// 记忆检索：相关性排序、双字组缓存在记忆文本变化后不会过期
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMemory, retrieve, similarity } from '../server/memory.js';

const agent = () => ({ id: 'x', memories: [] });

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
