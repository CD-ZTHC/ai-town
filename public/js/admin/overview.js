// 管理面板 · 概览：在线人数、运行中的世界、今日 token 用量和预算、队列长度、最近的告警（启动失败回退、磁盘超限、举报）
import { api, esc, fmtNum, fmtTime } from '../site/api.js';

const ALERT = {
  'settings.rollback': '⚠️ 设置启动失败已回退', 'world.unlisted': '🚩 世界转为不公开', 'world.suspend': '⛔ 世界被下架', 'world.sample-hit': '🔎 抽样审核命中',
  'world.publish-rejected': '📝 发布审核没通过', 'genesis.failed': '✨ 创世失败', 'admin.token': '🔑 使用了管理员令牌', 'disk.full': '💾 磁盘超限',
  'memory.high': '🧠 内存超过告警阈值',
};
const KIND = { sandbox: '插件沙箱', 'sandbox-test': '插件测试', evolve: '进化引擎', 'genesis-trial': '创世试跑' };

/** 内存（重构方案 §6.2）：服务进程、子进程、SSE 积压 */
function memoryCard(m) {
  if (!m) return '';
  const p = m.process;
  const high = m.alertMb > 0 && p.rss > m.alertMb;
  const kids = Object.entries(m.byKind).map(([k, g]) => `${esc(KIND[k] || k)} ${g.count} 个${g.rss ? `（${g.rss}MB）` : ''}`).join(' · ') || '没有';
  return `<div class="card" style="margin-bottom:14px"><h2>内存</h2>
    ${high ? `<div class="bad" style="margin-bottom:6px">⚠️ 服务进程常驻内存 ${p.rss}MB，超过告警阈值 ${m.alertMb}MB</div>` : ''}
    <div class="small">服务进程：常驻 <b class="${high ? 'bad' : ''}">${p.rss}MB</b> · 堆 ${p.heapUsed} / ${p.heapTotal}MB（上限 ${m.heapLimitMb}MB）· 堆外 ${p.external}MB（ArrayBuffer ${p.arrayBuffers}MB）</div>
    <div class="small">子进程：${kids}</div>
    <div class="small">推送：${m.sse.clients} 个连接 · 积压 ${m.sse.backlogKb}KB（最多的一个 ${m.sse.maxBacklogKb}KB）· 运行中的世界 ${m.worlds} 个</div></div>`;
}

async function render(el) {
  const d = await api('api/admin/overview');
  const l = d.llm || {};
  el.innerHTML = `
    <div class="stats" style="margin-bottom:14px">
      <div class="card stat"><span class="muted small">在线</span><b>${d.online}</b><span class="small muted">注册用户 ${fmtNum(d.users)}</span></div>
      <div class="card stat"><span class="muted small">运行中的世界</span><b>${d.running.length} / ${d.max}</b><span class="small muted">公开 ${d.worlds.public || 0} · 预览 ${d.worlds.preview || 0}</span></div>
      <div class="card stat"><span class="muted small">今日 token</span><b>${fmtNum(l.dayTokens)}</b><span class="small muted">${l.dailyBudget ? `预算 ${fmtNum(l.dailyBudget)}` : '不限'}</span></div>
      <div class="card stat"><span class="muted small">排队</span><b>${(l.classes || []).reduce((s, c) => s + c.queued, 0)}</b><span class="small muted">进行中 ${l.inflight ?? 0} / ${l.concurrency ?? '-'}</span></div>
      <div class="card stat"><span class="muted small">待处理举报</span><b class="${d.openReports ? 'warn' : ''}">${d.openReports}</b><span class="small muted">已下架 ${d.worlds.suspended || 0} · 不公开 ${d.worlds.unlisted || 0}</span></div>
    </div>
    ${memoryCard(d.memory)}
    <div class="card" style="margin-bottom:14px"><h2>运行中的世界</h2>${d.running.map((w) => `<div>${esc(w.id)} · 第 ${w.day} 天 · ${w.viewers} 人在看${w.idle ? ' · 休眠' : ''}${w.pinned ? ' · 常驻' : ''}${w.diskFull ? ' · <span class="bad">磁盘超限</span>' : ''}</div>`).join('') || '<div class="muted">没有</div>'}</div>
    <div class="card"><h2>最近的告警</h2>${d.alerts.map((a) => `<div class="small">${esc(fmtTime(a.at))} · ${ALERT[a.action] || esc(a.action)} · ${esc(a.target)} <span class="muted">${esc(JSON.stringify(a.detail || {})).slice(0, 160)}</span></div>`).join('') || '<div class="muted small">没有告警</div>'}</div>`;
}

export const page = { id: 'overview', title: '📊 概览', render };
