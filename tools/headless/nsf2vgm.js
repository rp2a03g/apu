/*
 * NSF → VGM(NES APU) 書き出し
 *
 *   node tools/headless/nsf2vgm.js "song.nsf" --song 0 --sec 30 -o out.vgm [--precise]
 *
 * Mesen 用の録音スクリプト(tools/mesen/nes-apu-vgm-recorder.lua)と同じ符号化で VGM を作る。
 * 目的は 2 つ:
 *   1. その符号化(735 サンプル=1 フレーム固定、DPCM はデータブロック 0xC2、FDS は bit31)で作った
 *      VGM が、本ツールの VGM 経路(vgmPlayer → vgm2mml → nsf2mml)で NSF 直接変換と同じ結果に
 *      なるかの A/B(tools/headless/convert.js で両方を変換して比べる)。
 *   2. NSF を VGM にして他の VGM プレイヤーで聴く/配る。
 *
 * 2A03 と FDS 以外の拡張音源(VRC6/VRC7/N163/MMC5/FME-7)は VGM の NES APU に載らないので落とす
 * (件数を最後に表示)。--precise で各書き込みのフレーム内時刻(player.frameFrac)を wait に反映する
 * ($4011 直書き PCM の再生用。無指定なら全書き込みをフレーム頭に置く)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ctx } = require('./convert');

const SAMPLES_PER_FRAME = 735;
const NES_APU_CLOCK = 1789772;
const HEADER_SIZE = 0x100;

// CPU アドレス → VGM の NES APU レジスタ番号(0xB4 aa dd の aa)。対象外なら -1
function mapAddr(a) {
  if (a >= 0x4000 && a <= 0x401F) return (a === 0x4014 || a === 0x4016) ? -1 : a - 0x4000;
  if (a === 0x4023) return 0x3F;
  if (a >= 0x4040 && a <= 0x407F) return 0x40 + (a - 0x4040);
  if (a >= 0x4080 && a <= 0x409E) return 0x20 + (a - 0x4080);
  return -1;
}

function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
function u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF]; }
function utf16(s) {
  const out = [];
  for (const ch of s) { const c = ch.codePointAt(0); out.push(c < 0x80 ? c : 0x3F, 0); }
  out.push(0, 0);
  return out;
}

/**
 * @param {Uint8Array} nsfBytes
 * @param {object} opt {song, seconds, precise}
 * @returns {{vgm: Uint8Array, frames: number, dropped: number, fds: boolean}}
 */
function nsfToVgm(nsfBytes, opt = {}) {
  const MML = ctx();
  const song = opt.song || 0;
  const seconds = opt.seconds || 30;
  const precise = !!opt.precise;
  const sampleRate = 44100;
  const header = MML.NSF.parseHeader(nsfBytes);
  const totalFrames = Math.ceil(seconds * MML.Emu.FRAME_RATE_NTSC);

  const body = [];       // ヘッダ以降のコマンド列
  let emitted = 0;       // wait として書き出した合計サンプル
  let frameSample = 0;   // 現在フレーム頭の仮想時刻
  let dropped = 0;
  let fds = false;
  const dpcmCache = new Map();
  const shadow = {};

  const flushWait = (t) => {
    let d = t - emitted;
    while (d > 0) {
      if (d === SAMPLES_PER_FRAME) { body.push(0x62); d = 0; }
      else if (d > 0xFFFF) { body.push(0x61, ...u16(0xFFFF)); d -= 0xFFFF; }
      else { body.push(0x61, ...u16(d)); d = 0; }
    }
    if (t > emitted) emitted = t;
  };

  const player = new MML.Emu.NsfPlayer(nsfBytes);
  const emitDpcm = (t) => {
    const addr = 0xC000 + (shadow[0x4012] || 0) * 64;
    const len = (shadow[0x4013] || 0) * 16 + 1;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      let a = addr + i;
      if (a > 0xFFFF) a = 0x8000 + (a - 0x10000);
      data[i] = player.bus.read(a) & 0xFF;
    }
    const key = addr + ':' + len;
    const prev = dpcmCache.get(key);
    if (prev && prev.length === data.length && prev.every((b, i) => b === data[i])) return;
    dpcmCache.set(key, data);
    flushWait(t);
    body.push(0x67, 0x66, 0xC2, ...u32(len + 2), ...u16(addr), ...data);
  };
  const onWrite = (a, v) => {
    shadow[a] = v;
    const aa = mapAddr(a);
    if (aa < 0) { if (a >= 0x4000 && a <= 0xFFFF && a !== 0x4014 && a !== 0x4016) dropped++; return; }
    if (a === 0x4023 || (a >= 0x4040 && a <= 0x409E)) fds = true;
    const t = frameSample + (precise ? Math.min(SAMPLES_PER_FRAME - 1, Math.floor((player.frameFrac || 0) * SAMPLES_PER_FRAME)) : 0);
    if (a === 0x4015 && (v & 0x10)) emitDpcm(t);
    flushWait(t);
    body.push(0xB4, aa, v & 0xFF);
  };

  // capture.js _setupCapture と同じ: initSong() が直接書く $4017/$4015 を先に出す
  onWrite(0x4017, 0x40); onWrite(0x4015, 0x0F);
  player.bus.onWrite = onWrite;
  player.initSong(song, false);
  for (let f = 0; f < totalFrames; f++) {
    player.renderFrame(sampleRate);
    frameSample = (f + 1) * SAMPLES_PER_FRAME;
  }
  flushWait(frameSample);
  body.push(0x66);

  // GD3
  const name = (header.songName || path.basename(opt.name || 'nsf')).trim();
  // GD3: track=曲名、game は空(NSF にゲーム名欄は無い。本ツールの曲名表示は "game - track")
  const fields = [].concat(utf16(name), utf16(''), utf16(''), utf16(''), utf16('Nintendo Famicom / NES'), utf16(''),
    utf16(header.artist || ''), utf16(''), utf16(''), utf16('nsf2vgm.js'), utf16(''));
  const gd3 = [].concat([0x47, 0x64, 0x33, 0x20], u32(0x100), u32(fields.length), fields);

  const hdr = new Uint8Array(HEADER_SIZE);
  hdr.set([0x56, 0x67, 0x6D, 0x20], 0);
  const total = HEADER_SIZE + body.length + gd3.length;
  hdr.set(u32(total - 4), 0x04);
  hdr.set(u32(0x00000161), 0x08);
  hdr.set(u32(HEADER_SIZE + body.length - 0x14), 0x14);
  hdr.set(u32(frameSample), 0x18);
  hdr.set(u32(60), 0x24);
  hdr.set(u32(HEADER_SIZE - 0x34), 0x34);
  hdr.set(u32((NES_APU_CLOCK | (fds ? 0x80000000 : 0)) >>> 0), 0x84);

  const vgm = new Uint8Array(total);
  vgm.set(hdr, 0); vgm.set(body, HEADER_SIZE); vgm.set(gd3, HEADER_SIZE + body.length);
  return { vgm, frames: totalFrames, dropped, fds };
}

module.exports = { nsfToVgm };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find(a => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '-o' && !['--song', '--sec'].includes(argv[argv.indexOf(a) - 1]));
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (!file) { console.error('usage: nsf2vgm.js song.nsf [--song n] [--sec s] [-o out.vgm] [--precise]'); process.exit(2); }
  const bytes = new Uint8Array(fs.readFileSync(file));
  const r = nsfToVgm(bytes, { song: parseInt(get('--song', '0'), 10), seconds: parseFloat(get('--sec', '30')), precise: argv.includes('--precise'), name: path.basename(file) });
  const out = get('-o', file.replace(/\.[^.]+$/, '') + '.vgm');
  fs.writeFileSync(out, r.vgm);
  console.log(`${out}: ${r.vgm.length} bytes, ${r.frames} frames${r.fds ? ', FDS' : ''}${r.dropped ? `, 拡張音源の書き込み ${r.dropped} 件は落とした` : ''}`);
}
