// 暗月界的专属内容：到了当地才学会的能力、月露 / 月石 / 双月灯、许愿、花园安神与夜里的寒意
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER', 'MODS']) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const llm = await import('../server/llm.ts');
const { defaultSpec, validateSpec } = await import('../server/kernel/spec.ts');
const { useAbility } = await import('../server/kernel/abilities.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-moon-'));
function newTown(hour = 20) {
  llm.setMock(null);
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  town.t = hour * 60;
  town.openRegion('moonrealm', true);
  return town;
}
/** 把居民放到某个地点（暗月界的地点会自动切到那边的地图） */
function put(town, ids, loc) {
  const region = town.locRegion(loc);
  const p = town.worldOf(region).locations[loc].spots[0];
  ids.forEach((id, i) => Object.assign(town.byId[id], { region, x: p.x + i, y: p.y, inside: null, locId: loc, status: 'acting', path: [], convoId: null }));
}
const enter = (town, id, loc) => { put(town, [id], loc); town.rules.onEnter(town.byId[id], loc); };

test('暗月界的物品、能力、法则都通过校验', () => {
  const spec = defaultSpec({});
  assert.deepEqual(validateSpec(spec), []);
  for (const id of ['moon_dew', 'moon_lantern']) assert.ok(spec.items[id], id);
  for (const id of ['gather_dew', 'share_dew', 'pick_moonstone', 'star_wish', 'craft_moon_lantern', 'release_moon_lantern']) assert.ok(spec.abilities.some((a) => a.id === id), id);
  assert.ok(spec.structures.moon_float.tags.includes('light'));
});

test('第一次走到暗月界的地点，影灵教会当地的能力；再去不会重复', () => {
  const town = newTown(10);
  const lin = town.byId.lin;
  assert.ok(!lin.abilities.includes('gather_dew'));
  enter(town, 'lin', 'moon_garden');
  assert.ok(lin.abilities.includes('gather_dew') && lin.abilities.includes('share_dew'));
  assert.ok(lin.memories.some((m) => m.text.includes('影灵教我用花瓣接月露')));
  assert.ok(!lin.memories.some((m) => m.text.includes(`从${lin.name}那里`)), '不会说成从自己那里学会');
  const n = lin.memories.length;
  enter(town, 'lin', 'moon_garden');
  assert.equal(lin.memories.length, n, '第二次来不再触发');
  enter(town, 'lin', 'moon_lookout');
  enter(town, 'lin', 'moon_plaza');
  for (const id of ['pick_moonstone', 'star_wish', 'craft_moon_lantern', 'release_moon_lantern']) assert.ok(lin.abilities.includes(id), id);
  town.stop();
});

test('采月露只能在月光花园，月露可以递给朋友', () => {
  const town = newTown(10);
  const lin = town.byId.lin, su = town.byId.su;
  enter(town, 'lin', 'moon_garden');
  put(town, ['lin'], 'cafe');
  assert.match(useAbility(town, lin, 'gather_dew').reason, /不适合/);
  put(town, ['lin', 'su'], 'moon_garden');
  assert.equal(useAbility(town, lin, 'gather_dew').ok, true);
  assert.equal(lin.inventory.moon_dew, 1);
  su.body.stamina = 40;
  su.body.conditions = ['疲惫'];
  const r = useAbility(town, lin, 'share_dew', 'su');
  assert.equal(r.ok, true, r.reason);
  assert.equal(lin.inventory.moon_dew, undefined);
  assert.equal(su.body.stamina, 55);
  assert.ok(!su.body.conditions.includes('疲惫'));
  assert.ok(su.memories.some((m) => m.text.includes('月露')));
  town.stop();
});

test('拾月石 → 扎双月灯 → 双月节在码头放灯，灯会照亮镇上', () => {
  const town = newTown(19);
  const he = town.byId.he, zhao = town.byId.zhao;
  for (const loc of ['moon_lookout', 'moon_plaza']) enter(town, 'he', loc);
  put(town, ['he'], 'moon_lookout');
  for (let i = 0; i < 2; i++) {
    assert.equal(useAbility(town, he, 'pick_moonstone').ok, true);
    he.cooldowns.pick_moonstone = 0;
  }
  assert.equal(he.inventory.moonstone, 2);
  put(town, ['he'], 'moon_plaza');
  assert.equal(useAbility(town, he, 'craft_moon_lantern').ok, true);
  assert.equal(he.inventory.moonstone, undefined);
  assert.equal(he.inventory.moon_lantern, 1);

  put(town, ['he', 'zhao'], 'pier');
  const before = zhao.body.courage;
  const r = useAbility(town, he, 'release_moon_lantern');
  assert.equal(r.ok, true, r.reason);
  assert.equal(he.inventory.moon_lantern, undefined);
  const lamp = town.entities.find((e) => e.type === 'moon_float');
  assert.ok(lamp && (lamp.region || 'town') === 'town', '灯放在镇上的码头');
  assert.equal(zhao.body.courage, Math.min(100, before + 6));
  assert.ok(zhao.memories.some((m) => m.text.includes('双月灯')));
  town.stop();
});

test('星坠许愿要等到傍晚，一天一次', () => {
  const town = newTown(15);
  const su = town.byId.su;
  enter(town, 'su', 'moon_lookout');
  assert.match(useAbility(town, su, 'star_wish').reason, /不适合/);
  town.t = 20 * 60;
  assert.equal(useAbility(town, su, 'star_wish').ok, true);
  assert.ok(su.memories.some((m) => m.text.includes('许了一个愿')));
  assert.match(useAbility(town, su, 'star_wish').reason, /冷却/);
  town.stop();
});

test('月光花园让人安神；深夜在暗月界没有灯会发怵，有灯就不会', () => {
  const town = newTown(23);
  const garden = town.spec.rules.find((r) => r.id === 'moon_garden_calm');
  const chill = town.spec.rules.find((r) => r.id === 'moon_dark_chill');
  put(town, ['lin'], 'moon_garden');
  put(town, ['chen'], 'cafe');
  const lin = town.byId.lin, chen = town.byId.chen;
  lin.body.stamina = 50;
  town.rules.fire(garden);
  assert.equal(lin.body.stamina, 52);

  lin.body.courage = 50; chen.body.courage = 50;
  town.rules.fire(chill);
  assert.equal(lin.body.courage, 47, '暗月界的深夜有点冷');
  assert.equal(chen.body.courage, 50, '镇上的人不受影响');

  lin.body.courage = 50;
  town.spawnStructure('moon_float', { x: lin.x, y: lin.y, inside: null, region: 'moonrealm' }, 60);
  town.rules.fire(chill);
  assert.equal(lin.body.courage, 50, '身边有灯就不怕');
  town.stop();
});
