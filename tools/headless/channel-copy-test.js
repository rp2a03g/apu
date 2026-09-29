/*
 * 「複製」(src/convert/channelCopy.js)の単体テスト。合成したイベント列で加工の規則を確かめる:
 *   1. 移調 … 音符番号が動き、周波数の項目(freqHz/rawFreq/freqSeq)は同じ比で動く。ノイズ音符(non)は動かない
 *   2. デチューン … 音符はそのまま、周波数だけが比で動く
 *   3. 遅延(連続被覆形式) … 頭に休符が足され、曲末を越えた分は切られ、フレーム列も詰まる
 *   4. SPC 形式({frame,len,pitch/pitchSeq}) … pitch は整数のまま比で動き、遅延で frame が動き曲末で切れる
 *   5. 元の列を壊さない
 * 使い方: node tools/headless/channel-copy-test.js   (NGがあれば exit 1)
 */
'use strict';
const { ctx } = require('./convert');

const M = ctx();
const CC = M.Convert.ChannelCopy;
let fails = 0, oks = 0;
function eq(name, a, b) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`NG ${name}: got ${ja} expected ${jb}`); } else { oks++; }
}
function near(name, a, b, tol) {
  if (Math.abs(a - b) > (tol || 1e-6)) { fails++; console.log(`NG ${name}: got ${a} expected ${b}`); } else { oks++; }
}

// 1. 移調
{
  const ev = [{ start: 0, end: 10, note: 60, freqHz: 440, rawFreq: 441, freqSeq: [440, 442], volSeq: Array(10).fill(9) },
    { start: 10, end: 20, note: null }, { start: 20, end: 30, note: 5, non: true, freqHz: 100 }];
  const out = CC.transform(ev, { transpose: 12 }, CC.GENERIC);
  eq('transpose note', out.map(e => e.note), [72, null, 5]);
  near('transpose freqHz', out[0].freqHz, 880);
  near('transpose rawFreq', out[0].rawFreq, 882);
  near('transpose freqSeq', out[0].freqSeq[1], 884);
  near('noise untouched', out[2].freqHz, 100);
  eq('original untouched', ev[0].note, 60);
}
// 2. デチューン
{
  const out = CC.transform([{ start: 0, end: 10, note: 60, freqHz: 440 }], { detune: 100 }, CC.GENERIC);
  eq('detune note', out[0].note, 60);
  near('detune freq (100 cents = 1 semitone)', out[0].freqHz, 440 * Math.pow(2, 1 / 12), 1e-6);
}
// 3. 遅延(連続被覆)
{
  const ev = [{ start: 0, end: 10, note: 60, volSeq: Array(10).fill(1) }, { start: 10, end: 20, note: null }, { start: 20, end: 30, note: 62, volSeq: Array(10).fill(2) }];
  const out = CC.transform(ev, { delay: 15, totalFrames: 30 }, CC.GENERIC);
  eq('delay leading rest', out[0], { start: 0, end: 15, note: null });
  eq('delay shifted', out.slice(1).map(e => [e.start, e.end, e.note]), [[15, 25, 60], [25, 30, null]]);
  eq('delay past end dropped', out.length, 3);
  const out2 = CC.transform(ev, { delay: 5, totalFrames: 30 }, CC.GENERIC);
  eq('delay truncated last', out2[out2.length - 1], Object.assign({ start: 25, end: 30, note: 62 }, { volSeq: Array(5).fill(2) }));
}
// 4. SPC 形式
{
  const ev = [{ frame: 0, len: 10, pitchSemi: 60, pitch: 4096, pitchSeq: [4096, 4100], rawFreq: 440, volSeq: Array(10).fill(3) },
    { frame: 20, len: 10, pitchSemi: 62, pitch: 4600, pitchSeq: [4600], rawFreq: 494 }];
  const out = CC.transform(ev, { transpose: -12, delay: 25, totalFrames: 30 }, CC.SPC);
  eq('spc count (2nd dropped: 20+25>=30)', out.length, 1);
  eq('spc frame/len', [out[0].frame, out[0].len], [25, 5]);
  eq('spc volSeq trimmed', out[0].volSeq.length, 5);
  eq('spc pitchSemi', out[0].pitchSemi, 48);
  eq('spc pitch int', [out[0].pitch, out[0].pitchSeq[0]], [2048, 2048]);
  near('spc rawFreq', out[0].rawFreq, 220);
}
// 5. 何も指定しなければ写しだけ
{
  const ev = [{ start: 0, end: 10, note: 60, freqHz: 440 }];
  const out = CC.transform(ev, {}, CC.GENERIC);
  eq('plain copy', out, ev);
  eq('plain copy is a new object', out[0] !== ev[0], true);
  eq('label', CC.label('V0', 'V0#2'), 'V0 ⧉2');
  eq('parseId', CC.parseId('opm:0#3'), { of: 'opm:0', n: 3 });
}

console.log(`channel-copy: ok ${oks} / NG ${fails}`);
process.exit(fails ? 1 : 0);
