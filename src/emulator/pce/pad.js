/*
 * PC エンジンのパッド端子($1000)— 2 ボタンパッド、6 ボタンパッド、マルチタップ(2 ボタン × 5)
 * MML.Emu.PceInput(段階 9d)
 *
 * 端子は出力 2 本(bit0 = SEL、bit1 = CLR)と入力 4 本。ソフトは SEL/CLR を上げ下げして 4bit ずつ読む。
 * ボタンのビット(本体の setController と同じ): 0 I、1 II、2 SELECT、3 RUN、4 上、5 下、6 左、7 右、8 III、9 IV、10 V、11 VI
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。全部 [参照] Mesen 2 の Core/PCE/Input/(読んで動きを合わせた。写していない):
 *   2 ボタン(PceController.h): CLR=1 の間は 0 が読める。SEL=1 なら 上/右/下/左、SEL=0 なら I/II/SELECT/RUN(押すと 0)。
 *     上+下、左+右を同時に押したら、どちらも押していない扱い
 *   6 ボタン(PceAvenuePad6.h): CLR が 0→1 になるたびに「追加ボタンの番」と「普通の番」が入れ替わる。CLR=1 の間は $F が読める。
 *     追加ボタンの番: SEL=1 なら 0(6 ボタンの印)、SEL=0 なら III/IV/V/VI。普通の番は 2 ボタンと同じ並び(同時押しの打ち消しは無い)
 *   マルチタップ(PceTurboTap.cpp): 何番を読むかの数え。CLR=0 のまま SEL が 0→1 で次の番へ、SEL=1 のまま CLR が 0→1 で 1 番へ戻る。
 *     電源投入直後は「どれでもない」(5 番を越えた位置。$F が読める)。選ばれていないパッドには SEL=1・CLR=1 が見える
 *   マウスは Mesen に無いので作っていない(未着手)
 * 確かめ方: 合成 ROM(mk-pce-test-rom.js の 'pad')で、何も押していない時の読みの並びを Mesen と比べる(Mesen の自動実行は入力が入らない)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const TYPES = ['pad2', 'pad6', 'tap'];

  // 2 ボタン 1 個ぶんの読み。p = ボタンのビット
  function read2(p, sel, clr) {
    if (clr) return 0;
    if ((p & 0x30) === 0x30) p &= ~0x30;
    if ((p & 0xC0) === 0xC0) p &= ~0xC0;
    let v = 0x0F;
    if (sel) v &= ~(((p >> 4) & 1) | (((p >> 7) & 1) << 1) | (((p >> 5) & 1) << 2) | (((p >> 6) & 1) << 3)); // 上 右 下 左
    else v &= ~(p & 0x0F);                                                                                   // I II SELECT RUN
    return v & 0x0F;
  }

  class PceInput {
    constructor(type) {
      this.type = TYPES.includes(type) ? type : 'pad2';
      this.buttons = [0, 0, 0, 0, 0]; // 端子 1〜5(マルチタップでなければ [0] だけ使う)
      this.reset();
    }
    reset() {
      this.sel = false; this.clr = false;   // 本体が出している線
      this.extra = false;                   // 6 ボタン: 追加ボタンの番か
      this.tapPort = 5;                     // マルチタップ: 選ばれている番(5 = どれでもない)
      this.tapSel = [true, true, true, true, true]; this.tapClr = [true, true, true, true, true]; // 各パッドに見えている線
      this.prev = 0;
    }
    write(value) {
      const sel = (value & 1) !== 0, clr = (value & 2) !== 0;
      if (this.type === 'pad6') {
        if (clr && !this.clr) this.extra = !this.extra;
      } else if (this.type === 'tap') {
        const prevSel = (this.prev & 1) !== 0, prevClr = (this.prev & 2) !== 0;
        if (!clr && !prevSel && sel && this.tapPort < 5) this.tapPort++;
        if (sel && !prevClr && clr) this.tapPort = 0;
        this.prev = value;
        for (let i = 0; i < 5; i++) { const on = i === this.tapPort; this.tapSel[i] = on ? sel : true; this.tapClr[i] = on ? clr : true; }
      }
      this.sel = sel; this.clr = clr;
    }
    /** 入力 4 本(下位 4bit) */
    read() {
      if (this.type === 'pad6') {
        if (this.clr) return 0x0F;
        const p = this.buttons[0];
        if (this.extra) return this.sel ? 0 : (0x0F & ~((p >> 8) & 0x0F));
        let v = 0x0F;
        if (this.sel) v &= ~(((p >> 4) & 1) | (((p >> 7) & 1) << 1) | (((p >> 5) & 1) << 2) | (((p >> 6) & 1) << 3));
        else v &= ~(p & 0x0F);
        return v & 0x0F;
      }
      if (this.type === 'tap') {
        const n = this.tapPort;
        return n < 5 ? read2(this.buttons[n], this.tapSel[n], this.tapClr[n]) : 0x0F;
      }
      return read2(this.buttons[0], this.sel, this.clr);
    }
  }

  PceInput.TYPES = TYPES;
  Emu.PceInput = PceInput;
})(typeof window !== 'undefined' ? window : globalThis);
