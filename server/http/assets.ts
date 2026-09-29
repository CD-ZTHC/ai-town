// 前端资源版本（重构方案 §7）：不引入构建步骤，由服务端给 public/ 下的文件算内容哈希，
// 返回 HTML 时把入口改写成带 ?v=<哈希> 的 URL，并注入 import map，让模块之间的相对 import 也带上版本。
//   带正确 v 的请求 → immutable 长缓存；v 不对或没有 v → no-cache + 内容哈希 ETag
//   HTML → no-cache + 强 ETag，里面的 <meta name="build"> 告诉页面自己的版本，页面发现版本变了会提示刷新
// 每次取用都先比对文件的 mtime / 大小，变了才重新算哈希：开发时改前端不用重启服务。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha = (buf: string | NodeJS.ArrayBufferView, enc: crypto.BinaryToTextEncoding = 'hex'): string => crypto.createHash('sha256').update(buf).digest(enc);
const HASH_LEN = 10;

/** 服务端注入的内联脚本（import map）需要的 CSP 来源：'sha256-…' */
export const cspHash = (text: string): string => `'sha256-${sha(text, 'base64')}'`;

/** 解析 If-None-Match：逗号分隔的列表；忽略 W/ 前缀与反向代理压缩时追加的后缀（例如 Caddy 的 "…-zstd"） */
export function etagMatches(header: string | null | undefined, etag: string | null | undefined): boolean {
  if (!header || !etag) return false;
  const norm = (s: string): string => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/-(zstd|gzip|br|deflate)$/, '');
  const want = norm(etag);
  return header.split(',').some((t) => t.trim() === '*' || norm(t) === want);
}

/** 请求路径所在目录到站点根目录的相对路径：/ → ./，/admin/ → ../，/w/yunxi/ → ../../ */
export function rootPrefix(reqPath: string | null | undefined): string {
  const depth = String(reqPath || '/').split('/').length - 2;
  return depth > 0 ? '../'.repeat(depth) : './';
}

/** 一个文件的版本 */
export interface AssetEntry { hash: string; size: number; mtimeMs: number }
/** 改写后的 HTML */
export interface AssetPage { src: string; body: Buffer; etag: string; csp: string | null }

export class Assets {
  declare root: string;
  declare enabled: () => boolean;
  declare revision: string | null;
  /** 相对路径（posix）→ 版本 */
  declare files: Map<string, AssetEntry>;
  declare pages: Map<string, AssetPage>;
  declare _build: string | null;
  /**
   * root：public 目录（绝对路径）；enabled：ASSET_VERSIONING 开关（关闭时不改写 HTML、不给长缓存）；
   * revision：部署时写入的 REVISION（只用于展示）
   */
  constructor(root: string, { enabled = () => true, revision = null }: { enabled?: () => boolean; revision?: string | null } = {}) {
    this.root = path.resolve(root);
    this.enabled = enabled;
    this.revision = revision;
    this.files = new Map();
    this.pages = new Map(); // 改写后的 HTML 缓存：`${rel}|${prefix}|${build}` → { body, etag, csp }
    this._build = null;
    this.scan();
  }

  /** 遍历 public/（跳过点开头的文件），补上新增的、去掉删除的 */
  scan(): void {
    const seen = new Set<string>();
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) walk(abs);
        else if (d.isFile()) { const rel = path.relative(this.root, abs).split(path.sep).join('/'); seen.add(rel); this.entry(rel); }
      }
    };
    walk(this.root);
    for (const rel of this.files.keys()) if (!seen.has(rel)) { this.files.delete(rel); this._build = null; }
  }

  /** 某个文件的版本；文件不存在返回 null。mtime 或大小变了就重新计算 */
  entry(rel: string): AssetEntry | null {
    rel = String(rel).replace(/^\/+/, '');
    if (rel.split('/').some((seg) => seg.startsWith('.') || !seg)) return null; // 点开头的文件、路径穿越
    let st;
    try { st = fs.statSync(path.join(this.root, rel)); } catch { if (this.files.delete(rel)) this._build = null; return null; }
    if (!st.isFile()) return null;
    const cur = this.files.get(rel);
    if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) return cur;
    const e = { hash: sha(fs.readFileSync(path.join(this.root, rel))).slice(0, HASH_LEN), size: st.size, mtimeMs: st.mtimeMs };
    if (cur?.hash !== e.hash) this._build = null;
    this.files.set(rel, e);
    return e;
  }

  hash(rel: string): string | null { return this.entry(rel)?.hash || null; }

  /** 构建号：前端所有文件内容的整体哈希（只有前端真的变了，已打开的页面才需要刷新） */
  get build(): string {
    if (!this._build) this._build = sha([...this.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v.hash}`).join('\n')).slice(0, HASH_LEN);
    return this._build;
  }

  /** import map：public/js/ 下所有模块。prefix 是 HTML 所在目录到 public/ 的相对路径（'./' 或 '../'） */
  importMap(prefix: string): string {
    const imports: Record<string, string> = {};
    for (const [rel, e] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (rel.startsWith('js/') && rel.endsWith('.js')) imports[`${prefix}${rel}`] = `${prefix}${rel}?v=${e.hash}`;
    }
    return JSON.stringify({ imports });
  }

  /**
   * 改写后的 HTML：入口加 ?v=，注入构建号与 import map。
   * rel：HTML 文件（相对 public/）；reqPath：请求路径（算出页面到站点根目录的相对路径，写进 meta 供页面请求 api/build）
   */
  page(rel: string, reqPath: string): AssetPage | null {
    rel = rel.replace(/^\/+/, '');
    // HTML 里的 import map 覆盖所有模块：先确认各文件的版本是最新的
    this.scan();
    const src = this.entry(rel);
    if (!src) return null;
    const site = rootPrefix(reqPath);
    const key = `${rel}|${site}|${this.build}`;
    const hit = this.pages.get(key);
    if (hit && hit.src === src.hash) return hit;
    const html = fs.readFileSync(path.join(this.root, rel), 'utf8');
    const dir = path.posix.dirname(rel);
    const up = dir === '.' ? './' : '../'.repeat(dir.split('/').length);
    const out = rewriteHtml(html, { dir, resolve: (p) => this.hash(p), build: this.build, site, importMap: this.importMap(up) });
    const body = Buffer.from(out.html);
    const page = { src: src.hash, body, etag: `"${sha(body).slice(0, 16)}"`, csp: out.inline ? cspHash(out.inline) : null };
    if (this.pages.size > 64) this.pages.clear();
    this.pages.set(key, page);
    return page;
  }
}

/**
 * 改写 HTML：<script src> / <link href> 里能在清单里找到的相对路径加 ?v=<哈希>；在 </head> 前注入构建号与 import map。
 * 外链、data:、绝对路径、已经带查询参数的不动。返回 { html, inline }（inline：注入的内联脚本内容，用来算 CSP 哈希）
 */
export function rewriteHtml(html: string, { dir = '.', resolve, build, site = './', importMap = null }: { dir?: string; resolve: (rel: string) => string | null; build: string; site?: string; importMap?: string | null }): { html: string; inline: string | null } {
  const out = html.replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=")([^"]+)(")/gi, (m, a: string, url: string, b: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url) || url.includes('?')) return m;
    const rel = path.posix.normalize(path.posix.join(dir, url));
    if (rel.startsWith('..')) return m;
    const h = resolve(rel);
    return h ? `${a}${url}?v=${h}${b}` : m;
  });
  const esc = (s: unknown) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c as '&']));
  const inject = `<meta name="build" content="${esc(build)}" data-root="${esc(site)}">${importMap ? `\n<script type="importmap">${importMap}</script>` : ''}\n`;
  const i = out.search(/<\/head>/i);
  const html2 = i < 0 ? inject + out : out.slice(0, i) + inject + out.slice(i);
  return { html: html2, inline: importMap };
}
