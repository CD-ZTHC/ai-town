// 群众（docs/design/populace.md）：规格与默认推算、规则层（守恒、确定性、节日聚集、怪事躲开与搬走、伤亡）、
// 民意（模型只给方向，内核校验限幅）、传闻与线索、规则表达式、路人、视图、存读档与旧存档迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';
import type { PopulaceConfig } from '../server/kernel/populace-spec.ts';
import type { StepInput, PlaceInfo } from '../server/sim/populace-rules.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const llm = await import('../server/llm.ts');
const { Town } = await import('../server/sim.ts');
const { loadPack, packSpec } = await import('../server/worlds/pack.ts');
const { validateSpec } = await import('../server/kernel/spec.ts');
const { validatePopulace, resolvePopulace } = await import('../server/kernel/populace-spec.ts');
const R = await import('../server/sim/populace-rules.ts');
const { testExpr } = await import('../server/kernel/rules.ts');
const { classOf } = await import('../server/scheduler/classes.ts');

llm.setMock(null);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-pop-'));
const pack = (id: string) => loadPack(path.resolve(`worlds/${id}`));
const mk = (id: string, opts: Record<string, unknown> = {}) => new Town({ dataDir: (opts.dir as string) || tmp(), worldId: id, pack: pack(id), instantTalk: true, mods: [], seed: 11, ...opts });
const tick = () => new Promise((r) => setImmediate(r));
async function run(town: TownT, minutes: number, speed = 60) {
  town.speed = speed;
  const end = town.t + minutes;
  while (town.t < end) { town.advance(0.5); await tick(); }
}
const total = (town: TownT) => town.popCfg()!.groups.reduce((s, g) => s + R.groupTotal(town.pop, g.id), 0) + Object.values(town.pop.dead).reduce((s, n) => s + n, 0);

// ---------- 规格 ----------
test('规格：night-watch 的多类人群通过校验；写坏的类别、地点、作息被拒绝', () => {
  const spec = packSpec(pack('night-watch'));
  assert.deepEqual(validateSpec(spec), []);
  const cfg = resolvePopulace(spec)!;
  assert.equal(cfg.source, 'spec');
  assert.deepEqual(cfg.groups.map((g) => g.id), ['commuter', 'student', 'elder', 'nightowl']);
  assert.equal(cfg.groups.find((g) => g.id === 'nightowl')!.rhythm, 'night');
  const bad = structuredClone(spec) as typeof spec & { populace: { groups: Array<Record<string, unknown>> } };
  bad.populace.groups.push({ id: 'commuter', name: '重复', size: 1 }, { id: 'x', name: '外星人', size: -3, rhythm: 'sometimes', haunts: ['moon'] });
  const errs = validatePopulace(bad).map(([p, m]) => `${p}: ${m}`).join('\n');
  assert.match(errs, /id 重复/);
  assert.match(errs, /id 不合法/);
  assert.match(errs, /size 应为/);
  assert.match(errs, /rhythm 只能是/);
  assert.match(errs, /未知地点：moon/);
});

test('配置：没写群众的世界按主地图公开地点推一份（×6，8~120 人）；轻松向多一类游客；旧的 population 转成市民；groups 为空就没有群众', () => {
  const yunxi = packSpec(pack('yunxi'));
  const cfg = resolvePopulace(yunxi)!;
  const pub = Object.keys(yunxi.locations).filter((id) => yunxi.locations[id]!.public && !yunxi.locations[id]!.region).length;
  assert.equal(cfg.source, 'default');
  assert.equal(cfg.groups[0]!.size, Math.max(8, Math.min(120, pub * 6)));
  assert.equal(cfg.groups[1]!.rhythm, 'visitor', '轻松向的世界有游客');
  const dm = resolvePopulace(packSpec(pack('dawn-march')))!;
  assert.equal(dm.groups.length, 1, '非轻松向没有游客');
  assert.ok(dm.groups[0]!.haunts.every((id) => !(packSpec(pack('dawn-march')).locations[id] as { region?: string }).region), '只用主地图上的地点');
  assert.equal(resolvePopulace(packSpec(pack('pangu'))), null, '开天之前没有群众');
  const legacy = { ...packSpec(pack('night-watch')), populace: undefined, population: { metro: 800, river_view: 1500 } };
  const lc = resolvePopulace(legacy)!;
  assert.equal(lc.source, 'legacy');
  assert.equal(lc.groups[0]!.size, 2300);
  assert.deepEqual(lc.groups[0]!.haunts, ['metro']);
  assert.deepEqual(lc.groups[0]!.homes, ['river_view']);
});

// ---------- 规则层（纯函数） ----------
const cfg1 = (): PopulaceConfig => ({ groups: [{ id: 'g', name: '人', emoji: '🧑', size: 100, homes: [], haunts: [], work: [], rhythm: 'day', traits: { timid: 0.5, curious: 0.4, social: 0.5 }, tones: ['#555555'] }], outside: { name: '外地', via: [] }, scale: 0, capacity: {}, source: 'spec' });
const places = (): PlaceInfo[] => [
  { id: 'cafe', cats: ['food'], outdoor: false, cap: 200, state: 'open', active: true },
  { id: 'shop', cats: ['work'], outdoor: false, cap: 200, state: 'open', active: true },
  { id: 'square', cats: ['fun'], outdoor: true, cap: 200, state: 'open', active: true },
  { id: 'pier', cats: ['fun'], outdoor: true, cap: 200, state: 'open', active: true },
];
const input = (hour: number, over: Partial<StepInput> = {}): StepInput => ({ t: hour * 60, hour: hour % 24, day: 1 + Math.floor(hour / 24), fearCap: 1, places: places(), pull: {}, push: {}, outdoor: 0, festival: false, morale: 70, supplies: 80, joy: 0, anger: 0, travel: () => 10, ...over });
function sim(hours: number, from = 6, over: (h: number) => Partial<StepInput> = () => ({})) {
  const st = R.freshPopulace();
  const cfg = cfg1();
  R.seed(st, cfg);
  for (let h = from; h < from + hours; h++) { R.arrive(st, h * 60); R.step(st, cfg, input(h, over(h))); }
  R.arrive(st, (from + hours) * 60 + 999);
  return st;
}

test('规则层：整数分配不丢人；同样的输入得到同样的结果；人数守恒；白天出门、深夜回家', () => {
  for (const [n, w] of [[7, [1, 1, 1]], [100, [0.2, 0.5, 0.3]], [3, [0, 0, 0]]] as const) assert.equal(R.allocate(n, [...w]).reduce((s, x) => s + x, 0), n);
  const a = sim(30), b = sim(30);
  assert.deepEqual(a.at, b.at, '不用随机数，同样的输入同样的分布');
  assert.equal(R.groupTotal(a, 'g'), 100, '人数守恒');
  const noon = sim(7); // 06:00 → 13:00
  assert.ok(R.countAt(noon, R.HOME) < 50, `中午大部分人出门了（在家 ${R.countAt(noon, R.HOME)}）`);
  const night = sim(22); // → 04:00
  assert.ok(R.countAt(night, R.HOME) > 85, `深夜大部分人回家了（在家 ${R.countAt(night, R.HOME)}）`);
});

test('规则层：节日把人吸到码头；下雨时户外的人少了；关门的地方没人去', () => {
  const fest = sim(8, 12, () => ({ pull: { pier: 2.5 }, festival: true }));
  const order = ['cafe', 'shop', 'square', 'pier'].sort((x, y) => R.countAt(fest, y) - R.countAt(fest, x));
  assert.equal(order[0], 'pier', `节日里码头人最多：${JSON.stringify(fest.at)}`);
  const sunny = sim(6, 10, () => ({ outdoor: 0.3 })), rainy = sim(6, 10, () => ({ outdoor: -0.9 }));
  const outdoor = (st: typeof sunny) => R.countAt(st, 'square') + R.countAt(st, 'pier');
  assert.ok(outdoor(rainy) < outdoor(sunny), '雨天户外的人更少');
  const closed = sim(6, 10, () => ({ places: places().map((p) => (p.id === 'cafe' ? { ...p, state: 'closed' as const } : p)) }));
  assert.equal(R.countAt(closed, 'cafe'), 0);
});

test('规则层：怪事附近的人躲开；害怕太久的人搬走，平静下来后慢慢回来；分级决定恐惧上限', () => {
  const st = R.freshPopulace();
  const cfg = cfg1();
  R.seed(st, cfg);
  const scary = (h: number) => input(h, { push: { square: 3, pier: 3, cafe: 3, shop: 3 } });
  for (let h = 8; h < 12; h++) { R.arrive(st, h * 60); R.step(st, cfg, input(h)); }
  R.arrive(st, 12 * 60 + 999);
  const before = R.countAt(st, 'square');
  for (let h = 12; h < 16; h++) { R.arrive(st, h * 60); R.step(st, cfg, scary(h)); }
  R.arrive(st, 16 * 60 + 999);
  assert.ok(R.countAt(st, 'square') < before, '出事的地方人少了');
  assert.ok(st.mood.g!.fear > 0.6, `恐惧上来了：${st.mood.g!.fear}`);
  for (let h = 16; h < 16 + 48; h++) { R.arrive(st, h * 60); R.step(st, cfg, scary(h)); }
  R.arrive(st, 9999);
  const gone = R.countAt(st, R.OUT);
  assert.ok(gone > 0, '害怕了一天多，有人搬走了');
  assert.equal(R.groupTotal(st, 'g'), 100, '搬走的人还算在总数里（在外地）');
  for (let h = 64; h < 64 + 72; h++) { R.arrive(st, h * 60); R.step(st, cfg, input(h)); }
  R.arrive(st, 99999);
  assert.ok(R.countAt(st, R.OUT) < gone, '平静下来后有人回来了');
  // 轻松向的恐惧上限 0.5
  const cozy = R.freshPopulace();
  R.seed(cozy, cfg);
  for (let h = 8; h < 20; h++) R.step(cozy, cfg, input(h, { fearCap: 0.5, push: { square: 3, pier: 3, cafe: 3, shop: 3 } }));
  assert.ok(cozy.mood.g!.fear <= 0.5);
});

test('规则层：伤亡从那个地点此刻的人里扣，没人就没有伤亡；传闻同一个话题以新的为准', () => {
  const st = R.freshPopulace();
  st.at = { metro: { a: 5, b: 5 } };
  assert.equal(R.harm(st, 'metro', 4, 100), 4);
  assert.equal(R.countAt(st, 'metro'), 6);
  assert.equal(st.dead.metro, 4);
  assert.equal(R.harm(st, 'park', 3, 100), 0);
  R.hear(st, { about: '末班车', claim: 'A', confidence: 0.4, source: 'mind', since: 1 });
  R.hear(st, { about: '末班车', claim: 'B', confidence: 0.7, source: 'mind', since: 2 });
  assert.equal(st.beliefs.length, 1);
  assert.equal(st.beliefs[0]!.claim, 'B');
});

// ---------- 接到小镇上 ----------
test('小镇：云溪不配置任何东西就有群众来往；两次同种子运行完全一致；人数守恒', async () => {
  const a = mk('yunxi'), b = mk('yunxi');
  try {
    const before = total(a);
    await run(a, 8 * 60); await run(b, 8 * 60);
    assert.deepEqual(a.pop.at, b.pop.at);
    const snap = a.snapshot();
    assert.ok(snap.crowd && Object.keys(snap.crowd).length >= 3, `上午各处有人：${JSON.stringify(snap.crowd)}`);
    assert.equal(total(a), before);
    const v = a.populaceView()!;
    assert.equal(v.scale, 1, '不到 150 人：一个小人就是一个人');
    assert.ok(v.flows.every((f) => f.p.length >= 4 && f.region === 'town'), '人流带着沿路的折线');
    assert.ok(a.initPayload().populace, '初始数据里有群众');
  } finally { a.stop(); b.stop(); }
});

test('小镇：居民注意到身边的人一下子多了；人多的地方会听到群众里的传闻', async () => {
  const town = mk('yunxi');
  try {
    await run(town, 3 * 60);
    const a = town.agents.find((x) => x.kind !== 'creature')!;
    Object.assign(a, { locId: 'square', status: 'acting' });
    town.pop.seen.square = 1;
    town.pop.at.square = { folk: 30 };
    town.crowdHear({ about: '湖里的灯', claim: '镜湖里夜里会亮起一盏灯', confidence: 0.8, source: 'mind', loc: 'pier', tone: 'good' });
    town.popNotices(town.popPlaces());
    assert.ok(a.memories.some((m) => /热闹起来/.test(m.text)), '记下了「热闹起来」');
    for (let h = 0; h < 8 && !a.beliefs.some((b) => b.about === '湖里的灯'); h++) { town.pop.hour = h; town.popRumorsToAgents(town.popPlaces()); }
    assert.ok(a.beliefs.some((b) => b.about === '湖里的灯' && b.source === 'crowd'), '听到了群众的传闻');
  } finally { town.stop(); }
});

test('小镇：导演放出的消息群众也听说了；威胁的线索在群众里流传，真线索让群众伤亡减半；提示词里有群众', async () => {
  const town = mk('night-watch');
  try {
    const { runBeats } = await import('../server/story/beats.ts');
    runBeats(town, [{ kind: 'spreadNews', text: '二号线晚上停运检修', at: 'all', about: '二号线', claim: '二号线晚上不开了', confidence: 0.7 }]);
    assert.equal(town.crowdBelieves('二号线'), 0.7);
    town.crowdHear({ about: '末班车', claim: '结伴进站的人都平安回来了', confidence: 0.6, source: 'clue', truth: true, threat: 'last_train' });
    assert.ok(town.crowdKnowsTruth('last_train'));
    assert.ok(!town.crowdKnowsTruth('phone_ring'));
    assert.ok(!JSON.stringify(town.populacePanel()).includes('truth'), '真假不进面板');
    assert.match(town.populaceBlock(), /群众（上班族、学生、老街坊、夜归人）/);
    assert.match(town.director.prompt(), /群众（/);
  } finally { town.stop(); }
});

test('民意：模型只给方向——摘要、偏好、传闻、聚集、诉求经校验落地，不存在的地点与不合适的内容被丢弃', async (t) => {
  const town = mk('yunxi');
  t.after(() => { llm.setMock(null); town.stop(); });
  const prompts: string[] = [];
  llm.setMock((messages, opts) => {
    if (opts.label !== '群众心智') throw new Error(`没想到的调用：${opts.label}`);
    prompts.push(messages.at(-1)!.content);
    return JSON.stringify({
      summary: '萤火节快到了，大家都在准备灯',
      prefer: [{ group: 'folk', loc: 'pier', weight: 0.8, hours: 6, reason: '去码头看灯' }, { group: 'all', loc: 'moon', weight: 1, hours: 6, reason: '不存在' }],
      rumors: [{ about: '湖灯', claim: '今年的灯会特别亮', confidence: 0.7, loc: 'pier', tone: 'good' }, { about: '色情', claim: '色情内容', confidence: 1, loc: null, tone: null }],
      gathering: { loc: 'square', kind: 'market', from: '15:00', hours: 3, text: '广场上有人摆摊卖灯' },
      demand: { text: '希望码头边多几盏路灯' },
    });
  });
  const queued: Array<[string, string]> = [];
  town.architect = { enqueue: (text: string, origin: string) => { queued.push([text, origin]); return null; } } as unknown as TownT['architect'];
  assert.ok(await town.populaceMind());
  assert.match(prompts[0]!, /folk（居民）/);
  assert.equal(town.pop.summary, '萤火节快到了，大家都在准备灯');
  assert.deepEqual(town.pop.intents.map((x) => x.loc), ['pier'], '不存在的地点被丢弃');
  assert.deepEqual(town.pop.beliefs.map((b) => b.about), ['湖灯'], '不合适的传闻被丢弃');
  assert.equal(town.pop.gatherings[0]!.kind, 'market');
  assert.deepEqual(queued, [['希望码头边多几盏路灯', 'populace']]);
  assert.ok(town.logs.some((l) => l.type === 'populace' && /民意/.test(l.text)));
  // 三天内不再提诉求
  await town.populaceMind();
  assert.equal(queued.length, 1);
});

test('民意：每天清晨一次，有大事时加一次，总数不超过设置；关闭后不调用', async (t) => {
  const town = mk('yunxi');
  let calls = 0;
  llm.setMock((_m, opts) => { if (opts.label === '群众心智') calls++; return JSON.stringify({ summary: '平常的一天' }); });
  t.after(() => { llm.setMock(null); town.stop(); });
  await run(town, 2 * 60); // 到 08:15
  await tick(); await tick();
  assert.equal(calls, 1, '清晨一次');
  town.applyWorldOp({ op: 'addCanon', args: { text: '无关的事', tags: [] } });
  town.pop.mind.pending = true;
  town.pop.mind.at -= 200;
  town.popMindCheck(); await tick(); await tick();
  assert.equal(calls, 2, '有大事时加一次');
  town.pop.mind.pending = true;
  town.pop.mind.at -= 200;
  town.popMindCheck(); await tick();
  assert.equal(calls, 2, '默认每天最多 2 次');
  // 关掉民意：第二天清晨也不再调用
  process.env.POPULACE_MIND = 'false';
  t.after(() => { delete process.env.POPULACE_MIND; });
  await run(town, 24 * 60);
  assert.equal(calls, 2, '关闭后不调用');
  assert.equal(town.pop.mind.count, 0);
});

test('规则表达式：crowd / deserted / crowdBelieves / crowdMood / crowdGone；没有群众的世界里 deserted 为假', () => {
  const town = mk('night-watch');
  const pg = mk('pangu');
  try {
    town.pop.at.metro = { commuter: 40 };
    town.pop.norm.metro = 600;
    assert.ok(testExpr(town, "crowd('metro') == 40"));
    assert.ok(testExpr(town, "deserted('metro')"), '不到平常的一成');
    town.pop.at.metro = { commuter: 200 };
    assert.ok(!testExpr(town, "deserted('metro')"));
    town.crowdHear({ about: '末班车', claim: '末班车之后还有车', confidence: 0.6, source: 'mind' });
    assert.ok(testExpr(town, "crowdBelieves('末班车') > 0.5"));
    assert.ok(testExpr(town, "crowdMood('fear') >= 0 && crowdGone() == 0"));
    assert.ok(!testExpr(pg, "deserted('chaos_deep')"));
    assert.ok(testExpr(pg, "crowd('chaos_deep') == 0"));
  } finally { town.stop(); pg.stop(); }
});

test('路人：临时身份同一天固定、换一天会变；不存在的地点没有人；交谈走 P0、不写进居民的记忆', async (t) => {
  const town = mk('yunxi');
  t.after(() => { llm.setMock(null); town.stop(); });
  const p = town.passerby('square', 0, 3)!;
  assert.deepEqual(town.passerby('square', 0, 3), p);
  for (let i = 0; i < 200; i++) assert.ok(town.passerby('square', 0, i)!.line, `第 ${i} 个路人有一句话`);
  assert.match(p.name, /居民$/);
  assert.equal(town.passerby('moon', 0, 1), null);
  assert.equal(town.passerby('square', 9, 1), null);
  town.t += 1440;
  assert.notDeepEqual(town.passerby('square', 0, 3)!.name + town.passerby('square', 0, 4)!.name + town.passerby('square', 0, 5)!.name, p.name + town.passerby('square', 0, 4)!.name);
  assert.equal(classOf('与路人交谈'), 'P0');
  assert.equal(classOf('群众心智'), 'P2');
  const mems = town.agents.map((a) => a.memories.length);
  llm.setMock((messages, opts) => { assert.equal(opts.label, '与路人交谈'); assert.match(messages.at(-1)!.content, /你好/); return JSON.stringify({ reply: '你好呀，外地来的？', emoji: '👋' }); });
  const r = await town.passerbyChat('square', 0, 3, '你好', [], '小明');
  assert.equal(r.reply, '你好呀，外地来的？');
  assert.deepEqual(town.agents.map((a) => a.memories.length), mems);
});

test('存读档：群众原样保存；旧存档里黑暗叙事的人口转过来（死者照抄，活人按死者扣）', async () => {
  const dir = tmp();
  const town = mk('night-watch', { dir });
  await run(town, 4 * 60);
  const at = structuredClone(town.pop.at);
  town.save(); town.stop();
  const again = mk('night-watch', { dir });
  try { assert.deepEqual(again.pop.at, at); } finally { again.stop(); }
  // 旧存档：没有 populace 字段，dark.population 里记着死者
  const dir2 = tmp();
  const old = mk('night-watch', { dir: dir2 });
  old.populace = R.freshPopulace();
  old.dark.population = { metro: { alive: 780, dead: 20 }, school: { alive: 1195, dead: 5 } };
  old.save(); old.stop();
  const migrated = mk('night-watch', { dir: dir2 });
  try {
    assert.equal(migrated.pop.dead.metro, 20);
    assert.equal(R.groupTotal(migrated.pop, 'commuter'), 3000 - 25);
    assert.deepEqual(migrated.dark.population, {});
  } finally { migrated.stop(); }
});

test('地图压力：总是挤满人的地方交给架构师扩建', () => {
  const town = mk('yunxi');
  try {
    const cap = town.popPlaces().find((p) => p.id === 'cafe')!.cap;
    for (const d of [town.day - 1, town.day - 2, town.day - 3]) town.pop.peaks[d] = { cafe: cap + 5 };
    const p = town.mapPressure.compute();
    assert.equal(p.crowded?.[0]?.id, 'cafe');
    assert.match(town.mapPressure.top(p)!.text, /挤满了人/);
  } finally { town.stop(); }
});

test('前端：小人的数量按比例尺换算；按各类人数分配类别；沿折线取点；渲染器挂上了群众层', async () => {
  const { figureCount, groupOf, alongPath } = await import('../public/js/render/populace.js');
  const { Renderer } = await import('../public/js/render.js');
  assert.deepEqual([figureCount(0, 1), figureCount(5, 1), figureCount(40, 1)], [0, 5, 12]);
  assert.deepEqual([figureCount(3, 10), figureCount(55, 10), figureCount(900, 10)], [1, 6, 10]);
  assert.ok(figureCount(800, 0) >= 5 && figureCount(800, 0) <= 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => groupOf([3, 1], i, 4)), [0, 0, 0, 1]);
  assert.deepEqual(alongPath([0, 0, 10, 0, 10, 10], 0.5), { x: 10, y: 0 });
  assert.deepEqual(alongPath([0, 0, 10, 0], 1), { x: 10, y: 0 });
  for (const m of ['crowdFigures', 'drawPasserby', 'hitPassersby']) assert.equal(typeof (Renderer.prototype as unknown as Record<string, unknown>)[m], 'function');
});
