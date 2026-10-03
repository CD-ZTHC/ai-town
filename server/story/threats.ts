// 规律型威胁（黑暗叙事设计 §4.1~§4.3、§4.6、§4.7）：按规律杀人的东西，以及围绕它们发生的事件。
// 只有世界包声明了 threats 时才运行。规律判定、标记、应验都按规则结算，不调用 LLM；
// 规律本身（rule）从不进入任何提示词，居民只能通过线索形成自己的看法（信念）。
import { findPath } from '../world.ts';
import { addMemory, parseHM } from '../memory.ts';
import { runEffects, posOf, agentsNear } from '../kernel/effects.ts';
import type { Pos } from '../kernel/effects.ts';
import { testExpr } from '../kernel/rules.ts';
import { ratingAtLeast } from '../kernel/ratings.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { ThreatType } from '../types/spec.ts';
import type { DarkState, Incident, ThreatInstance } from '../types/town.ts';
import type { Cell } from '../types/map.ts';

const MAX_THREATS = 16;
const SOUND_WINDOW = 12; // 声音保留的游戏分钟
const ESCALATE_DAYS = 2; // 事件放着不管，多少天升级一次
const STAGE_NAMES: Record<string, string> = { omen: '征兆', outbreak: '爆发', spread: '扩散', handled: '处置', abandoned: '放弃', aftermath: '余波' };
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const dist = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.y - b.y);

export function freshDark(): DarkState {
  return { seq: 0, threats: [], sounds: [], zones: [], incidents: [], contained: [], population: {}, deaths: [], crowd: [], graves: [], lastMinute: -1, lastHour: -1, lastDay: -1 };
}

export class ThreatSystem {
  declare town: Town;
  declare random: () => number;
  constructor(town: Town, { random = town.rng }: { random?: () => number } = {}) { this.town = town; this.random = random; }

  get st(): DarkState { return (this.town.dark ||= freshDark()); }
  get enabled(): boolean { return Object.keys(this.town.spec.threats || {}).length > 0; }
  def(inst: ThreatInstance | null | undefined): ThreatType | null { return this.town.spec.threats?.[inst?.type as string] || null; }
  live(): ThreatInstance[] { return this.st.threats.filter((x) => !['contained', 'gone'].includes(x.state)); }
  find(ref: unknown): ThreatInstance | null {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    return this.live().find((x) => x.id === s || x.type === s || x.name === s || s.includes(x.name)) || null;
  }
  rnd(lo: number, hi: number): number { return lo + this.random() * (hi - lo); }
  pick<T>(list: readonly T[]): T { return list[Math.floor(this.random() * list.length)]; }

  // ---------- 开局：人口（群众只记数字，设计 §4.10）与世界包里的初始事件 ----------
  init(): void {
    const pop = this.st.population;
    for (const [id, n] of Object.entries(this.town.spec.population || {})) if (!pop[id]) pop[id] = { alive: n, dead: 0 };
    if (!this.enabled || this.st.seeded) return;
    this.st.seeded = true;
    for (const s of this.town.spec.incidents?.start || []) this.spawn(s.threat, { loc: s.at || null, cause: 'start', quiet: true });
  }

  // ---------- 出现 ----------
  /** 在某处出现一个威胁。at：坐标（可带 region）；loc：地点 id；都没有时在它常出没的地点。返回实例或 null */
  spawn(type: string, { at = null, loc = null, cause = '', incident = null, quiet = false }: { at?: (Cell & { region?: string }) | null; loc?: string | null; cause?: string; incident?: string | null; quiet?: boolean } = {}): ThreatInstance | null {
    const town = this.town;
    const def = town.spec.threats?.[type];
    if (!def || this.st.threats.filter((x) => !['contained', 'gone'].includes(x.state)).length >= MAX_THREATS) return null;
    if (def.minRating && !ratingAtLeast(town.spec.meta.rating, def.minRating)) return null;
    const home = loc || this.pick(def.haunt);
    const p = at || this.spotOf(home) || town.locCenter(home);
    if (!p) return null;
    const inst: ThreatInstance = {
      id: `th${++this.st.seq}`, type, name: def.name, x: p.x, y: p.y, region: at?.region || town.locRegion(home) || 'town',
      path: [], state: 'roam', hp: def.mortal ? def.hp! : null, born: Math.floor(town.t), restUntil: 0, dwellUntil: 0, suppressedUntil: 0, sounds: {}, crowdAt: town.t,
    };
    this.st.threats.push(inst);
    if (def.zone) this.st.zones.push({ id: `z${inst.id}`, threat: inst.id, x: p.x, y: p.y, r: def.zone.radius, region: inst.region, tint: def.zone.tint || '#5a2340', replay: def.zone.replay || null, born: Math.floor(town.t) });
    inst.incident = incident || this.openIncident(inst, home, cause).id;
    if (!quiet) town.log('threat', `${def.emoji} ${town.locName(home)}一带出现了异样……`, { threat: inst.id });
    town.emit('story');
    return inst;
  }

  spotOf(locId: string): Cell | null {
    const l = this.town.findLocation(locId);
    return l?.spots?.length ? { ...this.pick(l.spots) } : null;
  }

  // ---------- 每次推进 ----------
  tick(dt: number): void {
    if (!this.enabled) return;
    const st = this.st;
    for (const inst of this.live()) this.move(inst, dt);
    const minute = Math.floor(this.town.t);
    if (minute === st.lastMinute) return;
    st.lastMinute = minute;
    this.minuteTick();
    const hour = Math.floor(this.town.t / 60);
    if (hour !== st.lastHour) { st.lastHour = hour; this.hourTick(); }
    if (this.town.day !== st.lastDay) { const first = st.lastDay < 0; st.lastDay = this.town.day; if (!first) this.dayTick(); }
  }

  active(def: ThreatType): boolean {
    if (!def.active) return true;
    const [a, b] = def.active.map(parseHM) as [number, number];
    const m = this.town.minute;
    return a <= b ? m >= a && m <= b : m >= a || m <= b;
  }

  minuteTick(): void {
    const town = this.town;
    const st = this.st;
    st.sounds = st.sounds.filter((s) => town.t - s.t <= SOUND_WINDOW);
    for (const inst of this.live()) {
      const def = this.def(inst);
      if (!def) { inst.state = 'gone'; continue; }
      if (inst.state === 'suppressed' && town.t >= inst.suppressedUntil) { inst.state = 'roam'; town.log('threat', `${def.emoji} 被压住的${def.name}又动了起来`, { threat: inst.id }); }
      const awake = this.active(def);
      if (inst.state === 'roam' && !awake) inst.state = 'dormant';
      else if (inst.state === 'dormant' && awake) inst.state = 'roam';
      if (inst.state !== 'roam') continue;
      this.emitSounds(inst, def);
      if (def.rule && town.t >= inst.restUntil) this.evaluate(inst, def);
      if (def.crowd && town.t - inst.crowdAt >= def.crowd.every / this.escalation(inst)) this.crowdStrike(inst, def);
    }
    this.dueMarks();
    this.containTick();
  }

  hourTick(): void {
    const town = this.town;
    // 化解：条件满足的威胁永久消散
    for (const inst of this.live()) {
      const c = (this.def(inst)?.counters || []).find((x) => x.type === 'resolve');
      if (!c) continue;
      let ok = false;
      try { ok = testExpr(town, c.when, { threat: inst }); } catch (e) { console.warn(`[threat] ${inst.type} 的化解条件出错：`, (e as Error).message); }
      if (ok) this.end(inst, 'resolved', c.text || `${inst.name}消散了`);
    }
  }

  dayTick(): void {
    const town = this.town;
    // 收容的威胁每天有一定概率泄漏
    for (const c of [...this.st.contained]) {
      if (this.random() >= (c.leak || 0)) continue;
      this.st.contained = this.st.contained.filter((x) => x !== c);
      const holder = town.byId[c.holder];
      const at = holder && town.agents.includes(holder) ? posOf(town, holder) : null;
      const inst = this.spawn(c.type, { at, cause: 'leak', quiet: true });
      if (inst) town.log('threat', `💥 ${holder?.name ? `${holder.name}保管的` : ''}${c.item ? town.spec.items[c.item]?.name || '容器' : '容器'}开裂了，里面的${inst.name}跑了出来`, { threat: inst.id, agents: holder ? [holder.id] : [] });
    }
    // 太久没有事：按世界包的 incidents.autoEveryDays 让一个还没出现过的威胁出现（没有模型时也有故事）
    const every = town.spec.incidents?.autoEveryDays;
    const open = this.st.incidents.some((i) => ['omen', 'outbreak', 'spread'].includes(i.stage));
    if (open) this.st.quietSince = town.day;
    else if (every && town.day - (this.st.quietSince ?? town.day) >= every) {
      const live = new Set(this.live().map((x) => x.type));
      const pool = Object.keys(town.spec.threats!).filter((k) => !live.has(k));
      if (pool.length) { this.spawn(this.pick(pool), { cause: 'auto' }); this.st.quietSince = town.day; }
    }
    // 事件放着不管就升级：区域变大、群众伤亡加快
    for (const inc of this.st.incidents) {
      if (!['omen', 'outbreak', 'spread'].includes(inc.stage)) continue;
      if (town.day - (inc.touched ?? inc.day) < ESCALATE_DAYS) continue;
      inc.touched = town.day;
      inc.level = (inc.level || 1) + 1;
      const from = inc.stage;
      if (inc.stage !== 'spread') inc.stage = 'spread';
      const z = this.st.zones.find((x) => x.threat === inc.threat);
      const def = town.spec.threats?.[inc.type];
      if (z && def?.zone?.grow) z.r = Math.min(20, z.r + def.zone.grow);
      town.log('incident', `⚠️ ${town.locName(inc.loc)}的怪事没有人处理，正在蔓延${from !== 'spread' ? '（事件进入「扩散」）' : ''}`, { incident: inc.id });
    }
  }

  // ---------- 移动 ----------
  goTo(inst: ThreatInstance, x: number, y: number): void {
    const w = this.town.worldOf?.(inst.region) || this.town.world;
    inst.path = findPath(w, inst.x, inst.y, Math.round(x), Math.round(y)) || [{ x, y }];
  }

  move(inst: ThreatInstance, dt: number): void {
    const town = this.town;
    const def = this.def(inst);
    if (!def || inst.state === 'suppressed' || town.engaged?.('threat', inst.id)) { inst.path = []; return; }
    // 怕的东西（ward）：离开它的范围
    const ward = this.wardNear(inst, def);
    if (ward && !inst.fleeing) {
      inst.fleeing = true;
      const home = this.spotOf(def.haunt[0]) || { x: inst.x + 4, y: inst.y };
      this.goTo(inst, home.x, home.y);
    }
    if (!inst.path.length && town.t >= inst.dwellUntil) { inst.fleeing = false; this.choose(inst, def); }
    let d = (def.speed ?? 1.5) * dt;
    while (d > 0 && inst.path.length) {
      const n = inst.path[0];
      const dd = Math.hypot(n.x - inst.x, n.y - inst.y);
      if (dd <= d) { inst.x = n.x; inst.y = n.y; inst.path.shift(); d -= dd; } else { inst.x += ((n.x - inst.x) / dd) * d; inst.y += ((n.y - inst.y) / dd) * d; d = 0; }
    }
  }

  choose(inst: ThreatInstance, def: ThreatType): void {
    const town = this.town;
    const mode = def.movement || 'wander';
    inst.dwellUntil = town.t + 15 + this.random() * 30;
    if (mode === 'stationary') return;
    if (mode === 'stalk_marked' && inst.state === 'roam') {
      const prey = town.agents.filter((a) => (a.marks || []).some((m) => m.threat === inst.id) && (a.region || 'town') === inst.region)
        .map((a) => ({ a, p: posOf(town, a)! })).sort((p, q) => dist(p.p, inst) - dist(q.p, inst))[0];
      if (prey) { this.goTo(inst, prey.p.x, prey.p.y); inst.dwellUntil = town.t + 5; return; }
    }
    const i = mode === 'patrol' ? ((inst.patrol = (((inst.patrol as number | undefined) ?? -1) + 1) % def.haunt.length)) : Math.floor(this.random() * def.haunt.length);
    const s = this.spotOf(def.haunt[i]) || town.locCenter(def.haunt[i]);
    if (s && town.locRegion(def.haunt[i]) === inst.region) this.goTo(inst, s.x, s.y);
  }

  /** 附近有没有它怕的构筑物（counters 里的 ward） */
  wardNear(inst: ThreatInstance, def: ThreatType, at: Cell = inst) {
    const wards = (def.counters || []).filter((c) => c.type === 'ward');
    if (!wards.length) return null;
    return this.town.entities.find((e) => wards.some((c) => c.with === e.type && dist(e, at) <= (c.radius ?? 3)) && (e.region || 'town') === inst.region) || null;
  }

  emitSounds(inst: ThreatInstance, def: ThreatType): void {
    for (const s of def.sounds || []) {
      if (this.town.t - (inst.sounds[s.id] ?? -999) < s.every) continue;
      inst.sounds[s.id] = this.town.t;
      const snd = { id: s.id, x: inst.x, y: inst.y, r: s.radius ?? 5, region: inst.region, t: this.town.t, src: inst.id };
      this.st.sounds.push(snd);
      if (s.text) for (const a of this.town.agents) if (a.kind !== 'creature' && (a.region || 'town') === inst.region && dist(posOf(this.town, a)!, snd) <= snd.r && a.status !== 'sleeping') addMemory(a, { t: this.town.t, type: 'obs', text: s.text, importance: 3 });
    }
  }

  // ---------- 规律：判定、标记、应验 ----------
  /** 规律能碰到的人：同一区域、在它附近（reach）或在它的区域里；有它怕的东西护着的人不算 */
  candidates(inst: ThreatInstance, def: ThreatType): LiveAgent[] {
    const town = this.town;
    const zone = this.st.zones.find((z) => z.threat === inst.id);
    // 划成封锁区之后：只碰得到走进区域（没有区域时是身边 4 格）的人
    const reach = inst.confined ? (zone ? 0 : 4) : def.rule?.reach ?? 12;
    return town.agents.filter((a) => {
      if (a.kind === 'creature' || a.status === 'dead' || (a.region || 'town') !== inst.region) return false;
      if ((a.hosted || []).some((h) => h.threat === inst.type)) return false;
      const p = posOf(town, a)!;
      if (dist(p, inst) > reach && !(zone && dist(p, zone) <= zone.r)) return false;
      return !this.wardNear(inst, def, p);
    });
  }

  evaluate(inst: ThreatInstance, def: ThreatType): void {
    const town = this.town;
    for (const a of this.candidates(inst, def)) {
      if ((a.marks || []).some((m) => m.threat === inst.id)) continue;
      let hit = false;
      try {
        hit = testExpr(town, def.rule!.trigger, { e: a, self: a, threat: inst }) && !(def.rule!.unless && testExpr(town, def.rule!.unless, { e: a, self: a, threat: inst }));
      } catch (e) {
        console.warn(`[threat] ${inst.type} 的规律出错，已停用：`, (e as Error).message);
        inst.state = 'gone';
        return;
      }
      if (hit) this.mark(inst, def, a);
    }
  }

  mark(inst: ThreatInstance, def: ThreatType, a: LiveAgent, delay: [number, number] = def.rule!.mark.delay): void {
    const town = this.town;
    const due = town.t + this.rnd(delay[0], delay[1]);
    (a.marks ||= []).push({ threat: inst.id, type: inst.type, t: Math.floor(town.t), due, sign: def.rule!.mark.sign || '' });
    if (def.rule!.mark.sign) addMemory(a, { t: town.t, type: 'omen', text: `心里一阵发毛：${def.rule!.mark.sign}`, importance: 6 });
    town.log('mark', `👁️ ${a.name}${def.rule!.mark.sign ? `察觉到：${def.rule!.mark.sign}` : '身上发生了什么，自己却没有察觉'}`, { agents: [a.id], threat: inst.id });
    this.touch(inst);
    town.emit('agent', a.id);
  }

  dueMarks(): void {
    const town = this.town;
    for (const a of [...town.agents]) {
      if (!a.marks?.length) continue;
      for (const m of [...a.marks]) {
        if (m.due > town.t) continue;
        const inst = this.st.threats.find((x) => x.id === m.threat);
        const def = this.def(inst);
        if (!inst || !def || ['contained', 'gone'].includes(inst.state)) { a.marks = a.marks.filter((x) => x !== m); continue; }
        // 被压住的威胁：应验推迟
        if (inst.state === 'suppressed') { m.due = town.t + 10; continue; }
        a.marks = a.marks.filter((x) => x !== m);
        this.fulfil(inst, def, a);
        if (!town.agents.includes(a)) break;
      }
    }
  }

  fulfil(inst: ThreatInstance, def: ThreatType, a: LiveAgent): 'spared' | 'hosted' | 'failed' | 'struck' {
    const town = this.town;
    const b = { e: a, self: a, threat: inst };
    let spared = false;
    try { spared = Boolean(def.rule!.unless) && testExpr(town, def.rule!.unless, b); } catch { spared = false; }
    if (spared) {
      addMemory(a, { t: town.t, type: 'obs', text: `那东西找上门来，又停住了——我逃过了一劫。${this.pick(def.clues)}，也许就是这个原因`, importance: 8 });
      this.believe(a, def, this.pick(def.clues), 0.85);
      town.log('survive', `🫣 ${a.name}逃过了一劫`, { agents: [a.id], threat: inst.id });
      return 'spared';
    }
    // 寄宿：濒死之际，有人反过来成了它的宿主
    for (const v of def.hostable?.via || []) {
      let ok = false;
      try { ok = testExpr(town, v.when || 'true', b); } catch { ok = false; }
      if (!ok) continue;
      if (this.random() < v.p) { town.hostThreat?.(a, inst.type, inst); return 'hosted'; }
      if (v.fail) runEffects(town, { self: a, target: a, e: a, at: posOf(town, a), source: `threat:${inst.type}`, threat: inst }, v.fail);
      if (!town.agents.includes(a)) return 'failed';
    }
    const where = posOf(town, a);
    const seen = this.witnesses(inst, a, where);
    runEffects(town, { self: a, target: a, e: a, at: where, source: `threat:${inst.type}`, threat: inst }, def.rule!.outcome);
    inst.restUntil = town.t + (def.rule!.rest ?? 60);
    const inc = this.incidentOf(inst);
    if (inc) { inc.victims = (inc.victims || 0) + 1; if (inc.stage === 'omen') this.stage(inc, 'outbreak'); if (inc.victims >= 3 && inc.stage === 'outbreak') this.stage(inc, 'spread'); }
    this.giveWitnessClues(def, a, seen);
    this.touch(inst);
    return 'struck';
  }

  /** 在场的人：同一栋楼里，或都在户外、6 格以内 */
  witnesses(inst: ThreatInstance, a: LiveAgent, at: Pos | null): LiveAgent[] {
    return agentsNear(this.town, at, 6, a).filter((o) => o.kind !== 'creature');
  }

  giveWitnessClues(def: ThreatType, victim: LiveAgent, seen: LiveAgent[]): void {
    const town = this.town;
    for (const o of seen) {
      addMemory(o, { t: town.t, type: 'event', text: `亲眼看见${victim.name}出了事，那一幕怎么也忘不掉`, importance: 8 });
      o.body.courage = clamp(o.body.courage - 15, 0, 100);
      o.body.conditions = [...new Set([...o.body.conditions, '受惊'])].slice(-5);
      // 目击者记住的是死者死前做过的事：可能是真正的规律，也可能只是巧合
      const real = !def.decoys?.length || this.random() < 0.55;
      this.believe(o, def, real ? this.pick(def.clues) : this.pick(def.decoys!), real ? 0.55 : 0.5);
    }
  }

  /** 对某个威胁的看法（信念）：只在新的看法更确信时覆盖旧的 */
  believe(a: LiveAgent, def: ThreatType, claim: string, confidence: number): boolean {
    const about = def.name.slice(0, 12);
    const mine = a.beliefs.find((b) => b.about === about);
    if (mine && mine.confidence > confidence && mine.claim !== claim) return false;
    this.town.setBelief(a, { about, claim, confidence, source: 'clue' });
    return true;
  }

  /** 线索（设计 §4.2）：rule 规律；next_victim 下一个会出事的人；origin 来历 */
  giveClue(a: LiveAgent, kind: string, type: string | null = null, ctx: { confidence?: number } = {}): string | null {
    const town = this.town;
    const pool = type ? [type] : [...new Set(this.live().map((x) => x.type))];
    const defs = pool.map((t) => [t, town.spec.threats?.[t]] as const).filter(([, d]) => d) as Array<readonly [string, ThreatType]>;
    if (kind === 'next_victim') {
      const marked = town.agents.flatMap((x) => (x.marks || []).filter((m) => !type || m.type === type).map((m) => ({ x, due: m.due }))).sort((p, q) => p.due - q.due)[0];
      if (!marked) { addMemory(a, { t: town.t, type: 'omen', text: '纸上的字迹模糊，这一次没有写出任何名字', importance: 5 }); return null; }
      addMemory(a, { t: town.t, type: 'omen', text: `纸上浮现出一个名字：${marked.x.name}。下一个会出事的，是${marked.x.name}`, importance: 9 });
      town.setBelief(a, { about: '下一个', claim: `${marked.x.name}会出事`, confidence: 0.9, source: 'clue' });
      town.log('clue', `📓 ${a.name}得知了下一个会出事的人`, { agents: [a.id] });
      return marked.x.name;
    }
    if (!defs.length) return null;
    const [, def] = this.pick(defs);
    if (kind === 'origin') {
      if (!def.origin) return null;
      addMemory(a, { t: town.t, type: 'obs', text: `查到了${def.name}的来历：${def.origin}`, importance: 8 });
      town.setBelief(a, { about: `${def.name.slice(0, 8)}来历`, claim: def.origin.slice(0, 40), confidence: 0.8, source: 'clue' });
      town.log('clue', `🔎 ${a.name}查到了${def.name}的来历`, { agents: [a.id] });
      return def.origin;
    }
    const clue = this.pick(def.clues);
    addMemory(a, { t: town.t, type: 'obs', text: `关于${def.name}，我想明白了一点：${clue}`, importance: 7 });
    this.believe(a, def, clue, ctx.confidence ?? 0.75);
    town.log('clue', `🔎 ${a.name}摸到了${def.name}的一条线索`, { agents: [a.id] });
    return clue;
  }

  /** 研究（actions.finishResearch 调用）：在事发地点或资料地点研究威胁，得到规律或来历线索 */
  research(a: LiveAgent, r: { topic?: string; loc: string | null }): boolean {
    const town = this.town;
    const topic = String(r.topic || '');
    for (const inst of this.live()) {
      const def = this.def(inst)!;
      const zone = this.st.zones.find((z) => z.threat === inst.id);
      const inZone = zone && dist(posOf(town, a)!, zone) <= zone.r;
      const where = inZone || def.haunt.includes(r.loc!) || (def.research || []).includes(r.loc!);
      const about = topic.includes(def.name) || /规律|怪事|死因|凶手|怎么死|来历|身世|过去/.test(topic);
      if (!where || !about) continue;
      const origin = /来历|身世|过去|生前/.test(topic) || (inZone && zone.replay);
      if (origin && def.origin) {
        if (inZone && zone.replay) addMemory(a, { t: town.t, type: 'obs', text: `在那片地方，眼前又重演了「${zone.replay}」`, importance: 7 });
        this.giveClue(a, 'origin', inst.type);
      } else this.giveClue(a, 'rule', inst.type, { confidence: 0.7 });
      this.touch(inst);
      return true;
    }
    return false;
  }

  // ---------- 群众伤亡 ----------
  escalation(inst: ThreatInstance): number { return this.incidentOf(inst)?.level || 1; }

  crowdStrike(inst: ThreatInstance, def: ThreatType): void {
    const town = this.town;
    inst.crowdAt = town.t;
    const level = this.escalation(inst);
    const [lo, hi] = def.crowd!.kills;
    const n = Math.round(this.rnd(lo, hi) * (1 + (level - 1) * 0.5));
    if (n > 0) town.casualties?.(inst, n, { cause: `threat:${inst.type}`, text: `${def.name}又带走了人` });
    const inc = this.incidentOf(inst);
    if (inc && n > 0) { inc.crowd = (inc.crowd || 0) + n; if (inc.stage === 'omen') this.stage(inc, 'outbreak'); }
  }

  // ---------- 对抗方式（设计 §4.3）----------
  suppressNear(at: (Cell & { region?: string }) | null | undefined, power: number, minutes: number, radius: number, by: LiveAgent | null = null): number {
    const town = this.town;
    if (!at) return 0;
    let n = 0;
    for (const inst of this.live()) {
      if (inst.region !== (at.region || 'town') || dist(inst, at) > radius) continue;
      const def = this.def(inst)!;
      const c = (def.counters || []).find((x) => x.type === 'suppress');
      if (!c) { town.log('threat', `🌀 ${by?.name || '有人'}想压住${def.name}，可它根本不吃这一套`, { agents: by ? [by.id] : [], threat: inst.id }); continue; }
      if (power < (c.power ?? 1)) { town.log('threat', `🌀 ${by?.name || '有人'}想压住${def.name}，力量不够`, { agents: by ? [by.id] : [], threat: inst.id }); continue; }
      inst.state = 'suppressed';
      inst.suppressedUntil = Math.max(inst.suppressedUntil, town.t + minutes);
      inst.path = [];
      town.log('threat', `⛓️ ${by?.name || '有人'}压住了${def.name}`, { agents: by ? [by.id] : [], threat: inst.id });
      this.touch(inst);
      n++;
    }
    return n;
  }

  damageNear(at: (Cell & { region?: string }) | null | undefined, amount: number, tags: string[] = [], radius = 3, by: LiveAgent | null = null): number {
    const town = this.town;
    if (!at) return 0;
    const inst = this.live().filter((x) => x.region === (at.region || 'town') && dist(x, at) <= radius).sort((p, q) => dist(p, at) - dist(q, at))[0];
    if (!inst) return 0;
    return this.hit(inst, amount, tags, by);
  }

  /** 攻击一个威胁：会死的扣血，杀不死的只会停顿（有 delay 对抗方式时） */
  hit(inst: ThreatInstance, amount: number, tags: string[] = [], by: LiveAgent | null = null): number {
    const town = this.town;
    const def = this.def(inst)!;
    if (!def.mortal) {
      if ((def.counters || []).some((c) => c.type === 'delay')) {
        inst.state = 'suppressed';
        inst.suppressedUntil = Math.max(inst.suppressedUntil, town.t + 10);
        town.log('threat', `💥 ${by?.name || '有人'}的攻击让${def.name}停顿了一下`, { agents: by ? [by.id] : [], threat: inst.id });
      } else town.log('threat', `💥 ${by?.name || '有人'}的攻击对${def.name}毫无作用`, { agents: by ? [by.id] : [], threat: inst.id });
      return 0;
    }
    const weak = tags.some((t) => (def.weakness || []).includes(t));
    const dmg = Math.max(1, Math.round(amount * (weak ? 1.5 : 1) - (def.def || 0) * 0.5));
    inst.hp! -= dmg;
    this.touch(inst);
    if (inst.hp! <= 0) {
      for (const l of def.loot || []) if (by && this.random() < l.p) by.inventory[l.item] = Math.min(99, (by.inventory[l.item] || 0) + 1);
      this.end(inst, 'slain', `${by?.name || '有人'}消灭了${def.name}`, by);
    }
    return dmg;
  }

  /** 收容（居民行动 contain）：在它身边连续操作一段时间；被压住时一定成功，否则只有三成把握，失败会被它盯上 */
  startContain(a: LiveAgent, ref: unknown): { ok: boolean; reason?: string; retry?: boolean } {
    const town = this.town;
    const p = posOf(town, a)!;
    const inst = (ref ? [this.find(ref)].filter(Boolean) as ThreatInstance[] : this.live()).filter((x) => x.region === (p.region || 'town') && dist(x, p) <= 4).sort((x, y) => dist(x, p) - dist(y, p))[0];
    if (!inst) return { ok: false, reason: '身边没有可以收容的东西', retry: true };
    const def = this.def(inst)!;
    const c = (def.counters || []).find((x) => x.type === 'contain');
    if (!c) return { ok: false, reason: `${def.name}收不进任何东西里` };
    if ((a.inventory[c.with!] || 0) < 1) return { ok: false, reason: `身上没有${town.spec.items[c.with!]?.name || c.with}` };
    a.containing = { inst: inst.id, until: town.t + (c.time ?? 20), started: Math.floor(town.t) };
    a.action = { text: `收容${def.name}`, emoji: '📦' };
    town.log('threat', `📦 ${a.name}开始收容${def.name}`, { agents: [a.id], threat: inst.id });
    return { ok: true };
  }

  containTick(): void {
    const town = this.town;
    for (const a of town.agents) {
      const job = a.containing;
      if (!job) continue;
      const inst = this.st.threats.find((x) => x.id === job.inst);
      const p = posOf(town, a)!;
      if (!inst || ['contained', 'gone'].includes(inst.state)) { a.containing = null; continue; }
      if (dist(inst, p) > 5 || inst.region !== (p.region || 'town')) { a.containing = null; town.log('threat', `📦 ${a.name}的收容被打断了`, { agents: [a.id] }); continue; }
      if (town.t < job.until) continue;
      a.containing = null;
      const def = this.def(inst)!;
      const c = (def.counters || []).find((x) => x.type === 'contain')!;
      if ((a.inventory[c.with!] || 0) < 1) continue;
      const sure = inst.state === 'suppressed';
      if (!sure && this.random() >= 0.35) {
        if (def.rule) this.mark(inst, def, a, [5, 20]);
        town.log('threat', `📦 ${a.name}没能收住${def.name}，反而被它盯上了`, { agents: [a.id], threat: inst.id });
        continue;
      }
      a.inventory[c.with!] -= 1;
      if (!a.inventory[c.with!]) delete a.inventory[c.with!];
      if (c.yields) a.inventory[c.yields] = Math.min(99, (a.inventory[c.yields] || 0) + 1);
      this.st.contained.push({ type: inst.type, holder: a.id, since: Math.floor(town.t), leak: c.leak ?? 0, item: c.yields || c.with! });
      this.end(inst, 'contained', `${a.name}把${def.name}收进了${town.spec.items[c.yields || c.with!]?.name || '容器'}里`, a);
    }
  }

  /** 威胁结束：收容、消散（化解）、消灭。区域消失，事件进入处置 */
  end(inst: ThreatInstance, how: string, text: string, by: LiveAgent | null = null): void {
    const town = this.town;
    inst.state = how === 'contained' ? 'contained' : 'gone';
    inst.path = [];
    this.st.zones = this.st.zones.filter((z) => z.threat !== inst.id);
    for (const a of town.agents) if (a.marks?.length) a.marks = a.marks.filter((m) => m.threat !== inst.id);
    const inc = this.incidentOf(inst);
    if (inc) { inc.outcome = how; this.stage(inc, 'handled'); }
    const emoji = { contained: '📦', resolved: '✨', slain: '⚔️' }[how] || '•';
    town.log('threat', `${emoji} ${text}`, { agents: by ? [by.id] : [], threat: inst.id, result: how });
    if (how === 'resolved') town.worldFlags[`resolved_${inst.type}`] = true;
    if (by) addMemory(by, { t: town.t, type: 'obs', text, importance: 8 });
    // 被打死时的效果（世界包写的剧情：例如 Boss 倒下后天地开裂）
    const def = this.def(inst);
    if (how === 'slain' && def?.onSlain?.length) runEffects(town, { self: by, target: null, e: by, at: { x: inst.x, y: inst.y, inside: null, region: inst.region || 'town' }, source: `threat:${inst.type}`, threat: inst }, def.onSlain);
    try { town.applyWorldOp({ op: 'addCanon', args: { text: `第${town.day}天，${text}。`, tags: ['事件'] } }, { by: 'threat' }, { quiet: true }); } catch { /* 正典满了也不影响 */ }
    town.emit('story');
  }

  /** 宿主死亡：身上寄宿的威胁在原地脱出（效果 spawnThreat from host） */
  releaseHosted(a: LiveAgent): void {
    const town = this.town;
    const at = posOf(town, a);
    for (const h of a.hosted || []) {
      const inst = this.spawn(h.threat, { at: at && { x: at.x, y: at.y, region: at.region }, cause: 'host', quiet: true });
      if (inst) town.log('threat', `🌑 ${a.name}身上的${inst.name}脱了出来`, { agents: [a.id], threat: inst.id });
    }
    a.hosted = [];
  }

  // ---------- 事件（设计 §4.7）----------
  openIncident(inst: ThreatInstance, loc: string, cause = ''): Incident {
    const town = this.town;
    const inc: Incident = { id: `inc${++this.st.seq}`, threat: inst.id, type: inst.type, loc, stage: 'omen', day: town.day, touched: town.day, since: Math.floor(town.t), victims: 0, crowd: 0, level: 1, assigned: [], cause };
    this.st.incidents.push(inc);
    if (this.st.incidents.length > 60) this.st.incidents.shift();
    return inc;
  }

  incidentOf(inst: ThreatInstance | null | undefined): Incident | null | undefined { return inst && this.st.incidents.find((x) => x.id === inst.incident); }

  stage(inc: Incident, stage: string): void {
    if (inc.stage === stage) return;
    inc.stage = stage;
    inc.touched = this.town.day;
    if (stage !== 'handled') this.town.log('incident', `📍 ${this.town.locName(inc.loc)}的怪事进入「${STAGE_NAMES[stage]}」`, { incident: inc.id });
    this.town.emit('story');
  }

  /** 有人在处理（打、压、收、查）：事件的升级倒计时重新开始 */
  touch(inst: ThreatInstance): void {
    const inc = this.incidentOf(inst);
    if (inc) inc.touched = this.town.day;
  }

  /** 放弃一片区域（剧情动作 abandon）：划为封锁区，威胁只在区域里活动 */
  abandon(incId: string): boolean {
    const town = this.town;
    const inc = this.st.incidents.find((x) => x.id === incId || x.loc === incId);
    if (!inc || !['omen', 'outbreak', 'spread'].includes(inc.stage)) return false;
    this.stage(inc, 'abandoned');
    inc.outcome = 'abandoned';
    const inst = this.st.threats.find((x) => x.id === inc.threat);
    if (inst) inst.confined = true;
    const loc = town.findLocation(inc.loc);
    if (loc?.indoor) { try { town.applyWorldOp({ op: 'setBuildingState', args: { id: loc.indoor, state: 'closed' } }, { by: 'threat' }, { quiet: true }); } catch { /* 已经是这个状态 */ } }
    town.log('incident', `🚧 ${town.locName(inc.loc)}被划成了封锁区`, { incident: inc.id });
    try { town.applyWorldOp({ op: 'addCanon', args: { text: `第${town.day}天，${town.locName(inc.loc)}被划成了封锁区。`, tags: ['事件'] } }, { by: 'threat' }, { quiet: true }); } catch { /* 忽略 */ }
    return true;
  }

  // ---------- 视图 ----------
  view() {
    return {
      threats: this.live().filter((x) => x.state !== 'dormant').map((x) => {
        const def = this.def(x);
        return { id: x.id, type: x.type, name: x.name, emoji: def?.emoji || '👁️', x: +x.x.toFixed(2), y: +x.y.toFixed(2), region: x.region, state: x.state, ...(def?.mortal ? { hp: x.hp, maxHp: def.hp } : {}) };
      }),
      zones: this.st.zones.map((z) => ({ id: z.id, x: z.x, y: z.y, r: +z.r.toFixed(1), region: z.region, tint: z.tint })),
      graves: this.st.graves,
      // 群众（设计 §4.10）：各地还活着的人数，前端据此画出不接入模型的路人
      crowd: Object.fromEntries(Object.entries(this.st.population).map(([id, p]) => [id, p.alive])),
    };
  }

  panel() {
    const town = this.town;
    const pop = Object.entries(this.st.population).map(([id, p]) => ({ id, name: town.locName(id), alive: p.alive, dead: p.dead }));
    return {
      incidents: this.st.incidents.slice(-20).reverse().map((i) => ({ id: i.id, loc: i.loc, locName: town.locName(i.loc), stage: i.stage, stageName: STAGE_NAMES[i.stage], name: town.spec.threats?.[i.type]?.name || i.type, victims: i.victims || 0, crowd: i.crowd || 0, day: i.day, outcome: i.outcome || null, assigned: i.assigned.map((id) => town.byId[id]?.name || id) })),
      deaths: this.st.deaths.slice(-30).reverse(),
      population: pop,
      crowdDead: pop.reduce((s, p) => s + p.dead, 0),
      contained: this.st.contained.map((c) => ({ name: town.spec.threats?.[c.type]?.name || c.type, holder: town.byId[c.holder]?.name || c.holder, since: c.since })),
    };
  }
}
