// HTTP 服务：静态资源 + SSE 实时推送 + REST 接口（零依赖），含公网部署所需的权限、限流与审核
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Town, llmPublic, listSnapshots, restoreSnapshot } from './sim.js';
import { ADMIN_OPS } from './worldai/proposals.js';
import { registry, activeDir, forkTimeline, setActive } from './timelines.js';
import * as llm from './llm.js';
import { useAbility } from './kernel/abilities.js';
import { config, clientIp, isAdmin, visitorId, limits, sanitize, moderate } from './guard.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined;
const PUBLIC = path.resolve('public');
// 数据根目录：主时间线存放在这里，分支时间线在 timelines/ 子目录
const DATA = path.resolve(process.env.DATA_DIR || 'data');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

const makeTown = () => new Town({ dataDir: activeDir(DATA) });
let town = makeTown();
const clients = new Set();
const clientsPerIp = new Map();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
function wire(t) {
  t.on('tick', (s) => { if (clients.size) broadcast('tick', s); });
  t.on('log', (l) => broadcast('log', l));
  t.on('agent', (id) => broadcast('agent', { id }));
  t.on('newspaper', (p) => broadcast('newspaper', p));
  t.on('world', (w) => broadcast('world', w));
  t.on('vfx', (v) => broadcast('vfx', v));
  t.on('agents', (list) => broadcast('agents', list));
  // 故事面板只推送「有变化」的通知，页面再按需拉取 /api/story
  let storyTimer = null;
  t.on('story', () => { if (!storyTimer) storyTimer = setTimeout(() => { storyTimer = null; broadcast('story', { t: t.t }); }, 800); });
  t.votes.requireAdmin = config.publicMode && Boolean(config.adminToken);
  t.proposalSystem.requireAdmin = config.publicMode && Boolean(config.adminToken);
  t.on('worldmap', (w) => broadcast('worldmap', w));
  t.on('regions', (r) => broadcast('regions', r));
  let propTimer = null;
  t.on('proposals', () => { if (!propTimer) propTimer = setTimeout(() => { propTimer = null; broadcast('proposals', { t: t.t }); }, 800); });
  t.start();
}
wire(town);
let llmDirty = false;
llm.onActivity(() => { llmDirty = true; });
setInterval(() => { if (llmDirty || llm.stats.active.length) { llmDirty = false; broadcast('llm', llmPublic()); } }, 400);

// ---------- 无人观看时自动暂停（节省 LLM 开销）----------
let lastViewer = Date.now();
if (config.idlePauseSec > 0) {
  setInterval(() => {
    if (clients.size) { lastViewer = Date.now(); if (town.idle) { town.idle = false; console.log('[idle] 有访客，小镇继续运转'); } return; }
    if (!town.idle && Date.now() - lastViewer > config.idlePauseSec * 1000) {
      town.idle = true;
      town.save();
      console.log('[idle] 无人观看，小镇进入休眠');
    }
  }, 5000).unref();
}

// ---------- 工具 ----------
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const json = (res, code, data, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const type = String(req.headers['content-type'] || '');
  // 强制 JSON：跨站表单无法伪造，跨站 fetch 会触发预检而被拒绝
  if (!type.startsWith('application/json')) return reject(new HttpError(415, '需要 application/json'));
  if (Number(req.headers['content-length'] || 0) > 8192) { req.resume(); return reject(new HttpError(413, '请求过大')); }
  let s = '';
  let over = false;
  req.setEncoding('utf8');
  req.on('data', (c) => {
    if (over) return;
    s += c;
    if (s.length > 8192) { over = true; s = ''; reject(new HttpError(413, '请求过大')); }
  });
  req.on('end', () => {
    try {
      const v = s ? JSON.parse(s) : {};
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      resolve(v);
    } catch { reject(new HttpError(400, '请求格式错误')); }
  });
  req.on('error', reject);
});
const take = (limiter, key, what) => {
  const r = limiter.check(key);
  if (!r.ok) throw new HttpError(429, `${what}太频繁了，请 ${fmtWait(r.retryAfter)}后再试`, { retryAfter: r.retryAfter });
  return r;
};
const fmtWait = (s) => (s >= 90 ? `${Math.ceil(s / 60)} 分钟` : `${s} 秒`);
function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(403, '只有小镇管理员可以这样做');
}
function requireInteraction(req) {
  if (!config.allowInteraction && !isAdmin(req)) throw new HttpError(403, '当前为只读观赏模式');
  if (!llm.stats.enabled) throw new HttpError(503, 'AI 尚未配置');
  if (llm.budgetLeft() <= 0) throw new HttpError(429, '今天小镇的 AI 额度已经用完了，明天再来吧 🌙');
  if (llm.queueSize() > config.maxQueueForUser && !isAdmin(req)) throw new HttpError(503, '居民们正忙着思考，请稍后再试');
}
function remaining(ip, admin) {
  if (admin) return { chat: null, event: null };
  return {
    chat: limits.chat.check(ip, false).remaining,
    event: limits.event.check(ip, false).remaining,
  };
}

// ---------- 路由 ----------
async function handleApi(req, res, url, ip) {
  const p = url.pathname;
  const admin = isAdmin(req);
  const vid = visitorId(req, ip);

  if (req.method === 'GET') {
    if (p === '/api/stream') return openStream(req, res, ip);
    if (p === '/api/me') {
      return json(res, 200, {
        admin, publicMode: config.publicMode, needToken: Boolean(config.adminToken),
        interaction: config.allowInteraction || admin,
        limits: { chatPerHour: config.chatPerHour, eventPerHour: config.eventPerHour, weatherCooldownSec: config.weatherCooldownSec },
        remaining: remaining(ip, admin),
        avatar: town.avatars.mine(vid)?.id || null,
        budget: { total: llm.stats.dailyBudget, left: Number.isFinite(llm.budgetLeft()) ? llm.budgetLeft() : null },
      });
    }
    if (p.startsWith('/api/agent/')) {
      const d = town.agentDetail(decodeURIComponent(p.slice(11)), vid);
      return d ? json(res, 200, d) : json(res, 404, { error: '不存在' });
    }
    if (p === '/api/relations') return json(res, 200, town.relationsGraph());
    if (p === '/api/usage') return json(res, 200, town.usageView());
    if (p === '/api/newspapers') return json(res, 200, town.newspapers);
    if (p === '/api/world/history') return json(res, 200, town.worldHistory().slice(-200));
    if (p === '/api/story') return json(res, 200, { ...town.storyView(ip), admin });
    if (p === '/api/proposals') return json(res, 200, { ...town.proposalsView(ip, admin), admin });
    if (p === '/api/snapshots') { requireAdmin(req); return json(res, 200, listSnapshots(town.dataDir)); }
    if (p === '/api/timelines') { requireAdmin(req); return json(res, 200, registry(DATA)); }
    throw new HttpError(404, '不存在');
  }

  if (req.method !== 'POST') throw new HttpError(405, '不支持的方法');
  const b = await readBody(req);

  if (p === '/api/chat') {
    requireInteraction(req);
    const agent = town.byId[String(b.id)];
    if (!agent) throw new HttpError(404, '居民不存在');
    const mode = b.mode === 'whisper' ? 'whisper' : 'visitor';
    const text = sanitize(b.text, 200);
    if (text.length < 1) throw new HttpError(400, '说点什么吧');
    if (!admin) { take(limits.chatBurst, ip, '说话'); take(limits.chat, ip, '说话'); }
    const m = await moderate(text, 'chat', town.spec.meta.rating);
    if (!m.ok) throw new HttpError(422, m.reason);
    const r = await town.visitorChat(agent.id, text, mode, vid);
    return json(res, 200, { ...r, remaining: remaining(ip, admin) });
  }

  if (p === '/api/event') {
    requireInteraction(req);
    const text = sanitize(b.text, 120);
    if (text.length < 4) throw new HttpError(400, '事件描述太短了');
    const target = b.target === 'all' || !b.target ? 'all' : String(b.target);
    if (target !== 'all' && !town.byId[target]) throw new HttpError(404, '居民不存在');
    if (!admin) {
      // 先检查不扣次数，审核通过后再扣，避免被拒的内容也消耗额度
      const g = limits.eventGlobal.check('all', false);
      if (!g.ok) throw new HttpError(429, `小镇刚刚发生过一件事，请 ${fmtWait(g.retryAfter)}后再发布`);
      const e = limits.event.check(ip, false);
      if (!e.ok) throw new HttpError(429, `每小时最多发布 ${config.eventPerHour} 个事件，请 ${fmtWait(e.retryAfter)}后再试`);
    }
    if (!admin) take(limits.eventAttempt, ip, '尝试发布事件');
    const m = await moderate(text, 'event', town.spec.meta.rating);
    if (!m.ok) throw new HttpError(422, m.reason);
    if (!admin) { take(limits.eventGlobal, 'all', '发布事件'); take(limits.event, ip, '发布事件'); }
    console.log(`[event] ${ip} → ${target}: ${text}`);
    town.godEvent(text, target).catch((e) => console.warn('[event]', e.message));
    return json(res, 200, { ok: true, remaining: remaining(ip, admin) });
  }

  if (p === '/api/control') {
    const out = {};
    if (b.weather != null) {
      const w = String(b.weather);
      if (w !== 'auto' && !Object.hasOwn(town.spec.weather, w)) throw new HttpError(400, '未知天气');
      if (!admin) {
        if (!config.allowInteraction) throw new HttpError(403, '当前为只读观赏模式');
        take(limits.weather, 'all', '改变天气');
      }
      town.setWeather(w);
      out.weather = w;
    }
    if (b.speed != null || b.paused != null || b.skipTo != null) {
      requireAdmin(req);
      if (b.speed != null) {
        const sp = Number(b.speed);
        if (!Number.isFinite(sp)) throw new HttpError(400, '速度无效');
        town.speed = Math.max(0.25, Math.min(30, sp));
      }
      if (b.paused != null) town.paused = Boolean(b.paused);
      if (b.skipTo != null) {
        const target = Number(b.skipTo);
        if (!Number.isFinite(target) || target < 0 || target >= 1440) throw new HttpError(400, '时间无效');
        const m = town.t % 1440;
        town.t += ((target - m + 1440) % 1440) || 1440;
      }
    }
    return json(res, 200, { ok: true, speed: town.speed, paused: town.paused, ...out });
  }

  // 直接应用一条世界操作（仅管理员）。之后的阶段里，AI 的提案经过投票与审批后也走这条路径。
  if (p === '/api/world/op') {
    requireAdmin(req);
    if (!b.op || typeof b.op !== 'string') throw new HttpError(400, '缺少 op');
    const rec = town.applyWorldOp({ op: b.op, args: b.args && typeof b.args === 'object' ? b.args : {} }, { by: 'admin' });
    return json(res, 200, { ok: true, op: rec });
  }

  // 让某位居民立即使用一项能力（仅管理员，用于演示与排查）
  if (p === '/api/ability') {
    requireAdmin(req);
    const agent = town.byId[String(b.id)];
    if (!agent) throw new HttpError(404, '居民不存在');
    const r = useAbility(town, agent, String(b.ability || ''), b.target ? sanitize(b.target, 12) : null, '（管理员指示）');
    if (!r.ok) throw new HttpError(422, r.reason);
    return json(res, 200, { ok: true });
  }

  // 向世界架构师提一个建设建议（访客限流 + 审核；管理员不限）
  if (p === '/api/proposals') {
    requireInteraction(req);
    const text = sanitize(b.intent, 120);
    if (text.length < 4) throw new HttpError(400, '说得再具体一点吧');
    if (!admin) take(limits.proposal, ip, '提建议');
    const m = await moderate(text, 'event', town.spec.meta.rating);
    if (!m.ok) throw new HttpError(422, m.reason);
    const err = town.architect.enqueue(text, admin ? 'admin' : 'visitor');
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  // 管理员直接提交一份世界补丁（仍然经过校验、设定考据与审批流程）
  if (p === '/api/proposals/direct') {
    requireAdmin(req);
    const r = town.proposalSystem.submit({ title: b.title, motive: b.motive, ops: b.ops, construction: b.construction, origin: 'admin', allowed: ADMIN_OPS });
    if (r.error) throw new HttpError(422, r.error);
    return json(res, 200, { ok: true, id: r.proposal.id });
  }

  if (p === '/api/proposals/vote') {
    if (!config.allowInteraction && !admin) throw new HttpError(403, '当前为只读观赏模式');
    if (!admin) take(limits.vote, ip, '投票');
    const err = town.proposalSystem.vote(String(b.id || ''), ip, Boolean(b.yes));
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  // 管理员处理 AI 心愿单
  if (p === '/api/gaps/status') {
    requireAdmin(req);
    const err = town.architect.setGapStatus(String(b.id || ''), String(b.status || ''));
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/proposals/decide') {
    requireAdmin(req);
    const err = town.proposalSystem.decide(String(b.id || ''), Boolean(b.approve), 'admin');
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  // 时光回溯：恢复到某个整点快照（仅管理员，需二次确认；当前存档自动备份）
  if (p === '/api/rollback') {
    requireAdmin(req);
    if (b.confirm !== 'ROLLBACK') throw new HttpError(400, '需要确认');
    const name = String(b.name || '');
    // 先校验快照（不合法时小镇照常运行），再存盘（备份里包含最新进度），最后才停止旧小镇
    if (!/^d\d{3}-\d{2}\.json$/.test(name)) throw new HttpError(400, '快照名称不合法');
    if (!listSnapshots(town.dataDir).some((x) => x.name === name)) throw new HttpError(404, '快照不存在');
    town.save();
    town.stop();
    let bak;
    try { bak = restoreSnapshot(town.dataDir, name); } catch (e) {
      town = makeTown();
      wire(town);
      throw e;
    }
    town = makeTown();
    town.idle = config.idlePauseSec > 0 && clients.size === 0;
    wire(town);
    broadcast('init', town.initPayload());
    console.log(`[rollback] ${ip} 把小镇回溯到 ${b.name}，原存档备份为 ${bak}`);
    return json(res, 200, { ok: true, backup: bak });
  }

  // 时间线分支：从快照（或此刻）分出新时间线，可选择立即切换过去
  if (p === '/api/timelines/fork') {
    requireAdmin(req);
    const fromId = registry(DATA).active;
    if (!b.snapshot) town.save();
    const entry = forkTimeline(DATA, { fromId, snapshot: b.snapshot ? String(b.snapshot) : null, name: sanitize(b.name, 20) });
    if (b.switch !== false) switchTimeline(entry.id, ip);
    return json(res, 200, { ok: true, timeline: entry });
  }

  if (p === '/api/timelines/switch') {
    requireAdmin(req);
    switchTimeline(String(b.id || ''), ip);
    return json(res, 200, { ok: true });
  }

  // 访客化身：现身 / 走动 / 离开（不调用模型）
  if (p === '/api/avatar') {
    if (!config.allowInteraction && !admin) throw new HttpError(403, '当前为只读观赏模式');
    if (!admin) take(limits.avatar, ip, '现身');
    const name = sanitize(b.name, 8);
    const m = await moderate(name, 'chat', town.spec.meta.rating);
    if (!m.ok) throw new HttpError(422, m.reason);
    const v = town.avatars.join(vid, ip, { name, color: b.color });
    return json(res, 200, { ok: true, avatar: { id: v.id, name: v.name, color: v.color } });
  }
  if (p === '/api/avatar/move') {
    town.avatars.move(vid, String(b.location || ''));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/avatar/leave') {
    return json(res, 200, { ok: town.avatars.leave(vid) });
  }

  // 打开 / 关闭异界区域（管理员）
  if (p === '/api/region') {
    requireAdmin(req);
    if (!town.openRegion(String(b.id || ''), b.open !== false)) throw new HttpError(400, '未知区域');
    return json(res, 200, { ok: true, regions: town.regionsView() });
  }

  // 访客投票（每个 IP 每次抉择一票）
  if (p === '/api/vote') {
    if (!config.allowInteraction && !admin) throw new HttpError(403, '当前为只读观赏模式');
    if (!admin) take(limits.vote, ip, '投票');
    const err = town.votes.cast(String(b.id || ''), ip, String(b.option || ''));
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  // 管理员终审
  if (p === '/api/vote/decide') {
    requireAdmin(req);
    const err = town.votes.decide(String(b.id || ''), String(b.option || ''), 'admin');
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  // 手动开启剧情弧（管理员）
  if (p === '/api/arc/start') {
    requireAdmin(req);
    const err = town.arcs.start(String(b.template || ''), 'admin');
    if (err) throw new HttpError(409, err);
    return json(res, 200, { ok: true });
  }

  // 让叙事导演立即做一次决策（管理员）
  if (p === '/api/director/decide') {
    requireAdmin(req);
    if (!llm.stats.enabled) throw new HttpError(503, 'AI 尚未配置');
    if (town.director.deciding) throw new HttpError(409, '导演正在思考');
    const r = await town.director.decide();
    return json(res, 200, { ok: true, ...r });
  }

  if (p === '/api/newspaper') {
    requireAdmin(req);
    if (llm.budgetLeft() <= 0) throw new HttpError(429, '今日 AI 额度已用完');
    return json(res, 200, await town.makeNewspaper());
  }

  if (p === '/api/reset') {
    requireAdmin(req);
    if (b.confirm !== 'RESET') throw new HttpError(400, '需要确认');
    town.stop();
    // 不直接删除：旧存档改名备份，可手动恢复
    const save = path.join(town.dataDir, 'save.json');
    if (fs.existsSync(save)) {
      const bak = path.join(town.dataDir, `save-${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`);
      fs.renameSync(save, bak);
      console.log(`[reset] 旧存档已备份为 ${path.basename(bak)}`);
    }
    town = makeTown();
    town.idle = config.idlePauseSec > 0 && clients.size === 0;
    wire(town);
    broadcast('init', town.initPayload());
    console.log(`[reset] 小镇已由 ${ip} 重置到第一天`);
    return json(res, 200, { ok: true });
  }

  throw new HttpError(404, '不存在');
}

/** 切换到另一条时间线：当前小镇存盘停下，换成目标时间线的小镇 */
function switchTimeline(id, ip) {
  const r = registry(DATA);
  if (!r.list.some((t) => t.id === id)) throw new HttpError(404, '时间线不存在');
  town.save();
  town.stop();
  setActive(DATA, id);
  town = makeTown();
  town.idle = config.idlePauseSec > 0 && clients.size === 0;
  wire(town);
  broadcast('init', town.initPayload());
  console.log(`[timeline] ${ip} 切换到时间线 ${id}`);
}

function openStream(req, res, ip) {
  const n = clientsPerIp.get(ip) || 0;
  if (clients.size >= config.maxClients) throw new HttpError(503, '小镇访客太多了，请稍后再来');
  if (n >= config.maxClientsPerIp) throw new HttpError(429, '同时打开的页面太多了');
  clientsPerIp.set(ip, n + 1);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
  res.write('retry: 3000\n\n');
  res.write(`event: init\ndata: ${JSON.stringify(town.initPayload())}\n\n`);
  clients.add(res);
  if (town.idle) { town.idle = false; console.log('[idle] 有访客，小镇继续运转'); }
  const ka = setInterval(() => res.write(': ka\n\n'), 15000);
  req.on('close', () => {
    clients.delete(res);
    clearInterval(ka);
    const left = (clientsPerIp.get(ip) || 1) - 1;
    left > 0 ? clientsPerIp.set(ip, left) : clientsPerIp.delete(ip);
    lastViewer = Date.now();
  });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的方法' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad path' }); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || rel.split('/').some((seg) => seg.startsWith('.'))) {
    res.writeHead(404, SECURITY_HEADERS); return res.end('not found');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SECURITY_HEADERS); return res.end('not found'); }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, ...SECURITY_HEADERS };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const ip = clientIp(req);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, day: town.day, clients: clients.size, idle: !!town.idle });
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  try {
    const r = limits.api.check(ip);
    if (!r.ok) throw new HttpError(429, '请求太频繁了', { retryAfter: r.retryAfter });
    await handleApi(req, res, url, ip);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) {
      return json(res, e.status, { error: e.message, ...e.extra }, e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {});
    }
    if (e.code === 'BUDGET') return json(res, 429, { error: '今天小镇的 AI 额度已经用完了，明天再来吧 🌙' });
    if (e.status) return json(res, e.status, { error: e.message });
    console.warn('[api]', url.pathname, e.message);
    // 不向客户端暴露上游错误细节
    json(res, 502, { error: '居民们一时没反应过来，请稍后再试' });
  }
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(PORT, HOST, () => {
  const mode = config.publicMode ? `公网模式${config.adminToken ? '（已设置管理员令牌）' : '（⚠️ 未设置 ADMIN_TOKEN，管理功能全部关闭）'}` : '本地模式（所有访问者均为管理员，请勿直接暴露到公网）';
  console.log(`\n  🌸 云溪镇已开放： http://${HOST || 'localhost'}:${PORT}\n  🔐 ${mode}\n  🧠 LLM: ${llm.stats.enabled ? `${llm.stats.model}（快：${llm.stats.models.fast} · 强：${llm.stats.models.smart}）${llm.stats.dailyBudget ? ` · 每日预算 ${llm.stats.dailyBudget.toLocaleString()} tokens` : ''}` : '未配置（使用规则兜底）'}\n`);
});

const shutdown = () => { town.save(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
