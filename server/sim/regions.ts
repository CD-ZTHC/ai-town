// 区域与地点：地点查找、区域开关（暗月界）、地点列表
// 规则（区域是否开放、跨区域路线、地点中心、地名匹配）是下面只依赖显式输入的函数（重构方案 P6 第三步，测试见 test/regions-rules.test.ts）；
// Town 上的方法（Regions mixin）把世界状态交给它们，并负责开关区域时的副作用（日志、传闻、生物、把人送回来）。
import { addMemory } from '../memory.ts';
import type { Town } from '../sim.ts';
import type { GenWorld, MapLocation } from '../types/map.ts';

/** 区域图的一条有向边：从 from 区域的 a 点出发，到 to 区域的 b 点 */
export interface RegionLink { from: string; to: string; a: Cell; b: Cell; name: string }

// ---------- 规则（只依赖显式输入） ----------
/** 区域是否开放：主地图总是开放；世界标记 region_<id> 优先（剧情或管理员开关），否则看区域自己的声明 */
export function isRegionOpen(worldFlags: Record<string, unknown>, regions: ReadonlyArray<{ id: string; open?: boolean }>, id: string): boolean {
  if (id === 'town') return true;
  const flag = worldFlags[`region_${id}`];
  if (flag !== undefined) return flag === true;
  return regions.find((r) => r.id === id)?.open === true;
}

/** 从 from 区域去 to 区域的下一段：广度优先找最少换乘的路线，同一段有多个出口时挑离 pos 最近的；到不了返回 null */
export function nextHop(links: RegionLink[], isOpen: (id: string) => boolean, from: string, to: string, pos: Cell | null = null): RegionLink | null | undefined {
  if (from === to) return null;
  const open = links.filter((l) => isOpen(l.to) && isOpen(l.from));
  const prev = new Map<string, string | null>([[from, null]]);
  const q = [from];
  for (let i = 0; i < q.length && !prev.has(to); i++) for (const l of open) if (l.from === q[i] && !prev.has(l.to)) { prev.set(l.to, q[i]!); q.push(l.to); }
  if (!prev.has(to)) return null;
  let next = to;
  while (prev.get(next) !== from) next = prev.get(next)!;
  const opts = open.filter((l) => l.from === from && l.to === next);
  const d = (l: RegionLink) => (pos ? Math.hypot(l.a.x - pos.x, l.a.y - pos.y) : 0);
  return opts.sort((x, y) => d(x) - d(y))[0];
}

/** 地点的中心点：第一个站位 → 室内地点的门口 → 区域的中心 */
export function locationCenter(l: MapLocation | null, buildings: ReadonlyArray<{ id: string; entrance: Cell }>): Cell | null {
  if (!l) return null;
  if (l.spots?.length) return { x: l.spots[0]!.x, y: l.spots[0]!.y };
  if (l.indoor) {
    const b = buildings.find((x) => x.id === l.indoor);
    if (b) return { x: b.entrance.x, y: b.entrance.y };
  }
  if (l.rect) return { x: Math.round(l.rect.x + l.rect.w / 2), y: Math.round(l.rect.y + l.rect.h / 2) };
  return null;
}

/** 模型偶尔写中文地名：互相包含就算匹配，返回第一个匹配的地点 id */
export function matchLocName(name: string, locations: ReadonlyArray<{ id: string; name: string }>): string | null {
  return locations.find((l) => name.includes(l.name) || l.name.includes(name))?.id ?? null;
}

// ---------- Town 上的接口 ----------
import type { CurEntry, LiveAgent, ScheduleEntry } from '../types/agent.ts';
import type { Act, ActArgs, Convo, Fight, SaveData, ThreatInstance } from '../types/town.ts';
import type { Persona, Region } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import type { Pos } from '../kernel/effects.ts';
import type { ModelJSON } from '../llm.ts';
import type { RetrieveOptions } from '../memory.ts';

export class Regions {
  publicLocs(this: Town): string[] { return Object.keys(this.spec.locations).filter((id) => this.spec.locations[id]!.public && this.regionOpen(this.locRegion(id)) && this.findLocation(id)); }

  resolveLoc(this: Town, a: LiveAgent, loc: string): string {
    if (!loc || loc === 'home' || loc === a.home) return a.home;
    if (this.findLocation(loc) && this.regionOpen(this.locRegion(loc))) return loc;
    // LLM 偶尔写中文地名：在开放的区域里尝试匹配
    const all = Object.values(this.regions).filter((w) => this.regionOpen(w.id)).flatMap((w) => Object.values(w.locations));
    return matchLocName(loc, all) ?? a.home;
  }

  worldOf(this: Town, region: string | null | undefined): GenWorld { return this.regions[region as string] || this.world; }

  locRegion(this: Town, id: string): string { return (Object.hasOwn(this.spec.locations, id) && this.spec.locations[id]!.region) || 'town'; }

  findLocation(this: Town, id: string): MapLocation | null { const w = this.worldOf(this.locRegion(id)); return Object.hasOwn(w.locations, id) ? w.locations[id]! : null; }

  /** 区域是否开放：剧情或管理员打开的（世界标记），或区域自己声明默认开放（linkRegions / 世界包里的 open） */
  regionOpen(this: Town, id: string): boolean { return isRegionOpen(this.worldFlags, this.spec.regions, id); }

  openRegion(this: Town, id: string, open = true): boolean {
    if (!Object.hasOwn(this.regions, id) || id === 'town') return false;
    const was = this.regionOpen(id);
    this.worldFlags[`region_${id}`] = Boolean(open);
    const name = this.regions[id]!.name;
    const r = this.spec.regions.find((x) => x.id === id) || ({} as Partial<Region>);
    this.log('region', open ? (r.openText || `🌗 通往「${name}」的路打通了`) : `「${name}」的通路关闭了`, {});
    if (open && !was) this.seedRegionRumors(id);
    // 区域自带的友善生物（例如暗月界的小影灵）
    if (open && r.friends?.length && !this.creatures.list.some((c: { region?: string }) => c.region === id)) {
      for (const f of r.friends) if (Object.hasOwn(this.spec.creatures!, f.type)) this.creatures.addFriend({ type: f.type, name: f.name, near: f.near, region: id });
    }
    if (!open) {
      // 通路关闭：还在那边的人回到渡口；那边的小家伙留在那边
      const g = this.world.gate;
      for (const a of this.agents) if (a.region === id) Object.assign(a, { region: 'town', x: g.x, y: g.y, inside: null, path: [], dest: null, hop: null, curKey: null, locId: null, status: 'acting' });
      this.creatureList = this.creatures.list.filter((c: { region?: string }) => (c.region || 'town') !== id);
    }
    this.emit('regions', this.regionsView());
    this.emit('links', this.linksView());
    this.emit('story');
    return true;
  }

  /** 区域刚打开：让居民听说那边有什么，给他们一个过去看看的理由（传闻写在区域数据里；没写时按那边的地点生成） */
  seedRegionRumors(this: Town, id: string): void {
    const r = this.spec.regions.find((x) => x.id === id) || ({} as Partial<Region>);
    const name = this.regions[id]?.name || id;
    const places = Object.values(this.regions[id]?.locations || {}).filter((l) => l.name).slice(0, 3).map((l) => l.name);
    const rumors = r.rumors?.length ? r.rumors : [`听说${r.gateName ? `${r.gateName}那头的` : ''}${name}能去了${places.length ? `，那边有${places.join('、')}` : ''}`];
    const who = this.agents.filter((a) => a.kind !== 'creature');
    who.forEach((a, i) => {
      addMemory(a, { t: this.t, type: 'event', text: rumors[i % rumors.length], importance: 6 });
      this.setBelief(a, { about: name, claim: r.belief || `${name}可以过去逛逛`, confidence: 0.7, source: 'news' });
    });
    this.log('news_spread', `🗞️ ${rumors[0]}`, { agents: who.slice(0, 4).map((a) => a.id) });
  }

  /**
   * 区域图（地图演变 §5.2、§5.3）：远处的区域经路口连到主地图（路口是主地图上的 entry 地点，没写时是渡口）；
   * 相邻的地图经接壤边上的通道相连（两边按 key 配对）。返回有向边 [{ from, to, a: 出发点, b: 到达点, name }]
   */
  regionLinks(this: Town): RegionLink[] {
    const links: RegionLink[] = [];
    const town = this.regions.town!;
    for (const r of this.spec.regions) {
      const w = this.regions[r.id];
      if (r.id === 'town' || !w || r.adjacent) continue;
      const entry = (r.entry && this.locCenter(r.entry as string) && this.locRegion(r.entry as string) === 'town' ? this.locCenter(r.entry as string) : town.gate)!;
      const name = r.gateName || '渡口';
      links.push({ from: 'town', to: r.id, a: entry, b: w.gate, name }, { from: r.id, to: 'town', a: w.gate, b: entry, name });
    }
    for (const [id, w] of Object.entries(this.regions)) {
      for (const p of w.passages || []) {
        const q = this.regions[p.to]?.passages?.find((x) => x.key === p.key);
        if (q) links.push({ from: id, to: p.to, a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y }, name: `去${this.regions[p.to]!.name || p.to}的路口` });
      }
    }
    return links;
  }

  /** 从 from 区域去 to 区域的下一段：广度优先找最少换乘的路线，同一段有多个出口时挑离 pos 最近的 */
  routeStep(this: Town, from: string, to: string, pos: Cell | null = null): RegionLink | null | undefined {
    return nextHop(this.regionLinks(), (id) => this.regionOpen(id), from, to, pos);
  }

  /** 下发给前端的路口：只给开放的地图之间的（坐标取整到 0.01） */
  linksView(this: Town) {
    return this.regionLinks().filter((l) => this.regionOpen(l.from) && this.regionOpen(l.to)).map((l) => ({ from: l.from, to: l.to, a: { x: +l.a.x.toFixed(2), y: +l.a.y.toFixed(2) }, b: { x: +l.b.x.toFixed(2), y: +l.b.y.toFixed(2) } }));
  }

  regionsView(this: Town) {
    return Object.fromEntries(Object.values(this.regions).map((w) => {
      const r = this.spec.regions.find((x) => x.id === w.id) || ({} as Partial<Region>);
      return [w.id, { name: w.name || '小镇', open: this.regionOpen(w.id), ...(r.adjacent ? { adjacent: r.adjacent } : {}), theme: w.generator === 'moonrealm-v1' ? 'moon' : null,
        // 冒险（docs/design/adventure.md）：休眠、世界全图的位置与尺寸、氛围、地貌
        ...(this.regionActive(w.id) ? {} : { dormant: true }), W: w.W, H: w.H, ...(r.atlas ? { atlas: r.atlas } : {}), ...(r.ambience ? { ambience: r.ambience } : {}), ...(r.biome ? { biome: r.biome } : {}) }];
    }));
  }

  locListText(this: Town): string {
    const state = (id: string) => { const l = this.findLocation(id); return l?.ruin ? '，现在是一片废墟' : l?.closed === 'closed' ? '，已停业，只能到门口' : l?.closed === 'damaged' ? '，房子受损了，只能到门口' : ''; };
    const where = (id: string) => { const rg = this.locRegion(id); return rg === 'town' ? '' : `，在${this.regions[rg]?.name || rg}`; };
    return ['home（自己家）', ...this.publicLocs().map((id) => `${id}（${this.spec.locations[id]!.name}：${this.spec.locations[id]!.desc}${state(id)}${where(id)}）`)].join('\n');
  }

  locCenter(this: Town, id: string): Cell | null {
    const l = this.findLocation(id);
    return l ? locationCenter(l, this.worldOf(this.locRegion(id)).buildings) : null;
  }
}
