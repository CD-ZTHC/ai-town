// 管理面板 · 进化（多世界设计 §9、§14.9）：引擎状态、各世界的进化任务、待终审的插件、上线记录与回滚
import { api, esc, fmtTime } from '../site/api.js';

const ST = { pending: '待终审', approved: '已批准', canary: '灰度中', active: '已上线', rolledBack: '已回滚', rejected: '被驳回', disabled: '已停用', superseded: '已被新版本取代' };

async function render(el) {
  const d = await api('api/admin/evolution');
  const e = d.engine || {};
  el.innerHTML = `
    <div class="card stack" style="margin-bottom:14px"><h2>进化引擎</h2>
      <div>${e.running ? '🟢 运行中' : '⚪ 没有运行'} · 状态 ${esc(e.state || '—')} · 开启进化的世界：${(e.worlds || []).map((w) => `<code>${esc(w)}</code>`).join(' ') || '没有'}</div>
      <div class="small muted">每个世界每天 ${e.budgetLimit || '不限'} tokens · 公网自动上线范围 ${esc(e.publicDeploy || '')} · 评审模型 ${esc(e.reviewModel || '与实施相同')}</div>
      ${e.last ? `<div class="small">最近：${esc(e.last.world || '')} ${esc(e.last.title || '')} → ${esc(e.last.status)} ${esc(e.last.reason || '')}</div>` : ''}</div>
    <div class="card" style="margin-bottom:14px"><h2>任务</h2>${(e.jobs || []).length ? `<table><tr><th>世界</th><th>需求</th><th>状态</th><th>开始</th></tr>
      ${e.jobs.map((j) => `<tr><td><code>${esc(j.worldId)}</code></td><td>${esc(j.title || j.need || '')}<div class="small muted">${esc(j.reason || '')}</div></td><td><span class="pill">${esc(j.status)}</span> ${esc(j.stage || '')}</td><td class="small">${esc(fmtTime(j.startedAt))}</td></tr>`).join('')}</table>` : '<div class="muted small">还没有任务</div>'}</div>
    ${d.worlds.map((w) => `<div class="card" style="margin-bottom:14px"><h2>${esc(w.title)} <span class="muted small">${esc(w.id)}</span>${w.pending ? ` <span class="pill warn">${w.pending} 个待终审</span>` : ''}</h2>
      ${w.plugins.length ? `<table><tr><th>插件</th><th>层级</th><th>状态</th><th>调用 / 出错</th></tr>${w.plugins.map((p) => `<tr><td>${esc(p.title)} <code>${esc(p.key)}</code><div class="small muted">${esc(p.summary || '')}</div></td><td>${esc(p.tier)}</td><td>${ST[p.status] || esc(p.status)}${p.reason ? `<div class="small muted">${esc(p.reason)}</div>` : ''}</td><td>${p.calls} / ${p.errors}</td></tr>`).join('')}</table>` : '<div class="muted small">没有 AI 插件</div>'}
      <div class="small muted">停用、回滚、启用在世界页面的「进化」面板里操作（管理员或世界的创建者）</div></div>`).join('')}`;
}

export const page = { id: 'evolution', title: '🧬 进化', render };
