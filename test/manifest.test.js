// 能力清单文档必须与代码同步：新增扩展或操作后请运行 mise run manifest
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { defaultSpec } = await import('../server/kernel/spec.js');
await import('../plugin-host/builtin.js');
const { manifestMarkdown } = await import('../server/worldai/manifest.js');

test('docs/capabilities.md 与代码一致（不一致时运行 mise run manifest）', () => {
  const file = fs.readFileSync(new URL('../docs/capabilities.md', import.meta.url), 'utf8');
  assert.equal(file, manifestMarkdown(defaultSpec({})));
});
