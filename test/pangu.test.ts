// 验收世界包《开天》（docs/design/combat.md §6）：只用世界包数据，跑通「醒 → 群战 → Boss 三阶段 → 开天 → 撑天 → 身化万物」，
// 并检查创世能力的权限：只有 primordial 的角色能学会、AI 写的规则 / 能力碰不到创世效果、存档重放后世界一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack, packSpec } = await import('../server/worlds/pack.ts');
const { validateSpec } = await import('../server/kernel/spec.ts');
const { useAbility, mayHold } = await import('../server/kernel/abilities.ts');

const PG = loadPack(path.resolve('worlds/pangu'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-pangu-'));
const pgTown = (dir = tmp()) => new Town({ dataDir: dir, worldId: 'pangu', pack: PG, instantTalk: true, mods: [], seed: 11 });
const fightOut = (town: TownT, n = 600) => { for (let i = 0; i < n && town.fights.length; i++) town.combatTick(); };
/** 推进游戏时间（分钟），每分钟跑一次规则；战斗另外推 */
const minutes = (town: TownT, n: number) => { for (let i = 0; i < n; i++) { town.t += 1; town.rules.tick(); } };
const live = (town: TownT, type: string) => town.threats.live().filter((x) => x.type === type);
const awake = (town: TownT) => { const p = town.byId.pangu!; Object.assign(p, { status: 'acting' }); p.body.hp = 100; p.body.conditions = []; return p; };

test('《开天》世界包通过校验；盘古是 primordial，会开天，但条件不满足时用不了', (t) => {
  assert.deepEqual(validateSpec(packSpec(PG)), []);
  const town = pgTown();
  t.after(() => town.stop());
  const pangu = town.byId.pangu!;
  assert.ok(pangu.abilities.includes('kaitian'));
  assert.equal(live(town, 'murk_beast').length, 2, '开局两头浊气兽');
  assert.equal(town.weather, 'murk', '开天之前没有日月');
  awake(town);
  assert.match(useAbility(town, pangu, 'kaitian').reason!, /现在不适合/, '混沌本源没倒下之前开不了天');
});

test('完整的故事：群战 → Boss 三阶段 → 开天（新区域）→ 撑天（天一天天变高）→ 身化万物（新地图、新天气、初民）；重启后世界一致', (t) => {
  const dir = tmp();
  const town = pgTown(dir);
  const logs: string[] = [];
  const phases: string[] = [];
  town.on('log', (l) => logs.push(l.text));
  town.on('combat', (e) => { if (e.phase) phases.push(e.phase.text); });
  town.t = 8 * 60;
  const pangu = awake(town);
  // 1. 浊气兽扑上来，盘古用规则 AI 打（会放巨斧劈、混元一吼）
  const casts = new Set<string>();
  town.on('combat', (e) => { for (const c of e.casts) if (c.by.kind === 'agent') casts.add(c.skill); });
  for (const beast of live(town, 'murk_beast')) {
    Object.assign(pangu, { x: beast.x - 1, y: beast.y, region: 'town', inside: null, path: [] });
    const n = logs.length;
    town.combatTick(1);
    assert.ok(logs.slice(n).some((l) => /浊气兽扑向了盘古/.test(l)), '浊气兽主动扑向盘古');
    fightOut(town);
    awake(town);
  }
  assert.equal(live(town, 'murk_beast').length, 0, '浊气兽都被打散了');
  assert.ok(casts.has('axe_cleave'), '用了巨斧劈');
  // 2. 下午混沌本源找上门：三个阶段
  town.t = 14 * 60 - 1;
  minutes(town, 40);
  const core = live(town, 'chaos_core')[0];
  assert.ok(core, '混沌本源出现了');
  town.combatTick(1);
  assert.ok(town.engaged('threat', core!.id));
  fightOut(town, 1500);
  assert.equal(core!.state, 'gone', `盘古打倒了混沌本源（盘古血量 ${pangu.body.hp}）`);
  assert.equal(phases.length, 2, '经过了两次阶段变化');
  assert.equal(town.worldFlags.chaos_split, true);
  // 3. 开天：规则让盘古放「开天」，长出天穹与大地两张相邻的地图
  awake(town);
  minutes(town, 20);
  assert.ok(town.regions.sky && town.regions.earth, '天穹与大地出现了');
  live(town, 'murk_beast').length || town.threats.spawn('murk_beast', { loc: 'murk_field' });
  minutes(town, 60);
  town.threats.hourTick();
  assert.equal(live(town, 'murk_beast').length, 0, '天地分开后，剩下的浊气兽沉进了大地');
  town.threats.spawn('chaos_core', { loc: 'chaos_deep' }); // 例如故事引擎又放出一个
  town.threats.hourTick();
  assert.equal(live(town, 'chaos_core').length, 0, '天地分开后混沌本源聚不起来');
  assert.ok(town.specOps.some((o) => o.op === 'addAdjacentRegion' && o.cause.by === 'ability:kaitian'), '世界操作记在开天名下');
  assert.match(useAbility(town, pangu, 'kaitian').reason!, /用尽|冷却/, '开天只能用一次');
  // 4. 撑天：每次天高一丈，天地之重 +25；第四次撑到尽头，身化万物
  const h0 = town.regions.sky!.H;
  // 每天清晨、傍晚各撑一次（开天之后不会立刻撑）
  const before = town.specOps.filter((o) => o.op === 'expandMap').length;
  minutes(town, 30);
  assert.equal(town.specOps.filter((o) => o.op === 'expandMap').length, before, '开天之后不会马上撑天');
  for (let i = 0; i < 6 && town.agents.includes(pangu); i++) { awake(town); minutes(town, 720); }
  assert.ok(town.regions.sky!.H > h0, `天变高了（${h0} → ${town.regions.sky!.H}）`);
  // 一层层长高的天：没有沿接缝的横路，原地图边缘的树丛也清掉了（只剩中间一条往上的路）
  const sky = town.regions.sky!;
  for (const ext of town.spec.regions.find((r) => r.id === 'sky')!.extensions || []) {
    const r = ext.rect;
    assert.ok(ext.bare, '没有地点的扩展块');
    const seamRows = [r.y + r.h, r.y + r.h + 1];
    assert.ok(!sky.objects.some((o) => (o.type === 'bush' || o.type === 'tree') && seamRows.includes(o.y)), '接缝上没有树丛');
    const pathCells = Array.from({ length: sky.W }, (_, x) => sky.tiles[(r.y + r.h - 2) * sky.W + x]).filter((t) => t === sky.tiles[(r.y + 1) * sky.W + Math.floor(sky.W / 2)]).length;
    assert.ok(pathCells < sky.W / 2, '没有横贯的路');
  }
  assert.ok(!town.agents.includes(pangu), '盘古化作了天地万物');
  assert.equal(town.spec.personas.find((p) => p.id === 'pangu')!.status, 'departed');
  assert.ok(!town.dark.deaths.some((d) => d.id === 'pangu'), '不算死亡');
  assert.ok(!logs.some((l) => /落了空/.test(l)), '创世的每一步都成功了');
  assert.ok(town.regions.mountains && town.regions.rivers, '山川与江河出现了');
  assert.equal(town.weather, 'sunny', '化身之后立刻有了日月');
  assert.deepEqual([town.spec.weather.murk!.weight, town.spec.weather.sunny!.weight], [0, 20], '混沌的天气不再出现');
  assert.ok(['he', 'shi'].every((id) => town.agents.some((a) => a.id === id)), '初民来到了世界');
  assert.ok(town.byId.he!.memories.some((m) => /盘古化作了山川/.test(m.text)) || town.worldFlags.world_born, '世界诞生');
  assert.ok(logs.some((l) => /盘古倒下，身体化作了天地万物/.test(l)));
  // 初民在新地图上照常生活（推进一段模拟，不出错）
  const faults: string[] = [];
  const fault = town.fault.bind(town);
  town.fault = (where, e) => { faults.push(`${where}: ${(e as Error)?.stack}`); fault(where, e); };
  assert.equal(town.byId.he!.region, 'earth', '初民出生在大地上');
  town.speed = 30;
  town.t = Math.floor(town.t / 1440) * 1440 + 21 * 60 + 50; // 到睡觉的时候：回到别的地图上的家
  for (let i = 0; i < 200; i++) town.advance(0.5);
  town.speed = 1;
  assert.ok(['he', 'shi'].every((id) => town.byId[id]!.region === 'earth' && town.byId[id]!.inside), '夜里回到了大地上的草屋');
  assert.deepEqual(faults, []);
  // 5. 初民学不会创世级的能力
  assert.equal(town.learnAbility(town.byId.he!, 'kaitian'), false);
  assert.equal(mayHold(town.spec, 'he', town.spec.abilities.find((x) => x.id === 'hold_sky')), false);
  // 6. 重启：操作历史重放出同一个世界
  const regions = Object.keys(town.regions).sort();
  const skyH = town.regions.sky!.H;
  town.save();
  town.stop();
  const again = pgTown(dir);
  t.after(() => again.stop());
  assert.deepEqual(Object.keys(again.regions).sort(), regions);
  assert.equal(again.regions.sky!.H, skyH);
  assert.ok(!again.agents.some((a) => a.id === 'pangu'));
  assert.ok(again.agents.some((a) => a.id === 'he'));
});

test('创世的权限：AI 写的规则不能带创世效果、不能让人放创世级能力；AI 写的能力不能带 worldOp；非 primordial 的角色不能带创世级能力', (t) => {
  const town = pgTown();
  t.after(() => town.stop());
  const rule = (then: unknown[]) => ({ id: 'evil', name: '坏规则', when: { every: 10 }, then });
  assert.throws(() => town.applyWorldOp({ op: 'addRule', args: rule([{ op: 'worldOp', action: 'addCanon', args: { text: 'x', tags: [] } }]) }, { by: 'architect' }), /创世/);
  assert.throws(() => town.applyWorldOp({ op: 'addRule', args: { ...rule([{ op: 'cast', ability: 'kaitian' }]), forEach: 'agent' } }, { by: 'architect' }), /创世/);
  assert.throws(() => town.applyWorldOp({ op: 'addAbility', args: { id: 'fake', name: '假开天', emoji: '⚡', target: 'self', desc: '假的', effects: [{ op: 'worldOp', action: 'addCanon', args: { text: 'x', tags: [] } }] } }, { by: 'architect' }), /genesis/);
  assert.throws(() => town.applyWorldOp({ op: 'setAvatarKit', args: { ids: ['kaitian'] } }, { by: 'architect' }), /combat|创世/);
  const pack = structuredClone(PG);
  pack.world.personas[0].tier = 'resident';
  assert.match(validateSpec(packSpec(pack)).join('\n'), /只能给 tier 为 primordial/);
});

test('创世时现场生成布局（generate）：模型按意图给名字、地貌与地点（位置仍由世界包定）；模型给的不合法或没有模型时用世界包的兜底布局', async (t) => {
  const llm = await import('../server/llm.ts');
  const { runEffects } = await import('../server/kernel/effects.ts');
  const town = pgTown();
  t.after(() => { llm.setMock(null); town.stop(); });
  const effect = (id: string) => ({ op: 'worldOp', action: 'addAdjacentRegion', generate: '一片长满奇花的山谷', args: { id, name: '兜底山谷', from: 'town', side: id === 'vale' ? 'east' : 'west', length: 32, biome: 'meadow', areas: [{ id: `${id}_a`, size: 'small', places: [{ id: `${id}_spot`, kind: 'clearing', name: '兜底空地' }] }] } });
  // 1. 模型给出合法的布局
  llm.setMock(() => '{"name":"奇花谷","biome":"forest","areas":[{"biome":"forest","size":"medium","places":[{"id":"bloom","kind":"garden","name":"花海","emoji":"🌸","desc":"开满奇花的地方"},{"id":"hut","kind":"hut","name":"守花人小屋","emoji":"🛖","desc":"小屋"}]}]}');
  runEffects(town, { self: null, source: 'test' }, [effect('vale')]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(town.regions.vale?.name, '奇花谷', '用了模型给的名字');
  assert.equal(town.spec.regions.find((r) => r.id === 'vale')!.adjacent!.side, 'east', '位置由世界包定');
  assert.ok(town.spec.locations.vale_bloom0, '地点 id 加了前缀和序号（不会撞名）');
  // 2. 模型给的地点类型不存在 → 兜底布局
  llm.setMock(() => '{"name":"乱写的","biome":"forest","areas":[{"places":[{"id":"x","kind":"spaceship","name":"飞船"}]}]}');
  runEffects(town, { self: null, source: 'test' }, [effect('glen')]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(town.regions.glen?.name, '兜底山谷');
  assert.ok(town.spec.locations.glen_spot);
  // 3. 模型给的太多、窄地图放不下：逐步收缩后仍然用模型的设计，而不是退回兜底
  const big = { name: '万峰', biome: 'mountain', areas: [0, 1, 2].map((i) => ({ biome: 'mountain', size: 'small', places: [0, 1, 2, 3].map((j) => ({ id: `p${i}${j}`, kind: j % 2 ? 'grove' : 'field', name: `峰${i}${j}`, emoji: '⛰️', desc: '' })) })) };
  llm.setMock(() => JSON.stringify(big));
  runEffects(town, { self: null, source: 'test' }, [{ ...effect('peaks'), args: { ...effect('peaks').args, from: 'vale', side: 'south' } }]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(town.regions.peaks?.name, '万峰', '收缩后放下了');
});

test('没写线索的威胁（混沌本源、浊气兽）：研究 / 目击都不会想出「undefined」，也不会记下空的看法', (t) => {
  const town = pgTown();
  t.after(() => town.stop());
  const he = town.agents.find((a) => a.id !== 'pangu') || town.byId.pangu!;
  for (const type of ['chaos_core', 'murk_beast']) {
    assert.deepEqual(town.spec.threats![type]!.clues, [], `${type} 没写线索`);
    assert.equal(town.threats.giveClue(he, 'rule', type), null);
    town.threats.giveWitnessClues(town.spec.threats![type]!, town.byId.pangu!, [he]);
  }
  assert.ok(!he.memories.some((m) => m.text.includes('undefined')), '记忆里没有 undefined');
  assert.ok(!he.beliefs.some((b) => b.claim == null || String(b.claim).includes('undefined')), '没有空的看法');
});
