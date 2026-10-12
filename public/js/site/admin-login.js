// 管理面板的登录页：不是管理员时服务端在 /admin/ 返回这个页面（面板本身与它的脚本只给管理员）。
// 登录成功（管理员账号，或用 ADMIN_TOKEN 换到管理员 Cookie）后刷新，同一个地址就会换成面板
import { api, esc, $, toast, storage } from './api.js';
import { loginDialog } from './auth.js';

const box = $('#box');

async function render() {
  const me = await api('api/me').catch(() => null);
  if (me?.admin) {
    // 小镇页面存过令牌（请求头）：换成管理员 Cookie，打开面板时才带得上
    const t = storage.get('town-admin');
    if (t) await api('api/auth/admin-token', { token: t }).catch(() => null);
    let again = false;
    try { again = sessionStorage.getItem('admin-login-reload') === '1'; sessionStorage.setItem('admin-login-reload', again ? '' : '1'); } catch { /* 隐私模式 */ }
    if (!again) return location.reload();
  }
  try { sessionStorage.removeItem('admin-login-reload'); } catch { /* 隐私模式 */ }
  const accounts = Boolean(me?.accounts && me?.publicMode);
  box.innerHTML = `<h2>🔐 管理员登录</h2>
    ${accounts ? `<p>${me.user ? `你以「${esc(me.user.nickname)}」登录，但不是管理员。` : '<button class="primary" id="acct">用管理员账号登录</button>'}</p>
    ${me.user ? '<p class="muted small">还没有超级管理员时，可以在下面输入 ADMIN_TOKEN 把这个账号认领为超级管理员。</p>' : ''}` : ''}
    <p class="muted small">或者输入服务器上设置的管理员令牌（ADMIN_TOKEN，应急入口，每次使用都会写审计）。</p>
    <label>管理员令牌</label><input id="tok" type="password" autocomplete="off" />
    <div class="actions"><a href="../">返回首页</a><span style="flex:1"></span>${accounts && me.user ? '<button id="claim">认领为超级管理员</button>' : ''}<button class="primary" id="ok">进入</button></div>`;
  const tok = () => $('#tok').value.trim();
  const acct = $('#acct');
  if (acct) acct.onclick = async () => { if (await loginDialog({ reason: '用管理员账号登录' })) render(); };
  const claim = $('#claim');
  if (claim) claim.onclick = async () => {
    try { await api('api/auth/claim-admin', { token: tok() }); location.reload(); } catch (e) { toast(esc(e.message)); }
  };
  const submit = async () => {
    try { await api('api/auth/admin-token', { token: tok() }); location.reload(); } catch (e) { toast(esc(e.message)); }
  };
  $('#ok').onclick = submit;
  $('#tok').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('#tok').focus();
}

render();
