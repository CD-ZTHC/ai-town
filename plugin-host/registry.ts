// 扩展注册表（自主演化设计 §5.3）：插件通过这里向内核注册新的效果原语与表达式函数。
// 约束：只能新增、不能覆盖内核或其他插件已有的能力；每项都必须带说明文字（会进入能力清单，AI 据此使用它）。
// AI 插件被停用或回滚时，它注册的能力会被注销。
import { EFFECTS, EXPR_FNS, EXPR_FN_DOCS, EXT_FNS } from '../server/kernel/effects.ts';
import type { EffectDef } from '../server/kernel/effects.ts';

/** 已注册的扩展（能力清单、启动日志与管理面板用） */
export interface Extension { kind: 'effect' | 'exprFn'; name: string; doc: string; source: string }

const NAME = /^[a-z][a-zA-Z0-9]{1,23}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
let loaded: Extension[] = [];

function checkName(name: string, taken: boolean): void {
  if (!NAME.test(name) || RESERVED.has(name)) throw new Error(`扩展名称不合法：${name}（小写字母开头，只含字母数字，2~24 位）`);
  if (taken) throw new Error(`扩展名称与已有能力冲突：${name}（扩展只能新增，不能覆盖）`);
}

/**
 * 注册一个效果原语。def：
 *   doc   说明（参数格式 + 作用），会写进能力清单
 *   check(args, spec) 静态校验，返回错误文本或 null（必须限制数值范围）
 *   apply(town, ctx, args) 运行时执行；ctx 含 self / target / e / at / source
 */
export function registerEffect(name: string, def: Pick<EffectDef, 'doc' | 'check' | 'apply'>, source = 'ext'): void {
  checkName(name, Object.hasOwn(EFFECTS, name));
  if (typeof def?.check !== 'function' || typeof def?.apply !== 'function') throw new Error(`效果 ${name} 缺少 check / apply`);
  if (!String(def.doc || '').trim()) throw new Error(`效果 ${name} 缺少 doc 说明`);
  EFFECTS[name] = { ...def, ext: true, source };
  loaded.push({ kind: 'effect', name, doc: def.doc, source });
}

/**
 * 注册一个表达式函数。impl({ town, real }, ...args) → 普通值；real(快照) 返回真实居民。
 * 函数必须是只读的：不能修改小镇状态。
 */
export function registerExprFn(name: string, impl: (typeof EXT_FNS)[string], doc: string, source = 'ext'): void {
  checkName(name, EXPR_FNS.has(name));
  if (typeof impl !== 'function') throw new Error(`表达式函数 ${name} 不是函数`);
  if (!String(doc || '').trim()) throw new Error(`表达式函数 ${name} 缺少说明`);
  EXPR_FNS.add(name);
  EXPR_FN_DOCS[name] = doc;
  EXT_FNS[name] = impl;
  loaded.push({ kind: 'exprFn', name, doc, source });
}

/** 注销某个来源注册的全部能力（插件停用 / 回滚时使用） */
export function unregisterSource(source: string): void {
  for (const e of loaded.filter((x) => x.source === source)) {
    if (e.kind === 'effect' && EFFECTS[e.name]?.source === source) delete EFFECTS[e.name];
    if (e.kind === 'exprFn') { EXPR_FNS.delete(e.name); delete EXPR_FN_DOCS[e.name]; delete EXT_FNS[e.name]; }
  }
  loaded = loaded.filter((x) => x.source !== source);
}

/** 已加载的扩展（用于能力清单、启动日志与管理面板） */
export function extensions(): Extension[] { return loaded.slice(); }
