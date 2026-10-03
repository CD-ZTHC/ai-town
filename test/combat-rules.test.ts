// 战斗规则（重构方案 P6 第三步）：不建小镇，给数据和固定种子的随机数，断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, harmVerdict, stealCaught, guardRepels } from '../server/sim/combat.ts';
import type { WorldSpec } from '../server/types/spec.ts';

const fighter = (courage: number, hp = 100, inventory: Record<string, number> = {}, combat?: { atk?: number; def?: number }) =>
  ({ name: '某人', body: { hp, stamina: 100, courage, conditions: [] }, inventory, combat }) as Parameters<typeof computeStats>[0];
const always = (v: number) => () => v;

test('属性：基础值 + 勇气 + 人设 + 装备（只算装备类、数量大于 0 的物品）', () => {
  const items = {
    sword: { name: '剑', equip: true, mods: { atk: 3 }, tags: ['metal'] },
    shield: { name: '盾', equip: true, mods: { def: 2 } },
    bread: { name: '面包', mods: { atk: 9 } },
  } as unknown as WorldSpec['items'];
  assert.deepEqual(computeStats(fighter(50), items), { atk: 4, def: 1, tags: [] });
  assert.deepEqual(computeStats(fighter(100, 100, { sword: 1, shield: 1, bread: 3 }, { atk: 1 }), items), { atk: 10, def: 3, tags: ['metal'] });
  assert.deepEqual(computeStats(fighter(0, 100, { sword: 0 }, { atk: -10, def: -5 }), items), { atk: 1, def: 0, tags: [] }, '有下限');
});

test('能不能动手：世界不允许 → 分级不允许杀人 → 有仇 / 反派 / 敌对阵营才能动手', () => {
  const base = { hostileWorld: true, rating: 'dark', intent: 'subdue', affinity: 0, villain: false, factionsHostile: false, names: ['甲', '乙'] as [string, string] };
  assert.match(harmVerdict({ ...base, hostileWorld: false })!, /没有人会动手/);
  assert.match(harmVerdict({ ...base, rating: 'gentle', intent: 'kill', affinity: -100 })!, /不允许杀人/);
  assert.match(harmVerdict(base)!, /甲和乙没有深仇大恨/);
  assert.equal(harmVerdict({ ...base, affinity: -40 }), null);
  assert.equal(harmVerdict({ ...base, villain: true }), null);
  assert.equal(harmVerdict({ ...base, factionsHostile: true }), null);
});

test('偷窃与营救的检定', () => {
  assert.equal(stealCaught(50, 50, always(0.39)), true);
  assert.equal(stealCaught(50, 50, always(0.41)), false);
  assert.equal(stealCaught(100, 0, always(0.89)), true, '失主越勇敢越容易被抓');
  const seq = [0, 0.999];
  assert.equal(guardRepels({ atk: 5, def: 0, tags: [] }, { atk: 5, def: 0, tags: [] }, () => seq.shift()!), true, '救人者先掷（0）、看守后掷（0.999）');
});
