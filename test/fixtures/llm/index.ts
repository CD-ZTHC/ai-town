// 录制好的 LLM 回复：按模块（label）分组，同一模块的多条回复轮流使用，结果可复现。
// responses.json 可以手写，也可以用真实模型录制：LLM_RECORD=路径 mise run start（见 server/llm.js）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'responses.json');

export function loadFixtures(file = FIXTURE_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 生成一个可以交给 llm.setMock() 的假模型。
 * 没有录制的模块会抛错，调用方照常走兜底逻辑；calls 记录每个模块被调用的次数。
 */
export function fixtureMock(fixtures = loadFixtures()) {
  const calls = {};
  const mock = (messages, opts = {}) => {
    const label = opts.label || 'llm';
    const list = fixtures[label];
    const n = (calls[label] = (calls[label] || 0) + 1);
    if (!Array.isArray(list) || !list.length) throw new Error(`没有录制的回复：${label}`);
    const r = list[(n - 1) % list.length];
    return typeof r === 'string' ? r : JSON.stringify(r);
  };
  return Object.assign(mock, { calls });
}
