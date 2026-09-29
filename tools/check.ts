#!/usr/bin/env node
// mise run check：对所有 JS / TS 文件做语法检查（递归扫描，新增目录不用改这里）。
// .ts 由 node --check 按类型剥离检查：enum、namespace 等不可擦除的语法会报错；类型本身由 npm run typecheck 检查
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['server', 'plugin-host', 'plugins/builtin', 'evolution', 'public/js', 'tools', 'test'];

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
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

// 前端资源（重构方案 §7.6）：HTML 里引用的脚本 / 样式、模块之间的相对 import 都要存在于 public/ 下
// （否则 import map 里没有它，页面会白屏）；HTML 里不能有内联脚本（CSP 只放行服务端注入的 import map）
const problems: string[] = [];
const PUB = path.resolve('public');
const inPublic = (from: string, spec: string): boolean => {
  const abs = path.resolve(path.dirname(from), spec.split(/[?#]/)[0]);
  return abs.startsWith(PUB + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile();
};
function* files(dir: string, ext: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p, ext);
    else if (e.name.endsWith(ext)) yield p;
  }
}
for (const f of files('public', '.html')) {
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+)"/gi)) {
    const url = m[1]!;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue;
    if (url.startsWith('/')) problems.push(`${f}：${url} 是绝对路径（部署在子路径下会失效，也拿不到资源版本）`);
    else if (!inPublic(f, url)) problems.push(`${f}：引用的 ${url} 不存在`);
  }
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc=/.test(m[1]!) && m[2]!.trim()) problems.push(`${f}：有内联脚本（CSP 会拦截，改成外部文件）`);
  }
}
for (const f of files('public/js', '.js')) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:^|[;\s])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[;\s])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
    const spec = (m[1] || m[2] || m[3])!;
    if (!spec.startsWith('.')) { problems.push(`${f}：import '${spec}' 不是相对路径（不受 import map 覆盖）`); continue; }
    if (!inPublic(f, spec)) problems.push(`${f}：import 的 ${spec} 不存在`);
  }
}
if (problems.length) { console.error(`✖ 前端资源引用有问题：\n  ${problems.join('\n  ')}`); process.exit(1); }
// 冻结区（server/ public/ plugin-host/ evolution/ plugins/builtin/）的哈希锁：人工改动后要 mise run core:lock
process.exit(spawnSync(process.execPath, ['tools/core-guard.ts'], { stdio: 'inherit' }).status ?? 1);
