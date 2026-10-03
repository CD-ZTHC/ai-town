// 低延迟移动的前端逻辑（public/js/localmove.js，docs/design/realtime.md §4）：过图在 CDN 的乱序与延迟下不闪回、不回弹
import test from 'node:test';
import assert from 'node:assert/strict';

const Local = await import('../public/js/localmove.js');
// 两张 10×10 的地图，全部能走；A 的 (9,5) 是去 B 的路口，落在 B 的 (0,5)；B 的 (0,5) 也是回 A 的路口
const grid = () => ({ W: 10, H: 10, walk: new Uint8Array(100).fill(1) });
const sent: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const app = {
  perms: { realtime: 'on' }, regionWorlds: { A: grid(), B: grid() }, regionsOpen: { A: { open: true }, B: { open: true } },
  links: [{ from: 'A', to: 'B', a: { x: 9, y: 5 }, b: { x: 0, y: 5 } }, { from: 'B', to: 'A', a: { x: 0, y: 5 }, b: { x: 9, y: 5 } }],
  api: async () => ({ ok: true }),
};
Local.init(app);
Local.setSender((b: unknown) => sent.push(b));
const me = (o: Record<string, unknown>) => ({ id: 'v1', x: 5, y: 5, dir: 'right', region: 'A', pv: 0, ...o });
const walk = (dx: number, dy: number, s: number) => { Local.input([dx, dy]); for (let t = 0; t < s; t += 0.05) { Local.step(0.05); Local.flush(); } Local.input(null); };

test('预判过图：走到路口立即切到对面，上报经过的路口；确认前不再上报；确认后带新版本号继续', async () => {
  Local.sync(me({ x: 7.5 }));
  sent.length = 0;
  walk(1, 0, 0.6);
  assert.equal(Local.pos()!.region, 'B', '走到路口就切过去了（不等服务器）');
  assert.deepEqual(sent.find((b) => b.via)?.via, { from: 'A', to: 'B' });
  const n = sent.length;
  walk(1, 0, 0.3);
  assert.equal(sent.length, n, '等确认期间不上报');
  Local.onResult({ ok: true, pv: 1, region: 'B', seq: sent[n - 1].seq });
  await new Promise((r) => setTimeout(r, 120)); // 上报按真实时间每 100 毫秒一次
  walk(1, 0, 0.3);
  assert.equal(sent.at(-1).pv, 1, '确认后带着新版本号上报');
});

test('落点保护：刚落地往回走一点不会被送回去', () => {
  // 接着上一个用例：在 B 的落点附近，往回（朝 B→A 的路口）走一小步
  const before = Local.pos()!;
  assert.equal(before.region, 'B');
  walk(-1, 0, 0.1);
  assert.equal(Local.pos()!.region, 'B');
});

test('乱序：换图的回执先到、换图之前生成的旧快照后到——版本号只进不退，不闪回旧地图；过期的回执被丢掉', () => {
  Local.sync(me({ id: 'v2', x: 5, pv: 3 }));
  // 服务器（兜底的自动换图）告诉我们：已经去了 B，版本 4
  Local.onResult({ ok: false, reason: '换了地图', x: 0, y: 5, region: 'B', pv: 4, seq: 999 });
  assert.equal(Local.pos()!.region, 'B');
  // 换图之前生成的快照现在才到（Cloudflare 把推送攒在一起）
  Local.sync(me({ id: 'v2', x: 8.9, pv: 3, region: 'A' }));
  assert.equal(Local.pos()!.region, 'B', '旧快照被忽略');
  // 在 B 走了几步之后，一条针对旧上报的「版本号过期」回执到了
  walk(0, 1, 0.5);
  const p = Local.pos()!;
  Local.onResult({ ok: false, stale: true, x: 0, y: 5, region: 'B', pv: 4, seq: 1 });
  assert.deepEqual([Local.pos()!.x, Local.pos()!.y], [p.x, p.y], '过期的回执不回弹');
  // 服务器真的又改了位置（例如被击退，版本 5）：照服务器
  Local.sync(me({ id: 'v2', x: 3, y: 3, pv: 5, region: 'B' }));
  assert.deepEqual([Local.pos()!.x, Local.pos()!.y], [3, 3]);
});
