// 战斗与敌对行动（黑暗叙事设计 §4.3、§4.9；即时战斗见 docs/design/combat.md）：
// 居民之间的攻击、偷窃、威胁、俘虏与营救；居民、旅人化身与会死的威胁、敌对生物交手。
// 战斗按真实时间一拍一拍结算（fight-rules.ts 的 BEAT），每拍不调用 LLM；招式、伤害、规则 AI 都在 fight-rules.ts 里（可以单独测试）。
// 下面的 Town 方法（Combat mixin）负责把各种角色适配成「战斗单位」、推进战斗、结算结局，以及找人、记日志、写记忆等副作用。
import { addMemory } from '../memory.ts';
import { posOf, runEffects } from '../kernel/effects.ts';
import { findAbility } from '../kernel/abilities.ts';
import { lethal } from '../kernel/ratings.ts';
import { clamp } from './util.ts';
import {
  BEAT, MAX_BEATS, MAX_FIGHTS, STEP, INTERRUPT, STRIKE, DODGE, DODGE_CELLS, DODGE_BEATS,
  abilitySkill, addStatus, absorb, chooseSkill, damageRoll, dist, effectiveStats, hasStatus, inShape, sameUnit, stepToward, wantsFlee,
} from './fight-rules.ts';
import type { Fight, Fighter, Skill, Stats as FightStats, StatusId, UnitKind, UnitRef } from './fight-rules.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { ActArgs, ThreatInstance } from '../types/town.ts';
import type { WorldSpec } from '../types/spec.ts';
import type { EffectArgs, EffectCtx } from '../kernel/effects.ts';
import type { Avatar } from '../avatars.ts';
import type { Creature } from '../story/creatures.ts';

const HATE = -40; // 好感低于它才会动手
const CAPTIVE_MINUTES = 360;
const LEAVE_DIST = 12; // 离最近的敌人超过这么远就算脱离战斗
const AVATAR_HP = 100;

// ---------- 规则（只依赖显式输入） ----------
type Rand = () => number;
/** 战斗用到的居民字段 */
type FighterLike = Pick<LiveAgent, 'name' | 'body' | 'inventory' | 'combat'>;
export interface Stats { atk: number; def: number; tags: string[] }

/** 属性：基础值 + 人设里的 combat + 装备 */
export function computeStats(a: FighterLike, items: WorldSpec['items']): Stats {
  let atk = 4 + (a.combat?.atk || 0) + Math.round((a.body.courage - 50) / 25);
  let def = 1 + (a.combat?.def || 0);
  const tags: string[] = [];
  for (const [k, n] of Object.entries(a.inventory)) {
    const it = items[k];
    if (!it?.equip || n < 1) continue;
    atk += it.mods?.atk || 0;
    def += it.mods?.def || 0;
    tags.push(...(it.tags || []));
  }
  return { atk: Math.max(1, atk), def: Math.max(0, def), tags };
}

/** 能不能动手：返回不能的理由，能动手时返回 null（分级允许，而且恨对方、是反派，或者阵营敌对） */
export function harmVerdict({ hostileWorld, rating, intent, affinity, villain, factionsHostile, names }: {
  hostileWorld: boolean; rating: string; intent: string; affinity: number; villain: boolean; factionsHostile: boolean; names: [string, string];
}): string | null {
  if (!hostileWorld) return '这个世界里没有人会动手';
  if (intent === 'kill' && !lethal(rating)) return '这个世界不允许杀人';
  if (villain || affinity <= HATE || factionsHostile) return null;
  return `${names[0]}和${names[1]}没有深仇大恨，下不了手`;
}

/** 偷窃被抓：基础 40%，失主比小偷越勇敢越容易被抓 */
export const stealCaught = (victimCourage: number, thiefCourage: number, rng: Rand): boolean => rng() < 0.4 + (victimCourage - thiefCourage) / 200;

/** 救人时看守在场：救人的一方掷骰输了就被打回去（先掷救人者、再掷看守） */
export const guardRepels = (rescuer: Stats, guard: Stats, rng: Rand): boolean => rescuer.atk + rng() * 6 < guard.atk + rng() * 6;

// ---------- 战斗单位 ----------
/** 一个战斗单位此刻的样子（每次现取，不缓存） */
interface Unit {
  ref: UnitRef;
  name: string;
  x: number;
  y: number;
  region: string;
  hp: number;
  maxHp: number;
  courage: number;
  base: FightStats;
  agent?: LiveAgent;
  avatar?: Avatar;
  threat?: ThreatInstance;
  creature?: Creature;
}

/** 招式命中的上下文（效果原语 strike / status / knockback 在 ctx.combat 里拿到） */
interface CombatCtx { fight: Fight; fighter: Fighter; hits: Fighter[]; events: BeatEvents }
/** 一拍里发生的事（推给前端画飘字与特效） */
interface BeatEvents {
  id: string;
  region: string;
  casts: Array<{ by: UnitRef; skill: string; name: string; emoji: string; windup: number; target: UnitRef | null }>;
  fx: Array<{ by: UnitRef; skill: string; shape: string; range: number; radius: number; from: { x: number; y: number }; to: { x: number; y: number } | null; whiff?: boolean }>;
  /** by：出手的人（流血等没有出手的人时为空），前端据此画后退方向 */
  hits: Array<{ to: UnitRef; by?: UnitRef; dmg: number; crit?: boolean; heal?: boolean; absorbed?: number; dodged?: boolean; x: number; y: number }>;
  notes: Array<{ to: UnitRef; text: string; x: number; y: number }>;
  /** Boss 进入新阶段 */
  phase?: { name: string; emoji: string; text: string };
  start?: boolean;
  end?: boolean;
}

const refOf = (kind: UnitKind, id: string): UnitRef => ({ kind, id });

export class Combat {
  combatStats(this: Town, a: LiveAgent) { return computeStats(a, this.spec.items); }

  /** a 能不能对 b 动手（规则见 harmVerdict） */
  mayHarm(this: Town, a: LiveAgent, b: LiveAgent, intent = 'subdue') {
    return harmVerdict({
      hostileWorld: Boolean(this.canBeHostile?.()), rating: this.spec.meta.rating, intent,
      affinity: a.relations[b.id]?.affinity ?? 0, villain: a.alignment === 'villain', factionsHostile: this.factionsHostile(a, b), names: [a.name, b.name],
    });
  }

  factionsHostile(this: Town, a: LiveAgent, b: LiveAgent) {
    const fa = this.factionOf?.(a), fb = this.factionOf?.(b);
    return Boolean(fa && fb && fa !== fb && (fa.hostile || []).includes(fb.id));
  }

  // ---------- 战斗单位的适配 ----------
  unit(this: Town, ref: UnitRef | null | undefined): Unit | null {
    if (!ref) return null;
    switch (ref.kind) {
      case 'agent': {
        const a = this.byId[ref.id];
        if (!a || !this.agents.includes(a)) return null;
        const s = this.combatStats(a);
        const p = posOf(this, a)!;
        return { ref, name: a.name, x: p.x, y: p.y, region: p.region || 'town', hp: a.body.hp, maxHp: 100, courage: a.body.courage, base: { ...s, spd: 1 + (a.combat?.spd || 0) }, agent: a };
      }
      case 'avatar': {
        const v = this.avatars.list.find((x) => x.id === ref.id);
        if (!v || (v.downUntil || 0) > this.now()) return null;
        return { ref, name: v.name, x: v.x, y: v.y, region: v.region, hp: v.hp ?? AVATAR_HP, maxHp: AVATAR_HP, courage: 100, base: { atk: 7, def: 2, spd: 1.2, tags: [] }, avatar: v };
      }
      case 'threat': {
        const inst = this.threats.live().find((x) => x.id === ref.id);
        const def = inst && this.threats.def(inst);
        if (!inst || !def?.mortal || (inst.hp ?? 0) <= 0) return null;
        // Boss 的阶段：攻击力按当前阶段的倍数
        const ph = typeof inst.phase === 'number' ? def.phases?.[inst.phase] : null;
        return { ref, name: def.name, x: inst.x, y: inst.y, region: inst.region || 'town', hp: inst.hp!, maxHp: def.hp || 1, courage: 100, base: { atk: (def.atk || 0) * (ph?.atk ?? 1), def: def.def || 0, spd: def.speed || 1, tags: [] }, threat: inst };
      }
      case 'creature': {
        const c = this.creatures.list.find((x) => x.id === ref.id);
        const def = c && this.spec.creatures?.[c.type];
        if (!c || !def || c.hp <= 0 || c.friendly || c.hidden) return null;
        return { ref, name: c.name, x: c.x, y: c.y, region: c.region || 'town', hp: c.hp, maxHp: def.stats.hp, courage: def.stats.courage, base: { atk: def.temperament === 'hostile' ? 6 : 3, def: 0, spd: def.stats.speed || 1, tags: [] }, creature: c };
      }
    }
    return null;
  }

  setUnitHp(this: Town, u: Unit, hp: number): void {
    hp = Math.max(0, Math.round(hp));
    if (u.agent) { u.agent.body.hp = Math.min(100, hp); this.emit('agent', u.agent.id); }
    else if (u.avatar) u.avatar.hp = Math.min(AVATAR_HP, hp);
    else if (u.threat) u.threat.hp = hp;
    else if (u.creature) u.creature.hp = hp;
    u.hp = hp;
  }

  /** 把单位挪到 (x, y)：只走得通的格子（户外） */
  moveUnit(this: Town, u: Unit, x: number, y: number): boolean {
    const w = this.worldOf(u.region);
    const cx = Math.round(x), cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= w.W || cy >= w.H || !w.walk[cy * w.W + cx]) return false;
    const o = (u.agent || u.avatar || u.threat || u.creature)! as { x: number; y: number; dir?: string; moving?: boolean; path?: unknown[]; inside?: string | null };
    const dx = x - o.x, dy = y - o.y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) o.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    o.x = x; o.y = y;
    if (u.agent) u.agent.inside = null;
    u.x = x; u.y = y;
    return true;
  }

  /** 一个单位能出的招：普攻 + 会的能力里带 combat 块的（化身：闪避 + 世界包的化身技能） */
  skillsOf(this: Town, f: Fighter): Skill[] {
    const kit: Skill[] = [];
    const u = this.unit(f);
    if (!u || u.base.atk > 0) kit.push(STRIKE);
    const ids = f.kind === 'agent' ? this.byId[f.id]?.abilities || [] : f.kind === 'avatar' ? this.spec.combat?.avatarKit || [] : f.kind === 'threat' ? this.threatSkills(f.id) : [];
    if (f.kind === 'avatar') kit.push(DODGE);
    for (const id of ids) {
      const ab = findAbility(this.spec, id);
      const s = ab && abilitySkill(ab);
      if (s) kit.push(s);
    }
    return kit;
  }

  /** 威胁会的招式：类型自带的 + 当前阶段加上的 */
  threatSkills(this: Town, id: string): string[] {
    const inst = this.threats.live().find((x) => x.id === id);
    const def = inst && this.threats.def(inst);
    if (!def) return [];
    const ph = typeof inst!.phase === 'number' ? def.phases?.[inst!.phase] : null;
    return [...new Set([...(def.skills || []), ...(ph?.skills || [])])];
  }

  /** Boss 掉血到阈值：进入下一阶段（喊话、横幅、执行阶段效果） */
  threatPhase(this: Town, F: Fight, h: Fighter, inst: ThreatInstance, ev: BeatEvents) {
    const def = this.threats.def(inst);
    if (!def?.phases?.length || (inst.hp ?? 0) <= 0) return;
    const ratio = inst.hp! / (def.hp || 1);
    const cur = typeof inst.phase === 'number' ? inst.phase : -1;
    for (let i = cur + 1; i < def.phases.length; i++) {
      const ph = def.phases[i]!;
      if (ratio > ph.at) break;
      inst.phase = i;
      ev.phase = { name: def.name, emoji: def.emoji, text: ph.text };
      this.log('threat', `${def.emoji} ${ph.text}`, { threat: inst.id });
      if (ph.effects?.length) {
        const hits = F.fighters.filter((x) => !x.out && x.side !== h.side);
        runEffects(this, { self: null, target: null, at: { x: inst.x, y: inst.y, inside: null, region: inst.region || 'town' }, source: `threat:${inst.type}`, threat: inst, combat: { fight: F, fighter: h, hits, events: ev } satisfies CombatCtx }, ph.effects);
      }
    }
  }

  /** 招式此刻能不能用：冷却、居民的体力与物品 */
  skillReady(this: Town, f: Fighter, s: Skill, beat: number): boolean {
    if ((f.cds[s.id] || 0) > beat) return false;
    const c = s.ability?.cost;
    if (!c || f.kind !== 'agent') return true;
    const a = this.byId[f.id]!;
    if ((c.stamina || 0) > a.body.stamina) return false;
    return Object.entries(c.items || {}).every(([k, n]) => (a.inventory[k] || 0) >= n);
  }

  // ---------- 开打 ----------
  fightOf(this: Town, ref: UnitRef): Fight | null {
    return (this.fights || []).find((f) => f.fighters.some((x) => !x.out && sameUnit(x, ref))) || null;
  }

  /** 这个单位正在战斗里（移动、日程让位给战斗） */
  engaged(this: Town, kind: UnitKind, id: string): boolean { return Boolean(this.fights?.length && this.fightOf(refOf(kind, id))); }

  /** 让 a 对 b 动手：都不在战斗里就开一场；一方已经在打，另一方加入对面 */
  engage(this: Town, a: UnitRef, b: UnitRef, intent = 'subdue'): { ok: true; fight: Fight } | { ok: false; reason: string } {
    const ua = this.unit(a), ub = this.unit(b);
    if (!ua || !ub) return { ok: false, reason: '对手不在了' };
    if (ua.region !== ub.region) return { ok: false, reason: `${ub.name}不在附近` };
    const fs = (this.fights ||= []);
    const fa = this.fightOf(a), fb = this.fightOf(b);
    const fresh = (ref: UnitRef, side: 0 | 1, target: UnitRef): Fighter => ({ ...ref, name: (sameUnit(ref, a) ? ua : ub).name, side, intent: ref.kind === 'agent' || ref.kind === 'avatar' ? intent : 'subdue', act: null, statuses: [], cds: {}, target });
    let F: Fight;
    if (fa && fb && fa !== fb) return { ok: false, reason: '已经打起来了' };
    if (fa && fb) {
      const xa = fa.fighters.find((x) => !x.out && sameUnit(x, a))!, xb = fa.fighters.find((x) => !x.out && sameUnit(x, b))!;
      if (xa.side === xb.side) return { ok: false, reason: `${ub.name}是自己人` };
      xa.target = b;
      return { ok: true, fight: fa };
    }
    if (fa || fb) {
      F = (fa || fb)!;
      const inside = F.fighters.find((x) => !x.out && sameUnit(x, fa ? a : b))!;
      const joiner = fa ? b : a;
      F.fighters = F.fighters.filter((x) => !sameUnit(x, joiner));
      F.fighters.push(fresh(joiner, inside.side === 0 ? 1 : 0, fa ? a : b));
      if (fa) inside.target = b;
    } else {
      if (fs.length >= MAX_FIGHTS) return { ok: false, reason: '到处都在打，乱成一团' };
      F = { id: `f${++this.seq}`, beat: 0, acc: 0, region: ua.region, fighters: [fresh(a, 0, b), fresh(b, 1, a)] };
      fs.push(F);
    }
    for (const u of [ua, ub]) {
      if (u.agent) Object.assign(u.agent, { path: [], dest: null, moving: false, action: { text: '战斗中', emoji: '⚔️' } });
      if (u.threat) u.threat.path = [];
      if (u.creature) u.creature.path = [];
    }
    if (ua.agent && ua.agent.inside) this.moveUnit(ua, ua.x, ua.y);
    if (ub.agent && ub.agent.inside) this.moveUnit(ub, ub.x, ub.y);
    // Boss 第一次开打：登场演出（威胁自己写了 stage.intro 就用它的）
    for (const u of [ua, ub]) {
      const def = u.threat && this.threats.def(u.threat);
      if (!u.threat || !def || !(def.boss || def.phases?.length) || u.threat.introduced) continue;
      u.threat.introduced = true;
      this.stage(def.stage?.intro || { template: 'intro', target: 'threat', name: `${def.emoji} ${def.name}`, title: ((def.kind ? `${def.kind} · ` : '') + (def.origin || '')).slice(0, 40), priority: 'major' },
        { threat: u.threat, at: { x: u.x, y: u.y, inside: null, region: u.region } }, { source: `threat:${u.threat.type}` });
    }
    // 新加入的居民定战术、说开场白（combat-mind）
    for (const f of F.fighters) if (!f.out && f.kind === 'agent' && !f.tactic && (sameUnit(f, a) || sameUnit(f, b))) this.planFighter(F, f);
    this.emit('combat', { id: F.id, region: F.region, start: true, casts: [], fx: [], hits: [], notes: [] } satisfies BeatEvents);
    return { ok: true, fight: F };
  }

  // ---------- 居民之间 ----------
  attack(this: Town, a: LiveAgent, { target, intent = 'subdue' }: ActArgs) {
    const b = this.findNear(a, target, 3);
    if (!b) return { ok: false, reason: `${target}不在身边`, retry: true };
    const no = this.mayHarm(a, b, intent);
    if (no) return { ok: false, reason: no };
    const r0 = this.engage(refOf('agent', a.id), refOf('agent', b.id), intent);
    if (!r0.ok) return { ok: false, reason: r0.reason };
    const r = (b.relations[a.id] ||= { affinity: 0, note: '' });
    r.affinity = clamp(r.affinity - 40, -100, 100);
    r.note = `${a.name}对我动手了`;
    this.say(a, intent === 'kill' ? '……' : '别怪我！', 3000);
    this.log('combat', `⚔️ ${a.name}向${b.name}动手了`, { agents: [a.id, b.id] });
    return { ok: true };
  }

  // ---------- 战斗时钟 ----------
  /** 主循环每帧调用（dtReal：真实秒数）：每场战斗按拍推进 */
  combatTick(this: Town, dtReal = BEAT) {
    this.aggroTick(dtReal);
    if (!this.fights?.length) return;
    for (const F of [...this.fights]) {
      F.acc += dtReal;
      for (let n = 0; F.acc >= BEAT - 1e-9 && n < 4 && this.fights.includes(F); n++) {
        F.acc -= BEAT;
        try { this.fightBeat(F); } catch (e) { this.fault(`战斗 ${F.id}`, e); this.endFight(F, ''); }
      }
    }
  }

  /** 有攻击力的会死的威胁、敌对的生物撞上身边的旅人会主动动手（每秒看一次） */
  aggroTick(this: Town, dtReal: number) {
    this.rt.aggroAcc = (this.rt.aggroAcc || 0) + dtReal;
    if (this.rt.aggroAcc < 1) return;
    this.rt.aggroAcc = 0;
    if (this.fights?.length) this.bystanderTick();
    // 世界包里写了 aggro 的怪物：主动扑向身边的居民
    for (const t of this.threats.live()) {
      const def = this.threats.def(t);
      if (!def?.mortal || !def.aggro || t.state !== 'roam' || this.fightOf(refOf('threat', t.id))) continue;
      const a = this.agents.find((x) => x.kind !== 'creature' && !x.inside && (x.region || 'town') === (t.region || 'town') && Math.hypot(x.x - t.x, x.y - t.y) <= def.aggro! && !this.fightOf(refOf('agent', x.id)));
      if (a) { this.engage(refOf('threat', t.id), refOf('agent', a.id)); this.log('combat', `${def.emoji} ${def.name}扑向了${a.name}`, { agents: [a.id], threat: t.id }); }
    }
    if (!this.avatars.list.length) return;
    const foes: UnitRef[] = [
      ...this.threats.live().filter((t) => this.threats.def(t)?.mortal && (this.threats.def(t)?.atk || 0) > 0 && t.state === 'roam').map((t) => refOf('threat', t.id)),
      ...this.creatures.list.filter((c) => !c.friendly && !c.hidden && c.hp > 0 && this.spec.creatures?.[c.type]?.temperament === 'hostile').map((c) => refOf('creature', c.id)),
    ];
    for (const ref of foes) {
      if (this.fightOf(ref)) continue;
      const u = this.unit(ref);
      const v = u && this.avatars.list.find((x) => x.region === u.region && (x.downUntil || 0) <= this.now() && Math.hypot(x.x - u.x, x.y - u.y) <= 2.5 && !this.fightOf(refOf('avatar', x.id)));
      if (v) this.engage(ref, refOf('avatar', v.id));
    }
  }

  fightBeat(this: Town, F: Fight) {
    const beat = ++F.beat;
    const ev: BeatEvents = { id: F.id, region: F.region, casts: [], fx: [], hits: [], notes: [] };
    // 离场检查、状态到期、流血
    for (const f of F.fighters) {
      if (f.out) continue;
      const u = this.unit(f);
      if (!u || u.region !== F.region) { f.out = 'gone'; continue; }
      f.statuses = f.statuses.filter((s) => s.until > beat);
      const bleed = f.statuses.find((s) => s.id === 'bleed');
      if (bleed && beat % 4 === 0) this.applyHit(F, f, null, bleed.amount || 2, false, ev);
    }
    for (const f of F.fighters) {
      if (f.out) continue;
      const u = this.unit(f);
      if (!u) { f.out = 'gone'; continue; }
      const enemies = F.fighters.filter((x) => !x.out && x.side !== f.side);
      // 离最近的敌人太远：脱离战斗
      const near = enemies.map((x) => this.unit(x)).filter((x): x is Unit => Boolean(x)).sort((p, q) => dist(p, u) - dist(q, u))[0];
      if (!near || dist(near, u) > LEAVE_DIST) { f.out = 'fled'; ev.notes.push({ to: refOf(f.kind, f.id), text: '脱离了战斗', x: u.x, y: u.y }); continue; }
      if (hasStatus(f, 'stun', beat)) { f.act = null; continue; }
      if (f.act) {
        if (f.act.phase === 'windup' && beat >= f.act.until) {
          const s = this.skillsOf(f).find((x) => x.id === f.act!.skill);
          const act = f.act;
          f.act = { ...act, phase: 'recover', until: beat + (s?.recover ?? 2) };
          if (s) this.resolveSkill(F, f, s, act.target, ev);
        } else if (f.act.phase === 'recover' && beat >= f.act.until) f.act = null;
        if (f.act) continue;
      }
      if (f.out) continue;
      const kit = this.skillsOf(f).filter((s) => this.skillReady(f, s, beat));
      // 玩家操控：执行排队的指令；没有指令时自己不动（走位由玩家控制）
      if (f.kind === 'avatar') {
        const q = f.queued;
        f.queued = null;
        const s = q && kit.find((x) => x.id === q.skill);
        f.queuedDir = q?.dir || null;
        if (s) this.startSkill(F, f, s, q!.target && enemies.some((x) => sameUnit(x, q!.target)) ? q!.target : near.ref, ev);
        continue;
      }
      // 规则 AI：目标 → 逃跑 → 选招 → 走近或出招
      const guardFor = this.protectTarget(F, f);
      if (guardFor) f.target = guardFor;
      let tgt = f.target && enemies.some((x) => sameUnit(x, f.target)) ? this.unit(f.target) : null;
      if (!tgt) { tgt = near; f.target = near.ref; }
      if (wantsFlee(f.kind, u.hp, u.maxHp, u.courage, f.tactic)) {
        f.out = 'fled';
        this.fled(f, u, tgt);
        continue;
      }
      const foes = enemies.map((x) => this.unit(x)).filter((x): x is Unit => Boolean(x));
      const s = chooseSkill(kit, { me: u, foe: tgt, foes, statuses: f.statuses, beat, tactic: f.tactic }, this.rng);
      if (!s) continue;
      const self = s.role === 'heal' || s.role === 'guard';
      const reach = s.shape === 'circle' ? Math.max(s.radius, 1) : s.range;
      if (!self && dist(u, tgt) > reach) {
        if (hasStatus(f, 'root', beat)) continue;
        const sp = effectiveStats(u.base, f, beat).spd;
        const p = stepToward(u, tgt, STEP * sp, reach * 0.85);
        if (!this.moveUnit(u, p.x, p.y)) this.moveUnit(u, p.x, u.y) || this.moveUnit(u, u.x, p.y);
        continue;
      }
      this.startSkill(F, f, s, tgt.ref, ev);
    }
    // 结局：一方没人了，或者打太久
    const alive = [0, 1].map((side) => F.fighters.some((x) => !x.out && x.side === side));
    if (!alive[0] || !alive[1]) this.endFight(F, '', ev);
    else if (beat >= MAX_BEATS) this.endFight(F, '打得筋疲力尽，各自散了', ev);
    if (ev.casts.length || ev.fx.length || ev.hits.length || ev.notes.length || ev.end || ev.phase) this.emit('combat', ev);
  }

  startSkill(this: Town, F: Fight, f: Fighter, s: Skill, target: UnitRef | null, ev: BeatEvents) {
    f.act = { skill: s.id, phase: 'windup', from: F.beat, until: F.beat + s.windup, target };
    f.cds[s.id] = F.beat + s.windup + s.cd;
    // 居民放能力照常支付消耗（冷却按战斗的拍数另算）
    const c = s.ability?.cost;
    if (c && f.kind === 'agent') {
      const a = this.byId[f.id]!;
      a.body.stamina = Math.max(0, a.body.stamina - (c.stamina || 0));
      for (const [k, n] of Object.entries(c.items || {})) { const left = (a.inventory[k] || 0) - n; if (left > 0) a.inventory[k] = left; else delete a.inventory[k]; }
      if (c.burden) this.addBurden?.(a, c.burden.id, c.burden.amount, 'ability_used');
      if (!a.convoId && s.windup >= 2) this.say(a, `${s.emoji} ${s.name}！`, 2500);
    }
    ev.casts.push({ by: refOf(f.kind, f.id), skill: s.id, name: s.name, emoji: s.emoji, windup: s.windup, target });
    if (s.windup === 0) {
      f.act = { ...f.act, phase: 'recover', until: F.beat + s.recover };
      this.resolveSkill(F, f, s, target, ev);
    }
  }

  /** 招式生效：找出命中的敌人，结算伤害与效果 */
  resolveSkill(this: Town, F: Fight, f: Fighter, s: Skill, target: UnitRef | null, ev: BeatEvents) {
    const u = this.unit(f);
    if (!u) return;
    if (s.id === 'dodge') return this.dodge(F, f, u, ev, f.queuedDir || null);
    const tu = this.unit(target);
    const aim = tu || (u.avatar ? facing(u) : null);
    const enemies = F.fighters.filter((x) => !x.out && x.side !== f.side);
    let hits: Fighter[];
    if (s.role === 'heal' || s.role === 'guard') hits = [];
    else if (s.shape === 'single') hits = tu && dist(u, tu) <= s.range + 1 ? enemies.filter((x) => sameUnit(x, target)) : [];
    else hits = enemies.filter((x) => { const p = this.unit(x); return p && aim && inShape(s, u, aim, p); });
    ev.fx.push({ by: refOf(f.kind, f.id), skill: s.id, shape: s.shape, range: s.range, radius: s.radius, from: { x: u.x, y: u.y }, to: aim ? { x: aim.x, y: aim.y } : null, ...(hits.length || s.role === 'heal' || s.role === 'guard' ? {} : { whiff: true }) });
    if (s.id === 'strike') {
      for (const h of hits) this.strikeOne(F, f, u, h, { power: s.power || 1 }, ev);
      return;
    }
    const ctx: EffectCtx = {
      self: u.agent || null, target: tu?.agent || null, at: { x: u.x, y: u.y, inside: null, region: u.region }, source: `ability:${s.id}`,
      combat: { fight: F, fighter: f, hits, events: ev } satisfies CombatCtx,
    };
    runEffects(this, ctx, s.ability!.effects);
  }

  /** 普攻 / strike 效果对一个敌人：威胁走自己的扣血（弱点、掉落、事件），其余按攻防结算 */
  strikeOne(this: Town, F: Fight, f: Fighter, u: Unit, h: Fighter, { power = 1, add = 0, tags = [] as string[] }, ev: BeatEvents) {
    const tu = this.unit(h);
    if (!tu) return;
    const me = effectiveStats(u.base, f, F.beat);
    const allTags = [...me.tags, ...tags];
    if (hasStatus(h, 'dodge', F.beat)) { ev.hits.push({ to: refOf(h.kind, h.id), by: refOf(f.kind, f.id), dmg: 0, dodged: true, x: tu.x, y: tu.y }); return; }
    if (tu.threat) {
      const { dmg: raw, crit } = damageRoll(me.atk, 0, this.rng, { power, add });
      const before = tu.threat.hp!;
      this.threats.hit(tu.threat, raw, allTags, u.agent || null);
      const dmg = Math.max(0, before - Math.max(0, tu.threat.hp!));
      h.lastHit = refOf(f.kind, f.id);
      ev.hits.push({ to: refOf(h.kind, h.id), by: refOf(f.kind, f.id), dmg, crit, x: tu.x, y: tu.y });
      this.afterHit(F, h, tu, dmg, ev);
      this.threatPhase(F, h, tu.threat, ev);
      if ((tu.threat.hp ?? 0) <= 0 || tu.threat.state === 'gone') { h.out = 'down'; if (!u.agent) this.log('threat', `⚔️ ${u.name}消灭了${tu.name}`, { threat: tu.threat.id }); }
      return;
    }
    const them = effectiveStats(tu.base, h, F.beat);
    const { dmg, crit } = damageRoll(me.atk, them.def, this.rng, { power, add });
    this.applyHit(F, h, f, dmg, crit, ev);
  }

  /** 扣血（护盾先吸收）、打断蓄力、倒下 */
  applyHit(this: Town, F: Fight, h: Fighter, by: Fighter | null, dmg: number, crit: boolean, ev: BeatEvents) {
    const tu = this.unit(h);
    if (!tu) return;
    const real = absorb(h, dmg, F.beat);
    this.setUnitHp(tu, tu.hp - real);
    if (by) h.lastHit = refOf(by.kind, by.id);
    ev.hits.push({ to: refOf(h.kind, h.id), ...(by ? { by: refOf(by.kind, by.id) } : {}), dmg: real, crit, ...(real < dmg ? { absorbed: dmg - real } : {}), x: tu.x, y: tu.y });
    this.afterHit(F, h, tu, real, ev);
    if (tu.threat) this.threatPhase(F, h, tu.threat, ev);
    if (tu.hp <= 0) this.unitDown(F, h, tu);
    else if (tu.agent && tu.hp < 0.3 * tu.maxHp) this.criticalMoment(F, h);
  }

  afterHit(this: Town, F: Fight, h: Fighter, tu: Unit, dmg: number, ev: BeatEvents) {
    if (h.act?.phase === 'windup' && h.act.until - h.act.from >= 2 && dmg >= INTERRUPT * tu.maxHp) {
      h.act = null;
      ev.notes.push({ to: refOf(h.kind, h.id), text: '被打断', x: tu.x, y: tu.y });
    }
  }

  dodge(this: Town, F: Fight | null, f: Fighter | null, u: Unit, ev: BeatEvents | null, dir: [number, number] | null = null) {
    // 往玩家按着的方向冲；没有方向时远离最近的敌人，再没有就往面朝的反方向
    let d = dir;
    if (!d && F && f) {
      const foe = F.fighters.filter((x) => !x.out && x.side !== f.side).map((x) => this.unit(x)).filter((x): x is Unit => Boolean(x)).sort((p, q) => dist(p, u) - dist(q, u))[0];
      const L = foe ? dist(foe, u) : 0;
      if (foe && L > 0.01) d = [(u.x - foe.x) / L, (u.y - foe.y) / L];
    }
    if (!d) { const v = DIRV[u.avatar?.dir || 'down'] || [0, 1]; d = [-v[0], -v[1]]; }
    let moved = 0;
    for (let i = 1; i <= DODGE_CELLS * 2; i++) {
      if (!this.moveUnit(u, u.x + d[0] * 0.5, u.y + d[1] * 0.5)) break;
      moved += 0.5;
    }
    if (u.avatar) u.avatar.path = [];
    if (F && f) addStatus(f, { id: 'dodge', until: F.beat + DODGE_BEATS });
    ev?.fx.push({ by: u.ref, skill: 'dodge', shape: 'single', range: moved, radius: 0, from: { x: u.x - d[0] * moved, y: u.y - d[1] * moved }, to: { x: u.x, y: u.y } });
  }

  /** 战斗效果原语（kernel/effects 的 strike / status / knockback）：在战斗里作用于招式命中的敌人 */
  combatEffect(this: Town, op: 'strike' | 'status' | 'knockback', ctx: EffectCtx, a: EffectArgs) {
    const cc = ctx.combat as CombatCtx | undefined;
    if (!cc) {
      // 不在战斗中：strike 打身边会死的威胁（同 damage），其余没有效果
      if (op === 'strike' && ctx.self) {
        const s = this.combatStats(ctx.self);
        this.threats?.damageNear(posOf(this, ctx.self) || ctx.at, Math.round(s.atk * (a.power ?? 1) + (a.add ?? 0)), [...s.tags, ...(a.tags || [])], 3, ctx.self);
      }
      return;
    }
    const { fight: F, fighter: f, hits, events: ev } = cc;
    const u = this.unit(f);
    if (!u) return;
    if (op === 'strike') { for (const h of hits) if (!h.out) this.strikeOne(F, f, u, h, { power: a.power ?? 1, add: a.add ?? 0, tags: a.tags || [] }, ev); return; }
    if (op === 'status') {
      const who = (a.target ?? 'target') === 'self' ? [f] : hits.filter((h) => !h.out);
      for (const h of who) {
        addStatus(h, { id: a.status as StatusId, until: F.beat + a.beats, ...(a.amount ? { amount: a.amount } : {}) });
        if (a.status === 'stun') h.act = null;
        const p = this.unit(h);
        if (p) ev.notes.push({ to: refOf(h.kind, h.id), text: STATUS_TEXT[a.status as StatusId] || a.status, x: p.x, y: p.y });
      }
      return;
    }
    for (const h of hits) {
      const p = this.unit(h);
      if (!p || h.out) continue;
      const L = Math.max(dist(u, p), 0.001), ux = (p.x - u.x) / L, uy = (p.y - u.y) / L;
      for (let i = 0; i < a.cells * 2; i++) if (!this.moveUnit(p, p.x + ux * 0.5, p.y + uy * 0.5)) break;
      if (p.avatar) p.avatar.path = [];
      if (h.act?.phase === 'windup') { h.act = null; ev.notes.push({ to: refOf(h.kind, h.id), text: '被击退', x: p.x, y: p.y }); }
    }
  }

  // ---------- 结局 ----------
  unitDown(this: Town, F: Fight, h: Fighter, tu: Unit) {
    h.out = 'down';
    const byF = F.fighters.find((x) => sameUnit(x, h.lastHit));
    const by = this.unit(byF);
    if (tu.agent) {
      const x = tu.agent;
      if (by?.agent) return this.downed(x, by.agent, byF!.intent);
      x.body.hp = 5;
      x.body.conditions = [...new Set([...x.body.conditions, '重伤'])].slice(-5);
      addMemory(x, { t: this.t, type: 'event', text: `被${by?.name || '什么东西'}打倒了`, importance: 8 });
      this.log('combat', `🩸 ${x.name}被${by?.name || '什么东西'}打倒在地`, { agents: [x.id] });
      this.sendToClinic(x);
      return;
    }
    if (tu.avatar) {
      this.avatars.knockout(tu.avatar);
      this.log('combat', `💫 旅人「${tu.name}」被${by?.name || '打'}倒了`, {});
      return;
    }
    if (tu.threat) {
      // 流血等不经过 threats.hit 的伤害打死了威胁：照常结束事件（掉落交给打死它的居民）
      if (tu.threat.state !== 'gone') this.threats.end(tu.threat, 'slain', `${by?.name || '有人'}消灭了${tu.name}`, by?.agent || null);
      return;
    }
    if (tu.creature) {
      tu.creature.hp = 0;
      this.log('combat', `💨 ${tu.name}被${by?.name || '人'}打散了`, { agents: by?.agent ? [by.agent.id] : [] });
    }
  }

  fled(this: Town, f: Fighter, u: Unit, from: Unit) {
    if (u.agent) {
      u.agent.body.conditions = [...new Set([...u.agent.body.conditions, '受惊'])].slice(-5);
      addMemory(u.agent, { t: this.t, type: 'event', text: `被${from.name}打得逃走了`, importance: 7 });
    }
    if (u.creature) u.creature.fleeUntil = this.t + 30;
    this.log('combat', `🏃 ${u.name}从${from.name}手里逃走了`, { agents: [u.agent?.id, from.agent?.id].filter(Boolean) as string[] });
  }

  endFight(this: Town, F: Fight, text: string, ev: BeatEvents | null = null) {
    this.fights = (this.fights || []).filter((x) => x !== F);
    const names = F.fighters.map((x) => x.name || this.unit(x)?.name).filter(Boolean);
    for (const f of F.fighters) {
      const u = this.unit(f);
      if (!u?.agent) continue;
      const foes = F.fighters.filter((x) => x.side !== f.side).map((x) => x.name || this.unit(x)?.name).filter(Boolean);
      if (f.out !== 'down' && f.out !== 'fled' && foes.length) addMemory(u.agent, { t: this.t, type: 'event', text: `和${[...new Set(foes)].join('、')}打了一场`, importance: 6 });
      // 回到日程：下一帧重新决定去哪儿
      if (f.out !== 'down') u.agent.curKey = null;
    }
    if (text && names.length) this.log('combat', `${names.slice(0, 3).join('和')}${text}`, { agents: F.fighters.filter((x) => x.kind === 'agent').map((x) => x.id) });
    if (ev) ev.end = true;
    else this.emit('combat', { id: F.id, region: F.region, end: true, casts: [], fx: [], hits: [], notes: [] } satisfies BeatEvents);
  }

  /** 倒下：按攻击者的意图和分级决定结果（设计 §4.3 伤势阶梯） */
  downed(this: Town, x: LiveAgent, by: LiveAgent, intent: string) {
    x.body.hp = 5;
    addMemory(by, { t: this.t, type: 'event', text: `把${x.name}打倒了`, importance: 7 });
    for (const o of this.agents) if (o !== x && o !== by && this.near(o, x, 6)) addMemory(o, { t: this.t, type: 'event', text: `亲眼看见${by.name}把${x.name}打倒在地`, importance: 8 });
    if (intent === 'kill' && lethal(this.spec.meta.rating)) {
      const r = this.killAgent(x, { cause: `attack:${by.id}`, text: `${x.name}死在了${by.name}手里` });
      if (r === 'dead') return;
    }
    if (intent === 'capture') {
      x.captive = { by: by.id, since: Math.floor(this.t), until: this.t + CAPTIVE_MINUTES, at: by.home };
      x.body.conditions = [...new Set([...x.body.conditions, '被俘'])].slice(-5);
      this.insertEntry(x, { start: Math.floor(this.minute) + 1, end: Math.min(Math.floor(this.minute) + CAPTIVE_MINUTES, 23 * 60), location: by.home, activity: `被${by.name}关着`, emoji: '⛓️', src: 'commit' });
      this.log('combat', `⛓️ ${by.name}把${x.name}抓走了`, { agents: [x.id, by.id] });
      return;
    }
    x.body.conditions = [...new Set([...x.body.conditions, '重伤'])].slice(-5);
    this.log('combat', `🩸 ${x.name}被${by.name}打倒在地`, { agents: [x.id, by.id] });
    this.sendToClinic(x);
  }

  /** 每小时：被关着的人——时限到了，致死的分级下可能丧命，否则被放出来 */
  captiveTick(this: Town) {
    for (const x of [...this.agents]) {
      const c = x.captive;
      if (!c || this.t < c.until) continue;
      x.captive = null;
      x.body.conditions = x.body.conditions.filter((k) => k !== '被俘');
      const by = this.byId[c.by];
      if (lethal(this.spec.meta.rating) && by && this.agents.includes(by) && this.rng() < 0.5) {
        this.killAgent(x, { cause: `captive:${c.by}`, text: `没有人来救，${x.name}再也没能回来` });
        continue;
      }
      addMemory(x, { t: this.t, type: 'event', text: `被关了很久，终于逃了出来`, importance: 8 });
      this.log('combat', `🔓 ${x.name}逃了出来`, { agents: [x.id] });
    }
  }

  rescue(this: Town, a: LiveAgent, { target }: ActArgs) {
    const x = this.agents.find((o) => o.name === target || o.id === target || String(target).includes(o.name));
    if (!x?.captive) return { ok: false, reason: `${target}没有被关着` };
    if (a.locId !== x.captive.at && !this.near(a, x, 3)) return { ok: false, reason: `要到${this.locName(x.captive.at)}才能救人`, retry: true };
    const by = this.byId[x.captive.by];
    // 看守在场就得先打一架
    if (by && this.agents.includes(by) && this.near(by, a, 4)) {
      if (guardRepels(this.combatStats(a), this.combatStats(by), this.rng)) {
        this.woundAgent(a, 30, { cause: `guard:${by.id}` });
        this.log('combat', `⚔️ ${a.name}想救出${x.name}，被${by.name}打了回去`, { agents: [a.id, x.id, by.id] });
        return { ok: true };
      }
    }
    x.captive = null;
    x.body.conditions = x.body.conditions.filter((k) => k !== '被俘');
    x.schedule = x.schedule.filter((e) => e.emoji !== '⛓️');
    x.curKey = null;
    for (const [p, q] of [[x, a], [a, x]]) { const r = (p.relations[q.id] ||= { affinity: 0, note: '' }); r.affinity = clamp(r.affinity + 20, -100, 100); }
    addMemory(x, { t: this.t, type: 'event', text: `${a.name}把我救了出来`, importance: 9 });
    this.log('combat', `🔓 ${a.name}把${x.name}救了出来`, { agents: [a.id, x.id] });
    return { ok: true };
  }

  steal(this: Town, a: LiveAgent, { item, from }: ActArgs) {
    const b = this.findNear(a, from, 2);
    if (!b) return { ok: false, reason: `${from}不在身边`, retry: true };
    const no = this.mayHarm(a, b);
    if (no) return { ok: false, reason: no };
    if ((b.inventory[item] || 0) < 1) return { ok: false, reason: `${b.name}身上没有${this.spec.items[item]?.name || item}` };
    const caught = stealCaught(b.body.courage, a.body.courage, this.rng);
    if (caught) {
      const r = (b.relations[a.id] ||= { affinity: 0, note: '' });
      r.affinity = clamp(r.affinity - 25, -100, 100);
      r.note = `${a.name}想偷我的东西`;
      addMemory(b, { t: this.t, type: 'event', text: `抓到${a.name}想偷我的${this.spec.items[item]?.name || item}`, importance: 7 });
      this.log('combat', `🫳 ${a.name}想偷${b.name}的东西，被抓了个正着`, { agents: [a.id, b.id] });
      return { ok: true };
    }
    b.inventory[item] -= 1;
    if (!b.inventory[item]) delete b.inventory[item];
    a.inventory[item] = Math.min(99, (a.inventory[item] || 0) + 1);
    addMemory(a, { t: this.t, type: 'obs', text: `从${b.name}身上偷到了${this.spec.items[item]?.name || item}`, importance: 6 });
    this.log('combat', `🫳 ${b.name}身上少了点东西`, { agents: [b.id] });
    return { ok: true };
  }

  threaten(this: Town, a: LiveAgent, { target, demand }: ActArgs) {
    const b = this.findNear(a, target, 3);
    if (!b) return { ok: false, reason: `${target}不在身边`, retry: true };
    const no = this.mayHarm(a, b);
    if (no) return { ok: false, reason: no };
    const r = (b.relations[a.id] ||= { affinity: 0, note: '' });
    r.affinity = clamp(r.affinity - 15, -100, 100);
    b.body.courage = clamp(b.body.courage - 10, 0, 100);
    addMemory(b, { t: this.t, type: 'event', text: `${a.name}威胁我：${demand || '别多管闲事'}`, importance: 8 });
    this.say(a, String(demand || '你给我小心点。').slice(0, 30), 4000);
    this.log('combat', `😠 ${a.name}威胁了${b.name}`, { agents: [a.id, b.id] });
    return { ok: true };
  }

  // ---------- 居民与威胁 ----------
  hunt(this: Town, a: LiveAgent, { threat }: ActArgs) {
    const ts = this.threats;
    const p = posOf(this, a)!;
    const inst = ts?.find(threat);
    if (!inst) return { ok: false, reason: `找不到${threat}` };
    if (inst.region !== (p.region || 'town') || Math.hypot(inst.x - p.x, inst.y - p.y) > 5) return { ok: false, reason: `${inst.name}不在附近`, retry: true };
    const def = ts.def(inst);
    // 会死的威胁：打一场；杀不死的只会停顿一下（有 delay 对抗方式时）
    if (def?.mortal) {
      const r = this.engage(refOf('agent', a.id), refOf('threat', inst.id));
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true };
    }
    const s = this.combatStats(a);
    const dmg = ts.hit(inst, s.atk, s.tags, a);
    addMemory(a, { t: this.t, type: 'event', text: dmg ? `和${inst.name}交了手` : `对${inst.name}出手，却好像什么用也没有`, importance: 7 });
    return { ok: true };
  }

  // ---------- 玩家操控（游戏模式的旅人化身） ----------
  /**
   * 化身出招：skill 是 strike / dodge / 世界包 combat.avatarKit 里的能力；target 形如 "threat:t3"，不给时打身边最近的敌人。
   * 不在战斗里时先开打（residents：能不能对居民动手由调用方按身份判断后传入）
   */
  avatarAct(this: Town, uid: string, { skill, target, dir: rawDir }: { skill?: unknown; target?: unknown; dir?: unknown }, { residents = false } = {}) {
    // 闪避的方向（玩家按着的方向键）：单位向量
    const dv = Array.isArray(rawDir) ? rawDir.map(Number) : [];
    const dl = Math.hypot(dv[0] || 0, dv[1] || 0);
    const dir: [number, number] | null = dv.length === 2 && Number.isFinite(dl) && dl > 0.1 ? [dv[0]! / dl, dv[1]! / dl] : null;
    const v = this.avatars.mine(uid);
    if (!v) return { ok: false, reason: '你还没有在小镇里现身' };
    if ((v.downUntil || 0) > this.now()) return { ok: false, reason: '你倒下了，缓一缓' };
    const me = refOf('avatar', v.id);
    const sid = String(skill || 'strike');
    if (!this.skillsOf({ ...me, side: 0, intent: 'subdue', act: null, statuses: [], cds: {}, target: null }).some((s) => s.id === sid)) return { ok: false, reason: '没有这一招' };
    let F = this.fightOf(me);
    const want = parseRef(target);
    if (!F) {
      if (sid === 'dodge') { const u = this.unit(me)!; this.dodge(null, null, u, null, dir); this.emit('combat', { id: '', region: u.region, casts: [], fx: [{ by: me, skill: 'dodge', shape: 'single', range: 0, radius: 0, from: { x: u.x, y: u.y }, to: { x: u.x, y: u.y } }], hits: [], notes: [] }); return { ok: true }; }
      const foe = want ? this.avatarFoe(v, want, residents) : this.nearestFoe(v, residents);
      if (typeof foe === 'string') return { ok: false, reason: foe };
      if (!foe) return { ok: false, reason: '身边没有可以打的对手' };
      const r = this.engage(me, foe);
      if (!r.ok) return { ok: false, reason: r.reason };
      F = r.fight;
      const fu = this.unit(foe);
      if (fu?.agent) {
        const rel = ((fu.agent.travellers ||= {})[v.uid] ||= { affinity: 0, chats: 0 } as never) as { affinity: number };
        rel.affinity = clamp((rel.affinity || 0) - 40, -100, 100);
        addMemory(fu.agent, { t: this.t, type: 'event', text: `旅人${v.name}对我动手了`, importance: 8 });
      }
      this.log('combat', `⚔️ 旅人「${v.name}」向${fu?.name || '对手'}动手了`, { agents: fu?.agent ? [fu.agent.id] : [] });
    }
    const f = F.fighters.find((x) => !x.out && sameUnit(x, me))!;
    f.queued = { skill: sid, target: want && F.fighters.some((x) => !x.out && x.side !== f.side && sameUnit(x, want)) ? want : f.target, dir };
    return { ok: true, fight: F.id };
  }

  /** 化身能打谁：会死的威胁、敌对的生物；居民要 residents 为真（世界的创建者或管理员，且世界允许敌对） */
  avatarFoe(this: Town, v: Avatar, ref: UnitRef, residents: boolean): UnitRef | string | null {
    const u = this.unit(ref);
    if (!u || u.region !== v.region || Math.hypot(u.x - v.x, u.y - v.y) > 6) return null;
    if (ref.kind === 'avatar') return '不能对其他旅人动手';
    if (ref.kind === 'agent' && (!residents || !this.canBeHostile?.() || u.agent!.kind === 'creature')) return '你不能对这里的居民动手';
    return ref;
  }

  nearestFoe(this: Town, v: Avatar, residents: boolean): UnitRef | null {
    const cands: UnitRef[] = [
      ...this.threats.live().map((t) => refOf('threat', t.id)),
      ...this.creatures.list.map((c) => refOf('creature', c.id)),
      ...(residents && this.canBeHostile?.() ? this.agents.filter((a) => a.kind !== 'creature' && !a.inside).map((a) => refOf('agent', a.id)) : []),
    ];
    let best: UnitRef | null = null, bd = 6;
    for (const r of cands) {
      const u = this.unit(r);
      if (!u || u.region !== v.region) continue;
      const d = Math.hypot(u.x - v.x, u.y - v.y);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  /** Boss 的大血条用：名字、第几阶段 */
  bossView(this: Town, id: string) {
    const inst = this.threats.live().find((x) => x.id === id);
    const def = inst && this.threats.def(inst);
    if (!def || !(def.boss || def.phases?.length)) return {};
    return { boss: { name: def.name, emoji: def.emoji, phase: typeof inst!.phase === 'number' ? inst!.phase + 1 : 0, phases: def.phases?.length || 0 } };
  }

  /** 快照里的战斗：参战单位的血量、招式与读条、状态 */
  fightsView(this: Town) {
    return (this.fights || []).map((F) => ({
      id: F.id, region: F.region,
      fighters: F.fighters.filter((f) => !f.out).map((f) => {
        const u = this.unit(f);
        const s = f.act && this.skillsOf(f).find((x) => x.id === f.act!.skill);
        return {
          kind: f.kind, id: f.id, side: f.side, hp: Math.round(u?.hp ?? 0), maxHp: u?.maxHp ?? 100, ...(f.tactic ? { tactic: f.tactic } : {}),
          ...(f.act && s ? { act: { skill: s.id, name: s.name, emoji: s.emoji, phase: f.act.phase, p: f.act.phase === 'windup' && f.act.until > f.act.from ? +((F.beat - f.act.from) / (f.act.until - f.act.from)).toFixed(2) : 1, big: s.windup >= 3 } } : {}),
          ...(f.statuses.length ? { st: [...new Set(f.statuses.filter((x) => x.until > F.beat).map((x) => x.id))] } : {}),
          ...(f.kind === 'threat' ? this.bossView(f.id) : {}),
          ...(f.kind === 'avatar' ? { cds: Object.fromEntries(Object.entries(f.cds).filter(([, b]) => b > F.beat).map(([k, b]) => [k, +((b - F.beat) * BEAT).toFixed(1)])) } : {}),
        };
      }),
    }));
  }
}

const STATUS_TEXT: Record<StatusId, string> = { stun: '眩晕', root: '定身', shield: '护盾', haste: '加速', slow: '减速', bleed: '流血', weaken: '虚弱', guard: '架势', dodge: '闪避' };
const DIRV: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const facing = (u: Unit) => { const d = DIRV[u.avatar?.dir || 'down'] || [0, 1]; return { x: u.x + d[0] * 2, y: u.y + d[1] * 2 }; };
const KINDS: readonly string[] = ['agent', 'avatar', 'threat', 'creature'];
/** "threat:t3" → { kind, id } */
function parseRef(v: unknown): UnitRef | null {
  const m = /^([a-z]+):(.{1,40})$/.exec(String(v ?? ''));
  return m && KINDS.includes(m[1]!) ? { kind: m[1] as UnitKind, id: m[2]! } : null;
}
