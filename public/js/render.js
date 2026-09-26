// 世界渲染器：程序化像素地形 + 建筑 + y 排序物体/角色 + 昼夜光照 + 天气与粒子
// 静态层、物体与角色、氛围、叠加层分别在 render/ 下，以 mixin 的形式挂到 Renderer 上（见文件末尾）。
import { buildSprites, makePortrait } from './sprites.js';
import { TS, STATIC_OBJECTS, skyAt } from './render/util.js';
import { Terrain } from './render/terrain.js';
import { Objects } from './render/objects.js';
import { Atmosphere } from './render/atmosphere.js';
import { Overlays } from './render/overlays.js';

// 其他模块与测试从这里导入
export { TS, skyAt, h2, vnoise, hexToRgb, mix, lerp, clamp01 } from './render/util.js';

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap.getContext('2d');
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d');
    this.sprites = {};
    this.portraits = {};
    this.particles = { rain: [], snow: [], splash: [], smoke: [], petals: [], spray: [], flies: [], lanterns: [], butterflies: [], birds: [] };
    this.flash = 0;
    this.nextLightning = 5;
    this.time = 0;
    this.hits = [];
    this.bubbleSeen = new Map();
    this.vfx = [];
    this.creatureSprites = {};
  }

  /** 世界规格里的异界生物图鉴 → 预生成像素精灵 */
  setCreatureTypes(types = {}) {
    for (const [id, c] of Object.entries(types)) if (!this.creatureSprites[id] && c.look?.bodyPlan) this.creatureSprites[id] = buildSprites(c.look);
  }

  /** 能力等产生的一次性特效（世界坐标，单位：格） */
  addVfx(v) {
    this.vfx.push({ ...v, born: this.time, life: v.preset === 'ripple' ? 2.4 : 1.8 });
    if (this.vfx.length > 40) this.vfx.shift();
  }

  setWorld(world) {
    this.world = world;
    const { W, H } = world;
    this.tileAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : world.tiles[y * W + x]);
    this.buildTreeSprites();
    this.buildStatic();
    this.buildMinimap();
    // 静态物体已画进底图，其余（包括世界规格里新增的未知类型）都按动态物体参与 y 排序绘制
    this.dynamic = world.objects.filter((o) => !STATIC_OBJECTS.has(o.type));
    const P = this.particles;
    this.moon = world.id === 'moonrealm';
    this.balloonLight = null;
    this.particles.lanterns = [];
    P.flies = Array.from({ length: this.moon ? 60 : 46 }, () => this.newFly());
    P.butterflies = this.moon ? [] : Array.from({ length: 10 }, () => ({ x: 2 + Math.random() * 28, y: 33 + Math.random() * 9, vx: 0, vy: 0, c: ['#fff4a3', '#ffc6e0', '#bfe3ff', '#ffffff'][Math.floor(Math.random() * 4)], ph: Math.random() * 6 }));
  }

  newFly() {
    if (this.moon) return { x: 4 + Math.random() * 28, y: 3 + Math.random() * 20, ph: Math.random() * 10, sp: 0.2 + Math.random() * 0.5 };
    const zones = [[2, 33, 29, 10], [44, 30, 18, 3], [15, 36, 15, 6], [38, 2, 8, 12]];
    const z = zones[Math.floor(Math.random() * zones.length)];
    return { x: z[0] + Math.random() * z[2], y: z[1] + Math.random() * z[3], ph: Math.random() * 10, sp: 0.3 + Math.random() * 0.6 };
  }

  setAgents(list) {
    this.meta = Object.fromEntries(list.map((a) => [a.id, a]));
    for (const a of list) {
      this.sprites[a.id] = buildSprites(a.look);
      this.portraits[a.id] = makePortrait(this.sprites[a.id], a.look.shirt);
      const img = new Image();
      img.src = this.portraits[a.id];
      this.meta[a.id].portraitImg = img;
    }
  }

  resize(w, h, dpr) {
    this.vw = w; this.vh = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.light.width = Math.round(w * dpr / 2); this.light.height = Math.round(h * dpr / 2);
  }

  worldToScreen(wx, wy, cam) {
    return [(wx - cam.x) * cam.zoom + this.vw / 2, (wy - cam.y) * cam.zoom + this.vh / 2];
  }

  screenToWorld(sx, sy, cam) {
    return [(sx - this.vw / 2) / cam.zoom + cam.x, (sy - this.vh / 2) / cam.zoom + cam.y];
  }

  frame(S, dt) {
    this.time += dt;
    const { ctx, dpr } = this;
    const cam = S.cam;
    const minute = S.t % 1440;
    let sky = skyAt(minute, S.weather);
    // 暗月界：永远是紫色的黄昏
    if (this.moon) sky = { dark: Math.max(0.5, sky.dark * 0.4 + 0.45), warm: 0, pink: 0, night: true, moon: true };
    this.sky = sky;
    const festival = S.festival;
    this.S = S;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.moon ? '#0b0820' : '#1a2a1e';
    ctx.fillRect(0, 0, this.vw, this.vh);

    // 世界坐标变换
    const z = cam.zoom;
    const ox = this.vw / 2 - cam.x * z, oy = this.vh / 2 - cam.y * z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);
    const vx0 = cam.x - this.vw / 2 / z, vy0 = cam.y - this.vh / 2 / z;
    const vx1 = cam.x + this.vw / 2 / z, vy1 = cam.y + this.vh / 2 / z;
    this.view = { x0: vx0, y0: vy0, x1: vx1, y1: vy1 };

    // 地面
    const sx = Math.max(0, Math.floor(vx0)), sy = Math.max(0, Math.floor(vy0));
    const sw = Math.min(this.static.width, Math.ceil(vx1)) - sx, sh = Math.min(this.static.height, Math.ceil(vy1)) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(this.static, sx, sy, sw, sh, sx, sy, sw, sh);

    this.drawWater(ctx, vx0, vy0, vx1, vy1);

    // y 排序
    const items = [];
    const pad = 3 * TS;
    for (const o of this.dynamic) {
      const px = o.x * TS, py = o.y * TS;
      if (px < vx0 - pad || px > vx1 + pad || py < vy0 - pad || py > vy1 + pad * 2) continue;
      items.push({ y: (o.y + (o.h || 1)) * TS - (o.type === 'lily' || o.type === 'boat' ? 1000 : 0), o });
    }
    for (const a of S.agents) {
      if (a.inside) continue;
      items.push({ y: a.dy * TS + TS * 0.9, a });
    }
    for (const e of S.entities || []) {
      if (e.inside) continue;
      items.push({ y: e.kind === 'portal' ? -1e6 : e.y * TS + TS * 0.8, e });
    }
    for (const c of S.creatures || []) items.push({ y: c.dy * TS + TS * 0.9, c });
    for (const v of S.avatars || []) items.push({ y: v.dy * TS + TS * 0.9, v });
    items.sort((p, q) => p.y - q.y);
    for (const it of items) it.v ? this.drawAvatar(ctx, it.v, S) : it.o ? this.drawObject(ctx, it.o, S) : it.e ? (it.e.kind === 'portal' ? this.drawPortal(ctx, it.e) : this.drawEntity(ctx, it.e)) : it.c ? this.drawCreature(ctx, it.c) : this.drawAgent(ctx, it.a, S);
    this.drawVfx(ctx);
    this.drawPluginOverlay(ctx, S);

    this.updateParticles(dt, S, sky);
    this.drawWorldParticles(ctx, S, sky);
    this.drawCloudShadows(ctx, S);

    // 光照
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawLighting(S, sky, ox, oy, z);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawWeather(ctx, S, dt);
    // UI 叠加层（屏幕坐标）
    this.hits = [];
    this.drawOverlays(ctx, S, ox, oy, z);
    this.drawMinimap(S);
  }

  hitTest(sx, sy) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h) return h.id;
    }
    return null;
  }
}

// 把各部分的方法挂到 Renderer 上；重名直接报错，避免悄悄覆盖
for (const part of [Terrain, Objects, Atmosphere, Overlays]) {
  for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(part.prototype))) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(Renderer.prototype, name)) throw new Error(`Renderer.${name} 重复定义（${part.name}）`);
    Object.defineProperty(Renderer.prototype, name, desc);
  }
}
