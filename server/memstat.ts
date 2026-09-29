// 内存观测（重构方案 §6.2）：服务进程的内存、登记过的子进程（沙箱、试运行、进化引擎）及其 RSS。
// 子进程的 RSS 读 /proc/<pid>/status（只有 Linux 有；其他系统返回 null）。
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const MB = 1024 * 1024;
const children = new Map<number, { kind: string; since: number }>(); // pid -> { kind, since }

/** 服务进程的内存（MB） */
export interface ProcessMem { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number }

/** 登记一个子进程（退出时自动注销） */
export function trackChild<C extends ChildProcess | null | undefined>(kind: string, child: C): C {
  const pid = child?.pid;
  if (!pid) return child;
  children.set(pid, { kind, since: Date.now() });
  child!.once('exit', () => children.delete(pid));
  return child;
}

/** 某个进程的常驻内存（MB）；读不到时 null */
export function rssOf(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

/** 服务进程自己的内存（MB） */
export function processMem(): ProcessMem {
  const m = process.memoryUsage();
  return { rss: Math.round(m.rss / MB), heapUsed: Math.round(m.heapUsed / MB), heapTotal: Math.round(m.heapTotal / MB), external: Math.round(m.external / MB), arrayBuffers: Math.round(m.arrayBuffers / MB) };
}

/** 登记的子进程：[{ pid, kind, rss, since }] */
export function childList() {
  return [...children].map(([pid, c]) => ({ pid, kind: c.kind, rss: rssOf(pid), since: c.since }));
}

/** SSE 观众与积压（字节）：hosts 是运行中的 WorldHost */
export function sseStats(hosts: Array<{ clients: Iterable<{ backlog?: number }> }>) {
  let clients = 0, backlog = 0, maxBacklog = 0;
  for (const h of hosts) {
    for (const c of h.clients) {
      clients++;
      const b = c.backlog || 0;
      backlog += b;
      if (b > maxBacklog) maxBacklog = b;
    }
  }
  return { clients, backlogKb: Math.round(backlog / 1024), maxBacklogKb: Math.round(maxBacklog / 1024) };
}

/** 完整的内存视图（管理面板「概览」） */
export function memoryView(hosts: Array<{ clients: Iterable<{ backlog?: number }> }> = []) {
  const kids = childList();
  const byKind: Record<string, { count: number; rss: number }> = {};
  for (const k of kids) {
    const g = (byKind[k.kind] ||= { count: 0, rss: 0 });
    g.count++;
    g.rss += k.rss || 0;
  }
  return { process: processMem(), children: kids, byKind, sse: sseStats(hosts), worlds: hosts.length };
}

/**
 * 定时检查：服务进程 RSS 超过阈值时回调（同一轮高位每小时最多一次）。返回停止函数
 */
export function watchMemory({ limitMb, onHigh, everyMs = 60_000 }: { limitMb: () => number; onHigh: (mem: ProcessMem) => void; everyMs?: number }): () => void {
  let lastAlert = 0;
  const timer = setInterval(() => {
    const limit = limitMb();
    if (!(limit > 0)) return;
    const mem = processMem();
    if (mem.rss > limit && Date.now() - lastAlert > 3600_000) { lastAlert = Date.now(); onHigh(mem); }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
