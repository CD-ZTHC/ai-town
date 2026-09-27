// AI 插件清单（plugin.json）与效果参数的声明式校验。
// 沙箱插件的效果在内核里是同步校验的（能力、规则、剧情节拍都会先 check），所以参数格式必须以数据的形式写在清单里，
// 由宿主按下面的规则校验，而不是执行插件代码。
import { checkTarget } from '../server/kernel/effects.js';

export const TIERS = ['T0', 'T1', 'T2'];
export const PERMISSIONS = ['world.read', 'effects', 'store', 'llm', 'routes', 'ui.panel', 'ui.overlay'];
// 沙箱插件可以订阅的钩子（tick 太频繁，只给进程内的内置插件）
export const SANDBOX_HOOKS = ['hour', 'dayStart', 'agent.arrive', 'conversation.end', 'proposal.applied', 'avatar.arrive', 'story.beat'];
// T0 数据 / T1 声明式 可以带的内容
export const CONTENT_OPS = { T0: ['addBuilding', 'addCalendarEvent', 'addWeather', 'addItem', 'addStructure', 'addCanon'], T1: ['addBuilding', 'addCalendarEvent', 'addWeather', 'addItem', 'addStructure', 'addCanon', 'addAbility', 'addRule'] };
const ID = /^[a-z][a-z0-9-]{2,31}$/;
const NAME = /^[a-z][a-zA-Z0-9]{1,23}$/;
const ROUTE = /^[a-z][a-z0-9-]{1,23}$/;
const FIELD_TYPES = ['int', 'number', 'string', 'enum', 'bool', 'location', 'item', 'agent'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** 校验一个效果的参数 schema 本身（数值必须有上下限，字符串必须有长度上限） */
export function checkSchema(schema) {
  if (!isObj(schema)) return 'args 必须是对象';
  const keys = Object.keys(schema);
  if (keys.length > 8) return 'args 最多 8 个字段';
  for (const k of keys) {
    const f = schema[k];
    if (!/^[a-z][a-zA-Z0-9]{0,15}$/.test(k) || ['op', 'target', 'radius'].includes(k)) return `字段名不合法：${k}`;
    if (!isObj(f) || !FIELD_TYPES.includes(f.type)) return `字段 ${k} 的 type 只能是 ${FIELD_TYPES.join('/')}`;
    if ((f.type === 'int' || f.type === 'number') && !(fin(f.min) && fin(f.max) && f.min <= f.max && Math.abs(f.min) <= 1e4 && Math.abs(f.max) <= 1e4)) return `字段 ${k} 需要合理的 min / max`;
    if (f.type === 'string' && !(Number.isInteger(f.max) && f.max >= 1 && f.max <= 80)) return `字段 ${k} 需要 max（1~80）`;
    if (f.type === 'enum' && !(Array.isArray(f.values) && f.values.length >= 1 && f.values.length <= 12 && f.values.every((v) => typeof v === 'string' && v.length <= 20))) return `字段 ${k} 需要 values（1~12 个短字符串）`;
  }
  return null;
}

/** 按 schema 校验效果参数；target / radius 按内核规则校验 */
export function checkArgs(schema, args, spec) {
  for (const k of Object.keys(args)) if (!['op', 'target', 'radius', 'includeSelf'].includes(k) && !Object.hasOwn(schema, k)) return `未知参数：${k}`;
  for (const [k, f] of Object.entries(schema)) {
    const v = args[k];
    if (v == null) { if (f.required) return `缺少参数 ${k}`; continue; }
    if (f.type === 'int' && !(Number.isInteger(v) && v >= f.min && v <= f.max)) return `${k} 应为 ${f.min}~${f.max} 的整数`;
    if (f.type === 'number' && !(fin(v) && v >= f.min && v <= f.max)) return `${k} 应在 ${f.min}~${f.max}`;
    if (f.type === 'string' && !(typeof v === 'string' && v.length <= f.max)) return `${k} 应为 ≤${f.max} 字的文字`;
    if (f.type === 'enum' && !f.values.includes(v)) return `${k} 只能是 ${f.values.join('/')}`;
    if (f.type === 'bool' && typeof v !== 'boolean') return `${k} 应为 true / false`;
    if (f.type === 'location' && !(typeof v === 'string' && Object.hasOwn(spec.locations, v))) return `未知地点：${v}`;
    if (f.type === 'item' && !(typeof v === 'string' && Object.hasOwn(spec.items, v))) return `未知物品：${v}`;
    if (f.type === 'agent' && !(typeof v === 'string' && spec.personas.some((p) => p.id === v))) return `未知居民：${v}`;
  }
  return checkTarget(args);
}

/** 校验 plugin.json；dirName 为插件目录名（<id>@<version>） */
export function validateManifest(m, dirName = null) {
  const errs = [];
  if (!isObj(m)) return ['plugin.json 必须是对象'];
  if (!ID.test(String(m.id || ''))) errs.push('id 只能是小写字母、数字、短横线（3~32 位，字母开头）');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(m.version || ''))) errs.push('version 格式应为 x.y.z');
  if (dirName && dirName !== `${m.id}@${m.version}`) errs.push(`目录名应为 ${m.id}@${m.version}`);
  if (!TIERS.includes(m.tier)) errs.push(`tier 只能是 ${TIERS.join('/')}`);
  if (!String(m.title || '').trim() || String(m.title).length > 16) errs.push('title 为 1~16 字');
  if (!String(m.summary || '').trim() || String(m.summary).length > 80) errs.push('summary 为 1~80 字');
  const perms = m.permissions ?? [];
  if (!Array.isArray(perms) || perms.some((p) => !PERMISSIONS.includes(p))) errs.push(`permissions 只能包含 ${PERMISSIONS.join('、')}`);
  const effects = m.provides?.effects ?? [];
  const hooks = m.hooks ?? [];
  const routes = m.routes ?? [];
  if (!Array.isArray(effects) || effects.length > 4) errs.push('provides.effects 最多 4 个');
  else for (const e of effects) {
    if (!NAME.test(String(e?.name || ''))) errs.push(`效果名不合法：${e?.name}`);
    if (!String(e?.doc || '').trim() || String(e.doc).length > 200) errs.push(`效果 ${e?.name} 需要 doc（≤200 字）`);
    const se = checkSchema(e?.args ?? {});
    if (se) errs.push(`效果 ${e?.name}：${se}`);
  }
  if (!Array.isArray(hooks) || hooks.length > 6 || hooks.some((h) => !SANDBOX_HOOKS.includes(h))) errs.push(`hooks 只能包含 ${SANDBOX_HOOKS.join('、')}（最多 6 个）`);
  if (!Array.isArray(routes) || routes.length > 4 || routes.some((r) => !ROUTE.test(String(r)))) errs.push('routes 最多 4 个，名称为小写字母、数字、短横线');
  if (m.ui != null && !(isObj(m.ui) && (m.ui.title == null || String(m.ui.title).length <= 10))) errs.push('ui 格式不对');
  if (m.tier !== 'T2' && (effects.length || hooks.length || routes.length || m.ui)) errs.push(`${m.tier} 插件不能声明效果、钩子、接口或界面（需要 T2）`);
  const need = [[effects.length, 'effects'], [routes.length, 'routes'], [m.ui?.panel, 'ui.panel'], [m.ui?.overlay, 'ui.overlay']];
  for (const [has, p] of need) if (has && !perms.includes(p)) errs.push(`用到了 ${p}，需要在 permissions 里申请`);
  if (hooks.length && !perms.includes('effects') && !perms.includes('ui.overlay') && !perms.includes('store')) errs.push('订阅钩子需要 effects、store 或 ui.overlay 权限之一');
  const llmCap = Number(m.limits?.llmTokensPerDay ?? 0);
  if (!(llmCap >= 0 && llmCap <= 5000)) errs.push('limits.llmTokensPerDay 应在 0~5000');
  if (perms.includes('llm') && !llmCap) errs.push('申请 llm 权限时需要 limits.llmTokensPerDay');
  return errs;
}

/** 覆盖层绘制指令（插件只能返回这些，由前端统一绘制） */
export function cleanOverlay(list, world) {
  if (!Array.isArray(list)) return [];
  const W = world?.width || 64, Hh = world?.height || 44;
  const out = [];
  for (const c of list.slice(0, 20)) {
    if (!isObj(c) || !['emoji', 'text', 'ring', 'sparkle'].includes(c.kind)) continue;
    if (!(fin(c.x) && fin(c.y) && c.x >= 0 && c.y >= 0 && c.x <= W && c.y <= Hh)) continue;
    const color = /^#[0-9a-f]{6}$/i.test(String(c.color || '')) ? c.color : '#ffffff';
    out.push({ kind: c.kind, x: +c.x.toFixed(2), y: +c.y.toFixed(2), text: String(c.text ?? c.emoji ?? '').slice(0, 12), color, r: fin(c.r) ? Math.max(0.3, Math.min(6, c.r)) : 1, region: typeof c.region === 'string' && /^[a-z][a-z0-9_]{1,23}$/.test(c.region) ? c.region : 'town' });
  }
  return out;
}
