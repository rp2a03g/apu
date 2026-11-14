#!/usr/bin/env node
/*
 * スーパーゲームボーイ(src/emulator/snes/sgbConsole.js)の通し試験。BIOS は同梱しないので各自で渡す。
 *
 *   node tools/headless/sgb-test.js --bios SGB1.sfc [--boot sgb1.boot.rom] --gb rom.gb [--frames 1000] [--png out.png] [--wav out.wav]
 *
 * 見る物:
 *   1. 絵: SNES の画面の中のゲームボーイ部分(48,39 から 160×144)が、中の GbConsole の階調と 1 対 1 に対応しているか
 *   2. 音: 出力のサンプル数が時間どおりか、SNES 側(SPC)とゲームボーイ側の両方が鳴っているか
 *   3. 録音: VGM のヘッダのクロック、GBXX 種類 1(音源の像と APU ポートの書き込み)の数
 *   4. ステート: 保存 → 進める → 読み込み → 同じだけ進める、で画面と音が一致するか
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const biosFile = arg('--bios', null), bootFile = arg('--boot', null), gbFile = arg('--gb', null);
const frames = parseInt(arg('--frames', '1000'), 10), pngOut = arg('--png', null), wavOut = arg('--wav', null);
if (!biosFile || !gbFile) { console.error('usage: node tools/headless/sgb-test.js --bios SGB1.sfc [--boot sgb1.boot.rom] --gb rom.gb [--frames 1000] [--png out.png] [--wav out.wav]'); process.exit(2); }

const { MML } = load({ strict: true });
const SR = 48000;
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'OK  ' : 'NG  ') + msg); if (!ok) fail++; };
const mk = () => { const s = new MML.Emu.SgbConsole(readBytes(gbFile), { bios: readBytes(biosFile), bootRom: bootFile ? readBytes(bootFile) : null }); s.setSampleRate(SR); return s; };
function hash(a) { let h = 2166136261 >>> 0; for (let i = 0; i < a.length; i++) { h ^= a[i] & 0xFFFFFFFF; h = Math.imul(h, 16777619) >>> 0; } return h; }

const sgb = mk();
console.log(MML.Emu.SgbConsole.describe(sgb), `/ GB の時計 ${sgb.clockHz.toFixed(0)}Hz`);
let total = 0, spcPeak = 0, gbPeak = 0, mixPeak = 0; const pcm = [];
const spcTap = sgb.snes.apu.onSample; sgb.snes.apu.onSample = (l, r) => { const a = Math.max(Math.abs(l), Math.abs(r)); if (a > spcPeak) spcPeak = a; spcTap(l, r); };
const t0 = process.hrtime.bigint();
for (let f = 0; f < frames; f++) {
  const GM = sgb.gb.ring.length - 1; for (let i = 0; i < sgb.gb.ringLen; i += 16) { const a = Math.abs(sgb.gb.ring[(sgb.gb.ringHead + i) & GM]); if (a > gbPeak) gbPeak = a; }
  const outL = new Float32Array(sgb.ringLen), outR = new Float32Array(sgb.ringLen);
  sgb.snes.runFrame(); const n = sgb.ringLen; const l = new Float32Array(n), r = new Float32Array(n); sgb.takeAudioInto(l, n, r);
  for (let i = 0; i < n; i++) { const a = Math.max(Math.abs(l[i]), Math.abs(r[i])); if (a > mixPeak) mixPeak = a; }
  total += n; if (wavOut) pcm.push(l, r);
  void outL; void outR;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`${frames} フレーム ${ms.toFixed(0)}ms(${(ms / frames).toFixed(2)} ms/フレーム)`);

// 1. 絵
{
  const fr = sgb.frame, idx = sgb.gb.ppu.frameIdx, maps = [new Map(), new Map(), new Map(), new Map()];
  for (let y = 0; y < 144; y++) for (let x = 0; x < 160; x++) { const c = fr[(y + 39) * 256 + x + 48], m = maps[idx[y * 160 + x]]; m.set(c, (m.get(c) || 0) + 1); }
  let ok = 0; for (const m of maps) { let best = 0; for (const v of m.values()) if (v > best) best = v; ok += best; }
  check(ok >= 23040 * 0.98, `絵: GB の階調と SNES の画面が対応 ${ok}/23040(動いている絵は 1 フレームずれるので 98% 以上で合格)`);
}
// 2. 音
{
  const expect = frames / sgb.frameRate * SR;
  check(Math.abs(total - expect) < SR * 0.02, `音: サンプル数 ${total}(時間どおりなら ${expect.toFixed(0)})`);
  check(spcPeak > 0.01, `音: SNES 側(SPC)が鳴った(ピーク ${spcPeak.toFixed(3)})`);
  check(gbPeak > 0.005, `音: ゲームボーイ側が鳴った(ピーク ${gbPeak.toFixed(3)})`);
  check(mixPeak > 0.01 && mixPeak < 1.5, `音: 混ぜた出力のピーク ${mixPeak.toFixed(3)}`);
}
// 3. 録音
{
  sgb.startRecording();
  for (let f = 0; f < 180; f++) sgb.snes.runFrame();
  const recFrames = sgb.stopRecording();
  const r = MML.VGM.encodeGbRecording({ frames: recFrames, clock: Math.round(sgb.clockHz), name: 'sgb-test' });
  const v = r.vgm, dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  let states = 0, ports = 0;
  for (let p = 0x100; p + 13 < v.length; p++) if (v[p] === 0x67 && v[p + 1] === 0x66 && v[p + 2] === MML.VGM.GBXX.TYPE && v[p + 7] === 0x47 && v[p + 8] === 0x42 && v[p + 9] === 0x58 && v[p + 10] === 0x58 && v[p + 12] === MML.VGM.GBXX.KIND_SGB) {
    if (v[p + 13] === MML.VGM.GBXX.SGB_STATE) states++; else if (v[p + 13] === MML.VGM.GBXX.SGB_PORT) ports++;
    p += 6 + dv.getUint32(p + 3, true);
  }
  check(dv.getUint32(0x80, true) === Math.round(sgb.clockHz), `録音: VGM ヘッダの GB クロック ${dv.getUint32(0x80, true)}`);
  check(states === 1, `録音: SNES 側の音源の像(GBXX 種類 1)${states} 個、APU ポートの書き込み ${ports} 個、GB の書き込み ${r.writes} 個、${(r.samples / 44100).toFixed(2)} 秒`);
  check(Math.abs(r.samples / 44100 - 180 / sgb.frameRate) < 0.1, `録音: 長さが実時間(${(180 / sgb.frameRate).toFixed(2)} 秒)と合う`);
}
// 3b. 再生: 電源投入から録音した VGM(BIOS が音のドライバを送り、起動の音を鳴らすところ)を VGM の再生系に掛け、SNES 側の音を録音時と秒ごとに比べる
{
  const s2 = mk(); const live = []; let e = 0, n = 0;
  const tap = s2.snes.apu.onSample; s2.snes.apu.onSample = (l, r) => { e += Math.abs(l) + Math.abs(r); if (++n === 32000) { live.push(e); e = 0; n = 0; } tap(l, r); };
  s2.startRecording();
  for (let f = 0; f < 600; f++) { s2.snes.runFrame(); s2.ringLen = 0; }
  const r = MML.VGM.encodeGbRecording({ frames: s2.stopRecording(), clock: Math.round(s2.clockHz), name: 'sgb-replay' });
  const h = MML.VGM.parseHeader(r.vgm);
  check(!!h.sgb, `再生: ヘッダの解析が SNES 側の音源の像を見つける(長さ ${(r.samples / 44100).toFixed(2)} 秒、実時間 ${(600 / s2.frameRate).toFixed(2)} 秒)`);
  const play = (mode) => { // mode: 'render' = 普通の再生、'regs' = clock を回さない先読み(キャプチャと同じ経路)
    const p = new MML.Emu.VgmPlayer(r.vgm); const a = p.adapterById.sgbspc; const out = []; let ee = 0, nn = 0;
    if (!a) return null;
    const t2 = a.spc.onSample; a.spc.onSample = (l, rr) => { ee += Math.abs(l) + Math.abs(rr); if (++nn === 32000) { out.push(ee); ee = 0; nn = 0; } t2(l, rr); };
    let mix = 0;
    for (let f = 0; f < 600 && !p.ended; f++) { const o = p.renderFrame(48000, mode === 'regs', true); if (o) for (let i = 0; i < o.left.length; i += 4) mix = Math.max(mix, Math.abs(o.left[i])); }
    return { out, mix, p };
  };
  const cmp = (x) => x && x.out.length >= live.length - 1 && live.slice(0, x.out.length).every((v, i) => Math.abs(v - x.out[i]) <= Math.max(v, x.out[i]) * 0.1 + 1);
  const fmt = (a) => a.map((v) => v.toFixed(0)).join(' ');
  const a1 = play('render');
  check(cmp(a1) && live.some((v) => v > 100), `再生: SNES 側の音の量が秒ごとに録音時と合う(録音 ${fmt(live)} / 再生 ${a1 ? fmt(a1.out) : '無し'})`);
  check(a1 && a1.mix > 0.01, `再生: 混ぜた出力に音がある(ピーク ${a1 ? a1.mix.toFixed(3) : 0})`);
  const a2 = play('regs');
  check(cmp(a2), `再生: clock を回さない先読みの経路でも同じ(${a2 ? fmt(a2.out) : '無し'})`);
  // シーク: 5 秒の位置へ飛んでから 1 秒ぶんの音の量が、通しで再生した時の同じ区間と合う
  if (a1) {
    const p = new MML.Emu.VgmPlayer(r.vgm); for (let f = 0; f < 480; f++) p.renderFrame(48000, false, true); // 一度通って控えを作る
    const a = p.adapterById.sgbspc; let es = 0, ns = 0; const t3 = a.spc.onSample;
    p.seekTo(2 * 44100);
    const b = p.adapterById.sgbspc; const t4 = b.spc.onSample; b.spc.onSample = (l, rr) => { if (ns < 32000) { es += Math.abs(l) + Math.abs(rr); ns++; } t4(l, rr); };
    for (let f = 0; f < 70; f++) p.renderFrame(48000, false, true);
    check(Math.abs(es - a1.out[2]) <= Math.max(es, a1.out[2]) * 0.15 + 1, `再生: 2 秒へシークした後の 1 秒が、通しの再生の同じ区間と合う(${es.toFixed(0)} / ${a1.out[2].toFixed(0)}、控えを使えるか ${p.canCheckpoint})`);
    void t3;
    // シークの控え(チェックポイント): 3 秒の所で状態を控え、1 秒鳴らし、戻してもう 1 秒鳴らすと同じ
    const q = new MML.Emu.VgmPlayer(r.vgm); for (let f = 0; f < 180; f++) q.renderFrame(48000, false, true);
    const qa = q.adapterById.sgbspc; let eq = 0; const t5 = qa.spc.onSample; qa.spc.onSample = (l, rr) => { eq += Math.abs(l) + Math.abs(rr); t5(l, rr); };
    const cp = q._saveCheckpoint(); for (let f = 0; f < 60; f++) q.renderFrame(48000, false, true); const e1 = eq; eq = 0;
    q._restoreCheckpoint(cp); for (let f = 0; f < 60; f++) q.renderFrame(48000, false, true);
    check(e1 > 100 && Math.abs(e1 - eq) < 1e-6, `再生: 状態を控えて戻すと同じ音になる(${e1.toFixed(1)} / ${eq.toFixed(1)})`);
  }
}
// 4. ステート
{
  // 画面は完全一致、音は量が同じか(出力の標本化の位相は保存しないので、サンプル単位の一致は求めない)
  const run = (s, n) => { let h = 0, e = 0; for (let f = 0; f < n; f++) { s.snes.runFrame(); const k = s.ringLen, l = new Float32Array(k), r = new Float32Array(k); s.takeAudioInto(l, k, r); for (let i = 0; i < k; i++) e += Math.abs(l[i]) + Math.abs(r[i]); h = (h * 31 + hash(s.frame)) >>> 0; } return { h, e }; };
  sgb.ringHead = 0; sgb.ringLen = 0; // 録音の試験の間に溜まった音を捨ててから比べる
  const st = MML.Emu.SgbState.save(sgb);
  const a1 = run(sgb, 120);
  const okLoad = MML.Emu.SgbState.load(sgb, st);
  const a2 = run(sgb, 120);
  const near = (x, y) => Math.abs(x - y) <= Math.max(x, y) * 0.02 + 1e-6;
  check(okLoad && a1.h === a2.h, `ステート: 読み込み後の 120 フレームの画面が保存直後と同じ(${a1.h.toString(16)} / ${a2.h.toString(16)})`);
  check(near(a1.e, a2.e), `ステート: 音の量も同じ(${a1.e.toFixed(1)} / ${a2.e.toFixed(1)})`);
  const other = mk(); for (let f = 0; f < 30; f++) other.snes.runFrame();
  const okOther = MML.Emu.SgbState.load(other, st); const a3 = run(other, 120);
  check(okOther && a3.h === a1.h && near(a3.e, a1.e), `ステート: 別に起こした本体へ読み込んでも同じ(${a3.h.toString(16)}、音 ${a3.e.toFixed(1)})`);
}

function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
if (pngOut) {
  const w = 256, h = 224, frame = sgb.frame, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = frame[y * w + x], o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF; raw[o + 3] = 0xFF; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(pngOut, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log('wrote', pngOut);
}
if (wavOut) {
  let n = 0; for (let i = 0; i < pcm.length; i += 2) n += pcm[i].length;
  const b = Buffer.alloc(44 + n * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  let o = 44; for (let i = 0; i < pcm.length; i += 2) for (let k = 0; k < pcm[i].length; k++) { b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i][k] * 32767))), o); b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i + 1][k] * 32767))), o + 2); o += 4; }
  fs.writeFileSync(wavOut, b); console.log('wrote', wavOut);
}
console.log(fail ? `NG ${fail} 件` : '全部 OK');
process.exit(fail ? 1 : 0);
