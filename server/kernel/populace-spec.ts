// 群众的规格（docs/design/populace.md §3）：world.json 的 populace 块的校验，以及「这个世界实际用哪份群众配置」——
//   写了 populace 就用它（groups 为空表示这个世界没有群众）；
//   只有旧的 population（地点 → 人数）时转成一类「市民」；
//   都没有时按主地图的公开地点推一份默认群众（决策 1：公开地点数 × 6，8~120 人）。
// 只依赖规格本身，不依赖运行中的小镇，可以单独测试。
import type { WorldSpec } from '../types/spec.ts';

type Raw = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- 未经校验的规格数据

export const RHYTHMS = ['day', 'night', 'always', 'visitor'] as const;
export type PopRhythm = (typeof RHYTHMS)[number];
export const MAX_GROUPS = 8;
export const MAX_GROUP_SIZE = 100000;
const DEFAULT_PER_PLACE = 6;
const DEFAULT_MIN = 8;
const DEFAULT_MAX = 120;

/** 规格里的一类人群 */
export interface PopulaceGroupSpec {
  id: string;
  name: string;
  emoji?: string;
  size: number;
  /** 住处（建筑或地点 id）：只决定出门、回家时从哪里走 */
  homes?: string[];
  /** 常去的地点 */
  haunts?: string[];
  /** 上工的地点（不写时从常去的地点里按种类挑） */
  work?: string[];
  rhythm?: PopRhythm;
  /** 性情 0~1：胆小、好奇、爱凑热闹 */
  traits?: { timid?: number; curious?: number; social?: number };
  look?: { tones?: string[] };
}

export interface PopulaceSpec {
  groups: PopulaceGroupSpec[];
  /** 进出世界的出入口（地点 id）；不写时用主地图的渡口 */
  outside?: { name?: string; via?: string[] };
  /** 一个小人代表几个人；0 或不写 = 自动 */
  scale?: number;
  /** 地点容量（不写时按地点大小估算） */
  capacity?: Record<string, number>;
}

/** 运行时用的一类人群（字段都已补齐） */
export interface PopGroup {
  id: string;
  name: string;
  emoji: string;
  size: number;
  homes: string[];
  haunts: string[];
  work: string[];
  rhythm: PopRhythm;
  traits: { timid: number; curious: number; social: number };
  tones: string[];
}

export interface PopulaceConfig {
  groups: PopGroup[];
  outside: { name: string; via: string[] };
  scale: number;
  capacity: Record<string, number>;
  /** 配置从哪里来：spec（世界包写的）/ legacy（旧的 population）/ default（自动推出来的） */
  source: 'spec' | 'legacy' | 'default';
}

const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TONES = ['#6f86a8', '#a8786a', '#6a9478', '#9a86b4', '#b89a5c', '#5f8a9a', '#a06a7a', '#8a9a62'];
/** 像住处的建筑 / 地点种类 */
export const RESIDENTIAL = new Set(['house', 'cottage', 'apartment', 'home', 'hut', 'cabin', 'farmhouse', 'inn', 'manor', 'dorm', 'villa', 'tent']);
const inRange = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** 校验 populace 块：返回 [路径, 错误] 列表 */
export function validatePopulace(s: Raw): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const p = s?.populace;
  if (p == null) return out;
  if (typeof p !== 'object' || Array.isArray(p)) return [['populace', '应为对象']];
  const locs = s.locations || {};
  const isPlace = (id: unknown) => typeof id === 'string' && (Object.hasOwn(locs, id) || (s.buildings || []).some((b: Raw) => b.id === id && !b.removed));
  if (!Array.isArray(p.groups)) return [['populace.groups', '应为数组']];
  if (p.groups.length > MAX_GROUPS) out.push(['populace.groups', `最多 ${MAX_GROUPS} 类`]);
  const ids = new Set<string>();
  for (const [i, g] of p.groups.entries()) {
    const path = `populace.groups[${i}]`;
    if (!g || typeof g !== 'object') { out.push([path, '应为对象']); continue; }
    if (!ID_RE.test(g.id || '')) out.push([path, 'id 不合法']);
    else if (ids.has(g.id)) out.push([path, `id 重复：${g.id}`]);
    ids.add(g.id);
    if (!isStr(g.name, 8)) out.push([path, 'name 缺失或超过 8 字']);
    if (g.emoji != null && !isStr(g.emoji, 8)) out.push([path, 'emoji 不合法']);
    if (!Number.isInteger(g.size) || g.size < 0 || g.size > MAX_GROUP_SIZE) out.push([path, `size 应为 0~${MAX_GROUP_SIZE} 的整数`]);
    if (g.rhythm != null && !(RHYTHMS as readonly string[]).includes(g.rhythm)) out.push([path, `rhythm 只能是 ${RHYTHMS.join('/')}`]);
    for (const k of ['homes', 'haunts', 'work'] as const) {
      if (g[k] == null) continue;
      if (!Array.isArray(g[k]) || g[k].length > 16) { out.push([`${path}.${k}`, '应为最多 16 项的数组']); continue; }
      for (const id of g[k]) {
        if (k === 'homes' ? !isPlace(id) : !Object.hasOwn(locs, id)) out.push([`${path}.${k}`, `未知${k === 'homes' ? '建筑或地点' : '地点'}：${id}`]);
      }
    }
    for (const [k, v] of Object.entries<Raw>(g.traits || {})) {
      if (!['timid', 'curious', 'social'].includes(k)) out.push([`${path}.traits`, `未知性情：${k}`]);
      else if (!inRange(v, 0, 1)) out.push([`${path}.traits.${k}`, '应在 0~1']);
    }
    if (g.look?.tones != null && !(Array.isArray(g.look.tones) && g.look.tones.length <= 6 && g.look.tones.every((c: unknown) => typeof c === 'string' && COLOR_RE.test(c)))) out.push([`${path}.look.tones`, '应为最多 6 个 #rrggbb']);
  }
  for (const id of p.outside?.via || []) if (!Object.hasOwn(locs, id)) out.push(['populace.outside.via', `未知地点：${id}`]);
  if (p.outside?.name != null && !isStr(p.outside.name, 8)) out.push(['populace.outside.name', '超过 8 字']);
  if (p.scale != null && !inRange(p.scale, 0, 10000)) out.push(['populace.scale', '应在 0~10000']);
  for (const [id, n] of Object.entries<Raw>(p.capacity || {})) {
    if (!Object.hasOwn(locs, id)) out.push([`populace.capacity.${id}`, '未知地点']);
    else if (!Number.isInteger(n) || n < 1 || n > MAX_GROUP_SIZE) out.push([`populace.capacity.${id}`, `应为 1~${MAX_GROUP_SIZE} 的整数`]);
  }
  return out;
}

/** 地点的种类：户外地点写在 locations 上，室内地点看同名建筑 */
export function placeKind(spec: Pick<WorldSpec, 'locations' | 'buildings'>, id: string): string {
  const l = spec.locations?.[id] as { kind?: string } | undefined;
  if (l?.kind) return l.kind;
  const b = (spec.buildings || []).find((x) => x.id === id && !x.removed);
  return b?.kind || id;
}

const regionOf = (spec: Pick<WorldSpec, 'locations'>, id: string): string => (spec.locations?.[id] as { region?: string } | undefined)?.region || 'town';

function fill(g: PopulaceGroupSpec, i: number): PopGroup {
  const t = g.traits || {};
  return {
    id: g.id, name: g.name, emoji: g.emoji || '🧑', size: g.size,
    homes: [...(g.homes || [])], haunts: [...(g.haunts || [])], work: [...(g.work || [])],
    rhythm: g.rhythm || 'day',
    traits: { timid: t.timid ?? 0.5, curious: t.curious ?? 0.4, social: t.social ?? 0.5 },
    tones: g.look?.tones?.length ? [...g.look.tones] : [TONES[i % TONES.length]!, TONES[(i + 3) % TONES.length]!],
  };
}

/** 主地图上像住处的建筑（默认群众出门、回家的地方） */
function homeBuildings(spec: Pick<WorldSpec, 'buildings' | 'locations'>): string[] {
  return (spec.buildings || []).filter((b) => !b.removed && b.state !== 'ruin' && (b.region || 'town') === 'town' && RESIDENTIAL.has(b.kind)).map((b) => b.id);
}

/** 这个世界实际用的群众配置；null 表示没有群众 */
export function resolvePopulace(spec: Pick<WorldSpec, 'locations' | 'buildings' | 'meta' | 'voice'> & { populace?: PopulaceSpec; population?: Record<string, number> }): PopulaceConfig | null {
  const p = spec.populace;
  if (p) {
    const groups = (p.groups || []).map(fill).filter((g) => g.size > 0);
    if (!groups.length) return null;
    return { groups, outside: { name: p.outside?.name || '外地', via: [...(p.outside?.via || [])] }, scale: p.scale || 0, capacity: { ...(p.capacity || {}) }, source: 'spec' };
  }
  const legacy = Object.entries(spec.population || {}).filter(([id, n]) => Object.hasOwn(spec.locations || {}, id) && n > 0);
  if (legacy.length) {
    const size = legacy.reduce((s, [, n]) => s + n, 0);
    const pub = legacy.filter(([id]) => spec.locations[id]!.public).map(([id]) => id);
    const homes = legacy.filter(([id]) => !spec.locations[id]!.public).map(([id]) => id);
    return { groups: [fill({ id: 'citizen', name: '市民', size: Math.min(MAX_GROUP_SIZE, size), homes, haunts: pub }, 0)], outside: { name: '外地', via: [] }, scale: 0, capacity: {}, source: 'legacy' };
  }
  const pub = Object.keys(spec.locations || {}).filter((id) => spec.locations[id]!.public && regionOf(spec, id) === 'town');
  if (!pub.length) return null;
  const size = Math.max(DEFAULT_MIN, Math.min(DEFAULT_MAX, pub.length * DEFAULT_PER_PLACE));
  const name = (spec.voice as { resident?: string } | undefined)?.resident || '居民';
  const homes = homeBuildings(spec);
  const groups = [fill({ id: 'folk', name: name.slice(0, 8), size, homes, haunts: pub, traits: { timid: 0.5, curious: 0.4, social: 0.6 } }, 0)];
  if (spec.meta?.rating === 'cozy') groups.push(fill({ id: 'tourist', name: '游客', emoji: '🧳', size: Math.max(2, Math.round(size * 0.3)), haunts: pub, rhythm: 'visitor', traits: { timid: 0.3, curious: 0.8, social: 0.6 } }, 1));
  return { groups, outside: { name: '外地', via: [] }, scale: 0, capacity: {}, source: 'default' };
}
