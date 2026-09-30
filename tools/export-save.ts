#!/usr/bin/env node
// mise run export-save -- [--dir data/worlds/yunxi] [--out save.json]
// 把一条时间线的存档（world.db）导出成升级前的 save.json：用于回滚到 P5 之前的版本与排查问题。
// 运行中的服务也可以导出（VACUUM INTO 取一致的副本）；导出的文件放回目录并删掉 world.db 后，旧版本能直接读取。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorldSave } from '../server/storage/save-io.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const dir = path.resolve(ROOT, arg('--dir', process.env.DATA_DIR || 'data')!);
const out = path.resolve(ROOT, arg('--out', path.join(dir, 'save.export.json'))!);
const save = readWorldSave(dir);
if (!save) { console.error(`找不到存档：${dir}`); process.exit(1); }
fs.writeFileSync(`${out}.tmp`, JSON.stringify(save));
fs.renameSync(`${out}.tmp`, out);
console.log(`✅ 第${Math.floor((save.t || 0) / 1440) + 1}天的存档 → ${path.relative(ROOT, out) || out}（${(fs.statSync(out).size / 1024).toFixed(0)}KB）`);
