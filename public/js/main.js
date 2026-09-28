// 前端入口：实时数据流、相机与输入、渲染循环
import { Renderer, TS } from './render.js';
import * as UI from './ui.js';
import * as Modes from './modes.js';
import * as Immerse from './immerse.js';
import * as Play from './play.js';
import { requireLogin } from './ui/auth.js';

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const canvas = document.getElementById('world');
const minimap = document.getElementById('minimap');
const renderer = new Renderer(canvas, minimap);

export const app = {
  ready: false,
  world: null,
  view: 'town', // 当前查看的区域
  regionWorlds: {},
  regionsOpen: {},
  avatars: [],
  meta: {},
  snap: null,
  disp: {},
  cdisp: {},
  logs: [],
  newspapers: [],
  board: [],
  llm: null,
  cam: { x: 22.5 * TS, y: 22 * TS, zoom: 1.3, tx: null, ty: null },
  follow: null,
  selected: null,
  hover: null,
  forceFestival: false,
  renderer,
  perms: { admin: false, interaction: true, canTry: true, publicMode: false },
  // 相对路径：支持部署在子路径下（例如 https://example.com/town/）
  api: async (path, body, { retried = false } = {}) => {
    const headers = {};
    const token = storage.get('town-admin');
    if (token) headers['X-Admin-Token'] = token;
    const opts = body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path.replace(/^\//, ''), opts);
    let data = {};
    try { data = await res.json(); } catch {}
    // 游客点了互动入口：弹出登录框，登录成功后自动继续刚才的操作
    if (res.status === 401 && data.login && !retried) {
      await requireLogin(data.error);
      return app.api(path, body, { retried: true });
    }
    if (!res.ok) { const e = new Error(data.error || `请求失败（${res.status}）`); e.status = res.status; throw e; }
    return data;
  },
  async refreshPerms() {
    try { app.perms = await app.api('/api/me'); } catch {}
    // 能不能看到互动入口：能互动，或者登录之后就能互动（游客点下去会弹出登录框）
    app.perms.canTry = Boolean(app.perms.interaction || app.perms.loginToInteract);
    UI.applyPerms();
    // owner：有待终审的决策时提醒（每次打开页面提醒一次）
    if (app.perms.reviewer === 'owner' && app.perms.pendingDecisions && !app.remindedDecisions) {
      app.remindedDecisions = true;
      UI.toast(`🔔 有 ${app.perms.pendingDecisions} 项决策等你终审（在「进化 → 决策队列」里；超时后由 AI 裁决官决定）`, 8000);
    }
  },
  select(id, { focus = true } = {}) {
    app.selected = id;
    if (id && focus) app.follow = id;
    UI.openInspector(id);
    UI.refreshRoster();
  },
  focusAgent(id) {
    app.follow = id;
  },
  /** 切换查看的区域（小镇 / 暗月界） */
  setView(id, { center = true } = {}) {
    const w = app.regionWorlds[id];
    if (!w || app.view === id) return;
    app.view = id;
    app.world = w;
    renderer.setWorld(w);
    app.disp = {}; app.cdisp = {}; app.vdisp = {};
    if (center && w.gate) { app.cam.x = w.gate.x * TS; app.cam.y = w.gate.y * TS; }
    UI.onRegions?.();
  },
  agentWorldPos(id) {
    const a = app.snap?.agents.find((x) => x.id === id);
    if (!a) return null;
    // 跟随的人去了别的区域：画面跟过去
    if ((a.region || 'town') !== app.view) { app.setView(a.region || 'town', { center: false }); return null; }
    if (a.inside) {
      const b = app.world.buildings.find((b) => b.id === a.inside);
      return [(b.x + b.w / 2) * TS, (b.y + b.h / 2) * TS];
    }
    const d = app.disp[id] || a;
    return [(d.dx ?? a.x) * TS + TS / 2, (d.dy ?? a.y) * TS + TS / 2];
  },
};
window.app = app;

// 当前正在进行的日历事件（节日等），与服务端 kernel/spec.js 的 activeEvents 保持一致
const hm = (s) => { const m = /(\d{1,2})[:：](\d{2})/.exec(String(s)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function activeEvents(day, minute) {
  return (app.spec?.calendar.events || []).filter((e) => e.day === day && minute >= (hm(e.from) ?? 0) && minute < (e.to ? hm(e.to) : 1440));
}

/** 世界暂停的提示条：普通访客只看到「暂时不可用」；主人和管理员可以在「我的世界」或管理面板里查看原因并修复 */
function showHalt(info) {
  let el = document.getElementById('halt-bar');
  if (!info) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'halt-bar';
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:40;max-width:min(560px,92vw);padding:10px 16px;border-radius:12px;background:rgba(60,20,24,.92);border:1px solid rgba(255,122,122,.5);color:#ffd9d9;font-size:14px;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.4)';
    document.body.appendChild(el);
  }
  el.innerHTML = `⛔ ${String(info.text || '这个世界的 AI 服务暂时不可用，世界暂停了').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}<div style="font-size:12px;opacity:.8">世界的主人修好模型服务后会自动恢复。是主人？去 <a href="../../mine.html" style="color:#ffb86b">我的世界</a> 查看原因。</div>`;
}

// ---------- 数据流 ----------
function connect() {
  const es = new EventSource('api/stream');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    const first = !app.world;
    app.regionWorlds = { town: d.world, ...(d.regions || {}) };
    app.regionsOpen = d.regionsOpen || {};
    if (!app.regionWorlds[app.view] || (app.view !== 'town' && !app.regionsOpen[app.view]?.open)) app.view = 'town';
    const viewChanged = app.world && app.world.id !== app.view;
    app.world = app.regionWorlds[app.view];
    app.weathers = d.weathers;
    app.spec = d.spec;
    app.meta = Object.fromEntries(d.agents.map((a) => [a.id, a]));
    app.logs = d.logs;
    app.newspapers = d.newspapers;
    app.board = d.board;
    app.llm = d.llm;
    app.snap = d.state;
    app.disp = {};
    if (first || viewChanged || app.view === 'town') renderer.setWorld(app.world);
    renderer.setAgents(d.agents);
    renderer.setCreatureTypes(d.spec?.creatures);
    for (const a of d.agents) a.portrait = renderer.portraits[a.id];
    UI.init(app, first);
    showHalt(d.state?.halted || null);
    const perms = app.refreshPerms();
    if (first) {
      perms.then(() => Modes.start());
      resize();
      app.cam.zoom = Math.max(0.8, Math.min(1.7, window.innerWidth / (34 * TS)));
      app.ready = true;
      setTimeout(() => document.getElementById('loading').classList.add('done'), 400);
    }
  });
  es.addEventListener('tick', (e) => { app.snap = JSON.parse(e.data); });
  // 世界自带的模型服务出了致命错误：世界暂停，修好后自动恢复（world-llm 设计 §5.4）
  es.addEventListener('halt', (e) => showHalt(JSON.parse(e.data || '{}')));
  es.addEventListener('resume', () => { showHalt(null); UI.toast('✅ AI 服务恢复了，世界继续运转', 5000); });
  es.addEventListener('log', (e) => UI.onLog(JSON.parse(e.data)));
  es.addEventListener('agent', (e) => UI.onAgentChanged(JSON.parse(e.data).id));
  es.addEventListener('newspaper', (e) => { const p = JSON.parse(e.data); UI.onNewspaper(p); Immerse.onNewspaper(p); });
  // 管理员在面板里重启服务器：几秒后 EventSource 会自动重连
  es.addEventListener('restart', () => UI.toast('🔄 服务器正在重启，几秒后自动重连…', 6000));
  // 世界被下架、归档或卸载：停止重连，给出说明
  es.addEventListener('closed', (e) => {
    const { reason } = JSON.parse(e.data || '{}');
    if (/长时间无人观看|腾出位置|服务器停止|世界包已|设置已修改/.test(reason || '')) return; // 暂时卸载：EventSource 会自动重连并重新加载
    es.close();
    UI.worldClosed(reason);
  });
  es.addEventListener('vfx', (e) => { const v = JSON.parse(e.data); if ((v.region || 'town') === app.view) renderer.addVfx(v); });
  es.addEventListener('regions', (e) => {
    app.regionsOpen = JSON.parse(e.data);
    if (app.view !== 'town' && !app.regionsOpen[app.view]?.open) app.setView('town');
    UI.onRegions?.();
  });
  // 角色登场 / 离场：重建精灵与名册
  es.addEventListener('agents', (e) => {
    const list = JSON.parse(e.data);
    Play.onAgents?.();
    renderer.setAgents(list);
    for (const a of list) a.portrait = renderer.portraits[a.id];
    app.meta = Object.fromEntries(list.map((a) => [a.id, a]));
    UI.onAgents();
  });
  es.addEventListener('story', () => UI.onStory());
  // 每游戏日平均用量（每分钟刷新一次）
  const usage = () => app.api('/api/usage').then((u) => { app.usageAvg = u.avgPerDay; app.metrics = u.metrics; UI.updateBrain(); }).catch(() => {});
  usage();
  if (!app.usageTimer) app.usageTimer = setInterval(usage, 60_000);
  // 新建筑落地：重建地图与静态图层
  es.addEventListener('worldmap', (e) => {
    const w = JSON.parse(e.data);
    app.regionWorlds.town = w;
    // 地图向西 / 向北扩展：原来的一切整体平移，镜头跟着移，画面不跳
    if (w.shift && app.view === 'town') { app.cam.x += w.shift.dx * TS; app.cam.y += w.shift.dy * TS; for (const m of [app.disp, app.cdisp, app.vdisp || {}]) for (const d of Object.values(m)) { if (d.dx != null) { d.dx += w.shift.dx; d.dy += w.shift.dy; } } }
    if (app.view === 'town') { app.world = w; renderer.setWorld(app.world); }
  });
  es.addEventListener('proposals', () => UI.onProposals());
  es.addEventListener('evolution', () => UI.onEvolution());
  es.addEventListener('decisions', () => { UI.onEvolution(); UI.onProposals(); });
  es.addEventListener('world', (e) => {
    const w = JSON.parse(e.data);
    app.spec = w.spec;
    app.weathers = w.spec.weather;
    renderer.setCreatureTypes(w.spec.creatures);
    UI.onWorld(w);
  });
  es.addEventListener('llm', (e) => { app.llm = JSON.parse(e.data); UI.updateBrain(); });
  es.onerror = () => UI.toast('⚠️ 与小镇的连接中断，正在重连…', 2500);
}
connect();

// ---------- 画布尺寸 ----------
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
}
window.addEventListener('resize', resize);

// ---------- 相机 ----------
function clampCam() {
  if (!app.world) return;
  const c = app.cam;
  const W = app.world.W * TS, H = app.world.H * TS;
  const hw = window.innerWidth / 2 / c.zoom, hh = window.innerHeight / 2 / c.zoom;
  c.x = hw * 2 > W ? W / 2 : Math.max(hw - 60, Math.min(W - hw + 60, c.x));
  c.y = hh * 2 > H ? H / 2 : Math.max(hh - 120, Math.min(H - hh + 60, c.y));
}
function zoomAt(sx, sy, factor) {
  const c = app.cam;
  const [wx, wy] = renderer.screenToWorld(sx, sy, c);
  c.zoom = Math.max(0.45, Math.min(3.2, c.zoom * factor));
  c.x = wx - (sx - window.innerWidth / 2) / c.zoom;
  c.y = wy - (sy - window.innerHeight / 2) / c.zoom;
  clampCam();
}

app.zoomBy = (f) => zoomAt(innerWidth / 2, innerHeight / 2, f);
app.clampCam = clampCam;

// ---------- 输入 ----------
const pointers = new Map();
let drag = null, pinch = null;
canvas.addEventListener('pointerdown', (e) => {
  if (app.mode === 'immerse') { Immerse.poke(); return; }
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: app.cam.zoom };
    drag = null;
  } else {
    drag = { x: e.clientX, y: e.clientY, cx: app.cam.x, cy: app.cam.y, moved: false };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const target = Math.max(0.45, Math.min(3.2, pinch.zoom * (d / pinch.d)));
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, target / app.cam.zoom);
    return;
  }
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; canvas.classList.add('dragging'); app.follow = null; if (app.mode === 'play') Play.free(); }
    if (drag.moved) {
      app.cam.x = drag.cx - dx / app.cam.zoom;
      app.cam.y = drag.cy - dy / app.cam.zoom;
      clampCam();
    }
    return;
  }
  if (app.mode === 'immerse') { Immerse.poke(); return; }
  const id = renderer.hitTest(e.clientX, e.clientY);
  app.hover = id;
  canvas.classList.toggle('pointer', !!id);
  UI.tooltip(id, e.clientX, e.clientY);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && !drag.moved && e.type === 'pointerup') {
    const id = renderer.hitTest(e.clientX, e.clientY);
    if (app.mode === 'play') Play.tap(e.clientX, e.clientY, id);
    else if (id) app.select(id);
  }
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { app.hover = null; UI.tooltip(null); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (app.mode === 'immerse') return;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// 小地图导航
let miniDrag = false;
const miniGo = (e) => {
  const r = minimap.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * app.world.W * TS;
  const y = ((e.clientY - r.top) / r.height) * app.world.H * TS;
  app.cam.x = x; app.cam.y = y; app.follow = null; clampCam();
};
minimap.addEventListener('pointerdown', (e) => { miniDrag = true; minimap.setPointerCapture(e.pointerId); miniGo(e); });
minimap.addEventListener('pointermove', (e) => miniDrag && miniGo(e));
minimap.addEventListener('pointerup', () => { miniDrag = false; });

// 按键映射见 modes.js；这里只记录按住的方向键，用于观察模式下平移镜头
const keys = new Set();
window.addEventListener('keydown', (e) => { if (!e.target.closest('input, textarea, select')) keys.add(e.key.toLowerCase()); });
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

// 画布上的气泡等叠加层要避开的界面区域（顶栏、名册、检查器）
const visible = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
function safeInsets() {
  const s = { l: 8, t: 8, r: 8, b: 8 };
  for (const el of document.querySelectorAll('[data-safe]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect(), gap = 8;
    if (r.width === 0 || r.height === 0) continue;
    const side = el.dataset.safe;
    if (side === 't') s.t = Math.max(s.t, r.bottom + gap);
    if (side === 'b') s.b = Math.max(s.b, innerHeight - r.top + gap);
    if (side === 'l') s.l = Math.max(s.l, r.right + gap);
    if (side === 'r') s.r = Math.max(s.r, innerWidth - r.left + gap);
  }
  return s;
}

// 界面色温随时辰变化：清晨偏粉、白天偏暖、黄昏偏橙、夜晚偏蓝紫；暗月界固定为紫色
function uiTint(minute) {
  if (app.view !== 'town') return '#b58cff';
  const h = minute / 60;
  return h < 5 || h >= 20 ? '#8f9bff' : h < 8 ? '#ff9fb5' : h < 17 ? '#ffd28a' : '#ff9a5a';
}

// ---------- 主循环 ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (app.ready && app.snap) {
    const s = app.snap;
    // 键盘平移（仅观察模式；游戏模式下方向键用来走路）
    const pan = app.mode === 'observe' ? 600 * dt / app.cam.zoom : 0;
    if (!pan) keys.clear();
    if (keys.has('a') || keys.has('arrowleft')) { app.cam.x -= pan; app.follow = null; }
    if (keys.has('d') || keys.has('arrowright')) { app.cam.x += pan; app.follow = null; }
    if (keys.has('w') || keys.has('arrowup')) { app.cam.y -= pan; app.follow = null; }
    if (keys.has('s') || keys.has('arrowdown')) { app.cam.y += pan; app.follow = null; }

    // 平滑角色位置
    // 角色登场 / 离场的瞬间，快照与角色信息可能差一帧：只画两边都有的角色
    const here = (x) => (x.region || 'town') === app.view;
    const agents = s.agents.filter((a) => app.meta[a.id] && renderer.meta?.[a.id] && here(a)).map((a) => {
      let d = app.disp[a.id];
      if (!d) d = app.disp[a.id] = { dx: a.x, dy: a.y, walkPhase: 0 };
      const dist = Math.hypot(a.x - d.dx, a.y - d.dy);
      if (dist > 4 || a.inside) { d.dx = a.x; d.dy = a.y; }
      else {
        const k = 1 - Math.exp(-dt * 12);
        const nx = d.dx + (a.x - d.dx) * k, ny = d.dy + (a.y - d.dy) * k;
        d.walkPhase += Math.hypot(nx - d.dx, ny - d.dy) * 2.2;
        d.dx = nx; d.dy = ny;
      }
      const moving = a.moving || dist > 0.05;
      if (!moving) d.walkPhase = 0;
      return { ...a, dx: d.dx, dy: d.dy, walkPhase: d.walkPhase, moving, speaking: !!(a.convo && a.bubble && a.bubble.kind === 'say') };
    });
    // 异界生物也做平滑插值
    const creatures = (s.creatures || []).filter(here).map((c) => {
      let d = app.cdisp[c.id];
      if (!d || Math.hypot(c.x - d.dx, c.y - d.dy) > 4) d = app.cdisp[c.id] = { dx: c.x, dy: c.y };
      const k = 1 - Math.exp(-dt * 10);
      d.dx += (c.x - d.dx) * k; d.dy += (c.y - d.dy) * k;
      return { ...c, dx: d.dx, dy: d.dy };
    });
    // 黑暗叙事：威胁（平滑插值）、区域、墓碑
    const dk = s.dark;
    const dark = dk ? {
      threats: (dk.threats || []).filter(here).map((th) => {
        let d = (app.tdisp ||= {})[th.id];
        if (!d || Math.hypot(th.x - d.dx, th.y - d.dy) > 4) d = app.tdisp[th.id] = { dx: th.x, dy: th.y };
        const k = 1 - Math.exp(-dt * 8);
        d.dx += (th.x - d.dx) * k; d.dy += (th.y - d.dy) * k;
        return { ...th, dx: d.dx, dy: d.dy };
      }),
      zones: (dk.zones || []).filter(here), graves: (dk.graves || []).filter(here), crowd: app.view === 'town' ? dk.crowd || null : null,
    } : null;
    // 访客化身
    const mine = app.perms.avatar;
    const avatars = (s.avatars || []).filter(here).map((v) => {
      const d = (app.vdisp ||= {})[v.id] ||= { dx: v.x, dy: v.y };
      if (Math.hypot(v.x - d.dx, v.y - d.dy) > 4) { d.dx = v.x; d.dy = v.y; }
      const k = 1 - Math.exp(-dt * 10);
      d.dx += (v.x - d.dx) * k; d.dy += (v.y - d.dy) * k;
      return { ...v, dx: d.dx, dy: d.dy, mine: v.id === mine };
    });
    app.avatars = s.avatars || [];
    const agentMap = Object.fromEntries(agents.map((a) => [a.id, a]));
    const occupancy = {};
    for (const a of agents) if (a.inside) (occupancy[a.inside] ||= []).push(a.id);

    if (app.mode === 'immerse') Immerse.camera(dt, agentMap);
    else if (app.mode === 'play') Play.camera(dt, avatars);
    else if (app.follow) {
      const p = app.agentWorldPos(app.follow);
      if (p) {
        const k = 1 - Math.exp(-dt * 4);
        app.cam.x += (p[0] - app.cam.x) * k;
        app.cam.y += (p[1] - app.cam.y) * k;
      }
    }
    clampCam();
    const tt = app.debugT ?? s.t; // 调试：可在控制台设置 app.debugT / app.debugWeather 预览
    const day = Math.floor(tt / 1440) + 1;
    const minute = tt % 1440;
    // 世界规格里新增的天气用已有的天气效果（render.base）加一层色调来表现
    const weatherId = app.debugWeather ?? s.weather;
    const winfo = app.weathers[weatherId] || {};
    const S = {
      // 暗月界没有小镇的天气
      cam: app.cam, t: tt, day, region: app.view,
      weather: app.view === 'town' ? winfo.render?.base || weatherId : 'sunny', weatherId: app.view === 'town' ? weatherId : 'sunny', weatherTint: app.view === 'town' && winfo.render?.tint ? winfo.render : null,
      overlay: (s.overlay || []).filter((o) => (o.region || 'town') === app.view),
      agents, agentMap, occupancy, convos: s.convos, entities: (s.entities || []).filter((e) => e.kind === 'portal' ? app.view === 'town' : here(e)), creatures, avatars, dark,
      selected: app.selected, hover: app.hover, boardCount: app.board.length,
      festival: app.view === 'town' && ((app.forceFestival && app.spec?.calendar.events?.some((e) => e.vfx === 'festival_lanterns')) || activeEvents(day, minute).some((e) => e.vfx === 'festival_lanterns')),
      mode: app.mode, subtitles: app.mode === 'immerse' && Immerse.subsOn(),
      play: app.mode === 'play' ? Play.state() : null,
    };
    if (now - (app.safeT || 0) > 300) { app.safeT = now; renderer.safe = safeInsets(); }
    if (now - (app.tintT || 0) > 1000) { app.tintT = now; document.body.style.setProperty('--tint', uiTint(minute)); }
    renderer.frame(S, dt);
    UI.frame(S, dt);
    if (app.mode === 'immerse') Immerse.frame(S, dt);
    if (app.mode === 'play') Play.frame(S, dt);
    Sound.update(S);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- 环境音（WebAudio 程序化生成） ----------
export const Sound = {
  on: false,
  ctx: null,
  toggle() {
    this.on = !this.on;
    if (this.on && !this.ctx) this.init();
    if (this.ctx) this.ctx[this.on ? 'resume' : 'suspend']();
    return this.on;
  },
  init() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(ctx.destination);
    // 雨声：滤波白噪声
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    noise.connect(lp).connect(this.rainGain).connect(this.master); noise.start();
    // 溪水/风：低频噪声
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.05;
    const n2 = ctx.createBufferSource(); n2.buffer = buf; n2.loop = true; n2.playbackRate.value = 0.5;
    n2.connect(bp).connect(this.windGain).connect(this.master); n2.start();
    this.nextChirp = 0;
  },
  chirp(night) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g).connect(this.master);
    if (night) {
      // 蟋蟀
      o.type = 'square'; o.frequency.value = 4200 + Math.random() * 400;
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 4; i++) { g.gain.setValueAtTime(0.012, t + i * 0.06); g.gain.setValueAtTime(0, t + i * 0.06 + 0.03); }
      o.start(t); o.stop(t + 0.3);
    } else {
      // 鸟鸣
      o.type = 'sine';
      const f = 2200 + Math.random() * 1800;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * (1.3 + Math.random() * 0.5), t + 0.08);
      o.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.16);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.04, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    }
  },
  update(S) {
    if (!this.on || !this.ctx) return;
    const rain = S.weather === 'storm' ? 0.35 : S.weather === 'rain' ? 0.22 : 0;
    this.rainGain.gain.setTargetAtTime(rain, this.ctx.currentTime, 0.8);
    this.windGain.gain.setTargetAtTime(S.weather === 'storm' ? 0.12 : 0.04, this.ctx.currentTime, 1);
    const h = (S.t % 1440) / 60;
    const night = h < 5 || h > 20;
    if (this.ctx.currentTime > this.nextChirp) {
      if (!rain) this.chirp(night);
      this.nextChirp = this.ctx.currentTime + (night ? 0.8 + Math.random() * 2 : 1 + Math.random() * 4);
    }
  },
};
app.sound = Sound;
app.storage = storage;
// 模式、界面外壳与按键（依赖上面的 app.sound / app.storage）
Modes.init(app);
