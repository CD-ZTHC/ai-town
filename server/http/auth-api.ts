// 账号接口（多世界设计 §5.4、§11）：注册、登录、登出、改昵称、改密码、重置密码、管理员认领
import { Hono } from 'hono';
import { config, moderateNickname } from '../guard.ts';
import { get as setting } from '../settings/index.ts';
import { quota } from '../accounts/quota.ts';
import { HttpError } from './util.ts';
import { setSessionCookie, clearSessionCookie, sessionToken, setAdminCookie, clearAdminCookie, isAdminToken } from './identity.ts';
import type { AppEnv, Ctx } from '../types/http.ts';
import type { Accounts } from '../accounts/index.ts';

const str = (v: unknown, max: number): string => String(v ?? '').slice(0, max);

/** 人机验证（Cloudflare Turnstile）：没有配置 CAPTCHA_SECRET 时不启用 */
async function verifyCaptcha(token: unknown, ip: string): Promise<boolean> {
  const secret = setting('CAPTCHA_SECRET');
  if (!secret) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret, response: str(token, 2048), remoteip: ip }), signal: AbortSignal.timeout(10_000),
    });
    return Boolean((await res.json()).success);
  } catch { return false; }
}

export function authApi({ accounts }: { accounts: Accounts | null }): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  const need = (c: Ctx) => { if (!accounts) throw new HttpError(503, '账号系统未启用'); return accounts; };
  const me = (c: Ctx) => { const u = c.get('user'); if (!u || u.id === 'u_local') throw new HttpError(401, '请先登录', { login: true }); return u; };
  const who = (c: Ctx) => c.get('who');

  api.get('/captcha', (c) => c.json({ enabled: Boolean(setting('CAPTCHA_SECRET')), siteKey: setting('CAPTCHA_SITEKEY') || null }));

  api.get('/nickname-available', (c) => {
    const p = need(c).checkNickname(str(c.req.query('nickname'), 40), c.get('user')?.id);
    return c.json({ ok: !p, reason: p || null });
  });

  api.post('/register', async (c) => {
    const acc = need(c);
    if (!config.publicMode) throw new HttpError(409, '本地模式不需要注册');
    if (!setting('REGISTER_OPEN')) throw new HttpError(403, '暂时不开放注册');
    const b = c.get('body');
    const q = quota(who(c), 'register');
    if (!q.ok) throw new HttpError(429, q.message!, { retryAfter: q.retryAfter });
    if (!(await verifyCaptcha(b.captcha, c.get('ip')))) throw new HttpError(400, '人机验证没有通过', { field: 'captcha' });
    const nickname = str(b.nickname, 40);
    // 昵称先过关键词与格式检查（register 内部），再过审核模型
    const pre = acc.checkNickname(nickname);
    if (pre) throw new HttpError(409, pre, { field: 'nickname' });
    const m = await moderateNickname(nickname);
    if (!m.ok) throw new HttpError(422, `昵称：${m.reason}`, { field: 'nickname' });
    const user = await acc.register({ username: str(b.username, 40), nickname, password: str(b.password, 300) });
    setSessionCookie(c, acc.createSession(user.id, { ip: c.get('ip'), ua: c.req.header('user-agent') }));
    return c.json({ ok: true, user });
  });

  api.post('/login', async (c) => {
    const acc = need(c);
    if (!config.publicMode) throw new HttpError(409, '本地模式不需要登录');
    const b = c.get('body');
    const r = await acc.login({ username: str(b.username, 40), password: str(b.password, 300), ip: c.get('ip'), ua: c.req.header('user-agent') });
    setSessionCookie(c, r.token);
    return c.json({ ok: true, user: r.user });
  });

  api.post('/logout', (c) => {
    const tok = sessionToken(c);
    const n = tok && accounts ? accounts.logout(tok, { all: Boolean(c.get('body').all) }) : 0;
    clearSessionCookie(c);
    clearAdminCookie(c);
    return c.json({ ok: true, sessions: n });
  });

  api.post('/nickname', async (c) => {
    const u = me(c);
    const nickname = str(c.get('body').nickname, 40);
    const pre = need(c).checkNickname(nickname, u.id);
    if (pre) throw new HttpError(409, pre);
    const m = await moderateNickname(nickname);
    if (!m.ok) throw new HttpError(422, `昵称：${m.reason}`);
    return c.json({ ok: true, user: accounts!.rename(u.id, nickname) });
  });

  api.post('/password', async (c) => {
    const u = me(c);
    const b = c.get('body');
    await need(c).changePassword(u.id, str(b.old, 300), str(b.password, 300), { keepToken: sessionToken(c) });
    return c.json({ ok: true });
  });

  // 用管理员生成的一次性链接重置密码
  api.post('/reset', async (c) => {
    const b = c.get('body');
    const user = await need(c).resetPassword(str(b.token, 100), str(b.password, 300));
    setSessionCookie(c, accounts!.createSession(user.id, { ip: c.get('ip'), ua: c.req.header('user-agent') }));
    return c.json({ ok: true, user });
  });

  // 管理员认领：还没有超级管理员时，ADMIN_TOKEN 的持有者可以把自己的账号升为超级管理员
  api.post('/claim-admin', (c) => {
    const u = me(c);
    if (!isAdminToken(str(c.get('body').token, 300))) throw new HttpError(403, '管理员令牌不对');
    return c.json({ ok: true, user: need(c).claimSuper(u.id) });
  });

  // 用 ADMIN_TOKEN 进入管理面板（应急入口）：换成 HttpOnly 的管理员 Cookie，之后打开管理面板不用再带请求头
  api.post('/admin-token', (c) => {
    if (!isAdminToken(str(c.get('body').token, 300))) {
      accounts?.audit({ actor: `token@${c.get('ip')}`, action: 'admin.token-failed', target: '/admin/' });
      throw new HttpError(403, '管理员令牌不对');
    }
    setAdminCookie(c);
    accounts?.audit({ actor: c.get('user')?.id || `token@${c.get('ip')}`, action: 'admin.token', target: '/admin/', detail: { method: 'cookie' } });
    return c.json({ ok: true });
  });
  api.delete('/admin-token', (c) => { clearAdminCookie(c); return c.json({ ok: true }); });

  api.get('/sessions', (c) => c.json(need(c).sessionsOf(me(c).id)));

  return api;
}
