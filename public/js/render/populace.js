// 群众的画面（docs/design/populace.md §7）：各地点按人数画出路人，人流沿着道路走，聚集的人围成一圈。
// 服务器只给人数（快照的 crowd）和人流的路径（populace 推送），每个路人的位置由地点、类别、序号决定（每帧稳定）。
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。
import { TS } from './util.js';

const SKIN = ['#e8c6a0', '#d9b99b', '#c99a78', '#f0d2b0', '#b98a68'];
const HAIR = ['#2a2a2a', '#3b2a20', '#5a4030', '#1f1f28', '#7a6a5a', '#c8c0b0'];

/** 一个地点画几个小人：比例尺为 1 时一人一个；大于 1 时按比例；0 时按对数 */
export function figureCount(n, scale) {
  if (n <= 0) return 0;
  if (scale === 1) return Math.min(12, n);
  if (scale > 1) return Math.min(10, Math.max(1, Math.round(n / scale)));
  return Math.min(8, Math.max(1, Math.round(Math.log10(n + 1) * 2.2)));
}

/** 按各类人数把 k 个小人分给各类（第 i 个小人属于哪一类） */
export function groupOf(row, i, k) {
  const total = row.reduce((s, n) => s + n, 0);
  if (!total) return 0;
  const at = ((i + 0.5) / k) * total;
  let acc = 0;
  for (let g = 0; g < row.length; g++) { acc += row[g]; if (at < acc) return g; }
  return row.length - 1;
}

/** 折线（[x0, y0, x1, y1, …]）上按比例取一点 */
export function alongPath(p, f) {
  const n = p.length / 2;
  if (n < 2) return { x: p[0], y: p[1] };
  const seg = [];
  let len = 0;
  for (let i = 1; i < n; i++) { const d = Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]); seg.push(d); len += d; }
  let want = Math.max(0, Math.min(1, f)) * len;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const k = seg[i] ? Math.min(1, want / seg[i]) : 0;
      return { x: p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * k, y: p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * k };
    }
    want -= seg[i];
  }
  return { x: p[p.length - 2], y: p[p.length - 1] };
}

export class PopulaceLayer {
  /** 这一帧要画的路人：{ id, x, y, seed, g, moving, face? }；同时记下来给点击判定用 */
  crowdFigures(S) {
    const out = [];
    this.pfigs = out;
    const meta = S.pop, counts = S.crowd;
    if (!meta || !counts) return out;
    const v = this.view;
    const visible = (x, y) => !(x * TS < v.x0 - 64 || x * TS > v.x1 + 64 || y * TS < v.y0 - 64 || y * TS > v.y1 + 64);
    const t = S.t;
    const gathering = Object.fromEntries((meta.gatherings || []).filter((g) => g.from <= t && g.until > t).map((g) => [g.loc, g]));
    // 地点里的人
    for (const [id, row] of Object.entries(counts)) {
      const l = this.world.locations[id];
      if (!l) continue;
      const n = row.reduce((s, x) => s + x, 0);
      let k = figureCount(n, meta.scale);
      const b = l.indoor ? this.world.buildings.find((x) => x.id === l.indoor) : null;
      if (b) k = Math.min(k, 3); // 屋里的人看不见，门口站几个
      const ring = gathering[id] && !b;
      const c = ring ? { x: l.rect.x + l.rect.w / 2, y: l.rect.y + l.rect.h / 2 } : null;
      for (let i = 0; i < k; i++) {
        const seed = (id.length * 31 + i * 17 + id.charCodeAt(0) * 7) % 997;
        const g = groupOf(row, i, k);
        let x, y, moving = false, face = null;
        if (ring) {
          const a = (i / k) * Math.PI * 2 + 0.3, r = 1.6 + (seed % 3) * 0.45;
          x = c.x + Math.cos(a) * r; y = c.y + Math.sin(a) * r * 0.7 + Math.sin(this.time * 2 + seed) * 0.05;
          face = c;
        } else if (b) {
          const d = b.entrance || b.door;
          x = d.x + (i - 1) * 0.9 + Math.sin(this.time * 0.3 + seed) * 0.3; y = d.y + 0.4 + (i % 2) * 0.3;
          moving = Math.abs(Math.cos(this.time * 0.3 + seed)) > 0.6;
        } else {
          const base = l.spots?.length ? l.spots[(seed + i) % l.spots.length] : { x: l.rect.x + (seed % Math.max(1, l.rect.w)), y: l.rect.y + (seed % Math.max(1, l.rect.h)) };
          const ph = this.time * 0.25 + seed;
          x = base.x + Math.sin(ph) * 1.4 + ((seed % 5) - 2) * 0.4; y = base.y + Math.cos(ph * 0.7) * 0.7 + 0.6;
          moving = Math.abs(Math.cos(ph)) > 0.3;
        }
        if (visible(x, y)) out.push({ id: `p:${id}:${g}:${i}`, x, y, seed, g, moving, face });
      }
    }
    // 路上的人流
    for (const f of meta.flows || []) {
      if (f.region !== S.region || t < f.s || t > f.e || !f.p?.length) continue;
      const prog = (t - f.s) / Math.max(1, f.e - f.s);
      const k = meta.scale === 1 ? Math.min(6, f.n) : Math.min(5, Math.max(1, Math.ceil(meta.scale > 1 ? f.n / meta.scale : Math.log10(f.n + 1) * 2)));
      for (let j = 0; j < k; j++) {
        const q = prog - j * 0.035;
        if (q < 0) continue;
        const pt = alongPath(f.p, q);
        const seed = (f.id * 13 + j * 7) % 997;
        const x = pt.x + ((seed % 3) - 1) * 0.25, y = pt.y + ((seed % 5) - 2) * 0.12;
        if (visible(x, y)) out.push({ id: `p:${f.to}:${f.g}:${(f.id * 7 + j) % 1000}`, x, y, seed, g: f.g, moving: true, hurry: f.c === 'flee' || f.c === 'leave' });
      }
    }
    return out;
  }

  /** 一个路人：比居民小一号、半透明，衣服是所属类别的颜色 */
  drawPasserby(ctx, p) {
    const S = this.S;
    const tones = S?.pop?.groups?.[p.g]?.tones || ['#5b6270'];
    const X = p.x * TS + TS / 2, Y = p.y * TS + TS - 2;
    const sp = p.hurry ? 12 : 6;
    const k = 1.3; // 比居民小一号，但看得清
    const bob = p.moving ? Math.abs(Math.sin(this.time * sp + p.seed)) * 1.5 : 0;
    const step = p.moving ? Math.sin(this.time * sp + p.seed) * 1.5 : 0;
    const sel = S?.selected === p.id || S?.hover === p.id;
    ctx.save();
    ctx.translate(X, Y); ctx.scale(k, k); ctx.translate(-X, -Y);
    ctx.globalAlpha = sel ? 1 : 0.88;
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.ellipse(X, Y, 6, 2.2, 0, 0, 7); ctx.fill();
    if (sel) { ctx.strokeStyle = '#ffd666'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(X, Y, 8, 3, 0, 0, 7); ctx.stroke(); }
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(X - 3, Y - 4 - bob + step * 0.5, 2, 4); ctx.fillRect(X + 1, Y - 4 - bob - step * 0.5, 2, 4);
    ctx.fillStyle = tones[p.seed % tones.length];
    ctx.fillRect(X - 4, Y - 16 - bob, 8, 12);
    ctx.fillStyle = SKIN[p.seed % SKIN.length];
    ctx.beginPath(); ctx.arc(X, Y - 20 - bob, 4, 0, 7); ctx.fill();
    ctx.fillStyle = HAIR[(p.seed >> 2) % HAIR.length];
    ctx.fillRect(X - 4, Y - 24 - bob, 8, 2.5);
    ctx.restore();
  }

  /** 点击判定：路人的屏幕范围（先于居民登记，重叠时点到的是居民） */
  hitPassersby(ox, oy, z) {
    for (const p of this.pfigs || []) {
      const x = (p.x * TS + TS / 2) * z + ox, fy = (p.y * TS + TS - 2) * z + oy;
      if (x < -20 || x > this.vw + 20 || fy < -40 || fy > this.vh + 40) continue;
      this.hits.push({ id: p.id, x: x - 9 * z, y: fy - 34 * z, w: 18 * z, h: 35 * z });
    }
  }
}
