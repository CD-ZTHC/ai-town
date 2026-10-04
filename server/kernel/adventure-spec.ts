// 冒险（docs/design/adventure.md）的世界包字段：成长、回复、结伴、远征、怪物与武器的外观、区域氛围。
// 只做结构与引用完整性检查；没有声明这些字段的世界不受影响。
import { checkEffects, checkExpr } from './effects.ts';
import type { ExpeditionDef, WorldSpec } from '../types/spec.ts';

type Raw = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): boolean => num(v) && v >= lo && v <= hi;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** 暂时只支持一支远征队伍（§3.4）；数据结构、存档、事件都按多支设计，放开时改这里 */
export const MAX_EXPEDITIONS = 1;
export const DEFAULT_EXPEDITION = 'main';
/** 怪物外观的体型（§4.1）：前三种是异界生物原有的 */
export const MONSTER_PLANS: readonly string[] = ['wisp', 'hound', 'warden', 'blob', 'beast', 'bird', 'insect', 'humanoid', 'treant', 'golem', 'skeleton', 'serpent', 'eye'];
export const PATTERNS: readonly string[] = ['plain', 'spots', 'stripes', 'crystal', 'bone', 'ember'];
export const AURAS: readonly string[] = ['none', 'smoke', 'fire', 'frost', 'shadow', 'holy'];
export const WEAPONS: readonly string[] = ['sword', 'axe', 'staff', 'bow', 'spear', 'dagger', 'shield', 'hammer'];
export const PARTICLES: readonly string[] = ['none', 'motes', 'leaves', 'embers', 'sand', 'snow', 'fog'];
export const SOUNDS: readonly string[] = ['none', 'wind', 'birds', 'cave', 'fire', 'hum'];
/** 默认算作回复点的地点类型 */
export const REST_KINDS: readonly string[] = ['clinic', 'inn', 'temple', 'camp', 'shrine'];

/** 世界包里的远征：expedition（一支）或 expeditions（列表），统一成列表；没写 id 的叫 main */
export function expeditionsOf(spec: Pick<WorldSpec, 'expedition' | 'expeditions'>): Array<ExpeditionDef & { id: string }> {
  const list = [...(spec.expeditions || []), ...(spec.expedition ? [spec.expedition] : [])];
  return list.map((x) => ({ ...x, id: x.id || DEFAULT_EXPEDITION }));
}

/** 怪物外观：{bodyPlan, scale, palette:{body,accent,eyes,glow}, pattern, aura} */
export function checkLook(look: Raw): string | null {
  if (look == null) return null;
  if (typeof look !== 'object') return 'look 应为对象';
  if (!MONSTER_PLANS.includes(look.bodyPlan)) return `look.bodyPlan 只能是 ${MONSTER_PLANS.join('/')}`;
  if (look.scale != null && !inRange(look.scale, 0.6, 3)) return 'look.scale 应在 0.6~3';
  for (const [k, v] of Object.entries<Raw>(look.palette || {})) if (!['body', 'accent', 'eyes', 'glow'].includes(k) || !COLOR_RE.test(v)) return `look.palette.${k} 应为 #rrggbb`;
  if (look.pattern != null && !PATTERNS.includes(look.pattern)) return `look.pattern 只能是 ${PATTERNS.join('/')}`;
  if (look.aura != null && !AURAS.includes(look.aura)) return `look.aura 只能是 ${AURAS.join('/')}`;
  return null;
}

/** 校验冒险相关的字段，返回 [路径, 错误] 列表 */
export function validateAdventure(s: Raw): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const err = (p: string, m: string) => out.push([p, m]);
  const abilities: Raw[] = s.abilities || [];
  const personas: Raw[] = s.personas || [];
  const pIds = new Set(personas.map((p) => p.id));
  const regionIds = new Set((s.regions || []).map((r: Raw) => r.id));
  const locs = s.locations || {};
  const threats = s.threats || {};

  // ---- 成长 ----
  const g = s.growth;
  if (g != null) {
    const tracks = Object.entries<Raw>(g.tracks || {});
    if (!tracks.length || tracks.length > 8) err('growth.tracks', '需要 1~8 条成长路线');
    if (g.who != null && !['personas', 'all'].includes(g.who)) err('growth.who', '只能是 personas / all');
    if (g.maxLevel != null && !(Number.isInteger(g.maxLevel) && g.maxLevel >= 2 && g.maxLevel <= 99)) err('growth.maxLevel', '应为 2~99 的整数');
    if (g.curve != null && (!inRange(g.curve.base ?? 20, 5, 1000) || !inRange(g.curve.mult ?? 1.3, 1, 3))) err('growth.curve', 'base 应在 5~1000、mult 应在 1~3');
    if (g.share != null && !['participants', 'killer'].includes(g.share)) err('growth.share', '只能是 participants / killer');
    const maxLv = g.maxLevel ?? 40;
    for (const [id, t] of tracks) {
      const p = `growth.tracks.${id}`;
      if (!ID_RE.test(id)) err(p, 'id 不合法');
      if (t.name != null && !isStr(t.name, 8)) err(p, 'name 过长（≤8字）');
      const pl = t.perLevel || {};
      if (!inRange(pl.atk ?? 0, 0, 5) || !inRange(pl.def ?? 0, 0, 5) || !inRange(pl.maxHp ?? 0, 0, 50)) err(p, 'perLevel 的 atk、def 应在 0~5，maxHp 应在 0~50');
      for (const l of t.learn || []) {
        const ab = abilities.find((x) => x.id === l.ability);
        if (!(Number.isInteger(l.level) && l.level >= 2 && l.level <= maxLv)) err(p, `learn 的等级应在 2~${maxLv}`);
        if (!ab) err(p, `learn 里的能力不存在：${l.ability}`);
        else if (ab.power === 'genesis') err(p, `创世级的能力不能靠升级学会：${l.ability}`);
      }
    }
    if (g.avatar != null) {
      if (g.avatar.track != null && !Object.hasOwn(g.tracks || {}, g.avatar.track)) err('growth.avatar.track', `未知路线：${g.avatar.track}`);
      if (g.avatar.maxLevel != null && !(Number.isInteger(g.avatar.maxLevel) && g.avatar.maxLevel >= 1 && g.avatar.maxLevel <= maxLv)) err('growth.avatar.maxLevel', `应为 1~${maxLv} 的整数`);
    }
  }
  for (const p of personas) {
    if (p.growth != null) {
      if (!g) err(`personas.${p.id}.growth`, '世界包没有 growth，角色不能写成长路线');
      else {
        if (p.growth.track != null && !Object.hasOwn(g.tracks || {}, p.growth.track)) err(`personas.${p.id}.growth`, `未知路线：${p.growth.track}`);
        if (p.growth.level != null && !(Number.isInteger(p.growth.level) && p.growth.level >= 1 && p.growth.level <= (g.maxLevel ?? 40))) err(`personas.${p.id}.growth`, 'level 超出范围');
      }
    }
    if (p.party != null && !Object.hasOwn(s.parties || {}, p.party)) err(`personas.${p.id}.party`, `未知队伍：${p.party}`);
  }

  // ---- 回复 ----
  const r = s.recovery;
  if (r != null) {
    if (r.kinds != null && !(Array.isArray(r.kinds) && r.kinds.length <= 12 && r.kinds.every((k: unknown) => typeof k === 'string' && /^[a-z_]{2,16}$/.test(k)))) err('recovery.kinds', '应为 ≤12 个地点类型');
    for (const [id, v] of Object.entries<Raw>(r.places || {})) {
      if (!Object.hasOwn(locs, id)) err('recovery.places', `未知地点：${id}`);
      if (v?.rate != null && !inRange(v.rate, 0.1, 10)) err('recovery.places', `${id} 的 rate 应在 0.1~10`);
      if (v?.text != null && !isStr(v.text, 16)) err('recovery.places', `${id} 的 text 过长（≤16字）`);
    }
    if (r.rate != null && !inRange(r.rate, 0.1, 10)) err('recovery.rate', '应在 0.1~10（每游戏分钟回复生命上限的百分之几）');
    if (r.retreatAt != null && !inRange(r.retreatAt, 0, 0.9)) err('recovery.retreatAt', '应在 0~0.9');
    if (r.resumeAt != null && !inRange(r.resumeAt, Math.max(0.1, r.retreatAt ?? 0), 1)) err('recovery.resumeAt', '应在 retreatAt~1');
    if (r.downed != null && !['carry', 'warp'].includes(r.downed)) err('recovery.downed', '只能是 carry / warp');
  }

  // ---- 结伴 ----
  for (const [id, pt] of Object.entries<Raw>(s.parties || {})) {
    const p = `parties.${id}`;
    if (!ID_RE.test(id)) err(p, 'id 不合法');
    if (!pIds.has(pt?.leader)) err(p, `队长不存在：${pt?.leader}`);
    if (!isStr(pt?.name, 12)) err(p, 'name 缺失或过长（≤12字）');
    if (pt?.formation != null && !['loose', 'line'].includes(pt.formation)) err(p, 'formation 只能是 loose / line');
  }

  // ---- 远征 ----
  if (s.expedition != null && s.expeditions != null) err('expedition', 'expedition 与 expeditions 只能写一个');
  const exps = expeditionsOf(s);
  if (exps.length > MAX_EXPEDITIONS) err('expeditions', `暂时只支持 ${MAX_EXPEDITIONS} 支远征队伍`);
  const expIds = new Set<string>();
  for (const x of exps) {
    const p = `expeditions.${x.id}`;
    if (!ID_RE.test(x.id) || expIds.has(x.id)) err(p, 'id 不合法或重复');
    expIds.add(x.id);
    if (!Object.hasOwn(s.parties || {}, x.party)) err(p, `未知队伍：${x.party}`);
    if (!Array.isArray(x.stages) || !x.stages.length || x.stages.length > 32) { err(p, 'stages 应为 1~32 个阶段'); continue; }
    const sIds = new Set(x.stages.map((st: Raw) => st?.id));
    if (sIds.size !== x.stages.length) err(p, '阶段 id 重复');
    for (const st of x.stages as Raw[]) {
      const q = `${p}.stages.${st?.id}`;
      if (!ID_RE.test(st?.id || '')) { err(q, 'id 不合法'); continue; }
      if (!regionIds.has(st.region)) err(q, `未知区域：${st.region}`);
      if (!isStr(st.title, 12)) err(q, 'title 缺失或过长（≤12字）');
      if (st.intro != null && !isStr(st.intro, 60)) err(q, 'intro 过长（≤60字）');
      for (const l of st.wild || []) if (!Object.hasOwn(locs, l)) err(q, `wild 未知地点：${l}`);
      if (st.spawns != null && (!Array.isArray(st.spawns) || st.spawns.length > 6)) err(q, 'spawns 最多 6 条');
      for (const sp of st.spawns || []) {
        const t = threats[sp?.threat];
        if (!t?.mortal) err(q, `spawns 的威胁不存在或杀不死：${sp?.threat}`);
        if (!inRange(sp?.every, 10, 1440) || !(Number.isInteger(sp?.max) && sp.max >= 1 && sp.max <= 8)) err(q, 'spawns 的 every 应在 10~1440、max 应为 1~8');
        if (sp?.when != null) { const e = checkExpr(sp.when); if (e) err(q, `spawns.when ${e}`); }
      }
      if (st.boss != null) {
        if (!threats[st.boss.threat]?.mortal) err(q, `boss 不存在或杀不死：${st.boss.threat}`);
        if (st.boss.after != null) { const e = checkExpr(st.boss.after); if (e) err(q, `boss.after ${e}`); }
        if (st.boss.foreshadow != null && !inRange(st.boss.foreshadow, 0, 240)) err(q, 'boss.foreshadow 应在 0~240（分钟）');
        if (st.boss.at != null && !Object.hasOwn(locs, st.boss.at)) err(q, `boss.at 未知地点：${st.boss.at}`);
      }
      if (st.clear != null) { const e = checkExpr(st.clear); if (e) err(q, `clear ${e}`); }
      if (st.clear == null && st.boss == null) err(q, '需要 boss 或 clear（征服条件）');
      if (st.reward != null) { const e = checkEffects(st.reward, s); if (e) err(q, `reward ${e}`); }
      for (const u of st.unlock || []) if (!sIds.has(u)) err(q, `unlock 未知阶段：${u}`);
      if (st.levelHint != null && !(Number.isInteger(st.levelHint) && st.levelHint >= 1 && st.levelHint <= 99)) err(q, 'levelHint 应为 1~99 的整数');
      if (st.atlas != null && !(inRange(st.atlas.x, 0, 100) && inRange(st.atlas.y, 0, 100))) err(q, 'atlas 应为 {x, y}（0~100）');
    }
    if (x.tokens != null && !(isStr(x.tokens.name, 6) && isStr(x.tokens.emoji, 8) && Number.isInteger(x.tokens.total) && x.tokens.total >= 1 && x.tokens.total <= 12)) err(p, 'tokens 应为 {name ≤6字, emoji, total 1~12}');
  }

  // ---- 威胁的冒险字段 ----
  for (const [id, t] of Object.entries<Raw>(threats)) {
    const p = `threats.${id}`;
    if (t.exp != null && !inRange(t.exp, 0, 1000)) err(p, 'exp 应在 0~1000');
    if (t.foreshadow != null && !(inRange(t.foreshadow.lead, 10, 240) && (t.foreshadow.text == null || isStr(t.foreshadow.text, 40)))) err(p, 'foreshadow 应为 {lead: 10~240, text ≤40字}');
    if (t.incident != null && typeof t.incident !== 'boolean') err(p, 'incident 应为布尔值');
    const e = checkLook(t.look);
    if (e) err(p, e);
  }
  // ---- 物品 ----
  for (const [id, it] of Object.entries<Raw>(s.items || {})) {
    const p = `items.${id}`;
    if (it.combatUse != null && (typeof it.combatUse !== 'boolean' || (it.combatUse && !Array.isArray(it.use)))) err(p, 'combatUse 只能用在有 use 效果的物品上');
    if (it.look != null) {
      if (it.look.weapon != null && !WEAPONS.includes(it.look.weapon)) err(p, `look.weapon 只能是 ${WEAPONS.join('/')}`);
      for (const k of ['color', 'glow']) if (it.look[k] != null && !COLOR_RE.test(it.look[k])) err(p, `look.${k} 应为 #rrggbb`);
    }
  }
  // ---- 区域 ----
  for (const rg of s.regions || []) {
    const p = `regions.${rg.id}`;
    if (rg.atlas != null && !(inRange(rg.atlas.x, 0, 100) && inRange(rg.atlas.y, 0, 100))) err(p, 'atlas 应为 {x, y}（0~100）');
    const a = rg.ambience;
    if (a != null) {
      if (a.tint != null && !COLOR_RE.test(a.tint)) err(p, 'ambience.tint 应为 #rrggbb');
      if (a.tintAlpha != null && !inRange(a.tintAlpha, 0, 0.4)) err(p, 'ambience.tintAlpha 应在 0~0.4');
      if (a.particles != null && !PARTICLES.includes(a.particles)) err(p, `ambience.particles 只能是 ${PARTICLES.join('/')}`);
      if (a.sound != null && !SOUNDS.includes(a.sound)) err(p, `ambience.sound 只能是 ${SOUNDS.join('/')}`);
    }
  }
  for (const id of s.spotlight || []) if (!pIds.has(id)) err('spotlight', `未知角色：${id}`);
  if (s.fog != null && typeof s.fog !== 'boolean') err('fog', '应为布尔值');
  return out;
}
