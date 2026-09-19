/*
 * コナミ「牌の魔術師」カートリッジ内蔵の 8bit D/A
 * MML.Emu.MajutsushiDAC
 *
 * メモリ 0x5000-0x5FFF への書込み値(符号なし8bit、0x80=中点)がそのまま出力電圧になる。
 * ゲームは PLAY の中で DI したまま 4bit 差分符号を展開し、DJNZ の空ループで間隔を取りながら
 * LD (5000h),A を連打してしゃべる(割込みは使わない)。
 *
 * 資料(KSS の D/A はこの3つしか見当たらない):
 *   - libkss kssxspec.md: device flag の bit3-4 = 2 が "Majutushi D/A"。iomap.md: 5000-5FFFH 8bit D/A port
 *   - libkss vm.c memwrite: DA8 >>= 1; DA8 += (d - 0x80) << 3 を SCC の出力に足す
 *     (定常値 16×(d-0x80) ≒ SCC 1ch の最大 15×127 と同程度)
 *   - openMSX RomMajutsushi.cc: Konami マッパー+DAC、0x5000-0x5FFF の書込みは DAC へ(ROM には書かない)。
 *     DACSound8U は value-0x80 をそのまま出す(零次ホールド)
 * 出力は openMSX と同じ零次ホールド。libkss の「書込みごとに半分へ減衰」は書込み間隔で特性が
 * 変わる近似なので真似しない。振幅は libkss の比率(SCC 1ch 最大と同程度)を sccAudio.js の
 * スケール(1ch 最大 ≒ 0.186)へ写して 0.2/128 とした。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const GAIN = 0.2 / 128;

  class MajutsushiDAC {
    constructor() {
      this.value = 0x80;
      this.mute = [false];
      this.vol = [1];
      this.writes = 0;  // 書込み回数(鍵盤表示の「鳴っているか」判定用。snapshotMajutsushiDac 参照)
      this.peak = 0;    // 前回スナップショット以降の最大振幅 |value-0x80|
      this._snapWrites = 0;
    }
    reset() { this.value = 0x80; this.writes = 0; this.peak = 0; this._snapWrites = 0; }
    write(value) {
      this.value = value & 0xFF;
      this.writes++;
      const a = Math.abs(this.value - 0x80);
      if (a > this.peak) this.peak = a;
    }
    clock() {}
    mixSample() {
      if (this.mute[0]) return 0;
      return (this.value - 0x80) * GAIN * this.vol[0];
    }
  }

  // DAC の書込みアドレスか(KssBus と再生側の振り分けで共用)
  MajutsushiDAC.isDacAddr = (addr) => addr >= 0x5000 && addr <= 0x5FFF;

  // 鍵盤表示用スナップショット(KDA行)。★呼ぶたびに「前回からの書込み有無」と最大振幅を消費する
  // (鍵盤の描画ループから1フレーム1回だけ呼ぶ前提)。D/A は最後に書いた値を保持し続けるので、
  // 値そのものでは鳴り終わりが分からない。書込みが続いている間だけ active にする
  Emu.snapshotMajutsushiDac = function (chip) {
    const active = chip.writes !== chip._snapWrites;
    chip._snapWrites = chip.writes;
    const peak = chip.peak;
    chip.peak = 0;
    return { level: chip.value, vol: active ? Math.min(1, peak / 128) : 0, active };
  };

  Emu.MajutsushiDAC = MajutsushiDAC;
})(window);
