// 世界存档（重构方案 P5）：每条时间线一个 world.db（node:sqlite，WAL），代替每 20 秒整体序列化的 save.json。
//   kv     核心状态：顶层字段各一个键、每位居民一个键（不含记忆）；只写内容变化了的键
//   items  会不断增长的列表：每位居民的记忆、动态流、对话记录、编年；只追加新条目、删除被移除的条目，
//          列表顺序被打乱时（例如记忆压缩成摘要）只重写那一个列表
// 条目写入后不会再被修改（记忆压缩是换成新的摘要对象），所以按对象身份判断「已经写过」。
// 快照：VACUUM INTO 复制出一份数据库再流式 gzip（dNNN-HH.db.gz），不需要拼出整份 JSON。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

export const DB_FILE = 'world.db';
const SCHEMA_VERSION = 1;
/** 存档里按列表增量写入的字段（其余字段写进 kv） */
export const LIST_FIELDS = ['logs', 'convoLog', 'newspapers', 'epicNotes', 'epicChapters', 'outlineRevisions'] as const;

type Json = Record<string, unknown>;
/** 读出 / 写入的完整存档：结构与 save.json（SaveV2）相同 */
export type SaveObject = Json & { agents?: Array<Json & { id: string; memories?: object[] }> };

/** 数据库文件与它的 WAL / 共享内存文件 */
export const dbFiles = (dir: string): string[] => ['', '-wal', '-shm'].map((s) => path.join(dir, DB_FILE + s));

export class WorldStore {
  declare file: string;
  declare db: DatabaseSync;
  /** 上次写入的 kv 内容（用来判断键是否变化） */
  declare lastKv: Map<string, string>;
  /** 已经写进 items 的对象 → 行号 */
  declare rows: WeakMap<object, number>;
  /** 每个列表上次写入后的行号顺序 */
  declare lists: Map<string, number[]>;
  declare maxOrd: Map<string, number>;
  /** 上次写入失败：增量记录已经不可信，下次整体重写 */
  declare needFull: boolean;
  /** 预编译的语句（每 20 秒都要用，只编译一次） */
  declare sql: { put: StatementSync; delKv: StatementSync; ins: StatementSync; delRow: StatementSync; delList: StatementSync; readList: StatementSync };

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, DB_FILE);
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, list TEXT NOT NULL, ord INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_list ON items(list, ord);`);
    this.db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    this.lastKv = new Map();
    this.rows = new WeakMap();
    this.lists = new Map();
    this.maxOrd = new Map();
    this.needFull = false;
    this.sql = {
      put: this.db.prepare('INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json'),
      delKv: this.db.prepare('DELETE FROM kv WHERE key = ?'),
      ins: this.db.prepare('INSERT INTO items (list, ord, json) VALUES (?, ?, ?)'),
      delRow: this.db.prepare('DELETE FROM items WHERE id = ?'),
      delList: this.db.prepare('DELETE FROM items WHERE list = ?'),
      readList: this.db.prepare('SELECT id, ord, json FROM items WHERE list = ? ORDER BY ord'),
    };
  }

  static exists(dir: string): boolean { return fs.existsSync(path.join(dir, DB_FILE)); }

  /** 数据库里有没有存档（新建的空库没有） */
  get empty(): boolean { return !this.db.prepare("SELECT 1 FROM kv WHERE key = 't'").get(); }

  // ---------- 读 ----------
  /** 读出完整存档（结构与 save.json 相同）；同时记住每个对象已经写过，之后只写增量 */
  readAll(): SaveObject | null {
    if (this.empty) return null;
    const out: SaveObject = {};
    for (const r of this.db.prepare('SELECT key, json FROM kv').all() as Array<{ key: string; json: string }>) {
      this.lastKv.set(r.key, r.json);
      if (!r.key.startsWith('agent:')) out[r.key] = JSON.parse(r.json);
    }
    for (const f of LIST_FIELDS) out[f] = this.readList(f);
    const ids = (out.agentIds as string[] | undefined) || [];
    delete out.agentIds;
    out.agents = ids.filter((id) => this.lastKv.has(`agent:${id}`)).map((id) => ({ ...JSON.parse(this.lastKv.get(`agent:${id}`)!), memories: this.readList(`mem:${id}`) }));
    return out;
  }

  readList(list: string): object[] {
    const rows = this.sql.readList.all(list) as Array<{ id: number; ord: number; json: string }>;
    const out = rows.map((r) => { const o = JSON.parse(r.json); this.rows.set(o, r.id); return o; });
    this.lists.set(list, rows.map((r) => r.id));
    this.maxOrd.set(list, rows.length ? rows.at(-1)!.ord : -1);
    return out;
  }

  // ---------- 写 ----------
  /** 写入存档；full：忽略增量记录，全部重写（导入旧存档、关闭前的自检） */
  write(save: SaveObject, { full = false }: { full?: boolean } = {}): { kv: number; items: number } {
    const stat = { kv: 0, items: 0 };
    full ||= this.needFull;
    this.db.exec('BEGIN');
    try {
      if (full) { this.db.exec('DELETE FROM kv; DELETE FROM items;'); this.lastKv.clear(); this.lists.clear(); this.maxOrd.clear(); this.rows = new WeakMap(); }
      const kv: Array<[string, unknown]> = [];
      const agents = save.agents || [];
      for (const [k, v] of Object.entries(save)) if (k !== 'agents' && !(LIST_FIELDS as readonly string[]).includes(k)) kv.push([k, v]);
      kv.push(['agentIds', agents.map((a) => a.id)]);
      for (const a of agents) {
        const { memories, ...rest } = a;
        kv.push([`agent:${a.id}`, rest]);
        stat.items += this.syncList(`mem:${a.id}`, memories || []);
      }
      for (const f of LIST_FIELDS) stat.items += this.syncList(f, (save[f] as object[] | undefined) || []);
      const { put, delKv, delList } = this.sql;
      const seen = new Set<string>();
      for (const [k, v] of kv) {
        if (v === undefined) continue;
        seen.add(k);
        const json = JSON.stringify(v);
        if (this.lastKv.get(k) === json) continue;
        put.run(k, json);
        this.lastKv.set(k, json);
        stat.kv++;
      }
      // 不再存在的键（离开的居民、清空的字段）
      for (const k of [...this.lastKv.keys()]) if (!seen.has(k)) { delKv.run(k); this.lastKv.delete(k); }
      // 已经离开的居民的记忆列表
      const keep = new Set(agents.map((a) => `mem:${a.id}`));
      for (const list of [...this.lists.keys()]) if (list.startsWith('mem:') && !keep.has(list)) { delList.run(list); this.lists.delete(list); this.maxOrd.delete(list); }
      this.db.exec('COMMIT');
      this.needFull = false;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* 事务已经结束 */ }
      // 增量记录可能已经和数据库不一致：下次整体重写
      this.needFull = true;
      throw e;
    }
    return stat;
  }

  /** 让数据库里的列表与内存里的数组一致；返回写入 / 删除的行数 */
  syncList(list: string, items: object[]): number {
    const prev = this.lists.get(list) || [];
    const { ins, delRow, delList } = this.sql;
    // 快速路径：已写过的条目保持原来的相对顺序、新条目都在末尾 → 删掉移除的、追加新的。
    // 用两个指针顺序比对（prev 与 items 都按顺序走一遍），不建临时的索引
    let p = 0, ok = true, firstNew = items.length;
    for (let i = 0; i < items.length; i++) {
      const id = this.rows.get(items[i]!);
      if (id === undefined) { if (firstNew === items.length) firstNew = i; continue; }
      if (i > firstNew) { ok = false; break; } // 旧条目出现在新条目之后
      while (p < prev.length && prev[p] !== id) p++;
      if (p === prev.length) { ok = false; break; } // 不在上次的列表里，或者顺序变了
      p++;
    }
    let n = 0;
    if (ok) {
      // 上次的列表里、这次不在的（items 的旧条目是 prev 的子序列，按顺序比对即可找出）
      let j = 0;
      for (const id of prev) {
        if (j < firstNew && this.rows.get(items[j]!) === id) { j++; continue; }
        delRow.run(id);
        n++;
      }
      let ord = this.maxOrd.get(list) ?? -1;
      const order = new Array<number>(items.length);
      for (let i = 0; i < items.length; i++) {
        let id = i < firstNew ? this.rows.get(items[i]!) : undefined;
        if (id === undefined) { id = Number(ins.run(list, ++ord, JSON.stringify(items[i])).lastInsertRowid); this.rows.set(items[i]!, id); n++; }
        order[i] = id;
      }
      this.lists.set(list, order);
      this.maxOrd.set(list, ord);
      return n;
    }
    // 顺序变了：整个列表重写
    delList.run(list);
    const order = items.map((o, i) => { const id = Number(ins.run(list, i, JSON.stringify(o)).lastInsertRowid); this.rows.set(o, id); return id; });
    this.lists.set(list, order);
    this.maxOrd.set(list, items.length - 1);
    return prev.length + items.length;
  }

  // ---------- 快照与复制 ----------
  /** 复制出一份一致的数据库（VACUUM INTO；已有的目标文件会被替换） */
  copyTo(dest: string): void {
    fs.rmSync(dest, { force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(dest);
  }

  /** 写一份压缩快照：先 VACUUM INTO 临时文件，再流式 gzip（不阻塞主循环）；失败时抛错，临时文件都会清理 */
  async snapshotTo(file: string): Promise<void> {
    const tmp = `${file}.db.tmp`;
    try {
      this.copyTo(tmp);
      await pipeline(fs.createReadStream(tmp), zlib.createGzip(), fs.createWriteStream(`${file}.tmp`));
      fs.renameSync(`${file}.tmp`, file);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    }
  }

  close(): void { try { this.db.close(); } catch { /* 已关闭 */ } }
}

/** 把一个（可能正在使用的）数据库复制成一份一致的新文件：VACUUM INTO 会带上 WAL 里还没合并进主文件的内容 */
export function copyDbFile(src: string, dest: string): void {
  fs.rmSync(dest, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new DatabaseSync(src);
  try {
    db.exec('PRAGMA busy_timeout = 3000;');
    db.prepare('VACUUM INTO ?').run(dest);
  } finally { db.close(); }
}

/** 从一个数据库文件（world.db 或解压后的快照）读出完整存档；原文件不会被修改 */
export function readDbFile(file: string): SaveObject | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-read-'));
  try {
    copyDbFile(file, path.join(dir, DB_FILE));
    const s = new WorldStore(dir);
    try { return s.readAll(); } finally { s.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** 解压一份 .db.gz 快照到 dest（数据库文件）；快照只有几百 KB，同步即可 */
export function gunzipDb(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.tmp`, zlib.gunzipSync(fs.readFileSync(src)));
  fs.renameSync(`${dest}.tmp`, dest);
}

/** 读一份 .db.gz 快照 */
export function readDbSnapshot(file: string): SaveObject | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-snap-'));
  try {
    gunzipDb(file, path.join(dir, DB_FILE));
    const s = new WorldStore(dir);
    try { return s.readAll(); } finally { s.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
