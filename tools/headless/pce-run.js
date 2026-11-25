#!/usr/bin/env node
/*
 * 自前 PC エンジンエミュレータ(src/emulator/pce/)をヘッドレスで回す(nes-run.js / msx-run.js / gb-run.js の PCE 版、段階 9c)。
 *
 * 使い方: node tools/headless/pce-run.js "game.pce" [--frames N] [--png out.png] [--png-every M] [--audio out.wav]
 *           [--press "right:120-130,a:300-305"] [--dump N] [--region pce]
 *   --press のボタン名: a(= I) b(= II) select start(= RUN) up down left right
 * 終わりに実行時間、画面の大きさと色数、CPU の位置、VDC の主なレジスタ、音源への書き込み数を出す。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const file = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(pce|sgx|bin)$/i.test(a));
const frames = parseInt(arg('--frames', '300'), 10);
const pngOut = arg('--png', null);
const pngEvery = parseInt(arg('--png-every', '0'), 10);
const audioOut = arg('--audio', null);
const dumpEvery = parseInt(arg('--dump', '0'), 10);

const BTN = { a: 1, b: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 };
const presses = [];
for (const item of (arg('--press', '') || '').split(',').map(x => x.trim()).filter(Boolean)) {
  const m = /^(\w+):(\d+)(?:-(\d+))?$/.exec(item);
  if (!m || !BTN[m[1]]) { console.error('書式: name:from-to  例 right:120-130(a b select start up down left right)'); process.exit(2); }
  presses.push({ name: m[1], from: +m[2], to: m[3] ? +m[3] : +m[2] });
}
function padAt(f) { let b = 0; for (const p of presses) if (f >= p.from && f <= p.to) b |= BTN[p.name]; return b; }

function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function writePng(out, frame, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = frame[y * w + x]; const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF; raw[o + 3] = 0xFF; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
function writeWav(out, L, R, sr) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 20000)));
  for (let i = 0; i < n; i++) { buf.writeInt16LE(q(L[i]), 44 + i * 4); buf.writeInt16LE(q(R[i]), 46 + i * 4); }
  fs.writeFileSync(out, buf);
}

if (require.main === module) {
  if (!file) { console.error('ROM を指定してください(.pce)'); process.exit(2); }
  const { MML } = load({ strict: true });
  const SR = 44100;
  const pce = new MML.Emu.PceConsole(readBytes(file), { region: arg("--region", "auto"), model: arg("--model", /.sgx$/i.test(file) ? "sgx" : "auto"), pad: arg("--pad", "pad2") });
  console.log(`${path.basename(file)}: ${MML.Emu.PceConsole.describe(pce)}`);
  const aL = [], aR = [];
  if (audioOut) pce.setSampleRate(SR);
  let writes = 0;
  pce.onWrite = () => { writes++; };
  const t0 = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) {
    pce.setController(0, padAt(f));
    pce._frameFlag = false;
    let guard = 0;
    while (!pce._frameFlag && ++guard < 400000) pce.cpu.step();
    if (audioOut) { const n = pce.ringLen, l = new Float32Array(n), r = new Float32Array(n); pce.takeAudioInto(l, n, r); aL.push(l); aR.push(r); }
    if (pngEvery && pngOut && f > 0 && f % pngEvery === 0) writePng(pngOut.replace(/\.png$/i, '') + '_' + f + '.png', pce.frame, pce.frameWidth, pce.frameHeight);
    if (dumpEvery && f % dumpEvery === 0) {
      const c = pce.cpu, v = pce.vdc;
      console.log(`f=${f} pc=$${c.PC.toString(16)} mpr=${Array.from(pce.mpr).map(x => x.toString(16)).join(',')} ${pce.cycleSteps === 1 ? '高速' : '低速'} I=${(c.P >> 2) & 1} irq禁止=$${pce.irqDisable.toString(16)} BG=${v.bgOn ? 1 : 0} SPR=${v.sprOn ? 1 : 0} 幅=${(v.lat.hdw + 1) * 8} 行=${v.lat.vdw + 1} ドット÷${pce.vce.divider}`);
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const W = pce.frameWidth, H = pce.frameHeight;
  const colors = new Set(pce.frame).size;
  const v = pce.vdc;
  console.log(`${frames} frames in ${ms.toFixed(0)}ms (${(ms / frames).toFixed(2)} ms/frame), 画面 ${W}x${H} 色数 ${colors}, pc=$${pce.cpu.PC.toString(16)}, 音源への書き込み ${writes}`);
  console.log(`VDC: BG=${v.bgOn ? 1 : 0} SPR=${v.sprOn ? 1 : 0} 表示 ${(v.lat.hdw + 1) * 8}x${v.lat.vdw + 1} 仮想画面 ${v.lat.cols}x${v.lat.rows} スクロール ${v.reg.bxr},${v.reg.byr} 割り込み許可 垂直=${v.enVblank ? 1 : 0} 走査線=${v.enRcr ? 1 : 0}(R06=${v.rcrReg}) ドット÷${pce.vce.divider} ${pce.vce.lines} 行`);
  if (pngOut) { writePng(pngOut, pce.frame, W, H); console.log('wrote', pngOut, W + 'x' + H); }
  if (audioOut) {
    const total = aL.reduce((n, a) => n + a.length, 0), L = new Float32Array(total), R = new Float32Array(total);
    let o = 0; for (let i = 0; i < aL.length; i++) { L.set(aL[i], o); R.set(aR[i], o); o += aL[i].length; }
    writeWav(audioOut, L, R, SR);
    let peak = 0; for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    console.log('wrote', audioOut, total, 'samples, peak', peak.toFixed(3));
  }
}
module.exports = { writePng, writeWav };
