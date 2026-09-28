// 世界规格（重构方案 §8.1）：与 server/kernel/spec.js 的 validateSpec 对齐。
// 默认规格来自世界包（worlds/<id>/world.json + map.json + bible.json + arcs/），之后的改动都以 WorldOp 叠加（见 ops.ts）。
// 结构复杂、仍在演进的部分（剧情弧、威胁、事件）先给出主要字段，其余用索引签名放行。
import type { Look } from './agent.ts';

export type Rating = 'cozy' | 'drama' | 'tragic' | 'dark' | (string & {});
export type Storyteller = 'gentle' | 'voyage' | 'chaos' | 'horror';
export type BuildingState = 'open' | 'closed' | 'damaged' | 'ruin' | (string & {});

/** 效果原语（kernel/effects.js）：按 op 区分，参数随 op 不同 */
export interface Effect {
  op: string;
  target?: string;
  radius?: number;
  includeSelf?: boolean;
  [arg: string]: unknown;
}

export interface Voice {
  name: string;
  emoji: string;
  place: string;
  resident: string;
  chronicle: { name: string; kind: string; editor: string; style: string };
  ui: { tagline: string; welcome: string; sampleEvents: string[] };
}

export interface CalendarEvent {
  id: string;
  name: string;
  emoji?: string;
  /** 第几天（从 1 开始） */
  day: number;
  /** HH:MM */
  from: string;
  to?: string;
  location?: string;
  hint?: string;
  vfx?: string;
  countdown?: boolean;
}

export interface Weather {
  name: string;
  emoji: string;
  /** 0~100，0 表示不会自然出现（只能由剧情触发） */
  weight: number;
  avoid?: { fallback: string; [k: string]: unknown };
  render?: { base?: string; tint?: string; tintAlpha?: number };
}

export interface Location {
  name: string;
  emoji?: string;
  desc?: string;
  public?: boolean;
  region?: string;
  [k: string]: unknown;
}

export interface Building {
  id: string;
  name: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  roof?: string;
  state?: BuildingState;
  removed?: boolean;
  [k: string]: unknown;
}

export interface Persona {
  id: string;
  name: string;
  age: number;
  role: string;
  home: string;
  work: string;
  persona: string;
  goal: string;
  look: Look;
  kind?: 'resident' | 'traveller' | 'creature';
  tier?: string;
  status?: string;
  start?: { abilities?: string[]; inventory?: Record<string, number>; burdens?: Record<string, number>; hosted?: string[] };
  /** 对其他居民的初始关系：id → [好感, 看法] */
  relations: Record<string, [number, string]>;
  memories: string[];
  alignment?: string;
  combat?: Record<string, unknown>;
}

export interface Item {
  name: string;
  emoji: string;
  desc?: string;
  [k: string]: unknown;
}

export interface Structure {
  name: string;
  emoji: string;
  tags: string[];
  /** 存在多久（游戏分钟） */
  ttl?: number;
  light?: { r: number; color: string };
}

export interface Ability {
  id: string;
  name: string;
  emoji: string;
  target: 'self' | 'agent' | 'area' | 'location' | (string & {});
  desc: string;
  aiHint?: string;
  /** target 为 agent 时的作用距离（1~6 格） */
  range?: number;
  cost?: { stamina?: number; items?: Record<string, number>; burden?: { id: string; amount: number } };
  /** 游戏分钟 */
  cooldown?: number;
  /** 表达式（kernel/expr.ts） */
  requires?: string;
  effects: Effect[];
  learn?: { research?: { location: string; keywords: string[] }; [k: string]: unknown };
}

export interface Rule {
  id: string;
  name: string;
  when: { every?: number; at?: string; [k: string]: unknown };
  forEach?: 'agent' | (string & {});
  if?: string;
  then: Effect[];
}

export interface Thread {
  id: string;
  title: string;
  hook: string;
  owners?: string[];
}

export interface Region {
  id: string;
  name: string;
  generator: string;
  seed?: number;
  size: [number, number];
  biome?: string;
  gate?: unknown;
  gateName?: string;
  [k: string]: unknown;
}

export interface Arc {
  id: string;
  title: string;
  emoji?: string;
  summary: string;
  start: Record<string, unknown>;
  phases: Array<{ id: string; name: string; [k: string]: unknown }>;
  endings?: unknown[];
  finale?: unknown;
  cast?: unknown;
  [k: string]: unknown;
}

export interface CreatureType {
  name: string;
  emoji: string;
  origin?: string;
  tags: string[];
  look: { bodyPlan: 'wisp' | 'hound' | 'warden'; [k: string]: string };
  stats: { hp: number; speed: number; courage: number };
  behavior: Record<string, unknown>;
  [k: string]: unknown;
}

/** 规律型威胁（黑暗叙事）：详细字段见 kernel/threat-spec.js */
export interface ThreatType {
  name: string;
  emoji: string;
  kind?: string;
  mortal?: boolean;
  rule?: Record<string, unknown>;
  hostable?: { burden: string; grants: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export interface Faction {
  id: string;
  name: string;
  members: string[];
  head?: string;
  authority?: string[];
  stipend?: { every: number; [item: string]: number };
}

export interface Params {
  walkSpeed: number;
  maxConvos: number;
  convoBaseProb: number;
  reflectThreshold: number;
  /** 分钟，可以晚到次日 01:00 */
  dayEnd: number;
  deathNamed?: number;
  deathDays?: number;
}

export interface WorldSpec {
  id: string;
  specVersion: 2;
  meta: { name: string; rating: Rating; storyteller: Storyteller };
  voice: Voice;
  rhythm?: { plan?: string; diary?: string; chronicle?: string };
  era?: { tech: string; forbidden: string[] };
  lore: {
    summary: string;
    pillars?: string[];
    /** 正则片段：违背世界底线的词 */
    breakers?: string;
    canon: Array<{ id: string; text: string; tags: string[]; secret: boolean; t: number }>;
  };
  source?: { title?: string; [k: string]: unknown };
  calendar: { weekdays: string[]; events: CalendarEvent[] };
  weather: Record<string, Weather>;
  locations: Record<string, Location>;
  buildings: Building[];
  personas: Persona[];
  population?: Record<string, unknown>;
  creatures?: Record<string, CreatureType>;
  threads?: Thread[];
  items: Record<string, Item>;
  structures: Record<string, Structure>;
  abilities: Ability[];
  rules: Rule[];
  factions?: Faction[];
  burdens?: Record<string, { name?: string; [k: string]: unknown }>;
  threats?: Record<string, ThreatType>;
  incidents?: unknown[];
  params: Params;
  regions?: Region[];
  arcs?: Arc[];
}
