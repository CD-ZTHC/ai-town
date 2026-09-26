#!/usr/bin/env node
// 内核冻结守卫（自主演化设计 §8）
//   node tools/core-guard.js          校验：冻结区的文件与 core.lock 一致；AI 插件没有引用插件目录以外的代码
//   node tools/core-guard.js --lock   人工修改冻结区之后，重新生成 core.lock（mise run core:lock）
// 冻结区：server/ public/ plugin-host/ evolution/ plugins/builtin/ —— 只能由人修改；进化引擎在运行时也没有写权限。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHashes } from '../plugin-host/hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FROZEN = ['server', 'public', 'plugin-host', 'evolution', 'plugins/builtin'];
const LOCK = path.join(ROOT, 'core.lock');

export function currentHashes(root = ROOT) {
  const out = {};
  for (const d of FROZEN) for (const [f, h] of Object.entries(fileHashes(path.join(root, d)))) out[`${d}/${f}`] = h;
  return out;
}

/** 与 core.lock 比较，返回 { ok, changed, added, removed }；没有 core.lock 时 ok = null */
export function verifyCore(root = ROOT) {
  const file = path.join(root, 'core.lock');
  if (!fs.existsSync(file)) return { ok: null, changed: [], added: [], removed: [] };
  const lock = JSON.parse(fs.readFileSync(file, 'utf8')).files || {};
  const now = currentHashes(root);
  const changed = Object.keys(now).filter((f) => lock[f] && lock[f] !== now[f]);
  const added = Object.keys(now).filter((f) => !lock[f]);
  const removed = Object.keys(lock).filter((f) => !now[f]);
  return { ok: !changed.length && !added.length && !removed.length, changed, added, removed };
}

/** AI 插件只能引用自己目录里的文件 */
export function checkEvolvedImports(root = ROOT) {
  const dir = path.join(root, 'plugins', 'evolved');
  const problems = [];
  if (!fs.existsSync(dir)) return problems;
  for (const p of fs.readdirSync(dir)) {
    for (const f of Object.keys(fileHashes(path.join(dir, p))).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, p, f), 'utf8');
      for (const m of src.matchAll(/\b(?:import|export)\b[^'"`]*?from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] || m[2];
        const target = path.resolve(path.dirname(path.join(dir, p, f)), spec);
        if (!spec.startsWith('./') || !target.startsWith(path.join(dir, p) + path.sep)) problems.push(`${p}/${f} 引用了插件目录以外的模块：${spec}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--lock')) {
    const files = currentHashes();
    fs.writeFileSync(LOCK, `${JSON.stringify({ note: '冻结区文件哈希，由 mise run core:lock 生成；人工修改冻结区后需要重新生成', files }, null, 1)}\n`);
    console.log(`✅ core.lock 已更新（${Object.keys(files).length} 个文件）`);
  } else {
    const r = verifyCore();
    const bad = checkEvolvedImports();
    if (r.ok === null) console.log('⚠️ 没有 core.lock，运行 mise run core:lock 生成');
    else if (!r.ok) {
      console.log('❌ 冻结区与 core.lock 不一致：');
      for (const [k, list] of [['修改', r.changed], ['新增', r.added], ['删除', r.removed]]) for (const f of list) console.log(`   ${k} ${f}`);
      console.log('   如果是人工修改，请确认后运行 mise run core:lock');
    }
    for (const b of bad) console.log(`❌ ${b}`);
    if (r.ok === false || bad.length) process.exit(1);
    console.log('✅ 内核冻结区完整');
  }
}
