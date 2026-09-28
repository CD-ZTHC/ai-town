// 剧情节拍：叙事导演与剧情弧共用的「剧情动作」。每个动作先校验、再执行，非法动作会被丢弃。
// 普通动作导演可以直接使用；标记为 privileged 的动作（开裂隙、刷怪、角色登场/离场、投票……）只允许剧情弧模板使用。
import { addMemory } from '../memory.ts';
import { checkEffects, runEffects, posOf, VFX } from '../kernel/effects.ts';
import { advanceThread } from './threads.ts';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
// 导演直接使用 effect 动作时允许的效果（不含授予能力、临时参数等影响更大的原语）
const DIRECTOR_EFFECTS = new Set(['stat', 'condition', 'mood', 'memory', 'vfx', 'say', 'flag', 'belief']);

/** 把姓名或 id 解析成在场的角色 */
export function resolveWho(town, who, { all = false } = {}) {
  if (all && who === 'all') return town.agents.filter((a) => a.kind !== 'creature');
  const list = Array.isArray(who) ? who : [who];
  const out = [];
  for (const w of list) {
    const s = str(w, 16);
    const a = town.agents.find((x) => x.id === s || x.name === s) || town.agents.find((x) => s && s.includes(x.name));
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

const KINDS = {
  omen: {
    check(b, town) {
      if (!str(b.text, 60)) return 'text 不能为空';
      if (!resolveWho(town, b.who).length) return 'who 里没有在场的居民';
      if (b.at && !Object.hasOwn(town.spec.locations, b.at)) return `未知地点：${b.at}`;
      if (b.vfx && !VFX.includes(b.vfx)) return `未知特效：${b.vfx}`;
      return null;
    },
    run(town, b) {
      const who = resolveWho(town, b.who);
      for (const a of who) addMemory(a, { t: town.t, type: 'omen', text: str(b.text, 60), importance: 6 });
      if (b.at && b.vfx) {
        const p = town.locCenter(b.at);
        if (p) town.emit('vfx', { preset: b.vfx, x: p.x, y: p.y, color: b.color || '#9b6bff', radius: 3 });
      }
      town.log('omen', `🔮 ${who.map((a) => a.name).join('、')}察觉到：${str(b.text, 60)}`, { agents: who.map((a) => a.id) });
    },
  },
  spreadNews: {
    check(b, town) {
      if (!str(b.text, 80)) return 'text 不能为空';
      if (b.at !== 'all' && !Object.hasOwn(town.spec.locations, b.at || '')) return 'at 应为 all 或地点 id';
      if (b.about && !str(b.claim, 40)) return '有 about 时需要 claim';
      if (b.confidence != null && !inRange(b.confidence, 0, 1)) return 'confidence 应在 0~1';
      return null;
    },
    run(town, b) {
      const who = b.at === 'all' ? town.agents.filter((a) => a.kind !== 'creature') : town.agents.filter((a) => a.kind !== 'creature' && a.locId === b.at);
      for (const a of who) {
        addMemory(a, { t: town.t, type: 'event', text: `听说：${str(b.text, 80)}`, importance: 6 });
        if (b.about) town.setBelief(a, { about: str(b.about, 12), claim: str(b.claim, 40), confidence: b.confidence ?? 0.6, source: 'news' });
      }
      town.log('news_spread', `🗞️ ${str(b.text, 80)}`, { agents: who.slice(0, 4).map((a) => a.id) });
    },
  },
  belief: {
    check(b, town) {
      if (!str(b.about, 12) || !str(b.claim, 40)) return 'about / claim 不能为空';
      if (!resolveWho(town, b.who).length) return 'who 里没有在场的居民';
      return null;
    },
    run(town, b) {
      for (const a of resolveWho(town, b.who)) town.setBelief(a, { about: str(b.about, 12), claim: str(b.claim, 40), confidence: b.confidence ?? 0.7, source: 'self' });
    },
  },
  scene: {
    check(b, town) {
      if (!Object.hasOwn(town.spec.locations, b.location || '')) return `未知地点：${b.location}`;
      const n = resolveWho(town, b.participants).length;
      if (n < 2 || n > 6) return '参与者应为 2~6 位在场的角色';
      if (!str(b.purpose, 160)) return 'purpose 不能为空';
      return null;
    },
    run(town, b, ctx) { town.scenes.schedule({ ...b, arc: ctx.arc?.id || null, beatId: ctx.beatId || null }); },
  },
  thread: {
    check(b, town) {
      if (!town.spec.threads.some((t) => t.id === b.id)) return `未知剧情线程：${b.id}`;
      if (!['advanced', 'resolved'].includes(b.status)) return 'status 只能是 advanced / resolved';
      return null;
    },
    run(town, b) { advanceThread(town, b.id, b.status, str(b.note, 40)); },
  },
  giveItem: {
    check(b, town) {
      if (!Object.hasOwn(town.spec.items, b.item || '')) return `未知物品：${b.item}`;
      if (!resolveWho(town, b.who).length) return 'who 不在场';
      return null;
    },
    run(town, b) {
      for (const a of resolveWho(town, b.who)) a.inventory[b.item] = Math.min(99, (a.inventory[b.item] || 0) + (b.count || 1));
    },
  },
  effect: {
    check(b, town, privileged) {
      if (b.who !== 'all' && !resolveWho(town, b.who).length) return 'who 不在场';
      const e = checkEffects(b.effects, town.spec);
      if (e) return e;
      if (!privileged && b.effects.some((x) => !DIRECTOR_EFFECTS.has(x.op))) return `导演只能使用这些效果：${[...DIRECTOR_EFFECTS].join('/')}`;
      return null;
    },
    run(town, b, ctx) {
      for (const a of resolveWho(town, b.who, { all: true })) runEffects(town, { self: a, at: posOf(town, a), source: ctx.source }, b.effects);
    },
  },
  weather: {
    check(b, town) { return Object.hasOwn(town.spec.weather, b.id || '') ? null : `未知天气：${b.id}`; },
    run(town, b) { town.setWeatherFor(b.id, 180); },
  },
  canon: {
    check(b) { return str(b.text, 200) ? null : 'text 不能为空'; },
    run(town, b, ctx) { town.applyWorldOp({ op: 'addCanon', args: { text: b.text, tags: b.tags } }, { by: ctx.source }); },
  },
  // 原著的命运节点（创世生成的世界，多世界设计 §4.2）：到达了、以变形的方式出现了、或者这次跳过
  fate: {
    check(b, town) {
      if (!(town.spec.adaptation?.fateNodes || []).some((f) => f.id === b.id)) return `未知命运节点：${b.id}`;
      return ['reached', 'transformed', 'skipped'].includes(b.status) ? null : 'status 只能是 reached / transformed / skipped';
    },
    run(town, b) {
      town.worldFlags[`fate_${b.id}`] = b.status;
      const f = town.spec.adaptation.fateNodes.find((x) => x.id === b.id);
      town.log('thread', `📖 原著的命运节点「${f.text}」${b.status === 'reached' ? '如约发生了' : b.status === 'transformed' ? '以另一种方式发生了' : '这一次没有发生'}`, {});
    },
  },
  flag: {
    check(b) { return /^[a-z][a-z0-9_]{1,23}$/.test(b.name || '') ? null : 'name 不合法'; },
    run(town, b) { town.worldFlags[b.name] = b.value ?? true; },
  },
  growth: {
    check(b, town) {
      if (!str(b.change, 24)) return 'change 不能为空';
      return resolveWho(town, b.who).length ? null : 'who 不在场';
    },
    run(town, b) {
      for (const a of resolveWho(town, b.who)) {
        a.growth.push({ day: town.day, change: str(b.change, 24) });
        if (a.growth.length > 12) a.growth.shift();
        town.log('growth', `🌱 ${a.name}：${str(b.change, 24)}`, { agents: [a.id] });
      }
    },
  },
  propose: {
    check(b) { return String(b.intent || '').trim().length >= 4 ? null : 'intent 太短'; },
    run(town, b) {
      const err = town.architect ? town.architect.enqueue(b.intent, 'director') : '世界架构师插件未启用';
      if (err) console.warn('[beat] propose：', err);
    },
  },
  launchArc: {
    check(b, town) {
      if (!town.spec.arcs.some((x) => x.id === b.template)) return `未知剧情弧：${b.template}`;
      return town.arcs.canStart(b.template);
    },
    run(town, b) { town.arcs.start(b.template, 'director'); },
  },

  // ---------- 黑暗叙事（设计 §4.11）：只有世界包声明了 threats 时可用。导演只能安排局面，没有「杀死某人」这个动作 ----------
  incident: {
    check(b, town) {
      if (!town.threats?.enabled) return '这个世界没有威胁';
      if (!Object.hasOwn(town.spec.threats, b.threat || '')) return `未知威胁：${b.threat}`;
      if (b.at != null && !Object.hasOwn(town.spec.locations, b.at)) return `未知地点：${b.at}`;
      if (town.threats.live().filter((x) => x.type === b.threat).length >= 2) return '同一种威胁已经够多了';
      return null;
    },
    run(town, b, ctx) { town.threats.spawn(b.threat, { loc: b.at || null, cause: ctx.source || 'director' }); },
  },
  omenAt: {
    check(b, town) {
      if (!town.threats?.enabled) return '这个世界没有威胁';
      if (!Object.hasOwn(town.spec.locations, b.at || '')) return `未知地点：${b.at}`;
      return str(b.text, 60) ? null : 'text 不能为空';
    },
    run(town, b) {
      const here = town.agents.filter((a) => a.kind !== 'creature' && a.locId === b.at);
      for (const a of here) addMemory(a, { t: town.t, type: 'omen', text: str(b.text, 60), importance: 6 });
      const p = town.locCenter(b.at);
      if (p) town.emit('vfx', { preset: 'ripple', x: p.x, y: p.y, color: '#5a2340', radius: 3 });
      town.log('omen', `🕯️ ${town.locName(b.at)}：${str(b.text, 60)}`, { agents: here.map((a) => a.id) });
    },
  },
  clue: {
    check(b, town) {
      if (!town.threats?.enabled) return '这个世界没有威胁';
      if (!['rule', 'next_victim', 'origin'].includes(b.clueKind || 'rule')) return 'clueKind 只能是 rule / next_victim / origin';
      if (b.threat != null && !Object.hasOwn(town.spec.threats, b.threat)) return `未知威胁：${b.threat}`;
      return resolveWho(town, b.who).length ? null : 'who 不在场';
    },
    // 线索的内容由引擎从真假线索里抽取，导演只能决定给谁
    run(town, b) { for (const a of resolveWho(town, b.who)) town.threats.giveClue(a, b.clueKind || 'rule', b.threat || null, { confidence: 0.6 }); },
  },
  dispatch: {
    check(b, town) {
      if (!town.threats?.enabled) return '这个世界没有威胁';
      if (!town.dark.incidents.some((i) => (i.id === b.incident || i.loc === b.incident) && ['omen', 'outbreak', 'spread'].includes(i.stage))) return `没有进行中的事件：${b.incident}`;
      return resolveWho(town, b.who).length ? null : 'who 不在场';
    },
    run(town, b) { for (const a of resolveWho(town, b.who)) town.dispatch(a, b.incident); },
  },
  surge: {
    check(b, town) {
      if (!Object.hasOwn(town.spec.burdens || {}, b.burden || '')) return `未知负担值：${b.burden}`;
      if (!inRange(b.amount, -30, 30)) return 'amount 应在 -30~30';
      return resolveWho(town, b.who).some((a) => a.burdens?.[b.burden] != null) ? null : 'who 没有这种负担值';
    },
    run(town, b) { for (const a of resolveWho(town, b.who)) if (a.burdens?.[b.burden] != null) town.addBurden(a, b.burden, b.amount); },
  },
  leak: {
    check(b, town) { return town.dark?.contained?.length ? null : '没有收容着的威胁'; },
    run(town) {
      const c = town.dark.contained[0];
      town.dark.contained = town.dark.contained.slice(1);
      const holder = town.byId[c.holder];
      const inst = town.threats.spawn(c.type, { at: holder && town.agents.includes(holder) ? posOf(town, holder) : null, cause: 'leak', quiet: true });
      if (inst) town.log('threat', `💥 收容${inst.name}的容器开裂了`, { threat: inst.id });
    },
  },
  abandon: {
    check(b, town) { return town.threats?.enabled && town.dark.incidents.some((i) => (i.id === b.incident || i.loc === b.incident) && ['omen', 'outbreak', 'spread'].includes(i.stage)) ? null : `没有可以放弃的事件：${b.incident}`; },
    run(town, b) { town.threats.abandon(b.incident); },
  },
  ambush: {
    check(b, town) {
      if (!town.canBeHostile()) return '这个世界里没有人会动手';
      const [a] = resolveWho(town, b.who), [t] = resolveWho(town, b.target);
      if (!a || !t || a === t) return 'who / target 不在场';
      if (!Object.hasOwn(town.spec.locations, b.at || '')) return `未知地点：${b.at}`;
      return town.mayHarm(a, t, 'subdue');
    },
    // 只安排「在某处埋伏」这个局面：到了时间、对方真的出现，才会动手，结果由战斗结算决定
    run(town, b) {
      const [a] = resolveWho(town, b.who), [t] = resolveWho(town, b.target);
      const start = Math.min(Math.floor(town.minute) + 30, 22 * 60);
      const hh = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
      town.addCommitment(a, { time: hh, duration: 90, location: b.at, activity: `埋伏${t.name}`, emoji: '🗡️', act: { type: 'attack', target: t.name, intent: 'subdue' } }, '（心里打着主意）');
    },
  },

  // ---------- 以下仅限剧情弧模板 ----------
  portal: {
    privileged: true,
    check(b) { return ['crack', 'open', 'wide', 'stable', 'sealed'].includes(b.stage) ? null : 'stage 不合法'; },
    run(town, b) { town.creatures.setPortal(b); },
  },
  spawnCreatures: {
    privileged: true,
    check(b, town) {
      if (!Object.hasOwn(town.spec.creatures, b.type || '')) return `未知生物：${b.type}`;
      return inRange(b.count, 1, 8) ? null : 'count 应在 1~8';
    },
    run(town, b) { town.creatures.spawn(b.type, b.count, b.goal); },
  },
  region: {
    privileged: true,
    check(b, town) { return b.id !== 'town' && Object.hasOwn(town.regions || {}, b.id || '') ? null : `未知区域：${b.id}`; },
    run(town, b) { town.openRegion(b.id, b.open !== false); },
  },
  dismissCreatures: {
    privileged: true,
    check() { return null; },
    run(town, b) { town.creatures.dismiss(b.keep); },
  },
  traveller: {
    privileged: true,
    check(b, town, _p, ctx) {
      if (!ctx?.arc?.template?.cast?.[b.id]) return `剧情弧里没有这个角色：${b.id}`;
      return Object.hasOwn(town.spec.locations, b.at || '') ? null : `未知地点：${b.at}`;
    },
    run(town, b, ctx) { town.enterStage(ctx.arc.template.cast[b.id], b.at, ctx.source); },
  },
  depart: {
    privileged: true,
    check(b, town) { return town.spec.personas.some((p) => p.id === b.id) ? null : `未知角色：${b.id}`; },
    run(town, b, ctx) { town.depart(b.id, ctx.source); },
  },
  structure: {
    privileged: true,
    check(b, town) {
      if (!Object.hasOwn(town.spec.structures, b.type || '')) return `未知构筑物：${b.type}`;
      return Object.hasOwn(town.spec.locations, b.at || '') ? null : `未知地点：${b.at}`;
    },
    run(town, b) {
      const p = town.locCenter(b.at);
      if (p) town.spawnStructure(b.type, p, b.ttl ?? 1e7);
    },
  },
  calendar: {
    privileged: true,
    check(b) { return str(b.name, 16) && inRange(b.inDays, 1, 30) ? null : 'name / inDays 不合法'; },
    run(town, b, ctx) {
      const { inDays, kind: _k, ...rest } = b;
      town.applyWorldOp({ op: 'addCalendarEvent', args: { countdown: true, ...rest, day: town.day + inDays } }, { by: ctx.source });
    },
  },
  vote: {
    privileged: true,
    check(b) {
      if (!str(b.question, 40)) return 'question 不能为空';
      return Array.isArray(b.options) && b.options.length >= 2 && b.options.length <= 4 ? null : 'options 应为 2~4 项';
    },
    run(town, b, ctx) { town.votes.open({ question: b.question, options: b.options, minutes: b.minutes || 90, arc: ctx.arc?.id || null }); },
  },
  newspaper: {
    privileged: true,
    check() { return null; },
    run(town) { town.makeNewspaper().catch(() => {}); },
  },
};

export const DIRECTOR_KINDS = Object.keys(KINDS).filter((k) => !KINDS[k].privileged);
export const ALL_KINDS = Object.keys(KINDS);

export function checkBeat(town, b, { privileged = false, ctx = {} } = {}) {
  if (!b || typeof b !== 'object' || !Object.hasOwn(KINDS, b.kind || '')) return `未知动作：${b?.kind}`;
  const def = KINDS[b.kind];
  if (def.privileged && !privileged) return `只有剧情弧可以使用：${b.kind}`;
  return def.check(b, town, privileged, ctx);
}

/** 执行一组动作；返回 { done, skipped: [{kind, error}] } */
export function runBeats(town, list, { privileged = false, ctx = {} } = {}) {
  const skipped = [];
  let done = 0;
  for (const b of Array.isArray(list) ? list : []) {
    const err = checkBeat(town, b, { privileged, ctx });
    if (err) { skipped.push({ kind: b?.kind, error: err }); continue; }
    try { KINDS[b.kind].run(town, b, ctx); done++; town.hooks?.emit('story.beat', { beat: b }); } catch (e) {
      console.warn(`[beat] ${b.kind} 执行失败：`, e.message);
      skipped.push({ kind: b.kind, error: e.message });
    }
  }
  return { done, skipped };
}
