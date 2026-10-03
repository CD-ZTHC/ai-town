// 黑暗叙事的画面（docs/design/night-watch.md §4.13）：威胁、区域、墓碑、居民的伤势与标记。
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。
import { TS, hexToRgb } from './util.js';

export class DarkLayer {
  /** 区域：一片随时间缓缓起伏的暗色，边缘是一圈虚线 */
  drawZones(ctx, S) {
    const zones = S.dark?.zones || [];
    if (!zones.length) return;
    const t = this.time;
    for (const z of zones) {
      const X = z.x * TS + TS / 2, Y = z.y * TS + TS / 2, R = z.r * TS;
      const [r, g, b] = hexToRgb(z.tint || '#5a2340');
      const pulse = 0.5 + Math.sin(t * 0.8 + z.x) * 0.12;
      const grd = ctx.createRadialGradient(X, Y, R * 0.1, X, Y, R);
      grd.addColorStop(0, `rgba(${r},${g},${b},${0.42 * pulse})`);
      grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(X - R, Y - R, R * 2, R * 2);
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = -t * 6;
      ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(X, Y, R, R * 0.8, 0, 0, 7); ctx.stroke();
      ctx.restore();
    }
  }

  /** 威胁：一团影子上浮着它的符号；被压住时是灰色的，还带一圈锁链；会死的威胁有血条 */
  drawThreat(ctx, th) {
    const X = th.dx * TS + TS / 2, fy = th.dy * TS + TS - 2, t = this.time;
    const held = th.state === 'suppressed';
    const flick = held ? 0.5 : 0.75 + Math.sin(t * 7 + th.dx * 3) * 0.12 + (Math.random() < 0.03 ? -0.4 : 0);
    ctx.save();
    ctx.fillStyle = held ? 'rgba(90,90,100,.35)' : 'rgba(20,0,10,.45)';
    ctx.beginPath(); ctx.ellipse(X, fy, 13, 5, 0, 0, 7); ctx.fill();
    const g = ctx.createRadialGradient(X, fy - 20, 2, X, fy - 20, 26);
    g.addColorStop(0, held ? 'rgba(120,120,130,.55)' : 'rgba(30,5,20,.75)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(X - 26, fy - 46, 52, 52);
    ctx.globalAlpha = Math.max(0.2, flick);
    ctx.font = '26px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(th.emoji || '👁️', X, fy - 4 + Math.sin(t * 2 + th.dx) * 2);
    ctx.globalAlpha = 1;
    if (held) {
      ctx.strokeStyle = 'rgba(200,200,210,.8)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(X, fy - 16, 16, 20, 0, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    if (th.maxHp && !this.S?.fightKeys?.has(`threat:${th.id}`)) { // 战斗中的血条由 render/combat 画
      const w = 26, p = Math.max(0, th.hp / th.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(X - w / 2, fy - 40, w, 4);
      ctx.fillStyle = '#e04848'; ctx.fillRect(X - w / 2, fy - 40, w * p, 4);
    }
    ctx.restore();
  }

  /**
   * 群众：有人口的地点周围画几个不接入模型的路人。人数随活着的人口（取对数）变化，夜里少一些；
   * 每个路人在自己的小范围里慢慢踱步，位置由地点和序号决定（每帧稳定，不需要服务器下发坐标）。
   */
  crowdFigures(S) {
    const crowd = S.dark?.crowd;
    if (!crowd) return [];
    const minute = S.t % 1440;
    const night = minute < 6 * 60 || minute >= 21 * 60;
    const out = [];
    const v = this.view;
    for (const [id, alive] of Object.entries(crowd)) {
      const l = this.world.locations[id];
      if (!l || alive <= 0) continue;
      const n = Math.min(4, Math.round(Math.log10(alive + 1) * 1.3 * (night ? 0.35 : 1)));
      const r = l.rect;
      for (let i = 0; i < n; i++) {
        const seed = (id.length * 31 + i * 17 + id.charCodeAt(0)) % 997;
        const base = l.spots?.length ? l.spots[(seed + i) % l.spots.length] : { x: r.x + (seed % Math.max(1, r.w)), y: r.y + r.h };
        const ph = this.time * 0.25 + seed;
        const x = base.x + Math.sin(ph) * 1.6 + ((seed % 5) - 2) * 0.4, y = base.y + Math.cos(ph * 0.7) * 0.8 + 0.6;
        if (x * TS < v.x0 - 64 || x * TS > v.x1 + 64 || y * TS < v.y0 - 64 || y * TS > v.y1 + 64) continue;
        out.push({ x, y, seed, moving: Math.abs(Math.cos(ph)) > 0.3 });
      }
    }
    return out;
  }

  drawPasserby(ctx, p) {
    const X = p.x * TS + TS / 2, Y = p.y * TS + TS - 2;
    const tones = ['#5b6270', '#6d5b52', '#4f5a4f', '#6b6b7b', '#5a4a5a'];
    const bob = p.moving ? Math.abs(Math.sin(this.time * 6 + p.seed)) * 1.5 : 0;
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.ellipse(X, Y, 6, 2.2, 0, 0, 7); ctx.fill();
    ctx.fillStyle = tones[p.seed % tones.length];
    ctx.fillRect(X - 4, Y - 16 - bob, 8, 12);
    ctx.fillStyle = '#d9b99b';
    ctx.beginPath(); ctx.arc(X, Y - 20 - bob, 4, 0, 7); ctx.fill();
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(X - 3, Y - 4 - bob, 2, 4); ctx.fillRect(X + 1, Y - 4 - bob, 2, 4);
    ctx.restore();
  }

  drawGrave(ctx, g) {
    const X = g.x * TS + TS / 2, Y = g.y * TS + TS - 2;
    ctx.save();
    // 墓碑在夜里也要看得见：一圈淡淡的冷光
    const glow = ctx.createRadialGradient(X, Y - 10, 2, X, Y - 10, 22);
    glow.addColorStop(0, 'rgba(210,220,240,.35)'); glow.addColorStop(1, 'rgba(210,220,240,0)');
    ctx.fillStyle = glow; ctx.fillRect(X - 22, Y - 32, 44, 44);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(X, Y, 9, 3, 0, 0, 7); ctx.fill();
    // 墓碑直接画出来（不依赖系统有没有 🪦 这个字形）
    ctx.fillStyle = '#8d8f96';
    ctx.beginPath(); ctx.moveTo(X - 7, Y - 1); ctx.lineTo(X - 7, Y - 12); ctx.arc(X, Y - 12, 7, Math.PI, 0); ctx.lineTo(X + 7, Y - 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#6c6e75'; ctx.fillRect(X - 9, Y - 2, 18, 3);
    ctx.strokeStyle = '#55575d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X, Y - 15); ctx.lineTo(X, Y - 7); ctx.moveTo(X - 3, Y - 12); ctx.lineTo(X + 3, Y - 12); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = '10px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(230,225,215,.85)';
    ctx.fillText(g.name, X, Y - 20);
    ctx.restore();
  }

  /** 居民头顶：受伤时的血条，被盯上时的一只眼睛（观众是全知的） */
  drawAgentStatus(ctx, a) {
    if (a.hp == null && !a.marked && !a.hosted) return;
    const X = a.dx * TS + TS / 2, top = a.dy * TS - 26;
    ctx.save();
    if (a.hp != null && !this.S?.fightKeys?.has(`agent:${a.id}`)) {
      const w = 22, p = Math.max(0, a.hp / 100);
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(X - w / 2, top, w, 3);
      ctx.fillStyle = p < 0.3 ? '#e04848' : '#e0b048'; ctx.fillRect(X - w / 2, top, w * p, 3);
    }
    ctx.font = '11px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    if (a.marked) { ctx.globalAlpha = 0.6 + Math.sin(this.time * 5) * 0.3; ctx.fillText('👁️', X + 12, top + 2); ctx.globalAlpha = 1; }
    if (a.hosted) ctx.fillText('🌑', X - 12, top + 2);
    ctx.restore();
  }
}
