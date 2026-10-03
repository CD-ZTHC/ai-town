// 可设置种子的随机数（重构方案 P7）：模拟里的随机都从 town.rng 取，同一个种子、同样的输入 → 同样的世界。
// mulberry32：32 位状态，足够快，状态就是一个整数，可以直接写进存档，读档后从断点继续。
import crypto from 'node:crypto';

/** 一个随机数发生器：调用得到 [0, 1)；state 是当前状态（写进存档） */
export interface Rng {
  (): number;
  readonly seed: number;
  readonly state: number;
  /** 回到某个状态（读档时用；发生器对象不变，已经拿着它的子系统不受影响） */
  restore(state: number): void;
}

export function createRng(seed: number, state: number = seed): Rng {
  let s = state >>> 0;
  const next = (() => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  }) as Rng;
  Object.defineProperties(next, {
    seed: { value: seed >>> 0, enumerable: true },
    state: { get: () => s, enumerable: true },
    restore: { value: (x: number) => { s = x >>> 0; } },
  });
  return next;
}

/** 新世界的种子：真随机 */
export function freshSeed(): number { return crypto.randomInt(0, 2 ** 32 - 1); }

/** 存档里的随机数状态 → 发生器；没有（旧存档）时用新种子 */
export function rngFromSave(saved: unknown, seed?: number): Rng {
  if (seed != null) return createRng(seed);
  const r = saved as { seed?: unknown; state?: unknown } | null | undefined;
  if (r && Number.isInteger(r.seed) && Number.isInteger(r.state)) return createRng(r.seed as number, r.state as number);
  return createRng(freshSeed());
}

/** 从数组里随机取一个 */
export const pick = <T>(rng: () => number, a: readonly T[]): T => a[Math.floor(rng() * a.length)]!;
