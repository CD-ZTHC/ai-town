// 自主演化 E0 / E1：钩子总线、内置插件（施工 / 架构师 / go-to）、统一决策队列与 AI 裁决官的硬规则
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER', 'PLUGINS_DISABLE']) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const llm = await import('../server/llm.ts');
const { opinion } = await import('../server/kernel/decisions.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-e1-'));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
function newTown(opts = {}) {
  llm.setMock(null);
  const town = new Town({ dataDir: tmp(), instantTalk: true, ...opts });
  town.applyWorldOp({ op: 'setMeta', args: { storyteller: 'gentle' } }, { by: 'test' });
  town.t = 9 * 60;
  return town;
}
const TOWER = { id: 'star_tower', name: '观星塔', kind: 'tower', w: 3, h: 3, place: { near: 'pier' }, sign: '🔭', desc: '看星星的小塔' };

/** 一个测试用的决策类型：记录执行结果 */
function testKind(town, { gate = null, yes = 0, no = 0 } = {}) {
  const done = [];
  town.decisions.register('test', {
    dossier: () => '测试决策', gates: () => gate, tally: () => ({ yes, no }),
    resolve: (d, r) => done.push(r), undo: () => null,
  });
  return done;
}
const expire = (town) => { for (const d of town.decisions.list) if (d.status === 'waiting') d.untilMs = 0; };

test('内置插件：施工、架构师、go-to 从插件目录加载；插件列表可查看', () => {
  const town = newTown();
  assert.deepEqual(town.plugins.view().map((p) => p.id), ['architect', 'construction', 'go-to']);
  assert.ok(town.architect, '架构师插件挂上了 town.architect');
  town.stop();
});

test('施工插件接管带新建筑的提案；停用施工插件后，提案获批即落地（内核兜底）', async () => {
  const a = newTown();
  const p = a.proposalSystem.submit({ title: '观星塔', ops: [{ op: 'addBuilding', args: TOWER }], construction: { by: ['赵铁柱'], hours: 2 } }).proposal;
  await flush();
  assert.equal(p.status, 'building', '施工插件接管');
  assert.ok(a.entities.some((e) => e.type === 'scaffold'));
  a.t = p.finishT; a.proposalSystem.tick();
  assert.equal(p.status, 'applied');
  a.stop();

  const b = newTown({ disablePlugins: ['construction'] });
  assert.ok(!b.plugins.has('construction'));
  const q = b.proposalSystem.submit({ title: '观星塔', ops: [{ op: 'addBuilding', args: TOWER }], construction: { by: ['赵铁柱'], hours: 2 } }).proposal;
  await flush();
  assert.equal(q.status, 'applied', '没有插件接管时直接落地');
  assert.ok(!b.entities.some((e) => e.type === 'scaffold'));
  b.stop();
});

test('停用架构师插件：居民的点子与访客建议不会出错', () => {
  const town = newTown({ disablePlugins: ['architect'] });
  assert.equal(town.architect, null);
  const [a, b] = town.agents;
  town.hooks.emit('conversation.end', { a, b, res: { idea: '在码头修个灯塔' } });
  assert.deepEqual(town.proposalsView().queue, []);
  town.stop();
});

test('钩子：整点 / 新的一天 / 到达地点都会通知插件；插件出错不影响内核', () => {
  const town = newTown();
  const seen = [];
  town.hooks.on('hour', (e) => seen.push(`h${e.hour}`), 't');
  town.hooks.on('dayStart', (e) => seen.push(`d${e.day}`), 't');
  town.hooks.on('hour', () => { throw new Error('boom'); }, 'bad');
  town.t = 23 * 60 + 59; town.hourHooks();
  town.t += 1; town.hourHooks();
  town.t += 60; town.hourHooks();
  assert.deepEqual(seen, ['d2', 'h0', 'h1']);
  assert.equal(town.hooks.errors.bad, 2);
  town.stop();
});

test('民意：有效票 ≥ 5 且一方 ≥ 2/3 才算明确', () => {
  assert.equal(opinion({ yes: 2, no: 2 }), 'neutral');
  assert.equal(opinion({ yes: 1, no: 3 }), 'neutral', '票数太少');
  assert.equal(opinion({ yes: 1, no: 4 }), 'against');
  assert.equal(opinion({ yes: 4, no: 2 }), 'for');
});

test('AI 裁决官：硬闸门只能驳回；明确民意不能被推翻；低置信度延期一次，第二次必须决定', async () => {
  const town = newTown();
  const done = testKind(town, { gate: '测试没通过' });
  let calls = 0;
  llm.setMock(() => { calls++; return '{"decision":"adopt","confidence":0.9,"reasons":["很好"]}'; });
  const d1 = town.decisions.open({ kind: 'test', ref: 'a', title: '有问题的插件', risk: 'low' });
  expire(town); town.decisions.tick(); await flush();
  assert.equal(d1.result.decision, 'reject');
  assert.equal(d1.result.by, 'rule');
  assert.equal(calls, 0, '硬闸门不问模型');

  // 访客明确反对：模型想采纳也不行
  town.decisionState = [];
  const done2 = testKind(town, { yes: 1, no: 5 });
  const d2 = town.decisions.open({ kind: 'test', ref: 'b', title: '访客不喜欢', risk: 'low' });
  expire(town); town.decisions.tick(); await flush();
  assert.equal(d2.result.decision, 'reject');
  assert.match(d2.result.reasons[0], /访客明确反对/);
  assert.equal(done2[0].adopt, false);

  // 低置信度 → 延期一次（再等一个窗口）→ 第二次必须决定
  testKind(town);
  llm.setMock(() => '{"decision":"adopt","confidence":0.3,"reasons":["说不准"]}');
  const d3 = town.decisions.open({ kind: 'test', ref: 'c', title: '说不准', risk: 'low' });
  expire(town); town.decisions.tick(); await flush();
  assert.equal(d3.status, 'waiting');
  assert.equal(d3.deferred, 1);
  assert.ok(d3.untilMs > Date.now(), '延期后重新等一个终审窗口');
  expire(town); town.decisions.tick(); await flush();
  assert.equal(d3.status, 'decided');
  assert.equal(d3.result.decision, 'reject', '第二次仍没把握：民意不支持就驳回');
  assert.equal(done.length, 1);
  llm.setMock(null);
  town.stop();
});

test('AI 裁决官：高风险需要守护者和推动者都同意；只要一个反对就驳回', async () => {
  const town = newTown();
  testKind(town);
  const roles = [];
  llm.setMock((messages) => {
    const guardian = messages[1].content.includes('守护者');
    roles.push(guardian ? 'guardian' : 'advocate');
    return guardian ? '{"decision":"reject","confidence":0.8,"reasons":["风险太大"]}' : '{"decision":"adopt","confidence":0.9,"reasons":["有趣"]}';
  });
  const d = town.decisions.open({ kind: 'test', ref: 'x', title: '代码插件', risk: 'high' });
  expire(town); town.decisions.tick(); await flush();
  assert.deepEqual(roles, ['guardian', 'advocate']);
  assert.equal(d.result.decision, 'reject');
  assert.equal(d.result.roles.length, 2);
  llm.setMock(null);
  town.stop();
});

test('AI 裁决官：回滚率过高时自动收紧，高风险项只能等管理员；管理员随时可以直接拍板', async () => {
  const town = newTown();
  testKind(town);
  for (let i = 0; i < 6; i++) town.decisions.list.push({ id: `old${i}`, kind: 'test', status: 'decided', result: { by: 'ai', decision: 'adopt' }, outcome: i < 3 ? 'rolledBack' : null });
  assert.equal(town.decisions.calibration().strict, true);
  llm.setMock(() => '{"decision":"adopt","confidence":0.95,"reasons":["好"]}');
  const d = town.decisions.open({ kind: 'test', ref: 'y', title: '高风险', risk: 'high' });
  expire(town); town.decisions.tick(); await flush();
  assert.equal(d.status, 'waiting', '收紧后不自动裁决高风险项');
  assert.equal(town.decisions.decide(d.id, { adopt: true }), null);
  assert.equal(d.result.by, 'admin');
  llm.setMock(null);
  town.stop();
});
