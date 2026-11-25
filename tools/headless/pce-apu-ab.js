#!/usr/bin/env node
/*
 * 波形メモリ音源(HuC6280 内蔵)の「中身」を自前と Mesen 2 で比べる(段階 9b)。
 * 音源のレジスタ($0800-$0809)へ書き込むたびに、その直前の音源の状態を両方で控えて、1 行ずつ突き合わせる。
 *
 *   node tools/headless/pce-apu-ab.js "song.hes" [--frames 300] [--track N] [--mesen "C:\path\Mesen.exe"] [--context 6] [--keep]
 *   node tools/headless/pce-apu-ab.js --all "<folder>" [--frames 300] [--jobs 4] [--out result.txt]
 *     --track N  ヘッダの「最初の曲」を N に書き換えた写しで回す(Mesen は最初の曲しか鳴らさないため)
 *
 * 比べる物(ch ごと): 周期タイマの残り、波形の読み位置、今の出力、波形メモリ 32 個の中身、
 *                    ch5/6 はノイズの乱数(LFSR)・ノイズのタイマ・ノイズの出力
 * これで分かること: 波形の進み方(周期 0 の扱い、ch を入れ直した時のタイマ)、LFO(ch2 の出力で ch1 の周期が動く)、
 *                    ノイズの乱数の作りと周期、鳴っている最中の波形書き込み、DDA の出力。
 * 分からないこと: 音量の表と左右の混ぜ方(Mesen は音をスクリプトへ渡さない)。そこは VGMPlay の WAV と比べる。
 *
 * 仕掛け: Mesen の音源は「書き込みが来た時」と「1 画面の終わり」にだけまとめて時間を進める。状態はその時点の物が読める。
 *   自前も同じ時にだけ進めて(画面の終わりの時刻は Mesen の記録から取る)、同じ条件で比べる。
 *   Mesen の設定(HuC6280A の音=出力を -16〜+15 として扱う)が入っている前提。入っていないと「今の出力」が 16 ずれる。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (n) => process.argv.includes(n);
const USAGE = 'usage: node tools/headless/pce-apu-ab.js "song.hes" [--frames N] [--track N] --mesen "C:\\path\\Mesen.exe"(または環境変数 MESEN_EXE) | --all "<folder>" [--jobs 4] [--out result.txt]';

// ── 自前どうし: 速い道(ch ごとに一度に進める)と素直な道(Mesen と同じ刻み)が同じ状態になるか。Mesen は要らない ──
//   node tools/headless/pce-apu-ab.js --selfcheck "<folder>" [--frames 600]
if (has('--selfcheck')) {
  const folder = arg('--selfcheck', null);
  if (!folder || !fs.existsSync(folder)) { console.error(USAGE); process.exit(2); }
  const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.hes$/i.test(e.name)) out.push(p); } return out; };
  const files = walk(folder, []).sort();
  const { load, readBytes } = require('./load');
  const { MML } = load({ strict: true });
  const endT = parseInt(arg('--frames', '600'), 10) * 1365 * 262;
  const stateOf = (apu) => apu.ch.map((c, i) => { let sum = 0; for (let k = 0; k < 32; k++) sum += c.wave[k] * (k + 1); return [c.timer, c.wavePos, c.out, sum, c.lfsr, c.noiseTimer, c.noiseOut].join(','); }).join('|');
  const run = (file, chunked) => {
    MML.Emu.HesPlayer.DEFER_VBLANK = false; // Mesen には無い救済(タイマ処理中は垂直帰線を後回し)は切って比べる
    const p = new MML.Emu.HesPlayer(readBytes(file));
    const bus = p.bus, apu = p.apu, log = [];
    apu.forceChunked = chunked;
    const wr = bus.write.bind(bus);
    // 書き込みの直前まで進めた状態を比べる(進めずに比べると、進め方の違いではなく「まだ進めていない」だけの差が混ざる)
    bus.write = (addr, v) => { if (addr >= 0x0800 && addr < 0x0C00 && bus.mpr[0] === 0xFF) { apu.runToMaster(bus.clock); log.push(stateOf(apu)); } wr(addr, v); };
    p.initSong(p.header.firstTrack);
    let steps = 0;
    while (bus.clock < endT) { p.cpu.step(); if ((++steps & 0x3FF) === 0) { apu.runToMaster(bus.clock); log.push(stateOf(apu)); } }
    return log;
  };
  let ok = 0, total = 0; const bad = [];
  for (const file of files) {
    let a, b;
    try { a = run(file, false); b = run(file, true); } catch (e) { bad.push(path.basename(file) + ': 例外 ' + e.message); process.stderr.write('x'); continue; }
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    total += a.length;
    if (i === a.length && a.length === b.length) { ok++; process.stderr.write('.'); }
    else { bad.push(`${path.basename(file)}: ${i} 個目で違う\n    速い道 ${a[i]}\n    素直   ${b[i]}`); process.stderr.write('x'); }
  }
  console.log(`\nHES ${files.length} 本: 速い道と素直な道が同じ ${ok}(比べた点 ${total})、違う ${bad.length}`);
  for (const l of bad.slice(0, 20)) console.log('  ' + l);
  process.exit(bad.length ? 1 : 0);
}

// ── まとめて回す ──
if (has('--all')) {
  const folder = arg('--all', null);
  if (!folder || !fs.existsSync(folder)) { console.error(USAGE); process.exit(2); }
  const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.hes$/i.test(e.name)) out.push(p); } return out; };
  const files = walk(folder, []).sort();
  const jobs = Math.max(1, parseInt(arg('--jobs', '4'), 10));
  const pass = ['--frames', arg('--frames', '300')].concat(has('--mesen') ? ['--mesen', arg('--mesen', '')] : []);
  const rows = []; let next = 0, running = 0;
  const finishAll = () => {
    rows.sort((a, b) => a.file < b.file ? -1 : 1);
    const ok = rows.filter(r => r.ok);
    const lines = ok.reduce((s, r) => s + (+(/(\d+) 行/.exec(r.line) || [0, 0])[1]), 0);
    if (arg('--out', null)) fs.writeFileSync(arg('--out', null), rows.map(r => r.file + ': ' + r.line).join('\n') + '\n');
    console.log(`\nHES ${files.length} 本(${pass[1]} フレーム): 終わりまで同じ ${ok.length}(書き込み ${lines} 回ぶん)、違う ${rows.length - ok.length}`);
    for (const r of rows.filter(x => !x.ok).slice(0, 40)) console.log('  ' + r.file + ': ' + r.line);
    process.exit(rows.length === ok.length ? 0 : 1);
  };
  const pump = () => {
    while (running < jobs && next < files.length) {
      const file = files[next++]; running++;
      const ch = spawn(process.execPath, [__filename, file].concat(pass), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
      ch.on('close', (code) => {
        const line = (out.split(/\r?\n/).find(l => /終わりまで同じ|食い違い|記録を出しません/.test(l)) || out.trim().split(/\r?\n/).pop() || '').trim().slice(0, 160);
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
const frames = parseInt(arg('--frames', '300'), 10);
const mesen = arg('--mesen', process.env.MESEN_EXE || null);
if (!rom || !mesen || !fs.existsSync(mesen)) { console.error(USAGE); process.exit(2); }
const track = has('--track') ? parseInt(arg('--track', '0'), 10) & 0xFF : null;

// ── Mesen ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-apu-'));
const outPath = path.join(work, 'apu.txt').replace(/\\/g, '/');
// 1 行: 「時刻 W 番地 値 | ch0 | ... | ch5」。ch = タイマ,位置,出力,波形の検算値[,乱数,ノイズタイマ,ノイズ出力]。画面の終わりは「時刻 F」
const lua = [
  'local out = io.open(' + JSON.stringify(outPath) + ', "w")',
  'local n = 0',
  'local function chan(st, i)',
  '  local p = "psg.channels[" .. i .. "]."',
  '  local sum = 0',
  '  for k = 0, 31 do sum = sum + st[p .. "waveData" .. k] * (k + 1) end',
  '  local s = string.format("%d,%d,%d,%d", st[p .. "timer"], st[p .. "waveAddr"], st[p .. "currentOutput"], sum)',
  '  if i >= 4 then s = s .. string.format(",%d,%d,%d", st[p .. "noiseLfsr"], st[p .. "noiseTimer"], st[p .. "noiseOutput"]) end',
  '  return s',
  'end',
  'emu.addMemoryCallback(function(addr, value)',
  '  local st = emu.getState()',
  '  local t = {}',
  '  for i = 0, 5 do t[#t + 1] = chan(st, i) end',
  '  out:write(string.format("%d W %04X %02X | %s\\n", st.masterClock, addr, value, table.concat(t, " | ")))',
  'end, emu.callbackType.write, 0x0800, 0x0BFF)',
  'emu.addEventCallback(function()',
  '  local st = emu.getState()',
  '  out:write(string.format("%d F\\n", st.masterClock))',
  '  n = n + 1',
  '  if n >= ' + frames + ' then out:close(); emu.stop(0) end',
  'end, emu.eventType.endFrame)',
].join('\n');
const luaPath = path.join(work, 'apu.lua');
fs.writeFileSync(luaPath, lua);
const romCopy = path.join(work, 'song.hes');
let bytes = fs.readFileSync(rom);
{
  // ヘッダのデータ長よりファイルが短い曲は Mesen が開かない。自前は足りない所を $00 として読む(Mesen も DATA ブロックの外は $00)ので $00 で埋める
  const need = 0x20 + bytes.readUInt32LE(0x14);
  if (bytes.length < need && need <= 0x100020) bytes = Buffer.concat([bytes, Buffer.alloc(need - bytes.length, 0x00)]);
  if (track !== null) { bytes = Buffer.from(bytes); bytes[5] = track; }
  fs.writeFileSync(romCopy, bytes);
}
spawnSync(mesen, ['--testRunner', romCopy, luaPath, '--timeout=600'], { encoding: 'utf8', timeout: 660000 });
if (!fs.existsSync(outPath)) { console.error('Mesen が記録を出しませんでした'); process.exit(1); }
const A = [], frameEnds = [];
for (const l of fs.readFileSync(outPath, 'utf8').split(/\r?\n/)) {
  if (!l) continue;
  const sp = l.indexOf(' ');
  const t = +l.slice(0, sp);
  if (l[sp + 1] === 'F') { frameEnds.push(t); continue; }
  const bar = l.indexOf(' | ');
  const head = l.slice(sp + 1, bar).split(' ');
  A.push({ t, a: parseInt(head[1], 16), v: parseInt(head[2], 16), st: l.slice(bar + 3) });
}
if (!has('--keep')) fs.rmSync(work, { recursive: true, force: true }); else console.log('作業フォルダ: ' + work);
// Mesen が時間切れ(--timeout)で止まると、記録は途中までしか無い。短い区間だけ比べて「同じ」と言わないよう、フレーム数が足りなければ失敗にする。
// (描画の間引きを切った設定の Mesen は HES の実行が極端に遅く、300 フレームに届かなかった。HES は普段の設定の Mesen で回す)
if (frameEnds.length < frames - 2) { console.log(`Mesen が記録を出しません(${frames} フレームのうち ${frameEnds.length} フレームで止まった。時間切れの疑い)`); process.exit(1); }

// ── 自前 ──
const { load } = require('./load');
const { MML } = load({ strict: true });
MML.Emu.HesPlayer.DEFER_VBLANK = false; // Mesen には無い救済(タイマ処理中は垂直帰線を後回し)は切って比べる
const p = new MML.Emu.HesPlayer(new Uint8Array(bytes));
const bus = p.bus, cpu = p.cpu, apu = p.apu;
if (typeof apu.runToMaster !== 'function') { console.error('この音源の実装は時刻つきで進められません(apu.runToMaster が無い。9b の作り直し前)'); process.exit(1); }
const chanOf = (c, i) => {
  let sum = 0; for (let k = 0; k < 32; k++) sum += c.wave[k] * (k + 1);
  let s = `${c.timer},${c.wavePos},${c.out},${sum}`;
  if (i >= 4) s += `,${c.lfsr},${c.noiseTimer},${c.noiseOut}`;
  return s;
};
const B = [];
const wr = bus.write.bind(bus);
// Mesen は 1 画面の終わり(その瞬間)と、その時の命令が終わった所で音源を進める。同じ所で進める。
// 画面の終わりと音源への書き込みが同じ命令の中にあることがあるので、書き込みの直前にも「もう過ぎた画面の終わり」を済ませる
let fe = 0, frameEnded = false;
const passFrameEnds = () => { while (fe < frameEnds.length && frameEnds[fe] <= bus.clock) { apu.runToMaster(frameEnds[fe]); fe++; frameEnded = true; } };
bus.write = (addr, v) => {
  if (addr >= 0x0800 && addr < 0x0C00 && bus.mpr[0] === 0xFF) { passFrameEnds(); B.push({ t: bus.clock, a: addr, v, st: apu.ch.map(chanOf).join(' | ') }); }
  wr(addr, v);
};
p.initSong(p.header.firstTrack);
const endT = A.length ? A[A.length - 1].t : 0;
while (bus.clock < endT) {
  cpu.step();
  passFrameEnds();
  if (frameEnded) { apu.runToMaster(bus.clock); frameEnded = false; }
}

// ── 比べる ──
const NAMES = ['タイマ', '位置', '出力', '波形', '乱数', 'ノイズタイマ', 'ノイズ出力'];
const ctx = parseInt(arg('--context', '6'), 10);
const show = (e) => e ? `${String(e.t).padStart(11)} ${e.a.toString(16).padStart(4, '0')}=${e.v.toString(16).padStart(2, '0')}  ${e.st}` : '(無い)';
console.log(`${path.basename(rom)}${track !== null ? ' 曲 ' + track : ''}: Mesen ${A.length} 回、自前 ${B.length} 回の書き込み(${frames} フレーム)`);
const n = Math.min(A.length, B.length);
for (let i = 0; i < n; i++) {
  const x = A[i], y = B[i];
  if (x.t === y.t && x.a === y.a && x.v === y.v && x.st === y.st) continue;
  let why;
  if (x.a !== y.a || x.v !== y.v) why = '書き込みの並びが違う(音源より前の問題。pce-iotrace.js で見る)';
  else if (x.t !== y.t) why = `書き込みの時刻が違う(Mesen ${x.t} / 自前 ${y.t})`;
  else {
    const ca = x.st.split(' | '), cb = y.st.split(' | '); const d = [];
    for (let c = 0; c < 6; c++) { const fa = ca[c].split(','), fb = cb[c].split(','); for (let k = 0; k < fa.length; k++) if (fa[k] !== fb[k]) d.push(`ch${c + 1} の${NAMES[k]}(Mesen ${fa[k]} / 自前 ${fb[k]})`); }
    why = d.join('、');
  }
  console.log(`\n食い違い: ${i} 回目の書き込みの直前。${why}`);
  for (let k = Math.max(0, i - ctx); k <= Math.min(n - 1, i + 2); k++) {
    console.log((k === i ? '> ' : '  ') + 'M ' + show(A[k]));
    if (A[k].st !== B[k].st || A[k].t !== B[k].t) console.log((k === i ? '> ' : '  ') + '自 ' + show(B[k]));
  }
  process.exit(1);
}
if (A.length !== B.length) { console.log(`食い違い: 書き込みの回数が違う(Mesen ${A.length} / 自前 ${B.length})`); process.exit(1); }
console.log(`終わりまで同じ(${n} 行)`);
