// 内容分级（黑暗叙事设计 §3）：分级的顺序与「允许到什么程度」的判断集中在这里，别处不要写死分级名。
// 没有依赖，spec.js、pack.js、guard.js 都可以引用。

export const RATINGS = ['cozy', 'adventure', 'epic', 'dark', 'tragic'] as const;
export type Rating = (typeof RATINGS)[number];
const ORDER: Record<string, number> = Object.fromEntries(RATINGS.map((r, i) => [r, i]));

/** rating 是否达到 min（未知分级视为 cozy） */
export const ratingAtLeast = (rating: string | null | undefined, min: string): boolean => (ORDER[rating ?? ''] ?? 0) >= (ORDER[min] ?? 0);

/** 死亡可以作为叙事事件出现的分级（dark、tragic） */
export const lethal = (rating: string | null | undefined): boolean => ratingAtLeast(rating, 'dark');

/** 允许敌对与战斗的分级（adventure 起；死亡另看 lethal） */
export const hostile = (rating: string | null | undefined): boolean => ratingAtLeast(rating, 'adventure');

/** 关键词审核用的分级：会致死的分级按它自己审，其余一律按 epic（冒险词汇放行、死亡词汇拦截） */
export const reviewRating = (rating: string | null | undefined): string => (lethal(rating) ? rating! : 'epic');

/** 需要管理员显式授予的分级（不在默认授予里，界面上单独标注） */
export const EXPLICIT_RATINGS: readonly Rating[] = ['dark', 'tragic'];
