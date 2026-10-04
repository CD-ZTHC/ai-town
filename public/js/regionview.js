// 看哪张地图的规则（纯函数，测试见 test/frontend.test.ts）：未开放的区域什么时候要切回主地图、取区域地图失败后多久再试。

/**
 * 当前看的区域要不要切回主地图：主地图、开放的区域不用切；没开放的区域，
 * 只要正在跟随 / 选中的人、自己的化身就在这张地图上，也留在这里（否则会和跟随逻辑来回切换）
 */
export function mustLeave(view, regionsOpen, here = []) {
  if (!view || view === 'town' || regionsOpen?.[view]?.open) return false;
  return !here.includes(view);
}

/** 取区域地图失败后的退避：失败过 n 次，等 2^(n-1) × 2 秒再试（最多 60 秒）；没失败过返回 0 */
export function retryAt(fail) {
  return fail ? fail.at + Math.min(60_000, 2000 * 2 ** Math.max(0, fail.n - 1)) : 0;
}

/**
 * 镜头中心的可移动范围（像素）：允许越过地图边缘一点，再按界面遮挡（左边的名册与面板、右边的检视面板）多让出一些，
 * 这样贴着地图边缘的人也能挪到没被挡住的地方。地图比屏幕小时，居中在没被挡住的区域里
 */
export function camRange(size, half, zoom, lo, hi, padLo, padHi) {
  if (half * 2 > size) return [size / 2 - (lo - hi) / 2 / zoom, size / 2 - (lo - hi) / 2 / zoom];
  return [half - padLo - lo / zoom, size - half + padHi + hi / zoom];
}
