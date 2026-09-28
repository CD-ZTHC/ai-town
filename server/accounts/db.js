// 账号数据库（多世界设计 §5.7）：node:sqlite，直接写 SQL。账号、会话、授予、世界登记、举报、用量账本、审计都在这里。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1：初始表
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     nickname TEXT NOT NULL,
     nickname_key TEXT NOT NULL UNIQUE,
     nickname_changed_at INTEGER,
     pw_hash TEXT,
     role TEXT NOT NULL DEFAULT 'user',
     disabled_at INTEGER,
     disabled_reason TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE nickname_holds (nickname_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, until INTEGER NOT NULL);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ip TEXT, ua TEXT
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE reset_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_by TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
   CREATE TABLE grants (
     user_id TEXT NOT NULL, cap TEXT NOT NULL, quota TEXT NOT NULL DEFAULT '{}', granted_by TEXT, granted_at INTEGER NOT NULL,
     expires_at INTEGER, note TEXT, PRIMARY KEY (user_id, cap)
   );
   CREATE TABLE worlds (
     id TEXT PRIMARY KEY, owner_id TEXT, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', source_title TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'public', official INTEGER NOT NULL DEFAULT 0, rating TEXT NOT NULL DEFAULT 'cozy',
     pack_hash TEXT, evolution INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}', quota TEXT NOT NULL DEFAULT '{}',
     disk_bytes INTEGER NOT NULL DEFAULT 0, disk_detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, published_at INTEGER,
     status_reason TEXT, status_at INTEGER, released_at INTEGER
   );
   CREATE TABLE reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT, world_id TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, reporter TEXT NOT NULL,
     created_at INTEGER NOT NULL, handled_at INTEGER, handled_by TEXT, resolution TEXT
   );
   CREATE INDEX reports_world ON reports(world_id, handled_at);
   CREATE TABLE usage (
     day TEXT NOT NULL, world_id TEXT NOT NULL, user_id TEXT NOT NULL, class TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, world_id, user_id, class)
   );
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}');
   CREATE INDEX audit_at ON audit(at);`,
  // 2：按世界配置模型服务（world-llm 设计 §3）：凭据表；用量账本按计费来源（server / own）分开
  `CREATE TABLE llm_credentials (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
     key_enc TEXT NOT NULL, key_last4 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unchecked', fail_code TEXT, last_error TEXT,
     checked_at INTEGER, models TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE INDEX llm_credentials_owner ON llm_credentials(owner);
   CREATE TABLE usage2 (
     day TEXT NOT NULL, world_id TEXT NOT NULL, user_id TEXT NOT NULL, class TEXT NOT NULL, billing TEXT NOT NULL DEFAULT 'server',
     tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, world_id, user_id, class, billing)
   );
   INSERT INTO usage2 (day, world_id, user_id, class, billing, tokens, calls) SELECT day, world_id, user_id, class, 'server', tokens, calls FROM usage;
   DROP TABLE usage;
   ALTER TABLE usage2 RENAME TO usage;`,
];

/** 打开（或创建）账号数据库并执行迁移。file 为 ':memory:' 时只在内存里（测试用） */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  const ver = Number(db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v || 0);
  for (let i = ver; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(String(i + 1));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch { /* 忽略 */ } }
  return db;
}

/** 在一个事务里执行 fn */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
