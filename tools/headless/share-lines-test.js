/*
 * 共通行(src/convert/mmlEmit.js shareLinesPlan、変換設定 SHARE_LINES)の単体テスト。
 * 合成した2〜3チャンネルを emitScore に通し、次を確かめる:
 *   1. SHARE_LINES=off では従来どおり(行頭に複数文字の行が無い)
 *   2. auto: 音符列が同じ A/B が「AB …」の共通行になり、音量の違いは音符の直前に「A v12」「B v11」で分かれる
 *   3. オクターブ違い(+12)の組も共通行になり、最初の o<n> だけ分かれる
 *   4. 音符列が違うチャンネル(C)は組に入らない
 *   5. auto の条件(分ける行の上限)を超える組は別行に戻る。always なら細切れでも共通行
 *   6. 共通行の出力をコンパイルしても、従来出力と同じ音符列になる(トラックごとのフレーム数と音程列が一致)
 * 使い方: node tools/headless/share-lines-test.js   (NGがあれば exit 1)
 */
'use strict';
const { ctx } = require('./convert');

const M = ctx();
let fails = 0, oks = 0;
function eq(name, a, b) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`NG ${name}: got ${ja} expected ${jb}`); } else { oks++; }
}
const FPB = 30; // 120BPM
const TOTAL = FPB * 4 * 4; // 4小節
function seq(notes, vol, opt) {
  // notes: [[note, beats], ...] を四分=FPB で並べる。vol は全音符の音量(配列なら音符ごと)
  const evs = [];
  let t = 0;
  notes.forEach(([n, beats], i) => {
    const dur = Math.round(beats * FPB);
    const ev = { start: t, end: t + dur, note: n };
    if (n !== null) ev.volume = Array.isArray(vol) ? vol[i % vol.length] : vol;
    if (opt && opt.oct && n !== null) ev.note = n + opt.oct;
    evs.push(ev);
    t += dur;
  });
  return evs;
}
const melody = [[60, 1], [62, 1], [64, 0.5], [65, 0.5], [67, 1], [null, 1], [64, 1], [62, 1], [60, 1], [60, 1], [62, 1], [64, 1], [65, 1], [67, 2], [64, 2]];
function chan(letter, events) { return { letter, events, hasVolume: true }; }
function emit(channels, cmd) {
  const cd = channels.map(c => Object.assign({}, c, { events: c.events.map(e => Object.assign({}, e)) }));
  return M.Convert.emitScore(cd, FPB, { tempoBpm: 120, totalFrames: TOTAL, cmd: M.Convert.normalizeCmd(Object.assign({ LOOP_DETECT: false }, cmd || {})) });
}
const linesOf = (mml) => mml.split('\n').filter(l => l && !l.startsWith(';'));
const sharedLines = (mml) => linesOf(mml).filter(l => /^[A-Za-z]{2,} (?!t\d)/.test(l));

// トラックごとの音符列(コンパイル結果 segmentsByChannel: 長さ・音程・音量)
function compiledNotes(mml) {
  const c = M.Mml.compile(mml);
  if (c.errors && c.errors.length) return { error: c.errors[0].message || String(c.errors[0]) };
  const out = {};
  for (const [letter, segs] of Object.entries(c.segmentsByChannel || {})) {
    if (!segs || !segs.length) continue;
    out[letter] = segs.map(s => [s.durationFrames, s.noteNumber, s.volume]);
  }
  return out;
}

// 1. off
{
  const mml = emit([chan('A', seq(melody, 12)), chan('B', seq(melody, 11))], { SHARE_LINES: 'off' });
  eq('off: no shared line', sharedLines(mml).length, 0);
}
// 2. auto: A/B 同じ音符列、音量違い(先頭の v だけ違う)
let mmlAuto, mmlOff;
{
  mmlOff = emit([chan('A', seq(melody, 12)), chan('B', seq(melody, 11))], { SHARE_LINES: 'off' });
  mmlAuto = emit([chan('A', seq(melody, 12)), chan('B', seq(melody, 11))], { SHARE_LINES: 'auto' });
  const sh = sharedLines(mmlAuto);
  eq('auto: shared lines exist', sh.length > 0, true);
  eq('auto: all shared lines are AB', sh.every(l => l.startsWith('AB ')), true);
  eq('auto: per-channel v lines', linesOf(mmlAuto).some(l => /^A v12/.test(l)) && linesOf(mmlAuto).some(l => /^B v11/.test(l)), true);
  eq('auto: header note', mmlAuto.includes('; 共通行:'), true);
}
// 3. オクターブ違い
{
  const mml = emit([chan('A', seq(melody, 12)), chan('B', seq(melody, 12, { oct: 12 }))], { SHARE_LINES: 'auto' });
  const ls = linesOf(mml);
  eq('octave: shared', sharedLines(mml).length > 0, true);
  eq('octave: separate o lines', ls.some(l => /^A o\d/.test(l)) && ls.some(l => /^B o\d/.test(l)), true);
}
// 4. 違う音符列は組に入らない
{
  const other = melody.map(([n, b]) => [n === null ? null : n + 3, b]);
  const mml = emit([chan('A', seq(melody, 12)), chan('B', seq(melody, 11)), chan('C', seq(other, 10))], { SHARE_LINES: 'auto' });
  const sh = sharedLines(mml);
  eq('C not in group', sh.every(l => l.startsWith('AB ')), true);
  eq('C has own lines', linesOf(mml).some(l => /^C /.test(l)), true);
}
// 5. 分ける行の上限: B の音量が毎音違う → auto では別行、always では共通行
{
  const vols = [12, 11, 10, 9, 8, 7, 6, 5];
  const chans = [chan('A', seq(melody, 12)), chan('B', seq(melody, vols))];
  const a = emit(chans, { SHARE_LINES: 'auto' });
  const b = emit(chans, { SHARE_LINES: 'always' });
  eq('density: auto falls back', sharedLines(a).length, 0);
  eq('density: always shares', sharedLines(b).length > 0, true);
}
// 6. コンパイル結果の一致(共通行 vs 従来)
{
  const a = compiledNotes(mmlOff), b = compiledNotes(mmlAuto);
  eq('compile: no error', [a.error, b.error], [undefined, undefined]);
  eq('compile: same tracks', Object.keys(a), Object.keys(b));
  eq('compile: same notes', a, b);
}

console.log(`share-lines: ok ${oks} / NG ${fails}`);
process.exit(fails ? 1 : 0);
