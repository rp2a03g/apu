/*
 * 実際に鳴らした音を「数値で」点検する (NSF/SPC/KSS/GBS/HES/VGM)
 *
 *   node tools/headless/audio-check.js "song.nsf" --song 0 --sec 15
 *   node tools/headless/audio-check.js "song.hes" --sec 20 --wav out.wav
 *
 * 耳で聴かずに判定できる不具合を機械的に拾うためのもの。過去に踏んだ地雷が対象:
 *   クリップ      … 複数音源同時発音でgainが過大 → |s|が1.0に張り付く
 *   DCオフセット  … DDA(PCM)のon/off頻発でDC遮断フィルタがオーバーシュート
 *   オクターブずれ… 基音のFFTピークが期待の2倍/半分になる
 *   無音          … バンク切替やINIT失敗で一切発音しない
 *   プチノイズ    … 波形の不連続(隣接サンプル差の突出)
 *
 * ※ 音色の良し悪し・曲としての正しさは判定できない(それは人が聴くしかない)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { load, readBytes } = require('./load');
const { detectFormat, expandInput, probe, defaultSong } = require('./convert');

const SR = 48000;

/*
 * ★ここは実再生と条件を揃えること。
 * NSF の captureSong は内部で Emu.dcBlock を通すが、KSS/GBS/HES/VGM の
 * captureXxxSongAsync は生の値を返す。一方ブラウザ再生では *-stream-player.js が
 * 同じ係数(R=0.999)のDC遮断IIRを通している。揃えないと GBS の DC +0.22 のような
 * 「実再生には存在しない異常」を測ってしまう(実際に一度誤検出した)。
 * SPC だけは spc-stream-player.js もDC遮断を持たないので、素通しが実再生と同じ。
 */
async function renderAudio(bytes, format, opt) {
  const MML = globalThis.MML;
  const { song = 0, seconds = 15 } = opt;
  const o = { songIndex: song, durationSeconds: seconds, sampleRate: SR, mute: {} };
  const dc = MML.Emu.dcBlock;

  if (format === 'nsf') return { audio: MML.Emu.captureSong(bytes, o).audio, sampleRate: SR };
  if (format === 'kss') return { audio: dc((await MML.Emu.captureKssSongAsync(bytes, o)).audio), sampleRate: SR };
  if (format === 'gbs') return { audio: dc((await MML.Emu.captureGbsSongAsync(bytes, o)).audio), sampleRate: SR };
  if (format === 'hes') {
    // captureHesSongAsync が読むキーは track。songIndex を渡しても黙って無視され
    // header.firstTrack にフォールバックするので、変換側と別トラックを鳴らしてしまう
    return { audio: dc((await MML.Emu.captureHesSongAsync(bytes, Object.assign({ track: song }, o))).audio), sampleRate: SR };
  }
  if (format === 'vgm') {
    // captureVgmSongAsync はレジスタ採取専用で音声を返さないため、
    // VgmPlayer を直接回して1フレームずつPCMを集める(実再生と同じ renderFrame)。
    const raw = await MML.Archive.gunzipIfNeeded(bytes);
    const p = new MML.Emu.VgmPlayer(raw);
    const want = Math.floor(seconds * SR);
    const audio = new Float32Array(want);
    let pos = 0;
    while (pos < want) {
      const buf = p.renderFrame(SR);
      if (!buf || !buf.length) break;
      for (let i = 0; i < buf.length && pos < want; i++) audio[pos++] = buf[i];
    }
    return { audio: dc(audio.subarray(0, pos)), sampleRate: SR };
  }
  if (format === 'spc') {
    const p = new MML.Emu.SpcPlayer(bytes);
    return { audio: p.renderSeconds(seconds, SR), sampleRate: SR };
  }
  throw new Error(`未対応: ${format}`);
}

// ------------------------------------------------------------------ 解析

function basicStats(a) {
  let peak = 0, sum = 0, sumSq = 0, clip = 0, run = 0, maxRun = 0;
  let maxJump = 0, maxJumpAt = 0;
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
    sum += s; sumSq += s * s;
    // 1.0 に張り付いた区間の「長さ」が耳に付く歪みになる。単発は無視してよい
    if (abs >= 0.999) { clip++; if (++run > maxRun) maxRun = run; } else run = 0;
    if (i > 0) {
      const d = Math.abs(s - a[i - 1]);
      if (d > maxJump) { maxJump = d; maxJumpAt = i; }
    }
  }
  const n = a.length || 1;
  return {
    peak, rms: Math.sqrt(sumSq / n), dc: sum / n,
    clipCount: clip, clipRatio: clip / n, maxClipRun: maxRun,
    maxJump, maxJumpAt,
  };
}

/** 100ms窓ごとのRMSを見て、無音区間の割合と冒頭の無音長を出す */
function silenceStats(a, sr) {
  const win = Math.floor(sr * 0.1);
  const th = Math.pow(10, -60 / 20); // -60dBFS
  let silent = 0, total = 0, lead = -1;
  for (let p = 0; p + win <= a.length; p += win, total++) {
    let sq = 0;
    for (let i = p; i < p + win; i++) sq += a[i] * a[i];
    const isSilent = Math.sqrt(sq / win) < th;
    if (isSilent) silent++;
    else if (lead < 0) lead = total;
  }
  return {
    silentRatio: total ? silent / total : 1,
    leadingSilenceSec: lead < 0 ? Infinity : lead * 0.1,
    allSilent: silent === total,
  };
}

/** 反復radix-2 FFT(実数入力)。周波数ピーク検出にしか使わないので実装は最小限 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** 中央付近の1窓をHann窓でFFTし、強いピークを上位n個返す(オクターブずれの検出用) */
function spectralPeaks(a, sr, count = 3) {
  const N = 32768;
  if (a.length < N) return [];
  const start = Math.max(0, Math.floor((a.length - N) / 2));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    re[i] = a[start + i] * w;
  }
  fft(re, im);
  const half = N / 2;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);

  const peaks = [];
  for (let i = 2; i < half - 1; i++) {
    if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) peaks.push({ bin: i, mag: mag[i] });
  }
  peaks.sort((x, y) => y.mag - x.mag);
  const maxMag = peaks.length ? peaks[0].mag : 1;
  return peaks.slice(0, count).map((p) => ({
    hz: +(p.bin * sr / N).toFixed(1),
    note: hzToNote(p.bin * sr / N),
    rel: +(p.mag / maxMag).toFixed(3),
  }));
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function hzToNote(hz) {
  if (!(hz > 0)) return '-';
  const midi = 69 + 12 * Math.log2(hz / 440);
  const r = Math.round(midi);
  const cents = Math.round((midi - r) * 100);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}${cents >= 0 ? '+' : ''}${cents}`;
}

function writeWav(file, a, sr) {
  const n = a.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const db = (v) => (v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dBFS` : '-inf');

/**
 * 数値から「これは疑わしい」を機械的に指摘する。
 * ★測定点は「DC遮断の後・リミッタとマスター音量の前」。実再生は各 *-stream-player.js が
 *   DynamicsCompressor(threshold -3dB / ratio 20)を通すので、0dBFS超過は即歪みではなく
 *   「リミッタが介入して音量が押さえ込まれる」を意味する。断定を避けた文言にしてある。
 */
function verdicts(st, sil) {
  const out = [];
  if (sil.allSilent) out.push('❌ 全区間が無音(-60dBFS未満)。INIT失敗やバンク切替の疑い');
  else if (sil.silentRatio > 0.5) out.push(`⚠ 無音区間が ${(sil.silentRatio * 100).toFixed(0)}% ある`);
  if (sil.leadingSilenceSec > 2 && Number.isFinite(sil.leadingSilenceSec)) out.push(`⚠ 冒頭 ${sil.leadingSilenceSec.toFixed(1)} 秒が無音`);
  if (st.peak > 1.0) out.push(`⚠ リミッタ前ピークが ${st.peak.toFixed(3)}(0dBFS超過)。実再生ではリミッタが介入する`);
  if (st.maxClipRun >= 4) out.push(`❌ 1.0への張り付きが連続 ${st.maxClipRun} サンプル。gainが過大`);
  else if (st.clipRatio > 0.0001) out.push(`⚠ 1.0到達 ${(st.clipRatio * 100).toFixed(3)}%`);
  if (Math.abs(st.dc) > 0.02) out.push(`⚠ DCオフセット ${st.dc.toFixed(4)}(DC遮断が効いていない疑い)`);
  if (st.maxJump > 0.5) out.push(`⚠ 波形の不連続 ${st.maxJump.toFixed(3)}(プチノイズの疑い)`);
  if (st.peak < 0.05 && !sil.allSilent) out.push(`⚠ ピークが ${db(st.peak)} と極端に小さい`);
  return out.length ? out : ['✅ 機械判定では異常なし'];
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('-'));
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  if (!file) {
    console.error('usage: node tools/headless/audio-check.js <file> [--song N] [--entry N] [--sec S] [--wav out.wav]');
    process.exit(2);
  }
  load({ strict: true });

  const items = await expandInput(file);
  const item = items[parseInt(flag('--entry', '0'), 10)];
  const rawBytes = item.read ? await item.read() : item.bytes;
  const seconds = parseInt(flag('--sec', '15'), 10);
  // probe() は NSFe を素のNSFバイト列へ正規化し(VGMはgunzip)、ヘッダも返す。描画には
  // 必ずこの正規化後のバイト列を渡す。生の NSFe を captureSong に渡すと INIT が
  // "NSFE" マジックを命令として実行してしまい、エラーにならず全区間無音になる
  // (ファミコンポの .nsfe 全部で踏んだ。convert.js は最初から probe 経由だった)
  const { bytes, header } = await probe(rawBytes, item.format);
  // 曲番号の既定は convert.js と共通(ヘッダ宣言値)。ここを0固定にすると
  // 変換で見ている曲と別の曲を測ってしまい、数値の突き合わせができなくなる
  const song = flag('--song', null) != null
    ? parseInt(flag('--song', '0'), 10)
    : defaultSong(item.format, header);

  const t0 = Date.now();
  const { audio, sampleRate } = await renderAudio(bytes, item.format, { song, seconds });
  const ms = Date.now() - t0;

  const st = basicStats(audio);
  const sil = silenceStats(audio, sampleRate);
  const peaks = spectralPeaks(audio, sampleRate);

  console.log(`file      : ${item.key}`);
  console.log(`format    : ${item.format}  (song ${song}, ${seconds}s, ${sampleRate}Hz, 描画 ${ms}ms)`);
  console.log(`samples   : ${audio.length.toLocaleString()}`);
  console.log(`peak      : ${st.peak.toFixed(4)}  (${db(st.peak)})`);
  console.log(`rms       : ${st.rms.toFixed(4)}  (${db(st.rms)})`);
  console.log(`dc offset : ${st.dc.toFixed(5)}`);
  console.log(`clip      : ${st.clipCount} サンプル (${(st.clipRatio * 100).toFixed(4)}%)  最長連続 ${st.maxClipRun}`);
  console.log(`max jump  : ${st.maxJump.toFixed(4)}  @ ${(st.maxJumpAt / sampleRate).toFixed(2)}s`);
  console.log(`silence   : ${(sil.silentRatio * 100).toFixed(1)}%  冒頭 ${Number.isFinite(sil.leadingSilenceSec) ? sil.leadingSilenceSec.toFixed(1) + 's' : '全部'}`);
  console.log(`peaks     : ${peaks.map((p) => `${p.hz}Hz(${p.note}) ${p.rel}`).join('  ') || '-'}`);
  console.log('(測定点: DC遮断後・リミッタ/マスター音量の前)');
  console.log('');
  for (const v of verdicts(st, sil)) console.log(`  ${v}`);

  const wav = flag('--wav', null);
  if (wav) { writeWav(wav, audio, sampleRate); console.log(`\nwrote: ${wav}`); }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
