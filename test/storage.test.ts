// 存储（重构方案 P5）：存档在 world.db，每次只写变化的部分；快照是压缩的数据库（.db.gz）；
// 升级前的 save.json 与 .json / .json.gz 旧快照仍然可以导入、列出、回溯、分叉；保留份数各种格式一起算；指标只给当天保留去重用的 key
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'LLM_PROVIDER']) delete process.env[k];
const { Town, listSnapshots, restoreSnapshot } = await import('../server/sim.ts');
const { forkTimeline, timelineDir } = await import('../server/timelines.ts');
const { WorldStore } = await import('../server/storage/world-store.ts');
const { readWorldSave, readSnapshotFile, removeSave, copyWorldSave } = await import('../server/storage/save-io.ts');
const llm = await import('../server/llm.ts');
const { condenseCandidate, replaceWithSummary, ruleSummary } = await import('../server/memory.ts');
const { fixtureMock } = await import('./fixtures/llm/index.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-storage-'));
/** 存盘并等整点快照写完 */
async function saveAndSnap(town: InstanceType<typeof Town>) { town.save(); await town.snapWriting; }
/** 跟存档比较时去掉不稳定的部分：JSON 往返一次（undefined 字段消失） */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

test('存档写进 world.db；读回来与存盘内容一致；没有 save.json', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  town.byId.lin.goal = '办好音乐会';
  await saveAndSnap(town);
  const want = plain(town.saveData());
  town.stop();
  assert.ok(fs.existsSync(path.join(dir, 'world.db')));
  assert.ok(!fs.existsSync(path.join(dir, 'save.json')));
  assert.deepEqual(readWorldSave(dir), want);
});

test('增量写入：多天运行中反复存盘（记忆压缩、日志轮转、居民离开都会发生），数据库始终与整体写入的结果相同', async () => {
  llm.setMock(fixtureMock());
  try {
    const dir = tmp();
    const town = new Town({ dataDir: dir, instantTalk: true, pacing: false });
    town.speed = 30;
    const store = town.worldStore();
    let rewrites = 0;
    const orig = store.syncList.bind(store);
    store.syncList = (list, items) => { const n = orig(list, items); if (n > items.length) rewrites++; return n; };
    const end = town.t + 3 * 1440;
    let checks = 0;
    while (town.t < end) {
      town.advance(0.1);
      await new Promise((r) => setImmediate(r));
      // 每天清晨把前一天的琐碎记忆压缩成摘要（摘要插在列表中间，和真实的记忆压缩一样）
      if (Math.floor(town.t) % 1440 < 3 && town.t > 1440) {
        for (const a of town.agents) {
          const c = condenseCandidate(a, { minItems: 2, beforeDay: town.day });
          if (c) replaceWithSummary(a, c.items, { text: ruleSummary(c.day, c.items), day: c.day });
        }
      }
      if (Math.floor(town.t) % 180 < 3) {
        town.save();
        // 另开一份整体写入的数据库做对照
        const ref = tmp();
        const s = new WorldStore(ref);
        s.write(town.saveData(), { full: true });
        const want = s.readAll();
        s.close();
        assert.deepEqual(readWorldSave(dir), want, `第 ${checks} 次对照（t=${Math.floor(town.t)}）`);
        checks++;
      }
    }
    assert.ok(checks >= 10, `对照了 ${checks} 次`);
    assert.ok(rewrites > 0, '走到了「顺序变化 → 重写整个列表」的路径');
    assert.ok(town.agents.some((a) => a.memories.some((m) => m.type === 'summary')), '发生过记忆压缩');
    assert.equal(town.logs.length, 400, '动态流发生过轮转');
    // 反复存盘时只写变化：没有变化的第二次存盘什么都不写
    town.save();
    const stat = store.write(town.saveData());
    assert.deepEqual(stat, { kv: 0, items: 0 });
    town.stop();
  } finally { llm.setMock(null); }
});

test('每小时快照是压缩的数据库，内容与存档一致', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  await saveAndSnap(town);
  const [snap] = listSnapshots(dir);
  assert.match(snap.name, /^d001-06\.db\.gz$/);
  assert.deepEqual(readSnapshotFile(path.join(dir, 'snapshots', snap.name)), plain(town.saveData()));
  assert.ok(!fs.readdirSync(path.join(dir, 'snapshots')).some((f) => f.endsWith('.tmp')));
  town.stop();
});

test('升级前的 save.json：第一次启动时导入数据库，之后改名备份；内容不变', async () => {
  const dir = tmp();
  const a = new Town({ dataDir: dir });
  a.t = 1440 + 300;
  a.byId.lin.goal = '办好音乐会';
  a.log('event', '导入前的动态');
  a.save();
  const legacy = plain(a.saveData());
  a.stop();
  removeSave(dir);
  fs.writeFileSync(path.join(dir, 'save.json'), JSON.stringify(legacy));
  const b = new Town({ dataDir: dir });
  assert.equal(b.t, 1440 + 300);
  assert.equal(b.byId.lin.goal, '办好音乐会');
  assert.ok(b.logs.some((l) => l.text === '导入前的动态'));
  b.save();
  b.stop();
  assert.ok(!fs.existsSync(path.join(dir, 'save.json')));
  assert.equal(fs.readdirSync(dir).filter((f) => /^save-imported-.*\.bak\.json$/.test(f)).length, 1);
  assert.deepEqual(readWorldSave(dir).logs, legacy.logs);
  assert.deepEqual(readWorldSave(dir).agents.map((x: { memories: unknown }) => x.memories), legacy.agents.map((x: { memories: unknown }) => x.memories));
});

test('升级前的 .json / .json.gz 旧快照：能列出、回溯；同一整点有新快照时旧的被取代', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  await saveAndSnap(town);
  const snapDir = path.join(dir, 'snapshots');
  // 模拟旧版本留下的快照
  const old = plain(town.saveData());
  fs.writeFileSync(path.join(snapDir, 'd000-05.json'), JSON.stringify({ ...old, t: 5 * 60 }));
  fs.writeFileSync(path.join(snapDir, 'd000-04.json.gz'), zlib.gzipSync(JSON.stringify({ ...old, t: 4 * 60 })));
  assert.deepEqual(listSnapshots(dir).map((s) => s.name), ['d001-06.db.gz', 'd000-05.json', 'd000-04.json.gz']);
  const bak = restoreSnapshot(dir, 'd000-05.json');
  assert.match(bak, /^world-before-rollback-.*\.bak\.db$/);
  assert.equal(readWorldSave(dir).t, 5 * 60);
  restoreSnapshot(dir, 'd000-04.json.gz');
  assert.equal(readWorldSave(dir).t, 4 * 60);
  restoreSnapshot(dir, 'd001-06.db.gz');
  assert.equal(readWorldSave(dir).t, town.t);
  // 同一整点：新格式快照写入时删掉旧格式的
  fs.writeFileSync(path.join(snapDir, 'd001-07.json'), '{}');
  fs.writeFileSync(path.join(snapDir, 'd001-07.json.gz'), '{}');
  town.t = 7 * 60 + 5;
  await saveAndSnap(town);
  assert.ok(!fs.existsSync(path.join(snapDir, 'd001-07.json')));
  assert.ok(!fs.existsSync(path.join(snapDir, 'd001-07.json.gz')));
  assert.ok(fs.existsSync(path.join(snapDir, 'd001-07.db.gz')));
  assert.throws(() => restoreSnapshot(dir, 'd001-07.db.gz.bak'), /不合法/);
  town.stop();
});

test('回溯：损坏的快照不会替换存档', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  town.t = 600;
  await saveAndSnap(town);
  town.stop();
  fs.writeFileSync(path.join(dir, 'snapshots', 'd000-03.db.gz'), zlib.gzipSync('不是数据库'));
  fs.writeFileSync(path.join(dir, 'snapshots', 'd000-02.json'), '{坏的');
  assert.throws(() => restoreSnapshot(dir, 'd000-03.db.gz'));
  assert.throws(() => restoreSnapshot(dir, 'd000-02.json'));
  assert.equal(readWorldSave(dir).t, 600);
});

test('从数据库快照、旧快照、此刻（运行中）都能分出时间线', async () => {
  const root = tmp();
  const town = new Town({ dataDir: root });
  await saveAndSnap(town);
  const t0 = town.t;
  const old = plain(town.saveData());
  fs.writeFileSync(path.join(root, 'snapshots', 'd000-05.json'), JSON.stringify({ ...old, t: 5 * 60 }));
  const a = forkTimeline(root, { fromId: 'main', snapshot: 'd001-06.db.gz' });
  const b = forkTimeline(root, { fromId: 'main', snapshot: 'd000-05.json' });
  town.t += 90;
  town.save(); // 小镇还在运行（数据库开着、WAL 里有未合并的写入）
  const c = forkTimeline(root, { fromId: 'main' });
  assert.equal(readWorldSave(timelineDir(root, a.id)).t, t0);
  assert.equal(readWorldSave(timelineDir(root, b.id)).t, 5 * 60);
  assert.equal(readWorldSave(timelineDir(root, c.id)).t, town.t, '此刻分叉拿到最新的存盘');
  assert.equal(c.from!.hour, Math.floor((town.t % 1440) / 60));
  assert.ok(!fs.existsSync(path.join(timelineDir(root, a.id), 'save.json')));
  assert.throws(() => forkTimeline(root, { fromId: 'main', snapshot: '../save.json' }), /快照名称/);
  const fork = new Town({ dataDir: timelineDir(root, c.id) });
  assert.equal(fork.t, town.t);
  fork.stop();
  town.stop();
});

test('复制存档（影子试运行用）：运行中的数据库也得到一致的副本；旧的 save.json 原样复制', () => {
  const src = tmp();
  const town = new Town({ dataDir: src });
  town.t = 777;
  town.save();
  const dest = tmp();
  assert.equal(copyWorldSave(src, dest), true);
  assert.equal(readWorldSave(dest).t, 777);
  town.stop();
  const legacy = tmp();
  fs.writeFileSync(path.join(legacy, 'save.json'), JSON.stringify({ t: 42 }));
  const d2 = tmp();
  assert.equal(copyWorldSave(legacy, d2), true);
  assert.equal(readWorldSave(d2).t, 42);
  assert.equal(copyWorldSave(tmp(), tmp()), false);
});

test('数据库损坏：改名留存，重新开始', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'world.db'), 'garbage'.repeat(1000));
  const town = new Town({ dataDir: dir });
  assert.ok(town.t < 1440);
  town.save();
  town.stop();
  assert.ok(fs.readdirSync(dir).some((f) => /^world-corrupt-.*\.db$/.test(f)));
  assert.equal(readWorldSave(dir).t, town.t);
});

test('快照最多保留 24 份，新旧格式一起算', async () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  const snapDir = path.join(dir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  for (let h = 0; h < 5; h++) fs.writeFileSync(path.join(snapDir, `d000-${String(h).padStart(2, '0')}.json`), '{}');
  for (let h = 0; h < 24; h++) { town.t = 1440 + h * 60; await saveAndSnap(town); }
  const names = listSnapshots(dir).map((s) => s.name);
  assert.equal(names.length, 24);
  assert.ok(names.every((n) => n.endsWith('.db.gz')), '最旧的旧格式快照先被清理');
  town.stop();
});

test('导出工具：world.db → save.json，旧版本可直接读取', () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  town.t = 1440 + 120;
  town.save();
  const want = plain(town.saveData());
  town.stop();
  const out = path.join(dir, 'out.json');
  execFileSync(process.execPath, ['tools/export-save.ts', '--dir', dir, '--out', out], { stdio: 'pipe' });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), want);
});

test('指标：过去的日子只保留计数', () => {
  const town = new Town({ dataDir: tmp() });
  town.noteCommitMade(town.byId.lin, { start: 1200, end: 1260, location: 'tavern', activity: '喝一杯' });
  const d1 = town.metricsState.days[1];
  assert.equal(d1.pending!.length, 1);
  town.t += 1440;
  town.noteRun('plan', false);
  assert.equal(d1.pending, undefined);
  assert.equal(d1.keptKeys, undefined);
  assert.equal(d1.commitsMade, 1);
  assert.equal(town.metricsView().commitments.made, 1);
  town.stop();
});

test('写入失败（事务回滚）后，下一次整体重写，不会留下重复或缺失的条目', () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  town.log('event', '第一条');
  town.save();
  const store = town.worldStore();
  town.log('event', '第二条');
  const orig = store.sql.put;
  store.sql = { ...store.sql, put: { run() { throw new Error('磁盘满了'); } } as unknown as typeof orig };
  assert.throws(() => store.write(town.saveData()), /磁盘满了/);
  store.sql = { ...store.sql, put: orig };
  town.log('event', '第三条');
  town.save();
  town.stop();
  assert.deepEqual(readWorldSave(dir).logs.map((l: { text: string }) => l.text).filter((x: string) => /^第.条$/.test(x)), ['第一条', '第二条', '第三条']);
  assert.deepEqual(readWorldSave(dir), plain(town.saveData()));
});
