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
import { localDayKey } from '../llm.js';
import { get as setting } from '../settings/index.js';

export class Ledger {
  /** @param {import('node:sqlite').DatabaseSync} db accounts.db（usage 表） */
  constructor(db, { now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
    this.day = '';
    this.byWorld = new Map(); // 当天：世界 → { total, P0..P4 }
    this.byUser = new Map();
    this.upsert = db.prepare(`INSERT INTO usage (day, world_id, user_id, class, tokens, calls) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (day, world_id, user_id, class) DO UPDATE SET tokens = tokens + excluded.tokens, calls = calls + 1`);
    this.roll();
  }

  /** 换日：从数据库读回当天的累计（重启不清零） */
  roll() {
    const d = localDayKey(this.now());
    if (d === this.day) return;
    this.day = d;
    this.byWorld.clear();
    this.byUser.clear();
    for (const r of this.db.prepare('SELECT world_id, user_id, class, SUM(tokens) AS t FROM usage WHERE day = ? GROUP BY world_id, user_id, class').all(d)) this.bump(r.world_id, r.user_id, r.class, r.t);
  }

  bump(worldId, userId, cls, tokens) {
    const w = this.byWorld.get(worldId) || { total: 0, P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
    w.total += tokens;
    w[cls] = (w[cls] || 0) + tokens;
    this.byWorld.set(worldId, w);
    if (userId) this.byUser.set(userId, (this.byUser.get(userId) || 0) + tokens);
  }

  add({ worldId, userId, cls, tokens }) {
    this.roll();
    const w = worldId || '-';
    this.bump(w, userId || null, cls, tokens);
    try { this.upsert.run(this.day, w, userId || '', cls, Math.round(tokens)); } catch (e) { console.warn('[ledger] 写入失败：', e.message); }
  }

  world(worldId) { this.roll(); return this.byWorld.get(worldId) || { total: 0, P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }; }

  /** 当天用量排行 */
  ranking() { this.roll(); return [...this.byWorld.entries()].map(([id, u]) => ({ id, ...u })).sort((a, b) => b.total - a.total); }

  /** 某个世界最近 n 天的用量（owner 页面用） */
  history(worldId, n = 7) {
    return this.db.prepare('SELECT day, class, SUM(tokens) AS tokens FROM usage WHERE world_id = ? GROUP BY day, class ORDER BY day DESC LIMIT ?').all(worldId, n * 5);
  }

  /** 某个用户在某个级别的累计（创世额度：不按天） */
  userTotal(userId, cls) { return this.db.prepare('SELECT COALESCE(SUM(tokens), 0) AS t FROM usage WHERE user_id = ? AND class = ?').get(userId, cls).t; }
}

export const LEVELS = ['normal', 'quiet', 'rules', 'exhausted'];
export const LEVEL_NAMES = { normal: '正常', quiet: '停了导演与编年', rules: '居民改用规则驱动', exhausted: '今日额度用完', paused: 'AI 已暂停' };

/**
 * @param {object} o
 * @param {Ledger} o.ledger
 * @param {(id) => object|null} o.world 世界登记项
 * @param {(world) => object|null} o.ownerGrant
 * @param {() => number} o.globalUsed 全站当日已用
 */
export function budgetPolicy({ ledger, world, ownerGrant, globalUsed }) {
  const pinned = () => new Set(setting('PINNED_WORLDS'));

  /** 一个用户世界的日额度；常驻 / 官方世界返回 Infinity（只受全局约束） */
  function worldLimit(w) {
    if (!w || w.official || pinned().has(w.id)) return Infinity;
    const base = w.quota?.dailyWorldTokens ?? ownerGrant(w)?.quota?.dailyWorldTokens ?? setting('GENESIS_DAILY_WORLD_TOKENS');
    return w.status === 'preview' ? base * 0.2 : base;
  }

  /** 用户世界共享池（全局预算减去常驻世界的保留额）已用 / 上限 */
  function pool() {
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

  /** 当前降级档位 */
  function level(worldId) {
    const w = world(worldId);
    if (w?.settings?.aiPaused) return 'paused';
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
  function allow(job) {
    const w = job.worldId && job.worldId !== '-' ? world(job.worldId) : null;
    if (w?.settings?.aiPaused) return '管理员暂停了这个世界的 AI';
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
