// 扩展加载器：启动时按文件名顺序导入 server/ext/ 下除本文件与 registry.js 之外的所有 .js。
// 每个扩展文件在被导入时调用 registerEffect / registerExprFn 完成注册。加载失败会中止启动，避免带着半套能力运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensions } from './registry.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !['index.js', 'registry.js'].includes(f)).sort();
for (const f of files) {
  try {
    await import(pathToFileURL(path.join(dir, f)).href);
  } catch (e) {
    throw new Error(`[ext] 加载扩展 ${f} 失败：${e.message}`);
  }
}
if (files.length) console.log(`[ext] 已加载 ${extensions().length} 项扩展能力（${files.join('、')}）`);
