// 世界托管：一个运行中的世界 = 一个 Town 实例 + 它的 SSE 观众。
// 负责把 Town 的事件推给观众、无人观看时休眠、重置 / 回溯 / 切换时间线时换一个新的 Town。
export class WorldHost {
  /**
   * @param {object} o
   * @param {string} o.id 世界 id
   * @param {() => import('../sim.js').Town} o.makeTown 按当前时间线创建 Town
   * @param {(town) => void} [o.onWire] 新 Town 接线时的额外设置（例如投票需要管理员终审）
   * @param {number|(() => number)} [o.idlePauseSec] 无人观看多久后休眠（0 = 不休眠；函数则每次读取当前设置）
   */
  constructor({ id, makeTown, onWire = null, idlePauseSec = 0, now = () => Date.now() }) {
    this.id = id;
    this.makeTown = makeTown;
    this.onWire = onWire;
    this._idle = idlePauseSec;
    this.now = now;
    this.clients = new Set(); // { send(event, data), ip }
    this.clientsPerIp = new Map();
    this.lastViewer = now();
    this.town = null;
    this.replace(makeTown(), { initial: true });
  }

  get idlePauseSec() { return typeof this._idle === 'function' ? this._idle() : this._idle; }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  wire(t) {
    const b = (event) => (x) => this.broadcast(event, x);
    t.on('tick', (s) => { if (this.clients.size) this.broadcast('tick', s); });
    t.on('log', b('log'));
    t.on('agent', (id) => this.broadcast('agent', { id }));
    t.on('newspaper', b('newspaper'));
    t.on('world', b('world'));
    t.on('vfx', b('vfx'));
    t.on('agents', b('agents'));
    t.on('worldmap', b('worldmap'));
    t.on('regions', b('regions'));
    // 面板类的推送只通知「有变化」，页面再按需拉取；800ms 内合并成一次
    for (const ev of ['story', 'evolution', 'decisions', 'proposals']) {
      let timer = null;
      t.on(ev, () => { if (!timer) timer = setTimeout(() => { timer = null; this.broadcast(ev, { t: t.t }); }, 800); });
    }
    this.onWire?.(t);
    t.start();
  }

  /** 换上一个新的 Town（重置、回溯、切换时间线）；旧的由调用方先存盘停下 */
  replace(town, { initial = false } = {}) {
    this.town = town;
    town.idle = !initial && this.idlePauseSec > 0 && this.clients.size === 0;
    this.wire(town);
    if (!initial) this.broadcast('init', town.initPayload());
    return town;
  }

  /** 用 makeTown 重新创建（先存盘停下当前的） */
  reload({ save = true } = {}) {
    if (save) this.town.save();
    this.town.stop();
    return this.replace(this.makeTown());
  }

  // ---------- 观众 ----------
  /** 加入一位观众；返回离开时调用的函数 */
  join(client) {
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

  viewersFrom(ip) { return this.clientsPerIp.get(ip) || 0; }

  wake() {
    this.lastViewer = this.now();
    if (this.town.idle) { this.town.idle = false; console.log(`[idle] ${this.id}：有访客，继续运转`); }
  }

  /** 定时调用：无人观看超过 idlePauseSec 就休眠（不推进时间、不调用模型） */
  idleCheck() {
    if (!(this.idlePauseSec > 0)) return;
    if (this.clients.size) { this.wake(); return; }
    if (!this.town.idle && this.now() - this.lastViewer > this.idlePauseSec * 1000) {
      this.town.idle = true;
      this.town.save();
      console.log(`[idle] ${this.id}：无人观看，进入休眠`);
    }
  }

  close({ save = true } = {}) {
    for (const c of this.clients) c.close?.();
    this.clients.clear();
    if (save) this.town.save();
    this.town.stop();
  }
}
