// 小镇整体：无头运行（不连接 LLM，走规则兜底）、存档往返、v1 存档迁移、世界操作持久化
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在导入 llm.js 之前清掉 LLM 配置，保证测试不会发出真实请求
for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING']) delete process.env[k];
const { Town } = await import('../server/sim.ts');
import { readWorldSave, removeSave } from '../server/storage/save-io.ts';
const { RUNTIME_KEYS } = await import('../server/sim/runtime.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-test-'));
const tick = () => new Promise((r) => setImmediate(r));

/** 以 speed 倍速推进 minutes 个游戏分钟，每步之间让出事件循环，让异步认知流程（全部失败走兜底）跑完 */
async function run(town: InstanceType<typeof Town>, minutes: number, speed = 30) {
  town.speed = speed;
  const end = town.t + minutes;
  while (town.t < end) {
    town.advance(0.5);
    await tick();
  }
}

test('无头运行两天：日程兜底、移动、对话兜底都能正常工作', async () => {
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  let convos = 0;
  town.on('log', (l) => { if (l.type === 'convo') convos++; });
  await run(town, 12 * 60 - (6 * 60 + 15)); // 到第一天中午
  const noon = town.agents.map((a) => a.status);
  assert.ok(noon.every((s) => s !== 'sleeping'), `中午不应有人在睡觉：${noon}`);
  assert.ok(town.agents.every((a) => a.scheduleDay === 1 && a.schedule.length >= 3), '每个人都应有当天日程');
  await run(town, 36 * 60);
  assert.equal(town.day, 3);
  assert.equal(town.agents.length, 8);
  for (const a of town.agents) {
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), `${a.name} 坐标异常`);
    assert.ok(a.x >= 0 && a.y >= 0 && a.x < town.world.W && a.y < town.world.H, `${a.name} 越界`);
  }
  assert.ok(convos > 0, '应该发生过对话（兜底台词）');
  assert.ok(town.logs.some((l) => l.type === 'weather' || l.type === 'system'));
  town.stop();
});

test('存档往返：时间、居民状态、新组件都能恢复，并生成快照', async () => {
  const dir = tmp();
  const a = new Town({ dataDir: dir, instantTalk: true });
  await run(a, 120);
  a.byId.zhao.growth.push({ day: 1, change: '决定少喝点酒' });
  a.byId.zhao.inventory.wood = 5;
  a.save();
  const t = a.t;
  a.stop();

  const b = new Town({ dataDir: dir });
  assert.equal(b.t, t);
  assert.deepEqual(b.byId.zhao.growth, [{ day: 1, change: '决定少喝点酒' }]);
  assert.equal(b.byId.zhao.inventory.wood, 5);
  assert.equal(b.byId.zhao.persona, a.byId.zhao.persona);
  assert.match(b.personaBlock(b.byId.zhao), /成长经历：第1天：决定少喝点酒/);
  await b.snapWriting;
  b.stop();
  assert.ok(fs.readdirSync(path.join(dir, 'snapshots')).length >= 1);
});

test('v1 存档自动迁移到 v2，并备份旧文件', () => {
  const dir = tmp();
  const legacy = new Town({ dataDir: dir });
  legacy.t = 1440 + 600;
  legacy.byId.lin.goal = '办好音乐会';
  legacy.save();
  legacy.stop();
  // 伪造成 v1 格式（升级前的 save.json）：没有版本外的新字段与新组件
  const file = path.join(dir, 'save.json');
  const d = readWorldSave(dir);
  d.v = 1;
  delete d.specOps;
  for (const ag of d.agents) for (const k of ['kind', 'body', 'inventory', 'abilities', 'beliefs', 'growth']) delete ag[k];
  removeSave(dir);
  fs.writeFileSync(file, JSON.stringify(d));

  const town = new Town({ dataDir: dir });
  assert.equal(town.t, 1440 + 600);
  assert.equal(town.byId.lin.goal, '办好音乐会');
  assert.deepEqual(town.byId.lin.body, { hp: 100, stamina: 100, courage: 50, conditions: [] });
  assert.deepEqual(town.byId.lin.growth, []);
  assert.ok(fs.readdirSync(dir).some((f) => /^save-v1-.*\.bak\.json$/.test(f)), '应备份 v1 存档');
  town.save();
  assert.equal(readWorldSave(dir).v, 2);
  assert.ok(!fs.existsSync(file), '导入数据库后 save.json 改名备份');
  assert.ok(fs.readdirSync(dir).some((f) => /^save-imported-.*\.bak\.json$/.test(f)));
  town.stop();
});

test('世界操作：生效、写日志、存档后重放仍在；非法操作不影响世界', () => {
  const dir = tmp();
  const a = new Town({ dataDir: dir });
  const events: Array<{ desc: string }> = [];
  a.on('world', (w) => events.push(w));
  a.applyWorldOp({ op: 'addWeather', args: { id: 'aurora', name: '极光', emoji: '🌌', render: { base: 'sunny', tint: '#3fd6a0' } } }, { by: 'admin' });
  a.applyWorldOp({ op: 'setParam', args: { name: 'walkSpeed', value: 4 } }, { by: 'admin' });
  assert.throws(() => a.applyWorldOp({ op: 'setParam', args: { name: 'walkSpeed', value: 40 } }));
  assert.equal(a.specOps.length, 2);
  assert.equal(events.length, 2);
  assert.match(events[0].desc, /极光/);
  assert.equal(a.params.walkSpeed, 4);
  a.setWeather('aurora');
  assert.equal(a.weather, 'aurora');
  assert.equal(fs.readFileSync(path.join(dir, 'ops.jsonl'), 'utf8').trim().split('\n').length, 2);
  a.save();
  a.stop();

  const b = new Town({ dataDir: dir });
  assert.equal(b.spec.weather.aurora.name, '极光');
  assert.equal(b.params.walkSpeed, 4);
  assert.equal(b.weather, 'aurora');
  assert.deepEqual(b.worldHistory().map((r) => r.seq), [1, 2]);
  b.stop();
});

test('初始化数据包含前端需要的规格信息', () => {
  const town = new Town({ dataDir: tmp() });
  const p = town.initPayload();
  assert.equal(p.spec.calendar.events[0].id, 'firefly');
  assert.equal(p.weathers.sunny.name, '晴朗');
  assert.equal(p.agents.length, 8);
  town.stop();
});

test('状态分离（P6）：居民的临时字段在 town.rt 里，不进存档；读写照常；读档后重置', () => {
  const dir = tmp();
  const a = new Town({ dataDir: dir });
  const lin = a.byId.lin;
  lin.path = [{ x: 1, y: 2 }];
  lin.thinking = 2;
  lin.convoId = 'c1';
  lin.bubble = { id: 1, text: '你好', kind: 'say', until: 0 };
  assert.deepEqual(a.rt.agents.lin!.path, [{ x: 1, y: 2 }], '数据在运行时对象里');
  assert.equal(a.rt.agents.lin!.thinking, 2);
  for (const k of RUNTIME_KEYS) assert.ok(!Object.keys(lin).includes(k), `${k} 不可枚举`);
  assert.ok(!('path' in JSON.parse(JSON.stringify(lin))));
  assert.throws(() => { delete (lin as unknown as Record<string, unknown>).path; }, TypeError, '访问器删不掉（删掉后再赋值会变回普通字段、写进存档）');
  const saved = a.saveData().agents.find((x) => x.id === 'lin')!;
  for (const k of RUNTIME_KEYS) assert.ok(!(k in saved), `存档里不应有 ${k}`);
  a.save();
  a.stop();
  const b = new Town({ dataDir: dir });
  assert.deepEqual(b.byId.lin.path, []);
  assert.equal(b.byId.lin.thinking, 0);
  assert.equal(b.byId.lin.convoId, null);
  assert.equal(b.byId.lin.bubble, null);
  b.stop();
});
