#!/usr/bin/env node
/*
 * 巻き戻し用スナップショット(NesState.save)の 1 回の時間と大きさを ROM ごとに測る。
 * AudioWorklet の process() 1 回の予算は 128 サンプル ≒ 2.9ms(44.1kHz)。スナップショットが 30 フレームごとに
 * それを超えて走ると、音が途切れ(underrun)画面も止まって見える。
 *
 * 使い方: node tools/headless/nes-state-cost.js "<folder or file>" [--frames 120] [--reps 5] [--top 20]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const target = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a));
const frames = parseInt(arg('--frames', '120'), 10);
const reps = parseInt(arg('--reps', '5'), 10);
const top = parseInt(arg('--top', '20'), 10);
const biosPath = arg('--bios', process.env.FDS_BIOS || null);
const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter(f => /\.(nes|fds)$/i.test(f)).sort().map(f => path.join(target, f)) : [target];

const { MML } = load({ strict: true });
const bios = biosPath ? readBytes(biosPath) : null;

function sizeOf(v, seen = new Set()) { // 型付き配列のバイト数+ざっくりの object 数
  if (v === null || typeof v !== 'object') return 0;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (seen.has(v)) return 0; seen.add(v);
  let n = 16;
  for (const k of Object.keys(v)) n += 8 + sizeOf(v[k], seen);
  return n;
}
const rows = [];
for (const file of files) {
  let nes;
  try { nes = new MML.Emu.NesConsole(readBytes(file), { bios }); } catch (e) { continue; }
  nes.setSampleRate(44100);
  try { for (let f = 0; f < frames; f++) nes.runFrame(); } catch (e) { continue; }
  let best = Infinity, bytes = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    const st = MML.Emu.NesState.save(nes);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
    if (!bytes) bytes = sizeOf(st);
  }
  rows.push({ file: path.basename(file), mapper: nes.rom.mapper, ms: +best.toFixed(2), kb: +(bytes / 1024).toFixed(0) });
}
rows.sort((a, b) => b.ms - a.ms);
console.log(`${rows.length} 本。save の最短時間(ms)の分布: >2.9ms ${rows.filter(r => r.ms > 2.9).length}, >1ms ${rows.filter(r => r.ms > 1).length}, 中央値 ${rows[rows.length >> 1] ? rows[rows.length >> 1].ms : '-'}`);
console.log('遅い順:');
for (const r of rows.slice(0, top)) console.log(`  ${r.ms.toFixed(2)}ms ${String(r.kb).padStart(5)}KB mapper ${String(r.mapper).padStart(3)}  ${r.file}`);
