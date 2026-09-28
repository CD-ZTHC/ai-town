// 人员流动：世界会自己来新人、有人出门远行、有人回来。
// 节奏由代码把关（每天掷一次骰子、冷却、人数上限、同时离开的人数上限），到点时调用一次模型决定「谁来、谁走、谁回来」并生成新人的人物卡。
// 非致死原则：离开总是可逆的（出门的人按约定的日子回来，owner / 管理员也可以随时召回或请人离开）。
// 新人先以「外来者」（traveller）身份住下，和大家熟悉之后转为常住居民（settlePersona）。
import * as llm from '../llm.ts';
import { addMemory } from '../memory.ts';
import { keywordCheck } from '../guard.js';
import { ruleCheck } from '../worldai/canon.ts';
import { normalizeLook } from '../genesis/assemble.js';
import { get as setting } from '../settings/index.ts';
import { MAX_PERSONAS } from '../kernel/spec.ts';
import { reviewRating } from '../kernel/ratings.ts';

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const RESIDENTIAL = new Set(['hut', 'cabin', 'cottage', 'house', 'farmhouse', 'inn', 'tavern']);
const HOME_CAP = 3; // 一处住处最多住几个人
const SETTLE_DAYS = 5; // 新人至少住这么多天才考虑定居
const MIN_STAY_DAYS = 3; // 新来的人至少待这么多天才可能离开
const AWAY_RATIO = 0.2; // 同时出门在外的人不超过初始人数的这个比例（至少 1 人）

export class MigrationSystem {
  constructor(town, { random = Math.random } = {}) {
    this.town = town;
    this.random = random;
    this.busy = false;
  }

  get st() {
    const t = this.town;
    return (t.migrationState ||= { lastDay: t.day, rollDay: 0, dueAt: null, settleDay: 0, history: [], away: {}, arrived: {} });
  }

  /** 全站开关 MIGRATION 与世界设置里的 migration（默认开） */
  enabled() {
    return setting('MIGRATION') && this.town.worldSettings?.migration !== false;
  }

  /** 世界包里的初始人数（不含生物）：上限与离开比例都按它算 */
  baseline() {
    return Math.max(1, (this.town.baseSpec?.personas || this.town.spec.personas).filter((p) => p.kind !== 'creature').length);
  }

  cap() { return Math.ceil(this.baseline() * setting('MIGRATION_CAP')); }

  /** 剧情弧里的角色与生物由剧情管理，人员流动不碰 */
  protectedIds() {
    const ids = new Set();
    for (const arc of this.town.spec.arcs || []) for (const id of Object.keys(arc.cast || {})) ids.add(id);
    for (const p of this.town.spec.personas) if (p.kind === 'creature') ids.add(p.id);
    return ids;
  }

  people() { return this.town.spec.personas.filter((p) => p.kind !== 'creature'); }

  activeCount() { return this.people().filter((p) => p.status !== 'departed' && p.status !== 'dead').length; }

  /** 导演安排出门的人（owner / 管理员请走的人不算，导演也不会把他们叫回来） */
  awayCount() { return Object.values(this.st.away).filter((x) => !x.by || x.by === 'migration').length; }

  maxAway() { return Math.max(1, Math.floor(this.baseline() * AWAY_RATIO)); }

  /** 可以出门的人：在场、不归剧情管、不是刚来的 */
  leaveCandidates() {
    const prot = this.protectedIds();
    const st = this.st;
    return this.town.agents.filter((a) => a.kind !== 'creature' && !prot.has(a.id) && !a.convoId
      && !(st.arrived[a.id] && this.town.day - st.arrived[a.id].day < MIN_STAY_DAYS));
  }

  /** 这一次允许的变动 */
  options() {
    const out = [];
    if (this.activeCount() < this.cap() && this.town.spec.personas.length < MAX_PERSONAS) out.push('arrive');
    if (this.awayCount() < this.maxAway() && this.activeCount() > 2 && this.leaveCandidates().length) out.push('leave');
    if (this.awayCount()) out.push('return');
    return out;
  }

  /** 每天掷一次骰子：距离上次变动至少 minGap 天，之后每天有 p 的概率，平均间隔约为 MIGRATION_DAYS */
  roll() {
    const D = setting('MIGRATION_DAYS');
    const minGap = Math.max(1, Math.round(D * 0.75));
    if (this.town.day - this.st.lastDay < minGap) return false;
    return this.random() < 1 / Math.max(1, D - minGap + 1);
  }

  tick() {
    if (!this.enabled()) return;
    const town = this.town;
    const st = this.st;
    const m = town.minute;
    const day = town.day;
    const daytime = m >= 8 * 60 && m < 20 * 60;
    // 约好回来的人
    if (daytime) for (const [id, info] of Object.entries(st.away)) if (info.returnDay && day >= info.returnDay) this.recall(id, 'plan');
    // 新人住熟了就定居
    if (m >= 12 * 60 && st.settleDay !== day) { st.settleDay = day; this.settleCheck(); }
    if (st.rollDay !== day) {
      st.rollDay = day;
      st.dueAt = this.roll() ? (day - 1) * 1440 + 9 * 60 + Math.floor(this.random() * 7 * 60) : null;
    }
    if (st.dueAt != null && town.t >= st.dueAt && !this.busy) {
      st.dueAt = null;
      if (llm.enabled() && llm.budgetLeft() > 0) this.decide().catch((e) => console.warn('[migration]', e.message));
    }
  }

  // ---------- 住处 ----------
  occupancy() {
    const n = {};
    for (const p of this.town.spec.personas) if (p.status !== 'departed' && p.status !== 'dead' && p.home) n[p.home] = (n[p.home] || 0) + 1;
    return n;
  }

  /** 可以住人的地方：室内地点；住宅类建筑优先 */
  homes() {
    const w = this.town.world;
    const occ = this.occupancy();
    return Object.values(w.locations).filter((l) => l.indoor && !l.closed).map((l) => {
      const b = w.buildings.find((x) => x.id === l.indoor);
      return { id: l.id, name: l.name, residential: RESIDENTIAL.has(b?.kind) || Boolean(occ[l.id]), n: occ[l.id] || 0 };
    }).filter((h) => h.residential);
  }

  pickHome(wanted) {
    const homes = this.homes();
    const h = homes.find((x) => x.id === wanted && x.n < HOME_CAP);
    if (h) return h.id;
    const free = homes.filter((x) => x.n < HOME_CAP).sort((a, b) => a.n - b.n)[0]?.id;
    if (free) return free;
    // 住满了：记一笔住处紧张，架构师会看到（地图压力表）
    this.town.mapPressure?.homeFull();
    return homes.sort((a, b) => a.n - b.n)[0]?.id || null;
  }

  spawnAt(wanted) {
    const town = this.town;
    const pub = town.publicLocs();
    if (pub.includes(wanted)) return wanted;
    const sp = town.spec.voice?.spawn;
    return pub.includes(sp) ? sp : pub[0];
  }

  // ---------- 模型决定 ----------
  prompt(opts) {
    const town = this.town;
    const st = this.st;
    const place = town.spec.voice?.place || '小镇';
    const names = (id) => town.byId[id]?.name || id;
    const people = town.agents.filter((a) => a.kind !== 'creature').map((a) => {
      const came = st.arrived[a.id];
      return `- ${a.name}（${a.age}岁，${a.role}，住在${town.locName(a.home)}）${came ? `：第${came.day}天从${came.from}来的${a.kind === 'traveller' ? '外来者' : '，已经住下'}` : ''}`;
    }).join('\n');
    const away = Object.entries(st.away).filter(([, x]) => !x.by || x.by === 'migration').map(([id, x]) => `- ${names(id)}：第${x.since}天去了${x.where || '外地'}${x.returnDay ? `，约好第${x.returnDay}天回来` : ''}`).join('\n');
    const homes = this.homes().map((h) => `${h.id}（${h.name}，住着${h.n}人）`).join('、');
    const recent = town.logs.filter((l) => ['convo', 'scene', 'news_spread', 'arrival', 'depart', 'thread', 'growth', 'world'].includes(l.type)).slice(-10).map((l) => `- ${l.text}`).join('\n');
    const history = st.history.slice(-6).map((h) => `- 第${h.day}天 ${h.text}`).join('\n');
    const canon = (town.spec.lore.canon || []).slice(-5).map((c) => `- ${c.text}`).join('\n');
    const O = {
      arrive: `"arrive"：来了一个新人。给出 {"name":"≤6字","age":数字,"role":"身份≤12字","from":"从哪里来≤16字","why":"为什么来≤40字","persona":"性格与说话方式≤120字","goal":"来这里想做的事≤60字","home":"住处 id","work":"平时待的地点 id","at":"登场地点 id","memories":["来之前的经历≤40字",…最多3条],"relations":{"居民姓名":[好感-20~50,"看法≤20字"]},"look":{"skin":"#rrggbb","hair":"#rrggbb","hairStyle":"long/short/messy/buzz/bun/spiky","shirt":"#rrggbb","pants":"#rrggbb","acc":["apron/strawhat/beard/glasses/coat/cap/earring"]}}`,
      leave: `"leave"：有人出门一段时间（探亲、求学、进货、远行……），一定会回来。给出 {"who":"姓名","where":"去哪里≤16字","why":"为什么走≤40字","days":3~10,"farewell":"临走前对大家说的一句话≤40字"}`,
      return: `"return"：出门在外的人提前回来了。给出 {"who":"姓名","why":"为什么提前回来≤40字"}`,
    };
    return `${town.timeBlock()}
世界：${town.spec.meta.name}（${place}）。${str(town.spec.lore.summary, 300)}
不可违背的设定：${town.spec.lore.pillars.join('；')}
${town.spec.era?.tech ? `时代：${town.spec.era.tech}；这里没有：${(town.spec.era.forbidden || []).join('、') || '（无）'}\n` : ''}${canon ? `${place}的历史：\n${canon}\n` : ''}
现在住在${place}的人（${this.activeCount()} 人，上限 ${this.cap()} 人）：
${people}
${away ? `出门在外的人：\n${away}\n` : ''}${history ? `最近的人来人往：\n${history}\n` : ''}最近发生的事：
${recent || '（平静）'}
住处：${homes || '（没有空房，可以借住在别人家）'}
公共地点：${town.publicLocs().join(', ')}

你是这个世界的叙事导演。${place}里的人会自然地流动：有人慕名而来、投亲靠友、路过留下，也有人出门远行、过些日子再回来。
这一次可以选择：${opts.map((k) => `\n${O[k]}`).join('')}
"none"：这次没有合适的变动。
要求：新人必须属于这个世界的时代与设定，和已有居民不重名；来和走都要有具体、可信、能引出故事的理由，最好与最近发生的事或居民的目标有关；没有人死亡。
输出 JSON：{"change":"${opts.join('/')}/none","reason":"一句话说明为什么是现在（≤40字）",${opts.map((k) => `"${k}":{…}`).join(',')}}`;
  }

  async decide(force = null) {
    const town = this.town;
    if (this.busy) return { change: 'busy' };
    let opts = this.options();
    if (force) opts = opts.includes(force) ? [force] : [];
    if (!opts.length) return { change: 'none', reason: '现在没有可以发生的变动' };
    this.busy = true;
    try {
      const res = await llm.chatJSON([
        town.sys('你现在是整个世界的叙事导演，而不是某个角色。'),
        { role: 'user', content: this.prompt(opts) },
      ], { label: '人员流动', agent: '导演', maxTokens: 1800, temperature: 0.9, tier: 'smart', timeoutMs: 120_000, attempts: 2 });
      const change = opts.includes(res?.change) ? res.change : 'none';
      let r = { change: 'none', reason: str(res?.reason, 40) };
      if (change === 'arrive') r = this.arrive(res.arrive || {}, { reason: res.reason });
      else if (change === 'leave') r = this.leave(res.leave || {}, { reason: res.reason });
      else if (change === 'return') r = this.recall(this.resolve(res.return?.who)?.id, 'director', str(res.return?.why, 40));
      if (r?.error) console.warn(`[migration] ${town.worldId}：${change} 没有成功：${r.error}`);
      return r;
    } finally { this.busy = false; }
  }

  resolve(who) {
    const s = str(who, 16);
    if (!s) return null;
    const ps = this.people();
    return ps.find((p) => p.id === s || p.name === s) || ps.find((p) => s.includes(p.name)) || null;
  }

  // ---------- 三种变动 ----------
  /** 新人到来：人物卡经过裁剪、默认值、关键词与支柱设定检查后以外来者身份登场 */
  arrive(raw, { reason = '' } = {}) {
    const town = this.town;
    const st = this.st;
    if (this.activeCount() >= this.cap() || town.spec.personas.length >= MAX_PERSONAS) return { error: `人数已达上限 ${this.cap()}` };
    const name = str(raw.name, 6);
    if (!name) return { error: '没有名字' };
    const card = {
      name, age: Math.max(3, Math.min(120, Math.round(Number(raw.age) || 25))), role: str(raw.role, 12) || '外来者',
      persona: str(raw.persona, 200), goal: str(raw.goal, 60) || '在这里安顿下来', from: str(raw.from, 16) || '远方', why: str(raw.why, 40) || str(reason, 40),
      memories: (Array.isArray(raw.memories) ? raw.memories : []).map((m) => str(m, 40)).filter(Boolean).slice(0, 3),
    };
    if (!card.persona) return { error: '没有性格描述' };
    const text = [card.name, card.role, card.persona, card.goal, card.from, card.why, ...card.memories].join(' ');
    const kw = keywordCheck(text, reviewRating(town.spec.meta.rating));
    if (!kw.ok) return { error: `人物卡没有通过审核：${kw.reason}` };
    const issues = ruleCheck(town.spec, [{ op: 'addPersona', args: { name, text } }]);
    if (issues.length) return { error: issues[0] };
    const n = st.history.filter((h) => h.kind === 'arrive').length + 1;
    let id = `nc${town.day}_${n}`;
    while (town.spec.personas.some((p) => p.id === id)) id += 'x';
    const home = this.pickHome(raw.home);
    if (!home) return { error: '没有可以住的地方' };
    const at = this.spawnAt(raw.at);
    const work = town.findLocation(raw.work) ? raw.work : at;
    town.applyWorldOp({ op: 'addPersona', args: {
      id, name, age: card.age, role: card.role, kind: 'traveller', tier: 'support', home, work, persona: card.persona, goal: card.goal,
      look: normalizeLook(raw.look, id), memories: [`我从${card.from}来到这里：${card.why}`, ...card.memories],
      traveller: { origin: card.from, knowledgeGap: [] },
    } }, { by: 'migration' }, { quiet: true });
    town.syncAgents();
    const a = town.byId[id];
    // 新人对居民的第一印象（居民对新人的看法在相处中形成）
    for (const [k, v] of Object.entries(raw.relations && typeof raw.relations === 'object' ? raw.relations : {}).slice(0, 6)) {
      const b = town.agents.find((x) => x.name === k || x.id === k);
      if (!b || b === a) continue;
      const [aff, note] = Array.isArray(v) ? v : [v?.score, v?.note];
      a.relations[b.id] = { affinity: Math.max(-20, Math.min(50, Math.round(Number(aff) || 0))), note: str(note, 20) };
    }
    const s = town.findLocation(at)?.spots?.[0] || town.locCenter(at);
    if (s) Object.assign(a, { x: s.x, y: s.y, inside: null, locId: at, region: town.locRegion(at), status: 'acting', path: [], dest: null, curKey: null, action: { text: '四处张望', emoji: '👀' } });
    if (s) town.emit('vfx', { preset: 'sparkle', x: s.x, y: s.y, color: '#ffd76a', radius: 2, region: a.region });
    const place = town.spec.voice?.place || '小镇';
    const line = `${name}从${card.from}来到了${place}——${card.role}。${card.why}`;
    town.log('arrival', `🧳 ${line}`, { agents: [id] });
    for (const b of town.agents) if (b !== a && b.kind !== 'creature') addMemory(b, { t: town.t, type: 'event', text: `听说${place}来了个新人：${name}，${card.role}，从${card.from}来`, importance: 5 });
    town.replan(a, `你刚从${card.from}来到${place}，落脚在${town.locName(at)}；你暂时住在${town.locName(home)}。这里的一切对你来说都还很新鲜。`).catch(() => {});
    st.arrived[id] = { day: town.day, from: card.from };
    this.record('arrive', id, `🧳 ${name}从${card.from}来了：${card.why}`, reason);
    return { change: 'arrive', id, name };
  }

  /** 有人出门：约好几天后回来 */
  leave(raw, { reason = '', by = 'migration' } = {}) {
    const town = this.town;
    const p = this.resolve(raw.who);
    const a = p && town.byId[p.id];
    if (!a || !town.agents.includes(a)) return { error: `不在场：${raw.who}` };
    if (by === 'migration' && !this.leaveCandidates().includes(a)) return { error: `${a.name} 现在不能离开` };
    if (this.protectedIds().has(a.id)) return { error: `${a.name} 由剧情安排，不能离开` };
    const days = raw.days == null ? null : Math.max(2, Math.min(14, Math.round(Number(raw.days) || 5)));
    const where = str(raw.where, 16);
    const why = str(raw.why, 40) || str(reason, 40);
    const farewell = str(raw.farewell, 40);
    // 亲近的人记住这次离别
    for (const b of town.agents) if (b !== a && b.kind !== 'creature' && ((b.relations[a.id]?.affinity ?? 0) >= 20 || (a.relations[b.id]?.affinity ?? 0) >= 20)) {
      addMemory(b, { t: town.t, type: 'event', text: `${a.name}${where ? `去了${where}` : '出门了'}${why ? `（${why}）` : ''}${days ? `，说大概${days}天后回来` : ''}${farewell ? `。临走时说：「${farewell}」` : ''}`, importance: 6 });
    }
    addMemory(a, { t: town.t, type: 'event', text: `我${where ? `去了${where}` : '出门了'}${why ? `：${why}` : ''}`, importance: 6 });
    const text = `👋 ${a.name}${where ? `去了${where}` : '出门了'}${why ? `：${why}` : ''}${days ? `（约好第${town.day + days}天回来）` : ''}`;
    town.depart(a.id, by, text);
    this.st.away[a.id] = { since: town.day, returnDay: days ? town.day + days : null, where, why, by };
    this.record('leave', a.id, text, reason, by);
    return { change: 'leave', id: a.id, name: a.name };
  }

  /** 出门的人回来（到了约好的日子、导演安排提前回来、或 owner / 管理员召回） */
  recall(id, by = 'plan', why = '') {
    const town = this.town;
    const p = town.spec.personas.find((x) => x.id === id);
    if (!p || p.status !== 'departed') return { error: `不在外面：${id}` };
    if (this.protectedIds().has(id)) return { error: `${p.name} 由剧情安排` };
    const info = this.st.away[id] || {};
    if (by === 'director' && info.by && info.by !== 'migration') return { error: `${p.name} 是被请离的，只有创建者或管理员可以召回` };
    if (by === 'director' && !this.st.away[id]) return { error: `${p.name} 不是出门在外` };
    town.applyWorldOp({ op: 'setPersonaStatus', args: { id, status: 'active' } }, { by }, { quiet: true });
    town.syncAgents();
    const a = town.byId[id];
    const at = this.spawnAt(null);
    const s = town.findLocation(at)?.spots?.[0] || town.locCenter(at);
    if (a && s) Object.assign(a, { x: s.x, y: s.y, inside: null, locId: at, region: town.locRegion(at), status: 'idle', path: [], dest: null, curKey: null });
    delete this.st.away[id];
    const text = `🏡 ${p.name}${info.where ? `从${info.where}` : ''}回来了${why ? `：${why}` : ''}`;
    town.log('arrival', text, { agents: [id] });
    if (a) {
      addMemory(a, { t: town.t, type: 'event', text: `我${info.where ? `从${info.where}` : ''}回来了`, importance: 5 });
      for (const b of town.agents) if (b !== a && b.kind !== 'creature' && (b.relations[id]?.affinity ?? 0) >= 20) addMemory(b, { t: town.t, type: 'event', text: `${p.name}回来了`, importance: 5 });
      town.replan(a, `你${info.where ? `从${info.where}` : '出门一趟'}刚回来，到了${town.locName(at)}。`).catch(() => {});
    }
    this.record('return', id, text, why, by);
    return { change: 'return', id, name: p.name };
  }

  /** 外来者和大家熟悉之后定居：至少住满 SETTLE_DAYS 天，并且有两位居民和他处得不错 */
  settleCheck() {
    const town = this.town;
    const st = this.st;
    for (const [id, info] of Object.entries(st.arrived)) {
      const p = town.spec.personas.find((x) => x.id === id);
      const a = town.byId[id];
      if (!p || !a || p.kind !== 'traveller' || p.status === 'departed' || p.status === 'dead' || town.day - info.day < SETTLE_DAYS) continue;
      const friends = town.agents.filter((b) => b !== a && b.kind !== 'creature' && Math.max(b.relations[id]?.affinity ?? 0, a.relations[b.id]?.affinity ?? 0) >= 20);
      if (friends.length < 2) continue;
      town.applyWorldOp({ op: 'settlePersona', args: { id } }, { by: 'migration' }, { quiet: true });
      a.kind = 'resident';
      const place = town.spec.voice?.place || '小镇';
      const text = `🏠 ${a.name}决定在${place}住下来了，成了这里的${town.spec.voice?.resident || '居民'}`;
      town.log('arrival', text, { agents: [id] });
      addMemory(a, { t: town.t, type: 'event', text: `我决定在${place}住下来。${friends.slice(0, 2).map((b) => b.name).join('和')}待我很好`, importance: 7 });
      this.record('settle', id, text, '', 'migration', false);
    }
  }

  record(kind, id, text, reason = '', by = 'migration', counts = true) {
    const st = this.st;
    st.history.push({ day: this.town.day, t: Math.floor(this.town.t), kind, id, text: str(text, 80), reason: str(reason, 40), by });
    if (st.history.length > 60) st.history.shift();
    // 只有导演安排的变动计入冷却（约好的回来、定居、owner 的操作不算）
    if (counts && by === 'migration') st.lastDay = this.town.day;
    this.town.emit('story');
  }

  view() {
    const town = this.town;
    const st = this.st;
    const prot = this.protectedIds();
    return {
      enabled: this.enabled(), count: this.activeCount(), cap: this.cap(), history: st.history.slice(-20).reverse(),
      away: Object.entries(st.away).map(([id, x]) => ({ id, name: town.byId[id]?.name || id, ...x })),
      people: this.people().filter((p) => !prot.has(p.id)).map((p) => ({ id: p.id, name: p.name, role: p.role, kind: p.kind, status: p.status || 'active', arrivedDay: st.arrived[p.id]?.day ?? null, from: st.arrived[p.id]?.from ?? null })),
    };
  }
}
