// AI 表现指标：约定兑现按「人」计、重复约只算一次、对话重复率、兜底率
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'LLM_PROVIDER']) delete process.env[k];
const { Town } = await import('../server/sim.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-metrics-'));
const tick = () => new Promise((r) => setImmediate(r));
async function runTo(town, minute) {
  town.speed = 10;
  while (town.minute < minute) { town.advance(0.1); await tick(); }
}

test('两个人约了同一件事：各算一次，都到场就是 100%；同一个约定重复约只算一次', async (t) => {
  const town = new Town({ dataDir: tmp(), instantTalk: true, pacing: false });
  t.after(() => town.stop());
  await runTo(town, 18 * 60);
  const c = { time: '19:00', location: 'tavern', activity: '一起喝一杯', emoji: '🍺', duration: 60 };
  for (const id of ['lin', 'su']) assert.ok(town.addCommitment(town.byId[id], c));
  town.addCommitment(town.byId.lin, c); // 重复约
  let m = town.metricsView();
  assert.equal(m.commitments.pending, 2, '还没到时间的不算失约');
  assert.equal(m.commitments.made, 0);
  // 不让他们半路聊起来耽误赴约
  town.checkConversations = () => {};
  await runTo(town, 19 * 60 + 50);
  m = town.metricsView();
  assert.deepEqual([m.commitments.made, m.commitments.kept, m.commitments.keptRate], [2, 2, 1]);
});

test('对话重复率：同一对人两天内摘要相近算重复；兜底台词不参与比较', () => {
  const town = new Town({ dataDir: tmp() });
  const c = (t, a, b, summary, fallback) => ({ t, a, b, summary, lines: [], ...(fallback ? { fallback } : {}) });
  town.convoLog = [
    c(100, 'lin', 'su', '两人聊起湖边的紫光，约好晚上去酒馆'),
    c(200, 'su', 'lin', '两人又聊起湖边的紫光，约好晚上去酒馆'), // 重复
    c(300, 'lin', 'su', '林晓雨请苏墨帮忙查县志'), // 不重复
    c(400, 'lin', 'su', '随便寒暄', true), // 兜底，不参与
    c(5000, 'lin', 'su', '林晓雨请苏墨帮忙查县志'), // 距上次太久，不比较
    c(5100, 'he', 'zhao', '何月找赵铁柱做灯笼'), // 没有上一次
  ];
  const m = town.metricsView();
  assert.deepEqual([m.convos.compared, m.convos.repeats, m.convos.repeatRate], [2, 1, 0.5]);
  town.stop();
});

test('没有模型时规划全部是兜底；指标随存档保存', async (t) => {
  const dir = tmp();
  const town = new Town({ dataDir: dir, instantTalk: true, pacing: false });
  await runTo(town, 7 * 60);
  for (let i = 0; i < 5; i++) await tick();
  const m = town.metricsView();
  assert.equal(m.plans.total, 8);
  assert.equal(m.plans.fallbackRate, 1);
  town.save();
  town.stop();
  const again = new Town({ dataDir: dir });
  t.after(() => again.stop());
  assert.deepEqual(again.metricsView().plans, m.plans);
});
