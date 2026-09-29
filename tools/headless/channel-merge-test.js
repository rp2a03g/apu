/*
 * 「まとめる」(src/convert/channelMerge.js)の単体テスト。合成したイベント列で規則を確かめる:
 *   1. 交互 … 2chが11フレームずつずれて22フレームの音を鳴らす → 全音を拾い、各音は次の音で切られる
 *   2. 順繰り3ch+隙間 … 隙間は休符で埋まり、被覆は連続する。タイ候補は別chが直前なら外す
 *   3. 重ね(1フレーム差) … 「同時」として片方(音量の小さい方)を捨て、大半が同時なら注記に重ねの疑い
 *   4. 内包 … 長い音の中で短い音が鳴ったら、長い音の残りは捨てる
 *   5. 余韻判定 … 切った時点の音量がピークの25%以下なら quietCut
 * 使い方: node tools/headless/channel-merge-test.js   (NGがあれば exit 1)
 */
'use strict';
const { ctx } = require('./convert');

const M = ctx();
const CM = M.Convert.ChannelMerge;
let fails = 0, oks = 0;
function eq(name, a, b) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`NG ${name}: got ${ja} expected ${jb}`); } else { oks++; }
}
const note = (start, end, n, vol, extra) => Object.assign({ start, end, note: n, volSeq: Array.from({ length: end - start }, () => vol) }, extra || {});
const notesOf = (r) => r.events.filter(e => e.note !== null).map(e => [e.start, e.end, e.note]);
const covered = (r) => r.events.every((e, i) => i === 0 || r.events[i - 1].end === e.start);

// 1. 交互
{
  const A = [note(0, 22, 60, 100), note(22, 44, 62, 100)];
  const B = [note(11, 33, 61, 100), note(33, 55, 63, 100)];
  const r = CM.merge([{ events: A }, { events: B }]);
  eq('alt notes', notesOf(r), [[0, 11, 60], [11, 22, 61], [22, 33, 62], [33, 55, 63]]);
  eq('alt stats', [r.stats.notes, r.stats.cut, r.stats.dropped], [4, 3, 0]);
  eq('alt volSeq trimmed', r.events[0].volSeq.length, 11);
  eq('alt covered', covered(r), true);
  eq('alt perMember', r.stats.perMember, [2, 2]);
}
// 2. 順繰り3ch+隙間+タイ候補
{
  const A = [note(0, 30, 60, 100), note(90, 100, 66, 100, { tieCandidate: true })];
  const B = [note(10, 40, 62, 100)];
  const C = [note(20, 50, 64, 100), note(50, 60, 65, 100, { tieCandidate: true })];
  const r = CM.merge([{ events: A }, { events: B }, { events: C }]);
  eq('rr notes', notesOf(r), [[0, 10, 60], [10, 20, 62], [20, 50, 64], [50, 60, 65], [90, 100, 66]]);
  eq('rr rest gap', r.events.filter(e => e.note === null).map(e => [e.start, e.end]), [[60, 90]]);
  eq('rr covered', covered(r), true);
  const tied = r.events.filter(e => e.note !== null).map(e => !!e.tieCandidate);
  eq('rr tie kept only within same member', tied, [false, false, false, true, false]);
}
// 3. 重ね(1フレーム差、音量違い)
{
  const A = [note(0, 20, 60, 80), note(40, 60, 62, 80)];
  const B = [note(1, 21, 60, 100), note(41, 61, 62, 100)];
  const r = CM.merge([{ events: A }, { events: B }]);
  eq('double notes (louder wins, own end kept)', notesOf(r), [[1, 21, 60], [41, 61, 62]]);
  eq('double dropped', r.stats.dropped, 2);
  const text = CM.describe('V4+V7', 'n163_0', r.stats);
  eq('double hint in note', /重ね\(デチューン\)/.test(text), true);
}
// 4. 内包
{
  const A = [note(0, 100, 48, 100)];
  const B = [note(30, 40, 72, 100)];
  const r = CM.merge([{ events: A }, { events: B }]);
  eq('nested notes', notesOf(r), [[0, 30, 48], [30, 40, 72]]);
  eq('nested trailing rest', r.events[r.events.length - 1], { start: 40, end: 100, note: null });
}
// 5. 余韻判定
{
  const decay = (start, end, n) => ({ start, end, note: n, volSeq: Array.from({ length: end - start }, (_, i) => Math.max(0, 100 - i * 10)) });
  const A = [decay(0, 20, 60)];
  const B = [decay(9, 29, 62)]; // 9フレーム目の音量は 10(ピーク100の10%) → 余韻
  const r = CM.merge([{ events: A }, { events: B }]);
  eq('quiet cut', [r.stats.cut, r.stats.quietCut], [1, 1]);
  const A2 = [decay(0, 20, 60)];
  const B2 = [decay(3, 23, 62)]; // 3フレーム目は 70% → 実音
  const r2 = CM.merge([{ events: A2 }, { events: B2 }]);
  eq('loud cut', [r2.stats.cut, r2.stats.quietCut], [1, 0]);
}
// 6. 空/1本
{
  const r = CM.merge([{ events: [] }, { events: [note(5, 10, 60, 100)] }]);
  eq('single member passthrough', notesOf(r), [[5, 10, 60]]);
  eq('empty', CM.merge([{ events: [] }]).events, []);
}

console.log(`channel-merge: ok ${oks} / NG ${fails}`);
process.exit(fails ? 1 : 0);
