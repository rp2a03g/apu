#!/usr/bin/env node
/*
 * PC エンジン CD-ROM² の通し確認(段階 9e): CD から読めたか、音が出るか、ステート保存/復元、巻き戻し、
 * 録音 → VGM(ADPCM と CD-DA の操作は規格外ブロック PCEX)→ VgmPlayer で読み直し。
 *   node tools/headless/pce-cd-test.js "disc.cue" --syscard "syscard3.pce" [--frames 1500] [--keys "300-310:run,900-905:run"] [--save]
 * データのファイルは cue と同じフォルダの .bin / .img / .iso / .wav を全部読んで、cue の FILE と名前で突き合わせる(本体と同じ決まり)。
 * --keys は「何フレーム目から何フレーム目の手前まで、どのボタンを押すか」(i ii select run up down left right。+ で同時押し)。
 * ADPCM が鳴る所まで進める入力を与えると、ADPCM の録音と再生も確かめる(鳴らなければその項目は飛ばす)。--save で録った VGM を cue の隣に残す。
 * Mesen との照合は pce-rom-ab.js(.cue を渡す)。
 */
'use strict';
const fs = require('fs'), path = require('path');
function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const cue = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && /\.(cue|ccd)$/i.test(a) && !/^--/.test(all[i - 1] || ''));
const sys = arg('--syscard', process.env.PCE_SYSCARD || null);
if (!cue || !sys) { console.error('usage: node tools/headless/pce-cd-test.js "disc.cue" --syscard "syscard3.pce" [--frames 1500] [--keys "300-310:run"]'); process.exit(2); }
const h = require('./load'); const { MML } = h.load({ strict: true }); const E = MML.Emu;
let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
const N = parseInt(arg('--frames', '1500'), 10);
const BTN = { i: 1, ii: 2, select: 4, run: 8, up: 16, down: 32, left: 64, right: 128 };
const presses = arg('--keys', '300-310:run,900-905:run').split(',').map(p => { const m = /^(\d+)-(\d+):([a-z+]+)$/.exec(p); return { from: +m[1], to: +m[2], bits: m[3].split('+').reduce((a, n) => a | BTN[n], 0) }; });
const padAt = (n) => { let b = 0; for (const p of presses) if (n >= p.from && n < p.to) b |= p.bits; return b; };
const t0 = Date.now();
const text = fs.readFileSync(cue, 'latin1');
const dir = path.dirname(cue);
const files = fs.readdirSync(dir).filter(n => /\.(bin|img|iso|wav)$/i.test(n)).map(n => ({ name: n, data: new Uint8Array(fs.readFileSync(path.join(dir, n))) }));
const kind = /\.ccd$/i.test(cue) ? 'ccd' : 'cue';
const mk = () => new E.PceConsole(h.readBytes(sys), { cd: E.PceDisc.fromSet({ kind, text, files }) });
const hash = (a) => { let x = 2166136261 | 0; for (let i = 0; i < a.length; i++) x = Math.imul(x ^ a[i], 16777619) | 0; return x >>> 0; };
const key = (p) => [p.clock, p.cpu.PC, hash(p.ram), hash(p.cdRam), hash(p.cd.adpcm.ram), p.superRam ? hash(p.superRam) : 0, hash(new Uint8Array(p.vdc.vram.buffer)), p.cd.sector, p.cd.auSector, p.cd.auSample, p.cd.phase, p.cd.adpcm.readAddr, p.cd.adpcm.out].join(',');
console.log('読み込み ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');

// 1. 走らせて音を取る。ADPCM と CD-DA が鳴ったか
const a = mk(); a.setSampleRate(44100);
console.log(E.PceConsole.describe(a));
let peak = 0, cdaFrames = 0, adpcmFrames = 0, st = null, stAt = 0, peakCd = 0;
a.onFrame = () => { a.setController(0, padAt(a.frameCount)); };
const t1 = Date.now();
a.startRecording();
for (let f = 0; f < N; f++) {
  const s = a.runFrame();
  for (let i = 0; i < s.length; i++) { const v = Math.abs(s[i]); if (v > peak) peak = v; }
  if (a.cd.auStatus === 0 && !a.cd.seekDelay) cdaFrames++;
  if (a.cd.adpcm.playing) adpcmFrames++;
  peakCd = Math.max(peakCd, Math.abs(a.cd.outL));
  if (!st && (a.cd.adpcm.playing || (a.cd.auStatus === 0 && cdaFrames > 30)) && f > 600) { for (let i = 0; i < 555; i++) a.step(); st = structuredClone(E.PceState.save(a)); stAt = a.frameCount; }
}
const sec = (Date.now() - t1) / 1000;
console.log(`${N} フレーム ${sec.toFixed(1)} 秒(実時間の ${(N / 60 / sec).toFixed(1)} 倍)、読んだセクタ ${a.cd.reads}、CD-DA が鳴っていたフレーム ${cdaFrames}、ADPCM ${adpcmFrames}、音の最大 ${peak.toFixed(3)}(CD 側 ${peakCd.toFixed(3)})`);
ok(a.cd.reads > 0, 'CD からデータを読んだ');
ok(peak > 0.01 && peak <= 1.0, '音が出て、1.0 を超えない');
const frames = a.stopRecording();

// 2. ステート: 途中で取った物を別の本体に読ませ、同じ入力で進めて同じになるか
if (st) {
  const sizeOf = (o) => { let n = 0; const w = (x) => { if (ArrayBuffer.isView(x)) n += x.byteLength; else if (x && typeof x === 'object') for (const k of Object.keys(x)) w(x[k]); }; w(o); return n; };
  const b = mk(); b.setSampleRate(44100);
  for (let f = 0; f < stAt; f++) { b.setController(0, padAt(b.frameCount)); b.runFrame(); if (b.frameCount === stAt) break; }
  for (let i = 0; i < 555; i++) b.step();
  const c = mk(); c.setSampleRate(44100);
  ok(E.PceState.load(c, st), `ステート読込(${stAt} フレーム目、型つき配列の合計 ${(sizeOf(st) / 1024).toFixed(0)}KB)`);
  b.onFrame = () => b.setController(0, padAt(b.frameCount)); c.onFrame = () => c.setController(0, padAt(c.frameCount));
  c.setController(0, padAt(c.frameCount)); b.setController(0, padAt(b.frameCount));
  let same = key(b) === key(c);
  ok(same, '読んだ直後の状態が、取った時点まで走らせた別の本体と同じ');
  for (let f = 0; f < 200 && same; f++) { b.runFrame(); c.runFrame(); if (key(b) !== key(c)) { same = false; console.log('  ' + f + ' フレーム後に違う\n  ' + key(b) + '\n  ' + key(c)); } }
  ok(same, '復元後 200 フレーム、毎フレーム同じ(時計、PC、RAM、CD の RAM、ADPCM、VRAM、ドライブの位置)');
  const d = new E.PceConsole(h.readBytes(sys), {});
  ok(E.PceState.load(d, st) === false, 'CD つきのステートを HuCard の本体は読まない');
} else ok(false, 'ステートを取る場面(ADPCM か CD-DA が鳴っている所)に届かなかった');

// 3. 巻き戻し
{
  const p = mk(); const rw = new E.PceRewind(p); const want = { f: 1017 }; const total = 1100;
  for (let f = 0; f < total; f++) { p.setController(0, padAt(f)); p.runFrame(); rw.onFrame(); if (p.frameCount === want.f) want.k = key(p); }
  const got = rw.rewindTo(want.f);
  ok(got === want.f && key(p) === want.k, `巻き戻し ${total} → ${want.f}`);
}

// 4. 録音 → VGM
{
  const nA = frames.reduce((n, l) => n + l.filter(w => w.adpcm !== undefined).length, 0), nC = frames.reduce((n, l) => n + l.filter(w => w.cd !== undefined).length, 0);
  // Worklet 越しと同じ形(配列に付けた len が落ちる)にして符号化
  const sent = structuredClone(frames);
  const r = MML.VGM.encodePceRecording({ frames: sent, name: 'cd test', cd: true });
  const r0 = MML.VGM.encodePceRecording({ frames, name: 'cd test', cd: true });
  ok(r.samples === r0.samples && r.vgm.length === r0.vgm.length, `Worklet 越しの形でも長さが同じ(${r.samples} サンプル = ${(r.samples / 44100).toFixed(2)} 秒、${(r.vgm.length / 1024).toFixed(0)}KB)`);
  ok(r.adpcm === nA && r.cdOps === nC, `ADPCM ${r.adpcm} 個、CD-DA の操作 ${r.cdOps} 個が VGM に入った`);
  const hdr = MML.VGM.parseHeader(r.vgm);
  ok(hdr && hdr.pcex && (!!(hdr.pcex.flags & 1)) === (nA > 0), 'VGM のヘッダから PCEX が読める');
  if (process.argv.includes('--save')) fs.writeFileSync(path.join(dir, 'rec-test.vgm'), r.vgm);
  // 再生: 最後まで例外なく回り、ADPCM が鳴る
  const pl = new E.VgmPlayer(r.vgm); let pk = 0, apk = 0, n = 0;
  const ad = pl.adapterById && pl.adapterById.pceadpcm;
  while (!pl.ended && n < N + 120) { const buf = pl.renderFrame(44100); n++; if (buf) for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i])); if (ad) apk = Math.max(apk, Math.abs(ad.cur)); }
  // 波形メモリ音源も ADPCM も鳴っていない場面(CD-DA だけ)の録音は、VGM では無音になる(CD-DA の音声は VGM に入れない)
  const anyChip = frames.some(l => l.some(w => w.adpcm !== undefined || (w.addr === 4 && (w.value & 0x80))));
  ok(pl.ended || n >= N, `VgmPlayer で最後まで回る(${n} フレーム、最大 ${pk.toFixed(3)}、ADPCM の最大 ${apk})`);
  if (anyChip) ok(pk > 0.005, 'VGM の再生で音が出る'); else console.log('    (波形メモリ音源も ADPCM も鳴っていないので、VGM は無音。CD-DA の音声は VGM に入らない)');
  if (nA > 0) ok(apk > 0, 'VGM の再生で ADPCM が鳴る');
}
console.log(bad ? 'NG ' + bad : 'すべて OK');
process.exit(bad ? 1 : 0);
