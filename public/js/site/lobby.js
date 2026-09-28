// 世界大厅（多世界设计 §12）：世界卡片（简介、原著、在线人数、分级、创世者），官方世界置顶；登录 / 注册入口
import { api, esc, $, toast } from './api.js';
import { loginDialog } from './auth.js';

const RATING = { cozy: '温馨', adventure: '冒险', epic: '史诗', dark: '黑暗', tragic: '悲剧' };
let me = null;

async function nav() {
  try { me = await api('api/me'); } catch { me = null; }
  const u = me?.user;
  const canGenesis = me?.admin || me?.grants?.some((g) => g.cap === 'genesis');
  $('#nav').innerHTML = [
    u && !u.local ? `<a href="mine.html">我的世界</a>` : '',
    canGenesis ? '<a href="genesis.html">✨ 创世</a>' : '',
    me?.admin ? '<a href="admin/">管理</a>' : '',
    u ? `<span class="who">👤 ${esc(u.nickname)}</span>${u.local ? '' : '<button class="small" id="logout">退出</button>'}`
      : me?.accounts ? '<button class="small" id="login">登录</button><button class="small primary" id="register">注册</button>' : '',
  ].join(' ');
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('#login', async () => { if (await loginDialog()) nav(); });
  on('#register', async () => { if (await loginDialog({ register: true })) nav(); });
  on('#logout', async () => { await api('api/auth/logout', {}); toast('已退出登录'); nav(); });
}

async function list() {
  const q = encodeURIComponent($('#q').value.trim());
  const r = await api(`api/worlds?q=${q}&rating=${$('#rating').value}`);
  $('#list').innerHTML = r.list.map((w) => `
    <a class="card world-card" href="w/${encodeURIComponent(w.id)}/">
      <div class="row"><h3 style="margin:0">${esc(w.title)}</h3>${w.official ? '<span class="pill good">官方</span>' : ''}<span class="pill">${RATING[w.rating] || esc(w.rating)}</span></div>
      ${w.sourceTitle ? `<div class="small muted">改编自《${esc(w.sourceTitle)}》</div>` : ''}
      <p class="small" style="color:var(--text)">${esc(w.summary).slice(0, 120)}${w.summary.length > 120 ? '…' : ''}</p>
      <div class="small muted">${w.running ? `🟢 ${w.viewers} 人在看 · 第 ${w.day} 天` : '💤 休眠中，打开即唤醒'}${w.owner ? ` · 创世者 ${esc(w.owner)}` : ''}</div>
    </a>`).join('') || '<div class="empty">没有找到世界</div>';
}

let t = null;
$('#q').oninput = () => { clearTimeout(t); t = setTimeout(list, 300); };
$('#rating').onchange = list;
nav();
list();
