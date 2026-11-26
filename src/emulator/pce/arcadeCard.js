/*
 * アーケードカード(RAM 2MB+番地を自動で進める口 4 個+32bit のシフト/回転レジスタ)
 * MML.Emu.PceArcadeCard(段階 9f)
 *
 * 見え方:
 *   バンク $40-$43 のどこを読み書きしても、口 0-3 のデータの読み書きになる(番地は見ない)。
 *   I/O $1A00-$1A7F: 口のレジスタ。bit4-5 = 口の番号、下位 4bit = レジスタ($1A40-$1A7F は $1A00-$1A3F の鏡像)
 *     $0/$1 データ   $2-$4 基準番地(24bit)   $5/$6 オフセット(16bit)   $7/$8 増分(16bit)   $9 制御   $A 書くと「オフセットを基準に足す」(制御しだい)
 *     制御: bit0 読み書きのたびに進める、bit1 番地にオフセットを足す、bit3 オフセットを負の向きに扱う、bit4 進める先(1 = 基準、0 = オフセット)、
 *           bit5-6 「オフセットを基準に足す」きっかけ(1 = オフセット下位を書いた時、2 = 上位を書いた時、3 = $A を書いた時)
 *   I/O $1AE0-$1AE3: 32bit の値、$1AE4: シフト(書くと値を動かす)、$1AE5: 回転、$1AFE/$1AFF: 版と印($10 $51)
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/PCE/CdRom/PceArcadeCard.cpp(読んだだけで写していない):
 *   [参照] 番地 = 基準(+オフセット、bit1 の時)の下位 21bit。進めるのは番地を決めた後
 *   [参照] シフト: 値の bit3 が 0 なら左へ(下位 3bit)個、1 なら右へ(下位 3bit を反転して +1)個。0 を書いた時は動かさない
 *   ★ 「負の向き」(bit3)は、オフセットの符号を見ずにいつも $FF0000 を足す(Mesen の作り。オフセットが $8000 未満の時は実機と違うかもしれない)
 *   ★ 制御の bit2(増分を負に扱う)は Mesen では使われていない。同じにしてある
 *   ★ 回転($1AE5)は Mesen のソースに「未検証」とある。回す数が 0 になる値(下位 3bit が 0 で bit3 も 0)は C++ では結果が決まらない書き方なので、
 *      ここでは「動かさない」にした(照合では使っていない)
 *   [参照] $1A00-$1BFF のうち上に無い番地の読みは、CD 装置の側の値($FF)。口のレジスタ $B-$F の読みは $FF
 *   [推定] RAM は 0 で始める
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const RAM_SIZE = 0x200000;

  class PceArcadeCard {
    constructor() {
      this.ram = new Uint8Array(RAM_SIZE);
      this.top = 0;                       // 書いた番地の最大+1(ステートに入れる範囲を決める)
      this.base = new Uint32Array(4);     // 24bit
      this.offset = new Uint16Array(4);
      this.inc = new Uint16Array(4);
      this.control = new Uint8Array(4);
      this.value = 0;                     // 32bit(符号なしで持つ)
      this.shiftReg = 0; this.rotateReg = 0;
    }

    _addr(p) {
      const c = this.control[p];
      let a = this.base[p];
      if (c & 0x02) { a += this.offset[p]; if (c & 0x08) a += 0xFF0000; }
      return a & 0x1FFFFF;
    }
    _step(p) {
      const c = this.control[p];
      if (!(c & 0x01)) return;
      if (c & 0x10) this.base[p] = (this.base[p] + this.inc[p]) & 0xFFFFFF;
      else this.offset[p] = (this.offset[p] + this.inc[p]) & 0xFFFF;
    }
    _offsetToBase(p) {
      let a = this.base[p] + this.offset[p];
      if (this.control[p] & 0x08) a += 0xFF0000;
      this.base[p] = a & 0xFFFFFF;
    }

    /** 口 p のデータを読む(バンク $40-$43、$1Ap0/$1Ap1) */
    readData(p) { const a = this._addr(p); this._step(p); return this.ram[a]; }
    writeData(p, v) { const a = this._addr(p); this._step(p); this.ram[a] = v & 0xFF; if (a >= this.top) this.top = a + 1; }

    /** I/O $1A00-$1BFF の読み。other は CD 装置の側が返した値(ここに無い番地はそれを返す) */
    readIo(off, other) {
      if (off <= 0x1A7F) {
        const p = (off >> 4) & 3;
        switch (off & 0x0F) {
          case 0x00: case 0x01: return this.readData(p);
          case 0x02: return this.base[p] & 0xFF;
          case 0x03: return (this.base[p] >> 8) & 0xFF;
          case 0x04: return (this.base[p] >> 16) & 0xFF;
          case 0x05: return this.offset[p] & 0xFF;
          case 0x06: return this.offset[p] >> 8;
          case 0x07: return this.inc[p] & 0xFF;
          case 0x08: return this.inc[p] >> 8;
          case 0x09: return this.control[p];
          case 0x0A: return 0;
          default: return 0xFF;
        }
      }
      switch (off) {
        case 0x1AE0: return this.value & 0xFF;
        case 0x1AE1: return (this.value >>> 8) & 0xFF;
        case 0x1AE2: return (this.value >>> 16) & 0xFF;
        case 0x1AE3: return (this.value >>> 24) & 0xFF;
        case 0x1AE4: return this.shiftReg;
        case 0x1AE5: return this.rotateReg;
        case 0x1AFE: return 0x10;
        case 0x1AFF: return 0x51;
        default: return other;
      }
    }

    writeIo(off, v) {
      v &= 0xFF;
      if (off <= 0x1A7F) {
        const p = (off >> 4) & 3;
        switch (off & 0x0F) {
          case 0x00: case 0x01: this.writeData(p, v); break;
          case 0x02: this.base[p] = (this.base[p] & 0xFFFF00) | v; break;
          case 0x03: this.base[p] = (this.base[p] & 0xFF00FF) | (v << 8); break;
          case 0x04: this.base[p] = (this.base[p] & 0x00FFFF) | (v << 16); break;
          case 0x05: this.offset[p] = (this.offset[p] & 0xFF00) | v; if (((this.control[p] >> 5) & 3) === 1) this._offsetToBase(p); break;
          case 0x06: this.offset[p] = (this.offset[p] & 0x00FF) | (v << 8); if (((this.control[p] >> 5) & 3) === 2) this._offsetToBase(p); break;
          case 0x07: this.inc[p] = (this.inc[p] & 0xFF00) | v; break;
          case 0x08: this.inc[p] = (this.inc[p] & 0x00FF) | (v << 8); break;
          case 0x09: this.control[p] = v & 0x7F; break;
          case 0x0A: if (((this.control[p] >> 5) & 3) === 3) this._offsetToBase(p); break;
          default: break;
        }
        return;
      }
      switch (off) {
        case 0x1AE0: this.value = ((this.value & 0xFFFFFF00) | v) >>> 0; break;
        case 0x1AE1: this.value = ((this.value & 0xFFFF00FF) | (v << 8)) >>> 0; break;
        case 0x1AE2: this.value = ((this.value & 0xFF00FFFF) | (v << 16)) >>> 0; break;
        case 0x1AE3: this.value = ((this.value & 0x00FFFFFF) | (v << 24)) >>> 0; break;
        case 0x1AE4:
          this.shiftReg = v;
          if (v) this.value = (v & 0x08) ? this.value >>> ((~v & 7) + 1) : (this.value << (v & 7)) >>> 0;
          break;
        case 0x1AE5:
          this.rotateReg = v;
          if (v) {
            const n = (v & 0x08) ? (~v & 7) + 1 : (v & 7);
            if (n > 0 && n < 32) this.value = ((v & 0x08) ? (this.value >>> n) | (this.value << (32 - n)) : (this.value << n) | (this.value >>> (32 - n))) >>> 0;
          }
          break;
        default: break;
      }
    }
  }

  PceArcadeCard.RAM_SIZE = RAM_SIZE;
  Emu.PceArcadeCard = PceArcadeCard;
})(typeof window !== 'undefined' ? window : globalThis);
