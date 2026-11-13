#!/usr/bin/env node
/*
 * 自前ゲームボーイエミュレータと Mesen 2 を同じ ROM で走らせ、音源レジスタの書き込み列をフレームごとに突き合わせる(段階 8f)。
 *
 *   node tools/headless/gb-mesen-ab.js "rom.gb" [--frames 1200] [--mesen "C:\path\Mesen.exe"] [--model dmg|cgb|auto] [--keep]
 *   node tools/headless/gb-mesen-ab.js "song.gbs" [--frames 1200] …   GBS(Mesen は最初の曲を鳴らす)。実ソフトの音楽ドライバでの突き合わせ。
 *     GBS はフレームの区切り方が両者で違うので、通しの並び(先頭の位置を探して合わせる)だけで比べる
 *     Mesen の場所は --mesen か環境変数 MESEN_EXE。入力は与えない(起動して放っておいた時の音を比べる)
 *
 * やること:
 *   1. tools/mesen/vgm-recorder.lua を「起動と同時に録音、frames フレームで止める、フレーム内の時刻つき」に書き換えた写しを作り、
 *      Mesen.exe --testRunner rom script.lua で走らせる(GUI 無し、最高速)。出てきた VGM を読む
 *   2. 同じ ROM を自前エミュで frames フレーム回し、録音の書き込み列を取る
 *   3. どちらも「フレーム(VBlank の頭で区切る)ごとの (番地, 値) の並び」にして比べる。起動時の状態の違いで全体が数フレームずれる事が
 *      ある(Mesen はブート ROM を実行してからゲームに入る)ので、ずらし −600〜+20 フレームのうち一番合う所で数える
 * 出す物: 一致したフレームの割合、最初に食い違ったフレームと中身、フレーム内の時刻(サンプル)の差の分布
 * 読み方: 並びが合って時刻だけ数サンプル違うのは起動時の DIV/LY の位相の差。並びが違えば CPU/タイマ/割り込み/音源のどこかが違う。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const rom = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(gb|gbc|gbs)$/i.test(a));
const isGbs = /\.gbs$/i.test(rom || '');
const frames = parseInt(arg('--frames', '1200'), 10);
const mesen = arg('--mesen', process.env.MESEN_EXE || null);
if (!rom || !mesen || !fs.existsSync(mesen)) { console.error('usage: node tools/headless/gb-mesen-ab.js "rom.gb" [--frames N] --mesen "C:\\path\\Mesen.exe"(または環境変数 MESEN_EXE)'); process.exit(2); }

// ── 1. Mesen ──
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ab-'));
let lua = fs.readFileSync(path.join(__dirname, '..', 'mesen', 'vgm-recorder.lua'), 'utf8');
const set = (re, to) => { if (!re.test(lua)) throw new Error('vgm-recorder.lua の形が変わった: ' + re); lua = lua.replace(re, to); };
set(/autoStart\s*=\s*false/, 'autoStart       = true');
set(/preciseTiming\s*=\s*false/, 'preciseTiming   = true');
set(/stopAfterFrames\s*=\s*0/, 'stopAfterFrames = ' + frames);
set(/outDir\s*=\s*nil/, 'outDir          = ' + JSON.stringify(work.replace(/\\/g, '/') + '/'));
const luaPath = path.join(work, 'rec.lua');
fs.writeFileSync(luaPath, lua);
const run = spawnSync(mesen, ['--testRunner', path.resolve(rom), luaPath, '--timeout=120'], { encoding: 'utf8', timeout: 180000 });
const vgmFile = fs.readdirSync(work).find(f => /\.vgm$/i.test(f));
if (!vgmFile) { console.error('Mesen が VGM を出しませんでした(終了コード ' + run.status + ')。' + (run.stderr || '').slice(0, 300)); process.exit(1); }
const vgm = fs.readFileSync(path.join(work, vgmFile));

// VGM → フレームごとの [{ a, v, t }](0x62 か、0x61 の合計 735 サンプルで 1 フレーム)
function vgmFrames(b) {
  const data = 0x34 + b.readUInt32LE(0x34), out = [[]];
  let p = data, t = 0;
  const adv = (n) => { t += n; while (t >= 735) { t -= 735; out.push([]); } };
  while (p < b.length) {
    const c = b[p];
    if (c === 0x66) break;
    if (c === 0xB3) { out[out.length - 1].push({ a: b[p + 1], v: b[p + 2], t }); p += 3; }
    else if (c === 0x62) { adv(735); p += 1; }
    else if (c === 0x63) { adv(882); p += 1; }
    else if (c === 0x61) { adv(b.readUInt16LE(p + 1)); p += 3; }
    else if (c >= 0x70 && c <= 0x7F) { adv((c & 15) + 1); p += 1; }
    else if (c === 0x67) { p += 7 + b.readUInt32LE(p + 3); }
    else { console.error('VGM に知らない命令 $' + c.toString(16) + ' @' + p); break; }
  }
  return out;
}
const mFrames = vgmFrames(vgm);

// ── 2. 自前 ──
const { MML } = load({ strict: true });
if (isGbs) {
  // GBS: 書き込みを 1 列に並べ、短い方の先頭 12 個が相手のどこに現れるかで位置を合わせてから、何個続けて同じかを数える
  const p = new MML.Emu.GbsPlayer(readBytes(rom));
  const B = [];
  p.bus.onWrite = (addr, value) => { B.push((addr - 0xFF10) * 256 + value); };
  p.initSong(Math.max(0, (p.header.firstSong || 1) - 1)); // Mesen はヘッダの「最初の曲」を鳴らす
  const B0 = B.length; // INIT の書き込み数
  for (let f = 0; f < Math.ceil(frames * p.frameRate / 60) + 30; f++) p.renderFrame(44100, true);
  const A = []; for (const fr of mFrames) for (const w of fr) A.push(w.a * 256 + w.v);
  const find = (hay, needle, from) => { for (let i = 0; i + needle.length <= hay.length && i < 4000; i++) { let k = 0; while (k < needle.length && hay[i + k] === needle[k]) k++; if (k === needle.length) return i; } return -1; };
  // PLAY の書き込み(INIT の後)から 12 個を取り、Mesen 側で探す
  const probe = B.slice(B0, B0 + 12);
  const at = probe.length === 12 ? find(A, probe) : -1;
  if (at < 0) { console.log(`${path.basename(rom)}: Mesen ${A.length} 書き込み、自前 ${B.length} 書き込み(INIT ${B0})。位置を合わせられない(最初の 12 個が Mesen 側に見つからない)`); { const sh = (x) => x.slice(0, 36).map((v) => (v >> 8).toString(16) + '=' + (v & 255).toString(16)).join(' '); console.log('  Mesen の先頭: ' + sh(A)); console.log('  自前の INIT: ' + sh(B.slice(0, B0))); console.log('  自前の PLAY: ' + sh(B.slice(B0))); } if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true }); process.exit(1); }
  let n = 0; while (at + n < A.length && B0 + n < B.length && A[at + n] === B[B0 + n]) n++;
  const total = Math.min(A.length - at, B.length - B0);
  const fmt = (x) => (x === undefined ? '(なし)' : (x >> 8).toString(16) + '=' + (x & 255).toString(16));
  console.log(`${path.basename(rom)}: ヘッダ ${p.header.playFps.toFixed(2)}Hz/実際 ${p.frameRate.toFixed(2)}Hz、Mesen ${A.length} 書き込み、自前 ${B.length} 書き込み`);
  console.log(`通しの並び: PLAY の先頭から ${n} 個が同じ(比べられる長さ ${total})` + (n >= total - 8 ? ' → 終わりまで一致' : ` → ${n} 個目で食い違い: Mesen ${fmt(A[at + n])} ${fmt(A[at + n + 1])} / 自前 ${fmt(B[B0 + n])} ${fmt(B[B0 + n + 1])}`));
  if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
  process.exit(n >= total - 8 ? 0 : 1);
}
const gb = new MML.Emu.GbConsole(readBytes(rom), { model: arg('--model', 'auto') });
gb.startRecording();
for (let f = 0; f < frames + 24; f++) gb.runFrame();
const oFrames = gb.stopRecording().map(fr => fr.filter(w => w.addr !== undefined).map(w => ({ a: w.addr - 0xFF10, v: w.value, t: Math.floor(w.t * 735 / 70224) })));
// どちらも先頭フレームは「録音開始時の像」を含むので捨てる
mFrames[0] = []; oFrames[0] = [];

// ── 3. 比べる ──
const keyOf = (fr) => fr.map(w => w.a.toString(16) + '=' + w.v.toString(16)).join(' ');
const mKeys = mFrames.map(keyOf), oKeys = oFrames.map(keyOf);
const key = (fr) => (fr === undefined ? '' : keyOf(fr));
function score(shift) {
  let same = 0, n = 0, both = 0;
  for (let f = 1; f < frames; f++) {
    const a = mKeys[f], b = oKeys[f + shift];
    if (a === undefined || b === undefined) continue;
    n++;
    if (a === b) { same++; if (a.length) both++; }
  }
  return { shift, same, n, both };
}
let best = null;
// Mesen はブート ROM(起動ロゴ)を実行してからゲームに入るので、その分(数百フレーム)自前が先に進んでいる。広く探し、書き込みのあるフレームの一致で選ぶ
for (let s = -600; s <= 20; s++) { const r = score(s); if (!best || r.both > best.both || (r.both === best.both && r.same > best.same)) best = r; }
const mW = mFrames.reduce((n, f) => n + f.length, 0), oW = oFrames.reduce((n, f) => n + f.length, 0);
console.log(`${path.basename(rom)}: Mesen ${mFrames.length} フレーム/${mW} 書き込み、自前 ${oFrames.length} フレーム/${oW} 書き込み`);
console.log(`一致したフレーム ${best.same}/${best.n}(${(best.same * 100 / best.n).toFixed(1)}%、うち書き込みのあるフレーム ${best.both})、自前を ${best.shift} フレームずらした時`);
let shown = 0, seqOk = false; const dts = {};
for (let f = 1; f < frames; f++) {
  const a = mFrames[f], b = oFrames[f + best.shift];
  if (!a || !b) continue;
  if (key(a) !== key(b)) { if (shown++ < 4) console.log(`  食い違い f=${f}\n    Mesen: ${key(a).slice(0, 150)}\n    自前 : ${key(b).slice(0, 150)}`); }
  else for (let i = 0; i < a.length; i++) { const d = b[i].t - a[i].t; const k = d < -20 ? '<-20' : d > 20 ? '>20' : String(Math.round(d / 4) * 4); dts[k] = (dts[k] || 0) + 1; }
}
// フレームの区切りに依らない比べ方: 合わせた位置から書き込みを 1 列に並べ、先頭から何個同じか(境界をまたいだだけの食い違いはここで消える)
{
  const flat = (frs, from, to) => { const out = []; for (let f = from; f < to && f < frs.length; f++) if (f >= 0) for (const w of frs[f]) out.push(w.a * 256 + w.v); return out; };
  const start = Math.max(1, 1 - best.shift) + 2;
  const A = flat(mFrames, start, frames - 2), B = flat(oFrames, start + best.shift, frames - 2 + best.shift + 4);
  let n = 0; while (n < A.length && n < B.length && A[n] === B[n]) n++;
  console.log('通しの並び: 先頭から ' + n + ' 個が同じ(Mesen ' + A.length + ' 個)' + (n >= A.length - 8 ? ' → 録った範囲の終わりまで一致' : ' → ' + n + ' 個目で食い違い: Mesen ' + (A[n] >> 8).toString(16) + '=' + (A[n] & 255).toString(16) + ' / 自前 ' + (B[n] >> 8).toString(16) + '=' + (B[n] & 255).toString(16)));
  seqOk = n >= A.length - 8;
}
console.log('フレーム内の時刻の差(自前 − Mesen、サンプル。4 刻み): ' + Object.keys(dts).sort((x, y) => parseFloat(x.replace(/[<>]/g, '')) - parseFloat(y.replace(/[<>]/g, ''))).map(k => `${k}:${dts[k]}`).join('  '));
if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true }); else console.log('作業フォルダ: ' + work);
process.exit(seqOk ? 0 : 1);
