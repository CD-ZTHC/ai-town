// 世界大厅与世界管理接口（多世界设计 §11「世界」）：/api/worlds/*
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { HttpError } from './util.js';
import { authorize } from '../accounts/authz.js';
import { loadPack, writePack } from '../worlds/pack.js';
import { checkPack } from '../genesis/pipeline.js';
import { keywordCheck } from '../guard.js';

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
    const bad = texts.filter((t) => t && !keywordCheck(t, world.meta.rating === 'tragic' ? 'tragic' : 'epic').ok);
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
