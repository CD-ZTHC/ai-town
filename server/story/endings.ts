// 结局（docs/design/epic-outline.md §4）：每个游戏小时判定终局分支；条件连续满足 for 天后触发终幕，
// 终幕结束后世界冻结（主循环不再推进），史诗写大结局；之后可以开启下一部。
// 终局分支以大纲里的 endings 为准（没有大纲时用世界包的 endings）；世界包没有写结局的世界永不完结。
import { testExpr } from '../kernel/rules.ts';
import type { Town } from '../sim.ts';
import type { EndingDef, EndState } from '../types/story.ts';

export const DEFAULT_FINALE_HOURS = 12;

export function freshEnd(): EndState {
  return { held: {}, triggered: null, ended: null, part: 1, history: [] };
}

export class EndingSystem {
  declare town: Town;
  declare lastHour: number;
  constructor(town: Town) { this.town = town; this.lastHour = -1; }

  get st(): EndState { return this.town.endState; }
  /** 当前生效的终局分支 */
  list(): EndingDef[] { return this.town.outline?.endings ?? this.town.spec.endings ?? []; }
  /** 终幕进行中（导演、人员流动停下，世界继续运行让居民反应） */
  get finale(): boolean { return Boolean(this.st.triggered && !this.st.ended); }
  get ended(): boolean { return Boolean(this.st.ended); }

  /** 条件此刻是否满足（表达式出错按不满足） */
  holds(e: EndingDef): boolean {
    try { return testExpr(this.town, e.when); } catch (err) { console.warn(`[ending] ${e.id} 的条件出错：`, (err as Error).message); return false; }
  }

  /** 每个游戏小时：判定、推进终幕 */
  tick(): void {
    const town = this.town;
    const hour = Math.floor(town.t / 60);
    if (hour === this.lastHour) return;
    this.lastHour = hour;
    const st = this.st;
    if (st.ended) return;
    if (st.triggered) {
      if (town.t >= st.triggered.until) this.freeze();
      return;
    }
    for (const e of this.list()) {
      if (!this.holds(e)) { delete st.held[e.id]; continue; }
      st.held[e.id] ??= town.day;
      if (town.day - st.held[e.id]! >= (e.for || 0)) { this.trigger(e); return; }
    }
  }

  /** 结局条件达成：终幕开始 */
  trigger(e: EndingDef): void {
    const town = this.town;
    const hours = e.finale?.hours ?? DEFAULT_FINALE_HOURS;
    this.st.triggered = { id: e.id, title: e.title, kind: e.kind, t: Math.floor(town.t), day: town.day, until: town.t + hours * 60 };
    const text = e.finale?.text || `${e.kind === 'bad' ? '🌑' : '🌅'} 故事走到了尽头：「${e.title}」`;
    town.log('ending', `${e.kind === 'bad' ? '🌑' : '🌅'} 终幕：「${e.title}」${e.finale?.text ? `——${e.finale.text}` : ''}`, { ending: e.id, kind: e.kind });
    try { town.stage({ template: 'moment', target: 'at', text: text.slice(0, 40), priority: 'major' }, { at: town.world.gate ? { x: town.world.gate.x, y: town.world.gate.y, inside: null, region: 'town' } : null }, { source: 'ending' }); } catch { /* 舞台演出失败不影响结局 */ }
    town.emit('story');
    if (hours <= 0) this.freeze();
  }

  /** 终幕结束：世界冻结，史诗写大结局 */
  freeze(): void {
    const town = this.town;
    const tr = this.st.triggered;
    if (!tr || this.st.ended) return;
    this.st.ended = { id: tr.id, title: tr.title, kind: tr.kind, t: Math.floor(town.t), day: town.day };
    this.st.history.push({ part: this.st.part, id: tr.id, title: tr.title, kind: tr.kind, day: town.day });
    town.log('ending', `📕 故事完结：「${tr.title}」`, { ending: tr.id, kind: tr.kind });
    town.epicSys.requestFinale();
    town.emit('ended', { ...this.st.ended, part: this.st.part });
    town.emit('story');
  }

  /** 开启下一部：解除冻结，部数加一 */
  nextPart(): void {
    const st = this.st;
    st.ended = null;
    st.triggered = null;
    st.held = {};
    st.part += 1;
    this.lastHour = -1;
    this.town.emit('ended', null);
    this.town.emit('story');
  }

  /** 给管理者看的结局进度 */
  progress(): Array<EndingDef & { now: boolean; heldDays: number | null }> {
    return this.list().map((e) => ({ ...e, now: !this.st.ended && this.holds(e), heldDays: this.st.held[e.id] != null ? this.town.day - this.st.held[e.id]! : null }));
  }

  /** 写进导演提示词的结局进度（不写条件表达式，写给导演看的提示） */
  directorBlock(): string {
    const list = this.list();
    if (!list.length || this.st.ended) return '';
    return `\n这个故事可能的结局（只给你看；你只能往这些方向安排局面，不能直接宣布结局）：\n${list.map((e) => `- 「${e.title}」（${{ good: '好结局', bad: '坏结局', neutral: '结局' }[e.kind]}）${e.hint ? `：${e.hint}` : ''}${this.st.held[e.id] != null ? `【条件已满足 ${this.town.day - this.st.held[e.id]!} 天】` : ''}`).join('\n')}`;
  }

  view(full: boolean) {
    const st = this.st;
    return {
      triggered: st.triggered ? { id: st.triggered.id, title: st.triggered.title, kind: st.triggered.kind, day: st.triggered.day } : null,
      ended: st.ended, part: st.part, history: st.history,
      ...(full ? { endings: this.progress() } : {}),
    };
  }
}
