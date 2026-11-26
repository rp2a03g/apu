/*
 * 混ざった音の採譜(src/input/polyTranscribe.js)の回帰ベンチ(正解つき、2026-11-26)
 *
 *   node tools/headless/wav2mml-bench.js                 compose/ の 2A03 曲を鳴らして採点
 *   node tools/headless/wav2mml-bench.js song.mml ...    任意の MML で採点
 *   node tools/headless/wav2mml-bench.js --set threshold=0.5,ghostRatio=0   しきい値を変えて比べる
 *   node tools/headless/wav2mml-bench.js --mml song.mml  採譜した MML も表示
 *
 * MML を鳴らした音(Mml.render)だけから音符を拾い、compile() の音符列(正解)と突き合わせる。
 * 採点: 発音 ±50ms かつ音高一致。A=矩形波1(旋律)、B=矩形波2、C=三角波(低音)、D=ノイズ(打点、発音だけ)。
 *
 *   全体F   … 多重音の音符すべて 対 A+B+C
 *   旋律    … 声部分けの melody 対 A(再現/適合)
 *   低音帯  … 遮断(多重音の最低声部から決める)より下を単音検出 対 C(再現/適合)。[]内は決めた遮断Hz
 *   低音線  … 声部分けの bass 対 C(再現)。帯域で切らない方式との比較用
 *   打点    … drumOnsets 対 D(F)
 *
 * ★基準値(BASELINE)から 3 ポイント以上落ちたら失敗(終了コード 1)。方式を変えて良くなったら基準値を更新する。
 * ★自作 6 曲はしきい値を決めるのにも使っている(=甘い)。サンプル音源や実録音の精度はこの数字より大きく落ちる。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, ROOT } = require('./load');

const TOL = 0.05, SR = 48000, SEC = 30;
// [全体F, 旋律 再現, 低音帯 再現, 打点F](%)
const BASELINE = {
  hoshi_kouro: [78, 87, 99, 99], choi_melody: [74, 73, 100, 90], dennou_hanabi: [62, 80, 76, 91],
  iseki_no_kaze: [91, 93, 99, 61], karakuri_bayashi: [76, 88, 96, 95], seien_rush: [57, 49, 99, 95]
};

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const showMml = argv.includes('--mml');
const setOpts = {};
for (const kv of (flag('--set', '') || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); setOpts[k] = Number(v); }
let files = argv.filter((a, i) => /\.mml$/i.test(a) && argv[i - 1] !== '--set');
const custom = files.length > 0;
if (!custom) {
  const dir = path.join(ROOT, 'compose');
  files = ['hoshi_kouro', 'choi_melody', 'dennou_hanabi', 'iseki_no_kaze', 'karakuri_bayashi', 'seien_rush']
    .map(s => path.join(dir, s, s + '.mml')).filter(f => fs.existsSync(f));
}

const { MML } = load({ strict: true });
const PT = MML.Input.PolyTranscribe;

function match(est, ref) {
  const used = new Uint8Array(est.length); let tp = 0;
  for (const r of ref) {
    let b = -1, bd = TOL;
    for (let i = 0; i < est.length; i++) {
      if (used[i] || (r.midi != null && est[i].midi !== r.midi)) continue;
      const d = Math.abs(est[i].startSec - r.startSec); if (d < bd) { bd = d; b = i; }
    }
    if (b >= 0) { used[b] = 1; tp++; }
  }
  const P = tp / Math.max(1, est.length), R = tp / Math.max(1, ref.length);
  return { P: P * 100, R: R * 100, F: 200 * P * R / Math.max(1e-9, P + R) };
}
const n0 = v => v.toFixed(0).padStart(3);

let fail = 0;
console.log('曲                 全体F | 旋律 再現/適合 | 低音帯 再現/適合 [遮断] | 低音線 再現 | 打点F | 解析ms');
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const c = MML.Mml.compile(src), FR = c.frameRate || 60.0988;
  const durSec = Math.min(SEC, c.totalFrames / FR);
  const audio = MML.Mml.render(src, { sampleRate: SR }).audio.subarray(0, Math.floor(durSec * SR));
  // 正解
  const ref = {};
  for (const ch of ['A', 'B', 'C']) {
    const segs = c.segmentsByChannel[ch] || [], list = ref[ch] = [];
    let f = 0; const at = []; for (const s of segs) { at.push([f, s]); f += s.durationFrames; }
    let si = 0;
    for (const n of (c.noteList[ch] || [])) {
      if (n.note == null || n.kind !== 'note') continue;
      while (si + 1 < at.length && at[si + 1][0] <= n.startFrame) si++;
      const s = at[si] && at[si][1];
      const midi = s && s.freq ? Math.round(69 + 12 * Math.log2(s.freq / 440)) : n.note + 12;
      const startSec = n.startFrame / FR; if (startSec >= durSec) break;
      if (n.joined && list.length && list[list.length - 1].midi === midi) continue;
      list.push({ midi, startSec });
    }
  }
  const drum = [];
  for (const n of (c.noteList.D || [])) if (n.note != null && n.kind === 'note' && !n.joined && n.startFrame / FR < durSec) drum.push({ midi: null, startSec: n.startFrame / FR });
  const all = [...ref.A, ...ref.B, ...ref.C].sort((a, b) => a.startSec - b.startSec);

  const t0 = Date.now();
  const x = PT.toMono24k(audio, SR);
  const act = PT.multiPitch(x, setOpts);
  const notes = PT.notes(act, setOpts);
  const v = PT.voices(notes, setOpts);
  const cutoff = PT.suggestBassCutoff(v.bass, setOpts);
  const bass = PT.bassBand(x, Object.assign({}, setOpts, { bassCutoffHz: cutoff }));
  const hits = PT.drumOnsets(x, setOpts);
  const ms = Date.now() - t0;

  const mAll = match(notes, all), mMel = match(v.melody, ref.A), mBass = match(bass, ref.C), mLine = match(v.bass, ref.C);
  const mDrum = drum.length ? match(hits.map(h => ({ midi: null, startSec: h.timeSec })), drum) : null;
  const name = path.basename(file, '.mml');
  console.log(`${name.padEnd(18)} ${n0(mAll.F)}  |   ${n0(mMel.R)} / ${n0(mMel.P)}   |    ${n0(mBass.R)} / ${n0(mBass.P)}  [${String(cutoff).padStart(3)}] |     ${n0(mLine.R)}    |  ${mDrum ? n0(mDrum.F) : '  -'}  | ${ms}`);
  const base = BASELINE[name];
  if (base && !custom && !Object.keys(setOpts).length) {
    const got = [mAll.F, mMel.R, mBass.R, mDrum ? mDrum.F : 100];
    const label = ['全体F', '旋律', '低音帯', '打点'];
    got.forEach((g, i) => { if (g < base[i] - 3) { fail++; console.log(`  ✗ ${label[i]} が基準 ${base[i]} から ${g.toFixed(0)} へ落ちた`); } });
  }
  if (showMml) {
    const r = PT.buildMml([{ letter: 'A', notes: v.melody }, { letter: 'B', notes: v.inner }, { letter: 'C', notes: bass }], { letter: 'D', hits }, {});
    console.log(`--- 採譜した MML(t${Math.round(r.bpm)})---\n${r.text}\n`);
  }
}
if (fail) { console.log(`\n${fail} 件の退行`); process.exit(1); }
