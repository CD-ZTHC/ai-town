// 云溪镇地图生成：瓦片、建筑、装饰物、地点与站位点（确定性随机，前后端共享同一份数据）
export const T = {
  GRASS: 0, PATH: 1, PLAZA: 2, DIRT: 3, WATER: 4, SAND: 5, BRIDGE: 6, SOIL: 7, WOOD: 8, DEEP: 9, FLOWER: 10,
  MOON: 11, VOID: 12, MOONPATH: 13, // 暗月界：月砂地、星空虚空、月光小径
};
const WALKABLE = new Set([T.GRASS, T.PATH, T.PLAZA, T.DIRT, T.SAND, T.BRIDGE, T.SOIL, T.WOOD, T.FLOWER, T.MOON, T.MOONPATH]);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 生成器 yunxi-v1（手工布局）：建筑与地点信息来自世界规格（worlds/yunxi/world.json），保证云溪镇逐格不变
export function buildWorld({ buildings: buildingDefs, locationInfo }) {
  const W = 64, H = 44;
  const rnd = mulberry32(20260924);
  const tiles = new Array(W * H).fill(T.GRASS);
  const solid = new Uint8Array(W * H);
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const get = (x, y) => (inb(x, y) ? tiles[y * W + x] : -1);
  const set = (x, y, t) => inb(x, y) && (tiles[y * W + x] = t);
  const isSolid = (x, y) => !inb(x, y) || solid[y * W + x] || !WALKABLE.has(get(x, y));
  const block = (x, y) => inb(x, y) && (solid[y * W + x] = 1);
  const objects = [];

  // ---- 湖、溪流 ----
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - 54) / 10.5, dy = (y - 38.5) / 6.5;
      const d = dx * dx + dy * dy + Math.sin(x * 0.7) * 0.05 + Math.cos(y * 0.9) * 0.05;
      if (d < 0.42) set(x, y, T.DEEP);
      else if (d < 1) set(x, y, T.WATER);
      else if (d < 1.32) set(x, y, T.SAND);
    }
  }
  for (let y = 0; y <= 34; y++) {
    const cx = 47 + Math.round(Math.sin(y * 0.3) * 1.2);
    for (let x = cx - 1; x <= cx + 1; x++) set(x, y, T.WATER);
  }
  // 公园小池塘
  for (let y = 33; y < 42; y++) for (let x = 2; x < 13; x++) {
    const dx = (x - 7) / 3.6, dy = (y - 37.5) / 2.4;
    if (dx * dx + dy * dy < 1) set(x, y, T.WATER);
  }

  // ---- 道路 ----
  const road = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const t = get(x, y);
      set(x, y, t === T.WATER || t === T.DEEP ? T.BRIDGE : T.PATH);
    }
  };
  road(2, 15, 60, 2);
  road(2, 30, 51, 2);
  road(13, 2, 2, 40);
  road(31, 2, 2, 40);
  for (let y = 18; y <= 28; y++) for (let x = 16; x <= 29; x++) set(x, y, T.PLAZA);

  // 码头
  for (let y = 32; y <= 37; y++) for (let x = 50; x <= 51; x++) set(x, y, T.WOOD);
  for (let y = 37; y <= 38; y++) for (let x = 48; x <= 53; x++) set(x, y, T.WOOD);

  // 农田
  for (let y = 4; y <= 11; y++) for (let x = 52; x <= 61; x++) set(x, y, T.SOIL);
  for (let x = 51; x <= 62; x++) {
    objects.push({ type: 'fence', x, y: 3, dir: 'h' }); block(x, 3);
    if (x !== 56 && x !== 57) { objects.push({ type: 'fence', x, y: 12, dir: 'h' }); block(x, 12); }
  }
  for (let y = 4; y <= 11; y++) {
    objects.push({ type: 'fence', x: 51, y, dir: 'v' }); block(51, y);
    objects.push({ type: 'fence', x: 62, y, dir: 'v' }); block(62, y);
  }
  for (let y = 5; y <= 10; y += 2) for (let x = 52; x <= 61; x++) {
    if (x === 56 && y === 7) continue;
    objects.push({ type: 'crop', x, y, kind: x < 57 ? 'melon' : 'veg', v: rnd() });
  }
  objects.push({ type: 'scarecrow', x: 56, y: 7 }); block(56, 7);

  // ---- 建筑 ----
  // 世界规格里后来新增的建筑（added）不参与基础生成，而是在最后叠加，保证原地图的随机序列与其余部分不变
  const added = buildingDefs.filter((b) => b.added);
  const buildings = buildingDefs.filter((b) => !b.added).map((b) => {
    const door = { x: b.x + Math.floor(b.w / 2), y: b.y + b.h - 1 };
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) block(x, y);
    return { ...b, door, entrance: { x: door.x, y: door.y + 1 } };
  });

  // 从入口开辟小路连到最近的道路
  const carve = (sx, sy) => {
    const prev = new Map();
    const key = (x, y) => y * W + x;
    const q = [[sx, sy]];
    prev.set(key(sx, sy), null);
    while (q.length) {
      const [x, y] = q.shift();
      const t = get(x, y);
      if ((t === T.PATH || t === T.PLAZA || t === T.BRIDGE) && !(x === sx && y === sy)) {
        let k = prev.get(key(x, y));
        while (k !== null && k !== undefined) {
          const px = k % W, py = Math.floor(k / W);
          if (get(px, py) === T.GRASS || get(px, py) === T.SAND) set(px, py, T.DIRT);
          k = prev.get(k);
        }
        return;
      }
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny) || prev.has(key(nx, ny)) || isSolid(nx, ny)) continue;
        prev.set(key(nx, ny), key(x, y));
        q.push([nx, ny]);
      }
    }
  };
  for (const b of buildings) carve(b.entrance.x, b.entrance.y);
  carve(56, 12);
  carve(50, 32);

  // ---- 广场设施 ----
  const obj = (o, solidTiles = true) => {
    objects.push(o);
    if (solidTiles) for (let y = o.y; y < o.y + (o.h || 1); y++) for (let x = o.x; x < o.x + (o.w || 1); x++) block(x, y);
  };
  obj({ type: 'fountain', x: 21, y: 22, w: 3, h: 3 });
  objects.push({ type: 'stage', x: 20, y: 18, w: 5, h: 2 });
  obj({ type: 'board', x: 26, y: 18 });
  const stallColors = ['#e05a5a', '#4a90d9', '#f0b030', '#5bb56b'];
  const stallGoods = ['🍎', '💐', '🥖', '🐟'];
  [[17, 19], [17, 26], [27, 20], [27, 26]].forEach(([x, y], i) =>
    obj({ type: 'stall', x, y, w: 2, h: 1, color: stallColors[i], goods: stallGoods[i] }));
  [[18, 23], [26, 23], [20, 27], [24, 27]].forEach(([x, y]) => objects.push({ type: 'bench', x, y }));

  // 咖啡馆露台
  [[42, 9], [42, 12]].forEach(([x, y], i) => obj({ type: 'table', x, y, color: i ? '#e8a33d' : '#d9534f' }));
  for (let y = 8; y <= 13; y++) for (let x = 41; x <= 44; x++) if (get(x, y) === T.GRASS) set(x, y, T.WOOD);
  // 工坊后院
  obj({ type: 'anvil', x: 41, y: 26 });
  obj({ type: 'woodpile', x: 42, y: 28 });
  obj({ type: 'balloon', x: 43, y: 25 });
  for (let y = 25; y <= 28; y++) for (let x = 40; x <= 43; x++) if (get(x, y) === T.GRASS) set(x, y, T.DIRT);
  // 农场
  obj({ type: 'well', x: 53, y: 14 });
  obj({ type: 'hay', x: 58, y: 20 });
  obj({ type: 'hay', x: 59, y: 22 });
  // 湖上
  objects.push({ type: 'boat', x: 57, y: 39 });
  for (let i = 0; i < 14; i++) {
    const x = 44 + Math.floor(rnd() * 19), y = 33 + Math.floor(rnd() * 10);
    if (get(x, y) === T.WATER) objects.push({ type: 'lily', x, y, v: rnd() });
  }
  for (let i = 0; i < 5; i++) {
    const x = 4 + Math.floor(rnd() * 7), y = 36 + Math.floor(rnd() * 3);
    if (get(x, y) === T.WATER) objects.push({ type: 'lily', x, y, v: rnd() });
  }
  // 公园长椅
  [[16, 35], [20, 38], [25, 34], [10, 34], [4, 40]].forEach(([x, y]) => {
    if (!isSolid(x, y)) objects.push({ type: 'bench', x, y });
  });

  // 路灯
  const lamps = [];
  const lamp = (x, y) => {
    if (isSolid(x, y) || get(x, y) !== T.GRASS) return;
    obj({ type: 'lamp', x, y }); lamps.push({ x, y });
  };
  for (let x = 4; x < 62; x += 9) { lamp(x, 14); lamp(x + 4, 32); }
  for (let y = 6; y < 42; y += 9) { lamp(15, y); lamp(30, y + 4); }
  [[16, 18], [29, 18], [16, 28], [29, 28]].forEach(([x, y]) => { obj({ type: 'lamp', x, y }); lamps.push({ x, y }); });
  lamp(49, 33); lamp(52, 32);

  // ---- 地点与站位 ----
  const B = Object.fromEntries(buildings.map((b) => [b.id, b]));
  const locations = {};
  const addLoc = (id, extra) => {
    const info = locationInfo[id] || { name: B[id]?.name, emoji: '🏠', desc: '' };
    locations[id] = { id, name: info.name, emoji: info.emoji, desc: info.desc, spots: [], ...extra };
  };
  for (const b of buildings) {
    if (b.id.startsWith('home_')) addLoc(b.id, { indoor: b.id, rect: b, name: b.name });
  }
  addLoc('cafe', { indoor: 'cafe', rect: B.cafe, spots: [[41, 9], [43, 9], [41, 12], [43, 12], [42, 10]].map(([x, y]) => ({ x, y })) });
  addLoc('library', { indoor: 'library', rect: B.library });
  addLoc('tavern', { indoor: 'tavern', rect: B.tavern });
  addLoc('clinic', { indoor: 'clinic', rect: B.clinic });
  addLoc('workshop', { indoor: 'workshop', rect: B.workshop, spots: [[41, 27], [42, 26], [40, 25]].map(([x, y]) => ({ x, y })) });
  addLoc('square', {
    rect: { x: 16, y: 18, w: 14, h: 11 },
    spots: [[20, 22], [20, 24], [24, 22], [24, 24], [22, 21], [22, 25], [21, 19], [23, 19], [18, 23], [26, 23], [20, 27], [24, 27], [25, 19]]
      .map(([x, y]) => ({ x, y })),
  });
  addLoc('market', {
    rect: { x: 16, y: 18, w: 14, h: 11 },
    spots: [[17, 20], [18, 20], [17, 25], [18, 25], [27, 21], [28, 21], [27, 25], [28, 25]].map(([x, y]) => ({ x, y })),
  });
  addLoc('park', { rect: { x: 2, y: 33, w: 29, h: 10 } });
  addLoc('farm', { rect: { x: 52, y: 4, w: 10, h: 8 } });
  addLoc('pier', { rect: { x: 48, y: 32, w: 6, h: 7 }, spots: [[48, 38], [49, 37], [52, 37], [53, 38], [50, 38], [51, 34]].map(([x, y]) => ({ x, y })) });

  // 农场站位：田垄之间
  for (let y = 4; y <= 11; y += 2) for (let x = 53; x <= 60; x += 3) locations.farm.spots.push({ x, y });
  // 公园站位：长椅 + 草地
  for (const o of objects) if (o.type === 'bench' && o.y >= 33) locations.park.spots.push({ x: o.x, y: o.y });
  [[13, 37], [8, 41], [22, 36], [27, 40], [18, 41]].forEach(([x, y]) => locations.park.spots.push({ x, y }));

  // ---- 树木、花丛（避开道路/站位/入口）----
  const reserved = new Set();
  const reserve = (x, y, r = 1) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) reserved.add((y + dy) * W + x + dx); };
  for (const l of Object.values(locations)) for (const s of l.spots) reserve(Math.round(s.x), Math.round(s.y), 1);
  for (const b of buildings) reserve(b.entrance.x, b.entrance.y, 1);
  const nearRoad = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = get(x + dx, y + dy);
      if (t === T.PATH || t === T.DIRT || t === T.PLAZA || t === T.BRIDGE || t === T.WOOD) return true;
      if (inb(x + dx, y + dy) && solid[(y + dy) * W + x + dx]) return true;
    }
    return false;
  };
  const inPark = (x, y) => y >= 33 && x <= 30;
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (get(x, y) !== T.GRASS || reserved.has(y * W + x) || solid[y * W + x] || nearRoad(x, y)) continue;
      const edge = x < 2 || y < 2 || x > W - 3 || y > H - 3;
      const r = rnd();
      let p = edge ? 0.55 : 0.07;
      if (inPark(x, y)) p = 0.16;
      if (r < p) {
        const sakura = inPark(x, y) ? rnd() < 0.7 : rnd() < 0.08;
        const kind = sakura ? 'sakura' : rnd() < 0.3 ? 'pine' : 'oak';
        obj({ type: 'tree', x, y, kind, v: rnd() });
        reserve(x, y, 0);
      } else if (r < p + 0.04) {
        obj({ type: 'bush', x, y, v: rnd() });
      } else if (r < p + 0.14) {
        set(x, y, T.FLOWER);
      } else if (r < p + 0.17) {
        objects.push({ type: 'rock', x, y, v: rnd() });
      }
    }
  }

  // ---- 叠加新增建筑：清理占地及周围一格的树木 / 灌木 / 石头，开辟连到道路的小路 ----
  const overlayErrors = {};
  const REMOVABLE = new Set(['tree', 'bush', 'rock']);
  const BUILDABLE = new Set([T.GRASS, T.FLOWER, T.DIRT, T.SAND]);
  const inRect = (x, y, r, m = 0) => x >= r.x - m && x < r.x + r.w + m && y >= r.y - m && y < r.y + r.h + m;
  for (const def of added) {
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
    B[b.id] = b;
    carve(entrance.x, entrance.y);
    addLoc(b.id, { indoor: b.id, rect: b, name: b.name });
    if (def.lightAtNight) {
      const lx = Math.min(W - 1, def.x + def.w), ly = def.y + def.h - 1;
      if (!solid[ly * W + lx] && WALKABLE.has(get(lx, ly))) { objects.push({ type: 'lamp', x: lx, y: ly }); block(lx, ly); lamps.push({ x: lx, y: ly }); }
    }
  }

  // 连通性校验：丢弃不可达的站位
  const reach = new Uint8Array(W * H);
  const q = [[22, 20]];
  reach[20 * W + 22] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (isSolid(nx, ny) || reach[ny * W + nx]) continue;
      reach[ny * W + nx] = 1;
      q.push([nx, ny]);
    }
  }
  for (const l of Object.values(locations)) {
    l.spots = l.spots.filter((s) => reach[Math.round(s.y) * W + Math.round(s.x)]);
  }
  for (const b of buildings) {
    if (!reach[b.entrance.y * W + b.entrance.x]) console.warn('[world] 入口不可达：', b.id);
  }

  const walk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) walk[i] = reach[i] ? 1 : 0;

  // gate：通往其他区域（暗月界）的渡口位置，与裂隙的出怪点相同
  return { id: 'town', W, H, tiles, walk, objects, buildings, locations, lamps, overlayErrors, gate: { x: 51, y: 37 } };
}

// ---------- 区域生成器 moonrealm-v1：暗月界（裂隙另一头的口袋地图）；地点名称与描述来自世界规格 ----------
export function buildMoonRealm({ locationInfo = {} } = {}) {
  const W = 36, H = 26;
  const rnd = mulberry32(19260404);
  const tiles = new Array(W * H).fill(T.VOID);
  const solid = new Uint8Array(W * H);
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const get = (x, y) => (inb(x, y) ? tiles[y * W + x] : -1);
  const set = (x, y, t) => inb(x, y) && (tiles[y * W + x] = t);
  const objects = [];
  const lamps = [];
  const obj = (o) => { objects.push(o); for (let y = o.y; y < o.y + (o.h || 1); y++) for (let x = o.x; x < o.x + (o.w || 1); x++) if (inb(x, y)) solid[y * W + x] = 1; };
  // 漂浮的月岛
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x - 18) / 15.5, dy = (y - 12.5) / 10.8;
    if (dx * dx + dy * dy + Math.sin(x * 0.9) * 0.05 + Math.cos(y * 1.3) * 0.05 < 1) set(x, y, T.MOON);
  }
  // 月光小径
  for (let x = 5; x <= 31; x++) set(x, 13, T.MOONPATH);
  for (let y = 4; y <= 22; y++) set(18, y, T.MOONPATH);
  for (let x = 18; x <= 27; x++) set(x, 7, T.MOONPATH);
  // 月井、月灯
  obj({ type: 'moonwell', x: 17, y: 10, w: 2, h: 2 });
  for (const [x, y] of [[15, 12], [21, 12], [17, 18], [19, 18], [10, 12], [26, 12], [24, 6]]) {
    if (get(x, y) === T.MOON) { obj({ type: 'lamp', x, y }); lamps.push({ x, y }); }
  }
  // 月光花园
  for (let i = 0; i < 16; i++) {
    const x = 5 + Math.floor(rnd() * 8), y = 9 + Math.floor(rnd() * 9);
    if (get(x, y) === T.MOON && !solid[y * W + x]) objects.push({ type: 'moonflower', x, y, v: rnd() });
  }
  // 水晶散落在岛的边缘
  for (let i = 0; i < 40; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H);
    if (get(x, y) !== T.MOON || solid[y * W + x]) continue;
    let edge = false;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [2, 0], [-2, 0], [0, 2]]) if (get(x + dx, y + dy) === T.VOID) edge = true;
    const nearPath = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => get(x + dx, y + dy) === T.MOONPATH);
    if (edge && !nearPath) obj({ type: 'crystal', x, y, v: rnd() });
  }
  const locations = {};
  const addLoc = (id, rect, spots) => { locations[id] = { id, ...locationInfo[id], rect, spots: spots.map(([x, y]) => ({ x, y })) }; };
  addLoc('moon_gate', { x: 15, y: 19, w: 7, h: 4 }, [[18, 21], [17, 21], [19, 21], [17, 20], [19, 20]]);
  addLoc('moon_plaza', { x: 14, y: 9, w: 9, h: 7 }, [[16, 10], [20, 10], [16, 13], [20, 13], [17, 14], [19, 14], [18, 9]]);
  addLoc('moon_garden', { x: 4, y: 8, w: 9, h: 10 }, [[7, 11], [9, 13], [6, 14], [10, 10], [8, 16], [11, 15]]);
  addLoc('moon_lookout', { x: 24, y: 4, w: 8, h: 6 }, [[27, 6], [29, 7], [26, 8], [30, 6]]);
  // 连通性：从渡口出发可达的格子
  const walk = new Uint8Array(W * H);
  const q = [[18, 21]];
  walk[21 * W + 18] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (!inb(nx, ny) || walk[ny * W + nx] || solid[ny * W + nx] || !WALKABLE.has(get(nx, ny))) continue;
      walk[ny * W + nx] = 1;
      q.push([nx, ny]);
    }
  }
  for (const l of Object.values(locations)) l.spots = l.spots.filter((s) => walk[s.y * W + s.x]);
  return { id: 'moonrealm', name: '暗月界', W, H, tiles, walk, objects, buildings: [], locations, lamps, overlayErrors: {}, gate: { x: 18, y: 21 } };
}

// A* 寻路（4 邻接）
export function findPath(world, sx, sy, tx, ty) {
  const { W, H, walk } = world;
  sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
  if (sx === tx && sy === ty) return [];
  const idx = (x, y) => y * W + x;
  const g = new Float32Array(W * H).fill(Infinity);
  const came = new Int32Array(W * H).fill(-1);
  const open = [[0, sx, sy]];
  g[idx(sx, sy)] = 0;
  const closed = new Uint8Array(W * H);
  while (open.length) {
    // 小规模地图，线性取最小即可
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, x, y] = open[bi];
    open[bi] = open[open.length - 1]; open.pop();
    const ci = idx(x, y);
    if (closed[ci]) continue;
    closed[ci] = 1;
    if (x === tx && y === ty) {
      const path = [];
      let k = ci;
      while (k !== idx(sx, sy)) { path.push({ x: k % W, y: Math.floor(k / W) }); k = came[k]; }
      return path.reverse();
    }
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = idx(nx, ny);
      if ((!walk[ni] && !(nx === tx && ny === ty)) || closed[ni]) continue;
      // 走在道路上更便宜，让居民自然地沿路行走
      const t = world.tiles[ni];
      const cost = t === T.PATH || t === T.PLAZA || t === T.BRIDGE || t === T.WOOD || t === T.DIRT ? 1 : 2.2;
      const ng = g[ci] + cost;
      if (ng < g[ni]) {
        g[ni] = ng; came[ni] = ci;
        open.push([ng + Math.abs(nx - tx) + Math.abs(ny - ty), nx, ny]);
      }
    }
  }
  return null;
}
