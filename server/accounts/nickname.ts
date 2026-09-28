// 昵称（多世界设计 §5.6）：全站唯一。比较前做 NFKC 归一化、去掉空白与不可见字符、忽略大小写，
// 防止用全角字母或零宽字符造出「看起来一样」的名字。
import { keywordCheck } from '../guard.ts';

// 控制字符、零宽字符与双向文本控制符
const INVISIBLE = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff]]
  .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

/** 用于唯一性比较的键 */
export function nicknameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, '').toLowerCase();
}

/** 显示用的昵称：去掉不可见字符与首尾空白 */
export function cleanNickname(name) {
  return String(name ?? '').normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

// 冒充性词汇：不能出现在昵称里
const IMPERSONATE = /管理员|管理組|官方|系统|系統|客服|站长|版主|admin|moderator|official|system|root|staff/i;

/**
 * 昵称是否可用（不查数据库里的重名，那一步由调用方做）。reserved：保留的名字（官方世界居民的名字等）。
 * 返回问题描述，没有问题时返回 null。
 */
export function nicknameProblem(name, { reserved = [] } = {}) {
  const n = cleanNickname(name);
  const len = [...n].length;
  if (len < 1) return '起个昵称吧';
  if (len > 8) return '昵称最多 8 个字';
  if (/[<>{}[\]"'`\\「」@#]/.test(n)) return '昵称里不能有特殊符号';
  if (IMPERSONATE.test(nicknameKey(n))) return '昵称里不能有「管理员」「官方」「系统」这类词';
  const key = nicknameKey(n);
  if (reserved.some((r) => nicknameKey(r) === key)) return '这个名字是小镇居民的名字，换一个吧';
  const k = keywordCheck(n, 'cozy');
  if (!k.ok) return '这个昵称不太合适，换一个吧';
  return null;
}

/** 用户名（登录用）：3~20 位，只允许字母数字和下划线 */
export function usernameProblem(u) {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(String(u ?? ''))) return '用户名需要 3~20 位，只能用字母、数字和下划线';
  if (IMPERSONATE.test(u)) return '用户名里不能有 admin、official、system 这类词';
  return null;
}
