// HTTP 接口（Hono）：直接 app.request()，不监听端口
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'DATA_DIR', 'STORY_RATING', 'PUBLIC_MODE', 'ADMIN_TOKEN', 'MODS']) delete process.env[k];
const { Town } = await import('../server/sim.js');
const { WorldHost } = await import('../server/worlds/host.js');
const { createApp } = await import('../server/http/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-http-'));

function setup() {
  const dir = tmp();
  const host = new WorldHost({ id: 'yunxi', makeTown: () => new Town({ dataDir: dir, evolution: { dir: path.join(dir, 'evolution') } }) });
  host.dataRoot = dir;
  const app = createApp({ hostFor: () => host, publicDir: 'public' });
  return { app, host, dir };
}
const post = (app, p, body, headers = {}) => app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('接口：身份、世界数据、错误码与安全响应头', async (t) => {
  const { app, host } = setup();
  t.after(() => host.close({ save: false }));
  const me = await app.request('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(me.headers.get('cache-control'), 'no-store');
  const m = await me.json();
  assert.equal(m.admin, true, '本地模式下所有人都是管理员');

  const id = host.town.agents[0].id;
  const d = await app.request(`/api/agent/${id}`);
  assert.equal(d.status, 200);
  assert.equal((await d.json()).id, id);
  assert.equal((await app.request('/api/agent/nobody')).status, 404);
  assert.equal((await app.request('/api/nope')).status, 404);
  assert.equal((await app.request('/api/me', { method: 'PUT' })).status, 405);

  // 写接口只接受 JSON；请求体上限 8KB
  assert.equal((await app.request('/api/control', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post(app, '/api/control', `{"x":"${'a'.repeat(9000)}"}`)).status, 413);
  assert.equal((await post(app, '/api/control', '[1]')).status, 400);
  const r = await post(app, '/api/control', { speed: 4 });
  assert.equal(r.status, 200);
  assert.equal(host.town.speed, 4);
  assert.equal((await post(app, '/api/control', { weather: 'lava' })).status, 400);
});

test('公网模式：没有令牌不能做管理操作', async (t) => {
  const { app, host } = setup();
  t.after(() => host.close({ save: false }));
  const { config } = await import('../server/guard.js');
  const saved = { ...config };
  Object.assign(config, { publicMode: true, adminToken: 'secret-token' });
  t.after(() => Object.assign(config, saved));
  assert.equal((await post(app, '/api/control', { speed: 2 })).status, 403);
  assert.equal((await post(app, '/api/control', { speed: 2 }, { 'X-Admin-Token': 'secret-token' })).status, 200);
  assert.equal((await app.request('/api/snapshots')).status, 403);
});

test('SSE：先推送 init，断开后观众计数归零', async (t) => {
  const { app, host } = setup();
  t.after(() => host.close({ save: false }));
  const ctrl = new AbortController();
  const res = await app.request('/api/stream', { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('event: init')) text += new TextDecoder().decode((await reader.read()).value);
  assert.equal(host.clients.size, 1);
  await reader.cancel();
  assert.equal(host.clients.size, 0);
});

test('静态资源：首页、ETag、禁止路径穿越与点开头的文件', async (t) => {
  const { app, host } = setup();
  t.after(() => host.close({ save: false }));
  const r = await app.request('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await app.request('/', { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await app.request('/js/main.js')).status, 200);
  assert.equal((await app.request('/%2e%2e/package.json')).status, 404);
  assert.equal((await app.request('/.hidden')).status, 404);
  assert.equal((await app.request('/healthz')).status, 200);
});
