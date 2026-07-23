#!/usr/bin/env node
/**
 * SPC RAM/ドライバ状態解析ツール
 * Node.js で SPC700 エミュレータを動かし、最初の N 秒間の DSP 書き込みをログする
 *
 * Usage: node tools/analyze_spc.js <file.spc> [seconds=5]
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ── ブラウザ環境の shim ────────────────────────────────────────────
const window = {};
global.window = window;

// ── ソース読み込み ─────────────────────────────────────────────────
const srcDir = path.join(__dirname, '..', 'src');
require(path.join(srcDir, 'spc', 'spcHeader.js'));
require(path.join(srcDir, 'emulator', 'spcDsp.js'));
require(path.join(srcDir, 'emulator', 'spc700.js'));
require(path.join(srcDir, 'emulator', 'spcPlayer.js'));

const MML = window.MML;

// ── SPC ファイル読み込み ───────────────────────────────────────────
const spcPath  = process.argv[2];
const seconds  = parseFloat(process.argv[3] || '5');

if (!spcPath) {
  console.error('Usage: node tools/analyze_spc.js <file.spc> [seconds]');
  process.exit(1);
}

const spcBytes = new Uint8Array(fs.readFileSync(spcPath));
const header   = MML.SPC.parseHeader(spcBytes);

console.log('=== SPC Header ===');
console.log(`  PC=0x${header.pc.toString(16).toUpperCase()}  A=0x${header.a.toString(16).padStart(2,'0')}  X=0x${header.x.toString(16).padStart(2,'0')}  Y=0x${header.y.toString(16).padStart(2,'0')}  SP=0x${header.sp.toString(16).padStart(2,'0')}  PSW=0x${header.psw.toString(16).padStart(2,'0')}`);
if (header.id666) console.log(`  Song: ${header.id666.songTitle || '(none)'}`);

// RAM の重要アドレスを表示
const ram = MML.SPC.getRam(spcBytes);
console.log('\n=== Initial RAM (key addresses) ===');
console.log(`  $00F1 CTRL   = 0x${ram[0xF1].toString(16).padStart(2,'0')}`);
console.log(`  $00F4 IOPORT0= 0x${ram[0xF4].toString(16).padStart(2,'0')}`);
console.log(`  $00F5 IOPORT1= 0x${ram[0xF5].toString(16).padStart(2,'0')}`);
console.log(`  $00F6 IOPORT2= 0x${ram[0xF6].toString(16).padStart(2,'0')}`);
console.log(`  $00F7 IOPORT3= 0x${ram[0xF7].toString(16).padStart(2,'0')}`);
console.log(`  $00FA TDIV0  = 0x${ram[0xFA].toString(16).padStart(2,'0')}`);
console.log(`  $00FB TDIV1  = 0x${ram[0xFB].toString(16).padStart(2,'0')}`);
console.log(`  $00FC TDIV2  = 0x${ram[0xFC].toString(16).padStart(2,'0')}`);

// PSW の P フラグ確認 (DP ページ選択)
const pFlag = (header.psw & 0x20) ? 1 : 0;
const dpBase = pFlag ? 0x0100 : 0x0000;
console.log(`\n=== CPU State ===`);
console.log(`  PSW P-flag=${pFlag}  → dpBase=0x${dpBase.toString(16).toUpperCase()}`);

// DP ページの内容をダンプ（最初の 64 バイト）
console.log(`\n=== DP Page dump (0x${dpBase.toString(16).toUpperCase()} .. +63) ===`);
for (let i = 0; i < 64; i += 16) {
  const hex = Array.from({length:16}, (_,j) => ram[dpBase+i+j].toString(16).padStart(2,'0')).join(' ');
  console.log(`  ${(dpBase+i).toString(16).toUpperCase().padStart(4,'0')}: ${hex}`);
}

// ── エミュレーション実行 ───────────────────────────────────────────
console.log(`\n=== Emulation (${seconds}s) ===`);

const player   = new MML.Emu.SpcPlayer(spcBytes);
const DSP_RATE = MML.Emu.DSP_RATE;
const totalSmp = Math.round(seconds * DSP_RATE);

let konCount   = 0;
let koffCount  = 0;
const dspLog   = [];

player.dsp.onWrite = (reg, val) => {
  const t = (dspLog.length / DSP_RATE).toFixed(4); // 近似
  if (reg === 0x4C) {  // KON
    if (val !== 0) konCount++;
    dspLog.push({ t, reg: 'KON', val: `0x${val.toString(16).padStart(2,'0')}` });
  } else if (reg === 0x5C) {  // KOFF
    if (val !== 0) koffCount++;
    dspLog.push({ t, reg: 'KOFF', val: `0x${val.toString(16).padStart(2,'0')}` });
  } else {
    // ボイスレジスタ書き込みの最初の数件を記録
    if (dspLog.filter(e => e.reg !== 'KON' && e.reg !== 'KOFF' && e.reg !== 'PC').length < 20) {
      dspLog.push({ t, reg: `REG[${reg.toString(16).toUpperCase().padStart(2,'0')}]`, val: `0x${val.toString(16).padStart(2,'0')}` });
    }
  }
};

player.bus.onWrite = (addr, val) => {
  if (addr >= 0xF4 && addr <= 0xF7) {
    dspLog.push({ t: '?', reg: `SPC_WR_$F${addr-0xF0}`, val: `0x${val.toString(16).padStart(2,'0')}` });
  }
};

// PC スナップショット: 毎秒
let prevPcSample = 0;
for (let i = 0; i < totalSmp; i++) {
  if (player.isHalted) {
    console.log(`  CPU halted at sample ${i} (${(i/DSP_RATE).toFixed(3)}s) — restarting`);
    player.cpu.halted = false;
    player.cpu.PC = header.pc;
  }
  player.renderSample();
  if (i > 0 && i % DSP_RATE === 0) {
    console.log(`  t=${i/DSP_RATE}s  PC=0x${player.cpu.PC.toString(16).toUpperCase()}  KON=${konCount}  KOFF=${koffCount}`);
  }
}
console.log(`  t=${seconds}s  PC=0x${player.cpu.PC.toString(16).toUpperCase()}  KON=${konCount}  KOFF=${koffCount}`);

// ── 結果表示 ─────────────────────────────────────────────────────
console.log('\n=== DSP Write Log (first 60 entries) ===');
dspLog.slice(0, 60).forEach(e => console.log(`  ${e.t.toString().padEnd(8)} ${e.reg.padEnd(20)} ${e.val}`));

if (konCount === 0) {
  console.log('\n⚠ KON non-zero writes: 0 — no notes triggered!');
} else {
  console.log(`\n✓ KON non-zero writes: ${konCount}`);
}
