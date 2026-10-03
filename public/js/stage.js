// 🎬 演出播放器（docs/design/presentation.md §4）：按顺序执行服务器发来的分镜（镜头、黑边、慢镜、名字卡、横幅、旁白……）。
// 演出只影响画面；观众可以随时跳过（Esc / 「跳过」按钮），也可以在「更多」菜单里选「演出：全部 / 仅重大 / 关闭」。
// 游戏模式里：自己正在战斗时只播字幕类（不抢镜头）；一按方向键就把镜头交还给玩家。
import { TS } from './render.js';

const MODES = ['all', 'major', 'off'];
const LABEL = { all: '全部', major: '仅重大', off: '关闭' };
const CAMERA_STEPS = new Set(['focus', 'letterbox', 'slow']);
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

let app;
const st = { queue: [], cur: null, token: 0, cam: null, camOk: true, restore: null };
const $ = (s) => document.querySelector(s);
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

export function init(a) {
  app = a;
  // 捕获阶段：演出进行中的 Esc 只用来跳过，不再关面板 / 退出游戏模式
  window.addEventListener('keydown', (e) => {
    if (!st.cur || e.target.closest?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') { e.preventDefault(); e.stopImmediatePropagation(); skip(); return; }
    if (app.mode === 'play' && MOVE_KEYS.has(k)) releaseCamera();
  }, true);
  $('#stage-skip').addEventListener('click', skip);
  syncMenu();
}

export const mode = () => (MODES.includes(app.storage.get('town-stage')) ? app.storage.get('town-stage') : 'all');
export function cycleMode() {
  app.storage.set('town-stage', MODES[(MODES.indexOf(mode()) + 1) % MODES.length]);
  syncMenu();
  if (mode() === 'off') skip();
}
function syncMenu() { const b = $('#more-stage'); if (b) b.textContent = `🎬 演出：${LABEL[mode()]}`; }

/** 服务器发来的一段演出 */
export function enqueue(ev) {
  if (mode() === 'off' || (mode() === 'major' && ev.priority !== 'major')) return;
  // 模型写好的旁白（补在刚才那段演出后面）：直接叠成字幕，不排队
  if (ev.follow) {
    const s = (ev.steps || [])[0];
    if (s?.text) (app.renderer.stageUI ||= {}).narr = { text: s.text, born: now(), ms: s.ms || 2400 };
    return;
  }
  if (st.queue.length >= 3) st.queue.shift(); // 积压太多时丢掉最旧的，免得一直在补播
  st.queue.push(ev);
  if (!st.cur) next();
}

/** 我正在战斗（游戏模式）：不抢镜头 */
function fighting() {
  const me = app.perms?.avatar;
  return app.mode === 'play' && me && (app.snap?.fights || []).some((F) => F.fighters.some((f) => f.kind === 'avatar' && f.id === me));
}

async function next() {
  const ev = st.queue.shift();
  st.cur = ev || null;
  if (!ev) return;
  const token = ++st.token;
  const r = app.renderer;
  st.camOk = app.mode !== 'immerse' && !fighting();
  // 演出在别的地图上：重大演出临时切过去（结束后切回），普通演出只播字幕
  if (st.camOk && (ev.region || 'town') !== app.view) {
    if (ev.priority === 'major' && app.regionsOpen?.[ev.region]?.open !== false && app.regionWorlds?.[ev.region]) {
      st.restore = { view: app.view, cam: { ...app.cam } };
      app.setView(ev.region, { center: false });
    } else st.camOk = false;
  }
  if (st.camOk && !st.restore) st.restore = { view: app.view, cam: { ...app.cam }, follow: app.follow };
  $('#stage-skip').hidden = false;
  for (const step of ev.steps || []) {
    if (token !== st.token) return;
    await run(step, ev);
  }
  if (token === st.token) finish();
}

/** 执行一步（返回时这一步结束） */
async function run(s, ev) {
  const r = app.renderer;
  const ms = typeof s.ms === 'number' ? s.ms : { focus: 900, slow: 1500, card: 1800, banner: 1500, narrate: 2200, reveal: 3000, wait: 500 }[s.do] || 0;
  if (CAMERA_STEPS.has(s.do) && !st.camOk) return;
  const ui = (r.stageUI ||= {});
  switch (s.do) {
    case 'focus': {
      if ((s.target?.region || 'town') !== app.view) return;
      st.cam = { target: s.target, zoom: s.zoom ?? 1.6, from: { x: app.cam.x, y: app.cam.y, zoom: app.cam.zoom }, t0: now(), ms: Math.max(200, ms) };
      app.follow = null;
      return sleep(ms);
    }
    case 'letterbox': ui.letterbox = Boolean(s.on); return sleep(250);
    case 'slow': r.timeScale = s.scale ?? 0.4; await sleep(ms); r.timeScale = 1; return;
    case 'card': ui.card = { name: s.name, title: s.title || '', emoji: s.emoji || '', color: s.color || '#ffd166', born: now(), ms }; return sleep(ms);
    case 'banner': r.banner = { text: s.text, born: r.time, color: s.color }; return sleep(ms);
    case 'narrate': ui.narr = { text: s.text, born: now(), ms }; return sleep(ms);
    case 'flash': ui.flash = { color: s.color || '#ffffff', born: now() }; return sleep(120);
    case 'shake': r.shake = Math.max(r.shake || 0, s.power ?? 6); return;
    case 'vfx': if ((s.target?.region || 'town') === app.view) r.addVfx({ preset: s.preset, x: s.target.x, y: s.target.y, color: s.color || null, radius: s.radius ?? 2, region: s.target.region }); return;
    case 'reveal': r.revealRegion(s.text); return sleep(ms);
    case 'sound': r.sfx?.(s.sfx); return;
    case 'wait': return sleep(ms);
  }
}

function releaseCamera() { st.cam = null; st.camOk = false; if (app.renderer.stageUI) app.renderer.stageUI.letterbox = false; app.renderer.timeScale = 1; }

function finish() {
  const r = app.renderer;
  if (r.stageUI) r.stageUI.letterbox = false;
  r.timeScale = 1;
  st.cam = null;
  // 切回原来的地图 / 镜头位置（游戏模式里镜头本来就跟着自己）
  const back = st.restore;
  st.restore = null;
  if (back) {
    if (back.view !== app.view) app.setView(back.view, { center: false });
    if (app.mode === 'observe') { app.cam.x = back.cam.x; app.cam.y = back.cam.y; app.cam.zoom = back.cam.zoom; app.follow = back.follow ?? app.follow; }
  }
  $('#stage-skip').hidden = true;
  st.cur = null;
  next();
}

export function skip() {
  if (!st.cur) return;
  st.token++;
  const ui = app.renderer.stageUI || {};
  ui.card = null; ui.narr = null;
  st.queue = [];
  finish();
}

export const active = () => Boolean(st.cur);

/** 主循环每帧：演出接管镜头时返回 true（调用方不再跑跟随 / 游戏模式的镜头） */
export function camera() {
  const c = st.cam;
  if (!c) return false;
  const t = c.target;
  let x = t.x, y = t.y, zoom = c.zoom;
  // 跟着单位实时移动
  const live = t.kind === 'agent' ? app.renderer.S?.agentMap?.[t.id] : t.kind === 'threat' ? (app.renderer.S?.dark?.threats || []).find((v) => v.id === t.id) : t.kind === 'avatar' ? (app.renderer.S?.avatars || []).find((v) => v.id === t.id) : null;
  if (live) { x = live.dx ?? live.x; y = live.dy ?? live.y; }
  if (t.whole) { const w = app.regionWorlds?.[t.region] || app.renderer.world; if (w) zoom = Math.min(app.renderer.vw / (w.W * TS), app.renderer.vh / (w.H * TS)) * 1.05; }
  const k = ease(Math.min(1, (now() - c.t0) / c.ms));
  const tx = x * TS + TS / 2, ty = y * TS + TS / 2 - (t.whole ? 0 : TS * 0.5);
  app.cam.x = c.from.x + (tx - c.from.x) * k;
  app.cam.y = c.from.y + (ty - c.from.y) * k;
  app.cam.zoom = c.from.zoom + (zoom - c.from.zoom) * k;
  return true;
}
