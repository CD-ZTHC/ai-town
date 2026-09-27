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
const llm = await import('../server/llm.js');
const { judge } = await import('../server/worldai/council.js');
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
const { findPath } = await import('../server/world.js');
const { locationCenter } = await import('../server/kernel/placement.js');

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
