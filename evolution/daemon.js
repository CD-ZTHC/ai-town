#!/usr/bin/env node
// 进化引擎（自主演化设计 §3、§6）：常驻的独立进程，无人值守地发现需求 → 写需求文档 → 评审 → 实施 → 多轮评审 → 试运行 → 提交裁决。
// 启动方式：
//   node evolution/daemon.js           常驻（EVOLVE=auto 或 suggest 时由小镇服务器自动启动）
//   node evolution/daemon.js --once    只处理一个需求（mise run evolve）
// 小镇服务器启动它时会加上 Node 权限模型：只能写 plugins/evolved/ 与 data/evolution/，写不了内核与前端。
import fs from 'node:fs';
import { paths, readJSON, setEngine, Budget, ledger, str } from './common.js';
import { makeLLM, reviewInfo } from './llm.js';
import { discover } from './discover.js';
import { runJob } from './pipeline.js';

const P = paths();
const once = process.argv.includes('--once');
const MODE = once ? 'auto' : process.env.EVOLVE || 'off';
const INTERVAL = Number(process.env.EVOLVE_INTERVAL_MIN || 20) * 60_000;
const PACE_QUEUE = Number(process.env.PACE_QUEUE || 6);
const budget = new Budget(P);
const llm = makeLLM(budget);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; setEngine(P, { state: 'stopped', pid: null }); process.exit(0); });
process.on('SIGINT', () => { stopping = true; setEngine(P, { state: 'stopped', pid: null }); process.exit(0); });

/** 小镇的模型队列太忙时让路（小镇每隔几秒写一次心跳） */
function townBusy() {
  const hb = readJSON(P.heartbeat, null);
  return hb && Date.now() - Date.parse(hb.at) < 60_000 && hb.queue > PACE_QUEUE;
}

async function cycle() {
  if (!llm.enabled()) { setEngine(P, { state: 'no-llm' }); return 'no-llm'; }
  if (budget.left() <= 0) { setEngine(P, { state: 'waiting-budget', budget: { used: budget.used(), limit: budget.limit } }); return 'budget'; }
  if (townBusy()) { setEngine(P, { state: 'waiting-town' }); return 'busy'; }
  // 上次异常退出时遗留的「进行中」任务
  const jobs = readJSON(P.jobs, []);
  let fixed = false;
  for (const j of jobs) if (j.status === 'running' && j.pid !== process.pid) { j.status = 'failed'; j.reason = '进化引擎中途退出'; fixed = true; }
  if (fixed) fs.writeFileSync(P.jobs, JSON.stringify(jobs, null, 1));
  const need = discover(P);
  if (!need) { setEngine(P, { state: 'idle', job: null, stage: null }); return 'idle'; }
  console.log(`[evolve] 开始：${need.text}`);
  const job = await runJob({ P, llm, onStage: (s) => console.log(`[evolve]   · ${s}`) }, need);
  console.log(`[evolve] 结束：${job.status}${job.reason ? `（${job.reason}）` : ''}`);
  setEngine(P, { state: 'idle', job: null, stage: null, last: { id: job.id, status: job.status, reason: str(job.reason, 120), title: job.title || null, at: new Date().toISOString() } });
  return job.status;
}

async function main() {
  if (MODE === 'off') { console.log('[evolve] EVOLVE=off，进化引擎不启动'); return; }
  fs.mkdirSync(P.evo, { recursive: true });
  const info = reviewInfo();
  setEngine(P, { state: 'starting', pid: process.pid, mode: MODE, budget: { limit: budget.limit }, reviewModel: info.model, sameModel: info.sameModel, startedAt: new Date().toISOString() });
  ledger(P, 'engine-start', { mode: MODE, pid: process.pid, reviewModel: info.model });
  console.log(`[evolve] 进化引擎已启动（${MODE}，预算 ${budget.limit || '不限'} tokens/天，评审模型 ${info.model}${info.sameModel ? '，与实施相同' : ''}）`);
  if (once) { await cycle(); return; }
  while (!stopping) {
    let r;
    try { r = await cycle(); } catch (e) { console.warn('[evolve]', e.message); r = 'error'; }
    // 刚做完一个需求就休息一个周期；空闲 / 忙 / 没预算时隔一会儿再看
    await sleep(['idle', 'busy', 'budget', 'no-llm', 'error'].includes(r) ? Math.min(INTERVAL, 5 * 60_000) : INTERVAL);
  }
}

main().catch((e) => { console.error('[evolve] 进化引擎出错：', e); setEngine(P, { state: 'crashed', error: str(e.message, 200) }); process.exit(1); });
