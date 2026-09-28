// 世界补丁提案（设计文档 5.3 / 8.1）：校验 → 设定考据 → 审批 → （施工）→ 落地。
// 审批：本地模式 小改自动通过、大改等管理员确认；公网模式 小改和大改都先访客投票，再由管理员终审。
// 自主演化 E1：管理员终审窗口（真实时间，minor 6 小时 / major 24 小时）超时后，交给 AI 裁决官决定（不再作废）。
import { OPS, applyOp, OpError } from '../kernel/ops.ts';
import { findPlacement, checkPlacement, solvePath, solveBridge, solveRect, checkEdit, outdoorSize, choosePassages } from '../kernel/placement.ts';
import { addMemory, fmtTime } from '../memory.ts';
import { review } from './canon.ts';
import { impactOf } from '../kernel/impact.ts';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const LEVELS = ['micro', 'minor', 'major'];
const VOTE_MINUTES = 60;
const DAILY_QUOTA = { minor: 3, major: 1 };
const MAX_OPEN = 10;
const PROTECT_DAYS = 7; // 建成不满这么多天的建筑不能拆（地图演变 §6.3）
const DEMOLISH_GAP_DAYS = 3; // 两次拆除至少间隔
const EXPAND_GAP_DAYS = 7; // 两次扩展（含新建相邻 / 远处的地图）至少间隔
const EXPANSION = new Set(['expandMap', 'addAdjacentRegion', 'addRegion']);
const RESIDENTIAL = new Set(['hut', 'cabin', 'cottage', 'house', 'farmhouse', 'inn', 'tavern']);
/** 操作的审批等级：有的操作按参数决定（变成废墟是大改） */
export const levelOf = (o) => OPS[o.op].levelOf?.(o.args) || OPS[o.op].level;
/** 会让建筑消失（或变成废墟）的操作：需要搬迁去处、施工、居民议事 */
export const isDemolition = (o) => o.op === 'removeBuilding' || (o.op === 'setBuildingState' && o.args?.state === 'ruin');
// 架构师（以及导演、居民、访客的点子）可以提出的操作；管理员直接提交时还可以调参数、改分级
export const ARCHITECT_OPS = ['addBuilding', 'setBuildingState', 'renovateBuilding', 'removeBuilding', 'restoreBuilding', 'addPath', 'addBridge', 'clearArea', 'plantGrove', 'addOutdoorPlace', 'expandMap', 'addAdjacentRegion', 'addRegion', 'linkRegions', 'addCalendarEvent', 'addWeather', 'addItem', 'addStructure', 'addAbility', 'addRule', 'addCanon'];
export const ADMIN_OPS = [...ARCHITECT_OPS, 'setParam', 'setMeta'];
const FINAL = new Set(['applied', 'rejected', 'failed', 'expired', 'reverted']);

export class ProposalSystem {
  constructor(town) {
    this.town = town;
    this.requireAdmin = false;
    town.decisions?.register('proposal', {
      dossier: (d) => this.dossier(this.get(d.ref)),
      gates: (d) => {
        const p = this.get(d.ref);
        if (!p) return '提案不存在';
        if (p.canon && !p.canon.ok) return `设定考据未通过：${p.canon.issues.join('；')}`;
        const r = this.prepare(p.ops, ADMIN_OPS);
        return r.error ? `在当前世界上已经无法实施：${r.error}` : null;
      },
      tally: (d) => this.tally(this.get(d.ref)),
      resolve: (d, { adopt, by }) => {
        const p = this.get(d.ref);
        if (!p || !['voting', 'awaiting'].includes(p.status)) return;
        if (adopt) this.approve(p, by === 'admin' || by === 'owner' ? by : 'ai');
        else this.finish(p, 'rejected', by === 'admin' ? '管理员没有批准' : by === 'owner' ? '世界的创建者没有批准' : 'AI 裁决官没有采纳');
      },
      undo: (d) => this.undo(this.get(d.ref)),
    });
  }

  riskOf(p) { return p.level === 'major' ? 'high' : 'medium'; }

  dossier(p) {
    if (!p) return '（提案不存在）';
    return `建设提案「${p.title}」（${p.level === 'major' ? '大改' : '小改'}，来自${this.originText(p.origin)}）
动机：${p.motive || '（无）'}
内容：${p.ops.map((o) => OPS[o.op].describe?.(o.args, this.town.spec) || o.op).join('；')}
设定考据：${p.canon ? (p.canon.ok ? `通过${p.canon.notes ? `（${p.canon.notes}）` : ''}` : `未通过：${p.canon.issues.join('；')}`) : '未完成'}
今天已落地：小改 ${this.appliedToday('minor')} 个，大改 ${this.appliedToday('major')} 个`;
  }

  /** 撤销已采纳的提案：已落地的回滚它带来的世界变化；施工中 / 排队中的直接取消 */
  undo(p) {
    if (!p) return '提案不存在';
    if (p.status === 'applied') {
      const n = this.town.revertOps((r) => r.cause?.proposal === p.id);
      p.status = 'reverted';
      this.town.council?.afterUndone(p);
      p.result = { t: Math.floor(this.town.t), reason: `撤销（回滚了 ${n} 项世界变化）` };
    } else if (['building', 'queued', 'council'].includes(p.status)) {
      this.finish(p, 'rejected', '被撤销');
    } else return '这个提案现在不能撤销';
    this.town.log('proposal', `↩️ 提案「${p.title}」被撤销`, {});
    this.town.emit('proposals');
    return null;
  }
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
          if (r.error) this.town.mapPressure?.placeFailed();
          if (r.error) return { error: `第 ${i + 1} 个操作（${args.name || args.id}）：${r.error}` };
          Object.assign(args, { x: r.x, y: r.y, w, h, near });
        }
        delete args.place;
        const e = OPS.addBuilding.check(spec, args) || checkPlacement(spec, args);
        if (e) return { error: `第 ${i + 1} 个操作（${args.name || args.id}）：${e}` };
      }
      const solved = this.solveTerrain(spec, name, args);
      if (solved) {
        if (/找不到/.test(solved)) this.town.mapPressure?.placeFailed();
        return { error: `第 ${i + 1} 个操作（${name}）：${solved}` };
      }
      if (EXPANSION.has(name) && allowed === ARCHITECT_OPS) {
        const last = this.list.filter((p) => p.status === 'applied' && p.ops.some((o) => EXPANSION.has(o.op))).map((p) => p.appliedDay).sort((x, y) => y - x)[0];
        if (last != null && this.town.day - last < EXPAND_GAP_DAYS) return { error: `第 ${last} 天刚扩展过地图，${EXPAND_GAP_DAYS} 天之内不再扩展` };
      }
      if (isDemolition({ op: name, args })) {
        const err = this.demolitionProblem(spec, args.id);
        if (err) return { error: `第 ${i + 1} 个操作：${err}` };
        args.remap = this.suggestRemap(spec, args.id, args.remap);
      }
      try { spec = applyOp(spec, { op: name, args }); } catch (e) {
        return { error: `第 ${i + 1} 个操作（${name}）：${e instanceof OpError ? e.message : '无法应用'}` };
      }
      ops.push({ op: name, args });
    }
    // 远处的新区域要同时打通路口，否则开出来没人去得了
    for (const o of ops) if (o.op === 'addRegion' && !ops.some((x) => x.op === 'linkRegions' && x.args.region === o.args.id && x.args.open !== false)) {
      if (allowed === ARCHITECT_OPS) return { error: `新区域「${o.args.name || o.args.id}」需要同时用 linkRegions 打通路口（entry 是主地图上的路口地点）` };
    }
    return { ops };
  }

  submit({ title, motive = '', ops: rawOps, origin = 'admin', construction = null, allowed = ARCHITECT_OPS }) {
    const town = this.town;
    if (this.open().length >= MAX_OPEN) return { error: '待处理的提案太多了，请先处理已有的提案' };
    const r = this.prepare(rawOps, allowed);
    if (r.error) return r;
    const level = r.ops.reduce((lv, o) => (LEVELS.indexOf(levelOf(o)) > LEVELS.indexOf(lv) ? levelOf(o) : lv), 'micro');
    const building = r.ops.find((o) => o.op === 'addBuilding');
    const demolish = !building && r.ops.find(isDemolition);
    const site = building ? { x: building.args.x, y: building.args.y, w: building.args.w, h: building.args.h, near: building.args.near || null }
      : demolish ? this.siteOf(demolish.args.id) : null;
    const p = {
      id: `wp${++town.seq}`, title: str(title, 24) || '小镇建设', motive: str(motive, 80), origin, ops: r.ops, level,
      status: 'review', createdT: Math.floor(town.t), votes: {}, canon: null, result: null,
      construction: site ? {
        by: (Array.isArray(construction?.by) && construction.by.length ? construction.by : this.defaultCrew()).map((n) => str(n, 12)).slice(0, 3),
        hours: Math.max(1, Math.min(12, Math.round(Number(construction?.hours) || 4))),
        site, ...(demolish ? { kind: 'demolish' } : {}),
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
    return { director: '叙事导演', visitor: '访客的建议', admin: '管理员', architect: '世界架构师', planner: '地图压力表' }[origin] || origin;
  }

  route(p) {
    const town = this.town;
    // 拆除（或变成废墟）先经过居民议事，通过之后才走下面的终审
    if (p.ops.some(isDemolition) && !p.council?.pass && town.council) return town.council.start(p);
    if (p.level === 'micro' || (!this.requireAdmin && p.level === 'minor')) return this.approve(p, 'auto');
    if (this.requireAdmin) {
      p.status = 'voting';
      p.voteUntil = Math.floor(town.t) + VOTE_MINUTES;
      town.log('proposal', `🗳️ 提案「${p.title}」开始征求意见（${fmtTime(p.voteUntil)} 截止，之后由管理员终审；无人终审时由 AI 裁决官决定）`, {});
    } else {
      p.status = 'awaiting';
      this.openDecision(p);
      town.log('proposal', `⏳ 提案「${p.title}」改动较大，等待管理员确认（无人确认时由 AI 裁决官决定）`, {});
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

  openDecision(p) {
    const d = this.town.decisions?.open({ kind: 'proposal', ref: p.id, title: p.title, summary: p.motive, risk: this.riskOf(p) });
    if (d) p.decision = d.id;
  }

  /** 管理员终审（投票期间也可以直接决定） */
  decide(id, approve, by = 'admin') {
    const p = this.get(id);
    if (!p || !['voting', 'awaiting', 'queued'].includes(p.status)) return '这个提案现在不能终审';
    this.town.decisions?.cancel('proposal', p.id);
    if (approve) this.approve(p, by);
    else this.finish(p, 'rejected', by === 'owner' ? '世界的创建者没有批准' : '管理员没有批准');
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
    // 有插件接管（例如施工插件：搭脚手架、安排工人，工期结束后由 tick 落地）时交给插件；否则直接落地
    if (town.hooks?.claim('proposal.approved', p)) return;
    this.apply(p);
  }

  apply(p) {
    const town = this.town;
    // 距离提交可能已经过了一段时间：先按原坐标在最新的世界上校验，原位置被占用时才重新选址
    let r = this.prepare(p.ops, ADMIN_OPS);
    if (r.error && p.ops.some((o) => o.op === 'addBuilding' && o.args.near)) {
      r = this.prepare(p.ops.map((o) => (o.op === 'addBuilding' && o.args.near ? { op: o.op, args: { ...o.args, x: undefined, y: undefined, place: { near: o.args.near } } } : o)), ADMIN_OPS);
    }
    if (r.error) return this.finish(p, 'failed', r.error);
    for (const o of r.ops) if (o.op === 'addBuilding' || o.op === 'expandMap') o.args.builtDay = town.day;
    const before = town.spec;
    try {
      for (const o of r.ops) town.applyWorldOp(o, { by: 'proposal', proposal: p.id, origin: p.origin });
    } catch (e) {
      return this.finish(p, 'failed', e.message);
    }
    p.ops = r.ops;
    p.appliedDay = town.day;
    this.finish(p, 'applied', null);
    town.hooks?.emit('proposal.applied', p);
    const built = r.ops.find((o) => o.op === 'addBuilding');
    if (built) {
      for (const a of town.agents) if (a.kind !== 'creature') addMemory(a, { t: town.t, type: 'event', text: `镇上新建了「${built.args.name}」`, importance: 5 });
    }
    for (const o of r.ops.filter(isDemolition)) this.afterDemolition(p, o, before);
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
        this.openDecision(p);
        this.town.log('proposal', `🗳️ 提案「${p.title}」意见征集结束（赞成 ${this.tally(p).yes} / 反对 ${this.tally(p).no}），等待管理员终审`, {});
        this.town.emit('proposals');
      } else if (p.status === 'awaiting' && !p.decision && this.town.decisions) {
        this.openDecision(p); // 旧存档里等待中的提案：补开决策项
      } else if (p.status === 'building' && t >= p.finishT) {
        this.apply(p);
      } else if (p.status === 'queued' && this.appliedToday(p.level) < (DAILY_QUOTA[p.level] ?? Infinity)) {
        this.approve(p, p.approvedBy || 'auto');
      }
    }
  }

  /** 地形操作：模型只给意图（from / to / near / 大小），这里求出具体的格子；返回错误或 null（结果写回 args） */
  solveTerrain(spec, name, args) {
    const seed = (this.town.seq + 1) % 100000;
    if (name === 'addPath' && !Array.isArray(args.cells)) {
      const r = solvePath(spec, args.from, args.to);
      if (r.error) return r.error;
      args.cells = r.cells;
    } else if (name === 'addBridge' && !Array.isArray(args.cells)) {
      const r = solveBridge(spec, args.near ?? args.place?.near);
      if (r.error) return r.error;
      args.cells = r.cells;
    } else if (name === 'clearArea' && !args.rect) {
      const r = solveRect(spec, { mode: 'clear', w: Math.max(3, Math.min(10, Math.round(Number(args.w) || 6))), h: Math.max(3, Math.min(10, Math.round(Number(args.h) || 5))), near: args.near ?? args.place?.near });
      if (r.error) return r.error;
      args.rect = r.rect;
    } else if (name === 'plantGrove' && !Array.isArray(args.trees)) {
      const r = solveRect(spec, { mode: 'grove', w: Math.max(2, Math.min(8, Math.round(Number(args.w) || 5))), h: Math.max(2, Math.min(8, Math.round(Number(args.h) || 4))), near: args.near ?? args.place?.near, seed });
      if (r.error) return r.error;
      args.trees = r.trees.map(([x, y, k]) => [x, y, ['oak', 'pine', 'sakura'].includes(args.trees) ? args.trees : k]);
    } else if (name === 'addOutdoorPlace' && !args.rect) {
      const size = outdoorSize(args.kind);
      if (!size) return `kind 未知：${args.kind}`;
      const r = solveRect(spec, { mode: 'place', w: size[0], h: size[1], near: args.near ?? args.place?.near, id: args.id, placeKind: args.kind, seed });
      if (r.error) return r.error;
      Object.assign(args, { rect: r.rect, seed });
    } else if (name === 'addAdjacentRegion') {
      if (args.seed == null) args.seed = seed;
      args.length = Math.max(32, Math.min(96, Math.round(Number(args.length) || 48)));
      if (!Array.isArray(args.passages)) {
        const r = choosePassages(spec, args.from || 'town', args.side);
        if (r.error) return r.error;
        args.passages = r.passages;
      }
    } else if (name === 'expandMap') {
      if (args.seed == null) args.seed = seed;
      args.by = Math.round(Number(args.by) || 12);
    } else if (name === 'plantGrove' || name === 'addOutdoorPlace') {
      // 坐标是现成的（落地前按原位置再校验一次）
      const edit = name === 'plantGrove' ? { kind: 'grove', trees: args.trees } : { kind: 'place', id: args.id, placeKind: args.kind, rect: args.rect, seed: args.seed };
      const e = checkEdit(spec, edit);
      if (e) return e;
    }
    delete args.place;
    return null;
  }

  /** 施工队：没指定时找两位在场、不是生物的居民（优先在工坊一类地方工作的人） */
  defaultCrew() {
    const people = this.town.agents.filter((a) => a.kind !== 'creature' && a.kind !== 'traveller');
    const handy = people.filter((a) => /匠|木工|铁|建筑|工坊|修/.test(a.role));
    return (handy.length ? handy : people).slice(0, 2).map((a) => a.name);
  }

  siteOf(id) {
    const b = this.town.world.buildings.find((x) => x.id === id);
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h, near: b.id, id: b.id } : null;
  }

  /** 拆除（或变成废墟）在运行时的限制：进行中的剧情用到的地点、保护期、两次拆除的间隔 */
  demolitionProblem(spec, id) {
    const town = this.town;
    const b = spec.buildings.find((x) => x.id === id && !x.removed);
    if (!b) return `未知建筑：${id}`;
    const run = town.arcs?.active();
    const tpl = run && spec.arcs.find((a) => a.id === run.template);
    if (tpl && JSON.stringify(tpl).includes(`"${id}"`)) return `「${b.name}」是进行中的剧情《${tpl.title}》里的地方，剧情落幕之后才能拆`;
    if (b.builtDay != null && town.day - b.builtDay < PROTECT_DAYS) return `「${b.name}」建成还不到 ${PROTECT_DAYS} 天，先用一段时间再说`;
    const veto = town.council?.vetoes[id];
    if (veto != null && town.day < veto) return `居民刚否决过拆除「${b.name}」，第 ${veto} 天之前不能再提`;
    const last = this.list.filter((p) => p.status === 'applied' && p.ops.some(isDemolition)).map((p) => p.appliedDay).sort((x, y) => y - x)[0];
    if (last != null && town.day - last < DEMOLISH_GAP_DAYS) return `第 ${last} 天刚拆过房子，${DEMOLISH_GAP_DAYS} 天之内不再拆`;
    return null;
  }

  /** 模型没给（或给错）搬迁去处时，补上最近的合适地点：住处找住得下的住宅，工作地与节日等找最近的公共地点 */
  suggestRemap(spec, id, remap = {}) {
    const town = this.town;
    const out = { ...(remap && typeof remap === 'object' ? remap : {}) };
    const im = impactOf(spec, id);
    const at = town.locCenter(id) || { x: 0, y: 0 };
    const dist = (loc) => { const c = town.locCenter(loc); return c ? Math.hypot(c.x - at.x, c.y - at.y) : 999; };
    const occ = (bid) => spec.personas.filter((p) => p.status !== 'departed' && p.kind !== 'creature' && p.home === bid).length;
    const moving = spec.personas.filter((p) => p.status !== 'departed' && im.residents.includes(p.id)).length;
    const okHome = (bid) => { const b = spec.buildings.find((x) => x.id === bid && !x.removed); return b && b.id !== id && b.state !== 'ruin' && (b.region || 'town') === 'town' && occ(bid) + moving <= 3; };
    if (im.residents.length && !okHome(out.residents)) {
      const homes = spec.buildings.filter((b) => okHome(b.id) && (RESIDENTIAL.has(b.kind) || occ(b.id) > 0)).sort((x, y) => dist(x.id) - dist(y.id));
      if (homes[0]) out.residents = homes[0].id;
    }
    const pub = Object.keys(spec.locations).filter((l) => l !== id && spec.locations[l].public && !spec.locations[l].region).sort((x, y) => dist(x) - dist(y));
    const isLoc = (l) => l && l !== id && (Object.hasOwn(spec.locations, l) || spec.buildings.some((b) => b.id === l && !b.removed));
    if (im.workers.length && !isLoc(out.workers)) out.workers = pub[0];
    if ((im.events.length || im.rules.length || im.spawn || im.gates.length) && !isLoc(out.location)) out.location = pub[0];
    return out;
  }

  /** 拆除落地之后：原址写进正典，住过、在那里工作过的人记得它（议事时当事人的重要记忆见 council.js） */
  afterDemolition(p, o, before) {
    const town = this.town;
    const b = before.buildings.find((x) => x.id === o.args.id);
    if (!b) return;
    const ruin = o.op === 'setBuildingState';
    const im = impactOf(before, b.id);
    const text = ruin ? `第${town.day}天，「${b.name}」成了一片废墟。` : `第${town.day}天，「${b.name}」被拆除，原址成了一片空地。`;
    try { town.applyWorldOp({ op: 'addCanon', args: { text: `${text}${p.motive ? `（${p.motive}）` : ''}`.slice(0, 100), tags: [b.name] } }, { by: 'proposal', proposal: p.id }, { quiet: true }); } catch {}
    if (p.council?.pass) return town.council.afterApplied(p); // 议事过的提案：当事人的重要记忆由议事结果给出
    for (const id of im.residents) {
      const a = town.byId[id];
      if (a) addMemory(a, { t: town.t, type: 'event', text: `「${b.name}」${ruin ? '成了废墟' : '拆了'}，我搬到了${town.locName(a.home)}`, importance: 7 });
    }
    for (const id of im.workers) {
      const a = town.byId[id];
      if (a) addMemory(a, { t: town.t, type: 'event', text: `「${b.name}」${ruin ? '成了废墟' : '拆了'}，以后我在${town.locName(a.work)}做事`, importance: 6 });
    }
  }

  tally(p) {
    const v = Object.values(p.votes);
    return { yes: v.filter(Boolean).length, no: v.filter((x) => !x).length };
  }

  view(p, key = null) {
    return {
      id: p.id, title: p.title, motive: p.motive, origin: this.originText(p.origin), level: p.level, status: p.status,
      createdT: p.createdT, voteUntil: p.voteUntil || null, finishT: p.finishT || null,
      decision: p.decision ? this.town.decisions?.get(p.decision) && { untilMs: this.town.decisions.get(p.decision).untilMs, status: this.town.decisions.get(p.decision).status } : null,
      ops: p.ops.map((o) => ({ op: o.op, desc: OPS[o.op].describe?.(o.args, this.town.spec) || o.op, rect: o.op === 'addBuilding' ? { x: o.args.x, y: o.args.y, w: o.args.w, h: o.args.h } : null })),
      canon: p.canon, tally: this.tally(p), mine: key ? p.votes[key] ?? null : null, result: p.result, construction: p.construction, council: this.town.council?.view(p) || null,
    };
  }
}
