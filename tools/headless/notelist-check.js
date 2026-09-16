/*
 * 楽譜出力用の音符列 compile().noteList の点検 (ブラウザ不要)
 *
 *   node tools/headless/notelist-check.js            組み込みサンプルMML + 固定ケースを点検
 *   node tools/headless/notelist-check.js song.mml   任意のMMLファイルも点検
 *   node tools/headless/notelist-check.js --dump     各chの先頭数音を表示
 *
 * 見るもの(ROADMAP「フェーズ外: 楽譜出力」段階1の受け入れ条件):
 *   1. 各chの noteList の frames 合計が、そのchのセグメント合計(=ループ複製前の曲長)と一致する
 *   2. テンポ一定のchでは ticks(480分解能の音価)から逆算したフレーム数が実フレームと±1以内
 *      (framesForLength の丸め+carry と同じ誤差範囲)
 *   3. タイ/連符/w/k/n<num>/PS/;@time/;@key の固定ケースが期待どおりの形で出る
 *
 * 終了コード: 不一致があれば1。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { load } = require('./load.js');

const FPS = 60.0988;

function preLoopLength(r) {
  // compile() の totalFrames はループ地点(L)がある場合に [L, end) を末尾へ複製した後の値。
  // noteList は複製しないので、複製前の長さに戻して比べる
  if (r.loopPointFrame == null) return r.totalFrames;
  return (r.totalFrames + r.loopPointFrame) / 2;
}

function checkSong(label, source, MML, opts) {
  const r = MML.Mml.compile(source, {});
  const problems = [];
  if (r.errors.length) problems.push(`コンパイルエラー ${r.errors.length}件: ${r.errors[0].message}`);
  const total = preLoopLength(r);
  let maxSum = 0;
  let noteCount = 0, tieCount = 0, tupletCount = 0, waitCount = 0, keyOffCount = 0;
  for (const ch of r.channelLetters) {
    const list = r.noteList[ch] || [];
    let sum = 0, cursor = 0;
    let tempoConst = true;
    const t0 = list.length ? list[0].tempo : null;
    for (const n of list) {
      if (n.startFrame !== cursor) problems.push(`${label} ${ch}: startFrame ${n.startFrame} != 累積 ${cursor}`);
      if (!(n.frames >= 1)) problems.push(`${label} ${ch}: frames が不正 ${n.frames}`);
      if (!(n.ticks > 0)) problems.push(`${label} ${ch}: ticks が不正 ${n.ticks}`);
      cursor += n.frames; sum += n.frames;
      if (n.tempo !== t0) tempoConst = false;
      noteCount++;
      if (n.joined) tieCount++;
      if (n.tuplet) tupletCount++;
      if (n.kind === 'wait') waitCount++;
      if (n.kind === 'keyOff') keyOffCount++;
    }
    if (list.length && tempoConst) {
      // 連符は個々の音符が丸められ最後の音符に余りが寄るので、連符の塊ごとにまとめて比べる
      const framesPerWhole = (240 / t0) * FPS;
      let carry = 0;
      let i = 0;
      while (i < list.length) {
        const n = list[i];
        if (n.tuplet) {
          let ticks = 0, frames = 0, j = i;
          while (j < list.length && list[j].tuplet && (j === i || list[j].tuplet.index > 0)) { ticks += list[j].ticks; frames += list[j].frames; j++; }
          const ideal = ticks / (MML.Mml.SCORE_TPQN * 4) * framesPerWhole;
          if (Math.abs(ideal - frames) > 1.0) problems.push(`${label} ${ch}: 連符 ${i}〜${j - 1} ticks=${ticks} 理論${ideal.toFixed(2)}f 実${frames}f`);
          i = j;
          continue;
        }
        const ideal = n.ticks / (MML.Mml.SCORE_TPQN * 4) * framesPerWhole + carry;
        const pred = Math.max(1, Math.round(ideal));
        if (Math.abs(ideal - n.frames) > 1.0) problems.push(`${label} ${ch}#${i}: ticks=${n.ticks} 理論${ideal.toFixed(2)}f 実${n.frames}f (${n.kind})`);
        carry = ideal - pred;
        i++;
      }
    }
    maxSum = Math.max(maxSum, sum);
    if (opts.dump && list.length) {
      console.log(`  ${ch}: ${list.length}音 tempo${t0}${tempoConst ? '' : '(可変)'}`);
      for (const n of list.slice(0, 8)) {
        const sp = n.spelled ? `${n.spelled.name}${n.spelled.accidental > 0 ? '+'.repeat(n.spelled.accidental) : '-'.repeat(-n.spelled.accidental)}o${n.spelled.octave}` : '-';
        console.log(`     f${n.startFrame}+${n.frames} ${n.kind} note=${n.note} len=${n.len.n}${'.'.repeat(n.len.dots)}${n.tuplet ? ` tup${n.tuplet.count}[${n.tuplet.index}]` : ''} ticks=${n.ticks} ${n.joined ? 'joined ' : ''}${n.glide ? 'glide ' : ''}${sp}`);
      }
    }
  }
  if (maxSum !== total) problems.push(`${label}: noteList の最長ch合計 ${maxSum} != 曲長(ループ複製前) ${total}`);
  console.log(`${label}: ${r.channelLetters.length}ch 音符${noteCount} タイ/延長${tieCount} 連符${tupletCount} w${waitCount} k${keyOffCount} 曲長${total}f ` +
    `time=${r.score.time ? r.score.time.beats + '/' + r.score.time.beatType : 'なし'} key=${r.score.key ? r.score.key.fifths : 'なし'} 警告${r.warnings.length}`);
  return { r, problems };
}

// 固定ケース: 期待する形を直接照合する
function fixedCases(MML) {
  const problems = [];
  const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  let r;

  // 音価/付点/l<n>省略/休符
  r = MML.Mml.compile('A t120 l8 o4 c4 d e. r16 f2', {});
  eq('lengths', r.noteList.A.map(n => [n.kind, n.note, n.len.n, n.len.dots, n.ticks]),
    [['note', 48, 4, 0, 480], ['note', 50, 8, 0, 240], ['note', 52, 8, 1, 360], ['note', null, 16, 0, 120], ['note', 53, 2, 0, 960]]);

  // タイ(同音程)とレガート(異音程)、両方 joined。segments 側は併合されるが noteList は2要素
  r = MML.Mml.compile('A o4 c4&c8 d4&e8', {});
  eq('tie joined', r.noteList.A.map(n => [n.note, n.joined]), [[48, false], [48, true], [50, false], [52, true]]);
  eq('tie segments merged', r.highlightRanges.A.length, 2);

  // 連符: {ceg}4 = 三連八分(各160tick)。フレームは合計で四分音符ぶん
  r = MML.Mml.compile('A t120 o4 {ceg}4 c4', {});
  eq('tuplet', r.noteList.A.slice(0, 3).map(n => [n.tuplet.count, n.tuplet.index, n.ticks, n.len.n]), [[3, 0, 160, 4], [3, 1, 160, 4], [3, 2, 160, 4]]);
  eq('tuplet frames sum', r.noteList.A.slice(0, 3).reduce((a, n) => a + n.frames, 0), r.noteList.A[3].frames);

  // w(延長=joined、音程は直前の音)とk(リリース=休符扱い)
  r = MML.Mml.compile('A o4 c4 w4 d4 k4 r4 w4', {});
  eq('wait/keyoff', r.noteList.A.map(n => [n.kind, n.note, n.joined]),
    [['note', 48, false], ['wait', 48, true], ['note', 50, false], ['keyOff', null, false], ['note', null, false], ['wait', null, true]]);

  // n<num>(spelled無し)と PS(glide)
  r = MML.Mml.compile('A o4 n24 c PS g', {});
  eq('directNote', [r.noteList.A[0].note, r.noteList.A[0].spelled], [48, null]);
  eq('glide', r.noteList.A.map(n => n.glide), [false, false, true]);

  // 書かれた綴り(異名同音の手がかり)と移調
  r = MML.Mml.compile('A o4 c+ d- K2 e-', {});
  eq('spelled', r.noteList.A.map(n => [n.note, n.spelled.name, n.spelled.accidental, n.spelled.transpose]),
    [[49, 'c', 1, 0], [49, 'd', -1, 0], [53, 'e', -1, 2]]);

  // ループ展開: 書かれたとおり複製される。L(ループ地点)では複製しない
  r = MML.Mml.compile('A o4 [c4 d4]2 L e4', {});
  eq('loop expand', r.noteList.A.map(n => n.note), [48, 50, 48, 50, 52]);
  eq('L not duplicated', r.noteList.A.reduce((a, n) => a + n.frames, 0), (r.totalFrames + r.loopPointFrame) / 2);

  // テンポ変化の記録
  r = MML.Mml.compile('A t120 o4 c4 t90 d4', {});
  eq('tempo per note', r.noteList.A.map(n => n.tempo), [120, 90]);

  // ;@time / ;@key: 最初の1回、無効値は警告
  r = MML.Mml.compile(';@time 3/4\n;@key -1\n;@time 6/8\nA c4', {});
  eq('score directives', r.score, { time: { beats: 3, beatType: 4 }, key: { fifths: -1 } });
  eq('score no warnings', r.warnings.length, 0);
  r = MML.Mml.compile(';@time 3/5\n;@key 9\nA c4', {});
  eq('score invalid', [r.score.time, r.score.key, r.warnings.length, r.errors.length], [null, null, 2, 0]);
  r = MML.Mml.compile('A c4', {});
  eq('score absent', r.score, { time: null, key: null });

  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const dump = argv.includes('--dump');
  const files = argv.filter(a => !a.startsWith('--'));
  const g = load();
  const MML = global.MML || g.MML;

  let problems = fixedCases(MML);
  console.log(`固定ケース: ${problems.length ? problems.length + '件不一致' : 'すべて一致'}`);

  const songs = [['sample', MML.Mml.SAMPLE_SOURCE]];
  for (const f of files) songs.push([path.basename(f), fs.readFileSync(f, 'utf8')]);
  for (const [label, src] of songs) {
    const res = checkSong(label, src, MML, { dump });
    problems = problems.concat(res.problems);
  }
  for (const p of problems) console.log('  NG ' + p);
  console.log(problems.length ? `不一致 ${problems.length}件` : 'OK');
  process.exit(problems.length ? 1 : 0);
}

main();
