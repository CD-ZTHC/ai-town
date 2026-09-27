// 可选的 embedding：配置 EMBED_MODEL 后，记忆检索会同时参考语义相似度（没配置时只用双字组，行为与之前一致）。
// 向量按「模型 + 文本」缓存：优先存进 node:sqlite（<数据目录>/embeddings.db，增量写入，重启不用重算），
// 运行时不支持 node:sqlite 时退回进程内缓存。
//
// 环境变量：EMBED_MODEL（必填才启用）、EMBED_BASE_URL / EMBED_API_KEY（默认沿用 BASE_URL / API_KEY）、
// EMBED_TIMEOUT_MS（检索时最多等多久，默认 4000；超时这次就只用双字组）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env as settingsEnv } from './settings/index.js';

const BATCH = 64; // 一次请求最多多少条文本
const MAX_PER_CALL = 128; // 一次检索最多补算多少条记忆（其余下次再算）
const MEM_CACHE_MAX = 20_000;

/** OpenAI 兼容的 /embeddings 接口 */
export function openaiEmbeddings({ baseUrl, apiKey, model }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return async (texts, { signal } = {}) => {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
    const out = new Array(texts.length);
    for (const d of data.data || []) out[d.index] = d.embedding;
    if (out.some((v) => !Array.isArray(v))) throw new Error('embedding 返回的条数不对');
    return { vectors: out, tokens: data.usage?.total_tokens || data.usage?.prompt_tokens || 0 };
  };
}

/** 向量缓存：node:sqlite（可用时）+ 进程内 Map */
async function openStore(dir) {
  const mem = new Map();
  let db = null;
  if (dir) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      fs.mkdirSync(dir, { recursive: true });
      db = new DatabaseSync(path.join(dir, 'embeddings.db'));
      db.exec('CREATE TABLE IF NOT EXISTS vec (key TEXT PRIMARY KEY, dim INTEGER NOT NULL, data BLOB NOT NULL)');
    } catch (e) {
      console.warn('[embed] 无法使用 node:sqlite，向量只缓存在内存里：', e.message);
      db = null;
    }
  }
  const get = db?.prepare('SELECT data FROM vec WHERE key = ?');
  const put = db?.prepare('INSERT OR REPLACE INTO vec (key, dim, data) VALUES (?, ?, ?)');
  return {
    persistent: Boolean(db),
    get(key) {
      if (mem.has(key)) return mem.get(key);
      const row = get?.get(key);
      if (!row) return undefined;
      const v = new Float32Array(Uint8Array.from(row.data).buffer); // 复制一份：BLOB 的偏移不一定按 4 字节对齐
      mem.set(key, v);
      return v;
    },
    set(key, arr) {
      const v = Float32Array.from(arr);
      if (mem.size >= MEM_CACHE_MAX) mem.delete(mem.keys().next().value);
      mem.set(key, v);
      put?.run(key, v.length, new Uint8Array(v.buffer));
      return v;
    },
    close() { try { db?.close(); } catch {} },
  };
}

/**
 * @param {object} opts
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.dir] 缓存目录（不填只缓存在内存）
 * @param {(texts: string[], o?: {signal?: AbortSignal}) => Promise<{vectors: number[][], tokens?: number}>} [opts.embed] 测试用：注入假的 embedding
 */
export function createEmbedder({ env = settingsEnv(), dir = null, embed = null } = {}) {
  const model = env.EMBED_MODEL || '';
  const baseUrl = env.EMBED_BASE_URL || env.BASE_URL || '';
  const apiKey = env.EMBED_API_KEY || env.API_KEY || '';
  const enabled = Boolean(embed || (model && baseUrl && apiKey));
  const call = embed || (enabled ? openaiEmbeddings({ baseUrl, apiKey, model }) : null);
  const timeoutMs = Number(env.EMBED_TIMEOUT_MS || 4000);
  const stats = { enabled, model, calls: 0, texts: 0, tokens: 0, errors: 0, timeouts: 0, lastError: '' };
  let storeP = null;
  let store = null;
  const inflight = new Map(); // key -> Promise，同一段文本并发请求时只算一次
  const keyOf = (text) => crypto.createHash('sha1').update(`${model}\n${text}`).digest('base64url');

  async function fetchBatch(texts, keys) {
    stats.calls++;
    stats.texts += texts.length;
    const r = await call(texts);
    stats.tokens += r.tokens || 0;
    r.vectors.forEach((v, i) => store.set(keys[i], v));
  }

  return {
    enabled,
    stats,
    get persistent() { return Boolean(store?.persistent); },
    /** 已经算好的向量（同步，没有就返回 undefined） */
    vec(text) { return store?.get(keyOf(text)); },
    /**
     * 确保这些文本都有向量：一次最多补算 MAX_PER_CALL 条，超过 timeoutMs 就先返回（后台继续算完）。
     * 永远不抛错：失败时返回 false，调用方退回双字组。
     */
    async ensure(texts) {
      if (!enabled) return false;
      store ||= await (storeP ||= openStore(dir));
      const want = [];
      const waits = [];
      for (const text of new Set(texts.filter(Boolean))) {
        const key = keyOf(text);
        if (store.get(key)) continue;
        if (inflight.has(key)) { waits.push(inflight.get(key)); continue; }
        if (want.length < MAX_PER_CALL) want.push({ text, key });
      }
      for (let i = 0; i < want.length; i += BATCH) {
        const chunk = want.slice(i, i + BATCH);
        // 每批解析为 true / false（失败也不抛出），这样 ensure 才知道这次是不是全部算好了
        const p = fetchBatch(chunk.map((x) => x.text), chunk.map((x) => x.key)).then(() => true, (e) => {
          stats.errors++;
          stats.lastError = String(e.message || e).slice(0, 200);
          return false;
        }).finally(() => { for (const x of chunk) inflight.delete(x.key); });
        for (const x of chunk) inflight.set(x.key, p);
        waits.push(p);
      }
      if (!waits.length) return true;
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
      const r = await Promise.race([Promise.all(waits).then((oks) => (oks.every(Boolean) ? 'ok' : 'error')), timeout]);
      clearTimeout(timer);
      if (r === 'timeout') stats.timeouts++;
      return r === 'ok';
    },
    close() { store?.close(); },
  };
}
