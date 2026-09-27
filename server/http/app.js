// HTTP 应用（Hono）：静态资源、SSE、世界接口。与监听端口分开，测试可以直接 app.request()。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { config, limits } from '../guard.js';
import { HttpError, readJson } from './util.js';
import { worldApi } from './world-api.js';
import { adminApi } from './admin-api.js';
import { authApi } from './auth-api.js';
import { identity } from './identity.js';
import { withContext } from '../scheduler/context.js';

export const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};
// AI 插件的前端面板：在 sandbox iframe（没有 allow-same-origin）里运行，CSP 禁止一切网络请求，只能通过 postMessage 与页面通信
const PLUGIN_UI_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

const withHeaders = (res, headers) => { for (const [k, v] of Object.entries(headers)) if (!res.headers.has(k)) res.headers.set(k, v); return res; };

/**
 * 只有一个世界时的适配器（测试用）：所有路径都指向这个 host
 * @param {import('../worlds/host.js').WorldHost} host
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
 * @param {(c) => import('../worlds/host.js').WorldHost} [o.hostFor] 旧接口：只有一个世界（等同 worlds: singleWorld(host)）
 * @param {string} o.publicDir 静态资源目录
 * @param {() => object} [o.engineStatus]
 * @param {object} [o.admin] 管理员接口的依赖（见 admin-api.js）
 * @param {import('../accounts/index.js').Accounts} [o.accounts] 账号（不传时只有本地模式可用）
 * @param {Array<[string, Hono]>} [o.routes] 其他全站接口（大厅、创世……），挂在 /api/<前缀> 下
 */
export function createApp({ worlds = null, hostFor = null, publicDir, engineStatus, admin = {}, accounts = null, routes = [] }) {
  const PUBLIC = path.resolve(publicDir);
  const app = new Hono();
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
    if (e.code === 'BUDGET') return withHeaders(c.json({ error: '今天小镇的 AI 额度已经用完了，明天再来吧 🌙' }, 429), SECURITY_HEADERS);
    if (e.status) return withHeaders(c.json({ error: e.message, ...(e.errors ? { errors: e.errors } : {}) }, e.status), SECURITY_HEADERS);
    console.warn('[api]', c.req.path, e.message);
    // 不向客户端暴露上游错误细节
    return withHeaders(c.json({ error: '居民们一时没反应过来，请稍后再试' }, 502), SECURITY_HEADERS);
  });

  app.get('/healthz', (c) => c.json({ ok: true, ...worlds.health() }));

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
      if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) c.set('body', await readJson(c.req));
      else if (!['GET', 'HEAD', 'DELETE'].includes(c.req.method)) throw new HttpError(405, '不支持的方法');
      await next();
    });
  }
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
  app.get('/plugin-ui/*', (c) => servePluginUi(c, worlds.resolve(c, worlds.defaultId()), c.req.path));
  app.get('/w/:world/plugin-ui/*', (c) => servePluginUi(c, worlds.resolve(c, c.req.param('world')), c.req.path.replace(/^\/w\/[^/]+/, '')));

  // ---------- 页面：/ 大厅，/w/:world/ 世界页面（与原来的单世界页面相同，资源用相对路径）----------
  app.get('/w/:world', (c) => c.redirect(`${c.req.path}/`, 301));
  app.get('/w/:world/', identity({ accounts }), async (c) => {
    const p = await worlds.page(c, c.req.param('world'));
    if (!p.ok) return new Response(p.html, { status: p.status, headers: { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS } });
    return serveStatic(c, PUBLIC, '/index.html');
  });
  app.all('/w/:world/*', (c) => {
    let rel;
    try { rel = decodeURIComponent(c.req.path).replace(/^\/w\/[^/]+/, ''); } catch { return c.json({ error: 'bad path' }, 400); }
    return serveStatic(c, PUBLIC, rel);
  });
  app.get('/', (c) => serveStatic(c, PUBLIC, worlds.lobby ? '/lobby.html' : '/index.html'));
  app.all('*', (c) => serveStatic(c, PUBLIC));
  return app;
}

/** SSE：只推送这个世界的事件 */
export function openStream(c, host) {
  const ip = c.get('ip');
  let total = 0;
  for (const _ of host.clients) total++;
  if (total >= config.maxClients) throw new HttpError(503, '小镇访客太多了，请稍后再来');
  if (host.viewersFrom(ip) >= config.maxClientsPerIp) throw new HttpError(429, '同时打开的页面太多了');
  const enc = new TextEncoder();
  let leave = null, ka = null;
  const stream = new ReadableStream({
    start(ctrl) {
      const client = {
        ip,
        write: (s) => { try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); } },
        close: () => { try { ctrl.close(); } catch { /* 已关闭 */ } cleanup(); },
      };
      client.write('retry: 3000\n\n');
      client.write(`event: init\ndata: ${JSON.stringify(host.town.initPayload())}\n\n`);
      leave = host.join(client);
      ka = setInterval(() => client.write(': ka\n\n'), 15000);
    },
    cancel() { cleanup(); },
  });
  function cleanup() {
    clearInterval(ka);
    leave?.();
    leave = null;
  }
  c.req.raw.signal?.addEventListener?.('abort', cleanup);
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS } });
}

function servePluginUi(c, host, p) {
  const m = /^\/plugin-ui\/([a-z][a-z0-9-]{2,31})\/(ui\.js|boot\.js)?$/.exec(p);
  const [, id, f] = m || [];
  const file = m && host.town.evolved.uiFile(id);
  const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': PLUGIN_UI_CSP, 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store' };
  if (!file) return new Response('not found', { status: 404, headers });
  // 面板以模块方式加载（iframe 是 opaque origin，模块请求走 CORS）；ui.js 可以是普通脚本，也可以 export default 一个初始化函数
  const js = { ...headers, 'Content-Type': MIME['.js'], 'Access-Control-Allow-Origin': '*' };
  if (f === 'ui.js') return new Response(fs.readFileSync(file), { headers: js });
  if (f === 'boot.js') return new Response("import * as ui from './ui.js';\nif (typeof ui.default === 'function') ui.default();\n", { headers: js });
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.6 system-ui,sans-serif;margin:10px;color:#3a3226;background:#fffaf0}button{font:inherit;cursor:pointer}</style></head><body><div id="app"></div><script src="../../js/plugin-bridge.js"></script><script type="module" src="boot.js"></script></body></html>`, { headers: { ...headers, 'Content-Type': MIME['.html'] } });
}

/** 静态文件：禁止路径穿越与点开头的文件；弱 ETag + no-cache */
export function serveStatic(c, root, rel = null) {
  const notFound = () => new Response('not found', { status: 404, headers: SECURITY_HEADERS });
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return withHeaders(c.json({ error: '不支持的方法' }, 405), SECURITY_HEADERS);
  if (rel == null) {
    try { rel = decodeURIComponent(c.req.path); } catch { return c.json({ error: 'bad path' }, 400); }
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || rel.split('/').some((seg) => seg.startsWith('.'))) return notFound();
  let st;
  try { st = fs.statSync(file); } catch { return notFound(); }
  if (!st.isFile()) return notFound();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, ...SECURITY_HEADERS };
  if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
  if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
}
