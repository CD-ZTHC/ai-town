// 地图演变（docs/design/map-evolution.md）
// E1 叠加层：基础生成不变；带新增建筑的地图与重构前逐格一致；拆除的基础建筑变回空地；建筑状态（停业 / 受损 / 废墟）
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { officialPack, packSpec } from '../server/worlds/pack.js';
import { buildRegions } from '../server/worldgen/index.js';
import { applyOp } from '../server/kernel/ops.js';
import { findPlacement } from '../server/kernel/placement.js';
import { validateSpec } from '../server/kernel/spec.js';
import { T } from '../server/world.js';

const fingerprint = (x) => crypto.createHash('sha256').update(JSON.stringify({ t: x.tiles, w: [...x.walk], o: x.objects, b: x.buildings, l: x.locations, g: x.gate })).digest('hex').slice(0, 16);
const specOf = (id) => packSpec(officialPack(id), {});
const withHut = (s, near) => {
  const pl = findPlacement(s, { id: 'test_hut', name: '测试小屋', w: 4, h: 4, near, within: 14 });
  return applyOp(s, { op: 'addBuilding', args: { id: 'test_hut', name: '测试小屋', kind: 'hut', w: 4, h: 4, x: pl.x, y: pl.y, lightAtNight: true } });
};

test('E1 叠加层重构前后逐格一致：云溪镇、暗月界、小红帽，以及带新增建筑的地图', () => {
  const y = specOf('yunxi');
  const r = specOf('little-red');
  assert.equal(fingerprint(buildRegions(y).town), '315c3482058a6357');
  assert.equal(fingerprint(buildRegions(y).moonrealm), '972ab31556c53387');
  assert.equal(fingerprint(buildRegions(r).town), '72287ae2998bd4f5');
  assert.equal(fingerprint(buildRegions(withHut(y, 'square')).town), 'e7be809123901b91');
  assert.equal(fingerprint(buildRegions(withHut(r, 'village_square')).town), '07974093a6e764da');
});

test('拆除的基础建筑变回空地：占地可走、地点消失、其余地图不变', () => {
  const s = specOf('yunxi');
  const before = buildRegions(s).town;
  const lib = s.buildings.find((b) => b.id === 'library');
  s.buildings = s.buildings.map((b) => (b.id === 'library' ? { ...b, removed: true } : b));
  delete s.locations.library;
  const w = buildRegions(s).town;
  assert.ok(!w.buildings.some((b) => b.id === 'library'));
  assert.equal(w.locations.library, undefined);
  assert.deepEqual(w.lots.map((l) => l.id), ['library']);
  for (let y = lib.y; y < lib.y + lib.h; y++) for (let x = lib.x; x < lib.x + lib.w; x++) {
    assert.equal(w.tiles[y * w.W + x], T.DIRT);
    assert.equal(w.walk[y * w.W + x], 1, `(${x},${y}) 应该可以走`);
  }
  // 基础生成的随机序列没有变：树木、花丛、路灯与拆除前相同
  const deco = (x) => x.objects.filter((o) => ['tree', 'bush', 'rock', 'lamp'].includes(o.type));
  assert.deepEqual(deco(w), deco(before));
  // 其他建筑与地点照旧
  assert.equal(w.buildings.length, before.buildings.length - 1);
  for (const id of ['cafe', 'square', 'home_lin']) assert.deepEqual(w.locations[id].spots, before.locations[id].spots);
});

test('建筑状态：停业 / 受损只能到门口，废墟变成户外地点；废墟不能住人', () => {
  const s = specOf('little-red');
  s.buildings = s.buildings.map((b) => (b.id === 'bakery' ? { ...b, state: 'closed' } : b.id === 'hunter_cabin' ? { ...b, state: 'ruin' } : b));
  const w = buildRegions(s).town;
  assert.equal(w.locations.bakery.closed, 'closed');
  assert.equal(w.locations.bakery.indoor, 'bakery');
  assert.ok(w.locations.bakery.spots.length > 0);
  assert.equal(w.locations.hunter_cabin.indoor, undefined);
  assert.equal(w.locations.hunter_cabin.ruin, true);
  assert.ok(w.locations.hunter_cabin.spots.length > 0);
  assert.equal(w.buildings.find((b) => b.id === 'hunter_cabin').state, 'ruin');
  // 猎人还住在废墟里：规格不合法
  assert.ok(validateSpec(s).some((e) => e.includes('hunter') && e.includes('废墟')));
  s.buildings = s.buildings.map((b) => (b.id === 'hunter_cabin' ? { ...b, state: 'haunted' } : b));
  assert.ok(validateSpec(s).some((e) => e.includes('state 只能是')));
});
