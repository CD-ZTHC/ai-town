// 按世界配置模型服务（B2）：主密钥与加解密、凭据表、账本迁移与计费来源、SSRF 防护
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { SETTINGS } = await import('../server/settings/schema.js');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { seal, open, scrub, loadMasterKey, parseMasterKey, generateMasterKey } = await import('../server/secrets.js');
const { openDb } = await import('../server/accounts/db.js');
const { LlmCredentials } = await import('../server/accounts/llm-credentials.js');
const { Ledger } = await import('../server/scheduler/budget.js');
const { isBlockedAddress, urlProblem, makeSafeFetch } = await import('../server/net/safe-fetch.js');

const KEY = parseMasterKey(generateMasterKey());

test('加解密：往返；附加数据绑定行，挪到别的行解不开；主密钥的生成与读取', () => {
  const s = seal(KEY, 'sk-secret-123', 'c_1|u_a');
  assert.equal(open(KEY, s, 'c_1|u_a'), 'sk-secret-123');
  assert.throws(() => open(KEY, s, 'c_2|u_b'));
  assert.throws(() => open(parseMasterKey(generateMasterKey()), s, 'c_1|u_a'));
  assert.notEqual(seal(KEY, 'x', 'a'), seal(KEY, 'x', 'a'), '每次的 iv 不同');
  assert.throws(() => parseMasterKey('too-short'), /32 字节/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  const a = loadMasterKey({ dataDir: dir });
  assert.equal(a.source, 'generated');
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  const b = loadMasterKey({ dataDir: dir });
  assert.equal(b.source, 'file');
  assert.ok(a.key.equals(b.key));
  assert.equal(loadMasterKey({ dataDir: dir, envValue: generateMasterKey() }).source, 'env');
});

test('错误信息脱敏', () => {
  assert.equal(scrub('bad key sk-USERKEY-abcdef123 for you', ['sk-USERKEY-abcdef123']), 'bad key *** for you');
  assert.match(scrub('Incorrect API key provided: sk-proj-abcdefghijk'), /sk-\*\*\*/);
  assert.match(scrub('Authorization: Bearer abcdefghijklmn'), /Bearer \*\*\*/);
  assert.match(scrub('?key=AIzaSyA1234567890abc'), /key=\*\*\*/);
});

test('凭据：只写不读，视图里没有密文；密钥末 4 位；改地址 / 密钥后回到未测试；标记失败时脱敏；换主密钥', () => {
  const db = openDb(':memory:');
  const creds = new LlmCredentials(db, { key: KEY });
  const c = creds.create({ owner: 'u_a', name: '我的网关', provider: 'openai', baseUrl: 'https://gw.example/v1', apiKey: 'sk-live-ABCDEFGH1234' });
  assert.equal(c.keyLast4, '1234');
  assert.equal(c.status, 'unchecked');
  const shown = JSON.stringify([c, creds.list('u_a'), creds.get(c.id)]);
  assert.ok(!shown.includes('sk-live'), '视图里没有密钥');
  assert.ok(!shown.includes(db.prepare('SELECT key_enc FROM llm_credentials').get().key_enc), '视图里没有密文');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM llm_credentials').all()).includes('sk-live'), '数据库里不存明文');
  assert.equal(creds.secret(c.id), 'sk-live-ABCDEFGH1234');
  // 把 A 的密文复制给 B：解不开
  const d = creds.create({ owner: 'u_b', name: 'B', provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-b-00000000' });
  db.prepare('UPDATE llm_credentials SET key_enc = (SELECT key_enc FROM llm_credentials WHERE id = ?) WHERE id = ?').run(c.id, d.id);
  assert.throws(() => creds.secret(d.id));

  const failed = creds.mark(c.id, { status: 'failing', failCode: 'auth', error: 'HTTP 401: Incorrect API key provided: sk-live-ABCDEFGH1234' });
  assert.equal(failed.failCode, 'auth');
  assert.ok(!failed.lastError.includes('ABCDEFGH'), failed.lastError);
  assert.equal(creds.update(c.id, { name: '改个名' }).status, 'failing', '只改名不影响状态');
  const upd = creds.update(c.id, { apiKey: 'sk-new-99998888' });
  assert.equal(upd.status, 'unchecked');
  assert.equal(upd.keyLast4, '8888');
  assert.equal(creds.secret(c.id), 'sk-new-99998888');
  assert.equal(creds.mark(c.id, { status: 'ok', models: ['m1', 'm2'] }).models.length, 2);

  const k2 = parseMasterKey(generateMasterKey());
  assert.throws(() => creds.rotate(k2), '有解不开的行时整体回滚');
  assert.equal(creds.secret(c.id), 'sk-new-99998888', '回滚后仍用旧主密钥');
  creds.remove(d.id);
  assert.equal(creds.rotate(k2), 1);
  assert.equal(new LlmCredentials(db, { key: k2 }).secret(c.id), 'sk-new-99998888');
  assert.throws(() => new LlmCredentials(db, { key: KEY }).secret(c.id));
});

test('迁移：旧库的用量账本搬到带计费来源的新表；自带的用量不占站点额度，也不计入创世额度', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'accounts.db');
  // 造一个 schema 1 的旧库
  const old = openDb(':memory:'); // 只为拿到第 1 版的建表语句
  old.close();
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('schema', '1');
    CREATE TABLE usage (day TEXT NOT NULL, world_id TEXT NOT NULL, user_id TEXT NOT NULL, class TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, world_id, user_id, class));
    INSERT INTO usage VALUES ('2026-09-01', 'w1', 'u1', 'P3', 1234, 3);`);
  raw.close();
  const db = openDb(file);
  assert.deepEqual({ ...db.prepare('SELECT * FROM usage').get() }, { day: '2026-09-01', world_id: 'w1', user_id: 'u1', class: 'P3', billing: 'server', tokens: 1234, calls: 3 });
  const ledger = new Ledger(db);
  ledger.add({ worldId: 'w1', userId: 'u1', cls: 'P1', tokens: 100 });
  ledger.add({ worldId: 'w1', userId: 'u1', cls: 'P1', tokens: 900, billing: 'own' });
  ledger.add({ worldId: 'w1', userId: 'u1', cls: 'P3', tokens: 50, billing: 'own' });
  assert.equal(ledger.world('w1').total, 100, '站点额度只算服务器通道');
  assert.equal(ledger.own('w1').total, 950);
  assert.equal(ledger.userTotal('u1', 'P3'), 1234, '自带的创世用量不计入创世额度');
  assert.equal(ledger.ranking()[0].total, 100);
  const again = new Ledger(db);
  assert.equal(again.own('w1').P1, 900, '重启后从数据库读回');
  assert.ok(ledger.history('w1').some((r) => r.billing === 'own'));
});

test('SSRF：地址表', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(ip), false, ip);
  assert.equal(urlProblem('https://api.example.com/v1'), null);
  assert.match(urlProblem('http://api.example.com/v1'), /https/);
  assert.match(urlProblem('https://localhost:8080/v1'), /内网/);
  assert.match(urlProblem('https://[::1]/v1'), /内网/);
  assert.match(urlProblem('https://169.254.169.254/latest'), /内网/);
  assert.match(urlProblem('https://user:pw@example.com/v1'), /用户名/);
  assert.equal(urlProblem('http://localhost:11434/v1', { allowPrivate: true }), null);
  assert.match(urlProblem('ftp://x/y', { allowPrivate: true }), /http/);
});

test('SSRF：连接时拦截（包括解析到内网的域名）；允许内网时正常转发，响应是标准的 Response', async (t) => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { seen.push({ method: req.method, body: b, auth: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":1}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;
  const strict = makeSafeFetch({ allowPrivate: false });
  await assert.rejects(strict(`http://127.0.0.1:${port}/`), (e) => e.code === 'ADDRESS');
  // 走 DNS 解析的路径：localhost 在地址检查里就被拒；用一个会被解析到 127.0.0.1 的名字检查连接时的 lookup
  const { lookup } = await import('node:dns/promises');
  const hostsName = (await lookup('localhost').catch(() => null)) ? 'localhost' : null;
  if (hostsName) await assert.rejects(strict(`https://${hostsName}:${port}/`), (e) => e.code === 'ADDRESS');
  assert.equal(seen.length, 0, '一个请求都没有发出去');

  const loose = makeSafeFetch({ allowPrivate: () => true });
  const res = await loose(`http://127.0.0.1:${port}/v1/chat`, { method: 'POST', headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.ok(res instanceof Response);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.deepEqual(seen.at(-1), { method: 'POST', body: '{"a":1}', auth: 'Bearer k' });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(loose(`http://127.0.0.1:${port}/`, { signal: ac.signal }));
});

test('SSRF：连接时的 lookup 拒绝解析到内网的地址（防 DNS 重绑定）', async () => {
  const dns = await import('node:dns');
  const orig = dns.default.lookup;
  // 模拟一个公网域名在连接时被解析到内网
  dns.default.lookup = (host, opts, cb) => (host === 'rebind.example' ? cb(null, [{ address: '10.0.0.5', family: 4 }]) : orig(host, opts, cb));
  try {
    const f = makeSafeFetch();
    await assert.rejects(f('https://rebind.example/v1/models'), (e) => e.code === 'ADDRESS' && /10\.0\.0\.5/.test(e.message));
  } finally { dns.default.lookup = orig; }
});
