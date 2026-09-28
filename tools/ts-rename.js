#!/usr/bin/env node
// TypeScript 迁移的改名工具（重构方案 §8.2）：git mv 一批 .js → .ts，并把所有引用方的相对 import 改成 .ts。
//   node tools/ts-rename.js server/scheduler server/memory.js …   （目录则递归处理其中的 .js）
//   --dry  只打印要改的地方
// 只改能解析到被改名文件的相对路径：静态 import / export from、动态 import('…')、以及 path.join(…, 'x.js') 这类
// 硬编码的入口（这些只打印提醒，需要人工确认）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) { console.error('用法：node tools/ts-rename.js <文件或目录>… [--dry]'); process.exit(2); }

const ROOTS = ['server', 'plugin-host', 'plugins/builtin', 'evolution', 'tools', 'test'];
function* walk(dir, ext = /\.(js|ts)$/) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p, ext); } else if (ext.test(e.name)) yield p;
  }
}

const moving = new Set();
for (const t of targets) {
  const st = fs.statSync(t);
  if (st.isDirectory()) for (const f of walk(t, /\.js$/)) moving.add(path.resolve(f));
  else if (t.endsWith('.js')) moving.add(path.resolve(t));
}
if (!moving.size) { console.error('没有要改名的 .js 文件'); process.exit(1); }

const SPEC = /((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"])(\.{1,2}\/[^'"]+?\.js)(['"])/g;
const HARD = /['"]([\w./-]*\.js)['"]/g;
let edits = 0;
const warnings = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    const abs = path.resolve(f);
    const src = fs.readFileSync(f, 'utf8');
    const out = src.replace(SPEC, (m, a, spec, b) => {
      const target = path.resolve(path.dirname(abs), spec);
      if (!moving.has(target)) return m;
      edits++;
      return `${a}${spec.slice(0, -3)}.ts${b}`;
    });
    // 硬编码的文件名（入口路径、spawn 参数）：只提醒
    for (const m of out.matchAll(HARD)) {
      const base = path.basename(m[1]);
      if (m.index > 0 && /(from\s*|import\s*\(\s*|import\s+)$/.test(out.slice(Math.max(0, m.index - 12), m.index))) continue;
      if ([...moving].some((p) => path.basename(p) === base && (m[1].includes('/') ? p.endsWith(path.normalize(m[1]).replace(/^(\.\.?\/)+/, '')) : true))) warnings.push(`${f}：${m[0]}`);
    }
    if (out !== src && !dry) fs.writeFileSync(f, out);
  }
}
for (const f of moving) {
  const rel = path.relative(process.cwd(), f);
  if (dry) console.log(`git mv ${rel} ${rel.slice(0, -3)}.ts`);
  else execFileSync('git', ['mv', rel, `${rel.slice(0, -3)}.ts`]);
}
console.log(`${dry ? '（预览）' : ''}改名 ${moving.size} 个文件，改了 ${edits} 处 import`);
if (warnings.length) console.log(`\n需要人工确认的硬编码路径：\n  ${[...new Set(warnings)].join('\n  ')}`);
