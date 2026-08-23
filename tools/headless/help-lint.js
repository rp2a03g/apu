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
