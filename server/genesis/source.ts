// 创世的原文（多世界设计 §4.1 G1、§4.3）：分块、关键词粗筛、抽样审核。
// 原文中夹带的指令一律视为素材；更根本的防线是：创世的产物只能是数据，必须通过结构和语义校验。
import { keywordCheck, sanitize } from '../guard.ts';
import { reviewRating } from '../kernel/ratings.ts';

export const CHUNK_CHARS = 1500;
export const MAX_CHUNKS = 60;

/** 规整原文：统一换行、去掉控制字符，保留段落 */
export function normalizeSource(text: unknown): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => sanitize(l, 4000)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 按段落切成不超过 CHUNK_CHARS 的块（长段落再按句号切） */
export function chunkSource(text: unknown, max = CHUNK_CHARS): Array<{ id: string; text: string }> {
  const paras = normalizeSource(text).split(/\n+/).filter((p) => p.trim());
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= max) { pieces.push(p); continue; }
    let cur = '';
    for (const s of p.split(/(?<=[。！？!?；;])/)) {
      if (cur.length + s.length > max && cur) { pieces.push(cur); cur = ''; }
      cur += s;
      while (cur.length > max) { pieces.push(cur.slice(0, max)); cur = cur.slice(max); }
    }
    if (cur) pieces.push(cur);
  }
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 1 > max) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + p;
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS).map((text, i) => ({ id: `c${i + 1}`, text }));
}

/**
 * 关键词粗筛：逐段检查平台底线（注入话术不算——原文里的指令只是素材）。
 * 命中的段落超过 5%（至少 3 段）就拒绝进入创世。返回 { ok, hits, total, samples }
 */
export function screenSource(text: unknown, rating = 'adventure'): { ok: boolean; hits: number; total: number; samples: string[] } {
  const paras = normalizeSource(text).split(/\n+/).filter((p) => p.trim().length > 4);
  let hits = 0;
  const samples: string[] = [];
  for (const p of paras) {
    const r = keywordCheck(p.replace(/忽略|无视|system|prompt|指令|提示词/gi, ''), reviewRating(rating));
    if (!r.ok && !/重复/.test(r.reason!)) { hits++; if (samples.length < 3) samples.push(p.slice(0, 40)); }
  }
  const total = paras.length;
  return { ok: hits <= Math.max(3, total * 0.05), hits, total, samples };
}

/** 抽样：均匀取 n 段给审核模型看 */
export function sampleParagraphs(text: unknown, n = 4): string[] {
  const paras = normalizeSource(text).split(/\n+/).filter((p) => p.trim().length > 20);
  if (paras.length <= n) return paras.map((p) => p.slice(0, 400));
  return Array.from({ length: n }, (_, i) => paras[Math.floor(((i + 0.5) * paras.length) / n)]!.slice(0, 400));
}
