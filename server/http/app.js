// HTTP 应用（Hono）：静态资源、SSE、世界接口。与监听端口分开，测试可以直接 app.request()。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { config, clientIp, isAdmin, visitorId, limits } from '../guard.js';
import { HttpError, readJson, nodeLike } from './util.js';
import { worldApi } from './world-api.js';

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
 * @param {object} o
 * @param {(c) => import('../worlds/host.js').WorldHost} o.hostFor 当前请求对应的世界
 * @param {string} o.publicDir 静态资源目录
 * @param {() => object} [o.engineStatus]
 */
export function createApp({ hostFor, publicDir, engineStatus }) {
  const PUBLIC = path.resolve(publicDir);
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof HttpError) {
      const res = c.json({ error: e.message, ...e.extra }, e.status);
      if (e.extra.retryAfter) res.headers.set('Retry-After', String(e.extra.retryAfter));
      return withHeaders(res, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    }
    if (e.code === 'BUDGET') return withHeaders(c.json({ error: '今天小镇的 AI 额度已经用完了，明天再来吧 🌙' }, 429), SECURITY_HEADERS);
    if (e.status) return withHeaders(c.json({ error: e.message }, e.status), SECURITY_HEADERS);
    console.warn('[api]', c.req.path, e.message);
    // 不向客户端暴露上游错误细节
    return withHeaders(c.json({ error: '居民们一时没反应过来，请稍后再试' }, 502), SECURITY_HEADERS);
  });

  app.get('/healthz', (c) => {
    const host = hostFor(c);
    return c.json({ ok: true, day: host.town.day, clients: host.clients.size, idle: !!host.town.idle });
  });

  app.get('/plugin-ui/*', (c) => servePluginUi(c, hostFor(c)));

  // ---------- 接口：身份、兜底限流、JSON 请求体 ----------
  app.use('/api/*', async (c, next) => {
    const req = nodeLike(c);
    const ip = clientIp(req);
    c.set('ip', ip);
    c.set('admin', isAdmin(req));
    c.set('vid', visitorId(req, ip));
    const r = limits.api.check(ip);
    if (!r.ok) throw new HttpError(429, '请求太频繁了', { retryAfter: r.retryAfter });
    if (c.req.method === 'POST') c.set('body', await readJson(c.req));
    else if (c.req.method !== 'GET' && c.req.method !== 'HEAD') throw new HttpError(405, '不支持的方法');
    c.set('host', hostFor(c));
    await next();
    withHeaders(c.res, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  });
  app.route('/api', worldApi({ engineStatus, openStream }));
  app.all('/api/*', () => { throw new HttpError(404, '不存在'); });

  // ---------- 静态资源 ----------
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

function servePluginUi(c, host) {
  const m = /^\/plugin-ui\/([a-z][a-z0-9-]{2,31})\/(ui\.js|boot\.js)?$/.exec(c.req.path);
  const [, id, f] = m || [];
  const file = m && host.town.evolved.uiFile(id);
  const headers = { ...SECURITY_HEADERS, 'Content-Security-Policy': PLUGIN_UI_CSP, 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store' };
  if (!file) return new Response('not found', { status: 404, headers });
  // 面板以模块方式加载（iframe 是 opaque origin，模块请求走 CORS）；ui.js 可以是普通脚本，也可以 export default 一个初始化函数
  const js = { ...headers, 'Content-Type': MIME['.js'], 'Access-Control-Allow-Origin': '*' };
  if (f === 'ui.js') return new Response(fs.readFileSync(file), { headers: js });
  if (f === 'boot.js') return new Response("import * as ui from './ui.js';\nif (typeof ui.default === 'function') ui.default();\n", { headers: js });
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.6 system-ui,sans-serif;margin:10px;color:#3a3226;background:#fffaf0}button{font:inherit;cursor:pointer}</style></head><body><div id="app"></div><script src="/js/plugin-bridge.js"></script><script type="module" src="/plugin-ui/${id}/boot.js"></script></body></html>`, { headers: { ...headers, 'Content-Type': MIME['.html'] } });
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
