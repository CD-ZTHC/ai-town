// 账号、授予与请求身份（多世界设计 §5）：accounts/ 与 http/ 共用。

/** 角色：user 普通用户；admin 管理员；super 超级管理员 */
export type Role = 'user' | 'admin' | 'super';

/** 对外的用户信息（Accounts.pub，不含密码） */
export interface User {
  id: string;
  username: string;
  nickname: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  nicknameChangedAt: number | null;
}

/** 一项授予（例如 genesis 创世权限）及其配额 */
export interface Grant {
  cap: string;
  quota: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- 存成 JSON 的配额，字段按 cap 不同
  grantedBy: string | null;
  at: number;
  expiresAt: number | null;
  note: string;
}

/** 请求者（http/identity 解析）：登录的用户、是否管理员、网络地址 */
export interface Who {
  user?: User | null;
  admin?: boolean;
  ip?: string;
  [k: string]: unknown;
}

/** 审计记录 */
export interface AuditEntry { actor: string; action: string; target?: string; detail?: object }
