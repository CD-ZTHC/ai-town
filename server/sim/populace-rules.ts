// 群众的规则层（docs/design/populace.md §4）：每个游戏小时结算一次。只依赖显式输入（配置、状态、这一小时的局面），
// 不用随机数——同样的输入永远得到同样的人流，读档、快进、回放都一致。Town 上的接口见 sim/populace.ts。
import type { PopGroup, PopulaceConfig } from '../kernel/populace-spec.ts';

/** 在家（看不见）与在外地（不在世界里）的两个虚拟去处 */
export const HOME = '@home';
export const OUT = '@out';

export interface Flow {
  id: number;
  group: string;
  from: string;
  to: string;
  n: number;
  /** 出发、到达的游戏分钟 */
  start: number;
  eta: number;
  /** routine 作息 / gather 聚集 / flee 躲开 / leave 搬走 / return 回来 / arrive 来访 / depart 离开 */
  cause: string;
}

export interface PopMood { fear: number; joy: number; anger: number }

/** 群众相信的一条传闻 */
export interface CrowdBelief {
  about: string;
  claim: string;
  confidence: number;
  /** news 导演 / mind 民意 / clue 威胁的线索 / talk 居民的对话 */
  source: string;
  since: number;
  loc?: string | null;
  /** 点名地点的传闻是好事还是坏事：决定吸引还是排斥 */
  tone?: 'good' | 'bad' | null;
  /** 来自威胁的线索时：是真线索（true）还是误导（false）。不进任何提示词和视图 */
  truth?: boolean;
  threat?: string;
}

/** 民意给的去向偏好 */
export interface PopIntent { group: string | null; loc: string; weight: number; until: number; reason: string }

/** 自发的聚集 */
export interface Gathering { loc: string; kind: string; from: number; until: number; text: string }

export interface PopulaceState {
  seeded: boolean;
  /** 去处（地点 id / @home / @out）→ 类别 → 人数（不含路上的人） */
  at: Record<string, Record<string, number>>;
  dead: Record<string, number>;
  flows: Flow[];
  mood: Record<string, PopMood>;
  /** 恐惧持续高于出城阈值的小时数 */
  fearHours: Record<string, number>;
  beliefs: CrowdBelief[];
  intents: PopIntent[];
  gatherings: Gathering[];
  casualties: Array<{ t: number; loc: string; n: number }>;
  summary: string | null;
  summaryT: number;
  /** 传闻话题 → 出现过的游戏日 */
  topics: Record<string, number[]>;
  /** 上一次结算的小时（floor(t / 60)） */
  hour: number;
  mind: { day: number; count: number; at: number; sig: string; pending: boolean; demandDay: number };
  /** 游戏日 → 地点 → 当天的人数高峰（只留最近几天） */
  peaks: Record<string, Record<string, number>>;
  /** 地点平常的高峰（指数平均） */
  norm: Record<string, number>;
  normDay: number;
  /** 居民上一次注意到的人数、注意到的日子（地点 → …）；居民上一次听到群众传闻的日子 */
  seen: Record<string, number>;
  noticed: Record<string, number>;
  heard: Record<string, number>;
  /** 威胁事件 → 上一次往群众里放线索的日子 */
  clued: Record<string, number>;
  seq: number;
}

export function freshPopulace(): PopulaceState {
  return {
    seeded: false, at: {}, dead: {}, flows: [], mood: {}, fearHours: {}, beliefs: [], intents: [], gatherings: [], casualties: [],
    summary: null, summaryT: 0, topics: {}, hour: -1, mind: { day: 0, count: 0, at: -1, sig: '', pending: false, demandDay: -99 },
    peaks: {}, norm: {}, normDay: 0, seen: {}, noticed: {}, heard: {}, clued: {}, seq: 0,
  };
}

// ---------- 地点的种类 → 作息里的用途 ----------
const WORK_RE = /work|smith|forge|farm|field|office|school|hospital|clinic|store|shop|bakery|market|mine|archive|library|station|mill|dock|factory|lab|guild|studio|barn|harbor|port/;
const FOOD_RE = /cafe|tea|tavern|inn|bakery|restaurant|market|street|food|bar|canteen|kitchen|diner|pub/;
const FUN_RE = /square|plaza|park|pier|garden|meadow|street|shrine|temple|church|lake|well|story|fountain|beach|camp|clearing|grove|gate|lookout|alley|pond|bridge|hill|river|theater|stage|arena/;

/** 地点的用途：work 上工 / food 吃饭 / fun 闲逛（可以有多个；都不像时算闲逛） */
export function placeCats(kind: string, id = ''): string[] {
  const s = `${kind} ${id}`.toLowerCase();
  const out: string[] = [];
  if (WORK_RE.test(s)) out.push('work');
  if (FOOD_RE.test(s)) out.push('food');
  if (FUN_RE.test(s)) out.push('fun');
  return out.length ? out : ['fun'];
}

type Routine = { home: number; work: number; food: number; fun: number };
const DAY: Array<[number, Routine]> = [
  [6, { home: 0.97, work: 0.01, food: 0.01, fun: 0.01 }],
  [8, { home: 0.6, work: 0.2, food: 0.15, fun: 0.05 }],
  [12, { home: 0.2, work: 0.55, food: 0.1, fun: 0.15 }],
  [13, { home: 0.2, work: 0.2, food: 0.45, fun: 0.15 }],
  [17, { home: 0.2, work: 0.5, food: 0.1, fun: 0.2 }],
  [20, { home: 0.35, work: 0.05, food: 0.3, fun: 0.3 }],
  [22, { home: 0.65, work: 0.02, food: 0.18, fun: 0.15 }],
  [24, { home: 0.92, work: 0, food: 0.06, fun: 0.02 }],
];
/** 作息：这个钟点各种去处的比重 */
export function routine(rhythm: PopGroup['rhythm'], hour: number): Routine {
  if (rhythm === 'always') return { home: 0.35, work: 0.25, food: 0.2, fun: 0.2 };
  const h = rhythm === 'night' ? (hour + 10) % 24 : hour; // 夜猫子：晚上上工、白天睡觉
  return DAY.find(([end]) => h < end)![1];
}
/** 来访的人此刻在城里的比例 */
export function visitorShare(hour: number, festival: boolean): number {
  if (festival) return hour >= 9 && hour < 23 ? 0.9 : 0.15;
  return hour >= 10 && hour < 18 ? 0.25 : 0;
}

// ---------- 小工具 ----------
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** 把 total 按权重分成整数（最大余数法；同样的输入永远同样的结果） */
export function allocate(total: number, weights: number[]): number[] {
  const out = weights.map(() => 0);
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0 || !weights.length) return out;
  if (sum <= 0) { out[0] = total; return out; }
  const rem: Array<[number, number]> = [];
  let used = 0;
  weights.forEach((w, i) => { const x = (Math.max(0, w) / sum) * total; out[i] = Math.floor(x); used += out[i]!; rem.push([x - out[i]!, i]); });
  rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < total - used; k++) out[rem[k % rem.length]![1]]!++;
  return out;
}
/** 字符串的稳定哈希（出发时刻错开、路人的称呼用） */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const groupTotal = (st: PopulaceState, g: string): number => {
  let n = 0;
  for (const b of Object.values(st.at)) n += b[g] || 0;
  for (const f of st.flows) if (f.group === g) n += f.n;
  return n;
};
/** 一个去处此刻的人数（不含路上的） */
export const countAt = (st: PopulaceState, place: string): number => Object.values(st.at[place] || {}).reduce((s, n) => s + n, 0);
const add = (st: PopulaceState, place: string, g: string, n: number) => {
  const b = (st.at[place] ||= {});
  b[g] = (b[g] || 0) + n;
  if (b[g]! <= 0) delete b[g];
};

/** 开局：常住的人在家，来访的人在外地 */
export function seed(st: PopulaceState, cfg: PopulaceConfig): void {
  st.at = {};
  for (const g of cfg.groups) {
    add(st, g.rhythm === 'visitor' ? OUT : HOME, g.id, g.size);
    st.mood[g.id] ||= { fear: 0, joy: 0.3, anger: 0 };
  }
  st.seeded = true;
}

/** 到点的人流落地：去处关了的回家 */
export function arrive(st: PopulaceState, t: number, closed: (place: string) => boolean = () => false): Flow[] {
  const done = st.flows.filter((f) => f.eta <= t);
  if (!done.length) return done;
  st.flows = st.flows.filter((f) => f.eta > t);
  for (const f of done) add(st, f.to !== HOME && f.to !== OUT && closed(f.to) ? HOME : f.to, f.group, f.n);
  return done;
}

// ---------- 每小时的结算 ----------
export interface PlaceInfo {
  id: string;
  cats: string[];
  outdoor: boolean;
  cap: number;
  state: 'open' | 'damaged' | 'closed' | 'ruin';
  /** 所在区域在休眠：里面的人原地不动，也没有人去 */
  active: boolean;
}

export interface StepInput {
  t: number;
  hour: number;
  day: number;
  /** 分级决定的恐惧上限 */
  fearCap: number;
  places: PlaceInfo[];
  /** 地点 → 吸引 / 排斥的强度（0~3 左右） */
  pull: Record<string, number>;
  push: Record<string, number>;
  /** 天气对户外的影响：-1 下雨下雪 ~ +1 晴好 */
  outdoor: number;
  festival: boolean;
  morale: number;
  supplies: number;
  /** 全城的喜事、怨气（0~1） */
  joy: number;
  anger: number;
  /** 两个去处之间要走多少游戏分钟 */
  travel: (from: string, to: string) => number;
}

/** 这类人对一个地点的熟悉程度：常去、上工的地方 1，别处 0.5 */
const affinity = (g: PopGroup, id: string): number => (!g.haunts.length || g.haunts.includes(id) || g.work.includes(id) ? 1 : 0.5);

/** 这类人可以去的地点，按用途分好 */
function targetsOf(g: PopGroup, places: PlaceInfo[]): Record<string, PlaceInfo[]> {
  const mine = g.haunts.length ? places.filter((p) => g.haunts.includes(p.id) || g.work.includes(p.id)) : places;
  const by: Record<string, PlaceInfo[]> = { work: [], food: [], fun: [] };
  for (const p of mine) {
    if (g.work.length && g.work.includes(p.id)) { by.work!.push(p); continue; }
    // 写明了上工地点的人：别的「上工」类地点（例如车站）对他们只是常去的地方
    const cats = g.work.length ? p.cats.filter((c) => c !== 'work') : p.cats;
    for (const c of cats.length ? cats : ['fun']) by[c]!.push(p);
  }
  // 某种用途一个地方都没有：在常去的地方里随便待着
  for (const c of ['work', 'food', 'fun']) if (!by[c]!.length) by[c] = mine.filter((p) => !g.work.includes(p.id));
  return by;
}

/** 这类人此刻的理想分布：去处 → 权重 */
export function desire(g: PopGroup, st: PopulaceState, inp: StepInput, intents: PopIntent[] = st.intents): Record<string, number> {
  const r = routine(g.rhythm, inp.hour);
  const by = targetsOf(g, inp.places);
  const w: Record<string, number> = {};
  for (const c of ['work', 'food', 'fun'] as const) for (const p of by[c]!) w[p.id] = (w[p.id] || 0) + r[c] / by[c]!.length;
  const fear = st.mood[g.id]?.fear || 0;
  const { timid, curious, social } = g.traits;
  for (const p of inp.places) {
    if (!p.active) { delete w[p.id]; continue; }
    const pull = inp.pull[p.id] || 0, push = inp.push[p.id] || 0;
    // 节日、聚集这样的大事，不常去的人也会去凑热闹
    let base = Math.max(w[p.id] || 0, pull >= 1 ? 0.04 * pull * (0.5 + social) : 0);
    if (!base) continue;
    let m = pull * (0.4 + 0.6 * Math.max(curious, social)) - push * (0.5 + timid);
    m += p.outdoor ? inp.outdoor * 0.8 : Math.max(0, -inp.outdoor) * 0.3;
    for (const it of intents) if (it.loc === p.id && (!it.group || it.group === g.id)) m += it.weight * 1.5;
    if (p.state === 'closed') base = 0;
    else if (p.state === 'damaged') base *= 0.4;
    else if (p.state === 'ruin') base *= 0.15 * curious;
    w[p.id] = base * Math.exp(clamp(m, -5, 3));
  }
  // 害怕的时候、天不好的时候更愿意待在家里
  w[HOME] = r.home * Math.exp(clamp(fear * 2 * (0.5 + timid) + Math.max(0, -inp.outdoor) * 0.4, 0, 3));
  return w;
}

/** 更新一类人的情绪 */
export function updateMood(g: PopGroup, st: PopulaceState, inp: StepInput): PopMood {
  const m = (st.mood[g.id] ||= { fear: 0, joy: 0.3, anger: 0 });
  let src = 0;
  for (const p of inp.places) src = Math.max(src, (inp.push[p.id] || 0) * affinity(g, p.id));
  const morale = Math.max(0, (45 - inp.morale) / 60);
  // 危险叠加会饱和：一个游荡的威胁约 0.4，扩散中的事件约 0.7，几处一起才接近上限
  const fearT = Math.min(inp.fearCap, inp.fearCap * (1 - Math.exp(-src * (0.6 + 0.8 * g.traits.timid) / 2)) + morale);
  m.fear = clamp(m.fear + (fearT - m.fear) * (fearT > m.fear ? 0.35 : 0.12), 0, inp.fearCap);
  const joyT = clamp(0.3 + inp.joy * 0.7 + 0.15 * Math.sign(inp.outdoor) - m.fear * 0.3, 0, 1);
  m.joy = clamp(m.joy + (joyT - m.joy) * 0.3, 0, 1);
  const angerT = clamp(inp.anger + (inp.supplies < 40 ? (40 - inp.supplies) / 80 : 0) + ((st.fearHours[g.id] || 0) >= 24 ? 0.3 : 0), 0, 1);
  m.anger = clamp(m.anger + (angerT - m.anger) * 0.1, 0, 1);
  for (const k of ['fear', 'joy', 'anger'] as const) m[k] = Math.round(m[k] * 1000) / 1000;
  return m;
}

/** 一小时的结算：更新情绪、出城与回来、按理想分布挪人。返回新开始的人流 */
export function step(st: PopulaceState, cfg: PopulaceConfig, inp: StepInput): Flow[] {
  const flows: Flow[] = [];
  const active = new Set(inp.places.filter((p) => p.active).map((p) => p.id));
  const placeById = new Map(inp.places.map((p) => [p.id, p]));
  const all = cfg.groups.reduce((s, x) => s + groupTotal(st, x.id), 0);
  const inFlight = (g: string, to: string) => st.flows.reduce((s, f) => s + (f.group === g && f.to === to ? f.n : 0), 0);
  const emit = (g: PopGroup, from: string, to: string, n: number, cause: string) => {
    if (n <= 0 || from === to) return;
    add(st, from, g.id, -n);
    const id = ++st.seq;
    const start = inp.t + (hash(`${g.id}|${from}|${to}|${inp.hour}`) % 40);
    const f: Flow = { id, group: g.id, from, to, n, start, eta: start + Math.max(3, Math.round(inp.travel(from, to))), cause };
    st.flows.push(f);
    flows.push(f);
  };
  for (const g of cfg.groups) {
    const mood = updateMood(g, st, inp);
    const leaveAt = inp.fearCap * 0.65;
    st.fearHours[g.id] = mood.fear >= leaveAt ? (st.fearHours[g.id] || 0) + 1 : 0;
    const here = (place: string) => st.at[place]?.[g.id] || 0;

    // 去处：家 + 醒着的区域里的地点（休眠区域里的人原地不动）
    const buckets = [HOME, ...inp.places.filter((p) => active.has(p.id)).map((p) => p.id)];
    const cur = buckets.map((b) => here(b));
    const eff = buckets.map((b, i) => cur[i]! + inFlight(g.id, b));
    let inTown = eff.reduce((s, n) => s + n, 0);

    // 来访的人：按钟点和节日进城、离开
    if (g.rhythm === 'visitor') {
      const total = inTown + here(OUT) + inFlight(g.id, OUT);
      const want = Math.round(total * visitorShare(inp.hour, inp.festival));
      if (want > inTown && here(OUT) > 0) {
        const k = Math.min(here(OUT), Math.ceil((want - inTown) * 0.5));
        const ws = desire(g, st, inp);
        const ids = buckets.slice(1);
        const parts = allocate(k, ids.map((id) => ws[id] || 0));
        ids.forEach((id, i) => emit(g, OUT, id, parts[i]!, 'arrive'));
        continue;
      }
      if (want < inTown) {
        const k = Math.ceil((inTown - want) * 0.5);
        const order = buckets.map((b, i) => [b, cur[i]!] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
        let left = k;
        for (const [b, n] of order) { const x = Math.min(n, left); emit(g, b, OUT, x, 'depart'); left -= x; if (!left) break; }
        continue;
      }
    } else {
      // 害怕了太久：有人搬走；平静下来、人心安定了：有人回来
      if ((st.fearHours[g.id] || 0) >= 24 && inTown > 0) {
        const k = Math.max(1, Math.ceil(inTown * 0.01));
        const fromHome = Math.min(here(HOME), k);
        emit(g, HOME, OUT, fromHome, 'leave');
        if (k > fromHome) {
          const big = buckets.slice(1).map((b) => [b, here(b)] as const).sort((a, b) => b[1] - a[1])[0];
          if (big && big[1] > 0) emit(g, big[0], OUT, Math.min(big[1], k - fromHome), 'leave');
        }
        continue;
      }
      if (mood.fear < inp.fearCap * 0.4 && inp.morale >= 45 && here(OUT) > 0) emit(g, OUT, HOME, Math.max(1, Math.ceil(here(OUT) * 0.03)), 'return');
    }
    if (inTown <= 0) continue;

    // 理想分布：按权重分人，超过容量的部分回家
    const ws = desire(g, st, inp);
    const weights = buckets.map((b) => ws[b] || 0);
    if (weights.every((w) => w <= 0)) weights[0] = 1;
    const target = allocate(inTown, weights);
    // 容量按全体群众算；这一类人能占的部分按它在全体里的比例
    const ratio = groupTotal(st, g.id) / Math.max(1, all);
    for (let i = 1; i < buckets.length; i++) {
      const share = Math.max(1, Math.round(placeById.get(buckets[i]!)!.cap * ratio));
      if (target[i]! > share) { target[0]! += target[i]! - share; target[i] = share; }
    }
    // 挪人：多出来的人按惯性走一部分（越害怕走得越快），只有真在那儿的人能走
    const inertia = Math.min(0.7, 0.35 + 0.35 * mood.fear);
    const surplus = buckets.map((_, i) => Math.min(cur[i]!, Math.max(0, eff[i]! - target[i]!)));
    const deficit = buckets.map((_, i) => Math.max(0, target[i]! - eff[i]!));
    const sumS = surplus.reduce((s, n) => s + n, 0), sumD = deficit.reduce((s, n) => s + n, 0);
    const movers = Math.min(sumD, Math.ceil(sumS * inertia));
    if (movers <= 0) continue;
    const out = allocate(movers, surplus).map((n, i) => Math.min(n, surplus[i]!));
    const inn = allocate(movers, deficit);
    const src = out.map((n, i) => [i, n] as [number, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const dst = inn.map((n, i) => [i, n] as [number, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    let si = 0, di = 0;
    while (si < src.length && di < dst.length) {
      const k = Math.min(src[si]![1], dst[di]![1]);
      const to = buckets[dst[di]![0]]!;
      const why = (inp.pull[to] || 0) >= 1.5 ? 'gather' : (inp.push[buckets[src[si]![0]]!] || 0) >= 1 ? 'flee' : 'routine';
      emit(g, buckets[src[si]![0]]!, to, k, why);
      src[si]![1] -= k; dst[di]![1] -= k;
      if (!src[si]![1]) si++;
      if (!dst[di]![1]) di++;
    }
  }
  return flows;
}

/** 记下各地点今天的人数高峰；换日时把昨天的高峰并进「平常的高峰」，只留最近 4 天 */
export function notePeaks(st: PopulaceState, day: number, places: string[]): void {
  const today = (st.peaks[day] ||= {});
  for (const id of places) {
    const n = countAt(st, id);
    if (n > (today[id] || 0)) today[id] = n;
  }
  const y = st.peaks[day - 1];
  if (y && st.normDay < day - 1) {
    for (const [id, n] of Object.entries(y)) st.norm[id] = st.norm[id] != null ? Math.round(st.norm[id]! * 0.7 + n * 0.3) : n;
    st.normDay = day - 1;
  }
  for (const d of Object.keys(st.peaks).map(Number)) if (d < day - 3) delete st.peaks[d];
}

/** 过期的意图、聚集、传闻、伤亡记录 */
export function prune(st: PopulaceState, t: number, day: number): void {
  st.intents = st.intents.filter((x) => x.until > t);
  st.gatherings = st.gatherings.filter((x) => x.until > t);
  st.casualties = st.casualties.filter((x) => t - x.t < 2880);
  // 传闻慢慢淡去（每小时可信度 ×0.99），太淡的忘掉；最多记 12 条
  for (const b of st.beliefs) b.confidence = Math.round(b.confidence * 0.99 * 1000) / 1000;
  st.beliefs = st.beliefs.filter((b) => b.confidence >= 0.15).sort((a, b) => b.confidence - a.confidence || b.since - a.since).slice(0, 12);
  for (const [k, days] of Object.entries(st.topics)) { const keep = days.filter((d) => d > day - 7); if (keep.length) st.topics[k] = keep; else delete st.topics[k]; }
}

/** 长期被议论的话题（最近 4 天里至少 3 天出现过） */
export function persistentTopic(st: PopulaceState, day: number): string | null {
  const hit = Object.entries(st.topics).map(([k, ds]) => [k, new Set(ds.filter((d) => d > day - 4)).size] as const).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  return hit[0]?.[0] || null;
}

/** 按群众的伤亡扣人：从这个地点按类别比例扣，返回实际扣掉的人数 */
export function harm(st: PopulaceState, loc: string, n: number, t: number): number {
  const here = st.at[loc] || {};
  const total = Object.values(here).reduce((s, x) => s + x, 0);
  const k = Math.min(n, total);
  if (k <= 0) return 0;
  const ids = Object.keys(here);
  const parts = allocate(k, ids.map((id) => here[id]!)).map((x, i) => Math.min(x, here[ids[i]!]!));
  let done = 0;
  ids.forEach((id, i) => { add(st, loc, id, -parts[i]!); done += parts[i]!; });
  st.dead[loc] = (st.dead[loc] || 0) + done;
  st.casualties.push({ t, loc, n: done });
  if (st.casualties.length > 60) st.casualties.shift();
  return done;
}

/** 群众听到一条传闻：同一个话题以更新的为准，可信度取高的 */
export function hear(st: PopulaceState, b: CrowdBelief): void {
  const old = st.beliefs.find((x) => x.about === b.about);
  if (old) { Object.assign(old, { ...b, confidence: Math.max(old.confidence, b.confidence) }); return; }
  st.beliefs.push(b);
  st.beliefs.sort((a, c) => c.confidence - a.confidence || c.since - a.since);
  if (st.beliefs.length > 12) st.beliefs.length = 12;
}
