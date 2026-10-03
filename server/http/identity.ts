// 身份（多世界设计 §5.1）：identify(req) → { user | null, admin, ip }。业务代码不再直接读请求头或 IP。
//   公网模式：会话 Cookie（HttpOnly; SameSite=Lax; 公网下 Secure）→ 账号；管理员 = 账号角色为 admin / super，或持有 ADMIN_TOKEN（应急入口，写审计）
//   本地模式：所有请求都视为内置的本地管理员账号（昵称取 LOCAL_NICKNAME）；设置了 ADMIN_TOKEN 时管理操作仍需令牌
import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config, clientIp } from '../guard.ts';
import { get as setting } from '../settings/index.ts';
import { isAdminUser } from '../accounts/authz.ts';
import { SESSION_TTL } from '../accounts/index.ts';
import { HttpError, nodeLike } from './util.ts';
import type { Accounts } from '../accounts/index.ts';
import type { User } from '../types/account.ts';
import type { Ctx, Middleware } from '../types/http.ts';

export const COOKIE = 'town_sid';

function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isHttps(c: Ctx): boolean {
  if (c.req.url.startsWith('https:')) return true;
  if (config.trustProxy && /^https$/i.test(String(c.req.header('x-forwarded-proto') || '').split(',')[0].trim())) return true;
  return false;
}

/** 公网模式下 Cookie 带 Secure（本机调试用的 http://localhost 例外） */
function secure(c: Ctx): boolean {
  if (isHttps(c)) return true;
  const host = String(c.req.header('host') || '').replace(/:\d+$/, '');
  return config.publicMode && !['localhost', '127.0.0.1', '[::1]'].includes(host);
}

export function setSessionCookie(c: Ctx, token: string): void {
  setCookie(c, COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: Math.floor(SESSION_TTL / 1000) });
}
export function clearSessionCookie(c: Ctx): void { deleteCookie(c, COOKIE, { path: '/', secure: secure(c) }); }
export const sessionToken = (c: Ctx): string | null => getCookie(c, COOKIE) || null;

/**
 * 身份中间件：设置 c.get('ip' | 'user' | 'admin' | 'who' | 'vid')。
 * 写请求还要校验 Origin（跨站请求伪造：写接口只接受 JSON + Origin 必须是本站）。
 */
export function identity({ accounts }: { accounts: Accounts | null }): Middleware {
  const lastTokenAudit = new Map<string, number>();
  return async (c, next) => {
    const ip = clientIp(nodeLike(c));
    c.set('ip', ip);
    const method = c.req.method;
    if (!['GET', 'HEAD'].includes(method)) checkOrigin(c);

    let user: User | null = null;
    if (!config.publicMode) {
      user = accounts ? accounts.localUser(setting('LOCAL_NICKNAME')) : { id: 'u_local', nickname: setting('LOCAL_NICKNAME'), role: 'super' } as User;
    } else if (accounts) {
      const tok = sessionToken(c);
      const s = tok ? accounts.session(tok) : null;
      if (s) { user = s.user; if (s.touched) setSessionCookie(c, tok!); }
    }
    const header = c.req.header('x-admin-token');
    const viaToken = Boolean(config.adminToken && header && safeEqual(header, config.adminToken));
    // 本地模式：配置了令牌时管理操作仍需令牌（与之前一致），否则所有人都是管理员
    const admin = config.publicMode ? isAdminUser(user) || viaToken : config.adminToken ? viaToken : true;
    if (viaToken && config.publicMode && accounts) {
      // 令牌是应急入口：每次写操作都写审计；读操作每 10 分钟最多记一次
      const k = `${ip}|${method === 'GET' ? 'r' : c.req.path}`;
      if (method !== 'GET' || Date.now() - (lastTokenAudit.get(k) || 0) > 600_000) {
        lastTokenAudit.set(k, Date.now());
        accounts.audit({ actor: user?.id || `token@${ip}`, action: 'admin.token', target: c.req.path, detail: { method } });
      }
    }
    c.set('user', user);
    c.set('admin', admin);
    c.set('who', { user, admin, ip });
    // 聊天记录、化身、投票都按账号；持令牌但没登录的管理员用一个固定的身份
    c.set('vid', user?.id || (admin ? 'admin' : null));
    await next();
  };
}

function checkOrigin(c: Ctx): void {
  const origin = c.req.header('origin');
  if (!origin) return; // 同源的 fetch 在部分浏览器里不带 Origin；跨站请求一定带
  let o;
  try { o = new URL(origin); } catch { throw new HttpError(403, '来源不被允许'); }
  const host = (config.trustProxy && String(c.req.header('x-forwarded-host') || '').split(',')[0].trim()) || c.req.header('host') || new URL(c.req.url).host;
  if (o.host !== host) throw new HttpError(403, '来源不被允许');
}
