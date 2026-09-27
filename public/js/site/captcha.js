// 人机验证（Cloudflare Turnstile，多世界设计 §5.4）：服务器配置了 CAPTCHA_SECRET / CAPTCHA_SITEKEY 时，注册表单里显示验证组件。
// 没有配置时什么也不做。apiRoot：站点接口的相对路径前缀（表单页是 ''，世界页面是 '../../'）
let loading = null;
function loadScript() {
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { loading = null; reject(new Error('人机验证加载失败')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** 在 el 里放一个验证组件；返回 () => token（没启用时返回 () => null） */
export async function mountCaptcha(el, fetchJson) {
  let cfg;
  try { cfg = await fetchJson(); } catch { return () => null; }
  if (!cfg?.enabled || !cfg.siteKey) return () => null;
  let token = null;
  try {
    const t = await loadScript();
    t.render(el, { sitekey: cfg.siteKey, callback: (v) => { token = v; }, 'expired-callback': () => { token = null; } });
  } catch (e) { el.textContent = e.message; }
  return () => token;
}
