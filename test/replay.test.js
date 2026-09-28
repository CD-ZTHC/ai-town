// 无头回放（设计文档 11.5）：用录制好的 LLM 回复，以 30 倍速跑 7 个游戏日，检查不变量。
// 随机数固定种子，失败时可以用 REPLAY_SEED=… mise run test 复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER', 'MODS', 'PUBLIC_MODE']) delete process.env[k];
const { Town } = await import('../server/sim.js');
const llm = await import('../server/llm.ts');
const { defaultSpec } = await import('../server/kernel/spec.ts');
const { replay } = await import('../server/kernel/ops.ts');
const { fixtureMock } = await import('./fixtures/llm/index.js');

const SEED = Number(process.env.REPLAY_SEED || 20260926);
const DAYS = 7;
const STEP = 0.1; // 真实秒；30 倍速下每步 3 个游戏分钟
const tick = () => new Promise((r) => setImmediate(r));

/** mulberry32：小而够用的可复现随机数 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

test(`回放 ${DAYS} 个游戏日：没有居民卡住、上限生效、世界操作可重放、存档可恢复（种子 ${SEED}）`, async (t) => {
  const random = Math.random;
  Math.random = seeded(SEED);
  const mock = fixtureMock();
  llm.setMock(mock);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-replay-'));
  const town = new Town({ dataDir: dir, instantTalk: true, pacing: false });
  t.after(() => { town.stop(); llm.setMock(null); Math.random = random; });

  const residents = town.agents.map((a) => a.id);
  const since = {}; // 每个角色进入当前状态的游戏时间
  const types = new Set();
  town.on('log', (l) => types.add(l.type));
  const problems = [];
  const check = (cond, msg) => { if (!cond && problems.length < 20) problems.push(`第${town.day}天 ${Math.floor(town.minute / 60)}时：${msg}`); };
  let checkedDay = 0;

  town.speed = 30;
  const end = town.t + DAYS * 1440;
  while (town.t < end) {
    town.advance(STEP);
    await tick();
    for (const a of town.agents) {
      const s = since[a.id];
      if (!s || s.status !== a.status) since[a.id] = { status: a.status, t: town.t };
      const dur = town.t - since[a.id].t;
      check(Number.isFinite(a.x) && Number.isFinite(a.y), `${a.name} 坐标异常`);
      const w = town.worldOf(a.region);
      check(a.x >= 0 && a.y >= 0 && a.x < w.W && a.y < w.H, `${a.name} 越界 (${a.x},${a.y}) @${a.region}`);
      check(!(a.status === 'walking' && dur > 180), `${a.name} 走了 ${Math.round(dur)} 分钟还没到`);
      check(!(a.status === 'chatting' && dur > 120), `${a.name} 聊了 ${Math.round(dur)} 分钟还没结束`);
    }
    // 每天中午：所有居民都有当天的日程
    if (town.minute >= 12 * 60 && checkedDay !== town.day) {
      checkedDay = town.day;
      for (const a of town.agents) if (a.kind !== 'creature') check(a.scheduleDay === town.day && a.schedule.length >= 3, `${a.name} 中午还没有今天的日程`);
    }
    check(town.entities.length <= 30, `构筑物 ${town.entities.length} 个，超过上限`);
    check(town.creatures.list.length <= 24, `生物 ${town.creatures.list.length} 只，超过上限`);
  }
  // 等残留的异步认知流程落地
  for (let i = 0; i < 20; i++) await tick();

  assert.deepEqual(problems, [], problems.join('\n'));
  assert.equal(town.day, DAYS + 1);
  for (const id of residents) assert.ok(town.byId[id] && [...town.agents, ...town.away].includes(town.byId[id]), `居民 ${id} 被移除了`);
  assert.ok(town.logs.length <= 400 && town.convoLog.length <= 120, '日志上限');
  for (const a of town.agents) assert.ok(a.memories.length <= 400, `${a.name} 记忆超过上限`);

  // 录制的回复确实被用上了，而且产生了对应的结果
  for (const label of ['规划一天', '对话', '内心独白', '写日记', '撰写日报', '叙事导演']) assert.ok(mock.calls[label] > 0, `没有调用过：${label}`);
  // 每天至少一期日报（剧情高潮时还会出号外）
  for (let d = 1; d <= DAYS; d++) assert.ok(town.newspapers.some((p) => p.day === d), `第${d}天没有日报`);
  for (const type of ['plan', 'convo', 'thought', 'diary', 'news', 'arc']) assert.ok(types.has(type), `没有出现过 ${type} 日志`);

  // 所有世界操作都记进了审计日志，并且从默认规格重放能得到同样的世界
  const journal = fs.readFileSync(path.join(dir, 'ops.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const logged = new Set(journal.filter((r) => r.seq).map((r) => r.seq));
  for (const rec of town.specOps) assert.ok(logged.has(rec.seq), `操作 #${rec.seq} ${rec.op} 没有写进审计日志`);
  const re = replay(defaultSpec(), town.specOps);
  assert.deepEqual(re.skipped, []);
  assert.deepEqual(re.spec, town.spec, '重放后的世界规格与运行中的不一致');

  // 存档往返
  town.save();
  const again = new Town({ dataDir: dir });
  t.after(() => again.stop());
  assert.equal(again.t, town.t);
  assert.deepEqual(again.spec, town.spec);
  assert.deepEqual(again.agents.map((a) => a.id).sort(), town.agents.map((a) => a.id).sort());
  for (const a of again.agents) assert.equal(a.memories.length, town.byId[a.id].memories.length, `${a.name} 的记忆没有完整恢复`);
  // AI 表现指标：数值合法，且用录制回复时有真实的约定、对话和线程数据
  const m = town.metricsView();
  t.diagnostic(`指标：${JSON.stringify({ commitments: m.commitments, convos: m.convos, plans: m.plans, threads: m.threads, json: { ...m.json, byLabel: undefined } })}`);
  for (const r of [m.commitments.keptRate, m.convos.repeatRate, m.convos.fallbackRate, m.plans.fallbackRate, m.threads.resolvedRate, m.json.failRate]) assert.ok(r === null || (r >= 0 && r <= 1), `比例越界：${r}`);
  assert.ok(m.commitments.made > 0 && m.commitments.kept > 0, '应该有约定，并且有人赴约');
  assert.ok(m.convos.total > 0 && m.convos.compared > 0, '应该有可比较的对话');
  assert.ok(m.plans.total >= 8 * DAYS * 0.9, '每人每天都有规划记录');
  assert.equal(m.json.failed, 0, '录制回复都是合法 JSON');
  assert.deepEqual(again.metricsView().commitments, m.commitments, '指标随存档恢复');
  t.diagnostic(`调用：${Object.entries(mock.calls).map(([k, n]) => `${k}×${n}`).join('，')}；世界操作 ${town.specOps.length} 条`);
});
