// 多世界运行时（多世界设计 §6、§13）：世界登记与状态机、世界管理器（按需加载、上限、卸载）、磁盘上限、数据迁移、按世界路由
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const settings = await import('../server/settings/index.ts');
const { Town } = await import('../server/sim.ts');
const { openDb } = await import('../server/accounts/db.ts');
const { Accounts } = await import('../server/accounts/index.ts');
const { WorldRegistry } = await import('../server/worlds/registry.ts');
const { WorldManager, WorldFullError } = await import('../server/worlds/manager.ts');
const { migrateLegacy, needsMigration } = await import('../server/worlds/migrate.ts');
const { officialPack, loadPack, writePack } = await import('../server/worlds/pack.ts');
const { diskUsage, reclaim } = await import('../server/worlds/disk.ts');
const { activeDir } = await import('../server/timelines.ts');
const { createApp } = await import('../server/http/app.ts');
const { worldPage } = await import('../server/http/pages.ts');
const { authorize } = await import('../server/accounts/authz.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-worlds-'));

test('世界登记：短名规则、保留字、占用；状态机只允许合法的转换', () => {
  const reg = new WorldRegistry(openDb(':memory:'));
  assert.match(reg.idProblem('Ab'), /3~32/);
  assert.match(reg.idProblem('admin'), /保留字/);
  assert.equal(reg.idProblem('little-red'), null);
  reg.create({ id: 'little-red', ownerId: 'u_1', title: '小红帽' });
  assert.match(reg.idProblem('little-red'), /占用/);
  assert.throws(() => reg.create({ id: 'little-red', title: 'x' }), /占用/);
  assert.equal(reg.get('little-red').status, 'drafting');
  assert.throws(() => reg.setStatus('little-red', 'public'), /不能变成/);
  reg.setStatus('little-red', 'preview');
  reg.setStatus('little-red', 'public');
  assert.ok(reg.get('little-red').publishedAt);
  reg.setStatus('little-red', 'suspended', '冒充官方');
  assert.equal(reg.get('little-red').statusReason, '冒充官方');
  assert.throws(() => reg.setStatus('little-red', 'archived'), /不能变成/, '下架的世界 owner 不能自己归档绕开');
});

/** 两个世界：官方云溪镇 + 一个由云溪镇世界包改名得到的用户世界 */
function twoWorlds(t, { max = 4 } = {}) {
  settings._setForTest({ MAX_ACTIVE_WORLDS: max, PINNED_WORLDS: [], IDLE_PAUSE_SEC: 60, WORLD_UNLOAD_SEC: 60 });
  const data = tmp();
  const reg = new WorldRegistry(openDb(':memory:'));
  reg.ensureOfficial('yunxi', { title: '云溪镇', summary: '', packHash: 'x', settings: {} });
  const y = officialPack('yunxi');
  const made = [];
  for (const id of ['moon-town', 'star-town', 'sun-town']) {
    const dir = path.join(data, 'worlds', id, 'pack');
    writePack(dir, { world: { ...y.world, voice: { ...y.world.voice, name: id } }, map: y.map, arcs: y.arcs });
    reg.create({ id, ownerId: 'u_owner', title: id, status: 'drafting' });
    reg.setStatus(id, 'preview');
    reg.setStatus(id, 'public');
    made.push(id);
  }
  let now = 1_000_000;
  const manager = new WorldManager({
    data, registry: reg, now: () => now,
    makeTown: (w, root) => new Town({ dataDir: activeDir(root), worldId: w.id, pack: w.official ? officialPack(w.id) : loadPack(path.join(root, 'pack')), evolution: { dir: path.join(root, 'evolution'), pluginsDir: path.join(root, 'plugins') }, instantTalk: true, pacing: false }),
  });
  t.after(() => { manager.closeAll(); settings._setForTest({}); });
  return { data, reg, manager, advance: (ms) => { now += ms; }, ids: made };
}

test('两个世界同时运行互不影响：各自的时间、天气、存档目录', (t) => {
  const { manager, data } = twoWorlds(t);
  const a = manager.open('yunxi');
  const b = manager.open('moon-town');
  assert.notEqual(a.town, b.town);
  assert.equal(b.town.spec.voice.name, 'moon-town');
  a.town.speed = 30;
  a.town.advance(1);
  assert.ok(a.town.t > b.town.t, '只推进了一个世界');
  a.town.setWeather('rain');
  assert.equal(b.town.weather, 'sunny');
  a.town.save(); b.town.save();
  assert.ok(fs.existsSync(path.join(data, 'worlds', 'yunxi', 'save.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'worlds', 'moon-town', 'save.json'), 'utf8')).worldId, 'moon-town');
  // SSE 按世界推送
  const got = { a: [], b: [] };
  const la = a.join({ ip: '1', write: (m) => got.a.push(m) });
  const lb = b.join({ ip: '1', write: (m) => got.b.push(m) });
  a.town.log('event', '只在云溪镇');
  assert.ok(got.a.some((m) => m.includes('只在云溪镇')));
  assert.ok(!got.b.some((m) => m.includes('只在云溪镇')));
  la(); lb();
});

test('上限：打开新世界时卸载无人观看、空闲最久的；都有人在看就是满员；常驻世界不卸载', (t) => {
  const { manager, advance } = twoWorlds(t, { max: 2 });
  const a = manager.open('yunxi');
  advance(1000);
  const b = manager.open('moon-town');
  const leaveB = b.join({ ip: '1', write() {} });
  advance(1000);
  // yunxi 空闲最久、没人看：让位给 star-town
  manager.open('star-town');
  assert.deepEqual([...manager.loaded.keys()].sort(), ['moon-town', 'star-town']);
  assert.ok(a.town.stopped, '被卸载的世界已存盘停止');
  // 两个都有人在看：满员
  const s = manager.get('star-town');
  const leaveS = s.join({ ip: '2', write() {} });
  assert.throws(() => manager.open('sun-town'), WorldFullError);
  assert.equal(manager.canOpen('sun-town').ok, false);
  leaveS(); leaveB();
  // 常驻世界：不会被挤掉
  settings._setForTest({ MAX_ACTIVE_WORLDS: 2, PINNED_WORLDS: ['moon-town'], IDLE_PAUSE_SEC: 60, WORLD_UNLOAD_SEC: 60 });
  advance(1000);
  manager.open('sun-town');
  assert.ok(manager.get('moon-town'));
  assert.equal(manager.get('star-town'), null);
});

test('休眠与卸载：无人观看先休眠（不推进时间），再过 WORLD_UNLOAD_SEC 存盘卸载', (t) => {
  const { manager, advance } = twoWorlds(t);
  const h = manager.open('moon-town');
  advance(61_000);
  manager.tick();
  assert.equal(h.town.idle, true);
  const before = h.town.t;
  h.town.advance(1);
  assert.equal(h.town.t, before, '休眠的世界不推进时间（不消耗 token）');
  advance(61_000);
  manager.tick();
  assert.equal(manager.get('moon-town'), null);
  // 再打开：从存档恢复
  assert.equal(Math.round(manager.open('moon-town').town.t), Math.round(before));
});

test('下架立即停止运行；暂停的世界不推进时间', (t) => {
  const { manager, reg } = twoWorlds(t);
  manager.open('moon-town');
  reg.setStatus('moon-town', 'suspended', '测试');
  manager.onStatus('moon-town');
  assert.equal(manager.get('moon-town'), null);
  assert.throws(() => manager.open('moon-town'), /不存在/);
  const s = manager.open('star-town');
  reg.setStatus('star-town', 'paused');
  manager.onStatus('star-town');
  assert.equal(s.town.paused, true);
});

test('磁盘上限：超过后先回收旧快照（每条时间线留最近 1 个），仍然超限则标记 diskFull，存档照常写入', (t) => {
  const { manager, reg, data } = twoWorlds(t);
  const root = path.join(data, 'worlds', 'moon-town');
  const snaps = path.join(root, 'snapshots');
  fs.mkdirSync(snaps, { recursive: true });
  for (let h = 0; h < 6; h++) fs.writeFileSync(path.join(snaps, `d001-${String(h).padStart(2, '0')}.json.gz`), Buffer.alloc(300 * 1024));
  const tl = path.join(root, 'timelines', 'tl-1', 'snapshots');
  fs.mkdirSync(tl, { recursive: true });
  fs.writeFileSync(path.join(tl, 'd001-00.json.gz'), Buffer.alloc(300 * 1024));
  const u = diskUsage(root);
  assert.equal(u.snapshots, 6 * 300 * 1024);
  assert.equal(u.timelines, 300 * 1024);
  reclaim(root, 0);
  assert.deepEqual(fs.readdirSync(snaps), ['d001-05.json.gz'], '主时间线留最近的 1 个');
  assert.equal(fs.readdirSync(tl).length, 1, '分支也至少留 1 个');

  reg.update('moon-town', { quota: { diskMB: 1 } });
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(2 * 1024 * 1024)); // 不可回收的大文件
  const h = manager.open('moon-town');
  assert.equal(h.diskFull, true);
  assert.equal(h.town.diskFull, true);
  h.town.save();
  assert.ok(fs.existsSync(path.join(root, 'save.json')), '存档照常写入');
  assert.equal(reg.get('moon-town').diskBytes > 2 * 1024 * 1024, true);
  // 官方世界不受限制
  reg.update('yunxi', { quota: { diskMB: 1 } });
  assert.equal(manager.checkDisk('yunxi', { force: true }).full, false);
});

test('数据迁移：旧的 data/ 存档移到 data/worlds/yunxi/，先备份；迁移后读出的世界与迁移前一致', () => {
  const data = tmp();
  const old = new Town({ dataDir: data, instantTalk: true, pacing: false });
  old.speed = 30;
  for (let i = 0; i < 40; i++) old.advance(0.5);
  old.applyWorldOp({ op: 'addItem', args: { id: 'star_shard', name: '星星碎片', emoji: '⭐', desc: '测试' } }, { by: 'admin' });
  old.save();
  old.stop();
  const before = new Town({ dataDir: data, instantTalk: true, pacing: false });
  const snap = { t: before.t, spec: before.spec, agents: before.agents.map((a) => [a.id, a.x, a.y, a.memories.length]) };
  before.stop();
  fs.writeFileSync(path.join(data, 'accounts.db'), 'keep'); // 全站的文件留在原处

  assert.equal(needsMigration(data), true);
  const r = migrateLegacy(data);
  assert.ok(r.moved.includes('save.json') && r.moved.includes('ops.jsonl'));
  assert.ok(fs.existsSync(path.join(r.backup, 'save.json')), '完整备份');
  assert.ok(!fs.existsSync(path.join(data, 'save.json')));
  assert.ok(fs.existsSync(path.join(data, 'accounts.db')));
  assert.equal(needsMigration(data), false, '只迁移一次');
  const after = new Town({ dataDir: path.join(data, 'worlds', 'yunxi'), instantTalk: true, pacing: false });
  assert.deepEqual({ t: after.t, spec: after.spec, agents: after.agents.map((a) => [a.id, a.x, a.y, a.memories.length]) }, snap);
  after.stop();
});

test('路由：/api/w/:world/*、/w/:world/api/*、旧路径 /api/* 映射到默认世界；预览中的世界只有 owner 能看', async (t) => {
  const { manager, reg } = twoWorlds(t);
  const acc = new Accounts({ file: ':memory:', db: reg.db });
  reg.create({ id: 'draft-world', ownerId: 'u_someone', title: '草稿' });
  reg.setStatus('draft-world', 'preview');
  const app = createApp({
    publicDir: 'public', accounts: acc,
    worlds: {
      lobby: true, defaultId: () => 'yunxi',
      resolve: (c, id) => { const ok = authorize(c.get('who'), 'world.view', reg.get(id)); if (ok !== true) throw Object.assign(new Error(ok), { status: 404 }); return manager.open(id); },
      page: (c, id) => worldPage({ c, id, registry: reg, manager }),
      health: () => ({}),
    },
  });
  const { config } = await import('../server/guard.ts');
  config.publicMode = true;
  t.after(() => { config.publicMode = undefined; });
  assert.equal((await (await app.request('/api/w/moon-town/me')).json()).world, 'moon-town');
  assert.equal((await (await app.request('/w/star-town/api/me')).json()).world, 'star-town');
  assert.equal((await (await app.request('/api/me')).json()).world, 'yunxi');
  assert.equal((await app.request('/api/w/nope-world/me')).status, 404);
  assert.equal((await app.request('/api/w/draft-world/me')).status, 404, '预览中的世界游客看不到');
  // 页面：世界页面 = 原来的单世界页面；不存在的世界给说明页；首页是大厅
  const page = await app.request('/w/moon-town/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<canvas id="world">/);
  assert.equal((await app.request('/w/moon-town/js/main.js')).status, 200, '相对路径的资源');
  assert.equal((await app.request('/w/nope-world/')).status, 404);
  assert.match(await (await app.request('/')).text(), /世界大厅/);
});
