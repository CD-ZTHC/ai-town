// 管理员接口（多世界设计 §11、§14）：设置中心、重启。账号上线前用现有的管理员身份（ADMIN_TOKEN / 本地模式）。
import { Hono } from 'hono';
import * as settings from '../settings/index.js';
import { GROUPS, SETTINGS } from '../settings/schema.js';
import { createProvider } from '../llm-providers.js';
import { HttpError } from './util.js';

/**
 * @param {object} deps
 * @param {() => void} deps.restart 存盘后以退出码 75 退出，由守护进程拉起
 * @param {(changes) => string[]} [deps.impactOf] 保存前提示影响范围
 * @param {(entry) => void} [deps.audit] 写审计
 * @param {() => boolean} [deps.supervised] 是否运行在守护进程下
 */
export function adminApi(deps) {
  const api = new Hono();
  const accounts = deps.accounts;
  deps = { audit: accounts ? (e) => accounts.audit(e) : null, ...deps };
  api.use('*', async (c, next) => {
    if (!c.get('admin')) throw new HttpError(403, '只有管理员可以这样做');
    await next();
  });
  const actor = (c) => c.get('user')?.id || 'admin';

  api.get('/settings', (c) => c.json({
    groups: GROUPS, items: settings.view(), pending: settings.pendingRestart(), rollback: settings.lastRollback(),
    supervised: deps.supervised?.() ?? false,
  }));

  api.put('/settings', (c) => {
    const b = c.get('body');
    const changes = b.changes && typeof b.changes === 'object' ? b.changes : {};
    if (b.dryRun) {
      // 只校验并估计影响，不保存
      const { changed } = settings.validateChanges(changes);
      return c.json({ ok: true, changed, impact: deps.impactOf?.(Object.fromEntries(changed.map((k) => [k, changes[k]]))) || [] });
    }
    const before = Object.fromEntries(Object.keys(changes).filter((k) => SETTINGS[k]).map((k) => [k, settings.get(k)]));
    const r = settings.save(changes, { by: actor(c), note: String(b.note || '').slice(0, 80) });
    if (r.changed.length) {
      // 审计只记录「密钥被修改」，不记录值
      const detail = Object.fromEntries(r.changed.map((k) => [k, SETTINGS[k].secret ? '（已修改）' : { from: before[k], to: settings.get(k) }]));
      deps.audit?.({ actor: actor(c), action: 'settings.save', target: `v${r.version}`, detail });
    }
    return c.json({ ok: true, ...r });
  });

  // 用填写的值真实调用一次模型（不保存）
  api.post('/settings/test-llm', async (c) => {
    const b = c.get('body');
    const pick = (k) => (typeof b[k] === 'string' && b[k] && !b[k].startsWith('●') ? b[k] : settings.get(k));
    const env = { ...settings.env(), BASE_URL: pick('BASE_URL'), API_KEY: pick('API_KEY') };
    const model = pick('MODEL');
    let provider;
    try { provider = createProvider(pick('LLM_PROVIDER'), env); } catch (e) { throw new HttpError(400, e.message); }
    if (!provider.enabled) throw new HttpError(400, '接口地址或密钥没有填写');
    const started = Date.now();
    try {
      const r = await provider.complete({ model, messages: [{ role: 'user', content: '只回复两个字：你好' }], temperature: 0, maxTokens: 400, json: false, signal: AbortSignal.timeout(30_000) });
      return c.json({ ok: true, ms: Date.now() - started, model, reply: String(r.content || '').slice(0, 60), tokens: r.usage.prompt + r.usage.completion });
    } catch (e) {
      return c.json({ ok: false, ms: Date.now() - started, model, error: String(e.message || e).slice(0, 300) });
    }
  });

  api.get('/settings/history', (c) => c.json(settings.history()));
  api.get('/settings/export', (c) => c.json(settings.exportValues()));
  api.post('/settings/restore', (c) => {
    const r = settings.restore(c.get('body').version, { by: actor(c) });
    deps.audit?.({ actor: actor(c), action: 'settings.restore', target: `v${r.version}`, detail: { from: c.get('body').version, changed: r.changed } });
    return c.json({ ok: true, ...r });
  });

  // ---------- 用户（多世界设计 §5.2、§14.9）----------
  const acc = () => { if (!accounts) throw new HttpError(503, '账号系统未启用'); return accounts; };
  const userOr404 = (id) => { const u = acc().get(id); if (!u) throw new HttpError(404, '账号不存在'); return u; };
  api.get('/users', (c) => c.json({ total: acc().count(), list: acc().list({ q: String(c.req.query('q') || '').slice(0, 40), offset: Number(c.req.query('offset') || 0) }) }));
  api.get('/users/:id', (c) => {
    const u = userOr404(c.req.param('id'));
    return c.json({ ...u, grants: accounts.grantsOf(u.id), sessions: accounts.sessionsOf(u.id), audit: accounts.auditLog({ actor: u.id, limit: 30 }) });
  });
  api.post('/users/:id/grants', (c) => {
    const b = c.get('body');
    const u = userOr404(c.req.param('id'));
    const quota = b.quota && typeof b.quota === 'object' ? b.quota : {};
    const expiresAt = b.expiresAt ? Date.parse(b.expiresAt) || Number(b.expiresAt) || null : null;
    return c.json({ ok: true, grant: accounts.setGrant(u.id, { cap: String(b.cap || ''), quota, expiresAt, note: String(b.note || '') }, actor(c)) });
  });
  api.delete('/users/:id/grants/:cap', (c) => c.json({ ok: acc().revokeGrant(c.req.param('id'), c.req.param('cap'), actor(c)) }));
  api.post('/users/:id/disable', (c) => { acc().setDisabled(c.req.param('id'), true, actor(c), String(c.get('body').reason || '')); return c.json({ ok: true }); });
  api.post('/users/:id/enable', (c) => { acc().setDisabled(c.req.param('id'), false, actor(c)); return c.json({ ok: true }); });
  api.post('/users/:id/reset-link', (c) => c.json({ ok: true, token: acc().createResetToken(userOr404(c.req.param('id')).id, actor(c)) }));
  api.post('/users/:id/role', (c) => {
    // 只有超级管理员能任免管理员
    if (c.get('user')?.role !== 'super' && c.get('user')) throw new HttpError(403, '只有超级管理员可以任免管理员');
    return c.json({ ok: true, user: acc().setRole(c.req.param('id'), String(c.get('body').role || ''), actor(c)) });
  });

  // ---------- 审计 ----------
  api.get('/audit', (c) => c.json(acc().auditLog({ actor: String(c.req.query('actor') || ''), action: String(c.req.query('action') || ''), before: c.req.query('before') ? Number(c.req.query('before')) : null })));

  api.post('/restart', (c) => {
    deps.audit?.({ actor: actor(c), action: 'server.restart', target: '', detail: { pending: settings.pendingRestart() } });
    setTimeout(() => deps.restart(), 200);
    return c.json({ ok: true, supervised: deps.supervised?.() ?? false });
  });

  return api;
}
