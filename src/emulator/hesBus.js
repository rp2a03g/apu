/*
 * HES(PC Engine)実行用メモリバス + 最小限のハードウェア(MMU/タイマ/割込コントローラ/VDC)
 * MML.Emu.HesBus
 *
 * HuC6280のMMU: 8個のMPR(Memory Page Register、TAM/TMAで読み書き)が論理アドレス空間
 * $0000-$FFFF を8KB単位8ページに分割し、各ページに物理バンク番号(0-255、1バンク=8KB、
 * 256バンク=2MB)を割り当てる。物理バンク $00-$7F がDATAブロック(HESヘッダのaddr以降)、
 * $F8=ワークRAM、$F9-$FB=SuperGrafx拡張RAM、$FF=I/O空間(PSG/タイマ/割込コントローラ/VDC等)、
 * それ以外($80-$F7、$FC-$FE)は未マップ(0xFF固定)。
 *
 * ★GBS/NSF/KSSと異なり、HESヘッダにはPLAYアドレスが存在しない(INITアドレスのみ)。
 * 実機は「タイマ割込またはVDCの垂直帰線割込のハンドラ」としてPLAY相当の処理を呼ぶ設計で、
 * そのハンドラのアドレスはヘッダにもDATAブロックの固定位置にも存在せず、ゲーム本体の
 * 割込ベクタテーブル($FFF6-$FFFF、DATAブロックの一部としてROMに含まれる)経由でしか
 * わからない。そのため本ツールは(GBS等の簡略化と違い)本物のIRQディスパッチ
 * (Iフラグ・BRK/IRQ/RTI)をcpuHuC6280.js側に実装し、このバスはタイマ/VDC垂直帰線の
 * 実際のハードウェア挙動(割込要求の発生・マスク・確認)を再現する。
 *
 * 参考: Hes_Core.h/.cpp(Game_Music_Emu, kode54/Game_Music_Emu)のレジスタ挙動を実装から
 *   直接確認した上で、コードは移植せずクリーンルームで再実装(vector値$FFF6/$FFF8/$FFFAは
 *   HuC6280 CMOS Software Manual のBRK命令の記述($FFF6/$FFF7)から確認、IRQ1/TIQは
 *   cpu_done()が返す"reason code"(0x08/0x0A)が$FFF0起点のベクタ下位byteだったことから
 *   逆算して確認した)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PAGE_SIZE = 0x2000;
  const SCANLINE_PERIOD = 262 * 455; // マスタークロック単位(60.05Hz相当)、hesHeader.jsのVBLANK_FPSと同じ根拠

  const IRQ_VECTOR_IRQ2 = 0xFFF6; // BRKもここを共有(HuC6280仕様)
  const IRQ_VECTOR_IRQ1 = 0xFFF8; // VDC(垂直帰線)
  const IRQ_VECTOR_TIQ  = 0xFFFA; // 内蔵タイマ

  class HesBus {
    /**
     * @param {object} header - HES.parseHeader() の結果
     * @param {Uint8Array} rom - DATAブロックの生バイト列(header.dataOffset以降、dataSizeぶん)
     */
    constructor(header, rom) {
      this.header = header;
      this.rom = rom;
      this.romBase = header.addr;
      this.mpr = new Uint8Array(8);
      this.ram = new Uint8Array(PAGE_SIZE);       // 物理バンク$F8
      this.sgx = [new Uint8Array(PAGE_SIZE), new Uint8Array(PAGE_SIZE), new Uint8Array(PAGE_SIZE)]; // $F9-$FB
      this.apu = null;    // hesPlayer.js が構築後にセットする
      this.onWrite = null; // write-logキャプチャ用(hes2mml向け)
      this.reset();
    }

    reset() {
      for (let i = 0; i < 8; i++) this.mpr[i] = this.header.banks[i] || 0;
      this.ram.fill(0);
      for (const p of this.sgx) p.fill(0);

      this.timerReload = 0;      // $0C00 書込み値(7bit)
      this.timerCounter = 1024;  // マスタークロック単位の残りカウント
      this.timerEnabled = false;
      this.timerFired = false;

      // IRQディセーブルレジスタ($1402)。実機/HES規約とも起動直後はタイマ・VDC割込を
      // マスクした状態で始まる(ゲーム側が明示的にCLIおよびマスク解除する前提)。
      this.irqDisable = 0x06; // bit2=timer, bit1=vdp を disable

      this.vdcLatch = 0;
      this.vdcCr = 0;         // レジスタ5(CR)の下位byte。bit3=垂直帰線割込許可
      this.vblankCounter = SCANLINE_PERIOD;
      this.vblankPending = false;
    }

    setMpr(i, bank) { this.mpr[i & 7] = bank & 0xFF; }
    getMpr(i) { return this.mpr[i & 7]; }

    read(addr) {
      addr &= 0xFFFF;
      const bank = this.mpr[addr >>> 13];
      if (bank === 0xFF) return this.readIo(addr & 0x1FFF);
      if (bank === 0xF8) return this.ram[addr & 0x1FFF];
      if (bank >= 0xF9 && bank <= 0xFB) return this.sgx[bank - 0xF9][addr & 0x1FFF];
      if (bank >= 0x80) return 0xFF; // 未実装の特殊バンク
      const off = bank * PAGE_SIZE + (addr & 0x1FFF) - this.romBase;
      return (off >= 0 && off < this.rom.length) ? this.rom[off] : 0xFF;
    }

    write(addr, value) {
      addr &= 0xFFFF; value &= 0xFF;
      if (this.onWrite) this.onWrite(addr, value);
      const bank = this.mpr[addr >>> 13];
      if (bank === 0xFF) { this.writeIo(addr & 0x1FFF, value); return; }
      if (bank === 0xF8) { this.ram[addr & 0x1FFF] = value; return; }
      if (bank >= 0xF9 && bank <= 0xFB) { this.sgx[bank - 0xF9][addr & 0x1FFF] = value; return; }
      // ROM(bank<0x80)・未実装特殊バンク(bank>=0x80)への書込みは無視
    }

    readIo(off) {
      if (off >= 0x0800 && off <= 0x0809 && this.apu) return this.apu.readRegister(off);
      switch (off) {
        case 0x0000: { // VDC ステータスレジスタ: 読み出しで垂直帰線割込フラグをack
          const v = this.vblankPending ? 0x20 : 0x00;
          this.vblankPending = false;
          return v;
        }
        case 0x0C00:
          return this.timerEnabled ? Math.max(0, Math.floor((this.timerCounter - 1) / 1024)) : 0;
        case 0x1402:
          return this.irqDisable;
        case 0x1403: {
          let s = 0;
          if (this.timerFired) s |= 0x04;
          if (this.vblankPending && (this.vdcCr & 0x08)) s |= 0x02;
          return s;
        }
      }
      return 0xFF; // 未実装I/O(ジョイパッド・CD/ADPCM等)は安全側の既定値
    }

    writeIo(off, value) {
      if (off >= 0x0800 && off <= 0x0809 && this.apu) { this.apu.writeRegister(off, value); return; }
      switch (off) {
        case 0x0000: this.vdcLatch = value & 0x1F; return;
        case 0x0002: if (this.vdcLatch === 5) this.vdcCr = value; return;
        case 0x0003: return; // CR上位byte。本stubでは未使用(bit3は下位byte側)
        case 0x0C00: this.timerReload = value & 0x7F; return;
        case 0x0C01:
          this.timerEnabled = (value & 1) !== 0;
          if (this.timerEnabled) this.timerCounter = (this.timerReload + 1) * 1024;
          return;
        case 0x1402: this.irqDisable = value; return;
        case 0x1403:
          this.timerFired = false;
          if (this.timerEnabled) this.timerCounter = (this.timerReload + 1) * 1024;
          return;
      }
      // ジョイパッド($1000台)・CD/ADPCM($1800台)等は未実装、書込みは無視
    }

    // マスタークロック(hesHeader.js HES.CPU_CLOCK_HIGH)1tickごとに1回呼ぶ。
    // タイマの減算・垂直帰線周期のカウントダウンを進める(CPU速度(CSH/CSL)に関わらず
    // 一定レートで進む、実機のPSG/タイマがCPU速度と独立した固定クロックである仕様通り)。
    clock() { this.clockBy(1); }

    // clock()のnティック分バッチ版(数学的にclock()をn回呼ぶのと同値)。リアルタイム
    // 再生(hes-stream-player.js経由)では1オーディオサンプルあたり約162回もこの関数を
    // 呼ぶ必要があり(マスタークロック7.16MHz ÷ 44.1kHz)、tickごとの関数呼出しオーバー
    // ヘッドの累積がユーザー実測で「がくがく」(音声スレッドが間に合わずアンダーラン)
    // になるほど重かった。timerCounter/vblankCounterはどちらも「しきい値まで減算して
    // 折り返す」単純なカウンタなので、n減算してからしきい値超過分だけwhileで折り返す
    // ことでO(1)(ならし)にできる。hesPlayer.js renderFrame()から呼ぶ場合、命令境界
    // (cpu.step())の間だけをまとめて渡すため、IRQ判定(pollIrq、命令境界でしか
    // 見ない)の観測結果は1tickずつ呼んでいた場合と完全に同じになる。
    clockBy(n) {
      if (n <= 0) return;
      if (this.timerEnabled) {
        this.timerCounter -= n;
        while (this.timerCounter <= 0) {
          this.timerFired = true;
          this.timerCounter += (this.timerReload + 1) * 1024;
        }
      }
      this.vblankCounter -= n;
      while (this.vblankCounter <= 0) {
        this.vblankCounter += SCANLINE_PERIOD;
        this.vblankPending = true;
      }
    }

    // cpuHuC6280.js の step() が毎命令境界で呼ぶ。優先度はタイマ>VDC(Hes_Core.cpuの
    // cpu_done()チェック順と同じ)。マスク済み(irqDisableの対応bitが立っている)なら無視。
    pollIrq() {
      if (this.timerFired && !(this.irqDisable & 0x04)) return IRQ_VECTOR_TIQ;
      if (this.vblankPending && (this.vdcCr & 0x08) && !(this.irqDisable & 0x02)) return IRQ_VECTOR_IRQ1;
      return -1;
    }
  }

  Emu.HesBus = HesBus;
  Emu.HES_IRQ_VECTOR = { IRQ2: IRQ_VECTOR_IRQ2, IRQ1: IRQ_VECTOR_IRQ1, TIQ: IRQ_VECTOR_TIQ };
})(window);
