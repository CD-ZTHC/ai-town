// 存储：快照 gzip 压缩；升级前的 .json 旧快照仍然可以列出、回溯、分叉；保留份数对两种格式一起算；指标只给当天保留去重用的 key
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'LLM_PROVIDER']) delete process.env[k];
const { Town, listSnapshots, restoreSnapshot } = await import('../server/sim.ts');
const { forkTimeline, timelineDir } = await import('../server/timelines.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-storage-'));

test('每小时快照用 gzip 压缩，内容与存档一致，体积明显更小', () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  town.save();
  const [snap] = listSnapshots(dir);
  assert.match(snap.name, /^d001-06\.json\.gz$/);
  const raw = fs.readFileSync(path.join(dir, 'save.json'));
  const gz = fs.readFileSync(path.join(dir, 'snapshots', snap.name));
  assert.deepEqual(JSON.parse(zlib.gunzipSync(gz) as unknown as string), JSON.parse(raw as unknown as string));
  assert.ok(gz.length < raw.length / 2, `压缩后 ${gz.length}，原始 ${raw.length}`); // 新小镇的存档很小；跑满一季的存档压缩到约 13%
  assert.ok(!fs.readdirSync(path.join(dir, 'snapshots')).some((f) => f.endsWith('.tmp')));
  town.stop();
});

test('升级前的 .json 旧快照：能列出、回溯；同一整点有新快照时旧的被取代', () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  town.save();
  const snapDir = path.join(dir, 'snapshots');
  // 模拟旧版本留下的快照
  const old = JSON.parse(fs.readFileSync(path.join(dir, 'save.json'), 'utf8'));
  fs.writeFileSync(path.join(snapDir, 'd000-05.json'), JSON.stringify({ ...old, t: 5 * 60 }));
  assert.deepEqual(listSnapshots(dir).map((s) => s.name), ['d001-06.json.gz', 'd000-05.json']);
  restoreSnapshot(dir, 'd000-05.json');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'save.json'), 'utf8')).t, 5 * 60);
  restoreSnapshot(dir, 'd001-06.json.gz');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'save.json'), 'utf8')).t, town.t);
  // 同一整点：新格式快照写入时删掉旧格式的
  fs.writeFileSync(path.join(snapDir, 'd001-07.json'), '{}');
  town.t = 7 * 60 + 5;
  town.save();
  assert.ok(!fs.existsSync(path.join(snapDir, 'd001-07.json')));
  assert.ok(fs.existsSync(path.join(snapDir, 'd001-07.json.gz')));
  assert.throws(() => restoreSnapshot(dir, 'd001-07.json.gz.bak'), /不合法/);
  town.stop();
});

test('从压缩快照和旧快照都能分出时间线', () => {
  const root = tmp();
  const town = new Town({ dataDir: root });
  town.save();
  const old = JSON.parse(fs.readFileSync(path.join(root, 'save.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'snapshots', 'd000-05.json'), JSON.stringify({ ...old, t: 5 * 60 }));
  const a = forkTimeline(root, { fromId: 'main', snapshot: 'd001-06.json.gz' });
  const b = forkTimeline(root, { fromId: 'main', snapshot: 'd000-05.json' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(timelineDir(root, a.id), 'save.json'), 'utf8')).t, town.t);
  assert.equal(JSON.parse(fs.readFileSync(path.join(timelineDir(root, b.id), 'save.json'), 'utf8')).t, 5 * 60);
  assert.throws(() => forkTimeline(root, { fromId: 'main', snapshot: '../save.json' }), /快照名称/);
  town.stop();
});

test('快照最多保留 24 份，新旧格式一起算', () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  const snapDir = path.join(dir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  for (let h = 0; h < 5; h++) fs.writeFileSync(path.join(snapDir, `d000-${String(h).padStart(2, '0')}.json`), '{}');
  for (let h = 0; h < 24; h++) { town.t = 1440 + h * 60; town.save(); }
  const names = listSnapshots(dir).map((s) => s.name);
  assert.equal(names.length, 24);
  assert.ok(names.every((n) => n.endsWith('.gz')), '最旧的旧格式快照先被清理');
  town.stop();
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
