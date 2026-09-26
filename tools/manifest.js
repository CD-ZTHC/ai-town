#!/usr/bin/env node
// mise run manifest：从代码生成 docs/capabilities.md（AI 当前能使用的全部能力，含插件注册的扩展）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSpec } from '../server/kernel/spec.js';
import '../plugin-host/builtin.js';
import { manifestMarkdown } from '../server/worldai/manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(ROOT, 'docs', 'capabilities.md');
fs.writeFileSync(out, manifestMarkdown(defaultSpec({})));
console.log(`✅ 已生成 ${path.relative(ROOT, out)}`);
