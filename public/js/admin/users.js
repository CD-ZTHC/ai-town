// 管理面板 · 用户（多世界设计 §14.9）：搜索、查看、停用 / 启用、密码重置链接、授予 / 收回创世权限并编辑配额、设为管理员
import { api, esc, $, $$, toast, dialog, fmtTime, ROOT } from '../site/api.js';

const ROLE = { user: '用户', admin: '管理员', super: '超级管理员' };
// 创世授予的配额项与默认值来源（留空 = 用设置里的默认值）
const QUOTA = [
  ['maxWorlds', '可创建的世界数', 'GENESIS_MAX_WORLDS'],
  ['maxSourceChars', '原文字数上限', 'GENESIS_MAX_SOURCE_CHARS'],
  ['genesisTokens', '创世 token 额度', 'GENESIS_TOKENS'],
  ['dailyWorldTokens', '每个世界每日 token', 'GENESIS_DAILY_WORLD_TOKENS'],
  ['diskMB', '每个世界磁盘上限（MB）', 'WORLD_DISK_MB'],
];
const RATINGS = ['cozy', 'adventure', 'epic', 'dark', 'tragic'];
const EXPLICIT = ['dark', 'tragic']; // 需要显式勾选的分级：默认不授予

async function render(el, ctx) {
  el.innerHTML = `<div class="row" style="margin-bottom:12px">
      <input id="u-q" placeholder="搜索用户名、昵称或账号 id" style="flex:1;max-width:360px"><button id="u-go">搜索</button><span class="muted small" id="u-total"></span>
    </div><div class="card" id="u-list"><div class="empty">加载中…</div></div>`;
  const load = async () => {
    const r = await api(`api/admin/users?q=${encodeURIComponent($('#u-q', el).value.trim())}`);
    $('#u-total', el).textContent = `共 ${r.total} 个账号`;
    $('#u-list', el).innerHTML = r.list.length ? `<table><tr><th>昵称</th><th>用户名</th><th>角色</th><th>授予</th><th>注册时间</th><th></th></tr>
      ${r.list.map((u) => `<tr>
        <td>${esc(u.nickname)} ${u.disabled ? '<span class="pill bad">已停用</span>' : ''}<div class="muted small">${esc(u.id)}</div></td>
        <td>${esc(u.username)}</td><td>${ROLE[u.role] || esc(u.role)}</td>
        <td>${u.grants.map((g) => `<span class="pill good">${esc(g.cap)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td class="small">${esc(fmtTime(u.createdAt))}</td>
        <td><button class="small" data-open="${esc(u.id)}">管理</button></td></tr>`).join('')}</table>` : '<div class="empty">没有找到账号</div>';
    for (const b of $$('[data-open]', el)) b.onclick = () => openUser(b.dataset.open, ctx, load);
  };
  $('#u-go', el).onclick = load;
  $('#u-q', el).onkeydown = (e) => { if (e.key === 'Enter') load(); };
  await load();
}

async function openUser(id, ctx, reload) {
  const u = await api(`api/admin/users/${encodeURIComponent(id)}`);
  const settings = await api('api/admin/settings').catch(() => ({ items: [] }));
  const def = Object.fromEntries(settings.items.map((x) => [x.key, x.value]));
  const g = u.grants.find((x) => x.cap === 'genesis');
  const q = g?.quota || {};
  const d = dialog(`<h2>${esc(u.nickname)} <span class="muted small">@${esc(u.username)}</span></h2>
    <div class="small muted">${esc(u.id)} · ${ROLE[u.role]} · 注册于 ${esc(fmtTime(u.createdAt))} · ${u.sessions.length} 个登录中的设备</div>
    <h3 style="margin-top:16px">✨ 创世权限 ${g ? '<span class="pill good">已授予</span>' : '<span class="pill">未授予</span>'}</h3>
    <div class="small muted">留空的项使用设置里的默认值。</div>
    ${QUOTA.map(([k, label, sk]) => `<label>${label}（默认 ${esc(def[sk] ?? '—')}）</label><input data-q="${k}" type="number" min="0" value="${q[k] ?? ''}" placeholder="${esc(def[sk] ?? '')}">`).join('')}
    <label>允许的分级</label><div class="row">${RATINGS.map((r) => `<label class="row small" style="margin:0"><input type="checkbox" data-rating="${r}" ${(q.ratings || ['cozy', 'adventure']).includes(r) ? 'checked' : ''}> ${r}${EXPLICIT.includes(r) ? '（需显式勾选）' : ''}</label>`).join('')}</div>
    <label>死亡预算上限（dark / tragic 世界里，每 3 天最多几名具名角色死亡；默认 2，20 表示基本不限）</label><input data-q="deathNamed" type="number" min="0" max="20" value="${q.deathNamed ?? ''}" placeholder="2">
    <label>有效期（留空为长期）</label><input id="g-exp" type="date" value="${g?.expiresAt ? new Date(g.expiresAt).toISOString().slice(0, 10) : ''}">
    <label>备注</label><input id="g-note" value="${esc(g?.note || '')}" maxlength="200">
    <div class="row" style="margin-top:10px"><button class="primary" id="g-save">${g ? '更新授予' : '授予创世权限'}</button>${g ? '<button class="danger" id="g-revoke">收回</button>' : ''}</div>
    <h3 style="margin-top:18px">账号</h3>
    <div class="row">
      ${u.disabled ? '<button id="u-enable">启用</button>' : '<button class="danger" id="u-disable">停用</button>'}
      <button id="u-reset">生成密码重置链接</button>
      ${u.role === 'user' ? '<button id="u-admin">设为管理员</button>' : u.role === 'admin' ? '<button id="u-unadmin">取消管理员</button>' : ''}
    </div>
    <div id="u-link" class="small" style="margin-top:8px;word-break:break-all"></div>
    <h3 style="margin-top:18px">最近的操作</h3>
    <div class="small">${u.audit.map((a) => `<div>${esc(fmtTime(a.at))} · <code>${esc(a.action)}</code> ${esc(a.target)}</div>`).join('') || '<span class="muted">—</span>'}</div>
    <div class="actions"><button id="u-close">关闭</button></div>`);
  d.el.style.width = 'min(560px, 100%)';
  const done = async (msg) => { toast(msg); d.close(); await reload(); };
  $('#u-close', d.el).onclick = d.close;
  $('#g-save', d.el).onclick = async () => {
    const quota = {};
    for (const i of $$('[data-q]', d.el)) if (i.value !== '') quota[i.dataset.q] = Number(i.value);
    quota.ratings = $$('[data-rating]', d.el).filter((x) => x.checked).map((x) => x.dataset.rating);
    const exp = $('#g-exp', d.el).value;
    await api(`api/admin/users/${id}/grants`, { cap: 'genesis', quota, expiresAt: exp ? `${exp}T23:59:59` : null, note: $('#g-note', d.el).value });
    done('✅ 已授予创世权限');
  };
  const on = (sel, fn) => { const b = $(sel, d.el); if (b) b.onclick = async () => { try { await fn(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } }; };
  on('#g-revoke', async () => { if (confirm('收回创世权限？已创建的世界不受影响。')) { await api(`api/admin/users/${id}/grants/genesis`, undefined, 'DELETE'); done('已收回'); } });
  on('#u-disable', async () => { const reason = prompt('停用原因（会写入审计）：'); if (reason == null) return; await api(`api/admin/users/${id}/disable`, { reason }); done('已停用，该账号的所有登录已失效'); });
  on('#u-enable', async () => { await api(`api/admin/users/${id}/enable`, {}); done('已启用'); });
  on('#u-admin', async () => { if (confirm('设为管理员？')) { await api(`api/admin/users/${id}/role`, { role: 'admin' }); done('已设为管理员'); } });
  on('#u-unadmin', async () => { await api(`api/admin/users/${id}/role`, { role: 'user' }); done('已取消管理员'); });
  on('#u-reset', async () => {
    const r = await api(`api/admin/users/${id}/reset-link`, {});
    const link = new URL(`reset.html#${r.token}`, ROOT).href;
    $('#u-link', d.el).innerHTML = `一次性链接（48 小时内有效，请私下发给本人）：<br><code>${esc(link)}</code>`;
  });
}

export const page = { id: 'users', title: '👥 用户', render };
