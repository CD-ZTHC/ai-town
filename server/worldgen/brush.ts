// 户外地点的笔刷：广场、集市、田地、果园、花园、池塘、码头、水井、营地、神龛……
// layout-v1 生成基础地图时用它，运行中新增的户外地点（addOutdoorPlace，见 finish.js）也用它。
import { T } from './tiles.ts';
import type { MapObject, Rect } from '../types/map.ts';

/** 笔刷用到的画布操作 */
export interface Brush {
  set(x: number, y: number, t: number): unknown;
  get(x: number, y: number): number;
  block(x: number, y: number): unknown;
  objects: MapObject[];
  rnd: () => number;
  H: number;
}

/** 在画布上画一个户外地点：p = { rect, kind } */
export function paintOutdoor(c: Brush, p: { rect: Rect; kind: string }): void {
  const { set, get, block, objects, rnd, H } = c;
  const { x: rx, y: ry, w, h } = p.rect;
  const fill = (t: number) => { for (let y = ry; y < ry + h; y++) for (let x = rx; x < rx + w; x++) set(x, y, t); };
  if (['plaza', 'square', 'market'].includes(p.kind)) {
    fill(T.PLAZA);
    if (p.kind === 'market') for (let i = 0; i < 3; i++) { const o: MapObject = { type: 'stall', x: rx + 1 + i * 3, y: ry, w: 2, h: 1, color: ['#e05a5a', '#4a90d9', '#f0b030'][i], goods: ['🍎', '🥖', '💐'][i] }; objects.push(o); block(o.x, o.y); block(o.x + 1, o.y); }
    else { objects.push({ type: 'fountain', x: rx + Math.floor(w / 2) - 1, y: ry + Math.floor(h / 2) - 1, w: 3, h: 3 }); for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) block(rx + Math.floor(w / 2) - 1 + dx, ry + Math.floor(h / 2) - 1 + dy); }
  } else if (['field', 'farm', 'orchard'].includes(p.kind)) {
    fill(p.kind === 'orchard' ? T.GRASS : T.SOIL);
    for (let y = ry + 1; y < ry + h - 1; y += 2) for (let x = rx + 1; x < rx + w - 1; x++) {
      if (p.kind === 'orchard') { if ((x + y) % 3 === 0) { objects.push({ type: 'tree', x, y, kind: 'oak', v: rnd() }); block(x, y); } } else objects.push({ type: 'crop', x, y, kind: rnd() < 0.5 ? 'melon' : 'veg', v: rnd() });
    }
  } else if (p.kind === 'garden') {
    fill(T.FLOWER);
    objects.push({ type: 'bench', x: rx + 1, y: ry + h - 1 }, { type: 'bench', x: rx + w - 2, y: ry + h - 1 });
  } else if (p.kind === 'pond') {
    const cx = rx + w / 2 - 0.5, cy = ry + h / 2 - 0.5;
    for (let y = ry; y < ry + h; y++) for (let x = rx; x < rx + w; x++) if (((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2 < 0.8) set(x, y, T.WATER);
  } else if (p.kind === 'dock') {
    fill(T.WOOD);
    // 码头伸进下面的水里
    for (let y = ry + h; y < Math.min(H - 1, ry + h + 4); y++) if (get(rx + 1, y) === T.WATER || get(rx + 1, y) === T.DEEP || get(rx + 1, y) === T.SAND) { set(rx + 1, y, T.WOOD); set(rx + 2, y, T.WOOD); }
  } else if (p.kind === 'well') {
    objects.push({ type: 'well', x: rx + 1, y: ry + 1 }); block(rx + 1, ry + 1);
    for (let y = ry; y < ry + h; y++) for (let x = rx; x < rx + w; x++) if (get(x, y) === T.GRASS) set(x, y, T.DIRT);
  } else if (['camp', 'gate', 'path', 'bridge'].includes(p.kind)) {
    fill(T.DIRT);
    if (p.kind === 'camp') { objects.push({ type: 'woodpile', x: rx + 1, y: ry + 1 }); block(rx + 1, ry + 1); }
  } else if (p.kind === 'graveyard' || p.kind === 'shrine') {
    fill(T.DIRT);
    for (let y = ry + 1; y < ry + h - 1; y += 2) for (let x = rx + 1; x < rx + w - 1; x += 2) { objects.push({ type: 'rock', x, y, v: rnd() }); block(x, y); }
  }
  // clearing / meadow / grove：保持草地，只是不长树
}
