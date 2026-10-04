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

// ---------- 世界史诗、世界大纲与结局（docs/design/epic-outline.md） ----------
export type OutlineStatus = 'done' | 'active' | 'planned' | 'dropped';
export type BeatStatus = 'planned' | 'done' | 'transformed' | 'skipped';
/** 大纲节点：一件计划中要发生的事；done 是可选的完成条件表达式 */
export interface OutlineBeat {
  id: string;
  text: string;
  status: BeatStatus;
  done?: string;
  links?: { thread?: string; threat?: string; arc?: string; persona?: string };
  /** 推进或完成这个节点的史诗章节编号（第几部第几章：`${part}:${n}`） */
  chapters: string[];
  locked?: boolean;
  tags?: string[];
  /** 规则判定完成的时刻（之后写成的第一章挂上链接） */
  doneT?: number;
  note?: string;
}
/** 大纲的一幕（= 史诗的一卷） */
export interface OutlineAct {
  id: string;
  title: string;
  plan: string;
  recap?: string;
  status: OutlineStatus;
  endingRef?: string;
  locked?: boolean;
  beats: OutlineBeat[];
}
/** 大纲的一部（= 史诗的一部） */
export interface OutlinePart { id: string; title: string; status: OutlineStatus; acts: OutlineAct[] }
/** 终局分支：when 连续满足 for 天后触发 */
export interface EndingDef {
  id: string;
  title: string;
  kind: 'good' | 'bad' | 'neutral';
  when: string;
  for?: number;
  hint?: string;
  finale?: { hours?: number; text?: string };
}
export interface Outline {
  version: number;
  premise: string;
  theme: string;
  autoAdjust: boolean;
  parts: OutlinePart[];
  endings: EndingDef[];
}
/** 大纲的一次修订（只追加） */
export interface OutlineRevision {
  v: number;
  t: number;
  day: number;
  by: string;
  kind: 'genesis' | 'seed' | 'keeper' | 'owner-ai' | 'owner-manual' | 'part' | 'rerate';
  note: string;
  review?: { verdict: string; issues: number; forced?: boolean } | null;
  snapshot: Outline;
}
/** 世界包里的史诗配置 */
export interface EpicConfig {
  title?: string;
  narrator?: string;
  chapter?: { everyDays?: number; minDays?: number; weight?: number; words?: [number, number] };
  volumeEveryChapters?: number;
}
/** 史料账本的一条 */
export interface EpicNote { seq: number; t: number; day: number; kind: string; text: string; w: number }
/** 史诗的一章 */
export interface EpicChapter {
  part: number;
  partTitle?: string;
  volume: string;
  volumeTitle: string;
  n: number;
  title: string;
  body: string;
  summary: string;
  from: number;
  to: number;
  beats: string[];
  t: number;
  ending?: { id: string; title: string; kind: string } | null;
}
/** 史诗的进度（存档 epic） */
export interface EpicState {
  cursor: number;
  noteSeq: number;
  lastDay: number;
  checkedDay: number;
  synopsis: string;
  cast: Array<{ name: string; note: string }>;
  part: number;
  partTitle: string;
  failures: number;
  /** 正在等待写的大结局 */
  finalePending?: boolean;
}
/** 结局进度（存档 endState） */
export interface EndState {
  /** 结局 id → 条件开始连续满足的那一天 */
  held: Record<string, number>;
  triggered: { id: string; title: string; kind: string; t: number; day: number; until: number } | null;
  ended: { id: string; title: string; kind: string; t: number; day: number } | null;
  part: number;
  history: Array<{ part: number; id: string; title: string; kind: string; day: number }>;
}
