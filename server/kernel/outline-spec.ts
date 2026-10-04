// 世界大纲、结局与史诗配置的结构校验（docs/design/epic-outline.md §3、§4）。
// 没有运行时依赖：世界包校验（validateSpec）、创世、大纲编辑、AI 输出整理都用这里的函数。
import crypto from 'node:crypto';
import { checkExpr } from './effects.ts';
import type { EndingDef, EpicConfig, Outline, OutlineAct, OutlineBeat, OutlinePart } from '../types/story.ts';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 世界包 / 模型 / 用户提交的原始数据，逐项校验

export const OUTLINE_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const LIMITS = { premise: 120, theme: 40, parts: 6, acts: 8, beats: 10, actTitle: 20, plan: 300, recap: 300, beat: 80, endings: 4, endingTitle: 16, hint: 80, finaleText: 80 };
const PART_STATUS = ['done', 'active', 'planned', 'dropped'];
const BEAT_STATUS = ['planned', 'done', 'transformed', 'skipped'];
const KINDS = ['good', 'bad', 'neutral'];

const str = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isStr = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function emptyOutline(): Outline {
  return { version: 0, premise: '', theme: '', autoAdjust: true, parts: [], endings: [] };
}

/** 一个节点 / 幕 / 部是否已经成为历史（不能再改） */
export const settledBeat = (b: Pick<OutlineBeat, 'status'>): boolean => b.status !== 'planned';
export const settledAct = (a: Pick<OutlineAct, 'status'>): boolean => a.status === 'done' || a.status === 'dropped';

/**
 * 把模型或用户给的大纲整理成规范的形状：截断过长的文字、补上缺失的 id 与状态、去掉多余字段。
 * 不判断合法性（那是 outlineErrors 的事），只保证结构可用。
 */
export function normalizeOutline(raw: unknown): Outline {
  const r: Raw = raw && typeof raw === 'object' ? raw as Raw : {};
  const used = new Set<string>();
  const uid = (want: unknown, fallback: string): string => {
    let id = typeof want === 'string' && OUTLINE_ID_RE.test(want) ? want : fallback;
    for (let i = 2; used.has(id); i++) id = `${fallback}_${i}`;
    used.add(id);
    return id;
  };
  const parts: OutlinePart[] = (Array.isArray(r.parts) ? r.parts : []).slice(0, LIMITS.parts).map((p: Raw, pi: number) => ({
    id: uid(p?.id, `p${pi + 1}`),
    title: str(p?.title, LIMITS.actTitle) || `第${pi + 1}部`,
    status: PART_STATUS.includes(p?.status) ? p.status : 'planned',
    acts: (Array.isArray(p?.acts) ? p.acts : []).slice(0, LIMITS.acts).map((a: Raw, ai: number) => {
      const act: OutlineAct = {
        id: uid(a?.id, `p${pi + 1}a${ai + 1}`),
        title: str(a?.title, LIMITS.actTitle) || `第${ai + 1}幕`,
        plan: str(a?.plan, LIMITS.plan),
        status: PART_STATUS.includes(a?.status) ? a.status : 'planned',
        beats: (Array.isArray(a?.beats) ? a.beats : []).slice(0, LIMITS.beats).map((b: Raw, bi: number) => {
          const beat: OutlineBeat = {
            id: uid(b?.id, `p${pi + 1}a${ai + 1}b${bi + 1}`),
            text: str(b?.text, LIMITS.beat),
            status: BEAT_STATUS.includes(b?.status) ? b.status : 'planned',
            chapters: (Array.isArray(b?.chapters) ? b.chapters : []).map((c: unknown) => str(c, 12)).filter(Boolean).slice(0, 20),
          };
          if (isStr(b?.done, 300)) beat.done = b.done.trim();
          if (b?.links && typeof b.links === 'object') {
            const l: Raw = {};
            for (const k of ['thread', 'threat', 'arc', 'persona']) if (typeof b.links[k] === 'string' && OUTLINE_ID_RE.test(b.links[k])) l[k] = b.links[k];
            if (Object.keys(l).length) beat.links = l;
          }
          if (b?.locked) beat.locked = true;
          if (Array.isArray(b?.tags)) beat.tags = b.tags.map((t: unknown) => str(t, 8)).filter(Boolean).slice(0, 3);
          if (Number.isFinite(b?.doneT)) beat.doneT = b.doneT;
          if (isStr(b?.note, 60)) beat.note = str(b.note, 60);
          return beat;
        }),
      };
      if (isStr(a?.recap, LIMITS.recap + 50)) act.recap = str(a.recap, LIMITS.recap);
      if (typeof a?.endingRef === 'string' && OUTLINE_ID_RE.test(a.endingRef)) act.endingRef = a.endingRef;
      if (a?.locked) act.locked = true;
      return act;
    }),
  }));
  return {
    version: Number.isInteger(r.version) && r.version >= 0 ? r.version : 0,
    premise: str(r.premise, LIMITS.premise),
    theme: str(r.theme, LIMITS.theme),
    autoAdjust: r.autoAdjust !== false,
    parts,
    endings: normalizeEndings(r.endings),
  };
}

export function normalizeEndings(raw: unknown): EndingDef[] {
  const used = new Set<string>();
  return (Array.isArray(raw) ? raw : []).slice(0, LIMITS.endings).map((e: Raw, i: number) => {
    let id = typeof e?.id === 'string' && OUTLINE_ID_RE.test(e.id) ? e.id : `ending_${i + 1}`;
    while (used.has(id)) id = `${id}_x`;
    used.add(id);
    const d: EndingDef = { id, title: str(e?.title, LIMITS.endingTitle), kind: KINDS.includes(e?.kind) ? e.kind : 'neutral', when: String(e?.when ?? '').trim().slice(0, 300) };
    if (Number.isInteger(e?.for) && e.for > 0) d.for = Math.min(14, e.for);
    if (isStr(e?.hint, 200)) d.hint = str(e.hint, LIMITS.hint);
    if (e?.finale && typeof e.finale === 'object') {
      const f: NonNullable<EndingDef['finale']> = {};
      if (Number.isFinite(e.finale.hours)) f.hours = Math.max(0, Math.min(48, Math.round(e.finale.hours)));
      if (isStr(e.finale.text, 200)) f.text = str(e.finale.text, LIMITS.finaleText);
      d.finale = f;
    }
    return d;
  });
}

/** 结局的错误列表 */
export function endingErrors(list: unknown): string[] {
  const errs: string[] = [];
  if (list == null) return errs;
  if (!Array.isArray(list)) return ['endings 应为数组'];
  if (list.length > LIMITS.endings) errs.push(`结局最多 ${LIMITS.endings} 个`);
  const ids = new Set<string>();
  for (const [i, e] of list.entries()) {
    const p = `endings[${i}]`;
    if (!e || typeof e !== 'object') { errs.push(`${p}: 不是对象`); continue; }
    if (!OUTLINE_ID_RE.test(e.id || '')) errs.push(`${p}: id 不合法`);
    if (ids.has(e.id)) errs.push(`${p}: id 重复`);
    ids.add(e.id);
    if (!isStr(e.title, LIMITS.endingTitle)) errs.push(`${p}: title 缺失或过长（≤${LIMITS.endingTitle}字）`);
    if (!KINDS.includes(e.kind)) errs.push(`${p}: kind 只能是 ${KINDS.join('/')}`);
    if (!isStr(e.when, 300)) errs.push(`${p}: when 需要条件表达式`);
    else { const x = checkExpr(e.when); if (x) errs.push(`${p}.when: ${x}`); }
    if (e.for != null && !(Number.isInteger(e.for) && e.for >= 0 && e.for <= 14)) errs.push(`${p}: for 应为 0~14 的整数（天）`);
    if (e.hint != null && !isStr(e.hint, LIMITS.hint)) errs.push(`${p}: hint 过长（≤${LIMITS.hint}字）`);
    if (e.finale != null) {
      if (e.finale.hours != null && !(Number.isFinite(e.finale.hours) && e.finale.hours >= 0 && e.finale.hours <= 48)) errs.push(`${p}: finale.hours 应在 0~48`);
      if (e.finale.text != null && !isStr(e.finale.text, LIMITS.finaleText)) errs.push(`${p}: finale.text 过长（≤${LIMITS.finaleText}字）`);
    }
  }
  return errs;
}

/** 大纲的结构错误（含结局）；known：可以引用的 id（威胁、伏笔、剧情弧、居民），不传时不检查引用 */
export function outlineErrors(o: unknown, known: { threats?: string[]; threads?: string[]; arcs?: string[]; personas?: string[] } | null = null): string[] {
  const errs: string[] = [];
  const x: Raw = o as Raw;
  if (!x || typeof x !== 'object') return ['大纲不是对象'];
  if (x.premise != null && typeof x.premise === 'string' && x.premise.length > LIMITS.premise) errs.push(`premise 过长（≤${LIMITS.premise}字）`);
  if (x.theme != null && typeof x.theme === 'string' && x.theme.length > LIMITS.theme) errs.push(`theme 过长（≤${LIMITS.theme}字）`);
  if (!Array.isArray(x.parts)) return [...errs, 'parts 应为数组'];
  if (x.parts.length > LIMITS.parts) errs.push(`最多 ${LIMITS.parts} 部`);
  const ids = new Set<string>();
  const seen = (id: unknown, p: string) => {
    if (typeof id !== 'string' || !OUTLINE_ID_RE.test(id)) errs.push(`${p}: id 不合法`);
    else if (ids.has(id)) errs.push(`${p}: id 重复（${id}）`);
    else ids.add(id);
  };
  let activeActs = 0;
  const endingIds = new Set((Array.isArray(x.endings) ? x.endings : []).map((e: Raw) => e?.id));
  for (const [pi, part] of x.parts.entries()) {
    const pp = `parts[${pi}]`;
    seen(part?.id, pp);
    if (!isStr(part?.title, LIMITS.actTitle)) errs.push(`${pp}: title 缺失或过长`);
    if (!PART_STATUS.includes(part?.status)) errs.push(`${pp}: status 不合法`);
    if (!Array.isArray(part?.acts)) { errs.push(`${pp}: acts 应为数组`); continue; }
    if (part.acts.length > LIMITS.acts) errs.push(`${pp}: 最多 ${LIMITS.acts} 幕`);
    for (const [ai, act] of part.acts.entries()) {
      const ap = `${pp}.acts[${ai}]`;
      seen(act?.id, ap);
      if (!isStr(act?.title, LIMITS.actTitle)) errs.push(`${ap}: title 缺失或过长（≤${LIMITS.actTitle}字）`);
      if (typeof act?.plan !== 'string' || act.plan.length > LIMITS.plan) errs.push(`${ap}: plan 过长（≤${LIMITS.plan}字）`);
      if (act?.recap != null && (typeof act.recap !== 'string' || act.recap.length > LIMITS.recap)) errs.push(`${ap}: recap 过长`);
      if (!PART_STATUS.includes(act?.status)) errs.push(`${ap}: status 不合法`);
      if (act?.status === 'active') activeActs++;
      if (act?.endingRef != null && !endingIds.has(act.endingRef)) errs.push(`${ap}: endingRef 指向不存在的结局：${act.endingRef}`);
      if (!Array.isArray(act?.beats)) { errs.push(`${ap}: beats 应为数组`); continue; }
      if (act.beats.length > LIMITS.beats) errs.push(`${ap}: 每幕最多 ${LIMITS.beats} 个节点`);
      for (const [bi, b] of act.beats.entries()) {
        const bp = `${ap}.beats[${bi}]`;
        seen(b?.id, bp);
        if (!isStr(b?.text, LIMITS.beat)) errs.push(`${bp}: text 缺失或过长（≤${LIMITS.beat}字）`);
        if (!BEAT_STATUS.includes(b?.status)) errs.push(`${bp}: status 不合法`);
        if (b?.done != null) { const e = isStr(b.done, 300) ? checkExpr(b.done) : 'done 应为条件表达式'; if (e) errs.push(`${bp}.done: ${e}`); }
        if (!Array.isArray(b?.chapters)) errs.push(`${bp}: chapters 应为数组`);
        if (known && b?.links) {
          const L: Array<[string, string[] | undefined]> = [['threat', known.threats], ['thread', known.threads], ['arc', known.arcs], ['persona', known.personas]];
          for (const [k, list] of L) if (b.links[k] != null && list && !list.includes(b.links[k])) errs.push(`${bp}.links.${k}: 不存在：${b.links[k]}`);
        }
      }
    }
  }
  if (activeActs > 1) errs.push('同时只能有一幕在进行中');
  errs.push(...endingErrors(x.endings));
  return errs;
}

/**
 * 已经成为历史的内容不能改（§3.5）：上一版里已完成 / 已放弃的幕、已有结果的节点、已完成的部，
 * 在新版里必须原样存在。locked：AI（大纲维护）也不能改锁定的内容；人可以。
 */
export function historyErrors(prev: Outline, next: Outline, { respectLocks = false }: { respectLocks?: boolean } = {}): string[] {
  const errs: string[] = [];
  const nextActs = new Map(next.parts.flatMap((p) => p.acts.map((a) => [a.id, a] as const)));
  const nextBeats = new Map(next.parts.flatMap((p) => p.acts.flatMap((a) => a.beats.map((b) => [b.id, b] as const))));
  const nextParts = new Map(next.parts.map((p) => [p.id, p] as const));
  for (const p of prev.parts) {
    if (p.status === 'done' && nextParts.get(p.id)?.status !== 'done') errs.push(`已完成的「${p.title}」不能修改状态`);
    for (const a of p.acts) {
      const na = nextActs.get(a.id);
      if (settledAct(a)) {
        if (!na) errs.push(`已经过去的幕「${a.title}」不能删除`);
        else if (na.title !== a.title || na.status !== a.status || (na.recap || '') !== (a.recap || '') || na.plan !== a.plan) errs.push(`已经过去的幕「${a.title}」不能修改`);
      } else if (respectLocks && a.locked) {
        // 锁定的是内容（标题、计划、指向的结局）；随故事推进从「计划中」变成「进行中」、写下经过不算修改
        if (!na || na.title !== a.title || na.plan !== a.plan || (na.endingRef || '') !== (a.endingRef || '')) errs.push(`锁定的幕「${a.title}」不能修改`);
      }
      for (const b of a.beats) {
        const nb = nextBeats.get(b.id);
        if (settledBeat(b)) {
          if (!nb) errs.push(`已经发生的节点「${b.text}」不能删除`);
          else if (nb.text !== b.text || nb.status !== b.status) errs.push(`已经发生的节点「${b.text}」不能修改`);
          else if (b.chapters.some((c) => !nb.chapters.includes(c))) errs.push(`节点「${b.text}」的章节链接不能删除`);
        } else if (respectLocks && b.locked && (!nb || nb.text !== b.text)) errs.push(`锁定的节点「${b.text}」不能修改`);
      }
    }
  }
  if (respectLocks && JSON.stringify(prev.endings) !== JSON.stringify(next.endings)) errs.push('结局条件只能由人修改');
  return errs;
}

export function epicConfigErrors(e: unknown): string[] {
  if (e == null) return [];
  const x: Raw = e as Raw;
  const errs: string[] = [];
  if (typeof x !== 'object') return ['epic 应为对象'];
  if (x.title != null && !isStr(x.title, 20)) errs.push('epic.title 过长（≤20字）');
  if (x.narrator != null && !isStr(x.narrator, 80)) errs.push('epic.narrator 过长（≤80字）');
  const c = x.chapter;
  if (c != null) {
    const n = (v: unknown, lo: number, hi: number) => v == null || (Number.isFinite(v) && (v as number) >= lo && (v as number) <= hi);
    if (!n(c.everyDays, 1, 60) || !n(c.minDays, 0, 30) || !n(c.weight, 1, 200)) errs.push('epic.chapter 的 everyDays（1~60）/ minDays（0~30）/ weight（1~200）不合法');
    if (c.words != null && !(Array.isArray(c.words) && c.words.length === 2 && n(c.words[0], 300, 6000) && n(c.words[1], c.words[0], 8000))) errs.push('epic.chapter.words 应为 [最少, 最多]（300~8000 字）');
  }
  if (x.volumeEveryChapters != null && !(Number.isInteger(x.volumeEveryChapters) && x.volumeEveryChapters >= 2 && x.volumeEveryChapters <= 100)) errs.push('epic.volumeEveryChapters 应为 2~100 的整数');
  return errs;
}

/** 规格里的大纲、结局、史诗配置的错误（validateSpec 调用） */
export function specStoryErrors(s: Raw): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of epicConfigErrors(s.epic)) out.push(['epic', e]);
  for (const e of endingErrors(s.endings)) out.push(['endings', e]);
  if (s.outline != null) for (const e of outlineErrors(normalizeOutline({ ...s.outline, endings: s.outline.endings ?? s.endings ?? [] }))) out.push(['outline', e]);
  return out;
}

/** 大纲里所有给人看的文字（关键词审核用） */
export function outlineTexts(o: Outline): string[] {
  return [o.premise, o.theme, ...o.parts.flatMap((p) => [p.title, ...p.acts.flatMap((a) => [a.title, a.plan, a.recap || '', ...a.beats.map((b) => b.text)])]), ...o.endings.flatMap((e) => [e.title, e.hint || '', e.finale?.text || ''])].filter(Boolean);
}

/** 大纲的内容哈希（评审登记用：保存时只接受评审过的同一份草稿） */
export function hashOutline(o: Outline): string {
  const { version, ...rest } = o; // eslint-disable-line @typescript-eslint/no-unused-vars
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

/** 遍历所有节点 */
export function* allBeats(o: Outline): Generator<{ part: OutlinePart; act: OutlineAct; beat: OutlineBeat }> {
  for (const part of o.parts) for (const act of part.acts) for (const beat of act.beats) yield { part, act, beat };
}

/** 当前（进行中的）部与幕 */
export function currentAct(o: Outline): { part: OutlinePart | null; act: OutlineAct | null } {
  const part = o.parts.find((p) => p.status === 'active') || o.parts.find((p) => p.status === 'planned') || null;
  const act = part?.acts.find((a) => a.status === 'active') || part?.acts.find((a) => a.status === 'planned') || null;
  return { part, act };
}
