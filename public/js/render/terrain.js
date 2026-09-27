// 静态层：地形瓦片、树木、围栏与农田等静态物件、建筑、小地图底图（世界变化时重建一次）
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。
import { shade } from '../sprites.js';
import { TS, T, h2, vnoise, mix, clamp01, roundRect } from './util.js';

const DEFAULT_PAL = { grass: ['#68a74a', '#8cc963'], blade: ['#5a9640', '#9fd877'] };
const PLANK_KINDS = new Set(['tavern', 'workshop', 'farmhouse']);
const CHIMNEY_KINDS = new Set(['house', 'farmhouse', 'tavern', 'workshop', 'cafe']);

export class Terrain {
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
      else if (t === T.MOON) this.paintMoonGrass(g, x, y);
      else if (t === T.MOONPATH) this.paintSpeckle(g, x, y, '#8d86b8', '#77709f', '#a9a2d4');
      else if (t === T.VOID) this.paintVoid(g, x, y);
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
            const pal = this.grassPal(x + dx, y + dy);
            g.fillStyle = pal === DEFAULT_PAL ? (h2(i, x + y) > 0.5 ? '#6fae4f' : '#7dbb58') : (h2(i, x + y) > 0.5 ? pal.grass[0] : pal.grass[1]);
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
    // 暗月界：浮岛边缘的微光
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (tile(x, y) !== T.VOID) continue;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nt = tile(x + dx, y + dy);
        if (nt !== T.MOON && nt !== T.MOONPATH) continue;
        const X = x * TS, Y = y * TS;
        g.fillStyle = dy === -1 ? 'rgba(60,40,110,.95)' : 'rgba(170,140,255,.35)';
        if (dy === -1) g.fillRect(X, Y, TS, 10); // 岛的侧面
        if (dy === 1) g.fillRect(X, Y + TS - 3, TS, 3);
        if (dx === -1) g.fillRect(X, Y, 3, TS);
        if (dx === 1) g.fillRect(X + TS - 3, Y, 3, TS);
      }
    }
    // 广场马赛克：云溪镇喷泉周围的圆环（手工布局的坐标）
    if (this.world.id === 'town' && (!this.world.generator || this.world.generator === 'yunxi-v1')) {
    g.save();
    g.strokeStyle = 'rgba(170,140,110,.55)';
    g.lineWidth = 6;
    g.beginPath(); g.arc(22.5 * TS, 23.5 * TS, 3.1 * TS, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(200,120,90,.35)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(22.5 * TS, 23.5 * TS, 3.6 * TS, 0, Math.PI * 2); g.stroke();
    g.restore();
    }

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

  /** 这一格的地貌调色板（生成器 layout-v1 按区域给出；云溪镇没有，用默认的草地色） */
  grassPal(x, y) {
    const w = this.world;
    if (!w.biomes || !w.biome) return DEFAULT_PAL;
    return w.biomes[w.biome[y * w.W + x]] || DEFAULT_PAL;
  }

  paintGrass(g, x, y, flowers) {
    const X = x * TS, Y = y * TS;
    const pal = this.grassPal(x, y);
    for (let by = 0; by < TS; by += 4) for (let bx = 0; bx < TS; bx += 4) {
      const n = vnoise((X + bx) / 150, (Y + by) / 150) * 0.8 + (h2(X + bx, Y + by) - 0.5) * 0.3;
      g.fillStyle = mix(pal.grass[0], pal.grass[1], n);
      g.fillRect(X + bx, Y + by, 4, 4);
    }
    for (let i = 0; i < 4; i++) {
      const tx = X + Math.floor(h2(x, y, i) * 28), ty = Y + Math.floor(h2(y, x, i + 9) * 26);
      g.fillStyle = h2(x, y, i + 3) > 0.5 ? pal.blade[0] : pal.blade[1];
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

  paintMoonGrass(g, x, y) {
    const X = x * TS, Y = y * TS;
    for (let by = 0; by < TS; by += 4) for (let bx = 0; bx < TS; bx += 4) {
      const n = vnoise((X + bx) / 120, (Y + by) / 120, 5) * 0.8 + (h2(X + bx, Y + by, 3) - 0.5) * 0.3;
      g.fillStyle = mix('#3b3470', '#5a4f9a', n);
      g.fillRect(X + bx, Y + by, 4, 4);
    }
    if (h2(x, y, 11) > 0.7) { g.fillStyle = '#b9a8ff'; g.fillRect(X + h2(x, y, 12) * 28, Y + h2(x, y, 13) * 28, 2, 2); }
  }

  paintVoid(g, x, y) {
    const X = x * TS, Y = y * TS;
    g.fillStyle = mix('#0b0820', '#1a1240', vnoise(x / 6, y / 6, 9));
    g.fillRect(X, Y, TS, TS);
    for (let i = 0; i < 2; i++) if (h2(x, y, 20 + i) > 0.55) {
      g.fillStyle = h2(x, y, 30 + i) > 0.8 ? '#fff6d0' : 'rgba(200,190,255,.7)';
      g.fillRect(X + h2(x, y, 40 + i) * 30, Y + h2(x, y, 50 + i) * 30, 1.5, 1.5);
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

  /**
   * 建筑：云溪镇的建筑按类型画；世界包里的建筑带 style（多世界设计 §3.2，按参数绘制）：
   *   roofShape gable 人字 / thatch 茅草 / flat 平顶 / spire 尖塔 / dome 圆顶；material plaster / wood / stone / brick；
   *   decor chimney 烟囱 / flowers 花箱 / awning 遮阳篷 / lantern 门灯 / ivy 爬藤 / banner 旗帜 / bell 钟
   */
  drawBuilding(g, b) {
    if (b.state === 'ruin') return this.drawRuin(g, b);
    const X = b.x * TS, Y = b.y * TS, w = b.w * TS, h = b.h * TS;
    const closed = b.state === 'closed' || b.state === 'damaged'; // 停业 / 受损：夜里不亮灯、没有招牌
    const kind = b.kind;
    const st = b.style || null;
    const decor = new Set(st?.decor || []);
    // 未知类型（由世界规格新增的建筑）使用 b.wall 或默认墙色
    const wallC = { house: '#f2e2c2', library: '#e9dfcf', cafe: '#fbe8d2', tavern: '#7b5a40', clinic: '#f7f8fb', workshop: '#a58b6c', farmhouse: '#e8cfa6' }[kind] || b.wall || '#e8dcc4';
    const roofC = b.roof;
    const roofH = Math.round(h * (kind === 'library' ? 0.5 : st?.roofShape === 'flat' ? 0.3 : st?.roofShape === 'spire' ? 0.62 : 0.55));
    // 阴影
    g.fillStyle = 'rgba(20,30,20,.22)';
    g.beginPath(); g.moveTo(X + w, Y + 14); g.lineTo(X + w + 12, Y + 24); g.lineTo(X + w + 12, Y + h + 6); g.lineTo(X + 8, Y + h + 6); g.lineTo(X, Y + h); g.lineTo(X + w, Y + h); g.fill();

    // 墙面
    const wy = Y + roofH - 4;
    g.fillStyle = wallC;
    g.fillRect(X + 2, wy, w - 4, h - roofH + 4);
    if (st?.material === 'stone' || st?.material === 'brick') {
      // 石块 / 砖：错缝的块
      const bw = st.material === 'stone' ? 12 : 8, bh = st.material === 'stone' ? 8 : 5;
      for (let yy = wy, row = 0; yy < Y + h - 6; yy += bh, row++) {
        for (let xx = X + 2 - (row % 2) * (bw / 2); xx < X + w - 2; xx += bw) {
          g.fillStyle = shade(wallC, h2(xx, yy) > 0.5 ? -0.05 : 0.04);
          g.fillRect(Math.max(X + 2, xx + 1), yy + 1, Math.min(bw - 1, X + w - 2 - Math.max(X + 2, xx + 1)), bh - 1);
        }
      }
    } else if (PLANK_KINDS.has(kind) || st?.material === 'wood') {
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
      if (kind === 'house' || kind === 'cafe' || decor.has('flowers')) {
        g.fillStyle = '#8a5a3a'; g.fillRect(wx - 2, wyy + winH + 2, winW + 4, 4);
        for (let i = 0; i < 5; i++) { g.fillStyle = ['#ff6b8a', '#ffd166', '#ff9ec0'][i % 3]; g.fillRect(wx + i * 4, wyy + winH, 3, 3); }
      }
      if (closed) {
        // 钉上木板
        g.fillStyle = '#8a6a48'; g.fillRect(wx - 3, wyy + 3, winW + 6, 4); g.fillRect(wx - 3, wyy + winH - 6, winW + 6, 4);
        g.fillStyle = '#6a4a30'; g.fillRect(wx - 3, wyy + 5, winW + 6, 1); g.fillRect(wx - 3, wyy + winH - 4, winW + 6, 1);
      } else this.windows.push({ b: b.id, x: wx, y: wyy, w: winW, h: winH });
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
    if (closed) {
      // 门上交叉的封条
      g.strokeStyle = '#c9b48a'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(dx - 1, dy + 2); g.lineTo(dx + dW + 1, dy + dH - 4); g.moveTo(dx + dW + 1, dy + 2); g.lineTo(dx - 1, dy + dH - 4); g.stroke();
    } else this.windows.push({ b: b.id, x: dx, y: dy, w: dW, h: dH, door: true });

    // 屋顶
    const ov = 5;
    const rt = Y + 2;
    if (st && st.roofShape && st.roofShape !== 'gable') this.drawRoofShape(g, st.roofShape, X, Y, w, roofH, roofC);
    else {
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
    }

    // 爬藤、门灯、旗帜、钟（世界包里的建筑装饰）
    if (decor.has('ivy')) {
      for (let i = 0; i < 26; i++) {
        const ix = X + 3 + h2(b.x, i, 7) * 18, iy = wy + h2(b.y, i, 9) * (h - roofH - 4);
        g.fillStyle = i % 2 ? '#4f8a3c' : '#6aa34e'; g.fillRect(ix, iy, 4, 3);
      }
    }
    if (decor.has('lantern')) {
      const lx = Math.round(doorX - dW / 2 - 8), ly = dy + 2;
      g.fillStyle = '#4a3222'; g.fillRect(lx + 2, ly - 4, 1, 4);
      g.fillStyle = '#ffd76a'; g.fillRect(lx, ly, 5, 7);
      g.fillStyle = '#b8862a'; g.fillRect(lx, ly, 5, 1); g.fillRect(lx, ly + 6, 5, 1);
    }
    if (decor.has('banner')) {
      const bx = X + w - 10, by = rt - 14;
      g.fillStyle = '#5a3e28'; g.fillRect(bx, by, 2, 18);
      g.fillStyle = shade(roofC, 0.2); g.beginPath(); g.moveTo(bx + 2, by); g.lineTo(bx + 14, by + 4); g.lineTo(bx + 2, by + 8); g.fill();
    }
    if (decor.has('bell')) {
      g.fillStyle = '#d9a441'; g.beginPath(); g.arc(X + w / 2, Y + roofH * 0.45, 5, Math.PI, 0); g.fill(); g.fillRect(X + w / 2 - 5, Y + roofH * 0.45, 10, 3);
    }

    // 烟囱
    if ((CHIMNEY_KINDS.has(kind) && !st) || decor.has('chimney')) {
      const cx = X + w * 0.74, cy = rt - 6;
      g.fillStyle = '#8a4a3a'; g.fillRect(cx, cy, 11, 18);
      g.fillStyle = '#a85a46'; for (let i = 0; i < 18; i += 5) g.fillRect(cx, cy + i, 11, 1);
      g.fillStyle = '#5a2e24'; g.fillRect(cx - 1, cy - 2, 13, 4);
      this.chimneys.push({ b: b.id, x: cx + 5.5, y: cy - 2 });
    }

    // 特色装饰
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (kind === 'cafe' || decor.has('awning')) {
      // 条纹遮阳篷（世界包里的建筑用自己的屋顶色）
      const ay = wy + 2;
      const stripe = kind === 'cafe' ? '#d9534f' : roofC;
      for (let i = 0; i < w - 12; i += 8) { g.fillStyle = (i / 8) % 2 ? '#fff6ea' : stripe; g.fillRect(X + 6 + i, ay, 8, 10); }
      for (let i = 0; i < w - 12; i += 8) { g.fillStyle = (i / 8) % 2 ? '#fff6ea' : stripe; g.beginPath(); g.arc(X + 10 + i, ay + 10, 4, 0, Math.PI); g.fill(); }
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
    if (signs[kind] && !closed) {
      const sx = doorX + 22, sy = dy + 2;
      g.fillStyle = '#5a3e28'; g.fillRect(sx - 1, sy - 4, 2, 6);
      g.fillStyle = '#e8d2a8'; roundRect(g, sx - 9, sy + 1, 18, 15, 3); g.fill();
      g.strokeStyle = '#6a4a30'; g.lineWidth = 1.5; g.stroke();
      g.font = '11px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
      g.fillText(signs[kind], sx, sy + 9);
    }
    if (b.state === 'damaged') this.drawDamage(g, b, X, Y, w, h, roofH);
  }

  /** 受损：屋顶破洞、墙上的裂缝、靠在墙边的脚手架 */
  drawDamage(g, b, X, Y, w, h, roofH) {
    const hx = X + w * 0.3, hy = Y + roofH * 0.35;
    g.fillStyle = '#2a1e18';
    g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + 18, hy - 4); g.lineTo(hx + 26, hy + 8); g.lineTo(hx + 12, hy + 16); g.lineTo(hx - 4, hy + 10); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(40,28,20,.7)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X + w * 0.7, Y + roofH + 4); g.lineTo(X + w * 0.66, Y + roofH + 16); g.lineTo(X + w * 0.72, Y + roofH + 26); g.lineTo(X + w * 0.68, Y + roofH + 38); g.stroke();
    g.fillStyle = '#b08a55';
    const sx = X + w - 14;
    g.fillRect(sx, Y + 10, 3, h - 10); g.fillRect(sx + 10, Y + 10, 3, h - 10);
    for (let yy = Y + 16; yy < Y + h - 4; yy += 14) g.fillRect(sx - 2, yy, 17, 3);
  }

  /** 废墟：断墙、塌下来的屋顶、瓦砾和杂草（仍然占地、挡路） */
  drawRuin(g, b) {
    const X = b.x * TS, Y = b.y * TS, w = b.w * TS, h = b.h * TS;
    const wallC = shade(b.wall || '#e8dcc4', -0.18);
    g.fillStyle = 'rgba(20,30,20,.18)'; g.fillRect(X + 4, Y + h - 4, w, 8);
    g.fillStyle = '#9c8a74'; g.fillRect(X + 2, Y + h * 0.55, w - 4, h * 0.45);
    // 高低不一的断墙
    for (let i = 0, xx = X + 2; xx < X + w - 2; i++, xx += 10) {
      const hh = 10 + Math.floor(h2(b.x + i, b.y, 3) * (h * 0.5));
      g.fillStyle = shade(wallC, h2(i, b.y) > 0.5 ? 0.05 : -0.06);
      g.fillRect(xx, Y + h - 6 - hh, Math.min(10, X + w - 2 - xx), hh);
    }
    // 塌下的屋顶梁
    g.fillStyle = shade(b.roof || '#8a6a4a', -0.25);
    g.save(); g.translate(X + w * 0.45, Y + h * 0.62); g.rotate(-0.35); g.fillRect(-w * 0.3, -3, w * 0.6, 7); g.restore();
    // 瓦砾与杂草
    for (let i = 0; i < 18; i++) {
      const rx = X + 4 + h2(b.x, i, 11) * (w - 10), ry = Y + h * 0.6 + h2(b.y, i, 13) * (h * 0.36);
      g.fillStyle = i % 3 ? '#8e8272' : '#6f6558'; g.fillRect(rx, ry, 4 + (i % 3), 3);
    }
    for (let i = 0; i < 10; i++) {
      const gx = X + 3 + h2(b.x, i, 17) * (w - 6), gy = Y + h - 8 - h2(b.y, i, 19) * 10;
      g.fillStyle = i % 2 ? '#5a9640' : '#7fb85c'; g.fillRect(gx, gy, 2, 6); g.fillRect(gx + 2, gy + 2, 2, 4);
    }
  }

  /** 非人字形的屋顶：茅草、平顶、尖塔、圆顶 */
  drawRoofShape(g, shape, X, Y, w, roofH, roofC) {
    const ov = 5, rt = Y + 2;
    g.fillStyle = shade(roofC, -0.35);
    g.fillRect(X - ov, Y + roofH - 4, w + ov * 2, 6);
    if (shape === 'flat') {
      g.fillStyle = roofC; g.fillRect(X - 3, Y + roofH - 12, w + 6, 10);
      g.fillStyle = shade(roofC, 0.2); g.fillRect(X - 3, Y + roofH - 12, w + 6, 2);
      return;
    }
    g.fillStyle = roofC;
    g.beginPath();
    if (shape === 'spire') { g.moveTo(X - ov, Y + roofH - 2); g.lineTo(X + w + ov, Y + roofH - 2); g.lineTo(X + w / 2, rt - 18); }
    else if (shape === 'dome') { g.ellipse(X + w / 2, Y + roofH - 2, w / 2 + ov, roofH - 6, 0, Math.PI, 0); }
    else { g.moveTo(X - ov - 2, Y + roofH); g.lineTo(X + w + ov + 2, Y + roofH); g.quadraticCurveTo(X + w, rt + 2, X + w / 2, rt + 2); g.quadraticCurveTo(X, rt + 2, X - ov - 2, Y + roofH); }
    g.closePath(); g.fill();
    g.save(); g.clip();
    if (shape === 'thatch') {
      // 茅草：一缕一缕的斜线
      for (let yy = rt; yy < Y + roofH; yy += 4) for (let xx = X - ov; xx < X + w + ov; xx += 3) {
        g.fillStyle = shade(roofC, h2(xx, yy) > 0.5 ? 0.12 : -0.12); g.fillRect(xx, yy, 2, 3);
      }
    } else {
      for (let yy = rt; yy < Y + roofH; yy += 6) { g.fillStyle = shade(roofC, -0.14); g.fillRect(X - ov, yy + 4, w + ov * 2, 1); }
    }
    const rg = g.createLinearGradient(X, 0, X + w, 0);
    rg.addColorStop(0, 'rgba(255,255,255,.14)'); rg.addColorStop(1, 'rgba(0,0,0,.2)');
    g.fillStyle = rg; g.fillRect(X - ov, rt - 20, w + ov * 2, roofH + 20);
    g.restore();
  }

  buildMinimap() {
    const { W, H, tiles } = this.world;
    const s = 3;
    const c = document.createElement('canvas');
    c.width = W * s; c.height = H * s;
    const g = c.getContext('2d');
    const col = { 0: '#78b656', 1: '#d7c79f', 2: '#e4d8bd', 3: '#c6a06a', 4: '#4b9fd4', 5: '#e9d59c', 6: '#a77a4c', 7: '#8a5c3a', 8: '#b98b58', 9: '#2f76ae', 10: '#86c160', 11: '#4a4288', 12: '#0e0a26', 13: '#8d86b8' };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[y * W + x];
      const pal = (t === 0 || t === 10) && this.world.biomes ? this.grassPal(x, y) : null;
      g.fillStyle = pal ? pal.grass[1] : col[t];
      g.fillRect(x * s, y * s, s, s);
    }
    for (const o of this.world.objects) if (o.type === 'moonwell' || o.type === 'crystal') { g.fillStyle = '#c9b8ff'; g.fillRect(o.x * s, o.y * s, (o.w || 1) * s, (o.h || 1) * s); } else if (o.type === 'tree') { g.fillStyle = o.kind === 'sakura' ? '#e89ab8' : '#3f7d3c'; g.fillRect(o.x * s, o.y * s, s, s); }
    for (const b of this.world.buildings) { g.fillStyle = b.roof; g.fillRect(b.x * s, b.y * s, b.w * s, b.h * s); g.strokeStyle = 'rgba(0,0,0,.4)'; g.strokeRect(b.x * s + 0.5, b.y * s + 0.5, b.w * s - 1, b.h * s - 1); }
    this.miniBase = c;
    this.miniScale = s;
    this.mini.width = W * s; this.mini.height = H * s;
  }
}
