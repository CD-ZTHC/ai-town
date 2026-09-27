// 管理面板（多世界设计 §14.9）：按页组织，地址栏 #设置 这样的锚点记住当前页
import { api, esc, $, storage, dialog, toast } from '../site/api.js';
import { loginDialog } from '../site/auth.js';
import { page as settingsPage } from './settings.js';
import { page as usersPage } from './users.js';
import { page as auditPage } from './audit.js';
import { page as worldsPage } from './worlds.js';

// 各页：{ id, title, render(el, ctx) }，每页一个模块
export const PAGES = [settingsPage, usersPage, worldsPage, auditPage];

const ctx = { me: null, refreshAlerts };

async function boot() {
  try {
    ctx.me = await api('api/me');
  } catch { ctx.me = null; }
  if (!ctx.me?.admin) return askToken();
  $('#who').innerHTML = ctx.me.user ? `${esc(ctx.me.user.nickname)}（${esc(ctx.me.user.role === 'super' ? '超级管理员' : '管理员')}）` : '管理员';
  renderTabs();
  refreshAlerts();
  go(decodeURIComponent(location.hash.slice(1)) || PAGES[0].id);
}

function askToken() {
  const d = dialog(`<h2>🔐 管理员登录</h2>
    ${ctx.me?.accounts && ctx.me?.publicMode ? `<p>${ctx.me.user ? `你以「${esc(ctx.me.user.nickname)}」登录，但不是管理员。` : '<button class="primary" id="acct">用管理员账号登录</button>'}</p>
    ${ctx.me.user ? '<p class="muted small">还没有超级管理员时，可以在下面输入 ADMIN_TOKEN 把这个账号认领为超级管理员。</p><button id="claim">认领为超级管理员</button>' : ''}` : ''}
    <p class="muted small">或者输入服务器上设置的管理员令牌（ADMIN_TOKEN，应急入口，每次使用都会写审计）。</p>
    <label>管理员令牌</label><input id="tok" type="password" autocomplete="off" />
    <div class="actions"><a href="../">返回首页</a><span style="flex:1"></span><button class="primary" id="ok">进入</button></div>`);
  const acct = $('#acct', d.el);
  if (acct) acct.onclick = async () => { d.close(); if (await loginDialog({ reason: '用管理员账号登录' })) boot(); else askToken(); };
  const claim = $('#claim', d.el);
  if (claim) {
    claim.onclick = async () => {
      try { await api('api/auth/claim-admin', { token: $('#tok', d.el).value.trim() }); d.close(); toast('✅ 已认领为超级管理员'); boot(); } catch (e) { toast(esc(e.message)); }
    };
  }
  const submit = async () => {
    storage.set('town-admin', $('#tok', d.el).value.trim());
    const me = await api('api/me').catch(() => null);
    if (!me?.admin) { toast('令牌不对'); return; }
    d.close();
    boot();
  };
  $('#ok', d.el).onclick = submit;
  $('#tok', d.el).onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#tok', d.el).focus();
}

function renderTabs() {
  $('#tabs').innerHTML = PAGES.map((p) => `<button data-p="${p.id}">${esc(p.title)}</button>`).join('');
  $('#tabs').onclick = (e) => { const b = e.target.closest('button[data-p]'); if (b) go(b.dataset.p); };
}

let current = null;
async function go(id) {
  const page = PAGES.find((p) => p.id === id || p.title === id) || PAGES[0];
  current = page;
  history.replaceState(null, '', `#${page.id}`);
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.p === page.id);
  const el = $('#page');
  el.innerHTML = '<div class="empty">加载中…</div>';
  try { await page.render(el, ctx); } catch (e) {
    if (current === page) el.innerHTML = `<div class="banner bad">⚠️ ${esc(e.message)}</div>`;
  }
}
ctx.go = go;
ctx.reload = () => current && go(current.id);

/** 顶部告警：启动失败回退、待重启的设置 */
async function refreshAlerts() {
  let s;
  try { s = await api('api/admin/settings'); } catch { return; }
  const out = [];
  if (s.rollback) out.push(`<div class="banner bad">⚠️ 设置版本 ${s.rollback.from} 启动失败，已在 ${esc(new Date(s.rollback.at).toLocaleString())} 自动回退到版本 ${s.rollback.to}：${esc(s.rollback.reason)}</div>`);
  if (s.pending.length) {
    out.push(`<div class="banner">有 ${s.pending.length} 项设置需要重启才能生效（${s.pending.map((k) => `<code>${esc(k)}</code>`).join(' ')}）
      <button class="small primary" id="restart-now">立即重启</button>${s.supervised ? '' : ' <span class="muted small">（服务没有运行在守护进程下，退出后需要由 systemd / Docker 拉起）</span>'}</div>`);
  }
  $('#alerts').innerHTML = out.join('');
  const b = $('#restart-now');
  if (b) b.onclick = () => restartServer();
}

export async function restartServer() {
  if (!confirm('所有世界会先存盘，在线的页面几秒后自动重连。确定重启吗？')) return;
  await api('api/admin/restart', {});
  $('#alerts').innerHTML = '<div class="banner">⏳ 服务器正在重启……</div>';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { await api('api/me'); location.reload(); return; } catch { /* 还没起来 */ }
  }
  $('#alerts').innerHTML = '<div class="banner bad">服务器 60 秒内没有恢复，请检查服务器日志</div>';
}

boot();
