// 账号（多世界设计 §5）：注册登录、会话、昵称唯一与归一化、停用、改名、授予、重置链接、管理员认领、记忆里的账号引用、公网模式下的接口
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Accounts, installRefs, LOCAL_ID } = await import('../server/accounts/index.js');
const { nicknameKey } = await import('../server/accounts/nickname.js');
const { renderRefs, encodeRefs, GONE } = await import('../server/accounts/refs.js');
const { memoryHooks, addMemory } = await import('../server/memory.ts');
const { _resetQuota } = await import('../server/accounts/quota.js');

const PW = 'correct-horse-9';
const DAY = 86400_000;
function make(now = { t: 1_700_000_000_000 }) {
  return { acc: new Accounts({ file: ':memory:', reservedNames: () => ['林晓雨'], now: () => now.t }), now };
}

test('注册与登录：用户名、密码规则；会话令牌只存哈希；登出与登出所有设备', async () => {
  const { acc } = make();
  await assert.rejects(acc.register({ username: 'ab', nickname: '小满', password: PW }), /用户名/);
  await assert.rejects(acc.register({ username: 'xiaoman', nickname: '小满', password: 'short' }), /至少 10 位/);
  await assert.rejects(acc.register({ username: 'xiaoman', nickname: '小满', password: '1234567890' }), /太常见/);
  await assert.rejects(acc.register({ username: 'xiaoman', nickname: '小满', password: 'xiaoman-password' }), /不能包含用户名/);
  const u = await acc.register({ username: 'xiaoman', nickname: '小满', password: PW });
  assert.equal(u.role, 'user');
  await assert.rejects(acc.register({ username: 'XIAOMAN', nickname: '另一个', password: PW }), /已经被注册/);
  await assert.rejects(acc.login({ username: 'xiaoman', password: 'wrong-password' }), /不对/);
  const { token } = await acc.login({ username: 'xiaoman', password: PW, ip: '1.1.1.1' });
  assert.equal(acc.session(token).user.id, u.id);
  const raw = JSON.stringify(acc.db.prepare('SELECT * FROM sessions').all());
  assert.ok(!raw.includes(token), '数据库里不存明文令牌');
  const t2 = (await acc.login({ username: 'xiaoman', password: PW })).token;
  acc.logout(token);
  assert.equal(acc.session(token), null);
  assert.ok(acc.session(t2));
  acc.createSession(u.id);
  assert.equal(acc.logout(t2, { all: true }), 2);
});

test('会话：30 天滑动过期', async () => {
  const { acc, now } = make();
  const u = await acc.register({ username: 'slide_user', nickname: '滑动', password: PW });
  const tok = acc.createSession(u.id);
  now.t += 20 * DAY;
  assert.equal(acc.session(tok).touched, true, '使用时续期');
  now.t += 20 * DAY;
  assert.ok(acc.session(tok), '续期后 40 天仍然有效');
  now.t += 31 * DAY;
  assert.equal(acc.session(tok), null);
});

test('昵称：全站唯一，NFKC 归一化、忽略大小写与零宽字符；冒充词与居民名字保留', async () => {
  const { acc } = make();
  await acc.register({ username: 'u_ab', nickname: 'Ab', password: PW });
  assert.equal(nicknameKey('Ａｂ'), nicknameKey('ab'));
  await assert.rejects(acc.register({ username: 'u_ab2', nickname: 'ＡＢ', password: PW }), /已经有人用了/);
  await assert.rejects(acc.register({ username: 'u_ab3', nickname: `a​b`, password: PW }), /已经有人用了/);
  await assert.rejects(acc.register({ username: 'u_ab4', nickname: '官方小助手', password: PW }), /官方/);
  await assert.rejects(acc.register({ username: 'u_ab5', nickname: '林晓雨', password: PW }), /居民的名字/);
  await assert.rejects(acc.register({ username: 'u_ab6', nickname: '九个字的昵称太长啦', password: PW }), /最多 8 个字/);
});

test('停用账号：会话立即失效，不能登录；改名：30 天一次，旧昵称保留 90 天', async () => {
  const { acc, now } = make();
  const u = await acc.register({ username: 'bad_guy', nickname: '捣蛋', password: PW });
  const tok = acc.createSession(u.id);
  acc.setDisabled(u.id, true, 'admin', '刷屏');
  assert.equal(acc.session(tok), null);
  await assert.rejects(acc.login({ username: 'bad_guy', password: PW }), /停用/);
  acc.setDisabled(u.id, false, 'admin');

  const a = await acc.register({ username: 'renamer', nickname: '阿甲', password: PW });
  acc.rename(a.id, '阿乙');
  assert.equal(acc.get(a.id).nickname, '阿乙');
  assert.throws(() => acc.rename(a.id, '阿丙'), /30 天/);
  await assert.rejects(acc.register({ username: 'copycat', nickname: '阿甲', password: PW }), /刚被人改掉/);
  now.t += 91 * DAY;
  assert.ok(await acc.register({ username: 'copycat', nickname: '阿甲', password: PW }));
});

test('登录失败：按账号和 IP 指数退避', async () => {
  const { acc, now } = make();
  await acc.register({ username: 'target', nickname: '靶子', password: PW });
  for (let i = 0; i < 3; i++) await assert.rejects(acc.login({ username: 'target', password: 'nope-nope-nope', ip: '9.9.9.9' }), /不对/);
  await assert.rejects(acc.login({ username: 'target', password: PW, ip: '8.8.8.8' }), /太多/, '按账号退避');
  await assert.rejects(acc.login({ username: 'other', password: PW, ip: '9.9.9.9' }), /太多/, '按 IP 退避');
  now.t += 5000;
  assert.ok(await acc.login({ username: 'target', password: PW, ip: '8.8.8.8' }));
});

test('授予、重置链接、管理员认领、审计', async () => {
  const { acc, now } = make();
  const u = await acc.register({ username: 'maker', nickname: '造物', password: PW });
  acc.setGrant(u.id, { cap: 'genesis', quota: { maxWorlds: 2 }, expiresAt: now.t + DAY, note: '试点' }, 'admin');
  assert.equal(acc.grant(u.id, 'genesis').quota.maxWorlds, 2);
  now.t += 2 * DAY;
  assert.equal(acc.grant(u.id, 'genesis'), null, '过期的授予不生效');
  acc.setGrant(u.id, { cap: 'genesis' }, 'admin');
  assert.ok(acc.revokeGrant(u.id, 'genesis', 'admin'));

  const tok = acc.createResetToken(u.id, 'admin');
  await assert.rejects(acc.resetPassword(tok, 'short'), /10 位/);
  await acc.resetPassword(tok, 'brand-new-pass-1');
  await assert.rejects(acc.resetPassword(tok, 'brand-new-pass-2'), /无效/, '一次性');
  assert.ok(await acc.login({ username: 'maker', password: 'brand-new-pass-1' }));

  assert.equal(acc.hasSuper(), false);
  acc.claimSuper(u.id);
  assert.equal(acc.get(u.id).role, 'super');
  const v = await acc.register({ username: 'second', nickname: '第二', password: PW });
  assert.throws(() => acc.claimSuper(v.id), /已经有/);
  assert.throws(() => acc.setRole(u.id, 'user', 'x'), /至少要保留/);
  const actions = acc.auditLog().map((x) => x.action);
  for (const a of ['user.register', 'grant.set', 'grant.revoke', 'user.reset-link', 'user.password-reset', 'admin.claim']) assert.ok(actions.includes(a), a);
});

test('记忆里存账号引用：改名后称呼跟着变；停用后显示为「一位离开的旅人」；两个人不会被合并', async () => {
  const { acc } = make();
  installRefs(acc);
  const x = await acc.register({ username: 'xm1', nickname: '小明', password: PW });
  const y = await acc.register({ username: 'xm2', nickname: '小明明', password: PW });
  const agent = { id: 'zhou', memories: [], travellers: { [x.id]: {}, [y.id]: {} } };
  const m = addMemory(agent, { t: 0, text: '旅人「小明」和小明明一起来问路', importance: 3 });
  assert.equal(m.text, `旅人「{@${x.id}}」和{@${y.id}}一起来问路`);
  assert.equal(renderRefs(m.text), '旅人「小明」和小明明一起来问路');
  acc.rename(x.id, '大明');
  assert.equal(renderRefs(m.text), '旅人「大明」和小明明一起来问路');
  acc.setDisabled(y.id, true, 'admin');
  assert.equal(renderRefs(m.text), `旅人「大明」和${GONE}一起来问路`);
  // 单字昵称只替换书名号里的
  assert.equal(encodeRefs('我的名字叫风', [{ id: 'u_a', name: '风' }]), '我的名字叫风');
  assert.equal(encodeRefs('旅人「风」来了', [{ id: 'u_a', name: '风' }]), '旅人「{@u_a}」来了');
  memoryHooks.encode = null;
});

test('本地模式的内置账号：昵称跟随设置', () => {
  const { acc } = make();
  assert.equal(acc.localUser('旅人').nickname, '旅人');
  assert.equal(acc.localUser('阿福').nickname, '阿福');
  assert.equal(acc.get(LOCAL_ID).role, 'super');
  assert.equal(acc.count(), 0, '内置账号不计入用户数');
});

// ---------- 公网模式下的接口 ----------
const { Town } = await import('../server/sim.ts');
const { WorldHost } = await import('../server/worlds/host.js');
const { createApp } = await import('../server/http/app.js');
const { config } = await import('../server/guard.js');
const llm = await import('../server/llm.ts');

function setupPublic(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-acc-'));
  const acc = new Accounts({ file: ':memory:', reservedNames: () => [] });
  installRefs(acc);
  const host = new WorldHost({ id: 'yunxi', makeTown: () => new Town({ dataDir: dir, evolution: { dir: path.join(dir, 'evolution') } }) });
  host.dataRoot = dir;
  const app = createApp({ hostFor: () => host, publicDir: 'public', accounts: acc });
  Object.assign(config, { publicMode: true, adminToken: 'root-token-123' });
  _resetQuota();
  t.after(() => { host.close({ save: false }); Object.assign(config, { publicMode: undefined, adminToken: undefined }); memoryHooks.encode = null; llm.setMock(null); });
  const req = (p, { body, cookie, headers = {}, method } = {}) => app.request(p, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { app, host, acc, req };
}
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('公网模式：游客只能看；注册后以昵称互动；停用立即失效；跨站请求被拒；令牌仍然可用', async (t) => {
  const { host, acc, req } = setupPublic(t);
  const me0 = await (await req('/api/me')).json();
  assert.equal(me0.user, null);
  assert.equal(me0.interaction, false);
  assert.equal(me0.loginToInteract, true);
  const g = await req('/api/chat', { body: { id: 'zhou', text: '你好' } });
  assert.equal(g.status, 401);
  assert.equal((await g.json()).login, true);
  assert.equal((await req('/api/avatar', { body: { name: '冒充' } })).status, 401);
  assert.equal((await req('/api/vote', { body: { id: 'x', option: 'y' } })).status, 401);

  const r = await req('/api/auth/register', { body: { username: 'player1', nickname: '小满', password: PW } });
  assert.equal(r.status, 200, await r.clone().text());
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  const cookie = cookieOf(r);
  const me = await (await req('/api/me', { cookie })).json();
  assert.equal(me.user.nickname, '小满');
  assert.equal(me.interaction, true);

  // 现身：名字就是昵称，无视请求里的名字
  const av = await (await req('/api/avatar', { body: { name: '别的名字', color: '#64b5f6' }, cookie })).json();
  assert.equal(av.avatar.name, '小满');
  // 同一账号第二个标签页：同一个化身
  const av2 = await (await req('/api/avatar', { body: {}, cookie })).json();
  assert.equal(av2.avatar.id, av.avatar.id);

  // 聊天：居民记住的是账号
  llm.setMock(() => JSON.stringify({ reply: '你好呀', emoji: '🙂', thought: '', memory: '小满来问路', importance: 4, newPlan: null }));
  const chat = await req('/api/chat', { body: { id: 'zhou', text: '请问诊所在哪？' }, cookie });
  assert.equal(chat.status, 200, await chat.clone().text());
  const zhou = host.town.byId.zhou;
  const uid = me.user.id;
  assert.ok(zhou.travellers[uid]);
  assert.ok(zhou.memories.some((m) => m.text.includes(`{@${uid}}`)));
  acc.rename(uid, '满满');
  const detail = await (await req('/api/agent/zhou', { cookie })).json();
  assert.ok(detail.memories.some((m) => m.text.includes('满满')), '改名后居民仍然认得这个人');
  assert.ok(detail.relations.some((x) => x.traveller && x.name === '满满'));
  assert.equal(detail.chat.length, 2, '聊天记录跟着账号走');

  // 跨站写请求：Origin 不是本站
  assert.equal((await req('/api/avatar/leave', { body: {}, cookie, headers: { Origin: 'https://evil.example', Host: 'town.example' } })).status, 403);
  assert.equal((await req('/api/avatar/leave', { body: {}, cookie, headers: { Origin: 'http://town.example', Host: 'town.example' } })).status, 200);

  // 停用：会话立即失效
  acc.setDisabled(uid, true, 'admin');
  assert.equal((await (await req('/api/me', { cookie })).json()).user, null);
  assert.equal((await req('/api/chat', { body: { id: 'zhou', text: '还在吗' }, cookie })).status, 401);

  // ADMIN_TOKEN 仍然可以做管理操作，并写审计
  assert.equal((await req('/api/control', { body: { speed: 2 } })).status, 403);
  assert.equal((await req('/api/control', { body: { speed: 2 }, headers: { 'X-Admin-Token': 'root-token-123' } })).status, 200);
  assert.ok(acc.auditLog().some((x) => x.action === 'admin.token'));
});

test('公网模式：注册按 IP 限流、重复昵称被拒、互动额度按账号计', async (t) => {
  const { req } = setupPublic(t);
  const a = await req('/api/auth/register', { body: { username: 'first_one', nickname: '甲', password: PW } });
  assert.equal(a.status, 200);
  const dup = await req('/api/auth/register', { body: { username: 'second_one', nickname: '甲', password: PW } });
  assert.equal(dup.status, 409);
  assert.equal((await req('/api/auth/register', { body: { username: 'third_one', nickname: '丙', password: PW } })).status, 200);
  const over = await req('/api/auth/register', { body: { username: 'fourth_one', nickname: '丁', password: PW } });
  assert.equal(over.status, 429, '每个 IP 每小时 3 个（第 2 次因重名失败也计数）');

  // 聊天突发限制：每分钟 4 句
  const cookie = cookieOf(a);
  llm.setMock(() => JSON.stringify({ reply: '嗯', emoji: '🙂', thought: '', memory: '', importance: 2, newPlan: null }));
  const ids = ['zhou', 'lin', 'chen', 'su', 'zhao'];
  const codes = [];
  for (const id of ids) codes.push((await req('/api/chat', { body: { id, text: '你好' }, cookie })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 429]);
});

test('公网模式：昵称走昵称审核（不是事件审核），普通人名和英文名可以注册', async (t) => {
  const { req } = setupPublic(t);
  const seen = [];
  llm.setMock((messages, opts) => {
    if (/审核/.test(opts.label)) seen.push({ label: opts.label, prompt: messages[1].content });
    return JSON.stringify(/坏名字/.test(messages[1].content) ? { allow: false, reason: '换个友善的名字吧' } : { allow: true, reason: '' });
  });
  assert.equal((await req('/api/auth/register', { body: { username: 'ye_yu', nickname: '叶宇', password: PW } })).status, 200);
  const r = await req('/api/auth/register', { body: { username: 'alice_1', nickname: 'Alice', password: PW } });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.map((x) => x.label), ['昵称审核', '昵称审核']);
  assert.match(seen[0].prompt, /<input>叶宇<\/input>/);
  assert.doesNotMatch(seen[0].prompt, /小镇事件|针对真实人物/, '不能把昵称当成事件来审');

  const bad = await req('/api/auth/nickname', { body: { nickname: '坏名字' }, cookie: cookieOf(r) });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /换个友善的名字/);
});

test('管理员认领与用户管理接口', async (t) => {
  const { req } = setupPublic(t);
  const r = await req('/api/auth/register', { body: { username: 'boss_user', nickname: '镇长', password: PW } });
  const cookie = cookieOf(r);
  assert.equal((await req('/api/admin/users', { cookie })).status, 403);
  assert.equal((await req('/api/auth/claim-admin', { body: { token: 'wrong' }, cookie })).status, 403);
  assert.equal((await req('/api/auth/claim-admin', { body: { token: 'root-token-123' }, cookie })).status, 200);
  const list = await (await req('/api/admin/users', { cookie })).json();
  assert.equal(list.total, 1);
  const id = list.list[0].id;
  const g = await req(`/api/admin/users/${id}/grants`, { body: { cap: 'genesis', quota: { maxWorlds: 3 } }, cookie });
  assert.equal(g.status, 200);
  assert.equal((await (await req('/api/me', { cookie })).json()).grants[0].cap, 'genesis');
  assert.equal((await req(`/api/admin/users/${id}/grants/genesis`, { method: 'DELETE', cookie })).status, 200);
  const link = await (await req(`/api/admin/users/${id}/reset-link`, { body: {}, cookie })).json();
  assert.ok(link.token);
  const audit = await (await req('/api/admin/audit', { cookie })).json();
  assert.ok(audit.some((x) => x.action === 'admin.claim'));
});
