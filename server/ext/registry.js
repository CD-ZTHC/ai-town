// 扩展点注册表（设计文档第 7 节）：人工审核后的新能力放在 server/ext/*.js，通过这里接入内核。
// 约束：只能新增、不能覆盖内核已有的能力；每项都必须带说明文字（会进入能力清单，AI 据此使用它）。
import { EFFECTS, EXPR_FNS, EXPR_FN_DOCS, EXT_FNS } from '../kernel/effects.js';

const NAME = /^[a-z][a-zA-Z0-9]{1,23}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));
const loaded = [];

function checkName(name, taken) {
  if (!NAME.test(name) || RESERVED.has(name)) throw new Error(`扩展名称不合法：${name}（小写字母开头，只含字母数字，2~24 位）`);
  if (taken) throw new Error(`扩展名称与已有能力冲突：${name}（扩展只能新增，不能覆盖）`);
}

/**
 * 注册一个效果原语。def：
 *   doc   说明（参数格式 + 作用），会写进能力清单
 *   check(args, spec) 静态校验，返回错误文本或 null（必须限制数值范围）
 *   apply(town, ctx, args) 运行时执行；ctx 含 self / target / e / at / source
 */
export function registerEffect(name, def, source = 'ext') {
  checkName(name, Object.hasOwn(EFFECTS, name));
  if (typeof def?.check !== 'function' || typeof def?.apply !== 'function') throw new Error(`效果 ${name} 缺少 check / apply`);
  if (!String(def.doc || '').trim()) throw new Error(`效果 ${name} 缺少 doc 说明`);
  EFFECTS[name] = { ...def, ext: true };
  loaded.push({ kind: 'effect', name, doc: def.doc, source });
}

/**
 * 注册一个表达式函数。impl({ town, real }, ...args) → 普通值；real(快照) 返回真实居民。
 * 函数必须是只读的：不能修改小镇状态。
 */
export function registerExprFn(name, impl, doc, source = 'ext') {
  checkName(name, EXPR_FNS.has(name));
  if (typeof impl !== 'function') throw new Error(`表达式函数 ${name} 不是函数`);
  if (!String(doc || '').trim()) throw new Error(`表达式函数 ${name} 缺少说明`);
  EXPR_FNS.add(name);
  EXPR_FN_DOCS[name] = doc;
  EXT_FNS[name] = impl;
  loaded.push({ kind: 'exprFn', name, doc, source });
}

/** 已加载的扩展（用于能力清单、启动日志与管理面板） */
export function extensions() { return loaded.slice(); }
