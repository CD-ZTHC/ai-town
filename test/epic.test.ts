// 世界史诗、世界大纲、结局、第二部与分级修改（docs/design/epic-outline.md）：
// 化解永久生效、史料账本与续写、大纲维护与编辑评审、防剧透、结局与冻结、开启下一部、分级修改与重放。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';
import type { Pack } from '../server/types/world.ts';
import type { ChatMessage } from '../server/types/llm.ts';
import type { ChatOptions } from '../server/llm.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const llm = await import('../server/llm.ts');
const { Town } = await import('../server/sim.ts');
const { loadPack, packSpec } = await import('../server/worlds/pack.ts');
const { validateSpec, publicSpec } = await import('../server/kernel/spec.ts');
const { outlineErrors, normalizeOutline, historyErrors, endingErrors } = await import('../server/kernel/outline-spec.ts');
const { applyOp } = await import('../server/kernel/ops.ts');
const { testExpr } = await import('../server/kernel/rules.ts');
const { noteWeight } = await import('../server/story/epic.ts');

llm.setMock(null);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-epic-'));
const NW = loadPack(path.resolve('worlds/night-watch'));
const LR = loadPack(path.resolve('worlds/little-red'));
const mk = (pack: Pack, worldId: string, dir = tmp(), extra: Record<string, unknown> = {}) => new Town({ dataDir: dir, worldId, pack, instantTalk: true, mods: [], ...extra });
/** 按调用的 label 返回模型回复 */
type Reply = (messages: ChatMessage[], opts: ChatOptions) => unknown;
const mock = (table: Record<string, Reply>) => llm.setMock((messages, opts) => {
  const f = table[opts.label || ''];
  if (!f) throw new Error(`没有为「${opts.label}」准备回复`);
  return JSON.stringify(f(messages, opts));
});
const lastUser = (m: ChatMessage[]) => String(m.at(-1)?.content || '');
const resolveAll = (town: TownT) => { for (const k of Object.keys(town.spec.threats || {})) town.worldFlags[`resolved_${k}`] = true; };
const hours = (town: TownT, h: number) => { for (let i = 0; i < h; i++) { town.t += 60; town.outlineSys.tick(); town.endings.tick(); } };
const BODY = '夜色压在临川的江面上。'.repeat(80);

test('规格：《夜巡》带大纲、结局与史诗配置，全部通过校验；写坏的结局条件被拒绝', () => {
  const spec = packSpec(NW);
  assert.deepEqual(validateSpec(spec), []);
  assert.equal(spec.outline!.endings!.length, 3);
  assert.equal(spec.epic!.title, '夜巡录');
  // 每一只祟都有化解途径（严格的「世界上不再有祟」要能达成）
  for (const [id, t] of Object.entries(spec.threats!)) assert.ok(t.counters!.some((c) => c.type === 'resolve'), `${id} 没有化解途径`);
  assert.ok(endingErrors([{ id: 'x', title: '坏', kind: 'bad', when: "eval('1')" }]).length);
  assert.ok(endingErrors([{ id: 'x', title: '坏', kind: 'evil', when: 'day > 3' }]).some((e) => e.includes('kind')));
  const o = normalizeOutline({ parts: [{ title: 'p', status: 'active', acts: [{ title: 'a', status: 'active', beats: [] }, { title: 'b', status: 'active', beats: [] }] }] });
  assert.ok(outlineErrors(o).some((e) => e.includes('只能有一幕')));
  // 大纲与结局不下发给前端
  const pub = JSON.stringify(publicSpec(spec));
  assert.ok(!pub.includes('长夜无人') && !pub.includes('unresolvedThreats'));
});

test('化解永久生效：按种类化解，收容的与寄宿的一起散去；自动出现与泄漏都跳过已化解的种类', () => {
  const town = mk(NW, 'night-watch');
  const th = town.threats;
  const shen = town.byId.shen!;
  assert.ok(shen.hosted!.some((h) => h.threat === 'back_turned'));
  assert.ok(shen.abilities.includes('look_back'));
  const before = shen.burdens!.erosion!;
  town.worldFlags.pusher_named = true;
  th.hourTick();
  assert.ok(town.worldFlags.resolved_back_turned);
  assert.ok(!shen.hosted!.some((h) => h.threat === 'back_turned'), '寄宿的祟散去了');
  assert.ok(!shen.abilities.includes('look_back'), '失去它给的能力');
  assert.equal(shen.burdens!.erosion, Math.max(0, before - 30));
  assert.equal(th.spawn('back_turned'), null, '已化解的种类不会再出现');
  // 收容的同种威胁：化解时安静下来，不会再泄漏
  town.dark.contained.push({ type: 'phone_ring', holder: 'lu', since: 0, leak: 1, item: 'sealed_box' });
  town.byId.lu!.inventory.sealed_box = 1;
  th.resolveType('phone_ring', '那通电话有人接了');
  assert.equal(town.dark.contained.length, 0);
  assert.ok(!town.byId.lu!.inventory.sealed_box);
  assert.equal(testExpr(town, 'unresolvedThreats() == 5'), true);
  assert.ok(th.live().length > 0, '开局的祟还在外面');
  resolveAll(town);
  assert.equal(testExpr(town, 'unresolvedThreats() == 0'), true);
  th.hourTick();
  assert.equal(th.live().length, 0, '标记从别处设上时，在外的同种威胁也消散');
  town.dark.quietSince = town.day - 10;
  th.dayTick();
  assert.equal(th.live().length, 0, '没有可以再出现的种类');
});

test('大纲：读档时从世界包复制进存档（第一幕进行中，记一条修订）；节点的完成条件按小时判定；存读档保持', () => {
  const dir = tmp();
  const town = mk(NW, 'night-watch', dir);
  const o = town.outline!;
  assert.equal(o.version, 1);
  assert.equal(o.parts[0]!.status, 'active');
  assert.equal(o.parts[0]!.acts[0]!.status, 'active');
  assert.equal(town.outlineRevisions[0]!.kind, 'seed');
  town.worldFlags.resolved_waiting_mother = true;
  hours(town, 1);
  const beat = o.parts[0]!.acts[0]!.beats.find((b) => b.id === 'mother_resolved')!;
  assert.equal(beat.status, 'done');
  assert.ok(beat.doneT != null);
  // 导演看得到大纲与结局，提示里没有条件表达式
  const p = town.director.prompt();
  assert.ok(p.includes('槐荫巷的火') && p.includes('长夜尽头') && !p.includes('unresolvedThreats'));
  town.save();
  town.stop();
  const again = mk(NW, 'night-watch', dir);
  assert.equal(again.outline!.version, 1);
  assert.equal(again.outline!.parts[0]!.acts[0]!.beats.find((b) => b.id === 'mother_resolved')!.status, 'done');
  assert.equal(again.outlineRevisions.length, 1);
  again.stop();
  // 没有大纲的世界：不复制
  const lr = mk(LR, 'little-red');
  assert.equal(lr.outline, null);
  lr.stop();
});

test('史诗：重要的动态按权重记进史料账本；攒够了就写一章（检查避免词，写坏的让模型改一次），挂上大纲节点，游标前移', async (t) => {
  t.after(() => llm.setMock(null));
  const dir = tmp();
  const town = mk(NW, 'night-watch', dir);
  assert.equal(noteWeight({ type: 'death' }), 5);
  assert.equal(noteWeight({ type: 'threat' }), 0);
  assert.equal(noteWeight({ type: 'threat', result: 'resolved' }), 4);
  assert.equal(noteWeight({ type: 'convo' }), 0);
  town.log('death', '🪦 林小满死在了槐荫巷');
  town.log('convo', '闲聊');
  town.log('arc', '🌀 故事开始了');
  assert.equal(town.epicNotes.filter((n) => n.w > 0).length, 2);
  assert.equal(town.epicSys.due(), false, '还不够天数，权重也不够');
  for (let i = 0; i < 2; i++) town.log('death', `🪦 第 ${i} 个人遇害`);
  town.epic.lastDay = town.day - 2;
  assert.equal(town.epicSys.due(), true, '权重攒够了（≥12）并且隔了一天以上');
  let calls = 0;
  mock({
    撰写史诗: (m) => {
      calls++;
      assert.ok(lastUser(m).includes('林小满死在了槐荫巷'), '素材进了提示词');
      assert.ok(lastUser(m).includes('lane_first_death'), '大纲里还没发生的节点 id 给了作者');
      if (calls === 1) return { title: '杨间', body: `${BODY}杨间`, summary: 's', synopsis: '', cast: [], beats: [] }; // 避免词
      return { title: '槐荫巷', body: BODY, summary: '槐荫巷有人回了头', synopsis: '临川开始死人了', cast: [{ name: '陆承', note: '压着祟案' }], beats: ['lane_first_death', 'nope'] };
    },
    大纲维护: () => ({ beats: [], actDone: false, recap: '', future: null, note: '' }),
  });
  const ch = await town.epicSys.write();
  assert.equal(calls, 2, '命中避免词后重写了一次');
  assert.ok(ch);
  assert.equal(ch!.n, 1);
  assert.equal(ch!.volume, 'fire_lane_act', '卷 = 大纲里进行中的幕');
  assert.deepEqual(ch!.beats, ['lane_first_death']);
  assert.ok(town.outline!.parts[0]!.acts[0]!.beats[0]!.chapters.includes('1:1'));
  assert.equal(town.epic.synopsis, '临川开始死人了');
  assert.equal(town.epicNotes.filter((n) => n.seq <= town.epic.cursor).length, 0, '用过的素材删掉了');
  assert.equal(town.epicSys.due(), false);
  assert.ok(town.logs.some((l) => l.type === 'epic'));
  // 章节是只追加的列表，存读档保持
  town.save();
  town.stop();
  const again = mk(NW, 'night-watch', dir);
  assert.equal(again.epicChapters.length, 1);
  assert.equal(again.epicSys.chapter(1, 1)!.title, '槐荫巷');
  assert.ok(again.epicSys.markdown().includes('#### 第1章 槐荫巷'));
  again.stop();
});

test('大纲维护：回写进度、推进幕（史诗随之分卷）、按世界调整未来；已经发生的和锁定的内容不会被 AI 改动', async (t) => {
  t.after(() => llm.setMock(null));
  const town = mk(NW, 'night-watch');
  const o = town.outline!;
  o.parts[0]!.acts[2]!.locked = true;
  mock({
    大纲维护: () => ({
      beats: [{ id: 'lane_first_death', status: 'done' }, { id: 'qian_tells', status: 'transformed', note: '是何敏自己查到的' }, { id: 'mother_origin', status: 'done' }, { id: 'mother_resolved', status: 'done' }],
      actDone: true, recap: '等门的人等到了她的孩子。',
      future: { acts: [{ title: '新的第三幕', plan: 'AI 想重写', beats: [{ text: 'x' }] }] }, note: '第一幕结束',
    }),
  });
  const ch = { part: 1, n: 3, title: 't', summary: 's', beats: [], from: 0, to: town.t } as never;
  await town.outlineSys.afterChapter(ch);
  const n = town.outline!;
  assert.equal(n.version, 2);
  assert.equal(n.parts[0]!.acts[0]!.status, 'done');
  assert.equal(n.parts[0]!.acts[0]!.recap, '等门的人等到了她的孩子。');
  assert.equal(n.parts[0]!.acts.filter((a) => a.status === 'active').length, 1, '下一幕开始');
  assert.equal(n.parts[0]!.acts[0]!.beats[1]!.status, 'transformed');
  assert.ok(n.parts[0]!.acts.some((a) => a.id === 'bearers_act' && a.locked), '锁定的幕保留');
  assert.ok(n.parts[0]!.acts.some((a) => a.title === '新的第三幕'), '没锁定的计划被调整');
  // 没锁定的「名册上的名字」被 AI 换掉了，锁定的「负祟人」留在原位并成为当前的幕；史诗按当前的幕分卷
  assert.ok(!n.parts[0]!.acts.some((a) => a.id === 'ledger_act'));
  assert.equal(n.parts[0]!.acts.find((a) => a.status === 'active')!.id, 'bearers_act');
  assert.equal(town.epicSys.volumeOf(4).volume, 'bearers_act');
  assert.equal(town.outlineRevisions.at(-1)!.kind, 'keeper');
  // 历史不能改
  const bad = structuredClone(n);
  bad.parts[0]!.acts[0]!.recap = '改写历史';
  assert.ok(historyErrors(n, bad).length);
});

test('大纲编辑：保存前必须评审同一份草稿；改历史、写坏的条件、现在就满足的结局都过不了；强制保存只有管理员', async (t) => {
  t.after(() => llm.setMock(null));
  const town = mk(NW, 'night-watch');
  const sys = town.outlineSys;
  const draft = structuredClone(town.outline!);
  draft.parts[0]!.acts[1]!.plan = '萧九先找上了唐棠。';
  assert.throws(() => sys.save(draft, { baseVersion: 1, by: 'u1' }), /请先提交评审/);
  mock({ 设定评审: () => ({ verdict: 'pass', summary: '可以', issues: [{ severity: 'minor', where: '第二幕', text: '节奏略快', suggestion: '加一个节点' }] }) });
  const r = await sys.review(draft, 1, 'u1');
  assert.ok(r.reviewId);
  assert.equal(r.result.verdict, 'pass');
  // 评审之后又改了：不接受
  const changed = structuredClone(draft);
  changed.parts[0]!.acts[1]!.plan = '偷偷改了';
  assert.throws(() => sys.save(changed, { baseVersion: 1, reviewId: r.reviewId!, by: 'u1' }), /评审之后被改过/);
  const saved = sys.save(draft, { baseVersion: 1, reviewId: r.reviewId!, by: 'u1', kind: 'owner-manual' });
  assert.equal(saved.version, 2);
  assert.equal(town.outlineRevisions.at(-1)!.review!.issues, 1);
  assert.throws(() => sys.save(draft, { baseVersion: 1, reviewId: r.reviewId!, by: 'u1' }), /已经被更新/);
  // 写坏的条件：规则校验直接挡住
  const broken = structuredClone(town.outline!);
  broken.endings[0]!.when = "process.exit()";
  const rb = await sys.review(broken, 2, 'u1');
  assert.equal(rb.reviewId, null);
  assert.equal(rb.result.by, 'rules');
  // 结局现在就满足：major，不能保存
  const now = structuredClone(town.outline!);
  now.endings[0]!.when = 'day >= 1';
  const rn = await sys.review(now, 2, 'u1');
  assert.ok(rn.result.issues.some((i) => i.severity === 'major' && i.text.includes('现在就已经满足')));
  assert.throws(() => sys.save(now, { baseVersion: 2, reviewId: rn.reviewId!, by: 'u1' }), /需要先修改/);
  assert.throws(() => sys.save(now, { baseVersion: 2, force: true, by: 'u1' }), /只有管理员/);
  assert.equal(sys.save(now, { baseVersion: 2, force: true, admin: true, by: 'admin' }).version, 3);
  assert.equal(town.outlineRevisions.at(-1)!.review!.forced, true);
});

test('AI 辅助修改：按描述改大纲，结果先过规则校验（不合法时带着错误重写一次），不会直接保存', async (t) => {
  t.after(() => llm.setMock(null));
  const town = mk(NW, 'night-watch');
  let n = 0;
  mock({
    大纲修改: (m) => {
      n++;
      const o = JSON.parse(lastUser(m).split('现在的大纲：\n')[1]!.split('\n')[0]!);
      if (n === 1) { o.parts[0].acts[1].status = 'active'; return { outline: o, summary: '两幕同时进行' }; } // 不合法
      o.parts[0].acts[3].plan = '萧九在镇匣开裂之后回来帮忙。';
      return { outline: o, summary: '萧九回来帮忙' };
    },
  });
  const r = await town.outlineSys.assist('让萧九回来帮忙', 1);
  assert.equal(n, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(r.draft.parts[0]!.acts[3]!.plan, '萧九在镇匣开裂之后回来帮忙。');
  assert.equal(town.outline!.version, 1, '还没有保存');
});

test('防剧透：其他人只看得到已经发生的幕和当前幕的标题，看不到计划与结局', () => {
  const town = mk(NW, 'night-watch');
  const o = town.outline!;
  o.parts[0]!.acts[0]!.status = 'done';
  o.parts[0]!.acts[0]!.recap = '等门的人等到了。';
  o.parts[0]!.acts[0]!.beats[0]!.status = 'done';
  o.parts[0]!.acts[1]!.status = 'active';
  const pub = JSON.stringify(town.outlineSys.view(false));
  assert.ok(pub.includes('等门的人等到了') && pub.includes('名册上的名字'));
  assert.ok(!pub.includes('报丧簿开始写出'), '当前幕的计划不公开');
  assert.ok(!pub.includes('负祟人') && !pub.includes('长夜无人') && !pub.includes('unresolvedThreats'), '未来与结局不公开');
  const full = JSON.stringify(town.outlineSys.view(true));
  assert.ok(full.includes('长夜无人') && full.includes('报丧簿开始写出') && full.includes('revisions'));
  assert.deepEqual([...town.outlineSys.publicBeats()], ['lane_first_death']);
});

test('结局：条件达成 → 终幕（导演停下）→ 冻结（时间不再推进、写大结局）→ 开启第二部；坏结局要连续满足若干天', async (t) => {
  t.after(() => llm.setMock(null));
  const town = mk(NW, 'night-watch');
  const ends: unknown[] = [];
  town.on('ended', (e) => ends.push(e));
  // 坏结局：夜巡司的人都死了，要连续 3 天
  for (const id of ['lu', 'shen', 'gu']) town.byId[id]!.status = 'dead';
  hours(town, 1);
  assert.equal(town.endState.triggered, null);
  assert.ok(town.endState.held.nobody_left != null);
  for (const id of ['lu', 'shen', 'gu']) town.byId[id]!.status = 'idle';
  hours(town, 1);
  assert.equal(town.endState.held.nobody_left, undefined, '中断后重新计数');
  // 好结局：所有的祟都被化解
  resolveAll(town);
  hours(town, 1);
  assert.equal(town.endState.triggered!.id, 'dawn');
  assert.ok(town.endings.finale);
  assert.ok(town.logs.some((l) => l.type === 'ending'));
  let wrote = 0;
  mock({ 撰写史诗: (m) => { wrote++; assert.ok(lastUser(m).includes('大结局') && lastUser(m).includes('尾声')); return { title: '天亮了', body: BODY, summary: '最后一盏灯熄灭了', synopsis: '全书', cast: [], beats: [] }; } });
  hours(town, 18);
  assert.ok(town.endState.ended);
  assert.equal(ends.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(wrote, 1);
  const last = town.epicChapters.at(-1)!;
  assert.equal(last.ending!.id, 'dawn');
  assert.equal(town.epic.finalePending, false);
  const t0 = town.t;
  town.advance(0.5);
  assert.equal(town.t, t0, '冻结后时间不再推进');
  // 第二部
  mock({
    大纲修改: () => ({ title: '余烬', premise: '十年后镇匣开裂', acts: [{ title: '开裂', plan: '镇匣一个接一个地开裂', beats: [{ text: '第一只镇匣开裂' }] }, { title: '回声', plan: 'p', beats: [] }], endings: [{ id: 'dawn2', title: '再次天亮', kind: 'good', when: "flag('dawn2')" }] }),
    设定评审: () => ({ verdict: 'pass', summary: 'ok', issues: [] }),
  });
  const plan = await town.sequel.plan({ direction: '十年后镇匣开裂', by: 'u1' });
  assert.ok(plan.planId);
  const r = town.sequel.apply(plan.planId!, { by: 'u1' });
  assert.equal(r.part, 2);
  assert.equal(town.endState.ended, null);
  assert.equal(town.epic.part, 2);
  assert.equal(town.epic.partTitle, '余烬');
  const o = town.outline!;
  assert.equal(o.parts[0]!.status, 'done');
  assert.equal(o.parts.at(-1)!.status, 'active');
  assert.equal(o.parts.at(-1)!.acts[0]!.status, 'active');
  assert.deepEqual(o.endings.map((e) => e.id), ['dawn2']);
  assert.equal(ends.at(-1), null);
  town.advance(0.5);
  assert.ok(town.t > t0, '第二部开始后世界继续推进');
});

test('分级修改：冒险级的小红帽 → 黑暗级；AI 适配支柱、反派与威胁，评审后作为世界操作应用，重启后按操作历史重放', async (t) => {
  t.after(() => llm.setMock(null));
  const dir = tmp();
  const town = mk(LR, 'little-red', dir);
  const ratings: string[] = [];
  town.on('rating', (r) => ratings.push(r));
  const threat = {
    howl: {
      name: '夜嚎', emoji: '🐺', kind: '狼影', mortal: false, origin: '被猎人赶出森林的老狼', haunt: ['forest_path'], movement: 'wander', active: ['20:00', '05:00'],
      rule: { trigger: "night() && entered(e, 'forest_path') && alone(e)", mark: { delay: [20, 60], sign: '背后有呼吸声' }, outcome: [{ op: 'kill', target: 'self', text: '{self}在林子里没有回来' }] },
      counters: [{ type: 'ward', with: 'torch_ward', radius: 3 }, { type: 'resolve', when: "flag('old_wolf_buried')", text: '老狼被好好安葬了' }],
      clues: ['一个人走林子会出事'], decoys: ['穿红衣服的人会出事'],
    },
  };
  mock({
    分级适配: (m) => (lastUser(m).includes('按规律行事的威胁')
      ? { threats: threat, structures: { torch_ward: { name: '火把圈', emoji: '🔥', tags: ['light'] } }, items: {}, abilities: [], burden: null, hosts: [], start: ['howl'] }
      : { pillars: ['森林在夜里会吃人', '大灰狼是真正的猎食者，不会被一次善意感化', '小红帽勇敢，但勇敢要付出代价'], summary: null, personas: [{ id: 'wolf', alignment: 'villain', drives: [{ text: '把外婆的小屋变成自己的窝', perDay: 30 }], redemption: '' }], storyteller: 'horror', story: '森林变得危险' }),
    设定评审: () => ({ verdict: 'pass', summary: '符合黑暗分级', issues: [] }),
    大纲维护: () => ({ future: null, note: '' }),
    // 没有大纲的世界：按改动之后的世界（新的支柱、新的威胁）生成大纲
    生成大纲: (m) => {
      assert.ok(lastUser(m).includes('howl') && lastUser(m).includes('森林在夜里会吃人'), '按改动之后的世界来写');
      return { outline: { premise: '森林在夜里会吃人', parts: [{ title: '黑森林', status: 'active', acts: [{ title: '失踪', status: 'active', plan: '有人在林子里没有回来', beats: [{ text: '猎人发现了狼的踪迹' }] }] }], endings: [{ id: 'old_wolf_rests', title: '老狼安息', kind: 'good', when: "flag('old_wolf_buried')" }, { id: 'forest_wins', title: '森林吞没村庄', kind: 'bad', when: 'namedDeaths() >= 3', for: 1 }] }, summary: '黑暗的小红帽' };
    },
  });
  const p = await town.rerate.plan({ to: 'dark', by: 'u1' });
  assert.equal(p.summary.outline.created, true);
  assert.deepEqual(p.summary.outline.endings.map((e: { title: string }) => e.title), ['老狼安息', '森林吞没村庄']);
  assert.ok(p.planId);
  assert.equal(p.summary.toName, '黑暗');
  assert.equal(p.summary.threats[0].name, '夜嚎');
  assert.ok(p.summary.personas.some((x: { name: string }) => x.name === '大灰狼'));
  assert.equal(town.spec.meta.rating, 'adventure', '应用之前世界不变');
  const r = town.rerate.apply(p.planId, { by: 'u1' });
  assert.deepEqual(r.failed, []);
  assert.equal(r.outline, 'saved', '大纲跟着分级一起保存');
  assert.equal(town.outline!.endings.length, 2);
  assert.equal(town.outlineRevisions.at(-1)!.kind, 'rerate');
  assert.equal(town.spec.meta.rating, 'dark');
  assert.equal(town.spec.meta.storyteller, 'horror');
  assert.ok(town.spec.lore.pillars!.includes('森林在夜里会吃人'));
  assert.equal(town.byId.wolf!.alignment, 'villain', '在场的狼也变成了反派');
  assert.ok(town.spec.threats!.howl);
  assert.ok(town.threats.live().some((x) => x.type === 'howl'), '开局威胁出现了');
  assert.deepEqual(ratings, ['dark']);
  assert.throws(() => town.rerate.apply(p.planId, { by: 'u1' }), /不存在或已过期/);
  // 重启：按操作历史重放（世界设置里的分级同步改成 dark，和登记一致）
  town.save();
  town.stop();
  const again = mk(LR, 'little-red', dir, { worldSettings: { rating: 'dark' } });
  assert.equal(again.spec.meta.rating, 'dark');
  assert.ok(again.spec.threats!.howl);
  assert.equal(again.spec.personas.find((x) => x.id === 'wolf')!.alignment, 'villain');
  again.stop();
  // 世界登记的分级说了算：之后管理员直接改回冒险，重放出来的 setMeta 不会盖过它
  const back = mk(LR, 'little-red', dir, { worldSettings: { rating: 'adventure' } });
  assert.equal(back.spec.meta.rating, 'adventure');
  back.stop();
});

test('新的世界操作：setLore / addBurden / addThreat / setIncidents / setPersonaTraits 都会校验参数', () => {
  const spec = packSpec(LR);
  assert.throws(() => applyOp(spec, { op: 'setLore', args: { pillars: [] } }), /pillars/);
  assert.throws(() => applyOp(spec, { op: 'addThreat', args: { id: 'x1', def: { name: '影', emoji: '👤', mortal: false, haunt: ['nowhere'] } } }), /haunt/);
  assert.throws(() => applyOp(spec, { op: 'setIncidents', args: { start: [{ threat: 'nope' }] } }), /未知威胁/);
  assert.throws(() => applyOp(spec, { op: 'setPersonaTraits', args: { id: 'wolf', alignment: 'evil' } }), /alignment/);
  assert.throws(() => applyOp(spec, { op: 'setPersonaTraits', args: { id: 'wolf', redemption: "eval('x')" } }), /redemption/);
  const s2 = applyOp(spec, { op: 'addBurden', args: { id: 'fear', def: { name: '恐惧', drift: 1 } } });
  assert.ok(s2.burdens!.fear);
  const s3 = applyOp(s2, { op: 'addItem', args: { id: 'charm', name: '护身符', emoji: '🧿', use: [{ op: 'burden', id: 'fear', amount: -5 }] } });
  assert.equal(s3.items.charm!.use!.length, 1, 'addItem 保留 use 效果');
});

test('接口：大纲按身份裁剪；没有令牌不能修改大纲、生成计划；故事完结后不能再互动，史诗照常可读', async (t) => {
  const { WorldHost } = await import('../server/worlds/host.ts');
  const { createApp } = await import('../server/http/app.ts');
  const { config } = await import('../server/guard.ts');
  const dir = tmp();
  const host = new WorldHost({ id: 'night-watch', makeTown: () => mk(NW, 'night-watch', dir) });
  host.dataRoot = dir;
  const app = createApp({ hostFor: () => host, publicDir: 'public' });
  t.after(() => { host.close({ save: false }); Object.assign(config, { publicMode: undefined, adminToken: undefined }); });
  Object.assign(config, { publicMode: true, adminToken: 'secret-token' });
  const ADMIN = { 'X-Admin-Token': 'secret-token' };
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) => app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const anon = await (await app.request('/api/outline')).json();
  assert.equal(anon.full, false);
  assert.ok(!JSON.stringify(anon).includes('长夜无人'), '游客看不到结局');
  const adm = await (await app.request('/api/outline', { headers: ADMIN })).json();
  assert.equal(adm.full, true);
  assert.equal(adm.ending.endings.length, 3);
  assert.equal((await post('/api/outline/save', { draft: adm.outline, baseVersion: 1 })).status, 403);
  assert.equal((await post('/api/rating/plan', { to: 'cozy' })).status, 403);
  assert.equal((await post('/api/outline/save', { draft: adm.outline, baseVersion: 1 }, ADMIN)).status, 409, '没有评审不能保存');
  // 大纲草稿可以超过 8KB
  const big = structuredClone(adm.outline);
  big.premise = big.premise.slice(0, 100);
  big.parts[0].acts.forEach((a: { plan: string }) => { a.plan = '长'.repeat(290); });
  assert.notEqual((await post('/api/outline/review', { draft: big, baseVersion: 1 }, ADMIN)).status, 413);
  assert.equal((await app.request('/api/epic')).status, 200);
  // 完结：互动返回 409，史诗可读
  host.town.endState.ended = { id: 'dawn', title: '长夜尽头', kind: 'good', t: 0, day: 1 };
  const chat = await post('/api/event', { text: '城里又出事了' }, ADMIN);
  assert.equal(chat.status, 409);
  assert.equal((await chat.json()).ended, true);
  assert.equal((await app.request('/api/epic')).status, 200);
});

test('AI 生成大纲：结果存为草稿并自动评审（刷新页面也在）；当场就满足的结局会让模型重写；保存后草稿清空', async (t) => {
  t.after(() => llm.setMock(null));
  const town = mk(LR, 'little-red');
  let n = 0;
  mock({
    生成大纲: (m) => {
      n++;
      const outline = { premise: '小红帽去外婆家', parts: [{ title: '森林', status: 'active', acts: [{ title: '出发', status: 'active', plan: '妈妈叮嘱小红帽', beats: [{ text: '小红帽带上篮子' }] }] }], endings: [{ id: 'safe', title: '平安到家', kind: 'good', when: n === 1 ? 'unresolvedThreats() == 0' : "flag('home_safe')" }] };
      if (n === 2) assert.ok(lastUser(m).includes('现在就已经满足'), '把问题告诉了模型');
      return { outline, summary: '温馨的冒险' };
    },
    设定评审: () => ({ verdict: 'pass', summary: '可以', issues: [] }),
  });
  const r = await town.outlineSys.draftJob('generate', { baseVersion: 0, by: 'u1' });
  assert.equal(n, 2, '没有威胁的世界里 unresolvedThreats() == 0 当场成立，重写了一次');
  assert.deepEqual(r.errors, []);
  assert.ok(r.reviewId);
  assert.equal(town.outline, null, '还没有保存');
  const v = town.outlineSys.view(true) as { draft: { reviewId: string; source: string; draft: { endings: Array<{ when: string }> } } };
  assert.equal(v.draft.source, 'generate');
  assert.equal(v.draft.reviewId, r.reviewId);
  assert.equal(v.draft.draft.endings[0]!.when, "flag('home_safe')");
  assert.ok(!JSON.stringify(town.outlineSys.view(false)).includes('平安到家'), '草稿不给其他人看');
  // 服务重启后评审登记没了：草稿还在，但需要重新评审
  town.outlineSys.desk.items.clear();
  assert.equal((town.outlineSys.view(true) as { draft: { reviewId: string | null } }).draft.reviewId, null);
  const rv = await town.outlineSys.review(v.draft.draft, 0, 'u1');
  town.outlineSys.save(v.draft.draft, { baseVersion: 0, reviewId: rv.reviewId, by: 'u1', kind: 'owner-ai' });
  assert.equal(town.outline!.version, 1);
  assert.equal(town.outlineDraft, null, '保存后草稿清空');
});

test('重置到第一天：分级修改带来的内容与大纲保留（大纲从头开始），史诗清空', async (t) => {
  const { WorldHost } = await import('../server/worlds/host.ts');
  const { createApp } = await import('../server/http/app.ts');
  const dir = tmp();
  const host = new WorldHost({ id: 'little-red', makeTown: () => mk(LR, 'little-red', dir) });
  host.dataRoot = dir;
  const app = createApp({ hostFor: () => host, publicDir: 'public' });
  t.after(() => host.close({ save: false }));
  const town = host.town;
  const { applyContent } = await import('../server/worldai/rerate.ts');
  applyContent(town, { ops: [{ op: 'setMeta', args: { rating: 'dark' } }, { op: 'setLore', args: { pillars: ['森林在夜里会吃人'] } }], hosts: [], dropped: [] }, { kind: 'rerate' });
  town.outlineSys.commit(normalizeOutline({ premise: 'p', parts: [{ title: '一', status: 'active', acts: [{ title: 'a', status: 'done', recap: '过去了', plan: 'x', beats: [{ text: 'b', status: 'done', chapters: ['1:1'] }] }, { title: 'b', status: 'active', plan: 'y', beats: [] }] }], endings: [] }), { kind: 'owner-manual', by: 'u1' });
  town.epicChapters.push({ part: 1, volume: 'v1', volumeTitle: '第1卷', n: 1, title: 't', body: 'b', summary: 's', from: 0, to: 0, beats: [], t: 0 });
  const r = await app.request('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESET' }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).kept, { ops: 2, outline: true });
  const nt = host.town;
  assert.notEqual(nt, town);
  assert.equal(nt.spec.meta.rating, 'dark');
  assert.deepEqual(nt.spec.lore.pillars, ['森林在夜里会吃人']);
  assert.equal(nt.epicChapters.length, 0);
  const o = nt.outline!;
  assert.equal(o.parts[0]!.acts[0]!.status, 'active', '从第一幕重新开始');
  assert.equal(o.parts[0]!.acts[0]!.recap, undefined);
  assert.deepEqual(o.parts[0]!.acts[0]!.beats[0]!.chapters, []);
  assert.equal(o.parts[0]!.acts[1]!.status, 'planned');
  // 再重置一次：内容仍然保留（不会越叠越多）
  await app.request('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESET' }) });
  assert.equal(host.town.specOps.filter((x) => x.cause?.kind === 'rerate').length, 2);
});

test('取出模型给的大纲：各种包法都认；AI 写成空大纲时让它重写', async (t) => {
  t.after(() => llm.setMock(null));
  const { pickOutline } = await import('../server/story/outline.ts');
  const o = { parts: [{ title: 'p', acts: [] }] };
  assert.deepEqual(pickOutline({ outline: o }), o);
  assert.deepEqual(pickOutline({ outline: JSON.stringify(o) }), o);
  assert.deepEqual(pickOutline(o), o);
  assert.deepEqual(pickOutline({ result: o }), o);
  assert.equal(pickOutline({ summary: 'x' }), null);
  const town = mk(LR, 'little-red');
  let n = 0;
  mock({ 生成大纲: (m) => { n++; if (n === 1) return { summary: '忘了写大纲' }; assert.ok(lastUser(m).includes('大纲是空的')); return { 大纲: { parts: [{ title: '森林', status: 'active', acts: [{ title: '出发', status: 'active', plan: 'p', beats: [{ text: '带上篮子' }] }] }] }, summary: 's' }; } });
  const r = await town.outlineSys.generate(0);
  assert.equal(n, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(r.draft.parts[0]!.acts[0]!.title, '出发');
});
