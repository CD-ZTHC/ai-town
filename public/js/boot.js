// 部署窗口（重构方案 §7.5）：经典脚本，放在模块入口之前。
// 入口模块或它依赖的模块加载失败（服务正在重启、新旧版本混杂）时，提示并按 2 / 5 / 10 秒退避刷新，最多 3 次。
// 模块图加载成功后 version.js 会清掉重试计数。
(function () {
  var KEY = 'town-boot-retry';
  var WAIT = [2000, 5000, 10000];
  var shown = false;
  function tries() { try { return Number(sessionStorage.getItem(KEY) || 0); } catch (e) { return 3; } }
  function note(text) {
    var el = document.getElementById('boot-bar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'boot-bar';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:10000;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:rgba(30,34,52,.94);color:#f3ecff;font:14px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.35)';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (shown || !t || t.tagName !== 'SCRIPT' || t.type !== 'module') return;
    shown = true;
    var n = tries();
    if (n >= WAIT.length) { note('页面没能加载完整，请稍后手动刷新'); return; }
    try { sessionStorage.setItem(KEY, String(n + 1)); } catch (err) { /* 隐私模式 */ }
    note('服务正在更新，' + WAIT[n] / 1000 + ' 秒后自动重试…');
    setTimeout(function () { location.reload(); }, WAIT[n]);
  }, true);
})();
