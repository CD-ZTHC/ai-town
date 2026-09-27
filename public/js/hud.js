// 观察模式的界面外壳：顶栏溢出菜单、AI 状态浮层、底部 Dock、命令面板（Ctrl/⌘+K）
import { TS } from './render.js';
import * as UI from './ui.js';

let app;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const { esc } = UI;

export function init(a) {
  app = a;
  // 溢出菜单
  $('#btn-more').addEventListener('click', (e) => popover($('#more-menu'), e.currentTarget));
  $$('#more-menu [data-cmd]').forEach((b) => b.addEventListener('click', () => { $('#more-menu').hidden = true; run(b.dataset.cmd); }));
  // AI 大脑浮层
  $('#brain-btn').addEventListener('click', (e) => popover($('#brain'), e.currentTarget));
  // Dock
  $$('#dock [data-mode]').forEach((b) => b.addEventListener('click', () => app.setMode(b.dataset.mode)));
  $('#btn-weather').addEventListener('click', (e) => UI.weatherMenu(e.currentTarget));
  $('#btn-event').addEventListener('click', UI.eventModal);
  $('#btn-news').addEventListener('click', () => UI.newsModal());
  $('#btn-graph').addEventListener('click', UI.graphModal);
  $('#btn-build').addEventListener('click', () => UI.buildModal());
  $('#btn-evolve').addEventListener('click', () => UI.evolveModal());
  // 点击空白处关闭浮层
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#more-menu, #btn-more')) $('#more-menu').hidden = true;
    if (!e.target.closest('#brain, #brain-btn')) $('#brain').hidden = true;
  });
  // 手机上的抽屉：把手在「半屏 / 全屏」之间切换
  $$('.sheet-handle').forEach((h) => h.addEventListener('click', () => h.closest('.sheet').classList.toggle('full')));
  // 小地图显隐（手机上默认隐藏）
  setMinimap(app.storage.get('town-minimap') ?? (innerWidth > 900 ? '1' : '0'));
  // 命令面板
  $('#pal-input').addEventListener('input', renderPalette);
  $('#pal-input').addEventListener('keydown', paletteKey);
  $('#palette').addEventListener('pointerdown', (e) => { if (e.target.id === 'palette') closePalette(); });
  syncSound();
}

function popover(el, btn) {
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false;
  const r = btn.getBoundingClientRect();
  el.style.top = `${r.bottom + 8}px`;
  el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth))}px`;
}

function setMinimap(v) {
  app.storage.set('town-minimap', v);
  document.body.classList.toggle('no-minimap', v !== '1');
  $('#more-minimap').textContent = `🗺 小地图：${v === '1' ? '开' : '关'}`;
}

export function syncSound() {
  const on = app.sound.on;
  $('#more-sound').textContent = `${on ? '🔊' : '🔇'} 环境音：${on ? '开' : '关'}`;
  for (const b of $$('[data-im="sound"], #play-sound')) b.textContent = on ? '🔊' : '🔇';
}
export function toggleSound() { app.sound.toggle(); syncSound(); }

export function run(cmd) {
  if (cmd === 'palette') return openPalette();
  if (cmd === 'sound') return toggleSound();
  if (cmd === 'minimap') return setMinimap(document.body.classList.contains('no-minimap') ? '1' : '0');
  if (cmd === 'help') return UI.helpModal();
  if (cmd === 'admin') return UI.adminModal();
  if (cmd === 'account') return UI.accountModal();
}

// ---------- 命令面板 ----------
const pal = { items: [], sel: 0 };
export function openPalette() {
  if (app.mode === 'immerse') return;
  $('#palette').hidden = false;
  $('#pal-input').value = '';
  renderPalette();
  $('#pal-input').focus();
}
export function closePalette() { $('#palette').hidden = true; }
export const paletteOpen = () => !$('#palette').hidden;

function commands() {
  const flyTo = (l) => () => {
    if ((l.region || 'town') !== app.view) app.setView(l.region || 'town', { center: false });
    app.follow = null;
    app.cam.x = (l.rect.x + l.rect.w / 2) * TS; app.cam.y = (l.rect.y + l.rect.h / 2) * TS;
  };
  const list = [];
  for (const a of Object.values(app.meta)) {
    const s = app.snap?.agents.find((x) => x.id === a.id);
    list.push({ icon: `<img src="${a.portrait}" alt="">`, label: a.name, hint: `${a.role}${s ? ` · ${s.emoji} ${s.action}` : ''}`, keys: `${a.name} ${a.role} ${a.id}`, run: () => { if (app.mode !== 'observe') app.setMode('observe'); app.select(a.id); } });
  }
  const locs = { ...(app.regionWorlds.town?.locations || {}) };
  for (const [rid, w] of Object.entries(app.regionWorlds)) if (rid !== 'town' && app.regionsOpen[rid]?.open) for (const [k, l] of Object.entries(w.locations)) locs[k] = { ...l, region: rid };
  for (const l of Object.values(locs)) {
    if (!l.rect) continue;
    list.push({ icon: esc(l.emoji || '📍'), label: l.name, hint: l.region ? '异界 · 镜头飞过去' : '地点 · 镜头飞过去', keys: `${l.name} ${l.id}`, run: flyTo(l) });
  }
  const tools = [
    ['🔭', '观察模式', () => app.setMode('observe')],
    ['🎬', '沉浸模式', () => app.setMode('immerse')],
    ...(app.perms.canTry ? [['🎮', '游戏模式', () => app.setMode('play')]] : []),
    ['📰', app.spec?.voice?.chronicle.name || '日报', () => UI.newsModal()],
    ['🕸️', '关系网络', UI.graphModal],
    ['🎭', '故事面板', () => UI.storyModal()],
    ['🛠', '建设与编年史', () => UI.buildModal()],
    ['🧬', '小镇的进化（AI 插件与决策队列）', () => UI.evolveModal()],
    ...(app.perms.canTry ? [['📢', '发布事件', UI.eventModal], ['⛅', '天气', () => UI.weatherMenu($('#btn-weather'))]] : []),
    ['🔊', '环境音开关', toggleSound],
    ['🗺', '小地图开关', () => run('minimap')],
    ['❔', '说明与快捷键', UI.helpModal],
  ];
  for (const [icon, label, fn] of tools) list.push({ icon, label, hint: '功能', keys: label, run: fn });
  return list;
}
function renderPalette() {
  const q = $('#pal-input').value.trim().toLowerCase();
  const all = commands();
  pal.items = (q ? all.filter((c) => c.keys.toLowerCase().includes(q) || [...q].every((ch) => c.keys.toLowerCase().includes(ch))) : all).slice(0, 12);
  pal.sel = 0;
  drawPalette();
}
function drawPalette() {
  $('#pal-list').innerHTML = pal.items.map((c, i) => `<button class="${i === pal.sel ? 'on' : ''}" data-i="${i}"><span class="pi">${c.icon}</span><b>${esc(c.label)}</b><small>${esc(c.hint)}</small></button>`).join('') || '<div class="empty">没有找到</div>';
  $$('#pal-list button').forEach((b) => b.addEventListener('click', () => pick(Number(b.dataset.i))));
  $('#pal-list .on')?.scrollIntoView({ block: 'nearest' });
}
function pick(i) {
  const c = pal.items[i];
  closePalette();
  c?.run();
}
function paletteKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = Math.min(pal.items.length - 1, pal.sel + 1); drawPalette(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = Math.max(0, pal.sel - 1); drawPalette(); }
  if (e.key === 'Enter') { e.preventDefault(); pick(pal.sel); }
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
}
