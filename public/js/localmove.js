// 低延迟移动（docs/design/realtime.md §4）：游戏模式里自己的化身在本地先走，约每 100 毫秒把位置上报给服务器校验。
// 服务器认可就沿用；不认可（太快、穿墙、版本过期）时给出它认可的位置，这里对齐（回弹）；异常太多时服务器让我们退回「等服务器」的旧模式。
// 被打倒、击退、闪避、换地图这类服务器改的位置会让版本号 pv 加一，看到它变了就以服务器为准。
const SPEED = 4; // 格/秒，与服务器 avatars.ts 一致
const SEND_MS = 100;

let app;
let send = null; // 上报通道：实时通道连上时由它提供，否则用 HTTP
const st = { on: false, x: 0, y: 0, dir: 'down', moving: false, region: 'town', pv: 0, path: [], input: null, lastSent: null, sentAt: 0, inflight: false, follow: false, id: null };

export function init(a) { app = a; }
/** 实时通道（R3）连上后改用它上报；断开时传 null 退回 HTTP */
export function setSender(fn) { send = fn; }

/** 这一帧是否由本地决定自己的位置 */
export const active = () => st.on;
export const pos = () => (st.on ? { x: st.x, y: st.y, dir: st.dir, moving: st.moving, region: st.region } : null);

/** 当前地图里 (x, y) 这一格能不能走 */
function walkable(region, x, y) {
  const w = app.regionWorlds?.[region];
  const cx = Math.round(x), cy = Math.round(y);
  return Boolean(w && cx >= 0 && cy >= 0 && cx < w.W && cy < w.H && w.walk?.[cy * w.W + cx]);
}

/** 每帧：和服务器快照里自己的化身对齐状态；返回是否在本地驱动 */
export function sync(v) {
  const mode = app.perms?.realtime;
  if (!v || !mode || mode === 'off' || v.serverMove) { st.on = false; return false; }
  // 第一次、换了化身、服务器改过位置（pv 变了）、换了地图：以服务器为准
  if (!st.on || st.id !== v.id || (v.pv || 0) !== st.pv || (v.region || 'town') !== st.region) {
    Object.assign(st, { on: true, id: v.id, x: v.x, y: v.y, dir: v.dir, region: v.region || 'town', pv: v.pv || 0, path: [], lastSent: { x: v.x, y: v.y } });
  }
  // 「快速前往」由服务器寻路：没有本地输入时跟着服务器的位置走
  st.follow = Boolean(v.to) && !st.input && !st.path.length;
  if (st.follow) { st.x = v.x; st.y = v.y; st.dir = v.dir; st.moving = v.moving; st.lastSent = { x: v.x, y: v.y }; }
  return true;
}

/** 本帧的方向输入（单位向量或 null） */
export function input(vec) { st.input = vec && Math.hypot(vec[0], vec[1]) > 0.01 ? vec : null; if (st.input) st.path = []; }

/** 点地面 / 走到某人身边：本地寻路后沿路径走 */
export function goTo(tx, ty) {
  const p = findPath(st.region, Math.round(st.x), Math.round(st.y), tx, ty);
  if (!p) return false;
  st.path = p;
  return true;
}

/** 每帧推进（dt：秒） */
export function step(dt) {
  if (!st.on || st.follow) return;
  let dx = 0, dy = 0;
  if (st.input) { dx = st.input[0]; dy = st.input[1]; }
  else if (st.path.length) {
    const n = st.path[0];
    const ex = n.x - st.x, ey = n.y - st.y, d = Math.hypot(ex, ey);
    if (d < 0.08) { st.x = n.x; st.y = n.y; st.path.shift(); return step(0); }
    dx = ex / d; dy = ey / d;
  }
  const len = Math.hypot(dx, dy);
  st.moving = len > 0.01;
  if (!st.moving || dt <= 0) return;
  const k = Math.min(1, len);
  let mx = (dx / len) * SPEED * k * dt, my = (dy / len) * SPEED * k * dt;
  // 点地走路：不要越过下一个路点
  if (!st.input && st.path.length) { const n = st.path[0]; const d = Math.hypot(n.x - st.x, n.y - st.y); const s = Math.hypot(mx, my); if (s > d) { mx *= d / s; my *= d / s; } }
  // 撞墙时沿墙滑：先试整步，再分别试横、竖
  if (walkable(st.region, st.x + mx, st.y + my)) { st.x += mx; st.y += my; }
  else if (walkable(st.region, st.x + mx, st.y)) st.x += mx;
  else if (walkable(st.region, st.x, st.y + my)) st.y += my;
  else st.moving = false;
  if (Math.abs(mx) > Math.abs(my)) st.dir = mx > 0 ? 'right' : 'left'; else if (Math.abs(my) > 0.0001) st.dir = my > 0 ? 'down' : 'up';
}

/** 定期上报（主循环每帧调用，内部按 SEND_MS 节流） */
export function flush() {
  if (!st.on || st.follow || st.inflight) return;
  const t = performance.now();
  if (t - st.sentAt < SEND_MS) return;
  const last = st.lastSent;
  if (last && Math.hypot(st.x - last.x, st.y - last.y) < 0.02) return;
  st.sentAt = t;
  st.lastSent = { x: st.x, y: st.y };
  const body = { x: +st.x.toFixed(3), y: +st.y.toFixed(3), dir: st.dir, pv: st.pv };
  if (send) { send(body); return; }
  st.inflight = true;
  app.api('/api/avatar/pos', body).then(onResult).catch(() => {}).finally(() => { st.inflight = false; });
}

/** 服务器对上报的回应：不认可时对齐它给的位置（回弹） */
export function onResult(r) {
  if (!r || r.ok) return;
  Object.assign(st, { x: r.x, y: r.y, region: r.region, pv: r.pv, path: [], lastSent: { x: r.x, y: r.y } });
  if (r.fallback) st.on = false;
}

/** 本地寻路（广度优先，4 方向；地图最大 96×64，开销很小） */
export function findPath(region, sx, sy, tx, ty) {
  const w = app.regionWorlds?.[region];
  if (!w || !walkable(region, tx, ty)) return null;
  const W = w.W, start = sy * W + sx, goal = ty * W + tx;
  const prev = new Int32Array(W * w.H).fill(-1);
  prev[start] = start;
  const q = [start];
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === goal) break;
    const x = c % W, y = (c / W) | 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= w.H) continue;
      const n = ny * W + nx;
      if (prev[n] >= 0 || !w.walk[n]) continue;
      prev[n] = c;
      q.push(n);
    }
  }
  if (prev[goal] < 0) return null;
  const out = [];
  for (let c = goal; c !== start; c = prev[c]) out.push({ x: c % W, y: (c / W) | 0 });
  return out.reverse();
}
