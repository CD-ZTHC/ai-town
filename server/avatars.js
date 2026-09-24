// 访客化身（设计文档 P6）：访客可以用一个名字在小镇里现身、走到公共地点；居民看得见，也会记住名字。
// 化身只存在于内存（不进存档），长时间不操作会自动离开。每个 IP 同时最多一个化身，全镇最多 MAX 个。
import { findPath } from './world.js';

const MAX = Number(process.env.AVATAR_MAX || 8);
const IDLE_MS = 20 * 60_000; // 20 分钟不操作就离开
const MOVE_CD_MS = 3000;
const GOTO_CD_MS = 250; // 游戏模式里点地 / 键盘走路，间隔可以短一些
const SPEED = 4; // 格/真实秒：化身按真实时间行走，不受调速、暂停影响，操作手感一致
const COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f'];
const err = (status, message) => Object.assign(new Error(message), { status });

export class AvatarSystem {
  constructor(town, { now = () => Date.now() } = {}) {
    this.town = town;
    this.now = now;
    this.list = [];
    this.seq = 0;
  }

  mine(vid) { return this.list.find((v) => v.vid === vid) || null; }

  join(vid, ip, { name, color } = {}) {
    const town = this.town;
    name = String(name ?? '').replace(/[\s<>{}[\]"'`\\]/g, '').slice(0, 8);
    if (name.length < 1) throw err(400, '起个名字吧');
    if (town.agents.some((a) => a.name === name) || this.list.some((v) => v.name === name && v.vid !== vid && v.ip !== ip)) throw err(409, '这个名字已经有人用了');
    const old = this.mine(vid) || this.list.find((v) => v.ip === ip);
    if (old) this.remove(old, false);
    if (this.list.length >= MAX) throw err(429, `小镇里的访客已经满了（最多 ${MAX} 位），稍后再来吧`);
    const spots = town.findLocation('square')?.spots || [];
    const s = spots.length ? spots[Math.floor(Math.random() * spots.length)] : town.locCenter('square') || { x: 50, y: 34 };
    const v = {
      id: `v${++this.seq}`, vid, ip, name, color: COLORS.includes(color) ? color : COLORS[this.seq % COLORS.length],
      x: s.x, y: s.y, dir: 'down', moving: false, region: 'town', locId: 'square', path: [], hop: null,
      seen: this.now(), movedAt: 0,
    };
    this.list.push(v);
    town.log('avatar', `👣 旅人「${name}」来到了${town.locName('square')}`, {});
    town.emit('avatars');
    return v;
  }

  move(vid, locId) {
    const town = this.town;
    const v = this.mine(vid);
    if (!v) throw err(404, '你还没有在小镇里现身');
    if (this.now() - (v.movedLocAt || 0) < MOVE_CD_MS) throw err(429, '慢一点，刚刚才动身');
    locId = String(locId || '');
    if (!town.publicLocs().includes(locId)) throw err(400, '只能去开放的公共地点');
    v.movedAt = v.movedLocAt = v.seen = this.now();
    this.walk(v, locId);
    return v;
  }

  /** 游戏模式：走到当前区域里任意一个可以走到的格子 */
  goto(vid, x, y) {
    const town = this.town;
    const v = this.mine(vid);
    if (!v) throw err(404, '你还没有在小镇里现身');
    if (this.now() - v.movedAt < GOTO_CD_MS) throw err(429, '慢一点');
    const w = town.worldOf(v.region);
    x = Math.round(Number(x)); y = Math.round(Number(y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= w.W || y >= w.H || !w.walk[y * w.W + x]) throw err(400, '那里走不过去');
    const path = findPath(w, Math.round(v.x), Math.round(v.y), x, y);
    if (!path) throw err(400, '那里走不过去');
    v.movedAt = v.seen = this.now();
    Object.assign(v, { path, hop: null, target: null, locId: null });
    return v;
  }

  walk(v, locId) {
    const town = this.town;
    const here = town.worldOf(v.region);
    const to = town.locRegion(locId);
    v.locId = null;
    if (to !== v.region) {
      v.hop = { to, locId };
      v.path = findPath(here, Math.round(v.x), Math.round(v.y), here.gate.x, here.gate.y) || [];
      return;
    }
    const loc = town.findLocation(locId);
    const s = loc.spots?.length ? loc.spots[Math.floor(Math.random() * loc.spots.length)] : town.locCenter(locId);
    v.path = findPath(here, Math.round(v.x), Math.round(v.y), s.x, s.y) || [{ x: s.x, y: s.y }];
    v.target = locId;
  }

  leave(vid) {
    const v = this.mine(vid);
    if (!v) return false;
    this.remove(v, true);
    return true;
  }

  remove(v, say) {
    this.list = this.list.filter((x) => x !== v);
    if (say) this.town.log('avatar', `👋 旅人「${v.name}」离开了小镇`, {});
    this.town.emit('avatars');
  }

  touch(vid) { const v = this.mine(vid); if (v) v.seen = this.now(); return v; }

  /** dtReal：真实秒数 */
  tick(dtReal) {
    const now = this.now();
    for (const v of [...this.list]) {
      if (now - v.seen > IDLE_MS) { this.remove(v, true); continue; }
      let dist = SPEED * dtReal;
      v.moving = v.path.length > 0;
      while (dist > 0 && v.path.length) {
        const n = v.path[0];
        const dx = n.x - v.x, dy = n.y - v.y, d = Math.hypot(dx, dy);
        if (Math.abs(dx) > Math.abs(dy)) v.dir = dx > 0 ? 'right' : 'left'; else if (d > 0.001) v.dir = dy > 0 ? 'down' : 'up';
        if (d <= dist) { v.x = n.x; v.y = n.y; v.path.shift(); dist -= d; } else { v.x += (dx / d) * dist; v.y += (dy / d) * dist; dist = 0; }
      }
      if (v.moving && !v.path.length) this.arrived(v);
    }
  }

  arrived(v) {
    const town = this.town;
    v.moving = false;
    if (v.hop) {
      const { to, locId } = v.hop;
      v.hop = null;
      if (!town.regionOpen(to)) return;
      const g = town.worldOf(to).gate;
      Object.assign(v, { region: to, x: g.x, y: g.y });
      this.walk(v, locId);
      return;
    }
    v.locId = v.target || null;
    // 认识的居民会打招呼（不调用模型）
    for (const a of town.agents) {
      if (a.kind === 'creature' || a.status !== 'acting' || a.convoId || a.bubble || !this.near(a, 4).includes(v)) continue;
      const known = (a.visitorChats?.[v.vid] || []).length > 0;
      if (!known && Math.random() > 0.3) continue;
      town.say(a, known ? `又见面了，${v.name}！` : `你好呀，${v.name}，第一次来吗？`, 4000, 'say');
      break;
    }
  }

  /** 居民身边的访客化身（同一区域、户外、6 格内） */
  near(a, r = 6) {
    if (a.inside) return [];
    return this.list.filter((v) => v.region === (a.region || 'town') && Math.hypot(v.x - a.x, v.y - a.y) < r);
  }

  view() {
    return this.list.map((v) => ({ id: v.id, name: v.name, color: v.color, x: +v.x.toFixed(2), y: +v.y.toFixed(2), dir: v.dir, moving: v.moving, region: v.region,
      // 接下来要走的几格与终点：前端据此预览路线、平滑插值
      ...(v.path.length ? { next: v.path.slice(0, 3), to: v.path[v.path.length - 1] } : {}) }));
  }
}
