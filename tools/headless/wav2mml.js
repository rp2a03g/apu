/*
 * 混ざった音 → MML の CLI(ブラウザの聴音「曲(伴奏入り)」と同じコア: src/input/polyTranscribe.js)
 *
 *   node tools/headless/wav2mml.js <曲.wav> [--bpm N] [--grid 16] [--bass band|line] [--no-drums] [--no-inner]
 *                                  [--set key=value,...] [-o out.mml]
 *   node tools/headless/wav2mml.js --bass-stem bass.wav --other-stem other.wav --drums-stem drums.wav [--vocals-stem vocals.wav]
 *
 *   1 本の WAV(混ざった音)からは 旋律→A / 2 声目→B / 低音→C / 打点→D を取り出す。
 *   外で分けたステムを渡すと、bass は低音(帯域で切らず単音検出)、other は旋律と 2 声目、drums は打点、
 *   vocals は単音検出で旋律(A)になり、other の旋律は B へ回る。-50dB 未満のステムは無音として使わない。
 *
 *   --bass   band=遮断より下を単音検出(既定。誤検出が少ない) / line=多重音の最低声部(高い音域まで動くベース向け)
 *   --set    しきい値を直接指定(src/input/polyTranscribe.js の DEFAULTS。例: --set threshold=0.5,drumSensitivity=3)
 *
 * 入力は PCM WAV(16/24bit・32bit float、モノ/ステレオ、任意レート)。MP3 等はブラウザ側で読む。
 */
'use strict';
const fs = require('fs');
const { load } = require('./load');
const { MML } = load({ strict: true });
const PT = MML.Input.PolyTranscribe, PD = MML.Input.PitchDetect, NS = MML.Input.NoteSegment;

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF/WAV file: ' + file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = { off: p + 8, len: Math.min(sz, b.length - p - 8) }; break; }
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('bad wav: ' + file);
  const bps = fmt.bits / 8, n = Math.floor(data.len / (bps * fmt.ch)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const q = data.off + (i * fmt.ch + c) * bps;
      if (fmt.bits === 16) s += b.readInt16LE(q) / 32768;
      else if (fmt.bits === 32 && fmt.tag === 3) s += b.readFloatLE(q);
      else if (fmt.bits === 32) s += b.readInt32LE(q) / 2147483648;
      else if (fmt.bits === 24) s += ((b[q] | (b[q + 1] << 8) | (b[q + 2] << 16)) << 8 >> 8) / 8388608;
      else if (fmt.bits === 8) s += (b[q] - 128) / 128;
    }
    out[i] = s / fmt.ch;
  }
  return PT.toMono24k(out, fmt.sr);
}

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['--bpm', '--grid', '--bass', '--set', '-o', '--bass-stem', '--other-stem', '--drums-stem', '--vocals-stem'];
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const mixFile = argv.find((a, i) => !a.startsWith('-') && VALUE_FLAGS.indexOf(argv[i - 1]) < 0);
const stems = { bass: flag('--bass-stem'), other: flag('--other-stem'), drums: flag('--drums-stem'), vocals: flag('--vocals-stem') };
if (!mixFile && !stems.bass && !stems.other && !stems.drums && !stems.vocals) {
  console.error('usage: node tools/headless/wav2mml.js <song.wav> [--bpm N] [--grid N] [--bass band|line] [--no-drums] [--no-inner] [--set k=v,...] [-o out.mml]\n' +
    '       node tools/headless/wav2mml.js --bass-stem b.wav --other-stem o.wav --drums-stem d.wav [--vocals-stem v.wav]');
  process.exit(1);
}
const o = {};
for (const kv of (flag('--set', '') || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); o[k] = Number(v); }
const log = (...a) => console.error(...a);
const rmsDb = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return 10 * Math.log10(s / Math.max(1, x.length) + 1e-12); };
const QUIET_DB = -50;
const mono = (x, det) => {
  const { frames } = PD.analyze(x, PT.SAMPLE_RATE, Object.assign({}, NS.PRESETS.instrument.detect, det || {}));
  return NS.segment(frames, Object.assign({}, NS.PRESETS.instrument.segment, { keySnap: false, midiMin: 24 })).notes;
};

const t0 = Date.now();
let melody = [], inner = [], bass = [], hits = [];
if (mixFile) {
  const x = readWav(mixFile);
  log(`${mixFile}: ${(x.length / PT.SAMPLE_RATE).toFixed(1)}s`);
  const v = PT.voices(PT.notes(PT.multiPitch(x, o), o), o);
  melody = v.melody; inner = v.inner;
  if (flag('--bass', 'band') === 'line') bass = v.bass;
  else { const cutoff = PT.suggestBassCutoff(v.bass, o); log(`低音の遮断: ${cutoff}Hz`); bass = PT.bassBand(x, Object.assign({}, o, { bassCutoffHz: cutoff })); }
  hits = PT.drumOnsets(x, o);
} else {
  const get = (name) => { if (!stems[name]) return null; const x = readWav(stems[name]); const db = rmsDb(x); log(`${name}: ${stems[name]} ${db.toFixed(1)}dB${db < QUIET_DB ? '(無音として使わない)' : ''}`); return db < QUIET_DB ? null : x; };
  const xb = get('bass'), xo = get('other'), xd = get('drums'), xv = get('vocals');
  if (xb) bass = mono(xb, { fmin: 30, fmax: 400, gateDb: -50 });
  if (xo) { const v = PT.voices(PT.notes(PT.multiPitch(xo, o), o), Object.assign({}, o, { bassSplitMidi: 0 })); melody = v.melody; inner = v.inner; }
  if (xv) { inner = melody; melody = mono(xv, { fmin: 100, fmax: 2100 }); }
  if (xd) hits = PT.drumOnsets(xd, o);
}
if (argv.includes('--no-drums')) hits = [];
if (argv.includes('--no-inner')) inner = [];

const bpm = flag('--bpm') ? Number(flag('--bpm')) : undefined;
const r = PT.buildMml([{ letter: 'A', notes: melody }, { letter: 'B', notes: inner }, { letter: 'C', notes: bass }], { letter: 'D', hits },
  { bpm, grid: Number(flag('--grid', '16')) });
const chk = MML.Mml.compile(r.text);
log(`旋律 ${melody.length} 音 / 2声目 ${inner.length} 音 / 低音 ${bass.length} 音 / 打点 ${hits.length} / t${Math.round(r.bpm)}${bpm ? '' : '(推定)'} / 解析 ${Date.now() - t0}ms / コンパイルエラー ${chk.errors.length} 件`);
for (const e of chk.errors.slice(0, 5)) log('  ' + (e.message || JSON.stringify(e)));
if (flag('-o')) { fs.writeFileSync(flag('-o'), r.text + '\n'); log('wrote ' + flag('-o')); } else console.log(r.text);
