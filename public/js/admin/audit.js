// 管理面板 · 审计：所有管理操作和设置变更的记录，可按人、按类型筛选
import { api, esc, $, fmtTime } from '../site/api.js';

async function render(el) {
  el.innerHTML = `<div class="row" style="margin-bottom:12px">
      <input id="a-actor" placeholder="操作人账号 id" style="max-width:220px">
      <select id="a-action"><option value="">全部类型</option>${['settings', 'user', 'grant', 'admin', 'world', 'report', 'server', 'genesis', 'decision'].map((x) => `<option>${x}</option>`).join('')}</select>
      <button id="a-go">筛选</button>
    </div><div class="card" id="a-list"></div>`;
  const load = async () => {
    const list = await api(`api/admin/audit?actor=${encodeURIComponent($('#a-actor', el).value.trim())}&action=${encodeURIComponent($('#a-action', el).value)}`);
    $('#a-list', el).innerHTML = list.length ? `<table><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>详情</th></tr>
      ${list.map((a) => `<tr><td class="small">${esc(fmtTime(a.at))}</td><td>${esc(a.actorName || a.actor)}</td><td><code>${esc(a.action)}</code></td><td class="small">${esc(a.target)}</td>
        <td class="small"><code>${esc(JSON.stringify(a.detail)).slice(0, 300)}</code></td></tr>`).join('')}</table>` : '<div class="empty">没有记录</div>';
  };
  $('#a-go', el).onclick = load;
  await load();
}

export const page = { id: 'audit', title: '📜 审计', render };
