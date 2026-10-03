// 行动规则（重构方案 P6 第三步）：不建小镇，给世界规格与模型输出，断言规范化的结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAct, retryPlan } from '../server/sim/actions.ts';
import { defaultSpec } from '../server/kernel/spec.ts';
import type { Act } from '../server/types/town.ts';

const spec = defaultSpec({});
const item = Object.keys(spec.items)[0]!;
const ability = spec.abilities[0]!.id;
const A = (x: Record<string, unknown>) => x as Act;

test('规范化行动：合法的保留并裁剪，不合法的丢弃', () => {
  assert.equal(parseAct(null, spec, false), undefined);
  assert.deepEqual(parseAct(A({ type: 'give', item, to: '林晓雨', count: 99 }), spec, false), { type: 'give', item, to: '林晓雨', count: 5 });
  assert.deepEqual(parseAct(A({ type: 'give', item, to: '林晓雨', count: 'abc' }), spec, false), { type: 'give', item, to: '林晓雨', count: 1 });
  assert.equal(parseAct(A({ type: 'give', item: 'nope', to: '林晓雨' }), spec, false), undefined, '世界里没有的物品');
  assert.deepEqual(parseAct(A({ type: 'use', ability, target: 'null' }), spec, false), { type: 'use', ability }, '模型写的 "null" 当作没有对象');
  assert.deepEqual(parseAct(A({ type: 'research', topic: '镜湖的传说'.repeat(5) }), spec, false), { type: 'research', topic: '镜湖的传说'.repeat(4) });
  assert.equal(parseAct(A({ type: 'fly' }), spec, true), undefined);
});

test('敌对行动只在会有人动手的世界里接受；意图不认识时按制服处理', () => {
  assert.equal(parseAct(A({ type: 'attack', target: '赵铁柱', intent: 'kill' }), spec, false), undefined);
  assert.deepEqual(parseAct(A({ type: 'attack', target: '赵铁柱', intent: 'kill' }), spec, true), { type: 'attack', target: '赵铁柱', intent: 'kill' });
  assert.deepEqual(parseAct(A({ type: 'attack', target: '赵铁柱', intent: '狠狠地' }), spec, true), { type: 'attack', target: '赵铁柱', intent: 'subdue' });
  assert.deepEqual(parseAct(A({ type: 'steal', item, target: '赵铁柱' }), spec, true), { type: 'steal', item, from: '赵铁柱' });
  assert.equal(parseAct(A({ type: 'taboo', hold: ['silent'] }), spec, true), undefined, '没有威胁的世界不接受禁忌姿态');
});

test('重试：可以重试时每 10 分钟一次、同一条日程最多 6 次；换了日程重新计数', () => {
  let p = retryPlan(null, 'k1', 100, true);
  assert.deepEqual(p, { key: 'k1', next: 110, tries: 1 });
  for (let i = 0; i < 5; i++) p = retryPlan(p, 'k1', 100, true);
  assert.equal(p!.tries, 6);
  assert.equal(retryPlan(p, 'k1', 200, true), null, '第 7 次放弃');
  assert.deepEqual(retryPlan(p, 'k2', 200, true), { key: 'k2', next: 210, tries: 1 });
  assert.equal(retryPlan(p, 'k1', 200, false), null, '不能重试的失败直接放弃');
});
