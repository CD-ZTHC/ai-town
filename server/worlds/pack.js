// 世界包（多世界设计 §3）：世界是数据，不是代码。
//   world.json  规格：设定、支柱、日历、居民、建筑、地点、物品、能力、规则、参数、叙述口吻（voice）、作息（rhythm）、时代（era）
//   map.json    区域：每个区域用哪个生成器、生成参数（语义布局）
//   arcs/*.json 剧情弧
//   bible.json  世界圣经（人物、地点、物件、规则、时间线、文风；每条事实带出处）——创世生成的世界才有完整内容
//   source/     原文分块与索引（只给创世与运行时检索用，不对外提供，不参与哈希）
// 官方世界在仓库的 worlds/<id>/；用户创世生成的在 data/worlds/<id>/pack/。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { solveLayout } from '../worldgen/layout.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OFFICIAL_DIR = path.join(ROOT, 'worlds');
export const WORLD_ID_RE = /^[a-z][a-z0-9-]{2,31}$/;
export { RATINGS } from '../kernel/ratings.ts';

const HM = z.string().regex(/^\d{1,2}:\d{2}$/, '应为 HH:MM');
const text = (max) => z.string().min(1).max(max);

/** 世界包里除内核规格以外的字段（内核规格仍由 kernel/spec.js 的 validateSpec 校验） */
export const VoiceSchema = z.object({
  name: text(16), // 世界名（界面标题）
  emoji: text(8).default('🌸'),
  place: text(8).default('小镇'), // 提示词与文案里对这个地方的称呼：小镇 / 森林 / 王国……
  spawn: z.string().max(32).optional(), // 旅人现身的地点
  resident: text(8).default('居民'),
  chronicle: z.object({
    name: text(16), // 《云溪日报》
    kind: text(8), // 日报 / 公告 / 歌谣 / 起居注
    editor: text(16), // 主编 / 吟游诗人 / 史官
    style: text(80),
  }),
  ui: z.object({
    tagline: text(40).default('正在唤醒居民们的记忆……'),
    welcome: text(200),
    sampleEvents: z.array(text(60)).max(12).default([]),
  }),
});
export const RhythmSchema = z.object({ plan: HM, diary: HM, chronicle: HM });
export const EraSchema = z.object({ tech: text(24), forbidden: z.array(text(16)).max(40).default([]) });
export const PackMetaSchema = z.object({
  voice: VoiceSchema,
  rhythm: RhythmSchema,
  era: EraSchema,
  lore: z.object({ pillars: z.array(text(80)).min(1).max(12), breakers: z.string().max(400).default(''), summary: text(2000), canon: z.array(z.any()) }).passthrough(),
  source: z.object({ title: z.string().max(60), author: z.string().max(40).default(''), license: z.string().max(80).default('') }).optional(),
}).passthrough();

const PlaceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), kind: z.string().regex(/^[a-z_]{2,16}$/), name: text(16),
  emoji: z.string().max(8).optional(), desc: z.string().max(120).optional(), public: z.boolean().optional(), outdoor: z.boolean().optional(),
  size: z.tuple([z.number().int(), z.number().int()]).optional(),
  style: z.object({ roof: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), wall: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    roofShape: z.enum(['gable', 'thatch', 'flat', 'spire', 'dome']).optional(), material: z.enum(['plaster', 'wood', 'stone', 'brick']).optional(),
    decor: z.array(z.enum(['chimney', 'flowers', 'awning', 'lantern', 'ivy', 'sign', 'bell', 'banner'])).max(6).optional(), sign: z.string().max(4).optional() }).optional(),
});
const AreaSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,23}$/), name: z.string().max(16).optional(), biome: z.string().max(16).optional(), size: z.enum(['small', 'medium', 'large']).optional(), places: z.array(PlaceSchema).max(16) });
export const MapSchema = z.object({
  regions: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,23}$/), generator: z.string().min(1).max(32), name: text(16),
    areas: z.array(AreaSchema).max(9).optional(), links: z.array(z.object({ from: z.string(), to: z.string(), via: z.enum(['path', 'trail', 'bridge']).optional() })).max(16).optional(),
  }).passthrough()).min(1).max(12)
    .refine((rs) => rs[0].id === 'town', { message: '第一个区域是主地图，id 必须是 town' })
    .refine((rs) => new Set(rs.map((r) => r.id)).size === rs.length, { message: '区域 id 重复' }),
});

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** 世界包的内容哈希（不含 source/）：存档里记下它，世界包改动后能看出来 */
export function hashPack(pack) {
  return crypto.createHash('sha256').update(canonical({ world: pack.world, map: pack.map, arcs: pack.arcs })).digest('hex').slice(0, 16);
}

export class PackError extends Error {
  constructor(errors) { super(`世界包不合法：${errors.slice(0, 5).join('；')}`); this.errors = errors; this.status = 422; }
}

/** 校验世界包的结构（不含内核规格的语义校验）；返回错误列表 */
export function packErrors(pack) {
  const errs = [];
  const add = (where, r) => { if (!r.success) for (const i of r.error.issues) errs.push(`${where}.${i.path.join('.')}: ${i.message}`); };
  add('world', PackMetaSchema.safeParse(pack.world));
  add('map', MapSchema.safeParse(pack.map));
  for (const [i, a] of (pack.arcs || []).entries()) if (!a || typeof a.id !== 'string') errs.push(`arcs[${i}]: 缺少 id`);
  return errs;
}

/** 读取一个世界包目录 */
export function loadPack(dir) {
  const world = readJSON(path.join(dir, 'world.json'));
  const map = fs.existsSync(path.join(dir, 'map.json')) ? readJSON(path.join(dir, 'map.json')) : { regions: world.regions || [] };
  const arcDir = path.join(dir, 'arcs');
  const arcs = fs.existsSync(arcDir) ? fs.readdirSync(arcDir).filter((f) => f.endsWith('.json')).sort().map((f) => readJSON(path.join(arcDir, f))) : [];
  const bible = fs.existsSync(path.join(dir, 'bible.json')) ? readJSON(path.join(dir, 'bible.json')) : null;
  const pack = { dir, world, map, arcs, bible };
  const errs = packErrors(pack);
  if (errs.length) throw new PackError(errs);
  pack.world = PackMetaSchema.parse(world); // 补齐默认值
  pack.hash = hashPack(pack);
  return pack;
}

/** 写出一个世界包（创世与导出用）；arcs 每个一个文件 */
export function writePack(dir, { world, map, arcs = [], bible = null }) {
  fs.mkdirSync(path.join(dir, 'arcs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), `${JSON.stringify(world, null, 1)}\n`);
  fs.writeFileSync(path.join(dir, 'map.json'), `${JSON.stringify(map, null, 1)}\n`);
  for (const f of fs.readdirSync(path.join(dir, 'arcs'))) fs.rmSync(path.join(dir, 'arcs', f));
  for (const a of arcs) fs.writeFileSync(path.join(dir, 'arcs', `${a.id}.json`), `${JSON.stringify(a, null, 1)}\n`);
  if (bible) fs.writeFileSync(path.join(dir, 'bible.json'), `${JSON.stringify(bible, null, 1)}\n`);
}

/**
 * 世界包 → 内核规格。overrides：世界级设置（分级、叙事者），覆盖世界包里的默认值。
 * 顺序与之前相同：世界包（底座）→ Mod → 插件覆盖层 → 操作历史重放（后面三步在 Town 里）。
 */
export function packSpec(pack, overrides = {}) {
  const w = structuredClone(pack.world);
  const spec = { ...w, regions: structuredClone(pack.map.regions), arcs: structuredClone(pack.arcs) };
  // 语义布局的区域：由布局求解器给出建筑坐标与地点（确定性），叠在世界包自己写的建筑与地点之前
  spec.buildings = spec.buildings || [];
  spec.locations = spec.locations || {};
  for (const r of spec.regions) {
    if (r.generator !== 'layout-v1') continue;
    const solved = solveLayout(r);
    spec.buildings = [...solved.buildings, ...spec.buildings.filter((b) => !solved.buildings.some((x) => x.id === b.id))];
    spec.locations = { ...solved.locations, ...spec.locations };
  }
  spec.meta = { ...spec.meta, ...(overrides.rating ? { rating: overrides.rating } : {}), ...(overrides.storyteller ? { storyteller: overrides.storyteller } : {}) };
  return spec;
}

const cache = new Map();
/** 官方世界包（仓库里的 worlds/<id>/），按目录缓存 */
export function officialPack(id = 'yunxi') {
  if (!cache.has(id)) cache.set(id, loadPack(path.join(OFFICIAL_DIR, id)));
  return cache.get(id);
}
export function officialIds() {
  try { return fs.readdirSync(OFFICIAL_DIR).filter((d) => fs.existsSync(path.join(OFFICIAL_DIR, d, 'world.json'))); } catch { return []; }
}
