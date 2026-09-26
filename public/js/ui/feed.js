// 动态流：日志条目的渲染、筛选、「最新」提示
import { $, $$, app, esc, face, fmtTime, name, toast, ui } from './core.js';
import { scheduleDetail } from './inspector.js';
import { newsModal } from './modals.js';
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

const feedMatch = (l, f = ui.feedFilter) => f === 'all' || (f === 'watch' ? (l.agents || []).some((id) => app.watch.has(id)) : FEED_GROUPS[f]?.includes(l.type));

// 折叠时只显示最新一条；剧情、约定、抉择等重要条目会短暂高亮
const LATEST_SKIP = new Set(['system', 'weather', 'plan']);

const LATEST_HOT = new Set(['commit', 'event', 'vote', 'arc', 'portal', 'arrival', 'news', 'encounter']);

function setLatest(l) {
  const el = $('#feed-latest');
  if (!el || !l || LATEST_SKIP.has(l.type)) return;
  const faces = (l.agents || []).slice(0, 2).map((id) => `<img src="${face(id)}" alt="">`).join('');
  const icon = { convo: '💬', scene: '🎭', thought: '💭', reflect: '✨', event: '📢', news: '📰', commit: '📌' }[l.type] || '•';
  el.innerHTML = `<span class="faces">${faces}</span><span class="lt">${fmtTime(l.t)}</span><span class="lx">${icon} ${esc(l.text)}</span>`;
  if (LATEST_HOT.has(l.type) || STORY_TYPES.includes(l.type)) { el.classList.remove('hot'); void el.offsetWidth; el.classList.add('hot'); }
}

export function renderFeed() {
  const items = app.logs.filter((l) => feedMatch(l)).slice(-120).reverse();
  setLatest([...app.logs].reverse().find((l) => !LATEST_SKIP.has(l.type)));
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
  setLatest(l);
  if (feedMatch(l)) {
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
  // 关注的居民有新动向时提醒
  const w = (l.agents || []).filter((id) => app.watch.has(id));
  if (w.length && ['convo', 'scene', 'reflect', 'reaction', 'gift', 'learn'].includes(l.type)) toast(`🔔 <b>${esc(name(w[0]))}</b>：${esc(String(l.text).slice(0, 60))}`, 4500);
  app.onLogHooks?.forEach((fn) => fn(l));
}
