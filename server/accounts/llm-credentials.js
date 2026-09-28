// 模型服务凭据（按世界配置模型服务设计 §3.1）：属于账号（owner = 用户 id），或属于站点（owner = 'site'，只给官方世界用）。
// 密钥加密存放，只写不读：对外只有末 4 位；明文只经 secret() 交给构造 provider 的代码，永远不出这个模块的公开视图。
import crypto from 'node:crypto';
import { seal, open, scrub } from '../secrets.ts';

export const SITE = 'site';
export const STATUSES = ['unchecked', 'ok', 'failing'];
const err = (status, message) => Object.assign(new Error(message), { status });
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const last4 = (k) => String(k).slice(-4);

export class LlmCredentials {
  /**
   * @param {import('node:sqlite').DatabaseSync} db accounts.db
   * @param {{ key: Buffer, now?: () => number, onChange?: (id: string) => void }} o
   */
  constructor(db, { key, now = () => Date.now(), onChange = null }) {
    this.db = db;
    this.key = key;
    this.now = now;
    this.onChange = onChange;
  }

  row(id) { return this.db.prepare('SELECT * FROM llm_credentials WHERE id = ?').get(String(id)) || null; }

  /** 对外的视图（白名单字段；不含密文） */
  view(r) {
    if (!r) return null;
    return {
      id: r.id, owner: r.owner, name: r.name, provider: r.provider, baseUrl: r.base_url, keyLast4: r.key_last4,
      status: r.status, failCode: r.fail_code || null, lastError: r.last_error || '', checkedAt: r.checked_at || null,
      models: parse(r.models, []), createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  get(id) { return this.view(this.row(id)); }

  list(owner) { return this.db.prepare('SELECT * FROM llm_credentials WHERE owner = ? ORDER BY created_at').all(String(owner)).map((r) => this.view(r)); }

  count(owner) { return this.db.prepare('SELECT COUNT(*) AS n FROM llm_credentials WHERE owner = ?').get(String(owner)).n; }

  /** 解密后的密钥：只给构造 provider 的代码用 */
  secret(id) {
    const r = this.row(id);
    if (!r) return null;
    return open(this.key, r.key_enc, `${r.id}|${r.owner}`);
  }

  create({ owner, name, provider, baseUrl = '', apiKey }) {
    const id = `c_${crypto.randomBytes(5).toString('hex')}`;
    const now = this.now();
    this.db.prepare(`INSERT INTO llm_credentials (id, owner, name, provider, base_url, key_enc, key_last4, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, String(owner), String(name), String(provider), String(baseUrl), seal(this.key, apiKey, `${id}|${owner}`), last4(apiKey), now, now);
    this.onChange?.(id);
    return this.get(id);
  }

  /** 改名、换地址、换类型、换密钥（不传 apiKey = 不改）；地址或密钥变了，状态回到「未测试」 */
  update(id, { name, provider, baseUrl, apiKey } = {}) {
    const r = this.row(id);
    if (!r) throw err(404, '凭据不存在');
    const sets = [];
    const args = [];
    if (name !== undefined) { sets.push('name = ?'); args.push(String(name)); }
    if (provider !== undefined && provider !== r.provider) { sets.push('provider = ?'); args.push(String(provider)); }
    if (baseUrl !== undefined && baseUrl !== r.base_url) { sets.push('base_url = ?'); args.push(String(baseUrl)); }
    if (apiKey) { sets.push('key_enc = ?', 'key_last4 = ?'); args.push(seal(this.key, apiKey, `${r.id}|${r.owner}`), last4(apiKey)); }
    if (sets.some((s) => !s.startsWith('name'))) sets.push("status = 'unchecked'", 'fail_code = NULL', 'last_error = NULL');
    if (!sets.length) return this.view(r);
    sets.push('updated_at = ?');
    args.push(this.now(), r.id);
    this.db.prepare(`UPDATE llm_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    this.onChange?.(r.id);
    return this.get(r.id);
  }

  remove(id) {
    this.db.prepare('DELETE FROM llm_credentials WHERE id = ?').run(String(id));
    this.onChange?.(String(id));
  }

  /** 记下测试或调用的结果：ok 或 failing（错误信息先脱敏，去掉密钥原文） */
  mark(id, { status, failCode = null, error = '', models = null }) {
    const r = this.row(id);
    if (!r) return null;
    let key = '';
    try { key = this.secret(id); } catch { /* 解不开也照样记 */ }
    const msg = error ? scrub(error, [key]).slice(0, 300) : null;
    this.db.prepare(`UPDATE llm_credentials SET status = ?, fail_code = ?, last_error = ?, checked_at = ?${models ? ', models = ?' : ''} WHERE id = ?`)
      .run(status, status === 'ok' ? null : failCode, status === 'ok' ? null : msg, this.now(), ...(models ? [JSON.stringify(models.slice(0, 200))] : []), r.id);
    return this.get(r.id);
  }

  /** 换主密钥：在一个事务里重写所有密文 */
  rotate(newKey) {
    const rows = this.db.prepare('SELECT id, owner, key_enc FROM llm_credentials').all();
    const upd = this.db.prepare('UPDATE llm_credentials SET key_enc = ? WHERE id = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) upd.run(seal(newKey, open(this.key, r.key_enc, `${r.id}|${r.owner}`), `${r.id}|${r.owner}`), r.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.key = newKey;
    return rows.length;
  }
}
