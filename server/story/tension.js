// 张力模型（设计文档 5.2）：不调用 LLM，每游戏小时计算一次。
// T = 35×威胁 + 20×冲突 + 20×悬念 + 15×匮乏 + 10×氛围，范围 0~100。
import { activeEvents } from '../kernel/spec.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const PORTAL_THREAT = { crack: 0.15, open: 0.55, wide: 0.9, stable: 0.05, sealed: 0 };

export function computeTension(town) {
  const people = town.agents.filter((a) => a.kind !== 'creature');
  const hostile = town.creatures.list.filter((c) => !c.friendly && !c.hidden).length;
  const threat = clamp01(hostile / 10 + (PORTAL_THREAT[town.creatures.portal?.stage] || 0));

  let negative = 0, pairs = 0;
  for (const a of people) for (const r of Object.values(a.relations)) { pairs++; if (r.affinity < 0) negative++; }
  const scared = people.filter((a) => a.body.conditions.some((c) => c === '受惊' || c === '晕倒')).length;
  const conflict = clamp01((pairs ? negative / pairs : 0) * 3 + scared / Math.max(1, people.length));

  const threads = town.spec.threads;
  const open = threads.filter((t) => (town.threadState[t.id]?.status || 'open') !== 'resolved').length;
  const arc = town.arcs.active();
  const mystery = clamp01((threads.length ? (open / threads.length) * 0.6 : 0) + (arc?.phase === 'omen' ? 0.4 : 0));

  const stamina = people.reduce((s, a) => s + a.body.stamina, 0) / Math.max(1, people.length);
  const scarcity = clamp01((1 - stamina / 100) * 0.5 + (1 - town.crisis.supplies / 100) * 0.5);

  const ambience = clamp01((activeEvents(town.spec, town.day, town.minute).length ? 0.5 : 0) + (['storm', 'fog', 'bloodmoon'].includes(town.weather) ? 0.5 : 0));

  const parts = { threat, conflict, mystery, scarcity, ambience };
  const value = Math.round(35 * threat + 20 * conflict + 20 * mystery + 15 * scarcity + 10 * ambience);
  return { value, parts };
}

// 三种叙事者的目标曲线
const VOYAGE = [20, 28, 36, 60, 55, 68, 30]; // 一季 7 天：伏笔 → 爆发 → 高潮 → 回落
export function targetTension(town) {
  const st = town.spec.meta.storyteller;
  const hour = town.minute / 60;
  const night = hour < 7 || hour > 22 ? -5 : 0;
  if (st === 'voyage') return VOYAGE[(town.day - 1) % 7] + night;
  if (st === 'chaos') {
    // 每 6 小时换一个伪随机目标（同一时段内稳定）
    const k = Math.floor(town.t / 360);
    const r = Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1;
    return Math.round(15 + r * 65);
  }
  // gentle：日常为主，每三天一次小波澜
  return (town.day % 3 === 0 && hour > 13 && hour < 20 ? 40 : 22) + night;
}

export const BOREDOM_HOURS = { gentle: 8, voyage: 5, chaos: 3 };
