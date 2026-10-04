// 查询：推送给前端的快照与各面板的视图
// 每次推送里居民的一帧（agentFrame）是只依赖显式输入的函数（重构方案 P6 第三步，测试见 test/social-rules.test.ts）；其余视图由 Views mixin 汇总。
import fs from 'node:fs';
import path from 'node:path';
import * as llm from '../llm.ts';
import { fmtTime, fmtStamp } from '../memory.ts';
import { publicSpec } from '../kernel/spec.ts';
import { equipped, expToNext } from './growth.ts';
import { findAbility } from '../kernel/abilities.ts';
import { threadList } from '../story/threads.ts';
import { renderRefs, ref } from '../accounts/refs.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent, ScheduleEntry } from '../types/agent.ts';
import type { Act, ActArgs, Convo, Fight, SaveData, ThreatInstance } from '../types/town.ts';
import type { Ability, Persona } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import type { Pos } from '../kernel/effects.ts';
import type { ModelJSON } from '../llm.ts';
import type { RetrieveOptions } from '../memory.ts';
import type { StoryState } from '../story/director.ts';

/** 推送给前端的居民一帧：坐标保留 3 位小数；气泡过了显示时间（now，真实毫秒）就不再下发；满血、没有标记时省略对应字段 */
export function agentFrame(a: LiveAgent, now: number) {
  return {
    id: a.id, x: +a.x.toFixed(3), y: +a.y.toFixed(3), dir: a.dir, moving: a.moving, status: a.status, region: a.region || 'town',
    inside: a.inside, emoji: a.action.emoji, action: a.action.text, loc: a.locId, mood: a.mood.emoji,
    thinking: a.thinking > 0 ? a.thinkingLabel : '', convo: a.convoId,
    ...(a.body.hp < (a.body.maxHp ?? 100) ? { hp: Math.round(a.body.hp) } : {}), ...(a.marks?.length ? { marked: true } : {}), ...(a.hosted?.length ? { hosted: true } : {}),
    // 冒险（docs/design/adventure.md）：生命上限不是 100 时下发、等级、休整中
    ...(a.body.maxHp != null && a.body.maxHp !== 100 ? { maxHp: a.body.maxHp } : {}), ...(a.xp ? { lv: a.xp.level } : {}), ...(a.resting ? { rest: a.resting.why } : {}),
    bubble: a.bubble && a.bubble.until > now ? { id: a.bubble.id, text: a.bubble.text, kind: a.bubble.kind } : null,
  };
}

export class Views {
  snapshot(this: Town) {
    const now = this.now();
    return {
      t: this.t, speed: this.speed, paced: this.paced < 1 ? +this.paced.toFixed(2) : null, paused: this.paused, idle: !!this.idle, halted: this.halted || null, weather: this.weather, nightSkip: !!this.nightSkip,
      agents: this.hasAdventure() ? this.agents.map((a) => ({ ...agentFrame(a, now), ...this.gearView(a) })) : this.agents.map((a) => agentFrame(a, now)),
      convos: [...this.convos.values()].map((c) => ({ id: c.id, a: c.a, b: c.b, state: c.state })),
      entities: [
        ...this.entities.map((e) => ({ id: e.id, kind: 'structure', type: e.type, emoji: e.emoji, name: e.name, x: +e.x.toFixed(2), y: +e.y.toFixed(2), inside: e.inside, light: e.light || null, region: e.region || 'town' })),
        ...(this.portalState ? [{ id: 'portal', kind: 'portal', type: 'portal', stage: this.portalState.stage, name: this.portalState.name, x: this.portalState.x, y: this.portalState.y, inside: null, light: { r: 140, color: '170,120,255' } }] : []),
      ],
      creatures: this.creatures.view(),
      ...(this.threats.enabled || this.dark.graves.length ? { dark: this.threats.view() } : {}),
      avatars: this.avatars.view(),
      ...(this.fights?.length ? { fights: this.fightsView() } : {}),
      ...(this.hasAdventure() ? { adv: this.adventureView() } : {}),
      overlay: this.evolved.snapshotExtra(),
      story: { tension: this.story?.now?.value ?? null, arc: this.arcs.active()?.phase || null, vote: this.votes.list.some((v) => v.status !== 'closed') },
    };
  }

  agentDetail(this: Town, id: string, vid = 'local') {
    const a = this.byId[id];
    if (!a) return null;
    return {
      id: a.id, name: a.name, age: a.age, role: a.role, persona: a.persona, goal: a.goal, todayGoal: a.todayGoal, look: a.look,
      status: a.status, action: a.action, thought: a.thought, mood: a.mood, loc: a.locId, locName: a.locId ? this.locName(a.locId) : '路上',
      thinking: a.thinking ? a.thinkingLabel : '',
      schedule: (a.scheduleDay === this.day ? a.schedule : []).map((e) => ({ ...e, time: `${fmtTime(e.start)}-${fmtTime(e.end)}`, locName: this.locName(this.resolveLoc(a, e.location)) })),
      memories: a.memories.slice(-120).reverse().map((m) => ({ ...m, text: renderRefs(m.text), stamp: fmtStamp(m.t) })),
      relations: [
        ...Object.entries(a.relations).map(([oid, r]) => ({ id: oid, name: this.byId[oid]?.name, ...r })),
        // 认识的旅人（按账号记，显示当前昵称）
        ...Object.entries(a.travellers || {}).map(([uid, r]) => ({ id: uid, name: renderRefs(ref(uid)), affinity: r.affinity, note: `聊过 ${r.chats} 次`, traveller: true })),
      ].sort((x, y) => y.affinity - x.affinity),
      diary: a.diary.slice().reverse(),
      chat: a.visitorChats[vid] || [],
      body: { ...a.body, stamina: Math.round(a.body.stamina), courage: Math.round(a.body.courage) },
      inventory: Object.entries(a.inventory).map(([k, n]) => ({ id: k, n, name: this.spec.items[k]?.name || k, emoji: this.spec.items[k]?.emoji || '📦' })),
      abilities: a.abilities.map((k) => findAbility(this.spec, k)).filter((ab): ab is Ability => Boolean(ab)).map((ab) => ({
        id: ab.id, name: ab.name, emoji: ab.emoji, desc: ab.desc, cooldown: Math.max(0, Math.ceil((a.cooldowns?.[ab.id] || 0) - this.t)),
      })),
      researching: a.researching?.topic || null,
      // 黑暗叙事：负担值、寄宿、禁忌姿态、立场（规律本身从不下发）
      burdens: Object.entries(a.burdens || {}).map(([k, n]) => ({ id: k, name: this.spec.burdens?.[k]?.name || k, value: Math.round(n), max: this.spec.burdens?.[k]?.max ?? 100 })),
      hosted: (a.hosted || []).map((h) => ({ id: h.threat, name: this.spec.threats?.[h.threat]?.name || h.threat, emoji: this.spec.threats?.[h.threat]?.emoji || '🌑' })),
      posture: a.posture && a.posture.until > this.t ? a.posture.holds : [],
      marked: Boolean(a.marks?.length),
      alignment: a.alignment || null,
      captive: a.captive ? this.byId[a.captive.by]?.name || true : null,
      // 冒险：成长、装备、队伍、休整（检视面板的「成长」页）
      ...this.growthDetail(a),
    };
  }

  /** 角色手里拿的东西（前端画武器图层，冒险 §4.2）：武器、盾 */
  gearView(this: Town, a: LiveAgent) {
    let wp: { w: string; c?: string; g?: string } | null = null, sh: { c?: string } | null = null;
    for (const k of equipped(a.inventory, this.spec.items)) {
      const lk = this.spec.items[k]?.look;
      if (!lk?.weapon) continue;
      if (lk.weapon === 'shield') sh = { ...(lk.color ? { c: lk.color } : {}) };
      else if (!wp) wp = { w: lk.weapon, ...(lk.color ? { c: lk.color } : {}), ...(lk.glow ? { g: lk.glow } : {}) };
    }
    return { ...(wp ? { wp } : {}), ...(sh ? { sh } : {}) };
  }

  /** 冒险的静态信息（随初始数据下发）：回复点、各区域在世界全图上的位置 */
  adventureMeta(this: Town) {
    if (!this.hasAdventure()) return null;
    return { rests: Object.keys(this.spec.locations).filter((id) => this.restOf(id)) };
  }

  /** 检视面板的「成长」页：等级、经验、属性、装备栏、队伍 */
  growthDetail(this: Town, a: LiveAgent) {
    const xp = this.spec.growth ? this.xpOf(a) : null;
    const st = this.combatStats(a);
    const eq = equipped(a.inventory, this.spec.items).map((k) => ({ id: k, slot: this.spec.items[k]!.equip, name: this.spec.items[k]!.name, emoji: this.spec.items[k]!.emoji, mods: this.spec.items[k]!.mods || {}, ...(this.spec.items[k]!.look ? { look: this.spec.items[k]!.look } : {}) }));
    const party = this.spec.parties ? this.partyOf(a) : null;
    if (!xp && !eq.length && !party && !a.resting) return {};
    return {
      adventure: {
        ...(xp ? { level: xp.level, exp: xp.exp, next: expToNext(this.spec.growth, xp.level), track: this.spec.growth!.tracks[xp.track]?.name || xp.track } : {}),
        atk: st.atk, def: st.def, maxHp: this.maxHp(a), equipped: eq,
        ...(party ? { party: { id: party, name: this.spec.parties![party]?.name || party, leader: this.spec.parties![party]?.leader } } : {}),
        ...(a.resting ? { resting: { why: a.resting.why, at: this.locName(a.resting.at) } } : {}),
      },
    };
  }

  /**
   * 首次推送：激活的区域带完整地图；休眠的区域只给名字与尺寸（stub），前端切过去时再请求（冒险 §3.5）
   */
  initPayload(this: Town) {
    return {
      world: this.world,
      regions: Object.fromEntries(Object.entries(this.regions).filter(([id]) => id !== 'town').map(([id, w]) => [id, this.regionActive(id) ? w : { id, name: w.name, W: w.W, H: w.H, stub: true }])),
      worldId: this.worldId,
      regionsOpen: this.regionsView(),
      adventure: this.adventureMeta(),
      // 地图之间的路口（游戏模式的低延迟移动用来预判过图，docs/design/realtime.md §4）
      links: this.linksView(),
      weathers: this.spec.weather,
      spec: publicSpec(this.spec),
      agents: this.agentsMeta(),
      logs: this.logs.slice(-150),
      newspapers: this.newspapers,
      board: this.board,
      llm: llmPublic(),
      state: this.snapshot(),
    };
  }

  relationsGraph(this: Town) {
    return this.agents.map((a) => ({ id: a.id, name: a.name, relations: Object.entries(a.relations).map(([id, r]) => ({ id, ...r })) }));
  }

  agentsMeta(this: Town) {
    return this.agents.map((a) => ({ id: a.id, name: a.name, age: a.age, role: a.role, look: a.look, home: a.home, kind: a.kind }));
  }

  usageView(this: Town) {
    const days = Object.entries(this.usage?.days || {}).map(([d, v]) => ({ day: Number(d), ...v })).sort((a, b) => a.day - b.day);
    const avg = days.length ? Math.round(days.reduce((s, d) => s + d.tokens, 0) / days.length) : null;
    return { days, avgPerDay: avg, byLabel: llm.stats.byLabel, metrics: this.metricsView() };
  }

  /** 心愿单 + 已生成的需求文档（mise run evolve 写在 data/evolve.json 里） */
  gapsWithRfc(this: Town) {
    let rfcs: Record<string, { file?: string }> = {};
    try { rfcs = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'evolve.json'), 'utf8')).gaps || {}; } catch {}
    return [...(this.gaps || [])].sort((a, b) => b.count - a.count).map((g) => ({ ...g, status: g.status || 'open', rfc: rfcs[g.id]?.file || null }));
  }

  proposalsView(this: Town, key: string | null = null, admin = false) {
    const ps = this.proposalSystem;
    return {
      proposals: ps.list.slice(-20).reverse().map((p) => ps.view(p, key)),
      queue: (this.architectQueue || []).map((q) => ({ intent: q.intent, origin: ps.originText(q.origin) })),
      thinking: Boolean(this.architect?.busy),
      gaps: admin ? this.gapsWithRfc() : undefined,
      requireAdmin: ps.requireAdmin,
      pressure: this.mapPressure?.view() || null,
    };
  }

  storyView(this: Town, key: string | null = null) {
    const st: Partial<StoryState> = this.story || {};
    return {
      storyteller: this.spec.meta.storyteller, rating: this.spec.meta.rating,
      tension: st.now || null, history: (st.history || []).slice(-72), decisions: (st.decisions || []).slice(-8).reverse(),
      arcs: this.arcs.view(), threads: threadList(this),
      arcTemplates: this.spec.arcs!.filter((a) => !this.arcs.runs.some((r: { template: string }) => r.template === a.id)).map((a) => ({ id: a.id, title: a.title })),
      migration: this.migration.view(),
      votes: this.votes.list.slice(-5).reverse().map((v) => this.votes.view(v, key)),
      scenes: (this.pendingScenes || []).map((s) => ({ title: s.title, time: s.time, location: this.locName(s.location) })),
      crisis: {
        ...this.crisis, defense: this.entities.filter((e) => (e.tags as string[]).includes('light')).length,
        creatures: this.creatures.list.filter((c: { friendly?: boolean }) => !c.friendly).length, portal: this.portalState ? { stage: this.portalState.stage, name: this.portalState.name } : null,
      },
      bestiary: Object.entries(this.spec.creatures!).map(([id, c]) => (this.discovered.includes(id) || (c.leader && this.spec.personas.some((p) => p.creature === id))
        ? { id, known: true, name: c.name, emoji: c.emoji, origin: c.origin, lore: c.lore, weakness: c.weakness, temperament: c.temperament, look: c.look }
        : { id, known: false })),
      dark: this.threats.enabled ? this.threats.panel() : null,
      travellers: this.spec.personas.filter((p) => p.kind === 'traveller').map((p) => ({ id: p.id, name: p.name, role: p.role, origin: p.traveller?.origin, status: p.status || 'active' })),
    };
  }
}

export function llmPublic() {
  const s = llm.stats;
  return {
    enabled: s.enabled, model: s.model, calls: s.calls, ok: s.ok, errors: s.errors, inflight: s.inflight, queued: s.queued,
    tokens: s.promptTokens + s.completionTokens, dayTokens: s.dayTokens, dailyBudget: s.dailyBudget, avgMs: Math.round(s.avgMs), lastError: s.lastError,
    active: s.active.map((x) => ({ label: x.label, agent: x.agent, ms: Date.now() - x.since /* 确定性白名单：模型调用计时 */ })), recent: s.recent,
  };
}
