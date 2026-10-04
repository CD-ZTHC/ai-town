// 前端的纯函数（不依赖 DOM，在 Node 里直接导入）：拆分前后行为保持一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { h2, vnoise, hexToRgb, mix, lerp, clamp01, skyAt, Renderer, TS } from '../public/js/render.js';
import { esc, fmtTime, sparkline, bodyHTML } from '../public/js/ui.js';
import { shade } from '../public/js/sprites.js';

test('噪声：确定、落在 0~1、相邻格子连续', () => {
  assert.equal(h2(3, 4, 1), h2(3, 4, 1));
  assert.notEqual(h2(3, 4, 1), h2(4, 3, 1));
  for (let i = 0; i < 200; i++) {
    const v = vnoise(i * 0.37, i * 0.21, 7);
    assert.ok(v >= 0 && v <= 1, `vnoise 越界：${v}`);
    assert.ok(h2(i, -i, 3) >= 0 && h2(i, -i, 3) < 1);
  }
  // 在整数格点上等于格点的哈希值；格点之间平滑变化
  assert.equal(vnoise(5, 9, 2), h2(5, 9, 2));
  assert.ok(Math.abs(vnoise(5.001, 9, 2) - vnoise(5, 9, 2)) < 0.01);
});

test('颜色：hex 解析、插值（夹在 0~1）、明暗', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
  assert.equal(mix('#000000', '#ffffff', 0.5), 'rgb(128,128,128)');
  assert.equal(mix('#000000', '#ffffff', 2), 'rgb(255,255,255)');
  assert.equal(mix('#102030', '#102030', 0.3), 'rgb(16,32,48)');
  assert.equal(lerp(2, 4, 0.25), 2.5);
  assert.deepEqual([clamp01(-1), clamp01(0.4), clamp01(9)], [0, 0.4, 1]);
  assert.equal(shade('#808080', 0), '#808080');
  assert.equal(shade('#808080', -1), '#000000');
  assert.equal(shade('#808080', 1), '#ffffff');
});

test('天色：白天亮、深夜暗、黄昏偏暖、清晨偏粉，坏天气更暗', () => {
  const noon = skyAt(12 * 60, 'sunny');
  assert.deepEqual(noon, { dark: 0, warm: 0, pink: 0, night: false });
  const night = skyAt(23 * 60, 'sunny');
  assert.equal(night.dark, 0.66);
  assert.equal(night.night, true);
  assert.ok(skyAt(17.5 * 60, 'sunny').warm > 0.4);
  assert.ok(skyAt(5.5 * 60, 'sunny').pink > 0.7);
  assert.ok(skyAt(12 * 60, 'storm').dark > skyAt(12 * 60, 'rain').dark);
  assert.ok(skyAt(12 * 60, 'storm').dark > 0);
  assert.equal(skyAt(12 * 60, 'unknown-weather').dark, 0);
  for (let m = 0; m < 1440; m += 7) {
    const s = skyAt(m, 'storm');
    assert.ok(s.dark >= 0 && s.dark <= 0.78, `第 ${m} 分钟 dark=${s.dark}`);
  }
});

test('坐标换算：世界 ↔ 屏幕互逆，镜头中心在屏幕中央', () => {
  const r = Object.create(Renderer.prototype);
  Object.assign(r, { vw: 1200, vh: 800 });
  const cam = { x: 40 * TS, y: 20 * TS, zoom: 1.5 };
  assert.deepEqual(r.worldToScreen(cam.x, cam.y, cam), [600, 400]);
  const [sx, sy] = r.worldToScreen(123, 456, cam);
  const [wx, wy] = r.screenToWorld(sx, sy, cam);
  assert.ok(Math.abs(wx - 123) < 1e-9 && Math.abs(wy - 456) < 1e-9);
  r.hits = [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 5, y: 5, w: 10, h: 10 }];
  assert.equal(r.hitTest(7, 7), 'b', '后画的在上面');
  assert.equal(r.hitTest(2, 2), 'a');
  assert.equal(r.hitTest(50, 50), null);
});

test('界面文本：转义、时间格式', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(9 * 60 + 5), '09:05');
  assert.equal(fmtTime(1440 + 23 * 60 + 59.9), '23:59');
});

test('张力曲线：空数据给提示；有数据时两条折线落在画布内', () => {
  assert.match(sparkline([]), /张力曲线会在整点更新/);
  const svg = sparkline([{ v: 0, target: 50 }, { v: 100, target: 50 }, { v: 150, target: -5 }]);
  const lines = [...svg.matchAll(/points="([^"]+)"/g)].map((m) => m[1].split(' ').map((p) => p.split(',').map(Number)));
  assert.equal(lines.length, 2);
  for (const pts of lines) for (const [x, y] of pts) assert.ok(x >= 0 && x <= 680 && y >= 0 && y <= 90, `${x},${y}`);
  assert.deepEqual(lines[1][0], [0, 90]);
  assert.deepEqual(lines[1][1], [340, 0]);
  assert.match(sparkline([{ v: 30, target: 30 }]), /points="340\.0,63\.0"/, '只有一个点时画在中间');
});

test('居民状态卡：体力勇气条夹在 0~100，物品与能力都经过转义', () => {
  assert.equal(bodyHTML({}), '');
  const html = bodyHTML({
    body: { stamina: 130, courage: -5, conditions: ['疲惫'] },
    inventory: [{ name: '<b>灯</b>', emoji: '🏮', n: 2 }],
    abilities: [{ name: '萤火结界', emoji: '🏮', desc: '"护"', cooldown: 3 }],
    researching: '萤火',
  });
  assert.match(html, /width:100%/);
  assert.match(html, /width:0%/);
  assert.match(html, /&lt;b&gt;灯&lt;\/b&gt;×2/);
  assert.ok(!html.includes('<b>灯</b>'));
  assert.match(html, /冷却 3 分钟/);
  assert.match(html, /<span>疲惫<\/span>/);
});

test('看哪张地图：未开放的区域里有正在看的人时不切回主地图；取地图失败后退避；镜头按界面遮挡让开', async () => {
  const { mustLeave, retryAt, camRange } = await import('../public/js/regionview.js');
  const open = { town: { open: true }, meadow: { open: true }, forest: { open: false } };
  assert.equal(mustLeave('town', open, []), false);
  assert.equal(mustLeave('meadow', open, []), false);
  assert.equal(mustLeave('forest', open, []), true, '没人可看的未开放区域：切回主地图');
  assert.equal(mustLeave('forest', open, ['town', 'forest']), false, '跟随的人在那边：留下（不和跟随逻辑来回切）');
  assert.equal(retryAt(null), 0);
  assert.equal(retryAt({ n: 1, at: 1000 }), 3000);
  assert.equal(retryAt({ n: 3, at: 1000 }), 9000);
  assert.equal(retryAt({ n: 20, at: 1000 }), 61000, '最多等 60 秒');
  // 地图 1000 宽、半屏 300：没有遮挡时边缘只多让 60；左边被挡住 200 像素（缩放 2）时再多让 100
  assert.deepEqual(camRange(1000, 300, 2, 0, 0, 60, 60), [240, 760]);
  assert.deepEqual(camRange(1000, 300, 2, 200, 0, 60, 60), [140, 760]);
  // 地图比屏幕小：居中在没被挡住的地方
  assert.deepEqual(camRange(400, 300, 2, 200, 0, 60, 60), [150, 150]);
});
