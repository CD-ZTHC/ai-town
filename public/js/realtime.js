// 实时通道（docs/design/realtime.md §3、§6、§7）：游戏模式里经 Cloudflare 的一条 WebSocket。
// 上行：位置上报、出招、心跳（测往返延迟）、看哪张地图、网络统计；下行：位置纠正、出招失败、战斗通道（每秒 15 帧）。
// 连不上或断开时自动退回 HTTP（功能不变，只是慢一些）；`?debug=net` 显示往返延迟、推送间隔与当前的传输方式。
import * as Local from './localmove.js';

const PING_MS = 5000;
const NET_MS = 60_000;
const RENDER_DELAY = 100; // 战斗通道里的单位延后这么多毫秒播放（缓冲两帧，网络抖动时不跳）
const MAX_FAILS = 5;

let app;
const st = { want: false, ws: null, open: false, fails: 0, retry: null, ping: null, net: null, rtts: [], gaps: [], lastSnap: 0, frames: 0, fps: 0, fpsAt: 0, offset: null, buf: new Map(), shots: new Map(), onErr: null };
const now = () => performance.now();
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };

export function init(a, { onError } = {}) {
  app = a;
  st.onErr = onError || null;
  if (new URLSearchParams(location.search).get('debug') === 'net') debugPanel();
}

/** 进入游戏模式：连上（REALTIME 关着时什么也不做） */
export function start() {
  st.want = Boolean(app.perms?.realtime && app.perms.realtime !== 'off');
  if (st.want && !st.ws) connect();
}
/** 离开游戏模式：断开 */
export function stop() {
  st.want = false;
  clearTimeout(st.retry);
  st.ws?.close();
}
export const connected = () => st.open;

async function connect() {
  if (!st.want || st.ws) return;
  let ticket;
  try { ticket = (await app.api('/api/realtime/ticket', {})).ticket; } catch { return retry(); }
  const url = new URL(`api/realtime?ticket=${encodeURIComponent(ticket)}`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = (st.ws = new WebSocket(url));
  ws.onopen = () => {
    st.open = true; st.fails = 0;
    Local.setSender((b) => send({ t: 'mv', ...b }));
    send({ t: 'view', region: app.view });
    ping();
    st.ping = setInterval(ping, PING_MS);
    st.net = setInterval(report, NET_MS);
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* 坏消息忽略 */ } };
  ws.onclose = () => {
    const was = st.open;
    st.open = false; st.ws = null;
    clearInterval(st.ping); clearInterval(st.net);
    Local.setSender(null);
    if (!was) st.fails++;
    retry();
  };
}

function retry() {
  if (!st.want || st.fails >= MAX_FAILS) return; // 连不上太多次：留在 HTTP
  clearTimeout(st.retry);
  st.retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** st.fails));
}

function send(m) { if (st.open) st.ws.send(JSON.stringify(m)); }

/** 出招走实时通道；没连上时返回 false（调用方走 HTTP） */
export function act(body) { if (!st.open) return false; send({ t: 'act', ...body }); return true; }
/** 换了看的地图：告诉服务器，战斗通道只推这张地图 */
export function view(region) { send({ t: 'view', region }); st.buf.clear(); }

function ping() { send({ t: 'ping', ts: now(), ...(st.rtts.length ? { rtt: pct(st.rtts, 0.5) } : {}) }); }
function report() { send({ t: 'net', rtt50: pct(st.rtts, 0.5), rtt95: pct(st.rtts, 0.95), gap95: pct(st.gaps, 0.95) }); }

function onMessage(m) {
  switch (m.t) {
    case 'pong': st.rtts.push(now() - m.ts); if (st.rtts.length > 30) st.rtts.shift(); break;
    case 'ack': Local.onResult(m); break;
    case 'err': st.onErr?.(m.reason, m.skill); break;
    case 'cf': channel(m); break;
  }
}

/** 世界快照到了：记下到达间隔（判断推送有没有被攒包） */
export function onSnapshot() {
  const t = now();
  if (st.lastSnap) { st.gaps.push(t - st.lastSnap); if (st.gaps.length > 60) st.gaps.shift(); }
  st.lastSnap = t;
}

/** 战斗通道的一帧：按服务器时间放进各单位的缓冲（本地时间 = 服务器时间 + 最小的观测偏移） */
function channel(m) {
  const recv = Date.now();
  const off = recv - m.ts;
  st.offset = st.offset == null ? off : Math.min(st.offset + 2, off); // 慢慢放宽，跟上时钟漂移
  const t = m.ts + st.offset;
  for (const [k, x, y, hp] of m.u) {
    const a = st.buf.get(k) || [];
    a.push({ t, x, y, hp });
    while (a.length > 2 && t - a[0].t > 1000) a.shift();
    st.buf.set(k, a);
  }
  st.frames++;
  if (now() - st.fpsAt > 1000) { st.fps = st.frames; st.frames = 0; st.fpsAt = now(); }
}

/** 战斗通道里某个单位此刻该画的位置（延后 100 毫秒插值）；没有新数据时返回 null（用快照） */
export function posOf(key) {
  const a = st.buf.get(key);
  if (!a?.length) return null;
  const t = Date.now() - RENDER_DELAY;
  if (t - a[a.length - 1].t > 500) return null; // 太久没更新：这个单位已经不在战斗里了
  if (t <= a[0].t) return { x: a[0].x, y: a[0].y };
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i].t <= t) {
      const n = a[i + 1];
      if (!n) return { x: a[i].x, y: a[i].y };
      const k = (t - a[i].t) / Math.max(1, n.t - a[i].t);
      return { x: a[i].x + (n.x - a[i].x) * k, y: a[i].y + (n.y - a[i].y) * k };
    }
  }
  return null;
}

/** 调试面板（?debug=net） */
function debugPanel() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:8px;bottom:70px;z-index:60;font:12px/1.5 ui-monospace,monospace;color:#cfe;background:rgba(0,0,0,.65);padding:6px 10px;border-radius:8px;pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  setInterval(() => {
    el.textContent = `通道 ${st.open ? 'WebSocket' : st.want ? `HTTP（重连 ${st.fails}/${MAX_FAILS}）` : '未开启'}\n往返 p50 ${pct(st.rtts, 0.5) ?? '-'}ms  p95 ${pct(st.rtts, 0.95) ?? '-'}ms\n快照间隔 p50 ${pct(st.gaps, 0.5) ?? '-'}ms  p95 ${pct(st.gaps, 0.95) ?? '-'}ms\n战斗通道 ${st.fps} 帧/秒  本地移动 ${Local.active() ? '开' : '关'}`;
  }, 500);
}
