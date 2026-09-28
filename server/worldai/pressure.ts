// 地图压力表（地图演变设计 §6.1）：地图的变化由需求驱动，而不是随机发生。每个游戏日算一次：
//   空地紧张：最近选址失败的次数、主地图上可建空地的比例      → 清地、扩展、相邻的地图
//   住处紧张：人员流动找住处时满员的次数、住处的平均人数      → 新建 / 改建住处
//   闲置建筑：没人住、没人在这里做事、几天没人去的建筑        → 改建、停业、拆除
//   破败：受损 / 废墟持续的天数                               → 修复或清除
//   走得远：居民日常一趟路的平均格数比开始时明显变长          → 修路、架桥
// 结果写进架构师的提示词、显示在建设面板；压力明显时每两天最多交给架构师一个意图。
import { T } from './../worldgen/tiles.ts';
import type { Town } from '../sim.ts';

/** 当天算出来的压力 */
export interface PressureNow {
  day: number;
  size: string;
  freeRatio: number;
  fails: number;
  perHome: number;
  full: number;
  idle: Array<{ id: string; name: string }>;
  decay: Array<{ id: string; name: string; state?: string; days: number }>;
  walk: number | null;
  walkRatio: number | null;
}
/** 存档 mapState.pressure */
export interface PressureState {
  day: number;
  /** 选址失败、住处满员发生在哪几天 */
  placeFails: number[];
  homeFull: number[];
  /** 游戏日 → 地点 → 到访次数 */
  visits: Record<string, Record<string, number>>;
  /** 游戏日 → 走路的趟数与总格数 */
  walks: Record<string, { n: number; sum: number }>;
  walkBaseDay?: number;
  lastIntentDay: number;
  lastIntent?: { key: string; text: string };
  now: PressureNow | null;
}

const KEEP_DAYS = 14;
const IDLE_DAYS = 5;
const INTENT_GAP_DAYS = 2;

export class MapPressure {
  declare town: Town;
  constructor(town: Town) { this.town = town; }

  get st(): PressureState {
    const m = (this.town.mapState ||= {});
    return (m.pressure ||= { day: 0, placeFails: [], homeFull: [], visits: {}, walks: {}, lastIntentDay: -99, now: null });
  }

  // ---------- 记录 ----------
  placeFailed() { this.st.placeFails.push(this.town.day); this.trim(); }
  homeFull() { this.st.homeFull.push(this.town.day); this.trim(); }
  visit(locId: string | null | undefined): void {
    if (!locId) return;
    const d = (this.st.visits[this.town.day] ||= {});
    d[locId] = (d[locId] || 0) + 1;
  }
  walk(len: number): void {
    if (!(len > 0)) return;
    const w = (this.st.walks[this.town.day] ||= { n: 0, sum: 0 });
    w.n++; w.sum += len;
  }
  trim() {
    const min = this.town.day - KEEP_DAYS;
    const st = this.st;
    st.placeFails = st.placeFails.filter((d) => d > min);
    st.homeFull = st.homeFull.filter((d) => d > min);
    for (const k of Object.keys(st.visits)) if (Number(k) <= min) delete st.visits[k];
    for (const k of Object.keys(st.walks)) if (Number(k) <= min && Number(k) !== st.walkBaseDay) delete st.walks[k];
  }

  // ---------- 计算 ----------
  compute(): PressureNow {
    const town = this.town;
    const st = this.st;
    const day = town.day;
    const spec = town.spec;
    const w = town.world;
    // 空地：可以建房、没有东西的草地占全图的比例
    let free = 0;
    const occupied = new Set(w.objects.map((o) => o.y * w.W + o.x));
    for (let i = 0; i < w.W * w.H; i++) if ((w.tiles[i] === T.GRASS || w.tiles[i] === T.FLOWER) && w.walk[i] && !occupied.has(i)) free++;
    const freeRatio = free / (w.W * w.H);
    const fails = st.placeFails.filter((d) => d > day - 7).length;
    // 住处
    const people = spec.personas.filter((p) => p.kind !== 'creature' && p.status !== 'departed');
    const homes = new Set(people.map((p) => p.home));
    const perHome = homes.size ? people.length / homes.size : 0;
    const full = st.homeFull.filter((d) => d > day - 7).length;
    // 闲置：没人住、没人工作、最近 IDLE_DAYS 天没人去
    const visited = new Set<string>();
    for (let d = day - IDLE_DAYS; d <= day; d++) for (const k of Object.keys(st.visits[d] || {})) visited.add(k);
    const used = new Set(people.flatMap((p) => [p.home, p.work]));
    const trackedSince = Math.min(...Object.keys(st.visits).map(Number), day);
    const idle = day - trackedSince >= IDLE_DAYS
      ? w.buildings.filter((b) => !used.has(b.id) && !visited.has(b.id) && b.state !== 'ruin').map((b) => ({ id: b.id, name: b.name }))
      : [];
    // 破败：受损 / 废墟从哪天开始（最后一次改状态的操作）
    const decay = w.buildings.filter((b) => b.state === 'damaged' || b.state === 'ruin').map((b) => {
      const op = [...town.specOps].reverse().find((r) => r.op === 'setBuildingState' && (r.args as { id: string }).id === b.id);
      return { id: b.id, name: b.name, state: b.state, days: op ? day - (Math.floor(op.t / 1440) + 1) : 0 };
    });
    // 走得远：最近 3 天一趟路的平均格数，与最早记录的那天相比
    if (st.walkBaseDay == null) { const first = Object.keys(st.walks).map(Number).sort((a, b) => a - b)[0]; if (first != null && first < day) st.walkBaseDay = first; }
    const avg = (ds: number[]): number | null => { let n = 0, s = 0; for (const d of ds) { const x = st.walks[d]; if (x) { n += x.n; s += x.sum; } } return n ? s / n : null; };
    const recent = avg([day - 1, day - 2, day - 3].filter((d) => d !== st.walkBaseDay));
    const base = st.walkBaseDay != null ? avg([st.walkBaseDay]) : null;
    const walkRatio = recent && base ? recent / base : null;
    const size = `${w.W}×${w.H}`;
    st.now = { day, size, freeRatio: Math.round(freeRatio * 100) / 100, fails, perHome: Math.round(perHome * 10) / 10, full, idle, decay, walk: recent ? Math.round(recent) : null, walkRatio: walkRatio ? Math.round(walkRatio * 100) / 100 : null };
    st.day = day;
    return st.now;
  }

  /** 最突出的一个需求：{ key, text（给架构师的意图） } 或 null */
  top(p: PressureNow | null = this.st.now): { key: string; text: string } | null {
    if (!p) return null;
    const place = this.town.spec.voice?.place || '小镇';
    if (p.full >= 2 || p.perHome >= 2.6) return { key: 'homes', text: `${place}的住处快住满了（最近 ${p.full} 次有人找不到空房），给新来的人盖或改一处住处` };
    if (p.fails >= 2 || p.freeRatio < 0.05) return { key: 'space', text: `${place}的空地快用完了（最近 ${p.fails} 次找不到地方建房），考虑清理树丛腾地方、向外扩展地图，或者在已经到头的一侧开辟相邻的地图` };
    const longDecay = p.decay.find((d) => d.days >= 3);
    if (longDecay) return { key: 'decay', text: `「${longDecay.name}」${longDecay.state === 'ruin' ? '成了废墟' : '受损'}已经 ${longDecay.days} 天了，修好它，或者清走另作他用` };
    if (p.idle.length) return { key: 'idle', text: `「${p.idle[0]!.name}」好几天没人去了，考虑改建成大家用得上的地方` };
    if (p.walkRatio && p.walkRatio >= 1.3) return { key: 'walk', text: `居民每天走的路比以前远了不少（平均 ${p.walk} 格），修一条近路或者架座桥` };
    return null;
  }

  /** 每天一次：算压力；压力明显时交给架构师一个意图（每两天最多一个；已经有地图相关的提案在处理时不交） */
  daily(): void {
    const town = this.town;
    const p = this.compute();
    const t = this.top(p);
    if (!t || !town.architect || town.day - this.st.lastIntentDay < INTENT_GAP_DAYS) return;
    const busy = town.proposalSystem.open().length > 0 || (town.architectQueue || []).length > 0;
    if (busy) return;
    const err = town.architect.enqueue(t.text, 'planner');
    if (!err) { this.st.lastIntentDay = town.day; this.st.lastIntent = t; }
  }

  /** 写进架构师提示词的一段 */
  text(): string {
    const p = this.st.now;
    if (!p) return '';
    const lines = [`地图 ${p.size}，可建空地约占 ${Math.round(p.freeRatio * 100)}%${p.fails ? `，最近 7 天有 ${p.fails} 次找不到地方建房` : ''}`,
      `每处住处平均住 ${p.perHome} 人${p.full ? `，最近有 ${p.full} 次新来的人找不到空房` : ''}`];
    if (p.idle.length) lines.push(`好几天没人去的建筑：${p.idle.slice(0, 4).map((x) => x.name).join('、')}`);
    if (p.decay.length) lines.push(`受损 / 废墟：${p.decay.map((x) => `${x.name}（${x.days} 天）`).join('、')}`);
    if (p.walk) lines.push(`居民一趟路平均 ${p.walk} 格${p.walkRatio ? `（是最初的 ${p.walkRatio} 倍）` : ''}`);
    return `地图现状：\n${lines.map((l) => `- ${l}`).join('\n')}`;
  }

  view() { return this.st.now ? { ...this.st.now, top: this.top()?.text || null } : null; }
}
