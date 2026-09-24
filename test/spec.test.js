// 世界规格：默认规格必须合法，并与重构前写死在代码里的数据完全一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpec, validateSpec, calendarHint, pickWeather, activeEvents, weekdayOf } from '../server/kernel/spec.js';
import { buildWorld } from '../server/world.js';
import { PERSONAS } from '../server/personas.js';

test('默认规格通过校验', () => {
  assert.deepEqual(validateSpec(defaultSpec({})), []);
});

test('内容分级读取 STORY_RATING，非法值回落到 cozy', () => {
  assert.equal(defaultSpec({ STORY_RATING: 'adventure' }).meta.rating, 'adventure');
  assert.equal(defaultSpec({ STORY_RATING: 'gore' }).meta.rating, 'cozy');
  assert.equal(defaultSpec({}).meta.rating, 'cozy');
});

test('由规格生成的地图与原地图逐格一致', () => {
  const s = defaultSpec({});
  const a = buildWorld();
  const b = buildWorld({ buildings: s.buildings, locationInfo: s.locations });
  assert.deepEqual(b.tiles, a.tiles);
  assert.deepEqual([...b.walk], [...a.walk]);
  assert.deepEqual(b.buildings, a.buildings);
  assert.deepEqual(b.objects, a.objects);
  assert.deepEqual(b.locations, a.locations);
});

test('居民、公共地点与重构前一致', () => {
  const s = defaultSpec({});
  assert.deepEqual(s.personas, PERSONAS);
  const pub = Object.keys(s.locations).filter((id) => s.locations[id].public && !s.locations[id].region);
  assert.deepEqual(pub, ['cafe', 'library', 'tavern', 'clinic', 'workshop', 'square', 'market', 'park', 'farm', 'pier']);
});

test('节日提示文案与重构前一致', () => {
  const s = defaultSpec({});
  assert.equal(calendarHint(s, 1), '距离周六萤火节还有3天。');
  assert.equal(calendarHint(s, 4), '今天就是萤火节！晚上大家会在镜湖边放灯许愿。');
  assert.equal(calendarHint(s, 5), '萤火节已经过去了。');
  assert.equal(weekdayOf(s, 1), '周三');
  assert.equal(weekdayOf(s, 8), '周三');
});

test('节日只在当天 18:00 之后进行', () => {
  const s = defaultSpec({});
  assert.equal(activeEvents(s, 4, 17 * 60).length, 0);
  assert.equal(activeEvents(s, 4, 18 * 60)[0].id, 'firefly');
  assert.equal(activeEvents(s, 3, 20 * 60).length, 0);
});

test('自动天气的概率分布与重构前的阈值一致', () => {
  const s = defaultSpec({});
  // 旧逻辑：r<0.5 晴，<0.75 多云，<0.88 雨，<0.93 雷阵雨，否则雾（白天雾改为多云）
  const legacy = (r, m) => {
    let w = r < 0.5 ? 'sunny' : r < 0.75 ? 'cloudy' : r < 0.88 ? 'rain' : r < 0.93 ? 'storm' : 'fog';
    if (w === 'fog' && m > 600 && m < 1140) w = 'cloudy';
    return w;
  };
  for (const m of [300, 700, 1200]) {
    for (let i = 0; i < 1000; i++) {
      const r = (i + 0.5) / 1000;
      assert.equal(pickWeather(s, m, () => r), legacy(r, m), `r=${r} m=${m}`);
    }
  }
});

test('校验器能发现坏数据', () => {
  const s = defaultSpec({});
  s.personas[0].home = 'nowhere';
  s.params.walkSpeed = 99;
  s.weather.fog.avoid.fallback = 'lava';
  const errs = validateSpec(s);
  assert.ok(errs.some((e) => e.includes('home')));
  assert.ok(errs.some((e) => e.includes('walkSpeed')));
  assert.ok(errs.some((e) => e.includes('fallback')));
});
