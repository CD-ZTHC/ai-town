// 模型服务（provider）：llm.js 负责队列、限流、重试、预算与统计，真正发请求的是 provider。
// 默认只有 OpenAI 兼容接口（零依赖）；接入其他 SDK（例如 pi-ai）时实现同样的接口，
// 用 registerProvider 注册，再通过 LLM_PROVIDER=名字 选用。
//
// provider 接口：
//   name        名字
//   enabled     是否已配置（未配置时小镇走规则兜底）
//   listModels  可选：() => Promise<string[]>，用于模型名自动纠正
//   complete    ({ model, messages, temperature, maxTokens, json, signal }) =>
//                 Promise<{ content: string, usage: { prompt: number, completion: number }, finishReason?: string }>
//   失败时抛出 Error，message 带上上游的原始错误信息：llm.js 据此识别限流、鉴权失败、不支持 JSON 模式。
import { piProvider } from './llm-pi.js';

export function openaiCompatible({ baseUrl = '', apiKey = '' } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  return {
    name: 'openai',
    enabled: Boolean(base && apiKey),
    async listModels() {
      const res = await fetch(`${base}/models`, { headers });
      const data = await res.json();
      return (data.data || []).map((m) => m.id);
    },
    async complete({ model, messages, temperature, maxTokens, json, signal }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          reasoning_effort: 'low',
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 },
        finishReason: data.choices?.[0]?.finish_reason,
      };
    },
  };
}

const factories = {
  openai: (env) => openaiCompatible({ baseUrl: env.BASE_URL || '', apiKey: env.API_KEY || '' }),
  // pi-ai（可选依赖，第一次请求时才加载）
  pi: (env) => piProvider(env),
};

/** 注册一个 provider 工厂：factory(env) => provider */
export function registerProvider(name, factory) {
  if (Object.hasOwn(factories, name)) throw new Error(`provider 已存在：${name}`);
  factories[name] = factory;
}

export function createProvider(name = 'openai', env = process.env) {
  if (!Object.hasOwn(factories, name)) throw new Error(`未知的 LLM_PROVIDER：${name}（可用：${Object.keys(factories).join('、')}）`);
  return factories[name](env);
}
