// 静态检查（自动闸门的一部分，不依赖模型）：AI 插件的代码在进入评审之前必须先通过这里。
// 这是纵深防御的第一层：真正的边界是沙箱进程；这里负责尽早拦下明显的危险写法、混淆与「写给审查员的指令」。
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from '../hash.ts';

export const LIMITS = { files: 10, fileBytes: 40_000, totalBytes: 120_000 };
const ALLOWED_FILES = /^(plugin\.json|content\.json|server\.js|ui\.js|test\.js|lib\/[a-z0-9-]{1,24}\.js|RFC\.md|REVIEW\.md|CHANGELOG\.md)$/;

// 服务端代码（沙箱）里禁止出现的标识符与写法
/** 禁止的标识符（按词匹配）或写法（正则），以及原因 */
type Banned = Array<[string | RegExp, string]>;
const SERVER_BANNED: Banned = [
  ['process', '访问进程对象'], ['globalThis', '访问全局对象'], ['global', '访问全局对象'], ['require', 'CommonJS 加载'], ['module', '模块系统'],
  ['eval', '动态执行代码'], ['Function', '构造函数'], ['constructor', '通过 constructor 取得构造函数'], ['__proto__', '原型链操作'],
  ['prototype', '修改原型'], ['defineProperty', '改写对象属性'], ['setPrototypeOf', '原型链操作'], ['Reflect', '反射'], ['Proxy', '代理对象'],
  ['fetch', '网络请求'], ['XMLHttpRequest', '网络请求'], ['WebSocket', '网络连接'], ['WebAssembly', 'WebAssembly'], ['Atomics', '共享内存'],
  ['SharedArrayBuffer', '共享内存'], ['setTimeout', '定时器'], ['setInterval', '定时器'], ['setImmediate', '定时器'], ['queueMicrotask', '微任务'],
  ['Buffer', '二进制缓冲'], ['atob', '解码隐藏内容'], ['btoa', '编码数据'], ['fromCharCode', '拼字符隐藏内容'], ['fromCodePoint', '拼字符隐藏内容'],
  ['unescape', '解码隐藏内容'], ['decodeURIComponent', '解码隐藏内容'], ['debugger', '调试语句'], [/\bwith\s*\(/, 'with 语句'],
];
// 前端面板代码（sandbox iframe）里禁止的写法
const UI_BANNED: Banned = [
  ['eval', '动态执行代码'], ['Function', '构造函数'], ['constructor', '取得构造函数'], ['__proto__', '原型链操作'],
  ['fetch', '网络请求'], ['XMLHttpRequest', '网络请求'], ['WebSocket', '网络连接'], ['EventSource', '网络连接'], ['sendBeacon', '网络请求'],
  [/\b(window|self|globalThis)\s*\.\s*(top|parent)\b/, '访问上层页面'], ['opener', '访问打开者页面'], ['cookie', '读取 Cookie'], ['localStorage', '本地存储'], ['sessionStorage', '本地存储'],
  ['indexedDB', '本地存储'], ['importScripts', '加载脚本'], ['Worker', '后台线程'], ['atob', '解码隐藏内容'], ['fromCharCode', '拼字符隐藏内容'],
  ['innerHTML', '直接写 HTML（请用 textContent）'], ['outerHTML', '直接写 HTML'], ['insertAdjacentHTML', '直接写 HTML'], ['srcdoc', '嵌入文档'],
  [/\blocation\s*(=|\.\s*(href|assign|replace))/, '跳转页面'], [/\bopen\s*\(/, '打开新窗口'],
];
// 写给 AI 审查员 / 实施者的指令性文字（提示词注入）
const INJECTION = /(忽略|无视)(之前|以上|前面|上述|所有)|(审查|评审|审核)(员|者|agent)|reviewer|ignore\s+(all|previous|above|prior)|disregard|system\s*prompt|you\s+are\s+now|as\s+an\s+ai|approve\s+this|这段代码(是)?安全|无需审查|跳过(审查|检查)/i;

const word = (w: string) => new RegExp(`(?<![A-Za-z0-9_$])${w}(?![A-Za-z0-9_$])`);

/** 去掉注释（给安全审查员看的版本；也用于检查） */
export function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      out += src.slice(i, end < 0 ? src.length : end + 2).replace(/[^\n]/g, '');
      i = end < 0 ? src.length : end + 1;
    } else out += c;
  }
  return out;
}

function checkJs(file: string, src: string, banned: Banned): string[] {
  const issues: string[] = [];
  for (const [w, why] of banned) if ((w instanceof RegExp ? w : word(w)).test(src)) issues.push(`${file}：不允许使用 ${w instanceof RegExp ? w.source : w}（${why}）`);
  if (/\bimport\s*\(/.test(src)) issues.push(`${file}：不允许动态 import()`);
  if (/import\.meta/.test(src)) issues.push(`${file}：不允许使用 import.meta`);
  if (/\\x[0-9a-f]{2}|\\u\{?[0-9a-f]{4}/i.test(src)) issues.push(`${file}：字符串里不允许使用 \\x / \\u 转义（可能隐藏内容）`);
  if (/[​-‏‪-‮⁦-⁩﻿]/.test(src)) issues.push(`${file}：包含不可见或双向控制字符`);
  if (/\[\s*['"`][^'"`]*['"`]\s*\+/.test(src)) issues.push(`${file}：不允许用字符串拼接访问属性（可能隐藏属性名）`);
  for (const m of src.matchAll(/\b(?:import|export)\b[^;'"`]*?\bfrom\s*(['"`])([^'"`]*)\1|\bimport\s*(['"`])([^'"`]*)\3/g)) {
    const spec = (m[2] ?? m[4])!;
    if (!/^\.\/(lib\/)?[a-z0-9-]{1,24}\.js$/.test(spec)) issues.push(`${file}：只能导入插件目录里的文件（./xxx.js），不能导入 ${spec}`);
  }
  const longest = Math.max(0, ...src.split('\n').map((l) => l.length));
  if (longest > 400) issues.push(`${file}：有超过 400 字符的长行（可能隐藏内容）`);
  return issues;
}

/**
 * 检查插件目录。返回 { ok, issues, files, stripped }：stripped 是去掉注释后的代码（给安全审查员）。
 * tier：T0 / T1 只能有数据文件；T2 必须有 server.js 与 test.js。
 */
export function staticCheck(dir: string, tier: string): { ok: boolean; issues: string[]; files: string[]; stripped: Record<string, string> } {
  const issues: string[] = [];
  const files = listFiles(dir);
  if (files.length > LIMITS.files) issues.push(`文件太多（${files.length} > ${LIMITS.files}）`);
  let total = 0;
  const stripped: Record<string, string> = {};
  for (const f of files) {
    if (!ALLOWED_FILES.test(f)) { issues.push(`不允许的文件：${f}`); continue; }
    const buf = fs.readFileSync(path.join(dir, f));
    total += buf.length;
    if (buf.length > LIMITS.fileBytes) issues.push(`${f} 太大（${buf.length} 字节）`);
    const src = buf.toString('utf8');
    if (f.endsWith('.md')) continue; // 文档不执行，但下面仍检查注入
    if (INJECTION.test(src)) issues.push(`${f}：包含写给 AI 的指令性文字（提示词注入）`);
    if (f.endsWith('.json')) { try { JSON.parse(src); } catch { issues.push(`${f} 不是合法的 JSON`); } continue; }
    const code = stripComments(src);
    stripped[f] = code;
    if (INJECTION.test(code)) continue;
    issues.push(...checkJs(f, code, f === 'ui.js' ? UI_BANNED : SERVER_BANNED));
  }
  if (total > LIMITS.totalBytes) issues.push(`插件总大小超过 ${LIMITS.totalBytes} 字节`);
  if (!files.includes('plugin.json')) issues.push('缺少 plugin.json');
  if (tier === 'T2') {
    if (!files.includes('server.js') && !files.includes('ui.js')) issues.push('T2 插件至少需要 server.js 或 ui.js');
    if (files.includes('server.js') && !files.includes('test.js')) issues.push('T2 插件必须自带 test.js');
  } else if (files.some((f) => f.endsWith('.js'))) issues.push(`${tier} 插件不能包含代码文件`);
  if ((tier === 'T0' || tier === 'T1') && !files.includes('content.json')) issues.push(`${tier} 插件需要 content.json`);
  return { ok: !issues.length, issues, files, stripped };
}
