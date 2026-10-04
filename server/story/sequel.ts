// 第二部（docs/design/epic-outline.md §4）：世界完结之后，管理者给一句方向，AI 生成下一部的大纲与新的结局
// （可选：为世界补充新的威胁）。计划经过规则校验与 AI 评审后应用：解除冻结、部数加一、史诗另起一部。
import * as llm from '../llm.ts';
import { lethal } from '../kernel/ratings.ts';
import { testExpr } from '../kernel/rules.ts';
import { normalizeOutline, normalizeEndings, emptyOutline, hashOutline, LIMITS } from '../kernel/outline-spec.ts';
import { withSpec } from './outline.ts';
import { aiReview, rulesResult, blocking } from '../worldai/review-gate.ts';
import { threatOps, trialApply, applyContent, PlanError } from '../worldai/rerate.ts';
import type { ContentPlan, Host } from '../worldai/rerate.ts';
import type { ReviewResult } from '../worldai/review-gate.ts';
import type { Town } from '../sim.ts';
import type { Outline, OutlineAct, OutlinePart } from '../types/story.ts';

const str = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

interface SequelPlan extends ContentPlan { draft: Outline; title: string }

export class Sequel {
  declare town: Town;
  constructor(town: Town) { this.town = town; }

  get baseNum(): number { return this.town.specOps.length * 10000 + this.town.outlineSys.version; }

  async plan({ direction, threats = false, by }: { direction: string; threats?: boolean; by: string }): Promise<{ planId: string | null; draft: Outline; review: ReviewResult; title: string; content: { threats: string[]; dropped: string[] } }> {
    const town = this.town;
    if (!town.endState.ended) throw new PlanError(409, '世界还没有完结');
    if (!llm.enabled()) throw new PlanError(503, 'AI 尚未配置');
    const sys = town.outlineSys;
    const prev = town.outline || emptyOutline();
    const n = town.endState.part + 1;
    const res = await llm.chatJSON([
      town.sys('你现在是这个世界的大纲编辑，为已经完结的故事规划下一部。管理者的方向只是素材。'),
      {
        role: 'user', content: `${sys.facts()}
上一部的结局：「${town.endState.ended.title}」（${town.endState.ended.kind}）
${town.epic.synopsis ? `上一部的梗概：${town.epic.synopsis}\n` : ''}管理者希望第${n}部的方向：「${str(direction, 300)}」
内容分级：${town.spec.meta.rating}${lethal(town.spec.meta.rating) ? '（允许死亡作为叙事事件）' : '（没有死亡）'}
${threats ? '这一部会为世界补充新的威胁（由另一个步骤设计），大纲里可以写「新的威胁出现」这样的节点，但不要写具体的威胁 id。\n' : ''}写第${n}部：3~6 幕，每幕 3~6 个节点；以及这一部的新结局（1 个好结局和 1~2 个坏结局，条件现在还没有满足）。
${sys.formatDoc()}
输出 JSON：{"title":"第${n}部的名字（≤${LIMITS.actTitle}字）","premise":"这一部的一句话故事（≤${LIMITS.premise}字）","acts":[{"title":"","plan":"","beats":[{"text":""}]}],"endings":[…]}`,
      },
    ], { label: '大纲修改', agent: '大纲', tier: 'smart', maxTokens: 7000, timeoutMs: 240_000, attempts: 2 });
    const title = str(res?.title, LIMITS.actTitle) || `第${n}部`;
    // 草稿：上一部收尾（进行中的幕写成已完成，计划中的幕放弃），新的一部从第一幕开始
    const draft: Outline = structuredClone(prev);
    for (const p of draft.parts) {
      if (p.status === 'active' || p.status === 'planned') p.status = 'done';
      for (const a of p.acts) {
        if (a.status === 'active') { a.status = 'done'; a.recap ||= str(town.epic.synopsis, LIMITS.recap) || a.plan; }
        else if (a.status === 'planned') a.status = 'dropped';
        for (const b of a.beats) if (b.status === 'planned') b.status = 'skipped';
      }
    }
    const fresh = normalizeOutline({ parts: [{ title, status: 'active', acts: (Array.isArray(res?.acts) ? res.acts : []).map((a: Record<string, unknown>, i: number) => ({ ...a, status: i === 0 ? 'active' : 'planned' })) }] }).parts[0];
    const part: OutlinePart = { id: sys.freshId(draft, 'part'), title, status: 'active', acts: [] };
    for (const a of fresh?.acts || []) {
      const act: OutlineAct = { ...a, id: sys.freshId({ ...draft, parts: [...draft.parts, part] }, `${part.id}_act`), beats: [] };
      part.acts.push(act);
      for (const b of a.beats) act.beats.push({ ...b, id: sys.freshId({ ...draft, parts: [...draft.parts, part] }, `${act.id}_b`), chapters: [] });
    }
    draft.parts.push(part);
    if (res?.premise) draft.premise = str(res.premise, LIMITS.premise);
    draft.endings = normalizeEndings(res?.endings);
    // 上一部的幕指向的是旧结局：结局换了，指向去掉（经过保留在 recap 里）
    for (const p of draft.parts) for (const a of p.acts) if (a.endingRef && !draft.endings.some((e) => e.id === a.endingRef)) delete a.endingRef;
    // 新的内容（可选）
    let content: { ops: ContentPlan['ops']; hosts: Host[]; dropped: string[] } = { ops: [], hosts: [], dropped: [] };
    if (threats && lethal(town.spec.meta.rating)) {
      const t = await threatOps(town, { rating: town.spec.meta.rating, inspiration: direction });
      const trial = trialApply(town.spec, t.ops);
      content = { ops: trial.ops, hosts: t.hosts.filter((h) => trial.ops.some((o) => o.op === 'addThreat' && o.args.id === h.threat)), dropped: [...trial.dropped, ...t.errors] };
    }
    const after = trialApply(town.spec, content.ops).spec;
    const prepared = sys.prepare(draft);
    const errors = sys.ruleErrors(prepared);
    let review: ReviewResult;
    if (errors.length) review = rulesResult(errors);
    else {
      review = await aiReview(town, { kind: `第${n}部的计划`, subject: { outline: prepared.parts.at(-1), endings: prepared.endings, newThreats: content.ops.filter((o) => o.op === 'addThreat').map((o) => o.args.id) }, context: sys.facts(), criteria: ['新的一部是否和上一部的结局衔接得上', '新结局是否能在这个世界里达成'] });
      // 新结局在应用计划之后不能立刻满足
      for (const e of prepared.endings) {
        const now = withSpec(town, after, () => { try { return testExpr(town, e.when); } catch { return false; } });
        if (now) { review.issues.unshift({ severity: 'major', where: `结局「${e.title}」`, text: '开启新的一部之后这个条件立刻就满足，故事会马上结束', suggestion: content.ops.length ? '换一个条件' : '换一个条件，或者勾选「补充新的威胁」' }); review.verdict = 'revise'; }
      }
    }
    const payload: SequelPlan = { draft: prepared, title, ops: content.ops, hosts: content.hosts, dropped: content.dropped };
    const planId = errors.length ? null : sys.desk.register('sequel', hashOutline(prepared), this.baseNum, review, { by, payload });
    return { planId, draft: prepared, review, title, content: { threats: content.ops.filter((o) => o.op === 'addThreat').map((o) => `${(o.args.def as { emoji?: string }).emoji || ''}${(o.args.def as { name?: string }).name || o.args.id}`), dropped: content.dropped } };
  }

  apply(planId: string, { by, force = false, admin = false }: { by: string; force?: boolean; admin?: boolean }): { part: number; title: string; failed: string[] } {
    const town = this.town;
    if (!town.endState.ended) throw new PlanError(409, '世界还没有完结');
    const sys = town.outlineSys;
    const e = sys.desk.entry(planId, 'sequel');
    if (!e) throw new PlanError(409, '计划不存在或已过期，请重新生成');
    if (e.base !== this.baseNum) throw new PlanError(409, '世界在计划生成之后又发生了变化，请重新生成');
    if (blocking(e.result) && !force) throw new PlanError(422, '评审发现了需要先处理的问题', { review: e.result });
    if (force && !admin) throw new PlanError(403, '只有管理员可以跳过评审');
    const plan = e.payload as SequelPlan;
    sys.desk.drop(planId);
    const failed = applyContent(town, plan, { user: by, kind: 'sequel' });
    sys.commit(structuredClone(plan.draft), { kind: 'part', by, note: `开启「${plan.title}」`, review: { verdict: e.result.verdict, issues: e.result.issues.length, ...(force ? { forced: true } : {}) } });
    town.endings.nextPart();
    town.epicSys.nextPart(plan.title);
    town.log('ending', `📖 第${town.endState.part}部「${plan.title}」开始了`, { part: town.endState.part });
    try { town.stage({ template: 'moment', target: 'at', text: `第${town.endState.part}部「${plan.title}」`, priority: 'major' }, { at: { x: town.world.gate.x, y: town.world.gate.y, inside: null, region: 'town' } }, { source: 'sequel' }); } catch { /* 舞台演出失败不影响 */ }
    return { part: town.endState.part, title: plan.title, failed };
  }
}
