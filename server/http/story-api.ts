// 世界史诗、大纲、结局、第二部与分级修改的接口（docs/design/epic-outline.md §7），挂在世界接口下（/api/w/:world/...）。
// 读：史诗所有人可读；大纲按身份裁剪（只有管理者看得到未来）。写：只有管理者（这个世界的所有者或全站管理员）。
// 要调用模型的操作作为后台任务运行：立即返回任务 id，页面轮询 /ai-jobs/:id。
import { HttpError } from './util.ts';
import { RATINGS, EXPLICIT_RATINGS } from '../kernel/ratings.ts';
import type { Hono } from 'hono';
import type { AppEnv, Ctx } from '../types/http.ts';
import type { Accounts } from '../accounts/index.ts';
import type { Town } from '../sim.ts';

type Reviewer = (c: Ctx) => 'admin' | 'owner' | null;

/** 模块里抛出的带 status 的错误（大纲、计划）→ HTTP 错误 */
function rethrow(e: unknown): never {
  const x = e as Error & { status?: number; extra?: Record<string, unknown> };
  if (x instanceof HttpError) throw x;
  if (x?.status) throw new HttpError(x.status, x.message, x.extra || {});
  throw x;
}
const guard = <T>(fn: () => T): T => { try { return fn(); } catch (e) { rethrow(e); } };

export function storyRoutes(api: Hono<AppEnv>, { reviewer, accounts }: { reviewer: Reviewer; accounts?: Accounts | null }): void {
  const town = (c: Ctx): Town => c.get('host').town;
  const manager = (c: Ctx): string => {
    const r = reviewer(c);
    if (!r) throw new HttpError(403, '只有这个世界的创建者或管理员可以这样做');
    return c.get('user')?.id || (r === 'admin' ? 'admin' : 'owner');
  };
  const job = (c: Ctx, kind: string, fn: () => Promise<unknown>) => {
    const by = manager(c);
    const j = guard(() => town(c).aiJobs.start(kind, by, fn));
    return c.json({ ok: true, jobId: j.id });
  };
  const num = (v: unknown): number => (Number.isInteger(v) ? v as number : -1);

  // ---------- 史诗 ----------
  api.get('/epic', (c) => c.json({ ...town(c).epicSys.toc(), manager: Boolean(reviewer(c)) }));
  api.get('/epic.md', (c) => {
    const t = town(c);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${t.epicSys.config().title}.md`)}`);
    return c.body(t.epicSys.markdown());
  });
  api.get('/epic/:part/:n', (c) => {
    const t = town(c);
    const ch = t.epicSys.chapter(Number(c.req.param('part')), Number(c.req.param('n')));
    if (!ch) throw new HttpError(404, '没有这一章');
    // 章节对应的大纲节点：其他人只能看到已经发生的
    const visible = reviewer(c) ? ch.beats : ch.beats.filter((id) => t.outlineSys.publicBeats().has(id));
    const list = t.epicSys.chapters;
    const i = list.indexOf(ch);
    const ref = (x: typeof ch | undefined) => (x ? { part: x.part, n: x.n, title: x.title } : null);
    return c.json({ ...ch, beats: t.outlineSys.beatTexts(visible), prev: ref(list[i - 1]), next: ref(list[i + 1]) });
  });
  api.post('/epic/write', (c) => {
    const t = town(c);
    if (t.epicSys.busy) throw new HttpError(409, '正在写');
    if (!t.epicSys.notes.some((n) => n.seq > t.epic.cursor && n.w > 0)) throw new HttpError(409, '还没有新的素材');
    return job(c, 'epic', () => t.epicSys.write());
  });

  // ---------- 大纲 ----------
  api.get('/outline', (c) => c.json(town(c).outlineSys.view(Boolean(reviewer(c)))));
  api.get('/outline/revisions/:v', (c) => {
    manager(c);
    const r = town(c).outlineRevisions.find((x) => x.v === Number(c.req.param('v')));
    if (!r) throw new HttpError(404, '没有这个版本');
    return c.json(r);
  });
  // AI 生成 / 修改：结果存为草稿（刷新页面、换一台设备都还在），并自动提交评审
  api.post('/outline/assist', (c) => {
    const t = town(c), b = c.get('body');
    const instruction = String(b.instruction || '').trim().slice(0, 600);
    if (!instruction) throw new HttpError(400, '请描述想怎么修改');
    const by = manager(c);
    return job(c, 'outline', () => t.outlineSys.draftJob('assist', { instruction, baseVersion: num(b.baseVersion), from: b.draft && typeof b.draft === 'object' ? b.draft : null, by }));
  });
  api.post('/outline/generate', (c) => {
    const t = town(c), b = c.get('body');
    const by = manager(c);
    return job(c, 'outline', () => t.outlineSys.draftJob('generate', { baseVersion: num(b.baseVersion), by }));
  });
  api.post('/outline/review', (c) => {
    const t = town(c), b = c.get('body');
    if (!b.draft || typeof b.draft !== 'object') throw new HttpError(400, '缺少草稿');
    const by = manager(c);
    return job(c, 'outline', async () => {
      const r = await t.outlineSys.review(b.draft, num(b.baseVersion), by);
      const cur = t.outlineDraft;
      t.outlineSys.putDraft(r.draft, { base: num(b.baseVersion), by, source: cur?.source || 'manual', summary: cur?.summary || '', review: r.result, reviewId: r.reviewId });
      return r;
    });
  });
  // 手动编辑的草稿：边改边暂存（评审结果随之失效）
  api.post('/outline/draft', (c) => {
    const t = town(c), b = c.get('body');
    const by = manager(c);
    if (!b.draft || typeof b.draft !== 'object') throw new HttpError(400, '缺少草稿');
    const cur = t.outlineDraft;
    const source = ['generate', 'assist', 'manual', 'revision'].includes(b.source) ? b.source : cur?.source || 'manual';
    t.outlineSys.putDraft(b.draft, { base: num(b.baseVersion), by, source, summary: typeof b.summary === 'string' ? b.summary : cur?.summary || '' });
    return c.json({ ok: true });
  });
  api.post('/outline/draft/discard', (c) => {
    manager(c);
    town(c).outlineSys.discardDraft();
    return c.json({ ok: true });
  });
  api.post('/outline/save', (c) => {
    const t = town(c), b = c.get('body');
    const by = manager(c);
    if (!b.draft || typeof b.draft !== 'object') throw new HttpError(400, '缺少草稿');
    const o = guard(() => t.outlineSys.save(b.draft, { baseVersion: num(b.baseVersion), reviewId: b.reviewId ? String(b.reviewId) : null, force: Boolean(b.force), by, admin: Boolean(c.get('admin')), kind: b.kind === 'owner-ai' ? 'owner-ai' : 'owner-manual', note: String(b.note || '') }));
    return c.json({ ok: true, version: o.version });
  });
  // 自动调整未来的开关：不改内容，不需要评审
  api.post('/outline/auto', (c) => {
    const t = town(c), b = c.get('body');
    const by = manager(c);
    const o = t.outline;
    if (!o) throw new HttpError(404, '这个世界还没有大纲');
    const next = { ...structuredClone(o), autoAdjust: Boolean(b.on) };
    t.outlineSys.commit(next, { kind: 'owner-manual', by, note: b.on ? '开启自动调整未来' : '关闭自动调整未来' });
    return c.json({ ok: true, version: t.outlineSys.version });
  });

  // ---------- 第二部 ----------
  api.post('/story/sequel', (c) => {
    const t = town(c), b = c.get('body');
    const direction = String(b.direction || '').trim().slice(0, 300);
    if (!direction) throw new HttpError(400, '请写一句第二部的方向');
    if (!t.endState.ended) throw new HttpError(409, '世界还没有完结');
    const by = manager(c);
    return job(c, 'sequel', () => t.sequel.plan({ direction, threats: Boolean(b.threats), by }));
  });
  api.post('/story/sequel/apply', (c) => {
    const t = town(c), b = c.get('body');
    const by = manager(c);
    return c.json({ ok: true, ...guard(() => t.sequel.apply(String(b.planId || ''), { by, force: Boolean(b.force), admin: Boolean(c.get('admin')) })) });
  });

  // ---------- 分级修改 ----------
  /** 这个人能把世界改成哪些分级：管理员不限；所有者在授予的范围内（默认温馨、冒险） */
  const allowedRatings = (c: Ctx): readonly string[] => {
    if (reviewer(c) === 'admin') return RATINGS;
    const w = c.get('host').world;
    const owner = w?.ownerId ? accounts?.get(w.ownerId) : null;
    if (owner && ['admin', 'super'].includes(owner.role)) return RATINGS;
    const grant = w?.ownerId ? accounts?.grant(w.ownerId, 'genesis') : null;
    return grant?.quota?.ratings?.length ? grant.quota.ratings : ['cozy', 'adventure'];
  };
  api.get('/rating/options', (c) => {
    manager(c);
    return c.json({ current: town(c).spec.meta.rating, allowed: allowedRatings(c), explicit: EXPLICIT_RATINGS });
  });
  api.post('/rating/plan', (c) => {
    const t = town(c), b = c.get('body');
    const to = String(b.to || '');
    if (!(RATINGS as readonly string[]).includes(to)) throw new HttpError(400, '未知分级');
    manager(c);
    if (!allowedRatings(c).includes(to)) throw new HttpError(403, `你没有被授予「${to}」分级`);
    if (t.endState.ended) throw new HttpError(409, '故事已经完结，开启下一部之后才能修改分级');
    const by = manager(c);
    return job(c, 'rating', () => t.rerate.plan({ to, direction: String(b.direction || '').slice(0, 300), threats: b.threats !== false, by }));
  });
  api.post('/rating/apply', (c) => {
    const t = town(c), b = c.get('body');
    const by = manager(c);
    const e = t.outlineSys.desk.entry(String(b.planId || ''), 'rerate');
    const to = (e?.payload as { to?: string } | undefined)?.to;
    if (to && !allowedRatings(c).includes(to)) throw new HttpError(403, `你没有被授予「${to}」分级`);
    return c.json({ ok: true, ...guard(() => t.rerate.apply(String(b.planId || ''), { by, force: Boolean(b.force), admin: Boolean(c.get('admin')) })) });
  });

  // ---------- 后台任务 ----------
  api.get('/ai-jobs/:id', (c) => {
    const by = manager(c);
    const j = town(c).aiJobs.get(c.req.param('id'), c.get('admin') ? null : by);
    if (!j) throw new HttpError(404, '任务不存在（服务可能重启过，请重新发起）');
    return c.json(j);
  });
}
