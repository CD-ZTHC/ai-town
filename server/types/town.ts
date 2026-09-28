// Town 的类型占位（重构方案 §8.2）：sim.js 与各个职责模块要到 B5 才迁移，在那之前内核模块里凡是拿到 Town 的地方都用 TownLike。
// B5 完成后把它换成 `import type { Town } from '../sim.ts'`，编译器会指出所有需要补的地方。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TownLike = any; // TODO(types): B5 迁移 sim.js 后换成 Town

/** 效果、规则、能力里「一个居民」的最小形状（运行中的居民对象，见 types/agent.ts 的 LiveAgent） */
export type { LiveAgent as AgentLike } from './agent.ts';
