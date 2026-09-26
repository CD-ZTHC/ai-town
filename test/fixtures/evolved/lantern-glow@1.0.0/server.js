// 码头灯语：傍晚到码头的居民会停下来看灯
export default function setup(api) {
  api.effect('glowUp', (args, ctx) => {
    const n = (api.store.get('glows') || 0) + 1;
    api.store.set('glows', n);
    return [
      { op: 'vfx', preset: 'glow_ring', color: '#ffcc66', radius: args.warmth },
      { op: 'mood', text: '温暖', emoji: '🏮', target: 'self' },
    ];
  });
  api.on('agent.arrive', (event, world) => {
    if (event.locId !== 'pier' || world.hour < 17) return [];
    api.overlay([{ kind: 'emoji', x: event.agent.x, y: event.agent.y - 1, text: '🏮' }]);
    return [{ op: 'say', text: '码头的灯亮起来了', who: event.agent.id }];
  });
  api.route('stats', () => ({ glows: api.store.get('glows') || 0 }));
}
