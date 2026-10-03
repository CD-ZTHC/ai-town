// 即时战斗的表现（docs/design/combat.md §4）：招式特效（斩击、光束、扇形、冲击波、闪避残影）、命中火花、
// 伤害飘字、血条与读条、状态图标、大招横幅、震屏。数据来自快照里的 fights 与每拍推送的 combat 事件。
import { TS, roundRect } from './util.js';

const STATUS_ICON = { stun: '💫', root: '⛓️', shield: '🛡️', haste: '💨', slow: '🐌', bleed: '🩸', weaken: '🥀', guard: '🧱', dodge: '👻' };
const SKILL_COLOR = { strike: '#ffffff', dodge: '#9fd8ff' };
const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
const ZERO = Object.freeze({ x: 0, y: 0 });

export class CombatLayer {
  /** 服务器推来的一拍：特效、飘字、横幅、震屏，以及打击感（受击闪白、后退、出手前冲、打击停顿）与音效 */
  addCombat(ev) {
    const t = this.time;
    this.cfx ||= []; this.floats ||= [];
    const key = (u) => `${u.kind}:${u.id}`;
    for (const f of ev.fx || []) {
      if (f.skill === 'dodge') { this.cfx.push({ kind: 'dash', from: f.from, to: f.to, born: t, life: 0.35 }); this.sfx?.('dodge', f.to); continue; }
      // 出手前冲：朝目标冲 0.25 格再收回
      if (f.to) this.push(key(f.by), f.to.x - f.from.x, f.to.y - f.from.y, 0.25, 0.18);
      this.sfx?.('swing', f.from);
      const kind = f.skill === 'strike' ? 'slash' : { line: 'beam', cone: 'cone', circle: 'wave' }[f.shape] || 'slash';
      this.cfx.push({ kind, from: f.from, to: f.to || f.from, range: f.range, radius: f.radius, whiff: !!f.whiff, color: this.skillColor(f.skill), born: t, life: kind === 'wave' ? 0.55 : kind === 'beam' ? 0.4 : 0.28 });
    }
    for (const h of ev.hits || []) {
      if (h.dodged) { this.floats.push({ x: h.x, y: h.y, text: '闪避', color: '#9fd8ff', size: 13, born: t }); this.sfx?.('dodge', h); continue; }
      // 受击后退（沿出手的人指向自己的方向；暴击更远）与音效
      const src = h.by && this.unitPos(this.S || {}, h.by.kind, h.by.id);
      if (src) this.push(key(h.to), h.x - src.x, h.y - src.y, h.crit ? 0.35 : 0.18, 0.16);
      this.sfx?.(h.crit ? 'crit' : h.dmg > 0 ? 'hit' : 'shield', h);
      if (h.absorbed) this.sfx?.('shield', h);
      this.cfx.push({ kind: 'spark', from: { x: h.x, y: h.y }, color: h.crit ? '#ffd166' : '#ffffff', born: t, life: 0.25 });
      if (h.dmg > 0) this.floats.push({ x: h.x, y: h.y, text: h.crit ? `${h.dmg}!` : String(h.dmg), color: h.crit ? '#ffd166' : '#ff6b6b', size: h.crit ? 22 : 15, born: t, dx: (Math.random() - 0.5) * 0.6 });
      if (h.absorbed) this.floats.push({ x: h.x, y: h.y - 0.4, text: `🛡️${h.absorbed}`, color: '#bfe3ff', size: 12, born: t });
      this.flashes ||= {};
      this.flashes[`${h.to.kind}:${h.to.id}`] = t;
      const mine = this.myRef && h.to.kind === this.myRef.kind && h.to.id === this.myRef.id;
      if (h.crit || h.dmg >= 15 || mine) this.shake = Math.max(this.shake || 0, h.crit ? 7 : mine ? 5 : 3);
      // 打击停顿：暴击、重击、自己挨打时画面停住一瞬
      if (h.crit || h.dmg >= 15 || mine) this.hitstop(h.crit ? 90 : 60);
    }
    for (const n of ev.notes || []) this.floats.push({ x: n.x, y: n.y - 0.3, text: n.text, color: '#e9d8ff', size: 12, born: t });
    for (const c of ev.casts || []) if (c.windup >= 3) this.banner = { text: `${c.emoji} ${c.name}`, born: t };
    // Boss 进入新阶段：红色横幅 + 震屏
    if (ev.phase) { this.banner = { text: `${ev.phase.emoji} ${ev.phase.text}`, born: t, color: '#ff6b6b' }; this.shake = Math.max(this.shake || 0, 9); this.hitstop(120); this.sfx?.('roar'); }
    if (this.cfx.length > 60) this.cfx.splice(0, this.cfx.length - 60);
    if (this.floats.length > 60) this.floats.splice(0, this.floats.length - 60);
  }

  /** 记一次位移冲量（受击后退、出手前冲）：沿 (dx, dy) 方向推 amp 格，dur 秒内弹回 */
  push(key, dx, dy, amp, dur) {
    const L = Math.hypot(dx, dy);
    if (L < 0.01) return;
    (this.impulses ||= {})[key] = { x: (dx / L) * amp, y: (dy / L) * amp, born: performance.now(), dur: dur * 1000 };
  }

  /** 某个单位此刻的显示偏移（格）：先快后慢地推出去再弹回 */
  offsetOf(key) {
    const m = this.impulses?.[key];
    if (!m) return ZERO;
    const k = (performance.now() - m.born) / m.dur;
    if (k >= 1) { delete this.impulses[key]; return ZERO; }
    const s = Math.sin(Math.PI * Math.min(1, k * 1.3)) * (1 - k * 0.3);
    return { x: m.x * s, y: m.y * s };
  }

  /** 打击停顿：画面停住 ms 毫秒（主循环把这段时间的显示时间记为 0） */
  hitstop(ms) { this.hitstopUntil = Math.max(this.hitstopUntil || 0, performance.now() + ms); }

  /** 受击闪白：这个单位最近 0.12 秒内被打中过 */
  flashing(key) { const f = this.flashes?.[key]; return f != null && this.time - f < 0.12; }

  /** 在刚画好的精灵上叠一层白光（受击闪白）：用加色混合把图像本身再画一遍 */
  flashOver(ctx, draw) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85;
    draw(); draw();
    ctx.restore();
  }

  /** 能力的颜色：取能力 id 的哈希，同一招颜色固定 */
  skillColor(id) {
    if (SKILL_COLOR[id]) return SKILL_COLOR[id];
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 85% 65%)`;
  }

  /** 震屏：返回这一帧的镜头偏移（屏幕像素） */
  shakeOffset(dt) {
    if (!this.shake) return [0, 0];
    this.shake = Math.max(0, this.shake - dt * 30);
    return [(Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake];
  }

  /** 世界坐标里的招式特效（在角色之上、光照之前） */
  drawCombatFx(ctx) {
    const t = this.time;
    this.cfx = (this.cfx || []).filter((f) => t - f.born < f.life);
    if (!this.cfx.length) return;
    const P = (p) => [p.x * TS + TS / 2, p.y * TS + TS / 2 - 8];
    ctx.save();
    ctx.lineCap = 'round';
    for (const f of this.cfx) {
      const k = (t - f.born) / f.life, a = 1 - k;
      const [fx, fy] = P(f.from), [tx, ty] = P(f.to || f.from);
      const ang = Math.atan2(ty - fy, tx - fx);
      const col = f.color || '#fff';
      ctx.globalAlpha = a * (f.whiff ? 0.45 : 1);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      switch (f.kind) {
        case 'slash': {
          // 斩击：在目标身前划一道弧
          const cx = fx + Math.cos(ang) * TS * 0.9, cy = fy + Math.sin(ang) * TS * 0.9;
          ctx.lineWidth = 5 * a + 1;
          ctx.beginPath(); ctx.arc(cx - Math.cos(ang) * 10, cy - Math.sin(ang) * 10, TS * 0.7, ang - 1.1 + k * 0.6, ang + 0.2 + k * 1.2); ctx.stroke();
          break;
        }
        case 'beam': {
          const len = (f.range || 4) * TS, w = Math.max(6, (f.radius || 0.8) * TS * 0.9) * (1 - k * 0.6);
          ctx.save(); ctx.translate(fx, fy); ctx.rotate(ang);
          const g = ctx.createLinearGradient(0, 0, len, 0);
          g.addColorStop(0, col); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g; ctx.fillRect(0, -w / 2, len * Math.min(1, k * 3 + 0.2), w);
          ctx.fillStyle = '#fff'; ctx.globalAlpha = a * 0.8; ctx.fillRect(0, -w / 6, len * Math.min(1, k * 3 + 0.2), w / 3);
          ctx.restore();
          break;
        }
        case 'cone': {
          const R = (f.range || 2) * TS * (0.5 + k * 0.6);
          ctx.beginPath(); ctx.moveTo(fx, fy); ctx.arc(fx, fy, R, ang - Math.PI / 4, ang + Math.PI / 4); ctx.closePath();
          ctx.globalAlpha = a * 0.45; ctx.fill();
          ctx.globalAlpha = a; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(fx, fy, R, ang - Math.PI / 4, ang + Math.PI / 4); ctx.stroke();
          break;
        }
        case 'wave': {
          const R = Math.max(1, f.radius || 2) * TS * (0.3 + k * 0.9);
          for (let i = 0; i < 2; i++) {
            ctx.lineWidth = (6 - i * 3) * a + 1;
            ctx.beginPath(); ctx.ellipse(fx, fy + 10, R * (1 - i * 0.25), R * 0.5 * (1 - i * 0.25), 0, 0, 7); ctx.stroke();
          }
          ctx.globalAlpha = a * 0.15; ctx.beginPath(); ctx.ellipse(fx, fy + 10, R, R * 0.5, 0, 0, 7); ctx.fill();
          break;
        }
        case 'dash': {
          // 闪避：几道残影
          for (let i = 0; i < 4; i++) {
            const q = i / 4;
            ctx.globalAlpha = a * (0.15 + q * 0.25);
            ctx.beginPath(); ctx.arc(fx + (tx - fx) * q, fy + (ty - fy) * q, 9, 0, 7); ctx.fill();
          }
          break;
        }
        case 'spark': {
          for (let i = 0; i < 8; i++) {
            const an = (i / 8) * Math.PI * 2 + f.born * 7;
            const r = 6 + k * 18;
            ctx.fillRect(fx + Math.cos(an) * r - 1.5, fy + Math.sin(an) * r - 1.5, 3, 3);
          }
          ctx.globalAlpha = a * 0.6; ctx.beginPath(); ctx.arc(fx, fy, 10 * (1 - k), 0, 7); ctx.fill();
          break;
        }
      }
    }
    ctx.restore();
  }

  /** 世界长出了新地方（创世、扩展地图、新区域）：全屏闪光，再从中间展开一行字 */
  revealRegion(text) { this.reveal = { text, born: this.time }; this.shake = Math.max(this.shake || 0, 10); this.sfx?.('chime'); }

  drawReveal(ctx) {
    const r = this.reveal;
    if (!r) return;
    const k = (this.time - r.born) / 3.5;
    if (k >= 1) { this.reveal = null; return; }
    ctx.save();
    // 闪光：从中间向外推开
    const R = Math.hypot(this.vw, this.vh) * Math.min(1, k * 2.5);
    const g = ctx.createRadialGradient(this.vw / 2, this.vh / 2, R * 0.6, this.vw / 2, this.vh / 2, R);
    g.addColorStop(0, 'rgba(255,240,200,0)'); g.addColorStop(0.85, `rgba(255,230,170,${0.55 * (1 - k)})`); g.addColorStop(1, 'rgba(255,230,170,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, this.vw, this.vh);
    if (k < 0.12) { ctx.fillStyle = `rgba(255,250,235,${(0.12 - k) * 6})`; ctx.fillRect(0, 0, this.vw, this.vh); }
    // 文字：横向展开
    const a = k < 0.15 ? k / 0.15 : k > 0.8 ? (1 - k) / 0.2 : 1;
    const y = this.vh * 0.38;
    ctx.globalAlpha = a;
    const w = Math.min(this.vw * 0.9, 760) * Math.min(1, k * 5);
    const bg = ctx.createLinearGradient(this.vw / 2 - w / 2, 0, this.vw / 2 + w / 2, 0);
    bg.addColorStop(0, 'rgba(20,12,30,0)'); bg.addColorStop(0.5, 'rgba(20,12,30,.8)'); bg.addColorStop(1, 'rgba(20,12,30,0)');
    ctx.fillStyle = bg; ctx.fillRect(this.vw / 2 - w / 2, y - 34, w, 68);
    ctx.font = `800 ${this.vw < 600 ? 18 : 24}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe7a8'; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 4;
    ctx.strokeText(r.text, this.vw / 2, y); ctx.fillText(r.text, this.vw / 2, y);
    ctx.restore();
  }

  /** 战斗单位此刻画在哪里（格，平滑过的位置） */
  unitPos(S, kind, id) {
    const p = kind === 'agent' ? S.agentMap?.[id]
      : kind === 'avatar' ? (S.avatars || []).find((v) => v.id === id)
      : kind === 'threat' ? (S.dark?.threats || []).find((x) => x.id === id)
      : (S.creatures || []).find((c) => c.id === id);
    if (!p || p.inside) return null;
    return { x: p.dx ?? p.x, y: p.dy ?? p.y };
  }

  /** 屏幕坐标：血条、读条、状态、飘字、横幅 */
  drawCombatOverlay(ctx, S, ox, oy, z) {
    const t = this.time;
    const toS = (wx, wy) => [wx * z + ox, wy * z + oy];
    const myId = S.play?.me;
    this.myRef = myId ? { kind: 'avatar', id: myId } : null;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const F of S.fights || []) {
      const mySide = F.fighters.find((f) => f.kind === 'avatar' && f.id === myId)?.side;
      for (const f of F.fighters) {
        const p = this.unitPos(S, f.kind, f.id);
        if (!p) continue;
        // 化身头顶有名牌：血条放在名牌上面
        const [x, y] = toS(p.x * TS + TS / 2, p.y * TS - TS * (f.kind === 'avatar' ? 1.75 : 1.1));
        const w = 40, h = 5;
        const friend = mySide == null ? f.side === 0 : f.side === mySide;
        const ratio = Math.max(0, Math.min(1, f.hp / (f.maxHp || 100)));
        // 受击闪白
        const fl = this.flashes?.[`${f.kind}:${f.id}`];
        const flash = fl != null && t - fl < 0.15;
        ctx.fillStyle = 'rgba(10,10,20,.7)'; roundRect(ctx, x - w / 2 - 1.5, y - h / 2 - 1.5, w + 3, h + 3, 3); ctx.fill();
        ctx.fillStyle = flash ? '#fff' : friend ? (ratio > 0.3 ? '#5bd17a' : '#f0b44a') : '#ff5a5a';
        roundRect(ctx, x - w / 2, y - h / 2, w * ratio, h, 2); ctx.fill();
        // 读条（蓄力中）：大招用金色，并在头顶写招式名
        if (f.act?.phase === 'windup') {
          ctx.fillStyle = 'rgba(10,10,20,.7)'; roundRect(ctx, x - w / 2 - 1, y + 5, w + 2, 4, 2); ctx.fill();
          ctx.fillStyle = f.act.big ? '#ffd166' : '#bfe3ff'; roundRect(ctx, x - w / 2, y + 5.5, w * Math.min(1, f.act.p), 3, 1.5); ctx.fill();
          if (f.act.skill !== 'strike') {
            ctx.font = `600 ${f.act.big ? 13 : 11}px ${FONT}`;
            ctx.fillStyle = f.act.big ? '#ffd166' : '#fff';
            ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 3;
            const label = `${f.act.emoji} ${f.act.name}`;
            ctx.strokeText(label, x, y - 11); ctx.fillText(label, x, y - 11);
          }
        }
        if (f.st?.length) {
          ctx.font = `11px "Apple Color Emoji","Segoe UI Emoji",sans-serif`;
          f.st.slice(0, 4).forEach((s, i) => ctx.fillText(STATUS_ICON[s] || '•', x + w / 2 + 8 + i * 12, y));
        }
      }
    }
    // 伤害飘字
    this.floats = (this.floats || []).filter((f) => t - f.born < 1.1);
    for (const f of this.floats) {
      const k = (t - f.born) / 1.1;
      const [x, y] = toS((f.x + (f.dx || 0) * k) * TS + TS / 2, f.y * TS - TS * 0.2);
      const pop = k < 0.12 ? 1 + (0.12 - k) * 4 : 1;
      ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      ctx.font = `800 ${Math.round(f.size * pop)}px ${FONT}`;
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(20,10,20,.85)';
      ctx.strokeText(f.text, x, y - k * 34); ctx.fillStyle = f.color; ctx.fillText(f.text, x, y - k * 34);
    }
    ctx.globalAlpha = 1;
    // 大招横幅
    if (this.banner && t - this.banner.born < 1.3) {
      const k = (t - this.banner.born) / 1.3;
      const a = k < 0.15 ? k / 0.15 : k > 0.75 ? (1 - k) / 0.25 : 1;
      ctx.globalAlpha = a;
      const y = this.vh * 0.22;
      const g = ctx.createLinearGradient(0, 0, this.vw, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(20,10,30,.75)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, y - 26, this.vw, 52);
      ctx.font = `900 ${Math.round(28 + (1 - Math.min(1, k * 6)) * 10)}px ${FONT}`;
      ctx.fillStyle = this.banner.color || '#ffd166'; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 4;
      ctx.strokeText(this.banner.text, this.vw / 2, y); ctx.fillText(this.banner.text, this.vw / 2, y);
      ctx.globalAlpha = 1;
    }
    this.drawReveal(ctx);
    ctx.restore();
  }
}
