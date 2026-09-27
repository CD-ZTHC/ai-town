// 🎬 沉浸模式：隐藏界面、导演镜头自动运镜、对白字幕、章节卡、悬浮控制条
import { TS } from './render.js';
import { esc, weekday } from './ui.js';
import * as HUD from './hud.js';

let app;
const $ = (s) => document.querySelector(s);
const now = () => performance.now();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const MIN_STAY = 8000, MAX_STAY = 40000, COOLDOWN = 90000, PICK_EVERY = 1000;
// 最近发生的动态：类型 → [基础分, 保鲜时间 ms]
const HOT_LOGS = {
  scene: [100, 60000], vote: [100, 60000], arc: [100, 45000], portal: [95, 45000],
  encounter: [90, 30000], creature: [90, 30000], mischief: [80, 30000], arrival: [85, 45000],
  thought: [20, 20000], reflect: [30, 20000], gift: [40, 25000], learn: [35, 25000],
};
const NARRATE = new Set(['arc', 'portal', 'vote', 'arrival', 'depart', 'weather', 'omen']);
const PHASE = { omen: '🔮 伏笔', breach: '🌀 爆发', struggle: '⚔️ 发展', climax: '🌕 高潮', aftermath: '🌅 余波' };

const st = {
  cur: null, since: 0, pickT: 0, history: [], cool: new Map(), locked: false, fading: false,
  subs: true, recent: [], seenBubbles: new Set(), lines: [], chapters: [], chapterUntil: 0,
  lastDay: null, lastMinute: null, lastArc: undefined, pokeT: 0, statusT: 0,
};

export function init(a) {
  app = a;
  st.subs = app.storage.get('town-subs') !== '0';
  setBars(app.storage.get('town-bars') !== '0'); // 电影黑边默认开
  (app.onLogHooks ||= []).push(onLog);
  document.querySelectorAll('#im-bar [data-im]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); cmd(b.dataset.im); }));
  $('#immerse').addEventListener('pointermove', poke);
  $('#world').addEventListener('dblclick', () => { if (app.mode === 'immerse') app.setMode('observe'); });
  document.addEventListener('fullscreenchange', syncBar);
  syncBar();
}

export const subsOn = () => st.subs;
export function currentAgent() { return st.cur?.agents?.[0] || null; }

export function enter({ gesture }) {
  app.follow = null;
  Object.assign(st, { cur: null, since: 0, pickT: 0, history: [], locked: false, lines: [], lastDay: null, lastArc: undefined });
  st.seenBubbles = new Set((app.snap?.agents || []).map((a) => a.bubble?.id).filter(Boolean)); // 进入前已经在说的话不重复出字幕
  $('#subtitles').innerHTML = '';
  if (gesture) {
    // 进入按钮本身就是一次用户操作：顺便开全屏和环境音（被浏览器拒绝时静默忽略）
    document.documentElement.requestFullscreen?.().catch(() => {});
    if (!app.sound.on) HUD.toggleSound();
  }
  poke();
  syncBar();
}
export function exit() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  document.body.classList.remove('im-active');
  $('#fade').classList.remove('on');
  $('#chapter').hidden = true;
  st.chapters = [];
}

/** 鼠标移动 / 触摸：显示控制条与光标，2.5 秒无操作后隐藏 */
export function poke() {
  if (app.mode !== 'immerse') return;
  st.pokeT = now();
  document.body.classList.add('im-active');
}

export function key(e) {
  const k = e.key;
  poke();
  if (k === 'Escape' || k === 'i' || k === 'I') return app.setMode('observe');
  if (k === ' ') { e.preventDefault(); cmd('lock'); }
  if (k === 'Tab' || k === 'ArrowRight') { e.preventDefault(); cmd('next'); }
  if (k === 'ArrowLeft') cmd('prev');
  if (k === 'f' || k === 'F') cmd('full');
}

function cmd(c) {
  if (c === 'exit') return app.setMode('observe');
  if (c === 'lock') st.locked = !st.locked;
  if (c === 'next') { st.locked = false; switchTo(best(st.cur?.key)); }
  if (c === 'prev') { const h = st.history.pop(); if (h) switchTo(h, { back: true }); }
  if (c === 'sound') HUD.toggleSound();
  if (c === 'subs') { st.subs = !st.subs; app.storage.set('town-subs', st.subs ? null : '0'); if (!st.subs) $('#subtitles').innerHTML = ''; }
  if (c === 'bars') { const on = !document.body.classList.contains('bars'); setBars(on); app.storage.set('town-bars', on ? null : '0'); }
  if (c === 'full') document.fullscreenElement ? document.exitFullscreen?.().catch(() => {}) : document.documentElement.requestFullscreen?.().catch(() => {});
  syncBar();
}
function setBars(on) { document.body.classList.toggle('bars', on); }
function syncBar() {
  const b = (k) => $(`#im-bar [data-im="${k}"]`);
  b('lock').textContent = st.locked ? '▶' : '⏸';
  b('lock').title = st.locked ? '恢复自动运镜 (空格)' : '锁定当前镜头 (空格)';
  b('subs').classList.toggle('on', st.subs);
  b('bars').classList.toggle('on', document.body.classList.contains('bars'));
  b('full').classList.toggle('on', !!document.fullscreenElement);
  b('full').hidden = !document.documentElement.requestFullscreen;
}

// ---------- 导演镜头 ----------
function regionOf(x) { return x?.region || 'town'; }
function agentPos(id) {
  const a = app.snap?.agents.find((q) => q.id === id);
  if (!a) return null;
  const r = regionOf(a);
  if (a.inside) {
    const b = app.regionWorlds[r]?.buildings.find((q) => q.id === a.inside);
    if (b) return { region: r, x: (b.x + b.w / 2) * TS, y: (b.y + b.h / 2) * TS, inside: true };
  }
  return { region: r, x: a.x * TS + TS / 2, y: a.y * TS + TS / 2 };
}
function groupPos(ids) {
  const ps = ids.map(agentPos).filter(Boolean);
  if (!ps.length) return null;
  const region = ps[0].region;
  const same = ps.filter((p) => p.region === region);
  const xs = same.map((p) => p.x), ys = same.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { region, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}
function fitZoom(p, min = 1.1, max = 2) {
  const z = Math.min(innerWidth / ((p.w || 0) + 12 * TS), innerHeight / ((p.h || 0) + 9 * TS));
  return Math.max(min, Math.min(max, z));
}
const zoomScale = () => Math.max(0.65, Math.min(1.1, innerWidth / 1300));
const watched = (ids) => (ids || []).some((id) => app.watch.has(id));

function candidates() {
  const s = app.snap;
  if (!s) return [];
  const out = [];
  const t = now();
  const awake = s.agents.filter((a) => a.status !== 'sleeping');
  // 最近的剧情 / 遭遇 / 心声
  st.recent = st.recent.filter((r) => t - r.at < (HOT_LOGS[r.l.type]?.[1] || 0));
  for (const r of st.recent) {
    const [base] = HOT_LOGS[r.l.type];
    const ids = (r.l.agents || []).filter((id) => app.meta[id]);
    let p = ids.length ? groupPos(ids) : null;
    if (!p && /portal/.test(r.l.type)) { const e = (s.entities || []).find((q) => q.kind === 'portal'); if (e) p = { region: 'town', x: e.x * TS, y: e.y * TS }; }
    if (!p && ['creature', 'encounter', 'mischief'].includes(r.l.type)) { const c = (s.creatures || [])[0]; if (c) p = { region: regionOf(c), x: c.x * TS, y: c.y * TS }; }
    if (!p) continue;
    const icon = { thought: '💭', reflect: '✨', scene: '🎭', vote: '🗳️', encounter: '👻', creature: '👻', gift: '🎁' }[r.l.type] || '🌀';
    out.push({ key: `log:${r.l.id ?? r.at}`, score: base + (watched(ids) ? 25 : 0), agents: ids, ...p, zoom: ids.length > 1 ? fitZoom(p) : 1.8, label: `${icon} ${String(r.l.text).slice(0, 28)}` });
  }
  // 正在进行的对话
  for (const c of s.convos || []) {
    const ids = [c.a, c.b].filter((id) => app.meta[id]);
    const p = groupPos(ids);
    if (!p) continue;
    out.push({ key: `convo:${c.id}`, score: 60 + ids.length * 5 + (watched(ids) ? 25 : 0) + (p.inside ? -15 : 0), agents: ids, ...p, zoom: fitZoom(p, 1.5, 2.1), label: `💬 ${ids.map((id) => app.meta[id].name).join(' × ')}` });
  }
  // 节日灯会（夜晚的镜湖）
  const m = s.t % 1440;
  const pier = app.regionWorlds.town?.locations?.pier?.rect;
  const lanterns = (app.spec?.calendar.events || []).filter((e) => e.vfx === 'festival_lanterns');
  const fest = lanterns.find((e) => e.day === Math.floor(s.t / 1440) + 1) || (app.forceFestival && lanterns[0]);
  if (fest && (m > 1110 || m < 60) && pier) out.push({ key: 'festival', score: 55, region: 'town', x: (pier.x + pier.w / 2) * TS, y: (pier.y - 2) * TS, zoom: 1.25, label: `${fest.emoji || '🏮'} ${fest.name}` });
  // 访客化身在和居民说话
  for (const v of s.avatars || []) {
    const a = awake.find((q) => !q.inside && regionOf(q) === regionOf(v) && q.bubble?.kind === 'say' && Math.hypot(q.x - v.x, q.y - v.y) < 4);
    if (a) out.push({ key: `avatar:${v.id}`, score: 45, agents: [a.id], region: regionOf(v), x: (v.x + a.x) / 2 * TS + TS / 2, y: (v.y + a.y) / 2 * TS + TS / 2, zoom: 1.9, label: `👣 ${v.name} 和 ${app.meta[a.id]?.name}` });
  }
  // 走在路上的居民：让画面有生活气
  for (const a of awake) if (a.status === 'walking' && !a.inside) out.push({ key: `walk:${a.id}`, score: 12 + (watched([a.id]) ? 25 : 0), agents: [a.id], follow: a.id, ...agentPos(a.id), zoom: 1.7, label: `🚶 ${app.meta[a.id]?.name}：${a.action}` });
  // 风景空镜（清晨、黄昏更值得看；深夜全员熟睡时做夜景巡游）
  const golden = (m > 330 && m < 450) || (m > 1020 && m < 1140);
  const night = !awake.length;
  const locs = Object.values(app.regionWorlds.town?.locations || {}).filter((l) => l.rect && !l.id.startsWith('home_') && !l.region);
  if (locs.length) {
    const l = locs[Math.floor(t / 45000) % locs.length];
    out.push({ key: `scenic:${l.id}`, score: 10 * (golden ? 3 : 1) + (night ? 30 : 0), region: 'town', x: (l.rect.x + l.rect.w / 2) * TS, y: (l.rect.y + l.rect.h / 2) * TS, zoom: night ? 1.2 : 1.15, drift: true, label: `${l.emoji || '📍'} ${l.name}` });
  }
  // 冷却：刚拍过的目标降权
  for (const c of out) { const cd = st.cool.get(c.key); if (cd && t - cd < COOLDOWN && c.key !== st.cur?.key) c.score -= 35; }
  return out;
}
function best(exclude) {
  const list = candidates().filter((c) => c.key !== exclude);
  return list.sort((a, b) => b.score - a.score)[0] || null;
}

function switchTo(c, { back = false } = {}) {
  if (!c) return;
  const t = now();
  if (st.cur) {
    st.cool.set(st.cur.key, t);
    if (!back) { st.history.push(st.cur); if (st.history.length > 20) st.history.shift(); }
  }
  const far = !st.cur || regionOf(c) !== app.view || Math.hypot(c.x - app.cam.x, c.y - app.cam.y) > 22 * TS;
  st.cur = c;
  st.since = t;
  st.statusT = t;
  showStatus();
  if (far) cut(c);
}
/** 远距离：淡出到黑 → 瞬移 → 淡入，避免长距离横扫 */
function cut(c) {
  const jump = () => {
    if (regionOf(c) !== app.view) app.setView(regionOf(c), { center: false });
    app.cam.x = c.x; app.cam.y = c.y; app.cam.zoom = (c.zoom || 1.3) * zoomScale();
    app.clampCam();
  };
  if (reduced() || !st.cur) return jump();
  st.fading = true;
  $('#fade').classList.add('on');
  setTimeout(() => { jump(); $('#fade').classList.remove('on'); st.fading = false; }, 260);
}

function pick() {
  const all = candidates();
  const cur = st.cur && all.find((c) => c.key === st.cur.key);
  if (cur) Object.assign(st.cur, cur); // 刷新位置与分数
  if (st.locked && st.cur) return;
  const t = now(), stay = t - st.since;
  const rest = all.filter((c) => c.key !== st.cur?.key).sort((a, b) => b.score - a.score);
  const top = rest[0];
  if (!st.cur) return switchTo(top);
  if (!cur && stay >= MIN_STAY / 2) return switchTo(top); // 目标消失（对话结束等）
  if (!top) return;
  const curScore = cur ? cur.score : 0;
  if (stay >= MAX_STAY) return switchTo(top);
  if (top.score - curScore > 40) return switchTo(top); // 大事发生：立刻切
  if (stay >= MIN_STAY && top.score > curScore + 5) return switchTo(top);
}

export function camera(dt) {
  const t = now();
  if (t - st.pickT > PICK_EVERY) { st.pickT = t; pick(); }
  const c = st.cur;
  if (!c || st.fading) return;
  if (regionOf(c) !== app.view) return cut(c);
  let { x, y } = c;
  if (c.follow) { const p = agentPos(c.follow); if (p && p.region === app.view) { x = p.x; y = p.y; } }
  if (c.drift) { const k = (t - st.since) / 1000; x += Math.sin(k * 0.08) * 3 * TS; y += Math.cos(k * 0.06) * 1.5 * TS; }
  const kp = reduced() ? 1 : 1 - Math.exp(-dt * 1.8), kz = reduced() ? 1 : 1 - Math.exp(-dt * 1.2);
  app.cam.x += (x - app.cam.x) * kp;
  app.cam.y += (y - app.cam.y) * kp;
  app.cam.zoom += ((c.zoom || 1.3) * zoomScale() - app.cam.zoom) * kz;
  app.clampCam();
}

// ---------- 状态角标 ----------
function locName(c) {
  const w = app.regionWorlds[regionOf(c)];
  if (!w) return '';
  const tx = c.x / TS, ty = c.y / TS;
  let bestL = null, bd = 9;
  for (const l of Object.values(w.locations)) {
    const r = l.rect;
    if (!r) continue;
    const inside = tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h + 1;
    const d = inside ? 0 : Math.hypot(tx - (r.x + r.w / 2), ty - (r.y + r.h / 2));
    if (d < bd) { bd = d; bestL = l; }
  }
  return bestL ? `📍 ${bestL.name}` : '';
}
function showStatus() {
  if (!st.cur) return;
  const where = locName(st.cur), label = st.cur.label || '';
  $('#im-where').textContent = where && label.includes(where.replace('📍 ', '')) ? label : [where, label].filter(Boolean).join(' · ');
  const el = $('#im-status');
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

// ---------- 字幕 ----------
function onLog(l) {
  if (HOT_LOGS[l.type]) st.recent.push({ l, at: now() });
  if (app.mode !== 'immerse') return;
  if (NARRATE.has(l.type)) addLine({ id: `n${l.id ?? now()}`, kind: 'narr', text: l.text });
}
function addLine(x) {
  if (!st.subs) return;
  const len = x.text.length;
  x.at = now();
  x.until = x.at + 2000 + len * 90 + (x.kind === 'narr' ? 1500 : 0);
  st.lines.push(x);
  if (st.lines.length > 6) st.lines.shift();
}
function collectBubbles(S) {
  const r = app.renderer;
  for (const a of S.agents) {
    const b = a.bubble;
    if (!b || b.text === '…' || st.seenBubbles.has(b.id)) continue;
    st.seenBubbles.add(b.id);
    // 只给画面里的人配字幕
    const p = agentPos(a.id);
    if (!p) continue;
    const [sx, sy] = r.worldToScreen(p.x, p.y, app.cam);
    if (sx < -40 || sy < -40 || sx > innerWidth + 40 || sy > innerHeight + 40) continue;
    const m = app.meta[a.id];
    addLine({ id: b.id, kind: b.kind === 'think' ? 'think' : 'say', who: m?.name || a.id, color: m?.look?.shirt || '#ffd28a', text: b.text });
  }
  if (st.seenBubbles.size > 400) st.seenBubbles = new Set([...st.seenBubbles].slice(-200));
}
function renderLines() {
  const t = now();
  st.lines = st.lines.filter((l) => l.until > t);
  const show = st.lines.slice(-2);
  const html = show.map((l) => {
    const n = reduced() ? l.text.length : Math.min(l.text.length, Math.floor((t - l.at) / 1000 * 26) + 1);
    const txt = esc(l.text.slice(0, n));
    if (l.kind === 'narr') return `<div class="subline narr">${txt}</div>`;
    return `<div class="subline ${l.kind}"><b style="color:${esc(l.color)}">${esc(l.who)}</b>${l.kind === 'think' ? '💭 ' : '：'}${l.kind === 'think' ? `<i>${txt}</i>` : `「${txt}」`}</div>`;
  }).join('');
  const el = $('#subtitles');
  if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
}

// ---------- 章节卡 ----------
function chapter(html) {
  st.chapters.push(html);
}
export function onNewspaper(p) {
  if (app.mode === 'immerse') chapter(`<small>📰 ${esc(app.spec?.voice?.chronicle.name || '日报')} · 第 ${p.day ?? ''} 期</small><h2>${esc(p.headline)}</h2>${p.subhead ? `<p>${esc(p.subhead)}</p>` : ''}`);
}
function chapters(S) {
  const m = S.t % 1440;
  if (st.lastMinute != null && st.lastMinute < 360 && m >= 360 || st.lastDay != null && S.day !== st.lastDay && m >= 360) {
    const w = app.weathers[S.weatherId] || {};
    chapter(`<small>${w.emoji || ''} ${esc(w.name || '')}</small><h2>第 ${S.day} 天 · ${esc(weekday(S.day))}</h2>`);
  }
  st.lastMinute = m; st.lastDay = S.day;
  const arc = app.snap.story?.arc ?? null;
  if (st.lastArc !== undefined && arc && arc !== st.lastArc) chapter(`<small>剧情推进</small><h2>${PHASE[arc] || esc(arc)}</h2>`);
  st.lastArc = arc;
  const t = now();
  const el = $('#chapter');
  if (t > st.chapterUntil) {
    if (st.chapters.length) {
      el.innerHTML = st.chapters.shift();
      el.hidden = false;
      el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
      st.chapterUntil = t + 3200;
    } else el.hidden = true;
  }
}

export function frame(S) {
  const t = now();
  if (t - st.pokeT > 2500) document.body.classList.remove('im-active');
  $('#im-clock').textContent = `${String(Math.floor(S.t % 1440 / 60)).padStart(2, '0')}:${String(Math.floor(S.t % 60)).padStart(2, '0')} · 第${S.day}天 · ${(app.weathers[S.weatherId] || {}).emoji || ''}`;
  if (st.subs) { collectBubbles(S); renderLines(); }
  chapters(S);
}
