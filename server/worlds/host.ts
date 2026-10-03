import { withContext } from '../scheduler/context.ts';
import { pushChannel, CHANNEL_HZ } from '../net/realtime.ts';
import type { RtSession } from '../net/realtime.ts';
import { get as setting } from '../settings/index.ts';
import type { Town } from '../sim.ts';
import type { World } from '../types/world.ts';

const enc = new TextEncoder();

/** 一位 SSE 观众（http/app.ts 的 openStream）：push 收编码好的字节（有背压），旧式的 write 收文本 */
export interface SseClient {
  ip: string;
  push?(event: string, bytes: Uint8Array): void;
  write?(text: string): void;
  close?(): void;
  /** 积压的字节数 */
  backlog?: number;
}

// 世界托管：一个运行中的世界 = 一个 Town 实例 + 它的 SSE 观众。
// 负责把 Town 的事件推给观众、无人观看时休眠、重置 / 回溯 / 切换时间线时换一个新的 Town。
export class WorldHost {
  declare id: string;
  declare makeTown: () => Town;
  declare onWire: ((town: Town) => void) | null;
  declare _idle: number | (() => number);
  declare now: () => number;
  declare clients: Set<SseClient>;
  /** 游戏模式的实时通道（server/net/realtime.ts）：连上来的观众；有人时每 1/15 秒推一帧战斗通道 */
  rt: Set<RtSession> = new Set();
  declare rtTimer?: ReturnType<typeof setInterval> | null;
  declare clientsPerIp: Map<string, number>;
  declare lastViewer: number;
  declare town: Town;
  /** 由世界管理器设置：数据目录、登记项、磁盘是否超限 */
  declare dataRoot?: string;
  declare world?: World | null;
  declare diskFull?: boolean;
  /**
   * id：世界 id；makeTown：按当前时间线创建 Town；onWire：新 Town 接线时的额外设置（例如投票需要管理员终审）；
   * idlePauseSec：无人观看多久后休眠（0 = 不休眠；函数则每次读取当前设置）
   */
  constructor({ id, makeTown, onWire = null, idlePauseSec = 0, now = () => Date.now() }: { id: string; makeTown: () => Town; onWire?: ((town: Town) => void) | null; idlePauseSec?: number | (() => number); now?: () => number }) {
    this.id = id;
    this.makeTown = makeTown;
    this.onWire = onWire;
    this._idle = idlePauseSec;
    this.now = now;
    this.clients = new Set(); // { push(event, bytes) | write(text), ip }：见 http/app.ts 的 openStream
    // 实时通道的观众进出：有人时开战斗通道的定时器，没人时关掉
    const add = this.rt.add.bind(this.rt), del = this.rt.delete.bind(this.rt);
    this.rt.add = (s) => { add(s); this.wake(); if (!this.rtTimer) { this.rtTimer = setInterval(() => { try { pushChannel(this); } catch (e) { console.warn('[realtime]', (e as Error).message); } }, 1000 / CHANNEL_HZ); this.rtTimer.unref?.(); } return this.rt; };
    this.rt.delete = (s) => { const r = del(s); if (!this.rt.size && this.rtTimer) { clearInterval(this.rtTimer); this.rtTimer = null; } return r; };
    this.clientsPerIp = new Map();
    this.lastViewer = now();
    this.town = null as unknown as Town;
    this.replace(makeTown(), { initial: true });
  }

  get idlePauseSec(): number { return typeof this._idle === 'function' ? this._idle() : this._idle; }

  /** 推给所有观众：只序列化、编码一次，所有观众共用同一份字节 */
  broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let bytes: Uint8Array | null = null;
    for (const c of this.clients) {
      if (c.push) c.push(event, bytes ||= enc.encode(msg));
      else c.write!(msg);
    }
  }

  wire(t: Town): void {
    const b = (event: string) => (x: unknown) => this.broadcast(event, x);
    // 快照按 TICK_HZ 推送（默认每秒 4 次）；没有观众时连快照都不算
    t.wantsSnapshot = () => this.clients.size > 0;
    t.snapshotEvery = () => 1 / setting('TICK_HZ');
    t.on('tick', (s) => this.broadcast('tick', s));
    t.on('log', b('log'));
    t.on('agent', (id) => this.broadcast('agent', { id }));
    t.on('newspaper', b('newspaper'));
    t.on('world', b('world'));
    t.on('vfx', b('vfx'));
    t.on('combat', b('combat'));
    t.on('stage', b('stage'));
    t.on('agents', b('agents'));
    t.on('worldmap', b('worldmap'));
    t.on('regions', b('regions'));
    t.on('reinit', () => this.broadcast('init', t.initPayload()));
    // 面板类的推送只通知「有变化」，页面再按需拉取；800ms 内合并成一次
    for (const ev of ['story', 'evolution', 'decisions', 'proposals'] as const) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      t.on(ev, () => { if (!timer) timer = setTimeout(() => { timer = null; this.broadcast(ev, { t: t.t }); }, 800); });
    }
    this.onWire?.(t);
    // 世界的主循环在「这个世界」的调用上下文里运行：之后所有的模型调用都自动记在这个世界名下
    withContext({ worldId: this.id }, () => t.start());
  }

  /** 换上一个新的 Town（重置、回溯、切换时间线）；旧的由调用方先存盘停下 */
  replace(town: Town, { initial = false }: { initial?: boolean } = {}): Town {
    this.town = town;
    town.idle = !initial && this.idlePauseSec > 0 && this.clients.size === 0;
    this.wire(town);
    if (!initial) this.broadcast('init', town.initPayload());
    return town;
  }

  /** 用 makeTown 重新创建（先存盘停下当前的） */
  reload({ save = true }: { save?: boolean } = {}): Town {
    if (save) this.town.save();
    this.town.stop();
    return this.replace(this.makeTown());
  }

  // ---------- 观众 ----------
  /** 加入一位观众；返回离开时调用的函数 */
  join(client: SseClient): () => void {
    const n = this.clientsPerIp.get(client.ip) || 0;
    this.clientsPerIp.set(client.ip, n + 1);
    this.clients.add(client);
    this.wake();
    return () => {
      if (!this.clients.delete(client)) return;
      const left = (this.clientsPerIp.get(client.ip) || 1) - 1;
      left > 0 ? this.clientsPerIp.set(client.ip, left) : this.clientsPerIp.delete(client.ip);
      this.lastViewer = this.now();
    };
  }

  viewersFrom(ip: string): number { return this.clientsPerIp.get(ip) || 0; }

  wake(): void {
    this.lastViewer = this.now();
    if (this.town.idle) { this.town.idle = false; console.log(`[idle] ${this.id}：有访客，继续运转`); }
  }

  /** 暂停：世界自带的模型服务出了致命错误（按世界配置模型服务设计 §5.4）。有观众也不会唤醒，直到 resume */
  halt(info: NonNullable<Town['halted']>): void {
    if (this.town.halted) return;
    this.town.halted = info;
    this.town.save();
    this.broadcast('halt', info);
  }

  resume(): void {
    if (!this.town.halted) return;
    this.town.halted = null;
    this.broadcast('resume', { t: this.town.t });
  }

  /** 定时调用：无人观看超过 idlePauseSec 就休眠（不推进时间、不调用模型） */
  idleCheck(): void {
    // 不休眠（设置改为 0、或者世界改成了常驻）：已经在休眠的立即恢复
    if (!(this.idlePauseSec > 0)) {
      if (this.town.idle) { this.town.idle = false; console.log(`[idle] ${this.id}：不再休眠，继续运转`); }
      return;
    }
    if (this.clients.size) { this.wake(); return; }
    if (!this.town.idle && this.now() - this.lastViewer > this.idlePauseSec * 1000) {
      this.town.idle = true;
      this.town.save();
      console.log(`[idle] ${this.id}：无人观看，进入休眠`);
    }
  }

  close({ save = true }: { save?: boolean } = {}): void {
    for (const c of this.clients) c.close?.();
    this.clients.clear();
    for (const s of [...this.rt]) s.ws.close(1001, 'world closed');
    if (save) this.town.save();
    this.town.stop();
  }
}
