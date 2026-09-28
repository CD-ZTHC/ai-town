// 拆除的连带影响（地图演变设计 §3.3）：列出世界规格里所有引用某座建筑（及其地点 id）的地方。
// removeBuilding / setBuildingState(ruin) 用它检查搬迁去处（remap）是否齐全；撤销扩展时也会用到。
// 这里只看规格；运行中的剧情弧、线程、约定由调用方（小镇）另外检查。

/** 返回 { residents, workers, events, rules, spawn, gates } */
export function impactOf(spec, id) {
  const personas = spec.personas || [];
  return {
    residents: personas.filter((p) => p.kind !== 'creature' && p.home === id).map((p) => p.id),
    workers: personas.filter((p) => p.kind !== 'creature' && p.work === id && p.home !== id).map((p) => p.id),
    // 住在这里又在这里工作的人：搬走之后工作地也跟着换
    liveWork: personas.filter((p) => p.kind !== 'creature' && p.work === id && p.home === id).map((p) => p.id),
    events: (spec.calendar?.events || []).filter((e) => e.location === id).map((e) => e.id),
    rules: (spec.rules || []).filter((r) => r.when?.enter === id).map((r) => r.id),
    spawn: spec.voice?.spawn === id,
    gates: (spec.regions || []).filter((r) => r.gate === id).map((r) => r.id),
  };
}

const HOME_CAP = 3;
const liveBuilding = (spec, id) => (spec.buildings || []).find((b) => b.id === id && !b.removed);

/**
 * 检查 remap 能不能覆盖所有引用。返回错误文本或 null。
 * remap: { residents: 建筑id, workers: 地点id, location: 地点id }
 */
export function checkRemap(spec, id, remap = {}, { name = id } = {}) {
  const im = impactOf(spec, id);
  const names = (ids) => ids.map((x) => spec.personas.find((p) => p.id === x)?.name || x).join('、');
  const isLoc = (x) => x && x !== id && (Object.hasOwn(spec.locations || {}, x) || liveBuilding(spec, x));
  if (im.residents.length) {
    const to = remap.residents;
    const b = to && to !== id && liveBuilding(spec, to);
    if (!b) return `「${name}」还住着 ${im.residents.length} 个人（${names(im.residents)}），需要在 remap.residents 里给出搬去哪座建筑`;
    if (b.state === 'ruin') return `不能搬进废墟：${to}`;
    const n = spec.personas.filter((p) => p.status !== 'departed' && p.kind !== 'creature' && p.home === to).length;
    const moving = spec.personas.filter((p) => p.status !== 'departed' && im.residents.includes(p.id)).length;
    if (n + moving > HOME_CAP) return `「${b.name}」住不下（已经住着 ${n} 人，每处最多 ${HOME_CAP} 人）`;
  }
  if (im.workers.length && !isLoc(remap.workers)) return `有 ${im.workers.length} 个人（${names(im.workers)}）在「${name}」工作，需要在 remap.workers 里给出新的工作地点`;
  const needLoc = [...im.events.map((e) => `节日 ${e}`), ...im.rules.map((r) => `规则 ${r}`), ...(im.spawn ? ['出生点'] : []), ...im.gates.map((g) => `区域 ${g} 的渡口`)];
  if (needLoc.length && !isLoc(remap.location)) return `「${name}」被这些地方引用：${needLoc.join('、')}，需要在 remap.location 里给出替代的地点`;
  return null;
}

/** 在规格副本上把所有引用改指向（与删除建筑在同一个操作里，撤销时一起恢复） */
export function applyRemap(spec, id, remap = {}) {
  const im = impactOf(spec, id);
  for (const p of spec.personas) {
    if (im.residents.includes(p.id) || im.liveWork.includes(p.id)) p.home = remap.residents;
    if (im.liveWork.includes(p.id)) p.work = remap.workers && remap.workers !== id ? remap.workers : remap.residents;
    if (im.workers.includes(p.id)) p.work = remap.workers;
  }
  for (const e of spec.calendar?.events || []) if (e.location === id) e.location = remap.location;
  for (const r of spec.rules || []) if (r.when?.enter === id) r.when.enter = remap.location;
  if (spec.voice?.spawn === id) spec.voice.spawn = remap.location;
  for (const r of spec.regions || []) if (r.gate === id) r.gate = remap.location;
}
