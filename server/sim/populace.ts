// 群众（docs/design/populace.md）：具名居民以外的普通人。规则层（sim/populace-rules.ts）每个游戏小时挪一次人，
// 这里负责把小镇的局面整理成规则层的输入、落地人流、伤亡、传闻、民意调用（每天 1~N 次）、路人的临时身份与交谈、视图。
// 以 mixin 的形式挂到 Town 上，方法里的 this 是 Town。
import * as llm from '../llm.ts';
import { findPath } from '../world.ts';
import { addMemory, fmtTime, parseHM } from '../memory.ts';
import { keywordCheck } from '../guard.ts';
import { activeEvents } from '../kernel/spec.ts';
import { ratingAtLeast } from '../kernel/ratings.ts';
import { resolvePopulace, placeKind, RESIDENTIAL } from '../kernel/populace-spec.ts';
import { get as setting } from '../settings/index.ts';
import { SCHEMAS } from '../llm-schemas.ts';
import { systemPrompt } from './cognition.ts';
import { clampStr } from './util.ts';
import {
  HOME, OUT, freshPopulace, seed, arrive, step, notePeaks, prune, harm, hear, countAt, groupTotal, placeCats, hash, persistentTopic,
} from './populace-rules.ts';
import type { PlaceInfo, StepInput, CrowdBelief, PopulaceState, Flow } from './populace-rules.ts';
import type { PopulaceConfig, PopGroup } from '../kernel/populace-spec.ts';
import type { Town } from '../sim.ts';
import type { WorldSpec } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import type { ModelJSON } from '../llm.ts';

export { freshPopulace } from './populace-rules.ts';

const GATHER_KINDS = ['market', 'celebrate', 'watch', 'mourn', 'pray', 'protest', 'flee'] as const;
const GATHER_NAMES: Record<string, string> = { market: '赶集', celebrate: '庆祝', watch: '围观', mourn: '悼念', pray: '祈福', protest: '请愿', flee: '避难' };
const STAGE_PUSH: Record<string, number> = { omen: 0.8, outbreak: 1.6, spread: 2.6 };
const MAX_PATHS_PER_VIEW = 40;
const ADJ = ['高个子的', '矮个子的', '年轻的', '上了年纪的', '笑眯眯的', '愁眉苦脸的', '匆匆忙忙的', '慢悠悠的', '爱说话的', '不爱说话的', '扎着辫子的', '留着胡子的', '戴帽子的', '提着篮子的', '背着包袱的', '哼着小曲的'];

const cfgCache = new WeakMap<WorldSpec, PopulaceConfig | null>();
const pathCache = new WeakMap<PopulaceState, Map<number, number[] | null>>();
const thinking = new WeakSet<object>();
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 分级决定恐惧的上限（决策 3：人数在任何分级都可以减少，分级只管情绪和口吻） */
export function fearCap(rating: string): number {
  if (ratingAtLeast(rating, 'dark')) return 1;
  if (ratingAtLeast(rating, 'adventure')) return 0.75;
  return 0.5;
}

/** 一个小人代表几个人；0 表示按对数换算 */
export function figureScale(cfg: PopulaceConfig, total: number): number {
  if (cfg.scale) return cfg.scale;
  if (total <= 150) return 1;
  if (total <= 1500) return 10;
  return 0;
}

export class Populace {
  /** 这个世界实际用的群众配置（随规格变化重新推算）；null 表示没有群众 */
  popCfg(this: Town): PopulaceConfig | null {
    if (!cfgCache.has(this.spec)) cfgCache.set(this.spec, resolvePopulace(this.spec));
    return cfgCache.get(this.spec)!;
  }

  populaceEnabled(this: Town): boolean { return Boolean(this.popCfg()); }

  get pop(): PopulaceState {
    const t = this as unknown as Town;
    return (t.populace ||= freshPopulace());
  }

  /** 开局 / 读档之后：第一次时把人放进世界；旧存档里黑暗叙事的人口转过来（死者数照抄，活着的人数按死者扣） */
  populaceInit(this: Town): void {
    const cfg = this.popCfg();
    const st = this.pop;
    if (!cfg) return;
    if (!st.seeded) {
      seed(st, cfg);
      const legacy = this.dark?.population || {};
      const dead = Object.entries(legacy).reduce((s, [loc, p]) => { if (p.dead) st.dead[loc] = (st.dead[loc] || 0) + p.dead; return s + (p.dead || 0); }, 0);
      if (dead > 0) {
        // 死去的人从第一类人群里扣掉（旧存档只有一类「市民」）
        const g = cfg.groups[0]!;
        const home = st.at[HOME] || {};
        home[g.id] = Math.max(0, (home[g.id] || 0) - dead);
      }
      if (this.dark) this.dark.population = {};
    }
    // 规格变了（新增的类别、被删掉的类别）：新类别放进来，删掉的类别清走
    const ids = new Set(cfg.groups.map((g) => g.id));
    for (const g of cfg.groups) if (!groupTotal(st, g.id) && !Object.values(st.at).some((b) => g.id in b)) { const b = (st.at[g.rhythm === 'visitor' ? OUT : HOME] ||= {}); b[g.id] = g.size; st.mood[g.id] ||= { fear: 0, joy: 0.3, anger: 0 }; }
    for (const b of Object.values(st.at)) for (const k of Object.keys(b)) if (!ids.has(k)) delete b[k];
    st.flows = st.flows.filter((f) => ids.has(f.group));
    if (st.hour < 0) st.hour = Math.floor(this.t / 60);
  }

  // ---------- 局面 → 规则层的输入 ----------
  /** 群众能去的地点：公开、所在区域开放、地图上找得到 */
  popPlaces(this: Town): PlaceInfo[] {
    const cfg = this.popCfg()!;
    const ids = this.publicLocs();
    const area = (id: string): number => {
      const m = this.findLocation(id);
      const r = m?.rect;
      return r ? r.w * r.h : Math.max(4, (m?.spots?.length || 2) * 4);
    };
    // 没写容量时按面积分：全体群众的 4 倍按各地点的面积摊开（至少 6 人）
    const totalArea = ids.reduce((s, id) => s + area(id), 0) || 1;
    const people = cfg.groups.reduce((s, g) => s + g.size, 0);
    return ids.map((id) => {
      const m = this.findLocation(id)!;
      const state = m.ruin ? 'ruin' : m.closed === 'closed' ? 'closed' : m.closed === 'damaged' ? 'damaged' : 'open';
      return { id, cats: placeCats(placeKind(this.spec, id), id), outdoor: !m.indoor, cap: cfg.capacity[id] || Math.max(6, Math.round((people * area(id) / totalArea) * 4)), state, active: this.regionActive(this.locRegion(id)) };
    });
  }

  /** 去处在地图上的一格：地点取中心，家取这类人最近的住处门口，外地取出入口 */
  popPoint(this: Town, place: string, group: PopGroup | null, near: Cell | null): (Cell & { region: string }) | null {
    if (place !== HOME && place !== OUT) { const c = this.locCenter(place); return c ? { ...c, region: this.locRegion(place) } : null; }
    const pts: Array<Cell & { region: string }> = [];
    if (place === HOME) {
      const ids = group?.homes.length ? group.homes : this.spec.buildings.filter((b) => !b.removed && b.state !== 'ruin' && (b.region || 'town') === 'town' && RESIDENTIAL.has(b.kind)).map((b) => b.id);
      for (const id of ids) {
        const b = this.world.buildings.find((x) => x.id === id);
        if (b) pts.push({ ...b.entrance, region: 'town' });
        else { const c = this.locCenter(id); if (c) pts.push({ ...c, region: this.locRegion(id) }); }
      }
    } else {
      for (const id of this.popCfg()?.outside.via || []) { const c = this.locCenter(id); if (c) pts.push({ ...c, region: this.locRegion(id) }); }
      if (!pts.length && this.world.gate) pts.push({ ...this.world.gate, region: 'town' });
    }
    if (!pts.length) return null;
    if (!near) return pts[0]!;
    return pts.reduce((best, p) => (Math.abs(p.x - near.x) + Math.abs(p.y - near.y) < Math.abs(best.x - near.x) + Math.abs(best.y - near.y) ? p : best));
  }

  popTravel(this: Town, from: string, to: string): number {
    const a = from === HOME || from === OUT ? null : this.popPoint(from, null, null);
    const b = to === HOME || to === OUT ? null : this.popPoint(to, null, null);
    const p = a || this.popPoint(from, null, b), q = b || this.popPoint(to, null, a);
    if (!p || !q) return 10;
    if (p.region !== q.region) return 30;
    return clamp((Math.abs(p.x - q.x) + Math.abs(p.y - q.y)) / 2.5, 4, 60);
  }

  /** 这一小时的吸引与排斥、全城的喜事与怨气 */
  popStimuli(this: Town, places: PlaceInfo[]): Pick<StepInput, 'pull' | 'push' | 'festival' | 'joy' | 'anger'> {
    const pull: Record<string, number> = {}, push: Record<string, number> = {};
    const inc = (m: Record<string, number>, id: string, v: number) => { if (v > 0) m[id] = (m[id] || 0) + v; };
    const center = new Map(places.map((p) => [p.id, this.locCenter(p.id)]));
    const near = (loc: string, w: number, radius: number) => {
      const c = this.locCenter(loc);
      if (!c) return;
      const rg = this.locRegion(loc);
      for (const p of places) {
        const pc = center.get(p.id);
        if (!pc || this.locRegion(p.id) !== rg) continue;
        const d = Math.hypot(pc.x - c.x, pc.y - c.y);
        if (d <= radius) inc(push, p.id, w * (1 - d / (radius + 1)));
      }
    };
    let joy = 0, anger = 0, festival = false;
    // 威胁：进行中的事件按阶段、在外作祟的威胁按位置
    for (const i of this.dark?.incidents || []) if (STAGE_PUSH[i.stage]) near(i.loc, STAGE_PUSH[i.stage]!, 18);
    for (const th of this.threats?.live?.() || []) {
      if (['dormant', 'contained', 'gone'].includes(th.state) || th.wild) continue;
      let best: string | null = null, bd = Infinity;
      for (const p of places) { const c = center.get(p.id); if (!c || this.locRegion(p.id) !== th.region) continue; const d = Math.hypot(c.x - th.x, c.y - th.y); if (d < bd) { bd = d; best = p.id; } }
      if (best && bd <= 10) near(best, 1, 8);
    }
    // 最近死过人的地方
    const st = this.pop;
    for (const c of st.casualties) inc(push, c.loc, Math.min(2.5, Math.log2(1 + c.n)) * (1 - (this.t - c.t) / 2880));
    // 夜里捣乱的异界生物
    const night = this.minute >= 20 * 60 || this.minute < 5 * 60;
    if (night && this.swarmGoal && this.creatures?.list?.some((c) => !c.friendly)) inc(push, this.swarmGoal, 0.6);
    // 灯、结界附近让人安心
    for (const p of places) {
      if (!push[p.id]) continue;
      const c = center.get(p.id);
      if (c && this.entities.some((e) => ((e.tags as string[]) || []).some((t) => t === 'light' || t === 'ward') && (e.region || 'town') === this.locRegion(p.id) && Math.hypot(e.x - c.x, e.y - c.y) <= 5)) push[p.id]! *= 0.5;
    }
    // 节日
    for (const e of activeEvents(this.spec, this.day, this.minute)) { if (e.location) inc(pull, e.location, 2.5); festival = true; joy = Math.max(joy, 0.8); }
    for (const e of this.spec.calendar.events) if (e.day === this.day && !festival && e.location && this.minute < (parseHM(e.from) ?? 0)) { inc(pull, e.location, 0.5); joy = Math.max(joy, 0.4); }
    // 自发的聚集
    for (const g of st.gatherings) {
      if (g.from > this.t || g.until <= this.t) continue;
      inc(pull, g.loc, 2.2);
      if (g.kind === 'celebrate' || g.kind === 'market') joy = Math.max(joy, 0.5);
      if (g.kind === 'protest') anger = Math.max(anger, 0.3);
      if (g.kind === 'celebrate') festival = true;
    }
    // 新落成的地方：三天里大家都想去看看
    for (const r of this.specOps.slice(-40)) {
      if (r.op !== 'addBuilding' && r.op !== 'addOutdoorPlace') continue;
      const id = (r.args as { id?: string }).id;
      const age = (this.t - r.t) / 1440;
      if (id && age < 3) { inc(pull, id, 1.2 * (1 - age / 3)); joy = Math.max(joy, 0.3); }
    }
    // 具名居民在的地方更热闹
    const busy: Record<string, number> = {};
    for (const a of this.agents) if (a.kind !== 'creature' && a.locId && a.status !== 'sleeping') busy[a.locId] = (busy[a.locId] || 0) + 1;
    for (const [id, n] of Object.entries(busy)) inc(pull, id, Math.min(0.6, n * 0.12));
    // 点名地点的传闻
    for (const b of st.beliefs) if (b.loc && b.tone) inc(b.tone === 'good' ? pull : push, b.loc, 0.8 * b.confidence);
    // 常去的地方关门了：有怨气
    const cfg = this.popCfg()!;
    const haunts = new Set(cfg.groups.flatMap((g) => g.haunts));
    anger = Math.max(anger, Math.min(0.4, places.filter((p) => p.state !== 'open' && (!haunts.size || haunts.has(p.id))).length * 0.08));
    return { pull, push, festival, joy, anger };
  }

  /** 天气对户外的影响：世界规格里的 outdoor（-1~1），没写时按天气 id 推断 */
  popWeather(this: Town): number {
    const w = this.spec.weather[this.weather];
    if (typeof w?.outdoor === 'number') return clamp(w.outdoor, -1, 1);
    if (/storm|snow|blizzard|sand/.test(this.weather)) return -0.9;
    if (/rain|drizzle|shower|fog|hail/.test(this.weather)) return -0.6;
    if (/sunny|clear/.test(this.weather)) return 0.3;
    return 0;
  }

  // ---------- 主循环 ----------
  populaceTick(this: Town): void {
    const cfg = this.popCfg();
    if (!cfg) return;
    const st = this.pop;
    if (st.flows.length) {
      const done = arrive(st, this.t, (id) => { const m = this.findLocation(id); return !m || Boolean(m.ruin) || m.closed === 'closed'; });
      if (done.length) for (const f of done) pathCache.get(st)?.delete(f.id);
    }
    const hour = Math.floor(this.t / 60);
    if (hour <= st.hour) return;
    st.hour = hour;
    const places = this.popPlaces();
    const inp: StepInput = {
      t: Math.floor(this.t), hour: hour % 24, day: this.day, fearCap: fearCap(this.spec.meta.rating), places,
      ...this.popStimuli(places), outdoor: this.popWeather(), morale: this.crisis.morale, supplies: this.crisis.supplies,
      travel: (a, b) => this.popTravel(a, b),
    };
    step(st, cfg, inp);
    prune(st, this.t, this.day);
    notePeaks(st, this.day, places.map((p) => p.id));
    this.popClues();
    this.popNotices(places);
    this.popRumorsToAgents(places);
    this.popMindCheck();
    this.emit('populace', this.populaceView());
  }

  // ---------- 伤亡、传闻 ----------
  /** 群众伤亡：从这个地点扣人，返回实际扣掉的人数 */
  harmCrowd(this: Town, loc: string, n: number): number {
    if (!this.popCfg()) return 0;
    return harm(this.pop, loc, n, Math.floor(this.t));
  }

  /** 伤亡落在哪个地点：离坐标最近、此刻有人的地点（12 格以内），没有就是最近的地点 */
  popHarmLoc(this: Town, at: Cell & { region?: string }): string | null {
    const st = this.pop;
    const region = at.region || 'town';
    let best: string | null = null, bd = Infinity, any: string | null = null, ad = Infinity;
    for (const id of this.publicLocs()) {
      if (this.locRegion(id) !== region) continue;
      const c = this.locCenter(id);
      if (!c) continue;
      const d = Math.hypot(c.x - at.x, c.y - at.y);
      if (d < ad) { ad = d; any = id; }
      if (countAt(st, id) > 0 && d <= 12 && d < bd) { bd = d; best = id; }
    }
    return best || any;
  }

  /** 群众听到一条传闻（导演的 spreadNews、民意、威胁的线索） */
  crowdHear(this: Town, b: Omit<CrowdBelief, 'since'> & { since?: number }): void {
    if (!this.popCfg()) return;
    const about = clampStr(b.about, 12), claim = clampStr(b.claim, 40);
    if (!about || !claim) return;
    hear(this.pop, { ...b, about, claim, confidence: clamp(num(b.confidence, 0.6), 0, 1), since: b.since ?? Math.floor(this.t) });
    if (b.source !== 'clue') { const days = (this.pop.topics[about] ||= []); if (!days.includes(this.day)) days.push(this.day); }
  }

  /** 群众是否已经相信了这个威胁的一条真线索（相信了就会照着做，群众伤亡减半） */
  crowdKnowsTruth(this: Town, threat: string): boolean {
    return this.pop.beliefs.some((b) => b.threat === threat && b.truth === true && b.confidence >= 0.5);
  }

  /** 进行中的事件：每天往群众里放一条说法（真线索或误导，真假混杂） */
  popClues(this: Town): void {
    const st = this.pop;
    if (this.minute < 9 * 60) return;
    for (const inc of this.dark?.incidents || []) {
      if (inc.stage !== 'outbreak' && inc.stage !== 'spread') continue;
      if (st.clued[inc.id] === this.day) continue;
      st.clued[inc.id] = this.day;
      const def = this.spec.threats?.[inc.type];
      if (!def) continue;
      const list = [...(def.clues || []).map((c) => [c, true] as const), ...(def.decoys || []).map((c) => [c, false] as const)];
      if (!list.length) continue;
      const [claim, truth] = list[hash(`${inc.id}|${this.day}`) % list.length]!;
      this.crowdHear({ about: def.name, claim, confidence: 0.5, source: 'clue', truth, threat: inc.type, loc: null, tone: null });
      this.log('populace', `🗣️ ${this.locName(inc.loc)}一带开始流传一种说法：${claim}`, { loc: inc.loc });
    }
    for (const k of Object.keys(st.clued)) if (!(this.dark?.incidents || []).some((i) => i.id === k && ['outbreak', 'spread'].includes(i.stage))) delete st.clued[k];
  }

  /** 居民注意到身边的人一下子多了 / 少了（每个地点每天最多一次） */
  popNotices(this: Town, places: PlaceInfo[]): void {
    const st = this.pop;
    const inTown = this.popCfg()!.groups.reduce((s, g) => s + groupTotal(st, g.id) - (st.at[OUT]?.[g.id] || 0), 0);
    const minN = Math.max(3, Math.ceil(inTown / Math.max(1, places.length) / 3));
    for (const p of places) {
      if (!p.active) continue;
      const now = countAt(st, p.id), prev = st.seen[p.id] ?? now;
      st.seen[p.id] = now;
      if (st.noticed[p.id] === this.day) continue;
      const more = now >= minN && now >= prev * 2 && now - prev >= minN;
      const less = prev >= minN && now <= prev / 2;
      if (!more && !less) continue;
      const who = this.agents.filter((a) => a.kind !== 'creature' && a.locId === p.id && a.status !== 'sleeping');
      if (!who.length) continue;
      st.noticed[p.id] = this.day;
      const name = this.locName(p.id);
      const text = more ? `${name}一下子热闹起来，来了好多人（差不多 ${now} 个）` : `${name}的人一下子少了很多，冷冷清清的`;
      const importance = clamp(Math.round(3 + Math.log2(Math.max(now, prev) / minN)), 3, 5);
      for (const a of who) addMemory(a, { t: this.t, type: 'obs', text, importance });
    }
  }

  /** 人多的地方，居民会听到群众里流传的说法（每人每天最多一条） */
  popRumorsToAgents(this: Town, places: PlaceInfo[]): void {
    const st = this.pop;
    if (!st.beliefs.length) return;
    const ok = new Set(places.filter((p) => p.active && countAt(st, p.id) >= 3).map((p) => p.id));
    for (const a of this.agents) {
      if (a.kind === 'creature' || a.status === 'sleeping' || !a.locId || !ok.has(a.locId) || st.heard[a.id] === this.day) continue;
      if (hash(`${a.id}|${st.hour}`) % 4) continue;
      const b = st.beliefs.find((x) => x.confidence >= 0.4 && (a.beliefs.find((y) => y.about === x.about)?.confidence ?? 0) < x.confidence * 0.8);
      if (!b) continue;
      st.heard[a.id] = this.day;
      this.setBelief(a, { about: b.about, claim: b.claim, confidence: Math.round(b.confidence * 0.8 * 100) / 100, source: 'crowd' });
      addMemory(a, { t: this.t, type: 'obs', text: `在${this.locName(a.locId)}听街上的人说：${b.claim}`, importance: 4 });
    }
    for (const k of Object.keys(st.heard)) if (st.heard[k]! < this.day - 1) delete st.heard[k];
  }

  /** 从群众里「转正」一位新居民：对应类别少一个人；返回是否成功 */
  populaceRecruit(this: Town, groupId: string): boolean {
    const st = this.pop;
    for (const place of [HOME, ...Object.keys(st.at)]) {
      const b = st.at[place];
      if (b?.[groupId]) { b[groupId]!--; if (!b[groupId]) delete b[groupId]; return true; }
    }
    return false;
  }

  /** 长期被议论的话题（给人员流动：新人可以从群众里站出来） */
  populaceTopic(this: Town): string | null { return this.popCfg() ? persistentTopic(this.pop, this.day) : null; }

  // ---------- 民意 ----------
  /** 每小时：看要不要调用一次民意（每天 07:00 一次；有大事时加一次，总数不超过设置） */
  popMindCheck(this: Town): void {
    const st = this.pop;
    const m = st.mind;
    const sig = [
      ...(this.dark?.incidents || []).filter((i) => ['omen', 'outbreak', 'spread'].includes(i.stage)).map((i) => `${i.id}:${i.stage}`),
      ...activeEvents(this.spec, this.day, this.minute).map((e) => e.id),
      ...this.specOps.filter((r) => ['addBuilding', 'addOutdoorPlace', 'setBuildingState', 'removeBuilding'].includes(r.op)).slice(-1).map((r) => `op${r.seq}`),
      st.casualties.filter((c) => this.t - c.t < 1440).reduce((s, c) => s + c.n, 0) > 0.02 * this.popCfg()!.groups.reduce((s, g) => s + g.size, 0) ? 'harm' : '',
    ].join('|');
    if (sig !== m.sig) { if (m.sig) m.pending = true; m.sig = sig; }
    if (m.day !== this.day) { m.day = this.day; m.count = 0; }
    if (!setting('POPULACE_MIND')) return;
    const due = (m.count === 0 && this.minute >= 7 * 60) || (m.pending && m.count > 0 && this.t - m.at >= 120);
    if (!due || m.count >= setting('POPULACE_MIND_PER_DAY')) return;
    this.populaceMind().catch(() => {});
  }

  /** 民意调用：群众的集体倾向。模型只给方向，内核校验、限幅后交给规则层 */
  async populaceMind(this: Town): Promise<boolean> {
    const cfg = this.popCfg();
    if (!cfg || thinking.has(this) || !llm.enabled() || llm.budgetLeft() <= 0 || llm.isBusy()) return false;
    const st = this.pop;
    thinking.add(this);
    st.mind.count++;
    st.mind.at = Math.floor(this.t);
    st.mind.pending = false;
    try {
      const res = await llm.chatJSON([
        systemPrompt(this.spec, Boolean(this.pack), '这一次你不扮演任何一位居民，而是这里普通人（群众）的集体心声。只写大多数人的倾向，不点名伤害任何具体的人。'),
        { role: 'user', content: this.popMindPrompt() },
      ], { label: '群众心智', schema: SCHEMAS.populace, agent: '群众', maxTokens: 1500, tier: 'fast', attempts: 1, timeoutMs: 60_000 });
      this.popApplyMind(res);
      return true;
    } catch (e) {
      console.warn(`[populace] ${this.worldId} 民意调用失败：`, (e as Error).message);
      return false;
    } finally {
      thinking.delete(this);
    }
  }

  popMindPrompt(this: Town): string {
    const cfg = this.popCfg()!;
    const st = this.pop;
    const place = this.spec.voice?.place || '小镇';
    const groups = cfg.groups.map((g) => {
      const top = this.publicLocs().map((id) => [id, st.at[id]?.[g.id] || 0] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, n]) => `${this.locName(id)}${n}`).join('、');
      const m = st.mood[g.id] || { fear: 0, joy: 0, anger: 0 };
      return `- ${g.id}（${g.name}）：${groupTotal(st, g.id) - (st.at[OUT]?.[g.id] || 0)} 人在${place}，${st.at[OUT]?.[g.id] || 0} 人在${cfg.outside.name}；人最多的地方：${top || '都在家'}；恐惧 ${m.fear.toFixed(2)}，欢乐 ${m.joy.toFixed(2)}，不满 ${m.anger.toFixed(2)}`;
    }).join('\n');
    const recent = this.logs.filter((l) => ['event', 'incident', 'casualty', 'news_spread', 'world', 'arrival', 'depart', 'scene', 'populace', 'omen', 'death'].includes(l.type)).slice(-10).map((l) => `- [${fmtTime(l.t)}] ${l.text}`).join('\n');
    const beliefs = st.beliefs.slice(0, 6).map((b) => `- ${b.about}：${b.claim}（${Math.round(b.confidence * 100)}%）`).join('\n');
    const locs = this.publicLocs().map((id) => `${id}（${this.locName(id)}）`).join('、');
    return `${this.timeBlock()}
这里的普通人（不是那些有名有姓的居民）分成这几类：
${groups}
${st.summary ? `上一次大家的心思：${st.summary}\n` : ''}最近发生的事：
${recent || '（平静）'}
大家在传的说法：
${beliefs || '（没有）'}

请推断今天大家的集体倾向。可以去的地点 id：${locs}
输出 JSON：
{"summary":"今天大家心里在想什么（≤40字）",
"prefer":[{"group":"类别id 或 all","loc":"地点id","weight":-1~1（正数想去，负数躲开）,"hours":1~24,"reason":"≤20字"}]（最多 4 条）,
"rumors":[{"about":"话题≤12字","claim":"大家在传什么≤40字","confidence":0~1,"loc":"地点id 或 null","tone":"good/bad/null（这个说法让人想去还是想躲开那里）"}]（最多 2 条，可以为空）,
"gathering":null 或 {"loc":"地点id","kind":"${GATHER_KINDS.join('/')}","from":"HH:MM（今天）","hours":1~6,"text":"≤30字"},
"demand":null 或 {"text":"大家希望${place}添点什么、修好什么、关掉什么（≤40字）"}}
要求：符合这个世界的时代与分级；平静的日子就写平静的事，不要无中生有；不点名任何具体的人。`;
  }

  popApplyMind(this: Town, res: ModelJSON): void {
    const cfg = this.popCfg()!;
    const st = this.pop;
    const rating = this.spec.meta.rating;
    const ok = (s: string) => Boolean(s) && keywordCheck(s, rating).ok;
    const locs = new Set(this.publicLocs());
    const gids = new Set(cfg.groups.map((g) => g.id));
    const summary = clampStr(res.summary, 60);
    if (ok(summary)) { st.summary = summary; st.summaryT = Math.floor(this.t); this.log('populace', `🗣️ 民意：${summary}`); }
    for (const p of (Array.isArray(res.prefer) ? res.prefer : []).slice(0, 4)) {
      if (!p || !locs.has(p.loc)) continue;
      const group = gids.has(p.group) ? p.group : null;
      st.intents.push({ group, loc: p.loc, weight: clamp(num(p.weight, 0), -1, 1), until: Math.floor(this.t) + clamp(Math.round(num(p.hours, 6)), 1, 24) * 60, reason: clampStr(p.reason, 20) });
    }
    if (st.intents.length > 12) st.intents.splice(0, st.intents.length - 12);
    for (const r of (Array.isArray(res.rumors) ? res.rumors : []).slice(0, 2)) {
      if (!r || !ok(clampStr(r.claim, 40)) || !ok(clampStr(r.about, 12))) continue;
      this.crowdHear({ about: r.about, claim: r.claim, confidence: clamp(num(r.confidence, 0.6), 0, 1), source: 'mind', loc: locs.has(r.loc) ? r.loc : null, tone: r.tone === 'good' || r.tone === 'bad' ? r.tone : null });
    }
    const g = res.gathering;
    if (g && typeof g === 'object' && locs.has(g.loc) && (GATHER_KINDS as readonly string[]).includes(g.kind) && ok(clampStr(g.text, 30))) {
      const dayStart = Math.floor(this.t / 1440) * 1440;
      const from = Math.max(Math.floor(this.t), dayStart + (parseHM(g.from) ?? Math.floor(this.minute)));
      const until = from + clamp(Math.round(num(g.hours, 2)), 1, 6) * 60;
      if (!st.gatherings.some((x) => x.loc === g.loc && x.until > from)) {
        st.gatherings.push({ loc: g.loc, kind: g.kind, from, until, text: clampStr(g.text, 30) });
        if (st.gatherings.length > 4) st.gatherings.shift();
        this.log('populace', `👥 ${fmtTime(from)} 起，大家要去${this.locName(g.loc)}${GATHER_NAMES[g.kind]}：${clampStr(g.text, 30)}`, { loc: g.loc });
      }
    }
    const d = clampStr(res.demand?.text, 40);
    if (d && ok(d) && this.day - st.mind.demandDay >= 3 && this.architect) {
      const err = this.architect.enqueue(d, 'populace');
      if (!err) { st.mind.demandDay = this.day; this.log('populace', `📣 群众的呼声：${d}`); }
    }
    this.emit('populace', this.populaceView());
    this.emit('story');
  }

  // ---------- 提示词里的一段 ----------
  /** 导演、日报用：民意、人流、聚集、传闻 */
  populaceBlock(this: Town): string {
    const cfg = this.popCfg();
    if (!cfg) return '';
    const st = this.pop;
    const busy = this.publicLocs().map((id) => [id, countAt(st, id)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${this.locName(id)}（${n}）`).join('、');
    const out = cfg.groups.reduce((s, g) => s + (st.at[OUT]?.[g.id] || 0), 0);
    const left = cfg.groups.filter((g) => g.rhythm !== 'visitor').reduce((s, g) => s + (st.at[OUT]?.[g.id] || 0), 0);
    const g = st.gatherings.filter((x) => x.until > this.t).map((x) => `${this.locName(x.loc)}${GATHER_NAMES[x.kind]}（${x.text}）`).join('；');
    const rumors = st.beliefs.slice(0, 3).map((b) => b.claim).join('；');
    return `\n群众（${cfg.groups.map((x) => x.name).join('、')}）：${st.summary || '日子照常过'}${busy ? `；人最多的地方：${busy}` : ''}${left ? `；已经有 ${left} 人搬走了` : out ? `；${out} 人在外地` : ''}${g ? `；聚集：${g}` : ''}${rumors ? `；街上在传：${rumors}` : ''}`;
  }

  /** 规划一天用：镇上的情形 */
  populaceHint(this: Town): string {
    if (!this.popCfg()) return '';
    const st = this.pop;
    const y = st.peaks[this.day - 1] || {};
    const ranked = Object.entries(y).filter(([id]) => this.publicLocs().includes(id)).sort((a, b) => b[1] - a[1]);
    if (!ranked.length && !st.summary) return '';
    const busy = ranked.slice(0, 2).map(([id]) => this.locName(id)).join('、');
    const quiet = ranked.length > 3 ? ranked.slice(-2).map(([id]) => this.locName(id)).join('、') : '';
    return `镇上的情形：${st.summary || '日子照常过'}${busy ? `；昨天人最多的是${busy}` : ''}${quiet ? `，最冷清的是${quiet}` : ''}${st.gatherings.some((g) => g.until > this.t) ? `；今天${st.gatherings.filter((g) => g.until > this.t).map((g) => `${this.locName(g.loc)}有人${GATHER_NAMES[g.kind]}`).join('、')}` : ''}。\n`;
  }

  // ---------- 路人 ----------
  /** 路人的临时身份：按地点、类别、序号、游戏日确定（同一天点同一个人得到同一个人） */
  passerby(this: Town, loc: string, gi: number, idx: number) {
    const cfg = this.popCfg();
    const g = cfg?.groups[gi];
    if (!g || !Number.isInteger(idx) || idx < 0 || idx > 999 || !(loc === HOME || loc === OUT || this.publicLocs().includes(loc))) return null;
    const st = this.pop;
    const h = hash(`${loc}|${g.id}|${idx}|${this.day}`);
    const name = `${ADJ[h % ADJ.length]}${g.name}`;
    const m = st.mood[g.id] || { fear: 0, joy: 0.3, anger: 0 };
    const gather = st.gatherings.find((x) => x.loc === loc && x.from <= this.t && x.until > this.t);
    const rumor = st.beliefs.length ? st.beliefs[h % st.beliefs.length]! : null;
    const lines = gather ? [`${gather.text}，一起去看看吧！`]
      : m.fear >= 0.5 ? ['最近还是少出门吧。', '这几天心里总是发毛。', '天一黑我就回家，谁叫也不出来。']
        : m.anger >= 0.4 ? ['这日子什么时候是个头？', '上面的人也该管管了。']
          : m.joy >= 0.55 ? ['今天真热闹！', '好久没这么开心了。', '走，去那边看看！']
            : ['忙完这阵子就好了。', '你是外地来的吧？', '这儿我待了好些年了。', `今天${this.weatherText()}，正好出来走走。`];
    const line = rumor && h % 3 === 0 ? `听说${rumor.claim}` : lines[(h >>> 4) % lines.length]!;
    return { loc, locName: loc.startsWith('@') ? (loc === OUT ? cfg!.outside.name : '路上') : this.locName(loc), group: g.id, groupName: g.name, emoji: g.emoji, name, line, mood: m };
  }

  /** 旅人和路人说话（P0）：不写进任何具名居民的记忆 */
  async passerbyChat(this: Town, loc: string, gi: number, idx: number, text: string, history: Array<{ from: string; text: string }> = [], visitorName: string | null = null) {
    const p = this.passerby(loc, gi, idx);
    if (!p) throw Object.assign(new Error('这里没有这个人'), { status: 404 });
    const st = this.pop;
    const hist = history.slice(-6).map((h) => `${h.from === 'user' ? '旅人' : p.name}：${clampStr(h.text, 120)}`).join('\n');
    const m = p.mood;
    const res = await llm.chatJSON([
      systemPrompt(this.spec, Boolean(this.pack), `这一次你扮演一位普通的路人：${p.name}。你不是有名有姓的重要人物，只知道街坊之间流传的事。`),
      {
        role: 'user', content: `${this.timeBlock()}
你是${p.name}，此刻在${p.locName}。${st.summary ? `这几天大家的心思：${st.summary}。` : ''}
你的心情：${m.fear >= 0.5 ? '提心吊胆' : m.anger >= 0.4 ? '憋着一肚子火' : m.joy >= 0.55 ? '很高兴' : '平平常常'}。
你听说的事：${st.beliefs.slice(0, 4).map((b) => b.claim).join('；') || '没什么特别的'}
${hist ? `刚才的对话：\n${hist}\n` : ''}${visitorName ? `旅人「${visitorName}」` : '一位旅人'}对你说：「${text}」
请用口语回一句（可以反问、抱怨、分享街坊的传闻；不知道的事就说不知道）。输出 JSON：{"reply":"≤60字","emoji":"一个emoji"}`,
      },
    ], { label: '与路人交谈', schema: SCHEMAS.passerby, agent: p.name, maxTokens: 800, timeoutMs: 60_000, attempts: 2 });
    const reply = clampStr(res.reply, 120) || '……';
    this.log('visitor', `🧳 ${visitorName ? `旅人「${visitorName}」` : '旅人'}和${p.locName}的${p.name}搭话「${clampStr(text, 40)}」→「${reply}」`);
    return { reply, emoji: clampStr(res.emoji, 4) || p.emoji, name: p.name };
  }

  // ---------- 视图 ----------
  /** 快照里的一帧：醒着的区域里，各地点各类人的人数（类别顺序同 populaceView().groups） */
  populaceSnapshot(this: Town): Record<string, number[]> | null {
    const cfg = this.popCfg();
    if (!cfg) return null;
    const st = this.pop;
    const out: Record<string, number[]> = {};
    for (const [place, b] of Object.entries(st.at)) {
      if (place === HOME || place === OUT) continue;
      const row = cfg.groups.map((g) => b[g.id] || 0);
      if (row.some((n) => n > 0)) out[place] = row;
    }
    return out;
  }

  /** 人流的路径（缓存；一次最多新算 MAX_PATHS_PER_VIEW 条）：[x0, y0, x1, y1, …]，算不出来时为 null */
  popPath(this: Town, f: Flow, budget: { n: number }): { region: string; path: number[] } | null {
    const cache = pathCache.get(this.pop) || new Map<number, number[] | null>();
    pathCache.set(this.pop, cache);
    const g = this.popCfg()!.groups.find((x) => x.id === f.group) || null;
    const a0 = f.from === HOME || f.from === OUT ? null : this.popPoint(f.from, g, null);
    const b0 = f.to === HOME || f.to === OUT ? null : this.popPoint(f.to, g, null);
    const a = a0 || this.popPoint(f.from, g, b0), b = b0 || this.popPoint(f.to, g, a0);
    if (!a || !b || a.region !== b.region) return null;
    if (!cache.has(f.id)) {
      if (budget.n <= 0) return null;
      budget.n--;
      const raw = findPath(this.worldOf(a.region), Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y));
      if (!raw?.length) cache.set(f.id, null);
      else {
        const pts = [{ x: Math.round(a.x), y: Math.round(a.y) }, ...raw.filter((_, i) => i % 2 === 1 || i === raw.length - 1)];
        cache.set(f.id, pts.flatMap((p) => [p.x, p.y]));
      }
    }
    const path = cache.get(f.id);
    return path ? { region: a.region, path } : null;
  }

  /** 推给前端的群众状态（每小时、民意之后推一次；也随初始数据下发） */
  populaceView(this: Town) {
    const cfg = this.popCfg();
    if (!cfg) return null;
    const st = this.pop;
    const total = cfg.groups.reduce((s, g) => s + groupTotal(st, g.id), 0);
    const budget = { n: MAX_PATHS_PER_VIEW };
    const live = st.flows.filter((f) => f.eta > this.t).sort((x, y) => y.n - x.n);
    const flows = [];
    for (const f of live) {
      const p = this.popPath(f, budget);
      if (p) flows.push({ id: f.id, g: cfg.groups.findIndex((x) => x.id === f.group), n: f.n, s: f.start, e: f.eta, c: f.cause, to: f.to, region: p.region, p: p.path });
    }
    return {
      scale: figureScale(cfg, total), total,
      groups: cfg.groups.map((g) => ({ id: g.id, name: g.name, emoji: g.emoji, tones: g.tones })),
      flows,
      gatherings: st.gatherings.filter((x) => x.until > this.t).map((x) => ({ loc: x.loc, kind: x.kind, from: x.from, until: x.until, text: x.text })),
      summary: st.summary,
    };
  }

  /** 故事面板的「群众」一节 */
  populacePanel(this: Town) {
    const cfg = this.popCfg();
    if (!cfg) return null;
    const st = this.pop;
    const groups = cfg.groups.map((g) => {
      const out = st.at[OUT]?.[g.id] || 0;
      const top = this.publicLocs().map((id) => [id, st.at[id]?.[g.id] || 0] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => ({ name: this.locName(id), n }));
      return { id: g.id, name: g.name, emoji: g.emoji, total: groupTotal(st, g.id), out, home: st.at[HOME]?.[g.id] || 0, moving: st.flows.filter((f) => f.group === g.id).reduce((s, f) => s + f.n, 0), visitor: g.rhythm === 'visitor', mood: st.mood[g.id] || { fear: 0, joy: 0, anger: 0 }, top };
    });
    const places = this.publicLocs().map((id) => ({ id, name: this.locName(id), n: countAt(st, id), dead: st.dead[id] || 0 })).filter((p) => p.n || p.dead).sort((a, b) => b.n - a.n);
    return {
      summary: st.summary, outside: cfg.outside.name, groups, places,
      dead: Object.values(st.dead).reduce((s, n) => s + n, 0),
      beliefs: st.beliefs.slice(0, 8).map((b) => ({ about: b.about, claim: b.claim, confidence: Math.round(b.confidence * 100) / 100, loc: b.loc ? this.locName(b.loc) : null })),
      gatherings: st.gatherings.filter((x) => x.until > this.t).map((x) => ({ loc: this.locName(x.loc), kind: GATHER_NAMES[x.kind] || x.kind, from: fmtTime(x.from), until: fmtTime(x.until), text: x.text })),
      flows: st.flows.filter((f) => f.cause !== 'routine').sort((a, b) => b.n - a.n).slice(0, 5).map((f) => ({ group: cfg.groups.find((g) => g.id === f.group)?.name || f.group, from: f.from === HOME ? '家里' : f.from === OUT ? cfg.outside.name : this.locName(f.from), to: f.to === HOME ? '家里' : f.to === OUT ? cfg.outside.name : this.locName(f.to), n: f.n, cause: f.cause })),
    };
  }

  // ---------- 规则表达式 ----------
  crowdAt(this: Town, loc: string): number { return this.popCfg() ? countAt(this.pop, loc) : 0; }
  crowdGone(this: Town): number { const cfg = this.popCfg(); return cfg ? cfg.groups.filter((g) => g.rhythm !== 'visitor').reduce((s, g) => s + (this.pop.at[OUT]?.[g.id] || 0), 0) : 0; }
  crowdMood(this: Town, kind: string): number {
    const cfg = this.popCfg();
    if (!cfg || !['fear', 'joy', 'anger'].includes(kind)) return 0;
    let n = 0, s = 0;
    for (const g of cfg.groups) { const w = groupTotal(this.pop, g.id); n += w; s += w * (this.pop.mood[g.id]?.[kind as 'fear'] || 0); }
    return n ? Math.round((s / n) * 1000) / 1000 : 0;
  }
  crowdBelieves(this: Town, about: string): number { return this.pop.beliefs.find((b) => b.about === about)?.confidence || 0; }
  /** 这个地点几乎没有群众：不到平常高峰的 10%（至少 2 人以下）；世界没有群众时为假 */
  deserted(this: Town, loc: string): boolean {
    if (!this.popCfg()) return false;
    const n = countAt(this.pop, loc);
    return n <= Math.max(2, Math.round((this.pop.norm[loc] || 0) * 0.1));
  }
}
