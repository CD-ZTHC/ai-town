// 存档结构（重构方案 §8.1）：照 server/sim/persistence.js 的 save() 当前字段整理，是 P6 状态分离（TownState 的 zod schema）的起点。
// 子系统自己的状态（剧情、提案、决策……）结构较大，先用 unknown，迁移到对应子系统时再细化。
import type { Agent } from './agent.ts';
import type { OpRecord } from './ops.ts';

export type SaveVersion = 2;

export interface LogItem {
  id: number;
  /** 游戏分钟 */
  t: number;
  type: string;
  text: string;
  [extra: string]: unknown;
}

export interface Entity {
  id: string;
  type: string;
  emoji: string;
  name: string;
  x: number;
  y: number;
  inside: string | null;
  region?: string;
  light?: { r: number; color: string } | null;
  until?: number;
  tags?: string[];
  [k: string]: unknown;
}

export interface ConvoRecord {
  id: string;
  a: string;
  b: string;
  t: number;
  where?: string;
  summary: string;
  lines: Array<{ speaker: string; text: string }>;
  commitments?: string[];
  [k: string]: unknown;
}

/** 每晚的编年（日报 / 公告 / 歌谣……） */
export interface Newspaper {
  day: number;
  headline?: string;
  subhead?: string;
  lead?: string;
  articles?: Array<{ title: string; body: string }>;
  gossip?: string;
  quote?: { who: string; text: string };
  forecast?: string;
  [k: string]: unknown;
}

export interface SaveV2 {
  v: SaveVersion;
  worldId: string;
  packHash?: string | null;
  /** 游戏分钟 */
  t: number;
  weather: string;
  weatherLock?: boolean | string | null;
  specOps: OpRecord[];
  /** 在场的与出门在外的居民（运行时字段已排除） */
  agents: Agent[];
  entities: Entity[];
  worldFlags: Record<string, unknown>;
  paramMods: unknown[];
  ruleState: { every: Record<string, number>; at: Record<string, number>; [k: string]: unknown };
  threadState: Record<string, unknown>;
  crisis: { morale: number; supplies: number };
  discovered: string[];
  story?: unknown;
  migrationState?: unknown;
  mapState?: unknown;
  arcRuns: unknown[];
  voteState: unknown[];
  pendingScenes: unknown[];
  creatureList: unknown[];
  dark?: Record<string, unknown>;
  fights?: unknown[];
  portalState: unknown | null;
  swarmGoal: unknown | null;
  proposals: unknown[];
  decisionState: Array<{ status: string; [k: string]: unknown }>;
  architectQueue: unknown[];
  gaps: unknown[];
  architectUsage?: unknown;
  usage?: { days: Record<string, unknown> };
  metricsState: { days: Record<string, unknown> };
  logs: LogItem[];
  convoLog: ConvoRecord[];
  newspapers: Newspaper[];
  epic?: unknown;
  epicNotes?: unknown[];
  epicChapters?: unknown[];
  outline?: unknown;
  outlineRevisions?: unknown[];
  endState?: unknown;
  board: unknown[];
  pairCd: Record<string, number>;
  flags: Record<string, unknown>;
  seq: number;
  llmDay?: { key: string; tokens: number };
}
