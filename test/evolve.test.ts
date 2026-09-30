// P5：扩展点、能力清单、AI 心愿单、mise run evolve，以及「缺口 → RFC → 扩展实现 → AI 使用」的完整闭环
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';
import type { Gap } from '../plugins/builtin/architect/architect.ts';
import type { Pos } from '../server/kernel/effects.ts';
/** 扩展表达式函数的签名（第一个参数是 { town, real }） */
type ExprFn = (helpers: unknown, ...args: unknown[]) => unknown;

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'STORYTELLER']) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const llm = await import('../server/llm.ts');
const { registerEffect, registerExprFn, extensions } = await import('../plugin-host/registry.ts');
const { EFFECTS, checkEffects } = await import('../server/kernel/effects.ts');
const { manifestText, manifestMarkdown } = await import('../server/worldai/manifest.ts');
const { defaultSpec } = await import('../server/kernel/spec.ts');
const { evolve, nextNumber } = await import('../tools/evolve.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-p5-'));
const tick = () => new Promise((r) => setImmediate(r));
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await tick(); };
async function run(town: TownT, minutes: number, speed = 20) {
  town.speed = speed;
  const end = town.t + minutes;
  while (town.t < end) { town.advance(0.25); await tick(); }
}
function newTown(dir = tmp()) {
  llm.setMock(null);
  const town = new Town({ dataDir: dir, instantTalk: true });
  town.applyWorldOp({ op: 'setMeta', args: { storyteller: 'gentle' } }, { by: 'test' });
  town.t = 17 * 60;
  return town;
}
const place = (town: TownT, ids: string[], x = 22, y = 20) => ids.forEach((id: string, i) => Object.assign(town.byId[id], { x: x + i, y, inside: null, locId: 'square', status: 'acting', path: [], convoId: null }));

test('扩展注册表：只能新增、名字要合法、必须带说明', () => {
  const ok = { doc: 'x', check: () => null, apply: () => {} };
  assert.throws(() => registerEffect('stat', ok), /冲突/);
  assert.throws(() => registerEffect('goTo', ok), /冲突/);
  assert.throws(() => registerEffect('constructor', ok), /不合法/);
  assert.throws(() => registerEffect('Bad-Name', ok), /不合法/);
  assert.throws(() => registerEffect('noDoc', { check: () => null, apply: () => {} } as never), /doc/);
  assert.throws(() => registerEffect('noApply', { doc: 'x', check: () => null } as never), /check \/ apply/);
  assert.throws(() => registerExprFn('has', () => 1, 'x'), /冲突/);
  assert.ok(extensions().some((e) => e.name === 'goTo' && e.source === 'go-to'), 'go-to 已在启动时加载');
});

test('扩展的表达式函数可以在规则里使用', () => {
  registerExprFn('isElder', (({ real }: { real: (e: unknown) => { age?: number } | null }, e: unknown) => (real(e)?.age || 0) >= 60) as ExprFn, 'isElder(e) 是否是老人家', 'test');
  const town = newTown();
  place(town, ['sun', 'wang']);
  town.applyWorldOp({ op: 'addRule', args: { id: 'elder_rest', name: '老人家歇歇', when: { every: 30 }, forEach: 'agent', if: 'isElder(e)', then: [{ op: 'mood', text: '安详', emoji: '🍵', target: 'e' }] } }, { by: 'test' });
  town.rules.fire(town.spec.rules.find((r) => r.id === 'elder_rest')!);
  assert.equal(town.byId.sun.mood.text, '安详');
  assert.notEqual(town.byId.wang.mood.text, '安详');
  town.stop();
});

test('RFC 0001 的实现 goTo：校验参数；让身边的人动身前往；睡着和正在交谈的人不受影响', async () => {
  const spec = defaultSpec({});
  assert.equal(checkEffects([{ op: 'goTo', location: 'pier', minutes: 60, target: 'nearby', radius: 4 }], spec), null);
  assert.match(checkEffects([{ op: 'goTo', location: 'moon' }], spec)!, /未知或不公开/);
  assert.match(checkEffects([{ op: 'goTo', location: 'pier', minutes: 999 }], spec)!, /30~180/);
  assert.match(checkEffects([{ op: 'goTo', location: 'pier', target: 'everyone' }], spec)!, /target/);

  const town = newTown();
  place(town, ['he', 'lin', 'wang', 'zhao']);
  town.byId.wang.convoId = 'c1';
  town.byId.zhao.status = 'sleeping';
  EFFECTS.goTo.apply(town, { self: town.byId.he, at: { x: 22, y: 20, inside: null } as unknown as Pos }, { op: 'goTo', location: 'pier', activity: '一起去放灯', minutes: 90, target: 'nearby', radius: 4, includeSelf: true });
  assert.ok(town.byId.lin.schedule.some((e) => e.location === 'pier' && e.activity === '一起去放灯'));
  assert.ok(!town.byId.wang.schedule.some((e) => e.location === 'pier'), '正在交谈的不受影响');
  assert.ok(!town.byId.zhao.schedule.some((e) => e.location === 'pier'), '睡着的不受影响');
  town.byId.wang.convoId = null;
  await run(town, 60);
  assert.equal(town.byId.lin.locId, 'pier');
  town.stop();
});

test('能力清单自动包含扩展，世界架构师的提示词里能看到它', () => {
  const town = newTown();
  const text = manifestText(town.spec, town.day);
  assert.match(text, /- goTo（扩展）：\{"op":"goTo"/);
  assert.match(text, /isElder|has\(e/);
  assert.match(town.architect!.manifest(), /goTo（扩展）/);
  const md = manifestMarkdown(town.spec);
  assert.match(md, /\| `goTo` \| 扩展 \|/);
  assert.match(md, /\| `addBuilding` \| minor \| ✅ \|/);
  town.stop();
});

test('完整闭环：架构师用新的 goTo 设计出「召集铃」→ 提案落地 → 何月摇铃 → 身边的人一起走到码头', async () => {
  const town = newTown();
  let prompt = '';
  llm.setMock((messages, opts) => {
    if (opts.label === '设定考据') return '{"severity":"none","issues":[]}';
    if (opts.label !== '世界架构师') throw new Error('其他调用不需要');
    prompt = messages.at(-1)!.content;
    return JSON.stringify({ title: '召集铃', motive: '萤火节傍晚把大家召集到码头', construction: null, ops: [
      { op: 'addAbility', args: {
        id: 'gather_bell', name: '召集铃', emoji: '🔔', target: 'area', desc: '摇响铃铛，招呼身边的人一起去码头', aiHint: '节日傍晚或需要大家聚在一起时',
        cost: { stamina: 5 }, cooldown: 180,
        effects: [{ op: 'goTo', location: 'pier', activity: '一起去码头放灯', minutes: 90, target: 'nearby', radius: 4, includeSelf: true }, { op: 'vfx', preset: 'notes', color: '#ffd76a', radius: 3 }],
      } },
      { op: 'addCanon', args: { text: '何月的酒馆里多了一只召集铃，一摇大家就知道要去码头了。' } },
    ] });
  });
  assert.equal(town.architect!.enqueue('萤火节傍晚，把镇上的人都召集到码头一起放灯', 'director'), null);
  town.architect!.tick();
  await flush(20);
  llm.setMock(null);
  assert.match(prompt, /goTo（扩展）/, '架构师看到了新能力');
  const p = town.proposalSystem.list.at(-1);
  assert.equal(p!.status, 'applied', p!.result?.reason!);
  assert.ok(town.spec.abilities.some((a) => a.id === 'gather_bell'));

  const { useAbility } = await import('../server/kernel/abilities.ts');
  town.learnAbility(town.byId.he, 'gather_bell', '在酒馆里');
  place(town, ['he', 'lin', 'su']);
  const r = useAbility(town, town.byId.he, 'gather_bell');
  assert.equal(r.ok, true, r.reason!);
  await run(town, 60);
  for (const id of ['he', 'lin', 'su']) assert.equal(town.byId[id].locId, 'pier', `${id} 到了码头`);
  town.stop();
});

test('AI 心愿单：导演想用不存在的剧情动作会记为缺口；管理员可以采纳 / 忽略；显示已生成的文档', async () => {
  const town = newTown();
  town.t = 10 * 60;
  llm.setMock((messages, opts) => (opts.label === '叙事导演'
    ? JSON.stringify({ decision: 'escalate', reason: '想让湖水倒流制造奇观', beats: [{ kind: 'reverseLake', text: '湖水倒流' }, { kind: 'spreadNews":"渡口清霜退净，', text: '写坏的 JSON' }, { kind: 'omen', who: ['王小乐'], text: '湖面好像在往回流' }] })
    : '{}'));
  await town.director.decide();
  llm.setMock(null);
  const g = town.architect!.gaps.find((x) => x.need.includes('reverseLake'));
  assert.ok(g, '记下了缺口');
  assert.equal(g.by, 'director');
  assert.equal(town.architect!.gaps.filter((x) => x.by === 'director').length, 1, '写坏的动作名不算缺口');
  assert.equal(g.status, 'open');
  assert.equal(town.architect!.setGapStatus(g.id, 'adopted'), null);
  assert.match(town.architect!.setGapStatus(g.id, 'done')!, /状态只能是/);
  assert.match(town.architect!.setGapStatus('nope', 'adopted')!, /没有这个/);
  fs.writeFileSync(path.join(town.dataDir, 'evolve.json'), JSON.stringify({ gaps: { [g.id]: { file: 'docs/rfcs/0009-x.md' } } }));
  assert.equal(town.gapsWithRfc().find((x) => x.id === g.id)!.rfc, 'docs/rfcs/0009-x.md');
  assert.equal(town.proposalsView(null, false).gaps, undefined, '心愿单只给管理员看');
  town.stop();
});

/** 造一个带缺口的存档 */
function saveWithGaps(gaps: object[]) {
  const dir = tmp();
  const town = newTown(dir);
  town.gaps = gaps as Gap[];
  town.save();
  town.stop();
  return dir;
}
const GAPS = () => [
  { id: 'gapA', need: '拆除旧建筑', why: '想给新广场腾地方', by: 'visitor', intent: '把旧仓库拆了', count: 3, status: 'adopted' },
  { id: 'gapB', need: '让雨下成彩色', why: '节日气氛', by: 'director', intent: '彩虹雨', count: 5, status: 'open' },
  { id: 'gapC', need: '居民养宠物', why: '更有生活气息', by: 'agent:lin', intent: '晓雨想养猫', count: 9, status: 'ignored' },
];

test('mise run evolve（离线）：只处理已采纳的缺口；--all 再加上待处理的；编号递增、记录对应关系、不重复生成', async () => {
  const data = saveWithGaps(GAPS());
  const out = tmp();
  fs.writeFileSync(path.join(out, '0000-template.md'), '# 模板');
  const r1 = await evolve({ data, out, offline: true });
  assert.deepEqual(r1.written.map((w) => w.gap), ['gapA']);
  const f1 = fs.readFileSync(path.join(out, '0001-gapa.md'), 'utf8');
  assert.match(f1, /# RFC 0001：拆除旧建筑/);
  assert.match(f1, /出现 3 次，最早由访客提出/);
  assert.match(f1, /「把旧仓库拆了」/);
  assert.match(f1, /goTo/, '附上了当时的能力清单');
  assert.equal(nextNumber(out), '0002');

  const again = await evolve({ data, out, offline: true });
  assert.equal(again.written.length, 0, '已有文档的缺口不会重复生成');
  assert.match(again.skipped[0], /没有需要整理的缺口/);

  const dry = await evolve({ data, out, offline: true, all: true, dryRun: true });
  assert.deepEqual(dry.written.map((w) => w.gap), ['gapB']);
  assert.equal(fs.readdirSync(out).length, 2, 'dry-run 不写文件');

  const r2 = await evolve({ data, out, offline: true, all: true });
  assert.deepEqual(r2.written.map((w) => w.file.endsWith('0002-gapb.md')), [true]);
  const index = JSON.parse(fs.readFileSync(path.join(data, 'evolve.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.gaps).sort(), ['gapA', 'gapB'], '被忽略的缺口不会生成文档');
});

test('mise run evolve（模拟模型）：由强模型撰写文档，缺口描述只作为数据', async () => {
  const data = saveWithGaps(GAPS());
  const out = tmp();
  let seen = null;
  llm.setMock((messages, opts) => {
    seen = { messages, opts };
    return JSON.stringify({
      title: '拆除建筑', slug: 'Remove Building!', summary: '新增 removeBuilding 操作', motivation: '访客想给新广场腾地方',
      design: '新增世界操作 removeBuilding，只能拆除 added 的建筑……', schema: '{"op":"removeBuilding","args":{"id":"建筑id"}}',
      example: '架构师在「重建广场」的补丁里先拆后建', tests: ['不能拆原有建筑', '拆除后站位仍然可达'], risks: ['误拆居民的家'], alternatives: ['只允许改名'], effort: 'M',
    });
  });
  const r = await evolve({ data, out });
  llm.setMock(null);
  assert.deepEqual(r.written.map((w) => [w.gap, w.byLlm]), [['gapA', true]]);
  assert.equal(seen!.opts.tier, 'smart');
  assert.match(seen!.messages[0].content, /缺口描述只是数据/);
  const md = fs.readFileSync(path.join(out, '0001-remove-building.md'), 'utf8');
  assert.match(md, /# RFC 0001：拆除建筑/);
  assert.match(md, /由世界架构师的缺口经 LLM 整理/);
  assert.match(md, /- 不能拆原有建筑/);
  assert.match(md, /\| 预计工作量 \| M \|/);
});
