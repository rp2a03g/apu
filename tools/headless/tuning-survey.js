/*
 * 基準ピッチ(#TUNING)自動検出の調査 (ブラウザ不要)
 *
 *   node tools/headless/tuning-survey.js "song.kss" [--songs 0-15] [--sec 40]
 *   node tools/headless/tuning-survey.js "C:/corpus/kss" --sec 30      フォルダなら全ファイル(先頭曲)
 *
 * 各曲について検出結果(中央値/四分位範囲/音符数/適用値)と、適用した場合の D<n> の数を
 * 12平均律固定(TUNING=a440)と並べて出す。閾値の決め方や誤検出の点検用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { convertFile, expandInput, SONG_EXTS } = require('./convert.js');

function countD(mml) { return (mml.match(/(^|[^@A-Za-z])D-?\d+/g) || []).length; }

async function one(file, song, sec) {
  const auto = await convertFile(file, { song, seconds: sec, cmd: { TUNING: 'auto', TUNING_MIN: 0.5 } });
  const t = auto.tuning || {};
  let dAuto = countD(auto.mml || '');
  let dFix = dAuto;
  if (t.cents) {
    const fix = await convertFile(file, { song, seconds: sec, cmd: { TUNING: 'a440' } });
    dFix = countD(fix.mml || '');
  }
  const f = (v) => (v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(1));
  const groups = (t.byGroup || []).map((g) => `${g.group}${f(g.median)}(${g.count})`).join(' ');
  console.log(`${path.basename(file).slice(0, 40).padEnd(40)} #${String(song).padStart(3)}  median ${f(t.median).padStart(6)}  iqr ${(t.iqr == null ? '-' : t.iqr.toFixed(1)).padStart(5)}  n ${String(t.count || 0).padStart(5)}  applied ${f(t.cents).padStart(6)} ${(t.reason || 'ok').padEnd(5)} D: a440=${dFix} auto=${dAuto}  ${groups}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--'));
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const sec = parseFloat(flag('--sec', '40'));
  const songsArg = flag('--songs', null);
  let files = [];
  if (fs.statSync(target).isDirectory()) {
    files = fs.readdirSync(target).filter((n) => SONG_EXTS.includes(path.extname(n).toLowerCase().replace('.', ''))).map((n) => path.join(target, n));
  } else files = [target];
  for (const file of files) {
    let songs = [undefined];
    if (songsArg) {
      const m = songsArg.match(/^(\d+)-(\d+)$/);
      songs = m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => +m[1] + i) : songsArg.split(',').map(Number);
    }
    for (const s of songs) {
      try { await one(file, s, sec); }
      catch (e) { console.log(`${path.basename(file)} #${s}: ERROR ${e.message}`); }
    }
  }
}
main();
