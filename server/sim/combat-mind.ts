// 战斗里的人心（即时战斗设计 combat.md §3.5、C3）：开打时定战术、濒死时说一句话、旁观者要不要冲上去。
// 每一拍仍由规则结算；模型只在这几个时刻各调用一次，异步、不阻塞战斗。没有模型、额度用完、出错时用兜底规则（fight-rules.ts），
// 兜底的结果立即生效，所以没有模型的世界里战斗照样有战术和台词。模型调用按标签「战斗战术」「战斗台词」计入 AI 大脑的指标。
import * as llm from '../llm.ts';
import { addMemory } from '../memory.ts';
import { SCHEMAS } from '../llm-schemas.ts';
import { systemPrompt } from './cognition.ts';
import { TACTICS, TACTIC_TEXT, fallbackLine, fallbackTactic, sameUnit } from './fight-rules.ts';
import type { Fight, Fighter, Tactic, UnitRef } from './fight-rules.ts';
import type { Town } from '../sim.ts';
import type { LiveAgent } from '../types/agent.ts';
import type { ModelJSON } from '../llm.ts';

const JOIN_R = 6; // 多近的旁观者会考虑加入
const JOIN_AFFINITY = 50; // 对某一方的好感达到这个值才会出手
const JOIN_COURAGE = 45;

const canAsk = () => llm.enabled() && llm.budgetLeft() > 0 && !llm.isBusy();

export class CombatMind {
  /** 一个居民刚加入战斗：定战术（先用兜底立即生效，模型的回复到了再覆盖） */
  planFighter(this: Town, F: Fight, f: Fighter) {
    const a = this.byId[f.id];
    if (f.kind !== 'agent' || !a) return;
    const u = this.unit(f)!;
    const allies = F.fighters.filter((x) => !x.out && x.side === f.side && !sameUnit(x, f));
    const foes = F.fighters.filter((x) => !x.out && x.side !== f.side);
    const allyHurt = allies.some((x) => { const p = this.unit(x); return p && p.hp / p.maxHp < 0.6; });
    f.tactic ||= fallbackTactic({ hp: u.hp, maxHp: u.maxHp, courage: u.courage, villain: a.alignment === 'villain', allyHurt });
    const foeName = this.unit(foes[0])?.name || '';
    if (!canAsk()) {
      if (!a.convoId) this.say(a, fallbackLine('start', { tactic: f.tactic, foe: foeName, villain: a.alignment === 'villain' }, this.rng), 2500);
      return;
    }
    const list = (xs: Fighter[]) => xs.map((x) => { const p = this.unit(x); return p ? `${p.name}（血量${Math.round(p.hp)}/${p.maxHp}）` : ''; }).filter(Boolean).join('、') || '没有';
    llm.chatJSON([
      systemPrompt(this.spec, false),
      { role: 'user', content: `${this.personaBlock(a)}
${a.name}正在和人打斗。自己：血量${Math.round(u.hp)}/${u.maxHp}；同伴：${list(allies)}；对手：${list(foes)}。
会的招式：${this.skillsOf(f).map((s) => s.name).join('、')}。
按人设决定这一架怎么打：aggressive 猛攻 / defensive 稳守 / protect 护着某个同伴 / flee 找机会脱身，再说一句开打时的话（≤15字）。
输出 JSON：{"tactic":"aggressive/defensive/protect/flee","protect":"要护着的同伴名字或 null","line":"≤15字"}` },
    ], { label: '战斗战术', schema: SCHEMAS.combatTactic, agent: a.name, maxTokens: 300, tier: 'fast', attempts: 1, timeoutMs: 20_000 }).then((res: ModelJSON) => {
      if (!this.fights.includes(F) || f.out) return;
      if (TACTICS.includes(res?.tactic)) f.tactic = res.tactic as Tactic;
      const ally = allies.find((x) => this.unit(x)?.name === res?.protect);
      f.protect = f.tactic === 'protect' && ally ? { kind: ally.kind, id: ally.id } : null;
      if (f.tactic === 'protect' && !f.protect) f.tactic = 'aggressive';
      const line = String(res?.line || '').trim().slice(0, 20);
      if (line && !a.convoId) this.say(a, line, 3000);
    }).catch(() => {
      if (!a.convoId && this.fights.includes(F)) this.say(a, fallbackLine('start', { tactic: f.tactic, foe: foeName, villain: a.alignment === 'villain' }, this.rng), 2500);
    });
  }

  /** 居民濒死（血量第一次低于 30%）：说一句话，模型也可以改战术（例如改成脱身） */
  criticalMoment(this: Town, F: Fight, f: Fighter) {
    const a = this.byId[f.id];
    if (f.kind !== 'agent' || !a || (f.said ||= []).includes('low')) return;
    f.said.push('low');
    const villain = a.alignment === 'villain';
    if (!canAsk()) { if (!a.convoId) this.say(a, fallbackLine('low', { villain }, this.rng), 2500); return; }
    const foes = F.fighters.filter((x) => !x.out && x.side !== f.side).map((x) => this.unit(x)?.name).filter(Boolean).join('、');
    llm.chatJSON([
      systemPrompt(this.spec, false),
      { role: 'user', content: `${this.personaBlock(a)}
${a.name}在和${foes || '对手'}的打斗中快撑不住了（血量${Math.round(a.body.hp)}）。按人设说一句话（≤15字），可以换战术：aggressive / defensive / protect / flee。
输出 JSON：{"line":"≤15字","tactic":"可选"}` },
    ], { label: '战斗台词', schema: SCHEMAS.combatLine, agent: a.name, maxTokens: 200, tier: 'fast', attempts: 1, timeoutMs: 15_000 }).then((res: ModelJSON) => {
      if (!this.fights.includes(F) || f.out) return;
      if (TACTICS.includes(res?.tactic) && res.tactic !== 'protect') f.tactic = res.tactic as Tactic;
      const line = String(res?.line || '').trim().slice(0, 20);
      if (line && !a.convoId) this.say(a, line, 3000);
    }).catch(() => { if (!a.convoId) this.say(a, fallbackLine('low', { villain }, this.rng), 2500); });
  }

  /** 每秒：战斗附近的居民——和某一方交情深、又够勇敢的冲上去帮忙；胆小的记下自己没敢上前 */
  bystanderTick(this: Town) {
    for (const F of [...(this.fights || [])]) {
      const seen = (F.seen ||= []);
      const pts = F.fighters.filter((x) => !x.out).map((x) => ({ f: x, u: this.unit(x) })).filter((x) => x.u);
      for (const o of this.agents) {
        if (o.kind === 'creature' || o.inside || o.status === 'sleeping' || o.convoId || o.captive || seen.includes(o.id) || this.engaged('agent', o.id)) continue;
        const p = this.unit({ kind: 'agent', id: o.id });
        if (!p || p.region !== F.region || !pts.some((x) => Math.hypot(x.u!.x - p.x, x.u!.y - p.y) <= JOIN_R)) continue;
        seen.push(o.id);
        // 最在乎的那个参战者
        let best: { f: Fighter; name: string; aff: number } | null = null;
        for (const { f, u } of pts) {
          const aff = f.kind === 'agent' ? o.relations[f.id]?.affinity ?? 0 : f.kind === 'avatar' ? o.travellers?.[u!.avatar!.uid]?.affinity ?? 0 : -100;
          if (aff >= JOIN_AFFINITY && (!best || aff > best.aff)) best = { f, name: u!.name, aff };
        }
        if (!best) continue;
        const foe = pts.find((x) => x.f.side !== best!.f.side && this.joinAllowed(o, x.f))?.f;
        if (!foe) continue;
        if (o.body.courage < JOIN_COURAGE) {
          addMemory(o, { t: this.t, type: 'event', text: `看见${best.name}在和人打斗，我没敢上前`, importance: 6 });
          continue;
        }
        const r = this.engage({ kind: 'agent', id: o.id }, { kind: foe.kind, id: foe.id });
        if (!r.ok) continue;
        const me = r.fight.fighters.find((x) => !x.out && x.kind === 'agent' && x.id === o.id)!;
        me.tactic = 'protect';
        me.protect = { kind: best.f.kind, id: best.f.id };
        this.say(o, fallbackLine('join', { ally: best.name }, this.rng), 2500);
        addMemory(o, { t: this.t, type: 'event', text: `冲上去帮${best.name}打架`, importance: 7 });
        this.log('combat', `🛡️ ${o.name}冲上去帮${best.name}`, { agents: [o.id, ...(best.f.kind === 'agent' ? [best.f.id] : [])] });
      }
    }
  }

  /** 旁观者 o 能不能对参战的 x 动手：怪物、生物可以；居民要世界允许敌对；旅人不行 */
  joinAllowed(this: Town, o: LiveAgent, x: Fighter): boolean {
    if (x.kind === 'threat' || x.kind === 'creature') return true;
    if (x.kind === 'avatar') return false;
    return Boolean(this.canBeHostile?.()) && x.id !== o.id;
  }

  /** 护人：攻击正在打自己要保护的人的那个敌人 */
  protectTarget(this: Town, F: Fight, f: Fighter): UnitRef | null {
    if (f.tactic !== 'protect' || !f.protect) return null;
    const foe = F.fighters.find((x) => !x.out && x.side !== f.side && (sameUnit(x.target, f.protect) || sameUnit(x.act?.target, f.protect)));
    return foe ? { kind: foe.kind, id: foe.id } : null;
  }

  /** 战术的中文说明（面板、日志用） */
  tacticText(this: Town, t: Tactic | undefined) { return t ? TACTIC_TEXT[t] : ''; }
}
