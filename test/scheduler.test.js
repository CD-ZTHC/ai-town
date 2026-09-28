// 统一 AI 调度（多世界设计 §7）：label → 级别、出队顺序、并发保留、按世界轮转、防饿死、公平补偿、额度拒绝、
// 调用归属（AsyncLocalStorage）、分层预算与降级、压测（一个世界刷聊天时另一个世界的心跳不被饿死）
import test from 'node:test';
import assert from 'node:assert/strict';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const settings = await import('../server/settings/index.ts');
const { classOf } = await import('../server/scheduler/classes.ts');
const { Scheduler } = await import('../server/scheduler/index.ts');
const { withContext } = await import('../server/scheduler/context.ts');
const { Ledger, budgetPolicy } = await import('../server/scheduler/budget.ts');
const { openDb } = await import('../server/accounts/db.js');
const llm = await import('../server/llm.js');

test('label → 级别：调度策略只有这一张表', () => {
  assert.equal(classOf('与旅人交谈'), 'P0');
  assert.equal(classOf('内容审核'), 'P0');
  assert.equal(classOf('昵称审核'), 'P0');
  assert.equal(classOf('规划一天'), 'P1');
  assert.equal(classOf('叙事导演'), 'P2');
  assert.equal(classOf('撰写日报'), 'P2');
  assert.equal(classOf('创世：阅读'), 'P3');
  assert.equal(classOf('进化：实施'), 'P4');
  assert.equal(classOf('插件：天文台'), 'P2');
  assert.equal(classOf('没见过的'), 'P2');
});

function harness({ limit = 4, allow = () => true, now = { t: 0 } } = {}) {
  const s = new Scheduler({ limit: () => limit, allow, now: () => now.t, agingMs: () => 1000 });
  const order = [];
  const add = (cls, worldId, name) => s.push({ cls, worldId, run: async () => {}, reject: (e) => order.push(`rejected:${name}:${e.message}`), name });
  const drain = (n = Infinity) => {
    const out = [];
    while (out.length < n) { const j = s.next(); if (!j) break; s.started(j); out.push(j); }
    return out;
  };
  return { s, add, drain, order, now };
}

test('出队：P0 → P4；同一级别内按世界轮转；只剩最后一个空位时留给 P0', () => {
  const { s, add, drain } = harness({ limit: 3 });
  add('P2', 'a', 'a-p2'); add('P1', 'a', 'a-p1-1'); add('P1', 'a', 'a-p1-2'); add('P1', 'b', 'b-p1');
  const got = drain();
  assert.deepEqual(got.map((j) => j.name), ['a-p1-1', 'b-p1'], '轮转到 b；第 3 个空位留给 P0');
  add('P0', 'c', 'c-p0');
  assert.deepEqual(drain().map((j) => j.name), ['c-p0']);
  for (const j of got) s.finished(j);
  assert.deepEqual(drain().map((j) => j.name), ['a-p1-2'], 'P1 先于 P2');
});

test('P3 / P4：合计最多 1 个并发，而且只在 P1 为空时；等太久的每 10 次出队保底 1 次', () => {
  const { s, add, drain, now } = harness({ limit: 8 });
  add('P4', 'a', 'evo'); add('P3', 'g', 'gen'); add('P1', 'b', 'beat');
  // P1 排着队时后台任务不出队；P1 出完之后，P3 与 P4 合计只占 1 个
  const first = drain();
  assert.deepEqual(first.map((j) => j.name), ['beat', 'gen']);
  for (const j of first) s.finished(j);
  // 防饿死：P1 一直有任务时，等太久的 P4 仍然每 10 次出队拿到 1 次
  now.t = 5000;
  for (let i = 0; i < 12; i++) add('P1', `w${i}`, `beat${i}`);
  const names = [];
  for (let i = 0; i < 12; i++) {
    const [j] = drain(1);
    if (!j) break;
    names.push(j.name);
    s.finished(j);
  }
  assert.ok(names.includes('evo'), `饿了很久的进化任务也能出队：${names.join(',')}`);
});

test('公平补偿：连续让路多的世界下次连续出队两次；额度用完的世界任务被拒绝，不阻塞别的世界', () => {
  const rejected = [];
  const { s, add, drain } = harness({ limit: 100, allow: (j) => (j.worldId === 'broke' ? '额度用完' : true) });
  s.push({ cls: 'P2', worldId: 'broke', run: async () => {}, reject: (e) => rejected.push(e.message), name: 'x' });
  for (let i = 0; i < 3; i++) s.noteYield('shy');
  add('P2', 'loud', 'l1'); add('P2', 'loud', 'l2'); add('P2', 'shy', 's1'); add('P2', 'shy', 's2'); add('P2', 'shy', 's3');
  const got = drain().map((j) => j.name);
  assert.deepEqual(rejected, ['额度用完']);
  assert.deepEqual(got.slice(0, 4), ['l1', 's1', 's2', 'l2'], '让路多的世界这一轮出队两次');
});

test('调用归属：llm.chat 从 AsyncLocalStorage 读世界与用户，账本按世界记账', async (t) => {
  const events = [];
  const off = llm.onUsage((e) => events.push(e));
  llm.setProvider({ name: 'fake', enabled: true, complete: async () => ({ content: 'ok', usage: { prompt: 10, completion: 5 } }) });
  t.after(() => { off(); llm.setProvider(null); });
  await withContext({ worldId: 'moon', userId: 'u_1' }, () => llm.chat([{ role: 'user', content: 'x' }], { label: '与旅人交谈' }));
  // 世界的主循环里发起的调用（例如定时器回调）也继承上下文
  await withContext({ worldId: 'star' }, () => new Promise((r) => setTimeout(() => r(llm.chat([], { label: '规划一天' })), 1)));
  assert.deepEqual(events.map((e) => [e.worldId, e.userId, e.cls, e.tokens]), [['moon', 'u_1', 'P0', 15], ['star', null, 'P1', 15]]);
});

test('分层预算：单个世界按授予的日额度降级（80% 停叙事、100% 退回规则、P0 多给 20%）；预览只有 20%；常驻不受限；暂停 AI', () => {
  settings._setForTest({ LLM_DAILY_TOKENS: 1_000_000, GENESIS_DAILY_WORLD_TOKENS: 1000, PINNED_WORLDS: ['yunxi'] });
  const ledger = new Ledger(openDb(':memory:'));
  const worlds = {
    yunxi: { id: 'yunxi', official: true, status: 'public', settings: {} },
    red: { id: 'red', ownerId: 'u', status: 'public', settings: {}, quota: {} },
    draft: { id: 'draft', ownerId: 'u', status: 'preview', settings: {}, quota: {} },
    frozen: { id: 'frozen', ownerId: 'u', status: 'public', settings: { aiPaused: true }, quota: {} },
  };
  const b = budgetPolicy({ ledger, world: (id) => worlds[id] || null, ownerGrant: () => null, globalUsed: () => 0 });
  const allow = (worldId, cls) => b.allow({ worldId, cls });
  assert.equal(allow('red', 'P2'), true);
  ledger.add({ worldId: 'red', cls: 'P1', tokens: 850 });
  assert.equal(b.level('red'), 'quiet');
  assert.match(allow('red', 'P2'), /暂停导演/);
  assert.equal(allow('red', 'P1'), true);
  ledger.add({ worldId: 'red', cls: 'P1', tokens: 200 });
  assert.match(allow('red', 'P1'), /规则驱动/);
  assert.equal(allow('red', 'P0'), true, '有人在等的聊天仍然可用');
  ledger.add({ worldId: 'red', cls: 'P0', tokens: 200 });
  assert.match(allow('red', 'P0'), /用完/);
  ledger.add({ worldId: 'draft', cls: 'P1', tokens: 210 });
  assert.equal(b.level('draft'), 'rules', '预览中的世界只有 20%');
  ledger.add({ worldId: 'yunxi', cls: 'P2', tokens: 500_000 });
  assert.equal(allow('yunxi', 'P2'), true, '常驻世界只受全局预算约束');
  assert.match(allow('frozen', 'P0'), /暂停/);
  // 重启后从数据库读回当天用量
  const again = new Ledger(ledger.db);
  assert.equal(again.world('red').total, 1250);
  settings._setForTest({});
});

test('压测：一个世界刷聊天时，另一个世界的心跳延迟在阈值内；总并发始终不超过上限', async (t) => {
  let inflight = 0, peak = 0;
  llm.setProvider({ name: 'slow', enabled: true, complete: async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 15)); inflight--; return { content: 'ok', usage: { prompt: 1, completion: 1 } }; } });
  t.after(() => llm.setProvider(null));
  const started = Date.now();
  const flood = [];
  for (let i = 0; i < 60; i++) flood.push(withContext({ worldId: 'busy' }, () => llm.chat([], { label: '与旅人交谈' })));
  const beats = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    beats.push(withContext({ worldId: 'calm' }, () => llm.chat([], { label: '规划一天' })).then(() => Date.now() - t0));
    await new Promise((r) => setTimeout(r, 20));
  }
  const waits = await Promise.all(beats);
  await Promise.all(flood);
  const floodMs = Date.now() - started;
  assert.ok(peak <= 4, `并发峰值 ${peak}`);
  // 刷屏的 60 个请求要花 ~450ms 以上；安静世界的心跳每个都应远快于此
  assert.ok(Math.max(...waits) < floodMs / 3, `心跳等待 ${waits.join('/')}ms，刷屏总耗时 ${floodMs}ms`);
});

test('进化引擎经 IPC 调用模型：进入主进程的统一队列（P4），记在世界名下，引擎自己不联网', async (t) => {
  const { fork } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { hostCall } = await import('../evolution/llm.js');
  const events = [];
  const off = llm.onUsage((e) => events.push(e));
  llm.setProvider({ name: 'fake', enabled: true, complete: async () => ({ content: '{"verdict":"ok"}', usage: { prompt: 20, completion: 10 } }) });
  t.after(() => { off(); llm.setProvider(null); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-ipc-'));
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, `
import { makeLLM } from ${JSON.stringify(path.resolve('evolution/llm.js'))};
let used = 0;
const llm = makeLLM({ left: () => Infinity, add: (n) => { used += n; } }, { worldId: 'little-red' });
const r = await llm.call('评审', [{ role: 'user', content: 'x' }], { review: true });
process.send({ type: 'done', r, used, enabled: llm.enabled() });
`);
  const child = fork(script, { env: { PATH: process.env.PATH, EVOLVE_IPC: '1', EVOLVE_LLM: '1' } });
  const done = await new Promise((resolve, reject) => {
    child.on('message', async (m) => {
      if (m.type === 'llm') {
        const r = await withContext({ worldId: m.worldId }, () => hostCall(m));
        child.send({ type: 'llm-result', id: m.id, ok: true, json: r.json, tokens: r.tokens });
      } else if (m.type === 'done') resolve(m);
    });
    child.on('error', reject);
  });
  child.kill();
  assert.deepEqual(done.r, { verdict: 'ok' });
  assert.equal(done.used, 30, '引擎自己的进化预算也记上了');
  assert.equal(done.enabled, true);
  assert.deepEqual(events.map((e) => [e.worldId, e.cls, e.label]), [['little-red', 'P4', '进化：评审']]);
});
