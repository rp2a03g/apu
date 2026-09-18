/*
 * 組み込みサンプルMML(src/mml/sampleMml.js)の各章を「順番に」鳴らすための待ち行を計算する
 *
 *   node tools/headless/sample-sequence.js            点検(待ち行が最新か・章どうしが重なっていないか)
 *   node tools/headless/sample-sequence.js --write    待ち行を計算し直して sampleMml.js へ書き込む
 *
 * なぜ要るか: サンプルは「章ごとに担当チャンネルがコマンドを実演する」構成なので、そのまま再生すると
 * 全パートが頭から一斉に鳴る。ヘルプの項目別再生は項目の行だけを鳴らすので困らないが、エディタで
 * サンプルをそのまま再生すると聴けたものではない(2026-09-19、ユーザー指摘)。
 * コメント指示やツール側の特別扱いで順番に鳴らすと「MMLに書いてある通りに鳴る」が崩れる(本家ppmckcや
 * NSF書き出しと食い違う)ので、素直に各章の先頭へ休符の待ち行を置く:
 *
 *   GHIJKL [r1]41 ; ←順番待ち(自動生成: tools/headless/sample-sequence.js)
 *
 * ・待ちは章(=同じチャンネルを共有する章のまとまり)単位。VRC7 6ch や N163 8ch は和音として同時に鳴らす
 * ・長さは全音符(小節)単位。前のまとまりの実長(コンパイル結果のフレーム数)を切り上げ、1小節の間を空ける
 * ・待ち行は t を含めない(src/mml/helpIndex.js SETUP_HINT_RE がセットアップ行と誤認しないため)。
 *   複数チャンネル文字の行は helpIndex の CHANNEL_LINE_RE(1文字)に掛からないので、項目の実演にも混ざらない
 * ・L(ループ地点)は曲中に置かない。1つでもあると、終わったチャンネルが本家同様に先頭から繰り返して重なる
 *
 * help-lint.js からも check() を呼ぶ(章の中身を伸ばして重なったら lint が落ちる)。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SAMPLE_FILE = path.join(ROOT, 'src', 'mml', 'sampleMml.js');
const MARK = '; ←順番待ち(自動生成: tools/headless/sample-sequence.js)';
const RULE_RE = /^; =+\s*$/;
const WAIT_RE = /^[A-Za-z]+ \[r1\]\d+ ; ←順番待ち/;
const CH_LINE_RE = /^([A-Za-z]+)\s+\S/;
const OPEN = 'Mml.SAMPLE_SOURCE =`';

/** sampleMml.js のテキストから MML 本文(テンプレートリテラルの中身)を切り出す */
function splitFile(text) {
  const i0 = text.indexOf(OPEN);
  const i1 = text.lastIndexOf('`;');
  if (i0 < 0 || i1 < 0) throw new Error('sampleMml.js の SAMPLE_SOURCE が見つかりません');
  const bodyStart = i0 + OPEN.length;
  return { head: text.slice(0, bodyStart), body: text.slice(bodyStart, i1), tail: text.slice(i1) };
}

/** 章(罫線で挟まれた見出し)ごとに、見出しの閉じ罫線の行番号と、その章で使うチャンネル文字を拾う */
function chaptersOf(lines) {
  const chapters = [];
  let i = 0;
  while (i < lines.length) {
    if (RULE_RE.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !RULE_RE.test(lines[j]) && lines[j].startsWith(';')) j++;
      if (j < lines.length && RULE_RE.test(lines[j]) && j > i + 1) {
        chapters.push({ title: lines[i + 1].replace(/^;\s*/, ''), closeLine: j, letters: [] });
        i = j + 1;
        continue;
      }
    }
    const cur = chapters[chapters.length - 1];
    const m = cur && !lines[i].startsWith(';') && !lines[i].startsWith('@') && !lines[i].startsWith('#') &&
      !lines[i].startsWith('$') ? CH_LINE_RE.exec(lines[i]) : null;
    if (m) for (const c of m[1]) if (!cur.letters.includes(c)) cur.letters.push(c);
    i++;
  }
  return chapters.filter(c => c.letters.length);
}

/** チャンネルを共有する章を1つのまとまりにする(A の「基本」と「続き」など)。出現順を保つ */
function blocksOf(chapters) {
  const blocks = [];
  for (const ch of chapters) {
    const hit = blocks.find(b => b.letters.some(l => ch.letters.includes(l)));
    if (hit) { for (const l of ch.letters) if (!hit.letters.includes(l)) hit.letters.push(l); hit.chapters.push(ch); }
    else blocks.push({ letters: ch.letters.slice(), chapters: [ch] });
  }
  return blocks;
}

function stripWaits(lines) { return lines.filter(l => !WAIT_RE.test(l)); }

/** 待ち行を計算して入れた本文を返す */
function sequence(MML, body) {
  const nl = body.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = stripWaits(body.split(nl));
  const compiled = MML.Mml.compile(lines.join('\n'), {});
  if (compiled.errors.length) throw new Error('サンプルMMLがコンパイルできません: ' + compiled.errors[0].message);
  const whole = (240 / compiled.tempo) * MML.Mml.FRAME_RATE_NTSC; // 全音符のフレーム数(待ち行は曲頭のテンポで数える)
  const durOf = (ch) => (compiled.segmentsByChannel[ch] || []).reduce((a, s) => a + s.durationFrames, 0);
  const blocks = blocksOf(chaptersOf(lines));
  let bars = 0;
  const inserts = []; // { afterLine, text }
  for (const b of blocks) {
    b.startBars = bars;
    if (bars > 0) inserts.push({ afterLine: b.chapters[0].closeLine, text: `${b.letters.join('')} [r1]${bars} ${MARK}` });
    const dur = Math.max(0, ...b.letters.map(durOf));
    b.bars = Math.ceil(dur / whole);
    bars += b.bars + 1; // 1小節の間を空ける
  }
  inserts.sort((a, b) => b.afterLine - a.afterLine);
  for (const ins of inserts) lines.splice(ins.afterLine + 1, 0, ins.text);
  return { body: lines.join(nl), blocks, totalBars: bars };
}

/** まとまりどうしの発音区間が重なっていないか(コンパイル結果で確かめる) */
function overlaps(MML, body) {
  const lines = body.split(/\r?\n/);
  const compiled = MML.Mml.compile(lines.join('\n'), {});
  const issues = [];
  if (compiled.errors.length) return [`サンプルMMLがコンパイルできません: ${compiled.errors[0].message}`];
  const rangeOf = (ch) => {
    let f = 0, first = null, last = null;
    for (const s of compiled.segmentsByChannel[ch] || []) {
      if (s.freq != null) { if (first === null) first = f; last = f + s.durationFrames; }
      f += s.durationFrames;
    }
    return first === null ? null : [first, last];
  };
  const blocks = blocksOf(chaptersOf(lines)).map(b => {
    const rs = b.letters.map(rangeOf).filter(Boolean);
    return { name: b.letters.join(''), first: Math.min(...rs.map(r => r[0])), last: Math.max(...rs.map(r => r[1])) };
  }).filter(b => Number.isFinite(b.first));
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].first < blocks[i - 1].last) {
      issues.push(`${blocks[i - 1].name} の章(〜${blocks[i - 1].last}f)と ${blocks[i].name} の章(${blocks[i].first}f〜)が重なっています。` +
        '`node tools/headless/sample-sequence.js --write` で待ち行を計算し直してください');
    }
  }
  if (Object.values(compiled.loopFrameByChannel || {}).some(v => v != null)) {
    issues.push('サンプルの曲中に L(ループ地点)があります。終わったチャンネルが先頭から繰り返して全パートが重なるので、L は解説のみにしてください');
  }
  return issues;
}

/** 点検: 待ち行が最新か+重なりが無いか。戻り値は問題の文字列配列(空なら合格) */
function check(MML) {
  const parts = splitFile(fs.readFileSync(SAMPLE_FILE, 'utf8'));
  const issues = overlaps(MML, parts.body);
  const fresh = sequence(MML, parts.body).body;
  if (fresh !== parts.body) issues.push('順番待ちの行が古くなっています。`node tools/headless/sample-sequence.js --write` で更新してください');
  return issues;
}

function main() {
  const { load } = require('./load.js');
  const g = load();
  const MML = global.MML || g.MML;
  const text = fs.readFileSync(SAMPLE_FILE, 'utf8');
  const parts = splitFile(text);
  if (process.argv.includes('--write')) {
    const r = sequence(MML, parts.body);
    fs.writeFileSync(SAMPLE_FILE, parts.head + r.body + parts.tail);
    for (const b of r.blocks) console.log(`  ${b.letters.join('').padEnd(8)} 開始 ${String(b.startBars).padStart(3)} 小節目 / 長さ ${b.bars} 小節`);
    console.log(`wrote ${path.relative(ROOT, SAMPLE_FILE)} (全体 ${r.totalBars} 小節)`);
    return;
  }
  const issues = check(MML);
  for (const m of issues) console.log('ERROR ' + m);
  console.log(issues.length ? `問題 ${issues.length} 件` : 'OK: 章は順番に鳴ります(重なり無し・待ち行は最新)');
  process.exit(issues.length ? 1 : 0);
}

module.exports = { check, sequence, overlaps, splitFile };
if (require.main === module) main();
