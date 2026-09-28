// 生成器 layout-v1（多世界设计 §3.2）：LLM 与世界包作者只写「语义布局」，由这里确定性地展开成瓦片。
//   区域图 → 布局求解（每个区域一块地、每个地点一个位置）→ 地形笔刷（biome 决定地块调色板与装饰物分布）
//
// map.json 里的区域：
//   { "id": "town", "generator": "layout-v1", "name": "森林边的村子", "seed": 7, "size": [64, 44], "gate": "village_gate",
//     "areas": [{ "id": "village", "biome": "meadow", "size": "medium",
//                 "places": [{ "id": "red_house", "kind": "cottage", "name": "小红帽家", "emoji": "🏠", "desc": "…", "public": false,
//                              "style": { "roof": "#c0392b", "wall": "#f2e2c2", "roofShape": "thatch", "decor": ["chimney", "flowers"] } }] }],
//     "links": [{ "from": "village", "to": "forest", "via": "path" }] }
// 建筑的坐标由求解器给出（packSpec 时写进规格的 buildings / locations），之后运行中新增的建筑（addBuilding）照常叠加。
import { findPath } from '../world.ts';
import { T, WALKABLE } from './tiles.ts';
import { finishRegion } from './finish.ts';
import { paintOutdoor } from './brush.ts';
import type { Cell, GenSpec, GenWorld, MapBuilding, MapLocation, MapObject, Rect } from '../types/map.ts';
import type { Building, Location, Region } from '../types/spec.ts';

/** map.json 里区域块中的一个地点 */
interface Place {
  id: string;
  kind: string;
  name?: string;
  emoji?: string;
  desc?: string;
  public?: boolean;
  /** kind 不认识时，按户外地点处理 */
  outdoor?: boolean;
  /** 自定义占地 [宽, 高] */
  size?: number[];
  sign?: string;
  style?: { roof?: string; wall?: string; roofShape?: string; decor?: string[]; material?: string; sign?: string };
}
/** 区域块 */
interface Area { id: string; biome?: string; size?: string; places?: Place[] }
/** 求解出的地点位置 */
interface Placed { rect: Rect; kind: string; outdoor: boolean; area: string }
const areasOf = (region: Region): Area[] => (region.areas || []) as Area[];

// 建筑类的地点：占地（宽 × 高）
export const BUILDING_KINDS: Record<string, [number, number]> = {
  hut: [4, 4], cabin: [4, 4], cottage: [5, 5], house: [5, 5], farmhouse: [5, 5], shop: [6, 5], bakery: [6, 5], clinic: [6, 5],
  workshop: [6, 4], barn: [6, 5], mill: [5, 6], inn: [7, 6], tavern: [7, 6], library: [8, 6], school: [8, 6], temple: [7, 6],
  tower: [4, 6], castle: [10, 7], palace: [10, 7], hall: [8, 6], cafe: [7, 6],
  // 现代题材（黑暗叙事设计 §4.13）
  apartment: [7, 7], office: [7, 6], hospital: [9, 6], station: [8, 5], police: [6, 5], store: [6, 5], archive: [6, 5],
};
// 户外地点：占地
export const OUTDOOR_KINDS: Record<string, [number, number]> = {
  plaza: [9, 7], square: [9, 7], market: [9, 6], garden: [7, 6], clearing: [7, 6], meadow: [8, 6], field: [9, 6], farm: [9, 6],
  orchard: [8, 6], well: [4, 4], pond: [7, 5], grove: [7, 6], camp: [6, 5], dock: [4, 5], gate: [4, 3], shrine: [4, 4], graveyard: [6, 5],
  bridge: [4, 4], path: [5, 4],
  street: [8, 5], alley: [5, 4], parking: [8, 6], park: [9, 7],
};
const AREA_WEIGHT: Record<string, number> = { small: 1, medium: 2, large: 3 };

// 地貌：地块调色板（前端按它画草地）与装饰物分布
/** 地貌：地块调色板与装饰物的分布（trees：树种 → 权重；tree / flower / rock / bush：每格出现的概率） */
export interface Biome { grass: string[]; blade: string[]; trees: Record<string, number>; tree: number; flower: number; rock: number; bush: number }

export const BIOMES: Record<string, Biome> = {
  meadow: { grass: ['#68a74a', '#8cc963'], blade: ['#5a9640', '#9fd877'], trees: { oak: 0.7, pine: 0.2, sakura: 0.1 }, tree: 0.06, flower: 0.1, rock: 0.02, bush: 0.04 },
  village: { grass: ['#6aa94c', '#8ec865'], blade: ['#5a9640', '#9fd877'], trees: { oak: 0.8, sakura: 0.2 }, tree: 0.04, flower: 0.08, rock: 0.01, bush: 0.04 },
  forest: { grass: ['#4f8a3c', '#6aa34e'], blade: ['#3f7a32', '#7fb85c'], trees: { oak: 0.55, pine: 0.45 }, tree: 0.3, flower: 0.04, rock: 0.03, bush: 0.08 },
  dark_forest: { grass: ['#2f5a33', '#40703f'], blade: ['#244a28', '#56864a'], trees: { pine: 0.8, oak: 0.2 }, tree: 0.42, flower: 0.01, rock: 0.04, bush: 0.1 },
  snow: { grass: ['#dfe8ef', '#f4f8fb'], blade: ['#c8d6e0', '#ffffff'], trees: { pine: 1 }, tree: 0.1, flower: 0, rock: 0.04, bush: 0.02 },
  desert: { grass: ['#e2c98f', '#efd9a4'], blade: ['#cdb27a', '#f5e3b8'], trees: {}, tree: 0, flower: 0, rock: 0.06, bush: 0.02 },
  autumn: { grass: ['#9fa04a', '#c4a24e'], blade: ['#8a8a3a', '#d8b860'], trees: { oak: 0.85, pine: 0.15 }, tree: 0.12, flower: 0.03, rock: 0.02, bush: 0.05 },
  swamp: { grass: ['#4d6b44', '#667f4c'], blade: ['#3c5a36', '#7a9458'], trees: { oak: 0.6, pine: 0.4 }, tree: 0.15, flower: 0.02, rock: 0.01, bush: 0.12 },
  lake: { grass: ['#68a74a', '#8cc963'], blade: ['#5a9640', '#9fd877'], trees: { oak: 0.6, pine: 0.4 }, tree: 0.05, flower: 0.06, rock: 0.02, bush: 0.03 },
  // 城市：灰色的水泥地，行道树稀少
  urban: { grass: ['#6f7176', '#7d7f84'], blade: ['#63656a', '#8b8d92'], trees: { oak: 1 }, tree: 0.004, flower: 0, rock: 0.015, bush: 0.01 },
  // 老城区：更暗、更旧
  old_town: { grass: ['#5d5a55', '#6b6760'], blade: ['#524f4a', '#77726a'], trees: { oak: 0.7, pine: 0.3 }, tree: 0.012, flower: 0, rock: 0.04, bush: 0.03 },
};
export const BIOME_IDS = Object.keys(BIOMES);

function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s: unknown): number => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/** 区域现在的总尺寸（扩展之后的）；regionSize 是生成器用的基础尺寸 */
export function mapSize(region: Region): number[] { return Array.isArray(region.baseSize) && Array.isArray(region.size) ? region.size : regionSize(region); }

/** 区域的地图尺寸：写了就用写的，否则按区域数量估算 */
export function regionSize(region: Region): number[] {
  // 扩展过的区域：生成器仍按基础尺寸生成，size 是扩展之后的总尺寸
  if (Array.isArray(region.baseSize)) return region.baseSize as number[];
  if (Array.isArray(region.size) && region.size.length === 2) return region.size.map((n) => Math.max(24, Math.min(96, Math.round(n))));
  const weight = areasOf(region).reduce((s, a) => s + (AREA_WEIGHT[a.size ?? ''] || 2), 0);
  return weight > 8 ? [80, 52] : weight > 5 ? [64, 44] : [52, 38];
}

/** 把区域排成一行或两行，宽度按大小加权（每块至少放得下自己最宽的地点）：返回每个区域的矩形 */
function partition(areas: Area[], W: number, H: number): Record<string, Rect> {
  const rows = areas.length <= 3 ? [areas] : [areas.filter((_, i) => i % 2 === 0), areas.filter((_, i) => i % 2 === 1)];
  const out: Record<string, Rect> = {};
  const top = 2, bottom = H - 2, left = 2, right = W - 2;
  const rowH = Math.floor((bottom - top) / rows.length);
  rows.forEach((row, r) => {
    const avail = right - left;
    const minW = row.map((a) => Math.max(10, ...(a.places || []).map((p) => sizeOf(p)[0] + 5)));
    const weight = row.map((a) => AREA_WEIGHT[a.size ?? ''] || 2);
    const total = weight.reduce((s, w) => s + w, 0);
    // 先按权重分，再把不够最小宽度的补足、从最宽的那块里扣回来
    const widths = weight.map((w) => Math.floor((avail * w) / total));
    for (let i = 0; i < widths.length; i++) {
      while (widths[i]! < minW[i]!) {
        const j = widths.reduce((best, w, k) => (k !== i && w - minW[k]! > widths[best]! - minW[best]! ? k : best), i === 0 ? 1 % widths.length : 0);
        if (j === i || widths[j]! <= minW[j]!) break;
        widths[j]!--; widths[i]!++;
      }
    }
    let x = left;
    row.forEach((a, i) => {
      const w = i === row.length - 1 ? right - x : widths[i]!;
      out[a.id] = { x, y: top + r * rowH, w, h: r === rows.length - 1 ? bottom - (top + r * rowH) : rowH };
      x += w;
    });
  });
  return out;
}

/**
 * 布局求解：每个地点放在所属区域里（货架式排布，建筑之间至少隔两格，门口下面留出通道）。
 * 返回 { buildings, locations, rects, problems }，只依赖区域描述，确定性。
 */
export function solveLayout(region: Region): { W: number; H: number; buildings: Building[]; locations: Record<string, Location>; rects: Record<string, Rect>; places: Record<string, Placed>; problems: string[] } {
  const [W, H] = regionSize(region) as [number, number];
  const areas = areasOf(region);
  const rects = partition(areas, W, H);
  const buildings: Building[] = [];
  const locations: Record<string, Location> = {};
  const places: Record<string, Placed> = {}; // 地点 id → { rect, kind, outdoor, area }
  const problems: string[] = [];
  for (const a of areas) {
    const r = rects[a.id]!;
    const lake = a.biome === 'lake';
    // 湖区：地点沿着上边排，下面是水
    let x = r.x + 2, y = r.y + 2, rowH = 0;
    const maxX = r.x + r.w - 2, maxY = lake ? r.y + Math.floor(r.h * 0.45) : r.y + r.h - 3;
    const list = [...(a.places || [])].sort((p, q) => (sizeOf(q)[1] - sizeOf(p)[1]) || String(p.id).localeCompare(String(q.id)));
    for (const p of list) {
      const [w, h] = sizeOf(p);
      if (x + w > maxX) { x = r.x + 2; y += rowH + 3; rowH = 0; }
      if (y + h > maxY || x + w > maxX) { problems.push(`区域「${a.id}」放不下「${p.id}」`); continue; }
      const rect = { x, y, w, h };
      const outdoor = Object.hasOwn(OUTDOOR_KINDS, p.kind) || (!Object.hasOwn(BUILDING_KINDS, p.kind) && p.outdoor === true);
      places[p.id] = { rect, kind: p.kind, outdoor, area: a.id };
      const info = { name: String(p.name || p.id).slice(0, 16), emoji: p.emoji || (outdoor ? '📍' : '🏠'), desc: String(p.desc || p.name || '').slice(0, 120), public: p.public !== false, ...(region.id !== 'town' ? { region: region.id } : {}) };
      locations[p.id] = info;
      if (!outdoor) {
        const s = p.style || {};
        buildings.push({
          id: p.id, name: info.name.slice(0, 10), kind: /^[a-z]{2,16}$/.test(p.kind || '') ? p.kind : 'house', x, y, w, h,
          roof: s.roof || '#8a5a44', wall: s.wall || '#e8dcc4', ...(p.sign || s.sign ? { sign: String(p.sign || s.sign).slice(0, 4) } : {}),
          style: { roofShape: s.roofShape || 'gable', decor: Array.isArray(s.decor) ? s.decor.slice(0, 6) : [], material: s.material || 'plaster' },
          ...(region.id !== 'town' ? { region: region.id } : {}),
        });
      }
      x += w + 3;
      rowH = Math.max(rowH, h);
    }
  }
  return { W, H, buildings, locations, rects, places, problems };
}

function sizeOf(p: Place): number[] {
  if (Array.isArray(p.size) && p.size.length === 2) return [Math.max(3, Math.min(12, p.size[0]! | 0)), Math.max(3, Math.min(10, p.size[1]! | 0))];
  return BUILDING_KINDS[p.kind] || OUTDOOR_KINDS[p.kind] || [5, 5];
}

/** 地形笔刷：按求解出的布局与地貌画出瓦片、道路、水、装饰物，并叠加运行中新增的建筑 */
export function buildLayoutRegion(region: Region, spec: GenSpec): GenWorld {
  const solved = solveLayout(region);
  const { W, H, rects, places } = solved;
  const rnd = mulberry32(region.seed ?? hashStr(region.id + (region.name || '')));
  const tiles: number[] = new Array(W * H).fill(T.GRASS);
  const solid = new Uint8Array(W * H);
  const biomeIds = ['meadow'];
  const biome = new Uint8Array(W * H);
  const inb = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const get = (x: number, y: number): number => (inb(x, y) ? tiles[y * W + x] : -1);
  const set = (x: number, y: number, t: number) => inb(x, y) && (tiles[y * W + x] = t);
  const isSolid = (x: number, y: number) => !inb(x, y) || solid[y * W + x] || !WALKABLE.has(get(x, y));
  const block = (x: number, y: number) => inb(x, y) && (solid[y * W + x] = 1);
  const objects: MapObject[] = [];
  const lamps: Cell[] = [];
  const areas = areasOf(region);
  const areaOf = new Map(areas.map((a) => [a.id, a]));

  // ---- 地貌 ----
  const regionBiome = BIOMES[region.biome ?? ''] ? region.biome! : 'meadow';
  biome.fill(0);
  biomeIds[0] = regionBiome;
  for (const a of areas) {
    const b = BIOMES[a.biome ?? ''] ? a.biome! : regionBiome;
    let idx = biomeIds.indexOf(b);
    if (idx < 0) { biomeIds.push(b); idx = biomeIds.length - 1; }
    const r = rects[a.id]!;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (inb(x, y)) biome[y * W + x] = idx;
    // 湖：区域下半部分是水，外圈是沙滩
    if (a.biome === 'lake') {
      const cx = r.x + r.w / 2, cy = r.y + r.h * 0.72, rx = r.w * 0.42, ry = r.h * 0.3;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + Math.sin(x * 0.7) * 0.04;
        if (d < 0.45) set(x, y, T.DEEP); else if (d < 1) set(x, y, T.WATER); else if (d < 1.3) set(x, y, T.SAND);
      }
    }
  }
  const biomeAt = (x: number, y: number): Biome => BIOMES[biomeIds[biome[y * W + x]!]!] || BIOMES.meadow!;

  // ---- 户外地点（笔刷在 brush.js，运行中新增的户外地点也用它）----
  const brush = { set, get, block, objects, rnd, H };
  for (const p of Object.values(places)) if (p.outdoor) paintOutdoor(brush, p);

  // ---- 建筑（规格里的，不含运行中新增的）----
  const defs = spec.buildings!.filter((b) => (b.region || 'town') === region.id);
  const buildings: MapBuilding[] = defs.filter((b) => !b.added).map((b) => {
    const door = { x: b.x + Math.floor(b.w / 2), y: b.y + b.h - 1 };
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { block(x, y); if (get(x, y) !== T.GRASS && get(x, y) !== T.FLOWER) set(x, y, T.GRASS); }
    return { ...b, door, entrance: { x: door.x, y: door.y + 1 } };
  });

  // ---- 道路：区域之间按 links 连起来（没写 links 就按顺序串成一条），用 L 形路径；过水的地方是桥 ----
  const center = (r: Rect): Cell => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
  const links = (region.links?.length ? region.links : areas.slice(1).map((a, i) => ({ from: areas[i]!.id, to: a.id, via: 'path' })))
    .filter((l) => rects[l.from] && rects[l.to]);
  const paint = (x: number, y: number, trail: boolean) => {
    if (!inb(x, y) || solid[y * W + x]) return;
    const t = get(x, y);
    if (t === T.WATER || t === T.DEEP) set(x, y, T.BRIDGE);
    else if (t === T.GRASS || t === T.FLOWER || t === T.SAND) set(x, y, trail ? T.DIRT : T.PATH);
  };
  const roadCells: Array<[number, number]> = [];
  for (const l of links) {
    const a = center(rects[l.from]!), b = center(rects[l.to]!);
    const trail = l.via === 'trail';
    const width = trail ? 1 : 2;
    // 先横后竖；路走在区域中线上，避开建筑（建筑格子是 solid，不会被刷成路）
    const midY = a.y;
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) for (let k = 0; k < width; k++) { paint(x, midY + k, trail); roadCells.push([x, midY]); }
    for (let y = Math.min(midY, b.y); y <= Math.max(midY, b.y); y++) for (let k = 0; k < width; k++) { paint(b.x + k, y, trail); roadCells.push([b.x, y]); }
  }
  // 每个区域里也有一条横贯的小路，建筑门口从这里接出去
  for (const a of areas) {
    const r = rects[a.id]!;
    if (a.biome === 'lake') continue;
    const y = r.y + r.h - 2;
    for (let x = r.x + 1; x < r.x + r.w - 1; x++) paint(x, y, a.biome === 'dark_forest' || a.biome === 'forest');
  }

  // 从入口开辟小路连到最近的道路 / 广场
  const carve = (sx: number, sy: number) => {
    const prev = new Map<number, number | null>();
    const key = (x: number, y: number): number => y * W + x;
    const q: Array<[number, number]> = [[sx, sy]];
    prev.set(key(sx, sy), null);
    while (q.length) {
      const [x, y] = q.shift()!;
      const t = get(x, y);
      if ((t === T.PATH || t === T.PLAZA || t === T.BRIDGE || t === T.DIRT || t === T.WOOD) && !(x === sx && y === sy)) {
        let k = prev.get(key(x, y));
        while (k !== null && k !== undefined) {
          const px = k % W, py = Math.floor(k / W);
          if (get(px, py) === T.GRASS || get(px, py) === T.SAND || get(px, py) === T.FLOWER) set(px, py, T.DIRT);
          k = prev.get(k);
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
  for (const b of buildings) carve(b.entrance.x, b.entrance.y);
  for (const p of Object.values(places)) if (p.outdoor) { const c = center(p.rect); if (!solid[c.y * W + c.x]) carve(c.x, c.y); }

  // ---- 地点与站位 ----
  const locations: Record<string, MapLocation> = {};
  const info = spec.locations!;
  for (const [id, p] of Object.entries(places)) {
    const base: MapLocation = { id, name: info[id]?.name || id, emoji: info[id]?.emoji || '📍', desc: info[id]?.desc || '', spots: [] };
    if (!p.outdoor) { const b = buildings.find((x) => x.id === id); if (b) locations[id] = { ...base, indoor: id, rect: b }; continue; }
    const r = p.rect;
    for (let y = r.y; y < r.y + r.h && base.spots.length < 12; y += 2) for (let x = r.x + (y % 2); x < r.x + r.w && base.spots.length < 12; x += 2) {
      if (!isSolid(x, y)) base.spots.push({ x, y });
    }
    locations[id] = { ...base, rect: r };
  }

  // ---- 路灯：沿道路每隔 9 格一盏 ----
  for (let i = 0; i < roadCells.length; i += 9) {
    const [x, y] = roadCells[i]!;
    for (const [dx, dy] of [[0, -1], [0, 2], [-1, 0], [2, 0]]) {
      const lx = x + dx, ly = y + dy;
      if (inb(lx, ly) && get(lx, ly) === T.GRASS && !solid[ly * W + lx]) { objects.push({ type: 'lamp', x: lx, y: ly }); block(lx, ly); lamps.push({ x: lx, y: ly }); break; }
    }
  }

  // ---- 树木、花丛、石头：按地貌的分布，避开道路、站位、入口与地点 ----
  const reserved = new Uint8Array(W * H);
  const reserve = (x: number, y: number, r = 1) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (inb(x + dx, y + dy)) reserved[(y + dy) * W + x + dx] = 1; };
  for (const l of Object.values(locations)) for (const s of l.spots) reserve(s.x, s.y, 1);
  for (const b of buildings) { reserve(b.entrance.x, b.entrance.y, 1); for (let y = b.y - 1; y <= b.y + b.h; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) if (inb(x, y)) reserved[y * W + x] = 1; }
  for (const p of Object.values(places)) for (let y = p.rect.y - 1; y <= p.rect.y + p.rect.h; y++) for (let x = p.rect.x - 1; x <= p.rect.x + p.rect.w; x++) if (inb(x, y)) reserved[y * W + x] = 1;
  const nearRoad = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = get(x + dx, y + dy);
      if (t === T.PATH || t === T.DIRT || t === T.PLAZA || t === T.BRIDGE || t === T.WOOD) return true;
    }
    return false;
  };
  const pickTree = (bio: Biome): string => {
    const entries = Object.entries(bio.trees);
    let r = rnd() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
    return entries[0]?.[0] || 'oak';
  };
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (get(x, y) !== T.GRASS || reserved[y * W + x] || solid[y * W + x] || nearRoad(x, y)) continue;
      const bio = biomeAt(x, y);
      const edge = x < 2 || y < 2 || x > W - 3 || y > H - 3;
      const r = rnd();
      const pt = edge ? Math.max(0.5, bio.tree) : bio.tree;
      if (r < pt && Object.keys(bio.trees).length) { objects.push({ type: 'tree', x, y, kind: pickTree(bio), v: rnd() }); block(x, y); }
      else if (r < pt + bio.bush) { objects.push({ type: 'bush', x, y, v: rnd() }); block(x, y); }
      else if (r < pt + bio.bush + bio.flower) set(x, y, T.FLOWER);
      else if (r < pt + bio.bush + bio.flower + bio.rock) objects.push({ type: 'rock', x, y, v: rnd() });
    }
  }

  // ---- 叠加层（拆除、新增建筑、建筑状态）与连通性：见 finish.js；渡口（通往其他区域的地方）在叠加之后确定，避开新建筑 ----
  const gate = () => {
    const gatePlace = region.gate && places[region.gate];
    let g = gatePlace ? center(gatePlace.rect) : null;
    if (!g) { const first = Object.values(places).find((p) => p.outdoor); g = first ? center(first.rect) : { x: Math.floor(W / 2), y: Math.floor(H / 2) }; }
    if (isSolid(g.x, g.y)) {
      // 找最近的可走格
      let best: (Cell & { d: number }) | null = null;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!isSolid(x, y)) { const d = Math.abs(x - g.x) + Math.abs(y - g.y); if (!best || d < best.d) best = { x, y, d }; }
      g = { x: best!.x, y: best!.y };
    }
    return g;
  };
  return finishRegion({
    name: region.name, W, H, tiles, solid, objects, buildings, locations, lamps, gate,
    roads: [T.PATH, T.PLAZA, T.BRIDGE, T.DIRT, T.WOOD], dirtOver: [T.GRASS, T.SAND, T.FLOWER],
    // 前端按地貌调色：biomes 是调色板列表，biome 是每格的下标
    biomes: biomeIds.map((id) => ({ id, grass: BIOMES[id].grass, blade: BIOMES[id].blade })), biome: [...biome],
  }, region, spec);
}

/** 检查一个区域描述能不能展开（创世校验用）：返回问题列表 */
export function layoutProblems(region: Region, spec: GenSpec): string[] {
  const s = solveLayout(region);
  const problems = [...s.problems];
  const w = buildLayoutRegion(region, { ...spec, buildings: s.buildings, locations: { ...s.locations, ...spec.locations } });
  for (const b of w.buildings) if (!w.walk[b.entrance.y * w.W + b.entrance.x]) problems.push(`「${b.name}」的门口走不到`);
  for (const [id, l] of Object.entries(w.locations)) if (!l.indoor && !l.spots.length) problems.push(`「${l.name}」（${id}）没有可以站的地方`);
  // 任意两个地点之间都能走到
  const ids = Object.keys(w.locations);
  const pos = (l: MapLocation): Cell | undefined => (l.indoor ? w.buildings.find((b) => b.id === l.indoor)?.entrance : l.spots[0]);
  const a = ids.length && pos(w.locations[ids[0]]);
  for (const id of ids.slice(1)) {
    const b = pos(w.locations[id]);
    if (a && b && !findPath(w, a.x, a.y, b.x, b.y) && !(a.x === b.x && a.y === b.y)) problems.push(`「${w.locations[id].name}」和其他地方不连通`);
  }
  return problems;
}
