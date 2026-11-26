#!/usr/bin/env node
/*
 * 巻き戻しの進め直しで、連射(ターボ)を押している間のパッドの値が元と同じになるかの確認(NES / GB)。
 *   node tools/headless/rewind-turbo-test.js "game.nes" | "game.gb"
 * 毎フレーム違う値を入れ、1 番に連射を掛けて 400 フレーム進め、333 フレーム目へ戻す。
 *   - 進め直しの各フレームで本体に入ったパッドの値が、元の時と同じか
 *   - 戻った所の状態が、同じ入力で頭から真っすぐ進めた時と同じか(音の出力の輪の位置などは除く)
 * PC エンジンは pce-rewind-pad-test.js(パッド 5 個・12bit も見る)。
 */
'use strict';
const { load, readBytes } = require('./load'); const { MML } = load({ strict: true });
const E = MML.Emu; let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/headless/rewind-turbo-test.js "game.nes"|"game.gb"'); process.exit(2); }
const isGb = /\.(gb|gbc)$/i.test(file);
const Console = isGb ? E.GbConsole : E.NesConsole, Rewind = isGb ? E.GbRewind : E.NesRewind, State = isGb ? E.GbState : E.NesState;
const rom = readBytes(file), PORTS = isGb ? 1 : 2;
const SKIP = new Set(['ringHead', 'ringLen', '_frameDirty', 'frameDivider']);
const hash = (a) => { let h = 2166136261 | 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) | 0; return h >>> 0; };
const diffKeys = (x, y, path, out) => {
  if (x && x.buffer && x.BYTES_PER_ELEMENT) { if (!y || hash(new Uint8Array(x.buffer, x.byteOffset, x.byteLength)) !== hash(new Uint8Array(y.buffer, y.byteOffset, y.byteLength))) out.push(path); }
  else if (x && typeof x === 'object') { for (const k of Object.keys(x)) if (!SKIP.has(k)) diffKeys(x[k], y ? y[k] : undefined, path + '.' + k, out); }
  else if (x !== y) out.push(path);
  return out;
};
const bitsOf = (f, port) => (Math.imul(f * 5 + port + 1, 2654435761) >>> 7) & 0xF3; // SELECT / START は押さない(ポーズで止まると試験にならない)
const END = 400, BACK = 333, TURBO = 0x03;
const run = (upto, rw, log) => {
  const p = new Console(rom, isGb ? { model: 'auto' } : {}); p.setSampleRate(44100);
  const r = rw ? new Rewind(p) : null;
  const orig = p.runFrame.bind(p);
  p.runFrame = () => { if (log.on) log.rows.push(p.frameCount + 1, p.pad.slice()); return orig(); };
  for (let f = 1; f <= upto; f++) {
    for (let port = 0; port < PORTS; port++) p.setController(port, bitsOf(f, port), port === 0 ? TURBO : 0);
    p.runFrame(); if (r) r.onFrame();
  }
  return { p, r };
};
const logA = { on: true, rows: [] }; const a = run(END, true, logA);
const padAt = new Map(); for (let i = 0; i < logA.rows.length; i += 2) padAt.set(logA.rows[i], logA.rows[i + 1]);
const first = logA.rows.length;
const got = a.r.rewindTo(BACK);
ok(got === BACK, `${BACK} フレーム目へ戻った(${got})`);
let n = 0, diff = 0;
for (let i = first; i < logA.rows.length; i += 2) { const want = padAt.get(logA.rows[i]), g = logA.rows[i + 1]; n++; if (!want || want.some((v, k) => v !== g[k])) diff++; }
ok(n > 0 && diff === 0, `進め直しの ${n} フレームで、入ったパッドの値が元と同じ(違い ${diff})`);
const b = run(BACK, false, { on: false, rows: [] });
for (let port = 0; port < PORTS; port++) b.p.setController(port, bitsOf(END, port), port === 0 ? TURBO : 0);
const d = diffKeys(State.save(a.p), State.save(b.p), '', []);
ok(d.length === 0, `戻った所の状態が、真っすぐ進めた時と同じ${d.length ? '(違う所: ' + d.slice(0, 6).join(' ') + ')' : ''}`);
console.log(bad ? `NG ${bad} 件` : '全部 OK');
process.exit(bad ? 1 : 0);
