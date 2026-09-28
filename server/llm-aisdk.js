// Vercel AI SDK 适配器（`ai` + `@ai-sdk/*`，可选依赖，第一次请求时才加载）：接入 OpenAI 兼容以外的服务商。
//
// 三种用法（kind）：
//   anthropic / google   单一服务商：模型名直接写 claude-sonnet-5、gemini-3-pro；BASE_URL 可选（官方地址或代理）
//   aisdk                只给服务器用：模型名写成「服务商/模型」，不同档位可以混用不同服务商
//                          MODEL=anthropic/claude-sonnet-5   密钥由 AI SDK 从 ANTHROPIC_API_KEY 等环境变量读取
//                          MODEL=glm-5.3 + BASE_URL + API_KEY  没有前缀的走 OpenAI 兼容网关
//
// strictKey（世界自带的模型服务一律开启）：必须显式给出密钥，绝不让 AI SDK 去读服务器的环境变量；
// 请求头里的密钥也要与给出的一致，否则拒绝发出（最后一道防线）。
// fetch：可以注入（自带模型时是 safeFetch，做连接时的地址校验）。
// 重试、限流、预算都由 llm.js 负责，所以关掉 AI SDK 自带的重试（maxRetries: 0）。

const CUSTOM = 'custom';
const PREFIXED = ['anthropic', 'google', 'openai'];
const DEFAULT_BASE = { anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta', openai: 'https://api.openai.com/v1' };
globalThis.AI_SDK_LOG_WARNINGS = false; // 兼容模式之类的提示不打到日志里

/** "anthropic/claude-sonnet-5" → { provider, id }；没有前缀（或前缀不认识）的走自定义网关 */
export function parseModelName(name) {
  const s = String(name || '');
  const i = s.indexOf('/');
  const p = i > 0 ? s.slice(0, i) : '';
  return PREFIXED.includes(p) ? { provider: p, id: s.slice(i + 1) } : { provider: CUSTOM, id: s };
}

/** OpenAI 风格的消息 → { system, messages }（system 合并到一起，其余原样；content 一律转成字符串） */
export function toPrompt(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role === 'system') system.push(text);
    else out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return { ...(system.length ? { system: system.join('\n\n') } : {}), messages: out };
}

async function defaultLoad() {
  try {
    const [ai, compat, anthropic, google, openai] = await Promise.all([
      import('ai'), import('@ai-sdk/openai-compatible'), import('@ai-sdk/anthropic'), import('@ai-sdk/google'), import('@ai-sdk/openai'),
    ]);
    return { ai, compat, anthropic, google, openai };
  } catch {
    throw new Error('这种模型服务需要先安装 AI SDK：在项目目录运行 npm install（它是可选依赖）');
  }
}

/** 把 AI SDK 的错误变成带上游状态码与原文的 Error：llm.js 据此识别限流、鉴权失败、余额不足、不支持 JSON 模式 */
function upstreamError(e) {
  const status = e?.statusCode;
  let msg = e?.message || String(e);
  try { const d = JSON.parse(e?.responseBody || ''); msg = d?.error?.message || d?.message || msg; } catch { /* 不是 JSON */ }
  const err = new Error(status ? `HTTP ${status}: ${msg}` : msg);
  if (status) err.status = status;
  return err;
}

/**
 * @param {object} o
 * @param {'anthropic'|'google'|'aisdk'} o.kind
 * @param {string} [o.baseUrl]
 * @param {string} [o.apiKey]
 * @param {string[]} [o.models] 配置的模型名（aisdk 用来判断是否需要自定义网关）
 * @param {boolean} [o.strictKey] 必须显式给出密钥（世界自带的模型服务）
 * @param {typeof fetch} [o.fetch]
 * @param {() => Promise<object>} [o.load] 测试用：注入已加载的模块
 */
export function aisdkProvider({ kind, baseUrl = '', apiKey = '', models = [], strictKey = false, fetch: f = null, load = defaultLoad } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const configured = models.filter(Boolean);
  const needsCustom = kind === 'aisdk' && configured.some((n) => parseModelName(n).provider === CUSTOM);
  const enabled = kind === 'aisdk'
    ? configured.length > 0 && (!needsCustom || Boolean(base && apiKey))
    : Boolean(apiKey) || (!strictKey && Boolean(process.env[kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GOOGLE_GENERATIVE_AI_API_KEY']));

  // 自带模型：请求头里的密钥必须是给出的那一把（防止 AI SDK 在任何情况下退回去读服务器的环境变量）
  const guarded = strictKey
    ? async (url, init = {}) => {
      const h = new Headers(init.headers);
      const sent = h.get('x-api-key') || h.get('x-goog-api-key') || (h.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!apiKey || sent !== apiKey) throw new Error('请求没有带上这份凭据的密钥，已拒绝发出');
      return (f || fetch)(url, init);
    }
    : f || undefined;

  let loading = null;
  const sdk = () => (loading ||= load().catch((e) => { loading = null; throw e; }));
  const factories = new Map();

  /** 服务商实例（按服务商缓存） */
  function providerFor(m, provider) {
    if (factories.has(provider)) return factories.get(provider);
    if (strictKey && !apiKey) throw new Error('这份凭据没有密钥');
    // 单一服务商：密钥与地址来自凭据 / 设置；aisdk 模式下带前缀的服务商由 AI SDK 从环境变量读密钥
    const own = kind !== 'aisdk';
    const opts = { ...(own && apiKey ? { apiKey } : {}), ...(own && base ? { baseURL: base } : {}), ...(guarded ? { fetch: guarded } : {}) };
    let p;
    if (provider === CUSTOM) p = m.compat.createOpenAICompatible({ name: CUSTOM, baseURL: base, apiKey, includeUsage: true, supportsStructuredOutputs: true, ...(guarded ? { fetch: guarded } : {}) });
    else if (provider === 'anthropic') p = m.anthropic.createAnthropic(opts);
    else if (provider === 'google') p = m.google.createGoogleGenerativeAI(opts);
    else p = m.openai.createOpenAI(opts);
    factories.set(provider, p);
    return p;
  }

  const route = (name) => (kind === 'aisdk' ? parseModelName(name) : { provider: kind, id: String(name || '') });

  async function listJSON(url, headers) {
    const res = await (guarded || fetch)(url, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  }

  return {
    name: kind,
    enabled,
    async listModels() {
      if (kind === 'anthropic') {
        const data = await listJSON(`${base || DEFAULT_BASE.anthropic}/models?limit=200`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
        return (data.data || []).map((m) => m.id);
      }
      if (kind === 'google') {
        const data = await listJSON(`${base || DEFAULT_BASE.google}/models?pageSize=200`, { 'x-goog-api-key': apiKey });
        return (data.models || []).map((m) => String(m.name || '').replace(/^models\//, ''));
      }
      // aisdk：只能列出自定义网关的模型；内置服务商不列（返回的列表里没有它们时，llm.js 不做自动纠正）
      if (!needsCustom) return [];
      const data = await listJSON(`${base}/models`, { Authorization: `Bearer ${apiKey}` });
      return [...(data.data || []).map((m) => m.id), ...configured.filter((n) => parseModelName(n).provider !== CUSTOM)];
    },
    async complete({ model: name, messages, temperature, maxTokens, json, schema, signal }) {
      const m = await sdk();
      const { provider, id } = route(name);
      const p = providerFor(m, provider);
      const model = provider === CUSTOM ? p.chatModel(id) : p(id);
      // JSON 模式只给 Chat Completions 风格的接口（与默认的 OpenAI 兼容实现一致）；其他服务商靠提示词约束，llm.js 负责修复
      const chatStyle = provider === CUSTOM;
      const output = json && chatStyle
        ? schema ? m.ai.Output.object({ schema: m.ai.jsonSchema(schema.schema), name: schema.name }) : m.ai.Output.json()
        : undefined;
      const req = {
        model, ...toPrompt(messages), temperature, maxOutputTokens: maxTokens, abortSignal: signal, maxRetries: 0,
        ...(output ? { output } : {}),
        // 自定义网关与默认实现保持一致：少思考、快回复（GLM 等默认会长时间思考）；json_schema 用非严格模式，兼容性更好
        ...(chatStyle ? { providerOptions: { [CUSTOM]: { reasoningEffort: 'low', strictJsonSchema: false } } } : {}),
      };
      try {
        const r = await m.ai.generateText(req);
        return { content: r.text ?? '', usage: { prompt: r.usage?.inputTokens || 0, completion: r.usage?.outputTokens || 0 }, finishReason: r.finishReason };
      } catch (e) {
        // 模型的输出不是合法 JSON：把原文交回 llm.js，由它修复或让模型重写
        if (m.ai.NoObjectGeneratedError?.isInstance?.(e) && typeof e.text === 'string') {
          return { content: e.text, usage: { prompt: e.usage?.inputTokens || 0, completion: e.usage?.outputTokens || 0 }, finishReason: e.finishReason };
        }
        throw upstreamError(e);
      }
    },
  };
}
