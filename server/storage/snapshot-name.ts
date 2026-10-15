// 快照文件名：dNNN-HH.db.gz（数据库快照）；升级前的 dNNN-HH.json.gz、dNNN-HH.json 仍然可以回溯和分叉。
// 天数至少 3 位，第 1000 天起是 4 位及以上（d1000-00）——所以不能按字符串排序（"d1000" < "d998"），要按数值排。
export const SNAP_RE = /^d(\d{3,})-(\d{2})\.(?:db\.gz|json(?:\.gz)?)$/;

/** 快照名对应的游戏时间（小时）；不是快照名时返回 NaN */
function snapHour(name: string): number {
  const m = SNAP_RE.exec(name);
  return m ? Number(m[1]) * 24 + Number(m[2]) : NaN;
}

/** 按游戏时间从旧到新排（同一整点按文件名排，保持原来的先后） */
export function sortSnapshots(names: string[]): string[] {
  return [...names].sort((a, b) => snapHour(a) - snapHour(b) || (a < b ? -1 : a > b ? 1 : 0));
}
