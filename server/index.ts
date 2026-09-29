// 服务入口：设置、账号、世界管理器（多世界）、HTTP 应用（Hono，见 http/app.ts）与进化引擎，然后监听端口
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { serve } from '@hono/node-server';
import * as settings from './settings/index.ts';
import { Town, llmPublic } from './sim.ts';
import { activeDir } from './timelines.ts';
import * as llm from './llm.ts';
import { config } from './guard.ts';
import { Accounts, installRefs } from './accounts/index.ts';
import { authorize } from './accounts/authz.ts';
import { WorldRegistry } from './worlds/registry.ts';
import { WorldManager, WorldFullError } from './worlds/manager.ts';
import { migrateLegacy, migrateEvolution } from './worlds/migrate.ts';
import { officialPack, officialIds, loadPack } from './worlds/pack.ts';
import { createApp } from './http/app.ts';
import { worldsApi } from './http/worlds-api.ts';
import { genesisApi, genesisQuota } from './http/genesis-api.ts';
import { GenesisJobs } from './genesis/jobs.ts';
import { HttpError } from './http/util.ts';
import { worldPage } from './http/pages.ts';
import { evolveConfig } from '../plugin-host/evolved.js';
import { engineArgs } from '../evolution/common.js';
import { hostCall, setReviewResolver } from '../evolution/llm.js';
import { loadMasterKey } from './secrets.ts';
import { LlmCredentials, SITE } from './accounts/llm-credentials.ts';
import { createWorldLlm, normalizeAi } from './world-llm.ts';
import { credentialsApi } from './http/llm-api.ts';
import { setEmbedResolver } from './embeddings.ts';
import { Ledger, budgetPolicy, LEVEL_NAMES } from './scheduler/budget.ts';
import { withContext } from './scheduler/context.ts';
import { CLASS_NAMES } from './scheduler/classes.ts';
import { sampleWorld } from './worlds/review.ts';
import { trackChild, memoryView, processMem, watchMemory } from './memstat.ts';
import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { World } from './types/world.ts';
import type { User } from './types/account.ts';
import type { AiConfig } from './world-llm.ts';
import type { Ctx } from './types/http.ts';

/** 世界的 AI 配置：字段按 own 的形状读（server 时都是 undefined） */
type AnyAi = AiConfig & Partial<Extract<AiConfig, { source: 'own' }>>;
/** 进化引擎经 IPC 发来的模型调用请求（evolution/llm.js 的 hostCall 处理） */
type EngineMsg = { type?: string; id?: string; worldId?: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
/** 进化引擎的任务（data/evolution/jobs.json，由 evolution/ 写入） */
type EvoJob = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- evolution/ 在 B8 迁移

// 设置中心：保存的值（data/settings.json）> 环境变量（只作初始值）> 默认值。
// 还起作用的环境变量写错时直接报错退出，不悄悄用默认值；先读设置文件，才知道哪些环境变量已经不起作用
settings.load();
const bad = settings.envProblems();
if (bad.length) {
  console.error(`[settings] 环境变量不合法：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
// 环境变量只作初始值：还没保存过的项导入设置文件，之后以保存的值为准（与已保存的值不同的环境变量会被忽略并提示）
settings.seedFromEnv();
const PORT = settings.get('PORT');
const HOST = settings.get('HOST') || undefined;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(settings.get('DATA_DIR'));
// 进化引擎的全站状态（任务、引擎状态、账本、开启进化的世界列表）；每个世界的插件与登记在 data/worlds/<id>/ 里
const EVO_DIR = path.join(DATA, 'evolution');

// ---------- 账号与世界登记 ----------
const accounts = new Accounts({ file: path.join(DATA, 'accounts.db'), reservedNames: () => officialIds().flatMap((id) => officialPack(id).world.personas.map((p: { name: string }) => p.name)) });
installRefs(accounts);
setInterval(() => accounts.sweepSessions(), 3600_000).unref();
let manager: WorldManager | null = null;
const registry = new WorldRegistry(accounts.db, { onChange: (id) => manager?.onStatus(id) });

// ---------- 按世界配置模型服务（docs/design/world-llm.md）：凭据加密存放；世界选了自己的模型服务，世界里的一切都用它 ----------
const master = loadMasterKey({ envValue: settings.get('SECRETS_KEY'), dataDir: DATA });
if (master.source === 'generated') console.warn(`[secrets] 已生成凭据加密主密钥 ${master.file}：请备份它，丢失后所有模型服务凭据都要重填（生产环境建议改用环境变量 SECRETS_KEY）`);
const credentials = new LlmCredentials(accounts.db, { key: master.key });
const HALT_PUBLIC = '这个世界的 AI 服务暂时不可用，世界暂停了';
const worldLlm = createWorldLlm({
  registry, credentials, audit: (e) => accounts.audit(e),
  onHalt: (id, h) => manager?.get(id)?.halt({ code: h.code, text: HALT_PUBLIC }),
  onResume: (id) => manager?.get(id)?.resume(),
});
llm.setProfileResolver(worldLlm.resolve);
llm.onFailure(worldLlm.onFailure);
setEmbedResolver(worldLlm.embedFor);
setReviewResolver(worldLlm.reviewFor);
worldLlm.start();

// 首次以多世界版本启动：把 data/ 下的存档移到 data/worlds/yunxi/（先完整备份）
migrateLegacy(DATA, 'yunxi');
migrateEvolution(DATA, ROOT, 'yunxi');
// 官方世界登记；原来的同名环境变量（STORY_RATING、STORYTELLER、MODS）只在第一次登记时写入官方世界的设置（§14.8）
for (const id of officialIds()) {
  const p = officialPack(id);
  const first = !registry.get(id);
  registry.ensureOfficial(id, {
    title: p.world.voice.name, summary: p.world.lore.summary.slice(0, 200), packHash: p.hash, rating: p.world.meta.rating,
    settings: first && id === 'yunxi' ? { rating: process.env.STORY_RATING || undefined, storyteller: process.env.STORYTELLER || undefined, mods: settings.get('MODS') } : {},
  });
}

// ---------- 世界管理器 ----------
function evolutionMode(world: World): string | undefined {
  if (world.official) return evolveConfig().mode;
  return world.evolution ? 'auto' : 'off';
}
function makeTown(world: World, root: string): Town {
  const pack = world.official ? officialPack(world.id) : loadPack(path.join(root, 'pack'));
  const s = world.settings || {};
  const town = new Town({
    dataDir: activeDir(root),
    worldId: world.id,
    pack,
    worldSettings: { rating: s.rating, storyteller: s.storyteller, mods: s.mods || [], migration: s.migration !== false, ...(Number.isInteger(s.deathNamed) ? { deathNamed: s.deathNamed } : {}) },
    // 每个世界的 AI 插件只在自己的目录里（为 A 世界生成的插件不会被 B 世界加载）；
    // 官方世界的进化开关是 EVOLVE，用户世界是创世时（或之后在设置里）打开的开关，超时交给 AI 裁决官
    evolution: { dir: path.join(root, 'evolution'), pluginsDir: path.join(root, 'plugins'), config: { publicMode: config.publicMode, mode: evolutionMode(world) } },
  });
  // 自带的模型服务出了致命错误、还没修好：加载后直接停在原地，不发起任何调用
  if (s.ai?.halt) town.halted = { code: s.ai.halt.code, text: HALT_PUBLIC };
  return town;
}
manager = new WorldManager({
  data: DATA, registry, makeTown,
  onWire: (world, t) => {
    // 决策的终审人（§8）：用户世界由 owner 终审（超时交给 AI 裁决官）；官方世界由管理员终审（公网 + 设置了令牌时）
    const human = !world.official ? Boolean(world.ownerId) : config.publicMode && Boolean(config.adminToken);
    t.votes.requireAdmin = human;
    t.proposalSystem.requireAdmin = human;
  },
  ownerGrant: (w) => (w.ownerId ? accounts.grant(w.ownerId, 'genesis') : null),
});
for (const id of settings.get('PINNED_WORLDS')) {
  try { if (registry.get(id)) manager.open(id); } catch (e) { console.warn(`[worlds] 常驻世界 ${id} 加载失败：`, (e as Error).message); }
}
setInterval(() => manager!.tick(), 5000).unref();

// ---------- 统一 AI 调度（§7）：账本记在 usage 表；出队前按世界的分层预算检查 ----------
const ledger = new Ledger(accounts.db);
llm.onUsage((e) => ledger.add(e));
const budget = budgetPolicy({
  ledger, world: (id) => registry.get(id), ownerGrant: (w) => ((w as World).ownerId ? accounts.grant((w as World).ownerId!, 'genesis') : null), globalUsed: () => llm.stats.dayTokens,
  // 世界用自己的模型服务：只受自己设的每日上限约束
  ownLimit: (id) => (worldLlm.isOwn(id) ? (normalizeAi(registry.get(id)?.settings?.ai) as AnyAi).dailyTokens! : null),
});
llm.setBudgetPolicy(budget.allow);
// ---------- 创世（§4）：任务排队运行，模型调用在 P3 级，从创世者的 genesisTokens 扣 ----------
const genesisUsed = (uid: string) => ledger.userTotal(uid, 'P3');
const genesis = new GenesisJobs({
  data: DATA, registry,
  budgetLeft: (uid, wid) => (wid && worldLlm.isOwn(wid) ? Infinity : genesisQuota(accounts.grant(uid, 'genesis')).genesisTokens - genesisUsed(uid)),
  audit: (e) => accounts.audit(e),
  onWorldReady: (id) => manager!.close(id, '世界包已更新'),
});

/** 我的世界（owner 页面）：状态、今日用量与降级档位、磁盘、观众、创世任务 */
function myWorlds(user: User) {
  return registry.list({ ownerId: user.id }).filter((w) => w.status !== 'archived').map((w) => {
    const h = manager!.get(w.id);
    const grant = accounts.grant(user.id, 'genesis');
    const limit = budget.worldLimit(w);
    return {
      id: w.id, title: w.title, summary: w.summary, rating: w.rating, settings: w.settings, official: w.official,
      status: w.status, statusReason: w.statusReason, evolution: w.evolution, migration: w.settings?.migration !== false, running: Boolean(h), viewers: h ? h.clients.size : 0,
      usage: ledger.world(w.id), dailyLimit: Number.isFinite(limit) ? limit : null, level: budget.level(w.id), levelName: LEVEL_NAMES[budget.level(w.id)],
      ai: aiSummary(w), ownUsage: ledger.own(w.id),
      diskBytes: w.diskBytes, diskLimitMB: w.quota?.diskMB ?? grant?.quota?.diskMB ?? settings.get('WORLD_DISK_MB'),
      pendingDecisions: h ? h.town.decisions.list?.filter?.((d: { status: string }) => d.status === 'waiting').length || 0 : 0,
      job: genesis.jobs.filter((j) => j.worldId === w.id).at(-1) ? genesis.view(genesis.jobs.filter((j) => j.worldId === w.id).at(-1)!) : null,
    };
  });
}

/** 世界的 AI 摘要（我的世界、管理面板）：用哪套模型、是否暂停、暂停原因；不含任何密钥 */
function aiSummary(w: World) {
  const ai = normalizeAi(w.settings?.ai) as AnyAi;
  const cred = ai.source === 'own' ? credentials.get(ai.credential!) : null;
  return {
    source: ai.source, active: worldLlm.isOwn(w.id), model: ai.models?.default || null, dailyTokens: ai.dailyTokens ?? null,
    credential: cred ? { id: cred.id, name: cred.name, status: cred.status } : null,
    halted: Boolean(ai.halt), haltText: ai.halt ? worldLlm.haltText(ai.halt) : '', haltMessage: ai.halt?.message || '',
  };
}

/** 调度面板（管理员）：各级别队列、各世界用量排行与降级档位、正在进行的调用 */
function llmView() {
  return {
    // 自带的模型服务：每把钥匙一条通道（不显示任何凭据内容，地址除外）
    lanes: llm.lanesView().filter((l) => l.billing === 'own').map((l) => {
      const id = l.key.slice(5);
      const cred = credentials.get(id);
      return {
        ...l, name: cred?.name || id, baseUrl: cred?.baseUrl || '', credentialStatus: cred?.status || 'gone',
        ownerName: l.owner === SITE ? '站点' : accounts.get(l.owner!)?.nickname || l.owner,
        worlds: worldLlm.worldsUsing(id).map((w) => ({ id: w.id, title: w.title, halted: Boolean(w.settings.ai.halt), usage: ledger.own(w.id).total })),
      };
    }),
    classes: llm.sched.view().map((x) => ({ ...x, name: CLASS_NAMES[x.cls] })),
    ranking: ledger.ranking().map((r) => ({ ...r, title: registry.get(r.id)?.title || r.id, level: budget.level(r.id), levelName: LEVEL_NAMES[budget.level(r.id)], limit: Number.isFinite(budget.worldLimit(registry.get(r.id))) ? budget.worldLimit(registry.get(r.id)) : null })),
    pool: budget.pool(),
    concurrency: settings.get('LLM_CONCURRENCY'), inflight: llm.stats.inflight, dayTokens: llm.stats.dayTokens, dailyBudget: llm.stats.dailyBudget,
    active: llm.stats.active.map((a) => ({ label: a.label, agent: a.agent, ms: Date.now() - a.since })),
    genesis: genesis.all().map((j) => ({ ...j, owner: accounts.get(j.ownerId)?.nickname || j.ownerId })),
  };
}

let llmDirty = false;
llm.onActivity(() => { llmDirty = true; });
setInterval(() => { if (llmDirty || llm.stats.active.length) { llmDirty = false; manager!.broadcastAll('llm', llmPublic()); } }, 400);

/** 请求对应的世界：检查可见性（预览中 / 已下架的只有 owner 和管理员能看），按需加载；满员时 503 */
function resolveWorld(c: Ctx, id: string | null | undefined) {
  const w = registry.get(id);
  const ok = authorize(c.get('who') || {}, 'world.view', w);
  if (ok !== true) throw new HttpError(w && w.status === 'suspended' ? 403 : 404, ok);
  try { return manager!.open(id!); } catch (e) {
    if (e instanceof WorldFullError) throw new HttpError(503, e.message, { retryAfter: e.retryAfter, full: true });
    throw e;
  }
}

// ---------- 运行时抽样审核（§10.2）：公开的用户世界，每 30 分钟抽一条编年或动态送审（P3，只用空闲容量） ----------
const SAMPLE_EVERY = 30 * 60_000;
const lastSample = new Map();
setInterval(async () => {
  for (const h of manager!.loaded.values()) {
    const w = registry.get(h.id);
    if (!w || w.official || w.status !== 'public' || Date.now() - (lastSample.get(h.id) || 0) < SAMPLE_EVERY) continue;
    lastSample.set(h.id, Date.now());
    try {
      const r = await withContext({ worldId: h.id }, () => sampleWorld(h.town));
      if (!r.hit) continue;
      accounts.audit({ actor: 'system', action: 'world.sample-hit', target: h.id, detail: { what: r.what, text: r.text } });
      const hits = Number(w.settings?.sampleHits || 0) + 1;
      registry.update(h.id, { settings: { sampleHits: hits } });
      // 累计多次命中：转为不公开，等管理员处理
      if (hits >= 3) {
        registry.setStatus(h.id, 'unlisted', `抽样审核累计 ${hits} 次发现不合适的内容，暂时不在大厅公开，等待管理员处理`);
        accounts.audit({ actor: 'system', action: 'world.unlisted', target: h.id, detail: { sampleHits: hits } });
      }
    } catch (e) { console.warn(`[review] ${h.id} 抽样审核失败：`, (e as Error).message); }
  }
}, 60_000).unref();

// 归档 30 天后清理磁盘；短名再冷却 30 天才能被重新使用（§4.4、§6.3）
setInterval(() => {
  for (const w of registry.list({ status: 'archived' })) {
    if (w.releasedAt || Date.now() - (w.statusAt || 0) < 30 * 86400_000) continue;
    manager!.close(w.id, '归档清理');
    fs.rmSync(manager!.root(w.id), { recursive: true, force: true });
    registry.release(w.id);
    accounts.audit({ actor: 'system', action: 'world.purge', target: w.id });
  }
}, 3600_000).unref();

const RESTART_CODE = 75;
const supervised = typeof process.send === 'function';
function restart() {
  // 存盘、通知在线页面「服务器正在重启」，再以 75 退出，由守护进程（server/main.ts）立即拉起
  manager!.broadcastAll('restart', { at: Date.now() });
  shuttingDown = true;
  engine?.kill('SIGTERM');
  setTimeout(() => { manager!.closeAll(); process.exit(RESTART_CODE); }, 300);
}
/** 保存设置前提示影响范围：例如把世界上限调小会卸载哪些世界 */
function impactOf(changes: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (changes.MAX_ACTIVE_WORLDS != null) {
    const n = Number(changes.MAX_ACTIVE_WORLDS);
    const over = manager!.loaded.size - n;
    if (over > 0) {
      const victims = [...manager!.loaded.values()].filter((h) => !manager!.isPinned(h.id)).sort((a, b) => a.clients.size - b.clients.size || a.lastViewer - b.lastViewer).slice(0, over);
      const watched = victims.filter((h) => h.clients.size);
      out.push(`将卸载 ${victims.length} 个世界${watched.length ? `，其中 ${watched.length} 个有 ${watched.reduce((s, h) => s + h.clients.size, 0)} 位观众` : ''}（新的上限在有人打开世界时生效）`);
    }
  }
  if (changes.REGISTER_OPEN === false) out.push('关闭注册：新访客将无法注册账号（已有账号不受影响）');
  if (changes.ALLOW_INTERACTION === false) out.push('关闭互动：所有世界变成纯观赏模式');
  return out;
}

const app = createApp({
  publicDir: path.join(ROOT, 'public'),
  revision: (() => { try { return fs.readFileSync(path.join(ROOT, 'REVISION'), 'utf8').trim() || null; } catch { return null; } })(),
  accounts,
  engineStatus: (worldId?: string) => engineStatus(worldId),
  admin: {
    restart, supervised: () => supervised, impactOf, manager, registry, llmView, budget, ledger, engineStatus: () => engineStatus(),
    memory: () => ({ ...memoryView([...manager!.loaded.values()]), alertMb: settings.get('MEM_ALERT_MB'), heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576) }),
    siteCredentials: credentialsApi({ credentials, worldLlm, accounts, scope: 'site' }), aiSummary,
  },
  routes: [
    ['worlds', worldsApi({
      registry, manager: manager!, accounts, jobs: genesis, mine: myWorlds, worldLlm,
      credentialsFor: (w) => credentials.list(w.official ? SITE : w.ownerId || '-'),
      usage: (id) => ({ server: ledger.world(id), own: ledger.own(id) }),
    })],
    ['genesis', genesisApi({ accounts, registry, jobs: genesis, used: genesisUsed, userDiskTotal: () => manager!.userDiskTotal(), worldLlm })],
    ['me/llm-credentials', credentialsApi({ credentials, worldLlm, accounts, scope: 'user' })],
  ],
  worlds: {
    lobby: true,
    defaultId: () => settings.get('DEFAULT_WORLD'),
    resolve: resolveWorld,
    page: (c, id) => worldPage({ c, id, registry, manager: manager! }),
    health: () => ({ worlds: manager!.view().map(({ id, viewers, idle }) => ({ id, viewers, idle })), clients: manager!.view().reduce((s, w) => s + w.viewers, 0), rssMb: processMem().rss }),
  },
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  // 端口监听成功、常驻世界已加载：当前设置版本标记为「正常」，告诉守护进程启动成功
  settings.markGood();
  process.send?.({ type: 'ready' });
  const mode = config.publicMode ? `公网模式${config.adminToken ? '（已设置管理员令牌）' : '（⚠️ 未设置 ADMIN_TOKEN，无法认领超级管理员）'}` : '本地模式（所有访问者均为管理员，请勿直接暴露到公网）';
  console.log(`\n  🌸 AI Town 已开放： http://${HOST || 'localhost'}:${PORT}（${registry.list({ status: 'public' }).length} 个公开世界，运行中 ${manager!.loaded.size}）\n  🔐 ${mode}\n  🧠 LLM: ${llm.stats.enabled ? `${llm.stats.model}（快：${llm.stats.models.fast} · 强：${llm.stats.models.smart}）${llm.stats.dailyBudget ? ` · 每日预算 ${llm.stats.dailyBudget.toLocaleString()} tokens` : ''}` : '未配置（使用规则兜底）'}\n`);
});
// 内存告警（重构方案 §6.2）：常驻内存超过 MEM_ALERT_MB 时写审计，概览页会显示
watchMemory({
  limitMb: () => settings.get('MEM_ALERT_MB'),
  onHigh: (mem) => {
    console.warn(`[mem] 服务进程常驻内存 ${mem.rss}MB，超过告警阈值`);
    accounts.audit({ actor: 'system', action: 'memory.high', target: `${mem.rss}MB`, detail: { ...mem, sse: memoryView([...manager!.loaded.values()]).sse } });
  },
});
(server as Server).headersTimeout = 20_000;
(server as Server).requestTimeout = 30_000;

// ---------- 进化引擎（自主演化设计 §3、多世界设计 §9）：一台引擎服务所有开启进化的世界 ----------
// 用 Node 权限模型限制为只能写：开启进化的世界各自的 plugins/ 与 evolution/，以及 data/evolution/（全站的任务与账本）
let engine: ChildProcess | null = null;
let engineRestarts = 0;
let engineWorlds = '[]';
/** 开启进化的世界：官方世界看 EVOLVE，用户世界看自己的开关；磁盘超限、下架、归档的不算 */
function evolutionWorlds() {
  return registry.list().filter((w) => WorldRegistry.runnable(w) && evolutionMode(w) !== 'off' && !manager!.get(w.id)?.diskFull)
    .map((w) => ({ id: w.id, official: w.official, packDir: w.official ? path.join(ROOT, 'worlds', w.id) : path.join(manager!.root(w.id), 'pack'), mode: evolutionMode(w) }));
}
/** 列表变了：写给引擎看；需要写的目录变了就重启引擎（权限在启动时给定） */
function syncEvolution() {
  const list = evolutionWorlds();
  const json = JSON.stringify(list);
  fs.mkdirSync(EVO_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVO_DIR, 'worlds.json'), JSON.stringify(list, null, 1));
  if (json === engineWorlds) return;
  engineWorlds = json;
  if (engine) { engineRestarts = 0; engine.removeAllListeners('exit'); engine.kill('SIGTERM'); engine = null; }
  startEngine();
}
setInterval(syncEvolution, 60_000).unref();
function startEngine() {
  const list: Array<{ id: string }> = JSON.parse(engineWorlds);
  if (!list.length || !settings.get('EVOLVE_DAEMON')) return;
  const dirs = list.flatMap((w) => [path.join(manager!.root(w.id), 'plugins'), path.join(manager!.root(w.id), 'evolution')]);
  for (const d of [...dirs, EVO_DIR]) fs.mkdirSync(d, { recursive: true });
  // 引擎不联网：模型调用经 IPC 交给主进程，放进统一队列的 P4 级（§7.5）
  // TODO(types): B8 迁移 evolution/common 后去掉 extraWrite 的断言（JS 从默认值 [] 推断出 never[]）
  const args = [`--max-old-space-size=${settings.get('CHILD_HEAP_MB')}`, ...engineArgs({ root: ROOT, data: DATA, evolvedDir: dirs[0], evoDir: EVO_DIR, extraWrite: dirs.slice(1) as never[], net: false }), path.join(ROOT, 'evolution', 'daemon.js')];
  engine = spawn(process.execPath, args, { cwd: ROOT, env: settings.env({ ...process.env, DATA_DIR: DATA, EVOLVE_IPC: '1', EVOLVE_LLM: llm.stats.enabled || list.some((w) => worldLlm.isOwn(w.id)) ? '1' : '0' }), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const proc = trackChild('evolve', engine);
  proc.on('message', async (m: EngineMsg) => {
    if (m?.type !== 'llm') return;
    let reply;
    try {
      // 只替开启了进化的世界调用模型
      if (!JSON.parse(engineWorlds).some((w: { id: string }) => w.id === (m.worldId || 'yunxi'))) throw new Error('这个世界没有开启进化');
      const r = await withContext({ worldId: m.worldId || 'yunxi', userId: null }, () => hostCall(m as Parameters<typeof hostCall>[0]));
      reply = { type: 'llm-result', id: m.id, ok: true, json: r.json, tokens: r.tokens };
    } catch (e) { reply = { type: 'llm-result', id: m.id, ok: false, error: String((e as Error).message).slice(0, 300), code: (e as { code?: string }).code }; }
    if (proc.connected) proc.send(reply);
  });
  engine.on('exit', (code) => {
    engine = null;
    if (shuttingDown) return;
    // 异常退出：指数退避后重启（最多间隔 30 分钟）
    const wait = Math.min(30 * 60_000, 30_000 * 2 ** engineRestarts++);
    console.warn(`[evolve] 进化引擎退出（${code}），${Math.round(wait / 1000)} 秒后重启`);
    setTimeout(startEngine, wait).unref();
  });
  const cfg = evolveConfig();
  if (cfg.publicMode && cfg.publicDeploy === 'all' && cfg.sandboxNet !== 'isolated') {
    console.warn('[evolve] ⚠️ 公网模式允许 AI 代码插件自动上线，但没有声明沙箱已在系统层面断网（EVOLVE_SANDBOX_NET=isolated）。沙箱已禁止导入网络模块并移除网络对象，仍建议在容器层给沙箱断网。');
  }
}
/** 引擎状态；worldId 给出时只列这个世界的任务 */
function engineStatus(worldId: string | null = null) {
  let st: Record<string, unknown> = {};
  try { st = JSON.parse(fs.readFileSync(path.join(EVO_DIR, 'engine.json'), 'utf8')); } catch { /* 还没有运行过 */ }
  let jobs: object[] = [];
  try { jobs = JSON.parse(fs.readFileSync(path.join(EVO_DIR, 'jobs.json'), 'utf8')).filter((j: EvoJob) => !worldId || (j.worldId || 'yunxi') === worldId).slice(-12).reverse().map((j: EvoJob) => ({ id: j.id, worldId: j.worldId || 'yunxi', status: j.status, stage: j.stage, need: j.need?.text, source: j.need?.source, title: j.title || null, tier: j.tier || null, key: j.key || null, reason: j.reason || null, rfc: j.rfc || null, startedAt: j.startedAt, finishedAt: j.finishedAt || null, log: (j.log || []).slice(-8) })); } catch { /* 无 */ }
  const cfg = evolveConfig();
  return { ...st, running: Boolean(engine), worlds: JSON.parse(engineWorlds).map((w: { id: string }) => w.id), enabled: worldId ? JSON.parse(engineWorlds).some((w: { id: string }) => w.id === worldId) : undefined, mode: cfg.mode, publicDeploy: cfg.publicDeploy, budgetLimit: settings.get('EVOLVE_BUDGET'), sandboxNet: cfg.sandboxNet, jobs };
}
syncEvolution();

let shuttingDown = false;
const shutdown = () => { shuttingDown = true; engine?.kill('SIGTERM'); worldLlm.stop(); manager!.closeAll(); accounts.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
