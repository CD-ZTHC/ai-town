// 效果原语（设计文档 4.4）：AI 改变世界的「动词表」。能力、规则、剧情节拍最终都编译成这些原语。
// 每个原语：check(args, spec) 静态校验（返回错误文本或 null），apply(town, ctx, args) 在运行时执行。
// ctx：{ self, target, e, at: {x, y, inside}, source }，self / target / e 为居民对象（可能为空）。
import { parse, ExprError } from './expr.js';
import { addMemory } from '../memory.js';

// 表达式里可以调用的函数名（实现见 rules.js 的 exprEnv）
export const EXPR_FNS = new Set(['has', 'count', 'knows', 'hasCondition', 'nearStructure', 'nearAgents', 'min', 'max', 'abs', 'rand']);
// 表达式函数的说明（用于自动生成能力清单）
export const EXPR_FN_DOCS = {
  has: "has(e, '物品id', 数量=1) 身上是否有某物品", count: "count(e, '物品id') 物品数量", knows: "knows(e, '能力id') 是否会某能力",
  hasCondition: "hasCondition(e, '状态') 是否处于某状态", nearStructure: "nearStructure(e, '标签', 半径=3) 附近是否有带该标签的构筑物",
  nearAgents: 'nearAgents(e, 半径=3) 附近醒着的人数', min: 'min(a, b…)', max: 'max(a, b…)', abs: 'abs(x)', rand: 'rand() 0~1 随机数',
};
// 扩展目录（server/ext/）注册的表达式函数实现：name → (helpers, ...args) => value
export const EXT_FNS = {};
export const STATS = ['hp', 'stamina', 'courage'];
export const TARGETS = ['self', 'target', 'e', 'nearby', 'all'];
export const VFX = ['glow_ring', 'sparkle', 'heal', 'notes', 'burst', 'ripple'];
export const MAX_EFFECTS = 8;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => num(v) && v >= lo && v <= hi;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function checkTarget(a, allowed = TARGETS) {
  const t = a.target ?? 'self';
  if (!allowed.includes(t)) return `target 只能是 ${allowed.join('/')}`;
  if (a.radius != null && !inRange(a.radius, 1, 6)) return 'radius 应在 1~6';
  return null;
}

/** 位置：居民在室内时取建筑入口，并记下所在建筑 */
export function posOf(town, a) {
  if (!a) return null;
  if (a.inside) {
    const b = (town.worldOf?.(a.region) || town.world).buildings.find((x) => x.id === a.inside);
    if (b) return { x: b.x + b.w / 2, y: b.y + b.h - 1, inside: a.inside, region: a.region || 'town' };
  }
  return { x: a.x, y: a.y, inside: null, region: a.region || 'town' };
}

/** 附近的居民：同一建筑内，或都在户外且距离不超过 r 格。睡着的人不算。 */
export function agentsNear(town, at, r = 3, except = null) {
  if (!at) return [];
  return town.agents.filter((o) => o !== except && o.status !== 'sleeping' && (o.region || 'town') === (at.region || 'town') &&
    (at.inside ? o.inside === at.inside : !o.inside && Math.hypot(o.x - at.x, o.y - at.y) <= r));
}

/** 按效果参数里的 target / radius 解析出受影响的居民（扩展也可以复用） */
export function resolveTargets(town, ctx, a) {
  const t = a.target ?? 'self';
  if (t === 'self') return [ctx.self].filter(Boolean);
  if (t === 'target') return [ctx.target].filter(Boolean);
  if (t === 'e') return ctx.e?.kind === 'resident' ? [ctx.e] : [];
  if (t === 'nearby') return agentsNear(town, ctx.at, a.radius ?? 3, a.includeSelf ? null : ctx.self);
  if (t === 'all') return town.agents;
  return [];
}

const fill = (text, ctx) => text.replace(/\{self\}/g, ctx.self?.name || '有人').replace(/\{target\}/g, ctx.target?.name || '有人');

export const EFFECTS = {
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
        const v = a.set != null ? a.set : (x.body[a.stat] ?? 0) + a.add;
        x.body[a.stat] = clamp(Math.round(v), 0, 100);
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
    apply(town, ctx, a) { for (const x of resolveTargets(town, ctx, a)) town.learnAbility(x, a.ability, ctx.self ? `从${ctx.self.name}那里` : ''); },
  },
};

/** 校验一组效果，返回错误文本或 null */
export function checkEffects(list, spec) {
  if (!Array.isArray(list) || !list.length) return 'effects 至少需要一个效果';
  if (list.length > MAX_EFFECTS) return `effects 最多 ${MAX_EFFECTS} 个`;
  for (const [i, ef] of list.entries()) {
    if (!ef || typeof ef !== 'object' || !Object.hasOwn(EFFECTS, ef.op ?? '')) return `effects[${i}]：未知效果 ${ef?.op}`;
    const e = EFFECTS[ef.op].check(ef, spec);
    if (e) return `effects[${i}]（${ef.op}）：${e}`;
  }
  return null;
}

export function checkExpr(src) {
  try { parse(src, EXPR_FNS); return null; } catch (e) { return e instanceof ExprError ? `表达式错误：${e.message}` : String(e.message); }
}

/** 依次执行效果；单个效果出错不影响其他效果 */
export function runEffects(town, ctx, list) {
  for (const ef of list.slice(0, MAX_EFFECTS)) {
    try { EFFECTS[ef.op]?.apply(town, ctx, ef); } catch (e) { console.warn(`[effect] ${ef.op} 失败：`, e.message); }
  }
}
