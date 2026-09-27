// 数据迁移（多世界设计 §13）：首次以多世界版本启动时，把 data/ 下的存档、操作日志、时间线、快照、向量缓存移到 data/worlds/yunxi/。
// 迁移前先完整备份到 data/backup-4.0-<时间>/；迁移之后世界从新位置读出的状态与迁移前一致（见 test/worlds.test.js）。
import fs from 'node:fs';
import path from 'node:path';

// 属于世界的东西（其余的 accounts.db、settings.json、evolution/ 是全站的，留在原处）
const WORLD_ITEMS = (name) => ['save.json', 'save.json.tmp', 'ops.jsonl', 'snapshots', 'timelines', 'timelines.json'].includes(name)
  || /^embeddings\.db(-wal|-shm)?$/.test(name) || /^save-.*\.bak\.json$/.test(name);

export function worldRoot(data, id) { return path.join(data, 'worlds', id); }

/** 需要迁移吗：旧位置有存档，新位置还没有 */
export function needsMigration(data, id = 'yunxi') {
  const target = worldRoot(data, id);
  if (fs.existsSync(path.join(target, 'save.json')) || fs.existsSync(path.join(target, 'ops.jsonl'))) return false;
  return fs.existsSync(data) && fs.readdirSync(data).some(WORLD_ITEMS);
}

/** 执行迁移；返回 { backup, moved } 或 null（不需要迁移） */
export function migrateLegacy(data, id = 'yunxi', { now = new Date() } = {}) {
  if (!needsMigration(data, id)) return null;
  const items = fs.readdirSync(data).filter(WORLD_ITEMS);
  const backup = path.join(data, `backup-4.0-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const f of items) fs.cpSync(path.join(data, f), path.join(backup, f), { recursive: true });
  const target = worldRoot(data, id);
  fs.mkdirSync(target, { recursive: true });
  for (const f of items) fs.renameSync(path.join(data, f), path.join(target, f));
  console.log(`[migrate] 已把 ${items.length} 项存档数据移到 ${path.relative(data, target)}/（备份在 ${path.basename(backup)}/）`);
  return { backup, moved: items };
}
