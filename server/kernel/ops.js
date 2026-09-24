// WorldOp：对世界规格的一切修改都是一条带类型、可校验、可重放的操作。
// 存档只保存「操作历史」，读档时 = 默认规格 + 按序重放，因此代码里对基础设定的更新也会同步到老存档。
import fs from 'node:fs';
import path from 'node:path';
import { PARAM_BOUNDS, RATINGS, STORYTELLERS, validateSpec } from './spec.js';
import { parseHM } from '../memory.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
// 与 JS 对象原型重名的 id（constructor、toString……）一律不允许，避免查表时混淆
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const validId = (id) => ID_RE.test(id || '') && !RESERVED.has(id);
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// 每个操作：level 决定审批等级（micro / minor / major），check 返回错误文本或 null，
// apply 修改规格（传入的是副本），describe 生成给玩家看的一句话
export const OPS = {
  setParam: {
    level: 'major',
    check(spec, a) {
      const b = Object.hasOwn(PARAM_BOUNDS, a.name) && PARAM_BOUNDS[a.name];
      if (!b) return `未知参数：${a.name}`;
      if (typeof a.value !== 'number' || !Number.isFinite(a.value)) return 'value 应为数字';
      if (a.value < b[0] || a.value > b[1]) return `${a.name} 应在 ${b[0]}~${b[1]}`;
      return null;
    },
    apply(spec, a) { spec.params[a.name] = a.value; },
    describe: (a) => `世界参数 ${a.name} 调整为 ${a.value}`,
  },
  setMeta: {
    level: 'major',
    check(spec, a) {
      if (a.rating != null && !RATINGS.includes(a.rating)) return `rating 只能是 ${RATINGS.join('/')}`;
      if (a.storyteller != null && !STORYTELLERS.includes(a.storyteller)) return `storyteller 只能是 ${STORYTELLERS.join('/')}`;
      if (a.rating == null && a.storyteller == null) return '没有要修改的字段';
      return null;
    },
    apply(spec, a) {
      if (a.rating != null) spec.meta.rating = a.rating;
      if (a.storyteller != null) spec.meta.storyteller = a.storyteller;
    },
    describe: (a) => [a.rating && `内容分级改为 ${a.rating}`, a.storyteller && `叙事者改为 ${a.storyteller}`].filter(Boolean).join('，'),
  },
  addCanon: {
    level: 'micro',
    check(spec, a) {
      if (!str(a.text, 200)) return 'text 不能为空';
      if (spec.lore.canon.length >= 500) return '正典条目已达上限';
      return null;
    },
    apply(spec, a, ctx) {
      spec.lore.canon.push({
        id: `canon_${ctx.seq}`, text: str(a.text, 200),
        tags: (Array.isArray(a.tags) ? a.tags : []).map((t) => str(t, 12)).filter(Boolean).slice(0, 6),
        secret: Boolean(a.secret), t: ctx.t,
      });
    },
    describe: (a) => (a.secret ? '一个秘密被写入了小镇的历史' : `写入设定集：${str(a.text, 40)}`),
  },
  addCalendarEvent: {
    level: 'minor',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (spec.calendar.events.some((e) => e.id === a.id)) return `日历事件已存在：${a.id}`;
      if (!str(a.name, 16)) return 'name 不能为空';
      if (!Number.isInteger(a.day) || a.day < 1) return 'day 应为正整数';
      if (parseHM(a.from) == null) return 'from 应为 HH:MM';
      if (a.to != null && parseHM(a.to) == null) return 'to 应为 HH:MM';
      if (a.location && !Object.hasOwn(spec.locations, a.location)) return `地点不存在：${a.location}`;
      return null;
    },
    apply(spec, a) {
      spec.calendar.events.push({
        id: a.id, name: str(a.name, 16), emoji: str(a.emoji, 4) || '🎉', day: a.day, from: a.from,
        ...(a.to ? { to: a.to } : {}), ...(a.location ? { location: a.location } : {}),
        hint: str(a.hint, 60), countdown: Boolean(a.countdown),
      });
    },
    describe: (a) => `新的节日「${str(a.name, 16)}」将在第 ${a.day} 天举行`,
  },
  addWeather: {
    level: 'minor',
    check(spec, a) {
      if (!validId(a.id)) return 'id 不合法';
      if (Object.hasOwn(spec.weather, a.id)) return `天气已存在：${a.id}`;
      if (!str(a.name, 8) || !str(a.emoji, 4)) return 'name / emoji 不能为空';
      const w = a.weight ?? 0;
      if (typeof w !== 'number' || w < 0 || w > 20) return '新天气的 weight 应在 0~20';
      const r = a.render || {};
      if (r.base && !['sunny', 'cloudy', 'rain', 'storm', 'fog', 'snow'].includes(r.base)) return `render.base 未知：${r.base}`;
      if (r.tint && !COLOR_RE.test(r.tint)) return 'render.tint 应为 #rrggbb';
      return null;
    },
    apply(spec, a) {
      const r = a.render || {};
      spec.weather[a.id] = {
        name: str(a.name, 8), emoji: str(a.emoji, 4), weight: a.weight ?? 0,
        render: { base: r.base || 'cloudy', ...(r.tint ? { tint: r.tint, tintAlpha: Math.max(0, Math.min(0.5, Number(r.tintAlpha) || 0.2)) } : {}) },
      };
    },
    describe: (a) => `天空中出现了一种新的天气：${str(a.emoji, 4)} ${str(a.name, 8)}`,
  },
};

export class OpError extends Error {
  constructor(msg) { super(msg); this.code = 'OP'; this.status = 400; }
}

/**
 * 在规格副本上应用一条操作，返回新规格；失败抛出 OpError，原规格不受影响。
 * 应用后还会做一次整体校验，防止单个操作检查不到的连锁问题。
 */
export function applyOp(spec, op, ctx = {}) {
  const def = Object.hasOwn(OPS, op?.op ?? '') && OPS[op.op];
  if (!def) throw new OpError(`未知操作：${op?.op}`);
  const args = op.args || {};
  const e = def.check(spec, args);
  if (e) throw new OpError(e);
  const next = structuredClone(spec);
  def.apply(next, args, { seq: ctx.seq ?? 0, t: ctx.t ?? 0 });
  const errs = validateSpec(next);
  if (errs.length) throw new OpError(`应用后规格不合法：${errs[0]}`);
  return next;
}

/** 从基础规格重放历史。无法重放的操作（例如基础设定已变化导致冲突）会被跳过并报告。 */
export function replay(base, history) {
  let spec = base;
  const skipped = [];
  for (const rec of history) {
    try { spec = applyOp(spec, rec, rec); } catch (e) { skipped.push({ seq: rec.seq, op: rec.op, error: e.message }); }
  }
  return { spec, skipped };
}

/** 追加写的审计日志（data/ops.jsonl）。日志只用于审计，重放以存档中的历史为准。 */
export class OpJournal {
  constructor(file) { this.file = file; }
  append(rec) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.warn('[ops] 写日志失败：', e.message);
    }
  }
}
