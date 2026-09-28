// 黑暗叙事（docs/design/night-watch.md）：分级与审核、规律型威胁（标记 → 应验 / 逃过）、死亡流程与死亡预算、线索与信念、
// 对抗方式（压制、收容、泄漏、化解、消灭）、负担值与宿主、战斗与敌对行动、剧情动作、存读档，以及现有世界不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.js');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const llm = await import('../server/llm.js');
const { Town } = await import('../server/sim.js');
const { loadPack, packSpec } = await import('../server/worlds/pack.js');
const { validateSpec } = await import('../server/kernel/spec.js');
const { useAbility } = await import('../server/kernel/abilities.js');
const { checkBeat, runBeats, ALL_KINDS } = await import('../server/story/beats.js');
const { keywordCheck, targetsResident } = await import('../server/guard.js');
const { ratingAtLeast, lethal } = await import('../server/kernel/ratings.js');

llm.setMock(null);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-dark-'));
const NW = loadPack(path.resolve('worlds/night-watch'));
const nwTown = (opts = {}) => new Town({ dataDir: opts.dir || tmp(), worldId: 'night-watch', pack: opts.pack || NW, instantTalk: true, mods: [], ...opts });
/** 把时间拨到当天的某个钟点（不经过中间的推进） */
const at = (town, hh, mm = 0) => { town.t = (town.day - 1) * 1440 + hh * 60 + mm; };
/** 把居民放到某个地点的户外站位上 */
function put(town, a, loc, dx = 0) {
  const l = town.findLocation(loc);
  const s = l.spots?.[0] || town.locCenter(loc);
  Object.assign(a, { x: s.x + dx, y: s.y, inside: null, locId: loc, region: 'town', status: 'acting', path: [], dest: null, convoId: null });
}
const inst = (town, type) => town.dark.threats.find((x) => x.type === type && !['gone', 'contained'].includes(x.state));
const byName = (town, n) => town.agents.find((a) => a.name === n);

test('分级：dark 排在 epic 与 tragic 之间，会致死；审核放行虚构战斗，拦截血腥', () => {
  assert.ok(ratingAtLeast('dark', 'epic') && !ratingAtLeast('dark', 'tragic'));
  assert.ok(lethal('dark') && lethal('tragic') && !lethal('epic'));
  assert.ok(keywordCheck('他杀死了那只恶魔', 'dark').ok);
  assert.ok(!keywordCheck('他杀死了那只恶魔', 'epic').ok, 'epic 仍然拦截死亡词汇');
  assert.ok(keywordCheck('屠夫从地下走了出来', 'dark').ok, '角色名「屠夫」在致死分级下放行');
  assert.ok(!keywordCheck('满地血腥', 'dark').ok);
  assert.ok(!keywordCheck('一场屠杀', 'tragic').ok);
  assert.ok(targetsResident('让沈知今晚被祟杀死', ['沈知', '沈砚']));
  assert.ok(!targetsResident('城里又出事了', ['沈知']));
  assert.ok(!targetsResident('沈知今天去上学了', ['沈知']));
});

test('规格：《夜巡》世界包通过校验；写坏的规律、未知的对抗物品被拒绝', () => {
  const spec = packSpec(NW);
  assert.deepEqual(validateSpec(spec), []);
  const bad = structuredClone(spec);
  bad.threats.waiting_mother.rule.trigger = "eval('x')";
  bad.threats.phone_ring.counters[0].with = 'gold_bar';
  delete bad.threats.back_turned.clues;
  const errs = validateSpec(bad).join('\n');
  assert.match(errs, /waiting_mother.*不允许的函数|waiting_mother.*表达式/);
  assert.match(errs, /phone_ring.*contain\.with 未知物品/);
  assert.match(errs, /back_turned.*真线索/);
});

test('规律：在槐荫巷被叫了名字 → 被标记 → 应验死去；目击者得到线索，最亲近的人祟蚀跳涨，留下墓碑与遗物', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const zhi = byName(town, '沈知'), qian = byName(town, '钱伯'), shen = byName(town, '沈砚');
  zhi.inventory.old_photo = 1;
  put(town, zhi, 'fire_lane');
  put(town, qian, 'fire_lane', 1);
  const wm = inst(town, 'waiting_mother');
  Object.assign(wm, { x: zhi.x + 2, y: zhi.y });
  town.threats.minuteTick();
  assert.equal(zhi.marks?.length ?? 0, 0, '没被叫名字时规律不触发');
  zhi.namedAt = town.t;
  town.threats.minuteTick();
  assert.equal(zhi.marks.length, 1, '被标记');
  assert.ok(town.logs.some((l) => l.type === 'mark' && l.agents?.includes('zhi')));
  const erosion = shen.burdens.erosion;
  zhi.marks[0].due = town.t;
  town.threats.minuteTick();
  assert.ok(!town.agents.includes(zhi), '死者不在场');
  assert.equal(town.spec.personas.find((p) => p.id === 'zhi').status, 'dead');
  assert.equal(zhi.status, 'dead');
  assert.equal(town.dark.graves.at(-1).name, '沈知');
  assert.equal(shen.burdens.erosion, erosion + 15, '失去锚：祟蚀跳涨 15');
  assert.equal(shen.mood.text, '悲伤');
  assert.equal(shen.inventory.old_photo, 1, '遗物交给了最亲近的人');
  const b = qian.beliefs.find((x) => x.about === '等门的人');
  const def = town.spec.threats.waiting_mother;
  assert.ok(b && [...def.clues, ...def.decoys].includes(b.claim), '目击者形成了一个看法（可能是真线索，也可能是误导）');
  assert.ok(town.spec.lore.canon.some((c) => c.text.includes('沈知')), '写进了世界历史');
  assert.equal(town.dark.incidents.find((i) => i.type === 'waiting_mother').stage, 'outbreak');
  // 规律从不出现在居民的提示词里
  assert.ok(!town.personaBlock(qian).includes('named(') && !town.personaBlock(qian).includes('trigger'));
});

test('规律：应验时满足 unless（长明灯照着）→ 逃过一劫，得到一条确信的真线索', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const he = byName(town, '何敏');
  put(town, he, 'fire_lane');
  Object.assign(inst(town, 'waiting_mother'), { x: he.x + 2, y: he.y });
  he.namedAt = town.t;
  town.threats.minuteTick();
  assert.equal(he.marks.length, 1);
  town.spawnStructure('lamp_ward', { x: he.x, y: he.y, region: 'town' }, 120);
  he.marks[0].due = town.t;
  town.threats.minuteTick();
  assert.ok(town.agents.includes(he), '活了下来');
  const b = he.beliefs.find((x) => x.about === '等门的人');
  assert.equal(b.confidence, 0.85);
  assert.ok(town.spec.threats.waiting_mother.clues.includes(b.claim));
  assert.ok(town.logs.some((l) => l.type === 'survive'));
});

test('长明灯：有灯护着的人不会被标记，怕灯的东西会离开灯的范围', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const he = byName(town, '何敏');
  put(town, he, 'fire_lane');
  const wm = inst(town, 'waiting_mother');
  Object.assign(wm, { x: he.x + 1, y: he.y });
  town.spawnStructure('lamp_ward', { x: he.x, y: he.y, region: 'town' }, 120);
  he.namedAt = town.t;
  town.threats.minuteTick();
  assert.equal(he.marks?.length ?? 0, 0);
});

test('死亡预算与主角光环：预算用完、或有光环时，致命结果降为重伤；非致死分级下死亡也会降级', (t) => {
  const town = nwTown({ worldSettings: { deathNamed: 1 } });
  t.after(() => town.stop());
  const [a, b, c] = ['钱伯', '林小满', '何敏'].map((n) => byName(town, n));
  assert.equal(town.killAgent(a, { text: '钱伯走了' }), 'dead');
  assert.equal(town.deathBudget().left, 0);
  assert.equal(town.killAgent(b), 'spared');
  assert.ok(town.agents.includes(b) && b.body.hp < 30 && b.body.conditions.includes('重伤'));
  town.worldSettings.deathNamed = 5;
  town.spec.personas.find((p) => p.id === 'he').plotArmor = true;
  assert.equal(town.killAgent(c), 'spared', '主角光环');

  const adv = nwTown({ worldSettings: { rating: 'adventure' } });
  t.after(() => adv.stop());
  assert.equal(adv.killAgent(byName(adv, '钱伯')), 'wounded');
  assert.throws(() => adv.applyWorldOp({ op: 'setPersonaStatus', args: { id: 'qian', status: 'dead' } }), /不允许死亡/);
});

test('对抗：回望压住祟（付出祟蚀）→ 收容进镇匣 → 事件处置；镇匣开裂时祟会跑出来', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const shen = byName(town, '沈砚'), lu = byName(town, '陆承');
  put(town, shen, 'fire_lane');
  put(town, lu, 'fire_lane', 1);
  const wm = inst(town, 'waiting_mother');
  Object.assign(wm, { x: shen.x + 2, y: shen.y });
  const before = shen.burdens.erosion;
  assert.ok(useAbility(town, shen, 'look_back').ok);
  assert.equal(shen.burdens.erosion, before + 8, '借祟之力付出祟蚀');
  assert.equal(wm.state, 'suppressed');
  shen.namedAt = town.t;
  town.threats.minuteTick();
  assert.equal(shen.marks?.length ?? 0, 0, '被压住的祟不会标记人');
  assert.ok(town.threats.startContain(lu, '等门的人').ok);
  town.t += 26;
  town.threats.minuteTick();
  assert.equal(wm.state, 'contained');
  assert.equal(lu.inventory.sealed_box, 1);
  assert.ok(!lu.inventory.seal_box, '空镇匣用掉了');
  assert.equal(town.dark.incidents.find((i) => i.threat === wm.id).outcome, 'contained');
  assert.equal(town.dark.zones.length, 0, '区域随之消失');
  town.threats.random = () => 0;
  town.threats.dayTick();
  assert.ok(inst(town, 'waiting_mother'), '开裂之后又跑了出来');
});

test('收容：没压住就动手，多半失手并被它盯上', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const lu = byName(town, '陆承');
  put(town, lu, 'fire_lane');
  Object.assign(inst(town, 'waiting_mother'), { x: lu.x + 2, y: lu.y });
  town.threats.random = () => 0.9;
  assert.ok(town.threats.startContain(lu, '等门的人').ok);
  town.t += 26;
  town.threats.minuteTick();
  assert.equal(lu.marks.length, 1, '失手被盯上');
  assert.equal(lu.inventory.seal_box, 1, '镇匣还在');
});

test('化解：查到来历（研究）→ 学会寻亲并找到那个孩子 → 等门的人消散，写进世界历史', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const he = byName(town, '何敏');
  put(town, he, 'archive');
  he.researching = { topic: '等门的人的来历', since: town.t - 60, key: 'k', loc: 'archive' };
  town.finishResearch(he);
  assert.ok(he.beliefs.find((b) => b.about === '等门的人来历')?.confidence >= 0.6, '研究得到了来历');
  he.researching = { topic: '寻亲', since: town.t - 60, key: 'k2', loc: 'archive' };
  town.finishResearch(he);
  assert.ok(he.abilities.includes('seek_kin'));
  assert.ok(useAbility(town, he, 'seek_kin').ok);
  town.threats.hourTick();
  assert.ok(!inst(town, 'waiting_mother'));
  assert.equal(town.worldFlags.resolved_waiting_mother, true);
  assert.equal(town.dark.incidents.find((i) => i.type === 'waiting_mother').outcome, 'resolved');
  assert.ok(town.spec.lore.canon.some((c) => c.text.includes('等门的人')));
});

test('负担值：祟蚀满了人会死，身上寄宿的祟在原地脱出，成为新的事件', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const gu = byName(town, '顾南星');
  put(town, gu, 'plaza');
  const n = town.dark.incidents.length;
  gu.burdens.erosion = 98;
  town.addBurden(gu, 'erosion', 5);
  assert.ok(!town.agents.includes(gu), '死了');
  const sc = inst(town, 'shadow_child');
  assert.ok(sc, '影子里的孩子脱了出来');
  assert.ok(Math.hypot(sc.x - gu.x, sc.y - gu.y) < 2, '在他死去的地方');
  assert.equal(town.dark.incidents.length, n + 1);
});

test('负担值：锚越多涨得越慢，没有锚涨得最快；寄宿两只互相克制的祟会更慢', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const shen = byName(town, '沈砚');
  const rate = () => { const v = shen.burdens.erosion; town.burdenTick(); const d = shen.burdens.erosion - v; return d; };
  const one = rate(); // 只有妹妹一个锚：倍率 1
  shen.relations.tang.affinity = 80;
  const two = rate(); // 两个锚：减半
  for (const r of Object.values(shen.relations)) r.affinity = 0;
  const none = rate(); // 没有锚：1.8 倍
  assert.ok(Math.abs(two - one / 2) < 1e-9 && Math.abs(none - one * 1.8) < 1e-9, `${one} / ${two} / ${none}`);
  town.hostThreat(shen, 'shadow_child');
  const both = rate(); // 1.0 + 1.2 - 0.4 - 0.4 = 1.4 倍，再乘没有锚的 1.8
  assert.ok(Math.abs(both - one * 1.4 * 1.8) < 1e-9, `${both}`);
});

test('宿主：被标记的人濒死之际反过来成了祟的宿主（hostable.via），得到它的能力', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const zhi = byName(town, '沈知');
  put(town, zhi, 'plaza');
  const bt = town.threats.spawn('back_turned', { loc: 'plaza' });
  Object.assign(bt, { x: zhi.x + 3, y: zhi.y });
  town.threats.random = () => 0;
  town.threats.minuteTick();
  assert.equal(zhi.marks.length, 1, '夜里看见了它');
  zhi.marks[0].due = town.t;
  town.threats.minuteTick();
  assert.ok(town.agents.includes(zhi));
  assert.deepEqual(zhi.hosted.map((h) => h.threat), ['back_turned']);
  assert.ok(zhi.abilities.includes('look_back'));
  assert.equal(zhi.burdens.erosion, 0);
  assert.equal(bt.state, 'gone');
});

test('声音与禁忌：铃声响着的时候说话会被盯上，保持不出声的人不会', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const [tang, lin] = ['唐棠', '林小满'].map((n) => byName(town, n));
  put(town, tang, 'hospital');
  put(town, lin, 'hospital', 1);
  const pr = inst(town, 'phone_ring');
  Object.assign(pr, { x: tang.x + 1, y: tang.y, path: [] });
  tang.spokeAt = town.t;
  lin.spokeAt = town.t;
  assert.equal(town.runDarkAct(lin, { type: 'taboo', hold: ['silent'] }).ok, true);
  town.threats.minuteTick();
  assert.equal(tang.marks?.length ?? 0, 1, '听见铃声时开口说话');
  assert.equal(lin.marks?.length ?? 0, 0, '不出声的人没事');
});

test('线索：报丧簿写出下一个会出事的人（用了会染上祟蚀）', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const [xiao, tang] = ['萧九', '唐棠'].map((n) => byName(town, n));
  (tang.marks ||= []).push({ threat: inst(town, 'phone_ring').id, type: 'phone_ring', t: town.t, due: town.t + 60, sign: '' });
  const e = xiao.burdens.erosion;
  assert.ok(town.useItem(xiao, { item: 'death_ledger' }).ok);
  assert.equal(xiao.beliefs.find((b) => b.about === '下一个').claim, '唐棠会出事');
  assert.equal(xiao.burdens.erosion, e + 6);
  assert.equal(xiao.inventory.death_ledger, 1, '报丧簿不会用完');
});

test('战斗：没有仇的人下不了手；反派会动手，致死分级下打倒后可能丧命', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const [zhi, tang, xiao, shen] = ['沈知', '唐棠', '萧九', '沈砚'].map((n) => byName(town, n));
  put(town, zhi, 'plaza'); put(town, tang, 'plaza', 1);
  assert.match(town.attack(zhi, { target: '唐棠' }).reason, /下不了手/);
  put(town, xiao, 'park'); put(town, shen, 'park', 1);
  shen.body.hp = 3;
  shen.body.courage = 80;
  assert.ok(town.attack(xiao, { target: '沈砚', intent: 'kill' }).ok);
  assert.equal(shen.relations.xiao.affinity, -40, '被攻击的人好感骤降');
  town.t += 1;
  town.combatTick();
  assert.ok(!town.agents.includes(shen), '被打倒后死去');
  assert.ok(town.dark.deaths.some((d) => d.id === 'shen' && d.cause === 'attack:xiao'));
  assert.ok(inst(town, 'back_turned'), '他身上的祟脱了出来');
});

test('会死的威胁：纸扎人可以被火消灭，掉落材料', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  const shen = byName(town, '沈砚');
  shen.inventory.lighter = 1;
  put(town, shen, 'earth_shrine');
  const pm = town.threats.spawn('paper_man', { loc: 'earth_shrine' });
  Object.assign(pm, { x: shen.x + 1, y: shen.y, path: [] });
  town.threats.random = () => 0;
  for (let i = 0; i < 6 && pm.state !== 'gone'; i++) town.hunt(shen, { threat: '纸扎人' });
  assert.equal(pm.state, 'gone');
  assert.ok(shen.inventory.cinnabar_lead >= 1, '掉落了朱砂铅');
  assert.equal(town.dark.incidents.find((i) => i.threat === pm.id).outcome, 'slain');
});

test('剧情动作：导演只能安排局面（开启事件、线索、派遣、放弃），没有「杀死某人」的动作', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  assert.ok(!ALL_KINDS.includes('kill'));
  assert.equal(checkBeat(town, { kind: 'kill', who: '沈知' }), '未知动作：kill');
  const r = runBeats(town, [
    { kind: 'incident', threat: 'last_train' },
    { kind: 'clue', who: ['何敏'], clueKind: 'rule', threat: 'phone_ring' },
    { kind: 'dispatch', who: ['沈砚'], incident: 'fire_lane' },
    { kind: 'surge', who: ['顾南星'], burden: 'erosion', amount: 5 },
    { kind: 'omenAt', at: 'metro', text: '站台的广播念了一个不存在的站名' },
  ], { ctx: { source: 'director' } });
  assert.equal(r.done, 5, JSON.stringify(r.skipped));
  assert.ok(inst(town, 'last_train'));
  assert.ok(byName(town, '何敏').beliefs.some((b) => b.about === '半夜的铃声'));
  assert.deepEqual(town.dark.incidents.find((i) => i.loc === 'fire_lane').assigned, ['shen']);
  assert.ok(runBeats(town, [{ kind: 'abandon', incident: 'fire_lane' }]).done === 1);
  assert.equal(town.dark.incidents.find((i) => i.loc === 'fire_lane').stage, 'abandoned');
  assert.match(checkBeat(town, { kind: 'surge', who: ['沈知'], burden: 'erosion', amount: 5 }), /没有这种负担值/);
});

test('存读档：威胁、事件、标记、负担值、死者与墓碑都保存下来', (t) => {
  const dir = tmp();
  const town = nwTown({ dir });
  at(town, 21);
  const [zhi, qian] = ['沈知', '钱伯'].map((n) => byName(town, n));
  town.killAgent(qian, { text: '钱伯死在了茶馆里' });
  (zhi.marks ||= []).push({ threat: inst(town, 'phone_ring').id, type: 'phone_ring', t: town.t, due: town.t + 99, sign: '铃声' });
  zhi.posture = { holds: ['silent'], until: town.t + 60 };
  town.save();
  town.stop();
  const again = nwTown({ dir });
  t.after(() => again.stop());
  assert.equal(again.dark.threats.length, 2);
  assert.equal(again.dark.graves[0].name, '钱伯');
  assert.ok(!again.agents.some((a) => a.id === 'qian'), '死者读档后仍然不在场');
  assert.equal(again.byId.zhi.marks.length, 1);
  assert.ok(again.hasPosture(again.byId.zhi, 'silent'));
  assert.equal(again.byId.shen.burdens.erosion, town.byId.shen.burdens.erosion);
  assert.equal(again.dark.seeded, true, '读档不会重复生成开局事件');
});

test('视图：快照里有威胁与区域，面板里有事件、群众伤亡与死者；规律不会下发给前端', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  at(town, 21);
  town.threats.minuteTick();
  const snap = town.snapshot();
  assert.ok(snap.dark.threats.length >= 1 && snap.dark.zones.length === 1);
  const dead = () => town.storyView().dark.population.find((p) => p.id === 'metro').dead;
  const before = dead(), total = town.storyView().dark.crowdDead;
  town.casualties('metro', 3, { text: '又有人没回来' });
  assert.equal(dead(), before + 3);
  assert.equal(town.storyView().dark.crowdDead, total + 3);
  const pub = JSON.stringify(town.initPayload());
  assert.ok(!pub.includes("named(e)") && !pub.includes('mother_child_found'), '规律与化解条件不出现在前端数据里');
  const d = town.agentDetail('shen');
  assert.equal(d.burdens[0].name, '祟蚀');
  assert.equal(d.hosted[0].name, '背对你的人');
});

test('规划提示：负祟人知道自己的祟蚀与寄宿，反派知道自己的立场；有威胁的世界可以安排禁忌与收容', (t) => {
  const town = nwTown();
  t.after(() => town.stop());
  const [shen, xiao, lu] = ['沈砚', '萧九', '陆承'].map((n) => byName(town, n));
  assert.match(town.personaBlock(shen), /祟蚀：42\/100/);
  assert.match(town.personaBlock(shen), /寄宿着：背对你的人/);
  assert.match(town.personaBlock(xiao), /不会因为一次友善的对话/);
  const block = town.actionBlock(lu);
  assert.match(block, /"type":"taboo"/);
  assert.match(block, /"type":"contain"/);
  assert.match(block, /"type":"attack"/);
  assert.equal(town.normalizeAct({ type: 'taboo', hold: ['silent', 'fly'] }).hold.join(), 'silent');
  assert.equal(town.normalizeAct({ type: 'attack', target: '萧九', intent: 'kill' }).intent, 'kill');
});

test('现有世界不受影响：云溪镇没有威胁，快照里没有黑暗叙事的数据，新的剧情动作不可用', (t) => {
  const town = new Town({ dataDir: tmp(), instantTalk: true, mods: [] });
  t.after(() => town.stop());
  assert.equal(town.threats.enabled, false);
  assert.equal(town.snapshot().dark, undefined);
  assert.equal(town.storyView().dark, null);
  assert.equal(checkBeat(town, { kind: 'incident', threat: 'x' }), '这个世界没有威胁');
  assert.equal(town.normalizeAct({ type: 'taboo', hold: ['silent'] }), undefined);
  assert.equal(town.normalizeAct({ type: 'attack', target: '小乐' }), undefined, 'cozy 世界里没有敌对行动');
  assert.equal(town.darkPersonaBlock(town.agents[0]), '');
});

// ---------- 通用性：同一套能力拼出别的世界（不是《夜巡》专用） ----------
function darkRed() {
  const pk = structuredClone(loadPack(path.resolve('worlds/little-red')));
  const w = pk.world;
  w.meta.rating = 'dark';
  w.items.sword = { name: '猎刀', emoji: '🔪', equip: 'weapon', mods: { atk: 12 }, tags: ['iron'] };
  w.items.wolf_fang = { name: '狼牙', emoji: '🦷' };
  w.threats = {
    ghoul: {
      name: '腐狼', emoji: '🐺', mortal: true, hp: 20, atk: 4, speed: 1.5, weakness: ['iron'], haunt: ['forest_path'],
      rule: { trigger: 'near(e, 1.5)', mark: { delay: [0, 1] }, outcome: [{ op: 'wound', amount: 10, target: 'self' }] },
      counters: [{ type: 'slay' }], loot: [{ item: 'wolf_fang', p: 1 }], clues: ['靠近它就会被咬'],
    },
  };
  w.burdens = { corruption: { name: '腐化', max: 100, drift: 0, onFull: [{ op: 'spawnThreat', threat: 'ghoul', target: 'self' }, { op: 'kill', target: 'self', text: '{self}变成了一头腐狼' }] } };
  const wolf = w.personas.find((p) => p.id === 'wolf');
  Object.assign(wolf, { alignment: 'villain', drives: [{ text: '饿，想吃掉篮子里的东西', perDay: 50 }] });
  return pk;
}

test('通用：腐化满了变成怪物（负担值 + spawnThreat），会死的怪物被带铁的刀砍倒', (t) => {
  const pk = darkRed();
  assert.deepEqual(validateSpec(packSpec(pk)), []);
  const town = new Town({ dataDir: tmp(), worldId: 'dark-red', pack: pk, instantTalk: true, mods: [] });
  t.after(() => town.stop());
  const [hunter, mom] = ['hunter', 'mom'].map((id) => town.byId[id]);
  put(town, mom, 'forest_path');
  town.addBurden(mom, 'corruption', 100);
  assert.ok(!town.agents.includes(mom));
  const g = inst(town, 'ghoul');
  assert.ok(g, '妈妈变成了腐狼');
  hunter.inventory.sword = 1;
  put(town, hunter, 'forest_path', 1);
  Object.assign(g, { x: hunter.x + 1, y: hunter.y, path: [] });
  town.threats.random = () => 0;
  for (let i = 0; i < 3 && g.state !== 'gone'; i++) town.hunt(hunter, { threat: '腐狼' });
  assert.equal(g.state, 'gone');
  assert.equal(hunter.inventory.wolf_fang, 1);
});

test('通用：反派的欲望压力累积到头会逼他行动；打倒对方可以抓走，别人能把人救出来', async (t) => {
  const pk = darkRed();
  const town = new Town({ dataDir: tmp(), worldId: 'dark-red', pack: pk, instantTalk: true, mods: [] });
  t.after(() => town.stop());
  const [wolf, red, hunter] = ['wolf', 'red', 'hunter'].map((id) => town.byId[id]);
  const news = [];
  town.replan = async (a, text) => { news.push([a.id, text]); };
  wolf.pressure = { '饿，想吃掉篮子里的东西': 99 };
  town.villainTick();
  assert.deepEqual(news[0], ['wolf', '心里的欲望压不住了：饿，想吃掉篮子里的东西。今天一定要有所行动']);
  put(town, wolf, 'flower_meadow'); put(town, red, 'flower_meadow', 1);
  red.body.hp = 3;
  red.body.courage = 80;
  assert.ok(town.attack(wolf, { target: '小红帽', intent: 'capture' }).ok);
  town.t += 1;
  town.combatTick();
  assert.equal(red.captive?.by, 'wolf', '小红帽被抓走了');
  put(town, hunter, wolf.home);
  hunter.locId = red.captive.at;
  put(town, wolf, 'flower_meadow');
  assert.ok(town.rescue(hunter, { target: '小红帽' }).ok);
  assert.equal(red.captive, null);
  assert.ok(red.relations.hunter.affinity >= 50);
});

