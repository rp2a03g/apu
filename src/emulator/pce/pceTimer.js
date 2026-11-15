/*
 * PC エンジンの内蔵タイマ(HuC6280 の中、I/O $0C00-$0FFF)
 * MML.Emu.PceTimer
 *
 * 7bit の下りカウンタ。マスタークロック 3072 個(=高速時の CPU 1024 サイクル)ごとに 1 減り、0 の次で再装填して割り込みを上げる。
 * CPU の速さ(CSH/CSL)には関係なく進む。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。このファイルは全部 [参照] Mesen 2 の Core/PCE/PceTimer.cpp(読んだだけで写していない):
 *   - カウンタが 0 の時に刻みが来ると「再装填+割り込み」、それ以外は 1 減るだけ → 周期は (再装填値+1)×3072 マスタークロック
 *   - $0C01 bit0 は「止まっている ↔ 動いている」が変わった時だけ、刻みとカウンタを頭に戻す(動いている最中に 1 を書き直しても何も起きない)
 *   - $0C00 への書き込みは再装填値を変えるだけ(動いているカウンタには次の再装填まで効かない)
 *   - 電源投入でカウンタは 0
 *   - 読み出し: カウンタ。ただし 0 から再装填される直前(刻みの残り 15 マスタークロック以下)は $7F が見える。
 *     ★ Mesen のコメントによれば、これに頼るゲームがあって入れた物で、正しい時間幅は未確認
 * HES 119 本の Mesen との突き合わせ(tools/headless/pce-mesen-ab.js)で動きを確かめる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PRESCALE = 1024 * 3; // マスタークロック

  class PceTimer {
    constructor() { this.reset(); }

    reset() {
      this.reload = 0;
      this.counter = 0;
      this.scaler = PRESCALE;
      this.enabled = false;
    }

    /**
     * マスタークロック n 個ぶん進める。割り込みを上げる時は true を返す。
     * 呼ぶ側は必ず n=3 で呼ぶ(低速の CPU 1 サイクルは 3 を 4 回)。刻みは 3 の倍数なので、ちょうど 0 になった所で次へ進む。
     */
    advance(n) {
      if (!this.enabled) return false;
      this.scaler -= n;
      if (this.scaler > 0) return false;
      this.scaler += PRESCALE;
      if (this.counter === 0) { this.counter = this.reload; return true; }
      this.counter--;
      return false;
    }

    write(addr, value) {
      if (addr & 1) {
        const on = (value & 1) !== 0;
        if (on !== this.enabled) { this.enabled = on; this.scaler = PRESCALE; this.counter = this.reload; }
      } else {
        this.reload = value & 0x7F;
      }
    }

    read() {
      return (this.counter === 0 && this.scaler <= 5 * 3) ? 0x7F : this.counter;
    }
  }

  Emu.PceTimer = PceTimer;
  Emu.PCE_MASTER_CLOCK = 21477270; // [参照] PceConstants.h(NTSC の色副搬送波 ×6)
})(window);
