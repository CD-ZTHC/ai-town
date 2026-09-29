// 世界登记项与世界包（多世界设计 §3、§6.3）：worlds/registry、worlds/pack 与管理面板共用。
import type { Arc } from './spec.ts';

/** 世界的状态（状态机见 worlds/registry.ts） */
export type WorldStatus = 'drafting' | 'preview' | 'failed' | 'public' | 'paused' | 'unlisted' | 'suspended' | 'archived';

/** 世界级设置（worlds 表的 settings 列）：分级、叙事者、Mod、模型服务、管理员改过的字段… */
export interface WorldSettings {
  rating?: string;
  storyteller?: string;
  mods?: string[];
  /** 按世界配置的模型服务（world-llm.ts 的 normalizeAi 规范化） */
  ai?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- 用户提交的原始配置，由 normalizeAi 逐项裁剪
  aiPaused?: boolean;
  migration?: boolean;
  /** 管理员改过的标题 / 简介：之后不再被世界包覆盖 */
  overrides?: { title?: boolean; summary?: boolean };
  [k: string]: unknown;
}

/** 世界配额（worlds 表的 quota 列） */
export interface WorldQuota {
  diskMB?: number;
  dailyWorldTokens?: number;
  [k: string]: unknown;
}

/** 世界登记项（WorldRegistry.row2world） */
export interface World {
  id: string;
  ownerId: string | null;
  title: string;
  summary: string;
  sourceTitle: string;
  status: WorldStatus;
  visibility: string;
  official: boolean;
  rating: string;
  packHash: string | null;
  evolution: boolean;
  settings: WorldSettings;
  quota: WorldQuota;
  diskBytes: number;
  disk: Record<string, number>;
  createdAt: number;
  publishedAt: number | null;
  statusReason: string | null;
  statusAt: number | null;
  releasedAt: number | null;
}

/** world.json：内核规格加上世界包自己的字段（voice、rhythm、era…），由 kernel/spec 的 validateSpec 与 PackMetaSchema 校验 */
export type PackWorld = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 读进来的 JSON，校验在 packErrors / validateSpec

/** 一个世界包（loadPack 读出的内容） */
export interface Pack {
  dir?: string;
  world: PackWorld;
  /** map.json：区域（语义布局的区域还没有求解出尺寸，所以只要求这几项） */
  map: { regions: Array<{ id: string; name: string; generator: string; [k: string]: unknown }>; [k: string]: unknown };
  arcs: Arc[];
  bible: unknown;
  /** 内容哈希（不含 source/） */
  hash: string;
}
