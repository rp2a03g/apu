/*
 * HuC6260(VCE: 色の石)— パレット 512 色、ドットクロック、1 画面の行数
 * MML.Emu.PceVce(段階 9c)
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3):
 *   [参照] Mesen 2 の Core/PCE/PceVce.cpp(読んだだけで写していない):
 *          $0400 bit0-1 = ドットクロック(0: 5.37MHz=マスター÷4、1: 7.16MHz=÷3、2/3: 10.74MHz=÷2)、bit2 = 263 行、bit7 = 白黒。
 *          $0402/$0403 = パレットの番地(9bit)。$0404 = 下位 8bit、$0405 = 上位 1bit(書く/読むと番地が 1 進む)。
 *          読み: $0404 は下位、$0405 は bit0 だけ本物でほかは 1。それ以外は $FF
 *   [推定] 電源投入時のパレットの中身は 0(実機は不定。Mesen は設定しだいで乱数にもできる)
 * 色の値(9bit: 緑 3bit・赤 3bit・青 3bit)→ 画面の色は pceConsole.js が決める。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class PceVce {
    constructor() { this.pal = new Uint16Array(0x200); this.reset(); }
    reset() {
      this.pal.fill(0);
      this.palAddr = 0;
      this.divider = 4;      // マスタークロック何個で 1 ドットか
      this.lines = 262;
      this.grayscale = false;
      this.ctrl = 0;
    }
    read(port) {
      switch (port & 7) {
        case 4: return this.pal[this.palAddr] & 0xFF;
        case 5: { const v = (this.pal[this.palAddr] >> 8) & 1; this.palAddr = (this.palAddr + 1) & 0x1FF; return 0xFE | v; }
        default: return 0xFF;
      }
    }
    write(port, value) {
      switch (port & 7) {
        case 0:
          this.ctrl = value;
          this.lines = (value & 0x04) ? 263 : 262;
          this.grayscale = (value & 0x80) !== 0;
          this.divider = (value & 3) === 0 ? 4 : (value & 3) === 1 ? 3 : 2;
          break;
        case 2: this.palAddr = (this.palAddr & 0x100) | value; break;
        case 3: this.palAddr = (this.palAddr & 0xFF) | ((value & 1) << 8); break;
        case 4: this.pal[this.palAddr] = (this.pal[this.palAddr] & 0x100) | value; break;
        case 5: this.pal[this.palAddr] = (this.pal[this.palAddr] & 0xFF) | ((value & 1) << 8); this.palAddr = (this.palAddr + 1) & 0x1FF; break;
        default: break;
      }
    }
  }

  Emu.PceVce = PceVce;
})(typeof window !== 'undefined' ? window : globalThis);
