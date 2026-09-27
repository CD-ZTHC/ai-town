// 🧬 进化面板：AI 插件、决策队列、进化引擎（自主演化 E1~E5）；AI 插件自己的面板运行在沙箱 iframe 里
import { $, $$, app, esc, fmtLeft, fmtTime, name, openModal, toast, ui } from './core.js';

let evoPending = null;
export function onEvolution() {
  if (!ui.evoOpen || evoPending || ui.panelOpen) return;
  evoPending = setTimeout(() => { evoPending = null; if (ui.evoOpen) renderEvolve(); }, 600);
}

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

export function evolveModal(tab) {
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
            ${p.status === 'pending' && app.perms.canTry ? `<button class="mini" data-ev="${esc(p.key)}" data-yes="1">👍 赞成上线</button><button class="mini" data-ev="${esc(p.key)}" data-yes="0">👎 反对</button>` : ''}
            ${d.admin && p.status === 'pending' && dec ? `<button class="mini adm" data-dd="${dec.id}" data-ok="1">✅ 批准</button><button class="mini adm" data-dd="${dec.id}" data-ok="0">✖ 驳回</button>` : ''}
            ${d.admin && ['canary', 'active'].includes(p.status) ? `<button class="mini adm" data-act="rollback" data-key="${esc(p.key)}">⏪ 回滚</button><button class="mini adm" data-act="disable" data-key="${esc(p.key)}">⏸ 停用</button>` : ''}
            ${d.admin && ['disabled', 'rolledBack', 'superseded', 'rejected', 'retired'].includes(p.status) ? `<button class="mini adm" data-act="enable" data-key="${esc(p.key)}">▶ 启用</button>` : ''}
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
