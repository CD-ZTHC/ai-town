// 区域生成器（多世界设计 §3.2）：世界包的 map.json 只写「用哪个生成器、什么参数」，由生成器确定性地展开成瓦片。
//   yunxi-v1      云溪镇的手工布局（逐格不变）
//   moonrealm-v1  暗月界
//   layout-v1     语义布局 → 地图（创世生成的世界用，见 layout.js）
import { buildWorld, buildMoonRealm } from '../world.ts';
import { buildLayoutRegion } from './layout.ts';
import type { Region } from '../types/spec.ts';
import type { GenSpec, GenWorld } from '../types/map.ts';

export type Generator = (region: Region, spec: GenSpec) => GenWorld;

const GENERATORS: Record<string, Generator> = {
  'yunxi-v1': (region, spec) => buildWorld({ buildings: spec.buildings!, locationInfo: spec.locations!, region, spec }),
  'moonrealm-v1': (region, spec) => buildMoonRealm({ locationInfo: spec.locations, region, spec }),
  'layout-v1': (region, spec) => buildLayoutRegion(region, spec),
};

export function registerGenerator(name: string, fn: Generator): void { GENERATORS[name] = fn; }
export const generatorNames = () => Object.keys(GENERATORS);

/** 按区域的生成器展开地图 */
export function buildRegion(region: Region, spec: GenSpec): GenWorld {
  const gen = GENERATORS[region.generator];
  if (!gen) throw new Error(`未知的地图生成器：${region.generator}`);
  const w = gen(region, spec);
  w.id = region.id;
  w.name = region.name || w.name;
  w.generator = region.generator;
  return w;
}

/** 世界的全部区域；第一个区域是主地图（id 固定为 town） */
export function buildRegions(spec: GenSpec & { regions: Region[] }): Record<string, GenWorld> {
  return Object.fromEntries(spec.regions.map((r) => [r.id, buildRegion(r, spec)]));
}
