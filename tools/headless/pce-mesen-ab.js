#!/usr/bin/env node
/*
 * PC エンジン(いまは HES)を自前と Mesen 2 の両方で走らせ、PSG レジスタの書き込み列を突き合わせる(段階 9a。DESIGN-PCE-CAPTURE.md §2.1)。
 *
 *   node tools/headless/pce-mesen-ab.js "song.hes" [--frames 600] [--mesen "C:\path\Mesen.exe"] [--keep] [--show 4]
 *   node tools/headless/pce-mesen-ab.js --all "<folder>" [--out result.jsonl] [--frames 600] [--jobs 4]
 *     Mesen の場所は --mesen か環境変数 MESEN_EXE。Mesen は HES のヘッダの「最初の曲」を鳴らすので、自前も同じ曲を回す
 *
 * やること:
 *   1. tools/mesen/vgm-recorder.lua を「起動と同時に録音、frames フレームで止める」に書き換えた写しを作り、
 *      Mesen.exe --testRunner song.hes script.lua で走らせる(GUI 無し、最高速)。出てきた VGM から HuC6280 の書き込み(0xB9)を取り出す
 *   2. 同じ曲を自前(HesPlayer)で回し、PSG($0800-$0809)への書き込みを取る
 *   3. どちらも「(レジスタ, 値) の通しの並び」にして比べる。フレームの区切りは両者で違うので使わない。
 *      Mesen の録音は頭に「録音開始時の像」(実際の書き込みではない)が入り、スクリプトが動き出す前の書き込みは録れていないので、
 *      自前の並びの一部(12 個)が Mesen のどこに現れるかで位置を合わせる
 * 出す物:
 *   prefix  合わせた位置から何個続けて同じか
 *   same    食い違ったら近くで合わせ直して数え続けた時の、同じだった割合(%)と合わせ直した回数(resync)
 * 読み方:
 *   prefix が終わりまで = Mesen と同じ動き。
 *   resync が少しで same が高い = 2 つの割り込み(タイマと垂直帰線)の前後関係が所々で入れ替わっている(時刻の精度の問題)。
 *   same が低い = CPU/タイマ/割り込み/PSG のどこかが違う。
 * 注意: Mesen 側の採り口は論理番地 $0800-$0809(MPR0=$FF の前提)。I/O を別の窓に置く曲は Mesen 側が空になる。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (n) => process.argv.includes(n);
const frames = parseInt(arg('--frames', '600'), 10);
const mesen = arg('--mesen', process.env.MESEN_EXE || null);
const usage = () => { console.error('usage: node tools/headless/pce-mesen-ab.js "song.hes" [--frames N] --mesen "C:\\path\\Mesen.exe"(または環境変数 MESEN_EXE) | --all "<folder>" [--out result.jsonl] [--jobs 4]'); process.exit(2); };
if (!mesen || !fs.existsSync(mesen)) usage();

// ── まとめて回す ──
if (has('--all')) {
  const folder = arg('--all', null);
  if (!folder || !fs.existsSync(folder)) usage();
  const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.hes$/i.test(e.name)) out.push(p); } return out; };
  const files = walk(folder, []).sort();
  const outFile = arg('--out', null); if (outFile) fs.writeFileSync(outFile, '');
  const jobs = Math.max(1, parseInt(arg('--jobs', '4'), 10));
  const results = []; let next = 0, running = 0;
  const done = () => {
    const ok = results.filter(r => r.full), part = results.filter(r => !r.full && !r.error);
    console.log(`\nHES ${files.length} 本(${frames} フレーム): 終わりまで一致 ${ok.length}、途中で食い違い ${part.length}、比べられない ${results.filter(r => r.error).length}`);
    const band = (lo, hi) => part.filter(r => r.same >= lo && r.same < hi).length;
    console.log(`  食い違った物の「同じだった割合」: 99% 以上 ${band(99, 101)}、90〜99% ${band(90, 99)}、50〜90% ${band(50, 90)}、50% 未満 ${band(0, 50)}`);
    for (const r of part.sort((a, b) => a.same - b.same).slice(0, 25)) console.log(`  ${r.file}: prefix ${r.prefix}/${r.total}、same ${r.same}%(resync ${r.resync})、Mesen ${r.mesen} / 自前 ${r.own}`);
    for (const r of results.filter(x => x.error).slice(0, 25)) console.log(`  ${r.file}: ${r.error}`);
    process.exit(part.length || results.some(r => r.error) ? 1 : 0);
  };
  const pump = () => {
    while (running < jobs && next < files.length) {
      const file = files[next++]; running++;
      const ch = spawn(process.execPath, [__filename, file, '--frames', String(frames), '--mesen', mesen, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; ch.stdout.on('data', d => { out += d; });
      ch.on('close', () => {
        let r; try { r = JSON.parse(out.trim().split('\n').pop()); } catch (e) { r = { file: path.basename(file), error: '結果が読めない: ' + out.slice(0, 120) }; }
        results.push(r); if (outFile) fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
        process.stderr.write(r.error ? '?' : r.full ? '.' : 'x');
        running--; if (next >= files.length && running === 0) done(); else pump();
      });
    }
  };
  pump();
  return;
}

const rom = process.argv.slice(2).find(a => !a.startsWith('--') && /\.hes$/i.test(a));
if (!rom) usage();
const json = has('--json');
const base = path.basename(rom);
const finish = (r, code) => { if (json) console.log(JSON.stringify(r)); process.exit(code); };

// ── 1. Mesen ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-ab-'));
const cleanup = () => { if (!has('--keep')) fs.rmSync(work, { recursive: true, force: true }); else if (!json) console.log('作業フォルダ: ' + work); };
let lua = fs.readFileSync(path.join(__dirname, '..', 'mesen', 'vgm-recorder.lua'), 'utf8');
const set = (re, to) => { if (!re.test(lua)) throw new Error('vgm-recorder.lua の形が変わった: ' + re); lua = lua.replace(re, to); };
set(/autoStart\s*=\s*false/, 'autoStart       = true');
set(/stopAfterFrames\s*=\s*0/, 'stopAfterFrames = ' + frames);
set(/outDir\s*=\s*nil/, 'outDir          = ' + JSON.stringify(work.replace(/\\/g, '/') + '/'));
const luaPath = path.join(work, 'rec.lua');
fs.writeFileSync(luaPath, lua);
// 曲のファイルは作業フォルダへ写して渡す(名前に空白や記号があっても Mesen が開けるように)
const romCopy = path.join(work, 'song.hes');
{
  // ヘッダのデータ長よりファイルが短い曲(末尾が切れている)は Mesen が開かない。自前は足りない所を $00 として読む(Mesen も DATA ブロックの外は $00)ので、写しを $00 で埋めて同じ条件にする
  let b = fs.readFileSync(rom);
  const need = 0x20 + b.readUInt32LE(0x14);
  if (b.length < need && need <= 0x100020) b = Buffer.concat([b, Buffer.alloc(need - b.length, 0x00)]);
  fs.writeFileSync(romCopy, b);
}
const run = spawnSync(mesen, ['--testRunner', romCopy, luaPath, '--timeout=120'], { encoding: 'utf8', timeout: 180000 });
const vgmFile = fs.readdirSync(work).find(f => /\.vgm$/i.test(f));
if (!vgmFile) { cleanup(); if (!json) console.error(base + ': Mesen が VGM を出しませんでした(終了コード ' + run.status + ')'); finish({ file: base, error: 'Mesen が VGM を出さない(終了コード ' + run.status + ')' }, 1); }
const vgm = fs.readFileSync(path.join(work, vgmFile));
function vgmWrites(b) {
  const out = []; let p = 0x34 + b.readUInt32LE(0x34);
  while (p < b.length) {
    const c = b[p];
    if (c === 0x66) break;
    if (c === 0xB9) { out.push((b[p + 1] << 8) | b[p + 2]); p += 3; }
    else if (c === 0x62 || c === 0x63) p += 1;
    else if (c === 0x61) p += 3;
    else if (c >= 0x70 && c <= 0x7F) p += 1;
    else if (c === 0x67) p += 7 + b.readUInt32LE(p + 3);
    else throw new Error('VGM に知らない命令 $' + c.toString(16) + ' @' + p);
  }
  return out;
}
const A = vgmWrites(vgm);
cleanup();

// ── 2. 自前 ──
const { load, readBytes } = require('./load');
const { MML } = load({ strict: true });
const p = new MML.Emu.HesPlayer(readBytes(rom));
const B = [];
const bus = p.bus;
bus.onWrite = (addr, value) => {
  if (bus.mpr[addr >>> 13] !== 0xFF) return;
  const off = addr & 0x1FFF;
  if (off >= 0x0800 && off <= 0x0809) B.push(((off & 15) << 8) | value);
};
p.initSong(p.header.firstTrack);
const total = Math.ceil(frames * p.frameRate / 59.82) + 30;
for (let f = 0; f < total; f++) p.renderFrame(44100, true);

// ── 3. 比べる ──
const fmt = (x) => (x === undefined ? '(なし)' : (x >> 8).toString(16) + '=' + (x & 255).toString(16).padStart(2, '0'));
const row = (list, at, n) => list.slice(Math.max(0, at), at + n).map(fmt).join(' ');
if (A.length < 40 || B.length < 40) {
  if (!json) console.log(`${base}: 書き込みが少なすぎて比べられない(Mesen ${A.length}、自前 ${B.length})`);
  finish({ file: base, error: `書き込みが少ない(Mesen ${A.length}、自前 ${B.length})`, mesen: A.length, own: B.length }, 1);
}
// 位置合わせ: 自前の並びの b0 個目からの 12 個が Mesen のどこにあるか。頭の方から順に試す
function findSeq(hay, needle, limit) { outer: for (let i = 0; i + needle.length <= hay.length && i < limit; i++) { for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer; return i; } return -1; }
let a0 = -1, b0 = -1;
for (const s of [0, 8, 24, 64, 160, 400, 1000, 2500]) { if (s + 12 > B.length) break; const at = findSeq(A, B.slice(s, s + 12), 6000); if (at >= 0) { a0 = at; b0 = s; break; } }
if (a0 < 0) {
  if (!json) { console.log(`${base}: 位置を合わせられない(自前の並びが Mesen 側に見つからない)。Mesen ${A.length} / 自前 ${B.length}`); console.log('  Mesen の先頭: ' + row(A, 0, 40)); console.log('  自前の先頭 : ' + row(B, 0, 40)); }
  finish({ file: base, error: '位置を合わせられない', mesen: A.length, own: B.length }, 1);
}
// 合わせた位置から手前へも伸ばす(自前の頭に Mesen が録れている分)
while (a0 > 0 && b0 > 0 && A[a0 - 1] === B[b0 - 1]) { a0--; b0--; }
const len = Math.min(A.length - a0, B.length - b0);
let prefix = 0; while (prefix < len && A[a0 + prefix] === B[b0 + prefix]) prefix++;
// 食い違ったら合わせ直して数え続ける: この先の 8 個が相手の ±96 個の範囲にあればそこへ飛ぶ
let i = a0, j = b0, same = 0, resync = 0; const breaks = [];
const endA = A.length - 8, endB = B.length - 8;
while (i < endA && j < endB) {
  if (A[i] === B[j]) { same++; i++; j++; continue; }
  if (breaks.length < 12) breaks.push([i, j]);
  let found = false;
  for (let d = 1; d <= 96 && !found; d++) {
    for (const [di, dj] of [[d, 0], [0, d], [d, d]]) {
      for (let e = 0; e <= (di && dj ? d : 0) && !found; e++) {
        const ii = i + (di ? (dj ? e : d) : 0), jj = j + (dj ? d : 0);
        if (ii + 8 > A.length || jj + 8 > B.length) continue;
        let k = 0; while (k < 8 && A[ii + k] === B[jj + k]) k++;
        if (k === 8) { i = ii; j = jj; found = true; }
      }
    }
  }
  if (!found) { i += 8; j += 8; }
  resync++;
}
const cmp = Math.min(endA - a0, endB - b0);
const full = prefix >= len - 8;
const pct = +(same * 100 / Math.max(1, cmp)).toFixed(2);
if (!json) {
  console.log(`${base}: Mesen ${A.length} 書き込み、自前 ${B.length} 書き込み(位置合わせ: Mesen ${a0} 個目 = 自前 ${b0} 個目)`);
  console.log(`通しの並び: ${prefix} 個が続けて同じ(比べられる長さ ${len})` + (full ? ' → 終わりまで一致' : ''));
  if (!full) {
    console.log(`合わせ直して数えると ${same}/${cmp} 個が同じ(${pct}%)、合わせ直し ${resync} 回`);
    const show = parseInt(arg('--show', '3'), 10);
    for (const [x, y] of breaks.slice(0, show)) { console.log(`  食い違い(Mesen ${x} 個目 / 自前 ${y} 個目)`); console.log('    Mesen: ' + row(A, x - 6, 22)); console.log('    自前 : ' + row(B, y - 6, 22)); }
  }
}
finish({ file: base, full, prefix, total: len, same: full ? 100 : pct, resync: full ? 0 : resync, mesen: A.length, own: B.length }, full ? 0 : 1);
