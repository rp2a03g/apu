#!/usr/bin/env node
/*
 * 自前 NES エミュレータの総当たり点検: フォルダの .nes/.fds を全部ヘッドレスで回し、1 本ごとに
 * 「起動するか・音が鳴るか・Start で進むか・固まっていないか・速さ」を JSON Lines に書く。
 *
 * 使い方: node tools/headless/nes-sweep.js "<folder>" [--out result.jsonl] [--frames 900] [--shard i/n] [--jobs 8]
 *   --jobs n  : n 個の子プロセスに分けて並列に回す(親は結果をまとめて集計を出す)
 *   --shard i/n : 子プロセス用(ファイル一覧の i 番目/n)
 *   --bios    : .fds の BIOS(環境変数 FDS_BIOS でも可)
 * 1 本の手順: frames フレーム回す。Start を 3 回(180/420/660 フレームで 10 フレーム)、A を 540 で 5 フレーム押す。
 * 出す物:
 *   load     : 読めたか(未対応マッパーなどは err)
 *   msPerFrame : 1 フレームの計算時間(16.7ms を超えると実時間で間に合わない)
 *   colors   : 終わりの画面の色数(1 色のままなら何も描いていない)
 *   changedAfterStart : Start を押した後に画面が変わったか(押す前の最後の画面と、押して 60 フレーム後の画面の比較。押して 60 フレーム以内に音が出始めた場合も可)
 *   stuck    : 終わりの 180 フレームで画面が 1 度も変わらず、音源レジスタの書き込みも無い(固まった疑い)
 *   halted   : CPU が KIL(ジャム)で止まった
 *   writes   : 音源レジスタの書き込み回数(2A03+拡張)。audioRms: 後半の音の実効値、audioPeak: 最大
 *   soundAt  : 最初に音(RMS>0.002 のフレーム)が出たフレーム(-1 なら無音のまま)
 *   error    : 実行中の例外
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const folder = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+(\/\d+)?$/.test(a) && !/\.jsonl$/i.test(a));
if (!folder) { console.error('usage: node tools/headless/nes-sweep.js "<folder>" [--out result.jsonl] [--frames 900] [--jobs 8]'); process.exit(2); }
const frames = parseInt(arg('--frames', '900'), 10);
const outFile = arg('--out', null);
const shard = arg('--shard', null);
const jobs = parseInt(arg('--jobs', '1'), 10);
const biosPath = arg('--bios', process.env.FDS_BIOS || null);

const files = fs.readdirSync(folder).filter(f => /\.(nes|fds)$/i.test(f)).sort().map(f => path.join(folder, f));

if (jobs > 1 && !shard) {
  // 親: 子を jobs 個起こし、stdout の JSON 行を集める
  const lines = [];
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < jobs; i++) {
    const args = [__filename, folder, '--frames', String(frames), '--shard', `${i}/${jobs}`];
    if (biosPath) args.push('--bios', biosPath);
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (l) { lines.push(l); if (lines.length % 100 === 0) process.stderr.write(`${lines.length}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`); } } });
    c.on('exit', () => { if (++done === jobs) finish(); });
  }
  function finish() {
    const rows = lines.map(l => JSON.parse(l)).sort((a, b) => a.file.localeCompare(b.file));
    if (outFile) fs.writeFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    summarize(rows);
  }
} else {
  const { MML } = load({ strict: true });
  const bios = biosPath ? readBytes(biosPath) : null;
  let mine = files;
  if (shard) { const [i, n] = shard.split('/').map(Number); mine = files.filter((_, k) => k % n === i); }
  for (const file of mine) {
    const r = runOne(MML, file, bios);
    process.stdout.write(JSON.stringify(r) + '\n');
  }
  if (!shard && outFile) { /* 単独実行で --out は使わない(stdout をリダイレクトする) */ }
}

function hashFrame(fr) { let h = 2166136261; for (let i = 0; i < fr.length; i += 7) { h ^= fr[i]; h = Math.imul(h, 16777619); } return h >>> 0; }

function runOne(MML, file, bios) {
  const r = { file: path.basename(file) };
  let nes;
  try {
    nes = new MML.Emu.NesConsole(readBytes(file), { bios });
    r.load = true; r.info = MML.Emu.INES.describe(nes.rom); r.mapper = nes.rom.mapper;
  } catch (e) { r.load = false; r.err = String(e && e.message || e); return r; }
  const SR = 22050;
  nes.setSampleRate(SR);
  nes.startRecording();
  const STARTS = [180, 420, 660];
  const press = (f) => { let b = 0; for (const s of STARTS) if (f >= s && f < s + 10) b |= 8; if (f >= 540 && f < 545) b |= 1; return b; };
  const hashes = new Array(frames);
  let writes = 0, soundAt = -1, peak = 0, rmsAcc = 0, rmsN = 0, lastWriteFrame = -1;
  const t0 = process.hrtime.bigint();
  try {
    for (let f = 0; f < frames; f++) {
      nes.setController(0, press(f));
      const a = nes.runFrame();
      hashes[f] = hashFrame(nes.frame);
      if (nes.rec) { const n = nes.rec.frames.length; if (n) { const fr = nes.rec.frames.splice(0); for (const x of fr) { if (x.length) { writes += x.length; lastWriteFrame = f; } } } }
      if (a) {
        let s = 0, p = 0;
        for (let i = 0; i < a.length; i++) { const v = a[i]; s += v * v; const q = v < 0 ? -v : v; if (q > p) p = q; }
        const rms = Math.sqrt(s / a.length);
        if (soundAt < 0 && rms > 0.002 && f > 2) soundAt = f;
        if (f >= frames / 2) { rmsAcc += rms; rmsN++; }
        if (p > peak) peak = p;
      }
      if (nes.cpu.halted) { r.halted = f; break; }
    }
  } catch (e) { r.error = String(e && e.stack || e).split('\n').slice(0, 2).join(' | '); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  r.msPerFrame = +(ms / frames).toFixed(2);
  r.colors = new Set(nes.frame).size;
  r.writes = writes; r.soundAt = soundAt; r.audioPeak = +peak.toFixed(3); r.audioRms = +(rmsN ? rmsAcc / rmsN : 0).toFixed(4);
  // Start の効き: 押す直前の画面と 60 フレーム後の画面
  r.changedAfterStart = STARTS.some(s => s + 60 < frames && hashes[s - 1] !== undefined && hashes[s - 1] !== hashes[s + 60]) || STARTS.some(s => soundAt >= s && soundAt < s + 60);
  // 固まり: 終わりの 180 フレームで画面が変わらず、書き込みも無い
  const tail = Math.min(180, frames);
  let same = true; for (let f = frames - tail + 1; f < frames; f++) if (hashes[f] !== hashes[frames - tail]) { same = false; break; }
  r.stuck = same && lastWriteFrame < frames - tail;
  r.screenStatic = same;
  return r;
}

function summarize(rows) {
  const n = rows.length;
  const c = (p) => rows.filter(p).length;
  console.log(`\n== ${n} 本 ==`);
  console.log(`読めない: ${c(r => !r.load)}`);
  console.log(`例外: ${c(r => r.error)}`);
  console.log(`CPU ジャム: ${c(r => r.halted !== undefined)}`);
  console.log(`画面 1 色: ${c(r => r.load && r.colors <= 1)}`);
  console.log(`無音(soundAt<0): ${c(r => r.load && r.soundAt < 0)}`);
  console.log(`Start で変化なし: ${c(r => r.load && !r.changedAfterStart)}`);
  console.log(`固まり疑い(画面も書き込みも止まる): ${c(r => r.stuck)}`);
  console.log(`遅い(>16.7ms/frame): ${c(r => r.msPerFrame > 16.7)}  >8ms: ${c(r => r.msPerFrame > 8)}`);
  const byErr = {};
  for (const r of rows) if (!r.load) { const k = r.err.replace(/\(.*$/, '').trim(); byErr[k] = (byErr[k] || 0) + 1; }
  for (const [k, v] of Object.entries(byErr).sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`);
}
