// 作息与身体规则（重构方案 P6 第三步）：不建小镇，给数据断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleEntryAt, bodyTick } from '../server/sim/movement.ts';
import type { ScheduleEntry } from '../server/types/agent.ts';

const E = (start: number, end: number, activity: string) => ({ start, end, location: 'shop', activity, emoji: '💼', src: 'plan' }) as ScheduleEntry;
const at = (minute: number, schedule: ScheduleEntry[] = [], scheduleDay = 2) =>
  scheduleEntryAt({ day: 2, minute, planAt: 6 * 60, dayEnd: 22 * 60 + 30, home: 'home_lin', schedule, scheduleDay });

test('此刻该做什么：深夜睡觉、照日程、空档随便转转、日程前后在家', () => {
  const day = [E(8 * 60, 12 * 60, '上班'), E(13 * 60, 17 * 60, '下午班')];
  assert.equal(at(3 * 60, day).activity, '睡觉');
  assert.equal(at(23 * 60 + 10, day).key, 'sleep-2-pm');
  assert.equal(at(10 * 60, day).key, '2-480-shop-上班');
  assert.deepEqual([at(12 * 60 + 30, day).activity, at(12 * 60 + 30, day).key], ['随便转转', '2-gap-720']);
  assert.equal(at(7 * 60, day).activity, '在家吃早饭');
  assert.equal(at(6 * 60 + 10, day).activity, '睡觉', '6:30 前还在睡');
  assert.equal(at(20 * 60, day).activity, '在家休息');
  assert.equal(at(22 * 60 + 40, day).activity, '睡觉');
});

test('没有今天的日程（昨天的不算）：起床想想今天做什么', () => {
  assert.equal(at(9 * 60, [E(8 * 60, 12 * 60, '上班')], 1).key, 'wake-2');
  assert.equal(at(9 * 60).activity, '起床，想想今天要做什么');
});

test('身体：活动消耗体力、睡觉恢复；勇气回归 50；伤势恢复到一半解除重伤；疲惫有回差', () => {
  const b = { hp: 49.6, stamina: 21, courage: 90, conditions: ['重伤', '受惊'] };
  bodyTick(b, 'walking', 60);
  assert.equal(b.stamina, 18);
  assert.ok(b.conditions.includes('疲惫'), '体力低于 20 出现疲惫');
  assert.ok(b.courage < 90 && b.courage > 50);
  assert.ok(b.hp >= 50 && b.conditions.includes('重伤') === false, '恢复到 50 以上解除重伤');
  assert.ok(!b.conditions.includes('受惊'), '勇气够了受惊消失');
  bodyTick(b, 'sleeping', 100);
  assert.equal(b.stamina, 38);
  assert.ok(b.conditions.includes('疲惫'), '40 以下仍然疲惫（回差）');
  bodyTick(b, 'sleeping', 20);
  assert.ok(!b.conditions.includes('疲惫'));
});
