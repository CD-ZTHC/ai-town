// 访问用户填写的地址（世界自带的模型服务）：防止服务器替用户访问内网（SSRF，按世界配置模型服务设计 §7.2）。
//   - 只允许 https（allowPrivate 时也允许 http）
//   - 在建立连接时校验解析出的每个 IP（自定义 lookup），防止 DNS 重绑定；IP 字面量直接校验
//   - 不跟随重定向；响应体上限 8 MB
// 返回标准的 Response，可以作为 fetch 注入给 AI SDK 和 OpenAI 兼容实现。
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_BODY = 8 * 1024 * 1024;

// 不允许访问的地址：回环、私有、链路本地（含云厂商元数据地址）、CGNAT、保留、文档、组播、未指定……
const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]]) blocked.addSubnet(a, p, 'ipv6');

/** IPv6 里嵌着的 IPv4（::ffff:a.b.c.d、64:ff9b::a.b.c.d、::a.b.c.d） */
function embeddedV4(ip) {
  const m = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return null;
}

/** 这个 IP 是否不允许访问 */
export function isBlockedAddress(ip) {
  const fam = net.isIP(ip);
  if (!fam) return true;
  if (fam === 4) return blocked.check(ip, 'ipv4');
  const v4 = embeddedV4(ip);
  if (v4) return blocked.check(v4, 'ipv4');
  return blocked.check(ip, 'ipv6');
}

export class AddressError extends Error {
  constructor(msg) { super(msg); this.code = 'ADDRESS'; }
}

/** 地址本身的检查（保存凭据时用；真正的防线在连接时）：返回问题描述或 null */
export function urlProblem(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { return '接口地址不是合法的网址'; }
  if (u.username || u.password) return '接口地址里不能带用户名或密码';
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return allowPrivate ? '接口地址只能是 http 或 https' : '接口地址必须是 https';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isBlockedAddress(host)))) return '不允许访问内网或本机地址';
  return null;
}

function checkedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true, family: options?.family || 0 }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad) return cb(new AddressError(`不允许访问内网地址（${hostname} → ${bad.address}）`));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function bodyOf(b) {
  if (b == null) return null;
  if (typeof b === 'string' || Buffer.isBuffer(b)) return Buffer.from(b);
  if (b instanceof Uint8Array) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  if (b instanceof URLSearchParams) return Buffer.from(b.toString());
  throw new Error('safeFetch 不支持这种请求体');
}

/**
 * @param {{ allowPrivate?: boolean | (() => boolean), maxBody?: number }} [o]
 * @returns {typeof fetch}
 */
export function makeSafeFetch({ allowPrivate = false, maxBody = MAX_BODY } = {}) {
  return async function safeFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const priv = typeof allowPrivate === 'function' ? allowPrivate() : allowPrivate;
    const problem = urlProblem(url.href, { allowPrivate: priv });
    if (problem) throw new AddressError(problem);
    const headers = new Headers(init.headers);
    headers.set('accept-encoding', 'gzip, deflate, br');
    const body = bodyOf(init.body);
    if (body) headers.set('content-length', String(body.length));
    const signal = init.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(url, {
        method: init.method || 'GET', headers: Object.fromEntries(headers), signal,
        ...(priv ? {} : { lookup: checkedLookup }),
      }, (res) => {
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          if (size > maxBody) { req.destroy(new Error(`响应超过 ${Math.round(maxBody / 1048576)} MB`)); return; }
          chunks.push(c);
        });
        stream.on('error', reject);
        stream.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (k === 'content-encoding' || k === 'content-length' || v == null) continue;
            for (const x of [].concat(v)) h.append(k, x);
          }
          const status = res.statusCode || 500;
          const noBody = status === 204 || status === 304 || (init.method || 'GET').toUpperCase() === 'HEAD';
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage || '', headers: h }));
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}
