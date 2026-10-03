// 参数化生成（多世界设计 §3.2、M5）：语义布局 → 地图；手写的「小红帽」世界包可以运行；运行中开辟新区域
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack, packSpec } = await import('../server/worlds/pack.ts');
const { validateSpec } = await import('../server/kernel/spec.ts');
const { solveLayout, buildLayoutRegion, layoutProblems } = await import('../server/worldgen/layout.ts');
const { findPlacement } = await import('../server/kernel/placement.ts');
const { findPath } = await import('../server/world.ts');
import { readWorldSave } from '../server/storage/save-io.ts';
type Region = import('../server/types/spec.ts').Region;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-layout-'));
const pack = loadPack('worlds/little-red');
const tick = () => new Promise((r) => setImmediate(r));

test('布局求解：确定性；建筑不重叠、至少隔一格；每个地点都连通', () => {
  const region = pack.map.regions[0] as Region;
  const a = solveLayout(region), b = solveLayout(region);
  assert.deepEqual(a.buildings, b.buildings);
  assert.deepEqual(a.problems, []);
  for (const x of a.buildings) for (const y of a.buildings) {
    if (x === y) continue;
    assert.ok(!(x.x < y.x + y.w + 1 && x.x + x.w + 1 > y.x && x.y < y.y + y.h + 1 && x.y + x.h + 1 > y.y), `${x.id} 与 ${y.id} 挨得太近`);
  }
  const spec = packSpec(pack);
  assert.deepEqual(validateSpec(spec), []);
  assert.deepEqual(layoutProblems(region, spec), []);
  const w1 = buildLayoutRegion(region, spec), w2 = buildLayoutRegion(region, spec);
  assert.deepEqual(w1.tiles, w2.tiles, '同一个种子逐格一致');
  assert.ok(w1.biomes!.some((x) => x.id === 'dark_forest'), '按区域的地貌调色');
  // 任意两个地点之间都能走到
  const pts = Object.values(w1.locations).map((l) => (l.indoor ? w1.buildings.find((b) => b.id === l.indoor)!.entrance : l.spots[0]));
  for (const p of pts.slice(1)) assert.ok(findPath(w1, pts[0].x, pts[0].y, p.x, p.y), '连通');
});

test('手写的「小红帽」世界包可以运行：居民按规则兜底过完两天，没有人卡住；存档往返', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir, worldId: 'little-red', pack, instantTalk: true, pacing: false, evolution: { dir: path.join(dir, 'evolution'), pluginsDir: path.join(dir, 'plugins') } });
  assert.equal(town.spec.voice.name, '小红帽');
  assert.equal(town.world.W, 64);
  assert.ok(town.world.biomes);
  const visited = new Set();
  town.speed = 30;
  const end = town.t + 2 * 1440;
  while (town.t < end) {
    town.advance(0.5);
    await tick();
    for (const a of town.agents) if (a.locId) visited.add(a.locId);
    for (const a of town.agents) assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
  }
  assert.ok(visited.has('grandma_house') && visited.has('red_house'), [...visited].join(','));
  assert.ok(visited.size >= 5, `居民去过的地方：${[...visited].join('、')}`);
  // 旅人在村口广场现身
  const v = town.avatars.join('u_test', '1.1.1.1', { name: '路人' });
  assert.equal(v.locId, 'village_square');
  town.save();
  town.stop();
  const again = new Town({ dataDir: dir, worldId: 'little-red', pack, instantTalk: true, pacing: false, evolution: { dir: path.join(dir, 'evolution'), pluginsDir: path.join(dir, 'plugins') } });
  assert.equal(Math.round(again.t), Math.round(town.t));
  assert.equal(readWorldSave(dir).packHash, pack.hash);
  again.stop();
});

test('运行中的世界：新增建筑在语义布局的地图上找得到位置；addRegion 开辟新区域，linkRegions 打通后居民能过去', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir, worldId: 'little-red', pack, instantTalk: true, pacing: false, evolution: { dir: path.join(dir, 'evolution'), pluginsDir: path.join(dir, 'plugins') } });
  const spot = findPlacement(town.spec, { id: 'tea_stall', name: '茶摊', w: 4, h: 3, near: 'village_square', within: 14 });
  assert.ok(!spot.error, spot.error!);
  town.applyWorldOp({ op: 'addBuilding', args: { id: 'tea_stall', name: '茶摊', kind: 'shop', x: spot.x, y: spot.y, w: 4, h: 3, roof: '#2e8b57' } }, { by: 'admin' });
  assert.ok(town.world.buildings.some((b) => b.id === 'tea_stall'));

  const reinit = [];
  town.on('reinit', () => reinit.push(1));
  assert.throws(() => town.applyWorldOp({ op: 'addRegion', args: { id: 'cave', name: '水晶洞', areas: [{ id: 'hall', places: [{ id: 'village_square', kind: 'clearing', name: '重名' }] }] } }), /已存在|不合法/);
  town.applyWorldOp({ op: 'addRegion', args: { id: 'crystal_cave', name: '水晶洞', biome: 'snow', areas: [{ id: 'hall', biome: 'snow', places: [{ id: 'crystal_hall', kind: 'clearing', name: '水晶大厅', emoji: '💎' }, { id: 'ice_pond', kind: 'pond', name: '冰湖' }] }] } }, { by: 'admin' });
  assert.ok(town.regions.crystal_cave, '新区域已生成');
  assert.equal(town.regionOpen('crystal_cave'), false, '默认关闭');
  assert.ok(!town.publicLocs().includes('crystal_hall'));
  town.applyWorldOp({ op: 'linkRegions', args: { region: 'crystal_cave' } }, { by: 'admin' });
  assert.equal(town.regionOpen('crystal_cave'), true);
  assert.ok(town.publicLocs().includes('crystal_hall'));
  assert.ok(reinit.length >= 2, '前端重新拿地图');
  assert.ok(town.initPayload().regions.crystal_cave);
  // 让小红帽过去：跨区域走路
  const red = town.byId.red;
  town.insertEntry(red, { start: Math.floor(town.minute) + 1, end: Math.floor(town.minute) + 300, location: 'crystal_hall', activity: '去水晶洞看看', emoji: '💎', src: 'commit' });
  town.speed = 30;
  for (let i = 0; i < 2000 && red.region !== 'crystal_cave'; i++) { town.advance(0.3); await tick(); }
  assert.equal(red.region, 'crystal_cave');
  town.save();
  town.stop();
  // 重放：操作历史里的新区域在读档后还在
  const again = new Town({ dataDir: dir, worldId: 'little-red', pack, instantTalk: true, pacing: false, evolution: { dir: path.join(dir, 'evolution'), pluginsDir: path.join(dir, 'plugins') } });
  assert.ok(again.regions.crystal_cave);
  again.stop();
});
