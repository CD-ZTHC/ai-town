// 社交与视图规则（重构方案 P6 第三步）：不建小镇，给数据断言结果
import test from 'node:test';
import assert from 'node:assert/strict';
import { withBelief, beliefsToShare, chatPairs } from '../server/sim/social.ts';
import { agentFrame } from '../server/sim/views.ts';
import type { LiveAgent } from '../server/types/agent.ts';

const B = (about: string, confidence: number) => ({ about, claim: `${about}的看法`, confidence, source: '', t: 0 });

test('写入信念：同话题替换、确信度截断取两位、最多 20 条', () => {
  let bs = [B('天气', 0.5)];
  bs = withBelief(bs, { about: '天气', claim: '要下雨', confidence: 1.234 }, 99.7);
  assert.deepEqual(bs, [{ about: '天气', claim: '要下雨', confidence: 1, source: '', t: 99 }]);
  for (let i = 0; i < 25; i++) bs = withBelief(bs, { about: `话题${i}`, claim: 'x' }, 0);
  assert.equal(bs.length, 20);
  assert.equal(bs[0]!.about, '话题5');
});

test('传播信念：最新的优先、最多 2 条、没把握的不传、对方更确信的不覆盖', () => {
  const x = [B('a', 0.9), B('b', 0.4), B('c', 0.8), B('d', 0.9)];
  assert.deepEqual(beliefsToShare(x, []).map((b) => [b.about, +b.confidence.toFixed(2)]), [['d', 0.63], ['c', 0.56]]);
  assert.deepEqual(beliefsToShare(x, [B('d', 0.7)]).map((b) => b.about), ['c', 'a']);
  // 对方正好 20 条：第一条传过去会挤掉对方最早的那条，第二条的判断要基于挤掉之后的列表
  const y = [B('a', 0.95), ...Array.from({ length: 19 }, (_, i) => B(`y${i}`, 0.5))];
  assert.deepEqual(beliefsToShare([B('a', 0.9), B('d', 0.9)], y).map((b) => b.about), ['d', 'a']);
});

test('搭话：不能都在走路、要在一起、150 分钟内聊过的不再聊；好感影响概率', () => {
  const P = (id: string, x: number, extra: Partial<LiveAgent> = {}) => ({ id, status: 'acting', region: 'town', inside: null, x, y: 0, relations: {}, ...extra }) as unknown as LiveAgent;
  const a = P('a', 0, { relations: { b: { affinity: 60, note: '' } } }), b = P('b', 2), c = P('c', 10), d = P('d', 1, { status: 'walking' }), e = P('e', 1.5, { status: 'walking' });
  const pairs = chatPairs([a, b, c, d, e], 1000, { 'a|d': 900 }, 0.3);
  assert.deepEqual(pairs.map((p) => [p.a.id, p.b.id, +p.p.toFixed(3)]), [['a', 'b', 0.4], ['a', 'e', 0.3], ['b', 'd', 0.3], ['b', 'e', 0.3]]);
});

test('推送帧：坐标保留 3 位；气泡过了时间不下发；满血不带 hp', () => {
  const a = { id: 'lin', x: 1.23456, y: 2, dir: 'down', moving: false, status: 'acting', inside: null, action: { text: '弹琴', emoji: '🎸' }, locId: 'square', mood: { emoji: '🙂' },
    thinking: 0, thinkingLabel: '', convoId: null, body: { hp: 100 }, bubble: { id: 1, text: '你好', kind: 'say', until: 1000 } } as unknown as LiveAgent;
  const f = agentFrame(a, 999);
  assert.equal(f.x, 1.235);
  assert.deepEqual(f.bubble, { id: 1, text: '你好', kind: 'say' });
  assert.equal('hp' in f, false);
  assert.equal(agentFrame(a, 1000).bubble, null);
});
