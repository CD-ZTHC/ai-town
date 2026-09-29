// 沙箱客户端：由宿主（小镇服务器或进化引擎）启动沙箱子进程、收发消息、处理超时与崩溃。
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackChild } from '../../server/memstat.ts';
import type { ChildProcess } from 'node:child_process';

/** 沙箱发回的消息（runner.ts） */
type Msg = { type?: string; id?: number; ok?: boolean; result?: unknown; side?: Side; error?: string; registered?: Registered; results?: TestResult[]; prompt?: string };
/** 一次调用里插件产生的副作用：日志、覆盖层、存储 */
export interface Side { logs?: string[]; overlay?: unknown[]; store?: Record<string, unknown> }
/** 插件注册的效果、钩子、接口名 */
export interface Registered { effects: string[]; hooks: string[]; routes: string[] }
export interface TestResult { name: string; ok: boolean; error?: string }
type Child = ChildProcess & { killedByHost?: boolean };

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.ts');
// 路径里有符号链接时（例如 macOS 的 /var → /private/var），权限模型有的地方按原路径、有的按真实路径比对，两种都放行
const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const readable = (p: string): string[] => [...new Set([path.resolve(p), real(p)])].map((x) => `--allow-fs-read=${x}`);

/** 沙箱进程的启动参数：只读本运行器与插件目录；没有写权限、子进程、worker、原生模块；禁止从字符串生成代码 */
export function sandboxArgs(pluginDir: string, memMb = 64): string[] {
  return ['--permission', ...readable(RUNNER), ...readable(pluginDir), `--max-old-space-size=${memMb}`, '--disallow-code-generation-from-strings', '--no-warnings'];
}

function spawn(pluginDir: string, mode: 'test' | 'run'): Child {
  return trackChild(mode === 'test' ? 'sandbox-test' : 'sandbox', fork(RUNNER, [real(pluginDir), mode], { // 真实路径：模块加载器给出的 URL 也是真实路径，运行器据此判断「插件目录里的文件」
    execArgv: sandboxArgs(pluginDir),
    env: {}, // 不继承任何环境变量：没有密钥、没有代理
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
  }));
}

/** 在沙箱里运行插件自带的测试（test.js），返回 { ok, results, error } */
export function runPluginTests(pluginDir: string, { timeoutMs = 8000 }: { timeoutMs?: number } = {}): Promise<{ ok: boolean; results: TestResult[]; error: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(pluginDir, 'test');
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d).slice(-1000); });
    child.stdout!.resume();
    const done = (r: { ok: boolean; results: TestResult[]; error: string | null }) => { clearTimeout(timer); child.kill('SIGKILL'); resolve(r); };
    const timer = setTimeout(() => done({ ok: false, results: [], error: `测试超时（${timeoutMs}ms）` }), timeoutMs);
    child.on('message', (m: Msg) => {
      if (m?.type === 'testResults') done({ ok: m.results!.length > 0 && m.results!.every((x) => x.ok), results: m.results!, error: m.results!.length ? null : 'test.js 里没有任何测试' });
      else if (m?.type === 'fatal') done({ ok: false, results: [], error: m.error! });
    });
    child.on('exit', (code) => done({ ok: false, results: [], error: `测试进程退出（${code}）${stderr ? `：${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}` }));
  });
}

/** 沙箱的启动选项：onLlm 替插件调用模型；callMs 单次调用超时；readyMs 启动超时；store 插件存储的初值 */
export interface SandboxOptions { onLlm?: ((prompt: string) => Promise<string>) | null; callMs?: number; readyMs?: number; store?: object }

export class SandboxClient {
  declare dir: string;
  declare opts: SandboxOptions;
  declare callMs: number;
  declare child: Child | null;
  declare ready: Promise<Registered> | null;
  declare registered: Registered | null;
  declare pending: Map<number, { resolve: (r: { result: unknown; side: Side }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; started: number }>;
  declare seq: number;
  declare stderr: string;
  declare stats: { calls: number; errors: number; timeouts: number; crashes: number; ms: number; consecutive: number };
  declare closed: boolean;
  constructor(pluginDir: string, opts: SandboxOptions = {}) {
    this.dir = pluginDir;
    this.opts = opts;
    this.callMs = opts.callMs || 500;
    this.child = null;
    this.ready = null;
    this.registered = null;
    this.pending = new Map();
    this.seq = 0;
    this.stderr = '';
    this.stats = { calls: 0, errors: 0, timeouts: 0, crashes: 0, ms: 0, consecutive: 0 };
    this.closed = false;
  }

  start(): Promise<Registered> {
    if (this.ready) return this.ready;
    this.ready = new Promise<Registered>((resolve, reject) => {
      const child = spawn(this.dir, 'run');
      this.child = child;
      child.stderr!.on('data', (d: Buffer) => { this.stderr = (this.stderr + d).slice(-2000); });
      child.stdout!.resume();
      const timer = setTimeout(() => { reject(new Error('插件启动超时')); this.kill(); }, this.opts.readyMs || 5000);
      child.on('message', (m: Msg) => this.onMessage(m, { resolve, reject, timer }));
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        const err = new Error(`沙箱进程退出（${sig || code}）`);
        reject(err);
        if (child.killedByHost) return; // 宿主主动结束（超时 / 关闭）：已经处理过了
        if (!this.closed) this.stats.crashes++;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        if (this.child === child) { this.child = null; this.ready = null; }
      });
      if (this.opts.store) child.send({ type: 'init', store: this.opts.store });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  onMessage(m: Msg, boot: { resolve: (r: Registered) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }) {
    if (m?.type === 'ready') { clearTimeout(boot.timer); this.registered = m.registered!; boot.resolve(m.registered!); return; }
    if (m?.type === 'fatal') { clearTimeout(boot.timer); boot.reject(new Error(m.error)); return; }
    if (m?.type === 'llm') {
      const reply = (r: { ok: boolean; text?: string; error?: string }) => this.child?.connected && this.child.send({ type: 'llmReply', id: m.id, ...r });
      if (!this.opts.onLlm) return reply({ ok: false, error: '这个插件没有申请模型权限' });
      this.opts.onLlm(String(m.prompt || '')).then((text) => reply({ ok: true, text }), (e: Error) => reply({ ok: false, error: e.message }));
      return;
    }
    const p = this.pending.get(m?.id!);
    if (!p) return;
    this.pending.delete(m.id!);
    clearTimeout(p.timer);
    this.stats.ms += Date.now() - p.started;
    if (m.ok) { this.stats.consecutive = 0; p.resolve({ result: m.result, side: m.side || {} }); } else { this.stats.errors++; this.stats.consecutive++; p.reject(new Error(m.error || '插件出错')); }
  }

  /** 调用插件：type 为 effect / hook / route；超时会杀掉沙箱进程（下次调用时重启） */
  async call(type: 'effect' | 'hook' | 'route', name: string, payload: unknown, timeoutMs = this.callMs): Promise<{ result: unknown; side: Side }> {
    await this.start();
    if (!this.child?.connected) throw new Error('沙箱未运行');
    const id = ++this.seq;
    this.stats.calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts++;
        this.stats.consecutive++;
        reject(new Error(`插件处理超时（${timeoutMs}ms）`));
        this.kill(); // 可能是死循环：直接结束进程
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, started: Date.now() });
      this.child!.send({ id, type, name, payload } as import('node:child_process').Serializable);
    });
  }

  kill(): void {
    const child = this.child;
    if (!child) return;
    child.killedByHost = true;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('沙箱进程已被结束')); }
    this.pending.clear();
    this.child = null;
    this.ready = null;
  }

  close(): void { this.closed = true; this.kill(); }
}
