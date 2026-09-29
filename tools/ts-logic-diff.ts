#!/usr/bin/env node
// TypeScript 迁移的核对工具（重构方案 §8.2「不借迁移改逻辑」）：两个版本的代码去掉类型与注释后，按词法单元比对，
// 列出所有差异块。补类型的提交里应该只剩等价改写（类字段声明、非空断言、括号……），逐条过一遍即可。
//   node tools/ts-logic-diff.ts <改名提交> <补类型提交 | WORKTREE> <文件>…
// 注：正则字面量里含引号时分词会把一段代码当成字符串，这类差异需要人工看原文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
process.removeAllListeners('warning');
const [base, head, ...files] = process.argv.slice(2);
const show = (rev: string, f: string): string => (rev === 'WORKTREE' ? fs.readFileSync(f, 'utf8') : execFileSync('git', ['show', `${rev}:${f}`], { encoding: 'utf8' }));
const toks = (src: string): string[] => stripTypeScriptTypes(src, { mode: 'strip' })
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
  .match(/`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|[A-Za-z_$一-龥][\w$一-龥]*|\d+(?:\.\d+)?|\S/g) || [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-'));
let total = 0;
for (const f of files) {
  let a, b;
  try { a = toks(show(base!, f)); b = toks(show(head!, f)); } catch (e) { console.log(`? ${f}: ${(e as Error).message.split('\n')[0]}`); continue; }
  fs.writeFileSync(path.join(dir, 'a'), a.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b'), b.join('\n') + '\n');
  const r = spawnSync('diff', [path.join(dir, 'a'), path.join(dir, 'b')], { encoding: 'utf8' });
  if (!r.stdout) { console.log(`= ${f}`); continue; }
  const hunks = [];
  for (const block of r.stdout.split(/\n(?=\d)/)) {
    const [hdr, ...lines] = block.split('\n');
    const m = /^(\d+)/.exec(hdr);
    const at = Number(m![1]);
    const ctx = a.slice(Math.max(0, at - 8), at - 1).join(' ');
    hunks.push(`   …${ctx}  ‖ ${lines.filter((l) => /^[<>]/.test(l)).map((l) => l.replace(/^< /, '−').replace(/^> /, '+')).join(' ')}`);
  }
  total += hunks.length;
  console.log(`≠ ${f}（${hunks.length} 处）\n${hunks.join('\n')}`);
}
console.log(`共 ${total} 处差异`);
