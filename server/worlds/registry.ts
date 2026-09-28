// 世界登记表（多世界设计 §6.3、§5.7 的 worlds 表）：每个世界的归属、状态、可见性、世界级设置、配额与磁盘占用。
// 状态机：drafting → preview → public ⇄ paused；public → unlisted（举报）→ suspended（下架）；preview / public → archived（归档）
import { WORLD_ID_RE } from './pack.ts';
import { lethal } from '../kernel/ratings.ts';

export const STATUSES = ['drafting', 'preview', 'failed', 'public', 'paused', 'unlisted', 'suspended', 'archived'];
// 允许的状态转换：谁可以做由调用方（授权）决定，这里只管能不能从 A 到 B
const TRANSITIONS = {
  drafting: ['preview', 'failed', 'archived'],
  failed: ['drafting', 'archived'],
  preview: ['preview', 'public', 'archived', 'drafting'],
  public: ['paused', 'unlisted', 'suspended', 'archived'],
  paused: ['public', 'suspended', 'archived'],
  unlisted: ['public', 'suspended'],
  suspended: ['public'],
  archived: [],
};
// 路由词与保留字：不能用作世界短名（多世界设计 §4.4）
export const RESERVED_IDS = new Set(['admin', 'api', 'w', 'auth', 'static', 'new', 'js', 'css', 'lobby', 'genesis', 'mine', 'my', 'me', 'login', 'register', 'reset', 'plugin-ui', 'healthz', 'www', 'about', 'help', 'official', 'system']);
export const ID_COOLDOWN_MS = 30 * 86400_000; // 归档清理后短名冷却 30 天
const RUNNABLE = new Set(['public', 'paused', 'unlisted', 'preview']);

const err = (status, message) => Object.assign(new Error(message), { status });
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export class WorldRegistry {
  /** @param {import('node:sqlite').DatabaseSync} db accounts.db */
  constructor(db, { now = () => Date.now(), onChange = null } = {}) {
    this.db = db;
    this.now = now;
    this.onChange = onChange;
  }

  row2world(r) {
    if (!r) return null;
    return {
      id: r.id, ownerId: r.owner_id, title: r.title, summary: r.summary, sourceTitle: r.source_title, status: r.status, visibility: r.visibility,
      official: Boolean(r.official), rating: r.rating, packHash: r.pack_hash, evolution: Boolean(r.evolution),
      settings: parse(r.settings, {}), quota: parse(r.quota, {}), diskBytes: r.disk_bytes, disk: parse(r.disk_detail, {}),
      createdAt: r.created_at, publishedAt: r.published_at, statusReason: r.status_reason, statusAt: r.status_at, releasedAt: r.released_at,
    };
  }

  get(id) { return this.row2world(this.db.prepare('SELECT * FROM worlds WHERE id = ?').get(String(id))); }

  list({ status = null, ownerId = null, official = null } = {}) {
    return this.db.prepare(`SELECT * FROM worlds WHERE (? IS NULL OR status = ?) AND (? IS NULL OR owner_id = ?) AND (? IS NULL OR official = ?) ORDER BY official DESC, published_at DESC, created_at DESC`)
      .all(status, status, ownerId, ownerId, official, official).map((r) => this.row2world(r));
  }

  /** 世界短名是否可用：返回问题描述或 null */
  idProblem(id) {
    id = String(id ?? '');
    if (!WORLD_ID_RE.test(id)) return '短名需要 3~32 位：小写字母开头，只能有小写字母、数字和短横线';
    if (RESERVED_IDS.has(id)) return '这个短名是保留字，换一个吧';
    const w = this.get(id);
    if (w && !(w.status === 'archived' && w.releasedAt && this.now() - w.releasedAt > ID_COOLDOWN_MS)) return w?.releasedAt ? '这个短名刚被释放，30 天后才能重新使用' : '这个短名已经被占用了';
    return null;
  }

  /** 登记（官方世界在启动时登记；用户世界在提交创世时以唯一约束占用短名） */
  create({ id, ownerId = null, title, summary = '', sourceTitle = '', status = 'drafting', official = false, rating = 'cozy', packHash = null, evolution = false, settings = {}, quota = {} }) {
    if (!official) { const p = this.idProblem(id); if (p) throw err(409, p); }
    const now = this.now();
    // 冷却期已过的归档世界：删掉旧记录，把短名让出来
    this.db.prepare("DELETE FROM worlds WHERE id = ? AND status = 'archived'").run(id);
    try {
      this.db.prepare(`INSERT INTO worlds (id, owner_id, title, summary, source_title, status, official, rating, pack_hash, evolution, settings, quota, created_at, published_at, status_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ownerId, String(title).slice(0, 40), String(summary).slice(0, 400), String(sourceTitle).slice(0, 60), status, official ? 1 : 0, rating, packHash, evolution ? 1 : 0, JSON.stringify(settings), JSON.stringify(quota), now, status === 'public' ? now : null, now);
    } catch (e) {
      if (/UNIQUE|PRIMARY/.test(e.message)) throw err(409, '这个短名已经被占用了');
      throw e;
    }
    this.onChange?.(id);
    return this.get(id);
  }

  /**
   * 官方世界：启动时登记（已有则只更新标题与包哈希）。
   * 会致死的分级（dark、tragic）第一次登记为不公开（有链接才能看），由管理员决定是否公开（黑暗叙事设计 §3）
   */
  ensureOfficial(id, { title, summary, packHash, settings, rating = 'cozy' }) {
    const w = this.get(id);
    const r = settings?.rating || rating;
    if (!w) return this.create({ id, title, summary, status: lethal(r) ? 'unlisted' : 'public', official: true, packHash, settings, rating: r });
    // 管理员改过的标题 / 简介（settings.overrides）不再被世界包覆盖（按世界配置模型服务设计 §9.2）
    const o = w.settings?.overrides || {};
    this.db.prepare('UPDATE worlds SET title = ?, summary = ?, pack_hash = ?, official = 1, rating = ? WHERE id = ?')
      .run(o.title ? w.title : title, o.summary ? w.summary : summary, packHash, w.settings?.rating || rating, id);
    return this.get(id);
  }

  update(id, patch) {
    const w = this.get(id);
    if (!w) throw err(404, '世界不存在');
    const cols = { title: 'title', summary: 'summary', sourceTitle: 'source_title', rating: 'rating', packHash: 'pack_hash', visibility: 'visibility' };
    for (const [k, col] of Object.entries(cols)) if (patch[k] !== undefined) this.db.prepare(`UPDATE worlds SET ${col} = ? WHERE id = ?`).run(patch[k], id);
    if (patch.evolution !== undefined) this.db.prepare('UPDATE worlds SET evolution = ? WHERE id = ?').run(patch.evolution ? 1 : 0, id);
    if (patch.settings) this.db.prepare('UPDATE worlds SET settings = ? WHERE id = ?').run(JSON.stringify({ ...w.settings, ...patch.settings }), id);
    if (patch.quota) this.db.prepare('UPDATE worlds SET quota = ? WHERE id = ?').run(JSON.stringify({ ...w.quota, ...patch.quota }), id);
    this.onChange?.(id);
    return this.get(id);
  }

  /** 状态转换（校验是否允许）；reason 会给 owner 看 */
  setStatus(id, to, reason = '') {
    const w = this.get(id);
    if (!w) throw err(404, '世界不存在');
    if (!STATUSES.includes(to)) throw err(400, '未知状态');
    if (w.status !== to && !TRANSITIONS[w.status].includes(to)) throw err(409, `世界现在是「${w.status}」，不能变成「${to}」`);
    const now = this.now();
    this.db.prepare('UPDATE worlds SET status = ?, status_reason = ?, status_at = ?, published_at = COALESCE(published_at, CASE WHEN ? = \'public\' THEN ? END) WHERE id = ?')
      .run(to, String(reason || '').slice(0, 400), now, to, now, id);
    this.onChange?.(id);
    return this.get(id);
  }

  /** 归档清理之后：记下释放时间（短名冷却 30 天） */
  release(id) { this.db.prepare('UPDATE worlds SET released_at = ? WHERE id = ?').run(this.now(), id); }

  remove(id) { this.db.prepare('DELETE FROM worlds WHERE id = ?').run(id); this.onChange?.(id); }

  setDisk(id, bytes, detail) { this.db.prepare('UPDATE worlds SET disk_bytes = ?, disk_detail = ? WHERE id = ?').run(Math.round(bytes), JSON.stringify(detail || {}), id); }

  /** 能不能运行（加载到内存）：已发布的、暂停的（只是不推进）、预览中的 */
  static runnable(w) { return Boolean(w && RUNNABLE.has(w.status)); }
}
