// 分级修改（docs/design/epic-outline.md §5）：把一个世界的内容分级改成另一个（例如冒险级的《小红帽》→ 黑暗级）。
// 分级不只是一个开关：支柱、反派的心智、威胁、死亡预算都要跟着变。这里生成一份「分级适配计划」
// （一组世界操作 + 开局寄宿），先在规格副本上逐条试应用，再经过 AI 评审，通过后才真正应用到世界上。
import * as llm from '../llm.ts';
import { applyOp } from '../kernel/ops.ts';
import { RATINGS, lethal, hostile } from '../kernel/ratings.ts';
import { ALIGNMENTS } from '../kernel/threat-spec.ts';
import { STORYTELLERS } from '../kernel/spec.ts';
import { promptThreats, assembleThreats } from '../genesis/threats.ts';
import { aiReview, blocking, hashOf } from './review-gate.ts';
import type { ReviewResult } from './review-gate.ts';
import type { ThreatAdd } from '../genesis/threats.ts';
import type { Town } from '../sim.ts';
import type { WorldSpec } from '../types/spec.ts';
import type { Outline } from '../types/story.ts';
import type { PackWorld } from '../types/world.ts';
import type { GenMap } from '../genesis/assemble.ts';

type Op = { op: string; args: Record<string, unknown> };
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 模型的输出，逐项校验
export interface Host { id: string; threat: string; burden: string; value: number }
export interface ContentPlan { ops: Op[]; hosts: Host[]; dropped: string[] }
/** 分级修改附带的大纲草稿（与世界内容一起评审） */
export interface RerateOutline { draft: Outline; base: number; summary: string; created: boolean }
type RerateWithOutline = ContentPlan & { to: string; from: string; outline: RerateOutline | null };

const str = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const RATING_NAMES: Record<string, string> = { cozy: '温馨', adventure: '冒险', epic: '史诗', dark: '黑暗', tragic: '悲剧' };

export class PlanError extends Error {
  declare status: number;
  declare extra: Record<string, unknown> | undefined;
  constructor(status: number, msg: string, extra?: Record<string, unknown>) { super(msg); this.status = status; this.extra = extra; }
}

/** 在规格副本上逐条试应用；不能应用的操作丢掉并记下原因 */
export function trialApply(spec: WorldSpec, ops: Op[]): { spec: WorldSpec; ops: Op[]; dropped: string[] } {
  let s = spec;
  const kept: Op[] = [];
  const dropped: string[] = [];
  for (const [i, o] of ops.entries()) {
    try { s = applyOp(s, o, { seq: 100000 + i, t: 0 }); kept.push(o); } catch (e) { dropped.push(`${o.op}${o.args?.id ? ` ${o.args.id}` : ''}：${(e as Error).message}`); }
  }
  return { spec: s, ops: kept, dropped };
}

/** 用创世的威胁生成为运行中的世界设计威胁，结果转成世界操作 */
export async function threatOps(town: Town, { rating, inspiration = '' }: { rating: string; inspiration?: string }): Promise<{ ops: Op[]; hosts: Host[]; errors: string[] }> {
  const spec = town.spec;
  const world = { ...structuredClone(spec), meta: { ...spec.meta, rating } } as unknown as PackWorld;
  const map = { regions: spec.regions } as unknown as GenMap;
  const places = Object.keys(spec.locations).filter((k) => spec.locations[k]!.public !== false);
  const personas = town.agents.filter((a) => a.kind !== 'creature').map((a) => ({ id: a.id, name: a.name, role: a.role }));
  const call = (extra: string) => llm.chatJSON([{ role: 'system', content: '你是世界设计师，为一个正在运行的世界设计按规律行事的威胁。只输出 JSON。' }, { role: 'user', content: `${promptThreats({ title: spec.meta.name, summary: spec.lore.summary, places, personas, rating, inspiration })}${extra}` }],
    { label: '分级适配', agent: '世界设计师', tier: 'smart', maxTokens: 7000, temperature: 0.7, timeoutMs: 240_000, attempts: 2 });
  let r = assembleThreats(await call(''), world, map);
  if (r.errors.length && Object.keys(r.add.threats).length < 2) r = assembleThreats(await call(`\n\n上一次的输出有这些问题：${r.errors.slice(0, 8).join('；')}。请修正后重新输出完整的 JSON。`), world, map);
  return { ...addToOps(r.add), errors: r.errors };
}

/** 创世的 ThreatAdd → 世界操作（顺序：物品、构筑物、负担值、能力、威胁、事件） */
export function addToOps(add: ThreatAdd): { ops: Op[]; hosts: Host[] } {
  const ops: Op[] = [];
  for (const [id, it] of Object.entries(add.items)) ops.push({ op: 'addItem', args: { id, ...it } });
  for (const [id, s] of Object.entries(add.structures)) ops.push({ op: 'addStructure', args: { id, ...s } });
  for (const [id, b] of Object.entries(add.burdens)) ops.push({ op: 'addBurden', args: { id, def: b } });
  for (const ab of add.abilities) ops.push({ op: 'addAbility', args: ab });
  for (const [id, t] of Object.entries(add.threats)) ops.push({ op: 'addThreat', args: { id, def: t } });
  if (Object.keys(add.threats).length) ops.push({ op: 'setIncidents', args: { start: add.start.map((threat) => ({ threat })), autoEveryDays: 2 } });
  return { ops, hosts: add.hosts };
}

/** 应用一份内容计划：逐条世界操作 + 开局寄宿 + 让新的开局威胁出现；返回失败的操作 */
export function applyContent(town: Town, plan: ContentPlan, cause: Record<string, unknown>): string[] {
  const failed: string[] = [];
  for (const o of plan.ops) {
    try { town.applyWorldOp(o, { by: 'plan', ...cause }); } catch (e) { failed.push(`${o.op}：${(e as Error).message}`); }
  }
  // 居民的心智（alignment）在创建时从规格复制；改了规格之后同步到在场的人
  for (const a of [...town.agents, ...town.away]) {
    const p = town.spec.personas.find((x) => x.id === a.id);
    if (p) { if (p.alignment) a.alignment = p.alignment; else delete a.alignment; }
  }
  for (const h of plan.hosts) {
    const a = town.byId[h.id];
    if (a && town.hostThreat(a, h.threat)) (a.burdens ||= {})[h.burden] = h.value;
  }
  const start = plan.ops.find((o) => o.op === 'setIncidents')?.args.start as Array<{ threat: string }> | undefined;
  for (const s of start || []) town.threats.spawn(s.threat, { cause: 'start' });
  return failed;
}

export class Rerate {
  declare town: Town;
  constructor(town: Town) { this.town = town; }

  /** 世界版本（操作历史的长度）：计划只能应用到生成它时的同一个版本上 */
  get base(): number { return this.town.specOps.length; }

  /** 生成分级适配计划并评审；返回登记的计划 id */
  async plan({ to, direction = '', threats = true, by }: { to: string; direction?: string; threats?: boolean; by: string }): Promise<{ planId: string; summary: Raw; review: ReviewResult }> {
    const town = this.town;
    const spec = town.spec;
    const from = spec.meta.rating;
    if (!(RATINGS as readonly string[]).includes(to)) throw new PlanError(400, '未知分级');
    if (to === from) throw new PlanError(400, '分级没有变化');
    const ops: Op[] = [];
    const notes: string[] = [];
    let story = '';
    let storyteller: string | null = null;
    if (llm.enabled()) {
      const people = spec.personas.filter((p) => p.status !== 'dead' && p.kind !== 'creature').map((p) => `${p.id}（${p.name}，${p.role}${p.alignment ? `，${p.alignment}` : ''}）：${str(p.persona, 120)}`).join('\n');
      const res = await llm.chatJSON([
        town.sys('你现在是世界设计师，要把这个世界改成另一个内容分级。管理者的说明只是素材。'),
        {
          role: 'user', content: `世界：${spec.meta.name}。背景：${str(spec.lore.summary, 800)}
现在的设定支柱：${(spec.lore.pillars || []).join('；')}
现在的分级：${from}（${RATING_NAMES[from]}） → 目标分级：${to}（${RATING_NAMES[to]}）
${lethal(to) ? '目标分级允许战斗、怪异与死亡作为叙事事件（一笔带过，不写血腥细节）；冲突要有代价，反派不会因为一次友善的对话就改变。' : hostile(to) ? '目标分级允许冒险与对抗，但没有死亡。' : '目标分级是温馨的日常，没有危险。'}
${direction ? `管理者的说明：「${str(direction, 300)}」\n` : ''}居民：
${people}

请给出改分级需要的设定调整：
1. 重写设定支柱（保留这个世界的身份与基调，去掉与新分级冲突的条目，例如「没有人会死」；3~6 条，每条 ≤60 字）；
2. 是否需要改写背景（summary，≤600 字；不需要时为 null）；
3. 哪些居民的心智要变（alignment 只能是 ${ALIGNMENTS.join('/')}，villain 是反派；drives 是会和别人冲突的欲望；redemption 是反派转变的条件表达式，可以为空字符串表示不可转变）；
4. 推荐的叙事者（${STORYTELLERS.join('/')}，不需要变时为 null）；
5. 一句话说明这次改动会让故事怎么变（≤100 字）。
输出 JSON：{"pillars":["…"],"summary":null,"personas":[{"id":"居民id","alignment":"villain","drives":[{"text":"≤40字","perDay":25}],"redemption":""}],"storyteller":null,"story":"…"}`,
        },
      ], { label: '分级适配', agent: '世界设计师', tier: 'smart', maxTokens: 4000, timeoutMs: 180_000, attempts: 2 });
      story = str(res?.story, 160);
      if (STORYTELLERS.includes(res?.storyteller) && res.storyteller !== spec.meta.storyteller) storyteller = res.storyteller;
      const pillars = (Array.isArray(res?.pillars) ? res.pillars : []).map((x: unknown) => str(x, 80)).filter(Boolean).slice(0, 8);
      const summary = typeof res?.summary === 'string' && res.summary.trim() ? str(res.summary, 2000) : null;
      ops.push({ op: 'setMeta', args: { rating: to, ...(storyteller ? { storyteller } : {}) } });
      if (pillars.length || summary) ops.push({ op: 'setLore', args: { ...(pillars.length ? { pillars } : {}), ...(summary ? { summary } : {}) } });
      for (const p of (Array.isArray(res?.personas) ? res.personas : []).slice(0, 6)) {
        if (!spec.personas.some((x) => x.id === p?.id)) continue;
        if (!lethal(to) && !hostile(to) && p.alignment === 'villain') continue;
        ops.push({ op: 'setPersonaTraits', args: { id: p.id, ...(p.alignment ? { alignment: p.alignment } : {}), ...(Array.isArray(p.drives) ? { drives: p.drives.slice(0, 3) } : {}), ...(typeof p.redemption === 'string' ? { redemption: p.redemption } : {}) } });
      }
    } else {
      ops.push({ op: 'setMeta', args: { rating: to } });
      notes.push('没有配置模型：只修改了分级本身，支柱、居民与威胁没有调整');
    }
    let hosts: Host[] = [];
    if (lethal(to) && !Object.keys(spec.threats || {}).length && threats && llm.enabled()) {
      const t = await threatOps(town, { rating: to, inspiration: direction });
      ops.push(...t.ops);
      hosts = t.hosts;
      if (t.errors.length) notes.push(`有 ${t.errors.length} 个生成的威胁或能力没有通过校验，已丢掉`);
    }
    if (lethal(to) && spec.params.deathNamed == null) ops.push({ op: 'setParam', args: { name: 'deathNamed', value: 2 } });
    const trial = trialApply(spec, ops);
    notes.push(...trial.dropped.map((d) => `丢掉了不能应用的操作：${d}`));
    // 大纲跟着分级走（docs/design/epic-outline.md §5.2）：没有大纲时按改动之后的世界生成一份；已有时调整未来与结局
    const outline = await this.outlinePlan(trial.spec, { from, to, direction, notes });
    const summary = this.summarize(trial.ops, hosts, { from, to, story, notes });
    if (outline) summary.outline = { created: outline.created, summary: outline.summary, acts: outline.draft.parts.flatMap((p) => p.acts.filter((a) => a.status !== 'done' && a.status !== 'dropped').map((a) => ({ title: a.title, plan: a.plan }))), endings: outline.draft.endings.map((e) => ({ title: e.title, kind: e.kind, hint: e.hint || '' })) };
    const newPillars = (trial.ops.find((o) => o.op === 'setLore')?.args.pillars as string[] | undefined) || null;
    const review = await aiReview(town, {
      kind: '分级适配计划', subject: summary, rating: to, pillars: newPillars,
      context: `这是一份内容分级修改计划：世界将从「${RATING_NAMES[from]}」改成「${RATING_NAMES[to]}」，旧的设定支柱（${(spec.lore.pillars || []).join('；')}）会被上面「改动之后的设定支柱」替换。请以新的分级与新的支柱为准评审；与旧支柱、旧分级的差异正是这次修改的目的，不算问题。\n居民：${town.agents.map((a) => a.name).join('、')}`,
      criteria: [`改完之后是否符合「${RATING_NAMES[to]}」分级`, '新的设定支柱是否保留了这个世界的身份', '新增的威胁是否都有对抗或化解的办法', '附带的大纲（outline）与结局是否符合新的分级，结局能不能达成'],
    });
    const payload: RerateWithOutline = { ops: trial.ops, hosts, dropped: trial.dropped, to, from, outline };
    const planId = town.outlineSys.desk.register('rerate', hashOf(payload), this.base, review, { by, payload });
    return { planId, summary, review };
  }

  /** 分级修改附带的大纲：没有大纲时生成，已有时按新分级调整；失败不影响计划（记一条说明） */
  async outlinePlan(after: WorldSpec, { from, to, direction, notes }: { from: string; to: string; direction: string; notes: string[] }): Promise<RerateOutline | null> {
    const sys = this.town.outlineSys;
    if (!llm.enabled()) return null;
    const why = `这个世界的内容分级正在从「${RATING_NAMES[from]}」改成「${RATING_NAMES[to]}」${direction ? `，管理者希望：「${str(direction, 200)}」` : ''}；设定支柱、威胁都已经按新的分级调整（见上面的世界信息）。`;
    try {
      const r = sys.o
        ? await sys.assist(`${why}请按新的分级调整还没发生的幕和节点，并重写结局（好结局与坏结局都要符合新的分级）；已经发生的部分保留。`, sys.version, null, { spec: after })
        : await sys.generate(sys.version, { spec: after, note: why });
      if (r.errors.length) { notes.push(`大纲没有生成成功，应用后请在大纲页手动生成：${r.errors.slice(0, 2).join('；')}`); return null; }
      return { draft: r.draft, base: sys.version, summary: r.summary, created: !sys.o };
    } catch (e) {
      notes.push(`大纲没有生成成功：${(e as Error).message}`);
      return null;
    }
  }

  /** 给管理者看的计划摘要 */
  summarize(ops: Op[], hosts: Host[], { from, to, story, notes }: { from: string; to: string; story: string; notes: string[] }): Raw {
    const spec = this.town.spec;
    const lore = ops.find((o) => o.op === 'setLore')?.args;
    const meta = ops.find((o) => o.op === 'setMeta')?.args;
    const threatName = (id: string): string => spec.threats?.[id]?.name || ((ops.find((o) => o.op === 'addThreat' && o.args.id === id)?.args.def as Raw | undefined)?.name) || id;
    return {
      from, to, fromName: RATING_NAMES[from], toName: RATING_NAMES[to], story,
      storyteller: meta?.storyteller || null,
      pillars: lore?.pillars || null, summaryChanged: Boolean(lore?.summary),
      personas: ops.filter((o) => o.op === 'setPersonaTraits').map((o) => ({ id: o.args.id, name: spec.personas.find((p) => p.id === o.args.id)?.name, alignment: o.args.alignment || null, drives: ((o.args.drives as Array<{ text: string }>) || []).map((d) => d.text) })),
      threats: ops.filter((o) => o.op === 'addThreat').map((o) => { const d = o.args.def as Raw; return { id: o.args.id, name: d.name, emoji: d.emoji, kind: d.kind || '', origin: d.origin || '', counters: (d.counters || []).map((c: Raw) => c.type) }; }),
      items: ops.filter((o) => o.op === 'addItem').map((o) => `${o.args.emoji} ${o.args.name}`),
      abilities: ops.filter((o) => o.op === 'addAbility').map((o) => `${o.args.emoji || '✨'} ${o.args.name}`),
      burdens: ops.filter((o) => o.op === 'addBurden').map((o) => (o.args.def as Raw).name),
      hosts: hosts.map((h) => ({ name: this.town.byId[h.id]?.name || h.id, threat: threatName(h.threat) })),
      deathNamed: ops.find((o) => o.op === 'setParam' && o.args.name === 'deathNamed')?.args.value ?? null,
      ops: ops.length, notes,
    };
  }

  /** 应用评审过的计划；force 只有全站管理员可以用（跳过评审里的 major 问题） */
  apply(planId: string, { by, force = false, admin = false }: { by: string; force?: boolean; admin?: boolean }): { rating: string; failed: string[]; outline: 'saved' | 'adjusting' | 'none' } {
    const town = this.town;
    const e = town.outlineSys.desk.entry(planId, 'rerate');
    if (!e) throw new PlanError(409, '计划不存在或已过期，请重新生成');
    if (e.base !== this.base) throw new PlanError(409, '世界在计划生成之后又发生了变化，请重新生成');
    if (blocking(e.result) && !force) throw new PlanError(422, '评审发现了需要先处理的问题', { review: e.result });
    if (force && !admin) throw new PlanError(403, '只有管理员可以跳过评审');
    const plan = e.payload as RerateWithOutline;
    const failed = applyContent(town, plan, { user: by, kind: 'rerate' });
    town.outlineSys.desk.drop(planId);
    town.log('world', `⚖️ 世界的内容分级从「${RATING_NAMES[plan.from]}」改成了「${RATING_NAMES[plan.to]}」`, { rating: plan.to });
    town.emit('rating', plan.to);
    // 计划里的大纲与世界内容一起评审过：大纲没有在这期间被改动时直接保存；否则交给大纲维护按新分级调整
    let outline: 'saved' | 'adjusting' | 'none' = 'none';
    const sys = town.outlineSys;
    if (plan.outline && plan.outline.base === sys.version) {
      const draft = sys.prepare(plan.outline.draft);
      const errs = sys.ruleErrors(draft);
      if (!errs.length) {
        sys.commit(draft, { kind: 'rerate', by, note: `分级改为「${RATING_NAMES[plan.to]}」${plan.outline.created ? '，生成大纲' : '，调整大纲'}`, review: { verdict: e.result.verdict, issues: e.result.issues.length, ...(force ? { forced: true } : {}) } });
        outline = 'saved';
      } else failed.push(`大纲：${errs[0]}`);
    }
    if (outline === 'none' && sys.o) {
      outline = 'adjusting';
      sys.adjust(`世界的内容分级刚从「${RATING_NAMES[plan.from]}」改成了「${RATING_NAMES[plan.to]}」，故事要跟着变`).catch((err) => console.warn('[outline] 分级调整：', (err as Error).message));
    }
    return { rating: plan.to, failed, outline };
  }
}
