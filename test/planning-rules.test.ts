// 日程规则（重构方案 P6 第三步）：不建小镇，给数据断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { tidySchedule, spliceEntry, fallbackTemplate, dayRoll, pickOuting } from '../server/sim/planning.ts';
import type { ScheduleEntry } from '../server/types/agent.ts';

const E = (start: number, end: number, activity = 'x', src = 'plan') => ({ start, end, location: 'home', activity, emoji: '🙂', src }) as ScheduleEntry;
const span = (list: ScheduleEntry[]) => list.map((e) => [e.start, e.end, e.activity]);

test('整理日程：排序、截短重叠的前一项、丢掉不足 10 分钟的', () => {
  assert.deepEqual(span(tidySchedule([E(600, 700, 'b'), E(480, 620, 'a'), E(700, 705, 'c'), E(800, 900, 'd')])), [[480, 600, 'a'], [600, 700, 'b'], [800, 900, 'd']]);
});

test('插入日程：覆盖的部分让开，剩下不足 10 分钟的残段丢掉', () => {
  const day = [E(480, 720, '上班'), E(720, 780, '午饭'), E(780, 1020, '下午')];
  assert.deepEqual(span(spliceEntry(day, E(700, 790, '约会', 'commit'))), [[480, 700, '上班'], [700, 790, '约会'], [790, 1020, '下午']]);
  assert.deepEqual(span(spliceEntry(day, E(475, 715, '整段'))), [[475, 715, '整段'], [720, 780, '午饭'], [780, 1020, '下午']], '上班只剩 5 分钟，丢掉');
  assert.equal(day.length, 3, '不修改原数组');
});

test('兜底日程模板：七段、连续、到 22:30', () => {
  const s = fallbackTemplate({ work: 'shop', lunch: 'cafe', walk: ['pier', '散步透气', '🚶'], dinner: 'tavern' });
  assert.equal(s.length, 7);
  assert.equal(s[0]!.start, 6 * 60 + 30);
  assert.equal(s.at(-1)!.end, 22 * 60 + 30);
  for (let i = 1; i < s.length; i++) assert.equal(s[i]!.start, s[i - 1]!.end);
  assert.deepEqual(s.map((e) => e.location), ['home', 'shop', 'cafe', 'shop', 'pier', 'tavern', 'home']);
});

test('去暗月界的掷骰：同一人同一天结果固定、不同天会变；掷骰落在概率里才去', () => {
  assert.equal(dayRoll('lin', 3), dayRoll('lin', 3));
  assert.notEqual(dayRoll('lin', 3), dayRoll('lin', 4));
  const r = dayRoll('lin', 3);
  assert.ok(r >= 0 && r < 1);
  assert.equal(pickOuting(0.5, 0.25), null);
  assert.equal(pickOuting(0, 0.25)!.location, 'moon_garden');
  assert.equal(pickOuting(0.24, 0.25)!.location, 'moon_plaza');
});
