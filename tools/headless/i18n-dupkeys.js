/*
 * en.js の重複キー検出(オブジェクトリテラルは後勝ちで、先の訳が黙って死ぬため)
 *   node tools/headless/i18n-dupkeys.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', '..', 'src', 'i18n', 'en.js'), 'utf8');
const re = /^\s*'((?:[^'\\]|\\.)*)':/gm;
const seen = new Map();
const dups = [];
let m;
let n = 0;
while ((m = re.exec(src)) !== null) {
  n++;
  const line = src.slice(0, m.index).split('\n').length;
  if (seen.has(m[1])) dups.push(`${m[1]}  (lines ${seen.get(m[1])} / ${line})`);
  else seen.set(m[1], line);
}
console.log(`keys=${n} duplicates=${dups.length}`);
for (const d of dups) console.log('  ' + d);
process.exit(dups.length ? 1 : 0);
