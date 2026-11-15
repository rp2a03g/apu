/*
 * HuCard の読み込みとバンクの並べ方
 * MML.Emu.PceCard(段階 9c: 普通のカードだけ。1MB を超える拡張マッパー、RAM 内蔵カードは 9d)
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3):
 *   [参照] Mesen 2 の Core/PCE/PceConsole.cpp / PceMemoryManager.cpp(読んだだけで写していない):
 *          大きさを 8K で割った余りが 512 なら頭の 512 バイトはコピー機のヘッダなので捨てる。2 の累乗でない大きさは次の 2 の累乗まで 0 で埋める。
 *          バンク $00-$7F(1MB)への並べ方は「埋めた後の大きさ」で決まる: 512K = 頭 256K+後ろ 256K を 3 回、ほかは頭から順に繰り返し。
 *   ★ Mesen のソースには 384K と 768K 専用の並べ方も書いてあるが、先に 2 の累乗へ埋めるので、そこには入らない(384K は 512K、768K は 1MB として並ぶ)。
 *      384K のカードは $00-$2F が中身、$30-$3F が 0、$40-$4F が後ろの 128K、という形になる。同じにしてある。
 *      実機の 384K/768K のカードの鏡像と同じかは未確認(手元の 384K の 10 本は Mesen と同じに動く)
 *   [推定] ビットが逆順の吸い出し: 北米版(TurboGrafx-16)のカードはデータ線の並びが国内版と逆で、吸い出しによっては各バイトのビットが
 *          逆順のまま入っている。見分け方: 電源投入時は MPR7 = 0 なので、リセットベクタ(頭の 8K の $1FFE/$1FFF)は必ず $E000 以上を指す。
 *          上位バイトが $E0 未満で、ビットを逆にすると $E0 以上になる物だけ、全バイトを逆にする。
 *          ★ Mesen 2 はこの戻しをしない(そのまま読んで動かない)。手元の 54 本では 1 本が該当(照合の時は戻した後の物を Mesen へ渡す)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const BANK = 0x2000;

  class PceCard {
    constructor(bytes) {
      let rom = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.hadHeader = (rom.length % BANK) === 512;
      if (this.hadHeader) rom = rom.subarray(512);
      this.fileSize = rom.length;
      this.reversed = false;
      if (rom.length >= BANK) {
        const rev = (b) => { let r = 0; for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i; return r; };
        if (rom[0x1FFF] < 0xE0 && rev(rom[0x1FFF]) >= 0xE0) {
          const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[i] = rev(i);
          const fixed = new Uint8Array(rom.length); for (let i = 0; i < rom.length; i++) fixed[i] = t[rom[i]];
          rom = fixed; this.reversed = true;
        }
      }
      let size = 1; while (size < rom.length) size <<= 1;
      if (size !== rom.length || rom.byteOffset) { const padded = new Uint8Array(Math.max(size, BANK)); padded.set(rom); rom = padded; }
      this.rom = rom;
      const banks = rom.length / BANK;
      this.banks = banks;
      const layout = banks === 0x40 ? [0, 0x10, 0x20, 0x30, 0x20, 0x30, 0x20, 0x30] : [0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70];
      // バンク番号 → ROM の中の位置
      this.offset = new Int32Array(0x80);
      for (let i = 0; i < 0x80; i++) this.offset[i] = ((layout[i >> 4] + (i & 0x0F)) % banks) * BANK;
      this.oversize = banks > 0x80; // 1MB 超(拡張マッパー)。9d で対応
    }
  }

  Emu.PceCard = PceCard;
})(typeof window !== 'undefined' ? window : globalThis);
