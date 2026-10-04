// 区域的激活与休眠（docs/design/adventure.md §3.5）：区域不限数量，一段时间没人去的区域进入休眠，
// 不再模拟里面的威胁、生物和刷怪；重新被访问时按流逝的时间推算出最新状态，推算不了的部分交给 AI 推演。
// 推算规则只依赖显式输入（可以单独测试）；Town 上的方法负责判断有没有人在、唤醒、发事件、调模型。
import * as llm from '../llm.ts';
import { SCHEMAS } from '../llm-schemas.ts';
import { systemPrompt } from './cognition.ts';
import { expeditionsOf } from '../kernel/adventure-spec.ts';
import type { Town } from '../sim.ts';
import type { ThreatInstance } from '../types/town.ts';
import type { ThreatType } from '../types/spec.ts';
import type { ModelJSON } from '../llm.ts';

export const REGION_IDLE = 6 * 60; // 游戏分钟：这么久没人去就休眠
export const REGION_AI_DAYS = 2; // 休眠超过这么多天，唤醒时请模型推演
const AI_GAP = 1440; // 同一个区域两次推演至少隔一天
const AI_PER_DAY = 4; // 每个世界每游戏天最多推演几次
const THREAT_REGEN = 0.1; // 休眠期间会死的威胁每小时回复 hp 上限的 10%
/** 模型推演能提出的世界操作（白名单） */
export const WAKE_OPS: readonly string[] = ['setBuildingState', 'restoreBuilding', 'plantGrove', 'addOutdoorPlace', 'addCanon'];
const MAX_WAKE_CHANGES = 3;
const MAX_WAKE_SPAWNS = 2;
const canAsk = () => llm.enabled() && llm.budgetLeft() > 0 && !llm.isBusy();

// ---------- 规则（只依赖显式输入） ----------
/** 休眠期间的会死的威胁：按时长回血，Boss 的阶段重置，路径清空（位置由调用方放回常出没的地点） */
export function catchUpThreat(inst: { hp: number | null; phase?: unknown; path: ThreatInstance['path'] }, def: Pick<ThreatType, 'mortal' | 'hp'>, minutes: number): void {
  inst.path = [];
  if (!def.mortal || inst.hp == null || !def.hp) return;
  inst.hp = Math.min(def.hp, Math.round(inst.hp + def.hp * THREAT_REGEN * (minutes / 60)));
  if (inst.hp >= def.hp) delete inst.phase;
}

/** 已征服区域的野怪按刷新间隔补回来几只（只补到上限） */
export const refillCount = (minutes: number, every: number, live: number, max: number): number => Math.max(0, Math.min(max - live, Math.floor(minutes / Math.max(1, every))));

/** 校验模型给的一条变化：只能是白名单里的操作，而且只能动这个区域里的东西；返回错误或 null */
export function checkWakeChange(c: unknown, region: string, locRegion: (id: string) => string, hasBuilding: (id: string) => boolean): string | null {
  if (!c || typeof c !== 'object') return '不是对象';
  const { op, args } = c as { op?: unknown; args?: Record<string, unknown> };
  if (!WAKE_OPS.includes(String(op))) return `不能用 ${String(op)}`;
  if (!args || typeof args !== 'object') return '缺少 args';
  if (op === 'addCanon') return typeof args.text === 'string' && args.text.length <= 100 ? null : 'text 缺失或过长';
  if (op === 'setBuildingState' || op === 'restoreBuilding') {
    const id = String(args.id || '');
    if (!hasBuilding(id) || locRegion(id) !== region) return `不是这个区域里的建筑：${id}`;
    if (op === 'setBuildingState' && !['closed', 'damaged'].includes(String(args.state))) return '只能改成 closed / damaged';
    return null;
  }
  const near = String(args.near || '');
  return locRegion(near) === region ? null : `near 不在这个区域：${near}`;
}

// ---------- Town 上的接口 ----------
export class Dormancy {
  /** 区域是否激活（主地图永远激活；没有记录的区域视为激活） */
  regionActive(this: Town, id: string | null | undefined): boolean {
    if (!id || id === 'town') return true;
    return this.regionState?.[id]?.active !== false;
  }

  /** 这个区域此刻有没有人：居民（包括正在去那边的）、化身、战斗 */
  regionPresence(this: Town, id: string): boolean {
    if (this.agents.some((a) => (a.region || 'town') === id || a.hop?.to === id || (a.dest && !a.dest.hop && a.dest.locId && this.locRegion(a.dest.locId) === id))) return true;
    if (this.avatars.list.some((v) => v.region === id || v.hop?.to === id)) return true;
    return (this.fights || []).some((f) => f.region === id);
  }

  /** 每游戏分钟：有人的区域刷新「最近有人」，空了太久的区域休眠，休眠的区域有人来了就唤醒 */
  dormancyTick(this: Town) {
    const rs = (this.regionState ||= {});
    for (const id of Object.keys(this.regions)) {
      if (id === 'town') continue;
      const r = (rs[id] ||= { active: true, seen: Math.floor(this.t) });
      if (this.regionPresence(id)) {
        r.seen = Math.floor(this.t);
        if (!r.active) this.wakeRegion(id, 'visit');
      } else if (r.active && this.t - r.seen > REGION_IDLE) this.sleepRegion(id);
    }
    for (const id of Object.keys(rs)) if (!this.regions[id]) delete rs[id];
  }

  /** 观众在前端打开了这个区域：算作有人来过（休眠的就唤醒） */
  watchRegion(this: Town, id: string): boolean {
    if (!this.regions[id] || id === 'town') return Boolean(this.regions[id]);
    const r = ((this.regionState ||= {})[id] ||= { active: true, seen: Math.floor(this.t) });
    r.seen = Math.floor(this.t);
    if (!r.active) this.wakeRegion(id, 'watch');
    return true;
  }

  sleepRegion(this: Town, id: string) {
    const r = this.regionState[id]!;
    r.active = false;
    r.since = Math.floor(this.t);
    for (const t of this.threats.live()) if ((t.region || 'town') === id) t.path = [];
    for (const c of this.creatures.list) if ((c.region || 'town') === id) c.path = [];
    this.emit('regions', this.regionsView());
  }

  /** 唤醒：按流逝的时间推算最新状态；休眠够久、有模型时再请模型推演这段时间发生了什么 */
  wakeRegion(this: Town, id: string, why: 'visit' | 'watch' = 'visit') {
    const r = this.regionState[id]!;
    const minutes = Math.max(0, this.t - (r.since ?? this.t));
    r.active = true;
    r.seen = Math.floor(this.t);
    delete r.since;
    this.catchUpRegion(id, minutes);
    this.emit('regions', this.regionsView());
    if (minutes >= REGION_AI_DAYS * 1440) this.wakeStory(id, minutes);
    this.hooks.emit('region.wake', { region: id, minutes, why });
  }

  /** 推算：威胁回血、回到常出没的地点；生物回到常去的地方；已征服区域的野怪补回来 */
  catchUpRegion(this: Town, id: string, minutes: number) {
    for (const inst of this.threats.live()) {
      if ((inst.region || 'town') !== id) continue;
      const def = this.threats.def(inst);
      if (!def) continue;
      catchUpThreat(inst, def, minutes);
      const home = def.haunt.filter((h) => this.locRegion(h) === id);
      const s = home.length ? this.threats.spotOf(home[Math.floor(this.rng() * home.length)]!) : null;
      if (s) { inst.x = s.x; inst.y = s.y; }
    }
    for (const c of this.creatures.list) if ((c.region || 'town') === id) { c.path = []; c.dwellUntil = 0; }
    for (const x of expeditionsOf(this.spec)) {
      const st = this.expState(x);
      for (const s of x.stages) {
        if (s.region !== id || st.stages[s.id]?.status !== 'cleared') continue;
        (s.spawns || []).forEach((sp, i) => {
          const live = this.threats.live().filter((t) => t.type === sp.threat && (t.region || 'town') === id).length;
          const n = refillCount(minutes, sp.every * 3, live, sp.max);
          const def = this.spec.threats?.[sp.threat];
          for (let k = 0; k < n && def; k++) {
            const home = (s.wild?.length ? s.wild : def.haunt).filter((h) => this.locRegion(h) === id);
            const loc = home[Math.floor(this.rng() * home.length)];
            if (loc) this.threats.spawn(sp.threat, { loc, cause: `expedition:${x.id}`, quiet: true, wild: true });
          }
          st.spawnAt[`${s.id}:${i}`] = Math.floor(this.t);
        });
      }
    }
  }

  /** AI 推演：请模型说说这段时间这里发生了什么，最多 3 条白名单里的变化、2 只普通的怪（异步；结果到了再应用） */
  wakeStory(this: Town, id: string, minutes: number) {
    const r = this.regionState[id]!;
    const adv = this.adventureState();
    if (adv.wakeAi?.day !== this.day) adv.wakeAi = { day: this.day, n: 0 };
    const name = this.regions[id]?.name || id;
    const days = Math.max(1, Math.round(minutes / 1440));
    const quiet = () => this.log('region', `🍃 ${name}安静了${days}天，没有人来过`, {});
    if (!canAsk() || (r.aiAt != null && this.t - r.aiAt < AI_GAP) || adv.wakeAi.n >= AI_PER_DAY) { quiet(); return; }
    r.aiAt = Math.floor(this.t);
    adv.wakeAi.n += 1;
    const places = Object.entries(this.spec.locations).filter(([lid]) => this.locRegion(lid) === id).slice(0, 16);
    const buildings = this.spec.buildings.filter((b) => !b.removed && (b.region || 'town') === id).map((b) => `${b.id}（${b.name}${b.state ? `，${b.state}` : ''}）`);
    const threats = Object.entries(this.spec.threats || {}).filter(([, d]) => d.mortal && !d.boss && !d.phases?.length && d.haunt.some((h) => this.locRegion(h) === id)).map(([tid, d]) => `${tid}（${d.name}）`);
    const recent = this.logs.filter((l) => String(l.text).includes(name)).slice(-6).map((l) => l.text);
    const canon = this.spec.lore.canon.slice(-6).map((c) => c.text);
    llm.chatJSON([
      systemPrompt(this.spec, false),
      { role: 'user', content: `「${name}」已经${days}天没有人来过了。根据这里的样子推演这段时间发生了什么（合乎世界设定，克制，不要凭空出现新角色）。
地点：${places.map(([lid, l]) => `${lid}（${l.name}）`).join('、') || '无'}
建筑：${buildings.join('、') || '无'}
可能出没的怪：${threats.join('、') || '无'}
最近和这里有关的事：${recent.join('；') || '无'}
设定集：${canon.join('；') || '无'}
最多 3 条变化，只能用：setBuildingState {"id","state":"closed/damaged","reason"}、restoreBuilding {"id"}、plantGrove {"near":"地点id","w","h"}、addOutdoorPlace {"id","kind","name","emoji","desc","near":"地点id"}、addCanon {"text"}；最多 2 只怪出现在某个地点。
输出 JSON：{"summary":"≤40字，这段时间这里发生了什么","changes":[{"op":"…","args":{…}}],"spawns":[{"threat":"怪的id","at":"地点id"}]}` },
    ], { label: '区域推演', schema: SCHEMAS.regionWake, maxTokens: 700, tier: 'fast', attempts: 1, timeoutMs: 30_000 })
      .then((res: ModelJSON) => this.applyWakeStory(id, res))
      .catch(() => quiet());
  }

  /** 应用模型的推演：逐条校验，不合法的直接丢弃 */
  applyWakeStory(this: Town, id: string, res: ModelJSON) {
    if (!this.regions[id]) return;
    const name = this.regions[id]!.name || id;
    const summary = String(res?.summary || '').trim().slice(0, 40);
    let applied = 0;
    for (const c of (Array.isArray(res?.changes) ? res.changes : []).slice(0, MAX_WAKE_CHANGES)) {
      const e = checkWakeChange(c, id, (x) => this.locRegion(x), (x) => this.spec.buildings.some((b) => b.id === x && !b.removed));
      if (e) continue;
      try { this.applyWorldOp({ op: c.op, args: c.args }, { by: 'region-wake' }, { quiet: true }); applied++; } catch { /* 不合法的变化丢弃 */ }
    }
    let spawned = 0;
    for (const sp of (Array.isArray(res?.spawns) ? res.spawns : []).slice(0, MAX_WAKE_SPAWNS)) {
      const def = this.spec.threats?.[String(sp?.threat)];
      const at = String(sp?.at || '');
      if (!def?.mortal || def.boss || def.phases?.length || this.locRegion(at) !== id || !this.findLocation(at)) continue;
      if (this.threats.spawn(String(sp.threat), { loc: at, cause: 'region-wake', quiet: true, wild: true })) spawned++;
    }
    this.log('region', `🍃 ${summary || `${name}安静了很久`}`, { milestone: applied || spawned ? 'wake' : undefined });
    if (summary) { try { this.applyWorldOp({ op: 'addCanon', args: { text: `${name}：${summary}`, tags: ['区域'] } }, { by: 'region-wake' }, { quiet: true }); } catch { /* 设定集满了 */ } }
  }
}
