#!/usr/bin/env node
/*
 * 自前 MSX エミュレータ(src/emulator/msx/)をヘッドレスで回し、画面を PNG に、音を WAV に書く(nes-run.js の MSX 版)。
 *
 * 使い方: node tools/headless/msx-run.js "game.rom" [--machine msx1|msx2|msx2plus|turbor] [--mapper plain|konami|konamiScc|ascii8|ascii16]
 *           [--bios-main main.rom] [--bios-sub sub.rom] [--bios-logo logo.rom] [--bios-dir dir]
 *           [--frames N] [--png out.png] [--png-every M] [--audio out.wav]
 *           [--press "right:120-130,a:300-305"] [--key "Space:120-130,Return:200"] [--stub]
 *           [--cart-b fmpac|msxaudio|scci] [--vgm out.vgm]
 *   --cart-b   : カートリッジ 2(音源。fmpac は同梱 C-BIOS の MSX-MUSIC ROM)。--vgm は最初のフレームから録音して VGM に書く(7b)
 *   --disk a.dsk [--disk b.dsk] --disk-rom disk.rom [--fdc wd2793|tc8566af] : ディスク(7d)。ディスク ROM は利用者の物(C-BIOS に無い)
 *   (どれも無ければ同梱 C-BIOS。cbiosData.js を生成済みのとき)
 *   --bios-dir : C-BIOS のディレクトリ(cbios_main_msx2_jp.rom / cbios_sub.rom / cbios_logo_msx2.rom などを機種に合わせて拾う)。
 *                環境変数 MSX_BIOS_DIR でも可
 *   --stub     : tools/headless/mk-msx-test-rom.js のスタブ BIOS を使う(市販 BIOS 不要の通し試験)
 *   --press    : ジョイスティック 1(a b up down left right)。--key は MSX のキー名(msxKeyboard.js の KEYS)
 *   --dump N   : N フレームごとに VDP レジスタ/PSG レジスタ/PC を出す
 * 終わりに実行時間、画面の色数、VDP のモード、PSG のレジスタを出す(真っ黒・無音なら何かが動いていない)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (name) => process.argv.includes(name);
const file = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(rom|mx1|mx2|bin)$/i.test(a) && !/stub-bios|cbios/i.test(a));
const frames = parseInt(arg('--frames', '300'), 10);
const pngOut = arg('--png', null);
const pngEvery = parseInt(arg('--png-every', '0'), 10);
const audioOut = arg('--audio', null);
const machine = arg('--machine', 'msx2');
const mapper = arg('--mapper', null);
const dumpEvery = parseInt(arg('--dump', '0'), 10);
const cartBKind = arg('--cart-b', null);
const diskFiles = process.argv.map((a, i) => a === '--disk' ? process.argv[i + 1] : null).filter(Boolean);
const fdcKind = arg('--fdc', 'wd2793');
const diskRom = arg('--disk-rom', null);
const vgmOut = arg('--vgm', null);

const BTN = { a: 1, b: 2, up: 16, down: 32, left: 64, right: 128 };
function parseRanges(s, check) {
  const out = [];
  for (const item of (s || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = /^(\w+):(\d+)(?:-(\d+))?$/.exec(item);
    if (!m || !check(m[1])) { console.error('書式: name:from-to  例 right:120-130'); process.exit(2); }
    out.push({ name: m[1], from: +m[2], to: m[3] ? +m[3] : +m[2] });
  }
  return out;
}
const presses = parseRanges(arg('--press', ''), (n) => !!BTN[n]);
function padAt(f) { let b = 0; for (const p of presses) if (f >= p.from && f <= p.to) b |= BTN[p.name]; return b; }

// PNG(RGBA、フィルタ無し)
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

// BIOS を集める
function pickBios() {
  const bios = {};
  if (has('--stub')) { bios.main = require('./mk-msx-test-rom').buildBios({ ramSec: machine === 'turbor' ? 0 : 2 }); bios.name = 'stub'; return bios; }
  const dir = arg('--bios-dir', process.env.MSX_BIOS_DIR || null);
  const main = arg('--bios-main', null), sub = arg('--bios-sub', null), logo = arg('--bios-logo', null);
  if (main) bios.main = readBytes(main);
  if (sub) bios.sub = readBytes(sub);
  if (logo) bios.logo = readBytes(logo);
  if (dir && !bios.main) {
    const pick = (names) => { for (const n of names) { const p = path.join(dir, n); if (fs.existsSync(p)) return readBytes(p); } return null; };
    const m = machine;
    bios.main = pick(m === 'msx1' ? ['cbios_main_msx1_jp.rom', 'cbios_main_msx1.rom'] : m === 'msx2' ? ['cbios_main_msx2_jp.rom', 'cbios_main_msx2.rom'] : ['cbios_main_msx2+_jp.rom', 'cbios_main_msx2+.rom']);
    bios.sub = m === 'msx1' ? null : pick(['cbios_sub.rom']);
    bios.logo = pick(m === 'msx1' ? ['cbios_logo_msx1.rom'] : m === 'msx2' ? ['cbios_logo_msx2.rom'] : ['cbios_logo_msx2+.rom']);
    bios.name = 'C-BIOS';
  }
  if (!bios.main) {
    // 指定が無ければ同梱 C-BIOS(src/emulator/msx/cbiosData.js。本体が機種に合わせて選ぶ)。それも無ければ諦める
    if (MML.Emu.MsxConsole.hasDefaultBios(machine)) { if (diskRom) { const b = MML.Emu.MsxConsole.defaultBios(machine); b.disk = readBytes(diskRom); return b; } return undefined; }
    console.error('BIOS がありません: --stub か --bios-main/--bios-dir(MSX_BIOS_DIR)を指定するか、cbiosData.js を生成してください(mk-cbios-data.js)'); process.exit(2);
  }
  if (diskRom) bios.disk = readBytes(diskRom);
  bios.name = bios.name || path.basename(main || '');
  return bios;
}

const { MML } = load({ strict: true });
const keys = parseRanges(arg('--key', ''), (n) => !!MML.Emu.MsxKeyboard.KEYS[n]);
const bytes = file ? readBytes(file) : null;
const cartB = cartBKind ? (cartBKind === 'fmpac' ? { kind: 'fmpac', rom: MML.Emu.MsxConsole.defaultMusicRom() } : { kind: cartBKind }) : null;
const msx = new MML.Emu.MsxConsole(bytes, { machine, mapperType: mapper, bios: pickBios(), cartB, disks: diskFiles.map(readBytes), fdc: fdcKind }); // bios undefined = 同梱 C-BIOS
if (vgmOut) msx.startRecording();
console.log(`${file ? path.basename(file) : '(no cart)'}: ${MML.Emu.MsxConsole.describe(msx)}`);
const SR = 44100;
const audio = [];
if (audioOut) msx.setSampleRate(SR);
const H = msx.frameHeight; // 幅はフレームごと(MSX2 の 512 ドットモード)に msx.frameWidth を見る
const t0 = process.hrtime.bigint();
const keyState = new Map();
for (let f = 0; f < frames; f++) {
  msx.setController(0, padAt(f));
  for (const k of keys) { const down = f >= k.from && f <= k.to; if (keyState.get(k.name) !== down) { keyState.set(k.name, down); msx.setMsxKey(k.name, down); } }
  const a = msx.runFrame();
  if (audioOut && a) audio.push(Float32Array.from(a));
  if (pngEvery && pngOut && f > 0 && f % pngEvery === 0) writePng(pngOut.replace(/\.png$/i, '') + '_' + f + '.png', msx.frame, msx.frameWidth, H);
  if (dumpEvery && f % dumpEvery === 0) {
    const v = msx.vdp, r = Array.from(v.regs.subarray(0, 8)).map(x => x.toString(16).padStart(2, '0')).join(' ');
    console.log(`f=${f} pc=$${msx.cpu.pc.toString(16)} sp=$${msx.cpu.sp.toString(16)} iff1=${msx.cpu.iff1 ? 1 : 0} mode=${v.mode} vdp[${r}] S0=$${v.status[0].toString(16)} psg[${Array.from(msx.psg.regs.subarray(0, 14)).map(x => x.toString(16)).join(' ')}] A8=$${msx.ppiA.toString(16)} ssl3=$${msx.ssl[3].toString(16)}`);
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const colors = new Set(msx.frame.subarray(0, msx.frameWidth * H)).size;
const v = msx.vdp;
console.log(`${frames} frames in ${ms.toFixed(0)}ms (${(ms / frames).toFixed(2)} ms/frame), 画面の色数 ${colors}, VDP mode ${v.mode}${v.unsupportedMode ? '(未対応モードあり)' : ''} ${v.displayLines}行 ${v.linesPerFrame === 313 ? '50Hz' : '60Hz'}, frames ${msx.frameCount}, CPU cycles ${msx.cpuCycles}, pc=$${msx.cpu.pc.toString(16)}`);
console.log(`PSG: ${Array.from(msx.psg.regs.subarray(0, 14)).map(x => x.toString(16)).join(' ')}  A8=$${msx.ppiA.toString(16)} ssl=[${Array.from(msx.ssl).join(',')}] mapper=[${Array.from(msx.ramDev.sel).join(',')}]`);
if (pngOut) { writePng(pngOut, msx.frame, msx.frameWidth, H); console.log('wrote', pngOut, msx.frameWidth + 'x' + H); }
if (vgmOut) {
  const recFrames = msx.stopRecording();
  const counts = {};
  for (const fr of recFrames) for (const w of fr) counts[w.chip] = (counts[w.chip] || 0) + 1;
  const r = MML.VGM.encodeMsxRecording({ frames: recFrames, chips: msx.chips(), machine: msx.machine, name: file ? path.basename(file) : 'MSX', creator: 'msx-run.js' });
  fs.writeFileSync(vgmOut, r.vgm);
  console.log('wrote', vgmOut, r.vgm.length, 'bytes,', r.frames, 'frames,', r.rate + 'Hz, chips', r.chips.join('+'), r.sccPlus ? '(SCC+)' : '', 'dropped', r.dropped, 'writes', JSON.stringify(counts));
}
if (audioOut) { const total = audio.reduce((n, a) => n + a.length, 0); const all = new Float32Array(total); let o = 0; for (const a of audio) { all.set(a, o); o += a.length; } writeWav(audioOut, all, SR); let peak = 0; for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i])); console.log('wrote', audioOut, total, 'samples, peak', peak.toFixed(3)); }
