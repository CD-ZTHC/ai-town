// LLM 客户端的请求管线：用假 provider 检查 JSON 模式降级、鉴权失败不重试、用量统计、并发上限
import test from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'LLM_PROVIDER', 'LLM_CONCURRENCY', 'LLM_JSON_MODE', 'LLM_DAILY_TOKENS', 'PUBLIC_MODE', 'LLM_RECORD']) delete process.env[k];
const llm = await import('../server/llm.js');
const { createProvider, registerProvider, openaiCompatible } = await import('../server/llm-providers.js');

/** 假 provider：按顺序执行 steps 里的回复（函数或返回值），记录每次请求 */
function fake(steps) {
  const reqs = [];
  return {
    reqs,
    name: 'fake',
    enabled: true,
    async complete(req) {
      reqs.push(req);
      const step = steps[Math.min(reqs.length - 1, steps.length - 1)];
      return typeof step === 'function' ? step(req) : step;
    },
  };
}
const ok = (content, prompt = 10, completion = 5) => ({ content, usage: { prompt, completion }, finishReason: 'stop' });

test('未配置时不可用；未知的 provider 名字会报错', () => {
  assert.equal(llm.stats.enabled, false);
  assert.equal(createProvider('openai', {}).enabled, false);
  assert.equal(createProvider('openai', { BASE_URL: 'http://x/v1', API_KEY: 'k' }).enabled, true);
  assert.throws(() => createProvider('nope', {}), /未知的 LLM_PROVIDER/);
  registerProvider('fake-registered', () => fake([ok('{}')]));
  assert.equal(createProvider('fake-registered', {}).name, 'fake');
  assert.throws(() => registerProvider('openai', () => null), /已存在/);
});

test('请求走 provider，并统计按模块的用量', async () => {
  const p = fake([ok('{"a":1}', 30, 12)]);
  llm.setProvider(p);
  assert.equal(llm.stats.enabled, true);
  const before = llm.stats.dayTokens;
  const res = await llm.chatJSON([{ role: 'user', content: 'hi' }], { label: '测试模块', maxTokens: 99, temperature: 0.3 });
  assert.deepEqual(res, { a: 1 });
  assert.equal(p.reqs.length, 1);
  assert.equal(p.reqs[0].json, true, 'chatJSON 默认请求 JSON 模式');
  assert.equal(p.reqs[0].maxTokens, 99);
  assert.equal(p.reqs[0].temperature, 0.3);
  assert.ok(p.reqs[0].signal instanceof AbortSignal);
  assert.equal(llm.stats.dayTokens - before, 42);
  assert.deepEqual({ ...llm.stats.byLabel['测试模块'], ms: 0 }, { calls: 1, fails: 0, tokens: 42, ms: 0 });
});

test('网关不支持 JSON 模式：自动关闭后重试，之后的请求也不再带', async () => {
  const p = fake([
    (req) => { if (req.json) throw new Error('response_format is not supported'); return ok('{"b":2}'); },
  ]);
  llm.setProvider(p);
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'json' }), { b: 2 });
  assert.deepEqual(p.reqs.map((r) => r.json), [true, false]);
  await llm.chatJSON([{ role: 'user', content: 'y' }], { label: 'json' });
  assert.equal(p.reqs.at(-1).json, false);
});

test('鉴权失败不重试；空回复会重试到次数用完', async () => {
  const auth = fake([() => { throw new Error('Invalid API key'); }]);
  llm.setProvider(auth);
  const errs = llm.stats.errors;
  await assert.rejects(llm.chat([{ role: 'user', content: 'x' }], { label: 'auth', attempts: 3 }), /Invalid API key/);
  assert.equal(auth.reqs.length, 1);
  assert.equal(llm.stats.errors, errs + 1);
  assert.equal(llm.stats.byLabel.auth.fails, 1);

  const empty = fake([ok('  '), ok('终于有内容了')]);
  llm.setProvider(empty);
  assert.equal(await llm.chat([{ role: 'user', content: 'x' }], { label: 'empty', attempts: 2 }), '终于有内容了');
  assert.equal(empty.reqs.length, 2);
});

test('同时在飞的请求不超过并发上限（默认 4）', async () => {
  let inflight = 0, peak = 0;
  const release = [];
  const p = fake([() => {
    inflight++; peak = Math.max(peak, inflight);
    return new Promise((r) => release.push(() => { inflight--; r(ok('done')); }));
  }]);
  llm.setProvider(p);
  const all = Array.from({ length: 7 }, (_, i) => llm.chat([{ role: 'user', content: String(i) }], { label: 'conc' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 4);
  assert.equal(llm.queueSize(), 7, '3 个排队 + 4 个在飞');
  while (release.length || inflight) { release.splice(0).forEach((f) => f()); await new Promise((r) => setImmediate(r)); }
  assert.deepEqual(await Promise.all(all), Array(7).fill('done'));
  assert.equal(peak, 4);
});

test('OpenAI 兼容 provider：请求体与回复解析', async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
    if (JSON.parse(init.body).model === 'bad') return new Response('<html>502</html>', { status: 502 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  };
  const p = openaiCompatible({ baseUrl: 'http://gw/v1/', apiKey: 'sk' });
  assert.deepEqual(await p.listModels(), ['m1', 'm2']);
  const r = await p.complete({ model: 'm1', messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10, json: true });
  assert.deepEqual(r, { content: 'hi', usage: { prompt: 7, completion: 3 }, finishReason: 'stop' });
  const req = calls.at(-1);
  assert.equal(req.url, 'http://gw/v1/chat/completions');
  assert.equal(req.init.headers.Authorization, 'Bearer sk');
  assert.deepEqual(JSON.parse(req.init.body), { model: 'm1', messages: [{ role: 'user', content: 'x' }], temperature: 0.5, max_tokens: 10, reasoning_effort: 'low', response_format: { type: 'json_object' } });
  await assert.rejects(p.complete({ model: 'bad', messages: [] }), /HTTP 502: <html>502/);
});
