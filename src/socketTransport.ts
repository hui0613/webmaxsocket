/**
 * Socket transport for the Max API (api.oneme.ru:443).
 * Binary msgpack protocol with LZ4 compression.
 * Used for ANDROID devices.
 */

import * as tls from 'tls';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { v4 as uuidv4 } from 'uuid';
import { Opcode, getOpcodeName } from './opcodes';
import { UserAgentPayload } from './userAgent';
import { APP_VERSION, BUILD_NUMBER } from './constants';

/**
 * LZ4 block decompression (as in the Max protocol).
 * Prefers the native `lz4` (requires node-gyp / VS C++ on Windows), otherwise pure JS `lz4js`.
 */
function resolveLz4Uncompress(): (inp: Buffer, out: Buffer) => number {
  try {
    const lz4Binding = require('lz4/lib/binding.js');
    return (inp, out) => lz4Binding.uncompress(inp, out);
  } catch (_) {
    try {
      const lz4js = require('lz4js');
      return (inp, out) => lz4js.decompressBlock(inp, out, 0, inp.length, 0);
    } catch (e: any) {
      throw new Error(
        'LZ4: install the `lz4js` dependency (npm i lz4js) or build the native `lz4` (Visual Studio, C++ workload). ' +
          e.message
      );
    }
  }
}
const lz4Uncompress = resolveLz4Uncompress();

const HOST = 'api.oneme.ru';
const PORT = 443;

/**
 * Builds a binary packet.
 * Header: 1b ver, 2b cmd, 1b seq, 2b opcode, 4b payload_len.
 */
const MSGPACK_INT64_OPTS = { useBigInt64: true };

function payloadNeedsBigInt64(v: any): boolean {
  if (typeof v === 'bigint') return true;
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(payloadNeedsBigInt64);
  for (const k of Object.keys(v)) {
    if (payloadNeedsBigInt64(v[k])) return true;
  }
  return false;
}

export function packPacket(
  ver: number,
  cmd: number,
  seq: number,
  opcode: number,
  payload: any
): Buffer {
  const payloadBuf = payload
    ? Buffer.from(
        msgpackEncode(
          payload,
          payloadNeedsBigInt64(payload) ? MSGPACK_INT64_OPTS : undefined
        )
      )
    : Buffer.alloc(0);
  const payloadLen = payloadBuf.length & 0xffffff;
  const buf = Buffer.allocUnsafe(10 + payloadBuf.length);
  buf.writeUInt8(ver, 0);
  buf.writeUInt16BE(cmd, 1);
  buf.writeUInt8(seq % 256, 3);
  buf.writeUInt16BE(opcode, 4);
  buf.writeUInt32BE(payloadLen, 6);
  if (payloadBuf.length) payloadBuf.copy(buf, 10);
  return buf;
}

/**
 * Parses a response. compFlag: raw LZ4 block.
 */
export function unpackPacket(data: Buffer): any {
  if (data.length < 10) return null;
  const ver = data.readUInt8(0);
  const cmd = data.readUInt16BE(1);
  const seq = data.readUInt8(3);
  const opcode = data.readUInt16BE(4);
  const packedLen = data.readUInt32BE(6);
  const compFlag = packedLen >> 24;
  const payloadLength = packedLen & 0xffffff;
  let payload = null;

  if (payloadLength > 0 && data.length >= 10 + payloadLength) {
    const payloadBytes = Buffer.from(data.subarray(10, 10 + payloadLength));
    try {
      if (compFlag !== 0) {
        const out = Buffer.alloc(Math.max(payloadLength * 20, 256 * 1024));
        const n = lz4Uncompress(payloadBytes, out);
        if (n > 0) payload = msgpackDecode(out.subarray(0, n), MSGPACK_INT64_OPTS);
      } else {
        payload = msgpackDecode(payloadBytes, MSGPACK_INT64_OPTS);
      }
    } catch (_) {
      payload = null;
    }
  }

  return { ver, cmd, seq, opcode, payload };
}

/** JSON for logs: bigint -> string, truncates long strings. */
function safeJsonForLog(obj: any, maxLen: number = 12000): string {
  if (obj === undefined) return '(no payload)';
  try {
    const s = JSON.stringify(
      obj,
      (k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    );
    return s.length > maxLen
      ? `${s.slice(0, maxLen)}\n… [truncated ${s.length - maxLen} chars]`
      : s;
  } catch (_) {
    return String(obj);
  }
}

function readExactlyFromBuffer(transport: any, n: number): Promise<any> {
  return new Promise<any>((resolve) => {
    const tryResolve = (): boolean => {
      if (transport._recvBuffer.length >= n) {
        const result = transport._recvBuffer.subarray(0, n);
        transport._recvBuffer = transport._recvBuffer.subarray(n);
        resolve(Buffer.from(result));
        return true;
      }
      return false;
    };
    if (tryResolve()) return;

    const onData = () => {
      if (tryResolve()) transport.socket.removeListener('data', onData);
    };
    transport.socket.on('data', onData);
  });
}

export class MaxSocketTransport {
  host: string;
  port: number;
  deviceId: string;
  deviceType: string;
  ua: string;
  debug: boolean;
  socket: any;
  seq: number;
  ver: number;
  pending: Map<any, any>;
  _recvBuffer: Buffer;
  onNotification: ((data: any) => void) | null;

  constructor(options: any = {}) {
    this.host = options.host || HOST;
    this.port = options.port || PORT;
    this.deviceId = options.deviceId || uuidv4();
    this.deviceType = options.deviceType || 'ANDROID';
    this.ua = options.ua || options.headerUserAgent ||
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
    this.debug = options.debug || false;

    this.socket = null;
    this.seq = 0;
    this.ver = 11;
    this.pending = new Map();
    this._recvBuffer = Buffer.alloc(0);
    this.onNotification = null;
  }

  _log(...args: any[]): void {
    if (this.debug) console.log('[Socket]', ...args);
  }

  _debugErr(...args: any[]): void {
    if (this.debug) console.error('[Socket]', ...args);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const opts = {
        host: this.host,
        port: this.port,
        servername: this.host,
        rejectUnauthorized: true
      };
      const sock = tls.connect(opts, () => {
        this.socket = sock;
        this._recvBuffer = Buffer.alloc(0);
        sock.on('data', (chunk: Buffer) => {
          this._recvBuffer = Buffer.concat([this._recvBuffer, chunk]);
        });
        this._log('Connected to', this.host + ':' + this.port);
        this._startRecvLoop();
        resolve();
      });
      sock.on('error', reject);
      sock.setKeepAlive(true);
    });
  }

  _makeMessage(opcode: number, payload: any, cmd: number = 0): any {
    this.seq++;
    return {
      ver: this.ver,
      cmd,
      seq: this.seq,
      opcode,
      // undefined — empty packet body (like GET_QR without payload on web); null/{} — explicit object
      payload: payload === undefined ? undefined : payload || {}
    };
  }

  /**
   * One-way send without waiting for a reply (answer to a server PING — like WebSocket sendPong).
   */
  sendOneWay(opcode: number, payload: any = {}, cmd: number = 0): void {
    if (!this.socket || this.socket.destroyed) return;
    const msg = this._makeMessage(opcode, payload, cmd);
    const packet = packPacket(msg.ver, msg.cmd, msg.seq, msg.opcode, msg.payload);
    this.socket.write(packet);
  }

  _startRecvLoop(): void {
    const readNext = async () => {
      if (!this.socket || this.socket.destroyed) return;
      try {
        const header = await readExactlyFromBuffer(this, 10);
        const packedLen = header.readUInt32BE(6);
        const payloadLen = packedLen & 0xffffff;
        let payloadData = Buffer.alloc(0);
        if (payloadLen > 0) {
          payloadData = await readExactlyFromBuffer(this, payloadLen);
        }
        const packet = unpackPacket(Buffer.concat([header, payloadData]));
        if (!packet) return readNext();

        const seqKey = packet.seq % 256;
        const payloads = Array.isArray(packet.payload) ? packet.payload : [packet.payload];
        for (const p of payloads) {
          const data = { ...packet, payload: p };
          const pending = this.pending.get(seqKey);
          if (pending) {
            this.pending.delete(seqKey);
            pending.resolve(data);
            break;
          }
          if (this.onNotification) this.onNotification(data);
        }
      } catch (e: any) {
        if (this.socket && !this.socket.destroyed) {
          this._log('Recv error:', e.message);
        }
        for (const [, p] of this.pending) p.reject(e);
        this.pending.clear();
        return;
      }
      readNext();
    };
    readNext();
  }

  async sendAndWait(opcode: number, payload: any, cmd: number = 0, timeout: number = 20000): Promise<any> {
    if (!this.socket || this.socket.destroyed) throw new Error('Socket not connected');

    const outMsg = this._makeMessage(opcode, payload, cmd);
    const seqKey = outMsg.seq % 256;
    const packet = packPacket(outMsg.ver, outMsg.cmd, outMsg.seq, outMsg.opcode, outMsg.payload);

    if (this.debug) {
      this._log('→', getOpcodeName(opcode), `(seq=${outMsg.seq})`, safeJsonForLog(payload));
    }

    let pendingRef: any;
    const promise = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => {
        const p = this.pending.get(seqKey);
        if (p) {
          this.pending.delete(seqKey);
          p.reject(new Error(`Timeout waiting for opcode ${getOpcodeName(opcode)}`));
        }
      }, timeout);
      pendingRef = {
        resolve: (data: any) => { clearTimeout(t); resolve(data); },
        reject: (err: any) => { clearTimeout(t); reject(err); }
      };
      this.pending.set(seqKey, pendingRef);
    });

    this.socket.write(packet, (err: any) => {
      if (err) {
        const p = this.pending.get(seqKey);
        if (p) {
          this.pending.delete(seqKey);
          p.reject(err);
        }
      }
    });

    const result = await promise;
    if (result.payload && result.payload.error) {
      const err = result.payload.error;
      const localized = result.payload.localizedMessage;
      const errText =
        localized ||
        (typeof err === 'string' ? err : err && err.message != null ? String(err.message) : '') ||
        JSON.stringify(err);

      if (this.debug) {
        this._debugErr('RPC error response', {
          opcode: getOpcodeName(opcode),
          opcodeNum: opcode,
          seq: outMsg.seq,
          outgoingPayload: safeJsonForLog(payload),
          fullResponsePayload: safeJsonForLog(result.payload)
        });
      }

      const e: any = new Error(errText);
      if (this.debug) e.rawPayload = result.payload;
      throw e;
    }
    return result;
  }

  async handshake(userAgentPayload?: any): Promise<any> {
    const ua = userAgentPayload || new UserAgentPayload({
      deviceType: this.deviceType,
      headerUserAgent: this.ua,
      appVersion: APP_VERSION,
      osVersion: '14',
      deviceName: 'Android',
      screen: '360x780 3.0x',
      buildNumber: BUILD_NUMBER
    });
    const payload = {
      deviceId: this.deviceId,
      userAgent: typeof ua.toJSON === 'function' ? ua.toJSON() : ua
    };
    const resp = await this.sendAndWait(Opcode.SESSION_INIT, payload);
    this._log('Handshake OK');
    return resp;
  }

  async requestCode(phone: string, language: string = 'ru'): Promise<any> {
    const payload = { phone, type: 'START_AUTH', language };
    const data = await this.sendAndWait(Opcode.AUTH_REQUEST, payload);
    return data.payload?.token || null;
  }

  async sendCode(tempToken: string, code: string): Promise<any> {
    const payload = {
      token: tempToken,
      verifyCode: code,
      authTokenType: 'CHECK_CODE'
    };
    const data = await this.sendAndWait(Opcode.AUTH, payload);
    return data.payload;
  }

  async sendLogin2FAPassword(trackId: string, password: string): Promise<any> {
    const payload = {
      trackId: String(trackId).trim(),
      password: String(password)
    };
    const data = await this.sendAndWait(Opcode.AUTH_LOGIN_CHECK_PASSWORD, payload);
    return data.payload;
  }

  async sync(token: string, userAgentJson?: any): Promise<any> {
    const payload: any = {
      interactive: true,
      token,
      chatsSync: 0,
      contactsSync: 0,
      presenceSync: 0,
      draftsSync: 0,
      chatsCount: 40
    };
    if (userAgentJson) payload.userAgent = userAgentJson;
    const data = await this.sendAndWait(Opcode.LOGIN, payload);
    return data.payload;
  }

  async getChats(marker: number = 0): Promise<any[]> {
    const data = await this.sendAndWait(Opcode.CHATS_LIST, { marker });
    return data.payload?.chats || [];
  }

  async getHistory(chatId: any, from: number = Date.now(), backward: number = 200, forward: number = 0): Promise<any[]> {
    const data = await this.sendAndWait(Opcode.CHAT_HISTORY, {
      chatId,
      from,
      forward,
      backward,
      getMessages: true
    });
    return data.payload?.messages || [];
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [, p] of this.pending) p.reject(new Error('Connection closed'));
    this.pending.clear();
  }
}
