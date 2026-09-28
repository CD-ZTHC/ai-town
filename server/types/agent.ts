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
}

export interface DiaryEntry {
  day: number;
  text: string;
}

/** 旅人（按账号记）与居民的交情 */
export interface TravellerRelation {
  affinity: number;
  chats: number;
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
  lastConvoEnd: number;
  lastThoughtT: number;
  lastReflectT: number;
  visitorChats: Record<string, VisitorChatLine[]>;

  body: Body;
  inventory: Record<string, number>;
  abilities: string[];
  beliefs: Belief[];
  growth: Array<{ t: number; text: string; [k: string]: unknown }>;
  cooldowns: Record<string, number>;
  /** 已发放初始物品与能力 */
  kit: number;
  researching?: { topic: string; since: number; key: string; loc: string };

  // ---------- 黑暗叙事（docs/design/night-watch.md）----------
  alignment?: string;
  combat?: Record<string, unknown>;
  /** 负担值：负担名 → 当前值 */
  burdens?: Record<string, number>;
  hosted?: Array<{ threat: string; since: number }>;
  marks?: Array<Record<string, unknown>>;
  spokeAt?: number;
  namedAt?: number;
}

/** 只在运行时存在的字段（save() 里排除，读档时重置） */
export interface AgentRuntime {
  path: Array<{ x: number; y: number }>;
  dest: { x: number; y: number; locId?: string | null } | null;
  curKey: string | null;
  curEntry?: ScheduleEntry | null;
  bubble: { id: number; text: string; kind: 'say' | 'think' | (string & {}); until: number } | null;
  /** 正在进行的模型调用数 */
  thinking: number;
  thinkingLabel: string;
  reflecting?: boolean;
  convoId: string | null;
  chatBusy?: boolean;
  pendingAct?: unknown;
  actKey?: string | null;
  hop?: unknown;
}

/** 运行中的居民对象：迁移期间两部分仍在同一个对象上 */
export type LiveAgent = Agent & AgentRuntime;

/** 存档时排除的字段名（与 AgentRuntime 保持一致） */
export type RuntimeKey = keyof AgentRuntime;
