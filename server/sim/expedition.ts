// 远征前线（docs/design/adventure.md §3.4）：一个区域接一个区域往外推。
// 阶段的状态、刷野怪、Boss 预告与出现、征服后的奖励与解锁都按规则结算，不调模型。
// 现在只允许一支远征（kernel/adventure-spec 的 MAX_EXPEDITIONS），但状态、事件都按远征 id 分开。
import { addMemory } from '../memory.ts';
import { runEffects } from '../kernel/effects.ts';
import { testExpr } from '../kernel/rules.ts';
import { expeditionsOf } from '../kernel/adventure-spec.ts';
import { parseHM } from '../memory.ts';
import { isNight } from './recovery.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { ExpeditionDef, ExpeditionStage } from '../types/spec.ts';
import type { ExpeditionState, StageState, StageStatus } from './adventure-state.ts';
import type { ThreatInstance } from '../types/town.ts';
import type { Cell } from '../types/map.ts';

const SPAWN_NEAR: [number, number] = [6, 10]; // 刷在队伍视野边缘
const CLEARED_SLOW = 3; // 已征服的区域刷新慢三倍
const BOSS_RETRY = 120; // Boss 没被打倒就消失了：多久之后再来

// ---------- 规则（只依赖显式输入） ----------
/** 新的远征进度：第一段是前线，其余锁着 */
export function freshExpedition(x: Pick<ExpeditionDef, 'stages'>, t: number): ExpeditionState {
  const stages: Record<string, StageState> = {};
  x.stages.forEach((s, i) => { stages[s.id] = { status: i === 0 ? 'front' : 'locked', kills: 0, ...(i === 0 ? { openedAt: Math.floor(t) } : {}) }; });
  return { stages, front: x.stages[0]?.id || null, tokens: 0, spawnAt: {} };
}

/** 当前前线：按世界包里的顺序，第一个已开放、还没征服的阶段 */
export function frontOf(x: Pick<ExpeditionDef, 'stages'>, st: ExpeditionState): string | null {
  return x.stages.find((s) => { const k = st.stages[s.id]?.status; return k === 'open' || k === 'front'; })?.id || null;
}

/** 把 front 标记同步到阶段状态上（只有一个阶段是 front） */
export function markFront(x: Pick<ExpeditionDef, 'stages'>, st: ExpeditionState): void {
  const f = frontOf(x, st);
  for (const s of x.stages) { const ss = st.stages[s.id]; if (ss && (ss.status === 'open' || ss.status === 'front')) ss.status = s.id === f ? 'front' : 'open'; }
  st.front = f;
}

/** 越级时的经验折扣：比建议等级高 3 级以上减半，6 级以上只剩四分之一 */
export const overLevelMult = (level: number, hint: number | undefined): number => (!hint ? 1 : level - hint >= 6 ? 0.25 : level - hint >= 3 ? 0.5 : 1);

/** 在 (cx, cy) 周围 r0~r1 格的环上找一个走得通的格子（按给定的随机数，确定性） */
export function ringCell(w: { W: number; H: number; walk: ArrayLike<number | boolean> }, cx: number, cy: number, [r0, r1]: [number, number], rnd: () => number, tries = 24): Cell | null {
  for (let i = 0; i < tries; i++) {
    const ang = rnd() * Math.PI * 2, d = r0 + rnd() * (r1 - r0);
    const x = Math.round(cx + Math.cos(ang) * d), y = Math.round(cy + Math.sin(ang) * d);
    if (x >= 1 && y >= 1 && x < w.W - 1 && y < w.H - 1 && w.walk[y * w.W + x]) return { x, y };
  }
  return null;
}

// ---------- Town 上的接口 ----------
export class Expedition {
  expeditions(this: Town) { return expeditionsOf(this.spec); }

  /** 远征的进度（第一次用到时创建）；世界包后来新增的阶段按锁着补上 */
  expState(this: Town, x: ExpeditionDef & { id: string }): ExpeditionState {
    const all = this.adventureState().expeditions;
    let st = all[x.id];
    if (!st) {
      st = all[x.id] = freshExpedition(x, this.t);
      const first = x.stages[0];
      if (first && first.region !== 'town' && !this.regionOpen(first.region)) this.openRegion(first.region, true);
    }
    for (const s of x.stages) st.stages[s.id] ||= { status: 'locked', kills: 0 };
    return st;
  }

  /** 远征队伍的成员（在场的） */
  expeditionParty(this: Town, x: ExpeditionDef): LiveAgent[] {
    const lead = this.partyLeader(x.party);
    return lead ? this.partyMembers(lead) : [];
  }

  /** 有人在这个区域：远征队员或旅人化身（返回他们的位置） */
  presentIn(this: Town, region: string, x: ExpeditionDef): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (const a of this.expeditionParty(x)) if ((a.region || 'town') === region && !a.inside && a.status !== 'sleeping') out.push({ x: a.x, y: a.y });
    for (const v of this.avatars.list) if (v.region === region && (v.downUntil || 0) <= this.now()) out.push({ x: v.x, y: v.y });
    return out;
  }

  /** 每游戏分钟：各支远征刷怪、Boss、征服判定 */
  expeditionTick(this: Town) {
    for (const x of this.expeditions()) {
      const st = this.expState(x);
      const lead = this.partyLeader(x.party);
      for (const s of x.stages) {
        const ss = st.stages[s.id]!;
        if (ss.status === 'locked') continue;
        if (!this.regionActive(s.region)) continue;
        this.stageSpawns(x, s, ss, st, lead);
        if (ss.status !== 'cleared') { this.stageBoss(x, s, ss, lead); this.stageClear(x, s, ss, st, lead); }
      }
    }
  }

  stageSpawns(this: Town, x: ExpeditionDef & { id: string }, s: ExpeditionStage, ss: StageState, st: ExpeditionState, lead: LiveAgent | null) {
    if (!s.spawns?.length) return;
    const here = this.presentIn(s.region, x);
    if (!here.length) return;
    // 队长血不多时不刷，让队伍有机会撤
    if (lead && (lead.region || 'town') === s.region && lead.body.hp < this.recoveryCfg().resumeAt * this.maxHp(lead) * 0.75) return;
    s.spawns.forEach((sp, i) => {
      const key = `${s.id}:${i}`;
      const every = sp.every * (ss.status === 'cleared' ? CLEARED_SLOW : 1);
      if (this.t - (st.spawnAt[key] ?? -Infinity) < every) return;
      if (sp.when) { try { if (!testExpr(this, sp.when, { e: lead, self: lead })) return; } catch { return; } }
      const live = this.threats.live().filter((t) => t.type === sp.threat && (t.region || 'town') === s.region).length;
      st.spawnAt[key] = Math.floor(this.t);
      if (live >= sp.max) return;
      const near = here[Math.floor(this.rng() * here.length)]!;
      const at = this.wildSpot(s, near);
      if (at) this.threats.spawn(sp.threat, { at: { ...at, region: s.region }, cause: `expedition:${x.id}`, quiet: true, wild: true });
    });
  }

  /** 刷怪的位置：写了 wild 时取离队伍最近的野外地点里的一个站位，否则在队伍视野边缘 */
  wildSpot(this: Town, s: ExpeditionStage, near: { x: number; y: number }): Cell | null {
    const w = this.worldOf(s.region);
    const ring = ringCell(w, near.x, near.y, SPAWN_NEAR, this.rng);
    if (!s.wild?.length) return ring;
    // 野外地点的站位里，离队伍 5 格以外最近的几个（不贴脸刷）；都太近时在视野边缘
    const spots = s.wild.filter((id) => this.locRegion(id) === s.region).flatMap((id) => this.findLocation(id)?.spots || [])
      .map((p) => ({ p, d: Math.hypot(p.x - near.x, p.y - near.y) })).filter((x) => x.d >= SPAWN_NEAR[0] - 1).sort((a, b) => a.d - b.d).slice(0, 6);
    if (!spots.length) return ring;
    return spots[Math.floor(this.rng() * spots.length)]!.p;
  }

  stageBoss(this: Town, x: ExpeditionDef & { id: string }, s: ExpeditionStage, ss: StageState, lead: LiveAgent | null) {
    const b = s.boss;
    if (!b || ss.bossOut === true) {
      // 出现过、但没被打倒就不见了（被化解、跑掉）：过一阵子再来
      if (b && ss.bossOut && !this.threats.live().some((t) => t.type === b.threat && (t.region || 'town') === s.region) && this.t - (ss.bossAt ?? 0) > BOSS_RETRY && !ss.bossDown) { ss.bossOut = false; ss.bossAt = null; }
      return;
    }
    if (ss.bossAt == null) {
      let ready = true;
      if (b.after) { try { ready = testExpr(this, b.after, { e: lead, self: lead }); } catch { ready = false; } }
      if (!ready) return;
      const lead0 = b.foreshadow ?? this.spec.threats?.[b.threat]?.foreshadow?.lead ?? 0;
      ss.bossAt = Math.floor(this.t + lead0);
      if (lead0 > 0) this.announceForeshadow(b.threat, s.region, ss.bossAt, { exp: x.id, stage: s.id });
      return;
    }
    if (this.t < ss.bossAt || !this.presentIn(s.region, x).length) return;
    const def = this.spec.threats?.[b.threat];
    if (!def) return;
    const loc = b.at || def.haunt.find((h) => this.locRegion(h) === s.region) || null;
    const inst = this.threats.spawn(b.threat, { loc, cause: `expedition:${x.id}`, quiet: true, wild: true });
    if (!inst) return;
    ss.bossOut = true;
    ss.bossAt = Math.floor(this.t);
    this.clearForeshadow(b.threat, s.region);
    this.log('threat', `${def.emoji} ${def.name}出现在了${this.regions[s.region]?.name || s.region}`, { threat: inst.id, milestone: 'boss' });
  }

  stageClear(this: Town, x: ExpeditionDef & { id: string }, s: ExpeditionStage, ss: StageState, st: ExpeditionState, lead: LiveAgent | null) {
    let done = false;
    if (s.clear) { try { done = testExpr(this, s.clear, { e: lead, self: lead }); } catch { done = false; } }
    else done = Boolean(ss.bossDown);
    if (!done) return;
    ss.status = 'cleared';
    ss.clearedAt = Math.floor(this.t);
    if (x.tokens) st.tokens = Math.min(x.tokens.total, st.tokens + 1);
    const region = this.regions[s.region]?.name || s.region;
    if (s.reward?.length) runEffects(this, { self: lead, target: lead, e: lead, at: null, source: `expedition:${x.id}` }, s.reward);
    const opened: string[] = [];
    for (const id of s.unlock || []) {
      const ns = st.stages[id];
      const nd = x.stages.find((q) => q.id === id);
      if (!ns || !nd || ns.status !== 'locked') continue;
      ns.status = 'open';
      ns.openedAt = Math.floor(this.t);
      if (nd.region !== 'town' && !this.regionOpen(nd.region)) this.openRegion(nd.region, true);
      opened.push(id);
    }
    markFront(x, st);
    for (const m of this.expeditionParty(x)) addMemory(m, { t: this.t, type: 'event', text: `我们征服了${region}${opened.length ? `，前面的路打开了` : ''}`, importance: 8 });
    this.log('frontier', `🚩 「${s.title}」征服了${region}${opened.length ? `，通往${opened.map((id) => this.regions[x.stages.find((q) => q.id === id)!.region]?.name || id).join('、')}的路打开了` : ''}`, { milestone: 'cleared' });
    try { this.applyWorldOp({ op: 'addCanon', args: { text: `第${this.day}天，${region}被征服了。`, tags: ['远征'] } }, { by: 'expedition' }, { quiet: true }); } catch { /* 设定集满了 */ }
    this.emit('adv', { type: 'frontier', exp: x.id, stage: s.id, title: s.title, from: s.region, fromName: region,
      to: opened.map((id) => { const nd = x.stages.find((q) => q.id === id)!; return { stage: id, region: nd.region, name: this.regions[nd.region]?.name || nd.region, title: nd.title }; }) });
    this.emit('story');
  }

  /** 一只威胁被打倒：算进区域与阶段的战绩；是 Boss 就记下 */
  expeditionKill(this: Town, inst: ThreatInstance) {
    const region = inst.region || 'town';
    const adv = this.adventureState();
    adv.kills[region] = (adv.kills[region] || 0) + 1;
    adv.slain[inst.type] = (adv.slain[inst.type] || 0) + 1;
    this.adventureToday().kills += 1;
    for (const x of this.expeditions()) {
      const st = this.expState(x);
      for (const s of x.stages) {
        const ss = st.stages[s.id]!;
        if (s.region !== region || ss.status === 'locked') continue;
        ss.kills += 1;
        if (s.boss?.threat === inst.type && ss.status !== 'cleared') ss.bossDown = true;
      }
    }
  }

  /** 这个区域所在阶段的建议等级（经验折扣用） */
  levelHintOf(this: Town, region: string): number | undefined {
    for (const x of this.expeditions()) { const s = x.stages.find((q) => q.region === region && q.levelHint); if (s) return s.levelHint; }
    return undefined;
  }

  /** 这个人是不是某支远征的队长 */
  expeditionOfLeader(this: Town, a: LiveAgent): (ExpeditionDef & { id: string }) | null {
    return this.expeditions().find((x) => this.partyLeader(x.party) === a) || null;
  }

  /** 前线阶段与它的野外地点（没有写 wild 时取区域里的户外公共地点，不含回复点） */
  frontInfo(this: Town, x: ExpeditionDef & { id: string }): { stage: ExpeditionStage; wild: string[] } | null {
    const st = this.expState(x);
    const stage = x.stages.find((s) => s.id === st.front);
    if (!stage) return null;
    const wild = (stage.wild?.length ? stage.wild : Object.keys(this.spec.locations).filter((id) => this.locRegion(id) === stage.region && this.spec.locations[id]!.public && !this.restOf(id) && this.findLocation(id)?.spots?.length))
      .filter((id) => this.findLocation(id));
    return { stage, wild };
  }

  /** 规划提示里的「远征」：前线在哪、还差什么、最近的回复点 */
  expeditionHint(this: Town, a: LiveAgent): string {
    const x = this.expeditionOfLeader(a);
    const f = x && this.frontInfo(x);
    if (!x || !f) return '';
    const ss = this.expState(x).stages[f.stage.id]!;
    const rest = this.nearestRest(this.locCenter(f.wild[0] || '') ? { ...this.locCenter(f.wild[0]!)!, region: f.stage.region } : null);
    const need = f.stage.boss && !ss.bossDown ? `还没有打倒${this.spec.threats?.[f.stage.boss.threat]?.name || '这里的首领'}` : '还没有征服';
    return `【远征】${a.name}是${this.spec.parties?.[x.party]?.name || '队伍'}的队长。当前前线：「${f.stage.title}」（${this.regions[f.stage.region]?.name || f.stage.region}），${need}，已经打倒了 ${ss.kills} 只。那里的野外：${f.wild.map((id) => `${id}（${this.locName(id)}）`).join('、') || '无'}${rest ? `；最近的回复点：${rest}（${this.locName(rest)}）` : ''}。今天白天的大部分时间应该去前线清剿、变强，傍晚回回复点休整（location 填上面的 id）。\n`;
  }

  /**
   * 规划完之后（有没有模型都一样）：远征的队长白天必须有去前线的安排；没有就补上上午、下午两段，傍晚回回复点
   */
  ensureExpedition(this: Town, a: LiveAgent) {
    const x = this.expeditionOfLeader(a);
    const f = x && this.frontInfo(x);
    if (!x || !f || !f.wild.length || a.scheduleDay !== this.day) return;
    const day = a.schedule.filter((e) => e.start < 18 * 60 && e.end > 8 * 60);
    if (day.some((e) => e.location !== 'home' && this.locRegion(e.location) === f.stage.region)) return;
    const w0 = f.wild[0]!, w1 = f.wild[1] || w0;
    const rest = this.nearestRest(this.locCenter(w0) ? { ...this.locCenter(w0)!, region: f.stage.region } : null);
    const add = (start: string, end: string, location: string, activity: string, emoji: string) => this.insertEntry(a, { start: parseHM(start)!, end: parseHM(end)!, location, activity, emoji, src: 'expedition' });
    add('08:00', '11:30', w0, `去${this.locName(w0)}清剿`, '⚔️');
    add('11:30', '13:00', rest || w0, rest ? '回营地吃点东西' : '原地歇一歇', '🍖');
    add('13:00', '17:30', w1, `在${this.locName(w1)}继续探索`, '🗡️');
    if (rest) add('17:30', '22:30', rest, '回营地休整', '🏕️');
  }

  /** 夜里远离家乡的远征队员：就近在回复点扎营（不必每晚走回村里） */
  campEntry(this: Town, a: LiveAgent): import('../types/agent.ts').CurEntry | null {
    if (!isNight(this.minute, this.dayEnd) || !this.expeditions().some((x) => this.expeditionParty(x).includes(a))) return null;
    if ((a.region || 'town') === this.locRegion(a.home)) return null;
    const at = this.nearestRest({ x: a.x, y: a.y, region: a.region });
    if (!at || this.locRegion(at) === this.locRegion(a.home)) return null;
    return { key: `camp-${at}-${this.day}`, location: at, activity: `在${this.locName(at)}扎营过夜`, emoji: '⛺', sleep: true, sleepAt: at };
  }

  stageStatus(this: Town, id: string, exp?: string): StageStatus | 'none' {
    const x = this.expeditions().find((e) => !exp || e.id === exp);
    return (x && this.expState(x).stages[id]?.status) || 'none';
  }

  /** 快照里的远征：各阶段状态、前线、进度物 */
  expeditionView(this: Town) {
    return this.expeditions().map((x) => {
      const st = this.expState(x);
      return {
        id: x.id, party: x.party, front: st.front, tokens: x.tokens ? { ...x.tokens, got: st.tokens } : null,
        stages: x.stages.map((s) => ({ id: s.id, region: s.region, title: s.title, status: st.stages[s.id]?.status || 'locked', kills: st.stages[s.id]?.kills || 0, ...(s.atlas ? { atlas: s.atlas } : {}), ...(s.levelHint ? { levelHint: s.levelHint } : {}) })),
      };
    });
  }
}
