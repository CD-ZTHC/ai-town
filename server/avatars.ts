// 访客化身（设计文档 P6、多世界设计 §5.6）：登录的用户以账号昵称在世界里现身、走到公共地点；居民看得见，也会记住这个人。
// 化身只存在于内存（不进存档），长时间不操作会自动离开。同一账号在同一个世界里只有一个化身（多个标签页看到的是同一个），
// 每个世界最多 AVATAR_MAX 个。
import { findPath } from './world.ts';
import { get as setting } from './settings/index.ts';
import type { Town } from './sim.ts';
import type { LiveAgent } from './types/agent.ts';

/** 一位访客的化身（只在内存里） */
export interface Avatar {
  id: string;
  /** 账号 id */
  uid: string;
  ip: string;
  name: string;
  color: string;
  x: number;
  y: number;
  dir: 'up' | 'down' | 'left' | 'right';
  moving: boolean;
  region: string;
  locId: string | null;
  path: Array<{ x: number; y: number }>;
  /** 跨区域时下一段 */
  hop: { to: string; locId: string; arrive?: { x: number; y: number } | null } | null;
  /** 正在前往的地点 */
  target?: string | null;
  seen: number;
  movedAt: number;
  movedLocAt?: number;
  /** 像素形象（前端用和居民一样的精灵生成器画）：衣服颜色就是 color */
  look: AvatarLook;
  /** 即时战斗（sim/combat）：血量（满血 100）；被打倒后到这个时刻（真实毫秒）之前不能行动 */
  hp?: number;
  downUntil?: number;
}

const IDLE_MS = 20 * 60_000; // 20 分钟不操作就离开
const MOVE_CD_MS = 3000;
const GOTO_CD_MS = 250; // 游戏模式里点地 / 键盘走路，间隔可以短一些
const SPEED = 4; // 格/真实秒：化身按真实时间行走，不受调速、暂停影响，操作手感一致
const DOWN_MS = 3000; // 被打倒后缓多久
const REGEN = 8; // 不在战斗里时每真实秒回多少血
/** 旅人可选的发型、发色、肤色（白名单，前端角色卡与之一致） */
export const HAIR_STYLES = ['short', 'long', 'bun', 'spiky', 'messy', 'braid'];
export const HAIR_COLORS = ['#2b1d14', '#5a3a22', '#8a5a2b', '#d9b26a', '#c8c8c8', '#7a2e2e'];
export const SKINS = ['#f7d5bd', '#eec39a', '#d9a88a', '#b98c66', '#8d5f43'];
export interface AvatarLook { skin: string; hair: string; hairStyle: string; shirt: string; pants: string; acc: string[] }
const PANTS: Record<string, string> = { '#e57373': '#5a4a6a', '#64b5f6': '#3e4a5e', '#81c784': '#4a5a3a', '#ffb74d': '#5a4632', '#ba68c8': '#4a3a5a', '#4db6ac': '#3a4f4c', '#f06292': '#5a3a4a', '#a1887f': '#4a3e38' };
/** 角色卡给的形象：不在白名单里的值用默认值（旧客户端只传颜色时也一样） */
export function avatarLook(color: string, raw: Partial<AvatarLook> | null | undefined): AvatarLook {
  const pick = (list: string[], v: unknown, d: string) => (list.includes(v as string) ? (v as string) : d);
  return { skin: pick(SKINS, raw?.skin, SKINS[0]!), hair: pick(HAIR_COLORS, raw?.hair, HAIR_COLORS[1]!), hairStyle: pick(HAIR_STYLES, raw?.hairStyle, 'short'), shirt: color, pants: PANTS[color] || '#4a4a5a', acc: [] };
}
const COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f'];
const err = (status: number, message: string): Error & { status: number } => Object.assign(new Error(message), { status });

export class AvatarSystem {
  declare town: Town;
  declare now: () => number;
  declare list: Avatar[];
  declare seq: number;
  constructor(town: Town, { now = () => town.now() } = {}) {
    this.town = town;
    this.now = now;
    this.list = [];
    this.seq = 0;
  }

  mine(uid: string): Avatar | null { return this.list.find((v) => v.uid === uid) || null; }

  /** uid：账号 id；name：账号昵称（由服务端给出）。已经现身的账号再次现身时沿用同一个化身 */
  join(uid: string, ip: string, { name, color, look }: { name?: string; color?: string; look?: Partial<AvatarLook> | null } = {}): Avatar {
    const town = this.town;
    name = String(name ?? '').replace(/[\s<>{}[\]"'`\\]/g, '').slice(0, 8);
    if (name.length < 1) throw err(400, '起个名字吧');
    if (this.list.some((v) => v.name === name && v.uid !== uid)) throw err(409, '这个名字已经有人用了');
    const old = this.mine(uid);
    if (old) {
      Object.assign(old, { name, ip, seen: this.now(), ...(COLORS.includes(color!) ? { color } : {}) });
      old.look = avatarLook(old.color, look || old.look);
      town.emit('avatars');
      return old;
    }
    if (this.list.length >= setting('AVATAR_MAX')) throw err(429, `这里的访客已经满了（最多 ${setting('AVATAR_MAX')} 位），稍后再来吧`);
    const { spawn, s } = this.spawnPoint();
    const c = COLORS.includes(color!) ? color! : COLORS[(this.seq + 1) % COLORS.length]!;
    const v: Avatar = {
      id: `v${++this.seq}`, uid, ip, name, color: c, look: avatarLook(c, look),
      x: s.x, y: s.y, dir: 'down', moving: false, region: 'town', locId: spawn, path: [], hop: null,
      seen: this.now(), movedAt: 0,
    };
    this.list.push(v);
    town.log('avatar', `👣 旅人「${name}」来到了${town.locName(spawn)}`, {});
    town.emit('avatars');
    return v;
  }

  /** 旅人出现的地方：世界包的 voice.spawn，其次是广场，再其次是主地图上第一个有站位的公共地点 */
  spawnPoint(): { spawn: string; s: { x: number; y: number } } {
    const town = this.town;
    const spawn = [town.spec.voice?.spawn, 'square', ...town.publicLocs()].find((id) => id && town.locRegion(id) === 'town' && town.findLocation(id)?.spots?.length) || 'square';
    const spots = town.findLocation(spawn)?.spots || [];
    const s = spots.length ? spots[Math.floor(this.town.rng() * spots.length)]! : town.locCenter(spawn) || town.world.gate;
    return { spawn, s };
  }

  /** 战斗中被打倒：回到出生点，缓几秒，血量回满 */
  knockout(v: Avatar) {
    const { spawn, s } = this.spawnPoint();
    Object.assign(v, { region: 'town', x: s.x, y: s.y, path: [], hop: null, target: null, locId: spawn, moving: false, hp: 100, downUntil: this.now() + DOWN_MS });
    this.town.emit('avatars');
  }

  move(uid: string, locId: string) {
    const town = this.town;
    const v = this.mine(uid);
    if (!v) throw err(404, '你还没有在小镇里现身');
    if (this.now() - (v.movedLocAt || 0) < MOVE_CD_MS) throw err(429, '慢一点，刚刚才动身');
    locId = String(locId || '');
    if (!town.publicLocs().includes(locId)) throw err(400, '只能去开放的公共地点');
    v.movedAt = v.movedLocAt = v.seen = this.now();
    this.walk(v, locId);
    return v;
  }

  /** 游戏模式：走到当前区域里任意一个可以走到的格子 */
  goto(uid: string, x: number, y: number) {
    const town = this.town;
    const v = this.mine(uid);
    if (!v) throw err(404, '你还没有在小镇里现身');
    if (this.now() - v.movedAt < GOTO_CD_MS) throw err(429, '慢一点');
    if ((v.downUntil || 0) > this.now()) throw err(409, '你倒下了，缓一缓');
    const w = town.worldOf(v.region);
    x = Math.round(Number(x)); y = Math.round(Number(y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= w.W || y >= w.H || !w.walk[y * w.W + x]) throw err(400, '那里走不过去');
    const path = findPath(w, Math.round(v.x), Math.round(v.y), x, y);
    if (!path) throw err(400, '那里走不过去');
    v.movedAt = v.seen = this.now();
    Object.assign(v, { path, hop: null, target: null, locId: null });
    return v;
  }

  walk(v: Avatar, locId: string) {
    const town = this.town;
    const here = town.worldOf(v.region);
    const to = town.locRegion(locId);
    v.locId = null;
    if (to !== v.region) {
      const step = town.routeStep(v.region || 'town', to, v);
      if (!step) return;
      v.hop = { to: step.to, locId, arrive: step.b };
      v.path = findPath(here, Math.round(v.x), Math.round(v.y), step.a.x, step.a.y) || [];
      return;
    }
    const loc = town.findLocation(locId)!;
    const s = (loc.spots?.length ? loc.spots[Math.floor(this.town.rng() * loc.spots.length)] : town.locCenter(locId))!;
    v.path = findPath(here, Math.round(v.x), Math.round(v.y), s.x, s.y) || [{ x: s.x, y: s.y }];
    v.target = locId;
  }

  leave(uid: string) {
    const v = this.mine(uid);
    if (!v) return false;
    this.remove(v, true);
    return true;
  }

  remove(v: Avatar, say: boolean) {
    this.list = this.list.filter((x) => x !== v);
    if (say) this.town.log('avatar', `👋 旅人「${v.name}」离开了小镇`, {});
    this.town.emit('avatars');
  }

  touch(uid: string) { const v = this.mine(uid); if (v) v.seen = this.now(); return v; }

  /** dtReal：真实秒数 */
  tick(dtReal: number) {
    const now = this.now();
    for (const v of [...this.list]) {
      if (now - v.seen > IDLE_MS) { this.remove(v, true); continue; }
      if ((v.hp ?? 100) < 100 && !this.town.engaged?.('avatar', v.id)) v.hp = Math.min(100, (v.hp ?? 100) + REGEN * dtReal);
      if ((v.downUntil || 0) > now) continue;
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

  arrived(v: Avatar) {
    const town = this.town;
    v.moving = false;
    if (v.hop) {
      const { to, locId, arrive } = v.hop;
      v.hop = null;
      if (!town.regionOpen(to)) return;
      const g = arrive || town.worldOf(to).gate;
      Object.assign(v, { region: to, x: g.x, y: g.y });
      this.walk(v, locId);
      return;
    }
    v.locId = v.target || null;
    town.hooks?.emit('avatar.arrive', { avatar: v });
    // 认识的居民会打招呼（不调用模型）
    for (const a of town.agents) {
      if (a.kind === 'creature' || a.status !== 'acting' || a.convoId || a.bubble || !this.near(a, 4).includes(v)) continue;
      const known = Boolean(a.travellers?.[v.uid]) || (a.visitorChats?.[v.uid] || []).length > 0;
      if (!known && this.town.rng() > 0.3) continue;
      town.say(a, known ? `又见面了，${v.name}！` : `你好呀，${v.name}，第一次来吗？`, 4000, 'say');
      break;
    }
  }

  /** 居民身边的访客化身（同一区域、户外、6 格内） */
  near(a: LiveAgent, r = 6) {
    if (a.inside) return [];
    return this.list.filter((v) => v.region === (a.region || 'town') && Math.hypot(v.x - a.x, v.y - a.y) < r);
  }

  view() {
    const now = this.now();
    return this.list.map((v) => ({ id: v.id, name: v.name, color: v.color, look: v.look, x: +v.x.toFixed(2), y: +v.y.toFixed(2), dir: v.dir, moving: v.moving, region: v.region,
      ...((v.hp ?? 100) < 100 ? { hp: Math.round(v.hp!) } : {}), ...((v.downUntil || 0) > now ? { down: true } : {}),
      // 接下来要走的几格与终点：前端据此预览路线、平滑插值
      ...(v.path.length ? { next: v.path.slice(0, 3), to: v.path[v.path.length - 1] } : {}) }));
  }
}
