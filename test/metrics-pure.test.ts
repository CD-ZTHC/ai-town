// 指标模块的纯函数（重构方案 P6 第三步的示范）：不建小镇，给一份状态、断言新的状态与算出的指标（集成测试见 metrics.test.ts）
import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsDay, recordCommitMade, recordSettle, recordRun, computeMetrics } from '../server/sim/metrics.ts';
import type { MetricsHolder } from '../server/sim/metrics.ts';
import type { ScheduleEntry } from '../server/types/agent.ts';
import type { ConvoRecord } from '../server/types/save.ts';

const fresh = (): MetricsHolder => ({ metricsState: { days: {} } });
const entry = (start: string, end: number) => ({ start, end, location: 'tavern', activity: '喝一杯' }) as unknown as ScheduleEntry;
const input = (s: MetricsHolder, extra: Partial<Parameters<typeof computeMetrics>[0]> = {}) =>
  computeMetrics({ metricsState: s.metricsState, day: 1, minute: 12 * 60, convoLog: [], threads: [], byLabel: {}, ...extra });

test('约定：同一个约定只记一次；到场才算兑现；今天还没到时间的不算失约', () => {
  const s = fresh();
  recordCommitMade(s, 1, 'lin', entry('20:00', 21 * 60));
  recordCommitMade(s, 1, 'lin', entry('20:00', 21 * 60));
  recordCommitMade(s, 1, 'zhao', entry('09:00', 10 * 60));
  assert.equal(s.metricsState.days[1]!.commitsMade, 2);
  assert.deepEqual(input(s).commitments, { made: 1, kept: 0, keptRate: 0, pending: 1 }, '20:00 的还没到时间');
  recordSettle(s, 1, 'lin', { src: 'commit', key: '1-20:00-tavern-喝一杯' } as never);
  recordSettle(s, 1, 'lin', { src: 'commit', key: '1-20:00-tavern-喝一杯' } as never);
  recordSettle(s, 1, 'lin', { src: 'plan', key: 'x' } as never);
  assert.equal(s.metricsState.days[1]!.commitsKept, 1, '重复到场、非约定的日程都不算');
  assert.deepEqual(input(s).commitments, { made: 2, kept: 1, keptRate: 0.5, pending: 0 });
});

test('按天计数：新的一天开始时，过去的日子只保留计数；最多保留 30 天', () => {
  const s = fresh();
  recordCommitMade(s, 1, 'lin', entry('20:00', 21 * 60));
  metricsDay(s, 2);
  assert.equal(s.metricsState.days[1]!.pending, undefined);
  assert.equal(s.metricsState.days[1]!.commitsMade, 1);
  for (let d = 3; d <= 40; d++) recordRun(s, d, 'plan', d % 2 === 0);
  const days = Object.keys(s.metricsState.days).map(Number);
  assert.equal(days.length, 30);
  assert.equal(Math.min(...days), 11);
  assert.deepEqual(input(s, { day: 40 }).plans, { total: 30, fallback: 15, fallbackRate: 0.5 });
});

test('对话重复率：两天内同一对人、摘要相似的算重复；兜底对话不参与', () => {
  const c = (t: number, summary: string, fallback = false) => ({ id: `c${t}`, a: 'lin', b: 'zhao', t, summary, lines: [], ...(fallback ? { fallback } : {}) }) as ConvoRecord;
  const log = [c(100, '两人约好晚上去酒馆听音乐会'), c(200, '两人约好晚上去酒馆听音乐会'), c(300, '赵铁柱说起码头的新船', true), c(5000, '两人约好晚上去酒馆听音乐会')];
  const m = input(fresh(), { convoLog: log });
  assert.deepEqual([m.convos.compared, m.convos.repeats], [1, 1], '第 4 段离上一段超过两天，不比较');
});

test('JSON 与线程：只统计 chatJSON 调用过的模块', () => {
  const ls = (json: number, repairs = 0, badJson = 0, schemaMiss = 0) => ({ calls: json, fails: 0, tokens: 0, ms: 0, json, repairs, badJson, schemaMiss });
  const m = input(fresh(), { byLabel: { 对话: ls(10, 1, 0, 2), 闲聊: ls(0) }, threads: [{ status: 'open' }, { status: 'advanced' }, { status: 'resolved' }] });
  assert.deepEqual(Object.keys(m.json.byLabel), ['对话']);
  assert.equal(m.json.schemaMissRate, 0.2);
  assert.deepEqual(m.threads, { total: 3, advanced: 1, resolved: 1, resolvedRate: 0.333, touchedRate: 0.667 });
});
