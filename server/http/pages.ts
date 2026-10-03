// 世界页面的入口检查：世界不存在、已下架、满员时给一个说明页，而不是让页面打开后反复报错
import { authorize } from '../accounts/authz.ts';
import type { WorldRegistry } from '../worlds/registry.ts';
import type { WorldManager } from '../worlds/manager.ts';
import type { Ctx } from '../types/http.ts';

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c as '&']));

export function infoPage(title: string, body: string, { retryAfter = 0 }: { retryAfter?: number } = {}): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AI Town</title><link rel="stylesheet" href="../../site.css">${retryAfter ? `<meta http-equiv="refresh" content="${Math.min(300, retryAfter)}">` : ''}</head>
<body><header class="site-top"><a class="brand" href="../../">AI Town</a></header>
<main class="site" style="max-width:560px"><div class="card"><h2>${esc(title)}</h2>${body}<p><a href="../../">← 回到世界大厅</a></p></div></main></body></html>`;
}

export function worldPage({ c, id, registry, manager }: { c: Ctx; id: string; registry: WorldRegistry; manager: WorldManager }): { ok: true; status?: undefined; html?: undefined } | { ok: false; status: number; html: string } {
  const w = registry.get(id);
  const ok = authorize(c.get('who') || {}, 'world.view', w);
  if (ok !== true) {
    if (w?.status === 'suspended') return { ok: false, status: 403, html: infoPage('这个世界已被下架', `<p class="muted">${esc(w.title)} 暂时无法访问。</p>`) };
    return { ok: false, status: 404, html: infoPage('没有找到这个世界', `<p class="muted">链接 <code>/w/${esc(id)}/</code> 没有对应的世界，也可能还没有发布。</p>`) };
  }
  const cap = manager.canOpen(id);
  if (!cap.ok) {
    const min = Math.ceil(cap.retryAfter! / 60);
    return { ok: false, status: 503, html: infoPage('世界满员了', `<p>现在同时运行的世界已经到了上限，而且每个世界都有人在看。</p><p class="muted">预计 ${min} 分钟左右会空出位置，这个页面会自动刷新。</p>`, { retryAfter: cap.retryAfter }) };
  }
  return { ok: true };
}
