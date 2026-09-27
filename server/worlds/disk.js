// 世界的磁盘占用与上限（多世界设计 §6.4）：不在每次写文件时同步统计，而是存盘后与每小时计算一次。
//   上限三层（后面的覆盖前面的）：全局默认 WORLD_DISK_MB → 创世者授予的 quota.diskMB → 世界自己的 quota.diskMB；官方世界不受限
//   超过 100%：先回收可以重建的东西（旧快照，每条时间线至少留最近 1 个；向量缓存），仍然超限则拒绝会增长的操作。
//   存档与操作日志始终可以写入——世界本身照常运行。
import fs from 'node:fs';
import path from 'node:path';
import { get as setting } from '../settings/index.js';

const MB = 1024 * 1024;
const SNAP = /^d(\d{3})-(\d{2})\.json(?:\.gz)?$/;

/** 目录大小，按类别细分：snapshots / timelines / source / plugins / embeddings / other */
export function diskUsage(root) {
  const out = { total: 0, snapshots: 0, timelines: 0, source: 0, plugins: 0, embeddings: 0, other: 0 };
  const walk = (dir, cat) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const c = cat || ({ snapshots: 'snapshots', timelines: 'timelines', source: 'source', plugins: 'plugins' }[e.name] || null);
        walk(p, c);
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(p).size; } catch { continue; }
        const c = cat || (/^embeddings\.db/.test(e.name) ? 'embeddings' : 'other');
        out[cat === 'timelines' && /^embeddings\.db/.test(e.name) ? 'embeddings' : c] += size;
        out.total += size;
      }
    }
  };
  walk(root, null);
  return out;
}

/** 这个世界的上限（字节）；Infinity = 不限 */
export function diskLimit(world, ownerGrant = null) {
  if (!world || world.official) return Infinity;
  const mb = world.quota?.diskMB ?? ownerGrant?.quota?.diskMB ?? setting('WORLD_DISK_MB');
  return Number(mb) > 0 ? Number(mb) * MB : Infinity;
}

/** 所有快照目录（主时间线与各分支） */
function snapshotDirs(root) {
  const dirs = [path.join(root, 'snapshots')];
  const tl = path.join(root, 'timelines');
  try { for (const d of fs.readdirSync(tl)) dirs.push(path.join(tl, d, 'snapshots')); } catch { /* 没有分支 */ }
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * 回收可以重建的东西，直到不超过 target 字节：按时间从旧到新删快照（每条时间线至少保留最近 1 个），再清空向量缓存。
 * 返回回收的字节数。
 */
export function reclaim(root, target) {
  let usage = diskUsage(root).total;
  let freed = 0;
  const del = (f) => { try { const s = fs.statSync(f).size; fs.rmSync(f, { force: true }); usage -= s; freed += s; } catch { /* 已删除 */ } };
  // 全部时间线的快照混在一起按「游戏时间」从旧到新排，每条时间线保留最新的 1 个
  const cands = [];
  for (const dir of snapshotDirs(root)) {
    const files = fs.readdirSync(dir).filter((f) => SNAP.test(f)).sort();
    for (const f of files.slice(0, -1)) {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
      cands.push({ file: path.join(dir, f), mtime });
    }
  }
  cands.sort((a, b) => a.mtime - b.mtime);
  for (const c of cands) { if (usage <= target) break; del(c.file); }
  if (usage > target) {
    // 向量缓存会按需重算
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of list) {
        if (e.isDirectory()) stack.push(path.join(d, e.name));
        else if (/^embeddings\.db(-wal|-shm)?$/.test(e.name)) del(path.join(d, e.name));
      }
    }
  }
  return freed;
}

/**
 * 检查一个世界：统计、超过 100% 时回收；返回 { bytes, limit, ratio, detail, full }。
 * full = 回收后仍然超限：拒绝新建时间线、开启新快照、进化引擎生成新插件。
 */
export function checkDisk(root, limit) {
  let detail = diskUsage(root);
  if (Number.isFinite(limit) && detail.total > limit) {
    const freed = reclaim(root, limit * 0.9);
    if (freed) { console.log(`[disk] ${path.basename(root)}：超过上限，回收了 ${(freed / MB).toFixed(1)} MB（旧快照、向量缓存）`); detail = diskUsage(root); }
  }
  const ratio = Number.isFinite(limit) ? detail.total / limit : 0;
  return { bytes: detail.total, limit, ratio, detail, full: ratio > 1 };
}

export const bytesToMB = (b) => Math.round((b / MB) * 10) / 10;
