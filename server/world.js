// 云溪镇地图生成：瓦片、建筑、装饰物、地点与站位点（确定性随机，前后端共享同一份数据）
export const T = {
  GRASS: 0, PATH: 1, PLAZA: 2, DIRT: 3, WATER: 4, SAND: 5, BRIDGE: 6, SOIL: 7, WOOD: 8, DEEP: 9, FLOWER: 10,
};
const WALKABLE = new Set([T.GRASS, T.PATH, T.PLAZA, T.DIRT, T.SAND, T.BRIDGE, T.SOIL, T.WOOD, T.FLOWER]);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BUILDINGS = [
  { id: 'home_lin', name: '林家小屋', kind: 'house', x: 2, y: 3, w: 5, h: 5, roof: '#d4606f' },
  { id: 'home_su', name: '苏家小屋', kind: 'house', x: 7, y: 3, w: 5, h: 5, roof: '#5b7bb4' },
  { id: 'home_zhou', name: '周家小屋', kind: 'house', x: 2, y: 9, w: 5, h: 5, roof: '#6aa56b' },
  { id: 'home_wang', name: '王家老宅', kind: 'house', x: 7, y: 9, w: 5, h: 5, roof: '#e39a3b' },
  { id: 'library', name: '云溪图书馆', kind: 'library', x: 17, y: 5, w: 9, h: 8, roof: '#7a5aa6' },
  { id: 'home_sun', name: '孙婆婆家', kind: 'house', x: 26, y: 9, w: 5, h: 5, roof: '#b86b4b' },
  { id: 'cafe', name: '星光咖啡馆', kind: 'cafe', x: 34, y: 6, w: 7, h: 7, roof: '#c4553f' },
  { id: 'clinic', name: '云溪诊所', kind: 'clinic', x: 3, y: 19, w: 7, h: 6, roof: '#e8e8ee' },
  { id: 'tavern', name: '月光酒馆', kind: 'tavern', x: 34, y: 18, w: 8, h: 6, roof: '#3d4a78' },
  { id: 'workshop', name: '铁柱工坊', kind: 'workshop', x: 34, y: 25, w: 6, h: 4, roof: '#7b6b5b' },
  { id: 'home_chen', name: '陈家农舍', kind: 'farmhouse', x: 52, y: 19, w: 5, h: 5, roof: '#a0452f' },
];

export const LOCATION_INFO = {
  home: { name: '自己家', emoji: '🏠', desc: '自己的家（休息、做饭、独处）' },
  cafe: { name: '星光咖啡馆', emoji: '☕', desc: '林晓雨经营的咖啡馆，带露台，07:00-20:00营业，镇上的社交中心' },
  library: { name: '云溪图书馆', emoji: '📚', desc: '苏墨管理的图书馆，安静，可以看书写作查资料' },
  tavern: { name: '月光酒馆', emoji: '🍺', desc: '何月经营的酒馆，傍晚后热闹，有驻唱与美酒' },
  clinic: { name: '云溪诊所', emoji: '🏥', desc: '周慧医生的诊所，看病、体检' },
  workshop: { name: '铁柱工坊', emoji: '🔨', desc: '赵铁柱的木工铁艺工坊，带后院' },
  square: { name: '中央广场', emoji: '⛲', desc: '镇中心，有喷泉、舞台和公告栏，镇民聚集闲聊的地方' },
  market: { name: '广场集市', emoji: '🧺', desc: '广场四周的小摊，买菜买花买杂货' },
  park: { name: '樱花公园', emoji: '🌸', desc: '樱花树、小池塘和长椅，散步、晒太阳、喂鸽子' },
  farm: { name: '陈家农场', emoji: '🌾', desc: '陈大山的农田，种着西瓜和蔬菜' },
  pier: { name: '镜湖码头', emoji: '🎣', desc: '湖边木码头，钓鱼、看日落、发呆' },
};

// 生成器 yunxi-v1：建筑与地点信息可由世界规格传入，默认使用上面的常量
export function buildWorld({ buildings: buildingDefs = BUILDINGS, locationInfo = LOCATION_INFO } = {}) {
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
  const buildings = buildingDefs.map((b) => {
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

  return { W, H, tiles, walk, objects, buildings, locations, lamps };
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
