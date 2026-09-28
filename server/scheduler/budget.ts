// 账本与分层预算（多世界设计 §7.4）
//
//   LLM_DAILY_TOKENS（全局）
//    ├─ 常驻世界保留额（PINNED_WORLDS 共享，默认占 30%）
//    ├─ 用户世界共享池
//    │    └─ 单个世界：min(授予的 dailyWorldTokens, 共享池剩余)；预览中的世界只有 20%
//    ├─ 创世：从创世者的 genesisTokens 扣（一次性额度，见 genesis/）
//    └─ 进化：每个开启进化的世界各有 EVOLVE_BUDGET
//
// 某个世界当日额度用到 80% 先停 P2（导演、编年），用完把 P1 退回规则驱动（调用失败，走现有兜底），
// P0 仍然可用但只多给 20%。全局预算吃紧（>90%）时，预览中的世界只保留 P0。管理员可以对单个世界「暂停 AI」。
//
// 世界自带的模型服务（job.billing === 'own'，world-llm 设计 §5.3）：不占上面任何一项站点额度，
// 只受世界自己设的每日上限约束（0 = 不限），降级档位照搬（分母换成自己的上限）。
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { localDayKey } from '../llm.ts';
import { get as setting } from '../settings/index.ts';
import type { Job, LlmClass } from '../types/scheduler.ts';

export type Billing = 'server' | 'own';
/** 一个世界当天的用量：合计与各级别 */
export type Usage = { total: number } & Record<LlmClass, number>;
const emptyUsage = (): Usage => ({ total: 0, P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 });

/** 预算判断需要的世界登记项字段（worlds/registry.ts） */
export interface BudgetWorld {
  id: string;
  official?: boolean;
  status?: string;
  quota?: { dailyWorldTokens?: number };
  settings?: { aiPaused?: boolean };
}

/** 调度任务上的计费来源（world-llm 设计 §5.3） */
type BudgetJob = Job & { billing?: Billing };

export class Ledger {
  db: DatabaseSync;
  now: () => Date;
  day = '';
  /** 当天：世界 → 用量（只算服务器通道：全站与世界的站点额度） */
  byWorld = new Map<string, Usage>();
  /** 当天：世界 → 用量（世界自带的模型服务，不占站点额度） */
  byOwn = new Map<string, Usage>();
  byUser = new Map<string, number>();
  upsert: StatementSync;

  /** @param db accounts.db（usage 表） */
  constructor(db: DatabaseSync, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.db = db;
    this.now = now;
    this.upsert = db.prepare(`INSERT INTO usage (day, world_id, user_id, class, billing, tokens, calls) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (day, world_id, user_id, class, billing) DO UPDATE SET tokens = tokens + excluded.tokens, calls = calls + 1`);
    this.roll();
  }

  /** 换日：从数据库读回当天的累计（重启不清零） */
  roll(): void {
    const d = localDayKey(this.now());
    if (d === this.day) return;
    this.day = d;
    this.byWorld.clear();
    this.byOwn.clear();
    this.byUser.clear();
    const rows = this.db.prepare('SELECT world_id, user_id, class, billing, SUM(tokens) AS t FROM usage WHERE day = ? GROUP BY world_id, user_id, class, billing').all(d) as Array<{ world_id: string; user_id: string; class: LlmClass; billing: Billing; t: number }>;
    for (const r of rows) this.bump(r.world_id, r.user_id, r.class, r.t, r.billing);
  }

  bump(worldId: string, userId: string | null, cls: LlmClass, tokens: number, billing: Billing = 'server'): void {
    const map = billing === 'own' ? this.byOwn : this.byWorld;
    const w = map.get(worldId) || emptyUsage();
    w.total += tokens;
    w[cls] = (w[cls] || 0) + tokens;
    map.set(worldId, w);
    if (userId && billing !== 'own') this.byUser.set(userId, (this.byUser.get(userId) || 0) + tokens);
  }

  add({ worldId, userId, cls, tokens, billing = 'server' }: { worldId?: string | null; userId?: string | null; cls: LlmClass; tokens: number; billing?: Billing }): void {
    this.roll();
    const w = worldId || '-';
    const b = billing === 'own' ? 'own' : 'server';
    this.bump(w, userId || null, cls, tokens, b);
    try { this.upsert.run(this.day, w, userId || '', cls, b, Math.round(tokens)); } catch (e) { console.warn('[ledger] 写入失败：', (e as Error).message); }
  }

  /** 当天用了多少站点额度（服务器通道） */
  world(worldId: string): Usage { this.roll(); return this.byWorld.get(worldId) || emptyUsage(); }

  /** 当天用了多少自带的模型服务 */
  own(worldId: string): Usage { this.roll(); return this.byOwn.get(worldId) || emptyUsage(); }

  /** 当天用量排行 */
  ranking(): Array<Usage & { id: string }> { this.roll(); return [...this.byWorld.entries()].map(([id, u]) => ({ id, ...u })).sort((a, b) => b.total - a.total); }

  /** 某个世界最近 n 天的用量（owner 页面用）：{ day, class, billing, tokens } */
  history(worldId: string, n = 7): Array<{ day: string; class: LlmClass; billing: Billing; tokens: number }> {
    return this.db.prepare('SELECT day, class, billing, SUM(tokens) AS tokens FROM usage WHERE world_id = ? GROUP BY day, class, billing ORDER BY day DESC LIMIT ?').all(worldId, n * 10) as Array<{ day: string; class: LlmClass; billing: Billing; tokens: number }>;
  }

  /** 某个用户在某个级别用掉的站点额度累计（创世额度：不按天；自带的模型服务不算） */
  userTotal(userId: string, cls: LlmClass): number { return (this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM usage WHERE user_id = ? AND class = ? AND billing = 'server'").get(userId, cls) as { t: number }).t; }
}

export const LEVELS = ['normal', 'quiet', 'rules', 'exhausted'] as const;
/** 降级档位；paused 是管理员暂停了这个世界的 AI */
export type Level = (typeof LEVELS)[number] | 'paused';
export const LEVEL_NAMES: Record<Level, string> = { normal: '正常', quiet: '停了导演与编年', rules: '居民改用规则驱动', exhausted: '今日额度用完', paused: 'AI 已暂停' };

export interface BudgetPolicyOptions {
  ledger: Ledger;
  /** 世界登记项 */
  world: (id: string) => BudgetWorld | null | undefined;
  /** 世界主人被授予的额度 */
  ownerGrant: (world: BudgetWorld) => { quota?: { dailyWorldTokens?: number } } | null | undefined;
  /** 全站当日已用 */
  globalUsed: () => number;
  /** 世界用自己的模型服务时的每日上限（0 = 不限）；不是自带时返回 null */
  ownLimit?: (worldId: string) => number | null | undefined;
}

export function budgetPolicy({ ledger, world, ownerGrant, globalUsed, ownLimit = () => null }: BudgetPolicyOptions) {
  const pinned = () => new Set(setting('PINNED_WORLDS'));

  /** 一个用户世界的日额度；常驻 / 官方世界返回 Infinity（只受全局约束） */
  function worldLimit(w: BudgetWorld | null | undefined): number {
    if (!w || w.official || pinned().has(w.id)) return Infinity;
    const base = w.quota?.dailyWorldTokens ?? ownerGrant(w)?.quota?.dailyWorldTokens ?? setting('GENESIS_DAILY_WORLD_TOKENS');
    return w.status === 'preview' ? base * 0.2 : base;
  }

  /** 用户世界共享池（全局预算减去常驻世界的保留额）已用 / 上限 */
  function pool(): { left: number; pinnedUsed?: number; userUsed?: number; total?: number } {
    const total = setting('LLM_DAILY_TOKENS');
    if (!total) return { left: Infinity };
    const pins = pinned();
    let userUsed = 0, pinnedUsed = 0;
    for (const r of ledger.ranking()) {
      const w = world(r.id);
      const isPinned = !w || w.official || pins.has(r.id);
      if (isPinned) pinnedUsed += r.total - r.P3 - r.P4; else userUsed += r.total - r.P3 - r.P4;
    }
    const reserve = total * setting('PINNED_BUDGET_SHARE');
    // 常驻世界没用完的保留额不给用户世界；用户世界的池子 = 总额 - 保留额
    return { left: total - reserve - userUsed, pinnedUsed, userUsed, total };
  }

  /** 自带模型服务的降级档位：只看自己设的上限 */
  function ownLevel(worldId: string, cap: number): Level {
    if (!cap) return 'normal';
    const ratio = ledger.own(worldId).total / cap;
    return ratio >= 1.2 ? 'exhausted' : ratio >= 1 ? 'rules' : ratio >= 0.8 ? 'quiet' : 'normal';
  }

  /** 当前降级档位 */
  function level(worldId: string): Level {
    const w = world(worldId);
    if (w?.settings?.aiPaused) return 'paused';
    const cap = ownLimit(worldId);
    if (cap !== null && cap !== undefined) return ownLevel(worldId, cap);
    const lim = worldLimit(w);
    if (!Number.isFinite(lim)) return 'normal';
    const used = ledger.world(worldId);
    const spent = used.total - used.P3 - used.P4;
    const ratio = lim > 0 ? spent / lim : Infinity;
    const p = pool();
    if (ratio >= 1.2 || p.left <= -lim * 0.2) return 'exhausted';
    if (ratio >= 1 || p.left <= 0) return 'rules';
    if (ratio >= 0.8) return 'quiet';
    return 'normal';
  }

  /** 调度器出队前的检查：true 或拒绝理由 */
  function allow(job: BudgetJob): true | string {
    const w = job.worldId && job.worldId !== '-' ? world(job.worldId) : null;
    if (w?.settings?.aiPaused) return '管理员暂停了这个世界的 AI';
    if (job.billing === 'own') {
      const lv = ownLevel(job.worldId, ownLimit(job.worldId) || 0);
      if (lv === 'exhausted') return '这个世界今天用自己模型服务的上限到了';
      if (lv === 'rules' && job.cls !== 'P0') return '这个世界今天用自己模型服务的上限到了，居民改用规则驱动';
      if (lv === 'quiet' && (job.cls === 'P2' || job.cls === 'P4')) return '这个世界今天的上限快到了，暂停导演与编年';
      return true;
    }
    if (job.cls === 'P3') return true; // 创世额度由创世任务自己检查（按创世者的 genesisTokens）
    if (job.cls === 'P4') {
      const lim = setting('EVOLVE_BUDGET');
      return !lim || ledger.world(job.worldId || '-').P4 < lim ? true : '今天这个世界的进化预算用完了';
    }
    // 全局吃紧：预览中的世界只保留 P0
    const total = setting('LLM_DAILY_TOKENS');
    if (w?.status === 'preview' && total && globalUsed() > total * 0.9 && job.cls !== 'P0') return '全站额度吃紧，预览中的世界暂停 AI';
    const lv = level(job.worldId);
    if (lv === 'exhausted') return '这个世界今天的 AI 额度用完了';
    if (lv === 'rules' && job.cls !== 'P0') return '这个世界今天的 AI 额度用完了，居民改用规则驱动';
    if (lv === 'quiet' && job.cls === 'P2') return '这个世界今天的额度快用完了，暂停导演与编年';
    return true;
  }

  return { allow, level, worldLimit, pool };
}
