// 全局进化引擎，按世界开启（多世界设计 §9、M8）：世界轮转、每个世界最多 1 个任务、预算按世界、
// 插件目录按世界隔离（A 世界的插件不会出现在 B 世界）、用户世界的流水线用它自己的世界包、旧目录迁移
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const llm = await import('../server/llm.js');
const { paths, Budget, rotation, readJSON, saveJobs } = await import('../evolution/common.js');
const { makeLLM } = await import('../evolution/llm.js');
const { runJob, currentSpec } = await import('../evolution/pipeline.js');
const { discover } = await import('../evolution/discover.js');
const { Town } = await import('../server/sim.js');
const { loadPack } = await import('../server/worlds/pack.js');
const { migrateEvolution } = await import('../server/worlds/migrate.js');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'evolved');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-evo-worlds-'));
const fixture = (key) => Object.fromEntries(['plugin.json', 'server.js', 'test.js', 'content.json'].filter((f) => fs.existsSync(path.join(FIX, key, f))).map((f) => [f, fs.readFileSync(path.join(FIX, key, f), 'utf8')]));

test('世界轮转：从上次的下一个开始，跳过已经有任务在进行的世界', () => {
  const worlds = [{ id: 'yunxi' }, { id: 'little-red' }, { id: 'three-pigs' }];
  assert.deepEqual(rotation(worlds, [], null).map((w) => w.id), ['yunxi', 'little-red', 'three-pigs']);
  assert.deepEqual(rotation(worlds, [], 'yunxi').map((w) => w.id), ['little-red', 'three-pigs', 'yunxi']);
  assert.deepEqual(rotation(worlds, [{ status: 'running', worldId: 'three-pigs' }], 'yunxi').map((w) => w.id), ['little-red', 'yunxi']);
  assert.deepEqual(rotation(worlds, [{ status: 'running' }], null).map((w) => w.id), ['little-red', 'three-pigs'], '旧任务没有 worldId 时算官方世界');
});

test('目录与预算按世界：任务、账本全站共用；一个世界的预算用完不影响别的世界', () => {
  const root = tmp();
  const A = paths({ dataRoot: root, world: 'little-red' });
  const B = paths({ dataRoot: root, world: 'three-pigs' });
  assert.equal(A.plugins, path.join(root, 'worlds', 'little-red', 'plugins'));
  assert.equal(A.evo, path.join(root, 'worlds', 'little-red', 'evolution'));
  assert.equal(A.jobs, B.jobs, '任务全站共用');
  assert.equal(A.jobs, path.join(root, 'evolution', 'jobs.json'));
  new Budget(A, 1000).add(1000);
  assert.equal(new Budget(A, 1000).left(), 0);
  assert.equal(new Budget(B, 1000).left(), 1000);
  // 一个世界有任务在进行时，只有它自己不发现新需求
  saveJobs(A, [{ id: 'j1', worldId: 'little-red', status: 'running', need: {} }]);
  assert.equal(discover(A, { ideas: true }), null);
  assert.ok(discover(B, { ideas: true }), '别的世界照常');
});

function mockAgents(script) {
  llm.setMock((messages) => {
    const role = Object.keys(script).find((r) => messages[0].content.includes(`你的角色：${r}`)) || '?';
    const v = script[role];
    if (v === undefined) throw new Error(`没有为「${role}」准备回复`);
    return JSON.stringify(v);
  });
}

test('用户世界的流水线：用它自己的世界包；插件装在它自己的目录，只有它自己加载（A 世界的插件不会出现在 B 世界）', { timeout: 180_000 }, async (t) => {
  t.after(() => llm.setMock(null));
  const root = tmp();
  const packDir = path.resolve('worlds/little-red');
  const A = paths({ dataRoot: root, world: 'little-red', packDir });
  assert.equal(currentSpec(A).meta.name, '小红帽', '需求与实施看到的是这个世界的规格');
  const tea = fixture('tea-leaf@1.0.0');
  mockAgents({
    技术策划: { id: 'tea-leaf', title: '新茶', tier: 'T0', summary: '新增物品：新茶', rfc: '## 动机\n外婆想喝新茶\n## 验收标准\n- 出现物品' },
    '需求评审 Agent': { verdict: 'approve', issues: [] },
    '实施 Agent': { files: { 'plugin.json': JSON.parse(tea['plugin.json']), 'content.json': JSON.parse(tea['content.json']) }, notes: '' },
    世界观审查员: { verdict: 'pass', findings: [] },
    安全审查员: { verdict: 'pass', findings: [] },
  });
  const job = await runJob({ P: A, llm: makeLLM(new Budget(A, 0), { worldId: 'little-red' }) }, { source: 'gap', text: '外婆想喝新茶', count: 3, gapKey: '新茶' });
  assert.equal(job.status, 'submitted', job.reason);
  assert.equal(job.worldId, 'little-red');
  assert.ok(fs.existsSync(path.join(A.plugins, 'tea-leaf@1.0.0')), '装在 A 世界自己的插件目录');
  assert.ok(readJSON(A.verified, {})['tea-leaf@1.0.0']?.passed);
  assert.ok(fs.readFileSync(A.ledger, 'utf8').includes('"world":"little-red"'), '账本记下是哪个世界');
  llm.setMock(null);

  const pack = loadPack(packDir);
  const worldA = new Town({ dataDir: A.data, worldId: 'little-red', pack, instantTalk: true, evolution: { dir: A.evo, pluginsDir: A.plugins, config: { mode: 'auto' } } });
  const Bp = paths({ dataRoot: root, world: 'three-pigs' });
  const worldB = new Town({ dataDir: Bp.data, worldId: 'three-pigs', pack, instantTalk: true, evolution: { dir: Bp.evo, pluginsDir: Bp.plugins, config: { mode: 'auto' } } });
  t.after(() => { worldA.stop(); worldB.stop(); });
  worldA.evolved.tick();
  worldB.evolved.tick();
  assert.ok(worldA.decisions.find('plugin', 'tea-leaf@1.0.0'), 'A 世界开了决策项（owner 终审）');
  assert.equal(worldB.decisions.find('plugin', 'tea-leaf@1.0.0'), undefined, 'B 世界看不到');
  assert.deepEqual(Object.keys(worldB.evolved.state.plugins), []);
});

test('迁移：官方世界的插件与登记从旧目录移到 data/worlds/yunxi/，任务与账本留在全站目录', () => {
  const data = tmp();
  const repo = tmp();
  fs.mkdirSync(path.join(data, 'evolution', 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(data, 'evolution', 'registry.json'), '{"plugins":{"x@1.0.0":{"status":"active"}}}');
  fs.writeFileSync(path.join(data, 'evolution', 'jobs.json'), '[]');
  fs.mkdirSync(path.join(repo, 'plugins', 'evolved', 'x@1.0.0'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugins', 'evolved', 'x@1.0.0', 'plugin.json'), '{}');
  const r = migrateEvolution(data, repo);
  assert.ok(r.moved.includes('registry.json') && r.moved.includes('plugins/evolved'));
  assert.ok(fs.existsSync(path.join(data, 'worlds', 'yunxi', 'evolution', 'registry.json')));
  assert.ok(fs.existsSync(path.join(data, 'worlds', 'yunxi', 'plugins', 'x@1.0.0', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(data, 'evolution', 'jobs.json')), '任务留在全站目录');
  assert.deepEqual(fs.readdirSync(path.join(repo, 'plugins', 'evolved')), [], '旧目录清空（目录本身保留，可能是挂载点）');
  assert.ok(fs.existsSync(path.join(r.backup, 'plugins-evolved', 'x@1.0.0')), '先备份');
  assert.equal(migrateEvolution(data, repo), null, '只迁移一次');
});
