// 世界操作（重构方案 §8.1）：对世界规格的一切修改都是一条 WorldOp（server/kernel/ops.js 的 OPS 表），
// 应用后记进存档的 specOps，读档时从默认规格重放。
import type { Effect, Rule, Ability, Weather, Item, Structure, CalendarEvent, BuildingState, Params, Rating, Storyteller } from './spec.ts';

/** 审批等级 */
export type OpLevel = 'micro' | 'minor' | 'major';

/** 各操作的参数；未细化的操作先用宽松的对象，逐步补全 */
export interface OpArgs {
  setParam: { name: keyof Params; value: number };
  setMeta: { rating?: Rating; storyteller?: Storyteller };
  addCanon: { text: string; tags?: string[]; secret?: boolean };
  addThread: { id: string; title: string; hook: string };
  addCalendarEvent: Omit<CalendarEvent, 'day'> & { day?: number; [k: string]: unknown };
  addWeather: { id: string } & Weather;
  addItem: { id: string } & Item;
  addStructure: { id: string } & Structure;
  addAbility: Ability;
  addBuilding: { id: string; name: string; kind: string; [k: string]: unknown };
  setBuildingState: { id: string; state: BuildingState; remap?: Record<string, string> };
  renovateBuilding: { id: string; [k: string]: unknown };
  removeBuilding: { id: string; remap?: Record<string, string>; [k: string]: unknown };
  restoreBuilding: { id: string };
  addPath: Record<string, unknown>;
  addBridge: Record<string, unknown>;
  clearArea: Record<string, unknown>;
  plantGrove: Record<string, unknown>;
  addOutdoorPlace: Record<string, unknown>;
  expandMap: Record<string, unknown>;
  addRegion: Record<string, unknown>;
  linkRegions: Record<string, unknown>;
  addAdjacentRegion: Record<string, unknown>;
  addPersona: Record<string, unknown>;
  setPersonaStatus: { id: string; status: string; [k: string]: unknown };
  settlePersona: { id: string; [k: string]: unknown };
  addRule: Rule & { then: Effect[] };
}

export type OpName = keyof OpArgs;

/** 一条操作（按 op 字段区分参数类型） */
export type WorldOp = { [K in OpName]: { op: K; args: OpArgs[K] } }[OpName];

/** 变更来源，例如 { by: 'admin' } / { by: 'proposal', proposal: 'wp_1', origin: 'admin' } */
export interface OpCause {
  by: string;
  [k: string]: unknown;
}

/** 存档 specOps 里的一条记录（sim.js 的 applyWorldOp）：操作本身 + 序号、时间、来源 */
export type OpRecord = WorldOp & {
  seq: number;
  /** 游戏分钟（取整） */
  t: number;
  cause: OpCause;
};

/** ops.jsonl 审计日志里的其他记录（回溯、分叉……） */
export interface JournalRecord {
  op: string;
  at?: string;
  [k: string]: unknown;
}
