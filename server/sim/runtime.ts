// 状态分离（重构方案 P6 第一步）：居民的临时字段（路径、目的地、气泡、思考中、对话 id……）放在运行时对象 town.rt 里，
// 居民对象本身只剩要存档的数据。居民对象上的同名属性是不可枚举的访问器，转发到运行时对象：
// 读写照旧（a.path、a.thinking），但它们不会出现在 JSON.stringify / 对象展开里——存档不再需要排除列表，
// 以后新增临时字段只要加进 AgentRuntime 与 RUNTIME_DEFAULTS，就不会被误写进存档。
import type { AgentRuntime, LiveAgent } from '../types/agent.ts';

/** 临时字段与它们的初值（读档、新建居民时都从这里开始）；visitorChat 是旧版本的存档字段，读档时删除，不在这里 */
const RUNTIME_DEFAULTS = (): Required<Omit<AgentRuntime, 'visitorChat'>> => ({
  path: [], dest: null, hop: null, curKey: null, curEntry: null, bubble: null,
  thinking: 0, thinkingLabel: '', reflecting: false, convoId: null, chatBusy: false, pendingAct: null, actKey: null,
});
export const RUNTIME_KEYS = Object.keys(RUNTIME_DEFAULTS()) as Array<keyof ReturnType<typeof RUNTIME_DEFAULTS>>;

/** 每个世界的运行时状态（永不序列化） */
export interface TownRuntime {
  agents: Record<string, AgentRuntime>;
  /** 威胁、敌对生物主动找旅人动手的计时（秒，见 sim/combat 的 aggroTick） */
  aggroAcc?: number;
  /** 上一次普通演出的真实时间（毫秒，sim/stage 的节流） */
  stageAt?: number;
  /** 延迟补偿（sim/combat）：单位 → 最近 1 秒的 [真实毫秒, x, y] */
  posHist?: Map<string, Array<[number, number, number]>>;
  /** 冒险循环（sim/adventure）上次运行的游戏分钟 */
  advMinute?: number;
}

export const freshRuntime = (): TownRuntime => ({ agents: {} });

/** 给居民对象挂上运行时字段：数据放在 rt.agents[id]，居民对象上是不可枚举、不可删除的访问器 */
export function attachRuntime(rt: TownRuntime, a: LiveAgent): void {
  const r = (rt.agents[a.id] ||= RUNTIME_DEFAULTS()) as unknown as Record<string, unknown>;
  const obj = a as unknown as Record<string, unknown>;
  for (const k of RUNTIME_KEYS) {
    if (Object.hasOwn(obj, k)) {
      // 创建时写在对象上的初值：搬进运行时对象
      r[k] = obj[k];
      delete obj[k];
    }
    Object.defineProperty(a, k, {
      get: () => r[k],
      set: (v) => { r[k] = v; },
      enumerable: false, configurable: false,
    });
  }
}
