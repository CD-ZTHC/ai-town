// 各认知模块的输出结构（重构方案 P8）：zod 定义，一份两用——
//   1. 开启结构化输出（LLM_JSON_SCHEMA=1）时转成 JSON Schema 发给网关（response_format: json_schema / AI SDK Output.object）；
//   2. 解析出 JSON 之后比对一次，不符合的计入 schemaMiss（AI 大脑的指标），只统计、不拒绝——字段的取舍与兜底仍由各模块的手工校验负责。
// 结构与提示词里写给模型的「输出 JSON：{…}」一致；对象都允许多余字段，长度限制只写在提示词里（非严格模式下网关不保证长度）。
import { z } from 'zod';
import type { JsonSchemaSpec } from './types/llm.ts';

/** 把 zod schema 包成 chatJSON 的 schema 选项；name 只能用字母、数字、_ 和 -（OpenAI 的要求） */
export function outputSchema(name: string, zod: z.ZodType): JsonSchemaSpec {
  const schema = z.toJSONSchema(zod, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name, schema, zod };
}

const obj = z.looseObject;
const str = z.string();
const nullable = <T extends z.ZodType>(t: T) => z.union([t, z.null()]);
const entry = obj({ start: str, end: str, location: str, activity: str, emoji: str });
const line = obj({ speaker: str, text: str });
const plan = obj({ time: str, location: str, activity: str, emoji: str });

export const SCHEMAS = {
  memorySummary: outputSchema('memory_summary', obj({ summary: str })),
  innerThought: outputSchema('inner_thought', obj({
    thought: str, action: str, emoji: str, mood: str, moodEmoji: str,
    use: nullable(obj({ ability: str, target: nullable(str) })).optional(),
  })),
  reflect: outputSchema('reflection', obj({ insights: z.array(str), mood: str, moodEmoji: str, goal: str })),
  diary: outputSchema('diary', obj({ diary: str })),
  newspaper: outputSchema('newspaper', obj({
    headline: str, subhead: str, lead: str, articles: z.array(obj({ title: str, body: str })),
    gossip: str, quote: obj({ who: str, text: str }), forecast: str,
  })),
  dayPlan: outputSchema('day_plan', obj({ mood: str, moodEmoji: str, goal: str, schedule: z.array(entry) })),
  replan: outputSchema('replan', obj({ reaction: str, thought: str, schedule: z.array(entry) })),
  convo: outputSchema('conversation', obj({
    lines: z.array(line), summary: str, memoryA: str, memoryB: str,
    affinityA: z.number(), affinityB: z.number(), noteA: str, noteB: str, importance: z.number(),
    commitments: z.array(obj({ who: z.union([z.array(str), str]), time: str, location: str, activity: str, emoji: str })),
    idea: nullable(str).optional(),
  })),
  visitorReply: outputSchema('visitor_reply', obj({
    reply: str, emoji: str, thought: str, memory: str, importance: z.number(), newPlan: nullable(plan),
  })),
  director: outputSchema('director', obj({ decision: str, reason: str, beats: z.array(obj({ kind: str })) })),
  scene: outputSchema('scene', obj({
    lines: z.array(line), summary: str, memories: z.record(str, str),
    affinity: z.array(obj({ from: str, to: str, delta: z.number() })),
    assignments: z.array(obj({ who: str, time: str, location: str, activity: str, emoji: str })),
    choice: z.record(str, str).optional(),
  })),
  swarm: outputSchema('swarm', obj({ target: str, mode: z.enum(['steal', 'scout', 'hide']), reason: str })),
  canon: outputSchema('canon_review', obj({ severity: z.enum(['none', 'minor', 'major']), issues: z.array(str) })),
  council: outputSchema('council', obj({
    consent: z.record(str, obj({ yes: z.boolean(), reason: str })),
    votes: z.record(str, obj({ yes: z.boolean(), reason: str })),
    memories: z.record(str, obj({ agree: str, forced: str })),
    thread: obj({ title: str, hook: str }),
  })),
  // 即时战斗（sim/combat-mind）：开打时的战术与台词、濒死时的一句话
  combatTactic: outputSchema('combat_tactic', obj({ tactic: z.enum(['aggressive', 'defensive', 'protect', 'flee']), protect: nullable(str).optional(), line: str })),
  combatLine: outputSchema('combat_line', obj({ line: str, tactic: z.enum(['aggressive', 'defensive', 'protect', 'flee']).optional() })),
  // 演出旁白（sim/stage）
  narration: outputSchema('narration', obj({ text: str })),
  // 创世时现场生成的布局（worldai/genesis-region）：区域有 areas，扩展地块有 places
  genesisLayout: outputSchema('genesis_layout', obj({
    name: str, biome: str,
    areas: z.array(obj({ biome: str.optional(), size: str.optional(), places: z.array(obj({ id: str, kind: str, name: str, emoji: str, desc: str })) })).optional(),
    places: z.array(obj({ id: str, kind: str, name: str, emoji: str, desc: str })).optional(),
  })),
  // 区域唤醒时的推演（sim/dormancy，docs/design/adventure.md §3.5）
  regionWake: outputSchema('region_wake', obj({
    summary: str,
    changes: z.array(obj({ op: str, args: z.record(str, z.unknown()) })).optional(),
    spawns: z.array(obj({ threat: str, at: str })).optional(),
  })),
  // AI 裁决官：有选项时给 option，否则给 decision
  arbiter: outputSchema('arbiter', obj({ option: str.optional(), decision: str.optional(), confidence: z.number(), reasons: z.array(str) })),
};
