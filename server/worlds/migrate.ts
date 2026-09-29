// 数据迁移（多世界设计 §13）：首次以多世界版本启动时，把 data/ 下的存档、操作日志、时间线、快照、向量缓存移到 data/worlds/yunxi/。
// 迁移前先完整备份到 data/backup-4.0-<时间>/；迁移之后世界从新位置读出的状态与迁移前一致（见 test/worlds.test.js）。
import fs from 'node:fs';
import path from 'node:path';

// 属于世界的东西（其余的 accounts.db、settings.json、evolution/ 是全站的，留在原处）
const WORLD_ITEMS = (name: string): boolean => ['save.json', 'save.json.tmp', 'ops.jsonl', 'snapshots', 'timelines', 'timelines.json'].includes(name)
  || /^embeddings\.db(-wal|-shm)?$/.test(name) || /^save-.*\.bak\.json$/.test(name);

export function worldRoot(data: string, id: string): string { return path.join(data, 'worlds', id); }

/** 需要迁移吗：旧位置有存档，新位置还没有 */
export function needsMigration(data: string, id = 'yunxi'): boolean {
  const target = worldRoot(data, id);
  if (fs.existsSync(path.join(target, 'save.json')) || fs.existsSync(path.join(target, 'ops.jsonl'))) return false;
  return fs.existsSync(data) && fs.readdirSync(data).some(WORLD_ITEMS);
}

/** 执行迁移；返回 { backup, moved } 或 null（不需要迁移） */
export function migrateLegacy(data: string, id = 'yunxi', { now = new Date() }: { now?: Date } = {}): { backup: string; moved: string[] } | null {
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

/**
 * 进化引擎全局化之后（多世界设计 §9、§13）：官方世界的 AI 插件从 plugins/evolved/ 移到 data/worlds/yunxi/plugins/，
 * 插件登记、锁定哈希、信号、候选与需求文档从 data/evolution/ 移到 data/worlds/yunxi/evolution/。
 * 任务、引擎状态与账本仍在 data/evolution/（全站共用）。先备份再移动；只做一次。
 */
export function migrateEvolution(data: string, root: string, id = 'yunxi', { now = new Date() }: { now?: Date } = {}): { backup: string; moved: string[] } | null {
  const worldEvo = path.join(worldRoot(data, id), 'evolution');
  const worldPlugins = path.join(worldRoot(data, id), 'plugins');
  const oldEvo = path.join(data, 'evolution');
  const oldPlugins = path.join(root, 'plugins', 'evolved');
  const ITEMS = ['registry.json', 'verified.json', 'signals.json', 'heartbeat.json', 'candidates', 'shadow', 'rfcs'];
  const moveEvo = fs.existsSync(oldEvo) && !fs.existsSync(path.join(worldEvo, 'registry.json')) ? ITEMS.filter((f) => fs.existsSync(path.join(oldEvo, f))) : [];
  const movePlugins = fs.existsSync(oldPlugins) && fs.readdirSync(oldPlugins).length && !(fs.existsSync(worldPlugins) && fs.readdirSync(worldPlugins).length);
  if (!moveEvo.length && !movePlugins) return null;
  const backup = path.join(data, `backup-evolution-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backup, { recursive: true });
  for (const f of moveEvo) fs.cpSync(path.join(oldEvo, f), path.join(backup, 'evolution', f), { recursive: true });
  if (movePlugins) fs.cpSync(oldPlugins, path.join(backup, 'plugins-evolved'), { recursive: true });
  fs.mkdirSync(worldEvo, { recursive: true });
  for (const f of moveEvo) fs.renameSync(path.join(oldEvo, f), path.join(worldEvo, f));
  if (movePlugins) {
    fs.mkdirSync(worldPlugins, { recursive: true });
    // 只清空内容、不删目录本身（Docker 部署里它可能是一个挂载点）
    for (const d of fs.readdirSync(oldPlugins)) {
      fs.cpSync(path.join(oldPlugins, d), path.join(worldPlugins, d), { recursive: true });
      fs.rmSync(path.join(oldPlugins, d), { recursive: true, force: true });
    }
  }
  console.log(`[migrate] 官方世界的 AI 插件与进化记录已移到 worlds/${id}/（备份在 ${path.basename(backup)}/）`);
  return { backup, moved: [...moveEvo, ...(movePlugins ? ['plugins/evolved'] : [])] };
}
