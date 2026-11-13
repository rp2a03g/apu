#!/usr/bin/env node
/*
 * ゲームボーイ本体(src/emulator/gb/)の通し試験用 ROM を作る(市販 ROM もテスト ROM も無しで骨格を確かめる)。
 *
 *   node tools/headless/mk-gb-test-rom.js out.gb [--mbc rom|mbc1|mbc3|mbc5]
 *   const { buildTestRom, EXPECT } = require('./mk-gb-test-rom');
 *
 * やること(結果は 1 文字ずつシリアルへ出す。全部通ると EXPECT と同じ文字列になる):
 *   1. タイマ割り込み: TAC=5(16T ごと)で TIMA をあふれさせ、HALT×3 の間に来た回数 → '3'
 *   2. EI の遅れ: 割り込み保留のまま EI; INC B; … で、INC B が先に実行される → 'E'
 *   3. HALT バグ: IME=0 で保留ありの HALT の次の 1 バイト(INC B)が 2 度実行される → 'H'
 *   4. VBlank 待ち(LY をポーリング)→ 'V'。その後タイル 1 を黒で塗って左上に置く(画面が 2 色になる)
 *   5. バンク切り替え(MBC つきの時): バンク 2 の $4000 を読む → 'B'(ROM のみなら '-')
 *   6. セーブ RAM(RAM つきの時): 許可して書いて読む → 'R'(無ければ '-')
 *   7. CH2 を鳴らす(音のピークが出る)→ 'K'。以後 HALT で回り続ける
 *   失敗した項目は '!' を出す。
 */
'use strict';

const EXPECT_BY_MBC = { rom: '3EHV--K', mbc1: '3EHVBRK', mbc3: '3EHVBRK', mbc5: '3EHVBRK' };
const TYPE = { rom: 0x00, mbc1: 0x03, mbc3: 0x13, mbc5: 0x1B };

// ラベルつきの極小アセンブラ(バイト列を並べ、JR/CALL/JP の飛び先だけ後で埋める)
class Asm {
  constructor(org) { this.org = org; this.out = []; this.labels = {}; this.fix = []; }
  get pc() { return this.org + this.out.length; }
  b(...bytes) { for (const x of bytes) this.out.push(x & 0xFF); return this; }
  label(name) { this.labels[name] = this.pc; return this; }
  jr(op, name) { this.out.push(op, 0); this.fix.push({ at: this.out.length - 1, name, rel: true }); return this; }
  abs(op, name) { this.out.push(op, 0, 0); this.fix.push({ at: this.out.length - 2, name, rel: false }); return this; }
  done() {
    for (const f of this.fix) {
      const t = this.labels[f.name];
      if (t === undefined) throw new Error('未定義ラベル ' + f.name);
      if (f.rel) { const d = t - (this.org + f.at + 1); if (d < -128 || d > 127) throw new Error('JR が届かない ' + f.name); this.out[f.at] = d & 0xFF; }
      else { this.out[f.at] = t & 0xFF; this.out[f.at + 1] = t >> 8; }
    }
    return this.out;
  }
}

function buildTestRom(opt) {
  const mbc = (opt && opt.mbc) || 'mbc1';
  const banked = mbc !== 'rom';
  const rom = new Uint8Array(banked ? 0x10000 : 0x8000).fill(0xFF);

  const a = new Asm(0x150);
  const putc = (ch) => a.b(0x3E, ch.charCodeAt(0)).abs(0xCD, 'putc');   // LD A,ch / CALL putc
  const fail = (name) => { a.label(name); putc('!'); };
  a.b(0xF3, 0x31, 0xFE, 0xFF);                       // DI / LD SP,$FFFE
  // 1. タイマ割り込み
  a.b(0xAF, 0x4F, 0xE0, 0x06, 0xE0, 0x05);           // XOR A / LD C,A / LDH (TMA),A / LDH (TIMA),A
  a.b(0x3E, 0x05, 0xE0, 0x07);                       // TAC=5
  a.b(0x3E, 0x04, 0xE0, 0xFF, 0xAF, 0xE0, 0x0F);     // IE=タイマ / IF=0
  a.b(0xFB, 0x76, 0x00, 0x76, 0x00, 0x76, 0x00, 0xF3); // EI / HALT NOP ×3 / DI
  a.b(0xAF, 0xE0, 0x07);                             // TAC=0
  a.b(0x79, 0xC6, 0x30).abs(0xCD, 'putc');           // LD A,C / ADD '0' / CALL putc
  // 2. EI の遅れ: IF にタイマを立てておき EI; INC B。ISR は C に B を写す(INC B の後なら C=1)
  a.b(0x06, 0x00, 0x0E, 0xFF);                       // LD B,0 / LD C,$FF
  a.b(0x3E, 0x04, 0xE0, 0x0F);                       // IF=タイマ
  a.b(0x3E, 0x01, 0xEA, 0x00, 0xC0);                 // LD A,1 / LD ($C000),A  ISR のモード=1(C←B)
  a.b(0xFB, 0x04, 0x00, 0x00, 0xF3);                 // EI / INC B / NOP / NOP / DI
  a.b(0x79, 0xFE, 0x01).jr(0x20, 'f2');              // LD A,C / CP 1 / JR NZ,fail
  putc('E'); a.jr(0x18, 't3');
  fail('f2');
  // 3. HALT バグ: IME=0、IF&IE≠0 で HALT → 次の INC B が 2 度
  a.label('t3');
  a.b(0x06, 0x00, 0x3E, 0x04, 0xE0, 0x0F);           // LD B,0 / IF=タイマ(IE もタイマ)
  a.b(0x76, 0x04);                                   // HALT / INC B
  a.b(0xAF, 0xE0, 0x0F);                             // IF=0
  a.b(0x78, 0xFE, 0x02).jr(0x20, 'f3');              // LD A,B / CP 2
  putc('H'); a.jr(0x18, 't4');
  fail('f3');
  // 4. VBlank 待ち+絵
  a.label('t4');
  a.label('wv').b(0xF0, 0x44, 0xFE, 0x90).jr(0x20, 'wv'); // LDH A,(LY) / CP 144 / JR NZ
  a.b(0x21, 0x10, 0x80, 0x06, 0x10, 0x3E, 0xFF);     // LD HL,$8010 / LD B,16 / LD A,$FF
  a.label('fill').b(0x22, 0x05).jr(0x20, 'fill');    // LD (HL+),A / DEC B / JR NZ
  a.b(0x3E, 0x01, 0xEA, 0x00, 0x98);                 // LD A,1 / LD ($9800),A
  a.b(0x3E, 0xE4, 0xE0, 0x47);                       // BGP=$E4
  putc('V');
  // 5. バンク切り替え
  if (banked) {
    a.b(0x3E, 0x02, 0xEA, 0x00, 0x20);               // LD A,2 / LD ($2000),A
    a.b(0xFA, 0x00, 0x40, 0xFE, 0xB2).jr(0x20, 'f5'); // LD A,($4000) / CP $B2
    a.b(0x3E, 0x01, 0xEA, 0x00, 0x20);               // バンク 1 に戻す
    a.b(0xFA, 0x00, 0x40, 0xFE, 0xB1).jr(0x20, 'f5');
    putc('B'); a.jr(0x18, 't6');
    fail('f5');
    // 6. セーブ RAM
    a.label('t6');
    a.b(0x3E, 0x0A, 0xEA, 0x00, 0x00);               // RAM 許可
    a.b(0x3E, 0x5A, 0xEA, 0x34, 0xA1);               // LD ($A134),$5A
    a.b(0xAF, 0xFA, 0x34, 0xA1, 0xFE, 0x5A).jr(0x20, 'f6');
    a.b(0xAF, 0xEA, 0x00, 0x00);                     // RAM 禁止
    a.b(0xFA, 0x34, 0xA1, 0xFE, 0xFF).jr(0x20, 'f6'); // 禁止中は $FF
    putc('R'); a.jr(0x18, 't7');
    fail('f6');
  } else { putc('-'); putc('-'); }
  // 7. 音
  a.label('t7');
  a.b(0x3E, 0x80, 0xE0, 0x26, 0x3E, 0x77, 0xE0, 0x24, 0x3E, 0xFF, 0xE0, 0x25); // NR52 / NR50 / NR51
  a.b(0x3E, 0x80, 0xE0, 0x16, 0x3E, 0xF0, 0xE0, 0x17, 0x3E, 0x00, 0xE0, 0x18, 0x3E, 0x87, 0xE0, 0x19); // CH2
  putc('K');
  a.b(0xAF, 0xE0, 0xFF);                             // IE=0
  a.label('end').b(0x76, 0x00).jr(0x18, 'end');
  // putc: シリアルへ 1 バイト(内部クロック)。終わるまで SC をポーリング
  a.label('putc').b(0xE0, 0x01, 0x3E, 0x81, 0xE0, 0x02);
  a.label('pw').b(0xF0, 0x02, 0xCB, 0x7F).jr(0x20, 'pw').b(0xC9);
  rom.set(a.done(), 0x150);

  // タイマ ISR($0050): ($C000)=0 なら INC C、1 なら C←B。どちらも RETI
  rom.set([0xFA, 0x00, 0xC0, 0xB7, 0x20, 0x02, 0x0C, 0xD9, 0x48, 0xD9], 0x50); // LD A,($C000) / OR A / JR NZ,+2 / INC C / RETI / LD C,B / RETI
  rom.set([0x00, 0xC3, 0x50, 0x01], 0x100);          // NOP / JP $0150
  rom[0x104] = 0xCE; rom[0x105] = 0xED;              // ロゴの先頭 2 バイトだけ(中身判定用。ロゴ本体は入れない)
  const title = 'GBTEST';
  for (let i = 0; i < 16; i++) rom[0x134 + i] = i < title.length ? title.charCodeAt(i) : 0;
  rom[0x146] = 0; rom[0x147] = TYPE[mbc]; rom[0x148] = banked ? 1 : 0; rom[0x149] = banked ? 2 : 0;
  rom[0x14A] = 0; rom[0x14B] = 0; rom[0x14C] = 0;
  let x = 0; for (let i = 0x134; i <= 0x14C; i++) x = (x - rom[i] - 1) & 0xFF;
  rom[0x14D] = x;
  if (banked) { rom[0x4000] = 0xB1; rom[0x8000] = 0xB2; rom[0xC000] = 0xB3; } // 各バンクの印
  return rom;
}

module.exports = { buildTestRom, EXPECT_BY_MBC };

if (require.main === module) {
  const out = process.argv[2];
  const i = process.argv.indexOf('--mbc');
  const mbc = i >= 0 ? process.argv[i + 1] : 'mbc1';
  if (!out || !TYPE.hasOwnProperty(mbc)) { console.error('使い方: node mk-gb-test-rom.js out.gb [--mbc rom|mbc1|mbc3|mbc5]'); process.exit(2); }
  const rom = buildTestRom({ mbc });
  require('fs').writeFileSync(out, rom);
  console.log('wrote', out, rom.length, 'bytes, 期待するシリアル出力:', EXPECT_BY_MBC[mbc]);
}
