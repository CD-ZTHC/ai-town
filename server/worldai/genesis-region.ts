// 创世时现场生成区域布局（combat.md §5：worldOp 的 generate）：世界包只写意图与兜底布局，模型按意图给出名字、地貌与地点。
// 模型给的布局照常经世界操作的校验（OPS[action].check）；没有模型、出错、校验不过时用世界包写的兜底参数。
// 只负责「语义布局」（名字、地貌、地点），地图的位置（id、from、side、length、region）始终来自世界包，模型改不了。
import * as llm from '../llm.ts';
import { SCHEMAS } from '../llm-schemas.ts';
import { BIOME_IDS, BUILDING_KINDS, OUTDOOR_KINDS } from '../worldgen/layout.ts';
import type { Town } from '../sim.ts';
import type { ModelJSON } from '../llm.ts';

/** 可以现场生成布局的世界操作 */
export const GENERATABLE: readonly string[] = ['addRegion', 'addAdjacentRegion', 'expandMap'];
/** 世界包定下、模型不能改的参数 */
const FIXED = ['id', 'from', 'side', 'length', 'region', 'by', 'seed', 'passages', 'fromName'];

/** 模型的回复 → 世界操作的参数（只取语义布局的部分，地点 id 加上前缀避免撞名） */
export function mergeLayout(action: string, base: Record<string, unknown>, res: ModelJSON, prefix: string): Record<string, unknown> | null {
  if (!res || typeof res !== 'object') return null;
  const KINDS = new Set([...Object.keys(BUILDING_KINDS), ...Object.keys(OUTDOOR_KINDS)]);
  const place = (p: ModelJSON, i: number) => ({
    id: `${prefix}_${String(p?.id || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 12) || 'p'}${i}`,
    kind: String(p?.kind || ''), name: String(p?.name || '').slice(0, 16), emoji: String(p?.emoji || '').slice(0, 4), desc: String(p?.desc || '').slice(0, 60),
  });
  // 类型不认识、没有名字的地点直接丢掉（不让一个坏地点拖垮整片布局）
  const places = (xs: unknown, from: number) => (Array.isArray(xs) ? xs : []).slice(0, 4).map((p, j) => place(p, from + j)).filter((p) => KINDS.has(p.kind) && p.name);
  const out: Record<string, unknown> = { ...base, name: String(res.name || base.name || '').slice(0, 16) };
  if (BIOME_IDS.includes(res.biome)) out.biome = res.biome;
  if (action === 'expandMap') {
    out.places = places(res.places, 0);
  } else {
    const areas = (Array.isArray(res.areas) ? res.areas : []).slice(0, 3).map((a: ModelJSON, i: number) => ({
      id: `${prefix}_a${i}`, ...(BIOME_IDS.includes(a?.biome) ? { biome: a.biome } : {}), size: ['small', 'medium', 'large'].includes(a?.size) ? a.size : 'medium',
      places: places(a?.places, i * 10),
    })).filter((a: { places: unknown[] }) => a.places.length);
    if (!areas.length) return null;
    out.areas = areas;
  }
  for (const k of FIXED) if (k in base) out[k] = base[k];
  return out;
}

/**
 * 模型的布局放不下时逐步收缩（地图窄时几块区域挤在一行里最容易放不下）：
 * 只留前两块、每块最多 2 个地点 → 合成一块（最多 3 个地点）→ 一块 2 个地点 → 一块 1 个地点
 */
export function layoutVariants(action: string, args: Record<string, unknown>): Array<Record<string, unknown>> {
  type Area = { id: string; biome?: string; size?: string; places: unknown[] };
  if (action === 'expandMap') {
    const ps = (args.places as unknown[]) || [];
    return [args, { ...args, places: ps.slice(0, 2) }, { ...args, places: ps.slice(0, 1) }];
  }
  const areas = (args.areas as Area[]) || [];
  const all = areas.flatMap((a) => a.places);
  const one = (n: number) => ({ ...args, areas: [{ ...areas[0]!, size: 'large', places: all.slice(0, n) }] });
  return [args, { ...args, areas: areas.slice(0, 2).map((a) => ({ ...a, places: a.places.slice(0, 2) })) }, one(3), one(2), one(1)];
}

/**
 * 让模型按意图生成布局并应用；返回 Promise（创世效果不等它）。
 * apply(args)：求解地形、校验并应用一组参数，成功返回 true（失败不抛出）；先试模型给的，不行再用兜底的
 */
export function generateLayout(town: Town, action: string, base: Record<string, unknown>, intent: string, apply: (args: Record<string, unknown>) => boolean): Promise<void> {
  const fallback = () => { if (!apply(base)) town.log('world', `🌫️ 创世的力量落了空：「${intent.slice(0, 20)}」没能成形`, {}); };
  if (!llm.enabled() || llm.budgetLeft() <= 0) { fallback(); return Promise.resolve(); }
  const kinds = [...Object.keys(BUILDING_KINDS), ...Object.keys(OUTDOOR_KINDS)].join('/');
  const P = '{"id":"英文小写","kind":"地点类型","name":"≤10字","emoji":"一个emoji","desc":"≤40字"}';
  const shape = action === 'expandMap'
    ? `{"name":"≤12字","biome":"地貌","places":[${P}, …]（1~4个地点）}`
    : `{"name":"≤12字","biome":"地貌","areas":[{"biome":"地貌","size":"small/medium/large","places":[${P}, …]（每块 1~4 个地点）}, …]（1~3块）}`;
  const prefix = String(base.id || base.region || 'gen').replace(/[^a-z0-9_]/g, '').slice(0, 10) || 'gen';
  return llm.chatJSON([
    { role: 'system', content: `你是「${town.spec.meta.name}」的创世之力，为世界里新出现的一片地方设计布局。${town.spec.lore.summary}\n只输出 JSON。` },
    { role: 'user', content: `这片新地方的意图：${intent}
地貌只能是：${BIOME_IDS.join('/')}
地点类型只能是：${kinds}（建筑类会有房子，其余是户外）
输出 JSON：${shape}` },
  ], { label: '创世布局', schema: SCHEMAS.genesisLayout, maxTokens: 900, tier: 'fast', attempts: 1, timeoutMs: 45_000 }).then((res: ModelJSON) => {
    const args = mergeLayout(action, base, res, prefix);
    if (!(args && layoutVariants(action, args).some((v) => apply(v)))) fallback();
  }).catch(() => fallback());
}
