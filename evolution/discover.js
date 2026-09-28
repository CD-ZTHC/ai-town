// 发现需求（自主演化设计 §6.2）：从小镇导出的信号里挑下一件要做的事。优先级：
//   1. 修复被自动回滚的插件（每个插件最多修 2 次）
//   2. AI 心愿单里的能力缺口（管理员「采纳」的优先，其次按出现次数；「忽略」的不做）
//   3. 没有别的事可做时，每天最多一次，让引擎根据小镇近况自己想一个小功能（EVOLVE_IDEAS=0 关闭）
import { readJSON, loadJobs, str } from './common.js';
import { get as setting } from '../server/settings/index.ts';

const MAX_TRIES = 2;
const MAX_PENDING = 2; // 等待裁决的插件太多时先不做新的
const ADMIN_REASONS = /管理员/;

export function discover(P, { now = Date.now(), ideas = setting('EVOLVE_IDEAS') } = {}) {
  // 任务是全站的：只看这个世界的
  const jobs = loadJobs(P).filter((j) => (j.worldId || 'yunxi') === (P.world?.id || 'yunxi'));
  if (jobs.some((j) => j.status === 'running')) return null;
  const reg = readJSON(P.registry, { plugins: {} }).plugins;
  if (Object.values(reg).filter((e) => ['pending', 'approved'].includes(e.status)).length >= MAX_PENDING) return null;
  const tries = (pred) => jobs.filter((j) => pred(j.need) && !['paused'].includes(j.status)).length;

  // 1. 修复
  for (const [key, e] of Object.entries(reg)) {
    if (e.status !== 'rolledBack' || ADMIN_REASONS.test(e.reason || '')) continue;
    const id = key.split('@')[0];
    if (Object.keys(reg).some((k) => k.startsWith(`${id}@`) && k > key)) continue; // 已经有更新的版本
    if (tries((n) => n.fixId === id) >= MAX_TRIES) continue;
    return { source: 'bugfix', text: `修复插件「${e.title}」：${str(e.reason, 120)}`, fixOf: key, fixId: id, detail: e.summary };
  }

  // 2. 心愿单
  const signals = readJSON(P.signals, {});
  for (const g of signals.gaps || []) {
    const past = jobs.filter((j) => j.need?.gapKey === g.need);
    if (past.some((j) => ['running', 'submitted', 't3'].includes(j.status))) continue;
    const done = past.filter((j) => j.status !== 'paused');
    // 失败过的需求：出现次数又增加 3 次以上才再试
    if (done.length >= MAX_TRIES || (done.length && g.count < (done.at(-1).need.count || 0) + 3)) continue;
    return { source: 'gap', text: g.need, why: g.why, count: g.count, gapKey: g.need, adopted: g.adopted };
  }

  // 3. 自己想点子
  if (!ideas) return null;
  const lastIdea = jobs.filter((j) => j.need?.source === 'idea').at(-1);
  if (lastIdea && now - Date.parse(lastIdea.startedAt) < 24 * 3600_000) return null;
  const mix = (signals.logMix || []).map(([k, v]) => `${k}×${v}`).join('、');
  return { source: 'idea', text: '根据小镇的近况，设计一个能让居民生活或访客体验更有趣的小功能（优先用 T0 / T1 实现）', detail: `最近的动态构成：${mix || '（无）'}；剧情张力：${signals.tension ?? '未知'}；叙事风格：${signals.storyteller || '未知'}` };
}
