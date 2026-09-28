// 地图演变（docs/design/map-evolution.md）
// E1 叠加层：基础生成不变；带新增建筑的地图与重构前逐格一致；拆除的基础建筑变回空地；建筑状态（停业 / 受损 / 废墟）
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { officialPack, packSpec } from '../server/worlds/pack.js';
import { buildRegions } from '../server/worldgen/index.ts';
import { applyOp } from '../server/kernel/ops.ts';
import { findPlacement } from '../server/kernel/placement.ts';
import { validateSpec } from '../server/kernel/spec.ts';
import { T } from '../server/world.ts';

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
const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack } = await import('../server/worlds/pack.js');
const { manifestText } = await import('../server/worldai/manifest.ts');
const llm = await import('../server/llm.ts');
const { judge } = await import('../server/worldai/council.ts');
const { ARCHITECT_OPS, ADMIN_OPS } = await import('../server/worldai/proposals.ts');
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
  // 设定考据是异步的：等它把提案送去议事；当事人（小红帽、妈妈）同意、其余居民过半赞成
  for (let i = 0; i < 20 && p.status === 'review'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(p.status, 'council');
  llm.setMock((m, o) => JSON.stringify(o?.label === '居民议事' ? { consent: { 小红帽: { yes: true }, 妈妈: { yes: true } }, votes: { 外婆: { yes: true }, 猎人: { yes: true }, 大灰狼: { yes: false } } } : {}));
  t.after(() => llm.setMock(null));
  await town.council.deliberate(p);
  assert.equal(p.status, 'awaiting', p.result?.reason);
  assert.equal(ps.decide(p.id, true, 'admin'), null);
  assert.equal(p.status, 'building');
  town.t = p.finishT + 1;
  ps.tick();
  assert.equal(p.status, 'applied', p.result?.reason);
  assert.equal(red.inside, null, '在里面的人走到了门口');
  assert.ok(town.spec.lore.canon.some((c) => c.text.includes('小红帽家') && c.text.includes('拆除')), '写进正典');
  assert.ok(red.memories.some((m) => m.importance === 9 && m.text.includes('小红帽家')), '当事人的重要记忆');
  // 两次拆除至少隔 3 天
  const r2 = ps.prepare([{ op: 'removeBuilding', args: { id: 'bakery' } }]);
  assert.match(r2.error, /3 天之内不再拆/);
  // 保护期
  town.t += 5 * 1440;
  const pl = findPlacement(town.spec, { id: 'shed', name: '小棚', w: 4, h: 4, near: 'village_square', within: 16 });
  town.applyWorldOp({ op: 'addBuilding', args: { id: 'shed', name: '小棚', kind: 'hut', w: 4, h: 4, x: pl.x, y: pl.y, builtDay: town.day } });
  assert.match(ps.prepare([{ op: 'removeBuilding', args: { id: 'shed' } }]).error, /不到 7 天/);
});

// ---------- E3 拆除的议事 ----------
test('议事判定：当事人同意 + 过半数；当事人反对 + 全票；差一票否决；过半数反对否决；没有当事人只看过半数', () => {
  const v = (...yes) => Object.fromEntries(yes.map((y, i) => [`v${i}`, { yes: y }]));
  const voters = ['v0', 'v1', 'v2'];
  const J = (consent, votes, stakeholders = ['s']) => judge({ stakeholders, voters, consent, votes });
  assert.equal(J({ s: { yes: true } }, v(true, true, false)).pass, true);
  assert.equal(J({ s: { yes: true } }, v(true, false, false)).pass, false);
  const forced = J({ s: { yes: false } }, v(true, true, true));
  assert.deepEqual([forced.pass, forced.forced], [true, true]);
  assert.equal(J({ s: { yes: false } }, v(true, true, false)).pass, false, '差一票');
  assert.equal(J({ s: { yes: false } }, { v0: { yes: true }, v1: { yes: true } }).pass, false, '有人没表态不算全票');
  assert.equal(J({}, v(true, true, false), []).pass, true, '没有当事人：过半数');
  assert.equal(J({}, v(true, false, false), []).pass, false);
});

test('议事：当事人不同意、其余全票赞成 → 拆除；当事人得到重要记忆、心情失落、记下谁赞成，并留下「旧居」线程', async (t) => {
  const town = redTown();
  t.after(() => { town.stop(); llm.setMock(null); });
  llm.setMock((m, o) => JSON.stringify(o?.label === '居民议事' ? {
    consent: { 小红帽: { yes: false, reason: '这是我长大的地方' }, 妈妈: { yes: true, reason: '为了修路' } },
    votes: { 外婆: { yes: true, reason: '路修好了我走得动' }, 猎人: { yes: true }, 大灰狼: { yes: true } },
    memories: { 小红帽: { agree: '我答应了。', forced: '我不想搬走，可大家都举了手。那扇红门，我再也推不开了。' } },
    thread: { title: '红门的记忆', hook: '小红帽总在旧址那里发呆' },
  } : {}));
  const ps = town.proposalSystem;
  const { proposal: p } = ps.submit({ title: '拆掉小红帽家修路', motive: '去外婆家的路太绕', ops: [{ op: 'removeBuilding', args: { id: 'red_house' } }] });
  for (let i = 0; i < 20 && p.status === 'review'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(p.status, 'council');
  assert.deepEqual(p.council.stakeholders.sort(), ['mom', 'red']);
  assert.ok(town.pendingScenes.some((sc) => sc.council === p.id), '安排了议事会');
  town.council.onScene({ council: p.id }, { summary: '大家在村口广场吵了一下午' });
  await town.council.deliberate(p);
  assert.equal(p.council.pass, true);
  assert.equal(p.council.forced, true);
  assert.equal(ps.decide(p.id, true, 'owner'), null);
  town.t = p.finishT + 1;
  ps.tick();
  assert.equal(p.status, 'applied', p.result?.reason);
  const red = town.byId.red;
  assert.ok(red.memories.some((m) => m.importance === 9 && m.text.includes('红门')), '被全票通过的当事人的重要记忆');
  assert.equal(red.mood.text, '失落');
  assert.match(red.relations.grandma.note, /赞成拆了「小红帽家」/);
  assert.ok(town.byId.mom.memories.some((m) => m.importance === 9 && m.text.includes('我答应了') && m.text.includes('小红帽家')), '同意的当事人用默认文案');
  assert.ok(town.spec.threads.some((th) => th.title === '红门的记忆'));
  assert.ok(ps.view(p).council.votes.every((x) => x.yes === true));
  // 撤销：多一段「后来不拆了」
  assert.equal(ps.undo(p), null);
  assert.ok(red.memories.some((m) => m.text.includes('后来大家决定不拆')));
});

test('议事否决：差一票不拆；10 天之内不能再提；终审人不能推翻', async (t) => {
  const town = redTown();
  t.after(() => { town.stop(); llm.setMock(null); });
  llm.setMock((m, o) => JSON.stringify(o?.label === '居民议事' ? {
    consent: { 小红帽: { yes: false }, 妈妈: { yes: false } }, votes: { 外婆: { yes: false, reason: '舍不得' }, 猎人: { yes: true }, 大灰狼: { yes: true } },
  } : {}));
  const ps = town.proposalSystem;
  const { proposal: p } = ps.submit({ title: '拆掉小红帽家', ops: [{ op: 'removeBuilding', args: { id: 'red_house' } }] });
  for (let i = 0; i < 20 && p.status === 'review'; i++) await new Promise((r) => setImmediate(r));
  town.council.onScene({ council: p.id }, null);
  await town.council.deliberate(p);
  assert.equal(p.status, 'rejected');
  assert.match(p.result.reason, /居民否决/);
  assert.match(ps.decide(p.id, true, 'admin'), /不能终审/);
  assert.match(ps.prepare([{ op: 'removeBuilding', args: { id: 'red_house' } }]).error, /居民刚否决过/);
  assert.ok(town.byId.grandma.memories.some((m) => m.text.includes('反对拆掉「小红帽家」')));
  town.t += 10 * 1440;
  assert.ok(!ps.prepare([{ op: 'removeBuilding', args: { id: 'red_house' } }]).error);
});

// ---------- E4 地形 ----------
const { findPath } = await import('../server/world.ts');
const { locationCenter } = await import('../server/kernel/placement.ts');

test('修路：穿过树林的新路让往返变近；入口与站位都还在；跨太宽的水面要先架桥', (t) => {
  const town = redTown();
  t.after(() => town.stop());
  const w0 = town.world;
  const a = locationCenter(w0, 'village_square'), b = locationCenter(w0, 'wolf_den');
  const before = findPath(w0, a.x, a.y, b.x, b.y).length;
  const r = town.proposalSystem.prepare([{ op: 'addPath', args: { from: 'village_square', to: 'wolf_den', surface: 'dirt' } }]);
  assert.ok(!r.error, r.error);
  town.applyWorldOp(r.ops[0]);
  const w = town.world;
  const after = findPath(w, a.x, a.y, b.x, b.y).length;
  assert.ok(after < before, `${before} → ${after}`);
  for (const bd of w.buildings) assert.equal(w.walk[bd.entrance.y * w.W + bd.entrance.x], 1);
  for (const [id, l] of Object.entries(w0.locations)) assert.ok(w.locations[id].spots.length >= l.spots.length, id);
  assert.ok(town.worldHistory().at(-1).desc.includes('修了一条从「村口广场」到「狼窝」的路'));
  assert.equal(town.proposalSystem.prepare([{ op: 'addPath', args: { from: 'village_square', to: 'wolf_den' } }]).error?.includes('已经有路了'), true);
});

test('架桥、清地、种树、新的户外地点：求解后落地，读档重放得到同样的地图', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-map-'));
  const town = new Town({ dataDir: dir, instantTalk: true });
  t.after(() => town.stop());
  const ps = town.proposalSystem;
  const r = ps.prepare([
    { op: 'addBridge', args: { near: 'home_chen' } },
    { op: 'clearArea', args: { near: 'home_chen', w: 6, h: 5 } },
    { op: 'addOutdoorPlace', args: { id: 'melon_garden', kind: 'garden', name: '瓜棚花园', emoji: '🌻', desc: '农场边新辟的小花园', near: 'home_chen' } },
    { op: 'plantGrove', args: { near: 'park', w: 5, h: 4, trees: 'sakura' } },
  ]);
  assert.ok(!r.error, r.error);
  const trees0 = town.world.objects.filter((o) => o.type === 'tree').length;
  for (const o of r.ops) town.applyWorldOp(o);
  const w = town.world;
  const bridge = r.ops[0].args.cells;
  for (const [x, y] of bridge) assert.equal(w.tiles[y * w.W + x], T.BRIDGE);
  const rect = r.ops[1].args.rect;
  assert.ok(!w.objects.some((o) => ['tree', 'bush', 'rock'].includes(o.type) && o.x >= rect.x && o.x < rect.x + rect.w && o.y >= rect.y && o.y < rect.y + rect.h && !r.ops[3].args.trees.some(([x, y]) => x === o.x && y === o.y)), '清干净了');
  assert.ok(w.objects.filter((o) => o.type === 'tree' && o.kind === 'sakura').length >= r.ops[3].args.trees.length);
  assert.ok(w.locations.melon_garden.spots.length > 0, '新地点走得进去');
  assert.ok(town.publicLocs().includes('melon_garden'), '居民可以去');
  assert.ok(trees0 > 0);
  town.save();
  const again = new Town({ dataDir: dir, instantTalk: true });
  t.after(() => again.stop());
  assert.equal(fingerprint(again.world), fingerprint(w), '重放得到同样的地图');
});

// ---------- E5 地图扩展 ----------
const EXT = (side, by = 16, extra = {}) => ({ op: 'expandMap', args: { side, by, biome: 'village', name: '新街', seed: 5, places: [{ id: 'new_inn', kind: 'inn', name: '旅人客栈' }, { id: 'new_orchard', kind: 'orchard', name: '新果园' }], ...extra } });

test('向东扩展：原地图逐格不变（只多了接缝上的路），新地点可以走到；不能超过 96×64', () => {
  const s0 = specOf('yunxi');
  const w0 = buildRegions(s0).town;
  const s = applyOp(s0, EXT('east'));
  const w = buildRegions(s).town;
  assert.deepEqual([w.W, w.H], [80, 44]);
  let diff = 0;
  for (let y = 0; y < 44; y++) for (let x = 0; x < 64; x++) {
    const a = w0.tiles[y * 64 + x], b = w.tiles[y * 80 + x];
    if (a !== b) { diff++; assert.ok([T.DIRT, T.PATH].includes(b), `(${x},${y}) ${a} → ${b}`); }
  }
  assert.ok(diff < 40, `接缝改动 ${diff} 格`);
  for (const b of w0.buildings) assert.deepEqual([w.buildings.find((x) => x.id === b.id).x, w.buildings.find((x) => x.id === b.id).y], [b.x, b.y]);
  const sq = locationCenter(w, 'square');
  for (const id of ['new_inn', 'new_orchard']) { const c = locationCenter(w, id); assert.ok(findPath(w, sq.x, sq.y, c.x, c.y), id); }
  assert.ok(w.biomes.some((b) => b.id === 'village'));
  // 上限
  let big = s;
  big = applyOp(big, EXT('east', 16, { places: [] }));
  assert.throws(() => applyOp(big, EXT('east', 8, { places: [] })), /最大 96×64/);
});

test('向西扩展：基础地图与运行中的一切整体平移——新增建筑、地形编辑、居民、施工现场；读档与重放一致；撤销时平移回来', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-map-'));
  const town = new Town({ dataDir: dir, worldId: 'little-red', pack: redPack, instantTalk: true });
  t.after(() => town.stop());
  const ps = town.proposalSystem;
  const r1 = ps.prepare([{ op: 'addPath', args: { from: 'village_square', to: 'wolf_den' } }, { op: 'addBuilding', args: { id: 'shed', name: '小棚', kind: 'hut', w: 4, h: 4, place: { near: 'village_square' } } }]);
  assert.ok(!r1.error, r1.error);
  for (const o of r1.ops) town.applyWorldOp(o);
  const before = structuredClone({ shed: town.world.buildings.find((b) => b.id === 'shed'), bakery: town.world.buildings.find((b) => b.id === 'bakery'), gate: town.world.gate, path: town.spec.regions[0].edits[0].cells[0] });
  const red = town.byId.red;
  Object.assign(red, { x: 10, y: 20, inside: null });
  const r = ps.prepare([EXT('west', 12)]);
  assert.ok(!r.error, r.error);
  const rec = town.applyWorldOp(r.ops[0], { by: 'test' });
  const w = town.world;
  assert.equal(w.W, 76);
  assert.deepEqual([red.x, red.y], [22, 20], '居民跟着平移');
  assert.equal(w.buildings.find((b) => b.id === 'shed').x, before.shed.x + 12, '新增建筑平移');
  assert.equal(w.buildings.find((b) => b.id === 'bakery').x, before.bakery.x + 12, '基础建筑平移');
  assert.deepEqual(w.gate, { x: before.gate.x + 12, y: before.gate.y });
  assert.deepEqual(town.spec.regions[0].edits[0].cells[0], [before.path[0] + 12, before.path[1]], '地形编辑平移');
  assert.deepEqual(town.spec.regions[0].offset, { x: 12, y: 0 });
  // 所有居民站在能走的格子上（或在屋里）
  for (const a of town.agents) if (!a.inside) assert.equal(w.walk[Math.round(a.y) * w.W + Math.round(a.x)], 1, `${a.name} 卡在 (${a.x},${a.y})`);
  town.save();
  const again = new Town({ dataDir: dir, worldId: 'little-red', pack: redPack, instantTalk: true });
  t.after(() => again.stop());
  assert.equal(fingerprint(again.world), fingerprint(w), '重放得到同样的地图');
  assert.deepEqual([again.byId.red.x, again.byId.red.y], [22, 20]);
  // 撤销扩展：平移回来
  town.revertOps((x) => x.seq === rec.seq);
  assert.equal(town.world.W, 64);
  assert.deepEqual([red.x, red.y], [10, 20]);
  assert.equal(town.world.buildings.find((b) => b.id === 'shed').x, before.shed.x);
});

// ---------- E6 区域图：相邻的地图、路口、数据化的文案 ----------
const walkTo = (town, a, locId) => {
  const e = { activity: '逛逛' };
  Object.assign(a, { inside: null, status: 'acting', convoId: null, curEntry: e });
  town.navigate(a, locId, e);
  for (let i = 0; i < 4000 && a.status === 'walking'; i++) town.step(a, 1);
  return a;
};
const ADJ = (id, side, extra = {}) => ({ op: 'addAdjacentRegion', args: { id, name: '城东', side, length: 40, fromName: '城中', biome: 'village', areas: [{ id: `${id}_a`, size: 'large', places: [{ id: `${id}_market`, kind: 'market', name: '东市' }, { id: `${id}_inn`, kind: 'inn', name: '东门客栈' }] }], ...extra } });

test('相邻的地图：通道两边对齐；居民从主地图走过去（经路口换到新地图）；再连一张时能连续换乘', (t) => {
  const town = redTown();
  t.after(() => town.stop());
  const r = town.proposalSystem.prepare([ADJ('chengdong', 'east')]);
  assert.ok(!r.error, r.error);
  town.applyWorldOp(r.ops[0]);
  assert.equal(town.spec.regions[0].name, '城中');
  const east = town.regions.chengdong;
  assert.ok(east && east.passages.length >= 1, '新地图有通道');
  const mine = town.world.passages.find((p) => p.to === 'chengdong');
  const theirs = east.passages.find((p) => p.key === mine.key);
  assert.equal(mine.x, town.world.W - 1);
  assert.equal(theirs.x, 0);
  assert.equal(mine.y, theirs.y, '两边对齐');
  assert.ok(town.regionOpen('chengdong'), '相邻的地图一直是通的');
  assert.ok(town.publicLocs().includes('chengdong_market'));
  assert.match(town.locListText(), /东市.*在城东/);
  const red = walkTo(town, town.byId.red, 'chengdong_market');
  assert.equal(red.region, 'chengdong');
  assert.equal(red.locId, 'chengdong_market');
  assert.ok(red.memories.some((m) => m.text.includes('第一次来到了城东')));
  // 城东再往东连一张：从城中出发要换乘两次
  const r2 = town.proposalSystem.prepare([ADJ('dongjiao', 'east', { from: 'chengdong', name: '东郊', fromName: undefined, areas: [{ id: 'dj_a', size: 'large', places: [{ id: 'dj_farm', kind: 'farm', name: '东郊农场' }] }] })]);
  assert.ok(!r2.error, r2.error);
  town.applyWorldOp(r2.ops[0]);
  assert.equal(town.routeStep('town', 'dongjiao').to, 'chengdong');
  const mom = walkTo(town, town.byId.mom, 'dj_farm');
  // 第一段走到城东，接着自己继续走完第二段
  for (let i = 0; i < 4 && mom.region !== 'dongjiao'; i++) walkTo(town, mom, 'dj_farm');
  assert.equal(mom.region, 'dongjiao');
  // 有邻居的一侧不能再扩展
  assert.match(town.proposalSystem.prepare([EXT('east', 8, { places: [] })]).error, /已经连着相邻的地图/);
  assert.ok(!town.proposalSystem.prepare([EXT('south', 8, { places: [] })]).error);
});

test('远处的区域：经路口往返；开放时的旁白、传闻、第一次到访的记忆来自区域数据（小红帽世界里没有暗月界的字样）', (t) => {
  const yx = new Town({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'town-map-')), instantTalk: true });
  t.after(() => yx.stop());
  yx.openRegion('moonrealm', true);
  assert.ok(yx.logs.some((l) => l.text.includes('月之渡口那头的「暗月界」向小镇敞开了')));
  assert.ok(yx.byId.lin.memories.some((m) => m.text.includes('暗月界')));
  const lin = walkTo(yx, yx.byId.lin, 'moon_plaza');
  assert.equal(lin.region, 'moonrealm');
  assert.ok(lin.memories.some((m) => m.text.includes('第一次穿过月之渡口，来到了暗月界：天是深紫色的')));

  const town = redTown();
  t.after(() => town.stop());
  // 架构师：远处的区域要同时打通路口
  const region = { op: 'addRegion', args: { id: 'north_hill', name: '北山', biome: 'forest', areas: [{ id: 'nh_a', places: [{ id: 'nh_camp', kind: 'camp', name: '山顶营地' }] }] } };
  assert.match(town.proposalSystem.prepare([region]).error, /linkRegions/);
  const r = town.proposalSystem.prepare([region, { op: 'linkRegions', args: { region: 'north_hill', open: true, entry: 'forest_path', gateName: '北山山口' } }]);
  assert.ok(!r.error, r.error);
  for (const o of r.ops) town.applyWorldOp(o);
  town.openRegion('north_hill', true);
  const red = walkTo(town, town.byId.red, 'nh_camp');
  assert.equal(red.region, 'north_hill');
  const text = [...town.logs.map((l) => l.text), ...red.memories.map((m) => m.text)].join('\n');
  assert.ok(text.includes('北山'));
  assert.ok(!/暗月界|月之渡口/.test(text), '没有暗月界的字样');
  assert.ok(red.memories.some((m) => m.text.includes('第一次穿过北山山口，来到了北山')));
});

// ---------- E7 需求驱动 ----------
test('地图压力表：选址失败、住处满员、破败、闲置、走得远各自引出相应的意图；每两天最多交给架构师一个', (t) => {
  const town = redTown();
  t.after(() => town.stop());
  const mp = town.mapPressure;
  mp.compute();
  assert.equal(mp.top(), null, '刚开始没有明显的需求');
  // 走得远：第 1 天平均 10 格，之后变成 15 格
  mp.walk(10); mp.walk(10);
  town.t += 1440; mp.walk(15);
  town.t += 1440; mp.walk(15);
  town.t += 1440;
  assert.equal(mp.compute().walkRatio, 1.5);
  assert.equal(mp.top().key, 'walk');
  // 闲置：五天没人去、没人住、没人工作的建筑
  mp.st.visits[1] = { red_house: 3 };
  town.t += 3 * 1440;
  assert.ok(mp.compute().idle.some((x) => x.id === 'bakery') === false, '妈妈在面包房工作，不算闲置');
  town.applyWorldOp({ op: 'renovateBuilding', args: { id: 'bakery', name: '旧仓库' } });
  town.byId.mom.work = 'village_square';
  persona(town, 'mom').work = 'village_square';
  assert.ok(mp.compute().idle.some((x) => x.id === 'bakery'));
  assert.equal(mp.top().key, 'idle');
  // 破败：受损三天
  town.applyWorldOp({ op: 'setBuildingState', args: { id: 'red_house', state: 'damaged' } });
  town.t += 3 * 1440;
  assert.equal(mp.top(mp.compute()).key, 'decay');
  // 空地紧张优先于破败；住处紧张最优先
  mp.placeFailed(); mp.placeFailed();
  assert.equal(mp.top(mp.compute()).key, 'space');
  mp.homeFull(); mp.homeFull();
  assert.equal(mp.top(mp.compute()).key, 'homes');
  assert.match(mp.text(), /地图现状/);
  // 交给架构师：来源是地图压力表；两天之内不再交
  town.architectQueue = [];
  mp.daily();
  assert.equal(town.architectQueue.length, 1);
  assert.equal(town.architectQueue[0].origin, 'planner');
  assert.match(town.architectQueue[0].intent, /住处快住满了/);
  town.architectQueue = [];
  town.t += 1440;
  mp.daily();
  assert.equal(town.architectQueue.length, 0, '两天之内不再交');
  assert.ok(town.proposalsView().pressure.top);
});

test('架构师的扩展每 7 天最多一次（管理员不受限制）；人员流动找不到空房时记入压力表', async (t) => {
  const town = redTown();
  t.after(() => town.stop());
  const ps = town.proposalSystem;
  const { proposal: p } = ps.submit({ title: '往南长', ops: [EXT('south', 8, { places: [] })] });
  for (let i = 0; i < 20 && p.status === 'review'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(ps.decide(p.id, true, 'admin'), null);
  assert.equal(p.status, 'applied', p.result?.reason);
  assert.match(ps.prepare([EXT('north', 8, { places: [] })], ARCHITECT_OPS).error, /7 天之内不再扩展/);
  assert.ok(!ps.prepare([EXT('north', 8, { places: [] })], ADMIN_OPS).error, '管理员直接提交不受限制');
  // 住处全满
  town.migration.homes = () => [{ id: 'red_house', name: '小红帽家', residential: true, n: 3 }, { id: 'grandma_house', name: '外婆家', residential: true, n: 3 }];
  const before = town.mapPressure.st.homeFull.length;
  town.migration.pickHome(null);
  assert.equal(town.mapPressure.st.homeFull.length, before + 1);
});
