// HTTP 层的小工具：错误类型、JSON 请求体、限流、把 Hono 的请求转成 guard.js 认识的形状
import type { IncomingMessage } from 'node:http';
import type { HonoRequest } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Limiter, LimitResult } from '../guard.ts';
import type { Body, Ctx } from '../types/http.ts';

export class HttpError extends Error {
  declare status: ContentfulStatusCode;
  declare extra: { retryAfter?: number; [k: string]: unknown };
  constructor(status: number, message: string, extra: { retryAfter?: number; [k: string]: unknown } = {}) { super(message); this.status = status as ContentfulStatusCode; this.extra = extra; }
}

export const fmtWait = (s: number): string => (s >= 90 ? `${Math.ceil(s / 60)} 分钟` : `${s} 秒`);

export const take = (limiter: Limiter, key: string, what: string): LimitResult => {
  const r = limiter.check(key);
  if (!r.ok) throw new HttpError(429, `${what}太频繁了，请 ${fmtWait(r.retryAfter!)}后再试`, { retryAfter: r.retryAfter });
  return r;
};

export const MAX_BODY = 8192;

/**
 * 读取 JSON 请求体：只接受 application/json（跨站表单无法伪造，跨站 fetch 会触发预检而被拒绝），
 * 超过 limit 字节立即中止读取，只接受对象。
 */
export async function readJson(req: HonoRequest, limit = MAX_BODY): Promise<Body> {
  const type = String(req.header('content-type') || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, '需要 application/json');
  if (Number(req.header('content-length') || 0) > limit) throw new HttpError(413, '请求过大');
  let s = '';
  const body = req.raw.body;
  if (body) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      s += dec.decode(value, { stream: true });
      if (s.length > limit) { reader.cancel().catch(() => {}); throw new HttpError(413, '请求过大'); }
    }
    s += dec.decode();
  }
  let v: unknown;
  try { v = s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, '请求格式错误'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '请求格式错误');
  return v as Body;
}

/** guard.js 的函数按 Node 的 IncomingMessage 读取请求头与对端地址；这里给出同样形状的对象 */
export function nodeLike(c: Ctx): IncomingMessage {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
  return { headers, socket: c.env?.incoming?.socket || { remoteAddress: '127.0.0.1' } } as IncomingMessage;
}
