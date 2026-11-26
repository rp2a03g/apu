#!/usr/bin/env node
/*
 * PC エンジンの巻き戻しが、パッド 5 個(マルチタップ)と 6 ボタン(III〜VI)の入力を控えているかの確認。
 *   node tools/headless/pce-rewind-pad-test.js "game.pce"
 * 5 個のパッドに毎フレーム違う値(12bit)を入れて進め、途中へ巻き戻す。
 *   - 進め直しの各フレームで本体に入ったパッドの値が、元の時と同じか(5 個とも、上の 4bit も)
 *   - 戻った所の状態が、同じ入力で頭から真っすぐ進めた時と同じか
 *   - 巻き戻した後、今押している物が残っているか
 * ROM がそのパッドを読むかどうかに頼らないよう、本体に入った値そのものを比べる。
 */
'use strict';
const { load, readBytes } = require('./load'); const { MML } = load({ strict: true });
const E = MML.Emu; let bad = 0; const ok = (c, m) => { console.log((c ? 'OK  ' : 'NG  ') + m); if (!c) bad++; };
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/headless/pce-rewind-pad-test.js "game.pce"'); process.exit(2); }
const rom = readBytes(file);
const hash = (a) => { let h = 2166136261 | 0; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) | 0; return h >>> 0; };
const stateHash = (p) => { const st = E.PceState.save(p); let h = 0; const walk = (v) => { if (v && v.buffer && v.BYTES_PER_ELEMENT) h = Math.imul(h ^ hash(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), 16777619) | 0; else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.keys(v).sort().forEach(k => { if (!SKIP.has(k)) walk(v[k]); }); else if (typeof v === 'number') h = Math.imul(h ^ (v | 0), 16777619) | 0; }; walk(st); return h >>> 0; };
// 比べない物: 音の出力の輪の位置(巻き戻しでは戻さない)と、画面を送ったかの印(巻き戻しを付けた時だけ動く)
const SKIP = new Set(['ringHead', 'ringLen', '_frameDirty', 'frameDivider']);
// フレーム f のパッド port の値(12bit)。連射は 2 番だけ
const bitsOf = (f, port) => (Math.imul(f * 5 + port + 1, 2654435761) >>> 7) & 0xFFF;

for (const mode of ['tap', 'pad6']) {
  const END = 400, BACK = 333;
  const run = (upto, rw, log) => {
    const p = new E.PceConsole(rom, { pad: mode }); p.setSampleRate(44100);
    const r = rw ? new E.PceRewind(p) : null;
    const orig = p.runFrame.bind(p);
    p.runFrame = () => { if (log) log.push(p.frameCount + 1, p.pad.slice()); return orig(); };
    for (let f = 1; f <= upto; f++) {
      for (let port = 0; port < 5; port++) p.setController(port, bitsOf(f, port), port === 1 ? 0x003 : 0);
      p.runFrame(); if (r) r.onFrame();
    }
    return { p, r };
  };
  // 元: 400 フレーム進める(入ったパッドの値を控える)
  const logA = []; const a = run(END, true, logA);
  const padAt = new Map(); for (let i = 0; i < logA.length; i += 2) padAt.set(logA[i], logA[i + 1]);
  // 巻き戻す: 進め直しで入った値を控える
  const logB = []; const o2 = a.p.runFrame; a.p.runFrame = () => { logB.push(a.p.frameCount + 1, a.p.pad.slice()); return o2(); };
  // (上の run が差し替えた runFrame の上にもう 1 枚かぶせている。元の控えは logA に足されるが、もう使わない)
  const got = a.r.rewindTo(BACK);
  ok(got === BACK, `${mode}: ${BACK} フレーム目へ戻った(${got})`);
  let n = 0, diff = 0, hi = 0, far = 0;
  for (let i = 0; i < logB.length; i += 2) {
    const want = padAt.get(logB[i]), g = logB[i + 1]; n++;
    if (!want || want.some((v, k) => v !== g[k])) diff++;
    if (g[0] & 0xF00) hi++; if (g[2] | g[3] | g[4]) far++;
  }
  ok(n > 0 && diff === 0, `${mode}: 進め直しの ${n} フレームで、入ったパッドの値が元と同じ(違い ${diff})`);
  ok(hi > 0 && far > 0, `${mode}: その中に III〜VI(${hi} フレーム)と 3〜5 番(${far} フレーム)が入っている`);
  // 真っすぐ BACK まで進めた物と同じ状態か
  const b = run(BACK, false, null);
  for (let port = 0; port < 5; port++) b.p.setController(port, bitsOf(END, port), port === 1 ? 0x003 : 0); // 押している物は「今」の値に揃えて比べる
  ok(stateHash(a.p) === stateHash(b.p), `${mode}: 戻った所の状態が、真っすぐ進めた時と同じ`);
  // 今押している物(END フレーム目の値)が残っている
  let held = true; for (let port = 0; port < 5; port++) if (a.p.padHeld[port] !== bitsOf(END, port)) held = false;
  ok(held, `${mode}: 今押している物が 5 個とも残っている`);
}
console.log(bad ? `NG ${bad} 件` : '全部 OK');
process.exit(bad ? 1 : 0);
