// 回复与撤退（docs/design/adventure.md §3.2）：回复点、血少撤退、被打倒后送到最近的回复点、在回复点回血。
// 居民和旅人化身共用「找最近的回复点」与回血速率（§3.9）。没有 recovery 字段的世界沿用原来的送诊所逻辑。
import { addMemory } from '../memory.ts';
import { posOf } from '../kernel/effects.ts';
import { REST_KINDS } from '../kernel/adventure-spec.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent } from '../types/agent.ts';
import type { RecoveryDef, WorldSpec } from '../types/spec.ts';
import type { RegionLink } from './regions.ts';
import type { Cell } from '../types/map.ts';

export interface RecoveryCfg { kinds: readonly string[]; rate: number; retreatAt: number; resumeAt: number; downed: 'carry' | 'warp' }
const CARRY_R = 8;
const WARP_AFTER = 30; // 没人搀扶时，多少游戏分钟后「被路过的人送到」回复点
const HEALER_MULT = 1.5;

// ---------- 规则（只依赖显式输入） ----------
export function recoveryCfg(r: RecoveryDef | undefined): RecoveryCfg {
  return { kinds: r?.kinds || REST_KINDS, rate: r?.rate ?? 1.5, retreatAt: r?.retreatAt ?? 0.35, resumeAt: r?.resumeAt ?? 0.9, downed: r?.downed || 'carry' };
}

/** 地点的类型：户外地点写在地点上，建筑写在建筑上 */
export function locKind(spec: Pick<WorldSpec, 'locations' | 'buildings'>, id: string): string | null {
  const l = spec.locations[id];
  if (typeof l?.kind === 'string') return l.kind;
  return spec.buildings.find((b) => b.id === id && !b.removed)?.kind || null;
}

/** 这个地点是不是回复点；是的话返回回血速率（每游戏分钟回复生命上限的百分之几）与文案 */
export function restOf(spec: Pick<WorldSpec, 'locations' | 'buildings' | 'recovery'>, id: string | null | undefined): { rate: number; text: string } | null {
  if (!id || !spec.recovery) return null;
  const cfg = recoveryCfg(spec.recovery);
  const own = spec.recovery.places?.[id];
  if (own) return { rate: own.rate ?? cfg.rate, text: own.text || '' };
  const k = locKind(spec, id);
  if (k && cfg.kinds.includes(k)) return { rate: cfg.rate, text: '' };
  return null;
}

/** 从 from 区域出发，到各个区域要换几次地图（广度优先；到不了的不在结果里） */
export function regionHops(links: RegionLink[], isOpen: (id: string) => boolean, from: string): Map<string, number> {
  const out = new Map<string, number>([[from, 0]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) for (const l of links) if (l.from === q[i] && isOpen(l.to) && !out.has(l.to)) { out.set(l.to, out.get(q[i]!)! + 1); q.push(l.to); }
  return out;
}

/** 挑最近的地点：先比换几次地图，再比同一张地图上的直线距离 */
export function pickNearest(cands: Array<{ id: string; region: string; at: Cell | null }>, from: { x: number; y: number; region: string }, hops: Map<string, number>): string | null {
  let best: string | null = null, bs = Infinity;
  for (const c of cands) {
    const h = hops.get(c.region);
    if (h == null || !c.at) continue;
    const s = h * 10_000 + (h === 0 ? Math.hypot(c.at.x - from.x, c.at.y - from.y) : 0);
    if (s < bs) { bs = s; best = c.id; }
  }
  return best;
}

/** 回复点里每游戏分钟回多少血 */
export const restHeal = (maxHp: number, rate: number, dt: number, { sleeping = false, healer = false } = {}): number =>
  (maxHp * rate / 100) * dt * (sleeping ? 2 : 1) * (healer ? HEALER_MULT : 1);

export const isNight = (minute: number, dayEnd: number): boolean => minute >= Math.min(dayEnd, 23 * 60) || minute < 6 * 60 + 30;

// ---------- Town 上的接口 ----------
export class Recovery {
  recoveryCfg(this: Town): RecoveryCfg { return recoveryCfg(this.spec.recovery); }

  restOf(this: Town, locId: string | null | undefined) { return restOf(this.spec, locId); }

  /** 离某个位置最近、走得到的回复点（没有时返回 null） */
  nearestRest(this: Town, from: { x: number; y: number; region?: string | null } | null): string | null {
    if (!from || !this.spec.recovery) return null;
    const region = from.region || 'town';
    const hops = regionHops(this.regionLinks(), (id) => this.regionOpen(id), region);
    const cands = Object.keys(this.spec.locations).filter((id) => this.restOf(id) && this.findLocation(id) && this.regionOpen(this.locRegion(id)))
      .map((id) => ({ id, region: this.locRegion(id), at: this.locCenter(id) }));
    return pickNearest(cands, { x: from.x, y: from.y, region }, hops);
  }

  /**
   * 送去休整：撤退（retreat）、被打倒（downed）。去最近的回复点，没有就回家。
   * 被打倒时：身边有同伴或交好的人就搀扶过去，没有就过一阵子「被路过的人送到」
   */
  sendToRest(this: Town, a: LiveAgent, why: 'retreat' | 'downed' = 'retreat'): string {
    const at = this.nearestRest(posOf(this, a)) || a.home;
    a.resting = { at, since: Math.floor(this.t), why };
    a.curKey = null;
    const st = this.adventureToday();
    const name = this.locName(at);
    if (why === 'retreat') {
      st.retreats += 1;
      addMemory(a, { t: this.t, type: 'obs', text: `伤得不轻，先撤回${name}休整`, importance: 5 });
      this.log('retreat', `↩️ ${a.name}退出战场，往${name}撤去`, { agents: [a.id] });
      this.emit('adv', { type: 'retreat', unit: { kind: 'agent', id: a.id }, name: a.name, to: at, toName: name });
      // 队长撤退：全队一起撤
      for (const m of this.partyMembers(a)) if (m !== a && !m.resting && !this.engaged('agent', m.id)) { m.resting = { at, since: Math.floor(this.t), why: 'retreat' }; m.curKey = null; }
      return at;
    }
    st.downs += 1;
    const carrier = this.recoveryCfg().downed === 'carry' ? this.findCarrier(a) : null;
    if (carrier) {
      carrier.resting = { at, since: Math.floor(this.t), why: 'retreat' };
      carrier.curKey = null;
      addMemory(carrier, { t: this.t, type: 'event', text: `把倒下的${a.name}扶去了${name}`, importance: 7 });
      addMemory(a, { t: this.t, type: 'event', text: `倒下的时候，是${carrier.name}把我扶去了${name}`, importance: 8 });
      const r = (a.relations[carrier.id] ||= { affinity: 0, note: '' });
      r.affinity = Math.min(100, r.affinity + 8);
      this.log('downed', `🤝 ${carrier.name}扶起倒下的${a.name}，往${name}走去`, { agents: [a.id, carrier.id], milestone: 'downed' });
      this.emit('adv', { type: 'downed', unit: { kind: 'agent', id: a.id }, name: a.name, carrier: { kind: 'agent', id: carrier.id, name: carrier.name }, to: at, toName: name });
    } else {
      (a.resting as { warpAt?: number }).warpAt = this.t + WARP_AFTER;
      this.log('downed', `🩸 ${a.name}倒下了，过一阵子会被人送到${name}`, { agents: [a.id], milestone: 'downed' });
      this.emit('adv', { type: 'downed', unit: { kind: 'agent', id: a.id }, name: a.name, to: at, toName: name });
    }
    const doc = this.agents.find((x) => x.work === at && x.kind !== 'creature' && x !== a);
    if (doc) addMemory(doc, { t: this.t, type: 'event', text: `${a.name}受了伤，被送到了${name}`, importance: 6 });
    return at;
  }

  /** 能搀扶倒下的人的：8 格内醒着、没在战斗、同队或好感 ≥ 50 的人（同队优先） */
  findCarrier(this: Town, a: LiveAgent): LiveAgent | null {
    const p = posOf(this, a);
    if (!p) return null;
    const team = new Set(this.partyMembers(a));
    return this.agents.filter((o) => o !== a && o.kind !== 'creature' && o.status !== 'sleeping' && !o.captive && !o.convoId && !this.engaged('agent', o.id)
      && (o.region || 'town') === p.region && Math.hypot(o.x - p.x, o.y - p.y) <= CARRY_R && (team.has(o) || (o.relations[a.id]?.affinity ?? 0) >= 50))
      .sort((x, y) => Number(team.has(y)) - Number(team.has(x)) || (y.relations[a.id]?.affinity ?? 0) - (x.relations[a.id]?.affinity ?? 0))[0] || null;
  }

  /** 正在休整的人此刻该做的事：去回复点、夜里在那里过夜；血回够了就恢复原来的日程 */
  restEntry(this: Town, a: LiveAgent): CurEntry | null {
    const r = a.resting;
    if (!r) return null;
    const max = this.maxHp(a);
    if (r.why !== 'downed' && a.body.hp >= this.recoveryCfg().resumeAt * max) return this.endRest(a), null;
    if (r.why === 'downed' && a.body.hp >= 0.5 * max) { r.why = 'retreat'; }
    const night = isNight(this.minute, this.dayEnd);
    const info = this.restOf(r.at);
    const name = this.locName(r.at);
    return {
      key: `rest-${r.at}-${night ? `n${this.day}` : 'd'}`, location: r.at === a.home ? 'home' : r.at,
      activity: night ? `在${name}过夜` : info?.text || `在${name}休整`, emoji: info ? '🏕️' : '🛏️', sleep: night, sleepAt: r.at,
    };
  }

  endRest(this: Town, a: LiveAgent) {
    if (!a.resting) return;
    const at = a.resting.at;
    a.resting = null;
    a.curKey = null;
    if (a.body.hp >= 0.5 * this.maxHp(a)) a.body.conditions = a.body.conditions.filter((c) => c !== '重伤');
    this.log('rested', `💪 ${a.name}在${this.locName(at)}休整好了，重新出发`, { agents: [a.id] });
    this.emit('adv', { type: 'rested', unit: { kind: 'agent', id: a.id }, name: a.name });
    this.emit('agent', a.id);
  }

  /** 每游戏分钟：血少的人撤退；没人搀扶的倒地者到时被送到回复点 */
  recoveryTick(this: Town) {
    if (!this.spec.recovery) return;
    const cfg = this.recoveryCfg();
    for (const a of [...this.agents]) {
      if (a.kind === 'creature' || a.captive) continue;
      const r = a.resting as (LiveAgent['resting'] & { warpAt?: number }) | null | undefined;
      if (r?.warpAt && this.t >= r.warpAt) {
        delete r.warpAt;
        this.warpTo(a, r.at);
        continue;
      }
      if (r || !cfg.retreatAt || a.status === 'sleeping' || a.convoId || this.engaged('agent', a.id)) continue;
      if (a.body.hp < cfg.retreatAt * this.maxHp(a)) this.sendToRest(a, 'retreat');
    }
  }

  /** 直接出现在某个地点（没人搀扶的倒地者「被送到」回复点） */
  warpTo(this: Town, a: LiveAgent, at: string) {
    const loc = this.findLocation(at);
    if (!loc) return;
    const region = this.locRegion(at);
    const b = loc.indoor ? this.worldOf(region).buildings.find((x) => x.id === loc.indoor) : null;
    const s = b ? b.entrance : (loc.spots[0] || this.locCenter(at));
    if (!s) return;
    Object.assign(a, { region, x: s.x, y: s.y, inside: b ? b.id : null, locId: at, path: [], dest: null, hop: null, moving: false, curKey: null, status: 'acting' });
    const doc = this.agents.find((x) => x.work === at && x.kind !== 'creature' && x !== a);
    addMemory(a, { t: this.t, type: 'event', text: `醒来时已经在${this.locName(at)}了${doc ? `，${doc.name}守在旁边` : ''}`, importance: 7 });
    if (doc && !doc.convoId) this.say(doc, `醒了？别乱动，伤还没好。`, 4000);
    this.log('revive', `🏥 ${a.name}被人送到了${this.locName(at)}`, { agents: [a.id] });
    this.emit('adv', { type: 'revive', unit: { kind: 'agent', id: a.id }, name: a.name, at, atName: this.locName(at), by: doc ? { kind: 'agent', id: doc.id, name: doc.name } : null });
  }

  /** 身体随时间：在回复点里按速率回血（睡觉翻倍、医生在场 ×1.5） */
  restHealTick(this: Town, a: LiveAgent, dt: number) {
    if (!this.spec.recovery || !a.locId || a.status === 'walking') return;
    const info = this.restOf(a.locId);
    if (!info) return;
    const max = this.maxHp(a);
    if (a.body.hp >= max) return;
    const healer = this.agents.some((x) => x !== a && x.work === a.locId && x.locId === a.locId && x.status !== 'sleeping');
    a.body.hp = Math.min(max, a.body.hp + restHeal(max, info.rate, dt, { sleeping: a.status === 'sleeping', healer }));
  }
}
