// 程序化像素角色精灵：4 方向 × 3 帧，自动描边；以及头像生成
export const SPR_W = 20, SPR_H = 27;

export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  return `#${((1 << 24) | (f(r) << 16) | (f(g) << 8) | f(b)).toString(16).slice(1)}`;
}

function drawBody(ctx, look, dir, frame) {
  const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x + 1, y + 1, w, h); };
  const { skin, hair, shirt, pants } = look;
  const acc = new Set(look.acc || []);
  const style = look.hairStyle;
  const skinS = shade(skin, -0.12);
  const shirtS = shade(shirt, -0.18);
  const pantsS = shade(pants, -0.2);
  const hairS = shade(hair, -0.25);
  const hairH = shade(hair, 0.25);
  const shoe = '#3b2b2b';
  const coat = acc.has('coat');
  const top = coat ? '#f6f6fa' : shirt;
  const topS = coat ? '#d8dae6' : shirtS;
  const side = dir === 'left' || dir === 'right';
  // 1: 左腿前 2: 右腿前
  const lUp = frame === 1 ? 1 : 0, rUp = frame === 2 ? 1 : 0;

  // ---- 腿与鞋 ----
  if (!side) {
    px(6, 19, 3, 3 - lUp, pants); px(6, 22 - lUp, 3, 2, shoe);
    px(9, 19, 3, 3 - rUp, pantsS); px(9, 22 - rUp, 3, 2, shoe);
  } else {
    if (frame === 0) { px(7, 19, 4, 3, pants); px(7, 22, 4, 2, shoe); }
    else {
      const back = frame === 1 ? pantsS : pants, front = frame === 1 ? pants : pantsS;
      px(5, 19, 3, 3, back); px(4, 22, 3, 2, shoe);
      px(10, 19, 3, 3, front); px(11, 22, 3, 2, shoe);
    }
  }
  // ---- 身体 ----
  if (!side) {
    px(5, 12, 8, 7, top);
    px(5, 17, 8, 2, topS);
    if (coat) { px(4, 13, 10, 7, '#f6f6fa'); px(8, 13, 2, 7, shirt); px(4, 19, 10, 1, '#d8dae6'); }
    if (acc.has('apron') && dir === 'down') { px(6, 13, 6, 6, '#fbf6ee'); px(6, 12, 1, 1, '#fbf6ee'); px(11, 12, 1, 1, '#fbf6ee'); px(7, 16, 4, 1, '#eadfce'); }
    // 手臂摆动
    const la = frame === 1 ? -1 : frame === 2 ? 1 : 0;
    px(3, 12 + Math.max(0, la), 2, 5, topS); px(3, 17 + la, 2, 2, skin);
    px(13, 12 + Math.max(0, -la), 2, 5, topS); px(13, 17 - la, 2, 2, skin);
  } else {
    px(6, 12, 6, 7, top);
    px(6, 17, 6, 2, topS);
    if (coat) { px(5, 13, 8, 7, '#f6f6fa'); px(5, 19, 8, 1, '#d8dae6'); }
    if (acc.has('apron')) { px(10, 13, 2, 6, '#fbf6ee'); }
    const sw = frame === 1 ? 1 : frame === 2 ? -1 : 0;
    px(8 + sw, 13, 2, 5, topS); px(8 + sw, 18, 2, 1, skin);
  }

  // ---- 头 ----
  px(4, 3, 10, 9, skin);
  px(3, 4, 1, 7, skin); px(14, 4, 1, 7, skin);
  px(4, 11, 10, 1, skinS);
  if (dir === 'down') {
    px(6, 7, 1, 2, '#2b2233'); px(11, 7, 1, 2, '#2b2233');
    px(6, 7, 1, 1, '#4a3d55');
    px(5, 9, 1, 1, '#f3a3a3'); px(12, 9, 1, 1, '#f3a3a3');
    px(8, 10, 2, 1, '#b8645e');
  } else if (dir === 'right') {
    px(11, 7, 1, 2, '#2b2233'); px(12, 9, 1, 1, '#f3a3a3'); px(12, 10, 1, 1, '#b8645e');
    px(14, 7, 1, 2, skin);
  } else if (dir === 'left') {
    px(6, 7, 1, 2, '#2b2233'); px(5, 9, 1, 1, '#f3a3a3'); px(5, 10, 1, 1, '#b8645e');
    px(3, 7, 1, 2, skin);
  }

  // ---- 胡子 ----
  if (acc.has('beard') && dir !== 'up') {
    if (dir === 'down') { px(4, 9, 10, 3, hairS); px(8, 10, 2, 1, '#8a4a44'); px(5, 9, 1, 1, hairS); }
    else if (dir === 'right') px(9, 9, 5, 3, hairS);
    else px(4, 9, 5, 3, hairS);
  }

  // ---- 头发 ----
  const hairTop = () => { px(4, 1, 10, 3, hair); px(3, 2, 12, 2, hair); px(5, 1, 6, 1, hairH); };
  if (dir === 'up') {
    px(3, 2, 12, 9, hair); px(4, 1, 10, 1, hair); px(4, 11, 10, 1, hairS);
    if (style === 'long') { px(2, 5, 14, 9, hair); px(3, 13, 12, 2, hairS); }
    if (style === 'bun') { px(7, -1, 4, 3, hair); px(8, -1, 2, 1, hairH); }
    if (style === 'spiky') { px(4, 0, 2, 1, hair); px(8, -1, 2, 2, hair); px(12, 0, 2, 1, hair); }
    if (style === 'messy') { px(5, 0, 2, 1, hair); px(10, 0, 2, 1, hair); }
  } else {
    if (style === 'buzz') {
      px(4, 2, 10, 2, hair); px(3, 3, 1, 2, hair); px(14, 3, 1, 2, hair);
    } else {
      hairTop();
      if (dir === 'down') {
        px(3, 4, 2, 2, hair); px(13, 4, 2, 2, hair); px(5, 4, 3, 1, hair); px(10, 4, 2, 1, hair);
        if (style === 'long') { px(2, 4, 2, 10, hair); px(14, 4, 2, 10, hair); px(2, 13, 2, 1, hairS); px(14, 13, 2, 1, hairS); }
        if (style === 'messy') { px(6, 4, 2, 2, hair); px(4, 0, 2, 1, hair); px(9, 0, 2, 1, hair); px(12, 1, 2, 1, hair); }
        if (style === 'spiky') { px(4, 0, 2, 1, hair); px(7, -1, 2, 2, hair); px(10, 0, 2, 1, hair); px(12, 0, 2, 2, hair); px(8, 4, 3, 1, hair); }
        if (style === 'bun') { px(7, -1, 4, 3, hair); px(8, -1, 2, 1, hairH); }
      } else {
        const back = dir === 'right' ? 3 : 10;
        px(back, 3, 5, 6, hair);
        if (dir === 'right') { px(9, 4, 4, 1, hair); } else { px(5, 4, 4, 1, hair); }
        if (style === 'long') px(dir === 'right' ? 2 : 11, 4, 5, 10, hair);
        if (style === 'bun') px(dir === 'right' ? 3 : 11, 0, 4, 3, hair);
        if (style === 'spiky') { px(5, -1, 2, 2, hair); px(9, 0, 2, 1, hair); px(dir === 'right' ? 3 : 13, 1, 2, 2, hair); }
        if (style === 'messy') { px(6, 0, 2, 1, hair); px(10, 0, 2, 1, hair); }
      }
    }
  }

  // ---- 配饰 ----
  if (acc.has('glasses') && dir !== 'up') {
    const g = '#2d2d3a';
    if (dir === 'down') { px(5, 6, 3, 1, g); px(10, 6, 3, 1, g); px(5, 8, 3, 1, g); px(10, 8, 3, 1, g); px(8, 7, 2, 1, g); px(5, 7, 1, 1, g); px(12, 7, 1, 1, g); }
    else if (dir === 'right') { px(10, 6, 3, 1, g); px(10, 8, 3, 1, g); px(12, 7, 1, 1, g); px(6, 7, 4, 1, g); }
    else { px(5, 6, 3, 1, g); px(5, 8, 3, 1, g); px(5, 7, 1, 1, g); px(8, 7, 4, 1, g); }
  }
  if (acc.has('strawhat')) {
    px(0, 3, 18, 1, '#d9b25a'); px(1, 2, 16, 1, '#e8c56f');
    px(5, 0, 8, 2, '#e8c56f'); px(5, 1, 8, 1, '#c0392b');
  }
  if (acc.has('cap')) {
    px(3, 1, 12, 3, '#d9423a'); px(5, 0, 8, 1, '#d9423a'); px(8, 1, 2, 1, '#f7f7f7');
    if (dir === 'down') px(4, 4, 10, 1, '#a52f29');
    if (dir === 'right') px(12, 3, 5, 1, '#a52f29');
    if (dir === 'left') px(1, 3, 5, 1, '#a52f29');
  }
  if (acc.has('earring') && dir !== 'up') {
    if (dir !== 'right') px(3, 10, 1, 1, '#ffd34d');
    if (dir !== 'left') px(14, 10, 1, 1, '#ffd34d');
  }
}

function outline(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const out = new Uint8ClampedArray(d);
  const a = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (a(x, y) > 0) continue;
    if (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1)) {
      const i = (y * w + x) * 4;
      out[i] = 38; out[i + 1] = 28; out[i + 2] = 44; out[i + 3] = 230;
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
}

// 返回 { down:[c0,c1,c2], up:[...], left:[...], right:[...] }
export function buildSprites(look) {
  const res = {};
  for (const dir of ['down', 'up', 'right']) {
    res[dir] = [0, 1, 2].map((f) => {
      const c = document.createElement('canvas');
      c.width = SPR_W; c.height = SPR_H;
      const ctx = c.getContext('2d');
      ctx.translate(0, 1);
      drawBody(ctx, look, dir, f);
      outline(c);
      return c;
    });
  }
  res.left = res.right.map((src) => {
    const c = document.createElement('canvas');
    c.width = SPR_W; c.height = SPR_H;
    const ctx = c.getContext('2d');
    ctx.translate(SPR_W, 0); ctx.scale(-1, 1);
    ctx.drawImage(src, 0, 0);
    return c;
  });
  return res;
}

// 头像：放大的正面像素头部，带圆形背景
export function makePortrait(sprites, bg, size = 96) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, shade(bg, 0.45));
  g.addColorStop(1, shade(bg, 0.1));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
  const s = size / 15;
  ctx.drawImage(sprites.down[0], 0, 0, SPR_W, 20, size / 2 - (SPR_W * s) / 2, size * 0.1, SPR_W * s, 20 * s);
  ctx.restore();
  return c.toDataURL();
}
