// AI 插件契约（重构方案 §8.1、D4）：插件保持 JS，这份声明只作为生成器与人工编写时的参考，
// 与 plugin-host/schema.js（清单校验）、plugin-host/sandbox/runner.js（沙箱里的 api）、plugin-host/evolved.js（世界视图）保持一致。

export type Tier = 'T0' | 'T1' | 'T2';
export type Permission = 'world.read' | 'effects' | 'store' | 'llm' | 'routes' | 'ui.panel' | 'ui.overlay';
/** 沙箱插件可以订阅的钩子（tick 太频繁，只给进程内的内置插件） */
export type SandboxHook = 'hour' | 'dayStart' | 'agent.arrive' | 'conversation.end' | 'proposal.applied' | 'avatar.arrive' | 'story.beat';

/** 效果参数的声明式 schema（数值必须有上下限，字符串必须有长度上限） */
export type ArgField =
  | { type: 'int' | 'number'; min: number; max: number; required?: boolean }
  | { type: 'string'; max: number; required?: boolean }
  | { type: 'enum'; values: string[]; required?: boolean }
  | { type: 'bool' | 'location' | 'item' | 'agent'; required?: boolean };

export interface EffectDecl {
  /** 小写字母开头，2~24 位 */
  name: string;
  /** ≤200 字 */
  doc: string;
  /** 最多 8 个字段；op / target / radius 保留 */
  args?: Record<string, ArgField>;
}

/** plugin.json */
export interface PluginManifest {
  /** 小写字母、数字、短横线，3~32 位 */
  id: string;
  /** x.y.z；插件目录名为 <id>@<version> */
  version: string;
  tier: Tier;
  /** 1~16 字 */
  title: string;
  /** 1~80 字 */
  summary: string;
  permissions?: Permission[];
  provides?: { effects?: EffectDecl[] };
  /** 最多 6 个 */
  hooks?: SandboxHook[];
  /** 最多 4 个 */
  routes?: string[];
  ui?: { title?: string; panel?: boolean; overlay?: boolean };
  limits?: { llmTokensPerDay?: number };
  /** T0 / T1：随插件一起应用的世界操作（见 server/types/ops.ts） */
  content?: Array<{ op: string; args: Record<string, unknown> }>;
}

// ---------- T2 server.js 看到的世界（只读快照） ----------
export interface AgentView {
  id: string;
  name: string;
  role: string;
  kind: string;
  loc: string | null;
  status: string;
  region: string;
  x: number;
  y: number;
  mood?: string;
  moodEmoji?: string;
  stamina: number;
  courage: number;
  conditions: string[];
  inventory: Record<string, number>;
}

export interface WorldView {
  day: number;
  minute: number;
  hour: number;
  weekday: string;
  weather: string;
  flags: Record<string, unknown>;
  width: number;
  height: number;
  agents: AgentView[];
  locations: Array<{ id: string; name: string; center: { x: number; y: number } | null }>;
  items: string[];
  avatars: Array<{ name: string; loc: string | null; region: string }>;
}

/** 效果被调用时的上下文 */
export interface EffectCtx {
  self: AgentView | null;
  target: AgentView | null;
  source: string | null;
}

/** 钩子的事件负载 */
export interface HookEvents {
  hour: { day: number; hour: number };
  dayStart: { day: number };
  'agent.arrive': { agent: AgentView; locId: string };
  'conversation.end': { a: AgentView; b: AgentView; summary: string };
  'proposal.applied': { title: string; ops: string[] };
  'avatar.arrive': { name: string; loc: string | null };
  'story.beat': { kind: string };
}

/** 插件返回给宿主的效果：内核的效果原语（op + 参数），由宿主校验后执行 */
export interface EffectResult {
  op: string;
  [arg: string]: unknown;
}
export type HandlerResult = EffectResult[] | { effects: EffectResult[] } | void | null;

/** 覆盖层绘制指令（由前端统一绘制） */
export interface OverlayItem {
  kind: 'emoji' | 'text' | 'ring' | 'sparkle';
  x: number;
  y: number;
  text?: string;
  emoji?: string;
  color?: string;
  r?: number;
  region?: string;
}

/** server.js 的 export default function setup(api) 收到的 api */
export interface PluginApi {
  effect(name: string, fn: (args: Record<string, unknown>, ctx: EffectCtx, world: WorldView) => HandlerResult | Promise<HandlerResult>): void;
  on<K extends SandboxHook>(event: K, fn: (event: HookEvents[K], world: WorldView) => HandlerResult | Promise<HandlerResult>): void;
  route(name: string, fn: (body: unknown, world: WorldView) => unknown): void;
  /** 写一条动态（≤60 字） */
  log(text: string): void;
  /** 最多 20 条 */
  overlay(list: OverlayItem[]): void;
  /** 插件私有存储（JSON，合计 ≤64KB） */
  store: { get(key: string): unknown; set(key: string, value: unknown): void };
  /** 请宿主调用模型（需要 llm 权限；prompt ≤1500 字） */
  llm(prompt: string): Promise<string>;
}

/** test.js 的 export default function (t) 收到的 t */
export interface PluginTest {
  test(name: string, fn: () => void | Promise<void>): void;
  assert: typeof import('node:assert');
  /** 记录注册结果的假 api，供测试直接调用插件的处理函数 */
  api(): PluginApi & { registered: { effects: Record<string, Function>; hooks: Record<string, Function>; routes: Record<string, Function>; logs: string[]; overlay: OverlayItem[] | null; store: Record<string, unknown> } };
}
