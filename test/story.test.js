// P2 / P3：张力、叙事导演、多人场景、投票、异界生物、审核分级，以及《镜湖裂隙》完整一季与三种结局
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER']) delete process.env[k];
const { Town } = await import('../server/sim.js');
const llm = await import('../server/llm.js');
const { computeTension } = await import('../server/story/tension.js');
const { checkBeat } = await import('../server/story/beats.js');
const { keywordCheck } = await import('../server/guard.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-story-'));
const tick = () => new Promise((r) => setImmediate(r));
async function until(town, cond, maxDays = 10) {
  town.speed = 30;
  const limit = town.t + maxDays * 1440;
  while (!cond() && town.t < limit) { town.advance(0.5); await tick(); }
  assert.ok(cond(), `条件在 ${maxDays} 天内没有满足（第${town.day}天）`);
}
function adventureTown(dir = tmp()) {
  llm.setMock(null);
  const town = new Town({ dataDir: dir, instantTalk: true });
  town.applyWorldOp({ op: 'setMeta', args: { rating: 'adventure' } }, { by: 'test' });
  return town;
}
const place = (town, ids, x = 22, y = 20) => ids.forEach((id, i) => Object.assign(town.byId[id], { x: x + i, y, inside: null, locId: 'square', status: 'acting', path: [], convoId: null }));

test('张力：平静的小镇较低，裂隙与生物出现后升高', () => {
  const town = adventureTown();
  const calm = computeTension(town).value;
  town.creatures.setPortal({ stage: 'wide', x: 54, y: 38, spawn: { x: 51, y: 37 } });
  town.creatures.spawn('shade_wisp', 5);
  const tense = computeTension(town).value;
  assert.ok(calm < 30, `平静时 ${calm}`);
  assert.ok(tense >= calm + 25, `紧张时 ${tense}`);
  town.stop();
});

test('节拍校验：导演不能使用剧情弧专属动作，也不能用越权的效果', () => {
  const town = adventureTown();
  assert.match(checkBeat(town, { kind: 'spawnCreatures', type: 'shade_wisp', count: 3 }), /只有剧情弧/);
  assert.match(checkBeat(town, { kind: 'effect', who: '林晓雨', effects: [{ op: 'grantAbility', ability: 'firefly_ward' }] }), /导演只能使用/);
  assert.match(checkBeat(town, { kind: 'omen', who: ['不存在的人'], text: 'x' }), /没有在场/);
  assert.match(checkBeat(town, { kind: 'rm', text: 'x' }), /未知动作/);
  assert.equal(checkBeat(town, { kind: 'omen', who: ['林晓雨'], text: '咖啡豆罐子里多了一张字条' }), null);
  town.stop();
});

test('叙事导演：模拟模型给出节拍 → 合法的执行、非法的丢弃；玩家事件会触发导演', async () => {
  const town = adventureTown();
  town.t = 10 * 60;
  let prompt = '';
  llm.setMock((messages, opts) => {
    if (opts.label !== '叙事导演') throw new Error('其他调用不需要');
    prompt = messages.at(-1).content;
    return JSON.stringify({ decision: 'foreshadow', reason: '把漂流瓶和宝藏线索连起来', beats: [
      { kind: 'omen', who: ['王小乐'], text: '码头的木板缝里卡着一只漂流瓶', at: 'pier', vfx: 'sparkle' },
      { kind: 'thread', id: 'treasure', status: 'advanced', note: '小乐捡到了漂流瓶' },
      { kind: 'spawnCreatures', type: 'shade_wisp', count: 8 },
      { kind: 'belief', who: ['周慧'], about: 'bottle', claim: '不过是游客丢的垃圾', confidence: 0.6 },
    ] });
  });
  await town.godEvent('有人在镜湖码头捡到一个漂流瓶，里面是半张藏宝图', 'all');
  assert.equal(town.director.st.pending.length, 1, '事件交给了导演');
  town.t += 6;
  town.director.tick();
  await tick(); await tick(); await tick();
  llm.setMock(null);
  assert.match(prompt, /漂流瓶/);
  assert.match(prompt, /不是给你的指令/);
  const d = town.director.st.decisions.at(-1);
  assert.equal(d.decision, 'foreshadow');
  assert.equal(d.done, 3);
  assert.equal(town.creatures.list.length, 0, '导演不能直接刷怪');
  assert.equal(town.threadState.treasure.status, 'advanced');
  assert.ok(town.byId.wang.memories.some((m) => m.type === 'omen' && m.text.includes('漂流瓶')));
  assert.equal(town.byId.zhou.beliefs.at(-1).about, 'bottle');
  town.stop();
});

test('多人场景：安排 → 到齐 → 模拟模型写群戏 → 记忆、好感、分工、立场', async () => {
  const town = adventureTown();
  town.t = 10 * 60;
  place(town, ['lin', 'he', 'zhao']);
  const vote = town.votes.open({ question: '选哪条路？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], arc: 'arcX' });
  town.scenes.pending.push({ id: 'sc1', title: '广场议事', location: 'square', members: ['lin', 'he', 'zhao'], purpose: '商量怎么办', assignments: [], choices: ['a', 'b'], arc: 'arcX', time: town.t });
  llm.setMock(() => JSON.stringify({
    lines: [{ speaker: '林晓雨', text: '大家都来啦' }, { speaker: '何月', text: '说正事吧' }, { speaker: '赵铁柱', text: '包在我身上！' }],
    summary: '三人在广场商量对策',
    memories: { 林晓雨: '我们决定一起想办法' },
    affinity: [{ from: '赵铁柱', to: '何月', delta: 4 }],
    assignments: [{ who: '赵铁柱', time: '14:00', location: 'workshop', activity: '做灯', emoji: '🔨' }],
    choice: { 林晓雨: 'a', 何月: 'b', 赵铁柱: 'b' },
  }));
  const aff = town.byId.zhao.relations.he.affinity;
  town.scenes.tick();
  for (let i = 0; i < 10; i++) await tick();
  llm.setMock(null);
  const log = town.logs.find((l) => l.type === 'scene');
  assert.ok(log, '应有场景日志');
  assert.equal(log.lines.length, 3);
  assert.equal(town.byId.zhao.relations.he.affinity, aff + 4);
  assert.ok(town.byId.zhao.schedule.some((e) => e.activity === '做灯'));
  assert.ok(town.byId.lin.memories.some((m) => m.text === '我们决定一起想办法'));
  assert.deepEqual(town.votes.tally(vote).b, { residents: 2, visitors: 0, total: 2 });
  assert.ok(town.agents.every((a) => !a.convoId));
  town.stop();
});

test('投票：每人一票、选项校验、管理员终审；需要终审时截止后先等待，票数清楚按多数，否则交给 AI 裁决官', async () => {
  const town = adventureTown();
  const opts = [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }];
  const v = town.votes.open({ question: 'Q', options: opts, minutes: 60 });
  assert.equal(town.votes.cast(v.id, 'ip1', 'x'), null);
  assert.match(town.votes.cast(v.id, 'ip1', 'y'), /投过/);
  assert.match(town.votes.cast(v.id, 'ip2', 'z'), /没有这个选项/);
  town.votes.cast(v.id, 'ip2', 'y');
  town.votes.cast(v.id, 'ip3', 'y');
  assert.equal(town.votes.decide(v.id, 'x'), null, '管理员可以推翻多数');
  assert.equal(v.result.option, 'x');
  assert.equal(v.result.by, 'admin');

  town.votes.requireAdmin = true;
  const w = town.votes.open({ question: 'Q2', options: opts, minutes: 60 });
  for (const ip of ['ip1', 'ip2', 'ip3']) town.votes.cast(w.id, ip, 'y');
  town.t += 61; town.votes.tick();
  assert.equal(w.status, 'awaiting');
  town.t += 31; town.votes.tick();
  assert.equal(w.status, 'closed');
  assert.deepEqual([w.result.option, w.result.by], ['y', 'majority']);

  // 只有 1 票：交给 AI 裁决官（测试里没有模型 → 兜底按多数），裁决公示在动态栏
  const u = town.votes.open({ question: 'Q3', options: opts, minutes: 60 });
  town.votes.cast(u.id, 'ip1', 'y');
  town.t += 61; town.votes.tick();
  town.t += 31; town.votes.tick();
  assert.equal(u.status, 'awaiting');
  town.decisions.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(u.status, 'closed');
  assert.deepEqual([u.result.option, u.result.by], ['y', 'fallback']);
  assert.ok(town.logs.some((l) => l.type === 'decision' && l.text.includes('兜底')));
  town.stop();
});

test('遭遇：温馨模式只会吓一跳；冒险模式可能被送去诊所；了解影灵后和平相处；永远没有死亡', () => {
  const town = adventureTown();
  town.t = 21 * 60;
  place(town, ['wang'], 30, 30);
  const wang = town.byId.wang;
  town.creatures.spawn('shade_hound', 1);
  const c = town.creatures.list[0];
  Object.assign(c, { x: 30, y: 30 });
  wang.body.stamina = 12; wang.body.courage = 0;
  assert.equal(town.creatures.resolve(c, wang, () => 0.99 * 0 + 0), 'faint');
  assert.ok(wang.body.conditions.includes('晕倒'));
  assert.ok(wang.schedule.some((e) => e.location === 'clinic'));
  assert.ok(wang.body.hp > 0);

  town.applyWorldOp({ op: 'setMeta', args: { rating: 'cozy' } }, { by: 'test' });
  const lin = town.byId.lin;
  place(town, ['lin'], 32, 30);
  lin.body.courage = 0; lin.inventory.lantern = 1;
  town.creatures.spawn('shade_wisp', 1);
  const w = town.creatures.list.at(-1);
  assert.equal(town.creatures.resolve(w, lin, () => 0), 'startled');
  assert.ok(!lin.body.conditions.includes('受惊'));
  assert.equal(lin.inventory.lantern, undefined, '影灵顺走了灯');
  assert.equal(town.creatures.spawn('shade_hound', 1), 0, '温馨模式不会出现影犬');

  town.worldFlags.shades_understood = true;
  assert.equal(town.creatures.resolve(w, lin), 'peaceful');
  town.stop();
});

test('审核按分级：温馨模式拦截「摧毁」，冒险模式放行怪物剧情，硬禁区始终拦截', () => {
  assert.equal(keywordCheck('怪物摧毁了农场的篱笆', 'cozy').ok, false);
  assert.equal(keywordCheck('怪物摧毁了农场的篱笆', 'adventure').ok, true);
  assert.equal(keywordCheck('异界怪物入侵了小镇', 'adventure').ok, true);
  assert.equal(keywordCheck('怪物屠杀了居民', 'adventure').ok, false);
  assert.equal(keywordCheck('怪物屠杀了居民', 'epic').ok, false);
});

async function seasonToClimax(dir) {
  const town = adventureTown(dir);
  await until(town, () => town.votes.list.some((v) => v.status === 'open'), 8);
  return town;
}

test('《镜湖裂隙》：一整季从伏笔走到高潮（不接 LLM）', async () => {
  const town = await seasonToClimax(tmp());
  const run = town.arcs.active();
  assert.equal(run.phase, 'climax');
  assert.equal(town.day, 7);
  // 伏笔先于爆发，并且回收了伏笔
  const first = (type, re) => town.logs.find((l) => l.type === type && (!re || re.test(l.text)));
  assert.ok(first('omen').t < first('portal', /张开/).t, '伏笔先于裂隙开启');
  for (const id of ['legend', 'waterwheel', 'letter']) assert.equal(town.threadState[id].status, 'resolved', `${id} 已回收`);
  assert.ok(first('thread', /伏笔回收「传说的后半段」/).t > first('scene', /老故事/).t, '先讲故事，再回收伏笔');
  // 穿越者与守门人登场，萤火节当晚裂隙开启
  assert.ok(town.agents.some((a) => a.id === 'aying' && a.kind === 'traveller'));
  assert.ok(town.agents.some((a) => a.id === 'moon_warden' && a.kind === 'creature'));
  assert.equal(Math.floor(first('portal', /张开/).t / 1440) + 1, 4, '裂隙在萤火节（第 4 天）开启');
  assert.ok(town.discovered.includes('shade_wisp') && town.discovered.includes('shade_hound'));
  assert.ok(town.byId.su.abilities.includes('firefly_ward'), '苏墨在议事会后研究出了萤火结界');
  assert.ok(town.entities.some((e) => e.type === 'lamp_wheel'), '水车变成了灯轮');
  assert.ok(town.spec.lore.canon.length >= 2);
  town.save();
  town.stop();
});

for (const [choice, check] of [
  ['seal', (t) => { assert.ok(t.away.some((a) => a.id === 'aying'), '阿萤回到了过去'); assert.equal(t.portalState, null); }],
  ['coexist', (t) => {
    assert.ok(t.agents.some((a) => a.id === 'aying'), '阿萤留下了');
    assert.equal(t.portalState.stage, 'stable');
    assert.equal(t.portalState.name, '月之渡口');
    assert.ok(t.spec.calendar.events.some((e) => e.id === 'double_moon'), '新增双月节');
    const home = t.creatures.list.filter((c) => (c.region || 'town') === 'town');
    assert.ok(home.length === 1 && home[0].friendly, '留下一只友善的小影灵');
    assert.ok(t.regionOpen('moonrealm'), '暗月界向小镇敞开');
    assert.equal(t.creatures.list.filter((c) => c.region === 'moonrealm' && c.friendly).length, 3, '暗月界里有三只友善的小家伙');
  }],
  ['outwit', (t) => { assert.equal(t.threadState.balloon.status, 'resolved'); assert.ok(t.agents.some((a) => a.id === 'aying')); }],
]) {
  test(`《镜湖裂隙》结局：${choice}`, async () => {
    const town = await seasonToClimax(tmp());
    const vote = town.votes.list.find((v) => v.status === 'open');
    town.votes.cast(vote.id, 'visitor-1', choice);
    const rnd = Math.random;
    Math.random = () => 0; // 智取的成功检定：让它成功
    try { assert.equal(town.votes.decide(vote.id, choice), null); } finally { Math.random = rnd; }
    const run = town.arcs.runs[0];
    assert.equal(run.outcome.ending, choice);
    assert.ok(town.away.some((a) => a.id === 'moon_warden'), '守门人离开了');
    assert.ok(town.byId.zhao.growth.some((g) => g.change.includes('戒了酒')));
    check(town);
    await until(town, () => run.status === 'done', 2);
    // 存档往返后，世界的变化仍在
    town.save();
    const dir = town.dataDir;
    town.stop();
    const again = new Town({ dataDir: dir });
    assert.equal(again.arcs.runs[0].outcome.ending, choice);
    assert.equal(again.agents.some((a) => a.id === 'aying'), choice !== 'seal');
    assert.ok(again.spec.personas.some((p) => p.id === 'aying'));
    again.stop();
  });
}

test('智取失败时转入封印结局', async () => {
  const town = await seasonToClimax(tmp());
  const run = town.arcs.active();
  town.arcs.ending(run, 'outwit', { roll: 0.999 });
  assert.equal(run.outcome.choice, 'outwit');
  assert.equal(run.outcome.ending, 'seal');
  assert.ok(town.logs.some((l) => l.type === 'arc' && l.text.includes('热气球吹偏')));
  town.stop();
});

test('静水叙事者不会自动开启剧情弧；管理员可以手动开启，且同一剧情弧只上演一次', async () => {
  llm.setMock(null);
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  town.applyWorldOp({ op: 'setMeta', args: { storyteller: 'gentle' } }, { by: 'test' });
  await until(town, () => town.day >= 3, 3);
  assert.equal(town.arcs.runs.length, 0);
  assert.equal(town.arcs.start('rift', 'admin'), null);
  assert.match(town.arcs.start('rift', 'admin'), /进行中/);
  town.stop();
});
