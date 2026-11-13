/*
 * バーコードボーイ(通信ポートにつなぐバーコードリーダー、1992 年、対応ソフト 5 本)
 * MML.Emu.GbBarcodeBoy
 *
 * 1. ゲームが内部クロックで $10 $07 $10 $07 を送る。リーダーは $FF $FF $10 $07 を返す(後ろの 2 つが合えば「つながっている」)
 * 2. その後ゲームは外部クロックで待つ。カードを通すとリーダーの側がクロックを出して 30 バイト送る:
 *    $02、EAN-13 の 13 桁(ASCII)、$03 を 2 回
 * 3. 送り終わるとまた 1 の握手から
 *
 * exchange(b): ゲームが内部クロックで送った 1 バイトへの返事。握手に関係ないバイトは null(呼び出し側が他の機器=プリンタへ回す)
 * pull(): ゲームが外部クロックで待っている時に本体が呼ぶ。送るバイトがあればそれ、無ければ −1
 * scan(digits): 13 桁(JAN/EAN-13)を読ませる。握手が済んでいる時だけ受け付ける
 *
 * 参考: Shonumi "Dan Docs" の Barcode Boy の章。実機の送る間隔は分からないので、本体の都合の速さ(約 2ms に 1 バイト)で送る
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const HELLO = [0x10, 0x07, 0x10, 0x07], REPLY = [0xFF, 0xFF, 0x10, 0x07];

  class GbBarcodeBoy {
    constructor() { this.reset(); }
    reset() { this.pos = 0; this.armed = false; this.queue = []; }
    exchange(b) {
      if (b === HELLO[this.pos]) { const r = REPLY[this.pos]; if (++this.pos === 4) { this.pos = 0; this.armed = true; } return r; }
      if (this.pos > 0) { this.pos = b === HELLO[0] ? 1 : 0; return b === HELLO[0] ? REPLY[0] : 0xFF; }
      return this.armed ? 0xFF : null; // 握手の後、ゲームが自分のクロックで送ってきた物には $FF
    }
    pull() {
      if (!this.queue.length) return -1;
      const b = this.queue.shift();
      if (!this.queue.length) this.armed = false; // 送り終わったら握手からやり直し
      return b;
    }
    scan(digits) {
      const s = String(digits || '').replace(/\D/g, '');
      if (s.length !== 13 || !this.armed || this.queue.length) return false;
      const part = [0x02]; for (let i = 0; i < 13; i++) part.push(s.charCodeAt(i)); part.push(0x03);
      this.queue = part.concat(part);
      return true;
    }
    // EAN-13 の検査数字が合っているか(入力の確認用)
    static checkEan13(digits) {
      const s = String(digits || '').replace(/\D/g, '');
      if (s.length !== 13) return false;
      let sum = 0; for (let i = 0; i < 12; i++) sum += (s.charCodeAt(i) - 48) * (i % 2 ? 3 : 1);
      return (10 - sum % 10) % 10 === s.charCodeAt(12) - 48;
    }
  }

  Emu.GbBarcodeBoy = GbBarcodeBoy;
})(typeof window !== 'undefined' ? window : globalThis);
