import setup from './server.js';

export default function (t) {
  t.test('glowUp 返回暖光与心情', () => {
    const api = t.api();
    setup(api);
    const out = api.registered.effects.glowUp({ warmth: 2 }, {});
    t.assert.equal(out[0].op, 'vfx');
    t.assert.equal(out[0].radius, 2);
  });
  t.test('傍晚到码头会说话，白天不会', () => {
    const api = t.api();
    setup(api);
    const agent = { id: 'wang', x: 10, y: 10 };
    t.assert.equal(api.registered.hooks['agent.arrive']({ locId: 'pier', agent }, { hour: 18 }).length, 1);
    t.assert.equal(api.registered.hooks['agent.arrive']({ locId: 'pier', agent }, { hour: 9 }).length, 0);
  });
}
