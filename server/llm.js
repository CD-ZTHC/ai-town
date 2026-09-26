// LLM 客户端：并发队列、重试、模型分档与自动校正、JSON 提取、统计。发请求交给 provider（见 llm-providers.js）
import fs from 'node:fs';
import { createProvider } from './llm-providers.js';

let provider = createProvider(process.env.LLM_PROVIDER || 'openai');
const CONCURRENCY = Number(process.env.LLM_CONCURRENCY || 4);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 150_000);

const PUBLIC = process.env.PUBLIC_MODE === '1' || process.env.PUBLIC_MODE === 'true';
// 每日令牌预算（0 = 不限）。公网模式默认 300 万，超出后小镇退化为规则驱动，玩家交互暂停
const DAILY_BUDGET = Number(process.env.LLM_DAILY_TOKENS ?? (PUBLIC ? 3_000_000 : 0));

// 模型分档：fast 用于高频的小任务（独白、审核），smart 用于低频的重要任务（日报，以及之后的叙事导演、世界架构师）。
// 未配置的档位回落到 MODEL，因此只配置 MODEL 时行为与之前完全一致。
const models = {
  default: process.env.MODEL || '',
  fast: process.env.MODEL_FAST || '',
  smart: process.env.MODEL_SMART || '',
};
const modelFor = (tier) => models[tier] || models.default;
// JSON 模式（response_format: json_object）：大幅减少模型输出不合法 JSON 的情况。
// 网关不支持时会报错，此时自动关闭并重试；也可以用 LLM_JSON_MODE=0 手动关闭。
let jsonMode = process.env.LLM_JSON_MODE !== '0';
let modelChecked = false;
const listeners = new Set();

export const stats = {
  enabled: provider.enabled,
  model: models.default,
  models: { fast: modelFor('fast'), smart: modelFor('smart') },
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
  dailyBudget: DAILY_BUDGET,
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
function rollDay() {
  const k = new Date().toISOString().slice(0, 10);
  if (stats.dayKey !== k) { stats.dayKey = k; stats.dayTokens = 0; }
}
export function budgetLeft() {
  rollDay();
  return DAILY_BUDGET ? Math.max(0, DAILY_BUDGET - stats.dayTokens) : Infinity;
}
export const queueSize = () => queue.length + stats.inflight;

async function ensureModel() {
  if (modelChecked || !stats.enabled) return;
  modelChecked = true;
  try {
    const ids = provider.listModels ? await provider.listModels() : [];
    for (const tier of Object.keys(models)) {
      const want = models[tier];
      if (!want || !ids.length || ids.includes(want)) continue;
      // 容错：尝试找到字符组成最相近的模型（例如 glm-5.3-xflash -> glm-5.3-flashx）
      const score = (id) => {
        const a = [...want].sort().join('');
        const b = [...id].sort().join('');
        let same = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
        return same - Math.abs(a.length - b.length) * 2;
      };
      const best = ids.slice().sort((x, y) => score(y) - score(x))[0];
      console.warn(`[llm] 模型 "${want}"（${tier}）不可用，自动改用 "${best}"（可用: ${ids.join(', ')}）`);
      models[tier] = best;
    }
    stats.model = models.default;
    stats.models = { fast: modelFor('fast'), smart: modelFor('smart') };
  } catch (e) {
    console.warn('[llm] 无法获取模型列表：', e.message);
  }
}

// ---- 并发队列（带自适应限流）----
const queue = [];
let penalty = 0; // 触发限流后临时降低并发
let cooldownUntil = 0;
let backoff = 0;
let pumpTimer = null;
const limit = () => Math.max(1, CONCURRENCY - penalty);
export const isBusy = () => queue.length > 1 || stats.inflight >= limit() || Date.now() < cooldownUntil;
function pump() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) {
    if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
    stats.queued = queue.length;
    return notify();
  }
  while (stats.inflight < limit() && queue.length) {
    const job = queue.shift();
    stats.queued = queue.length;
    stats.inflight++;
    job().finally(() => {
      stats.inflight--;
      pump();
      notify();
    });
  }
  stats.queued = queue.length;
  notify();
}
function enqueue(fn, priority = false) {
  return new Promise((resolve, reject) => {
    const job = () => fn().then(resolve, reject);
    priority ? queue.unshift(job) : queue.push(job);
    pump();
  });
}

let seq = 0;
async function rawChat(messages, { maxTokens = 3000, temperature = 0.9, label = 'llm', agent = null, timeoutMs = TIMEOUT_MS, attempts = 3, tier = 'default', json = false }) {
  await ensureModel();
  const model = modelFor(tier);
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
        const { content, usage, finishReason } = await provider.complete({ model, messages, temperature, maxTokens, json: json && jsonMode, signal: ctrl.signal });
        stats.promptTokens += usage.prompt;
        stats.completionTokens += usage.completion;
        rollDay();
        stats.dayTokens += usage.prompt + usage.completion;
        const u = (stats.byLabel[label] ||= { calls: 0, fails: 0, tokens: 0, ms: 0 });
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
        if (json && jsonMode && /response_format|json_object|json mode/i.test(e.message)) {
          jsonMode = false;
          console.warn('[llm] 网关不支持 JSON 模式，已自动关闭');
          continue;
        }
        if (/速率|频率|rate.?limit|429|too many|concurren|并发/i.test(e.message)) {
          // 限流：全局冷却 + 指数退避 + 降低并发
          backoff = Math.min(5, backoff + 1);
          penalty = Math.min(CONCURRENCY - 1, penalty + 1);
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
    (stats.byLabel[label] ||= { calls: 0, fails: 0, tokens: 0, ms: 0 }).fails++;
    throw lastErr;
  } finally {
    stats.active = stats.active.filter((a) => a.id !== id);
  }
}

function pushRecent(r) {
  stats.recent.unshift({ ...r, at: Date.now() });
  stats.recent.length = Math.min(stats.recent.length, 12);
}

// 测试用：注入一个假的模型（fn(messages, opts) => 回复文本），不发出任何网络请求
let mock = null;
export function setMock(fn) {
  mock = fn || null;
  stats.enabled = Boolean(mock) || provider.enabled;
}

/** 换用另一个 provider（测试，或在启动时接入其他 SDK）；模型名会重新校验 */
export function setProvider(p) {
  provider = p;
  modelChecked = false;
  stats.enabled = Boolean(mock) || provider.enabled;
}

export function chat(messages, opts = {}) {
  if (mock) return Promise.resolve().then(() => mock(messages, opts));
  if (!stats.enabled) return Promise.reject(new Error('LLM 未配置'));
  if (budgetLeft() <= 0) return Promise.reject(new BudgetError());
  const p = enqueue(() => rawChat(messages, opts), opts.priority);
  return RECORD_FILE ? p.then((content) => { record(opts.label || 'llm', content); return content; }) : p;
}

// 录制真实回复，供无头回放测试使用：LLM_RECORD=test/fixtures/llm/responses.json mise run start
// 按模块（label）分组，每个模块保留最近 RECORD_KEEP 条；能解析成 JSON 的存成对象，方便人工审阅与修改
const RECORD_FILE = process.env.LLM_RECORD || '';
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
    // 常见修复：中文引号、尾逗号
    const fixed = s
      .replace(/[“”]/g, '"')
      .replace(/"\s*：\s*/g, '":') // 键后面的全角冒号
      .replace(/"\s*，\s*"/g, '","') // 字符串之间的全角逗号
      .replace(/([:[,]\s*)\+(\d)/g, '$1$2') // 数字前的 + 号
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\n/g, ' ');
    return JSON.parse(fixed);
  }
}

export async function chatJSON(messages, opts = {}) {
  opts = { json: true, ...opts };
  let content = await chat(messages, opts);
  try {
    return extractJSON(content);
  } catch {
    content = await chat(
      [...messages, { role: 'assistant', content }, { role: 'user', content: '上面的输出不是合法 JSON。请只输出合法的 JSON，不要任何其他文字。' }],
      opts,
    );
    return extractJSON(content);
  }
}
