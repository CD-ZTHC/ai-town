// 调用归属（多世界设计 §7.3）：世界管理器调用某个世界的 tick、HTTP 中间件处理某个世界的请求时设置 { worldId, userId }，
// llm.chat 自动读取。调用链上的函数签名都不用改。
import { AsyncLocalStorage } from 'node:async_hooks';

export const llmContext = new AsyncLocalStorage();

/** 在 ctx 里运行 fn（ctx 与外层合并） */
export function withContext(ctx, fn) {
  return llmContext.run({ ...(llmContext.getStore() || {}), ...ctx }, fn);
}

export const currentContext = () => llmContext.getStore() || {};
