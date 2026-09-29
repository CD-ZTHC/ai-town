#!/usr/bin/env node
// 进化引擎（自主演化设计 §3、§6；多世界设计 §9）：常驻的独立进程，无人值守地发现需求 → 写需求文档 → 评审 → 实施 → 多轮评审 → 试运行 → 提交裁决。
// 一台引擎服务所有开启进化的世界：在它们之间轮转「发现需求」，每个世界最多同时有 1 个任务在进行。
// 启动方式：
//   node evolution/daemon.ts           常驻（有世界开启进化时由小镇服务器自动启动，模型调用经 IPC 交给服务器排队）
//   node evolution/daemon.ts --once    只处理一个需求（mise run evolve；默认官方世界云溪镇）
// 小镇服务器启动它时会加上 Node 权限模型：只能写开启进化的世界各自的 plugins/ 与 evolution/，以及 data/evolution/。
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJSON, setEngine, Budget, ledger, str, enabledWorlds, rotation, loadJobs, ROOT } from './common.ts';
import { makeLLM, reviewInfo } from './llm.ts';
import { discover } from './discover.ts';
import { runJob } from './pipeline.ts';
import { get as setting } from '../server/settings/index.ts';

const G = paths(); // 全站的目录（任务、引擎状态、账本、开启进化的世界列表）
const once = process.argv.includes('--once');
const INTERVAL = setting('EVOLVE_INTERVAL_MIN') * 60_000;
const PACE_QUEUE = setting('PACE_QUEUE');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; setEngine(G, { state: 'stopped', pid: null }); process.exit(0); });
process.on('SIGINT', () => { stopping = true; setEngine(G, { state: 'stopped', pid: null }); process.exit(0); });

/** 这一轮要看的世界：服务器写的列表；独立运行（--once）且没有列表时是官方世界云溪镇 */
function worlds() {
  const list = enabledWorlds(G);
  if (list.length || !once) return list;
  return [{ id: 'yunxi', official: true, packDir: path.join(ROOT, 'worlds', 'yunxi') }];
}

/** 这个世界的模型队列太忙时让路（世界每隔几秒写一次心跳） */
function worldBusy(P) {
  const hb = readJSON(P.heartbeat, null);
  return hb && Date.now() - Date.parse(hb.at) < 60_000 && hb.queue > PACE_QUEUE;
}

async function cycle() {
  const list = worlds();
  if (!list.length) { setEngine(G, { state: 'idle', job: null, stage: null, worlds: [] }); return 'idle'; }
  // 上次异常退出时遗留的「进行中」任务
  const jobs = readJSON(G.jobs, []);
  let fixed = false;
  for (const j of jobs) if (j.status === 'running' && j.pid !== process.pid) { j.status = 'failed'; j.reason = '进化引擎中途退出'; fixed = true; }
  if (fixed) fs.writeFileSync(G.jobs, JSON.stringify(jobs, null, 1));
  const engine = readJSON(G.engine, {});
  let lastState = 'idle';
  for (const w of rotation(list, loadJobs(G), engine.lastWorld)) {
    const P = paths({ world: w.id, packDir: w.packDir || null });
    const budget = new Budget(P);
    const llm = makeLLM(budget, { worldId: w.id });
    setEngine(G, { lastWorld: w.id, worlds: list.map((x) => x.id) });
    if (!llm.enabled()) { lastState = 'no-llm'; continue; }
    if (budget.left() <= 0) { lastState = 'budget'; continue; }
    if (worldBusy(P)) { lastState = 'busy'; continue; }
    const need = discover(P);
    if (!need) continue;
    console.log(`[evolve] ${w.id} 开始：${need.text}`);
    setEngine(G, { state: 'working', world: w.id });
    const job = await runJob({ P, llm, onStage: (s) => console.log(`[evolve]   · ${w.id} ${s}`) }, need);
    console.log(`[evolve] ${w.id} 结束：${job.status}${job.reason ? `（${job.reason}）` : ''}`);
    setEngine(G, { state: 'idle', job: null, stage: null, world: null, last: { id: job.id, world: w.id, status: job.status, reason: str(job.reason, 120), title: job.title || null, at: new Date().toISOString() } });
    return job.status;
  }
  setEngine(G, { state: lastState, job: null, stage: null });
  return lastState;
}

async function main() {
  fs.mkdirSync(G.global, { recursive: true });
  const info = reviewInfo();
  setEngine(G, { state: 'starting', pid: process.pid, mode: once ? 'auto' : setting('EVOLVE'), budgetLimit: setting('EVOLVE_BUDGET'), reviewModel: info.model, sameModel: info.sameModel, startedAt: new Date().toISOString() });
  ledger(G, 'engine-start', { pid: process.pid, reviewModel: info.model, worlds: worlds().map((w) => w.id) });
  console.log(`[evolve] 进化引擎已启动（${worlds().length} 个世界开启进化，每个世界每天 ${setting('EVOLVE_BUDGET') || '不限'} tokens，评审模型 ${info.model}${info.sameModel ? '，与实施相同' : ''}）`);
  if (once) { await cycle(); return; }
  while (!stopping) {
    let r;
    try { r = await cycle(); } catch (e) { console.warn('[evolve]', e.message); r = 'error'; }
    // 刚做完一个需求就休息一个周期；空闲 / 忙 / 没预算时隔一会儿再看
    await sleep(['idle', 'busy', 'budget', 'no-llm', 'error'].includes(r) ? Math.min(INTERVAL, 5 * 60_000) : INTERVAL);
  }
}

main().catch((e) => { console.error('[evolve] 进化引擎出错：', e); setEngine(G, { state: 'crashed', error: str(e.message, 200) }); process.exit(1); });
