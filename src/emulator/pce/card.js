/*
 * HuCard の読み込みとバンクの並べ方
 * MML.Emu.PceCard(段階 9c: 普通のカード。9d: 1MB を超えるカードのバンク切り替え、RAM 内蔵カード、SuperGrafx 専用カードの見分け)
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3):
 *   [参照] Mesen 2 の Core/PCE/PceConsole.cpp / PceMemoryManager.cpp(読んだだけで写していない):
 *          大きさを 8K で割った余りが 512 なら頭の 512 バイトはコピー機のヘッダなので捨てる。2 の累乗でない大きさは次の 2 の累乗まで 0 で埋める。
 *          バンク $00-$7F(1MB)への並べ方は「埋めた後の大きさ」で決まる: 512K = 頭 256K+後ろ 256K を 3 回、ほかは頭から順に繰り返し。
 *   ★ Mesen のソースには 384K と 768K 専用の並べ方も書いてあるが、先に 2 の累乗へ埋めるので、そこには入らない(384K は 512K、768K は 1MB として並ぶ)。
 *      384K のカードは $00-$2F が中身、$30-$3F が 0、$40-$4F が後ろの 128K、という形になる。同じにしてある。
 *      実機の 384K/768K のカードの鏡像と同じかは未確認(手元の 384K の 10 本は Mesen と同じに動く)
 *   [参照] 1MB を超えるカード(PceSf2RomMapper.cpp): バンク $00 の $1FF0-$1FFF へ書くと、番地の下位 4bit が「段」になり、
 *          バンク $40-$7F に見える 512K が ROM の (段 × 512K + 512K) からの 512K に切り替わる。$00-$3F は頭の 512K のまま
 *   [参照] RAM 内蔵カード(PceMemoryManager.cpp): バンク $40-$5F に 32K の RAM(4 回の鏡像)。見分けは ROM の CRC32(1 本だけ)
 *   [参照] SuperGrafx 専用カード 5 本の CRC32(PceConsole.cpp)。ほかに拡張子 .sgx でも SuperGrafx として開く
 *   ★ CRC32 は「512 バイトのヘッダを外し、ビットの逆順を戻した後、2 の累乗に埋める前」の中身で取る。Mesen はファイルそのまま(ヘッダ込み)で取るので、
 *      ヘッダつきの吸い出しは Mesen では見分けられない(拡張子 .sgx なら通る)
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
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const SGX_ONLY = new Set([0xB486A8ED, 0x1F041166, 0x3B13AF61, 0x4C2126B0, 0x8C4588E2]); // SuperGrafx 専用の 5 本(ハッシュだけ)
  const RAM_CARD = 0x083C956A;                                                             // RAM 32K 内蔵の 1 本

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
      this.crc = crc32(rom);
      this.sgxOnly = SGX_ONLY.has(this.crc);
      this.ramSize = this.crc === RAM_CARD ? 0x8000 : 0;
      let size = BANK; while (size < rom.length) size <<= 1; // 8K に満たない物も 8K まで埋める
      if (size !== rom.length || rom.byteOffset) { const padded = new Uint8Array(size); padded.set(rom); rom = padded; }
      this.rom = rom;
      const banks = rom.length / BANK;
      this.banks = banks;
      this.layout = banks === 0x40 ? [0, 0x10, 0x20, 0x30, 0x20, 0x30, 0x20, 0x30] : [0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70];
      // バンク番号 → ROM の中の位置
      this.offset = new Int32Array(0x80);
      this.banked = banks > 0x80; // 1MB 超: バンク $40-$7F を切り替える
      this.oversize = false;      // (9c の名残。画面側が見る)
      this.select(0);
    }
    /** 1MB 超のカードの段を選ぶ(普通のカードは 0 のまま) */
    select(n) {
      this.selected = n & 0x0F;
      const banks = this.banks, L = this.layout, add = this.banked ? this.selected * 0x40 : 0;
      for (let i = 0; i < 0x80; i++) this.offset[i] = ((L[i >> 4] + (i & 0x0F) + (i >= 0x40 ? add : 0)) % banks) * BANK;
    }
  }

  Emu.PceCard = PceCard;
})(typeof window !== 'undefined' ? window : globalThis);
