// 内存相关的防护（重构方案 §6.2~6.5）：试运行锁、embedding 缓存上限、Town 替换时的资源释放
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { withTrialSlot } = await import('../server/trial-lock.js');
const { createEmbedder } = await import('../server/embeddings.js');
const { memoryView, trackChild, sseStats } = await import('../server/memstat.js');
const { Town } = await import('../server/sim.js');
const { WorldHost } = await import('../server/worlds/host.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-mem-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('试运行锁：同时只有一个；失效的锁（持有进程已不在）会被接管', async () => {
  const dir = tmp();
  let running = 0, peak = 0;
  const job = async () => { running++; peak = Math.max(peak, running); await sleep(30); running--; return 'ok'; };
  const r = await Promise.all([1, 2, 3].map(() => withTrialSlot(dir, job, { pollMs: 5 })));
  assert.deepEqual(r, ['ok', 'ok', 'ok']);
  assert.equal(peak, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'trial.lock')), '用完释放');
  // 持有者进程已经退出的锁
  fs.writeFileSync(path.join(dir, 'trial.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  assert.equal(await withTrialSlot(dir, async () => 'taken', { pollMs: 5, waitMs: 1000 }), 'taken');
  // 仍然有效的锁：排队超时
  fs.writeFileSync(path.join(dir, 'trial.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  await assert.rejects(withTrialSlot(dir, async () => 1, { pollMs: 5, waitMs: 30 }), (e) => e.code === 'TRIAL_BUSY');
  // 出错也释放
  fs.rmSync(path.join(dir, 'trial.lock'));
  await assert.rejects(withTrialSlot(dir, async () => { throw new Error('boom'); }));
  assert.ok(!fs.existsSync(path.join(dir, 'trial.lock')));
});

test('embedding：进程内缓存有上限（LRU），持久层仍然能读回', async () => {
  const dir = tmp();
  const embed = async (texts) => ({ vectors: texts.map((t) => [t.length, 1, 2]) });
  const e = createEmbedder({ dir, embed, env: { EMBED_TIMEOUT_MS: '10000' } });
  const texts = Array.from({ length: 2600 }, (_, i) => `记忆 ${i}`);
  for (let i = 0; i < texts.length; i += 128) assert.equal(await e.ensure(texts.slice(i, i + 128)), true);
  assert.ok(e.persistent);
  // 早先的文本已经被挤出内存，但还能从 SQLite 读回
  assert.deepEqual([...e.vec(texts[0])], [texts[0].length, 1, 2]);
  e.close();
});

test('Town 替换：连续重置 20 次，计时器与活动句柄不增长', async () => {
  const dir = tmp();
  const host = new WorldHost({ id: 'yunxi', makeTown: () => new Town({ dataDir: dir }) });
  // 让一段对话停在「等待说完」的计时器上，并让世界进入休眠（休眠时计时器不倒计时）
  const town0 = host.town;
  town0.sleepReal(60_000);
  town0.idle = true;
  const count = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  host.reload({ save: false });
  const before = count();
  for (let i = 0; i < 20; i++) host.reload({ save: false });
  assert.ok(count() <= before, `计时器 ${before} → ${count()}`);
  assert.equal(town0.stopped, true);
  assert.equal(town0.sleepers.size, 0, '旧 Town 的对话计时器已释放');
  host.close({ save: false });
});

test('内存视图：服务进程、登记的子进程、SSE 积压', async () => {
  const { spawn } = await import('node:child_process');
  const child = trackChild('sandbox', spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']));
  const v = memoryView([{ clients: new Set([{ backlog: 2048 }, { backlog: 1024 }]) }]);
  assert.ok(v.process.rss > 0 && v.process.heapUsed > 0);
  assert.equal(v.byKind.sandbox.count, 1);
  assert.deepEqual(v.sse, { clients: 2, backlogKb: 3, maxBacklogKb: 2 });
  child.kill();
  await new Promise((r) => child.once('exit', r));
  assert.equal(memoryView([]).byKind.sandbox, undefined, '退出后注销');
  assert.equal(sseStats([]).clients, 0);
});
