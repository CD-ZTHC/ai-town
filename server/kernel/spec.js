// 世界规格：把原本写死在代码里的世界（设定、居民、建筑、地点、天气、日历、参数）变成一份可校验的数据。
// 默认规格来自官方世界包 worlds/yunxi/（多世界设计 §3）；之后的一切改动都以 WorldOp 叠加在它上面。
import { BUILDING_STATES } from '../worldgen/finish.js';
import { parseHM } from '../memory.js';
import { validateAbility } from './abilities.js';
import { validateRule } from './rules.js';
import { officialPack, packSpec } from '../worlds/pack.js';
import { RATINGS } from './ratings.js';
import { validateDark } from './threat-spec.js';

export const SPEC_VERSION = 2;
export { RATINGS } from './ratings.js';
export const STORYTELLERS = ['gentle', 'voyage', 'chaos', 'horror'];
export const PERSONA_KINDS = ['resident', 'traveller', 'creature'];
export const BODY_PLANS = ['wisp', 'hound', 'warden'];
export const MAX_PERSONAS = 24; // 含离开的人与剧情角色；世界包发布时另有 16 位的上限，余量留给人员流动

// 内核参数：AI 只能在上下限之内调节（见设计文档 4.6）
export const PARAM_BOUNDS = {
  walkSpeed: [2, 5],
  maxConvos: [1, 6],
  convoBaseProb: [0.05, 0.6],
  reflectThreshold: [20, 80],
  dayEnd: [21 * 60, 25 * 60], // 分钟，可以晚到次日 01:00
  // 死亡预算（黑暗叙事设计 §4.10）：每 deathDays 天最多 deathNamed 名具名角色死亡；世界设置可以覆盖 deathNamed
  deathNamed: [0, 20],
  deathDays: [1, 14],
};

/**
 * 默认世界规格：官方世界包（云溪镇）+ 世界级设置（分级、叙事者）。
 * env 里的 STORY_RATING / STORYTELLER 只在官方世界上生效（多世界设计 §14.8）。
 */
export function defaultSpec(env = process.env, pack = officialPack('yunxi')) {
  const rating = RATINGS.includes(env.STORY_RATING) ? env.STORY_RATING : undefined;
  const storyteller = STORYTELLERS.includes(env.STORYTELLER) ? env.STORYTELLER : undefined;
  return packSpec(pack, { rating, storyteller });
}

// ---------- 校验 ----------
const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v) => Number.isInteger(v);

/** 返回错误列表（空数组表示通过）。只做结构与引用完整性检查，不涉及剧情合理性。 */
export function validateSpec(s) {
  const errs = [];
  const err = (path, msg) => errs.push(`${path}: ${msg}`);
  if (!s || typeof s !== 'object') return ['spec: 不是对象'];
  if (s.specVersion !== SPEC_VERSION) err('specVersion', `应为 ${SPEC_VERSION}`);
  if (!RATINGS.includes(s.meta?.rating)) err('meta.rating', `只能是 ${RATINGS.join('/')}`);
  if (!STORYTELLERS.includes(s.meta?.storyteller)) err('meta.storyteller', `只能是 ${STORYTELLERS.join('/')}`);
  if (!isStr(s.lore?.summary, 2000)) err('lore.summary', '缺失或过长');
  if (!Array.isArray(s.lore?.canon)) err('lore.canon', '应为数组');

  const cal = s.calendar || {};
  if (!Array.isArray(cal.weekdays) || cal.weekdays.length !== 7 || !cal.weekdays.every((w) => isStr(w, 8))) err('calendar.weekdays', '应为 7 个名称');
  const evIds = new Set();
  for (const [i, e] of (cal.events || []).entries()) {
    const p = `calendar.events[${i}]`;
    if (!ID_RE.test(e.id || '')) err(p, 'id 不合法');
    else if (evIds.has(e.id)) err(p, `id 重复：${e.id}`);
    evIds.add(e.id);
    if (!isStr(e.name, 16)) err(p, 'name 缺失或过长');
    if (!isInt(e.day) || e.day < 1) err(p, 'day 应为正整数');
    if (parseHM(e.from) == null) err(p, 'from 应为 HH:MM');
  }

  const weathers = Object.entries(s.weather || {});
  if (!weathers.length) err('weather', '至少需要一种天气');
  if (!weathers.some(([, w]) => w.weight > 0)) err('weather', '至少一种天气的 weight > 0');
  for (const [id, w] of weathers) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(`weather.${id}`, 'id 不合法');
    if (!isStr(w.name, 8) || !isStr(w.emoji, 8)) err(`weather.${id}`, 'name/emoji 缺失');
    if (typeof w.weight !== 'number' || w.weight < 0 || w.weight > 100) err(`weather.${id}`, 'weight 应在 0~100');
    if (w.avoid && !Object.hasOwn(s.weather, w.avoid.fallback)) err(`weather.${id}`, `fallback 不存在：${w.avoid.fallback}`);
  }

  const bIds = new Set();
  for (const b of s.buildings || []) {
    if (bIds.has(b.id)) err(`buildings.${b.id}`, 'id 重复');
    bIds.add(b.id);
    if (![b.x, b.y, b.w, b.h].every(isInt) || b.w < 2 || b.h < 2) err(`buildings.${b.id}`, '位置或尺寸不合法');
    if (b.state != null && !BUILDING_STATES.includes(b.state)) err(`buildings.${b.id}`, `state 只能是 ${BUILDING_STATES.join('/')}`);
  }
  // 拆除的建筑留在数组里（基础生成要用），但不能再被引用；废墟不能住人
  const liveB = new Set((s.buildings || []).filter((b) => !b.removed).map((b) => b.id));
  const homeB = new Set((s.buildings || []).filter((b) => !b.removed && b.state !== 'ruin').map((b) => b.id));
  const locs = s.locations || {};
  const regionIds = new Set((s.regions || []).map((r) => r.id));
  for (const [id, l] of Object.entries(locs)) {
    if (!isStr(l.name, 16)) err(`locations.${id}`, 'name 缺失或过长');
    if (l.region != null && !regionIds.has(l.region)) err(`locations.${id}`, `未知区域：${l.region}`);
  }

  const items = s.items || {};
  for (const [id, it] of Object.entries(items)) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(`items.${id}`, 'id 不合法');
    if (!isStr(it.name, 8) || !isStr(it.emoji, 8)) err(`items.${id}`, 'name/emoji 缺失');
  }
  for (const [id, st] of Object.entries(s.structures || {})) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(`structures.${id}`, 'id 不合法');
    if (!isStr(st.name, 8) || !isStr(st.emoji, 8)) err(`structures.${id}`, 'name/emoji 缺失');
    if (!Array.isArray(st.tags)) err(`structures.${id}`, 'tags 应为数组');
    if (st.light && !(st.light.r >= 20 && st.light.r <= 160 && /^\d{1,3},\d{1,3},\d{1,3}$/.test(st.light.color))) err(`structures.${id}`, 'light 不合法');
  }
  const abIds = new Set();
  for (const ab of s.abilities || []) {
    if (abIds.has(ab.id)) err(`abilities.${ab.id}`, 'id 重复');
    abIds.add(ab.id);
    const e = validateAbility(ab, s);
    if (e) err(`abilities.${ab.id}`, e);
  }
  const ruleIds = new Set();
  for (const r of s.rules || []) {
    if (ruleIds.has(r.id)) err(`rules.${r.id}`, 'id 重复');
    ruleIds.add(r.id);
    const e = validateRule(r, s);
    if (e) err(`rules.${r.id}`, e);
  }

  for (const [id, c] of Object.entries(s.creatures || {})) {
    const p = `creatures.${id}`;
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(p, 'id 不合法');
    if (!isStr(c.name, 8) || !isStr(c.emoji, 8)) err(p, 'name/emoji 缺失');
    if (!BODY_PLANS.includes(c.look?.bodyPlan)) err(p, `look.bodyPlan 只能是 ${BODY_PLANS.join('/')}`);
    if (!(c.stats?.hp > 0 && c.stats.hp <= 300 && c.stats.speed > 0 && c.stats.speed <= 6 && c.stats.courage >= 0 && c.stats.courage <= 100)) err(p, 'stats 不合法');
    if (!['wander', 'thief', 'chaser', 'guard'].includes(c.behavior?.archetype)) err(p, 'behavior.archetype 不合法');
    if (c.minRating && !RATINGS.includes(c.minRating)) err(p, 'minRating 不合法');
  }
  const threadIds = new Set();
  for (const t of s.threads || []) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(t.id || '') || threadIds.has(t.id)) err(`threads.${t.id}`, 'id 不合法或重复');
    threadIds.add(t.id);
    if (!isStr(t.title, 20) || !isStr(t.hook, 80)) err(`threads.${t.id}`, 'title/hook 缺失或过长');
  }
  for (const a of s.arcs || []) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(a.id || '') || !isStr(a.title, 20)) err(`arcs.${a.id}`, 'id/title 不合法');
    if (!Array.isArray(a.phases) || !a.phases.length) err(`arcs.${a.id}`, '缺少 phases');
  }

  const pIds = new Set();
  for (const p of s.personas || []) {
    const path = `personas.${p.id}`;
    if (!ID_RE.test(p.id || '')) { err(path, 'id 不合法'); continue; }
    if (pIds.has(p.id)) err(path, 'id 重复');
    pIds.add(p.id);
    if (!isStr(p.name, 12) || !isStr(p.persona, 400) || !isStr(p.role, 30)) err(path, 'name/persona/role 缺失或过长');
    if (p.kind != null && !PERSONA_KINDS.includes(p.kind)) err(path, `kind 只能是 ${PERSONA_KINDS.join('/')}`);
    if (p.status != null && !['active', 'departed', 'dead'].includes(p.status)) err(path, 'status 只能是 active / departed / dead');
    if (p.kind === 'creature') {
      if (!Object.hasOwn(locs, p.home)) err(path, `异界角色的 home 应为地点：${p.home}`);
      if (!BODY_PLANS.includes(p.look?.bodyPlan)) err(path, 'look.bodyPlan 不合法');
    } else if (!homeB.has(p.home)) err(path, bIds.has(p.home) ? `home 已被拆除或成了废墟：${p.home}` : `home 不是建筑：${p.home}`);
    if (!locs[p.work] && !liveB.has(p.work)) err(path, `work 不存在：${p.work}`);
    if (!p.look || typeof p.look !== 'object') err(path, '缺少 look');
    for (const id of p.start?.abilities || []) if (!abIds.has(id)) err(path, `初始能力不存在：${id}`);
    for (const id of Object.keys(p.start?.inventory || {})) if (!Object.hasOwn(items, id)) err(path, `初始物品不存在：${id}`);
  }
  if ((s.personas || []).length > MAX_PERSONAS) err('personas', `角色最多 ${MAX_PERSONAS} 位`);
  for (const p of s.personas || []) {
    for (const rid of Object.keys(p.relations || {})) if (!pIds.has(rid)) err(`personas.${p.id}.relations`, `未知居民：${rid}`);
  }

  for (const [path, msg] of validateDark(s)) err(path, msg);

  for (const [k, v] of Object.entries(s.params || {})) {
    const b = Object.hasOwn(PARAM_BOUNDS, k) && PARAM_BOUNDS[k];
    if (!b) err(`params.${k}`, '未知参数');
    else if (typeof v !== 'number' || v < b[0] || v > b[1]) err(`params.${k}`, `应在 ${b[0]}~${b[1]}`);
  }
  return errs;
}

// ---------- 查询工具 ----------
export function weekdayOf(spec, day) {
  const w = spec.calendar.weekdays;
  return w[(((day - 1) % w.length) + w.length) % w.length];
}

/** 当前正在进行的日历事件 */
export function activeEvents(spec, day, minute) {
  return spec.calendar.events.filter((e) => {
    if (e.day !== day) return false;
    const from = parseHM(e.from) ?? 0;
    const to = e.to ? parseHM(e.to) : 24 * 60;
    return minute >= from && minute < to;
  });
}

/** 给提示词用的节日倒计时文案（与重构前的 festivalHint 文案一致） */
export function calendarHint(spec, day) {
  return spec.calendar.events.filter((e) => e.countdown).map((e) => {
    const d = e.day - day;
    if (d > 0) return `距离${weekdayOf(spec, e.day)}${e.name}还有${d}天。`;
    if (d === 0) return `今天就是${e.name}！${e.hint ? `${e.hint}。` : ''}`;
    return `${e.name}已经过去了。`;
  }).join('');
}

/** 按权重抽取自动天气 */
export function pickWeather(spec, minute, rnd = Math.random) {
  const list = Object.entries(spec.weather).filter(([, w]) => w.weight > 0);
  const total = list.reduce((s, [, w]) => s + w.weight, 0);
  let r = rnd() * total;
  let id = list[list.length - 1][0];
  for (const [k, w] of list) { if ((r -= w.weight) < 0) { id = k; break; } }
  const av = spec.weather[id].avoid;
  if (av && minute > parseHM(av.from) && minute < parseHM(av.to)) id = av.fallback;
  return id;
}

/** 前端需要的规格子集 */
export function publicSpec(spec) {
  return {
    meta: spec.meta, calendar: spec.calendar, weather: spec.weather, canon: spec.lore.canon, voice: spec.voice || null,
    items: spec.items, structures: spec.structures,
    creatures: Object.fromEntries(Object.entries(spec.creatures).map(([id, c]) => [id, { name: c.name, emoji: c.emoji, look: c.look, lore: c.lore, weakness: c.weakness, origin: c.origin, temperament: c.temperament, leader: Boolean(c.leader) }])),
    threads: spec.threads,
    abilities: spec.abilities.map(({ id, name, emoji, desc, target }) => ({ id, name, emoji, desc, target })),
    rules: spec.rules.map(({ id, name }) => ({ id, name })),
    // 威胁只下发名字和外观：规律、线索、对抗方式都不给前端（真相由引擎掌握）
    threats: Object.fromEntries(Object.entries(spec.threats || {}).map(([id, t]) => [id, { name: t.name, emoji: t.emoji, kind: t.kind || null, mortal: t.mortal, look: t.look || null }])),
    burdens: Object.fromEntries(Object.entries(spec.burdens || {}).map(([id, b]) => [id, { name: b.name, max: b.max ?? 100 }])),
  };
}
