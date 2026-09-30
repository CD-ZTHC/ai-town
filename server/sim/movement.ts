// 日程执行与移动：当前该做什么、寻路、行走、到达、体力与勇气
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
import { findPath } from '../world.ts';
import { addMemory } from '../memory.ts';
import { clamp, rand } from './util.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent, ScheduleEntry } from '../types/agent.ts';
import type { Act, ActArgs, Convo, Fight, SaveData, ThreatInstance } from '../types/town.ts';
import type { Persona, Region } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import type { Pos } from '../kernel/effects.ts';
import type { ModelJSON } from '../llm.ts';
import type { RetrieveOptions } from '../memory.ts';

export class Movement {
  desired(this: Town, a: LiveAgent): CurEntry {
    const m = this.minute;
    // 异界角色不按人类作息：一直守在自己的地点
    if (a.kind === 'creature') {
      const p = this.spec.personas.find((x) => x.id === a.id);
      return { key: `guard-${a.work}`, location: a.work, activity: p?.idle || '静静地守着', emoji: '🌑' };
    }
    const sleep: CurEntry = { key: `sleep-${this.day}-${m < 12 * 60 ? 'am' : 'pm'}`, location: a.home, activity: '睡觉', emoji: '😴', sleep: true };
    if (m >= 23 * 60 || m < this.rhythm.plan) return sleep;
    const s = a.scheduleDay === this.day ? a.schedule : [];
    if (!s.length) {
      if (m < 6 * 60 + 30) return sleep;
      if (m >= this.dayEnd) return sleep;
      return { key: `wake-${this.day}`, location: a.home, activity: '起床，想想今天要做什么', emoji: '🌅' };
    }
    const e = s.find((e) => m >= e.start && m < e.end);
    if (e) return { ...e, key: `${this.day}-${e.start}-${e.location}-${e.activity}` };
    if (m < s[0]!.start) return m < 6 * 60 + 30 ? sleep : { key: `early-${this.day}`, location: a.home, activity: '在家吃早饭', emoji: '🍳' };
    if (m >= s[s.length - 1]!.end) return m >= this.dayEnd ? sleep : { key: `eve-${this.day}`, location: a.home, activity: '在家休息', emoji: '🛋️' };
    const prev = [...s].reverse().find((e) => e.end <= m)!;
    return { ...prev, key: `${this.day}-gap-${prev.end}`, activity: '随便转转', emoji: '🚶', act: undefined };
  }

  updateAgent(this: Town, a: LiveAgent, dt: number): void {
    this.updateBody(a, dt);
    if (a.convoId) return;
    const e = this.desired(a);
    if (e.key !== a.curKey) {
      if (a.researching && a.researching.key !== e.key) this.finishResearch(a);
      a.curKey = e.key;
      a.curEntry = e;
      const locId = this.resolveLoc(a, e.location);
      if (a.locId === locId && a.status !== 'walking') {
        this.settle(a, e);
        this.runAct(a, e);
      } else {
        this.navigate(a, locId, e);
      }
    }
    if (a.status === 'walking') this.step(a, dt);
    // 对象还没到场的行动：每 10 游戏分钟重试一次，直到这条日程结束
    const pa = a.pendingAct;
    if (pa && pa.key === a.curKey && a.status === 'acting' && this.t >= pa.next) this.runAct(a, a.curEntry!, true);
  }

  /** 体力随活动消耗、睡觉恢复；勇气缓慢回归平常 */
  updateBody(this: Town, a: LiveAgent, dt: number) {
    const b = a.body;
    const rate = a.status === 'sleeping' ? 0.2 : a.status === 'walking' ? -0.05 : -0.025;
    b.stamina = clamp(b.stamina + rate * dt, 0, 100);
    b.courage = clamp(b.courage + (50 - b.courage) * 0.002 * dt, 0, 100);
    // 伤势慢慢恢复（睡觉时快一些），恢复到一半就不再是重伤
    if (b.hp < 100) {
      b.hp = clamp(b.hp + (a.status === 'sleeping' ? 0.02 : 0.008) * dt, 0, 100);
      if (b.hp >= 50 && b.conditions.includes('重伤')) b.conditions = b.conditions.filter((c) => c !== '重伤');
    }
    const tired = b.conditions.includes('疲惫');
    if (!tired && b.stamina < 20) b.conditions = [...b.conditions, '疲惫'];
    else if (tired && b.stamina > 40) b.conditions = b.conditions.filter((c) => c !== '疲惫');
    // 受惊、晕倒会随勇气和体力恢复而消失
    if (b.conditions.includes('受惊') && b.courage >= 45) b.conditions = b.conditions.filter((c) => c !== '受惊');
    if (b.conditions.includes('晕倒') && b.stamina > 35) b.conditions = b.conditions.filter((c) => c !== '晕倒');
  }

  settle(this: Town, a: LiveAgent, e: CurEntry) {
    a.moving = false;
    a.status = e.sleep ? 'sleeping' : 'acting';
    a.action = { text: e.activity, emoji: e.emoji || '🙂' };
    this.noteSettle(a, e);
    // 保持「不开门」的人不进屋，在门口熬一夜
    if (e.sleep && !this.hasPosture(a, 'noOpen')) {
      const home = this.world.locations[a.home]!;
      a.inside = home.indoor as string | null;
      const b = this.world.buildings.find((x) => x.id === home.indoor)!;
      a.x = b.entrance.x; a.y = b.entrance.y;
    }
  }

  navigate(this: Town, a: LiveAgent, locId: string, e: CurEntry) {
    const loc = this.findLocation(locId)!; // resolveLoc 给出的都是存在的地点
    const here = this.worldOf(a.region);
    // 离开建筑：从入口出发
    if (a.inside) {
      const b = here.buildings.find((x) => x.id === a.inside);
      if (b) { a.x = b.entrance.x; a.y = b.entrance.y; }
      a.inside = null;
    }
    // 目的地在另一个区域：按区域图走到下一段的路口 / 通道，穿过去再继续（可能要换乘几次）
    const to = this.locRegion(locId);
    if (to !== (a.region || 'town')) {
      const step = this.routeStep(a.region || 'town', to, a);
      if (!step) { Object.assign(a, { status: 'acting', dest: null, curKey: null, moving: false }); return; }
      a.hop = { to: step.to, locId, arrive: step.b };
      a.dest = { locId: null, x: step.a.x, y: step.a.y, indoor: null, hop: true };
      a.locId = null;
      a.path = findPath(here, a.x, a.y, step.a.x, step.a.y) || [];
      a.status = 'walking';
      a.moving = true;
      a.action = { text: `前往${loc.name}（经${step.name}）`, emoji: '🌀' };
      return;
    }
    let dest: NonNullable<LiveAgent['dest']>;
    // 停业 / 受损的建筑：只有住在里面的人能进，其他人到门口
    const canEnter = loc.indoor && (!loc.closed || a.home === locId) && !this.hasPosture(a, 'noOpen');
    const indoorPreferred = canEnter && (!loc.spots.length || e.sleep || ['rain', 'storm', 'snow'].includes(this.weather) || this.minute > 19 * 60 || a.work === locId || this.rng() < 0.5);
    if (canEnter && indoorPreferred) {
      const b = here.buildings.find((x) => x.id === loc.indoor)!;
      dest = { locId, x: b.entrance.x, y: b.entrance.y, indoor: b.id };
    } else {
      const taken = new Set(this.agents.filter((o) => o !== a && o.dest).map((o) => `${o.dest!.x},${o.dest!.y}`));
      const free = loc.spots.filter((s) => !taken.has(`${s.x},${s.y}`));
      const b = loc.indoor && here.buildings.find((x) => x.id === loc.indoor);
      const s = (rand(this.rng, free.length ? free : loc.spots) || (b ? b.entrance : this.locCenter(locId)))!;
      dest = { locId, x: s.x, y: s.y, indoor: null };
    }
    a.dest = dest;
    a.locId = null;
    const p = findPath(here, a.x, a.y, dest.x, dest.y);
    if (!p) { a.x = dest.x; a.y = dest.y; a.path = []; }
    else a.path = p;
    if (p && a.kind !== 'creature') this.mapPressure?.walk(p.length);
    a.status = 'walking';
    a.moving = true;
    a.action = { text: `前往${loc.name}${e.sleep ? '' : '·' + e.activity}`, emoji: e.sleep ? '🥱' : '🚶' };
  }

  step(this: Town, a: LiveAgent, dt: number): void {
    let dist = this.params.walkSpeed * dt * (this.hasPosture(a, 'eyesClosed') ? 0.4 : 1);
    while (dist > 0 && a.path.length) {
      const n = a.path[0]!;
      const dx = n.x - a.x, dy = n.y - a.y;
      const d = Math.hypot(dx, dy);
      if (Math.abs(dx) > Math.abs(dy)) a.dir = dx > 0 ? 'right' : 'left';
      else if (d > 0.001) a.dir = dy > 0 ? 'down' : 'up';
      if (d <= dist) { a.x = n.x; a.y = n.y; a.path.shift(); dist -= d; }
      else { a.x += (dx / d) * dist; a.y += (dy / d) * dist; dist = 0; }
    }
    if (!a.path.length) this.arrive(a);
  }

  arrive(this: Town, a: LiveAgent): void {
    const e = a.curEntry!;
    if (a.dest?.hop) {
      // 走到渡口：穿过去，出现在另一个区域的渡口，继续前往目的地
      const hop = a.hop;
      a.hop = null;
      if (!hop || !this.regionOpen(hop.to)) { a.curKey = null; a.status = 'acting'; a.moving = false; a.dest = null; return; }
      const r = this.spec.regions.find((x) => x.id === hop.to) || ({} as Partial<Region>);
      const portal = !r.adjacent && hop.to !== 'town' || (a.region && a.region !== 'town' && !this.spec.regions.find((x) => x.id === a.region)?.adjacent);
      if (portal) this.emit('vfx', { preset: 'ripple', x: a.x, y: a.y, color: '#b58cff', radius: 1.5, region: a.region || 'town' });
      const at = hop.arrive || this.worldOf(hop.to).gate;
      Object.assign(a, { region: hop.to, x: at.x, y: at.y });
      if (portal) this.emit('vfx', { preset: 'ripple', x: at.x, y: at.y, color: '#b58cff', radius: 1.5, region: hop.to });
      if (hop.to !== 'town' && !a.visited?.includes(hop.to)) {
        (a.visited ||= []).push(hop.to);
        const name = this.regions[hop.to]!.name;
        addMemory(a, { t: this.t, type: 'obs', text: `第一次${r.gateName ? `穿过${r.gateName}，` : ''}来到了${name}${r.firstVisit ? `：${r.firstVisit}` : ''}`, importance: 7 });
        this.log('region', `${r.adjacent ? '🗺️' : '🌗'} ${a.name}第一次踏进了${name}`, { agents: [a.id] });
      }
      this.navigate(a, hop.locId, e);
      return;
    }
    a.moving = false;
    // 目的地先取出来：到达过程中的规则、行动、到达钩子（插件、规律型威胁）可能让这个人死去、离开或被带走，
    // 那时 a.dest 会被清空。每一步之后都确认人还在场，不在就不再继续（否则整个进程会因为读 null 而崩溃）
    const dest = a.dest;
    if (!dest) return;
    const here = () => this.agents.includes(a);
    a.locId = dest.locId;
    if (dest.indoor) { a.inside = dest.indoor; a.openedAt = this.t; }
    this.settle(a, e);
    if (!e.sleep) this.rules.onEnter(a, a.locId!);
    if (!here()) return;
    this.runAct(a, e);
    if (!here()) return;
    if (!e.sleep) this.hooks.emit('agent.arrive', { agent: a, locId: a.locId });
    if (!here()) return;
    if (a.kind !== 'creature') this.mapPressure?.visit(a.locId!);
    if (!e.sleep) {
      if (dest.indoor) a.dir = 'up';
      else a.dir = rand(this.rng, ['down', 'left', 'right', 'down']);
      if (this.t - a.lastThoughtT > 80 && this.rng() < 0.45) this.innerThought(a);
    }
  }
}
