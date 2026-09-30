// LLM 客户端的请求管线：用假 provider 检查 JSON 模式降级、鉴权失败不重试、用量统计、并发上限
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompleteArgs, CompleteResult } from '../server/types/llm.ts';
/** 假 provider 的一步：固定回复，或按请求生成回复的函数 */
type Step = CompleteResult | ((req: CompleteArgs) => unknown);

for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'MODEL_FAST', 'MODEL_SMART', 'LLM_PROVIDER', 'LLM_CONCURRENCY', 'LLM_JSON_MODE', 'LLM_DAILY_TOKENS', 'PUBLIC_MODE', 'LLM_RECORD']) delete process.env[k];
const llm = await import('../server/llm.ts');
const { createProvider, registerProvider, openaiCompatible } = await import('../server/llm-providers.ts');

/** 假 provider：按顺序执行 steps 里的回复（函数或返回值），记录每次请求 */
function fake(steps: Step[]) {
  const reqs: CompleteArgs[] = [];
  return {
    reqs,
    name: 'fake',
    enabled: true,
    async complete(req: CompleteArgs) {
      reqs.push(req);
      const step = steps[Math.min(reqs.length - 1, steps.length - 1)];
      return (typeof step === 'function' ? step(req) : step) as CompleteResult;
    },
  };
}
const ok = (content: string, prompt = 10, completion = 5): CompleteResult => ({ content, usage: { prompt, completion }, finishReason: 'stop' });

test('未配置时不可用；未知的 provider 名字会报错', () => {
  assert.equal(llm.stats.enabled, false);
  assert.equal(createProvider('openai', {}).enabled, false);
  assert.equal(createProvider('openai', { BASE_URL: 'http://x/v1', API_KEY: 'k' }).enabled, true);
  assert.throws(() => createProvider('nope', {}), /未知的 LLM_PROVIDER/);
  registerProvider('fake-registered', () => fake([ok('{}')]));
  assert.equal(createProvider('fake-registered', {}).name, 'fake');
  assert.throws(() => registerProvider('openai', () => null as never), /已存在/);
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
  assert.deepEqual({ ...llm.stats.byLabel['测试模块'], ms: 0 }, { calls: 1, fails: 0, tokens: 42, ms: 0, json: 1, repairs: 0, badJson: 0, schemaMiss: 0 });
});

test('网关不支持 JSON 模式：自动关闭后重试，之后的请求也不再带', async () => {
  const p = fake([
    (req: CompleteArgs) => { if (req.json) throw new Error('response_format is not supported'); return ok('{"b":2}'); },
  ]);
  llm.setProvider(p);
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'json' }), { b: 2 });
  assert.deepEqual(p.reqs.map((r) => r.json), [true, false]);
  await llm.chatJSON([{ role: 'user', content: 'y' }], { label: 'json' });
  assert.equal(p.reqs.at(-1)!.json, false);
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

test('同时在飞的请求不超过并发上限（默认 4），其中 1 个留给交互（P0）', async () => {
  let inflight = 0, peak = 0;
  const release: Array<() => void> = [];
  const p = fake([() => {
    inflight++; peak = Math.max(peak, inflight);
    return new Promise((r) => release.push(() => { inflight--; r(ok('done')); }));
  }]);
  llm.setProvider(p);
  const all = Array.from({ length: 7 }, (_, i) => llm.chat([{ role: 'user', content: String(i) }], { label: 'conc' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 3, '非交互的调用最多占 3 个');
  assert.equal(llm.queueSize(), 7, '4 个排队 + 3 个在飞');
  // 有人在等的交互（旅人聊天）立刻用上保留的那一个
  all.push(llm.chat([{ role: 'user', content: 'p0' }], { label: '与旅人交谈' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 4);
  while (release.length || inflight) { release.splice(0).forEach((f) => f()); await new Promise((r) => setImmediate(r)); }
  assert.deepEqual(await Promise.all(all), Array(8).fill('done'));
  assert.equal(peak, 4);
});

test('OpenAI 兼容 provider：请求体与回复解析', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
    if (JSON.parse(init!.body as string).model === 'bad') return new Response('<html>502</html>', { status: 502 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  }) as typeof fetch;
  const p = openaiCompatible({ baseUrl: 'http://gw/v1/', apiKey: 'sk' });
  assert.deepEqual(await p.listModels!(), ['m1', 'm2']);
  const r = await p.complete({ model: 'm1', messages: [{ role: 'user', content: 'x' }], temperature: 0.5, maxTokens: 10, json: true });
  assert.deepEqual(r, { content: 'hi', usage: { prompt: 7, completion: 3 }, finishReason: 'stop' });
  const req = calls.at(-1)!;
  assert.equal(req.url, 'http://gw/v1/chat/completions');
  assert.equal((req.init!.headers as Record<string, string>).Authorization, 'Bearer sk');
  assert.deepEqual(JSON.parse(req.init!.body as string), { model: 'm1', messages: [{ role: 'user', content: 'x' }], temperature: 0.5, max_tokens: 10, reasoning_effort: 'low', response_format: { type: 'json_object' } });
  await assert.rejects(p.complete({ model: 'bad', messages: [] }), /HTTP 502: <html>502/);
});

test('结构化输出：开启后把 schema 交给 provider；网关不支持时退回普通 JSON 模式', async () => {
  const schema = { name: 'x', schema: { type: 'object', properties: { a: { type: 'number' } } } };
  const p = fake([(req: CompleteArgs) => { if (req.schema) throw new Error("Invalid value for 'response_format.type': json_schema is not supported"); return ok('{"a":1}'); }]);
  llm.setProvider(p);
  llm.setJsonMode(true); // 前面的测试把 JSON 模式关掉了
  llm.setJsonSchema(false);
  await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'schema', schema });
  assert.equal(p.reqs.at(-1)!.schema, undefined, '没开启时不传 schema');
  llm.setJsonSchema(true);
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'schema', schema }), { a: 1 });
  assert.deepEqual(p.reqs.slice(-2).map((r) => [Boolean(r.schema), r.json]), [[true, true], [false, true]], '退回 json_object，仍然是 JSON 模式');
  await llm.chatJSON([{ role: 'user', content: 'x' }], { label: 'schema', schema });
  assert.equal(p.reqs.at(-1)!.schema, undefined, '之后不再发送 schema');
});

test('OpenAI 兼容 provider：有 schema 时发送非严格的 json_schema', async (t) => {
  const { responseFormat } = await import('../server/llm-providers.ts');
  assert.deepEqual(responseFormat(null), { type: 'json_object' });
  const { ARCHITECT_SCHEMA } = await import('../plugins/builtin/architect/architect.ts');
  const rf = responseFormat(ARCHITECT_SCHEMA);
  assert.equal(rf.type, 'json_schema');
  assert.equal(rf.json_schema!.name, 'world_patch');
  assert.equal(rf.json_schema!.strict, false);
  assert.ok((rf.json_schema!.schema as { properties: { ops: { items: { properties: { op: { enum: string[] } } } } } }).properties.ops.items.properties.op.enum.includes('addBuilding'));
  // 架构师确实带着 schema 调用
  let seen = null;
  llm.setMock((_m, opts) => { seen = opts; return '{"gap":{"need":"n","why":"w"}}'; });
  t.after(() => llm.setMock(null));
  const { Architect } = await import('../plugins/builtin/architect/architect.ts');
  await new Architect({} as never).ask([{ role: 'user', content: 'x' }]);
  assert.equal(seen!.schema, ARCHITECT_SCHEMA);
});

test('JSON 解析统计：一次修好计入 repairs，修不好计入 badJson', async () => {
  llm.setProvider(fake([ok('不是 JSON'), ok('{"fixed":true}'), ok('还不是'), ok('仍然不是')]));
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: '解析' }), { fixed: true });
  await assert.rejects(llm.chatJSON([{ role: 'user', content: 'x' }], { label: '解析' }));
  const s = llm.stats.byLabel['解析'];
  assert.deepEqual([s.json, s.repairs, s.badJson], [2, 2, 1]);
});

test('结构化输出（P8）：zod 定义转成 json_schema 发给网关；解析后不符合结构的计入 schemaMiss，结果照常返回', async (t) => {
  const { SCHEMAS } = await import('../server/llm-schemas.ts');
  const spec = SCHEMAS.diary;
  assert.equal(spec.name, 'diary');
  assert.equal(spec.schema.type, 'object');
  assert.deepEqual((spec.schema as { required: string[] }).required, ['diary']);
  assert.equal('$schema' in spec.schema, false);
  // 所有名字都符合 OpenAI 的要求
  for (const s of Object.values(SCHEMAS)) assert.match(s.name, /^[a-zA-Z0-9_-]{1,64}$/);
  const { responseFormat } = await import('../server/llm-providers.ts');
  const rf = responseFormat(spec) as { type: string; json_schema: Record<string, unknown> };
  assert.equal(rf.type, 'json_schema');
  assert.deepEqual(Object.keys(rf.json_schema).sort(), ['name', 'schema', 'strict'], 'zod 本身不会发给网关');

  const replies = ['{"diary":"今天很好"}', '{"text":"字段名写错了"}'];
  llm.setMock(async () => replies.shift()!);
  t.after(() => llm.setMock(null));
  const before = llm.stats.byLabel['日记测试']?.schemaMiss || 0;
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: '日记测试', schema: spec }), { diary: '今天很好' });
  assert.deepEqual(await llm.chatJSON([{ role: 'user', content: 'x' }], { label: '日记测试', schema: spec }), { text: '字段名写错了' }, '不拒绝，交给调用方兜底');
  assert.equal(llm.stats.byLabel['日记测试']!.schemaMiss - before, 1);
});
