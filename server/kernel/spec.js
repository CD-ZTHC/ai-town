// 世界规格：把原本写死在代码里的世界（设定、居民、建筑、地点、天气、日历、参数）变成一份可校验的数据。
// 默认规格由 personas.js / world.js 的常量生成，保证与重构前完全一致；之后的一切改动都以 WorldOp 叠加在它上面。
import { PERSONAS, TOWN_LORE } from '../personas.js';
import { BUILDINGS, LOCATION_INFO } from '../world.js';
import { parseHM } from '../memory.js';
import { validateAbility } from './abilities.js';
import { validateRule } from './rules.js';

export const SPEC_VERSION = 2;
export const RATINGS = ['cozy', 'adventure', 'epic'];
export const STORYTELLERS = ['gentle', 'voyage', 'chaos'];

// 内核参数：AI 只能在上下限之内调节（见设计文档 4.6）
export const PARAM_BOUNDS = {
  walkSpeed: [2, 5],
  maxConvos: [1, 6],
  convoBaseProb: [0.05, 0.6],
  reflectThreshold: [20, 80],
  dayEnd: [21 * 60, 25 * 60], // 分钟，可以晚到次日 01:00
};

const PUBLIC_LOCS = ['cafe', 'library', 'tavern', 'clinic', 'workshop', 'square', 'market', 'park', 'farm', 'pier'];

const clone = (x) => structuredClone(x);

// ---------- 默认内容：物品、构筑物、能力、规则（都可以被 WorldOp 扩充）----------
const DEFAULT_ITEMS = () => ({
  lantern: { name: '萤火灯', emoji: '🏮', desc: '竹骨纸面的小灯，萤火节必备' },
  wood: { name: '木材', emoji: '🪵', desc: '工坊和农场常用的木料' },
  herb: { name: '草药', emoji: '🌿', desc: '周医生常备的安神草药' },
  melon: { name: '西瓜', emoji: '🍉', desc: '陈家农场的西瓜，镇上最甜' },
});

const DEFAULT_STRUCTURES = () => ({
  light_ward: { name: '萤火结界', emoji: '🏮', tags: ['light'], ttl: 90, light: { r: 110, color: '255,205,110' } },
});

const DEFAULT_ABILITIES = () => [
  {
    id: 'firefly_ward', name: '萤火结界', emoji: '🏮', target: 'area',
    desc: '点起一圈萤火灯，让周围亮堂起来、让人安心',
    aiHint: '夜里、雾天或有人害怕时，在户外使用',
    cost: { stamina: 15, items: { lantern: 1 } }, cooldown: 120,
    requires: '!self.inside',
    effects: [
      { op: 'spawn', structure: 'light_ward', ttl: 90 },
      { op: 'vfx', preset: 'glow_ring', color: '#ffd76a', radius: 3 },
      { op: 'stat', stat: 'courage', add: 6, target: 'nearby', radius: 3, includeSelf: true },
      { op: 'memory', text: '{self}点起了一圈萤火灯，四周一下子亮了', target: 'nearby', radius: 3, importance: 4 },
    ],
    learn: { teach: true, research: { location: 'library', keywords: ['萤火', '灯', '结界', '传说', '镜湖'] } },
  },
  {
    id: 'warm_coffee', name: '暖心咖啡', emoji: '☕', target: 'agent',
    desc: '亲手冲一杯对方爱喝的咖啡',
    aiHint: '朋友疲惫或心情低落时',
    cost: { stamina: 5 }, cooldown: 60, requires: "self.loc == 'cafe'",
    effects: [
      { op: 'stat', stat: 'stamina', add: 15, target: 'target' },
      { op: 'affinity', toward: 'self', delta: 2, target: 'target' },
      { op: 'memory', text: '{self}给我冲了一杯咖啡，暖暖的', target: 'target', importance: 3 },
      { op: 'vfx', preset: 'sparkle', color: '#c48a5a', radius: 1 },
    ],
    learn: { teach: true },
  },
  {
    id: 'checkup', name: '问诊', emoji: '🩺', target: 'agent',
    desc: '给对方做个简单检查，叮嘱注意身体',
    aiHint: '发现有人疲惫、受惊或身体不适时',
    cost: { stamina: 10 }, cooldown: 90,
    effects: [
      { op: 'condition', remove: '疲惫', target: 'target' },
      { op: 'condition', remove: '受惊', target: 'target' },
      { op: 'stat', stat: 'stamina', add: 10, target: 'target' },
      { op: 'memory', text: '{self}给我做了检查，叮嘱我注意身体', target: 'target', importance: 4 },
      { op: 'vfx', preset: 'heal', color: '#7fd6a0', radius: 1 },
    ],
  },
  {
    id: 'moon_song', name: '月光之歌', emoji: '🎶', target: 'area',
    desc: '轻轻唱一首流浪时学会的歌',
    aiHint: '傍晚在酒馆或广场，大家需要鼓舞时',
    cost: { stamina: 15 }, cooldown: 180, requires: 'hour >= 17',
    effects: [
      { op: 'stat', stat: 'courage', add: 8, target: 'nearby', radius: 4 },
      { op: 'memory', text: '听{self}唱了一首歌，心里暖暖的', target: 'nearby', radius: 4, importance: 4 },
      { op: 'vfx', preset: 'notes', color: '#b58cff', radius: 3 },
    ],
    learn: { teach: true },
  },
  {
    id: 'craft_lantern', name: '扎萤火灯', emoji: '🔨', target: 'self',
    desc: '用木材扎一盏萤火灯',
    aiHint: '在工坊、有木材时，为萤火节或结界备灯',
    cost: { stamina: 10, items: { wood: 2 } }, cooldown: 60, requires: "self.loc == 'workshop'",
    effects: [
      { op: 'giveItem', item: 'lantern', count: 1 },
      { op: 'vfx', preset: 'burst', color: '#ffb347', radius: 1 },
    ],
    learn: { teach: true },
  },
  {
    id: 'old_tale', name: '讲古', emoji: '📜', target: 'agent',
    desc: '给对方讲一段云溪镇的老故事',
    aiHint: '和年轻人闲坐、对方好奇过去时',
    cost: { stamina: 5 }, cooldown: 120,
    effects: [
      { op: 'memory', text: '{self}给我讲了一段镜湖的老故事', target: 'target', importance: 5 },
      { op: 'stat', stat: 'courage', add: 3, target: 'target' },
      { op: 'affinity', toward: 'self', delta: 2, target: 'target' },
    ],
  },
  {
    id: 'pick_melon', name: '摘西瓜', emoji: '🍉', target: 'self',
    desc: '从瓜田里挑一个熟透的西瓜',
    aiHint: '在农场、想送人西瓜时',
    cost: { stamina: 8 }, cooldown: 90, requires: "self.loc == 'farm'",
    effects: [{ op: 'giveItem', item: 'melon', count: 1 }],
  },
];

const DEFAULT_RULES = () => [
  {
    id: 'ward_comfort', name: '萤火安神', when: { every: 30 }, forEach: 'agent',
    if: "e.status != 'sleeping' && nearStructure(e, 'light', 3)",
    then: [{ op: 'stat', stat: 'courage', add: 2, target: 'e' }, { op: 'stat', stat: 'stamina', add: 1, target: 'e' }],
  },
  {
    id: 'rain_tired', name: '淋雨疲惫', when: { every: 60 }, forEach: 'agent',
    if: "(weather == 'rain' || weather == 'storm') && !e.inside && e.status != 'sleeping'",
    then: [{ op: 'stat', stat: 'stamina', add: -3, target: 'e' }],
  },
];

export function defaultSpec(env = process.env) {
  const rating = RATINGS.includes(env.STORY_RATING) ? env.STORY_RATING : 'cozy';
  const locations = {};
  for (const [id, info] of Object.entries(LOCATION_INFO)) {
    if (id === 'home') continue;
    locations[id] = { ...info, public: PUBLIC_LOCS.includes(id) };
  }
  return {
    id: 'yunxi',
    specVersion: SPEC_VERSION,
    meta: { name: '云溪镇', rating, storyteller: 'gentle' },
    lore: {
      summary: TOWN_LORE,
      pillars: ['云溪镇的温馨底色不可改变', '居民不会死亡，离开小镇也总是可以回来'],
      canon: [],
    },
    calendar: {
      weekdays: ['周三', '周四', '周五', '周六', '周日', '周一', '周二'],
      events: [
        { id: 'firefly', name: '萤火节', emoji: '🏮', day: 4, from: '18:00', location: 'pier', hint: '晚上大家会在镜湖边放灯许愿', vfx: 'festival_lanterns', countdown: true },
      ],
    },
    // weight 为自动天气的相对权重；avoid 表示在某时段内改用 fallback（例如白天不起雾）
    weather: {
      sunny: { name: '晴朗', emoji: '☀️', weight: 50 },
      cloudy: { name: '多云', emoji: '⛅', weight: 25 },
      rain: { name: '下雨', emoji: '🌧️', weight: 13 },
      storm: { name: '雷阵雨', emoji: '⛈️', weight: 5 },
      fog: { name: '起雾', emoji: '🌫️', weight: 7, avoid: { from: '10:00', to: '19:00', fallback: 'cloudy' } },
      snow: { name: '下雪', emoji: '❄️', weight: 0 },
    },
    regions: [{ id: 'town', generator: 'yunxi-v1', seed: 20260924, size: [64, 44] }],
    locations,
    buildings: clone(BUILDINGS),
    personas: clone(PERSONAS),
    creatures: [],
    items: DEFAULT_ITEMS(),
    structures: DEFAULT_STRUCTURES(),
    abilities: DEFAULT_ABILITIES(),
    rules: DEFAULT_RULES(),
    factions: [],
    arcs: [],
    params: { walkSpeed: 3.2, maxConvos: 3, convoBaseProb: 0.22, reflectThreshold: 40, dayEnd: 22 * 60 + 30 },
  };
}

// ---------- 校验 ----------
const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v) => Number.isInteger(v);

/** 返回错误列表（空数组表示通过）。只做结构与引用完整性检查，不涉及剧情合理性。 */
export function validateSpec(s) {
  const errs = [];
  const err = (path, msg) => errs.push(`${path}: ${msg}`);
  if (!s || typeof s !== 'object') return ['spec: 不是对象'];
  if (s.specVersion !== SPEC_VERSION) err('specVersion', `应为 ${SPEC_VERSION}`);
  if (!RATINGS.includes(s.meta?.rating)) err('meta.rating', `只能是 ${RATINGS.join('/')}`);
  if (!STORYTELLERS.includes(s.meta?.storyteller)) err('meta.storyteller', `只能是 ${STORYTELLERS.join('/')}`);
  if (!isStr(s.lore?.summary, 2000)) err('lore.summary', '缺失或过长');
  if (!Array.isArray(s.lore?.canon)) err('lore.canon', '应为数组');

  const cal = s.calendar || {};
  if (!Array.isArray(cal.weekdays) || cal.weekdays.length !== 7 || !cal.weekdays.every((w) => isStr(w, 8))) err('calendar.weekdays', '应为 7 个名称');
  const evIds = new Set();
  for (const [i, e] of (cal.events || []).entries()) {
    const p = `calendar.events[${i}]`;
    if (!ID_RE.test(e.id || '')) err(p, 'id 不合法');
    else if (evIds.has(e.id)) err(p, `id 重复：${e.id}`);
    evIds.add(e.id);
    if (!isStr(e.name, 16)) err(p, 'name 缺失或过长');
    if (!isInt(e.day) || e.day < 1) err(p, 'day 应为正整数');
    if (parseHM(e.from) == null) err(p, 'from 应为 HH:MM');
  }

  const weathers = Object.entries(s.weather || {});
  if (!weathers.length) err('weather', '至少需要一种天气');
  if (!weathers.some(([, w]) => w.weight > 0)) err('weather', '至少一种天气的 weight > 0');
  for (const [id, w] of weathers) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(`weather.${id}`, 'id 不合法');
    if (!isStr(w.name, 8) || !isStr(w.emoji, 8)) err(`weather.${id}`, 'name/emoji 缺失');
    if (typeof w.weight !== 'number' || w.weight < 0 || w.weight > 100) err(`weather.${id}`, 'weight 应在 0~100');
    if (w.avoid && !Object.hasOwn(s.weather, w.avoid.fallback)) err(`weather.${id}`, `fallback 不存在：${w.avoid.fallback}`);
  }

  const bIds = new Set();
  for (const b of s.buildings || []) {
    if (bIds.has(b.id)) err(`buildings.${b.id}`, 'id 重复');
    bIds.add(b.id);
    if (![b.x, b.y, b.w, b.h].every(isInt) || b.w < 2 || b.h < 2) err(`buildings.${b.id}`, '位置或尺寸不合法');
  }
  const locs = s.locations || {};
  for (const [id, l] of Object.entries(locs)) {
    if (!isStr(l.name, 16)) err(`locations.${id}`, 'name 缺失或过长');
  }

  const items = s.items || {};
  for (const [id, it] of Object.entries(items)) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(`items.${id}`, 'id 不合法');
    if (!isStr(it.name, 8) || !isStr(it.emoji, 8)) err(`items.${id}`, 'name/emoji 缺失');
  }
  for (const [id, st] of Object.entries(s.structures || {})) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(id)) err(`structures.${id}`, 'id 不合法');
    if (!isStr(st.name, 8) || !isStr(st.emoji, 8)) err(`structures.${id}`, 'name/emoji 缺失');
    if (!Array.isArray(st.tags)) err(`structures.${id}`, 'tags 应为数组');
    if (st.light && !(st.light.r >= 20 && st.light.r <= 160 && /^\d{1,3},\d{1,3},\d{1,3}$/.test(st.light.color))) err(`structures.${id}`, 'light 不合法');
  }
  const abIds = new Set();
  for (const ab of s.abilities || []) {
    if (abIds.has(ab.id)) err(`abilities.${ab.id}`, 'id 重复');
    abIds.add(ab.id);
    const e = validateAbility(ab, s);
    if (e) err(`abilities.${ab.id}`, e);
  }
  const ruleIds = new Set();
  for (const r of s.rules || []) {
    if (ruleIds.has(r.id)) err(`rules.${r.id}`, 'id 重复');
    ruleIds.add(r.id);
    const e = validateRule(r, s);
    if (e) err(`rules.${r.id}`, e);
  }

  const pIds = new Set();
  for (const p of s.personas || []) {
    const path = `personas.${p.id}`;
    if (!ID_RE.test(p.id || '')) { err(path, 'id 不合法'); continue; }
    if (pIds.has(p.id)) err(path, 'id 重复');
    pIds.add(p.id);
    if (!isStr(p.name, 12) || !isStr(p.persona, 400) || !isStr(p.role, 30)) err(path, 'name/persona/role 缺失或过长');
    if (!bIds.has(p.home)) err(path, `home 不是建筑：${p.home}`);
    if (!locs[p.work] && !bIds.has(p.work)) err(path, `work 不存在：${p.work}`);
    if (!p.look || typeof p.look !== 'object') err(path, '缺少 look');
    for (const id of p.start?.abilities || []) if (!abIds.has(id)) err(path, `初始能力不存在：${id}`);
    for (const id of Object.keys(p.start?.inventory || {})) if (!Object.hasOwn(items, id)) err(path, `初始物品不存在：${id}`);
  }
  for (const p of s.personas || []) {
    for (const rid of Object.keys(p.relations || {})) if (!pIds.has(rid)) err(`personas.${p.id}.relations`, `未知居民：${rid}`);
  }

  for (const [k, v] of Object.entries(s.params || {})) {
    const b = Object.hasOwn(PARAM_BOUNDS, k) && PARAM_BOUNDS[k];
    if (!b) err(`params.${k}`, '未知参数');
    else if (typeof v !== 'number' || v < b[0] || v > b[1]) err(`params.${k}`, `应在 ${b[0]}~${b[1]}`);
  }
  return errs;
}

// ---------- 查询工具 ----------
export function weekdayOf(spec, day) {
  const w = spec.calendar.weekdays;
  return w[(((day - 1) % w.length) + w.length) % w.length];
}

/** 当前正在进行的日历事件 */
export function activeEvents(spec, day, minute) {
  return spec.calendar.events.filter((e) => {
    if (e.day !== day) return false;
    const from = parseHM(e.from) ?? 0;
    const to = e.to ? parseHM(e.to) : 24 * 60;
    return minute >= from && minute < to;
  });
}

/** 给提示词用的节日倒计时文案（与重构前的 festivalHint 文案一致） */
export function calendarHint(spec, day) {
  return spec.calendar.events.filter((e) => e.countdown).map((e) => {
    const d = e.day - day;
    if (d > 0) return `距离${weekdayOf(spec, e.day)}${e.name}还有${d}天。`;
    if (d === 0) return `今天就是${e.name}！${e.hint ? `${e.hint}。` : ''}`;
    return `${e.name}已经过去了。`;
  }).join('');
}

/** 按权重抽取自动天气 */
export function pickWeather(spec, minute, rnd = Math.random) {
  const list = Object.entries(spec.weather).filter(([, w]) => w.weight > 0);
  const total = list.reduce((s, [, w]) => s + w.weight, 0);
  let r = rnd() * total;
  let id = list[list.length - 1][0];
  for (const [k, w] of list) { if ((r -= w.weight) < 0) { id = k; break; } }
  const av = spec.weather[id].avoid;
  if (av && minute > parseHM(av.from) && minute < parseHM(av.to)) id = av.fallback;
  return id;
}

/** 前端需要的规格子集 */
export function publicSpec(spec) {
  return {
    meta: spec.meta, calendar: spec.calendar, weather: spec.weather, canon: spec.lore.canon,
    items: spec.items, structures: spec.structures,
    abilities: spec.abilities.map(({ id, name, emoji, desc, target }) => ({ id, name, emoji, desc, target })),
    rules: spec.rules.map(({ id, name }) => ({ id, name })),
  };
}
