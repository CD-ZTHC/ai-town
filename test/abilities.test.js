// P1：效果原语、能力、行动、规则引擎，以及用模拟模型验证「居民通过 LLM 自主使用能力」
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING']) delete process.env[k];
const { Town } = await import('../server/sim.js');
const llm = await import('../server/llm.js');
const { defaultSpec, validateSpec } = await import('../server/kernel/spec.js');
const { applyOp } = await import('../server/kernel/ops.js');
const { useAbility } = await import('../server/kernel/abilities.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-p1-'));
const tick = () => new Promise((r) => setImmediate(r));
async function run(town, minutes, speed = 20) {
  town.speed = speed;
  const end = town.t + minutes;
  while (town.t < end) { town.advance(0.25); await tick(); }
}
/** 把两位居民放到同一片户外空地上，处于「活动中」 */
function placeTogether(town, ids, x = 22, y = 20) {
  ids.forEach((id, i) => Object.assign(town.byId[id], { x: x + i, y, inside: null, locId: 'square', status: 'acting', path: [], convoId: null }));
}
function newTown() {
  llm.setMock(null);
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  town.t = 1440 * 0 + 20 * 60; // 第 1 天 20:00
  return town;
}

test('默认能力与规则都通过校验，居民带着初始物品和能力', () => {
  assert.deepEqual(validateSpec(defaultSpec({})), []);
  const town = newTown();
  assert.deepEqual(town.byId.sun.abilities, ['old_tale', 'firefly_ward']);
  assert.equal(town.byId.sun.inventory.lantern, 3);
  assert.equal(town.byId.zhao.inventory.wood, 8);
  town.stop();
});

test('萤火结界：消耗体力和灯、生成构筑物、周围的人更有勇气、进入冷却', () => {
  const town = newTown();
  placeTogether(town, ['sun', 'wang']);
  const sun = town.byId.sun, wang = town.byId.wang;
  const before = { stamina: sun.body.stamina, courage: wang.body.courage };
  const vfx = [];
  town.on('vfx', (v) => vfx.push(v));
  const r = useAbility(town, sun, 'firefly_ward');
  assert.equal(r.ok, true, r.reason);
  assert.equal(sun.inventory.lantern, 2);
  assert.equal(sun.body.stamina, before.stamina - 15);
  assert.equal(wang.body.courage, before.courage + 6);
  assert.equal(town.entities.length, 1);
  assert.equal(town.entities[0].type, 'light_ward');
  assert.equal(vfx[0].preset, 'glow_ring');
  assert.ok(wang.memories.some((m) => m.text.includes('孙秀兰点起了一圈萤火灯')));
  assert.equal(town.logs.at(-1).type, 'ability');
  assert.match(useAbility(town, sun, 'firefly_ward').reason, /冷却/);
  town.stop();
});

test('能力的前置条件：室内不能用萤火结界，不会的能力不能用，对象要在身边', () => {
  const town = newTown();
  const sun = town.byId.sun;
  Object.assign(sun, { inside: 'home_sun', status: 'acting' });
  assert.match(useAbility(town, sun, 'firefly_ward').reason, /不适合/);
  assert.match(useAbility(town, sun, 'checkup').reason, /还不会/);
  placeTogether(town, ['zhou'], 40, 40);
  placeTogether(town, ['zhao'], 10, 10);
  const r = useAbility(town, town.byId.zhou, 'checkup', '赵铁柱');
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  town.stop();
});

test('问诊：对身边的人使用，消除疲惫', () => {
  const town = newTown();
  placeTogether(town, ['zhou', 'zhao']);
  town.byId.zhao.body.conditions = ['疲惫'];
  town.byId.zhao.body.stamina = 10;
  const r = useAbility(town, town.byId.zhou, 'checkup', '赵铁柱');
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(town.byId.zhao.body.conditions, []);
  assert.equal(town.byId.zhao.body.stamina, 20);
  town.stop();
});

test('日程行动：送东西、传授能力（对象晚到时会重试）、研究学会能力', async () => {
  const town = newTown();
  const chen = town.byId.chen, lin = town.byId.lin, sun = town.byId.sun, su = town.byId.su;
  placeTogether(town, ['chen', 'lin']);
  assert.equal(town.giveItem(chen, { item: 'melon', to: '林晓雨', count: 1 }).ok, true);
  assert.equal(chen.inventory.melon, 1);
  assert.equal(lin.inventory.melon, 1);

  // 传授：对象不在身边 → 可重试；到场后成功
  placeTogether(town, ['sun'], 5, 5);
  placeTogether(town, ['wang'], 30, 30);
  assert.equal(town.teach(sun, { ability: 'firefly_ward', to: '王小乐' }).retry, true);
  placeTogether(town, ['sun', 'wang']);
  assert.equal(town.teach(sun, { ability: 'firefly_ward', to: '王小乐' }).ok, true);
  assert.ok(town.byId.wang.abilities.includes('firefly_ward'));
  assert.match(town.teach(sun, { ability: 'old_tale', to: '王小乐' }).reason, /没法教/);

  // 研究：苏墨在图书馆研究「镜湖传说」一小时以上 → 学会萤火结界
  const e = { key: 'k-research', act: { type: 'research', topic: '镜湖传说里的灯' }, activity: '查资料' };
  Object.assign(su, { locId: 'library', inside: 'library', status: 'acting' });
  town.runAct(su, e);
  assert.equal(su.researching.topic, '镜湖传说里的灯');
  town.t += 60;
  town.finishResearch(su);
  assert.ok(su.abilities.includes('firefly_ward'));
  assert.ok(town.logs.some((l) => l.type === 'learn' && l.text.includes('苏墨通过研究学会了')));
  town.stop();
});

test('行动规范化：非法的行动被丢弃，合法的保留', () => {
  const town = newTown();
  assert.deepEqual(town.normalizeAct({ type: 'use', ability: 'firefly_ward', target: 'null' }), { type: 'use', ability: 'firefly_ward' });
  assert.equal(town.normalizeAct({ type: 'use', ability: 'fireball' }), undefined);
  assert.equal(town.normalizeAct({ type: 'give', item: 'gold', to: '林晓雨' }), undefined);
  assert.deepEqual(town.normalizeAct({ type: 'give', item: 'melon', to: '林晓雨', count: 99 }), { type: 'give', item: 'melon', to: '林晓雨', count: 5 });
  assert.equal(town.normalizeAct({ type: 'rm -rf' }), undefined);
  assert.equal(town.normalizeAct('use'), undefined);
  town.stop();
});

test('规则引擎：萤火结界附近的人定时恢复，淋雨会累；天气触发与地点触发', () => {
  const town = newTown();
  placeTogether(town, ['sun', 'wang']);
  useAbility(town, town.byId.sun, 'firefly_ward');
  const c0 = town.byId.wang.body.courage;
  assert.equal(town.rules.fire(town.spec.rules.find((r) => r.id === 'ward_comfort')) >= 2, true);
  assert.equal(town.byId.wang.body.courage, c0 + 2);

  town.weather = 'rain';
  const s0 = town.byId.wang.body.stamina;
  town.rules.fire(town.spec.rules.find((r) => r.id === 'rain_tired'));
  assert.equal(town.byId.wang.body.stamina, Math.round(s0 - 3));

  town.applyWorldOp({ op: 'addRule', args: {
    id: 'storm_scare', name: '雷声吓人', when: { weather: 'storm' }, forEach: 'agent',
    if: '!e.inside', then: [{ op: 'condition', add: '受惊', target: 'e' }],
  } }, { by: 'test' });
  town.setWeather('storm');
  assert.ok(town.byId.wang.body.conditions.includes('受惊'));

  town.applyWorldOp({ op: 'addRule', args: {
    id: 'pier_calm', name: '湖风安神', when: { enter: 'pier' }, then: [{ op: 'stat', stat: 'courage', add: 5, target: 'self' }],
  } }, { by: 'test' });
  const c1 = town.byId.chen.body.courage;
  town.rules.onEnter(town.byId.chen, 'pier');
  assert.equal(town.byId.chen.body.courage, c1 + 5);
  town.stop();
});

test('WorldOp：AI 可以新增能力和规则，但越界的定义会被拒绝', () => {
  const s = defaultSpec({});
  const good = {
    id: 'star_gaze', name: '观星', emoji: '🔭', target: 'area', desc: '带大家看星星', aiHint: '晴朗的夜里',
    cost: { stamina: 5 }, cooldown: 120, requires: "hour >= 20 && weather == 'sunny'",
    effects: [{ op: 'stat', stat: 'courage', add: 4, target: 'nearby', radius: 4 }],
    learn: { teach: true, research: { location: 'library', keywords: ['星', '天文'] } },
  };
  assert.equal(applyOp(s, { op: 'addAbility', args: good }).abilities.at(-1).id, 'star_gaze');
  const bad = (patch, re) => assert.throws(() => applyOp(s, { op: 'addAbility', args: { ...good, ...patch } }), re);
  bad({ effects: [{ op: 'stat', stat: 'hp', add: -999, target: 'all' }] }, /add 应在/);
  bad({ effects: [{ op: 'exec', cmd: 'rm -rf /' }] }, /未知效果/);
  bad({ requires: 'self.constructor' }, /表达式错误/);
  bad({ cost: { items: { gold: 1 } } }, /未知物品/);
  bad({ effects: Array(9).fill({ op: 'log', text: 'x' }) }, /最多/);
  assert.throws(() => applyOp(s, { op: 'addRule', args: { id: 'r1', name: 'x', when: { every: 1 }, then: [{ op: 'log', text: 'x' }] } }), /every/);
  assert.throws(() => applyOp(s, { op: 'addRule', args: { id: 'r2', name: 'x', when: { every: 30, at: '10:00' }, then: [{ op: 'log', text: 'x' }] } }), /只能包含/);
});

test('临时参数调整：生效期间夹在上下限内，到期自动恢复', () => {
  const town = newTown();
  town.addParamMod({ name: 'walkSpeed', mul: 2, until: town.t + 30 });
  assert.equal(town.params.walkSpeed, 5, '3.2×2 超过上限 5');
  town.t += 31;
  town.expire();
  assert.equal(town.params.walkSpeed, 3.2);
  town.stop();
});

test('体力：活动消耗、睡觉恢复、过低时疲惫', () => {
  const town = newTown();
  const a = town.byId.lin;
  a.status = 'acting';
  a.body.stamina = 21;
  town.updateBody(a, 60);
  assert.ok(a.body.stamina < 20);
  assert.ok(a.body.conditions.includes('疲惫'));
  a.status = 'sleeping';
  town.updateBody(a, 300);
  assert.ok(a.body.stamina > 40);
  assert.ok(!a.body.conditions.includes('疲惫'));
  town.stop();
});

test('端到端：模拟模型让孙婆婆在内心独白里自主使用萤火结界', async () => {
  const town = newTown();
  placeTogether(town, ['sun', 'wang']);
  const prompts = [];
  llm.setMock((messages, opts) => {
    prompts.push({ label: opts.label, text: messages.at(-1).content });
    if (opts.label === '内心独白') {
      return JSON.stringify({ thought: '天黑了，小乐有点怕，点盏灯吧', action: '点灯', emoji: '🏮', mood: '安心', moodEmoji: '😊', use: { ability: 'firefly_ward', target: null } });
    }
    return '{}';
  });
  await town.innerThought(town.byId.sun);
  llm.setMock(null);
  const p = prompts.find((x) => x.label === '内心独白');
  assert.match(p.text, /firefly_ward「🏮萤火结界」/, '提示词里要列出能力');
  assert.match(p.text, /"use"/, '提示词里要说明 use 字段');
  assert.equal(town.entities.length, 1);
  assert.ok(town.logs.some((l) => l.type === 'ability' && l.text.includes('孙秀兰使用了🏮「萤火结界」')));
  town.stop();
});

test('端到端：模拟模型在日程里安排研究，苏墨去图书馆学会萤火结界', async () => {
  const town = new Town({ dataDir: tmp(), instantTalk: true });
  llm.setMock((messages, opts) => {
    if (opts.label === '规划一天' && messages.at(-1).content.includes('姓名：苏墨')) {
      return JSON.stringify({ mood: '专注', moodEmoji: '📚', goal: '弄清镜湖传说', schedule: [
        { start: '06:30', end: '07:30', location: 'home', activity: '吃早饭', emoji: '🍳' },
        { start: '07:30', end: '10:00', location: 'library', activity: '查县志', emoji: '📜', act: { type: 'research', topic: '镜湖传说与萤火灯' } },
        { start: '10:00', end: '22:30', location: 'library', activity: '写小说', emoji: '✍️' },
      ] });
    }
    if (opts.label === '规划一天') throw new Error('其他人用兜底日程');
    throw new Error('无');
  });
  await run(town, 11 * 60 - (6 * 60 + 15));
  llm.setMock(null);
  assert.ok(town.byId.su.abilities.includes('firefly_ward'), `苏墨的能力：${town.byId.su.abilities}`);
  town.stop();
});

test('存档往返：物品、能力、冷却、构筑物、规则状态都能恢复；P0 存档补发初始物品', async () => {
  const dir = tmp();
  const a = new Town({ dataDir: dir });
  a.t = 20 * 60;
  placeTogether(a, ['sun', 'wang']);
  useAbility(a, a.byId.sun, 'firefly_ward');
  a.save();
  a.stop();
  const b = new Town({ dataDir: dir });
  assert.equal(b.entities.length, 1);
  assert.equal(b.byId.sun.inventory.lantern, 2);
  assert.ok(b.byId.sun.cooldowns.firefly_ward > b.t);
  b.stop();

  // 模拟 P0 存档：没有 kit 标记，物品和能力为空
  const file = path.join(dir, 'save.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const ag of d.agents) { delete ag.kit; ag.inventory = {}; ag.abilities = []; delete ag.cooldowns; }
  fs.writeFileSync(file, JSON.stringify(d));
  const c = new Town({ dataDir: dir });
  assert.equal(c.byId.zhao.inventory.wood, 8);
  assert.deepEqual(c.byId.he.abilities, ['moon_song']);
  c.stop();
});
