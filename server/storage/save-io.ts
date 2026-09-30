// 读写一条时间线的存档，不管它是新的 world.db 还是升级前的 save.json（重构方案 P5 §9.2）。
// 给运行中的小镇以外的地方用：时间线分叉、时光回溯、重置、影子试运行、进化引擎、命令行工具。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DB_FILE, WorldStore, copyDbFile, dbFiles, readDbFile, readDbSnapshot, gunzipDb } from './world-store.ts';
import type { SaveObject } from './world-store.ts';
import type { SaveData } from '../types/town.ts';

export const LEGACY_FILE = 'save.json';

/** 这个目录有存档吗（数据库或旧的 save.json） */
export function hasSave(dir: string): boolean {
  return fs.existsSync(path.join(dir, DB_FILE)) || fs.existsSync(path.join(dir, LEGACY_FILE));
}

/** 读出一条时间线的完整存档；数据库优先，没有数据库时读旧的 save.json；都没有返回 null。损坏时抛错 */
export function readWorldSave(dir: string): SaveData | null {
  if (fs.existsSync(path.join(dir, DB_FILE))) return readDbFile(path.join(dir, DB_FILE));
  if (fs.existsSync(path.join(dir, LEGACY_FILE))) return JSON.parse(fs.readFileSync(path.join(dir, LEGACY_FILE), 'utf8'));
  return null;
}

/** 读一份快照：dNNN-HH.db.gz（新）、dNNN-HH.json.gz、dNNN-HH.json（升级前）。损坏时抛错 */
export function readSnapshotFile(file: string): SaveData {
  let d: SaveData | null;
  if (file.endsWith('.db.gz')) d = readDbSnapshot(file);
  else {
    const buf = fs.readFileSync(file);
    d = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  }
  if (!d || typeof d !== 'object') throw new Error('快照是空的');
  return d;
}

/** 删掉目录里的存档（数据库及其 WAL、旧的 save.json）；调用方先确保没有小镇在用它 */
export function removeSave(dir: string): void {
  for (const f of [...dbFiles(dir), path.join(dir, LEGACY_FILE), path.join(dir, `${LEGACY_FILE}.tmp`)]) fs.rmSync(f, { force: true });
}

/** 用一份存档内容替换目录里的存档（写成数据库） */
export function writeWorldSave(dir: string, save: SaveObject): void {
  removeSave(dir);
  const s = new WorldStore(dir);
  try { s.write(save, { full: true }); } finally { s.close(); }
}

/** 用一份快照替换目录里的存档：.db.gz 直接解压成数据库，旧格式的 JSON 快照导入成数据库 */
export function restoreSnapshotFile(file: string, dir: string): void {
  if (file.endsWith('.db.gz')) {
    readDbSnapshot(file); // 先确认快照能读，损坏的快照不允许替换
    removeSave(dir);
    gunzipDb(file, path.join(dir, DB_FILE));
  } else writeWorldSave(dir, readSnapshotFile(file));
}

/** 把一条时间线的存档复制到另一个目录（分叉、影子试运行）；源是正在运行的数据库也没关系。返回是否复制了东西 */
export function copyWorldSave(srcDir: string, destDir: string): boolean {
  fs.mkdirSync(destDir, { recursive: true });
  removeSave(destDir);
  if (fs.existsSync(path.join(srcDir, DB_FILE))) { copyDbFile(path.join(srcDir, DB_FILE), path.join(destDir, DB_FILE)); return true; }
  if (fs.existsSync(path.join(srcDir, LEGACY_FILE))) { fs.copyFileSync(path.join(srcDir, LEGACY_FILE), path.join(destDir, LEGACY_FILE)); return true; }
  return false;
}

/** 把存档备份成一个文件（数据库副本，或旧的 save.json 原样复制）；返回备份文件名，没有存档时返回 null */
export function backupSave(dir: string, tag: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(path.join(dir, DB_FILE))) {
    const name = `world-${tag}-${stamp}.bak.db`;
    copyDbFile(path.join(dir, DB_FILE), path.join(dir, name));
    return name;
  }
  if (fs.existsSync(path.join(dir, LEGACY_FILE))) {
    const name = `save-${tag}-${stamp}.bak.json`;
    fs.copyFileSync(path.join(dir, LEGACY_FILE), path.join(dir, name));
    return name;
  }
  return null;
}
