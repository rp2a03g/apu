#!/usr/bin/env node
/*
 * 自前 NES エミュレータ(src/emulator/nes/)をヘッドレスで回し、画面を PNG に書く。
 *
 * 使い方: node tools/headless/nes-run.js "game.nes" [--frames N] [--png out.png] [--png-every M]
 *                                          [--press "start:120-130,a:300-305,right:400-600"] [--audio out.wav]
 *                                          [--vgm out.vgm] [--rec-from F]
 *   --press  : ボタン名:開始フレーム-終了フレーム をカンマ区切り(a b select start up down left right)
 *   --png-every M : M フレームごとに out_<frame>.png も書く(動きの確認用)
 *   --audio  : 音も計算して WAV(44.1kHz mono 16bit)に書く
 *   --vgm    : 音源レジスタの書き込みを録音して VGM に書く(本体の録音ボタンと同じ経路。--rec-from で開始フレーム)
 * 終わりに実行時間と「画面に何色あるか」を出す(真っ黒のままなら何かが動いていない)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const file = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a) && !/\.(png|wav)$/i.test(a));
if (!file) { console.error('usage: node tools/headless/nes-run.js "game.nes" [--frames N] [--png out.png] [--press "start:120-130"]'); process.exit(2); }
const frames = parseInt(arg('--frames', '300'), 10);
const pngOut = arg('--png', null);
const pngEvery = parseInt(arg('--png-every', '0'), 10);
const audioOut = arg('--audio', null);
const vgmOut = arg('--vgm', null);
const recFrom = parseInt(arg('--rec-from', '0'), 10);

const BTN = { a: 1, b: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 };
const presses = [];
for (const item of (arg('--press', '') || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const m = /^(\w+):(\d+)(?:-(\d+))?$/.exec(item);
  if (!m || !BTN[m[1]]) { console.error('press の書式: name:from-to  例 start:120-130'); process.exit(2); }
  presses.push({ bits: BTN[m[1]], from: +m[2], to: m[3] ? +m[3] : +m[2] });
}
function padAt(f) { let b = 0; for (const p of presses) if (f >= p.from && f <= p.to) b |= p.bits; return b; }

// PNG(RGBA、フィルタ無し)
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, frame, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const p = frame[y * w + x];
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF; raw[o + 3] = 0xFF;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
function writeWav(file, samples, sr) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 20000))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

const { MML } = load({ strict: true });
const bytes = readBytes(file);
const nes = new MML.Emu.NesConsole(bytes);
console.log(`${path.basename(file)}: ${MML.Emu.INES.describe(nes.rom)}, reset=$${nes.cpu.PC.toString(16)}`);
const SR = 44100;
const audio = [];
if (audioOut) nes.setSampleRate(SR);
const t0 = process.hrtime.bigint();
for (let f = 0; f < frames; f++) {
  if (vgmOut && f === recFrom) nes.startRecording();
  nes.setController(0, padAt(f));
  const a = nes.runFrame();
  if (audioOut && a) audio.push(Float32Array.from(a));
  if (pngEvery && pngOut && f > 0 && f % pngEvery === 0) writePng(pngOut.replace(/\.png$/i, '') + '_' + f + '.png', nes.frame, 256, 240);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const colors = new Set(nes.frame).size;
console.log(`${frames} frames in ${ms.toFixed(0)}ms (${(ms / frames).toFixed(2)} ms/frame), 画面の色数 ${colors}, PPU frame ${nes.ppu.frameCount}, CPU cycles ${nes.cpuCycles}, ctrl=$${nes.ppu.ctrl.toString(16)} mask=$${nes.ppu.mask.toString(16)}`);
if (pngOut) { writePng(pngOut, nes.frame, 256, 240); console.log('wrote', pngOut); }
if (vgmOut) {
  const rec = nes.stopRecording();
  const r = MML.VGM.encodeNesRecording({ frames: rec, extBits: nes.extBits(), name: path.basename(file), creator: 'nes-run.js' });
  fs.writeFileSync(vgmOut, r.vgm);
  console.log('wrote', vgmOut, r.vgm.length, 'bytes,', r.frames, 'frames' + (r.dropped ? ', dropped ' + r.dropped : ''));
}
if (audioOut) { const total = audio.reduce((n, a) => n + a.length, 0); const all = new Float32Array(total); let o = 0; for (const a of audio) { all.set(a, o); o += a.length; } writeWav(audioOut, all, SR); console.log('wrote', audioOut, total, 'samples'); }
