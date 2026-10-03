// 叙事与世界 AI 的数据结构（重构方案 §8.2 B6）：提案、剧情弧、投票、场景、异界生物、威胁……
// 大多数是存档里的状态（types/save.ts 的对应字段），由各子系统（story/、worldai/）读写。
import type { OpLevel } from './ops.ts';

// ---------- 建设提案（worldai/proposals） ----------
/** 提案里的一条世界操作：参数由 kernel/ops 的 check() 校验，这里不约束 */
export interface ProposalOp {
  op: string;
  args: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type ProposalStatus = 'review' | 'voting' | 'awaiting' | 'queued' | 'building' | 'council' | 'applied' | 'rejected' | 'failed' | 'expired' | 'reverted';

/** 设定考据官的结论（worldai/canon） */
export interface CanonReview {
  ok: boolean;
  severity: 'none' | 'minor' | 'major';
  issues: string[];
  by: 'rules' | 'llm';
  notes?: string;
}

/** 施工：谁来建、要几个小时、在哪里（拆除时 kind 为 demolish） */
export interface Construction {
  by: string[];
  hours: number;
  site: { x: number; y: number; w: number; h: number; near: string | null; id?: string };
  kind?: 'demolish';
  [k: string]: unknown;
}

export interface Proposal {
  id: string;
  title: string;
  motive: string;
  /** admin / director / visitor / architect / planner / agent:<居民 id> */
  origin: string;
  ops: ProposalOp[];
  level: OpLevel;
  status: ProposalStatus;
  createdT: number;
  /** 投票：投票人 → 赞成 */
  votes: Record<string, boolean>;
  canon: CanonReview | null;
  result: { t: number; reason: string | null } | null;
  construction: Construction | null;
  voteUntil?: number;
  finishT?: number;
  appliedDay?: number;
  approvedBy?: string;
  /** 决策队列里的项 */
  decision?: string;
  /** 拆除前的居民议事（worldai/council） */
  council?: CouncilState | null;
}

/** 一位居民在议事里的表态 */
export interface CouncilVote { yes: boolean; reason?: string; [k: string]: unknown }

/** 居民议事的进展与结论（提案的 council 字段） */
export interface CouncilState {
  status: 'meeting' | 'deliberating' | 'done' | (string & {});
  buildingId: string;
  buildingName: string;
  /** 当事人（住在这里、在这里工作的人）与其余投票人 */
  stakeholders: string[];
  voters: string[];
  startT: number;
  votes: Record<string, CouncilVote>;
  consent: Record<string, CouncilVote>;
  sceneId?: string;
  nextT?: number;
  busy?: boolean;
  summary?: string | null;
  pass?: boolean;
  forced?: boolean;
  why?: string;
  tally?: { yes: number; no: number; voters: number; cast: number; agreed: boolean };
  /** 当事人第一人称的重要记忆：同意搬走时 / 被全票通过时 */
  memories?: Record<string, { agree: string; forced: string }>;
  thread?: { title: string; hook: string };
  [k: string]: unknown;
}

// ---------- 抉择投票（story/votes） ----------
export interface VoteOption { id: string; label: string; desc: string }
export interface Vote {
  id: string;
  question: string;
  options: VoteOption[];
  openedT: number;
  closesT: number;
  /** 所属的剧情弧 */
  arc: string | null;
  /** 访客（IP 或其哈希）→ 选项 id；居民 id → 选项 id */
  visitors: Record<string, string>;
  residents: Record<string, string>;
  status: 'open' | 'awaiting' | 'closed';
  awaitUntil?: number | null;
  result: { option: string; by: string; t: number } | null;
}
export type VoteTally = Record<string, { residents: number; visitors: number; total: number }>;
