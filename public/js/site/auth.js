// 表单类页面的登录 / 注册弹窗（与小镇主页面的登录框同一套接口）
import { api, esc, $, dialog, toast } from './api.js';
import { mountCaptcha } from './captcha.js';

/** 弹出登录框；成功后 resolve 用户，关掉则 resolve null */
export function loginDialog({ reason = '', register = false } = {}) {
  return new Promise((resolve) => {
    const d = dialog(`<h2>${register ? '✨ 注册' : '👋 登录'}</h2>
      ${reason ? `<p class="muted small">${esc(reason)}</p>` : ''}
      <form id="lf">
        <label>用户名</label><input name="username" autocomplete="username" maxlength="20" required>
        ${register ? '<label>昵称（1~8 个字，全站唯一）</label><input name="nickname" maxlength="8" required>' : ''}
        <label>密码${register ? '（至少 10 位）' : ''}</label><input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required>
        ${register ? '<div id="lf-captcha" style="margin-top:10px"></div>' : ''}
        <div class="bad small" id="lf-msg" style="margin-top:8px"></div>
        <div class="actions"><a href="#" id="lf-switch">${register ? '已有账号？登录' : '没有账号？注册'}</a><span style="flex:1"></span><button type="button" id="lf-cancel">取消</button><button class="primary">${register ? '注册' : '登录'}</button></div>
      </form>`);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; d.close(); resolve(v); } };
    $('#lf-cancel', d.el).onclick = () => finish(null);
    $('#lf-switch', d.el).onclick = (e) => { e.preventDefault(); settled = true; d.close(); loginDialog({ reason, register: !register }).then(resolve); };
    const captcha = register ? mountCaptcha($('#lf-captcha', d.el), () => api('api/auth/captcha')) : Promise.resolve(() => null);
    $('#lf', d.el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const body = Object.fromEntries(new FormData(e.target).entries());
        const token = (await captcha)();
        if (token) body.captcha = token;
        const r = await api(register ? 'api/auth/register' : 'api/auth/login', body);
        toast(`👋 ${esc(r.user.nickname)}`);
        finish(r.user);
      } catch (err) { $('#lf-msg', d.el).textContent = err.message; }
    };
    d.el.querySelector('input').focus();
  });
}
