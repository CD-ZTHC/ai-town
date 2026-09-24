// 世界渲染器：程序化像素地形 + 建筑 + y 排序物体/角色 + 昼夜光照 + 天气与粒子
import { buildSprites, makePortrait, shade, SPR_W, SPR_H } from './sprites.js';

export const TS = 32;
const T = { GRASS: 0, PATH: 1, PLAZA: 2, DIRT: 3, WATER: 4, SAND: 5, BRIDGE: 6, SOIL: 7, WOOD: 8, DEEP: 9, FLOWER: 10 };
const SCALE = 2; // 角色精灵放大倍数
const STATIC_OBJECTS = new Set(['fence', 'crop', 'bench', 'rock', 'stage', 'hay', 'anvil', 'woodpile']);

// ---------- 工具 ----------
function h2(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const sm = (t) => t * t * (3 - 2 * t);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  const u = sm(xf), v = sm(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(c1, c2, t) {
  t = Math.max(0, Math.min(1, t));
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// 天空：返回黑暗度与色调
export function skyAt(minute, weather) {
  const h = minute / 60;
  let dark, warm = 0, pink = 0;
  if (h < 4.5) dark = 0.66;
  else if (h < 6.5) { dark = lerp(0.66, 0, (h - 4.5) / 2); pink = Math.sin(((h - 4.5) / 2) * Math.PI) * 0.8; }
  else if (h < 16.5) dark = 0;
  else if (h < 18.5) { dark = lerp(0, 0.22, (h - 16.5) / 2); warm = (h - 16.5) / 2; }
  else if (h < 20) { dark = lerp(0.22, 0.66, (h - 18.5) / 1.5); warm = 1 - (h - 18.5) / 1.5; }
  else dark = 0.66;
  const wd = { sunny: 0, cloudy: 0.08, rain: 0.2, storm: 0.3, fog: 0.1, snow: 0.08 }[weather] || 0;
  return { dark: Math.min(0.78, dark + wd * (1 - dark)), warm, pink, night: dark > 0.3 };
}

// ---------- 渲染器 ----------
export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap.getContext('2d');
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d');
    this.sprites = {};
    this.portraits = {};
    this.particles = { rain: [], snow: [], splash: [], smoke: [], petals: [], spray: [], flies: [], lanterns: [], butterflies: [], birds: [] };
    this.flash = 0;
    this.nextLightning = 5;
    this.time = 0;
    this.hits = [];
    this.bubbleSeen = new Map();
    this.vfx = [];
    this.creatureSprites = {};
  }

  /** 世界规格里的异界生物图鉴 → 预生成像素精灵 */
  setCreatureTypes(types = {}) {
    for (const [id, c] of Object.entries(types)) if (!this.creatureSprites[id] && c.look?.bodyPlan) this.creatureSprites[id] = buildSprites(c.look);
  }

  /** 能力等产生的一次性特效（世界坐标，单位：格） */
  addVfx(v) {
    this.vfx.push({ ...v, born: this.time, life: v.preset === 'ripple' ? 2.4 : 1.8 });
    if (this.vfx.length > 40) this.vfx.shift();
  }

  // ---------- 初始化 ----------
  setWorld(world) {
    this.world = world;
    const { W, H } = world;
    this.tileAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : world.tiles[y * W + x]);
    this.buildTreeSprites();
    this.buildStatic();
    this.buildMinimap();
    // 静态物体已画进底图，其余（包括世界规格里新增的未知类型）都按动态物体参与 y 排序绘制
    this.dynamic = world.objects.filter((o) => !STATIC_OBJECTS.has(o.type));
    const P = this.particles;
    P.flies = Array.from({ length: 46 }, () => this.newFly());
    P.butterflies = Array.from({ length: 10 }, () => ({ x: 2 + Math.random() * 28, y: 33 + Math.random() * 9, vx: 0, vy: 0, c: ['#fff4a3', '#ffc6e0', '#bfe3ff', '#ffffff'][Math.floor(Math.random() * 4)], ph: Math.random() * 6 }));
  }

  newFly() {
    const zones = [[2, 33, 29, 10], [44, 30, 18, 3], [15, 36, 15, 6], [38, 2, 8, 12]];
    const z = zones[Math.floor(Math.random() * zones.length)];
    return { x: z[0] + Math.random() * z[2], y: z[1] + Math.random() * z[3], ph: Math.random() * 10, sp: 0.3 + Math.random() * 0.6 };
  }

  setAgents(list) {
    this.meta = Object.fromEntries(list.map((a) => [a.id, a]));
    for (const a of list) {
      this.sprites[a.id] = buildSprites(a.look);
      this.portraits[a.id] = makePortrait(this.sprites[a.id], a.look.shirt);
      const img = new Image();
      img.src = this.portraits[a.id];
      this.meta[a.id].portraitImg = img;
    }
  }

  // ---------- 树的预渲染 ----------
  buildTreeSprites() {
    const make = (kind, v) => {
      const c = document.createElement('canvas');
      c.width = 84; c.height = 100;
      const g = c.getContext('2d');
      const pal = {
        oak: ['#2f6b35', '#3f8a3e', '#56a84a', '#77c35c', '#9ad874'],
        sakura: ['#b75c86', '#d97aa3', '#ee9fc0', '#f7bfd6', '#fde0ec'],
        pine: ['#1f4d3a', '#2b6547', '#3a7d55', '#4f9966', '#6bb37d'],
      }[kind];
      const canopy = document.createElement('canvas');
      canopy.width = 84; canopy.height = 100;
      const cg = canopy.getContext('2d');
      // 树干
      g.fillStyle = '#6b4a2f';
      g.fillRect(37, 50, 10, 38);
      g.fillStyle = '#54391f';
      g.fillRect(43, 50, 4, 38);
      g.fillStyle = '#7d5a3a';
      g.fillRect(34, 84, 16, 4);
      const B = 3;
      if (kind === 'pine') {
        for (let by = 4; by < 78; by += B) for (let bx = 8; bx < 76; bx += B) {
          const layer = Math.floor((by - 4) / 20);
          const ly = (by - 4) % 20;
          const half = 8 + layer * 7 + ly * 0.9;
          const dx = bx - 42;
          if (Math.abs(dx) > half) continue;
          const l = clamp01(0.55 - dx / (half * 2.2) - ly / 40 + (h2(bx, by, v * 99) - 0.5) * 0.35);
          cg.fillStyle = pal[Math.min(4, Math.floor(l * 5))];
          cg.fillRect(bx, by, B, B);
        }
      } else {
        const r0 = 22 + v * 5;
        const blobs = [[42, 36, r0], [30, 44, r0 * 0.75], [54, 44, r0 * 0.75], [42, 24, r0 * 0.7], [35, 30, r0 * 0.6], [50, 30, r0 * 0.6]];
        for (let by = 0; by < 80; by += B) for (let bx = 0; bx < 84; bx += B) {
          let inside = false, best = 9;
          for (const [cx, cy, r] of blobs) {
            const d = Math.hypot(bx - cx, by - cy) / r;
            if (d < 1) { inside = true; best = Math.min(best, d); }
          }
          if (!inside) continue;
          const l = clamp01(0.62 - (bx - 42) / 80 - (by - 34) / 55 - best * 0.25 + (h2(bx, by, v * 77) - 0.5) * 0.3);
          cg.fillStyle = pal[Math.min(4, Math.floor(l * 5))];
          cg.fillRect(bx, by, B, B);
        }
        if (kind === 'oak' && v > 0.6) {
          // 果实
          for (let i = 0; i < 5; i++) {
            cg.fillStyle = '#e8573f';
            cg.fillRect(26 + h2(i, 3, v * 50) * 32, 24 + h2(i, 7, v * 50) * 30, 3, 3);
          }
        }
      }
      return { trunk: c, canopy };
    };
    this.trees = {};
    for (const k of ['oak', 'sakura', 'pine']) this.trees[k] = [0.1, 0.5, 0.9].map((v) => make(k, v));
  }

  // ---------- 静态地面层 ----------
  buildStatic() {
    const { W, H } = this.world;
    const c = document.createElement('canvas');
    c.width = W * TS; c.height = H * TS;
    const g = c.getContext('2d');
    this.static = c;
    const tile = this.tileAt;
    const isGround = (t) => t === T.GRASS || t === T.FLOWER;
    const isWater = (t) => t === T.WATER || t === T.DEEP;

    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tile(x, y);
      const X = x * TS, Y = y * TS;
      if (t === T.GRASS || t === T.FLOWER) this.paintGrass(g, x, y, t === T.FLOWER);
      else if (t === T.PATH) this.paintCobble(g, x, y);
      else if (t === T.PLAZA) this.paintPlaza(g, x, y);
      else if (t === T.DIRT) this.paintSpeckle(g, x, y, '#c9a46e', '#b58f5a', '#d8b884');
      else if (t === T.SAND) this.paintSpeckle(g, x, y, '#ecd9a2', '#dcc68a', '#f6e8bd');
      else if (t === T.SOIL) {
        this.paintSpeckle(g, x, y, '#8a5c3a', '#744a2c', '#9a6a45');
        g.fillStyle = 'rgba(60,35,20,.45)';
        for (let i = 4; i < TS; i += 8) g.fillRect(X, Y + i, TS, 2);
      } else if (isWater(t)) {
        const deep = t === T.DEEP;
        for (let by = 0; by < TS; by += 4) for (let bx = 0; bx < TS; bx += 4) {
          const n = vnoise((X + bx) / 90, (Y + by) / 90, 3);
          g.fillStyle = mix(deep ? '#2c6fa8' : '#3f95cf', deep ? '#3a86c0' : '#5bb0de', n);
          g.fillRect(X + bx, Y + by, 4, 4);
        }
      } else if (t === T.BRIDGE || t === T.WOOD) {
        const vertical = t === T.BRIDGE ? isWater(tile(x, y - 1)) || isWater(tile(x, y + 1)) ? false : true : false;
        const horizontalPlanks = t === T.WOOD ? !(tile(x, y - 1) === T.WOOD && tile(x, y + 1) === T.WOOD && tile(x - 1, y) !== T.WOOD) : vertical;
        g.fillStyle = '#6e4a2c';
        g.fillRect(X, Y, TS, TS);
        for (let i = 0; i < 4; i++) {
          g.fillStyle = ['#b98b58', '#a97c4b', '#c39664', '#ad7f4e'][(i + x + y) % 4];
          if (horizontalPlanks) g.fillRect(X, Y + i * 8, TS, 7);
          else g.fillRect(X + i * 8, Y, 7, TS);
        }
        g.fillStyle = 'rgba(60,40,20,.5)';
        if (horizontalPlanks) { g.fillRect(X + 4, Y + 3, 2, 2); g.fillRect(X + 26, Y + 19, 2, 2); }
        else { g.fillRect(X + 3, Y + 4, 2, 2); g.fillRect(X + 19, Y + 26, 2, 2); }
        if (t === T.BRIDGE) {
          // 栏杆
          g.fillStyle = '#5a3a20';
          if (!isWater(tile(x, y - 1)) && tile(x, y - 1) !== T.BRIDGE) g.fillRect(X, Y, TS, 4);
          if (!isWater(tile(x, y + 1)) && tile(x, y + 1) !== T.BRIDGE) g.fillRect(X, Y + TS - 4, TS, 4);
          if (tile(x, y - 1) !== T.BRIDGE) { g.fillStyle = '#7a5230'; g.fillRect(X, Y, TS, 3); }
          if (tile(x, y + 1) !== T.BRIDGE) { g.fillStyle = '#7a5230'; g.fillRect(X, Y + TS - 3, TS, 3); }
        }
      }
    }
    // 边缘过渡：草地侵入道路，水边泡沫
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tile(x, y);
      const X = x * TS, Y = y * TS;
      if (t === T.PATH || t === T.DIRT || t === T.PLAZA || t === T.SAND) {
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          if (!isGround(tile(x + dx, y + dy))) continue;
          for (let i = 0; i < TS; i += 3) {
            const len = 1 + Math.floor(h2(x * 7 + i, y * 3 + dx + dy * 5) * 4);
            g.fillStyle = h2(i, x + y) > 0.5 ? '#6fae4f' : '#7dbb58';
            if (dy === -1) g.fillRect(X + i, Y, 3, len);
            if (dy === 1) g.fillRect(X + i, Y + TS - len, 3, len);
            if (dx === -1) g.fillRect(X, Y + i, len, 3);
            if (dx === 1) g.fillRect(X + TS - len, Y + i, len, 3);
          }
        }
      }
      if (isWater(t)) {
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nt = tile(x + dx, y + dy);
          if (nt < 0 || isWater(nt) || nt === T.BRIDGE || nt === T.WOOD) continue;
          g.fillStyle = 'rgba(255,255,255,.55)';
          if (dy === -1) g.fillRect(X, Y, TS, 3);
          if (dy === 1) g.fillRect(X, Y + TS - 3, TS, 3);
          if (dx === -1) g.fillRect(X, Y, 3, TS);
          if (dx === 1) g.fillRect(X + TS - 3, Y, 3, TS);
          g.fillStyle = 'rgba(30,70,110,.35)';
          if (dy === -1) g.fillRect(X, Y + 3, TS, 4);
          if (dx === -1) g.fillRect(X + 3, Y, 4, TS);
          if (dx === 1) g.fillRect(X + TS - 7, Y, 4, TS);
        }
      }
    }
    // 广场马赛克：喷泉周围的圆环
    g.save();
    g.strokeStyle = 'rgba(170,140,110,.55)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(22.5 * TS, 23.5 * TS, 3.1 * TS, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(200,120,90,.35)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(22.5 * TS, 23.5 * TS, 3.6 * TS, 0, Math.PI * 2); g.stroke();
    g.restore();

    // 静态物体
    for (const o of this.world.objects) {
      const X = o.x * TS, Y = o.y * TS;
      if (o.type === 'fence') this.drawFence(g, o, X, Y);
      else if (o.type === 'crop') this.drawCrop(g, o, X, Y);
      else if (o.type === 'bench') this.drawBench(g, X, Y);
      else if (o.type === 'rock') this.drawRock(g, o, X, Y);
      else if (o.type === 'stage') this.drawStage(g, o, X, Y);
      else if (o.type === 'hay') this.drawHay(g, X, Y);
      else if (o.type === 'anvil') this.drawAnvil(g, X, Y);
      else if (o.type === 'woodpile') this.drawWoodpile(g, X, Y);
    }
    // 建筑
    this.windows = [];
    this.chimneys = [];
    for (const b of this.world.buildings) this.drawBuilding(g, b);
  }

  paintGrass(g, x, y, flowers) {
    const X = x * TS, Y = y * TS;
    for (let by = 0; by < TS; by += 4) for (let bx = 0; bx < TS; bx += 4) {
      const n = vnoise((X + bx) / 150, (Y + by) / 150) * 0.8 + (h2(X + bx, Y + by) - 0.5) * 0.3;
      g.fillStyle = mix('#68a74a', '#8cc963', n);
      g.fillRect(X + bx, Y + by, 4, 4);
    }
    for (let i = 0; i < 4; i++) {
      const tx = X + Math.floor(h2(x, y, i) * 28), ty = Y + Math.floor(h2(y, x, i + 9) * 26);
      g.fillStyle = h2(x, y, i + 3) > 0.5 ? '#5a9640' : '#9fd877';
      g.fillRect(tx, ty + 2, 1, 3); g.fillRect(tx + 2, ty, 1, 5); g.fillRect(tx + 4, ty + 2, 1, 3);
    }
    if (flowers) {
      const cols = ['#ff7aa2', '#ffd35c', '#ffffff', '#b58cff', '#ff9d5c', '#7ec8ff'];
      const n = 3 + Math.floor(h2(x, y, 5) * 3);
      for (let i = 0; i < n; i++) {
        const fx = X + 3 + Math.floor(h2(x, y, i + 20) * 24), fy = Y + 3 + Math.floor(h2(x, y, i + 40) * 24);
        g.fillStyle = '#3f7a32'; g.fillRect(fx + 1, fy + 3, 1, 3);
        g.fillStyle = cols[Math.floor(h2(x, y, i + 60) * cols.length)];
        g.fillRect(fx, fy + 1, 3, 1); g.fillRect(fx + 1, fy, 1, 3);
        g.fillStyle = '#ffe98a'; g.fillRect(fx + 1, fy + 1, 1, 1);
      }
    }
  }

  paintCobble(g, x, y) {
    const X = x * TS, Y = y * TS;
    g.fillStyle = '#b3a07a';
    g.fillRect(X, Y, TS, TS);
    for (let r = 0; r < 4; r++) {
      const off = (r + y * 4) % 2 ? 4 : 0;
      for (let cI = -1; cI < 4; cI++) {
        const sx = X + cI * 8 + off, sy = Y + r * 8;
        const n = h2(x * 4 + cI, y * 4 + r);
        g.fillStyle = mix('#cbb88e', '#e3d4ae', n);
        const x0 = Math.max(X, sx + 1), x1 = Math.min(X + TS, sx + 8);
        if (x1 > x0) g.fillRect(x0, sy + 1, x1 - x0, 6);
        g.fillStyle = 'rgba(255,255,255,.18)';
        if (x1 > x0) g.fillRect(x0, sy + 1, x1 - x0, 1);
      }
    }
  }

  paintPlaza(g, x, y) {
    const X = x * TS, Y = y * TS;
    const alt = (x + y) % 2;
    g.fillStyle = alt ? '#e8dcc2' : '#ddd0b3';
    g.fillRect(X, Y, TS, TS);
    g.fillStyle = 'rgba(150,125,95,.35)';
    g.fillRect(X, Y, TS, 1); g.fillRect(X, Y, 1, TS);
    g.fillStyle = 'rgba(255,255,255,.25)';
    g.fillRect(X + 1, Y + 1, TS - 2, 1);
    if (h2(x, y, 11) > 0.8) { g.fillStyle = 'rgba(150,125,95,.25)'; g.fillRect(X + 8 + h2(x, y) * 12, Y + 10, 6, 1); }
  }

  paintSpeckle(g, x, y, base, dark, light) {
    const X = x * TS, Y = y * TS;
    g.fillStyle = base;
    g.fillRect(X, Y, TS, TS);
    for (let i = 0; i < 14; i++) {
      g.fillStyle = h2(x, y, i) > 0.5 ? dark : light;
      g.fillRect(X + Math.floor(h2(x, y, i + 30) * 30), Y + Math.floor(h2(x, y, i + 50) * 30), 2, 2);
    }
  }

  drawFence(g, o, X, Y) {
    g.fillStyle = 'rgba(0,0,0,.15)';
    g.fillRect(X, Y + 24, TS, 4);
    g.fillStyle = '#8a6440';
    if (o.dir === 'h') { g.fillRect(X, Y + 10, TS, 4); g.fillRect(X, Y + 18, TS, 4); }
    else { g.fillRect(X + 13, Y, 6, TS); }
    g.fillStyle = '#a57b50';
    g.fillRect(X + 12, Y + 4, 8, 22);
    g.fillStyle = '#c29a6c';
    g.fillRect(X + 12, Y + 4, 8, 3);
  }

  drawCrop(g, o, X, Y) {
    for (let i = 0; i < 3; i++) {
      const cx = X + 5 + i * 10, cy = Y + 16;
      if (o.kind === 'melon') {
        g.fillStyle = '#3c7a2e'; g.fillRect(cx - 4, cy - 6, 8, 3);
        g.fillStyle = '#2f6d2f'; g.beginPath(); g.ellipse(cx, cy + 2, 5, 4, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#5aa84a'; g.fillRect(cx - 3, cy, 1, 5); g.fillRect(cx, cy - 1, 1, 6); g.fillRect(cx + 3, cy, 1, 5);
      } else {
        g.fillStyle = '#4f9a3c'; g.fillRect(cx - 1, cy - 6, 2, 8);
        g.fillStyle = '#6fc24f'; g.fillRect(cx - 4, cy - 3, 3, 2); g.fillRect(cx + 1, cy - 5, 3, 2);
        if (h2(i, o.x, o.y) > 0.5) { g.fillStyle = '#e04a3a'; g.fillRect(cx - 1, cy + 1, 3, 3); }
      }
    }
  }

  drawBench(g, X, Y) {
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(X + 3, Y + 22, 28, 5);
    g.fillStyle = '#5b4030'; g.fillRect(X + 4, Y + 16, 3, 8); g.fillRect(X + 25, Y + 16, 3, 8);
    g.fillStyle = '#b07a48'; g.fillRect(X + 2, Y + 13, 28, 5);
    g.fillStyle = '#c99060'; g.fillRect(X + 2, Y + 13, 28, 2);
    g.fillStyle = '#9a6a3e'; g.fillRect(X + 2, Y + 6, 28, 4);
  }

  drawRock(g, o, X, Y) {
    const r = 5 + o.v * 5;
    g.fillStyle = 'rgba(0,0,0,.15)'; g.beginPath(); g.ellipse(X + 17, Y + 22, r + 2, r * 0.5, 0, 0, 7); g.fill();
    g.fillStyle = '#8f949c'; g.beginPath(); g.ellipse(X + 16, Y + 18, r, r * 0.75, 0, 0, 7); g.fill();
    g.fillStyle = '#b4b9c0'; g.beginPath(); g.ellipse(X + 14, Y + 16, r * 0.5, r * 0.35, 0, 0, 7); g.fill();
  }

  drawStage(g, o, X, Y) {
    const w = o.w * TS, h = o.h * TS;
    g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(X + 4, Y + 6, w, h);
    g.fillStyle = '#7a4f2e'; g.fillRect(X, Y + h - 8, w, 8);
    for (let i = 0; i < w; i += 8) { g.fillStyle = i % 16 ? '#c08a55' : '#b37d4a'; g.fillRect(X + i, Y, 7, h - 8); }
    g.fillStyle = '#d9a46a'; g.fillRect(X, Y, w, 2);
    // 彩旗
    const cols = ['#ff6b6b', '#ffd166', '#4ecdc4', '#a78bfa', '#ff9f68'];
    g.strokeStyle = '#5a4030'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(X, Y + 2); g.quadraticCurveTo(X + w / 2, Y + 14, X + w, Y + 2); g.stroke();
    for (let i = 1; i < 12; i++) {
      const t = i / 12, fx = X + w * t, fy = Y + 2 + Math.sin(t * Math.PI) * 6;
      g.fillStyle = cols[i % cols.length];
      g.beginPath(); g.moveTo(fx - 4, fy); g.lineTo(fx + 4, fy); g.lineTo(fx, fy + 7); g.fill();
    }
  }

  drawHay(g, X, Y) {
    g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(X + 17, Y + 26, 15, 5, 0, 0, 7); g.fill();
    g.fillStyle = '#d9b44a'; g.beginPath(); g.ellipse(X + 16, Y + 18, 14, 11, 0, 0, 7); g.fill();
    g.fillStyle = '#e9cb6a'; for (let i = 0; i < 8; i++) g.fillRect(X + 5 + i * 3, Y + 10 + (i % 3) * 3, 2, 8);
    g.fillStyle = '#b58f2f'; g.fillRect(X + 3, Y + 18, 26, 2);
  }

  drawAnvil(g, X, Y) {
    g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(X + 6, Y + 24, 22, 4);
    g.fillStyle = '#6a4a30'; g.fillRect(X + 9, Y + 16, 14, 10);
    g.fillStyle = '#4a4e57'; g.fillRect(X + 5, Y + 9, 22, 7); g.fillRect(X + 11, Y + 15, 10, 4);
    g.fillStyle = '#6f7582'; g.fillRect(X + 5, Y + 9, 22, 2);
  }

  drawWoodpile(g, X, Y) {
    for (let r = 0; r < 3; r++) for (let i = 0; i < 3 - r; i++) {
      const cx = X + 8 + i * 9 + r * 4.5, cy = Y + 24 - r * 7;
      g.fillStyle = '#8a5a30'; g.beginPath(); g.arc(cx, cy, 4.5, 0, 7); g.fill();
      g.fillStyle = '#d9b27a'; g.beginPath(); g.arc(cx, cy, 3, 0, 7); g.fill();
      g.fillStyle = '#b48650'; g.fillRect(cx - 1, cy - 1, 2, 2);
    }
  }

  drawBuilding(g, b) {
    const X = b.x * TS, Y = b.y * TS, w = b.w * TS, h = b.h * TS;
    const kind = b.kind;
    // 未知类型（由世界规格新增的建筑）使用 b.wall 或默认墙色
    const wallC = { house: '#f2e2c2', library: '#e9dfcf', cafe: '#fbe8d2', tavern: '#7b5a40', clinic: '#f7f8fb', workshop: '#a58b6c', farmhouse: '#e8cfa6' }[kind] || b.wall || '#e8dcc4';
    const roofC = b.roof;
    const roofH = Math.round(h * (kind === 'library' ? 0.5 : 0.55));
    // 阴影
    g.fillStyle = 'rgba(20,30,20,.22)';
    g.beginPath(); g.moveTo(X + w, Y + 14); g.lineTo(X + w + 12, Y + 24); g.lineTo(X + w + 12, Y + h + 6); g.lineTo(X + 8, Y + h + 6); g.lineTo(X, Y + h); g.lineTo(X + w, Y + h); g.fill();

    // 墙面
    const wy = Y + roofH - 4;
    g.fillStyle = wallC;
    g.fillRect(X + 2, wy, w - 4, h - roofH + 4);
    if (kind === 'tavern' || kind === 'workshop' || kind === 'farmhouse') {
      for (let i = 0; i < w - 4; i += 8) { g.fillStyle = shade(wallC, i % 16 ? -0.06 : 0.04); g.fillRect(X + 2 + i, wy, 7, h - roofH + 4); }
    } else {
      for (let yy = wy + 6; yy < Y + h - 6; yy += 7) { g.fillStyle = shade(wallC, -0.05); g.fillRect(X + 2, yy, w - 4, 1); }
    }
    g.fillStyle = shade(wallC, -0.22);
    g.fillRect(X + 2, Y + h - 6, w - 4, 6);
    g.fillStyle = 'rgba(0,0,0,.08)';
    g.fillRect(X + w - 8, wy, 6, h - roofH + 4);
    if (kind === 'library') {
      for (let i = 0; i < 5; i++) {
        const cx = X + 14 + i * ((w - 28) / 4);
        g.fillStyle = '#f7f1e6'; g.fillRect(cx - 4, wy + 2, 8, h - roofH - 6);
        g.fillStyle = '#d8cfbd'; g.fillRect(cx + 2, wy + 2, 2, h - roofH - 6);
      }
    }

    // 窗户
    const doorX = b.door.x * TS + TS / 2;
    const winY = wy + (h - roofH) * 0.28;
    const winW = 16, winH = 15;
    const slots = [];
    const span = w / 2 - 18;
    const count = Math.max(1, Math.floor(span / 34));
    for (let i = 0; i < count; i++) {
      const off = 26 + i * 32;
      if (doorX - off - winW / 2 > X + 6) slots.push(doorX - off);
      if (doorX + off + winW / 2 < X + w - 6) slots.push(doorX + off);
    }
    if (kind === 'library') slots.splice(0, slots.length, ...[0.2, 0.36, 0.64, 0.8].map((t) => X + w * t));
    for (const cx of slots) {
      const wx = Math.round(cx - winW / 2), wyy = Math.round(winY);
      g.fillStyle = '#5a4030'; g.fillRect(wx - 2, wyy - 2, winW + 4, winH + 4);
      const gr = g.createLinearGradient(wx, wyy, wx + winW, wyy + winH);
      gr.addColorStop(0, '#bfe4f7'); gr.addColorStop(1, '#6fa9cf');
      g.fillStyle = gr; g.fillRect(wx, wyy, winW, winH);
      g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(wx + 2, wyy + 2, 4, 2); g.fillRect(wx + 2, wyy + 4, 2, 3);
      g.fillStyle = '#5a4030'; g.fillRect(wx + winW / 2 - 1, wyy, 2, winH); g.fillRect(wx, wyy + winH / 2 - 1, winW, 2);
      // 花箱
      if (kind === 'house' || kind === 'cafe') {
        g.fillStyle = '#8a5a3a'; g.fillRect(wx - 2, wyy + winH + 2, winW + 4, 4);
        for (let i = 0; i < 5; i++) { g.fillStyle = ['#ff6b8a', '#ffd166', '#ff9ec0'][i % 3]; g.fillRect(wx + i * 4, wyy + winH, 3, 3); }
      }
      this.windows.push({ b: b.id, x: wx, y: wyy, w: winW, h: winH });
    }

    // 门
    const dW = 18, dH = 24;
    const dx = Math.round(doorX - dW / 2), dy = Y + h - 6 - dH;
    g.fillStyle = '#4a3222'; g.fillRect(dx - 2, dy - 2, dW + 4, dH + 2);
    g.fillStyle = kind === 'clinic' ? '#8fb8d8' : kind === 'cafe' ? '#a0463a' : '#7a5234';
    g.fillRect(dx, dy, dW, dH);
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(dx + dW / 2 - 1, dy, 2, dH);
    g.fillStyle = '#f2c14e'; g.fillRect(dx + dW - 5, dy + 12, 2, 2);
    g.fillStyle = '#b8b0a0'; g.fillRect(dx - 4, Y + h - 4, dW + 8, 4);
    this.windows.push({ b: b.id, x: dx, y: dy, w: dW, h: dH, door: true });

    // 屋顶
    const ov = 5;
    const rt = Y + 2;
    g.fillStyle = shade(roofC, -0.35);
    g.fillRect(X - ov, Y + roofH - 4, w + ov * 2, 6);
    g.fillStyle = roofC;
    g.beginPath();
    g.moveTo(X - ov, Y + roofH - 2);
    g.lineTo(X + w + ov, Y + roofH - 2);
    g.lineTo(X + w - 4, rt + 6);
    g.lineTo(X + 4, rt + 6);
    g.closePath(); g.fill();
    // 瓦片
    g.save(); g.clip();
    for (let yy = rt + 8, row = 0; yy < Y + roofH; yy += 7, row++) {
      g.fillStyle = shade(roofC, -0.16);
      g.fillRect(X - ov, yy + 5, w + ov * 2, 2);
      for (let xx = X - ov + (row % 2) * 6; xx < X + w + ov; xx += 12) {
        g.fillStyle = shade(roofC, 0.1);
        g.fillRect(xx + 1, yy, 8, 2);
      }
    }
    const rg = g.createLinearGradient(X, 0, X + w, 0);
    rg.addColorStop(0, 'rgba(255,255,255,.12)'); rg.addColorStop(0.6, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,.18)');
    g.fillStyle = rg; g.fillRect(X - ov, rt, w + ov * 2, roofH);
    g.restore();
    g.fillStyle = shade(roofC, 0.28);
    g.fillRect(X + 4, rt + 4, w - 8, 4);
    g.fillStyle = shade(roofC, -0.3);
    g.fillRect(X + 4, rt + 8, w - 8, 1);

    // 烟囱
    if (kind === 'house' || kind === 'farmhouse' || kind === 'tavern' || kind === 'workshop' || kind === 'cafe') {
      const cx = X + w * 0.74, cy = rt - 6;
      g.fillStyle = '#8a4a3a'; g.fillRect(cx, cy, 11, 18);
      g.fillStyle = '#a85a46'; for (let i = 0; i < 18; i += 5) g.fillRect(cx, cy + i, 11, 1);
      g.fillStyle = '#5a2e24'; g.fillRect(cx - 1, cy - 2, 13, 4);
      this.chimneys.push({ b: b.id, x: cx + 5.5, y: cy - 2 });
    }

    // 特色装饰
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (kind === 'cafe') {
      // 条纹遮阳篷
      const ay = wy + 2;
      for (let i = 0; i < w - 12; i += 8) { g.fillStyle = (i / 8) % 2 ? '#fff6ea' : '#d9534f'; g.fillRect(X + 6 + i, ay, 8, 10); }
      for (let i = 0; i < w - 12; i += 8) { g.fillStyle = (i / 8) % 2 ? '#fff6ea' : '#d9534f'; g.beginPath(); g.arc(X + 10 + i, ay + 10, 4, 0, Math.PI); g.fill(); }
    }
    if (kind === 'clinic') {
      g.fillStyle = '#e74c3c';
      const cx = X + w / 2, cy = Y + roofH * 0.5;
      g.fillRect(cx - 9, cy - 3, 18, 6); g.fillRect(cx - 3, cy - 9, 6, 18);
    }
    if (kind === 'tavern') {
      g.fillStyle = '#f5d76e'; g.beginPath(); g.arc(X + w / 2, Y + roofH * 0.48, 9, 0, 7); g.fill();
      g.fillStyle = b.roof; g.beginPath(); g.arc(X + w / 2 + 4, Y + roofH * 0.48 - 3, 8, 0, 7); g.fill();
    }
    // 招牌
    const signs = { cafe: '☕', library: '📚', tavern: '🍺', clinic: '', workshop: '🔨', farmhouse: '🌾' };
    if (!signs[kind] && b.sign) signs[kind] = b.sign; // 新增建筑的招牌
    if (signs[kind]) {
      const sx = doorX + 22, sy = dy + 2;
      g.fillStyle = '#5a3e28'; g.fillRect(sx - 1, sy - 4, 2, 6);
      g.fillStyle = '#e8d2a8'; roundRect(g, sx - 9, sy + 1, 18, 15, 3); g.fill();
      g.strokeStyle = '#6a4a30'; g.lineWidth = 1.5; g.stroke();
      g.font = '11px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
      g.fillText(signs[kind], sx, sy + 9);
    }
  }

  // ---------- 小地图 ----------
  buildMinimap() {
    const { W, H, tiles } = this.world;
    const s = 3;
    const c = document.createElement('canvas');
    c.width = W * s; c.height = H * s;
    const g = c.getContext('2d');
    const col = { 0: '#78b656', 1: '#d7c79f', 2: '#e4d8bd', 3: '#c6a06a', 4: '#4b9fd4', 5: '#e9d59c', 6: '#a77a4c', 7: '#8a5c3a', 8: '#b98b58', 9: '#2f76ae', 10: '#86c160' };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { g.fillStyle = col[tiles[y * W + x]]; g.fillRect(x * s, y * s, s, s); }
    for (const o of this.world.objects) if (o.type === 'tree') { g.fillStyle = o.kind === 'sakura' ? '#e89ab8' : '#3f7d3c'; g.fillRect(o.x * s, o.y * s, s, s); }
    for (const b of this.world.buildings) { g.fillStyle = b.roof; g.fillRect(b.x * s, b.y * s, b.w * s, b.h * s); g.strokeStyle = 'rgba(0,0,0,.4)'; g.strokeRect(b.x * s + 0.5, b.y * s + 0.5, b.w * s - 1, b.h * s - 1); }
    this.miniBase = c;
    this.miniScale = s;
    this.mini.width = W * s; this.mini.height = H * s;
  }

  // ---------- 每帧 ----------
  resize(w, h, dpr) {
    this.vw = w; this.vh = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.light.width = Math.round(w * dpr / 2); this.light.height = Math.round(h * dpr / 2);
  }

  worldToScreen(wx, wy, cam) {
    return [(wx - cam.x) * cam.zoom + this.vw / 2, (wy - cam.y) * cam.zoom + this.vh / 2];
  }
  screenToWorld(sx, sy, cam) {
    return [(sx - this.vw / 2) / cam.zoom + cam.x, (sy - this.vh / 2) / cam.zoom + cam.y];
  }

  frame(S, dt) {
    this.time += dt;
    const { ctx, dpr } = this;
    const cam = S.cam;
    const minute = S.t % 1440;
    const sky = skyAt(minute, S.weather);
    this.sky = sky;
    const festival = S.festival;
    this.S = S;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1a2a1e';
    ctx.fillRect(0, 0, this.vw, this.vh);

    // 世界坐标变换
    const z = cam.zoom;
    const ox = this.vw / 2 - cam.x * z, oy = this.vh / 2 - cam.y * z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);
    const vx0 = cam.x - this.vw / 2 / z, vy0 = cam.y - this.vh / 2 / z;
    const vx1 = cam.x + this.vw / 2 / z, vy1 = cam.y + this.vh / 2 / z;
    this.view = { x0: vx0, y0: vy0, x1: vx1, y1: vy1 };

    // 地面
    const sx = Math.max(0, Math.floor(vx0)), sy = Math.max(0, Math.floor(vy0));
    const sw = Math.min(this.static.width, Math.ceil(vx1)) - sx, sh = Math.min(this.static.height, Math.ceil(vy1)) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(this.static, sx, sy, sw, sh, sx, sy, sw, sh);

    this.drawWater(ctx, vx0, vy0, vx1, vy1);

    // y 排序
    const items = [];
    const pad = 3 * TS;
    for (const o of this.dynamic) {
      const px = o.x * TS, py = o.y * TS;
      if (px < vx0 - pad || px > vx1 + pad || py < vy0 - pad || py > vy1 + pad * 2) continue;
      items.push({ y: (o.y + (o.h || 1)) * TS - (o.type === 'lily' || o.type === 'boat' ? 1000 : 0), o });
    }
    for (const a of S.agents) {
      if (a.inside) continue;
      items.push({ y: a.dy * TS + TS * 0.9, a });
    }
    for (const e of S.entities || []) {
      if (e.inside) continue;
      items.push({ y: e.kind === 'portal' ? -1e6 : e.y * TS + TS * 0.8, e });
    }
    for (const c of S.creatures || []) items.push({ y: c.dy * TS + TS * 0.9, c });
    items.sort((p, q) => p.y - q.y);
    for (const it of items) it.o ? this.drawObject(ctx, it.o, S) : it.e ? (it.e.kind === 'portal' ? this.drawPortal(ctx, it.e) : this.drawEntity(ctx, it.e)) : it.c ? this.drawCreature(ctx, it.c) : this.drawAgent(ctx, it.a, S);
    this.drawVfx(ctx);

    this.updateParticles(dt, S, sky);
    this.drawWorldParticles(ctx, S, sky);
    this.drawCloudShadows(ctx, S);

    // 光照
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawLighting(S, sky, ox, oy, z);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawWeather(ctx, S, dt);
    // UI 叠加层（屏幕坐标）
    this.hits = [];
    this.drawOverlays(ctx, S, ox, oy, z);
    this.drawMinimap(S);
  }

  drawWater(ctx, vx0, vy0, vx1, vy1) {
    const { W, H } = this.world;
    const t = this.time;
    const x0 = Math.max(0, Math.floor(vx0 / TS)), y0 = Math.max(0, Math.floor(vy0 / TS));
    const x1 = Math.min(W - 1, Math.ceil(vx1 / TS)), y1 = Math.min(H - 1, Math.ceil(vy1 / TS));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const tt = this.tileAt(x, y);
      if (tt !== T.WATER && tt !== T.DEEP) continue;
      const X = x * TS, Y = y * TS;
      const river = x >= 44 && x <= 49 && y < 32;
      for (let i = 0; i < 2; i++) {
        const ph = h2(x, y, i) * 6.28;
        const a = (Math.sin(t * 1.6 + ph) + 1) / 2;
        if (a < 0.35) continue;
        ctx.fillStyle = `rgba(255,255,255,${(a - 0.35) * 0.55})`;
        const drift = river ? ((t * 14 + h2(x, y, i + 5) * 32) % 32) : Math.sin(t * 0.8 + ph) * 3;
        const lx = X + 4 + h2(x, y, i + 2) * 18, ly = Y + 6 + h2(x, y, i + 3) * 20;
        if (river) ctx.fillRect(lx, Y + drift, 2, 6);
        else ctx.fillRect(lx + drift, ly, 7, 2);
      }
    }
  }

  drawObject(ctx, o, S) {
    const X = o.x * TS, Y = o.y * TS, t = this.time;
    const wind = S.weather === 'storm' ? 3.2 : S.weather === 'rain' ? 1.8 : 1;
    switch (o.type) {
      case 'tree': {
        const spr = this.trees[o.kind][Math.floor(o.v * 3) % 3];
        ctx.fillStyle = 'rgba(15,35,15,.25)';
        ctx.beginPath(); ctx.ellipse(X + 18, Y + 28, 20, 7, 0, 0, 7); ctx.fill();
        const bx = X + 16 - 42, by = Y + 30 - 88;
        ctx.drawImage(spr.trunk, bx, by);
        const sway = Math.sin(t * 1.2 + o.v * 20) * 1.4 * wind + Math.sin(t * 2.7 + o.x) * 0.4 * wind;
        ctx.drawImage(spr.canopy, bx + sway, by);
        break;
      }
      case 'bush': {
        ctx.fillStyle = 'rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(X + 16, Y + 26, 13, 5, 0, 0, 7); ctx.fill();
        const cols = ['#3e7f3a', '#4f9a45', '#69b456'];
        [[16, 16, 11], [9, 19, 7], [23, 19, 7], [16, 12, 7]].forEach(([cx, cy, r], i) => { ctx.fillStyle = cols[i % 3]; ctx.beginPath(); ctx.arc(X + cx, Y + cy, r, 0, 7); ctx.fill(); });
        if (o.v > 0.5) { ctx.fillStyle = o.v > 0.75 ? '#ff6b8a' : '#fff'; for (let i = 0; i < 4; i++) ctx.fillRect(X + 8 + i * 5, Y + 12 + (i % 2) * 6, 3, 3); }
        break;
      }
      case 'lamp': {
        const on = this.sky.dark > 0.15;
        ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(X + 12, Y + 26, 10, 3);
        ctx.fillStyle = '#34343f'; ctx.fillRect(X + 14, Y - 18, 4, 46);
        ctx.fillStyle = '#4a4a58'; ctx.fillRect(X + 12, Y + 24, 8, 4);
        ctx.fillStyle = '#2a2a33'; ctx.fillRect(X + 9, Y - 28, 14, 3); ctx.fillRect(X + 11, Y - 31, 10, 3);
        ctx.fillStyle = on ? '#ffe7a3' : '#cfd8dc'; ctx.fillRect(X + 10, Y - 25, 12, 9);
        ctx.fillStyle = '#2a2a33'; ctx.fillRect(X + 10, Y - 17, 12, 2); ctx.fillRect(X + 15, Y - 25, 2, 9);
        break;
      }
      case 'stall': {
        const w = o.w * TS;
        ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(X + 4, Y + 24, w, 6);
        ctx.fillStyle = '#8a5a34'; ctx.fillRect(X + 2, Y + 12, w - 4, 14);
        ctx.fillStyle = '#a56d40'; ctx.fillRect(X + 2, Y + 12, w - 4, 3);
        ctx.font = '12px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 0; i < 4; i++) ctx.fillText(o.goods, X + 10 + i * 14, Y + 10);
        ctx.fillStyle = '#5a3a22'; ctx.fillRect(X + 3, Y - 22, 3, 36); ctx.fillRect(X + w - 6, Y - 22, 3, 36);
        for (let i = 0; i < w + 4; i += 8) {
          ctx.fillStyle = (i / 8) % 2 ? '#fff8ec' : o.color;
          ctx.fillRect(X - 2 + i, Y - 26, 8, 10);
          ctx.beginPath(); ctx.arc(X + 2 + i, Y - 16, 4, 0, Math.PI); ctx.fill();
        }
        break;
      }
      case 'fountain': this.drawFountain(ctx, X, Y, S); break;
      case 'board': {
        ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(X + 2, Y + 26, 30, 4);
        ctx.fillStyle = '#5a3a22'; ctx.fillRect(X + 4, Y - 6, 3, 34); ctx.fillRect(X + 25, Y - 6, 3, 34);
        ctx.fillStyle = '#8a5a34'; ctx.fillRect(X, Y - 12, 32, 26);
        ctx.fillStyle = '#c99a62'; ctx.fillRect(X + 2, Y - 10, 28, 22);
        const n = Math.min(4, (S.boardCount || 0) + 2);
        for (let i = 0; i < n; i++) { ctx.fillStyle = ['#fffbe8', '#ffe3e3', '#e3f2ff', '#fff'][i]; ctx.fillRect(X + 4 + (i % 2) * 13, Y - 8 + Math.floor(i / 2) * 10, 11, 8); ctx.fillStyle = '#e74c3c'; ctx.fillRect(X + 9 + (i % 2) * 13, Y - 8 + Math.floor(i / 2) * 10, 2, 2); }
        if (S.boardCount) {
          const b = Math.sin(t * 4) * 2;
          ctx.fillStyle = '#ffcf40'; ctx.beginPath(); ctx.arc(X + 16, Y - 22 + b, 7, 0, 7); ctx.fill();
          ctx.fillStyle = '#5a3a00'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', X + 16, Y - 21 + b);
        }
        break;
      }
      case 'table': {
        ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(X + 16, Y + 26, 14, 5, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#6a4a30'; ctx.fillRect(X + 15, Y + 8, 3, 18);
        ctx.fillStyle = '#f4ead8'; ctx.beginPath(); ctx.ellipse(X + 16, Y + 16, 11, 5, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillRect(X + 10, Y + 13, 4, 3); ctx.fillStyle = '#6b3e1e'; ctx.fillRect(X + 11, Y + 13, 2, 1);
        ctx.fillStyle = '#5a3a22'; ctx.fillRect(X + 15, Y - 24, 2, 34);
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = i % 2 ? '#fff6ea' : o.color;
          ctx.beginPath(); ctx.moveTo(X + 16, Y - 30); ctx.lineTo(X - 4 + i * 6.7, Y - 16); ctx.lineTo(X + 2.7 + i * 6.7, Y - 16); ctx.fill();
        }
        break;
      }
      case 'balloon': this.drawBalloon(ctx, X, Y, S); break;
      case 'well': {
        ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(X + 16, Y + 26, 15, 5, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#8d8f98'; ctx.fillRect(X + 3, Y + 10, 26, 16);
        ctx.fillStyle = '#a9abb3'; for (let i = 0; i < 26; i += 7) ctx.fillRect(X + 3 + i, Y + 10, 6, 7);
        ctx.fillStyle = '#2e5e86'; ctx.fillRect(X + 6, Y + 8, 20, 4);
        ctx.fillStyle = '#5a3a22'; ctx.fillRect(X + 4, Y - 10, 3, 22); ctx.fillRect(X + 25, Y - 10, 3, 22);
        ctx.fillStyle = '#a0452f'; ctx.beginPath(); ctx.moveTo(X - 2, Y - 8); ctx.lineTo(X + 16, Y - 22); ctx.lineTo(X + 34, Y - 8); ctx.fill();
        break;
      }
      case 'scarecrow': {
        const s = Math.sin(t * 1.5) * 1.5 * wind;
        ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.fillRect(X + 10, Y + 26, 12, 3);
        ctx.fillStyle = '#6a4a30'; ctx.fillRect(X + 15, Y - 10, 3, 38); ctx.fillRect(X + 3 + s, Y, 26, 3);
        ctx.fillStyle = '#c0504d'; ctx.fillRect(X + 9 + s / 2, Y + 2, 14, 12);
        ctx.fillStyle = '#e8c56f'; ctx.beginPath(); ctx.arc(X + 16 + s / 2, Y - 8, 6, 0, 7); ctx.fill();
        ctx.fillStyle = '#b58f2f'; ctx.fillRect(X + 6 + s / 2, Y - 12, 20, 3); ctx.fillRect(X + 11 + s / 2, Y - 18, 10, 6);
        ctx.fillStyle = '#333'; ctx.fillRect(X + 13 + s / 2, Y - 9, 2, 2); ctx.fillRect(X + 18 + s / 2, Y - 9, 2, 2);
        break;
      }
      case 'boat': {
        const bob = Math.sin(t * 1.3) * 2, rot = Math.sin(t * 0.9) * 0.05;
        ctx.save(); ctx.translate(X + 16, Y + 16 + bob); ctx.rotate(rot);
        ctx.fillStyle = 'rgba(20,50,80,.3)'; ctx.beginPath(); ctx.ellipse(2, 8, 26, 6, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#7a4a2a'; ctx.beginPath(); ctx.moveTo(-26, -2); ctx.lineTo(26, -2); ctx.lineTo(18, 8); ctx.lineTo(-18, 8); ctx.fill();
        ctx.fillStyle = '#a86a3a'; ctx.fillRect(-24, -4, 48, 4);
        ctx.fillStyle = '#e8d8b8'; ctx.fillRect(-4, -4, 8, 4);
        ctx.restore();
        break;
      }
      case 'lily': {
        const bob = Math.sin(t + o.v * 9) * 1;
        ctx.fillStyle = '#3f8f45'; ctx.beginPath(); ctx.arc(X + 16, Y + 16 + bob, 7, 0.4, Math.PI * 2 - 0.1); ctx.lineTo(X + 16, Y + 16 + bob); ctx.fill();
        ctx.fillStyle = '#5bb15e'; ctx.beginPath(); ctx.arc(X + 14, Y + 14 + bob, 3, 0, 7); ctx.fill();
        if (o.v > 0.6) { ctx.fillStyle = '#ffc2d8'; ctx.beginPath(); ctx.arc(X + 19, Y + 13 + bob, 3, 0, 7); ctx.fill(); ctx.fillStyle = '#fff3a0'; ctx.fillRect(X + 18, Y + 12 + bob, 2, 2); }
        break;
      }
      default: {
        // 兜底：没有专门绘制函数的物体（例如 AI 新增的类型）画成带阴影的 emoji
        const w = (o.w || 1) * TS, h = (o.h || 1) * TS;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,.18)';
        ctx.beginPath(); ctx.ellipse(X + w / 2, Y + h - 3, w * 0.4, 5, 0, 0, 7); ctx.fill();
        ctx.font = `${Math.round(Math.min(w, h) * 0.8)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(o.emoji || '❔', X + w / 2, Y + h - 2);
        ctx.restore();
      }
    }
  }

  /** 构筑物（例如萤火结界）：地面光圈 + 浮动的 emoji */
  drawEntity(ctx, e) {
    const X = e.x * TS + TS / 2, Y = e.y * TS + TS / 2, t = this.time;
    const col = e.light?.color || '255,220,140';
    const pulse = 0.5 + Math.sin(t * 2.4 + e.x) * 0.15;
    const r = (e.light ? e.light.r / 110 : 1) * TS * 2.6;
    const g = ctx.createRadialGradient(X, Y + 8, 4, X, Y + 8, r);
    g.addColorStop(0, `rgba(${col},${0.32 * pulse})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.fillRect(X - r, Y + 8 - r, r * 2, r * 2);
    ctx.strokeStyle = `rgba(${col},${0.55 * pulse})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(X, Y + 10, r * 0.55, r * 0.22, 0, 0, 7); ctx.stroke();
    ctx.save();
    ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const n = e.light ? 5 : 1;
    for (let i = 0; i < n; i++) {
      const ang = t * 0.6 + (i / n) * Math.PI * 2;
      const px = n > 1 ? X + Math.cos(ang) * r * 0.5 : X, py = n > 1 ? Y + 10 + Math.sin(ang) * r * 0.2 : Y + 10;
      ctx.fillText(e.emoji || '✨', px, py - 4 + Math.sin(t * 3 + i) * 2);
    }
    ctx.restore();
  }

  /** 镜湖裂隙：旋转的紫色涡流，大小随阶段变化 */
  drawPortal(ctx, e) {
    const X = e.x * TS + TS / 2, Y = e.y * TS + TS / 2, t = this.time;
    const size = { crack: 0.5, open: 1.3, wide: 2.2, stable: 1.4 }[e.stage] ?? 1;
    const stable = e.stage === 'stable';
    const R = TS * 1.6 * size;
    const g = ctx.createRadialGradient(X, Y, 2, X, Y, R * 1.6);
    g.addColorStop(0, stable ? 'rgba(255,230,160,.55)' : 'rgba(190,150,255,.65)');
    g.addColorStop(0.5, stable ? 'rgba(180,160,255,.25)' : 'rgba(110,70,200,.35)');
    g.addColorStop(1, 'rgba(60,30,120,0)');
    ctx.fillStyle = g; ctx.fillRect(X - R * 1.6, Y - R * 1.6, R * 3.2, R * 3.2);
    ctx.save();
    ctx.translate(X, Y); ctx.scale(1, 0.45);
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = stable ? `rgba(255,${220 - i * 20},150,${0.7 - i * 0.12})` : `rgba(${180 - i * 20},${120 - i * 15},255,${0.8 - i * 0.15})`;
      ctx.lineWidth = 3 - i * 0.5;
      ctx.beginPath(); ctx.arc(0, 0, R * (1 - i * 0.2), t * (1.2 + i * 0.4), t * (1.2 + i * 0.4) + Math.PI * 1.3); ctx.stroke();
    }
    if (e.stage === 'crack') { ctx.strokeStyle = 'rgba(200,170,255,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-R, 0); ctx.lineTo(-R * 0.3, -4); ctx.lineTo(R * 0.2, 3); ctx.lineTo(R, -1); ctx.stroke(); }
    ctx.restore();
  }

  /** 异界生物：沿用角色精灵管线，漂浮 + 底部微光 */
  drawCreature(ctx, c) {
    const spr = this.creatureSprites[c.type];
    if (!spr) return;
    const cx = c.dx * TS + TS / 2, fy = c.dy * TS + TS - 2;
    const fi = c.moving ? [1, 0, 2, 0][Math.floor(this.time * 6) % 4] : Math.floor(this.time * 2) % 2;
    const float = Math.sin(this.time * 3 + c.dx) * 2;
    ctx.fillStyle = c.friendly ? 'rgba(255,170,220,.35)' : 'rgba(110,80,220,.35)';
    ctx.beginPath(); ctx.ellipse(cx, fy, 10, 4, 0, 0, 7); ctx.fill();
    const img = spr[c.dir]?.[fi] || spr.down[0];
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(img, Math.round(cx - (SPR_W * SCALE) / 2), Math.round(fy - SPR_H * SCALE + 4 + float), SPR_W * SCALE, SPR_H * SCALE);
    ctx.restore();
    if (c.friendly && c.name) {
      ctx.save(); ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd6ee';
      ctx.fillText(`💜${c.name}`, cx, fy - SPR_H * SCALE - 2); ctx.restore();
    }
  }

  drawVfx(ctx) {
    const t = this.time;
    this.vfx = this.vfx.filter((v) => t - v.born < v.life);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const v of this.vfx) {
      const k = (t - v.born) / v.life; // 0 → 1
      const X = v.x * TS + TS / 2, Y = v.y * TS + TS / 2;
      const R = (v.radius || 2) * TS;
      const [r, g, b] = hexToRgb(v.color || '#ffe08a');
      const a = 1 - k;
      ctx.globalAlpha = a;
      switch (v.preset) {
        case 'glow_ring':
        case 'ripple': {
          const rings = v.preset === 'ripple' ? 3 : 2;
          for (let i = 0; i < rings; i++) {
            const kk = Math.max(0, k - i * 0.15);
            ctx.strokeStyle = `rgb(${r},${g},${b})`; ctx.lineWidth = 3 * (1 - kk);
            ctx.beginPath(); ctx.ellipse(X, Y + 8, R * kk, R * kk * 0.45, 0, 0, 7); ctx.stroke();
          }
          break;
        }
        case 'burst': {
          for (let i = 0; i < 12; i++) {
            const ang = (i / 12) * Math.PI * 2;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(X + Math.cos(ang) * R * k * 1.4 - 2, Y + Math.sin(ang) * R * k * 1.4 - 2, 4, 4);
          }
          break;
        }
        case 'sparkle':
        case 'heal':
        case 'notes': {
          const glyph = { sparkle: '✦', heal: '✚', notes: '♪' }[v.preset];
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.font = `bold ${v.preset === 'notes' ? 18 : 14}px sans-serif`;
          for (let i = 0; i < 6; i++) {
            const ox = Math.sin(i * 2.1) * R * 0.6 + Math.sin(t * 4 + i) * 4;
            ctx.fillText(glyph, X + ox, Y - 10 - k * 40 - (i % 3) * 10);
          }
          break;
        }
      }
    }
    ctx.restore();
  }

  drawFountain(ctx, X, Y, S) {
    const t = this.time;
    const cx = X + 48, cy = Y + 50;
    ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(cx + 3, cy + 8, 50, 30, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#9ea3ad'; ctx.beginPath(); ctx.ellipse(cx, cy + 4, 48, 30, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#c3c8d0'; ctx.beginPath(); ctx.ellipse(cx, cy, 48, 28, 0, 0, 7); ctx.fill();
    const wg = ctx.createRadialGradient(cx, cy, 5, cx, cy, 42);
    wg.addColorStop(0, '#7fd0f0'); wg.addColorStop(1, '#3a8fc8');
    ctx.fillStyle = wg; ctx.beginPath(); ctx.ellipse(cx, cy, 40, 22, 0, 0, 7); ctx.fill();
    // 涟漪
    for (let i = 0; i < 3; i++) {
      const p = ((t * 0.5 + i / 3) % 1);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - p)})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(cx, cy, 8 + p * 30, 4 + p * 16, 0, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = '#b4b9c2'; ctx.fillRect(cx - 5, cy - 30, 10, 30);
    ctx.fillStyle = '#d4d8de'; ctx.fillRect(cx - 5, cy - 30, 4, 30);
    ctx.fillStyle = '#c3c8d0'; ctx.beginPath(); ctx.ellipse(cx, cy - 30, 16, 7, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#6fc0e8'; ctx.beginPath(); ctx.ellipse(cx, cy - 31, 12, 4, 0, 0, 7); ctx.fill();
    // 水柱粒子
    const P = this.particles.spray;
    if (P.length < 90) for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      P.push({ x: cx, y: cy - 34, vx: Math.cos(a) * (14 + Math.random() * 10), vy: -40 - Math.random() * 20, z: cy - 34, life: 0 });
    }
    ctx.fillStyle = 'rgba(210,240,255,.85)';
    for (const p of P) ctx.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
  }

  drawBalloon(ctx, X, Y, S) {
    const t = this.time;
    const minute = S.t % 1440;
    const launched = S.festival && minute > 19.5 * 60;
    const inflating = S.day >= 3 && !launched;
    ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(X + 16, Y + 28, 14, 5, 0, 0, 7); ctx.fill();
    if (!launched) {
      ctx.fillStyle = '#8a5a30'; ctx.fillRect(X + 6, Y + 12, 20, 16);
      ctx.fillStyle = '#b07a44'; for (let i = 0; i < 20; i += 4) ctx.fillRect(X + 6 + i, Y + 12, 2, 16);
      if (inflating) {
        const s = 0.6 + Math.sin(t * 0.8) * 0.05;
        this.balloonShape(ctx, X + 16, Y - 30, 26 * s);
        ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X + 8, Y + 12); ctx.lineTo(X + 4, Y - 20); ctx.moveTo(X + 24, Y + 12); ctx.lineTo(X + 28, Y - 20); ctx.stroke();
      } else {
        ctx.fillStyle = '#e9a23b'; ctx.beginPath(); ctx.ellipse(X + 20, Y + 4, 14, 7, 0.3, 0, 7); ctx.fill();
        ctx.fillStyle = '#d9534f'; ctx.beginPath(); ctx.ellipse(X + 12, Y + 6, 9, 5, -0.3, 0, 7); ctx.fill();
      }
    } else {
      const rise = Math.min(260, (minute - 19.5 * 60) * 6);
      const bx = X + 16 + Math.sin(t * 0.4) * 10, by = Y - 60 - rise + Math.sin(t * 0.9) * 4;
      this.balloonShape(ctx, bx, by, 34);
      ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx - 14, by + 26); ctx.lineTo(bx - 8, by + 48); ctx.moveTo(bx + 14, by + 26); ctx.lineTo(bx + 8, by + 48); ctx.stroke();
      ctx.fillStyle = '#8a5a30'; ctx.fillRect(bx - 9, by + 48, 18, 12);
      const fl = 0.6 + Math.random() * 0.4;
      ctx.fillStyle = `rgba(255,170,60,${fl})`; ctx.beginPath(); ctx.ellipse(bx, by + 40, 3, 6 * fl, 0, 0, 7); ctx.fill();
      this.balloonLight = { x: bx, y: by };
    }
  }

  balloonShape(ctx, x, y, r) {
    const cols = ['#e74c3c', '#f1c40f', '#3498db', '#f1c40f', '#e74c3c'];
    ctx.save();
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.9, r, 0, 0, Math.PI * 2); ctx.clip();
    for (let i = 0; i < 5; i++) { ctx.fillStyle = cols[i]; ctx.fillRect(x - r + (i * 2 * r) / 5, y - r, (2 * r) / 5 + 1, r * 2); }
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 2, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,.4)'); g.addColorStop(1, 'rgba(0,0,0,.25)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }

  drawAgent(ctx, a, S) {
    const spr = this.sprites[a.id];
    if (!spr) return;
    const cx = a.dx * TS + TS / 2, fy = a.dy * TS + TS - 2;
    const walking = a.moving;
    const fi = walking ? [1, 0, 2, 0][Math.floor(a.walkPhase * 2) % 4] : 0;
    let bob = walking && fi ? -1 : 0;
    if (a.speaking) bob -= Math.abs(Math.sin(this.time * 9)) * 2;
    const sel = S.selected === a.id;
    // 影子
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(cx, fy, 11, 4, 0, 0, 7); ctx.fill();
    if (sel || S.hover === a.id) {
      const p = (Math.sin(this.time * 4) + 1) / 2;
      ctx.strokeStyle = sel ? `rgba(255,214,102,${0.6 + p * 0.4})` : 'rgba(255,255,255,.7)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, fy, 15 + p * 3, 6 + p, 0, 0, 7); ctx.stroke();
    }
    const img = spr[a.dir]?.[fi] || spr.down[0];
    ctx.drawImage(img, Math.round(cx - (SPR_W * SCALE) / 2), Math.round(fy - SPR_H * SCALE + 4 + bob), SPR_W * SCALE, SPR_H * SCALE);
  }

  // ---------- 粒子 ----------
  updateParticles(dt, S, sky) {
    const P = this.particles;
    const minute = S.t % 1440;
    // 喷泉
    for (const p of P.spray) { p.vy += 90 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life += dt; }
    P.spray = P.spray.filter((p) => p.y < p.z + 40 && p.life < 2);
    // 炊烟：有人在家的房子，早晚
    const h = minute / 60;
    const cooking = (h > 6 && h < 9) || (h > 17 && h < 21);
    for (const c of this.chimneys) {
      const occ = S.occupancy[c.b]?.length;
      if ((occ && (cooking || S.weather === 'snow')) || c.b === 'tavern' && h > 17) {
        if (Math.random() < dt * 3) P.smoke.push({ x: c.x, y: c.y, vx: 4 + Math.random() * 6, vy: -12 - Math.random() * 6, r: 3, life: 0 });
      }
    }
    for (const p of P.smoke) { p.x += p.vx * dt; p.y += p.vy * dt; p.r += 4 * dt; p.life += dt; }
    P.smoke = P.smoke.filter((p) => p.life < 3.5);
    // 樱花花瓣
    if (P.petals.length < 70 && Math.random() < dt * 12) {
      P.petals.push({ x: (2 + Math.random() * 30) * TS, y: (31 + Math.random() * 10) * TS, vx: 10 + Math.random() * 12, vy: 8 + Math.random() * 8, rot: Math.random() * 6, life: 0, max: 4 + Math.random() * 4 });
    }
    const wind = S.weather === 'storm' ? 3 : 1;
    for (const p of P.petals) { p.x += p.vx * dt * wind; p.y += p.vy * dt + Math.sin(p.life * 3) * 0.3; p.rot += dt * 2; p.life += dt; }
    P.petals = P.petals.filter((p) => p.life < p.max);
    // 萤火虫
    for (const f of P.flies) { f.ph += dt * f.sp; f.x += Math.cos(f.ph * 1.3) * dt * 0.4; f.y += Math.sin(f.ph * 1.7) * dt * 0.3; }
    // 蝴蝶
    for (const b of P.butterflies) {
      b.ph += dt * 3;
      b.vx += (Math.random() - 0.5) * dt * 4; b.vy += (Math.random() - 0.5) * dt * 4;
      b.vx *= 0.97; b.vy *= 0.97;
      b.x = Math.max(2, Math.min(30, b.x + b.vx * dt)); b.y = Math.max(32, Math.min(42, b.y + b.vy * dt));
    }
    // 飞鸟
    if (!sky.night && S.weather !== 'storm' && Math.random() < dt * 0.04 && P.birds.length < 2) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      P.birds.push({ x: dir > 0 ? -60 : this.vw + 60, y: 60 + Math.random() * this.vh * 0.5, vx: dir * (50 + Math.random() * 30), n: 3 + Math.floor(Math.random() * 4), ph: 0 });
    }
    for (const b of P.birds) { b.x += b.vx * dt; b.ph += dt * 10; }
    P.birds = P.birds.filter((b) => b.x > -100 && b.x < this.vw + 100);
    // 萤火节：湖面河灯与天灯
    if (S.festival && sky.night) {
      if (P.lanterns.length < 80 && Math.random() < dt * 5) {
        const onWater = Math.random() < 0.55;
        P.lanterns.push(onWater
          ? { water: true, x: (46 + Math.random() * 16) * TS, y: (33 + Math.random() * 9) * TS, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 2, life: 0, max: 40 }
          : { water: false, x: (48 + Math.random() * 6) * TS, y: 37.5 * TS, vx: (Math.random() - 0.5) * 8, vy: -14 - Math.random() * 10, life: 0, max: 30 });
      }
    }
    for (const l of P.lanterns) { l.x += l.vx * dt; l.y += l.vy * dt; l.life += dt; }
    P.lanterns = P.lanterns.filter((l) => l.life < l.max);
  }

  drawWorldParticles(ctx, S, sky) {
    const P = this.particles;
    for (const p of P.smoke) {
      ctx.fillStyle = `rgba(230,230,235,${0.45 * (1 - p.life / 3.5)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    for (const p of P.petals) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = `rgba(255,${190 + Math.floor(p.rot * 5) % 30},215,${Math.min(1, (p.max - p.life))})`;
      ctx.fillRect(-2, -1, 4, 2.5);
      ctx.restore();
    }
    if (!sky.night && S.weather === 'sunny') {
      for (const b of P.butterflies) {
        const f = Math.abs(Math.sin(b.ph * 4)) * 3 + 1;
        const x = b.x * TS, y = b.y * TS - 10;
        ctx.fillStyle = b.c;
        ctx.fillRect(x - f, y - 2, f, 3); ctx.fillRect(x + 1, y - 2, f, 3);
        ctx.fillStyle = '#333'; ctx.fillRect(x, y - 2, 1, 4);
      }
    }
    for (const l of P.lanterns) {
      if (!l.water) continue;
      const x = l.x, y = l.y + Math.sin(this.time * 2 + l.x) * 1.5;
      ctx.fillStyle = '#d9534f'; ctx.fillRect(x - 3, y - 4, 6, 5);
      ctx.fillStyle = '#ffd98a'; ctx.fillRect(x - 2, y - 3, 4, 3);
    }
  }

  drawCloudShadows(ctx, S) {
    if (!['sunny', 'cloudy'].includes(S.weather)) return;
    const a = S.weather === 'cloudy' ? 0.13 : 0.06;
    const t = this.time;
    const { W, H } = this.world;
    for (let i = 0; i < 6; i++) {
      const x = ((h2(i, 1) * W * TS + t * (12 + i * 3)) % (W * TS + 600)) - 300;
      const y = h2(i, 2) * H * TS;
      const r = 140 + h2(i, 3) * 160;
      const g = ctx.createRadialGradient(x, y, 10, x, y, r);
      g.addColorStop(0, `rgba(20,30,50,${a})`); g.addColorStop(1, 'rgba(20,30,50,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.4, r, 0, 0, 7); ctx.fill();
    }
  }

  drawLighting(S, sky, ox, oy, z) {
    const { ctx, lctx, light, dpr } = this;
    const minute = S.t % 1440;
    // 晨昏色调
    if (sky.warm > 0.01) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(255,120,40,${0.55 * Math.sin(sky.warm * Math.PI)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (sky.pink > 0.01) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(255,140,190,${0.45 * sky.pink})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (sky.dark < 0.02) return;
    const ls = (dpr / 2); // 光照图为半分辨率
    const toL = (wx, wy) => [(wx * z + ox) * ls, (wy * z + oy) * ls];
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, light.width, light.height);
    lctx.fillStyle = `rgba(10,14,42,${sky.dark})`;
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.globalCompositeOperation = 'destination-out';
    const lights = this.collectLights(S, sky, minute);
    const inView = (x, y, r) => x > this.view.x0 - r && x < this.view.x1 + r && y > this.view.y0 - r && y < this.view.y1 + r;
    for (const L of lights) {
      if (!inView(L.x, L.y, L.r)) continue;
      const [lx, ly] = toL(L.x, L.y);
      const r = L.r * z * ls;
      const g = lctx.createRadialGradient(lx, ly, 0, lx, ly, r);
      g.addColorStop(0, `rgba(0,0,0,${L.i})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(lx - r, ly - r, r * 2, r * 2);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(light, 0, 0, this.canvas.width, this.canvas.height);
    // 暖色辉光
    ctx.globalCompositeOperation = 'lighter';
    const k = Math.min(1, sky.dark * 1.6);
    for (const L of lights) {
      if (!L.c || !inView(L.x, L.y, L.r)) continue;
      const x = (L.x * z + ox) * dpr, y = (L.y * z + oy) * dpr, r = L.r * 0.7 * z * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${L.c},${0.35 * k * L.i})`); g.addColorStop(1, `rgba(${L.c},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 点亮的窗户
    for (const w of this.litWindows) {
      ctx.fillStyle = `rgba(255,200,100,${0.75 * k})`;
      ctx.fillRect((w.x * z + ox) * dpr, (w.y * z + oy) * dpr, w.w * z * dpr, w.h * z * dpr);
    }
    // 萤火虫 & 灯笼
    const P = this.particles;
    for (const f of P.flies) {
      const a = (Math.sin(f.ph * 3) + 1) / 2 * k * (S.festival ? 1.3 : 1);
      if (a < 0.05) continue;
      const x = (f.x * TS * z + ox) * dpr, y = (f.y * TS * z + oy) * dpr;
      const r = 7 * z * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(220,255,140,${a})`); g.addColorStop(1, 'rgba(220,255,140,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (const l of P.lanterns) {
      const fade = Math.min(1, l.life / 2, (l.max - l.life) / 3);
      const x = (l.x * z + ox) * dpr, y = ((l.y + (l.water ? Math.sin(this.time * 2 + l.x) * 1.5 : 0)) * z + oy) * dpr;
      const r = (l.water ? 18 : 14) * z * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,150,50,${0.55 * fade})`); g.addColorStop(1, 'rgba(255,100,30,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      if (!l.water) {
        ctx.fillStyle = `rgba(255,210,140,${fade})`;
        ctx.fillRect(x - 3 * z * dpr, y - 4 * z * dpr, 6 * z * dpr, 8 * z * dpr);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
  }

  collectLights(S, sky, minute) {
    const out = [];
    const on = sky.dark > 0.15;
    const h = minute / 60;
    if (on) for (const l of this.world.lamps) {
      out.push({ x: l.x * TS + 16, y: l.y * TS - 16, r: 120, i: 0.95, c: '255,190,110' });
    }
    this.litWindows = [];
    if (on) {
      for (const w of this.windows) {
        const occ = S.occupancy[w.b]?.length || 0;
        const asleep = occ && S.occupancy[w.b].every((id) => S.agentMap[id]?.status === 'sleeping');
        const open = (w.b === 'tavern' && h > 16) || (w.b === 'cafe' && h > 6.5 && h < 20.5);
        const lit = (occ && !asleep) || open || (h < 22 && h > 18 && (w.b.startsWith('home_') && h2(w.x, w.y) > 0.5));
        if (!lit) continue;
        this.litWindows.push(w);
        out.push({ x: w.x + w.w / 2, y: w.y + w.h + 6, r: w.door ? 50 : 42, i: 0.85, c: '255,180,90' });
      }
    }
    out.push({ x: 22.5 * TS, y: 23.5 * TS, r: 90, i: 0.5, c: '120,200,255' });
    for (const a of S.agents) {
      if (a.inside || !on) continue;
      out.push({ x: a.dx * TS + 16, y: a.dy * TS + 10, r: 56, i: 0.7, c: '255,200,120' });
    }
    if (on) for (const c of S.creatures || []) out.push({ x: c.dx * TS + 16, y: c.dy * TS + 8, r: 34, i: 0.6, c: c.friendly ? '255,170,220' : '150,120,255' });
    if (on) for (const e of S.entities || []) {
      if (e.light && !e.inside) out.push({ x: e.x * TS + 16, y: e.y * TS + 16, r: e.light.r * 1.6, i: 0.95, c: e.light.color });
    }
    if (S.festival && on) {
      for (const l of this.particles.lanterns) out.push({ x: l.x, y: l.y, r: l.water ? 46 : 36, i: 0.9, c: '255,160,70' });
      if (this.balloonLight) out.push({ x: this.balloonLight.x, y: this.balloonLight.y + 20, r: 110, i: 0.9, c: '255,170,80' });
    }
    return out;
  }

  drawWeather(ctx, S, dt) {
    const P = this.particles;
    const W = this.vw, H = this.vh;
    const rainy = S.weather === 'rain' || S.weather === 'storm';
    const target = S.weather === 'storm' ? 650 : S.weather === 'rain' ? 380 : 0;
    while (P.rain.length < target) P.rain.push({ x: Math.random() * W * 1.2, y: Math.random() * H, l: 10 + Math.random() * 14, v: 700 + Math.random() * 400 });
    if (P.rain.length > target) P.rain.length = target;
    if (rainy) {
      const slant = S.weather === 'storm' ? 0.35 : 0.15;
      ctx.strokeStyle = 'rgba(190,210,255,.45)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of P.rain) {
        d.y += d.v * dt; d.x -= d.v * slant * dt;
        if (d.y > H) {
          if (Math.random() < 0.3) P.splash.push({ x: d.x, y: Math.random() * H, life: 0 });
          d.y = -20; d.x = Math.random() * W * 1.2 + 40;
        }
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * slant, d.y - d.l);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(40,60,90,.12)'; ctx.fillRect(0, 0, W, H);
    }
    for (const s of P.splash) {
      s.life += dt;
      ctx.strokeStyle = `rgba(210,225,255,${0.5 * (1 - s.life / 0.4)})`;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 2 + s.life * 14, 1 + s.life * 5, 0, 0, 7); ctx.stroke();
    }
    P.splash = P.splash.filter((s) => s.life < 0.4);
    // 闪电
    if (S.weather === 'storm') {
      this.nextLightning -= dt;
      if (this.nextLightning < 0) { this.flash = 1; this.nextLightning = 4 + Math.random() * 10; }
    }
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(230,235,255,${this.flash * 0.55})`; ctx.fillRect(0, 0, W, H);
      this.flash = Math.max(0, this.flash - dt * 3.5);
      if (this.flash > 0.6 && Math.random() < 0.3) this.flash = 0.9;
    }
    // 雪
    const snowTarget = S.weather === 'snow' ? 260 : 0;
    while (P.snow.length < snowTarget) P.snow.push({ x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 2.5, v: 30 + Math.random() * 40, ph: Math.random() * 6 });
    if (P.snow.length > snowTarget) P.snow.length = snowTarget;
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    for (const f of P.snow) {
      f.y += f.v * dt; f.ph += dt; f.x += Math.sin(f.ph) * 20 * dt;
      if (f.y > H) { f.y = -5; f.x = Math.random() * W; }
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill();
    }
    if (S.weather === 'snow') { ctx.fillStyle = 'rgba(230,240,255,.12)'; ctx.fillRect(0, 0, W, H); }
    // 世界规格新增天气的色调（例如血月）
    if (S.weatherTint) {
      ctx.globalAlpha = S.weatherTint.tintAlpha ?? 0.2;
      ctx.fillStyle = S.weatherTint.tint; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    // 雾
    if (S.weather === 'fog') {
      const t = this.time;
      for (let i = 0; i < 7; i++) {
        const x = ((i * 290 + t * (10 + i * 4)) % (W + 600)) - 300, y = (i * 173) % H;
        const g = ctx.createRadialGradient(x, y, 20, x, y, 360);
        g.addColorStop(0, 'rgba(235,240,245,.35)'); g.addColorStop(1, 'rgba(235,240,245,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 360, y - 360, 720, 720);
      }
    }
    // 飞鸟（屏幕空间）
    ctx.strokeStyle = 'rgba(40,40,50,.7)'; ctx.lineWidth = 1.5;
    for (const b of P.birds) {
      for (let i = 0; i < b.n; i++) {
        const x = b.x - Math.sign(b.vx) * i * 16, y = b.y + (i % 2 ? 1 : -1) * i * 7;
        const f = Math.sin(b.ph + i) * 4;
        ctx.beginPath(); ctx.moveTo(x - 6, y - f); ctx.lineTo(x, y); ctx.lineTo(x + 6, y - f); ctx.stroke();
      }
    }
  }

  // ---------- 屏幕叠加层：名牌、表情、气泡、建筑占用 ----------
  drawOverlays(ctx, S, ox, oy, z) {
    const now = performance.now();
    const toS = (wx, wy) => [wx * z + ox, wy * z + oy];
    const bubbles = [];
    ctx.textBaseline = 'middle';

    // 地点标签（远景）
    if (z < 0.9) {
      ctx.font = '600 13px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      for (const l of Object.values(this.world.locations)) {
        if (l.id.startsWith('home_')) continue;
        const r = l.rect;
        const [x, y] = toS((r.x + r.w / 2) * TS, (r.y + (l.indoor ? r.h + 0.55 : r.h / 2)) * TS);
        const label = `${l.emoji} ${l.name}`;
        const w = ctx.measureText(label).width + 16;
        ctx.fillStyle = 'rgba(20,22,35,.55)'; roundRect(ctx, x - w / 2, y - 11, w, 22, 11); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(label, x, y + 1);
      }
    }

    // 建筑内的居民
    for (const b of this.world.buildings) {
      const ids = S.occupancy[b.id] || [];
      if (!ids.length) continue;
      const [cx, top] = toS((b.x + b.w / 2) * TS, b.y * TS - 6);
      const size = Math.max(22, Math.min(34, 26 * z));
      const gap = 4;
      const totalW = ids.length * size + (ids.length - 1) * gap;
      let x = cx - totalW / 2;
      const y = top - size - 4;
      ctx.fillStyle = 'rgba(20,22,35,.6)';
      roundRect(ctx, x - 6, y - 5, totalW + 12, size + 10, (size + 10) / 2); ctx.fill();
      for (const id of ids) {
        const a = S.agentMap[id], m = this.meta[id];
        const sleeping = a.status === 'sleeping';
        ctx.save();
        ctx.globalAlpha = sleeping ? 0.55 : 1;
        if (m.portraitImg.complete) ctx.drawImage(m.portraitImg, x, y, size, size);
        ctx.restore();
        if (S.selected === id) { ctx.strokeStyle = '#ffd666'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 + 1, 0, 7); ctx.stroke(); }
        ctx.font = `${Math.round(size * 0.42)}px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
        ctx.textAlign = 'center';
        if (sleeping) {
          const zz = (this.time * 0.8 + id.length) % 1;
          ctx.fillStyle = `rgba(200,220,255,${1 - zz})`;
          ctx.font = `bold ${Math.round(size * 0.4)}px sans-serif`;
          ctx.fillText('z', x + size * 0.85 + zz * 6, y - zz * 14);
        } else {
          ctx.fillText(a.emoji || '🙂', x + size * 0.85, y + size * 0.85);
        }
        this.hits.push({ id, x, y, w: size, h: size });
        if (a.thinking) {
          const p = (Math.sin(this.time * 5) + 1) / 2;
          ctx.strokeStyle = `rgba(192,132,252,${0.5 + p * 0.5})`; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 + 2 + p * 2, 0, 7); ctx.stroke();
          ctx.fillStyle = '#a78bfa'; ctx.beginPath(); ctx.arc(x + 4, y + 4, 7, 0, 7); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.fillText('✦', x + 4, y + 4.5);
        }
        if (a.bubble) bubbles.push({ a, x: x + size / 2, y: y - 6 });
        x += size + gap;
      }
    }

    // 户外居民
    for (const a of S.agents) {
      if (a.inside) continue;
      const [x, fy] = toS(a.dx * TS + TS / 2, a.dy * TS + TS - 2);
      if (x < -100 || x > this.vw + 100 || fy < -100 || fy > this.vh + 150) continue;
      const headY = fy - (SPR_H * SCALE - 4) * z;
      this.hits.push({ id: a.id, x: x - 12 * z - 4, y: headY, w: 24 * z + 8, h: fy - headY + 4 });
      const m = this.meta[a.id];
      // 名牌
      if (z >= 0.75 || S.selected === a.id || S.hover === a.id) {
        ctx.font = '600 11px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        const tw = ctx.measureText(m.name).width + 12;
        ctx.fillStyle = S.selected === a.id ? 'rgba(255,200,80,.95)' : 'rgba(20,22,35,.7)';
        roundRect(ctx, x - tw / 2, fy + 5, tw, 16, 8); ctx.fill();
        ctx.fillStyle = S.selected === a.id ? '#2a1a00' : '#fff';
        ctx.fillText(m.name, x, fy + 13.5);
      }
      // 表情徽章
      const by = headY - 12 + Math.sin(this.time * 2 + a.id.length) * 2;
      if (a.thinking) this.drawThinking(ctx, x, by, a.thinking);
      else if (!a.bubble || a.bubble.kind !== 'say') {
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.beginPath(); ctx.arc(x, by, 11, 0, 7); ctx.fill();
        ctx.font = '13px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(a.emoji || '🙂', x, by + 1);
      }
      if (a.bubble) bubbles.push({ a, x, y: headY - (a.thinking ? 34 : 4) });
    }

    // 对话连线
    for (const c of S.convos) {
      const A = S.agentMap[c.a], B = S.agentMap[c.b];
      if (!A || !B || A.inside || B.inside) continue;
      const [x1, y1] = toS(A.dx * TS + 16, A.dy * TS + 4), [x2, y2] = toS(B.dx * TS + 16, B.dy * TS + 4);
      ctx.strokeStyle = c.state === 'thinking' ? 'rgba(180,150,255,.6)' : 'rgba(255,220,140,.5)';
      ctx.setLineDash([4, 5]); ctx.lineDashOffset = -this.time * 20; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 气泡（避免重叠）
    const placed = [];
    bubbles.sort((p, q) => q.y - p.y);
    for (const b of bubbles) this.drawBubble(ctx, b, placed, now, S);
  }

  drawThinking(ctx, x, y, label) {
    const t = this.time;
    ctx.font = '600 11px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    const text = `✦ ${label}`;
    const w = ctx.measureText(text).width + 26;
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    const p = (t * 0.6) % 1;
    g.addColorStop(0, '#7c5cff'); g.addColorStop(clamp01(p), '#c084fc'); g.addColorStop(1, '#5b8cff');
    ctx.fillStyle = g;
    roundRect(ctx, x - w / 2, y - 10, w, 20, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x - 5, y + 1);
    for (let i = 0; i < 3; i++) {
      const a = (Math.sin(t * 6 - i * 0.8) + 1) / 2;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + a * 0.7})`;
      ctx.beginPath(); ctx.arc(x + w / 2 - 14 + i * 4, y + 1, 1.5, 0, 7); ctx.fill();
    }
  }

  drawBubble(ctx, { a, x, y }, placed, now, S) {
    const b = a.bubble;
    if (!this.bubbleSeen.has(b.id)) this.bubbleSeen.set(b.id, now);
    const age = (now - this.bubbleSeen.get(b.id)) / 1000;
    const think = b.kind === 'think';
    let text = b.text;
    const dots = text === '…';
    if (!dots) text = text.slice(0, Math.floor(age * (think ? 28 : 22)) + 1);
    ctx.font = `${think ? 'italic ' : ''}13px "PingFang SC","Microsoft YaHei",sans-serif`;
    const maxW = 210;
    // 折行（逐字）
    const lines = [];
    let cur = '';
    for (const ch of dots ? '   ' : text) {
      if (ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch;
    }
    lines.push(cur);
    const full = dots ? ['   '] : (() => { const L = []; let c = ''; for (const ch of b.text) { if (ctx.measureText(c + ch).width > maxW) { L.push(c); c = ch; } else c += ch; } L.push(c); return L; })();
    const w = Math.max(dots ? 44 : 30, Math.min(maxW, Math.max(...full.map((l) => ctx.measureText(l).width)))) + 20;
    const lh = 18;
    const h = full.length * lh + 12;
    let bx = x - w / 2, by = y - h - 12;
    for (let i = 0; i < 8; i++) {
      const hit = placed.find((p) => bx < p.x + p.w && bx + w > p.x && by < p.y + p.h && by + h > p.y);
      if (!hit) break;
      by = hit.y - h - 4;
    }
    placed.push({ x: bx, y: by, w, h });
    const pop = Math.min(1, age * 6);
    ctx.save();
    ctx.globalAlpha = pop;
    const sel = S.selected === a.id;
    ctx.fillStyle = think ? 'rgba(245,242,255,.95)' : '#fffdf7';
    ctx.strokeStyle = think ? 'rgba(150,130,220,.8)' : sel ? '#ffb347' : 'rgba(60,45,30,.55)';
    ctx.lineWidth = sel ? 2 : 1.2;
    ctx.shadowColor = 'rgba(0,0,0,.25)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    roundRect(ctx, bx, by, w, h, 10); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
    // 尾巴
    if (think) {
      ctx.beginPath(); ctx.arc(x - 2, by + h + 5, 4, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(x + 1, y - 4, 2.5, 0, 7); ctx.fill(); ctx.stroke();
    } else {
      const tx = Math.max(bx + 12, Math.min(bx + w - 12, x));
      ctx.beginPath(); ctx.moveTo(tx - 6, by + h - 1); ctx.lineTo(x, y - 4); ctx.lineTo(tx + 6, by + h - 1); ctx.closePath();
      ctx.fillStyle = '#fffdf7'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(tx - 6, by + h); ctx.lineTo(x, y - 4); ctx.lineTo(tx + 6, by + h); ctx.stroke();
    }
    ctx.fillStyle = think ? '#5b4a8a' : '#2d2418';
    ctx.textAlign = 'left';
    if (dots) {
      for (let i = 0; i < 3; i++) {
        const k = (Math.sin(this.time * 7 - i) + 1) / 2;
        ctx.fillStyle = `rgba(90,70,140,${0.3 + k * 0.7})`;
        ctx.beginPath(); ctx.arc(bx + w / 2 - 8 + i * 8, by + h / 2 - k * 2, 3, 0, 7); ctx.fill();
      }
    } else {
      lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 6 + lh / 2 + i * lh + 1));
    }
    ctx.restore();
  }

  drawMinimap(S) {
    const g = this.mctx, s = this.miniScale / TS;
    g.drawImage(this.miniBase, 0, 0);
    const sky = this.sky;
    if (sky.dark > 0.05) { g.fillStyle = `rgba(10,14,42,${sky.dark * 0.7})`; g.fillRect(0, 0, this.mini.width, this.mini.height); }
    for (const a of S.agents) {
      let x, y;
      if (a.inside) { const b = this.world.buildings.find((b) => b.id === a.inside); x = (b.x + b.w / 2) * TS; y = (b.y + b.h / 2) * TS; }
      else { x = a.dx * TS + 16; y = a.dy * TS + 16; }
      g.fillStyle = '#1a1a22'; g.beginPath(); g.arc(x * s, y * s, 4, 0, 7); g.fill();
      g.fillStyle = this.meta[a.id].look.shirt; g.beginPath(); g.arc(x * s, y * s, 3, 0, 7); g.fill();
      if (S.selected === a.id) { g.strokeStyle = '#ffd666'; g.lineWidth = 2; g.beginPath(); g.arc(x * s, y * s, 6, 0, 7); g.stroke(); }
    }
    const v = this.view;
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1.5;
    g.strokeRect(v.x0 * s, v.y0 * s, (v.x1 - v.x0) * s, (v.y1 - v.y0) * s);
  }

  hitTest(sx, sy) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h) return h.id;
    }
    return null;
  }
}
