#!/usr/bin/env node
/*
 * nes-sweep.js の結果(JSON Lines)を分類して読みやすく出す。
 * 使い方: node tools/headless/nes-sweep-report.js result.jsonl [--all]
 *   既定では改造/不良/過剰ダンプなどの印([h…][b…][o…][p…][t…][a…][f…])が付いたファイルを除く(--all で全部)
 */
'use strict';
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/headless/nes-sweep-report.js result.jsonl [--all]'); process.exit(2); }
const all = process.argv.includes('--all');
let rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const tagged = (f) => /\[(h|b|o|p|t|a|f)[^\]]*\]/i.test(f) || /改造/.test(f);
if (!all) rows = rows.filter((r) => !tagged(r.file));
console.log(`${rows.length} 本${all ? '' : '(改造/不良/過剰ダンプの印つきを除く)'}`);
const show = (title, p, f) => { const r = rows.filter(p); console.log(`\n## ${title} (${r.length})`); for (const x of r) console.log('  ' + f(x)); };
const brief = (r) => `${r.file} | ${r.info || r.err}`;
show('読めない', (r) => !r.load, (r) => `${r.file} | ${r.err.replace(/\(対応:.*$/, '')}`);
show('例外', (r) => r.error, (r) => `${r.file} | ${r.error}`);
show('CPU ジャム(KIL)', (r) => r.halted !== undefined, (r) => `${brief(r)} | ${r.halted} フレーム目`);
show('画面が 1 色のまま', (r) => r.load && r.halted === undefined && r.colors <= 1, (r) => `${brief(r)} | 書き込み ${r.writes} 音@${r.soundAt}`);
show('無音(900 フレーム)', (r) => r.load && r.halted === undefined && r.colors > 1 && r.soundAt < 0, (r) => `${brief(r)} | 書き込み ${r.writes} 色 ${r.colors} Start:${r.changedAfterStart ? '効く' : '変化なし'}`);
show('固まり疑い(終わり 3 秒 画面も書き込みも止まる)', (r) => r.load && r.halted === undefined && r.colors > 1 && r.soundAt >= 0 && r.stuck, (r) => `${brief(r)} | 音@${r.soundAt} Start:${r.changedAfterStart ? '効く' : '変化なし'}`);
show('Start で変化なし(音は出る・固まってはいない)', (r) => r.load && r.halted === undefined && r.colors > 1 && r.soundAt >= 0 && !r.stuck && !r.changedAfterStart, (r) => `${brief(r)} | 音@${r.soundAt}`);
const slow = rows.filter((r) => r.msPerFrame > 6).sort((a, b) => b.msPerFrame - a.msPerFrame);
console.log(`\n## 遅い順(>6ms/frame、${slow.length})`);
for (const r of slow.slice(0, 25)) console.log(`  ${r.msPerFrame}ms ${brief(r)}`);
const byMapper = {};
for (const r of rows) if (r.load) { const k = r.mapper; byMapper[k] = byMapper[k] || { n: 0, bad: 0 }; byMapper[k].n++; if (r.halted !== undefined || r.colors <= 1 || r.stuck) byMapper[k].bad++; }
console.log('\n## マッパー別(本数 / 問題あり)');
console.log('  ' + Object.entries(byMapper).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v.n}/${v.bad}`).join('  '));
