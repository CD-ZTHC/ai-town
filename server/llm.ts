// LLM 客户端：并发队列、重试、模型分档与自动校正、JSON 提取、统计。发请求交给 provider（见 llm-providers.js）
//
// 通道与配置档（按世界配置模型服务，设计见 docs/design/world-llm.md §5）：
//   通道（Lane）    一把钥匙一条通道：provider、调度队列、并发、限流退避、JSON 模式降级、模型名纠正都属于通道。
//                   服务器的模型是 'server' 通道；世界自带的模型服务按凭据各有一条通道，互不影响。
//   配置档（Profile）某个世界用哪条通道、哪三档模型、多长超时、要不要 JSON 模式。
// 每次调用按调用上下文（scheduler/context.js 的 worldId）解析配置档：由服务入口 setProfileResolver 注入；
// 没有注入解析器时一律用服务器的配置档，行为与只有一个模型时完全一样。审核类调用永远用服务器（SERVER_ONLY）。
import fs from 'node:fs';
import { createProvider } from './llm-providers.ts';
import { get as setting, env as settingsEnv } from './settings/index.ts';
import { Scheduler } from './scheduler/index.ts';
import { classOf, SERVER_ONLY } from './scheduler/classes.ts';
import { currentContext } from './scheduler/context.ts';
import { scrub } from './secrets.ts';
import type { ChatMessage, JsonSchemaSpec, Provider } from './types/llm.ts';
import type { CallContext, Job, LlmClass } from './types/scheduler.ts';
import type { Billing } from './scheduler/budget.ts';

export type Tier = 'default' | 'fast' | 'smart';

/** chat / chatJSON 的选项 */
export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** 用途（决定调度级别，见 scheduler/classes.ts），也是统计的分组 */
  label?: string;
  agent?: string | null;
  timeoutMs?: number | null;
  attempts?: number;
  tier?: Tier;
  json?: boolean;
  schema?: JsonSchemaSpec | null;
  /** 指定另一个模型（进化引擎的评审 Agent 用） */
  model?: string;
  provider?: Provider | null;
  cls?: LlmClass | null;
  onTokens?: ((tokens: number) => void) | null;
}

/** 通道里排队的任务 */
export type LlmJob = Job & { userId?: string | null; billing: Billing; lane: string };

/** 配置档：某个世界用哪条通道、哪三档模型、多长超时、要不要 JSON 模式；blocked 表示这个世界现在不能调用模型 */
export interface Profile {
  lane: Lane;
  models(): { default: string; fast: string; smart: string };
  timeoutMs(): number;
  jsonMode: boolean;
  schemaMode: boolean;
  blocked?: string | null;
  code?: string;
}

/** 失败的分类（failureKind） */
export type FailureKind = 'rate' | 'balance' | 'auth' | 'model' | 'address' | 'net' | null;

const listeners = new Set<(s: typeof stats) => void>();
const lanes = new Map<string, Lane>(); // key → Lane

// allow：出队前的额度检查（按世界的分层预算，见 scheduler/budget.ts；由服务入口设置）
type BudgetAllow = (job: LlmJob) => true | string;
let budgetPolicy: BudgetAllow = () => true;
export function setBudgetPolicy(fn: BudgetAllow | null | undefined): void { budgetPolicy = fn || (() => true); }

export interface LaneOptions {
  key: string;
  billing: Billing;
  provider: () => Provider;
  /** 并发上限（遇到限流时再临时降低） */
  limit: () => number;
  jsonMode?: boolean;
  schemaMode?: boolean;
  owner?: string | null;
}

/** 通道：一把钥匙的队列、并发与退避状态 */
export class Lane {
  key: string;
  billing: Billing;
  getProvider: () => Provider;
  baseLimit: () => number;
  jsonMode: boolean;
  schemaMode: boolean;
  owner: string | null;
  /** 模型名写错时自动纠正的结果（想要的名字 → 实际使用的名字） */
  fixes: Record<string, string>;
  checked: Set<string>;
  /** 触发限流后临时降低并发 */
  penalty: number;
  cooldownUntil: number;
  backoff: number;
  pumpTimer: NodeJS.Timeout | null;
  inflight: number;
  lastUsed: number;
  /** 连续的网络错误（判断「持续连不上」） */
  netFails: number;
  netFailSince: number;
  stats: { calls: number; ok: number; errors: number; tokens: number; lastError: string };
  sched: Scheduler;

  constructor({ key, billing, provider, limit, jsonMode = true, schemaMode = false, owner = null }: LaneOptions) {
    this.key = key; this.billing = billing; this.getProvider = provider; this.baseLimit = limit; this.jsonMode = jsonMode; this.schemaMode = schemaMode; this.owner = owner;
    this.fixes = {};
    this.checked = new Set();
    this.penalty = 0;
    this.cooldownUntil = 0;
    this.backoff = 0;
    this.pumpTimer = null;
    this.inflight = 0;
    this.lastUsed = Date.now();
    this.netFails = 0;
    this.netFailSince = 0;
    this.stats = { calls: 0, ok: 0, errors: 0, tokens: 0, lastError: '' };
    this.sched = new Scheduler({ limit: () => this.limit(), agingMs: () => setting('PRIORITY_AGING_MIN') * 60_000, allow: (job) => budgetPolicy(job as LlmJob) });
  }

  get provider(): Provider { return this.getProvider(); }
  limit(): number { return Math.max(1, this.baseLimit() - this.penalty); }
  queued(): number { return this.sched.queued(); }
}

// ---- 服务器的通道与配置档：provider 按「服务类型 + 地址 + 密钥」缓存，面板里改了下一次调用就换用新的 ----
let injected: Provider | null = null; // 测试或启动时注入的 provider（setProvider）
let cached: { sig: string; p: Provider } | null = null;
function serverProvider(): Provider {
  if (injected) return injected;
  const sig = JSON.stringify([setting('LLM_PROVIDER'), setting('BASE_URL'), setting('API_KEY'), setting('MODEL'), setting('MODEL_FAST'), setting('MODEL_SMART')]);
  if (cached?.sig !== sig) {
    cached = { sig, p: createProvider(setting('LLM_PROVIDER'), settingsEnv()) };
    serverLane.checked.clear();
  }
  return cached!.p;
}
// JSON 模式（response_format: json_object）：大幅减少模型输出不合法 JSON 的情况。
// 网关不支持时会报错，此时自动关闭并重试（只关这条通道）；也可以用 LLM_JSON_MODE=0 手动关闭。
// 结构化输出（response_format: json_schema）：调用方给了 schema 且 LLM_JSON_SCHEMA=1 时使用；网关不支持时自动退回普通 JSON 模式
const serverLane = new Lane({
  key: 'server', billing: 'server', provider: serverProvider, limit: () => setting('LLM_CONCURRENCY'),
  jsonMode: setting('LLM_JSON_MODE'), schemaMode: setting('LLM_JSON_SCHEMA'),
});
lanes.set('server', serverLane);
// 模型分档：fast 用于高频的小任务（独白、审核），smart 用于低频的重要任务（日报、叙事导演、世界架构师）。
// 未配置的档位回落到 MODEL，因此只配置 MODEL 时行为与之前完全一致。
const serverProfile: Profile = {
  lane: serverLane,
  models: () => ({ default: setting('MODEL'), fast: setting('MODEL_FAST'), smart: setting('MODEL_SMART') }),
  timeoutMs: () => setting('LLM_TIMEOUT_MS'),
  jsonMode: true,
  schemaMode: true,
};

export function setJsonMode(on: unknown): void { serverLane.jsonMode = Boolean(on); }
export function setJsonSchema(on: unknown): void { serverLane.schemaMode = Boolean(on); }

const wanted = (profile: Profile, tier: Tier): string => {
  const m = profile.models();
  return (tier === 'fast' ? m.fast : tier === 'smart' ? m.smart : '') || m.default;
};
const modelFor = (profile: Profile, tier: Tier): string => { const w = wanted(profile, tier); return profile.lane.fixes[w] || w; };

// ---- 世界的配置档（由服务入口注入）----
/** 返回配置档；返回 null 用服务器的；返回 { blocked, code } 的配置档表示这个世界现在不能调用模型（例如已暂停） */
export type ProfileResolver = (q: { worldId: string | null; userId: string | null; label: string }) => Profile | null;
let resolver: ProfileResolver | null = null;
export function setProfileResolver(fn: ProfileResolver | null | undefined): void { resolver = fn || null; }

function resolve(ctx: CallContext = currentContext(), label = ''): Profile {
  if (!resolver || SERVER_ONLY.has(label)) return serverProfile;
  return resolver({ worldId: ctx.worldId || null, userId: ctx.userId || null, label }) || serverProfile;
}

/** 建（或取回）一条通道；同一把钥匙的世界共用一条 */
export function lane(key: string, make: () => Omit<LaneOptions, 'key' | 'billing'>): Lane {
  let l = lanes.get(key);
  if (!l) { l = new Lane({ key, billing: 'own', jsonMode: true, schemaMode: true, ...make() }); lanes.set(key, l); }
  l.lastUsed = Date.now();
  return l;
}

/** 回收通道：拒绝还在排队的任务（在途的请求让它自然结束） */
export function dropLane(key: string, reason = '模型服务已更换'): void {
  const l = lanes.get(key);
  if (!l || l === serverLane) return;
  l.sched.drop(() => true, Object.assign(new Error(reason), { code: 'HALTED', status: 503 }));
  lanes.delete(key);
  notify();
}

/** 拒绝某些世界在所有通道里排队的任务（世界暂停时） */
export function dropWorld(worldId: string, reason: string): void {
  for (const l of lanes.values()) l.sched.drop((job) => job.worldId === worldId, Object.assign(new Error(reason), { code: 'HALTED', status: 503 }));
}

/** 回收空闲的自带通道（空闲 idleMs 以上、没有排队也没有在途） */
export function sweepLanes(idleMs = 10 * 60_000, keep: (key: string) => boolean = () => false): void {
  for (const [k, l] of lanes) if (l !== serverLane && !l.inflight && !l.queued() && Date.now() - l.lastUsed > idleMs && !keep(k)) lanes.delete(k);
}

// ---- 统计 ----
export const stats = {
  get enabled() { return Boolean(mock) || serverLane.provider.enabled; },
  get model() { return modelFor(serverProfile, 'default'); },
  get models() { return { fast: modelFor(serverProfile, 'fast'), smart: modelFor(serverProfile, 'smart') }; },
  calls: 0,
  ok: 0,
  errors: 0,
  inflight: 0,
  queued: 0,
  promptTokens: 0,
  completionTokens: 0,
  avgMs: 0,
  lastError: '',
  dayKey: '',
  dayTokens: 0, // 只算服务器通道（全站预算）
  get dailyBudget() { return dailyBudget(); },
  recent: [] as Array<{ label: string; agent: string | null; ms: number; ok: boolean; at: number }>,
  /** 按模块统计：{ 规划一天: { calls, fails, tokens, ms, json, repairs, badJson, schemaMiss } } */
  byLabel: {} as Record<string, LabelStats>,
  active: [] as Array<{ id: number; label: string; agent: string | null; since: number; model: string; lane: string }>,
};

export interface LabelStats { calls: number; fails: number; tokens: number; ms: number; json: number; repairs: number; badJson: number; schemaMiss: number }

/** 各条通道的状态（管理面板用；不含任何密钥） */
export function lanesView() {
  return [...lanes.values()].map((l) => ({
    key: l.key, billing: l.billing, owner: l.owner, provider: l.provider?.name || '', limit: l.limit(), penalty: l.penalty,
    inflight: l.inflight, queued: l.queued(), cooling: Math.max(0, l.cooldownUntil - Date.now()), jsonMode: l.jsonMode, fixes: { ...l.fixes }, ...l.stats,
  }));
}

export function onActivity(fn: (s: typeof stats) => void): () => boolean {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn(stats));

const concurrency = () => setting('LLM_CONCURRENCY');
// 每日令牌预算（0 = 不限）。公网模式默认 300 万，超出后世界退化为规则驱动，玩家交互暂停。只约束服务器通道
const dailyBudget = () => setting('LLM_DAILY_TOKENS');

export class BudgetError extends Error {
  code = 'BUDGET';
  constructor() { super('今日 AI 额度已用完'); }
}
/** 本地日期（YYYY-MM-DD）：每日额度按服务器所在时区的午夜重置，而不是 UTC 午夜 */
export function localDayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function rollDay() {
  const k = localDayKey();
  if (stats.dayKey !== k) { stats.dayKey = k; stats.dayTokens = 0; }
}
/** 当前世界可用的每日额度：服务器通道看全站预算；自带的模型服务不占全站预算（自己的上限由预算策略检查） */
export function budgetLeft(): number {
  const p = resolve();
  if (p.blocked) return 0;
  if (p.lane.billing !== 'server') return Infinity;
  rollDay();
  const b = dailyBudget();
  return b ? Math.max(0, b - stats.dayTokens) : Infinity;
}

/** 当前世界现在能不能调用模型（没配置、世界暂停中 → false）；审核等只用服务器的调用看 stats.enabled */
export function enabled(): boolean {
  if (mock) return true;
  const p = resolve();
  return !p.blocked && Boolean(p.lane.provider?.enabled);
}

/** 当前世界不能调用模型的原因（例如 AI 服务暂停了），没有则 null */
export function blocked(): string | null {
  if (mock) return null;
  return resolve().blocked || null;
}

const totalQueued = () => [...lanes.values()].reduce((s, l) => s + l.queued(), 0);
/** 队列长度：不传世界时是全局（排队 + 进行中），传世界时是这个世界在它的通道里的积压（按世界调速用） */
export const queueSize = (worldId: string | null = null): number => {
  if (!worldId) return totalQueued() + stats.inflight;
  const p = resolver ? resolve({ worldId }) : serverProfile;
  return (p.lane || serverLane).sched.backlog(worldId);
};

async function ensureModel(profile: Profile): Promise<void> {
  const l = profile.lane;
  const provider = l.provider;
  const want = [...new Set((['default', 'fast', 'smart'] as const).map((t) => wanted(profile, t)))].filter((w) => w && !l.checked.has(w));
  if (!want.length || !(mock || provider.enabled)) return;
  for (const w of want) l.checked.add(w);
  try {
    const ids = provider.listModels ? await provider.listModels() : [];
    for (const w of want) {
      if (!ids.length || ids.includes(w)) continue;
      // 容错：尝试找到字符组成最相近的模型（例如 glm-5.3-xflash -> glm-5.3-flashx）
      const score = (id: string): number => {
        const a = [...w].sort().join('');
        const b = [...id].sort().join('');
        let same = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
        return same - Math.abs(a.length - b.length) * 2;
      };
      const best = ids.slice().sort((x, y) => score(y) - score(x))[0];
      console.warn(`[llm] ${l.key === 'server' ? '' : `${l.key} `}模型 "${w}" 不可用，自动改用 "${best}"（可用: ${ids.join(', ')}）`);
      l.fixes[w] = best!;
    }
  } catch (e) {
    console.warn(`[llm] ${l.key === 'server' ? '' : `${l.key} `}无法获取模型列表：`, (e as Error).message);
  }
}

// ---- 统一调度（多世界设计 §7）：每条通道一个队列、一个并发上限；按级别与世界出队，带自适应限流 ----
// 服务器通道的调度器（测试会拦截它的 push）
export const sched = serverLane.sched;
// 所有自带通道合计的在途上限（0 = 不限），防止大量自带世界占满服务器的连接
let ownInflight = 0;
const ownCap = () => { try { return setting('USER_LLM_TOTAL_CONCURRENCY'); } catch { return 0; } };

/** 队列忙：调用点（导演、独白、群体心智）据此让路；让路记在当前世界上，作为公平补偿的依据 */
export const isBusy = (): boolean => {
  const ctx = currentContext();
  const p = resolve(ctx);
  const l = p.lane || serverLane;
  const busy = Boolean(p.blocked) || l.queued() > 1 || l.inflight >= l.limit() || Date.now() < l.cooldownUntil;
  if (busy) l.sched.noteYield(ctx.worldId);
  return busy;
};

function pumpLane(l: Lane): void {
  const wait = l.cooldownUntil - Date.now();
  if (wait > 0) {
    if (!l.pumpTimer) l.pumpTimer = setTimeout(() => { l.pumpTimer = null; pump(); }, wait);
    return;
  }
  const cap = l.billing === 'own' ? ownCap() : 0;
  for (let job = cap && ownInflight >= cap ? null : l.sched.next(); job; job = cap && ownInflight >= cap ? null : l.sched.next()) {
    l.sched.started(job);
    l.inflight++;
    stats.inflight++;
    if (l.billing === 'own') ownInflight++;
    (job.run() as Promise<unknown>).finally(() => {
      l.sched.finished(job);
      l.inflight--;
      stats.inflight--;
      if (l.billing === 'own') ownInflight--;
      pump();
      notify();
    });
  }
}
function pump(): void {
  for (const l of lanes.values()) pumpLane(l);
  stats.queued = totalQueued();
  notify();
}

/** 放进通道的队列：级别由 label 决定（调用点不再自己选优先级），世界与用户来自调用上下文 */
function enqueue(profile: Profile, fn: (ctx: CallContext) => Promise<string>, opts: ChatOptions, ctx: CallContext): Promise<string> {
  const l = profile.lane;
  return new Promise<string>((resolve, reject) => {
    const job: LlmJob = { cls: opts.cls || classOf(opts.label), worldId: ctx.worldId as string /* 没有世界时 push 会补成 "-" */, userId: ctx.userId, billing: l.billing, lane: l.key, label: opts.label, run: () => fn(ctx).then(resolve, reject), reject };
    l.sched.push(job);
    pump();
  });
}

// ---- 用量账本：每次调用结束后记下 { worldId, userId, class, tokens, billing }（由服务入口写进 usage 表）----
export interface UsageEvent { worldId: string | null; userId: string | null; cls: LlmClass; label: string; tokens: number; billing: Billing }
const usageListeners = new Set<(u: UsageEvent) => void>();
export function onUsage(fn: (u: UsageEvent) => void): () => boolean { usageListeners.add(fn); return () => usageListeners.delete(fn); }

// ---- 故障：自带通道的致命错误交给服务入口（暂停世界、标记凭据，见设计 §5.4）----
export interface FailureEvent { lane: Lane; kind: FailureKind; error: unknown; worldId: string | null; profile: Profile; model: string }
let failureHook: ((f: FailureEvent) => void) | null = null;
export function onFailure(fn: ((f: FailureEvent) => void) | null | undefined): void { failureHook = fn || null; }

/**
 * 错误分类：rate 限流（退避重试）；balance 余额不足、auth 鉴权失败、model 模型不存在、address 地址被拒（致命，不重试）；
 * net 网络错误或 5xx（重试；连续多次才算致命）；null 其他
 */
export function failureKind(err: unknown): FailureKind {
  const e = err as { message?: string; upstreamStatus?: number; code?: string } | null | undefined;
  const m = String(e?.message || e || '');
  const s = Number(e?.upstreamStatus) || Number(/HTTP (\d{3})/.exec(m)?.[1]) || 0;
  if (e?.code === 'ADDRESS') return 'address';
  if (s === 402 || /insufficient|余额|欠费|balance|exceeded your current quota|billing|credit/i.test(m)) return 'balance';
  if (s === 429 || /\b429\b|速率|频率|rate.?limit|too many|concurren|并发/i.test(m)) return 'rate';
  if (s === 401 || s === 403 || /no access|invalid.*key|unauthori|authentication|permission denied/i.test(m)) return 'auth';
  if ((s === 404 && /model/i.test(m)) || /model.{0,60}(not.?found|does not exist|not exist|unknown)|模型不存在|unknown model|no such model/i.test(m)) return 'model';
  if (s >= 500 || (!s && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket|network|certificate|TLS/i.test(m))) return 'net';
  return null;
}
const FATAL = new Set<FailureKind>(['balance', 'auth', 'model', 'address']);

let seq = 0;
async function rawChat(profile: Profile, messages: ChatMessage[], { maxTokens = 3000, temperature = 0.9, label = 'llm', agent = null, timeoutMs = null, attempts = 3, tier = 'default', json = false, schema = null, model: override = '', provider: providerOverride = null, cls = null, onTokens = null }: ChatOptions, ctx: CallContext = {}): Promise<string> {
  const l = profile.lane;
  await ensureModel(profile);
  // override：进化引擎的评审 Agent 可以指定另一个模型（评审模型）
  const model = override || modelFor(profile, tier);
  timeoutMs ??= profile.timeoutMs();
  const id = ++seq;
  const started = Date.now();
  stats.active.push({ id, label, agent, since: started, model, lane: l.key });
  stats.calls++;
  l.stats.calls++;
  notify();
  let lastErr: unknown;
  try {
    for (let attempt = 0; attempt < attempts + 3; attempt++) {
      const wait = l.cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * 500));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs!);
      const jsonOn = json && l.jsonMode && profile.jsonMode;
      const schemaOn = Boolean(schema && jsonOn && l.schemaMode && profile.schemaMode);
      try {
        const { content, usage, finishReason } = await (providerOverride || l.provider).complete({ model, messages, temperature, maxTokens, json: jsonOn, ...(schemaOn ? { schema } : {}), signal: ctrl.signal });
        stats.promptTokens += usage.prompt;
        stats.completionTokens += usage.completion;
        const tokens = usage.prompt + usage.completion;
        if (l.billing === 'server') { rollDay(); stats.dayTokens += tokens; }
        l.stats.tokens += tokens;
        onTokens?.(tokens);
        for (const fn of usageListeners) { try { fn({ worldId: ctx.worldId || null, userId: ctx.userId || null, cls: cls || classOf(label), label, tokens, billing: l.billing }); } catch { /* 账本失败不影响调用 */ } }
        const u = labelStats(label);
        u.calls++;
        u.tokens += tokens;
        u.ms += Date.now() - started;
        l.netFails = 0;
        if (!content.trim()) throw new Error(`空回复 (finish_reason=${finishReason})`);
        const ms = Date.now() - started;
        l.backoff = Math.max(0, l.backoff - 1);
        if (l.stats.ok % 5 === 0 && l.penalty > 0) l.penalty--;
        stats.ok++;
        l.stats.ok++;
        stats.avgMs = stats.avgMs ? stats.avgMs * 0.85 + ms * 0.15 : ms;
        pushRecent({ label, agent, ms, ok: true });
        return content;
      } catch (e) {
        lastErr = e;
        const kind = failureKind(e);
        if (FATAL.has(kind)) break;
        const msg = String((e as Error)?.message);
        if (schemaOn && /json_schema|response_format|schema/i.test(msg)) {
          l.schemaMode = false;
          console.warn(`[llm] ${l.key === 'server' ? '网关' : `${l.key} 的网关`}不支持结构化输出（json_schema），已退回普通 JSON 模式`);
          continue;
        }
        if (jsonOn && /response_format|json_object|json mode/i.test(msg)) {
          l.jsonMode = false;
          console.warn(`[llm] ${l.key === 'server' ? '网关' : `${l.key} 的网关`}不支持 JSON 模式，已自动关闭`);
          continue;
        }
        if (kind === 'rate') {
          // 限流：通道冷却 + 指数退避 + 降低并发
          l.backoff = Math.min(5, l.backoff + 1);
          l.penalty = Math.min(l.baseLimit() - 1, l.penalty + 1);
          l.cooldownUntil = Math.max(l.cooldownUntil, Date.now() + 4000 * 2 ** (l.backoff - 1));
          stats.lastError = `限流中，${Math.round((l.cooldownUntil - Date.now()) / 1000)}s 后重试`;
          continue;
        }
        if (kind === 'net' && !ctrl.signal.aborted) {
          if (!l.netFails++) l.netFailSince = Date.now();
        }
        if (attempt >= attempts - 1) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    stats.errors++;
    l.stats.errors++;
    stats.lastError = l.stats.lastError = scrub(String((lastErr as Error)?.message || lastErr)).slice(0, 200);
    pushRecent({ label, agent, ms: Date.now() - started, ok: false });
    labelStats(label).fails++;
    const kind = failureKind(lastErr);
    if (l.billing === 'own' && failureHook && (FATAL.has(kind) || kind === 'net')) {
      try { failureHook({ lane: l, kind, error: lastErr, worldId: ctx.worldId || null, profile, model }); } catch (e) { console.warn('[llm] 故障处理失败：', (e as Error).message); }
    }
    throw lastErr;
  } finally {
    stats.active = stats.active.filter((a) => a.id !== id);
  }
}

/** 按模块的统计：请求次数、失败、token、耗时；json / repairs / badJson / schemaMiss 是 chatJSON 的解析情况 */
function labelStats(label: string): LabelStats {
  return (stats.byLabel[label] ||= { calls: 0, fails: 0, tokens: 0, ms: 0, json: 0, repairs: 0, badJson: 0, schemaMiss: 0 });
}

function pushRecent(r: { label: string; agent: string | null; ms: number; ok: boolean }): void {
  stats.recent.unshift({ ...r, at: Date.now() });
  stats.recent.length = Math.min(stats.recent.length, 12);
}

// 测试用：注入一个假的模型（fn(messages, opts) => 回复文本），不发出任何网络请求
export type MockFn = (messages: ChatMessage[], opts: ChatOptions) => string | Promise<string>;
let mock: MockFn | null = null;
export function setMock(fn: MockFn | null | undefined): void {
  mock = fn || null;
}

/** 换用另一个 provider（测试，或在启动时接入其他 SDK）：只换服务器通道；模型名会重新校验 */
export function setProvider(p: Provider | null | undefined): void {
  injected = p || null;
  serverLane.checked.clear();
}

export class HaltedError extends Error {
  code = 'HALTED';
  status = 503;
  constructor(msg?: string) { super(msg || '这个世界的 AI 服务暂停了'); }
}

export function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (mock) return Promise.resolve().then(() => mock!(messages, opts));
  const ctx = currentContext();
  const profile = resolve(ctx, opts.label);
  if (profile.blocked) return Promise.reject(new HaltedError(profile.blocked));
  if (!profile.lane.provider.enabled) return Promise.reject(new Error('LLM 未配置'));
  if (profile.lane.billing === 'server') {
    rollDay();
    const b = dailyBudget();
    if (b && stats.dayTokens >= b) return Promise.reject(new BudgetError());
  }
  const p = enqueue(profile, (c) => rawChat(profile, messages, opts, c), opts, ctx);
  return RECORD_FILE ? p.then((content) => { record(opts.label || 'llm', content); return content; }) : p;
}


// 录制真实回复，供无头回放测试使用：LLM_RECORD=test/fixtures/llm/responses.json mise run start
// 按模块（label）分组，每个模块保留最近 RECORD_KEEP 条；能解析成 JSON 的存成对象，方便人工审阅与修改
const RECORD_FILE = setting('LLM_RECORD');
const RECORD_KEEP = 4;
function record(label: string, content: string): void {
  try {
    let all: Record<string, unknown[]> = {};
    try { all = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8')); } catch {}
    let entry: unknown = content;
    try { entry = extractJSON(content); } catch {}
    all[label] = [...(all[label] || []), entry].slice(-RECORD_KEEP);
    fs.writeFileSync(RECORD_FILE, JSON.stringify(all, null, 2) + '\n');
  } catch (e) {
    console.warn('[llm] 录制失败：', (e as Error).message);
  }
}

/** 模型输出的 JSON：结构由调用方逐字段校验，所以这里不约束 */
export type ModelJSON = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export function extractJSON(text: string): ModelJSON {
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error('回复中没有 JSON');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    const fixed = repairJSON(s);
    try {
      return JSON.parse(fixed);
    } catch (e) {
      // 附上出错位置附近的原文，日志里能直接看出模型写错了什么
      const em = (e as Error).message;
      const at = Number(/position (\d+)/.exec(em)?.[1]);
      throw new Error(Number.isFinite(at) ? `${em}（附近：${fixed.slice(Math.max(0, at - 60), at + 40)}）` : em);
    }
  }
}

// 值可以从这些字符开始（用来判断字符串里的引号后面跟着的 , 或 : 是不是 JSON 结构）
const VALUE_START = /["“{[+\-\d]|true|false|null/y;
const skipWs = (s: string, i: number): number => { while (i < s.length && /\s/.test(s[i]!)) i++; return i; };

/** 引号 s[i] 是不是在结束字符串：后面（跳过空白）是 } ] 或结尾，或者是 , : 且再后面是一个值（逗号后面也可以是尾逗号的 } ]） */
function closesString(s: string, i: number): boolean {
  let j = skipWs(s, i + 1);
  if (j >= s.length || s[j] === '}' || s[j] === ']') return true;
  if (!',:，：'.includes(s[j]!)) return false;
  const comma = s[j] === ',' || s[j] === '，';
  j = skipWs(s, j + 1);
  if (comma && (s[j] === '}' || s[j] === ']')) return true;
  VALUE_START.lastIndex = j;
  return VALUE_START.test(s);
}

/**
 * 修复模型常见的格式错误。逐字符扫描、区分字符串内外，只改 JSON 结构，不动台词内容：
 * 结构位置的中文引号 / 全角冒号 / 全角逗号、数字前的 + 号、尾逗号；
 * 字符串里没转义的英文引号（如 "text":"桩上刻着"第三根桩"几个字"）与换行；台词漏掉的 "text" 键。
 */
export function repairJSON(s: string): string {
  // 台词里最常见的错误：{"speaker":"赵铁柱":"……"} 漏了 "text" 键（对话与多人场景都用 speaker / text）
  s = s.replace(/("speaker"\s*[:：]\s*"[^"\n]{1,40}")\s*[:：]\s*(?=["“])/g, '$1,"text":');
  let out = '';
  let inStr = false;
  let curly = false; // 这个字符串是不是用中文引号开头的（是的话 ” 才可能是结束引号）
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { out += c + (s[++i] ?? ''); continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r' || c === '\t') { out += c === '\t' ? '\\t' : ''; continue; }
      const quote = c === '"' || (curly && c === '”');
      if (quote && closesString(s, i)) { out += '"'; inStr = false; continue; }
      out += c === '"' ? '\\"' : c;
      continue;
    }
    if (c === '"' || c === '“' || c === '”') { out += '"'; inStr = true; curly = c !== '"'; continue; }
    if (c === '：') { out += ':'; continue; }
    if (c === '，') { out += ','; continue; }
    if (c === '+' && /\d/.test(s[i + 1] || '') && /[:[,]\s*$/.test(out)) continue;
    if (c === '}' || c === ']') { out = out.replace(/,\s*$/, ''); }
    out += c;
  }
  return out;
}

export async function chatJSON(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ModelJSON> {
  opts = { json: true, ...opts };
  let content = await chat(messages, opts);
  const s = labelStats(opts.label || 'llm');
  s.json++;
  // 解析出来的 JSON 与模块声明的结构（llm-schemas.ts）不符：只计数（AI 大脑的指标），交给调用方的手工校验兜底
  const checked = (v: ModelJSON): ModelJSON => { if (opts.schema?.zod && !opts.schema.zod.safeParse(v).success) s.schemaMiss = (s.schemaMiss || 0) + 1; return v; };
  try {
    return checked(extractJSON(content));
  } catch (e) {
    // 输出不是合法 JSON：让模型改一次（计入 repairs），还不行计入 badJson
    s.repairs++;
    console.warn(`[llm] ${opts.label || 'llm'} 的回复不是合法 JSON，让模型重写：${String((e as Error).message).slice(0, 240)}`);
    content = await chat(
      [...messages, { role: 'assistant', content }, { role: 'user', content: '上面的输出不是合法 JSON。请只输出合法的 JSON，不要任何其他文字。' }],
      opts,
    );
    try {
      return checked(extractJSON(content));
    } catch (e) {
      s.badJson++;
      throw e;
    }
  }
}
