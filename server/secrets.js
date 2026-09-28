// 凭据加密（按世界配置模型服务设计 §3.4）：AES-256-GCM，主密钥来自 SECRETS_KEY（环境变量），
// 没有配置时首次启动自动生成 <数据目录>/secret.key（0600）。附加数据（AAD）绑定凭据的 id 与所有者，
// 把一行的密文挪到另一行会解密失败。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;

/** 解析 base64 / base64url / hex 写法的 32 字节主密钥 */
export function parseMasterKey(s) {
  const t = String(s || '').trim();
  for (const enc of ['base64url', 'base64', 'hex']) {
    try {
      const b = Buffer.from(t, enc);
      if (b.length === KEY_BYTES) return b;
    } catch { /* 下一种 */ }
  }
  throw new Error('SECRETS_KEY 应为 32 字节（base64 或 hex 编码）');
}

export const generateMasterKey = () => crypto.randomBytes(KEY_BYTES).toString('base64url');

/**
 * 主密钥：优先用 SECRETS_KEY；否则读 / 生成 <dataDir>/secret.key。
 * 返回 { key, source: 'env' | 'file' | 'generated', file? }
 */
export function loadMasterKey({ envValue = '', dataDir }) {
  if (envValue) return { key: parseMasterKey(envValue), source: 'env' };
  const file = path.join(path.resolve(dataDir), 'secret.key');
  if (fs.existsSync(file)) return { key: parseMasterKey(fs.readFileSync(file, 'utf8')), source: 'file', file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${generateMasterKey()}\n`, { mode: 0o600, flag: 'wx' });
  return { key: parseMasterKey(fs.readFileSync(file, 'utf8')), source: 'generated', file };
}

/** 加密：返回 iv.tag.ciphertext（base64url） */
export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function open(key, sealed, aad) {
  const [iv, tag, ct] = String(sealed).split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** 错误信息脱敏：去掉密钥原文，以及 sk-… / Bearer … / key=… 这类片段 */
export function scrub(text, secrets = []) {
  let s = String(text || '');
  for (const k of secrets) if (k && k.length >= 4) s = s.split(k).join('***');
  return s
    .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_\-]{6,}/g, '$1-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1***')
    .replace(/((?:api[_-]?key|key|token)["'=:\s]+)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}
