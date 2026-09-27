// 管理面板 · 调度（多世界设计 §7.6）：各级别队列长度与等待时间、各世界用量排行与降级档位、正在进行的调用；可以对单个世界「暂停 AI」
import { api, esc, $, $$, toast, fmtNum } from '../site/api.js';

const sec = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} 分` : `${Math.round(ms / 1000)} 秒`);

async function render(el, ctx) {
  const d = await api('api/admin/llm');
  const pool = d.pool || {};
  el.innerHTML = `
    <div class="stats" style="margin-bottom:14px">
      <div class="card stat"><span class="muted small">并发</span><b>${d.inflight} / ${d.concurrency}</b></div>
      <div class="card stat"><span class="muted small">今日用量</span><b>${fmtNum(d.dayTokens)}</b><span class="small muted">${d.dailyBudget ? `预算 ${fmtNum(d.dailyBudget)}` : '不限'}</span></div>
      <div class="card stat"><span class="muted small">用户世界共享池剩余</span><b>${Number.isFinite(pool.left) ? fmtNum(Math.max(0, Math.round(pool.left))) : '不限'}</b></div>
    </div>
    <div class="card" style="margin-bottom:14px"><h2>队列</h2><table><tr><th>级别</th><th>排队</th><th>进行中</th><th>最久等待</th><th>平均等待</th><th>按世界</th></tr>
      ${d.classes.map((c) => `<tr><td><b>${c.cls}</b> ${esc(c.name)}</td><td>${c.queued}</td><td>${c.inflight}</td><td>${c.oldestMs ? sec(c.oldestMs) : '—'}</td><td>${c.avgWaitMs ? sec(c.avgWaitMs) : '—'}</td>
        <td class="small">${Object.entries(c.byWorld).map(([w, n]) => `${esc(w)}×${n}`).join(' ') || '—'}</td></tr>`).join('')}</table></div>
    <div class="card" style="margin-bottom:14px"><h2>今日各世界用量</h2>${d.ranking.length ? `<table><tr><th>世界</th><th>合计</th><th>P0 交互</th><th>P1 心跳</th><th>P2 叙事</th><th>P3 创世</th><th>P4 进化</th><th>日额度</th><th>档位</th><th></th></tr>
      ${d.ranking.map((r) => `<tr><td>${esc(r.title)}<div class="muted small">${esc(r.id)}</div></td><td><b>${fmtNum(r.total)}</b></td>${['P0', 'P1', 'P2', 'P3', 'P4'].map((k) => `<td class="small">${fmtNum(r[k])}</td>`).join('')}
        <td class="small">${r.limit ? fmtNum(Math.round(r.limit)) : '不限'}</td><td><span class="pill ${r.level === 'normal' ? 'good' : r.level === 'quiet' ? 'warn' : 'bad'}">${esc(r.levelName)}</span></td>
        <td>${r.id !== '-' ? `<button class="small" data-ai="${esc(r.id)}" data-p="${r.level === 'paused' ? '0' : '1'}">${r.level === 'paused' ? '恢复 AI' : '暂停 AI'}</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">今天还没有调用</div>'}</div>
    <div class="card" style="margin-bottom:14px"><h2>创世任务</h2>${(d.genesis || []).length ? `<table><tr><th>世界</th><th>创世者</th><th>状态</th><th>阶段</th><th>用量</th><th>时间</th></tr>
      ${d.genesis.map((j) => `<tr><td>${esc(j.worldId)}</td><td>${esc(j.owner)}</td><td><span class="pill ${j.status === 'done' ? 'good' : j.status === 'failed' ? 'bad' : 'warn'}">${esc(j.status)}</span>${j.error ? `<div class="small bad">${esc(j.error)}</div>` : ''}</td><td>${esc(j.stage)}</td><td>${fmtNum(j.tokens)}</td><td class="small">${esc(new Date(j.createdAt).toLocaleString())}</td></tr>`).join('')}</table>` : '<div class="muted small">没有</div>'}</div>
    <div class="card"><h2>正在进行</h2>${d.active.map((a) => `<div class="small">${esc(a.label)} · ${esc(a.agent || '')} · ${sec(a.ms)}</div>`).join('') || '<div class="muted small">没有</div>'}</div>`;
  for (const b of $$('[data-ai]', el)) {
    b.onclick = async () => { await api(`api/admin/worlds/${b.dataset.ai}/ai`, { paused: b.dataset.p === '1' }); toast(b.dataset.p === '1' ? '已暂停这个世界的 AI' : '已恢复'); ctx.reload(); };
  }
}

export const page = { id: 'llm', title: '🧠 调度', render };
