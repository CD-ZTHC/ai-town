// 世界大厅与世界管理接口（多世界设计 §11「世界」）：/api/worlds/*
import { Hono } from 'hono';
import { HttpError } from './util.js';

/**
 * @param {object} deps
 * @param {import('../worlds/registry.js').WorldRegistry} deps.registry
 * @param {import('../worlds/manager.js').WorldManager} deps.manager
 * @param {import('../accounts/index.js').Accounts} [deps.accounts]
 */
export function worldsApi(deps) {
  const api = new Hono();
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

  return api;
}
