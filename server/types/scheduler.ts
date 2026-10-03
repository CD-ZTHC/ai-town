// 统一 AI 调度（重构方案 §8.1；多世界设计 §7）：server/scheduler/ 的任务、级别与调用上下文。

/** P0 交互、P1 心跳、P2 叙事、P3 创世、P4 进化 */
export type LlmClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** 调用归属（scheduler/context.js）：世界主循环、HTTP 请求处理时设置，llm.chat 自动读取 */
export interface CallContext {
  worldId?: string | null;
  userId?: string | null;
  [k: string]: unknown;
}

/** 调度队列里的一个任务（scheduler/index.js 的 Scheduler.push） */
export interface Job {
  cls: LlmClass;
  /** 没有归属的任务记为 '-' */
  worldId: string;
  /** 调用点声明的用途（classes.js 的 TABLE：「对话」「规划一天」……） */
  label?: string;
  /** 插队到本世界该级别的最前面 */
  front?: boolean;
  /** 入队时间（毫秒），push 时写入 */
  at?: number;
  run(): void | Promise<unknown>;
  reject(err: Error): void;
}

/** 出队前的额度检查：true 放行；字符串是拒绝理由 */
export type AllowFn = (job: Job) => true | string;
