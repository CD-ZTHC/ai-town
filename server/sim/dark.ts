// 黑暗叙事的居民侧（设计 §4.4、§4.5、§4.8~§4.10）：死亡与死亡预算、受伤与治疗、群众伤亡、负担值、宿主关系、
// 阵营配给与派遣、反派的欲望与转变，以及写进居民提示词的部分。
// 规则（是否在身边、死亡预算、负担值的一步、寄宿倍率、伤亡记在哪、会不会有人动手）是下面只依赖显式输入的函数
// （重构方案 P6 第三步，测试见 test/dark-rules.test.ts）；Town 上的方法（Dark mixin）负责死亡、日志、记忆与效果。
import { addMemory } from '../memory.ts';
import { runEffects, posOf } from '../kernel/effects.ts';
import { testExpr, hasPosture } from '../kernel/rules.ts';
import { findAbility } from '../kernel/abilities.ts';
import { lethal } from '../kernel/ratings.ts';
import { freshDark } from '../story/threats.ts';
import { clamp } from './util.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent, ScheduleEntry } from '../types/agent.ts';
import type { Act, ActArgs, Convo, DarkState, Fight, SaveData, ThreatInstance } from '../types/town.ts';
import type { Persona, WorldSpec } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import type { Pos } from '../kernel/effects.ts';
import type { ModelJSON } from '../llm.ts';
import type { RetrieveOptions } from '../memory.ts';

export const DEATH_NAMED_DEFAULT = 2;
export const DEATH_DAYS_DEFAULT = 3;
const ANCHOR = 50; // 好感达到多少算「锚」（负担值的 anchor_lost 事件）

// darkState 是 getter（不能声明 this 参数），这里声明它用到的字段
export interface Dark { dark: DarkState }

// ---------- 规则（只依赖显式输入） ----------
type Placed = { x: number; y: number; region?: string | null; inside?: string | null };

/** 两个居民是否在一起（同一栋楼里，或都在户外、r 格以内；不同区域不算） */
export function isNear(a: Placed | null | undefined, b: Placed | null | undefined, r = 3): boolean {
  if (!a || !b || (a.region || 'town') !== (b.region || 'town')) return false;
  if (a.inside || b.inside) return a.inside === b.inside;
  return Math.hypot(a.x - b.x, a.y - b.y) <= r;
}

/** 死亡预算：最近 days 天里已经死了几个具名角色，还剩几个名额 */
export function deathBudgetOf(deaths: ReadonlyArray<{ t: number }>, t: number, named: number, days: number) {
  const used = deaths.filter((d) => t - d.t < days * 1440).length;
  return { named, days, used, left: Math.max(0, named - used) };
}

/** 负担值的一步：截到 [0, max]；跨过 moodAt 的阈值时换成对应的心情（取最后一个）；刚到顶时 full */
export function burdenStep(before: number, amount: number, max: number, moodAt: ReadonlyArray<readonly [number, string]>): { value: number; mood: string | null; full: boolean } {
  const value = clamp(before + amount, 0, max);
  let mood: string | null = null;
  for (const [v, m] of moodAt) if (before < v && value >= v) mood = m;
  return { value, mood, full: value >= max && before < max };
}

/** 寄宿的威胁对某个负担的增速倍率：寄宿的各威胁的 rate 相加，再加上同时寄宿时的互相影响；没有寄宿时为 1 */
export function hostedDriftMult(hosted: ReadonlyArray<{ threat: string }>, threats: WorldSpec['threats'], burdenId: string): number {
  const hosts = hosted.map((h) => threats?.[h.threat]?.hostable).filter((h) => h?.burden === burdenId);
  if (!hosts.length) return 1;
  let mult = hosts.reduce((s, h) => s + (h!.rate ?? 1), 0);
  for (const h of hosted) for (const [other, off] of Object.entries(threats?.[h.threat]?.hostable?.offsets || {})) if (hosted.some((x) => x.threat === other)) mult += off;
  return Math.max(0, mult);
}

/** 群众伤亡记在哪个地点：候选地点里与 at 同区域、中心离 at 最近的 */
export function nearestLoc(cands: string[], at: Placed, regionOf: (id: string) => string, centerOf: (id: string) => { x: number; y: number } | null): string | null {
  let loc: string | null = null, best = Infinity;
  for (const id of cands) {
    if (regionOf(id) !== (at.region || 'town')) continue;
    const c = centerOf(id);
    const d = c ? Math.hypot(c.x - at.x, c.y - at.y) : Infinity;
    if (d < best) { best = d; loc = id; }
  }
  return loc;
}

/** 这个世界允许居民之间的敌对行动吗：冒险分级起，并且世界包里有阵营、反派或威胁 */
export function hostileWorld(spec: Pick<WorldSpec, 'meta' | 'factions' | 'personas' | 'threats'>): boolean {
  if (!['adventure', 'epic', 'dark', 'tragic'].includes(spec.meta.rating)) return false;
  return Boolean((spec.factions || []).length || spec.personas.some((p) => p.alignment === 'villain') || Object.keys(spec.threats || {}).length);
}

// ---------- Town 上的接口 ----------
export class Dark {
  near(this: Town, a: LiveAgent, b: LiveAgent, r = 3) { return isNear(a, b, r); }

  get darkState() { return (this.dark ||= freshDark()); }

  /** 死亡预算：每 days 天最多 named 名具名角色死亡（世界设置覆盖世界包参数） */
  deathBudget(this: Town) {
    const named = Number.isInteger(this.worldSettings?.deathNamed) ? this.worldSettings.deathNamed : this.params.deathNamed ?? DEATH_NAMED_DEFAULT;
    return deathBudgetOf(this.darkState.deaths, this.t, named, this.params.deathDays ?? DEATH_DAYS_DEFAULT);
  }

  // ---------- 死亡（设计 §4.10）----------
  /**
   * 让一位居民死去。分级不允许、有主角光环、死亡预算用完时降为重伤。
   * 返回 'dead' / 'wounded'（分级不允许）/ 'spared'（光环或预算）/ 'absent'
   */
  killAgent(this: Town, a: LiveAgent, { cause = '', text = '', threat = null }: { cause?: string; text?: string; threat?: ThreatInstance | null } = {}) {
    if (!a || !this.agents.includes(a) || a.kind === 'creature') return 'absent';
    const p = this.spec.personas.find((x) => x.id === a.id);
    if (!lethal(this.spec.meta.rating)) { this.woundAgent(a, 80, { cause }); return 'wounded'; }
    if (p?.plotArmor || this.deathBudget().left <= 0) {
      this.woundAgent(a, 85, { cause });
      addMemory(a, { t: this.t, type: 'obs', text: '差一点就死了，不知道是怎么捡回这条命的', importance: 9 });
      this.log('survive', `🩸 ${a.name}重伤倒下，捡回了一条命`, { agents: [a.id] });
      return 'spared';
    }
    const at = posOf(this, a);
    const why = text || `${a.name}死了`;
    const others = this.agents.filter((o) => o !== a && o.kind !== 'creature');
    // 遗物交给和死者最亲近的人
    const heir = others.map((o) => ({ o, aff: a.relations[o.id]?.affinity ?? -999 })).sort((x, y) => y.aff - x.aff)[0];
    const items = { ...a.inventory };
    if (heir && heir.aff > 0) for (const [k, n] of Object.entries(items)) heir.o.inventory[k] = Math.min(99, (heir.o.inventory[k] || 0) + n);
    a.inventory = {};
    this.applyWorldOp({ op: 'setPersonaStatus', args: { id: a.id, status: 'dead' } }, { by: cause || 'death' }, { quiet: true });
    this.syncAgents();
    Object.assign(a, { marks: [], containing: null, posture: null, captive: null, moving: false });
    const st = this.darkState;
    st.graves.push({ id: `g${++st.seq}`, name: a.name, x: Math.round(at?.x ?? a.x), y: Math.round(at?.y ?? a.y), region: at?.region || 'town', t: Math.floor(this.t), day: this.day });
    if (st.graves.length > 40) st.graves.shift();
    st.deaths.push({ id: a.id, name: a.name, t: Math.floor(this.t), day: this.day, cause, text: why, loc: a.locId || null });
    // 认识的人：悲伤、失去锚；关系很近的人会想查清真相
    for (const o of others) {
      const aff = Math.max(o.relations[a.id]?.affinity ?? 0, a.relations[o.id]?.affinity ?? 0);
      const close = aff >= ANCHOR;
      addMemory(o, { t: this.t, type: 'event', text: close ? `${a.name}死了。${why}。我还没来得及……` : `听说${a.name}死了：${why}`, importance: close ? 9 : 6 });
      if (close) {
        o.mood = { text: '悲伤', emoji: '😢' };
        this.burdenEvent(o, 'anchor_lost');
        if (aff >= 60) this.setBelief(o, { about: `${a.name.slice(0, 8)}的死`, claim: `一定要查清${a.name}是怎么死的`, confidence: 0.9, source: 'grief' });
      }
    }
    if (heir && heir.aff > 0 && Object.keys(items).length) addMemory(heir.o, { t: this.t, type: 'obs', text: `${a.name}的遗物交到了我手里`, importance: 7 });
    // 身上寄宿的东西脱出（设计 §4.5）
    if (a.hosted?.length) this.threats?.releaseHosted(a);
    this.log('death', `🕯️ ${why}`, { agents: [a.id], cause, ...(threat ? { threat: threat.id } : {}) });
    try { this.applyWorldOp({ op: 'addCanon', args: { text: `第${this.day}天，${why}。`, tags: ['死亡'] } }, { by: 'death' }, { quiet: true }); } catch { /* 正典满了 */ }
    this.crisis.morale = clamp(this.crisis.morale - 10, 0, 100);
    this.hooks.emit('agent.death', { agent: a, cause });
    this.emit('agents', this.agentsMeta());
    this.emit('story');
    return 'dead';
  }

  /** 受伤：hp 降到 30 以下为重伤，送去休养 */
  woundAgent(this: Town, a: LiveAgent, amount: number, { cause = '' }: { cause?: string } = {}) {
    if (!a || !this.agents.includes(a)) return;
    const b = a.body;
    b.hp = clamp(Math.round(b.hp - amount), 1, 100);
    if (b.hp < 30 && !b.conditions.includes('重伤')) {
      b.conditions = [...new Set([...b.conditions, '重伤'])].slice(-5);
      addMemory(a, { t: this.t, type: 'obs', text: '受了很重的伤，得好好躺一阵子', importance: 7 });
      this.log('wound', `🩸 ${a.name}受了重伤`, { agents: [a.id], cause });
      this.sendToClinic(a);
    }
    this.emit('agent', a.id);
  }

  healAgent(this: Town, a: LiveAgent, amount: number) {
    const b = a.body;
    b.hp = clamp(Math.round(b.hp + amount), 0, 100);
    if (b.hp >= 50) b.conditions = b.conditions.filter((c) => c !== '重伤');
    this.emit('agent', a.id);
  }

  /** 群众伤亡（只记数字，设计 §4.10）：at 可以是地点 id 或坐标；记在最近的、有人口的地点上 */
  casualties(this: Town, at: Cell & { region?: string } | string | null | undefined, n: number, { cause = '', text = '' }: { cause?: string; text?: string } = {}) {
    if (!(n > 0)) return 0;
    const st = this.darkState;
    let loc: string | null = typeof at === 'string' ? at : null;
    if (!loc && at) {
      const cands = Object.keys(st.population).length ? Object.keys(st.population) : this.publicLocs();
      loc = nearestLoc(cands, at as Placed, (id) => this.locRegion(id), (id) => this.locCenter(id));
    }
    const pop = loc && st.population[loc];
    const k = pop ? Math.min(n, pop.alive) : n;
    if (!k) return 0;
    if (pop) { pop.alive -= k; pop.dead += k; }
    st.crowd.push({ t: Math.floor(this.t), day: this.day, loc, n: k, cause });
    if (st.crowd.length > 200) st.crowd.shift();
    this.crisis.morale = clamp(this.crisis.morale - Math.min(8, k), 0, 100);
    for (const a of this.agents) if (a.locId === loc && a.kind !== 'creature') addMemory(a, { t: this.t, type: 'event', text: `${this.locName(loc)}又死了${k}个人，大家都吓坏了`, importance: 6 });
    this.log('casualty', `🕯️ ${loc ? this.locName(loc) : '城里'}：${text || '又有人遇害'}（${k} 人）`, { cause, loc, n: k });
    return k;
  }

  // ---------- 负担值（设计 §4.4）----------
  addBurden(this: Town, a: LiveAgent, id: string, amount: number, event: string | null = null) {
    const def = this.spec.burdens?.[id];
    if (!def || !a || !this.agents.includes(a)) return;
    if (amount > 0 && (a.burdenFreeze?.[id] || 0) > this.t) return;
    const bs = (a.burdens ||= {});
    const step = burdenStep(bs[id] ?? 0, amount, def.max ?? 100, def.moodAt || []);
    bs[id] = step.value;
    if (step.mood) a.mood = { text: step.mood, emoji: '🌑' };
    if (step.full && def.onFull?.length) {
      this.log('burden', `🌑 ${a.name}的${def.name}到了尽头`, { agents: [a.id] });
      runEffects(this, { self: a, target: a, e: a, at: posOf(this, a), source: `burden:${id}` }, def.onFull);
    }
    if (event === 'ability_used') this.burdenEvent(a, 'ability_used', id);
    this.emit('agent', a.id);
  }

  /** 关系事件触发负担值跳涨：anchor_lost（最亲近的人死了）/ anchor_gained / ability_used */
  burdenEvent(this: Town, a: LiveAgent, event: string, only: string | null= null) {
    for (const id of Object.keys(a.burdens || {})) {
      if (only && id !== only) continue;
      for (const ev of this.spec.burdens?.[id]?.onEvent || []) if (ev.event === event) this.addBurden(a, id, ev.amount);
    }
  }

  /** 每小时：负担值按 drift 增长（寄宿的威胁、driftMods 调整速度） */
  burdenTick(this: Town) {
    const spec = this.spec;
    if (!spec.burdens || !Object.keys(spec.burdens).length) return;
    for (const a of [...this.agents]) {
      for (const id of Object.keys(a.burdens || {})) {
        const def = spec.burdens[id];
        if (!def || !def.drift) continue;
        let mult = hostedDriftMult(a.hosted || [], spec.threats, id);
        for (const m of def.driftMods || []) {
          try { if (testExpr(this, m.when, { self: a, e: a })) mult *= m.mult; } catch { /* 条件出错时忽略这一条 */ }
        }
        this.addBurden(a, id, (def.drift / 24) * mult);
        if (!this.agents.includes(a)) break;
      }
    }
  }

  // ---------- 宿主关系（设计 §4.5）----------
  /** 让 a 成为某个威胁的宿主；inst 是被吸收的那个实例（没有时只是寄宿一只同类） */
  hostThreat(this: Town, a: LiveAgent, type: string, inst: ThreatInstance | null= null) {
    const def = this.spec.threats?.[type];
    const h = def?.hostable;
    if (!h || !a || !this.agents.includes(a) || (a.hosted || []).some((x) => x.threat === type)) return false;
    (a.hosted ||= []).push({ threat: type, since: Math.floor(this.t) });
    (a.burdens ||= {})[h.burden] ??= 0;
    for (const id of h.grants) if (!a.abilities.includes(id)) this.learnAbility(a, id, `借着${def.name}的力量`);
    if (inst) {
      inst.state = 'gone';
      const st = this.darkState;
      st.zones = st.zones.filter((z) => z.threat !== inst.id);
      for (const o of this.agents) if (o.marks?.length) o.marks = o.marks.filter((m) => m.threat !== inst.id);
      const inc = st.incidents.find((x) => x.id === inst.incident);
      if (inc) { inc.outcome = 'hosted'; inc.stage = 'handled'; }
    }
    addMemory(a, { t: this.t, type: 'obs', text: `${def.name}进到了我的身体里。我能借它的力量了，可我也知道这意味着什么`, importance: 9 });
    this.log('host', `🌑 ${a.name}成了${def.name}的宿主`, { agents: [a.id] });
    this.emit('agent', a.id);
    return true;
  }

  /** 创建角色时：初始寄宿的威胁与负担值（世界包 personas[].start.hosted / start.burdens） */
  initDarkAgent(this: Town, a: LiveAgent, p: Persona) {
    if (p.alignment) a.alignment = p.alignment;
    if (p.combat) a.combat = { ...p.combat };
    const burdens = { ...(p.start?.burdens || {}) };
    for (const t of p.start?.hosted || []) {
      const h = this.spec.threats?.[t]?.hostable;
      if (!h) continue;
      (a.hosted ||= []).push({ threat: t, since: 0 });
      burdens[h.burden] ??= 0;
      for (const id of h.grants) if (!a.abilities.includes(id) && findAbility(this.spec, id)) a.abilities.push(id);
    }
    if (Object.keys(burdens).length) a.burdens = burdens;
  }

  // ---------- 阵营：配给与派遣（设计 §4.8）----------
  factionOf(this: Town, a: LiveAgent) { return (this.spec.factions || []).find((f) => (f.members || []).includes(a.id)) || null; }

  stipendTick(this: Town) {
    const st = this.darkState;
    for (const f of this.spec.factions || []) {
      if (!f.stipend) continue;
      const { every, ...items } = f.stipend;
      const last = (st.stipendAt ||= {})[f.id];
      if (last == null) { st.stipendAt[f.id] = this.t; continue; }
      if (this.t - last < every) continue;
      st.stipendAt[f.id] = this.t;
      const got = [];
      for (const id of f.members || []) {
        const a = this.byId[id];
        if (!a || !this.agents.includes(a)) continue;
        for (const [k, n] of Object.entries(items)) a.inventory[k] = Math.min(99, (a.inventory[k] || 0) + n);
        got.push(a.name);
      }
      if (got.length) this.log('faction', `📦 ${f.name}给${got.join('、')}发下了${Object.entries(items).map(([k, n]) => `${this.spec.items[k]?.name || k}×${n}`).join('、')}`, {});
    }
  }

  /** 派遣：阵营把某人派去某个事件；去不去由这个人自己决定（重新盘算日程） */
  dispatch(this: Town, a: LiveAgent, incId: string, by: LiveAgent | null = null) {
    const inc = this.darkState.incidents.find((x) => x.id === incId || x.loc === incId);
    if (!a || !inc) return false;
    if (!inc.assigned.includes(a.id)) inc.assigned.push(a.id);
    const f = this.factionOf(a);
    const threat = this.spec.threats?.[inc.type]?.name || '怪事';
    const news = `${f ? f.name : '上面'}${by ? `（${by.name}）` : ''}派你去${this.locName(inc.loc)}处理「${threat}」的事`;
    this.log('dispatch', `📜 ${f ? f.name : ''}派${a.name}去${this.locName(inc.loc)}`, { agents: [a.id], incident: inc.id });
    this.replan(a, news).catch(() => {});
    return true;
  }

  // ---------- 反派（设计 §4.9）----------
  /** 每小时：欲望的压力累积，满了就逼他动手；满足转变门槛时转变立场（只由规则判定） */
  villainTick(this: Town) {
    for (const a of [...this.agents]) {
      const p = this.spec.personas.find((x) => x.id === a.id);
      if (!p || a.alignment !== 'villain') continue;
      if (p.redemption) {
        let ok = false;
        try { ok = testExpr(this, p.redemption, { self: a, e: a }); } catch { ok = false; }
        if (ok) {
          a.alignment = 'neutral';
          addMemory(a, { t: this.t, type: 'obs', text: '心里有什么东西松动了，也许我不必再这样下去', importance: 9 });
          this.log('growth', `🌱 ${a.name}动摇了，不再与大家为敌`, { agents: [a.id] });
          continue;
        }
      }
      for (const d of p.drives || []) {
        const pr = (a.pressure ||= {});
        pr[d.text] = (pr[d.text] || 0) + (d.perDay ?? 25) / 24;
        if (pr[d.text] < 100) continue;
        pr[d.text] = 0;
        this.replan(a, `心里的欲望压不住了：${d.text}。今天一定要有所行动`).catch(() => {});
      }
    }
  }

  darkHourly(this: Town) {
    const hour = Math.floor(this.t / 60);
    const st = this.darkState;
    if (st.agentHour === hour) return;
    const first = st.agentHour == null;
    st.agentHour = hour;
    if (first) return;
    this.burdenTick();
    this.stipendTick();
    this.villainTick();
    this.captiveTick?.();
  }

  // ---------- 提示词 ----------
  /** 写进居民人设块的黑暗叙事部分：立场、欲望、负担值、寄宿、被标记的迹象、禁忌姿态 */
  darkPersonaBlock(this: Town, a: LiveAgent) {
    const out = [];
    const p = this.spec.personas.find((x) => x.id === a.id);
    if (a.alignment === 'villain') out.push(`立场：你和其他人的目标是冲突的${p?.drives?.length ? `（${p.drives.map((d) => d.text).join('；')}）` : ''}。你不会因为一次友善的对话就改变主意，也不会无缘无故放弃。`);
    for (const [id, v] of Object.entries(a.burdens || {})) {
      const def = this.spec.burdens?.[id];
      if (!def) continue;
      const hi = (def.moodAt || []).filter(([th]) => v >= th).at(-1);
      out.push(`${def.name}：${Math.round(v)}/${def.max ?? 100}${hi ? `（${def.selfText || `你感觉自己越来越${hi[1]}`}）` : ''}`);
    }
    if (a.hosted?.length) out.push(`你身上寄宿着：${a.hosted.map((h) => this.spec.threats?.[h.threat]?.name || h.threat).join('、')}。借用它的力量会让负担加重。`);
    const signs = (a.marks || []).map((m) => m.sign).filter(Boolean);
    if (signs.length) out.push(`最近总觉得不对劲：${[...new Set(signs)].join('；')}`);
    if (a.posture && a.posture.until > this.t) out.push(`你正刻意保持：${a.posture.holds.map((h) => (POSTURE_NAMES as Record<string, string>)[h] || h).join('、')}`);
    if (a.captive) out.push(`你被${this.byId[a.captive.by]?.name || '人'}关了起来，等着有人来救。`);
    return out.length ? `\n${out.join('\n')}` : '';
  }

  /** 写进规划提示的行动说明（actionBlock 的补充） */
  darkActionBlock(this: Town, a: LiveAgent) {
    const spec = this.spec;
    const lines = [];
    if (Object.keys(spec.threats || {}).length) {
      lines.push(`{"type":"taboo","hold":["${Object.keys(POSTURE_NAMES).join('","')}"],"until":"HH:MM"} 刻意保持某些禁忌（${Object.entries(POSTURE_NAMES).map(([k, v]) => `${k}=${v}`).join('，')}），用来躲开你认为危险的东西；代价是闭眼走得慢、不说话就没法商量`);
      const containers = new Set(Object.values(spec.threats!).flatMap((t) => ((t.counters || []) as Array<{ type: string; with: string }>).filter((c) => c.type === 'contain').map((c) => c.with)));
      if ([...containers].some((k) => a.inventory[k])) lines.push('{"type":"contain","threat":"要收容的东西的名字"} 在它身边用容器把它收起来（先压住它才稳妥，否则很可能失手并被它盯上）');
      lines.push('{"type":"hunt","threat":"名字"} 去找它、和它正面交手（有的东西杀不死，只能拖住）');
    }
    const usable = Object.keys(a.inventory).filter((k) => spec.items[k]?.use);
    if (usable.length) lines.push(`{"type":"useItem","item":"${usable.join('/')}"} 使用身上的物品（${usable.map((k) => `${spec.items[k].name}：${spec.items[k].desc || ''}`).join('；')}）`);
    if (this.canBeHostile()) {
      lines.push(`{"type":"attack","target":"姓名","intent":"subdue/drive_off${lethal(spec.meta.rating) ? '/kill' : ''}"} 攻击某人（只有在对方是你的敌人、你恨他或者你是反派时才会这么做）`);
      lines.push('{"type":"steal","item":"物品id","from":"姓名"} 偷别人身上的东西；{"type":"threaten","target":"姓名","demand":"≤30字"} 威胁别人');
      if (this.agents.some((o) => o.captive)) lines.push('{"type":"rescue","target":"姓名"} 去把被关起来的人救出来');
    }
    const f = this.factionOf(a);
    if (f?.head === a.id && (f.authority || []).includes('dispatch')) {
      const open = this.darkState.incidents.filter((i) => ['omen', 'outbreak', 'spread'].includes(i.stage));
      if (open.length) lines.push(`{"type":"dispatch","who":"姓名","incident":"${open.map((i) => i.loc).join('/')}"} 以${f.name}的名义派人去处理某处的怪事`);
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  canBeHostile(this: Town) { return hostileWorld(this.spec); }

  hasPosture(this: Town, a: LiveAgent, name: string) { return hasPosture(this, a, name); }
}

export const POSTURE_NAMES = { eyesClosed: '闭着眼', silent: '不出声', noOpen: '不开门', stayLit: '待在亮处', notAlone: '不落单' };
