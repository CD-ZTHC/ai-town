// 战斗与敌对行动（黑暗叙事设计 §4.3 的 slay、§4.9）：居民之间的攻击、偷窃、威胁、俘虏与营救，以及居民与会死的威胁交手。
// 按规则逐回合结算（每游戏分钟一回合），不调用 LLM。
// 规则（属性、能否动手、伤害、逃跑、偷窃与营救的检定）是下面只依赖显式输入的函数（重构方案 P6 第三步），
// 可以不建小镇单独测试（test/combat-rules.test.ts）；Town 上的方法（Combat mixin）负责找人、记日志、写记忆等副作用。
import { addMemory } from '../memory.ts';
import { posOf } from '../kernel/effects.ts';
import { lethal } from '../kernel/ratings.ts';
import { clamp } from './util.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { ActArgs, Fight } from '../types/town.ts';
import type { WorldSpec } from '../types/spec.ts';

const MAX_ROUNDS = 12;
const HATE = -40; // 好感低于它才会动手
const CAPTIVE_MINUTES = 360;

// ---------- 规则（只依赖显式输入） ----------
type Rand = () => number;
/** 战斗用到的居民字段 */
type Fighter = Pick<LiveAgent, 'name' | 'body' | 'inventory' | 'combat'>;
export interface Stats { atk: number; def: number; tags: string[] }

/** 属性：基础值 + 人设里的 combat + 装备 */
export function computeStats(a: Fighter, items: WorldSpec['items']): Stats {
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

/** 一次出手的伤害（至少 1）：攻击 ×（0.8~1.2 的浮动）− 防御的一半 */
export const blow = (atk: number, def: number, rng: Rand): number => Math.max(1, Math.round(atk * (0.8 + rng() * 0.4) - def * 0.5));

/** 互殴一回合：先算 a 打 b、再算 b 打 a（随机数的取用顺序固定） */
export function exchange(sa: Stats, sb: Stats, rng: Rand): { hitA: number; hitB: number } {
  const hitB = blow(sa.atk, sb.def, rng);
  const hitA = blow(sb.atk, sa.def, rng);
  return { hitA, hitB };
}

/** 撑不住（0 < 血量 < 30）又不够勇敢（< 50）的一方逃跑：先看 b 再看 a；没有人逃返回 null */
export function whoFlees<T extends Fighter>(a: T, b: T): T | null {
  for (const x of [b, a]) if (x.body.hp > 0 && x.body.hp < 30 && x.body.courage < 50) return x;
  return null;
}

/** 偷窃被抓：基础 40%，失主比小偷越勇敢越容易被抓 */
export const stealCaught = (victimCourage: number, thiefCourage: number, rng: Rand): boolean => rng() < 0.4 + (victimCourage - thiefCourage) / 200;

/** 救人时看守在场：救人的一方掷骰输了就被打回去（先掷救人者、再掷看守） */
export const guardRepels = (rescuer: Stats, guard: Stats, rng: Rand): boolean => rescuer.atk + rng() * 6 < guard.atk + rng() * 6;

// ---------- Town 上的接口（找人、记日志、写记忆等副作用） ----------
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

  // ---------- 居民之间 ----------
  attack(this: Town, a: LiveAgent, { target, intent = 'subdue' }: ActArgs) {
    const b = this.findNear(a, target, 3);
    if (!b) return { ok: false, reason: `${target}不在身边`, retry: true };
    const no = this.mayHarm(a, b, intent);
    if (no) return { ok: false, reason: no };
    const f = (this.fights ||= []);
    if (f.some((x) => [x.a, x.b].includes(a.id) || [x.a, x.b].includes(b.id))) return { ok: false, reason: '已经打起来了' };
    f.push({ id: `f${++this.seq}`, a: a.id, b: b.id, intent, round: 0 });
    const r = (b.relations[a.id] ||= { affinity: 0, note: '' });
    r.affinity = clamp(r.affinity - 40, -100, 100);
    r.note = `${a.name}对我动手了`;
    this.say(a, intent === 'kill' ? '……' : '别怪我！', 3000);
    this.log('combat', `⚔️ ${a.name}向${b.name}动手了`, { agents: [a.id, b.id] });
    return { ok: true };
  }

  /** 每游戏分钟：结算进行中的打斗 */
  combatTick(this: Town) {
    const minute = Math.floor(this.t);
    if (this.fightMinute === minute || !this.fights?.length) return;
    this.fightMinute = minute;
    for (const f of [...this.fights]) this.round(f);
  }

  round(this: Town, f: Fight) {
    const a = this.byId[f.a], b = this.byId[f.b];
    const end = (text: string | null, extra = {}) => { this.fights = this.fights.filter((x) => x !== f); if (text) this.log('combat', text, { agents: [f.a, f.b], ...extra }); };
    if (!a || !b || !this.agents.includes(a) || !this.agents.includes(b) || !this.near(a, b, 4)) return end(a && b ? `${a.name}和${b.name}分开了` : '');
    f.round++;
    const { hitA, hitB } = exchange(this.combatStats(a), this.combatStats(b), this.rng);
    b.body.hp = Math.max(0, b.body.hp - hitB);
    a.body.hp = Math.max(0, a.body.hp - hitA);
    // 撑不住、又不够勇敢的一方逃跑
    const x = whoFlees(a, b);
    if (x) {
      const y = x === a ? b : a;
      x.body.conditions = [...new Set([...x.body.conditions, '受惊'])].slice(-5);
      addMemory(x, { t: this.t, type: 'event', text: `被${y.name}打得逃走了`, importance: 7 });
      return end(`🏃 ${x.name}从${y.name}手里逃走了`);
    }
    const down = b.body.hp <= 0 ? [b, a] : a.body.hp <= 0 ? [a, b] : null;
    if (down) { end(''); this.downed(down[0], down[1], down[1] === a ? f.intent : 'subdue'); return; }
    if (f.round >= MAX_ROUNDS) return end(`${a.name}和${b.name}打得筋疲力尽，各自散了`);
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
    const s = this.combatStats(a);
    const dmg = ts.hit(inst, s.atk, s.tags, a);
    const def = ts.def(inst);
    // 会死的威胁会还手
    if (def?.mortal && inst.hp! > 0 && def.atk) this.woundAgent(a, blow(def.atk, s.def, this.rng), { cause: `threat:${inst.type}` });
    addMemory(a, { t: this.t, type: 'event', text: dmg ? `和${inst.name}交了手` : `对${inst.name}出手，却好像什么用也没有`, importance: 7 });
    return { ok: true };
  }
}
