// 按世界配置模型服务（B3~B6）：世界 → 通道的解析、审核只走服务器、通道隔离、致命错误暂停世界与恢复、
// 计费与自己的上限、语义检索与进化评审、接口（密钥永远不出现在响应里）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const settings = await import('../server/settings/index.ts');
const llm = await import('../server/llm.ts');
const { withContext } = await import('../server/scheduler/context.ts');
const { openDb } = await import('../server/accounts/db.ts');
const { LlmCredentials, SITE } = await import('../server/accounts/llm-credentials.ts');
const { WorldRegistry } = await import('../server/worlds/registry.ts');
const { Ledger, budgetPolicy } = await import('../server/scheduler/budget.ts');
const { parseMasterKey, generateMasterKey } = await import('../server/secrets.ts');
const { createWorldLlm, normalizeAi } = await import('../server/world-llm.ts');
const { createEmbedder, setEmbedResolver } = await import('../server/embeddings.ts');
const { hostCall, setReviewResolver } = await import('../evolution/llm.ts');
const { credentialsApi } = await import('../server/http/llm-api.ts');
const { worldsApi } = await import('../server/http/worlds-api.ts');
const { WorldHost } = await import('../server/worlds/host.ts');
const { _resetQuota } = await import('../server/accounts/quota.ts');

settings._setForTest({ USER_LLM_PRIVATE_NET: true });
const USER_KEY = 'sk-USER-SECRET-a1b2c3d4';

/** 假 provider：mode 决定回复或错误；记录请求 */
function fake(name) {
  const f = {
    name, enabled: true, reqs: [], mode: 'ok',
    async listModels() {
      if (['401', '402'].includes(f.mode)) throw Object.assign(new Error('Invalid API key'), { upstreamStatus: Number(f.mode) });
      return ['m-default', 'm-fast', 'm-smart'];
    },
    async complete(req) {
      f.reqs.push(req);
      const m = typeof f.mode === 'function' ? f.mode(req) : f.mode;
      if (m === '401') throw Object.assign(new Error(`Incorrect API key provided: ${USER_KEY}`), { upstreamStatus: 401 });
      if (m === '402') throw Object.assign(new Error('Insufficient account balance'), { upstreamStatus: 402 });
      if (m === '404') throw Object.assign(new Error(`The model \`${req.model}\` does not exist`), { upstreamStatus: 404 });
      if (m === '429') throw Object.assign(new Error('Rate limit reached'), { upstreamStatus: 429 });
      if (m === 'net') throw new Error('fetch failed');
      if (m === 'nojson' && req.json) throw new Error('response_format is not supported');
      return { content: '{"ok":true}', usage: { prompt: 10, completion: 5 } };
    },
  };
  return f;
}

// ---- 环境：一个服务器 provider，若干世界与凭据 ----
const server = fake('server');
llm.setProvider(server);
const db = openDb(':memory:');
const registry = new WorldRegistry(db);
const credentials = new LlmCredentials(db, { key: parseMasterKey(generateMasterKey()) });
const fakes = new Map();
const halts = [];
const resumes = [];
const audits = [];
let clock = 0; // 世界 LLM 的时钟偏移（判断「持续连不上」用）
const worldLlm = createWorldLlm({
  registry, credentials, audit: (e) => audits.push(e), now: () => Date.now() + clock,
  onHalt: (id, h) => halts.push([id, h.code]), onResume: (id) => resumes.push(id),
  makeProvider: (cred) => fakes.get(cred.id),
});
llm.setProfileResolver(worldLlm.resolve);
llm.onFailure(worldLlm.onFailure);
const ledger = new Ledger(db);
llm.onUsage((e) => ledger.add(e));
const budget = budgetPolicy({ ledger, world: (id) => registry.get(id), ownerGrant: () => null, globalUsed: () => llm.stats.dayTokens, ownLimit: (id) => (worldLlm.isOwn(id) ? normalizeAi(registry.get(id).settings.ai).dailyTokens : null) });
llm.setBudgetPolicy(budget.allow);

function cred(owner, name = 'c') {
  const c = credentials.create({ owner, name, provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: USER_KEY });
  fakes.set(c.id, fake(c.id));
  return { ...c, f: fakes.get(c.id) };
}
function world(id, { owner = 'u1', ai = null, official = false } = {}) {
  registry.create({ id, ownerId: official ? null : owner, title: id, status: 'drafting', official, settings: ai ? { ai } : {} });
  if (!official) { registry.setStatus(id, 'preview'); registry.setStatus(id, 'public'); }
  worldLlm.invalidate(id);
  return id;
}
const own = (credential, extra = {}) => ({ source: 'own', credential, models: { default: 'm-default', smart: 'm-smart' }, concurrency: 2, ...extra });
const ask = (worldId, opts = {}) => withContext({ worldId, userId: 'u9' }, () => llm.chatJSON([{ role: 'user', content: 'x' }], { label: '对话', attempts: 1, ...opts }));

test('解析：世界选了自己的模型服务，世界里的调用都用它；审核永远用服务器；没有世界上下文的用服务器', async () => {
  const a = cred('u1');
  world('own-a', { ai: own(a.id) });
  world('plain');
  const s0 = server.reqs.length;
  assert.deepEqual(await ask('own-a'), { ok: true });
  assert.equal(a.f.reqs.length, 1);
  assert.equal(a.f.reqs[0].model, 'm-default');
  await ask('own-a', { tier: 'smart', label: '叙事导演' });
  assert.equal(a.f.reqs.at(-1).model, 'm-smart');
  await ask('own-a', { label: '与旅人交谈' });
  assert.equal(a.f.reqs.length, 3, '注册用户的对话也用世界的模型');
  assert.equal(server.reqs.length, s0, '服务器一次都没被调用');
  await ask('own-a', { label: '内容审核' });
  assert.equal(server.reqs.length, s0 + 1, '审核走服务器');
  await ask('plain');
  await withContext({}, () => llm.chat([{ role: 'user', content: 'x' }], { label: 'x' }));
  assert.equal(server.reqs.length, s0 + 3);
  assert.equal(a.f.reqs.length, 3);
  assert.equal(withContext({ worldId: 'own-a' }, () => llm.enabled()), true);
});

test('计费：自带的用量记在 own 名下，不占全站预算；审核在自带世界里也记服务器', async () => {
  const a = cred('u1');
  world('bill', { ai: own(a.id) });
  const day = llm.stats.dayTokens;
  await ask('bill');
  assert.equal(llm.stats.dayTokens, day, '全站日预算不变');
  assert.equal(ledger.own('bill').total, 15);
  assert.equal(ledger.world('bill').total, 0);
  await ask('bill', { label: '内容审核' });
  assert.equal(ledger.world('bill').total, 15);
  assert.equal(llm.stats.dayTokens, day + 15);
});

test('引用规则：用户世界只能引用主人的凭据，否则世界暂停', async () => {
  const a = cred('u1');
  world('stolen', { owner: 'u2', ai: own(a.id) });
  await assert.rejects(ask('stolen'), (e) => e.code === 'HALTED');
  assert.equal(registry.get('stolen').settings.ai.halt.code, 'credential');
  assert.equal(a.f.reqs.length, 0, '别人的钥匙一次都没用');
  assert.throws(() => worldLlm.validate(own(a.id), registry.get('stolen')), /自己的模型服务/);
});

test('通道隔离：自带网关不支持 JSON 模式只关自己的；限流只让自己的通道退避', async () => {
  const a = cred('u1');
  world('iso', { ai: own(a.id) });
  a.f.mode = 'nojson';
  await ask('iso');
  const lane = llm.lanesView().find((l) => l.key === `cred:${a.id}`);
  assert.equal(lane.jsonMode, false);
  assert.equal(llm.lanesView().find((l) => l.key === 'server').jsonMode, true, '服务器的 JSON 模式不受影响');
  a.f.mode = 'ok';

  let n = 0;
  a.f.mode = () => (n++ === 0 ? '429' : 'ok');
  const slow = ask('iso', { attempts: 2 }); // 第一次 429，通道冷却约 4 秒后重试成功
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  await ask('plain');
  assert.ok(Date.now() - t0 < 1000, '服务器通道没有被拖慢');
  assert.ok(llm.lanesView().find((l) => l.key === `cred:${a.id}`).cooling > 0);
  assert.equal(llm.lanesView().find((l) => l.key === 'server').cooling, 0);
  assert.deepEqual(await slow, { ok: true });
  assert.equal(halts.filter(([id]) => id === 'iso').length, 0, '限流不暂停世界');
});

test('致命错误：密钥失效暂停用这把钥匙的所有世界，排队任务被拒、不再打上游；修好后自动恢复', async () => {
  const a = cred('u1');
  world('fa1', { ai: own(a.id) });
  world('fa2', { ai: own(a.id, { models: { default: 'm-fast' } }) });
  a.f.mode = '401';
  await assert.rejects(ask('fa1'), /Incorrect API key/);
  assert.equal(a.f.reqs.length, 1, '鉴权失败不重试');
  for (const id of ['fa1', 'fa2']) assert.equal(registry.get(id).settings.ai.halt.code, 'auth');
  assert.deepEqual(halts.filter(([id]) => id.startsWith('fa')).sort(), [['fa1', 'auth'], ['fa2', 'auth']]);
  const c = credentials.get(a.id);
  assert.equal(c.status, 'failing');
  assert.equal(c.failCode, 'auth');
  assert.ok(!c.lastError.includes(USER_KEY), '失败原因里没有密钥原文');
  assert.ok(!JSON.stringify(registry.get('fa1')).includes(USER_KEY));
  await assert.rejects(ask('fa2'), (e) => e.code === 'HALTED');
  assert.equal(a.f.reqs.length, 1, '暂停后不再打上游');
  assert.equal(withContext({ worldId: 'fa1' }, () => llm.enabled()), false);
  assert.match(withContext({ worldId: 'fa1' }, () => llm.blocked()), /密钥无效/);
  assert.ok(audits.some((e) => e.action === 'world.ai-halt' && e.target === 'fa2'));

  a.f.mode = 'ok';
  const r = await worldLlm.checkCredential(a.id);
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['m-default', 'm-fast', 'm-smart']);
  assert.ok(!registry.get('fa1').settings.ai.halt && !registry.get('fa2').settings.ai.halt);
  assert.ok(resumes.includes('fa1') && resumes.includes('fa2'));
  assert.equal(credentials.get(a.id).status, 'ok');
  assert.deepEqual(await ask('fa2'), { ok: true });
});

test('余额不足同样暂停；模型不存在只暂停这个世界', async () => {
  const a = cred('u1');
  world('bal', { ai: own(a.id) });
  a.f.mode = '402';
  await assert.rejects(ask('bal'));
  assert.equal(registry.get('bal').settings.ai.halt.code, 'balance');

  const b = cred('u1');
  world('mod1', { ai: own(b.id, { models: { default: 'no-such-model' } }) });
  world('mod2', { ai: own(b.id) });
  b.f.mode = (req) => (req.model === 'no-such-model' ? '404' : 'ok');
  b.f.listModels = async () => []; // 网关不提供模型列表：没法自动纠正模型名
  const out = []; // 能列出模型时，写错的模型名会被自动纠正成最接近的，不会暂停（见下面的 mod3）
  await assert.rejects(ask('mod1'));
  assert.equal(registry.get('mod1').settings.ai.halt.code, 'model');
  assert.ok(!registry.get('mod2').settings.ai.halt, '同一把钥匙的其他世界不受影响');
  assert.notEqual(credentials.get(b.id).status, 'failing');
  assert.deepEqual(await ask('mod2'), { ok: true });
  // 改好模型名后重试：恢复
  registry.update('mod1', { settings: { ai: { ...registry.get('mod1').settings.ai, models: { default: 'm-default' } } } });
  worldLlm.invalidate('mod1');
  assert.equal((await worldLlm.retryWorld('mod1')).ok, true);
  assert.ok(!registry.get('mod1').settings.ai.halt);
  const c = cred('u1');
  world('mod3', { ai: own(c.id, { models: { default: 'm-defualt' } }) });
  c.f.mode = (req) => (req.model === 'm-defualt' ? '404' : 'ok');
  assert.deepEqual(await ask('mod3'), { ok: true });
  assert.equal(c.f.reqs.at(-1).model, 'm-default', '模型名写错时自动纠正');
  assert.equal(out.length, 0);
});

test('网络错误：偶发的不暂停；连续多次并持续 3 分钟以上才暂停', async () => {
  settings._setForTest({ USER_LLM_PRIVATE_NET: true, USER_LLM_HALT_NET_FAILS: 2 });
  const a = cred('u1');
  world('net', { ai: own(a.id) });
  a.f.mode = 'net';
  await assert.rejects(ask('net'));
  assert.ok(!registry.get('net').settings.ai.halt, '一次网络错误不暂停');
  await assert.rejects(ask('net'));
  assert.ok(!registry.get('net').settings.ai.halt, '次数够了，但持续时间还不到 3 分钟');
  clock = 4 * 60_000;
  await assert.rejects(ask('net'));
  assert.equal(registry.get('net').settings.ai.halt.code, 'net');
  clock = 0;
  a.f.mode = 'ok';
  await worldLlm.probe();
  assert.ok(!registry.get('net').settings.ai.halt, '探测到连通后自动恢复');
  settings._setForTest({ USER_LLM_PRIVATE_NET: true });
});

test('自己设的每日上限：超过后只保留交互，再超 20% 全停；不影响站点额度', async () => {
  const a = cred('u1');
  world('cap', { ai: own(a.id, { dailyTokens: 30 }) });
  await ask('cap');
  await ask('cap');
  assert.equal(ledger.own('cap').total, 30);
  await assert.rejects(ask('cap', { label: '规划一天' }), /上限/);
  assert.deepEqual(await ask('cap', { label: '与旅人交谈' }), { ok: true });
  await assert.rejects(ask('cap', { label: '与旅人交谈' }), /上限/);
  assert.equal(budget.level('cap'), 'exhausted');
  assert.ok(!registry.get('cap').settings.ai.halt, '到上限不是故障，不暂停');
});

test('站点关闭自带模型：用户世界改用服务器；官方世界（站点凭据）不受影响', async () => {
  const a = cred('u1');
  const site = cred(SITE);
  world('off-user', { ai: own(a.id) });
  world('off-official', { official: true, ai: own(site.id) });
  settings._setForTest({ USER_LLM_PRIVATE_NET: true, USER_LLM: false });
  worldLlm.invalidate();
  const s0 = server.reqs.length;
  await ask('off-user');
  assert.equal(server.reqs.length, s0 + 1);
  await ask('off-official');
  assert.equal(site.f.reqs.length, 1);
  assert.throws(() => worldLlm.validate(own(a.id), registry.get('off-user')), /没有开放/);
  settings._setForTest({ USER_LLM_PRIVATE_NET: true });
  worldLlm.invalidate();
  // 官方世界只能引用站点凭据
  assert.throws(() => worldLlm.validate(own(a.id), registry.get('off-official')), /自己的模型服务/);
});

test('语义检索与进化评审：自带时用世界配置的，不借用服务器的', async () => {
  process.env.EMBED_MODEL = 'server-embed';
  process.env.BASE_URL = 'http://server/v1';
  process.env.API_KEY = 'sk-server';
  setEmbedResolver(worldLlm.embedFor);
  setReviewResolver(worldLlm.reviewFor);
  try {
    const a = cred('u1');
    const r = cred('u1', 'review');
    world('emb', { ai: own(a.id) });
    world('emb2', { ai: own(a.id, { embed: { model: 'text-embed' }, review: { credential: r.id, model: 'r-model' } }) });
    assert.equal(createEmbedder({ worldId: 'emb' }).enabled, false, '没配 embedding 就不开，不回落到服务器的');
    const e2 = createEmbedder({ worldId: 'emb2' });
    assert.equal(e2.enabled, true);
    assert.equal(e2.stats.model, 'text-embed');
    assert.equal(createEmbedder({ worldId: 'plain' }).stats.model, 'server-embed', '服务器世界照旧');

    const res = await withContext({ worldId: 'emb2' }, () => hostCall({ role: '评审', messages: [{ role: 'user', content: 'x' }], review: true }));
    assert.deepEqual(res.json, { ok: true });
    assert.equal(r.f.reqs.at(-1).model, 'r-model', '评审用世界配置的评审模型和凭据');
    await withContext({ worldId: 'emb' }, () => hostCall({ role: '评审', messages: [{ role: 'user', content: 'x' }], review: true }));
    assert.equal(a.f.reqs.at(-1).model, 'm-smart', '没配评审模型：用世界的强模型');
  } finally {
    for (const k of ['EMBED_MODEL', 'BASE_URL', 'API_KEY']) delete process.env[k];
    setEmbedResolver(null);
    setReviewResolver(null);
  }
});

test('世界托管：暂停后不推进、有观众也不唤醒；恢复后继续', () => {
  const sent = [];
  const town = { t: 0, idle: false, halted: null, save() {}, stop() {}, start() {}, on() {}, initPayload: () => ({}) };
  const host = new WorldHost({ id: 'h1', makeTown: () => town });
  host.clients.add({ write: (m) => sent.push(m) });
  host.halt({ code: 'auth', text: '暂停了' });
  assert.deepEqual(town.halted, { code: 'auth', text: '暂停了' });
  host.wake();
  assert.ok(town.halted, '有观众也不唤醒');
  host.resume();
  assert.equal(town.halted, null);
  assert.ok(sent.some((m) => m.startsWith('event: halt')) && sent.some((m) => m.startsWith('event: resume')));
});

// ---------- 接口 ----------
function app() {
  const users = { u1: { id: 'u1', role: 'user' }, u2: { id: 'u2', role: 'user' }, nogrant: { id: 'nogrant', role: 'user' }, admin: { id: 'admin', role: 'admin' } };
  const accounts = { grant: (uid) => (['u1', 'u2'].includes(uid) ? { quota: {} } : null), audit: (e) => audits.push(e), get: () => null };
  const manager = { get: () => null, close: () => {}, loaded: new Map() };
  const a = new Hono();
  a.use('*', async (c, next) => {
    const u = users[c.req.header('x-user')] || null;
    c.set('user', u);
    c.set('admin', u?.role === 'admin');
    c.set('who', { user: u, admin: u?.role === 'admin', ip: `ip-${u?.id}` });
    c.set('body', ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.json().catch(() => ({})) : {});
    await next();
  });
  a.route('/api/me/llm-credentials', credentialsApi({ credentials, worldLlm, accounts, scope: 'user' }));
  a.route('/api/admin/llm-credentials', credentialsApi({ credentials, worldLlm, accounts, scope: 'site' }));
  a.route('/api/worlds', worldsApi({ registry, manager, accounts, worldLlm, credentialsFor: (w) => credentials.list(w.official ? SITE : w.ownerId), usage: (id) => ({ server: ledger.world(id), own: ledger.own(id) }) }));
  a.onError((e, c) => c.json({ error: e.message }, e.status || 500));
  const call = async (user, method, url, body) => {
    const res = await a.request(url, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return call;
}

test('接口：凭据的增删改查与测试；只能操作自己的；密钥永远不出现在响应里', async () => {
  _resetQuota();
  db.prepare("DELETE FROM llm_credentials WHERE owner = 'u1'").run(); // 前面的用例建了不少，腾出数量上限
  const call = app();
  const texts = [];
  const rec = (r) => { texts.push(r.text); return r; };
  assert.equal((await call('nogrant', 'GET', '/api/me/llm-credentials')).status, 403, '需要创世授予');
  settings._setForTest({ USER_LLM_PRIVATE_NET: false });
  assert.match((rec(await call('u1', 'POST', '/api/me/llm-credentials', { name: 'x', provider: 'openai', baseUrl: 'https://169.254.169.254/v1', apiKey: 'k' }))).json.error, /内网/);
  assert.match(rec(await call('u1', 'POST', '/api/me/llm-credentials', { name: 'x', provider: 'openai', baseUrl: 'http://gw.example/v1', apiKey: 'k' })).json.error, /https/);
  assert.match(rec(await call('u1', 'POST', '/api/me/llm-credentials', { name: 'x', provider: 'aisdk', baseUrl: 'https://gw.example/v1', apiKey: 'k' })).json.error, /不支持/);
  const created = rec(await call('u1', 'POST', '/api/me/llm-credentials', { name: '我的网关', provider: 'openai', baseUrl: 'https://gw.example/v1/', apiKey: USER_KEY }));
  assert.equal(created.status, 200);
  const id = created.json.credential.id;
  assert.equal(created.json.credential.baseUrl, 'https://gw.example/v1');
  assert.equal(created.json.credential.keyLast4, USER_KEY.slice(-4));
  fakes.set(id, fake(id));
  settings._setForTest({ USER_LLM_PRIVATE_NET: true });
  const list = rec(await call('u1', 'GET', '/api/me/llm-credentials'));
  assert.ok(list.json.list.some((c) => c.id === id));
  assert.ok(!rec(await call('u2', 'GET', '/api/me/llm-credentials')).json.list.some((c) => c.id === id), '看不到别人的');
  assert.equal(rec(await call('u2', 'POST', `/api/me/llm-credentials/${id}/test`)).status, 404, '不能测试别人的');
  const t = rec(await call('u1', 'POST', `/api/me/llm-credentials/${id}/test`));
  assert.equal(t.json.ok, true);
  assert.equal(t.json.credential.status, 'ok');

  // 世界绑定：GET / PUT /api/worlds/:id/ai
  world('api-w', { owner: 'u1' });
  assert.equal((await call('u2', 'GET', '/api/worlds/api-w/ai')).status, 403);
  const put = rec(await call('u1', 'PUT', '/api/worlds/api-w/ai', { source: 'own', credential: id, models: { default: 'm-default' }, concurrency: 99 }));
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.ai.concurrency, settings.get('USER_LLM_MAX_CONCURRENCY'), '并发不超过站点上限');
  const got = rec(await call('u1', 'GET', '/api/worlds/api-w/ai'));
  assert.equal(got.json.credential.id, id);
  assert.ok(got.json.credentials.some((c) => c.id === id));
  assert.deepEqual(await ask('api-w'), { ok: true });

  // 让它失效 → 世界暂停；换密钥（PATCH）后自动测试并恢复
  fakes.get(id).mode = '401';
  await assert.rejects(ask('api-w'));
  assert.ok(registry.get('api-w').settings.ai.halt);
  assert.equal(rec(await call('u1', 'GET', '/api/worlds/api-w/ai')).json.halted, true);
  fakes.get(id).mode = 'ok';
  const patched = rec(await call('u1', 'PATCH', `/api/me/llm-credentials/${id}`, { apiKey: 'sk-NEW-KEY-99990000' }));
  assert.equal(patched.json.test.ok, true);
  assert.ok(!registry.get('api-w').settings.ai.halt, '换了密钥，测试通过，世界恢复');
  texts.push(JSON.stringify(credentials.list('u1')), JSON.stringify(registry.get('api-w')));

  // 删除被引用的凭据：需要确认；确认后世界暂停
  assert.equal(rec(await call('u1', 'DELETE', `/api/me/llm-credentials/${id}`)).status, 409);
  const del = rec(await call('u1', 'DELETE', `/api/me/llm-credentials/${id}?confirm=1`));
  assert.deepEqual(del.json.halted, ['api-w']);
  assert.equal(registry.get('api-w').settings.ai.halt.code, 'credential');

  // 站点凭据只有管理员能管
  assert.equal((await call('u1', 'GET', '/api/admin/llm-credentials')).status, 403);
  const siteRes = rec(await call('admin', 'POST', '/api/admin/llm-credentials', { name: '站点', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: USER_KEY }));
  assert.equal(siteRes.json.credential.owner, SITE, '站点凭据可以用内网地址');

  for (const s of texts) {
    assert.ok(!s.includes(USER_KEY), `响应里出现了密钥：${s.slice(0, 200)}`);
    assert.ok(!s.includes('sk-NEW-KEY-99990000'));
    assert.ok(!s.includes('key_enc'));
  }
  assert.ok(audits.some((e) => e.action === 'llm.credential.create'));
  assert.ok(!JSON.stringify(audits).includes(USER_KEY), '审计里没有密钥');
});

test('接口：测试连接有频率限制', async () => {
  _resetQuota();
  const call = app();
  const c = cred('u1');
  for (let i = 0; i < 3; i++) assert.equal((await call('u1', 'POST', `/api/me/llm-credentials/${c.id}/test`)).status, 200);
  assert.equal((await call('u1', 'POST', `/api/me/llm-credentials/${c.id}/test`)).status, 429);
});

test('官方世界：管理员改的标题不被世界包覆盖；恢复后又用世界包的值；只有管理员能改官方世界', async () => {
  _resetQuota();
  const call = app();
  registry.ensureOfficial('off-pack', { title: '世界包标题', summary: '世界包简介', packHash: 'h1', settings: {} });
  assert.equal((await call('u1', 'PATCH', '/api/worlds/off-pack/settings', { title: '想改' })).status, 403);
  const r = await call('admin', 'PATCH', '/api/worlds/off-pack/settings', { title: '管理员改的标题' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(registry.get('off-pack').settings.overrides, { title: true });
  registry.ensureOfficial('off-pack', { title: '世界包标题', summary: '世界包新简介', packHash: 'h2', settings: {} }); // 模拟重启
  assert.equal(registry.get('off-pack').title, '管理员改的标题');
  assert.equal(registry.get('off-pack').summary, '世界包新简介', '没改过的字段照常跟随世界包');
  await call('admin', 'PATCH', '/api/worlds/off-pack/settings', { resetOverrides: ['title'] });
  registry.ensureOfficial('off-pack', { title: '世界包标题', summary: 'x', packHash: 'h3', settings: {} });
  assert.equal(registry.get('off-pack').title, '世界包标题');
  assert.equal((await call('admin', 'PATCH', '/api/worlds/off-pack/settings', { rating: 'nope' })).status, 400);
});
