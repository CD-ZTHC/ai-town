// 进化引擎的模型调用：实施类 Agent 用 MODEL_SMART；评审类 Agent 可以单独配置另一个模型（甚至另一家服务），
// 避免「同一个模型写、同一个模型审」的共同盲区。所有调用计入进化预算（EVOLVE_BUDGET，0 为不限）。
import * as base from '../server/llm.js';
import { openaiCompatible } from '../server/llm-providers.js';
import { BudgetExceeded } from './common.js';
import { get as setting } from '../server/settings/index.js';

const REVIEW = {
  url: setting('EVOLVE_REVIEW_BASE_URL').replace(/\/+$/, ''),
  key: setting('EVOLVE_REVIEW_API_KEY'),
  model: setting('EVOLVE_REVIEW_MODEL'),
};

export function reviewInfo() {
  const own = Boolean(REVIEW.url && REVIEW.key && REVIEW.model);
  const model = own || REVIEW.model ? REVIEW.model : base.stats.models.smart;
  return { model, separateService: own, sameModel: model === base.stats.models.smart };
}

async function reviewChat(messages, { maxTokens, temperature }) {
  const res = await fetch(`${REVIEW.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REVIEW.key}` },
    body: JSON.stringify({ model: REVIEW.model, messages, max_tokens: maxTokens, temperature, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return { json: base.extractJSON(data.choices?.[0]?.message?.content || ''), tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0) };
}

/**
 * 在主进程里执行一次进化引擎的模型调用（多世界设计 §7.5）：放进统一队列的 P4 级，记在 worldId 名下。
 * 评审模型单独配置了另一家服务时，同样走这个队列，只是换一个 provider。返回 { json, tokens }。
 */
export async function hostCall({ role, messages, review = false, maxTokens = 4000, temperature = 0.4 }) {
  const own = Boolean(REVIEW.url && REVIEW.key && REVIEW.model);
  let tokens = 0;
  const json = await base.chatJSON(messages, {
    tier: 'smart', label: `进化：${role}`, agent: '进化引擎', maxTokens, temperature, attempts: 2, timeoutMs: 180_000,
    ...(review && REVIEW.model ? { model: REVIEW.model } : {}),
    ...(review && own ? { provider: openaiCompatible({ baseUrl: REVIEW.url, apiKey: REVIEW.key }) } : {}),
    onTokens: (n) => { tokens += n; },
  });
  return { json, tokens };
}

// 守护进程由小镇服务器以 IPC 通道启动时，模型调用交给主进程排队（守护进程自己不联网、不持有第二份队列）
let ipcSeq = 0;
const ipcWaiting = new Map();
function ipcCall(payload) {
  if (!ipcWaiting.size) process.on('message', onIpc);
  const id = ++ipcSeq;
  return new Promise((resolve, reject) => {
    ipcWaiting.set(id, { resolve, reject });
    process.send({ type: 'llm', id, ...payload });
  });
}
function onIpc(m) {
  if (m?.type !== 'llm-result' || !ipcWaiting.has(m.id)) return;
  const w = ipcWaiting.get(m.id);
  ipcWaiting.delete(m.id);
  if (!ipcWaiting.size) process.off('message', onIpc);
  m.ok ? w.resolve(m) : w.reject(Object.assign(new Error(m.error || '模型调用失败'), { code: m.code }));
}
export const viaIpc = () => typeof process.send === 'function' && process.env.EVOLVE_IPC === '1';

export function makeLLM(budget, { worldId = null } = {}) {
  let last = base.stats.promptTokens + base.stats.completionTokens;
  const settle = () => {
    const now = base.stats.promptTokens + base.stats.completionTokens;
    if (now > last) budget.add(now - last);
    last = now;
  };
  const own = Boolean(REVIEW.url && REVIEW.key && REVIEW.model);
  return {
    // 通过 IPC 调用时由主进程判断模型是否可用；启动参数里的 EVOLVE_LLM=1 表示主进程配置了模型
    enabled: () => (viaIpc() ? process.env.EVOLVE_LLM === '1' : base.stats.enabled),
    /**
     * @param {string} role Agent 角色（用于统计）
     * @param {Array} messages
     * @param {{ review?: boolean, maxTokens?: number, temperature?: number }} opts review：评审类 Agent
     */
    async call(role, messages, { review = false, maxTokens = 4000, temperature = 0.4 } = {}) {
      if (budget.left() <= 0) throw new BudgetExceeded();
      if (viaIpc()) {
        const r = await ipcCall({ role, messages, review, maxTokens, temperature, worldId });
        budget.add(r.tokens);
        return r.json;
      }
      if (review && own) {
        const r = await reviewChat(messages, { maxTokens, temperature });
        budget.add(r.tokens);
        return r.json;
      }
      try {
        return await base.chatJSON(messages, { tier: 'smart', label: `进化：${role}`, agent: '进化引擎', maxTokens, temperature, attempts: 2, timeoutMs: 180_000, ...(review && REVIEW.model ? { model: REVIEW.model } : {}) });
      } finally { settle(); }
    },
  };
}
