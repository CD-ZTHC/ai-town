// 世界管理器（多世界设计 §6.1）：一台服务器同时托管多个世界，按需加载、无人时休眠、休眠久了存盘卸载。
//   loaded: Map<worldId, WorldHost>
//   open(id)   加载（或唤醒）世界；超出上限时先卸载一个无人观看、空闲最久的世界；都有人在看就返回「世界满员」
//   close(id)  存盘并从内存卸载
//   tick()     每个世界各自计算「无人观看」时长：先休眠（IDLE_PAUSE_SEC，不推进时间、不调用模型），再卸载（WORLD_UNLOAD_SEC）
// 常驻世界（PINNED_WORLDS）不会被卸载，但计入上限。
import fs from 'node:fs';
import { WorldHost } from './host.ts';
import { WorldRegistry } from './registry.ts';
import { worldRoot } from './migrate.ts';
import { checkDisk, diskLimit } from './disk.ts';
import { get as setting } from '../settings/index.ts';
import type { Town } from '../sim.ts';
import type { World } from '../types/world.ts';

export class WorldFullError extends Error {
  declare status: number;
  declare retryAfter: number;
  declare full: boolean;
  constructor(retryAfter: number) { super('现在同时运行的世界已经满了，请稍后再来'); this.status = 503; this.retryAfter = retryAfter; this.full = true; }
}

export class WorldManager {
  declare data: string;
  declare registry: WorldRegistry;
  declare makeTownFor: (world: World, root: string) => Town;
  declare onWire: ((world: World, town: Town) => void) | null;
  declare ownerGrant: (world: World) => { quota?: { diskMB?: number } } | null;
  declare now: () => number;
  declare loaded: Map<string, WorldHost>;
  declare lastDiskCheck: Map<string, number>;
  /**
   * data：数据根目录；makeTown：按世界登记项创建 Town（root = data/worlds/<id>/）；
   * onWire：新 Town 接线时的额外设置（例如决策的终审人）；ownerGrant：世界创建者的 genesis 授予（磁盘上限用）
   */
  constructor({ data, registry, makeTown, onWire = null, ownerGrant = () => null, now = () => Date.now() }: {
    data: string; registry: WorldRegistry; makeTown: (world: World, root: string) => Town; onWire?: ((world: World, town: Town) => void) | null;
    ownerGrant?: (world: World) => { quota?: { diskMB?: number } } | null; now?: () => number;
  }) {
    this.data = data;
    this.registry = registry;
    this.makeTownFor = makeTown;
    this.onWire = onWire;
    this.ownerGrant = ownerGrant;
    this.now = now;
    this.loaded = new Map();
    this.lastDiskCheck = new Map();
  }

  pinned(): Set<string> { return new Set(setting('PINNED_WORLDS')); }
  isPinned(id: string): boolean { return this.pinned().has(id); }
  get(id: string): WorldHost | null { return this.loaded.get(id) || null; }
  root(id: string): string { return worldRoot(this.data, id); }

  /** 加载（或返回已加载的）世界 */
  open(id: string): WorldHost {
    const hit = this.loaded.get(id);
    if (hit) return hit;
    const w = this.registry.get(id);
    if (!WorldRegistry.runnable(w)) throw Object.assign(new Error('世界不存在'), { status: 404 });
    this.makeRoom();
    const root = this.root(id);
    fs.mkdirSync(root, { recursive: true });
    let host: WorldHost | null = null; // 构造时就会接线第一个 Town，此时 host 还没赋值
    host = new WorldHost({
      id,
      makeTown: () => this.makeTownFor(this.registry.get(id) || w!, root),
      onWire: (t) => {
        t.paused = t.paused || this.registry.get(id)?.status === 'paused';
        t.diskFull = (host as WorldHost | null)?.diskFull || false;
        this.onWire?.(this.registry.get(id) || w!, t);
      },
      idlePauseSec: () => setting('IDLE_PAUSE_SEC'),
      now: this.now,
    });
    host.dataRoot = root;
    host.world = w;
    this.loaded.set(id, host);
    this.checkDisk(id, { force: true });
    console.log(`[worlds] 已加载 ${id}（运行中 ${this.loaded.size}/${setting('MAX_ACTIVE_WORLDS')}）`);
    return host;
  }

  /** 腾出一个位置：卸载无人观看、空闲最久的非常驻世界；都有人在看就抛出 WorldFullError */
  makeRoom(): void {
    const max = setting('MAX_ACTIVE_WORLDS');
    while (this.loaded.size >= max) {
      const idle = [...this.loaded.values()].filter((h) => !h.clients.size && !this.isPinned(h.id)).sort((a, b) => a.lastViewer - b.lastViewer);
      if (!idle.length) throw new WorldFullError(this.estimateWait());
      this.close(idle[0]!.id, '为其他世界腾出位置');
    }
  }

  /** 世界满员时的预计等待（秒）：最早有观众离开之后，还要等休眠与卸载的时间 */
  estimateWait(): number { return Math.max(60, setting('IDLE_PAUSE_SEC') + 60); }

  /** 能不能再加载一个世界（不实际加载）；满员时返回预计等待秒数 */
  canOpen(id: string): { ok: boolean; retryAfter?: number } {
    if (this.loaded.has(id)) return { ok: true };
    if (this.loaded.size < setting('MAX_ACTIVE_WORLDS')) return { ok: true };
    const idle = [...this.loaded.values()].some((h) => !h.clients.size && !this.isPinned(h.id));
    return idle ? { ok: true } : { ok: false, retryAfter: this.estimateWait() };
  }

  close(id: string, why = ''): boolean {
    const h = this.loaded.get(id);
    if (!h) return false;
    this.loaded.delete(id);
    h.broadcast('closed', { reason: why });
    h.close({ save: true });
    this.checkDisk(id, { force: true });
    console.log(`[worlds] 已卸载 ${id}${why ? `（${why}）` : ''}`);
    return true;
  }

  /** 世界状态变了（下架、归档、暂停 / 恢复）：立即生效 */
  onStatus(id: string): void {
    const w = this.registry.get(id);
    const h = this.loaded.get(id);
    if (!h) return;
    h.world = w;
    if (!WorldRegistry.runnable(w)) { this.close(id, w ? w.statusReason || `世界已${w.status === 'suspended' ? '下架' : '关闭'}` : '世界已删除'); return; }
    h.town.paused = w!.status === 'paused';
  }

  broadcastAll(event: string, data: unknown): void { for (const h of this.loaded.values()) h.broadcast(event, data); }

  /** 定时调用：休眠、卸载、每小时统计磁盘 */
  tick(): void {
    const unloadAfter = (setting('IDLE_PAUSE_SEC') + setting('WORLD_UNLOAD_SEC')) * 1000;
    for (const h of [...this.loaded.values()]) {
      h.idleCheck();
      if (!h.clients.size && !this.isPinned(h.id) && this.now() - h.lastViewer > unloadAfter) this.close(h.id, '长时间无人观看');
      else this.checkDisk(h.id);
    }
    // 常驻世界总是加载着
    for (const id of this.pinned()) {
      if (!this.loaded.has(id) && WorldRegistry.runnable(this.registry.get(id))) {
        try { this.open(id); } catch (e) { console.warn(`[worlds] 常驻世界 ${id} 加载失败：`, (e as Error).message); }
      }
    }
  }

  /** 统计磁盘（每小时一次，加载 / 卸载时立即）；超限先回收，仍然超限就标记 diskFull */
  checkDisk(id: string, { force = false }: { force?: boolean } = {}): ReturnType<typeof checkDisk> | null {
    const last = this.lastDiskCheck.get(id) || 0;
    if (!force && this.now() - last < 3600_000) return null;
    this.lastDiskCheck.set(id, this.now());
    const w = this.registry.get(id);
    if (!w) return null;
    const r = checkDisk(this.root(id), diskLimit(w, this.ownerGrant(w)));
    this.registry.setDisk(id, r.bytes, r.detail);
    const h = this.loaded.get(id);
    if (h) {
      if (Boolean(h.diskFull) !== r.full) console.log(`[disk] ${id}：${r.full ? '超出磁盘上限，暂停新建时间线、快照与新插件' : '磁盘占用恢复正常'}`);
      h.diskFull = r.full;
      if (h.town) h.town.diskFull = r.full;
    }
    return r;
  }

  /** 所有用户世界加起来的磁盘占用（字节） */
  userDiskTotal(): number { return this.registry.list({ official: 0 }).reduce((s, w) => s + (w.diskBytes || 0), 0); }

  view() {
    return [...this.loaded.values()].map((h) => ({ id: h.id, viewers: h.clients.size, idle: Boolean(h.town.idle), pinned: this.isPinned(h.id), day: h.town.day, lastViewer: h.lastViewer, diskFull: Boolean(h.diskFull) }));
  }

  closeAll(): void { for (const id of [...this.loaded.keys()]) this.close(id, '服务器停止'); }
}
