// 每帧的物体与角色：水面、动态物件、构筑物与裂隙、异界生物、特效、喷泉、热气球、访客化身、居民
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。
import { SPR_W, SPR_H, buildSprites } from '../sprites.js';
import { TS, T, SCALE, h2, hexToRgb, roundRect } from './util.js';

export class Objects {
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
      case 'moonwell': {
        const cx = X + TS, cy = Y + TS + 4;
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx + 2, cy + 8, 30, 14, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#6d6699'; ctx.beginPath(); ctx.ellipse(cx, cy + 4, 28, 14, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#9a93c8'; ctx.beginPath(); ctx.ellipse(cx, cy, 28, 13, 0, 0, 7); ctx.fill();
        const wg = ctx.createRadialGradient(cx, cy, 2, cx, cy, 22);
        wg.addColorStop(0, '#e6f4ff'); wg.addColorStop(1, '#6a8cff');
        ctx.fillStyle = wg; ctx.beginPath(); ctx.ellipse(cx, cy, 22, 9, 0, 0, 7); ctx.fill();
        for (let i = 0; i < 5; i++) {
          const p = (t * 0.4 + i / 5) % 1;
          ctx.fillStyle = `rgba(220,235,255,${1 - p})`;
          ctx.fillRect(cx - 14 + i * 7, cy - p * 40, 2, 2);
        }
        break;
      }
      case 'moonflower': {
        const glow = 0.6 + Math.sin(t * 2 + o.v * 10) * 0.3;
        ctx.fillStyle = '#2d5a55'; ctx.fillRect(X + 15, Y + 14, 2, 12);
        ctx.fillStyle = `rgba(160,235,255,${glow})`;
        for (const [dx, dy] of [[0, -4], [4, 0], [0, 4], [-4, 0]]) { ctx.beginPath(); ctx.arc(X + 16 + dx, Y + 12 + dy, 3, 0, 7); ctx.fill(); }
        ctx.fillStyle = '#fffbe0'; ctx.fillRect(X + 15, Y + 11, 2, 2);
        break;
      }
      case 'crystal': {
        const h = 20 + o.v * 18;
        ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(X + 16, Y + 26, 10, 4, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#7b5cd6';
        ctx.beginPath(); ctx.moveTo(X + 10, Y + 26); ctx.lineTo(X + 14, Y + 26 - h); ctx.lineTo(X + 20, Y + 26 - h * 0.8); ctx.lineTo(X + 22, Y + 26); ctx.fill();
        ctx.fillStyle = '#b69bff';
        ctx.beginPath(); ctx.moveTo(X + 14, Y + 26); ctx.lineTo(X + 14, Y + 26 - h); ctx.lineTo(X + 17, Y + 26 - h * 0.9); ctx.lineTo(X + 17, Y + 26); ctx.fill();
        if (Math.sin(t * 1.5 + o.v * 30) > 0.9) { ctx.fillStyle = '#fff'; ctx.fillRect(X + 15, Y + 24 - h, 2, 2); }
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
    // 怪物体型的异界生物：和威胁一样画（冒险 §4.1）
    if (spr.palette) return this.drawMonster(ctx, { ...c, type: `c_${c.type}`, maxHp: null }, this.creatureLooks?.[c.type] || { bodyPlan: 'blob' }, this.S);
    const cx = c.dx * TS + TS / 2, fy = c.dy * TS + TS - 2;
    const fi = c.moving ? [1, 0, 2, 0][Math.floor(this.time * 6) % 4] : Math.floor(this.time * 2) % 2;
    const float = Math.sin(this.time * 3 + c.dx) * 2;
    ctx.fillStyle = c.friendly ? 'rgba(255,170,220,.35)' : 'rgba(110,80,220,.35)';
    ctx.beginPath(); ctx.ellipse(cx, fy, 10, 4, 0, 0, 7); ctx.fill();
    const img = spr[c.dir]?.[fi] || spr.down[0];
    ctx.save();
    ctx.globalAlpha = 0.92;
    const draw = () => ctx.drawImage(img, Math.round(cx - (SPR_W * SCALE) / 2), Math.round(fy - SPR_H * SCALE + 4 + float), SPR_W * SCALE, SPR_H * SCALE);
    draw();
    if (this.flashing(`creature:${c.id}`)) this.flashOver(ctx, draw);
    ctx.restore();
    if (c.friendly && c.name) {
      ctx.save(); ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd6ee';
      ctx.fillText(`💜${c.name}`, cx, fy - SPR_H * SCALE - 2); ctx.restore();
    }
  }

  /** AI 插件的覆盖层：插件只能给出声明式的绘制指令（emoji / text / ring / sparkle），由这里统一绘制 */
  drawPluginOverlay(ctx, S) {
    if (!S.overlay?.length) return;
    const t = this.time;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const o of S.overlay) {
      const X = o.x * TS + TS / 2, Y = o.y * TS + TS / 2;
      const bob = Math.sin(t * 2 + o.x) * 2;
      if (o.kind === 'emoji') { ctx.font = '18px sans-serif'; ctx.fillText(o.text, X, Y + bob); }
      else if (o.kind === 'text') {
        ctx.font = 'bold 12px sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.fillStyle = o.color;
        ctx.strokeText(o.text, X, Y); ctx.fillText(o.text, X, Y);
      } else if (o.kind === 'ring') {
        ctx.strokeStyle = o.color; ctx.globalAlpha = 0.5 + Math.sin(t * 3) * 0.2; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(X, Y + 8, o.r * TS, o.r * TS * 0.45, 0, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (o.kind === 'sparkle') {
        ctx.fillStyle = o.color; ctx.font = 'bold 13px sans-serif';
        for (let i = 0; i < 3; i++) ctx.fillText('✦', X + Math.sin(t * 2 + i * 2.1) * o.r * TS * 0.5, Y - 6 - ((t * 20 + i * 12) % 24));
      }
    }
    ctx.restore();
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
        case 'split': {
          // 创世：一道金色的裂缝从天到地劈开，四周一圈光
          const L = R * 3, segs = 14;
          ctx.save();
          ctx.globalAlpha = Math.min(1, (1 - k) * 1.6);
          ctx.shadowColor = `rgb(${r},${g},${b})`; ctx.shadowBlur = 24;
          for (const [w, col] of [[10 * (1 - k) + 3, `rgb(${r},${g},${b})`], [3, '#fff']]) {
            ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
            for (let i = 0; i <= segs; i++) {
              const yy = Y - L + (2 * L * i) / segs * Math.min(1, k * 4);
              const xx = X + Math.sin(i * 2.7 + v.seed * 10) * TS * 0.6 * (i % 2 ? 1 : -1);
              i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
            }
            ctx.stroke();
          }
          ctx.globalAlpha = (1 - k) * 0.5;
          const gr = ctx.createRadialGradient(X, Y, 0, X, Y, R * 2);
          gr.addColorStop(0, `rgba(${r},${g},${b},0.9)`); gr.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = gr; ctx.fillRect(X - R * 2, Y - R * 2, R * 4, R * 4);
          ctx.restore();
          break;
        }
        case 'quake': {
          ctx.strokeStyle = `rgba(${r},${g},${b},.8)`;
          for (let i = 0; i < 3; i++) {
            const kk = Math.min(1, k * 1.5 + i * 0.15);
            ctx.lineWidth = 4 * (1 - kk) + 1;
            ctx.beginPath(); ctx.ellipse(X, Y + 8, R * kk * 1.4, R * kk * 0.6, 0, 0, 7); ctx.stroke();
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

  /** 访客化身：带兜帽的斗篷小人 + 名牌（自己的化身有金色光圈） */
  drawAvatar(ctx, v, S) {
    const cx = v.dx * TS + TS / 2, fy = v.dy * TS + TS - 2;
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.ellipse(cx, fy, 10, 4, 0, 0, 7); ctx.fill();
    if (v.mine) {
      const p = (Math.sin(this.time * 4) + 1) / 2;
      ctx.strokeStyle = `rgba(255,214,102,${0.6 + p * 0.4})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(cx, fy, 14 + p * 2, 5 + p, 0, 0, 7); ctx.stroke();
    }
    // 像素精灵（和居民同一个生成器）：按形象缓存，行走时换帧；被打倒时半透明闪烁
    const look = v.look || { skin: '#f7d5bd', hair: '#5a3a22', hairStyle: 'short', shirt: v.color, pants: '#4a4a5a', acc: [] };
    const k = JSON.stringify(look);
    const cache = (this.avatarSprites ||= {});
    if (cache[v.id]?.k !== k) cache[v.id] = { k, spr: buildSprites(look) };
    const spr = cache[v.id].spr;
    const fi = v.moving ? [1, 0, 2, 0][Math.floor(this.time * 8) % 4] : 0;
    const img = spr[v.dir]?.[fi] || spr.down[0];
    const y0 = fy - SPR_H * SCALE + 4;
    ctx.save();
    if (v.down) ctx.globalAlpha = 0.35 + (Math.sin(this.time * 12) > 0 ? 0.3 : 0);
    const draw = () => ctx.drawImage(img, Math.round(cx - (SPR_W * SCALE) / 2), Math.round(y0), SPR_W * SCALE, SPR_H * SCALE);
    draw();
    if (this.flashing(`avatar:${v.id}`)) this.flashOver(ctx, draw);
    ctx.restore();
    ctx.save();
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const label = `👣${v.name}`;
    const w = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(20,20,30,.6)'; roundRect(ctx, cx - w / 2, y0 - 16, w, 14, 5); ctx.fill();
    ctx.fillStyle = v.mine ? '#ffe08a' : '#fff'; ctx.fillText(label, cx, y0 - 3);
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
    const draw = () => ctx.drawImage(img, Math.round(cx - (SPR_W * SCALE) / 2), Math.round(fy - SPR_H * SCALE + 4 + bob), SPR_W * SCALE, SPR_H * SCALE);
    // 武器与盾（冒险 §4.2）：朝上时在身后
    if (a.dir === 'up') this.drawGear(ctx, `agent:${a.id}`, cx, fy + bob, a.dir, a.wp, a.sh);
    draw();
    if (this.flashing(`agent:${a.id}`)) this.flashOver(ctx, draw);
    if (a.dir !== 'up') this.drawGear(ctx, `agent:${a.id}`, cx, fy + bob, a.dir, a.wp, a.sh);
    this.drawAgentStatus(ctx, a);
  }
}
