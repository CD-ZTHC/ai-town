// 全站试运行锁（重构方案 §6.4）：创世试跑与进化的影子试运行同时最多一个，避免在小内存机器上叠加内存峰值。
// 它们分别在服务进程和进化引擎进程里发起，所以用文件锁：<数据目录>/evolution/trial.lock（两个进程都能写）。
// 锁文件记下持有者的 pid 与时间；持有者进程已经不在、或超过 staleMs 仍未释放的锁视为失效。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function tryTake(file: string, staleMs: number, what: string): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), what }), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  let cur: { pid?: number; at?: number } | null = null;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 刚好被释放或写了一半 */ }
  const stale = !cur || !Number.isFinite(cur.at) || Date.now() - cur.at! > staleMs || (cur.pid && !alive(cur.pid));
  if (stale) {
    try { fs.rmSync(file, { force: true }); } catch { /* 别人先删了 */ }
  }
  return false;
}

/**
 * 拿到全站试运行名额后执行 fn；等待超过 waitMs 仍拿不到时抛错（code = 'TRIAL_BUSY'）。
 * dir：锁文件所在目录（<数据目录>/evolution）
 */
export async function withTrialSlot<T>(dir: string | null | undefined, fn: () => Promise<T>, { waitMs = 10 * 60_000, staleMs = 15 * 60_000, what = '', pollMs = 1000 }: { waitMs?: number; staleMs?: number; what?: string; pollMs?: number } = {}): Promise<T> {
  if (!dir) return fn();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'trial.lock');
  const end = Date.now() + waitMs;
  while (!tryTake(file, staleMs, what)) {
    if (Date.now() > end) throw Object.assign(new Error('另一个试运行正在进行，排队超时'), { code: 'TRIAL_BUSY' });
    await sleep(pollMs);
  }
  try { return await fn(); } finally {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur.pid === process.pid) fs.rmSync(file, { force: true });
    } catch { /* 已经不在 */ }
  }
}
