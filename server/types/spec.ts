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
  /** 新来的人出现的地点 */
  spawn?: string;
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
  /** 运行中加上的（不是世界包里的） */
  added?: boolean;
  region?: string;
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
  combat?: { atk?: number; def?: number; spd?: number };
  /** 主角光环：不会死（降为重伤） */
  plotArmor?: boolean;
  /** 反派回心转意的条件（表达式） */
  redemption?: string;
  /** 反派的欲望：每天积累多少压力 */
  drives?: Array<{ text: string; perDay?: number }>;
  /** 旅人：从哪里来、对这里不了解什么 */
  traveller?: { origin: string; knowledgeGap?: string[]; [k: string]: unknown };
  origin?: string;
  /** 异界角色守着时的样子 */
  idle?: string;
  /** 这个角色是某种异界生物的首领（图鉴里默认可见） */
  creature?: string;
}

export interface Item {
  name: string;
  emoji: string;
  desc?: string;
  /** 装备位置（黑暗叙事）：装备后加成 mods */
  equip?: 'weapon' | 'armor' | 'trinket' | (string & {});
  mods?: { atk?: number; def?: number; hp?: number };
  /** 弱点标签（攻击威胁时比对） */
  tags?: string[];
  /** 使用物品的效果 */
  use?: Effect[];
  [k: string]: unknown;
}

/** 负担值（黑暗叙事设计 §4.4）：随时间或事件增长，到头时触发 onFull */
export interface BurdenDef {
  name: string;
  max?: number;
  /** 每天增长多少 */
  drift?: number;
  driftMods?: Array<{ when: string; mult: number }>;
  onEvent?: Array<{ event: string; amount: number }>;
  /** 到某个数值时心情变成… */
  moodAt?: Array<[number, string]>;
  selfText?: string;
  onFull?: Effect[];
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
  /** 创世级（combat.md §5）：可以改世界结构（worldOp）、让人离开世界（transform）；只能写在世界包里，只有 tier 为 primordial 的角色能学会和使用 */
  power?: 'genesis';
  /** 创世级能力每个人一共能用几次 */
  uses?: number;
  /** 即时战斗里的招式节奏（设计 combat.md §3.3）：没有时不能在战斗里用 */
  combat?: { windup?: number; recover?: number; range?: number; shape?: 'single' | 'circle' | 'line' | 'cone'; radius?: number; cd?: number };
  learn?: { research?: { location: string; keywords: string[] }; [k: string]: unknown };
}

export interface Rule {
  id: string;
  name: string;
  /** 四种触发器之一：every（每隔 N 游戏分钟）、at（每天某时刻）、weather（天气变为某种，* 为任意）、enter（到达某地点，* 为任意） */
  when: { every?: number; at?: string; weather?: string; enter?: string };
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

export type Side = 'north' | 'south' | 'east' | 'west';

/** 地形编辑（地图演变 §4）：修路、架桥、清地、种树、新户外地点 */
export interface RegionEdit {
  kind: string;
  id?: string | null;
  placeKind?: string | null;
  cells?: number[][];
  trees?: Array<[number, number, string]>;
  rect?: { x: number; y: number; w: number; h: number };
  seed?: number;
  [k: string]: unknown;
}

/** 相邻地图之间的通道入口 */
export interface RegionEntry { side: Side; at: number; to: string; key: string }

export interface Region {
  id: string;
  name: string;
  generator: string;
  seed?: number;
  size: [number, number];
  biome?: string;
  /** 通往这个区域的渡口（小镇里的地点 id） */
  gate?: string;
  gateName?: string;
  /** 已经向玩家开放 */
  open?: boolean;
  /** layout-v1：区域块与连接 */
  areas?: Array<{ id: string; biome?: string; size?: string; places: Array<{ id: string; kind: string; name: string; [k: string]: unknown }> }>;
  links?: Array<{ from: string; to: string; via: string }>;
  /** 运行中加上的地形编辑、扩展块 */
  edits?: RegionEdit[];
  extensions?: Array<{ rect: { x: number; y: number; w: number; h: number }; [k: string]: unknown }>;
  /** 与相邻地图相通的入口 */
  entries?: RegionEntry[];
  /** 相邻地图：接在哪张地图的哪一侧 */
  adjacent?: { to: string; side: Side };
  /** 向西 / 向北扩展时世界包基础内容的平移 */
  offset?: { x: number; y: number };
  /** 扩展过的区域：生成器用的基础尺寸（size 是扩展之后的） */
  baseSize?: [number, number];
  /** 开放时、第一次到访时的文字；到访后居民得到的看法、听到的传闻；那边的原住民 */
  openText?: string;
  firstVisit?: string;
  belief?: string;
  rumors?: string[];
  friends?: Array<{ type: string; name: string; near: string }>;
  [k: string]: unknown;
}

/** 剧情弧里的时刻：开弧后第 d 天的 at（HH:MM） */
export interface ArcWhen { d?: number; at: string }

/** 剧情弧的一个节拍：到点（或进入阶段时）执行一串 beats */
export interface ArcBeat {
  id: string;
  when: ArcWhen & { enter?: boolean };
  do: unknown[];
}

/** 剧情弧模板（设计文档 5.2） */
export interface Arc {
  id: string;
  title: string;
  emoji?: string;
  summary: string;
  start: { at?: string; [k: string]: unknown };
  /** 伏笔 → 爆发 → 发展 → 高潮 → 余波 */
  phases: Array<{ id: string; name: string; until?: ArcWhen; beats: ArcBeat[] }>;
  /** 投票选项 id → 结局；check 为智取判定，失败时转到 fail 结局 */
  endings: Record<string, { title: string; do: unknown[]; check?: { base?: number }; fail?: string; failText?: string }>;
  finale?: unknown[];
  /** 剧情弧带来的角色：id → 人物卡 */
  cast?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CreatureType {
  name: string;
  emoji: string;
  origin?: string;
  tags: string[];
  look: { bodyPlan: 'wisp' | 'hound' | 'warden'; [k: string]: string };
  stats: { hp: number; speed: number; courage: number };
  /** 行为：原型、活动时段、怕什么、常去的地点 */
  behavior: { archetype?: 'wander' | 'guard' | 'chaser' | 'thief' | (string & {}); active?: [string, string]; fleeFrom?: string; targets?: string[]; [k: string]: unknown };
  temperament?: string;
  lore?: string;
  leader?: boolean;
  minRating?: string;
  [k: string]: unknown;
}

/** 规律型威胁（黑暗叙事设计 §4）：校验见 kernel/threat-spec.ts */
export interface ThreatType {
  name: string;
  emoji: string;
  kind?: string;
  /** 会不会死（杀不死的只能收容、压制） */
  mortal: boolean;
  hp?: number;
  atk?: number;
  def?: number;
  speed?: number;
  origin?: string;
  movement?: 'wander' | 'stalk_marked' | 'stationary' | 'patrol';
  /** 常出没的地点 */
  haunt: string[];
  /** 活动时段 ["HH:MM","HH:MM"] */
  active?: [string, string];
  minRating?: string;
  /** 规律：触发条件 → 标记（延迟、征兆）→ 结局；unless 为豁免条件 */
  rule?: { trigger: string; unless?: string; mark: { delay: [number, number]; sign?: string }; outcome: Effect[]; reach?: number; rest?: number };
  sounds?: Array<{ id: string; every: number; radius?: number; text?: string }>;
  /** 对付它的办法 */
  counters?: Array<{ type: string; with?: string; yields?: string; time?: number; leak?: number; power?: number; radius?: number; when?: string; text?: string; hint?: string }>;
  zone?: { radius: number; grow?: number; replay?: string; tint?: string };
  hostable?: { burden: string; grants: string[]; rate?: number; offsets?: Record<string, number>; via?: Array<{ when?: string; p: number; fail?: Effect[] }> };
  /** 真线索、假线索 */
  clues: string[];
  /** 攻击带这些标签时伤害加成 */
  weakness?: string[];
  decoys?: string[];
  /** 可以研究它的地点 */
  research?: string[];
  loot?: Array<{ item: string; p: number }>;
  /** 即时战斗（combat.md §3、§5）：会用的招式（带 combat 块的能力）、血量阶段（Boss）、被打死时的效果、主动攻击身边居民的距离 */
  skills?: string[];
  phases?: Array<{ at: number; text: string; effects?: Effect[]; skills?: string[]; atk?: number }>;
  onSlain?: Effect[];
  aggro?: number;
  /** 群众伤亡：每隔多少分钟、杀几个 */
  crowd?: { every: number; kills: [number, number] };
  look?: unknown;
  [k: string]: unknown;
}

export interface Faction {
  id: string;
  name: string;
  members: string[];
  /** 敌对的阵营 */
  hostile?: string[];
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
  /** 改编自原著的世界（创世）：忠实度、开场、原著里的命运节点 */
  adaptation?: { fidelity?: string; start?: string; notes?: string; fateNodes?: Array<{ id: string; text: string; day: number }> };
  calendar: { weekdays: string[]; events: CalendarEvent[] };
  weather: Record<string, Weather>;
  locations: Record<string, Location>;
  buildings: Building[];
  personas: Persona[];
  creatures?: Record<string, CreatureType>;
  threads?: Thread[];
  items: Record<string, Item>;
  structures: Record<string, Structure>;
  abilities: Ability[];
  rules: Rule[];
  factions?: Faction[];
  burdens?: Record<string, BurdenDef>;
  threats?: Record<string, ThreatType>;
  /** 事件：开局就有的威胁、自动出现的间隔 */
  incidents?: { start?: Array<{ threat: string; at?: string }>; autoEveryDays?: number };
  /** 地点 → 当地的群众人数 */
  population?: Record<string, number>;
  params: Params;
  regions: Region[];
  arcs?: Arc[];
  /** 官方世界包：false 时第一次登记为「不公开」（不进大厅，链接可以进），管理员在面板里切成公开 */
  listed?: boolean;
  /** 即时战斗：游戏模式里旅人化身的技能（1~4 键，能力 id） */
  combat?: { avatarKit?: string[] };
}
