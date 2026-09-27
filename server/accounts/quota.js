// 配额（多世界设计 §5.1、§5.4）：quota(who, bucket) → { ok, remaining, retryAfter }。
// 互动额度按账号计；公开注册意味着账号本身不值钱，所以同时保留按 IP 的兜底上限（单账号额度 × RATE_IP_FACTOR）。
// 世界范围的冷却（全镇事件、改天气）按世界计。管理员不受限。
import { Limiter } from '../guard.js';
import { get as setting } from '../settings/index.js';

const H = 3600_000;
const ipMax = (n) => () => Math.max(1, Math.ceil(n() * setting('RATE_IP_FACTOR')));
const chat = () => setting('RATE_CHAT_PER_HOUR');
const event = () => setting('RATE_EVENT_PER_HOUR');

// 每个桶：按账号的限流器（可以有多个，全部通过才算通过）、按 IP 的兜底、按世界的冷却
const BUCKETS = {
  chat: { user: [new Limiter(chat, H), new Limiter(4, 60_000)], ip: new Limiter(ipMax(chat), H), what: '说话' },
  event: { user: [new Limiter(event, H)], ip: new Limiter(ipMax(event), H), world: new Limiter(1, () => setting('EVENT_GLOBAL_COOLDOWN_SEC') * 1000), what: '发布事件' },
  // 含被审核拒绝的尝试，防止刷审核调用
  eventAttempt: { user: [new Limiter(() => Math.max(6, event() * 3), H)], ip: new Limiter(ipMax(() => Math.max(6, event() * 3)), H), what: '尝试发布事件' },
  weather: { world: new Limiter(1, () => setting('WEATHER_COOLDOWN_SEC') * 1000), what: '改变天气' },
  vote: { user: [new Limiter(20, H)], ip: new Limiter(ipMax(() => 20), H), what: '投票' },
  proposal: { user: [new Limiter(2, H)], ip: new Limiter(ipMax(() => 2), H), what: '提建议' },
  avatar: { user: [new Limiter(6, H)], what: '现身' },
  plugin: { user: [new Limiter(30, 60_000)], ip: new Limiter(ipMax(() => 30), 60_000), what: '使用插件' },
  report: { user: [new Limiter(10, H)], ip: new Limiter(ipMax(() => 10), H), what: '举报' },
  register: { ip: new Limiter(() => setting('REGISTER_PER_IP_HOUR'), H), what: '注册' },
};
setInterval(() => { for (const b of Object.values(BUCKETS)) for (const l of [...(b.user || []), b.ip, b.world].filter(Boolean)) l.sweep(); }, 300_000).unref();

const fmtWait = (s) => (s >= 90 ? `${Math.ceil(s / 60)} 分钟` : `${s} 秒`);

/**
 * @param {{ user?: {id}, admin?: boolean, ip?: string }} who
 * @param {string} bucket
 * @param {{ take?: boolean, world?: string }} [o] take=false 只检查不扣次数
 */
export function quota(who, bucket, { take = true, world = '' } = {}) {
  const b = BUCKETS[bucket];
  if (!b) throw new Error(`未知的配额：${bucket}`);
  if (who.admin) return { ok: true, remaining: null, retryAfter: 0 };
  const checks = [
    ...(b.world ? [[b.world, `w:${world}`, 'world']] : []),
    ...(who.user && b.user ? b.user.map((l) => [l, `u:${who.user.id}`, 'user']) : []),
    ...(b.ip && who.ip ? [[b.ip, `ip:${who.ip}`, 'ip']] : []),
  ];
  // 先全部检查（不扣），都通过再一起扣，避免一个桶扣了另一个桶却拒绝
  let remaining = Infinity;
  for (const [l, key, scope] of checks) {
    const r = l.check(key, false);
    if (!r.ok) {
      const message = scope === 'world' ? `${bucket === 'weather' ? '天气刚刚变过' : '这里刚刚发生过一件事'}，请 ${fmtWait(r.retryAfter)}后再${b.what}`
        : scope === 'ip' ? `你所在的网络${b.what}太频繁了，请 ${fmtWait(r.retryAfter)}后再试`
          : `${b.what}太频繁了，请 ${fmtWait(r.retryAfter)}后再试`;
      return { ok: false, remaining: 0, retryAfter: r.retryAfter, scope, message };
    }
    if (scope === 'user') remaining = Math.min(remaining, r.remaining);
  }
  if (take) for (const [l, key, scope] of checks) { const r = l.check(key, true); if (scope === 'user') remaining = Math.min(remaining, r.remaining); }
  return { ok: true, remaining: Number.isFinite(remaining) ? (take ? remaining : remaining) : null, retryAfter: 0 };
}

/** 剩余次数（不扣） */
export function remaining(who, bucket) {
  if (who.admin || !who.user) return null;
  const b = BUCKETS[bucket];
  return Math.min(...(b.user || []).map((l) => l.check(`u:${who.user.id}`, false).remaining));
}

/** 测试用：清空计数 */
export function _resetQuota() { for (const b of Object.values(BUCKETS)) for (const l of [...(b.user || []), b.ip, b.world].filter(Boolean)) l.hits.clear(); }
