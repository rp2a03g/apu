#!/usr/bin/env node
/*
 * PC エンジンの合成テスト ROM を作る(段階 9c、DESIGN-PCE-CAPTURE.md §2.7)。
 * 公開のテスト ROM が少ない分を、自前の小さな ROM を Mesen 2 と突き合わせて埋める(tools/headless/pce-rom-ab.js)。
 *
 *   node tools/headless/mk-pce-test-rom.js --out <フォルダ>          全部の場面を <場面名>.pce で書き出す
 *   node tools/headless/mk-pce-test-rom.js --list                    場面の一覧
 *   const { buildTestRom, SCENES } = require('./mk-pce-test-rom')   buildTestRom('rcr') → Uint8Array(8K)
 *
 * ROM の中身(どの場面も同じ骨組み):
 *   リセット: 高速に切り替え、MPR0 = I/O・MPR1 = RAM、VCE と VDC のレジスタを表のとおりに設定、パレット 512 色、
 *             タイル 64 個と BAT(仮想画面いっぱい)、スプライトの絵とスプライト表を VRAM へ(TIA のブロック転送)、表示を入れて待つ。
 *   IRQ1: VDC のステータスを読んで RAM に控え(最後の 1 個と、ビットごとの回数)、走査線の割り込みなら横スクロールを変え、
 *         垂直帰線なら横スクロールを戻して縦スクロールを 1 進める。場面によっては VRAM を読み返したり、VRAM 間の転送を掛けたりする。
 *   場面 'pad' はパッドの端子を決まった順に読む。場面 'sgx' 'sgxmix' は SuperGrafx(.sgx で書き出す。2 個目の VDC と優先順位の石)。
 *   タイマ: 場面 'timer' だけ。割り込みごとに波形メモリ音源の DDA に値を書く(録音の時刻の確認用)。
 * 絵は式で作った模様(著作物ではない)。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── 小さなアセンブラ(使う命令だけ)──
class Asm {
  constructor(org) { this.org = org; this.b = []; this.labels = {}; this.fix = []; }
  get pc() { return this.org + this.b.length; }
  label(n) { this.labels[n] = this.pc; return this; }
  db(...v) { for (const x of v) this.b.push(x & 0xFF); return this; }
  dw(v) { if (typeof v === 'string') { this.fix.push({ at: this.b.length, n: v, abs: true }); this.b.push(0, 0); } else this.b.push(v & 0xFF, (v >> 8) & 0xFF); return this; }
  rel(n) { this.fix.push({ at: this.b.length, n, abs: false }); this.b.push(0); return this; }
  sei() { return this.db(0x78); } cli() { return this.db(0x58); } cld() { return this.db(0xD8); } csh() { return this.db(0xD4); }
  txs() { return this.db(0x9A); } pha() { return this.db(0x48); } pla() { return this.db(0x68); } rti() { return this.db(0x40); }
  phx() { return this.db(0xDA); } plx() { return this.db(0xFA); } nop() { return this.db(0xEA); } inx() { return this.db(0xE8); }
  lda(v) { return this.db(0xA9, v); } ldx(v) { return this.db(0xA2, v); }
  ldaAbs(a) { return this.db(0xAD).dw(a); } staAbs(a) { return this.db(0x8D).dw(a); } stzAbs(a) { return this.db(0x9C).dw(a); }
  staAbsX(a) { return this.db(0x9D).dw(a); }
  incAbs(a) { return this.db(0xEE).dw(a); }
  and(v) { return this.db(0x29, v); }
  tam(mask) { return this.db(0x53, mask); }
  st0(v) { return this.db(0x03, v); } st1(v) { return this.db(0x13, v); } st2(v) { return this.db(0x23, v); }
  jmp(n) { return this.db(0x4C).dw(n); }
  beq(n) { return this.db(0xF0).rel(n); } bne(n) { return this.db(0xD0).rel(n); }
  tia(src, dst, len) { return this.db(0xE3).dw(src).dw(dst).dw(len); }   // 交互(dst, dst+1)へ転送
  // VDC のレジスタへ 16bit の値
  vreg(r, v) { return this.st0(r).st1(v & 0xFF).st2((v >> 8) & 0xFF); }
  link() {
    for (const f of this.fix) {
      const t = this.labels[f.n]; if (t === undefined) throw new Error('ラベルが無い: ' + f.n);
      if (f.abs) { this.b[f.at] = t & 0xFF; this.b[f.at + 1] = (t >> 8) & 0xFF; }
      else { const d = t - (this.org + f.at + 1); if (d < -128 || d > 127) throw new Error('分岐が遠い: ' + f.n); this.b[f.at] = d & 0xFF; }
    }
    return this.b;
  }
}

// ── 絵の材料 ──
// タイル n(0-63): 8×8、4 面。VRAM では 16 語(頭 8 語 = 面 0 が下位バイト・面 1 が上位バイト、後ろ 8 語 = 面 2/3)
function tileWords(n) {
  const w = new Array(16).fill(0);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let c;
    switch (n & 7) {
      case 0: c = 0; break;                                   // 透明
      case 1: c = ((x + y + n) & 15) || 1; break;             // 斜めの縞
      case 2: c = (x ^ y) + 1 + (n >> 3); break;              // 市松の変形
      case 3: c = x === 0 || y === 0 ? 15 : (n >> 3) + 1; break; // 枠
      case 4: c = ((x * y + n) & 15); break;
      case 5: c = (x < 4) !== (y < 4) ? 9 : 0; break;         // 半分透明
      case 6: c = (x + (n >> 3)) & 15; break;                 // 横のグラデーション
      default: c = (y * 2 + (n >> 3)) & 15; break;            // 縦のグラデーション
    }
    c &= 15;
    const bit = 7 - x;
    if (c & 1) w[y] |= 1 << bit; if (c & 2) w[y] |= 0x100 << bit;
    if (c & 4) w[y + 8] |= 1 << bit; if (c & 8) w[y + 8] |= 0x100 << bit;
  }
  return w;
}
// スプライトの絵 n: 16×16、4 面。VRAM では 64 語(面ごとに 16 語、1 語が 1 行)
function spriteWords(n) {
  const w = new Array(64).fill(0);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const dx = x - 7.5, dy = y - 7.5, r = Math.sqrt(dx * dx + dy * dy);
    let c = 0;
    if (n % 3 === 0) c = r < 7.5 ? ((x + n) & 15) || 1 : 0;        // 丸
    else if (n % 3 === 1) c = (x === y || x === 15 - y || x === 0 || y === 0) ? 15 - (n & 7) : 0; // ×印と左上の枠(反転が分かる)
    else c = (x >> 2) + (y >> 2) * 4;                              // 16 色の升目(左上は透明)
    c &= 15;
    for (let p = 0; p < 4; p++) if (c & (1 << p)) w[p * 16 + y] |= 1 << (15 - x);
  }
  return w;
}
const wordsToBytes = (ws) => { const o = []; for (const v of ws) o.push(v & 0xFF, (v >> 8) & 0xFF); return o; };

// ── 場面 ──
// vce: $0400 の値。regs: VDC のレジスタ番号 → 値。cr: 表示を入れる時の R05。sprites: [y, x, 絵, 属性] の並び(最大 64)
const HV_256 = { 0x0A: 0x0202, 0x0B: 0x041F, 0x0C: 0x0D02, 0x0D: 0x00EF, 0x0E: 0x0003 }; // 5MHz、幅 256、240 行
const HV_336 = { 0x0A: 0x0403, 0x0B: 0x0629, 0x0C: 0x0D02, 0x0D: 0x00EF, 0x0E: 0x0003 }; // 7MHz、幅 336
const HV_512 = { 0x0A: 0x0B02, 0x0B: 0x063F, 0x0C: 0x0D02, 0x0D: 0x00EF, 0x0E: 0x0003 }; // 10MHz、幅 512
const spr = (list) => list;
const ROW = (y, n, step, attr, pat) => Array.from({ length: n }, (_, i) => [64 + y, 32 + 8 + i * step, (pat || 0) + (i % 6), attr]);
const SCENES = {
  // BG とスプライトの基本(大きさ、反転、優先順位、パレット)
  basic: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: spr([
    [64 + 20, 32 + 20, 0, 0x0080], [64 + 20, 32 + 44, 1, 0x0081], [64 + 20, 32 + 68, 2, 0x0082],
    [64 + 20, 32 + 100, 1, 0x0883], [64 + 20, 32 + 124, 1, 0x8084], [64 + 20, 32 + 148, 1, 0x8885],        // 左右/上下/両方の反転
    [64 + 60, 32 + 20, 0, 0x0186], [64 + 60, 32 + 60, 0, 0x1187], [64 + 100, 32 + 110, 0, 0x3188],        // 幅 32、高さ 32、高さ 64
    [64 + 60, 32 + 110, 1, 0x0909], [64 + 100, 32 + 20, 2, 0x000A], [64 + 104, 32 + 28, 0, 0x008B],       // BG の後ろ(優先 0)、重なり
    [64 - 8, 32 - 8, 0, 0x008C], [64 + 232, 32 + 248, 1, 0x008D]]) },                                     // 画面の端にはみ出す
  // 走査線の割り込みで横スクロールを割る
  rcr: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010, 0x06: 0x40 + 100 }, HV_256), cr: 0xCC, rcrScroll: 77, sprites: ROW(96, 6, 30, 0x0080) },
  // 1 行にスプライト 20 枚(16 枚を超えた分は出ない。あふれの割り込み)
  overflow: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xCA, sprites: ROW(50, 20, 12, 0x0080) },
  // スプライト 0 の衝突の割り込み
  collision: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC9, sprites: spr([[64 + 80, 32 + 80, 0, 0x0080], [64 + 86, 32 + 88, 1, 0x0081], [64 + 150, 32 + 30, 2, 0x0082]]) },
  // 263 行
  lines263: { vce: 0x04, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: ROW(120, 8, 28, 0x0080) },
  // 7MHz(幅 336)と 10MHz(幅 512、仮想画面 64 桁)
  mhz7: { vce: 0x01, regs: Object.assign({ 0x09: 0x0010 }, HV_336), cr: 0xC8, sprites: ROW(60, 10, 30, 0x0080) },
  mhz10: { vce: 0x02, regs: Object.assign({ 0x09: 0x0010 }, HV_512), cr: 0xC8, sprites: ROW(60, 14, 34, 0x0180) },
  // 白黒の印
  gray: { vce: 0x80, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: ROW(40, 6, 36, 0x0080) },
  // 仮想画面 64×64、縦にも流す
  big: { vce: 0x00, regs: Object.assign({ 0x09: 0x0050, 0x07: 0x0123, 0x08: 0x0155 }, HV_256), cr: 0xC8, sprites: [] },
  // BG だけ切、スプライトだけ切、両方切(バースト)
  bgoff: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0x48, sprites: ROW(100, 8, 28, 0x0080) },
  sproff: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0x88, sprites: ROW(100, 8, 28, 0x0080) },
  alloff: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0x08, sprites: ROW(100, 8, 28, 0x0080) },
  // 垂直帰線ごとに VRAM を 16 語読み返して RAM に控える+VRAM 間の転送(終わりの割り込みつき)
  vramio: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010, 0x0F: 0x0012 }, HV_256), cr: 0xC8, sprites: ROW(100, 4, 40, 0x0080), readback: true, dma: true },
  // 表示中(垂直帰線の外)に VRAM へ書き続ける: 待たされ方の確認
  busy: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: ROW(100, 12, 18, 0x0080), busyWrite: true },
  // パッドの端子: SEL/CLR を決まった順に上げ下げしながら読む(6 ボタンの見分け、マルチタップの番送り)。読んだ値は RAM $2300〜
  pad: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: [], padSeq: [1, 3, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 3, 1, 0, 2, 0, 1, 3, 1, 0, 3, 0, 1, 0] },
  // SuperGrafx: 2 個目の VDC にも BG とスプライトを出し、窓 2 つで重ね方を 4 通りに分ける(拡張子 .sgx で書き出す)
  sgx: { sgx: true, vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: ROW(60, 8, 30, 0x0080),
    vpc: { 0x08: 0xB7, 0x09: 0x23, 0x0A: 120, 0x0B: 0, 0x0C: 200, 0x0D: 0 }, sprites2: ROW(90, 8, 26, 0x0081, 2) },
  // SuperGrafx: 重ね方を毎フレーム書き換える(行の途中ではなく垂直帰線で)+ ST0-2 の書き先を VDC2 に切り替える
  sgxmix: { sgx: true, vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: ROW(100, 6, 34, 0x0080),
    vpc: { 0x08: 0x37, 0x09: 0x7B, 0x0A: 80, 0x0B: 0, 0x0C: 160, 0x0D: 0 }, sprites2: ROW(110, 6, 30, 0x0082, 1), vpcFlip: true },
  // タイマ割り込みで DDA
  timer: { vce: 0x00, regs: Object.assign({ 0x09: 0x0010 }, HV_256), cr: 0xC8, sprites: [], timer: 3 },
};

function buildTestRom(name) {
  const sc = SCENES[name];
  if (!sc) throw new Error('場面が無い: ' + name);
  const ROM = new Uint8Array(0x2000);
  const ORG = 0xE000;
  // データ(ROM の後ろ半分に置く)
  const data = []; const place = (bytes) => { const at = ORG + 0x0800 + data.length; for (const v of bytes) data.push(v & 0xFF); return at; };
  const pal = []; for (let i = 0; i < 512; i++) { const v = i < 256 ? (((i * 37) ^ (i >> 4) * 73) & 0x1FF) : (((i * 59) + 0x49) & 0x1FF); pal.push((i & 15) === 0 && i !== 0 && i !== 256 ? 0 : v); }
  pal[0] = 0x049; pal[256] = 0x1C0; // 背景色と枠の色は分かりやすい別の色
  const palAt = place(wordsToBytes(pal));
  const tiles = []; for (let n = 0; n < 64; n++) tiles.push(...tileWords(n));
  const tilesAt = place(wordsToBytes(tiles));
  const sprPat = []; for (let n = 0; n < 8; n++) sprPat.push(...spriteWords(n));
  const sprAt = place(wordsToBytes(sprPat));
  const satb = new Array(256).fill(0);
  (sc.sprites || []).slice(0, 64).forEach((s, i) => { satb[i * 4] = s[0] & 0x3FF; satb[i * 4 + 1] = s[1] & 0x3FF; satb[i * 4 + 2] = (0x5000 >> 5) + ((s[2] & 7) << 1); satb[i * 4 + 3] = s[3]; });
  const satbAt = place(wordsToBytes(satb));
  const satb2 = new Array(256).fill(0);
  (sc.sprites2 || []).slice(0, 64).forEach((s, i) => { satb2[i * 4] = s[0] & 0x3FF; satb2[i * 4 + 1] = s[1] & 0x3FF; satb2[i * 4 + 2] = (0x5000 >> 5) + ((s[2] & 7) << 1); satb2[i * 4 + 3] = s[3]; });
  const satb2At = sc.sgx ? place(wordsToBytes(satb2)) : 0;
  // BAT は 1 行ぶん(128 語)の模様を 2 種類持ち、行ごとに交互に転送する(ROM を小さく保つ)
  const batRow = (k) => { const o = []; for (let x = 0; x < 128; x++) o.push((((x + k * 3) & 15) << 12) | (0x100 + ((x * 5 + k * 11) & 63))); return o; };
  const batA = place(wordsToBytes(batRow(0))), batB = place(wordsToBytes(batRow(1)));
  if (ORG + 0x0800 + data.length > 0xFFF0) throw new Error('データが入りきらない');

  const a = new Asm(ORG);
  a.label('reset').sei().csh().cld()
    .lda(0xFF).tam(0x01).lda(0xF8).tam(0x02)
    .ldx(0xFF).txs()
    .lda(0x07).staAbs(0x1402).staAbs(0x1403)     // 割り込みは全部止めておく
    .lda(sc.vce).staAbs(0x0400)
    .vreg(0x05, 0x0000);                          // 表示も割り込みも切
  for (const r of Object.keys(sc.regs)) a.vreg(+r, sc.regs[r]);
  // パレット
  a.stzAbs(0x0402).stzAbs(0x0403).tia(palAt, 0x0404, 1024);
  // タイル($1000〜、タイル番号 $100〜)
  a.vreg(0x00, 0x1000).st0(0x02).tia(tilesAt, 0x0002, 64 * 16 * 2);
  // BAT: 仮想画面の幅ぶんを行ごとに
  const cols = [32, 64, 128, 128][((sc.regs[0x09] || 0) >> 4) & 3], rows = ((sc.regs[0x09] || 0) & 0x40) ? 64 : 32;
  a.vreg(0x00, 0x0000).st0(0x02);
  for (let y = 0; y < rows; y++) a.tia((y & 1) ? batB : batA, 0x0002, cols * 2);
  // スプライトの絵($5000〜)とスプライト表($7F00)
  a.vreg(0x00, 0x5000).st0(0x02).tia(sprAt, 0x0002, 8 * 64 * 2);
  a.vreg(0x00, 0x7F00).st0(0x02).tia(satbAt, 0x0002, 512);
  a.vreg(0x13, 0x7F00);
  if (sc.sgx) {
    // 2 個目の VDC($0010-$0013)。ST0-2 は使わず番地で書く
    const v2 = (r, v) => a.lda(r).staAbs(0x0010).lda(v & 0xFF).staAbs(0x0012).lda((v >> 8) & 0xFF).staAbs(0x0013);
    v2(0x05, 0x0000);
    for (const r of Object.keys(sc.regs)) v2(+r, sc.regs[r]);
    v2(0x07, 0x0004); v2(0x08, 0x0006);                                  // スクロールを少しずらす
    v2(0x00, 0x1000); a.lda(0x02).staAbs(0x0010).tia(tilesAt, 0x0012, 64 * 16 * 2);
    v2(0x00, 0x0000); a.lda(0x02).staAbs(0x0010);
    for (let y = 0; y < rows; y++) a.tia((y & 1) ? batA : batB, 0x0012, cols * 2);   // 1 個目と行の模様を入れ替える
    v2(0x00, 0x5000); a.lda(0x02).staAbs(0x0010).tia(sprAt, 0x0012, 8 * 64 * 2);
    v2(0x00, 0x7F00); a.lda(0x02).staAbs(0x0010).tia(satb2At, 0x0012, 512);
    v2(0x13, 0x7F00);
    v2(0x05, sc.cr & 0xC0);                                              // 表示だけ入れる(割り込みは 1 個目から)
    for (const r of Object.keys(sc.vpc)) a.lda(sc.vpc[r]).staAbs(+r);
  }
  if (sc.dma) a.vreg(0x10, 0x1000).vreg(0x11, 0x6000).vreg(0x12, 0x00FF); // VRAM 間の転送($1000 → $6000、256 語)
  // RAM の控えを 0 に
  a.ldx(0x00).lda(0x00).label('clr').staAbsX(0x2200).inx().bne('clr');
  if (sc.timer !== undefined) {
    // 波形メモリ音源: ch1 を DDA に。タイマを回す
    a.lda(0xFF).staAbs(0x0801).stzAbs(0x0800).lda(0xFF).staAbs(0x0805).lda(0xDF).staAbs(0x0804)
      .lda(sc.timer).staAbs(0x0C00).lda(0x01).staAbs(0x0C01);
  }
  a.lda(sc.timer !== undefined ? 0x01 : 0x05).staAbs(0x1402);          // IRQ1(とタイマ)だけ通す。IRQ2 は止める
  a.vreg(0x05, sc.cr);
  a.cli();
  if (sc.padSeq) sc.padSeq.forEach((v, i) => { a.lda(v).staAbs(0x1000).ldaAbs(0x1000).staAbs(0x2300 + i); });
  a.label('main');
  if (sc.busyWrite) a.vreg(0x00, 0x6800).st0(0x02).st1(0x55).st2(0xAA).st1(0x33).st2(0xCC).st1(0x0F).st2(0xF0).incAbs(0x2210);
  a.jmp('main');

  // IRQ1(VDC)
  a.label('irq1').pha().phx()
    .ldaAbs(0x0000).staAbs(0x2200)                 // ステータス(読むと消える)
    .pha();
  for (let bit = 0; bit < 6; bit++) a.pla().pha().and(1 << bit).beq('nb' + bit).incAbs(0x2201 + bit).label('nb' + bit);
  a.pla().pha().and(0x04).beq('norcr');
  if (sc.rcrScroll !== undefined) a.vreg(0x07, sc.rcrScroll);
  a.label('norcr').pla().and(0x20).bne('vbl').jmp('novbl').label('vbl'); // 垂直帰線の処理は長い場面があるので、近い分岐で飛び越す
  a.incAbs(0x2208);
  if (sc.rcrScroll !== undefined) a.vreg(0x07, 0x0000);
  a.st0(0x08).ldaAbs(0x2208).staAbs(0x0002).stzAbs(0x0003);          // 縦スクロール = フレーム数
  if (sc.readback) {
    a.vreg(0x01, 0x1000).st0(0x02);
    for (let i = 0; i < 16; i++) a.ldaAbs(0x0002).staAbs(0x2220 + i * 2).ldaAbs(0x0003).staAbs(0x2221 + i * 2);
  }
  if (sc.dma) a.vreg(0x10, 0x1000).vreg(0x11, 0x6000).vreg(0x12, 0x00FF);
  if (sc.padSeq) sc.padSeq.forEach((v, i) => { a.lda(v).staAbs(0x1000).ldaAbs(0x1000).staAbs(0x2340 + i); });
  if (sc.vpcFlip) {
    // 偶数フレームと奇数フレームで重ね方を入れ替え、ST0-2 の書き先も切り替える(奇数の時は ST で VDC2 の横スクロールを書く)
    a.ldaAbs(0x2208).and(0x01).beq('even')
      .lda(0x7B).staAbs(0x0008).lda(0x37).staAbs(0x0009).lda(0x01).staAbs(0x000E).st0(0x07).ldaAbs(0x2208).staAbs(0x0012).stzAbs(0x0013).stzAbs(0x000E).jmp('vpcdone')
      .label('even').lda(0x37).staAbs(0x0008).lda(0x7B).staAbs(0x0009).label('vpcdone');
  }
  a.label('novbl').plx().pla().rti();
  // タイマ
  a.label('timer').pha().staAbs(0x1403).incAbs(0x2209).ldaAbs(0x2209).and(0x1F).staAbs(0x0806).pla().rti();
  a.label('irq2').rti();
  const code = a.link();
  if (code.length > 0x0800) throw new Error('コードが長い: ' + code.length);
  ROM.set(code, 0);
  ROM.set(data, 0x0800);
  const vec = (at, n) => { const t = a.labels[n]; ROM[at] = t & 0xFF; ROM[at + 1] = t >> 8; };
  vec(0x1FF6, 'irq2'); vec(0x1FF8, 'irq1'); vec(0x1FFA, 'timer'); vec(0x1FFC, 'irq2'); vec(0x1FFE, 'reset');
  return ROM;
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
  if (process.argv.includes('--list')) { for (const k of Object.keys(SCENES)) console.log(k); process.exit(0); }
  const out = arg('--out', null);
  if (!out) { console.error('usage: node tools/headless/mk-pce-test-rom.js --out <フォルダ> | --list'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  for (const k of Object.keys(SCENES)) { fs.writeFileSync(path.join(out, k + (SCENES[k].sgx ? '.sgx' : '.pce')), buildTestRom(k)); }
  console.log(`${Object.keys(SCENES).length} 本を書き出しました: ${out}`);
}
module.exports = { buildTestRom, SCENES, Asm };
