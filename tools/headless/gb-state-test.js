#!/usr/bin/env node
/*
 * ゲームボーイ本体まわりの通し確認(msx-state-test.js の GB 版): 中身判定、ステート保存/復元、巻き戻し、録音 → VGM → VgmPlayer で読み直し、
 * 書き込み列から鍵盤表示の値。  node tools/headless/gb-state-test.js [game.gb]
 */
const { load, readBytes } = require('./load'); const { MML } = load({ strict: true });
const { buildTestRom } = require('./mk-gb-test-rom');
const E = MML.Emu; let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
const path = require('path');
const acid = buildTestRom({ mbc: 'rom' });
ok(E.Image.detect(acid, 'x.gb').kind === 'gb', '中身判定 .gb');
ok(E.Image.detect(acid, 'noext').kind === 'gb', '中身判定 拡張子なし(ヘッダで)');
ok(E.Image.detect(buildTestRom({ mbc: 'mbc1' }), 'a.rom').kind === 'gb', '中身判定 .rom でもヘッダが GB なら GB');
const hash = (a) => { let h = 2166136261 | 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) | 0; return h >>> 0; };

// 状態保存/復元: 60 フレーム目で保存 → 120 まで進めて画面を控える → 復元 → 同じだけ進めて同じ画面か
const rom = process.argv[2] ? readBytes(process.argv[2]) : buildTestRom({ mbc: 'mbc5' }); // 実ソフトで確かめる時は ROM を引数に
const gb = new E.GbConsole(rom); gb.setSampleRate(44100);
for (let f = 0; f < 60; f++) gb.runFrame();
const st = E.GbState.save(gb);
const copy = structuredClone(st);
for (let f = 0; f < 60; f++) gb.runFrame();
const h1 = hash(new Uint8Array(gb.frame.buffer)), pc1 = gb.cpu.pc, cyc1 = gb.cpuCycles;
ok(E.GbState.load(gb, copy), 'ステート読込(structuredClone を通した物)');
for (let f = 0; f < 60; f++) gb.runFrame();
ok(hash(new Uint8Array(gb.frame.buffer)) === h1 && gb.cpu.pc === pc1 && gb.cpuCycles === cyc1, `復元後に同じ結果(pc $${gb.cpu.pc.toString(16)} / $${pc1.toString(16)})`);
ok(!E.GbState.load(new E.GbConsole(acid), copy), '別の ROM のステートは拒否');

// 巻き戻し
const g2 = new E.GbConsole(rom); const rw = new E.GbRewind(g2);
const shots = {};
for (let f = 0; f < 200; f++) { g2.setController(0, f % 50 < 10 ? 8 : 0); g2.runFrame(); rw.onFrame(); if (g2.frameCount === 130) shots.h = hash(new Uint8Array(g2.frame.buffer)); if (g2.frameCount === 130) shots.cyc = g2.cpuCycles; }
const got = rw.rewindTo(130);
ok(got === 130 && g2.cpuCycles === shots.cyc && hash(new Uint8Array(g2.frame.buffer)) === shots.h, `巻き戻し 200 → 130(戻った ${got})`);
ok(rw.beginReverse() && !!rw.reverseStep() && rw.palette.length === 256, '逆再生の 1 枚と色表');
rw.endReverse();

// 録音 → VGM → 読み直し
const g3 = new E.GbConsole(buildTestRom({ mbc: 'mbc1' })); g3.startRecording();
for (let f = 0; f < 90; f++) g3.runFrame();
const frames = structuredClone(g3.stopRecording());
ok(frames.length >= 90 && frames[5].len === 70224, `録音のフレーム列(${frames.length} 枚、len が複製後も残る: ${frames[5].len})`);
const r = MML.VGM.encodeGbRecording({ frames, name: 'test' });
const hd = MML.VGM.parseHeader(r.vgm);
ok(Math.abs(r.samples - 90 * 70224 * 44100 / 4194304) < 800 && r.writes > 40, `VGM 化(${r.vgm.length} バイト、${r.writes} 書き込み、${r.samples} サンプル)`);
const vp = new E.VgmPlayer(r.vgm);
let peak = 0, n = 0;
for (let k = 0; k < 120 && n < r.samples; k++) { const a = vp.renderFrame(44100, false, true); if (!a) break; const L = a.left || a; n += L.length; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i])); }
ok(peak > 0.01, `VgmPlayer で読み直して音が出る(peak ${peak.toFixed(3)}、チップ ${JSON.stringify(Object.keys(hd.chips || {}))})`);
// ライブ表示の stepper と同じ流れ: 書き込みを APU に流して鍵盤の値を取る
const apu = new E.APUGb(); let act = 0;
for (const fr of frames) { for (const w of fr) if (w.addr >= 0xFF10) apu.writeRegister(w.addr, w.value); apu.advance(70224); if (E.snapshotGbApu(apu).ch2.active) act++; }
ok(act > 10, `書き込み列から鍵盤の値(CH2 が鳴っているフレーム ${act})`);
process.exit(bad ? 1 : 0);
