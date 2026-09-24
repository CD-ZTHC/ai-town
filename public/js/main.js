// 前端入口：实时数据流、相机与输入、渲染循环
import { Renderer, TS } from './render.js';
import * as UI from './ui.js';

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
function visitorId() {
  let v = storage.get('town-vid');
  if (!v) { v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''); storage.set('town-vid', v); }
  return v;
}

const canvas = document.getElementById('world');
const minimap = document.getElementById('minimap');
const renderer = new Renderer(canvas, minimap);

export const app = {
  ready: false,
  world: null,
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
  perms: { admin: false, interaction: true, publicMode: false },
  // 相对路径：支持部署在子路径下（例如 https://example.com/town/）
  api: async (path, body) => {
    const headers = { 'X-Visitor': visitorId() };
    const token = storage.get('town-admin');
    if (token) headers['X-Admin-Token'] = token;
    const opts = body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path.replace(/^\//, ''), opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || `请求失败（${res.status}）`); e.status = res.status; throw e; }
    return data;
  },
  async refreshPerms() {
    try { app.perms = await app.api('/api/me'); } catch {}
    UI.applyPerms();
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
  agentWorldPos(id) {
    const a = app.snap?.agents.find((x) => x.id === id);
    if (!a) return null;
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

// ---------- 数据流 ----------
function connect() {
  const es = new EventSource('api/stream');
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    const first = !app.world;
    app.world = d.world;
    app.weathers = d.weathers;
    app.spec = d.spec;
    app.meta = Object.fromEntries(d.agents.map((a) => [a.id, a]));
    app.logs = d.logs;
    app.newspapers = d.newspapers;
    app.board = d.board;
    app.llm = d.llm;
    app.snap = d.state;
    app.disp = {};
    if (first) {
      renderer.setWorld(d.world);
    }
    renderer.setAgents(d.agents);
    renderer.setCreatureTypes(d.spec?.creatures);
    for (const a of d.agents) a.portrait = renderer.portraits[a.id];
    UI.init(app, first);
    app.refreshPerms();
    if (first) {
      resize();
      app.cam.zoom = Math.max(0.8, Math.min(1.7, window.innerWidth / (34 * TS)));
      app.ready = true;
      setTimeout(() => document.getElementById('loading').classList.add('done'), 400);
    }
  });
  es.addEventListener('tick', (e) => { app.snap = JSON.parse(e.data); });
  es.addEventListener('log', (e) => UI.onLog(JSON.parse(e.data)));
  es.addEventListener('agent', (e) => UI.onAgentChanged(JSON.parse(e.data).id));
  es.addEventListener('newspaper', (e) => UI.onNewspaper(JSON.parse(e.data)));
  es.addEventListener('vfx', (e) => renderer.addVfx(JSON.parse(e.data)));
  // 角色登场 / 离场：重建精灵与名册
  es.addEventListener('agents', (e) => {
    const list = JSON.parse(e.data);
    renderer.setAgents(list);
    for (const a of list) a.portrait = renderer.portraits[a.id];
    app.meta = Object.fromEntries(list.map((a) => [a.id, a]));
    UI.onAgents();
  });
  es.addEventListener('story', () => UI.onStory());
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

// ---------- 输入 ----------
const pointers = new Map();
let drag = null, pinch = null;
canvas.addEventListener('pointerdown', (e) => {
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
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; canvas.classList.add('dragging'); app.follow = null; }
    if (drag.moved) {
      app.cam.x = drag.cx - dx / app.cam.zoom;
      app.cam.y = drag.cy - dy / app.cam.zoom;
      clampCam();
    }
    return;
  }
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
    if (id) app.select(id);
  }
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { app.hover = null; UI.tooltip(null); });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
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

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  keys.add(e.key.toLowerCase());
  if (e.key === ' ') { e.preventDefault(); UI.togglePause(); }
  if (e.key === 'Escape') UI.escape();
  if (e.key === 'f' && app.selected) app.follow = app.selected;
  if (e.key === '=' || e.key === '+') zoomAt(innerWidth / 2, innerHeight / 2, 1.15);
  if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.15);
  const sp = { 1: 1, 2: 3, 3: 8, 4: 20 }[e.key];
  if (sp) UI.setSpeed(sp);
  if (e.key === 'Tab') {
    e.preventDefault();
    const ids = Object.keys(app.meta);
    const i = ids.indexOf(app.selected);
    app.select(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ---------- 主循环 ----------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (app.ready && app.snap) {
    const s = app.snap;
    // 键盘平移
    const pan = 600 * dt / app.cam.zoom;
    if (keys.has('a') || keys.has('arrowleft')) { app.cam.x -= pan; app.follow = null; }
    if (keys.has('d') || keys.has('arrowright')) { app.cam.x += pan; app.follow = null; }
    if (keys.has('w') || keys.has('arrowup')) { app.cam.y -= pan; app.follow = null; }
    if (keys.has('s') || keys.has('arrowdown')) { app.cam.y += pan; app.follow = null; }

    // 平滑角色位置
    // 角色登场 / 离场的瞬间，快照与角色信息可能差一帧：只画两边都有的角色
    const agents = s.agents.filter((a) => app.meta[a.id] && renderer.meta?.[a.id]).map((a) => {
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
    const creatures = (s.creatures || []).map((c) => {
      let d = app.cdisp[c.id];
      if (!d || Math.hypot(c.x - d.dx, c.y - d.dy) > 4) d = app.cdisp[c.id] = { dx: c.x, dy: c.y };
      const k = 1 - Math.exp(-dt * 10);
      d.dx += (c.x - d.dx) * k; d.dy += (c.y - d.dy) * k;
      return { ...c, dx: d.dx, dy: d.dy };
    });
    const agentMap = Object.fromEntries(agents.map((a) => [a.id, a]));
    const occupancy = {};
    for (const a of agents) if (a.inside) (occupancy[a.inside] ||= []).push(a.id);

    if (app.follow) {
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
      cam: app.cam, t: tt, day, weather: winfo.render?.base || weatherId, weatherId, weatherTint: winfo.render?.tint ? winfo.render : null,
      agents, agentMap, occupancy, convos: s.convos, entities: s.entities || [], creatures,
      selected: app.selected, hover: app.hover, boardCount: app.board.length,
      festival: app.forceFestival || activeEvents(day, minute).some((e) => e.vfx === 'festival_lanterns'),
    };
    renderer.frame(S, dt);
    UI.frame(S, dt);
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
