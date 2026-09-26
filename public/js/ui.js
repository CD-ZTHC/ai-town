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
  onRegions();
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
  $('#story-chip').addEventListener('click', () => storyModal());
  $('#btn-build').addEventListener('click', () => buildModal());
  $('#btn-evolve').addEventListener('click', () => evolveModal());
  $('#btn-avatar').addEventListener('click', () => avatarModal());
  $('#region-chip').addEventListener('click', () => app.setView(app.view === 'town' ? nextRegion() : 'town'));
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
  $('#clock-date').textContent += app.snap.nightSkip ? ' · 🌙 夜深了，时间加速中' : app.snap.paced ? ' · 🧠 大家在思考，时间放慢了' : '';
  // 顶栏节日标签：显示下一个（或正在进行的）需要倒计时的日历事件
  // 故事标签：张力 + 剧情阶段；有抉择时闪烁
  const st = app.snap.story;
  const sc = $('#story-chip');
  if (st) {
    const PH = { omen: '伏笔', breach: '爆发', struggle: '发展', climax: '高潮', aftermath: '余波' };
    sc.textContent = st.vote ? '🗳️ 抉择进行中！' : `🎭 ${st.tension != null ? `张力 ${st.tension}` : '故事'}${st.arc ? ` · ${PH[st.arc] || st.arc}` : ''}`;
    sc.classList.toggle('live', Boolean(st.vote));
  }
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
  t.innerHTML = `<b>${esc(name(id))}</b> <span style="color:var(--muted)">${esc(app.meta[id]?.role || '')}</span><br>${esc(a.emoji)} ${esc(a.action)}${a.thinking ? `<br><span style="color:#c4b5fd">✦ ${esc(a.thinking)}…</span>` : ''}`;
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
  $('#btn-avatar').hidden = !p.interaction;
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
const STORY_TYPES = ['proposal', 'idea', 'arc', 'omen', 'thread', 'portal', 'creature', 'encounter', 'mischief', 'arrival', 'depart', 'vote', 'vote_cast', 'scene', 'scene_plan', 'news_spread', 'growth'];
const FEED_GROUPS = { convo: ['convo', 'scene'], thought: ['thought'], event: ['event', 'reflect', 'commit', 'visitor', 'reaction', 'plan', 'news', 'diary', 'world', 'ability', 'learn', 'gift', 'effect'], story: STORY_TYPES };
function feedItemHTML(l) {
  const faces = (l.agents || []).slice(0, 4).map((id) => `<img src="${face(id)}" alt="">`).join('');
  const t = fmtTime(l.t);
  if (l.type === 'scene') {
    return `<div class="fi convo scene" data-convo="${l.id}">
      <div class="ft"><span class="faces">${faces}</span>&nbsp; ${t} · ${esc(l.where || '')} · 🎭 ${esc(l.title || '群戏')} · ${(l.lines || []).length} 句</div>
      <div>${esc(l.text)}</div>
      ${(l.commitments || []).length ? `<div style="color:var(--sakura);font-size:11.5px;margin-top:3px">📌 ${l.commitments.map(esc).join('；')}</div>` : ''}
      <div class="lines">${(l.lines || []).map((x) => `<div class="line"><img src="${face(x.speaker)}"><b>${esc(name(x.speaker))}</b><span>${esc(x.text)}</span></div>`).join('')}</div>
    </div>`;
  }
  if (l.type === 'convo') {
    return `<div class="fi convo" data-convo="${l.id}">
      <div class="ft"><span class="faces">${faces}</span>&nbsp; ${t} · ${esc(l.where || '')} · 💬 ${(l.lines || []).length} 句</div>
      <div><span class="who" data-agent="${l.agents[0]}">${esc(name(l.agents[0]))}</span> × <span class="who" data-agent="${l.agents[1]}">${esc(name(l.agents[1]))}</span>：${esc(l.text)}</div>
      ${(l.commitments || []).length ? `<div style="color:var(--sakura);font-size:11.5px;margin-top:3px">📌 ${l.commitments.map(esc).join('；')}</div>` : ''}
      <div class="lines">${(l.lines || []).map((x) => `<div class="line"><img src="${face(x.speaker)}"><b>${esc(name(x.speaker))}</b><span>${esc(x.text)}</span></div>`).join('')}</div>
    </div>`;
  }
  const icon = { thought: '💭', reflect: '✨', event: '📢', commit: '', visitor: '', reaction: '❗', plan: '🗓️', news: '', diary: '📖', weather: '', system: '', world: '', ability: '', learn: '', gift: '', effect: '✨', vote_cast: '🗳️', growth: '', scene_plan: '' }[l.type] ?? '';
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
  if (l.type === 'learn' || l.type === 'gift') toast(esc(l.text), 4500);
  if (['arc', 'vote', 'arrival', 'depart', 'portal'].includes(l.type)) toast(esc(l.text), 6500);
  if (l.type === 'proposal' && /落地|开工|征求意见/.test(l.text)) toast(esc(l.text), 5500);
  if (l.agents?.includes(app.selected)) scheduleDetail();
}
export function onAgents() {
  buildRoster();
  refreshRoster();
  if (app.selected && !app.meta[app.selected]) closeInspector();
}

let buildPending = null;
export function onProposals() {
  if (!ui.buildOpen || buildPending) return;
  buildPending = setTimeout(() => { buildPending = null; if (ui.buildOpen) renderBuild(); }, 600);
}

let evoPending = null;
export function onEvolution() {
  if (!ui.evoOpen || evoPending || ui.panelOpen) return;
  evoPending = setTimeout(() => { evoPending = null; if (ui.evoOpen) renderEvolve(); }, 600);
}

let storyPending = null;
export function onStory() {
  if (!ui.storyOpen || storyPending) return;
  storyPending = setTimeout(() => { storyPending = null; if (ui.storyOpen) renderStory(); }, 600);
}

// ---------- 区域（P6） ----------
const nextRegion = () => Object.keys(app.regionsOpen).find((k) => k !== 'town' && app.regionsOpen[k].open);
export function onRegions() {
  const chip = $('#region-chip');
  const other = nextRegion();
  chip.hidden = !other && app.view === 'town';
  const name = app.regionsOpen[other]?.name || '异界';
  chip.textContent = app.view === 'town' ? `🌗 去${name}看看` : '🏘️ 回到小镇';
  chip.classList.toggle('live', app.view !== 'town');
  document.body.classList.toggle('moon-view', app.view !== 'town');
}

// ---------- 访客化身（P6） ----------
const AV_COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f'];
function avatarModal() {
  const mine = app.avatars.find((v) => v.id === app.perms.avatar);
  if (!mine) {
    const saved = app.storage.get('town-avatar-name') || '';
    let color = app.storage.get('town-avatar-color') || AV_COLORS[0];
    const card = openModal(`<h2>👣 以旅人的身份现身</h2>
      <div class="sub">起一个名字，你会以旅人的样子出现在中央广场。居民们看得见你、会跟你打招呼，和你聊过的话也会记住是你说的。20 分钟不操作会自动离开。</div>
      <div class="pform"><input id="av-name" maxlength="8" placeholder="你的名字（≤8 字）" value="${esc(saved)}">
      <div class="av-colors">${AV_COLORS.map((c) => `<button class="av-c${c === color ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <button class="primary" id="av-go">现身 ✨</button><span class="quota" id="av-msg"></span></div>`);
    $$('.av-c', card).forEach((b) => b.addEventListener('click', () => { color = b.dataset.c; $$('.av-c', card).forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#av-go', card).onclick = async () => {
      const name = $('#av-name', card).value.trim();
      try {
        const r = await app.api('/api/avatar', { name, color });
        app.storage.set('town-avatar-name', r.avatar.name); app.storage.set('town-avatar-color', r.avatar.color);
        await app.refreshPerms();
        app.setView('town');
        closeModal();
        toast(`👣 ${esc(r.avatar.name)}来到了中央广场`);
      } catch (e) { $('#av-msg', card).innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(e.message)}</span>`; }
    };
    return;
  }
  const locs = Object.entries(app.spec.locations).filter(([, l]) => l.public && (!l.region || app.regionsOpen[l.region]?.open));
  const card = openModal(`<h2>👣 ${esc(mine.name)}</h2>
    <div class="sub">想去哪里？点一下就会走过去。${mine.region !== 'town' ? '（你现在在异界）' : ''}走到居民身边再和他们聊天，他们会知道是「站在面前的」你。</div>
    <div class="av-locs">${locs.map(([id, l]) => `<button class="mini" data-go="${id}">${l.region ? '🌗 ' : ''}${esc(l.name)}</button>`).join('')}</div>
    <div class="pact"><button class="mini" id="av-find">🔍 找到我</button><button class="mini" id="av-leave">👋 离开小镇</button></div>`);
  $$('[data-go]', card).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/avatar/move', { location: b.dataset.go }); closeModal(); toast(`👣 前往${esc(app.spec.locations[b.dataset.go].name)}`); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $('#av-find', card).onclick = () => {
    const v = app.avatars.find((x) => x.id === app.perms.avatar);
    if (!v) return;
    app.follow = null;
    app.setView(v.region, { center: false });
    app.cam.x = v.x * 32 + 16; app.cam.y = v.y * 32 + 16;
    closeModal();
  };
  $('#av-leave', card).onclick = async () => { await app.api('/api/avatar/leave', {}).catch(() => {}); await app.refreshPerms(); closeModal(); };
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
  const perDay = app.usageAvg ? `<span title="最近几个游戏日的平均用量">每游戏日≈${fmtK(app.usageAvg)}</span>` : '';
  $('#brain-stats').innerHTML = `<span>调用 ${s.ok}</span>${budget}${perDay}<span>均 ${(s.avgMs / 1000).toFixed(1)}s</span>${app.snap?.idle ? '<span>💤</span>' : ''}${s.queued ? `<span>排队 ${s.queued}</span>` : ''}${s.errors ? `<span style="color:var(--bad)" title="${esc(s.lastError)}">错误 ${s.errors}</span>` : ''}`;
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
    ${d.todayGoal ? `<div class="goal"><b>今日心愿</b> ${esc(d.todayGoal)}</div>` : ''}
    ${bodyHTML(d)}`;
  renderPane(fresh);
}

// 体力 / 勇气、状态、物品与能力（P1）
function bodyHTML(d) {
  if (!d.body) return '';
  const bar = (label, v, cls) => `<div class="meter ${cls}"><span>${label}</span><i><b style="width:${Math.max(0, Math.min(100, v))}%"></b></i><em>${v}</em></div>`;
  const inv = (d.inventory || []).map((x) => `<span class="chip-item" title="${esc(x.name)}">${esc(x.emoji)} ${esc(x.name)}×${x.n}</span>`).join('');
  const abs = (d.abilities || []).map((x) => `<span class="chip-ab${x.cooldown ? ' cd' : ''}" title="${esc(x.desc)}${x.cooldown ? `（冷却 ${x.cooldown} 分钟）` : ''}">${esc(x.emoji)} ${esc(x.name)}${x.cooldown ? ' ⏳' : ''}</span>`).join('');
  return `<div class="ibody">
    ${bar('体力', d.body.stamina, 'st')}${bar('勇气', d.body.courage, 'co')}
    ${d.body.conditions.length ? `<div class="conds">${d.body.conditions.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}
    ${d.researching ? `<div class="goal"><b>研究中</b> ${esc(d.researching)}</div>` : ''}
    ${abs ? `<div class="chips"><b>能力</b>${abs}</div>` : ''}
    ${inv ? `<div class="chips"><b>物品</b>${inv}</div>` : ''}
  </div>`;
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

// ---------- 故事面板（P2 / P3）----------
const PHASE_ICON = { omen: '🔮', breach: '🌀', struggle: '⚔️', climax: '🌕', aftermath: '🌅' };
const TH_STATUS = { open: ['未展开', 'open'], advanced: ['进行中', 'adv'], resolved: ['已回收', 'done'] };
function storyModal(tab) {
  ui.storyTab = tab || ui.storyTab || 'story';
  const card = openModal(`<h2>🎭 小镇的故事</h2>
    <div class="sub">叙事导演根据小镇的「张力」安排伏笔、冲突与喘息；剧情弧在关键时刻交给小镇（和你）来抉择。</div>
    <div class="tabs stabs">${[['story', '📖 剧情'], ['vote', '🗳️ 抉择'], ['threads', '🧵 伏笔'], ['crisis', '⚔️ 危机'], ['bestiary', '👾 图鉴']].map(([k, l]) => `<button data-t="${k}" class="${ui.storyTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="story-body" class="story-body"><div class="empty">正在翻开故事书……</div></div>`, 'story-wrap');
  card.style.width = 'min(760px, 94vw)';
  $$('.stabs button', card).forEach((b) => b.addEventListener('click', () => {
    ui.storyTab = b.dataset.t;
    $$('.stabs button', card).forEach((x) => x.classList.toggle('on', x === b));
    renderStory();
  }));
  ui.storyOpen = true;
  renderStory();
}

function sparkline(history) {
  if (!history.length) return '<div class="empty">张力曲线会在整点更新</div>';
  const W = 680, H = 90, n = history.length;
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const line = (k) => history.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${line('target')}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5" stroke-dasharray="4 4"/>
    <polyline points="${line('v')}" fill="none" stroke="#ffb86b" stroke-width="2.5"/></svg>
    <div class="legend"><span><i style="background:#ffb86b"></i>张力</span><span><i style="background:rgba(255,255,255,.35)"></i>叙事者的目标</span></div>`;
}

async function renderStory() {
  const body = $('#story-body');
  if (!body) { ui.storyOpen = false; return; }
  let d;
  try { d = await app.api('/api/story'); } catch (e) { body.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; return; }
  if (!$('#story-body')) return;
  const tab = ui.storyTab;
  const ST = { gentle: '🌸 静水', voyage: '🗺️ 远航', chaos: '🎲 掷骰' };
  const RT = { cozy: '温馨', adventure: '冒险', epic: '史诗' };
  let html = '';
  if (tab === 'story') {
    const arcs = d.arcs.map((a) => `<div class="arc ${a.status}">
      <b>${esc(a.emoji || '🌀')} 《${esc(a.title)}》</b> <small>${a.status === 'active' ? '进行中' : '已落幕'}${a.outcome ? ` · 结局「${esc(a.outcome.title)}」` : ''}</small>
      <div class="phases">${a.phases.map((p) => { const i = a.phases.findIndex((x) => x.id === a.phase); const j = a.phases.indexOf(p); return `<span class="${j < i || a.status === 'done' ? 'past' : j === i ? 'now' : ''}">${PHASE_ICON[p.id] || '•'} ${esc(p.name)}</span>`; }).join('<i>›</i>')}</div></div>`).join('');
    html = `<div class="srow"><span>叙事者 <b>${ST[d.storyteller] || d.storyteller}</b></span><span>内容分级 <b>${RT[d.rating] || d.rating}</b></span>
      <span>当前张力 <b>${d.tension?.value ?? '—'}</b> / 目标 ${d.tension?.target ?? '—'}</span></div>
      ${sparkline(d.history)}
      <h3>剧情弧</h3>${arcs || '<div class="empty">还没有剧情弧开启。远航 / 掷骰叙事者会在夜里自动开启，管理员也可以手动开启。</div>'}
      ${d.admin && !d.arcs.some((a) => a.status === 'active') ? '<button class="primary" id="arc-start">🌀 开启《镜湖裂隙》</button>' : ''}
      ${d.scenes.length ? `<h3>即将上演</h3>${d.scenes.map((s) => `<div class="dec">🎭 ${fmtTime(s.time)} · ${esc(s.location)} · ${esc(s.title)}</div>`).join('')}` : ''}
      <h3>导演笔记 ${d.admin ? '<button class="mini" id="dir-go">让导演现在想一想</button>' : ''}</h3>
      ${d.decisions.map((x) => `<div class="dec"><b>${fmtTime(x.t)}</b> ${esc({ noop: '按兵不动', foreshadow: '埋伏笔', complicate: '添麻烦', escalate: '升级', relief: '喘息', resolve: '收束', launchArc: '开启剧情弧' }[x.decision] || x.decision)} — ${esc(x.reason)}${x.external ? '（回应了玩家事件）' : ''}</div>`).join('') || '<div class="empty">导演还没有出手（需要配置 LLM）。</div>'}`;
  } else if (tab === 'vote') {
    html = d.votes.map((v) => {
      const total = Object.values(v.tally).reduce((s, x) => s + x.total, 0) || 1;
      const open = v.status === 'open' || v.status === 'awaiting';
      return `<div class="vote ${v.status}"><h3>${esc(v.question)}</h3>
        <div class="vmeta">${v.status === 'open' ? `投票截止：${fmtTime(v.closesT)}` : v.status === 'awaiting' ? `投票已截止，等待管理员终审（${fmtTime(v.awaitUntil)} 前无人裁决则按多数决定）` : `已揭晓：${esc(v.options.find((o) => o.id === v.result?.option)?.label || '')}（${v.result?.by === 'admin' ? '管理员终审' : '多数决定'}）`}</div>
        ${v.options.map((o) => { const t = v.tally[o.id]; return `<div class="vopt ${v.result?.option === o.id ? 'win' : ''} ${v.mine === o.id ? 'mine' : ''}">
          <div class="vlab"><b>${esc(o.label)}</b><small>${esc(o.desc)}</small></div>
          <div class="vbar"><i style="width:${(t.total / total) * 100}%"></i></div>
          <div class="vnum">居民 ${t.residents} · 访客 ${t.visitors}</div>
          ${open && !v.mine && app.perms.interaction ? `<button class="mini" data-vote="${v.id}" data-opt="${o.id}">投这个</button>` : ''}
          ${open && d.admin ? `<button class="mini adm" data-decide="${v.id}" data-opt="${o.id}">终审</button>` : ''}</div>`; }).join('')}</div>`;
    }).join('') || '<div class="empty">目前没有需要小镇抉择的事。剧情走到关键时刻时，这里会出现投票。</div>';
  } else if (tab === 'threads') {
    html = d.threads.map((t) => `<div class="thread ${TH_STATUS[t.status][1]}"><div><b>${esc(t.title)}</b><span class="badge">${TH_STATUS[t.status][0]}</span></div>
      <small>${esc(t.hook)}</small>${t.notes.length ? `<div class="tnotes">${t.notes.map((n) => `<div>· ${fmtTime(n.t)} ${esc(n.text)}</div>`).join('')}</div>` : ''}</div>`).join('');
  } else if (tab === 'crisis') {
    const c = d.crisis;
    const meter = (label, v, cls) => `<div class="cmeter ${cls}"><span>${label}</span><i><b style="width:${v}%"></b></i><em>${v}</em></div>`;
    html = `${meter('士气', c.morale, 'mo')}${meter('物资', c.supplies, 'su')}
      <div class="srow"><span>🏮 亮着的灯阵 <b>${c.defense}</b></span><span>👾 游荡的异界生物 <b>${c.creatures}</b></span><span>🌀 裂隙 <b>${c.portal ? `${esc(c.portal.name)}（${{ crack: '微裂', open: '开启', wide: '扩张', stable: '稳定' }[c.portal.stage] || c.portal.stage}）` : '无'}</b></span></div>
      <div class="sub">影灵会偷西瓜、吹灭灯笼（物资下降）；居民遭遇生物时靠勇气、灯和同伴对抗，赢了士气上升。冒险模式下被吓坏的人会被送去诊所，但没有人会死。</div>`;
  } else {
    html = `<div class="beasts">${d.bestiary.map((b) => b.known ? `<div class="beast"><img src="${creatureFace(b.id)}" alt=""><div><b>${esc(b.emoji)} ${esc(b.name)}</b><small>${esc(b.origin || '')}</small><p>${esc(b.lore || '')}</p><div class="weak">弱点：${(b.weakness || []).map(esc).join('、')}</div></div></div>`
      : '<div class="beast unknown"><div class="q">？</div><div><b>？？？</b><small>尚未遭遇</small></div></div>').join('')}</div>
      <h3>来自别处的人</h3>${d.travellers.map((t) => `<div class="dec">🧳 <b>${esc(t.name)}</b> · ${esc(t.role)} · 来自${esc(t.origin || '远方')}${t.status === 'departed' ? ' · 已离开' : ''}</div>`).join('') || '<div class="empty">还没有人从别处来。</div>'}`;
  }
  body.innerHTML = html;
  $$('[data-vote]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/vote', { id: b.dataset.vote, option: b.dataset.opt }); toast('🗳️ 你的一票已投出'); renderStory(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-decide]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定以管理员身份终审这个选项吗？')) return;
    try { await app.api('/api/vote/decide', { id: b.dataset.decide, option: b.dataset.opt }); renderStory(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  const as = $('#arc-start', body);
  if (as) as.onclick = async () => { try { await app.api('/api/arc/start', { template: 'rift' }); renderStory(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } };
  const dg = $('#dir-go', body);
  if (dg) dg.onclick = async () => { dg.disabled = true; dg.textContent = '导演思考中…'; try { await app.api('/api/director/decide', {}); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } renderStory(); };
}

// ---------- 建设面板（P4）----------
const P_STATUS = {
  review: ['🔎 考据中', 'rev'], voting: ['🗳️ 征求意见', 'vote'], awaiting: ['⏳ 等待终审', 'wait'], queued: ['📋 排队动工', 'wait'],
  building: ['🚧 施工中', 'build'], applied: ['✅ 已落地', 'ok'], rejected: ['❌ 已驳回', 'no'], failed: ['⚠️ 未能实施', 'no'], expired: ['⌛ 已作废', 'no'], reverted: ['↩️ 已撤销', 'no'],
};
const P_LEVEL = { micro: '微调', minor: '小改', major: '大改' };
function buildModal(tab) {
  ui.buildTab = tab || ui.buildTab || 'list';
  const tabs = [['list', '🛠 提案'], ['history', '📜 编年史'], ...(app.perms.admin ? [['gaps', '🧩 AI 心愿单'], ['rollback', '⏳ 时间线'], ['regions', '🌗 区域']] : [])];
  const card = openModal(`<h2>🛠 小镇建设</h2>
    <div class="sub">世界架构师把大家的点子变成「世界补丁」：新的建筑、节日、天气、物品、能力与法则。每份补丁都要经过校验和设定考据；${app.perms.publicMode ? '访客投票后由管理员终审' : '小改自动通过，大改需要管理员确认'}。</div>
    <div class="tabs stabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${ui.buildTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="build-body" class="story-body"><div class="empty">正在翻阅图纸……</div></div>`, 'story-wrap');
  card.style.width = 'min(760px, 94vw)';
  $$('.stabs button', card).forEach((b) => b.addEventListener('click', () => {
    ui.buildTab = b.dataset.t;
    $$('.stabs button', card).forEach((x) => x.classList.toggle('on', x === b));
    renderBuild();
  }));
  ui.buildOpen = true;
  renderBuild();
}

/** 在小地图上标出新建筑的位置 */
function sitePreview(rects) {
  const base = app.renderer.miniBase;
  if (!base || !rects.length) return '';
  const s = app.renderer.miniScale;
  const r = rects[0];
  const pad = 10;
  const x0 = Math.max(0, r.x - pad), y0 = Math.max(0, r.y - pad);
  const x1 = Math.min(app.world.W, r.x + r.w + pad), y1 = Math.min(app.world.H, r.y + r.h + pad);
  const c = document.createElement('canvas');
  const k = 4;
  c.width = (x1 - x0) * s * k / 3; c.height = (y1 - y0) * s * k / 3;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(base, x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s, 0, 0, c.width, c.height);
  const u = c.width / (x1 - x0);
  for (const q of rects) {
    g.fillStyle = 'rgba(255,184,107,.45)'; g.fillRect((q.x - x0) * u, (q.y - y0) * u, q.w * u, q.h * u);
    g.strokeStyle = '#ffb86b'; g.lineWidth = 2; g.strokeRect((q.x - x0) * u + 1, (q.y - y0) * u + 1, q.w * u - 2, q.h * u - 2);
  }
  return `<img class="site" src="${c.toDataURL()}" alt="选址">`;
}

async function renderBuild() {
  const body = $('#build-body');
  if (!body) { ui.buildOpen = false; return; }
  const tab = ui.buildTab;
  let html = '';
  try {
    if (tab === 'list') {
      const d = await app.api('/api/proposals');
      const form = app.perms.interaction ? `<div class="pform"><textarea id="p-intent" rows="2" maxlength="120" placeholder="给小镇提个建设点子，例如：在码头边修一座可以看星星的小塔"></textarea>
        <button class="primary" id="p-go">交给世界架构师 ✨</button><span class="quota" id="p-msg">${d.admin ? '管理员不受频率限制' : '每小时最多 2 条 · 建议会经过审核'}</span></div>` : '';
      const queue = d.queue.length || d.thinking ? `<div class="dec">🧠 世界架构师${d.thinking ? '正在设计图纸' : ''}${d.queue.length ? `，还有 ${d.queue.length} 个点子排队：${d.queue.map((q) => esc(q.intent)).join('；')}` : ''}</div>` : '';
      const cards = d.proposals.map((p) => {
        const [label, cls] = P_STATUS[p.status] || [p.status, ''];
        const open = p.status === 'voting' || p.status === 'awaiting';
        const rects = p.ops.map((o) => o.rect).filter(Boolean);
        const time = p.status === 'voting' ? `意见征集截止 ${fmtTime(p.voteUntil)}` : p.status === 'awaiting' && p.decision?.untilMs ? (p.decision.status === 'arbitrating' ? '🤖 AI 裁决官正在决定' : `${fmtLeft(p.decision.untilMs)}后无人终审将由 🤖 AI 裁决官决定`) : p.status === 'building' ? `预计 ${fmtTime(p.finishT)} 完工` : '';
        return `<div class="prop ${cls}">
          <div class="phead"><b>${esc(p.title)}</b><span class="badge">${P_LEVEL[p.level] || p.level}</span><span class="pst">${label}</span></div>
          <div class="pmeta">${esc(p.origin)} · 第${Math.floor(p.createdT / 1440) + 1}天 ${fmtTime(p.createdT)}${time ? ` · ${time}` : ''}</div>
          ${p.motive ? `<div class="pmot">${esc(p.motive)}</div>` : ''}
          <div class="pbody">${sitePreview(rects)}<ul>${p.ops.map((o) => `<li>${esc(o.desc)}</li>`).join('')}</ul></div>
          ${p.canon?.issues?.length ? `<div class="pcanon">📜 考据官：${p.canon.issues.map(esc).join('；')}</div>` : ''}
          ${p.result?.reason ? `<div class="pcanon">${esc(p.result.reason)}</div>` : ''}
          <div class="pact">
            ${open || p.tally.yes || p.tally.no ? `<span class="quota">赞成 ${p.tally.yes} · 反对 ${p.tally.no}</span>` : ''}
            ${open && p.mine == null && app.perms.interaction ? `<button class="mini" data-pv="${p.id}" data-yes="1">👍 赞成</button><button class="mini" data-pv="${p.id}" data-yes="0">👎 反对</button>` : ''}
            ${p.mine != null ? `<span class="quota">你投了${p.mine ? '赞成' : '反对'}</span>` : ''}
            ${(open || p.status === 'queued') && d.admin ? `<button class="mini adm" data-pd="${p.id}" data-ok="1">✅ 批准</button><button class="mini adm" data-pd="${p.id}" data-ok="0">✖ 驳回</button>` : ''}
          </div></div>`;
      }).join('');
      html = form + queue + (cards || '<div class="empty">还没有建设提案。居民聊天时、导演推进剧情时，或者你在上面提一个点子，都可能催生新的提案。</div>');
    } else if (tab === 'history') {
      const list = await app.api('/api/world/history');
      html = list.slice().reverse().map((r) => `<div class="dec"><b>第${Math.floor(r.t / 1440) + 1}天 ${fmtTime(r.t)}</b> ${esc(r.desc)} <small class="quota">（${esc({ proposal: '建设提案', admin: '管理员', director: '叙事导演' }[r.cause?.by] || r.cause?.by || '')}）</small></div>`).join('')
        || '<div class="empty">世界还没有发生过结构性的变化。</div>';
    } else if (tab === 'gaps') {
      const d = await app.api('/api/proposals');
      const GS = { open: '待处理', adopted: '已采纳', ignored: '已忽略' };
      html = `<div class="sub">叙事导演和世界架构师想做、但现有能力做不到的事。进化引擎会自动挑选这里的需求来实现（「采纳」的优先，「忽略」的不做），做好的插件在「🧬 进化」里表决上线。</div>` + ((d.gaps || []).map((g) => `<div class="gap ${g.status}">
        <div><b>×${g.count}</b> ${esc(g.need)} <span class="badge">${g.rfc ? '📄 已有需求文档' : GS[g.status] || g.status}</span></div>
        <small class="quota">${esc(g.why)}（起因：${esc(g.intent || '')}）</small>
        ${g.rfc ? `<div class="quota">📄 ${esc(g.rfc)}</div>` : `<div class="pact">${g.status !== 'adopted' ? `<button class="mini adm" data-gap="${esc(g.id)}" data-st="adopted">✅ 采纳</button>` : ''}${g.status !== 'ignored' ? `<button class="mini" data-gap="${esc(g.id)}" data-st="ignored">忽略</button>` : ''}${g.status !== 'open' ? `<button class="mini" data-gap="${esc(g.id)}" data-st="open">重新打开</button>` : ''}</div>`}
      </div>`).join('') || '<div class="empty">暂时没有能力缺口。</div>');
    } else if (tab === 'regions') {
      html = `<div class="sub">异界是和小镇相连的口袋地图，居民经「月之渡口」往返。通常由剧情（《镜湖裂隙》的共存结局）打开，管理员也可以手动开关；关闭时还在那边的人会被送回渡口。</div>` +
        Object.entries(app.regionsOpen).filter(([k]) => k !== 'town').map(([k, r]) => `<div class="dec snap"><b>🌗 ${esc(r.name)}</b> <small class="quota">${r.open ? '已开放' : '未开放'}</small><button class="mini adm" data-region="${esc(k)}" data-open="${r.open ? 0 : 1}">${r.open ? '关闭通路' : '打开通路'}</button></div>`).join('');
    } else {
      const [list, tl] = await Promise.all([app.api('/api/snapshots'), app.api('/api/timelines')]);
      const cur = tl.list.find((t) => t.id === tl.active);
      html = `<h3>🌿 时间线</h3><div class="sub">从任意整点快照（或此刻）分出一条新的世界线，各自独立发展，可以随时来回切换。当前：<b>${esc(cur?.name || tl.active)}</b></div>` +
        tl.list.map((t) => `<div class="dec snap"><b>${t.id === tl.active ? '▶ ' : ''}${esc(t.name)}</b> <small class="quota">${t.from ? `从「${esc(tl.list.find((x) => x.id === t.from.timeline)?.name || t.from.timeline)}」第${t.from.day}天 ${String(t.from.hour).padStart(2, '0')}:00 分出` : '最初的世界'}</small>${t.id === tl.active ? '' : `<button class="mini adm" data-tl="${esc(t.id)}">切换过去</button>`}</div>`).join('') +
        `<div class="pform"><input id="tl-name" maxlength="20" placeholder="新时间线的名字，例如：如果那天没有下雨"><button class="primary" id="tl-fork">从此刻分出新时间线 🌿</button></div>` +
        `<h3>⏳ 快照</h3><div class="sub">「回到这里」会让当前时间线回到那个时刻（当前存档先自动备份）；「分出」则保留当前时间线，从那个时刻另开一条。</div>` + (list.map((s) => `<div class="dec snap"><b>第${s.day}天 ${String(s.hour).padStart(2, '0')}:00</b> <small class="quota">${Math.round(s.size / 1024)} KB</small><button class="mini" data-fork="${esc(s.name)}">🌿 分出</button><button class="mini adm" data-snap="${esc(s.name)}">回到这里</button></div>`).join('') || '<div class="empty">还没有快照（每个游戏小时自动保存一份，保留最近 24 份）。</div>');
    }
  } catch (e) { html = `<div class="empty">⚠️ ${esc(e.message)}</div>`; }
  if (!$('#build-body')) return;
  body.innerHTML = html;
  const go = $('#p-go', body);
  if (go) go.onclick = async () => {
    const intent = $('#p-intent').value.trim();
    if (!intent) return;
    go.disabled = true;
    try { await app.api('/api/proposals', { intent }); toast('🧠 点子已经交给世界架构师了'); renderBuild(); } catch (e) { $('#p-msg').innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(e.message)}</span>`; go.disabled = false; }
  };
  $$('[data-pv]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/proposals/vote', { id: b.dataset.pv, yes: b.dataset.yes === '1' }); renderBuild(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-pd]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(b.dataset.ok === '1' ? '批准这份世界补丁？' : '驳回这份世界补丁？')) return;
    try { await app.api('/api/proposals/decide', { id: b.dataset.pd, approve: b.dataset.ok === '1' }); renderBuild(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-gap]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/gaps/status', { id: b.dataset.gap, status: b.dataset.st }); renderBuild(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-region]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/region', { id: b.dataset.region, open: b.dataset.open === '1' }); renderBuild(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-tl]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('切换到这条时间线？当前时间线会先存档。')) return;
    try { await app.api('/api/timelines/switch', { id: b.dataset.tl }); closeModal(); toast('🌿 已切换时间线'); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  const fork = async (snapshot) => {
    const name = $('#tl-name', body)?.value.trim() || '';
    try { const r = await app.api('/api/timelines/fork', { name, snapshot }); closeModal(); toast(`🌿 分出了新时间线「${esc(r.timeline.name)}」并切换过去`); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  };
  const tf = $('#tl-fork', body);
  if (tf) tf.onclick = () => fork(null);
  $$('[data-fork]', body).forEach((b) => b.addEventListener('click', () => fork(b.dataset.fork)));
  $$('[data-snap]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确定把小镇回溯到这个时刻吗？之后发生的一切都会消失（当前存档会备份）。')) return;
    try { await app.api('/api/rollback', { name: b.dataset.snap, confirm: 'ROLLBACK' }); closeModal(); toast('⏳ 时光倒流了……'); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
}

// ---------- 🧬 进化：AI 插件、决策队列、进化引擎（自主演化 E1~E5） ----------
const fmtLeft = (ms) => {
  const s = Math.max(0, (ms - Date.now()) / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)} 小时${Math.round((s % 3600) / 60)} 分` : `${Math.ceil(s / 60)} 分钟`;
};
const EV_STATUS = {
  pending: ['🗳️ 等待表决', 'vote'], approved: ['📋 排队灰度', 'wait'], canary: ['🧪 灰度试运行', 'build'], active: ['✅ 运行中', 'ok'],
  rolledBack: ['⏪ 已回滚', 'no'], rejected: ['❌ 未采纳', 'no'], disabled: ['⏸ 已停用', 'no'], superseded: ['🔁 已被新版本取代', 'no'], retired: ['📦 已退役', 'no'],
};
const TIER = { T0: '数据', T1: '规则', T2: '代码', builtin: '内置' };
const D_KIND = { proposal: '🛠 建设提案', vote: '🗳️ 剧情抉择', plugin: '🧩 插件上线', retire: '📦 插件退役' };
const D_BY = { admin: '管理员', ai: '🤖 AI 裁决官', rule: '🤖 硬规则', fallback: '🤖 兜底规则', majority: '多数决定' };
const STAGE = {
  rfc: '✍️ 写需求文档', 'rfc-review': '🔍 需求评审', implement: '🛠 实施', fix: '🔧 修复', gate: '🚦 自动闸门', 'final-security': '🛡 安全终审',
  shadow: '👥 影子试运行', install: '📦 安装锁定', submitted: '✅ 已提交表决', dropped: '✖ 放弃', t3: '📄 需要改内核（已写需求文档）', failed: '⚠️ 出错', paused: '⏸ 预算用完', running: '进行中',
};
const stageText = (s) => STAGE[s] || (String(s).startsWith('review-') ? `👀 第 ${s.slice(7)} 轮评审` : s);
const ENGINE = { idle: '空闲', working: '工作中', 'waiting-budget': '今日预算已用完', 'waiting-town': '小镇繁忙，让路中', 'no-llm': '没有配置模型', stopped: '已停止', crashed: '异常退出', starting: '启动中' };

function evolveModal(tab) {
  ui.evoTab = tab || ui.evoTab || 'plugins';
  const tabs = [['plugins', '🧩 AI 插件'], ['decisions', '⚖️ 决策队列'], ...(app.perms.admin ? [['engine', '⚙️ 进化引擎']] : []), ['builtin', '📦 内置插件']];
  const card = openModal(`<h2>🧬 小镇的进化</h2>
    <div class="sub">小镇会自己成长：进化引擎把 AI 心愿单里的需求写成需求文档，经过需求评审、实施、多轮 AI 评审与安全终审、影子试运行后，做成插件交给大家表决；管理员在终审窗口内没有处理的事，由 🤖 AI 裁决官在硬性规则之内决定。所有新功能都在独立的插件目录里，随时可以回滚。</div>
    <div class="tabs stabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${ui.evoTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="evo-body" class="story-body"><div class="empty">正在读取……</div></div>`, 'story-wrap');
  card.style.width = 'min(780px, 94vw)';
  $$('.stabs button', card).forEach((b) => b.addEventListener('click', () => {
    ui.evoTab = b.dataset.t;
    $$('.stabs button', card).forEach((x) => x.classList.toggle('on', x === b));
    renderEvolve();
  }));
  ui.evoOpen = true;
  ui.panelOpen = false;
  renderEvolve();
}

function decisionLine(d) {
  const r = d.result;
  const wait = d.status === 'waiting' ? (d.untilMs ? `${fmtLeft(d.untilMs)}后由 🤖 AI 裁决官决定` : d.untilT != null ? `游戏时间 ${fmtTime(d.untilT)} 后由 🤖 AI 裁决官决定` : '') : d.status === 'arbitrating' ? '🤖 AI 裁决官正在决定…' : '';
  return `${wait ? `<div class="quota">⏳ ${wait}${d.deferred ? '（已延期一次）' : ''}</div>` : ''}
    ${r ? `<div class="pcanon">${D_BY[r.by] || esc(r.by)}：${r.option ? `选择 ${esc(r.option)}` : r.decision === 'adopt' ? '采纳' : '驳回'}${r.confidence != null ? `（信心 ${Math.round(r.confidence * 100)}%）` : ''}${r.reasons?.length ? ` —— ${r.reasons.map(esc).join('；')}` : ''}${r.roles ? `<br><small>${r.roles.map((x) => `${x.role === 'guardian' ? '守护者' : '推动者'}：${x.decision}`).join(' · ')}</small>` : ''}</div>` : ''}
    ${d.outcome ? `<div class="quota">后来：${d.outcome === 'undone' ? '被管理员撤销' : '被回滚'}</div>` : ''}`;
}

async function renderEvolve() {
  const body = $('#evo-body');
  if (!body) { ui.evoOpen = false; return; }
  let html = '';
  try {
    const d = await app.api('/api/evolution');
    const tab = ui.evoTab;
    const decOf = (key) => d.decisions.items.find((x) => x.kind === 'plugin' && x.ref === key);
    if (tab === 'plugins') {
      const c = d.config;
      html = `<div class="dec">自主进化：<b>${{ off: '关闭', suggest: '只提建议（超时不自动上线）', auto: '完全自主' }[c.mode]}</b>${c.publicMode ? ` · 公网自动上线：<b>${{ off: '不允许', data: '只允许数据 / 规则类', all: '全部允许' }[c.publicDeploy]}</b>` : ''} · 同时运行上限 ${c.maxActive}</div>`;
      if (d.panels.length) html += `<div class="pact">${d.panels.map((p) => `<button class="mini" data-panel="${esc(p.id)}" data-title="${esc(p.title)}">🪟 ${esc(p.title)}</button>`).join('')}</div>`;
      html += d.plugins.map((p) => {
        const [label, cls] = EV_STATUS[p.status] || [p.status, ''];
        const dec = decOf(p.key);
        return `<div class="prop ${cls}">
          <div class="phead"><b>${esc(p.title || p.id)}</b><span class="badge">${TIER[p.tier] || p.tier} · v${esc(p.version)}</span><span class="pst">${label}</span></div>
          <div class="pmot">${esc(p.summary || '')}</div>
          ${p.reason && ['rolledBack', 'rejected', 'disabled'].includes(p.status) ? `<div class="pcanon">${esc(p.reason)}</div>` : ''}
          ${dec ? decisionLine(dec) : ''}
          <div class="pact">
            <span class="quota">调用 ${p.calls} 次${p.errors ? ` · 出错 ${p.errors} 次` : ''}${p.status === 'pending' || p.votes.yes || p.votes.no ? ` · 赞成 ${p.votes.yes} · 反对 ${p.votes.no}` : ''}</span>
            ${p.status === 'pending' && app.perms.interaction ? `<button class="mini" data-ev="${esc(p.key)}" data-yes="1">👍 赞成上线</button><button class="mini" data-ev="${esc(p.key)}" data-yes="0">👎 反对</button>` : ''}
            ${d.admin && p.status === 'pending' && dec ? `<button class="mini adm" data-dd="${dec.id}" data-ok="1">✅ 批准</button><button class="mini adm" data-dd="${dec.id}" data-ok="0">✖ 驳回</button>` : ''}
            ${d.admin && ['canary', 'active'].includes(p.status) ? `<button class="mini adm" data-act="rollback" data-key="${esc(p.key)}">⏪ 回滚</button><button class="mini adm" data-act="disable" data-key="${esc(p.key)}">⏸ 停用</button>` : ''}
            ${d.admin && ['disabled', 'rolledBack', 'superseded', 'rejected'].includes(p.status) ? `<button class="mini adm" data-act="enable" data-key="${esc(p.key)}">▶ 启用</button>` : ''}
          </div>
          ${d.admin && p.lastError ? `<small class="quota">最近的错误：${esc(p.lastError)}</small>` : ''}
        </div>`;
      }).join('') || '<div class="empty">还没有 AI 插件。进化引擎开启后（EVOLVE=auto），它会从 AI 心愿单里挑需求来实现。</div>';
    } else if (tab === 'decisions') {
      const cal = d.decisions.calibration;
      html = `<div class="sub">管理员终审窗口：小改 6 小时、大改与代码插件 24 小时（真实时间）；超时后由 AI 裁决官决定。硬规则：闸门不过只能驳回、访客明确反对不能采纳、代码插件要「守护者」和「推动者」都同意、没把握时延期一次。</div>
        <div class="dec">🤖 最近 ${cal.n} 次 AI 采纳中被回滚 ${Math.round(cal.rate * 100)}%${cal.strict ? ' —— <b>已自动收紧</b>：高风险项只能等管理员' : ''}</div>` +
        (d.decisions.items.map((x) => `<div class="prop ${x.status === 'decided' ? (x.result?.decision === 'adopt' ? 'ok' : 'no') : 'wait'}">
          <div class="phead"><b>${esc(x.title)}</b><span class="badge">${D_KIND[x.kind] || x.kind} · ${{ low: '低风险', medium: '中风险', high: '高风险' }[x.risk]}</span><span class="pst">${{ waiting: '⏳ 等待终审', arbitrating: '🤖 裁决中', decided: '已决定', cancelled: '已在别处处理' }[x.status]}</span></div>
          ${x.summary ? `<div class="pmot">${esc(x.summary)}</div>` : ''}
          ${decisionLine(x)}
          <div class="pact">${d.admin && x.status === 'waiting' && x.kind !== 'vote' ? `<button class="mini adm" data-dd="${x.id}" data-ok="1">✅ 采纳</button><button class="mini adm" data-dd="${x.id}" data-ok="0">✖ 驳回</button>` : ''}${x.canUndo ? `<button class="mini adm" data-undo="${x.id}">↩️ 撤销这个裁决</button>` : ''}</div>
        </div>`).join('') || '<div class="empty">目前没有需要拍板的事。</div>');
    } else if (tab === 'engine') {
      const e = d.engine || {};
      const used = e.budget?.day ? e.budget.tokens : 0;
      html = `<div class="dec">状态：<b>${ENGINE[e.state] || e.state || '未运行'}</b>${e.running ? '' : '（进程未运行）'}${e.stage ? ` · 当前：${stageText(e.stage)}「${esc(e.need || '')}」` : ''}</div>
        <div class="dec">今日预算：${used.toLocaleString()} / ${e.budgetLimit ? e.budgetLimit.toLocaleString() : '不限'} tokens · 评审模型：${esc(e.reviewModel || '（同实施）')}${e.sameModel ? ' <span style="color:var(--bad)">⚠️ 实施与评审使用同一模型，建议配置 EVOLVE_REVIEW_MODEL</span>' : ''}</div>
        ${d.config.publicMode && d.config.publicDeploy === 'all' && d.config.sandboxNet !== 'isolated' ? '<div class="pcanon">⚠️ 公网允许代码插件自动上线，但没有声明沙箱已在系统层面断网（EVOLVE_SANDBOX_NET=isolated）。</div>' : ''}
        <h3>最近的任务</h3>` + ((e.jobs || []).map((j) => `<div class="prop ${{ submitted: 'ok', dropped: 'no', failed: 'no', t3: 'wait' }[j.status] || 'build'}">
          <div class="phead"><b>${esc(j.title || j.need || '')}</b>${j.tier ? `<span class="badge">${esc(j.tier)}</span>` : ''}<span class="pst">${stageText(j.status === 'running' ? j.stage : j.status)}</span></div>
          <div class="pmeta">${{ gap: '来自 AI 心愿单', bugfix: '修复故障', idea: '引擎自己的点子' }[j.source] || ''} · ${esc(j.need || '')}${j.key ? ` · ${esc(j.key)}` : ''}${j.rfc ? ` · 📄 data/evolution/rfcs/${esc(j.rfc)}` : ''}</div>
          ${j.reason ? `<div class="pcanon">${esc(j.reason)}</div>` : ''}
          ${(j.log || []).length ? `<ul class="joblog">${j.log.map((l) => `<li>${esc(l.text)}</li>`).join('')}</ul>` : ''}
        </div>`).join('') || '<div class="empty">还没有任务。</div>');
    } else {
      html = `<div class="sub">内置插件由人维护，放在 plugins/builtin/ 下，和 AI 插件一样通过钩子接入内核。</div>` +
        d.builtin.map((p) => `<div class="dec"><b>${esc(p.title)}</b> <small class="quota">${esc(p.id)} · v${esc(p.version)}${p.errors ? ` · 出错 ${p.errors} 次` : ''}</small><br><small>${esc(p.summary)}</small></div>`).join('');
    }
  } catch (err) { html = `<div class="empty">⚠️ ${esc(err.message)}</div>`; }
  if (!$('#evo-body')) return;
  body.innerHTML = html;
  $$('[data-ev]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/evolution/vote', { key: b.dataset.ev, yes: b.dataset.yes === '1' }); renderEvolve(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-dd]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(b.dataset.ok === '1' ? '采纳？' : '驳回？')) return;
    try { await app.api('/api/decisions/decide', { id: b.dataset.dd, adopt: b.dataset.ok === '1' }); renderEvolve(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-undo]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('撤销这个裁决？已经落地的内容会被回滚。')) return;
    try { await app.api('/api/decisions/undo', { id: b.dataset.undo }); renderEvolve(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-act]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm({ rollback: '回滚这个插件？', disable: '停用这个插件？', enable: '启用这个版本？' }[b.dataset.act])) return;
    try { await app.api('/api/evolution/action', { key: b.dataset.key, action: b.dataset.act }); renderEvolve(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-panel]', body).forEach((b) => b.addEventListener('click', () => openPluginPanel(b.dataset.panel, b.dataset.title)));
}

/** AI 插件的面板：sandbox iframe（没有 allow-same-origin），只能通过 postMessage 拿公开状态、调用自己的接口 */
function openPluginPanel(id, title) {
  const card = openModal(`<h2>🪟 ${esc(title)}</h2><div class="sub">这个面板由 AI 插件提供，运行在隔离的沙箱里。</div>
    <iframe id="plugin-frame" class="plugin-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src="plugin-ui/${encodeURIComponent(id)}/"></iframe>
    <div class="pact"><button class="mini" id="panel-back">← 返回</button></div>`, 'story-wrap');
  card.style.width = 'min(680px, 94vw)';
  ui.panelOpen = true;
  const frame = $('#plugin-frame', card);
  const post = (m) => frame.contentWindow?.postMessage(m, '*');
  const pushState = () => {
    const s = app.snap;
    if (!s) return;
    post({ type: 'state', state: { day: Math.floor(s.t / 1440) + 1, hour: Math.floor((s.t % 1440) / 60), weather: s.weather, agents: s.agents.map((a) => ({ id: a.id, name: name(a.id), loc: a.loc, mood: a.mood })) } });
  };
  const onMsg = async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.type !== 'call' || typeof m.route !== 'string') return;
    try {
      const r = await app.api(`/api/p/${encodeURIComponent(id)}/${encodeURIComponent(m.route)}`, { body: m.body ?? null });
      post({ type: 'result', id: m.id, ok: true, result: r.result });
    } catch (err) { post({ type: 'result', id: m.id, ok: false, error: err.message }); }
  };
  window.addEventListener('message', onMsg);
  frame.addEventListener('load', pushState);
  const timer = setInterval(() => { if (!document.body.contains(frame)) { clearInterval(timer); window.removeEventListener('message', onMsg); ui.panelOpen = false; return; } pushState(); }, 2000);
  $('#panel-back', card).onclick = () => { ui.panelOpen = false; evolveModal('plugins'); };
}

const creatureFaces = {};
function creatureFace(id) {
  if (creatureFaces[id]) return creatureFaces[id];
  const spr = app.renderer.creatureSprites[id];
  if (!spr) return '';
  const c = document.createElement('canvas');
  c.width = 80; c.height = 108;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(spr.down[0], 0, 0, 80, 108);
  return (creatureFaces[id] = c.toDataURL());
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
function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; ui.storyOpen = false; ui.buildOpen = false; ui.evoOpen = false; ui.panelOpen = false; }

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
