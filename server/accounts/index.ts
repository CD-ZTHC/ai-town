// 账号（多世界设计 §5）：注册、登录、会话、昵称、授予、禁用、重置链接、管理员认领、审计。
// 三个独立的函数：identify（谁在请求，见 http/identity.ts）、authorize（能不能做，见 authz.ts）、quota（还剩多少，见 quota.ts）。
import crypto from 'node:crypto';
import { openDb, tx } from './db.ts';
import { hashPassword, verifyPassword, passwordProblem } from './passwords.ts';
import { nicknameKey, cleanNickname, nicknameProblem, usernameProblem } from './nickname.ts';
import { setResolver, encodeRefs } from './refs.ts';
import { memoryHooks } from '../memory.ts';

const DAY = 86400_000;
export const SESSION_TTL = 30 * DAY; // 30 天滑动过期
const SESSION_TOUCH = 3600_000; // 最多每小时更新一次 last_seen_at
const RENAME_EVERY = 30 * DAY;
const HOLD = 90 * DAY; // 改名后旧昵称保留 90 天
const RESET_TTL = 2 * DAY;
export const LOCAL_ID = 'u_local';
export const ROLES = ['user', 'admin', 'super'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const newId = () => `u_${crypto.randomBytes(5).toString('hex')}`;

export class Accounts {
  /**
   * @param {object} o
   * @param {string} o.file 数据库文件（':memory:' 为内存数据库）
   * @param {() => string[]} [o.reservedNames] 保留的名字（官方世界居民的名字）
   * @param {() => number} [o.now]
   */
  constructor({ file, reservedNames = () => [], now = () => Date.now(), db = null }) {
    this.db = db || openDb(file);
    this.reservedNames = reservedNames;
    this.now = now;
    this.cache = new Map(); // id → 用户（昵称解析用）
    this.fails = new Map(); // 登录失败：key → { n, until }
  }

  close() { try { this.db.close(); } catch { /* 已关闭 */ } }

  // ---------- 查询 ----------
  row(id) { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null; }

  /** 对外的用户信息（不含密码） */
  pub(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, nickname: u.nickname, role: u.role, disabled: Boolean(u.disabled_at), createdAt: u.created_at, nicknameChangedAt: u.nickname_changed_at || null };
  }

  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const u = this.pub(this.row(id));
    if (u) this.cache.set(id, u);
    return u;
  }

  byUsername(username) { return this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '')) || null; }

  /** 昵称是否可用（全站唯一 + 改名保留期）；返回问题描述或 null */
  nicknameTaken(nickname, exceptId = null) {
    const key = nicknameKey(nickname);
    const u = this.db.prepare('SELECT id FROM users WHERE nickname_key = ?').get(key);
    if (u && u.id !== exceptId) return '这个昵称已经有人用了';
    const h = this.db.prepare('SELECT user_id, until FROM nickname_holds WHERE nickname_key = ?').get(key);
    if (h && h.until > this.now() && h.user_id !== exceptId) return '这个昵称刚被人改掉，暂时不能使用';
    return null;
  }

  checkNickname(nickname, exceptId = null) {
    return nicknameProblem(nickname, { reserved: this.reservedNames() }) || this.nicknameTaken(nickname, exceptId);
  }

  // ---------- 注册与登录 ----------
  async register({ username, nickname, password }) {
    username = String(username ?? '').trim();
    const p1 = usernameProblem(username);
    if (p1) throw err(400, p1, { field: 'username' });
    const nick = cleanNickname(nickname);
    const p2 = this.checkNickname(nick);
    if (p2) throw err(409, p2, { field: 'nickname' });
    const p3 = passwordProblem(password, { username });
    if (p3) throw err(400, p3, { field: 'password' });
    if (this.byUsername(username)) throw err(409, '这个用户名已经被注册了', { field: 'username' });
    const pw = await hashPassword(password);
    const id = newId();
    try {
      this.db.prepare('INSERT INTO users (id, username, nickname, nickname_key, pw_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, username, nick, nicknameKey(nick), pw, 'user', this.now());
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw err(409, /nickname/.test(e.message) ? '这个昵称已经有人用了' : '这个用户名已经被注册了');
      throw e;
    }
    this.audit({ actor: id, action: 'user.register', target: id, detail: { username, nickname: nick } });
    return this.get(id);
  }

  /** 登录失败按账号和 IP 双重指数退避：连续失败 3 次后开始等待 2、4、8……秒，最长 15 分钟 */
  backoff(keys) {
    const now = this.now();
    for (const k of keys) {
      const f = this.fails.get(k);
      if (f && f.until > now) return Math.ceil((f.until - now) / 1000);
    }
    return 0;
  }

  noteFail(keys) {
    const now = this.now();
    for (const k of keys) {
      const f = this.fails.get(k) || { n: 0, until: 0 };
      f.n++;
      f.until = f.n >= 3 ? now + Math.min(15 * 60_000, 1000 * 2 ** (f.n - 2)) : 0;
      this.fails.set(k, f);
    }
    if (this.fails.size > 20000) for (const [k, f] of this.fails) if (f.until < now) this.fails.delete(k);
  }

  async login({ username, password, ip = '', ua = '' }) {
    const keys = [`u:${String(username || '').toLowerCase()}`, `ip:${ip}`];
    const wait = this.backoff(keys);
    if (wait) throw err(429, `尝试次数太多了，请 ${wait} 秒后再试`, { retryAfter: wait });
    const u = this.byUsername(username);
    const ok = await verifyPassword(password, u?.pw_hash);
    if (!u || !ok) { this.noteFail(keys); throw err(401, '用户名或密码不对'); }
    if (u.disabled_at) throw err(403, '这个账号已被停用');
    for (const k of keys) this.fails.delete(k);
    return { user: this.pub(u), token: this.createSession(u.id, { ip, ua }) };
  }

  // ---------- 会话 ----------
  createSession(userId, { ip = '', ua = '' } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, now, now, String(ip).slice(0, 64), String(ua).slice(0, 200));
    return token;
  }

  /** 根据会话令牌找到用户；过期或账号已停用时返回 null。touched：这次是否刷新了过期时间（需要重新下发 Cookie） */
  session(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const h = sha256(token);
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h);
    if (!s) return null;
    const now = this.now();
    if (now - s.last_seen_at > SESSION_TTL) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h); return null; }
    const u = this.row(s.user_id);
    if (!u || u.disabled_at) return null;
    let touched = false;
    if (now - s.last_seen_at > SESSION_TOUCH) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, h);
      touched = true;
    }
    return { user: this.pub(u), touched };
  }

  logout(token, { all = false } = {}) {
    const s = token && this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!s) return 0;
    if (all) return Number(this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(s.user_id).changes);
    return Number(this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes);
  }

  sessionsOf(userId) {
    return this.db.prepare('SELECT created_at, last_seen_at, ip, ua FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId);
  }

  sweepSessions() {
    this.db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').run(this.now() - SESSION_TTL);
    this.db.prepare('DELETE FROM nickname_holds WHERE until < ?').run(this.now());
  }

  // ---------- 昵称与密码 ----------
  rename(userId, nickname) {
    const u = this.row(userId);
    if (!u) throw err(404, '账号不存在');
    const nick = cleanNickname(nickname);
    if (nick === u.nickname) return this.pub(u);
    const now = this.now();
    if (u.nickname_changed_at && now - u.nickname_changed_at < RENAME_EVERY && u.role !== 'super') {
      const days = Math.ceil((u.nickname_changed_at + RENAME_EVERY - now) / DAY);
      throw err(429, `每 30 天只能改一次昵称，还要等 ${days} 天`);
    }
    const p = this.checkNickname(nick, userId);
    if (p) throw err(409, p);
    tx(this.db, () => {
      // 旧昵称保留 90 天，期间别人不能用，避免冒充刚改名的人
      this.db.prepare('INSERT OR REPLACE INTO nickname_holds (nickname_key, user_id, until) VALUES (?, ?, ?)').run(u.nickname_key, userId, now + HOLD);
      this.db.prepare('UPDATE users SET nickname = ?, nickname_key = ?, nickname_changed_at = ? WHERE id = ?').run(nick, nicknameKey(nick), now, userId);
    });
    this.cache.delete(userId);
    this.audit({ actor: userId, action: 'user.rename', target: userId, detail: { from: u.nickname, to: nick } });
    return this.get(userId);
  }

  async changePassword(userId, oldPw, newPw, { keepToken = null } = {}) {
    const u = this.row(userId);
    if (!u) throw err(404, '账号不存在');
    if (!(await verifyPassword(oldPw, u.pw_hash))) throw err(401, '原密码不对');
    const p = passwordProblem(newPw, { username: u.username });
    if (p) throw err(400, p);
    this.db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(newPw), userId);
    // 改密码后其他设备全部登出
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepToken ? sha256(keepToken) : '');
    this.audit({ actor: userId, action: 'user.password', target: userId });
  }

  /** 管理员生成一次性的密码重置链接（第一版不接邮件） */
  createResetToken(userId, by) {
    if (!this.row(userId)) throw err(404, '账号不存在');
    const token = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO reset_tokens (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, by, this.now() + RESET_TTL);
    this.audit({ actor: by, action: 'user.reset-link', target: userId });
    return token;
  }

  async resetPassword(token, newPw) {
    const r = this.db.prepare('SELECT * FROM reset_tokens WHERE token_hash = ?').get(sha256(String(token || '')));
    if (!r || r.used_at || r.expires_at < this.now()) throw err(400, '重置链接无效或已过期');
    const u = this.row(r.user_id);
    const p = passwordProblem(newPw, { username: u?.username });
    if (p) throw err(400, p);
    tx(this.db, () => {
      this.db.prepare('UPDATE reset_tokens SET used_at = ? WHERE token_hash = ?').run(this.now(), r.token_hash);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
    });
    this.db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(newPw), r.user_id);
    this.audit({ actor: r.user_id, action: 'user.password-reset', target: r.user_id });
    return this.get(r.user_id);
  }

  // ---------- 管理 ----------
  list({ q = '', limit = 50, offset = 0 } = {}) {
    const like = `%${String(q).replace(/[%_]/g, '')}%`;
    const rows = this.db.prepare(`SELECT * FROM users WHERE id != ? AND (username LIKE ? OR nickname LIKE ? OR id = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(LOCAL_ID, like, like, q, Math.min(200, limit), offset);
    return rows.map((u) => ({ ...this.pub(u), grants: this.grantsOf(u.id), sessions: this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(u.id).n }));
  }

  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE id != ?').get(LOCAL_ID).n; }

  /** 停用账号：立即删除它的全部会话 */
  setDisabled(userId, disabled, by, reason = '') {
    const u = this.row(userId);
    if (!u) throw err(404, '账号不存在');
    if (u.role === 'super' && disabled) throw err(409, '不能停用超级管理员');
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET disabled_at = ?, disabled_reason = ? WHERE id = ?').run(disabled ? this.now() : null, disabled ? String(reason).slice(0, 200) : null, userId);
      if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
    this.cache.delete(userId);
    this.audit({ actor: by, action: disabled ? 'user.disable' : 'user.enable', target: userId, detail: { reason } });
  }

  setRole(userId, role, by) {
    if (!ROLES.includes(role)) throw err(400, '未知角色');
    const u = this.row(userId);
    if (!u) throw err(404, '账号不存在');
    if (u.role === 'super' && role !== 'super' && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super'").get().n <= 1) throw err(409, '至少要保留一位超级管理员');
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    this.cache.delete(userId);
    this.audit({ actor: by, action: 'user.role', target: userId, detail: { from: u.role, to: role } });
    return this.get(userId);
  }

  hasSuper() { return Boolean(this.db.prepare("SELECT id FROM users WHERE role = 'super' AND id != ? LIMIT 1").get(LOCAL_ID)); }

  /** 管理员认领：还没有超级管理员时，ADMIN_TOKEN 的持有者可以把自己的账号升为超级管理员 */
  claimSuper(userId) {
    if (this.hasSuper()) throw err(409, '已经有超级管理员了');
    this.db.prepare("UPDATE users SET role = 'super' WHERE id = ?").run(userId);
    this.cache.delete(userId);
    this.audit({ actor: userId, action: 'admin.claim', target: userId });
    return this.get(userId);
  }

  /** 本地模式的内置账号（所有请求都视为它）；昵称跟随设置 LOCAL_NICKNAME */
  localUser(nickname) {
    const u = this.row(LOCAL_ID);
    const nick = cleanNickname(nickname) || '旅人';
    if (!u) {
      this.db.prepare('INSERT INTO users (id, username, nickname, nickname_key, pw_hash, role, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
        .run(LOCAL_ID, 'local', nick, `#local:${nicknameKey(nick)}`, 'super', this.now());
    } else if (u.nickname !== nick) {
      this.db.prepare('UPDATE users SET nickname = ?, nickname_key = ? WHERE id = ?').run(nick, `#local:${nicknameKey(nick)}`, LOCAL_ID);
      this.cache.delete(LOCAL_ID);
    }
    return this.get(LOCAL_ID);
  }

  // ---------- 授予（多世界设计 §5.2）----------
  grantsOf(userId) {
    const now = this.now();
    return this.db.prepare('SELECT * FROM grants WHERE user_id = ?').all(userId)
      .filter((g) => !g.expires_at || g.expires_at > now)
      .map((g) => ({ cap: g.cap, quota: JSON.parse(g.quota || '{}'), grantedBy: g.granted_by, at: g.granted_at, expiresAt: g.expires_at, note: g.note || '' }));
  }

  grant(userId, cap) { return this.grantsOf(userId).find((g) => g.cap === cap) || null; }

  setGrant(userId, { cap, quota = {}, expiresAt = null, note = '' }, by) {
    if (!this.row(userId)) throw err(404, '账号不存在');
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(String(cap))) throw err(400, '授予名称不合法');
    this.db.prepare('INSERT OR REPLACE INTO grants (user_id, cap, quota, granted_by, granted_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, cap, JSON.stringify(quota || {}), by, this.now(), expiresAt || null, String(note || '').slice(0, 200));
    this.audit({ actor: by, action: 'grant.set', target: userId, detail: { cap, quota, expiresAt, note } });
    return this.grant(userId, cap);
  }

  revokeGrant(userId, cap, by) {
    const n = Number(this.db.prepare('DELETE FROM grants WHERE user_id = ? AND cap = ?').run(userId, cap).changes);
    if (n) this.audit({ actor: by, action: 'grant.revoke', target: userId, detail: { cap } });
    return n > 0;
  }

  // ---------- 审计 ----------
  audit({ actor, action, target = '', detail = {} }) {
    try {
      this.db.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(this.now(), String(actor || 'system'), action, String(target || ''), JSON.stringify(detail ?? {}));
    } catch (e) { console.warn('[audit] 写入失败：', e.message); }
  }

  auditLog({ actor = '', action = '', limit = 200, before = null } = {}) {
    const rows = this.db.prepare(`SELECT * FROM audit WHERE (? = '' OR actor = ?) AND (? = '' OR action LIKE ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
      .all(actor, actor, action, `${action}%`, before, before, Math.min(500, limit));
    return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}'), actorName: this.get(r.actor)?.nickname || null }));
  }
}

/**
 * 让世界里的记忆按账号引用旅人（多世界设计 §5.6）：昵称解析用账号表，居民写记忆时把认识的旅人的昵称换成引用。
 */
export function installRefs(accounts) {
  setResolver((id) => accounts.get(id));
  memoryHooks.encode = (agent, text) => {
    const ids = Object.keys(agent.travellers || {});
    if (!ids.length || typeof text !== 'string') return text;
    return encodeRefs(text, ids.map((id) => ({ id, name: accounts.get(id)?.nickname })).filter((p) => p.name));
  };
}
