// 创世：威胁生成（黑暗叙事设计 §4.12）。让模型设计这个世界里按规律行事的威胁，把规律编译成内核的表达式，
// 逐个校验；不合法的带着错误让模型改一次，还不合法的丢掉。改编模式与参考模式都可以用。
import { validateThreat, validateBurden, POSTURES } from '../kernel/threat-spec.ts';
import { EXPR_FN_DOCS, EFFECTS } from '../kernel/effects.ts';
import { validateAbility } from '../kernel/abilities.ts';
import { packSpec } from '../worlds/pack.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
const MAX_THREATS = 6;
// 规律里常用的函数（其余的也能用，这里只挑与规律有关的写进提示词）
const RULE_FNS = ['seen', 'near', 'heard', 'opened', 'entered', 'speaking', 'named', 'alone', 'asleep', 'night', 'marked', 'inZone', 'posture', 'has', 'nearStructure', 'nearAgents', 'believes', 'flag', 'anchors', 'burden'];
const OUTCOME_OPS = ['kill', 'wound', 'memory', 'condition', 'burden', 'casualties'];

export function promptThreats({ title, summary, places, personas, rating, inspiration = '' }) {
  const lethal = ['dark', 'tragic'].includes(rating);
  return `世界：${str(title, 16)}。背景：${str(summary, 400)}
${inspiration ? `题材参考：${str(inspiration, 200)}（只借用题材的感觉，不要使用参考作品里的任何人名、地名、专有名词和具体的怪物）\n` : ''}地点 id：${places.join(', ')}
居民：${personas.map((p) => `${p.id}（${p.name}，${p.role}）`).join('、')}
内容分级：${rating}${lethal ? '（允许死亡作为叙事事件，一笔带过）' : '（没有人会死：结果只能是受伤、受惊、失去东西）'}

为这个世界设计 3~${MAX_THREATS} 个「按规律行事的威胁」。每个威胁有自己的规律：触犯了规律的人会被它盯上，过一段时间规律应验。
规律（trigger / unless）要写成表达式，只能用这些函数（e 是被判定的人）：
${RULE_FNS.map((k) => `- ${EXPR_FN_DOCS[k]}`).join('\n')}
表达式语法：&& || ! 比较 数字 '字符串'，例如 "night() && entered(e, '地点id') && named(e)"。
禁忌姿态（posture 的名字）只有：${POSTURES.join('/')}。
结果（outcome）是效果列表，只能用 ${OUTCOME_OPS.join('/')}：
${OUTCOME_OPS.map((k) => `- ${EFFECTS[k].doc}`).join('\n')}
${lethal ? '' : '（这个分级下不要用 kill。）\n'}对抗方式 counters（至少一种）：{"type":"contain","with":"容器物品id","yields":"收容后变成的物品id","time":20,"leak":0.02}、{"type":"suppress","power":1~5}、{"type":"ward","with":"构筑物id","radius":3}、{"type":"delay"}、{"type":"exploit","hint":"≤40字"}、{"type":"resolve","when":"flag('某个标记')","text":"≤30字"}；会死的威胁（mortal:true，要写 hp）还可以有 {"type":"slay"}。
容器物品、护身的构筑物要写进 items / structures；resolve 用到的标记要有办法设置（写一个能力，效果是 {"op":"flag","name":"标记","value":true}）。
每个威胁要有真线索 clues（死者死前做过、真正触发规律的事）和误导的 decoys（看起来像、其实无关的巧合），各 1~3 条。
可以有一个负担值 burden（借用威胁的力量要付出的代价），以及 1~2 位居民是某个威胁的宿主（hosts）：宿主获得 grants 里的能力，也背上负担值。

输出 JSON：
{"threats":{"英文小写id":{"name":"≤8字","emoji":"一个emoji","kind":"≤6字","mortal":false,"speed":1.2,"origin":"它生前的来历（≤60字）",
  "haunt":["地点id"],"movement":"wander/stalk_marked/stationary/patrol","active":["20:00","05:00"],
  "sounds":[{"id":"英文","every":45,"radius":5,"text":"≤20字"}],
  "rule":{"trigger":"表达式","unless":"表达式(可选)","mark":{"delay":[20,120],"sign":"被盯上的人察觉到的迹象（≤20字）"},"outcome":[效果],"reach":8,"rest":120},
  "counters":[…],"zone":{"radius":4,"grow":0.5,"replay":"重演的场景（≤30字）"}(可选),
  "hostable":{"grants":["能力id"],"burden":"负担id","rate":1}(可选),
  "clues":["…"],"decoys":["…"],"research":["能查到线索的地点id"],"crowd":{"every":720,"kills":[0,1]}(可选)}},
"items":{"物品id":{"name":"≤6字","emoji":"","desc":"≤30字","use":[效果](可选)}},
"structures":{"构筑物id":{"name":"≤6字","emoji":"","tags":["light"],"light":{"r":70,"color":"255,200,120"}}},
"burden":{"id":"英文","name":"≤4字","drift":1,"moodAt":[[60,"两字"]],"onFull":[{"op":"kill","target":"self"},{"op":"spawnThreat","from":"host","target":"self"}]} 或 null,
"abilities":[{"id":"英文","name":"≤6字","emoji":"","target":"self/agent/area","desc":"≤40字","aiHint":"≤30字","cost":{"stamina":10,"burden":{"id":"负担id","amount":8}},"cooldown":60,"effects":[效果]}],
"hosts":[{"who":"居民id","threat":"威胁id","burden":40}],
"start":["开局就出现的威胁id，1~2个"]}`;
}

/** 把模型的输出整理成世界包字段并逐个校验。返回 { add, errors }；add 可以直接合进 world */
export function assembleThreats(raw, world, map) {
  const items = {}, structures = {}, burdens = {}, threats = {};
  const errors = [];
  for (const [id, it] of Object.entries(raw?.items || {}).slice(0, 8)) {
    if (!ID_RE.test(id) || Object.hasOwn(world.items || {}, id)) continue;
    items[id] = { name: str(it.name, 8) || id, emoji: str(it.emoji, 4) || '📦', desc: str(it.desc, 40), ...(Array.isArray(it.use) ? { use: it.use.slice(0, 4) } : {}) };
  }
  for (const [id, s] of Object.entries(raw?.structures || {}).slice(0, 4)) {
    if (!ID_RE.test(id)) continue;
    const light = s.light && Number(s.light.r) >= 20 && Number(s.light.r) <= 160 && /^\d{1,3},\d{1,3},\d{1,3}$/.test(s.light.color) ? { r: Number(s.light.r), color: s.light.color } : null;
    structures[id] = { name: str(s.name, 8) || id, emoji: str(s.emoji, 4) || '🏮', tags: [...new Set([...(Array.isArray(s.tags) ? s.tags.map((t) => str(t, 12)) : []), id])].slice(0, 4), ...(light ? { light } : {}) };
  }
  const b = raw?.burden;
  if (b && ID_RE.test(b.id || '')) burdens[b.id] = { name: str(b.name, 8) || '负担', max: 100, drift: Number(b.drift) || 1, moodAt: Array.isArray(b.moodAt) ? b.moodAt.slice(0, 3) : [], onFull: Array.isArray(b.onFull) ? b.onFull.slice(0, 4) : [] };
  const draft = { ...world, items: { ...world.items, ...items }, structures: { ...(world.structures || {}), ...structures }, burdens: { ...(world.burdens || {}), ...burdens } };
  const abilities = [];
  for (const ab of (Array.isArray(raw?.abilities) ? raw.abilities : []).slice(0, 6)) {
    if (!ab || (world.abilities || []).some((x) => x.id === ab.id)) continue;
    const e = validateAbility(ab, draft);
    if (e) errors.push(`能力 ${ab?.id}：${e}`); else abilities.push(ab);
  }
  draft.abilities = [...(world.abilities || []), ...abilities];
  for (const [id, bu] of Object.entries(burdens)) { const e = validateBurden(id, bu, draft); if (e) { errors.push(`负担值 ${id}：${e}`); delete burdens[id]; } }
  draft.burdens = { ...(world.burdens || {}), ...burdens };
  // 威胁的校验要用到地点：按地图求出规格里的地点
  const spec = packSpec({ world: { ...draft, threats: {} }, map, arcs: [] });
  spec.threats = {};
  for (const [id, t] of Object.entries(raw?.threats || {}).slice(0, MAX_THREATS)) spec.threats[id] = t;
  for (const [id, t] of Object.entries(spec.threats)) {
    const e = validateThreat(id, t, spec);
    if (e) errors.push(`威胁 ${id}：${e}`); else threats[id] = t;
  }
  const hosts = [];
  for (const h of Array.isArray(raw?.hosts) ? raw.hosts.slice(0, 2) : []) {
    const p = world.personas.find((x) => x.id === h.who || x.name === h.who);
    const t = threats[h.threat];
    if (p && t?.hostable && burdens[t.hostable.burden]) hosts.push({ id: p.id, threat: h.threat, burden: t.hostable.burden, value: Math.max(0, Math.min(90, Number(h.burden) || 30)) });
  }
  const start = (Array.isArray(raw?.start) ? raw.start : []).filter((id) => threats[id]).slice(0, 2);
  return { add: { items, structures, burdens, abilities, threats, hosts, start: start.length ? start : Object.keys(threats).slice(0, 1) }, errors };
}

/** 把整理好的威胁合进世界包 */
export function mergeThreats(world, add) {
  world.items = { ...world.items, ...add.items };
  world.structures = { ...(world.structures || {}), ...add.structures };
  world.burdens = { ...(world.burdens || {}), ...add.burdens };
  world.abilities = [...(world.abilities || []), ...add.abilities];
  world.threats = { ...(world.threats || {}), ...add.threats };
  for (const h of add.hosts) {
    const p = world.personas.find((x) => x.id === h.id);
    p.start = { ...(p.start || {}), hosted: [h.threat], burdens: { [h.burden]: h.value } };
  }
  if (Object.keys(world.threats).length) world.incidents = { start: add.start.map((threat) => ({ threat })), autoEveryDays: 2 };
  return world;
}
