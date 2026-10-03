// Town 发出的事件与负载（重构方案 §8.1）：WorldHost 把它们转成 SSE 推给页面（worlds/host.ts 的 wire）。
// 用法：class Town extends (EventEmitter as new () => TypedEmitter<TownEvents>)，或在 on/emit 处标注。
import type { LogItem, Newspaper } from './save.ts';
import type { WorldSpec } from './spec.ts';
import type { OpRecord } from './ops.ts';

/** 世界快照（sim/views.js 的 snapshot()）：每秒推 TICK_HZ 次 */
export interface Snapshot {
  t: number;
  speed: number;
  paced: number | null;
  paused: boolean;
  idle: boolean;
  halted: { code: string; text: string } | null;
  weather: string;
  nightSkip: boolean;
  agents: Array<{
    id: string; x: number; y: number; dir: string; moving: boolean; status: string; region: string;
    inside: string | null; emoji: string; action: string; loc: string | null; mood: string;
    thinking: string; convo: string | null; hp?: number; marked?: boolean; hosted?: boolean;
    bubble: { id: number; text: string; kind: string } | null;
  }>;
  convos: Array<{ id: string; a: string; b: string; state: string }>;
  entities: Array<Record<string, unknown>>;
  creatures: Array<Record<string, unknown>>;
  dark?: Record<string, unknown>;
  avatars: Array<Record<string, unknown>>;
  overlay: unknown;
  story: { tension: number | null; arc: string | null; vote: boolean };
}

export interface Vfx {
  preset: string;
  x: number;
  y: number;
  color?: string;
  radius?: number;
  region?: string;
  [k: string]: unknown;
}

/** 事件名 → 监听函数的参数 */
export interface TownEvents {
  tick: [snapshot: Snapshot];
  log: [item: LogItem];
  agent: [id: string];
  agents: [list: Array<Record<string, unknown>>];
  newspaper: [paper: Newspaper];
  world: [change: { spec: Partial<WorldSpec>; op: OpRecord | null; desc: string; quiet?: boolean }];
  vfx: [vfx: Vfx];
  worldmap: [world: Record<string, unknown>];
  regions: [regions: Record<string, unknown>];
  reinit: [];
  say: [line: { convo: string; speaker: string; text: string }];
  // 面板类：只通知「有变化」，页面再按需拉取（host 里 800ms 合并）
  story: [];
  evolution: [];
  decisions: [];
  proposals: [];
}

export type TownEventName = keyof TownEvents;

/** 类型化的 EventEmitter 接口（只约束 on / off / once / emit 的签名） */
export interface TypedEmitter<E extends { [K in keyof E]: unknown[] }> {
  on<K extends keyof E>(event: K, listener: (...args: E[K]) => void): this;
  once<K extends keyof E>(event: K, listener: (...args: E[K]) => void): this;
  off<K extends keyof E>(event: K, listener: (...args: E[K]) => void): this;
  emit<K extends keyof E>(event: K, ...args: E[K]): boolean;
}

/** SSE 推给页面的事件（在 TownEvents 之外，由 WorldHost / 世界管理器发出） */
export interface HostEvents {
  init: Record<string, unknown> & { build?: string | null };
  halt: { code: string; text: string };
  resume: { t: number };
  closed: { reason: string };
  restart: Record<string, never>;
}
