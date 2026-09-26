// 世界补丁提案（设计文档 5.3 / 8.1）：校验 → 设定考据 → 审批 → （施工）→ 落地。
// 审批：本地模式 小改自动通过、大改等管理员确认；公网模式 小改和大改都先访客投票，再由管理员终审（不会自动通过，超时作废）。
import { OPS, applyOp, OpError } from '../kernel/ops.js';
import { findPlacement, checkPlacement } from '../kernel/placement.js';
import { addMemory, fmtTime } from '../memory.js';
import { review } from './canon.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const LEVELS = ['micro', 'minor', 'major'];
const VOTE_MINUTES = 60;
const ADMIN_WAIT = 1440; // 公网模式下等待管理员终审的最长时间（游戏分钟），超时作废
const DAILY_QUOTA = { minor: 3, major: 1 };
const MAX_OPEN = 10;
// 架构师（以及导演、居民、访客的点子）可以提出的操作；管理员直接提交时还可以调参数、改分级
export const ARCHITECT_OPS = ['addBuilding', 'addCalendarEvent', 'addWeather', 'addItem', 'addStructure', 'addAbility', 'addRule', 'addCanon'];
export const ADMIN_OPS = [...ARCHITECT_OPS, 'setParam', 'setMeta'];
const FINAL = new Set(['applied', 'rejected', 'failed', 'expired']);

export class ProposalSystem {
  constructor(town) { this.town = town; this.requireAdmin = false; }
  get list() { return (this.town.proposals ||= []); }
  get(id) { return this.list.find((p) => p.id === id); }
  open() { return this.list.filter((p) => !FINAL.has(p.status)); }

  /**
   * 在当前规格的副本上依次试应用：解析 place（自动选址）、检查占地与连通性。
   * 返回 { ops } 或 { error }；ops 里的建筑已经有了确定的坐标。
   */
  prepare(rawOps, allowed = ARCHITECT_OPS) {
    if (!Array.isArray(rawOps) || !rawOps.length) return { error: '补丁里没有任何操作' };
    if (rawOps.length > 6) return { error: '一个补丁最多 6 个操作' };
    let spec = this.town.spec;
    const ops = [];
    for (const [i, raw] of rawOps.entries()) {
      const name = String(raw?.op || '');
      if (!allowed.includes(name) || !Object.hasOwn(OPS, name)) return { error: `第 ${i + 1} 个操作不允许：${name}` };
      const args = raw.args && typeof raw.args === 'object' ? structuredClone(raw.args) : {};
      if (name === 'addBuilding') {
        if (args.x == null || args.y == null) {
          // 模型常把 place 写扁（args.near / args.within）或写成字符串：意思明确，照样接受
          const place = typeof args.place === 'string' ? { near: args.place } : args.place || {};
          const near = place.near ?? args.near;
          const within = Math.max(4, Math.min(16, Number(place.within ?? args.within) || 12));
          const w = Math.round(Number(args.w) || 4), h = Math.round(Number(args.h) || 4);
          const r = findPlacement(spec, { id: args.id, name: args.name, w, h, near, within });
          if (r.error) return { error: `第 ${i + 1} 个操作（${args.name || args.id}）：${r.error}` };
          Object.assign(args, { x: r.x, y: r.y, w, h, near });
        }
        delete args.place;
        const e = OPS.addBuilding.check(spec, args) || checkPlacement(spec, args);
        if (e) return { error: `第 ${i + 1} 个操作（${args.name || args.id}）：${e}` };
      }
      try { spec = applyOp(spec, { op: name, args }); } catch (e) {
        return { error: `第 ${i + 1} 个操作（${name}）：${e instanceof OpError ? e.message : '无法应用'}` };
      }
      ops.push({ op: name, args });
    }
    return { ops };
  }

  submit({ title, motive = '', ops: rawOps, origin = 'admin', construction = null, allowed = ARCHITECT_OPS }) {
    const town = this.town;
    if (this.open().length >= MAX_OPEN) return { error: '待处理的提案太多了，请先处理已有的提案' };
    const r = this.prepare(rawOps, allowed);
    if (r.error) return r;
    const level = r.ops.reduce((lv, o) => (LEVELS.indexOf(OPS[o.op].level) > LEVELS.indexOf(lv) ? OPS[o.op].level : lv), 'micro');
    const building = r.ops.find((o) => o.op === 'addBuilding');
    const p = {
      id: `wp${++town.seq}`, title: str(title, 24) || '小镇建设', motive: str(motive, 80), origin, ops: r.ops, level,
      status: 'review', createdT: Math.floor(town.t), votes: {}, canon: null, result: null,
      construction: building ? {
        by: (Array.isArray(construction?.by) ? construction.by : ['赵铁柱']).map((n) => str(n, 12)).slice(0, 3),
        hours: Math.max(1, Math.min(12, Math.round(Number(construction?.hours) || 4))),
        site: { x: building.args.x, y: building.args.y, w: building.args.w, h: building.args.h, near: building.args.near || null },
      } : null,
    };
    this.list.push(p);
    if (this.list.length > 60) this.list.splice(0, this.list.findIndex((x) => FINAL.has(x.status)) + 1 || 1);
    town.log('proposal', `🛠️ 新的建设提案「${p.title}」（${this.originText(origin)}）`, {});
    town.emit('proposals');
    review(town, p).then((c) => {
      p.canon = c;
      if (!c.ok) this.finish(p, 'rejected', `设定考据未通过：${c.issues.join('；')}`);
      else this.route(p);
    }).catch((e) => this.finish(p, 'failed', e.message));
    return { proposal: p };
  }

  originText(origin) {
    if (origin.startsWith('agent:')) return `${this.town.byId[origin.slice(6)]?.name || '居民'}的点子`;
    return { director: '叙事导演', visitor: '访客的建议', admin: '管理员', architect: '世界架构师' }[origin] || origin;
  }

  route(p) {
    const town = this.town;
    if (p.level === 'micro' || (!this.requireAdmin && p.level === 'minor')) return this.approve(p, 'auto');
    if (this.requireAdmin) {
      p.status = 'voting';
      p.voteUntil = Math.floor(town.t) + VOTE_MINUTES;
      town.log('proposal', `🗳️ 提案「${p.title}」开始征求意见（${fmtTime(p.voteUntil)} 截止，之后由管理员终审）`, {});
    } else {
      p.status = 'awaiting';
      town.log('proposal', `⏳ 提案「${p.title}」改动较大，等待管理员确认`, {});
    }
    town.emit('proposals');
  }

  vote(id, key, yes) {
    const p = this.get(id);
    if (!p || (p.status !== 'voting' && p.status !== 'awaiting')) return '这个提案现在不能投票';
    if (p.votes[key] != null) return '你已经投过票了';
    p.votes[key] = Boolean(yes);
    this.town.emit('proposals');
    return null;
  }

  /** 管理员终审（投票期间也可以直接决定） */
  decide(id, approve, by = 'admin') {
    const p = this.get(id);
    if (!p || !['voting', 'awaiting', 'queued'].includes(p.status)) return '这个提案现在不能终审';
    if (approve) this.approve(p, by);
    else this.finish(p, 'rejected', '管理员没有批准');
    return null;
  }

  appliedToday(level) {
    const day = this.town.day;
    return this.list.filter((p) => p.appliedDay === day && p.level === level).length;
  }

  approve(p, by) {
    const town = this.town;
    p.approvedBy = by;
    if (DAILY_QUOTA[p.level] != null && this.appliedToday(p.level) >= DAILY_QUOTA[p.level]) {
      p.status = 'queued';
      town.log('proposal', `📋 提案「${p.title}」已批准，今天的建设额度用完了，明天再动工`, {});
      town.emit('proposals');
      return;
    }
    p.appliedDay = town.day; // 先占用当天额度（施工中的也算）
    if (p.construction) this.startConstruction(p);
    else this.apply(p);
  }

  startConstruction(p) {
    const town = this.town;
    const { site, hours, by } = p.construction;
    p.status = 'building';
    p.finishT = Math.floor(town.t) + hours * 60;
    town.spawnStructure('scaffold', { x: site.x + site.w / 2 - 0.5, y: site.y + site.h - 1, inside: null }, hours * 60);
    const start = Math.floor(town.minute) + 10;
    const workers = [];
    for (const name of by) {
      const a = town.agents.find((x) => x.name === name || x.id === name);
      if (!a || a.kind === 'creature') continue;
      if (site.near && start < 22 * 60 && town.addCommitment(a, { time: fmtTime(start), duration: Math.min(hours * 60, 22 * 60 - start), location: site.near, activity: `施工：${p.title}`, emoji: '🚧' }, '（小镇的建设任务）')) workers.push(a.name);
    }
    town.log('proposal', `🚧 「${p.title}」开工了${workers.length ? `，${workers.join('、')}负责施工` : ''}，预计 ${fmtTime(p.finishT)} 完工`, {});
    town.emit('proposals');
  }

  apply(p) {
    const town = this.town;
    // 距离提交可能已经过了一段时间：先按原坐标在最新的世界上校验，原位置被占用时才重新选址
    let r = this.prepare(p.ops, ADMIN_OPS);
    if (r.error && p.ops.some((o) => o.op === 'addBuilding' && o.args.near)) {
      r = this.prepare(p.ops.map((o) => (o.op === 'addBuilding' && o.args.near ? { op: o.op, args: { ...o.args, x: undefined, y: undefined, place: { near: o.args.near } } } : o)), ADMIN_OPS);
    }
    if (r.error) return this.finish(p, 'failed', r.error);
    try {
      for (const o of r.ops) town.applyWorldOp(o, { by: 'proposal', proposal: p.id, origin: p.origin });
    } catch (e) {
      return this.finish(p, 'failed', e.message);
    }
    p.ops = r.ops;
    p.appliedDay = town.day;
    this.finish(p, 'applied', null);
    const built = r.ops.find((o) => o.op === 'addBuilding');
    if (built) {
      for (const a of town.agents) if (a.kind !== 'creature') addMemory(a, { t: town.t, type: 'event', text: `镇上新建了「${built.args.name}」`, importance: 5 });
    }
    if (p.origin.startsWith('agent:')) {
      const a = town.byId[p.origin.slice(6)];
      if (a) addMemory(a, { t: town.t, type: 'event', text: `我提议的「${p.title}」实现了！`, importance: 7 });
    }
  }

  finish(p, status, reason) {
    p.status = status;
    p.result = { t: Math.floor(this.town.t), reason };
    const text = {
      applied: `✅ 提案「${p.title}」落地了`, rejected: `❌ 提案「${p.title}」被驳回${reason ? `：${reason}` : ''}`,
      failed: `⚠️ 提案「${p.title}」没能实施${reason ? `：${reason}` : ''}`, expired: `⌛ 提案「${p.title}」无人终审，已作废`,
    }[status];
    this.town.log('proposal', text, {});
    this.town.emit('proposals');
  }

  tick() {
    const t = this.town.t;
    for (const p of this.list) {
      if (p.status === 'voting' && t >= p.voteUntil) {
        p.status = 'awaiting';
        p.awaitUntil = Math.floor(t) + ADMIN_WAIT;
        this.town.log('proposal', `🗳️ 提案「${p.title}」意见征集结束（赞成 ${this.tally(p).yes} / 反对 ${this.tally(p).no}），等待管理员终审`, {});
        this.town.emit('proposals');
      } else if (p.status === 'awaiting' && this.requireAdmin && t >= (p.awaitUntil ?? Infinity)) {
        this.finish(p, 'expired', null);
      } else if (p.status === 'building' && t >= p.finishT) {
        this.apply(p);
      } else if (p.status === 'queued' && this.appliedToday(p.level) < (DAILY_QUOTA[p.level] ?? Infinity)) {
        this.approve(p, p.approvedBy || 'auto');
      }
    }
  }

  tally(p) {
    const v = Object.values(p.votes);
    return { yes: v.filter(Boolean).length, no: v.filter((x) => !x).length };
  }

  view(p, key = null) {
    return {
      id: p.id, title: p.title, motive: p.motive, origin: this.originText(p.origin), level: p.level, status: p.status,
      createdT: p.createdT, voteUntil: p.voteUntil || null, awaitUntil: p.awaitUntil || null, finishT: p.finishT || null,
      ops: p.ops.map((o) => ({ op: o.op, desc: OPS[o.op].describe?.(o.args) || o.op, rect: o.op === 'addBuilding' ? { x: o.args.x, y: o.args.y, w: o.args.w, h: o.args.h } : null })),
      canon: p.canon, tally: this.tally(p), mine: key ? p.votes[key] ?? null : null, result: p.result, construction: p.construction,
    };
  }
}
