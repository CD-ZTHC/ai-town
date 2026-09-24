// 规则引擎（设计文档 4.5）：世界法则 = 触发 → 条件（安全表达式）→ 效果。
// 触发器：every（每隔 N 游戏分钟）、at（每天某时刻）、weather（天气变为某种）、enter（居民到达某地点）。
import { compile, evaluate } from './expr.js';
import { EXPR_FNS, checkEffects, checkExpr, runEffects, posOf, agentsNear } from './effects.js';
import { parseHM } from '../memory.js';

const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_MATCHES = 12; // 一次触发最多影响的实体数，防止「雪崩」规则

/** 表达式里看到的居民：只读的普通对象快照 */
export function agentView(a) {
  if (!a) return null;
  return {
    id: a.id, name: a.name, kind: a.kind, role: a.role, loc: a.locId || '', status: a.status, inside: Boolean(a.inside),
    hp: a.body.hp, stamina: a.body.stamina, courage: a.body.courage, mood: a.mood.text,
  };
}

/** 表达式运行环境：变量 + 白名单函数（函数只接收快照，通过 id 回查真实居民） */
export function exprEnv(town, { self = null, target = null, e = null } = {}) {
  const real = (v) => (v && typeof v === 'object' ? town.byId[v.id] : null);
  const fns = {
    has: (v, item, n = 1) => (real(v)?.inventory[item] || 0) >= n,
    count: (v, item) => real(v)?.inventory[item] || 0,
    knows: (v, ability) => Boolean(real(v)?.abilities.includes(ability)),
    hasCondition: (v, name) => Boolean(real(v)?.body.conditions.includes(name)),
    nearStructure: (v, tag, r = 3) => {
      const p = posOf(town, real(v));
      return Boolean(p) && town.entities.some((s) => s.tags.includes(tag) && Math.hypot(s.x - p.x, s.y - p.y) <= r);
    },
    nearAgents: (v, r = 3) => { const a = real(v); return a ? agentsNear(town, posOf(town, a), r, a).length : 0; },
    min: Math.min, max: Math.max, abs: Math.abs, rand: Math.random,
  };
  const vars = {
    self: agentView(self), target: agentView(target), e: agentView(e),
    weather: town.weather, hour: Math.floor(town.minute / 60), minute: Math.floor(town.minute), day: town.day,
    rating: town.spec.meta.rating, flags: { ...town.worldFlags },
  };
  return { vars, fns };
}

export function testExpr(town, src, bindings) {
  if (!src) return true;
  const { vars, fns } = exprEnv(town, bindings);
  return Boolean(evaluate(compile(src, EXPR_FNS), vars, fns));
}

export function validateRule(r, spec) {
  if (!r || typeof r !== 'object') return '规则不是对象';
  if (!ID_RE.test(r.id || '')) return 'id 不合法';
  if (!String(r.name || '').trim() || String(r.name).length > 16) return 'name 缺失或过长（≤16字）';
  const w = r.when || {};
  const kinds = ['every', 'at', 'weather', 'enter'].filter((k) => w[k] != null);
  if (kinds.length !== 1) return 'when 必须且只能包含 every / at / weather / enter 之一';
  if (w.every != null && !(Number.isInteger(w.every) && w.every >= 10 && w.every <= 1440)) return 'every 应为 10~1440 的整数（游戏分钟）';
  if (w.at != null && parseHM(w.at) == null) return 'at 应为 HH:MM';
  if (w.weather != null && w.weather !== '*' && !Object.hasOwn(spec.weather, w.weather)) return `未知天气：${w.weather}`;
  if (w.enter != null && w.enter !== '*' && !Object.hasOwn(spec.locations, w.enter)) return `未知地点：${w.enter}`;
  if (r.forEach != null && r.forEach !== 'agent') return 'forEach 只能是 agent';
  if (r.if != null) { const e = checkExpr(r.if); if (e) return e; }
  return checkEffects(r.then, spec);
}

export class RuleEngine {
  constructor(town) { this.town = town; this.broken = new Set(); }

  get state() { return (this.town.ruleState ||= { every: {}, at: {} }); }

  /** 每次模拟推进时调用 */
  tick() {
    const { town } = this;
    for (const r of town.spec.rules) {
      const w = r.when;
      if (w.every != null) {
        const last = this.state.every[r.id];
        if (last == null) { this.state.every[r.id] = town.t; continue; }
        if (town.t - last >= w.every) { this.state.every[r.id] = town.t; this.fire(r); }
      } else if (w.at != null) {
        if (town.minute >= parseHM(w.at) && this.state.at[r.id] !== town.day) { this.state.at[r.id] = town.day; this.fire(r); }
      }
    }
  }

  onWeather(weather) {
    for (const r of this.town.spec.rules) if (r.when.weather === weather || r.when.weather === '*') this.fire(r);
  }

  onEnter(agent, locId) {
    for (const r of this.town.spec.rules) if (r.when.enter === locId || r.when.enter === '*') this.fire(r, agent);
  }

  fire(r, bound = null) {
    if (this.broken.has(r.id)) return 0;
    const town = this.town;
    const candidates = bound ? [bound] : r.forEach === 'agent' ? town.agents : [null];
    let n = 0;
    for (const e of candidates) {
      if (n >= MAX_MATCHES) break;
      let ok;
      try { ok = testExpr(town, r.if, { self: e, e }); } catch (err) {
        // 表达式运行出错的规则停用（直到重启），避免每个 tick 刷屏
        console.warn(`[rule] ${r.id} 条件出错，已停用：`, err.message);
        this.broken.add(r.id);
        return n;
      }
      if (!ok) continue;
      runEffects(town, { self: e, e, target: null, at: posOf(town, e), source: `rule:${r.id}` }, r.then);
      n++;
    }
    return n;
  }
}
