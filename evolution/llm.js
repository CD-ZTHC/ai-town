// 进化引擎的模型调用：实施类 Agent 用 MODEL_SMART；评审类 Agent 可以单独配置另一个模型（甚至另一家服务），
// 避免「同一个模型写、同一个模型审」的共同盲区。所有调用计入进化预算（EVOLVE_BUDGET，0 为不限）。
import * as base from '../server/llm.js';
import { BudgetExceeded } from './common.js';

const REVIEW = {
  url: (process.env.EVOLVE_REVIEW_BASE_URL || '').replace(/\/+$/, ''),
  key: process.env.EVOLVE_REVIEW_API_KEY || '',
  model: process.env.EVOLVE_REVIEW_MODEL || '',
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

export function makeLLM(budget) {
  let last = base.stats.promptTokens + base.stats.completionTokens;
  const settle = () => {
    const now = base.stats.promptTokens + base.stats.completionTokens;
    if (now > last) budget.add(now - last);
    last = now;
  };
  const own = Boolean(REVIEW.url && REVIEW.key && REVIEW.model);
  return {
    enabled: () => base.stats.enabled,
    /**
     * @param {string} role Agent 角色（用于统计）
     * @param {Array} messages
     * @param {{ review?: boolean, maxTokens?: number, temperature?: number }} opts review：评审类 Agent
     */
    async call(role, messages, { review = false, maxTokens = 4000, temperature = 0.4 } = {}) {
      if (budget.left() <= 0) throw new BudgetExceeded();
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
