// 区域与地点：地点查找、区域开关（暗月界）、地点列表
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
import { addMemory } from '../memory.ts';

export class Regions {
  publicLocs() { return Object.keys(this.spec.locations).filter((id) => this.spec.locations[id].public && this.regionOpen(this.locRegion(id)) && this.findLocation(id)); }

  resolveLoc(a, loc) {
    if (!loc || loc === 'home' || loc === a.home) return a.home;
    if (this.findLocation(loc) && this.regionOpen(this.locRegion(loc))) return loc;
    // LLM 偶尔写中文地名：在开放的区域里尝试匹配
    const all = Object.values(this.regions).filter((w) => this.regionOpen(w.id)).flatMap((w) => Object.values(w.locations));
    const hit = all.find((l) => loc.includes(l.name) || l.name.includes(loc));
    return hit ? hit.id : a.home;
  }

  worldOf(region) { return this.regions[region] || this.world; }

  locRegion(id) { return (Object.hasOwn(this.spec.locations, id) && this.spec.locations[id].region) || 'town'; }

  findLocation(id) { const w = this.worldOf(this.locRegion(id)); return Object.hasOwn(w.locations, id) ? w.locations[id] : null; }

  /** 区域是否开放：剧情或管理员打开的（世界标记），或区域自己声明默认开放（linkRegions / 世界包里的 open） */
  regionOpen(id) {
    if (id === 'town') return true;
    const flag = this.worldFlags[`region_${id}`];
    if (flag !== undefined) return flag === true;
    return this.spec.regions.find((r) => r.id === id)?.open === true;
  }

  openRegion(id, open = true) {
    if (!Object.hasOwn(this.regions, id) || id === 'town') return false;
    const was = this.regionOpen(id);
    this.worldFlags[`region_${id}`] = Boolean(open);
    const name = this.regions[id].name;
    const r = this.spec.regions.find((x) => x.id === id) || {};
    this.log('region', open ? (r.openText || `🌗 通往「${name}」的路打通了`) : `「${name}」的通路关闭了`, {});
    if (open && !was) this.seedRegionRumors(id);
    // 区域自带的友善生物（例如暗月界的小影灵）
    if (open && r.friends?.length && !this.creatures.list.some((c) => c.region === id)) {
      for (const f of r.friends) if (Object.hasOwn(this.spec.creatures, f.type)) this.creatures.addFriend({ type: f.type, name: f.name, near: f.near, region: id });
    }
    if (!open) {
      // 通路关闭：还在那边的人回到渡口；那边的小家伙留在那边
      const g = this.world.gate;
      for (const a of this.agents) if (a.region === id) Object.assign(a, { region: 'town', x: g.x, y: g.y, inside: null, path: [], dest: null, hop: null, curKey: null, locId: null, status: 'acting' });
      this.creatureList = this.creatures.list.filter((c) => (c.region || 'town') !== id);
    }
    this.emit('regions', this.regionsView());
    this.emit('story');
    return true;
  }

  /** 区域刚打开：让居民听说那边有什么，给他们一个过去看看的理由（传闻写在区域数据里；没写时按那边的地点生成） */
  seedRegionRumors(id) {
    const r = this.spec.regions.find((x) => x.id === id) || {};
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
  regionLinks() {
    const links = [];
    const town = this.regions.town;
    for (const r of this.spec.regions) {
      const w = this.regions[r.id];
      if (r.id === 'town' || !w || r.adjacent) continue;
      const entry = r.entry && this.locCenter(r.entry) && this.locRegion(r.entry) === 'town' ? this.locCenter(r.entry) : town.gate;
      const name = r.gateName || '渡口';
      links.push({ from: 'town', to: r.id, a: entry, b: w.gate, name }, { from: r.id, to: 'town', a: w.gate, b: entry, name });
    }
    for (const [id, w] of Object.entries(this.regions)) {
      for (const p of w.passages || []) {
        const q = this.regions[p.to]?.passages?.find((x) => x.key === p.key);
        if (q) links.push({ from: id, to: p.to, a: { x: p.x, y: p.y }, b: { x: q.x, y: q.y }, name: `去${this.regions[p.to].name || p.to}的路口` });
      }
    }
    return links;
  }

  /** 从 from 区域去 to 区域的下一段：广度优先找最少换乘的路线，同一段有多个出口时挑离 pos 最近的 */
  routeStep(from, to, pos = null) {
    if (from === to) return null;
    const links = this.regionLinks().filter((l) => this.regionOpen(l.to) && this.regionOpen(l.from));
    const prev = new Map([[from, null]]);
    const q = [from];
    for (let i = 0; i < q.length && !prev.has(to); i++) for (const l of links) if (l.from === q[i] && !prev.has(l.to)) { prev.set(l.to, q[i]); q.push(l.to); }
    if (!prev.has(to)) return null;
    let next = to;
    while (prev.get(next) !== from) next = prev.get(next);
    const opts = links.filter((l) => l.from === from && l.to === next);
    const d = (l) => (pos ? Math.hypot(l.a.x - pos.x, l.a.y - pos.y) : 0);
    return opts.sort((x, y) => d(x) - d(y))[0];
  }

  regionsView() {
    return Object.fromEntries(Object.values(this.regions).map((w) => {
      const r = this.spec.regions.find((x) => x.id === w.id) || {};
      return [w.id, { name: w.name || '小镇', open: this.regionOpen(w.id), ...(r.adjacent ? { adjacent: r.adjacent } : {}), theme: w.generator === 'moonrealm-v1' ? 'moon' : null }];
    }));
  }

  locListText() {
    const state = (id) => { const l = this.findLocation(id); return l?.ruin ? '，现在是一片废墟' : l?.closed === 'closed' ? '，已停业，只能到门口' : l?.closed === 'damaged' ? '，房子受损了，只能到门口' : ''; };
    const where = (id) => { const rg = this.locRegion(id); return rg === 'town' ? '' : `，在${this.regions[rg]?.name || rg}`; };
    return ['home（自己家）', ...this.publicLocs().map((id) => `${id}（${this.spec.locations[id].name}：${this.spec.locations[id].desc}${state(id)}${where(id)}）`)].join('\n');
  }

  locCenter(id) {
    const l = this.findLocation(id);
    if (!l) return null;
    if (l.spots?.length) return { x: l.spots[0].x, y: l.spots[0].y };
    if (l.indoor) {
      const b = this.worldOf(this.locRegion(id)).buildings.find((x) => x.id === l.indoor);
      if (b) return { x: b.entrance.x, y: b.entrance.y };
    }
    if (l.rect) return { x: Math.round(l.rect.x + l.rect.w / 2), y: Math.round(l.rect.y + l.rect.h / 2) };
    return null;
  }
}
