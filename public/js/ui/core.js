// 界面共用的状态与小工具：app（live binding，由 setApp 设置）、选择器、转义、时间、弹窗与提示
// app 是 live binding：只有 setApp 能改它，其他模块导入后读到的永远是最新的值。

export let app;
export function setApp(a) { app = a; }
export const $ = (s, r = document) => r.querySelector(s);

export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtTime = (t) => { const m = Math.floor(t % 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

export const weekday = (day) => { const w = app.spec?.calendar.weekdays || []; return w.length ? w[(day - 1) % w.length] : ''; };

export const face = (id) => app.meta[id]?.portrait || '';

export const name = (id) => app.meta[id]?.name || id;

export const ui = { tab: 'sched', memFilter: 'all', chatMode: 'visitor', feedFilter: 'all', detail: null, rosterT: 0, refreshT: 0, pending: false };

export function toast(html, ms = 4200) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
}

/** 距离某个真实时间点还有多久（「3 小时5 分」/「12 分钟」） */
export const fmtLeft = (ms) => {
  const s = Math.max(0, (ms - Date.now()) / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)} 小时${Math.round((s % 3600) / 60)} 分` : `${Math.ceil(s / 60)} 分钟`;
};

export const guarded = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
};

export function openModal(html, cls = '') {
  const card = $('#modal-card');
  card.className = `modal-card ${cls}`;
  card.innerHTML = `<button class="modal-x" id="modal-x">✕</button>${html}`;
  $('#modal').hidden = false;
  $('#modal-x').onclick = closeModal;
  return card;
}

export function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; ui.storyOpen = false; ui.buildOpen = false; ui.evoOpen = false; ui.panelOpen = false; }
