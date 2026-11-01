#!/usr/bin/env node
/*
 * ライブ表示の中継の見本: NES の VGM(録音スクリプト tools/mesen/vgm-recorder.lua の出力や
 * tools/headless/nsf2vgm.js の出力)を、実時間で 1 フレームずつ WebSocket へ流す。
 * 本体の鍵盤表示ヘッダ [LIVE] → 接続(既定 ws://localhost:8765)で、ロールが追記モードで育つ。
 *
 * メッセージ形式は src/ui/liveRoll.js 冒頭のとおり(JSON テキスト)。エミュレータから直接流す
 * 中継を書くときの雛形でもある(Lua 側にソケットが無ければ、ファイルを tail する中継でもよい)。
 *
 * 使い方: node tools/live/vgm-ws-relay.js "song.vgm" [--port 8765] [--loop] [--speed 1]
 *   --loop : 曲末で先頭へ戻って流し続ける(ループ点は見ない)
 *   --speed: 実時間に対する倍率(2 なら倍速。表示の重さを見る用)
 *
 * WebSocket サーバは Node に無いので、RFC 6455 の最小実装(テキストフレーム送信、ping/close 応答)。
 */
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { load, readBytes } = require('../headless/load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const file = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));
if (!file) { console.error('usage: node tools/live/vgm-ws-relay.js "song.vgm" [--port 8765] [--loop] [--speed 1]'); process.exit(2); }
const port = parseInt(arg('--port', '8765'), 10);
const loop = process.argv.includes('--loop');
const speed = parseFloat(arg('--speed', '1')) || 1;
const SPF = 735; // 1 フレーム = 735 サンプル(DESIGN-CAPTURE.md P-2)
const FPS = 60.0988;

// ── VGM → フレームごとの NES 書き込み列 ───────────────────────────────────
// 0xB4 aa dd = $4000+aa、NESX ブロック(kind=1) = CPU アドレス直指定。他チップのコマンドは読み飛ばす
function parseNesFrames(MML, bytes) {
  const VGM = MML.VGM;
  const hdr = VGM.parseHeader(bytes);
  const frames = [];
  const at = (f) => { while (frames.length <= f) frames.push([]); return frames[f]; };
  const end = hdr.gd3Offset && hdr.gd3Offset > hdr.dataOffset ? Math.min(hdr.gd3Offset, bytes.length) : bytes.length;
  let p = hdr.dataOffset, t = 0;
  let chips = [];
  while (p < end) {
    const op = bytes[p];
    if (op === 0x66) break;
    const f = Math.floor(t / SPF);
    if (op === 0x61) { t += bytes[p + 1] | (bytes[p + 2] << 8); p += 3; continue; }
    if (op === 0x62) { t += SPF; p++; continue; }
    if (op === 0x63) { t += 882; p++; continue; }
    if (op >= 0x70 && op <= 0x7F) { t += (op & 0xF) + 1; p++; continue; }
    if (op === 0x67) {
      const size = (bytes[p + 3] | (bytes[p + 4] << 8) | (bytes[p + 5] << 16) | (bytes[p + 6] << 24)) & 0x7FFFFFFF;
      const type = bytes[p + 2], block = bytes.subarray(p + 7, p + 7 + size);
      if (VGM.isNesxBlock(type, block)) {
        if (block[5] === VGM.NESX.KIND_HEADER && block.length >= 7) chips = nesxChips(MML, block[6]);
        else if (block[5] === VGM.NESX.KIND_WRITES) {
          const fr = at(f);
          for (let q = 6; q + 4 <= block.length; q += 4) {
            const addr = block[q] | (block[q + 1] << 8), value = block[q + 2], meta = block[q + 3];
            if (meta & 0x80) fr.push([addr, 0, 1]); else fr.push([addr, value, 0]);
          }
        }
      }
      p += 7 + size; continue;
    }
    if (op === 0x64) { p += 4; continue; }
    const n = VGM.operandLength(op);
    if (n < 0) throw new Error('unknown VGM command 0x' + op.toString(16) + ' at ' + p);
    if (op === 0xB4) at(f).push([0x4000 + (bytes[p + 1] & 0x7F), bytes[p + 2], 0]);
    if (op >= 0x80 && op <= 0x8F) t += op & 0xF;
    p += 1 + n;
  }
  at(Math.max(0, Math.round(t / SPF) - 1));
  return { frames, chips, hdr };
}
function nesxChips(MML, flags) {
  const F = MML.NSF.CHIP_FLAGS, names = [];
  if (flags & F.VRC6) names.push('vrc6'); if (flags & F.VRC7) names.push('vrc7'); if (flags & F.FDS) names.push('fds');
  if (flags & F.MMC5) names.push('mmc5'); if (flags & F.N163) names.push('n163'); if (flags & F.FME7) names.push('fme7');
  return names;
}

// ── 最小 WebSocket サーバ ───────────────────────────────────────────────
function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
function serve(onClient) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0), upgraded = false, client = null;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString('utf8');
        buf = buf.slice(i + 4);
        const m = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head);
        if (!m) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        const accept = crypto.createHash('sha1').update(m[1] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        upgraded = true;
        client = { send: (text) => { if (!sock.destroyed) sock.write(wsFrame(text)); }, close: () => sock.end() };
        onClient(client);
      }
      // 受信フレーム(ping/close だけ見る。マスク付き)
      while (buf.length >= 2) {
        const op = buf[0] & 0x0F, masked = !!(buf[1] & 0x80);
        let len = buf[1] & 0x7F, o = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
        const total = o + (masked ? 4 : 0) + len;
        if (buf.length < total) return;
        if (op === 0x8) { sock.end(Buffer.from([0x88, 0])); }
        else if (op === 0x9) { const b = Buffer.from(buf.slice(o + (masked ? 4 : 0), total)); if (masked) { const k = buf.slice(o, o + 4); for (let i = 0; i < b.length; i++) b[i] ^= k[i & 3]; } sock.write(Buffer.concat([Buffer.from([0x8A, b.length]), b])); }
        buf = buf.slice(total);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (client && client.onClose) client.onClose(); });
  });
  server.listen(port, '127.0.0.1', () => console.log(`ws://localhost:${port} で待っています(本体の [LIVE] → 接続)`));
  return server;
}

// ── 送出 ─────────────────────────────────────────────────────────────────
const { MML } = load({ strict: true });
const bytes = readBytes(file);
const { frames, chips } = parseNesFrames(MML, bytes);
console.log(`${path.basename(file)}: ${frames.length} frames (${(frames.length / FPS).toFixed(1)}s), chips=[${chips.join(',')}]${loop ? ', loop' : ''}${speed !== 1 ? ', x' + speed : ''}`);

serve((client) => {
  console.log('接続されました');
  // 先頭フレームより前に置かれた書き込み(nsf2vgm の INIT 分)は無いので initw は送らない。録音スクリプトの
  // VGM も同じ(開始時の像は最初のフレームの書き込みに含まれている)
  client.send(JSON.stringify({ t: 'hello', chips, fps: FPS, name: path.basename(file) }));
  const t0 = Date.now();
  let sent = 0, timer = null;
  const tick = () => {
    const target = Math.floor((Date.now() - t0) / 1000 * FPS * speed);
    while (sent <= target) {
      const f = loop ? sent % frames.length : sent;
      if (f >= frames.length) { client.send(JSON.stringify({ t: 'end' })); console.log('曲末。切断します'); client.close(); return; }
      const w = [], r = [];
      for (const [a, v, rd] of frames[f]) { if (rd) r.push(a); else w.push(a, v); }
      const msg = r.length ? { t: 'f', w, r } : { t: 'f', w };
      client.send(JSON.stringify(msg));
      sent++;
    }
    timer = setTimeout(tick, 4);
  };
  client.onClose = () => { if (timer) clearTimeout(timer); timer = null; console.log(`切断されました(${sent} frames)`); };
  tick();
});
