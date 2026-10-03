// 异界生物（设计文档 5.5 / 6.2）：日常行为由规则驱动，群体心智每两小时最多调用一次 LLM。
// 遭遇结算没有死亡：结果只有 驱散 / 吓退 / 偷走东西 / 受惊 / 晕倒送诊所。
import { findPath } from '../world.ts';
import * as llm from '../llm.ts';
import { addMemory, parseHM } from '../memory.ts';
import { posOf } from '../kernel/effects.ts';
import { ratingAtLeast } from '../kernel/ratings.ts';
import type { Town } from '../sim.ts';
import type { ModelJSON } from '../llm.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { CreatureType } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import { SCHEMAS } from '../llm-schemas.ts';

/** 一只异界生物（存档 creatureList） */
export interface Creature {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  region?: string;
  dir: 'up' | 'down' | 'left' | 'right';
  moving: boolean;
  hp: number;
  /** 想去的地点 id */
  goal: string | null;
  path: Cell[];
  friendly: boolean;
  /** 白天躲起来了 */
  hidden: boolean;
  dwellUntil: number;
  fleeUntil: number;
  lastMischief: number;
  nextSeek: number;
  /** 正要去捣乱的地点 */
  target?: string;
}

/** 镜湖裂隙（存档 portalState） */
export interface Portal {
  id: 'portal';
  kind: 'portal';
  stage: string;
  x: number;
  y: number;
  spawn: Cell;
  name: string;
}

const MAX_CREATURES = 24;
const rand = <T>(rng: () => number, a: readonly T[]): T => a[Math.floor(rng() * a.length)];
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const PORTAL_TEXT: Record<string, string> = {
  crack: '镜湖湖心出现了一道细细的紫色裂纹',
  open: '🌀 镜湖裂隙张开了！',
  wide: '🌀 裂隙扩张到了整个湖心，血色的月亮升了起来',
  stable: '🌗 裂隙平静下来，成了两个世界之间的渡口',
  sealed: '✨ 裂隙在灯光中合拢了',
};

export class CreatureSystem {
  declare town: Town;
  declare thinking: boolean;
  constructor(town: Town) { this.town = town; }
  get list(): Creature[] { return (this.town.creatureList ||= []); }
  get portal(): Portal | null { return this.town.portalState || null; }
  def(c: Creature): CreatureType { return this.town.spec.creatures![c.type]!; }

  // ---------- 裂隙 ----------
  setPortal({ stage, x, y, spawn, name }: { stage: string; x?: number; y?: number; spawn?: Cell; name?: string }): void {
    const town = this.town;
    let p = this.portal;
    if (!p) {
      if (stage === 'sealed') return;
      p = town.portalState = { id: 'portal', kind: 'portal', stage, x: x ?? 54, y: y ?? 38, spawn: spawn || { x: 51, y: 37 }, name: name || '镜湖裂隙' };
    }
    p.stage = stage;
    if (name) p.name = name;
    town.emit('vfx', { preset: 'ripple', x: p.x, y: p.y, color: stage === 'sealed' ? '#ffd76a' : '#9b6bff', radius: stage === 'wide' ? 5 : 3 });
    town.log('portal', PORTAL_TEXT[stage] || `裂隙：${stage}`, {});
    if (stage === 'sealed') town.portalState = null;
    town.emit('story');
  }

  spawnPoint(): Cell {
    const p = this.portal;
    if (p) return { x: p.spawn.x, y: p.spawn.y };
    const spots = this.town.world.locations.pier?.spots || [];
    return spots.length ? { ...rand(this.town.rng, spots) } : { x: 50, y: 34 };
  }

  spawn(type: string, count = 1, goal: string | null = null): number {
    const town = this.town;
    const def = town.spec.creatures![type];
    if (!def || def.leader) return 0;
    if (def.minRating && !ratingAtLeast(town.spec.meta.rating, def.minRating)) return 0;
    let n = 0;
    for (let i = 0; i < count && this.list.length < MAX_CREATURES; i++) {
      const at = this.spawnPoint();
      this.list.push({
        id: `m${++town.seq}`, type, name: def.name, x: at.x + (this.town.rng() - 0.5), y: at.y, dir: 'down', moving: false,
        hp: def.stats.hp, goal, path: [], friendly: false, hidden: false, dwellUntil: 0, fleeUntil: 0, lastMischief: -999, nextSeek: 0,
      });
      n++;
    }
    if (!n) return 0;
    const first = !town.discovered.includes(type);
    if (first) town.discovered.push(type);
    town.log('creature', `👾 ${n} 只${def.name}从裂隙里钻了出来${first ? `（图鉴新增：${def.emoji}${def.name}）` : ''}`, {});
    town.emit('story');
    return n;
  }

  /** 剧情收尾：生物回到裂隙那边；可以留下一只友善的 */
  dismiss(keep: { type: string; name?: string; near: string } | null = null): void {
    const town = this.town;
    // 暗月界里的友善生物不受影响
    const elsewhere = this.list.filter((c) => (c.region || 'town') !== 'town');
    const n = this.list.length - elsewhere.length;
    town.creatureList = elsewhere;
    if (n) town.log('creature', `🌙 ${n} 只异界生物回到了湖的那一边`, {});
    if (keep && this.addFriend(keep)) town.log('creature', `💜 一只叫「${keep.name}」的小影灵留在了小镇`, {});
    town.emit('story');
  }

  /** 一只友善的生物，在 near 附近闲逛；region 为所在区域 */
  addFriend({ type, name, near, region = 'town' }: { type: string; name?: string; near: string; region?: string }): Creature | null {
    const town = this.town;
    if (!town.spec.creatures![type] || this.list.length >= MAX_CREATURES) return null;
    const p = town.locCenter(near) || this.spawnPoint();
    const c: Creature = {
      id: `m${++town.seq}`, type, name: String(name || '').slice(0, 8) || town.spec.creatures![type]!.name, region,
      x: p.x, y: p.y, dir: 'down', moving: false, hp: 30, goal: near, path: [], friendly: true, hidden: false, dwellUntil: 0, fleeUntil: 0, lastMischief: 0, nextSeek: 0,
    };
    this.list.push(c);
    return c;
  }

  // ---------- 每次推进 ----------
  tick(dt: number): void {
    if (!this.list.length) return;
    for (const c of this.list) this.update(c, dt);
    this.encounters();
    if (this.list.some((c) => c.hp <= 0)) this.town.creatureList = this.list.filter((c) => c.hp > 0);
    this.swarmMind();
  }

  active(def: CreatureType): boolean {
    const [a, b] = (def.behavior.active || ['00:00', '23:59']).map(parseHM) as [number, number];
    const m = this.town.minute;
    return a <= b ? m >= a && m <= b : m >= a || m <= b;
  }

  nearLight(c: { x: number; y: number; region?: string }, r = 3): boolean {
    return this.town.entities.some((e) => e.tags!.includes('light') && !e.inside && (e.region || 'town') === (c.region || 'town') && Math.hypot(e.x - c.x, e.y - c.y) <= r);
  }

  goTo(c: Creature, x: number, y: number): void {
    const p = findPath(this.town.worldOf?.(c.region) || this.town.world, c.x, c.y, x, y);
    c.path = p || [{ x, y }];
  }

  update(c: Creature, dt: number): void {
    const town = this.town;
    const def = this.def(c);
    if (!def) { c.hp = 0; return; }
    if (town.engaged?.('creature', c.id)) { c.path = []; return; } // 正在战斗（sim/combat）
    const beh = def.behavior;
    // 昼伏夜出：白天回到裂隙附近躲起来（友善的小家伙除外）
    if (!c.friendly && !this.active(def)) {
      if (!c.hidden) {
        const home = this.spawnPoint();
        if (Math.hypot(c.x - home.x, c.y - home.y) < 1.5) { c.hidden = true; c.path = []; }
        else if (!c.path.length) this.goTo(c, home.x, home.y);
      }
    } else if (c.hidden) {
      c.hidden = false;
      c.dwellUntil = 0;
    }
    if (c.hidden) return;
    // 怕光：靠近萤火结界、灯轮等光源时逃开
    if (!c.friendly && beh.fleeFrom === 'light' && town.t >= c.fleeUntil && this.nearLight(c)) {
      c.fleeUntil = town.t + 30;
      const home = this.spawnPoint();
      this.goTo(c, home.x, home.y);
      c.dwellUntil = town.t + 30;
    }
    if (!c.path.length && town.t >= c.dwellUntil) this.choose(c, def);
    this.move(c, def, dt);
  }

  choose(c: Creature, def: CreatureType): void {
    const town = this.town;
    const beh = def.behavior;
    if (c.friendly || beh.archetype === 'wander') {
      const p = town.locCenter(c.goal as string) || { x: c.x, y: c.y };
      const spots = town.findLocation?.(c.goal as string)?.spots || [];
      const s = spots.length ? rand(this.town.rng, spots) : { x: Math.round(p.x + (this.town.rng() - 0.5) * 6), y: Math.round(p.y + (this.town.rng() - 0.5) * 4) };
      this.goTo(c, s.x, s.y);
      c.dwellUntil = town.t + 20 + this.town.rng() * 40;
      return;
    }
    if (beh.archetype === 'guard') return;
    if (beh.archetype === 'chaser' && town.t >= c.nextSeek) {
      c.nextSeek = town.t + 5;
      const prey = town.agents.filter((a) => a.kind !== 'creature' && !a.inside && a.status !== 'sleeping')
        .map((a) => ({ a, d: Math.hypot(a.x - c.x, a.y - c.y) })).filter((x) => x.d < 10).sort((p, q) => p.d - q.d)[0];
      if (prey) { this.goTo(c, Math.round(prey.a.x), Math.round(prey.a.y)); return; }
    }
    // 偷窃 / 游荡：去目标地点的某个站位
    const targets = (c.goal ? [c.goal] : []).concat(town.swarmGoal ? [town.swarmGoal] : [], beh.targets || []);
    const locId = c.goal && this.town.rng() < 0.6 ? c.goal : rand(this.town.rng, targets);
    const loc = town.world.locations[locId];
    const s = loc?.spots?.length ? rand(this.town.rng, loc.spots) : town.locCenter(locId);
    if (!s) return;
    this.goTo(c, s.x, s.y);
    c.target = locId;
    c.dwellUntil = town.t + 20 + this.town.rng() * 30;
  }

  move(c: Creature, def: CreatureType, dt: number): void {
    let dist = def.stats.speed * dt;
    c.moving = c.path.length > 0;
    while (dist > 0 && c.path.length) {
      const n = c.path[0];
      const dx = n.x - c.x, dy = n.y - c.y, d = Math.hypot(dx, dy);
      if (Math.abs(dx) > Math.abs(dy)) c.dir = dx > 0 ? 'right' : 'left'; else if (d > 0.001) c.dir = dy > 0 ? 'down' : 'up';
      if (d <= dist) { c.x = n.x; c.y = n.y; c.path.shift(); dist -= d; }
      else { c.x += (dx / d) * dist; c.y += (dy / d) * dist; dist = 0; }
    }
    if (!c.path.length && c.moving) { c.moving = false; this.arrived(c, def); }
  }

  arrived(c: Creature, def: CreatureType): void {
    const town = this.town;
    // 每只影灵 3 小时最多捣一次乱，全镇 45 分钟最多一次，避免刷屏
    if (c.friendly || def.behavior.archetype !== 'thief' || !c.target || town.t - c.lastMischief < 180 || town.t - (town.mischiefAt ?? -999) < 45) return;
    c.lastMischief = town.t;
    town.mischiefAt = town.t;
    const name = town.locName(c.target);
    const text = c.target === 'farm' ? `${def.emoji}${def.name}在${name}偷啃了西瓜` : `${def.emoji}${def.name}把${name}的灯笼吹灭了`;
    town.crisis.supplies = clamp(town.crisis.supplies - (c.target === 'farm' ? 3 : 2), 0, 100);
    town.crisis.morale = clamp(town.crisis.morale - 1, 0, 100);
    town.log('mischief', text, {});
  }

  // ---------- 遭遇 ----------
  encounters(): void {
    const town = this.town;
    for (const c of this.list) {
      if (c.friendly || c.hidden || c.hp <= 0) continue;
      for (const a of town.agents) {
        if (a.kind === 'creature' || a.inside || a.status === 'sleeping' || a.convoId || (a.region || 'town') !== (c.region || 'town')) continue;
        if (Math.hypot(a.x - c.x, a.y - c.y) > 1.3) continue;
        const key = `${c.id}|${a.id}`;
        if (town.t - (town.encounterCd[key] ?? -999) < 90) continue;
        town.encounterCd[key] = town.t;
        this.resolve(c, a);
        break;
      }
    }
  }

  resolve(c: Creature, a: LiveAgent, rnd: () => number = this.town.rng): string {
    const town = this.town;
    const def = this.def(c);
    const rating = town.spec.meta.rating;
    const at = posOf(town, a)!;
    town.emit('vfx', { preset: 'burst', x: at.x, y: at.y, color: '#9b6bff', radius: 1.5, region: at.region });
    // 了解影灵之后，淘气的小家伙不再与人为敌
    if (town.worldFlags.shades_understood && def.temperament !== 'hostile') {
      addMemory(a, { t: town.t, type: 'obs', text: `和一只${def.name}对视了一会儿，它歪着头飘走了，好像并不想伤害我`, importance: 4 });
      if (town.t - (town.peacefulAt ?? -999) >= 60) {
        town.peacefulAt = town.t;
        town.log('encounter', `👀 ${a.name}和一只${def.name}对视了一会儿，它歪着头飘走了`, { agents: [a.id], result: 'peaceful' });
      }
      c.dwellUntil = town.t + 30;
      this.goTo(c, this.spawnPoint().x, this.spawnPoint().y);
      return 'peaceful';
    }
    const allies = town.agents.filter((o) => o !== a && o.kind !== 'creature' && !o.inside && o.status !== 'sleeping' && Math.hypot(o.x - a.x, o.y - a.y) < 3).length;
    const night = town.minute > 20 * 60 || town.minute < 5 * 60;
    const me = a.body.courage / 100 + ((a.inventory.lantern || 0) > 0 ? 0.2 : 0) + (this.nearLight(a) ? 0.4 : 0) + Math.min(0.3, allies * 0.1) + (a.abilities.includes('firefly_ward') ? 0.1 : 0) + rnd() * 0.5;
    const it = def.stats.courage / 100 + (night ? 0.1 : 0) + rnd() * 0.5;
    if (me >= it) {
      c.hp -= 25;
      a.body.courage = clamp(a.body.courage + 5, 0, 100);
      town.crisis.morale = clamp(town.crisis.morale + 3, 0, 100);
      if (c.hp <= 0) {
        if (this.town.rng() < 0.4) a.inventory.moonstone = (a.inventory.moonstone || 0) + 1;
        addMemory(a, { t: town.t, type: 'obs', text: `我驱散了一只${def.name}，它化成一缕紫烟回到了湖里`, importance: 5 });
        town.log('encounter', `✨ ${a.name}驱散了一只${def.name}，它化成一缕紫烟回到了湖里`, { agents: [a.id], result: 'dispel' });
        return 'dispel';
      }
      addMemory(a, { t: town.t, type: 'obs', text: `我把一只${def.name}吓跑了`, importance: 4 });
      town.log('encounter', `💪 ${a.name}把一只${def.name}吓跑了`, { agents: [a.id], result: 'repel' });
      c.fleeUntil = town.t + 30;
      this.goTo(c, this.spawnPoint().x, this.spawnPoint().y);
      return 'repel';
    }
    town.crisis.morale = clamp(town.crisis.morale - 4, 0, 100);
    if ((a.inventory.lantern || 0) > 0 && def.behavior.archetype === 'thief') {
      a.inventory.lantern -= 1;
      if (!a.inventory.lantern) delete a.inventory.lantern;
    }
    if (rating === 'cozy') {
      a.body.courage = clamp(a.body.courage - 5, 0, 100);
      addMemory(a, { t: town.t, type: 'obs', text: `被一只${def.name}吓了一跳，它还顺走了我的东西`, importance: 4 });
      town.log('encounter', `😳 ${a.name}被一只${def.name}吓了一跳`, { agents: [a.id], result: 'startled' });
      return 'startled';
    }
    a.body.courage = clamp(a.body.courage - 8, 0, 100);
    a.body.stamina = clamp(a.body.stamina - 10, 0, 100);
    if (rating === 'epic') a.body.hp = clamp(a.body.hp - 20, 1, 100);
    a.body.conditions = [...new Set([...a.body.conditions, '受惊'])].slice(-5);
    if (a.body.stamina < 15) {
      a.body.conditions = [...new Set([...a.body.conditions, '晕倒'])].slice(-5);
      town.sendToClinic(a);
      addMemory(a, { t: town.t, type: 'obs', text: `被${def.name}扑倒，吓晕了过去，醒来时在诊所`, importance: 7 });
      town.log('encounter', `😵 ${a.name}被${def.name}吓晕了，被送去了诊所`, { agents: [a.id], result: 'faint' });
      return 'faint';
    }
    addMemory(a, { t: town.t, type: 'obs', text: `被一只${def.name}扑了过来，吓得心怦怦跳`, importance: 5 });
    town.log('encounter', `😱 ${a.name}被一只${def.name}吓坏了`, { agents: [a.id], result: 'scared' });
    return 'scared';
  }

  // ---------- 群体心智：每两小时由 LLM 决定影灵群今晚的去向 ----------
  swarmMind(): void {
    const town = this.town;
    const hostile = this.list.filter((c) => !c.friendly && !c.hidden);
    if (!hostile.length || town.t - (town.swarmAt ?? -999) < 120 || this.thinking) return;
    if (!llm.enabled() || llm.budgetLeft() <= 0 || llm.isBusy()) return;
    town.swarmAt = town.t;
    this.thinking = true;
    const outside = town.agents.filter((a) => a.kind !== 'creature' && !a.inside && a.status !== 'sleeping').map((a) => `${a.name}在${town.locName(a.locId) || '路上'}`);
    const lights = town.entities.filter((e) => e.tags!.includes('light')).map((e) => `${e.name}(${Math.round(e.x)},${Math.round(e.y)})`);
    const def = this.def(hostile[0]);
    llm.chatJSON([
      { role: 'system', content: '你是一群异界小生物的群体本能。只输出 JSON。' },
      { role: 'user', content: `${town.timeBlock()}
你们是${def.name}：${def.lore}，怕光，喜欢亮晶晶的东西和甜食，并不想伤人。现在有 ${hostile.length} 只在镇上。
户外的人：${outside.join('、') || '没有'}；亮着的灯阵：${lights.join('、') || '没有'}
可以去的地点：${town.publicLocs().join(', ')}
选一个今晚要去的地点（避开灯光）。输出：{"target":"地点id","mode":"steal 或 scout 或 hide","reason":"≤20字"}` },
    ], { label: '群体心智', schema: SCHEMAS.swarm, agent: def.name, maxTokens: 800, tier: 'fast', attempts: 1, timeoutMs: 45_000 }).then((res: ModelJSON) => {
      const target = town.publicLocs().includes(res.target) ? res.target : null;
      town.swarmGoal = res.mode === 'hide' ? null : target;
      if (target && res.mode !== 'hide') for (const c of this.list) if (!c.friendly) c.goal = target;
    }).catch(() => {}).finally(() => { this.thinking = false; });
  }

  view() {
    return this.list.filter((c) => !c.hidden).map((c) => ({ id: c.id, type: c.type, name: c.name, x: +c.x.toFixed(2), y: +c.y.toFixed(2), dir: c.dir, moving: c.moving, friendly: c.friendly, region: c.region || 'town' }));
  }
}
