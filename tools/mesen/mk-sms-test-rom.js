// SMS / GG 用の最小テスト ROM(Z80 手組み)。vgm-recorder.lua の headless テスト用。
// PSG ポート $7F に音程/音量を書いて短い旋律(c d e f g f e d、五度下、周期ノイズ)を繰り返す。
// GG 版(出力名が .gg)はポート $06(ステレオ)も書く。
//   node tools/mesen/mk-sms-test-rom.js out.sms
//   node tools/mesen/mk-sms-test-rom.js out.gg
'use strict';
const fs = require('fs');
const out = process.argv[2] || 'test.sms';
const isGg = /\.gg$/i.test(out);
const rom = new Uint8Array(0x8000);
let p = 0;
const b = (...xs) => { for (const x of xs) rom[p++] = x & 0xFF; };
const SN = 3579545;
const toneOf = (hz) => Math.round(SN / (32 * hz));
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// プログラム
b(0xF3);             // di
b(0xED, 0x56);       // im 1
b(0x31, 0xF0, 0xDF); // ld sp,$DFF0
const start = p;
b(0x21, 0, 0);       // ld hl,table (後で埋める)
const tableRef = p - 2;
const loop = p;
b(0x7E);             // ld a,(hl)
b(0x23);             // inc hl
b(0xFE, 0x7F);       // cp $7F  → 先頭へ
b(0x28, 0); const jStart = p - 1;
b(0xFE, 0x7E);       // cp $7E  → 待ち
b(0x28, 0); const jDelay = p - 1;
b(0xFE, 0x7D);       // cp $7D  → GG ステレオ
b(0x28, 0); const jGg = p - 1;
b(0xD3, 0x7F);       // out ($7F),a
b(0x18, 0); const jLoop1 = p - 1;
// delay: b = (hl)++ ; b 回 ×(約 1 フレーム)
const delay = p;
b(0x46);             // ld b,(hl)
b(0x23);             // inc hl
const outer = p;
b(0x11, 0x00, 0x0A); // ld de,$0A00
const inner = p;
b(0x1B);             // dec de
b(0x7A);             // ld a,d
b(0xB3);             // or e
b(0x20, 0); rom[p - 1] = (inner - p) & 0xFF; // jr nz,inner
b(0x10, 0); rom[p - 1] = (outer - p) & 0xFF; // djnz outer
b(0x18, 0); const jLoop2 = p - 1;
// gg: a = (hl)++ ; out ($06),a
const gg = p;
b(0x7E); b(0x23); b(0xD3, 0x06);
b(0x18, 0); const jLoop3 = p - 1;
rom[jStart] = (start - (jStart + 1)) & 0xFF;
rom[jDelay] = (delay - (jDelay + 1)) & 0xFF;
rom[jGg] = (gg - (jGg + 1)) & 0xFF;
rom[jLoop1] = (loop - (jLoop1 + 1)) & 0xFF;
rom[jLoop2] = (loop - (jLoop2 + 1)) & 0xFF;
rom[jLoop3] = (loop - (jLoop3 + 1)) & 0xFF;
// 割り込みベクタ $38 を避けて表を $0100 に
p = 0x38; b(0xED, 0x4D); // reti
p = 0x100;
rom[tableRef] = 0x00; rom[tableRef + 1] = 0x01;
const tone = (ch, n) => { const t = toneOf(midi(n)); b(0x80 | (ch << 5) | (t & 0xF), (t >> 4) & 0x3F); };
const vol = (ch, v) => b(0x90 | (ch << 5) | (15 - v));
const wait = (frames) => b(0x7E, frames);
if (isGg) b(0x7D, 0xFF);
// ch0 旋律、ch1 五度下、ch3 ノイズ(周期ノイズ, ch2 のトーンで周波数)
const mel = [72, 74, 76, 77, 79, 77, 76, 74];
vol(0, 12); vol(1, 8); vol(2, 0); vol(3, 0);
for (let i = 0; i < mel.length; i++) {
  tone(0, mel[i]); tone(1, mel[i] - 7);
  if (i % 2 === 0) { b(0xE0 | 0x04 | 0x00); vol(3, 10); } else { vol(3, 0); }
  if (isGg) b(0x7D, i % 2 === 0 ? 0xF2 : 0x2F); // ステレオを左右に振る
  wait(8);
  vol(3, 0);
  wait(4);
}
b(0x7F);
// SEGA ヘッダ
const hdr = 'TMR SEGA';
for (let i = 0; i < 8; i++) rom[0x7FF0 + i] = hdr.charCodeAt(i);
rom[0x7FFF] = isGg ? 0x7C : 0x4C; // 地域/サイズ(GG international / SMS export, 32KB)
fs.writeFileSync(out, rom);
console.log('wrote', out, isGg ? '(GG)' : '(SMS)');
