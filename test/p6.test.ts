// P6：随 AI 负载调速、每日用量、Mod 导出与加载、时间线分支、异界区域、访客化身
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';
import type { LabelStats } from '../server/llm.ts';
import type { OpRecord } from '../server/types/ops.ts';
import type { CurEntry } from '../server/types/agent.ts';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER', 'MODS']) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const llm = await import('../server/llm.ts');
const { exportMod, applyMods, readMod } = await import('../server/kernel/mods.ts');
const { defaultSpec } = await import('../server/kernel/spec.ts');
const { registry, forkTimeline, setActive, activeDir, timelineDir } = await import('../server/timelines.ts');
const { buildMoonRealm, T } = await import('../server/world.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-p6-'));

test('模型排队太长时放慢时间流速，最低 1/4；关闭后不受影响', () => {
  let q = 0;
  const town = new Town({ dataDir: tmp(), pacing: true, queueSize: () => q });
  llm.setMock(() => '{}');
  try {
    town.speed = 10;
    // 有人醒着，避免触发深夜快进
    const awake = () => { town.byId.lin.status = 'acting'; };
    town.advance = ((f) => (dt) => { awake(); f.call(town, dt); })(town.advance);
    const t0 = town.t;
    q = 12;
    town.advance(1);
    assert.equal(town.paced, 0.5);
    assert.ok(Math.abs(town.t - t0 - 5) < 1e-9, '12 个排队 → 半速');
    q = 100;
    town.advance(1);
    assert.equal(town.paced, 0.25, '最低 1/4');
    q = 2;
    town.advance(1);
    assert.equal(town.paced, 1);
    town.pacing = false;
    q = 100;
    town.advance(1);
    assert.equal(town.paced, 1, '关闭调速');
    assert.equal(town.snapshot().paced, null, '不调速时快照里没有 paced');
  } finally {
    llm.setMock(null);
    town.stop();
  }
});

test('每个游戏日记录 token 用量，重启跨日不记负数', () => {
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  const base = llm.stats.promptTokens;
  town.t = 1440 + 6 * 60; // 第 2 天
  town.recordUsage(); // 设置起点
  llm.stats.promptTokens += 1000;
  llm.stats.byLabel.测试 = { calls: 3, fails: 0, tokens: 1000, ms: 10 } as LabelStats;
  town.t = 2 * 1440 + 6 * 60;
  town.recordUsage();
  const v = town.usageView();
  assert.equal(v.days.length, 1);
  assert.equal(v.days[0].day, 2);
  assert.equal(v.days[0].tokens, 1000);
  assert.equal(v.days[0].byLabel.测试.calls, 3);
  assert.equal(v.avgPerDay, 1000);
  town.save();
  town.stop();
  const again = new Town({ dataDir: dir });
  assert.equal(again.usageView().days[0].tokens, 1000, '存档里保留用量');
  again.stop();
  llm.stats.promptTokens = base;
  delete llm.stats.byLabel.测试;
});

test('Mod：只导出内容类操作，可以加载到新小镇；坏数据被跳过', () => {
  // 第 3 项是坏数据（setParam 的参数名写成了 key），用来检查导出时会被跳过
  const specOps = [
    { seq: 1, op: 'addCanon', args: { text: '湖边有块会唱歌的石头', tags: ['镜湖'] }, cause: { by: 'arc' } },
    { seq: 2, op: 'addItem', args: { id: 'song_stone', name: '歌石', emoji: '🪨', desc: '会唱歌的石头' }, cause: { by: 'proposal' } },
    { seq: 3, op: 'setParam', args: { key: 'walkSpeed', value: 4 }, cause: { by: 'admin' } },
  ] as unknown as OpRecord[];
  const all = exportMod(specOps, { id: 'song-stone', name: '歌石' });
  assert.deepEqual(all.ops.map((o) => o.op), ['addCanon', 'addItem']);
  const only = exportMod(specOps, { id: 'song-stone', proposalsOnly: true });
  assert.deepEqual(only.ops.map((o) => o.op), ['addItem']);
  assert.throws(() => exportMod(specOps, { id: 'Bad Id' }), /Mod id/);
  assert.throws(() => exportMod([], { id: 'empty' }), /没有可以导出/);

  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'song-stone.json'), JSON.stringify({ ...all, ops: [...all.ops, { op: 'setParam', args: {} }, { op: 'addItem', args: { id: 'song_stone' } }] }));
  assert.equal(readMod(path.join(dir, 'song-stone.json')).ops.length, 3, '非内容类操作被过滤');
  const r = applyMods(defaultSpec(), ['song-stone', 'missing', '../etc'], dir);
  assert.ok(r.spec.items.song_stone);
  assert.equal(r.loaded[0].ops, 2);
  assert.ok(r.skipped.some((k) => k.mod === 'missing'));
  assert.ok(r.skipped.some((k) => k.mod === '../etc' && /名称/.test(k.error)));
  assert.ok(r.skipped.some((k) => k.op === 'addItem'), '重复 id 的操作被跳过');

  const town = new Town({ dataDir: tmp(), mods: ['song-stone'], modsDir: dir });
  assert.ok(town.spec.items.song_stone);
  assert.equal(town.specOps.length, 0, 'Mod 内容不写进本小镇的操作历史');
  town.stop();
});

test('仓库自带的 Mod 可以加载', () => {
  const r = applyMods(defaultSpec(), ['lakeside-story-corner']);
  assert.deepEqual(r.skipped, []);
  assert.ok(r.spec.buildings.some((b) => b.id === 'lakeside_story'));
});

test('时间线：从存档或快照分叉、切换、登记表防越界', () => {
  const root = tmp();
  assert.equal(registry(root).active, 'main');
  const town = new Town({ dataDir: activeDir(root) });
  town.t = 2 * 1440 + 10 * 60;
  town.save();
  town.stop();
  const e = forkTimeline(root, { fromId: 'main', name: '如果那天下了雨' });
  assert.equal(e.id, 'tl-1');
  assert.equal(e.from!.day, 3);
  assert.equal(e.name, '如果那天下了雨');
  setActive(root, 'tl-1');
  assert.equal(activeDir(root), path.join(root, 'timelines', 'tl-1'));
  const fork = new Town({ dataDir: activeDir(root) });
  assert.equal(Math.floor(fork.t), 2 * 1440 + 10 * 60, '分支从来源存档继续');
  fork.t += 60;
  fork.save();
  fork.stop();
  const main = JSON.parse(fs.readFileSync(path.join(root, 'save.json'), 'utf8'));
  assert.equal(Math.floor(main.t), 2 * 1440 + 10 * 60, '分支的变化不影响主时间线');
  assert.throws(() => forkTimeline(root, { fromId: 'main', snapshot: '../save.json' }), /快照名称/);
  assert.throws(() => forkTimeline(root, { fromId: 'nope' }), /来源时间线/);
  assert.throws(() => timelineDir(root, '../x'), /时间线不存在/);
  assert.throws(() => setActive(root, 'tl-9'), /时间线不存在/);
});

test('暗月界：地图可以走通，所有地点都在可走区域', () => {
  const w = buildMoonRealm({ locationInfo: defaultSpec({}).locations });
  assert.equal(w.id, 'moonrealm');
  assert.ok(w.walk[w.gate.y * w.W + w.gate.x]);
  for (const l of Object.values(w.locations)) for (const s of l.spots) assert.ok(w.walk[s.y * w.W + s.x], `${l.id} ${s.x},${s.y}`);
  assert.ok(w.tiles.includes(T.MOON));
});

function stepUntil(town: { advance(dt: number): void }, cond: () => unknown, maxSteps = 4000) {
  for (let i = 0; i < maxSteps && !cond(); i++) town.advance(0.2);
  return cond();
}

test('区域：关闭时不能去；打开后居民经渡口走到异界地点，再走回来；关闭时被送回', () => {
  const town = new Town({ dataDir: tmp() });
  town.pacing = false;
  const a = town.byId.lin;
  assert.equal(town.resolveLoc(a, 'moon_garden'), a.home, '关闭的区域回落到家');
  assert.ok(!town.publicLocs().includes('moon_garden'));
  town.openRegion('moonrealm', true);
  assert.ok(town.publicLocs().includes('moon_garden'));
  assert.equal(town.resolveLoc(a, '月光花园'), 'moon_garden', '中文地名也能匹配');
  assert.equal(town.creatures.list.filter((c) => c.region === 'moonrealm').length, 3);

  town.t = 10 * 60;
  const e = { start: town.t, end: town.t + 600, location: 'moon_garden', activity: '赏花', emoji: '🌸' } as unknown as CurEntry;
  Object.assign(a, { status: 'acting', inside: null, x: 22, y: 20, schedule: [e], curKey: null, convoId: null });
  a.curEntry = e;
  town.navigate(a, 'moon_garden', e);
  assert.ok(a.hop, '先去渡口');
  const walk = { advance: (dt: number) => { town.t += dt * 5; if (a.status === 'walking') town.step(a, dt * 5); } };
  const ok = stepUntil(walk, () => a.locId === 'moon_garden');
  assert.ok(ok, '走到了月光花园');
  assert.equal(a.region, 'moonrealm');
  assert.ok(a.memories.some((m) => m.text.includes('月之渡口')), '记得第一次穿越');
  assert.ok(town.logs.some((l) => l.type === 'region' && (l.agents as string[] | undefined)?.includes('lin')));
  assert.equal(town.snapshot().agents.find((x) => x.id === 'lin')!.region, 'moonrealm');

  // 同区域才算附近
  const b = town.byId.su;
  Object.assign(b, { x: a.x, y: a.y, inside: null, region: 'town', status: 'acting' });
  assert.ok(!town.nearbyText(a).includes(b.name), '不同区域的人不算在身边');

  // 回家：经渡口回到小镇
  const home = { start: town.t, end: town.t + 600, location: a.home, activity: '回家', emoji: '🏠' } as unknown as CurEntry;
  a.curEntry = home;
  town.navigate(a, a.home, home);
  assert.ok(stepUntil(walk, () => a.locId === a.home));
  assert.equal(a.region, 'town');

  // 关闭通路：还在那边的人回到渡口
  a.region = 'moonrealm';
  town.openRegion('moonrealm', false);
  assert.equal(a.region, 'town');
  assert.equal(town.creatures.list.filter((c) => c.region === 'moonrealm').length, 0);
  town.stop();
});

test('暗月界开放：居民听说了那边的事，规划提示里有去的理由；关闭时都没有', () => {
  const town = new Town({ dataDir: tmp() });
  const a = town.byId.su;
  assert.equal(town.moonHint(a), '');
  assert.equal(town.moonOuting(a), null);
  town.openRegion('moonrealm', true);
  for (const x of town.agents.filter((x) => x.kind !== 'creature')) {
    assert.ok(x.memories.some((m) => m.text.includes('暗月界')), `${x.name}听说了暗月界`);
    assert.ok(x.beliefs.some((b) => b.about === '暗月界'));
  }
  assert.match(town.moonHint(a), /moon_garden/);
  const n = a.memories.length;
  town.openRegion('moonrealm', true);
  assert.equal(a.memories.length, n, '重复打开不再重复散播');
  town.stop();
});

test('暗月界开放后，没有模型的两天里也有居民去那边逛，晚上都回家', async () => {
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  town.pacing = false;
  town.speed = 10;
  town.openRegion('moonrealm', true);
  const seen: Record<number, Set<string>> = {};
  while (town.t < 1440 + 23 * 60) {
    town.advance(0.5);
    await new Promise((r) => setImmediate(r)); // 让规划失败后的兜底日程生效
    for (const a of town.agents) if (a.region === 'moonrealm' && a.locId?.startsWith('moon_')) (seen[town.day] ||= new Set()).add(a.id);
  }
  assert.ok(seen[1]?.size >= 1, '第 1 天有人去暗月界');
  assert.ok(seen[2]?.size >= 1, '第 2 天有人去暗月界');
  assert.ok(town.logs.some((l) => l.type === 'region' && l.text.includes('第一次踏进')));
  assert.deepEqual(town.agents.filter((a) => a.region === 'moonrealm').map((a) => a.name), [], '23:00 都回到了小镇');
  town.stop();
});

test('区域：导演不能开区域，剧情弧可以；存档保留开放状态', async () => {
  const { checkBeat } = await import('../server/story/beats.ts');
  const dir = tmp();
  const town = new Town({ dataDir: dir });
  assert.match(checkBeat(town, { kind: 'region', id: 'moonrealm', open: true }) || '', /./);
  assert.equal(checkBeat(town, { kind: 'region', id: 'moonrealm', open: true }, { privileged: true }), null);
  assert.match(checkBeat(town, { kind: 'region', id: 'town' }, { privileged: true }) || '', /未知区域/);
  town.openRegion('moonrealm');
  town.save();
  town.stop();
  const again = new Town({ dataDir: dir });
  assert.ok(again.regionOpen('moonrealm'));
  assert.equal(again.initPayload().regionsOpen.moonrealm.open, true);
  assert.ok(again.initPayload().regions.moonrealm.tiles.length);
  again.stop();
});

test('访客化身：现身、限制、走动、被居民看见、聊天时记住名字、超时离开', async () => {
  let now = 1_000_000;
  const town = new Town({ dataDir: tmp() });
  town.avatars.now = () => now;
  const av = town.avatars;
  assert.throws(() => av.join('v1', '1.1.1.1', { name: '' }), /起个名字/);
  const v = av.join('v1', '1.1.1.1', { name: '小满<b>' });
  assert.equal(v.name, '小满b');
  assert.throws(() => av.join('v2', '2.2.2.2', { name: '小满b' }), /已经有人用了/);
  // 同一个账号再次现身（另一个标签页、另一台设备）：沿用同一个化身，不会分身
  assert.equal(av.join('v1', '3.3.3.3', { name: '小满b', color: '#64b5f6' }), v);
  assert.equal(av.list.length, 1);
  assert.equal(v.color, '#64b5f6');
  // 不同的账号可以在同一个 IP 下各自现身
  av.join('v9', '1.1.1.1', { name: '阿九' });
  assert.equal(av.list.length, 2);
  av.leave('v9');
  av.leave('v1');
  const me = av.join('v1', '1.1.1.1', { name: '小满' });
  assert.throws(() => av.move('v1', 'moon_garden'), /公共地点/, '关闭的区域不能去');
  assert.throws(() => av.move('nobody', 'cafe'), /还没有/);
  av.move('v1', 'pier');
  assert.throws(() => av.move('v1', 'cafe'), /慢一点/);
  for (let i = 0; i < 400 && me.path.length; i++) av.tick(0.5);
  assert.equal(me.locId, 'pier');
  assert.ok(town.snapshot().avatars.some((x) => x.name === '小满'));

  // 游戏模式：走到任意可达的格子
  const W = town.world;
  const free = [...W.walk.keys()].find((i) => W.walk[i] && Math.hypot(i % W.W - me.x, Math.floor(i / W.W) - me.y) > 5);
  now += 1000;
  assert.throws(() => av.goto('v1', -1, 0), /走不过去/);
  assert.throws(() => av.goto('v1', 'x' as unknown as number, 3), /走不过去/);
  const wall = [...W.walk.keys()].find((i) => !W.walk[i]);
  assert.throws(() => av.goto('v1', wall! % W.W, Math.floor(wall! / W.W)), /走不过去/);
  av.goto('v1', free! % W.W, Math.floor(free! / W.W));
  assert.throws(() => av.goto('v1', free! % W.W, Math.floor(free! / W.W)), /慢一点/);
  assert.ok(av.view()[0].to, '行走中下发终点');
  for (let i = 0; i < 400 && me.path.length; i++) av.tick(0.5);
  assert.deepEqual([me.x, me.y], [free! % W.W, Math.floor(free! / W.W)]);
  assert.equal(av.view()[0].to, undefined);
  now += 4000;
  av.move('v1', 'pier');
  for (let i = 0; i < 400 && me.path.length; i++) av.tick(0.5);

  // 居民在身边时能看见
  const a = town.byId.zhou;
  Object.assign(a, { x: me.x + 1, y: me.y, inside: null, region: 'town', status: 'acting' });
  assert.match(town.nearbyText(a), /旅人「小满」/);

  // 聊天：提示词里带名字，记忆里也有名字
  let prompt = '';
  llm.setMock((messages) => { prompt = messages.at(-1)!.content; return JSON.stringify({ reply: '你好', emoji: '🙂', thought: '', memory: '有人来问路', importance: 4, newPlan: null }); });
  try {
    await town.visitorChat('zhou', '请问诊所在哪？', 'visitor', 'v1');
  } finally { llm.setMock(null); }
  assert.match(prompt, /站在面前的旅人「小满」/);
  assert.ok(a.memories.some((m) => m.text.includes('小满')));

  // 超时离开
  now += 21 * 60_000;
  av.tick(0.1);
  assert.equal(av.list.length, 0);
  assert.ok(town.logs.some((l) => l.type === 'avatar' && l.text.includes('离开')));
  town.stop();
});
