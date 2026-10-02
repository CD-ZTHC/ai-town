// AI 表现指标：约定兑现率、对话重复率、剧情线程回收率、JSON 失败率、兜底率。
// 换模型时拿来对比；计数按游戏日存进存档（最多 30 天），JSON 统计来自进程内的 llm.stats。
//
// 独立模块（重构方案 P6 第三步的第一个子系统）：逻辑都是只操作数据的函数——
//   记录：(state, day, …) → 修改 state.metricsState；视图：(输入数据) → 指标。不依赖 Town，可以单独测试（见 test/metrics.test.ts）。
// Town 上的同名方法（下面的 Metrics mixin）只是把 town 的状态与时间交给这些函数，调用方不用改。
import * as llm from '../llm.ts';
import { similarity } from '../memory.ts';
import { threadList } from '../story/threads.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent, ScheduleEntry } from '../types/agent.ts';
import type { MetricsDay } from '../types/town.ts';
import type { ConvoRecord } from '../types/save.ts';
import type { LabelStats } from '../llm.ts';

const KEEP_DAYS = 30;
const REPEAT_SIM = 0.5; // 两次对话摘要的相似度达到这个值算「重复」
const REPEAT_WINDOW = 2 * 1440; // 只和两天内同一对人的上一次对话比较

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/** 指标用到的那部分世界状态 */
export interface MetricsHolder { metricsState: { days: Record<string, MetricsDay> } }
type Day = MetricsDay & { keptKeys: string[]; pending: Array<{ key: string; end: number }> };

/** 某一天的计数（没有就新建；过去的日子只保留计数，最多 30 天） */
export function metricsDay(s: MetricsHolder, day: number): Day {
  const st = (s.metricsState ||= { days: {} });
  if (!st.days[day]) {
    // 过去的日子只保留计数：去掉用来去重的 key 列表，控制存档体积
    for (const old of Object.values(st.days)) { delete old.keptKeys; delete old.pending; }
    st.days[day] = { commitsMade: 0, commitsKept: 0, keptKeys: [], pending: [], plans: 0, planFallback: 0, convos: 0, convoFallback: 0 };
  }
  const d = st.days[day]!;
  d.keptKeys ||= [];
  d.pending ||= [];
  const keys = Object.keys(st.days).map(Number).sort((a, b) => a - b);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete st.days[k];
  return d as Day;
}

/** 新约定。key = 居民 + desired() 生成的日程 key；同一个约定重复约只算一次 */
export function recordCommitMade(s: MetricsHolder, day: number, agentId: string, entry: ScheduleEntry): void {
  const d = metricsDay(s, day);
  const key = `${agentId}:${day}-${entry.start}-${entry.location}-${entry.activity}`;
  if (d.pending.some((p) => p.key === key)) return;
  d.commitsMade++;
  d.pending.push({ key, end: entry.end });
}

/** 居民在约定的日程里到场 */
export function recordSettle(s: MetricsHolder, day: number, agentId: string, e: CurEntry | null | undefined): void {
  if (e?.src !== 'commit' || !e.key) return;
  const d = metricsDay(s, day);
  const key = `${agentId}:${e.key}`;
  if (d.keptKeys.includes(key)) return;
  d.keptKeys.push(key);
  d.commitsKept++;
}

/** 规划 / 对话用的是模型输出还是兜底 */
export function recordRun(s: MetricsHolder, day: number, kind: string, fallback: boolean): void {
  const d = metricsDay(s, day);
  if (kind === 'plan') { d.plans++; if (fallback) d.planFallback++; }
  if (kind === 'convo') { d.convos++; if (fallback) d.convoFallback++; }
}

/** 算指标需要的全部输入（都是数据） */
export interface MetricsInput {
  metricsState: MetricsHolder['metricsState'] | undefined;
  day: number;
  minute: number;
  convoLog: ConvoRecord[];
  threads: Array<{ status: string }>;
  byLabel: Record<string, LabelStats>;
}

export function computeMetrics({ metricsState, day, minute, convoLog, threads, byLabel: llmByLabel }: MetricsInput) {
  const days = Object.entries(metricsState?.days || {}).map(([k, v]) => ({ day: Number(k), ...v }));
  const sum = (f: 'commitsMade' | 'commitsKept' | 'plans' | 'planFallback' | 'convos' | 'convoFallback') => days.reduce((s, d) => s + (d[f] || 0), 0);
  // 今天还没到时间的约定不算失约
  const today = days.find((d) => d.day === day);
  const pending = (today?.pending || []).filter((p) => p.end > minute && !today!.keptKeys!.includes(p.key)).length;
  const made = sum('commitsMade') - pending, kept = sum('commitsKept');

  let compared = 0, repeats = 0;
  const real = convoLog.filter((c) => !c.fallback && c.summary);
  for (let i = 0; i < real.length; i++) {
    const c = real[i]!;
    const pair = [c.a, c.b].sort().join();
    for (let j = i - 1; j >= 0; j--) {
      const p = real[j]!;
      if (c.t - p.t > REPEAT_WINDOW) break;
      if ([p.a, p.b].sort().join() !== pair) continue;
      compared++;
      if (similarity(c.summary, p.summary) >= REPEAT_SIM) repeats++;
      break;
    }
  }

  const resolved = threads.filter((t) => t.status === 'resolved').length;
  const touched = threads.filter((t) => t.status !== 'open').length;

  const byLabel: Record<string, { calls: number; repaired: number; failed: number; schemaMiss: number }> = {};
  let jsonCalls = 0, repaired = 0, failed = 0, schemaMiss = 0;
  for (const [label, s] of Object.entries(llmByLabel)) {
    if (!s.json) continue;
    jsonCalls += s.json; repaired += s.repairs || 0; failed += s.badJson || 0; schemaMiss += s.schemaMiss || 0;
    byLabel[label] = { calls: s.json, repaired: s.repairs || 0, failed: s.badJson || 0, schemaMiss: s.schemaMiss || 0 };
  }

  return {
    days: days.length,
    commitments: { made, kept: Math.min(kept, made), keptRate: ratio(Math.min(kept, made), made), pending },
    convos: { total: sum('convos'), fallback: sum('convoFallback'), fallbackRate: ratio(sum('convoFallback'), sum('convos')), compared, repeats, repeatRate: ratio(repeats, compared) },
    plans: { total: sum('plans'), fallback: sum('planFallback'), fallbackRate: ratio(sum('planFallback'), sum('plans')) },
    threads: { total: threads.length, advanced: touched - resolved, resolved, resolvedRate: ratio(resolved, threads.length), touchedRate: ratio(touched, threads.length) },
    json: { calls: jsonCalls, repaired, failed, schemaMiss, repairRate: ratio(repaired, jsonCalls), failRate: ratio(failed, jsonCalls), schemaMissRate: ratio(schemaMiss, jsonCalls), byLabel },
  };
}

/** Town 上的接口（转发给上面的函数） */
export class Metrics {
  metricsDay(this: Town, day = this.day): Day { return metricsDay(this.state, day); }
  noteCommitMade(this: Town, a: LiveAgent, entry: ScheduleEntry) { recordCommitMade(this.state, this.day, a.id, entry); }
  noteSettle(this: Town, a: LiveAgent, e: CurEntry) { recordSettle(this.state, this.day, a.id, e); }
  noteRun(this: Town, kind: string, fallback: boolean) { recordRun(this.state, this.day, kind, fallback); }
  metricsView(this: Town) {
    return computeMetrics({ metricsState: this.metricsState, day: this.day, minute: this.minute, convoLog: this.convoLog, threads: threadList(this), byLabel: llm.stats.byLabel });
  }
}
