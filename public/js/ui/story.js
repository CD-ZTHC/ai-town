// 故事面板：张力曲线、剧情弧、导演笔记、抉择投票、伏笔、人来人往、危机、生物图鉴
import { $, $$, app, esc, fmtTime, openModal, toast, ui, voice } from './core.js';
import { renderEpic, renderOutline } from './epic.js';
let storyPending = null;

export function onStory() {
  if (!ui.storyOpen || storyPending) return;
  // 正在读章节、编辑大纲或看计划时不刷新（会冲掉输入）
  if ((ui.storyTab === 'epic' && ui.epicView) || (ui.storyTab === 'outline' && (ui.outlineEdit || ui.outlinePanel))) return;
  storyPending = setTimeout(() => { storyPending = null; if (ui.storyOpen) renderStory(); }, 600);
}

const PHASE_ICON = { omen: '🔮', breach: '🌀', struggle: '⚔️', climax: '🌕', aftermath: '🌅' };

const TH_STATUS = { open: ['未展开', 'open'], advanced: ['进行中', 'adv'], resolved: ['已回收', 'done'] };

export function storyModal(tab) {
  ui.storyTab = tab || ui.storyTab || 'story';
  const card = openModal(`<h2>🎭 ${esc(voice().place || '小镇')}的故事</h2>
    <div class="sub">叙事导演根据小镇的「张力」安排伏笔、冲突与喘息；剧情弧在关键时刻交给小镇（和你）来抉择。</div>
    <div class="tabs stabs">${[['story', '📖 剧情'], ['epic', '📜 史诗'], ['outline', '🗺️ 大纲'], ...(app.spec?.threats && Object.keys(app.spec.threats).length ? [['incidents', '🕯️ 事件']] : []), ['vote', '🗳️ 抉择'], ['threads', '🧵 伏笔'], ['people', '🧳 人来人往'], ['crisis', '⚔️ 危机'], ['bestiary', '👾 图鉴']].map(([k, l]) => `<button data-t="${k}" class="${ui.storyTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="story-body" class="story-body"><div class="empty">正在翻开故事书……</div></div>`, 'story-wrap');
  card.style.width = 'min(760px, 94vw)';
  $$('.stabs button', card).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.t !== ui.storyTab && b.dataset.t !== 'epic') ui.epicView = null;
    ui.storyTab = b.dataset.t;
    $$('.stabs button', card).forEach((x) => x.classList.toggle('on', x === b));
    renderStory();
  }));
  ui.storyOpen = true;
  renderStory();
}

export function sparkline(history) {
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
  if (ui.storyTab === 'epic') return renderEpic(body);
  if (ui.storyTab === 'outline') return renderOutline(body);
  let d;
  try { d = await app.api('/api/story'); } catch (e) { body.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; return; }
  if (!$('#story-body')) return;
  const tab = ui.storyTab;
  const ST = { gentle: '🌸 静水', voyage: '🗺️ 远航', chaos: '🎲 掷骰', horror: '🕯️ 恐怖' };
  const RT = { cozy: '温馨', adventure: '冒险', epic: '史诗', dark: '黑暗', tragic: '悲剧' };
  let html = '';
  if (tab === 'story') {
    const arcs = d.arcs.map((a) => `<div class="arc ${a.status}">
      <b>${esc(a.emoji || '🌀')} 《${esc(a.title)}》</b> <small>${a.status === 'active' ? '进行中' : '已落幕'}${a.outcome ? ` · 结局「${esc(a.outcome.title)}」` : ''}</small>
      <div class="phases">${a.phases.map((p) => { const i = a.phases.findIndex((x) => x.id === a.phase); const j = a.phases.indexOf(p); return `<span class="${j < i || a.status === 'done' ? 'past' : j === i ? 'now' : ''}">${PHASE_ICON[p.id] || '•'} ${esc(p.name)}</span>`; }).join('<i>›</i>')}</div></div>`).join('');
    html = `<div class="srow"><span>叙事者 <b>${ST[d.storyteller] || d.storyteller}</b></span><span>内容分级 <b>${RT[d.rating] || d.rating}</b></span>
      <span>当前张力 <b>${d.tension?.value ?? '—'}</b> / 目标 ${d.tension?.target ?? '—'}</span></div>
      ${sparkline(d.history)}
      <h3>剧情弧</h3>${arcs || '<div class="empty">还没有剧情弧开启。远航 / 掷骰叙事者会在夜里自动开启，管理员也可以手动开启。</div>'}
      ${d.admin && !d.arcs.some((a) => a.status === 'active') ? (d.arcTemplates || []).map((a) => `<button class="primary" data-arc="${esc(a.id)}">🌀 开启《${esc(a.title)}》</button>`).join(' ') : ''}
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
          ${open && !v.mine && app.perms.canTry ? `<button class="mini" data-vote="${v.id}" data-opt="${o.id}">投这个</button>` : ''}
          ${open && d.admin ? `<button class="mini adm" data-decide="${v.id}" data-opt="${o.id}">终审</button>` : ''}</div>`; }).join('')}</div>`;
    }).join('') || '<div class="empty">目前没有需要小镇抉择的事。剧情走到关键时刻时，这里会出现投票。</div>';
  } else if (tab === 'threads') {
    html = d.threads.map((t) => `<div class="thread ${TH_STATUS[t.status][1]}"><div><b>${esc(t.title)}</b><span class="badge">${TH_STATUS[t.status][0]}</span></div>
      <small>${esc(t.hook)}</small>${t.notes.length ? `<div class="tnotes">${t.notes.map((n) => `<div>· ${fmtTime(n.t)} ${esc(n.text)}</div>`).join('')}</div>` : ''}</div>`).join('');
  } else if (tab === 'people') {
    const m = d.migration;
    const KIND = { arrive: '到来', leave: '出门', return: '回来', settle: '定居' };
    const BY = { owner: '（创建者）', admin: '（管理员）' };
    const here = m.people.filter((p) => p.status !== 'departed');
    const gone = m.people.filter((p) => p.status === 'departed');
    html = `<div class="srow"><span>在场 <b>${m.count}</b> / 上限 ${m.cap}</span><span>人员流动 <b>${m.enabled ? '开启' : '关闭'}</b></span>
      ${d.admin && m.enabled ? '<button class="mini" id="mig-go">让导演现在安排一次</button>' : ''}</div>
      <div class="sub">会有人慕名而来、投亲靠友，也会有人出门远行、过些日子再回来。新来的人和大家熟悉之后会定居下来。没有人会永远消失。</div>
      <h3>最近的人来人往</h3>${m.history.map((h) => `<div class="dec"><b>第${h.day}天</b> ${esc(h.text)}${BY[h.by] || ''}</div>`).join('') || '<div class="empty">还没有人来去。</div>'}
      ${gone.length ? `<h3>出门在外</h3>${gone.map((p) => { const a = m.away.find((x) => x.id === p.id); return `<div class="dec">🧳 <b>${esc(p.name)}</b> · ${esc(p.role)}${a?.where ? ` · 在${esc(a.where)}` : ''}${a?.returnDay ? ` · 约好第${a.returnDay}天回来` : ''}${d.admin ? ` <button class="mini adm" data-prec="${esc(p.id)}">召回</button>` : ''}</div>`; }).join('')}` : ''}
      ${d.admin ? `<h3>在场的人</h3>${here.map((p) => `<div class="dec">${p.kind === 'traveller' ? '🧳' : '🏠'} <b>${esc(p.name)}</b> · ${esc(p.role)}${p.arrivedDay ? ` · 第${p.arrivedDay}天从${esc(p.from || '远方')}来` : ''} <button class="mini adm" data-pdep="${esc(p.id)}">请离</button></div>`).join('')}
        <div class="sub">「请离」和「召回」互为撤销；剧情弧里的角色由剧情安排，不在这里。</div>` : ''}`;
  } else if (tab === 'incidents') {
    const k = d.dark || { incidents: [], deaths: [], population: [], contained: [], crowdDead: 0 };
    const STAGE = { omen: 'omen', outbreak: 'hot', spread: 'hot', handled: 'done', abandoned: 'done', aftermath: 'done' };
    const OUT = { contained: '已收容', resolved: '已化解', slain: '已消灭', abandoned: '划为封锁区', hosted: '被人寄宿' };
    html = `<div class="srow"><span>🕯️ 群众遇害 <b>${k.crowdDead}</b></span><span>🪦 居民遇害 <b>${k.deaths.length}</b></span><span>📦 收容中 <b>${k.contained.length}</b></span></div>
      <h3>事件</h3>${k.incidents.map((i) => `<div class="dec inc ${STAGE[i.stage] || ''}">📍 <b>${esc(i.locName)}</b> · ${esc(i.name)} · 第${i.day}天起 · <b>${esc(i.stageName)}</b>${i.outcome ? `（${OUT[i.outcome] || esc(i.outcome)}）` : ''}
        <div class="sub">遇害：居民 ${i.victims} · 群众 ${i.crowd}${i.assigned.length ? ` · 派去处理：${i.assigned.map(esc).join('、')}` : ''}</div></div>`).join('') || '<div class="empty">暂时平静。</div>'}
      ${k.deaths.length ? `<h3>逝者</h3>${k.deaths.map((x) => `<div class="dec">🪦 <b>${esc(x.name)}</b> · 第${x.day}天 · ${esc(x.text || '')}</div>`).join('')}` : ''}
      ${k.contained.length ? `<h3>收容中</h3>${k.contained.map((c) => `<div class="dec">📦 ${esc(c.name)} · 由 ${esc(c.holder)} 保管</div>`).join('')}` : ''}
      ${k.population.length ? `<h3>各处人口</h3><div class="pops">${k.population.map((p) => `<span>${esc(p.name)} <b>${p.alive}</b>${p.dead ? ` <em>−${p.dead}</em>` : ''}</span>`).join('')}</div>` : ''}
      <div class="sub">规律只有世界自己知道；居民只能从目击、幸存和调查里拼凑出自己的看法，看法可能是错的。</div>`;
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
  $$('[data-arc]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/arc/start', { template: b.dataset.arc }); renderStory(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-pdep]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('让这个人暂时离开吗？之后可以在这里召回。')) return;
    try { await app.api('/api/people/depart', { id: b.dataset.pdep }); renderStory(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $$('[data-prec]', body).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/people/recall', { id: b.dataset.prec }); renderStory(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  const mg = $('#mig-go', body);
  if (mg) mg.onclick = async () => {
    mg.disabled = true; mg.textContent = '导演思考中…';
    try { const r = await app.api('/api/people/run', {}); toast(r.change === 'none' ? `🤔 导演觉得现在没有合适的变动${r.reason ? `：${esc(r.reason)}` : ''}` : `🧳 ${esc(r.name || '')} ${{ arrive: '来了', leave: '出门了', return: '回来了' }[r.change] || ''}`); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
    renderStory();
  };
  const dg = $('#dir-go', body);
  if (dg) dg.onclick = async () => { dg.disabled = true; dg.textContent = '导演思考中…'; try { await app.api('/api/director/decide', {}); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } renderStory(); };
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
