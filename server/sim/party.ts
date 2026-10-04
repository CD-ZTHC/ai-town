// 结伴同行（docs/design/adventure.md §3.3）：队员跟着队长的日程走，队长开打时自动加入同一方。
// 队员仍然有自己的思考、对话和记忆，只是此刻去哪儿由队长决定。
import { addMemory } from '../memory.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent } from '../types/agent.ts';
import type { UnitRef } from './fight-rules.ts';

const ASSIST_R = 12; // 队长开打时，多远的队员会赶过来

export class Party {
  /** 这个人所在的队伍 id：运行中加入 / 离开的（a.party）优先，其次是人设里写的；队长也算 */
  partyOf(this: Town, a: LiveAgent): string | null {
    if (a.party !== undefined) return a.party;
    const p = this.spec.personas.find((x) => x.id === a.id);
    if (p?.party && this.spec.parties?.[p.party]) return p.party;
    return Object.entries(this.spec.parties || {}).find(([, d]) => d.leader === a.id)?.[0] || null;
  }

  partyLeader(this: Town, id: string | null): LiveAgent | null {
    const d = id ? this.spec.parties?.[id] : null;
    const a = d ? this.byId[d.leader] : null;
    return a && this.agents.includes(a) ? a : null;
  }

  /** 同队的在场成员（含自己）；不在队伍里时为空 */
  partyMembers(this: Town, a: LiveAgent): LiveAgent[] {
    const id = this.partyOf(a);
    if (!id) return [];
    return this.agents.filter((x) => x.kind !== 'creature' && this.partyOf(x) === id);
  }

  /** 队员此刻该做的事：跟着队长（队长睡觉、自己受伤休整时不跟） */
  partyEntry(this: Town, a: LiveAgent): CurEntry | null {
    const id = this.partyOf(a);
    const lead = this.partyLeader(id);
    if (!lead || lead === a || a.captive) return null;
    const e = lead.resting ? this.restEntry(lead) : lead.curEntry || null;
    if (!e || e.sleep) return null;
    const loc = this.resolveLoc(lead, e.location);
    return { ...e, key: `party-${lead.id}-${e.key}`, location: loc, activity: `跟着${lead.name}·${String(e.activity).slice(0, 12)}`, act: undefined };
  }

  /** 加入 / 离开队伍（效果原语 party） */
  setParty(this: Town, a: LiveAgent, id: string | null) {
    const before = this.partyOf(a);
    if (before === id) return;
    a.party = id;
    a.curKey = null;
    const name = id ? this.spec.parties?.[id]?.name || id : this.spec.parties?.[before!]?.name || '队伍';
    if (id) {
      addMemory(a, { t: this.t, type: 'event', text: `加入了${name}`, importance: 8 });
      this.log('party', `🤝 ${a.name}加入了${name}`, { agents: [a.id], milestone: 'party' });
    } else {
      addMemory(a, { t: this.t, type: 'event', text: `离开了${name}`, importance: 7 });
      this.log('party', `👋 ${a.name}离开了${name}`, { agents: [a.id] });
    }
    this.emit('adv', { type: 'party', unit: { kind: 'agent', id: a.id }, name: a.name, party: id, partyName: name });
    this.emit('agent', a.id);
  }

  /** 每秒（战斗时）：队里有人在打，身边的队员赶过来加入同一方 */
  partyAssist(this: Town) {
    if (!this.spec.parties || !this.fights?.length) return;
    for (const F of [...this.fights]) {
      for (const f of F.fighters) {
        if (f.out || f.kind !== 'agent') continue;
        const a = this.byId[f.id];
        if (!a) continue;
        const foe = F.fighters.find((x) => !x.out && x.side !== f.side);
        if (!foe) continue;
        for (const m of this.partyMembers(a)) {
          if (m === a || m.status === 'sleeping' || m.convoId || m.captive || m.resting?.why === 'downed' || this.engaged('agent', m.id)) continue;
          if ((m.region || 'town') !== F.region || Math.hypot(m.x - a.x, m.y - a.y) > ASSIST_R) continue;
          const r = this.engage({ kind: 'agent', id: m.id }, { kind: foe.kind, id: foe.id } as UnitRef);
          if (r.ok) this.log('combat', `⚔️ ${m.name}赶来和${a.name}并肩作战`, { agents: [m.id, a.id] });
        }
      }
    }
  }

  /** 快照里的队伍：成员与队长（前端的冒险者面板） */
  partiesView(this: Town) {
    const out: Record<string, { name: string; leader: string; members: string[] }> = {};
    for (const [id, d] of Object.entries(this.spec.parties || {})) {
      const members = this.agents.filter((x) => x.kind !== 'creature' && this.partyOf(x) === id).map((x) => x.id);
      out[id] = { name: d.name, leader: d.leader, members: [d.leader, ...members.filter((m) => m !== d.leader)].filter((m) => this.byId[m] && this.agents.includes(this.byId[m]!)) };
    }
    return out;
  }
}
