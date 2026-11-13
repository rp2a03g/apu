/*
 * ポケットプリンタ(通信ポートにつなぐ感熱プリンタ)
 * MML.Emu.GbPrinter
 *
 * 本体(gbConsole.js)の serialDevice として使う: exchange(GB が送ったバイト) → プリンタが返すバイト。
 * パケット: $88 $33 命令 圧縮 長さ(下位, 上位) データ… チェックサム(下位, 上位)、続く 2 バイトの間にプリンタが $81 と状態を返す。
 *   命令 1 = 初期化、2 = 印刷(枚数、余白[上位=前/下位=後]、パレット、濃さ)、4 = 画像データ(2bpp のタイル、横 20 タイル。
 *   1 パケット最大 $280 バイト = 2 段)、$F = 状態の問い合わせ
 *   圧縮(フラグ 1): 制御バイトの bit7 が 1 なら次の 1 バイトを (下位 7bit+2) 回、0 なら続く (値+1) バイトをそのまま
 * 印刷: 溜まったタイルをパレットで階調(0=白〜3=黒)にして 1 枚の帯にする。後ろの余白が 0 の印刷は次の印刷とつながる(長い絵)ので、
 *   余白ありの印刷が来た所で 1 枚として確定し、onPrint({ width: 160, height, pixels: Uint8Array(階調) }) に渡す。
 * 状態: データあり $08 → 印刷命令の直後 $06(印刷中)→ 何度か問い合わせると $04(完了)。初期化で 0 に戻る。
 *
 * 参考: Pan Docs "Game Boy Printer"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 160;

  class GbPrinter {
    constructor() {
      this.onPrint = null;
      this.pages = [];       // 確定した絵(onPrint が無い時に溜まる)
      this.reset();
    }
    reset() {
      this.state = 0;        // 0,1 = マジック、2 = 命令、3 = 圧縮、4,5 = 長さ、6 = データ、7,8 = チェックサム、9 = $81 を返す、10 = 状態を返す
      this.cmd = 0; this.compress = 0; this.len = 0; this.got = 0; this.sum = 0; this.chk = 0;
      this.data = new Uint8Array(0x280);
      this.tiles = [];       // 溜まった画像データ(バイト列)
      this.strips = [];      // 印刷済みでまだ確定していない帯(階調の行列)
      this.status = 0;
      this.busy = 0;         // 印刷中として答える残り回数
    }

    // 1 バイトのやり取り
    exchange(b) {
      b &= 0xFF;
      switch (this.state) {
        case 0: this.state = b === 0x88 ? 1 : 0; return 0x00;
        case 1: this.state = b === 0x33 ? 2 : (b === 0x88 ? 1 : 0); return 0x00;
        case 2: this.cmd = b; this.sum = b; this.state = 3; return 0x00;
        case 3: this.compress = b & 1; this.sum += b; this.state = 4; return 0x00;
        case 4: this.len = b; this.sum += b; this.state = 5; return 0x00;
        case 5: this.len |= b << 8; this.sum += b; this.got = 0; this.state = this.len ? 6 : 7; if (this.len > this.data.length) this.data = new Uint8Array(this.len); return 0x00;
        case 6: this.data[this.got++] = b; this.sum += b; if (this.got >= this.len) this.state = 7; return 0x00;
        case 7: this.chk = b; this.state = 8; return 0x00;
        case 8: this.chk |= b << 8; this._run((this.sum & 0xFFFF) === this.chk); this.state = 9; return 0x00;
        case 9: this.state = 10; return 0x81;
        default: {
          this.state = 0;
          const st = this.status;
          if (this.busy > 0 && --this.busy === 0) this.status = (this.status & ~0x02) & ~0x08 | 0x04; // 印刷が終わった
          return st;
        }
      }
    }

    _run(sumOk) {
      if (!sumOk) { this.status |= 0x01; return; }
      this.status &= ~0x01;
      const d = this.data.subarray(0, this.len);
      switch (this.cmd) {
        case 0x01: this.tiles = []; this.status = 0; this.busy = 0; break;
        case 0x04:
          if (!this.len) break; // 空のデータ = 「これで全部」
          if (this.compress) {
            for (let i = 0; i < d.length;) {
              const c = d[i++];
              if (c & 0x80) { const v = d[i++]; for (let k = (c & 0x7F) + 2; k > 0; k--) this.tiles.push(v); }
              else { for (let k = c + 1; k > 0 && i < d.length; k--) this.tiles.push(d[i++]); }
            }
          } else for (let i = 0; i < d.length; i++) this.tiles.push(d[i]);
          this.status |= 0x08;
          break;
        case 0x02: {
          const margins = d.length > 1 ? d[1] : 0x13, pal = (d.length > 2 && d[2]) ? d[2] : 0xE4;
          if (d.length && d[0] === 0) { this._finish(); break; } // 0 枚 = 紙送りだけ
          this._strip(pal);
          this.tiles = [];
          this.status = (this.status | 0x02 | 0x08) & 0xFF; this.busy = 3;
          if (margins & 0x0F) this._finish(); // 後ろに余白がある = ここで 1 枚
          break;
        }
        default: break; // $0F: 状態だけ
      }
    }
    // 溜まったタイル(横 20 個ずつ)を階調の帯にする
    _strip(pal) {
      const rows = Math.floor(this.tiles.length / (20 * 16));
      if (!rows) return;
      const px = new Uint8Array(W * rows * 8), t = this.tiles;
      for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < 20; tx++) {
        const base = (ty * 20 + tx) * 16;
        for (let y = 0; y < 8; y++) {
          const lo = t[base + y * 2], hi = t[base + y * 2 + 1];
          for (let x = 0; x < 8; x++) {
            const c = (((hi >> (7 - x)) & 1) << 1) | ((lo >> (7 - x)) & 1);
            px[(ty * 8 + y) * W + tx * 8 + x] = (pal >> (c * 2)) & 3;
          }
        }
      }
      this.strips.push(px);
    }
    // 帯をつないで 1 枚にして渡す
    _finish() {
      if (!this.strips.length) return;
      const total = this.strips.reduce((n, s) => n + s.length, 0);
      const pixels = new Uint8Array(total);
      let o = 0; for (const s of this.strips) { pixels.set(s, o); o += s.length; }
      this.strips = [];
      const page = { width: W, height: total / W, pixels };
      if (this.onPrint) this.onPrint(page); else this.pages.push(page);
    }
    // つながる印刷の途中で止まっている帯があれば確定する(ゲームを閉じる時など)
    flush() { this._finish(); }
  }

  Emu.GbPrinter = GbPrinter;
})(typeof window !== 'undefined' ? window : globalThis);
