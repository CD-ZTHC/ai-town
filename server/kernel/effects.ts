// 效果原语（设计文档 4.4）：AI 改变世界的「动词表」。能力、规则、剧情节拍最终都编译成这些原语。
// 每个原语：check(args, spec) 静态校验（返回错误文本或 null），apply(town, ctx, args) 在运行时执行。
// ctx：{ self, target, e, at: {x, y, inside}, source }，self / target / e 为居民对象（可能为空）。
import { parse, ExprError } from './expr.ts';
import { addMemory } from '../memory.ts';
import type { WorldSpec } from '../types/spec.ts';
import type { AgentLike, ThreatInstance, TownLike } from '../types/town.ts';

/** 效果参数：来自世界包、AI 或插件的数据，由各原语的 check() 在运行时逐项校验，所以静态上不约束字段 */
export type EffectArgs = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 位置：户外坐标，或所在建筑（入口坐标） */
export interface Pos {
  x: number;
  y: number;
  inside: string | null;
  region: string;
}

/** 效果执行的上下文 */
export interface EffectCtx {
  self?: AgentLike | null;
  target?: AgentLike | null;
  e?: AgentLike | null;
  at?: Pos | null;
  source?: string | null;
  /** 在威胁的规律里执行时：这个威胁 */
  threat?: ThreatInstance | null;
  [k: string]: unknown;
}

export interface EffectDef {
  /** 给 AI 看的写法说明（能力清单） */
  doc: string;
  /** 静态校验：返回错误文本或 null */
  check(a: EffectArgs, spec: WorldSpec): string | null;
  /** 运行时执行 */
  apply(town: TownLike, ctx: EffectCtx, a: EffectArgs): void;
  /** 由插件提供的效果：来源 */
  plugin?: string;
  /** 扩展注册的效果（plugin-host/registry 的 registerEffect） */
  ext?: boolean;
  source?: string;
}

// 表达式里可以调用的函数名（实现见 rules.js 的 exprEnv）
export const EXPR_FNS = new Set(['has', 'count', 'knows', 'hasCondition', 'nearStructure', 'nearAgents', 'min', 'max', 'abs', 'rand',
  // 黑暗叙事（设计 §4.1 行为原语、§4.4 负担值、§4.2 信念）：没有威胁的世界里也能用，只是多数时候为假
  'seen', 'near', 'heard', 'opened', 'entered', 'speaking', 'named', 'alone', 'asleep', 'night', 'marked', 'inZone', 'posture',
  'burden', 'anchors', 'believes', 'flag', 'hosts']);
// 表达式函数的说明（用于自动生成能力清单）
export const EXPR_FN_DOCS: Record<string, string> = {
  has: "has(e, '物品id', 数量=1) 身上是否有某物品", count: "count(e, '物品id') 物品数量", knows: "knows(e, '能力id') 是否会某能力",
  hasCondition: "hasCondition(e, '状态') 是否处于某状态", nearStructure: "nearStructure(e, '标签', 半径=3) 附近是否有带该标签的构筑物",
  nearAgents: 'nearAgents(e, 半径=3) 附近醒着的人数', min: 'min(a, b…)', max: 'max(a, b…)', abs: 'abs(x)', rand: 'rand() 0~1 随机数',
  seen: 'seen(e) 在威胁的规律里：e 看得见这个威胁（6 格内、没闭眼、没睡着）', near: 'near(e, 半径=3) 在威胁的规律里：e 离这个威胁不超过半径',
  heard: "heard(e, '声音id') e 最近 10 分钟内听到了某种声音（威胁发出的）", opened: 'opened(e) e 最近 10 分钟内开门进过屋',
  entered: "entered(e, '地点id') e 此刻在某地点", speaking: 'speaking(e) e 最近 2 分钟内在对话里说过话', named: 'named(e) e 最近 30 分钟内被人当面叫了名字',
  alone: 'alone(e) e 身边 4 格内没有醒着的人', asleep: 'asleep(e) e 在睡觉', night: 'night() 现在是夜里（20:00~05:00）',
  marked: 'marked(e) e 被这个威胁（不在威胁的规律里时：任何威胁）标记了', inZone: 'inZone(e) e 在这个威胁（或任何威胁）的区域里',
  posture: "posture(e, 'eyesClosed/silent/noOpen/stayLit/notAlone') e 正保持着某种禁忌姿态",
  burden: "burden(e, '负担id') e 的负担值", anchors: 'anchors(e, 好感阈值=50) e 身边好感达到阈值、还活着的人数',
  believes: "believes(e, '话题') e 对某个话题的确信度（0~1，没有这个看法时为 0）", flag: "flag('标记名') 世界标记是否为真", hosts: "hosts(e, '威胁id') e 身上寄宿着某个威胁",
};
// 扩展目录（server/ext/）注册的表达式函数实现：name → (helpers, ...args) => value
export const EXT_FNS: Record<string, (helpers: unknown, ...args: any[]) => unknown> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
export const STATS: readonly string[] = ['hp', 'stamina', 'courage'];
export const TARGETS: readonly string[] = ['self', 'target', 'e', 'nearby', 'all'];
export const VFX: readonly string[] = ['glow_ring', 'sparkle', 'heal', 'notes', 'burst', 'ripple'];
export const MAX_EFFECTS = 8;

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): boolean => num(v) && v >= lo && v <= hi;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function checkTarget(a: EffectArgs, allowed: readonly string[] = TARGETS): string | null {
  const t = a.target ?? 'self';
  if (!allowed.includes(t)) return `target 只能是 ${allowed.join('/')}`;
  if (a.radius != null && !inRange(a.radius, 1, 6)) return 'radius 应在 1~6';
  return null;
}

/** 位置：居民在室内时取建筑入口，并记下所在建筑 */
export function posOf(town: TownLike, a: AgentLike | null | undefined): Pos | null {
  if (!a) return null;
  if (a.inside) {
    const b = (town.worldOf?.(a.region) || town.world).buildings.find((x: { id: string }) => x.id === a.inside);
    if (b) return { x: b.x + b.w / 2, y: b.y + b.h - 1, inside: a.inside, region: a.region || 'town' };
  }
  return { x: a.x, y: a.y, inside: null, region: a.region || 'town' };
}

/** 附近的居民：同一建筑内，或都在户外且距离不超过 r 格。睡着的人不算。 */
export function agentsNear(town: TownLike, at: Pos | null | undefined, r = 3, except: AgentLike | null = null): AgentLike[] {
  if (!at) return [];
  return town.agents.filter((o: AgentLike) => o !== except && o.status !== 'sleeping' && (o.region || 'town') === (at.region || 'town') &&
    (at.inside ? o.inside === at.inside : !o.inside && Math.hypot(o.x - at.x, o.y - at.y) <= r));
}

/** 按效果参数里的 target / radius 解析出受影响的居民（扩展也可以复用） */
export function resolveTargets(town: TownLike, ctx: EffectCtx, a: EffectArgs): AgentLike[] {
  const t = a.target ?? 'self';
  if (t === 'self') return ctx.self ? [ctx.self] : [];
  if (t === 'target') return ctx.target ? [ctx.target] : [];
  if (t === 'e') return ctx.e?.kind === 'resident' ? [ctx.e] : [];
  if (t === 'nearby') return agentsNear(town, ctx.at, a.radius ?? 3, a.includeSelf ? null : ctx.self);
  if (t === 'all') return town.agents;
  return [];
}

const fill = (text: string, ctx: EffectCtx): string => text.replace(/\{self\}/g, ctx.self?.name || '有人').replace(/\{target\}/g, ctx.target?.name || '有人');

export const EFFECTS: Record<string, EffectDef> = {
  stat: {
    doc: '{"op":"stat","stat":"hp/stamina/courage","add":-30~30 或 "set":0~100,"target":"self/target/e/nearby/all","radius":1~6} 改变体力、勇气等',
    check(a) {
      if (!STATS.includes(a.stat)) return `stat 只能是 ${STATS.join('/')}`;
      if (a.add == null && a.set == null) return '需要 add 或 set';
      if (a.add != null && !inRange(a.add, -30, 30)) return 'add 应在 -30~30';
      if (a.set != null && !inRange(a.set, 0, 100)) return 'set 应在 0~100';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) {
        const stat = a.stat as 'hp' | 'stamina' | 'courage'; // check() 已限定在 STATS 之内
        const v = a.set != null ? a.set : (x.body[stat] ?? 0) + a.add;
        x.body[stat] = clamp(Math.round(v), 0, 100);
      }
    },
  },
  condition: {
    doc: '{"op":"condition","add":"≤6字" 或 "remove":"≤6字","target":…} 添加或移除状态（如 受惊、疲惫）',
    check(a) {
      if (!str(a.add, 6) && !str(a.remove, 6)) return '需要 add 或 remove（≤6字）';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) {
        const set = new Set(x.body.conditions);
        if (a.remove) set.delete(str(a.remove, 6));
        if (a.add) set.add(str(a.add, 6));
        x.body.conditions = [...set].slice(-5);
      }
    },
  },
  mood: {
    doc: '{"op":"mood","text":"两字","emoji":"一个emoji","target":…} 设置心情',
    check(a) { return !str(a.text, 6) ? 'text 不能为空（≤6字）' : checkTarget(a); },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) x.mood = { text: str(a.text, 6), emoji: str(a.emoji, 4) || x.mood.emoji };
    },
  },
  memory: {
    doc: '{"op":"memory","text":"≤80字，可用 {self} {target}","importance":1~8,"target":…} 写入记忆',
    check(a) {
      if (!str(a.text, 80)) return 'text 不能为空';
      if (a.importance != null && !inRange(a.importance, 1, 8)) return 'importance 应在 1~8';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) addMemory(x, { t: town.t, type: 'obs', text: fill(str(a.text, 80), ctx), importance: a.importance ?? 4 });
    },
  },
  belief: {
    doc: '{"op":"belief","about":"≤12字话题","claim":"≤40字看法","confidence":0~1,"target":…} 写入信念',
    check(a) {
      if (!str(a.about, 12) || !str(a.claim, 40)) return 'about / claim 不能为空';
      if (a.confidence != null && !inRange(a.confidence, 0, 1)) return 'confidence 应在 0~1';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) {
        const about = str(a.about, 12);
        x.beliefs = x.beliefs.filter((b) => b.about !== about);
        x.beliefs.push({ about, claim: fill(str(a.claim, 40), ctx), confidence: a.confidence ?? 0.6, source: ctx.self?.id || ctx.source || '', t: Math.floor(town.t) });
        if (x.beliefs.length > 20) x.beliefs.shift();
      }
    },
  },
  affinity: {
    doc: '{"op":"affinity","toward":"self/target","delta":-10~10,"target":…} 改变好感',
    check(a) {
      if (!['self', 'target'].includes(a.toward)) return 'toward 只能是 self/target';
      if (!inRange(a.delta, -10, 10)) return 'delta 应在 -10~10';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      const who = a.toward === 'self' ? ctx.self : ctx.target;
      if (!who) return;
      for (const x of resolveTargets(town, ctx, a)) {
        if (x === who) continue;
        const r = (x.relations[who.id] ||= { affinity: 0, note: '' });
        r.affinity = clamp(r.affinity + Math.round(a.delta), -100, 100);
      }
    },
  },
  giveItem: {
    doc: '{"op":"giveItem","item":"物品id","count":1~5,"target":…} 获得物品',
    check(a, spec) {
      if (!Object.hasOwn(spec.items, a.item)) return `未知物品：${a.item}`;
      if (a.count != null && !(Number.isInteger(a.count) && a.count >= 1 && a.count <= 5)) return 'count 应为 1~5 的整数';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) x.inventory[a.item] = Math.min(99, (x.inventory[a.item] || 0) + (a.count ?? 1));
    },
  },
  takeItem: {
    doc: '{"op":"takeItem","item":"物品id","count":1~5,"target":…} 失去物品',
    check(a, spec) { return EFFECTS.giveItem.check(a, spec); },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) {
        const left = (x.inventory[a.item] || 0) - (a.count ?? 1);
        if (left > 0) x.inventory[a.item] = left; else delete x.inventory[a.item];
      }
    },
  },
  flag: {
    doc: '{"op":"flag","name":"英文小写","value":布尔/数字/字符串} 设置世界标记',
    check(a) {
      if (!/^[a-z][a-z0-9_]{1,23}$/.test(a.name || '')) return 'name 不合法';
      if (!['boolean', 'number', 'string'].includes(typeof a.value)) return 'value 只能是布尔、数字或字符串';
      return null;
    },
    apply(town, ctx, a) { town.worldFlags[a.name] = typeof a.value === 'string' ? str(a.value, 24) : a.value; },
  },
  spawn: {
    doc: '{"op":"spawn","structure":"构筑物id","ttl":10~240,"target":"self/target"} 在身边生成构筑物',
    check(a, spec) {
      if (!Object.hasOwn(spec.structures, a.structure)) return `未知构筑物：${a.structure}`;
      if (a.ttl != null && !inRange(a.ttl, 10, 240)) return 'ttl 应在 10~240（游戏分钟）';
      return checkTarget(a, ['self', 'target']);
    },
    apply(town, ctx, a) {
      const who = (a.target ?? 'self') === 'target' ? ctx.target : ctx.self;
      const at = posOf(town, who) || ctx.at;
      if (!at) return;
      town.spawnStructure(a.structure, at, a.ttl ?? town.spec.structures[a.structure].ttl ?? 60, ctx);
    },
  },
  vfx: {
    doc: '{"op":"vfx","preset":"glow_ring/sparkle/heal/notes/burst/ripple","color":"#rrggbb","radius":0.5~6} 播放特效',
    check(a) {
      if (!VFX.includes(a.preset)) return `preset 只能是 ${VFX.join('/')}`;
      if (a.color != null && !COLOR_RE.test(a.color)) return 'color 应为 #rrggbb';
      if (a.radius != null && !inRange(a.radius, 0.5, 6)) return 'radius 应在 0.5~6';
      return checkTarget(a, ['self', 'target']);
    },
    apply(town, ctx, a) {
      const who = (a.target ?? 'self') === 'target' ? ctx.target : ctx.self;
      const at = posOf(town, who) || ctx.at;
      if (at) town.emit('vfx', { preset: a.preset, x: at.x, y: at.y, color: a.color || null, radius: a.radius ?? 2, region: at.region || 'town' });
    },
  },
  say: {
    doc: '{"op":"say","text":"≤40字","target":"self/target"} 说一句话（气泡）',
    check(a) { return !str(a.text, 40) ? 'text 不能为空（≤40字）' : checkTarget(a, ['self', 'target']); },
    apply(town, ctx, a) {
      const who = (a.target ?? 'self') === 'target' ? ctx.target : ctx.self;
      if (who && !who.convoId) town.say(who, fill(str(a.text, 40), ctx), 5000);
    },
  },
  log: {
    doc: '{"op":"log","text":"≤60字"} 在动态栏记一笔',
    check(a) { return !str(a.text, 60) ? 'text 不能为空（≤60字）' : null; },
    apply(town, ctx, a) { town.log('effect', fill(str(a.text, 60), ctx), { agents: [ctx.self?.id, ctx.target?.id].filter(Boolean) }); },
  },
  paramMod: {
    doc: '{"op":"paramMod","name":"参数名","mul":0.5~2 或 "add":-60~60,"ttl":10~600} 临时调整内核参数',
    check(a, spec) {
      if (!Object.hasOwn(spec.params, a.name)) return `未知参数：${a.name}`;
      if (a.mul == null && a.add == null) return '需要 mul 或 add';
      if (a.mul != null && !inRange(a.mul, 0.5, 2)) return 'mul 应在 0.5~2';
      if (a.add != null && !inRange(a.add, -60, 60)) return 'add 应在 -60~60';
      if (!inRange(a.ttl, 10, 600)) return 'ttl 应在 10~600（游戏分钟）';
      return null;
    },
    apply(town, ctx, a) { town.addParamMod({ name: a.name, mul: a.mul, add: a.add, until: town.t + a.ttl, source: ctx.source || '' }); },
  },
  grantAbility: {
    doc: '{"op":"grantAbility","ability":"能力id","target":…} 授予能力',
    check(a, spec) {
      if (!spec.abilities.some((x) => x.id === a.ability)) return `未知能力：${a.ability}`;
      return checkTarget(a);
    },
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.learnAbility(x, a.ability, ctx.self && ctx.self !== x ? `从${ctx.self.name}那里` : ''); },
  },
  // ---------- 黑暗叙事（设计 §4.1、§4.3、§4.4、§4.5、§4.10）：没有对应系统的世界里这些效果什么也不做 ----------
  kill: {
    doc: '{"op":"kill","target":"self/target/e","text":"≤40字，一笔带过的描写，可用 {self}"} 让人死去（分级不允许、死亡预算用完或有主角光环时降为重伤）',
    check(a) { return a.text != null && !str(a.text, 40) ? 'text 过长' : checkTarget(a, ['self', 'target', 'e']); },
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.killAgent?.(x, { cause: ctx.source || '', text: a.text ? fill(str(a.text, 40), { ...ctx, self: x }) : '', threat: ctx.threat }); },
  },
  wound: {
    doc: '{"op":"wound","amount":5~100,"target":…} 受伤（hp 降到 30 以下为重伤，送去休养）',
    check(a) { return !inRange(a.amount, 5, 100) ? 'amount 应在 5~100' : checkTarget(a); },
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.woundAgent?.(x, a.amount, { cause: ctx.source || '' }); },
  },
  heal: {
    doc: '{"op":"heal","amount":5~100,"target":…} 治疗伤势',
    check(a) { return !inRange(a.amount, 5, 100) ? 'amount 应在 5~100' : checkTarget(a); },
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.healAgent?.(x, a.amount); },
  },
  casualties: {
    doc: '{"op":"casualties","min":0~50,"max":0~50,"text":"≤30字"} 当地的群众伤亡（只记数字）',
    check(a) { return !(inRange(a.min, 0, 50) && inRange(a.max, a.min, 50)) ? 'min / max 应在 0~50' : a.text != null && !str(a.text, 30) ? 'text 过长' : null; },
    apply(town, ctx, a) { town.casualties?.(ctx.at, a.min + Math.floor(town.rng() * (a.max - a.min + 1)), { cause: ctx.source || '', text: str(a.text, 30) }); },
  },
  clue: {
    doc: '{"op":"clue","kind":"rule/next_victim/origin","threat":"威胁id(可选)","target":…} 得到一条关于威胁的线索（规律 / 下一个受害者 / 来历）',
    check(a, spec) {
      if (!['rule', 'next_victim', 'origin'].includes(a.kind)) return 'kind 只能是 rule / next_victim / origin';
      if (a.threat != null && !Object.hasOwn(spec.threats || {}, a.threat)) return `未知威胁：${a.threat}`;
      return checkTarget(a);
    },
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.threats?.giveClue(x, a.kind, a.threat || ctx.threat?.type || null, ctx as { confidence?: number }); },
  },
  burden: {
    doc: '{"op":"burden","id":"负担id","amount":-100~100 或 "freeze":10~1440,"target":…} 改变或冻结负担值',
    check(a, spec) {
      if (!Object.hasOwn(spec.burdens || {}, a.id)) return `未知负担值：${a.id}`;
      if (a.amount == null && a.freeze == null) return '需要 amount 或 freeze';
      if (a.amount != null && !inRange(a.amount, -100, 100)) return 'amount 应在 -100~100';
      if (a.freeze != null && !inRange(a.freeze, 10, 1440)) return 'freeze 应在 10~1440';
      return checkTarget(a);
    },
    apply(town, ctx, a) {
      for (const x of resolveTargets(town, ctx, a)) {
        if (a.freeze != null) (((x as AgentLike & { burdenFreeze?: Record<string, number> }).burdenFreeze ||= {})[a.id] = town.t + a.freeze);
        if (a.amount != null) town.addBurden?.(x, a.id, a.amount);
      }
    },
  },
  spawnThreat: {
    doc: '{"op":"spawnThreat","threat":"威胁id" 或 "from":"host","target":"self/target"} 在某人身边出现一个威胁；from 为 host 时，是这个人身上寄宿的威胁脱出',
    check(a, spec) {
      if (a.from === 'host') return checkTarget(a, ['self', 'target']);
      if (!Object.hasOwn(spec.threats || {}, a.threat)) return `未知威胁：${a.threat}`;
      return checkTarget(a, ['self', 'target']);
    },
    apply(town, ctx, a) {
      const who = (a.target ?? 'self') === 'target' ? ctx.target : ctx.self;
      if (a.from === 'host') { if (who) town.threats?.releaseHosted(who); return; }
      const at = posOf(town, who) || ctx.at;
      if (at) town.threats?.spawn(a.threat, { at, cause: ctx.source || '' });
    },
  },
  host: {
    doc: '{"op":"host","threat":"威胁id","target":…} 让某人成为某个威胁的宿主（寄宿后获得它的能力，也背上它的负担值）',
    check(a, spec) { return !spec.threats?.[a.threat]?.hostable ? `不是可寄宿的威胁：${a.threat}` : checkTarget(a); },
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.hostThreat?.(x, a.threat, ctx.threat?.type === a.threat ? ctx.threat : null); },
  },
  suppress: {
    doc: '{"op":"suppress","power":1~10,"minutes":5~240,"radius":1~8} 压制身边的威胁：强度够的话，它在这段时间里不能移动，规律也不生效',
    check(a) { return !(inRange(a.power, 1, 10) && inRange(a.minutes, 5, 240) && inRange(a.radius ?? 4, 1, 8)) ? 'power 1~10、minutes 5~240、radius 1~8' : null; },
    apply(town, ctx, a) { town.threats?.suppressNear(posOf(town, ctx.self) || ctx.at, a.power, a.minutes, a.radius ?? 4, ctx.self); },
  },
  damage: {
    doc: '{"op":"damage","amount":1~100,"tags":["弱点标签"],"radius":1~8} 攻击身边会死的威胁（杀不死的威胁只会停顿一会儿）',
    check(a) { return !(inRange(a.amount, 1, 100) && inRange(a.radius ?? 3, 1, 8)) ? 'amount 1~100、radius 1~8' : a.tags != null && !Array.isArray(a.tags) ? 'tags 应为数组' : null; },
    apply(town, ctx, a) { town.threats?.damageNear(posOf(town, ctx.self) || ctx.at, a.amount, a.tags || [], a.radius ?? 3, ctx.self); },
  },
};

/** 校验一组效果，返回错误文本或 null */
export function checkEffects(list: unknown, spec: WorldSpec): string | null {
  if (!Array.isArray(list) || !list.length) return 'effects 至少需要一个效果';
  if (list.length > MAX_EFFECTS) return `effects 最多 ${MAX_EFFECTS} 个`;
  for (const [i, ef] of list.entries()) {
    if (!ef || typeof ef !== 'object' || !Object.hasOwn(EFFECTS, ef.op ?? '')) return `effects[${i}]：未知效果 ${ef?.op}`;
    const e = EFFECTS[ef.op]!.check(ef, spec);
    if (e) return `effects[${i}]（${ef.op}）：${e}`;
  }
  return null;
}

export function checkExpr(src: unknown): string | null {
  try { parse(src, EXPR_FNS); return null; } catch (e) { return e instanceof ExprError ? `表达式错误：${e.message}` : String((e as Error).message); }
}

/** 依次执行效果；单个效果出错不影响其他效果 */
export function runEffects(town: TownLike, ctx: EffectCtx, list: EffectArgs[]): void {
  for (const ef of list.slice(0, MAX_EFFECTS)) {
    try { EFFECTS[ef.op]?.apply(town, ctx, ef); } catch (e) { console.warn(`[effect] ${ef.op} 失败：`, (e as Error).message); }
  }
}
