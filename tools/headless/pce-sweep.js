#!/usr/bin/env node
/*
 * PC エンジンの総当たり点検(段階 9。nes-sweep.js / msx-sweep.js / gb-sweep.js の PCE 版)。
 * いまは HES(実ソフトの音楽ドライバ)だけ。ROM の総当たりは本体(9c)ができてから足す。
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
