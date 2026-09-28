#!/usr/bin/env node
// mise run settings:doc：由设置声明表（server/settings/schema.js）生成 docs/settings.md
import fs from 'node:fs';
import { SETTINGS, GROUPS } from '../server/settings/schema.js';

const fmt = (d) => {
  const v = typeof d.default === 'function' ? '（按其他设置推导）' : d.default;
  if (Array.isArray(v)) return v.length ? `\`${v.join(',')}\`` : '（空）';
  if (v === '' || v === undefined) return '（空）';
  if (typeof v === 'boolean') return v ? '开' : '关';
  return `\`${v}\``;
};
const kind = (d) => ({ int: '整数', number: '数字', bool: '开关', string: '文本', list: '逗号分隔的列表', enum: (d.values || []).map((x) => `\`${x || '（空）'}\``).join(' / ') }[d.kind]);

let out = `# 设置项

> 本文由 \`mise run settings:doc\` 根据 [server/settings/schema.js](../server/settings/schema.js) 生成，请不要手工修改。

值的来源：**管理面板保存的值（\`data/settings.json\`）> 环境变量（只作初始值）> 默认值**。
标记为「启动必需」的项只能用环境变量设置；其余所有项都在管理面板（\`/admin\`）里修改，以保存的值为准。
环境变量只用来提供初始值：服务启动时，还没保存过的项会从环境变量导入设置文件；之后再改环境变量不会生效（启动日志和面板上会提示「已忽略」）。

- **即时**：保存后立即生效；**重启**：需要重启进程（面板上可以一键重启）。
- 布尔值在环境变量里写 \`1\` / \`0\`（也接受 \`true\` / \`false\`）；列表写成逗号分隔。
- 还起作用的环境变量（启动必需的项，或还没保存过、要导入的项）写错时，服务拒绝启动并指出是哪一项。
`;
for (const [g, title] of Object.entries(GROUPS)) {
  const rows = Object.entries(SETTINGS).filter(([, d]) => d.group === g);
  if (!rows.length) continue;
  out += `\n## ${title}\n\n| 键 | 说明 | 取值 | 默认 | 生效 |\n| --- | --- | --- | --- | --- |\n`;
  for (const [k, d] of rows) {
    const tags = [d.bootstrap && '启动必需', d.secret && '密钥', d.scope === 'world' && '世界级', d.dev && '仅开发'].filter(Boolean).map((x) => `**${x}**`).join(' ');
    out += `| \`${k}\` | ${d.label}${d.help ? `：${d.help}` : ''}${tags ? ` ${tags}` : ''} | ${kind(d)} | ${fmt(d)} | ${d.apply === 'live' ? '即时' : '重启'} |\n`;
  }
}
fs.writeFileSync('docs/settings.md', out);
console.log(`docs/settings.md 已生成（${Object.keys(SETTINGS).length} 项）`);
