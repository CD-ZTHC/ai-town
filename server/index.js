// 服务入口：创建世界、HTTP 应用（Hono，见 http/app.js）与进化引擎，然后监听端口
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Town, llmPublic } from './sim.js';
import { activeDir } from './timelines.js';
import * as llm from './llm.js';
import { config } from './guard.js';
import { WorldHost } from './worlds/host.js';
import { createApp } from './http/app.js';
import { evolveConfig } from '../plugin-host/evolved.js';
import { engineArgs } from '../evolution/common.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 数据根目录：主时间线存放在这里，分支时间线在 timelines/ 子目录
const DATA = path.resolve(process.env.DATA_DIR || 'data');
// AI 插件与进化引擎的状态放在数据根目录（所有时间线共用）
const EVO_DIR = path.join(DATA, 'evolution');

const host = new WorldHost({
  id: 'yunxi',
  makeTown: () => new Town({ dataDir: activeDir(DATA), evolution: { dir: EVO_DIR, config: { publicMode: config.publicMode } } }),
  onWire: (t) => {
    t.votes.requireAdmin = config.publicMode && Boolean(config.adminToken);
    t.proposalSystem.requireAdmin = config.publicMode && Boolean(config.adminToken);
  },
  idlePauseSec: config.idlePauseSec,
});
host.dataRoot = DATA;

let llmDirty = false;
llm.onActivity(() => { llmDirty = true; });
setInterval(() => { if (llmDirty || llm.stats.active.length) { llmDirty = false; host.broadcast('llm', llmPublic()); } }, 400);
// 无人观看时自动暂停（节省 LLM 开销）
if (config.idlePauseSec > 0) setInterval(() => host.idleCheck(), 5000).unref();

const app = createApp({ hostFor: () => host, publicDir: path.join(ROOT, 'public'), engineStatus: () => engineStatus() });

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  const mode = config.publicMode ? `公网模式${config.adminToken ? '（已设置管理员令牌）' : '（⚠️ 未设置 ADMIN_TOKEN，管理功能全部关闭）'}` : '本地模式（所有访问者均为管理员，请勿直接暴露到公网）';
  console.log(`\n  🌸 云溪镇已开放： http://${HOST || 'localhost'}:${PORT}\n  🔐 ${mode}\n  🧠 LLM: ${llm.stats.enabled ? `${llm.stats.model}（快：${llm.stats.models.fast} · 强：${llm.stats.models.smart}）${llm.stats.dailyBudget ? ` · 每日预算 ${llm.stats.dailyBudget.toLocaleString()} tokens` : ''}` : '未配置（使用规则兜底）'}\n`);
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

// ---------- 进化引擎（自主演化设计 §3）：独立进程，用 Node 权限模型限制为只能写 plugins/evolved/ 与 data/evolution/ ----------
const EVOLVED_DIR = path.join(ROOT, 'plugins', 'evolved');
let engine = null;
let engineRestarts = 0;
function startEngine() {
  const cfg = evolveConfig();
  if (cfg.mode === 'off' || process.env.EVOLVE_DAEMON === '0') return;
  fs.mkdirSync(EVOLVED_DIR, { recursive: true });
  fs.mkdirSync(EVO_DIR, { recursive: true });
  const args = [...engineArgs({ root: ROOT, data: DATA, evolvedDir: EVOLVED_DIR, evoDir: EVO_DIR }), path.join(ROOT, 'evolution', 'daemon.js')];
  engine = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA }, stdio: ['ignore', 'inherit', 'inherit'] });
  engine.on('exit', (code) => {
    engine = null;
    if (shuttingDown) return;
    // 异常退出：指数退避后重启（最多间隔 30 分钟）
    const wait = Math.min(30 * 60_000, 30_000 * 2 ** engineRestarts++);
    console.warn(`[evolve] 进化引擎退出（${code}），${Math.round(wait / 1000)} 秒后重启`);
    setTimeout(startEngine, wait).unref();
  });
  if (cfg.publicMode && cfg.publicDeploy === 'all' && cfg.sandboxNet !== 'isolated') {
    console.warn('[evolve] ⚠️ 公网模式允许 AI 代码插件自动上线，但没有声明沙箱已在系统层面断网（EVOLVE_SANDBOX_NET=isolated）。沙箱已禁止导入网络模块并移除网络对象，仍建议在容器层给沙箱断网。');
  }
}
function engineStatus() {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(EVO_DIR, 'engine.json'), 'utf8')); } catch { /* 还没有运行过 */ }
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(path.join(EVO_DIR, 'jobs.json'), 'utf8')).slice(-12).reverse().map((j) => ({ id: j.id, status: j.status, stage: j.stage, need: j.need?.text, source: j.need?.source, title: j.title || null, tier: j.tier || null, key: j.key || null, reason: j.reason || null, rfc: j.rfc || null, startedAt: j.startedAt, finishedAt: j.finishedAt || null, log: (j.log || []).slice(-8) })); } catch { /* 无 */ }
  const cfg = evolveConfig();
  return { ...st, running: Boolean(engine), mode: cfg.mode, publicDeploy: cfg.publicDeploy, budgetLimit: Number(process.env.EVOLVE_BUDGET ?? 200_000), sandboxNet: cfg.sandboxNet, jobs };
}
startEngine();

let shuttingDown = false;
const shutdown = () => { shuttingDown = true; engine?.kill('SIGTERM'); host.town.save(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
