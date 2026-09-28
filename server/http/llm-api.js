// 模型服务凭据接口（按世界配置模型服务设计 §10.1）
//   /api/me/llm-credentials      自己的凭据（需要 genesis 授予；只能操作自己的）
//   /api/admin/llm-credentials   站点凭据（owner = 'site'，只给官方世界用；管理员）
//     GET    /            列表（不含密钥，只有末 4 位）与引用它的世界
//     POST   /            { name, provider, baseUrl, apiKey }
//     PATCH  /:id         { name?, provider?, baseUrl?, apiKey? }（不传 apiKey = 不改）；地址或密钥改了会自动测试，通过则恢复相关世界
//     DELETE /:id         被世界引用时需要 ?confirm=1；确认后这些世界暂停
//     POST   /:id/test    测试连接（列出模型 + 一次很短的补全），每人每分钟 3 次
import { Hono } from 'hono';
import { authorize } from '../accounts/authz.js';
import { SITE } from '../accounts/llm-credentials.js';
import { quota } from '../accounts/quota.js';
import { get as setting } from '../settings/index.ts';
import { HttpError } from './util.js';

const clip = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * @param {object} deps
 * @param {import('../accounts/llm-credentials.js').LlmCredentials} deps.credentials
 * @param {ReturnType<import('../world-llm.ts').createWorldLlm>} deps.worldLlm
 * @param {import('../accounts/index.js').Accounts} [deps.accounts]
 * @param {'user'|'site'} deps.scope
 */
export function credentialsApi({ credentials, worldLlm, accounts = null, scope = 'user' }) {
  const api = new Hono();
  const audit = (e) => accounts?.audit(e);

  /** 这个请求操作的是谁的凭据 */
  const ownerOf = (c) => {
    if (scope === 'site') {
      if (!c.get('admin')) throw new HttpError(403, '只有管理员可以这样做');
      return SITE;
    }
    const user = c.get('user');
    if (!user) throw new HttpError(401, '请先登录', { login: true });
    const ok = authorize(c.get('who'), 'genesis', null, { grant: () => accounts?.grant(user.id, 'genesis') });
    if (ok !== true) throw new HttpError(403, ok);
    return user.id;
  };
  const actor = (c) => c.get('user')?.id || 'admin';
  const mine = (c) => {
    const owner = ownerOf(c);
    const cred = credentials.get(c.req.param('id'));
    if (!cred || cred.owner !== owner) throw new HttpError(404, '凭据不存在');
    return cred;
  };
  const withUse = (cred) => ({ ...cred, worlds: worldLlm.worldsUsing(cred.id).map((w) => ({ id: w.id, title: w.title, halted: Boolean(w.settings.ai.halt) })) });

  api.get('/', (c) => {
    const owner = ownerOf(c);
    return c.json({ list: credentials.list(owner).map(withUse), max: owner === SITE ? null : setting('USER_LLM_CREDENTIALS_MAX'), providers: owner === SITE ? ['openai', 'anthropic', 'google'] : setting('USER_LLM_PROVIDERS'), enabled: setting('USER_LLM') || owner === SITE, privateNet: owner === SITE || setting('USER_LLM_PRIVATE_NET') });
  });

  api.post('/', (c) => {
    const owner = ownerOf(c);
    if (owner !== SITE && credentials.count(owner) >= setting('USER_LLM_CREDENTIALS_MAX')) throw new HttpError(403, `最多保存 ${setting('USER_LLM_CREDENTIALS_MAX')} 份模型服务`);
    const b = c.get('body');
    const input = { name: clip(b.name, 20) || '我的模型服务', provider: clip(b.provider, 20), baseUrl: clip(b.baseUrl, 500).replace(/\/+$/, ''), apiKey: String(b.apiKey ?? '').trim() };
    const p = worldLlm.credentialProblem(input, { owner });
    if (p) throw new HttpError(400, p);
    const cred = credentials.create({ owner, ...input });
    audit({ actor: actor(c), action: 'llm.credential.create', target: cred.id, detail: { owner, provider: cred.provider, baseUrl: cred.baseUrl, keyLast4: cred.keyLast4 } });
    return c.json({ ok: true, credential: withUse(cred) });
  });

  api.patch('/:id', async (c) => {
    const cred = mine(c);
    const b = c.get('body');
    const patch = {};
    if (b.name !== undefined) patch.name = clip(b.name, 20) || cred.name;
    if (b.provider !== undefined) patch.provider = clip(b.provider, 20);
    if (b.baseUrl !== undefined) patch.baseUrl = clip(b.baseUrl, 500).replace(/\/+$/, '');
    if (b.apiKey) patch.apiKey = String(b.apiKey).trim();
    const p = worldLlm.credentialProblem({ provider: patch.provider ?? cred.provider, baseUrl: patch.baseUrl ?? cred.baseUrl, apiKey: patch.apiKey }, { owner: cred.owner, partial: true });
    if (p) throw new HttpError(400, p);
    if ((patch.provider ?? cred.provider) === 'openai' && !(patch.baseUrl ?? cred.baseUrl)) throw new HttpError(400, 'OpenAI 兼容接口需要填写接口地址');
    const next = credentials.update(cred.id, patch);
    worldLlm.credentialChanged(cred.id);
    audit({ actor: actor(c), action: 'llm.credential.update', target: cred.id, detail: { fields: Object.keys(patch), keyLast4: next.keyLast4 } });
    // 地址、类型或密钥变了：自动测试，通过就恢复因它暂停的世界
    let test = null;
    if ((patch.apiKey || patch.baseUrl !== undefined || patch.provider !== undefined) && quota(c.get('who') || {}, 'llm-test').ok) test = await worldLlm.checkCredential(cred.id, { by: actor(c) });
    return c.json({ ok: true, credential: withUse(credentials.get(cred.id)), test });
  });

  api.delete('/:id', (c) => {
    const cred = mine(c);
    const using = worldLlm.worldsUsing(cred.id);
    if (using.length && c.req.query('confirm') !== '1') throw new HttpError(409, `还有 ${using.length} 个世界在用它，删除后这些世界会暂停`, { worlds: using.map((w) => ({ id: w.id, title: w.title })), confirm: true });
    credentials.remove(cred.id);
    worldLlm.credentialRemoved(cred.id);
    worldLlm.halt(using.map((w) => w.id), { code: 'credential', message: '模型服务凭据已删除', credential: cred.id });
    audit({ actor: actor(c), action: 'llm.credential.delete', target: cred.id, detail: { worlds: using.map((w) => w.id) } });
    return c.json({ ok: true, halted: using.map((w) => w.id) });
  });

  api.post('/:id/test', async (c) => {
    const cred = mine(c);
    const q = quota(c.get('who') || {}, 'llm-test');
    if (!q.ok) throw new HttpError(429, q.message, { retryAfter: q.retryAfter });
    const r = await worldLlm.checkCredential(cred.id, { by: actor(c) });
    audit({ actor: actor(c), action: 'llm.credential.test', target: cred.id, detail: { ok: r.ok, kind: r.kind || null } });
    return c.json({ ...r, credential: withUse(credentials.get(cred.id)) });
  });

  return api;
}
