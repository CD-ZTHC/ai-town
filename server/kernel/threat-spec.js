// 黑暗叙事的规格校验（黑暗叙事设计 §4、§6.1）：威胁、负担值、阵营权威、人口、反派心智、装备。
// 这些字段都是可选的：世界包没有声明时，validateDark 什么也不检查，相关系统也不会运行。
import { checkEffects, checkExpr } from './effects.js';
import { RATINGS } from './ratings.js';
import { parseHM } from '../memory.ts';

const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => num(v) && v >= lo && v <= hi;

export const MOVEMENTS = ['wander', 'stalk_marked', 'stationary', 'patrol'];
export const COUNTER_TYPES = ['slay', 'contain', 'suppress', 'ward', 'delay', 'exploit', 'resolve'];
export const POSTURES = ['eyesClosed', 'silent', 'noOpen', 'stayLit', 'notAlone'];
export const EQUIP_SLOTS = ['weapon', 'armor', 'trinket'];
export const ALIGNMENTS = ['villain', 'neutral'];
export const CLUE_KINDS = ['rule', 'next_victim', 'origin'];
export const BURDEN_EVENTS = ['anchor_lost', 'anchor_gained', 'ability_used'];

function checkCounter(c, spec) {
  if (!c || !COUNTER_TYPES.includes(c.type)) return `type 只能是 ${COUNTER_TYPES.join('/')}`;
  if (c.type === 'contain') {
    if (!Object.hasOwn(spec.items || {}, c.with)) return `contain.with 未知物品：${c.with}`;
    if (c.yields != null && !Object.hasOwn(spec.items || {}, c.yields)) return `contain.yields 未知物品：${c.yields}`;
    if (c.time != null && !inRange(c.time, 5, 120)) return 'contain.time 应在 5~120（游戏分钟）';
    if (c.leak != null && !inRange(c.leak, 0, 0.5)) return 'contain.leak 应在 0~0.5（每天）';
  }
  if (c.type === 'suppress' && c.power != null && !inRange(c.power, 1, 10)) return 'suppress.power 应在 1~10';
  if (c.type === 'ward') {
    if (!Object.hasOwn(spec.structures || {}, c.with)) return `ward.with 应为构筑物 id：${c.with}`;
    if (c.radius != null && !inRange(c.radius, 1, 8)) return 'ward.radius 应在 1~8';
  }
  if (c.type === 'resolve') {
    if (!isStr(c.when, 300)) return 'resolve.when 需要条件表达式';
    const e = checkExpr(c.when);
    if (e) return `resolve.when ${e}`;
    if (c.text != null && !isStr(c.text, 40)) return 'resolve.text 过长（≤40字）';
  }
  if (c.type === 'exploit' && !isStr(c.hint, 60)) return 'exploit.hint 需要一段提示（≤60字）';
  return null;
}

export function validateThreat(id, t, spec) {
  if (!ID_RE.test(id)) return 'id 不合法';
  if (!t || typeof t !== 'object') return '不是对象';
  if (!isStr(t.name, 12) || !isStr(t.emoji, 8)) return 'name（≤12字）/ emoji 缺失';
  if (t.kind != null && !isStr(t.kind, 12)) return 'kind 过长（≤12字）';
  if (typeof t.mortal !== 'boolean') return 'mortal 必须是布尔值';
  if (t.mortal && !inRange(t.hp, 1, 500)) return '会死的威胁需要 hp（1~500）';
  for (const k of ['atk', 'def']) if (t[k] != null && !inRange(t[k], 0, 60)) return `${k} 应在 0~60`;
  if (t.speed != null && !inRange(t.speed, 0.2, 6)) return 'speed 应在 0.2~6';
  if (t.origin != null && !isStr(t.origin, 80)) return 'origin 过长（≤80字）';
  if (t.movement != null && !MOVEMENTS.includes(t.movement)) return `movement 只能是 ${MOVEMENTS.join('/')}`;
  if (!Array.isArray(t.haunt) || !t.haunt.length || t.haunt.length > 6) return 'haunt 应为 1~6 个地点 id';
  for (const l of t.haunt) if (!Object.hasOwn(spec.locations, l)) return `haunt 未知地点：${l}`;
  if (t.active != null && !(Array.isArray(t.active) && t.active.length === 2 && t.active.every((x) => parseHM(x) != null))) return 'active 应为 ["HH:MM","HH:MM"]';
  if (t.minRating != null && !RATINGS.includes(t.minRating)) return 'minRating 不合法';
  const r = t.rule;
  if (r != null) {
    if (!isStr(r.trigger, 300)) return 'rule.trigger 需要条件表达式';
    let e = checkExpr(r.trigger);
    if (e) return `rule.trigger ${e}`;
    if (r.unless != null) { e = checkExpr(r.unless); if (e) return `rule.unless ${e}`; }
    const d = r.mark?.delay;
    if (!(Array.isArray(d) && d.length === 2 && inRange(d[0], 0, 720) && inRange(d[1], d[0], 720))) return 'rule.mark.delay 应为 [最短, 最长]（0~720 游戏分钟）';
    if (r.mark.sign != null && !isStr(r.mark.sign, 30)) return 'rule.mark.sign 过长（≤30字）';
    e = checkEffects(r.outcome, spec);
    if (e) return `rule.outcome ${e}`;
    if (r.reach != null && !inRange(r.reach, 2, 40)) return 'rule.reach 应在 2~40';
    if (r.rest != null && !inRange(r.rest, 0, 1440)) return 'rule.rest 应在 0~1440';
  }
  for (const s of t.sounds || []) {
    if (!/^[a-z][a-z0-9_]{1,15}$/.test(s.id || '')) return 'sounds[].id 不合法';
    if (!inRange(s.every, 5, 720) || !inRange(s.radius ?? 5, 1, 12)) return 'sounds[] 的 every（5~720）/ radius（1~12）不合法';
    if (s.text != null && !isStr(s.text, 30)) return 'sounds[].text 过长';
  }
  if (t.counters != null) {
    if (!Array.isArray(t.counters) || t.counters.length > 8) return 'counters 应为数组（≤8）';
    for (const [i, c] of t.counters.entries()) { const e = checkCounter(c, spec); if (e) return `counters[${i}] ${e}`; }
    if (!t.mortal && t.counters.some((c) => c.type === 'slay')) return '杀不死的威胁不能有 slay';
  }
  const z = t.zone;
  if (z != null) {
    if (!inRange(z.radius, 1, 20) || (z.grow != null && !inRange(z.grow, 0, 5))) return 'zone.radius（1~20）/ grow（0~5 每天）不合法';
    if (z.replay != null && !isStr(z.replay, 40)) return 'zone.replay 过长（≤40字）';
    if (z.tint != null && !/^#[0-9a-f]{6}$/i.test(z.tint)) return 'zone.tint 应为 #rrggbb';
  }
  const h = t.hostable;
  if (h != null) {
    if (!Array.isArray(h.grants) || h.grants.some((g) => !spec.abilities.some((a) => a.id === g))) return 'hostable.grants 里有未知能力';
    if (!Object.hasOwn(spec.burdens || {}, h.burden)) return `hostable.burden 未知负担值：${h.burden}`;
    if (h.rate != null && !inRange(h.rate, 0, 5)) return 'hostable.rate 应在 0~5';
    for (const [k, v] of Object.entries(h.offsets || {})) if (!Object.hasOwn(spec.threats, k) || !inRange(v, -1, 1)) return `hostable.offsets 不合法：${k}`;
    for (const v of h.via || []) {
      const e = checkExpr(v.when || 'true');
      if (e) return `hostable.via ${e}`;
      if (!inRange(v.p, 0, 1)) return 'hostable.via[].p 应在 0~1';
      if (v.fail != null) { const f = checkEffects(v.fail, spec); if (f) return `hostable.via[].fail ${f}`; }
    }
  }
  for (const k of ['clues', 'decoys']) {
    if (t[k] != null && (!Array.isArray(t[k]) || t[k].length > 8 || t[k].some((x) => !isStr(x, 40)))) return `${k} 应为 ≤8 条、每条 ≤40 字`;
  }
  if (t.rule && !(t.clues || []).length) return '有规律的威胁至少要有一条真线索（clues）';
  for (const l of t.research || []) if (!Object.hasOwn(spec.locations, l)) return `research 未知地点：${l}`;
  for (const x of t.loot || []) if (!Object.hasOwn(spec.items || {}, x.item) || !inRange(x.p, 0, 1)) return 'loot 不合法';
  if (t.crowd != null && !(inRange(t.crowd.every, 30, 1440) && Array.isArray(t.crowd.kills) && inRange(t.crowd.kills[0], 0, 50) && inRange(t.crowd.kills[1], t.crowd.kills[0], 50))) return 'crowd 应为 {every: 30~1440, kills: [最少, 最多]}';
  return null;
}

export function validateBurden(id, b, spec) {
  if (!ID_RE.test(id)) return 'id 不合法';
  if (!isStr(b?.name, 8)) return 'name 缺失或过长（≤8字）';
  if (b.max != null && !inRange(b.max, 10, 1000)) return 'max 应在 10~1000';
  if (b.drift != null && !inRange(b.drift, -20, 50)) return 'drift 应在 -20~50（每天）';
  for (const m of b.driftMods || []) {
    const e = checkExpr(m.when || '');
    if (e) return `driftMods.when ${e}`;
    if (!inRange(m.mult, 0, 5)) return 'driftMods.mult 应在 0~5';
  }
  for (const ev of b.onEvent || []) if (!BURDEN_EVENTS.includes(ev.event) || !inRange(ev.amount, -100, 100)) return `onEvent 只能是 ${BURDEN_EVENTS.join('/')}，amount 在 -100~100`;
  for (const m of b.moodAt || []) if (!(Array.isArray(m) && inRange(m[0], 0, b.max ?? 100) && isStr(m[1], 6))) return 'moodAt 应为 [[数值, "心情"]…]';
  if (b.selfText != null && !isStr(b.selfText, 80)) return 'selfText 过长（≤80字）';
  if (b.onFull != null) { const e = checkEffects(b.onFull, spec); if (e) return `onFull ${e}`; }
  return null;
}

/** 黑暗叙事字段的校验；返回 [路径, 错误] 列表 */
export function validateDark(s) {
  const errs = [];
  const err = (p, m) => errs.push([p, m]);
  for (const [id, b] of Object.entries(s.burdens || {})) { const e = validateBurden(id, b, s); if (e) err(`burdens.${id}`, e); }
  for (const [id, t] of Object.entries(s.threats || {})) { const e = validateThreat(id, t, s); if (e) err(`threats.${id}`, e); }
  const inc = s.incidents;
  if (inc != null) {
    for (const x of inc.start || []) {
      if (!Object.hasOwn(s.threats || {}, x.threat)) err('incidents.start', `未知威胁：${x.threat}`);
      if (x.at != null && !Object.hasOwn(s.locations || {}, x.at)) err('incidents.start', `未知地点：${x.at}`);
    }
    if (inc.autoEveryDays != null && !(Number.isInteger(inc.autoEveryDays) && inc.autoEveryDays >= 1 && inc.autoEveryDays <= 14)) err('incidents.autoEveryDays', '应为 1~14 的整数');
  }
  for (const [id, n] of Object.entries(s.population || {})) {
    if (!Object.hasOwn(s.locations || {}, id)) err(`population.${id}`, '未知地点');
    else if (!Number.isInteger(n) || n < 0 || n > 100000) err(`population.${id}`, '应为 0~100000 的整数');
  }
  for (const [i, f] of (s.factions || []).entries()) {
    const p = `factions[${i}]`;
    if (!f || !ID_RE.test(f.id || '') || !isStr(f.name, 12)) { err(p, 'id / name 不合法'); continue; }
    if (f.authority != null && !(Array.isArray(f.authority) && f.authority.every((x) => x === 'dispatch'))) err(p, 'authority 只能包含 dispatch');
    if (f.stipend != null) {
      const { every, ...items } = f.stipend;
      if (!inRange(every, 60, 10080)) err(p, 'stipend.every 应在 60~10080（游戏分钟）');
      for (const [k, n] of Object.entries(items)) if (!Object.hasOwn(s.items || {}, k) || !(Number.isInteger(n) && n >= 1 && n <= 10)) err(p, `stipend 物品不合法：${k}`);
    }
    for (const m of f.members || []) if (!(s.personas || []).some((x) => x.id === m)) err(p, `members 未知居民：${m}`);
    if (f.head != null && !(f.members || []).includes(f.head)) err(p, 'head 必须是成员');
    for (const h of f.hostile || []) if (!(s.factions || []).some((x) => x.id === h && x !== f)) err(p, `hostile 未知阵营：${h}`);
  }
  for (const [id, it] of Object.entries(s.items || {})) {
    if (it.equip != null && !EQUIP_SLOTS.includes(it.equip)) err(`items.${id}`, `equip 只能是 ${EQUIP_SLOTS.join('/')}`);
    for (const [k, v] of Object.entries(it.mods || {})) if (!['atk', 'def', 'hp'].includes(k) || !inRange(v, -20, 40)) err(`items.${id}`, 'mods 只能有 atk / def / hp（-20~40）');
    if (it.use != null) { const e = checkEffects(it.use, s); if (e) err(`items.${id}.use`, e); }
  }
  for (const p of s.personas || []) {
    const path = `personas.${p.id}`;
    if (p.alignment != null && !ALIGNMENTS.includes(p.alignment)) err(path, `alignment 只能是 ${ALIGNMENTS.join('/')}`);
    if (p.redemption != null) { const e = checkExpr(p.redemption); if (e) err(path, `redemption ${e}`); }
    for (const d of p.drives || []) if (!isStr(d.text, 40) || !inRange(d.perDay ?? 25, 0, 100)) err(path, 'drives 应为 [{text: ≤40字, perDay: 0~100}]');
    for (const t of p.start?.hosted || []) if (!s.threats?.[t]?.hostable) err(path, `start.hosted 不是可寄宿的威胁：${t}`);
    for (const [k, v] of Object.entries(p.start?.burdens || {})) if (!Object.hasOwn(s.burdens || {}, k) || !inRange(v, 0, 1000)) err(path, `start.burdens 不合法：${k}`);
    if (p.combat != null) for (const [k, v] of Object.entries(p.combat)) if (!['atk', 'def'].includes(k) || !inRange(v, 0, 60)) err(path, 'combat 只能有 atk / def（0~60）');
  }
  return errs;
}
