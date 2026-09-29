// 内置插件加载器：启动时按目录名顺序导入 plugins/builtin/*/server.js（人工维护、可信、在进程内运行）。
// 加载失败会中止启动，避免带着半套能力运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Town } from '../server/sim.ts';
import type { PluginManifest } from './types/plugin.d.ts';
import type { BuiltinApi } from './index.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILTIN_DIR = path.join(ROOT, 'plugins', 'builtin');

/** 内置插件的 server.js：setup 时拿到小镇与宿主的接口 */
export interface BuiltinModule {
  setup(town: Town, api: BuiltinApi): void;
  teardown?(town: Town): void;
}
export interface BuiltinPlugin { id: string; dir: string; manifest: PluginManifest; mod: BuiltinModule }

export const builtins: BuiltinPlugin[] = [];
for (const id of fs.existsSync(BUILTIN_DIR) ? fs.readdirSync(BUILTIN_DIR).sort() : []) {
  const dir = path.join(BUILTIN_DIR, id);
  if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    if (manifest.id !== id) throw new Error(`plugin.json 里的 id（${manifest.id}）与目录名不一致`);
    const mod = await import(pathToFileURL(path.join(dir, 'server.js')).href);
    if (typeof mod.default?.setup !== 'function') throw new Error('server.js 需要 export default { setup(town, api) }');
    builtins.push({ id, dir, manifest, mod: mod.default });
  } catch (e) {
    throw new Error(`[plugin] 加载内置插件 ${id} 失败：${(e as Error).message}`);
  }
}
