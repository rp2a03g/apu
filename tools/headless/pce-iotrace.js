#!/usr/bin/env node
/*
 * HES を自前と Mesen 2 で走らせ、I/O($0000-$1FFF、MPR0=$FF の前提)の読み書きを「マスタークロックの時刻つき」で並べて比べる(段階 9a)。
 * pce-mesen-ab.js(書き込みの並びだけ)で食い違った曲の原因を探すのに使う。
 *
 *   node tools/headless/pce-iotrace.js "song.hes" [--frames 120] [--mesen "C:\path\Mesen.exe"] [--psg] [--context 12] [--from N] [--keep]
 *     --psg     PSG($0800-$0BFF)の書き込みも並べる(既定は VDC/タイマ/割り込みレジスタだけ。PSG は量が多い)
 *     --from N  N 個目の食い違いから見せる
 *
 * 1 行 = 「時刻 種類(R/W) 番地 値」。両者は電源投入(曲の頭)からのマスタークロックで時刻を数えるので、そのまま比べられる。
 * 出す物: 最初に食い違った所の前後(--context 行)と、その時点の時刻の差。
 * 読み方: 番地と値が同じで時刻だけずれていく → サイクル数か速度(CSH/CSL)が違う。
 *         片方にだけ読み書きがある → 割り込みの入り方が違う(直前の $1402/$1403/$0C01 と VDC ステータスの読みを見る)。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (n) => process.argv.includes(n);
// ── まとめて回す: --all "<folder>" [--jobs 4] [--out result.txt]。1 曲 1 行で結果を出し、全部同じなら終了コード 0 ──
if (has('--all')) {
  const folder = arg('--all', null);
  if (!folder || !fs.existsSync(folder)) { console.error('usage: node tools/headless/pce-iotrace.js --all "<folder>" [--frames N] [--psg] [--jobs 4] [--out result.txt]'); process.exit(2); }
  const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.hes$/i.test(e.name)) out.push(p); } return out; };
  const files = walk(folder, []).sort();
  const jobs = Math.max(1, parseInt(arg('--jobs', '4'), 10));
  const pass = ['--frames', arg('--frames', '180')].concat(has('--psg') ? ['--psg'] : []).concat(process.argv.includes('--mesen') ? ['--mesen', arg('--mesen', '')] : []);
  const rows = []; let next = 0, running = 0;
  const finishAll = () => {
    rows.sort((a, b) => a.file < b.file ? -1 : 1);
    const ok = rows.filter(r => r.ok), exact = ok.filter(r => / 0 マスタークロック/.test(r.line));
    const text = rows.map(r => r.file + ': ' + r.line).join('\n');
    if (arg('--out', null)) fs.writeFileSync(arg('--out', null), text + '\n');
    console.log(`\nHES ${files.length} 本(${pass[1]} フレーム${has('--psg') ? '、PSG 込み' : ''}): 終わりまで同じ ${ok.length}(うち時刻も全部同じ ${exact.length})、違う ${rows.length - ok.length}`);
    for (const r of rows.filter(x => !x.ok).slice(0, 30)) console.log('  ' + r.file + ': ' + r.line);
    process.exit(rows.length === ok.length ? 0 : 1);
  };
  const pump = () => {
    while (running < jobs && next < files.length) {
      const file = files[next++]; running++;
      const ch = require('child_process').spawn(process.execPath, [__filename, file].concat(pass), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
      ch.on('close', (code) => {
        const line = (out.split(/\r?\n/).find(l => /終わりまで同じ|食い違い #|記録を出しません/.test(l)) || out.trim().split(/\r?\n/).pop() || '').trim().slice(0, 140);
        rows.push({ file: path.basename(file), ok: code === 0, line });
        process.stderr.write(code === 0 ? '.' : 'x');
        running--; if (next >= files.length && running === 0) finishAll(); else pump();
      });
    }
  };
  pump();
  return;
}
const rom = process.argv.slice(2).find(a => !a.startsWith('--') && /\.hes$/i.test(a));
const frames = parseInt(arg('--frames', '120'), 10);
const mesen = arg('--mesen', process.env.MESEN_EXE || null);
if (!rom || !mesen || !fs.existsSync(mesen)) { console.error('usage: node tools/headless/pce-iotrace.js "song.hes" [--frames N] --mesen "C:\\path\\Mesen.exe"(または環境変数 MESEN_EXE)'); process.exit(2); }
const withPsg = has('--psg');
// $1C00/$1C01 は Mesen が HES の待ち場所(自分へ飛ぶ BRA)を見せている番地。自前は別の仕掛けで待つので比べない
const keepLine = (addr) => (withPsg || addr < 0x0800 || addr >= 0x0C00) && addr !== 0x1C00 && addr !== 0x1C01;

// ── Mesen ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-io-'));
const outPath = path.join(work, 'io.txt').replace(/\\/g, '/');
const lua = [
  'local out = io.open(' + JSON.stringify(outPath) + ', "w")',
  'local n = 0',
  'local function cb(kind)',
  '  return function(addr, value)',
  '    local st = emu.getState()',
  '    out:write(string.format("%d %s %04X %02X\\n", st.masterClock or 0, kind, addr, value))',
  '  end',
  'end',
  'emu.addMemoryCallback(cb("W"), emu.callbackType.write, 0x0000, 0x1FFF)',
  'emu.addMemoryCallback(cb("R"), emu.callbackType.read, 0x0000, 0x1FFF)',
  'emu.addEventCallback(function()',
  '  n = n + 1',
  '  if n >= ' + frames + ' then out:close(); emu.stop(0) end',
  'end, emu.eventType.endFrame)',
].join('\n');
const luaPath = path.join(work, 'io.lua');
fs.writeFileSync(luaPath, lua);
const romCopy = path.join(work, 'song.hes');
{
  // ヘッダのデータ長よりファイルが短い曲(末尾が切れている)は Mesen が開かない。自前は足りない所を $00 として読む(Mesen も DATA ブロックの外は $00)ので、写しを $00 で埋めて同じ条件にする
  let b = fs.readFileSync(rom);
  const need = 0x20 + b.readUInt32LE(0x14);
  if (b.length < need && need <= 0x100020) b = Buffer.concat([b, Buffer.alloc(need - b.length, 0x00)]);
  fs.writeFileSync(romCopy, b);
}
spawnSync(mesen, ['--testRunner', romCopy, luaPath, '--timeout=120'], { encoding: 'utf8', timeout: 180000 });
if (!fs.existsSync(outPath)) { console.error('Mesen が記録を出しませんでした'); process.exit(1); }
const parse = (text) => text.split(/\r?\n/).filter(Boolean).map(l => { const p = l.split(' '); return { t: +p[0], k: p[1], a: parseInt(p[2], 16), v: parseInt(p[3], 16) }; }).filter(e => keepLine(e.a));
const rawText = fs.readFileSync(outPath, 'utf8');
const A = parse(rawText);
// Mesen が時間切れで止まると記録は途中まで。最後の行の時刻が頼んだフレーム数の 9 割に届いていなければ失敗にする
// (描画の間引きを切った設定の Mesen は HES の実行が極端に遅い。HES は普段の設定の Mesen で回す)
{ const ls = rawText.trimEnd().split(/\r?\n/); const lastT = ls.length ? +ls[ls.length - 1].split(' ')[0] : 0; const got = lastT / (1365 * 262);
  if (got < frames * 0.9) { console.log(`Mesen が記録を出しません(${frames} フレームのうち約 ${Math.floor(got)} フレームで止まった。時間切れの疑い)`); process.exit(1); } }
if (!has('--keep')) fs.rmSync(work, { recursive: true, force: true }); else console.log('作業フォルダ: ' + work);

// ── 自前 ──
const { MML } = load({ strict: true });
MML.Emu.HesPlayer.DEFER_VBLANK = false; // Mesen には無い救済(タイマ処理中は垂直帰線を後回し)は切って比べる
const p = new MML.Emu.HesPlayer(readBytes(rom));
const bus = p.bus;
const B = [];
const io = (addr) => addr < 0x2000 && bus.mpr[0] === 0xFF;
const rd = bus.read.bind(bus), wr = bus.write.bind(bus), st = bus.stWrite.bind(bus);
bus.read = (addr) => { const v = rd(addr); if (io(addr) && keepLine(addr)) B.push({ t: bus.clock, k: 'R', a: addr, v }); return v; };
bus.write = (addr, v) => { if (io(addr) && keepLine(addr)) B.push({ t: bus.clock, k: 'W', a: addr, v }); wr(addr, v); };
bus.stWrite = (port, v) => { B.push({ t: bus.clock, k: 'W', a: port, v }); st(port, v); };
p.initSong(p.header.firstTrack);
const endT = A.length ? A[A.length - 1].t : 0;
while (bus.clock < endT) p.renderFrame(44100, true);

// ── 比べる ──
const fmt = (e) => (e ? `${String(e.t).padStart(10)} ${e.k} ${e.a.toString(16).padStart(4, '0')} ${e.v.toString(16).padStart(2, '0')}` : ''.padStart(21));
const same = (x, y) => x && y && x.k === y.k && x.a === y.a && x.v === y.v;
let n = 0; const skip = parseInt(arg('--from', '0'), 10);
let i = 0, j = 0, breaks = 0, maxDt = 0, exact = 0;
const ctx = parseInt(arg('--context', '12'), 10);
console.log(`${path.basename(rom)}: Mesen ${A.length} 行、自前 ${B.length} 行(${frames} フレーム)`);
while (i < A.length && j < B.length) {
  if (same(A[i], B[j])) { const d = Math.abs(B[j].t - A[i].t); if (d > maxDt) maxDt = d; if (d === 0) exact++; n++; i++; j++; continue; }
  if (breaks++ >= skip) {
    console.log(`\n${n} 行が同じ(うち時刻も同じ ${exact}、時刻の差の最大 ${maxDt} マスタークロック)。食い違い #${breaks}: Mesen ${i} 行目 / 自前 ${j} 行目`);
    console.log('  ' + 'Mesen'.padEnd(23) + '自前');
    for (let k = -ctx; k < ctx; k++) console.log((k === 0 ? '> ' : '  ') + fmt(A[i + k]).padEnd(23) + fmt(B[j + k]) + (A[i + k] && B[j + k] && same(A[i + k], B[j + k]) ? '   Δt ' + (B[j + k].t - A[i + k].t) : ''));
    process.exit(1);
  }
  // 合わせ直す(次の食い違いを見たい時用): この先 6 行が相手の 400 行以内にあればそこへ
  let found = false;
  for (let d = 1; d <= 400 && !found; d++) for (const [di, dj] of [[d, 0], [0, d]]) { let k = 0; while (k < 6 && same(A[i + di + k], B[j + dj + k])) k++; if (k === 6) { i += di; j += dj; found = true; break; } }
  if (!found) { i += 6; j += 6; }
}
console.log(`終わりまで同じ(${n} 行、うち時刻も同じ ${exact}、時刻の差の最大 ${maxDt} マスタークロック)`);
