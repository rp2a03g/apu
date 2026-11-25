#!/usr/bin/env node
/*
 * HuCard の ROM を自前の PC エンジン(src/emulator/pce/)と Mesen 2 で無操作で走らせ、3 つを比べる(段階 9c)。
 *
 *   node tools/headless/pce-rom-ab.js "game.pce" [--frames 300] [--shots 60,180,300] [--mesen "C:\path\Mesen.exe"]
 *        [--no-io] [--context 10] [--out <フォルダ>] [--keep] [--pad pad2|pad6|tap]
 *   拡張子が .sgx なら SuperGrafx として回す(Mesen も拡張子で SuperGrafx にする)。RAM は 32K、2 個目の VDC の VRAM とスプライト表も比べる。
 *   --pad: 自前のパッドの種類。Mesen 側は設定(settings.json の PcEngine.Port1.Type)で決まるので、その種類にした Mesen の写しを --mesen で渡す
 *   node tools/headless/pce-rom-ab.js --all "<フォルダ>" [--frames 300] [--jobs 4] [--out result.txt] [--limit N]
 *
 * 1. I/O の読み書き(論理番地 $0000-$1FFF で、MPR0 が $FF の時だけ。ST0/ST1/ST2 は番地 0/2/3 への書き込みとして)を、マスタークロックの時刻つきで 1 行ずつ。
 *    I/O を別の窓(MPR1-7)から触るソフトや、MPR0 に ROM を割り当てている間の ST0-2 は記録に入らない(メモリと画面の比較には効く)。
 *    最初に食い違った所の前後を出す。--no-io で省く(長い時間を回す時)。
 * 2. 最後のフレームの終わりの中身: VRAM(32768 語)、スプライト表(256 語)、パレット(512 語)、RAM(8K)。違う個数と最初の数個。
 * 3. --shots のフレームの画面。Mesen の絵は設定で上下左右が切られているので、自前の絵の中で一番合う位置を探して重ねる。
 *    色は「Mesen の色 → 自前の色」の対応を画素から作って比べる(Mesen の色の表は設定で変えられる物なので、値そのものは比べない)。
 *    合わなかった画素の数を出し、--out があれば両方の PNG と違いの絵を残す。
 *
 * フレームの数え方: どちらも「走査線 256 に入った所」で 1 フレーム。電源投入からの数なのでそのまま対応する。
 *   ただし画面だけは 1 つずれる: Mesen の Lua で endFrame の時に取れる絵は、まだ 1 つ前のフレームの物(絵の差し替えが endFrame の通知より後)。
 *   なので「--shots N」は Mesen の N 回目の endFrame で取った絵=N-1 フレーム目の絵を、自前の N-1 フレーム目と比べる。
 * 入力は与えない(Mesen の --testRunner では入力が入らない)。
 * Mesen の設定: 電源投入時のメモリが乱数(既定)だと比べられないので、「RamPowerOnState = AllZeros」「DisableFrameSkipping = true」にした
 *   Mesen の写しを使う(Mesen.exe と同じフォルダに settings.json を置くと、そのフォルダだけで完結する。普段使いの設定は触らない)。
 *   描画の間引き(DisableFrameSkipping = false)が入っていると、最高速で回す時に絵が古いまま残り、スプライト衝突の判定も飛ぶ。
 * 終了コード: 3 つとも同じなら 0。CD 本体のレジスタ($1800-$1BFF)の読みの値だけが違う行は「同じ」に数え、行数を別に出す(CD の中身は段階 9e)。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (n) => process.argv.includes(n);
const USAGE = 'usage: node tools/headless/pce-rom-ab.js "game.pce" [--frames N] [--shots a,b,c] --mesen "C:\\path\\Mesen.exe"(または環境変数 MESEN_EXE) | --all "<folder>"';

// ── まとめて回す ──
if (has('--all')) {
  const folder = arg('--all', null);
  if (!folder || !fs.existsSync(folder)) { console.error(USAGE); process.exit(2); }
  const walk = (dir, out) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(pce|sgx)$/i.test(e.name)) out.push(p); } return out; };
  let files = walk(folder, []).sort();
  // 拡張子が .pce でも中身が HES(先頭 "HESM")の物は曲データなので外す(HES は pce-iotrace.js / pce-apu-ab.js で比べる)
  { const isHes = (p) => { const fd = fs.openSync(p, 'r'), b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('latin1') === 'HESM'; };
    const n0 = files.length; files = files.filter(p => !isHes(p)); if (files.length !== n0) console.log(`中身が HES の物 ${n0 - files.length} 本は外しました(残り ${files.length} 本)`); }
  const limit = parseInt(arg('--limit', '0'), 10); if (limit) files = files.slice(0, limit);
  const jobs = Math.max(1, parseInt(arg('--jobs', '4'), 10));
  const pass = ['--frames', arg('--frames', '300')].concat(has('--shots') ? ['--shots', arg('--shots', '')] : []).concat(has('--no-io') ? ['--no-io'] : []).concat(has('--pad') ? ['--pad', arg('--pad', 'pad2')] : []).concat(has('--mesen') ? ['--mesen', arg('--mesen', '')] : []);
  const rows = []; let next = 0, running = 0;
  const finishAll = () => {
    rows.sort((a, b) => a.file < b.file ? -1 : 1);
    const ok = rows.filter(r => r.ok);
    if (arg('--out', null)) fs.writeFileSync(arg('--out', null), rows.map(r => (r.ok ? 'OK  ' : 'NG  ') + r.file + ': ' + r.line).join('\n') + '\n');
    console.log(`\nROM ${files.length} 本(${pass[1]} フレーム): 3 つとも同じ ${ok.length}、違う ${rows.length - ok.length}`);
    for (const r of rows.filter(x => !x.ok).slice(0, 60)) console.log('  ' + r.file + ': ' + r.line);
    process.exit(rows.length === ok.length ? 0 : 1);
  };
  const pump = () => {
    while (running < jobs && next < files.length) {
      const file = files[next++]; running++;
      const ch = spawn(process.execPath, [__filename, file].concat(pass), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
      ch.on('close', (code) => {
        const line = (out.split(/\r?\n/).find(l => /^まとめ:/.test(l)) || out.trim().split(/\r?\n/).pop() || '').replace(/^まとめ:\s*/, '').trim().slice(0, 200);
        rows.push({ file: path.basename(file), ok: code === 0, line });
        process.stderr.write(code === 0 ? '.' : 'x');
        running--; if (next >= files.length && running === 0) finishAll(); else pump();
      });
    }
  };
  pump();
  return;
}

const rom = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(pce|sgx)$/i.test(a));
const frames = parseInt(arg('--frames', '300'), 10);
const mesen = arg('--mesen', process.env.MESEN_EXE || null);
if (!rom || !mesen || !fs.existsSync(mesen)) { console.error(USAGE); process.exit(2); }
const isSgx = /\.sgx$/i.test(rom);
const shots = (arg('--shots', String(frames)) || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 1 && x <= frames);
const withIo = !has('--no-io');
const ctx = parseInt(arg('--context', '10'), 10);
const outDir = arg('--out', null);
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const base = path.basename(rom).replace(/\.[^.]+$/, '');

// ── Mesen ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-rom-'));
const W = work.replace(/\\/g, '/');
const lua = [
  'local n = 0',
  'local shots = {' + shots.map(s => '[' + s + ']=true').join(',') + '}',
  withIo ? 'local out = io.open("' + W + '/io.txt", "w")' : '',
  withIo ? 'local function cb(kind) return function(addr, value) local st = emu.getState() if st["memoryManager.mpr[0]"] == 255 then out:write(string.format("%d %s %04X %02X\\n", st.masterClock or 0, kind, addr, value)) end end end' : '',
  withIo ? 'emu.addMemoryCallback(cb("W"), emu.callbackType.write, 0x0000, 0x1FFF)' : '',
  withIo ? 'emu.addMemoryCallback(cb("R"), emu.callbackType.read, 0x0000, 0x1FFF)' : '',
  'local function dump(name, mt, len)',
  '  local f = io.open("' + W + '/" .. name .. ".bin", "wb")',
  '  local t = {}',
  '  for i = 0, len - 1 do t[#t + 1] = string.char(emu.read(i, mt)) if #t >= 4096 then f:write(table.concat(t)) t = {} end end',
  '  f:write(table.concat(t)) f:close()',
  'end',
  'emu.addEventCallback(function()',
  '  local ok, err = pcall(function()',
  '    n = n + 1',
  '    if shots[n] then local f = io.open("' + W + '/shot_" .. n .. ".png", "wb") f:write(emu.takeScreenshot()) f:close() end',
  '    if n >= ' + frames + ' then',
  '      dump("vram", emu.memType.pceVideoRam, 0x10000) dump("satb", emu.memType.pceSpriteRam, 0x200)',
  '      dump("pal", emu.memType.pcePaletteRam, 0x400) dump("ram", emu.memType.pceWorkRam, ' + (isSgx ? '0x8000' : '0x2000') + ')',
  isSgx ? '      dump("vram2", emu.memType.pceVideoRamVdc2, 0x10000) dump("satb2", emu.memType.pceSpriteRamVdc2, 0x200)' : '',
  '      local st = emu.getState() local t = io.open("' + W + '/state.txt", "w")',
  '      t:write(string.format("pc=%04x clock=%d", st["cpu.pc"] or 0, st.masterClock or 0)) t:close()',
  withIo ? '      out:close()' : '',
  '      emu.stop(0)',
  '    end',
  '  end)',
  '  if not ok then local e = io.open("' + W + '/error.txt", "a") e:write(tostring(err) .. "\\n") e:close() emu.stop(1) end',
  'end, emu.eventType.endFrame)',
].filter(Boolean).join('\n');
fs.writeFileSync(path.join(work, 'ab.lua'), lua);
// Mesen はバックアップ RAM を「Saves/<ROM の名前>.sav」に残し、次に同じ名前で起動すると読み込む。前の実行の中身が残っていると
// ゲームの動きが変わる(セーブを探す時間が変わる)ので、毎回ちがう名前の写しで回し、出来たセーブは消す。
const romName = 'abrom-' + process.pid + '-' + Date.now().toString(36);
const romCopy = path.join(work, romName + path.extname(rom).toLowerCase());
// ビットが逆順の吸い出しは、自前が戻した後の中身を Mesen へ渡す(Mesen は戻さないので、そのままでは動かず比べる意味が無い)
{ const { load: ld, readBytes: rb } = require('./load'); const E0 = ld({ strict: true }).MML.Emu; const card = new E0.PceCard(rb(rom)); if (card.reversed) fs.writeFileSync(romCopy, Buffer.from(card.rom.subarray(0, card.fileSize))); else fs.copyFileSync(rom, romCopy); }
spawnSync(mesen, ['--testRunner', romCopy, path.join(work, 'ab.lua'), '--timeout=' + Math.max(120, frames)], { encoding: 'utf8', timeout: Math.max(180000, frames * 1000) });
for (const home of [path.dirname(mesen), path.join(os.homedir(), 'Documents', 'MesenCE'), path.join(os.homedir(), 'Documents', 'Mesen2')]) {
  for (const sub of ['Saves', 'RecentGames', 'SaveStates']) { const dir = path.join(home, sub); let names = []; try { names = fs.readdirSync(dir); } catch (e) { /* 無ければよい */ } for (const n of names) if (n.startsWith(romName)) fs.rmSync(path.join(dir, n), { force: true }); }
}
const cleanup = () => { if (!has('--keep')) fs.rmSync(work, { recursive: true, force: true }); else console.log('作業フォルダ: ' + work); };
if (!fs.existsSync(path.join(work, 'state.txt'))) {
  let e = ''; try { e = fs.readFileSync(path.join(work, 'error.txt'), 'utf8'); } catch (x) { /* 無ければよい */ }
  console.log('まとめ: Mesen が記録を出しません ' + e.trim().slice(0, 200)); cleanup(); process.exit(1);
}

// ── 自前 ──
const { load, readBytes } = require('./load');
const { writePng } = require('./pce-run');
const { MML } = load({ strict: true });
const pce = new MML.Emu.PceConsole(readBytes(rom), { model: isSgx ? 'sgx' : 'pce', pad: arg('--pad', 'pad2') });
const B = [];
if (withIo) pce.onIo = (k, a, v) => { if (a < 0x2000 && pce.mpr[0] === 0xFF) B.push({ t: pce.clock, k, a, v }); };
const myShots = {};
// Mesen が控えを取った時の時計。同じ負荷で繰り返すと、Mesen は稀に(45 回に 1 回ほど)数えたフレームが 1 つずれた所で止まる
// (I/O と画面は同じなのに RAM のフレーム数の番地だけ違う、という形で見つかった。自前は毎回同じ結果になる)。
// なので「同じフレーム番号」ではなく「同じ時計の区切り」のメモリを比べる。合う区切りが無ければフレーム番号で取り、その旨を出す
const mesenClock = +(/clock=(\d+)/.exec(fs.readFileSync(path.join(work, 'state.txt'), 'utf8')) || [0, 0])[1];
let memAt = null, memByFrame = null;
pce.onFrameExact = () => { const hit = pce.clock === mesenClock, byFrame = pce.frameCount === frames; if (!hit && !byFrame) return; const m = { vram: pce.vdc.vram.slice(), satb: pce.vdc.satb.slice(), pal: pce.vce.pal.slice(), ram: pce.ram.slice(), vram2: pce.vdc2 ? pce.vdc2.vram.slice() : null, satb2: pce.vdc2 ? pce.vdc2.satb.slice() : null, pc: pce.cpu.PC, clock: pce.clock, frame: pce.frameCount }; if (hit) memAt = m; if (byFrame) memByFrame = m; };
for (let f = 1; f <= frames + 2; f++) {
  pce._frameFlag = false;
  let guard = 0;
  while (!pce._frameFlag && ++guard < 2000000) pce.cpu.step();
  if (shots.includes(f + 1)) myShots[f + 1] = { w: pce.frameWidth, h: pce.frameHeight, px: Uint32Array.from(pce.frame), idx: Uint16Array.from(pce.frameIdx) };
}

if (!memAt) { memAt = memByFrame; console.log('(Mesen が控えを取った時計に合う区切りが自前に無いので、同じフレーム番号のメモリで比べます)'); }
else if (memAt.frame !== frames) console.log(`(Mesen は ${frames} 回目ではなく ${memAt.frame} フレーム目の区切りで止まっていた。同じ時計の区切りのメモリで比べます)`);
console.log(`${path.basename(rom)}: ${MML.Emu.PceConsole.describe(pce)}、${frames} フレーム。Mesen ${fs.readFileSync(path.join(work, 'state.txt'), 'utf8')} / 自前 clock=${memAt ? memAt.clock : pce.clock}`);
const summary = [];
let allOk = true;

// ── 1. I/O ──
if (withIo) {
  const A = fs.readFileSync(path.join(work, 'io.txt'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { const p = l.split(' '); return { t: +p[0], k: p[1], a: parseInt(p[2], 16), v: parseInt(p[3], 16) }; });
  const fmt = (e) => (e ? `${String(e.t).padStart(10)} ${e.k} ${e.a.toString(16).padStart(4, '0')} ${e.v.toString(16).padStart(2, '0')}` : ''.padStart(21));
  // CD 本体のレジスタの読みは、番地と時刻が同じなら値が違っても並びは同じとみなし、違った行数を別に数える(CD/ADPCM の中身は段階 9e)
  let cdDiff = 0;
  const isCd = (e) => e.k === 'R' && e.a >= 0x1800 && e.a < 0x1C00;
  const same = (x, y) => x && y && x.k === y.k && x.a === y.a && (x.v === y.v || isCd(x));
  const endT = A.length ? A[A.length - 1].t : 0;
  while (B.length && B[B.length - 1].t > endT) B.pop();
  let i = 0, exact = 0, maxDt = 0;
  const n = Math.min(A.length, B.length);
  let firstDt = -1;
  while (i < n && same(A[i], B[i])) { const d = Math.abs(B[i].t - A[i].t); if (d === 0) exact++; else if (firstDt < 0) firstDt = i; if (d > maxDt) maxDt = d; if (A[i].v !== B[i].v) cdDiff++; i++; }
  const showAt = (at) => { console.log('  ' + 'Mesen'.padEnd(23) + '自前'); for (let k = -ctx; k < ctx; k++) if (at + k >= 0) console.log((k === 0 ? '> ' : '  ') + fmt(A[at + k]).padEnd(23) + fmt(B[at + k]) + (same(A[at + k], B[at + k]) ? '   Δt ' + (B[at + k].t - A[at + k].t) : '')); };
  // 終わりの数行は、最後のフレームの切れ目の取り方で片方にだけ残ることがある
  if (i >= n && A.length === B.length) {
    console.log(`I/O: 終わりまで同じ(${i} 行、うち時刻も同じ ${exact}、時刻の差の最大 ${maxDt} マスタークロック)`);
    summary.push(`I/O ${i} 行同じ` + (maxDt ? `(時刻の差 最大 ${maxDt}、最初は ${firstDt} 行目=およそ ${Math.floor(A[firstDt].t / (1365 * 262.5))} フレーム目)` : '') + (cdDiff ? `(うち CD のレジスタの読みの値だけ違う ${cdDiff} 行=段階 9e)` : ''));
    if (cdDiff) console.log(`  うち CD のレジスタ($1800-$1BFF)の読みの値だけ違う行: ${cdDiff}(番地と時刻は同じ。CD/ADPCM の中身は段階 9e)`);
    if (maxDt) { allOk = false; console.log(`時刻が最初にずれる所(${firstDt} 行目):`); showAt(firstDt); }
  } else {
    allOk = false;
    console.log(`I/O: ${i} 行が同じ(うち時刻も同じ ${exact}、時刻の差の最大 ${maxDt})。${i} 行目で食い違い(Mesen ${A.length} 行 / 自前 ${B.length} 行)`);
    showAt(i);
    const fr = A[i] ? Math.floor(A[i].t / (1365 * 262.5)) : -1;
    summary.push(`I/O ${i} 行目で食い違い(およそ ${fr} フレーム目)`);
  }
}

// ── 2. メモリ ──
{
  const rd = (name) => fs.readFileSync(path.join(work, name + '.bin'));
  const words = (buf) => { const n = buf.length >> 1, o = new Uint16Array(n); for (let i = 0; i < n; i++) o[i] = buf[i * 2] | (buf[i * 2 + 1] << 8); return o; };
  const cmp = (label, a, b, hex) => {
    let bad = 0; const first = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { bad++; if (first.length < 6) first.push(`$${i.toString(16)}: Mesen ${a[i].toString(16).padStart(hex, '0')} / 自前 ${b[i].toString(16).padStart(hex, '0')}`); }
    if (bad) { allOk = false; console.log(`${label}: 違う ${bad} / ${a.length}  ${first.join(', ')}`); summary.push(`${label} ${bad} 個違う`); }
    return bad;
  };
  const mine = memAt || { vram: pce.vdc.vram, satb: pce.vdc.satb, pal: pce.vce.pal, ram: pce.ram, vram2: pce.vdc2 ? pce.vdc2.vram : null, satb2: pce.vdc2 ? pce.vdc2.satb : null };
  const bad = cmp('VRAM', words(rd('vram')), mine.vram, 4) + cmp('スプライト表', words(rd('satb')), mine.satb, 4)
    + cmp('パレット', words(rd('pal')), mine.pal, 3) + cmp('RAM', rd('ram'), mine.ram, 2)
    + (isSgx ? cmp('VRAM(VDC2)', words(rd('vram2')), mine.vram2, 4) + cmp('スプライト表(VDC2)', words(rd('satb2')), mine.satb2, 4) : 0);
  if (!bad) { console.log('メモリ: VRAM・スプライト表・パレット・RAM とも同じ'); summary.push('メモリ同じ'); }
}

// ── 3. 画面 ──
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len); if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } else if (type === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xFF;
    }
  }
  const out = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (0xFF000000 | (px[i * bpp + 2] << 16) | (px[i * bpp + 1] << 8) | px[i * bpp]) >>> 0;
  return { w, h, px: out };
}
// Mesen の絵(m)を自前の絵(o)の (dx, dy) に重ねた時の、合わない画素の数。色は「Mesen の色ごとに、一番多く重なった自前の色」を対応とみなす
function mismatch(m, o, dx, dy) {
  if (mesenPal) { let bad = 0; const colors = new Set(); for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const a = m.px[y * m.w + x]; colors.add(a); if (a !== o.px[(y + dy) * o.w + x + dx]) bad++; } return { bad, map: { get: (a) => a }, colors: colors.size }; }
  const pair = new Map();
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const a = m.px[y * m.w + x], b = o.px[(y + dy) * o.w + x + dx];
    let t = pair.get(a); if (!t) pair.set(a, t = new Map());
    t.set(b, (t.get(b) || 0) + 1);
  }
  let bad = 0; const map = new Map();
  for (const [a, t] of pair) { let best = 0, bc = 0, sum = 0; for (const [b, c] of t) { sum += c; if (c > best) { best = c; bc = b; } } map.set(a, bc); bad += sum - best; }
  return { bad, map, colors: pair.size };
}
// Mesen の色の表(Mesen.exe と同じフォルダか Documents の settings.json)。読めれば、自前の色の番号をこの表で色に直して値そのものを比べる
// (白黒の印つきは Mesen と同じ式: 0.299R+0.587G+0.114B の切り捨て)。読めなければ「色の対応を画素から作る」比べ方のまま
let mesenPal = null;
for (const dir of [path.dirname(mesen), path.join(os.homedir(), 'Documents', 'MesenCE'), path.join(os.homedir(), 'Documents', 'Mesen2')]) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    const p = cfg.PcEngine && cfg.PcEngine.Palette;
    if (p && p.length === 512) {
      mesenPal = new Uint32Array(1024);
      for (let i = 0; i < 512; i++) { const r = (p[i] >> 16) & 0xFF, g = (p[i] >> 8) & 0xFF, b = p[i] & 0xFF; mesenPal[i] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; const y = Math.max(0, Math.min(255, Math.floor(0.299 * r + 0.587 * g + 0.114 * b))); mesenPal[i | 0x200] = (0xFF000000 | (y << 16) | (y << 8) | y) >>> 0; }
      break;
    }
  } catch (e) { /* 次の場所 */ }
}
if (!mesenPal) console.log('(Mesen の色の表が読めないので、色は画素から作った対応で比べます)');
for (const f of shots) {
  const file = path.join(work, 'shot_' + f + '.png');
  if (!fs.existsSync(file)) { console.log(`画面 f=${f}: Mesen の絵が無い`); allOk = false; summary.push(`画面 ${f} 無し`); continue; }
  const m = decodePng(fs.readFileSync(file)), o = myShots[f];
  if (mesenPal) { o.px = new Uint32Array(o.idx.length); for (let i = 0; i < o.idx.length; i++) o.px[i] = mesenPal[o.idx[i]]; }
  if (m.w > o.w || m.h > o.h) { console.log(`画面 f=${f}: 大きさが合わない(Mesen ${m.w}x${m.h} / 自前 ${o.w}x${o.h})`); allOk = false; summary.push(`画面 ${f} 大きさ違い`); if (outDir) { fs.copyFileSync(file, path.join(outDir, `${base}_${f}_mesen.png`)); writePng(path.join(outDir, `${base}_${f}_own.png`), o.px, o.w, o.h); } continue; }
  let best = null;
  for (let dy = 0; dy <= o.h - m.h; dy++) for (let dx = 0; dx <= o.w - m.w; dx++) { const r = mismatch(m, o, dx, dy); if (!best || r.bad < best.bad) best = Object.assign(r, { dx, dy }); }
  const ok = best.bad === 0;
  if (!ok) allOk = false;
  console.log(`画面 f=${f}: Mesen ${m.w}x${m.h}(色 ${best.colors})を自前 ${o.w}x${o.h} の (${best.dx},${best.dy}) に重ねて、合わない画素 ${best.bad} / ${m.w * m.h}`);
  summary.push(`画面 ${f}: ${ok ? '同じ' : best.bad + ' 画素違う'}`);
  if (outDir) {
    fs.copyFileSync(file, path.join(outDir, `${base}_${f}_mesen.png`));
    writePng(path.join(outDir, `${base}_${f}_own.png`), o.px, o.w, o.h);
    if (!ok) { // 違いの絵: 合う所は暗く、違う所は赤
      const d = new Uint32Array(m.w * m.h);
      for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const a = m.px[y * m.w + x], b = o.px[(y + best.dy) * o.w + x + best.dx]; d[y * m.w + x] = best.map.get(a) === b ? ((0xFF000000 | ((b >> 2) & 0x3F3F3F)) >>> 0) : 0xFF0000FF; }
      writePng(path.join(outDir, `${base}_${f}_diff.png`), d, m.w, m.h);
    }
  }
}
console.log('まとめ: ' + summary.join('、'));
cleanup();
process.exit(allOk ? 0 : 1);
