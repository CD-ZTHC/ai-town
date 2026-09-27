// 设置中心（多世界设计 §14）：值的来源只有三层，优先级从高到低：环境变量 > 面板保存的值（data/settings.json）> 声明里的默认值。
// 代码里只用 settings.get('KEY')，不再直接读 process.env。每次读取都取当前值，live 类设置保存后立即生效。
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, parseString, toEnvString, checkValue } from './schema.js';

const KEEP_VERSIONS = 20;
const warned = new Set();

// 设置文件：只有显式 load() 之后才读取（测试不调用 load，只看环境变量与默认值）
let file = null;
let store = { current: 0, versions: [] };
let values = {}; // 当前版本里保存的值
let bootValues = null; // 进程启动时 restart 类设置的生效值（判断「待重启」）

const emptyStore = () => ({ current: 0, versions: [] });

export function settingsFile(dataDir = process.env.DATA_DIR || 'data') { return path.join(path.resolve(dataDir), 'settings.json'); }

export function readStore(f) {
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(s.versions)) return s;
  } catch { /* 没有或损坏：视为空 */ }
  return emptyStore();
}

export function writeStore(f, s) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
  try { fs.chmodSync(f, 0o600); } catch { /* 某些文件系统不支持 */ }
}

const currentVersion = (s) => s.versions.find((v) => v.v === s.current) || null;

/** 读取设置文件（进程启动时调用一次）；返回当前版本号 */
export function load({ dataDir, file: f } = {}) {
  file = f || settingsFile(dataDir);
  store = readStore(file);
  values = { ...(currentVersion(store)?.values || {}) };
  bootValues = null;
  bootValues = Object.fromEntries(Object.keys(SETTINGS).filter((k) => SETTINGS[k].apply === 'restart').map((k) => [k, JSON.stringify(get(k))]));
  return store.current;
}

/** 只在测试里用：换一份内存中的设置（不落盘） */
export function _setForTest(v) { file = null; store = emptyStore(); values = { ...v }; bootValues = null; }

function fromEnv(key) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return undefined;
  const def = SETTINGS[key];
  const r = checkValue(def, parseString(def, raw));
  if (r.ok) return { value: r.value };
  if (!warned.has(key)) { warned.add(key); console.warn(`[settings] 环境变量 ${key}=${def.secret ? '***' : raw} 不合法（${r.error}），已忽略`); }
  return { invalid: r.error };
}

/** 设置的当前值 */
export function get(key) {
  const def = SETTINGS[key];
  if (!def) throw new Error(`未声明的设置项：${key}`);
  const e = fromEnv(key);
  if (e?.value !== undefined) return e.value;
  if (def.bootstrap !== true && Object.hasOwn(values, key)) return values[key];
  return typeof def.default === 'function' ? def.default(get) : def.default;
}

/** 值来自哪里：env / panel / default */
export function source(key) {
  if (fromEnv(key)?.value !== undefined) return 'env';
  if (!SETTINGS[key].bootstrap && Object.hasOwn(values, key)) return 'panel';
  return 'default';
}

/**
 * 当前生效的设置，写成环境变量的字符串形式。给仍然接受 env 对象的模块（createProvider、defaultSpec 等）用，
 * 也用来启动子进程（进化引擎），让它们看到面板里保存的值。
 */
export function env(extra = process.env) {
  const out = { ...extra };
  for (const [k, def] of Object.entries(SETTINGS)) {
    if (def.scope === 'world') continue;
    const s = source(k);
    if (s === 'panel') out[k] = toEnvString(def, get(k));
  }
  return out;
}

/** 启动时检查：环境变量里不合法的值 */
export function envProblems() {
  const out = [];
  for (const k of Object.keys(SETTINGS)) {
    const e = fromEnv(k);
    if (e?.invalid) out.push(`${k}：${e.invalid}`);
  }
  return out;
}

/** 有哪些 restart 类设置在启动之后变了（需要重启才能生效） */
export function pendingRestart() {
  if (!bootValues) return [];
  return Object.keys(bootValues).filter((k) => JSON.stringify(get(k)) !== bootValues[k]);
}

export class SettingsError extends Error {
  constructor(errors) { super(Object.entries(errors).map(([k, e]) => `${k}：${e}`).join('；')); this.errors = errors; this.status = 422; }
}

/** 校验一组改动（面板提交的值可以是字符串或已解析的值；null 表示恢复默认）。返回 { next, changed } */
export function validateChanges(changes) {
  const errors = {};
  const next = { ...values };
  const changed = [];
  for (const [k, raw] of Object.entries(changes || {})) {
    const def = SETTINGS[k];
    if (!def || def.dev || def.scope === 'world') { errors[k] = '未知的设置项'; continue; }
    if (def.bootstrap) { errors[k] = '启动必需的设置只能用环境变量修改'; continue; }
    if (source(k) === 'env') { errors[k] = '已由环境变量锁定'; continue; }
    if (raw === null) { if (Object.hasOwn(next, k)) { delete next[k]; changed.push(k); } continue; }
    const v = typeof raw === 'string' && def.kind !== 'string' && def.kind !== 'enum' ? parseString(def, raw) : raw;
    const r = checkValue(def, v);
    if (!r.ok) { errors[k] = r.error; continue; }
    if (JSON.stringify(next[k]) !== JSON.stringify(r.value)) { next[k] = r.value; changed.push(k); }
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);
  return { next, changed };
}

function pushVersion(nextValues, { by, note, changed }) {
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
export function save(changes, { by = 'admin', note = '' } = {}) {
  const { next, changed } = validateChanges(changes);
  if (!changed.length) return { version: store.current, changed, restart: pendingRestart() };
  const version = pushVersion(next, { by, note, changed });
  return { version, changed, restart: pendingRestart() };
}

/** 恢复到历史版本（生成一个内容相同的新版本） */
export function restore(v, { by = 'admin' } = {}) {
  const target = store.versions.find((x) => x.v === Number(v));
  if (!target) throw Object.assign(new Error('没有这个版本'), { status: 404 });
  const before = values;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(target.values)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(target.values[k]));
  const version = pushVersion({ ...target.values }, { by, note: `恢复到版本 ${target.v}`, changed });
  return { version, changed, restart: pendingRestart() };
}

/** 启动成功后把当前版本标记为「正常」 */
export function markGood() {
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
export function rollbackToGood(f, reason) {
  const s = readStore(f);
  const cur = currentVersion(s);
  if (!cur || cur.good) return null;
  const good = s.versions.filter((x) => x.good && x.v !== cur.v).at(-1);
  s.current = good ? good.v : 0;
  s.rollback = { at: new Date().toISOString(), from: cur.v, to: s.current, reason: String(reason || '').slice(0, 500) };
  writeStore(f, s);
  return s.rollback;
}

export function lastRollback() { return store.rollback || null; }

export function history() {
  return store.versions.slice().reverse().map(({ v, at, by, note, changed, good }) => ({ v, at, by, note, changed, good, current: v === store.current }));
}

const mask = (v) => (v ? `●●●● ${String(v).slice(-4)}` : '');

/** 面板用：所有设置项的声明、当前值（密钥只给末 4 位）、来源、是否待重启 */
export function view() {
  const pending = new Set(pendingRestart());
  return Object.entries(SETTINGS).filter(([, d]) => !d.dev && d.scope !== 'world').map(([key, d]) => {
    const value = get(key);
    const def = typeof d.default === 'function' ? d.default(get) : d.default;
    return {
      key, group: d.group, kind: d.kind, values: d.values, label: d.label, help: d.help || '', apply: d.apply, bootstrap: Boolean(d.bootstrap), secret: Boolean(d.secret),
      value: d.secret ? (value ? mask(value) : '') : value, isSet: Boolean(value), default: d.secret ? '' : def, source: source(key), pending: pending.has(key),
    };
  });
}

/** 导出（不含密钥） */
export function exportValues() {
  return Object.fromEntries(Object.entries(values).filter(([k]) => !SETTINGS[k]?.secret));
}

export const settings = { get, source, env, load, save, restore, markGood, history, view, pendingRestart, envProblems, exportValues, lastRollback };
export default settings;
