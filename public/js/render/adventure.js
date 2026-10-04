// 冒险的画面（docs/design/adventure.md §4）：像素怪物、武器与出招姿势、敌我光圈与目标线、回复点、
// 升级光柱、掉落弧线、经验飘字、休整时的回血粒子、倒下消散、危险暗角，以及洞窟 / 城堡 / 火山等地貌的氛围。
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。数据来自快照的 adv 字段与 adv 事件。
import { TS, SCALE, roundRect } from './util.js';
import { buildMonster, MON_W, MON_H, MONSTER_PLANS } from '../monsters.js';

const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
const AURA = { fire: ['255,120,40', '255,210,90'], frost: ['150,210,255', '235,250,255'], smoke: ['110,100,92', '170,160,150'], shadow: ['80,30,140', '150,100,235'], holy: ['255,236,160', '255,255,230'] };
/** 地貌的氛围：天色（暗度、色调）、默认粒子 */
const BIOME = {
  cave: { dark: 0.8, particles: 'motes' }, castle: { dark: 0.48, tint: '40,16,70', particles: 'fog' }, volcano: { dark: 0.28, tint: '120,30,10', particles: 'embers' },
  ruins: { particles: 'sand' }, desert: { particles: 'sand' }, dark_forest: { dark: 0.18, particles: 'leaves' }, snow: { particles: 'snow' }, chaos: {}, sky: {},
};
const PARTICLE_STYLE = {
  motes: { n: 26, col: '255,250,210', size: [1, 2], vy: [-6, -2], vx: [-3, 3], a: 0.5 },
  leaves: { n: 22, col: '120,170,80', size: [2, 3], vy: [8, 16], vx: [6, 14], a: 0.7 },
  embers: { n: 34, col: '255,140,50', size: [1, 2.5], vy: [-30, -14], vx: [-6, 6], a: 0.85, glow: true },
  sand: { n: 60, col: '230,205,150', size: [1, 2], vy: [-2, 4], vx: [40, 80], a: 0.45 },
  snow: { n: 50, col: '255,255,255', size: [1, 2.5], vy: [14, 26], vx: [-6, 6], a: 0.8 },
  fog: { n: 10, col: '150,120,200', size: [60, 120], vy: [-2, 2], vx: [4, 10], a: 0.06, blob: true },
};
const WEAPON_LEN = { sword: 13, axe: 11, staff: 18, bow: 12, spear: 20, dagger: 7, hammer: 12 };
const rnd = (a, b) => a + Math.random() * (b - a);

export class AdventureLayer {
  // ---------- 怪物 ----------
  /** 威胁的像素精灵（按类型 + 外观缓存） */
  monsterSprites(key, look) {
    const c = (this.monCache ||= {});
    const k = JSON.stringify(look);
    if (c[key]?.k !== k) c[key] = { k, spr: buildMonster(look) };
    return c[key].spr;
  }

  /** 这个单位面朝哪边：位置变化决定；战斗中朝着目标 */
  facing(key, x, y, S) {
    const m = ((this.faceMem ||= {})[key] ||= { x, y, dir: 'down' });
    const F = (S.fights || []).find((q) => q.fighters.some((f) => `${f.kind}:${f.id}` === key));
    const me = F?.fighters.find((f) => `${f.kind}:${f.id}` === key);
    const tg = me?.tg && this.unitPos(S, ...me.tg.split(':'));
    const dx = tg ? tg.x - x : x - m.x, dy = tg ? tg.y - y : y - m.y;
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) m.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    m.x = x; m.y = y;
    return m.dir;
  }

  /** 按外观画一个像素怪物：脚下阴影、Boss 的威压光环、光环粒子、呼吸起伏、走路 / 出手的帧、受击闪白、血条 */
  drawMonster(ctx, th, look, S) {
    const spr = this.monsterSprites(`t:${th.type}`, look);
    const key = `threat:${th.id}`;
    const dir = this.facing(key, th.dx, th.dy, S);
    const sc = SCALE * (look.scale || 1);
    const W = MON_W * sc, H = MON_H * sc;
    const X = th.dx * TS + TS / 2, fy = th.dy * TS + TS - 2, t = this.time;
    const boss = Boolean(th.boss) || (look.scale || 1) >= 2;
    const pose = this.poses?.[key];
    const attacking = pose && t - pose.born < 0.35;
    const fi = attacking ? 3 : this.isMoving(key, th) ? [1, 0, 2, 0][Math.floor(t * 6) % 4] : 0;
    const breathe = 1 + Math.sin(t * 2.2 + th.dx) * (boss ? 0.035 : 0.02);
    ctx.save();
    if (boss) {
      const g = ctx.createRadialGradient(X, fy, 4, X, fy, W * 0.7);
      g.addColorStop(0, 'rgba(120,20,40,.35)'); g.addColorStop(1, 'rgba(120,20,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(X, fy, W * 0.7, W * 0.25, 0, 0, 7); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath(); ctx.ellipse(X, fy, W * 0.34, Math.max(4, W * 0.1), 0, 0, 7); ctx.fill();
    this.drawAura(ctx, look.aura, X, fy - H * 0.45, W, H, 'back');
    const img = spr[dir]?.[fi] || spr.down[0];
    const h = H * breathe;
    const draw = () => ctx.drawImage(img, Math.round(X - W / 2), Math.round(fy - h + 2 * sc), Math.round(W), Math.round(h));
    draw();
    if (this.flashing(key)) this.flashOver(ctx, draw);
    this.drawAura(ctx, look.aura, X, fy - H * 0.45, W, H, 'front');
    if (th.maxHp && !S.fightKeys?.has(key)) {
      const w = Math.max(26, W * 0.5), p = Math.max(0, th.hp / th.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(X - w / 2, fy - h - 4, w, 4);
      ctx.fillStyle = '#e04848'; ctx.fillRect(X - w / 2, fy - h - 4, w * p, 4);
    }
    ctx.restore();
    (this.monSeen ||= {})[th.id] = { X, fy, W, H, at: t, hp: th.hp, maxHp: th.maxHp, pal: spr.palette, boss, region: S.region };
  }

  /** 这一帧它在不在走：和上一帧比位置 */
  isMoving(key, p) {
    const m = ((this.moveMem ||= {})[key] ||= { x: p.dx, y: p.dy, until: 0 });
    if (Math.hypot(p.dx - m.x, p.dy - m.y) > 0.004) m.until = this.time + 0.15;
    m.x = p.dx; m.y = p.dy;
    return this.time < m.until;
  }

  /** 光环：火焰往上飘、冰霜闪点、烟、暗影、圣光（back 在身后画光晕，front 画粒子） */
  drawAura(ctx, aura, X, Y, W, H, layer) {
    const c = AURA[aura];
    if (!c) return;
    const t = this.time;
    ctx.save();
    if (layer === 'back') {
      const g = ctx.createRadialGradient(X, Y, 2, X, Y, Math.max(W, H) * 0.65);
      g.addColorStop(0, `rgba(${c[0]},${aura === 'shadow' || aura === 'smoke' ? 0.45 : 0.32})`); g.addColorStop(1, `rgba(${c[0]},0)`);
      ctx.fillStyle = g; ctx.fillRect(X - W, Y - H, W * 2, H * 2);
    } else {
      ctx.globalCompositeOperation = aura === 'shadow' || aura === 'smoke' ? 'source-over' : 'lighter';
      for (let i = 0; i < 10; i++) {
        const ph = (t * (aura === 'fire' ? 0.9 : 0.4) + i / 10) % 1;
        const ox = Math.sin(i * 12.9 + t * 1.3) * W * 0.32;
        const y = Y + H * 0.4 - ph * H * (aura === 'fire' ? 1.1 : 0.8);
        ctx.globalAlpha = (1 - ph) * (aura === 'smoke' ? 0.35 : 0.8);
        ctx.fillStyle = `rgb(${i % 2 ? c[0] : c[1]})`;
        const s = aura === 'smoke' || aura === 'shadow' ? 4 + ph * 6 : 2 + (1 - ph) * 2;
        ctx.fillRect(X + ox - s / 2, y - s / 2, s, s);
      }
    }
    ctx.restore();
  }

  /** 威胁从画面上消失时：之前血不多，就碎成像素粒子消散（Boss 更大、带金光） */
  monsterDissolve(S) {
    const seen = this.monSeen || {};
    const now = this.time;
    const live = new Set((S.dark?.threats || []).map((x) => x.id));
    for (const [id, m] of Object.entries(seen)) {
      if (live.has(id)) continue;
      delete seen[id];
      if (now - m.at > 0.6 || m.region !== S.region || !m.maxHp || m.hp / m.maxHp > 0.4) continue;
      const n = m.boss ? 70 : 26;
      const cols = [m.pal?.body || '#888', m.pal?.accent || '#ccc', '#ffffff'];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = rnd(30, m.boss ? 160 : 90);
        (this.bursts ||= []).push({ x: m.X + rnd(-m.W, m.W) * 0.25, y: m.fy - m.H * rnd(0.2, 0.8), vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: rnd(0.5, m.boss ? 1.6 : 0.9), born: now, col: cols[i % 3], s: rnd(2, m.boss ? 5 : 3.5) });
      }
      if (m.boss) { this.pillars = [...(this.pillars || []), { x: m.X, y: m.fy, born: now, life: 1.6, col: '255,230,150', w: m.W * 0.5 }]; this.shake = Math.max(this.shake || 0, 10); }
      this.sfx?.(m.boss ? 'chime' : 'poof', { x: m.X / TS, y: m.fy / TS });
    }
  }

  // ---------- 武器与出招姿势（§4.2） ----------
  /** 记一个姿势：charge 蓄力（武器举起来）、slash 挥砍、thrust 直刺、spin 回旋、cast 施法、guard 举盾 */
  notePose(key, kind) { (this.poses ||= {})[key] = { kind, born: this.time }; }

  /** 招式的姿势：按形状（直线刺、扇形 / 单体劈、圆形回旋），自己用的招（治疗、护身）是施法 */
  poseOf(f) {
    const ab = this.abilityOf?.(f.skill);
    if (ab?.target === 'self') return 'cast';
    if (f.skill === 'strike') return 'slash';
    return f.shape === 'circle' ? (ab && /heal|治|光/.test(ab.name) ? 'cast' : 'spin') : f.shape === 'line' || f.shape === 'projectile' ? 'thrust' : 'slash';
  }

  /** 画手里的武器与盾（在角色精灵之后画；朝上时武器在身后，由调用方先画） */
  drawGear(ctx, key, X, fy, dir, wp, sh) {
    if (!wp && !sh) return;
    const t = this.time;
    const pose = this.poses?.[key];
    const age = pose ? t - pose.born : 9;
    const kind = age < (pose?.kind === 'charge' ? 1.5 : 0.4) ? pose.kind : 'idle';
    const k = Math.min(1, age / 0.28);
    const side = dir === 'left' ? -1 : 1;
    const hand = { x: X + (dir === 'up' ? -9 : dir === 'down' ? 9 : 6 * side), y: fy - 20 };
    ctx.save();
    if (sh) {
      const front = kind === 'guard' || dir === 'down';
      const sx = kind === 'guard' ? X + (dir === 'left' ? -8 : dir === 'right' ? 8 : 0) : X + (dir === 'right' ? -7 : dir === 'left' ? 7 : -9);
      ctx.fillStyle = sh.c || '#8a5a3a'; ctx.strokeStyle = 'rgba(20,14,10,.9)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(sx, fy - 16, front ? 6 : 4, 7, 0, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(sx - 1, fy - 20, 2, 7);
    }
    if (wp) {
      const len = WEAPON_LEN[wp.w] || 12;
      // 角度：0 指向右；平时斜举，挥砍时扫过一道弧，蓄力时高举
      let ang = dir === 'left' ? -Math.PI + 0.75 : dir === 'right' ? -0.75 : dir === 'up' ? -1.9 : -1.2;
      let ox = 0, oy = 0;
      if (kind === 'slash') ang = (dir === 'left' ? -Math.PI : 0) + side * (-2.1 + k * 2.6);
      else if (kind === 'charge') ang = (dir === 'left' ? -Math.PI + 1.9 : -1.9) + Math.sin(t * 40) * 0.05;
      else if (kind === 'thrust') { ang = dir === 'left' ? Math.PI : dir === 'right' ? 0 : dir === 'up' ? -Math.PI / 2 : Math.PI / 2; ox = Math.cos(ang) * 6 * Math.sin(k * Math.PI); oy = Math.sin(ang) * 6 * Math.sin(k * Math.PI); }
      else if (kind === 'spin') ang = k * Math.PI * 2 - Math.PI / 2;
      else if (kind === 'cast') { ang = -Math.PI / 2; oy = -3 * Math.sin(k * Math.PI); }
      else ang += Math.sin(t * 2 + X) * 0.04;
      ctx.translate(hand.x + ox, hand.y + oy);
      ctx.rotate(ang);
      this.drawWeaponShape(ctx, wp, len, kind === 'cast' || kind === 'charge');
      ctx.rotate(-ang);
      // 挥砍的残影弧
      if (kind === 'slash' || kind === 'spin') {
        ctx.globalAlpha = (1 - k) * 0.55;
        ctx.strokeStyle = wp.g || '#ffffff'; ctx.lineWidth = 3;
        const a0 = kind === 'spin' ? -Math.PI / 2 : (dir === 'left' ? -Math.PI : 0) + side * -2.1;
        ctx.beginPath(); ctx.arc(0, 0, len + 2, Math.min(a0, ang), Math.max(a0, ang)); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 武器的形状（局部坐标：握柄在原点，沿 x 轴伸出去） */
  drawWeaponShape(ctx, wp, len, glowing) {
    const c = wp.c || '#c0c8d0', dark = 'rgba(25,18,14,.95)';
    ctx.fillStyle = dark;
    switch (wp.w) {
      case 'axe': ctx.fillRect(-1, -1, len, 2); ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(len - 4, -1); ctx.lineTo(len + 1, -6); ctx.lineTo(len + 2, 4); ctx.lineTo(len - 4, 1); ctx.fill(); break;
      case 'hammer': ctx.fillRect(-1, -1, len, 2); ctx.fillStyle = c; ctx.fillRect(len - 3, -4, 5, 8); break;
      case 'staff': ctx.fillStyle = c; ctx.fillRect(-2, -1, len, 2); ctx.fillStyle = wp.g || '#fff6c8'; ctx.beginPath(); ctx.arc(len, 0, glowing ? 3.5 : 2.5, 0, 7); ctx.fill(); break;
      case 'spear': ctx.fillStyle = '#7a5a3a'; ctx.fillRect(-4, -1, len, 2); ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(len - 4, -2.5); ctx.lineTo(len + 3, 0); ctx.lineTo(len - 4, 2.5); ctx.fill(); break;
      case 'bow': ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, len * 0.6, -1.2, 1.2); ctx.stroke(); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(Math.cos(-1.2) * len * 0.6, Math.sin(-1.2) * len * 0.6); ctx.lineTo(Math.cos(1.2) * len * 0.6, Math.sin(1.2) * len * 0.6); ctx.stroke(); break;
      default: { // sword / dagger
        ctx.fillRect(-1, -3, 2, 6); // 护手
        ctx.fillStyle = '#5a3a22'; ctx.fillRect(-4, -1, 4, 2); // 握柄
        ctx.fillStyle = c; ctx.fillRect(1, -1.5, len, 3);
        ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(1, -1.5, len, 1);
        ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(len + 1, -1.5); ctx.lineTo(len + 4, 0); ctx.lineTo(len + 1, 1.5); ctx.fill();
      }
    }
    if (wp.g) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.35 + Math.sin(this.time * 4) * 0.15 + (glowing ? 0.3 : 0);
      const g = ctx.createRadialGradient(len * 0.6, 0, 1, len * 0.6, 0, len * 0.9);
      g.addColorStop(0, wp.g); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = pulse; ctx.fillStyle = g; ctx.fillRect(-4, -len, len * 2, len * 2);
      ctx.restore();
    }
  }

  // ---------- 地面：回复点、敌我光圈、目标线（在角色之下） ----------
  drawAdventureGround(ctx, S) {
    const t = this.time;
    // 回复点：户外的营地是一堆篝火，室内的（教会、旅店）门口一圈暖光
    for (const id of S.adv?.rests || []) {
      const l = this.world.locations?.[id];
      if (!l?.rect) continue;
      const b = l.indoor && this.world.buildings?.find((x) => x.id === l.indoor);
      const cx = b ? (b.entrance.x + 0.5) * TS : (l.rect.x + l.rect.w / 2) * TS, cy = b ? (b.entrance.y + 0.9) * TS : (l.rect.y + l.rect.h / 2) * TS;
      if (cx < this.view.x0 - 200 || cx > this.view.x1 + 200 || cy < this.view.y0 - 200 || cy > this.view.y1 + 200) continue;
      const fl = 0.85 + Math.sin(t * 9 + cx) * 0.08 + Math.random() * 0.05;
      const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, TS * (b ? 2.2 : 3));
      g.addColorStop(0, `rgba(255,200,110,${0.32 * fl})`); g.addColorStop(1, 'rgba(255,200,110,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(cx, cy, TS * (b ? 2.2 : 3), TS * (b ? 1.3 : 1.8), 0, 0, 7); ctx.fill();
      if (!b) {
        // 篝火：几根木柴 + 跳动的火苗
        ctx.fillStyle = '#5a3a22'; ctx.fillRect(cx - 9, cy + 2, 18, 3); ctx.fillRect(cx - 7, cy - 1, 14, 3);
        for (let i = 0; i < 3; i++) {
          const h = (10 + Math.sin(t * 11 + i * 2) * 3) * fl;
          ctx.fillStyle = ['#ff6a2a', '#ffb43a', '#fff0a0'][i];
          ctx.beginPath(); ctx.moveTo(cx - 6 + i * 2, cy); ctx.quadraticCurveTo(cx + Math.sin(t * 7 + i) * 2, cy - h * 1.6 + i * 3, cx + 6 - i * 2, cy); ctx.fill();
        }
      }
    }
    // 敌我光圈：以焦点（自己的化身 / 跟随的人 / 焦点角色）所在的一方为「我方」
    const focus = S.focusKey;
    for (const F of S.fights || []) {
      const mine = F.fighters.find((f) => `${f.kind}:${f.id}` === focus)?.side ?? F.fighters.find((f) => f.kind === 'agent' && S.adv?.party?.has(f.id))?.side ?? 0;
      for (const f of F.fighters) {
        const p = this.unitPos(S, f.kind, f.id);
        if (!p) continue;
        const ally = f.side === mine;
        const X = p.x * TS + TS / 2, Y = p.y * TS + TS - 2;
        const r = f.kind === 'threat' ? Math.max(12, (S.lookOf?.(f.id)?.scale || 1) * 13) : 12;
        ctx.save();
        ctx.strokeStyle = ally ? 'rgba(110,190,255,.85)' : 'rgba(255,90,90,.85)'; ctx.lineWidth = 2;
        ctx.setLineDash(ally ? [] : [4, 3]); ctx.lineDashOffset = -t * 10;
        ctx.beginPath(); ctx.ellipse(X, Y, r, r * 0.38, 0, 0, 7); ctx.stroke();
        ctx.restore();
        // 目标线：蓄力中的单位指向它的目标
        if (f.act?.phase === 'windup' && f.tg) {
          const q = this.unitPos(S, ...f.tg.split(':'));
          if (!q) continue;
          ctx.save();
          ctx.globalAlpha = 0.55; ctx.strokeStyle = ally ? '#6ebeff' : '#ff5a5a'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]); ctx.lineDashOffset = -t * 20;
          ctx.beginPath(); ctx.moveTo(X, Y - 10); ctx.lineTo(q.x * TS + TS / 2, q.y * TS + TS / 2 - 6); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

  // ---------- 世界层特效（在角色之上） ----------
  drawAdventureFx(ctx, S, dt) {
    const t = this.time;
    // 休整中的人：绿色的光点往上飘
    for (const a of S.agents) {
      if (!a.rest || a.inside || a.hp == null) continue;
      const X = a.dx * TS + TS / 2, Y = a.dy * TS;
      for (let i = 0; i < 4; i++) {
        const ph = (t * 0.6 + i / 4 + a.dx) % 1;
        ctx.globalAlpha = (1 - ph) * 0.8; ctx.fillStyle = i % 2 ? '#7be08a' : '#c8ffd0';
        ctx.fillRect(X + Math.sin(i * 3 + t * 2) * 9, Y + 6 - ph * 26, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    // 升级 / Boss 倒下的光柱
    this.pillars = (this.pillars || []).filter((p) => t - p.born < p.life);
    for (const p of this.pillars) {
      const k = (t - p.born) / p.life, a = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const w = (p.w || 18) * (1 + k * 0.4), h = 160 + k * 60;
      const g = ctx.createLinearGradient(0, p.y - h, 0, p.y);
      g.addColorStop(0, `rgba(${p.col},0)`); g.addColorStop(0.7, `rgba(${p.col},${0.55 * a})`); g.addColorStop(1, `rgba(${p.col},${0.85 * a})`);
      ctx.fillStyle = g; ctx.fillRect(p.x - w / 2, p.y - h, w, h);
      ctx.globalAlpha = a;
      ctx.strokeStyle = `rgb(${p.col})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, w * (0.8 + k), w * 0.35 * (0.8 + k), 0, 0, 7); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const ph = (k * 1.6 + i / 8) % 1;
        ctx.fillStyle = `rgb(${p.col})`;
        ctx.fillRect(p.x + Math.sin(i * 2.3 + t * 3) * w * 0.8, p.y - ph * h, 3, 3);
      }
      ctx.restore();
    }
    // 掉落：图标从倒下的位置弹起，沿弧线飞向拾取的人
    this.loots = (this.loots || []).filter((l) => t - l.born < l.life);
    for (const l of this.loots) {
      const k = (t - l.born) / l.life;
      const to = this.unitPos(S, l.to.kind, l.to.id) || l.from;
      const x = (l.from.x + (to.x - l.from.x) * k) * TS + TS / 2;
      const y = (l.from.y + (to.y - l.from.y) * k) * TS + TS / 2 - Math.sin(k * Math.PI) * 46 - 8;
      ctx.save();
      ctx.font = '16px "Apple Color Emoji","Segoe UI Emoji",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
      const gl = ctx.createRadialGradient(x, y, 1, x, y, 14);
      gl.addColorStop(0, 'rgba(255,240,170,.7)'); gl.addColorStop(1, 'rgba(255,240,170,0)');
      ctx.fillStyle = gl; ctx.fillRect(x - 14, y - 14, 28, 28);
      ctx.fillText(l.emoji, x, y);
      ctx.restore();
    }
    // 倒下消散的像素粒子
    this.bursts = (this.bursts || []).filter((b) => t - b.born < b.life);
    for (const b of this.bursts) {
      const k = (t - b.born) / b.life;
      b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 120 * dt; b.vx *= 0.98;
      ctx.globalAlpha = 1 - k; ctx.fillStyle = b.col;
      ctx.fillRect(b.x - b.s / 2, b.y - b.s / 2, b.s, b.s);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- 屏幕层（光照之后）：地貌氛围、色调、危险暗角 ----------
  drawAdventureScreen(ctx, S, dt) {
    const info = S.regionInfo || {};
    const biome = BIOME[info.biome] || {};
    const amb = info.ambience || {};
    // 色调
    const tint = amb.tint ? `${parseInt(amb.tint.slice(1, 3), 16)},${parseInt(amb.tint.slice(3, 5), 16)},${parseInt(amb.tint.slice(5, 7), 16)}` : biome.tint;
    if (tint) {
      ctx.save(); ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(${tint},${amb.tintAlpha ?? 0.25})`; ctx.fillRect(0, 0, this.vw, this.vh);
      ctx.restore();
    }
    // 粒子
    const kind = amb.particles || biome.particles;
    const st = PARTICLE_STYLE[kind];
    const P = (this.ambP ||= { kind: null, list: [] });
    if (P.kind !== kind) { P.kind = kind; P.list = []; }
    if (st) {
      while (P.list.length < st.n) P.list.push({ x: Math.random() * this.vw, y: Math.random() * this.vh, vx: rnd(...st.vx), vy: rnd(...st.vy), s: rnd(...st.size), ph: Math.random() * 6 });
      ctx.save();
      if (st.glow) ctx.globalCompositeOperation = 'lighter';
      for (const p of P.list) {
        p.x += (p.vx + Math.sin(this.time + p.ph) * 4) * dt; p.y += p.vy * dt;
        if (p.x > this.vw + 130) p.x = -120; if (p.x < -130) p.x = this.vw + 120;
        if (p.y > this.vh + 130) p.y = -120; if (p.y < -130) p.y = this.vh + 120;
        const a = st.a * (0.6 + Math.sin(this.time * 2 + p.ph) * 0.4);
        if (st.blob) {
          const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.s);
          g.addColorStop(0, `rgba(${st.col},${a})`); g.addColorStop(1, `rgba(${st.col},0)`);
          ctx.fillStyle = g; ctx.fillRect(p.x - p.s, p.y - p.s, p.s * 2, p.s * 2);
        } else { ctx.fillStyle = `rgba(${st.col},${a})`; ctx.fillRect(p.x, p.y, p.s, p.s); }
      }
      ctx.restore();
    }
    // 火山：画面下方一层暗红的热浪
    if (info.biome === 'volcano') {
      const g = ctx.createLinearGradient(0, this.vh * 0.55, 0, this.vh);
      g.addColorStop(0, 'rgba(255,80,20,0)'); g.addColorStop(1, `rgba(255,80,20,${0.12 + Math.sin(this.time * 1.3) * 0.04})`);
      ctx.fillStyle = g; ctx.fillRect(0, this.vh * 0.55, this.vw, this.vh * 0.45);
    }
    // 危险暗角：焦点的人血量低于 30% 时，屏幕边缘一圈红色随心跳闪动
    const r = S.focusHp;
    if (r != null && r < 0.3) {
      const beat = Math.pow(Math.max(0, Math.sin(this.time * 5.2)), 6);
      const a = (0.25 + (0.3 - r) * 1.2) * (0.6 + beat * 0.4);
      const g = ctx.createRadialGradient(this.vw / 2, this.vh / 2, Math.min(this.vw, this.vh) * 0.35, this.vw / 2, this.vh / 2, Math.hypot(this.vw, this.vh) * 0.62);
      g.addColorStop(0, 'rgba(160,0,10,0)'); g.addColorStop(1, `rgba(170,0,12,${Math.min(0.7, a)})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, this.vw, this.vh);
      if (this.time - (this.heartAt || 0) > 1.2) { this.heartAt = this.time; this.sfx?.('heart'); }
    }
  }

  /** 地貌决定的天色：洞窟整张地图很暗（只有人和火光周围亮），城堡偏暗 */
  biomeSky(sky, S) {
    const b = BIOME[S.regionInfo?.biome];
    if (!b?.dark) return sky;
    return { ...sky, dark: Math.max(sky.dark, b.dark), night: true };
  }

  /** 冒险额外的光源：回复点的火光、旅人、发光的怪物（暗的地貌里才有意义） */
  adventureLights(S) {
    const out = [];
    for (const id of S.adv?.rests || []) {
      const l = this.world.locations?.[id];
      if (!l?.rect) continue;
      const b = l.indoor && this.world.buildings?.find((x) => x.id === l.indoor);
      out.push({ x: b ? (b.entrance.x + 0.5) * TS : (l.rect.x + l.rect.w / 2) * TS, y: b ? (b.entrance.y + 0.5) * TS : (l.rect.y + l.rect.h / 2) * TS, r: 150, i: 0.95, c: '255,170,80' });
    }
    for (const v of S.avatars || []) out.push({ x: v.dx * TS + 16, y: v.dy * TS + 10, r: 70, i: 0.75, c: '255,210,140' });
    for (const th of S.dark?.threats || []) {
      const lk = S.lookOf?.(th.id);
      if (lk?.aura && lk.aura !== 'smoke' && lk.aura !== 'shadow') out.push({ x: th.dx * TS + 16, y: th.dy * TS, r: 60 * (lk.scale || 1), i: 0.7, c: AURA[lk.aura][0] });
    }
    return out;
  }

  // ---------- 事件 ----------
  /** 服务器推来的冒险事件：升级光柱、经验飘字、掉落弧线、撤退 / 倒下 / 醒来的提示 */
  onAdv(ev, S) {
    const t = this.time;
    const at = (u) => (u ? this.unitPos(S, u.kind, u.id) : null);
    this.floats ||= [];
    if (ev.type === 'levelup') {
      const p = at(ev.unit);
      if (p) {
        this.pillars = [...(this.pillars || []), { x: p.x * TS + TS / 2, y: p.y * TS + TS - 2, born: t, life: 1.8, col: '255,214,102', w: 22 }];
        this.floats.push({ x: p.x, y: p.y - 0.6, text: `LEVEL UP · Lv ${ev.level}`, color: '#ffd166', size: 18, born: t });
      }
      this.sfx?.('levelup', p);
    }
    if (ev.type === 'exp') for (const g of ev.gained || []) {
      const p = at(g);
      if (p) this.floats.push({ x: p.x + 0.3, y: p.y - 0.2, text: `+${g.exp} EXP`, color: '#ffe08a', size: 12, born: t + 0.25, dx: 0.2 });
    }
    if (ev.type === 'loot' && (ev.region || 'town') === S.region) {
      (ev.items || []).forEach((it, i) => (this.loots ||= []).push({ from: { x: ev.x, y: ev.y }, to: ev.unit, emoji: it.emoji, born: t + i * 0.12, life: 0.9 }));
      this.sfx?.('loot', { x: ev.x, y: ev.y });
    }
    const note = { retreat: ['↩ 撤退', '#bfe3ff'], downed: ['💫 倒下', '#ff9a9a'], revive: ['✚ 醒来', '#7be08a'], rested: ['💪 休整好了', '#7be08a'], party: ['🤝 入队', '#ffd166'] }[ev.type];
    if (note) { const p = at(ev.unit); if (p) this.floats.push({ x: p.x, y: p.y - 0.5, text: note[0], color: note[1], size: 13, born: t }); }
  }
}

export { MONSTER_PLANS };
