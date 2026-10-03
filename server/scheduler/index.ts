// 统一 AI 调度器（多世界设计 §7.3）：所有世界的居民、导演、日报、审核，以及创世、进化，全部经过这一个队列。
//
// 每当有并发空位：
//   按 P0 → P4 的顺序找第一个可以出队的级别；在这个级别内按世界轮转（加权），跳过当日额度已用完的世界
// 保留规则：
//   - 至少 1 个并发留给 P0（总并发为 1 时除外）
//   - P3、P4 合计最多占 1 个并发，而且只在 P1 队列为空时才占
//   - 防饿死：P3 / P4 任务等待超过 PRIORITY_AGING_MIN 后，每 10 次出队保底 1 次
//   - 公平补偿：连续让路（导演看到队列忙就不做决策）N 次的世界，下次出队权重翻倍
//   - 单个世界最多同时占 L-2 个并发（L≥3；L=2 时 1 个）——只在别的世界也有任务排队时生效，
//     保证一个世界刷聊天时，别的世界的心跳仍然有空位（没有别的世界时不限制，不浪费容量）
import { CLASSES } from './classes.ts';
import type { AllowFn, Job, LlmClass } from '../types/scheduler.ts';

type PerClass<T> = Record<LlmClass, T>;
const perClass = <T>(f: () => T): PerClass<T> => Object.fromEntries(CLASSES.map((c) => [c, f()])) as PerClass<T>;

const YIELD_BOOST = 3;
const AGING_EVERY = 10;
const NO_WORLD = '-';

export interface SchedulerOptions {
  /** 当前并发上限 */
  limit: () => number;
  /** 防饿死阈值（毫秒） */
  agingMs?: () => number;
  /** 出队前的额度检查（按世界、按级别）；返回理由则拒绝这个任务 */
  allow?: AllowFn;
  now?: () => number;
}

export interface ClassView {
  cls: LlmClass;
  queued: number;
  inflight: number;
  oldestMs: number;
  avgWaitMs: number;
  byWorld: Record<string, number>;
}

export class Scheduler {
  limit: () => number;
  agingMs: () => number;
  allow: AllowFn;
  now: () => number;
  /** 级别 → 世界 → 任务[] */
  queues: PerClass<Map<string, Job[]>>;
  /** 级别内的世界轮转顺序 */
  rr: PerClass<string[]>;
  /** 级别|世界 → 本轮还能连续出队的次数（加权轮转） */
  credit = new Map<string, number>();
  inflight: PerClass<number>;
  inflightByWorld = new Map<string, number>();
  yields = new Map<string, number>();
  dequeues = 0;
  /** 出队时的等待时间（观测用） */
  waits: PerClass<{ n: number; ms: number }>;

  constructor({ limit, agingMs = () => 30 * 60_000, allow = () => true, now = () => Date.now() }: SchedulerOptions) {
    this.limit = limit;
    this.agingMs = agingMs;
    this.allow = allow;
    this.now = now;
    this.queues = perClass(() => new Map());
    this.rr = perClass((): string[] => []);
    this.inflight = perClass(() => 0);
    this.waits = perClass(() => ({ n: 0, ms: 0 }));
  }

  /** 放进队列 */
  push(job: Job): void {
    job.worldId ||= NO_WORLD;
    job.at = this.now();
    const q = this.queues[job.cls];
    let list = q.get(job.worldId);
    if (!list) { list = []; q.set(job.worldId, list); this.rr[job.cls].push(job.worldId); }
    // 同一世界同一级别内：先来先到（front 表示插队到本世界该级别的最前面）
    job.front ? list.unshift(job) : list.push(job);
  }

  queued(cls: LlmClass | null = null, worldId: string | null = null): number {
    let n = 0;
    for (const c of cls ? [cls] : CLASSES) {
      for (const [w, list] of this.queues[c]) if (!worldId || w === worldId) n += list.length;
    }
    return n;
  }

  totalInflight(): number { return CLASSES.reduce((s, c) => s + this.inflight[c], 0); }

  /** 某个世界的积压（排队 + 进行中）：按世界调速用 */
  backlog(worldId: string): number { return this.queued(null, worldId) + (this.inflightByWorld.get(worldId) || 0); }

  /** 导演等调用点看到队列忙而让路时记一次；连续让路多的世界下次出队权重翻倍 */
  noteYield(worldId: string | null | undefined): void { if (worldId) this.yields.set(worldId, (this.yields.get(worldId) || 0) + 1); }

  /** 取出下一个可以运行的任务（没有则返回 null）；被额度拒绝的任务会直接 reject */
  next(): Job | null {
    const L = Math.max(1, this.limit());
    const I = this.totalInflight();
    if (I >= L) return null;
    const reserveForP0 = L > 1 && I >= L - 1; // 只剩最后一个空位：留给 P0
    const bgBusy = this.inflight.P3 + this.inflight.P4 > 0;
    // 防饿死：每 AGING_EVERY 次出队，给等太久的 P3 / P4 一次机会（仍然不占 P0 的保留位）
    if (!reserveForP0 && !bgBusy && this.dequeues % AGING_EVERY === AGING_EVERY - 1) {
      for (const cls of ['P3', 'P4'] as const) {
        const j = this.take(cls, (job) => this.now() - (job.at ?? 0) > this.agingMs());
        if (j) return j;
      }
    }
    for (const cls of CLASSES) {
      if (cls !== 'P0' && reserveForP0) break;
      if ((cls === 'P3' || cls === 'P4') && (bgBusy || this.queued('P1') > 0)) continue;
      const j = this.take(cls);
      if (j) return j;
    }
    return null;
  }

  /** 在一个级别内按世界轮转取任务；filter 只取满足条件的任务 */
  take(cls: LlmClass, filter: ((job: Job) => boolean) | null = null): Job | null {
    const order = this.rr[cls];
    const q = this.queues[cls];
    let visited = 0;
    while (order.length && visited < order.length) {
      const w = order[0];
      const list = q.get(w);
      if (!list?.length) { order.shift(); q.delete(w); this.credit.delete(`${cls}|${w}`); continue; }
      const idx = filter ? list.findIndex(filter) : 0;
      if (idx < 0 || this.overCap(w)) { order.push(order.shift()!); visited++; continue; }
      const job = list[idx];
      list.splice(idx, 1);
      const ok = this.allow(job);
      if (ok !== true) {
        // 这个世界当日额度用完：拒绝这个任务（调用方退回规则驱动），接着看同一世界的下一个
        job.reject(Object.assign(new Error(ok), { code: 'BUDGET', status: 429 }));
        continue;
      }
      // 加权轮转：连续让路多的世界可以连续出队两次，之后轮到下一个世界
      const key = `${cls}|${w}`;
      const boosted = (this.yields.get(w) || 0) >= YIELD_BOOST;
      const credit = (this.credit.get(key) ?? (boosted ? 2 : 1)) - 1;
      if (credit > 0 && list.length) this.credit.set(key, credit);
      else {
        this.credit.delete(key);
        order.push(order.shift()!);
        if (boosted) this.yields.set(w, 0);
      }
      if (!list.length) { q.delete(w); const i = order.indexOf(w); if (i >= 0) order.splice(i, 1); }
      this.dequeues++;
      const wt = this.waits[cls];
      wt.n++; wt.ms += this.now() - (job.at ?? this.now());
      return job;
    }
    return null;
  }

  /** 这个世界是否已经占满了它能占的并发（只在别的世界也有任务排队时限制） */
  overCap(w: string): boolean {
    const L = Math.max(1, this.limit());
    const cap = L >= 3 ? L - 2 : Math.max(1, L - 1);
    if ((this.inflightByWorld.get(w) || 0) < cap) return false;
    for (const c of CLASSES) for (const [ow, list] of this.queues[c]) if (ow !== w && list.length) return true;
    return false;
  }

  /** 拒绝并移除满足条件的排队任务（世界暂停、通道回收时） */
  drop(filter: (job: Job) => boolean, err: Error): number {
    let n = 0;
    for (const cls of CLASSES) {
      for (const [w, list] of this.queues[cls]) {
        const keep: Job[] = [];
        for (const job of list) {
          if (filter(job)) { n++; try { job.reject(err); } catch { /* 忽略 */ } } else keep.push(job);
        }
        this.queues[cls].set(w, keep);
      }
    }
    return n;
  }

  started(job: Job): void {
    this.inflight[job.cls]++;
    this.inflightByWorld.set(job.worldId, (this.inflightByWorld.get(job.worldId) || 0) + 1);
  }

  finished(job: Job): void {
    this.inflight[job.cls]--;
    const n = (this.inflightByWorld.get(job.worldId) || 1) - 1;
    n > 0 ? this.inflightByWorld.set(job.worldId, n) : this.inflightByWorld.delete(job.worldId);
  }

  /** 调度面板：各级别的队列长度、最老任务的等待时间、平均等待、进行中 */
  view(): ClassView[] {
    const now = this.now();
    return CLASSES.map((cls) => {
      let queued = 0, oldest = 0;
      const byWorld: Record<string, number> = {};
      for (const [w, list] of this.queues[cls]) {
        queued += list.length;
        if (list.length) { byWorld[w] = list.length; oldest = Math.max(oldest, now - Math.min(...list.map((j) => j.at ?? now))); }
      }
      const wt = this.waits[cls];
      return { cls, queued, inflight: this.inflight[cls], oldestMs: oldest, avgWaitMs: wt.n ? Math.round(wt.ms / wt.n) : 0, byWorld };
    });
  }
}
