// 界面：名册、检查器、动态流、AI 大脑面板、弹窗（日报 / 关系网 / 事件 / 帮助）
// 各面板拆在 ui/ 下；这里保留名册、顶栏、AI 大脑等外壳，并统一导出界面的公共接口（import * as UI from './ui.js'）。
import { setApp, $, $$, closeModal, openModal, esc, fmtTime, guarded, name, toast, ui, weekday, app, voice } from './ui/core.js';
import { renderFeed } from './ui/feed.js';
import { closeInspector, loadDetail, openInspector } from './ui/inspector.js';
import { storyModal } from './ui/story.js';

export { esc, fmtTime, weekday, face, name, toast, openModal, closeModal } from './ui/core.js';
export { onLog } from './ui/feed.js';
export { openInspector, closeInspector, onAgentChanged, bodyHTML } from './ui/inspector.js';
export { onStory, storyModal, sparkline } from './ui/story.js';
export { onProposals, buildModal } from './ui/build.js';
export { onEvolution, evolveModal } from './ui/evolve.js';
export { avatarModal, eventModal, newsModal, graphModal, helpModal, adminModal } from './ui/modals.js';
export { accountModal, requireLogin } from './ui/auth.js';

/** 按世界的叙述口吻设置页面标题与品牌 */
function applyVoice() {
  const v = voice();
  document.title = `${v.name} · AI Town`;
  for (const el of document.querySelectorAll('.brand-name, #loading h1')) el.textContent = v.name;
  for (const el of document.querySelectorAll('.brand-icon, .load-logo')) el.textContent = v.emoji;
  $('.brand')?.setAttribute('title', `${v.name} · 回到世界大厅`);
  $('#btn-news')?.setAttribute('title', v.chronicle.name);
  const span = $('#btn-news span');
  if (span) span.textContent = v.chronicle.kind;
}

export function init(a, first) {
  setApp(a);
  applyVoice();
  buildRoster();
  renderFeed();
  updateBrain();
  onRegions();
  if (!first) { if (app.selected) openInspector(app.selected); return; }
  $$('#speed button').forEach((b) => b.addEventListener('click', () => {
    const sp = Number(b.dataset.speed);
    sp === 0 ? togglePause() : setSpeed(sp);
  }));
  // 底部 Dock 的按钮（天气 / 事件 / 日报 / 关系网 / 建设）由 hud.js 绑定
  $('#story-chip').addEventListener('click', () => storyModal());
  $('#region-chip').addEventListener('click', () => app.setView(app.view === 'town' ? nextRegion() : 'town'));
  $('#festival-chip').addEventListener('click', () => {
    app.forceFestival = !app.forceFestival;
    toast(app.forceFestival ? '🏮 萤火节灯会预览：夜晚时镜湖上会升起河灯与天灯' : '🏮 已关闭灯会预览');
  });
  $('#insp-close').addEventListener('click', closeInspector);
  const feedOpen = (open) => {
    const f = $('#feed'); f.classList.toggle('collapsed', !open);
    $('#feed-toggle').textContent = open ? '▾' : '▴';
    app.storage.set('town-feed-open', open ? '1' : null);
  };
  feedOpen(app.storage.get('town-feed-open') === '1' && innerWidth > 900);
  $('#feed-toggle').addEventListener('click', () => feedOpen($('#feed').classList.contains('collapsed')));
  $('#feed-latest').addEventListener('click', () => feedOpen(true));
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
}

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
    c.classList.toggle('watched', app.watch.has(a.id));
    c.querySelector('.rmood').textContent = a.mood || '';
    c.querySelector('.ract').textContent = a.thinking ? `✦ ${a.thinking}…` : a.status === 'chatting' ? `💬 与${name(app.snap.convos.find((x) => x.id === a.convo)?.[app.snap.convos.find((x) => x.id === a.convo)?.a === a.id ? 'b' : 'a'])}聊天` : `${a.emoji} ${a.action}`;
  }
}

export function tooltip(id, x, y) {
  const t = $('#tooltip');
  if (!id) { t.hidden = true; return; }
  const a = app.snap.agents.find((q) => q.id === id);
  t.hidden = false;
  t.innerHTML = `<b>${esc(name(id))}</b> <span style="color:var(--muted)">${esc(app.meta[id]?.role || '')}</span><br>${esc(a.emoji)} ${esc(a.action)}${a.thinking ? `<br><span style="color:#c4b5fd">✦ ${esc(a.thinking)}…</span>` : ''}`;
  t.style.left = `${x + 16}px`; t.style.top = `${y + 12}px`;
}

/** 世界被下架 / 归档：盖住画面，给出原因 */
export function worldClosed(reason) {
  const el = document.createElement('div');
  el.className = 'world-closed';
  el.innerHTML = `<div><h2>这个世界暂时关闭了</h2><p>${esc(reason || '')}</p><a href="../../">回到世界大厅</a></div>`;
  document.body.appendChild(el);
}

/** 举报：世界、居民或一条动态 */
export function reportModal(target = 'world') {
  const card = openModal(`<h2>🚩 举报</h2><div class="sub">如果这个世界里有不合适的内容（色情、现实政治、违法、针对真实的人……），告诉管理员。多位用户举报后，世界会暂时不在大厅公开。</div>
    <div class="pform"><textarea id="rp-reason" rows="3" maxlength="200" placeholder="哪里不合适？"></textarea><button class="primary" id="rp-go">提交</button><span class="quota" id="rp-msg"></span></div>`);
  $('#rp-go', card).onclick = guarded(async () => {
    await app.api(`../../api/worlds/${encodeURIComponent(app.perms.world)}/report`, { target, reason: $('#rp-reason', card).value });
    closeModal();
    toast('已提交，谢谢你');
  });
}

export function applyPerms() {
  const p = app.perms;
  // 游客也能看到互动入口：点下去先弹出登录框
  const canTry = p.interaction || p.loginToInteract;
  $('#speed').hidden = !p.admin;
  $('#mode-chip').hidden = p.admin;
  $('#mode-chip').textContent = p.interaction ? '🌿 访客模式' : p.loginToInteract ? '👀 游客（登录后可互动）' : '👀 观赏模式';
  $('#btn-event').hidden = !canTry;
  $('#dock-play').hidden = !canTry;
  $('#more-admin').hidden = !p.needToken && !p.admin;
  $('#more-account').hidden = !p.accounts;
  $('#more-account').textContent = p.user ? `👤 ${p.user.nickname}` : '👤 登录 / 注册';
  $('#more-report').hidden = !p.accounts || p.owner;
  document.body.classList.toggle('world-preview', p.worldStatus === 'preview');
  $('#btn-weather').hidden = !canTry;
  if (!canTry && ui.tab === 'chat') ui.tab = 'sched';
}

export const setSpeed = guarded(async (sp) => {
  if (!app.perms.admin) return;
  await app.api('/api/control', { speed: sp, paused: false });
});

export const togglePause = guarded(async () => {
  if (!app.perms.admin) return;
  await app.api('/api/control', { paused: !app.snap.paused });
});

export function escape() {
  if (!$('#modal').hidden) { closeModal(); return true; }
  for (const id of ['#more-menu', '#weather-menu', '#brain']) if (!$(id).hidden) { $(id).hidden = true; return true; }
  if (!$('#inspector').hidden) { closeInspector(); return true; }
  return false;
}

export function weatherMenu(btn) {
  const m = $('#weather-menu');
  if (!m.hidden) { m.hidden = true; return; }
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.min(innerWidth - 256, r.left)}px`; m.style.top = `${r.bottom + 8}px`;
  m.innerHTML = `<button data-w="auto">🔄 自动变化</button>` + Object.entries(app.weathers).map(([k, w]) => `<button data-w="${esc(k)}" class="${app.snap.weather === k ? 'on' : ''}">${esc(w.emoji)} ${esc(w.name)}</button>`).join('');
  m.hidden = false;
  // 按钮在底部 Dock 时下方放不下：改为在按钮上方展开
  if (r.bottom + 8 + m.offsetHeight > innerHeight) m.style.top = `${Math.max(8, r.top - m.offsetHeight - 8)}px`;
  $$('button', m).forEach((b) => b.addEventListener('click', guarded(async () => {
    m.hidden = true;
    await app.api('/api/control', { weather: b.dataset.w });
  })));
}

export function onAgents() {
  buildRoster();
  refreshRoster();
  if (app.selected && !app.meta[app.selected]) closeInspector();
}

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

export function onWorld(w) {
  toast(`🌀 ${esc(w.desc || w.op?.op || '')}`, 5000);
}

export function onNewspaper(p) {
  app.newspapers.push(p);
  toast(`📰 新一期《${esc(voice().chronicle.name)}》出炉：<b>${esc(p.headline)}</b>`, 7000);
}

export function updateBrain() {
  const s = app.llm;
  if (!s) return;
  $('#brain-dot').className = `brain-dot ${s.inflight ? 'on' : ''} ${!s.enabled || s.errors ? 'err' : ''}`;
  $('#brain-q').textContent = s.queued ? s.queued : s.inflight ? s.inflight : '';
  $('#brain-btn').title = s.enabled ? `AI 大脑：${s.model}${s.inflight ? ` · 思考中 ${s.inflight}` : ' · 空闲'}${s.queued ? ` · 排队 ${s.queued}` : ''}` : 'AI 大脑：未配置 LLM';
  $('#brain-model').textContent = s.enabled ? s.model : '未配置 LLM';
  const tk = s.tokens > 1e6 ? `${(s.tokens / 1e6).toFixed(2)}M` : `${(s.tokens / 1000).toFixed(1)}k`;
  const fmtK = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const budget = s.dailyBudget ? `<span title="今日令牌用量 / 每日预算">今日 ${fmtK(s.dayTokens)}/${fmtK(s.dailyBudget)}</span>` : `<span>令牌 ${tk}</span>`;
  const perDay = app.usageAvg ? `<span title="最近几个游戏日的平均用量">每游戏日≈${fmtK(app.usageAvg)}</span>` : '';
  // AI 表现指标（/api/metrics 有完整明细）：换模型时对比用
  const m = app.metrics, pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);
  const quality = m ? `<span title="约定兑现率：约好的事到点真的去了">赴约 ${pct(m.commitments.keptRate)}</span><span title="对话重复率：同一对人两天内聊的内容相近">重复 ${pct(m.convos.repeatRate)}</span><span title="JSON 需要让模型重写一次的比例 / 重写后仍失败的比例">JSON 修 ${pct(m.json.repairRate)}·败 ${pct(m.json.failRate)}</span>` : '';
  $('#brain-stats').innerHTML = `<span>调用 ${s.ok}</span>${budget}${perDay}${quality}<span>均 ${(s.avgMs / 1000).toFixed(1)}s</span>${app.snap?.idle ? '<span>💤</span>' : ''}${s.queued ? `<span>排队 ${s.queued}</span>` : ''}${s.errors ? `<span style="color:var(--bad)" title="${esc(s.lastError)}">错误 ${s.errors}</span>` : ''}`;
  $('#brain-active').innerHTML = s.active.slice(0, 6).map((x) => `<div class="bact"><b>${esc(x.agent || '')}</b> ${esc(x.label)}<span>${(x.ms / 1000).toFixed(0)}s</span></div>`).join('') || '<div style="color:var(--muted)">静候灵感中…</div>';
}
