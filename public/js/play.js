// 🎮 游戏模式：以旅人化身在小镇里走动，走到居民身边和 TA 面对面聊天
import { TS } from './render.js';
import * as UI from './ui.js';
import * as HUD from './hud.js';

let app;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const { esc, face, name } = UI;
const now = () => performance.now();

const TALK_R = 2.5; // 多近可以开口
const LEAVE_R = 5; // 走开多远自动结束对话（服务端认定「站在面前」是 6 格）
const EAR_R = 6; // 旁听范围
const DIRS = { w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
const AV_COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f'];

const st = {
  keys: new Set(), joy: null, lastDir: null, sendT: 0, sending: false, queued: null,
  free: false, lastTo: null, click: null,
  near: [], focus: null, focusPinned: null, chase: null,
  talk: null, detail: null, pending: false, error: '', mode: 'visitor', typed: {},
  goneT: 0,
};
const touch = () => matchMedia('(pointer: coarse)').matches;

export function init(a) {
  app = a;
  window.addEventListener('keyup', (e) => st.keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => st.keys.clear());
  $('#play-exit').addEventListener('click', askExit);
  $('#play-center').addEventListener('click', () => { st.free = false; });
  $('#play-go').addEventListener('click', () => UI.avatarModal());
  $('#play-sound').addEventListener('click', HUD.toggleSound);
  $('#talk-btn').addEventListener('click', () => st.focus && talkTo(st.focus));
  $('#dlg-form').addEventListener('submit', send);
  $('#dlg-mode').addEventListener('click', () => { st.mode = st.mode === 'visitor' ? 'whisper' : 'visitor'; renderDialog(); $('#dlg-input').focus(); });
  $('#dlg-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeDialog(); } });
  joystick();
}

const me = () => app.snap?.avatars?.find((v) => v.id === app.perms.avatar) || null;
const agentsHere = (v) => (app.snap?.agents || []).filter((a) => app.meta[a.id] && (a.region || 'town') === (v.region || 'town'));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 进入游戏模式前：没有化身就先填角色卡。成功返回 true，取消返回 false */
export async function ensureAvatar() {
  await app.refreshPerms();
  if (app.perms.avatar && me()) return true;
  return new Promise((resolve) => {
    let color = app.storage.get('town-avatar-color') || AV_COLORS[0];
    // 登录的用户用账号昵称现身，只需要挑衣服
    const nick = app.perms.user?.nickname || '';
    const card = UI.openModal(`<div class="charcard">
      <canvas id="cc-preview" width="120" height="150"></canvas>
      <div class="cc-form">
        <h2>👣 以旅人的身份走进小镇</h2>
        <div class="sub">${nick ? `挑件衣服吧，${esc(nick)}。` : '起个名字、挑件衣服。'}你会出现在中央广场，居民们看得见你、会跟你打招呼，和你聊过的话也会记住是你说的。20 分钟不操作会自动离开。</div>
        ${nick ? '' : `<input id="cc-name" maxlength="8" placeholder="你的名字（≤8 字）" value="${esc(app.storage.get('town-avatar-name') || '')}">`}
        <div class="av-colors">${AV_COLORS.map((c) => `<button class="av-c${c === color ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="衣服颜色"></button>`).join('')}</div>
        <div class="row"><button class="primary" id="cc-go">走进小镇 ✨</button><span class="quota" id="cc-msg"></span></div>
        <div class="sub cc-tips">点击地面或用 <kbd>WASD</kbd> 走路 · 走到居民身边按 <kbd>E</kbd> 聊天 · <kbd>Esc</kbd> 退出</div>
      </div></div>`, 'charcard-wrap');
    const draw = () => drawPreview($('#cc-preview', card), color, nick || $('#cc-name', card)?.value.trim() || '旅人');
    draw();
    $('#cc-name', card)?.addEventListener('input', draw);
    $$('.av-c', card).forEach((b) => b.addEventListener('click', () => { color = b.dataset.c; $$('.av-c', card).forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
    let done = false;
    const finish = (ok) => { if (done) return; done = true; obs.disconnect(); resolve(ok); };
    // 弹窗被关掉（✕ / 点背景 / Esc）就当取消
    const obs = new MutationObserver(() => { if ($('#modal').hidden) finish(false); });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    const go = async () => {
      const nm = nick || $('#cc-name', card).value.trim();
      try {
        const r = await app.api('/api/avatar', { name: nm, color });
        app.storage.set('town-avatar-name', r.avatar.name); app.storage.set('town-avatar-color', r.avatar.color);
        await app.refreshPerms();
        // 等下一帧快照里出现自己的化身
        for (let i = 0; i < 20 && !me(); i++) await new Promise((res) => setTimeout(res, 100));
        done = true; obs.disconnect();
        UI.closeModal();
        resolve(true);
      } catch (e) { $('#cc-msg', card).innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(e.message)}</span>`; }
    };
    $('#cc-go', card).onclick = go;
    $('#cc-name', card)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => ($('#cc-name', card) || $('#cc-go', card))?.focus(), 50);
  });
}
function drawPreview(cv, color, label) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.save(); g.translate(60, 128); g.scale(2.4, 2.4);
  g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(0, 0, 10, 4, 0, 0, 7); g.fill();
  const y0 = -38;
  g.fillStyle = color;
  g.beginPath(); g.moveTo(-11, -2); g.lineTo(-7, y0 + 14); g.lineTo(7, y0 + 14); g.lineTo(11, -2); g.closePath(); g.fill();
  g.beginPath(); g.arc(0, y0 + 10, 9, 0, 7); g.fill();
  g.fillStyle = '#f3d7b6'; g.beginPath(); g.arc(0, y0 + 12, 5.5, 0, 7); g.fill();
  g.fillStyle = '#3a2a20'; g.fillRect(-3, y0 + 11, 2, 2); g.fillRect(1, y0 + 11, 2, 2);
  g.restore();
  g.font = 'bold 13px sans-serif'; g.textAlign = 'center'; g.fillStyle = '#ffe08a';
  g.fillText(`👣${label}`, 60, 20);
}

export function enter() {
  app.follow = null;
  st.free = false;
  st.focusPinned = null;
  const v = me();
  if (v && (v.region || 'town') !== app.view) app.setView(v.region || 'town', { center: false });
  if (v) { app.cam.x = v.x * TS + TS / 2; app.cam.y = v.y * TS + TS / 2; }
  app.cam.zoom = Math.max(1.3, Math.min(2, innerWidth / (24 * TS)));
  $('#joystick').hidden = !touch();
  if (!app.storage.get('town-play-tip')) {
    app.storage.set('town-play-tip', '1');
    UI.toast(touch() ? '👣 点击地面或用左下角摇杆走路，走到居民身边点 💬 聊天' : '👣 点击地面或用 <kbd>WASD</kbd> 走路，走到居民身边按 <kbd>E</kbd> 聊天', 6000);
  }
}
export function exit() {
  closeDialog();
  st.keys.clear(); st.joy = null; st.chase = null;
  $('#joystick').hidden = true;
}

/** 退出前确认：留下化身，还是离开小镇 */
function askExit() {
  const card = UI.openModal(`<h2>离开游戏模式？</h2>
    <div class="sub">留在小镇的话，你的化身会继续站在原地，20 分钟无操作后自动离开。</div>
    <div class="row"><button class="primary" id="ex-stay">🏠 留在小镇</button><button class="ghost" id="ex-leave">👋 离开小镇</button><button class="ghost" id="ex-cancel">继续玩</button></div>`);
  $('#ex-stay', card).onclick = () => { UI.closeModal(); app.setMode('observe'); };
  $('#ex-leave', card).onclick = async () => { await app.api('/api/avatar/leave', {}).catch(() => {}); await app.refreshPerms(); UI.closeModal(); app.setMode('observe'); };
  $('#ex-cancel', card).onclick = UI.closeModal;
}

export function key(e) {
  const k = e.key.toLowerCase();
  if (k === 'escape') {
    if (!$('#modal').hidden || !$('#inspector').hidden) return UI.escape();
    if (st.talk) return closeDialog();
    return askExit();
  }
  if (DIRS[k]) { e.preventDefault(); st.keys.add(k); st.free = false; st.chase = null; return; }
  if (k === 'e' || k === 'enter') {
    e.preventDefault();
    if (st.talk) return $('#dlg-input').focus();
    if (st.focus) talkTo(st.focus);
    return;
  }
  if (k === 'f') st.free = false;
  if (k === 'tab') {
    e.preventDefault();
    if (st.near.length) { const i = st.near.indexOf(st.focus); st.focusPinned = st.near[(i + 1) % st.near.length]; }
  }
  if (k === '=' || k === '+') app.zoomBy(1.15);
  if (k === '-') app.zoomBy(1 / 1.15);
}

export function free() { st.free = true; }
export function onAgents() { if (st.talk && !app.meta[st.talk]) closeDialog(); }

// ---------- 移动 ----------
function walkable(x, y) {
  const w = app.regionWorlds[(me()?.region) || 'town'];
  if (!w || x < 0 || y < 0 || x >= w.W || y >= w.H) return false;
  return !!w.walk?.[y * w.W + x];
}
function nearestWalkable(x, y, r = 4, from = null, minD = 0) {
  let bestP = null, bd = Infinity;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.hypot(dx, dy) < minD || !walkable(x + dx, y + dy)) continue;
    const d = Math.hypot(dx, dy) + (from ? Math.hypot(x + dx - from.x, y + dy - from.y) * 0.3 : 0);
    if (d < bd) { bd = d; bestP = { x: x + dx, y: y + dy }; }
  }
  return bestP;
}
async function goto(x, y) {
  st.queued = { x, y };
  if (st.sending) return;
  while (st.queued) {
    const t = st.queued; st.queued = null;
    const wait = 280 - (now() - st.sendT);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    st.sending = true; st.sendT = now();
    try { await app.api('/api/avatar/goto', t); st.free = false; }
    catch (e) { if (e.status !== 429) UI.toast(`⚠️ ${esc(e.message)}`, 2000); }
    finally { st.sending = false; }
  }
}

/** 点击画布：点到居民就走过去聊天，点到地面就走过去 */
export function tap(sx, sy, id) {
  const v = me();
  if (!v) return;
  if (id) return talkTo(id);
  if ((v.region || 'town') !== app.view) { app.setView(v.region || 'town'); return; }
  const [wx, wy] = app.renderer.screenToWorld(sx, sy, app.cam);
  const tx = Math.floor(wx / TS), ty = Math.floor(wy / TS);
  const p = walkable(tx, ty) ? { x: tx, y: ty } : nearestWalkable(tx, ty, 4, v);
  if (!p) return UI.toast('那里走不过去', 1500);
  st.chase = null;
  st.click = { x: p.x, y: p.y, t: now() };
  goto(p.x, p.y);
}

function stepInput(v) {
  let dx = 0, dy = 0;
  for (const k of st.keys) { const d = DIRS[k]; if (d) { dx += d[0]; dy += d[1]; } }
  if (st.joy) { dx = st.joy.x; dy = st.joy.y; }
  const len = Math.hypot(dx, dy);
  if (len > 0.01) {
    dx /= len; dy /= len;
    st.lastDir = [dx, dy];
    if (now() - st.sendT > 300 && !st.sending) {
      const ox = Math.round(v.x), oy = Math.round(v.y);
      for (const n of [3, 2, 1]) {
        const x = Math.round(ox + dx * n), y = Math.round(oy + dy * n);
        if (walkable(x, y)) { goto(x, y); break; }
      }
    }
  } else if (st.lastDir) {
    // 松开方向键：停在前方最近的一格
    const [ldx, ldy] = st.lastDir;
    st.lastDir = null;
    const x = Math.round(v.x + ldx * 0.6), y = Math.round(v.y + ldy * 0.6);
    goto(...(walkable(x, y) ? [x, y] : [Math.round(v.x), Math.round(v.y)]));
  }
}

function joystick() {
  const el = $('#joystick'), knob = $('#joystick i');
  let id = null;
  const move = (e) => {
    const r = el.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    knob.style.transform = `translate(${x * 30}px, ${y * 30}px)`;
    st.joy = l > 0.3 ? { x, y } : null;
    if (st.joy) { st.free = false; st.chase = null; }
  };
  el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.setPointerCapture(id); move(e); });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
  const end = () => { id = null; st.joy = null; knob.style.transform = ''; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ---------- 对话 ----------
function talkTo(id) {
  const v = me(), a = app.snap?.agents.find((x) => x.id === id);
  if (!v || !a) return;
  if ((a.region || 'town') !== (v.region || 'town')) return UI.toast(`${esc(name(id))}不在这里`, 2000);
  if (a.inside) return UI.toast(`${esc(name(id))}在屋里，等 TA 出来再聊吧`, 2500);
  if (a.status === 'sleeping') return UI.toast(`${esc(name(id))}睡着了……`, 2000);
  if (dist(a, v) <= TALK_R) return openDialog(id);
  // 走到 TA 身边再开口
  st.chase = { id, t: now(), sent: 0 };
}
function chase(v) {
  const c = st.chase;
  if (!c) return;
  const a = app.snap.agents.find((x) => x.id === c.id);
  if (!a || a.inside || now() - c.t > 20000) { st.chase = null; return; }
  if (dist(a, v) <= TALK_R) { st.chase = null; openDialog(a.id); return; }
  if (now() - c.sent > 1500) {
    c.sent = now();
    // 站到 TA 身边，而不是跟 TA 叠在一起
    const p = nearestWalkable(Math.round(a.x), Math.round(a.y), 2, v, 1);
    if (p) { st.click = { ...p, t: now() }; goto(p.x, p.y); }
  }
}

async function openDialog(id) {
  st.talk = id; st.detail = null; st.error = ''; st.focusPinned = id;
  $('#dialog').hidden = false;
  renderDialog();
  await loadDialog();
  if (!touch()) $('#dlg-input').focus();
}
function closeDialog() {
  if (!st.talk) return;
  st.talk = null; st.detail = null;
  $('#dialog').hidden = true;
  $('#dlg-input').blur();
}
async function loadDialog() {
  const id = st.talk;
  if (!id) return;
  try {
    const d = await app.api(`/api/agent/${id}`);
    if (st.talk !== id) return;
    st.detail = d;
    renderDialog();
  } catch (e) { st.error = e.message; renderDialog(); }
}
function renderDialog() {
  const id = st.talk;
  if (!id) return;
  const d = st.detail, m = app.meta[id], s = app.snap?.agents.find((x) => x.id === id);
  const whisper = st.mode === 'whisper';
  $('#dialog').classList.toggle('whisper', whisper);
  const head = `<img src="${face(id)}" alt=""><div class="dh"><b>${esc(m?.name || id)}</b><small>${esc(m?.role || '')}${s ? ` · ${esc(s.mood || '')} ${esc(s.emoji)} ${esc(s.action)}` : ''}</small></div>
    <button class="mini" id="dlg-info" title="查看 TA 的日程、记忆与关系">📋 详情</button><button class="mini" id="dlg-x" title="结束对话 (Esc)">✕</button>`;
  if ($('#dlg-head').dataset.h !== head) {
    $('#dlg-head').innerHTML = head; $('#dlg-head').dataset.h = head;
    $('#dlg-x').onclick = closeDialog;
    $('#dlg-info').onclick = () => app.select(id, { focus: false });
  }
  const chat = d?.chat || [];
  const last = chat.length - 1;
  const msgs = chat.map((c, i) => {
    const mine = c.from === 'user';
    let text = c.text;
    // 最新一句回复逐字出现
    if (!mine && i === last) {
      const key = `${id}:${i}:${c.text}`;
      const t0 = st.typed[key] ||= now();
      text = c.text.slice(0, Math.floor((now() - t0) / 1000 * 30) + 1);
    }
    return `<div class="msg ${mine ? 'user' : 'agent'}">${mine ? '' : `<b>${esc(m?.name || '')}</b>`}${esc(text)}</div>`;
  }).join('');
  const html = (d ? msgs || `<div class="msg sys">${whisper ? `化作一个念头，悄悄钻进${esc(m?.name)}心里——TA 会以为这是自己想到的。` : `你站在${esc(m?.name)}面前。打个招呼吧——TA 会记住是你说的。`}</div>` : '<div class="msg sys">……</div>')
    + (st.pending ? '<div class="msg agent typing">✦ 正在想怎么回答…</div>' : '')
    + (st.error ? `<div class="msg sys err">⚠️ ${esc(st.error)}</div>` : '');
  const log = $('#dlg-log');
  if (log.dataset.h !== html) { log.innerHTML = html; log.dataset.h = html; log.scrollTop = log.scrollHeight; }
  $('#dlg-mode').textContent = whisper ? '💭' : '🧳';
  $('#dlg-mode').title = whisper ? '现在：化作心声（点击切换为以旅人身份说话）' : '现在：以旅人身份说话（点击切换为化作心声）';
  $('#dlg-input').placeholder = whisper ? `在${m?.name || 'TA'}心里种下一个念头…` : `对${m?.name || 'TA'}说点什么…`;
  const q = app.perms.remaining?.chat;
  $('#dlg-quota').textContent = q == null ? '' : `本小时还可以说 ${q} 句 · 请友善发言，内容会经过审核`;
}
async function send(e) {
  e.preventDefault();
  const input = $('#dlg-input');
  const text = input.value.trim();
  const id = st.talk;
  if (!text || st.pending || !id) return;
  input.value = '';
  (st.detail ||= { chat: [] }).chat.push({ from: 'user', text });
  st.pending = true; st.error = '';
  renderDialog();
  try {
    const r = await app.api('/api/chat', { id, text, mode: st.mode });
    if (r.remaining) app.perms.remaining = r.remaining;
    if (r.plan) UI.toast(`📌 ${esc(name(id))} 改变了计划：${esc(r.plan)}`);
  } catch (err) {
    st.error = err.message;
    input.value = text;
  } finally {
    st.pending = false;
    if (st.talk === id) await loadDialog();
  }
}

// ---------- 每帧 ----------
export function state() {
  const v = me();
  return v ? { me: v.id, near: st.near, focus: st.talk ? null : st.focus, talk: st.talk, to: v.to || null, next: v.next || null, click: st.click, touch: touch() } : null;
}

export function camera(dt, avatars) {
  const v = avatars.find((x) => x.mine);
  if (!v) return;
  if (st.lastTo !== JSON.stringify(v.to || null)) { st.lastTo = JSON.stringify(v.to || null); if (v.to) st.free = false; }
  if (st.free) return;
  const c = app.cam, z = c.zoom;
  // 对话框打开时把化身放到屏幕上方一点，免得被挡住
  const ax = v.dx * TS + TS / 2, ay = v.dy * TS + TS / 2 + (st.talk ? innerHeight * 0.16 / z : 0);
  const dead = 3 * TS;
  let tx = c.x, ty = c.y;
  if (ax - c.x > dead) tx = ax - dead; else if (c.x - ax > dead) tx = ax + dead;
  if (ay - c.y > dead * 0.7) ty = ay - dead * 0.7; else if (c.y - ay > dead * 0.7) ty = ay + dead * 0.7;
  const k = 1 - Math.exp(-dt * 5);
  c.x += (tx - c.x) * k; c.y += (ty - c.y) * k;
  app.clampCam();
}

export function frame(S) {
  const v = me();
  if (!v) {
    // 化身消失（超时离开或被移除）
    if (!st.goneT) st.goneT = now();
    else if (now() - st.goneT > 3000) { st.goneT = 0; UI.toast('👋 你的化身已经离开了小镇'); app.setMode('observe'); }
    return;
  }
  st.goneT = 0;
  if ((v.region || 'town') !== app.view && !st.free) app.setView(v.region || 'town', { center: true });
  stepInput(v);
  chase(v);
  // 附近的人
  const here = agentsHere(v).filter((a) => !a.inside && a.status !== 'sleeping');
  st.near = here.filter((a) => dist(a, v) <= TALK_R).sort((a, b) => dist(a, v) - dist(b, v)).map((a) => a.id);
  st.focus = st.near.includes(st.focusPinned) ? st.focusPinned : st.near[0] || null;
  // 对话中走远了
  if (st.talk && !st.pending) {
    const a = app.snap.agents.find((x) => x.id === st.talk);
    if (!a || a.inside || a.status === 'sleeping' || (a.region || 'town') !== (v.region || 'town') || dist(a, v) > LEAVE_R) {
      const nm = name(st.talk);
      closeDialog();
      UI.toast(`${esc(nm)}去忙别的了`, 2500);
    }
  }
  if (st.talk) renderDialog();
  // 顶部信息
  const w = app.weathers[S.weatherId] || {};
  $('#play-clock').textContent = `${String(Math.floor(S.t % 1440 / 60)).padStart(2, '0')}:${String(Math.floor(S.t % 60)).padStart(2, '0')} · 第${S.day}天 · ${w.emoji || ''} ${w.name || ''}`;
  const meHtml = `<i style="background:${esc(v.color)}"></i>👣 ${esc(v.name)}`;
  if ($('#play-me').dataset.h !== meHtml) { $('#play-me').innerHTML = meHtml; $('#play-me').dataset.h = meHtml; }
  const around = here.filter((a) => dist(a, v) <= EAR_R).sort((a, b) => dist(a, v) - dist(b, v)).slice(0, 6);
  const nearHtml = around.map((a) => `<button data-talk="${a.id}" class="${a.id === st.focus ? 'on' : ''}" title="和${esc(name(a.id))}聊天"><img src="${face(a.id)}" alt=""><span>${esc(name(a.id))}</span></button>`).join('');
  if ($('#play-near').dataset.h !== nearHtml) {
    $('#play-near').innerHTML = nearHtml; $('#play-near').dataset.h = nearHtml;
    $$('#play-near [data-talk]').forEach((b) => b.addEventListener('click', () => talkTo(b.dataset.talk)));
  }
  // 旁听：身边有人在聊天
  const ear = (app.snap.convos || []).find((c) => [c.a, c.b].every((id) => { const a = here.find((x) => x.id === id); return a && dist(a, v) <= EAR_R; }));
  const earEl = $('#play-ear');
  earEl.hidden = !ear || !!st.talk;
  if (ear) earEl.textContent = `👂 正在旁听：${name(ear.a)} × ${name(ear.b)}`;
  $('#talk-btn').hidden = !touch() || !st.focus || !!st.talk;
}
