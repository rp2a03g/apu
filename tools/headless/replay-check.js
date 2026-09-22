/*
 * 再生エンジンの回帰: 「書き込みログの再適用で鳴らすブラウザの再生エンジン」が、
 * CPUを回して直接合成した音(真値)と同じ音を出すかを、フレーム内タイミングごと確かめる。
 *
 *   node tools/headless/replay-check.js                 (要 MML_CORPUS_ROOT)
 *   node tools/headless/replay-check.js --strip-t       t を捨てて再生(必ずNGになる=検査の自己確認)
 *
 * 背景(2026-09-22): ブラウザのNSF再生は 2026-08-08 に「6502を回しながら音を作る」方式から
 * NsfReplayStreamPlayer(Worker の先読みキャプチャ writeLog をチップへ再適用するだけ)へ
 * 変わった。writeLog はフレーム単位なので、1フレームに何十回も $4011 を書く
 * ソフトウェアPCM(水戸黄門の音声)がフレーム頭に潰れて壊れたが、ヘッドレスの回帰は
 * 変換(captureSong=CPU直接合成)しか見ておらず1か月半気付けなかった。修正で writeLog の
 * 各書き込みにフレーム内時刻 t を付けたが、その t を出す経路は captureSong(renderFrame)と
 * captureSongAsync の regsOnly ループの2本あり、片方だけ直して「直った」と誤認もした。
 * この検査は**アプリ本体と同じ経路**(captureSongAsync regsOnly → NsfReplayStreamPlayer)を
 * 通した音を、captureSong の音と0.1秒窓のスペクトル類似度で比べる。
 *
 * 判定: 有音窓の平均類似度 >= 0.95 かつ 最低 >= 0.7。番兵曲は「フレーム内タイミングが音に
 * 効く曲」を選ぶ(水戸黄門#0=$4011音声)。コーパスに無い番兵は skip と表示して失敗にしない。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, readBytes } = require('./load');

const ROOT = process.env.MML_CORPUS_ROOT || null;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const root = flag('--corpus-root', ROOT);
const STRIP_T = argv.includes('--strip-t');
const SEC = +flag('--sec', '4');
const SR = 44100;

// 番兵: [表示名, 形式, ファイル名, 曲(0始まり), 見る範囲(秒)]
const SENTINELS = [
  ['水戸黄門#0 $4011音声', 'nsf', 'Tenka no Goikenban - Mito Koumon (1987-08-11)(-)(Sunsoft).nsf', 0, 1.5],
  ['Golf US #0 FDS変調', 'nsf', 'Famicom Golf - US Course (FDS)(1987-06-14)(HAL Laboratory)(Nintendo).nsf', 0, 4],
  // N163: ドライバが位相バイトを LDA $4800 で読み飛ばすので、読み出しをログに残さないと
  // 書き込みが位相バイトへずれ落ちて(音程は同じまま)3chデチューンのうなりが別物になる(0.907)
  ['女神転生II #0 N163', 'nsf', 'Megami Tensei II - Digital Devil Story (1990-04-06)(Atlus)(Namco).nsf', 0, 4],
];

const N = 4096;
function fft(re, im) {
  for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const WIN = new Float32Array(N); for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
const BINS = Math.floor(6000 / (SR / N));
function spec(x, at) {
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (x[at + i] || 0) * WIN[i];
  fft(re, im);
  const m = new Float32Array(BINS); let e = 0;
  for (let k = 0; k < BINS; k++) { m[k] = Math.hypot(re[k], im[k]); e += m[k] * m[k]; }
  return { m, e: Math.sqrt(e) };
}
const SIL = 2;
function cosSim(a, b) {
  if (a.e < SIL && b.e < SIL) return null; // 両方無音: 判定しない
  if (a.e < SIL || b.e < SIL) return 0;
  let s = 0; for (let k = 0; k < BINS; k++) s += a.m[k] * b.m[k];
  return s / (a.e * b.e);
}
// 位相に依存しない比較。再生エンジン側の頭の遅れは無いはずだが、±2フレームのラグは探す
function compare(truth, replay, seconds) {
  const HOP = SR / 10;
  const frames = []; for (let t = 0; t + N <= Math.min(truth.length, seconds * SR); t += HOP) frames.push({ t, s: spec(truth, t) });
  const score = (lag) => { let s = 0, n = 0, min = 1; for (const f of frames) { const c = cosSim(f.s, spec(replay, f.t + lag)); if (c === null) continue; s += c; n++; if (c < min) min = c; } return { mean: n ? s / n : 1, min, n }; };
  let best = null;
  for (let lag = -1500; lag <= 1500; lag += 100) { const r = score(lag); if (!best || r.mean > best.mean) { best = r; best.lag = lag; } }
  return best;
}

// ブラウザの AudioContext の張りぼて(stream-player.js が起動時に触るものだけ)
function fakeAudioCtx() {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 1 }, attack: { value: 0 }, release: { value: 0 }, onaudioprocess: null });
  return { sampleRate: SR, destination: node(), createGain: node, createDynamicsCompressor: node, createScriptProcessor: node };
}

async function checkNsf(MML, bytes, song, seconds) {
  // 真値: CPUとAPUをインターリーブして直接合成(captureSong)
  const truth = MML.Emu.captureSong(bytes, { songIndex: song, durationSeconds: seconds + 0.5, sampleRate: SR });
  // アプリ本体と同じ経路: Worker が回す regsOnly の先読みキャプチャ → NsfReplayStreamPlayer
  const cap = await MML.Emu.captureSongAsync(bytes, { songIndex: song, durationSeconds: seconds + 0.5, regsOnly: true, yieldFn: () => Promise.resolve() });
  if (STRIP_T) for (const ws of cap.writeLog) for (const w of ws) delete w.t;
  const p = new MML.Audio.NsfReplayStreamPlayer(fakeAudioCtx());
  p.load(bytes, song, cap.totalFrames, cap);
  p.isPlaying = true;
  const total = Math.ceil((seconds + 0.5) * SR), out = new Float32Array(total), buf = new Float32Array(1024);
  for (let i = 0; i < total; i += 1024) { p._fill(buf); out.set(buf.subarray(0, Math.min(1024, total - i)), i); }
  // 真値は dcBlock 済み、再生側も DC ブロッカー入り。ゲイン段(gainNode)は通らないので素の音同士
  return compare(truth.audio, out, seconds);
}

async function main() {
  if (!root) { console.error('MML_CORPUS_ROOT か --corpus-root が必要'); process.exit(2); }
  const { MML } = load({ strict: true });
  let ok = 0, ng = 0, skip = 0;
  for (const [name, fmt, file, song, seconds] of SENTINELS) {
    const p = path.join(root, fmt, file);
    if (!fs.existsSync(p)) { console.log(`skip  ${name} (${file} が無い)`); skip++; continue; }
    let r;
    try {
      if (fmt === 'nsf') r = await checkNsf(MML, readBytes(p), song, Math.min(seconds, SEC));
      else { console.log(`skip  ${name} (${fmt} は未対応)`); skip++; continue; }
    } catch (e) { console.log(`NG    ${name}: 例外 ${e.message}`); ng++; continue; }
    const pass = r.mean >= 0.95 && r.min >= 0.7;
    console.log(`${pass ? 'OK   ' : 'NG   '} ${name}: 類似度 平均 ${r.mean.toFixed(3)} 最低 ${r.min.toFixed(3)} (有音窓 ${r.n}, lag ${r.lag})`);
    if (pass) ok++; else ng++;
  }
  console.log(`replay: OK ${ok} / NG ${ng} / skip ${skip}`);
  process.exit(ng ? 1 : 0);
}
main();
