// 创世 G4 的组装（多世界设计 §4.1）：把模型给出的人物、地图、叙述口吻等拼成一个世界包。
// 模型的输出只是素材：所有字段在这里裁剪、补默认值、换成合法的 id；最后仍要通过结构校验（zod）与内核规格校验。
import { BUILDING_KINDS, OUTDOOR_KINDS, BIOME_IDS } from '../worldgen/layout.js';
import { SPEC_VERSION } from '../kernel/spec.js';

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v, d) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : d);
const HAIR = ['long', 'short', 'messy', 'buzz', 'bun', 'spiky'];
const ACC = ['apron', 'strawhat', 'beard', 'glasses', 'coat', 'cap', 'earring'];
const SKIN = ['#f7d5bd', '#f3cfb3', '#e8b896', '#d9a88a', '#c68f6a', '#8d5a3c'];
const CLOTH = ['#d62c2c', '#4a90d9', '#5bb56b', '#e8a33d', '#8e6bb8', '#4db6ac', '#f06292', '#a1887f', '#607d8b'];
const ROOFS = ['#c0392b', '#8e44ad', '#2e8b57', '#d9a441', '#5b7bb4', '#7b5b4b', '#b86b4b'];
const RATING_ORDER = ['cozy', 'adventure', 'epic', 'tragic'];
const hashStr = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const pick = (arr, seed) => arr[hashStr(seed) % arr.length];

/** 模型给的 id → 合法 id（小写字母开头，字母数字下划线）；不合法就用序号 */
export function safeId(v, fallback, used) {
  let id = String(v ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(id)) id = fallback;
  let out = id, n = 2;
  while (used.has(out)) out = `${id}_${n++}`.slice(0, 32);
  used.add(out);
  return out;
}

/** 地图：区域块 + 地点；保证每个居民的家是一座建筑（没有就补一间小屋） */
export function assembleMap(raw, { worldName, homesNeeded = 0 }) {
  const used = new Set(['town']);
  const areasIn = Array.isArray(raw?.areas) ? raw.areas.slice(0, 5) : [];
  const areas = areasIn.map((a, i) => ({
    id: safeId(a.id, `area_${i + 1}`, used),
    name: str(a.name, 16) || `区域${i + 1}`,
    biome: BIOME_IDS.includes(a.biome) ? a.biome : 'meadow',
    size: ['small', 'medium', 'large'].includes(a.size) ? a.size : 'medium',
    places: (Array.isArray(a.places) ? a.places.slice(0, 8) : []).map((p, j) => {
      const kind = Object.hasOwn(BUILDING_KINDS, p.kind) || Object.hasOwn(OUTDOOR_KINDS, p.kind) ? p.kind : 'cottage';
      const place = {
        id: safeId(p.id, `place_${i + 1}_${j + 1}`, used), kind, name: str(p.name, 16) || `地点${j + 1}`,
        emoji: str(p.emoji, 4) || (Object.hasOwn(OUTDOOR_KINDS, kind) ? '📍' : '🏠'), desc: str(p.desc, 110) || str(p.name, 16), public: p.public !== false,
      };
      if (Object.hasOwn(BUILDING_KINDS, kind)) {
        const s = p.style || {};
        place.style = {
          roof: hex(s.roof, pick(ROOFS, place.id)), wall: hex(s.wall, '#efe2c8'),
          roofShape: ['gable', 'thatch', 'flat', 'spire', 'dome'].includes(s.roofShape) ? s.roofShape : 'gable',
          material: ['plaster', 'wood', 'stone', 'brick'].includes(s.material) ? s.material : 'plaster',
          decor: (Array.isArray(s.decor) ? s.decor : ['chimney']).filter((d) => ['chimney', 'flowers', 'awning', 'lantern', 'ivy', 'banner', 'bell'].includes(d)).slice(0, 4),
        };
      }
      return place;
    }).filter((p) => p.name),
  })).filter((a) => a.places.length);
  if (!areas.length) areas.push({ id: 'village', name: '村子', biome: 'meadow', size: 'medium', places: [] });
  // 公共的户外地点至少一个（旅人现身、大家碰头）
  if (!areas.some((a) => a.places.some((p) => Object.hasOwn(OUTDOOR_KINDS, p.kind) && p.public))) {
    areas[0].places.unshift({ id: safeId('square', 'square', used), kind: 'square', name: '广场', emoji: '⛲', desc: `${worldName}的中心，大家在这里碰头`, public: true });
  }
  // 住处够每个居民（可以合住）；至少补到 ceil(需要/2) 座
  const homes = areas.flatMap((a) => a.places.filter((p) => Object.hasOwn(BUILDING_KINDS, p.kind)));
  for (let k = homes.length; k < Math.ceil(homesNeeded / 2); k++) {
    const a = areas[k % areas.length];
    if (a.places.length >= 8) continue;
    a.places.push({ id: safeId(`house_${k + 1}`, `house_${k + 1}`, used), kind: 'cottage', name: `小屋${k + 1}`, emoji: '🏠', desc: '一间普通的小屋', public: false, style: { roof: pick(ROOFS, `h${k}`), wall: '#efe2c8', roofShape: 'gable', material: 'plaster', decor: ['chimney'] } });
  }
  const ids = new Set(areas.map((a) => a.id));
  const links = (Array.isArray(raw?.links) ? raw.links : []).map((l) => ({ from: String(l.from || ''), to: String(l.to || ''), via: l.via === 'trail' ? 'trail' : 'path' }))
    .filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to).slice(0, 8);
  const gate = areas.flatMap((a) => a.places).find((p) => Object.hasOwn(OUTDOOR_KINDS, p.kind) && p.public)?.id;
  return { regions: [{ id: 'town', generator: 'layout-v1', name: str(worldName, 16) || '新世界', seed: hashStr(worldName) % 100000, biome: areas[0].biome, gate, areas, ...(links.length ? { links } : {}) }] };
}

/** 外观：只接受合法的颜色与部件，缺的按 id 稳定地挑一个 */
export function normalizeLook(raw, id) {
  const look = raw && typeof raw === 'object' ? raw : {};
  return {
    skin: hex(look.skin, pick(SKIN, `${id}s`)), hair: hex(look.hair, '#3a2a1a'), hairStyle: HAIR.includes(look.hairStyle) ? look.hairStyle : pick(HAIR, id),
    shirt: hex(look.shirt, pick(CLOTH, `${id}c`)), pants: hex(look.pants, '#5a5a7a'), acc: (Array.isArray(look.acc) ? look.acc : []).filter((a) => ACC.includes(a)).slice(0, 2),
  };
}

/** 居民：映射到内核规格的人物格式；家必须是建筑，工作地是任意地点 */
export function assemblePersonas(raw, map, { maxPersonas = 12 } = {}) {
  const places = map.regions[0].areas.flatMap((a) => a.places);
  const buildings = places.filter((p) => Object.hasOwn(BUILDING_KINDS, p.kind));
  const publicPlaces = places.filter((p) => p.public);
  const byName = new Map(places.map((p) => [p.name, p.id]));
  const placeId = (v) => (places.some((p) => p.id === v) ? v : byName.get(v) || null);
  const list = (Array.isArray(raw?.personas) ? raw.personas : []).slice(0, maxPersonas);
  const used = new Set();
  const personas = list.map((p, i) => {
    const id = safeId(p.id, `c${i + 1}`, used);
    let home = placeId(p.home);
    if (!buildings.some((b) => b.id === home)) home = buildings[i % Math.max(1, buildings.length)]?.id;
    const work = placeId(p.work) || publicPlaces[i % Math.max(1, publicPlaces.length)]?.id || home;
    return {
      id, name: str(p.name, 12) || `居民${i + 1}`, age: Math.max(3, Math.min(120, Math.round(Number(p.age) || 30))), role: str(p.role, 30) || '居民',
      home, work, persona: str(p.persona, 380) || str(p.role, 30), goal: str(p.goal, 120) || '好好过日子',
      tier: p.tier === 'support' ? 'support' : 'lead',
      look: normalizeLook(p.look, id),
      start: { abilities: [], inventory: {} },
      relations: {}, _relations: p.relations,
      memories: (Array.isArray(p.memories) ? p.memories : []).map((m) => str(m, 80)).filter(Boolean).slice(0, 5),
    };
  });
  // 关系：按名字或 id 找到对方
  const byPName = new Map(personas.map((p) => [p.name, p.id]));
  for (const p of personas) {
    const rel = p._relations && typeof p._relations === 'object' ? p._relations : {};
    for (const [k, v] of Object.entries(rel).slice(0, 8)) {
      const to = personas.some((x) => x.id === k) ? k : byPName.get(k);
      if (!to || to === p.id) continue;
      const [score, note] = Array.isArray(v) ? v : [v?.score, v?.note];
      p.relations[to] = [Math.max(-100, Math.min(100, Math.round(Number(score) || 0))), str(note, 40) || ''];
    }
    delete p._relations;
    if (!p.memories.length) p.memories.push(`我是${p.name}，${p.role}。`);
  }
  return personas;
}

/** 物品与能力：能力只用少数几种安全的效果模板 */
export function assembleExtras(raw, personas) {
  const used = new Set();
  const items = {};
  for (const [i, it] of (Array.isArray(raw?.items) ? raw.items : []).slice(0, 8).entries()) {
    const id = safeId(it.id, `item_${i + 1}`, used);
    if (id.length > 24) continue;
    items[id] = { name: str(it.name, 8) || `物品${i + 1}`, emoji: str(it.emoji, 4) || '📦', desc: str(it.desc, 60) };
  }
  const TEMPLATES = {
    story: (name) => [{ op: 'memory', text: `{self}给我讲了一段${name}`, target: 'target', importance: 5 }, { op: 'affinity', toward: 'self', delta: 2, target: 'target' }],
    cheer: () => [{ op: 'stat', stat: 'courage', add: 6, target: 'nearby', radius: 3, includeSelf: true }, { op: 'vfx', preset: 'sparkle', color: '#ffd76a', radius: 2 }],
    heal: () => [{ op: 'stat', stat: 'stamina', add: 12, target: 'target' }, { op: 'vfx', preset: 'heal', color: '#7fd6a0', radius: 1 }],
  };
  const abilities = [];
  const aUsed = new Set();
  for (const [i, a] of (Array.isArray(raw?.abilities) ? raw.abilities : []).slice(0, 6).entries()) {
    const tpl = a.template === 'make' && a.item && items[a.item] ? 'make' : Object.hasOwn(TEMPLATES, a.template) ? a.template : 'story';
    const id = safeId(a.id, `skill_${i + 1}`, aUsed);
    const name = str(a.name, 8) || `本事${i + 1}`;
    abilities.push({
      id, name, emoji: str(a.emoji, 4) || '✨', target: tpl === 'cheer' || tpl === 'make' ? (tpl === 'make' ? 'self' : 'area') : 'agent',
      desc: str(a.desc, 40) || name, aiHint: str(a.hint, 40) || '合适的时候', cost: { stamina: 8 }, cooldown: 120,
      effects: tpl === 'make' ? [{ op: 'giveItem', item: a.item, count: 1 }] : TEMPLATES[tpl](name),
      learn: { teach: true },
    });
    const owner = personas.find((p) => p.name === a.owner || p.id === a.owner);
    if (owner) owner.start.abilities.push(id);
  }
  return { items, abilities };
}

/** 世界规格（world.json）：设定、支柱、日历、天气、居民、叙述口吻、作息、时代 */
export function assembleWorld({ id, title, adapt, personas, extras, threads, options, sourceTitle }) {
  const rating = RATING_ORDER.includes(options.rating) ? options.rating : 'adventure';
  const cal = adapt?.calendar || {};
  const weekdays = Array.isArray(cal.weekdays) && cal.weekdays.length === 7 && cal.weekdays.every((w) => str(w, 8)) ? cal.weekdays.map((w) => str(w, 8)) : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const v = adapt?.voice || {};
  const ch = v.chronicle || {};
  const tUsed = new Set();
  return {
    id, specVersion: SPEC_VERSION,
    meta: { name: str(title, 16), rating, storyteller: ['gentle', 'voyage', 'chaos'].includes(options.storyteller) ? options.storyteller : 'voyage' },
    lore: {
      summary: str(adapt?.summary, 1500) || str(title, 16),
      pillars: (Array.isArray(adapt?.pillars) ? adapt.pillars : []).map((p) => str(p, 80)).filter(Boolean).slice(0, 6).concat(['没有血腥与残酷的描写']).slice(0, 6),
      breakers: /^[\p{L}\p{N}|]{0,200}$/u.test(String(adapt?.breakers || '')) ? String(adapt.breakers).replace(/^\||\|$/g, '').replace(/\|\|+/g, '|') : '血腥|屠',
      canon: (Array.isArray(adapt?.fateNodes) ? adapt.fateNodes : []).slice(0, 8).map((f, i) => ({ id: `fate_${i + 1}`, text: `原著：${str(f.text, 90)}`, tags: ['原著'], secret: false, t: 0 })),
    },
    calendar: {
      weekdays,
      events: (Array.isArray(cal.events) ? cal.events : []).slice(0, 2).map((e, i) => ({ id: `event_${i + 1}`, name: str(e.name, 16) || '节日', emoji: str(e.emoji, 4) || '🎉', day: Math.max(1, Math.min(14, Math.round(Number(e.day) || 3))), from: /^\d{1,2}:\d{2}$/.test(e.from) ? e.from : '18:00', hint: str(e.hint, 60), countdown: true })),
    },
    weather: {
      sunny: { name: '晴朗', emoji: '☀️', weight: 50 }, cloudy: { name: '多云', emoji: '⛅', weight: 25 }, rain: { name: '下雨', emoji: '🌧️', weight: 15 },
      fog: { name: '起雾', emoji: '🌫️', weight: 10, avoid: { from: '10:00', to: '17:00', fallback: 'cloudy' } },
    },
    locations: {}, buildings: [], personas, creatures: {},
    threads: (Array.isArray(threads) ? threads : []).slice(0, 5).map((t, i) => ({ id: safeId(t.id, `thread_${i + 1}`, tUsed).slice(0, 24), title: str(t.title, 20) || `线索${i + 1}`, owners: (t.owners || []).map((o) => personas.find((p) => p.name === o || p.id === o)?.id).filter(Boolean).slice(0, 3), hook: str(t.hook, 80) || str(t.title, 20) || '…' })),
    items: extras.items, structures: {}, abilities: extras.abilities, rules: [], factions: [],
    params: { walkSpeed: 3.2, maxConvos: Math.min(4, Math.max(1, Math.round(personas.length / 3))), convoBaseProb: 0.22, reflectThreshold: 40, dayEnd: 22 * 60 + 30 },
    voice: {
      name: str(title, 16), emoji: str(v.emoji, 4) || '📖', place: str(v.place, 8) || '小镇', resident: '居民',
      chronicle: { name: str(ch.name, 16) || `${str(title, 10)}纪事`, kind: str(ch.kind, 8) || '纪事', editor: str(ch.editor, 16) || '记录者', style: str(ch.style, 80) || '简洁、生动' },
      ui: { tagline: str(v.tagline, 40) || '故事正在展开……', welcome: str(v.welcome, 200) || `一个由 AI 自主演绎的世界：${str(title, 16)}`, sampleEvents: (Array.isArray(v.sampleEvents) ? v.sampleEvents : []).map((e) => str(e, 60)).filter(Boolean).slice(0, 6) },
    },
    rhythm: { plan: '05:30', diary: '22:15', chronicle: '22:45' },
    era: { tech: str(adapt?.era?.tech, 24) || '童话时代', forbidden: (Array.isArray(adapt?.era?.forbidden) ? adapt.era.forbidden : []).map((x) => str(x, 16)).filter(Boolean).slice(0, 20) },
    adaptation: {
      fidelity: ['faithful', 'drift', 'free'].includes(options.fidelity) ? options.fidelity : 'drift',
      start: str(adapt?.start, 120), notes: str(adapt?.notes, 600),
      fateNodes: (Array.isArray(adapt?.fateNodes) ? adapt.fateNodes : []).slice(0, 8).map((f, i) => ({ id: `fate_${i + 1}`, text: str(f.text, 90), day: Math.max(1, Math.min(30, Math.round(Number(f.day) || i + 2))) })),
    },
    ...(sourceTitle ? { source: { title: str(sourceTitle, 60), author: str(options.author, 40), license: str(options.license, 80) } } : {}),
  };
}
