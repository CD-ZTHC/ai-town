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

// ---------- E2 建筑的一生 ----------
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { SETTINGS } = await import('../server/settings/schema.js');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.js');
const { loadPack } = await import('../server/worlds/pack.js');
const { manifestText } = await import('../server/worldai/manifest.js');
const redPack = loadPack(path.resolve('worlds/little-red'));
const redTown = () => new Town({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'town-map-')), worldId: 'little-red', pack: redPack, instantTalk: true });
const persona = (town, id) => town.spec.personas.find((p) => p.id === id);

test('拆除：没有搬迁去处被拒绝并说明原因；架构师补上就近的去处后落地，引用全部改指向，撤销后恢复', (t) => {
  const town = redTown();
  t.after(() => town.stop());
  assert.throws(() => town.applyWorldOp({ op: 'removeBuilding', args: { id: 'grandma_house' } }), /还住着 1 个人（外婆）/);
  assert.throws(() => town.applyWorldOp({ op: 'removeBuilding', args: { id: 'grandma_house', remap: { residents: 'red_house' } } }), /节日 grandma_birthday/);
  const r = town.proposalSystem.prepare([{ op: 'removeBuilding', args: { id: 'grandma_house' } }]);
  assert.ok(!r.error, r.error);
  const remap = r.ops[0].args.remap;
  assert.ok(['red_house', 'hunter_cabin', 'wolf_den'].includes(remap.residents), JSON.stringify(remap));
  assert.ok(remap.location && remap.location !== 'grandma_house');
  const rec = town.applyWorldOp(r.ops[0], { by: 'test', proposal: 'wpX' });
  assert.equal(persona(town, 'grandma').home, remap.residents);
  assert.equal(town.byId.grandma.home, remap.residents, '运行中的居民也搬了');
  assert.equal(town.spec.calendar.events[0].location, remap.location);
  assert.equal(town.spec.locations.grandma_house, undefined);
  assert.ok(!town.world.buildings.some((b) => b.id === 'grandma_house'));
  assert.ok(town.world.lots.some((l) => l.id === 'grandma_house'), '原址是空地');
  assert.ok(town.logs.some((l) => l.text.includes('「外婆家」被拆除了')) || town.worldHistory().some((h) => h.desc.includes('外婆')));
  // 空地可以再建
  const again = findPlacement(town.spec, { id: 'new_house', name: '新屋', w: 5, h: 5, near: remap.location, within: 16 });
  assert.ok(!again.error, again.error);
  // 撤销
  town.revertOps((x) => x.seq === rec.seq);
  assert.equal(persona(town, 'grandma').home, 'grandma_house');
  assert.equal(town.byId.grandma.home, 'grandma_house');
  assert.equal(town.spec.calendar.events[0].location, 'grandma_house');
  assert.ok(town.world.buildings.some((b) => b.id === 'grandma_house'));
});

test('改建：名字、类型变了，地点 id 与住户不变；停业后别人只能到门口，住户照样能回家；废墟要搬迁、修复后恢复', (t) => {
  const town = redTown();
  t.after(() => town.stop());
  town.applyWorldOp({ op: 'renovateBuilding', args: { id: 'bakery', name: '蜂蜜茶馆', kind: 'cafe', desc: '面包房改成了茶馆', public: true } });
  assert.equal(town.world.buildings.find((b) => b.id === 'bakery').name, '蜂蜜茶馆');
  assert.equal(town.spec.locations.bakery.name, '蜂蜜茶馆');
  assert.equal(persona(town, 'mom').work, 'bakery');
  assert.throws(() => town.applyWorldOp({ op: 'renovateBuilding', args: { id: 'bakery', name: '外婆家' } }), /已经有了/);

  town.applyWorldOp({ op: 'setBuildingState', args: { id: 'red_house', state: 'closed' } });
  const loc = town.findLocation('red_house');
  assert.equal(loc.closed, 'closed');
  const e = { activity: '串门' };
  town.navigate(town.byId.hunter, 'red_house', e);
  assert.equal(town.byId.hunter.dest.indoor, null, '别人只能到门口');
  town.navigate(town.byId.red, 'red_house', { sleep: true, activity: '睡觉' });
  assert.equal(town.byId.red.dest.indoor, 'red_house', '住户照样能进');
  town.applyWorldOp({ op: 'setBuildingState', args: { id: 'bakery', state: 'closed' } });
  assert.match(town.locListText(), /蜂蜜茶馆：面包房改成了茶馆，已停业/);

  assert.throws(() => town.applyWorldOp({ op: 'setBuildingState', args: { id: 'hunter_cabin', state: 'ruin' } }), /还住着/);
  const r = town.proposalSystem.prepare([{ op: 'setBuildingState', args: { id: 'hunter_cabin', state: 'ruin' } }]);
  assert.ok(!r.error, r.error);
  town.applyWorldOp(r.ops[0]);
  assert.ok(town.findLocation('hunter_cabin').ruin);
  assert.notEqual(persona(town, 'hunter').home, 'hunter_cabin');
  town.applyWorldOp({ op: 'restoreBuilding', args: { id: 'hunter_cabin' } });
  assert.equal(town.findLocation('hunter_cabin').indoor, 'hunter_cabin');
  assert.match(manifestText(town.spec), /hunter_cabin\(猎人小屋/);
});

test('拆除提案：大改、有施工期、在里面的人走到门口；保护期内不能拆；两次拆除至少隔 3 天', async (t) => {
  const town = redTown();
  t.after(() => town.stop());
  const ps = town.proposalSystem;
  const red = town.byId.red;
  const house = town.world.buildings.find((b) => b.id === 'red_house');
  Object.assign(red, { inside: 'red_house', x: house.entrance.x, y: house.entrance.y });
  const { proposal: p, error } = ps.submit({ title: '拆掉小红帽家', ops: [{ op: 'removeBuilding', args: { id: 'red_house' } }], construction: { hours: 2 } });
  assert.ok(!error, error);
  assert.equal(p.level, 'major');
  assert.equal(p.construction.kind, 'demolish');
  assert.deepEqual(p.construction.site.id, 'red_house');
  assert.ok(p.construction.by.length > 0, '有施工队（不再写死云溪镇的人）');
  // 设定考据是异步的：等它把提案送去审批
  for (let i = 0; i < 20 && p.status === 'review'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(ps.decide(p.id, true, 'admin'), null);
  assert.equal(p.status, 'building');
  town.t = p.finishT + 1;
  ps.tick();
  assert.equal(p.status, 'applied', p.result?.reason);
  assert.equal(red.inside, null, '在里面的人走到了门口');
  assert.ok(town.spec.lore.canon.some((c) => c.text.includes('小红帽家') && c.text.includes('拆除')), '写进正典');
  assert.ok(red.memories.some((m) => m.text.includes('小红帽家') && m.text.includes('搬到')));
  // 两次拆除至少隔 3 天
  const r2 = ps.prepare([{ op: 'removeBuilding', args: { id: 'bakery' } }]);
  assert.match(r2.error, /3 天之内不再拆/);
  // 保护期
  town.t += 5 * 1440;
  const pl = findPlacement(town.spec, { id: 'shed', name: '小棚', w: 4, h: 4, near: 'village_square', within: 16 });
  town.applyWorldOp({ op: 'addBuilding', args: { id: 'shed', name: '小棚', kind: 'hut', w: 4, h: 4, x: pl.x, y: pl.y, builtDay: town.day } });
  assert.match(ps.prepare([{ op: 'removeBuilding', args: { id: 'shed' } }]).error, /不到 7 天/);
});
