// HTTP 层（Hono）的上下文类型：中间件放进 c 的变量、各接口共用的请求体类型。
import type { IncomingMessage } from 'node:http';
import type { Context, MiddlewareHandler } from 'hono';
import type { User, Who } from './account.ts';
import type { WorldHost } from '../worlds/host.ts';

/** JSON 请求体（readJson 保证是对象；字段由各接口逐项校验） */
export type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 中间件设置的变量：identity 设 ip / user / admin / who / vid，世界路由设 host，写接口设 body */
export interface AppVars {
  ip: string;
  user: User | null;
  admin: boolean;
  who: Who;
  /** 聊天记录、化身、投票按它区分：账号 id，持令牌但没登录的管理员是 'admin' */
  vid: string | null;
  host: WorldHost;
  body: Body;
  /** 前端构建号 */
  build: string;
}

export type AppEnv = { Variables: AppVars; Bindings: { incoming?: IncomingMessage } };
export type Ctx = Context<AppEnv>;
export type Middleware = MiddlewareHandler<AppEnv>;
