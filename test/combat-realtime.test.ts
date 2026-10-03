// 即时战斗（docs/design/combat.md）：战斗时钟、旅人化身出招、居民的规则 AI、结局、存读档与确定性
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';
import type { LiveAgent } from '../server/types/agent.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack } = await import('../server/worlds/pack.ts');

const NW = loadPack(path.resolve('worlds/night-watch'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-fight-'));
const nwTown = (opts: Record<string, unknown> = {}) => new Town({ dataDir: tmp(), worldId: 'night-watch', pack: NW, instantTalk: true, mods: [], seed: 7, ...opts });
const night = (town: TownT) => { town.t = (town.day - 1) * 1440 + 21 * 60; };
const byName = (town: TownT, n: string) => town.agents.find((a) => a.name === n)!;
const beats = (town: TownT, n: number) => { for (let i = 0; i < n; i++) town.combatTick(); };
const fightOut = (town: TownT, n = 400) => { for (let i = 0; i < n && town.fights.length; i++) town.combatTick(); };
function put(town: TownT, a: LiveAgent, loc: string, dx = 0) {
  const s = town.findLocation(loc)!.spots?.[0] || town.locCenter(loc)!;
  Object.assign(a, { x: s.x + dx, y: s.y, inside: null, locId: loc, path: [], status: 'acting', region: town.locRegion(loc) });
}
/** 纸扎人（会死、怕火）刷在 (x+1, y) */
function paperMan(town: TownT, x: number, y: number) {
  const inst = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(inst, { x: x + 1, y, path: [], region: 'town' });
  return inst;
}
function avatarAt(town: TownT, loc: string) {
  const v = town.avatars.join('u1', '127.0.0.1', { name: '阿游' });
  const s = town.findLocation(loc)!.spots?.[0] || town.locCenter(loc)!;
  Object.assign(v, { x: s.x, y: s.y, path: [] });
  return v;
}

test('旅人化身：出招开打，按拍结算（读条 → 生效 → 硬直），技能能打出弱点；打赢后战斗结束', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  night(town);
  const v = avatarAt(town, 'earth_shrine');
  const pm = paperMan(town, v.x, v.y);
  const events: Array<{ hits: Array<{ dmg: number }>; casts: Array<{ skill: string }>; end?: boolean }> = [];
  town.on('combat', (e) => events.push(e));
  assert.match(town.avatarAct('nobody', { skill: 'strike' }).reason!, /还没有/);
  assert.match(town.avatarAct('u1', { skill: 'fireball' }).reason!, /没有这一招/);
  assert.ok(town.avatarAct('u1', { skill: 'cinnabar_flick', target: `threat:${pm.id}` }).ok);
  assert.ok(town.engaged('avatar', v.id) && town.engaged('threat', pm.id));
  beats(town, 1);
  const me = () => town.fightsView()[0]!.fighters.find((f) => f.kind === 'avatar')!;
  assert.equal(me().act?.skill, 'cinnabar_flick', '第一拍开始蓄力');
  assert.equal(me().act?.phase, 'windup');
  beats(town, 2);
  assert.ok(events.some((e) => e.hits.length), '蓄力完成后命中');
  assert.ok(pm.hp! < 40);
  // 一直普攻到打死它（化身闲下来时执行排队的指令）
  for (let i = 0; i < 300 && town.fights.length; i++) { if (i % 2 === 0) town.avatarAct('u1', { skill: 'strike' }); town.combatTick(); }
  assert.equal(pm.state, 'gone', '纸扎人被打死了');
  assert.equal(town.fights.length, 0);
  assert.ok(events.some((e) => e.end));
  assert.ok(town.logs.some((l) => /阿游消灭了纸扎人/.test(l.text)));
  assert.ok(!town.snapshot().fights, '没有战斗时快照里没有 fights');
});

test('化身被打倒：回到出生点、缓几秒、血量回满；会死的威胁撞上身边的旅人会主动动手', (t) => {
  let now = 1_000_000;
  const town = nwTown({ now: () => now });
  t.after(() => town.stop());
  night(town);
  const v = avatarAt(town, 'earth_shrine');
  const pm = paperMan(town, v.x, v.y);
  town.combatTick(1); // 每秒看一次身边有没有旅人
  assert.ok(town.engaged('threat', pm.id), '纸扎人先动手');
  v.hp = 3;
  fightOut(town);
  assert.equal(v.hp, 100);
  assert.ok((v.downUntil || 0) > now, '倒下后要缓一缓');
  assert.match(town.avatarAct('u1', { skill: 'strike' }).reason!, /倒下了/);
  assert.equal(v.locId, town.avatars.spawnPoint().spawn);
  now += 5000;
  assert.match(town.avatarAct('u1', { skill: 'strike' }).reason!, /身边没有/);
});

test('化身对居民：只有世界的创建者 / 管理员能动手，只会打倒不会打死；居民用规则 AI 还手', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const lin = byName(town, '林小满');
  put(town, lin, 'plaza');
  const v = avatarAt(town, 'plaza');
  Object.assign(v, { x: lin.x + 1, y: lin.y });
  assert.match(town.avatarAct('u1', { skill: 'strike', target: `agent:${lin.id}` }).reason!, /不能对这里的居民动手/);
  lin.body.courage = 90; // 不逃
  assert.ok(town.avatarAct('u1', { skill: 'strike', target: `agent:${lin.id}` }, { residents: true }).ok);
  assert.ok(town.engaged('agent', lin.id));
  assert.ok((lin.travellers?.u1?.affinity ?? 0) <= -40, '被打的人记恨这个旅人');
  let hitBack = false;
  town.on('combat', (e) => { if (e.casts.some((c: { by: { kind: string } }) => c.by.kind === 'agent')) hitBack = true; });
  for (let i = 0; i < 400 && town.fights.length; i++) { if (i % 2 === 0) town.avatarAct('u1', { skill: 'strike' }, { residents: true }); town.combatTick(); }
  assert.ok(hitBack, '居民还手了');
  assert.ok(town.agents.includes(lin), '没有被打死');
  assert.ok(lin.body.conditions.includes('重伤'));
  assert.ok(!town.engaged('agent', lin.id));
});

test('居民的规则 AI：会用带 combat 块的能力；被打倒的居民离场，其他人回到日程', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  night(town);
  const shen = byName(town, '沈砚');
  put(town, shen, 'earth_shrine');
  shen.abilities.push('cinnabar_flick');
  shen.body.courage = 90;
  const pm = paperMan(town, shen.x, shen.y);
  const used = new Set<string>();
  town.on('combat', (e) => { for (const c of e.casts) used.add(c.skill); });
  assert.ok(town.hunt(shen, { threat: '纸扎人' }).ok);
  fightOut(town);
  assert.ok(used.has('cinnabar_flick'), '用了弹朱砂');
  assert.equal(pm.state, 'gone');
  assert.equal(shen.curKey, null, '打完回到日程');
  assert.ok(shen.memories.some((m) => /和纸扎人打了一场/.test(m.text)));
});

test('状态与击退：眩晕打断蓄力、击退把人推开、护盾挡伤害', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  night(town);
  const v = avatarAt(town, 'earth_shrine');
  const pm = paperMan(town, v.x, v.y);
  assert.ok(town.avatarAct('u1', { skill: 'steady_breath' }).ok);
  beats(town, 2);
  const F = town.fights[0]!;
  const me = F.fighters.find((f) => f.kind === 'avatar')!;
  assert.ok(me.statuses.some((s) => s.id === 'shield'), '定神：挂上护盾');
  const x0 = pm.x;
  for (let i = 0; i < 40 && !F.fighters.find((f) => f.kind === 'threat')!.statuses.some((s) => s.id === 'slow'); i++) { town.avatarAct('u1', { skill: 'lamp_sweep' }); town.combatTick(); }
  assert.ok(F.fighters.find((f) => f.kind === 'threat')!.statuses.some((s) => s.id === 'slow'), '灯扫：减速');
  assert.ok(Math.abs(pm.x - x0) > 0.4 || pm.state === 'gone', '灯扫：击退');
  // 闪避：朝按着的方向冲出去，几拍内无敌
  if (town.fights.length) {
    for (let i = 0; i < 12 && me.act; i++) town.combatTick();
    const [vx, vy] = [v.x, v.y];
    assert.ok(town.avatarAct('u1', { skill: 'dodge', dir: [0, 1] }).ok);
    beats(town, 1);
    assert.ok(v.y > vy && v.x === vx, '往下冲');
    assert.ok(me.statuses.some((s) => s.id === 'dodge'));
  }
});

test('存读档：进行中的战斗保存下来，化身不进存档；旧版的回合制打斗被丢弃；同一个种子打出同样的结果', (t) => {
  const dir = tmp();
  const town = nwTown({ dataDir: dir });
  night(town);
  const shen = byName(town, '沈砚'), xiao = byName(town, '萧九');
  put(town, xiao, 'park'); put(town, shen, 'park', 1);
  assert.ok(town.attack(xiao, { target: '沈砚', intent: 'subdue' }).ok);
  beats(town, 3);
  town.save();
  town.stop();
  const again = nwTown({ dataDir: dir });
  t.after(() => again.stop());
  assert.equal(again.fights.length, 1);
  assert.ok(again.engaged('agent', 'shen'));
  fightOut(again);
  assert.equal(again.fights.length, 0);

  // 两个同种子的世界打同一场，结果一致
  const run = () => {
    const w = nwTown();
    night(w);
    const a = byName(w, '萧九'), b = byName(w, '沈砚');
    put(w, a, 'park'); put(w, b, 'park', 1);
    b.body.courage = 90;
    w.attack(a, { target: '沈砚' });
    const trace: number[] = [];
    for (let i = 0; i < 60 && w.fights.length; i++) { w.combatTick(); trace.push(a.body.hp, b.body.hp); }
    w.stop();
    return trace;
  };
  assert.deepEqual(run(), run());
});

test('AI 创造的战斗技能：addAbility 保留 combat 块；setAvatarKit 放进旅人的技能栏；居民学会后在战斗里会用；重启后还在', (t) => {
  const dir = tmp();
  const town = nwTown({ dataDir: dir });
  night(town);
  const ab = { id: 'ash_whip', name: '灰鞭', emoji: '🌪️', target: 'agent', desc: '卷起一鞭香灰抽过去', combat: { windup: 2, range: 4, shape: 'line', cd: 6 }, effects: [{ op: 'strike', power: 1.6, tags: ['fire'] }, { op: 'status', status: 'slow', beats: 6 }] };
  town.applyWorldOp({ op: 'addAbility', args: ab }, { by: 'architect' });
  assert.deepEqual(town.spec.abilities.find((x) => x.id === 'ash_whip')!.combat, ab.combat);
  assert.throws(() => town.applyWorldOp({ op: 'addAbility', args: { ...ab, id: 'bad_whip', combat: { windup: 99 } } }, { by: 'architect' }), /windup/);
  assert.throws(() => town.applyWorldOp({ op: 'addAbility', args: { ...ab, id: 'god_whip', power: 'genesis' } }, { by: 'architect' }), /power/);
  assert.throws(() => town.applyWorldOp({ op: 'setAvatarKit', args: { ids: ['look_back'] } }, { by: 'architect' }), /combat/);
  town.applyWorldOp({ op: 'setAvatarKit', args: { ids: ['ash_whip', 'steady_breath'] } }, { by: 'architect' });
  assert.deepEqual(town.spec.combat!.avatarKit, ['ash_whip', 'steady_breath']);
  const shen = byName(town, '沈砚');
  put(town, shen, 'earth_shrine');
  shen.abilities.push('ash_whip');
  shen.body.courage = 90;
  const pm = paperMan(town, shen.x, shen.y);
  const used = new Set<string>();
  town.on('combat', (e) => { for (const c of e.casts) used.add(c.skill); });
  town.hunt(shen, { threat: '纸扎人' });
  fightOut(town);
  assert.ok(used.has('ash_whip'), '居民在战斗里用了 AI 造的招式');
  assert.equal(pm.state, 'gone');
  town.save();
  town.stop();
  const again = nwTown({ dataDir: dir });
  t.after(() => again.stop());
  assert.ok(again.spec.abilities.find((x) => x.id === 'ash_whip')?.combat, '重放后 combat 块还在');
  assert.deepEqual(again.spec.combat!.avatarKit, ['ash_whip', 'steady_breath']);
});

test('旁观者：和挨打一方交情深、够勇敢的人冲上去帮忙（护着他）；胆小的只记下自己没敢上前', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  night(town);
  const [xiao, shen, zhi, tang] = ['萧九', '沈砚', '沈知', '唐棠'].map((n) => byName(town, n));
  for (const [a, dx] of [[xiao, 0], [shen, 1], [zhi, 3], [tang, -3]] as const) put(town, a, 'park', dx);
  zhi.body.courage = 80; // 妹妹（好感 95）
  tang.body.courage = 20; // 医生（好感 45 → 拉到 60，但胆小）
  tang.relations.shen = { affinity: 60, note: '' };
  assert.ok(town.attack(xiao, { target: '沈砚', intent: 'subdue' }).ok);
  town.combatTick(1);
  const F = town.fights[0]!;
  const zf = F.fighters.find((f) => f.id === 'zhi');
  assert.ok(zf, '沈知加入了战斗');
  assert.equal(zf!.side, F.fighters.find((f) => f.id === 'shen')!.side, '站在哥哥一边');
  assert.equal(zf!.tactic, 'protect');
  assert.deepEqual(zf!.protect, { kind: 'agent', id: 'shen' });
  assert.ok(!F.fighters.some((f) => f.id === 'tang'));
  assert.ok(tang.memories.some((m) => /没敢上前/.test(m.text)));
  assert.ok(town.logs.some((l) => /沈知冲上去帮沈砚/.test(l.text)));
});

test('模型定战术与台词：开打时问一次，回复到了覆盖兜底的战术并说出来；濒死时再问一次；模型出错时用兜底', async (t) => {
  const llm = await import('../server/llm.ts');
  const asked: string[] = [];
  llm.setMock((_m, opts) => {
    asked.push(String(opts.label));
    return opts.label === '战斗战术' ? '{"tactic":"defensive","protect":null,"line":"我不想伤你。"}' : '{"line":"还没完……","tactic":"flee"}';
  });
  t.after(() => llm.setMock(null));
  const town = nwTown();
  t.after(() => town.stop());
  night(town);
  const [xiao, shen] = ['萧九', '沈砚'].map((n) => byName(town, n));
  put(town, xiao, 'park'); put(town, shen, 'park', 1);
  assert.ok(town.attack(xiao, { target: '沈砚' }).ok);
  await new Promise((r) => setTimeout(r, 20));
  const sf = town.fights[0]!.fighters.find((f) => f.id === 'shen')!;
  assert.equal(sf.tactic, 'defensive');
  assert.equal(shen.bubble?.text, '我不想伤你。');
  shen.body.hp = 40;
  for (let i = 0; i < 80 && !sf.said?.includes('low'); i++) town.combatTick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(asked.includes('战斗台词'), '濒死时问了一句');
  assert.equal(asked.filter((x) => x === '战斗战术').length, 2, '每个参战的居民各问一次');
});

test('旅人的像素形象：白名单里的发型、发色、肤色照用，乱写的换成默认值；裤子跟衣服配色；快照里带形象', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const v = town.avatars.join('u9', '127.0.0.1', { name: '阿形', color: '#64b5f6', look: { hairStyle: 'braid', hair: '#d9b26a', skin: '#8d5f43' } });
  assert.deepEqual(v.look, { skin: '#8d5f43', hair: '#d9b26a', hairStyle: 'braid', shirt: '#64b5f6', pants: '#3e4a5e', acc: [] });
  const w = town.avatars.join('u8', '127.0.0.1', { name: '阿乱', color: 'red', look: { hairStyle: '<script>', hair: 'url(x)', skin: 1 as unknown as string } });
  assert.equal(w.look.hairStyle, 'short');
  assert.match(w.look.hair, /^#[0-9a-f]{6}$/);
  assert.equal(w.look.shirt, w.color, '衣服颜色就是化身的颜色');
  // 再次现身只换衣服：发型保留
  town.avatars.join('u9', '127.0.0.1', { name: '阿形', color: '#81c784' });
  assert.equal(v.look.hairStyle, 'braid');
  assert.equal(v.look.shirt, '#81c784');
  assert.ok(town.avatars.view().every((x) => x.look?.hairStyle));
});
