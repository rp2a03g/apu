#!/usr/bin/env node
/*
 * PC エンジン CD-ROM² の合成テスト CD を作る(段階 9f、DESIGN-PCE-CAPTURE.md §2.7)。
 * アーケードカードを使う実ソフトが手元に無い分を、自前の小さなプログラムを CD から起動して Mesen 2 と突き合わせて埋める。
 *
 *   node tools/headless/mk-pce-test-cd.js --donor "disc.cue" --out <フォルダ> [--scene arcade]
 *   → <フォルダ>/<場面>/disc.cue、t1.bin(音声 2 秒ぶんの無音)、t2.iso(データ)
 *   照合: node tools/headless/pce-rom-ab.js <フォルダ>/arcade/disc.cue --syscard <v3.00> --cdtype acd --keys "300-310:run" --frames 600 --mesen <CdRomType=Arcade の写し>
 *
 * 起動の仕組み: システムカードはデータトラックの頭 2 セクタを読み、1 セクタ目の頭にある指示(読むセクタの位置と数、置く番地、飛び先、MPR2-6 のバンク)
 *   のとおりにプログラムを読んで飛ぶ。頭 2 セクタにはどの CD にも同じ決まり文句が入っていて、システムカードがそれを確かめる。
 *   決まり文句は自分では作らず、--donor に渡した手持ちの CD の頭 2 セクタを借りて、指示の 13 バイトだけ書き換える
 *   (なので出来たイメージは配らない。_tmp_test の下に置く)。
 *   プログラムは $4000(MPR2 = バンク $80 = CD 装置の RAM)に置く。I/O は MPR0($0000-)、RAM は MPR1($2000-)。
 *
 * 場面 'arcade': アーケードカードの口 4 個(基準・オフセット・増分・制御の全ビット、バンク $40-$43 からの読み書き、2MB と 24bit と 16bit の折り返し、
 *   $1A40- の鏡像、知らないレジスタ)と、32bit のシフト/回転、版の印を順に触り、読んだ値を RAM $3000- に並べる。
 *   I/O の読みの値は pce-rom-ab.js が 1 個ずつ比べる。RAM と、アーケードカードの RAM も終わりに比べる。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Asm } = require('./mk-pce-test-rom');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }

// ── 場面: 操作の並び → プログラム ──
function sceneArcade() {
  const ops = [];
  const W = (a, v) => ops.push(['W', a, v & 0xFF]), R = (a) => ops.push(['R', a]), BANK = (p) => ops.push(['B', 0x40 + p]);
  const MPR = (mask, bank) => ops.push(['M', mask, bank]), RAW = (...b) => ops.push(['X', b]);
  const reg = (p, r) => 0x1A00 + p * 0x10 + r;
  const setBase = (p, v) => { W(reg(p, 2), v); W(reg(p, 3), v >> 8); W(reg(p, 4), v >> 16); };
  const setOff = (p, v) => { W(reg(p, 5), v); W(reg(p, 6), v >> 8); };
  const setInc = (p, v) => { W(reg(p, 7), v); W(reg(p, 8), v >> 8); };
  const readRegs = (p) => { for (let r = 2; r <= 0x0A; r++) R(reg(p, r)); };
  // 1. 印と、何もしていない時の読み
  R(0x1AFE); R(0x1AFF); for (let a = 0x1AE0; a <= 0x1AE5; a++) R(a);
  R(0x1A0B); R(0x1A0F); R(0x1A80); R(0x1AB0); R(0x1AE6); R(0x1BFF);
  for (let p = 0; p < 4; p++) readRegs(p);
  // 2. 口 0: 基準を進めながら 16 個書く → 読み返す
  setBase(0, 0); setOff(0, 0); setInc(0, 1); W(reg(0, 9), 0x11);
  for (let i = 0; i < 16; i++) W(reg(0, i & 1), 0xA0 + i * 5);
  readRegs(0);
  setBase(0, 0); for (let i = 0; i < 8; i++) R(reg(0, 1)); readRegs(0);
  // 3. 口 1: オフセットを足し、オフセットを進める(バンク $41 から読む)
  setBase(1, 4); setOff(1, 2); setInc(1, 3); W(reg(1, 9), 0x03);
  BANK(1); for (const a of [0x6000, 0x7FFF, 0x6123, 0x6000]) R(a);
  readRegs(1);
  // 4. 口 2: 負の向きのオフセット(オフセットが $8000 以上と未満の両方)
  setBase(2, 0x010010); setOff(2, 0xFFF0); setInc(2, 0); W(reg(2, 9), 0x0A); W(reg(2, 0), 0x5A);
  setOff(2, 0x0010); W(reg(2, 0), 0xC3);
  setBase(0, 0x010000); R(reg(0, 0)); setBase(0, 0x010020); R(reg(0, 0)); setBase(0, 0x000020); R(reg(0, 0));
  // 5. 口 3: 「オフセットを基準に足す」きっかけ 3 通り+負の向き
  setBase(3, 0x000100); setOff(3, 0);
  W(reg(3, 9), 0x20); W(reg(3, 5), 0x05); readRegs(3); W(reg(3, 6), 0x01); readRegs(3);
  W(reg(3, 9), 0x40); W(reg(3, 5), 0x07); readRegs(3); W(reg(3, 6), 0x02); readRegs(3);
  W(reg(3, 9), 0x60); W(reg(3, 5), 0x09); W(reg(3, 6), 0x00); readRegs(3); W(reg(3, 0x0A), 0xEE); readRegs(3);
  W(reg(3, 9), 0x68); W(reg(3, 0x0A), 0x00); readRegs(3);
  W(reg(3, 9), 0x00); W(reg(3, 0x0A), 0x00); readRegs(3);
  // 6. 折り返し: 2MB(番地)、24bit(基準)、16bit(オフセット)
  setBase(0, 0x1FFFFE); setInc(0, 1); W(reg(0, 9), 0x11); for (let i = 0; i < 4; i++) W(reg(0, 0), 0x31 + i); readRegs(0);
  setBase(0, 0x1FFFFE); for (let i = 0; i < 4; i++) R(reg(0, 0));
  setBase(0, 0xFFFFFF); setInc(0, 0xFFFF); R(reg(0, 0)); readRegs(0);
  setBase(1, 0); setOff(1, 0xFFFF); setInc(1, 2); W(reg(1, 9), 0x03); R(reg(1, 0)); R(reg(1, 0)); readRegs(1);
  // 7. 鏡像($1A40-$1A7F)と、制御の全ビット
  R(0x1A42); R(0x1A53); W(0x1A60, 0x77); R(0x1A79);
  W(reg(2, 9), 0xFF); R(reg(2, 9)); setBase(2, 0x000008); setOff(2, 0x0001); setInc(2, 0x0002); R(reg(2, 0)); R(reg(2, 0)); readRegs(2);
  W(reg(2, 9), 0x7F); W(reg(2, 5), 0x03); readRegs(2);
  // 8. バンク $42 / $43 / $40 からの書き込みと読み返し
  setBase(2, 0x020000); setOff(2, 0); setInc(2, 1); W(reg(2, 9), 0x11);
  BANK(2); for (const [a, v] of [[0x6000, 0x11], [0x7FFF, 0x22], [0x6ABC, 0x33], [0x6001, 0x44]]) W(a, v);
  setBase(3, 0x020000); setOff(3, 0); setInc(3, 1); W(reg(3, 9), 0x11);
  BANK(3); for (const a of [0x6000, 0x6000, 0x7000, 0x7FFF, 0x6000]) R(a);
  setBase(0, 0); setInc(0, 2); W(reg(0, 9), 0x11); BANK(0); for (let i = 0; i < 6; i++) R(0x6000 + i * 0x111);
  readRegs(0); readRegs(2); readRegs(3);
  // 9. 32bit の値のシフト
  const setVal = (v) => { W(0x1AE0, v); W(0x1AE1, v >>> 8); W(0x1AE2, v >>> 16); W(0x1AE3, v >>> 24); };
  const readVal = () => { for (let a = 0x1AE0; a <= 0x1AE5; a++) R(a); };
  setVal(0x12345678); readVal();
  for (const v of [0x01, 0x07, 0x08, 0x0F, 0x09, 0x00, 0x13, 0xF8, 0x84, 0x0C]) { W(0x1AE4, v); readVal(); if (v === 0x08 || v === 0x0F) setVal(0xFEDCBA98); }
  // 10. 回転(回す数が 0 になる値は使わない: Mesen の C++ では結果が決まらない書き方)
  setVal(0x80000001); readVal();
  for (const v of [0x01, 0x03, 0x0F, 0x0C, 0x09, 0x08, 0x07, 0x95, 0xFA]) { W(0x1AE5, v); readVal(); }
  // 11. 途中の値を口で埋めてから読む(少し広い範囲)
  setBase(1, 0x030000); setOff(1, 0x0100); setInc(1, 0x0101); W(reg(1, 9), 0x13); for (let i = 0; i < 24; i++) W(reg(1, 0), 0xE0 ^ (i * 7));
  setBase(1, 0x030000); for (let i = 0; i < 24; i++) R(reg(1, 1));
  readRegs(1);

  // ── ここから下は、別の目の見直し(§2.6)で「触っていない」と挙がった組み合わせ ──
  // 12. 読む先に前もって別々の値を置く(書いていない所は 0 なので、番地を間違えても同じ値が読めてしまう)
  const poke = (addr, v) => { setBase(0, addr); W(reg(0, 9), 0x00); W(reg(0, 0), v); };
  for (const [addr, v] of [[0x00FFFF, 0x91], [0x1F0009, 0x92], [0x1F000B, 0x93], [0x010020, 0x94], [0x000300, 0x95], [0x000302, 0x96], [0xF0300 & 0x1FFFFF, 0x97], [0x1F0300, 0x98], [0x000310, 0x99], [0x008310 & 0x1FFFFF, 0x9A]]) poke(addr, v);
  // 13. 進めない設定(bit0 = 0)で増分が 0 でない / オフセットだけ進む(bit1 = 0。番地は動かない)/ 負の向きだけ(bit3、bit1 = 0)
  setBase(1, 0x000300); setOff(1, 0x0002); setInc(1, 0x0005); W(reg(1, 9), 0x00); R(reg(1, 0)); R(reg(1, 0)); readRegs(1);
  W(reg(1, 9), 0x01); R(reg(1, 0)); R(reg(1, 0)); readRegs(1);
  setOff(1, 0x0000); W(reg(1, 9), 0x08); R(reg(1, 0)); W(reg(1, 9), 0x0A); R(reg(1, 0)); readRegs(1);
  // 14. 制御の bit2(増分を負に扱う、のはず)で増分が $8000 以上
  setBase(2, 0x000310); setOff(2, 0); setInc(2, 0x8000); W(reg(2, 9), 0x15); R(reg(2, 0)); R(reg(2, 0)); readRegs(2);
  // 15. $A への書き込み: きっかけが 1 と 2 の時は足さない
  setBase(3, 0x000400); W(reg(3, 9), 0x00); setOff(3, 0x0011); W(reg(3, 9), 0x20); W(reg(3, 0x0A), 1); readRegs(3); W(reg(3, 9), 0x40); W(reg(3, 0x0A), 1); readRegs(3);
  // 16. 決まっていない番地: 読み($1AC0-、$1B00-、$1BE0-、$1BFE)と、書いた後でレジスタが変わっていないこと
  for (const a of [0x1AC0, 0x1AC1, 0x1AC2, 0x1AC3, 0x1B00, 0x1B02, 0x1B42, 0x1BE0, 0x1BE4, 0x1BFE, 0x1AFD]) R(a);
  for (const a of [0x1A0B, 0x1A0F, 0x1A80, 0x1AC0, 0x1AE6, 0x1AFE, 0x1AFF, 0x1B02, 0x1B09, 0x1BE0, 0x1BE4]) W(a, 0x5C);
  for (let p = 0; p < 4; p++) readRegs(p); readVal(); R(0x1AFE); R(0x1AFF);
  // 17. CD 装置の側が巻き込まれていないこと($1802 割り込み許可、$1804 リセット、$180F フェーダ、$18C1 の印)
  for (const a of [0x1802, 0x1804, 0x180B, 0x180D, 0x180F, 0x18C1, 0x18C2]) R(a);
  // 18. バンクの端: $40/$41/$43 から書き、$42 から読む。隣の $3F と $44 は ROM のまま(書いてもカードの RAM に入らない)
  for (let p = 0; p < 4; p++) { setBase(p, 0x040000 + p * 0x100); setOff(p, 0); setInc(p, 1); W(reg(p, 9), 0x11); }
  BANK(0); W(0x6000, 0x61); W(0x6001, 0x62); BANK(1); W(0x7000, 0x63); BANK(3); W(0x6FFF, 0x64);
  setBase(2, 0x040000); BANK(2); R(0x6000); R(0x6000); setBase(2, 0x040100); R(0x6000); setBase(2, 0x040300); R(0x6000);
  ops.push(['B', 0x3F]); R(0x6000); R(0x7FFE); W(0x6000, 0xEE); ops.push(['B', 0x44]); R(0x6000); R(0x7FFE); W(0x6000, 0xEE);
  for (let p = 0; p < 4; p++) readRegs(p);
  // 19. 別の MPR から: バンク $40 を MPR4($8000-)に出して読む(終わったら MPR4 を元の $82 へ)
  setBase(0, 0x040000); MPR(0x10, 0x40); R(0x8000); R(0x9FFF); MPR(0x10, 0x82); readRegs(0);
  // 20. ブロック転送: RAM → 口(TIN: 送り先を動かさない)、口 → RAM(TAI: 読み元を $1A00/$1A01 で交互に)
  for (let i = 0; i < 12; i++) W(0x3F00 + i, 0xB0 + i * 3);
  setBase(0, 0x050000); setInc(0, 1); W(reg(0, 9), 0x11);
  RAW(0xD3, 0x00, 0x3F, 0x00, 0x1A, 12, 0x00);            // TIN $3F00 → $1A00、12 個
  readRegs(0); setBase(0, 0x050000);
  RAW(0xF3, 0x00, 0x1A, 0x20, 0x3F, 12, 0x00);            // TAI $1A00/$1A01 → $3F20-、12 個
  readRegs(0); for (let i = 0; i < 12; i++) R(0x3F20 + i);
  // 21. シフト/回転: 0 個になる値(シフトは「動かさない」と決まっている)、回転に 0
  setVal(0xDEADBEEF); for (const v of [0x10, 0x80, 0xF0]) { W(0x1AE4, v); readVal(); }
  W(0x1AE5, 0x00); readVal();

  const a = new Asm(0x4000);
  a.sei().csh();
  let n = 0;
  for (const op of ops) {
    if (op[0] === 'W') a.lda(op[2]).staAbs(op[1]);
    else if (op[0] === 'R') { a.ldaAbs(op[1]).staAbs(0x3000 + n); n++; }
    else if (op[0] === 'M') a.lda(op[2]).tam(op[1]);
    else if (op[0] === 'X') a.db(...op[1]);
    else a.lda(op[1]).tam(0x08);
  }
  a.lda(0xA5).staAbs(0x3000 + n).label('end').jmp('end');
  if (0x3000 + n >= 0x3F00) throw new Error('読みの数が多すぎる: ' + n);
  if (a.pc >= 0x6000) throw new Error('プログラムが $6000 を越えた(MPR3 を差し替えるので、$4000-$5FFF に収める): $' + a.pc.toString(16));
  return { code: Uint8Array.from(a.link()), reads: n, ops: ops.length };
}
const SCENES = { arcade: sceneArcade };

/** 借り物の頭 2 セクタ(各 2048 バイト)とプログラムから、データトラックの中身を作る */
function buildDataTrack(boot0, boot1, code) {
  const sectors = Math.ceil(code.length / 2048);
  if (sectors > 16) throw new Error('プログラムが大きすぎる(16 セクタまで): ' + code.length); // $4000-$BFFF に収まる範囲
  const ipl = Uint8Array.from(boot1);
  ipl.set([0x00, 0x00, 0x02, sectors, 0x00, 0x40, 0x00, 0x40, 0x00, 0x01, 0x02, 0x03, 0x04], 0); // 位置(3)、数、置く番地、飛び先、MPR2-6
  for (let i = 13; i < 32; i++) ipl[i] = 0; // 起動時の絵と音の指定は無し
  const out = new Uint8Array((2 + sectors + 300) * 2048); // 後ろに余白(短すぎるとドライブの読みが端に掛かる)
  out.set(boot0, 0); out.set(ipl, 2048); out.set(code, 4096);
  return out;
}

if (require.main === module) {
  const donor = arg('--donor', null), outDir = arg('--out', null), only = arg('--scene', null);
  if (!donor || !outDir) { console.error('usage: node tools/headless/mk-pce-test-cd.js --donor "disc.cue" --out <フォルダ> [--scene arcade]'); process.exit(2); }
  const { load } = require('./load'); const { MML } = load({ strict: true });
  const dir = path.dirname(donor);
  const files = fs.readdirSync(dir).filter(n => /\.(bin|img|iso|wav)$/i.test(n)).map(n => ({ name: n, data: new Uint8Array(fs.readFileSync(path.join(dir, n))) }));
  const disc = MML.Emu.PceDisc.fromSet({ kind: /\.ccd$/i.test(donor) ? 'ccd' : 'cue', text: fs.readFileSync(donor, 'latin1'), files });
  const t = disc.tracks.find(x => !x.audio);
  if (!t) { console.error('借りる CD にデータトラックがありません'); process.exit(1); }
  const boot0 = new Uint8Array(2048), boot1 = new Uint8Array(2048);
  disc.readData(t.first, boot0); disc.readData(t.first + 1, boot1);
  if (Buffer.from(boot1.subarray(32, 55)).toString('latin1') !== 'PC Engine CD-ROM SYSTEM') { console.error('借りる CD の頭が PC エンジンの CD の形ではありません'); process.exit(1); }
  for (const name of Object.keys(SCENES)) {
    if (only && only !== name) continue;
    const s = SCENES[name]();
    const d = path.join(outDir, name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 't1.bin'), new Uint8Array(150 * 2352));
    fs.writeFileSync(path.join(d, 't2.iso'), buildDataTrack(boot0, boot1, s.code));
    fs.writeFileSync(path.join(d, 'disc.cue'), 'FILE "t1.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nFILE "t2.iso" BINARY\n  TRACK 02 MODE1/2048\n    INDEX 01 00:00:00\n');
    console.log(`${name}: プログラム ${s.code.length} バイト、操作 ${s.ops} 個、読み ${s.reads} 個 → ${path.join(d, 'disc.cue')}`);
  }
}

module.exports = { SCENES, buildDataTrack };
