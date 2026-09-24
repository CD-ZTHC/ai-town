// 语义化放置（设计文档 5.3）：AI 只描述「靠近哪里、多大」，由这里寻找合法位置并校验连通性。
// 校验标准：占地可建、与其他建筑隔一格、门口能走到、原有建筑入口仍然可达、各地点的可达站位一个都不少。
import { buildWorld, T } from '../world.js';

const BUILDABLE = new Set([T.GRASS, T.FLOWER, T.DIRT, T.SAND]);
const MAX_FULL_CHECKS = 24;

const worldOf = (spec, extra = null) => buildWorld({
  buildings: extra ? [...spec.buildings, { ...extra, added: true }] : spec.buildings,
  locationInfo: extra ? { ...spec.locations, [extra.id]: { name: extra.name, emoji: extra.emoji || '🏠', desc: extra.desc || '' } } : spec.locations,
});

/** 地点的中心点（站位、入口或区域中心） */
export function locationCenter(world, id) {
  const l = world.locations[id];
  if (!l) return null;
  if (l.indoor) {
    const b = world.buildings.find((x) => x.id === l.indoor);
    if (b) return { x: b.entrance.x, y: b.entrance.y };
  }
  if (l.rect) return { x: Math.round(l.rect.x + l.rect.w / 2), y: Math.round(l.rect.y + l.rect.h / 2) };
  if (l.spots?.length) return { x: l.spots[0].x, y: l.spots[0].y };
  return null;
}

/** 完整校验：以新建筑重建地图，返回 null 或错误原因 */
export function checkPlacement(spec, def, base = worldOf(spec)) {
  const w = worldOf(spec, def);
  if (w.overlayErrors[def.id]) return w.overlayErrors[def.id];
  const b = w.buildings.find((x) => x.id === def.id);
  if (!b || !w.walk[b.entrance.y * w.W + b.entrance.x]) return '新建筑的门口走不到';
  for (const ob of w.buildings) if (!w.walk[ob.entrance.y * w.W + ob.entrance.x]) return `会挡住「${ob.name}」的入口`;
  for (const [id, l] of Object.entries(base.locations)) {
    if ((w.locations[id]?.spots.length ?? 0) < l.spots.length) return `会挡住「${l.name}」的站位`;
  }
  return null;
}

/**
 * 在 near 地点附近（within 格内）寻找放得下 w×h 建筑的位置。
 * 返回 { x, y } 或 { error }。
 */
export function findPlacement(spec, { id, name = '', w, h, near, within = 12 }) {
  const base = worldOf(spec);
  const c = locationCenter(base, near);
  if (!c) return { error: `未知地点：${near}` };
  const { W, H, tiles, walk, objects, buildings } = base;
  const removable = new Set(objects.filter((o) => ['tree', 'bush', 'rock'].includes(o.type)).map((o) => o.y * W + o.x));
  const quick = (x, y) => {
    if (x < 1 || y < 1 || x + w > W - 1 || y + h > H - 2) return false;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = yy * W + xx;
      if (!BUILDABLE.has(tiles[i]) || (!walk[i] && !removable.has(i))) return false;
    }
    if (buildings.some((b) => b.x < x + w + 1 && b.x + b.w + 1 > x && b.y < y + h + 1 && b.y + b.h + 1 > y)) return false;
    const ex = x + Math.floor(w / 2), ey = y + h;
    return Boolean(walk[ey * W + ex]);
  };
  const cands = [];
  for (let y = c.y - within - h; y <= c.y + within; y++) {
    for (let x = c.x - within - w; x <= c.x + within; x++) {
      const ex = x + Math.floor(w / 2), ey = y + h;
      const d = Math.hypot(ex - c.x, ey - c.y);
      if (d <= within && quick(x, y)) cands.push({ x, y, d });
    }
  }
  cands.sort((p, q) => p.d - q.d);
  let lastErr = '附近没有足够大的空地';
  for (const cand of cands.slice(0, MAX_FULL_CHECKS)) {
    const err = checkPlacement(spec, { id, name, x: cand.x, y: cand.y, w, h }, base);
    if (!err) return { x: cand.x, y: cand.y };
    lastErr = err;
  }
  return { error: `在「${base.locations[near].name}」附近找不到合适的位置（${lastErr}）` };
}
