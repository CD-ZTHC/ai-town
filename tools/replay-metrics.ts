#!/usr/bin/env node
// 7 个游戏日的无头回放（固定随机种子 + 录制的模型回复），输出 AI 表现指标与最终状态的摘要。
// 用来确认重构没有改变模拟的行为（重构方案 §8.2：B5、B6 迁移前后对比）：
//   node tools/replay-metrics.ts > after.json；git stash；node tools/replay-metrics.ts > before.json；git stash pop；cmp before.json after.json
// 与 test/replay.test.ts 用同一个种子与录制回复；那边检查不变量，这里只输出可比较的结果。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = process.cwd();
for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER', 'MODS', 'PUBLIC_MODE', 'EMBED_MODEL']) delete process.env[k];
const { Town } = await import(`${root}/server/sim.ts`);
const llm = await import(`${root}/server/llm.ts`);
const { fixtureMock } = await import(`${root}/test/fixtures/llm/index.ts`);
llm.setMock(fixtureMock());
const town = new Town({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rm-')), instantTalk: true, pacing: false, seed: 20260926 });
town.speed = 30;
const end = town.t + 7 * 1440;
while (town.t < end) { town.advance(0.1); await new Promise((r) => setImmediate(r)); }
const m = town.metricsView();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 居民、日志等（只取来算摘要）
const state = {
  t: Math.round(town.t),
  agents: town.agents.map((a: Row) => [a.id, Math.round(a.x * 100), Math.round(a.y * 100), a.status, a.locId, a.memories.map((x: Row) => x.text), a.relations, a.inventory, a.abilities, a.beliefs.map((b: Row) => b.claim)]),
  logs: town.logs.map((l: Row) => [l.type, l.text]),
  specOps: town.specOps.map((r: Row) => [r.op, r.t]),
  story: town.story?.now?.value ?? null,
};
const h = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
console.log(JSON.stringify({ commitments: m.commitments, repeat: m.repeat, threads: m.threads, plans: m.plans, convos: m.convos, json: m.json, logs: town.logs.length, stateHash: h }));
town.stop();
process.exit(0);
