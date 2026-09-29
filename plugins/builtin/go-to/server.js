// 内置插件 go-to（RFC 0001，docs/rfcs/0001-go-to.md）：让居民立刻动身前往指定地点。
// 来源：AI 心愿单 —— 叙事导演想「萤火节傍晚，把镇上的人都召集到码头一起放灯」，但没有对应的能力。
// 效果是进程级的全局注册，所以在模块加载时注册一次；setup 不需要做任何事。
import { registerEffect } from '../../../plugin-host/registry.ts';
import { checkTarget, resolveTargets } from '../../../server/kernel/effects.ts';

const str = (v, max) => String(v ?? '').trim().slice(0, max);

registerEffect('goTo', {
  doc: '{"op":"goTo","location":"地点id","activity":"≤14字","minutes":30~180,"target":"self/target/e/nearby/all","radius":1~6} 让对象立刻动身前往某地（插入一段即时日程；睡着或正在交谈的人不受影响）',
  check(a, spec) {
    if (!Object.hasOwn(spec.locations, a.location || '') || spec.locations[a.location].public === false) return `未知或不公开的地点：${a.location}`;
    if (a.minutes != null && !(Number.isInteger(a.minutes) && a.minutes >= 30 && a.minutes <= 180)) return 'minutes 应为 30~180 的整数';
    if (a.activity != null && str(a.activity, 20).length > 14) return 'activity 应 ≤14 字';
    return checkTarget(a);
  },
  apply(town, ctx, a) {
    const start = Math.floor(town.minute) + 1;
    if (start >= 22 * 60) return; // 太晚了，不再让人出门
    const end = Math.min(start + (a.minutes ?? 60), 23 * 60);
    const activity = str(a.activity, 14) || `赶去${town.locName(a.location)}`;
    for (const x of resolveTargets(town, ctx, a)) {
      if (x.kind === 'creature' || x.status === 'sleeping' || x.convoId) continue;
      town.insertEntry(x, { start, end, location: a.location, activity, emoji: '🏃', src: 'commit' });
    }
  },
}, 'go-to');

export default { setup() {} };
