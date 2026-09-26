// pi-ai 适配器：没装 pi-ai 时整组跳过（它是可选依赖）。
// 自定义网关走一个本地的假 OpenAI 兼容服务（流式 SSE，与真实网关一致）；内置服务商走 pi-ai 自带的 faux provider。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { piProvider, parseModelName, toContext } from '../server/llm-pi.js';

let pi = null;
try { pi = await import('@earendil-works/pi-ai'); } catch {}
const skip = pi ? false : '未安装 @earendil-works/pi-ai（npm install 后再测）';

test('模型名解析与消息转换', () => {
  assert.deepEqual(parseModelName('anthropic/claude-sonnet-5'), { provider: 'anthropic', id: 'claude-sonnet-5' });
  assert.deepEqual(parseModelName('openrouter/meta/llama'), { provider: 'openrouter', id: 'meta/llama' });
  assert.deepEqual(parseModelName('glm-5.3'), { provider: 'custom', id: 'glm-5.3' });
  const ctx = toContext([
    { role: 'system', content: 'A' }, { role: 'system', content: 'B' },
    { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' },
  ], { api: 'x', provider: 'p', id: 'm' });
  assert.equal(ctx.systemPrompt, 'A\n\nB');
  assert.deepEqual(ctx.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(ctx.messages[1].content, [{ type: 'text', text: 'a' }]);
});

test('是否可用：自定义网关要有 BASE_URL 与 API_KEY；内置服务商只要有模型名', () => {
  assert.equal(piProvider({}).enabled, false);
  assert.equal(piProvider({ MODEL: 'glm' }).enabled, false);
  assert.equal(piProvider({ MODEL: 'glm', BASE_URL: 'http://x', API_KEY: 'k' }).enabled, true);
  assert.equal(piProvider({ MODEL: 'anthropic/claude-sonnet-5' }).enabled, true);
  assert.equal(piProvider({ MODEL: 'anthropic/claude-sonnet-5', MODEL_FAST: 'glm' }).enabled, false, '混用时自定义网关也要配置');
});

/** 假的 OpenAI 兼容网关：按 mode 返回流式回复或错误，记录收到的请求 */
async function fakeGateway(t) {
  const gw = { mode: 'ok', reqs: [] };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      gw.reqs.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'glm-test' }] }));
      const fail = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); };
      if (gw.mode === '429') return fail(429, '请求频率过高，请稍后再试');
      if (gw.mode === '401') return fail(401, 'Invalid API key');
      if (gw.mode === 'no-json' && body.response_format) return fail(400, 'response_format is not supported');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '{"ok":' } }] });
      chunk({ choices: [{ index: 0, delta: { content: 'true}' }, finish_reason: 'stop' }] });
      chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  gw.env = { BASE_URL: `http://127.0.0.1:${srv.address().port}/v1/`, API_KEY: 'sk-test', MODEL: 'glm-test' };
  return gw;
}

test('自定义网关：请求体、鉴权、流式回复与用量', { skip }, async (t) => {
  const gw = await fakeGateway(t);
  const p = piProvider(gw.env);
  const r = await p.complete({ model: 'glm-test', messages: [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: '你好' }], temperature: 0.2, maxTokens: 50, json: true });
  assert.deepEqual(r, { content: '{"ok":true}', usage: { prompt: 11, completion: 4 }, finishReason: 'stop' });
  const call = gw.reqs.find((x) => x.url.endsWith('/chat/completions'));
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.auth, 'Bearer sk-test');
  assert.deepEqual(call.body.messages, [{ role: 'system', content: '只输出 JSON' }, { role: 'user', content: '你好' }]);
  assert.equal(call.body.model, 'glm-test');
  assert.equal(call.body.max_tokens, 50);
  assert.equal(call.body.temperature, 0.2);
  assert.equal(call.body.reasoning_effort, 'low');
  assert.deepEqual(call.body.response_format, { type: 'json_object' });
  await p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: false });
  assert.equal(gw.reqs.at(-1).body.response_format, undefined, '不要 JSON 时不带 response_format');
  assert.deepEqual(await p.listModels(), ['glm-test']);
  const schema = { name: 's', schema: { type: 'object' } };
  await p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: true, schema });
  assert.deepEqual(gw.reqs.at(-1).body.response_format, { type: 'json_schema', json_schema: { name: 's', schema: { type: 'object' }, strict: false } });
});

test('自定义网关：错误信息保留上游状态码与原文，llm.js 才能识别限流 / 鉴权 / JSON 模式', { skip }, async (t) => {
  const gw = await fakeGateway(t);
  const p = piProvider(gw.env);
  const call = () => p.complete({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }], json: true, maxTokens: 10 });
  gw.mode = '429';
  await assert.rejects(call, /429.*请求频率过高/);
  gw.mode = '401';
  await assert.rejects(call, /Invalid API key/);
  gw.mode = 'no-json';
  await assert.rejects(call, /response_format/);
  assert.equal(gw.reqs.filter((x) => x.url.endsWith('/chat/completions')).length, 3, 'pi-ai 自己不重试');
});

test('接进 llm.js：LLM_PROVIDER=pi 时 chatJSON 端到端可用，不支持 JSON 模式会自动降级', { skip }, async (t) => {
  const gw = await fakeGateway(t);
  gw.mode = 'no-json';
  const llm = await import('../server/llm.js');
  llm.setProvider(piProvider(gw.env));
  t.after(() => llm.setMock(null));
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'pi', tier: 'default' }), { ok: true });
  const bodies = gw.reqs.filter((x) => x.url.endsWith('/chat/completions')).map((x) => Boolean(x.body.response_format));
  assert.deepEqual(bodies, [true, false]);
  assert.equal(llm.stats.byLabel.pi.tokens, 15);
});

test('内置服务商：按「服务商/模型」路由，assistant 消息能往回传，错误会抛出', { skip }, async () => {
  const faux = pi.fauxProvider();
  const models = pi.createModels();
  models.setProvider(faux.provider);
  const m = faux.getModel();
  const p = piProvider({ MODEL: `${m.provider}/${m.id}` }, { load: async () => ({ pi, models }) });
  assert.equal(p.enabled, true);
  assert.ok((await p.listModels()).includes(`${m.provider}/${m.id}`));
  faux.setResponses([pi.fauxAssistantMessage([pi.fauxText('{"hello":"world"}')])]);
  const r = await p.complete({ model: `${m.provider}/${m.id}`, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '不是 JSON' }, { role: 'user', content: '请只输出 JSON' }] });
  assert.equal(r.content, '{"hello":"world"}');
  assert.ok(r.usage.prompt > 0 && r.usage.completion > 0);
  // 队列空了：faux 返回错误消息而不是抛出，适配器要把它变成异常
  await assert.rejects(p.complete({ model: `${m.provider}/${m.id}`, messages: [{ role: 'user', content: 'x' }] }), /No more faux responses/);
  await assert.rejects(p.complete({ model: `${m.provider}/nope`, messages: [] }), /没有模型/);
});

test('没装 pi-ai 时给出明确的安装提示', async () => {
  const p = piProvider({ MODEL: 'anthropic/x' }, { load: async () => { throw new Error('LLM_PROVIDER=pi 需要先安装 @earendil-works/pi-ai：在项目目录运行 npm install（它是可选依赖）'); } });
  await assert.rejects(p.complete({ model: 'anthropic/x', messages: [] }), /npm install/);
});
