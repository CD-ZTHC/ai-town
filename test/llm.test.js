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

test('台词里的引号：中文引号保持原样，没转义的英文引号被转义', () => {
  // 以前会把台词里的“”换成英文引号，一段只差尾逗号的 JSON 反而被改坏
  assert.deepEqual(extractJSON('{"lines":[{"text":"你看这“第三根桩”上的字"}],"summary":"x",}'), { lines: [{ text: '你看这“第三根桩”上的字' }], summary: 'x' });
  assert.deepEqual(extractJSON('{"memories":{"林晓雨":"我读到“旧信”，“木桩”也在","苏墨":"好"},}'), { memories: { 林晓雨: '我读到“旧信”，“木桩”也在', 苏墨: '好' } });
  assert.deepEqual(extractJSON('{"lines":[{"speaker":"林晓雨","text":"桩上刻着"第三根桩"几个字"}]}'), { lines: [{ speaker: '林晓雨', text: '桩上刻着"第三根桩"几个字' }] });
  assert.deepEqual(extractJSON('{"memories":{"林晓雨":"我在码头读到"旧信"，心里一紧","苏墨":"字迹是"第三根桩"：别动"}}'),
    { memories: { 林晓雨: '我在码头读到"旧信"，心里一紧', 苏墨: '字迹是"第三根桩"：别动' } });
  assert.deepEqual(extractJSON('{"summary":"第一行\n第二行"}'), { summary: '第一行\n第二行' }, '字符串里的换行');
  assert.deepEqual(extractJSON('{"a":"x \\"引\\" y"}'), { a: 'x "引" y' }, '已经转义的引号不动');
});

test('修不好时，报错里带上出错位置附近的原文', () => {
  assert.throws(() => extractJSON('{"lines":[{"speaker" "林晓雨"}]}'), /附近：.*林晓雨/);
});
