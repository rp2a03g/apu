#!/usr/bin/env node
/*
 * PC エンジンの総当たり点検(段階 9。nes-sweep.js / msx-sweep.js / gb-sweep.js の PCE 版)。
 * HES(実ソフトの音楽ドライバ)と、HuCard の ROM(段階 9g)。
 *
 *   node tools/headless/pce-sweep.js --roms "<folder>" [--frames 1800] [--jobs 6] [--out result.jsonl] [--limit N]
 *   node tools/headless/pce-sweep.js --roms-report result.jsonl      結果の読み直し(分類の表だけ出す)
 * --roms: フォルダ(下の階層も)の .pce / .sgx を 1 本ずつ frames フレーム回す。3 秒おきに RUN、その間に I を押す(タイトルを抜けるため)。1 本ごとに JSON 1 行:
 *   file、size、banks、sgx、error(例外)、stuck(1 画面ぶん回しても画面の区切りが来なかった最初のフレーム)、
 *   colors(1/3・2/3・終わりの画面にある色の数)、writes(波形メモリ音源への書き込み回数)、sound(どれかの ch が音量つきで入っていたフレーム数)、pc、ms。
 *   中身が HES(先頭 "HESM")の物は外す。終わりに分類(例外/止まった/一色/無音)の表を出す。終了コードは例外か止まった物があれば 1。
 *
 *   node tools/headless/pce-sweep.js --hes "<folder>" [--out result.jsonl] [--tracks 3] [--sec 10] [--save <dir>]
 *   node tools/headless/pce-sweep.js --compare base.jsonl new.jsonl [--seq baseDir newDir]
 *
 * --hes: フォルダ(下の階層も)の .hes を、ヘッダの最初の曲から tracks 曲ぶん、sec 秒ずつ回す。1 曲ごとに JSON 1 行:
 *   file、track、writes(PSG $0800-$0809 への書き込み回数)、hash(書き込みの「通しの並び」(番地, 値) の FNV-1a)、
 *   dda(そのうち $0806 への書き込みで DDA が入っていた回数)、timerIrq / vblankIrq(割り込みを取った回数)、error
 *   --save を付けると、並びそのものを <dir>/<file>.<track>.seq(1 個 2 バイト: 番地の下位 4bit <<8 | 値)に書く。
 *   並びは「いつ書いたか」を含まない。CPU の中身だけを触った変更なら変わらないはず、という見張りに使う(DESIGN-PCE-CAPTURE.md §2.2)。
 *
 * --compare: 2 回ぶんの結果を曲ごとに比べる。hash が同じ=並びが完全に同じ。違う曲は、--seq で並びのフォルダを渡すと
 *   「何個目まで同じか」「長い方の前の方に短い方が丸ごと入っているか(=時間の進みが違うだけ)」も出す。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (n) => process.argv.includes(n);
function walk(dir, re, out) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, re, out); else if (re.test(e.name)) out.push(p); } return out; }

if (has('--compare')) {
  const i = process.argv.indexOf('--compare');
  const [fa, fb] = [process.argv[i + 1], process.argv[i + 2]];
  const j = process.argv.indexOf('--seq');
  const seqDirs = j >= 0 ? [process.argv[j + 1], process.argv[j + 2]] : null;
  const read = (f) => new Map(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(o => [o.file + '#' + o.track, o]));
  const A = read(fa), B = read(fb);
  let same = 0, diff = 0, onlyTime = 0, errA = 0, errB = 0; const rows = [];
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) { rows.push(k + ': 新しい方に無い'); diff++; continue; }
    if (a.error) errA++; if (b.error) errB++;
    if (a.error || b.error) { if (!!a.error !== !!b.error) { rows.push(`${k}: 例外 ${a.error || '無し'} → ${b.error || '無し'}`); diff++; } else same++; continue; }
    if (a.hash === b.hash && a.writes === b.writes) { same++; continue; }
    diff++;
    let note = `書き込み ${a.writes} → ${b.writes}`;
    if (seqDirs) {
      const name = k.replace('#', '.') + '.seq';
      const pa = path.join(seqDirs[0], name), pb = path.join(seqDirs[1], name);
      if (fs.existsSync(pa) && fs.existsSync(pb)) {
        const sa = fs.readFileSync(pa), sb = fs.readFileSync(pb);
        const n = Math.min(sa.length, sb.length); let p = 0;
        while (p < n && sa[p] === sb[p]) p++;
        p >>= 1;
        const prefix = p === (n >> 1);
        if (prefix) onlyTime++;
        note += prefix ? `、短い方は長い方の頭と同じ(時間の進みだけが違う)` : `、${p} 個目で食い違い(${(p / (n >> 1) * 100).toFixed(1)}% まで同じ)`;
      }
    }
    rows.push(k + ': ' + note);
  }
  console.log(`曲 ${A.size}: 並びが同じ ${same}、違う ${diff}(うち時間の進みだけ ${onlyTime})、例外 ${errA} → ${errB}`);
  for (const r of rows.slice(0, 60)) console.log('  ' + r);
  if (rows.length > 60) console.log(`  …ほか ${rows.length - 60}`);
  process.exit(diff ? 1 : 0);
}

// ── ROM の総当たり ──
function romReport(rows, frames) {
  const err = rows.filter(r => r.error), stuck = rows.filter(r => !r.error && r.stuck >= 0);
  const fine = rows.filter(r => !r.error && !(r.stuck >= 0));
  const blank = fine.filter(r => r.colors.every(c => c <= 1)), blankEnd = fine.filter(r => r.colors[2] <= 1 && !r.colors.every(c => c <= 1));
  const silent = fine.filter(r => r.writes === 0), mute = fine.filter(r => r.writes > 0 && r.sound === 0);
  console.log(`\nROM ${rows.length} 本(${frames} フレーム): 例外 ${err.length}、止まった ${stuck.length}、ずっと一色 ${blank.length}、終わりだけ一色 ${blankEnd.length}、音源に一度も書かない ${silent.length}、書くが鳴らさない ${mute.length}`);
  const show = (label, list, fmt) => { if (!list.length) return; console.log(label + ':'); for (const r of list.slice(0, 40)) console.log('  ' + r.file + (fmt ? '  ' + fmt(r) : '')); if (list.length > 40) console.log('  …ほか ' + (list.length - 40)); };
  show('例外', err, r => r.error);
  show('止まった', stuck, r => 'フレーム ' + r.stuck + ' pc $' + (r.pc || 0).toString(16));
  show('ずっと一色', blank, r => 'pc $' + (r.pc || 0).toString(16) + ' 書き込み ' + r.writes + ' ' + (r.size >> 10) + 'K');
  show('終わりだけ一色', blankEnd, r => '色 ' + r.colors.join('/'));
  show('音源に一度も書かない', silent.filter(r => !blank.includes(r)), r => '色 ' + r.colors.join('/'));
  show('書くが鳴らさない', mute, r => '書き込み ' + r.writes);
  return err.length + stuck.length;
}
if (has('--roms-report')) {
  const rows = fs.readFileSync(arg('--roms-report', ''), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  process.exit(romReport(rows, rows.length ? rows[0].frames : 0) ? 1 : 0);
}
if (has('--rom-batch')) { // 子: 一覧のファイルを順に回して 1 本 1 行
  const { load, readBytes } = require('./load'); const E = load({ strict: true }).MML.Emu;
  const frames = parseInt(arg('--frames', '1800'), 10);
  for (const file of fs.readFileSync(arg('--rom-batch', ''), 'utf8').split('\n').filter(Boolean)) {
    const o = { file: path.basename(file), frames, colors: [0, 0, 0], writes: 0, sound: 0, stuck: -1 };
    const t0 = Date.now();
    try {
      const bytes = readBytes(file); o.size = bytes.length;
      const pce = new E.PceConsole(bytes, { model: /\.sgx$/i.test(file) ? 'sgx' : 'auto' });
      o.banks = pce.card.banks; o.sgx = !!pce.sgx;
      pce.onWrite = () => { o.writes++; };
      const seen = new Uint8Array(1024);
      for (let fr = 0; fr < frames; fr++) {
        const k = fr % 180; pce.setController(0, (k >= 120 && k < 126 ? 8 : 0) | (k >= 30 && k < 34 ? 1 : 0));
        pce._frameFlag = false; let guard = 0;
        while (!pce._frameFlag && ++guard < 600000) pce.cpu.step();
        if (!pce._frameFlag) { o.stuck = fr; break; }
        const ch = pce.apu.ch; for (let i = 0; i < 6; i++) if ((ch[i].control & 0x80) && (ch[i].control & 0x1F)) { o.sound++; break; }
        const at = fr + 1 === Math.floor(frames / 3) ? 0 : fr + 1 === Math.floor(frames * 2 / 3) ? 1 : fr + 1 === frames ? 2 : -1;
        if (at >= 0) { seen.fill(0); const idx = pce.frameIdx; let n = 0; for (let i = 0; i < idx.length; i += 3) if (!seen[idx[i]]) { seen[idx[i]] = 1; n++; } o.colors[at] = n; }
      }
      o.pc = pce.cpu.PC;
    } catch (e) { o.error = String(e && e.message || e).slice(0, 160); }
    o.ms = Date.now() - t0;
    console.log(JSON.stringify(o));
  }
  process.exit(0);
}
if (has('--roms')) {
  const dir = arg('--roms', null);
  if (!dir || !fs.existsSync(dir)) { console.error('usage: node tools/headless/pce-sweep.js --roms "<folder>" [--frames 1800] [--jobs 6] [--out result.jsonl]'); process.exit(2); }
  const isHes = (p) => { const fd = fs.openSync(p, 'r'), b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('latin1') === 'HESM'; };
  let files = walk(dir, /\.(pce|sgx)$/i, []).sort();
  const n0 = files.length; files = files.filter(p => !isHes(p)); const hesN = n0 - files.length;
  const limit = parseInt(arg('--limit', '0'), 10); if (limit) files = files.slice(0, limit);
  const frames = arg('--frames', '1800'), jobs = Math.max(1, parseInt(arg('--jobs', '6'), 10)), outFile = arg('--out', null);
  console.log(`ROM ${files.length} 本(中身が HES の ${hesN} 本は外した)、${frames} フレーム、${jobs} 並列`);
  const os = require('os'), { spawn } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pce-sweep-'));
  const rows = []; let left = jobs;
  if (outFile) fs.writeFileSync(outFile, '');
  for (let j = 0; j < jobs; j++) {
    const list = path.join(tmp, 'list' + j + '.txt');
    fs.writeFileSync(list, files.filter((_, i) => i % jobs === j).join('\n'));
    const ch = spawn(process.execPath, [__filename, '--rom-batch', list, '--frames', frames], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    ch.stdout.on('data', (d) => { buf += d; let p; while ((p = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, p); buf = buf.slice(p + 1); if (!line.trim()) continue; const o = JSON.parse(line); rows.push(o); if (outFile) fs.appendFileSync(outFile, line + '\n'); if (rows.length % 50 === 0) process.stderr.write(rows.length + '/' + files.length + '\n'); } });
    ch.on('close', () => { if (--left === 0) { fs.rmSync(tmp, { recursive: true, force: true }); rows.sort((a, b) => a.file < b.file ? -1 : 1); process.exit(romReport(rows, +frames) ? 1 : 0); } });
  }
  return;
}

const folder = arg('--hes', null);
if (!folder || !fs.existsSync(folder)) { console.error('usage: node tools/headless/pce-sweep.js --hes "<folder>" [--out result.jsonl] [--tracks 3] [--sec 10] [--save <dir>] | --compare a.jsonl b.jsonl [--seq dirA dirB]'); process.exit(2); }
const { load, readBytes } = require('./load');
const outFile = arg('--out', null), saveDir = arg('--save', null);
const maxTracks = parseInt(arg('--tracks', '3'), 10), sec = parseFloat(arg('--sec', '10'));
if (saveDir) fs.mkdirSync(saveDir, { recursive: true });
if (outFile) fs.writeFileSync(outFile, '');
const { MML } = load({ strict: true });
const E = MML.Emu;
const lines = [];
const emit = (o) => { lines.push(o); if (outFile) fs.appendFileSync(outFile, JSON.stringify(o) + '\n'); };

const files = walk(folder, /\.hes$/i, []).sort();
for (const file of files) {
  const bytes = readBytes(file);
  let first;
  try { first = MML.HES.parseHeader(bytes).firstTrack | 0; } catch (e) { emit({ file: path.basename(file), track: -1, error: 'header: ' + e.message }); continue; }
  for (let k = 0; k < maxTracks; k++) {
    const track = (first + k) & 0xFF;
    const r = { file: path.basename(file), track };
    try {
      E.HesPlayer.DEFER_VBLANK = process.env.PCE_HES_DEFER !== '0'; // 救済(タイマ処理中は垂直帰線を後回し)。既定は入。PCE_HES_DEFER=0 で切って回す
      const p = new E.HesPlayer(bytes);
      const seq = [];
      let dda = 0, h = 2166136261 | 0;
      const bus = p.bus;
      bus.onWrite = (addr, value) => {
        if (bus.mpr[addr >>> 13] !== 0xFF) return;
        const off = addr & 0x1FFF;
        if (off < 0x0800 || off > 0x0809) return;
        const w = ((off & 15) << 8) | value;
        seq.push(w);
        h = Math.imul(h ^ (w & 0xFF), 16777619); h = Math.imul(h ^ (w >> 8), 16777619);
        if (off === 0x0806) dda++;
      };
      // 割り込みを取った回数(本体を作り直した後も同じ名前で数えられるよう、ベクタの読み出しで数える)
      let timerIrq = 0, vblankIrq = 0;
      const rd = bus.read.bind(bus);
      bus.read = (addr) => { if (addr === 0xFFFA) timerIrq++; else if (addr === 0xFFF8) vblankIrq++; return rd(addr); };
      p.initSong(track);
      const total = Math.ceil(sec * p.frameRate);
      const t0 = Date.now();
      for (let f = 0; f < total; f++) p.renderFrame(44100, true);
      r.writes = seq.length; r.hash = h >>> 0; r.dda = dda; r.timerIrq = timerIrq; r.vblankIrq = vblankIrq;
      r.msPerSec = Math.round((Date.now() - t0) / sec);
      if (saveDir) fs.writeFileSync(path.join(saveDir, r.file + '.' + track + '.seq'), Buffer.from(new Uint16Array(seq).buffer));
    } catch (e) { r.error = String(e && e.message || e).split('\n')[0]; }
    emit(r);
  }
}
const err = lines.filter(l => l.error), silent = lines.filter(l => !l.error && l.writes === 0);
console.log(`HES ${files.length} 本、${lines.length} 曲: 例外 ${err.length}、PSG への書き込み無し ${silent.length}、タイマ割り込みで動く ${lines.filter(l => l.timerIrq > 10).length}、垂直帰線で動く ${lines.filter(l => l.vblankIrq > 10).length}`);
for (const l of err.slice(0, 20)) console.log('  ' + l.file + ' #' + l.track + ': ' + l.error);
process.exit(err.length ? 1 : 0);
