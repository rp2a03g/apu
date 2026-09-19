/*
 * 楽譜の表記モデル(src/score/notation.js)と MusicXML 書き出し(src/score/musicxml.js)の点検 (ブラウザ不要)
 *
 *   node tools/headless/score-check.js                 固定ケース + 組み込みサンプルMML
 *   node tools/headless/score-check.js song.mml        任意のMMLファイルも点検
 *   node tools/headless/score-check.js --out DIR       点検した曲の .musicxml を DIR に書く(MuseScore/ブラウザで開く用)
 *
 * 見るもの(作業計画「フェーズ外: 楽譜出力」段階2の受け入れ条件):
 *   1. 各小節の音価合計が拍子どおり(units)。全休符小節は1個の小節休符
 *   2. 音符ごとの合計 units が noteList の音価と厳密一致(見栄えで音を動かしていない)
 *   3. タイ/スラー/連符/連桁の start/stop が対になっている。タイは同じ音高同士
 *   4. MusicXML がタグの対応が取れている(簡易パーサ)。要素の並びがスキーマ順
 *   5. 固定ケース: 小節線またぎのタイ分割、3/4・5/8拍子、連符、付点、綴り、調の推定、テンポ変化
 *
 * 終了コード: 不一致があれば1。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { load } = require('./load.js');

function checkXmlWellFormed(xml) {
  const problems = [];
  const stack = [];
  const re = /<\?[^]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)(\s[^>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('<?') || m[0].startsWith('<!')) continue;
    if (m[1]) { const top = stack.pop(); if (top !== m[1]) problems.push(`閉じタグ不一致 </${m[1]}> (開いているのは <${top}>)`); }
    else if (!m[4]) stack.push(m[2]);
  }
  if (stack.length) problems.push(`閉じていないタグ: ${stack.join(',')}`);
  // 「<」がタグ以外に残っていないか(エスケープ漏れ)
  const stripped = xml.replace(re, '');
  if (/[<>]/.test(stripped.replace(/&lt;|&gt;/g, ''))) problems.push('タグ以外に < > が残っている(エスケープ漏れ)');
  return problems;
}

// note 要素の子要素がスキーマ順か(pitch/unpitched/rest, duration, tie, voice, type, dot, accidental, time-modification, beam, notations)
function checkNoteOrder(xml) {
  const ORDER = ['chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'instrument', 'voice', 'type', 'dot', 'accidental', 'time-modification', 'staff', 'beam', 'notations'];
  const problems = [];
  const re = /<note>([^]*?)<\/note>/g;
  let m, count = 0;
  while ((m = re.exec(xml))) {
    count++;
    const kids = [...m[1].matchAll(/^\s{8}<([a-z-]+)/gm)].map(x => x[1]);
    let last = -1;
    for (const k of kids) {
      const i = ORDER.indexOf(k);
      if (i < 0) { problems.push(`note の子要素が想定外: ${k}`); continue; }
      if (i < last) { problems.push(`note の子要素の順序違反: ${kids.join(',')}`); break; }
      last = i;
    }
    if (problems.length > 5) break;
  }
  return { problems, count };
}

function checkNotation(label, compiled, notation, MML) {
  const problems = [];
  const U = notation.units;
  const measureUnits = notation.time.beats * U / notation.time.beatType;
  for (const part of notation.parts) {
    const list = part.group ? null : (compiled.noteList[part.letter] || []);
    const perNote = new Map();
    let tieOpen = null, slurOpen = 0, tupOpen = 0;
    let tieChordOpen = new Set();
    let total = 0;
    for (const measure of part.measures) {
      let sum = 0;
      const beamOpen = [];
      for (const it of measure.items) {
        sum += it.dur; total += it.dur;
        if (!it.measureRest) perNote.set(it.noteIndex, (perNote.get(it.noteIndex) || 0) + it.dur);
        else {
          // 小節休符: その小節に重なる休符の units を按分せず、後で「休符は合計だけ」で見る
        }
        if (it.tieStop && !it.chord) {
          if (!tieOpen) problems.push(`${label} ${part.letter} m${measure.number}: タイの終点だけがある`);
          else if (tieOpen.note !== it.note) problems.push(`${label} ${part.letter} m${measure.number}: タイの両端の音高が違う ${tieOpen.note}→${it.note}`);
          tieOpen = null;
        }
        if (it.tieStart && !it.chord) { if (tieOpen) problems.push(`${label} ${part.letter} m${measure.number}: タイが二重に開いた`); tieOpen = { note: it.note }; }
        if (it.slurStop) { if (slurOpen <= 0) problems.push(`${label} ${part.letter} m${measure.number}: スラーの終点だけがある`); else slurOpen--; }
        if (it.slurStart) slurOpen++;
        if (it.tuplet) {
          if (it.tuplet.start) { if (tupOpen) problems.push(`${label} ${part.letter} m${measure.number}: 連符が二重に開いた`); tupOpen = 1; }
          else if (!tupOpen) problems.push(`${label} ${part.letter} m${measure.number}: 連符括弧の外に連符音符`);
          if (it.tuplet.stop) tupOpen = 0;
        } else if (tupOpen) problems.push(`${label} ${part.letter} m${measure.number}: 連符が閉じないまま通常音符`);
        it.beams.forEach((b, lv) => {
          if (b === 'begin') { if (beamOpen[lv]) problems.push(`${label} ${part.letter} m${measure.number}: 連桁${lv + 1}が二重に始まった`); beamOpen[lv] = true; }
          else if (b === 'continue' || b === 'end') { if (!beamOpen[lv]) problems.push(`${label} ${part.letter} m${measure.number}: 連桁${lv + 1}が始まっていない`); if (b === 'end') beamOpen[lv] = false; }
        });
        if (!it.rest && !part.percussion && it.chord) {
          for (const cn of it.chord) {
            const pc = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[cn.pitch.step] + cn.pitch.alter;
            if (cn.pitch.octave * 12 + pc !== cn.note) problems.push(`${label} ${part.letter} m${measure.number}: 和音の綴りが音高と合わない`);
            if (cn.tieStop && !tieChordOpen.has(cn.note)) problems.push(`${label} ${part.letter} m${measure.number}: 和音のタイの終点だけがある ${cn.note}`);
          }
          tieChordOpen = new Set(it.chord.filter(cn => cn.tieStart).map(cn => cn.note));
        }
        if (!it.rest && !part.percussion) {
          const p = it.pitch;
          const pc = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[p.step] + p.alter;
          if (p.octave * 12 + pc !== it.note) problems.push(`${label} ${part.letter} m${measure.number}: 綴りが音高と合わない ${p.step}${p.alter}${p.octave} != ${it.note}`);
        }
      }
      if (sum !== measureUnits) problems.push(`${label} ${part.letter} m${measure.number}: 小節の合計 ${sum} != ${measureUnits}`);
      if (beamOpen.some(Boolean)) problems.push(`${label} ${part.letter} m${measure.number}: 連桁が閉じていない`);
      if (tupOpen) { problems.push(`${label} ${part.letter} m${measure.number}: 連符が小節をまたいだ`); tupOpen = 0; }
    }
    if (tieOpen) problems.push(`${label} ${part.letter}: タイが閉じていない`);
    if (slurOpen) problems.push(`${label} ${part.letter}: スラーが閉じていない(${slurOpen})`);
    // 音符ごとの合計(休符は小節休符に併合されるので音符だけ厳密に見る)。曲全体の合計は最終小節の埋めぶんを除いて一致
    let noteUnitsTotal = 0;
    (list || []).forEach((n, idx) => {
      const want = ((Math.pow(2, n.len.dots + 1) - 1) * U) / (Math.pow(2, n.len.dots) * n.len.n * (n.tuplet ? n.tuplet.count : 1));
      noteUnitsTotal += want;
      if (n.note == null || n.kind === 'keyOff') return;
      const got = perNote.get(idx);
      if (got == null) { problems.push(`${label} ${part.letter} #${idx}: 音符が譜面に出ていない`); return; }
      if (Math.abs(got - want) > 1e-9) problems.push(`${label} ${part.letter} #${idx}: 音価 ${got} != ${want}`);
    });
    const lastFill = Math.ceil(noteUnitsTotal / measureUnits) * measureUnits;
    if (list && total < lastFill || total % measureUnits !== 0) problems.push(`${label} ${part.letter}: 譜面の合計 ${total} が曲長 ${noteUnitsTotal}(小節埋め ${lastFill})と合わない`);
  }
  const counts = notation.parts.map(p => p.measures.length);
  if (counts.some(c => c !== counts[0])) problems.push(`${label}: パート間で小節数が違う ${counts.join(',')}`);
  return problems;
}

function runSong(label, source, MML, outDir, piano) {
  const compiled = MML.Mml.compile(source, {});
  let problems = [];
  if (compiled.errors.length) { problems.push(`${label}: コンパイルエラー ${compiled.errors[0].message}`); return { problems }; }
  let notation, xml;
  try {
    notation = piano ? MML.Score.buildPianoNotation(compiled, {}) : MML.Score.buildNotation(compiled, {});
    xml = MML.Score.toMusicXML(notation, { date: '2026-09-16' });
  } catch (e) { problems.push(`${label}: 例外 ${e.stack || e}`); return { problems }; }
  problems = problems.concat(checkNotation(label, compiled, notation, MML));
  problems = problems.concat(checkXmlWellFormed(xml).map(p => `${label}: ${p}`));
  const order = checkNoteOrder(xml);
  problems = problems.concat(order.problems.map(p => `${label}: ${p}`));
  const measures = notation.parts.length ? Math.max(...notation.parts.map(p => p.measures.length)) : 0;
  console.log(`${label}: ${notation.parts.length}パート ${measures}小節 U=${notation.units} 拍子${notation.time.beats}/${notation.time.beatType} 調号${notation.key.fifths}${notation.key.estimated ? '(推定 ' + notation.key.mode + ')' : ''} note要素${order.count} ${(xml.length / 1024).toFixed(0)}KB`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, label.replace(/[^\w.-]+/g, '_') + '.musicxml');
    fs.writeFileSync(f, xml);
    console.log(`  → ${f}`);
  }
  return { problems, notation, xml, compiled };
}

function fixedCases(MML) {
  const problems = [];
  const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  const build = (src) => MML.Score.buildNotation(MML.Mml.compile(src, {}), {});
  const flat = (n, letter) => { const p = n.parts.find(p => p.letter === letter); return p.measures.flatMap(m => m.items.map(it => [m.number, it.rest ? 'r' : it.pitch.step + (it.pitch.alter || '') + it.pitch.octave, it.noteType, it.dots, it.tieStart ? 'T' : '', it.tieStop ? 't' : '', it.tuplet ? `${it.tuplet.actual}:${it.tuplet.normal}${it.tuplet.start ? 's' : ''}${it.tuplet.stop ? 'e' : ''}` : ''])); };

  // 小節線をまたぐ音はタイで分割(4/4: 全音符, 2分, 全音符 → 2小節目の後半から3小節目前半)
  let n = build(';@key 0\nA o4 c1 c2 c1');
  eq('measure split', flat(n, 'A'), [[1, 'C4', 1, 0, '', '', ''], [2, 'C4', 2, 0, '', '', ''], [2, 'C4', 2, 0, 'T', '', ''], [3, 'C4', 2, 0, '', 't', ''], [3, 'r', 2, 0, '', '', '']]);
  // 3/4: 全音符 → 付点2分 + 4分(タイ)
  n = build(';@time 3/4\n;@key 0\nA o4 c1');
  eq('3/4 whole', flat(n, 'A'), [[1, 'C4', 2, 1, 'T', '', ''], [2, 'C4', 4, 0, '', 't', ''], [2, 'r', 2, 0, '', '', '']]);
  eq('3/4 divisions', [n.units, n.divisions], [4, 1]);
  // 5/8: c4 c2 → 2小節目へ 1/8 だけはみ出す(付点4分+8分)
  n = build(';@time 5/8\n;@key 0\nA o4 c4 c2');
  eq('5/8', flat(n, 'A'), [[1, 'C4', 4, 0, '', '', ''], [1, 'C4', 4, 1, 'T', '', ''], [2, 'C4', 8, 0, '', 't', ''], [2, 'r', 2, 0, '', '', '']]);
  // 連符: {ceg}4 → 3連8分(3:2)、括弧は3つで閉じる。l12 も同じ
  n = build(';@key 0\nA o4 {ceg}4 c12 e12 g12 c2');
  eq('triplets', flat(n, 'A').slice(0, 6).map(x => [x[1], x[2], x[6]]), [['C4', 8, '3:2s'], ['E4', 8, '3:2'], ['G4', 8, '3:2e'], ['C4', 8, '3:2s'], ['E4', 8, '3:2'], ['G4', 8, '3:2e']]);
  // 5連符(4分を5等分 = 16分の5:4)
  n = build(';@key 0\nA o4 {cdefg}4');
  eq('quintuplet', flat(n, 'A').slice(0, 5).map(x => [x[2], x[6]]), [[16, '5:4s'], [16, '5:4'], [16, '5:4'], [16, '5:4'], [16, '5:4e']]);
  // 付点・2重付点・w(延長はタイ)
  n = build(';@key 0\nA o4 c4. c8 c4.. c16 c4 w4');
  eq('dots/wait', flat(n, 'A').filter(x => x[1] !== 'r').map(x => [x[2], x[3], x[4], x[5]]), [[4, 1, '', ''], [8, 0, '', ''], [4, 2, '', ''], [16, 0, '', ''], [4, 0, 'T', ''], [4, 0, '', 't']]);
  // 綴り: 調の音階 > 書かれた綴り > 既定。ヘ長調(-1)の a+ は Bb、ハ長調の d- は Db、c+ は C#
  n = build(';@key -1\nA o4 a+4 b-4');
  eq('spell key F', flat(n, 'A').filter(x => x[1] !== 'r').map(x => x[1]), ['B-14', 'B-14']);
  n = build(';@key 0\nA o4 d-4 c+4 K2 c4');
  eq('spell hint', flat(n, 'A').filter(x => x[1] !== 'r').map(x => x[1]), ['D-14', 'C14', 'D4']);
  // 臨時記号: 小節内で有効、タイの続きには付けない。調号の音には付けない
  n = build(';@key 1\nA o4 f4 f4 f+4 f4');
  eq('accidentals', n.parts[0].measures[0].items.map(it => it.accidental), ['natural', null, 'sharp', 'natural']);
  // 調の推定: イ短調の音階 → fifths 0 minor、ト長調 → 1 major
  n = build('A o4 a2 b2 c2 d2 e2 f2 g+2 a1 a1 e1');
  eq('estimate a minor', [n.key.fifths, n.key.mode, n.key.estimated], [0, 'minor', true]);
  n = build('A o4 g2 a2 b2 c2 d2 e2 f+2 g1 g1 d1 b1');
  eq('estimate G major', [n.key.fifths, n.key.mode], [1, 'major']);
  // 全休符の小節は小節休符1個。テンポは曲頭と変化点だけ
  n = build(';@key 0\nA t120 o4 c1 r1 t90 c1');
  eq('measure rest', n.parts[0].measures.map(m => [m.measureRest, m.items.length, m.items[0].tempo]), [[false, 1, 120], [true, 1, null], [false, 1, 90]]);
  // 打楽器(ノイズ ch)は unpitched + パーカッション記号。レガート(異音程の&)はスラー、PS もスラー
  n = build(';@key 0\nA o4 c4&d4 c4 PS e4\nD o1 c8 d8');
  const A = n.parts.find(p => p.letter === 'A').measures[0].items;
  eq('slur', A.map(it => [it.slurStart, it.slurStop, it.tieStart, it.tieStop]), [[true, false, false, false], [false, true, false, false], [true, false, false, false], [false, true, false, false]]);
  const D = n.parts.find(p => p.letter === 'D');
  eq('percussion', [D.clef.sign, D.measures[0].items[0].unpitched != null, D.measures[0].items[0].pitch], ['percussion', true, null]);
  // 連桁: 4/4 で 8分×4 → 拍ごとに2つずつ。16分は2段目
  n = build(';@key 0\nA o4 c8 d8 e8 f8 g16 a16 b16 c16 r2');
  eq('beams', n.parts[0].measures[0].items.map(it => it.beams.join('/')), ['begin', 'end', 'begin', 'end', 'begin/begin', 'continue/continue', 'continue/continue', 'end/end', '']);

  // ── ピアノ2段(段階5) ──
  const piano = (src) => MML.Score.buildPianoNotation(MML.Mml.compile(src, {}), {});
  const chords = (n, L) => n.parts.find(p => p.letter === L).measures.flatMap(m => m.items.map(it => it.rest ? 'r' + it.noteType
    : (it.chord ? '[' + it.chord.map(cn => cn.note + (cn.tieStop ? 't' : '') + (cn.tieStart ? 'T' : '')).join(',') + ']' : String(it.note)) + it.noteType));
  // 2声の和音化: A(メロディ=右手)+B(中央値≥C4=右手)+C(ベース=左手)
  n = piano(';@key 0\nA o4 c4 e4 g4 c4\nB o4 e4 g4 b4 e4\nC o3 c1');
  eq('piano assign', [n.piano.rh, n.piano.lh], [['A', 'B'], ['C']]);
  eq('piano RH chords', chords(n, 'RH'), ['[48,52]4', '[52,55]4', '[55,59]4', '[48,52]4']);
  eq('piano LH', chords(n, 'LH'), ['[36]1']);
  eq('piano clefs', n.parts.map(p => p.clef.sign), ['G', 'F']);
  // 鳴り続ける音はタイ、打ち直しは新しい和音
  n = piano(';@key 0\nA o4 c2 c2\nB o4 e1\nC o2 c1');
  eq('piano tie', chords(n, 'RH'), ['[48,52T]2', '[48,52t]2']);
  // 保持音の上でメロディが動く: 保持音は小節の中で毎回タイ
  n = piano(';@key 0\nA o5 c8 d8 e8 f8 g2\nB o4 c2 r2\nC o2 c1');
  eq('piano held', chords(n, 'RH'), ['[48T,60]8', '[48tT,62]8', '[48tT,64]8', '[48t,65]8', '[67]2']);
  // 打楽器は別段でそのまま
  n = piano(';@key 0\nA o4 c1\nC o2 c1\nD o1 c8 c8 r2.');
  eq('piano percussion kept', n.parts.map(p => p.letter), ['RH', 'LH', 'D']);
  // MusicXML: 1パート2段(staves=2、backup)、和音の2音目に <chord/>
  const px = MML.Score.toMusicXML(piano(';@key 0\nA o4 c4 e4 g4 c4\nB o4 e4 g4 b4 e4\nC o3 c1'), { date: '2026-09-16' });
  eq('piano xml staves', (px.match(/<staves>2<\/staves>/g) || []).length, 1);
  eq('piano xml backup', (px.match(/<backup>/g) || []).length, 1);
  eq('piano xml chord', (px.match(/<chord\/>/g) || []).length, 4);
  eq('piano xml parts', (px.match(/<part id=/g) || []).length, 1);
  eq('piano xml staff2', (px.match(/<staff>2<\/staff>/g) || []).length, 1);
  problems.push(...checkXmlWellFormed(px).map(p => 'piano xml: ' + p));
  problems.push(...checkNoteOrder(px).problems.map(p => 'piano xml: ' + p));
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;
  const files = argv.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  const g = load();
  const MML = global.MML || g.MML;

  let problems = fixedCases(MML);
  console.log(`固定ケース: ${problems.length ? problems.length + '件不一致' : 'すべて一致'}`);
  const songs = [['sample', MML.Mml.SAMPLE_SOURCE]];
  for (const f of files) songs.push([path.basename(f, path.extname(f)), fs.readFileSync(f, 'utf8')]);
  for (const [label, src] of songs) problems = problems.concat(runSong(label, src, MML, outDir).problems);
  for (const [label, src] of songs) problems = problems.concat(runSong(label + '-piano', src, MML, outDir, true).problems);
  for (const p of problems) console.log('  NG ' + p);
  console.log(problems.length ? `不一致 ${problems.length}件` : 'OK');
  process.exit(problems.length ? 1 : 0);
}

main();
