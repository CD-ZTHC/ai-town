// 建设面板：提案与审批、选址预览、AI 心愿单、时光回溯、时间线、区域
import { $, $$, app, closeModal, esc, fmtLeft, fmtTime, name, openModal, toast, ui } from './core.js';
let buildPending = null;

export function onProposals() {
  if (!ui.buildOpen || buildPending) return;
  buildPending = setTimeout(() => { buildPending = null; if (ui.buildOpen) renderBuild(); }, 600);
}

const P_STATUS = {
  review: ['🔎 考据中', 'rev'], council: ['🏛️ 居民议事中', 'vote'], voting: ['🗳️ 征求意见', 'vote'], awaiting: ['⏳ 等待终审', 'wait'], queued: ['📋 排队动工', 'wait'],
  building: ['🚧 施工中', 'build'], applied: ['✅ 已落地', 'ok'], rejected: ['❌ 已驳回', 'no'], failed: ['⚠️ 未能实施', 'no'], expired: ['⌛ 已作废', 'no'], reverted: ['↩️ 已撤销', 'no'],
};

/** 拆除的议事：当事人是否同意、每位居民的表态与理由、判定结果 */
function councilHTML(c) {
  if (!c) return '';
  const vote = (v) => `<span class="cv ${v.yes == null ? '' : v.yes ? 'yes' : 'no'}" title="${esc(v.reason)}">${v.yes == null ? '…' : v.yes ? '👍' : '👎'} ${esc(v.name)}</span>`;
  const head = c.status === 'meeting' ? '议事会还没开' : c.status === 'deliberating' ? '大家正在表态' : c.pass ? `通过：${esc(c.why || '')}` : `否决：${esc(c.why || '')}`;
  return `<div class="pcouncil"><div>🏛️ 议事「${esc(c.building)}」 · ${head}</div>
    ${c.summary ? `<div class="quota">${esc(c.summary)}</div>` : ''}
    ${c.stakeholders.length ? `<div>当事人：${c.stakeholders.map((v) => `${vote(v)}${v.reason ? `<small>「${esc(v.reason)}」</small>` : ''}`).join(' ')}</div>` : ''}
    ${c.status === 'done' ? `<div>居民：${c.votes.map(vote).join(' ')}</div>` : ''}</div>`;
}

const P_LEVEL = { micro: '微调', minor: '小改', major: '大改' };

export function buildModal(tab) {
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
      const form = app.perms.canTry ? `<div class="pform"><textarea id="p-intent" rows="2" maxlength="120" placeholder="给小镇提个建设点子，例如：在码头边修一座可以看星星的小塔"></textarea>
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
          ${councilHTML(p.council)}
          ${p.canon?.issues?.length ? `<div class="pcanon">📜 考据官：${p.canon.issues.map(esc).join('；')}</div>` : ''}
          ${p.result?.reason ? `<div class="pcanon">${esc(p.result.reason)}</div>` : ''}
          <div class="pact">
            ${open || p.tally.yes || p.tally.no ? `<span class="quota">赞成 ${p.tally.yes} · 反对 ${p.tally.no}</span>` : ''}
            ${open && p.mine == null && app.perms.canTry ? `<button class="mini" data-pv="${p.id}" data-yes="1">👍 赞成</button><button class="mini" data-pv="${p.id}" data-yes="0">👎 反对</button>` : ''}
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
