// 即时战斗的规则（docs/design/combat.md §3）：不建小镇，给数据和固定的随机数，断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { abilitySkill, absorb, addStatus, checkCombatBlock, chooseSkill, damageRoll, effectiveStats, fallbackLine, fallbackTactic, inShape, stepToward, wantsFlee, STRIKE } from '../server/sim/fight-rules.ts';
import { createRng } from '../server/kernel/rng.ts';
import type { Ability } from '../server/types/spec.ts';
import type { Fighter, Situation } from '../server/sim/fight-rules.ts';

const always = (v: number) => () => v;
const ab = (id: string, effects: Ability['effects'], combat: Ability['combat'] | null = {}, target = 'agent'): Ability => ({ id, name: id, emoji: '✨', target, desc: 'x', effects, ...(combat ? { combat } : {}) });
const holder = (): Pick<Fighter, 'statuses'> => ({ statuses: [] });

test('伤害：攻击 × 浮动 × 弱点 × 暴击 − 防御的一半，至少 1；同一个种子结果相同', () => {
  // rng 依次给出：暴击判定、浮动
  const seq = (...v: number[]) => () => v.shift()!;
  assert.deepEqual(damageRoll(10, 4, seq(0.5, 0.5)), { dmg: 8, crit: false });
  assert.deepEqual(damageRoll(10, 4, seq(0.05, 0.5)), { dmg: 14, crit: true });
  assert.deepEqual(damageRoll(10, 0, seq(0.5, 0.5), { weak: true, power: 2, add: 5 }), { dmg: 38, crit: false });
  assert.equal(damageRoll(1, 50, always(0.5)).dmg, 1);
  assert.deepEqual(damageRoll(7, 2, createRng(9)), damageRoll(7, 2, createRng(9)));
});

test('状态：护盾先吸收并叠加；虚弱、架势、加速改属性；过期的不算', () => {
  const f = holder();
  addStatus(f, { id: 'shield', until: 10, amount: 10 });
  addStatus(f, { id: 'shield', until: 8, amount: 5 });
  assert.equal(f.statuses[0]!.amount, 15);
  assert.equal(absorb(f, 12, 1), 0);
  assert.equal(absorb(f, 12, 1), 9, '护盾只剩 3');
  assert.equal(f.statuses.length, 0, '护盾用完就没了');
  addStatus(f, { id: 'weaken', until: 5 });
  addStatus(f, { id: 'guard', until: 5, amount: 3 });
  addStatus(f, { id: 'haste', until: 5 });
  assert.deepEqual(effectiveStats({ atk: 10, def: 1, spd: 1, tags: [] }, f, 2), { atk: 7, def: 4, spd: 1.5, tags: [] });
  assert.deepEqual(effectiveStats({ atk: 10, def: 1, spd: 1, tags: [] }, f, 5), { atk: 10, def: 1, spd: 1, tags: [] });
});

test('范围：圆形、直线、扇形', () => {
  const o = { x: 0, y: 0 }, east = { x: 3, y: 0 };
  const circle = { shape: 'circle' as const, range: 0, radius: 2 };
  assert.ok(inShape(circle, o, east, { x: 1, y: 1 }));
  assert.ok(!inShape(circle, o, east, { x: 2, y: 2 }));
  const line = { shape: 'line' as const, range: 5, radius: 0.8 };
  assert.ok(inShape(line, o, east, { x: 4.5, y: 0.5 }));
  assert.ok(!inShape(line, o, east, { x: -1, y: 0 }), '身后不算');
  assert.ok(!inShape(line, o, east, { x: 2, y: 1.5 }));
  const cone = { shape: 'cone' as const, range: 2.2, radius: 0 };
  assert.ok(inShape(cone, o, east, { x: 1.5, y: 1 }));
  assert.ok(!inShape(cone, o, east, { x: 0, y: 2 }), '扇形只有前方 90°');
});

test('能力 → 招式：combat 块给出节奏与范围，效果决定用途；写坏的 combat 块被拒绝', () => {
  assert.equal(abilitySkill(ab('a', [{ op: 'heal', amount: 5 }], null)), null, '没有 combat 块不能在战斗里用');
  const s = abilitySkill(ab('b', [{ op: 'strike', power: 2 }, { op: 'status', status: 'stun', beats: 4 }], { windup: 4, range: 3 }))!;
  assert.deepEqual([s.role, s.windup, s.range, s.shape, s.cd], ['control', 4, 3, 'single', 12]);
  assert.equal(abilitySkill(ab('c', [{ op: 'status', status: 'shield', beats: 9, amount: 9, target: 'self' }], {}, 'self'))!.role, 'guard');
  assert.equal(abilitySkill(ab('d', [{ op: 'strike' }], {}, 'area'))!.shape, 'circle');
  assert.equal(checkCombatBlock({ windup: 2, shape: 'cone' }), null);
  assert.match(checkCombatBlock({ windup: 99 })!, /windup/);
  assert.match(checkCombatBlock({ shape: 'star' })!, /shape/);
});

test('规则 AI：血少时护身、有控制招时先控制、够不着时远程招占优；逃跑与走位', () => {
  const sit = (hp: number, foeAt = { x: 1, y: 0 }): Situation => ({ me: { x: 0, y: 0, hp, maxHp: 100 }, foe: { ...foeAt, hp: 50, maxHp: 50 }, foes: [foeAt], statuses: [], beat: 1 });
  const guard = abilitySkill(ab('g', [{ op: 'status', status: 'shield', beats: 9, amount: 9, target: 'self' }], {}, 'self'))!;
  const stun = abilitySkill(ab('s', [{ op: 'strike' }, { op: 'status', status: 'stun', beats: 4 }], { range: 2 }))!;
  const shot = abilitySkill(ab('l', [{ op: 'strike' }], { range: 6, shape: 'line' }))!;
  const r0 = always(0);
  assert.equal(chooseSkill([STRIKE, guard], sit(30), r0), guard);
  assert.equal(chooseSkill([STRIKE, guard], sit(90), r0), STRIKE);
  assert.equal(chooseSkill([STRIKE, stun], sit(90), r0), stun);
  assert.equal(chooseSkill([STRIKE, shot], sit(90, { x: 5, y: 0 }), r0), shot);
  assert.ok(wantsFlee('agent', 20, 100, 30));
  assert.ok(!wantsFlee('agent', 20, 100, 80), '勇敢的不逃');
  assert.ok(!wantsFlee('threat', 1, 100, 0), '威胁不逃');
  assert.deepEqual(stepToward({ x: 0, y: 0 }, { x: 4, y: 0 }, 1, 1.5), { x: 1, y: 0 });
  assert.deepEqual(stepToward({ x: 0, y: 0 }, { x: 2, y: 0 }, 1, 1.5), { x: 0.5, y: 0 }, '走到射程边上就停');
});

test('战术（没有模型时）：胆小又血少想跑、同伴挨打时护人、胆小或吃亏时稳守，其余猛攻；战术影响选招与逃跑', () => {
  const base = { hp: 100, maxHp: 100, courage: 70, villain: false, allyHurt: false };
  assert.equal(fallbackTactic({ ...base, hp: 20, courage: 30 }), 'flee');
  assert.equal(fallbackTactic({ ...base, allyHurt: true }), 'protect');
  assert.equal(fallbackTactic({ ...base, allyHurt: true, villain: true }), 'aggressive', '反派不护人');
  assert.equal(fallbackTactic({ ...base, courage: 30 }), 'defensive');
  assert.equal(fallbackTactic(base), 'aggressive');
  const guard = abilitySkill(ab('g', [{ op: 'status', status: 'shield', beats: 9, amount: 9, target: 'self' }], {}, 'self'))!;
  const sit = { me: { x: 0, y: 0, hp: 80, maxHp: 100 }, foe: { x: 1, y: 0, hp: 50, maxHp: 50 }, foes: [{ x: 1, y: 0 }], statuses: [], beat: 1 };
  assert.equal(chooseSkill([STRIKE, guard], { ...sit, tactic: 'aggressive' }, always(0)), STRIKE);
  assert.equal(chooseSkill([STRIKE, guard], { ...sit, tactic: 'defensive' }, always(0)), guard, '稳守时先护身');
  assert.ok(wantsFlee('agent', 40, 100, 40, 'defensive'), '稳守的人更早撤');
  assert.ok(!wantsFlee('agent', 40, 100, 40));
  assert.ok(wantsFlee('agent', 80, 100, 90, 'flee'), '想脱身的人找机会就走');
  assert.match(fallbackLine('join', { ally: '小满' }, always(0)), /小满/);
});
