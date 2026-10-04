// 冒险（docs/design/adventure.md）的调度与视图：经验结算、预告、每游戏分钟的冒险循环、焦点角色、快照。
// 具体能力分在 growth（成长）、recovery（回复）、party（结伴）、expedition（远征）、dormancy（区域休眠）里。
import { expWorth, shareExp } from './growth.ts';
import { overLevelMult } from './expedition.ts';
import { freshAdventure } from './adventure-state.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { AdventureState } from './adventure-state.ts';
import type { Fight, Fighter, UnitRef } from './fight-rules.ts';

export class Adventure {
  adventureState(this: Town): AdventureState { return (this.adventure ||= freshAdventure()); }

  /** 今天的战绩（跨天清零） */
  adventureToday(this: Town): AdventureState['today'] {
    const st = this.adventureState();
    if (st.today.day !== this.day) st.today = { day: this.day, kills: 0, loot: 0, retreats: 0, downs: 0 };
    return st.today;
  }

  /** 这个世界有没有冒险的内容（没有时快照里不带冒险字段） */
  hasAdventure(this: Town): boolean {
    const s = this.spec;
    return Boolean(s.growth || s.recovery || s.parties || s.expedition || s.expeditions?.length);
  }

  /**
   * 战斗里打倒了一个单位：按 growth.share 给我方活着的参战者分经验（最后一击另加），越级的打折。
   * F 为空时（战斗外打死的）只给 killer
   */
  awardKill(this: Town, F: Fight | null, killer: UnitRef | null, worth: number, region: string, name: string) {
    if (!this.spec.growth || !(worth > 0)) return;
    const side = F && killer ? F.fighters.find((x) => x.kind === killer.kind && x.id === killer.id)?.side : null;
    const mates: Fighter[] = F && side != null ? F.fighters.filter((x) => x.side === side && !x.out && (x.kind === 'agent' || x.kind === 'avatar')) : [];
    const key = (r: UnitRef) => `${r.kind}:${r.id}`;
    const ids = mates.map(key);
    if (killer && !ids.includes(key(killer)) && (killer.kind === 'agent' || killer.kind === 'avatar')) ids.push(key(killer));
    const split = shareExp(worth, ids, killer ? key(killer) : null, this.spec.growth.share);
    const hint = this.levelHintOf(region);
    const gained: Array<{ kind: string; id: string; exp: number }> = [];
    for (const [k, n] of Object.entries(split)) {
      const [kind, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      if (kind === 'agent') {
        const a = this.byId[id];
        if (!a || !this.agents.includes(a) || !this.xpOf(a)) continue;
        const amt = Math.max(1, Math.round(n * overLevelMult(a.xp!.level, hint)));
        this.grantExp({ kind: 'agent', agent: a }, amt, `打倒了${name}`);
        gained.push({ kind, id, exp: amt });
      } else if (kind === 'avatar') {
        const v = this.avatars.list.find((x) => x.id === id);
        if (!v) continue;
        const amt = Math.max(1, Math.round(n * overLevelMult(this.avatarXp(v)!.level, hint)));
        this.grantExp({ kind: 'avatar', avatar: v }, amt, `打倒了${name}`);
        gained.push({ kind, id, exp: amt });
      }
    }
    if (gained.length) this.emit('adv', { type: 'exp', region, gained });
  }

  /** 威胁值多少经验 */
  threatWorth(this: Town, type: string): number {
    const d = this.spec.threats?.[type];
    return d ? expWorth(d.hp || 10, d.exp) : 0;
  }

  // ---------- 预告（§3.7） ----------
  /** 发出预告：动态里一条、身边的居民听到；前端顶部滚动提示 */
  announceForeshadow(this: Town, threat: string, region: string, due: number, { exp, stage }: { exp?: string; stage?: string } = {}) {
    const def = this.spec.threats?.[threat];
    if (!def) return;
    const st = this.adventureState();
    const rname = this.regions[region]?.name || region;
    const text = def.foreshadow?.text || `${rname}深处传来不安的动静……`;
    st.foreshadows = st.foreshadows.filter((f) => !(f.threat === threat && f.region === region));
    st.foreshadows.push({ id: `fs${++st.seq}`, threat, region, due, text, ...(exp ? { exp } : {}), ...(stage ? { stage } : {}) });
    this.log('foreshadow', `${def.emoji} ${text}`, { milestone: 'foreshadow' });
    for (const a of this.agents) if ((a.region || 'town') === region && a.kind !== 'creature') this.setBelief(a, { about: def.name.slice(0, 12), claim: text.slice(0, 40), confidence: 0.6, source: 'omen' });
    this.emit('adv', { type: 'foreshadow', threat, name: def.name, emoji: def.emoji, region, regionName: rname, eta: Math.max(0, Math.round(due - this.t)), text });
  }

  clearForeshadow(this: Town, threat: string, region: string) {
    const st = this.adventureState();
    st.foreshadows = st.foreshadows.filter((f) => !(f.threat === threat && f.region === region));
  }

  /** 世界包规则里的 spawnThreat 遇上带 foreshadow 的威胁：先预告，到点再出现 */
  queueSpawn(this: Town, threat: string, at: { x: number; y: number; region?: string } | null, lead: number) {
    const region = at?.region || this.spec.threats?.[threat]?.haunt.map((h) => this.locRegion(h))[0] || 'town';
    this.announceForeshadow(threat, region, Math.floor(this.t + lead));
    const f = this.adventureState().foreshadows.at(-1);
    if (f && at) f.at = { x: at.x, y: at.y };
  }

  /** 每游戏分钟：到点的预告（规则排进来的）兑现 */
  foreshadowTick(this: Town) {
    const st = this.adventureState();
    for (const f of [...st.foreshadows]) {
      if (f.exp || this.t < f.due) continue;
      st.foreshadows = st.foreshadows.filter((x) => x !== f);
      this.threats.spawn(f.threat, { at: f.at ? { ...f.at, region: f.region } : null, cause: 'foreshadow' });
    }
  }

  // ---------- 焦点角色（§4.7） ----------
  spotlightIds(this: Town): string[] {
    if (this.spec.spotlight?.length) return this.spec.spotlight.filter((id) => this.byId[id] && this.agents.includes(this.byId[id]!));
    const lead = this.expeditions()[0] ? this.partyLeader(this.expeditions()[0]!.party) : null;
    return lead ? [lead.id] : [];
  }

  /** 焦点角色第一次进入某个区域：发区域标题卡（每个区域只播一次） */
  spotlightTick(this: Town) {
    const st = this.adventureState();
    for (const id of this.spotlightIds()) {
      const a = this.byId[id]!;
      const region = a.region || 'town';
      if (st.visited.includes(region) || a.status === 'walking' && a.dest?.hop) continue;
      st.visited.push(region);
      if (st.visited.length === 1 && region === 'town') continue; // 开局所在的地方不播
      const stage = this.expeditions().flatMap((x) => x.stages).find((s) => s.region === region);
      const r = this.spec.regions.find((x) => x.id === region);
      this.emit('adv', { type: 'region', region, name: this.regions[region]?.name || region, title: stage?.title || '', intro: stage?.intro || r?.firstVisit || '', who: { kind: 'agent', id: a.id, name: a.name } });
    }
  }

  // ---------- 主循环 ----------
  /** 每游戏分钟一次（advance 里按分钟去重调用） */
  adventureTick(this: Town) {
    const m = Math.floor(this.t);
    if (this.rt.advMinute === m) return;
    this.rt.advMinute = m;
    this.dormancyTick();
    if (!this.hasAdventure()) return;
    this.adventureToday();
    for (const a of this.agents) if (a.kind !== 'creature') this.maxHp(a);
    this.recoveryTick();
    this.expeditionTick();
    this.foreshadowTick();
    this.spotlightTick();
  }

  /** 快照里的冒险：队伍、远征、今日战绩、预告、焦点角色 */
  adventureView(this: Town) {
    if (!this.hasAdventure()) return null;
    const st = this.adventureState();
    return {
      parties: this.partiesView(), expeditions: this.expeditionView(), today: this.adventureToday(), spotlight: this.spotlightIds(),
      foreshadows: st.foreshadows.map((f) => ({ threat: f.threat, name: this.spec.threats?.[f.threat]?.name || f.threat, emoji: this.spec.threats?.[f.threat]?.emoji || '❗', region: f.region, eta: Math.max(0, Math.round(f.due - this.t)), text: f.text })),
    };
  }

  /** 冒险者面板里一个人的卡片 */
  heroCard(this: Town, a: LiveAgent) {
    const xp = this.xpOf(a);
    return { id: a.id, name: a.name, hp: Math.round(a.body.hp), maxHp: this.maxHp(a), ...(xp ? { level: xp.level } : {}), resting: a.resting?.why || null };
  }
}
