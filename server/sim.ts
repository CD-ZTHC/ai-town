// 小镇模拟核心：世界状态、主循环、天气、角色登场与离开、世界操作。
// 其余职责按模块拆在 server/sim/ 下（区域、移动、日程、行动、认知、社交、视图、存档），
// 以 mixin 的形式挂到 Town 上（见文件末尾），方法里的 this 都是 Town。
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { buildRegions, buildRegion } from './worldgen/index.ts';
import * as llm from './llm.ts';
import { addMemory, parseHM } from './memory.ts';
import { officialPack, packSpec } from './worlds/pack.ts';
import { defaultSpec, validateSpec, weekdayOf, calendarHint, pickWeather, publicSpec, PARAM_BOUNDS } from './kernel/spec.ts';
import { RuleEngine } from './kernel/rules.ts';
import { Director } from './story/director.ts';
import { ArcEngine } from './story/arcs.ts';
import { SceneManager } from './story/scene.ts';
import { VoteSystem } from './story/votes.ts';
import { CreatureSystem } from './story/creatures.ts';
import { ThreatSystem, freshDark } from './story/threats.ts';
import { MigrationSystem } from './story/migration.ts';
import { AvatarSystem } from './avatars.ts';
import { ProposalSystem } from './worldai/proposals.ts';
import { Council } from './worldai/council.ts';
import { MapPressure } from './worldai/pressure.ts';
import { HookBus } from './kernel/hooks.ts';
import { DecisionQueue } from './kernel/decisions.ts';
import { PluginHost } from '../plugin-host/index.ts';
import { EvolvedManager } from '../plugin-host/evolved.ts';
import { findAbility } from './kernel/abilities.ts';
import { applyOp, replay, OpJournal, OPS, OpError } from './kernel/ops.ts';
import { checkPlacement } from './kernel/placement.ts';
import { applyMods } from './kernel/mods.ts';
import { createEmbedder } from './embeddings.ts';
import { clamp, rand } from './sim/util.ts';
import { Regions } from './sim/regions.ts';
import { Movement } from './sim/movement.ts';
import { Planning } from './sim/planning.ts';
import { Actions } from './sim/actions.ts';
import { Cognition } from './sim/cognition.ts';
import { Social } from './sim/social.ts';
import { Views } from './sim/views.ts';
import { Persistence } from './sim/persistence.ts';
import { Metrics } from './sim/metrics.ts';
import { Dark } from './sim/dark.ts';
import { Combat } from './sim/combat.ts';
import { get as setting } from './settings/index.ts';
import type { Embedder } from './embeddings.ts';
import type { WorldSpec, Params, Persona } from './types/spec.ts';
import type { OpRecord } from './types/ops.ts';
import type { Cell, GenWorld } from './types/map.ts';
import type { LiveAgent } from './types/agent.ts';
import type { ConvoRecord, Entity, LogItem, Newspaper, SaveV2 } from './types/save.ts';
import type { Convo, DarkState, MetricsDay, TownOptions } from './types/town.ts';
import type { Decision } from './kernel/decisions.ts';
import type { ThreadState } from './story/threads.ts';
import type { MigrationState } from './story/migration.ts';
import type { Creature, Portal } from './story/creatures.ts';
import type { ArcRun } from './story/arcs.ts';
import type { StoryState } from './story/director.ts';
import type { Architect, ArchitectItem, ArchitectUsage, Gap } from '../plugins/builtin/architect/architect.ts';
import type { PressureState } from './worldai/pressure.ts';
import type { Scene } from './story/scene.ts';
import type { Proposal, Vote } from './types/story.ts';
import type { EffectCtx, Pos } from './kernel/effects.ts';
import type { BuildingDef } from './kernel/placement.ts';
import type { OpCause } from './types/ops.ts';

export type { DarkState } from './types/town.ts';

const MAX_STRUCTURES = 30;
// 改变地图上建筑的世界操作：落地后重建地图（syncMap）
const MAP_OPS = new Set(['expandMap', 'addBuilding', 'setBuildingState', 'renovateBuilding', 'removeBuilding', 'restoreBuilding', 'addPath', 'addBridge', 'clearArea', 'plantGrove', 'addOutdoorPlace']);

// 各职责模块（server/sim/）的方法经文件末尾的 mixin 挂到 Town.prototype 上；这里用声明合并让类型也知道它们
export interface Town extends Regions, Movement, Planning, Actions, Cognition, Social, Views, Persistence, Metrics, Dark, Combat {}

export class Town extends EventEmitter {
  // 字段只做类型声明（declare）：类型剥离后不生成任何代码，初始化仍在构造函数与各模块里，运行行为不变
  // ---- 配置与存档 ----
  declare opts: TownOptions;
  declare dataDir: string;
  declare saveFile: string;
  declare instantTalk: boolean;
  declare pacing: boolean;
  declare queueSize: (() => number) | null;
  declare journal: OpJournal;
  declare embedder: Embedder;
  declare worldId: string;
  declare pack: TownOptions['pack'];
  declare packHash: string;
  declare worldSettings: NonNullable<TownOptions['worldSettings']>;
  declare mods: Array<{ id: string; name: string; ops: number }>;
  // ---- 世界规格与地图 ----
  /** 默认规格 + Mod：之后叠加插件内容与存档中的操作历史 */
  declare baseSpec: WorldSpec;
  declare spec: WorldSpec;
  declare specOps: OpRecord[];
  /** 插件带来的数据内容（自主演化 §5.2 T0/T1） */
  declare overlays: Array<{ id: string; ops: Array<{ op: string; args?: Record<string, unknown> }> }>;
  declare regions: Record<string, GenWorld>;
  declare world: GenWorld;
  // ---- 时间与天气 ----
  declare t: number;
  declare speed: number;
  declare paused: boolean;
  declare weather: string;
  declare weatherLock: SaveV2['weatherLock'];
  declare nextWeatherT: number;
  // ---- 居民 ----
  /** 在场的角色 */
  declare agents: LiveAgent[];
  /** 离开小镇的角色（数据保留，可以回来） */
  declare away: LiveAgent[];
  declare byId: Record<string, LiveAgent>;
  declare convos: Map<string, Convo>;
  declare convoLog: ConvoRecord[];
  declare logs: LogItem[];
  declare newspapers: Newspaper[];
  declare board: unknown[];
  declare pairCd: Record<string, number>;
  declare flags: Record<string, unknown>;
  declare seq: number;
  // ---- 运行时世界状态 ----
  /** 构筑物等临时实体（例如萤火结界） */
  declare entities: Entity[];
  /** 效果原语 flag 写入的世界标记 */
  declare worldFlags: Record<string, unknown>;
  /** 效果原语 paramMod 带来的临时参数调整 */
  declare paramMods: Array<{ name: keyof Params; mul?: number; add?: number; until: number; source: string }>;
  declare ruleState: SaveV2['ruleState'];
  declare rules: RuleEngine;
  // ---- 叙事、异界与黑暗叙事（各子系统自己的状态结构较大，B6 迁移子系统时再细化） ----
  declare threadState: Record<string, ThreadState>;
  declare crisis: SaveV2['crisis'];
  declare discovered: string[];
  declare encounterCd: Record<string, number>;
  declare story: StoryState | undefined;
  declare migrationState: MigrationState | undefined;
  /** 地图演变的状态：压力表、拆除否决（建筑 id → 第几天之前不能再提） */
  declare mapState: { pressure?: PressureState; vetoes?: Record<string, number>; [k: string]: unknown } | undefined;
  declare arcRuns: ArcRun[];
  declare voteState: Vote[];
  declare pendingScenes: Scene[];
  declare creatureList: Creature[];
  declare dark: DarkState;
  declare fights: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- TODO(types): 战斗记录（sim/combat）
  declare portalState: Portal | null;
  declare swarmGoal: string | null;
  /** 异界生物：上次捣乱、上次和平相遇、上次群体心智的游戏分钟 */
  /** 运行时抽样审核已经看过的编年 / 动态（worlds/review.ts） */
  declare sampled?: Set<string>;
  declare mischiefAt?: number;
  declare peacefulAt?: number;
  declare swarmAt?: number;
  declare proposals: Proposal[];
  declare decisionState: Decision[];
  declare architectQueue: ArchitectItem[];
  declare gaps: Gap[];
  declare architectUsage: ArchitectUsage | undefined;
  /** 世界架构师插件（plugins/builtin/architect）装上时设置 */
  declare architect: Architect | null;
  declare usage: { days: Record<string, { tokens: number; calls: number; byLabel: Record<string, { calls: number; tokens: number }>; speed: number }>; mark: unknown } | undefined;
  declare metricsState: { days: Record<string, MetricsDay> };
  // ---- 子系统 ----
  declare decisions: DecisionQueue;
  declare director: Director;
  declare arcs: ArcEngine;
  declare scenes: SceneManager;
  declare votes: VoteSystem;
  declare creatures: CreatureSystem;
  declare threats: ThreatSystem;
  declare migration: MigrationSystem;
  declare avatars: AvatarSystem;
  declare proposalSystem: ProposalSystem;
  declare council: Council;
  declare mapPressure: MapPressure;
  declare hooks: HookBus;
  declare plugins: PluginHost;
  declare evolved: EvolvedManager;
  // ---- 主循环与托管方设置的状态（worlds/host.ts、worlds/manager.ts） ----
  declare timer: NodeJS.Timeout | null;
  declare acc?: { convo: number; snapshot: number; save: number };
  declare faults?: Map<string, number>;
  /** 对话里等待台词说完的计时器（Town.stop() 时结束） */
  declare sleepers?: Set<() => void>;
  declare stopped?: boolean;
  /** 无人观看，休眠中 */
  declare idle?: boolean;
  /** 世界自带的模型服务出了致命错误，世界暂停（world-llm） */
  declare halted?: { code: string; text: string } | null;
  declare diskFull?: boolean;
  declare nightSkip?: boolean;
  declare paced: number;
  declare wantsSnapshot?: () => boolean;
  declare snapshotEvery?: () => number;
  declare hookHour?: number;
  declare crisisHour?: number;
  declare fightMinute?: number;
  declare lastSnapHour?: number;

  constructor(opts: TownOptions = {}) {
    super();
    this.dataDir = path.resolve(opts.dataDir || setting('DATA_DIR'));
    this.saveFile = path.join(this.dataDir, 'save.json');
    this.instantTalk = Boolean(opts.instantTalk);
    this.pacing = opts.pacing ?? setting('PACE_WITH_LLM');
    this.queueSize = opts.queueSize || null; // 测试可注入
    this.journal = new OpJournal(path.join(this.dataDir, 'ops.jsonl'));
    // 可选的 embedding（EMBED_MODEL）：记忆检索参考语义相似度；向量缓存在 <数据目录>/embeddings.db
    this.opts = opts;
    this.embedder = opts.embedder || createEmbedder({ dir: this.dataDir, worldId: opts.worldId || 'yunxi' });
    const saved = this.readSave();
    // 世界规格 = 默认规格 + 存档中的操作历史重放
    this.specOps = Array.isArray(saved?.specOps) ? saved.specOps : [];
    // 世界包（多世界设计 §3）：opts.pack 不传时是官方世界云溪镇；worldSettings 是世界级设置（分级、叙事者、Mod）
    this.worldId = opts.worldId || 'yunxi';
    this.pack = opts.pack || null;
    const ws = opts.worldSettings || null;
    this.worldSettings = ws || {};
    const base = () => (this.pack ? packSpec(this.pack, ws || {}) : defaultSpec(ws ? { STORY_RATING: ws.rating, STORYTELLER: ws.storyteller } : process.env));
    this.packHash = (this.pack || officialPack('yunxi')).hash;
    const baseErrs = validateSpec(base());
    if (baseErrs.length) throw new Error(`世界规格不合法：${baseErrs.join('；')}`);
    if (saved?.packHash && saved.packHash !== this.packHash) console.log(`[save] ${this.worldId}：世界包已更新（${saved.packHash} → ${this.packHash}），按操作历史重放`);
    // Mod 叠加在世界包之上、存档之下（世界设置里的 mods，或 MODS / opts.mods）
    const modNames = opts.mods ?? ws?.mods ?? setting('MODS');
    const m = applyMods(base(), modNames, opts.modsDir);
    for (const k of m.skipped) console.warn(`[mod] ${k.mod}${k.op ? ` / ${k.op}` : ''}：${k.error}`);
    if (m.loaded.length) console.log(`[mod] 已加载：${m.loaded.map((x) => `${x.name}（${x.ops} 项）`).join('、')}`);
    this.mods = m.loaded;
    this.baseSpec = m.spec; // 默认规格 + Mod：之后叠加插件内容与存档中的操作历史
    // 自主演化：AI 插件在重放操作历史之前加载（T2 的效果要先注册，T0 / T1 的内容作为覆盖层）
    this.evolved = new EvolvedManager(this, opts.evolution);
    this.overlays = this.evolved.preload(); // 插件带来的数据内容 [{ id, ops }]（自主演化 §5.2 T0/T1）
    let withPlugins = m.spec;
    for (const o of this.overlays) withPlugins = replay(withPlugins, o.ops.map((x, i) => ({ seq: i + 1, ...x }))).spec;
    const { spec, skipped } = replay(withPlugins, this.specOps);
    for (const k of skipped) console.warn(`[spec] 跳过无法重放的操作 #${k.seq} ${k.op}：${k.error}`);
    this.spec = spec;
    // 区域：主地图（id 为 town）+ 其他区域（例如暗月界，口袋地图，默认关闭，由剧情或管理员打开）
    this.regions = buildRegions(this.spec);
    this.world = this.regions.town;
    this.t = 6 * 60 + 15;
    this.speed = 1;
    this.paused = false;
    // 没有「晴」的世界（例如夜巡）用它的第一种天气作为开局天气
    this.weather = Object.hasOwn(this.spec.weather, 'sunny') ? 'sunny' : Object.keys(this.spec.weather)[0];
    this.weatherLock = false;
    this.nextWeatherT = this.t + 180;
    // agents：在场的角色；away：离开小镇的角色（数据保留，可以回来）
    this.agents = this.spec.personas.map((p) => this.createAgent(p));
    this.away = [];
    this.byId = Object.fromEntries(this.agents.map((a) => [a.id, a]));
    this.convos = new Map();
    this.convoLog = [];
    this.logs = [];
    this.newspapers = [];
    this.board = [];
    this.pairCd = {};
    this.flags = {};
    this.seq = 0;
    // P1：运行时世界状态
    this.entities = []; // 构筑物等临时实体（例如萤火结界）
    this.worldFlags = {}; // 效果原语 flag 写入的世界标记
    this.paramMods = []; // 效果原语 paramMod 带来的临时参数调整
    this.ruleState = { every: {}, at: {} };
    this.rules = new RuleEngine(this);
    // P2 / P3：叙事与异界
    this.threadState = {};
    this.crisis = { morale: 70, supplies: 80 };
    this.discovered = [];
    this.encounterCd = {};
    // 自主演化 E1：统一决策队列（管理员终审窗口超时后由 AI 裁决官决定）
    this.decisions = new DecisionQueue(this, { now: opts.now });
    this.director = new Director(this);
    this.arcs = new ArcEngine(this);
    this.scenes = new SceneManager(this);
    this.votes = new VoteSystem(this);
    this.creatures = new CreatureSystem(this);
    // 黑暗叙事：规律型威胁、事件、人口、死亡（世界包没有 threats 时不运行）
    this.dark = freshDark();
    this.fights = [];
    this.threats = new ThreatSystem(this, { random: opts.random });
    this.migration = new MigrationSystem(this, { random: opts.random });
    this.avatars = new AvatarSystem(this);
    // P4：建设提案（世界架构师、施工等功能由 plugins/builtin/ 下的插件提供）
    this.proposalSystem = new ProposalSystem(this);
    this.council = new Council(this); // 拆除的议事（地图演变 §3.4）
    this.mapPressure = new MapPressure(this); // 地图压力表（地图演变 §6.1）
    this.architect = null;
    // 自主演化 E0：钩子总线 + 插件宿主
    this.hooks = new HookBus();
    this.plugins = new PluginHost(this, { disable: opts.disablePlugins });
    this.evolved.init();
    this.load(saved);
    this.syncAgents(false);
    this.threats.init();
  }

  get day() { return Math.floor(this.t / 1440) + 1; }

  get minute() { return this.t % 1440; }

  get weekday() { return weekdayOf(this.spec, this.day); }

  /** 生效中的内核参数 = 规格参数 + 临时调整（始终夹在上下限之内） */
  get params(): Params {
    if (!this.paramMods.length) return this.spec.params;
    const out: Params = { ...this.spec.params };
    for (const m of this.paramMods) {
      if (!Object.hasOwn(out, m.name)) continue;
      let v = out[m.name]!;
      if (m.mul != null) v *= m.mul;
      if (m.add != null) v += m.add;
      const [lo, hi] = PARAM_BOUNDS[m.name];
      out[m.name] = clamp(m.name === 'maxConvos' ? Math.round(v) : v, lo, hi);
    }
    return out;
  }

  get dayEnd() { return this.spec.params.dayEnd; }

  festivalHint() { return calendarHint(this.spec, this.day); }

  weatherText() { return this.spec.weather[this.weather]?.name || this.weather; }

  locName(id: string | null | undefined): string { return this.findLocation(id as string)?.name || (Object.hasOwn(this.spec.locations, id as string) && this.spec.locations[id as string]!.name) || (id as string); }

  createAgent(p: Persona): LiveAgent {
    const home = this.world.locations[p.home];
    const b = home?.indoor ? this.world.buildings.find((x) => x.id === home.indoor) : null;
    // 没有房子的角色（例如暗月守门人）出现在所属地点的某个站位
    const spot = b ? b.entrance : (home?.spots?.[0] || this.locCenter(p.home) || { x: 50, y: 34 });
    const a: LiveAgent = {
      id: p.id, name: p.name, age: p.age, role: p.role, persona: p.persona, goal: p.goal, look: p.look, ...(p.tier ? { tier: p.tier } : {}),
      home: p.home, work: p.work,
      x: spot.x, y: spot.y, dir: 'down', moving: false, inside: b ? b.id : null, locId: p.home, region: 'town',
      status: 'sleeping', action: { text: '睡觉', emoji: '😴' }, thought: '', mood: { text: '平静', emoji: '🙂' },
      schedule: [], scheduleDay: 0, curKey: null, path: [], dest: null,
      memories: [], relations: {}, diary: [], importanceAcc: 0,
      thinking: 0, thinkingLabel: '', convoId: null, lastConvoEnd: -999, lastThoughtT: -999, lastReflectT: 0,
      bubble: null, visitorChats: {}, diaryDay: 0,
      // 通用组件（设计文档 4.2）：P0 先建立数据结构，能力与对抗系统在后续阶段接入
      kind: p.kind || 'resident',
      body: { hp: 100, stamina: 100, courage: 50, conditions: [] },
      inventory: { ...(p.start?.inventory || {}) }, abilities: [...(p.start?.abilities || [])], beliefs: [], growth: [],
      cooldowns: {}, kit: 1, // kit：已发放初始物品与能力（旧存档读档时补发）
    };
    for (const [id, [aff, note]] of Object.entries(p.relations)) a.relations[id] = { affinity: aff, note };
    this.initDarkAgent(a, p);
    for (const text of p.memories) addMemory(a, { t: Math.max(0, this.t - 60 * (1 + Math.random() * 5)), type: 'obs', text, importance: 6 });
    a.importanceAcc = 0;
    return a;
  }

  log(type: string, text: string, extra: Record<string, unknown> = {}): LogItem {
    const item: LogItem = { id: ++this.seq, t: this.t, type, text, ...extra };
    this.logs.push(item);
    if (this.logs.length > 400) this.logs.shift();
    this.emit('log', item);
    return item;
  }

  say(a: LiveAgent, text: string, ms = 5000, kind = 'say'): void {
    a.bubble = { id: ++this.seq, text, kind, until: Date.now() + ms };
  }

  async think<T>(a: LiveAgent, label: string, fn: () => Promise<T>): Promise<T> {
    a.thinking++;
    a.thinkingLabel = label;
    this.emit('agent', a.id);
    try {
      return await fn();
    } finally {
      a.thinking--;
      if (!a.thinking) a.thinkingLabel = '';
      this.emit('agent', a.id);
    }
  }

  start(): void {
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dtReal = Math.min(0.5, (now - last) / 1000);
      last = now;
      // 一个世界的模拟出错不能让整个进程崩溃（所有世界一起停、守护进程反复重启）：记下来，下一个 tick 继续
      try { this.advance(dtReal); } catch (e) { this.fault('tick', e); }
    }, 50);
  }

  /** 模拟出错：打日志（同一处错误每分钟最多一次），不抛出 */
  fault(where: string, err: unknown): void {
    const e = err as Error | null | undefined;
    const key = `${where}|${e?.message}`;
    const now = Date.now();
    this.faults ||= new Map();
    if (now - (this.faults.get(key) || 0) < 60_000) return;
    this.faults.set(key, now);
    console.error(`[sim] ${this.worldId} ${where} 出错（已跳过，世界继续运行）：`, e?.stack || e);
  }

  /** 推进一次模拟（dtReal 为真实秒数）。主循环与无头测试共用。 */
  advance(dtReal: number): void {
    const acc = (this.acc ||= { convo: 0, snapshot: 0, save: 0 });
    // halted：世界自带的模型服务出了致命错误，世界暂停（{ code, text }，见 world-llm.js），和休眠一样停在原地
    if (!this.paused && !this.idle && !this.halted) {
      // 深夜全员熟睡时自动快进，避免漫长的空白夜晚
      this.nightSkip = this.convos.size === 0 && this.agents.every((a) => a.status === 'sleeping');
      // 随 AI 负载放慢：模型排队太长时时间流速按比例降低，避免游戏时间跑在思考前面（最低 1/4）
      this.paced = 1;
      if (this.pacing && llm.enabled() && !this.nightSkip) {
        // 按世界调速：看本世界在队列里的积压，一个世界卡住不会拖慢所有世界的时钟
        const q = this.queueSize ? this.queueSize() : llm.queueSize(this.worldId);
        const cap = setting('PACE_QUEUE'); // 模型排队超过这个数时开始放慢时间
        if (q > cap) this.paced = Math.max(0.25, cap / q);
      }
      const dtGame = dtReal * (this.nightSkip ? Math.max(this.speed, 15) : this.speed * this.paced);
      this.t += dtGame;
      // 逐个居民隔离：一个人的状态出错时让他原地停下，不影响其他人（遍历副本：更新过程中可能有人死去或离开）
      for (const a of [...this.agents]) {
        if (!this.agents.includes(a)) continue; // 这一轮里已经死去或离开
        try { this.updateAgent(a, dtGame); } catch (e) {
          this.fault(`居民 ${a.id}`, e);
          Object.assign(a, { path: [], dest: null, moving: false, curKey: null, status: a.status === 'walking' ? 'idle' : a.status });
        }
      }
      this.expire();
      this.rules.tick();
      this.creatures.tick(dtGame);
      this.threats.tick(dtGame);
      this.combatTick();
      this.darkHourly();
      this.scenes.tick();
      this.votes.tick();
      this.arcs.tick();
      this.director.tick();
      this.migration.tick();
      this.proposalSystem.tick();
      this.council.tick();
      this.decisions.tick();
      this.evolved.tick();
      this.hooks.emit('tick', dtGame);
      this.hourHooks();
      this.crisisTick();
      this.dailyHooks();
      this.autoWeather();
      acc.convo += dtReal;
      if (acc.convo > 0.8) { acc.convo = 0; this.checkConversations(); }
    }
    // 访客化身按真实时间行走（暂停、调速都不影响玩家操作）
    this.avatars.tick(dtReal);
    acc.snapshot += dtReal;
    // 快照：托管方可以调低频率（snapshotEvery，秒），没有观众时（wantsSnapshot 为假）不生成
    if (acc.snapshot >= (this.snapshotEvery ? this.snapshotEvery() : 0.1)) {
      acc.snapshot = 0;
      if (!this.wantsSnapshot || this.wantsSnapshot()) this.emit('tick', this.snapshot());
    }
    acc.save += dtReal;
    if (acc.save > 20) { acc.save = 0; this.save(); }
  }

  /** 整点与新一天的钩子 */
  hourHooks() {
    const hour = Math.floor(this.t / 60);
    if (this.hookHour === hour) return;
    const first = this.hookHour == null;
    this.hookHour = hour;
    if (first) return; // 启动（或读档）后的第一个整点不补发
    if (hour % 24 === 0) this.hooks.emit('dayStart', { day: this.day });
    this.hooks.emit('hour', { day: this.day, hour: hour % 24 });
  }

  /** 停下并释放（重构方案 §6.5）：主循环、对话等待的计时器、插件沙箱、embedding 数据库、事件监听 */
  stop(): void {
    this.plugins?.stop();
    this.evolved?.stop();
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    for (const done of [...(this.sleepers || [])]) done();
    this.removeAllListeners();
    this.stopped = true;
    if (!this.opts?.embedder) this.embedder?.close();
  }

  /** 世界作息（world.json 的 rhythm）：规划、日记、编年的时刻，单位为分钟 */
  get rhythm(): { plan: number; diary: number; chronicle: number } {
    const r = this.spec.rhythm || {};
    // 写错的时刻解析为 null，比较时按 0 处理（与迁移前一致）
    return { plan: parseHM(r.plan ?? '05:30') as number, diary: parseHM(r.diary ?? '22:15') as number, chronicle: parseHM(r.chronicle ?? '22:45') as number };
  }

  dailyHooks() {
    const m = this.minute, d = this.day;
    const rh = this.rhythm;
    if (m >= rh.plan && m < this.dayEnd && this.flags.plannedDay !== d) this.planAll();
    if (m >= 6 * 60 && this.flags.pressureDay !== d) { this.flags.pressureDay = d; this.mapPressure.daily(); }
    if (m >= rh.diary && this.flags.diaryDay !== d) {
      this.flags.diaryDay = d;
      // 写完日记顺便整理记忆：太多时把较早一天的琐事浓缩成一条
      for (const a of this.agents) if (a.kind !== 'creature') this.writeDiary(a).then(() => this.condenseMemories(a)).catch(() => {});
    }
    if (m >= rh.chronicle && this.flags.newsDay !== d) {
      this.flags.newsDay = d;
      this.makeNewspaper().catch(() => {});
    }
  }

  autoWeather() {
    if (this.weatherLock || this.t < this.nextWeatherT) return;
    this.nextWeatherT = this.t + 120 + Math.random() * 240;
    const w = pickWeather(this.spec, this.minute);
    if (w !== this.weather) {
      this.weather = w;
      const info = this.spec.weather[w];
      this.log('weather', `天气转为${info.emoji} ${info.name}`);
      this.rules.onWeather(w);
    }
  }

  setWeather(w: string): void {
    if (w === 'auto') { this.weatherLock = false; this.nextWeatherT = this.t; return; }
    if (!Object.hasOwn(this.spec.weather, w)) return;
    const info = this.spec.weather[w];
    this.weather = w;
    this.weatherLock = true;
    this.log('weather', `天空听从了你的意志：${info.emoji} ${info.name}`);
    this.rules.onWeather(w);
  }

  spawnStructure(type: string, at: Cell & Partial<Pos>, ttl: number, ctx: EffectCtx = {}): Entity | null {
    const def = this.spec.structures[type];
    if (!def) return null;
    const e: Entity = {
      id: `s${++this.seq}`, kind: 'structure', type, name: def.name, emoji: def.emoji, tags: [...def.tags],
      ...(def.light ? { light: def.light } : {}), x: at.x, y: at.y, inside: at.inside || null, region: at.region || 'town', until: this.t + ttl, owner: ctx.self?.id || null,
    };
    this.entities.push(e);
    if (this.entities.length > MAX_STRUCTURES) this.entities.shift();
    return e;
  }

  addParamMod(m: Town['paramMods'][number]): void {
    this.paramMods.push(m);
    if (this.paramMods.length > 10) this.paramMods.shift();
  }

  expire() {
    if (this.entities.some((e) => e.until! <= this.t)) this.entities = this.entities.filter((e) => e.until! > this.t);
    if (this.paramMods.some((m) => m.until <= this.t)) this.paramMods = this.paramMods.filter((m) => m.until > this.t);
  }

  /** 让 agents / away 与世界规格中的角色状态保持一致（新角色登场、离开、回来） */
  syncAgents(emit = true): boolean {
    let changed = false;
    for (const p of this.spec.personas) {
      let a = this.byId[p.id];
      if (!a) {
        a = this.createAgent(p);
        this.byId[p.id] = a;
        this.agents.push(a);
        changed = true;
      }
      // 离开的人和死去的人都不在场（死者的数据留在 away 里，状态是 dead）
      const gone = p.status === 'departed' || p.status === 'dead';
      const here = this.agents.includes(a);
      if (gone && here) {
        this.agents.splice(this.agents.indexOf(a), 1);
        this.away.push(a);
        Object.assign(a, { status: p.status === 'dead' ? 'dead' : 'away', convoId: null, path: [], dest: null, bubble: null, pendingAct: null });
        changed = true;
      } else if (!gone && !here) {
        this.away = this.away.filter((x) => x !== a);
        this.agents.push(a);
        Object.assign(a, { status: 'idle', curKey: null });
        changed = true;
      }
    }
    if (changed && emit) this.emit('agents', this.agentsMeta());
    return changed;
  }

  /** 剧情角色登场：写入世界规格（或恢复在场），出现在指定地点 */
  enterStage(cast: Persona, at: string, source = 'arc'): LiveAgent {
    const p = this.spec.personas.find((x) => x.id === cast.id);
    if (!p) this.applyWorldOp({ op: 'addPersona', args: cast }, { by: source }, { quiet: true });
    else if (p.status === 'departed') this.applyWorldOp({ op: 'setPersonaStatus', args: { id: cast.id, status: 'active' } }, { by: source }, { quiet: true });
    else if (this.agents.includes(this.byId[cast.id]!)) return this.byId[cast.id]!;
    this.syncAgents();
    const a = this.byId[cast.id]!;
    const loc = this.findLocation(at);
    const s = (loc?.spots?.length ? rand(loc.spots) : this.locCenter(at))!;
    Object.assign(a, { x: s.x, y: s.y, inside: null, locId: at, region: this.locRegion(at), status: 'acting', path: [], dest: null, curKey: null, action: { text: '四处张望', emoji: '👀' } });
    this.emit('vfx', { preset: 'burst', x: s.x, y: s.y, color: '#b58cff', radius: 2, region: a.region });
    this.log('arrival', a.kind === 'creature' ? `🌑 ${a.name}从裂隙中现身了` : `🌀 ${a.name}从裂隙中跌了出来——${a.role}`, { agents: [a.id] });
    if (a.kind === 'traveller') this.replan(a, `你刚从一道紫色的裂隙中跌出来，落在了${this.locName(at)}。这里的一切都很陌生。`).catch(() => {});
    return a;
  }

  depart(id: string, source = 'arc', text: string | null = null): boolean {
    const p = this.spec.personas.find((x) => x.id === id);
    if (!p || p.status === 'departed') return false;
    const a = this.byId[id];
    this.applyWorldOp({ op: 'setPersonaStatus', args: { id, status: 'departed' } }, { by: source }, { quiet: true });
    this.syncAgents();
    if (a) this.log('depart', text || `👋 ${a.name}离开了${this.spec.voice?.place || '小镇'}`, { agents: [id] });
    return true;
  }

  /** 剧情设置的天气：持续一段时间后恢复自动天气 */
  setWeatherFor(id: string, minutes = 180): void {
    const info = this.spec.weather[id];
    if (!info) return;
    this.weather = id;
    this.weatherLock = false;
    this.nextWeatherT = this.t + minutes;
    this.log('weather', `天气转为${info.emoji} ${info.name}`);
    this.rules.onWeather(id);
  }

  sendToClinic(a: LiveAgent): void {
    const m = Math.floor(this.minute) + 1;
    if (m >= 22 * 60) return;
    // 有诊所就去诊所（医生会记住这件事），没有就回家休息
    const clinic = this.findLocation('clinic') ? 'clinic' : 'home';
    this.insertEntry(a, { start: m, end: Math.min(m + 60, 23 * 60), location: clinic, activity: clinic === 'clinic' ? '在诊所休息' : '回家休息', emoji: '🏥', src: 'commit' });
    const doc = clinic === 'clinic' ? this.agents.find((x) => x.work === 'clinic' && x.kind !== 'creature') : null;
    if (doc && doc !== a) addMemory(doc, { t: this.t, type: 'event', text: `${a.name}被吓晕了，送到了${this.locName('clinic')}`, importance: 6 });
  }

  /** 按游戏日记录 token 用量（每天清晨结算前一天），用于估算真实的日用量 */
  recordUsage(): void {
    const u = (this.usage ||= { days: {}, mark: null }) as { days: Record<string, any>; mark: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- 用量快照的结构见下
    const now = { tokens: llm.stats.promptTokens + llm.stats.completionTokens, calls: llm.stats.calls, byLabel: structuredClone(llm.stats.byLabel) };
    if (u.mark && this.day > 1) {
      const byLabel: Record<string, { calls: number; tokens: number }> = {};
      for (const [k, v] of Object.entries(now.byLabel)) {
        const p = u.mark.byLabel[k] || { calls: 0, tokens: 0 };
        if (v.calls - p.calls > 0) byLabel[k] = { calls: v.calls - p.calls, tokens: v.tokens - p.tokens };
      }
      // 重启会让进程内的计数归零：出现负数时说明这一天跨越了重启，不记录
      if (now.tokens >= u.mark.tokens) u.days[this.day - 1] = { tokens: now.tokens - u.mark.tokens, calls: now.calls - u.mark.calls, byLabel, speed: this.speed };
    }
    u.mark = now;
    const keys = Object.keys(u.days).map(Number).sort((a, b) => a - b);
    for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete u.days[k];
  }

  crisisTick(): void {
    const hour = Math.floor(this.t / 60);
    if (this.crisisHour === hour) return;
    this.crisisHour = hour;
    const c = this.crisis;
    c.supplies = Math.min(100, c.supplies + 1);
    c.morale += c.morale < 70 ? 1 : c.morale > 70 ? -1 : 0;
  }

  storyContext() { return this.arcs.contextText(); }

  /**
   * 应用一条 WorldOp（设计文档 4.3）：校验 → 应用到规格 → 记入存档历史与审计日志 → 通知前端。
   * cause：变更来源，例如 {by: 'admin'} / {by: 'architect', proposal: 'wp_1'}；参数由各操作的 check() 校验
   */
  applyWorldOp(op: { op: string; args?: Record<string, any> }, cause: OpCause = { by: 'system' }, { quiet = false }: { quiet?: boolean } = {}): OpRecord { // eslint-disable-line @typescript-eslint/no-explicit-any
    const rec = { seq: (this.specOps.at(-1)?.seq || 0) + 1, t: Math.floor(this.t), op: op.op, args: op.args || {}, cause } as OpRecord;
    if (rec.op === 'addBuilding') {
      // 先做静态检查，再以新建筑重建地图校验占地与连通性
      const def = OPS.addBuilding!.check(this.spec, rec.args);
      if (def) throw new OpError(def);
      const err = checkPlacement(this.spec, rec.args as unknown as BuildingDef);
      if (err) throw new OpError(`放不下：${err}`);
    }
    const prev = this.spec;
    this.spec = applyOp(this.spec, rec, rec);
    if (MAP_OPS.has(rec.op)) { const moved = this.shiftByOffsets(prev); this.syncMap(prev, moved); }
    const args = rec.args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (rec.op === 'addRegion' || rec.op === 'linkRegions' || rec.op === 'addAdjacentRegion' || (rec.op === 'expandMap' && (args.region || 'town') !== 'town')) this.rebuildRegions();
    if (rec.op === 'addAdjacentRegion') this.seedRegionRumors(args.id);
    this.specOps.push(rec);
    this.journal.append(rec);
    const desc = OPS[rec.op]!.describe?.(rec.args, prev) || rec.op; // 用操作之前的规格描述（拆除、改建之后旧名字就找不到了）
    if (!quiet) this.log('world', `🌀 世界发生了变化：${desc}`, { op: rec.op, seq: rec.seq });
    this.emit('world', { spec: publicSpec(this.spec), op: rec, desc, ...(quiet ? { quiet: true } : {}) });
    return rec;
  }

  /**
   * 重新计算世界规格：默认规格 + Mod + 插件内容覆盖层 + 操作历史。
   * 插件被停用 / 回滚、或撤销某个提案时使用；返回重放时被跳过的操作数。
   */
  rebuildSpec(): number {
    let spec = this.baseSpec;
    for (const o of this.overlays) {
      const r = replay(spec, o.ops.map((x, i) => ({ seq: i + 1, op: x.op, args: x.args })));
      spec = r.spec;
      for (const k of r.skipped) console.warn(`[plugin] ${o.id} 的内容 ${k.op} 无法应用：${k.error}`);
    }
    const r = replay(spec, this.specOps);
    const hadBuildings = JSON.stringify(this.spec.buildings);
    const hadRegions = JSON.stringify(this.spec.regions);
    this.spec = r.spec;
    const moved = this.shiftByOffsets({ regions: JSON.parse(hadRegions) });
    if (JSON.stringify(this.spec.regions) !== hadRegions) { this.rebuildRegions(); if (moved) this.syncMap(null, moved); }
    else if (JSON.stringify(this.spec.buildings) !== hadBuildings) this.syncMap(null);
    for (const a of this.agents) a.abilities = a.abilities.filter((id) => findAbility(this.spec, id));
    this.emit('world', { spec: publicSpec(this.spec), op: null, desc: '世界规格已重新计算' });
    return r.skipped.length;
  }

  /** 撤销满足条件的世界操作（从操作历史中移除后重算规格）；返回撤销的数量 */
  revertOps(pred: (r: OpRecord) => boolean): number {
    const before = this.specOps.length;
    const removed = this.specOps.filter(pred);
    this.specOps = this.specOps.filter((r) => !pred(r));
    for (const r of removed) this.journal.append({ op: 'revert', seq: r.seq, cause: r.cause, at: new Date().toISOString() });
    if (removed.length) this.rebuildSpec();
    return before - this.specOps.length;
  }

  /** 设置插件内容覆盖层（null 表示移除）并重算规格 */
  setOverlay(id: string, ops: Town['overlays'][number]['ops'] | null): void {
    this.overlays = this.overlays.filter((o) => o.id !== id);
    if (ops) this.overlays.push({ id, ops });
    this.rebuildSpec();
  }

  /**
   * 建筑变化（新建、改建、停业、废墟、拆除、修复）之后：重建地图，并让运行时状态跟上——
   * 居民的住处与工作地按规格同步（拆除时的搬迁）；待在进不去的建筑里的人走到门口；原定在已消失地点的场景取消。
   */
  syncMap(prev: WorldSpec | null = null, moved: { dx: number; dy: number } | null = null): void {
    const old = this.world;
    this.rebuildWorld(moved);
    const personas = Object.fromEntries(this.spec.personas.map((p) => [p.id, p]));
    for (const a of [...this.agents, ...this.away]) {
      const p = personas[a.id];
      if (p && p.kind !== 'creature') { a.home = p.home; a.work = p.work; }
    }
    for (const a of this.agents) {
      if (!a.inside) continue;
      const b = this.world.buildings.find((x) => x.id === a.inside);
      const gone = !b || b.state === 'ruin' || (b.state && a.home !== b.id);
      if (!gone) continue;
      const e = (b || old.buildings.find((x) => x.id === a.inside))?.entrance;
      Object.assign(a, { inside: null, curKey: null, path: [], dest: null, status: a.status === 'sleeping' ? 'idle' : a.status, ...(e ? { x: e.x, y: e.y } : {}) });
    }
    const lost = (this.pendingScenes || []).filter((sc) => !this.findLocation(sc.location));
    if (lost.length) {
      this.pendingScenes = this.pendingScenes.filter((sc) => !lost.includes(sc));
      for (const sc of lost) this.log('scene_plan', `🗓️ 原定在${prev?.locations?.[sc.location]?.name || '那里'}的「${sc.title}」取消了：那个地方已经不在了`, { agents: sc.members || [] });
    }
  }

  /**
   * 地图向西 / 向北扩展（或撤销扩展）时，区域的偏移变了：把这个区域里一切运行时的坐标跟着平移，
   * 让规格（重放得到的）与存档里的位置始终在同一个坐标系。返回 { dx, dy } 或 null。
   */
  shiftByOffsets(prevSpec: { regions?: WorldSpec['regions'] } | null): { dx: number; dy: number } | null {
    let moved: { dx: number; dy: number } | null = null;
    for (const r of this.spec.regions) {
      const before = prevSpec?.regions?.find((x) => x.id === r.id)?.offset || { x: 0, y: 0 };
      const dx = (r.offset?.x || 0) - (before.x || 0), dy = (r.offset?.y || 0) - (before.y || 0);
      if (!dx && !dy) continue;
      this.shiftRuntime(r.id, dx, dy);
      if (r.id === 'town') moved = { dx, dy };
    }
    return moved;
  }

  shiftRuntime(region: string, dx: number, dy: number): void {
    const inR = (o: { region?: string | null }) => (o.region || 'town') === region;
    const mv = (p: { x: number; y: number } | null | undefined) => { if (p) { p.x += dx; p.y += dy; } };
    for (const a of this.agents) if (inR(a)) { mv(a); Object.assign(a, { path: [], dest: null, curKey: null, moving: false }); if (a.status === 'walking') a.status = 'idle'; }
    for (const c of this.creatures.list) if (inR(c)) { mv(c); c.path = []; }
    for (const e of this.entities) if (inR(e)) mv(e);
    for (const v of this.avatars.list) if (inR(v)) { mv(v); v.path = []; v.target = null; }
    if (region === 'town' && this.portalState) { mv(this.portalState); mv(this.portalState.spawn); }
    // 还没落地的提案：选好的位置也跟着平移（落地前会按原坐标再校验一次）
    if (region !== 'town') return;
    for (const p of this.proposalSystem.open()) {
      if (p.construction?.site) mv(p.construction.site);
      for (const o of p.ops) {
        const a = o.args || {};
        if (o.op === 'addBuilding' && Number.isInteger(a.x)) mv(a as { x: number; y: number });
        if (Array.isArray(a.cells)) a.cells = a.cells.map(([x, y]: number[]) => [x! + dx, y! + dy]);
        if (Array.isArray(a.trees)) a.trees = a.trees.map(([x, y, k]: [number, number, string]) => [x + dx, y + dy, k]);
        if (a.rect) a.rect = { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy };
      }
    }
  }

  /** 世界结构变化（新增建筑）后重建地图；正在走路的角色与生物重新寻路；moved 是平移量（前端的镜头跟着移） */
  rebuildWorld(moved: { dx: number; dy: number } | null = null): void {
    this.world = this.regions.town = buildRegion(this.spec.regions.find((r) => r.id === 'town')!, this.spec);
    this.regions.town = this.world;
    for (const a of this.agents) if (a.status === 'walking') { a.curKey = null; a.path = []; }
    for (const c of this.creatures.list) c.path = [];
    this.emit('worldmap', moved ? { ...this.world, shift: moved } : this.world);
  }

  /** 区域增减（addRegion / linkRegions）后重建所有区域；前端重新拿一次初始数据 */
  rebuildRegions() {
    this.regions = buildRegions(this.spec);
    this.world = this.regions.town;
    // 所在区域被移除的角色回到主地图的渡口
    for (const a of this.agents) {
      if (!this.regions[a.region || 'town']) Object.assign(a, { region: 'town', x: this.world.gate.x, y: this.world.gate.y, inside: null, path: [], dest: null, curKey: null, locId: null });
      if (a.status === 'walking') { a.curKey = null; a.path = []; }
    }
    this.emit('regions', this.regionsView());
    this.emit('reinit');
  }

  worldHistory() {
    return this.specOps.map((r) => ({ ...r, desc: OPS[r.op]?.describe?.(r.args, this.spec) || r.op }));
  }
}

// 把各职责模块的方法挂到 Town 上；重名直接报错，避免悄悄覆盖
for (const part of [Regions, Movement, Planning, Actions, Cognition, Social, Views, Persistence, Metrics, Dark, Combat]) {
  for (const [name, desc] of Object.entries(Object.getOwnPropertyDescriptors(part.prototype))) {
    if (name === 'constructor') continue;
    if (Object.hasOwn(Town.prototype, name)) throw new Error(`Town.${name} 重复定义（${part.name}）`);
    Object.defineProperty(Town.prototype, name, desc);
  }
}

export { listSnapshots, restoreSnapshot } from './sim/persistence.ts';
export { llmPublic } from './sim/views.ts';
