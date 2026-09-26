// 渲染器共用的常量与小工具（纯函数，不碰 DOM）
export const TS = 32;
export const T = { GRASS: 0, PATH: 1, PLAZA: 2, DIRT: 3, WATER: 4, SAND: 5, BRIDGE: 6, SOIL: 7, WOOD: 8, DEEP: 9, FLOWER: 10, MOON: 11, VOID: 12, MOONPATH: 13 };
export const SCALE = 2; // 角色精灵放大倍数
export const STATIC_OBJECTS = new Set(['fence', 'crop', 'bench', 'rock', 'stage', 'hay', 'anvil', 'woodpile']);

// ---------- 工具 ----------
export function h2(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const sm = (t) => t * t * (3 - 2 * t);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  const u = sm(xf), v = sm(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function mix(c1, c2, t) {
  t = Math.max(0, Math.min(1, t));
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (t) => Math.max(0, Math.min(1, t));

export function roundRect(c, x, y, w, h, r) {
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
