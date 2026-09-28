// 世界大厅与世界管理接口（多世界设计 §11「世界」）：/api/worlds/*
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { HttpError } from './util.js';
import { authorize } from '../accounts/authz.js';
import { loadPack, writePack } from '../worlds/pack.js';
import { checkPack } from '../genesis/pipeline.js';
import { keywordCheck, sanitize } from '../guard.js';
import { publishReview } from '../worlds/review.js';
import { quota } from '../accounts/quota.js';
import { get as setting } from '../settings/index.js';
import { reviewRating } from '../kernel/ratings.js';
import { STORYTELLERS } from '../kernel/spec.js';
import { DEATH_NAMED_DEFAULT } from './genesis-api.js';

const clip = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const EDITABLE = new Set(['drafting', 'preview']);

/**
 * @param {object} deps
 * @param {import('../worlds/registry.js').WorldRegistry} deps.registry
 * @param {import('../worlds/manager.js').WorldManager} deps.manager
 * @param {import('../accounts/index.js').Accounts} [deps.accounts]
 */
export function worldsApi(deps) {
  const api = new Hono();
  deps = { audit: deps.accounts ? (e) => deps.accounts.audit(e) : null, ...deps };
  const { registry, manager, accounts } = deps;
  const card = (w) => {
    const h = manager.get(w.id);
    return {
      id: w.id, title: w.title, summary: w.summary, sourceTitle: w.sourceTitle, rating: w.rating, official: w.official, status: w.status,
      owner: w.ownerId ? accounts?.get(w.ownerId)?.nickname || null : null, viewers: h ? h.clients.size : 0, running: Boolean(h), day: h?.town.day ?? null,
      publishedAt: w.publishedAt,
    };
  };

  // 大厅：公开的世界（官方置顶），支持按关键词筛选
  api.get('/', (c) => {
    const q = String(c.req.query('q') || '').trim().slice(0, 30);
    const rating = String(c.req.query('rating') || '');
    const list = registry.list({ status: 'public' })
      .filter((w) => !q || w.title.includes(q) || w.summary.includes(q) || w.sourceTitle.includes(q))
      .filter((w) => !rating || w.rating === rating)
      .map(card);
    const offset = Math.max(0, Number(c.req.query('offset') || 0));
    return c.json({ total: list.length, list: list.slice(offset, offset + 48), capacity: { running: manager.loaded.size } });
  });

  api.get('/id-available', (c) => {
    const p = registry.idProblem(String(c.req.query('id') || ''));
    return c.json({ ok: !p, reason: p || null });
  });

  // 我的世界：含状态、磁盘占用与上限
  api.get('/mine', (c) => {
    const u = c.get('user');
    if (!u) throw new HttpError(401, '请先登录', { login: true });
    return c.json(deps.mine ? deps.mine(u) : registry.list({ ownerId: u.id }).map(card));
  });

  // ---------- 预览期编辑（多世界设计 §4.3 第 5 步）：owner 和管理员；发布之后不能再改世界包 ----------
  const owned = (c, { editable = false } = {}) => {
    const w = registry.get(c.req.param('id'));
    const ok = authorize(c.get('who') || {}, 'world.manage', w);
    if (!w || ok !== true) throw new HttpError(w ? 403 : 404, w ? ok : '世界不存在');
    if (editable && !EDITABLE.has(w.status)) throw new HttpError(409, '世界发布之后不能再修改世界包');
    return w;
  };
  const packDir = (id) => path.join(manager.root(id), 'pack');

  api.get('/:id/draft', (c) => {
    const w = owned(c);
    if (w.official) throw new HttpError(409, '官方世界的世界包在仓库里维护');
    const p = loadPack(packDir(w.id));
    const job = deps.jobs?.jobs.filter((j) => j.worldId === w.id && j.kind !== 'regen').at(-1);
    return c.json({
      world: w, pack: { world: p.world, map: p.map, arcs: p.arcs, bible: p.bible ? { ...p.bible, characters: p.bible.characters?.map(({ witnesses, ...x }) => x) } : null },
      report: job?.report || null, regen: deps.jobs?.jobs.filter((j) => j.worldId === w.id && j.kind === 'regen').slice(-5).reverse().map((j) => deps.jobs.view(j)) || [],
    });
  });

  api.patch('/:id/draft', (c) => {
    const w = owned(c, { editable: true });
    const b = c.get('body');
    const dir = packDir(w.id);
    const p = loadPack(dir);
    const world = p.world;
    const texts = [];
    const set = (obj, k, v, max) => { if (v !== undefined) { obj[k] = clip(v, max); texts.push(obj[k]); } };
    if (b.title !== undefined) { set(world.meta, 'name', b.title, 16); world.voice.name = world.meta.name; }
    if (b.lore) {
      set(world.lore, 'summary', b.lore.summary, 1500);
      if (Array.isArray(b.lore.pillars)) { world.lore.pillars = b.lore.pillars.map((x) => clip(x, 80)).filter(Boolean).slice(0, 6); texts.push(...world.lore.pillars); }
    }
    if (b.voice) {
      set(world.voice.ui, 'welcome', b.voice.welcome, 200);
      set(world.voice.chronicle, 'name', b.voice.chronicle, 16);
      if (Array.isArray(b.voice.sampleEvents)) { world.voice.ui.sampleEvents = b.voice.sampleEvents.map((x) => clip(x, 60)).filter(Boolean).slice(0, 6); texts.push(...world.voice.ui.sampleEvents); }
    }
    for (const e of Array.isArray(b.personas) ? b.personas.slice(0, 16) : []) {
      const x = world.personas.find((q) => q.id === e.id);
      if (!x) throw new HttpError(404, `居民不存在：${e.id}`);
      set(x, 'name', e.name, 12); set(x, 'role', e.role, 30); set(x, 'persona', e.persona, 380); set(x, 'goal', e.goal, 120);
      if (Array.isArray(e.memories)) { x.memories = e.memories.map((m) => clip(m, 80)).filter(Boolean).slice(0, 5); texts.push(...x.memories); }
    }
    for (const e of Array.isArray(b.places) ? b.places.slice(0, 40) : []) {
      const x = p.map.regions.flatMap((r) => r.areas || []).flatMap((a) => a.places).find((q) => q.id === e.id);
      if (!x) throw new HttpError(404, `地点不存在：${e.id}`);
      set(x, 'name', e.name, 16); set(x, 'desc', e.desc, 110); if (e.emoji !== undefined) x.emoji = clip(e.emoji, 4);
    }
    const bad = texts.filter((t) => t && !keywordCheck(t, reviewRating(world.meta.rating)).ok);
    if (bad.length) throw new HttpError(422, `这些内容不合适：${bad.slice(0, 2).join('；')}`);
    const errs = checkPack(world, p.map);
    if (errs.length) throw new HttpError(422, `改完之后世界包不合法：${errs.slice(0, 3).join('；')}`);
    writePack(dir, { world, map: p.map, arcs: p.arcs, bible: p.bible });
    const next = loadPack(dir);
    registry.update(w.id, { title: world.meta.name, summary: world.lore.summary.slice(0, 300), packHash: next.hash });
    manager.close(w.id, '世界包已修改');
    deps.audit?.({ actor: c.get('user')?.id || 'admin', action: 'world.draft-edit', target: w.id, detail: { fields: Object.keys(b) } });
    return c.json({ ok: true, hash: next.hash });
  });

  api.post('/:id/draft/regenerate', (c) => {
    const w = owned(c, { editable: true });
    const part = String(c.get('body').part || '');
    if (!['personas', 'map', 'extras', 'voice'].includes(part)) throw new HttpError(400, '只能重新生成：personas / map / extras / voice');
    if (!deps.jobs) throw new HttpError(503, '创世未启用');
    if (deps.jobs.jobs.some((j) => j.worldId === w.id && ['queued', 'running'].includes(j.status))) throw new HttpError(409, '这个世界已经有任务在排队了');
    const job = deps.jobs.create({ ownerId: w.ownerId || c.get('user')?.id, worldId: w.id, options: { part }, kind: 'regen' });
    return c.json({ ok: true, jobId: job.id, position: deps.jobs.position(job.id) });
  });

  // ---------- owner 管理（多世界设计 §5.3、§6.3）：发布（自动审核）、暂停 / 恢复、归档、世界设置 ----------
  const act = (c, w, action, detail = {}) => deps.audit?.({ actor: c.get('user')?.id || 'admin', action, target: w.id, detail });

  api.post('/:id/publish', async (c) => {
    const w = owned(c);
    if (w.status !== 'preview') throw new HttpError(409, '只有预览中的世界可以发布');
    if (deps.jobs?.jobs.some((j) => j.worldId === w.id && ['queued', 'running'].includes(j.status))) throw new HttpError(409, '还有任务在进行');
    // 分级必须在创世者被授予的范围内；管理员自己的世界不限
    const owner = w.ownerId ? accounts?.get(w.ownerId) : null;
    const grant = w.ownerId ? accounts?.grant(w.ownerId, 'genesis') : null;
    const allowed = owner && ['admin', 'super'].includes(owner.role) ? null : grant?.quota?.ratings?.length ? grant.quota.ratings : ['cozy', 'adventure'];
    const r = await (deps.review || publishReview)({ packDir: packDir(w.id), allowedRatings: allowed });
    if (!r.ok) {
      registry.setStatus(w.id, 'preview', `自动审核没有通过：${r.reasons.join('；')}`);
      act(c, w, 'world.publish-rejected', { reasons: r.reasons });
      throw new HttpError(422, `自动审核没有通过：${r.reasons.join('；')}`, { reasons: r.reasons });
    }
    registry.setStatus(w.id, 'public', '');
    act(c, w, 'world.publish', { report: r.report });
    return c.json({ ok: true, report: r.report });
  });

  api.post('/:id/pause', (c) => {
    const w = owned(c);
    if (w.status !== 'public') throw new HttpError(409, '只有公开的世界可以暂停');
    registry.setStatus(w.id, 'paused', '创建者暂停了这个世界');
    act(c, w, 'world.pause');
    return c.json({ ok: true });
  });
  api.post('/:id/resume', (c) => {
    const w = owned(c);
    if (w.status !== 'paused') throw new HttpError(409, '世界没有暂停');
    registry.setStatus(w.id, 'public', '');
    act(c, w, 'world.resume');
    return c.json({ ok: true });
  });
  api.post('/:id/archive', (c) => {
    const w = owned(c);
    if (w.official) throw new HttpError(409, '官方世界不能归档');
    registry.setStatus(w.id, 'archived', '已归档，30 天后清理');
    manager.close(w.id, '世界已归档');
    act(c, w, 'world.archive');
    return c.json({ ok: true });
  });

  // 世界设置：标题、简介、自主进化开关、人员流动开关、可见性（owner 可以改自己的世界，管理员可以改任何世界）
  api.patch('/:id/settings', (c) => {
    const w = owned(c);
    const b = c.get('body');
    const patch = {};
    if (b.title !== undefined) patch.title = sanitize(b.title, 40);
    if (b.summary !== undefined) patch.summary = sanitize(b.summary, 300);
    for (const t of [patch.title, patch.summary]) if (t && !keywordCheck(t, 'epic').ok) throw new HttpError(422, '这段文字不太合适');
    if (b.evolution !== undefined) patch.evolution = Boolean(b.evolution);
    const settings = {};
    // 世界级设置（§14.8）：叙事者、Mod；分级改动要在授予范围内（管理员可以改任何世界）
    if (b.migration !== undefined) settings.migration = Boolean(b.migration);
    if (b.storyteller !== undefined) { if (!STORYTELLERS.includes(b.storyteller)) throw new HttpError(400, '未知叙事者'); settings.storyteller = b.storyteller; }
    if (b.rating !== undefined && c.get('admin')) settings.rating = String(b.rating);
    // 死亡预算（每 3 天最多几名具名角色死亡）：owner 只能在授予的上限之内调整，管理员不限
    if (b.deathNamed !== undefined) {
      const n = Number(b.deathNamed);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new HttpError(400, '死亡预算应为 0~20 的整数');
      if (!c.get('admin')) {
        const owner = w.ownerId ? accounts?.get(w.ownerId) : null;
        const q = w.ownerId ? accounts?.grant(w.ownerId, 'genesis')?.quota : null;
        const cap = owner && ['admin', 'super'].includes(owner.role) ? 20 : Number.isInteger(q?.deathNamed) ? q.deathNamed : DEATH_NAMED_DEFAULT;
        if (n > cap) throw new HttpError(403, `你的死亡预算上限是 ${cap}`);
      }
      settings.deathNamed = n;
    }
    if (b.mods !== undefined && c.get('admin')) settings.mods = (Array.isArray(b.mods) ? b.mods : []).map(String).slice(0, 12);
    if (Object.keys(settings).length) patch.settings = settings;
    const next = registry.update(w.id, patch);
    act(c, w, 'world.settings', patch);
    // 叙事者、Mod、进化开关要重新加载世界才生效；人员流动开关直接生效
    const running = manager.get(w.id);
    if (running && settings.migration !== undefined) running.town.worldSettings.migration = settings.migration;
    if (running && settings.deathNamed !== undefined) running.town.worldSettings.deathNamed = settings.deathNamed;
    const reload = Object.keys(settings).some((k) => !['migration', 'deathNamed'].includes(k));
    if (reload || patch.evolution !== undefined) manager.close(w.id, '世界设置已修改');
    return c.json({ ok: true, world: next });
  });

  // ---------- 举报（§10.2）：登录用户可以举报世界、角色或单条动态；有效举报达到阈值自动转为不公开 ----------
  api.post('/:id/report', (c) => {
    const w = registry.get(c.req.param('id'));
    if (!w || !['public', 'unlisted', 'paused'].includes(w.status)) throw new HttpError(404, '世界不存在');
    const u = c.get('user');
    if (!u || u.id === 'u_local' && setting('PUBLIC_MODE')) throw new HttpError(401, '登录后才能举报', { login: true });
    const q = quota(c.get('who'), 'report');
    if (!q.ok) throw new HttpError(429, q.message, { retryAfter: q.retryAfter });
    const b = c.get('body');
    const target = String(b.target || 'world').slice(0, 60);
    if (!/^(world|persona:[a-z0-9_]{2,32}|log:\d{1,9}|newspaper:\d{1,4})$/.test(target)) throw new HttpError(400, '举报对象不合法');
    const reason = sanitize(b.reason, 200);
    if (reason.length < 2) throw new HttpError(400, '说说为什么要举报');
    const db = registry.db;
    // 同一个人对同一个世界 24 小时内只算一次
    if (db.prepare('SELECT id FROM reports WHERE world_id = ? AND reporter = ? AND created_at > ?').get(w.id, u.id, Date.now() - 86400_000)) return c.json({ ok: true, duplicate: true });
    db.prepare('INSERT INTO reports (world_id, target, reason, reporter, created_at) VALUES (?, ?, ?, ?, ?)').run(w.id, target, reason, u.id, Date.now());
    // 有效举报：7 天内、未处理、不同的举报人
    const n = db.prepare('SELECT COUNT(DISTINCT reporter) AS n FROM reports WHERE world_id = ? AND handled_at IS NULL AND created_at > ?').get(w.id, Date.now() - 7 * 86400_000).n;
    if (!w.official && w.status === 'public' && n >= setting('REPORT_UNLIST_THRESHOLD')) {
      registry.setStatus(w.id, 'unlisted', `收到 ${n} 份举报，暂时不在大厅公开，等待管理员处理`);
      deps.audit?.({ actor: 'system', action: 'world.unlisted', target: w.id, detail: { reports: n } });
    }
    return c.json({ ok: true });
  });

  // 发布前可以换短名（发布后不可修改，保证分享出去的链接长期有效）
  api.post('/:id/rename', (c) => {
    const w = owned(c, { editable: true });
    const to = String(c.get('body').id || '');
    const p = registry.idProblem(to);
    if (p) throw new HttpError(409, p);
    if (deps.jobs?.jobs.some((j) => j.worldId === w.id && ['queued', 'running'].includes(j.status))) throw new HttpError(409, '有任务在进行，稍后再改');
    manager.close(w.id, '世界改名');
    registry.db.prepare('UPDATE worlds SET id = ? WHERE id = ?').run(to, w.id);
    if (fs.existsSync(manager.root(w.id))) fs.renameSync(manager.root(w.id), manager.root(to));
    for (const j of deps.jobs?.jobs || []) if (j.worldId === w.id) j.worldId = to;
    deps.jobs?.save();
    deps.audit?.({ actor: c.get('user')?.id || 'admin', action: 'world.rename', target: to, detail: { from: w.id } });
    return c.json({ ok: true, id: to });
  });

  return api;
}
