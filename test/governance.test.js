// 上架与治理（多世界设计 §8、§10、M7）：发布时的自动审核、暂停 / 恢复 / 归档、举报转为不公开、管理员下架与恢复、
// 运行时抽样审核、owner 终审（别人不能终审，管理员可以否决）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const settings = await import('../server/settings/index.ts');
const { openDb } = await import('../server/accounts/db.js');
const { Accounts, installRefs } = await import('../server/accounts/index.js');
const { WorldRegistry } = await import('../server/worlds/registry.js');
const { WorldManager } = await import('../server/worlds/manager.js');
const { loadPack, writePack } = await import('../server/worlds/pack.js');
const { publishReview, sampleWorld } = await import('../server/worlds/review.js');
const { Town } = await import('../server/sim.js');
const { activeDir } = await import('../server/timelines.js');
const { createApp } = await import('../server/http/app.js');
const { worldsApi } = await import('../server/http/worlds-api.js');
const { authorize } = await import('../server/accounts/authz.js');
const { config } = await import('../server/guard.js');
const { _resetQuota } = await import('../server/accounts/quota.js');
const llm = await import('../server/llm.ts');
const { memoryHooks } = await import('../server/memory.ts');

const PW = 'correct-horse-9';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-gov-'));
let userSeq = 0;
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

function env(t) {
  const data = tmp();
  const db = openDb(':memory:');
  const acc = new Accounts({ file: ':memory:', db });
  installRefs(acc);
  const reg = new WorldRegistry(db);
  let manager = null;
  reg.onChange = (id) => manager?.onStatus(id);
  manager = new WorldManager({
    data, registry: reg,
    makeTown: (w, root) => new Town({ dataDir: activeDir(root), worldId: w.id, pack: loadPack(path.join(root, 'pack')), instantTalk: true, pacing: false, evolution: { dir: path.join(root, 'evolution'), pluginsDir: path.join(root, 'plugins') } }),
    onWire: (w, t) => { t.votes.requireAdmin = Boolean(w.ownerId); t.proposalSystem.requireAdmin = Boolean(w.ownerId); },
  });
  const app = createApp({
    publicDir: 'public', accounts: acc,
    admin: { manager, registry: reg },
    routes: [['worlds', worldsApi({ registry: reg, manager, accounts: acc })]],
    worlds: {
      defaultId: () => 'x',
      resolve: (c, id) => { const w = reg.get(id); const ok = authorize(c.get('who'), 'world.view', w); if (ok !== true) throw Object.assign(new Error(ok), { status: w?.status === 'suspended' ? 403 : 404 }); return manager.open(id); },
      page: () => ({ ok: true }), health: () => ({}),
    },
  });
  config.publicMode = true;
  config.adminToken = 'root-token-123';
  settings._setForTest({ REPORT_UNLIST_THRESHOLD: 3 });
  _resetQuota();
  t.after(() => { manager.closeAll(); config.publicMode = undefined; config.adminToken = undefined; settings._setForTest({}); memoryHooks.encode = null; llm.setMock(null); });
  const req = (p, { body, cookie, method, admin } = {}) => app.request(p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(admin ? { 'X-Admin-Token': 'root-token-123' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const user = async (name) => {
    const r = await req('/api/auth/register', { body: { username: `player_${++userSeq}`, nickname: name, password: PW } });
    _resetQuota(); // 注册按 IP 限流：测试里同一个 IP 注册很多人
    const j = await r.json();
    return { cookie: cookieOf(r), id: j.user.id };
  };
  /** 用小红帽的世界包做一个用户世界（预览中） */
  const makeWorld = (id, ownerId, patch = {}) => {
    const p = loadPack('worlds/little-red');
    const world = { ...p.world, id, meta: { ...p.world.meta, ...patch } };
    writePack(path.join(data, 'worlds', id, 'pack'), { world, map: p.map, arcs: p.arcs, bible: p.bible });
    reg.create({ id, ownerId, title: world.meta.name, status: 'drafting' });
    reg.setStatus(id, 'preview');
  };
  return { data, acc, reg, manager, req, user, makeWorld };
}

test('发布：自动审核通过即公开；分级超出授予范围时退回预览并附原因；owner 暂停 / 恢复 / 归档', { timeout: 60_000 }, async (t) => {
  const e = env(t);
  const owner = await e.user('造物主');
  const other = await e.user('路人甲');
  e.acc.setGrant(owner.id, { cap: 'genesis', quota: { ratings: ['cozy'] } }, 'admin');
  e.makeWorld('red-riding', owner.id);
  assert.equal((await e.req('/api/worlds/red-riding/publish', { body: {}, cookie: other.cookie })).status, 403, '别人不能发布');
  const bad = await e.req('/api/worlds/red-riding/publish', { body: {}, cookie: owner.cookie });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /分级/);
  assert.equal(e.reg.get('red-riding').status, 'preview');
  assert.match(e.reg.get('red-riding').statusReason, /自动审核没有通过/);

  e.acc.setGrant(owner.id, { cap: 'genesis', quota: { ratings: ['cozy', 'adventure'] } }, 'admin');
  const ok = await e.req('/api/worlds/red-riding/publish', { body: {}, cookie: owner.cookie });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(e.reg.get('red-riding').status, 'public');
  assert.ok((await (await e.req('/api/worlds')).json()).list.some((w) => w.id === 'red-riding'), '出现在大厅');
  assert.equal((await e.req('/api/w/red-riding/me')).status, 200, '游客可以看');
  assert.equal((await e.req('/api/worlds/red-riding/draft', { method: 'PATCH', body: { title: '改名' }, cookie: owner.cookie })).status, 409, '发布后不能改世界包');

  assert.equal((await e.req('/api/worlds/red-riding/pause', { body: {}, cookie: owner.cookie })).status, 200);
  assert.equal(e.manager.open('red-riding').town.paused, true, '暂停的世界不推进时间');
  assert.equal((await e.req('/api/worlds/red-riding/resume', { body: {}, cookie: owner.cookie })).status, 200);
  assert.equal(e.manager.get('red-riding').town.paused, false);
  assert.equal((await e.req('/api/worlds/red-riding/archive', { body: {}, cookie: owner.cookie })).status, 200);
  assert.equal(e.manager.get('red-riding'), null);
  assert.equal((await e.req('/api/w/red-riding/me')).status, 404);
});

test('自动审核的其他步骤：文本关键词、试跑', { timeout: 60_000 }, async () => {
  const dir = tmp();
  const p = loadPack('worlds/little-red');
  writePack(dir, { world: { ...p.world, lore: { ...p.world.lore, summary: '这个世界里到处都是色情内容' } }, map: p.map, arcs: p.arcs });
  const r = await publishReview({ packDir: dir, allowedRatings: null });
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /关键词/);
  const good = tmp();
  writePack(good, { world: p.world, map: p.map, arcs: p.arcs });
  const g = await publishReview({ packDir: good, allowedRatings: null, shadow: async () => ({ ok: true, stuckRate: 0.8 }) });
  assert.equal(g.ok, false);
  assert.match(g.reasons[0], /卡住/);
});

test('举报：不同的人举报达到阈值自动转为不公开；管理员下架立即停止运行、在线观众收到通知；只有管理员能恢复', { timeout: 60_000 }, async (t) => {
  const e = env(t);
  const owner = await e.user('造物主');
  e.makeWorld('red-riding', owner.id);
  e.reg.setStatus('red-riding', 'public');
  assert.equal((await e.req('/api/worlds/red-riding/report', { body: { reason: '不合适' } })).status, 401, '游客不能举报');
  const reporters = [];
  for (const n of ['甲', '乙', '丙']) reporters.push(await e.user(`举报人${n}`));
  await e.req('/api/worlds/red-riding/report', { body: { reason: '不合适' }, cookie: reporters[0].cookie });
  await e.req('/api/worlds/red-riding/report', { body: { reason: '重复举报' }, cookie: reporters[0].cookie });
  await e.req('/api/worlds/red-riding/report', { body: { reason: '不合适' }, cookie: reporters[1].cookie });
  assert.equal(e.reg.get('red-riding').status, 'public', '同一个人重复举报只算一次');
  await e.req('/api/worlds/red-riding/report', { body: { target: 'persona:wolf', reason: '太吓人' }, cookie: reporters[2].cookie });
  assert.equal(e.reg.get('red-riding').status, 'unlisted');
  assert.ok(!(await (await e.req('/api/worlds')).json()).list.some((w) => w.id === 'red-riding'), '不在大厅');
  assert.equal((await e.req('/api/w/red-riding/me')).status, 200, '链接仍然能打开');
  const reports = await (await e.req('/api/admin/reports', { admin: true })).json();
  assert.equal(reports.length, 3, '重复的举报不另存');

  // 下架：在线观众收到通知，世界停止运行
  const host = e.manager.open('red-riding');
  const got = [];
  host.join({ ip: '1', write: (m) => got.push(m) });
  assert.equal((await e.req('/api/admin/worlds/red-riding/suspend', { body: { reason: '冒充官方' }, cookie: owner.cookie })).status, 403);
  assert.equal((await e.req('/api/admin/worlds/red-riding/suspend', { body: { reason: '冒充官方' }, admin: true })).status, 200);
  assert.ok(got.some((m) => m.includes('event: closed') && m.includes('冒充官方')));
  assert.equal(e.manager.get('red-riding'), null);
  assert.equal((await e.req('/api/w/red-riding/me')).status, 403);
  const mine = await (await e.req('/api/worlds/mine', { cookie: owner.cookie })).json();
  assert.equal(mine[0].status, 'suspended', 'owner 在「我的世界」里看到状态');
  assert.match(e.reg.get('red-riding').statusReason, /冒充官方/);
  assert.equal((await e.req('/api/worlds/red-riding/resume', { body: {}, cookie: owner.cookie })).status, 409, 'owner 不能自行恢复');
  assert.equal((await e.req('/api/admin/worlds/red-riding/restore', { body: {}, admin: true })).status, 200);
  assert.equal(e.reg.get('red-riding').status, 'public');
  assert.equal((await (await e.req('/api/admin/reports', { admin: true })).json()).length, 0, '恢复时一并处理了举报');
});

test('owner 终审：自己世界里的决策由 owner 拍板，别人不行；管理员可以撤销', { timeout: 60_000 }, async (t) => {
  const e = env(t);
  const owner = await e.user('造物主');
  const other = await e.user('路人乙');
  e.makeWorld('red-riding', owner.id);
  e.reg.setStatus('red-riding', 'public');
  const town = e.manager.open('red-riding').town;
  // 开一个决策项（AI 插件上线之类的通用决策）
  const d = town.decisions.open({ kind: 'test', ref: 'x', title: '要不要在村口种一棵许愿树', summary: '测试', risk: 'low' });
  const me = await (await e.req('/api/w/red-riding/me', { cookie: owner.cookie })).json();
  assert.equal(me.reviewer, 'owner');
  assert.equal(me.pendingDecisions, 1);
  assert.equal((await (await e.req('/api/w/red-riding/me', { cookie: other.cookie })).json()).reviewer, null);
  assert.equal((await e.req('/api/w/red-riding/decisions/decide', { body: { id: d.id, adopt: true }, cookie: other.cookie })).status, 403);
  const r = await e.req('/api/w/red-riding/decisions/decide', { body: { id: d.id, adopt: true }, cookie: owner.cookie });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(town.decisions.get(d.id).result.by, 'owner');
  // 撤销只有全站管理员
  assert.equal((await e.req('/api/w/red-riding/decisions/undo', { body: { id: d.id }, cookie: owner.cookie })).status, 403);
  // 用户世界的投票与提案需要人终审（owner）
  assert.equal(town.votes.requireAdmin, true);
});

test('运行时抽样审核：命中的编年被隐藏；通过的不动', async () => {
  const town = { spec: { meta: { rating: 'cozy', name: 'x' } }, newspapers: [{ day: 1, headline: '村里来了色情表演' }, { day: 2, headline: '今天天气真好' }], logs: [], emit() {} };
  let r = await sampleWorld(town, { random: () => 0 });
  assert.equal(r.hit, true);
  assert.deepEqual(town.newspapers.map((p) => p.day), [2]);
  r = await sampleWorld(town, { random: () => 0 });
  assert.equal(r.hit, false);
  assert.equal(town.newspapers.length, 1);
});
