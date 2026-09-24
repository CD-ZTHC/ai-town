// WorldOp：校验、应用、失败不污染原规格、重放
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpec, calendarHint } from '../server/kernel/spec.js';
import { applyOp, replay, OPS } from '../server/kernel/ops.js';

const base = () => defaultSpec({});

test('setParam 在上下限内生效，越界被拒', () => {
  const s = base();
  const next = applyOp(s, { op: 'setParam', args: { name: 'walkSpeed', value: 4 } });
  assert.equal(next.params.walkSpeed, 4);
  assert.equal(s.params.walkSpeed, 3.2, '原规格不应被修改');
  assert.throws(() => applyOp(s, { op: 'setParam', args: { name: 'walkSpeed', value: 50 } }), /2~5/);
  assert.throws(() => applyOp(s, { op: 'setParam', args: { name: 'gravity', value: 1 } }), /未知参数/);
});

test('未知操作、原型链上的键都被拒绝', () => {
  assert.throws(() => applyOp(base(), { op: 'deleteTown', args: {} }), /未知操作/);
  assert.throws(() => applyOp(base(), { op: 'constructor', args: {} }), /未知操作/);
  assert.throws(() => applyOp(base(), { op: 'setParam', args: { name: 'constructor', value: 1 } }), /未知参数/);
  assert.throws(() => applyOp(base(), { op: 'addWeather', args: { id: 'constructor', name: 'x', emoji: '?' } }), /id 不合法/);
});

test('addCalendarEvent 新增节日，并出现在提示词里', () => {
  const next = applyOp(base(), { op: 'addCalendarEvent', args: { id: 'double_moon', name: '双月节', emoji: '🌗', day: 8, from: '19:00', hint: '两轮月亮同时升起', countdown: true } });
  assert.equal(next.calendar.events.at(-1).name, '双月节');
  assert.match(calendarHint(next, 6), /双月节还有2天/);
  assert.throws(() => applyOp(next, { op: 'addCalendarEvent', args: { id: 'double_moon', name: 'x', day: 9, from: '10:00' } }), /已存在/);
  assert.throws(() => applyOp(base(), { op: 'addCalendarEvent', args: { id: 'x1', name: 'x', day: 2, from: '10:00', location: 'moon' } }), /地点不存在/);
});

test('addWeather 新增天气，默认不参与随机', () => {
  const next = applyOp(base(), { op: 'addWeather', args: { id: 'redmoon', name: '赤月', emoji: '🌕', render: { base: 'cloudy', tint: '#8a1c2c', tintAlpha: 0.3 } } });
  assert.deepEqual(next.weather.redmoon, { name: '赤月', emoji: '🌕', weight: 0, render: { base: 'cloudy', tint: '#8a1c2c', tintAlpha: 0.3 } });
  assert.throws(() => applyOp(base(), { op: 'addWeather', args: { id: 'x2', name: 'x', emoji: '?', render: { base: 'lava' } } }), /render.base/);
  assert.throws(() => applyOp(base(), { op: 'addWeather', args: { id: 'x3', name: 'x', emoji: '?', weight: 80 } }), /weight/);
});

test('addCanon 会截断过长文本和标签', () => {
  const next = applyOp(base(), { op: 'addCanon', args: { text: '镜'.repeat(500), tags: ['镜湖', '传说'.repeat(20)], secret: true } }, { seq: 7, t: 100 });
  const c = next.lore.canon[0];
  assert.equal(c.id, 'canon_7');
  assert.equal(c.text.length, 200);
  assert.equal(c.tags[1].length, 12);
  assert.equal(c.secret, true);
});

test('setMeta 只接受合法的分级与叙事者', () => {
  assert.equal(applyOp(base(), { op: 'setMeta', args: { rating: 'adventure' } }).meta.rating, 'adventure');
  assert.throws(() => applyOp(base(), { op: 'setMeta', args: { rating: 'gore' } }), /rating/);
});

test('重放历史得到相同结果，失败的操作被跳过而不是中断', () => {
  const history = [
    { seq: 1, op: 'setParam', args: { name: 'maxConvos', value: 5 } },
    { seq: 2, op: 'setParam', args: { name: 'maxConvos', value: 99 } },
    { seq: 3, op: 'addCanon', args: { text: '第一条正典' } },
  ];
  const { spec, skipped } = replay(base(), history);
  assert.equal(spec.params.maxConvos, 5);
  assert.equal(spec.lore.canon.length, 1);
  assert.deepEqual(skipped.map((k) => k.seq), [2]);
});

test('每个操作都声明了审批等级和描述', () => {
  for (const [name, def] of Object.entries(OPS)) {
    assert.ok(['micro', 'minor', 'major'].includes(def.level), name);
    assert.equal(typeof def.describe, 'function', name);
  }
});
