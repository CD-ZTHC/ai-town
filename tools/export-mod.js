#!/usr/bin/env node
// mise run export-mod -- --id <mod-id> [--name 名字] [--desc 说明] [--data data] [--out spec/mods] [--proposals-only]
// 把小镇存档里 AI 创造的内容（建筑、节日、天气、物品、构筑物、能力、规则、设定）导出成 Mod
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportMod } from '../server/kernel/mods.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const data = path.resolve(ROOT, arg('--data', process.env.DATA_DIR || 'data'));
const out = path.resolve(ROOT, arg('--out', 'spec/mods'));
const save = JSON.parse(fs.readFileSync(path.join(data, 'save.json'), 'utf8'));
const mod = exportMod(save.specOps || [], { id: arg('--id'), name: arg('--name'), description: arg('--desc', ''), source: `第${Math.floor((save.t || 0) / 1440) + 1}天的存档`, proposalsOnly: argv.includes('--proposals-only') });
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, `${mod.id}.json`);
fs.writeFileSync(file, JSON.stringify(mod, null, 2) + '\n');
console.log(`✅ 导出 ${mod.ops.length} 个操作 → ${path.relative(ROOT, file)}\n   加载方式：MODS=${mod.id}`);
