// 创世：冒险（docs/design/adventure.md §3.8）。用户以「战斗冒险」为基调创世时，让模型设计队伍、成长风格、野怪的外观，
// 以及 2~4 片要一路征服过去的土地（各有野怪和首领）；代码把它们拼成：从主地图往东一张接一张的相邻地图、远征阶段、
// 野怪与首领、成长路线、回复点。整体校验不过就不带这些内容（不影响创世本身）。
import { BIOME_IDS, OUTDOOR_KINDS, regionSize } from '../worldgen/layout.ts';
import { MONSTER_PLANS } from '../kernel/adventure-spec.ts';
import type { ModelJSON } from '../llm.ts';
import type { Region } from '../types/spec.ts';
import type { PackWorld } from '../types/world.ts';
import type { GenMap } from './assemble.ts';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 模型给的内容，逐项校验后才使用

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown, lo: number, hi: number, d: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d; };
const PLANS = MONSTER_PLANS.filter((p) => !['wisp', 'hound', 'warden'].includes(p));
const WILD_KINDS = ['clearing', 'meadow', 'grove', 'field', 'camp', 'shrine', 'pond', 'gate', 'path'];
const LAND_W = 40;

/** 成长风格 → 路线的数值与升级学会的招式（招式由代码生成，不靠模型写效果） */
const STYLES: Record<string, { name: string; perLevel: { atk: number; def: number; maxHp: number }; skill: Raw }> = {
  attack: { name: '剑士', perLevel: { atk: 1.2, def: 0.5, maxHp: 12 }, skill: { id: 'adv_heavy', name: '重击', emoji: '💥', target: 'agent', desc: '蓄满力气砍下去', aiHint: '对付难缠的敌人', combat: { windup: 3, recover: 3, range: 2.5, shape: 'cone', cd: 18 }, effects: [{ op: 'strike', power: 1.8 }, { op: 'knockback', cells: 1 }] } },
  heal: { name: '治疗师', perLevel: { atk: 0.4, def: 0.4, maxHp: 8 }, skill: { id: 'adv_mend', name: '治愈', emoji: '✨', target: 'agent', desc: '一团柔光落在同伴身上', aiHint: '同伴伤得重的时候', combat: { windup: 2, recover: 2, range: 6, cd: 14 }, effects: [{ op: 'heal', amount: 25, target: 'target' }, { op: 'vfx', preset: 'heal', color: '#fff6a8', radius: 1.2 }] } },
  guard: { name: '守卫', perLevel: { atk: 0.6, def: 1, maxHp: 16 }, skill: { id: 'adv_guard', name: '铁壁', emoji: '🛡️', target: 'self', desc: '架起防御，什么都打不动', aiHint: '顶在最前面的时候', combat: { windup: 1, recover: 2, cd: 28 }, effects: [{ op: 'status', status: 'shield', beats: 18, amount: 35, target: 'self' }] } },
  magic: { name: '法师', perLevel: { atk: 1.1, def: 0.3, maxHp: 7 }, skill: { id: 'adv_bolt', name: '法术弹', emoji: '🔮', target: 'agent', desc: '凝出一颗光弹打出去', aiHint: '敌人在远处', combat: { windup: 2, recover: 3, range: 5, shape: 'line', radius: 0.8, cd: 10 }, effects: [{ op: 'strike', power: 1.4 }] } },
};

export function promptAdventure({ title, summary, personas }: { title: string; summary: string; personas: Array<{ id: string; name: string; role: string }> }): string {
  return `世界：${title}。${str(summary, 300)}
居民：${personas.map((p) => `${p.id}（${p.name}，${p.role}）`).join('、')}
这个世界以战斗冒险为基调：一支队伍从这里出发，一片土地接一片土地地往外推，每片土地有野怪和守着它的首领，打倒首领就能走向下一片土地。请设计：
- party：队伍（队长 + 1~3 名队员，都从上面的居民里选，写 id）
- styles：每个队员的战斗风格 attack 剑士 / heal 治疗师 / guard 守卫 / magic 法师
- lands：2~4 片要征服的土地，按推进的顺序；每片 2~4 个户外地点（kind 只能是 ${WILD_KINDS.join('/')}，其中一个是 camp 营地，用来休整）；地貌 biome 只能是 ${BIOME_IDS.join('/')}
- 每片土地 2 种野怪、1 个首领；外观 bodyPlan 只能是 ${PLANS.join('/')}，配色 palette 用 #rrggbb；越往后越强
输出 JSON：{"party":{"name":"≤12字","leader":"居民id","members":["居民id"]},"styles":{"居民id":"attack/heal/guard/magic"},
"lands":[{"id":"英文小写id","name":"≤10字","biome":"","title":"如 第一章 风之原（≤12字）","intro":"≤60字","places":[{"id":"英文小写id","kind":"","name":"≤10字","emoji":"","desc":"≤40字"}],
"monsters":[{"id":"英文小写id","name":"≤8字","emoji":"","bodyPlan":"","palette":{"body":"#rrggbb","accent":"#rrggbb","eyes":"#rrggbb"},"hp":20~200,"atk":3~22}],
"boss":{"id":"英文小写id","name":"≤10字","emoji":"","bodyPlan":"","palette":{…},"hp":150~1000,"atk":8~28,"rage":"血量过半时的一句话（≤30字）"}}]}`;
}

/** 把模型的冒险设计拼进世界包与地图（在副本上做，调用方再整体校验） */
export function assembleAdventure(raw: ModelJSON, world: PackWorld, map: GenMap): { world: PackWorld; map: GenMap; errors: string[] } {
  const errors: string[] = [];
  const w: PackWorld = structuredClone(world);
  const m: GenMap = structuredClone(map);
  const pIds = new Set(w.personas.map((p: Raw) => p.id));
  const used = new Set<string>([...Object.keys(w.items || {}), ...(w.abilities || []).map((a: Raw) => a.id), ...m.regions.flatMap((r) => (r.areas || []).flatMap((a) => [a.id, ...a.places.map((p) => p.id)])), ...m.regions.map((r) => r.id)]);
  const uid = (v: unknown, d: string) => { let id = ID_RE.test(String(v)) ? String(v) : d; while (used.has(id)) id = `${id.slice(0, 20)}_${used.size % 100}`; used.add(id); return id; };
  // ---- 队伍与成长 ----
  const p = raw?.party || {};
  const leader = pIds.has(p.leader) ? p.leader : w.personas[0]?.id;
  const members: string[] = [leader, ...(Array.isArray(p.members) ? p.members : [])].filter((id, i, a) => pIds.has(id) && a.indexOf(id) === i).slice(0, 4);
  if (!leader) return { world, map, errors: ['没有可以当队长的居民'] };
  const styles = new Set<string>();
  w.abilities ||= [];
  for (const id of members) {
    const style = STYLES[raw?.styles?.[id]] ? raw.styles[id] : id === leader ? 'attack' : ['guard', 'heal', 'magic'][members.indexOf(id) % 3]!;
    styles.add(style);
    const per = w.personas.find((x: Raw) => x.id === id);
    per.growth = { track: style };
    per.party = 'party';
    per.combat = { atk: style === 'attack' || style === 'magic' ? 3 : 1, def: style === 'guard' ? 3 : 1 };
    if (id === leader) per.plotArmor = true;
  }
  w.growth = { who: 'personas', maxLevel: 30, curve: { base: 12, mult: 1.22 }, share: 'participants', tracks: {} };
  for (const s of styles) {
    const st = STYLES[s]!;
    if (!w.abilities.some((a: Raw) => a.id === st.skill.id)) w.abilities.push(structuredClone(st.skill));
    w.growth.tracks[s] = { name: st.name, perLevel: st.perLevel, learn: [{ level: 3, ability: st.skill.id }] };
  }
  w.growth.avatar = { track: [...styles][0] };
  w.parties = { party: { leader, name: str(p.name, 12) || '远征队' } };
  w.recovery = { kinds: ['camp', 'inn', 'temple', 'clinic', 'shrine'], rate: 1.6, retreatAt: 0.35, resumeAt: 0.85, downed: 'carry' };
  // ---- 土地：从主地图往东一张接一张 ----
  const town = m.regions[0]!;
  const H = regionSize(town as unknown as Region)[1]!;
  let prev = town;
  w.threats ||= {};
  const stages: Raw[] = [];
  const lands = (Array.isArray(raw?.lands) ? raw.lands : []).slice(0, 4);
  if (lands.length < 2) errors.push('至少需要两片土地');
  lands.forEach((land: Raw, i: number) => {
    const rid = uid(land.id, `land_${i + 1}`);
    const places = (Array.isArray(land.places) ? land.places : []).slice(0, 4).map((pl: Raw, j: number) => ({
      id: uid(pl.id, `${rid}_p${j + 1}`), kind: WILD_KINDS.includes(pl.kind) && Object.hasOwn(OUTDOOR_KINDS, pl.kind) ? pl.kind : 'clearing',
      name: str(pl.name, 10) || `野外${j + 1}`, emoji: str(pl.emoji, 4) || '📍', desc: str(pl.desc, 40) || str(pl.name, 10), public: true,
    }));
    if (!places.some((x: Raw) => x.kind === 'camp')) places.push({ id: uid(`${rid}_camp`, `${rid}_camp`), kind: 'camp', name: '营地', emoji: '🏕️', desc: '可以生火、包扎的营地', public: true });
    if (places.filter((x: Raw) => x.kind !== 'camp').length < 1) places.unshift({ id: uid(`${rid}_wild`, `${rid}_wild`), kind: 'clearing', name: '荒野', emoji: '🌾', desc: '野怪出没的地方', public: true });
    const at = Math.round(H / 2);
    const key = `${rid}_0`;
    (((prev as Raw).entries ||= []) as Raw[]).push({ side: 'east', at, to: rid, key });
    const region = { id: rid, generator: 'layout-v1', name: str(land.name, 10) || `第${i + 1}片土地`, seed: 5000 + i, size: [LAND_W, H], biome: BIOME_IDS.includes(land.biome) ? land.biome : 'meadow', open: false,
      adjacent: { to: prev.id, side: 'east' }, entries: [{ side: 'west', at, to: prev.id, key }], firstVisit: str(land.intro, 60) || undefined,
      areas: [{ id: uid(`${rid}_area`, `${rid}_area`), name: str(land.name, 10) || '野外', biome: BIOME_IDS.includes(land.biome) ? land.biome : 'meadow', size: 'large', places }] };
    m.regions.push(region);
    prev = region as typeof prev;
    const wild = places.filter((x: Raw) => x.kind !== 'camp').map((x: Raw) => x.id);
    const look = (r: Raw, scale = 1) => ({ bodyPlan: PLANS.includes(r?.bodyPlan) ? r.bodyPlan : PLANS[i % PLANS.length], ...(scale !== 1 ? { scale } : {}),
      palette: Object.fromEntries(Object.entries(r?.palette || {}).filter(([k, v]) => ['body', 'accent', 'eyes', 'glow'].includes(k) && HEX.test(String(v)))) });
    const mons = (Array.isArray(land.monsters) ? land.monsters : []).slice(0, 2).map((mo: Raw, j: number) => {
      const id = uid(mo.id, `${rid}_m${j + 1}`);
      const hp = num(mo.hp, 20, 200, 30 + i * 40), atk = num(mo.atk, 3, 22, 5 + i * 4);
      w.threats[id] = { name: str(mo.name, 8) || '野怪', emoji: str(mo.emoji, 4) || '👾', kind: '野怪', mortal: true, hp, atk, def: Math.round(atk / 4), speed: 1.4, haunt: wild.slice(0, 4), movement: 'wander', aggro: 3, incident: false, exp: Math.max(4, Math.round(hp / 4)), clues: [], look: look(mo) };
      return id;
    });
    const b = land.boss || {};
    const bid = uid(b.id, `${rid}_boss`);
    const bhp = num(b.hp, 150, 1000, 250 + i * 220), batk = num(b.atk, 8, 28, 9 + i * 5);
    w.threats[bid] = { name: str(b.name, 10) || '首领', emoji: str(b.emoji, 4) || '👑', kind: '首领', mortal: true, hp: bhp, atk: batk, def: Math.round(batk / 4), speed: 0.8, haunt: [wild[wild.length - 1]], movement: 'stationary', aggro: 6,
      incident: false, boss: true, exp: Math.round(bhp / 3), clues: [], look: look(b, 2.4), foreshadow: { lead: 60, text: `${str(land.name, 10) || '前方'}深处传来低沉的动静……` },
      phases: [{ at: 0.5, text: str(b.rage, 30) || `${str(b.name, 10) || '首领'}被激怒了！`, atk: 1.3 }] };
    stages.push({ id: `s${i + 1}`, region: rid, title: str(land.title, 12) || `第${i + 1}章`, ...(str(land.intro, 60) ? { intro: str(land.intro, 60) } : {}), wild, levelHint: 3 + i * 4,
      spawns: mons.map((id: string, j: number) => ({ threat: id, every: 45 + j * 25, max: 3 - j })), boss: { threat: bid, after: `kills('${rid}') >= ${6 + i * 2}` }, ...(i < lands.length - 1 ? { unlock: [`s${i + 2}`] } : {}) });
  });
  w.expedition = { id: 'main', party: 'party', stages };
  w.spotlight = [leader];
  return { world: w, map: m, errors };
}
