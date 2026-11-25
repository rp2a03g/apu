/*
 * HES(PC エンジンの曲データ)を走らせるためのバス: MMU、RAM、I/O(タイマ、割り込み、波形メモリ音源、VDC/VCE の時間だけ)
 * MML.Emu.HesBus — 2026-11-15 に時計を作り直し(段階 9a)
 *
 * 作り: CPU(cpuHuC6280.js)が 1 サイクルごとに tick() を呼ぶ。tick はマスタークロック(21.47727MHz)を
 * 高速時 3、低速時 12 進め、その分だけタイマ(pce/pceTimer.js)と VDC の時間(pce/vdcTiming.js)を進める。
 * 割り込みは「今かかっている線」(irqLines)として CPU に見せ、CPU がサイクルごとに見て、命令の終わりに入る。
 *
 * HES という形式の事情: ヘッダには INIT 番地しか無い。曲を進める処理は、曲データ自身の割り込みベクタ($FFF6-$FFFB)から
 * タイマか垂直帰線の割り込みで呼ばれる。だから本物の割り込みが要る。
 * タイマ(PCM)と垂直帰線(曲)の両方を使う曲は、2 つの前後関係で音源への書き込みの順が変わるので、垂直帰線の時刻も本物どおりに出す。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/PCE/(読んだだけで写していない):
 *   [参照] PceMemoryManager.cpp: I/O の番地の分け方(1K ごと、下位ビットで鏡像)、$1402 は下位 3bit、$1403 への書き込みはタイマの割り込みを下げるだけ、
 *          I/O バッファ(タイマ/割り込みレジスタの読み出しで上位ビットに前の値が残る)、音源の読み出しは I/O バッファ、
 *          VDC/VCE を読み書きすると CPU が 1 サイクル待たされる、パッド無しの $1000 は $BF(北米本体扱い+CD 無し)、
 *          電源投入で割り込みマスクは 0、1 サイクルの中の順番はタイマ → VDC
 *   [参照] PceVdc.cpp: VDC のステータスを読むと印と割り込みの線が消える。ポート 1 の読みは 0
 *   [参照] HesFileData.h / PceMemoryManager.cpp: バンク $00-$7F のうち DATA ブロックの外は $00 が読める(1MB を 0 で埋めた上に曲を置く)。
 *          HES は SuperGrafx ではない本体として動くので、RAM は 8K 1 枚で、バンク $F8-$FB はどれも同じ RAM
 *   [推定] VDC のデータポート(2/3)の読みは 0 を返す(VRAM を持たないため。HES の曲が VRAM を読んで分岐することは無い、という前提)
 *   [推定] RAM は 0 で始める(Mesen も HES では 0 にしている。「0 でないと鳴らない曲が多い」というコメントつき)
 * 動きは tools/headless/pce-mesen-ab.js(書き込みの並び)と pce-iotrace.js(I/O を時刻つきで)で Mesen と突き合わせる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const PAGE_SIZE = 0x2000;
  const LINE_IRQ1 = 2, LINE_TIMER = 4;
  const DEFER_LIMIT = 1365 * 262; // 救済の後回しの上限(マスタークロック。1 画面ぶん)

  class HesBus {
    /**
     * @param {object} header - HES.parseHeader() の結果
     * @param {Uint8Array} rom - DATA ブロック(header.dataOffset から dataSize ぶん)
     */
    constructor(header, rom) {
      this.header = header;
      this.rom = rom;
      this.romBase = header.addr;
      this.mpr = new Uint8Array(8);
      this.ram = new Uint8Array(PAGE_SIZE);       // バンク $F8-$FB(同じ 8K が 4 回見える)
      this.timer = new Emu.PceTimer();
      this.vdc = new Emu.PceVdcTiming();
      this.apu = null;     // hesPlayer.js が後から入れる
      this.cpu = null;     // 同上(VDC/VCE を触った時に 1 サイクル待たせるのに使う)
      this.onWrite = null; // 書き込みの採り口(論理番地, 値)
      this.syncApu = null; // 音源へ書く直前に呼ぶ(hesPlayer.js が「今の時刻まで音源を進める」のに使う)
      // HES の救済(実機には無い決まり。既定は入: HesPlayer.DEFER_VBLANK): タイマ割り込みの処理の中にいる間は、垂直帰線(IRQ1)の割り込みを入れず、戻った直後に入れる。
      // 理由: タイマ割り込み(DDA の再生)の処理が頭で割り込みを許可し直すゲームがあり、ゲーム本体は「処理中なら曲の処理を後回しにする」確認を
      //   垂直帰線の側に持っている。HES にする時にその確認が抜けた物は、DDA の処理が ch を選んでから値を書くまでの間に曲の処理が割り込み、
      //   選択が変わったまま戻って、DDA の値が別の ch の波形に落ちる(鳴っている波形が少しずつ壊れる。DESIGN-PCE-CAPTURE.md §9.4)。
      //   [推定] ゲーム固有の印を知らなくても同じ結果になる一般的な形としてこうした。Mesen には無い(入れると Mesen との照合は合わなくなる)。
      //   RTI で戻らない処理に備えて、入ってから 1 画面ぶん経ったら後回しをやめる
      this.deferVblank = false;
      this.reset();
    }

    reset() {
      for (let i = 0; i < 8; i++) this.mpr[i] = this.header.banks[i] || 0;
      this.ram.fill(0);
      this.timer.reset();
      this.vdc.reset();
      this.clock = 0;          // マスタークロックの通算
      this.cycleSteps = 1;     // CPU 1 サイクル = マスタークロック 3 個が何回ぶんか(高速 1、低速 4)
      this.timerIrq = false;   // タイマの割り込みの線($1403 への書き込みで下がる)
      this.irqDisable = 0;     // $1402
      this.ioBuffer = 0;
    }

    setMpr(i, bank) { this.mpr[i & 7] = bank & 0xFF; }
    getMpr(i) { return this.mpr[i & 7]; }
    setSpeed(high) { this.cycleSteps = high ? 1 : 4; }

    /** CPU 1 サイクル。マスタークロック 3 個ずつ、タイマ → VDC の順に進める */
    tick() {
      const timer = this.timer, vdc = this.vdc;
      for (let i = this.cycleSteps; i > 0; i--) {
        this.clock += 3;
        if (timer.advance(3)) this.timerIrq = true;
        vdc.exec();
      }
    }

    /** かかっている割り込み(マスク前)。bit1 = IRQ1(VDC)、bit2 = タイマ。IRQ2(bit0)は CD/外部で、HES には無い */
    get irqActive() { return (this.vdc.irq ? LINE_IRQ1 : 0) | (this.timerIrq ? LINE_TIMER : 0); }
    /** CPU が見る線(マスク後) */
    irqLines() {
      let l = ((this.vdc.irq ? LINE_IRQ1 : 0) | (this.timerIrq ? LINE_TIMER : 0)) & ~this.irqDisable;
      if (this.deferVblank && (l & LINE_IRQ1)) {
        const cpu = this.cpu;
        if (cpu && cpu.irqNest.length && cpu.irqNest.indexOf(0xFFFA) >= 0 && this.clock - cpu.irqTimerAt < DEFER_LIMIT) l &= ~LINE_IRQ1;
      }
      return l;
    }

    read(addr) {
      addr &= 0xFFFF;
      const bank = this.mpr[addr >>> 13];
      if (bank === 0xFF) return this.readIo(addr & 0x1FFF);
      if (bank >= 0xF8 && bank <= 0xFB) return this.ram[addr & 0x1FFF];
      if (bank >= 0x80) return 0xFF;
      const off = bank * PAGE_SIZE + (addr & 0x1FFF) - this.romBase;
      return (off >= 0 && off < this.rom.length) ? this.rom[off] : 0x00;
    }

    write(addr, value) {
      addr &= 0xFFFF; value &= 0xFF;
      if (this.onWrite) this.onWrite(addr, value);
      const bank = this.mpr[addr >>> 13];
      if (bank === 0xFF) { this.writeIo(addr & 0x1FFF, value); return; }
      if (bank >= 0xF8 && bank <= 0xFB) { this.ram[addr & 0x1FFF] = value; return; }
    }

    /** ST0/ST1/ST2 の書き先(VDC のポート 0/2/3)。MPR を通らない */
    stWrite(port, value) { this.writeIo(port & 3, value & 0xFF); }

    readIo(off) {
      if (off < 0x0400) { // VDC
        this.tick(); // 1 サイクル待たされる
        return (off & 3) === 0 ? this.vdc.readStatus() : 0;
      }
      if (off < 0x0800) { this.tick(); return 0xFF; }            // VCE(パレットは持たない。書き込み専用のレジスタは $FF)
      if (off < 0x0C00) return this.ioBuffer;                    // 波形メモリ音源は読めない
      if (off < 0x1000) { this.ioBuffer = (this.ioBuffer & 0x80) | (this.timer.read() & 0x7F); return this.ioBuffer; }
      if (off < 0x1400) { this.ioBuffer = 0xBF; return this.ioBuffer; } // パッド無し
      if (off < 0x1800) {
        switch (off & 3) {
          case 2: this.ioBuffer = (this.ioBuffer & 0xF8) | (this.irqDisable & 7); break;
          case 3: this.ioBuffer = (this.ioBuffer & 0xF8) | (this.irqActive & 7); break;
        }
        return this.ioBuffer;
      }
      return 0xFF; // CD ほか
    }

    writeIo(off, value) {
      if (off < 0x0400) { // VDC
        this.vdc.write(off, value);
        if (this.cpu) this.cpu.idle(); // 1 サイクル待たされる
        return;
      }
      if (off < 0x0800) { // VCE
        if ((off & 7) === 0) this.vdc.writeVceControl(value);
        if (this.cpu) this.cpu.idle();
        return;
      }
      if (off < 0x0C00) { // 波形メモリ音源
        if (this.apu) { if (this.syncApu) this.syncApu(); this.apu.writeRegister(0x0800 | (off & 0x0F), value); }
        this.ioBuffer = value; return;
      }
      if (off < 0x1000) { this.timer.write(off, value); this.ioBuffer = value; return; }
      if (off < 0x1400) { this.ioBuffer = value; return; }
      if (off < 0x1800) {
        switch (off & 3) {
          case 2: this.irqDisable = value & 7; break;
          case 3: this.timerIrq = false; break;
        }
        this.ioBuffer = value;
        return;
      }
    }
  }

  Emu.HesBus = HesBus;
})(window);
