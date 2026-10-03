// 演出系统（docs/design/presentation.md §4）：校验与模板、目标解析、节流、模型旁白；AI（架构师的规则、导演的节拍）与引擎的自动演出都能调用
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack } = await import('../server/worlds/pack.ts');
const { checkStage, expandStage, MINOR_GAP_MS } = await import('../server/sim/stage.ts');
const { runBeats } = await import('../server/story/beats.ts');
const llm = await import('../server/llm.ts');

const NW = loadPack(path.resolve('worlds/night-watch'));
const PG = loadPack(path.resolve('worlds/pangu'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-stage-'));
let clock = 1_000_000;
const make = (pack = NW, id = 'night-watch') => new Town({ dataDir: tmp(), worldId: id, pack, instantTalk: true, mods: [], seed: 5, now: () => clock });
const collect = (town: TownT) => { const out: Array<{ priority: string; region: string; follow?: string; steps: Array<Record<string, any>> }> = []; town.on('stage', (e) => out.push(e)); return out; }; // eslint-disable-line @typescript-eslint/no-explicit-any

test('校验与模板：模板展开成分镜；目标写法、步骤种类、时长、文字长度、未知地点都会被拦下', () => {
  assert.equal(checkStage({ template: 'intro', target: 'self', name: '盘古' }), null);
  assert.deepEqual(expandStage({ template: 'intro', name: '盘古' }).map((s) => s.do), ['letterbox', 'focus', 'sound', 'card', 'letterbox']);
  assert.equal(checkStage({ steps: [{ do: 'banner', text: '开！' }, { do: 'shake', power: 8 }] }), null);
  assert.match(checkStage({})!, /template 或 steps/);
  assert.match(checkStage({ template: 'dance' })!, /template 只能是/);
  assert.match(checkStage({ steps: [{ do: 'explode' }] })!, /do 只能是/);
  assert.match(checkStage({ steps: [{ do: 'focus', target: 'everyone' }] })!, /目标不合法/);
  assert.match(checkStage({ steps: Array.from({ length: 13 }, () => ({ do: 'wait' })) })!, /最多 12 步/);
  assert.match(checkStage({ steps: [{ do: 'wait', ms: 6000 }, { do: 'wait', ms: 6000 }, { do: 'wait', ms: 6000 }] })!, /太长/);
  assert.match(checkStage({ steps: [{ do: 'banner', text: '字'.repeat(41) }] })!, /过长/);
  assert.match(checkStage({ steps: [{ do: 'sound', sfx: 'explosion' }] })!, /sfx/);
  assert.match(checkStage({ template: 'moment', target: 'loc:nowhere', text: 'x' }, { locations: {} } as never)!, /未知地点/);
});

test('放演出：目标解析成单位引用与位置；普通演出 30 秒一次，重大演出不受限；没有模型时去掉只写了 ai 的旁白', (t) => {
  const town = make();
  t.after(() => town.stop());
  const got = collect(town);
  const shen = town.agents.find((a) => a.name === '沈砚')!;
  assert.ok(town.stage({ template: 'aftermath', target: 'self', ai: '描写一下他的背影' }, { self: shen }));
  assert.equal(got.length, 1);
  const focus = got[0]!.steps.find((s) => s.do === 'focus')!;
  assert.equal(focus.target.kind, 'agent');
  assert.equal(focus.target.id, shen.id);
  assert.ok(!got[0]!.steps.some((s) => s.do === 'narrate'), '没有模型、也没有兜底文字的旁白被去掉');
  assert.equal(town.stage({ template: 'moment', target: 'loc:plaza', text: '又来一段' }), false, '30 秒内的第二段普通演出被节流');
  assert.ok(town.stage({ template: 'moment', target: 'loc:plaza', text: '重大的', priority: 'major' }), '重大演出不受限');
  clock += MINOR_GAP_MS + 1;
  assert.ok(town.stage({ template: 'moment', target: 'loc:plaza', text: '过了 30 秒' }));
  assert.equal(got.length, 3);
  assert.equal(got[2]!.steps.find((s) => s.do === 'focus')!.target.region, 'town');
  assert.equal(town.stage({ steps: [{ do: 'banner', text: '' }] }), false, '不合法的不发');
});

test('旁白：写了 ai 的步骤由模型现写一句（截断到 40 字）；模型失败时用 text', async (t) => {
  const town = make();
  t.after(() => { llm.setMock(null); town.stop(); });
  const got = collect(town);
  llm.setMock(() => '{"text":"夜色压低了城市的呼吸。"}');
  town.stage({ steps: [{ do: 'banner', text: '深夜' }, { do: 'narrate', ai: '描写深夜的城市', ms: 2000 }], priority: 'major' });
  assert.deepEqual(got[0]!.steps.map((s) => s.do), ['banner'], '演出立刻发出，不等模型；还没写好的旁白先不放');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got[1]!.follow, (got[0] as unknown as { id: string }).id, '旁白写好后补发，跟在那段演出后面');
  assert.equal(got[1]!.steps[0]!.text, '夜色压低了城市的呼吸。');
  assert.equal(got[1]!.steps[0]!.ai, undefined, '提示词不下发给前端');
  llm.setMock(() => { throw new Error('boom'); });
  town.stage({ steps: [{ do: 'narrate', ai: '随便', text: '兜底的旁白' }], priority: 'major' });
  assert.equal(got[2]!.steps[0]!.text, '兜底的旁白', '有兜底文字时先用它');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 3, '模型失败时不补发');
});

test('AI 调用：架构师写进规则里的演出能通过校验并按时发出；导演的 stage 节拍能放一段（导演放的都是普通演出）', (t) => {
  const town = make();
  t.after(() => town.stop());
  const got = collect(town);
  town.applyWorldOp({ op: 'addRule', args: { id: 'midnight_bell', name: '午夜钟声', when: { every: 10 }, then: [{ op: 'stage', template: 'moment', target: 'loc:plaza', text: '🔔 远处传来一声钟响' }] } }, { by: 'architect' });
  assert.throws(() => town.applyWorldOp({ op: 'addRule', args: { id: 'bad_stage', name: '坏演出', when: { every: 10 }, then: [{ op: 'stage', steps: [{ do: 'fly' }] }] } }, { by: 'architect' }), /do 只能是/);
  for (let i = 0; i < 21; i++) { town.t += 1; town.rules.tick(); }
  assert.equal(got.length, 1, '规则触发了两次，第二次被节流');
  clock += MINOR_GAP_MS + 1;
  const r = runBeats(town, [{ kind: 'stage', template: 'intro', who: '沈砚', name: '沈砚', title: '夜巡司的负祟人', priority: 'major' }], { ctx: { source: 'director' } });
  assert.equal(r.done, 1, JSON.stringify(r.skipped));
  assert.equal(got[1]!.priority, 'minor', '导演写了 major 也按普通演出');
  assert.equal(got[1]!.steps.find((s) => s.do === 'card')!.name, '沈砚');
  assert.equal(runBeats(town, [{ kind: 'stage', template: 'moment', at: 'nowhere', text: 'x' }]).skipped.length, 1);
});

test('自动演出：Boss 第一次开打有登场演出（只一次）、被打死有倒下演出；创世能力有创世演出；Boss 的大血条信息在快照里', (t) => {
  const town = make(PG, 'pangu');
  t.after(() => town.stop());
  const got = collect(town);
  town.t = 14 * 60;
  const pangu = town.byId.pangu!;
  Object.assign(pangu, { status: 'acting', inside: null, path: [] });
  const core = town.threats.spawn('chaos_core', { loc: 'chaos_deep' })!;
  Object.assign(core, { x: pangu.x + 1, y: pangu.y, region: pangu.region });
  assert.ok(town.engage({ kind: 'threat', id: core.id }, { kind: 'agent', id: 'pangu' }).ok);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.priority, 'major');
  assert.match(got[0]!.steps.find((s) => s.do === 'card')!.name, /混沌本源/);
  assert.deepEqual(town.fightsView()[0]!.fighters.find((f) => f.kind === 'threat')!.boss, { name: '混沌本源', emoji: '🌑', phase: 0, phases: 2 });
  for (let i = 0; i < 1500 && town.fights.length; i++) { pangu.body.hp = 100; town.combatTick(); }
  assert.equal(core.state, 'gone');
  assert.equal(got.filter((e) => e.steps.some((s) => s.do === 'card')).length, 1, '登场演出只放一次');
  assert.ok(got.some((e) => e.steps.some((s) => s.do === 'banner' && /混沌本源/.test(s.text))), '倒下演出');
  town.castAbility(pangu, 'kaitian');
  assert.ok(got.some((e) => e.steps.some((s) => s.do === 'banner' && /开天/.test(s.text)) && e.steps.some((s) => s.do === 'letterbox')), '创世演出');
});
