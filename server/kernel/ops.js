// WorldOp：对世界规格的一切修改都是一条带类型、可校验、可重放的操作。
// 存档只保存「操作历史」，读档时 = 默认规格 + 按序重放，因此代码里对基础设定的更新也会同步到老存档。
import fs from 'node:fs';
import path from 'node:path';
import { PARAM_BOUNDS, RATINGS, STORYTELLERS, validateSpec } from './spec.js';
import { parseHM } from '../memory.js';
import { validateAbility } from './abilities.js';
import { validateRule } from './rules.js';
import { solveLayout, layoutProblems, BIOME_IDS, BUILDING_KINDS, OUTDOOR_KINDS } from '../worldgen/layout.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
// 与 JS 对象原型重名的 id（constructor、toString……）一律不允许，避免查表时混淆
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const validId = (id) => ID_RE.test(id || '') && !RESERVED.has(id);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const pName = (spec, id) => spec?.personas?.find((p) => p.id === id)?.name || id;

// 每个操作：level 决定审批等级（micro / minor / major），check 返回错误文本或 null，
// apply 修改规格（传入的是副本），describe 生成给玩家看的一句话
export const OPS = {
  setParam: {
    level: 'major',
    check(spec, a) {
      const b = Object.hasOwn(PARAM_BOUNDS, a.name) && PARAM_BOUNDS[a.name];
      if (!b) return `未知参数：${a.name}`;
      if (typeof a.value !== 'number' || !Number.isFinite(a.value)) return 'value 应为数字';
      if (a.value < b[0] || a.value > b[1]) return `${a.name} 应在 ${b[0]}~${b[1]}`;
      return null;
    },
    apply(spec, a) { spec.params[a.name] = a.value; },
    describe: (a) => `世界参数 ${a.name} 调整为 ${a.value}`,
  },
  setMeta: {
    level: 'major',
    check(spec, a) {
      if (a.rating != null && !RATINGS.includes(a.rating)) return `rating 只能是 ${RATINGS.join('/')}`;
      if (a.storyteller != null && !STORYTELLERS.includes(a.storyteller)) return `storyteller 只能是 ${STORYTELLERS.join('/')}`;
      if (a.rating == null && a.storyteller == null) return '没有要修改的字段';
      return null;
    },
    apply(spec, a) {
      if (a.rating != null) spec.meta.rating = a.rating;
      if (a.storyteller != null) spec.meta.storyteller = a.storyteller;
    },
    describe: (a) => [a.rating && `内容分级改为 ${a.rating}`, a.storyteller && `叙事者改为 ${a.storyteller}`].filter(Boolean).join('，'),
  },
  addCanon: {
    level: 'micro',
    check(spec, a) {
      if (!str(a.text, 200)) return 'text 不能为空';
      if (spec.lore.canon.length >= 500) return '正典条目已达上限';
      return null;
    },
    apply(spec, a, ctx) {
      spec.lore.canon.push({
        id: `canon_${ctx.seq}`, text: str(a.text, 200),
        tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => str(t, 12)).filter(Boolean).slice(0, 6),
        secret: Boolean(a.secret), t: ctx.t,
      });
    },
    describe: (a) => (a.secret ? '一个秘密被写入了小镇的历史' : `写入设定集：${str(a.text, 40)}`),
  },
  addCalendarEvent: {
    level: 'minor',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (spec.calendar.events.some((e) => e.id === a.id)) return `日历事件已存在：${a.id}`;
      if (!str(a.name, 16)) return 'name 不能为空';
      if (!Number.isInteger(a.day) || a.day < 1) return 'day 应为正整数';
      if (parseHM(a.from) == null) return 'from 应为 HH:MM';
      if (a.to != null && parseHM(a.to) == null) return 'to 应为 HH:MM';
      if (a.location && !Object.hasOwn(spec.locations, a.location)) return `地点不存在：${a.location}`;
      return null;
    },
    apply(spec, a) {
      spec.calendar.events.push({
        id: a.id, name: str(a.name, 16), emoji: str(a.emoji, 4) || '🎉', day: a.day, from: a.from,
        ...(a.to ? { to: a.to } : {}), ...(a.location ? { location: a.location } : {}),
        hint: str(a.hint, 60), countdown: Boolean(a.countdown), ...(a.vfx === 'festival_lanterns' ? { vfx: a.vfx } : {}),
      });
    },
    describe: (a) => `新的节日「${str(a.name, 16)}」将在第 ${a.day} 天举行`,
  },
  addWeather: {
    level: 'minor',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (Object.hasOwn(spec.weather, a.id)) return `天气已存在：${a.id}`;
      if (!str(a.name, 8) || !str(a.emoji, 4)) return 'name / emoji 不能为空';
      const w = a.weight ?? 0;
      if (typeof w !== 'number' || w < 0 || w > 20) return '新天气的 weight 应在 0~20';
      const r = a.render || {};
      if (r.base && !['sunny', 'cloudy', 'rain', 'storm', 'fog', 'snow'].includes(r.base)) return `render.base 未知：${r.base}`;
      if (r.tint && !COLOR_RE.test(r.tint)) return 'render.tint 应为 #rrggbb';
      return null;
    },
    apply(spec, a) {
      const r = a.render || {};
      spec.weather[a.id] = {
        name: str(a.name, 8), emoji: str(a.emoji, 4), weight: a.weight ?? 0,
        render: { base: r.base || 'cloudy', ...(r.tint ? { tint: r.tint, tintAlpha: Math.max(0, Math.min(0.5, Number(r.tintAlpha) || 0.2)) } : {}) },
      };
    },
    describe: (a) => `天空中出现了一种新的天气：${str(a.emoji, 4)} ${str(a.name, 8)}`,
  },
  addItem: {
    level: 'micro',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (Object.hasOwn(spec.items, a.id)) return `物品已存在：${a.id}`;
      if (!str(a.name, 8) || !str(a.emoji, 4)) return 'name / emoji 不能为空';
      return null;
    },
    apply(spec, a) { spec.items[a.id] = { name: str(a.name, 8), emoji: str(a.emoji, 4), desc: str(a.desc, 40) }; },
    describe: (a) => `小镇上出现了新东西：${str(a.emoji, 4)} ${str(a.name, 8)}`,
  },
  addStructure: {
    level: 'minor',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (Object.hasOwn(spec.structures, a.id)) return `构筑物已存在：${a.id}`;
      if (!str(a.name, 8) || !str(a.emoji, 4)) return 'name / emoji 不能为空';
      if (a.ttl != null && !(a.ttl >= 10 && a.ttl <= 240)) return 'ttl 应在 10~240';
      if (a.light && !(a.light.r >= 20 && a.light.r <= 160 && /^\d{1,3},\d{1,3},\d{1,3}$/.test(a.light.color))) return 'light 不合法（r 20~160，color 形如 255,200,100）';
      return null;
    },
    apply(spec, a) {
      spec.structures[a.id] = {
        name: str(a.name, 8), emoji: str(a.emoji, 4), ttl: a.ttl ?? 60,
        tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => str(t, 12)).filter(Boolean).slice(0, 4),
        ...(a.light ? { light: { r: a.light.r, color: a.light.color } } : {}),
      };
    },
    describe: (a) => `人们学会了搭建「${str(a.name, 8)}」`,
  },
  addAbility: {
    level: 'minor',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (spec.abilities.some((x) => x.id === a.id)) return `能力已存在：${a.id}`;
      return validateAbility(a, spec);
    },
    apply(spec, a) {
      const { id, name, emoji, desc, aiHint, target, range, cost, cooldown, requires, effects, learn } = structuredClone(a);
      spec.abilities.push(Object.fromEntries(Object.entries({ id, name, emoji: str(emoji, 4) || '✨', desc, aiHint, target, range, cost, cooldown, requires, effects, learn }).filter(([, v]) => v !== undefined)));
    },
    describe: (a) => `世界上出现了一种新能力：${str(a.emoji, 4)}「${str(a.name, 8)}」`,
  },
  addBuilding: {
    level: 'minor',
    // 坐标由放置求解器给出；这里只做静态检查，占地与连通性由小镇在应用前用 checkPlacement 校验
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (spec.buildings.some((b) => b.id === a.id) || Object.hasOwn(spec.locations, a.id)) return `建筑或地点已存在：${a.id}`;
      if (spec.buildings.filter((b) => b.added).length >= 12) return '新增建筑已达上限（12 座）';
      if (!str(a.name, 10)) return 'name 不能为空（≤10字）';
      if (!/^[a-z]{2,16}$/.test(a.kind || '')) return 'kind 应为 2~16 个小写字母';
      if (!(Number.isInteger(a.w) && a.w >= 3 && a.w <= 7 && Number.isInteger(a.h) && a.h >= 3 && a.h <= 6)) return '尺寸应为宽 3~7、高 3~6';
      const [W, H] = spec.regions[0].size;
      if (!(Number.isInteger(a.x) && Number.isInteger(a.y) && a.x >= 1 && a.y >= 1 && a.x + a.w <= W - 1 && a.y + a.h <= H - 2)) return '位置超出地图';
      for (const k of ['roof', 'wall']) if (a[k] != null && !COLOR_RE.test(a[k])) return `${k} 应为 #rrggbb`;
      return null;
    },
    apply(spec, a) {
      spec.buildings.push({
        id: a.id, name: str(a.name, 10), kind: a.kind, x: a.x, y: a.y, w: a.w, h: a.h,
        roof: a.roof || '#8a6a4a', wall: a.wall || '#e8dcc4', ...(a.sign ? { sign: str(a.sign, 4) } : {}), lightAtNight: Boolean(a.lightAtNight), added: true,
      });
      spec.locations[a.id] = { name: str(a.name, 10), emoji: str(a.emoji, 4) || str(a.sign, 4) || '🏠', desc: str(a.desc, 60) || str(a.name, 10), public: a.public !== false };
    },
    describe: (a) => `小镇上建起了新地方：${str(a.sign || a.emoji, 4)}「${str(a.name, 10)}」`,
  },
  // 开辟一个新区域（多世界设计 §3.2）：只描述语义布局，由生成器 layout-v1 落地；默认关闭，linkRegions 之后才能过去
  addRegion: {
    level: 'major',
    check(spec, a) {
      if (!validId(a.id) || a.id === 'town') return 'id 不合法';
      if (spec.regions.some((r) => r.id === a.id)) return `区域已存在：${a.id}`;
      if (spec.regions.length >= 6) return '区域已达上限（6 个）';
      if (!str(a.name, 16)) return 'name 不能为空（≤16字）';
      if (a.biome != null && !BIOME_IDS.includes(a.biome)) return `biome 只能是 ${BIOME_IDS.join('/')}`;
      const areas = Array.isArray(a.areas) ? a.areas : [];
      if (!areas.length || areas.length > 4) return 'areas 需要 1~4 块';
      const ids = new Set();
      for (const ar of areas) {
        if (!validId(ar.id)) return `区域块 id 不合法：${ar.id}`;
        if (ar.biome != null && !BIOME_IDS.includes(ar.biome)) return `biome 只能是 ${BIOME_IDS.join('/')}`;
        if (!Array.isArray(ar.places) || !ar.places.length || ar.places.length > 8) return '每块需要 1~8 个地点';
        for (const p of ar.places) {
          if (!validId(p.id)) return `地点 id 不合法：${p.id}`;
          if (ids.has(p.id) || Object.hasOwn(spec.locations, p.id) || spec.buildings.some((b) => b.id === p.id)) return `地点已存在：${p.id}`;
          ids.add(p.id);
          if (!Object.hasOwn(BUILDING_KINDS, p.kind) && !Object.hasOwn(OUTDOOR_KINDS, p.kind)) return `地点类型未知：${p.kind}`;
          if (!str(p.name, 16)) return '地点需要 name';
        }
      }
      const problems = layoutProblems(regionOf(a), spec);
      return problems.length ? `布局不可行：${problems[0]}` : null;
    },
    apply(spec, a) {
      const r = regionOf(a);
      const solved = solveLayout(r);
      spec.regions.push({ ...r, open: false });
      spec.buildings.push(...solved.buildings);
      Object.assign(spec.locations, solved.locations);
    },
    describe: (a) => `世界的边缘出现了一片新的地方：「${str(a.name, 16)}」`,
  },
  // 打通（或封闭）通往某个区域的路
  linkRegions: {
    level: 'minor',
    check(spec, a) {
      const r = spec.regions.find((x) => x.id === a.region);
      if (!r || r.id === 'town') return `未知区域：${a.region}`;
      return null;
    },
    apply(spec, a) {
      const r = spec.regions.find((x) => x.id === a.region);
      r.open = a.open !== false;
    },
    describe: (a) => (a.open === false ? `通往「${a.region}」的路被封上了` : `通往「${a.region}」的路打通了`),
  },
  addPersona: {
    level: 'major',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (spec.personas.some((p) => p.id === a.id)) return `角色已存在：${a.id}`;
      if (!str(a.name, 12) || !str(a.persona, 400) || !str(a.role, 30)) return 'name / persona / role 不能为空';
      if (a.kind === 'resident') return '新角色只能是 traveller 或 creature';
      return null;
    },
    apply(spec, a) {
      const p = structuredClone(a);
      spec.personas.push({
        id: p.id, name: str(p.name, 12), age: Math.max(1, Math.min(999, Number(p.age) || 20)), role: str(p.role, 30), kind: p.kind || 'traveller', ...(p.tier === 'support' ? { tier: 'support' } : {}),
        home: p.home, work: p.work, persona: str(p.persona, 400), goal: str(p.goal, 120), look: p.look, relations: {},
        memories: (Array.isArray(p.memories) ? p.memories : []).map((m) => str(m, 80)).slice(0, 5),
        ...(p.idle ? { idle: str(p.idle, 24) } : {}), ...(p.creature ? { creature: p.creature } : {}),
        ...(p.traveller ? { traveller: { origin: str(p.traveller.origin, 30), knowledgeGap: (p.traveller.knowledgeGap || []).map((k) => str(k, 8)).slice(0, 8) } } : {}),
        start: { abilities: p.start?.abilities || [], inventory: p.start?.inventory || {} },
        status: 'active',
      });
    },
    describe: (a) => `新角色登场：${str(a.name, 12)}（${str(a.role, 30)}）`,
  },
  setPersonaStatus: {
    level: 'major',
    check(spec, a) {
      const p = spec.personas.find((x) => x.id === a.id);
      if (!p) return `未知角色：${a.id}`;
      if (!['active', 'departed'].includes(a.status)) return 'status 只能是 active / departed';
      return null;
    },
    apply(spec, a) { spec.personas.find((x) => x.id === a.id).status = a.status; },
    describe: (a, spec) => { const n = pName(spec, a.id); const place = spec?.voice?.place || '小镇'; return a.status === 'departed' ? `${n}离开了${place}` : `${n}回到了${place}`; },
  },
  // 外来者定居，成为常住居民（人员流动）；来历保留在 origin
  settlePersona: {
    level: 'major',
    check(spec, a) {
      const p = spec.personas.find((x) => x.id === a.id);
      if (!p) return `未知角色：${a.id}`;
      return p.kind === 'traveller' ? null : '只有外来者可以定居';
    },
    apply(spec, a) {
      const p = spec.personas.find((x) => x.id === a.id);
      p.kind = 'resident';
      if (p.traveller?.origin) p.origin = p.traveller.origin;
      delete p.traveller;
    },
    describe: (a, spec) => `${pName(spec, a.id)}定居下来`,
  },
  addRule: {
    level: 'major',
    check(spec, a) {
      if (spec.rules.some((x) => x.id === a.id)) return `规则已存在：${a.id}`;
      if (spec.rules.length >= 40) return '规则数量已达上限';
      return validateRule(a, spec);
    },
    apply(spec, a) {
      const { id, name, when, forEach, if: cond, then } = structuredClone(a);
      spec.rules.push(Object.fromEntries(Object.entries({ id, name, when, forEach, if: cond, then }).filter(([, v]) => v !== undefined)));
    },
    describe: (a) => `新的世界法则生效了：「${str(a.name, 16)}」`,
  },
};

export class OpError extends Error {
  constructor(msg) { super(msg); this.code = 'OP'; this.status = 400; }
}

/**
 * 在规格副本上应用一条操作，返回新规格；失败抛出 OpError，原规格不受影响。
 * 应用后还会做一次整体校验，防止单个操作检查不到的连锁问题。
 */
/** addRegion 的参数 → 区域描述 */
function regionOf(a) {
  return {
    id: a.id, name: str(a.name, 16), generator: 'layout-v1', biome: a.biome || 'meadow', seed: Number.isInteger(a.seed) ? a.seed : undefined,
    size: [40, 30], ...(a.gate ? { gate: a.gate } : {}),
    areas: (a.areas || []).map((ar) => ({ id: ar.id, biome: ar.biome, size: ['small', 'medium', 'large'].includes(ar.size) ? ar.size : 'medium',
      places: (ar.places || []).map((p) => ({ id: p.id, kind: p.kind, name: str(p.name, 16), emoji: str(p.emoji, 4) || undefined, desc: str(p.desc, 80) || undefined, public: p.public !== false })) })),
    links: Array.isArray(a.links) ? a.links.slice(0, 6).map((l) => ({ from: str(l.from, 24), to: str(l.to, 24), via: l.via === 'trail' ? 'trail' : 'path' })) : undefined,
  };
}

export function applyOp(spec, op, ctx = {}) {
  const def = Object.hasOwn(OPS, op?.op ?? '') && OPS[op.op];
  if (!def) throw new OpError(`未知操作：${op?.op}`);
  const args = op.args || {};
  const e = def.check(spec, args);
  if (e) throw new OpError(e);
  const next = structuredClone(spec);
  def.apply(next, args, { seq: ctx.seq ?? 0, t: ctx.t ?? 0 });
  const errs = validateSpec(next);
  if (errs.length) throw new OpError(`应用后规格不合法：${errs[0]}`);
  return next;
}

/** 从基础规格重放历史。无法重放的操作（例如基础设定已变化导致冲突）会被跳过并报告。 */
export function replay(base, history) {
  let spec = base;
  const skipped = [];
  for (const rec of history) {
    try { spec = applyOp(spec, rec, rec); } catch (e) { skipped.push({ seq: rec.seq, op: rec.op, error: e.message }); }
  }
  return { spec, skipped };
}

/** 追加写的审计日志（data/ops.jsonl）。日志只用于审计，重放以存档中的历史为准。 */
export class OpJournal {
  constructor(file) { this.file = file; }
  append(rec) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.warn('[ops] 写日志失败：', e.message);
    }
  }
}
