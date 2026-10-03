// 低延迟与无锁定战斗（docs/design/realtime.md）：客户端上报位置、服务器校验
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Town as TownT } from '../server/sim.ts';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Town } = await import('../server/sim.ts');
const { loadPack } = await import('../server/worlds/pack.ts');

const NW = loadPack(path.resolve('worlds/night-watch'));
let clock = 1_000_000;
const make = () => new Town({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'town-rt-')), worldId: 'night-watch', pack: NW, instantTalk: true, mods: [], seed: 3, now: () => clock });
/** 化身旁边一格能走的位置（dx 方向） */
function walkable(town: TownT, x: number, y: number) { const w = town.worldOf('town'); return Boolean(w.walk[Math.round(y) * w.W + Math.round(x)]); }

test('位置上报：合理的移动被采用；太快、穿墙、越界被拒绝并回弹；旧版本的上报作废', (t) => {
  const town = make();
  t.after(() => town.stop());
  const v = town.avatars.join('u1', '127.0.0.1', { name: '阿游' });
  // 找一个往右能走 2 格的位置
  const w = town.worldOf('town');
  let sx = -1, sy = -1;
  for (let y = 2; y < w.H - 2 && sx < 0; y++) for (let x = 2; x < w.W - 4; x++) if ([0, 1, 2, 3].every((d) => walkable(town, x + d, y))) { sx = x; sy = y; break; }
  Object.assign(v, { x: sx, y: sy });
  clock += 1000;
  v.reportAt = clock;
  clock += 250;
  assert.deepEqual(town.avatars.report('u1', { x: sx + 1, y: sy, pv: 0 }), { ok: true }, '0.25 秒走 1 格（速度 4 格/秒）');
  assert.equal(v.x, sx + 1);
  assert.equal(v.dir, 'right');
  clock += 100;
  const fast = town.avatars.report('u1', { x: sx + 3, y: sy, pv: 0 });
  assert.equal(fast.ok, false, '0.1 秒走 2 格：太快');
  assert.equal(!fast.ok && fast.x, sx + 1, '回弹到上一个合法位置');
  // 穿墙：找一格走不通的
  let wx = -1, wy = -1;
  for (let y = 1; y < w.H - 1 && wx < 0; y++) for (let x = 1; x < w.W - 1; x++) if (!walkable(town, x, y) && walkable(town, x - 1, y)) { wx = x; wy = y; break; }
  Object.assign(v, { x: wx - 1, y: wy });
  clock += 1000;
  assert.equal(town.avatars.report('u1', { x: wx, y: wy, pv: 0 }).ok, false, '走进走不通的格子');
  assert.equal(town.avatars.report('u1', { x: -5, y: 3, pv: 0 }).ok, false, '越界');
  // 服务器强制改了位置（例如被击退）：客户端拿旧版本上报会被忽略
  town.avatars.forced(v);
  clock += 250;
  const stale = town.avatars.report('u1', { x: v.x, y: v.y, pv: 0 });
  assert.equal(!stale.ok && stale.pv, 1);
  assert.equal(town.avatars.report('u1', { x: v.x, y: v.y, pv: 1 }).ok, true);
});

test('异常太多（一分钟内被拒绝超过 10 次）：退回由服务器决定位置；上报停了就算停下', (t) => {
  const town = make();
  t.after(() => town.stop());
  const v = town.avatars.join('u2', '127.0.0.1', { name: '阿快' });
  for (let i = 0; i < 11; i++) { clock += 100; town.avatars.report('u2', { x: v.x + 30, y: v.y, pv: 0 }); }
  const r = town.avatars.report('u2', { x: v.x, y: v.y, pv: 0 });
  assert.equal(!r.ok && r.fallback, true);
  assert.ok(town.avatars.view().find((x) => x.id === v.id)!.serverMove);
  const u = town.avatars.join('u3', '127.0.0.1', { name: '阿停' });
  Object.assign(u, { moving: true, reportAt: clock });
  clock += 400;
  town.avatars.tick(0.05);
  assert.equal(u.moving, false);
});

test('被打倒、击退等服务器改位置时版本号加一，快照里带上', (t) => {
  const town = make();
  t.after(() => town.stop());
  const v = town.avatars.join('u4', '127.0.0.1', { name: '阿倒' });
  town.avatars.knockout(v);
  assert.equal(v.pv, 1);
  assert.equal(town.avatars.view().find((x) => x.id === v.id)!.pv, 1);
});

// ---------- 无锁定战斗（§5） ----------
const night = (town: TownT) => { town.t = (town.day - 1) * 1440 + 21 * 60; };
function setup(t: import('node:test').TestContext) {
  const town = make();
  t.after(() => town.stop());
  night(town);
  const v = town.avatars.join('u1', '127.0.0.1', { name: '阿游' });
  const w = town.worldOf('town');
  // 一段横向 8 格都能走的空地
  outer: for (let y = 3; y < w.H - 3; y++) for (let x = 3; x < w.W - 10; x++) {
    if ([...Array(9).keys()].every((d) => walkable(town, x + d, y))) { Object.assign(v, { x, y }); break outer; }
  }
  return { town, v };
}
const events = (town: TownT) => { const out: any[] = []; town.on('combat', (e) => out.push(e)); return out; }; // eslint-disable-line @typescript-eslint/no-explicit-any
const beats = (town: TownT, n: number) => { for (let i = 0; i < n; i++) town.combatTick(); };

test('对空出招：没有敌人时开一场「一个人的战斗」，招式落空后悄悄结束；预警带着方向与范围', (t) => {
  const { town, v } = setup(t);
  const ev = events(town);
  assert.ok(town.avatarAct('u1', { skill: 'strike', ax: 1, ay: 0 }).ok);
  assert.ok(town.fights[0]!.solo);
  beats(town, 1);
  const cast = ev.flatMap((e) => e.casts)[0];
  assert.deepEqual([cast.shape, cast.aim], ['single', { x: 1, y: 0 }]);
  assert.deepEqual(cast.from, { x: v.x, y: v.y });
  beats(town, 8);
  assert.equal(town.fights.length, 0, '落空后结束');
  assert.ok(ev.some((e) => e.fx.some((f: { whiff?: boolean }) => f.whiff)));
  assert.ok(!town.logs.some((l) => /动手/.test(l.text)), '对空挥一下不记日志');
});

test('判定区域：面前的纸扎人被打中并拉进战斗；身后的打不到', (t) => {
  const { town, v } = setup(t);
  const front = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(front, { x: v.x + 1, y: v.y, region: 'town', path: [] });
  const back = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(back, { x: v.x - 1.2, y: v.y, region: 'town', path: [], state: 'dormant' });
  town.avatarAct('u1', { skill: 'strike', ax: 1, ay: 0 });
  beats(town, 2);
  assert.ok(front.hp! < 40, '面前的被打中');
  assert.equal(back.hp, 40, '身后的没事');
  assert.ok(town.engaged('threat', front.id));
  assert.ok(!town.fights[0]!.solo, '打中之后成了正常的战斗');
});

test('能躲开：敌人出招的方向在蓄力开始时定下，蓄力期间走出范围就打不中', (t) => {
  const { town, v } = setup(t);
  v.hp = 100;
  const pm = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(pm, { x: v.x + 1, y: v.y, region: 'town', path: [] });
  const ev = events(town);
  town.engage({ kind: 'threat', id: pm.id }, { kind: 'avatar', id: v.id });
  for (let i = 0; i < 6; i++) {
    town.combatTick();
    const c = ev.flatMap((e) => e.casts).find((x) => x.by.kind === 'threat');
    if (c) break;
  }
  // 纸扎人开始蓄力了：旅人往左跑开 3 格
  v.x -= 3;
  beats(town, 2);
  assert.equal(v.hp, 100, '躲开了');
  assert.ok(ev.some((e) => e.fx.some((f: { by: { kind: string }; whiff?: boolean }) => f.by.kind === 'threat' && f.whiff)), '纸扎人打空');
});

test('弹道：直线招式飞过去打中第一个敌人；朝墙打会撞墙消失', (t) => {
  const { town, v } = setup(t);
  const pm = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(pm, { x: v.x + 4, y: v.y, region: 'town', path: [], state: 'dormant' });
  const ev = events(town);
  town.avatarAct('u1', { skill: 'cinnabar_flick', ax: 1, ay: 0 });
  beats(town, 3);
  assert.ok(ev.some((e) => e.fx.some((f: { shape: string; speed?: number }) => f.shape === 'projectile' && f.speed)), '放出了弹道');
  beats(town, 3);
  assert.ok(pm.hp! < 40, '打中了 4 格外的纸扎人');
  assert.ok(!town.fights.some((F) => F.projectiles?.length), '打中后弹道消失');
});

test('延迟补偿：按旅人当时看到的位置判定（最多回溯 250 毫秒）', (t) => {
  const { town, v } = setup(t);
  const pm = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(pm, { x: v.x + 1, y: v.y, region: 'town', path: [], state: 'dormant' });
  v.rtt = 200; // 单程 100 + 插值延后 100 = 回溯 200 毫秒
  town.recordPositions();
  clock += 200;
  pm.x = v.x + 4; // 纸扎人刚刚跑开（旅人的画面里它还在面前）
  town.recordPositions();
  assert.deepEqual(town.posAt({ kind: 'threat', id: pm.id }, clock - 200), { x: v.x + 1, y: v.y });
  assert.deepEqual(town.posAt({ kind: 'threat', id: pm.id }, clock - 100), { x: v.x + 2.5, y: v.y }, '两次记录之间插值');
  town.avatarAct('u1', { skill: 'strike', ax: 1, ay: 0 });
  beats(town, 2);
  assert.ok(pm.hp! < 40, '按回溯的位置打中了');
});

// ---------- 实时通道（§3、§6） ----------
test('WebSocket 帧：解析客户端加了掩码的帧；拒绝不加掩码、分片、过大的帧', async () => {
  const { parseFrames, frame, acceptKey } = await import('../server/net/ws.ts');
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC 6455 的示例');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = (op: number, text: string, fin = true) => { const p = Buffer.from(text); const d = Buffer.from(p.map((b, i) => b ^ mask[i & 3]!)); return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), mask, d]); };
  const two = Buffer.concat([masked(1, 'hi'), masked(1, 'yo')]);
  const [fr, rest] = parseFrames(Buffer.concat([two, two.subarray(0, 3)]));
  assert.deepEqual(fr.map((f) => f.data.toString()), ['hi', 'yo']);
  assert.equal(rest.length, 3, '不完整的帧留到下次');
  assert.throws(() => parseFrames(frame(1, Buffer.from('x'))), /掩码/);
  assert.throws(() => parseFrames(masked(1, 'x', false)), /分片/);
});

test('实时通道：没有票据连不上；连上后心跳、位置纠正、出招、战斗通道都走这条连接', async (t) => {
  const http = await import('node:http');
  const { handleUpgrade, issueTicket, pushChannel } = await import('../server/net/realtime.ts');
  const { town, v } = setup(t);
  const host = { town, rt: new Set<import('../server/net/realtime.ts').RtSession>() };
  const server = http.createServer((_q, r) => r.end());
  server.on('upgrade', (req, socket) => { if (!handleUpgrade(req, socket, { hostOf: (id) => (id === 'night-watch' ? host : null), defaultWorld: () => 'night-watch' })) socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const port = (server.address() as import('node:net').AddressInfo).port;
  const open = (q: string) => new Promise<WebSocket>((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/w/night-watch/api/realtime${q}`); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('连不上')); });
  await assert.rejects(open('?ticket=nope'), /连不上/);
  await assert.rejects(open(`?ticket=${issueTicket('u1', 'little-red', false)}`), /连不上/, '票据是别的世界的');
  const ws = await open(`?ticket=${issueTicket('u1', 'night-watch', false)}`);
  t.after(() => ws.close());
  const inbox: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  const wait = async (pred: (m: any) => boolean) => { for (let i = 0; i < 100; i++) { const m = inbox.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } throw new Error('没等到'); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  ws.send(JSON.stringify({ t: 'ping', ts: 123, rtt: 180 }));
  assert.equal((await wait((m) => m.t === 'pong')).ts, 123);
  assert.equal(v.rtt, 180, '测得的往返延迟记在化身上（延迟补偿用）');
  ws.send(JSON.stringify({ t: 'mv', x: v.x + 30, y: v.y, pv: 0 }));
  const ack = await wait((m) => m.t === 'ack');
  assert.equal(ack.x, v.x, '太快：回弹到服务器认可的位置');
  ws.send(JSON.stringify({ t: 'act', skill: 'fireball', ax: 1, ay: 0 }));
  assert.match((await wait((m) => m.t === 'err')).reason, /没有这一招/);
  const pm = town.threats.spawn('paper_man', { loc: 'earth_shrine' })!;
  Object.assign(pm, { x: v.x + 1, y: v.y, region: 'town', path: [], state: 'dormant' });
  ws.send(JSON.stringify({ t: 'act', skill: 'strike', ax: 1, ay: 0 }));
  await new Promise((r) => setTimeout(r, 30));
  town.combatTick(); town.combatTick();
  pushChannel(host);
  const cf = await wait((m) => m.t === 'cf');
  assert.ok(cf.u.some((x: [string]) => x[0] === `threat:${pm.id}`), '战斗通道里有纸扎人');
  assert.ok(cf.u.some((x: [string]) => x[0] === `avatar:${v.id}`));
});
