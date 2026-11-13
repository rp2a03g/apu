#!/usr/bin/env node
/*
 * SNES 本体の骨格(src/emulator/snes/、スーパーゲームボーイの土台)をヘッドレスで回し、画面を PNG に書く。
 *
 *   node tools/headless/snes-run.js "rom.sfc" [--frames N] [--png out.png] [--png-every M] [--press "a:120-130,start:300"] [--dump N] [--text] [--gb rom.gb [--gb-boot sgb.boot.rom]]
 *   --press : b y select start up down left right a x l r
 * 終わりに実行時間、画面の色数、CPU/PPU/APU の状態を出す。公開テスト ROM は結果を画面に出すので PNG を見る。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const file = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(sfc|smc|bin)$/i.test(a));
const frames = parseInt(arg('--frames', '300'), 10);
const pngOut = arg('--png', null), pngEvery = parseInt(arg('--png-every', '0'), 10), dumpEvery = parseInt(arg('--dump', '0'), 10);
if (!file) { console.error('usage: node tools/headless/snes-run.js "rom.sfc" [--frames N] [--png out.png]'); process.exit(2); }

function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function writePng(f, frame, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = frame[y * w + x]; const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF; raw[o + 3] = 0xFF; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const { MML } = load({ strict: true });
const B = MML.Emu.SnesConsole.BUTTON;
const NAMES = { b: B.B, y: B.Y, select: B.SELECT, start: B.START, up: B.UP, down: B.DOWN, left: B.LEFT, right: B.RIGHT, a: B.A, x: B.X, l: B.L, r: B.R };
const presses = [];
for (const item of (arg('--press', '') || '').split(',').map(x => x.trim()).filter(Boolean)) {
  const m = /^(\w+):(\d+)(?:-(\d+))?$/.exec(item);
  if (!m || !NAMES[m[1]]) { console.error('書式: name:from-to'); process.exit(2); }
  presses.push({ bit: NAMES[m[1]], from: +m[2], to: m[3] ? +m[3] : +m[2] });
}
// スーパーゲームボーイ: --gb にゲームボーイの ROM、--gb-boot にブート ROM(任意)
const gbFile = arg('--gb', null), gbBoot = arg('--gb-boot', null);
const icd = gbFile ? new MML.Emu.SgbIcd2(readBytes(gbFile), { bootRom: gbBoot ? readBytes(gbBoot) : null }) : null;
const snes = new MML.Emu.SnesConsole(readBytes(file), { ext: icd });
console.log(`${path.basename(file)}: "${snes.cart.title}" ${snes.cart.hirom ? 'HiROM' : 'LoROM'} ${snes.rom.length >> 10}K SRAM ${snes.sram.length}`);
const t0 = process.hrtime.bigint();
for (let f = 0; f < frames; f++) {
  let bits = 0; for (const p of presses) if (f >= p.from && f <= p.to) bits |= p.bit;
  snes.setController(0, bits);
  snes.runFrame();
  if (pngEvery && pngOut && f > 0 && f % pngEvery === 0) writePng(pngOut.replace(/\.png$/i, '') + '_' + f + '.png', snes.frame, 256, 224);
  if (dumpEvery && f % dumpEvery === 0) { const c = snes.cpu, p = snes.ppu; console.log(`f=${f} pc=$${c.pbr.toString(16)}:${c.pc.toString(16)} p=$${c.p.toString(16)} e=${c.e} mode=${p.bgMode} tm=$${p.tm.toString(16)} blank=${p.forceBlank ? 1 : 0} br=${p.brightness} nmi=${snes.nmiEnable ? 1 : 0} spc pc=$${snes.apu.cpu.PC.toString(16)} ports in=[${Array.from(snes.apu.in).map(x => x.toString(16))}] out=[${Array.from(snes.apu.out).map(x => x.toString(16))}]` + (icd ? ` gb pc=$${icd.gb.cpu.pc.toString(16)} ly=${icd.gb.ppu.line} lcdc=$${icd.gb.ppu.lcdc.toString(16)} run=${icd.running ? 1 : 0} q=${icd.queue.length}` : '')); }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const c = snes.cpu, p = snes.ppu;
console.log(`${frames} frames in ${ms.toFixed(0)}ms (${(ms / frames).toFixed(2)} ms/frame), 画面の色数 ${new Set(snes.frame).size}, pc=$${c.pbr.toString(16)}:${c.pc.toString(16)} e=${c.e} waiting=${c.waiting} stopped=${c.stopped}`);
console.log(`PPU: mode ${p.bgMode} TM=$${p.tm.toString(16)} forceBlank=${p.forceBlank} brightness=${p.brightness} | APU: SPC pc=$${snes.apu.cpu.PC.toString(16)} romEnable=${snes.apu.romEnable}`);
if (process.argv.includes('--text')) { // BG1 のタイル番号を文字として読む(テスト ROM の結果表示用)
  for (let r = 0; r < 28; r++) { let line = ''; for (let x = 0; x < 32; x++) { const t = p.vram[(p.bgMap[0] + r * 32 + x) & 0x7FFF] & 0xFF; line += t >= 0x20 && t < 0x7F ? String.fromCharCode(t) : ' '; } if (line.trim()) console.log('| ' + line.trimEnd()); }
}
if (pngOut) { writePng(pngOut, snes.frame, 256, 224); console.log('wrote', pngOut); }
