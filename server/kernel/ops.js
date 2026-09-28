// WorldOp：对世界规格的一切修改都是一条带类型、可校验、可重放的操作。
// 存档只保存「操作历史」，读档时 = 默认规格 + 按序重放，因此代码里对基础设定的更新也会同步到老存档。
import fs from 'node:fs';
import path from 'node:path';
import { PARAM_BOUNDS, RATINGS, STORYTELLERS, validateSpec } from './spec.js';
import { lethal } from './ratings.js';
import { parseHM } from '../memory.js';
import { checkRemap, applyRemap } from './impact.js';
import { stripOf, packStrip, SIDES, MAX_SIZE } from '../worldgen/extend.js';
import { buildRegion } from '../worldgen/index.js';
import { validateAbility } from './abilities.js';
import { validateRule } from './rules.js';
import { solveLayout, layoutProblems, regionSize, mapSize, BIOME_IDS, BUILDING_KINDS, OUTDOOR_KINDS } from '../worldgen/layout.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
// 与 JS 对象原型重名的 id（constructor、toString……）一律不允许，避免查表时混淆
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const validId = (id) => ID_RE.test(id || '') && !RESERVED.has(id);
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const building = (spec, id) => (spec.buildings || []).find((b) => b.id === id && !b.removed);
const bName = (spec, id) => (spec?.buildings || []).find((b) => b.id === id)?.name || id;
const pName = (spec, id) => spec?.personas?.find((p) => p.id === id)?.name || id;

// 地形编辑的公共检查
const MAX_EDITS = 40;
const townOf = (spec) => spec.regions.find((r) => r.id === 'town') || spec.regions[0];
const editsProblem = (spec) => ((townOf(spec).edits || []).length >= MAX_EDITS ? `这张地图上的地形改动已经够多了（最多 ${MAX_EDITS} 处）` : null);
const cellsOk = (spec, cells, max) => {
  const [W, H] = mapSize(townOf(spec));
  return Array.isArray(cells) && cells.length > 0 && cells.length <= max && cells.every((c) => Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1]) && c[0] >= 0 && c[1] >= 0 && c[0] < W && c[1] < H);
};
const rectOk = (spec, r, max) => {
  const [W, H] = mapSize(townOf(spec));
  return r && [r.x, r.y, r.w, r.h].every(Number.isInteger) && r.w >= 1 && r.h >= 1 && r.w <= max && r.h <= max && r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;
};
const pushEdit = (spec, e) => { const r = townOf(spec); (r.edits ||= []).push(e); };
const locName = (spec, id) => spec?.locations?.[id]?.name || (spec?.buildings || []).find((b) => b.id === id)?.name || id || '那里';

// 地图扩展：地点的占地、屋顶配色、平移
const ROOFS = ['#c0392b', '#8e44ad', '#2e8b57', '#d9a441', '#5b7bb4', '#7b5b4b', '#b86b4b'];
const placeSizes = (places) => Object.fromEntries(places.map((p) => [p.id, BUILDING_KINDS[p.kind] || OUTDOOR_KINDS[p.kind] || [5, 5]]));
/** 向西 / 向北扩展：这个区域里运行中加入的一切（新增建筑、地形编辑、已有的扩展块）跟着平移；世界包的基础内容由 offset 平移 */
function shiftRegion(spec, region, dx, dy) {
  for (const b of spec.buildings) if (b.added && (b.region || 'town') === region.id) { b.x += dx; b.y += dy; }
  for (const e of region.edits || []) {
    if (e.cells) e.cells = e.cells.map(([x, y]) => [x + dx, y + dy]);
    if (e.trees) e.trees = e.trees.map(([x, y, k]) => [x + dx, y + dy, k]);
    if (e.rect) e.rect = { ...e.rect, x: e.rect.x + dx, y: e.rect.y + dy };
  }
  for (const ext of region.extensions || []) ext.rect = { ...ext.rect, x: ext.rect.x + dx, y: ext.rect.y + dy };
  for (const e of region.entries || []) e.at += e.side === 'east' || e.side === 'west' ? dy : dx;
  region.offset = { x: (region.offset?.x || 0) + dx, y: (region.offset?.y || 0) + dy };
}

// 区域：地点块的检查、相邻关系
const SIDE_NAMES = { north: '北边', south: '南边', east: '东边', west: '西边' };
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const regionName = (spec, id) => spec?.regions?.find((r) => r.id === id)?.name || id;
/** 某张地图在某一侧有没有相邻的地图（它自己连过去的，或者别的地图连过来的） */
export function neighborOn(spec, id, side) {
  const r = spec.regions.find((x) => x.id === id);
  if (r?.adjacent && OPPOSITE[r.adjacent.side] === side) return r.adjacent.to;
  return spec.regions.find((x) => x.adjacent?.to === id && x.adjacent.side === side)?.id || null;
}
function areasProblem(spec, a) {
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
  return null;
}
function adjacentApply(spec, a) {
  const from = spec.regions.find((r) => r.id === (a.from || 'town'));
  const [FW, FH] = mapSize(from);
  const size = a.side === 'east' || a.side === 'west' ? [a.length, FH] : [FW, a.length];
  const r = { ...regionOf({ ...a, seed: Number.isInteger(a.seed) ? a.seed : 1 }), size, open: true, adjacent: { to: from.id, side: a.side } };
  r.entries = a.passages.map((at, i) => ({ side: OPPOSITE[a.side], at, to: from.id, key: `${a.id}_${i}` }));
  (from.entries ||= []).push(...a.passages.map((at, i) => ({ side: a.side, at, to: a.id, key: `${a.id}_${i}` })));
  if (a.fromName) from.name = str(a.fromName, 16);
  const solved = solveLayout(r);
  spec.regions.push(r);
  spec.buildings.push(...solved.buildings);
  Object.assign(spec.locations, solved.locations);
}

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
  // 新的剧情线程（伏笔看板）：例如被全票通过拆掉旧居的人，之后可能有和解、纪念或补偿的故事
  addThread: {
    level: 'micro',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if ((spec.threads || []).some((t) => t.id === a.id)) return `线程已存在：${a.id}`;
      if (!str(a.title, 20) || !str(a.hook, 80)) return 'title / hook 不能为空';
      return (spec.threads || []).length >= 60 ? '剧情线程已达上限' : null;
    },
    apply(spec, a) { (spec.threads ||= []).push({ id: a.id, title: str(a.title, 20), hook: str(a.hook, 80) }); },
    describe: (a) => `新的故事线索：${str(a.title, 20)}`,
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
      const region = spec.regions.find((r) => r.id === (a.region || 'town')) || spec.regions[0];
      const [RW, RH] = mapSize(region);
      const cap = Math.floor((RW * RH) / 120);
      if (spec.buildings.filter((b) => !b.removed && (b.region || 'town') === region.id).length >= cap) return `这张地图上的建筑已经够多了（最多 ${cap} 座）`;
      if (!str(a.name, 10)) return 'name 不能为空（≤10字）';
      if (!/^[a-z]{2,16}$/.test(a.kind || '')) return 'kind 应为 2~16 个小写字母';
      if (!(Number.isInteger(a.w) && a.w >= 3 && a.w <= 7 && Number.isInteger(a.h) && a.h >= 3 && a.h <= 6)) return '尺寸应为宽 3~7、高 3~6';
      const [W, H] = [RW, RH];
      if (!(Number.isInteger(a.x) && Number.isInteger(a.y) && a.x >= 1 && a.y >= 1 && a.x + a.w <= W - 1 && a.y + a.h <= H - 2)) return '位置超出地图';
      for (const k of ['roof', 'wall']) if (a[k] != null && !COLOR_RE.test(a[k])) return `${k} 应为 #rrggbb`;
      return null;
    },
    apply(spec, a) {
      spec.buildings.push({
        id: a.id, name: str(a.name, 10), kind: a.kind, x: a.x, y: a.y, w: a.w, h: a.h,
        roof: a.roof || '#8a6a4a', wall: a.wall || '#e8dcc4', ...(a.sign ? { sign: str(a.sign, 4) } : {}), lightAtNight: Boolean(a.lightAtNight), added: true,
        ...(a.region && a.region !== 'town' ? { region: a.region } : {}), ...(a.builtDay != null ? { builtDay: a.builtDay } : {}),
      });
      spec.locations[a.id] = { name: str(a.name, 10), emoji: str(a.emoji, 4) || str(a.sign, 4) || '🏠', desc: str(a.desc, 60) || str(a.name, 10), public: a.public !== false, ...(a.region && a.region !== 'town' ? { region: a.region } : {}) };
    },
    describe: (a) => `小镇上建起了新地方：${str(a.sign || a.emoji, 4)}「${str(a.name, 10)}」`,
  },
  // ---------- 建筑的一生（地图演变设计 §3）：状态、改建、拆除、修复 ----------
  setBuildingState: {
    level: 'minor',
    levelOf: (a) => (a.state === 'ruin' ? 'major' : 'minor'),
    check(spec, a) {
      const b = building(spec, a.id);
      if (!b) return `未知建筑：${a.id}`;
      if (!['closed', 'damaged', 'ruin'].includes(a.state)) return 'state 只能是 closed / damaged / ruin（恢复营业用 restoreBuilding）';
      if ((b.state || 'open') === a.state) return `「${b.name}」已经是这个状态了`;
      // 变成废墟：住户和引用要有去处，与拆除相同
      return a.state === 'ruin' ? checkRemap(spec, a.id, a.remap, { name: b.name }) : null;
    },
    apply(spec, a) {
      const b = building(spec, a.id);
      b.state = a.state;
      if (a.state === 'ruin') applyRemap(spec, a.id, a.remap);
    },
    describe: (a, spec) => `「${bName(spec, a.id)}」${{ closed: '停业了', damaged: '受损了', ruin: '成了一片废墟' }[a.state] || a.state}`,
  },
  renovateBuilding: {
    level: 'minor',
    // 改建 / 换用途：占地不变，地点 id 不变，所有引用自然保留
    check(spec, a) {
      const b = building(spec, a.id);
      if (!b) return `未知建筑：${a.id}`;
      if (b.state === 'ruin') return `「${b.name}」是废墟，先修复（restoreBuilding）再改建`;
      if (a.name != null && !str(a.name, 10)) return 'name 不能为空（≤10字）';
      if (a.name && spec.buildings.some((x) => x.id !== a.id && !x.removed && x.name === str(a.name, 10))) return `「${str(a.name, 10)}」这个名字已经有了`;
      if (a.kind != null && !/^[a-z]{2,16}$/.test(a.kind)) return 'kind 应为 2~16 个小写字母';
      for (const k of ['roof', 'wall']) if (a[k] != null && !COLOR_RE.test(a[k])) return `${k} 应为 #rrggbb`;
      if (!['name', 'kind', 'desc', 'emoji', 'sign', 'roof', 'wall', 'public', 'style'].some((k) => a[k] != null)) return '没有要改的内容';
      return null;
    },
    apply(spec, a) {
      const b = building(spec, a.id);
      const was = b.name;
      if (a.name) b.name = str(a.name, 10);
      if (a.kind) b.kind = a.kind;
      if (a.roof) b.roof = a.roof;
      if (a.wall) b.wall = a.wall;
      if (a.sign != null) b.sign = str(a.sign, 4);
      if (a.style && typeof a.style === 'object') {
        const s = a.style;
        b.style = { ...(b.style || {}), ...(['gable', 'thatch', 'flat', 'spire', 'dome'].includes(s.roofShape) ? { roofShape: s.roofShape } : {}),
          ...(['plaster', 'wood', 'stone', 'brick'].includes(s.material) ? { material: s.material } : {}),
          ...(Array.isArray(s.decor) ? { decor: s.decor.filter((d) => ['chimney', 'flowers', 'awning', 'lantern', 'ivy', 'banner', 'bell'].includes(d)).slice(0, 4) } : {}) };
      }
      const l = (spec.locations[a.id] ||= { name: was, emoji: '🏠', desc: was, public: false });
      if (a.name) l.name = str(a.name, 10);
      if (a.emoji || a.sign) l.emoji = str(a.emoji || a.sign, 4);
      if (a.desc) l.desc = str(a.desc, 60);
      if (a.public != null) l.public = Boolean(a.public);
      if (b.region && !l.region) l.region = b.region;
    },
    describe: (a, spec) => `「${bName(spec, a.id)}」改建${a.name && a.name !== bName(spec, a.id) ? `成了「${str(a.name, 10)}」` : '了'}`,
  },
  removeBuilding: {
    level: 'major',
    // 拆除：建筑消失、留下空地；remap 在同一个操作里把住户、工作地、节日、规则、出生点、渡口改指向，撤销时一起恢复
    check(spec, a) {
      const b = building(spec, a.id);
      if (!b) return `未知建筑：${a.id}`;
      return checkRemap(spec, a.id, a.remap, { name: b.name });
    },
    apply(spec, a) {
      const b = building(spec, a.id);
      applyRemap(spec, a.id, a.remap);
      // 运行中新增的建筑直接删掉；世界包里的基础建筑留在数组里（基础生成要用），标记为已拆除
      if (b.added) spec.buildings.splice(spec.buildings.indexOf(b), 1);
      else { b.removed = true; delete b.state; }
      delete spec.locations[a.id];
    },
    describe: (a, spec) => `「${a.name || bName(spec, a.id)}」被拆除了，原址成了一片空地`,
  },
  restoreBuilding: {
    level: 'minor',
    check(spec, a) {
      const b = building(spec, a.id);
      if (!b) return `未知建筑：${a.id}`;
      return b.state && b.state !== 'open' ? null : `「${b.name}」好好的，不需要修复`;
    },
    apply(spec, a) { delete building(spec, a.id).state; },
    describe: (a, spec) => `「${bName(spec, a.id)}」修好了，重新开门`,
  },
  // ---------- 地形（地图演变设计 §4）：保存求解后的格子，重放时不再求解；叠加在基础地图上（worldgen/finish.js） ----------
  addPath: {
    level: 'minor',
    check(spec, a) {
      const e = editsProblem(spec);
      if (e) return e;
      if (!cellsOk(spec, a.cells, 400)) return '路线（cells）不合法：让系统按 from / to 求解';
      if (a.surface != null && !['path', 'dirt', 'plaza'].includes(a.surface)) return 'surface 只能是 path / dirt / plaza';
      return null;
    },
    apply(spec, a) { pushEdit(spec, { kind: 'path', cells: a.cells.map(([x, y]) => [x, y]), surface: a.surface || 'path', from: a.from || null, to: a.to || null }); },
    describe: (a, spec) => `修了一条从「${locName(spec, a.from)}」到「${locName(spec, a.to)}」的路`,
  },
  addBridge: {
    level: 'major',
    check(spec, a) {
      const e = editsProblem(spec);
      if (e) return e;
      return cellsOk(spec, a.cells, 8) ? null : '桥（cells）不合法：让系统按 near 求解';
    },
    apply(spec, a) { pushEdit(spec, { kind: 'bridge', cells: a.cells.map(([x, y]) => [x, y]), near: a.near || null }); },
    describe: (a, spec) => `在「${locName(spec, a.near)}」附近架起了一座桥`,
  },
  clearArea: {
    level: 'minor',
    check(spec, a) {
      const e = editsProblem(spec);
      if (e) return e;
      return rectOk(spec, a.rect, 10) ? null : '范围（rect）不合法：让系统按 near 求解';
    },
    apply(spec, a) { pushEdit(spec, { kind: 'clear', rect: { ...a.rect }, near: a.near || null }); },
    describe: (a, spec) => `清理了「${locName(spec, a.near)}」附近的树丛，腾出一片空地`,
  },
  plantGrove: {
    level: 'minor',
    check(spec, a) {
      const e = editsProblem(spec);
      if (e) return e;
      if (!Array.isArray(a.trees) || !a.trees.length || a.trees.length > 40) return '树（trees）不合法：让系统按 near 求解';
      return cellsOk(spec, a.trees, 40) ? null : '树的位置超出地图';
    },
    apply(spec, a) { pushEdit(spec, { kind: 'grove', trees: a.trees.map(([x, y, k]) => [x, y, ['oak', 'pine', 'sakura'].includes(k) ? k : 'oak']), near: a.near || null }); },
    describe: (a, spec) => `在「${locName(spec, a.near)}」附近种了一片树`,
  },
  addOutdoorPlace: {
    level: 'minor',
    check(spec, a) {
      const e = editsProblem(spec);
      if (e) return e;
      if (!validId(a.id)) return 'id 不合法';
      if (Object.hasOwn(spec.locations, a.id) || spec.buildings.some((b) => b.id === a.id)) return `地点已存在：${a.id}`;
      if (!Object.hasOwn(OUTDOOR_KINDS, a.kind || '')) return `kind 只能是 ${Object.keys(OUTDOOR_KINDS).join('/')}`;
      if (!str(a.name, 16)) return 'name 不能为空（≤16字）';
      const [w, h] = OUTDOOR_KINDS[a.kind];
      if (!rectOk(spec, a.rect, 12) || a.rect.w !== w || a.rect.h !== h) return '位置（rect）不合法：让系统按 near 求解';
      return null;
    },
    apply(spec, a) {
      spec.locations[a.id] = { name: str(a.name, 16), emoji: str(a.emoji, 4) || '📍', desc: str(a.desc, 60) || str(a.name, 16), public: a.public !== false };
      pushEdit(spec, { kind: 'place', id: a.id, placeKind: a.kind, rect: { ...a.rect }, seed: Number(a.seed) || 1 });
    },
    describe: (a) => `多了一个新去处：${str(a.emoji, 4)}「${str(a.name, 16)}」`,
  },
  // ---------- 地图扩展（地图演变设计 §5.1）：任意方向，最大 96×64；向西 / 向北时运行中加入的坐标一起平移 ----------
  expandMap: {
    level: 'major',
    check(spec, a) {
      const region = spec.regions.find((r) => r.id === (a.region || 'town'));
      if (!region) return `未知区域：${a.region}`;
      if (!SIDES.includes(a.side)) return `side 只能是 ${SIDES.join('/')}`;
      if (!Number.isInteger(a.by) || a.by < 8 || a.by > 24) return 'by 应为 8~24 格';
      if ((region.extensions || []).length >= 8) return '这张地图已经扩展过太多次了';
      if (neighborOn(spec, region.id, a.side)) return `这一侧已经连着相邻的地图了，不能再往${SIDE_NAMES[a.side]}扩展`;
      const cur = mapSize(region);
      const { size, rect } = stripOf(cur, a.side, a.by);
      if (size[0] > MAX_SIZE[0] || size[1] > MAX_SIZE[1]) return `地图最大 ${MAX_SIZE.join('×')}，这个方向已经到头了（可以在那一侧开辟相邻的地图）`;
      if (a.biome != null && !BIOME_IDS.includes(a.biome)) return `biome 只能是 ${BIOME_IDS.join('/')}`;
      if (!str(a.name, 16)) return 'name 不能为空（≤16字）';
      const places = Array.isArray(a.places) ? a.places : [];
      if (places.length > 6) return '新地块最多 6 个地点';
      const ids = new Set();
      for (const p of places) {
        if (!validId(p.id) || ids.has(p.id) || Object.hasOwn(spec.locations, p.id) || spec.buildings.some((b) => b.id === p.id)) return `地点 id 不合法或已存在：${p.id}`;
        ids.add(p.id);
        if (!Object.hasOwn(BUILDING_KINDS, p.kind) && !Object.hasOwn(OUTDOOR_KINDS, p.kind)) return `地点类型未知：${p.kind}`;
        if (!str(p.name, 16)) return '地点需要 name';
      }
      const { problems } = packStrip(rect, a.side, places, placeSizes(places));
      return problems.length ? problems[0] : null;
    },
    apply(spec, a) {
      const region = spec.regions.find((r) => r.id === (a.region || 'town'));
      const cur = mapSize(region);
      if (!region.baseSize) region.baseSize = [...regionSize(region)];
      const { rect, dx, dy, size } = stripOf(cur, a.side, a.by);
      if (dx || dy) shiftRegion(spec, region, dx, dy);
      region.size = size;
      const places = Array.isArray(a.places) ? a.places : [];
      const { placed } = packStrip(rect, a.side, places, placeSizes(places));
      const seed = Number(a.seed) || 1;
      const inRegion = region.id !== 'town' ? { region: region.id } : {};
      for (const p of places) {
        const r = placed[p.id];
        if (!r) continue;
        spec.locations[p.id] = { name: str(p.name, 16), emoji: str(p.emoji, 4) || (Object.hasOwn(OUTDOOR_KINDS, p.kind) ? '📍' : '🏠'), desc: str(p.desc, 60) || str(p.name, 16), public: p.public !== false, ...inRegion };
        if (Object.hasOwn(OUTDOOR_KINDS, p.kind)) (region.edits ||= []).push({ kind: 'place', id: p.id, placeKind: p.kind, rect: r, seed: seed + p.id.length });
        else {
          spec.buildings.push({
            id: p.id, name: str(p.name, 10), kind: p.kind, ...r, roof: COLOR_RE.test(p.roof || '') ? p.roof : ROOFS[(seed + p.id.length) % ROOFS.length],
            wall: COLOR_RE.test(p.wall || '') ? p.wall : '#efe2c8', ...(p.sign ? { sign: str(p.sign, 4) } : {}), added: true, ...inRegion, ...(a.builtDay != null ? { builtDay: a.builtDay } : {}),
          });
        }
      }
      (region.extensions ||= []).push({ side: a.side, by: a.by, biome: BIOME_IDS.includes(a.biome) ? a.biome : 'meadow', name: str(a.name, 16), rect, seed });
    },
    describe: (a) => `${{ north: '北边', south: '南边', east: '东边', west: '西边' }[a.side] || ''}长出了一片新地方：「${str(a.name, 16)}」`,
  },
  // 开辟一个新区域（多世界设计 §3.2）：只描述语义布局，由生成器 layout-v1 落地；默认关闭，linkRegions 之后才能过去
  addRegion: {
    level: 'major',
    check(spec, a) {
      if (!validId(a.id) || a.id === 'town') return 'id 不合法';
      if (spec.regions.some((r) => r.id === a.id)) return `区域已存在：${a.id}`;
      if (spec.regions.length >= 6) return '区域已达上限（6 个）';
      const e = areasProblem(spec, a);
      if (e) return e;
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
  // 打通（或封闭）通往某个远处区域的路；entry 是主地图上的路口地点（不写时用主地图的渡口），gateName 是路口的名字
  linkRegions: {
    level: 'minor',
    check(spec, a) {
      const r = spec.regions.find((x) => x.id === a.region);
      if (!r || r.id === 'town') return `未知区域：${a.region}`;
      if (r.adjacent) return '相邻的地图一直是通的';
      if (a.entry != null && !Object.hasOwn(spec.locations, a.entry) && !spec.buildings.some((b) => b.id === a.entry && !b.removed)) return `未知地点：${a.entry}`;
      return null;
    },
    apply(spec, a) {
      const r = spec.regions.find((x) => x.id === a.region);
      r.open = a.open !== false;
      if (a.entry) r.entry = a.entry;
      if (a.gateName) r.gateName = str(a.gateName, 12);
    },
    describe: (a) => (a.open === false ? `通往「${a.region}」的路被封上了` : `通往「${a.region}」的路打通了`),
  },
  // 相邻的地图（地图演变 §5.2）：主地图（或另一张相邻地图）在某一侧到头之后，在那一侧新建一张地图，接壤的边上有 1~3 个通道
  addAdjacentRegion: {
    level: 'major',
    check(spec, a) {
      if (!validId(a.id) || a.id === 'town') return 'id 不合法';
      if (spec.regions.some((r) => r.id === a.id)) return `区域已存在：${a.id}`;
      if (spec.regions.length >= 6) return '区域已达上限（6 个）';
      const from = spec.regions.find((r) => r.id === (a.from || 'town'));
      if (!from) return `未知区域：${a.from}`;
      if (!SIDES.includes(a.side)) return `side 只能是 ${SIDES.join('/')}`;
      if (neighborOn(spec, from.id, a.side)) return `「${from.name || from.id}」的${SIDE_NAMES[a.side]}已经有相邻的地图了`;
      if (!Number.isInteger(a.length) || a.length < 32 || a.length > MAX_SIZE[a.side === 'east' || a.side === 'west' ? 0 : 1]) return 'length（远离接缝的方向有多长）应为 32~96（南北向最多 64）';
      const e = areasProblem(spec, a);
      if (e) return e;
      const edge = a.side === 'east' || a.side === 'west' ? mapSize(from)[1] : mapSize(from)[0];
      if (!Array.isArray(a.passages) || !a.passages.length || a.passages.length > 3 || !a.passages.every((p) => Number.isInteger(p) && p >= 2 && p <= edge - 3)) return '通道（passages）不合法：让系统选';
      const next = structuredClone(spec);
      adjacentApply(next, a);
      const r = next.regions.find((x) => x.id === a.id);
      const problems = layoutProblems(r, next);
      if (problems.length) return `布局不可行：${problems[0]}`;
      const w = buildRegion(r, next);
      const wf = buildRegion(next.regions.find((x) => x.id === from.id), next);
      const mine = (w.passages || []).length, theirs = (wf.passages || []).filter((p) => p.to === a.id).length;
      if (mine < a.passages.length || theirs < a.passages.length) return '接壤的边上开不出通道（被水或建筑挡住了），换个位置';
      return null;
    },
    apply(spec, a) { adjacentApply(spec, a); },
    describe: (a, spec) => `「${regionName(spec, a.from || 'town')}」的${SIDE_NAMES[a.side]}连上了一片新地方：「${str(a.name, 16)}」`,
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
      if (!['active', 'departed', 'dead'].includes(a.status)) return 'status 只能是 active / departed / dead';
      if (a.status === 'dead' && !lethal(spec.meta.rating)) return '这个世界的分级不允许死亡';
      if (p.status === 'dead') return `${p.name}已经不在人世了`;
      return null;
    },
    apply(spec, a) { spec.personas.find((x) => x.id === a.id).status = a.status; },
    describe: (a, spec) => { const n = pName(spec, a.id); const place = spec?.voice?.place || '小镇'; return a.status === 'dead' ? `${n}死了` : a.status === 'departed' ? `${n}离开了${place}` : `${n}回到了${place}`; },
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
