// P4：新增建筑（叠加与选址）、世界补丁提案与审批、施工、配额、设定考据、世界架构师、时光回溯
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER']) delete process.env[k];
const { Town, listSnapshots, restoreSnapshot } = await import('../server/sim.js');
const llm = await import('../server/llm.js');
const { buildWorld } = await import('../server/world.js');
const { defaultSpec } = await import('../server/kernel/spec.js');
const { findPlacement, checkPlacement } = await import('../server/kernel/placement.js');
const { ruleCheck } = await import('../server/worldai/canon.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-p4-'));
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
async function run(town, minutes, speed = 20) {
  town.speed = speed;
  const end = town.t + minutes;
  while (town.t < end) { town.advance(0.25); await tick(); }
}
function newTown(dir = tmp()) {
  llm.setMock(null);
  const town = new Town({ dataDir: dir, instantTalk: true });
  town.applyWorldOp({ op: 'setMeta', args: { storyteller: 'gentle' } }, { by: 'test' }); // 测试里不让剧情弧打扰
  town.t = 9 * 60;
  return town;
}
const TOWER = { id: 'star_tower', name: '观星塔', kind: 'tower', w: 3, h: 3, sign: '🔭', desc: '码头边可以看星星的小塔', lightAtNight: true, place: { near: 'pier' } };

test('新增建筑叠加在原地图上：其余部分逐格不变，门口可达，站位一个不少', () => {
  const s = defaultSpec({});
  const r = findPlacement(s, { id: 'star_tower', w: 3, h: 3, near: 'pier' });
  assert.ok(!r.error, r.error);
  const base = buildWorld({ buildings: s.buildings, locationInfo: s.locations });
  const def = { id: 'star_tower', name: '观星塔', kind: 'tower', x: r.x, y: r.y, w: 3, h: 3, added: true };
  const w = buildWorld({ buildings: [...s.buildings, def], locationInfo: { ...s.locations, star_tower: { name: '观星塔', emoji: '🔭', desc: '' } } });
  const b = w.buildings.find((x) => x.id === 'star_tower');
  assert.ok(b && w.locations.star_tower?.indoor === 'star_tower');
  assert.ok(w.walk[b.entrance.y * w.W + b.entrance.x], '门口可达');
  // 占地外扩 2 格以外（含小路）的物体保持不变
  const far = (o) => o.x < def.x - 2 || o.x > def.x + def.w + 1 || o.y < def.y - 2 || o.y > def.y + def.h + 3;
  assert.deepEqual(w.objects.filter(far).filter((o) => o.type !== 'lamp'), base.objects.filter(far).filter((o) => o.type !== 'lamp'));
  for (const [id, l] of Object.entries(base.locations)) assert.ok(w.locations[id].spots.length >= l.spots.length, id);
});

test('选址：压在建筑、湖面、道路上都会被拒绝；找不到空地时给出原因', () => {
  const s = defaultSpec({});
  assert.match(checkPlacement(s, { id: 'x', x: 34, y: 6, w: 3, h: 3 }), /占用|挨得/);
  assert.match(checkPlacement(s, { id: 'x', x: 54, y: 38, w: 3, h: 3 }), /不是可以建房/);
  assert.match(checkPlacement(s, { id: 'x', x: 12, y: 14, w: 4, h: 3 }), /不是可以建房/);
  assert.match(findPlacement(s, { id: 'x', w: 7, h: 6, near: 'farm', within: 4 }).error, /找不到/);
  assert.match(findPlacement(s, { id: 'x', w: 3, h: 3, near: 'moon' }).error, /未知地点/);
});

test('新建筑落地后：地图重建、成为可去的地点、居民会走进去；存档读档后仍在', async () => {
  const dir = tmp();
  const town = newTown(dir);
  let maps = 0;
  town.on('worldmap', () => maps++);
  const r = town.proposalSystem.prepare([{ op: 'addBuilding', args: TOWER }]);
  assert.ok(!r.error, r.error);
  town.applyWorldOp(r.ops[0], { by: 'test' });
  assert.equal(maps, 1);
  assert.ok(town.publicLocs().includes('star_tower'));
  assert.match(town.locListText(), /star_tower（观星塔：码头边可以看星星的小塔）/);
  // 让王小乐去新建筑
  const wang = town.byId.wang;
  Object.assign(wang, { scheduleDay: town.day, schedule: [{ start: 9 * 60, end: 12 * 60, location: 'star_tower', activity: '上塔看风景', emoji: '🔭', src: 'plan' }], curKey: null });
  await run(town, 90);
  assert.equal(wang.locId, 'star_tower');
  assert.equal(wang.inside, 'star_tower');
  // 不合法的位置直接拒绝
  assert.throws(() => town.applyWorldOp({ op: 'addBuilding', args: { ...TOWER, id: 'bad', name: '坏塔', x: 34, y: 6 } }, { by: 'test' }), /放不下/);
  town.save();
  town.stop();
  const again = new Town({ dataDir: dir });
  assert.ok(again.world.buildings.some((b) => b.id === 'star_tower'));
  assert.ok(again.world.locations.star_tower);
  again.stop();
});

test('提案（本地模式）：带施工的小改自动通过 → 工地 → 居民去施工 → 按时完工', async () => {
  const town = newTown();
  const { proposal: p, error } = town.proposalSystem.submit({ title: '码头观星塔', motive: '想在夜里看星星', ops: [{ op: 'addBuilding', args: TOWER }, { op: 'addCanon', args: { text: '镇民在码头边修了一座观星塔。' } }], origin: 'agent:wang', construction: { by: ['赵铁柱'], hours: 3 } });
  assert.ok(!error, error);
  assert.equal(p.level, 'minor');
  await flush();
  assert.equal(p.status, 'building');
  assert.ok(town.entities.some((e) => e.type === 'scaffold'));
  assert.ok(town.byId.zhao.schedule.some((e) => e.activity.startsWith('施工')));
  await run(town, 3 * 60 + 5);
  assert.equal(p.status, 'applied');
  assert.ok(town.world.buildings.some((b) => b.id === 'star_tower'));
  assert.ok(town.byId.wang.memories.some((m) => m.text.includes('我提议的「码头观星塔」实现了')));
  assert.equal(town.spec.lore.canon.at(-1).text, '镇民在码头边修了一座观星塔。');
  town.stop();
});

test('提案（本地模式）：大改等管理员确认；可以驳回；每日配额用完后排队到第二天', async () => {
  const town = newTown();
  const rule = { id: 'night_owl', name: '夜猫子', when: { every: 60 }, forEach: 'agent', if: 'hour >= 22', then: [{ op: 'stat', stat: 'stamina', add: -1, target: 'e' }] };
  const a = town.proposalSystem.submit({ title: '新法则', ops: [{ op: 'addRule', args: rule }] }).proposal;
  await flush();
  assert.equal(a.status, 'awaiting');
  assert.equal(town.proposalSystem.decide(a.id, true), null);
  assert.equal(a.status, 'applied');
  assert.ok(town.spec.rules.some((r) => r.id === 'night_owl'));

  const b = town.proposalSystem.submit({ title: '另一条', ops: [{ op: 'addRule', args: { ...rule, id: 'night_owl2', name: '夜猫子二' } }] }).proposal;
  await flush();
  assert.equal(town.proposalSystem.decide(b.id, false), null);
  assert.equal(b.status, 'rejected');

  const items = ['a', 'b', 'c', 'd'].map((k) => town.proposalSystem.submit({ title: `新天气${k}`, ops: [{ op: 'addWeather', args: { id: `w_${k}`, name: `天${k}`, emoji: '🌈' } }] }).proposal);
  await flush();
  assert.deepEqual(items.map((p) => p.status), ['applied', 'applied', 'applied', 'queued']);
  await run(town, 24 * 60, 40);
  assert.equal(items[3].status, 'applied', '第二天动工');
  town.stop();
});

test('提案（公网模式）：访客投票 → 管理员终审；无人终审会作废；微调直接通过', async () => {
  const town = newTown();
  town.proposalSystem.requireAdmin = true;
  const p = town.proposalSystem.submit({ title: '新物品', ops: [{ op: 'addWeather', args: { id: 'aurora', name: '极光', emoji: '🌌' } }] }).proposal;
  await flush();
  assert.equal(p.status, 'voting');
  assert.equal(town.proposalSystem.vote(p.id, 'ip1', true), null);
  assert.match(town.proposalSystem.vote(p.id, 'ip1', false), /投过/);
  town.proposalSystem.vote(p.id, 'ip2', false);
  town.t += 61; town.proposalSystem.tick();
  assert.equal(p.status, 'awaiting');
  assert.deepEqual(town.proposalSystem.tally(p), { yes: 1, no: 1 });
  assert.equal(town.proposalSystem.decide(p.id, true), null);
  assert.equal(p.status, 'applied');

  const q = town.proposalSystem.submit({ title: '没人管', ops: [{ op: 'addWeather', args: { id: 'mist2', name: '薄雾', emoji: '🌁' } }] }).proposal;
  await flush();
  town.t += 61; town.proposalSystem.tick();
  town.t += 1441; town.proposalSystem.tick();
  assert.equal(q.status, 'expired');
  assert.ok(!town.spec.weather.mist2, '作废的提案不会落地');

  const m = town.proposalSystem.submit({ title: '设定', ops: [{ op: 'addCanon', args: { text: '码头的木板是百年前铺的。' } }] }).proposal;
  await flush();
  assert.equal(m.status, 'applied', '微调直接通过');
  town.stop();
});

test('提案校验：不允许的操作、重名、找不到空地都会在提交时被拒绝', async () => {
  const town = newTown();
  const ps = town.proposalSystem;
  assert.match(ps.submit({ title: 'x', ops: [{ op: 'setMeta', args: { rating: 'epic' } }] }).error, /不允许/);
  assert.match(ps.submit({ title: 'x', ops: [{ op: 'addPersona', args: { id: 'x' } }] }).error, /不允许/);
  assert.match(ps.submit({ title: 'x', ops: [{ op: 'addBuilding', args: { ...TOWER, w: 7, h: 6, place: { near: 'farm', within: 4 } } }] }).error, /找不到/);
  assert.match(ps.submit({ title: 'x', ops: [] }).error, /没有任何操作/);
  // 与已有名字重复：考据官的规则检查驳回
  assert.deepEqual(ruleCheck(town.spec, [{ op: 'addItem', args: { name: '萤火灯' } }]), ['「萤火灯」这个名字已经存在']);
  const dup = ps.submit({ title: '重名', ops: [{ op: 'addItem', args: { id: 'lamp2', name: '萤火灯', emoji: '🏮' } }] }).proposal;
  await flush();
  assert.equal(dup.status, 'rejected');
  town.stop();
});

test('设定考据官（模拟模型）：判定明显矛盾时驳回，小瑕疵只作提示', async () => {
  const town = newTown();
  let calls = 0;
  llm.setMock((messages, opts) => {
    if (opts.label !== '设定考据') throw new Error('无');
    calls++;
    return JSON.stringify(messages.at(-1).content.includes('火山') ? { severity: 'major', issues: ['云溪镇没有火山'] } : { severity: 'minor', issues: ['名字略显突兀'] });
  });
  const bad = town.proposalSystem.submit({ title: '火山口', ops: [{ op: 'addItem', args: { id: 'lava', name: '火山石', emoji: '🌋', desc: '从火山里捡来的' } }] }).proposal;
  const ok = town.proposalSystem.submit({ title: '新物品', ops: [{ op: 'addItem', args: { id: 'shell', name: '湖贝', emoji: '🐚' } }] }).proposal;
  await flush();
  llm.setMock(null);
  assert.equal(calls, 2);
  assert.equal(bad.status, 'rejected');
  assert.match(bad.result.reason, /没有火山/);
  assert.equal(ok.status, 'applied');
  assert.deepEqual(ok.canon.issues, ['名字略显突兀']);
  town.stop();
});

test('世界架构师（模拟模型）：第一次补丁不合法 → 带着错误修正 → 提交；做不到的事记入心愿单并合并', async () => {
  const town = newTown();
  const prompts = [];
  let round = 0;
  llm.setMock((messages, opts) => {
    if (opts.label === '设定考据') return '{"severity":"none","issues":[]}';
    if (opts.label !== '世界架构师') throw new Error('无');
    prompts.push(messages.map((m) => m.content).join('\n'));
    if (/湖中央|湖岸线/.test(messages.at(-1).content)) return JSON.stringify({ gap: { need: '移动或改造湖岸地形', why: '想把码头往湖里延伸' } });
    round++;
    const near = round === 1 ? 'moon' : 'pier';
    return JSON.stringify({ title: '码头观星塔', motive: '小乐想看星星', ops: [{ op: 'addBuilding', args: { ...TOWER, place: { near } } }, { op: 'addCanon', args: { text: '码头边建起了观星塔。' } }], construction: null });
  });
  assert.equal(town.architect.enqueue('在码头边修一座观星塔', 'visitor'), null);
  town.architect.tick();
  await flush(20);
  assert.equal(round, 2, '修正了一轮');
  assert.match(prompts[1], /这份补丁有问题：.*未知地点/);
  assert.match(prompts[0], /「在码头边修一座观星塔」/);
  assert.match(prompts[0], /addBuilding/);
  const p = town.proposalSystem.list.at(-1);
  assert.equal(p.origin, 'visitor');
  assert.equal(p.status, 'building', '新建筑总要施工（默认铁柱，4 小时）');
  assert.deepEqual(p.construction.by, ['赵铁柱']);
  await run(town, 4 * 60 + 5);
  assert.equal(p.status, 'applied');
  assert.ok(town.world.buildings.some((b) => b.id === 'star_tower'));

  for (const intent of ['把码头移动到湖中央', '移动一下湖岸线']) {
    town.architect.enqueue(intent, 'admin');
    town.architect.tick();
    await flush(10);
  }
  llm.setMock(null);
  assert.equal(town.architect.gaps.length, 1, '相似的缺口合并');
  assert.equal(town.architect.gaps[0].count, 2);
  town.stop();
});

test('点子的来源与配额：导演节拍、居民聊天各自有每日上限', () => {
  const town = newTown();
  assert.equal(town.architect.enqueue('修一个湖边长椅', 'agent:lin'), null);
  assert.match(town.architect.enqueue('再修一个花坛', 'agent:chen'), /够多了/);
  for (let i = 0; i < 3; i++) assert.equal(town.architect.enqueue(`导演的点子${i}号`, 'director'), null);
  assert.match(town.architect.enqueue('导演的点子三号', 'director'), /够多了|太多了/);
  assert.ok(town.logs.some((l) => l.type === 'idea' && l.text.includes('林晓雨')));
  town.stop();
});

test('导演的 propose 节拍会把意图交给架构师', async () => {
  const town = newTown();
  const { runBeats } = await import('../server/story/beats.js');
  const r = runBeats(town, [{ kind: 'propose', intent: '为双月节准备一种新的灯' }], { ctx: { source: 'director' } });
  assert.equal(r.done, 1);
  assert.equal(town.architect.queue.at(-1).origin, 'director');
  town.stop();
});

test('时光回溯：列出快照、恢复前备份当前存档、恢复后回到过去；非法名称被拒', async () => {
  const dir = tmp();
  const town = newTown(dir);
  town.save();
  const [snap] = listSnapshots(dir);
  assert.ok(snap);
  const tBefore = town.t;
  town.applyWorldOp({ op: 'addWeather', args: { id: 'aurora', name: '极光', emoji: '🌌' } }, { by: 'test' });
  await run(town, 120);
  town.save();
  town.stop();
  const bak = restoreSnapshot(dir, snap.name);
  assert.ok(fs.existsSync(path.join(dir, bak)));
  const back = new Town({ dataDir: dir });
  assert.equal(back.t, tBefore);
  assert.ok(!back.spec.weather.aurora, '回溯后世界结构也回到过去');
  back.stop();
  assert.throws(() => restoreSnapshot(dir, '../save.json'), /不合法/);
  assert.throws(() => restoreSnapshot(dir, 'd999-23.json'), /不存在/);
});
