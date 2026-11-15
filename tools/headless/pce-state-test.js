#!/usr/bin/env node
/*
 * PC エンジン本体まわりの通し確認(gb-state-test.js の PCE 版、段階 9c): 中身判定、ステート保存/復元、巻き戻し、
 * 録音 → VGM → VgmPlayer で読み直し、録音の書き込み列を音源に流して同じ状態になるか。
 *   node tools/headless/pce-state-test.js "game.pce" [--frames 600]
 * ROM は引数で渡す。録音の試験は、200 フレーム目から 2 秒おきに RUN を 8 フレーム押して(タイトルを抜けて)音の鳴る所まで進めてから録る。
 * それでも無音のソフトは --frames を伸ばす。
 */
'use strict';
const { load, readBytes } = require('./load'); const { MML } = load({ strict: true });
const E = MML.Emu; let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const file = process.argv.slice(2).find(a => !a.startsWith('--') && /\.(pce|sgx)$/i.test(a));
if (!file) { console.error('usage: node tools/headless/pce-state-test.js "game.pce" [--frames 600]'); process.exit(2); }
const N = parseInt(arg('--frames', '600'), 10);
const rom = readBytes(file);
const hash = (a) => { let h = 2166136261 | 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) | 0; return h >>> 0; };
const frameHash = (p) => hash(new Uint8Array(p.frame.buffer, p.frame.byteOffset, p.frame.byteLength));

ok(E.Image.detect(rom, 'x.pce').kind === 'pce', '中身判定 .pce');
ok(E.Image.detect(rom, 'x.bin') === null || E.Image.detect(rom, 'x.bin').kind !== 'pce', '拡張子が .pce でなければ PC エンジンとは決めない');

// ステート: N フレーム目で保存 → 120 進めて控える → 復元 → 同じだけ進めて同じか(画面、PC、マスタークロック、VRAM、音源の状態)
const pce = new E.PceConsole(rom); pce.setSampleRate(44100);
for (let f = 0; f < N; f++) pce.runFrame();
// 命令の途中・行の途中で保存しても続きが同じになるか見るため、フレームの境目から少し進めた所で取る
for (let i = 0; i < 777; i++) pce.cpu.step();
const st = E.PceState.save(pce);
const copy = structuredClone(st);
const sizeOf = (o) => { let n = 0; const w = (x) => { if (ArrayBuffer.isView(x)) n += x.byteLength; else if (x && typeof x === 'object') for (const k of Object.keys(x)) w(x[k]); }; w(o); return n; };
const apuKey = (p) => p.apu.ch.map(c => [c.timer, c.wavePos, c.out, c.lfsr, c.control, c.freq].join(',')).join('|');
for (let f = 0; f < 120; f++) pce.runFrame();
const h1 = frameHash(pce), pc1 = pce.cpu.PC, ck1 = pce.clock, v1 = hash(new Uint8Array(pce.vdc.vram.buffer)), a1 = apuKey(pce);
ok(E.PceState.load(pce, copy), `ステート読込(structuredClone を通した物、型つき配列の合計 ${(sizeOf(st) / 1024).toFixed(0)}KB)`);
for (let f = 0; f < 120; f++) pce.runFrame();
ok(frameHash(pce) === h1 && pce.cpu.PC === pc1 && pce.clock === ck1 && hash(new Uint8Array(pce.vdc.vram.buffer)) === v1 && apuKey(pce) === a1,
  `復元後に同じ結果(pc $${pce.cpu.PC.toString(16)} / $${pc1.toString(16)}、clock ${pce.clock} / ${ck1})`);
const other = rom.map((b) => b ^ 1); // 全バイトを変えた別物(頭に 512 バイトのヘッダがある ROM でも確実に違う物になるように)
ok(!E.PceState.load(new E.PceConsole(other), copy), '別の ROM のステートは拒否');

// 巻き戻し
const p2 = new E.PceConsole(rom); const rw = new E.PceRewind(p2);
// 戻る先は控えのフレーム(30 の倍数)を外す: ちょうど控えのフレームへ戻ると、絵は次のフレームが出来るまで前の物が残る(NES/GB と同じ。出来上がった絵は控えに入れていない)
const want = { f: N + 30 + ((N + 30) % 30 === 0 ? 7 : 0) }; const total = N + 100;
for (let f = 0; f < total; f++) { p2.setController(0, f % 50 < 10 ? 8 : 0); p2.runFrame(); rw.onFrame(); if (p2.frameCount === want.f) { want.h = frameHash(p2); want.ck = p2.clock; } }
const got = rw.rewindTo(want.f);
ok(got === want.f && p2.clock === want.ck && frameHash(p2) === want.h, `巻き戻し ${total} → ${want.f}(戻った ${got})`);
ok(rw.beginReverse() && !!rw.reverseStep() && rw.palette.length === 256, '逆再生の 1 枚と色表');
rw.endReverse();
// Worklet と同じ呼び方: 本体の onFrame の中でステートを取る(画面の区切りは命令の途中に来るので、本体が命令の境目まで遅らせて呼ぶ)。
// 取った控えを別の本体に読ませ、同じ入力で 60 フレーム進めて、毎フレームの時計と PC、最後の画面が元と同じか
{
  const padOf = (f) => (f % 50 < 10 ? 8 : 0);
  const p4 = new E.PceConsole(rom); const log = {}; let st4 = null, h4 = 0;
  p4.onFrame = () => { log[p4.frameCount] = p4.clock + ':' + p4.cpu.PC; if (p4.frameCount === want.f) st4 = structuredClone(E.PceState.save(p4)); if (p4.frameCount === want.f + 60) h4 = frameHash(p4); };
  for (let f = 0; f < want.f + 60; f++) { p4.setController(0, padOf(f)); p4.runFrame(); }
  const p5 = new E.PceConsole(rom); let bad = null, h5 = 0;
  const loaded = E.PceState.load(p5, st4);
  p5.onFrame = () => { if (!bad && log[p5.frameCount] !== p5.clock + ':' + p5.cpu.PC) bad = p5.frameCount; if (p5.frameCount === want.f + 60) h5 = frameHash(p5); };
  for (let f = want.f; f < want.f + 60; f++) { p5.setController(0, padOf(f)); p5.runFrame(); }
  ok(loaded && bad === null && h5 === h4, `onFrame の中で取った控えから、60 フレームが元と同じ(時計・PC・最後の画面)${bad !== null ? '。' + bad + ' フレーム目で違う' : ''}`);
}

// 録音 → VGM → 読み直し
const p3 = new E.PceConsole(rom);
const runPad = (f) => (f >= 200 && f % 120 < 8 ? 8 : 0);
for (let f = 0; f < N; f++) { p3.setController(0, runPad(f)); p3.runFrame(); }
p3.startRecording();
const REC = 180;
for (let f = 0; f < REC; f++) { p3.setController(0, runPad(N + f)); p3.runFrame(); }
const frames = structuredClone(p3.stopRecording());
const lens = frames.slice(1, -1).map(fr => fr.len);
ok(frames.length >= REC && lens.every(l => l === 1365 * 262 || l === 1365 * 263), `録音のフレーム列(${frames.length} 枚、長さ ${[...new Set(lens)].join('/')} マスタークロック)`);
const r = MML.VGM.encodePceRecording({ frames, name: 'test' });
const hd = MML.VGM.parseHeader(r.vgm);
const expect = frames.reduce((n, fr) => n + (fr.len || 0), 0) * 44100 / 21477270;
ok(Math.abs(r.samples - expect) < 2 && r.writes > 200, `VGM 化(${r.vgm.length} バイト、${r.writes} 書き込み、${r.samples} サンプル、チップ ${JSON.stringify(Object.keys(hd.chips || {}))})`);
const vp = new E.VgmPlayer(r.vgm);
let peak = 0, n = 0;
for (let k = 0; k < REC + 20 && n < r.samples; k++) { const a = vp.renderFrame(44100, false, true); if (!a) break; const L = a.left || a; n += L.length; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i])); }
ok(peak > 0.005, `VgmPlayer で読み直して音が出る(peak ${peak.toFixed(3)})`);
// 録音の書き込み列だけを新しい音源に流すと、本体の音源と同じレジスタの状態になるか(頭の「今の像」が足りているかの確認)
const apu = new E.APUHuC6280();
for (const fr of frames) for (const w of fr) if (w.addr !== undefined) apu.writeRegister(0x0800 | w.addr, w.value);
const regKey = (a) => a.ch.map(c => [c.freq, c.control, c.balance, c.noiseCtrl, Array.from(c.wave).join('')].join(',')).join('|') + `|${a.balance},${a.lfoFreq},${a.lfoCtrl},${a.selected}`;
ok(regKey(apu) === regKey(p3.apu), '録音の書き込み列だけで、音源のレジスタと波形が本体と同じになる');
process.exit(bad ? 1 : 0);
