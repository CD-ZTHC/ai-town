// 生成出来的地图（重构方案 §8.2 B4）：生成器（world.ts 的 yunxi-v1 / moonrealm-v1、worldgen/layout.ts 的 layout-v1）
// 先画一张画布（Canvas），再由 worldgen/finish.ts 叠加运行中的变化、做连通性过滤，得到 GenWorld。前端拿到的就是它。
import type { Building, Location, Region } from './spec.ts';

export interface Cell { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** 地图上的装饰物与设施（树、长椅、路灯、摊位……）；不同 type 带不同的字段 */
export interface MapObject {
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  kind?: string;
  v?: number;
  [k: string]: unknown;
}

/** 地图上的建筑：规格里的建筑加上门与入口（入口是门外可以站的那一格） */
export type MapBuilding = Building & { door: Cell; entrance: Cell };

/** 地图上的地点：站位、所在建筑（室内）或户外范围 */
export interface MapLocation {
  id: string;
  name: string;
  emoji?: string;
  desc?: string;
  spots: Cell[];
  indoor?: string | null;
  rect?: Rect | null;
  /** 建筑成了废墟：不再是室内地点 */
  ruin?: boolean;
  /** 建筑停业 / 受损：只能到门口 */
  closed?: string;
  [k: string]: unknown;
}

/** 地貌的调色板（前端按它画草地） */
export interface BiomeColors { id: string; grass: string[]; blade: string[] }

/** 生成器画好的画布（交给 finishRegion） */
export interface Canvas {
  name?: string;
  W: number;
  H: number;
  tiles: number[];
  solid: Uint8Array;
  objects: MapObject[];
  buildings: MapBuilding[];
  locations: Record<string, MapLocation>;
  lamps: Cell[];
  /** 通往其他区域的渡口；可以是叠加之后才能确定的（函数） */
  gate: Cell | (() => Cell);
  /** 连通性的起点，缺省为 gate */
  origin?: Cell;
  /** 新增建筑晚上要不要点灯 */
  lampForAdded?: boolean;
  /** 哪些瓦片算路、从入口开小路时哪些地面铺成泥路 */
  roads?: number[];
  dirtOver?: number[];
  /** 每格的地貌下标（biomes 里的位置） */
  biome?: Uint8Array | number[];
  biomes?: BiomeColors[];
  [k: string]: unknown;
}

/** 最终的地图 */
export interface GenWorld {
  id: string;
  name?: string;
  generator?: string;
  W: number;
  H: number;
  tiles: number[];
  /** 从起点出发可以走到的格子 */
  walk: Uint8Array;
  objects: MapObject[];
  buildings: MapBuilding[];
  locations: Record<string, MapLocation>;
  lamps: Cell[];
  gate: Cell;
  /** 运行中新增的建筑放不下的原因：建筑 id → 原因 */
  overlayErrors: Record<string, string>;
  /** 拆除后留下的空地 */
  lots?: Array<Rect & { id: string; name: string }>;
  /** 与相邻地图相通的边缘通道 */
  passages?: Array<Cell & { key: string; to: string; side: string; name: string | null }>;
  biome?: number[];
  biomes?: BiomeColors[];
  [k: string]: unknown;
}

/** 生成器需要的规格字段 */
export interface GenSpec {
  buildings?: Building[];
  locations?: Record<string, Location>;
  regions?: Region[];
}
