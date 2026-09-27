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

  api.post('/restart', (c) => {
    deps.audit?.({ actor: actor(c), action: 'server.restart', target: '', detail: { pending: settings.pendingRestart() } });
    setTimeout(() => deps.restart(), 200);
    return c.json({ ok: true, supervised: deps.supervised?.() ?? false });
  });

  return api;
}
