// 表单类页面共用：请求接口、转义、提示。站点根目录按本模块的位置推算（/js/site/api.js → /），支持部署在子路径下。
export const ROOT = new URL('../../', import.meta.url);

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 隐私模式 */ } },
};

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

/** 请求站点接口：path 形如 'api/me'；body 为 undefined 时发 GET */
export async function api(path, body, method) {
  const headers = {};
  const token = storage.get('town-admin');
  if (token) headers['X-Admin-Token'] = token;
  const m = method || (body === undefined ? 'GET' : 'POST');
  const opts = { method: m, headers, credentials: 'same-origin' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(new URL(path.replace(/^\//, ''), ROOT), opts);
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw new ApiError(data.error || `请求失败（${res.status}）`, res.status, data);
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function toast(html, ms = 3500) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 打开一个弹窗；返回弹窗元素与关闭函数 */
export function dialog(html) {
  const back = document.createElement('div');
  back.className = 'dialog-back';
  back.innerHTML = `<div class="dialog">${html}</div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  return { el: back.firstElementChild, close };
}

export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtBytes = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`);
