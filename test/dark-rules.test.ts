// 黑暗叙事规则（重构方案 P6 第三步）：不建小镇，给数据断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNear, deathBudgetOf, burdenStep, hostedDriftMult, nearestLoc, hostileWorld } from '../server/sim/dark.ts';
import type { WorldSpec } from '../server/types/spec.ts';

test('是否在身边：同一栋楼里，或都在户外且足够近；不同区域不算', () => {
  assert.equal(isNear({ x: 0, y: 0 }, { x: 3, y: 0 }), true);
  assert.equal(isNear({ x: 0, y: 0 }, { x: 3, y: 1 }), false);
  assert.equal(isNear({ x: 0, y: 0, inside: 'inn' }, { x: 40, y: 40, inside: 'inn' }), true);
  assert.equal(isNear({ x: 0, y: 0, inside: 'inn' }, { x: 0, y: 0 }), false);
  assert.equal(isNear({ x: 0, y: 0, region: 'moon' }, { x: 0, y: 0 }), false);
  assert.equal(isNear(null, { x: 0, y: 0 }), false);
});

test('死亡预算：只算最近 days 天里的死亡', () => {
  const deaths = [{ t: 100 }, { t: 3000 }, { t: 5000 }];
  assert.deepEqual(deathBudgetOf(deaths, 5000, 2, 2), { named: 2, days: 2, used: 2, left: 0 });
  assert.deepEqual(deathBudgetOf(deaths, 5000, 5, 1), { named: 5, days: 1, used: 1, left: 4 });
});

test('负担值的一步：截到上限、跨过阈值换心情（取最后一个）、刚到顶才算 full', () => {
  const moodAt = [[30, '不安'], [60, '恐惧']] as const;
  assert.deepEqual(burdenStep(20, 50, 100, moodAt), { value: 70, mood: '恐惧', full: false });
  assert.deepEqual(burdenStep(40, 10, 100, moodAt), { value: 50, mood: null, full: false });
  assert.deepEqual(burdenStep(90, 30, 100, moodAt), { value: 100, mood: null, full: true });
  assert.deepEqual(burdenStep(100, 5, 100, moodAt), { value: 100, mood: null, full: false }, '已经满了不再触发');
  assert.equal(burdenStep(5, -20, 100, moodAt).value, 0);
});

test('寄宿倍率：寄宿的威胁 rate 相加，同时寄宿时互相抵消；没有寄宿为 1', () => {
  const threats = {
    ghost: { hostable: { burden: 'dread', rate: 2, offsets: { mirror: -1.5 } } },
    mirror: { hostable: { burden: 'dread', rate: 1 } },
    other: { hostable: { burden: 'hunger' } },
  } as unknown as WorldSpec['threats'];
  assert.equal(hostedDriftMult([], threats, 'dread'), 1);
  assert.equal(hostedDriftMult([{ threat: 'ghost' }], threats, 'dread'), 2);
  assert.equal(hostedDriftMult([{ threat: 'ghost' }, { threat: 'mirror' }], threats, 'dread'), 1.5);
  assert.equal(hostedDriftMult([{ threat: 'other' }], threats, 'dread'), 1, '别的负担不受影响');
});

test('伤亡记在同区域、最近的地点', () => {
  const centers: Record<string, { x: number; y: number }> = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 1, y: 0 } };
  const region = (id: string) => (id === 'c' ? 'moon' : 'town');
  assert.equal(nearestLoc(['a', 'b', 'c'], { x: 2, y: 0 }, region, (id) => centers[id]!), 'a');
  assert.equal(nearestLoc(['a', 'b', 'c'], { x: 2, y: 0, region: 'moon' }, region, (id) => centers[id]!), 'c');
  assert.equal(nearestLoc(['a'], { x: 0, y: 0, region: 'moon' }, region, (id) => centers[id]!), null);
});

test('会不会有人动手：冒险分级起，并且有阵营、反派或威胁', () => {
  const S = (rating: string, extra: Partial<WorldSpec> = {}) => ({ meta: { rating }, factions: [], personas: [], threats: {}, ...extra }) as unknown as WorldSpec;
  assert.equal(hostileWorld(S('dark')), false);
  assert.equal(hostileWorld(S('gentle', { threats: { x: {} } as never })), false);
  assert.equal(hostileWorld(S('adventure', { threats: { x: {} } as never })), true);
  assert.equal(hostileWorld(S('dark', { personas: [{ alignment: 'villain' }] as never })), true);
});
