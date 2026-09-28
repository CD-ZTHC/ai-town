// Town 的类型占位（重构方案 §8.2）：sim.js 与各个职责模块要到 B5 才迁移，在那之前内核模块里凡是拿到 Town 的地方都用 TownLike。
// B5 完成后把它换成 `import type { Town } from '../sim.ts'`，编译器会指出所有需要补的地方。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TownLike = any; // TODO(types): B5 迁移 sim.js 后换成 Town

/** 效果、规则、能力里「一个居民」的最小形状（运行中的居民对象，见 types/agent.ts 的 LiveAgent） */
export type { LiveAgent as AgentLike } from './agent.ts';

/** 进行中的对话（Town.convos） */
export interface Convo {
  id: string;
  a: string;
  b: string;
  where: string;
  /** 开始的游戏分钟 */
  t: number;
  lines: Array<{ speaker: string; text: string }>;
  /** thinking：等模型写台词；talking：正在说 */
  state: 'thinking' | 'talking' | (string & {});
  summary?: string;
  commitments?: string[];
  [k: string]: unknown;
}

/** Town 的构造选项 */
export interface TownOptions {
  /** 存档目录（默认 DATA_DIR，测试时指向临时目录） */
  dataDir?: string;
  /** 对话台词不等待真实时间（无头测试用） */
  instantTalk?: boolean;
  pacing?: boolean;
  /** 测试可注入：本世界在模型队列里的积压 */
  queueSize?: (() => number) | null;
  embedder?: import('../embeddings.ts').Embedder | null;
  worldId?: string;
  /** 世界包；不传时是官方世界云溪镇 */
  pack?: { hash: string; [k: string]: unknown } | null;
  /** 世界级设置（分级、叙事者、Mod、死亡预算……） */
  worldSettings?: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  mods?: string[];
  modsDir?: string;
  /** AI 插件（自主演化）的目录等 */
  evolution?: Record<string, unknown>;
  now?: () => number;
  random?: () => number;
  /** 不加载的内置插件 id（测试或排查用） */
  disablePlugins?: string[];
}

/** 日程里的行动（模型规划出来的 act，由 sim/actions 的 normalizeAct 规范化后执行） */
export interface Act {
  type?: string;
  [k: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- 各类行动的参数不同，由 normalizeAct 逐项检查
}
/** 行动处理函数收到的参数（attack / steal / giveItem ……） */
export type ActArgs = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 一个游戏日的 AI 表现指标（sim/metrics）；keptKeys / pending 只在当天保留，过去的日子只留计数 */
export interface MetricsDay {
  commitsMade: number;
  commitsKept: number;
  keptKeys?: string[];
  pending?: Array<{ key: string; end: number }>;
  plans: number;
  planFallback: number;
  convos: number;
  convoFallback: number;
}

/** 一场战斗（sim/combat） */
export type Fight = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- TODO(types): 战斗记录的结构

/** 存档（读档时的原始数据，字段可能缺失或来自旧版本） */
export type SaveData = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- 结构见 types/save.ts 的 SaveV2，load() 逐项兜底

/** 一处正在发生的怪事（黑暗叙事的事件） */
export type Incident = { id: string; loc: string; stage: string; assigned: string[]; threat?: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- TODO(types): B6（story/threats）

/** 黑暗叙事的运行状态（story/threats.js 的 freshDark；存档字段 dark） */
export interface DarkState {
  seq: number;
  threats: ThreatInstance[];
  sounds: Array<{ id: string; x: number; y: number; r: number; t: number; region?: string; [k: string]: unknown }>;
  zones: Array<{ threat: string; x: number; y: number; r: number; region?: string; [k: string]: unknown }>;
  incidents: Incident[];
  contained: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- TODO(types): B6
  /** 地点 → 活着 / 死去的群众 */
  population: Record<string, { alive: number; dead: number }>;
  deaths: Array<{ t: number; [k: string]: unknown }>;
  crowd: Array<{ t: number; day: number; loc: string | null; n: number; cause: string }>;
  graves: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- TODO(types): B6
  lastMinute: number;
  lastHour: number;
  lastDay: number;
  /** 阵营配给的上次发放时间 */
  stipendAt?: Record<string, number>;
  [k: string]: unknown;
}

/** 运行中的威胁实例（story/threats.js） */
export type ThreatInstance = { id: string; type: string; x: number; y: number; region?: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- TODO(types): B6
