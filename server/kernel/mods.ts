// Mod（设计文档第 7 节「内容反哺」）：把一个小镇里 AI 创造的内容导出成可分享的数据包，别的小镇可以加载。
// 加载顺序：默认世界规格 → Mod（按 MODS 列出的顺序）→ 存档里的操作历史。
import fs from 'node:fs';
import path from 'node:path';
import { replay } from './ops.ts';
import type { OpRecord } from '../types/ops.ts';
import type { WorldSpec } from '../types/spec.ts';

/** Mod 里的一条操作（只有内容类操作） */
export interface ModOp { op: string; args: object }
export interface Mod {
  id: string;
  name: string;
  description: string;
  source: string;
  createdAt: string;
  ops: ModOp[];
}

// 可以导出的内容类操作（不含角色、参数、分级等状态类操作）
export const MOD_OPS: readonly string[] = ['addBuilding', 'addCalendarEvent', 'addWeather', 'addItem', 'addStructure', 'addAbility', 'addRule', 'addCanon'];
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function modsDir(root: string = process.cwd()): string { return path.resolve(root, 'spec', 'mods'); }

/** 从操作历史中导出一个 Mod */
export function exportMod(specOps: OpRecord[], { id, name, description = '', source = '', proposalsOnly = false }: { id?: string; name?: string; description?: string; source?: string; proposalsOnly?: boolean } = {}): Mod {
  if (!ID_RE.test(String(id || ''))) throw new Error('Mod id 只能包含小写字母、数字和短横线（2~32 位）');
  // proposalsOnly：只导出经建设提案落地的内容（不含剧情弧写入的剧情设定）
  const ops = specOps.filter((r) => MOD_OPS.includes(r.op) && (!proposalsOnly || r.cause?.by === 'proposal')).map((r) => ({ op: r.op, args: r.args }));
  if (!ops.length) throw new Error('这个小镇还没有可以导出的内容');
  return { id: id!, name: String(name || id).slice(0, 30), description: String(description).slice(0, 200), source: String(source).slice(0, 60), createdAt: new Date().toISOString(), ops };
}

/** 读取 Mod 文件；只保留内容类操作 */
export function readMod(file: string): Mod {
  const m: Mod = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!ID_RE.test(String(m.id || '')) || !Array.isArray(m.ops)) throw new Error(`${path.basename(file)} 不是合法的 Mod`);
  return { ...m, ops: m.ops.filter((o) => MOD_OPS.includes(o?.op)) };
}

/** 按名称列表加载 Mod 并叠加到基础规格上；返回 { spec, loaded, skipped } */
export function applyMods<S extends WorldSpec>(base: S, names: string[], dir: string = modsDir()): { spec: S; loaded: Array<{ id: string; name: string; ops: number }>; skipped: Array<{ mod: string; op?: string; error: string }> } {
  let spec = base;
  const loaded: Array<{ id: string; name: string; ops: number }> = [];
  const skipped: Array<{ mod: string; op?: string; error: string }> = [];
  for (const name of names) {
    if (!ID_RE.test(name)) { skipped.push({ mod: name, error: '名称不合法' }); continue; }
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) { skipped.push({ mod: name, error: '文件不存在' }); continue; }
    let mod: Mod;
    try { mod = readMod(file); } catch (e) { skipped.push({ mod: name, error: (e as Error).message }); continue; }
    const r = replay(spec, mod.ops);
    spec = r.spec;
    loaded.push({ id: mod.id, name: mod.name, ops: mod.ops.length - r.skipped.length });
    for (const k of r.skipped) skipped.push({ mod: name, op: k.op, error: k.error });
  }
  return { spec, loaded, skipped };
}
