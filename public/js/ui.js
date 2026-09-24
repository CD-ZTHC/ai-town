// 界面：名册、检查器、动态流、AI 大脑面板、弹窗（日报 / 关系网 / 事件 / 帮助）
let app;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => { const m = Math.floor(t % 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const weekday = (day) => { const w = app.spec?.calendar.weekdays || []; return w.length ? w[(day - 1) % w.length] : ''; };
const face = (id) => app.meta[id]?.portrait || '';
const name = (id) => app.meta[id]?.name || id;

const ui = { tab: 'sched', memFilter: 'all', chatMode: 'visitor', feedFilter: 'all', detail: null, rosterT: 0, refreshT: 0, pending: false };

export function init(a, first) {
  app = a;
  buildRoster();
  renderFeed();
  updateBrain();
  if (!first) { if (app.selected) openInspector(app.selected); return; }
  $$('#speed button').forEach((b) => b.addEventListener('click', () => {
    const sp = Number(b.dataset.speed);
    sp === 0 ? togglePause() : setSpeed(sp);
  }));
  $('#btn-weather').addEventListener('click', (e) => weatherMenu(e.currentTarget));
  $('#btn-event').addEventListener('click', eventModal);
  $('#btn-news').addEventListener('click', () => newsModal());
  $('#btn-graph').addEventListener('click', graphModal);
  $('#btn-help').addEventListener('click', helpModal);
  $('#btn-sound').addEventListener('click', (e) => { e.currentTarget.textContent = app.sound.toggle() ? '🔊' : '🔇'; });
  $('#festival-chip').addEventListener('click', () => {
    app.forceFestival = !app.forceFestival;
    toast(app.forceFestival ? '🏮 萤火节灯会预览：夜晚时镜湖上会升起河灯与天灯' : '🏮 已关闭灯会预览');
  });
  $('#insp-close').addEventListener('click', closeInspector);
  $('#feed-toggle').addEventListener('click', () => {
    const f = $('#feed'); f.classList.toggle('collapsed');
    $('#feed-toggle').textContent = f.classList.contains('collapsed') ? '▴' : '▾';
  });
  $$('#feed-tabs button').forEach((b) => b.addEventListener('click', () => {
    ui.feedFilter = b.dataset.f;
    $$('#feed-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderFeed();
  }));
  $('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('click', (e) => {
    const w = e.target.closest('[data-agent]');
    if (w && !e.target.closest('#modal-card canvas')) { app.select(w.dataset.agent); }
    if (!e.target.closest('#weather-menu, #btn-weather')) $('#weather-menu').hidden = true;
  });
  if (!app.storage.get('town-help-seen')) { app.storage.set('town-help-seen', '1'); setTimeout(helpModal, 1200); }
}

// ---------- 每帧 ----------
export function frame(S) {
  const m = S.t % 1440, h = m / 60;
  $('#clock-time').textContent = fmtTime(S.t);
  const w = app.weathers[S.weatherId] || { emoji: '', name: S.weatherId };
  $('#clock-date').textContent = `第${S.day}天 · ${weekday(S.day)} · ${w.emoji} ${w.name}`;
  $('#clock-sky').textContent = h < 5 || h >= 20 ? '🌙' : h < 7 ? '🌅' : h >= 17 ? '🌇' : w.emoji;
  $('#clock-progress').style.width = `${(m / 1440) * 100}%`;
  $('#clock-date').textContent += app.snap.nightSkip ? ' · 🌙 夜深了，时间加速中' : '';
  // 顶栏节日标签：显示下一个（或正在进行的）需要倒计时的日历事件
  const fc = $('#festival-chip');
  const evs = (app.spec?.calendar.events || []).filter((e) => e.countdown).sort((x, y) => x.day - y.day);
  const ev = evs.find((e) => e.day >= S.day) || evs[evs.length - 1];
  if (ev) {
    const d = ev.day - S.day;
    const from = Number(String(ev.from).split(':')[0]) || 0;
    fc.textContent = d > 0 ? `${ev.emoji} ${ev.name} · 还有${d}天` : d === 0 ? (h >= from ? `${ev.emoji} ${ev.name}进行中！` : `${ev.emoji} 今晚${ev.name}！`) : `${ev.emoji} ${ev.name}已落幕`;
  }
  fc.hidden = !ev;
  fc.classList.toggle('live', (ev && ev.day === S.day) || app.forceFestival);
  const sp = app.snap;
  $$('#speed button').forEach((b) => {
    const v = Number(b.dataset.speed);
    b.classList.toggle('on', v === 0 ? sp.paused : !sp.paused && v === sp.speed);
  });
  const now = performance.now();
  if (now - ui.rosterT > 400) { ui.rosterT = now; refreshRoster(); }
  if (app.selected && now - ui.refreshT > 5000) { ui.refreshT = now; loadDetail(); }
}

// ---------- 名册 ----------
function buildRoster() {
  $('#roster').innerHTML = Object.values(app.meta).map((a) => `
    <div class="rcard" data-id="${a.id}">
      <img src="${a.portrait}" alt="">
      <span class="rmood"></span>
      <div class="rinfo"><div class="rname">${esc(a.name)} <small>${esc(a.role.split(/[（/]/)[0])}</small></div><div class="ract"></div></div>
    </div>`).join('');
  $$('#roster .rcard').forEach((c) => c.addEventListener('click', () => app.select(c.dataset.id)));
}
export function refreshRoster() {
  if (!app.snap) return;
  for (const a of app.snap.agents) {
    const c = $(`#roster .rcard[data-id="${a.id}"]`);
    if (!c) continue;
    c.classList.toggle('sel', app.selected === a.id);
    c.classList.toggle('thinking', !!a.thinking);
    c.classList.toggle('chatting', a.status === 'chatting');
    c.classList.toggle('sleeping', a.status === 'sleeping');
    c.querySelector('.rmood').textContent = a.mood || '';
    c.querySelector('.ract').textContent = a.thinking ? `✦ ${a.thinking}…` : a.status === 'chatting' ? `💬 与${name(app.snap.convos.find((x) => x.id === a.convo)?.[app.snap.convos.find((x) => x.id === a.convo)?.a === a.id ? 'b' : 'a'])}聊天` : `${a.emoji} ${a.action}`;
  }
}

// ---------- 提示 ----------
export function tooltip(id, x, y) {
  const t = $('#tooltip');
  if (!id) { t.hidden = true; return; }
  const a = app.snap.agents.find((q) => q.id === id);
  t.hidden = false;
  t.innerHTML = `<b>${esc(name(id))}</b> <span style="color:var(--muted)">${esc(app.meta[id].role)}</span><br>${esc(a.emoji)} ${esc(a.action)}${a.thinking ? `<br><span style="color:#c4b5fd">✦ ${esc(a.thinking)}…</span>` : ''}`;
  t.style.left = `${x + 16}px`; t.style.top = `${y + 12}px`;
}

export function toast(html, ms = 4200) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
}

// ---------- 权限 ----------
export function applyPerms() {
  const p = app.perms;
  $('#speed').hidden = !p.admin;
  $('#mode-chip').hidden = p.admin;
  $('#mode-chip').textContent = p.interaction ? '🌿 访客模式' : '👀 观赏模式';
  $('#btn-event').hidden = !p.interaction;
  $('#btn-weather').hidden = !p.interaction;
  if (!p.interaction && ui.tab === 'chat') ui.tab = 'sched';
}

// ---------- 控制 ----------
const guarded = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
};
export const setSpeed = guarded(async (sp) => {
  if (!app.perms.admin) return;
  await app.api('/api/control', { speed: sp, paused: false });
});
export const togglePause = guarded(async () => {
  if (!app.perms.admin) return;
  await app.api('/api/control', { paused: !app.snap.paused });
});
export function escape() {
  if (!$('#modal').hidden) return closeModal();
  if (!$('#inspector').hidden) return closeInspector();
}
function weatherMenu(btn) {
  const m = $('#weather-menu');
  if (!m.hidden) { m.hidden = true; return; }
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.min(innerWidth - 256, r.left)}px`; m.style.top = `${r.bottom + 8}px`;
  m.innerHTML = `<button data-w="auto">🔄 自动变化</button>` + Object.entries(app.weathers).map(([k, w]) => `<button data-w="${k}" class="${app.snap.weather === k ? 'on' : ''}">${w.emoji} ${w.name}</button>`).join('');
  m.hidden = false;
  $$('button', m).forEach((b) => b.addEventListener('click', guarded(async () => {
    m.hidden = true;
    await app.api('/api/control', { weather: b.dataset.w });
  })));
}

// ---------- 动态流 ----------
const FEED_GROUPS = { convo: ['convo'], thought: ['thought'], event: ['event', 'reflect', 'commit', 'visitor', 'reaction', 'plan', 'news', 'diary', 'world'] };
function feedItemHTML(l) {
  const faces = (l.agents || []).slice(0, 4).map((id) => `<img src="${face(id)}" alt="">`).join('');
  const t = fmtTime(l.t);
  if (l.type === 'convo') {
    return `<div class="fi convo" data-convo="${l.id}">
      <div class="ft"><span class="faces">${faces}</span>&nbsp; ${t} · ${esc(l.where || '')} · 💬 ${(l.lines || []).length} 句</div>
      <div><span class="who" data-agent="${l.agents[0]}">${esc(name(l.agents[0]))}</span> × <span class="who" data-agent="${l.agents[1]}">${esc(name(l.agents[1]))}</span>：${esc(l.text)}</div>
      ${(l.commitments || []).length ? `<div style="color:var(--sakura);font-size:11.5px;margin-top:3px">📌 ${l.commitments.map(esc).join('；')}</div>` : ''}
      <div class="lines">${(l.lines || []).map((x) => `<div class="line"><img src="${face(x.speaker)}"><b>${esc(name(x.speaker))}</b><span>${esc(x.text)}</span></div>`).join('')}</div>
    </div>`;
  }
  const icon = { thought: '💭', reflect: '✨', event: '📢', commit: '', visitor: '', reaction: '❗', plan: '🗓️', news: '', diary: '📖', weather: '', system: '', world: '' }[l.type] ?? '';
  const who = (l.agents || []).length === 1 && ['thought', 'reflect', 'reaction', 'plan', 'diary'].includes(l.type)
    ? `<span class="who" data-agent="${l.agents[0]}">${esc(name(l.agents[0]))}</span>${l.type === 'thought' ? '：' : ' '}` : '';
  let text = esc(l.text);
  if (who && text.startsWith(esc(name(l.agents[0])))) text = text.slice(esc(name(l.agents[0])).length).replace(/^[：\s]/, '');
  if (l.type === 'system' || l.type === 'weather') return `<div class="fi ${l.type}">${t} · ${text}</div>`;
  return `<div class="fi ${l.type}" ${l.type === 'news' ? 'data-news="1"' : ''}>
    <div class="ft">${faces ? `<span class="faces">${faces}</span>&nbsp;` : ''} ${t}</div>
    <div>${icon} ${who}${text}</div></div>`;
}
function renderFeed() {
  const f = ui.feedFilter;
  const items = app.logs.filter((l) => f === 'all' || FEED_GROUPS[f]?.includes(l.type)).slice(-120).reverse();
  $('#feed-list').innerHTML = items.map(feedItemHTML).join('') || '<div class="empty">小镇刚刚苏醒，故事即将开始……</div>';
  bindFeed($('#feed-list'));
}
function bindFeed(root) {
  $$('.fi.convo', root).forEach((el) => el.addEventListener('click', (e) => { if (!e.target.closest('[data-agent]')) el.classList.toggle('open'); }));
  $$('.fi[data-news]', root).forEach((el) => el.addEventListener('click', () => newsModal()));
}
export function onLog(l) {
  app.logs.push(l);
  if (app.logs.length > 400) app.logs.shift();
  const f = ui.feedFilter;
  if (f === 'all' || FEED_GROUPS[f]?.includes(l.type)) {
    const list = $('#feed-list');
    $('.empty', list)?.remove();
    const tmp = document.createElement('div');
    tmp.innerHTML = feedItemHTML(l);
    const el = tmp.firstElementChild;
    list.prepend(el);
    if (el.classList.contains('convo')) el.addEventListener('click', (e) => { if (!e.target.closest('[data-agent]')) el.classList.toggle('open'); });
    if (el.dataset.news) el.addEventListener('click', () => newsModal());
    while (list.children.length > 150) list.lastChild.remove();
  }
  if (l.type === 'event') app.board.push(l);
  if (l.type === 'event') toast(`📢 ${esc(l.text)}`, 6000);
  if (l.type === 'commit') toast(esc(l.text));
  if (l.type === 'reflect') toast(`✨ ${esc(l.text)}`, 5000);
  if (l.type === 'weather') toast(esc(l.text), 2500);
  if (l.agents?.includes(app.selected)) scheduleDetail();
}
export function onWorld(w) {
  toast(`🌀 ${esc(w.desc || w.op?.op || '')}`, 5000);
}
export function onNewspaper(p) {
  app.newspapers.push(p);
  toast(`📰 新一期《云溪日报》出炉：<b>${esc(p.headline)}</b>`, 7000);
}

// ---------- AI 大脑 ----------
export function updateBrain() {
  const s = app.llm;
  if (!s) return;
  $('#brain-dot').className = `brain-dot ${s.inflight ? 'on' : ''} ${!s.enabled ? 'err' : ''}`;
  $('#brain-model').textContent = s.enabled ? s.model : '未配置 LLM';
  const tk = s.tokens > 1e6 ? `${(s.tokens / 1e6).toFixed(2)}M` : `${(s.tokens / 1000).toFixed(1)}k`;
  const fmtK = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const budget = s.dailyBudget ? `<span title="今日令牌用量 / 每日预算">今日 ${fmtK(s.dayTokens)}/${fmtK(s.dailyBudget)}</span>` : `<span>令牌 ${tk}</span>`;
  $('#brain-stats').innerHTML = `<span>调用 ${s.ok}</span>${budget}<span>均 ${(s.avgMs / 1000).toFixed(1)}s</span>${app.snap?.idle ? '<span>💤</span>' : ''}${s.queued ? `<span>排队 ${s.queued}</span>` : ''}${s.errors ? `<span style="color:var(--bad)" title="${esc(s.lastError)}">错误 ${s.errors}</span>` : ''}`;
  $('#brain-active').innerHTML = s.active.slice(0, 6).map((x) => `<div class="bact"><b>${esc(x.agent || '')}</b> ${esc(x.label)}<span>${(x.ms / 1000).toFixed(0)}s</span></div>`).join('') || '<div style="color:var(--muted)">静候灵感中…</div>';
}

// ---------- 检查器 ----------
export function openInspector(id) {
  if (!id) return closeInspector();
  const insp = $('#inspector');
  const sameAgent = ui.detail?.id === id && !insp.hidden;
  insp.hidden = false;
  if (!sameAgent) {
    ui.detail = null;
    $('#insp-body').innerHTML = '<div class="empty">正在读取记忆……</div>';
  }
  loadDetail();
}
function closeInspector() {
  $('#inspector').hidden = true;
  app.selected = null;
  app.follow = null;
  ui.detail = null;
  refreshRoster();
}
let detailTimer = null;
function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(loadDetail, 350);
}
export function onAgentChanged(id) {
  if (id === app.selected) scheduleDetail();
}
async function loadDetail() {
  const id = app.selected;
  if (!id) return;
  try {
    const d = await app.api(`/api/agent/${id}`);
    if (app.selected !== id) return;
    const fresh = ui.detail?.id !== id;
    ui.detail = d;
    renderInspector(fresh);
  } catch (e) { console.warn(e); }
}

const MEM_ICON = { obs: '👁️', convo: '💬', thought: '💭', reflect: '✨', plan: '🗓️', event: '📢', chat: '🧳', diary: '📖' };
const STATUS = { walking: '🚶 移动中', acting: '🎯 活动中', chatting: '💬 交谈中', sleeping: '😴 睡觉', idle: '🙂 空闲' };

function renderInspector(fresh) {
  const d = ui.detail;
  const body = $('#insp-body');
  if (fresh || !$('#ih', body)) {
    body.innerHTML = `
      <div class="ihead" id="ih"></div>
      <div class="inow" id="inow"></div>
      <div class="itabs">
        ${[['sched', '🗓️ 日程'], ['mem', '🧠 记忆'], ['rel', '💞 关系'], ['diary', '📖 日记'], ...(app.perms.interaction ? [['chat', '💬 交谈']] : [])].map(([k, l]) => `<button data-t="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <div class="ipane" id="ipane"></div>`;
    $$('.itabs button', body).forEach((b) => b.addEventListener('click', () => {
      ui.tab = b.dataset.t;
      $$('.itabs button', body).forEach((x) => x.classList.toggle('on', x === b));
      renderPane(true);
    }));
  }
  const m = app.meta[d.id];
  $('#ih').style.setProperty('--hc', m.look.shirt);
  $('#ih').innerHTML = `
    <img src="${m.portrait}" alt="">
    <div style="flex:1;min-width:0">
      <h2>${esc(d.name)}</h2>
      <div class="role">${d.age}岁 · ${esc(d.role)}</div>
      <div class="pills">
        <span class="pill st-${d.status}">${STATUS[d.status] || d.status}</span>
        <span class="pill">${esc(d.mood.emoji)} ${esc(d.mood.text)}</span>
        ${d.thinking ? `<span class="pill think">✦ ${esc(d.thinking)}…</span>` : ''}
      </div>
      <div class="ibtns">
        <button id="b-follow" class="${app.follow === d.id ? 'on' : ''}">🎥 跟随</button>
        ${app.perms.interaction ? '<button id="b-chat">💬 搭话</button><button id="b-whisper">💭 心声</button>' : ''}
      </div>
    </div>`;
  $('#b-follow').onclick = () => { app.follow = app.follow === d.id ? null : d.id; renderInspector(false); };
  if ($('#b-chat')) $('#b-chat').onclick = () => { ui.tab = 'chat'; ui.chatMode = 'visitor'; renderInspector(true); };
  if ($('#b-whisper')) $('#b-whisper').onclick = () => { ui.tab = 'chat'; ui.chatMode = 'whisper'; renderInspector(true); };
  $('#inow').innerHTML = `
    <div class="act">${esc(d.action.emoji)} ${esc(d.action.text)}</div>
    <div class="where">📍 ${esc(d.locName)}</div>
    ${d.thought ? `<div class="thought">“${esc(d.thought)}”</div>` : ''}
    <div class="goal"><b>长期目标</b> ${esc(d.goal)}</div>
    ${d.todayGoal ? `<div class="goal"><b>今日心愿</b> ${esc(d.todayGoal)}</div>` : ''}`;
  renderPane(fresh);
}

function renderPane(reset) {
  const d = ui.detail;
  const pane = $('#ipane');
  if (!pane || !d) return;
  const scroll = pane.scrollTop;
  if (ui.tab === 'chat') return renderChat(reset);
  if (ui.tab === 'sched') {
    const now = app.snap.t % 1440;
    pane.innerHTML = d.schedule.length ? `<div class="sched">${d.schedule.map((e) => {
      const cls = now >= e.end ? 'past' : now >= e.start ? 'now' : '';
      return `<div class="sitem ${cls} ${e.src === 'commit' ? 'commit' : ''}"><div class="se">${esc(e.emoji)}</div><div><div class="st">${e.time}${e.src === 'commit' ? ' · 📌 约定' : ''}</div><div class="sa">${esc(e.activity)}</div><div class="sl">📍 ${esc(e.locName)}</div></div></div>`;
    }).join('')}</div>` : '<div class="empty">🧠 正在规划今天的日程……</div>';
    if (reset) $('.sitem.now', pane)?.scrollIntoView({ block: 'center' });
  } else if (ui.tab === 'mem') {
    const filters = [['all', '全部'], ['reflect', '✨ 反思'], ['convo', '💬 对话'], ['thought', '💭 想法'], ['event', '📢 事件'], ['chat', '🧳 旅人']];
    const list = d.memories.filter((mm) => ui.memFilter === 'all' || mm.type === ui.memFilter);
    pane.innerHTML = `<div class="mfilter">${filters.map(([k, l]) => `<button data-m="${k}" class="${ui.memFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>` +
      (list.map((mm) => `<div class="mem ${mm.type}"><div class="mi">${MEM_ICON[mm.type] || '•'}</div><div><div>${esc(mm.text)}</div><div class="mt"><span>${mm.stamp}</span><span class="imp" title="重要性 ${mm.importance}">${'●'.repeat(Math.ceil(mm.importance / 2))}</span></div></div></div>`).join('') || '<div class="empty">暂无记忆</div>');
    $$('.mfilter button', pane).forEach((b) => b.addEventListener('click', () => { ui.memFilter = b.dataset.m; renderPane(true); }));
  } else if (ui.tab === 'rel') {
    pane.innerHTML = d.relations.map((r) => {
      const v = r.affinity, w = Math.abs(v) / 2;
      const col = v >= 0 ? `linear-gradient(90deg,#5ad1c3,#7ddc8a)` : `linear-gradient(90deg,#ff7a7a,#ffae7a)`;
      return `<div class="rel" data-agent="${r.id}"><img src="${face(r.id)}"><div class="rb"><div class="rn">${esc(r.name)}<span style="color:${v >= 0 ? 'var(--good)' : 'var(--bad)'}">${v > 0 ? '+' : ''}${v}</span></div>
        <div class="bar"><i style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${col}"></i></div><div class="note">${esc(r.note)}</div></div></div>`;
    }).join('') || '<div class="empty">还没有建立关系</div>';
  } else if (ui.tab === 'diary') {
    pane.innerHTML = d.diary.map((x) => `<div class="diary"><h4>第 ${x.day} 天 · ${weekday(x.day)}</h4>${esc(x.text)}</div>`).join('') || '<div class="empty">📖 每晚 22:15 左右，居民会写下当天的日记</div>';
  }
  if (!reset) pane.scrollTop = scroll;
}

function renderChat(reset) {
  const d = ui.detail;
  const pane = $('#ipane');
  if (reset || !$('.chatbox', pane)) {
    pane.innerHTML = `<div class="chatbox">
      <div class="chatmode">
        <button data-mode="visitor" class="${ui.chatMode === 'visitor' ? 'on' : ''}">🧳 以旅人身份搭话<small>TA 会记住你说的话，并可能转告他人</small></button>
        <button data-mode="whisper" class="${ui.chatMode === 'whisper' ? 'on' : ''}">💭 化作心声<small>TA 会以为这是自己的念头</small></button>
      </div>
      <div class="chatlog" id="chatlog"></div>
      <div class="quota" id="chatquota"></div>
      <form class="chatin" id="chatform"><input id="chatinput" maxlength="200" autocomplete="off" placeholder="${ui.chatMode === 'whisper' ? '在 TA 心里种下一个念头…' : `对${esc(d.name)}说点什么…`}"><button class="send" id="chatsend">发送</button></form>
    </div>`;
    $$('.chatmode button', pane).forEach((b) => b.addEventListener('click', () => { ui.chatMode = b.dataset.mode; renderChat(true); }));
    $('#chatform').addEventListener('submit', sendChat);
    setTimeout(() => $('#chatinput')?.focus(), 50);
  }
  const log = $('#chatlog');
  const q = app.perms.remaining?.chat;
  const qEl = $('#chatquota');
  if (qEl) qEl.textContent = q == null ? '' : `本小时还可以说 ${q} 句话 · 请友善发言，内容会经过审核`;
  const html = (d.chat.length ? d.chat.map((c) => `<div class="msg ${c.from === 'user' ? 'user' : 'agent'}">${esc(c.text)}</div>`).join('') : `<div class="msg sys">和${esc(d.name)}聊聊吧——告诉 TA 一个秘密，看看消息会不会在小镇里传开 👀</div>`) + (ui.pending ? '<div class="msg agent typing">✦ 正在思考怎么回答…</div>' : '') + (ui.chatError ? `<div class="msg sys err">⚠️ ${esc(ui.chatError)}</div>` : '');
  if (log.dataset.h !== html) { log.innerHTML = html; log.dataset.h = html; log.scrollTop = log.scrollHeight; }
}

async function sendChat(e) {
  e.preventDefault();
  const input = $('#chatinput');
  const text = input.value.trim();
  if (!text || ui.pending) return;
  const d = ui.detail;
  input.value = '';
  d.chat.push({ from: 'user', text });
  ui.pending = true;
  ui.chatError = '';
  renderChat(false);
  try {
    const r = await app.api('/api/chat', { id: d.id, text, mode: ui.chatMode });
    if (r.remaining) app.perms.remaining = r.remaining;
    if (r.plan) toast(`📌 ${esc(d.name)} 改变了计划：${esc(r.plan)}`);
  } catch (err) {
    ui.chatError = err.message;
    input.value = text;
  } finally {
    ui.pending = false;
    await loadDetail();
  }
}

// ---------- 弹窗 ----------
function openModal(html, cls = '') {
  const card = $('#modal-card');
  card.className = `modal-card ${cls}`;
  card.innerHTML = `<button class="modal-x" id="modal-x">✕</button>${html}`;
  $('#modal').hidden = false;
  $('#modal-x').onclick = closeModal;
  return card;
}
function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; }

const PRESETS = [
  '🎆 今晚八点，中央广场将举办一场神秘的烟花表演！',
  '🍉 陈家农场西瓜大丰收，下午五点在农场免费请全镇吃西瓜！',
  '🌊 有人在镜湖码头捡到一个漂流瓶，里面是半张藏宝图。',
  '💌 公告栏上出现一封匿名情书，收信人写着“咖啡馆的她”。',
  '🎪 流动马戏团明天抵达，今天下午在广场招募帮手。',
  '⚡ 气象台预警：今晚有雷暴，请大家早点回家。',
  '🎤 萤火节音乐会招募表演者，报名处设在星光咖啡馆。',
  '🐱 孙婆婆的猫走丢了，最后有人在樱花公园见过它。',
];
function eventModal() {
  const opts = ['<option value="all">📢 全镇公告（所有人都会知道）</option>', ...Object.values(app.meta).map((a) => `<option value="${a.id}">✨ 只让 ${esc(a.name)} 知道（看消息如何传开）</option>`)].join('');
  const card = openModal(`
    <h2>📢 发布小镇事件</h2>
    <div class="sub">你是这座小镇的命运之手。写下一个事件，居民们会根据各自的性格、记忆与关系作出反应，并重新规划今天。</div>
    <textarea id="ev-text" rows="3" maxlength="120" style="width:100%" placeholder="例如：今晚八点，中央广场将举办一场神秘的烟花表演！"></textarea>
    <div class="presets">${PRESETS.map((p) => `<button>${esc(p)}</button>`).join('')}</div>
    <div class="row"><select id="ev-target">${opts}</select></div>
    <div class="row" style="justify-content:space-between"><span class="quota" id="ev-msg">${app.perms.admin ? '管理员不受频率限制' : `本小时还可发布 ${app.perms.remaining?.event ?? '-'} 次 · 事件会经过审核，请保持温馨友善`}</span>
      <span style="display:flex;gap:10px"><button class="ghost" id="ev-cancel">取消</button><button class="primary" id="ev-go">发布 ✨</button></span></div>`);
  card.style.width = 'min(640px, 94vw)';
  $$('.presets button', card).forEach((b) => b.addEventListener('click', () => { $('#ev-text').value = b.textContent.replace(/^\S+\s/, ''); }));
  $('#ev-cancel').onclick = closeModal;
  $('#ev-go').onclick = async (e) => {
    const text = $('#ev-text').value.trim();
    if (!text) return;
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '审核中…';
    try {
      const r = await app.api('/api/event', { text, target: $('#ev-target').value });
      if (r.remaining) app.perms.remaining = r.remaining;
      closeModal();
      toast('🌀 消息已送达，居民们正在重新盘算……');
    } catch (err) {
      $('#ev-msg').innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(err.message)}</span>`;
      btn.disabled = false; btn.textContent = '发布 ✨';
    }
  };
}

async function newsModal(idx) {
  const papers = app.newspapers;
  if (!papers.length) {
    const card = openModal(`<div class="paper"><div class="masthead"><h1>云溪日报</h1></div><div class="paper-empty">
      <p>📰 本报每晚 22:45 出版，记录小镇一天里的大事小情。</p><p>今天的新闻还在发生中……</p>
      ${app.perms.admin ? '<button class="primary" id="np-now">📝 立即出版今日号外</button>' : ''}</div></div>`, 'paper-wrap');
    if ($('#np-now', card)) $('#np-now', card).onclick = publishNow;
    return;
  }
  const i = idx ?? papers.length - 1;
  const p = papers[i];
  const card = openModal(`
    <div class="paper-tabs">${papers.map((x, j) => `<button data-i="${j}" class="${i === j ? 'on' : ''}">第${x.day}天</button>`).join('')}${app.perms.admin ? '<button id="np-now" style="margin-left:auto">📝 出版号外</button>' : ''}</div>
    <div class="paper">
      <div class="masthead"><h1>云溪日报</h1>
        <div class="meta"><span>第 ${p.day} 期 · ${esc(p.weekday || '')}</span><span>YUNXI DAILY</span><span>天气：${esc(app.weathers[p.weather]?.name || '')} · 售价 两颗西瓜籽</span></div></div>
      <div class="headline">${esc(p.headline)}</div>
      <div class="subhead">${esc(p.subhead || '')}</div>
      <div class="lead">${esc(p.lead || '')}</div>
      <div class="cols">${(p.articles || []).slice(0, 3).map((a) => `<article><h3>${esc(a.title)}</h3>${esc(a.body)}</article>`).join('')}</div>
      <div class="pfoot">
        <div class="gossip"><b>🗣️ 街头巷尾</b><br>${esc(p.gossip || '')}</div>
        <div><div class="quote">“${esc(p.quote?.text || '')}”</div><div style="text-align:right">—— ${esc(p.quote?.who || '')}</div>
        <div style="margin-top:8px"><b>明日预告：</b>${esc(p.forecast || '')}</div></div>
      </div>
    </div>`, 'paper-wrap');
  $$('.paper-tabs button[data-i]', card).forEach((b) => b.addEventListener('click', () => newsModal(Number(b.dataset.i))));
  if ($('#np-now', card)) $('#np-now', card).onclick = publishNow;
}
async function publishNow(e) {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = '✒️ 主编正在奋笔疾书……';
  try {
    await app.api('/api/newspaper', {});
    newsModal();
  } catch (err) {
    b.disabled = false; b.textContent = '📝 重试';
    toast(`⚠️ 出版失败：${esc(err.message)}`);
  }
}

async function graphModal() {
  const card = openModal(`<h2>🕸️ 关系网络</h2><div class="sub">箭头表示“谁对谁”的好感，颜色越绿越亲近、越红越疏远；悬停头像查看细节，点击头像查看居民。</div>
    <canvas id="graph"></canvas>
    <div class="legend"><span><i style="background:#7ddc8a"></i>亲近</span><span><i style="background:#8a8aa0"></i>普通</span><span><i style="background:#ff7a7a"></i>疏远</span></div>
    <div id="graph-info" style="min-height:70px;margin-top:10px;font-size:12.5px"></div>`, 'graph-wrap');
  const data = await app.api('/api/relations');
  const cv = $('#graph', card);
  const dpr = devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  const n = data.length;
  const R = Math.min(W, H) * 0.38;
  const pos = Object.fromEntries(data.map((a, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [a.id, [W / 2 + Math.cos(ang) * R, H / 2 + Math.sin(ang) * R]];
  }));
  const imgs = Object.fromEntries(data.map((a) => { const im = new Image(); im.src = face(a.id); return [a.id, im]; }));
  let hover = null, t0 = performance.now();
  const colorOf = (v) => v >= 0 ? `rgba(${Math.round(138 - v)},${Math.round(138 + v * 0.8)},${Math.round(160 - v * 0.2)},` : `rgba(255,${Math.round(122 + v * 0.5)},${Math.round(122 + v * 0.5)},`;
  function draw() {
    if (!document.body.contains(cv)) return;
    const t = (performance.now() - t0) / 1000;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    for (const a of data) for (const r of a.relations) {
      if (!pos[r.id]) continue;
      const on = !hover || hover === a.id || hover === r.id;
      const [x1, y1] = pos[a.id], [x2, y2] = pos[r.id];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const nx = -(y2 - y1) * 0.12, ny = (x2 - x1) * 0.12;
      const cx = mx + nx, cy = my + ny;
      const v = r.affinity;
      g.strokeStyle = colorOf(v) + (on ? 0.9 : 0.08) + ')';
      g.lineWidth = 1 + Math.abs(v) / 18;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke();
      // 流动的光点
      if (on) {
        const p = (t * 0.35 + (a.id.length + r.id.length) * 0.13) % 1;
        const px = (1 - p) ** 2 * x1 + 2 * (1 - p) * p * cx + p * p * x2, py = (1 - p) ** 2 * y1 + 2 * (1 - p) * p * cy + p * p * y2;
        g.fillStyle = colorOf(v) + '1)';
        g.beginPath(); g.arc(px, py, 2.5, 0, 7); g.fill();
      }
      // 箭头
      const k = 0.78;
      const ax = (1 - k) ** 2 * x1 + 2 * (1 - k) * k * cx + k * k * x2, ay = (1 - k) ** 2 * y1 + 2 * (1 - k) * k * cy + k * k * y2;
      const ang = Math.atan2(y2 - cy, x2 - cx);
      g.fillStyle = colorOf(v) + (on ? 0.9 : 0.08) + ')';
      g.beginPath(); g.moveTo(ax + Math.cos(ang) * 7, ay + Math.sin(ang) * 7); g.lineTo(ax + Math.cos(ang + 2.5) * 7, ay + Math.sin(ang + 2.5) * 7); g.lineTo(ax + Math.cos(ang - 2.5) * 7, ay + Math.sin(ang - 2.5) * 7); g.fill();
    }
    for (const a of data) {
      const [x, y] = pos[a.id];
      const s = hover === a.id ? 64 : 54;
      g.save();
      g.shadowColor = hover === a.id ? '#ffb86b' : 'rgba(0,0,0,.5)'; g.shadowBlur = hover === a.id ? 24 : 10;
      g.beginPath(); g.arc(x, y, s / 2, 0, 7); g.fillStyle = '#222'; g.fill();
      g.restore();
      g.imageSmoothingEnabled = false;
      if (imgs[a.id].complete) g.drawImage(imgs[a.id], x - s / 2, y - s / 2, s, s);
      g.fillStyle = '#fff'; g.font = '600 13px "PingFang SC",sans-serif'; g.textAlign = 'center';
      g.fillText(a.name, x, y + s / 2 + 16);
    }
    requestAnimationFrame(draw);
  }
  draw();
  const info = $('#graph-info', card);
  const hitNode = (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return data.find((a) => Math.hypot(pos[a.id][0] - x, pos[a.id][1] - y) < 30)?.id || null;
  };
  cv.addEventListener('mousemove', (e) => {
    const id = hitNode(e);
    cv.style.cursor = id ? 'pointer' : 'default';
    if (id === hover) return;
    hover = id;
    if (!id) { info.innerHTML = ''; return; }
    const a = data.find((x) => x.id === id);
    const inbound = data.flatMap((o) => o.relations.filter((r) => r.id === id).map((r) => ({ from: o.id, ...r })));
    info.innerHTML = `<b>${esc(a.name)} 眼中的别人：</b> ${a.relations.map((r) => `${esc(name(r.id))}(<span style="color:${r.affinity >= 0 ? 'var(--good)' : 'var(--bad)'}">${r.affinity}</span>) ${esc(r.note)}`).join('；')}<br><b style="color:var(--muted)">别人眼中的 TA：</b> ${inbound.map((r) => `${esc(name(r.from))}：${esc(r.note)}`).join('；')}`;
  });
  cv.addEventListener('click', (e) => { const id = hitNode(e); if (id) { closeModal(); app.select(id); } });
}

function helpModal() {
  openModal(`<h2>🌸 欢迎来到云溪镇</h2>
  <div class="sub">一座由大语言模型驱动的生成式智能体小镇。8 位居民各有性格、记忆、秘密和目标，他们会自己规划一天、相遇交谈、传播消息、反思成长。</div>
  <ul>
    <li>🗓️ <b>自主规划</b>：每天清晨，每位居民根据人设、昨天的日记和记忆制定日程。</li>
    <li>💬 <b>自然交谈</b>：居民相遇时会根据彼此的关系与记忆展开对话，达成约定后会真的赴约。</li>
    <li>🧠 <b>记忆与反思</b>：每段经历都写入记忆流，按时近性、重要性、相关性检索；积累够了会产生更深的领悟。</li>
    <li>📖 <b>日记与日报</b>：每晚居民写日记，《云溪日报》为全镇出一期报纸。</li>
    <li>🏮 <b>主线</b>：周六（第 4 天）晚上是萤火节——音乐会、热气球、匿名信、镜湖传说……结局由他们自己书写。</li>
  </ul>
  <b>你可以：</b>
  <ul>
    <li>点击居民查看 TA 的日程、记忆、关系与日记；<b>💬 以旅人身份搭话</b>或<b>💭 化作心声</b>，悄悄影响 TA。</li>
    <li>📢 发布小镇事件，看居民如何反应、消息如何在人群中扩散。</li>
    <li>⛅ 操控天气，🕸️ 查看关系网络，📰 翻阅日报。</li>
  </ul>
  <div class="sub" style="margin-top:10px">操作：拖拽平移 · 滚轮缩放 · <kbd>WASD</kbd> 移动 ${app.perms.admin ? '· <kbd>空格</kbd> 暂停 · <kbd>1-4</kbd> 调速 ' : ''}· <kbd>Tab</kbd> 切换居民 · <kbd>F</kbd> 跟随 · <kbd>Esc</kbd> 关闭</div>
  ${app.perms.publicMode && !app.perms.admin ? `<div class="sub" style="margin-top:10px">🌿 你正以访客身份参观：可以搭话、发布事件和改变天气（有频率限制，内容会经过审核）；时间流速由小镇管理员掌管。</div>` : ''}
  ${app.perms.needToken ? `<details class="admin-box"><summary>🔐 管理员</summary>
    <form id="admin-form" class="chatin" style="margin-top:8px">${app.perms.admin ? '<span class="quota" style="flex:1">已登录为管理员</span><button class="ghost" type="button" id="admin-out">退出</button>' : '<input id="admin-token" type="password" autocomplete="current-password" placeholder="管理员令牌"><button class="send">登录</button>'}</form></details>` : ''}
  <div class="row" style="justify-content:space-between">${app.perms.admin ? '<button class="ghost" id="help-reset">🔄 重置小镇</button>' : '<span></span>'}<button class="primary" id="help-ok">开始观察 ✨</button></div>`, 'help');
  $('#help-ok').onclick = closeModal;
  $('#admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    app.storage.set('town-admin', $('#admin-token').value.trim());
    await app.refreshPerms();
    if (app.perms.admin) { toast('🔐 已登录为管理员'); closeModal(); }
    else { app.storage.set('town-admin', null); toast('⚠️ 令牌不正确'); }
  });
  $('#admin-out')?.addEventListener('click', async () => {
    app.storage.set('town-admin', null);
    await app.refreshPerms();
    closeModal();
    toast('已退出管理员');
  });
  $('#help-reset')?.addEventListener('click', guarded(async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '⚠️ 再点一次：重新开始（旧存档会自动备份）'; return; }
    await app.api('/api/reset', { confirm: 'RESET' });
    closeModal();
    closeInspector();
    toast('🌱 小镇回到了第一天的清晨');
  }));
}
