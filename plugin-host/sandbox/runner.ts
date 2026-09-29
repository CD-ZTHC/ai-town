// 沙箱运行器（自主演化设计 §5.5）：在独立子进程里加载一个 AI 插件，通过 IPC 与宿主通信。
// 这个进程由宿主以下列方式启动：
//   node --permission --allow-fs-read=<本文件>,<插件目录> --max-old-space-size=64 --disallow-code-generation-from-strings
// 因此它：不能写任何文件、只能读自己的插件目录、不能启动子进程或 worker、不能加载原生模块、不能 eval / new Function；
// 环境变量为空（拿不到任何密钥）。本文件再加三道：只允许导入插件目录里的文件（禁止 node: 内置模块与动态导入其他位置）、
// 移除网络相关的全局对象、移除 process 与定时器。插件只能通过下面的 api 与世界交互，而 api 只会把「意图」交回宿主。
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assertModule from 'node:assert/strict';

/** 插件注册的处理函数：插件代码不可信，参数与返回值都在宿主那边校验 */
type Fn = (...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
/** 宿主发来的消息（sandbox/client.ts） */
type Msg = { type?: string; id?: number; name?: string; payload?: any; ok?: boolean; text?: string; error?: string; store?: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Side = { logs?: string[]; overlay?: unknown[]; store?: Record<string, unknown> };

const send = process.send!.bind(process);
const proc = process;
const onMessage = (fn: (msg: Msg) => void) => proc.on('message', fn);
const exit = process.exit.bind(process);
const [pluginDir, mode = 'run'] = process.argv.slice(2);
const DIR = path.resolve(pluginDir);
const DIR_URL = `${pathToFileURL(DIR).href}/`;

// ① 只允许导入插件目录里的文件
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    if (!r.url.startsWith(DIR_URL)) throw new Error(`沙箱禁止导入：${spec}`);
    return r;
  },
});
// ② 移除网络、定时器、进程等全局对象
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers', 'FormData',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'process', 'Buffer', 'navigator', 'performance', 'BroadcastChannel', 'MessageChannel', 'Worker']) {
  try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch { /* 不存在的就算了 */ }
}
// ③ 堵住通过构造函数拿到 Function 的路子（即使拿到，--disallow-code-generation-from-strings 也会拒绝）
for (const F of [function () {}, async function () {}, function* () {}, async function* () {}]) {
  try { Object.defineProperty(Object.getPrototypeOf(F), 'constructor', { value: undefined, configurable: false, writable: false }); } catch { /* ignore */ }
}

const MAX_STORE = 64 * 1024;
const reg: { effects: Record<string, Fn>; hooks: Record<string, Fn>; routes: Record<string, Fn>; overlay: null } = { effects: {}, hooks: {}, routes: {}, overlay: null };
let store: Record<string, unknown> = {};
let side: Side | null = null; // 本次调用中插件产生的副作用（日志、覆盖层、存储）
let llmSeq = 0;
const llmWait = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();

const api = Object.freeze({
  effect(name: unknown, fn: Fn) { if (typeof fn === 'function') reg.effects[String(name)] = fn; },
  on(event: unknown, fn: Fn) { if (typeof fn === 'function') reg.hooks[String(event)] = fn; },
  route(name: unknown, fn: Fn) { if (typeof fn === 'function') reg.routes[String(name)] = fn; },
  log(text: unknown) { if (side) (side.logs ||= []).push(String(text).slice(0, 60)); },
  overlay(list: unknown) { if (side) side.overlay = Array.isArray(list) ? list.slice(0, 20) : []; },
  store: Object.freeze({
    get(key: unknown) { const v = store[String(key)]; return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    set(key: unknown, value: unknown) {
      const next = { ...store, [String(key)]: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) };
      if (JSON.stringify(next).length > MAX_STORE) throw new Error('插件存储超过 64KB');
      store = next;
      if (side) side.store = store;
    },
  }),
  /** 请宿主调用模型（需要在 plugin.json 里申请 llm 权限；宿主负责额度与注入防护） */
  llm(prompt: unknown) {
    const id = ++llmSeq;
    send({ type: 'llm', id, prompt: String(prompt).slice(0, 1500) });
    return new Promise<string>((resolve, reject) => llmWait.set(id, { resolve, reject }));
  },
});

// 一个极简的测试框架（插件自带的 test.js 使用）
function harness() {
  const cases: Array<{ name: string; fn: Fn }> = [];
  return {
    cases,
    t: Object.freeze({
      test: (name: unknown, fn: Fn) => cases.push({ name: String(name).slice(0, 60), fn }),
      assert: assertModule,
      /** 一个记录注册结果的假 api，供测试直接调用插件的处理函数 */
      api() {
        const r: { effects: Record<string, Fn>; hooks: Record<string, Fn>; routes: Record<string, Fn>; logs: string[]; overlay: unknown; store: Record<string, unknown> } = { effects: {}, hooks: {}, routes: {}, logs: [], overlay: null, store: {} };
        return Object.freeze({
          effect: (n: string, fn: Fn) => { r.effects[n] = fn; }, on: (e: string, fn: Fn) => { r.hooks[e] = fn; }, route: (n: string, fn: Fn) => { r.routes[n] = fn; },
          log: (t: unknown) => r.logs.push(String(t)), overlay: (l: unknown) => { r.overlay = l; },
          store: { get: (k: string) => r.store[k], set: (k: string, v: unknown) => { r.store[k] = v; } },
          llm: async () => '（测试中的模型回复）',
          registered: r,
        });
      },
    }),
  };
}

async function call(msg: Msg) {
  side = {};
  try {
    let result;
    const p = msg.payload || {};
    if (msg.type === 'effect') result = await reg.effects[msg.name!]?.(p.args, p.ctx, p.world);
    else if (msg.type === 'hook') result = await reg.hooks[msg.name!]?.(p.event, p.world);
    else if (msg.type === 'route') result = await reg.routes[msg.name!]?.(p.body, p.world);
    else throw new Error(`未知调用：${msg.type}`);
    return { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)), side };
  } finally {
    side = null;
  }
}

onMessage(async (msg) => {
  if (msg?.type === 'llmReply') {
    const w = llmWait.get(msg.id!);
    llmWait.delete(msg.id!);
    if (w) (msg.ok ? w.resolve(String(msg.text || '')) : w.reject(new Error(msg.error || '模型调用失败')));
    return;
  }
  if (msg?.type === 'init') { store = (msg.store && typeof msg.store === 'object' ? msg.store : {}) as Record<string, unknown>; return; }
  if (!msg?.id) return;
  try {
    send({ id: msg.id, ...(await call(msg)) });
  } catch (e) {
    send({ id: msg.id, ok: false, error: String((e as Error)?.message || e).slice(0, 300) });
  }
});

try {
  if (mode === 'test') {
    const h = harness();
    const mod = await import(`${DIR_URL}test.js`);
    if (typeof mod.default !== 'function') throw new Error('test.js 需要 export default function (t) { t.test(...) }');
    await mod.default(h.t);
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const c of h.cases) {
      try { await c.fn(); results.push({ name: c.name, ok: true }); } catch (e) { results.push({ name: c.name, ok: false, error: String((e as Error)?.message || e).slice(0, 300) }); }
    }
    send({ type: 'testResults', results });
  } else {
    const mod = await import(`${DIR_URL}server.js`);
    if (typeof mod.default !== 'function') throw new Error('server.js 需要 export default function setup(api)');
    await mod.default(api);
    send({ type: 'ready', registered: { effects: Object.keys(reg.effects), hooks: Object.keys(reg.hooks), routes: Object.keys(reg.routes) } });
  }
} catch (e) {
  send({ type: 'fatal', error: String((e as Error)?.message || e).slice(0, 300) });
  exit(1);
}
