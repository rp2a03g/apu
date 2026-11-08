#!/usr/bin/env node
/*
 * MSX ステート(msxState.js)と巻き戻し(msxRewind.js)の回帰: 往復の決定性、差分圧縮の大きさ、rewindTo の復元、2 分超の容量。
 * スタブ BIOS+テスト ROM(mk-msx-test-rom.js)だけで動く。  node tools/headless/msx-state-test.js
 */
// ステート往復と巻き戻しの決定性、差分圧縮の容量を測る
const { load } = require('./load');
const { buildBios, buildTestRom } = require('./mk-msx-test-rom');
const { MML } = load({ strict: true });
const mk = () => new MML.Emu.MsxConsole(buildTestRom(), { machine: 'msx2', bios: { main: buildBios(), name: 'stub' } });
const a = mk();
for (let f = 0; f < 100; f++) { a.setController(0, f >= 50 ? 128 : 0); a.runFrame(); }
const st = MML.Emu.MsxState.save(a);
const sz = MML.Emu.MsxState.sizeOf(st);
const b = mk();
console.log('load ok', MML.Emu.MsxState.load(b, st), 'full size', sz);
for (let f = 0; f < 30; f++) { a.setController(0, 128); b.setController(0, 128); a.runFrame(); b.runFrame(); }
const same = a.frame.every((v, i) => v === b.frame[i]) && a.cpu.pc === b.cpu.pc && a.cpuCycles === b.cpuCycles;
console.log('determinism after load:', same, a.cpu.pc.toString(16), b.cpu.pc.toString(16));
// 差分圧縮
const st2 = MML.Emu.MsxState.save(a);
const packed = MML.Emu.MsxState.pack(st2, st);
console.log('packed size', MML.Emu.MsxState.sizeOf(packed), 'vs full', MML.Emu.MsxState.sizeOf(st2));
const un = MML.Emu.MsxState.unpack(packed, st);
const c = mk(); MML.Emu.MsxState.load(c, un);
for (let f = 0; f < 10; f++) { a.runFrame(); c.runFrame(); }
console.log('unpack determinism:', a.frame.every((v, i) => v === c.frame[i]) && a.cpu.pc === c.cpu.pc);
// 巻き戻し: 600 フレーム進めて 2 分ぶん超(8000 フレーム)の容量と、戻って同じ画面になるか
const d = mk(); const rw = new MML.Emu.MsxRewind(d);
const frames = [];
for (let f = 0; f < 700; f++) { d.setController(0, (f >> 5) & 1 ? 128 : 0); if (f === 300) d.setKey('Space', true); if (f === 330) d.setKey('Space', false); d.runFrame(); rw.onFrame(); if (f === 400) frames.push(d.frame.slice()); }
const t0 = Date.now(); const got = rw.rewindTo(401); const ms = Date.now() - t0;
console.log('rewindTo(401) ->', got, 'in', ms, 'ms; frame equal:', d.frame.every((v, i) => v === frames[0][i]), 'snaps', rw.snaps.length, 'bytes', rw.bytes, 'per snap', (rw.bytes / rw.snaps.length) | 0);
// 長時間: 8000 フレーム(2 分超、KEEP 240 を回す)
const e = mk(); const rw2 = new MML.Emu.MsxRewind(e); const t1 = Date.now();
for (let f = 0; f < 8000; f++) { e.setController(0, (f >> 4) & 1 ? 128 : 0); e.runFrame(); rw2.onFrame(); }
console.log('8000 frames with rewind:', Date.now() - t1, 'ms; snaps', rw2.snaps.length, 'bytes', rw2.bytes, '(' + ((rw2.bytes / 1048576).toFixed(1)) + ' MB) oldest', rw2.oldest);
