#!/usr/bin/env node
/*
 * 自前 MSX エミュレータの総当たり点検(7f): フォルダの .rom/.mx1/.mx2(と --disk-rom があれば .dsk)を全部ヘッドレスで回し、1 本ごとに
 * 「読めるか(マッパー推定)・載っている音源・起動するか・音が鳴るか・Space/Return/トリガで進むか・固まっていないか・速さ」を JSON Lines に書く。
 * nes-sweep.js の MSX 版。BIOS は指定が無ければ同梱 C-BIOS(機種は --machine、既定 msx2。turboR は実 BIOS が要る)。
 *
 * 使い方: node tools/headless/msx-sweep.js "<folder>" [--out result.jsonl] [--frames 900] [--machine msx2] [--jobs 8]
 *           [--bios-dir dir | --bios-main main.rom [--bios-sub sub.rom]] [--disk-rom disk.rom [--fdc wd2793|tc8566af]] [--cart-b fmpac|msxaudio|scci]
 *   --jobs n     : n 個の子プロセスに分けて並列に回す(親は結果をまとめて集計を出す)
 *   --shard i/n  : 子プロセス用(ファイル一覧の i 番目/n)
 * 1 本の手順: frames フレーム回す。Space を 180/420/660 で 10 フレーム、Return を 300 で 10 フレーム、ジョイスティック 1 のトリガ A を 540 で 5 フレーム押す。
 * 出す物:
 *   load       : 読めたか(マッパー推定で例外なら err)。info: describe()、type: マッパー種別、chips: 音源
 *   msPerFrame : 1 フレームの計算時間(16.7ms を超えると実時間で間に合わない)
 *   colors     : 終わりの画面の色数(1 色のままなら何も描いていない)。mode: 終わりの VDP モード、unsupportedMode: 未対応モードを使った
 *   changedAfterKey : キーを押した後に画面が変わったか(押す前の最後の画面と 60 フレーム後の比較。押して 60 フレーム以内に音が出始めた場合も可)
 *   stuck      : 終わりの 180 フレームで画面が 1 度も変わらず、音源の書き込みも無い(固まった疑い。BIOS の画面で止まっている=起動失敗も含む)
 *   dead       : CPU が HALT で割り込み禁止のまま(二度と動かない)
 *   writes     : 音源レジスタの書き込み回数。audioRms: 後半の音の実効値、audioPeak: 最大。soundAt: 最初に音(RMS>0.002)が出たフレーム(-1 なら無音)
 *   bootAt     : カートリッジのページ 1($4000 台)を初めて実行したフレーム(-1 なら BIOS から出ていない=ヘッダ無し/マッパー違い/ディスク)
 *   error      : 実行中の例外
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const folder = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+(\/\d+)?$/.test(a) && !/\.(jsonl|rom|bin)$/i.test(a) && fs.existsSync(a) && fs.statSync(a).isDirectory());
if (!folder) { console.error('usage: node tools/headless/msx-sweep.js "<folder>" [--out result.jsonl] [--frames 900] [--machine msx2] [--jobs 8] [--disk-rom disk.rom]'); process.exit(2); }
const frames = parseInt(arg('--frames', '900'), 10);
const outFile = arg('--out', null);
const shard = arg('--shard', null);
const jobs = parseInt(arg('--jobs', '1'), 10);
const machine = arg('--machine', 'msx2');
const diskRom = arg('--disk-rom', null);
const fdcKind = arg('--fdc', 'wd2793');
const cartBKind = arg('--cart-b', null);
const passThrough = ['--machine', '--disk-rom', '--fdc', '--cart-b', '--bios-dir', '--bios-main', '--bios-sub', '--bios-logo'];

const files = fs.readdirSync(folder).filter(f => /\.(rom|mx1|mx2)$/i.test(f) || (diskRom && /\.dsk$/i.test(f))).sort().map(f => path.join(folder, f));

if (jobs > 1 && !shard) {
  const lines = [];
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < jobs; i++) {
    const args = [__filename, folder, '--frames', String(frames), '--shard', `${i}/${jobs}`];
    for (const k of passThrough) { const v = arg(k, null); if (v !== null) args.push(k, v); }
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (l) { lines.push(l); if (lines.length % 50 === 0) process.stderr.write(`${lines.length}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`); } } });
    c.on('exit', () => { if (++done === jobs) finish(); });
  }
  function finish() {
    const rows = lines.map(l => JSON.parse(l)).sort((a, b) => a.file.localeCompare(b.file));
    if (outFile) fs.writeFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    summarize(rows);
  }
} else {
  const { MML } = load({ strict: true });
  const bios = pickBios(MML);
  let mine = files;
  if (shard) { const [i, n] = shard.split('/').map(Number); mine = files.filter((_, k) => k % n === i); }
  const rows = [];
  for (const file of mine) {
    const r = runOne(MML, file, bios);
    rows.push(r);
    process.stdout.write(JSON.stringify(r) + '\n');
  }
  if (!shard) { if (outFile) fs.writeFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); summarize(rows); }
}

// BIOS: --bios-main/--bios-dir(msx-run.js と同じ流儀)→ 無ければ同梱 C-BIOS(undefined を渡す)。--disk-rom は bios.disk に
function pickBios(MML) {
  const dir = arg('--bios-dir', process.env.MSX_BIOS_DIR || null);
  const main = arg('--bios-main', null), sub = arg('--bios-sub', null), logo = arg('--bios-logo', null);
  let bios = null;
  if (main) bios = { main: readBytes(main), sub: sub ? readBytes(sub) : null, logo: logo ? readBytes(logo) : null, name: path.basename(main) };
  else if (dir) {
    const pick = (re) => { const f = fs.readdirSync(dir).find(x => re.test(x)); return f ? readBytes(path.join(dir, f)) : null; };
    const m = machine === 'msx1' ? /main_msx1/i : machine === 'msx2plus' ? /main_msx2\+/i : /main_msx2[^+]/i;
    const mb = pick(m);
    if (mb) bios = { main: mb, sub: pick(/cbios_sub/i), logo: pick(machine === 'msx1' ? /logo_msx1/i : machine === 'msx2plus' ? /logo_msx2\+/i : /logo_msx2[^+]/i), name: 'C-BIOS(' + dir + ')' };
  }
  if (!bios) { const C = MML.Emu.MsxConsole; bios = C.hasDefaultBios(machine) ? C.defaultBios(machine) : null; }
  if (!bios) { console.error('BIOS がありません(' + machine + '): --bios-main/--bios-dir を指定してください(turboR は同梱 C-BIOS に無い)'); process.exit(2); }
  if (diskRom) bios.disk = readBytes(diskRom);
  return bios;
}

function hashFrame(fr, w) { const n = w * 240; let h = 2166136261; for (let i = 0; i < n; i += 7) { h ^= fr[i]; h = Math.imul(h, 16777619); } return h >>> 0; }

function runOne(MML, file, bios) {
  const r = { file: path.basename(file) };
  const isDsk = /\.dsk$/i.test(file);
  let msx;
  try {
    const bytes = readBytes(file);
    const cartB = cartBKind ? (cartBKind === 'fmpac' ? { kind: 'fmpac', rom: MML.Emu.MsxConsole.defaultMusicRom() } : { kind: cartBKind }) : null;
    msx = new MML.Emu.MsxConsole(isDsk ? null : bytes, { machine, bios, cartB, disks: isDsk ? [bytes] : [], fdc: fdcKind });
    r.load = true; r.info = MML.Emu.MsxConsole.describe(msx); r.type = msx.cart ? msx.cart.type : (isDsk ? 'disk' : null); r.chips = msx.chips().join('+');
    if (msx.cart) r.typeGuessed = !!msx.cart.guessed;
  } catch (e) { r.load = false; r.err = String(e && e.message || e); return r; }
  const SR = 22050;
  msx.setSampleRate(SR);
  msx.startRecording();
  const KEYS = [[180, 190, 'Space'], [300, 310, 'Return'], [420, 430, 'Space'], [660, 670, 'Space']];
  const keyAt = (f) => KEYS.filter(k => f >= k[0] && f < k[1]).map(k => k[2]);
  const hashes = new Array(frames);
  let writes = 0, soundAt = -1, peak = 0, rmsAcc = 0, rmsN = 0, lastWriteFrame = -1, bootAt = -1;
  let curKeys = new Set();
  const t0 = process.hrtime.bigint();
  try {
    for (let f = 0; f < frames; f++) {
      msx.setController(0, (f >= 540 && f < 545) ? 1 : 0);
      const want = new Set(keyAt(f));
      for (const k of curKeys) if (!want.has(k)) msx.setMsxKey(k, false);
      for (const k of want) if (!curKeys.has(k)) msx.setMsxKey(k, true);
      curKeys = want;
      const a = msx.runFrame();
      hashes[f] = hashFrame(msx.frame, msx.frameWidth);
      if (bootAt < 0 && !isDsk && msx.cpu.pc >= 0x4000 && msx.cpu.pc < 0xC000) bootAt = f;
      if (msx.rec) { const fr = msx.rec.frames.splice(0); for (const x of fr) { const n = x.filter(w => !(w.chip === 'psg' && w.addr >= 14)).length; if (n) { writes += n; lastWriteFrame = f; } } }
      if (a) {
        let s = 0, p = 0;
        for (let i = 0; i < a.length; i++) { const v = a[i]; s += v * v; const q = v < 0 ? -v : v; if (q > p) p = q; }
        const rms = Math.sqrt(s / a.length);
        if (soundAt < 0 && rms > 0.002 && f > 2) soundAt = f;
        if (f >= frames / 2) { rmsAcc += rms; rmsN++; }
        if (p > peak) peak = p;
      }
      if (msx.cpu.halted && !msx.cpu.iff1) { r.dead = f; break; }
    }
  } catch (e) { r.error = String(e && e.stack || e).split('\n').slice(0, 2).join(' | '); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  r.msPerFrame = +(ms / frames).toFixed(2);
  r.colors = new Set(msx.frame.subarray(0, msx.frameWidth * 240)).size;
  r.mode = msx.vdp.mode; if (msx.vdp.unsupportedMode) r.unsupportedMode = true;
  r.bootAt = bootAt;
  r.writes = writes; r.soundAt = soundAt; r.audioPeak = +peak.toFixed(3); r.audioRms = +(rmsN ? rmsAcc / rmsN : 0).toFixed(4);
  const starts = KEYS.map(k => k[0]).concat([540]);
  r.changedAfterKey = starts.some(s => s + 60 < frames && hashes[s - 1] !== undefined && hashes[s - 1] !== hashes[s + 60]) || starts.some(s => soundAt >= s && soundAt < s + 60);
  const tail = Math.min(180, frames);
  let same = true; for (let f = frames - tail + 1; f < frames; f++) if (hashes[f] !== hashes[frames - tail]) { same = false; break; }
  r.stuck = same && lastWriteFrame < frames - tail;
  r.screenStatic = same;
  return r;
}

function summarize(rows) {
  const n = rows.length;
  const c = (p) => rows.filter(p).length;
  console.log(`\n== ${n} 本(${machine}) ==`);
  console.log(`読めない: ${c(r => !r.load)}`);
  console.log(`例外: ${c(r => r.error)}`);
  console.log(`BIOS から出ない(bootAt<0、ディスク除く): ${c(r => r.load && r.bootAt < 0 && r.type !== 'disk')}`);
  console.log(`CPU 停止(HALT+DI): ${c(r => r.dead !== undefined)}`);
  console.log(`未対応の画面モード: ${c(r => r.unsupportedMode)}`);
  console.log(`画面 1 色: ${c(r => r.load && r.colors <= 1)}`);
  console.log(`無音(soundAt<0): ${c(r => r.load && r.soundAt < 0)}`);
  console.log(`キーで変化なし: ${c(r => r.load && !r.changedAfterKey)}`);
  console.log(`固まり疑い(画面も書き込みも止まる): ${c(r => r.stuck)}`);
  console.log(`遅い(>16.7ms/frame): ${c(r => r.msPerFrame > 16.7)}  >8ms: ${c(r => r.msPerFrame > 8)}`);
  const byType = {};
  for (const r of rows) if (r.load) byType[r.type || '?'] = (byType[r.type || '?'] || 0) + 1;
  console.log('マッパー: ' + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  const byErr = {};
  for (const r of rows) if (!r.load) { const k = r.err.replace(/\(.*$/, '').trim(); byErr[k] = (byErr[k] || 0) + 1; }
  for (const [k, v] of Object.entries(byErr).sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`);
}
