/*
 * 聴音(鼻歌・楽器の単音 → MML)の回帰ベンチ(正解つき合成音、2026-10-12)
 *
 *   node tools/headless/dictation-bench.js                 鼻歌 144 件 + 楽器 14 件を採点して一覧
 *   node tools/headless/dictation-bench.js --detail hum natural kirakira 120 sloppy
 *                                                          1件の正解/検出/MML を表示し WAV を書く
 *   node tools/headless/dictation-bench.js --no-keysnap    調へ寄せる処理を切って比べる
 *
 * 合成鼻歌(synthHum)は人の崩れ方を模す: 音ごとの音程ずれ、ドリフト、遅れて始まるビブラート、頭のスクープ、
 * 音間のグライド、同音連打の音量の谷、ジッタ、息の雑音。音色 hum/la/whistle/octave(2倍音>基音の罠)。
 * 合成楽器(synthPluck)は撥弦/打弦: 4ms アタック+指数減衰、高次倍音ほど速く減衰、非調和性、前の音の残響の重なり。
 *
 * 採点: 発音位置 ±100ms で同じ音高なら一致。検出音符列は本物の MML.Input.quantize → MML.Convert.emitChannel に
 * 通し、正解も同じ経路で MML にして文字列比較する(exactMML)。テンポは NoteSegment.estimateBpm。
 * 基準値(2026-10-12、keySnap ON): 丁寧 99〜100% / 崩れ(なめらか) 87〜94% / 崩れ(1音ずつ切る) 79〜82%、
 * 楽器 4分・8分 14/14、ピアノ(止める)16分 17/18、ギター(残響あり)16分 14/18。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const conv = require('./convert');
const MML = conv.ctx();
const PD = MML.Input.PitchDetect, NS = MML.Input.NoteSegment;

const TOL = 0.1;
const args = process.argv.slice(2);
const KEYSNAP = !args.includes('--no-keysnap');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

// ---- 合成: 鼻歌 -----------------------------------------------------------
function synthHum(melody, bpm, style) {
  const sr = 48000, r = rng(style.seed || 1), beatSec = 60 / bpm;
  const S = Object.assign({ vibCents: 30, vibHz: 5.5, scoopCents: 120, glideMs: 80, offsetSd: 0.15, driftCents: 15,
    timbre: 'hum', snrDb: 30, dipRatio: 0.3, attackMs: 40, releaseMs: 70, dipMs: 70 }, style);
  const notes = []; let t = 0;
  for (const n of melody) {
    const dur = n.beats * beatSec;
    if (n.midi != null) notes.push({ midi: n.midi, startSec: t, endSec: t + dur, artic: n.artic || 'attack', off: gauss(r) * S.offsetSd });
    t += dur;
  }
  const N = Math.round((t + 0.5) * sr), x = new Float32Array(N), f0 = new Float32Array(N), amp = new Float32Array(N);
  let drift = 0, driftTarget = 0;
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k], prev = notes[k - 1], next = notes[k + 1];
    const a = Math.round(n.startSec * sr), b = Math.round(n.endSec * sr);
    const cont = (p, q) => p && q && Math.abs(p.endSec - q.startSec) < 1e-6;
    const legatoIn = prev && n.artic === 'legato' && cont(prev, n), legatoOut = next && next.artic === 'legato' && cont(n, next);
    const reIn = prev && n.artic === 're' && cont(prev, n), reOut = next && next.artic === 're' && cont(n, next);
    for (let i = a; i < b && i < N; i++) {
      const tl = (i - a) / sr, tr = (b - i) / sr;
      let m = n.midi + n.off;
      if (!legatoIn) m -= (S.scoopCents / 100) * Math.exp(-tl / 0.04);
      if (legatoIn) { const g = S.glideMs / 1000, w = 1 / (1 + Math.exp(-tl / (g / 6))); m = (prev.midi + prev.off) + ((n.midi + n.off) - (prev.midi + prev.off)) * w; }
      if (legatoOut) { const g = S.glideMs / 1000, w = 1 / (1 + Math.exp(tr / (g / 6))); m += ((next.midi + next.off) - (n.midi + n.off)) * 0.5 * w; }
      const vibEnv = Math.min(1, Math.max(0, (tl - 0.15) / 0.2));
      m += (S.vibCents / 100) * vibEnv * Math.sin(2 * Math.PI * S.vibHz * tl + k);
      if ((i & 1023) === 0) { if (r() < 0.02) driftTarget = (r() - 0.5) * 2 * S.driftCents / 100; drift += (driftTarget - drift) * 0.05; }
      m += drift;
      f0[i] = 440 * Math.pow(2, (m - 69) / 12);
      let env = 1;
      const atk = S.attackMs / 1000, rel = S.releaseMs / 1000, dip = S.dipMs / 1000;
      if (!legatoIn && !reIn) env *= Math.min(1, tl / atk);
      if (!legatoOut && !reOut) env *= Math.min(1, tr / rel);
      if (reIn) env *= S.dipRatio + (1 - S.dipRatio) * Math.min(1, tl / (dip / 2));
      if (reOut) env *= S.dipRatio + (1 - S.dipRatio) * Math.min(1, tr / (dip / 2));
      env *= 1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * tl + k * 2);
      amp[i] = env;
    }
  }
  let ph = 0, jit = 0;
  for (let i = 0; i < N; i++) {
    if (!amp[i]) continue;
    const f = f0[i];
    if ((i & 255) === 0) jit = gauss(r) * 0.004;
    ph += 2 * Math.PI * f * (1 + jit) / sr;
    let s = 0;
    for (let k = 1; k <= 40; k++) {
      const fk = f * k; if (fk > 9000) break;
      let a;
      if (S.timbre === 'whistle') a = k === 1 ? 1 : (k === 2 ? 0.05 : 0);
      else if (S.timbre === 'hum') a = (1 / k) / (1 + Math.pow(fk / 900, 2));
      else if (S.timbre === 'octave') a = (k === 1 ? 0.35 : 1 / k) * (1 / (1 + Math.pow(fk / 1200, 2))) * (k === 2 ? 1.6 : 1);
      else { const F = (fc, bw) => 1 / Math.sqrt(1 + Math.pow((fk - fc) / bw, 2)); a = (1 / Math.pow(k, 0.6)) * (F(700, 120) + 0.6 * F(1200, 150) + 0.3 * F(2600, 250) + 0.08); }
      if (a) s += a * Math.sin(ph * k);
    }
    x[i] = s * amp[i];
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(x[i]));
  const g = 0.5 / (peak || 1); let sig = 0;
  for (let i = 0; i < N; i++) { x[i] *= g; sig += x[i] * x[i]; }
  sig = Math.sqrt(sig / N);
  const nAmp = sig * Math.pow(10, -S.snrDb / 20); let lp = 0;
  for (let i = 0; i < N; i++) { const w = gauss(r); lp += (w - lp) * 0.08; x[i] += nAmp * (0.7 * lp * 3 + 0.3 * w); }
  return { sr, x, truth: notes.map(n => ({ midi: n.midi, startSec: n.startSec, endSec: n.endSec, off: n.off })) };
}

// ---- 合成: 撥弦/打弦 -------------------------------------------------------
function synthPluck(melody, bpm, o) {
  const sr = 48000, beat = 60 / bpm, r = rng(o.seed || 3);
  let t = 0; const notes = [];
  for (const [m, b] of melody) { notes.push({ midi: m + (o.transpose || 0), startSec: t, endSec: t + b * beat, off: 0 }); t += b * beat; }
  const N = Math.round((t + 1.5) * sr), x = new Float32Array(N);
  const tau = o.tau || 0.8, ring = o.ring != null ? o.ring : 1, B = o.inharm || 0.0003;
  for (const n of notes) {
    const f = 440 * Math.pow(2, (n.midi - 69) / 12), a = Math.round(n.startSec * sr);
    const stopAt = ring ? Math.min(N, a + Math.round(3 * tau * sr)) : Math.min(N, Math.round(n.endSec * sr) + Math.round(0.03 * sr));
    const ph = []; for (let h = 1; h <= 20; h++) ph.push(r() * 6.28);
    for (let i = a; i < stopAt; i++) {
      const tl = (i - a) / sr;
      const env = Math.min(1, tl / 0.004) * Math.exp(-tl / tau) * (ring ? 1 : Math.min(1, (stopAt - i) / (0.02 * sr)));
      let s = 0;
      for (let h = 1; h <= 20; h++) {
        const fh = f * h * Math.sqrt(1 + B * h * h); if (fh > 10000) break;
        s += (o.weakFund && h === 1 ? 0.3 : 1) / Math.pow(h, 0.9) * Math.exp(-tl * h * 1.5 / tau) * Math.sin(2 * Math.PI * fh * tl + ph[h - 1]);
      }
      x[i] += s * env;
    }
  }
  let pk = 0; for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(x[i]));
  for (let i = 0; i < N; i++) x[i] = x[i] / pk * 0.5 + (r() - 0.5) * 0.002;
  return { sr, x, truth: notes };
}

// ---- 素材 ------------------------------------------------------------------
const MELODIES = {
  kirakira: [[60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2], [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2]],
  scale: [[60, .5], [62, .5], [64, .5], [65, .5], [67, .5], [69, .5], [71, .5], [72, .5], [71, .5], [69, .5], [67, .5], [65, .5], [64, .5], [62, .5], [60, 1]],
  game: [[67, .75], [67, .25], [72, .5], [71, .5], [69, .5], [67, 1], [64, .5], [65, .5], [67, .5], [60, .5], [62, 1], [64, .5], [67, .5], [65, 1.5], [64, .5], [62, 2]],
  run: [[60, .25], [62, .25], [64, .25], [65, .25], [67, 1], [69, .25], [67, .25], [65, .25], [64, .25], [62, .5], [64, .5], [60, 1], [67, .5], [67, .5], [65, .25], [64, .25], [62, .5], [60, 1]],
};
const ARTICS = {
  natural: (i, src) => src[i][0] === src[i - 1][0] ? 're' : 'legato',
  legato: () => 'legato', attack: () => 'attack'
};
const QUALITY = {
  clean:  { vibCents: 20, scoopCents: 80, glideMs: 60, offsetSd: 0.12, driftCents: 10, snrDb: 30 },
  sloppy: { vibCents: 50, scoopCents: 200, glideMs: 120, offsetSd: 0.3, driftCents: 25, snrDb: 15, dipRatio: 0.5 },
};
function melodyOf(name, artic, transpose) {
  const src = MELODIES[name];
  return src.map(([m, b], i) => ({ midi: m + (transpose || 0), beats: b, artic: i === 0 ? 'attack' : artic(i, src) }));
}
function mergeLegato(truth, artic) {
  if (artic !== 'legato') return truth;
  const out = [];
  for (const t of truth) { const l = out[out.length - 1]; if (l && l.midi === t.midi && Math.abs(l.endSec - t.startSec) < 1e-6) { l.endSec = t.endSec; continue; } out.push(Object.assign({}, t)); }
  return out;
}

// ---- 検出と採点 --------------------------------------------------------------
function detect(x, sr, preset) {
  const P = NS.PRESETS[preset];
  const { frames } = PD.analyze(x, sr, P.detect);
  return NS.segment(frames, Object.assign({ keySnap: KEYSNAP }, P.segment)).notes;
}
function score(truth, det) {
  const used = new Set(); let hits = 0, oct = 0, onsetErr = 0, inTune = 0, inTuneHit = 0;
  for (const t of truth) {
    let best = -1, bd = Infinity;
    det.forEach((d, i) => { if (used.has(i)) return; const dd = Math.abs(d.startSec - t.startSec); if (dd < TOL && dd < bd) { bd = dd; best = i; } });
    const ok = best >= 0 && det[best].midi === t.midi;
    if (best >= 0) { if (ok) { used.add(best); hits++; onsetErr += bd; } else if (Math.abs(det[best].midi - t.midi) === 12) { used.add(best); oct++; } }
    if (t.off == null || Math.abs(t.off) <= 0.45) { inTune++; if (ok) inTuneHit++; }
  }
  return { hits, oct, truth: truth.length, det: det.length, onsetErr: hits ? onsetErr / hits : 0, inTune, inTuneHit };
}
function toMml(notes, bpm) {
  const q = MML.Input.quantize(NS.toTimedEvents(notes), { bpm, originSec: 0, grid: 16, strength: 1, legato: true, beatsPerBar: 4 });
  const text = MML.Convert.emitChannel('A', q.events.map(e => Object.assign({}, e)), MML.Convert.TPQN,
    { totalFrames: q.totalTicks, wrapCol: 1e9, cmd: { SHAPE_REST: false } });
  return { q, text };
}
function writeWav(file, x, sr) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}

// ---- 1件表示 -------------------------------------------------------------------
const di = args.indexOf('--detail');
if (di >= 0) {
  const [timbre, artic, mel, bpmS, qual] = args.slice(di + 1);
  const bpm = Number(bpmS) || 120;
  const g = synthHum(melodyOf(mel, ARTICS[artic]), bpm, Object.assign({ timbre, seed: 7 }, QUALITY[qual] || QUALITY.clean));
  const truth = mergeLegato(g.truth, artic);
  const notes = detect(g.x, g.sr, 'voice');
  const out = path.join(__dirname, `dictation_${timbre}_${artic}_${mel}_${qual || 'clean'}.wav`);
  writeWav(out, g.x, g.sr);
  console.log('truth :', truth.map(n => `${n.startSec.toFixed(2)}:${n.midi}`).join(' '));
  console.log('detect:', notes.map(n => `${n.startSec.toFixed(2)}:${n.midi}${n.onset === 'dip' || n.onset === 'rise' ? '*' : ''}`).join(' '));
  console.log('score', score(truth, notes));
  console.log('truth MML :', toMml(truth, bpm).text);
  console.log('detect MML:', toMml(notes, bpm).text);
  console.log('bpm estimate', NS.estimateBpm(notes), 'true', bpm, ' wav:', out);
  process.exit(0);
}

// ---- 一覧 -----------------------------------------------------------------------
const agg = {};
const t0 = Date.now();
for (const timbre of ['hum', 'la', 'whistle', 'octave'])
  for (const artic of ['natural', 'legato', 'attack'])
    for (const qual of ['clean', 'sloppy'])
      for (const mel of Object.keys(MELODIES))
        for (const bpm of (mel === 'kirakira' ? [90, 120, 160] : [120])) {
          const g = synthHum(melodyOf(mel, ARTICS[artic], timbre === 'whistle' ? 12 : (timbre === 'hum' ? -12 : 0)), bpm, Object.assign({ timbre, seed: 11 }, QUALITY[qual]));
          const truth = mergeLegato(g.truth, artic);
          const notes = detect(g.x, g.sr, 'voice');
          const sc = score(truth, notes);
          const a = toMml(truth, bpm), b = toMml(notes, bpm);
          const bg = NS.estimateBpm(notes);
          const k = `${timbre}/${artic}/${qual}`;
          const A = agg[k] = agg[k] || { hits: 0, truth: 0, det: 0, oct: 0, exact: 0, n: 0, bpmOk: 0, bpmOct: 0, onset: 0, inTune: 0, inTuneHit: 0 };
          A.hits += sc.hits; A.truth += sc.truth; A.det += sc.det; A.oct += sc.oct; A.exact += a.text === b.text ? 1 : 0; A.n++;
          A.bpmOk += Math.abs(bg - bpm) <= 2 ? 1 : 0; A.bpmOct += (Math.abs(bg - bpm * 2) <= 4 || Math.abs(bg - bpm / 2) <= 1) ? 1 : 0;
          A.onset += sc.onsetErr; A.inTune += sc.inTune; A.inTuneHit += sc.inTuneHit;
        }
console.log(`keySnap=${KEYSNAP}  (${Date.now() - t0}ms)`);
console.log('voice: timbre/artic/quality     recall  prec  oct  exactMML  bpmOk(oct)  onsetMs  inTuneRecall');
for (const [k, A] of Object.entries(agg)) {
  console.log(k.padEnd(30), (A.hits / A.truth * 100).toFixed(0).padStart(5) + '%', (A.hits / Math.max(1, A.det) * 100).toFixed(0).padStart(5) + '%',
    String(A.oct).padStart(4), `${A.exact}/${A.n}`.padStart(9), `${A.bpmOk}(${A.bpmOct})/${A.n}`.padStart(11), (A.onset / A.n * 1000).toFixed(0).padStart(7),
    (A.inTuneHit / Math.max(1, A.inTune) * 100).toFixed(0).padStart(8) + '%');
}

console.log('\ninstrument (preset instrument):');
const cases = [];
for (const [mel, bpm] of [['kirakira', 120], ['scale', 120], ['run', 120], ['game', 160]]) {
  cases.push([`guitar ring tau0.8 ${mel}@${bpm}`, synthPluck(MELODIES[mel], bpm, { ring: 1, tau: 0.8 }), bpm]);
  cases.push([`guitar ring weak-fundamental ${mel}`, synthPluck(MELODIES[mel], bpm, { ring: 1, tau: 0.8, weakFund: true }), bpm]);
  cases.push([`piano damped tau1.5 ${mel}@${bpm}`, synthPluck(MELODIES[mel], bpm, { ring: 0, tau: 1.5 }), bpm]);
}
cases.push(['bass damped kirakira o2', synthPluck(MELODIES.kirakira, 100, { ring: 0, tau: 1.0, transpose: -31 }), 100]);
cases.push(['bass ring kirakira o2', synthPluck(MELODIES.kirakira, 100, { ring: 1, tau: 1.0, transpose: -31 }), 100]);
for (const [name, g, bpm] of cases) {
  const notes = detect(g.x, g.sr, 'instrument');
  const sc = score(g.truth, notes);
  const exact = toMml(g.truth, bpm).text === toMml(notes, bpm).text;
  console.log(name.padEnd(40), `hit ${sc.hits}/${sc.truth} det ${sc.det} oct ${sc.oct}`, exact ? 'exactMML' : '');
}
