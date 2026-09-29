#!/usr/bin/env node
// 更换凭据加密主密钥（按世界配置模型服务设计 §3.4）。先停掉服务再运行：
//   node tools/rotate-secrets.ts                 生成新主密钥；用 <数据目录>/secret.key 时直接改写这个文件
//   node tools/rotate-secrets.ts <新主密钥>       用指定的主密钥（32 字节 base64 / hex）
// 旧主密钥来自 SECRETS_KEY 环境变量，或 <数据目录>/secret.key。用环境变量时，运行完要把 SECRETS_KEY 换成新值。
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/accounts/db.ts';
import { LlmCredentials } from '../server/accounts/llm-credentials.ts';
import { loadMasterKey, parseMasterKey, generateMasterKey } from '../server/secrets.ts';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const file = path.join(dataDir, 'accounts.db');
if (!fs.existsSync(file)) { console.error(`没有找到 ${file}`); process.exit(1); }
const cur = loadMasterKey({ envValue: process.env.SECRETS_KEY || '', dataDir });
const text = process.argv[2] || generateMasterKey();
const next = parseMasterKey(text);
const n = new LlmCredentials(openDb(file), { key: cur.key }).rotate(next);
if (cur.source === 'env') {
  console.log(`✅ 已用新主密钥重写 ${n} 份凭据。请把环境变量 SECRETS_KEY 改成：\n${text}`);
} else {
  fs.writeFileSync(`${cur.file}.tmp`, `${text}\n`, { mode: 0o600 });
  fs.renameSync(`${cur.file}.tmp`, cur.file!);
  console.log(`✅ 已用新主密钥重写 ${n} 份凭据，并更新了 ${cur.file}（记得重新备份）`);
}
