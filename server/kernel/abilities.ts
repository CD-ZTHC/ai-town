// 能力系统（设计文档 6.3）：能力是由效果原语组合而成的数据。居民可以使用、研究、互相传授。
import { checkEffects, checkExpr, runEffects, posOf, agentsNear } from './effects.ts';
import { testExpr } from './rules.ts';
import { addMemory, fmtTime } from '../memory.ts';
import type { Ability, WorldSpec } from '../types/spec.ts';
import type { AgentLike, TownLike } from '../types/town.ts';

const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const inRange = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export const TARGET_TYPES: readonly string[] = ['self', 'agent', 'area'];

/** 校验一个能力（数据来自世界包或 AI，逐项检查） */
export function validateAbility(ab: Ability, spec: WorldSpec): string | null {
  if (!ab || typeof ab !== 'object') return '能力不是对象';
  if (!ID_RE.test(ab.id || '')) return 'id 不合法';
  if (!String(ab.name || '').trim() || String(ab.name).length > 8) return 'name 缺失或过长（≤8字）';
  if (!String(ab.desc || '').trim() || String(ab.desc).length > 50) return 'desc 缺失或过长（≤50字）';
  if (String(ab.aiHint || '').length > 50) return 'aiHint 过长（≤50字）';
  if (!TARGET_TYPES.includes(ab.target)) return `target 只能是 ${TARGET_TYPES.join('/')}`;
  if (ab.range != null && !inRange(ab.range, 1, 6)) return 'range 应在 1~6';
  const c: NonNullable<Ability['cost']> = ab.cost || {};
  if (c.stamina != null && !inRange(c.stamina, 0, 40)) return 'cost.stamina 应在 0~40';
  for (const [item, n] of Object.entries(c.items || {})) {
    if (!Object.hasOwn(spec.items, item)) return `cost.items 未知物品：${item}`;
    if (!(Number.isInteger(n) && n >= 1 && n <= 3)) return 'cost.items 数量应为 1~3';
  }
  if (c.burden != null && !(Object.hasOwn(spec.burdens || {}, c.burden.id) && inRange(c.burden.amount, 1, 50))) return 'cost.burden 应为 {id: 负担id, amount: 1~50}';
  if (ab.cooldown != null && !inRange(ab.cooldown, 0, 1440)) return 'cooldown 应在 0~1440（游戏分钟）';
  if (ab.requires != null) { const e = checkExpr(ab.requires); if (e) return `requires ${e}`; }
  const r = ab.learn?.research;
  if (r) {
    if (!Object.hasOwn(spec.locations, r.location)) return `learn.research 未知地点：${r.location}`;
    if (!Array.isArray(r.keywords) || !r.keywords.length || r.keywords.length > 8) return 'learn.research.keywords 应为 1~8 个关键词';
  }
  return checkEffects(ab.effects, spec);
}

export const findAbility = (spec: WorldSpec, id: string): Ability | undefined => spec.abilities.find((x) => x.id === id);

/** 写进提示词的能力说明 */
export function describeAbility(town: TownLike, a: AgentLike, ab: Ability): string {
  const c: NonNullable<Ability['cost']> = ab.cost || {};
  const cost = [c.stamina ? `体力${c.stamina}` : '', ...Object.entries(c.items || {}).map(([i, n]) => `${town.spec.items[i].name}×${n}`), c.burden ? `${town.spec.burdens?.[c.burden.id]?.name || c.burden.id}+${c.burden.amount}` : ''].filter(Boolean).join('、');
  const cd = (a.cooldowns?.[ab.id] || 0) > town.t ? `（冷却中，${fmtTime(a.cooldowns[ab.id]!)}后可用）` : '';
  const tgt = ab.target === 'agent' ? '对身边某人' : ab.target === 'area' ? '对周围的人' : '对自己';
  return `${ab.id}「${ab.emoji || ''}${ab.name}」${tgt}：${ab.desc}${ab.aiHint ? `；适合：${ab.aiHint}` : ''}${cost ? `；消耗：${cost}` : ''}${cd}`;
}

export type Prepared = { error: string; retry?: boolean; ab?: undefined; target?: undefined } | { error?: undefined; ab: Ability; target: AgentLike | null };

/** 检查能否使用；返回 { error } 或 { ab, target } */
export function prepare(town: TownLike, a: AgentLike, abilityId: string, targetRef: unknown): Prepared {
  const ab = findAbility(town.spec, abilityId);
  if (!ab) return { error: `没有这种能力：${abilityId}` };
  if (!a.abilities.includes(ab.id)) return { error: `${a.name}还不会「${ab.name}」` };
  if (a.status === 'sleeping') return { error: `${a.name}在睡觉` };
  if ((a.cooldowns?.[ab.id] || 0) > town.t) return { error: `「${ab.name}」还在冷却` };
  const c: NonNullable<Ability['cost']> = ab.cost || {};
  if ((c.stamina || 0) > a.body.stamina) return { error: `${a.name}体力不足` };
  for (const [item, n] of Object.entries(c.items || {})) {
    if ((a.inventory[item] || 0) < n) return { error: `${a.name}的${town.spec.items[item].name}不够` };
  }
  let target: AgentLike | null | undefined = null;
  if (ab.target === 'agent') {
    const near = agentsNear(town, posOf(town, a), ab.range ?? 3, a);
    const ref = String(targetRef ?? '').trim();
    target = ref ? near.find((o) => o.id === ref || o.name === ref || ref.includes(o.name)) : near[0];
    // 对象暂时不在身边：日程里的行动会稍后重试
    if (!target) return { error: ref ? `${ref}不在${a.name}身边` : `${a.name}身边没有人`, retry: true };
  }
  try {
    if (!testExpr(town, ab.requires, { self: a, target })) return { error: `现在不适合使用「${ab.name}」` };
  } catch (e) {
    return { error: `「${ab.name}」的条件无法判断：${(e as Error).message}` };
  }
  return { ab, target: target ?? null };
}

/** 使用能力：检查 → 支付消耗 → 执行效果 → 冷却、记忆、日志。返回 { ok, reason } */
export function useAbility(town: TownLike, a: AgentLike, abilityId: string, targetRef: unknown = null, why = ''): { ok: false; reason: string; retry: boolean } | { ok: true; ability: Ability; target: AgentLike | null } {
  const p = prepare(town, a, abilityId, targetRef);
  if (p.error != null) return { ok: false, reason: p.error, retry: Boolean(p.retry) };
  const { ab, target } = p;
  const c: NonNullable<Ability['cost']> = ab.cost || {};
  a.body.stamina = Math.max(0, a.body.stamina - (c.stamina || 0));
  for (const [item, n] of Object.entries(c.items || {})) {
    const left = (a.inventory[item] || 0) - n;
    if (left > 0) a.inventory[item] = left; else delete a.inventory[item];
  }
  (a.cooldowns ||= {})[ab.id] = town.t + (ab.cooldown || 0);
  if (c.burden) town.addBurden?.(a, c.burden.id, c.burden.amount, 'ability_used');
  runEffects(town, { self: a, target, at: posOf(town, a), source: `ability:${ab.id}` }, ab.effects);
  addMemory(a, { t: town.t, type: 'obs', text: `我${target ? `对${target.name}` : ''}使用了「${ab.name}」${why}`, importance: 3 });
  if (!a.convoId) town.say(a, `${ab.emoji || '✨'} ${ab.name}！`, 3500);
  town.log('ability', `${a.name}${target ? `对${target.name}` : ''}使用了${ab.emoji || ''}「${ab.name}」`, { agents: [a.id, target?.id].filter(Boolean), ability: ab.id });
  town.emit('agent', a.id);
  if (target) town.emit('agent', target.id);
  return { ok: true, ability: ab, target };
}

/** 研究：在指定地点研究的课题命中某个能力的关键词时，学会它 */
export function matchResearch(spec: WorldSpec, a: AgentLike, locId: string, topic: unknown): Ability | null {
  const t = String(topic || '');
  return spec.abilities.find((ab) => {
    const r = ab.learn?.research;
    return r && r.location === locId && !a.abilities.includes(ab.id) && (t.includes(ab.name) || r.keywords.some((k) => t.includes(k)));
  }) || null;
}
