// 居民检查器：状态卡、属性、日程、记忆、关系、日记、与居民聊天
import { $, $$, app, esc, face, toast, ui, weekday } from './core.js';
import { refreshRoster } from '../ui.js';
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

export function closeInspector() {
  $('#inspector').hidden = true;
  app.selected = null;
  app.follow = null;
  ui.detail = null;
  refreshRoster();
}

let detailTimer = null;

export function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(loadDetail, 350);
}

export function onAgentChanged(id) {
  if (id === app.selected) scheduleDetail();
}

export async function loadDetail() {
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
        ${[['attr', '📊 属性'], ['sched', '🗓️ 日程'], ['mem', '🧠 记忆'], ['rel', '💞 关系'], ['diary', '📖 日记'], ...(app.perms.canTry ? [['chat', '💬 交谈']] : [])].map(([k, l]) => `<button data-t="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}
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
        <button id="b-watch" class="${app.watch.has(d.id) ? 'on' : ''}" title="关注后，TA 有新动向时会提醒你；沉浸模式也会更常拍到 TA">🔔 ${app.watch.has(d.id) ? '已关注' : '关注'}</button>
        ${app.perms.canTry ? '<button id="b-chat">💬 搭话</button><button id="b-whisper">💭 心声</button>' : ''}
      </div>
    </div>`;
  $('#b-follow').onclick = () => { app.follow = app.follow === d.id ? null : d.id; renderInspector(false); };
  $('#b-watch').onclick = () => { app.toggleWatch(d.id); renderInspector(false); refreshRoster(); };
  if ($('#b-chat')) $('#b-chat').onclick = () => { ui.tab = 'chat'; ui.chatMode = 'visitor'; renderInspector(true); };
  if ($('#b-whisper')) $('#b-whisper').onclick = () => { ui.tab = 'chat'; ui.chatMode = 'whisper'; renderInspector(true); };
  $('#inow').innerHTML = `
    <div class="act">${esc(d.action.emoji)} ${esc(d.action.text)}</div>
    <div class="where">📍 ${esc(d.locName)}</div>
    ${d.thought ? `<div class="thought" title="${esc(d.thought)}"><span>“${esc(d.thought)}”</span></div>` : ''}`;
  renderPane(fresh);
}

// 体力 / 勇气、状态、物品与能力（P1）
export function bodyHTML(d) {
  if (!d.body) return '';
  const bar = (label, v, cls) => `<div class="meter ${cls}"><span>${label}</span><i><b style="width:${Math.max(0, Math.min(100, v))}%"></b></i><em>${v}</em></div>`;
  const inv = (d.inventory || []).map((x) => `<span class="chip-item" title="${esc(x.name)}">${esc(x.emoji)} ${esc(x.name)}×${x.n}</span>`).join('');
  const abs = (d.abilities || []).map((x) => `<span class="chip-ab${x.cooldown ? ' cd' : ''}" title="${esc(x.desc)}${x.cooldown ? `（冷却 ${x.cooldown} 分钟）` : ''}">${esc(x.emoji)} ${esc(x.name)}${x.cooldown ? ' ⏳' : ''}</span>`).join('');
  // 黑暗叙事：伤势、负担值、寄宿、禁忌姿态、立场
  const POSTURE = { eyesClosed: '闭着眼', silent: '不出声', noOpen: '不开门', stayLit: '待在亮处', notAlone: '不落单' };
  const dark = [
    d.alignment === 'villain' ? '<span class="dk vil">反派</span>' : '',
    d.marked ? '<span class="dk mark">👁️ 被盯上了</span>' : '',
    d.captive ? `<span class="dk">⛓️ 被${esc(typeof d.captive === 'string' ? d.captive : '人')}关着</span>` : '',
    ...(d.hosted || []).map((h) => `<span class="dk host">${esc(h.emoji)} 寄宿：${esc(h.name)}</span>`),
    ...(d.posture || []).map((p) => `<span class="dk">🤐 ${esc(POSTURE[p] || p)}</span>`),
  ].join('');
  return `<div class="ibody">
    ${d.body.hp < 100 ? bar('伤势', Math.round(d.body.hp), 'hp') : ''}${(d.burdens || []).map((b) => bar(b.name, Math.round((b.value / b.max) * 100), 'bu')).join('')}
    ${bar('体力', d.body.stamina, 'st')}${bar('勇气', d.body.courage, 'co')}
    ${dark ? `<div class="conds dark">${dark}</div>` : ''}
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
  if (ui.tab === 'attr') {
    pane.innerHTML = `<div class="iattr">
      <div class="goal"><b>长期目标</b> ${esc(d.goal)}</div>
      ${d.todayGoal ? `<div class="goal"><b>今日心愿</b> ${esc(d.todayGoal)}</div>` : ''}
      ${bodyHTML(d)}
    </div>`;
  } else if (ui.tab === 'sched') {
    const now = app.snap.t % 1440;
    pane.innerHTML = d.schedule.length ? `<div class="sched">${d.schedule.map((e) => {
      const cls = now >= e.end ? 'past' : now >= e.start ? 'now' : '';
      return `<div class="sitem ${cls} ${e.src === 'commit' ? 'commit' : ''}"><div class="se">${esc(e.emoji)}</div><div><div class="st">${e.time}${e.src === 'commit' ? ' · 📌 约定' : ''}</div><div class="sa">${esc(e.activity)}</div><div class="sl">📍 ${esc(e.locName)}</div></div></div>`;
    }).join('')}</div>` : '<div class="empty">🧠 正在规划今天的日程……</div>';
    const cur = reset && $('.sitem.now', pane);
    if (cur) { pane.scrollTop += cur.getBoundingClientRect().top - pane.getBoundingClientRect().top - (pane.clientHeight - cur.offsetHeight) / 2; return; }
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
      // 认识的旅人（按账号记）：没有头像，用 🧳 标记
      const pic = r.traveller ? '<span class="rel-trav">🧳</span>' : `<img src="${face(r.id)}">`;
      return `<div class="rel" ${r.traveller ? '' : `data-agent="${r.id}"`}>${pic}<div class="rb"><div class="rn">${esc(r.name)}<span style="color:${v >= 0 ? 'var(--good)' : 'var(--bad)'}">${v > 0 ? '+' : ''}${v}</span></div>
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
