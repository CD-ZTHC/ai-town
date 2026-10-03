// 区域规则（重构方案 P6 第三步）：不建小镇，给数据断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegionOpen, nextHop, locationCenter, matchLocName } from '../server/sim/regions.ts';
import type { RegionLink } from '../server/sim/regions.ts';
import type { MapLocation } from '../server/types/map.ts';

test('区域开关：主地图总是开放；世界标记优先于区域自己的声明', () => {
  const regions = [{ id: 'moon', open: false }, { id: 'forest', open: true }];
  assert.equal(isRegionOpen({}, regions, 'town'), true);
  assert.equal(isRegionOpen({}, regions, 'moon'), false);
  assert.equal(isRegionOpen({}, regions, 'forest'), true);
  assert.equal(isRegionOpen({ region_moon: true }, regions, 'moon'), true);
  assert.equal(isRegionOpen({ region_forest: false }, regions, 'forest'), false);
  assert.equal(isRegionOpen({}, regions, 'nowhere'), false);
});

test('跨区域路线：最少换乘、只走开放的区域、同一段挑离当前位置最近的出口', () => {
  const L = (from: string, to: string, x: number): RegionLink => ({ from, to, a: { x, y: 0 }, b: { x: 0, y: 0 }, name: `${from}→${to}` });
  const links = [L('town', 'forest', 10), L('town', 'forest', 40), L('forest', 'moon', 5), L('town', 'cave', 1), L('cave', 'moon', 1)];
  const all = () => true;
  assert.equal(nextHop(links, all, 'town', 'town'), null);
  assert.equal(nextHop(links, all, 'town', 'moon')!.to, 'forest', '两条路都是两段：按边的顺序先找到的');
  assert.equal(nextHop(links, all, 'town', 'forest', { x: 38, y: 0 })!.a.x, 40, '挑近的出口');
  assert.equal(nextHop(links, (id) => id !== 'forest', 'town', 'moon')!.to, 'cave', '森林关闭时绕路');
  assert.equal(nextHop(links, (id) => id !== 'forest' && id !== 'cave', 'town', 'moon'), null, '到不了');
});

test('地点中心：站位 → 室内门口 → 区域中心', () => {
  const b = [{ id: 'inn', entrance: { x: 7, y: 8 } }];
  assert.deepEqual(locationCenter({ spots: [{ x: 1, y: 2 }] } as MapLocation, b), { x: 1, y: 2 });
  assert.deepEqual(locationCenter({ spots: [], indoor: 'inn' } as unknown as MapLocation, b), { x: 7, y: 8 });
  assert.deepEqual(locationCenter({ rect: { x: 10, y: 10, w: 5, h: 4 } } as MapLocation, b), { x: 13, y: 12 });
  assert.equal(locationCenter({} as MapLocation, b), null);
  assert.equal(locationCenter(null, b), null);
});

test('地名匹配：模型写中文地名时互相包含就算', () => {
  const locs = [{ id: 'tavern', name: '酒馆' }, { id: 'pier', name: '镜湖码头' }];
  assert.equal(matchLocName('去酒馆', locs), 'tavern');
  assert.equal(matchLocName('码头', locs), 'pier');
  assert.equal(matchLocName('学校', locs), null);
});
