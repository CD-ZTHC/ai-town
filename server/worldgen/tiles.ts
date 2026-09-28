// 瓦片类型与可通行性：生成器、叠加层、放置求解共用
export const T = {
  GRASS: 0, PATH: 1, PLAZA: 2, DIRT: 3, WATER: 4, SAND: 5, BRIDGE: 6, SOIL: 7, WOOD: 8, DEEP: 9, FLOWER: 10,
  MOON: 11, VOID: 12, MOONPATH: 13, // 暗月界：月砂地、星空虚空、月光小径
};
export const WALKABLE = new Set([T.GRASS, T.PATH, T.PLAZA, T.DIRT, T.SAND, T.BRIDGE, T.SOIL, T.WOOD, T.FLOWER, T.MOON, T.MOONPATH]);
