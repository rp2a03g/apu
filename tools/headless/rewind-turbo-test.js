#!/usr/bin/env node
/*
 * 巻き戻しの進め直しで、連射(ターボ)を押している間のパッドの値が元と同じになるかの確認(NES / GB / スーパーゲームボーイ / MSX)。
 *   node tools/headless/rewind-turbo-test.js "game.nes" | "game.gb"
 *   node tools/headless/rewind-turbo-test.js "game.gb" --sgb-bios SGB1.sfc [--boot sgb1.boot.rom]   スーパーゲームボーイとして
 *   node tools/headless/rewind-turbo-test.js --msx                                                   MSX(スタブ BIOS+テスト ROM。ファイル不要)
 * 毎フレーム違う値を入れ、1 番に連射を掛けて 400 フレーム進め、333 フレーム目へ戻す。
 *   - 進め直しの各フレームで本体に入ったパッドの値が、元の時と同じか
 *   - 戻った所の状態が、同じ入力で頭から真っすぐ進めた時と同じか(音の出力の輪の位置などは除く)
 * PC エンジンは pce-rewind-pad-test.js(パッド 5 個・12bit も見る)。
 */
'use strict';
const { load, readBytes } = require('./load'); const { MML } = load({ strict: true });
const E = MML.Emu; let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null; }
const isMsx = process.argv.includes('--msx'), sgbBios = arg('--sgb-bios'), boot = arg('--boot');
const file = isMsx ? 'msx' : process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !/^--(sgb-bios|boot)$/.test(all[i - 1] || ''));
if (!file) { console.error('usage: node tools/headless/rewind-turbo-test.js "game.nes"|"game.gb"'); process.exit(2); }
const isGb = /\.(gb|gbc)$/i.test(file);
const Rewind = isMsx ? E.MsxRewind : sgbBios ? E.SgbRewind : isGb ? E.GbRewind : E.NesRewind, State = isMsx ? E.MsxState : sgbBios ? E.SgbState : isGb ? E.GbState : E.NesState;
const rom = isMsx ? null : readBytes(file), PORTS = (isGb && !sgbBios) ? 1 : 2;
const mk = () => {
  if (isMsx) { const { buildBios, buildTestRom } = require('./mk-msx-test-rom'); return new E.MsxConsole(buildTestRom(), { machine: 'msx2', bios: { main: buildBios(), name: 'stub' } }); }
  if (sgbBios) return new E.SgbConsole(rom, { bios: readBytes(sgbBios), bootRom: boot ? readBytes(boot) : null });
  return isGb ? new E.GbConsole(rom, { model: 'auto' }) : new E.NesConsole(rom, {});
};
// 本体に入る値: MSX はジョイスティック(joy)、スーパーゲームボーイは SNES 側のパッド端子(pad[] に書いただけでは届かないので、届いた先を見る)
const padOf = (p) => (p.snes && p.snes.pad ? Array.from(p.snes.pad) : (p.joy || p.pad).slice());
// 比べない物: 音の出力の輪の位置と端数(巻き戻しでは戻さない)、画面を送ったかの印
const SKIP = new Set(['ringHead', 'ringLen', '_frameDirty', 'frameDivider', '_frameFlag', 'apuAcc']);
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
  const p = mk(); if (p.setSampleRate) p.setSampleRate(44100);
  const r = rw ? new Rewind(p) : null;
  const orig = p.runFrame.bind(p);
  p.runFrame = () => { if (log.on) log.rows.push(p.frameCount + 1, padOf(p)); return orig(); };
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
// 押している物を両方とも同じにする。連射は外す(連射の位相をステートに持たない機種があり、巻き戻した後の位相は比べる対象でない)
for (const x of [a, b]) for (let port = 0; port < PORTS; port++) x.p.setController(port, bitsOf(END, port), 0);
// 入力の取り込み口(本体が次のフレームで読む値)は、押している物を入れ直した時の位相で 1 回ぶん違い得るので、
// 両方を同じ入力のまま 2 フレーム進めてから比べる(RAM などの本当の食い違いは進めても残る)
for (let k = 0; k < 2; k++) { a.p.runFrame(); b.p.runFrame(); }
const d = diffKeys(State.save(a.p), State.save(b.p), '', []);
ok(d.length === 0, `戻った所から 2 フレーム進めた状態が、真っすぐ進めた時と同じ${d.length ? '(違う所: ' + d.slice(0, 6).join(' ') + ')' : ''}`);
console.log(bad ? `NG ${bad} 件` : '全部 OK');
process.exit(bad ? 1 : 0);
