// 登录 / 注册（多世界设计 §5.4、§12）：游客点击任何互动入口时弹出，完成后自动继续刚才的操作。注册只要用户名、昵称和密码。
import { $, app, closeModal, esc, openModal, toast } from './core.js';

let waiting = null; // 正在等待登录完成的操作：{ promise, resolve, reject }

/** 需要登录：弹出登录框，登录（或注册）成功后 resolve；关掉弹窗则 reject */
export function requireLogin(reason = '') {
  if (waiting) return waiting.promise;
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  waiting = { promise, resolve, reject };
  showForm('login', reason);
  // 弹窗被关掉就当取消
  const obs = new MutationObserver(() => {
    if ($('#modal').hidden && waiting?.promise === promise) { obs.disconnect(); waiting = null; reject(Object.assign(new Error('已取消登录'), { cancelled: true })); }
  });
  obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
  return promise;
}

function showForm(tab, reason) {
  const reg = tab === 'register';
  const card = openModal(`<h2>${reg ? '✨ 注册' : '👋 登录'}</h2>
    <div class="sub">${esc(reason || '登录之后就可以现身、和居民聊天、化作心声、发布事件和投票了。')}${reg ? '<br>你的昵称会出现在所有世界里，居民们记住的就是你。' : ''}</div>
    <form id="auth-form" class="auth-form">
      <label>用户名<input name="username" autocomplete="username" maxlength="20" placeholder="字母、数字或下划线，3~20 位" required></label>
      ${reg ? '<label>昵称<input name="nickname" maxlength="8" placeholder="1~8 个字，全站唯一" required><span class="hint" id="nick-hint"></span></label>' : ''}
      <label>密码<input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? '至少 10 位' : ''}" required></label>
      <div class="row"><button class="primary" type="submit">${reg ? '注册并登录' : '登录'}</button><span class="quota" id="auth-msg"></span></div>
    </form>
    <div class="sub">${reg ? '已经有账号了？<a href="#" id="auth-switch">登录</a>' : '还没有账号？<a href="#" id="auth-switch">注册一个</a>（只要三项）'}</div>`, 'help auth');
  $('#auth-switch', card).onclick = (e) => { e.preventDefault(); showForm(reg ? 'login' : 'register', reason); };
  const nick = card.querySelector('input[name="nickname"]');
  if (nick) {
    let t = null;
    nick.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const v = nick.value.trim();
        if (!v) { $('#nick-hint', card).textContent = ''; return; }
        try {
          const r = await app.api(`/api/auth/nickname-available?nickname=${encodeURIComponent(v)}`);
          $('#nick-hint', card).innerHTML = r.ok ? '<span style="color:var(--good)">✓ 可以用</span>' : `<span style="color:var(--bad)">${esc(r.reason)}</span>`;
        } catch { /* 忽略 */ }
      }, 350);
    });
  }
  $('#auth-form', card).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await app.api(reg ? '/api/auth/register' : '/api/auth/login', body);
      await app.refreshPerms();
      const w = waiting;
      waiting = null;
      closeModal();
      toast(reg ? `🎉 欢迎你，${esc(r.user.nickname)}！` : `👋 欢迎回来，${esc(r.user.nickname)}`);
      w?.resolve(r.user);
    } catch (err) {
      $('#auth-msg', card).innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(err.message)}</span>`;
    } finally { btn.disabled = false; }
  });
  setTimeout(() => card.querySelector('input')?.focus(), 50);
}

/** 账号菜单：已登录时改昵称、改密码、登出；没登录时就是登录框 */
export function accountModal() {
  const u = app.perms.user;
  if (!u || u.local) {
    if (u?.local) {
      openModal(`<h2>👤 ${esc(u.nickname)}</h2><div class="sub">本地模式：所有访问者都是这个内置的本地管理员账号，不需要注册。昵称可以在管理面板的设置里修改（LOCAL_NICKNAME）。</div>`, 'help');
      return;
    }
    requireLogin().catch(() => {});
    return;
  }
  const card = openModal(`<h2>👤 ${esc(u.nickname)}</h2>
    <div class="sub">用户名 <b>${esc(u.username)}</b>${u.role !== 'user' ? ` · ${u.role === 'super' ? '超级管理员' : '管理员'}` : ''}${app.perms.grants?.some((g) => g.cap === 'genesis') ? ' · ✨ 拥有创世权限' : ''}</div>
    <form id="acc-nick" class="chatin"><input name="nickname" maxlength="8" placeholder="新昵称（每 30 天可以改一次）"><button class="send">改昵称</button></form>
    <form id="acc-pw" class="auth-form">
      <label>原密码<input name="old" type="password" autocomplete="current-password"></label>
      <label>新密码<input name="password" type="password" autocomplete="new-password" placeholder="至少 10 位"></label>
      <div class="row"><button class="ghost" type="submit">改密码</button></div>
    </form>
    <div class="row">
      ${app.perms.admin ? '<a class="ghost btn-link" href="../../admin/">🛠️ 管理面板</a>' : ''}
      <button class="ghost" id="acc-out">退出登录</button><button class="ghost" id="acc-out-all">登出所有设备</button>
    </div>`, 'help auth');
  $('#acc-nick', card).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await app.api('/api/auth/nickname', { nickname: e.target.nickname.value.trim() }); await app.refreshPerms(); toast(`✅ 以后大家会叫你「${esc(r.user.nickname)}」`); closeModal(); } catch (err) { toast(`⚠️ ${esc(err.message)}`); }
  });
  $('#acc-pw', card).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await app.api('/api/auth/password', { old: e.target.old.value, password: e.target.password.value }); toast('✅ 密码已修改，其他设备已登出'); closeModal(); } catch (err) { toast(`⚠️ ${esc(err.message)}`); }
  });
  const out = (all) => async () => { await app.api('/api/auth/logout', { all }).catch(() => {}); await app.refreshPerms(); closeModal(); toast(all ? '已登出所有设备' : '已退出登录'); };
  $('#acc-out', card).onclick = out(false);
  $('#acc-out-all', card).onclick = out(true);
}
