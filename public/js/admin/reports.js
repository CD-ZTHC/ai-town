// 管理面板 · 举报：待处理的举报，一键跳转到对应世界；下架 / 恢复 / 驳回
import { api, esc, $, $$, toast, fmtTime } from '../site/api.js';

async function render(el, ctx) {
  const all = new URLSearchParams(location.search).get('all');
  const list = await api(`api/admin/reports${all ? '?all=1' : ''}`);
  el.innerHTML = `<div class="card">${list.length ? `<table><tr><th>时间</th><th>世界</th><th>对象</th><th>理由</th><th>举报人</th><th></th></tr>
    ${list.map((r) => `<tr><td class="small">${esc(fmtTime(r.created_at))}</td>
      <td><a href="../w/${esc(r.world_id)}/" target="_blank">${esc(r.worldTitle)}</a> <span class="pill">${esc(r.worldStatus || '')}</span></td>
      <td class="small">${esc(r.target)}</td><td>${esc(r.reason)}</td><td class="small">${esc(r.reporterName)}</td>
      <td>${r.handled_at ? `<span class="muted small">${esc(r.resolution)}</span>` : `<button class="small" data-dismiss="${r.id}">驳回</button>
        ${r.worldStatus !== 'suspended' ? `<button class="small danger" data-suspend="${esc(r.world_id)}" data-rid="${r.id}">下架世界</button>` : ''}`}</td></tr>`).join('')}</table>` : '<div class="empty">没有待处理的举报</div>'}</div>`;
  for (const b of $$('[data-dismiss]', el)) b.onclick = async () => { await api(`api/admin/reports/${b.dataset.dismiss}/handle`, { resolution: 'dismissed' }); ctx.reload(); };
  for (const b of $$('[data-suspend]', el)) {
    b.onclick = async () => {
      const reason = prompt('下架原因（owner 可以看到）：');
      if (!reason) return;
      await api(`api/admin/worlds/${b.dataset.suspend}/suspend`, { reason });
      await api(`api/admin/reports/${b.dataset.rid}/handle`, { resolution: 'suspended' });
      toast('已下架');
      ctx.reload();
    };
  }
}

export const page = { id: 'reports', title: '🚩 举报', render };
