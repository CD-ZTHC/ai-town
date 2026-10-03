// 管理员接口（多世界设计 §11、§14）：设置中心、重启。账号上线前用现有的管理员身份（ADMIN_TOKEN / 本地模式）。
import { Hono } from 'hono';
import * as settings from '../settings/index.ts';
import { GROUPS, SETTINGS } from '../settings/schema.ts';
import { createProvider } from '../llm-providers.ts';
import { HttpError } from './util.ts';
import type { AppEnv, Ctx } from '../types/http.ts';
import type { Accounts } from '../accounts/index.ts';
import type { AuditEntry } from '../types/account.ts';
import type { World } from '../types/world.ts';
import type { WorldRegistry } from '../worlds/registry.ts';
import type { WorldManager } from '../worlds/manager.ts';
import type { SettingKey } from '../settings/index.ts';

/** SQLite 的行（reports 表） */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 管理员接口的依赖（server/index.ts 传入） */
export interface AdminDeps {
  /** 存盘后以退出码 75 退出，由守护进程拉起 */
  restart?: () => void;
  /** 是否运行在守护进程下 */
  supervised?: () => boolean;
  /** 保存前提示影响范围 */
  impactOf?: (changes: Record<string, unknown>) => string[];
  audit?: ((e: AuditEntry) => void) | null;
  accounts?: Accounts | null;
  manager?: WorldManager;
  registry?: WorldRegistry;
  llmView?: () => object;
  engineStatus?: () => object | null;
  memory?: () => object;
  siteCredentials?: Hono<AppEnv>;
  aiSummary?: (w: World) => object | null;
  [k: string]: unknown;
}

export function adminApi(deps: AdminDeps): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  const accounts = deps.accounts;
  deps = { audit: accounts ? (e: AuditEntry) => accounts.audit(e) : null, ...deps };
  api.use('*', async (c, next) => {
    if (!c.get('admin')) throw new HttpError(403, '只有管理员可以这样做');
    await next();
  });
  const actor = (c: Ctx) => c.get('user')?.id || 'admin';

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
    const before = Object.fromEntries(Object.keys(changes).filter((k) => SETTINGS[k as SettingKey]).map((k) => [k, settings.get(k)]));
    const r = settings.save(changes, { by: actor(c), note: String(b.note || '').slice(0, 80) });
    if (r.changed.length) {
      // 审计只记录「密钥被修改」，不记录值
      const detail = Object.fromEntries(r.changed.map((k) => [k, (SETTINGS[k as SettingKey] as { secret?: boolean }).secret ? '（已修改）' : { from: before[k], to: settings.get(k) }]));
      deps.audit?.({ actor: actor(c), action: 'settings.save', target: `v${r.version}`, detail });
    }
    return c.json({ ok: true, ...r });
  });

  // 用填写的值真实调用一次模型（不保存）
  api.post('/settings/test-llm', async (c) => {
    const b = c.get('body');
    const pick = (k: string): string => (typeof b[k] === 'string' && b[k] && !b[k].startsWith('●') ? b[k] : settings.get(k) as string);
    const env = { ...settings.env(), BASE_URL: pick('BASE_URL'), API_KEY: pick('API_KEY') };
    const model = pick('MODEL');
    let provider;
    try { provider = createProvider(pick('LLM_PROVIDER'), env); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (!provider.enabled) throw new HttpError(400, '接口地址或密钥没有填写');
    const started = Date.now();
    try {
      const r = await provider.complete({ model, messages: [{ role: 'user', content: '只回复两个字：你好' }], temperature: 0, maxTokens: 400, json: false, signal: AbortSignal.timeout(30_000) });
      return c.json({ ok: true, ms: Date.now() - started, model, reply: String(r.content || '').slice(0, 60), tokens: r.usage.prompt + r.usage.completion });
    } catch (e) {
      return c.json({ ok: false, ms: Date.now() - started, model, error: String((e as Error).message || e).slice(0, 300) });
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
  const userOr404 = (id: string) => { const u = acc().get(id); if (!u) throw new HttpError(404, '账号不存在'); return u; };
  api.get('/users', (c) => c.json({ total: acc().count(), list: acc().list({ q: String(c.req.query('q') || '').slice(0, 40), offset: Number(c.req.query('offset') || 0) }) }));
  api.get('/users/:id', (c) => {
    const u = userOr404(c.req.param('id'));
    return c.json({ ...u, grants: accounts!.grantsOf(u.id), sessions: accounts!.sessionsOf(u.id), audit: accounts!.auditLog({ actor: u.id, limit: 30 }) });
  });
  api.post('/users/:id/grants', (c) => {
    const b = c.get('body');
    const u = userOr404(c.req.param('id'));
    const quota = b.quota && typeof b.quota === 'object' ? b.quota : {};
    const expiresAt = b.expiresAt ? Date.parse(b.expiresAt) || Number(b.expiresAt) || null : null;
    return c.json({ ok: true, grant: accounts!.setGrant(u.id, { cap: String(b.cap || ''), quota, expiresAt, note: String(b.note || '') }, actor(c)) });
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

  // ---------- 世界（多世界设计 §14.9）----------
  const reg = () => { if (!deps.registry) throw new HttpError(503, '世界管理未启用'); return deps.registry; };
  api.get('/worlds', (c) => {
    const status = c.req.query('status') || null;
    const running = new Map((deps.manager?.view() || []).map((w) => [w.id, w]));
    const list = reg().list({ status }).map((w) => {
      const grant = w.ownerId && accounts ? accounts.grant(w.ownerId, 'genesis') : null;
      const limitMB = w.official ? null : w.quota?.diskMB ?? grant?.quota?.diskMB ?? settings.get('WORLD_DISK_MB');
      return { ...w, owner: w.ownerId ? accounts?.get(w.ownerId)?.nickname || w.ownerId : null, runtime: running.get(w.id) || null, diskLimitMB: limitMB, ai: deps.aiSummary?.(w) || null };
    }).sort((a, b) => b.diskBytes - a.diskBytes);
    return c.json({ list, running: running.size, max: settings.get('MAX_ACTIVE_WORLDS') });
  });
  api.post('/worlds/:id/quota', (c) => {
    const b = c.get('body');
    const q: Record<string, number | undefined> = {};
    for (const k of ['dailyWorldTokens', 'diskMB']) if (b[k] !== undefined) q[k] = b[k] === null || b[k] === '' ? undefined : Math.max(0, Number(b[k]) || 0);
    const w = reg().update(c.req.param('id'), { quota: q });
    deps.manager?.checkDisk(w.id, { force: true });
    deps.audit?.({ actor: actor(c), action: 'world.quota', target: w.id, detail: q });
    return c.json({ ok: true, world: w });
  });
  // 下架：立即停止运行、从大厅消失、在线观众看到下架提示；owner 能看到原因，但不能自行恢复（§10.2）
  api.post('/worlds/:id/suspend', (c) => {
    const reason = String(c.get('body').reason || '').trim().slice(0, 200);
    if (!reason) throw new HttpError(400, '请写下架原因（owner 会看到）');
    const w = reg().get(c.req.param('id'));
    if (!w) throw new HttpError(404, '世界不存在');
    if (w.official) throw new HttpError(409, '官方世界不能下架');
    reg().setStatus(w.id, 'suspended', `已被管理员下架：${reason}`);
    deps.manager?.close(w.id, `已被管理员下架：${reason}`);
    deps.audit?.({ actor: actor(c), action: 'world.suspend', target: w.id, detail: { reason } });
    return c.json({ ok: true });
  });
  api.post('/worlds/:id/restore', (c) => {
    const w = reg().get(c.req.param('id'));
    if (!w) throw new HttpError(404, '世界不存在');
    reg().setStatus(w.id, 'public', '');
    // 恢复时把这个世界未处理的举报一并标记为已处理
    reg().db.prepare("UPDATE reports SET handled_at = ?, handled_by = ?, resolution = 'restored' WHERE world_id = ? AND handled_at IS NULL").run(Date.now(), actor(c), w.id);
    deps.audit?.({ actor: actor(c), action: 'world.restore', target: w.id });
    return c.json({ ok: true });
  });

  // 官方世界的发布状态（按世界配置模型服务设计 §9.1）：在公开 / 不公开（有链接才能看）/ 暂停之间切换。
  // 例如 dark 分级的官方世界第一次登记是不公开的，由管理员决定是否公开
  api.post('/worlds/:id/status', (c) => {
    const w = reg().get(c.req.param('id'));
    if (!w) throw new HttpError(404, '世界不存在');
    if (!w.official) throw new HttpError(409, '用户世界的状态由创建者管理（下架与恢复用专门的操作）');
    const to = String(c.get('body').status || '');
    if (!['public', 'unlisted', 'paused'].includes(to)) throw new HttpError(400, '只能切换到公开、不公开或暂停');
    // 状态机里 unlisted 不能直接到 paused、paused 不能直接到 unlisted：经过 public 中转
    if (w.status !== to && !['public', to].includes(w.status)) reg().setStatus(w.id, 'public', '');
    reg().setStatus(w.id, to, to === 'paused' ? '管理员暂停了这个世界' : '');
    deps.audit?.({ actor: actor(c), action: 'world.status', target: w.id, detail: { from: w.status, to } });
    return c.json({ ok: true, world: reg().get(w.id) });
  });

  // ---------- 举报 ----------
  api.get('/reports', (c) => {
    const open = c.req.query('all') ? '' : 'AND handled_at IS NULL';
    const rows = reg().db.prepare(`SELECT * FROM reports WHERE 1=1 ${open} ORDER BY id DESC LIMIT 200`).all();
    return c.json(rows.map((r: Row) => ({ ...r, reporterName: accounts?.get(r.reporter)?.nickname || r.reporter, worldTitle: reg().get(r.world_id)?.title || r.world_id, worldStatus: reg().get(r.world_id)?.status || null })));
  });
  api.post('/reports/:id/handle', (c) => {
    const resolution = String(c.get('body').resolution || 'dismissed').slice(0, 40);
    const n = reg().db.prepare('UPDATE reports SET handled_at = ?, handled_by = ?, resolution = ? WHERE id = ? AND handled_at IS NULL').run(Date.now(), actor(c), resolution, Number(c.req.param('id'))).changes;
    deps.audit?.({ actor: actor(c), action: 'report.handle', target: String(c.req.param('id')), detail: { resolution } });
    return c.json({ ok: Boolean(n) });
  });

  // ---------- 进化（§9）：引擎状态与全部任务；运行中的世界各自的 AI 插件 ----------
  api.get('/evolution', (c) => {
    const worlds = [...(deps.manager?.loaded.values() || [])].map((h) => ({
      id: h.id, title: deps.registry?.get(h.id)?.title || h.id,
      plugins: h.town.evolved.view(true).plugins,
      pending: h.town.decisions.list.filter((d: { kind: string; status: string }) => d.kind === 'plugin' && d.status === 'waiting').length,
    }));
    return c.json({ engine: deps.engineStatus?.() || null, worlds });
  });

  // ---------- 概览 ----------
  api.get('/overview', (c) => {
    const view = deps.manager?.view() || [];
    const openReports = deps.registry ? (reg().db.prepare('SELECT COUNT(*) AS n FROM reports WHERE handled_at IS NULL').get() as { n: number }).n : 0;
    const alerts = accounts ? accounts.auditLog({ limit: 200 }).filter((a) => /^(world\.(unlisted|suspend|sample-hit|publish-rejected)|settings\.rollback|disk\.full|genesis\.failed|admin\.token|memory\.high)/.test(a.action)).slice(0, 12) : [];
    const rb = settings.lastRollback();
    return c.json({
      online: view.reduce((s, w) => s + w.viewers, 0), running: view, max: settings.get('MAX_ACTIVE_WORLDS'),
      worlds: deps.registry ? Object.fromEntries(['public', 'preview', 'unlisted', 'suspended', 'paused'].map((st) => [st, reg().list({ status: st }).length])) : {},
      users: accounts?.count() ?? 0, openReports, llm: deps.llmView?.() || null, memory: deps.memory?.() || null,
      alerts: [...(rb ? [{ at: Date.parse(rb.at), action: 'settings.rollback', target: `v${rb.from} → v${rb.to}`, detail: { reason: rb.reason } }] : []), ...alerts],
    });
  });

  api.post('/worlds/:id/unload', (c) => c.json({ ok: Boolean(deps.manager?.close(c.req.param('id'), '管理员卸载')) }));

  // ---------- 站点凭据（按世界配置模型服务设计 §9.3）：只给官方世界用 ----------
  if (deps.siteCredentials) api.route('/llm-credentials', deps.siteCredentials);

  // ---------- 调度（§7.6）----------
  api.get('/llm', (c) => c.json(deps.llmView ? deps.llmView() : {}));
  api.post('/worlds/:id/ai', (c) => {
    const paused = Boolean(c.get('body').paused);
    const w = reg().update(c.req.param('id'), { settings: { aiPaused: paused } });
    deps.audit?.({ actor: actor(c), action: paused ? 'world.ai-pause' : 'world.ai-resume', target: w.id });
    return c.json({ ok: true });
  });

  // ---------- 审计 ----------
  api.get('/audit', (c) => c.json(acc().auditLog({ actor: String(c.req.query('actor') || ''), action: String(c.req.query('action') || ''), before: c.req.query('before') ? Number(c.req.query('before')) : null })));

  api.post('/restart', (c) => {
    deps.audit?.({ actor: actor(c), action: 'server.restart', target: '', detail: { pending: settings.pendingRestart() } });
    setTimeout(() => deps.restart!(), 200);
    return c.json({ ok: true, supervised: deps.supervised?.() ?? false });
  });

  return api;
}
