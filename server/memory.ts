// 记忆流：写入、压缩、按「时近性 + 重要性 + 相关性」检索。
// 相关性默认用中文双字组相似度（无需向量模型）；配置了 embedding 时取双字组与语义相似度中较高的一个。
import type { Memory } from './types/agent.ts';

/** 记忆流操作只需要居民的这几个字段 */
export interface MemoryOwner {
  id: string;
  memories: Memory[];
  importanceAcc?: number;
  /** 记忆 id 的计数（随存档保存）：id 只由居民与计数决定，同一个种子跑两次完全相同 */
  memSeq?: number;
}

const PUNCT = /[\s，。！？、；：“”‘’（）《》…—\-,.!?;:'"()[\]{}~·]/g;

function bigrams(text: unknown): Set<string> {
  const s = String(text).replace(PUNCT, '');
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 两段文本的双字组相似度（0~1），供记忆检索、设定检索与能力缺口去重共用 */
export function similarity(a: unknown, b: unknown): number {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return hit / Math.sqrt(x.size * y.size);
}

export const MEMORY_CAP = 400;
// 压缩时只动「琐碎」的记忆：反思、摘要、日记不压缩，重要性 ≥ 6 的也不压缩
const KEEP_TYPES = new Set(['reflect', 'summary', 'diary']);
export const isTrivial = (m: Memory): boolean => !KEEP_TYPES.has(m.type) && m.importance < 6;
const MIN_GROUP = 5; // 同一天至少这么多条琐碎记忆才值得压缩成一条

// 记忆 id：居民 id + 计数（重构方案 P7）。旧存档里的 id 是「居民-时间戳-序号」，格式不同，不会和新 id 撞上
const newId = (agent: MemoryOwner): string => `${agent.id}-m${(agent.memSeq = (agent.memSeq || 0) + 1)}`;

/** encode(agent, text)：写入前把旅人的昵称换成账号引用（由账号模块设置，见 accounts/refs.ts） */
export const memoryHooks: { encode: ((agent: MemoryOwner, text: string) => string) | null } = { encode: null };

export function addMemory(agent: MemoryOwner, { t, type = 'obs', text, importance = 3 }: { t: number; type?: Memory['type']; text: string; importance?: number }): Memory {
  if (memoryHooks.encode) text = memoryHooks.encode(agent, text);
  const m: Memory = { id: newId(agent), t, type, text, importance };
  agent.memories.push(m);
  agent.importanceAcc = (agent.importanceAcc || 0) + importance;
  // 控制容量：优先把最早一天的琐碎记忆压缩成一条摘要；实在没有可压缩的，才淘汰最旧的一条琐碎记忆
  if (agent.memories.length > MEMORY_CAP && !compactOldestDay(agent, m)) {
    const drop = agent.memories.findIndex((x) => x.type !== 'reflect' && x.importance < 6);
    agent.memories.splice(drop >= 0 ? drop : 0, 1);
  }
  return m;
}

/**
 * 找出可以压缩的一天：最早的、琐碎记忆不少于 minItems 条的那一天（beforeDay 之前，不含 except）。
 * 返回 { day, items } 或 null；day 从 1 开始，与界面上的「第 N 天」一致。
 */
export function condenseCandidate(agent: MemoryOwner, { minItems = MIN_GROUP, beforeDay = Infinity, except = null }: { minItems?: number; beforeDay?: number; except?: Memory | null } = {}): { day: number; items: Memory[] } | null {
  const byDay = new Map<number, Memory[]>();
  for (const m of agent.memories) {
    if (m === except || !isTrivial(m)) continue;
    const day = Math.floor(m.t / 1440) + 1;
    if (day >= beforeDay) continue;
    let list = byDay.get(day);
    if (!list) byDay.set(day, (list = []));
    list.push(m);
  }
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const items = byDay.get(day)!;
    if (items.length >= minItems) return { day, items };
  }
  return null;
}

/** 规则摘要（不调用模型）：挑最重要的几条，拼成一句 */
export function ruleSummary(day: number, items: Memory[]): string {
  const top = [...items].sort((a, b) => b.importance - a.importance || a.t - b.t).slice(0, 4);
  const parts = top.map((m) => {
    // 去掉句末的括注（如「（和周慧约好的）」，截断的也算）与标点，太长的截断并标上省略号
    const s = String(m.text).replace(/（[^）]*）?$/u, '').replace(/[。！？，\s]+$/u, '');
    return s.length > 28 ? `${s.slice(0, 27)}…` : s;
  });
  return `第${day}天的零碎记忆：${parts.join('；')}${items.length > top.length ? `……（共${items.length}件小事）` : ''}`.slice(0, 160);
}

/** 用一条摘要替换一组记忆（按 id；已经不在的会被忽略）。摘要插在这组记忆最后一条的时间位置。返回摘要或 null */
export function replaceWithSummary(agent: MemoryOwner, items: Memory[], { text, importance = 4, day }: { text: string; importance?: number; day?: number }): Memory | null {
  const ids = new Set(items.map((m) => m.id));
  const gone = agent.memories.filter((m) => ids.has(m.id));
  if (gone.length < 2) return null;
  const t = Math.max(...gone.map((m) => m.t));
  const s: Memory = { id: newId(agent), t, type: 'summary', text: String(text).slice(0, 200), importance, day, count: gone.length };
  const rest = agent.memories.filter((m) => !ids.has(m.id));
  const at = rest.findIndex((m) => m.t > t);
  rest.splice(at < 0 ? rest.length : at, 0, s);
  agent.memories = rest;
  return s;
}

function compactOldestDay(agent: MemoryOwner, justAdded: Memory): boolean {
  const c = condenseCandidate(agent, { except: justAdded });
  if (!c) return false;
  return Boolean(replaceWithSummary(agent, c.items, { text: ruleSummary(c.day, c.items), day: c.day }));
}

// 记忆的双字组缓存：检索时不必每次都重新切分全部记忆。不进存档，记忆被淘汰后自动回收；文本变了就重新计算
const gramCache = new WeakMap<Memory, { text: string; grams: Set<string> }>();
function memGrams(m: Memory): Set<string> {
  const c = gramCache.get(m);
  if (c && c.text === m.text) return c.grams;
  const grams = bigrams(m.text);
  gramCache.set(m, { text: m.text, grams });
  return grams;
}

/** 余弦相似度（向量等长） */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]!, y = b[i]!; dot += x * y; na += x * x; nb += y * y; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
// 语义相似度映射到 0~1：embedding 的余弦值在无关文本之间通常也有 0.2~0.3，低于 0.3 视为无关
const semantic = (c: number): number => Math.max(0, Math.min(1, (c - 0.3) / 0.5));

export interface RetrieveOptions {
  /** 查询的向量（配置了 embedding 时） */
  qvec?: ArrayLike<number> | null;
  /** 取某条记忆的向量；还没算好的返回 undefined，只用双字组 */
  vecOf?: ((m: Memory) => ArrayLike<number> | undefined) | null;
}

/** 按「时近性 + 重要性 + 相关性」取最相关的 k 条记忆（按时间排序） */
export function retrieve(agent: MemoryOwner, query: string, now: number, k = 10, { qvec = null, vecOf = null }: RetrieveOptions = {}): Memory[] {
  const q = bigrams(query);
  const scored = agent.memories.map((m) => {
    const hours = Math.max(0, (now - m.t) / 60);
    const recency = Math.pow(0.97, hours);
    const importance = m.importance / 10;
    let relevance = 0;
    if (q.size) {
      const b = memGrams(m);
      let hit = 0;
      for (const g of q) if (b.has(g)) hit++;
      relevance = Math.min(1, (hit / Math.sqrt(q.size * Math.max(1, b.size))) * 3);
    }
    if (qvec && vecOf) {
      const v = vecOf(m);
      if (v) relevance = Math.max(relevance, semantic(cosine(qvec, v)));
    }
    return { m, score: recency + importance + relevance * 1.5 + (m.type === 'reflect' ? 0.2 : 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.m)
    .sort((a, b) => a.t - b.t);
}

export function fmtTime(t: number): string {
  const m = Math.floor(t % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function fmtStamp(t: number): string {
  return `第${Math.floor(t / 1440) + 1}天 ${fmtTime(t)}`;
}
export function parseHM(s: unknown): number | null {
  const m = /(\d{1,2})[:：](\d{2})/.exec(String(s));
  if (!m) return null;
  return Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2]));
}
