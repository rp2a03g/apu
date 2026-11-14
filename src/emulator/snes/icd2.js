/*
 * スーパーゲームボーイのカートリッジ(段階 8g-4): ICD2 チップ+ゲームボーイ本体
 * MML.Emu.SgbIcd2
 *
 * SNES 側からは $6000-$7FFF に見える(SnesConsole の ext に挿す)。中にゲームボーイ(gb/gbConsole.js)が丸ごと入っていて、
 * SNES のマスタークロックを分周した時計で動く(初代: 21.477MHz÷5 = 4.295MHz。実機のゲームボーイより約 2.4% 速い)。
 *   $6000 R : 今 LCD が描いている行(上位 5bit = 8 行単位の段)と、書き込み中のバッファ番号(下位 2bit)
 *   $6001 W : 読み出すバッファ番号(読み出し位置を 0 に戻す)
 *   $6002 R : ゲームボーイからのコマンド(16 バイト)が届いているか。読むと 1 つ取り出して $7000-$700F に置く
 *   $6003 W : bit7 = 0 でゲームボーイをリセット、1 で動かす / bit5-4 = パッドの人数(0=1 人、1=2 人、3=4 人) / bit1-0 = 時計の分周(÷4 ÷5 ÷7 ÷9)
 *   $6004-7 W: パッド 1〜4(0 = 押している。bit7-4 = START SELECT B A、bit3-0 = ↓ ↑ ← →)
 *   $600F R : チップの版
 *   $7000-F R: コマンド 16 バイト
 *   $7800 R : 選んだバッファの絵(20 タイル × 16 バイト = 320 バイト、ゲームボーイのタイル形式)。続けて読むと進む
 * ゲームボーイ側は P1($FF00)の P14/P15 の上げ下げでコマンドを 1 ビットずつ送る(両方 L = 開始、P14 だけ L = 0、P15 だけ L = 1)。
 * LCD の出力(4 階調の番号)は 8 行ぶんずつ 4 本のバッファに順に溜まり、BIOS がそれを読んで SNES の画面に描く。
 *
 * ブート ROM(256 バイト)があればそれを実行する(カートリッジのヘッダを 6 個のコマンドで SNES へ送るのがその仕事)。
 * 無ければ同じ 6 個のコマンドをここで作って届け、ゲームボーイは起動後の状態から始める。
 *
 * 出どころ: fullsnes(nocash)の SGB の章。パッド番号の進み方とコマンド受信の状態機械は bsnes の ICD を覚えている範囲で再現した物(推定を含む)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DIVIDER = [4, 5, 7, 9];

  class SgbIcd2 {
    // opts: { bootRom: Uint8Array(256) | null, revision: 1 | 2, gbOpts: GbConsole へ渡す追加の指定 }
    constructor(gbRom, opts) {
      opts = opts || {};
      this.revision = opts.revision || 1;
      this.gb = new Emu.GbConsole(gbRom, Object.assign({ model: 'dmg', sgb: this, bootRom: opts.bootRom || null }, opts.gbOpts || {}));
      this.hasBoot = !!opts.bootRom;
      this.baseHz = 21477272; this.clkScale = 1; // SGB2 は専用の水晶(20.97152MHz)。SgbConsole が入れる
      this.onClock = null;                       // (clk) SNES のマスタークロックが進んだ(音の標本化に使う)
      this.rows = new Uint8Array(4 * 8 * 160); // バッファ 4 本 × 8 行 × 160 画素(階調番号 0-3)
      this.packet = new Uint8Array(16);         // $7000-$700F
      this.reset();
    }
    reset() {
      this.r6003 = 0; this.running = false; this.div = DIVIDER[1]; this.mltReq = 0;
      this.pads = [0xFF, 0xFF, 0xFF, 0xFF];
      this.joypId = 0; this.joypLock = false;
      this.queue = [];                 // 届いたコマンド(16 バイトずつ)
      this.pulseLock = true; this.strobeLock = false; this.packetLock = false;
      this.bitData = 0; this.bitOffset = 0; this.packetOffset = 0; this.joypPacket = new Uint8Array(16);
      this.v = 0; this.writeBank = 0; this.readBank = 0; this.readAddr = 0;
      this.rows.fill(0); this.packet.fill(0);
      this.acc = 0; this.idleAcc = 0;
      this._applyClock();
    }
    // ゲームボーイの時計(Hz)= 元の時計 ÷ 分周。音の標本化が使う
    _applyClock() { this.gb.clockHz = this.baseHz / this.div; }

    // ── SNES 側 ──
    read(a) {
      a &= 0xFFFF;
      if (a === 0x6000) { this._follow(this.gb.ppu.line); return (this.v & 0xF8) | this.writeBank; }
      if (a === 0x6002) {
        if (!this.queue.length) return 0;
        this.packet.set(this.queue.shift());
        return 1;
      }
      if (a === 0x600F) return 0x21;
      if ((a & 0xFFF0) === 0x7000) return this.packet[a & 15];
      if (a === 0x7800) {
        const p = this.readAddr; this.readAddr = (p + 1) & 511;
        if (p >= 320) return 0xFF;
        // タイル t の y 行目、ビットプレーン pl(左端の画素が bit7)
        const t = p >> 4, y = (p >> 1) & 7, pl = p & 1, base = this.readBank * 1280 + y * 160 + t * 8, rows = this.rows;
        let b = 0;
        for (let i = 0; i < 8; i++) b = (b << 1) | ((rows[base + i] >> pl) & 1);
        return b;
      }
      return 0;
    }
    write(a, v) {
      a &= 0xFFFF;
      if (a === 0x6001) { this.readBank = v & 3; this.readAddr = 0; return; }
      if (a === 0x6003) {
        if (!(this.r6003 & 0x80) && (v & 0x80)) this._powerGb();
        this.r6003 = v; this.running = (v & 0x80) !== 0; this.div = DIVIDER[v & 3]; this._applyClock();
        this.mltReq = (v >> 4) & 3;
        this.joypId &= this.mltReq === 2 ? 3 : this.mltReq;
        return;
      }
      if (a >= 0x6004 && a <= 0x6007) { this.pads[a - 0x6004] = v; return; }
    }
    // SNES のマスタークロックが clk 進んだ
    tick(clk) {
      if (this.onClock) this.onClock(clk);
      if (!this.running) {
        // 止められている間も、録音中なら録音の時間(ゲームボーイのフレーム内時刻)だけは進める。
        // 進めないと、その間の SNES 側の音(APU ポートへの書き込み)が全部同じ時刻に潰れる
        const gb = this.gb;
        if (gb.rec) {
          this.idleAcc += clk * this.clkScale;
          const t = Math.floor(this.idleAcc / this.div);
          if (t > 0) { this.idleAcc -= t * this.div; gb.frameT += t; if (gb.frameT >= 70224) gb._frameEnd(); }
        }
        return;
      }
      this.acc += clk * this.clkScale;
      const gb = this.gb, div = this.div, need = div * 4;
      while (this.acc >= need) {
        const before = gb.cpuCycles;
        gb.step();
        this.acc -= (gb.cpuCycles - before) * div;
      }
    }

    _powerGb() {
      this.gb.reset();
      this.joypId = 0; this.joypLock = false;
      this.pulseLock = true; this.strobeLock = false; this.packetLock = false; this.bitOffset = 0; this.packetOffset = 0;
      this.queue.length = 0;
      this.v = 0; this.acc = 0;
      this._applyClock();
      if (!this.hasBoot) { // ブート ROM の代わり: ヘッダ $0104-$0157 を 14 バイトずつ 6 個のコマンドで届ける
        const rom = this.gb.cart.rom || [];
        for (let i = 0; i < 6; i++) {
          const pk = new Uint8Array(16);
          pk[0] = 0xF1 + i * 2;
          let sum = 0;
          for (let k = 0; k < 14; k++) { const b = rom[0x104 + i * 14 + k] | 0; pk[2 + k] = b; sum += b; }
          pk[1] = sum & 0xFF;
          this.queue.push(pk);
        }
      }
    }

    // ── ゲームボーイ側 ──
    // LCD の行 y を描き終えた(idx = 画面全体の階調番号)
    lcdLine(y, idx) {
      this._follow(y);
      this.rows.set(idx.subarray(y * 160, y * 160 + 160), this.writeBank * 1280 + (y & 7) * 160);
    }
    // 行カウンタを追いかける。見えている行の 8 行ごと(0 行目を含む)に書き込みバッファが次へ移る。VBlank の間は移らない
    // (VBlank でも移すと、BIOS が中身の無いバッファを最後の段として読んでしまう。実測: dmg-acid2 の最下段が化けた)
    _follow(line) {
      while (this.v !== line) {
        if (++this.v >= 154) this.v = 0;
        if (this.v < 144 && (this.v & 7) === 0) this.writeBank = (this.writeBank + 1) & 3;
      }
    }
    // P1 の下位 4bit。両方 H の時はパッド番号($F − 番号)が読める
    p1Low(p1) {
      const p14 = (p1 >> 4) & 1, p15 = (p1 >> 5) & 1, pad = this.pads[this.joypId];
      let low = 0x0F;
      if (p14 && p15) low = 0x0F - this.joypId;
      if (!p14) low &= pad & 0x0F;
      if (!p15) low &= (pad >> 4) & 0x0F;
      return low & 0x0F;
    }
    // P1 への書き込み(p14/p15 = 書いた値の bit4/bit5)
    joypWrite(p14, p15) {
      // パッド番号: 両方 H に戻るたびに次の人へ(人数は $6003)
      if (p14 && p15) {
        if (!this.joypLock) {
          this.joypLock = true;
          this.joypId = (this.joypId + 1) & (this.mltReq === 2 ? 3 : this.mltReq);
        }
      }
      if (p14 && !p15) this.joypLock = false;

      // コマンドの受信
      if (!p14 && !p15) { this.pulseLock = false; this.packetOffset = 0; this.bitOffset = 0; this.strobeLock = true; this.packetLock = false; return; }
      if (this.pulseLock) return;
      if (p14 && p15) { this.strobeLock = false; return; }
      if (this.strobeLock) return; // 前のビットから H に戻っていない
      this.strobeLock = true;
      const bit = p15 ? 0 : 1; // P14 だけ L = 0、P15 だけ L = 1
      if (this.packetLock) { // 16 バイト受け終えた後の止めのビット(0)
        if (!bit) { if (this.queue.length < 64) this.queue.push(this.joypPacket.slice()); }
        this.packetLock = false; this.pulseLock = true;
        return;
      }
      this.bitData = (bit << 7) | (this.bitData >> 1);
      if (++this.bitOffset < 8) return;
      this.bitOffset = 0;
      this.joypPacket[this.packetOffset] = this.bitData;
      if (++this.packetOffset < 16) return;
      this.packetOffset = 0;
      this.packetLock = true;
    }
  }

  Emu.SgbIcd2 = SgbIcd2;
})(typeof window !== 'undefined' ? window : globalThis);
