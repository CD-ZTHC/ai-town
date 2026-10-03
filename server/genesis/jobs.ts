// 创世任务（多世界设计 §4.3）：排队、运行、进度、失败时释放短名。任务记录在 data/genesis/jobs.json，原文在 data/genesis/sources/。
// 同一时刻只运行一个创世任务（它们本来就在统一队列的 P3 级，合计最多占 1 个并发）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runGenesis, runRegenerate } from './pipeline.ts';
import { writePack, loadPack } from '../worlds/pack.ts';
import { withContext } from '../scheduler/context.ts';
import { get as setting } from '../settings/index.ts';
import { trackChild } from '../memstat.ts';
import { withTrialSlot } from '../trial-lock.ts';
import type { WorldRegistry } from '../worlds/registry.ts';
import type { AuditEntry } from '../types/account.ts';
import type { GenesisDeps, GenesisReport, GenPack, ShadowResult } from './pipeline.ts';

/** 创世任务（data/genesis/jobs.json） */
export interface GenesisJob {
  id: string;
  /** genesis 创世；regen 预览期重新生成某一项 */
  kind: 'genesis' | 'regen';
  worldId: string;
  ownerId: string;
  /** 创世选项（用户提交，路由里校验过）；regen 时是 { part } */
  options: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  sourceId: string | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string;
  tokens: number;
  log: Array<{ at: string; stage: string; note: string }>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  report?: GenesisReport | null;
}

type RunGenesis = (job: GenesisJob, deps: GenesisDeps) => Promise<{ pack: GenPack; report: GenesisReport }>;

const SHADOW = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shadow.ts');
const readJSON = <T>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f: string, v: unknown): void => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${f}.tmp`, f); };

/** 在子进程里试跑新世界包 1 个游戏日 */
export function shadowRun(packDir: string, { timeoutMs = 120_000 }: { timeoutMs?: number } = {}): Promise<ShadowResult> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-shadow-'));
  return new Promise((resolve) => {
    const child = trackChild('genesis-trial', spawn(process.execPath, [`--max-old-space-size=${setting('CHILD_HEAP_MB')}`, SHADOW, packDir, work], { env: { PATH: process.env.PATH || '' }, stdio: ['ignore', 'pipe', 'pipe'] }));
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      fs.rmSync(work, { recursive: true, force: true });
      try { resolve(JSON.parse(out.trim().split('\n').pop()!)); } catch { resolve({ ok: false, error: '试跑没有输出结果（超时或崩溃）' }); }
    });
  });
}

export class GenesisJobs {
  declare dir: string;
  declare data: string;
  declare registry: WorldRegistry;
  declare budgetLeft: (userId: string, worldId: string) => number;
  declare audit: ((e: AuditEntry) => void) | null;
  declare onWorldReady: ((worldId: string) => void) | null;
  declare run: RunGenesis;
  declare shadow: (packDir: string) => Promise<ShadowResult>;
  declare file: string;
  declare jobs: GenesisJob[];
  declare running: GenesisJob | null;
  /**
   * data：数据根目录；budgetLeft：创世者剩余的创世额度（世界用自己的模型服务时不限）；onWorldReady：生成完成（世界进入预览）
   */
  constructor({ data, registry, budgetLeft, audit = null, onWorldReady = null, run = runGenesis, shadow = shadowRun }: {
    data: string; registry: WorldRegistry; budgetLeft: (userId: string, worldId: string) => number; audit?: ((e: AuditEntry) => void) | null;
    onWorldReady?: ((worldId: string) => void) | null; run?: RunGenesis; shadow?: (packDir: string) => Promise<ShadowResult>;
  }) {
    this.dir = path.join(data, 'genesis');
    this.data = data;
    this.registry = registry;
    this.budgetLeft = budgetLeft;
    this.audit = audit;
    this.onWorldReady = onWorldReady;
    this.run = run;
    this.shadow = shadow;
    this.file = path.join(this.dir, 'jobs.json');
    this.jobs = readJSON(this.file, []);
    // 上次进程退出时还在进行中的任务：重新排队
    for (const j of this.jobs) if (j.status === 'running') { j.status = 'queued'; j.log.push({ at: new Date().toISOString(), stage: j.stage, note: '服务器重启，重新排队' }); }
    this.running = null;
    this.save();
    setImmediate(() => this.pump());
  }

  save(): void { try { writeJSON(this.file, this.jobs.slice(-200)); } catch (e) { console.warn('[genesis] 保存任务失败：', (e as Error).message); } }

  get(id: string): GenesisJob | null { return this.jobs.find((j) => j.id === id) || null; }

  // ---------- 原文 ----------
  sourceFile(id: string): string { return path.join(this.dir, 'sources', `${id}.txt`); }

  saveSource(ownerId: string, text: string): { id: string; chars: number } {
    const id = `s_${crypto.randomBytes(6).toString('hex')}`;
    fs.mkdirSync(path.dirname(this.sourceFile(id)), { recursive: true });
    fs.writeFileSync(this.sourceFile(id), text);
    writeJSON(path.join(this.dir, 'sources', `${id}.json`), { ownerId, chars: text.length, at: new Date().toISOString() });
    return { id, chars: text.length };
  }

  sourceOwner(id: string): string | null { return readJSON<{ ownerId?: string } | null>(path.join(this.dir, 'sources', `${id}.json`), null)?.ownerId || null; }

  // ---------- 任务 ----------
  create({ ownerId, worldId, options, sourceId = null, kind = 'genesis' }: { ownerId: string; worldId: string; options: GenesisJob['options']; sourceId?: string | null; kind?: GenesisJob['kind'] }): GenesisJob {
    const job: GenesisJob = { id: `g_${crypto.randomBytes(6).toString('hex')}`, kind, worldId, ownerId, options, sourceId, status: 'queued', stage: 'queued', tokens: 0, log: [], createdAt: new Date().toISOString() };
    this.jobs.push(job);
    this.save();
    setImmediate(() => this.pump());
    return job;
  }

  /** 排在它前面的任务数（0 = 正在运行或下一个） */
  position(id: string): number {
    const queued = this.jobs.filter((j) => j.status === 'queued');
    const i = queued.findIndex((j) => j.id === id);
    return i < 0 ? 0 : i + (this.running ? 1 : 0);
  }

  view(job: GenesisJob) {
    return {
      id: job.id, worldId: job.worldId, status: job.status, stage: job.stage, tokens: job.tokens, position: this.position(job.id),
      createdAt: job.createdAt, finishedAt: job.finishedAt || null, error: job.error || null, report: job.report || null, log: job.log.slice(-20),
    };
  }

  async pump(): Promise<void> {
    if (this.running) return;
    const job = this.jobs.find((j) => j.status === 'queued');
    if (!job) return;
    this.running = job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.save();
    if (job.kind === 'regen') return this.pumpRegen(job);
    try {
      const source = job.sourceId && fs.existsSync(this.sourceFile(job.sourceId)) ? fs.readFileSync(this.sourceFile(job.sourceId), 'utf8') : null;
      const root = path.join(this.data, 'worlds', job.worldId);
      const packDir = path.join(root, 'pack');
      const { pack, report } = await withContext({ worldId: job.worldId, userId: job.ownerId }, () => this.run(job, {
        source,
        budgetLeft: () => this.budgetLeft(job.ownerId, job.worldId),
        onStage: () => this.save(),
        shadow: async (p: GenPack) => {
          // 先把包写到临时目录试跑，通过了再写进世界目录
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-pack-'));
          writePack(tmp, p);
          // 全站同时最多一个试运行（与进化的影子试运行共用一把锁）
          try { return await withTrialSlot(path.join(this.data, 'evolution'), () => this.shadow(tmp), { what: `genesis ${job.worldId}` }); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
        },
      }));
      if (report.problems.length) throw Object.assign(new Error(report.problems.join('；')), { report });
      writePack(packDir, pack);
      // 原文分块与摘要只给创世与运行时检索用，不对外提供
      fs.mkdirSync(path.join(packDir, 'source'), { recursive: true });
      fs.writeFileSync(path.join(packDir, 'source', 'chunks.json'), JSON.stringify(pack.chunks || []));
      fs.writeFileSync(path.join(packDir, 'source', 'digests.json'), JSON.stringify(pack.digests || []));
      const w = pack.world;
      this.registry.update(job.worldId, { title: w.meta.name, summary: w.lore.summary.slice(0, 300), sourceTitle: w.source?.title || '', rating: w.meta.rating, packHash: report.hash, evolution: Boolean(job.options.evolution) });
      this.registry.setStatus(job.worldId, 'preview');
      Object.assign(job, { status: 'done', stage: 'done', report, finishedAt: new Date().toISOString() });
      job.log.push({ at: job.finishedAt!, stage: 'done', note: '生成完成，进入预览' });
      this.audit?.({ actor: job.ownerId, action: 'genesis.done', target: job.worldId, detail: { job: job.id, tokens: job.tokens } });
      this.onWorldReady?.(job.worldId);
    } catch (e) {
      Object.assign(job, { status: 'failed', stage: 'failed', error: String((e as Error).message || e).slice(0, 400), report: (e as { report?: GenesisReport }).report || null, finishedAt: new Date().toISOString() });
      job.log.push({ at: job.finishedAt!, stage: 'failed', note: job.error! });
      // 失败的创世任务释放短名占用，清理半成品
      try { if (this.registry.get(job.worldId)?.status === 'drafting') this.registry.remove(job.worldId); } catch { /* 忽略 */ }
      fs.rmSync(path.join(this.data, 'worlds', job.worldId), { recursive: true, force: true });
      this.audit?.({ actor: job.ownerId, action: 'genesis.failed', target: job.worldId, detail: { job: job.id, error: job.error } });
      console.warn(`[genesis] ${job.id}（${job.worldId}）失败：${job.error}`);
    } finally {
      // 原文在任务结束后清理（分块已进世界包的 source/）
      if (job.sourceId) for (const f of [this.sourceFile(job.sourceId), path.join(this.dir, 'sources', `${job.sourceId}.json`)]) fs.rmSync(f, { force: true });
      this.running = null;
      this.save();
      setImmediate(() => this.pump());
    }
  }

  /** 预览期「重新生成这一项」：成功后替换世界包；失败不影响原来的世界 */
  async pumpRegen(job: GenesisJob): Promise<void> {
    const packDir = path.join(this.data, 'worlds', job.worldId, 'pack');
    try {
      const pack = loadPack(packDir);
      const { pack: next, report } = await withContext({ worldId: job.worldId, userId: job.ownerId }, () => runRegenerate(job, { pack, budgetLeft: () => this.budgetLeft(job.ownerId, job.worldId) }));
      writePack(packDir, next);
      this.registry.update(job.worldId, { packHash: report.hash, title: next.world.meta.name });
      Object.assign(job, { status: 'done', stage: 'done', report, finishedAt: new Date().toISOString() });
      job.log.push({ at: job.finishedAt!, stage: 'done', note: `已重新生成：${job.options.part}` });
      this.onWorldReady?.(job.worldId);
    } catch (e) {
      Object.assign(job, { status: 'failed', stage: 'failed', error: String((e as Error).message || e).slice(0, 400), finishedAt: new Date().toISOString() });
      job.log.push({ at: job.finishedAt!, stage: 'failed', note: job.error! });
    } finally {
      this.running = null;
      this.save();
      setImmediate(() => this.pump());
    }
  }

  /** 创世者名下的任务 */
  mine(ownerId: string) { return this.jobs.filter((j) => j.ownerId === ownerId).slice(-20).reverse().map((j) => this.view(j)); }

  /** 全站创世任务（管理员调度面板） */
  all() { return this.jobs.slice(-50).reverse().map((j) => ({ ...this.view(j), ownerId: j.ownerId })); }

  /** 用户世界磁盘总量是否超限（超过后暂停接受新的创世） */
  static diskFull(totalBytes: number): boolean {
    const gb = setting('WORLDS_DISK_TOTAL_GB');
    return gb > 0 && totalBytes > gb * 1024 ** 3;
  }
}
