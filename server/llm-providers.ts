// 模型服务（provider）：llm.js 负责队列、限流、重试、预算与统计，真正发请求的是 provider。
// 默认是 OpenAI 兼容接口（零依赖）；anthropic / google / aisdk 经 Vercel AI SDK 接入（llm-aisdk.js，可选依赖）。
// 接入其他 SDK 时实现同样的接口，用 registerProvider 注册，再通过 LLM_PROVIDER=名字 选用。
//
// provider 接口：
//   name        名字
//   enabled     是否已配置（未配置时小镇走规则兜底）
//   listModels  可选：() => Promise<string[]>，用于模型名自动纠正
//   complete    ({ model, messages, temperature, maxTokens, json, schema?, signal }) =>
//                 Promise<{ content: string, usage: { prompt: number, completion: number }, finishReason?: string }>
//               schema：{ name, schema }（JSON Schema），只在开启结构化输出时传入；不支持的实现可以忽略
//   失败时抛出 Error，message 带上上游的原始错误信息：llm.js 据此识别限流、鉴权失败、不支持 JSON 模式。
import { aisdkProvider } from './llm-aisdk.ts';

export function openaiCompatible({ baseUrl = '', apiKey = '', fetch: f = null } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const fetch = f || globalThis.fetch; // 世界自带的模型服务注入 safeFetch（连接时校验地址）
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  return {
    name: 'openai',
    enabled: Boolean(base && apiKey),
    async listModels() {
      const res = await fetch(`${base}/models`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${res.status}`), { upstreamStatus: res.status });
      return (data.data || []).map((m) => m.id);
    },
    async complete({ model, messages, temperature, maxTokens, json, schema, signal }) {
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
          ...(json ? { response_format: responseFormat(schema) } : {}),
        }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), { upstreamStatus: res.status });
      }
      // upstreamStatus：llm.js 据此区分鉴权失败、余额不足、模型不存在（不用 status，免得被 HTTP 层当成响应码）
      if (!res.ok || data.error) throw Object.assign(new Error(data.error?.message || `HTTP ${res.status}`), { upstreamStatus: res.ok ? 0 : res.status });
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 },
        finishReason: data.choices?.[0]?.finish_reason,
      };
    },
  };
}

/** Chat Completions 的 response_format：有 schema 时用 json_schema（非严格模式，兼容性更好） */
export function responseFormat(schema) {
  return schema ? { type: 'json_schema', json_schema: { name: schema.name, schema: schema.schema, strict: false } } : { type: 'json_object' };
}

const tiers = (env) => [env.MODEL, env.MODEL_FAST, env.MODEL_SMART];
let piWarned = false;
const factories = {
  openai: (env) => openaiCompatible({ baseUrl: env.BASE_URL || '', apiKey: env.API_KEY || '' }),
  // 经 AI SDK（可选依赖，第一次请求时才加载）
  anthropic: (env) => aisdkProvider({ kind: 'anthropic', baseUrl: env.BASE_URL, apiKey: env.API_KEY }),
  google: (env) => aisdkProvider({ kind: 'google', baseUrl: env.BASE_URL, apiKey: env.API_KEY }),
  aisdk: (env) => aisdkProvider({ kind: 'aisdk', baseUrl: env.BASE_URL, apiKey: env.API_KEY, models: tiers(env) }),
  // 旧名字：pi-ai 已经换成 AI SDK，「服务商/模型」的写法不变
  pi: (env) => {
    if (!piWarned) { piWarned = true; console.warn('[llm] LLM_PROVIDER=pi 已弃用，按 aisdk 处理（写法不变）；请改成 LLM_PROVIDER=aisdk'); }
    return factories.aisdk(env);
  },
};

/** 世界自带的模型服务可以选的类型（aisdk 从服务器的环境变量读密钥，只给服务器用） */
export const CREDENTIAL_PROVIDERS = ['openai', 'anthropic', 'google'];

/**
 * 按一份凭据建 provider：密钥必须显式给出（绝不读服务器的环境变量），请求经过注入的 fetch（safeFetch）
 * @param {{ provider: string, baseUrl?: string, apiKey: string, fetch?: typeof fetch }} c
 */
export function credentialProvider({ provider, baseUrl = '', apiKey, fetch: f = null }) {
  if (!CREDENTIAL_PROVIDERS.includes(provider)) throw new Error(`不支持的服务类型：${provider}`);
  if (!apiKey) throw new Error('这份凭据没有密钥');
  if (provider === 'openai') return openaiCompatible({ baseUrl, apiKey, fetch: f });
  return aisdkProvider({ kind: provider, baseUrl, apiKey, strictKey: true, fetch: f });
}

/** 注册一个 provider 工厂：factory(env) => provider */
export function registerProvider(name, factory) {
  if (Object.hasOwn(factories, name)) throw new Error(`provider 已存在：${name}`);
  factories[name] = factory;
}

export function createProvider(name = 'openai', env = process.env) {
  if (!Object.hasOwn(factories, name)) throw new Error(`未知的 LLM_PROVIDER：${name}（可用：${Object.keys(factories).join('、')}）`);
  return factories[name](env);
}
