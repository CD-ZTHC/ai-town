// 区域与地点：地点查找、区域开关（暗月界）、地点列表
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
import { addMemory } from '../memory.js';

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
    this.log('region', open ? `🌗 月之渡口那头的「${name}」向小镇敞开了` : `「${name}」的通路关闭了`, {});
    if (open && !was && id === 'moonrealm') this.seedMoonRumors();
    if (open && id === 'moonrealm' && !this.creatures.list.some((c) => c.region === 'moonrealm')) {
      for (const n of ['月月', '萤萤', '朦朦']) this.creatures.addFriend({ type: 'shade_wisp', name: n, near: 'moon_plaza', region: 'moonrealm' });
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

  /** 暗月界刚打开：让居民听说那边有什么，给他们一个过去看看的理由 */
  seedMoonRumors() {
    const rumors = [
      '听说月之渡口那头的暗月界能去了：月光花园的花一碰就会发光，影灵们晚上提着灯在广场散步',
      '听说暗月界有个星坠崖，站在崖边能同时看见两个月亮，对着双月许愿特别灵',
      '听说暗月界的月井水凉丝丝的，月光花采回来能泡茶，影灵们还挺欢迎客人的',
    ];
    const who = this.agents.filter((a) => a.kind !== 'creature');
    who.forEach((a, i) => {
      addMemory(a, { t: this.t, type: 'event', text: rumors[i % rumors.length], importance: 6 });
      this.setBelief(a, { about: '暗月界', claim: '渡口那头的暗月界很美，可以过去逛逛', confidence: 0.7, source: 'news' });
    });
    this.log('news_spread', `🗞️ ${rumors[0]}`, { agents: who.slice(0, 4).map((a) => a.id) });
  }

  regionsView() {
    return Object.fromEntries(Object.values(this.regions).map((w) => [w.id, { name: w.name || '小镇', open: this.regionOpen(w.id) }]));
  }

  locListText() {
    return ['home（自己家）', ...this.publicLocs().map((id) => `${id}（${this.spec.locations[id].name}：${this.spec.locations[id].desc}）`)].join('\n');
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
