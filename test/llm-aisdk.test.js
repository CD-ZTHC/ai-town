// AI SDK 适配器（anthropic / google / aisdk 类型）：没装 AI SDK 时整组跳过（它是可选依赖）。
// 用本地的假服务分别模拟 OpenAI 兼容网关与 Anthropic Messages 接口，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { aisdkProvider, parseModelName, toPrompt } from '../server/llm-aisdk.js';
import { createProvider, credentialProvider } from '../server/llm-providers.js';
import { SETTINGS, parseString } from '../server/settings/schema.js';

let installed = true;
try { await import('ai'); } catch { installed = false; }
const skip = installed ? false : '未安装 AI SDK（npm install 后再测）';

test('模型名解析与消息转换', () => {
  assert.deepEqual(parseModelName('anthropic/claude-sonnet-5'), { provider: 'anthropic', id: 'claude-sonnet-5' });
  assert.deepEqual(parseModelName('google/gemini-3-pro'), { provider: 'google', id: 'gemini-3-pro' });
  assert.deepEqual(parseModelName('glm-5.3'), { provider: 'custom', id: 'glm-5.3' });
  assert.deepEqual(parseModelName('meta/llama'), { provider: 'custom', id: 'meta/llama' }, '不认识的前缀属于网关自己的模型名');
  const p = toPrompt([{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  assert.equal(p.system, 'A\n\nB');
  assert.deepEqual(p.messages, [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
});

test('是否可用；LLM_PROVIDER=pi 的旧配置按 aisdk 处理', () => {
  assert.equal(aisdkProvider({ kind: 'aisdk' }).enabled, false);
  assert.equal(aisdkProvider({ kind: 'aisdk', models: ['glm'] }).enabled, false, '自定义网关要有地址和密钥');
  assert.equal(aisdkProvider({ kind: 'aisdk', models: ['glm'], baseUrl: 'http://x', apiKey: 'k' }).enabled, true);
  assert.equal(aisdkProvider({ kind: 'aisdk', models: ['anthropic/claude-sonnet-5'] }).enabled, true);
  assert.equal(aisdkProvider({ kind: 'anthropic', apiKey: 'k' }).enabled, true);
  assert.equal(aisdkProvider({ kind: 'anthropic', strictKey: true }).enabled, false);
  assert.equal(parseString(SETTINGS.LLM_PROVIDER, 'pi'), 'aisdk');
  assert.equal(createProvider('pi', { MODEL: 'anthropic/x' }).name, 'aisdk');
  assert.throws(() => credentialProvider({ provider: 'aisdk', apiKey: 'k' }), /不支持/, 'aisdk 会读服务器的环境变量，不能给凭据用');
  assert.throws(() => credentialProvider({ provider: 'anthropic', apiKey: '' }), /没有密钥/);
});

/** 假服务：/v1/chat/completions（OpenAI 兼容）与 /v1/messages（Anthropic），按 mode 返回回复或错误 */
async function fakeServer(t) {
  const s = { mode: 'ok', reply: '{"ok":true}', reqs: [] };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      s.reqs.push({ url: req.url, headers: req.headers, body });
      const send = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.endsWith('/models') || req.url.includes('/models?')) return send(200, { data: [{ id: 'glm-test' }, { id: 'claude-test' }] });
      if (s.mode === '429') return send(429, { error: { message: '请求频率过高，请稍后再试' } });
      if (s.mode === '401') return send(401, { error: { message: 'Invalid API key' } });
      if (s.mode === 'no-json' && body.response_format) return send(400, { error: { message: 'response_format is not supported' } });
      if (req.url.endsWith('/messages')) {
        return send(200, { id: 'm1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: s.reply }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } });
      }
      send(200, { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: s.reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 4 } });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  s.base = `http://127.0.0.1:${srv.address().port}/v1`;
  s.chats = () => s.reqs.filter((x) => x.url.endsWith('/chat/completions'));
  return s;
}

test('aisdk 的自定义网关：请求体、鉴权、用量、JSON 模式与模型列表', { skip }, async (t) => {
  const s = await fakeServer(t);
  const p = aisdkProvider({ kind: 'aisdk', baseUrl: `${s.base}/`, apiKey: 'sk-test', models: ['glm-test', 'anthropic/claude-x'] });
  const r = await p.complete({ model: 'glm-test', messages: [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: '你好' }], temperature: 0.2, maxTokens: 50, json: true });
  assert.deepEqual(r, { content: '{"ok":true}', usage: { prompt: 11, completion: 4 }, finishReason: 'stop' });
  const call = s.chats().at(-1);
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(call.body.messages, [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: '你好' }]);
  assert.equal(call.body.model, 'glm-test');
  assert.equal(call.body.max_tokens, 50);
  assert.equal(call.body.temperature, 0.2);
  assert.equal(call.body.reasoning_effort, 'low');
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  await p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: false });
  assert.equal(s.chats().at(-1).body.response_format, undefined, '不要 JSON 时不带 response_format');
  await p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: true, schema: { name: 's', schema: { type: 'object' } } });
  assert.deepEqual(s.chats().at(-1).body.response_format, { type: 'json_schema', json_schema: { name: 's', schema: { type: 'object' }, strict: false } });
  assert.deepEqual(await p.listModels(), ['glm-test', 'claude-test', 'anthropic/claude-x']);
});

test('模型输出不是合法 JSON 时把原文交回（由 llm.js 修复），而不是抛错', { skip }, async (t) => {
  const s = await fakeServer(t);
  s.reply = '好的：{"a":1,}';
  const p = aisdkProvider({ kind: 'aisdk', baseUrl: s.base, apiKey: 'k', models: ['glm-test'] });
  const r = await p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: true });
  assert.equal(r.content, '好的：{"a":1,}');
  assert.equal(r.usage.prompt, 11);
});

test('错误信息保留上游状态码与原文；AI SDK 自己不重试', { skip }, async (t) => {
  const s = await fakeServer(t);
  const p = aisdkProvider({ kind: 'aisdk', baseUrl: s.base, apiKey: 'k', models: ['glm-test'] });
  const call = () => p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: true, maxTokens: 10 });
  s.mode = '429';
  await assert.rejects(call, (e) => /429.*请求频率过高/.test(e.message) && e.status === 429);
  s.mode = '401';
  await assert.rejects(call, (e) => /401.*Invalid API key/.test(e.message) && e.status === 401);
  s.mode = 'no-json';
  await assert.rejects(call, /response_format/);
  assert.equal(s.chats().length, 3);
});

test('anthropic 类型：官方协议、凭据的密钥与地址、用量', { skip }, async (t) => {
  const s = await fakeServer(t);
  const p = aisdkProvider({ kind: 'anthropic', baseUrl: s.base, apiKey: 'sk-ant-1' });
  const r = await p.complete({ model: 'claude-test', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }], maxTokens: 20, json: true });
  assert.deepEqual(r.usage, { prompt: 7, completion: 3 });
  assert.equal(r.content, '{"ok":true}');
  const call = s.reqs.at(-1);
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-ant-1');
  assert.equal(call.body.system?.[0]?.text ?? call.body.system, 'S');
  assert.deepEqual(await p.listModels(), ['glm-test', 'claude-test']);
});

test('凭据绝不借用服务器环境变量里的密钥；请求经过注入的 fetch', { skip }, async (t) => {
  const s = await fakeServer(t);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-SERVER';
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });
  const seen = [];
  const f = (url, init) => { seen.push(String(url)); return fetch(url, init); };
  const p = credentialProvider({ provider: 'anthropic', baseUrl: s.base, apiKey: 'sk-USER', fetch: f });
  await p.complete({ model: 'claude-test', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
  assert.equal(s.reqs.at(-1).headers['x-api-key'], 'sk-USER');
  assert.equal(seen.length, 1, '请求经过注入的 fetch');
  // 即便有人把密钥清空（绕过构造时的检查），发请求前也会被拦下，而不是退回服务器的密钥
  const bad = aisdkProvider({ kind: 'anthropic', baseUrl: s.base, apiKey: '', strictKey: true });
  const n = s.reqs.length;
  await assert.rejects(bad.complete({ model: 'claude-test', messages: [{ role: 'user', content: 'x' }] }), /没有密钥/);
  assert.equal(s.reqs.length, n, '没有发出任何请求');
});

test('接进 llm.js：LLM_PROVIDER=aisdk 时 chatJSON 端到端可用，不支持 JSON 模式会自动降级', { skip }, async (t) => {
  const s = await fakeServer(t);
  s.mode = 'no-json';
  const llm = await import('../server/llm.js');
  llm.setProvider(createProvider('aisdk', { BASE_URL: s.base, API_KEY: 'k', MODEL: 'glm-test' }));
  t.after(() => { llm.setProvider(null); llm.setJsonMode(true); });
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'aisdk', tier: 'default', model: 'glm-test' }), { ok: true });
  assert.deepEqual(s.chats().map((x) => Boolean(x.body.response_format)), [true, false]);
  assert.equal(llm.stats.byLabel.aisdk.tokens, 15);
});

test('没装 AI SDK 时给出明确的安装提示', async () => {
  const p = aisdkProvider({ kind: 'anthropic', apiKey: 'k', load: async () => { throw new Error('这种模型服务需要先安装 AI SDK：在项目目录运行 npm install（它是可选依赖）'); } });
  await assert.rejects(p.complete({ model: 'x', messages: [] }), /npm install/);
});
