// 世界的持久状态（重构方案 P6 第二步）：存档里属于这个世界的字段，统一定义在这一张表里——
//   schema   zod 校验（只查大结构：数组 / 对象 / 数字……，不查内部细节，避免把合法的旧存档误判为损坏）；
//            TownState 的类型由它推导（z.custom<T>），Town 上不再逐个声明
//   load     读档：存档里的值 → 状态（缺失时用默认值；结构不对时告警并用默认值）
//   save     存盘时的转换（多数字段原样写）
// 数据放在 town.state 里，Town 原型上的同名访问器转发过去：子系统照旧读写 this.dark、this.logs ||= …；
// 存档 = 遍历这张表，读档 = 遍历这张表，不再手工列字段。居民（agents / away）、用量与随机数状态另行处理（见 persistence.ts）。
import { z } from 'zod';
import { freshDark } from '../story/threats.ts';
import type { Params } from '../types/spec.ts';
import type { OpRecord } from '../types/ops.ts';
import type { ConvoRecord, Entity, LogItem, Newspaper, SaveV2 } from '../types/save.ts';
import type { DarkState, MetricsDay } from '../types/town.ts';
import type { Decision } from '../kernel/decisions.ts';
import type { ThreadState } from '../story/threads.ts';
import type { MigrationState } from '../story/migration.ts';
import type { Creature, Portal } from '../story/creatures.ts';
import type { ArcRun } from '../story/arcs.ts';
import type { StoryState } from '../story/director.ts';
import type { ArchitectItem, ArchitectUsage, Gap } from '../../plugins/builtin/architect/architect.ts';
import type { PressureState } from '../worldai/pressure.ts';
import type { Scene } from '../story/scene.ts';
import type { Fight } from './fight-rules.ts';
import type { EndState, EpicChapter, EpicNote, EpicState, Outline, OutlineDraft, OutlineRevision, Proposal, Vote } from '../types/story.ts';
import { freshEpic } from '../story/epic.ts';
import { freshEnd } from '../story/endings.ts';

const isObj = (v: unknown): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const arr = <T>() => z.custom<T[]>((v) => Array.isArray(v));
const obj = <T>() => z.custom<T>(isObj);
const num = () => z.custom<number>((v) => typeof v === 'number' && Number.isFinite(v));
const str = () => z.custom<string>((v) => typeof v === 'string');
const opt = <T extends z.ZodType>(t: T) => z.custom<z.infer<T> | undefined>((v) => v === undefined || t.safeParse(v).success);
const nul = <T extends z.ZodType>(t: T) => z.custom<z.infer<T> | null>((v) => v === null || t.safeParse(v).success);

/** 读档函数用到的小镇字段（不直接引用 Town：Town 的类型由这张表推导，引用它会形成循环） */
interface TownCtx { t: number; weather: string; spec: { weather: Record<string, unknown> }; state: object }
type Town = TownCtx;

interface FieldDef<S extends z.ZodType> {
  schema: S;
  /** 读档：v 是存档里的值；返回 undefined 表示「缺失」（用 fallback） */
  load?: (v: unknown, town: Town) => unknown;
  /** 缺失或结构不对时的值 */
  fallback?: (town: Town) => z.infer<S>;
  /** 只在构造函数里读（例如 specOps：重放世界规格时就要用） */
  ctorOnly?: boolean;
  save?: (v: z.infer<S>) => unknown;
}
const field = <S extends z.ZodType>(schema: S, rest: Omit<FieldDef<S>, 'schema'> = {}): FieldDef<S> => ({ schema, ...rest });
/** 和旧的读档写法 d.x || 默认值 一致：假值（undefined / null / 0 / ''）当作缺失 */
const orDefault = (v: unknown) => v || undefined;

export const STATE = {
  t: field(num(), { fallback: (town) => town.t }),
  weather: field(str(), { load: (v, town) => (Object.hasOwn(town.spec.weather, v as string) ? v : undefined), fallback: (town) => town.weather }),
  weatherLock: field(z.custom<SaveV2['weatherLock']>(() => true)),
  specOps: field(arr<OpRecord>(), { ctorOnly: true }),
  logs: field(arr<LogItem>(), { load: orDefault, fallback: () => [] }),
  convoLog: field(arr<ConvoRecord>(), { load: orDefault, fallback: () => [] }),
  newspapers: field(arr<Newspaper>(), { load: orDefault, fallback: () => [] }),
  board: field(arr<unknown>(), { load: orDefault, fallback: () => [] }),
  pairCd: field(obj<Record<string, number>>(), { load: orDefault, fallback: () => ({}) }),
  flags: field(obj<Record<string, unknown>>(), { load: orDefault, fallback: () => ({}) }),
  seq: field(num(), { load: orDefault, fallback: () => 0 }),
  entities: field(arr<Entity>(), { load: orDefault, fallback: () => [] }),
  worldFlags: field(obj<Record<string, unknown>>(), { load: orDefault, fallback: () => ({}) }),
  paramMods: field(arr<{ name: keyof Params; mul?: number; add?: number; until: number; source: string }>(), { load: orDefault, fallback: () => [] }),
  ruleState: field(obj<SaveV2['ruleState']>(), { load: orDefault, fallback: () => ({ every: {}, at: {} }) }),
  threadState: field(obj<Record<string, ThreadState>>(), { load: orDefault, fallback: () => ({}) }),
  crisis: field(obj<SaveV2['crisis']>(), { load: orDefault, fallback: () => ({ morale: 70, supplies: 80 }) }),
  discovered: field(arr<string>(), { load: orDefault, fallback: () => [] }),
  story: field(opt(obj<StoryState>()), { load: orDefault }),
  migrationState: field(opt(obj<MigrationState>()), { load: orDefault }),
  mapState: field(opt(obj<{ pressure?: PressureState; vetoes?: Record<string, number>; [k: string]: unknown }>()), { load: orDefault }),
  arcRuns: field(arr<ArcRun>(), { load: orDefault, fallback: () => [] }),
  voteState: field(arr<Vote>(), { load: orDefault, fallback: () => [] }),
  pendingScenes: field(arr<Scene>(), { load: orDefault, fallback: () => [] }),
  creatureList: field(arr<Creature>(), { load: orDefault, fallback: () => [] }),
  // 旧存档缺的黑暗叙事字段用初值补齐
  dark: field(obj<DarkState>(), { load: (v) => (v ? { ...freshDark(), ...(v as object) } : undefined), fallback: () => freshDark() }),
  // 即时战斗（sim/combat）：旧版的回合制打斗读档时丢弃；化身不进存档，读档后视为离场
  fights: field(arr<Fight>(), { load: (v) => (Array.isArray(v) ? v.filter((f: Fight) => Array.isArray(f?.fighters)).map((f: Fight) => ({ ...f, fighters: f.fighters.map((x) => (x.kind === 'avatar' ? { ...x, out: 'gone' as const } : x)) })) : undefined), fallback: () => [] }),
  portalState: field(nul(obj<Portal>()), { load: orDefault, fallback: () => null }),
  swarmGoal: field(nul(str()), { load: orDefault, fallback: () => null, save: (v) => v || null }),
  proposals: field(arr<Proposal>(), { load: orDefault, fallback: () => [] }),
  // 重启时还在等 AI 裁决的决定回到等待（裁决请求随进程一起没了）
  decisionState: field(arr<Decision>(), { load: (v) => (Array.isArray(v) ? v.map((x: Decision) => (x.status === 'arbitrating' ? { ...x, status: 'waiting' } : x)) : v || undefined), fallback: () => [] }),
  architectQueue: field(arr<ArchitectItem>(), { load: orDefault, fallback: () => [] }),
  gaps: field(arr<Gap>(), { load: orDefault, fallback: () => [] }),
  architectUsage: field(opt(obj<ArchitectUsage>()), { load: orDefault }),
  metricsState: field(obj<{ days: Record<string, MetricsDay> }>(), { load: orDefault, fallback: () => ({ days: {} }) }),
  // 世界史诗、大纲与结局（docs/design/epic-outline.md）：账本、章节、修订是只追加的列表（world-store 的 LIST_FIELDS）
  epic: field(obj<EpicState>(), { load: (v) => (v ? { ...freshEpic(), ...(v as object) } : undefined), fallback: () => freshEpic() }),
  epicNotes: field(arr<EpicNote>(), { load: orDefault, fallback: () => [] }),
  epicChapters: field(arr<EpicChapter>(), { load: orDefault, fallback: () => [] }),
  outline: field(nul(obj<Outline>()), { load: orDefault, fallback: () => null }),
  outlineRevisions: field(arr<OutlineRevision>(), { load: orDefault, fallback: () => [] }),
  outlineDraft: field(nul(obj<OutlineDraft>()), { load: orDefault, fallback: () => null }),
  endState: field(obj<EndState>(), { load: (v) => (v ? { ...freshEnd(), ...(v as object) } : undefined), fallback: () => freshEnd() }),
};

export type StateKey = keyof typeof STATE;
/** 世界的持久状态（类型由上面的 schema 推导） */
export type TownState = { [K in StateKey]: z.infer<(typeof STATE)[K]['schema']> };
export const STATE_KEYS = Object.keys(STATE) as StateKey[];

/** 在 Town 原型上为每个状态字段挂访问器（转发到 this.state）；sim.ts 加载时调用一次 */
export function defineStateAccessors(proto: object): void {
  for (const k of STATE_KEYS) {
    Object.defineProperty(proto, k, {
      get(this: { state: Record<string, unknown> }) { return this.state[k]; },
      set(this: { state: Record<string, unknown> }, v: unknown) { this.state[k] = v; },
      enumerable: false, configurable: false,
    });
  }
}

/** 读档：存档里的值 → town.state（不含 ctorOnly 的字段） */
export function loadState(town: Town, d: Record<string, unknown>): void {
  const state = town.state as Record<string, unknown>;
  for (const k of STATE_KEYS) {
    const f = STATE[k] as FieldDef<z.ZodType>;
    if (f.ctorOnly) continue;
    const v = f.load ? f.load(d[k], town) : d[k];
    if (v === undefined) { state[k] = f.fallback?.(town); continue; }
    if (f.schema.safeParse(v).success) { state[k] = v; continue; }
    console.warn(`[save] 存档里的 ${k} 结构不对，已重置为初始值`);
    state[k] = f.fallback?.(town);
  }
}

/** 存盘：town.state → 存档里的字段（按表的顺序） */
export function saveState(town: Town): Record<string, unknown> {
  const state = town.state as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of STATE_KEYS) {
    const f = STATE[k] as FieldDef<z.ZodType>;
    out[k] = f.save ? f.save(state[k]) : state[k];
  }
  return out;
}
