// 记忆检索：相关性排序、双字组缓存在记忆文本变化后不会过期
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMemory, retrieve, similarity } from '../server/memory.ts';

const agent = () => ({ id: 'x', memories: [] as Memory[] });

test('相关的记忆排在前面，结果按时间顺序返回', () => {
  const a = agent();
  addMemory(a, { t: 0, text: '在码头看了夕阳', importance: 3 });
  addMemory(a, { t: 10, text: '和苏墨聊起萤火节的灯笼', importance: 3 });
  addMemory(a, { t: 20, text: '去农场买了西瓜', importance: 3 });
  const [top] = retrieve(a, '萤火节 灯笼', 30, 1);
  assert.match(top.text, /萤火节/);
  const all = retrieve(a, '萤火节', 30, 3);
  assert.deepEqual(all.map((m) => m.t), [0, 10, 20]);
});

test('记忆文本被改写后，检索用的是新文本', () => {
  const a = agent();
  const m = addMemory(a, { t: 0, text: '今天去码头钓鱼', importance: 3 });
  addMemory(a, { t: 0, text: '傍晚在码头边散步', importance: 3 });
  assert.equal(retrieve(a, '码头钓鱼', 0, 1)[0], m);
  m.text = '今天去工坊扎灯';
  assert.notEqual(retrieve(a, '码头钓鱼', 0, 1)[0], m);
  assert.equal(retrieve(a, '工坊扎灯', 0, 1)[0], m);
});

test('相似度：相同为 1，无关为 0', () => {
  assert.equal(similarity('镜湖传说', '镜湖传说'), 1);
  assert.equal(similarity('镜湖传说', '西瓜农场'), 0);
});

// ---------- 压缩与整理 ----------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_CAP, condenseCandidate, ruleSummary, replaceWithSummary, cosine } from '../server/memory.ts';
import { createEmbedder } from '../server/embeddings.ts';
import type { Memory } from '../server/types/agent.ts';

test('记忆满了：最早一天的琐事压缩成一条摘要，而不是直接删掉；重要记忆与反思不动', () => {
  const a = agent();
  addMemory(a, { t: 0, text: '第一次见到镜湖的紫光', importance: 8 });
  addMemory(a, { t: 5, text: '领悟：大家在一起就不怕', importance: 7, type: 'reflect' });
  for (let i = 0; i < MEMORY_CAP - 2; i++) addMemory(a, { t: 10 + i * 20, text: `第${i}件小事：去了趟集市`, importance: 2 });
  assert.equal(a.memories.length, MEMORY_CAP);
  addMemory(a, { t: 99999, text: '新的一件事', importance: 3 });
  assert.ok(a.memories.length < MEMORY_CAP, `压缩后应该腾出好几个位置：${a.memories.length}`);
  const s = a.memories.find((m) => m.type === 'summary');
  assert.ok(s, '有一条摘要');
  assert.equal(s.day, 1);
  assert.match(s.text, /^第1天的零碎记忆：/);
  assert.ok(s.count! >= 5);
  assert.ok(a.memories.some((m) => m.text === '第一次见到镜湖的紫光'));
  assert.ok(a.memories.some((m) => m.type === 'reflect'));
  assert.equal(a.memories.at(-1)!.text, '新的一件事', '刚写入的记忆不会被压缩掉');
  for (let i = 1; i < a.memories.length; i++) assert.ok(a.memories[i - 1].t <= a.memories[i].t, '仍按时间排序');
});

test('候选与规则摘要：只挑够数的最早一天；摘要不再被压缩', () => {
  const a = agent();
  for (let i = 0; i < 3; i++) addMemory(a, { t: i, text: `第一天小事${i}`, importance: 2 });
  for (let i = 0; i < 6; i++) addMemory(a, { t: 1440 + i, text: `第二天小事${i}`, importance: 2 + (i % 3) });
  const c = condenseCandidate(a, { minItems: 5 });
  assert.equal(c!.day, 2);
  assert.equal(c!.items.length, 6);
  assert.equal(condenseCandidate(a, { minItems: 5, beforeDay: 2 }), null);
  const text = ruleSummary(c!.day, c!.items);
  assert.match(text, /^第2天的零碎记忆：.*（共6件小事）$/);
  const s = replaceWithSummary(a, c!.items, { text, day: c!.day });
  assert.equal(a.memories.length, 4);
  assert.equal(s!.count, 6);
  assert.equal(condenseCandidate(a, { minItems: 1, beforeDay: 3 })!.day, 1, '摘要本身不算琐碎记忆');
});

test('每晚整理：有模型时用模型的第一人称概括，失败时用规则摘要；没超过阈值不整理', async (t) => {
  for (const k of ['BASE_URL', 'API_KEY', 'MODEL', 'LLM_PROVIDER', 'EMBED_MODEL']) delete process.env[k];
  const { Town } = await import('../server/sim.ts');
  const llm = await import('../server/llm.ts');
  const town = new Town({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'town-mem-')) });
  t.after(() => { town.stop(); llm.setMock(null); });
  const a = town.byId.lin;
  a.memories = [];
  // 第 1、2 天各 60 条，第 3 天 250 条：共 370 条，整理完一天还剩 311 条（仍超过 300），可以再整理一天
  for (const [d, n] of [[0, 60], [1, 60], [2, 250]]) for (let i = 0; i < n; i++) addMemory(a, { t: d * 1440 + 400 + i, text: `第${d + 1}天第${i}件小事`, importance: 2 });
  town.t = 3 * 1440 + 22 * 60; // 第 4 天晚上：可以整理第 1、2 天
  let prompt = '';
  llm.setMock((messages, opts) => { prompt = messages.at(-1)!.content; assert.equal(opts.label, '记忆整理'); return '{"summary":"那天忙忙碌碌，跑了好多趟腿。"}'; });
  const s1 = await town.condenseMemories(a);
  assert.equal(s1!.text, '第1天：那天忙忙碌碌，跑了好多趟腿。');
  assert.equal(s1!.importance, 5);
  assert.match(prompt, /林晓雨第1天经历的这些小事/);
  llm.setMock(() => { throw new Error('模型挂了'); });
  const s2 = await town.condenseMemories(a);
  assert.match(s2!.text, /^第2天的零碎记忆：/, '失败时用规则摘要');
  assert.equal(a.memories.length, 370 - 60 - 60 + 2);
  assert.equal(await town.condenseMemories(a), null, '剩下的不到 300 条，不再整理');
});

test('embedding：向量按文本缓存（node:sqlite），重启后不用重算；语义相近的记忆排到前面', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-embed-'));
  // 假 embedding：同一个「主题」的文本得到相近的向量
  const topic = (s: string) => (/湖|水|紫光/.test(s) ? [1, 0.1, 0] : /咖啡|拿铁/.test(s) ? [0, 1, 0.1] : [0.1, 0, 1]);
  let calls = 0;
  const embed = async (texts: string[]) => { calls++; return { vectors: texts.map(topic), tokens: texts.length }; };
  const e1 = createEmbedder({ dir, embed });
  const a = agent();
  addMemory(a, { t: 0, text: '清晨去码头看紫光', importance: 3 });
  addMemory(a, { t: 0, text: '给客人做了一杯拿铁', importance: 4 }); // 只看双字组时它排第一
  addMemory(a, { t: 0, text: '去工坊修椅子', importance: 3 });
  assert.equal(await e1.ensure(['湖水', ...a.memories.map((m) => m.text)]), true);
  assert.equal(calls, 1);
  if (e1.persistent) {
    e1.close();
    const e2 = createEmbedder({ dir, embed });
    t.after(() => e2.close());
    assert.equal(await e2.ensure(a.memories.map((m) => m.text)), true);
    assert.equal(calls, 1, '重启后直接读 sqlite 缓存');
    assert.deepEqual([...e2.vec('清晨去码头看紫光')!].map((x) => Math.round(x * 10) / 10), [1, 0.1, 0]);
  } else {
    t.diagnostic('当前 Node 不支持 node:sqlite，只验证了内存缓存');
    t.after(() => e1.close());
  }
  // 「湖水」和「紫光」没有共同的双字，只有语义检索能找到
  assert.equal(retrieve(a, '湖水', 0, 1)[0].text, '给客人做了一杯拿铁');
  const q = e1.vec('湖水') || topic('湖水');
  assert.equal(retrieve(a, '湖水', 0, 1, { qvec: q, vecOf: (m) => topic(m.text) })[0].text, '清晨去码头看紫光');
  assert.ok(cosine([1, 0], [1, 0]) > 0.99 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

test('embedding：超时或出错时不抛错，这次退回双字组；没配置时不启用', async () => {
  const slow = createEmbedder({ env: { EMBED_TIMEOUT_MS: '30' }, embed: () => new Promise((r) => setTimeout(() => r({ vectors: [[1]] }), 200)) });
  assert.equal(await slow.ensure(['a']), false);
  assert.equal(slow.stats.timeouts, 1);
  const bad = createEmbedder({ embed: async () => { throw new Error('boom'); } });
  assert.equal(await bad.ensure(['a']), false);
  assert.equal(bad.stats.errors, 1);
  assert.equal(createEmbedder({ env: {} }).enabled, false);
  assert.equal(createEmbedder({ env: { EMBED_MODEL: 'e', BASE_URL: 'http://x', API_KEY: 'k' } }).enabled, true);
  await new Promise((r) => setTimeout(r, 250)); // 让超时的请求在后台结束
});

test('接进小镇：配置了 embedding 时，语义相关的记忆会出现在提示词里', async (t) => {
  const { Town } = await import('../server/sim.ts');
  const llm = await import('../server/llm.ts');
  const topic = (s: string) => (/湖|水|紫光|涟漪/.test(s) ? [1, 0, 0] : [0, 1, 0]);
  const embedder = createEmbedder({ embed: async (texts) => ({ vectors: texts.map(topic) }) });
  const town = new Town({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'town-recall-')), embedder });
  t.after(() => { town.stop(); llm.setMock(null); });
  const a = town.byId.lin;
  a.memories = [];
  addMemory(a, { t: 0, text: '清晨看见湖面泛起紫色涟漪', importance: 2 });
  for (let i = 0; i < 30; i++) addMemory(a, { t: 60 + i, text: `帮客人结账第${i}次`, importance: 4 });
  const plain = town.memBlock(a, '想去看看水边', 5);
  assert.doesNotMatch(plain, /紫色涟漪/, '只看双字组时找不到');
  const withEmbed = await town.recall(a, '想去看看水边', 5);
  assert.match(withEmbed, /紫色涟漪/);
  // 真实的提示词链路：重新规划
  let prompt = '';
  llm.setMock((messages) => { prompt = messages.at(-1)!.content; return '{"reaction":"好","thought":"嗯","schedule":[]}'; });
  await town.replan(a, '有人说水边出现了怪事');
  assert.match(prompt, /紫色涟漪/);
});
