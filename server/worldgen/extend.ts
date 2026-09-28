// 地图扩展（地图演变设计 §5.1）：主地图向任意方向长出一条新地块，最大 96×64。
// 向西 / 向北扩展时原来的坐标整体平移：规格里「运行中加入的东西」（新增建筑、地形编辑、已有的扩展块）由 expandMap 操作平移，
// 世界包里的基础内容仍在基础坐标系里生成，再由叠加层贴到 offset 位置。
import { T } from './tiles.ts';

export const MAX_SIZE = [96, 64];
export const SIDES = ['north', 'south', 'east', 'west'];

/** 扩展之后：新地块的矩形（新坐标系）、原内容的平移量、新尺寸 */
export function stripOf([W, H], side, by) {
  if (side === 'east') return { rect: { x: W, y: 0, w: by, h: H }, dx: 0, dy: 0, size: [W + by, H] };
  if (side === 'west') return { rect: { x: 0, y: 0, w: by, h: H }, dx: by, dy: 0, size: [W + by, H] };
  if (side === 'south') return { rect: { x: 0, y: H, w: W, h: by }, dx: 0, dy: 0, size: [W, H + by] };
  return { rect: { x: 0, y: 0, w: W, h: by }, dx: 0, dy: by, size: [W, H + by] };
}

/** 新地块里的主路（沿接缝那一侧的长边，把整块地留给地点）与接回原地图的支路（在中间，通到接缝） */
export function stripRoads(rect, side) {
  if (side === 'east' || side === 'west') {
    const x = side === 'east' ? rect.x + 1 : rect.x + rect.w - 2;
    const y = rect.y + Math.floor(rect.h / 2);
    const seamX = side === 'east' ? rect.x : rect.x + rect.w - 1;
    return { main: { x, y: rect.y + 1, w: 1, h: rect.h - 3 }, link: { x: Math.min(x, seamX), y, w: Math.abs(x - seamX) + 1, h: 1 }, seam: { x: side === 'east' ? rect.x - 1 : rect.x + rect.w, y } };
  }
  const y = side === 'south' ? rect.y + 1 : rect.y + rect.h - 2;
  const x = rect.x + Math.floor(rect.w / 2);
  const seamY = side === 'south' ? rect.y : rect.y + rect.h - 1;
  return { main: { x: rect.x + 1, y, w: rect.w - 2, h: 1 }, link: { x, y: Math.min(y, seamY), w: 1, h: Math.abs(y - seamY) + 1 }, seam: { x, y: side === 'south' ? rect.y - 1 : rect.y + rect.h } };
}

const overlap = (a, b, m = 0) => a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;

/**
 * 在新地块里排地点（确定性的贪心扫描）：避开主路与支路两侧各一格、彼此隔一格；建筑门口下面留一格。
 * sizes: { 地点id: [w, h] }；返回 { placed: { id: rect }, problems }
 */
export function packStrip(rect, side, places, sizes) {
  const roads = stripRoads(rect, side);
  const band = [roads.main, roads.link].map((r) => ({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }));
  const placed = {};
  const taken = [];
  const problems = [];
  const list = [...places].sort((p, q) => (sizes[q.id][0] * sizes[q.id][1] - sizes[p.id][0] * sizes[p.id][1]) || String(p.id).localeCompare(String(q.id)));
  for (const p of list) {
    const [w, h] = sizes[p.id];
    let found = null;
    for (let y = rect.y + 1; y + h + 1 <= rect.y + rect.h - 1 && !found; y++) {
      for (let x = rect.x + 1; x + w <= rect.x + rect.w - 1 && !found; x++) {
        const r = { x, y, w, h: h + 1 }; // 多算一行给门口
        if (band.some((b) => overlap(r, b)) || taken.some((t) => overlap(r, t, 1))) continue;
        found = { x, y, w, h };
      }
    }
    if (!found) { problems.push(`新地块放不下「${p.name || p.id}」`); continue; }
    placed[p.id] = found;
    taken.push({ ...found, h: found.h + 1 });
  }
  return { placed, problems };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 在画布上画一个扩展块：地貌、主路与支路、装饰物；再把支路从接缝接到原地图最近的路上（沿途的树丛石头清掉）。
 * c = { W, H, tiles, solid, objects, biome, biomeIndex(id), roads:Set }
 */
export function paintExtension(c, ext, BIOMES) {
  const { W, H, tiles, solid, objects } = c;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const get = (x, y) => (inb(x, y) ? tiles[y * W + x] : -1);
  const set = (x, y, t) => inb(x, y) && (tiles[y * W + x] = t);
  const r = ext.rect;
  const inRect = (x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  const bio = BIOMES[ext.biome] || BIOMES.meadow;
  const bi = c.biomeIndex(BIOMES[ext.biome] ? ext.biome : 'meadow');
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { set(x, y, T.GRASS); c.biome[y * W + x] = bi; }
  const roads = stripRoads(r, ext.side);
  const roadCells = new Set();
  for (const rr of [roads.main, roads.link]) for (let y = rr.y; y < rr.y + rr.h; y++) for (let x = rr.x; x < rr.x + rr.w; x++) { set(x, y, T.PATH); roadCells.add(y * W + x); }
  // 装饰：离路一格以外按地貌撒树、灌木、花、石头；地图最外圈多种树
  const rnd = mulberry32(ext.seed || 1);
  const near = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (roadCells.has((y + dy) * W + x + dx)) return true; return false; };
  const kinds = Object.entries(bio.trees);
  const pickTree = () => { let v = rnd() * kinds.reduce((s, [, w]) => s + w, 0); for (const [k, w] of kinds) if ((v -= w) < 0) return k; return kinds[0]?.[0] || 'oak'; };
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    if (near(x, y)) continue;
    const edge = x < 2 || y < 2 || x > W - 3 || y > H - 3;
    const v = rnd();
    const pt = edge ? Math.max(0.5, bio.tree) : bio.tree * 0.6;
    if (v < pt && kinds.length) { objects.push({ type: 'tree', x, y, kind: pickTree(), v: rnd() }); solid[y * W + x] = 1; }
    else if (v < pt + bio.bush) { objects.push({ type: 'bush', x, y, v: rnd() }); solid[y * W + x] = 1; }
    else if (v < pt + bio.bush + bio.flower) set(x, y, T.FLOWER);
    else if (v < pt + bio.bush + bio.flower + bio.rock) objects.push({ type: 'rock', x, y, v: rnd() });
  }
  // 接缝：从支路的尽头往原地图里找最近的路，挡路的树丛石头清掉，草地铺成泥路
  const REMOVABLE = new Set(['tree', 'bush', 'rock']);
  const removable = new Map();
  for (const o of objects) if (REMOVABLE.has(o.type)) removable.set(o.y * W + o.x, o);
  const WALK = new Set([T.GRASS, T.FLOWER, T.SAND, T.DIRT, T.SOIL, T.PATH, T.PLAZA, T.BRIDGE, T.WOOD]);
  const passable = (x, y) => inb(x, y) && WALK.has(get(x, y)) && (!solid[y * W + x] || removable.has(y * W + x));
  const s = roads.seam;
  if (!passable(s.x, s.y)) return;
  const prev = new Map([[s.y * W + s.x, null]]);
  const q = [[s.x, s.y]];
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    if (c.roads.has(get(x, y)) && !inRect(x, y)) {
      for (let k = y * W + x; k != null; k = prev.get(k)) {
        const px = k % W, py = Math.floor(k / W);
        const o = removable.get(k);
        if (o) { objects.splice(objects.indexOf(o), 1); solid[k] = 0; removable.delete(k); }
        if ([T.GRASS, T.FLOWER, T.SAND].includes(get(px, py))) set(px, py, T.DIRT);
      }
      return;
    }
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (prev.has(k) || inRect(nx, ny) || !passable(nx, ny)) continue;
      prev.set(k, y * W + x);
      q.push([nx, ny]);
    }
  }
}
