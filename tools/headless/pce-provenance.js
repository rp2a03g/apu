#!/usr/bin/env node
/*
 * PC エンジンのコードに付けた「根拠の札」を数える(段階 9。DESIGN-PCE-CAPTURE.md §2.3)。
 *
 *   node tools/headless/pce-provenance.js [--md]
 *
 * 札: [試験] 測って合っている / [参照] 参照実装に合わせた / [文書] 公開文書による / [推定] どれでもない
 * 見る物: src/emulator/pce/ の全部と、下の EXTRA に挙げた作り直し済みのファイル。
 * 出す物: ファイルごとの札の数、[推定] の一覧(ファイル:行 と中身)、★(参照実装が自分で「概算/未確認」としている所、食い違い)の一覧。
 *   --md を付けると、DESIGN-PCE-CAPTURE.md §10 に貼れる形(表)で出す。
 * 札が 1 つも無いファイルは「札なし」として警告する(ハードの挙動を書くファイルに札が無いのは、根拠を書き忘れている)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
// 作り直しが済んで札を付け終えたファイル(pce/ の外にある物)。未着手の物は入れない
const EXTRA = ['src/emulator/cpuHuC6280.js', 'src/emulator/hesBus.js', 'src/emulator/apuHuC6280.js'];
// まだ作り直していない(札を付けていない)PCE 関連のファイル。数えないが、残っていることを毎回出す
const TODO = ['src/emulator/hesPlayer.js'];
const TAGS = ['試験', '参照', '文書', '推定'];
const md = process.argv.includes('--md');

const files = EXTRA.slice();
const dir = path.join(root, 'src/emulator/pce');
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (/\.js$/.test(f)) files.push('src/emulator/pce/' + f);

const guesses = [], stars = [], rows = [];
for (const rel of files) {
  const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
  const n = { 試験: 0, 参照: 0, 文書: 0, 推定: 0 };
  lines.forEach((line, i) => {
    // 札の説明そのもの(頭の凡例「[推定] 上のどれでもない…」など)は数えない
    const legend = /^\s*\*?\s*\[(試験|参照|文書|推定)\]\s+(SingleStepTests|Mesen 2 の Core|HuC6280 CMOS|上のどれでもない)/.test(line);
    for (const t of TAGS) {
      if (!line.includes('[' + t + ']') || legend) continue;
      n[t]++;
      if (t === '推定') {
        // 続きの行(同じ字下げのコメントの続き)を 2 行までつなぐ
        let text = line.replace(/^\s*(\/\/|\*)\s*/, '').trim();
        for (let k = 1; k <= 2; k++) { const nx = lines[i + k] || ''; if (/^\s*(\/\/|\*)\s{6,}\S/.test(nx)) text += ' ' + nx.replace(/^\s*(\/\/|\*)\s*/, '').trim(); else break; }
        guesses.push({ at: rel + ':' + (i + 1), text });
      }
    }
    if (line.includes('★')) stars.push({ at: rel + ':' + (i + 1), text: line.replace(/^\s*(\/\/|\*)\s*/, '').trim() });
  });
  rows.push({ rel, n, total: TAGS.reduce((a, t) => a + n[t], 0) });
}

if (md) {
  console.log('| ファイル | 試験 | 参照 | 文書 | 推定 |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.rel} | ${r.n.試験} | ${r.n.参照} | ${r.n.文書} | ${r.n.推定} |`);
  console.log('\n**[推定] の一覧**\n');
  for (const g of guesses) console.log(`- ${g.at} — ${g.text.replace(/^\[推定\]\s*/, '')}`);
  console.log('\n**★ 参照実装自身が概算/未確認としている所、食い違い**\n');
  for (const s of stars) console.log(`- ${s.at} — ${s.text.replace(/^★\s*/, '')}`);
} else {
  for (const r of rows) console.log(`${r.rel.padEnd(36)} 試験 ${r.n.試験}  参照 ${r.n.参照}  文書 ${r.n.文書}  推定 ${r.n.推定}` + (r.total === 0 ? '   ← 札なし' : ''));
  console.log(`\n[推定] ${guesses.length} 件:`);
  for (const g of guesses) console.log('  ' + g.at + '  ' + g.text.slice(0, 200));
  console.log(`\n★ ${stars.length} 件:`);
  for (const s of stars) console.log('  ' + s.at + '  ' + s.text.slice(0, 200));
}
const left = TODO.filter(f => fs.existsSync(path.join(root, f)));
if (left.length && !md) console.log('\nまだ作り直していない(札を付けていない)ファイル: ' + left.join('、'));
process.exit(rows.some(r => r.total === 0) ? 1 : 0);
