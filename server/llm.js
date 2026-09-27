// LLM 客户端：并发队列、重试、模型分档与自动校正、JSON 提取、统计。发请求交给 provider（见 llm-providers.js）
import fs from 'node:fs';
import { createProvider } from './llm-providers.js';
import { get as setting, env as settingsEnv } from './settings/index.js';
import { Scheduler } from './scheduler/index.js';
import { classOf } from './scheduler/classes.js';
import { currentContext } from './scheduler/context.js';

// provider 按「服务类型 + 地址 + 密钥」缓存：面板里改了地址或密钥，下一次调用就换用新的
let injected = null; // 测试或启动时注入的 provider（setProvider）
let cached = null;
function currentProvider() {
  if (injected) return injected;
  const sig = JSON.stringify([setting('LLM_PROVIDER'), setting('BASE_URL'), setting('API_KEY')]);
  if (cached?.sig !== sig) {
    cached = { sig, p: createProvider(setting('LLM_PROVIDER'), settingsEnv()) };
    checked.clear();
  }
  return cached.p;
}
const concurrency = () => setting('LLM_CONCURRENCY');
const timeoutMsSetting = () => setting('LLM_TIMEOUT_MS');
// 每日令牌预算（0 = 不限）。公网模式默认 300 万，超出后世界退化为规则驱动，玩家交互暂停
const dailyBudget = () => setting('LLM_DAILY_TOKENS');

// 模型分档：fast 用于高频的小任务（独白、审核），smart 用于低频的重要任务（日报、叙事导演、世界架构师）。
// 未配置的档位回落到 MODEL，因此只配置 MODEL 时行为与之前完全一致。
// fixes：模型名写错时自动纠正的结果（想要的名字 → 实际使用的名字）
const fixes = {};
const checked = new Set();
const wanted = (tier) => (tier === 'fast' ? setting('MODEL_FAST') : tier === 'smart' ? setting('MODEL_SMART') : '') || setting('MODEL');
const modelFor = (tier) => { const w = wanted(tier); return fixes[w] || w; };
// JSON 模式（response_format: json_object）：大幅减少模型输出不合法 JSON 的情况。
// 网关不支持时会报错，此时自动关闭并重试；也可以用 LLM_JSON_MODE=0 手动关闭。
let jsonMode = setting('LLM_JSON_MODE');
export function setJsonMode(on) { jsonMode = Boolean(on); }
// 结构化输出（response_format: json_schema）：调用方给了 schema 且 LLM_JSON_SCHEMA=1 时使用；
// 网关不支持时自动退回普通 JSON 模式
let schemaMode = setting('LLM_JSON_SCHEMA');
export function setJsonSchema(on) { schemaMode = Boolean(on); }
const listeners = new Set();

export const stats = {
  get enabled() { return Boolean(mock) || currentProvider().enabled; },
  get model() { return modelFor('default'); },
  get models() { return { fast: modelFor('fast'), smart: modelFor('smart') }; },
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
  dayTokens: 0,
  get dailyBudget() { return dailyBudget(); },
  recent: [], // {label, agent, ms, ok, at}
  byLabel: {}, // 按模块统计：{ 规划一天: { calls, fails, tokens, ms } }
  active: [], // {id, label, agent, since}
};

export function onActivity(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => fn(stats));

export class BudgetError extends Error {
  constructor() { super('今日 AI 额度已用完'); this.code = 'BUDGET'; }
}
/** 本地日期（YYYY-MM-DD）：每日额度按服务器所在时区的午夜重置，而不是 UTC 午夜 */
export function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function rollDay() {
  const k = localDayKey();
  if (stats.dayKey !== k) { stats.dayKey = k; stats.dayTokens = 0; }
}
export function budgetLeft() {
  rollDay();
  const b = dailyBudget();
  return b ? Math.max(0, b - stats.dayTokens) : Infinity;
}
/** 队列长度：不传世界时是全局（排队 + 进行中），传世界时是这个世界的积压（按世界调速用） */
export const queueSize = (worldId = null) => (worldId ? sched.backlog(worldId) : sched.queued() + stats.inflight);

async function ensureModel() {
  const provider = currentProvider();
  const want = [...new Set(['default', 'fast', 'smart'].map(wanted))].filter((w) => w && !checked.has(w));
  if (!want.length || !stats.enabled) return;
  for (const w of want) checked.add(w);
  try {
    const ids = provider.listModels ? await provider.listModels() : [];
    for (const w of want) {
      if (!ids.length || ids.includes(w)) continue;
      // 容错：尝试找到字符组成最相近的模型（例如 glm-5.3-xflash -> glm-5.3-flashx）
      const score = (id) => {
        const a = [...w].sort().join('');
        const b = [...id].sort().join('');
        let same = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
        return same - Math.abs(a.length - b.length) * 2;
      };
      const best = ids.slice().sort((x, y) => score(y) - score(x))[0];
      console.warn(`[llm] 模型 "${w}" 不可用，自动改用 "${best}"（可用: ${ids.join(', ')}）`);
      fixes[w] = best;
    }
  } catch (e) {
    console.warn('[llm] 无法获取模型列表：', e.message);
  }
}

// ---- 统一调度（多世界设计 §7）：一个队列、一个并发上限；按级别与世界出队，带自适应限流 ----
let penalty = 0; // 触发限流后临时降低并发
let cooldownUntil = 0;
let backoff = 0;
let pumpTimer = null;
const limit = () => Math.max(1, concurrency() - penalty);
// allow：出队前的额度检查（按世界的分层预算，见 scheduler/budget.js；由服务入口设置）
let budgetPolicy = () => true;
export function setBudgetPolicy(fn) { budgetPolicy = fn || (() => true); }
export const sched = new Scheduler({ limit, agingMs: () => setting('PRIORITY_AGING_MIN') * 60_000, allow: (job) => budgetPolicy(job) });
/** 队列忙：调用点（导演、独白、群体心智）据此让路；让路记在当前世界上，作为公平补偿的依据 */
export const isBusy = () => {
  const busy = sched.queued() > 1 || stats.inflight >= limit() || Date.now() < cooldownUntil;
  if (busy) sched.noteYield(currentContext().worldId);
  return busy;
};
function pump() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) {
    if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
    stats.queued = sched.queued();
    return notify();
  }
  for (let job = sched.next(); job; job = sched.next()) {
    sched.started(job);
    stats.inflight++;
    stats.queued = sched.queued();
    job.run().finally(() => {
      sched.finished(job);
      stats.inflight--;
      pump();
      notify();
    });
  }
  stats.queued = sched.queued();
  notify();
}
/** 放进队列：级别由 label 决定（调用点不再自己选优先级），世界与用户来自调用上下文 */
function enqueue(fn, opts) {
  const ctx = currentContext();
  return new Promise((resolve, reject) => {
    sched.push({ cls: opts.cls || classOf(opts.label), worldId: ctx.worldId, userId: ctx.userId, label: opts.label, run: () => fn(ctx).then(resolve, reject), reject });
    pump();
  });
}

// ---- 用量账本：每次调用结束后记下 { worldId, userId, class, tokens }（由服务入口写进 usage 表）----
const usageListeners = new Set();
export function onUsage(fn) { usageListeners.add(fn); return () => usageListeners.delete(fn); }

let seq = 0;
async function rawChat(messages, { maxTokens = 3000, temperature = 0.9, label = 'llm', agent = null, timeoutMs = timeoutMsSetting(), attempts = 3, tier = 'default', json = false, schema = null, model: override = '', provider: providerOverride = null, cls = null, onTokens = null }, ctx = {}) {
  await ensureModel();
  // override：进化引擎的评审 Agent 可以指定另一个模型（EVOLVE_REVIEW_MODEL）
  const model = override || modelFor(tier);
  const id = ++seq;
  const started = Date.now();
  stats.active.push({ id, label, agent, since: started, model });
  stats.calls++;
  notify();
  let lastErr;
  try {
    for (let attempt = 0; attempt < attempts + 3; attempt++) {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * 500));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const withSchema = Boolean(schema && json && jsonMode && schemaMode);
        const { content, usage, finishReason } = await (providerOverride || currentProvider()).complete({ model, messages, temperature, maxTokens, json: json && jsonMode, ...(withSchema ? { schema } : {}), signal: ctrl.signal });
        stats.promptTokens += usage.prompt;
        stats.completionTokens += usage.completion;
        rollDay();
        stats.dayTokens += usage.prompt + usage.completion;
        const tokens = usage.prompt + usage.completion;
        onTokens?.(tokens);
        for (const fn of usageListeners) { try { fn({ worldId: ctx.worldId || null, userId: ctx.userId || null, cls: cls || classOf(label), label, tokens }); } catch { /* 账本失败不影响调用 */ } }
        const u = labelStats(label);
        u.calls++;
        u.tokens += usage.prompt + usage.completion;
        u.ms += Date.now() - started;
        if (!content.trim()) throw new Error(`空回复 (finish_reason=${finishReason})`);
        const ms = Date.now() - started;
        backoff = Math.max(0, backoff - 1);
        if (stats.ok % 5 === 0 && penalty > 0) penalty--;
        stats.ok++;
        stats.avgMs = stats.avgMs ? stats.avgMs * 0.85 + ms * 0.15 : ms;
        pushRecent({ label, agent, ms, ok: true });
        return content;
      } catch (e) {
        lastErr = e;
        if (/no access|invalid.*key|unauthori/i.test(e.message)) break;
        if (schema && json && jsonMode && schemaMode && /json_schema|response_format|schema/i.test(e.message)) {
          schemaMode = false;
          console.warn('[llm] 网关不支持结构化输出（json_schema），已退回普通 JSON 模式');
          continue;
        }
        if (json && jsonMode && /response_format|json_object|json mode/i.test(e.message)) {
          jsonMode = false;
          console.warn('[llm] 网关不支持 JSON 模式，已自动关闭');
          continue;
        }
        if (/速率|频率|rate.?limit|429|too many|concurren|并发/i.test(e.message)) {
          // 限流：全局冷却 + 指数退避 + 降低并发
          backoff = Math.min(5, backoff + 1);
          penalty = Math.min(concurrency() - 1, penalty + 1);
          cooldownUntil = Math.max(cooldownUntil, Date.now() + 4000 * 2 ** (backoff - 1));
          stats.lastError = `限流中，${Math.round((cooldownUntil - Date.now()) / 1000)}s 后重试`;
          continue;
        }
        if (attempt >= attempts - 1) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    stats.errors++;
    stats.lastError = String(lastErr?.message || lastErr).slice(0, 200);
    pushRecent({ label, agent, ms: Date.now() - started, ok: false });
    labelStats(label).fails++;
    throw lastErr;
  } finally {
    stats.active = stats.active.filter((a) => a.id !== id);
  }
}

/** 按模块的统计：请求次数、失败、token、耗时；json / repairs / badJson 是 chatJSON 的解析情况 */
function labelStats(label) {
  return (stats.byLabel[label] ||= { calls: 0, fails: 0, tokens: 0, ms: 0, json: 0, repairs: 0, badJson: 0 });
}

function pushRecent(r) {
  stats.recent.unshift({ ...r, at: Date.now() });
  stats.recent.length = Math.min(stats.recent.length, 12);
}

// 测试用：注入一个假的模型（fn(messages, opts) => 回复文本），不发出任何网络请求
let mock = null;
export function setMock(fn) {
  mock = fn || null;
}

/** 换用另一个 provider（测试，或在启动时接入其他 SDK）；模型名会重新校验 */
export function setProvider(p) {
  injected = p || null;
  checked.clear();
}

export function chat(messages, opts = {}) {
  if (mock) return Promise.resolve().then(() => mock(messages, opts));
  if (!stats.enabled) return Promise.reject(new Error('LLM 未配置'));
  if (budgetLeft() <= 0) return Promise.reject(new BudgetError());
  const p = enqueue((ctx) => rawChat(messages, opts, ctx), opts);
  return RECORD_FILE ? p.then((content) => { record(opts.label || 'llm', content); return content; }) : p;
}

// 录制真实回复，供无头回放测试使用：LLM_RECORD=test/fixtures/llm/responses.json mise run start
// 按模块（label）分组，每个模块保留最近 RECORD_KEEP 条；能解析成 JSON 的存成对象，方便人工审阅与修改
const RECORD_FILE = setting('LLM_RECORD');
const RECORD_KEEP = 4;
function record(label, content) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8')); } catch {}
    let entry = content;
    try { entry = extractJSON(content); } catch {}
    all[label] = [...(all[label] || []), entry].slice(-RECORD_KEEP);
    fs.writeFileSync(RECORD_FILE, JSON.stringify(all, null, 2) + '\n');
  } catch (e) {
    console.warn('[llm] 录制失败：', e.message);
  }
}

export function extractJSON(text) {
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
      const at = Number(/position (\d+)/.exec(e.message)?.[1]);
      throw new Error(Number.isFinite(at) ? `${e.message}（附近：${fixed.slice(Math.max(0, at - 60), at + 40)}）` : e.message);
    }
  }
}

// 值可以从这些字符开始（用来判断字符串里的引号后面跟着的 , 或 : 是不是 JSON 结构）
const VALUE_START = /["“{[+\-\d]|true|false|null/y;
const skipWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

/** 引号 s[i] 是不是在结束字符串：后面（跳过空白）是 } ] 或结尾，或者是 , : 且再后面是一个值（逗号后面也可以是尾逗号的 } ]） */
function closesString(s, i) {
  let j = skipWs(s, i + 1);
  if (j >= s.length || s[j] === '}' || s[j] === ']') return true;
  if (!',:，：'.includes(s[j])) return false;
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
export function repairJSON(s) {
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

export async function chatJSON(messages, opts = {}) {
  opts = { json: true, ...opts };
  let content = await chat(messages, opts);
  const s = labelStats(opts.label || 'llm');
  s.json++;
  try {
    return extractJSON(content);
  } catch (e) {
    // 输出不是合法 JSON：让模型改一次（计入 repairs），还不行计入 badJson
    s.repairs++;
    console.warn(`[llm] ${opts.label || 'llm'} 的回复不是合法 JSON，让模型重写：${String(e.message).slice(0, 240)}`);
    content = await chat(
      [...messages, { role: 'assistant', content }, { role: 'user', content: '上面的输出不是合法 JSON。请只输出合法的 JSON，不要任何其他文字。' }],
      opts,
    );
    try {
      return extractJSON(content);
    } catch (e) {
      s.badJson++;
      throw e;
    }
  }
}
