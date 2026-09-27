// 叠加层（地图演变设计 §2、§7.2）：生成器只负责展开世界包里的基础地图，运行中的一切变化都在这里按顺序叠加上去。
//   拆除（removed）→ 新增建筑（added）→ 建筑状态（停业 / 受损 / 废墟）→ 连通性过滤
// 基础生成一行不动，所以云溪镇的基础瓦片与随机序列永远不变；两个生成器（yunxi-v1、layout-v1）共用这一段。
import { T, WALKABLE } from './tiles.js';

const REMOVABLE = new Set(['tree', 'bush', 'rock']);
const BUILDABLE = new Set([T.GRASS, T.FLOWER, T.DIRT, T.SAND]);
export const BUILDING_STATES = ['open', 'closed', 'damaged', 'ruin'];

/**
 * 把生成器的画布变成最终的地图。
 * @param {object} c 生成器的画布：{ W, H, tiles, solid, objects, buildings, locations, lamps, gate, origin?, carve(x, y), lampForAdded?, ...其余字段原样返回 }
 *   gate 可以是函数（叠加之后才能确定的渡口，例如 layout-v1 要避开新建筑）；origin 是连通性的起点，缺省为 gate
 * @param {object} region 规格里的区域
 * @param {object} spec 世界规格
 */
export function finishRegion(c, region, spec) {
  const { W, H, tiles, solid, objects, buildings, locations, lamps } = c;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const get = (x, y) => (inb(x, y) ? tiles[y * W + x] : -1);
  const set = (x, y, t) => inb(x, y) && (tiles[y * W + x] = t);
  const isSolid = (x, y) => !inb(x, y) || solid[y * W + x] || !WALKABLE.has(get(x, y));
  const block = (x, y) => inb(x, y) && (solid[y * W + x] = 1);
  const info = spec.locations || {};
  const defs = (spec.buildings || []).filter((b) => (b.region || 'town') === region.id);

  // ---- 拆除：基础建筑照常参与了基础生成（保证随机序列不变），在这里变回空地 ----
  const lots = [];
  for (const def of defs.filter((b) => b.removed && !b.added)) {
    const i = buildings.findIndex((b) => b.id === def.id);
    if (i < 0) continue;
    const b = buildings[i];
    buildings.splice(i, 1);
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      if (!inb(x, y)) continue;
      solid[y * W + x] = 0;
      set(x, y, T.DIRT);
    }
    for (const [id, l] of Object.entries(locations)) if (id === b.id || l.indoor === b.id) delete locations[id];
    lots.push({ id: b.id, name: b.name, x: b.x, y: b.y, w: b.w, h: b.h });
  }

  // ---- 运行中新增的建筑：清理占地及周围一格的树木 / 灌木 / 石头，开辟连到道路的小路 ----
  const overlayErrors = {};
  const inRect = (x, y, r, m = 0) => x >= r.x - m && x < r.x + r.w + m && y >= r.y - m && y < r.y + r.h + m;
  for (const def of defs.filter((b) => b.added && !b.removed)) {
    const door = { x: def.x + Math.floor(def.w / 2), y: def.y + def.h - 1 };
    const entrance = { x: door.x, y: door.y + 1 };
    let err = null;
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
    const b = { ...def, door, entrance };
    buildings.push(b);
    c.carve(entrance.x, entrance.y);
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
    const around = [[0, 0], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => ({ x: b.entrance.x + dx, y: b.entrance.y + dy }))
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
  const q = [[origin.x, origin.y]];
  walk[origin.y * W + origin.x] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (isSolid(nx, ny) || walk[ny * W + nx]) continue;
      walk[ny * W + nx] = 1;
      q.push([nx, ny]);
    }
  }
  for (const l of Object.values(locations)) l.spots = l.spots.filter((s) => walk[Math.round(s.y) * W + Math.round(s.x)]);
  for (const b of buildings) if (!walk[b.entrance.y * W + b.entrance.x]) console.warn(`[worldgen] ${region.id}：入口不可达：${b.id}`);

  const { solid: _s, carve: _c, origin: _o, lampForAdded: _l, gate: _g, ...rest } = c;
  return { ...rest, id: region.id, walk, overlayErrors, gate, ...(lots.length ? { lots } : {}) };
}
