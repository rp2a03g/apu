#!/usr/bin/env node
/*
 * 自前ゲームボーイエミュレータの総当たり点検(nes-sweep.js / msx-sweep.js の GB 版)。
 *
 *   node tools/headless/gb-sweep.js "<folder>" [--out result.jsonl] [--frames 900] [--model auto|dmg|cgb]
 *   node tools/headless/gb-sweep.js --gbs "<folder>" [--out result.jsonl] [--songs 4] [--sec 10]
 *
 * ROM の総当たり: フォルダ(下の階層も)の .gb/.gbc/.sgb を 1 本ずつ frames フレーム回す。Start を 3 回(180/420/660 フレームで 10 フレーム)、
 * A を 540 で 5 フレーム押す。1 本ごとに JSON 1 行:
 *   load(読めたか)、mbc、model、unsupported(未対応の基板)、msPerFrame、colors(終わりの画面の色数。1 色なら何も描いていない)、
 *   changedAfterStart(Start の後に画面が変わったか)、stuck(終わりの 180 フレームで画面も音源レジスタも動かない)、
 *   writes(音源レジスタの書き込み回数)、audioPeak、soundAt(最初に音が出たフレーム、-1 なら無音)、error
 * 最後に集計(基板別の本数、未対応、1 色のまま、無音、固まった疑い、遅い物)を出す。
 *
 * --gbs: GBS(実ソフトの音楽ドライバ)を曲ごとに回す。本体コアの CPU/タイマ/割り込み/音源を実ソフトのコードで点検できる
 *   (絵は出ない)。1 曲ごとに: 例外、PLAY の周期(ヘッダの値との差)、書き込みの有無、最初のトリガ、音のピーク
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (n) => process.argv.includes(n);
const gbsMode = has('--gbs');
const folder = gbsMode ? arg('--gbs', null) : process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a) && !/\.jsonl$/i.test(a) && !['auto', 'dmg', 'cgb'].includes(a));
if (!folder || !fs.existsSync(folder)) { console.error('usage: node tools/headless/gb-sweep.js "<folder>" [--out result.jsonl] [--frames 900] | --gbs "<folder>" [--songs 4] [--sec 10]'); process.exit(2); }
const outFile = arg('--out', null);
const { MML } = load({ strict: true });
const E = MML.Emu;
const lines = [];
const emit = (o) => { lines.push(o); if (outFile) fs.appendFileSync(outFile, JSON.stringify(o) + '\n'); };
if (outFile) fs.writeFileSync(outFile, '');
function walk(dir, re, out) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, re, out); else if (re.test(e.name)) out.push(p); } return out; }
const hash = (a) => { let h = 2166136261 | 0; for (let i = 0; i < a.length; i += 7) h = Math.imul(h ^ a[i], 16777619) | 0; return h >>> 0; };

if (gbsMode) {
  const maxSongs = parseInt(arg('--songs', '4'), 10), sec = parseFloat(arg('--sec', '10'));
  const files = walk(folder, /\.gbs$/i, []).sort();
  for (const file of files) {
    let header;
    try { header = MML.GBS.parseHeader(readBytes(file)); } catch (e) { emit({ file: path.basename(file), error: 'header: ' + e.message }); continue; }
    const n = Math.min(maxSongs, header.numSongs || 1);
    for (let song = 0; song < n; song++) {
      const r = { file: path.basename(file), song, fpsHeader: +header.playFps.toFixed(3), fast: !!(header.tac & 0x80) };
      try {
        const p = new E.GbsPlayer(readBytes(file));
        p.initSong(song);
        let writes = 0, firstTrig = -1, peak = 0, frames = 0;
        p.bus.onWrite = () => { writes++; };
        const t0 = p.con.cpuCycles, total = Math.ceil(sec * p.frameRate);
        const ms0 = Date.now();
        for (let f = 0; f < total; f++) {
          const a = p.renderFrame(44100, false, true); frames++;
          for (let i = 0; i < a.left.length; i += 4) { const v = Math.abs(a.left[i]) + Math.abs(a.right[i]); if (v > peak) peak = v; }
          if (firstTrig < 0 && (p.apu.ch1.triggerSeq || p.apu.ch2.triggerSeq || p.apu.ch3.triggerSeq || p.apu.ch4.triggerSeq)) firstTrig = f;
        }
        r.fps = +(4194304 / ((p.con.cpuCycles - t0) / frames)).toFixed(3);
        r.writes = writes; r.firstTrig = firstTrig; r.peak = +peak.toFixed(3); r.msPerSec = Math.round((Date.now() - ms0) / sec);
        r.rateOff = Math.abs(r.fps - r.fpsHeader) / r.fpsHeader > 0.01;
      } catch (e) { r.error = String(e && e.message || e); }
      emit(r);
    }
  }
  const songs = lines.filter(l => l.song !== undefined);
  const err = songs.filter(l => l.error), silent = songs.filter(l => !l.error && l.writes === 0), noTrig = songs.filter(l => !l.error && l.writes > 0 && l.firstTrig < 0);
  const off = songs.filter(l => l.rateOff), slow = songs.filter(l => l.msPerSec > 500);
  console.log(`GBS ${files.length} 本、${songs.length} 曲: 例外 ${err.length}、音源への書き込み無し ${silent.length}、書き込みはあるがトリガ無し ${noTrig.length}、PLAY の周期がヘッダと 1% 以上違う ${off.length}、実時間の半分より遅い ${slow.length}`);
  const show = (title, arr, f) => { if (arr.length) console.log(title + '\n' + arr.slice(0, 20).map(l => '  ' + l.file + ' #' + l.song + (f ? ' ' + f(l) : '')).join('\n') + (arr.length > 20 ? `\n  …ほか ${arr.length - 20}` : '')); };
  show('例外:', err, l => l.error);
  show('PLAY の周期がヘッダと違う(曲が TMA/TAC を書き換えている、または PLAY が 1 周期に収まらない):', off, l => `ヘッダ ${l.fpsHeader}Hz → 実測 ${l.fps}Hz`);
  show('音源への書き込みが無い:', silent);
  process.exit(err.length ? 1 : 0);
}

// ── ROM の総当たり ──
const frames = parseInt(arg('--frames', '900'), 10), model = arg('--model', 'auto');
const files = walk(folder, /\.(gb|gbc|sgb)$/i, []).sort();
const BTN = E.GbConsole.BUTTON;
for (const file of files) {
  const r = { file: path.relative(folder, file) };
  let gb;
  try { gb = new E.GbConsole(readBytes(file), { model }); r.load = true; r.mbc = gb.cart.mbc; r.model = gb.model; r.unsupported = !!gb.cart.unsupported; r.type = gb.cart.header.type; }
  catch (e) { r.load = false; r.error = String(e && e.message || e); emit(r); continue; }
  try {
    gb.setSampleRate(44100); gb.startRecording();
    let peak = 0, soundAt = -1, beforeStart = 0, changed = false, lastChange = 0, lastHash = 0, lastWrites = 0, writes = 0, lastWriteFrame = 0;
    const t0 = Date.now();
    for (let f = 0; f < frames; f++) {
      const press = ((f >= 180 && f < 190) || (f >= 420 && f < 430) || (f >= 660 && f < 670) ? BTN.START : 0) | (f >= 540 && f < 545 ? BTN.A : 0);
      gb.setController(0, press);
      const a = gb.runFrame();
      let fp = 0; for (let i = 0; i < a.length; i += 3) { const v = Math.abs(a[i]); if (v > fp) fp = v; }
      if (fp > peak) peak = fp;
      if (soundAt < 0 && fp > 0.004) soundAt = f;
      for (const fr of gb.rec.frames.splice(0)) writes += fr.length;
      if (writes !== lastWrites) { lastWrites = writes; lastWriteFrame = f; }
      const h = hash(gb.ppu.frameIdx);
      if (h !== lastHash) { lastHash = h; lastChange = f; }
      if (f === 179) beforeStart = h;
      if (f === 240 && h !== beforeStart) changed = true;
    }
    r.msPerFrame = +((Date.now() - t0) / frames).toFixed(2);
    r.colors = new Set(gb.frame).size; r.writes = writes; r.audioPeak = +peak.toFixed(3); r.soundAt = soundAt;
    r.changedAfterStart = changed || (soundAt >= 180 && soundAt < 240);
    r.stuck = frames - lastChange > 180 && frames - lastWriteFrame > 180;
    r.lcdOff = !gb.ppu.on;
  } catch (e) { r.error = String(e && e.stack || e).split('\n')[0]; }
  emit(r);
}
const ok = lines.filter(l => l.load && !l.error);
const by = {}; for (const l of lines) { const k = l.load ? l.mbc + (l.unsupported ? '(未対応 $' + l.type.toString(16) + ')' : '') : '読めない'; by[k] = (by[k] || 0) + 1; }
console.log(`ROM ${files.length} 本: ` + Object.keys(by).sort().map(k => `${k} ${by[k]}`).join('、'));
console.log(`  実行中の例外 ${lines.filter(l => l.load && l.error).length}、1 色のまま ${ok.filter(l => l.colors <= 1).length}、無音 ${ok.filter(l => l.soundAt < 0).length}、固まった疑い ${ok.filter(l => l.stuck).length}、` +
  `Start で変わらない ${ok.filter(l => !l.changedAfterStart).length}、1 フレーム 16.7ms 超 ${ok.filter(l => l.msPerFrame > 16.7).length}`);
for (const l of lines.filter(x => x.error).slice(0, 20)) console.log('  ' + l.file + ': ' + l.error);
