// 发现新版本（重构方案 §7.4）：页面从 <meta name="build"> 知道自己的构建号，
// 从 SSE 的 init、接口响应头 X-Build、定时请求 api/build 得知服务端当前的构建号。不一致时：
//   先显示不遮挡操作的提示条（可以立即刷新）；
//   页面在后台，或者持续 60 秒没有打开的弹窗、没有正在输入的内容 → 随机延迟 0~30 秒后自动刷新；
//   有未提交的内容时只提示，不自动刷新；
//   防循环：同一个新版本最多自动刷新两次（第二次带 _r 参数绕过中间层缓存），仍然不一致就只保留提示。
const meta = document.querySelector('meta[name="build"]');
const ROOT = new URL(meta?.dataset.root || '../', meta?.dataset.root ? location.href : import.meta.url);
const KEY = 'town-build-reload';
const IDLE_MS = 60_000;
const POLL_MS = 120_000;

const ss = {
  get() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(KEY, JSON.stringify(v)) : sessionStorage.removeItem(KEY); } catch { /* 隐私模式 */ } },
};
// 模块图加载成功：清掉 boot.js 的重试计数；去掉防缓存刷新时加的 _r 参数
try { sessionStorage.removeItem('town-boot-retry'); } catch { /* 隐私模式 */ }
if (new URLSearchParams(location.search).has('_r')) {
  const u = new URL(location.href);
  u.searchParams.delete('_r');
  history.replaceState(history.state, '', u);
}

/** 页面自己的构建号（服务端关闭资源版本时没有 meta：以第一次看到的为准） */
let mine = meta?.content || null;
let latest = null;
let bar = null;
let idleSince = 0;
let timer = null;
const busyChecks = [];

/** 页面可以登记额外的「有未提交内容」判断（例如创世草稿、设置表单） */
export function busyWhen(fn) { busyChecks.push(fn); }

function busy() {
  const el = document.activeElement;
  if (el && el !== document.body && (el.matches?.('input, textarea, select') || el.isContentEditable)) return true;
  if (document.querySelector('#modal:not([hidden]), .dialog-back, dialog[open]')) return true;
  // 看得见的输入框里有改过、没提交的内容
  for (const x of document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search]')) {
    if (x.value && x.value !== x.defaultValue && x.offsetParent !== null) return true;
  }
  return busyChecks.some((f) => { try { return f(); } catch { return false; } });
}

function reload() {
  const st = ss.get();
  const n = st?.build === latest ? st.n : 0;
  if (n >= 2) return; // 已经为这个版本刷新过两次：只保留提示
  ss.set({ build: latest, n: n + 1 });
  if (n === 0) { location.reload(); return; }
  // 第二次：刷新后还是旧页面，多半是 HTML 被中间层缓存了，带一个参数绕过
  const u = new URL(location.href);
  u.searchParams.set('_r', latest);
  location.replace(u);
}

function showBar() {
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'version-bar';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;display:flex;gap:10px;align-items:center;max-width:calc(100vw - 32px);padding:8px 10px 8px 14px;border-radius:12px;background:rgba(30,34,52,.94);color:#f3ecff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)';
  bar.innerHTML = '<span>✨ 小镇已更新，刷新后使用新版本</span><button type="button" style="font:inherit;cursor:pointer;border:0;border-radius:8px;padding:4px 10px;background:#ffb86b;color:#2a1a00">立即刷新</button><button type="button" aria-label="关闭" style="font:inherit;cursor:pointer;border:0;background:none;color:inherit;opacity:.7">✕</button>';
  const [go, close] = bar.querySelectorAll('button');
  go.onclick = () => { ss.set(null); reload(); };
  close.onclick = () => { bar.style.display = 'none'; };
  document.body.appendChild(bar);
}

function schedule() {
  if (timer) return;
  const st = ss.get();
  if (st?.build === latest && st.n >= 2) return; // 自动刷新已经试过了，只提示
  idleSince = busy() ? 0 : Date.now();
  timer = setInterval(() => {
    if (busy()) { idleSince = 0; return; }
    if (!idleSince) idleSince = Date.now();
    if (document.visibilityState === 'hidden' || Date.now() - idleSince >= IDLE_MS) {
      clearInterval(timer);
      // 错开：部署后所有观众不要在同一秒重新加载
      setTimeout(() => { if (!busy()) reload(); else { timer = null; schedule(); } }, Math.random() * 30_000);
    }
  }, 2000);
}

/** 服务端告诉我们的构建号（SSE init、X-Build 响应头、api/build） */
export function seen(build) {
  if (!build) return;
  if (!mine) { mine = build; return; }
  if (build === mine) {
    // 已经是最新：清掉防循环的记录
    if (ss.get()) ss.set(null);
    return;
  }
  if (latest === build) return;
  latest = build;
  showBar();
  schedule();
}

/** 从响应里取 X-Build */
export function fromResponse(res) {
  try { seen(res.headers.get('X-Build')); } catch { /* 没有这个头 */ }
  return res;
}

async function poll() {
  try { fromResponse(await fetch(new URL('api/build', ROOT), { cache: 'no-store', credentials: 'same-origin' })); } catch { /* 服务正在重启 */ }
}

setInterval(poll, POLL_MS);
// 往返缓存（手机切回、浏览器后退）恢复的页面不会重新请求任何东西：主动比对一次
addEventListener('pageshow', (e) => { if (e.persisted) poll(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !latest) poll(); });
