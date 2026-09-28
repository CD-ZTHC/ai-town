// 授权（多世界设计 §5.1）：authorize(who, action, world?) → true | 理由。业务代码只问「能不能做」，不读请求头或 IP。
//   who：{ user, admin }（由 http/identity.ts 解析）
//   world：世界登记项 { id, ownerId, status, official, ... }（多世界之后传入）
export const ADMIN_ROLES = new Set(['admin', 'super']);

export function isAdminUser(user) { return Boolean(user && ADMIN_ROLES.has(user.role) && !user.disabled); }

const RULES = {
  // 在世界里现身、聊天、心声、发布事件、改天气、投票、举报：只有注册用户（游客只能观看）
  interact: (who) => (who.user && !who.user.disabled ? true : '登录后才能和世界互动'),
  // 站点管理
  admin: (who) => (who.admin ? true : '只有管理员可以这样做'),
  // 创世：需要 genesis 授予
  genesis: (who, _w, ctx) => (who.admin || ctx?.grant?.('genesis') ? true : '需要管理员授予创世权限'),
  // 管理某个世界（设置、暂停、归档、终审）：owner 或全站管理员
  'world.manage': (who, w) => (who.admin || (who.user && w && w.ownerId === who.user.id) ? true : '只有这个世界的创建者可以这样做'),
  // 查看某个世界：公开的所有人可看；预览中 / 已下架的只有 owner 和管理员
  'world.view': (who, w) => {
    if (!w) return '世界不存在';
    if (['public', 'unlisted', 'paused'].includes(w.status)) return true;
    if (who.admin || (who.user && w.ownerId === who.user.id)) return true;
    return w.status === 'suspended' ? '这个世界已被下架' : '世界不存在';
  },
};

/** @returns {true | string} */
export function authorize(who, action, world = null, ctx = null) {
  const rule = RULES[action];
  if (!rule) throw new Error(`未知的操作：${action}`);
  return rule(who || {}, world, ctx);
}
