/*
 * NSF → VGM(NES APU) 書き出し
 *
 *   node tools/headless/nsf2vgm.js "song.nsf" --song 0 --sec 30 -o out.vgm [--precise]
 *
 * Mesen 用の録音スクリプト(tools/mesen/vgm-recorder.lua)と同じ符号化で VGM を作る
 * (符号化の本体は src/vgm/vgmRecord.js の MML.VGM.encodeNesRecording。自前 NES エミュレータの録音とも共通)。
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
  const extBits = (header.extraChips || 0) & ~MML.NSF.CHIP_FLAGS.FDS;

  const player = new MML.Emu.NsfPlayer(nsfBytes);
  const frames = [];
  let cur = [];
  const shadow = {};
  const curT = () => precise ? Math.min(SAMPLES_PER_FRAME - 1, Math.floor((player.frameFrac || 0) * SAMPLES_PER_FRAME)) : 0;
  // DPCM: $4015 bit4 を立てる直前に $4012/$4013 が指すサンプル本体を CPU 空間から写す(符号化側が同じ内容は 1 回にする)
  const dmcBlock = () => {
    const addr = 0xC000 + (shadow[0x4012] || 0) * 64;
    const len = (shadow[0x4013] || 0) * 16 + 1;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      let a = addr + i;
      if (a > 0xFFFF) a = 0x8000 + (a - 0x10000);
      data[i] = player.bus.read(a) & 0xFF;
    }
    return { addr, data };
  };
  const onWrite = (a, v) => {
    shadow[a] = v;
    const t = curT();
    if (a === 0x4015 && (v & 0x10)) cur.push({ dmc: dmcBlock() });
    cur.push({ addr: a, value: v, t });
  };
  // N163 $4800 の読み出し(ポインタが進む副作用)も記録する。NsfBus は副作用つきポートだけ onRead を呼ぶ
  const onRead = (a) => { cur.push({ addr: a, value: 0, read: true, t: curT() }); };

  // capture.js _setupCapture と同じ: initSong() が直接書く $4017/$4015 を先に出す
  onWrite(0x4017, 0x40); onWrite(0x4015, 0x0F);
  player.bus.onWrite = onWrite;
  player.bus.onRead = onRead;
  player.initSong(song, false);
  for (let f = 0; f < totalFrames; f++) {
    player.renderFrame(sampleRate);
    frames.push(cur); cur = [];
  }
  const name = (header.songName || path.basename(opt.name || 'nsf')).trim();
  // GD3: track=曲名、game は空(NSF にゲーム名欄は無い。本ツールの曲名表示は "game - track")
  const r = MML.VGM.encodeNesRecording({ frames, extBits, name, artist: header.artist || '', creator: 'nsf2vgm.js' });
  return { vgm: r.vgm, frames: totalFrames, dropped: r.dropped, fds: r.fds };
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
