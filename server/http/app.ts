// HTTP 应用（Hono）：静态资源、SSE、世界接口。与监听端口分开，测试可以直接 app.request()。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { config, limits } from '../guard.ts';
import { HttpError, readJson } from './util.ts';
import { worldApi } from './world-api.ts';
import { adminApi } from './admin-api.ts';
import { authApi } from './auth-api.ts';
import { identity } from './identity.ts';
import { withContext } from '../scheduler/context.ts';
import { get as setting } from '../settings/index.ts';
import { Assets, etagMatches } from './assets.ts';

export const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
// 冻结：@hono/node-server 的轻量 Response 会往传入的 headers 对象里写 content-length，
// 共享的对象一旦被写进去，之后所有响应都会带上错误的长度。所以这里永远只拷贝，不直接传
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
});
// AI 插件的前端面板：在 sandbox iframe（没有 allow-same-origin）里运行，CSP 禁止一切网络请求，只能通过 postMessage 与页面通信
const PLUGIN_UI_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

const withHeaders = (res, headers) => { for (const [k, v] of Object.entries(headers)) if (!/^content-length$/i.test(k) && !res.headers.has(k)) res.headers.set(k, v); return res; };

/**
 * 只有一个世界时的适配器（测试用）：所有路径都指向这个 host
 * @param {import('../worlds/host.ts').WorldHost} host
 */
export function singleWorld(host) {
  return {
    defaultId: () => host.id,
    resolve: (c, id) => { if (id && id !== host.id) throw new HttpError(404, '世界不存在'); return host; },
    page: () => ({ ok: true }),
    health: () => ({ day: host.town.day, clients: host.clients.size, idle: !!host.town.idle }),
  };
}

/**
 * @param {object} o
 * @param {object} [o.worlds] 世界解析：{ defaultId(), resolve(c, id) → WorldHost（检查可见性、按需加载）, page(c, id) → { ok } | { status, html }, health() }
 * @param {(c) => import('../worlds/host.ts').WorldHost} [o.hostFor] 旧接口：只有一个世界（等同 worlds: singleWorld(host)）
 * @param {string} o.publicDir 静态资源目录
 * @param {() => object} [o.engineStatus]
 * @param {object} [o.admin] 管理员接口的依赖（见 admin-api.js）
 * @param {import('../accounts/index.ts').Accounts} [o.accounts] 账号（不传时只有本地模式可用）
 * @param {Array<[string, Hono]>} [o.routes] 其他全站接口（大厅、创世……），挂在 /api/<前缀> 下
 * @param {string|null} [o.revision] 部署时写入的 REVISION（git 短哈希，只用于展示）
 */
export function createApp({ worlds = null, hostFor = null, publicDir, engineStatus, admin = {}, accounts = null, routes = [], revision = null }) {
  const PUBLIC = path.resolve(publicDir);
  const app = new Hono();
  // 前端资源版本（重构方案 §7）：内容哈希、HTML 改写与 import map、构建号
  const assets = new Assets(PUBLIC, { enabled: () => setting('ASSET_VERSIONING'), revision });
  if (!worlds) {
    worlds = {
      defaultId: () => null,
      resolve: (c, id) => { const h = hostFor(c); if (id && id !== h.id) throw new HttpError(404, '世界不存在'); return h; },
      page: () => ({ ok: true }),
      health: () => { const h = hostFor(); return { day: h.town.day, clients: h.clients.size, idle: !!h.town.idle }; },
    };
  }

  app.onError((e, c) => {
    if (e instanceof HttpError) {
      const res = c.json({ error: e.message, ...e.extra }, e.status);
      if (e.extra.retryAfter) res.headers.set('Retry-After', String(e.extra.retryAfter));
      return withHeaders(res, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    }
    if (e.code === 'BUDGET') return withHeaders(c.json({ error: '今天小镇的 AI 额度已经用完了，明天再来吧 🌙' }, 429), { ...SECURITY_HEADERS });
    if (e.status) return withHeaders(c.json({ error: e.message, ...(e.errors ? { errors: e.errors } : {}) }, e.status), { ...SECURITY_HEADERS });
    console.warn('[api]', c.req.path, e.message);
    // 不向客户端暴露上游错误细节
    return withHeaders(c.json({ error: '居民们一时没反应过来，请稍后再试' }, 502), { ...SECURITY_HEADERS });
  });

  // 所有响应带上构建号：已打开的旧页面调用接口时就能发现前端已经更新（§7.4）
  app.use('*', async (c, next) => {
    c.set('build', assets.build);
    await next();
    try { c.res.headers.set('X-Build', assets.build); } catch { /* 不可改的响应头 */ }
  });

  // 配置了人机验证时，页面的 CSP 放行 Turnstile 的脚本与 iframe（没配置时保持最严格的 CSP）。
  // 在页面当前的 CSP 上改（HTML 里注入的 import map 带着自己的哈希）
  app.use('*', async (c, next) => {
    await next();
    if (setting('CAPTCHA_SITEKEY') && /text\/html/.test(c.res.headers.get('content-type') || '')) {
      const csp = c.res.headers.get('Content-Security-Policy') || SECURITY_HEADERS['Content-Security-Policy'];
      c.res.headers.set('Content-Security-Policy', csp.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com").replace("frame-ancestors", "frame-src https://challenges.cloudflare.com; frame-ancestors").replace("connect-src 'self'", "connect-src 'self' https://challenges.cloudflare.com"));
    }
  });

  app.get('/healthz', (c) => c.json({ ok: true, build: assets.build, revision: assets.revision, ...worlds.health() }));

  // ---------- 接口：身份、兜底限流、JSON 请求体（全站接口与世界接口共用）----------
  const apiPrefixes = ['/api/*', '/w/:world/api/*'];
  for (const p of apiPrefixes) {
    app.use(p, async (c, next) => {
      await next();
      withHeaders(c.res, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    });
    app.use(p, identity({ accounts }));
    app.use(p, async (c, next) => {
      const r = limits.api.check(c.get('ip'));
      if (!r.ok) throw new HttpError(429, '请求太频繁了', { retryAfter: r.retryAfter });
      // 原文上传是 text/plain 的流，由创世接口自己读（有自己的大小上限）；其余写接口一律 JSON、≤8KB
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
        if (!c.req.path.endsWith('/api/genesis/source')) c.set('body', await readJson(c.req));
      } else if (!['GET', 'HEAD', 'DELETE'].includes(c.req.method)) throw new HttpError(405, '不支持的方法');
      await next();
    });
  }
  // 构建号（页面定时比对；世界页面用相对路径 api/build，所以两种前缀都有）
  for (const p of ['/api/build', '/w/:world/api/build']) app.get(p, (c) => c.json({ build: assets.build, revision: assets.revision }));
  app.route('/api/auth', authApi({ accounts }));
  app.route('/api/admin', adminApi({ ...admin, accounts }));
  for (const [prefix, sub] of routes) app.route(`/api/${prefix}`, sub);

  // ---------- 世界接口：/api/w/:world/*（设计里的路径）、/w/:world/api/*（世界页面的相对路径）、/api/*（旧路径 → 默认世界）----------
  const wapi = worldApi({ engineStatus, openStream, accounts });
  const bind = (getId) => async (c, next) => {
    const host = worlds.resolve(c, getId(c));
    c.set('host', host);
    await withContext({ worldId: host.id, userId: c.get('user')?.id || null }, () => next());
  };
  app.use('/api/w/:world/*', bind((c) => c.req.param('world')));
  app.route('/api/w/:world', wapi);
  app.use('/w/:world/api/*', bind((c) => c.req.param('world')));
  app.route('/w/:world/api', wapi);
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/w/')) return next();
    return bind(() => worlds.defaultId())(c, next);
  });
  app.route('/api', wapi);
  const notFound = (c) => { throw new HttpError(['GET', 'POST'].includes(c.req.method) ? 404 : 405, ['GET', 'POST'].includes(c.req.method) ? '不存在' : '不支持的方法'); };
  app.all('/api/*', notFound);
  app.all('/w/:world/api/*', notFound);

  // ---------- AI 插件面板 ----------
  const bridge = () => (setting('ASSET_VERSIONING') ? assets.hash('js/plugin-bridge.js') : null);
  app.get('/plugin-ui/*', (c) => servePluginUi(c, worlds.resolve(c, worlds.defaultId()), c.req.path, bridge()));
  app.get('/w/:world/plugin-ui/*', (c) => servePluginUi(c, worlds.resolve(c, c.req.param('world')), c.req.path.replace(/^\/w\/[^/]+/, ''), bridge()));

  // ---------- 页面：/ 大厅，/w/:world/ 世界页面（与原来的单世界页面相同，资源用相对路径）----------
  app.get('/w/:world', (c) => c.redirect(`${c.req.path}/`, 301));
  app.get('/w/:world/', identity({ accounts }), async (c) => {
    const p = await worlds.page(c, c.req.param('world'));
    if (!p.ok) return new Response(p.html, { status: p.status, headers: { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
    return serveStatic(c, PUBLIC, '/index.html', assets);
  });
  app.all('/w/:world/*', (c) => {
    let rel;
    try { rel = decodeURIComponent(c.req.path).replace(/^\/w\/[^/]+/, ''); } catch { return c.json({ error: 'bad path' }, 400); }
    return serveStatic(c, PUBLIC, rel, assets);
  });
  app.get('/', (c) => serveStatic(c, PUBLIC, worlds.lobby ? '/lobby.html' : '/index.html', assets));
  app.all('*', (c) => serveStatic(c, PUBLIC, null, assets));
  return app;
}

/**
 * SSE：只推送这个世界的事件。
 * 背压（重构方案 §6.1）：流由 pull() 驱动，只有底层连接能写时才取数据。
 *   tick   每位观众只留最新的一帧，发不出去的旧帧直接丢弃
 *   其他   进队列；队列积压超过 SSE_MAX_BUFFER_KB 时断开这个连接（页面会自动重连并重新拿 init）
 */
export function openStream(c, host) {
  const ip = c.get('ip');
  let total = 0;
  for (const _ of host.clients) total++;
  if (total >= config.maxClients) throw new HttpError(503, '小镇访客太多了，请稍后再来');
  if (host.viewersFrom(ip) >= config.maxClientsPerIp) throw new HttpError(429, '同时打开的页面太多了');
  const client = sseClient(ip, () => cleanup());
  let leave = null, ka = null;
  const stream = new ReadableStream({
    start() {
      client.write('retry: 3000\n\n');
      client.write(`event: init\ndata: ${JSON.stringify({ ...host.town.initPayload(), build: c.get('build') || null })}\n\n`);
      leave = host.join(client);
      ka = setInterval(() => client.write(': ka\n\n'), 15000);
    },
    pull: (ctrl) => client.pull(ctrl),
    cancel() { cleanup(); client.close({ drop: true }); },
  }, { highWaterMark: 0 });
  function cleanup() {
    clearInterval(ka);
    leave?.();
    leave = null;
  }
  c.req.raw.signal?.addEventListener?.('abort', () => { cleanup(); client.close({ drop: true }); });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS } });
}

const sseEnc = new TextEncoder();

/**
 * 一位 SSE 观众的发送缓冲。broadcast 调 push(event, bytes)（所有观众共用同一份字节）；write(text) 用于单独发给这一位的消息。
 * pull(ctrl) 在底层可写时被流调用：把排队的消息与最新一帧 tick 合成一块交出去；没有数据时等到有为止。
 * @param {string} ip
 * @param {() => void} onClose 连接被关闭（积压超限）时的清理
 */
export function sseClient(ip, onClose = () => {}) {
  let queue = [], queued = 0, tick = null;
  let wake = null, ctrl = null, overflow = false;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const client = {
    ip,
    closed: false,
    /** 当前积压的字节数（队列 + 未发出的 tick） */
    get backlog() { return queued + (tick?.length || 0); },
    push(event, bytes) {
      if (client.closed) return;
      if (event === 'tick') { tick = bytes; return notify(); }
      if (event === 'init') tick = null; // 新的 init 之后，旧 Town 的快照不再有意义
      queue.push(bytes);
      queued += bytes.length;
      // 单条消息（例如很大的 init）本身可以超过上限；排着两条以上还超限，说明这位观众已经收不动了
      if (queue.length > 1 && queued > setting('SSE_MAX_BUFFER_KB') * 1024) { overflow = true; return client.close({ drop: true }); }
      notify();
    },
    write(s) { client.push(/^event: init\n/.test(s) ? 'init' : 'msg', sseEnc.encode(s)); },
    /** 关闭：默认先把已排队的消息（例如 closed 事件）发完再断开；drop 时立即丢弃 */
    close({ drop = false } = {}) {
      if (client.closed) return;
      client.closed = true;
      tick = null;
      if (drop || !queue.length) { queue = []; queued = 0; try { ctrl?.close(); } catch { /* 已关闭 */ } }
      notify();
      onClose();
    },
    get overflowed() { return overflow; },
    async pull(c) {
      ctrl = c;
      while (!client.closed && !queue.length && !tick) await new Promise((r) => { wake = r; });
      if (!queue.length && !tick) { try { c.close(); } catch { /* 已关闭 */ } return; }
      const parts = tick ? [...queue, tick] : queue;
      queue = []; queued = 0; tick = null;
      let out = parts[0];
      if (parts.length > 1) {
        out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
      }
      c.enqueue(out);
    },
  };
  return client;
}

function servePluginUi(c, host, p, bridgeHash = null) {
  const m = /^\/plugin-ui\/([a-z][a-z0-9-]{2,31})\/(ui\.js|boot\.js)?$/.exec(p);
  const [, id, f] = m || [];
  const file = m && host.town.evolved.uiFile(id);
  const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': PLUGIN_UI_CSP, 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store' };
  if (!file) return new Response('not found', { status: 404, headers });
  // 面板以模块方式加载（iframe 是 opaque origin，模块请求走 CORS）；ui.js 可以是普通脚本，也可以 export default 一个初始化函数
  const js = { ...headers, 'Content-Type': MIME['.js'], 'Access-Control-Allow-Origin': '*' };
  if (f === 'ui.js') return new Response(fs.readFileSync(file), { headers: js });
  if (f === 'boot.js') return new Response("import * as ui from './ui.js';\nif (typeof ui.default === 'function') ui.default();\n", { headers: js });
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.6 system-ui,sans-serif;margin:10px;color:#3a3226;background:#fffaf0}button{font:inherit;cursor:pointer}</style></head><body><div id="app"></div><script src="../../js/plugin-bridge.js${bridgeHash ? `?v=${bridgeHash}` : ''}"></script><script type="module" src="boot.js"></script></body></html>`, { headers: { ...headers, 'Content-Type': MIME['.html'] } });
}

/**
 * 静态文件：禁止路径穿越与点开头的文件。
 * 有 assets（资源清单）时按 §7.3 给缓存头：HTML 改写后 no-cache + 强 ETag；带正确 ?v= 的资源 immutable；其余 no-cache + 内容哈希 ETag。
 * 没有 assets 或 ASSET_VERSIONING 关闭时：全部 no-cache。
 */
export function serveStatic(c, root, rel = null, assets = null) {
  const notFound = () => new Response('not found', { status: 404, headers: { ...SECURITY_HEADERS } });
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return withHeaders(c.json({ error: '不支持的方法' }, 405), { ...SECURITY_HEADERS });
  if (rel == null) {
    try { rel = decodeURIComponent(c.req.path); } catch { return c.json({ error: 'bad path' }, 400); }
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || rel.split('/').some((seg) => seg.startsWith('.'))) return notFound();
  let st;
  try { st = fs.statSync(file); } catch { return notFound(); }
  if (!st.isFile()) return notFound();
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const on = Boolean(assets && assets.enabled());
  const relPosix = path.relative(root, file).split(path.sep).join('/');
  const inm = c.req.header('if-none-match');

  // HTML：改写入口 URL、注入构建号与 import map；CSP 放行注入的 import map（按内容哈希）
  if (on && path.extname(file) === '.html') {
    const p = assets.page(relPosix, c.req.path);
    if (p) {
      const csp = p.csp ? SECURITY_HEADERS['Content-Security-Policy'].replace("script-src 'self'", `script-src 'self' ${p.csp}`) : SECURITY_HEADERS['Content-Security-Policy'];
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: p.etag, ...SECURITY_HEADERS, 'Content-Security-Policy': csp };
      if (etagMatches(inm, p.etag)) return new Response(null, { status: 304, headers });
      return new Response(c.req.method === 'HEAD' ? null : p.body, { status: 200, headers: { ...headers, 'Content-Length': String(p.body.length) } });
    }
  }

  const e = assets?.entry(relPosix);
  const etag = e ? `"${e.hash}"` : `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  // 带 v 且与当前内容一致：内容与 URL 一一对应，永不重新验证；v 不一致（旧页面在请求旧版本）只给当前内容、不许长缓存
  const v = c.req.query('v');
  const cache = on && e && v && v === e.hash ? 'public, max-age=31536000, immutable' : 'no-cache';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, ...SECURITY_HEADERS };
  if (etagMatches(inm, etag)) return new Response(null, { status: 304, headers });
  if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
}
