// 语义化放置（设计文档 5.3）：AI 只描述「靠近哪里、多大」，由这里寻找合法位置并校验连通性。
// 校验标准：占地可建、与其他建筑隔一格、门口能走到、原有建筑入口仍然可达、各地点的可达站位一个都不少。
import { T } from '../world.ts';
import { buildRegion } from '../worldgen/index.ts';
import type { Building, Location, Region, WorldSpec } from '../types/spec.ts';

import type { Cell, GenSpec, GenWorld } from '../types/map.ts';

export type { GenWorld } from '../types/map.ts';
/** 新建筑的描述（addBuilding 的参数加上求得的位置） */
export interface BuildingDef { id: string; name?: string; emoji?: string; desc?: string; x?: number; y?: number; w: number; h: number; [k: string]: unknown }
/** 地形编辑（地图演变 §4） */
export interface TerrainEdit { kind: 'clear' | 'grove' | 'place' | (string & {}); id?: string | null; placeKind?: string | null; rect?: { x: number; y: number; w: number; h: number }; trees?: Array<[number, number, string]>; seed?: number; [k: string]: unknown }
type Region2 = Region & { edits?: TerrainEdit[] };
const build = (region: Region | undefined, spec: GenSpec): GenWorld => buildRegion(region!, spec);

const BUILDABLE = new Set<number>([T.GRASS, T.FLOWER, T.DIRT, T.SAND]);
const MAX_FULL_CHECKS = 24;

// 用主地图自己的生成器重建（云溪镇是 yunxi-v1，创世生成的世界是 layout-v1）
const worldOf = (spec: WorldSpec, extra: BuildingDef | null = null): GenWorld => build(spec.regions!.find((r) => r.id === 'town'), {
  ...spec,
  // 候选建筑只用来校验能不能放下：字段不全，按建筑处理即可
  buildings: extra ? [...spec.buildings, { ...extra, added: true } as unknown as Building] : spec.buildings,
  locations: extra ? { ...spec.locations, [extra.id]: { name: extra.name, emoji: extra.emoji || '🏠', desc: extra.desc || '' } as Location } : spec.locations,
});

/** 地点的中心点（站位、入口或区域中心） */
export function locationCenter(world: GenWorld, id: string): Cell | null {
  const l = world.locations[id];
  if (!l) return null;
  if (l.indoor) {
    const b = world.buildings.find((x) => x.id === l.indoor);
    if (b) return { x: b.entrance.x, y: b.entrance.y };
  }
  if (l.rect) return { x: Math.round(l.rect.x + l.rect.w / 2), y: Math.round(l.rect.y + l.rect.h / 2) };
  if (l.spots?.length) return { x: l.spots[0].x, y: l.spots[0].y };
  return null;
}

/** 完整校验：以新建筑重建地图，返回 null 或错误原因 */
export function checkPlacement(spec: WorldSpec, def: BuildingDef, base: GenWorld = worldOf(spec)): string | null {
  const w = worldOf(spec, def);
  if (w.overlayErrors[def.id]) return w.overlayErrors[def.id];
  const b = w.buildings.find((x) => x.id === def.id);
  if (!b || !w.walk[b.entrance.y * w.W + b.entrance.x]) return '新建筑的门口走不到';
  for (const ob of w.buildings) if (!w.walk[ob.entrance.y * w.W + ob.entrance.x]) return `会挡住「${ob.name}」的入口`;
  for (const [id, l] of Object.entries(base.locations)) {
    if ((w.locations[id]?.spots.length ?? 0) < l.spots.length) return `会挡住「${l.name}」的站位`;
  }
  return null;
}

/**
 * 在 near 地点附近（within 格内）寻找放得下 w×h 建筑的位置。
 * 返回 { x, y } 或 { error }。
 */
export function findPlacement(spec: WorldSpec, { id, name = '', w, h, near, within = 12 }: { id: string; name?: string; w: number; h: number; near: string; within?: number }): { x: number; y: number; error?: undefined } | { error: string; x?: undefined; y?: undefined } {
  const base = worldOf(spec);
  const c = locationCenter(base, near);
  if (!c) return { error: `未知地点：${near}` };
  const { W, H, tiles, walk, objects, buildings } = base;
  const removable = new Set(objects.filter((o) => ['tree', 'bush', 'rock'].includes(o.type)).map((o) => o.y * W + o.x));
  const quick = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x + w > W - 1 || y + h > H - 2) return false;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = yy * W + xx;
      if (!BUILDABLE.has(tiles[i]!) || (!walk[i] && !removable.has(i))) return false;
    }
    if (buildings.some((b) => b.x < x + w + 1 && b.x + b.w + 1 > x && b.y < y + h + 1 && b.y + b.h + 1 > y)) return false;
    const ex = x + Math.floor(w / 2), ey = y + h;
    return Boolean(walk[ey * W + ex]);
  };
  const cands: Array<{ x: number; y: number; d: number }> = [];
  for (let y = c.y - within - h; y <= c.y + within; y++) {
    for (let x = c.x - within - w; x <= c.x + within; x++) {
      const ex = x + Math.floor(w / 2), ey = y + h;
      const d = Math.hypot(ex - c.x, ey - c.y);
      if (d <= within && quick(x, y)) cands.push({ x, y, d });
    }
  }
  cands.sort((p, q) => p.d - q.d);
  let lastErr = '附近没有足够大的空地';
  for (const cand of cands.slice(0, MAX_FULL_CHECKS)) {
    const err = checkPlacement(spec, { id, name, x: cand.x, y: cand.y, w, h }, base);
    if (!err) return { x: cand.x, y: cand.y };
    lastErr = err;
  }
  return { error: `在「${base.locations[near]!.name}」附近找不到合适的位置（${lastErr}）` };
}

// ---------- 地形编辑的求解（地图演变 §4）：AI 只说意图，这里给出具体的格子，并在应用前完整校验 ----------
import { OUTDOOR_KINDS } from '../worldgen/layout.ts';

const ROADS = new Set<number>([T.PATH, T.PLAZA, T.BRIDGE, T.WOOD, T.DIRT]);
const SOFT = new Set<number>([T.GRASS, T.FLOWER, T.SAND, T.SOIL]);
const WATERS = new Set<number>([T.WATER, T.DEEP]);
const MAX_BRIDGE = 4; // 修路时能顺带架桥的最宽水面
const townRegion = (spec: WorldSpec): Region | undefined => spec.regions!.find((r) => r.id === 'town');
const withEdit = (spec: WorldSpec, edit: TerrainEdit): WorldSpec => ({ ...spec, regions: spec.regions!.map((r: Region2) => (r.id === 'town' ? { ...r, edits: [...(r.edits || []), edit] } : r)) });

/** 以一条地形编辑重建主地图并校验：入口都走得到、原有地点的站位不减少、新地点至少有一个站位 */
export function checkEdit(spec: WorldSpec, edit: TerrainEdit, base: GenWorld = worldOf(spec)): string | null {
  const w = build(townRegion(withEdit(spec, edit)), withEdit(spec, edit));
  for (const b of w.buildings) if (!w.walk[b.entrance.y * w.W + b.entrance.x]) return `会挡住「${b.name}」的入口`;
  for (const [id, l] of Object.entries(base.locations)) {
    if ((w.locations[id]?.spots.length ?? 0) < l.spots.length) return `会挡住「${l.name}」的站位`;
  }
  if (edit.kind === 'place' && !w.locations[edit.id ?? '']?.spots.length) return '新地点走不进去';
  return null;
}

/** 修路：两地点之间代价最低的一条路（已有的路最便宜，草地其次，树丛要砍，窄水面架桥），只返回需要铺的格子 */
export function solvePath(spec: WorldSpec, from: string, to: string): { cells: Array<[number, number]>; error?: undefined } | { error: string; cells?: undefined } {
  if (!from || !to) return { error: `addPath 缺少 ${!from ? 'from' : 'to'}（参数写在 args 里：{"op":"addPath","args":{"from":"地点id","to":"地点id"}}）` };
  const w = worldOf(spec);
  const a = locationCenter(w, from), b = locationCenter(w, to);
  if (!a) return { error: `未知地点：${from}` };
  if (!b) return { error: `未知地点：${to}` };
  const { W, H, tiles, walk, objects } = w;
  const removable = new Set(objects.filter((o) => ['tree', 'bush', 'rock'].includes(o.type)).map((o) => o.y * W + o.x));
  const cost = (i: number): number => {
    const t = tiles[i]!;
    if (WATERS.has(t)) return 6;
    if (walk[i]) return ROADS.has(t) ? 1 : 1.4;
    if (removable.has(i) && SOFT.has(t)) return 2.5;
    return Infinity;
  };
  const dist = new Float64Array(W * H).fill(Infinity);
  const prev = new Int32Array(W * H).fill(-1);
  const start = a.y * W + a.x, goal = b.y * W + b.x;
  dist[start] = 0;
  // 二叉堆
  const heap: Array<[number, number]> = [[0, start]];
  const push = (d: number, i: number) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p]![0] <= heap[k]![0]) break; [heap[p], heap[k]] = [heap[k]!, heap[p]!]; k = p; } };
  const pop = (): [number, number] => { const top = heap[0]!; const last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l; if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k]!, heap[m]!]; k = m; } } return top; };
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]!) continue;
    if (i === goal) break;
    const x = i % W, y = Math.floor(i / W);
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      const c = j === goal ? 1 : cost(j);
      if (d + c < dist[j]!) { dist[j] = d + c; prev[j] = i; push(d + c, j); }
    }
  }
  if (!Number.isFinite(dist[goal])) return { error: `「${w.locations[from]!.name}」和「${w.locations[to]!.name}」之间找不到可以修路的地方` };
  const cells: Array<[number, number]> = [];
  let run = 0;
  for (let i = goal; i !== -1; i = prev[i]!) {
    run = WATERS.has(tiles[i]!) ? run + 1 : 0;
    if (run > MAX_BRIDGE) return { error: `路上要跨过超过 ${MAX_BRIDGE} 格宽的水面，需要先架桥（addBridge）` };
    if (!ROADS.has(tiles[i]!)) cells.push([i % W, Math.floor(i / W)]);
  }
  if (!cells.length) return { error: '这两个地方之间已经有路了' };
  return { cells: cells.reverse() };
}

/** 架桥：地点附近最窄的一段水面（横着或竖着），两头都是能走的地 */
export function solveBridge(spec: WorldSpec, near: string, within = 12): { cells: Array<[number, number]>; error?: undefined } | { error: string; cells?: undefined } {
  const w = worldOf(spec);
  const c = locationCenter(w, near);
  if (!c) return { error: `未知地点：${near}` };
  const { W, H, tiles, walk } = w;
  let best: { cells: Array<[number, number]>; d: number } | null = null;
  for (let y = Math.max(1, c.y - within); y <= Math.min(H - 2, c.y + within); y++) {
    for (let x = Math.max(1, c.x - within); x <= Math.min(W - 2, c.x + within); x++) {
      const i = y * W + x;
      if (!walk[i] || WATERS.has(tiles[i]!)) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const cells: Array<[number, number]> = [];
        let nx = x + dx, ny = y + dy;
        while (nx < W && ny < H && WATERS.has(tiles[ny * W + nx]!) && cells.length <= 6) { cells.push([nx, ny]); nx += dx; ny += dy; }
        if (!cells.length || cells.length > 6 || nx >= W || ny >= H || !walk[ny * W + nx]) continue;
        const d = Math.hypot(x - c.x, y - c.y);
        if (!best || cells.length < best.cells.length || (cells.length === best.cells.length && d < best.d)) best = { cells, d };
      }
    }
  }
  return best ? { cells: best.cells } : { error: `「${w.locations[near]!.name}」附近没有适合架桥的水面` };
}

/**
 * 在地点附近找一块 w×h 的地：
 *   clear 清地（里面至少有 3 棵树 / 灌木 / 石头）；grove 种树（空草地）；place 新户外地点（可以建房的空地）
 */
export function solveRect(spec: WorldSpec, { mode, w: rw, h: rh, near, within = 14, id = null, placeKind = null, seed = 1 }: { mode: 'clear' | 'grove' | 'place'; w: number; h: number; near: string; within?: number; id?: string | null; placeKind?: string | null; seed?: number }): { rect: { x: number; y: number; w: number; h: number }; trees?: Array<[number, number, string]>; error?: undefined } | { error: string; rect?: undefined; trees?: undefined } {
  const w = worldOf(spec);
  const c = locationCenter(w, near);
  if (!c) return { error: `未知地点：${near}` };
  const { W, H, tiles, walk, objects, buildings } = w;
  const removable = new Map(objects.filter((o) => ['tree', 'bush', 'rock'].includes(o.type)).map((o) => [o.y * W + o.x, o]));
  const occupied = new Set(objects.map((o) => o.y * W + o.x));
  const reserved = new Set<number>();
  for (const l of Object.values(w.locations)) {
    for (const s of l.spots) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) reserved.add((s.y + dy) * W + s.x + dx);
    if (l.rect && !l.indoor) for (let y = l.rect.y; y < l.rect.y + l.rect.h; y++) for (let x = l.rect.x; x < l.rect.x + l.rect.w; x++) reserved.add(y * W + x);
  }
  for (const b of buildings) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) reserved.add((b.entrance.y + dy) * W + b.entrance.x + dx);
  const quick = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x + rw > W - 1 || y + rh > H - 2) return false;
    if (buildings.some((b) => b.x < x + rw + 1 && b.x + b.w + 1 > x && b.y < y + rh + 1 && b.y + b.h + 1 > y)) return false;
    let n = 0;
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) {
      const i = yy * W + xx;
      if (mode === 'clear') { if (removable.has(i)) n++; continue; }
      if (reserved.has(i)) return false;
      if (mode === 'grove') { if (!([T.GRASS, T.FLOWER] as number[]).includes(tiles[i]!) || (occupied.has(i) && !removable.has(i))) return false; if (!occupied.has(i)) n++; continue; }
      if (mode === 'place' && (!BUILDABLE.has(tiles[i]!) || (!walk[i] && !removable.has(i)))) return false;
    }
    return mode === 'clear' ? n >= 3 : mode === 'grove' ? n * 2 >= rw * rh : true;
  };
  const cands: Array<{ x: number; y: number; d: number }> = [];
  for (let y = c.y - within - rh; y <= c.y + within; y++) for (let x = c.x - within - rw; x <= c.x + within; x++) {
    const d = Math.hypot(x + rw / 2 - c.x, y + rh / 2 - c.y);
    if (d <= within && quick(x, y)) cands.push({ x, y, d });
  }
  cands.sort((p, q) => p.d - q.d);
  let lastErr = mode === 'clear' ? '附近没有需要清理的树丛' : '附近没有足够大的空地';
  for (const cand of cands.slice(0, MAX_FULL_CHECKS)) {
    const rect = { x: cand.x, y: cand.y, w: rw, h: rh };
    const edit: TerrainEdit = mode === 'clear' ? { kind: 'clear', rect }
      : mode === 'grove' ? { kind: 'grove', trees: groveTrees(rect, seed).filter(([x, y]) => !occupied.has(y * W + x)) }
        : { kind: 'place', id, placeKind, rect, seed };
    const err = mode === 'clear' ? null : checkEdit(spec, edit, w);
    if (!err) return { rect, ...(edit.trees ? { trees: edit.trees } : {}) };
    lastErr = err;
  }
  return { error: `在「${w.locations[near]!.name}」附近找不到合适的地方（${lastErr}）` };
}

/** 树林：隔一格种一棵，品种按位置稳定地挑 */
export function groveTrees(rect: { x: number; y: number; w: number; h: number }, seed = 1, kinds: string[] = ['oak', 'pine']): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    if ((x + y) % 2) continue;
    out.push([x, y, kinds[(x * 7 + y * 13 + seed) % kinds.length]!]);
  }
  return out;
}

export const outdoorSize = (kind: string) => (OUTDOOR_KINDS as Record<string, unknown>)[kind] || null;

/**
 * 相邻地图的通道（地图演变 §5.2）：沿接壤的边找离现有道路最近的位置（沿途只能是能走的地或可以清掉的树丛），
 * 边长 ≥ 40 时再找一个相隔至少 12 格的。返回 { passages: [坐标] } 或 { error }
 */
export function choosePassages(spec: WorldSpec, regionId: string, side: 'east' | 'west' | 'north' | 'south'): { passages: number[]; error?: undefined } | { error: string; passages?: undefined } {
  const region = spec.regions!.find((r) => r.id === regionId);
  if (!region) return { error: `未知区域：${regionId}` };
  const w = build(region, spec);
  const { W, H, tiles, walk, objects } = w;
  const removable = new Set(objects.filter((o) => ['tree', 'bush', 'rock'].includes(o.type)).map((o) => o.y * W + o.x));
  const ok = (x: number, y: number): boolean => Boolean(x >= 0 && y >= 0 && x < W && y < H && (walk[y * W + x] || (removable.has(y * W + x) && SOFT.has(tiles[y * W + x]!)) || (SOFT.has(tiles[y * W + x]!) && !objects.some((o) => o.x === x && o.y === y))));
  const vertical = side === 'east' || side === 'west';
  const len = vertical ? H : W;
  const edge = (i: number): Cell => (side === 'east' ? { x: W - 1, y: i } : side === 'west' ? { x: 0, y: i } : side === 'north' ? { x: i, y: 0 } : { x: i, y: H - 1 });
  const score = (i: number): number => {
    const p = edge(i);
    if (!ok(p.x, p.y)) return Infinity;
    const seen = new Set([p.y * W + p.x]);
    let frontier: Array<[number, number]> = [[p.x, p.y]];
    for (let d = 0; d <= 16 && frontier.length; d++) {
      const next: Array<[number, number]> = [];
      for (const [x, y] of frontier) {
        if (ROADS.has(tiles[y * W + x]!) && walk[y * W + x]) return d;
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
          const nx = x + dx, ny = y + dy, k = ny * W + nx;
          if (seen.has(k) || !ok(nx, ny)) continue;
          seen.add(k);
          next.push([nx, ny]);
        }
      }
      frontier = next;
    }
    return Infinity;
  };
  const cands: Array<{ i: number; s: number }> = [];
  for (let i = 3; i <= len - 4; i++) { const s = score(i); if (Number.isFinite(s)) cands.push({ i, s: s + Math.abs(i - len / 2) * 0.05 }); }
  cands.sort((a, b) => a.s - b.s);
  if (!cands.length) return { error: '接壤的这条边上找不到能开路的地方' };
  const out = [cands[0]!.i];
  if (len >= 40) { const second = cands.find((c) => Math.abs(c.i - out[0]!) >= 12); if (second) out.push(second.i); }
  return { passages: out.sort((a, b) => a - b) };
}
