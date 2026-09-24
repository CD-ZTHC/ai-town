// LLM 客户端：JSON 提取与常见格式错误的修复
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON } from '../server/llm.js';

test('提取 JSON：去掉 markdown 代码块与前后说明文字', () => {
  assert.deepEqual(extractJSON('好的：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('[1,2]'), [1, 2]);
  assert.throws(() => extractJSON('没有 JSON'), /没有 JSON/);
});

test('修复模型常见的小格式错误', () => {
  assert.deepEqual(extractJSON('{"memories":{"何月"："我答应了","赵铁柱" ： "包在我身上"}}'), { memories: { 何月: '我答应了', 赵铁柱: '包在我身上' } }, '全角冒号');
  assert.deepEqual(extractJSON('{"tags":["镜湖"，"传说"]}'), { tags: ['镜湖', '传说'] }, '全角逗号');
  assert.deepEqual(extractJSON('{"affinity":[{"delta":+3},{"delta":-2}]}'), { affinity: [{ delta: 3 }, { delta: -2 }] }, '+ 号');
  assert.deepEqual(extractJSON('{“a”:“b”,}'), { a: 'b' }, '中文引号与尾逗号');
  assert.deepEqual(extractJSON('{"text":"他说：好"}'), { text: '他说：好' }, '字符串内容里的全角冒号保持不变');
});
