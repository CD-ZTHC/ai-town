// 安全表达式：规则条件、能力前置条件使用的迷你语言。手写解析器，不使用 eval / Function。
// 语法：数字、'字符串'、true/false/null、变量 a.b.c（只能读上下文里的自有属性）、
//       一元 ! -、二元 * / % + - < <= > >= == != && ||、括号、白名单函数调用 f(x, y)
// 限制：表达式长度、语法树节点数、求值步数都有上限；没有赋值、循环、属性写入。

const MAX_LEN = 300;
const MAX_NODES = 120;
const MAX_STEPS = 2000;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

export class ExprError extends Error {
  constructor(msg) { super(msg); this.code = 'EXPR'; }
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError('字符串没有结束');
      toks.push({ t: 'str', v: src.slice(i + 1, end) }); i = end + 1; continue;
    }
    if (/[A-Za-z_一-龥]/.test(c)) {
      const m = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*/.exec(src.slice(i));
      toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!().,'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new ExprError(`无法识别的字符：${c}`);
  }
  return toks;
}

const BIN = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

/** 解析为语法树。fns 为允许调用的函数名集合（用于解析期检查）。 */
export function parse(src, fns = new Set()) {
  if (typeof src !== 'string' || !src.trim()) throw new ExprError('表达式为空');
  if (src.length > MAX_LEN) throw new ExprError(`表达式过长（>${MAX_LEN}）`);
  const toks = tokenize(src);
  let p = 0, nodes = 0;
  const node = (n) => { if (++nodes > MAX_NODES) throw new ExprError('表达式过于复杂'); return n; };
  const peek = () => toks[p];
  const eat = (v) => { const k = toks[p]; if (!k || k.v !== v) throw new ExprError(`缺少 ${v}`); p++; return k; };

  function primary() {
    const k = toks[p++];
    if (!k) throw new ExprError('表达式不完整');
    if (k.t === 'num' || k.t === 'str') return node({ k: 'lit', v: k.v });
    if (k.t === 'op' && k.v === '(') { const e = expr(0); eat(')'); return e; }
    if (k.t === 'op' && (k.v === '!' || k.v === '-')) return node({ k: 'un', op: k.v, a: unary() });
    if (k.t === 'id') {
      if (k.v === 'true' || k.v === 'false') return node({ k: 'lit', v: k.v === 'true' });
      if (k.v === 'null') return node({ k: 'lit', v: null });
      if (peek()?.v === '(') {
        if (!fns.has(k.v)) throw new ExprError(`不允许的函数：${k.v}`);
        p++;
        const args = [];
        if (peek()?.v !== ')') { do args.push(expr(0)); while (peek()?.v === ',' && p++); }
        eat(')');
        return node({ k: 'call', f: k.v, args });
      }
      const path = [k.v];
      while (peek()?.v === '.') {
        p++;
        const n = toks[p++];
        if (!n || n.t !== 'id') throw new ExprError('属性名不合法');
        path.push(n.v);
      }
      if (path.some((s) => RESERVED.has(s) || s.startsWith('__'))) throw new ExprError('不允许访问内部属性');
      return node({ k: 'var', path });
    }
    throw new ExprError(`意外的符号：${k.v}`);
  }
  function unary() { return primary(); }
  function expr(minPrec) {
    let left = unary();
    for (;;) {
      const k = peek();
      const prec = k?.t === 'op' ? BIN[k.v] : undefined;
      if (!prec || prec <= minPrec) return left;
      p++;
      left = node({ k: 'bin', op: k.v, a: left, b: expr(prec) });
    }
  }
  const tree = expr(0);
  if (p < toks.length) throw new ExprError(`多余的内容：${toks[p].v}`);
  return tree;
}

/** 只读取「普通对象 / 数组」的自有属性，函数、原型链一律读不到 */
function read(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (!Object.hasOwn(obj, key)) return undefined;
  const v = obj[key];
  return typeof v === 'function' ? undefined : v;
}

/** 求值。vars 为变量表，fns 为 {名称: 函数} 白名单。 */
export function evaluate(tree, vars = {}, fns = {}) {
  let steps = 0;
  const ev = (n) => {
    if (++steps > MAX_STEPS) throw new ExprError('求值步数超限');
    switch (n.k) {
      case 'lit': return n.v;
      case 'var': {
        let v = read(vars, n.path[0]);
        for (const s of n.path.slice(1)) v = read(v, s);
        return v;
      }
      case 'un': { const a = ev(n.a); return n.op === '!' ? !a : -Number(a); }
      case 'bin': {
        if (n.op === '&&') return ev(n.a) ? ev(n.b) : false;
        if (n.op === '||') { const a = ev(n.a); return a || ev(n.b); }
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          // 不存在的变量（undefined）视同 null
          case '==': return (a ?? null) === (b ?? null);
          case '!=': return (a ?? null) !== (b ?? null);
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
          case '+': return typeof a === 'string' || typeof b === 'string' ? String(a) + String(b) : Number(a) + Number(b);
          case '-': return Number(a) - Number(b);
          case '*': return Number(a) * Number(b);
          case '/': return Number(b) === 0 ? 0 : Number(a) / Number(b);
          case '%': return Number(b) === 0 ? 0 : Number(a) % Number(b);
        }
        return undefined;
      }
      case 'call': {
        if (!Object.hasOwn(fns, n.f)) throw new ExprError(`不允许的函数：${n.f}`);
        return fns[n.f](...n.args.map(ev));
      }
    }
    throw new ExprError('未知节点');
  };
  return ev(tree);
}

/** 带缓存的编译：同一个表达式只解析一次 */
const cache = new Map();
export function compile(src, fnNames) {
  const key = `${[...fnNames].sort().join(',')}|${src}`;
  let t = cache.get(key);
  if (!t) {
    t = parse(src, fnNames);
    if (cache.size > 500) cache.clear();
    cache.set(key, t);
  }
  return t;
}
