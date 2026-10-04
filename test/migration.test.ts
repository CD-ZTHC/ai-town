// 人员流动：每天掷骰子的节奏、新人到来（人物卡裁剪与审核、住处、存读档）、出门与约好的日子回来、
// 外来者定居、人数上限、剧情角色不参与、owner 请走的人导演不会叫回来
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const llm = await import('../server/llm.ts');
const { Town } = await import('../server/sim.ts');
const { loadPack } = await import('../server/worlds/pack.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-migration-'));
const pack = loadPack(path.resolve('worlds/little-red'));
const redTown = (dir = tmp(), opts = {}) => new Town({ dataDir: dir, worldId: 'little-red', pack, instantTalk: true, ...opts });
/** 模拟模型：只回答「人员流动」，其余调用给一个空对象 */
const answer = (res: unknown) => llm.setMock((messages, opts) => JSON.stringify(opts?.label === '人员流动' ? res : {}));
const NEWCOMER = {
  change: 'arrive', reason: '外婆生日快到了，需要人手',
  arrive: {
    name: '阿禾', age: 19, role: '采蜜人', from: '山那边的蜂场', why: '听说村里的蜂蜜最好，想来学手艺',
    persona: '爽朗、手脚麻利，说话带着山里的口音，最怕蛇。', goal: '找到最好的野蜂巢', home: 'red_house', work: 'bakery', at: 'village_square',
    memories: ['路上遇见过一只灰色的大尾巴'], relations: { 妈妈: [20, '面包房的老板娘，看起来很和气'] },
    look: { skin: '#e8b896', hairStyle: 'short', shirt: 'not-a-color', acc: ['strawhat', 'laser'] },
  },
};

test('节奏：两次变动至少间隔平均间隔的 3/4，之后每天按概率发生', (t) => {
  const town = redTown(tmp(), { random: () => 0 });
  t.after(() => town.stop());
  const m = town.migration;
  m.st.lastDay = town.day;
  assert.equal(m.roll(), false, '刚变动过');
  town.t += 2 * 1440;
  assert.equal(m.roll(), false, '第 3 天还在冷却（平均 4 天，至少间隔 3 天）');
  town.t += 1440;
  assert.equal(m.roll(), true);
  m.random = () => 0.9;
  assert.equal(m.roll(), false, '冷却之后按概率');
});

test('新人到来：人物卡裁剪后以外来者身份登场，住进住处，居民听说了；存读档后还在', async (t) => {
  t.after(() => llm.setMock(null));
  const dir = tmp();
  const town = redTown(dir);
  const before = town.agents.length;
  answer(NEWCOMER);
  const r = await town.migration.decide();
  assert.equal(r.change, 'arrive', JSON.stringify(r));
  const p = town.spec.personas.find((x) => x.id === r.id);
  assert.equal(p!.kind, 'traveller');
  assert.equal(p!.tier, 'support');
  assert.equal(p!.traveller!.origin, '山那边的蜂场');
  assert.equal(p!.home, 'red_house');
  assert.match(p!.look.shirt, /^#[0-9a-f]{6}$/, '不合法的颜色换成默认值');
  assert.deepEqual(p!.look.acc, ['strawhat'], '不认识的部件被丢掉');
  assert.equal(town.agents.length, before + 1);
  const a = town.byId[r.id!];
  assert.equal(a.locId, 'village_square');
  assert.equal(a.relations.mom.affinity, 20);
  assert.ok(town.logs.some((l) => l.type === 'arrival' && l.text.includes('阿禾') && l.text.includes('森林村')), '编年用世界自己的地名');
  assert.ok(town.byId.red.memories.some((m) => m.text.includes('阿禾')), '居民听说来了新人');
  assert.equal(town.migration.st.lastDay, town.day);
  town.save();
  town.stop();
  const again = redTown(dir);
  t.after(() => again.stop());
  assert.ok(again.byId[r.id!] && again.agents.includes(again.byId[r.id!]), '读档后新人还在');
  assert.equal(again.migrationState!.arrived[r.id!].from, '山那边的蜂场');
});

test('人物卡没有通过审核（与支柱设定冲突）时不会登场', async (t) => {
  t.after(() => llm.setMock(null));
  const town = redTown();
  t.after(() => town.stop());
  answer({ ...NEWCOMER, arrive: { ...NEWCOMER.arrive, persona: '专门吃掉迷路的孩子' } });
  const r = await town.migration.decide('arrive');
  assert.ok(r.error, JSON.stringify(r));
  assert.ok(!town.spec.personas.some((p) => p.name === '阿禾'));
});

test('出门：从在场的人里消失，亲近的人记得；到了约好的日子白天回来', async (t) => {
  t.after(() => llm.setMock(null));
  const town = redTown();
  t.after(() => town.stop());
  answer({ change: 'leave', reason: '猎人要去镇上换火药', leave: { who: '猎人', where: '山下的镇子', why: '去换过冬的火药', days: 3, farewell: '看好小红帽' } });
  const r = await town.migration.decide('leave');
  assert.equal(r.change, 'leave', JSON.stringify(r));
  assert.equal(town.spec.personas.find((p) => p.id === 'hunter')!.status, 'departed');
  assert.ok(!town.agents.includes(town.byId.hunter));
  assert.ok(town.logs.some((l) => l.type === 'depart' && l.text.includes('山下的镇子')));
  assert.ok(town.byId.red.memories.some((m) => m.text.includes('看好小红帽')), '亲近的人记住了临别的话');
  assert.equal(town.migration.options().includes('leave'), false, '同时出门的人不超过初始人数的 20%（5 人 → 1 人）');
  // 还没到日子
  town.t = (town.day - 1) * 1440 + 10 * 60;
  town.migration.tick();
  assert.equal(town.spec.personas.find((p) => p.id === 'hunter')!.status, 'departed');
  town.t += 3 * 1440;
  town.migration.tick();
  assert.equal(town.spec.personas.find((p) => p.id === 'hunter')!.status, 'active', '到了约好的日子回来了');
  assert.ok(town.agents.includes(town.byId.hunter));
  assert.ok(town.logs.some((l) => l.type === 'arrival' && l.text.includes('回来了')));
});

test('定居：住满 5 天、有两位居民处得不错的外来者成为常住居民', async (t) => {
  t.after(() => llm.setMock(null));
  const town = redTown();
  t.after(() => town.stop());
  answer(NEWCOMER);
  const { id } = await town.migration.decide('arrive') as { id: string };
  town.t += 5 * 1440;
  town.migration.settleCheck();
  assert.equal(town.spec.personas.find((p) => p.id === id)!.kind, 'traveller', '还没有朋友');
  town.byId.red.relations[id] = { affinity: 30, note: '' };
  town.byId.grandma.relations[id] = { affinity: 25, note: '' };
  town.migration.settleCheck();
  const p = town.spec.personas.find((x) => x.id === id);
  assert.equal(p!.kind, 'resident');
  assert.equal(p!.origin, '山那边的蜂场');
  assert.equal(p!.traveller, undefined, '不再按刚来的外来者写提示词');
  assert.equal(town.byId[id].kind, 'resident');
  assert.ok(town.specOps.some((o) => o.op === 'settlePersona'), '可重放');
});

test('人数上限：在场人数到了初始人数的 1.5 倍就不再来新人', async (t) => {
  t.after(() => llm.setMock(null));
  const town = redTown();
  t.after(() => town.stop());
  assert.equal(town.migration.cap(), Math.ceil(town.migration.baseline() * 1.5));
  for (let i = 0; town.migration.options().includes('arrive'); i++) {
    answer({ ...NEWCOMER, arrive: { ...NEWCOMER.arrive, name: `新人${'甲乙丙丁戊己'[i]}` } });
    const r = await town.migration.decide('arrive');
    assert.equal(r.change, 'arrive', JSON.stringify(r));
    assert.ok(i < 10);
  }
  assert.equal(town.migration.activeCount(), town.migration.cap());
  const r = await town.migration.decide('arrive');
  assert.equal(r.change, 'none');
  // 住处：每处最多 3 人
  const occ = town.migration.occupancy();
  assert.ok(Object.values(occ).every((n) => n <= 3), JSON.stringify(occ));
});

test('剧情弧里的角色不参与人员流动（云溪镇的穿越者与守门人）', (t) => {
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  t.after(() => town.stop());
  const prot = town.migration.protectedIds();
  const cast = Object.keys(town.spec.arcs![0].cast!);
  assert.ok(cast.length && cast.every((id) => prot.has(id)));
  assert.ok(!town.migration.leaveCandidates().some((a) => prot.has(a.id)));
  assert.ok(!town.migration.view().people.some((p) => prot.has(p.id)));
});

test('owner 请走的人：导演不会把他叫回来，owner 可以召回', async (t) => {
  t.after(() => llm.setMock(null));
  const town = redTown();
  t.after(() => town.stop());
  assert.equal(town.migration.leave({ who: 'wolf' }, { by: 'owner' }).change, 'leave');
  assert.equal(town.migration.options().includes('return'), false);
  assert.ok(town.migration.recall('wolf', 'director').error);
  assert.equal(town.migration.recall('wolf', 'owner').change, 'return');
  assert.equal(town.spec.personas.find((p) => p.id === 'wolf')!.status, 'active');
  assert.ok(town.migration.view().history.some((h) => h.by === 'owner'));
});

test('世界设置里关掉人员流动后不再发生', (t) => {
  const town = redTown(tmp(), { worldSettings: { migration: false }, random: () => 0 });
  t.after(() => town.stop());
  assert.equal(town.migration.enabled(), false);
  town.t += 10 * 1440;
  town.migration.tick();
  assert.equal(town.migration.st.dueAt ?? null, null);
});

test('死者不占在世名额：dark 世界全员死亡、名册满 24 人之后仍会来新人；名册总数满了划去最早的死者', async (t) => {
  t.after(() => llm.setMock(null));
  const dir = tmp();
  const nw = loadPack(path.resolve('worlds/night-watch'));
  const nwTown = () => new Town({ dataDir: dir, worldId: 'night-watch', pack: nw, instantTalk: true, mods: [] });
  const town = nwTown();
  const look = town.spec.personas[0].look;
  let seq = 0;
  /** 来一个外来者然后让他死去 */
  const addDead = () => {
    const id = `ghost${++seq}`;
    town.applyWorldOp({ op: 'addPersona', args: { id, name: `过客${seq}`, role: '过客', persona: '沉默寡言', home: 'old_apartment', work: 'watch_office', look } }, { by: 'test' }, { quiet: true });
    town.applyWorldOp({ op: 'setPersonaStatus', args: { id, status: 'dead' } }, { by: 'test' }, { quiet: true });
  };
  for (const p of [...town.spec.personas]) town.applyWorldOp({ op: 'setPersonaStatus', args: { id: p.id, status: 'dead' } }, { by: 'test' }, { quiet: true });
  while (town.spec.personas.length < 24) addDead();
  town.syncAgents();
  assert.equal(town.migration.activeCount(), 0);
  assert.ok(town.migration.options().includes('arrive'), '以前 personas.length 达到 24 后 arrive 被永久排除');
  const card = { ...NEWCOMER.arrive, name: '守夜人', role: '外地来的更夫', from: '邻县', persona: '寡言、胆大，总提着一盏灯。', home: 'old_apartment', work: 'watch_office', at: 'plaza', relations: {} };
  answer({ change: 'arrive', reason: '城里没人了', arrive: card });
  const r1 = await town.migration.decide('arrive');
  assert.equal(r1.change, 'arrive', JSON.stringify(r1));
  assert.equal(town.spec.personas.length, 25);

  // 名册（含已故）满了：最早的死者（初始居民 lu）被划去，规格里别人对他的关系也一起清掉
  while (town.spec.personas.length < 48) addDead();
  assert.ok(town.spec.personas.some((p) => p.relations?.lu), '初始居民之间有关系');
  answer({ change: 'arrive', reason: '又来了一个', arrive: { ...card, name: '卖灯人' } });
  const r2 = await town.migration.decide('arrive');
  assert.equal(r2.change, 'arrive', JSON.stringify(r2));
  assert.equal(town.spec.personas.length, 48);
  assert.ok(!town.spec.personas.some((p) => p.id === 'lu'));
  assert.ok(!town.byId.lu && !town.away.some((a) => a.id === 'lu'));
  assert.ok(!town.spec.personas.some((p) => p.relations?.lu));
  assert.ok(town.specOps.some((o) => o.op === 'prunePersona' && o.args.id === 'lu'), '可重放');
  assert.throws(() => town.applyWorldOp({ op: 'prunePersona', args: { id: r2.id } }), /已故/, '只能划去死者');

  town.save();
  town.stop();
  const again = nwTown();
  t.after(() => again.stop());
  assert.equal(again.spec.personas.length, 48);
  assert.ok(again.byId[r2.id!] && !again.byId.lu, '读档后名册一致');
});
