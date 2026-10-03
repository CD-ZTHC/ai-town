// 能力清单（设计文档第 7 节）：从代码自动生成「AI 现在能做什么」。
// 架构师的提示词、`mise run manifest` 生成的 docs/capabilities.md、`mise run evolve` 的需求文档都用它，
// 因此新能力（包括插件注册的扩展）一旦加载，就会自动出现在 AI 的视野里。
import { EFFECTS, EXPR_FN_DOCS, VFX } from '../kernel/effects.ts';
import { OPS } from '../kernel/ops.ts';
import { PARAM_BOUNDS, BODY_PLANS } from '../kernel/spec.ts';
import { extensions } from '../../plugin-host/registry.ts';
import type { WorldSpec } from '../types/spec.ts';

// 世界架构师可以使用的操作及参数格式
export const OP_DOCS: Record<string, string> = {
  addBuilding: '{"id":"英文小写id","name":"≤10字","kind":"英文小写类型，如 tower/shrine/shop/garden","w":3~7,"h":3~6,"place":{"near":"地点id","within":6~16},"roof":"#rrggbb","wall":"#rrggbb","sign":"一个emoji","desc":"≤60字","lightAtNight":true/false} —— 不要写坐标，系统会在 near 附近自动找空地；新建筑会成为居民可以去的地点',
  renovateBuilding: '{"id":"现有建筑id","name":"新名字≤10字(可选)","kind":"新类型(可选)","desc":"≤60字(可选)","sign":"emoji(可选)","roof":"#rrggbb(可选)","public":true/false(可选)} —— 改建 / 换用途：占地不变，住户与所有引用照旧；闲置或不合用的建筑优先改建而不是拆',
  setBuildingState: '{"id":"现有建筑id","state":"closed 停业 / damaged 受损 / ruin 废墟","reason":"≤30字"} —— 变成废墟与拆除一样要给出 remap（见 removeBuilding），并经过居民议事',
  restoreBuilding: '{"id":"停业、受损或成了废墟的建筑id"} —— 修好、重新开门',
  removeBuilding: '{"id":"现有建筑id","remap":{"residents":"住户搬去的建筑id","workers":"在这里工作的人改去的地点id","location":"节日、规则等引用的替代地点id"}} —— 拆除，原址变成空地；remap 不写时系统就近安排；要经过居民议事（住户不同意时需要其他居民全票同意）',
  addPath: '{"from":"地点id","to":"地点id","surface":"path 石板 / dirt 泥路（可选）"} —— 修一条路：系统找最省事的路线（砍掉挡路的树丛，窄水面顺带架桥）；居民往返变近时用',
  addBridge: '{"near":"地点id"} —— 在附近最窄的水面上架桥（大改）',
  clearArea: '{"near":"地点id","w":3~10,"h":3~10} —— 清理附近的树丛石头，腾出空地（为以后建房）',
  plantGrove: '{"near":"地点id","w":2~8,"h":2~8,"trees":"oak/pine/sakura（可选）"} —— 在附近的空草地上种一片树',
  addOutdoorPlace: '{"id":"英文小写id","kind":"garden/orchard/market/plaza/field/pond/well/camp/shrine/clearing/grove/meadow","name":"≤16字","emoji","desc":"≤60字","near":"地点id"} —— 新的户外去处，系统在附近找空地画出来',
  expandMap: '{"side":"north/south/east/west","by":8~24,"biome":"meadow/village/forest/…","name":"新地块的名字≤16字","places":[{"id":"英文小写id","kind":"house/cottage/shop/inn/…或 garden/orchard/market/…","name":"≤16字","emoji","desc":"≤60字"}]（最多6个）} —— 地图向一边长出一片新地方（大改）；空地不够、镇子要长大时用；地图最大 96×64',
  addAdjacentRegion: '{"id":"英文小写id","name":"如 城东","from":"相邻的哪张地图（默认 town）","side":"north/south/east/west","length":32~96,"fromName":"原来那张地图的新称呼，如 城中（可选）","biome","areas":[{"id","biome","size":"small/medium/large","places":[{"id","kind","name","emoji","desc"}]}]} —— 某个方向的地图到了 96×64 的上限、镇子还要往那边长时，在那一侧新建一张相邻的地图（大改）；接壤的边上自动开通道，走到边缘就过去了',
  addRegion: '{"id","name","biome","areas":[同上]} —— 远处的新地方（北山、河对岸的村子、异界…）；必须同时用 linkRegions 打通（大改）',
  linkRegions: '{"region":"区域id","open":true,"entry":"主地图上的路口地点id","gateName":"路口的名字，如 北山山口"}',
  addCalendarEvent: '{"id","name":"≤16字","emoji","day":第几天（必须大于今天）,"from":"HH:MM","location":"地点id","hint":"≤60字","countdown":true}',
  addWeather: '{"id","name":"≤8字","emoji","weight":0~20,"render":{"base":"sunny/cloudy/rain/storm/fog/snow","tint":"#rrggbb","tintAlpha":0~0.5}}',
  addItem: '{"id","name":"≤8字","emoji","desc":"≤40字"}',
  addStructure: '{"id","name":"≤8字","emoji","ttl":10~240,"tags":["light"],"light":{"r":20~160,"color":"255,200,100"}}',
  addAbility: '{"id","name":"≤8字","emoji","target":"self/agent/area","desc":"≤50字","aiHint":"≤50字","cost":{"stamina":0~40,"items":{"物品id":1~3}},"cooldown":0~1440,"requires":"表达式(可选)","effects":[效果，最多8个],"learn":{"teach":true,"research":{"location":"地点id","keywords":["关键词"]}},"combat":{"windup":0~12,"recover":0~20,"range":1~8,"shape":"single/circle/line/cone","radius":0~6,"cd":0~400}(可选)} —— 写了 combat 块就是战斗招式（拍数，一拍 0.25 秒）：蓄力 windup 拍后生效，招式命中的敌人由 shape 决定，效果里用 strike / status / knockback；例：{"combat":{"windup":3,"range":5,"shape":"line","cd":16},"effects":[{"op":"strike","power":1.5,"tags":["fire"]},{"op":"status","status":"slow","beats":8}]}',
  setAvatarKit: '{"ids":["带 combat 块的能力id"]（最多4个）} —— 旅人（玩家）在游戏模式里能用的技能栏，整体替换',
  addRule: '{"id","name":"≤16字","when":{"every":10~1440} 或 {"at":"HH:MM"} 或 {"weather":"天气id"} 或 {"enter":"地点id"},"forEach":"agent"(可选),"if":"表达式(可选)","then":[效果]}',
  addCanon: '{"text":"写进小镇历史的事实（≤100字）","tags":["标签"]}',
};

export function effectsText(skip: readonly string[] = []): string {
  return Object.entries(EFFECTS).filter(([name]) => !skip.includes(name)).map(([name, d]) => `- ${name}${d.ext ? '（扩展）' : ''}：${d.doc}`).join('\n');
}

export function exprText(): string {
  return `变量：e.loc e.region e.inside e.stamina e.courage e.status e.name（规则中的居民；能力里用 self / target）、weather hour minute day flags.标记名
函数：${Object.values(EXPR_FN_DOCS).join('；')}`;
}

// 创世效果只能写在世界包里（AI 写的规则与能力里不允许，见 touchesGenesis）：不给架构师看，免得被当成操作用
const GENESIS_EFFECTS = ['worldOp', 'transform'];

const townLocs = (spec: WorldSpec) => Object.entries(spec.locations).filter(([, l]) => !l.region);
const farLocs = (spec: WorldSpec) => Object.entries(spec.locations).filter(([, l]) => l.region);

/** 架构师提示词里的能力清单 */
export function manifestText(spec: WorldSpec, day = 1): string {
  return `可用操作（ops 数组中每项为 {"op":"…","args":{…}}，只能用这些：${Object.keys(OP_DOCS).join('、')}）：
${Object.entries(OP_DOCS).map(([k, v]) => `- ${k} ${v.replace('必须大于今天', `必须大于今天 ${day}`)}`).join('\n')}
效果（能力的 effects、规则的 then 里使用）：
${effectsText(GENESIS_EFFECTS)}
表达式：
${exprText()}
现有地点：${townLocs(spec).map(([id, l]) => `${id}(${l.name})`).join('、')}${farLocs(spec).length ? `
异界地点（只能作为日程/节日地点，不能在那边建房）：${farLocs(spec).map(([id, l]) => `${id}(${l.name})`).join('、')}` : ''}
现有物品：${Object.entries(spec.items).map(([id, i]) => `${id}(${i.name})`).join('、')}
现有构筑物：${Object.entries(spec.structures).map(([id, x]) => `${id}(${x.name})`).join('、')}
现有能力：${spec.abilities.map((a) => `${a.id}(${a.name})`).join('、')}
地图：${spec.regions.map((r) => { const sz = Array.isArray(r.size) ? r.size.join('×') : '?'; return `${r.id}(${r.name || ''}${r.id === 'town' ? '，主地图' : r.adjacent ? `，在 ${r.adjacent.to} 的${{ north: '北', south: '南', east: '东', west: '西' }[r.adjacent.side as 'north']}边` : '，远处'}，${sz})`; }).join('、')}（每张地图最大 96×64）
现有建筑（id(名字，状态，住着几人)）：${spec.buildings.filter((b) => !b.removed).map((b) => {
    const n = spec.personas.filter((p) => p.home === b.id && p.status !== 'departed').length;
    const st = { closed: '停业', damaged: '受损', ruin: '废墟' }[b.state as 'closed'];
    return `${b.id}(${b.name}${st ? `，${st}` : ''}${n ? `，住着${n}人` : ''})`;
  }).join('、')}`;
}

/** docs/capabilities.md：给人看的能力清单 */
export function manifestMarkdown(spec: WorldSpec): string {
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

## 已加载的扩展（插件）

${ext.length ? ext.map((e) => `- ${e.kind === 'effect' ? '效果' : '表达式函数'} \`${e.name}\`（${e.source}）：${e.doc}`).join('\n') : '（无）'}
`;
}
