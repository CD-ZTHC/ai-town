// 用管理员生成的一次性链接重置密码：令牌在地址的 # 后面（不会发给服务器日志和 Referer）
import { api, esc, $ } from './api.js';

$('#rf').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('api/auth/reset', { token: location.hash.slice(1), password: e.target.password.value });
    $('#msg').innerHTML = `<span class="good">✅ 已设置，欢迎回来，${esc(r.user.nickname)}</span> <a href="./">回首页</a>`;
    history.replaceState(null, '', location.pathname);
  } catch (err) { $('#msg').innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
};
