// 叠加层：名字与状态标签、游戏模式提示、思考气泡、对话气泡的排布、小地图
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。
import { SPR_H } from '../sprites.js';
import { TS, SCALE, clamp01, roundRect } from './util.js';

export class Overlays {
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
        if (a.bubble) bubbles.push({ a, x: x + size / 2, y: y - 6, below: y + size + 8 });
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
        // 等级徽章（冒险 §4.4）：名牌左边一枚金色小牌
        if (a.lv) {
          ctx.font = '800 9px "PingFang SC","Microsoft YaHei",sans-serif';
          const lw = ctx.measureText(`Lv${a.lv}`).width + 8;
          ctx.fillStyle = 'rgba(255,209,102,.95)'; roundRect(ctx, x - tw / 2 - lw + 3, fy + 6, lw, 14, 7); ctx.fill();
          ctx.fillStyle = '#3a2400'; ctx.fillText(`Lv${a.lv}`, x - tw / 2 - lw / 2 + 3, fy + 13.5);
        }
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
      if (a.bubble) bubbles.push({ a, x, y: headY - (a.thinking ? 34 : 4), below: fy + 24 });
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

    if (S.play) this.drawPlay(ctx, S, toS, z);

    // 气泡（避免重叠）
    const placed = [];
    bubbles.sort((p, q) => q.y - p.y);
    for (const b of bubbles) this.drawBubble(ctx, b, placed, now, S);
  }

  // 游戏模式：路线、落点、身边可以聊天的人
  drawPlay(ctx, S, toS, z) {
    const P = S.play;
    const v = (S.avatars || []).find((x) => x.id === P.me);
    ctx.save();
    if (v && P.to) {
      const pts = [[v.dx, v.dy], ...(P.next || []).map((n) => [n.x, n.y]), [P.to.x, P.to.y]].map(([x, y]) => toS(x * TS + TS / 2, y * TS + TS - 4));
      ctx.strokeStyle = 'rgba(255,224,138,.55)'; ctx.lineWidth = 2; ctx.setLineDash([3, 6]); ctx.lineDashOffset = -this.time * 18;
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      ctx.setLineDash([]);
      const [x, y] = pts[pts.length - 1];
      const p = (Math.sin(this.time * 5) + 1) / 2;
      ctx.strokeStyle = 'rgba(255,224,138,.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, (9 + p * 3) * z, (4 + p) * z, 0, 0, 7); ctx.stroke();
    }
    // 点击落点的涟漪
    if (P.click) {
      const age = (performance.now() - P.click.t) / 1000;
      if (age < 0.6) {
        const [x, y] = toS(P.click.x * TS + TS / 2, P.click.y * TS + TS - 4);
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - age / 0.6)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, y, (6 + age * 30) * z, (2.5 + age * 12) * z, 0, 0, 7); ctx.stroke();
      }
    }
    // 身边的人：头顶 💬，最近的一位显示操作提示
    ctx.textAlign = 'center';
    for (const id of P.near) {
      const a = S.agentMap[id];
      if (!a || a.inside) continue;
      const [x, fy] = toS(a.dx * TS + TS / 2, a.dy * TS + TS - 2);
      const top = fy - (SPR_H * SCALE + 18) * z;
      if (id === P.focus) {
        const label = P.touch ? `💬 点一下和${this.meta[id]?.name}聊天` : `E  和${this.meta[id]?.name}聊天`;
        ctx.font = '600 12px "PingFang SC","Microsoft YaHei",sans-serif';
        const w = ctx.measureText(label).width + 20;
        const bob = Math.sin(this.time * 3) * 2;
        ctx.fillStyle = 'rgba(20,22,35,.85)'; roundRect(ctx, x - w / 2, top - 30 + bob, w, 22, 11); ctx.fill();
        ctx.strokeStyle = 'rgba(255,214,102,.8)'; ctx.lineWidth = 1.5; ctx.stroke();
        if (!P.touch) { ctx.fillStyle = '#ffd666'; roundRect(ctx, x - w / 2 + 5, top - 26 + bob, 16, 14, 4); ctx.fill(); }
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
        if (!P.touch) { ctx.fillStyle = '#2a1a00'; ctx.fillText('E', x - w / 2 + 13, top - 18.5 + bob); ctx.fillStyle = '#fff'; ctx.fillText(label.slice(1).trim(), x + 8, top - 18.5 + bob); }
        else ctx.fillText(label, x, top - 18.5 + bob);
      } else if (id !== P.talk) {
        ctx.font = '14px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
        ctx.fillText('💬', x + 14 * z, top - 6);
      }
    }
    ctx.restore();
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

  drawBubble(ctx, { a, x, y, below }, placed, now, S) {
    const b = a.bubble;
    if (!this.bubbleSeen.has(b.id)) this.bubbleSeen.set(b.id, now);
    const age = (now - this.bubbleSeen.get(b.id)) / 1000;
    const think = b.kind === 'think';
    let text = b.text;
    // 沉浸模式下对白改由字幕呈现，气泡只留省略号
    const dots = text === '…' || !!S.subtitles;
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
    // 放在头顶；贴近屏幕边缘或被界面挡住时，水平方向夹紧到安全区，头顶放不下就翻到脚下
    const sf = this.safe || { l: 8, t: 8, r: 8, b: 8 };
    const minX = sf.l, maxX = Math.max(minX, this.vw - sf.r - w);
    let bx = Math.max(minX, Math.min(maxX, x - w / 2));
    let flip = y - h - 12 < sf.t && below != null;
    let by = flip ? below + 12 : y - h - 12;
    for (let i = 0; i < 8; i++) {
      const hit = placed.find((p) => bx < p.x + p.w && bx + w > p.x && by < p.y + p.h && by + h > p.y);
      if (!hit) break;
      by = flip ? hit.y + hit.h + 4 : hit.y - h - 4;
      if (!flip && by < sf.t && below != null) { flip = true; by = below + 12; }
    }
    by = Math.max(sf.t, Math.min(this.vh - sf.b - h, by));
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
    const tx = Math.max(bx + 12, Math.min(bx + w - 12, x));
    if (think) {
      const ey = flip ? by - 5 : by + h + 5;
      ctx.beginPath(); ctx.arc(tx - 2, ey, 4, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc((tx + x) / 2 + 1, flip ? ey - 7 : ey + 7, 2.5, 0, 7); ctx.fill(); ctx.stroke();
    } else {
      // 尾巴指向说话的人（翻到脚下时朝上）
      const ey = flip ? by + 1 : by + h - 1, ty = flip ? below - 6 : y - 4;
      ctx.beginPath(); ctx.moveTo(tx - 6, ey); ctx.lineTo(x, ty); ctx.lineTo(tx + 6, ey); ctx.closePath();
      ctx.fillStyle = '#fffdf7'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(tx - 6, flip ? by : by + h); ctx.lineTo(x, ty); ctx.lineTo(tx + 6, flip ? by : by + h); ctx.stroke();
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
}
