// 按世界配置模型服务（设计见 docs/design/world-llm.md §4~§5）：
//   - 解析：世界 → 配置档（llm.setProfileResolver）。世界选了自己的模型服务，世界里的所有调用都用它（审核除外，见 SERVER_ONLY）
//   - 通道：一把钥匙（凭据）一条通道，同一个人的几个世界共用；并发取这些世界设置的最大值
//   - 故障：鉴权失败、余额不足、地址被拒、持续连不上 → 暂停用这份凭据的所有世界；模型不存在 → 只暂停这个世界
//   - 恢复：凭据或配置修好后测试连接，通过就恢复；「持续连不上」每 15 分钟自动探测一次
import * as llm from './llm.ts';
import { credentialProvider, CREDENTIAL_PROVIDERS } from './llm-providers.ts';
import { makeSafeFetch, urlProblem } from './net/safe-fetch.ts';
import { SITE } from './accounts/llm-credentials.js';
import { scrub } from './secrets.ts';
import { get as setting } from './settings/index.ts';
import type { CompleteArgs, Env, Provider } from './types/llm.ts';
import type { FailureEvent, FailureKind, Profile } from './llm.ts';

// 用到的世界登记项与凭据字段（worlds/registry.js、accounts/llm-credentials.js 在 B7 迁移）
/** 暂停原因 */
export interface Halt { code: string; message: string; credential?: string | null; at?: number }
interface WorldEntry { id: string; official?: boolean; ownerId?: string | null; settings?: { ai?: RawAi | null; [k: string]: unknown } }
/** settings.ai 的原始值（用户提交或存储的），由 normalizeAi 规范化 */
type RawAi = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Cred { id: string; owner: string; provider: string; baseUrl: string; updatedAt?: string | number; name?: string; status?: string; failCode?: string | null; lastError?: string; keyLast4?: string }
interface Registry { get(id: string): WorldEntry | null; list(q?: object): WorldEntry[]; update(id: string, patch: object): unknown }
interface Credentials { get(id: string): Cred | null; secret(id: string): string; mark(id: string, r: { status: string; failCode?: FailureKind | string | null; error?: string; models?: string[] | null }): void }

/** 世界的 AI 配置（settings.ai）规范化后的形式 */
export type AiConfig =
  | { source: 'server'; halt?: Halt }
  | {
    source: 'own';
    credential: string;
    models: { default: string; fast: string; smart: string };
    concurrency: number;
    timeoutMs: number;
    jsonMode: boolean;
    jsonSchema: boolean;
    dailyTokens: number;
    embed: { credential: string; model: string };
    review: { credential: string; model: string };
    halt?: Halt | null;
  };
type OwnAi = Extract<AiConfig, { source: 'own' }>;

/** 测试连接的结果；kind 是 llm.failureKind 的分类 */
export interface TestResult { ok: boolean; models: string[]; model?: string; ms: number; kind: FailureKind | 'credential' | null; error: string; warning?: string }

/** 被暂停的世界：只带 blocked（llm.ts 在读 lane 之前都会先检查 blocked） */
const blockedProfile = (text: string): Profile => ({ blocked: text }) as Profile;

const HALT_NAMES: Record<string, string> = {
  auth: '密钥无效或没有权限', balance: '余额不足', model: '模型不存在', address: '接口地址不允许访问', net: '持续连不上模型服务',
  credential: '模型服务凭据不存在或已失效',
};
const CRED_LEVEL = new Set(['auth', 'balance', 'address', 'net', 'credential']); // 影响用这份凭据的所有世界
const NET_HALT_MS = 3 * 60_000;
const PROBE_MS = 15 * 60_000;
const err = (status: number, message: string, extra: object = {}): Error & { status: number } => Object.assign(new Error(message), { status, ...extra });
const clampInt = (v: unknown, lo: number, hi: number, d: number): number => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const MODEL_RE = /^[\w.:/@+\-]{1,120}$/;

/** 世界的 AI 配置（settings.ai）的规范形式；没有配置时是 { source: 'server' } */
export function normalizeAi(ai: RawAi): AiConfig {
  if (!ai || ai.source !== 'own') return { source: 'server', ...(ai?.halt ? { halt: ai.halt } : {}) };
  return {
    source: 'own',
    credential: String(ai.credential || ''),
    models: { default: String(ai.models?.default || ''), fast: String(ai.models?.fast || ''), smart: String(ai.models?.smart || '') },
    concurrency: clampInt(ai.concurrency, 1, 32, 2),
    timeoutMs: clampInt(ai.timeoutMs, 5000, 600000, 150000),
    jsonMode: ai.jsonMode !== false,
    jsonSchema: Boolean(ai.jsonSchema),
    dailyTokens: clampInt(ai.dailyTokens, 0, 1e12, 0),
    embed: { credential: String(ai.embed?.credential || ''), model: String(ai.embed?.model || '') },
    review: { credential: String(ai.review?.credential || ''), model: String(ai.review?.model || '') },
    halt: ai.halt || null,
  };
}

export interface WorldLlmOptions {
  registry: Registry;
  credentials: Credentials;
  audit?: ((e: { actor: string; action: string; target: string; detail?: object }) => void) | null;
  /** 世界暂停（让运行中的世界停下、推送给观众） */
  onHalt?: ((worldId: string, halt: Halt) => void) | null;
  onResume?: ((worldId: string) => void) | null;
  /** 测试用：按凭据建 provider */
  makeProvider?: ((cred: Cred) => Provider) | null;
  now?: () => number;
}

export function createWorldLlm({ registry, credentials, audit = null, onHalt = null, onResume = null, makeProvider = null, now = () => Date.now() }: WorldLlmOptions) {
  const safeFetchFor = (cred: Cred) => makeSafeFetch({ allowPrivate: () => cred.owner === SITE || setting('USER_LLM_PRIVATE_NET') });
  const raw = makeProvider || ((cred: Cred) => credentialProvider({ provider: cred.provider, baseUrl: cred.baseUrl, apiKey: credentials.secret(cred.id), fetch: safeFetchFor(cred) }));
  /** 按凭据建 provider；它抛出的错误一律先脱敏（上游可能在错误里回显密钥），之后的统计、日志、接口都不会带出密钥 */
  function build(cred: Cred): Provider {
    const p = raw(cred);
    let key = '';
    try { key = credentials.secret(cred.id) || ''; } catch { /* 测试里的假凭据 */ }
    const clean = (e: unknown): Error => {
      if (e && typeof e === 'object' && typeof (e as Error).message === 'string') { try { (e as Error).message = scrub((e as Error).message, [key]); } catch { /* 只读的 message */ } return e as Error; }
      return new Error(scrub(String(e), [key]));
    };
    return {
      ...p,
      name: p.name, enabled: p.enabled,
      ...(p.listModels ? { listModels: () => p.listModels!().catch((e) => { throw clean(e); }) } : {}),
      complete: (req: CompleteArgs) => p.complete(req).catch((e) => { throw clean(e); }),
    };
  }

  // ---- 缓存：世界登记项（每次模型调用都要解析，1 秒内复用）、凭据的 provider（凭据改了就换新）、世界的配置档 ----
  const worldCache = new Map<string, { w: WorldEntry | null; at: number }>();
  function world(id: string): WorldEntry | null {
    const c = worldCache.get(id);
    if (c && now() - c.at < 1000) return c.w;
    const w = registry.get(id);
    worldCache.set(id, { w, at: now() });
    return w;
  }
  const invalidate = (id?: string | null) => (id ? worldCache.delete(id) : worldCache.clear());

  const providers = new Map<string, { sig: string; p: Provider }>(); // 凭据 id → { sig, p }
  function providerFor(cred: Cred): Provider {
    const sig = `${cred.updatedAt}|${cred.provider}|${cred.baseUrl}`;
    let e = providers.get(cred.id);
    if (e?.sig !== sig) {
      e = { sig, p: build(cred) };
      providers.set(cred.id, e);
      const l = llm.lane(`cred:${cred.id}`, () => laneOpts(cred));
      l.checked.clear();
      l.fixes = {};
      l.jsonMode = true;
      l.schemaMode = true;
    }
    return e!.p;
  }

  const laneConc = new Map<string, Map<string, number>>(); // 通道 → 世界 → 并发
  function laneOpts(cred: Cred) {
    const key = `cred:${cred.id}`;
    return {
      owner: cred.owner,
      provider: (): Provider => {
        const c = credentials.get(cred.id);
        if (!c) return { name: 'gone', enabled: false, complete: async () => { throw err(503, '模型服务凭据已删除'); } };
        return providerFor(c);
      },
      limit: () => Math.min(setting('USER_LLM_MAX_CONCURRENCY'), Math.max(1, ...(laneConc.get(key)?.values() || [1]))),
    };
  }

  /** 世界能引用这份凭据吗：用户世界只能引用主人的，官方世界只能引用站点凭据 */
  const canUse = (w: WorldEntry | null | undefined, cred: Cred | null | undefined): cred is Cred => Boolean(cred && w && cred.owner === (w.official ? SITE : w.ownerId));
  const ownActive = (w: WorldEntry | null | undefined): w is WorldEntry & { settings: { ai: RawAi } } => Boolean(w && w.settings?.ai?.source === 'own' && (w.official || setting('USER_LLM')));

  const profiles = new Map<string, { sig: string; profile: Profile }>(); // 世界 → { sig, profile }
  function profileFor(w: WorldEntry, ai: OwnAi, cred: Cred): Profile {
    const sig = JSON.stringify([ai.credential, ai.models, ai.timeoutMs, ai.jsonMode, ai.jsonSchema, cred.updatedAt]);
    let e = profiles.get(w.id);
    if (e?.sig === sig) { e.profile.lane.lastUsed = now(); return e.profile; }
    const key = `cred:${cred.id}`;
    const lane = llm.lane(key, () => laneOpts(cred));
    const profile: Profile & { worldId: string } = {
      lane, worldId: w.id,
      models: () => ai.models,
      timeoutMs: () => Math.min(ai.timeoutMs, setting('USER_LLM_MAX_TIMEOUT_MS')),
      jsonMode: ai.jsonMode, schemaMode: ai.jsonSchema,
    };
    e = { sig, profile };
    profiles.set(w.id, e);
    return profile;
  }

  /** llm.setProfileResolver 用：返回配置档、null（用服务器的）或 { blocked }（世界暂停中） */
  function resolve({ worldId }: { worldId: string | null }): Profile | null {
    if (!worldId || worldId === '-') return null;
    const w = world(worldId);
    if (!ownActive(w)) return null;
    const ai = normalizeAi(w.settings.ai) as OwnAi; // ownActive 已确认 source === 'own'
    if (ai.halt) return blockedProfile(haltText(ai.halt));
    const cred = credentials.get(ai.credential);
    if (!canUse(w, cred)) {
      halt([w.id], { code: 'credential', message: HALT_NAMES.credential! });
      return blockedProfile(HALT_NAMES.credential!);
    }
    const lc = laneConc.get(`cred:${cred.id}`) || new Map();
    lc.set(w.id, ai.concurrency);
    laneConc.set(`cred:${cred.id}`, lc);
    return profileFor(w, ai, cred);
  }

  const haltText = (h: Halt): string => `这个世界的 AI 服务暂停了：${HALT_NAMES[h.code] || h.message || '模型服务出错'}`;

  // ---- 暂停与恢复 ----
  function halt(worldIds: string[], { code, message = '', credential = null }: { code: string; message?: string; credential?: string | null }): void {
    const at = now();
    for (const id of worldIds) {
      const w = registry.get(id);
      if (!w) continue;
      const ai = w.settings?.ai || {};
      if (ai.halt) continue; // 已经暂停：保留第一次的原因
      const h: Halt = { code, message: scrub(String(message || HALT_NAMES[code] || '')).slice(0, 300), credential, at };
      registry.update(id, { settings: { ai: { ...ai, halt: h } } });
      invalidate(id);
      llm.dropWorld(id, haltText(h));
      audit?.({ actor: 'system', action: 'world.ai-halt', target: id, detail: { code, credential } });
      console.warn(`[world-llm] ${id} 暂停：${h.message}`);
      try { onHalt?.(id, h); } catch (e) { console.warn('[world-llm] 暂停世界失败：', (e as Error).message); }
    }
  }

  function resume(worldId: string, { by = 'system' }: { by?: string } = {}): boolean {
    const w = registry.get(worldId);
    const ai = w?.settings?.ai;
    if (!ai?.halt) return false;
    const { halt: _, ...rest } = ai;
    registry.update(worldId, { settings: { ai: rest } });
    invalidate(worldId);
    audit?.({ actor: by, action: 'world.ai-resume', target: worldId, detail: { code: ai.halt.code } });
    console.log(`[world-llm] ${worldId} 恢复运行`);
    try { onResume?.(worldId); } catch (e) { console.warn('[world-llm] 恢复世界失败：', (e as Error).message); }
    return true;
  }

  /** 正在引用这份凭据的世界（主模型） */
  const worldsUsing = (credId: string): Array<WorldEntry & { settings: { ai: RawAi } }> => registry.list().filter((w): w is WorldEntry & { settings: { ai: RawAi } } => w.settings?.ai?.source === 'own' && w.settings.ai.credential === credId);

  /** llm.onFailure：自带通道的致命错误 */
  function onFailure({ lane, kind, error, worldId, model }: FailureEvent): void {
    const credId = lane.key.startsWith('cred:') ? lane.key.slice(5) : null;
    if (!credId) return;
    // 上游的错误信息可能回显密钥（例如「Incorrect API key provided: sk-…」）：写进世界设置、审计之前先脱敏
    let key = '';
    try { key = credentials.secret(credId) || ''; } catch { /* 解不开也照样脱敏其他片段 */ }
    const msg = scrub(String((error as Error)?.message || error), [key]);
    if (kind === 'model') {
      if (worldId) halt([worldId], { code: 'model', message: `模型 ${model} 不存在：${msg}`.slice(0, 300), credential: credId });
      return;
    }
    if (kind === 'net') {
      if (lane.netFails < setting('USER_LLM_HALT_NET_FAILS') || now() - lane.netFailSince < NET_HALT_MS) return;
    }
    credentials.mark(credId, { status: 'failing', failCode: kind, error: msg });
    halt(worldsUsing(credId).map((w) => w.id), { code: kind!, message: `${HALT_NAMES[kind!]}：${msg}`.slice(0, 300), credential: credId });
  }

  // ---- 测试连接 ----
  /**
   * 列出模型，再用 model（没给就用列表里的第一个）发一次很短的补全。
   * 返回 { ok, models, model, ms, kind, error }；kind 是 llm.failureKind 的分类
   */
  async function test(cred: Cred, { model = '' }: { model?: string } = {}): Promise<TestResult> {
    const started = now();
    let provider: Provider;
    try { provider = build(cred); } catch (e) { return { ok: false, models: [], ms: 0, kind: 'auth', error: (e as Error).message }; }
    let models: string[] = [];
    let listErr: Error | null = null;
    try { models = provider.listModels ? await provider.listModels() : []; } catch (e) { listErr = e as Error; }
    const k = listErr ? llm.failureKind(listErr) : null;
    if (listErr && (['auth', 'balance', 'address'] as FailureKind[]).includes(k)) return { ok: false, models: [], ms: now() - started, kind: k, error: listErr.message };
    const use = model || models[0] || '';
    if (!use) return { ok: !listErr, models, ms: now() - started, kind: listErr ? k || 'net' : null, error: listErr ? listErr.message : '', warning: listErr ? '' : '接口没有返回模型列表' };
    try {
      const ctrl = AbortSignal.timeout(30_000);
      await provider.complete({ model: use, messages: [{ role: 'user', content: '回复“好”' }], temperature: 0, maxTokens: 8, json: false, signal: ctrl });
      return { ok: true, models, model: use, ms: now() - started, kind: null, error: '' };
    } catch (e) {
      return { ok: false, models, model: use, ms: now() - started, kind: llm.failureKind(e) || 'net', error: (e as Error).message };
    }
  }

  /** 测试一份已保存的凭据并记下结果；通过时恢复因它暂停的世界。返回测试结果 */
  async function checkCredential(credId: string, { by = 'system' }: { by?: string } = {}): Promise<TestResult> {
    const cred = credentials.get(credId);
    if (!cred) throw err(404, '凭据不存在');
    const r = await test(cred);
    credentials.mark(credId, r.ok ? { status: 'ok', models: r.models } : { status: 'failing', failCode: r.kind, error: r.error });
    if (r.ok) {
      for (const w of worldsUsing(credId)) if (w.settings.ai.halt && CRED_LEVEL.has(w.settings.ai.halt.code)) resume(w.id, { by });
    }
    return { ...r, error: r.ok ? '' : credentials.get(credId)!.lastError as string };
  }

  /** 世界的「重试」：用世界自己的模型测试；通过就恢复 */
  async function retryWorld(worldId: string, { by = 'system' }: { by?: string } = {}): Promise<Partial<TestResult> & { ok: boolean }> {
    const w = registry.get(worldId);
    if (!w) throw err(404, '世界不存在');
    const ai = normalizeAi(w.settings?.ai);
    if (ai.source !== 'own') { resume(worldId, { by }); return { ok: true }; }
    const cred = credentials.get(ai.credential);
    if (!canUse(w, cred)) return { ok: false, kind: 'credential', error: HALT_NAMES.credential };
    const r = await test(cred, { model: ai.models.default });
    credentials.mark(cred.id, r.ok ? { status: 'ok', models: r.models } : { status: 'failing', failCode: r.kind, error: r.error });
    if (r.ok) {
      resume(worldId, { by });
      for (const o of worldsUsing(cred.id)) if (o.settings.ai.halt && CRED_LEVEL.has(o.settings.ai.halt.code)) resume(o.id, { by });
    }
    return { ...r, error: r.ok ? '' : credentials.get(cred.id)!.lastError as string };
  }

  /** 「持续连不上」的凭据：定时探测，连通后恢复 */
  async function probe(): Promise<void> {
    const ids = new Set<string>();
    for (const w of registry.list()) if (w.settings?.ai?.halt?.code === 'net' && w.settings.ai.halt.credential) ids.add(w.settings.ai.halt.credential);
    for (const id of ids) { try { await checkCredential(id); } catch { /* 下次再试 */ } }
  }
  let probeTimer: NodeJS.Timeout | null = null;
  function start() { probeTimer ||= setInterval(() => { probe(); llm.sweepLanes(); }, PROBE_MS); probeTimer.unref?.(); }
  function stop() { clearInterval(probeTimer ?? undefined); probeTimer = null; }

  // ---- 校验世界的 AI 配置（保存时）----
  /** 校验提交的 settings.ai；返回规范化后的配置（halt 保留原值） */
  function validate(input: RawAi, w: WorldEntry): AiConfig {
    const ai = normalizeAi(input);
    const prevHalt = w?.settings?.ai?.halt || null;
    if (ai.source === 'server') return { source: 'server', ...(prevHalt ? { halt: prevHalt } : {}) };
    if (!w.official && !setting('USER_LLM')) throw err(403, '站点没有开放自带模型服务');
    for (const [field, id] of [['credential', ai.credential], ['embed', ai.embed.credential], ['review', ai.review.credential]] as const) {
      if (field !== 'credential' && !id) continue;
      const c = credentials.get(id);
      if (!canUse(w, c)) throw err(400, field === 'credential' ? '请选择一份自己的模型服务' : '引用的模型服务不存在', { field });
      if (!w.official && !(setting('USER_LLM_PROVIDERS') as string[]).includes(c.provider)) throw err(403, `站点没有开放 ${c.provider} 类型的模型服务`, { field });
    }
    if (!ai.models.default) throw err(400, '请填写默认模型', { field: 'models' });
    for (const m of [ai.models.default, ai.models.fast, ai.models.smart, ai.embed.model, ai.review.model]) if (m && !MODEL_RE.test(m)) throw err(400, `模型名不合法：${m}`, { field: 'models' });
    if (ai.embed.model && credentials.get(ai.embed.credential || ai.credential)?.provider !== 'openai') throw err(400, '语义检索只支持 OpenAI 兼容接口的 embedding 模型', { field: 'embed' });
    ai.concurrency = Math.min(ai.concurrency, setting('USER_LLM_MAX_CONCURRENCY'));
    ai.timeoutMs = Math.min(ai.timeoutMs, setting('USER_LLM_MAX_TIMEOUT_MS'));
    ai.halt = prevHalt;
    if (!ai.halt) delete ai.halt;
    return ai;
  }

  /** 凭据的字段检查（保存时） */
  function credentialProblem({ provider, baseUrl, apiKey }: { provider?: string; baseUrl?: string; apiKey?: string }, { owner, partial = false }: { owner?: string; partial?: boolean } = {}): string | null {
    if (!partial || provider !== undefined) {
      if (!CREDENTIAL_PROVIDERS.includes(provider as string)) return '不支持的服务类型';
      if (owner !== SITE && !(setting('USER_LLM_PROVIDERS') as string[]).includes(provider as string)) return `站点没有开放 ${provider} 类型的模型服务`;
    }
    if (baseUrl !== undefined && baseUrl !== '') {
      const p = urlProblem(baseUrl, { allowPrivate: owner === SITE || setting('USER_LLM_PRIVATE_NET') });
      if (p) return p;
    }
    if (!partial && provider === 'openai' && !baseUrl) return 'OpenAI 兼容接口需要填写接口地址';
    if (!partial || apiKey !== undefined) {
      if (!partial && !apiKey) return '请填写密钥';
      if (apiKey && (String(apiKey).length > 500 || /\s/.test(String(apiKey)))) return '密钥格式不对';
    }
    return null;
  }

  // ---- 其他子系统 ----
  /** 这个世界是不是用自己的模型服务（额度计算、创世额度用） */
  const isOwn = (worldId: string): boolean => ownActive(world(worldId));

  /** 语义检索：自带时用世界配置的 embedding（没配就不开），不借用服务器的 */
  function embedFor(worldId: string): { env: Env; fetch?: typeof fetch } | null {
    const w = world(worldId);
    if (!ownActive(w)) return null;
    const ai = normalizeAi(w.settings.ai) as OwnAi;
    if (!ai.embed.model) return { env: { EMBED_MODEL: '' } };
    const cred = credentials.get(ai.embed.credential || ai.credential);
    if (!canUse(w, cred) || cred.provider !== 'openai') return { env: { EMBED_MODEL: '' } };
    return { env: { EMBED_MODEL: ai.embed.model, EMBED_BASE_URL: cred.baseUrl, EMBED_API_KEY: credentials.secret(cred.id), EMBED_TIMEOUT_MS: String(setting('EMBED_TIMEOUT_MS')) }, fetch: safeFetchFor(cred) };
  }

  /** 进化评审：自带时用世界配置的评审模型（没配就用世界的强模型），不借用服务器的评审模型 */
  function reviewFor(worldId: string): { model: string; provider: Provider | null } | null {
    const w = world(worldId);
    if (!ownActive(w)) return null;
    const ai = normalizeAi(w.settings.ai) as OwnAi;
    const cred = ai.review.credential ? credentials.get(ai.review.credential) : null;
    return {
      model: ai.review.model || '',
      provider: cred && canUse(w, cred) ? providerFor(cred) : null,
    };
  }

  /** 世界 AI 状态（接口用；不含任何密钥） */
  function view(w: WorldEntry) {
    const ai = normalizeAi(w.settings?.ai);
    const cred = ai.source === 'own' ? credentials.get(ai.credential) : null;
    const lane = cred ? llm.lanesView().find((l) => l.key === `cred:${cred.id}`) : null;
    return {
      ai, active: ownActive(w), halted: Boolean(ai.halt), haltText: ai.halt ? haltText(ai.halt) : '',
      credential: cred ? { id: cred.id, name: cred.name, provider: cred.provider, status: cred.status, failCode: cred.failCode, lastError: cred.lastError, keyLast4: cred.keyLast4 } : null,
      lane: lane ? { inflight: lane.inflight, queued: lane.queued, limit: lane.limit, errors: lane.errors, lastError: lane.lastError, fixes: lane.fixes } : null,
    };
  }

  return {
    resolve, onFailure, halt, resume, test, checkCredential, retryWorld, probe, start, stop, validate, credentialProblem,
    isOwn, embedFor, reviewFor, view, invalidate, worldsUsing, normalizeAi, haltText, canUse,
    /** 凭据换了或删了：清掉缓存的 provider，回收通道 */
    credentialChanged(id: string) { providers.delete(id); for (const [wid, e] of profiles) if (e.profile.lane.key === `cred:${id}`) profiles.delete(wid); invalidate(); },
    credentialRemoved(id: string) { providers.delete(id); llm.dropLane(`cred:${id}`, '模型服务凭据已删除'); invalidate(); },
  };
}
