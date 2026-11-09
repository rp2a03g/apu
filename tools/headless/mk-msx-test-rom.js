#!/usr/bin/env node
/*
 * MSX の検証用に、手組みの「スタブ BIOS」と「テスト ROM」を作る(tools/mesen/mk-sms-test-rom.js の MSX 版)。
 * 市販の BIOS/ROM に頼らずに、自前エミュレータ(src/emulator/msx/)の Z80 割り込み・VDP(SCREEN 1)・PSG・入力を通しで確かめる。
 *
 *   node tools/headless/mk-msx-test-rom.js <出力ディレクトリ>
 *     → stub-bios.rom(32K: スロット 0 に置く最小 BIOS。スロット選択・INIT 呼び出し・INT で VDP の F を読んで EI)
 *       test-tone.rom(16K カートリッジ: 'AB' ヘッダ、SCREEN 1 に文字とスプライトを出し、60 フレームごとに PSG の音程を
 *       c d e f g と変え、ジョイスティック 1 の右/スペースキーでボーダー色を変える)
 *
 * 使い方(ヘッドレス): node tools/headless/msx-run.js out/test-tone.rom --bios-main out/stub-bios.rom --machine msx1 --frames 360 --audio out.wav --png out.png
 * 期待: 画面に文字と動くスプライト、音は 1 秒ごとに c d e f g、--press right で ボーダーが変わる。
 *
 * 中身は小さな Z80 マクロアセンブラ(必要な命令だけ)で組む。ラベルは 2 パス。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function asm(build) {
  // 2 パス: 1 回目でラベルの番地を集め、2 回目で確定
  let labels = {};
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    let org = 0;
    const here = () => org + out.length;
    const L = (name) => { if (pass === 0) labels[name] = here(); else if (labels[name] !== here()) throw new Error('label moved: ' + name); };
    const ref = (name) => (pass === 0 ? 0 : (name in labels ? labels[name] : (() => { throw new Error('undefined label ' + name); })()));
    const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
    const rel = (name) => { const d = ref(name) - (here() + 2); /* 変位は命令の次の番地(オペコード+変位の 2 バイト後)基準 */ if (pass === 1 && (d < -128 || d > 127)) throw new Error('jr too far: ' + name); return d & 0xFF; };
    const A = {
      org: (a) => { if (out.length) throw new Error('org after code'); org = a; },
      db: (...b) => { for (const x of b) { if (typeof x === 'string') for (const ch of x) out.push(ch.charCodeAt(0) & 0xFF); else out.push(x & 0xFF); } },
      dw: (...v) => { for (const x of v) out.push(...w16(typeof x === 'string' ? ref(x) : x)); },
      ds: (n, v) => { for (let i = 0; i < n; i++) out.push(v || 0); },
      label: L, here, ref,
      di: () => out.push(0xF3), ei: () => out.push(0xFB), halt: () => out.push(0x76), nop: () => out.push(0x00), ret: () => out.push(0xC9),
      reti: () => out.push(0xED, 0x4D), im1: () => out.push(0xED, 0x56),
      ld_sp: (n) => out.push(0x31, ...w16(n)), ld_hl: (n) => out.push(0x21, ...w16(typeof n === 'string' ? ref(n) : n)),
      ld_de: (n) => out.push(0x11, ...w16(typeof n === 'string' ? ref(n) : n)), ld_bc: (n) => out.push(0x01, ...w16(n)),
      ld_a: (n) => out.push(0x3E, n & 0xFF), ld_b: (n) => out.push(0x06, n & 0xFF), ld_c: (n) => out.push(0x0E, n & 0xFF), ld_d: (n) => out.push(0x16, n & 0xFF), ld_e: (n) => out.push(0x1E, n & 0xFF),
      out: (p) => out.push(0xD3, p & 0xFF), in: (p) => out.push(0xDB, p & 0xFF),
      jp: (l) => out.push(0xC3, ...w16(typeof l === 'string' ? ref(l) : l)), jp_hl: () => out.push(0xE9), call: (l) => out.push(0xCD, ...w16(typeof l === 'string' ? ref(l) : l)),
      jr: (l) => out.push(0x18, rel(l)), jr_nz: (l) => out.push(0x20, rel(l)), jr_z: (l) => out.push(0x28, rel(l)), jr_nc: (l) => out.push(0x30, rel(l)), jr_c: (l) => out.push(0x38, rel(l)), djnz: (l) => out.push(0x10, rel(l)),
      ld_mem_a: (n) => out.push(0x32, ...w16(typeof n === 'string' ? ref(n) : n)), ld_a_mem: (n) => out.push(0x3A, ...w16(typeof n === 'string' ? ref(n) : n)),
      ld_hl_mem: (n) => out.push(0x2A, ...w16(typeof n === 'string' ? ref(n) : n)), ld_mem_hl: (n) => out.push(0x22, ...w16(typeof n === 'string' ? ref(n) : n)),
      ld_phl_a: () => out.push(0x77), ld_a_phl: () => out.push(0x7E), ld_phl_n: (n) => out.push(0x36, n & 0xFF), ld_a_pde: () => out.push(0x1A), ld_pde_a: () => out.push(0x12),
      inc_hl: () => out.push(0x23), dec_hl: () => out.push(0x2B), inc_de: () => out.push(0x13), inc_a: () => out.push(0x3C), dec_a: () => out.push(0x3D), inc_b: () => out.push(0x04), dec_b: () => out.push(0x05), inc_c: () => out.push(0x0C), dec_c: () => out.push(0x0D), inc_e: () => out.push(0x1C),
      ld_a_b: () => out.push(0x78), ld_a_c: () => out.push(0x79), ld_a_d: () => out.push(0x7A), ld_a_e: () => out.push(0x7B), ld_a_h: () => out.push(0x7C), ld_a_l: () => out.push(0x7D),
      ld_b_a: () => out.push(0x47), ld_c_a: () => out.push(0x4F), ld_d_a: () => out.push(0x57), ld_e_a: () => out.push(0x5F), ld_h_a: () => out.push(0x67), ld_l_a: () => out.push(0x6F), ld_l_c: () => out.push(0x69), ld_h_b: () => out.push(0x60),
      cp: (n) => out.push(0xFE, n & 0xFF), and: (n) => out.push(0xE6, n & 0xFF), or: (n) => out.push(0xF6, n & 0xFF), xor_a: () => out.push(0xAF), add: (n) => out.push(0xC6, n & 0xFF), sub: (n) => out.push(0xD6, n & 0xFF),
      or_a: () => out.push(0xB7), or_b: () => out.push(0xB0), and_c: () => out.push(0xA1), or_e: () => out.push(0xB3), dec_de: () => out.push(0x1B), add_hl_de: () => out.push(0x19), add_hl_bc: () => out.push(0x09), ex_de_hl: () => out.push(0xEB), add_a_a: () => out.push(0x87), rlca: () => out.push(0x07), rrca: () => out.push(0x0F),
      push_af: () => out.push(0xF5), pop_af: () => out.push(0xF1), push_hl: () => out.push(0xE5), pop_hl: () => out.push(0xE1), push_bc: () => out.push(0xC5), pop_bc: () => out.push(0xC1), push_de: () => out.push(0xD5), pop_de: () => out.push(0xD1),
      ldir: () => out.push(0xED, 0xB0), ex_af: () => out.push(0x08), exx: () => out.push(0xD9), bit7_a: () => out.push(0xCB, 0x7F), bit0_a: () => out.push(0xCB, 0x47), bit3_a: () => out.push(0xCB, 0x5F),
      ld_a_i: () => out.push(0xED, 0x57),
      // R800(7e)
      mulub_a_b: () => out.push(0xED, 0xC1), mulub_a_c: () => out.push(0xED, 0xC9), muluw_hl_bc: () => out.push(0xED, 0xC3),
      ld_mem_de: (n) => out.push(0xED, 0x53, ...w16(typeof n === 'string' ? ref(n) : n)), ld_mem_bc: (n) => out.push(0xED, 0x43, ...w16(n)),
      in_a_c: () => out.push(0xED, 0x78), out_c_a: () => out.push(0xED, 0x79), and_a: () => out.push(0xA7), dec_c_: () => out.push(0x0D),
    };
    build(A);
    if (pass === 1) return { bytes: Uint8Array.from(out), labels, org };
  }
  throw new Error('unreachable');
}

// ── スタブ BIOS(スロット 0、32K)──
// 0x0000: 起動。DI、SP、PPI A8 = 0b11_11_01_00(ページ 0 スロット 0、ページ 1 スロット 1、ページ 2/3 スロット 3。実機 BIOS や C-BIOS と同じく
//         ヘッダの見つかったページ 1 だけをカートリッジにし、ページ 2 はメガ ROM 側が自分で切り替える)、
//         IM1、0x4000 が 'AB' なら INIT(0x4002 の番地)へ JP。無ければ画面に色を出して HALT ループ。
// 0x0038: INT。VDP S0 を読んで F を落とし、H.KEYI 相当は無し。FD9A(H.TIMI)を CALL(RAM に RET を置くのはテスト ROM 側)… 簡単のため
//         INT ハンドラは「AF を保存、S0 読み、JIFFY(0xFC9E、実機 BIOS と同じ番地)を +1、AF 復元、EI、RETI」。
// 0x0093/0x0096: WRTPSG/RDPSG、0x004D RDVRM、0x004A WRTVRM、0x0047 WRTVDP は最小実装(本物の番地と同じ)。
// opts.ramSec: 拡張スロット 3 の中で RAM のある二次スロット(msx2/2+ の配置は 2、turboR は 0。msxConsole.js の MACHINES.layout と合わせる)
function buildBios(opts) {
  const ramSec = (opts && opts.ramSec !== undefined) ? opts.ramSec : 2;
  const r = asm((A) => {
    A.org(0);
    A.di(); A.ld_sp(0xF380); A.ld_a(0xF4); A.out(0xA8); A.im1();
    A.ld_a(ramSec * 0x55); A.ld_mem_a(0xFFFF); // スロット 3 が拡張されている機種では RAM の二次スロットを全ページに(msx2 配置 0xAA=3-2、turboR 0x00=3-0)。msx1 ではただの RAM 書き
    // マッパー RAM の既定(3,2,1,0)はエミュレータが reset で置く
    A.ld_a_mem(0x4000); A.cp(0x41); A.jr_nz('noCart'); A.ld_a_mem(0x4001); A.cp(0x42); A.jr_nz('noCart');
    A.ld_hl_mem(0x4002); A.jp_hl();
    A.label('noCart'); // カートリッジ無し: ボーダーを青(R7=0x04)にして HALT
    A.ld_a(0x04); A.out(0x99); A.ld_a(0x87); A.out(0x99); A.ld_a(0xE0); A.out(0x99); A.ld_a(0x81); A.out(0x99);
    A.ei(); A.label('idle'); A.halt(); A.jr('idle');
    while (A.here() < 0x0038) A.nop();
    // 0x0038 INT
    A.push_af(); A.in(0x99); A.ld_a_mem(0xFC9E); A.inc_a(); A.ld_mem_a(0xFC9E); A.pop_af(); A.ei(); A.reti();
    // BIOS エントリは実機と同じく 3 バイトおきの JP 表(0x0047 WRTVDP / 0x004A WRTVRM / 0x004D RDVRM / 0x0093 WRTPSG / 0x0096 RDPSG)
    while (A.here() < 0x0047) A.nop();
    A.jp('wrtvdp'); A.jp('wrtvrm'); A.jp('rdvrm');
    while (A.here() < 0x0093) A.nop();
    A.jp('wrtpsg'); A.jp('rdpsg');
    while (A.here() < 0x0100) A.nop();
    // WRTVDP: B=データ C=レジスタ番号
    A.label('wrtvdp'); A.ld_a_b(); A.out(0x99); A.ld_a_c(); A.or(0x80); A.out(0x99); A.ret();
    // WRTVRM: HL=番地 A=値
    A.label('wrtvrm'); A.push_af(); A.ld_a_l(); A.out(0x99); A.ld_a_h(); A.and(0x3F); A.or(0x40); A.out(0x99); A.pop_af(); A.out(0x98); A.ret();
    // RDVRM: HL=番地 → A
    A.label('rdvrm'); A.ld_a_l(); A.out(0x99); A.ld_a_h(); A.and(0x3F); A.out(0x99); A.in(0x98); A.ret();
    // WRTPSG: A=レジスタ E=値
    A.label('wrtpsg'); A.out(0xA0); A.ld_a_e(); A.out(0xA1); A.ret();
    // RDPSG: A=レジスタ → A
    A.label('rdpsg'); A.out(0xA0); A.in(0xA2); A.ret();
    while (A.here() < 0x8000) A.db(0xFF);
  });
  return r.bytes;
}

// ── テスト ROM(16K、0x4000 に置く)──
function buildTestRom() {
  const NOTES = [0xFE, 0xE3, 0xCA, 0xBF, 0xAA]; // c d e f g(周期の下位。上位は 0。3579545/32/254≒440Hz…近似の目安)
  const r = asm((A) => {
    A.org(0x4000);
    A.db('AB'); A.dw('init'); A.dw(0, 0, 0, 0, 0, 0); // ヘッダ(INIT、STATEMENT、DEVICE、TEXT、予約)
    A.label('init');
    A.di(); A.ld_sp(0xF380);
    // VDP: SCREEN 1。R0=0、R1=0xE2(16K、表示、IE0、16×16 スプライト)、R2=6(名前表 0x1800)、R3=0x80(色表 0x2000)、R4=0(パターン 0)、
    //      R5=0x36(属性 0x1B00)、R6=7(スプライトパターン 0x3800)、R7=0xF4(白/青)
    const regs = [0x00, 0xE2, 0x06, 0x80, 0x00, 0x36, 0x07, 0xF4];
    regs.forEach((v, i) => { A.ld_b(v); A.ld_c(i); A.call(0x0047); });
    // パターン 0x00-0xFF: 文字 n の形は「n の下位 8 ビットを 8 行」(見分けやすい縞)。番地 0 から 2048 バイト
    A.ld_hl(0x0000); A.ld_de(0x0000); // DE=文字番号(E)
    A.label('patLoop');
    A.ld_b(8);
    A.label('patRow'); A.ld_a_e(); A.call(0x004A); A.inc_hl(); A.djnz('patRow');
    A.inc_e(); A.ld_a_e(); A.or_a(); A.jr_nz('patLoop');
    // 色表(0x2000、32 バイト): 文字 8 個ごとに色。白地に 1..15
    A.ld_hl(0x2000); A.ld_b(32); A.ld_c(0x10);
    A.label('colLoop'); A.ld_a_c(); A.call(0x004A); A.inc_hl(); A.ld_a_c(); A.add(0x10); A.and(0xF0); A.jr_nz('colOk'); A.ld_a(0x10); A.label('colOk'); A.or(0x01); A.ld_c_a(); A.djnz('colLoop');
    // 名前表(0x1800、768 バイト): 位置 n に文字 n&0xFF
    A.ld_hl(0x1800); A.ld_de(0x0300);
    A.label('nameLoop'); A.ld_a_l(); A.call(0x004A); A.inc_hl(); A.ld_a_h(); A.cp(0x1B); A.jr_nz('nameLoop');
    // スプライトパターン 0(0x3800、32 バイト): 16×16 の塗りつぶし
    A.ld_hl(0x3800); A.ld_b(32);
    A.label('sprPat'); A.ld_a(0xFF); A.call(0x004A); A.inc_hl(); A.djnz('sprPat');
    // スプライト属性 0(0x1B00): y=80 x=0 pat=0 color=8(赤)。1 番は終端 0xD0
    A.ld_hl(0x1B00); A.ld_a(80); A.call(0x004A); A.inc_hl(); A.xor_a(); A.call(0x004A); A.inc_hl(); A.xor_a(); A.call(0x004A); A.inc_hl(); A.ld_a(8); A.call(0x004A); A.inc_hl(); A.ld_a(0xD0); A.call(0x004A);
    // PSG: R7=0x3E(A のトーンだけ)、R8=15、R1=0、R0=c
    A.ld_a(7); A.ld_e(0x3E); A.call(0x0093); A.ld_a(8); A.ld_e(15); A.call(0x0093); A.ld_a(1); A.ld_e(0); A.call(0x0093); A.ld_a(0); A.ld_e(NOTES[0]); A.call(0x0093);
    // 変数: 0xE000 = 音の番号、0xE001 = 前回の JIFFY
    A.xor_a(); A.ld_mem_a(0xE000); A.ld_mem_a(0xE001); A.ld_mem_a(0xFC9E);
    A.ei();
    A.label('main');
    A.halt();
    // 60 フレームごとに音程を次へ: JIFFY(0xFC9E)を 60 で割った余りが 0 で、かつ前回処理した JIFFY と違うとき
    A.ld_a_mem(0xFC9E); A.ld_c_a();            // C = 今の JIFFY
    A.ld_a_mem(0xE001); A.cp(0); A.ld_b_a();   // B = 前回処理した JIFFY
    A.ld_a_c(); A.or_a(); A.jr_z('skipNote');  // 起動直後(0)は何もしない
    A.label('mod60'); A.cp(60); A.jr_c('modDone'); A.sub(60); A.jr('mod60'); A.label('modDone');
    A.or_a(); A.jr_nz('skipNote');
    A.ld_a_c(); A.ld_mem_a(0xE001);            // 処理済みの印(同じ JIFFY では二度進めない。B と比べる)
    A.ld_a_b(); A.ld_hl(0xE003); A.ld_phl_a(); A.ld_a_c(); A.ld_hl(0xE003); A.cp(0); // (B==C なら既に処理済み)
    A.ld_a_b(); A.ld_hl(0xE004); A.ld_phl_a(); A.ld_a_c(); A.ld_hl(0xE004); // 比較: A=C と (HL)=B
    A.db(0xBE); /* CP (HL) */ A.jr_z('skipNote');
    // 次の音番号
    A.ld_a_mem(0xE000); A.inc_a(); A.cp(5); A.jr_c('noteOk'); A.xor_a(); A.label('noteOk'); A.ld_mem_a(0xE000);
    A.ld_hl('notes'); A.ld_e_a(); A.ld_d(0); A.add_hl_de(); A.ld_a_phl(); A.ld_e_a(); A.xor_a(); A.call(0x0093); // R0 = notes[n]
    // 名前表の先頭 1 文字を音番号+0x30 にして見た目も変える
    A.ld_a_mem(0xE000); A.add(0x30); A.ld_hl(0x1800); A.call(0x004A);
    A.label('skipNote');
    // スプライトを右へ 1 ドット/フレーム(x は 0x1B01)
    A.ld_a_mem(0xE002); A.inc_a(); A.ld_mem_a(0xE002); A.ld_hl(0x1B01); A.call(0x004A);
    // 入力: ジョイスティック 1 の右(R14 bit3=0)か スペース(行 8 bit0=0)でボーダーを赤(R7=0xF8)、離すと青
    A.ld_a(15); A.call(0x0096); A.and(0xBF); A.ld_e_a(); A.ld_a(15); A.call(0x0093); // R15 bit6=0: 口 1
    A.ld_a(14); A.call(0x0096); A.bit3_a(); A.jr_z('hit');
    A.ld_a(8); A.out(0xAA); A.in(0xA9); A.bit0_a(); A.jr_z('hit');
    A.ld_b(0xF4); A.jr('setBd'); A.label('hit'); A.ld_b(0xF8); A.label('setBd'); A.ld_c(7); A.call(0x0047);
    A.jp('main');
    A.label('notes'); A.db(...NOTES);
    while (A.here() < 0x8000) A.db(0xFF);
  });
  return r.bytes;
}

// ── メガ ROM のテスト(128K、種別ごと)──
// 各バンク(8K、ascii16 は 16K)の先頭+0x100 にバンク番号を置き、INIT が全部の窓でバンクを切り替えて番号を読み比べる。
// 全部合えばボーダーを緑(R7=0x02)、違えば赤(0xF8)にして HALT。種別の推定(guessType)は INIT の LD (nn),A が材料になる。
const MEGA = {
  konami:    { bankSize: 0x2000, windows: [[0x6000, 0x6000], [0x8000, 0x8000], [0xA000, 0xA000]] },           // [レジスタ, 窓]
  konamiScc: { bankSize: 0x2000, windows: [[0x5000, 0x4000], [0x7000, 0x6000], [0x9000, 0x8000], [0xB000, 0xA000]] },
  ascii8:    { bankSize: 0x2000, windows: [[0x6000, 0x4000], [0x6800, 0x6000], [0x7000, 0x8000], [0x7800, 0xA000]] },
  ascii16:   { bankSize: 0x4000, windows: [[0x6000, 0x4000], [0x7000, 0x8000]] },
};
function buildMegaRom(type) {
  const m = MEGA[type];
  if (!m) throw new Error('unknown mega type ' + type);
  const size = 0x20000, rom = new Uint8Array(size).fill(0xFF);
  const nBanks = size / m.bankSize;
  for (let b = 0; b < nBanks; b++) rom[b * m.bankSize + 0x100] = b;
  const r = asm((A) => {
    A.org(0x4000);
    A.db('AB'); A.dw('init'); A.dw(0, 0, 0, 0, 0, 0);
    A.label('init');
    A.di(); A.ld_sp(0xF380);
    // ページ 2($8000-$BFFF)を自分(ページ 1)と同じ基本スロットへ。BIOS はヘッダのあるページ 1 しか有効にしないので、
    // 実際のメガ ROM と同じく自分で切り替える(カートリッジは拡張スロットに無い前提で $A8 を直接書く)
    A.in(0xA8); A.ld_c_a(); A.and(0x0C); A.rlca(); A.rlca(); A.ld_b_a(); A.ld_a_c(); A.and(0xCF); A.or_b(); A.out(0xA8);
    A.ld_b(0xE0); A.ld_c(1); A.call(0x0047); // 表示 ON
    // 窓ごとに: バンク 1..nBanks-1 を順に選び、窓+0x100 を読んで比べる(窓 0x4000 は自分のコードがあるので最後に戻す)
    m.windows.forEach(([reg, win], wi) => {
      if (win === 0x4000) return; // 自分のコードが載っている窓は切り替えない
      A.ld_b(nBanks - 1); A.ld_a(1);
      A.label('w' + wi);
      A.ld_mem_a(reg); A.ld_c_a(); A.ld_a_mem(win + 0x100); A.db(0xB9); /* CP C */ A.jr_nz('fail');
      A.ld_a_c(); A.inc_a(); A.djnz('w' + wi);
    });
    A.ld_b(0x02); A.ld_c(7); A.call(0x0047); A.jr('done'); // 緑
    A.label('fail'); A.ld_b(0xF8); A.ld_c(7); A.call(0x0047);
    A.label('done'); A.ei(); A.label('idle'); A.halt(); A.jr('idle');
  });
  rom.set(r.bytes, 0);
  return rom;
}

// ── 音源のテスト ROM(7b)──
// 128K の konamiScc 配置(バンク 0 が 0x4000)。INIT で各音源に音を出し、60 フレームごとに音程を変える(PSG 版のテスト ROM と同じ周期):
//   PSG ch A、OPLL ch0(I/O $7C/$7D、音色 1=バイオリン)、Y8950 ch0(I/O $C0/$C1、2op 加算)+ADPCM(RAM に 64 バイト書いて再生)、
//   kind 'scc': 0x9000 に 0x3F を書いて SCC を開き、ch0 の波形(のこぎり)/周波数/音量/有効を書く(konamiScc マッパーで動かす)
//   kind 'dac': 毎フレーム 0x5000 に鋸波の値を書く(konamiDac マッパーで動かす。0x5000 は konamiScc ではバンクレジスタなので別 ROM)
//   opts.pal: INIT で VDP R9 bit1 を立てて 50Hz にする(V9938 の機種で 882 サンプル/フレームの録音になる)
// 音源の有無は見ない(無い物への書き込みは本体が捨てる)。FM は OPLL と Y8950 の両方に書くので、カートリッジ 2 次第でどちらかが鳴る。
function buildSoundTestRom(kind, opts) {
  opts = opts || {};
  const NOTES_FM = [[0xAC, 0x19], [0xC1, 0x19], [0xD9, 0x19], [0xE6, 0x19], [0x02, 0x1A]]; // OPLL: fnum lo, [key on|sus|block<<1|fnum hi](ブロック 4: c d e f g 付近)
  const NOTES_PSG = [0xFE, 0xE3, 0xCA, 0xBF, 0xAA];
  const size = 0x20000, rom = new Uint8Array(size).fill(0xFF);
  const r = asm((A) => {
    A.org(0x4000);
    A.db('AB'); A.dw('init'); A.dw(0, 0, 0, 0, 0, 0);
    A.label('init');
    A.di(); A.ld_sp(0xF380);
    // ページ 2 を自分と同じスロットへ(メガ ROM のテストと同じ)
    A.in(0xA8); A.ld_c_a(); A.and(0x0C); A.rlca(); A.rlca(); A.ld_b_a(); A.ld_a_c(); A.and(0xCF); A.or_b(); A.out(0xA8);
    A.ld_b(0xE0); A.ld_c(1); A.call(0x0047); // 表示 ON
    if (opts.pal) { A.ld_b(0x02); A.ld_c(9); A.call(0x0047); } // 50Hz(V9938)
    // PSG: ch A
    A.ld_a(7); A.ld_e(0x3E); A.call(0x0093); A.ld_a(8); A.ld_e(15); A.call(0x0093); A.ld_a(1); A.ld_e(0); A.call(0x0093); A.ld_a(0); A.ld_e(NOTES_PSG[0]); A.call(0x0093);
    // OPLL: ch0 音色 1(バイオリン)音量 0、fnum、キーオン
    const opll = (reg, val) => { A.ld_a(reg); A.out(0x7C); A.ld_a(val); A.out(0x7D); };
    opll(0x30, 0x10); opll(0x10, NOTES_FM[0][0]); opll(0x20, NOTES_FM[0][1]);
    // Y8950: ch0 の 2 オペレータ(スロット 0 と 3): MULT=1、TL=0、AR=15 DR=0、SL=0 RR=4、加算接続(C0=1)、fnum、キーオン(ブロック 4)
    const opl = (reg, val) => { A.ld_a(reg); A.out(0xC0); A.ld_a(val); A.out(0xC1); };
    opl(0x20, 0x01); opl(0x23, 0x01); opl(0x40, 0x00); opl(0x43, 0x00); opl(0x60, 0xF0); opl(0x63, 0xF0); opl(0x80, 0x04); opl(0x83, 0x04); opl(0xC0, 0x01);
    opl(0xA0, NOTES_FM[0][0]); opl(0xB0, 0x30 | ((NOTES_FM[0][1] & 1) ? 1 : 0));
    // Y8950 ADPCM: RAM の先頭 64 バイト(2 ブロック)に鋸波っぽいデータを書き、ループ再生(REPEAT)
    opl(0x07, 0x60); opl(0x09, 0x00); opl(0x0A, 0x00); opl(0x0B, 0x01); opl(0x0C, 0x00); opl(0x08, 0x00);
    A.ld_b(64); A.ld_c(0x11);
    A.label('adLoop'); A.ld_a(0x0F); A.out(0xC0); A.ld_a_c(); A.out(0xC1); A.ld_a_c(); A.add(0x21); A.ld_c_a(); A.djnz('adLoop');
    opl(0x10, 0x00); opl(0x11, 0x20); opl(0x12, 0xC0); opl(0x07, 0xB0); // DELTA-N=0x2000、音量、START|MEMDATA|REPEAT
    if (kind === 'scc') {
      // SCC: 0x9000 ← 0x3F で窓を開き、ch0 の波形(のこぎり 32 点)、周波数、音量、有効
      A.ld_a(0x3F); A.ld_mem_a(0x9000);
      A.ld_hl(0x9800); A.ld_b(32); A.ld_c(0x80);
      A.label('wvLoop'); A.ld_a_c(); A.ld_phl_a(); A.inc_hl(); A.ld_a_c(); A.add(8); A.ld_c_a(); A.djnz('wvLoop');
      A.ld_a(NOTES_PSG[0]); A.ld_mem_a(0x9880); A.xor_a(); A.ld_mem_a(0x9881); A.ld_a(15); A.ld_mem_a(0x988A); A.ld_a(0x01); A.ld_mem_a(0x988F);
    }
    A.xor_a(); A.ld_mem_a(0xE000); A.ld_mem_a(0xE001); A.ld_mem_a(0xE002); A.ld_mem_a(0xFC9E);
    A.ei();
    A.label('main');
    A.halt();
    if (kind === 'dac') { A.ld_a_mem(0xE002); A.add(0x10); A.ld_mem_a(0xE002); A.ld_mem_a(0x5000); } // DAC: 毎フレーム 1 回(鋸波)
    // 60 フレームごとに音程を次へ(JIFFY mod 60 == 0 で、前回と違うとき)
    A.ld_a_mem(0xFC9E); A.ld_c_a();
    A.ld_a_mem(0xE001); A.ld_b_a();
    A.ld_a_c(); A.or_a(); A.jr_z('skipNote');
    A.label('mod60'); A.cp(60); A.jr_c('modDone'); A.sub(60); A.jr('mod60'); A.label('modDone');
    A.or_a(); A.jr_nz('skipNote');
    A.ld_a_b(); A.ld_hl(0xE004); A.ld_phl_a(); A.ld_a_c(); A.db(0xBE); /* CP (HL) */ A.jr_z('skipNote');
    A.ld_a_c(); A.ld_mem_a(0xE001);
    A.ld_a_mem(0xE000); A.inc_a(); A.cp(5); A.jr_c('noteOk'); A.xor_a(); A.label('noteOk'); A.ld_mem_a(0xE000);
    // PSG R0 / SCC 周波数
    A.ld_hl('psgNotes'); A.ld_e_a(); A.ld_d(0); A.add_hl_de(); A.ld_a_phl(); A.ld_e_a(); A.xor_a(); A.call(0x0093);
    if (kind === 'scc') { A.ld_a_e(); A.ld_mem_a(0x9880); }
    // OPLL / Y8950: キーオフ → fnum → キーオン
    A.ld_a_mem(0xE000); A.add_a_a(); A.ld_hl('fmNotes'); A.ld_e_a(); A.ld_d(0); A.add_hl_de();
    A.ld_a(0x20); A.out(0x7C); A.xor_a(); A.out(0x7D);                          // OPLL キーオフ
    A.ld_a(0x10); A.out(0x7C); A.ld_a_phl(); A.out(0x7D); A.ld_a(0xA0); A.out(0xC0); A.ld_a_phl(); A.out(0xC1); // fnum lo
    A.inc_hl(); A.ld_a(0x20); A.out(0x7C); A.ld_a_phl(); A.out(0x7D);          // OPLL キーオン
    A.ld_a(0xB0); A.out(0xC0); A.ld_a_phl(); A.and(0x01); A.or(0x30); A.out(0xC1); // Y8950 キーオン(ブロック 4)
    A.label('skipNote');
    A.jp('main');
    A.label('psgNotes'); A.db(...NOTES_PSG);
    A.label('fmNotes'); for (const n of NOTES_FM) A.db(n[0], n[1]);
    while (A.here() < 0x6000) A.db(0xFF);
  });
  rom.set(r.bytes, 0);
  for (let b = 1; b < size / 0x2000; b++) rom[b * 0x2000 + 0x100] = b;
  return rom;
}

// ── V9938 のテスト ROM(7c)──
// 16K。INIT で画面モードを設定し、VDP コマンドで絵を描き、スプライトモード 2 とライン割り込みを使う。確認は PNG の画素(tools の v9938 検査スクリプト)。
//   kind 'g4': SCREEN5(GRAPHIC4、212 行)。HMMV で画面を色 4 で塗り → LMMV で左上に 64×32 の色 9 の矩形 → HMMM で (0,0)-(63,31) を (128,100) に転送
//              → LINE で (0,211)-(255,0) の斜線(色 15) → PSET(10,10) 色 7 → SRCH 行 10 で色 7 を探す(S8/S9)。スプライト 0(16×16、色 10)を (100,60) に、
//              スプライト 1 を同じ位置に CC=1 で色 5(OR → 15)。ライン割り込みで行 100 以降のボーダー色を 1(黒)→ 6(赤)に(R19=100)
//   kind 'g7': SCREEN8(GRAPHIC7)。HMMV で画面を GRB=0x1C(緑)に塗り、LMMV で矩形 0xE0(赤)。
//   kind 'g6': SCREEN7(GRAPHIC6、512 幅)。HMMV で色 4、LMMV で 128×32 の矩形 色 9。
//   kind 't2': SCREEN0 WIDTH 80(TEXT2)。名前表に 'A'(0x41)を並べ、パターン 0x41 を縞に。
//   kind 'scroll'(V9958、7e): SCREEN5。ページ 0 を色 4 で塗り左上 64×212 を色 9、ページ 1(VRAM $8000〜)を色 2 で塗る。R25=SP2|MSK、R26=4(32 ドット)、R27=3。
//              期待: x 0-7 ボーダー(MSK、色 6)、x 8-34 色 9(矩形 64 の残り 32+右ずらし 3)、35-226 色 4、227-255 色 2(ページ 1)
//   kind 'yjk'(V9958): SCREEN12(G7+YJK)。HMMV で全面を Y=16 K=0 J=0(バイト $80)に塗り、行 0 の 0-3 を Y=31 J=+15 K=0(バイト $F8 $F8 $FF $F9)に。
//   kind 'yae'(V9958): SCREEN10(YJK+YAE)。行 0 の 0-3 を bit3=1 の パレット 9(バイト $98)に、他は $80
function buildV9938TestRom(kind) {
  const r = asm((A) => {
    A.org(0x4000);
    A.db('AB'); A.dw('init'); A.dw(0, 0, 0, 0, 0, 0);
    A.label('init');
    A.di(); A.ld_sp(0xF380);
    const vdp = (reg, val) => { A.ld_b(val); A.ld_c(reg); A.call(0x0047); };
    const waitCe = () => { // S2 の CE(bit0)が落ちるまで待つ
      A.label('wce' + A.here()); const lbl = 'wce' + (A.here() - 0); void lbl;
    };
    // 直接ポートで待つ(BIOS に依存しない): R15 ← 2、IN $99、bit0 で分岐、R15 ← 0
    const waitCmd = (tag) => { A.di(); A.ld_a(2); A.out(0x99); A.ld_a(0x8F); A.out(0x99); A.label('wc' + tag); A.in(0x99); A.bit0_a(); A.jr_nz('wc' + tag); A.xor_a(); A.out(0x99); A.ld_a(0x8F); A.out(0x99); };
    void waitCe;
    // コマンドのレジスタ R32〜R46 を間接レジスタ(R17 ← 32、$9B へ連続)で書く
    const cmd = (vals) => { A.di(); A.ld_a(32); A.out(0x99); A.ld_a(0x91); A.out(0x99); for (const v of vals) { A.ld_a(v); A.out(0x9B); } };
    const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
    if (kind === 'scroll') {
      vdp(0, 0x06); vdp(2, 0x1F); vdp(9, 0x80); vdp(7, 0x06); vdp(8, 0x02); vdp(1, 0x60); // ボーダー 6(赤。色 0/1 は黒で見分けられない)
      cmd([...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w16(256), ...w16(212), 0x44, 0x00, 0xC0]); waitCmd('a');          // ページ 0 全面 4
      cmd([...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w16(64), ...w16(212), 0x09, 0x00, 0x80]); waitCmd('b');           // 左 64 を 9
      cmd([...w16(0), ...w16(0), ...w16(0), ...w16(256), ...w16(256), ...w16(212), 0x22, 0x00, 0xC0]); waitCmd('c');        // ページ 1(DY=256)全面 2
      vdp(27, 3); vdp(26, 4); vdp(25, 0x03);
      A.ei(); A.label('idle'); A.halt(); A.jr('idle');
    } else if (kind === 'yjk' || kind === 'yae') {
      vdp(0, 0x0E); vdp(2, 0x1F); vdp(9, 0x80); vdp(7, 0x00); vdp(8, 0x02); vdp(1, 0x60);
      cmd([...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w16(256), ...w16(212), 0x80, 0x00, 0xC0]); waitCmd('a');          // 全面 Y=16
      const vram17 = (a) => { A.di(); A.ld_a((a >> 14) & 7); A.out(0x99); A.ld_a(0x8E); A.out(0x99); A.ld_a(a & 0xFF); A.out(0x99); A.ld_a(((a >> 8) & 0x3F) | 0x40); A.out(0x99); };
      vram17(0x0000);
      for (const b of (kind === 'yjk' ? [0xF8, 0xF8, 0xFF, 0xF9] : [0x98, 0x98, 0x98, 0x98])) { A.ld_a(b); A.out(0x98); }
      vdp(25, kind === 'yjk' ? 0x08 : 0x18);
      A.ei(); A.label('idle'); A.halt(); A.jr('idle');
    } else if (kind === 'g4' || kind === 'g6' || kind === 'g7') {
      // モード: G4 = M4(R0 bit2=0x04... M3=bit1 M4=bit2 M5=bit3): G4: R0=0x06 (M4|M3)、R1=0x60(表示+IE0)、212 行 R9=0x80
      const r0 = kind === 'g4' ? 0x06 : kind === 'g6' ? 0x0A : 0x0E;
      vdp(0, r0); vdp(2, kind === 'g4' ? 0x1F : 0x1F); vdp(9, 0x80); vdp(7, kind === 'g7' ? 0x00 : 0x01); vdp(1, 0x60);
      if (kind === 'g4') { vdp(5, 0xEF); vdp(11, 0x00); vdp(6, 0x0F); } // スプライト属性 $7600(色表 $7400)、パターン $7800(R6=A16-A11)
      else vdp(8, 0x02); // g6/g7: スプライト無効(SPD)。塗りつぶしで属性表が壊れると実機同様ゴミのスプライトが出るので
      const fill = kind === 'g7' ? 0x1C : 0x44;
      // HMMV 全画面: DX=0 DY=0 NX=256(or 512) NY=212 CLR=fill ARG=0 CMD=0xC0
      cmd([...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w16(kind === 'g6' ? 512 : 256), ...w16(212), fill, 0x00, 0xC0]); waitCmd('a');
      // LMMV 矩形: DX=0 DY=0 NX=64(128) NY=32 CLR=9(0xE0) IMP
      cmd([...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w16(kind === 'g6' ? 128 : 64), ...w16(32), kind === 'g7' ? 0xE0 : 0x09, 0x00, 0x80]); waitCmd('b');
      if (kind === 'g4') {
        // HMMM (0,0)-(63,31) → (128,100)
        cmd([...w16(0), ...w16(0), ...w16(128), ...w16(100), ...w16(64), ...w16(32), 0, 0x00, 0xD0]); waitCmd('c');
        // LINE (0,211) → (255,0): 長辺 X=255、短辺 Y=211、DIY=1(上へ: ARG bit3)、色 15
        cmd([...w16(0), ...w16(0), ...w16(0), ...w16(211), ...w16(255), ...w16(211), 0x0F, 0x08, 0x70]); waitCmd('d');
        // PSET (10,10) 色 7
        cmd([...w16(0), ...w16(0), ...w16(10), ...w16(10), ...w16(0), ...w16(0), 0x07, 0x00, 0x50]); waitCmd('e');
        // SRCH 行 10、SX=0 から色 7 を探す(EQ=0)。結果 S8/S9 → RAM 0xE010/0xE011 に写す
        cmd([...w16(0), ...w16(10), ...w16(0), ...w16(0), ...w16(0), ...w16(0), 0x07, 0x00, 0x60]); waitCmd('f');
        A.ld_a(8); A.out(0x99); A.ld_a(0x8F); A.out(0x99); A.in(0x99); A.ld_mem_a(0xE010);
        A.ld_a(9); A.out(0x99); A.ld_a(0x8F); A.out(0x99); A.in(0x99); A.ld_mem_a(0xE011);
        A.xor_a(); A.out(0x99); A.ld_a(0x8F); A.out(0x99); A.di();
        // スプライト: パターン 0(16×16 塗りつぶし)を $7800 に 32 バイト。属性 $7600: #0 y=59 x=100 pat=0、#1 y=59 x=100 pat=0、#2 y=$D8。
        // 色表 $7400: #0 の 16 行 = 10、#1 の 16 行 = 0x45(CC|5)
        // ★C-BIOS の WRTVRM は 14bit(0x7600 は 0x3600 に化ける)。17bit の番地は R14 と直接ポートで(DI のまま)
        const vram17 = (a) => { A.di(); A.ld_a((a >> 14) & 7); A.out(0x99); A.ld_a(0x8E); A.out(0x99); A.ld_a(a & 0xFF); A.out(0x99); A.ld_a(((a >> 8) & 0x3F) | 0x40); A.out(0x99); };
        vram17(0x7800); A.ld_b(32); A.label('spp'); A.ld_a(0xFF); A.out(0x98); A.djnz('spp');
        vram17(0x7600); for (const b of [59, 100, 0, 0, 59, 100, 0, 0, 0xD8]) { A.ld_a(b); A.out(0x98); }
        vram17(0x7400); A.ld_b(16); A.label('sc0'); A.ld_a(10); A.out(0x98); A.djnz('sc0');
        A.ld_b(16); A.label('sc1'); A.ld_a(0x45); A.out(0x98); A.djnz('sc1');
        vdp(1, 0x62); // 16×16
        // ライン割り込み: R19=100、R0 に IE1(bit4)。BIOS の WRTVDP は EI して戻り、C-BIOS の INT は S1 を読まないので FH が立つと暴走する。
        // ここからは DI のまま直接ポートに書き、割り込みは使わずポーリングで見る
        A.di(); A.ld_a(100); A.out(0x99); A.ld_a(0x93); A.out(0x99); A.ld_a(0x16); A.out(0x99); A.ld_a(0x80); A.out(0x99);
        // H.KEYI 相当は C-BIOS に無いので割り込みは自前: IM1 の $0038 は BIOS なので、ここでは割り込みを使わずポーリング(S1 の FH)
      }
      A.xor_a(); A.ld_mem_a(0xE000);
      if (kind !== 'g4') A.ei(); else A.di(); // g4 は R15 を切り替えてポーリングするので割り込みを使わない(★R15≠0 で BIOS の INT が入ると F が消えず暴走する)
      A.label('main');
      if (kind === 'g4') {
        // ポーリング: S1(R15=1)を読み FH(bit0)なら R7=0x16(ボーダー赤)、S0 の F なら R7=0x11(ボーダー黒)。S2/S0 を読むと F が落ちるので S0 は VBlank の判定にだけ使う
        A.ld_a(1); A.out(0x99); A.ld_a(0x8F); A.out(0x99); A.in(0x99); A.bit0_a(); A.jr_z('noFh');
        A.ld_a(0x16); A.out(0x99); A.ld_a(0x87); A.out(0x99);
        A.label('noFh');
        A.xor_a(); A.out(0x99); A.ld_a(0x8F); A.out(0x99); A.in(0x99); A.bit7_a(); A.jr_z('noF');
        A.ld_a(0x11); A.out(0x99); A.ld_a(0x87); A.out(0x99);
        A.label('noF');
      } else { A.halt(); }
      A.jp('main');
    } else if (kind === 't2') {
      // TEXT2: R0=0x04(M4)、R1=0x70(表示+IE0+M1)、名前表 R2=0x03(×$1000 → $0000)、パターン R4=0x02($1000)、R7=0xF4
      vdp(0, 0x04); vdp(2, 0x03); vdp(4, 0x02); vdp(7, 0xF4); vdp(9, 0x80); vdp(1, 0x70);
      // VRAM は直接ポートで書く(DI のまま。C-BIOS の WRTVRM は EI して戻り、SCREEN0 だと INT のカーソル処理が VDP の番地を動かす)
      const vramAddr = (a) => { A.ld_a(a & 0xFF); A.out(0x99); A.ld_a(((a >> 8) & 0x3F) | 0x40); A.out(0x99); };
      A.di();
      // パターン 0x41 = 縞(0xAA/0x55)
      vramAddr(0x1000 + 0x41 * 8); A.ld_b(8); A.label('tp'); A.ld_a_b(); A.and(1); A.jr_z('tp0'); A.ld_a(0xAA); A.jr('tp1'); A.label('tp0'); A.ld_a(0x55); A.label('tp1'); A.out(0x98); A.djnz('tp');
      // 名前表 80×26 に 'A'
      vramAddr(0x0000); A.ld_de(80 * 26); A.label('tn'); A.ld_a(0x41); A.out(0x98); A.dec_de(); A.ld_a_d(); A.or_e(); A.jr_nz('tn');
      A.ei(); A.label('idle'); A.halt(); A.jr('idle');
    }
    while (A.here() < 0x8000) A.db(0xFF);
  });
  return r.bytes;
}

// ── ディスク(FDC)のテスト ROM(7d)──
// カートリッジ(16K)として動き、ルーチンを RAM($C000)へ写してから実行する: ページ 1 をスロット 3-1(ディスクインターフェース)に切り替え、
// FDC を直接叩いてトラック 0・面 0・セクタ 1 の 512 バイトを $D000 へ読む → セクタ 2 へ $D000 の反転を書く → ページ 1 を戻してボーダーを
// 緑(成功: $D000 の先頭 4 バイトが 00 01 02 03)/赤に。結果は $CFFF(1=成功)と $D000 の中身で見る。ディスク ROM は要らない(ダミーでよい)。
//   kind 'wd2793': $7FFD=モータ|ドライブ 0、$7FFC=面 0、RESTORE、セクタ=1、READ SECTOR、$7FFF の bit7(~DRQ)/bit6(~IRQ)で回す。書きは WRITE SECTOR
//   kind 'tc8566af': $7FF8=0x0C(有効+モータ)、RECALIBRATE → SENSE INT、READ DATA(C0 H0 R1 N2 EOT1 GPL DTL)を RQM/DIO で回し結果 7 バイトを捨てる。書きは WRITE DATA
function buildDiskTestRom(kind) {
  const r = asm((A) => {
    A.org(0x4000);
    A.db('AB'); A.dw('init'); A.dw(0, 0, 0, 0, 0, 0);
    A.label('init');
    A.di(); A.ld_sp(0xF380);
    // ルーチン(ram..ramEnd)を $C000 へ写して飛ぶ
    A.ld_hl('ram'); A.ld_de(0xC000); A.ld_bc(0x0400); A.ldir(); A.jp(0xC000);
    A.label('ram');
    // ── ここから $C000 で動く(ラベルは ROM 上の番地なので、RAM 内の飛び先は差分で計算: ramAt(label) = 0xC000 + (label - ram))
    const base = () => A.ref('ram');
    const at = (lbl) => 0xC000 + (A.ref(lbl) - base());
    // ページ 1 をスロット 3 へ(A8 の bit3-2 = 11)、スロット 3 の副スロット: ページ 1 を 1 に($FFFF、ページ 3 が基本スロット 3 のときだけ書ける)
    A.in(0xA8); A.ld_mem_a(0xCFF0); A.or(0x0C); A.out(0xA8);
    A.ld_a_mem(0xFFFF); A.db(0x2F); /* CPL */ A.ld_mem_a(0xCFF1); A.and(0xF3); A.or(0x04); A.ld_mem_a(0xFFFF);
    if (kind === 'wd2793') {
      A.ld_a(0x80); A.ld_mem_a(0x7FFD);           // モータ ON、ドライブ 0
      A.xor_a(); A.ld_mem_a(0x7FFC);              // 面 0
      A.ld_a(0x08); A.ld_mem_a(0x7FF8);           // RESTORE(h)
      A.label('w1'); A.ld_a_mem(0x7FF8); A.bit0_a(); A.jr_nz('w1'); // busy 待ち
      A.ld_a(1); A.ld_mem_a(0x7FFA);              // セクタ 1
      A.ld_hl(0xD000); A.ld_bc(0x0200);
      A.ld_a(0x80); A.ld_mem_a(0x7FF8);           // READ SECTOR
      A.label('rd'); A.ld_a_mem(0x7FFF); A.bit7_a(); A.jr_z('rdByte'); A.db(0xCB, 0x77); /* BIT 6,A */ A.jr_z('rdEnd'); A.jr('rd');
      A.label('rdByte'); A.ld_a_mem(0x7FFB); A.ld_phl_a(); A.inc_hl(); A.jr('rd');
      A.label('rdEnd'); A.ld_a_mem(0x7FF8); // ステータス読み(IRQ を落とす)
      // 書き: セクタ 2 に $D000 の反転
      A.ld_a(2); A.ld_mem_a(0x7FFA); A.ld_hl(0xD000); A.ld_a(0xA0); A.ld_mem_a(0x7FF8);
      A.label('wr'); A.ld_a_mem(0x7FFF); A.bit7_a(); A.jr_z('wrByte'); A.db(0xCB, 0x77); A.jr_z('wrEnd'); A.jr('wr');
      A.label('wrByte'); A.ld_a_phl(); A.db(0x2F); A.ld_mem_a(0x7FFB); A.inc_hl(); A.jr('wr');
      A.label('wrEnd'); A.ld_a_mem(0x7FF8);
    } else {
      let rqN = 0;
      const fdcW = (v) => { const l = 'rq' + (rqN++); A.label(l); A.ld_a_mem(0x7FFA); A.bit7_a(); A.jr_z(l); A.ld_a(v); A.ld_mem_a(0x7FFB); }; // RQM を待って 1 バイト
      A.ld_a(0x0C); A.ld_mem_a(0x7FF8);           // 有効+モータ、ドライブ 0
      fdcW(0x07); fdcW(0x00);                     // RECALIBRATE
      fdcW(0x08);                                 // SENSE INTERRUPT STATUS → 結果 2 バイト(読んで捨てる)
      A.label('si1'); A.ld_a_mem(0x7FFA); A.and(0xD0); A.cp(0xD0); A.jr_nz('si1'); A.ld_a_mem(0x7FFB);
      A.label('si2'); A.ld_a_mem(0x7FFA); A.and(0xD0); A.cp(0xD0); A.jr_nz('si2'); A.ld_a_mem(0x7FFB);
      // READ DATA: 0x46(MFM) drive0 C0 H0 R1 N2 EOT1 GPL 0x1B DTL 0xFF
      for (const v of [0x46, 0x00, 0x00, 0x00, 0x01, 0x02, 0x01, 0x1B, 0xFF]) fdcW(v);
      A.ld_hl(0xD000); A.ld_bc(0x0200);
      A.label('rd'); A.ld_a_mem(0x7FFA); A.bit7_a(); A.jr_z('rd'); A.db(0xCB, 0x6F); /* BIT 5,A(NDM: 実行中) */ A.jr_z('rdRes');
      A.ld_a_mem(0x7FFB); A.ld_phl_a(); A.inc_hl(); A.jr('rd');
      A.label('rdRes'); A.ld_b(7); A.label('rr'); A.label('rr2'); A.ld_a_mem(0x7FFA); A.bit7_a(); A.jr_z('rr2'); A.ld_a_mem(0x7FFB); A.djnz('rr');
      // WRITE DATA: 0x45 … セクタ 2
      for (const v of [0x45, 0x00, 0x00, 0x00, 0x02, 0x02, 0x02, 0x1B, 0xFF]) fdcW(v);
      A.ld_hl(0xD000);
      A.label('wr'); A.ld_a_mem(0x7FFA); A.bit7_a(); A.jr_z('wr'); A.db(0xCB, 0x6F); A.jr_z('wrRes');
      A.ld_a_phl(); A.db(0x2F); A.ld_mem_a(0x7FFB); A.inc_hl(); A.jr('wr');
      A.label('wrRes'); A.ld_b(7); A.label('wr2'); A.ld_a_mem(0x7FFA); A.bit7_a(); A.jr_z('wr2'); A.ld_a_mem(0x7FFB); A.djnz('wr2');
    }
    // ページ 1 を戻す(A8 と $FFFF)
    A.ld_a_mem(0xCFF1); A.ld_mem_a(0xFFFF); A.ld_a_mem(0xCFF0); A.out(0xA8);
    // 判定: $D000 の先頭 4 バイト = 00 01 02 03
    A.ld_hl(0xD000); A.ld_b(0);
    A.label('ck'); A.ld_a_phl(); A.db(0xB8); /* CP B */ A.jr_nz('bad'); A.inc_hl(); A.inc_b(); A.ld_a_b(); A.cp(4); A.jr_nz('ck');
    A.ld_a(1); A.ld_mem_a(0xCFFF); A.ld_b(0x02); A.jr('setBd');
    A.label('bad'); A.xor_a(); A.ld_mem_a(0xCFFF); A.ld_b(0xF8);
    A.label('setBd'); A.ld_c(7); A.call(0x0047);
    A.label('idle'); A.halt(); A.jr('idle');
    A.label('ramEnd');
    void at;
    while (A.here() < 0x8000) A.db(0xFF);
  });
  // RAM で動かすので、ルーチン内の絶対番地(jr は相対で OK。jp/call/ld_hl(label) は ROM の番地)は使っていない: 確認のため ram..ramEnd の 0xC3/0xCD を数える
  return r.bytes;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/headless/mk-msx-test-rom.js <outdir>'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stub-bios.rom'), buildBios());
  fs.writeFileSync(path.join(dir, 'test-tone.rom'), buildTestRom());
  for (const t of Object.keys(MEGA)) fs.writeFileSync(path.join(dir, 'mega-' + t + '.rom'), buildMegaRom(t));
  console.log('wrote', path.join(dir, 'stub-bios.rom'), 'and test-tone.rom');
}
// ── turboR のテスト ROM(7e)──
// 16K カートリッジ。DI のまま: (1) S1990 のタイマをリセットして空ループ(Z80)→ $E000/1 に経過、(2) レジスタ 6 ← $00(R800、DRAM)に切り替え
// 同じ空ループ → $E002/3、読み戻し → $E00A、(3) MULUB A,B(200×100=20000)→ $E004、MULUW HL,BC($1234×$5678=$06260060)→ $E006(HL)/$E008(DE)、
// (4) PCM: $A5 ← $02(SEL)、$A4 に鋸波を 4096 サンプル、$A5 の bit1-0 が 0 でなくなるまで待って次へ(15.75kHz)。終わったら $E00C ← 1、ボーダー緑、HALT ループ
function buildTurboRTestRom() {
  const r = asm((A) => {
    A.org(0x4000);
    A.db('AB'); A.dw('init'); A.dw(0, 0, 0, 0, 0, 0);
    A.label('init');
    A.di(); A.ld_sp(0xF380);
    A.xor_a(); A.ld_mem_a(0xE00C);
    const busy = (tag) => { A.ld_b(64); A.label('bz' + tag); A.ld_c(0); A.label('bz2' + tag); A.dec_c(); A.jr_nz('bz2' + tag); A.djnz('bz' + tag); }; // 64×256 回(Z80 で約 30 万サイクル=タイマ 2.1 万刻み。16bit を回さない大きさ)
    A.out(0xE6); busy('z'); A.in(0xE6); A.ld_mem_a(0xE000); A.in(0xE7); A.ld_mem_a(0xE001);
    A.ld_a(6); A.out(0xE4); A.xor_a(); A.out(0xE5);                 // R800 / DRAM
    A.in(0xE5); A.ld_mem_a(0xE00A);
    A.out(0xE6); busy('r'); A.in(0xE6); A.ld_mem_a(0xE002); A.in(0xE7); A.ld_mem_a(0xE003);
    A.ld_a(200); A.ld_b(100); A.mulub_a_b(); A.ld_mem_hl(0xE004);
    A.ld_hl(0x1234); A.ld_bc(0x5678); A.muluw_hl_bc(); A.ld_mem_hl(0xE006); A.ld_mem_de(0xE008);
    // PCM
    A.ld_a(0x02); A.out(0xA5);
    A.ld_de(4096); A.ld_c(0);
    A.label('pcm'); A.ld_a_c(); A.out(0xA4); A.ld_a_c(); A.add(8); A.ld_c_a();
    A.label('pw'); A.in(0xA5); A.and(0x03); A.jr_z('pw');
    A.dec_de(); A.ld_a_d(); A.or_e(); A.jr_nz('pcm');
    A.ld_a(1); A.ld_mem_a(0xE00C);
    A.ld_a(0x12); A.out(0x99); A.ld_a(0x87); A.out(0x99);           // ボーダー緑
    A.label('idle'); A.halt(); A.jr('idle');
    while (A.here() < 0x8000) A.db(0xFF);
  });
  return r.bytes;
}

module.exports = { asm, buildBios, buildTestRom, buildMegaRom, buildSoundTestRom, buildV9938TestRom, buildDiskTestRom, buildTurboRTestRom, MEGA };
