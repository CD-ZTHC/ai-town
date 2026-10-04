// 成长（docs/design/adventure.md §3.1、§3.9）：经验、等级、属性加成、升级学招。
// 居民和旅人化身用同一套函数，化身只是多了等级上限、只能学战斗招式这几条限制。
// 下面的规则只依赖显式输入（可以单独测试）；Town 上的方法（Growth mixin）负责找人、写记忆、发事件。
import { addMemory } from '../memory.ts';
import { findAbility } from '../kernel/abilities.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { GrowthDef, GrowthTrack, WorldSpec } from '../types/spec.ts';
import type { Avatar } from '../avatars.ts';

export interface Xp { level: number; exp: number; track: string }
export interface Gains { atk: number; def: number; maxHp: number }
export const BASE_HP = 100;
const DEFAULT_MAX_LEVEL = 40;
const KILLER_BONUS = 0.2;
/** 化身技能栏最多几个 */
export const KIT_MAX = 4;

// ---------- 规则（只依赖显式输入） ----------
export const maxLevelOf = (g: GrowthDef | undefined): number => g?.maxLevel ?? DEFAULT_MAX_LEVEL;

/** 从 level 升到 level+1 需要的经验 */
export function expToNext(g: GrowthDef | undefined, level: number): number {
  const base = g?.curve?.base ?? 20, mult = g?.curve?.mult ?? 1.3;
  return Math.max(1, Math.round(base * mult ** (level - 1)));
}

export function trackOf(g: GrowthDef | undefined, id: string | undefined): GrowthTrack | null {
  if (!g) return null;
  return (id && g.tracks[id]) || Object.values(g.tracks)[0] || null;
}

/** 等级带来的属性加成：perLevel ×（等级 - 1），攻防取整 */
export function levelGains(g: GrowthDef | undefined, xp: Xp | null | undefined): Gains {
  const t = xp && trackOf(g, xp.track);
  if (!t || !xp) return { atk: 0, def: 0, maxHp: 0 };
  const n = Math.max(0, xp.level - 1);
  const p = t.perLevel || {};
  return { atk: Math.floor((p.atk || 0) * n), def: Math.floor((p.def || 0) * n), maxHp: Math.round((p.maxHp || 0) * n) };
}

/** 加经验：返回新的 xp、升了哪些级、学会了哪些能力（按 learn 的等级）、属性涨了多少。cap：等级上限 */
export function addExp(g: GrowthDef, xp: Xp, amount: number, cap = maxLevelOf(g)): { xp: Xp; levels: number[]; learned: string[]; gains: Gains } {
  const before = levelGains(g, xp);
  const next: Xp = { ...xp, exp: xp.exp + Math.max(0, Math.round(amount)) };
  const levels: number[] = [];
  while (next.level < cap && next.exp >= expToNext(g, next.level)) {
    next.exp -= expToNext(g, next.level);
    next.level += 1;
    levels.push(next.level);
  }
  // 到了上限：经验停在升级线上，不再累积
  if (next.level >= cap) next.exp = Math.min(next.exp, expToNext(g, next.level) - 1);
  const t = trackOf(g, next.track);
  const learned = (t?.learn || []).filter((l) => levels.includes(l.level)).map((l) => l.ability);
  const after = levelGains(g, next);
  return { xp: next, levels, learned, gains: { atk: after.atk - before.atk, def: after.def - before.def, maxHp: after.maxHp - before.maxHp } };
}

/** 战斗结束时的经验分配：participants 平分（最后一击另加 20%），killer 全给最后一击 */
export function shareExp(amount: number, recipients: string[], killer: string | null, share: GrowthDef['share'] = 'participants'): Record<string, number> {
  const out: Record<string, number> = {};
  if (!(amount > 0)) return out;
  if (share === 'killer' || !recipients.length) { if (killer) out[killer] = Math.round(amount); return out; }
  const each = amount / recipients.length;
  for (const r of recipients) out[r] = Math.max(1, Math.round(each + (r === killer ? amount * KILLER_BONUS : 0)));
  return out;
}

/** 威胁或生物值多少经验：写了 exp 用 exp，否则按 hp / 5 */
export const expWorth = (hp: number, exp?: number): number => Math.max(1, Math.round(exp ?? hp / 5));

/** 装备的属性：每个槽位只取加成最高的一件（同槽多件不叠加） */
export function equipped(inventory: Record<string, number>, items: WorldSpec['items']): string[] {
  const best = new Map<string, { id: string; score: number }>();
  for (const [k, n] of Object.entries(inventory)) {
    const it = items[k];
    if (!it?.equip || n < 1) continue;
    const m = it.mods || {};
    const score = (m.atk || 0) + (m.def || 0) + (m.hp || 0) / 10;
    // 写明槽位（weapon / armor / trinket…）的同槽只取一件；旧写法 equip: true 没有槽位，各算各的
    const slot = typeof it.equip === 'string' ? it.equip : `item:${k}`;
    const cur = best.get(slot);
    if (!cur || score > cur.score || (score === cur.score && k < cur.id)) best.set(slot, { id: k, score });
  }
  return [...best.values()].map((x) => x.id);
}

/** 生命上限：100 + 装备的 hp + 成长 */
export function maxHpOf(inventory: Record<string, number>, items: WorldSpec['items'], g: GrowthDef | undefined, xp: Xp | null | undefined): number {
  const eq = equipped(inventory, items).reduce((s, id) => s + (items[id]?.mods?.hp || 0), 0);
  return Math.max(10, BASE_HP + eq + levelGains(g, xp).maxHp);
}

// ---------- Town 上的接口 ----------
/** 能拿经验的单位：居民，或旅人化身（按账号） */
export type Grower = { kind: 'agent'; agent: LiveAgent } | { kind: 'avatar'; avatar: Avatar };

export class Growth {
  /** 这个居民会不会成长；会的话返回（必要时创建）它的 xp */
  xpOf(this: Town, a: LiveAgent): Xp | null {
    const g = this.spec.growth;
    if (!g || a.kind === 'creature') return null;
    if (a.xp) return a.xp;
    const p = this.spec.personas.find((x) => x.id === a.id);
    if (g.who !== 'all' && !p?.growth) return null;
    const track = p?.growth?.track && g.tracks[p.growth.track] ? p.growth.track : Object.keys(g.tracks)[0];
    if (!track) return null;
    a.xp = { level: Math.min(maxLevelOf(g), p?.growth?.level || 1), exp: 0, track };
    return a.xp;
  }

  /** 旅人化身的 xp：按账号存在存档里（adventure.avatars），化身本身不进存档 */
  avatarXp(this: Town, v: Avatar): Xp | null {
    const g = this.spec.growth;
    if (!g) return null;
    const st = this.adventureState();
    const saved = st.avatars[v.uid];
    const track = g.avatar?.track && g.tracks[g.avatar.track] ? g.avatar.track : Object.keys(g.tracks)[0]!;
    if (!saved) st.avatars[v.uid] = { level: 1, exp: 0, track, kit: [] };
    else if (!g.tracks[saved.track]) saved.track = track;
    return st.avatars[v.uid]!;
  }

  /** 化身的等级上限：世界包写了就用，否则为居民最高等级 + 2（至少 5），不让玩家把居民远远甩在后面 */
  avatarCap(this: Town): number {
    const g = this.spec.growth;
    if (g?.avatar?.maxLevel) return g.avatar.maxLevel;
    const top = Math.max(1, ...this.agents.map((a) => a.xp?.level || 1));
    return Math.min(maxLevelOf(g), Math.max(5, top + 2));
  }

  /** 居民的生命上限（同时写回 body.maxHp，身体恢复、视图都用它） */
  maxHp(this: Town, a: LiveAgent): number {
    const m = maxHpOf(a.inventory, this.spec.items, this.spec.growth, this.spec.growth ? this.xpOf(a) : null);
    if (a.body.maxHp !== m) {
      // 上限变低时把血量压下来；旧存档没有 maxHp 时按 100
      a.body.maxHp = m;
      if (a.body.hp > m) a.body.hp = m;
    }
    return m;
  }

  /** 化身的生命上限（化身没有背包，只算成长） */
  avatarMaxHp(this: Town, v: Avatar): number {
    return maxHpOf({}, this.spec.items, this.spec.growth, this.spec.growth ? this.avatarXp(v) : null);
  }

  /** 化身的技能栏：世界的 avatarKit + 升级学会的战斗招式（最多 KIT_MAX 个，满了时替换最早学的） */
  avatarKitOf(this: Town, v: Avatar | null): string[] {
    const base = this.spec.combat?.avatarKit || [];
    if (!v || !this.spec.growth) return base;
    const learned = (this.adventureState().avatars[v.uid]?.kit || []).filter((id) => findAbility(this.spec, id)?.combat);
    const room = Math.max(0, KIT_MAX - learned.length);
    return [...base.slice(0, room), ...learned].slice(0, KIT_MAX);
  }

  /** 给某个单位加经验：升级时学招、加血上限、写记忆、发事件 */
  grantExp(this: Town, who: Grower, amount: number, why = ''): number {
    const g = this.spec.growth;
    if (!g || !(amount > 0)) return 0;
    if (who.kind === 'agent') {
      const a = who.agent;
      const xp = this.xpOf(a);
      if (!xp) return 0;
      const hpBefore = this.maxHp(a);
      const r = addExp(g, xp, amount);
      a.xp = r.xp;
      const learned: string[] = [];
      for (const id of r.learned) if (!a.abilities.includes(id) && findAbility(this.spec, id)) { a.abilities.push(id); learned.push(id); }
      const hpAfter = this.maxHp(a);
      if (hpAfter > hpBefore) a.body.hp = Math.min(hpAfter, a.body.hp + (hpAfter - hpBefore));
      if (r.levels.length) this.onLevelUp({ kind: 'agent', id: a.id, name: a.name, level: r.xp.level, gains: r.gains, learned, why }, a);
      else this.emit('agent', a.id);
      return Math.round(amount);
    }
    const v = who.avatar;
    const xp = this.avatarXp(v)!;
    const r = addExp(g, xp, amount, this.avatarCap());
    const st = this.adventureState().avatars[v.uid]!;
    Object.assign(st, r.xp);
    // 化身只学带 combat 块、非创世级的能力
    const learned = r.learned.filter((id) => { const ab = findAbility(this.spec, id); return ab?.combat && ab.power !== 'genesis'; });
    for (const id of learned) if (!st.kit.includes(id)) { st.kit.push(id); if (st.kit.length > KIT_MAX) st.kit.shift(); }
    if (r.gains.maxHp > 0) v.hp = Math.min(this.avatarMaxHp(v), (v.hp ?? this.avatarMaxHp(v)) + r.gains.maxHp);
    if (r.levels.length) this.onLevelUp({ kind: 'avatar', id: v.id, name: v.name, level: r.xp.level, gains: r.gains, learned, why }, null);
    return Math.round(amount);
  }

  onLevelUp(this: Town, ev: { kind: 'agent' | 'avatar'; id: string; name: string; level: number; gains: Gains; learned: string[]; why: string }, a: LiveAgent | null) {
    const names = ev.learned.map((id) => findAbility(this.spec, id)?.name || id);
    if (a) {
      addMemory(a, { t: this.t, type: 'obs', text: `觉得自己又强了一些（${ev.level} 级）${names.length ? `，学会了${names.join('、')}` : ''}`, importance: 6 });
      this.emit('agent', a.id);
    }
    this.log('levelup', `⭐ ${ev.kind === 'avatar' ? `旅人「${ev.name}」` : ev.name}升到了 ${ev.level} 级${names.length ? `，习得：${names.join('、')}` : ''}`, { agents: a ? [a.id] : [], milestone: 'levelup' });
    this.emit('adv', { type: 'levelup', unit: { kind: ev.kind, id: ev.id }, name: ev.name, level: ev.level, gains: ev.gains, learned: ev.learned.map((id, i) => ({ id, name: names[i] })) });
  }
}
