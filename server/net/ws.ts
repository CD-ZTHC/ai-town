// 极简 WebSocket 服务端（RFC 6455，docs/design/realtime.md §3）：只用于游戏模式的实时通道，不引入依赖。
// 支持：握手、文本帧（不支持分片——客户端的消息都很小）、ping / pong、close；单条消息最大 16KB，超出直接断开。
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 16 * 1024;

/** 握手的 Sec-WebSocket-Accept */
export const acceptKey = (key: string): string => crypto.createHash('sha1').update(key + GUID).digest('base64');

/** 服务端发出的帧（不加掩码） */
export function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

/** 从缓冲里解出完整的帧；返回 [帧列表, 剩下的字节]；格式不对时抛出 */
export function parseFrames(buf: Buffer): [Array<{ opcode: number; data: Buffer }>, Buffer] {
  const out: Array<{ opcode: number; data: Buffer }> = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off]!, b1 = buf[off + 1]!;
    const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; const big = buf.readBigUInt64BE(p); if (big > BigInt(MAX_MSG)) throw new Error('消息太大'); len = Number(big); p += 8; }
    if (len > MAX_MSG) throw new Error('消息太大');
    if (!masked) throw new Error('客户端的帧必须加掩码');
    if (!fin || opcode === 0) throw new Error('不支持分片');
    if (buf.length - p < 4 + len) break;
    const mask = buf.subarray(p, p + 4);
    p += 4;
    const data = Buffer.from(buf.subarray(p, p + len));
    for (let i = 0; i < data.length; i++) data[i]! ^= mask[i & 3]!;
    out.push({ opcode, data });
    off = p + len;
  }
  return [out, buf.subarray(off)];
}

/** 一条 WebSocket 连接 */
export class WsConn {
  declare socket: Duplex;
  declare closed: boolean;
  onMessage: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;
  declare private buf: Buffer;
  declare private pinger: ReturnType<typeof setInterval>;
  declare lastSeen: number;

  constructor(socket: Duplex) {
    this.socket = socket;
    this.closed = false;
    this.buf = Buffer.alloc(0);
    this.lastSeen = Date.now(); // 确定性白名单：网络连接的心跳计时
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
    // 每 20 秒 ping 一次（Cloudflare 会关掉约 100 秒没有数据的连接）；60 秒没有任何回应就断开
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > 60_000) return this.close(1001, 'timeout'); // 确定性白名单：心跳超时
      this.write(frame(9, Buffer.alloc(0)));
    }, 20_000);
    this.pinger.unref?.();
  }

  private feed(d: Buffer) {
    this.lastSeen = Date.now(); // 确定性白名单：心跳计时
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_MSG * 4) return this.close(1009, 'too big');
    let frames;
    try { [frames, this.buf] = parseFrames(this.buf); } catch { return this.close(1002, 'protocol'); }
    for (const f of frames) {
      if (f.opcode === 1) this.onMessage?.(f.data.toString('utf8'));
      else if (f.opcode === 8) return this.close(1000, '');
      else if (f.opcode === 9) this.write(frame(10, f.data));
      // 10（pong）只用来刷新 lastSeen；二进制帧忽略
    }
  }

  private write(b: Buffer) { if (!this.closed) this.socket.write(b); }

  send(msg: unknown) { this.write(frame(1, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)))); }

  /** 积压在发送缓冲里的字节（慢的连接丢帧用） */
  get backlog(): number { return (this.socket as unknown as { writableLength?: number }).writableLength || 0; }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.write(frame(8, p));
    this.socket.end();
    this.end();
  }

  private end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.socket.destroy();
    this.onClose?.();
  }
}

/** 完成握手；不是合法的 WebSocket 请求时返回 null（调用方回 400 并关掉连接） */
export function accept(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') return null;
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  (socket as unknown as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true); // 小消息不攒包（Nagle），降低延迟
  return new WsConn(socket);
}

/** 拒绝升级请求 */
export function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
