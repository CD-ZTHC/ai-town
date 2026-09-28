// 前端资源版本（重构方案 §7）：清单哈希、HTML 改写与 import map、CSP 哈希、缓存头、If-None-Match
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { SETTINGS } = await import('../server/settings/schema.ts');
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const { Assets, rewriteHtml, etagMatches, rootPrefix, cspHash } = await import('../server/http/assets.ts');
const { Town } = await import('../server/sim.ts');
const { WorldHost } = await import('../server/worlds/host.ts');
const { createApp } = await import('../server/http/app.ts');
const settings = await import('../server/settings/index.ts');

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-assets-'));
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
  w('index.html', '<!doctype html><html><head><meta charset="utf-8"><script src="js/boot.js"></script><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://fonts.example/x.css"></head><body><script type="module" src="js/main.js"></script></body></html>');
  w('admin/index.html', '<html><head><link rel="stylesheet" href="../style.css"></head><body><script type="module" src="../js/admin/main.js"></script></body></html>');
  w('style.css', 'body{}');
  w('js/boot.js', '1');
  w('js/main.js', "import './ui.js';");
  w('js/ui.js', 'export {}');
  w('js/admin/main.js', "import '../ui.js';");
  w('.hidden', 'x');
  return { dir, w };
}
const h10 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

test('资源清单：内容哈希；文件改动后重新计算，构建号随之改变', () => {
  const { dir, w } = site();
  const a = new Assets(dir);
  assert.equal(a.hash('js/ui.js'), h10('export {}'));
  assert.equal(a.hash('.hidden'), null, '点开头的文件不在清单里');
  assert.equal(a.hash('js/../../etc/passwd'), null);
  const b1 = a.build;
  w('js/ui.js', 'export const x = 1;');
  fs.utimesSync(path.join(dir, 'js/ui.js'), new Date(), new Date(Date.now() + 5000));
  assert.equal(a.hash('js/ui.js'), h10('export const x = 1;'));
  assert.notEqual(a.build, b1);
  assert.equal(a.hash('js/nope.js'), null);
});

test('HTML 改写：入口带 ?v=，外链不动；注入构建号与 import map；admin 与 /w/<id>/ 的相对路径', () => {
  const { dir } = site();
  const a = new Assets(dir);
  const p = a.page('index.html', '/');
  const html = p.body.toString();
  assert.match(html, new RegExp(`src="js/main.js\\?v=${a.hash('js/main.js')}"`));
  assert.match(html, new RegExp(`src="js/boot.js\\?v=${a.hash('js/boot.js')}"`));
  assert.match(html, new RegExp(`href="style.css\\?v=${a.hash('style.css')}"`));
  assert.match(html, /href="https:\/\/fonts.example\/x.css"/);
  assert.match(html, new RegExp(`<meta name="build" content="${a.build}" data-root="./">`));
  const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(map.imports['./js/ui.js'], `./js/ui.js?v=${a.hash('js/ui.js')}`);
  assert.equal(map.imports['./js/admin/main.js'], `./js/admin/main.js?v=${a.hash('js/admin/main.js')}`);
  assert.equal(p.csp, cspHash(/<script type="importmap">(.*?)<\/script>/.exec(html)[1]), 'CSP 哈希与注入的内容一致');
  // 注入在 </head> 之前（模块脚本之前）
  assert.ok(html.indexOf('importmap') < html.indexOf('</head>'));

  const adm = a.page('admin/index.html', '/admin/').body.toString();
  assert.match(adm, new RegExp(`href="../style.css\\?v=${a.hash('style.css')}"`));
  assert.match(adm, /"\.\.\/js\/ui\.js":"\.\.\/js\/ui\.js\?v=/);
  assert.match(adm, /data-root="\.\.\/"/);
  // 世界页面：同一份 index.html，页面到站点根目录是 ../../
  assert.match(a.page('index.html', '/w/yunxi/').body.toString(), /data-root="\.\.\/\.\.\/"/);
});

test('rewriteHtml / rootPrefix / etagMatches 的边界', () => {
  const r = rewriteHtml('<script src="a.js?x=1"></script><script src="/abs.js"></script><script src="../out.js"></script><script src="a.js"></script>', { resolve: () => 'h', build: 'b' });
  assert.match(r.html, /src="a.js\?x=1"/);
  assert.match(r.html, /src="\/abs.js"/);
  assert.match(r.html, /src="\.\.\/out.js"/);
  assert.match(r.html, /src="a.js\?v=h"/);
  assert.equal(r.inline, null);
  assert.equal(rootPrefix('/'), './');
  assert.equal(rootPrefix('/lobby.html'), './');
  assert.equal(rootPrefix('/admin/'), '../');
  assert.equal(rootPrefix('/w/yunxi/'), '../../');
  assert.ok(etagMatches('"abc"', '"abc"'));
  assert.ok(etagMatches('W/"abc"', '"abc"'));
  assert.ok(etagMatches('"x", "abc-zstd"', '"abc"'), '反代压缩追加的后缀');
  assert.ok(etagMatches('*', '"abc"'));
  assert.ok(!etagMatches('"abd"', '"abc"'));
  assert.ok(!etagMatches('', '"abc"'));
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-assets-app-'));
  const host = new WorldHost({ id: 'yunxi', makeTown: () => new Town({ dataDir: dir }) });
  const app = createApp({ hostFor: () => host, publicDir: 'public', revision: 'abc1234' });
  return { app, host };
}

test('缓存头：HTML no-cache + 强 ETag；v 匹配 immutable，不匹配或缺失 no-cache；304', async (t) => {
  const { app, host } = setup();
  t.after(() => host.close({ save: false }));
  const r = await app.request('/');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const etag = r.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  const html = await r.text();
  const inline = /<script type="importmap">(.*?)<\/script>/.exec(html)[1];
  assert.ok(r.headers.get('content-security-policy').includes(`script-src 'self' ${cspHash(inline)}`));
  const build = /<meta name="build" content="([0-9a-f]+)"/.exec(html)[1];
  assert.equal(r.headers.get('x-build'), build);
  assert.equal((await app.request('/', { headers: { 'If-None-Match': `W/${etag.slice(0, -1)}-zstd"` } })).status, 304);

  const v = /src="js\/main\.js\?v=([0-9a-f]+)"/.exec(html)[1];
  const ok = await app.request(`/js/main.js?v=${v}`);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(ok.headers.get('etag'), `"${v}"`);
  assert.equal((await app.request('/js/main.js?v=0000000000')).headers.get('cache-control'), 'no-cache');
  const plain = await app.request('/js/main.js');
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  assert.equal((await app.request('/js/main.js', { headers: { 'If-None-Match': plain.headers.get('etag') } })).status, 304);
  // 世界页面与构建号接口
  const w = await (await app.request('/w/yunxi/')).text();
  assert.match(w, /data-root="\.\.\/\.\.\/"/);
  assert.deepEqual(await (await app.request('/api/build')).json(), { build, revision: 'abc1234' });
  assert.equal((await (await app.request('/w/yunxi/api/build')).json()).build, build);
  assert.equal((await (await app.request('/healthz')).json()).build, build);
  assert.equal((await app.request('/api/me')).headers.get('x-build'), build);
  // 页面里引用的每个模块都在 import map 里
  const map = JSON.parse(inline).imports;
  for (const f of fs.readdirSync('public/js', { recursive: true })) if (f.endsWith('.js')) assert.ok(map[`./js/${f.split(path.sep).join('/')}`], f);
});

test('ASSET_VERSIONING 关闭：不改写 HTML，全部 no-cache', async (t) => {
  const { app, host } = setup();
  settings._setForTest({ ASSET_VERSIONING: false });
  t.after(() => { settings._setForTest({}); host.close({ save: false }); });
  const html = await (await app.request('/')).text();
  assert.doesNotMatch(html, /importmap|\?v=/);
  const v = crypto.createHash('sha256').update(fs.readFileSync('public/js/main.js')).digest('hex').slice(0, 10);
  assert.equal((await app.request(`/js/main.js?v=${v}`)).headers.get('cache-control'), 'no-cache');
});

test('人机验证的 CSP 放行保留页面自己的 import map 哈希', async (t) => {
  const { app, host } = setup();
  settings._setForTest({ CAPTCHA_SITEKEY: 'site-key' });
  t.after(() => { settings._setForTest({}); host.close({ save: false }); });
  const csp = (await app.request('/')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com 'sha256-/);
});

test('SSE 的 init 带构建号', async (t) => {
  const { app, host } = setup();
  t.after(() => host.close({ save: false }));
  const res = await app.request('/api/stream');
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('event: init')) text += new TextDecoder().decode((await reader.read()).value);
  while (!/event: init\ndata: .*\n\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  const init = JSON.parse(/event: init\ndata: (.*)\n\n/.exec(text)[1]);
  assert.match(init.build, /^[0-9a-f]{10}$/);
  await reader.cancel();
});
