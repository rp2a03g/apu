/*
 * 聴音 CLI: 録音 WAV → 音符列 → MML(ブラウザの聴音パネルと同じコア: pitchDetect.js / noteSegment.js / quantize.js)
 *
 *   node tools/headless/dictation.js <録音.wav> [--preset voice|instrument] [--bpm 120] [--grid 16] [--octave 12]
 *                                    [--no-keysnap] [--gate] [--track] [--set key=value,...]
 *
 *   --preset   声(既定)/楽器。検出下限(70/40Hz)とスクープ吸収の既定が変わる
 *   --bpm      テンポ(省略時は発音間隔から推定)
 *   --octave   半音単位の移調(鼻歌は低くなりがちなので +12 等)
 *   --gate     音符の隙間を休符として残す(既定は詰めるレガート)
 *   --track    ピッチ軌跡(20msごと)も表示
 *   --set      検出/区切りのしきい値を直接指定(例: --set dipDb=4,minNoteSec=0.08,gateDb=-50,threshold=0.2)
 *
 * 入力は PCM WAV(8/16/24bit・32bit float、モノ/ステレオ、任意レート)。
 * Windows 11「サウンド レコーダー」は設定で録音形式を WAV にできる。
 * 「どこで音符が割れたか」を見るときは --track と、音符の行の * (谷/立ち上がりで分けた印)を見る。
 */
'use strict';
const fs = require('fs');
const conv = require('./convert');
const MML = conv.ctx();
const PD = MML.Input.PitchDetect, NS = MML.Input.NoteSegment;

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF/WAV file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = { off: p + 8, len: Math.min(sz, b.length - p - 8) };
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('bad wav');
  const bps = fmt.bits / 8, frames = Math.floor(data.len / (bps * fmt.ch)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
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
  return { sr: fmt.sr, x: out };
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^(voice|instrument|\d+(\.\d+)?|-?\d+|[a-zA-Z]+=.*)$/.test(a));
if (!file) { console.error('usage: node tools/headless/dictation.js <wav> [--preset voice|instrument] [--bpm N] [--grid N] [--octave N] [--no-keysnap] [--gate] [--track] [--set k=v,...]'); process.exit(1); }
const optStr = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] != null ? args[i + 1] : def; };
const optNum = (name, def) => { const v = optStr(name, null); return v == null ? def : Number(v); };
const preset = optStr('preset', 'voice');
const P = NS.PRESETS[preset] || NS.PRESETS.voice;
const detectOpts = Object.assign({}, P.detect), segOpts = Object.assign({ keySnap: !args.includes('--no-keysnap') }, P.segment);
for (const kv of (optStr('set', '') || '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  const num = Number(v);
  const val = (v === 'true') ? true : (v === 'false') ? false : (Number.isFinite(num) ? num : v);
  if (k in PD.DEFAULTS) detectOpts[k] = val; else segOpts[k] = val;
}

const { sr, x } = readWav(file);
console.log(`file: ${file}  ${sr}Hz  ${(x.length / sr).toFixed(1)}s  preset=${preset}`);
let t0 = Date.now();
const { frames } = PD.analyze(x, sr, detectOpts);
const tDetect = Date.now() - t0;
const { notes: notes0, key } = NS.segment(frames, segOpts);
const octave = optNum('octave', 0);
const notes = notes0.map(n => Object.assign({}, n, { midi: n.midi + octave, pitch: n.pitch + octave }));
console.log(`frames ${frames.length} (voiced ${(frames.filter(p => p.f).length / Math.max(1, frames.length) * 100).toFixed(0)}%)  detect ${tDetect}ms  notes ${notes.length}` +
  (key ? `  key ${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][key.root]} major(scale guess)` : ''));
if (args.includes('--track')) console.log('track(20ms):', frames.filter((p, i) => i % 4 === 0).map(p => p.f ? PD.toMidi(p.f).toFixed(1) : '--').join(' '));
if (!notes.length) { console.log('no notes found (silence, or level below gateDb)'); process.exit(0); }

const name = (m) => ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'][((m % 12) + 12) % 12] + ' o' + (Math.floor(m / 12) - 1);
const ms = notes.map(n => n.midi).sort((a, b) => a - b);
console.log(`range: ${name(ms[0])} .. ${name(ms[ms.length - 1])}  suggested transpose: ${NS.suggestTranspose(notes0) > 0 ? '+12' : '0'}`);
let bpm = optNum('bpm', null);
if (!bpm) { bpm = NS.estimateBpm(notes); console.log(`bpm (estimated from onsets): ${bpm}`); } else console.log(`bpm (given): ${bpm}`);

const grid = optNum('grid', 16), legato = !args.includes('--gate');
const origin = notes[0].startSec;
const q = MML.Input.quantize(NS.toTimedEvents(notes), { bpm, originSec: origin, endSec: notes[notes.length - 1].endSec, grid, strength: 1, legato, beatsPerBar: 4 });
const text = MML.Convert.emitChannel('A', q.events.map(e => Object.assign({}, e)), MML.Convert.TPQN,
  { totalFrames: q.totalTicks, wrapCol: 80, cmd: { SHAPE_REST: false }, tempoPrefix: `t${bpm} ` });
console.log('\nnotes (* = split by dip/rise):');
console.log(notes.map(n => `${n.startSec.toFixed(2)}-${n.endSec.toFixed(2)} ${name(n.midi).padEnd(6)} (${n.pitch.toFixed(2)})${n.onset === 'dip' || n.onset === 'rise' ? ' *' : ''}`).join('\n'));
console.log(`\nquantized: ${q.noteCount} notes, dropped ${q.droppedCount}\n`);
console.log(text);
