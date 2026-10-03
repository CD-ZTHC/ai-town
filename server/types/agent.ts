// 居民（重构方案 §8.1）：持久字段（写进存档）与运行时字段（路径、气泡、对话……，存档时排除）分开声明。
// 字段以 sim.js 的 createAgent 与 sim/persistence.js 的 save() 为准；P6 状态分离后，Agent 就是 state.agents[id]，AgentRuntime 就是 rt.agents[id]。

export type AgentKind = 'resident' | 'traveller' | 'creature';
export type AgentStatus = 'sleeping' | 'idle' | 'walking' | 'chatting' | 'acting' | 'working' | 'dead' | (string & {});
export type Dir = 'up' | 'down' | 'left' | 'right';

/** 记忆流中的一条（server/memory.js） */
export interface Memory {
  id: string;
  /** 游戏分钟 */
  t: number;
  type: 'obs' | 'reflect' | 'summary' | 'diary' | 'chat' | 'plan' | (string & {});
  text: string;
  importance: number;
  /** summary：压缩的是哪一天、多少条 */
  day?: number;
  count?: number;
}

export interface Relation {
  /** 好感 -100~100 */
  affinity: number;
  note: string;
}

export interface Belief {
  about: string;
  claim: string;
  /** 0~1 */
  confidence: number;
  source: string;
  t: number;
}

export interface Body {
  hp: number;
  stamina: number;
  courage: number;
  conditions: string[];
}

export interface Look {
  skin: string;
  hair: string;
  hairStyle: string;
  shirt: string;
  pants: string;
  acc?: string[];
}

export interface ScheduleEntry {
  /** 游戏分钟（当天） */
  start: number;
  end: number;
  location: string;
  activity: string;
  emoji?: string;
  src?: string;
  /** 这条日程要做的行动（sim/actions） */
  act?: import('./town.ts').Act;
  [k: string]: unknown;
}

/** 约定（对话、群戏、剧情里约好的事）：几点去哪里做什么；由 addCommitment 写进日程。来自模型时字段未经校验 */
export interface Commitment {
  time: string;
  location: string;
  activity: string;
  emoji?: string;
  /** 游戏分钟，默认 60 */
  duration?: number;
  act?: import('./town.ts').Act;
  [k: string]: unknown;
}

/** 此刻该做的事（sim/movement 的 desired）：日程里的一条，或者睡觉、起床、闲逛这类兜底 */
export interface CurEntry {
  key: string;
  location: string;
  activity: string;
  emoji?: string;
  sleep?: boolean;
  start?: number;
  end?: number;
  act?: import('./town.ts').Act;
  [k: string]: unknown;
}

export interface DiaryEntry {
  day: number;
  text: string;
}

/** 旅人（按账号记）与居民的交情 */
export interface TravellerRelation {
  affinity: number;
  chats: number;
  /** 第一次、最近一次见面的游戏分钟 */
  met?: number;
  last?: number;
}

export interface VisitorChatLine {
  from: string;
  text: string;
  t?: number;
}

/** 写进存档的居民字段 */
export interface Agent {
  id: string;
  name: string;
  age: number;
  role: string;
  persona: string;
  goal: string;
  todayGoal?: string;
  look: Look;
  tier?: string;
  kind: AgentKind;
  home: string;
  work: string;

  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  /** 所在建筑（室内）；室外为 null */
  inside: string | null;
  locId: string | null;
  region: string;
  status: AgentStatus;
  prevStatus?: AgentStatus;
  action: { text: string; emoji: string };
  thought: string;
  mood: { text: string; emoji: string };

  schedule: ScheduleEntry[];
  scheduleDay: number;
  memories: Memory[];
  relations: Record<string, Relation>;
  travellers?: Record<string, TravellerRelation>;
  diary: DiaryEntry[];
  diaryDay: number;
  importanceAcc: number;
  /** 记忆 id 的计数（见 memory.ts） */
  memSeq?: number;
  lastConvoEnd: number;
  lastThoughtT: number;
  lastReflectT: number;
  visitorChats: Record<string, VisitorChatLine[]>;

  body: Body;
  inventory: Record<string, number>;
  abilities: string[];
  beliefs: Belief[];
  /** 经历带来的变化（基础人设以世界规格为准） */
  growth: Array<{ day: number; change: string; [k: string]: unknown }>;
  cooldowns: Record<string, number>;
  /** 已发放初始物品与能力 */
  kit: number;
  researching?: { topic: string; since: number; key: string; loc: string | null } | null;

  // ---------- 黑暗叙事（docs/design/night-watch.md）----------
  alignment?: string;
  combat?: { atk?: number; def?: number; spd?: number };
  /** 负担值：负担名 → 当前值 */
  burdens?: Record<string, number>;
  hosted?: Array<{ threat: string; since: number }>;
  /** 身上的标记：哪个威胁、何时标上、何时应验、征兆 */
  marks?: Array<{ threat: string; type: string; t: number; due: number; sign: string }>;
  spokeAt?: number;
  namedAt?: number;
  /** 最近一次开门进屋的时刻 */
  openedAt?: number;
  /** 被关押：谁关的、从什么时候到什么时候、关在哪 */
  captive?: { by: string; since: number; until: number; at: string } | null;
  /** 正保持着的禁忌姿态 */
  posture?: { holds: string[]; until: number } | null;
  /** 正在收容的威胁 */
  containing?: { inst: string; until: number; started: number } | null;
  /** 负担值冻结到什么时候：负担名 → 游戏分钟 */
  burdenFreeze?: Record<string, number>;
  /** 反派的压力值 */
  pressure?: Record<string, number>;
  /** 去过的其他区域 */
  visited?: string[];
}

/** 只在运行时存在的字段（save() 里排除，读档时重置） */
export interface AgentRuntime {
  path: Array<{ x: number; y: number }>;
  /** 正在前往的位置；hop 表示先走到通往另一个区域的路口 */
  dest: { x: number; y: number; locId: string | null; indoor: string | null; hop?: boolean } | null;
  /** 跨区域时下一段：去哪个区域、最终的地点、在那边从哪里出现 */
  hop?: { to: string; locId: string; arrive?: { x: number; y: number } | null } | null;
  curKey: string | null;
  curEntry?: CurEntry | null;
  bubble: { id: number; text: string; kind: 'say' | 'think' | (string & {}); until: number } | null;
  /** 正在进行的模型调用数 */
  thinking: number;
  thinkingLabel: string;
  reflecting?: boolean;
  convoId: string | null;
  chatBusy?: boolean;
  /** 对象还没到场的行动：每 10 游戏分钟重试一次 */
  pendingAct?: { key: string; next: number; tries: number } | null;
  actKey?: string | null;
  /** 旧版本的字段（读档时删除） */
  visitorChat?: unknown;
}

/** 运行中的居民对象：迁移期间两部分仍在同一个对象上 */
export type LiveAgent = Agent & AgentRuntime;

/** 存档时排除的字段名（与 AgentRuntime 保持一致） */
export type RuntimeKey = keyof AgentRuntime;
