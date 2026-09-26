// 能力清单（设计文档第 7 节）：从代码自动生成「AI 现在能做什么」。
// 架构师的提示词、`mise run manifest` 生成的 docs/capabilities.md、`mise run evolve` 的需求文档都用它，
// 因此新能力（包括 server/ext/ 里的扩展）一旦合并，就会自动出现在 AI 的视野里。
import { EFFECTS, EXPR_FN_DOCS, VFX } from '../kernel/effects.js';
import { OPS } from '../kernel/ops.js';
import { PARAM_BOUNDS, BODY_PLANS } from '../kernel/spec.js';
import { extensions } from '../ext/registry.js';

// 世界架构师可以使用的操作及参数格式
export const OP_DOCS = {
  addBuilding: '{"id":"英文小写id","name":"≤10字","kind":"英文小写类型，如 tower/shrine/shop/garden","w":3~7,"h":3~6,"place":{"near":"地点id","within":6~16},"roof":"#rrggbb","wall":"#rrggbb","sign":"一个emoji","desc":"≤60字","lightAtNight":true/false} —— 不要写坐标，系统会在 near 附近自动找空地；新建筑会成为居民可以去的地点',
  addCalendarEvent: '{"id","name":"≤16字","emoji","day":第几天（必须大于今天）,"from":"HH:MM","location":"地点id","hint":"≤60字","countdown":true}',
  addWeather: '{"id","name":"≤8字","emoji","weight":0~20,"render":{"base":"sunny/cloudy/rain/storm/fog/snow","tint":"#rrggbb","tintAlpha":0~0.5}}',
  addItem: '{"id","name":"≤8字","emoji","desc":"≤40字"}',
  addStructure: '{"id","name":"≤8字","emoji","ttl":10~240,"tags":["light"],"light":{"r":20~160,"color":"255,200,100"}}',
  addAbility: '{"id","name":"≤8字","emoji","target":"self/agent/area","desc":"≤50字","aiHint":"≤50字","cost":{"stamina":0~40,"items":{"物品id":1~3}},"cooldown":0~1440,"requires":"表达式(可选)","effects":[效果，最多8个],"learn":{"teach":true,"research":{"location":"地点id","keywords":["关键词"]}}}',
  addRule: '{"id","name":"≤16字","when":{"every":10~1440} 或 {"at":"HH:MM"} 或 {"weather":"天气id"} 或 {"enter":"地点id"},"forEach":"agent"(可选),"if":"表达式(可选)","then":[效果]}',
  addCanon: '{"text":"写进小镇历史的事实（≤100字）","tags":["标签"]}',
};

export function effectsText() {
  return Object.entries(EFFECTS).map(([name, d]) => `- ${name}${d.ext ? '（扩展）' : ''}：${d.doc}`).join('\n');
}

export function exprText() {
  return `变量：e.loc e.region e.inside e.stamina e.courage e.status e.name（规则中的居民；能力里用 self / target）、weather hour minute day flags.标记名
函数：${Object.values(EXPR_FN_DOCS).join('；')}`;
}

const townLocs = (spec) => Object.entries(spec.locations).filter(([, l]) => !l.region);
const farLocs = (spec) => Object.entries(spec.locations).filter(([, l]) => l.region);

/** 架构师提示词里的能力清单 */
export function manifestText(spec, day = 1) {
  return `可用操作（ops 数组中每项为 {"op":"…","args":{…}}，只能用这些：${Object.keys(OP_DOCS).join('、')}）：
${Object.entries(OP_DOCS).map(([k, v]) => `- ${k} ${v.replace('必须大于今天', `必须大于今天 ${day}`)}`).join('\n')}
效果（能力的 effects、规则的 then 里使用）：
${effectsText()}
表达式：
${exprText()}
现有地点：${townLocs(spec).map(([id, l]) => `${id}(${l.name})`).join('、')}${farLocs(spec).length ? `
异界地点（只能作为日程/节日地点，不能在那边建房）：${farLocs(spec).map(([id, l]) => `${id}(${l.name})`).join('、')}` : ''}
现有物品：${Object.entries(spec.items).map(([id, i]) => `${id}(${i.name})`).join('、')}
现有构筑物：${Object.entries(spec.structures).map(([id, x]) => `${id}(${x.name})`).join('、')}
现有能力：${spec.abilities.map((a) => `${a.id}(${a.name})`).join('、')}
现有建筑：${spec.buildings.map((b) => b.name).join('、')}`;
}

/** docs/capabilities.md：给人看的能力清单 */
export function manifestMarkdown(spec) {
  const ext = extensions();
  return `# 能力清单（自动生成）

> 由 \`mise run manifest\` 从代码生成，请勿手工编辑。这就是 AI（叙事导演、世界架构师）当前能使用的全部能力。

## 世界操作（WorldOp）

| 操作 | 审批等级 | 架构师可用 | 参数 |
| --- | --- | --- | --- |
${Object.entries(OPS).map(([k, d]) => `| \`${k}\` | ${d.level} | ${OP_DOCS[k] ? '✅' : '—'} | ${(OP_DOCS[k] || '仅管理员 / 剧情弧使用').replace(/\|/g, '\\|')} |`).join('\n')}

## 效果原语

| 效果 | 来源 | 格式与作用 |
| --- | --- | --- |
${Object.entries(EFFECTS).map(([k, d]) => `| \`${k}\` | ${d.ext ? '扩展' : '内核'} | ${d.doc.replace(/\|/g, '\\|')} |`).join('\n')}

## 表达式函数

${Object.entries(EXPR_FN_DOCS).map(([k, v]) => `- \`${k}\`：${v}`).join('\n')}

## 其他可用资源

- 特效预设：${VFX.join('、')}
- 生物体型：${BODY_PLANS.join('、')}
- 可调参数：${Object.entries(PARAM_BOUNDS).map(([k, [a, b]]) => `\`${k}\`（${a}~${b}）`).join('、')}
- 地点：${townLocs(spec).map(([id, l]) => `\`${id}\` ${l.name}`).join('、')}
- 异界地点（不能建房）：${farLocs(spec).map(([id, l]) => `\`${id}\` ${l.name}（${l.region}）`).join('、') || '（无）'}
- 物品：${Object.entries(spec.items).map(([id, i]) => `\`${id}\` ${i.name}`).join('、')}
- 能力：${spec.abilities.map((a) => `\`${a.id}\` ${a.name}`).join('、')}

## 已加载的扩展（server/ext/）

${ext.length ? ext.map((e) => `- ${e.kind === 'effect' ? '效果' : '表达式函数'} \`${e.name}\`：${e.doc}`).join('\n') : '（无）'}
`;
}
