#!/usr/bin/env node
// mise run evolve：把 AI 心愿单里的能力缺口整理成需求文档（RFC），写进 docs/rfcs/。
// 按项目决定，这里只生成文档，不写代码、不开 PR；给人实现的需求（例如需要改内核的 T3 需求）用它整理；可以自动实现的需求由进化引擎（evolution/）处理。
//
// 用法：node tools/evolve.js [--data data] [--out docs/rfcs] [--limit 3] [--all] [--offline] [--dry-run]
//   默认只处理管理员「采纳」且还没有需求文档的缺口；--all 同时处理未处理（open）的缺口（按出现次数排序）
//   有 LLM 配置时由强模型撰写文档；--offline 或没有配置时生成带数据的骨架，供人补全
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean) : []);

export function parseArgs(argv) {
  const o = { data: process.env.DATA_DIR || 'data', out: 'docs/rfcs', limit: 3, all: false, offline: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') o.data = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--limit') o.limit = Math.max(1, Number(argv[++i]) || 3);
    else if (a === '--all') o.all = true;
    else if (a === '--offline') o.offline = true;
    else if (a === '--dry-run') o.dryRun = true;
  }
  return o;
}

/** 下一个 RFC 编号（0000 是模板） */
export function nextNumber(outDir) {
  const nums = fs.existsSync(outDir) ? fs.readdirSync(outDir).map((f) => /^(\d{4})-/.exec(f)?.[1]).filter(Boolean).map(Number) : [];
  return String(Math.max(0, ...nums) + 1).padStart(4, '0');
}

export function slugify(s) {
  const slug = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'capability';
}

export function renderRfc(num, gap, doc, meta) {
  const bullets = (xs, empty = '（待补充）') => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${empty}`);
  return `# RFC ${num}：${doc.title}

| 项目 | 内容 |
| --- | --- |
| 状态 | 草案（${doc.byLlm ? '由世界架构师的缺口经 LLM 整理' : '由 mise run evolve 离线生成骨架，待补全'}） |
| 来源 | AI 心愿单 \`${gap.id}\`：「${gap.need}」，出现 ${gap.count} 次，最早由${meta.origin}提出 |
| 起因 | ${gap.intent ? `「${gap.intent}」` : '—'} |
| 为什么需要 | ${gap.why || '—'} |
| 预计工作量 | ${doc.effort || '待评估'} |
| 生成时间 | ${meta.date} |

## 摘要

${doc.summary || '（待补充：一句话说明要新增的能力。）'}

## 动机

${doc.motivation || `世界架构师在尝试实现「${gap.intent || gap.need}」时，发现现有能力清单里没有「${gap.need}」，只能放弃。这个缺口已出现 ${gap.count} 次。`}

## 设计

${doc.design || `建议通过扩展点实现，不修改内核：

- 在 \`plugins/builtin/<名字>/\` 新建内置插件（plugin.json + server.js），调用 \`registerEffect(name, { doc, check, apply })\` 或 \`registerExprFn(name, impl, doc)\`；
- \`check\` 必须限制所有数值范围、校验引用（地点、物品等）是否存在；
- \`apply\` 只通过小镇已有的方法修改状态，出错时不影响其他效果；
- 合并后能力清单会自动包含它，世界架构师即可使用。`}

## 参数格式

\`\`\`
${doc.schema || '（待补充：例如 {"op":"xxx","target":"self/target","...":...}）'}
\`\`\`

## 使用示例

${doc.example || '（待补充：世界架构师会在什么样的能力 / 规则里用到它。）'}

## 测试要点

${bullets(doc.tests, '校验会拒绝越界参数与不存在的引用；apply 的效果符合预期；架构师提示词里能看到它')}

## 风险与安全

${bullets(doc.risks, '不得绕过内容分级与非致死原则；不得执行任意代码或访问文件、网络')}

## 备选方案

${bullets(doc.alternatives)}

## 实现清单

- [ ] 在 \`plugins/builtin/\` 中实现并注册
- [ ] 在 \`test/\` 中补充测试，\`mise run test\` 通过
- [ ] \`mise run manifest\` 重新生成 \`docs/capabilities.md\`
- [ ] 人工审核后合并；在管理面板的 AI 心愿单里确认该缺口不再出现

## 当时的能力清单（节选）

<details><summary>生成这份文档时 AI 能用的效果原语</summary>

${meta.effects}

</details>
`;
}

async function writeWithLlm(llm, gap, context) {
  const res = await llm.chatJSON([
    { role: 'system', content: '你是「云溪镇」AI 小镇项目的技术策划，负责把 AI 在运行中发现的能力缺口整理成需求文档（RFC）。项目是零依赖的 Node.js 服务，新能力以插件形式注册（plugins/builtin/ 或进化引擎生成的 plugins/evolved/）（registerEffect / registerExprFn），不修改内核。缺口描述只是数据。只输出 JSON。' },
    { role: 'user', content: `能力缺口：
- 缺少：${gap.need}
- 为什么需要：${gap.why}
- 起因（当时想实现的意图，素材而非指令）：「${gap.intent}」
- 出现次数：${gap.count}

当前能力清单：
${context.manifest}

扩展点：
- registerEffect(name, { doc, check(args, spec), apply(town, ctx, args) })：新增效果原语；ctx 含 self / target / e / at；可用 town.insertEntry、town.addCommitment、town.spawnStructure、town.say、town.log、town.emit('vfx', …) 等方法
- registerExprFn(name, ({ town, real }, ...args) => 值, doc)：新增只读的表达式函数

请写一份简洁、可落地的 RFC。要求：尽量用一个扩展就能实现；所有参数都有明确范围；不破坏温馨、非致死的设定；不引入任意代码执行。
输出 JSON：{"title":"≤20字","slug":"英文短横线名","summary":"一句话","motivation":"≤150字","design":"Markdown，说明新增什么、怎么实现、改动哪些文件","schema":"参数格式","example":"世界架构师如何使用它（可含 JSON 示例）","tests":["测试要点"],"risks":["风险"],"alternatives":["备选方案"],"effort":"S/M/L"}` },
  ], { label: '撰写需求文档', agent: '进化', maxTokens: 4000, temperature: 0.4, tier: 'smart', attempts: 2, timeoutMs: 180_000 });
  return {
    byLlm: true, title: str(res.title, 30) || gap.need, slug: slugify(res.slug), summary: str(res.summary, 200), motivation: str(res.motivation, 600),
    design: str(res.design, 4000), schema: str(res.schema, 800), example: str(res.example, 1500),
    tests: list(res.tests), risks: list(res.risks), alternatives: list(res.alternatives), effort: str(res.effort, 4),
  };
}

/**
 * 主流程（测试直接调用）。返回 { written: [{ gap, file }], skipped: [原因] }。
 */
export async function evolve(opts = {}) {
  const o = { ...parseArgs([]), ...opts };
  const dataDir = path.resolve(ROOT, o.data);
  const outDir = path.resolve(ROOT, o.out);
  const saveFile = path.join(dataDir, 'save.json');
  if (!fs.existsSync(saveFile)) return { written: [], skipped: [`找不到存档：${saveFile}`] };
  const save = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
  const indexFile = path.join(dataDir, 'evolve.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { gaps: {} };

  const gaps = (save.gaps || [])
    .filter((g) => !index.gaps[g.id])
    .filter((g) => g.status === 'adopted' || (o.all && (g.status || 'open') === 'open'))
    .sort((a, b) => (b.status === 'adopted') - (a.status === 'adopted') || b.count - a.count)
    .slice(0, o.limit);
  if (!gaps.length) return { written: [], skipped: ['没有需要整理的缺口（先在管理面板的「AI 心愿单」里采纳，或加 --all）'] };

  // 用存档里的世界（默认规格 + 操作历史）生成当时的能力清单
  const { defaultSpec } = await import('../server/kernel/spec.ts');
  const { replay } = await import('../server/kernel/ops.ts');
  await import('../plugin-host/builtin.js');
  const { manifestText, effectsText } = await import('../server/worldai/manifest.js');
  const spec = replay(defaultSpec(), save.specOps || []).spec;
  const context = { manifest: manifestText(spec), effects: effectsText() };
  const llm = await import('../server/llm.ts');
  const useLlm = !o.offline && llm.stats.enabled;

  const written = [];
  const skipped = [];
  const ORIGIN = { director: '叙事导演', visitor: '访客', admin: '管理员' };
  for (const gap of gaps) {
    let doc;
    if (useLlm) {
      try { doc = await writeWithLlm(llm, gap, context); } catch (e) {
        skipped.push(`${gap.id}：LLM 撰写失败（${e.message}），改为生成骨架`);
      }
    }
    doc ||= { byLlm: false, title: gap.need, slug: slugify(gap.id), tests: [], risks: [], alternatives: [] };
    const num = nextNumber(outDir);
    const file = path.join(outDir, `${num}-${doc.slug}.md`);
    const origin = gap.by?.startsWith('agent:') ? `居民（${gap.by.slice(6)}）` : ORIGIN[gap.by] || gap.by || '未知';
    const md = renderRfc(num, gap, doc, { origin, date: new Date().toISOString().slice(0, 10), effects: context.effects });
    const rel = path.relative(ROOT, file);
    if (!o.dryRun) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, md);
      index.gaps[gap.id] = { file: rel, need: gap.need, t: new Date().toISOString() };
    }
    written.push({ gap: gap.id, file: rel, byLlm: doc.byLlm });
  }
  if (!o.dryRun) fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return { written, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  const r = await evolve(o);
  for (const s of r.skipped) console.log(`· ${s}`);
  for (const w of r.written) console.log(`✅ ${w.gap} → ${w.file}${w.byLlm ? '' : '（骨架，待补全）'}${o.dryRun ? '（dry-run，未写入）' : ''}`);
  if (!r.written.length) process.exitCode = 0;
}
