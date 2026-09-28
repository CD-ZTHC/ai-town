// 时间线分支（设计文档 4.3）：从某个整点快照（或此刻）分出一条新的世界线，各自独立存档，可以来回切换。
// 目录：主时间线 = <data>/；分支 = <data>/timelines/<id>/；登记表 = <data>/timelines.json
import fs from 'node:fs';
import path from 'node:path';
import { SNAP_RE, readSnapshot } from './sim/persistence.ts';

const ID_RE = /^(main|tl-\d{1,4})$/;
const MAX_TIMELINES = 12;

const regFile = (root) => path.join(root, 'timelines.json');

export function registry(root) {
  try {
    const r = JSON.parse(fs.readFileSync(regFile(root), 'utf8'));
    if (Array.isArray(r.list) && r.list.some((t) => t.id === r.active)) return r;
  } catch {}
  return { active: 'main', list: [{ id: 'main', name: '主时间线', from: null, createdAt: null }] };
}

function writeRegistry(root, r) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(regFile(root), JSON.stringify(r, null, 2));
}

export function timelineDir(root, id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('时间线不存在'), { status: 404 });
  return id === 'main' ? path.resolve(root) : path.resolve(root, 'timelines', id);
}

export function activeDir(root) { return timelineDir(root, registry(root).active); }

/**
 * 分出一条新时间线。fromId：来源时间线；snapshot：来源时间线里的快照文件名（不填则用来源的当前存档）。
 * 返回新时间线的登记项。调用方负责在分叉前把来源小镇存盘。
 */
export function forkTimeline(root, { fromId, snapshot = null, name = '' }) {
  const r = registry(root);
  if (!r.list.some((t) => t.id === fromId)) throw Object.assign(new Error('来源时间线不存在'), { status: 404 });
  if (r.list.length >= MAX_TIMELINES) throw Object.assign(new Error(`时间线最多 ${MAX_TIMELINES} 条`), { status: 409 });
  const srcDir = timelineDir(root, fromId);
  let src;
  if (snapshot) {
    if (!SNAP_RE.test(String(snapshot))) throw Object.assign(new Error('快照名称不合法'), { status: 400 });
    src = path.join(srcDir, 'snapshots', snapshot);
  } else src = path.join(srcDir, 'save.json');
  if (!fs.existsSync(src)) throw Object.assign(new Error('来源存档不存在'), { status: 404 });
  const save = snapshot ? readSnapshot(src) : JSON.parse(fs.readFileSync(src, 'utf8'));
  const n = Math.max(0, ...r.list.map((t) => Number(/^tl-(\d+)$/.exec(t.id)?.[1] || 0))) + 1;
  const id = `tl-${n}`;
  const dir = timelineDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'save.json'), JSON.stringify(save));
  const t = save.t || 0;
  const entry = {
    id, name: String(name || '').trim().slice(0, 20) || `分支 ${n}`,
    from: { timeline: fromId, snapshot, day: Math.floor(t / 1440) + 1, hour: Math.floor((t % 1440) / 60) },
    createdAt: new Date().toISOString(),
  };
  r.list.push(entry);
  writeRegistry(root, r);
  return entry;
}

export function setActive(root, id) {
  const r = registry(root);
  if (!r.list.some((t) => t.id === id)) throw Object.assign(new Error('时间线不存在'), { status: 404 });
  r.active = id;
  writeRegistry(root, r);
  return timelineDir(root, id);
}
