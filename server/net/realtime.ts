// 游戏模式的实时通道（docs/design/realtime.md §3、§6）：经 Cloudflare 的一条 WebSocket，承载
//   上行：位置上报 mv、出招 act、心跳 ping（带上测得的往返延迟）、看哪张地图 view、网络统计 net；
//   下行：pong、位置纠正 ack、出招失败 err、战斗通道 cf（视野里有战斗时每秒 15 次：参战单位的位置与血量、飞行中的弹道）。
// 身份：页面先用普通的 HTTP 接口（会话 Cookie、Origin 校验都照旧）换一张 30 秒内有效、只能用一次的票据，再带着它连上来。
import crypto from 'node:crypto';
import { accept, reject } from './ws.ts';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WsConn } from './ws.ts';
import type { Town } from '../sim.ts';

const TICKET_MS = 30_000;
export const CHANNEL_HZ = 15;
const MAX_BACKLOG = 64 * 1024; // 发送缓冲积压超过它的连接跳过这一帧（慢的网络不拖累别人）

interface Ticket { vid: string; world: string; residents: boolean; exp: number }
const tickets = new Map<string, Ticket>();

/** 发一张票据（调用方已经确认过身份） */
export function issueTicket(vid: string, world: string, residents: boolean): string {
  const now = Date.now(); // 确定性白名单：票据有效期
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
  const id = crypto.randomBytes(18).toString('base64url');
  tickets.set(id, { vid, world, residents, exp: now + TICKET_MS });
  return id;
}

/** 一位连上来的观众 */
export interface RtSession { ws: WsConn; vid: string; residents: boolean; region: string; stats?: { rtt50?: number; rtt95?: number; gap95?: number; at: number } }
/** 托管这个世界的对象需要提供的东西（WorldHost） */
export interface RtHost { town: Town; rt: Set<RtSession> }

/** /api/realtime 或 /w/<世界>/api/realtime、/api/w/<世界>/realtime：解析出世界 id 与票据 */
export function parseUpgradeUrl(url: string): { world: string | null; ticket: string | null } | null {
  const u = new URL(url, 'http://x');
  const m = /^(?:\/w\/([a-z0-9_-]{1,40}))?\/api(?:\/w\/([a-z0-9_-]{1,40}))?\/realtime$/.exec(u.pathname);
  if (!m) return null;
  return { world: m[1] || m[2] || null, ticket: u.searchParams.get('ticket') };
}

/** HTTP 服务器的 upgrade 事件：校验票据、完成握手、把连接交给世界 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, { hostOf, defaultWorld }: { hostOf: (id: string) => RtHost | null; defaultWorld: () => string }): boolean {
  const p = parseUpgradeUrl(req.url || '');
  if (!p) return false; // 不是实时通道：交给别人（或者关掉）
  const t = p.ticket ? tickets.get(p.ticket) : undefined;
  if (p.ticket) tickets.delete(p.ticket);
  const world = p.world || defaultWorld();
  if (!t || t.exp < Date.now() || t.world !== world) { reject(socket, 401, 'Unauthorized'); return true; } // 确定性白名单：票据有效期
  const host = hostOf(world);
  if (!host) { reject(socket, 404, 'Not Found'); return true; }
  const ws = accept(req, socket);
  if (!ws) { reject(socket, 400, 'Bad Request'); return true; }
  const s: RtSession = { ws, vid: t.vid, residents: t.residents, region: 'town' };
  host.rt.add(s);
  ws.onClose = () => host.rt.delete(s);
  ws.onMessage = (text) => onMessage(host, s, text);
  return true;
}

type Msg = Record<string, unknown>;
/** 处理一条上行消息（错误只回给这位观众，不影响世界） */
export function onMessage(host: RtHost, s: RtSession, text: string) {
  let m: Msg;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const town = host.town;
  try {
    switch (m.t) {
      case 'ping': {
        s.ws.send({ t: 'pong', ts: m.ts });
        const rtt = Number(m.rtt);
        const v = town.avatars.mine(s.vid);
        if (v && Number.isFinite(rtt) && rtt > 0 && rtt < 5000) v.rtt = rtt;
        if (v) v.seen = town.avatars.now();
        return;
      }
      case 'mv': {
        const r = town.avatars.report(s.vid, { x: m.x, y: m.y, dir: m.dir, pv: m.pv, seq: m.seq, via: m.via });
        // 被拒绝、或者过了路口（客户端要拿到新的版本号）时回执
        if (!r.ok || r.pv != null) s.ws.send({ t: 'ack', ...r });
        return;
      }
      case 'act': {
        const r = town.avatarAct(s.vid, { skill: m.skill, target: m.target, dir: m.dir, ax: m.ax, ay: m.ay }, { residents: s.residents });
        if (!r.ok) s.ws.send({ t: 'err', reason: r.reason, skill: m.skill });
        return;
      }
      case 'view': if (typeof m.region === 'string' && m.region.length < 40) s.region = m.region; return;
      case 'net': {
        const n = (k: string) => (Number.isFinite(Number(m[k])) ? Math.round(Number(m[k])) : undefined);
        s.stats = { rtt50: n('rtt50'), rtt95: n('rtt95'), gap95: n('gap95'), at: town.avatars.now() };
        return;
      }
    }
  } catch (e) {
    s.ws.send({ t: 'err', reason: (e as Error).message, skill: m.skill });
  }
}

/** 战斗通道的一帧：这张地图上所有战斗里的单位（位置、血量）与飞行中的弹道；没有战斗时返回 null */
export function channelFrame(town: Town, region: string) {
  const fights = (town.fights || []).filter((F) => F.region === region);
  if (!fights.length) return null;
  const u: Array<[string, number, number, number]> = [];
  const p: Array<[string, number, number]> = [];
  for (const F of fights) {
    for (const f of F.fighters) {
      if (f.out) continue;
      const x = town.unit(f);
      if (x) u.push([`${f.kind}:${f.id}`, +x.x.toFixed(2), +x.y.toFixed(2), Math.round(x.hp)]);
    }
    for (const q of F.projectiles || []) p.push([q.id, +q.x.toFixed(2), +q.y.toFixed(2)]);
  }
  return { t: 'cf', ts: town.now(), u, ...(p.length ? { p } : {}) };
}

/** 每 1/15 秒：给看着有战斗的地图的观众推一帧 */
export function pushChannel(host: RtHost) {
  if (!host.rt.size || !host.town.fights?.length) return;
  const cache = new Map<string, string | null>();
  for (const s of host.rt) {
    if (s.ws.backlog > MAX_BACKLOG) continue;
    if (!cache.has(s.region)) { const f = channelFrame(host.town, s.region); cache.set(s.region, f ? JSON.stringify(f) : null); }
    const msg = cache.get(s.region);
    if (msg) s.ws.send(msg);
  }
}

/** 这个世界最近 2 分钟内上报过的网络统计（后台概览用） */
export function netSummary(host: RtHost) {
  const now = host.town.avatars.now();
  const list = [...host.rt].map((s) => s.stats).filter((x): x is NonNullable<RtSession['stats']> => Boolean(x && now - x.at < 120_000));
  const med = (k: 'rtt50' | 'rtt95' | 'gap95') => { const v = list.map((x) => x[k]).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  return { connections: host.rt.size, reporting: list.length, rtt50: med('rtt50'), rtt95: med('rtt95'), gap95: med('gap95') };
}
