#!/usr/bin/env node
/*
 * Worker/Worklet バンドルの再ビルド忘れを見つける(2026-11-11)。
 *   node tools/headless/bundle-fresh.js        古いバンドルがあれば一覧を出して exit 1
 *
 * tools/build-capture-workers.ps1 の表(Out と Files)を読み、各バンドルに元のソースがそのまま入っているかを見る
 * (ビルドはソースを繋ぐだけなので、ソースを直して再ビルドしていなければ文字列として見つからない)。
 * ブラウザ側も実行時に同じ考えで確かめ、古ければ黙って主スレッド実行(ゲーム画面は音なし)に落ちる。
 * 「直したのに直っていない」「音が出ない」を出す前に止めるため、check-all.js の最初でも回す。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ps1 = fs.readFileSync(path.join(ROOT, 'tools', 'build-capture-workers.ps1'), 'utf8');
const norm = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\)\(window\)/g, ')(globalThis)');

const stale = [];
let bundles = 0;
// コメント行(# …)の括弧や引用符で表を読み違えないように、先に落とす
const table = ps1.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
for (const block of table.split(/@\{/).slice(1)) {
  const out = /Out\s*=\s*'([^']+)'/.exec(block);
  const files = /Files\s*=\s*@\(([\s\S]*?)\n\s*\)/.exec(block);
  if (!out || !files) continue;
  bundles++;
  const outPath = path.join(ROOT, out[1].replace(/\\/g, '/'));
  if (!fs.existsSync(outPath)) { stale.push(`${out[1]}: ありません`); continue; }
  const bundle = norm(fs.readFileSync(outPath, 'utf8'));
  for (const m of files[1].matchAll(/'([^']+)'/g)) {
    const src = path.join(ROOT, m[1].replace(/\\/g, '/'));
    if (!fs.existsSync(src)) { stale.push(`${out[1]}: 元のソース ${m[1]} がありません`); continue; }
    if (!bundle.includes(norm(fs.readFileSync(src, 'utf8')))) stale.push(`${out[1]}: ${m[1]} がバンドルより新しい`);
  }
}
if (stale.length) {
  console.log('バンドルが古い(tools/build-capture-workers.ps1 で再ビルドしてください):');
  for (const s of stale) console.log('  ' + s);
  process.exit(1);
}
console.log(`バンドル ${bundles} 本はソースと一致`);
