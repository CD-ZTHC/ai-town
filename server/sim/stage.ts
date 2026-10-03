// 演出系统（docs/design/presentation.md §4）：一段演出是一张有上限的「分镜表」，只影响观众的画面，不改变世界、不进存档，
// 所以可以交给任何 AI 调用——效果 stage（能力、规则、威胁、负担值、剧情弧）、剧情导演的节拍、世界创建者的接口、引擎的自动演出都走这里。
// 校验与模板展开是只依赖显式输入的函数（test/stage.test.ts）；Town 上的 stage() 负责解析目标、节流、请模型写旁白、发出 stage 事件。
import * as llm from '../llm.ts';
import { SCHEMAS } from '../llm-schemas.ts';
import { posOf, VFX } from '../kernel/effects.ts';
import type { Town } from '../sim.ts';
import type { WorldSpec } from '../types/spec.ts';
import type { EffectCtx } from '../kernel/effects.ts';
import type { ModelJSON } from '../llm.ts';

export const STEP_KINDS = ['focus', 'letterbox', 'slow', 'card', 'banner', 'narrate', 'flash', 'shake', 'vfx', 'reveal', 'sound', 'wait'] as const;
export const TEMPLATES = ['intro', 'moment', 'reveal', 'aftermath', 'genesis'] as const;
export const SOUNDS = ['swing', 'hit', 'crit', 'dodge', 'shield', 'roar', 'quake', 'split', 'chime'];
export const MAX_STEPS = 12;
export const MAX_MS = 15_000;
export const MINOR_GAP_MS = 30_000; // 普通演出全世界至少间隔这么久
const DEFAULT_MS: Record<string, number> = { focus: 900, slow: 1500, card: 1800, banner: 1500, narrate: 2200, reveal: 3000, wait: 500 };
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TARGET_RE = /^(self|target|threat|at|(loc|agent|threat|region):[a-z0-9_-]{1,40})$/;

/** 演出脚本（数据或 AI 写的，逐项校验） */
export interface StageScript {
  priority?: 'minor' | 'major';
  template?: (typeof TEMPLATES)[number];
  target?: string;
  name?: string;
  title?: string;
  text?: string;
  ai?: string;
  emoji?: string;
  color?: string;
  region?: string;
  steps?: StageStep[];
}
export interface StageStep {
  do: (typeof STEP_KINDS)[number];
  target?: string;
  zoom?: number;
  ms?: number;
  on?: boolean;
  scale?: number;
  name?: string;
  title?: string;
  emoji?: string;
  color?: string;
  text?: string;
  ai?: string;
  power?: number;
  preset?: string;
  radius?: number;
  sfx?: string;
}

const str = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);
const inRange = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const textOk = (v: unknown, max = 40) => v == null || (typeof v === 'string' && v.length <= max);

/** 模板 → 分镜（写了 steps 时用 steps） */
export function expandStage(s: StageScript): StageStep[] {
  if (Array.isArray(s.steps) && s.steps.length) return s.steps;
  const target = s.target || 'self';
  const text = s.text || s.name || '';
  switch (s.template) {
    case 'intro': return [
      { do: 'letterbox', on: true }, { do: 'focus', target, zoom: 1.8, ms: 900 }, { do: 'sound', sfx: 'roar' },
      { do: 'card', name: s.name || text, title: s.title, emoji: s.emoji, color: s.color, ms: 2000 },
      ...(s.ai || s.text ? [{ do: 'narrate' as const, text: s.text, ai: s.ai, ms: 2200 }] : []), { do: 'letterbox', on: false },
    ];
    case 'moment': return [
      { do: 'focus', target, zoom: 1.6, ms: 600 }, { do: 'slow', scale: 0.35, ms: 1400 }, { do: 'flash', color: s.color || '#ffffff' },
      { do: 'banner', text, color: s.color, ms: 1600 }, ...(s.ai ? [{ do: 'narrate' as const, text: s.text, ai: s.ai, ms: 2000 }] : []),
    ];
    case 'reveal': return [
      ...(s.region ? [{ do: 'focus' as const, target: `region:${s.region}`, zoom: 0.6, ms: 1200 }] : []), { do: 'sound', sfx: 'chime' }, { do: 'reveal', text },
      ...(s.ai ? [{ do: 'narrate' as const, text: s.text, ai: s.ai, ms: 2200 }] : []),
    ];
    case 'aftermath': return [
      { do: 'letterbox', on: true }, { do: 'focus', target, zoom: 1.2, ms: 1400 }, { do: 'narrate', text: s.text, ai: s.ai, ms: 2600 }, { do: 'letterbox', on: false },
    ];
    case 'genesis': return [
      { do: 'letterbox', on: true }, { do: 'focus', target, zoom: 1.7, ms: 900 }, { do: 'slow', scale: 0.3, ms: 1800 }, { do: 'sound', sfx: 'split' },
      { do: 'flash', color: s.color || '#ffd166' }, { do: 'shake', power: 10 }, { do: 'banner', text, color: s.color || '#ffd166', ms: 1800 },
      ...(s.ai || s.title ? [{ do: 'narrate' as const, text: s.title, ai: s.ai, ms: 2400 }] : []), { do: 'letterbox', on: false },
    ];
  }
  return [];
}

/** 一步的时长（毫秒） */
const stepMs = (st: StageStep): number => (typeof st.ms === 'number' ? st.ms : DEFAULT_MS[st.do] || 0);

/** 校验一段演出：返回错误文本或 null。spec 用来检查地点、区域是否存在（可选） */
export function checkStage(s: unknown, spec?: WorldSpec | null): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return '演出应为对象';
  const x = s as StageScript;
  if (x.priority != null && !['minor', 'major'].includes(x.priority)) return 'priority 只能是 minor / major';
  if (x.template != null && !TEMPLATES.includes(x.template)) return `template 只能是 ${TEMPLATES.join('/')}`;
  if (x.steps == null && x.template == null) return '需要 template 或 steps';
  for (const k of ['name', 'title', 'text', 'ai'] as const) if (!textOk(x[k], k === 'ai' ? 80 : 40)) return `${k} 过长`;
  if (x.color != null && !COLOR_RE.test(x.color)) return 'color 应为 #rrggbb';
  const refErr = (t: unknown) => {
    if (t == null) return null;
    if (typeof t !== 'string' || !TARGET_RE.test(t)) return `目标不合法：${String(t).slice(0, 20)}（self / target / threat / at / loc:地点id / agent:居民id / threat:威胁id / region:区域id）`;
    if (spec && t.startsWith('loc:') && !Object.hasOwn(spec.locations, t.slice(4))) return `未知地点：${t.slice(4)}`;
    return null;
  };
  { const e = refErr(x.target); if (e) return e; }
  if (x.steps != null && !Array.isArray(x.steps)) return 'steps 应为数组';
  const steps = expandStage(x);
  if (!steps.length) return '演出是空的';
  if (steps.length > MAX_STEPS) return `最多 ${MAX_STEPS} 步`;
  let total = 0;
  for (const [i, st] of steps.entries()) {
    const at = `steps[${i}]`;
    if (!st || typeof st !== 'object' || !STEP_KINDS.includes(st.do)) return `${at}.do 只能是 ${STEP_KINDS.join('/')}`;
    if (st.ms != null && !inRange(st.ms, 0, 6000)) return `${at}.ms 应在 0~6000`;
    total += stepMs(st);
    const e = refErr(st.target);
    if (e) return `${at}：${e}`;
    if (st.zoom != null && !inRange(st.zoom, 0.4, 3)) return `${at}.zoom 应在 0.4~3`;
    if (st.scale != null && !inRange(st.scale, 0.2, 1)) return `${at}.scale 应在 0.2~1`;
    if (st.power != null && !inRange(st.power, 1, 12)) return `${at}.power 应在 1~12`;
    if (st.radius != null && !inRange(st.radius, 0.5, 6)) return `${at}.radius 应在 0.5~6`;
    if (st.color != null && !COLOR_RE.test(st.color)) return `${at}.color 应为 #rrggbb`;
    for (const k of ['name', 'title', 'text', 'emoji'] as const) if (!textOk(st[k], k === 'emoji' ? 8 : 40)) return `${at}.${k} 过长`;
    if (!textOk(st.ai, 80)) return `${at}.ai 过长（≤80字）`;
    if (st.do === 'vfx' && !VFX.includes(st.preset as string)) return `${at}.preset 只能是 ${VFX.join('/')}`;
    if (st.do === 'sound' && !SOUNDS.includes(st.sfx as string)) return `${at}.sfx 只能是 ${SOUNDS.join('/')}`;
    if ((st.do === 'banner' || st.do === 'reveal') && !str(st.text, 40)) return `${at} 需要 text`;
    if (st.do === 'narrate' && !str(st.text, 40) && !str(st.ai, 80)) return `${at} 需要 text 或 ai`;
    if (st.do === 'card' && !str(st.name, 40)) return `${at} 需要 name`;
  }
  if (total > MAX_MS) return `演出太长（${Math.round(total / 1000)} 秒，最多 ${MAX_MS / 1000} 秒）`;
  return null;
}

/** 解析好的目标：单位引用（前端跟着它实时移动）+ 此刻的位置；whole 表示整张地图 */
export interface StageTarget { kind?: string; id?: string; x: number; y: number; region: string; whole?: boolean }

export class Stage {
  /** 把目标写法解析成位置；解析不了返回 null（这一步的镜头被跳过，文字照常） */
  stageTarget(this: Town, ref: string | undefined, ctx: EffectCtx): StageTarget | null {
    const r = ref || 'self';
    const agent = (a: EffectCtx['self']) => { if (!a || !this.agents.includes(a)) return null; const p = posOf(this, a); return p ? { kind: 'agent', id: a.id, x: p.x, y: p.y, region: p.region || 'town' } : null; };
    const threat = (t: { id: string; x: number; y: number; region?: string } | null | undefined) => (t ? { kind: 'threat', id: t.id, x: t.x, y: t.y, region: t.region || 'town' } : null);
    if (r === 'self') return agent(ctx.self) || (ctx.at ? { x: ctx.at.x, y: ctx.at.y, region: ctx.at.region || 'town' } : null);
    if (r === 'target') return agent(ctx.target);
    if (r === 'threat') return threat(ctx.threat);
    if (r === 'at') return ctx.at ? { x: ctx.at.x, y: ctx.at.y, region: ctx.at.region || 'town' } : null;
    const [k, id] = r.split(':') as [string, string];
    if (k === 'agent') return agent(this.byId[id]);
    if (k === 'threat') return threat(this.threats.live().find((t) => t.id === id || t.type === id));
    if (k === 'loc') { const c = this.locCenter(id); return c ? { x: c.x, y: c.y, region: this.locRegion(id) } : null; }
    if (k === 'region') { const w = this.regions[id]; return w ? { x: w.W / 2, y: w.H / 2, region: id, whole: true } : null; }
    return null;
  }

  /**
   * 放一段演出：校验 → 展开模板 → 解析目标 → 节流 → （需要时）请模型写旁白 → 发出 stage 事件。
   * 返回是否发出（被节流、校验不过时为 false）。force：世界创建者 / 管理员手动放的，不受节流
   */
  stage(this: Town, script: StageScript, ctx: EffectCtx = {}, { source = '', force = false }: { source?: string; force?: boolean } = {}): boolean {
    const err = checkStage(script, this.spec);
    if (err) { console.warn(`[stage] ${source} 的演出不合法：${err}`); return false; }
    const priority = script.priority || (script.template === 'genesis' || script.template === 'intro' ? 'major' : 'minor');
    const now = this.now();
    if (priority === 'minor' && !force && now - (this.rt.stageAt || -Infinity) < MINOR_GAP_MS) return false;
    if (priority === 'minor') this.rt.stageAt = now;
    let region: string | null = null;
    const steps = expandStage(script).map((st) => {
      const out: Record<string, unknown> = { ...st };
      if (st.do === 'focus' || st.do === 'vfx') {
        const t = this.stageTarget(st.target, ctx);
        if (!t) return null;
        out.target = t;
        region ||= t.region;
      }
      return out;
    }).filter(Boolean) as Array<Record<string, unknown>>;
    if (!region) { const t = this.stageTarget(script.target, ctx); region = t?.region || ctx.at?.region || 'town'; }
    const id = `st${++this.seq}`;
    // 先发出（不等模型）：写了 ai 的旁白先用 text（没有就先不放），模型写好后作为「补一句旁白」再发一次（follow），前端直接叠成字幕
    const asks = steps.filter((st) => st.do === 'narrate' && st.ai);
    const ready = steps.filter((st) => !(st.do === 'narrate' && st.ai && !st.text)).map(({ ai: _ai, ...st }) => st);
    if (ready.length) this.emit('stage', { id, priority, region, source, steps: ready });
    if (!asks.length || !llm.enabled() || llm.budgetLeft() <= 0) return true;
    for (const st of asks) {
      llm.chatJSON([
        { role: 'system', content: `你是「${this.spec.meta.name}」的旁白。${this.spec.lore.summary.slice(0, 200)}\n只输出 JSON。` },
        { role: 'user', content: `${this.timeBlock?.() || ''}\n为这个画面写一句旁白（≤30字，不要引号）：${st.ai}\n输出 JSON：{"text":"…"}` },
      ], { label: '演出旁白', schema: SCHEMAS.narration, maxTokens: 200, tier: 'fast', attempts: 1, timeoutMs: 8_000 }).then((r: ModelJSON) => {
        const text = str(r?.text, 40);
        if (text) this.emit('stage', { id: `st${++this.seq}`, follow: id, priority, region, source, steps: [{ do: 'narrate', text, ms: st.ms ?? 2400 }] });
      }).catch(() => {});
    }
    return true;
  }

}
