// 安全表达式：语法、运算、以及各种恶意输入
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, ExprError } from '../server/kernel/expr.ts';

const FNS = new Set(['has', 'max']);
const run = (src, vars = {}, fns = {}) => evaluate(parse(src, FNS), vars, fns);

test('基本运算与优先级', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('-2 + 5'), 3);
  assert.equal(run('10 % 4 == 2'), true);
  assert.equal(run('1 < 2 && 3 >= 3 || false'), true);
  assert.equal(run('!true'), false);
  assert.equal(run('5 / 0'), 0, '除零不抛异常');
  assert.equal(run("'萤火' + '节'"), '萤火节');
});

test('变量读取只限自有属性', () => {
  const vars = { self: { loc: 'cafe', body: { hp: 80 } }, weather: 'rain' };
  assert.equal(run("self.loc == 'cafe'", vars), true);
  assert.equal(run('self.body.hp > 50', vars), true);
  assert.equal(run('self.missing.deep', vars), undefined);
  assert.equal(run("weather == 'rain' || weather == 'storm'", vars), true);
  assert.equal(run('中文变量 == null', {}), true);
});

test('白名单函数', () => {
  assert.equal(run('max(1, 5, 3)', {}, { max: Math.max }), 5);
  assert.equal(run("has(self, 'lantern')", { self: {} }, { has: () => true }), true);
  assert.throws(() => parse('eval(1)', FNS), /不允许的函数/);
  assert.throws(() => parse('require("fs")', FNS), /不允许的函数/);
});

test('拒绝访问原型链和内部属性', () => {
  for (const src of ['self.constructor', 'self.__proto__', 'constructor', 'self.toString', 'a.hasOwnProperty']) {
    assert.throws(() => parse(src, FNS), ExprError, src);
  }
  // 即便变量表里真的放了函数，也读不出来
  assert.equal(run('self.fn', { self: { fn: () => 1 } }), undefined);
});

test('拒绝语法外的东西', () => {
  for (const src of ['a = 1', 'a; b', '[1,2]', '{a:1}', '`x`', 'a => a', 'new Date()', 'x[0]', '']) {
    assert.throws(() => parse(src, FNS), ExprError, JSON.stringify(src));
  }
});

test('长度、复杂度上限', () => {
  assert.throws(() => parse('1+'.repeat(200) + '1', FNS), /过长|复杂/);
  assert.throws(() => parse(Array(80).fill('1').join('+'), FNS), /复杂/);
});
