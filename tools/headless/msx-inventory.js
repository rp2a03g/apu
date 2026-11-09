#!/usr/bin/env node
/*
 * MSX のファイル置き場を棚卸しする(7f の補助): フォルダを再帰的に見て、圧縮ファイル(zip/7z/rar/lzh/lha/gz)は 7-Zip(7z.exe)で展開先へ開き、
 * 中身を「カートリッジ ROM / ディスク画像 / BIOS らしい ROM / BASIC / その他」に識別して一覧(JSON Lines)と集計を出す。
 * 総当たり(msx-sweep.js)はこの展開先の roms/ と dsks/ に対して回す。
 *
 * 使い方: node tools/headless/msx-inventory.js "<folder>" --out "<展開先>" [--7z "C:\Program Files\7-Zip\7z.exe"] [--no-extract]
 *   展開先/roms/   : カートリッジ ROM(8K〜4M の 2 の累乗か 8K の倍数、名前は <元のアーカイブ名>__<中の名前>)
 *   展開先/dsks/   : ディスク画像(720K/360K/640K/320K)
 *   展開先/bios/   : BIOS らしい ROM(メイン 32K で先頭が F3 C3、サブ/ディスク/MUSIC 16K で 'AB' か 'CD'、漢字 128K/256K)… 名前に BIOS/ROM 定番名を含む物
 *   展開先/inventory.jsonl : 1 ファイル 1 行 { src, inner, kind, size, sha1, dest }
 * 識別は中身とサイズで行い、ファイル名は参考にしない(拡張子無しの .dsk も拾う)。入れ子のアーカイブは 1 段だけ開く。
 * ★ROM の中身はリポジトリに入れない(展開先は _tmp_test の下に)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const src = process.argv.slice(2).find(a => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory() && a !== arg('--out', ''));
const out = arg('--out', null);
const sevenZip = arg('--7z', 'C:\\Program Files\\7-Zip\\7z.exe');
const noExtract = process.argv.includes('--no-extract');
if (!src || !out) { console.error('usage: node tools/headless/msx-inventory.js "<folder>" --out "<dest>"'); process.exit(2); }
const ARCH = /\.(zip|7z|rar|lzh|lha|gz|tgz)$/i;
const DSK_SIZES = new Set([737280, 368640, 655360, 327680]);

for (const d of ['roms', 'dsks', 'bios', 'other', 'tmp']) fs.mkdirSync(path.join(out, d), { recursive: true });
const rows = [];
const seen = new Map(); // sha1 → dest(重複はコピーしない)

function sha1(b) { return crypto.createHash('sha1').update(b).digest('hex'); }
function walk(dir, fn) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, fn); else fn(p); } }
function safe(name) { return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim(); }

// 中身で種類を決める
function classify(bytes, name) {
  const n = bytes.length;
  const ab = bytes[0] === 0x41 && bytes[1] === 0x42, cd = bytes[0] === 0x43 && bytes[1] === 0x44;
  if (DSK_SIZES.has(n)) return 'dsk';
  if (n >= 0x2000 && (n & (n - 1)) === 0 && n <= 0x400000) {
    if (n === 0x8000 && bytes[0] === 0xF3 && bytes[1] === 0xC3) return 'bios'; // メイン BIOS(DI; JP)
    if (ab || cd) {
      // 16K/32K で 'AB' の物は BIOS 周辺(ディスク/MUSIC/サブ/漢字ドライバ)かカートリッジか中身では決めがたい。名前で寄せる(参考)
      if (/disk|msx2ext|msx2pext|mus|kanji|fmpac|ext\b|sub/i.test(name) && n <= 0x10000) return 'bios';
      return 'rom';
    }
    if (n === 0x20000 || n === 0x40000) { if (/kanji/i.test(name)) return 'bios'; }
    if (n === 0x4000 && /msx1han|han\b/i.test(name)) return 'bios';
    // ヘッダの無い 2 の累乗: メガ ROM(ページ 2 にヘッダがある物など)の可能性 → ROM
    for (let o = 0x4000; o < Math.min(n, 0x10000); o += 0x4000) if (bytes[o] === 0x41 && bytes[o + 1] === 0x42) return 'rom';
    return 'other';
  }
  if (n % 0x2000 === 0 && n >= 0x2000 && n <= 0x400000 && (ab || cd)) return 'rom'; // 2 の累乗でないメガ ROM(96K 等)
  if (/\.bas$/i.test(name) || bytes[0] === 0xFF && /\.bas$/i.test(name)) return 'basic';
  if (bytes[0] === 0xFE && n > 7) return 'bin'; // BLOAD 形式
  return 'other';
}
function take(bytes, srcFile, inner) {
  const name = inner ? path.basename(inner) : path.basename(srcFile);
  const kind = classify(bytes, name);
  const h = sha1(bytes);
  const row = { src: path.relative(src, srcFile), inner: inner || null, kind, size: bytes.length, sha1: h, dest: null };
  if (kind === 'rom' || kind === 'dsk' || kind === 'bios') {
    if (seen.has(h)) { row.dest = seen.get(h); row.dup = true; }
    else {
      const dir = kind === 'rom' ? 'roms' : kind === 'dsk' ? 'dsks' : 'bios';
      const base = safe((inner ? path.basename(srcFile).replace(ARCH, '') + '__' : '') + name);
      let dest = path.join(out, dir, base), k = 1;
      while (fs.existsSync(dest)) dest = path.join(out, dir, base.replace(/(\.[^.]*)?$/, '_' + (k++) + '$1'));
      fs.writeFileSync(dest, bytes);
      row.dest = path.relative(out, dest); seen.set(h, row.dest);
    }
  }
  rows.push(row);
}
function extract(archive, depth) {
  const tmp = fs.mkdtempSync(path.join(out, 'tmp', 'x-'));
  const r = spawnSync(sevenZip, ['x', '-y', '-o' + tmp, archive], { encoding: 'utf8' });
  if (r.status !== 0) { rows.push({ src: path.relative(src, archive), inner: null, kind: 'archive-error', size: fs.statSync(archive).size, err: (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | ') }); fs.rmSync(tmp, { recursive: true, force: true }); return; }
  walk(tmp, (f) => {
    const rel = path.relative(tmp, f);
    if (ARCH.test(f)) { if (depth < 1) extract(f, depth + 1); else rows.push({ src: path.relative(src, archive), inner: rel, kind: 'archive-nested', size: fs.statSync(f).size }); return; }
    const st = fs.statSync(f);
    if (st.size === 0 || st.size > 8 * 1024 * 1024) { rows.push({ src: path.relative(src, archive), inner: rel, kind: st.size ? 'big' : 'empty', size: st.size }); return; }
    take(fs.readFileSync(f), archive, rel);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

let nArch = 0;
walk(src, (f) => {
  if (ARCH.test(f)) { nArch++; if (!noExtract) extract(f, 0); else rows.push({ src: path.relative(src, f), kind: 'archive', size: fs.statSync(f).size }); return; }
  const st = fs.statSync(f);
  if (st.size === 0 || st.size > 8 * 1024 * 1024) { rows.push({ src: path.relative(src, f), inner: null, kind: st.size ? 'big' : 'empty', size: st.size }); return; }
  take(fs.readFileSync(f), f, null);
});
fs.writeFileSync(path.join(out, 'inventory.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const by = {};
for (const r of rows) by[r.kind] = (by[r.kind] || 0) + 1;
console.log(`入力 ${src}: アーカイブ ${nArch} 本、識別 ${rows.length} 件`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`重複を除いた置き場: roms ${fs.readdirSync(path.join(out, 'roms')).length}、dsks ${fs.readdirSync(path.join(out, 'dsks')).length}、bios ${fs.readdirSync(path.join(out, 'bios')).length} → ${out}`);
const errs = rows.filter(r => r.kind === 'archive-error');
if (errs.length) { console.log('開けなかったアーカイブ:'); for (const e of errs.slice(0, 20)) console.log('  ' + e.src + ' : ' + e.err); }
