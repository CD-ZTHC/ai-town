// 密码：scrypt（N=2^15, r=8, p=1）+ 每用户随机盐，比较用 timingSafeEqual（多世界设计 §5.4）
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw).normalize('NFKC'), salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) {
    // 账号不存在或没有密码：照样算一次，避免从耗时上看出账号是否存在
    await scrypt('x', 'salt-for-timing', KEYLEN, PARAMS);
    return false;
  }
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// 一个小型弱口令表：最常见的口令与键盘序列
const WEAK = new Set([
  '1234567890', '0123456789', '12345678910', '1111111111', '0000000000', '1234512345', '1122334455', '9876543210', '1234554321', '1q2w3e4r5t',
  'qwertyuiop', 'asdfghjkl;', 'zxcvbnm123', 'qwerty1234', 'password12', 'password123', 'passw0rd12', 'iloveyou12', 'abc1234567', 'abcdefghij',
  'abcd123456', 'a123456789', 'qwe1234567', '5201314520', '1314520520', 'woaini1314', 'admin12345', 'administrator', 'letmein123', 'welcome123',
  'football12', 'baseball12', 'sunshine12', 'princess12', 'dragon1234', 'monkey1234', 'aaaaaaaaaa', 'qqqqqqqqqq', 'zzzzzzzzzz', '1qaz2wsx3edc',
]);

/** 返回问题描述，没有问题时返回 null */
export function passwordProblem(pw, { username = '' } = {}) {
  pw = String(pw ?? '');
  if (pw.length < 10) return '密码至少 10 位';
  if (pw.length > 200) return '密码太长了';
  const low = pw.toLowerCase();
  if (WEAK.has(low)) return '这个密码太常见了，换一个吧';
  if (/^(.)\1+$/.test(pw)) return '密码不能是同一个字符重复';
  if (username && low.includes(String(username).toLowerCase())) return '密码不能包含用户名';
  if (/^\d+$/.test(pw) && isSequence(pw)) return '密码不能是连续的数字';
  return null;
}

function isSequence(s) {
  let up = true, down = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1 && d !== -9) up = false;
    if (d !== -1 && d !== 9) down = false;
  }
  return up || down;
}
