// 内容哈希：AI 插件的「评审锁定」与内核冻结校验（core.lock）都用它。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 列出目录下的所有文件（相对路径，排序；跳过以 . 开头的文件与目录） */
export function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 每个文件的哈希 */
export function fileHashes(dir) {
  return Object.fromEntries(listFiles(dir).map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))]));
}

/** 整个目录的哈希：文件名与内容都参与计算，任何改动（哪怕一个字符）都会改变结果 */
export function hashDir(dir, skip = []) {
  const h = crypto.createHash('sha256');
  for (const [f, v] of Object.entries(fileHashes(dir))) {
    if (skip.includes(f)) continue;
    h.update(`${f}\0${v}\n`);
  }
  return h.digest('hex');
}
