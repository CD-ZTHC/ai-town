// 冒险（docs/design/adventure.md）：成长、回复与撤退、结伴、远征前线、区域的激活与休眠，以及验收世界包《破晓远征》
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';
import type { GrowthDef, WorldSpec } from '../server/types/spec.ts';
import type { GenMap } from '../server/genesis/assemble.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack, packSpec } = await import('../server/worlds/pack.ts');
const { validateSpec } = await import('../server/kernel/spec.ts');
const G = await import('../server/sim/growth.ts');
const R = await import('../server/sim/recovery.ts');
const E = await import('../server/sim/expedition.ts');
const D = await import('../server/sim/dormancy.ts');

const DM = loadPack(path.resolve('worlds/dawn-march'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-adv-'));
const dmTown = (dir = tmp(), seed = 7) => new Town({ dataDir: dir, worldId: 'dawn-march', pack: DM, instantTalk: true, mods: [], seed });
const fightOut = (town: TownT, n = 800) => { for (let i = 0; i < n && town.fights.length; i++) town.combatTick(); };
/** 推进游戏时间（分钟）：每分钟跑一次规则与冒险循环 */
const minutes = (town: TownT, n: number) => { for (let i = 0; i < n; i++) { town.t += 1; town.rules.tick(); town.adventureTick(); } };
const place = (town: TownT, id: string, loc: string) => {
  const a = town.byId[id]!;
  const c = town.locCenter(loc)!;
  Object.assign(a, { region: town.locRegion(loc), x: c.x, y: c.y, inside: null, path: [], dest: null, hop: null, status: 'acting', locId: loc, curKey: null });
  return a;
};
const live = (town: TownT, type: string) => town.threats.live().filter((x) => x.type === type);

// ---------- 规则 ----------
const GROW: GrowthDef = { maxLevel: 10, curve: { base: 10, mult: 1.5 }, tracks: { a: { perLevel: { atk: 1.5, def: 0.5, maxHp: 10 }, learn: [{ level: 3, ability: 'x' }] } } };

test('成长规则：升级所需经验、连升、学招、到上限停住、属性加成', () => {
  assert.equal(G.expToNext(GROW, 1), 10);
  assert.equal(G.expToNext(GROW, 2), 15);
  const r = G.addExp(GROW, { level: 1, exp: 0, track: 'a' }, 30);
  assert.deepEqual(r.levels, [2, 3], '10 + 15 = 25 升两级，余 5');
  assert.equal(r.xp.exp, 5);
  assert.deepEqual(r.learned, ['x']);
  assert.deepEqual(r.gains, { atk: 3, def: 1, maxHp: 20 });
  const capped = G.addExp(GROW, { level: 1, exp: 0, track: 'a' }, 10_000, 3);
  assert.equal(capped.xp.level, 3, '有等级上限');
  assert.ok(capped.xp.exp < G.expToNext(GROW, 3), '到上限后经验不再累积');
  assert.deepEqual(G.levelGains(GROW, { level: 4, exp: 0, track: 'a' }), { atk: 4, def: 1, maxHp: 30 });
  assert.deepEqual(G.levelGains(undefined, null), { atk: 0, def: 0, maxHp: 0 });
});

test('经验分配：平分 + 最后一击加成；killer 模式全给最后一击', () => {
  assert.deepEqual(G.shareExp(30, ['a', 'b', 'c'], 'a'), { a: 16, b: 10, c: 10 });
  assert.deepEqual(G.shareExp(30, ['a', 'b'], 'b', 'killer'), { b: 30 });
  assert.deepEqual(G.shareExp(0, ['a'], 'a'), {});
  assert.equal(G.expWorth(50), 10);
  assert.equal(G.expWorth(50, 7), 7);
});

test('装备：写明槽位的同槽只取加成最高的一件，旧写法 equip: true 各算各的；生命上限 = 100 + 装备 + 成长', () => {
  const items = {
    s1: { name: '木剑', emoji: '🗡️', equip: 'weapon', mods: { atk: 2 } },
    s2: { name: '铁剑', emoji: '🗡️', equip: 'weapon', mods: { atk: 5 } },
    a1: { name: '甲', emoji: '🦺', equip: 'armor', mods: { def: 2, hp: 15 } },
    old1: { name: '旧1', emoji: '•', equip: true, mods: { atk: 1 } },
    old2: { name: '旧2', emoji: '•', equip: true, mods: { atk: 1 } },
  } as unknown as WorldSpec['items'];
  assert.deepEqual(G.equipped({ s1: 1, s2: 1, a1: 1, old1: 1, old2: 1 }, items).sort(), ['a1', 'old1', 'old2', 's2']);
  assert.equal(G.maxHpOf({ a1: 1 }, items, GROW, { level: 3, exp: 0, track: 'a' }), 135);
});

test('回复规则：最近的回复点（先比换几次地图，再比距离）；回血速率；夜里', () => {
  const links = [{ from: 'a', to: 'b', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, name: '' }, { from: 'b', to: 'c', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, name: '' }];
  const hops = R.regionHops(links, () => true, 'a');
  assert.deepEqual([...hops.entries()], [['a', 0], ['b', 1], ['c', 2]]);
  const cands = [{ id: 'far', region: 'a', at: { x: 30, y: 0 } }, { id: 'near', region: 'a', at: { x: 3, y: 0 } }, { id: 'other', region: 'b', at: { x: 0, y: 0 } }];
  assert.equal(R.pickNearest(cands, { x: 0, y: 0, region: 'a' }, hops), 'near');
  assert.equal(R.pickNearest(cands.slice(2), { x: 0, y: 0, region: 'a' }, hops), 'other');
  assert.equal(R.restHeal(200, 1.5, 10), 30);
  assert.equal(R.restHeal(200, 1.5, 10, { sleeping: true, healer: true }), 90);
  assert.ok(R.isNight(23 * 60, 22 * 60) && R.isNight(5 * 60, 22 * 60) && !R.isNight(12 * 60, 22 * 60));
});

test('远征规则：前线是第一个已开放、没征服的阶段；越级经验打折；环上找落点', () => {
  const x = { stages: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] } as never;
  const st = E.freshExpedition(x, 0);
  assert.equal(E.frontOf(x, st), 's1');
  st.stages.s1!.status = 'cleared';
  st.stages.s2!.status = 'open';
  E.markFront(x, st);
  assert.equal(st.front, 's2');
  assert.equal(st.stages.s2!.status, 'front');
  assert.equal(E.overLevelMult(5, 3), 1);
  assert.equal(E.overLevelMult(7, 3), 0.5);
  assert.equal(E.overLevelMult(10, 3), 0.25);
  const w = { W: 20, H: 20, walk: new Array(400).fill(1) };
  const c = E.ringCell(w, 10, 10, [6, 8], () => 0.5)!;
  const d = Math.hypot(c.x - 10, c.y - 10);
  assert.ok(d >= 5.5 && d <= 8.5);
});

test('休眠推算：威胁按时长回血、满血时阶段重置；补怪只补到上限；AI 推演的变化只能动这个区域', () => {
  const inst = { hp: 10, phase: 1, path: [{ x: 1, y: 1 }] };
  D.catchUpThreat(inst, { mortal: true, hp: 100 }, 120);
  assert.equal(inst.hp, 30);
  assert.deepEqual(inst.path, []);
  D.catchUpThreat(inst, { mortal: true, hp: 100 }, 6000);
  assert.equal(inst.hp, 100);
  assert.equal(inst.phase, undefined);
  assert.equal(D.refillCount(600, 100, 1, 3), 2);
  assert.equal(D.refillCount(50, 100, 0, 3), 0);
  const reg = (id: string) => (id.startsWith('m_') ? 'm' : 'town');
  const has = (id: string) => id === 'm_house' || id === 't_house';
  assert.equal(D.checkWakeChange({ op: 'setBuildingState', args: { id: 'm_house', state: 'damaged' } }, 'm', reg, has), null);
  assert.match(D.checkWakeChange({ op: 'setBuildingState', args: { id: 't_house', state: 'damaged' } }, 'm', reg, has)!, /不是这个区域/);
  assert.match(D.checkWakeChange({ op: 'setBuildingState', args: { id: 'm_house', state: 'ruin' } }, 'm', reg, has)!, /closed/);
  assert.match(D.checkWakeChange({ op: 'removeBuilding', args: { id: 'm_house' } }, 'm', reg, has)!, /不能用/);
  assert.equal(D.checkWakeChange({ op: 'plantGrove', args: { near: 'm_glade' } }, 'm', reg, has), null);
});

// ---------- 世界包 ----------
test('《破晓远征》通过校验；其他官方世界没有冒险字段，照旧通过', () => {
  assert.deepEqual(validateSpec(packSpec(DM)), []);
  for (const id of ['yunxi', 'little-red', 'night-watch', 'pangu']) assert.deepEqual(validateSpec(packSpec(loadPack(path.resolve('worlds', id)))), [], id);
});

test('冒险字段的校验：未知路线、远征超过一支、引用不存在的区域', () => {
  const s = packSpec(DM);
  const bad = structuredClone(s) as WorldSpec;
  bad.personas[0]!.growth = { track: 'nope' };
  bad.expeditions = [{ id: 'second', party: 'dawn', stages: [{ id: 'z1', region: 'nowhere', title: '没有的地方', clear: 'true' }] }];
  const errs = validateSpec(bad).join('\n');
  assert.match(errs, /未知路线：nope/);
  assert.match(errs, /expedition 与 expeditions 只能写一个/);
  assert.match(errs, /暂时只支持 1 支/);
  assert.match(errs, /未知区域：nowhere/);
});

// ---------- 小镇 ----------
test('远征开局：第一段的区域打开、队伍三人；快照里有冒险字段，旧世界没有', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.adventureTick();
  assert.ok(town.regionOpen('meadow'), '第一段的草原打开了');
  assert.ok(!town.regionOpen('forest'), '森林还锁着');
  const adv = town.snapshot().adv!;
  assert.deepEqual(adv.parties.dawn!.members, ['lan', 'baizhi', 'tiezhen']);
  assert.equal(adv.expeditions[0]!.front, 's1');
  assert.deepEqual(adv.spotlight, ['lan']);
  const old = new Town({ dataDir: tmp(), instantTalk: true, mods: [] });
  t.after(() => old.stop());
  assert.equal(old.snapshot().adv, undefined);
});

test('刷野怪：队伍在前线时才刷，刷在视野边缘、不开事件；打倒后经验分给参战的人，升级学招', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.t = 9 * 60;
  town.adventureTick();
  assert.equal(live(town, 'dew_slime').length, 0, '没人在草原时不刷');
  const lan = place(town, 'lan', 'wind_plain');
  place(town, 'baizhi', 'wind_plain');
  minutes(town, 1);
  const slimes = live(town, 'dew_slime');
  assert.equal(slimes.length, 1, '队伍到了就刷');
  assert.ok(slimes[0]!.wild, '野怪');
  assert.equal(town.dark.incidents.length, 0, '野怪不开事件');
  const d = Math.hypot(slimes[0]!.x - lan.x, slimes[0]!.y - lan.y);
  assert.ok(d > 3, `刷在视野边缘（${d.toFixed(1)} 格）`);
  // 打一场
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  town.on('adv', (e) => events.push(e));
  Object.assign(slimes[0]!, { x: lan.x + 1, y: lan.y });
  const r = town.engage({ kind: 'agent', id: 'lan' }, { kind: 'threat', id: slimes[0]!.id });
  assert.ok(r.ok);
  fightOut(town);
  assert.equal(live(town, 'dew_slime').length, 0);
  assert.ok(events.some((e) => e.type === 'exp'), '发了经验事件');
  assert.ok(lan.xp!.exp > 0 || lan.xp!.level > 1, '岚拿到了经验');
  assert.equal(town.adventure.kills.meadow, 1);
  assert.equal(town.expState(town.expeditions()[0]!).stages.s1!.kills, 1);
  // 连升到 4 级：学会回旋斩，血上限涨了
  const hp0 = town.maxHp(lan);
  town.grantExp({ kind: 'agent', agent: lan }, 200);
  assert.ok(lan.xp!.level >= 4);
  assert.ok(lan.abilities.includes('whirl_blade'), '4 级学会回旋斩');
  assert.ok(town.maxHp(lan) > hp0);
  assert.ok(events.some((e) => e.type === 'levelup' && (e.learned as Array<{ id: string }>).some((x) => x.id === 'whirl_blade')));
  assert.ok(town.logs.some((l) => l.type === 'levelup' && l.milestone === 'levelup'));
});

test('Boss：击败数够了先预告、到点出现；打倒后征服这一段——奖励、碎片、下一段的区域打开', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.t = 9 * 60;
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  town.on('adv', (e) => events.push(e));
  place(town, 'lan', 'wind_plain');
  town.adventure.kills.meadow = 8;
  minutes(town, 1);
  const fs1 = events.find((e) => e.type === 'foreshadow');
  assert.ok(fs1, '先发预告');
  assert.equal(fs1!.eta, 45);
  assert.equal(live(town, 'wolf_king').length, 0, '预告期间还没出现');
  assert.equal(town.snapshot().adv!.foreshadows.length, 1);
  minutes(town, 46);
  const king = live(town, 'wolf_king')[0];
  assert.ok(king, '到点出现');
  assert.equal(town.adventure.foreshadows.length, 0);
  // 直接打倒（战斗外）
  const lan = town.byId.lan!;
  town.threats.hit(king!, 9999, [], lan);
  minutes(town, 1);
  const st = town.expState(town.expeditions()[0]!);
  assert.equal(st.stages.s1!.status, 'cleared');
  assert.equal(st.front, 's2');
  assert.equal(st.tokens, 1);
  assert.ok(town.regionOpen('forest'), '森林打开了');
  assert.equal(lan.inventory.dawn_shard, 1);
  assert.equal(lan.inventory.iron_sword, 1);
  assert.equal(town.combatStats(lan).atk, town.combatStats({ ...lan, inventory: { iron_sword: 1 } } as never).atk, '铁剑替换了木剑（同槽只算一件）');
  const fr = events.find((e) => e.type === 'frontier');
  assert.ok(fr, '发了道路点亮事件');
  assert.equal((fr!.to as Array<{ region: string }>)[0]!.region, 'forest');
  assert.ok(town.logs.some((l) => l.milestone === 'cleared'));
  assert.ok(!town.spec.lore.canon.some((c) => /露团/.test(c.text)), '野怪不进设定集');
});

test('撤退与休整：血少撤到最近的回复点（全队一起），在那里回血，回够了恢复日程', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.t = 10 * 60;
  const lan = place(town, 'lan', 'wind_plain');
  const bz = place(town, 'baizhi', 'wind_plain');
  lan.body.hp = 20;
  minutes(town, 1);
  assert.equal(lan.resting?.why, 'retreat');
  assert.equal(lan.resting?.at, 'traveler_camp', '草原上最近的回复点是旅人营地');
  assert.equal(bz.resting?.at, 'traveler_camp', '队长撤，全队撤');
  assert.equal(town.adventure.today.retreats, 1);
  const e = town.desired(lan);
  assert.equal(e.location, 'traveler_camp');
  // 到了营地，按速率回血
  place(town, 'lan', 'traveler_camp');
  lan.resting = { at: 'traveler_camp', since: Math.floor(town.t), why: 'retreat' };
  const before = lan.body.hp;
  town.updateBody(lan, 10);
  assert.ok(lan.body.hp - before > 15, `在营地回血很快（${(lan.body.hp - before).toFixed(1)}）`);
  lan.body.hp = town.maxHp(lan);
  assert.equal(town.restEntry(lan), null, '回够了就不再休整');
  assert.equal(lan.resting, null);
});

test('被打倒：同伴在身边就搀扶去回复点；没人时过一阵子被送到；夜里在营地就地睡', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.t = 10 * 60;
  const lan = place(town, 'lan', 'wind_plain');
  const tz = place(town, 'tiezhen', 'wind_plain');
  place(town, 'baizhi', 'church');
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  town.on('adv', (e) => events.push(e));
  town.sendToClinic(lan);
  assert.equal(lan.resting?.why, 'downed');
  assert.equal(tz.resting?.at, lan.resting?.at, '铁砧扶着他走');
  assert.equal((events.find((e) => e.type === 'downed')!.carrier as { id: string }).id, 'tiezhen');
  assert.ok(lan.memories.some((m) => /铁砧把我扶去了/.test(m.text)));
  // 没有人在身边
  const t2 = dmTown();
  t.after(() => t2.stop());
  t2.t = 10 * 60;
  const l2 = place(t2, 'lan', 'stone_ring');
  place(t2, 'tiezhen', 'church');
  place(t2, 'baizhi', 'church');
  t2.sendToClinic(l2);
  minutes(t2, 31);
  assert.equal(l2.locId, 'traveler_camp', '被送到了营地');
  assert.equal(l2.region, 'meadow');
  // 夜里在营地就地睡
  t2.t = Math.floor(t2.t / 1440) * 1440 + 23 * 60;
  const n = t2.restEntry(l2)!;
  assert.ok(n.sleep && n.sleepAt === 'traveler_camp');
});

test('结伴：队员跟着队长的去处；队长开打，身边的队员加入同一方；效果 party 让人入队', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.t = 10 * 60;
  const lan = place(town, 'lan', 'wind_plain');
  const bz = place(town, 'baizhi', 'wind_plain');
  lan.curEntry = { key: 'k', location: 'stone_ring', activity: '巡逻' };
  const e = town.desired(bz);
  assert.equal(e.location, 'stone_ring');
  assert.match(e.activity, /跟着岚/);
  // 开打
  const inst = town.threats.spawn('grass_wolf', { at: { x: lan.x + 1, y: lan.y, region: 'meadow' }, quiet: true, wild: true })!;
  town.engage({ kind: 'agent', id: 'lan' }, { kind: 'threat', id: inst.id });
  town.partyAssist();
  const F = town.fightOf({ kind: 'agent', id: 'lan' })!;
  const side = (id: string) => F.fighters.find((x) => x.id === id)!.side;
  assert.equal(side('baizhi'), side('lan'), '白芷站在岚这一边');
  fightOut(town);
  // 萤：第二段征服后入队
  const ying = town.byId.ying!;
  assert.equal(town.partyOf(ying), null);
  town.expState(town.expeditions()[0]!).stages.s2!.status = 'cleared';
  minutes(town, 25);
  assert.equal(town.partyOf(ying), 'dawn');
  assert.ok(town.snapshot().adv!.parties.dawn!.members.includes('ying'));
});

test('治疗招式奶最伤的同伴；回复道具在战斗里自动使用', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  const lan = place(town, 'lan', 'wind_plain');
  const bz = place(town, 'baizhi', 'wind_plain');
  const inst = town.threats.spawn('grass_wolf', { at: { x: lan.x + 1, y: lan.y, region: 'meadow' }, quiet: true, wild: true })!;
  town.engage({ kind: 'agent', id: 'lan' }, { kind: 'threat', id: inst.id });
  town.partyAssist();
  const F = town.fightOf({ kind: 'agent', id: 'lan' })!;
  lan.body.hp = 20;
  const f = F.fighters.find((x) => x.id === 'baizhi')!;
  const u = town.unit(f)!;
  assert.equal(town.hurtAlly(F, f, u)?.agent, lan);
  const kit = town.skillsOf(F.fighters.find((x) => x.id === 'lan')!);
  assert.ok(kit.some((s) => s.id === 'item_healing_herb' && s.selfOnly), '回春草变成了只治自己的招');
  void bz;
});

test('旅人化身复用同一套成长与回复：等级按账号保存、上限受居民等级约束、被打倒在最近的回复点醒来', (t) => {
  const dir = tmp();
  const town = dmTown(dir);
  t.after(() => town.stop());
  const v = town.avatars.join('u1', '1.1.1.1', { name: '旅人甲' });
  assert.equal(town.avatarXp(v)!.level, 1);
  assert.equal(town.avatarCap(), 5, '居民都是 1 级时，上限是 5');
  town.grantExp({ kind: 'avatar', avatar: v }, 10_000);
  assert.equal(town.adventure.avatars.u1!.level, 5);
  assert.ok(town.avatarKitOf(v).includes('whirl_blade'), '4 级学会回旋斩，进了技能栏');
  assert.ok(town.avatarKitOf(v).length <= 4);
  assert.ok(town.avatarMaxHp(v) > 100);
  // 在草原上被打倒：醒在旅人营地
  town.adventureTick();
  const c = town.locCenter('wind_plain')!;
  Object.assign(v, { region: 'meadow', x: c.x, y: c.y });
  town.avatars.knockout(v);
  assert.equal(v.region, 'meadow');
  assert.equal(v.locId, 'traveler_camp');
  assert.equal(v.hp, town.avatarMaxHp(v));
  const view = town.avatars.view()[0]!;
  assert.equal(view.level, 5);
  town.save();
  town.stop();
  const again = dmTown(dir);
  t.after(() => again.stop());
  assert.equal(again.adventure.avatars.u1!.level, 5, '等级按账号存在存档里');
});

test('区域休眠：没人去 6 小时后休眠、怪不动；有人来时唤醒并按时间推算；休眠的区域不随初始数据下发', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.adventureTick();
  const slime = town.threats.spawn('dew_slime', { loc: 'wind_plain', quiet: true, wild: true })!;
  slime.hp = 5;
  for (const a of town.agents) if (a.region === 'meadow') place(town, a.id, 'village_square');
  minutes(town, D.REGION_IDLE + 2);
  assert.equal(town.regionActive('meadow'), false, '草原休眠了');
  assert.equal(town.regionsView().meadow!.dormant, true);
  const pay = town.initPayload().regions.meadow as { stub?: boolean };
  assert.equal(pay.stub, true, '初始数据里只给 stub');
  const pos = { x: slime.x, y: slime.y };
  slime.path = [{ x: pos.x + 3, y: pos.y }];
  town.threats.tick(5);
  assert.deepEqual({ x: slime.x, y: slime.y }, pos, '休眠区域里的怪不动');
  // 两小时后观众打开草原
  town.t += 120;
  town.watchRegion('meadow');
  assert.ok(town.regionActive('meadow'));
  assert.ok(slime.hp! > 5, '按休眠时长回了血');
  assert.equal((town.initPayload().regions.meadow as { tiles?: unknown }).tiles != null, true);
});

test('AI 推演：只应用白名单里、属于这个区域的变化；不合法的丢掉；Boss 不会被推演出来', (t) => {
  const town = dmTown();
  t.after(() => town.stop());
  town.adventureTick();
  const before = town.specOps.length;
  town.applyWakeStory('meadow', {
    summary: '狼群在石环附近换了窝',
    changes: [
      { op: 'plantGrove', args: { near: 'stone_ring', w: 3, h: 3 } },
      { op: 'removeBuilding', args: { id: 'inn' } },
      { op: 'setBuildingState', args: { id: 'inn', state: 'damaged' } },
    ],
    spawns: [{ threat: 'grass_wolf', at: 'stone_ring' }, { threat: 'wolf_king', at: 'wolf_den' }],
  });
  assert.ok(!town.spec.buildings.find((b) => b.id === 'inn')!.state, '村里的旅店不受影响');
  assert.equal(live(town, 'wolf_king').length, 0, 'Boss 不会被推演出来');
  assert.equal(live(town, 'grass_wolf').length, 1);
  assert.ok(town.specOps.length > before, '种树生效了（记入历史）');
  assert.ok(town.logs.some((l) => /狼群在石环附近换了窝/.test(l.text)));
});

test('存档：等级、队伍、休整、远征进度、区域状态都写进存档，重启后接着用', (t) => {
  const dir = tmp();
  const town = dmTown(dir);
  town.adventureTick();
  const lan = town.byId.lan!;
  town.grantExp({ kind: 'agent', agent: lan }, 100);
  const lv = lan.xp!.level;
  town.setParty(town.byId.ying!, 'dawn');
  town.adventure.kills.meadow = 3;
  town.save();
  town.stop();
  const again = dmTown(dir);
  t.after(() => again.stop());
  assert.equal(again.byId.lan!.xp!.level, lv);
  assert.equal(again.partyOf(again.byId.ying!), 'dawn');
  assert.equal(again.adventure.kills.meadow, 3);
  assert.ok(again.regionOpen('meadow'));
});

test('没有 recovery 的旧世界：送诊所的行为不变', (t) => {
  const town = new Town({ dataDir: tmp(), instantTalk: true, mods: [] });
  t.after(() => town.stop());
  town.t = 10 * 60;
  const a = town.agents[0]!;
  town.sendToClinic(a);
  assert.equal(a.resting, undefined);
  assert.ok(a.schedule.some((e) => e.location === 'clinic' && e.activity === '在诊所休息'));
});

test('创世的冒险步骤：模型给的队伍、风格、土地拼成相邻地图、远征、野怪与首领，整体通过校验', async () => {
  const { assembleAdventure } = await import('../server/genesis/adventure.ts');
  const { checkPack } = await import('../server/genesis/pipeline.ts');
  const pack = loadPack(path.resolve('worlds/little-red'));
  const ids = pack.world.personas.map((p: { id: string }) => p.id);
  const raw = {
    party: { name: '护送小队', leader: ids[0], members: [ids[1], 'nobody'] },
    styles: { [ids[0]!]: 'attack', [ids[1]!]: 'heal' },
    lands: [
      { id: 'wolf_wood', name: '狼林', biome: 'forest', title: '第一章 狼林', intro: '林子里全是狼', places: [{ id: 'den', kind: 'clearing', name: '狼窝', emoji: '🐺', desc: '狼窝' }, { id: 'rest', kind: 'camp', name: '猎人营地', emoji: '🏕️', desc: '' }],
        monsters: [{ id: 'wolf', name: '灰狼', emoji: '🐺', bodyPlan: 'beast', palette: { body: '#777777', eyes: 'bad' }, hp: 40, atk: 6 }],
        boss: { id: 'big_wolf', name: '大灰狼', emoji: '🐺', bodyPlan: 'beast', hp: 400, atk: 12, rage: '大灰狼仰天长嚎' } },
      { id: 'dark_hill', name: '暗丘', biome: 'nowhere', places: [{ id: 'hill', kind: 'house', name: '山丘' }], monsters: [], boss: { name: '影子', bodyPlan: 'unknown' } },
    ],
  };
  const r = assembleAdventure(raw, pack.world, pack.map as unknown as GenMap);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(checkPack(r.world, r.map), [], '拼出来的世界包通过完整校验');
  assert.equal(r.map.regions.length, pack.map.regions.length + 2);
  const land2 = r.map.regions.at(-1)!;
  assert.equal(land2.biome, 'meadow', '不认识的地貌换成默认的');
  assert.ok(land2.areas[0]!.places.some((p) => p.kind === 'camp'), '没写营地时补一个');
  assert.equal(r.world.expedition.stages.length, 2);
  assert.deepEqual(r.world.expedition.stages[0].unlock, ['s2']);
  assert.equal(r.world.threats.wolf.look.palette.eyes, undefined, '不合法的颜色丢掉');
  assert.ok(r.world.threats.big_wolf.boss);
  assert.deepEqual(Object.keys(r.world.parties), ['party']);
  assert.equal(r.world.personas.find((p: { id: string }) => p.id === ids[0]).plotArmor, true);
  assert.equal(pack.map.regions.length, r.map.regions.length - 2, '不改原来的地图（在副本上拼）');
});
