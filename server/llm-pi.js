// pi-ai 适配器（LLM_PROVIDER=pi）：通过 @earendil-works/pi-ai 接入 40 多家模型服务。
// pi-ai 是可选依赖：只在第一次请求时加载；没装时给出明确的报错，默认的零依赖路径不受影响。
//
// 模型名写法：
//   MODEL=anthropic/claude-sonnet-5        pi-ai 内置的服务商/模型，密钥由 pi-ai 从各自的环境变量读取（ANTHROPIC_API_KEY 等）
//   MODEL=glm-5.3 + BASE_URL + API_KEY     任意 OpenAI 兼容网关（经 pi-ai 的 openai-completions 实现）
// MODEL_FAST / MODEL_SMART 同理，可以混用不同服务商。
//
// 重试、限流、预算都由 llm.js 负责，所以关掉 pi-ai / SDK 自带的重试（maxRetries: 0）。

const PKG = '@earendil-works/pi-ai';
const CUSTOM = 'custom';
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** "anthropic/claude-sonnet-5" → { provider, id }；没有前缀的走自定义网关 */
export function parseModelName(name) {
  const s = String(name || '');
  const i = s.indexOf('/');
  return i > 0 ? { provider: s.slice(0, i), id: s.slice(i + 1) } : { provider: CUSTOM, id: s };
}

/** 把 OpenAI 风格的消息转成 pi-ai 的 Context（system 合并进 systemPrompt） */
export function toContext(messages, model) {
  const system = [];
  const out = [];
  const now = Date.now();
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role === 'system') system.push(text);
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: 'stop', timestamp: now });
    else out.push({ role: 'user', content: text, timestamp: now });
  }
  return { ...(system.length ? { systemPrompt: system.join('\n\n') } : {}), messages: out };
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ load?: () => Promise<{ pi: any, models: any, customApi?: any }> }} [inject] 测试用：注入已经建好的 pi-ai 模块与 Models
 */
export function piProvider(env = process.env, inject = {}) {
  const baseUrl = (env.BASE_URL || '').replace(/\/+$/, '');
  const apiKey = env.API_KEY || '';
  const configured = [env.MODEL, env.MODEL_FAST, env.MODEL_SMART].filter(Boolean);
  // 用到自定义网关时必须给出 BASE_URL 和 API_KEY；内置服务商的密钥由 pi-ai 自己解析
  const needsCustom = configured.some((n) => parseModelName(n).provider === CUSTOM);
  const enabled = configured.length > 0 && (!needsCustom || Boolean(baseUrl && apiKey));

  let loading = null;
  const load = () => (loading ||= (inject.load || defaultLoad)(baseUrl).catch((e) => { loading = null; throw e; }));

  function customModel(id) {
    return {
      id, name: id, api: 'openai-completions', provider: CUSTOM, baseUrl, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
      // 国内网关大多不认 developer 角色和 store 字段；max_tokens 兼容性最好
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
    };
  }

  function resolve(models, name) {
    const { provider, id } = parseModelName(name);
    if (provider === CUSTOM) return customModel(id);
    const m = models.getModel(provider, id);
    if (!m) throw new Error(`pi-ai 里没有模型 ${provider}/${id}`);
    return m;
  }

  return {
    name: 'pi',
    enabled,
    async listModels() {
      const { models } = await load();
      const ids = [];
      const prefixes = new Set(configured.map((n) => parseModelName(n).provider));
      for (const p of prefixes) {
        if (p !== CUSTOM) for (const m of models.getModels(p)) ids.push(`${p}/${m.id}`);
      }
      if (prefixes.has(CUSTOM) && baseUrl) {
        try {
          const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
          for (const m of (await res.json()).data || []) ids.push(m.id);
        } catch {}
      }
      return ids;
    },
    async complete({ model: name, messages, temperature, maxTokens, json, signal }) {
      const { models } = await load();
      const model = resolve(models, name);
      // 只有 Chat Completions 风格的接口认这些字段；其他服务商靠提示词约束 JSON
      const extra = {
        // 自定义网关与默认的 OpenAI 兼容实现保持一致：少思考、快回复（GLM 等默认会长时间思考）
        ...(model.provider === CUSTOM ? { reasoning_effort: 'low' } : {}),
        ...(json && model.api === 'openai-completions' ? { response_format: { type: 'json_object' } } : {}),
      };
      const opts = {
        signal, temperature, maxTokens, maxRetries: 0,
        ...(model.provider === CUSTOM ? { apiKey } : {}),
        ...(model.reasoning ? { reasoning: 'low' } : {}),
        ...(Object.keys(extra).length ? { samplingParams: extra } : {}),
      };
      const msg = await models.completeSimple(model, toContext(messages, model), opts);
      if (msg.stopReason === 'error' || msg.stopReason === 'aborted') throw new Error(msg.errorMessage || `pi-ai 请求失败（${msg.stopReason}）`);
      const content = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const u = msg.usage || ZERO_USAGE;
      return {
        content,
        usage: { prompt: (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), completion: u.output || 0 },
        finishReason: msg.stopReason,
      };
    },
  };
}

async function defaultLoad(baseUrl) {
  let pi;
  try {
    pi = await import(PKG);
  } catch {
    throw new Error(`LLM_PROVIDER=pi 需要先安装 ${PKG}：在项目目录运行 npm install（它是可选依赖）`);
  }
  const { builtinModels } = await import(`${PKG}/providers/all`);
  const models = builtinModels();
  if (baseUrl) {
    const { openAICompletionsApi } = await import(`${PKG}/api/openai-completions.lazy`);
    // 自定义网关：密钥随每次请求传入（见 complete），这里的鉴权只需声明「无需额外配置」
    models.setProvider(pi.createProvider({
      id: CUSTOM, name: 'OpenAI 兼容网关', baseUrl,
      auth: { apiKey: { name: 'API_KEY', resolve: async () => ({ auth: {} }) } },
      models: [], api: openAICompletionsApi(),
    }));
  }
  return { pi, models };
}
