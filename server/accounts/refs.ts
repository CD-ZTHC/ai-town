// 记忆里存引用，不存名字（多世界设计 §5.6）：居民写记忆时，把旅人的昵称换成 {@账号id}；
// 给模型组装提示词、给页面展示时，再换成该账号「当前」的昵称。改名之后居民仍然认得这个人；
// 账号被停用或注销时显示为「一位离开的旅人」，记忆本身保留。
const REF = /\{@(u_[a-z0-9_]{1,40})\}/g;
export const GONE = '一位离开的旅人';

let resolve = () => null; // id → { nickname, disabled } | null

/** 由账号模块设置：按 id 查当前昵称 */
export function setResolver(fn) { resolve = fn || (() => null); }

export const ref = (id) => `{@${id}}`;

/** 把文本里的引用换成当前昵称 */
export function renderRefs(text) {
  if (typeof text !== 'string' || !text.includes('{@')) return text;
  return text.replace(REF, (_, id) => {
    const u = resolve(id);
    return u && !u.disabled ? u.nickname : GONE;
  });
}

/**
 * 把文本里出现的旅人昵称换成引用。people：[{ id, name }]（这位居民认识的旅人）。
 * 「昵称」形式的一律替换；不带书名号的只替换两个字以上的昵称，避免把单字昵称误换进普通词里。
 */
export function encodeRefs(text, people) {
  if (typeof text !== 'string' || !people?.length) return text;
  // 长的名字先换，避免「小明」把「小明明」换掉一半
  for (const { id, name } of [...people].filter((p) => p.name).sort((a, b) => b.name.length - a.name.length)) {
    const r = ref(id);
    text = text.split(`「${name}」`).join(`「${r}」`);
    if ([...name].length >= 2) text = splitOutsideRefs(text, name, r);
  }
  return text;
}

// 替换 name，但不动已经是引用的部分
function splitOutsideRefs(text, name, r) {
  return text.split(/(\{@u_[a-z0-9_]+\})/).map((part) => (part.startsWith('{@') ? part : part.split(name).join(r))).join('');
}
