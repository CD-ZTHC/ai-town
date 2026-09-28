// 内核模块（kernel/）拿到的小镇：B2 迁移时 sim.js 还没有类型，先用这个名字占位，B5 之后就是 Town
export type TownLike = import('../sim.ts').Town;

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

/** 一处正在发生的怪事（黑暗叙事设计 §4.7） */
export interface Incident {
  id: string;
  /** 威胁实例的 id 与类型 */
  threat: string;
  type: string;
  loc: string;
  stage: 'omen' | 'outbreak' | 'spread' | 'handled' | 'abandoned' | 'aftermath' | (string & {});
  /** 开始、最近一次有人处理的游戏日 */
  day: number;
  touched: number;
  since: number;
  victims: number;
  crowd: number;
  level: number;
  /** 派去处理的人 */
  assigned: string[];
  cause: string;
  outcome?: string;
}

/** 黑暗叙事的运行状态（story/threats.js 的 freshDark；存档字段 dark） */
export interface DarkState {
  seq: number;
  threats: ThreatInstance[];
  sounds: Array<{ id: string; x: number; y: number; r: number; t: number; region: string; src: string }>;
  /** 威胁的区域（dark 地图上的色块） */
  zones: Array<{ id: string; threat: string; x: number; y: number; r: number; region: string; tint: string; replay: string | null; born: number }>;
  incidents: Incident[];
  /** 收容起来的威胁：谁保管、装在什么里、每天的泄漏概率 */
  contained: Array<{ type: string; holder: string; since: number; leak: number; item: string }>;
  /** 地点 → 活着 / 死去的群众 */
  population: Record<string, { alive: number; dead: number }>;
  deaths: Array<{ id: string; name: string; t: number; day: number; cause: string; text: string; loc: string | null }>;
  crowd: Array<{ t: number; day: number; loc: string | null; n: number; cause: string }>;
  graves: Array<{ id: string; name: string; x: number; y: number; region: string; t: number; day: number }>;
  lastMinute: number;
  lastHour: number;
  lastDay: number;
  /** 阵营配给的上次发放时间 */
  stipendAt?: Record<string, number>;
  /** 初始事件是否已经放出 */
  seeded?: boolean;
  /** 最近一次没有事件的游戏日 */
  quietSince?: number;
  [k: string]: unknown;
}

/** 运行中的威胁实例（story/threats） */
export interface ThreatInstance {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  region: string;
  path: Array<{ x: number; y: number }>;
  state: 'roam' | 'dwell' | 'rest' | 'contained' | 'gone' | (string & {});
  /** 会死的威胁才有 */
  hp: number | null;
  born: number;
  restUntil: number;
  dwellUntil: number;
  suppressedUntil: number;
  /** 声音 id → 上次发出的时刻 */
  sounds: Record<string, number>;
  crowdAt: number;
  incident?: string;
  fleeing?: boolean;
  /** 被放弃的区域里只在区域内活动 */
  confined?: boolean;
  patrol?: string[] | number;
  target?: string | null;
  [k: string]: unknown;
}
