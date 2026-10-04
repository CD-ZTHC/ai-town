// 怪物外观（docs/design/adventure.md §4.1）：按 look 参数化生成像素精灵——体型 bodyPlan、配色 palette、花纹 pattern。
// 每种外观生成一次并缓存：3 个方向 × 4 帧（0 待机、1/2 走路、3 出手），向左由向右镜像。基础画布 24×24，绘制时再按 scale 放大。
import { shade } from './sprites.js';

export const MON_W = 24, MON_H = 24;
/** 新体型（wisp / hound / warden 仍由 sprites.js 的生物画法负责） */
export const MONSTER_PLANS = ['blob', 'beast', 'bird', 'insect', 'humanoid', 'treant', 'golem', 'skeleton', 'serpent', 'eye'];
const DEFAULTS = {
  blob: ['#6ac6d8', '#bff2ff', '#1a2a3a'], beast: ['#7a6a5a', '#c8b8a0', '#ffd84a'], bird: ['#5a4a6a', '#e0a040', '#ffe85a'],
  insect: ['#6a5a3a', '#c89040', '#ff4a3a'], humanoid: ['#6a5a7a', '#c8a050', '#ffffff'], treant: ['#5a4630', '#6aa04a', '#ffd84a'],
  golem: ['#6a6670', '#ff7a3a', '#ffd84a'], skeleton: ['#e8e0cc', '#a89878', '#5ae0ff'], serpent: ['#4a7a4a', '#c8d060', '#ffe85a'], eye: ['#d8c8e0', '#8a3aff', '#2a1040'],
};

/** look → 统一的配色：{ body, accent, eyes, glow }（兼容异界生物的 body / glow / eyes 写法） */
export function paletteOf(look) {
  const d = DEFAULTS[look.bodyPlan] || DEFAULTS.humanoid;
  const p = look.palette || {};
  return { body: p.body || look.body || d[0], accent: p.accent || look.glow || d[1], eyes: p.eyes || look.eyes || d[2], glow: p.glow || look.glow || p.accent || d[1] };
}

function painter(ctx) {
  return (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
}

/** 花纹：在身体的矩形里撒点、画条纹、晶体、骨纹、余烬（确定性的位置） */
function pattern(px, kind, rect, col) {
  if (!kind || kind === 'plain' || !rect) return;
  const [x0, y0, w, h] = rect;
  if (kind === 'spots') for (let i = 0; i < 5; i++) px(x0 + ((i * 7) % w), y0 + ((i * 5 + 2) % h), 2, 2, col);
  if (kind === 'stripes') for (let x = x0 + 1; x < x0 + w; x += 3) px(x, y0, 1, h, col);
  if (kind === 'crystal') for (let i = 0; i < 3; i++) { const x = x0 + 2 + i * Math.max(2, Math.floor(w / 3)); px(x, y0 - 2, 2, 3, col); px(x + 0.5, y0 - 3, 1, 1, '#ffffff'); }
  if (kind === 'bone') for (let y = y0 + 1; y < y0 + h; y += 2) px(x0 + 1, y, w - 2, 1, col);
  if (kind === 'ember') for (let i = 0; i < 6; i++) px(x0 + ((i * 5 + 1) % w), y0 + ((i * 3 + 1) % h), 1, 1, i % 2 ? '#ffd84a' : '#ff6a2a');
}

const eyesAt = (px, dir, c, y, [l, r]) => { if (dir === 'up') return; const xs = dir === 'right' ? [r - 1, r + 2] : [l, r]; px(xs[0], y, 2, 2, c); if (dir !== 'right') px(xs[1], y, 2, 2, c); else px(xs[1], y, 1, 2, c); };

// ---------- 各体型 ----------
// 每个函数画一帧：dir ∈ down / up / right，f ∈ 0 待机 / 1、2 走路 / 3 出手；返回花纹的矩形
const PLANS = {
  blob(px, P, dir, f) {
    const sq = f === 1 ? 1 : f === 2 ? -1 : 0, lunge = f === 3 ? 2 : 0;
    const w = 16 + sq * 2, h = 11 - sq, x = 4 - sq + (dir === 'right' ? lunge : 0), y = 22 - h - (f === 3 ? 1 : 0);
    px(x + 2, y, w - 4, 1, shade(P.body, 0.15));
    px(x + 1, y + 1, w - 2, 2, P.body); px(x, y + 3, w, h - 4, P.body); px(x + 1, y + h - 1, w - 2, 1, shade(P.body, -0.25));
    px(x + 3, y + 2, 3, 2, P.accent);
    if (dir !== 'up') eyesAt(px, dir, P.eyes, y + 4, [x + 4, x + w - 7]);
    if (f === 3 && dir !== 'up') px(x + w / 2 - 2, y + 8, 4, 2, shade(P.body, -0.45));
    return [x + 1, y + 4, w - 2, h - 5];
  },
  beast(px, P, dir, f) {
    const dark = shade(P.body, -0.3), legA = f === 1 ? 1 : 0, legB = f === 2 ? 1 : 0, lunge = f === 3 ? 2 : 0;
    if (dir === 'right') {
      px(3, 12, 13, 7, P.body); px(3, 11, 11, 1, shade(P.body, 0.2)); px(4, 18, 11, 1, P.accent);
      px(14 + lunge, 8, 7, 7, P.body); px(15 + lunge, 6, 2, 2, dark); px(18 + lunge, 6, 2, 2, dark); px(20 + lunge, 12, 3, 2, P.accent);
      px(18 + lunge, 10, 2, 1, P.eyes);
      if (f === 3) px(20 + lunge, 14, 3, 1, '#ffffff');
      px(0, 10, 4, 2, dark);
      px(4, 19, 2, 4 - legA, dark); px(7, 19, 2, 4 - legB, dark); px(11, 19, 2, 4 - legA, dark); px(14, 19, 2, 4 - legB, dark);
      return [4, 12, 10, 6];
    }
    // 正面 / 背面：四条腿、胸口、带吻部和尖耳朵的头
    const lift = f === 3 ? -1 : 0;
    px(6, 18, 3, 5 - legA, dark); px(15, 18, 3, 5 - legB, dark); px(9, 19, 2, 3, dark); px(13, 19, 2, 3, dark);
    px(6, 11, 12, 9, P.body); px(7, 18, 10, 1, shade(P.body, -0.15));
    if (dir === 'up') { px(11, 17, 2, 6, dark); px(12, 21, 3, 2, dark); }
    px(7, 4 + lift, 10, 8, P.body); px(6, 6 + lift, 12, 4, P.body);
    px(6, 1 + lift, 3, 4, dark); px(15, 1 + lift, 3, 4, dark);
    if (dir === 'down') {
      px(7, 2 + lift, 1, 2, P.accent); px(16, 2 + lift, 1, 2, P.accent);
      px(9, 9 + lift, 6, 4, P.accent); px(11, 9 + lift, 2, 1, '#1a1a1a');
      px(8, 6 + lift, 2, 2, P.eyes); px(14, 6 + lift, 2, 2, P.eyes);
      px(7, 12, 10, 4, P.accent);
      if (f === 3) { px(10, 12 + lift, 1, 2, '#ffffff'); px(13, 12 + lift, 1, 2, '#ffffff'); }
    }
    return [6, 13, 12, 6];
  },
  bird(px, P, dir, f) {
    const flap = f === 1 ? -3 : f === 2 ? 2 : f === 3 ? -4 : 0, bob = f === 1 ? -1 : 0;
    const wing = shade(P.body, -0.2);
    px(8, 8 + bob, 8, 9, P.body); px(9, 7 + bob, 6, 1, shade(P.body, 0.2));
    px(1, 10 + flap + bob, 7, 3, wing); px(2, 13 + flap + bob, 5, 2, wing);
    px(16, 10 + flap + bob, 7, 3, wing); px(17, 13 + flap + bob, 5, 2, wing);
    if (dir === 'right') { px(16, 10 + bob, 4, 2, P.accent); px(13, 9 + bob, 2, 2, P.eyes); }
    else if (dir === 'down') { px(11, 12 + bob, 2, 3, P.accent); eyesAt(px, dir, P.eyes, 10 + bob, [9, 14]); }
    px(10, 17 + bob, 1, 3, P.accent); px(13, 17 + bob, 1, 3, P.accent);
    return [9, 11 + bob, 6, 5];
  },
  insect(px, P, dir, f) {
    const dark = shade(P.body, -0.35), leg = f === 1 ? 1 : f === 2 ? -1 : 0;
    if (dir === 'right') {
      px(2, 13, 7, 6, shade(P.body, -0.1)); px(9, 12, 7, 7, P.body); px(16 + (f === 3 ? 2 : 0), 12, 5, 5, P.body);
      px(20 + (f === 3 ? 2 : 0), 14, 3, 1, P.accent); px(20 + (f === 3 ? 2 : 0), 16, 3, 1, P.accent); px(18 + (f === 3 ? 2 : 0), 13, 1, 1, P.eyes);
      for (const [i, x] of [4, 9, 13].entries()) px(x + (i % 2 ? leg : -leg), 19, 1, 3, dark);
      px(1, 9, 2, 5, P.accent); px(2, 8, 3, 1, P.accent);
      return [9, 12, 7, 6];
    }
    px(6, 6, 12, 7, P.body); px(5, 12, 14, 9, shade(P.body, -0.08)); px(7, 4, 2, 3, P.accent); px(15, 4, 2, 3, P.accent);
    if (dir === 'down') { eyesAt(px, dir, P.eyes, 8, [8, 14]); if (f === 3) { px(6, 3, 3, 2, P.accent); px(15, 3, 3, 2, P.accent); } }
    for (const y of [13, 16, 19]) { px(2 + leg, y, 3, 1, dark); px(19 - leg, y, 3, 1, dark); }
    return [6, 13, 12, 7];
  },
  humanoid(px, P, dir, f) {
    const dark = shade(P.body, -0.3), lA = f === 1 ? 1 : 0, lB = f === 2 ? 1 : 0;
    px(8, 18, 3, 4 - lA, dark); px(13, 18, 3, 4 - lB, dark);
    px(7, 10, 10, 9, P.body); px(7, 17, 10, 2, dark); px(9, 10, 6, 2, P.accent);
    px(8, 3, 8, 7, shade(P.body, 0.12)); px(7, 2, 10, 2, dark); px(8, 1, 2, 2, P.accent); px(14, 1, 2, 2, P.accent);
    if (dir !== 'up') eyesAt(px, dir, P.eyes, 6, [9, 13]);
    const raise = f === 3 ? -5 : 0;
    if (dir === 'right') { px(13 + (f === 3 ? 3 : 0), 11 + raise, 3, 6, dark); if (f === 3) px(17, 3, 2, 9, P.accent); }
    else { px(4, 11 + (f === 3 ? raise : 0), 3, 7, dark); px(17, 11, 3, 7, dark); if (f === 3) px(3, 2, 2, 9, P.accent); }
    return [8, 12, 8, 5];
  },
  treant(px, P, dir, f) {
    const bark = P.body, dark = shade(bark, -0.3), leaf = P.accent, sway = f === 1 ? 1 : f === 2 ? -1 : 0;
    px(3 + sway, 1, 18, 7, leaf); px(1 + sway, 3, 22, 4, shade(leaf, -0.15)); px(6 + sway, 0, 12, 2, shade(leaf, 0.15));
    px(7, 7, 10, 15, bark); px(9, 8, 2, 13, dark);
    const arm = f === 3 ? -4 : 0;
    px(2, 9 + arm, 5, 3, bark); px(1, 7 + arm, 2, 3, bark); px(17, 9 + (dir === 'right' ? arm : 0), 5, 3, bark); px(21, 7 + (dir === 'right' ? arm : 0), 2, 3, bark);
    px(5, 21, 4, 2, dark); px(15, 21, 4, 2, dark);
    if (dir !== 'up') { eyesAt(px, dir, P.eyes, 11, [9, 13]); px(10, 15, 4, 2, shade(bark, -0.5)); }
    return [8, 12, 8, 8];
  },
  golem(px, P, dir, f) {
    const stone = P.body, dark = shade(stone, -0.3), lt = shade(stone, 0.15), step = f === 1 ? 1 : f === 2 ? -1 : 0, smash = f === 3 ? 3 : 0;
    px(5, 6, 14, 12, stone); px(5, 6, 14, 2, lt); px(8, 1, 8, 6, stone); px(8, 1, 8, 1, lt);
    px(1, 7 + smash, 4, 11, dark); px(19, 7 + smash, 4, 11, dark); px(0, 16 + smash, 5, 4, stone); px(19, 16 + smash, 5, 4, stone);
    px(6, 18, 5, 5 - Math.max(0, step), dark); px(13, 18, 5, 5 - Math.max(0, -step), dark);
    px(11, 9, 2, 6, P.accent); px(9, 11, 6, 2, P.accent);
    if (dir !== 'up') eyesAt(px, dir, P.eyes, 3, [9, 13]);
    return [6, 8, 12, 9];
  },
  skeleton(px, P, dir, f) {
    const bone = P.body, dark = shade(bone, -0.35), lA = f === 1 ? 1 : 0, lB = f === 2 ? 1 : 0;
    px(8, 2, 8, 7, bone); px(9, 8, 6, 1, dark);
    if (dir !== 'up') { px(dir === 'right' ? 12 : 9, 4, 2, 2, '#1a1a1a'); if (dir !== 'right') px(13, 4, 2, 2, '#1a1a1a'); px(dir === 'right' ? 12 : 9, 4, 1, 1, P.eyes); if (dir !== 'right') px(13, 4, 1, 1, P.eyes); }
    px(11, 9, 2, 10, bone); for (let y = 10; y < 16; y += 2) px(8, y, 8, 1, bone);
    const raise = f === 3 ? -6 : 0;
    px(6, 10, 1, 7, bone); px(17, 10 + raise, 1, 7, bone); if (f === 3) px(17, 0, 1, 10, P.accent);
    px(9, 19, 1, 4 - lA, bone); px(14, 19, 1, 4 - lB, bone); px(9, 18, 6, 1, dark);
    return [8, 10, 8, 6];
  },
  serpent(px, P, dir, f) {
    // 盘成两圈，脖子竖起来；出手时向前一扑，吐出信子
    const dark = shade(P.body, -0.3), belly = P.accent, sw = f === 1 ? 1 : f === 2 ? -1 : 0, strike = f === 3 ? 3 : 0;
    px(3, 18, 18, 4, P.body); px(2, 19, 20, 2, P.body); px(4, 21, 16, 1, dark);
    px(6, 15, 12, 4, shade(P.body, 0.08)); px(5, 16, 14, 2, shade(P.body, 0.08)); px(7, 18, 10, 1, dark);
    const nx = (dir === 'right' ? 12 + strike : dir === 'left' ? 8 : 10) + sw;
    px(nx, 8 - strike, 4, 9 + strike, P.body); px(nx + 1, 9 - strike, 2, 8, belly);
    const hx = dir === 'right' ? nx + strike : nx - 2;
    px(hx, 4 - strike, 8, 5, P.body); px(hx + 1, 3 - strike, 6, 1, shade(P.body, 0.15));
    if (dir === 'right') { px(hx + 5, 5 - strike, 2, 2, P.eyes); if (f === 3) { px(hx + 8, 7 - strike, 3, 1, '#ff4a6a'); px(hx + 10, 6 - strike, 1, 1, '#ff4a6a'); } }
    else if (dir === 'down') { px(hx + 1, 5 - strike, 2, 2, P.eyes); px(hx + 5, 5 - strike, 2, 2, P.eyes); if (f === 3) px(hx + 3, 9 - strike, 2, 2, '#ff4a6a'); }
    return [6, 15, 12, 3];
  },
  eye(px, P, dir, f) {
    const bob = f === 1 ? -1 : f === 2 ? 1 : 0, open = f === 3 ? 1 : 0;
    for (let i = 0; i < 4; i++) px(5 + i * 4, 17 + bob + (i % 2), 2, 5 - (i % 2), shade(P.accent, -0.2));
    px(4, 3 + bob, 16, 15, P.body); px(3, 6 + bob, 18, 9, P.body); px(6, 2 + bob, 12, 1, shade(P.body, 0.2));
    if (dir !== 'up') {
      const cx = dir === 'right' ? 13 : 9;
      px(cx - open, 6 + bob - open, 6 + open * 2, 7 + open * 2, P.accent); px(cx + 1, 8 + bob, 4, 3, P.eyes); px(cx + 1, 8 + bob, 1, 1, '#ffffff');
    } else px(6, 6 + bob, 12, 3, shade(P.body, -0.2));
    return [4, 14 + bob, 16, 3];
  },
};

/** 自动描边：透明像素挨着不透明像素的地方描一圈深色 */
function outline(c) {
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data, W = c.width, H = c.height;
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] > 0;
  const out = new Uint8ClampedArray(d);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (solid(x, y)) continue;
    if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) { const i = (y * W + x) * 4; out[i] = 22; out[i + 1] = 16; out[i + 2] = 26; out[i + 3] = 230; }
  }
  ctx.putImageData(new ImageData(out, W, H), 0, 0);
}

/** 生成一套怪物精灵：{ down: [4 帧], up, right, left } */
export function buildMonster(look) {
  const plan = PLANS[look.bodyPlan] || PLANS.humanoid;
  const P = paletteOf(look);
  const patCol = look.pattern === 'bone' ? shade(P.body, -0.25) : look.pattern === 'crystal' ? P.glow : shade(P.accent, -0.1);
  const res = {};
  for (const dir of ['down', 'up', 'right']) {
    res[dir] = [0, 1, 2, 3].map((f) => {
      const c = document.createElement('canvas');
      c.width = MON_W; c.height = MON_H;
      const ctx = c.getContext('2d');
      const px = painter(ctx);
      const rect = plan(px, P, dir, f);
      pattern(px, look.pattern, rect, patCol);
      outline(c);
      return c;
    });
  }
  res.left = res.right.map((src) => {
    const c = document.createElement('canvas');
    c.width = MON_W; c.height = MON_H;
    const ctx = c.getContext('2d');
    ctx.translate(MON_W, 0); ctx.scale(-1, 1);
    ctx.drawImage(src, 0, 0);
    return c;
  });
  res.palette = P;
  return res;
}
