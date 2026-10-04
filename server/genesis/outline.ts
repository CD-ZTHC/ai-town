// 创世：大纲与结局（docs/design/epic-outline.md §3.2）。为新世界写第一部的大纲与终局分支，
// 结局条件编译成内核表达式并校验；不合法时带着错误让模型改一次，还不合法就不带大纲（不影响创世）。
import { EXPR_FN_DOCS } from '../kernel/effects.ts';
import { lethal } from '../kernel/ratings.ts';
import { normalizeOutline, outlineErrors, LIMITS } from '../kernel/outline-spec.ts';
import type { ModelJSON } from '../llm.ts';
import type { WorldSpec } from '../types/spec.ts';
import type { Outline } from '../types/story.ts';

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const FNS = ['unresolvedThreats', 'liveThreats', 'containedThreats', 'crowdDead', 'namedDeaths', 'aliveIn', 'flag'];

export function promptOutline(spec: WorldSpec): string {
  const threats = Object.entries(spec.threats || {});
  const resolvable = threats.filter(([, t]) => (t.counters || []).some((c) => c.type === 'resolve')).map(([id]) => id);
  return `世界：${spec.meta.name}。背景：${str(spec.lore.summary, 600)}
设定支柱：${(spec.lore.pillars || []).join('；')}
内容分级：${spec.meta.rating}${lethal(spec.meta.rating) ? '（允许死亡作为叙事事件）' : '（没有死亡）'}
居民：${spec.personas.map((p) => `${p.id}（${p.name}，${p.role}）：${str(p.goal, 40)}`).join('；')}
${spec.threads?.length ? `伏笔：${spec.threads.map((t) => `${t.id}（${t.title}）：${t.hook}`).join('；')}\n` : ''}${threats.length ? `威胁：${threats.map(([id, t]) => `${id}（${t.name}）`).join('、')}${resolvable.length ? `；其中可以被化解的：${resolvable.join('、')}` : ''}\n` : ''}${spec.factions?.length ? `阵营：${spec.factions.map((f) => `${f.id}（${f.name}）`).join('、')}\n` : ''}${spec.adaptation?.fateNodes?.length ? `原著的命运节点（写成带 "tags":["原著"] 的节点）：${spec.adaptation.fateNodes.map((f) => f.text).join('；')}\n` : ''}
为这个世界写一份故事大纲：第一部，3~6 幕，每幕 3~6 个节点；第一部和第一幕的 status 是 active，其余是 planned；节点写具体、能在这个世界里发生的事（节点可以用 links 关联威胁 threat、伏笔 thread、居民 persona）。
再写这个故事的结局：1 个好结局和 1~2 个坏结局（kind 为 good / bad），条件要能用下面的函数判定，而且开局时还没有满足；如果这个世界适合永远写下去，endings 可以是空数组。
条件表达式只能用：${FNS.map((k) => EXPR_FN_DOCS[k]).join('；')}；变量 day（第几天）；语法 && || ! 比较 数字 '字符串'。
输出 JSON：{"premise":"一句话故事（≤${LIMITS.premise}字）","theme":"主题（≤${LIMITS.theme}字）",
"parts":[{"id":"part1","title":"≤${LIMITS.actTitle}字","status":"active","acts":[{"id":"英文小写","title":"≤${LIMITS.actTitle}字","plan":"这一幕要讲什么（≤${LIMITS.plan}字）","status":"active","beats":[{"id":"英文小写","text":"≤${LIMITS.beat}字","status":"planned","links":{"threat":"威胁id"}}]}]}],
"endings":[{"id":"英文小写","title":"≤${LIMITS.endingTitle}字","kind":"good","when":"表达式","for":0,"hint":"写给导演看的说明（≤${LIMITS.hint}字）","finale":{"hours":12,"text":"终幕的一句话（≤${LIMITS.finaleText}字）"}}]}`;
}

/** 整理模型的大纲并校验；返回 { outline, errors } */
export function assembleOutline(raw: ModelJSON, spec: WorldSpec): { outline: Outline; errors: string[] } {
  const o = normalizeOutline(raw);
  if (o.parts.length && !o.parts.some((p) => p.status === 'active')) o.parts[0]!.status = 'active';
  for (const p of o.parts) {
    if (p.status !== 'active') continue;
    if (!p.acts.some((a) => a.status === 'active') && p.acts[0]) p.acts[0].status = 'active';
    let seen = false;
    for (const a of p.acts) if (a.status === 'active') { if (seen) a.status = 'planned'; seen = true; }
  }
  // 创世时所有节点都还没发生
  for (const p of o.parts) for (const a of p.acts) { if (a.status === 'done') a.status = 'planned'; for (const b of a.beats) { b.status = 'planned'; b.chapters = []; } }
  const known = { threats: Object.keys(spec.threats || {}), threads: (spec.threads || []).map((t) => t.id), personas: spec.personas.map((p) => p.id) };
  for (const p of o.parts) for (const a of p.acts) for (const b of a.beats) if (b.links) for (const k of ['threat', 'thread', 'persona'] as const) if (b.links[k] && !(known[`${k}s`] as string[]).includes(b.links[k]!)) delete b.links[k];
  return { outline: o, errors: outlineErrors(o, known) };
}
