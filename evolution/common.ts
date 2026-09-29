// 进化引擎的公共部分：目录、账本、任务记录、引擎状态与 token 预算。
// 进化引擎只能写两个地方：plugins/evolved/（插件代码）与 data/evolution/（运行状态）；启动时由 Node 权限模型强制。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as setting } from '../server/settings/index.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** paths() 的参数：dataRoot 数据根目录；world 世界 id；data / evo / global / plugins 直接给出目录（测试、旧用法） */
export interface PathOptions { dataRoot?: string; world?: string; data?: string; evo?: string; global?: string; plugins?: string; packDir?: string | null }
export type Paths = ReturnType<typeof paths>;

/** 一个需求（discover.ts 发现，或来自心愿单 / 插件故障） */
export interface Need {
  source: 'gap' | 'bugfix' | 'idea' | (string & {});
  text: string;
  why?: string;
  count?: number;
  gapId?: string;
  /** 修复哪个插件版本（bugfix）与插件 id */
  fixOf?: string | null;
  fixId?: string;
  /** 来自心愿单时：缺口原文（用来判断同一个需求做过几次）与是否被管理员采纳 */
  gapKey?: string;
  adopted?: boolean;
  detail?: string;
}

/** 小镇导出的信号（signals.json，plugin-host/evolved.ts 的 exportSignals） */
export interface Signals {
  at?: string;
  day?: number;
  gaps?: Array<{ id: string; need: string; why: string; count: number; by: string; adopted: boolean }>;
  plugins?: Array<{ key: string; status?: string; errors: number; lastError?: string | null; calls: number }>;
  tension?: number | null;
  storyteller?: string;
  logMix?: Array<[string, number]>;
}

/** registry.json 里一个插件版本的状态（只读取进化引擎关心的字段） */
export interface RegistryEntry { status?: string; reason?: string; title?: string; summary?: string }

/** 进化任务（data/evolution/jobs.json） */
export interface EvoJob {
  id: string;
  worldId: string;
  pid: number;
  need: Need;
  status: 'running' | 'submitted' | 'dropped' | 'failed' | 'paused' | 't3' | (string & {});
  stage: string;
  startedAt: string;
  finishedAt?: string;
  log: Array<{ at: string; text: string }>;
  reason?: string;
  key?: string;
  rfcText?: string;
  title?: string;
  tier?: string;
  /** T3 需求文档的文件名 */
  rfc?: string;
}

/** 开启进化的世界（worlds.json） */
export interface EnabledWorld { id: string; official?: boolean; packDir?: string | null; mode?: string }

/**
 * 进化引擎的目录（多世界设计 §9）：一台引擎服务所有开启进化的世界。
 *   按世界：data/worlds/<id>/ 下的存档（data）、evolution/（登记、锁定哈希、信号、候选、试运行、需求文档）、plugins/（AI 插件）
 *   全站：data/evolution/ 下的任务（jobs）、引擎状态（engine）、账本（ledger，每条带 world）
 * opts.data 直接给出世界的数据目录时（测试、旧用法），全站的文件也放在这个世界的 evolution/ 里。
 */
export function paths(opts: PathOptions = {}) {
  const dataRoot = path.resolve(opts.dataRoot || path.resolve(ROOT, setting('DATA_DIR')));
  const worldId = opts.world || 'yunxi';
  const data = path.resolve(opts.data || path.join(dataRoot, 'worlds', worldId));
  const evo = path.resolve(opts.evo || path.join(data, 'evolution'));
  const global = path.resolve(opts.global || (opts.data ? evo : path.join(dataRoot, 'evolution')));
  return {
    dataRoot, data, evo, global,
    world: { id: worldId, packDir: opts.packDir || null },
    plugins: path.resolve(opts.plugins || path.join(data, 'plugins')),
    candidates: path.join(evo, 'candidates'),
    shadow: path.join(evo, 'shadow'),
    rfcs: path.join(evo, 'rfcs'),
    verified: path.join(evo, 'verified.json'),
    registry: path.join(evo, 'registry.json'),
    signals: path.join(evo, 'signals.json'),
    heartbeat: path.join(evo, 'heartbeat.json'),
    budget: path.join(evo, 'budget.json'),
    jobs: path.join(global, 'jobs.json'),
    engine: path.join(global, 'engine.json'),
    ledger: path.join(global, 'ledger.jsonl'),
    worlds: path.join(global, 'worlds.json'),
  };
}

/** 开启进化的世界（由小镇服务器写入 data/evolution/worlds.json）：[{ id, official, packDir, mode }] */
export function enabledWorlds(P: Paths): EnabledWorld[] { return readJSON<EnabledWorld[]>(P.worlds, []).filter((w) => w && /^[a-z][a-z0-9-]{2,31}$/.test(w.id)); }

/**
 * 在开启进化的世界之间轮转：从上次的下一个开始，跳过已经有任务在进行的世界（每个世界最多同时 1 个任务）。
 * 返回世界的列表顺序（调用方依次尝试「发现需求」，第一个有需求的就做）。
 */
export function rotation(worlds: EnabledWorld[], jobs: EvoJob[], last: string | null = null): EnabledWorld[] {
  const busy = new Set(jobs.filter((j) => j.status === 'running').map((j) => j.worldId || 'yunxi'));
  const i = worlds.findIndex((w) => w.id === last);
  const ordered = [...worlds.slice(i + 1), ...worlds.slice(0, i + 1)];
  return ordered.filter((w) => !busy.has(w.id));
}

/**
 * 进化引擎进程的启动参数：用 Node 权限模型限制为只能写插件目录与 data/evolution/。
 * 由小镇服务器启动时（net=false）模型调用经 IPC 交给主进程排队（多世界设计 §7.5），引擎自己不需要联网；
 * 独立运行时（net=true）要自己调用模型，Node 25 起权限模型默认禁止网络，所以支持时加上 --allow-net。
 * 沙箱与影子试运行的子进程各自带自己的参数、不加 --allow-net，因此仍然断网。
 */
export function engineArgs({ root, data, evolvedDir, evoDir, extraWrite = [], net: allowNet = true }: { root: string; data: string; evolvedDir: string; evoDir: string; extraWrite?: string[]; net?: boolean }): string[] {
  const net = allowNet && process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : [];
  return ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${data}`, `--allow-fs-write=${evolvedDir}`, `--allow-fs-write=${evoDir}`, ...extraWrite.map((d) => `--allow-fs-write=${d}`), ...net, '--allow-child-process'];
}

export const readJSON = <T>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export function writeJSON(f: string, v: unknown): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1));
  fs.renameSync(`${f}.tmp`, f);
}
export const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
export const today = (): string => new Date().toISOString().slice(0, 10);

export function ledger(P: Pick<Paths, 'evo' | 'ledger'> & { world?: { id: string } }, event: string, extra: object = {}): void {
  try {
    fs.mkdirSync(P.evo, { recursive: true });
    fs.appendFileSync(P.ledger, `${JSON.stringify({ at: new Date().toISOString(), by: 'engine', world: P.world?.id, event, ...extra })}\n`);
  } catch { /* 账本写失败不影响流程 */ }
}

/** 读取最近的账本记录（新的在后） */
export function readLedger(P: Pick<Paths, 'ledger'>, n = 60): Array<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any -- 账本的一行（JSON）
  try {
    return fs.readFileSync(P.ledger, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ---------- 预算 ----------
export class Budget {
  declare P: Pick<Paths, 'budget'>;
  declare limit: number;
  /** limit：每天的 token 上限（0 = 不限） */
  constructor(P: Pick<Paths, 'budget'>, limit = setting('EVOLVE_BUDGET')) {
    this.P = P;
    this.limit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  }
  // 每个世界各有 EVOLVE_BUDGET（记在世界的 evolution/budget.json）
  state(): { day: string; tokens: number } {
    const e = readJSON<{ day?: string; tokens: number }>(this.P.budget, {} as { tokens: number });
    return e.day === today() ? e as { day: string; tokens: number } : { day: today(), tokens: 0 };
  }
  used(): number { return this.state().tokens; }
  left(): number { return this.limit ? Math.max(0, this.limit - this.used()) : Infinity; }
  add(tokens: number): void {
    const b = this.state();
    b.tokens += Math.max(0, Math.round(tokens || 0));
    writeJSON(this.P.budget, b);
  }
}

export class BudgetExceeded extends Error {
  declare code: string;
  constructor() { super('今天的进化预算已用完'); this.code = 'EVOLVE_BUDGET'; }
}

// ---------- 引擎状态（管理面板读取） ----------
export function setEngine(P: Pick<Paths, 'engine'>, patch: object): void {
  const e = readJSON<object>(P.engine, {});
  writeJSON(P.engine, { ...e, ...patch, updatedAt: new Date().toISOString() });
}

// ---------- 任务 ----------
export function loadJobs(P: Pick<Paths, 'jobs'>): EvoJob[] { return readJSON<EvoJob[]>(P.jobs, []); }
export function saveJobs(P: Pick<Paths, 'jobs'>, jobs: EvoJob[]): void { writeJSON(P.jobs, jobs.slice(-100)); }
