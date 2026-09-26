#!/usr/bin/env node
// mise run check：对所有 JS 文件做语法检查（递归扫描，新增目录不用改这里）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['server', 'plugin-host', 'plugins/builtin', 'evolution', 'public/js', 'tools', 'test'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

let n = 0, bad = 0;
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    n++;
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; process.stderr.write(r.stderr); }
  }
}
console.log(bad ? `✖ ${bad}/${n} 个文件有语法错误` : `ok（${n} 个文件）`);
if (bad) process.exit(1);
// 冻结区（server/ public/ plugin-host/ evolution/ plugins/builtin/）的哈希锁：人工改动后要 mise run core:lock
process.exit(spawnSync(process.execPath, ['tools/core-guard.js'], { stdio: 'inherit' }).status ?? 1);
