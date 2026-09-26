// 进化引擎的公共部分：目录、账本、任务记录、引擎状态与 token 预算。
// 进化引擎只能写两个地方：plugins/evolved/（插件代码）与 data/evolution/（运行状态）；启动时由 Node 权限模型强制。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function paths(opts = {}) {
  const data = path.resolve(opts.data || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const evo = path.resolve(opts.evo || path.join(data, 'evolution'));
  return {
    data, evo,
    plugins: path.resolve(opts.plugins || path.join(ROOT, 'plugins', 'evolved')),
    candidates: path.join(evo, 'candidates'),
    shadow: path.join(evo, 'shadow'),
    rfcs: path.join(evo, 'rfcs'),
    verified: path.join(evo, 'verified.json'),
    registry: path.join(evo, 'registry.json'),
    signals: path.join(evo, 'signals.json'),
    heartbeat: path.join(evo, 'heartbeat.json'),
    jobs: path.join(evo, 'jobs.json'),
    engine: path.join(evo, 'engine.json'),
    ledger: path.join(evo, 'ledger.jsonl'),
  };
}

export const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export function writeJSON(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1));
  fs.renameSync(`${f}.tmp`, f);
}
export const str = (v, max) => String(v ?? '').trim().slice(0, max);
export const today = () => new Date().toISOString().slice(0, 10);

export function ledger(P, event, extra = {}) {
  try {
    fs.mkdirSync(P.evo, { recursive: true });
    fs.appendFileSync(P.ledger, `${JSON.stringify({ at: new Date().toISOString(), by: 'engine', event, ...extra })}\n`);
  } catch { /* 账本写失败不影响流程 */ }
}

/** 读取最近的账本记录（新的在后） */
export function readLedger(P, n = 60) {
  try {
    return fs.readFileSync(P.ledger, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ---------- 预算 ----------
export class Budget {
  /** limit：每天的 token 上限（0 = 不限） */
  constructor(P, limit = Number(process.env.EVOLVE_BUDGET ?? 200_000)) {
    this.P = P;
    this.limit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  }
  state() {
    const e = readJSON(this.P.engine, {});
    const b = e.budget?.day === today() ? e.budget : { day: today(), tokens: 0 };
    return b;
  }
  used() { return this.state().tokens; }
  left() { return this.limit ? Math.max(0, this.limit - this.used()) : Infinity; }
  add(tokens) {
    const e = readJSON(this.P.engine, {});
    const b = e.budget?.day === today() ? e.budget : { day: today(), tokens: 0 };
    b.tokens += Math.max(0, Math.round(tokens || 0));
    writeJSON(this.P.engine, { ...e, budget: b });
  }
}

export class BudgetExceeded extends Error {
  constructor() { super('今天的进化预算已用完'); this.code = 'EVOLVE_BUDGET'; }
}

// ---------- 引擎状态（管理面板读取） ----------
export function setEngine(P, patch) {
  const e = readJSON(P.engine, {});
  writeJSON(P.engine, { ...e, ...patch, updatedAt: new Date().toISOString() });
}

// ---------- 任务 ----------
export function loadJobs(P) { return readJSON(P.jobs, []); }
export function saveJobs(P, jobs) { writeJSON(P.jobs, jobs.slice(-100)); }
