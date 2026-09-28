// 模型调用（重构方案 §8.2 B3）：provider 接口、消息、调用选项。实现见 llm-providers.ts / llm-aisdk.ts，队列与统计见 llm.ts。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 结构化输出用的 JSON Schema（只在开启结构化输出时传入；不支持的实现可以忽略） */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface CompleteArgs {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  schema?: JsonSchemaSpec | null;
  signal?: AbortSignal;
}

export interface CompleteResult {
  content: string;
  usage: { prompt: number; completion: number };
  finishReason?: string;
}

/** 失败时抛出的错误：message 带上游的原始错误信息，upstreamStatus 是上游的 HTTP 状态（不用 status，免得被 HTTP 层当成响应码） */
export type UpstreamError = Error & { upstreamStatus?: number };

export interface Provider {
  name: string;
  /** 是否已配置（未配置时小镇走规则兜底） */
  enabled: boolean;
  /** 用于模型名自动纠正 */
  listModels?(): Promise<string[]>;
  complete(args: CompleteArgs): Promise<CompleteResult>;
}

/** 环境变量形式的设置（createProvider、defaultSpec 等仍接受 env 对象） */
export type Env = Record<string, string | undefined>;
