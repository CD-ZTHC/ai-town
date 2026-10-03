// 即时战斗的规则（设计 docs/design/combat.md §3）：只依赖显式输入的函数，不建小镇也能测试（test/fight-rules.test.ts）。
// 战斗按「拍」推进（BEAT 秒一拍）；每个战斗单位同一时间只做一件事：蓄力 → 生效 → 硬直。
import type { Ability } from '../types/spec.ts';

export const BEAT = 0.25; // 秒
export const MAX_BEATS = 240; // 一场最多打一分钟
export const MAX_FIGHTS = 6; // 每个世界同时进行的战斗
export const STEP = 0.9; // 速度为 1 时每拍移动的格数
export const INTERRUPT = 0.15; // 蓄力时受到的单次伤害达到最大血量的这个比例就被打断

export type UnitKind = 'agent' | 'avatar' | 'threat' | 'creature';
export interface UnitRef { kind: UnitKind; id: string }
export const sameUnit = (a: UnitRef | null | undefined, b: UnitRef | null | undefined): boolean => Boolean(a && b && a.kind === b.kind && a.id === b.id);
export const unitKey = (u: UnitRef): string => `${u.kind}:${u.id}`;

export const STATUS_IDS = ['stun', 'root', 'shield', 'haste', 'slow', 'bleed', 'weaken', 'guard', 'dodge'] as const;
export type StatusId = (typeof STATUS_IDS)[number];
export interface Status { id: StatusId; until: number; amount?: number }

/** 正在出的招；aim：出招方向（单位向量，开始蓄力时定下，之后不变——这样能被躲开） */
export interface Action {
  skill: string;
  phase: 'windup' | 'recover';
  /** 这一阶段结束的拍数 */
  until: number;
  /** 蓄力开始的拍数（前端画读条） */
  from: number;
  target: UnitRef | null;
  aim?: { x: number; y: number } | null;
}

export interface Fighter extends UnitRef {
  /** 开打时的名字（单位离场之后也能写日志、记忆） */
  name?: string;
  side: 0 | 1;
  /** subdue / kill / capture：打倒对方之后怎么办 */
  intent: string;
  act: Action | null;
  statuses: Status[];
  /** 招式 → 冷却结束的拍数 */
  cds: Record<string, number>;
  target: UnitRef | null;
  /** 离场：down 被打倒、fled 逃走、gone 不在了（走远、离开世界） */
  out?: 'down' | 'fled' | 'gone';
  /** 最后打中它的人（结局用） */
  lastHit?: UnitRef;
  /** 玩家操控（化身）：等着执行的指令 */
  queued?: { skill: string; target: UnitRef | null; dir?: [number, number] | null; aim?: { x: number; y: number } | null } | null;
  /** 旅人能不能打居民（世界创建者 / 管理员，且世界允许敌对）：无锁定时判定区域里的居民才算敌人 */
  residents?: boolean;
  /** 正在执行的指令带的方向（闪避） */
  queuedDir?: [number, number] | null;
  /** 战术（C3：开打时模型或兜底规则给出）与要保护的人 */
  tactic?: Tactic;
  protect?: UnitRef | null;
  /** 已经说过的关键台词（low 濒死） */
  said?: string[];
}

export interface Fight {
  id: string;
  beat: number;
  acc: number;
  region: string;
  fighters: Fighter[];
  /** 已经考虑过要不要加入的旁观者（居民 id） */
  seen?: string[];
  /** 旅人对空出招时临时开的「一个人的战斗」：招式落空就悄悄结束，打中谁就把谁拉进来 */
  solo?: boolean;
  /** 飞行中的弹道 */
  projectiles?: Projectile[];
}

// ---------- 战术（C3） ----------
export const TACTICS = ['aggressive', 'defensive', 'protect', 'flee'] as const;
export type Tactic = (typeof TACTICS)[number];
export const TACTIC_TEXT: Record<Tactic, string> = { aggressive: '猛攻', defensive: '稳守', protect: '护着自己人', flee: '找机会脱身' };

/** 没有模型时的战术：血少又胆小就想跑，胆小或吃亏就守，身边有自己人挨打就护着，其余猛攻 */
export function fallbackTactic({ hp, maxHp, courage, villain, allyHurt }: { hp: number; maxHp: number; courage: number; villain: boolean; allyHurt: boolean }): Tactic {
  const r = hp / Math.max(1, maxHp);
  if (r < 0.35 && courage < 40) return 'flee';
  if (allyHurt && !villain) return 'protect';
  if (courage < 45 || r < 0.5) return 'defensive';
  return 'aggressive';
}

/** 没有模型时的台词 */
export function fallbackLine(kind: 'start' | 'low' | 'join', { tactic = 'aggressive' as Tactic, foe = '', ally = '', villain = false }, rng: () => number): string {
  const pick = (xs: string[]) => xs[Math.floor(rng() * xs.length)]!;
  if (kind === 'join') return pick([`别碰${ally}！`, `${ally}，我来了！`, '住手！']);
  if (kind === 'low') return villain ? pick(['……还没完。', '你以为这就赢了？']) : pick(['撑住……', '我还能打。', '不行了……得想办法。']);
  if (tactic === 'flee') return pick(['惹不起，我走。', '别过来！']);
  if (tactic === 'defensive') return pick(['我不想打，但也不会让你。', '来吧。']);
  return villain ? pick(['碍事的家伙。', '自找的。']) : foe ? pick([`${foe}，冲我来！`, '看招！']) : '看招！';
}

/** 招式（内建招式与能力统一成这个形状） */
export interface Skill {
  id: string;
  name: string;
  emoji: string;
  windup: number;
  recover: number;
  range: number;
  shape: 'single' | 'circle' | 'line' | 'cone';
  radius: number;
  cd: number;
  /** 打分用：damage 伤害、control 控制、heal 治疗、guard 护身、move 位移 */
  role: 'damage' | 'control' | 'heal' | 'guard' | 'move';
  /** 普攻的倍率（能力的伤害写在效果里） */
  power?: number;
  ability?: Ability;
}

export const SHAPES = ['single', 'circle', 'line', 'cone'] as const;

/** 内建招式：普攻（所有单位都有）、闪避（化身） */
export const STRIKE: Skill = { id: 'strike', name: '普攻', emoji: '👊', windup: 1, recover: 3, range: 1.6, shape: 'single', radius: 0, cd: 0, role: 'damage', power: 1 };
export const DODGE: Skill = { id: 'dodge', name: '闪避', emoji: '💨', windup: 0, recover: 1, range: 0, shape: 'single', radius: 0, cd: 10, role: 'move' };
export const DODGE_CELLS = 2.5;
export const DODGE_BEATS = 3;

/** 能力 → 招式（没有 combat 块的能力不能在战斗里用） */
export function abilitySkill(ab: Ability): Skill | null {
  const c = ab.combat;
  if (!c) return null;
  const ops = (ab.effects || []).map((e) => e.op);
  const role: Skill['role'] = ops.includes('strike') || ops.includes('damage') ? (ops.includes('status') || ops.includes('knockback') ? 'control' : 'damage')
    : ops.includes('heal') ? 'heal' : ops.includes('status') ? 'guard' : 'damage';
  return {
    id: ab.id, name: ab.name, emoji: ab.emoji || '✨', ability: ab, role,
    windup: c.windup ?? 2, recover: c.recover ?? 3, range: c.range ?? (ab.target === 'agent' ? 3 : 1.6),
    shape: c.shape || (ab.target === 'area' ? 'circle' : 'single'), radius: c.radius ?? (ab.target === 'area' ? 2.5 : 0), cd: c.cd ?? 12,
  };
}

/** 能力 combat 块的校验 */
export function checkCombatBlock(c: unknown): string | null {
  if (c == null) return null;
  if (typeof c !== 'object') return 'combat 应为对象';
  const x = c as Record<string, unknown>;
  const range = (k: string, lo: number, hi: number) => x[k] == null || (typeof x[k] === 'number' && Number.isFinite(x[k]) && (x[k] as number) >= lo && (x[k] as number) <= hi);
  if (!range('windup', 0, 12)) return 'combat.windup 应在 0~12（拍）';
  if (!range('recover', 0, 20)) return 'combat.recover 应在 0~20（拍）';
  if (!range('range', 1, 8)) return 'combat.range 应在 1~8';
  if (!range('radius', 0, 6)) return 'combat.radius 应在 0~6';
  if (!range('cd', 0, 400)) return 'combat.cd 应在 0~400（拍）';
  if (x.shape != null && !SHAPES.includes(x.shape as never)) return `combat.shape 只能是 ${SHAPES.join('/')}`;
  return null;
}

// ---------- 状态 ----------
export const hasStatus = (f: Pick<Fighter, 'statuses'>, id: StatusId, beat: number): boolean => f.statuses.some((s) => s.id === id && s.until > beat);
export const statusAmount = (f: Pick<Fighter, 'statuses'>, id: StatusId, beat: number): number => f.statuses.filter((s) => s.id === id && s.until > beat).reduce((n, s) => n + (s.amount || 0), 0);

/** 挂状态：同种状态取更晚的结束时间、更大的数值（护盾叠加） */
export function addStatus(f: Pick<Fighter, 'statuses'>, s: Status): void {
  const old = f.statuses.find((x) => x.id === s.id);
  if (!old) { f.statuses.push({ ...s }); return; }
  old.until = Math.max(old.until, s.until);
  old.amount = s.id === 'shield' ? (old.amount || 0) + (s.amount || 0) : Math.max(old.amount || 0, s.amount || 0);
}

/** 状态修正后的属性 */
export interface Stats { atk: number; def: number; spd: number; tags: string[] }
export function effectiveStats(base: Stats, f: Pick<Fighter, 'statuses'>, beat: number): Stats {
  let { atk, def, spd } = base;
  if (hasStatus(f, 'weaken', beat)) atk *= 0.7;
  def += statusAmount(f, 'guard', beat);
  if (hasStatus(f, 'haste', beat)) spd *= 1.5;
  if (hasStatus(f, 'slow', beat)) spd *= 0.6;
  return { atk, def, spd, tags: base.tags };
}

/** 伤害：攻击 ×（0.85~1.15 浮动）×（弱点 1.5）− 防御的一半；暴击 ×1.6（10%）。至少 1 */
export function damageRoll(atk: number, def: number, rng: () => number, { weak = false, power = 1, add = 0 } = {}): { dmg: number; crit: boolean } {
  const crit = rng() < 0.1;
  const raw = (atk * power + add) * (0.85 + rng() * 0.3) * (weak ? 1.5 : 1) * (crit ? 1.6 : 1) - def * 0.5;
  return { dmg: Math.max(1, Math.round(raw)), crit };
}

/** 护盾先吸收：返回扣血的部分，并扣减护盾 */
export function absorb(f: Pick<Fighter, 'statuses'>, dmg: number, beat: number): number {
  for (const s of f.statuses) {
    if (s.id !== 'shield' || s.until <= beat || !s.amount) continue;
    const take = Math.min(s.amount, dmg);
    s.amount -= take;
    dmg -= take;
  }
  f.statuses = f.statuses.filter((s) => s.id !== 'shield' || (s.amount || 0) > 0);
  return dmg;
}

// ---------- 几何 ----------
interface P { x: number; y: number }
export const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);

/** p 是否在招式的作用范围里：from 出招的位置，to 瞄准的位置 */
export function inShape(skill: Pick<Skill, 'shape' | 'range' | 'radius'>, from: P, to: P, p: P): boolean {
  const d = dist(from, p);
  switch (skill.shape) {
    case 'circle': return d <= Math.max(skill.radius, 1);
    case 'line': {
      const L = Math.max(dist(from, to), 0.001), ux = (to.x - from.x) / L, uy = (to.y - from.y) / L;
      const along = (p.x - from.x) * ux + (p.y - from.y) * uy;
      const off = Math.abs((p.x - from.x) * uy - (p.y - from.y) * ux);
      return along >= 0 && along <= skill.range + 0.5 && off <= Math.max(skill.radius, 0.8);
    }
    case 'cone': {
      if (d > skill.range + 0.5) return false;
      if (d < 0.5) return true;
      const a1 = Math.atan2(to.y - from.y, to.x - from.x), a2 = Math.atan2(p.y - from.y, p.x - from.x);
      const diff = Math.abs(((a2 - a1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      return diff <= Math.PI / 4;
    }
    default: {
      // single（无锁定，docs/design/realtime.md §5.2）：面前的一小段弧（近战挥砍）
      if (d > skill.range + 0.4) return false;
      if (d < 0.5) return true;
      const a1 = Math.atan2(to.y - from.y, to.x - from.x), a2 = Math.atan2(p.y - from.y, p.x - from.x);
      return Math.abs(((a2 - a1 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) <= ARC;
    }
  }
}

const ARC = (35 / 180) * Math.PI;
/** 单位向量；长度为 0 时返回 null */
export function unitVec(x: number, y: number): { x: number; y: number } | null {
  const L = Math.hypot(x, y);
  return Number.isFinite(L) && L > 1e-6 ? { x: x / L, y: y / L } : null;
}
/** 弹道（line 招式，§5.2）：每拍飞多少格 */
export const PROJECTILE_STEP = 2.5;
/** 弹道：每拍推进一次，沿途每 1/4 格检查一次 */
export interface Projectile { id: string; by: UnitRef; side: 0 | 1; skill: string; x: number; y: number; dx: number; dy: number; left: number; width: number }

// ---------- 规则 AI ----------
export interface Situation {
  /** 自己 */
  me: P & { hp: number; maxHp: number };
  /** 当前目标（离自己最近或已锁定的敌人） */
  foe: P & { hp: number; maxHp: number };
  /** 所有还在场的敌人位置 */
  foes: P[];
  /** 已经挂着的状态 */
  statuses: Status[];
  beat: number;
  tactic?: Tactic;
}

/** 给一个可用的招式打分（越高越想用）；不想用返回 -Infinity */
export function scoreSkill(s: Skill, sit: Situation, rng: () => number): number {
  const hpRatio = sit.me.hp / Math.max(1, sit.me.maxHp);
  const d = dist(sit.me, sit.foe);
  let score: number;
  switch (s.role) {
    case 'heal': score = hpRatio < 0.5 ? 4 - hpRatio * 2 : -Infinity; break;
    case 'guard': score = hpRatio < 0.7 && !sit.statuses.some((x) => x.until > sit.beat && (x.id === 'shield' || x.id === 'guard')) ? 2.5 : 0.5; break;
    case 'move': score = -Infinity; break;
    case 'control': score = 2.6; break;
    default: score = s.id === 'strike' ? 1 : 2 + (s.windup >= 4 ? 0.5 : 0);
  }
  if (s.shape === 'circle' || s.shape === 'cone' || s.shape === 'line') {
    const hits = sit.foes.filter((p) => inShape(s, sit.me, sit.foe, p)).length;
    score += hits >= 2 ? 1 : 0;
    if (s.shape === 'circle' && d > Math.max(s.radius, 1)) score -= 1; // 范围技要靠近才有用
  }
  // 够不着的招要先走过去：远程招式在距离上占优
  if (d > s.range && s.role !== 'heal' && s.role !== 'guard') score -= 0.5;
  // 战术：猛攻偏向伤害与控制，稳守 / 护人偏向护身与治疗
  if (sit.tactic === 'aggressive' && (s.role === 'damage' || s.role === 'control')) score += 0.6;
  if ((sit.tactic === 'defensive' || sit.tactic === 'protect') && (s.role === 'guard' || s.role === 'heal') && score > -Infinity) score += 1.2;
  return score + rng() * 0.3;
}

/** 选一个招式（kit 里已经过滤掉冷却中、付不起的） */
export function chooseSkill(kit: Skill[], sit: Situation, rng: () => number): Skill | null {
  let best: Skill | null = null, bestScore = -Infinity;
  for (const s of kit) {
    const v = scoreSkill(s, sit, rng);
    if (v > bestScore) { best = s; bestScore = v; }
  }
  return best;
}

/** 撑不住（血量 < 30%；稳守时 < 45%）又不够勇敢（< 50）就逃；想脱身的人血量过半就走；威胁从不逃跑 */
export function wantsFlee(kind: UnitKind, hp: number, maxHp: number, courage: number, tactic?: Tactic): boolean {
  if (kind === 'threat' || kind === 'avatar' || hp <= 0) return false;
  const r = hp / Math.max(1, maxHp);
  if (tactic === 'flee') return r < 0.9;
  return r < (tactic === 'defensive' ? 0.45 : 0.3) && courage < 50;
}

/** 朝目标走一步（返回新位置，不检查地形） */
export function stepToward(from: P, to: P, cells: number, stopAt: number): P {
  const d = dist(from, to);
  if (d <= stopAt) return { x: from.x, y: from.y };
  const k = Math.min(cells, d - stopAt) / d;
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}
