#!/usr/bin/env node
/*
 * 公開されているゲームボーイのテスト ROM をまとめて回し、合否の表を出す(DESIGN-GB-CAPTURE.md §6)。
 *
 *   node tools/headless/gb-testroms.js [--root DIR] [--only 正規表現] [--all-models] [--verbose]
 *                                      [--save pass.txt] [--check pass.txt]
 *
 * ROM は同梱しない。DIR(既定 _tmp_test/gb、環境変数 GB_TESTROM_ROOT)の下に置く:
 *   blargg/…   blargg の gb-test-roms(cpu_instrs, instr_timing, mem_timing, mem_timing-2, halt_bug, interrupt_time, dmg_sound, oam_bug …)
 *   mooneye/…  mooneye-test-suite のビルド済み(acceptance, emulator-only …)
 *   dmg-acid2.gb(+ dmg-acid2.png = 正解の絵。あれば突き合わせる)、cgb-acid2.gbc(+ cgb-acid2.png)
 *
 * 合否の読み方:
 *   blargg  : シリアルに "Passed"/"Failed"。新しい枠組みの物は $A000 に状態($80=実行中、0=合格)、$A001-3 に DE B0 61、$A004〜に文
 *   mooneye : シリアルに 3,5,8,13,21,34 が出れば合格、$42×6 なら不合格(完了を待たずに次を送るので「送り始めたバイト」serialSent で見る)
 *   機種: 既定は DMG。blargg の cgb_sound / interrupt_time と cgb-acid2 は CGB で回す。
 *   mooneye の印が DMG を含まない物(-C、-S、-cgb… )は回さない(--all-models で DMG のまま全部)。mooneye の CGB 向けは
 *   「CGB 本体で白黒ソフトを動かした時」の試験(起動時のレジスタが違う)で、その動作はまだ無い
 *
 * --save は通った ROM の一覧を書き、--check はその一覧にあるのに今回落ちた物があれば終了コード 1(回帰の見張り)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, readBytes } = require('./load');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const has = (name) => process.argv.includes(name);
const ROOT = path.resolve(arg('--root', process.env.GB_TESTROM_ROOT || path.join(__dirname, '..', '..', '_tmp_test', 'gb')));
const only = arg('--only', null) ? new RegExp(arg('--only', null), 'i') : null;
const verbose = has('--verbose');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'dl') walk(p, out); } else if (/\.gbc?$/i.test(e.name)) out.push(p);
  }
  return out;
}

// mooneye の機種の印。DMG(初代の A〜C 版)で通るはずなら true
function runsOnDmg(name) {
  const m = /-([A-Za-z0-9]+)$/.exec(name.replace(/\.gbc?$/i, ''));
  if (!m) return true;
  const s = m[1];
  if (/^(dmg|mgb|sgb|cgb|agb|ags)/.test(s)) return /dmg(?!0)/.test(s) || /dmg0?[A-C]*[A-C]/.test(s) && /dmg[0A-C]*[ABC]/.test(s);
  if (/^[GSCA]+$/.test(s)) return s.includes('G');
  return true;
}

// PNG(8bit 以下、インターレース無し)を解く。acid2 の正解の絵用
function readPng(file) {
  const b = fs.readFileSync(file);
  let o = 8, w = 0, h = 0, depth = 0, ctype = 0, pal = null; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; }
    else if (type === 'PLTE') pal = d;
    else if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil(w * ch * depth / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, up = y ? px[dst - stride + x] : 0, c = (x >= bpp && y) ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[dst + x] = v & 0xFF;
    }
  }
  // 明るさ(0〜255)と色(0xBBGGRR)
  const lum = new Uint8Array(w * h), rgb = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v;
    if (ctype === 3) { const bitPos = x * depth, byte = px[y * stride + (bitPos >> 3)], i = (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1); v = pal[i * 3]; rgb[y * w + x] = pal[i * 3] | (pal[i * 3 + 1] << 8) | (pal[i * 3 + 2] << 16); }
    else if (ctype === 0) { const bitPos = x * depth, byte = px[y * stride + (bitPos >> 3)]; v = depth === 8 ? byte : Math.round(((byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1)) * 255 / ((1 << depth) - 1)); }
    else { v = px[y * stride + x * ch]; if (ch >= 3) rgb[y * w + x] = px[y * stride + x * ch] | (px[y * stride + x * ch + 1] << 8) | (px[y * stride + x * ch + 2] << 16); }
    lum[y * w + x] = v;
  }
  return { w, h, lum, rgb };
}

const { MML } = load({ strict: true });
const FIB = [3, 5, 8, 13, 21, 34];
const endsWith = (arr, tail) => arr.length >= tail.length && tail.every((v, i) => arr[arr.length - tail.length + i] === v);

function runOne(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const suite = rel.startsWith('blargg/') ? 'blargg' : rel.startsWith('mooneye/') ? 'mooneye' : /acid2/.test(rel) ? 'acid2' : 'other';
  const model = /cgb_sound|interrupt_time|cgb-acid2/.test(rel) ? 'cgb' : 'dmg';
  let gb;
  try { gb = new MML.Emu.GbConsole(readBytes(file), { model }); } catch (e) { return { rel, suite, pass: false, note: '起動できない: ' + e.message }; }
  const maxFrames = suite === 'blargg' ? 4200 : suite === 'acid2' ? 30 : 1200;
  let pass = null, note = '', f = 0;
  for (; f < maxFrames && pass === null; f++) {
    gb.runFrame();
    if (suite === 'mooneye') {
      if (endsWith(gb.serialSent, FIB)) pass = true;
      else if (endsWith(gb.serialSent, [0x42, 0x42, 0x42, 0x42, 0x42, 0x42])) pass = false;
    } else if (suite === 'blargg') {
      const s = String.fromCharCode(...gb.serialOut);
      if (/Passed/.test(s)) pass = true;
      else if (/Failed/.test(s)) { pass = false; note = s.replace(/\s+/g, ' ').trim().slice(-70); }
      else {
        const r = gb.cart.ram;
        if (r.length > 4 && r[1] === 0xDE && r[2] === 0xB0 && r[3] === 0x61 && r[0] !== 0x80) {
          pass = r[0] === 0;
          let t = ''; for (let i = 4; i < r.length && r[i]; i++) t += String.fromCharCode(r[i]);
          if (!pass) note = `code ${r[0]}: ` + t.replace(/\s+/g, ' ').trim().slice(-70);
        }
      }
    }
  }
  if (suite === 'acid2') {
    const ref = path.join(ROOT, model === 'cgb' ? 'cgb-acid2.png' : 'dmg-acid2.png');
    if (!fs.existsSync(ref)) return { rel, suite, pass: null, note: '正解の絵(' + path.basename(ref) + ')が無い', frames: f };
    const png = readPng(ref);
    if (model === 'cgb') { // 色そのものを比べる(正解の絵は 5bit → 8bit を (c<<3)|(c>>2) で作ってある)
      let diff = 0;
      for (let i = 0; i < 160 * 144; i++) if ((gb.frame[i] & 0xFFFFFF) !== png.rgb[i]) diff++;
      return { rel, suite, model, pass: png.w === 160 && png.h === 144 && diff === 0, note: diff ? `違う画素 ${diff}` : '', frames: f };
    }
    // 正解は 4 階調。こちらの階調番号(0=白〜3=黒)と明るさの順位で比べる
    const levels = Array.from(new Set(png.lum)).sort((a, b) => b - a);
    let diff = 0;
    for (let i = 0; i < 160 * 144; i++) if (levels.indexOf(png.lum[i]) !== gb.ppu.shades.indexOf(gb.frame[i])) diff++;
    pass = png.w === 160 && png.h === 144 && diff === 0;
    note = pass ? '' : `違う画素 ${diff}`;
  }
  if (pass === null) { pass = false; note = '終わらなかった' + (gb.serialOut.length ? ' serial=' + JSON.stringify(String.fromCharCode(...gb.serialOut.slice(-40))) : ''); }
  return { rel, suite, model, pass, note, frames: f };
}

if (!fs.existsSync(ROOT)) { console.error('テスト ROM の置き場がありません: ' + ROOT); process.exit(2); }
let files = walk(ROOT, []).sort();
if (only) files = files.filter(f => only.test(f));
const skipped = [];
if (!has('--all-models')) files = files.filter(f => { if (/mooneye/.test(f) && !runsOnDmg(path.basename(f))) { skipped.push(f); return false; } if (/[\\/](utils|manual-only|madness)[\\/]/.test(f)) { skipped.push(f); return false; } return true; });

const t0 = Date.now();
const results = files.map(runOne);
const groups = {};
for (const r of results) {
  const g = r.suite === 'acid2' ? 'acid2' :  r.rel.split('/').slice(0, r.suite === 'mooneye' ? 4 : 2).filter(x => !/\.gbc?$/i.test(x) && !/^mts-/.test(x)).join('/');
  (groups[g] = groups[g] || []).push(r);
}
let passN = 0;
for (const g of Object.keys(groups).sort()) {
  const rs = groups[g], ok = rs.filter(r => r.pass).length; passN += ok;
  console.log(`${(ok + '/' + rs.length).padStart(7)}  ${g}`);
  for (const r of rs) if (!r.pass || verbose) console.log(`           ${r.pass ? 'ok ' : 'NG '} ${path.basename(r.rel)}${r.note ? '  — ' + r.note : ''}`);
}
console.log(`合格 ${passN}/${results.length}(機種違い・手動などで回さなかった物 ${skipped.length})、${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

const saveTo = arg('--save', null), checkWith = arg('--check', null);
if (saveTo) { fs.writeFileSync(saveTo, results.filter(r => r.pass).map(r => r.rel.replace(/mts-[^/]+\//, '')).sort().join('\n') + '\n'); console.log('wrote', saveTo); }
if (checkWith) {
  const want = fs.readFileSync(checkWith, 'utf8').split(/\r?\n/).filter(Boolean);
  const got = new Set(results.filter(r => r.pass).map(r => r.rel.replace(/mts-[^/]+\//, '')));
  const ran = new Set(results.map(r => r.rel.replace(/mts-[^/]+\//, '')));
  const lost = want.filter(w => ran.has(w) && !got.has(w));
  if (lost.length) { console.log('★前は通っていたのに落ちた物:\n  ' + lost.join('\n  ')); process.exit(1); }
  console.log(`回帰なし(一覧 ${want.length} 本のうち今回回した物は全部合格)`);
}
