#!/usr/bin/env node
/*
 * 自前ゲームボーイエミュレータ(src/emulator/gb/)をヘッドレスで回す(nes-run.js / msx-run.js の GB 版)。
 *
 * 使い方: node tools/headless/gb-run.js "game.gb" [--frames N] [--png out.png] [--png-every M] [--audio out.wav]
 *           [--press "right:120-130,a:300-305"] [--dump N] [--serial] [--expect-serial STR] [--mooneye] [--model dmg|cgb|auto]
 *         node tools/headless/gb-run.js --selftest        自作テスト ROM(mk-gb-test-rom.js)を全 MBC で通す
 *   --serial         : シリアルへ出た文字を最後に出す(blargg のテスト ROM は結果をここへ書く)
 *   --expect-serial  : シリアル出力に STR が現れたらそこで止めて合格(終了コード 0)。出なければ 1
 *   --mooneye        : mooneye のテスト ROM の合否(LD B,B で止まり B,C,D,E,H,L = 3,5,8,13,21,34 なら合格)
 * 終わりに実行時間、画面の色数、LCDC、APU のレジスタを出す。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (name) => process.argv.includes(name);
const file = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(gb|gbc|sgb|bin)$/i.test(a));
const frames = parseInt(arg('--frames', '300'), 10);
const pngOut = arg('--png', null);
const pngEvery = parseInt(arg('--png-every', '0'), 10);
const audioOut = arg('--audio', null);
const dumpEvery = parseInt(arg('--dump', '0'), 10);
const expectSerial = arg('--expect-serial', null);

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
function writePng(file, frame, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const p = frame[y * w + x]; const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF; raw[o + 3] = 0xFF; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
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
const serialText = (gb) => gb.serialOut.map(c => c >= 0x20 && c < 0x7F || c === 10 ? String.fromCharCode(c) : '.').join('');

const { MML } = load({ strict: true });
const SR = 44100;

// 自作テスト ROM を全 MBC で通す。シリアル出力、画面の色数、音のピーク、録音の書き込み数を見る
if (has('--selftest')) {
  const { buildTestRom, EXPECT_BY_MBC } = require('./mk-gb-test-rom');
  let bad = 0;
  for (const mbc of Object.keys(EXPECT_BY_MBC)) {
    const gb = new MML.Emu.GbConsole(buildTestRom({ mbc }));
    gb.setSampleRate(SR); gb.startRecording();
    let peak = 0, samples = 0;
    for (let f = 0; f < 60; f++) { const a = gb.runFrame(); samples += a.length; for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i])); }
    const rec = gb.stopRecording();
    const writes = rec.reduce((n, fr) => n + fr.length, 0);
    const got = serialText(gb), colors = new Set(gb.frame).size, black = gb.frame[0] === gb.ppu.shades[3];
    const spf = samples / 60;
    const ok = got === EXPECT_BY_MBC[mbc] && colors === 2 && black && peak > 0.01 && writes > 40 && Math.abs(spf - SR / (4194304 / 70224)) < 1 && (mbc === 'rom' || gb.batteryDirty);
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'NG '} ${mbc.padEnd(4)} serial=${JSON.stringify(got)} (期待 ${EXPECT_BY_MBC[mbc]}) 色数=${colors} 左上黒=${black} peak=${peak.toFixed(3)} 録音の書き込み=${writes} サンプル/フレーム=${spf.toFixed(2)} battery=${gb.batteryDirty}`);
  }
  process.exit(bad ? 1 : 0);
}

if (!file) { console.error('ROM を指定してください(.gb/.gbc)。--selftest で自作テスト ROM'); process.exit(2); }
const gb = new MML.Emu.GbConsole(readBytes(file), { model: arg('--model', 'auto') });
console.log(`${path.basename(file)}: ${MML.Emu.GbConsole.describe(gb)} → ${gb.model}`);
const audio = [];
if (audioOut) gb.setSampleRate(SR);
const W = gb.frameWidth, H = gb.frameHeight;
const fib = () => { const c = gb.cpu; return c.b === 3 && c.c === 5 && c.d === 8 && c.e === 13 && c.h === 21 && c.l === 34; };
let verdict = null, ran = 0;
const t0 = process.hrtime.bigint();
for (let f = 0; f < frames; f++) {
  gb.setController(0, padAt(f));
  const a = gb.runFrame(); ran++;
  if (audioOut && a) audio.push(Float32Array.from(a));
  if (pngEvery && pngOut && f > 0 && f % pngEvery === 0) writePng(pngOut.replace(/\.png$/i, '') + '_' + f + '.png', gb.frame, W, H);
  if (dumpEvery && f % dumpEvery === 0) {
    const c = gb.cpu, p = gb.ppu;
    console.log(`f=${f} pc=$${c.pc.toString(16)} sp=$${c.sp.toString(16)} ime=${c.ime ? 1 : 0} halt=${c.halted ? 1 : 0} IE=$${gb.ie.toString(16)} IF=$${gb.if.toString(16)} LCDC=$${p.lcdc.toString(16)} LY=${p.ly} DIV=$${gb.div.toString(16)} TAC=${gb.tac} bank=${gb.cart.hi >> 14}`);
  }
  if (expectSerial && serialText(gb).includes(expectSerial)) { verdict = true; break; }
  // mooneye: 終わると LD B,B($40)の後で同じ所を回り続ける。PC の手前が $40 でレジスタが決まった並びなら合格
  if (has('--mooneye') && f > 2 && (gb._busRead((gb.cpu.pc - 1) & 0xFFFF) === 0x40 || gb._busRead((gb.cpu.pc - 2) & 0xFFFF) === 0x40)) { verdict = fib(); break; }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const colors = new Set(gb.frame).size;
const r = gb.apu.regRaw;
console.log(`${ran} frames in ${ms.toFixed(0)}ms (${(ms / ran).toFixed(2)} ms/frame), 画面の色数 ${colors}, LCDC=$${gb.ppu.lcdc.toString(16)}, CPU T ${gb.cpuCycles}, pc=$${gb.cpu.pc.toString(16)}`);
console.log(`APU: ${Array.from(r).map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
if (has('--serial') || expectSerial) console.log('serial: ' + JSON.stringify(serialText(gb)));
if (pngOut) { writePng(pngOut, gb.frame, W, H); console.log('wrote', pngOut, W + 'x' + H); }
if (audioOut) { const total = audio.reduce((n, a) => n + a.length, 0); const all = new Float32Array(total); let o = 0; for (const a of audio) { all.set(a, o); o += a.length; } writeWav(audioOut, all, SR); let peak = 0; for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i])); console.log('wrote', audioOut, total, 'samples, peak', peak.toFixed(3)); }
if (expectSerial || has('--mooneye')) { console.log(verdict ? 'PASS' : verdict === false ? 'FAIL' : 'FAIL(終わらなかった)'); process.exit(verdict ? 0 : 1); }
