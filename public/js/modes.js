// 三种界面模式：🔭 观察（observe）/ 🎬 沉浸（immerse）/ 🎮 游戏（play）
// 模式之间共享画布与数据流，只切换 HUD（body[data-mode] + CSS）、相机策略和按键映射。
import * as UI from './ui.js';
import * as HUD from './hud.js';
import * as Immerse from './immerse.js';
import * as Play from './play.js';

let app;
const $ = (s) => document.querySelector(s);
const MODES = ['observe', 'immerse', 'play'];

export function init(a) {
  app = a;
  app.mode = null;
  let watch = [];
  try { watch = JSON.parse(app.storage.get('town-watch') || '[]'); } catch {}
  app.watch = new Set(Array.isArray(watch) ? watch : []);
  app.toggleWatch = (id) => {
    app.watch.has(id) ? app.watch.delete(id) : app.watch.add(id);
    app.storage.set('town-watch', JSON.stringify([...app.watch]));
  };
  app.setMode = setMode;
  HUD.init(app);
  Immerse.init(app);
  Play.init(app);
  window.addEventListener('keydown', onKey);
}

/** 首次拿到权限后决定进入哪个模式：URL ?mode= > 上次的选择 > 公网默认沉浸、本地默认观察 */
export function start() {
  const q = new URLSearchParams(location.search).get('mode');
  const saved = app.storage.get('town-mode');
  let m = MODES.includes(q) ? q : ['observe', 'immerse'].includes(saved) ? saved : app.perms.publicMode ? 'immerse' : 'observe';
  if (m === 'play' && !app.perms.interaction) m = 'observe';
  setMode(m, { initial: true });
  if (m === 'observe' && !app.storage.get('town-help-seen')) { app.storage.set('town-help-seen', '1'); setTimeout(UI.helpModal, 1200); }
}

export async function setMode(m, { initial = false } = {}) {
  if (!MODES.includes(m) || m === app.mode) return;
  if (m === 'play') {
    if (!app.perms.interaction) return UI.toast('👀 当前是只读观赏模式，不能进入游戏');
    // 还没现身：先填角色卡，取消则留在原模式
    if (!(await Play.ensureAvatar())) return;
  }
  const prev = app.mode;
  if (prev === 'immerse') Immerse.exit();
  if (prev === 'play') Play.exit();
  app.mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll('#dock [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#immerse').hidden = m !== 'immerse';
  $('#play').hidden = m !== 'play';
  if (m !== 'play') app.storage.set('town-mode', m);
  UI.escape(); // 关掉浮层
  if (m === 'immerse') Immerse.enter({ gesture: !initial });
  if (m === 'play') Play.enter();
  if (m === 'observe' && prev) {
    // 从沉浸 / 游戏回来：把当时镜头对着的居民设为选中
    const id = prev === 'immerse' ? Immerse.currentAgent() : null;
    if (id) app.select(id, { focus: false });
  }
}

function onKey(e) {
  if (e.target.closest('input, textarea, select')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'k') { e.preventDefault(); HUD.paletteOpen() ? HUD.closePalette() : HUD.openPalette(); return; }
  if (HUD.paletteOpen()) return;
  if (app.mode === 'immerse') return Immerse.key(e);
  if (app.mode === 'play') return Play.key(e);
  // 观察模式
  if (k === ' ') { e.preventDefault(); UI.togglePause(); }
  if (k === 'Escape') UI.escape();
  if (k === 'f' && app.selected) app.follow = app.selected;
  if (k === 'i' || k === 'I') setMode('immerse');
  if ((k === 'g' || k === 'G') && app.perms.interaction) setMode('play');
  if (k === '=' || k === '+') app.zoomBy(1.15);
  if (k === '-') app.zoomBy(1 / 1.15);
  const sp = { 1: 1, 2: 3, 3: 8, 4: 20 }[k];
  if (sp) UI.setSpeed(sp);
  if (k === 'Tab') {
    e.preventDefault();
    const ids = Object.keys(app.meta);
    const i = ids.indexOf(app.selected);
    app.select(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
  }
}
