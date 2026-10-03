// 叠加层（地图演变设计 §2、§7.2）：生成器只负责展开世界包里的基础地图，运行中的一切变化都在这里按顺序叠加上去。
//   拆除（removed）→ 新增建筑（added）→ 建筑状态（停业 / 受损 / 废墟）→ 连通性过滤
// 基础生成一行不动，所以云溪镇的基础瓦片与随机序列永远不变；两个生成器（yunxi-v1、layout-v1）共用这一段。
import { T, WALKABLE } from './tiles.ts';
import { paintOutdoor } from './brush.ts';
import { paintExtension } from './extend.ts';
import { BIOMES } from './layout.ts';
import type { Canvas, Cell, GenSpec, GenWorld, MapBuilding, MapLocation, MapObject, Rect } from '../types/map.ts';
import type { Region } from '../types/spec.ts';

/** 叠加阶段的画布：gate 已经确定（compose 之后）或仍是函数 */
type Composed = Canvas;

const REMOVABLE = new Set(['tree', 'bush', 'rock']);
const BUILDABLE = new Set<number>([T.GRASS, T.FLOWER, T.DIRT, T.SAND]);
const SOFT = new Set<number>([T.GRASS, T.FLOWER, T.SAND, T.DIRT, T.SOIL]); // 可以铺成路的地面
const SURFACE: Record<string, number> = { path: T.PATH, dirt: T.DIRT, plaza: T.PLAZA };
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cellHash = (x: number, y: number): number => (((x * 73856093) ^ (y * 19349663)) >>> 0) / 4294967296;
export const BUILDING_STATES = ['open', 'closed', 'damaged', 'ruin'];

/**
 * 扩大画布（地图演变 §5.1）：区域的尺寸大于基础地图、或有偏移时，把基础地图贴到 offset 位置，所有坐标跟着平移。
 * 没有扩展过的区域原样返回。
 */
function compose(c: Composed, region: Region): Composed {
  const [W2, H2] = Array.isArray(region.size) && region.baseSize ? region.size : [c.W, c.H];
  const ox = region.offset?.x || 0, oy = region.offset?.y || 0;
  const needBiome = (region.extensions || []).length > 0;
  if (W2 === c.W && H2 === c.H && !ox && !oy && !needBiome) return c;
  const { W, H } = c;
  const tiles: number[] = new Array(W2 * H2).fill(T.GRASS);
  const solid = new Uint8Array(W2 * H2);
  const biome = new Uint8Array(W2 * H2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y + oy) * W2 + x + ox;
    tiles[i] = c.tiles[y * W + x]!;
    solid[i] = c.solid[y * W + x]!;
    if (c.biome) biome[i] = c.biome[y * W + x]!;
  }
  // 叠加之后才能确定的渡口：在原画布上先算出来再平移
  const gate = typeof c.gate === 'function' ? c.gate() : c.gate;
  const seen = new Set<Cell>();
  const shift = (o: Cell | null | undefined) => { if (!o || seen.has(o)) return; seen.add(o); o.x += ox; o.y += oy; };
  for (const o of c.objects) shift(o);
  for (const b of c.buildings) { shift(b); shift(b.door); shift(b.entrance); }
  for (const l of Object.values(c.locations)) { shift(l.rect); for (const s of l.spots) shift(s); }
  for (const l of c.lamps) shift(l);
  const g = gate && { x: gate.x + ox, y: gate.y + oy };
  const origin = c.origin && { x: c.origin.x + ox, y: c.origin.y + oy };
  return {
    ...c, W: W2, H: H2, tiles, solid, gate: g, ...(origin ? { origin } : {}), biome,
    biomes: c.biomes ? c.biomes.map((b) => ({ ...b })) : [{ id: 'meadow', grass: BIOMES.meadow!.grass, blade: BIOMES.meadow!.blade }],
  };
}

/**
 * 把生成器的画布变成最终的地图。
 * @param {object} c 生成器的画布：{ W, H, tiles, solid, objects, buildings, locations, lamps, gate, origin?, carve(x, y), lampForAdded?, ...其余字段原样返回 }
 *   gate 可以是函数（叠加之后才能确定的渡口，例如 layout-v1 要避开新建筑）；origin 是连通性的起点，缺省为 gate
 * @param {object} region 规格里的区域
 * @param {object} spec 世界规格
 */
export function finishRegion(c0: Canvas, region: Region, spec: GenSpec): GenWorld {
  const c = compose(c0, region);
  const { W, H, tiles, solid, objects, buildings, locations, lamps } = c;
  const inb = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const get = (x: number, y: number): number => (inb(x, y) ? tiles[y * W + x] : -1);
  const set = (x: number, y: number, t: number) => inb(x, y) && (tiles[y * W + x] = t);
  const isSolid = (x: number, y: number) => !inb(x, y) || solid[y * W + x] || !WALKABLE.has(get(x, y));
  const block = (x: number, y: number) => inb(x, y) && (solid[y * W + x] = 1);
  const info = spec.locations || {};
  // 从入口开辟小路连到最近的道路（与生成器里的规则相同：哪些瓦片算路、哪些地面铺成泥路由生成器给出）
  const ROADS_OF = new Set(c.roads || [T.PATH, T.PLAZA, T.BRIDGE]);
  const DIRT_OVER = new Set(c.dirtOver || [T.GRASS, T.SAND]);
  const carve = (sx: number, sy: number) => {
    const prev = new Map<number, number | null>();
    const key = (x: number, y: number): number => y * W + x;
    const q: Array<[number, number]> = [[sx, sy]];
    prev.set(key(sx, sy), null);
    for (let qi = 0; qi < q.length; qi++) {
      const [x, y] = q[qi];
      if (ROADS_OF.has(get(x, y)) && !(x === sx && y === sy)) {
        for (let k = prev.get(key(x, y)); k !== null && k !== undefined; k = prev.get(k)) {
          const px = k % W, py = Math.floor(k / W);
          if (DIRT_OVER.has(get(px, py))) set(px, py, T.DIRT);
        }
        return true;
      }
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny) || prev.has(key(nx, ny)) || isSolid(nx, ny)) continue;
        prev.set(key(nx, ny), key(x, y));
        q.push([nx, ny]);
      }
    }
    return false;
  };
  const defs = (spec.buildings || []).filter((b) => (b.region || 'town') === region.id);

  // ---- 扩展块（地图演变 §5.1）：按顺序画地貌、主路与支路、装饰，并接到原地图的路上 ----
  for (const ext of region.extensions || []) {
    // 有扩展块时 compose 一定给出了 biome / biomes
    const biomes = c.biomes!;
    paintExtension({ W, H, tiles, solid, objects, biome: c.biome as Uint8Array, biomeIndex: (id: string) => {
      let i = biomes.findIndex((b) => b.id === id);
      if (i < 0) { biomes.push({ id, grass: BIOMES[id]!.grass, blade: BIOMES[id]!.blade }); i = biomes.length - 1; }
      return i;
    }, roads: ROADS_OF }, ext as { rect: Rect; side: string; biome?: string; seed?: number; bare?: boolean }, BIOMES);
  }

  // ---- 拆除：基础建筑照常参与了基础生成（保证随机序列不变），在这里变回空地 ----
  const lots: Array<Rect & { id: string; name: string }> = [];
  for (const def of defs.filter((b) => b.removed && !b.added)) {
    const i = buildings.findIndex((b) => b.id === def.id);
    if (i < 0) continue;
    const b = buildings[i]!;
    buildings.splice(i, 1);
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      if (!inb(x, y)) continue;
      solid[y * W + x] = 0;
      set(x, y, T.DIRT);
    }
    for (const [id, l] of Object.entries(locations)) if (id === b.id || l.indoor === b.id) delete locations[id];
    lots.push({ id: b.id, name: b.name, x: b.x, y: b.y, w: b.w, h: b.h });
  }

  // ---- 地形编辑（地图演变 §4）：按操作顺序；保存的是求解后的结果（具体格子），重放时不再求解 ----
  const clearAt = (x: number, y: number) => {
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (REMOVABLE.has(o.type) && o.x === x && o.y === y) { objects.splice(i, 1); solid[y * W + x] = 0; }
    }
  };
  const carveLater: Rect[] = [];
  for (const e of region.edits || []) {
    if (e.kind === 'path' || e.kind === 'bridge') {
      for (const [x, y] of e.cells || []) {
        if (!inb(x, y)) continue;
        clearAt(x, y);
        if (solid[y * W + x]) continue;
        const t = get(x, y);
        if (t === T.WATER || t === T.DEEP) set(x, y, T.BRIDGE);
        else if (e.kind === 'path' && SOFT.has(t)) set(x, y, SURFACE[e.surface as string] ?? T.PATH);
      }
    } else if (e.kind === 'clear') {
      const r = e.rect!;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inb(x, y)) clearAt(x, y);
    } else if (e.kind === 'grove') {
      for (const [x, y, kind] of e.trees || []) {
        if (!inb(x, y) || solid[y * W + x] || ![T.GRASS, T.FLOWER].includes(get(x, y))) continue;
        objects.push({ type: 'tree', x, y, kind: ['oak', 'pine', 'sakura'].includes(kind) ? kind : 'oak', v: cellHash(x, y) });
        block(x, y);
      }
    } else if (e.kind === 'place') {
      const r = e.rect!;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inb(x, y)) { clearAt(x, y); if (get(x, y) === T.FLOWER) set(x, y, T.GRASS); }
      paintOutdoor({ set, get, block, objects, rnd: mulberry32(e.seed || 1), H }, { rect: r, kind: e.placeKind as string });
      const spots: Cell[] = [];
      for (let y = r.y; y < r.y + r.h && spots.length < 12; y += 2) for (let x = r.x + (y % 2); x < r.x + r.w && spots.length < 12; x += 2) if (!isSolid(x, y)) spots.push({ x, y });
      const id = e.id as string;
      locations[id] = { id, name: info[id]?.name || id, emoji: info[id]?.emoji || '📍', desc: info[id]?.desc || '', spots, rect: { ...r } };
      carveLater.push(r);
    }
  }
  // 新的户外地点：从它的边缘出发，找最近的一段路，用泥路接上
  const ROAD = new Set<number>([T.PATH, T.PLAZA, T.BRIDGE, T.WOOD, T.DIRT]);
  const inside = (x: number, y: number, r: Rect): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  for (const r of carveLater) {
    const prev = new Map<number, number | null>();
    const q: Array<[number, number]> = [];
    for (let x = r.x - 1; x <= r.x + r.w; x++) for (const y of [r.y - 1, r.y + r.h]) if (!isSolid(x, y)) { prev.set(y * W + x, null); q.push([x, y]); }
    for (let y = r.y; y < r.y + r.h; y++) for (const x of [r.x - 1, r.x + r.w]) if (!isSolid(x, y)) { prev.set(y * W + x, null); q.push([x, y]); }
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i]!;
      if (ROAD.has(get(x, y))) {
        for (let k: number | null | undefined = y * W + x; k != null; k = prev.get(k)) { const px = k % W, py = Math.floor(k / W); if ([T.GRASS, T.FLOWER, T.SAND].includes(get(px, py))) set(px, py, T.DIRT); }
        break;
      }
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy, k = ny * W + nx;
        if (isSolid(nx, ny) || prev.has(k) || inside(nx, ny, r)) continue;
        prev.set(k, y * W + x);
        q.push([nx, ny]);
      }
    }
  }

  // ---- 边缘通道（地图演变 §5.2）：与相邻地图接壤的边上，从边缘开一条路接到最近的路（沿途清掉树丛），两侧位置对齐 ----
  const passages: NonNullable<GenWorld['passages']> = [];
  for (const e of region.entries || []) {
    const at = Math.round(e.at);
    const p = e.side === 'east' ? { x: W - 1, y: at } : e.side === 'west' ? { x: 0, y: at } : e.side === 'north' ? { x: at, y: 0 } : { x: at, y: H - 1 };
    if (!inb(p.x, p.y)) continue;
    const prev = new Map<number, number | null>([[p.y * W + p.x, null]]);
    const q: Array<[number, number]> = [[p.x, p.y]];
    const passable = (x: number, y: number): boolean => inb(x, y) && WALKABLE.has(get(x, y)) || (inb(x, y) && [T.WATER].includes(get(x, y)));
    const soft = (x: number, y: number): boolean => !solid[y * W + x] || objects.some((o) => REMOVABLE.has(o.type) && o.x === x && o.y === y);
    let hit: [number, number] | null = null;
    for (let i = 0; i < q.length && !hit; i++) {
      const [x, y] = q[i]!;
      if (ROADS_OF.has(get(x, y)) && !(x === p.x && y === p.y)) { hit = [x, y]; break; }
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy, k = ny * W + nx;
        if (prev.has(k) || !passable(nx, ny) || !soft(nx, ny)) continue;
        prev.set(k, y * W + x);
        q.push([nx, ny]);
      }
    }
    if (!hit) continue;
    for (let k: number | null | undefined = hit[1] * W + hit[0]; k != null; k = prev.get(k)) {
      const px = k % W, py = Math.floor(k / W);
      clearAt(px, py);
      const t = get(px, py);
      if (t === T.WATER) set(px, py, T.BRIDGE);
      else if ([T.GRASS, T.FLOWER, T.SAND, T.SOIL].includes(t)) set(px, py, T.DIRT);
    }
    passages.push({ key: e.key, to: e.to, side: e.side, x: p.x, y: p.y, name: (e as { name?: string }).name || null });
  }

  // ---- 运行中新增的建筑：清理占地及周围一格的树木 / 灌木 / 石头，开辟连到道路的小路 ----
  const overlayErrors: Record<string, string> = {};
  const inRect = (x: number, y: number, r: Rect, m = 0): boolean => x >= r.x - m && x < r.x + r.w + m && y >= r.y - m && y < r.y + r.h + m;
  for (const def of defs.filter((b) => b.added && !b.removed)) {
    const door = { x: def.x + Math.floor(def.w / 2), y: def.y + def.h - 1 };
    const entrance = { x: door.x, y: door.y + 1 };
    let err: string | null = null;
    for (let y = def.y; y < def.y + def.h && !err; y++) {
      for (let x = def.x; x < def.x + def.w && !err; x++) {
        if (!inb(x, y) || !BUILDABLE.has(get(x, y))) err = `(${x},${y}) 不是可以建房的地面`;
        else if (solid[y * W + x] && !objects.some((o) => REMOVABLE.has(o.type) && o.x === x && o.y === y)) err = `(${x},${y}) 已被占用`;
      }
    }
    // 与已有建筑至少隔一格
    if (!err && buildings.some((b) => b.x < def.x + def.w + 1 && b.x + b.w + 1 > def.x && b.y < def.y + def.h + 1 && b.y + b.h + 1 > def.y)) err = '和已有建筑挨得太近';
    if (!err && (!inb(entrance.x, entrance.y) || !WALKABLE.has(get(entrance.x, entrance.y)))) err = '门口不能通行';
    if (err) { overlayErrors[def.id] = err; continue; }
    // 清理占地（含门口一列）周围的可移除物体
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (REMOVABLE.has(o.type) && (inRect(o.x, o.y, def, 1) || (o.x === entrance.x && o.y <= entrance.y + 1 && o.y >= entrance.y))) {
        objects.splice(i, 1);
        solid[o.y * W + o.x] = 0;
      }
    }
    for (let y = def.y; y < def.y + def.h; y++) for (let x = def.x; x < def.x + def.w; x++) block(x, y);
    const b: MapBuilding = { ...def, door, entrance };
    buildings.push(b);
    carve(entrance.x, entrance.y);
    locations[b.id] = { id: b.id, name: b.name || info[b.id]?.name, emoji: info[b.id]?.emoji || '🏠', desc: info[b.id]?.desc || '', spots: [], indoor: b.id, rect: b };
    if (def.lightAtNight && c.lampForAdded) {
      const lx = Math.min(W - 1, def.x + def.w), ly = def.y + def.h - 1;
      if (!solid[ly * W + lx] && WALKABLE.has(get(lx, ly))) { objects.push({ type: 'lamp', x: lx, y: ly }); block(lx, ly); lamps.push({ x: lx, y: ly }); }
    }
  }

  // ---- 建筑状态：停业 / 受损只能到门口；废墟不再是室内地点，而是可以在周围走动的户外地点 ----
  for (const b of buildings) {
    const def = defs.find((d) => d.id === b.id);
    const state = def?.state && def.state !== 'open' ? def.state : null;
    if (!state) continue;
    b.state = state;
    const l = locations[b.id];
    if (!l) continue;
    const around = [[0, 0], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => ({ x: b.entrance.x + dx!, y: b.entrance.y + dy! }))
      .filter((s) => !isSolid(s.x, s.y));
    if (state === 'ruin') {
      delete l.indoor;
      l.ruin = true;
      l.spots = around;
    } else {
      l.closed = state;
      if (!l.spots.length) l.spots = around;
    }
  }

  // ---- 渡口（可以是叠加之后才确定的）与连通性：丢弃不可达的站位 ----
  const gate = typeof c.gate === 'function' ? c.gate() : c.gate;
  const origin = c.origin || gate;
  const walk = new Uint8Array(W * H);
  const q: Array<[number, number]> = [[origin.x, origin.y]];
  walk[origin.y * W + origin.x] = 1;
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (isSolid(nx, ny) || walk[ny * W + nx]) continue;
      walk[ny * W + nx] = 1;
      q.push([nx, ny]);
    }
  }
  for (const l of Object.values(locations)) l.spots = l.spots.filter((s) => walk[Math.round(s.y) * W + Math.round(s.x)]);
  for (const b of buildings) if (!walk[b.entrance.y * W + b.entrance.x]) console.warn(`[worldgen] ${region.id}：入口不可达：${b.id}`);

  const { solid: _s, origin: _o, lampForAdded: _l, gate: _g, roads: _r, dirtOver: _d, ...rest } = c;
  if (rest.biome && !Array.isArray(rest.biome)) rest.biome = [...rest.biome];
  return { ...rest, id: region.id, walk, overlayErrors, gate, ...(lots.length ? { lots } : {}), ...(passages.length ? { passages: passages.filter((p) => walk[p.y * W + p.x]) } : {}) } as unknown as GenWorld; // rest 里是画布的其余字段（W、H、tiles……），原样返回
}
