// 世界内的接口（挂在 /api 与 /api/w/:world 下）：c.get('host') 是当前世界的托管对象。
// 身份（admin / vid / ip）由上层中间件解析，这里只关心业务。
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { llmPublic, listSnapshots, restoreSnapshot } from '../sim.js';
import { ADMIN_OPS } from '../worldai/proposals.js';
import { registry, forkTimeline, setActive } from '../timelines.js';
import * as llm from '../llm.js';
import { useAbility } from '../kernel/abilities.js';
import { config, sanitize, moderate } from '../guard.js';
import { authorize } from '../accounts/authz.js';
import { quota, remaining as quotaLeft } from '../accounts/quota.js';
import { HttpError } from './util.js';

function requireAdmin(c) {
  if (!c.get('admin')) throw new HttpError(403, '只有小镇管理员可以这样做');
}
/** 互动（现身、聊天、心声、事件、天气、投票、举报）：只有登录的用户；游客返回 401，页面弹出登录框后自动继续 */
function requireUser(c) {
  if (!config.allowInteraction && !c.get('admin')) throw new HttpError(403, '当前为只读观赏模式');
  if (c.get('admin')) return;
  const ok = authorize(c.get('who'), 'interact');
  if (ok !== true) throw new HttpError(401, ok, { login: true });
}
/** 需要调用模型的互动：再检查模型、预算与队列 */
function requireInteraction(c) {
  requireUser(c);
  const admin = c.get('admin');
  if (!llm.stats.enabled) throw new HttpError(503, 'AI 尚未配置');
  if (llm.budgetLeft() <= 0) throw new HttpError(429, '今天的 AI 额度已经用完了，明天再来吧 🌙');
  if (llm.queueSize() > config.maxQueueForUser && !admin) throw new HttpError(503, '居民们正忙着思考，请稍后再试');
}
function take(c, bucket, opts = {}) {
  const r = quota(c.get('who'), bucket, { world: c.get('host').id, ...opts });
  if (!r.ok) throw new HttpError(429, r.message, { retryAfter: r.retryAfter });
  return r;
}
function remaining(c) {
  const who = c.get('who');
  return { chat: quotaLeft(who, 'chat'), event: quotaLeft(who, 'event') };
}
/** 审核用的世界上下文 */
const worldCtx = (t) => ({ name: t.spec.meta.name, place: t.spec.voice?.place || '小镇', pillars: t.spec.lore.pillars });
/** 当前请求的旅人身份：账号 id + 当前昵称 */
const visitor = (c) => ({ id: c.get('vid'), name: c.get('user')?.nickname || null });

/**
 * @param {object} deps
 * @param {import('../accounts/index.js').Accounts} [deps.accounts]
 * @param {() => object} [deps.engineStatus] 进化引擎状态（管理员可见）
 * @param {(c, host) => Response} deps.openStream SSE
 */
export function worldApi(deps) {
  const api = new Hono();
  const town = (c) => c.get('host').town;

  api.get('/stream', (c) => deps.openStream(c, c.get('host')));
  api.get('/me', (c) => {
    const admin = c.get('admin'), user = c.get('user');
    return c.json({
      admin, publicMode: config.publicMode, needToken: Boolean(config.adminToken), accounts: Boolean(deps.accounts),
      user: user ? { id: user.id, username: user.username, nickname: user.nickname, role: user.role, local: user.id === 'u_local' } : null,
      grants: user && deps.accounts ? deps.accounts.grantsOf(user.id) : [],
      interaction: (config.allowInteraction || admin) && Boolean(user || admin),
      loginToInteract: config.allowInteraction && !user && !admin,
      limits: { chatPerHour: config.chatPerHour, eventPerHour: config.eventPerHour, weatherCooldownSec: config.weatherCooldownSec },
      remaining: remaining(c),
      avatar: c.get('vid') ? town(c).avatars.mine(c.get('vid'))?.id || null : null,
      budget: { total: llm.stats.dailyBudget, left: Number.isFinite(llm.budgetLeft()) ? llm.budgetLeft() : null },
      world: c.get('host').id,
    });
  });
  api.get('/agent/:id', (c) => {
    const d = town(c).agentDetail(c.req.param('id'), c.get('vid') || '-');
    return d ? c.json(d) : c.json({ error: '不存在' }, 404);
  });
  api.get('/relations', (c) => c.json(town(c).relationsGraph()));
  api.get('/usage', (c) => c.json(town(c).usageView()));
  api.get('/metrics', (c) => c.json(town(c).metricsView()));
  api.get('/newspapers', (c) => c.json(town(c).newspapers));
  api.get('/world/history', (c) => c.json(town(c).worldHistory().slice(-200)));
  api.get('/story', (c) => c.json({ ...town(c).storyView(c.get('vid') || '-'), admin: c.get('admin') }));
  api.get('/proposals', (c) => c.json({ ...town(c).proposalsView(c.get('vid') || '-', c.get('admin')), admin: c.get('admin') }));
  api.get('/evolution', (c) => {
    const t = town(c), admin = c.get('admin');
    return c.json({ ...t.evolved.view(admin), builtin: t.plugins.view(), decisions: t.decisions.view(admin), engine: admin ? deps.engineStatus?.() : undefined, admin });
  });
  api.get('/decisions', (c) => c.json({ ...town(c).decisions.view(c.get('admin')), admin: c.get('admin') }));
  api.get('/snapshots', (c) => { requireAdmin(c); return c.json(listSnapshots(town(c).dataDir)); });
  api.get('/timelines', (c) => { requireAdmin(c); return c.json(registry(c.get('host').dataRoot)); });

  // ---------- 写接口（请求体已由上层中间件解析为 c.get('body')）----------
  api.post('/chat', async (c) => {
    requireInteraction(c);
    const t = town(c), b = c.get('body');
    const agent = t.byId[String(b.id)];
    if (!agent) throw new HttpError(404, '居民不存在');
    const mode = b.mode === 'whisper' ? 'whisper' : 'visitor';
    const text = sanitize(b.text, 200);
    if (text.length < 1) throw new HttpError(400, '说点什么吧');
    take(c, 'chat');
    const m = await moderate(text, 'chat', t.spec.meta.rating, worldCtx(t));
    if (!m.ok) throw new HttpError(422, m.reason);
    // 心声对居民是匿名的，但日志里记下账号，便于管理员追查滥用
    if (mode === 'whisper') console.log(`[whisper] ${c.get('host').id} ${c.get('vid')} → ${agent.id}: ${text}`);
    const r = await t.visitorChat(agent.id, text, mode, visitor(c));
    return c.json({ ...r, remaining: remaining(c) });
  });

  api.post('/event', async (c) => {
    requireInteraction(c);
    const t = town(c), b = c.get('body');
    const text = sanitize(b.text, 120);
    if (text.length < 4) throw new HttpError(400, '事件描述太短了');
    const target = b.target === 'all' || !b.target ? 'all' : String(b.target);
    if (target !== 'all' && !t.byId[target]) throw new HttpError(404, '居民不存在');
    // 先检查不扣次数，审核通过后再扣，避免被拒的内容也消耗额度；尝试次数（含被拒的）单独计数
    take(c, 'event', { take: false });
    take(c, 'eventAttempt');
    const m = await moderate(text, 'event', t.spec.meta.rating, worldCtx(t));
    if (!m.ok) throw new HttpError(422, m.reason);
    take(c, 'event');
    console.log(`[event] ${c.get('host').id} ${c.get('vid')}@${c.get('ip')} → ${target}: ${text}`);
    t.godEvent(text, target).catch((e) => console.warn('[event]', e.message));
    return c.json({ ok: true, remaining: remaining(c) });
  });

  api.post('/control', (c) => {
    const t = town(c), b = c.get('body');
    const out = {};
    if (b.weather != null) {
      const w = String(b.weather);
      if (w !== 'auto' && !Object.hasOwn(t.spec.weather, w)) throw new HttpError(400, '未知天气');
      requireUser(c);
      take(c, 'weather');
      t.setWeather(w);
      out.weather = w;
    }
    if (b.speed != null || b.paused != null || b.skipTo != null) {
      requireAdmin(c);
      if (b.speed != null) {
        const sp = Number(b.speed);
        if (!Number.isFinite(sp)) throw new HttpError(400, '速度无效');
        t.speed = Math.max(0.25, Math.min(30, sp));
      }
      if (b.paused != null) t.paused = Boolean(b.paused);
      if (b.skipTo != null) {
        const target = Number(b.skipTo);
        if (!Number.isFinite(target) || target < 0 || target >= 1440) throw new HttpError(400, '时间无效');
        const m = t.t % 1440;
        t.t += ((target - m + 1440) % 1440) || 1440;
      }
    }
    return c.json({ ok: true, speed: t.speed, paused: t.paused, ...out });
  });

  // 直接应用一条世界操作（仅管理员）
  api.post('/world/op', (c) => {
    requireAdmin(c);
    const b = c.get('body');
    if (!b.op || typeof b.op !== 'string') throw new HttpError(400, '缺少 op');
    const rec = town(c).applyWorldOp({ op: b.op, args: b.args && typeof b.args === 'object' ? b.args : {} }, { by: 'admin' });
    return c.json({ ok: true, op: rec });
  });

  // 让某位居民立即使用一项能力（仅管理员，用于演示与排查）
  api.post('/ability', (c) => {
    requireAdmin(c);
    const t = town(c), b = c.get('body');
    const agent = t.byId[String(b.id)];
    if (!agent) throw new HttpError(404, '居民不存在');
    const r = useAbility(t, agent, String(b.ability || ''), b.target ? sanitize(b.target, 12) : null, '（管理员指示）');
    if (!r.ok) throw new HttpError(422, r.reason);
    return c.json({ ok: true });
  });

  // 向世界架构师提一个建设建议（访客限流 + 审核；管理员不限）
  api.post('/proposals', async (c) => {
    requireInteraction(c);
    const t = town(c), b = c.get('body'), admin = c.get('admin');
    const text = sanitize(b.intent, 120);
    if (text.length < 4) throw new HttpError(400, '说得再具体一点吧');
    take(c, 'proposal');
    const m = await moderate(text, 'event', t.spec.meta.rating, worldCtx(t));
    if (!m.ok) throw new HttpError(422, m.reason);
    const err = t.architect ? t.architect.enqueue(text, admin ? 'admin' : 'visitor') : '世界架构师插件未启用';
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  // 管理员直接提交一份世界补丁（仍然经过校验、设定考据与审批流程）
  api.post('/proposals/direct', (c) => {
    requireAdmin(c);
    const b = c.get('body');
    const r = town(c).proposalSystem.submit({ title: b.title, motive: b.motive, ops: b.ops, construction: b.construction, origin: 'admin', allowed: ADMIN_OPS });
    if (r.error) throw new HttpError(422, r.error);
    return c.json({ ok: true, id: r.proposal.id });
  });

  api.post('/proposals/vote', (c) => {
    voteGate(c);
    const b = c.get('body');
    const err = town(c).proposalSystem.vote(String(b.id || ''), c.get('vid'), Boolean(b.yes));
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  api.post('/gaps/status', (c) => {
    requireAdmin(c);
    const t = town(c), b = c.get('body');
    const err = !t.architect ? '世界架构师插件未启用' : t.architect.setGapStatus(String(b.id || ''), String(b.status || ''));
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  api.post('/proposals/decide', (c) => {
    requireAdmin(c);
    const b = c.get('body');
    const err = town(c).proposalSystem.decide(String(b.id || ''), Boolean(b.approve), 'admin');
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  // AI 插件：访客投票（每人一票）、管理员停用 / 回滚 / 启用
  api.post('/evolution/vote', (c) => {
    voteGate(c);
    const b = c.get('body');
    const err = town(c).evolved.vote(String(b.key || ''), c.get('vid'), Boolean(b.yes));
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });
  api.post('/evolution/action', (c) => {
    requireAdmin(c);
    const b = c.get('body');
    const err = town(c).evolved.adminAction(String(b.key || ''), String(b.action || ''));
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });
  // AI 插件自己的接口：/api/p/<插件id>/<接口名>
  api.post('/p/:id/:name', async (c) => {
    const id = c.req.param('id'), name = c.req.param('name');
    if (!/^[a-z][a-z0-9-]{2,31}$/.test(id) || !/^[a-z][a-z0-9-]{1,23}$/.test(name)) throw new HttpError(404, '不存在');
    requireUser(c);
    take(c, 'plugin');
    const result = await town(c).evolved.route(id, name, c.get('body').body ?? null);
    return c.json({ ok: true, result });
  });

  // 统一决策队列：管理员直接拍板 / 撤销 AI 的裁决
  api.post('/decisions/decide', (c) => {
    requireAdmin(c);
    const t = town(c), b = c.get('body');
    const d = t.decisions.get(String(b.id || ''));
    if (!d) throw new HttpError(404, '决策项不存在');
    // 提案与剧情抉择走原来的终审入口（会同时关闭决策项）
    const err = d.kind === 'proposal' ? t.proposalSystem.decide(d.ref, Boolean(b.adopt), 'admin')
      : d.kind === 'vote' ? t.votes.decide(d.ref, String(b.option || ''), 'admin')
        : t.decisions.decide(d.id, { adopt: Boolean(b.adopt) }, 'admin');
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });
  api.post('/decisions/undo', (c) => {
    requireAdmin(c);
    const err = town(c).decisions.undo(String(c.get('body').id || ''));
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  // 时光回溯：恢复到某个整点快照（仅管理员，需二次确认；当前存档自动备份）
  api.post('/rollback', (c) => {
    requireAdmin(c);
    const host = c.get('host'), b = c.get('body');
    if (b.confirm !== 'ROLLBACK') throw new HttpError(400, '需要确认');
    const name = String(b.name || '');
    // 先校验快照（不合法时小镇照常运行），再存盘（备份里包含最新进度），最后才停止旧小镇
    if (!/^d\d{3}-\d{2}\.json(?:\.gz)?$/.test(name)) throw new HttpError(400, '快照名称不合法');
    if (!listSnapshots(host.town.dataDir).some((x) => x.name === name)) throw new HttpError(404, '快照不存在');
    host.town.save();
    host.town.stop();
    let bak;
    try { bak = restoreSnapshot(host.town.dataDir, name); } catch (e) {
      host.replace(host.makeTown());
      throw e;
    }
    host.replace(host.makeTown());
    console.log(`[rollback] ${c.get('ip')} 把 ${host.id} 回溯到 ${name}，原存档备份为 ${bak}`);
    return c.json({ ok: true, backup: bak });
  });

  // 时间线分支：从快照（或此刻）分出新时间线，可选择立即切换过去
  api.post('/timelines/fork', (c) => {
    requireAdmin(c);
    const host = c.get('host'), b = c.get('body');
    if (host.diskFull) throw new HttpError(409, '这个世界的磁盘空间已经用满了，删掉一些时间线或联系管理员放宽上限后再分支');
    const fromId = registry(host.dataRoot).active;
    if (!b.snapshot) host.town.save();
    const entry = forkTimeline(host.dataRoot, { fromId, snapshot: b.snapshot ? String(b.snapshot) : null, name: sanitize(b.name, 20) });
    if (b.switch !== false) switchTimeline(host, entry.id, c.get('ip'));
    return c.json({ ok: true, timeline: entry });
  });
  api.post('/timelines/switch', (c) => {
    requireAdmin(c);
    switchTimeline(c.get('host'), String(c.get('body').id || ''), c.get('ip'));
    return c.json({ ok: true });
  });

  // 访客化身：现身 / 走动 / 离开（不调用模型）
  api.post('/avatar', async (c) => {
    const t = town(c), b = c.get('body'), user = c.get('user');
    requireUser(c);
    take(c, 'avatar');
    // 旅人在所有世界里都用账号昵称出现；只有持令牌但没登录的管理员才自己起名字
    const name = user?.nickname || sanitize(b.name, 8);
    if (!user) {
      const m = await moderate(name, 'chat', t.spec.meta.rating, worldCtx(t));
      if (!m.ok) throw new HttpError(422, m.reason);
    }
    const v = t.avatars.join(c.get('vid'), c.get('ip'), { name, color: b.color });
    return c.json({ ok: true, avatar: { id: v.id, name: v.name, color: v.color } });
  });
  api.post('/avatar/move', (c) => { requireUser(c); town(c).avatars.move(c.get('vid'), String(c.get('body').location || '')); return c.json({ ok: true }); });
  api.post('/avatar/goto', (c) => { requireUser(c); const b = c.get('body'); town(c).avatars.goto(c.get('vid'), b.x, b.y); return c.json({ ok: true }); });
  api.post('/avatar/leave', (c) => c.json({ ok: c.get('vid') ? town(c).avatars.leave(c.get('vid')) : false }));

  // 打开 / 关闭异界区域（管理员）
  api.post('/region', (c) => {
    requireAdmin(c);
    const t = town(c), b = c.get('body');
    if (!t.openRegion(String(b.id || ''), b.open !== false)) throw new HttpError(400, '未知区域');
    return c.json({ ok: true, regions: t.regionsView() });
  });

  // 访客投票（每个 IP 每次抉择一票）
  api.post('/vote', (c) => {
    voteGate(c);
    const b = c.get('body');
    const err = town(c).votes.cast(String(b.id || ''), c.get('vid'), String(b.option || ''));
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });
  api.post('/vote/decide', (c) => {
    requireAdmin(c);
    const b = c.get('body');
    const err = town(c).votes.decide(String(b.id || ''), String(b.option || ''), 'admin');
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  // 手动开启剧情弧（管理员）
  api.post('/arc/start', (c) => {
    requireAdmin(c);
    const err = town(c).arcs.start(String(c.get('body').template || ''), 'admin');
    if (err) throw new HttpError(409, err);
    return c.json({ ok: true });
  });

  // 让叙事导演立即做一次决策（管理员）
  api.post('/director/decide', async (c) => {
    requireAdmin(c);
    const t = town(c);
    if (!llm.stats.enabled) throw new HttpError(503, 'AI 尚未配置');
    if (t.director.deciding) throw new HttpError(409, '导演正在思考');
    const r = await t.director.decide();
    return c.json({ ok: true, ...r });
  });

  api.post('/newspaper', async (c) => {
    requireAdmin(c);
    if (llm.budgetLeft() <= 0) throw new HttpError(429, '今日 AI 额度已用完');
    return c.json(await town(c).makeNewspaper());
  });

  api.post('/reset', (c) => {
    requireAdmin(c);
    const host = c.get('host');
    if (c.get('body').confirm !== 'RESET') throw new HttpError(400, '需要确认');
    host.town.stop();
    // 不直接删除：旧存档改名备份，可手动恢复
    const save = path.join(host.town.dataDir, 'save.json');
    if (fs.existsSync(save)) {
      const bak = path.join(host.town.dataDir, `save-${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`);
      fs.renameSync(save, bak);
      console.log(`[reset] 旧存档已备份为 ${path.basename(bak)}`);
    }
    host.replace(host.makeTown());
    console.log(`[reset] ${host.id} 已由 ${c.get('ip')} 重置到第一天`);
    return c.json({ ok: true });
  });

  return api;
}

function voteGate(c) {
  requireUser(c);
  take(c, 'vote');
}

/** 切换到另一条时间线：当前小镇存盘停下，换成目标时间线的小镇 */
function switchTimeline(host, id, ip) {
  const r = registry(host.dataRoot);
  if (!r.list.some((t) => t.id === id)) throw new HttpError(404, '时间线不存在');
  host.town.save();
  host.town.stop();
  setActive(host.dataRoot, id);
  host.replace(host.makeTown());
  console.log(`[timeline] ${ip} 把 ${host.id} 切换到时间线 ${id}`);
}

export { llmPublic };
