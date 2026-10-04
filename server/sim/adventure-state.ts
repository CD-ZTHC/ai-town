// 冒险（docs/design/adventure.md）写进存档的状态结构：放在单独的文件里，存档表（sim/state.ts）引用它不会形成循环。

export type StageStatus = 'locked' | 'open' | 'front' | 'cleared';
export interface StageState {
  status: StageStatus;
  /** 在这一阶段的区域里打倒了多少只 */
  kills: number;
  /** Boss：预告发出的时刻、出现的时刻（游戏分钟）、是否已经出现过 */
  bossAt?: number | null;
  bossOut?: boolean;
  /** Boss 已经被打倒（默认的征服条件） */
  bossDown?: boolean;
  openedAt?: number;
  clearedAt?: number;
}
export interface ExpeditionState {
  stages: Record<string, StageState>;
  /** 当前前线（阶段 id） */
  front: string | null;
  /** 收集到的进度物（tokens） */
  tokens: number;
  /** 每条刷怪规则上次刷新的时刻：`阶段id:序号` → 游戏分钟 */
  spawnAt: Record<string, number>;
}
export interface AvatarProgress { level: number; exp: number; track: string; kit: string[] }
export interface Foreshadow { id: string; threat: string; region: string; due: number; text: string; exp?: string; stage?: string; at?: { x: number; y: number } }
export interface AdventureState {
  /** 旅人化身的等级（按账号） */
  avatars: Record<string, AvatarProgress>;
  /** 各支远征的进度（按远征 id） */
  expeditions: Record<string, ExpeditionState>;
  /** 各区域累计打倒的数量 */
  kills: Record<string, number>;
  /** 各种威胁被打倒的次数（表达式 slain()） */
  slain: Record<string, number>;
  /** 今天的战绩（冒险者面板） */
  today: { day: number; kills: number; loot: number; retreats: number; downs: number };
  /** 已经发出、还没兑现的预告 */
  foreshadows: Foreshadow[];
  /** 焦点角色第一次到达过的区域（区域标题卡只播一次） */
  visited: string[];
  /** 区域推演的次数（每游戏天限额） */
  wakeAi?: { day: number; n: number };
  seq: number;
}

export function freshAdventure(): AdventureState {
  return { avatars: {}, expeditions: {}, kills: {}, slain: {}, today: { day: 0, kills: 0, loot: 0, retreats: 0, downs: 0 }, foreshadows: [], visited: [], seq: 0 };
}

/** 区域的激活状态（§3.5）：主地图不在这里，永远激活 */
export interface RegionState {
  active: boolean;
  /** 最近一次有人在的时刻（游戏分钟） */
  seen: number;
  /** 进入休眠的时刻 */
  since?: number;
  /** 上次 AI 推演的时刻 */
  aiAt?: number;
}
export type RegionStates = Record<string, RegionState>;
