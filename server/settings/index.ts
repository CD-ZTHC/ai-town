// 设置中心（多世界设计 §14）：保存的值（data/settings.json）> 环境变量（只作初始值）> 声明里的默认值。
// 环境变量只用来给「还没有保存过」的设置提供初始值：服务启动时把它们导入设置文件（seedFromEnv），之后一律以保存的值为准，
// 改环境变量不会再影响已经保存的设置，面板上也没有被环境变量锁定的项。启动必需的几项（端口、数据目录等）例外，只能用环境变量。
// 代码里只用 settings.get('KEY')，不再直接读 process.env。每次读取都取当前值，live 类设置保存后立即生效。
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, parseString, toEnvString, checkValue } from './schema.ts';
import type { SettingDef, SettingKey, SettingValue } from './schema.ts';

export type { SettingKey, SettingValue } from './schema.ts';
type Values = Record<string, unknown>;

/** 设置文件里的一个版本 */
export interface Version {
  v: number;
  at: string;
  by: string;
  note: string;
  changed: string[];
  values: Values;
  /** 用这个版本启动成功过 */
  good: boolean;
}

export interface Rollback {
  at: string;
  from: number;
  to: number;
  reason: string;
}

/** data/settings.json */
export interface Store {
  current: number;
  versions: Version[];
  /** 已经从环境变量导入过初始值的项（导入过就不再导入，即使之后被恢复成默认值） */
  seeded?: string[];
  rollback?: Rollback;
}

export type Source = 'panel' | 'env' | 'default';

const KEEP_VERSIONS = 20;
const warned = new Set<string>();
/** 按字符串访问的声明表（遍历、面板提交的键） */
const DEFS: Record<string, SettingDef> = SETTINGS;
const defOf = (key: string): SettingDef => {
  const def = Object.hasOwn(DEFS, key) ? DEFS[key] : undefined;
  if (!def) throw new Error(`未声明的设置项：${key}`);
  return def;
};

// 设置文件：只有显式 load() 之后才读取（测试不调用 load，只看环境变量与默认值）。
let file: string | null = null;
let store: Store = { current: 0, versions: [] };
let values: Values = {}; // 当前版本里保存的值
let bootValues: Record<string, string> | null = null; // 进程启动时 restart 类设置的生效值（判断「待重启」）

const emptyStore = (): Store => ({ current: 0, versions: [] });

export function settingsFile(dataDir: string = process.env.DATA_DIR || 'data'): string { return path.join(path.resolve(dataDir), 'settings.json'); }

export function readStore(f: string): Store {
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(s.versions)) return s;
  } catch { /* 没有或损坏：视为空 */ }
  return emptyStore();
}

export function writeStore(f: string, s: Store): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
  try { fs.chmodSync(f, 0o600); } catch { /* 某些文件系统不支持 */ }
}

const currentVersion = (s: Store): Version | null => s.versions.find((v) => v.v === s.current) || null;

/** 读取设置文件（进程启动时调用一次）；返回当前版本号 */
export function load({ dataDir, file: f }: { dataDir?: string; file?: string } = {}): number {
  const target = f || settingsFile(dataDir);
  file = target;
  store = readStore(target);
  values = { ...(currentVersion(store)?.values || {}) };
  bootValues = null;
  bootValues = Object.fromEntries(Object.keys(DEFS).filter((k) => defOf(k).apply === 'restart').map((k) => [k, JSON.stringify(get(k))]));
  return store.current;
}

/** 只在测试里用：换一份内存中的设置（不落盘） */
export function _setForTest(v: Values): void { file = null; store = emptyStore(); values = { ...v }; bootValues = null; }

function fromEnv(key: string): { value: unknown; invalid?: undefined } | { value?: undefined; invalid: string } | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return undefined;
  const def = defOf(key);
  const r = checkValue(def, parseString(def, raw));
  if (r.ok) return { value: r.value };
  if (!warned.has(key)) { warned.add(key); console.warn(`[settings] 环境变量 ${key}=${def.secret ? '***' : raw} 不合法（${r.error}），已忽略`); }
  return { invalid: r.error };
}

/** 设置的当前值：保存的值优先；没有保存过的才看环境变量（初始值）；都没有用默认值。启动必需的项只看环境变量 */
export function get<K extends SettingKey>(key: K): SettingValue<K>;
export function get(key: string): unknown;
export function get(key: string): unknown {
  const def = defOf(key);
  if (def.bootstrap !== true && Object.hasOwn(values, key)) return values[key];
  if (def.bootstrap === true || !(store.seeded || []).includes(key)) {
    const e = fromEnv(key);
    if (e?.value !== undefined) return e.value;
  }
  return typeof def.default === 'function' ? def.default(get) : def.default;
}

/** 值来自哪里：panel（保存的值）/ env（环境变量：启动必需的项，或还没导入的初始值）/ default */
export function source(key: string): Source {
  const def = defOf(key);
  if (!def.bootstrap && Object.hasOwn(values, key)) return 'panel';
  if ((def.bootstrap || !(store.seeded || []).includes(key)) && fromEnv(key)?.value !== undefined) return 'env';
  return 'default';
}

/**
 * 把环境变量作为初始值导入设置文件（服务入口在 load 之后调用一次）：只导入还没有保存过、也没有导入过的项，
 * 生成一个新版本。已经保存过的项，环境变量与它不同时只提示，不覆盖。返回 { imported, ignored }
 */
export function seedFromEnv({ by = 'env' }: { by?: string } = {}): { imported: string[]; ignored: string[] } {
  const imported: string[] = [];
  const ignored: string[] = [];
  const seeded = new Set(store.seeded || []);
  const next: Values = { ...values };
  for (const [k, def] of Object.entries(DEFS)) {
    if (def.bootstrap || def.scope === 'world' || def.dev) continue;
    const e = fromEnv(k);
    if (e?.value === undefined) continue;
    if (Object.hasOwn(values, k) || seeded.has(k)) {
      if (JSON.stringify(get(k)) !== JSON.stringify(e.value)) ignored.push(k);
      continue;
    }
    next[k] = e.value;
    seeded.add(k);
    imported.push(k);
  }
  if (imported.length) {
    store.seeded = [...seeded];
    pushVersion(next, { by, note: '从环境变量导入初始值', changed: imported });
  }
  if (ignored.length) console.warn(`[settings] 这些环境变量与已保存的设置不同，已忽略（环境变量只用作初始值，请在管理面板里修改）：${ignored.join('、')}`);
  return { imported, ignored };
}

/** 环境变量与保存的值不同（面板上提示「环境变量已被忽略」） */
function envIgnored(key: string): boolean {
  const def = defOf(key);
  if (def.bootstrap) return false;
  const e = fromEnv(key);
  return e?.value !== undefined && source(key) !== 'env' && JSON.stringify(get(key)) !== JSON.stringify(e.value);
}

/**
 * 当前生效的设置，写成环境变量的字符串形式。给仍然接受 env 对象的模块（createProvider、defaultSpec 等）用，
 * 也用来启动子进程（进化引擎），让它们看到面板里保存的值。
 */
export function env(extra: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...extra };
  for (const [k, def] of Object.entries(DEFS)) {
    if (def.scope === 'world' || def.bootstrap) continue;
    const s = source(k);
    if (s === 'panel') out[k] = toEnvString(def, get(k));
    // 已经导入过、之后被恢复成默认值的项：子进程不应再看到原来的环境变量
    else if (s === 'default') delete out[k];
  }
  return out;
}

/**
 * 启动时检查：环境变量里不合法的值。只检查还起作用的环境变量：启动必需的项，以及还没保存过、要作为初始值导入的项
 * （已经保存过的项，环境变量本来就会被忽略，写错了也不影响启动）
 */
export function envProblems(): string[] {
  const out: string[] = [];
  for (const k of Object.keys(DEFS)) {
    if (!defOf(k).bootstrap && (Object.hasOwn(values, k) || (store.seeded || []).includes(k))) continue;
    const e = fromEnv(k);
    if (e?.invalid) out.push(`${k}：${e.invalid}`);
  }
  return out;
}

/** 有哪些 restart 类设置在启动之后变了（需要重启才能生效） */
export function pendingRestart(): string[] {
  const boot = bootValues;
  if (!boot) return [];
  return Object.keys(boot).filter((k) => JSON.stringify(get(k)) !== boot[k]);
}

export class SettingsError extends Error {
  errors: Record<string, string>;
  status = 422;
  constructor(errors: Record<string, string>) { super(Object.entries(errors).map(([k, e]) => `${k}：${e}`).join('；')); this.errors = errors; }
}

/** 校验一组改动（面板提交的值可以是字符串或已解析的值；null 表示恢复默认）。返回 { next, changed } */
export function validateChanges(changes: Record<string, unknown> | null | undefined): { next: Values; changed: string[] } {
  const errors: Record<string, string> = {};
  const next: Values = { ...values };
  const changed: string[] = [];
  for (const [k, raw] of Object.entries(changes || {})) {
    const def = Object.hasOwn(DEFS, k) ? DEFS[k] : undefined;
    if (!def || def.dev || def.scope === 'world') { errors[k] = '未知的设置项'; continue; }
    if (def.bootstrap) { errors[k] = '启动必需的设置只能用环境变量修改'; continue; }
    if (raw === null) { if (Object.hasOwn(next, k)) { delete next[k]; changed.push(k); } continue; }
    const v = typeof raw === 'string' && def.kind !== 'string' && def.kind !== 'enum' ? parseString(def, raw) : raw;
    const r = checkValue(def, v);
    if (!r.ok) { errors[k] = r.error; continue; }
    if (JSON.stringify(next[k]) !== JSON.stringify(r.value)) { next[k] = r.value; changed.push(k); }
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);
  return { next, changed };
}

function pushVersion(nextValues: Values, { by, note, changed }: { by: string; note?: string; changed: string[] }): number {
  const v = Math.max(0, ...store.versions.map((x) => x.v)) + 1;
  const lastGood = store.versions.filter((x) => x.good).at(-1);
  store.versions.push({ v, at: new Date().toISOString(), by, note: note || '', changed, values: nextValues, good: false });
  store.versions = store.versions.slice(-KEEP_VERSIONS);
  // 最近的「正常」版本一定保留，保证启动失败时有地方可以回退
  if (lastGood && !store.versions.some((x) => x.v === lastGood.v)) store.versions.unshift(lastGood);
  store.current = v;
  values = { ...nextValues };
  if (file) writeStore(file, store);
  return v;
}

/**
 * 保存一组改动为新版本。返回 { version, changed, restart }（restart：需要重启才能生效的项）。
 * 改动为空时不产生新版本。
 */
export function save(changes: Record<string, unknown>, { by = 'admin', note = '' }: { by?: string; note?: string } = {}): { version: number; changed: string[]; restart: string[] } {
  const { next, changed } = validateChanges(changes);
  if (!changed.length) return { version: store.current, changed, restart: pendingRestart() };
  const version = pushVersion(next, { by, note, changed });
  return { version, changed, restart: pendingRestart() };
}

/** 恢复到历史版本（生成一个内容相同的新版本） */
export function restore(v: number | string, { by = 'admin' }: { by?: string } = {}): { version: number; changed: string[]; restart: string[] } {
  const target = store.versions.find((x) => x.v === Number(v));
  if (!target) throw Object.assign(new Error('没有这个版本'), { status: 404 });
  const before = values;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(target.values)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(target.values[k]));
  const version = pushVersion({ ...target.values }, { by, note: `恢复到版本 ${target.v}`, changed });
  return { version, changed, restart: pendingRestart() };
}

/** 启动成功后把当前版本标记为「正常」 */
export function markGood(): void {
  if (!file) return;
  const s = readStore(file);
  const cur = currentVersion(s);
  if (!cur || cur.good) return;
  cur.good = true;
  writeStore(file, s);
  store = s;
}

/**
 * 守护进程在连续启动失败后调用：回退到最近一个「正常」的版本（没有的话回到空设置）。
 * 返回回退的说明，或 null（当前版本本来就是正常的，不是设置的问题）。
 */
export function rollbackToGood(f: string, reason: unknown): Rollback | null {
  const s = readStore(f);
  const cur = currentVersion(s);
  if (!cur || cur.good) return null;
  const good = s.versions.filter((x) => x.good && x.v !== cur.v).at(-1);
  s.current = good ? good.v : 0;
  s.rollback = { at: new Date().toISOString(), from: cur.v, to: s.current, reason: String(reason || '').slice(0, 500) };
  writeStore(f, s);
  return s.rollback;
}

export function lastRollback(): Rollback | null { return store.rollback || null; }

export function history(): Array<Omit<Version, 'values'> & { current: boolean }> {
  return store.versions.slice().reverse().map(({ v, at, by, note, changed, good }) => ({ v, at, by, note, changed, good, current: v === store.current }));
}

const mask = (v: unknown): string => (v ? `●●●● ${String(v).slice(-4)}` : '');

/** 面板用：所有设置项的声明、当前值（密钥只给末 4 位）、来源、是否待重启 */
export function view() {
  const pending = new Set(pendingRestart());
  return Object.entries(DEFS).filter(([, d]) => !d.dev && d.scope !== 'world').map(([key, d]) => {
    const value = get(key);
    const def = typeof d.default === 'function' ? d.default(get) : d.default;
    return {
      key, group: d.group, kind: d.kind, values: d.values, label: d.label, help: d.help || '', apply: d.apply, bootstrap: Boolean(d.bootstrap), secret: Boolean(d.secret),
      value: d.secret ? (value ? mask(value) : '') : value, isSet: Boolean(value), default: d.secret ? '' : def, source: source(key), envIgnored: envIgnored(key), pending: pending.has(key),
    };
  });
}

/** 导出（不含密钥） */
export function exportValues(): Values {
  return Object.fromEntries(Object.entries(values).filter(([k]) => !(Object.hasOwn(DEFS, k) && DEFS[k]?.secret)));
}

export const settings = { get, source, seedFromEnv, env, load, save, restore, markGood, history, view, pendingRestart, envProblems, exportValues, lastRollback };
export default settings;
