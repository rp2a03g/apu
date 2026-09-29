/*
 * EnvelopeRegistry の番号の試験(2026-09-29)
 *   node tools/headless/envreg-index-test.js
 * ソフトウェア表(0番から)とハードウェア減衰表(100番から)の番号が重ならないこと、
 * ソフトウェア表が100番を越えても前方一致の共有・ENV_MERGE・compact が効くことを確かめる。
 */
'use strict';
const { load } = require('./load');
const M = load({ strict: true }).MML;
let fail = 0, pass = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (cond) pass++; else fail++; };
const cmd = M.Convert.normalizeCmd({});
// 詰め物: k ごとに別の値列(同じ長さ・先頭2値が k で一意なので、互いに前方一致しない)
const filler = (k, tail) => ({ values: [1 + (k % 13), 1 + Math.floor(k / 13)].concat(tail), loop: null });

// 1) ハードウェア表を先に1本、そのあとソフトウェア表を120本 → 100番のハード表が上書きされないこと
{
  const r = new M.Convert.EnvelopeRegistry(cmd);
  const hwShape = { values: [15, 12, 9, 6, 3, 0], loop: null };
  const hw = r.registerShape(hwShape, true);
  const sw = [];
  for (let k = 0; k < 120; k++) sw.push(r.registerShape(filler(k, [7, 7]), false));
  ok(r.tables.get(hw) && r.tables.get(hw).hw && r.tables.get(hw).values.join() === hwShape.values.join(), `ハード表 @v${hw} が残っている`);
  ok(new Set(sw.concat([hw])).size === 121, 'ソフト120本+ハード1本の番号がすべて別');
  ok(r.registerShape(hwShape, true) === hw, 'ハード表の再登録は同じ番号を返す');
  // compact 後もハード表はハード表として引ける
  const ch = { events: sw.map(i => ({ envelopeV: i })).concat([{ envelopeV: hw }]) };
  r.compact([ch]);
  const hwIdx = ch.events[ch.events.length - 1].envelopeV;
  ok(r.tables.get(hwIdx).hw === true, 'compact 後もハード表の印が残る');
  ok(r.registerShape(hwShape, true) === hwIdx, 'compact 後もハード表を再登録すると同じ番号');
  ok(new Set(ch.events.map(e => e.envelopeV)).size === 121, 'compact 後も番号がすべて別');
  const newSw = r.registerShape({ values: [1, 2, 3, 4, 5], loop: null }, false);
  ok(!r.tables.get(newSw).hw && !ch.events.some(e => e.envelopeV === newSw), 'compact 後に足したソフト表が既存の番号と重ならない');
}
// 2) ソフト表が100番を越えても前方一致の共有が効く
{
  const r = new M.Convert.EnvelopeRegistry(cmd);
  for (let k = 0; k < 105; k++) r.registerShape(filler(k, [9, 9]), false);
  const a = r.registerShape({ values: [15, 14, 13, 12, 11, 10], loop: null }, false);
  const b = r.registerShape({ values: [15, 14, 13], loop: null }, false);
  ok(a >= 100 && a === b, `100番以降のソフト表(@v${a})にも前方一致の短い表が相乗りする`);
}
// 3) ENV_MERGE(mergeSimilar)が100番以降のソフト表も対象にし、ハード表は対象にしない
{
  const r = new M.Convert.EnvelopeRegistry(cmd);
  for (let k = 0; k < 102; k++) r.registerShape(filler(k, [8, 8, 0]), false);
  const a = r.registerShape({ values: [15, 15, 15, 9, 9, 4, 4, 4], loop: null }, false);
  const b = r.registerShape({ values: [15, 15, 9, 9, 9, 4, 4, 4], loop: null }, false);
  const h1 = r.registerShape({ values: [14, 14, 14, 7, 7, 2], loop: null }, true);
  const h2 = r.registerShape({ values: [14, 14, 7, 7, 7, 2], loop: null }, true);
  const ch = { events: [{ envelopeV: a }, { envelopeV: a }, { envelopeV: b }, { envelopeV: h1 }, { envelopeV: h2 }] };
  r.mergeSimilar([ch]);
  ok(a >= 100 && ch.events[2].envelopeV === a, `100番以降のソフト表 @v${b} が @v${a} へ統合される`);
  ok(ch.events[3].envelopeV === h1 && ch.events[4].envelopeV === h2, 'ハード表は統合されない');
}
console.log(`envreg-index: ok ${pass} / NG ${fail}`);
process.exit(fail ? 1 : 0);
