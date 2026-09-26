// 氛围：粒子（萤火、落叶、河灯……）、云影、昼夜光照与灯光、天气
// 以 Renderer 的方法形式挂载（见 render.js 末尾），方法里的 this 就是 Renderer。
import { TS, h2 } from './util.js';

export class Atmosphere {
  updateParticles(dt, S, sky) {
    const P = this.particles;
    const minute = S.t % 1440;
    // 喷泉
    for (const p of P.spray) { p.vy += 90 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life += dt; }
    P.spray = P.spray.filter((p) => p.y < p.z + 40 && p.life < 2);
    // 炊烟：有人在家的房子，早晚
    const h = minute / 60;
    const cooking = (h > 6 && h < 9) || (h > 17 && h < 21);
    for (const c of this.chimneys) {
      const occ = S.occupancy[c.b]?.length;
      if ((occ && (cooking || S.weather === 'snow')) || c.b === 'tavern' && h > 17) {
        if (Math.random() < dt * 3) P.smoke.push({ x: c.x, y: c.y, vx: 4 + Math.random() * 6, vy: -12 - Math.random() * 6, r: 3, life: 0 });
      }
    }
    for (const p of P.smoke) { p.x += p.vx * dt; p.y += p.vy * dt; p.r += 4 * dt; p.life += dt; }
    P.smoke = P.smoke.filter((p) => p.life < 3.5);
    // 樱花花瓣
    if (P.petals.length < 70 && Math.random() < dt * 12) {
      P.petals.push({ x: (2 + Math.random() * 30) * TS, y: (31 + Math.random() * 10) * TS, vx: 10 + Math.random() * 12, vy: 8 + Math.random() * 8, rot: Math.random() * 6, life: 0, max: 4 + Math.random() * 4 });
    }
    const wind = S.weather === 'storm' ? 3 : 1;
    for (const p of P.petals) { p.x += p.vx * dt * wind; p.y += p.vy * dt + Math.sin(p.life * 3) * 0.3; p.rot += dt * 2; p.life += dt; }
    P.petals = P.petals.filter((p) => p.life < p.max);
    // 萤火虫
    for (const f of P.flies) { f.ph += dt * f.sp; f.x += Math.cos(f.ph * 1.3) * dt * 0.4; f.y += Math.sin(f.ph * 1.7) * dt * 0.3; }
    // 蝴蝶
    for (const b of P.butterflies) {
      b.ph += dt * 3;
      b.vx += (Math.random() - 0.5) * dt * 4; b.vy += (Math.random() - 0.5) * dt * 4;
      b.vx *= 0.97; b.vy *= 0.97;
      b.x = Math.max(2, Math.min(30, b.x + b.vx * dt)); b.y = Math.max(32, Math.min(42, b.y + b.vy * dt));
    }
    // 飞鸟
    if (!sky.night && S.weather !== 'storm' && Math.random() < dt * 0.04 && P.birds.length < 2) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      P.birds.push({ x: dir > 0 ? -60 : this.vw + 60, y: 60 + Math.random() * this.vh * 0.5, vx: dir * (50 + Math.random() * 30), n: 3 + Math.floor(Math.random() * 4), ph: 0 });
    }
    for (const b of P.birds) { b.x += b.vx * dt; b.ph += dt * 10; }
    P.birds = P.birds.filter((b) => b.x > -100 && b.x < this.vw + 100);
    // 萤火节：湖面河灯与天灯
    if (S.festival && sky.night) {
      if (P.lanterns.length < 80 && Math.random() < dt * 5) {
        const onWater = Math.random() < 0.55;
        P.lanterns.push(onWater
          ? { water: true, x: (46 + Math.random() * 16) * TS, y: (33 + Math.random() * 9) * TS, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 2, life: 0, max: 40 }
          : { water: false, x: (48 + Math.random() * 6) * TS, y: 37.5 * TS, vx: (Math.random() - 0.5) * 8, vy: -14 - Math.random() * 10, life: 0, max: 30 });
      }
    }
    for (const l of P.lanterns) { l.x += l.vx * dt; l.y += l.vy * dt; l.life += dt; }
    P.lanterns = P.lanterns.filter((l) => l.life < l.max);
  }

  drawWorldParticles(ctx, S, sky) {
    const P = this.particles;
    for (const p of P.smoke) {
      ctx.fillStyle = `rgba(230,230,235,${0.45 * (1 - p.life / 3.5)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    for (const p of P.petals) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = `rgba(255,${190 + Math.floor(p.rot * 5) % 30},215,${Math.min(1, (p.max - p.life))})`;
      ctx.fillRect(-2, -1, 4, 2.5);
      ctx.restore();
    }
    if (!sky.night && S.weather === 'sunny') {
      for (const b of P.butterflies) {
        const f = Math.abs(Math.sin(b.ph * 4)) * 3 + 1;
        const x = b.x * TS, y = b.y * TS - 10;
        ctx.fillStyle = b.c;
        ctx.fillRect(x - f, y - 2, f, 3); ctx.fillRect(x + 1, y - 2, f, 3);
        ctx.fillStyle = '#333'; ctx.fillRect(x, y - 2, 1, 4);
      }
    }
    for (const l of P.lanterns) {
      if (!l.water) continue;
      const x = l.x, y = l.y + Math.sin(this.time * 2 + l.x) * 1.5;
      ctx.fillStyle = '#d9534f'; ctx.fillRect(x - 3, y - 4, 6, 5);
      ctx.fillStyle = '#ffd98a'; ctx.fillRect(x - 2, y - 3, 4, 3);
    }
  }

  drawCloudShadows(ctx, S) {
    if (!['sunny', 'cloudy'].includes(S.weather)) return;
    const a = S.weather === 'cloudy' ? 0.13 : 0.06;
    const t = this.time;
    const { W, H } = this.world;
    for (let i = 0; i < 6; i++) {
      const x = ((h2(i, 1) * W * TS + t * (12 + i * 3)) % (W * TS + 600)) - 300;
      const y = h2(i, 2) * H * TS;
      const r = 140 + h2(i, 3) * 160;
      const g = ctx.createRadialGradient(x, y, 10, x, y, r);
      g.addColorStop(0, `rgba(20,30,50,${a})`); g.addColorStop(1, 'rgba(20,30,50,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.4, r, 0, 0, 7); ctx.fill();
    }
  }

  drawLighting(S, sky, ox, oy, z) {
    const { ctx, lctx, light, dpr } = this;
    const minute = S.t % 1440;
    // 晨昏色调
    if (sky.warm > 0.01) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(255,120,40,${0.55 * Math.sin(sky.warm * Math.PI)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (sky.pink > 0.01) {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = `rgba(255,140,190,${0.45 * sky.pink})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (sky.dark < 0.02) return;
    const ls = (dpr / 2); // 光照图为半分辨率
    const toL = (wx, wy) => [(wx * z + ox) * ls, (wy * z + oy) * ls];
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, light.width, light.height);
    lctx.fillStyle = sky.moon ? `rgba(30,10,60,${sky.dark})` : `rgba(10,14,42,${sky.dark})`;
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.globalCompositeOperation = 'destination-out';
    const lights = this.collectLights(S, sky, minute);
    const inView = (x, y, r) => x > this.view.x0 - r && x < this.view.x1 + r && y > this.view.y0 - r && y < this.view.y1 + r;
    for (const L of lights) {
      if (!inView(L.x, L.y, L.r)) continue;
      const [lx, ly] = toL(L.x, L.y);
      const r = L.r * z * ls;
      const g = lctx.createRadialGradient(lx, ly, 0, lx, ly, r);
      g.addColorStop(0, `rgba(0,0,0,${L.i})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(lx - r, ly - r, r * 2, r * 2);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(light, 0, 0, this.canvas.width, this.canvas.height);
    // 暖色辉光
    ctx.globalCompositeOperation = 'lighter';
    const k = Math.min(1, sky.dark * 1.6);
    for (const L of lights) {
      if (!L.c || !inView(L.x, L.y, L.r)) continue;
      const x = (L.x * z + ox) * dpr, y = (L.y * z + oy) * dpr, r = L.r * 0.7 * z * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${L.c},${0.35 * k * L.i})`); g.addColorStop(1, `rgba(${L.c},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 点亮的窗户
    for (const w of this.litWindows) {
      ctx.fillStyle = `rgba(255,200,100,${0.75 * k})`;
      ctx.fillRect((w.x * z + ox) * dpr, (w.y * z + oy) * dpr, w.w * z * dpr, w.h * z * dpr);
    }
    // 萤火虫 & 灯笼
    const P = this.particles;
    for (const f of P.flies) {
      const a = (Math.sin(f.ph * 3) + 1) / 2 * k * (S.festival ? 1.3 : 1);
      if (a < 0.05) continue;
      const x = (f.x * TS * z + ox) * dpr, y = (f.y * TS * z + oy) * dpr;
      const r = 7 * z * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(220,255,140,${a})`); g.addColorStop(1, 'rgba(220,255,140,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (const l of P.lanterns) {
      const fade = Math.min(1, l.life / 2, (l.max - l.life) / 3);
      const x = (l.x * z + ox) * dpr, y = ((l.y + (l.water ? Math.sin(this.time * 2 + l.x) * 1.5 : 0)) * z + oy) * dpr;
      const r = (l.water ? 18 : 14) * z * dpr;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,150,50,${0.55 * fade})`); g.addColorStop(1, 'rgba(255,100,30,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      if (!l.water) {
        ctx.fillStyle = `rgba(255,210,140,${fade})`;
        ctx.fillRect(x - 3 * z * dpr, y - 4 * z * dpr, 6 * z * dpr, 8 * z * dpr);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
  }

  collectLights(S, sky, minute) {
    const out = [];
    const on = sky.dark > 0.15;
    const h = minute / 60;
    if (on) for (const l of this.world.lamps) {
      out.push({ x: l.x * TS + 16, y: l.y * TS - 16, r: 120, i: 0.95, c: this.moon ? '190,160,255' : '255,190,110' });
    }
    if (this.moon) for (const o of this.world.objects) {
      if (o.type === 'moonwell') out.push({ x: (o.x + 1) * TS, y: (o.y + 1) * TS, r: 150, i: 0.95, c: '160,200,255' });
      else if (o.type === 'crystal') out.push({ x: o.x * TS + 16, y: o.y * TS + 8, r: 40, i: 0.6, c: '200,150,255' });
      else if (o.type === 'moonflower' && o.v > 0.6) out.push({ x: o.x * TS + 16, y: o.y * TS + 16, r: 26, i: 0.5, c: '150,230,255' });
    }
    this.litWindows = [];
    if (on) {
      for (const w of this.windows) {
        const occ = S.occupancy[w.b]?.length || 0;
        const asleep = occ && S.occupancy[w.b].every((id) => S.agentMap[id]?.status === 'sleeping');
        const open = (w.b === 'tavern' && h > 16) || (w.b === 'cafe' && h > 6.5 && h < 20.5);
        const lit = (occ && !asleep) || open || (h < 22 && h > 18 && (w.b.startsWith('home_') && h2(w.x, w.y) > 0.5));
        if (!lit) continue;
        this.litWindows.push(w);
        out.push({ x: w.x + w.w / 2, y: w.y + w.h + 6, r: w.door ? 50 : 42, i: 0.85, c: '255,180,90' });
      }
    }
    if (!this.moon) out.push({ x: 22.5 * TS, y: 23.5 * TS, r: 90, i: 0.5, c: '120,200,255' });
    for (const a of S.agents) {
      if (a.inside || !on) continue;
      out.push({ x: a.dx * TS + 16, y: a.dy * TS + 10, r: 56, i: 0.7, c: '255,200,120' });
    }
    if (on) for (const c of S.creatures || []) out.push({ x: c.dx * TS + 16, y: c.dy * TS + 8, r: 34, i: 0.6, c: c.friendly ? '255,170,220' : '150,120,255' });
    if (on) for (const e of S.entities || []) {
      if (e.light && !e.inside) out.push({ x: e.x * TS + 16, y: e.y * TS + 16, r: e.light.r * 1.6, i: 0.95, c: e.light.color });
    }
    if (S.festival && on) {
      for (const l of this.particles.lanterns) out.push({ x: l.x, y: l.y, r: l.water ? 46 : 36, i: 0.9, c: '255,160,70' });
      if (this.balloonLight) out.push({ x: this.balloonLight.x, y: this.balloonLight.y + 20, r: 110, i: 0.9, c: '255,170,80' });
    }
    return out;
  }

  drawWeather(ctx, S, dt) {
    const P = this.particles;
    const W = this.vw, H = this.vh;
    const rainy = S.weather === 'rain' || S.weather === 'storm';
    const target = S.weather === 'storm' ? 650 : S.weather === 'rain' ? 380 : 0;
    while (P.rain.length < target) P.rain.push({ x: Math.random() * W * 1.2, y: Math.random() * H, l: 10 + Math.random() * 14, v: 700 + Math.random() * 400 });
    if (P.rain.length > target) P.rain.length = target;
    if (rainy) {
      const slant = S.weather === 'storm' ? 0.35 : 0.15;
      ctx.strokeStyle = 'rgba(190,210,255,.45)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of P.rain) {
        d.y += d.v * dt; d.x -= d.v * slant * dt;
        if (d.y > H) {
          if (Math.random() < 0.3) P.splash.push({ x: d.x, y: Math.random() * H, life: 0 });
          d.y = -20; d.x = Math.random() * W * 1.2 + 40;
        }
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * slant, d.y - d.l);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(40,60,90,.12)'; ctx.fillRect(0, 0, W, H);
    }
    for (const s of P.splash) {
      s.life += dt;
      ctx.strokeStyle = `rgba(210,225,255,${0.5 * (1 - s.life / 0.4)})`;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 2 + s.life * 14, 1 + s.life * 5, 0, 0, 7); ctx.stroke();
    }
    P.splash = P.splash.filter((s) => s.life < 0.4);
    // 闪电
    if (S.weather === 'storm') {
      this.nextLightning -= dt;
      if (this.nextLightning < 0) { this.flash = 1; this.nextLightning = 4 + Math.random() * 10; }
    }
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(230,235,255,${this.flash * 0.55})`; ctx.fillRect(0, 0, W, H);
      this.flash = Math.max(0, this.flash - dt * 3.5);
      if (this.flash > 0.6 && Math.random() < 0.3) this.flash = 0.9;
    }
    // 雪
    const snowTarget = S.weather === 'snow' ? 260 : 0;
    while (P.snow.length < snowTarget) P.snow.push({ x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 2.5, v: 30 + Math.random() * 40, ph: Math.random() * 6 });
    if (P.snow.length > snowTarget) P.snow.length = snowTarget;
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    for (const f of P.snow) {
      f.y += f.v * dt; f.ph += dt; f.x += Math.sin(f.ph) * 20 * dt;
      if (f.y > H) { f.y = -5; f.x = Math.random() * W; }
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill();
    }
    if (S.weather === 'snow') { ctx.fillStyle = 'rgba(230,240,255,.12)'; ctx.fillRect(0, 0, W, H); }
    // 世界规格新增天气的色调（例如血月）
    if (S.weatherTint) {
      ctx.globalAlpha = S.weatherTint.tintAlpha ?? 0.2;
      ctx.fillStyle = S.weatherTint.tint; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    // 雾
    if (S.weather === 'fog') {
      const t = this.time;
      for (let i = 0; i < 7; i++) {
        const x = ((i * 290 + t * (10 + i * 4)) % (W + 600)) - 300, y = (i * 173) % H;
        const g = ctx.createRadialGradient(x, y, 20, x, y, 360);
        g.addColorStop(0, 'rgba(235,240,245,.35)'); g.addColorStop(1, 'rgba(235,240,245,0)');
        ctx.fillStyle = g; ctx.fillRect(x - 360, y - 360, 720, 720);
      }
    }
    // 飞鸟（屏幕空间）
    ctx.strokeStyle = 'rgba(40,40,50,.7)'; ctx.lineWidth = 1.5;
    for (const b of P.birds) {
      for (let i = 0; i < b.n; i++) {
        const x = b.x - Math.sign(b.vx) * i * 16, y = b.y + (i % 2 ? 1 : -1) * i * 7;
        const f = Math.sin(b.ph + i) * 4;
        ctx.beginPath(); ctx.moveTo(x - 6, y - f); ctx.lineTo(x, y); ctx.lineTo(x + 6, y - f); ctx.stroke();
      }
    }
  }
}
