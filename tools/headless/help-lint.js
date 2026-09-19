/*
 * ヘルプ索引の自己点検 (ブラウザ不要)
 *
 *   node tools/headless/help-lint.js            組み込みサンプルMMLを点検
 *   node tools/headless/help-lint.js song.mml   任意のMMLファイルを点検
 *   node tools/headless/help-lint.js --list     抽出できた項目を一覧表示
 *
 * 見るもの:
 *   1. ";@help" タグの書式エラー・本文/実演スニペットの欠落・コマンドの重複
 *   2. 各項目の実演スニペットが実際にコンパイルできるか(解説が実装から取り残されると落ちる)
 *   3. compiler.js 冒頭の「対応コマンド:」ブロックと突き合わせた網羅チェック
 *      (ヘルプ側に第2のコマンド一覧を作らないため、正典はあくまでcompiler.jsの記述)
 *
 * 終了コード: エラーがあれば1、警告だけなら0。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { load } = require('./load.js');

const ROOT = path.join(__dirname, '..', '..');

/**
 * 英語版の組み込みサンプル(src/mml/sampleMml.en.js)の点検。
 *
 * 二重管理になってよいのはコメントだけ、という状態を守る:
 *   ・コメントを落としたMML本文が日本語版と1行も違わないこと(音が変わっていない)
 *   ・英語版だけで同じ項目が揃い、実演スニペットがコンパイルできること
 *   ・掲載しているコマンドの集合が日本語版と一致すること(片方だけ項目を足した、を落とす)
 *   ・英語版のコメントに日本語が残っていないこと(訳し忘れ)
 */
function lintEnglishSample(MML) {
  const out = [];
  const ja = MML.Mml.SAMPLE_SOURCE;
  const en = MML.Mml.SAMPLE_SOURCE_EN;
  if (!en) {
    out.push({ level: 'error', lineNo: 0, message: '英語版の組み込みサンプル(SAMPLE_SOURCE_EN)が読み込まれていません' });
    return out;
  }

  // コメント(";"以降)を落として残った実データ行だけを比べる
  const bodyOf = (s) => String(s).split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/;.*$/, '').replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
  const bj = bodyOf(ja);
  const be = bodyOf(en);
  for (let i = 0; i < Math.max(bj.length, be.length); i++) {
    if (bj[i] !== be[i]) {
      out.push({ level: 'error', lineNo: 0,
        message: `英語版のMML本文が日本語版と違います(${i + 1}行目)\n        ja: ${bj[i] === undefined ? '(無し)' : bj[i]}\n        en: ${be[i] === undefined ? '(無し)' : be[i]}` });
      break; // 1件出れば十分(ずれると以降は全部ずれる)
    }
  }

  const r = MML.HelpIndex.lint(en, MML.Mml.compile);
  for (const i of r.issues) out.push({ level: i.level, lineNo: i.lineNo, message: '[en] ' + i.message });

  // 項目は同じ順・同じ数で並んでいるはず(MML本文が同一なので、タグの位置も同じ)。
  // コマンド名は言語をまたいで同じだが、"音域"/"Range" のような説明項目のラベルだけは
  // 訳されるので、日本語を含むラベルは一致を求めない。
  const ej = MML.HelpIndex.parse(ja).entries;
  const ee = r.entries;
  const CJK_LABEL = /[぀-ヿ一-鿿]/;
  if (ej.length !== ee.length) {
    out.push({ level: 'error', lineNo: 0, message: `ヘルプ項目の数が違います(日本語版 ${ej.length} / 英語版 ${ee.length})` });
  } else {
    for (let i = 0; i < ej.length; i++) {
      const a = ej[i].commands.join(' ');
      const b = ee[i].commands.join(' ');
      if (a !== b && !CJK_LABEL.test(a)) {
        out.push({ level: 'error', lineNo: ee[i].lineNo, message: `${i + 1}番目の項目のコマンドが違います(ja: ${a} / en: ${b})` });
      }
      if (!ee[i].title) out.push({ level: 'error', lineNo: ee[i].lineNo, message: `英語版の見出しが空です(${b})` });
      if (ej[i].docOnly !== ee[i].docOnly) {
        out.push({ level: 'error', lineNo: ee[i].lineNo, message: `解説のみ(nodemo)の指定が日本語版と違います(${b})` });
      }
    }
  }

  // 訳し忘れ(英語版のコメントに残った日本語)。ひらがな/カタカナ/漢字のどれかが出たら拾う
  const CJK = /[぀-ヿ一-鿿]/;
  en.split('\n').forEach((l, i) => {
    const s = l.replace(/\r$/, '');
    if (/^\s*;/.test(s) || /;/.test(s)) {
      const comment = /^\s*;/.test(s) ? s : s.slice(s.indexOf(';'));
      if (CJK.test(comment)) out.push({ level: 'warn', lineNo: i + 1, message: `英語版に日本語が残っています: ${comment.trim().slice(0, 60)}` });
    }
  });

  return out;
}

 function main() {
  const argv = process.argv.slice(2);
  const wantList = argv.includes('--list');
  const file = argv.find((a) => !a.startsWith('--'));

  const g = load();
  const MML = global.MML || g.MML;
  const source = file ? fs.readFileSync(file, 'utf8') : MML.Mml.SAMPLE_SOURCE;

  const { issues, entries, chapters } = MML.HelpIndex.lint(source, MML.Mml.compile);

  // --- 網羅チェック: compiler.js の「対応コマンド:」に載っていてヘルプに無いもの ---
  const compilerSrc = fs.readFileSync(path.join(ROOT, 'src', 'mml', 'compiler.js'), 'utf8');
  const checklist = MML.HelpIndex.commandChecklistFromDoc(compilerSrc);
  const helpCommands = [];
  for (const e of entries) helpCommands.push(...e.commands);
  const missing = checklist.filter((c) => !MML.HelpIndex.isCommandCovered(c, helpCommands));

  if (wantList) {
    let chapter = null;
    for (const e of entries) {
      if (e.chapter !== chapter) { chapter = e.chapter; console.log('\n== ' + (chapter || '(章なし)') + ' =='); }
      console.log(
        `  [${e.category}] ${e.title}  (${e.commands.join(' ')})  ` +
        `本文${e.body.length}字 / 実演${e.snippet.split('\n').filter(Boolean).length}行` +
        (e.playable ? '' : ' / 再生不可')
      );
    }
    console.log('');
  }

  // 組み込みサンプルは章を順番に鳴らす(tools/headless/sample-sequence.js)。章の中身を伸ばして
  // 次の章と重なった/待ち行が古い/曲中に L を置いた、をここで落とす
  if (!file) {
    for (const message of require('./sample-sequence.js').check(MML)) issues.push({ level: 'error', lineNo: 0, message });
    for (const i of lintEnglishSample(MML)) issues.push(i);
  }

  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level !== 'error');
  for (const i of errors) console.log(`ERROR [line ${i.lineNo}] ${i.message}`);
  for (const i of warns) console.log(`WARN  [line ${i.lineNo}] ${i.message}`);
  if (missing.length) {
    console.log('\nヘルプ未掲載のコマンド (compiler.js「対応コマンド:」より):');
    for (const c of missing) console.log('   ' + c);
  }

  console.log('');
  console.log(`章 ${chapters.length} / 項目 ${entries.length} / エラー ${errors.length} / 警告 ${warns.length} / 未掲載 ${missing.length}`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
