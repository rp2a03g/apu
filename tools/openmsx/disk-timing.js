#!/usr/bin/env node
/*
 * ディスクの読み込みの速さを openMSX と突き合わせる(2026-11-12。FDC に実機の時間を入れた時の確かめ)。
 * 画面の比較(ab.js)では静止した画面がどのフレームとも合うので時間差が測れない。こちらは FDC のデータレジスタ($7FFB)を
 * CPU が読んだ回数をフレームごとに数え、累計が全体の 1%/10%/…/100% に届いたフレームを両方で並べる。
 *
 * 使い方: node tools/openmsx/disk-timing.js a.dsk [b.dsk …] [--machine fsa1f|wd2793] [--frames 3000]
 *   機種は ab.js の MACHINES(fsa1f = TC8566AF、wd2793 = WD2793 Philips 式)。openMSX の場所も ab.js と同じ。
 *   ★数えるのは $7FFB の読み(データとコマンドの結果バイト)。書き込みは数えない。両方とも同じ数え方。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ab = require('./ab.js');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OPENMSX = process.env.OPENMSX || path.join(ROOT, '_tmp_test', 'openmsx', 'app', 'openmsx.exe');
const BIOS_DIR = arg('--bios-dir', path.join(ROOT, '_tmp_test', 'msx', 'sweep', 'bios'));
const OUT = path.resolve(arg('--out', path.join(ROOT, '_tmp_test', 'openmsx', 'timing')));
const MACHINE = arg('--machine', 'fsa1f');
const FRAMES = +arg('--frames', '3000');
const disks = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

function runRef(disk, dir) {
  const q = (p) => '{' + p.replace(/\\/g, '/') + '}';
  const tcl = [
    'set mute on', 'set throttle off', 'set ::cnt 0', 'set ::n 0', `set ::stop ${FRAMES}`, 'set ::log {}',
    'debug set_watchpoint read_mem 0x7FFB {} {incr ::cnt}',
    'proc onFrame {} {',
    '  lappend ::log $::cnt',
    `  if {$::n >= $::stop} { set fh [open ${q(path.join(dir, 'ref.txt'))} w]; puts $fh $::log; close $fh; exit }`,
    '  incr ::n', '  after frame onFrame', '}',
    'after frame onFrame',
  ].join('\n') + '\n';
  const tf = path.join(dir, 'timing.tcl');
  ab.freshCmos(MACHINE);
  fs.writeFileSync(tf, tcl);
  return new Promise((resolve) => {
    const p = spawn(OPENMSX, ['-machine', ab.MACHINES[MACHINE].openmsx, '-diska', disk, '-script', tf], { stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } resolve(null); }, 600000);
    p.on('exit', () => { clearTimeout(t); try { resolve(fs.readFileSync(path.join(dir, 'ref.txt'), 'utf8').trim().split(/\s+/).map(Number)); } catch (e) { resolve(null); } });
  });
}

let MML = null;
function runOurs(disk) {
  if (!MML) MML = require(path.join(ROOT, 'tools', 'headless', 'load.js')).load({ strict: true }).MML;
  const M = ab.MACHINES[MACHINE], opts = Object.assign({}, M.ours);
  opts.bios = {}; for (const [k, f] of Object.entries(M.bios)) opts.bios[k] = new Uint8Array(fs.readFileSync(path.join(BIOS_DIR, f))); opts.bios.name = 'split';
  opts.disks = [new Uint8Array(fs.readFileSync(disk))];
  const m = new MML.Emu.MsxConsole(null, opts);
  let cnt = 0;
  const di = m.disk, orig = di._readReg.bind(di);
  di._readReg = (r) => { if (r === 3) cnt++; return orig(r); };
  const log = [];
  for (let f = 0; f <= FRAMES; f++) { m.runFrame(); log.push(cnt); }
  return log;
}

// 累計が total の p に届いた最初のフレーム
function marks(log) {
  const total = log[log.length - 1] || 0, out = {};
  const PS = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 1]; for (const p of PS) { const want = Math.max(1, Math.ceil(total * p)); out['p' + p] = log.findIndex((c) => c >= want); }
  return { total, out };
}

(async () => {
  ab.ensureMachines();
  fs.mkdirSync(OUT, { recursive: true });
  for (const d of disks) {
    const disk = path.resolve(d), dir = path.join(OUT, path.basename(d).replace(/[^\w.-]/g, '_') + '_' + MACHINE);
    fs.mkdirSync(dir, { recursive: true });
    const [ref, ours] = await Promise.all([runRef(disk, dir), Promise.resolve().then(() => runOurs(disk))]);
    if (!ref) { console.log(path.basename(d), 'openMSX が結果を出さなかった'); continue; }
    fs.writeFileSync(path.join(dir, 'ours.txt'), ours.join(' '));
    const a = marks(ours), b = marks(ref);
    console.log(`${path.basename(d)} [${MACHINE}] 読んだバイト こちら ${a.total} / openMSX ${b.total}`);
    console.log('  到達%   ' + Object.keys(a.out).map((p) => String(Math.round(+p.slice(1) * 100)).padStart(6)).join(''));
    console.log('  こちら  ' + Object.values(a.out).map((v) => String(v).padStart(6)).join(''));
    console.log('  openMSX ' + Object.values(b.out).map((v) => String(v).padStart(6)).join(''));
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
