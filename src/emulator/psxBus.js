/*
 * PlayStation バス(PSF再生用の最小構成)
 * MML.Emu.PsxBus
 *
 *   RAM 2MB(0x00000000/0x80000000/0xA0000000 の各セグメントで 4 回ミラー)
 *   スクラッチパッド 1KB (0x1F800000)
 *   割込みコントローラ I_STAT/I_MASK (0x1F801070/74)
 *   DMA 7ch (0x1F801080..) — SPU(ch4) は即時転送、GPU(ch2)/OTC(ch6)/他は形だけ完了させる
 *   ルートカウンタ 3 本 (0x1F801100..)
 *   GPU ステータス (0x1F801814) — VBlank ごとに奇偶ビットが反転するだけ
 *   SPU (0x1F801C00..0x1F801FFF) → Emu.SpuPsx
 *   BIOS 領域 (0x1FC00000..) は HLE のトラップ用(読みは 0)
 *
 * 時間の進め方: CPU の累積サイクル(cpu.cycles)を sync(cycles) に渡すと、
 * その時点までのルートカウンタ・VBlank・SPU(768 サイクルごとに 1 サンプル)を進める。
 * SPU の出力は audioL/audioR(Int16Array のリング)に溜まり、player が取り出す。
 *
 * CPU クロック 33.8688MHz。フレーム周期は GPU クロック(53.693175MHz)の
 * NTSC 3413×263 / PAL 3406×314 ドットから換算する(59.83Hz / 50.20Hz)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 33868800;
  const GPU_CLOCK = 53693175;
  const RAM_SIZE = 0x200000;
  const CYCLES_PER_SAMPLE = 768;

  const IRQ_VBLANK = 1, IRQ_GPU = 2, IRQ_CDROM = 4, IRQ_DMA = 8, IRQ_TMR0 = 16, IRQ_TMR1 = 32, IRQ_TMR2 = 64, IRQ_SIO0 = 128, IRQ_SIO1 = 256, IRQ_SPU = 512, IRQ_PIO = 1024;

  class RootCounter {
    constructor(index, bus) {
      this.index = index; this.bus = bus;
      this.reset();
    }
    reset() {
      this.count = 0; this.mode = 0; this.target = 0;
      this.frac = 0;        // 分周の端数(CPUサイクル)
      this.irqDone = false; // ワンショットで発火済み
      this.reachedTarget = false; this.reachedOverflow = false;
      this.irqRequest = true; // bit10: 0=要求中(反転論理)
    }
    /** 1カウントあたりの CPU サイクル(小数可) */
    divisor() {
      const src = (this.mode >> 8) & 3;
      switch (this.index) {
        case 0: return (src & 1) ? this.bus.cyclesPerDot : 1;
        case 1: return (src & 1) ? this.bus.cyclesPerHblank : 1;
        default: return (src & 2) ? 8 : 1;
      }
    }
    stopped() {
      if (!(this.mode & 1)) return false;
      const sm = (this.mode >> 1) & 3;
      if (this.index === 2) return sm === 0 || sm === 3;
      return false; // 0/1 のブランク同期は自由走行として扱う
    }
    writeMode(v) {
      this.mode = v & 0x3FF;
      this.count = 0; this.frac = 0;
      this.irqDone = false; this.irqRequest = true;
      this.reachedTarget = false; this.reachedOverflow = false;
    }
    readMode() {
      let v = this.mode | (this.irqRequest ? 0x400 : 0) | (this.reachedTarget ? 0x800 : 0) | (this.reachedOverflow ? 0x1000 : 0);
      this.reachedTarget = false; this.reachedOverflow = false;
      return v;
    }
    fireIrq() {
      const repeat = !!(this.mode & 0x40);
      if (!repeat && this.irqDone) return;
      this.irqDone = true;
      if (this.mode & 0x80) { // トグル
        this.irqRequest = !this.irqRequest;
        if (!this.irqRequest) this.bus.raiseIrq(IRQ_TMR0 << this.index);
      } else {
        this.irqRequest = false;
        this.bus.raiseIrq(IRQ_TMR0 << this.index);
        this.irqRequest = true; // パルス
      }
    }
    targetHit() { this.reachedTarget = true; if (this.mode & 0x10) this.fireIrq(); }
    overflowHit() { this.reachedOverflow = true; if (this.mode & 0x20) this.fireIrq(); }
    advance(cycles) {
      if (this.stopped()) return;
      const div = this.divisor();
      let ticks;
      if (div === 1) ticks = cycles;
      else { this.frac += cycles; ticks = Math.floor(this.frac / div); this.frac -= ticks * div; }
      const tgt = this.target & 0xFFFF;
      const resetOnTarget = !!(this.mode & 8);
      if (resetOnTarget && tgt === 0) { // 毎カウント到達: 1回だけ扱う
        if (ticks > 0) this.targetHit();
        this.count = 0;
        return;
      }
      while (ticks > 0) {
        if (resetOnTarget) {
          // 0..tgt を往復。count > tgt(目標を下げた直後)は 0xFFFF まで走る
          const n = (this.count <= tgt) ? tgt - this.count : 0xFFFF - this.count;
          if (ticks <= n) { this.count += ticks; ticks = 0; if (this.count === tgt) this.reachedTarget = true; }
          else {
            ticks -= n + 1;
            if (this.count + n === tgt) this.targetHit(); else this.overflowHit();
            this.count = 0;
          }
        } else {
          const n = 0xFFFF - this.count;
          if (ticks <= n) {
            const nc = this.count + ticks;
            if (this.count < tgt && nc >= tgt) this.targetHit();
            this.count = nc; ticks = 0;
          } else {
            if (this.count < tgt) this.targetHit();
            ticks -= n + 1;
            this.overflowHit();
            this.count = 0;
          }
        }
      }
    }
  }

  class PsxBus {
    constructor(spu) {
      this.ramBuf = new ArrayBuffer(RAM_SIZE);
      this.ram = new Uint8Array(this.ramBuf);
      this.ram16 = new Uint16Array(this.ramBuf);
      this.ram32 = new Int32Array(this.ramBuf);
      this.scratchBuf = new ArrayBuffer(0x400);
      this.scratch = new Uint8Array(this.scratchBuf);
      this.scratch16 = new Uint16Array(this.scratchBuf);
      this.scratch32 = new Int32Array(this.scratchBuf);
      this.spu = spu || new Emu.SpuPsx();
      this.spu.onIrq = () => this.raiseIrq(IRQ_SPU);
      this.counters = [new RootCounter(0, this), new RootCounter(1, this), new RootCounter(2, this)];
      this.memCtrl = new Int32Array(9);
      this.dmaMadr = new Int32Array(7); this.dmaBcr = new Int32Array(7); this.dmaChcr = new Int32Array(7);
      this.audioL = new Int16Array(65536); this.audioR = new Int16Array(65536);
      this.audioWrite = 0; this.audioRead = 0;
      this.onWrite = null;   // (addr, value, size) 任意のフック(デバッグ用)
      this.writeSeq = 0;         // CPU からの書き込み回数(アイドル判定用)
      this.ioSeq = 0;            // 時間で値が変わりうる I/O の読み出し回数(アイドル判定用)
      this.protectStubs = false; // HLE スタブ(0x80..0xCF)への書き込みを弾く(ドライバがベクタを消しても HLE が生き残るように)
      this.speedFactor = 1;      // テンポ変更: CPU/タイマ/VBlank だけ速くする(SPU は不変)
      this.trapMask = 0x1FF80000; this.trapBase = 0x1FC00000; // BIOS 領域(セグメントビットは落として比較)
      this.onTrap = null; this.onSyscall = null;
      this.setRefresh(60);
      this.reset();
    }

    setRefresh(hz) {
      const pal = hz === 50;
      const dots = pal ? 3406 * 314 : 3413 * 263;
      this.cyclesPerFrame = dots * CPU_CLOCK / GPU_CLOCK;
      this.cyclesPerHblank = this.cyclesPerFrame / (pal ? 314 : 263);
      this.cyclesPerDot = CPU_CLOCK / GPU_CLOCK * 8; // 320px モード相当(ドットクロック=GPU/8)
      this.frameRate = CPU_CLOCK / this.cyclesPerFrame;
    }

    reset() {
      this.ram.fill(0); this.scratch.fill(0);
      this.spu.reset();
      for (const c of this.counters) c.reset();
      this.iStat = 0; this.iMask = 0; this.irqLine = false;
      this.dmaMadr.fill(0); this.dmaBcr.fill(0); this.dmaChcr.fill(0);
      this.dpcr = 0x07654321; this.dicr = 0;
      this.memCtrl.fill(0);
      this.ramSize = 0x00000B88;
      this.cacheCtrl = 0;
      this.gpuStat = 0x14802000 | 0;
      this.gpuOdd = false;
      this.syncedCycles = 0;
      this.frameAccum = 0; this.spuAccum = 0;
      this.frameCount = 0;
      this.audioWrite = 0; this.audioRead = 0;
      this.onVblank = null;
      this.onSample = null;
    }

    // ── 割込み ────────────────────────────────────────────
    raiseIrq(bit) { this.iStat |= bit; this.updateIrqLine(); }
    updateIrqLine() { this.irqLine = (this.iStat & this.iMask) !== 0; }

    // ── 時間 ──────────────────────────────────────────────
    /** cpu.cycles(累積)まで周辺を進める */
    sync(cycles) {
      let elapsed = cycles - this.syncedCycles;
      if (elapsed <= 0) return;
      this.syncedCycles = cycles;
      const timerElapsed = this.speedFactor === 1 ? elapsed : elapsed * this.speedFactor;
      for (const c of this.counters) c.advance(timerElapsed);
      this.frameAccum += timerElapsed;
      while (this.frameAccum >= this.cyclesPerFrame) {
        this.frameAccum -= this.cyclesPerFrame;
        this.gpuOdd = !this.gpuOdd;
        this.frameCount++;
        this.raiseIrq(IRQ_VBLANK);
        if (this.onVblank) this.onVblank(this.frameCount);
      }
      this.spuAccum += elapsed;
      const spu = this.spu;
      while (this.spuAccum >= CYCLES_PER_SAMPLE) {
        this.spuAccum -= CYCLES_PER_SAMPLE;
        spu.clock();
        const w = this.audioWrite;
        this.audioL[w] = spu.outL; this.audioR[w] = spu.outR;
        this.audioWrite = (w + 1) & 0xFFFF;
        if (this.onSample) this.onSample(spu);
      }
    }

    /** 溜まった音声サンプル数 */
    get audioAvailable() { return (this.audioWrite - this.audioRead) & 0xFFFF; }
    /** サンプルを1つ取り出す({l,r} を避けて2値を配列 out[0],out[1] に書く) */
    popSample(out) {
      const r = this.audioRead;
      out[0] = this.audioL[r]; out[1] = this.audioR[r];
      this.audioRead = (r + 1) & 0xFFFF;
    }

    // ── メモリ ────────────────────────────────────────────
    read8(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000) return this.ram[p & 0x1FFFFF];
      if ((p & 0x1FFFFC00) === 0x1F800000) return this.scratch[p & 0x3FF];
      if ((p & 0x1FFFF000) === 0x1F801000) {
        this.ioSeq++;
        if (p >= 0x1F801C00 && p < 0x1F802000) { const h = this.spu.readReg((p - 0x1F801C00) >> 1); return (p & 1) ? (h >> 8) & 0xFF : h & 0xFF; }
        const w = this.ioRead32(p & ~3);
        return (w >>> ((p & 3) * 8)) & 0xFF;
      }
      if (p >= 0x1F000000 && p < 0x1F800000) return 0xFF; // 拡張1(未接続)
      return 0;
    }
    read16(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p & 1) return this.read8(addr) | (this.read8(addr + 1) << 8);
      if (p < 0x800000) return this.ram16[(p & 0x1FFFFF) >> 1];
      if ((p & 0x1FFFFC00) === 0x1F800000) return this.scratch16[(p & 0x3FF) >> 1];
      if ((p & 0x1FFFF000) === 0x1F801000) {
        this.ioSeq++;
        if (p >= 0x1F801C00 && p < 0x1F802000) return this.spu.readReg((p - 0x1F801C00) >> 1);
        const w = this.ioRead32(p & ~3);
        return (w >>> ((p & 2) * 8)) & 0xFFFF;
      }
      if (p >= 0x1F000000 && p < 0x1F800000) return 0xFFFF;
      return 0;
    }
    read32(addr) {
      const p = addr & 0x1FFFFFFF;
      if (p & 3) return (this.read16(addr) | (this.read16(addr + 2) << 16)) | 0;
      if (p < 0x800000) return this.ram32[(p & 0x1FFFFF) >> 2];
      if ((p & 0x1FFFFC00) === 0x1F800000) return this.scratch32[(p & 0x3FF) >> 2];
      if ((p & 0x1FFFF000) === 0x1F801000) {
        this.ioSeq++;
        if (p >= 0x1F801C00 && p < 0x1F802000) {
          const i = (p - 0x1F801C00) >> 1;
          return (this.spu.readReg(i) | (this.spu.readReg(i + 1) << 16)) | 0;
        }
        return this.ioRead32(p);
      }
      if (p >= 0x1F000000 && p < 0x1F800000) return -1;
      if ((addr >>> 0) === 0xFFFE0130) { this.ioSeq++; return this.cacheCtrl; }
      return 0;
    }
    write8(addr, v) {
      this.writeSeq++;
      const p = addr & 0x1FFFFFFF;
      if (p < 0x800000) { if (this.protectStubs && ((p & 0x1FFFFF) - 0x80 >>> 0) < 0x50) return; this.ram[p & 0x1FFFFF] = v; return; }
      if ((p & 0x1FFFFC00) === 0x1F800000) { this.scratch[p & 0x3FF] = v; return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00 && p < 0x1F802000) { if (!(p & 1)) this.spu.writeReg((p - 0x1F801C00) >> 1, v & 0xFF); return; }
        // 8bit I/O 書き(CD-ROM 等)は無視
        return;
      }
    }
    write16(addr, v) {
      this.writeSeq++;
      const p = addr & 0x1FFFFFFF;
      if ((p & 1) && p < 0x800000) { this.write8(addr, v & 0xFF); this.write8(addr + 1, (v >>> 8) & 0xFF); return; }
      if (p < 0x800000) { if (this.protectStubs && ((p & 0x1FFFFF) - 0x80 >>> 0) < 0x50) return; this.ram16[(p & 0x1FFFFF) >> 1] = v; return; }
      if ((p & 0x1FFFFC00) === 0x1F800000) { this.scratch16[(p & 0x3FF) >> 1] = v; return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00 && p < 0x1F802000) { this.spu.writeReg((p - 0x1F801C00) >> 1, v); return; }
        if (p >= 0x1F801100 && p < 0x1F801130) { this.timerWrite(p, v & 0xFFFF); return; }
        if (p === 0x1F801070) { this.iStat &= v; this.updateIrqLine(); return; }
        if (p === 0x1F801074) { this.iMask = v & 0x7FF; this.updateIrqLine(); return; }
        return;
      }
    }
    write32(addr, v) {
      this.writeSeq++;
      const p = addr & 0x1FFFFFFF;
      if ((p & 3) && p < 0x800000) { this.write16(addr, v & 0xFFFF); this.write16(addr + 2, (v >>> 16) & 0xFFFF); return; }
      if (p < 0x800000) { if (this.protectStubs && ((p & 0x1FFFFF) - 0x80 >>> 0) < 0x50) return; this.ram32[(p & 0x1FFFFF) >> 2] = v; return; }
      if ((p & 0x1FFFFC00) === 0x1F800000) { this.scratch32[(p & 0x3FF) >> 2] = v; return; }
      if ((p & 0x1FFFF000) === 0x1F801000) {
        if (p >= 0x1F801C00 && p < 0x1F802000) {
          const i = (p - 0x1F801C00) >> 1;
          this.spu.writeReg(i, v & 0xFFFF); this.spu.writeReg(i + 1, (v >>> 16) & 0xFFFF);
          return;
        }
        this.ioWrite32(p, v);
        return;
      }
      if ((addr >>> 0) === 0xFFFE0130) { this.cacheCtrl = v; return; }
    }

    // ── I/O ───────────────────────────────────────────────
    ioRead32(p) {
      if (p >= 0x1F801000 && p < 0x1F801024) return this.memCtrl[(p - 0x1F801000) >> 2];
      switch (p) {
        case 0x1F801060: return this.ramSize;
        case 0x1F801070: return this.iStat;
        case 0x1F801074: return this.iMask;
        case 0x1F8010F0: return this.dpcr;
        case 0x1F8010F4: return this.dicr;
        case 0x1F801814: return (this.gpuStat & 0x7FFFFFFF) | (this.gpuOdd ? 0x80000000 : 0);
        case 0x1F801810: return 0;
        case 0x1F801040: return 0xFFFFFFFF | 0; // SIO0 data(パッド無し)
        case 0x1F801044: return 0x5; // SIO0 stat: TX ready
        case 0x1F801800: return 0x18; // CDROM: parameter fifo empty/ready
        default: break;
      }
      if (p >= 0x1F801080 && p < 0x1F8010F0) {
        const ch = (p - 0x1F801080) >> 4;
        switch (p & 0xC) { case 0: return this.dmaMadr[ch]; case 4: return this.dmaBcr[ch]; case 8: return this.dmaChcr[ch]; default: return 0; }
      }
      if (p >= 0x1F801100 && p < 0x1F801130) {
        const c = this.counters[(p - 0x1F801100) >> 4];
        switch (p & 0xC) { case 0: return c.count & 0xFFFF; case 4: return c.readMode(); case 8: return c.target; default: return 0; }
      }
      return 0;
    }

    ioWrite32(p, v) {
      if (p >= 0x1F801000 && p < 0x1F801024) { this.memCtrl[(p - 0x1F801000) >> 2] = v; return; }
      switch (p) {
        case 0x1F801060: this.ramSize = v; return;
        case 0x1F801070: this.iStat &= v; this.updateIrqLine(); return;
        case 0x1F801074: this.iMask = v & 0x7FF; this.updateIrqLine(); return;
        case 0x1F8010F0: this.dpcr = v; return;
        case 0x1F8010F4: this.dicrWrite(v); return;
        case 0x1F801810: return; // GP0
        case 0x1F801814: return; // GP1
        default: break;
      }
      if (p >= 0x1F801080 && p < 0x1F8010F0) {
        const ch = (p - 0x1F801080) >> 4;
        switch (p & 0xC) {
          case 0: this.dmaMadr[ch] = v & 0x00FFFFFF; return;
          case 4: this.dmaBcr[ch] = v; return;
          case 8: this.dmaChcrWrite(ch, v); return;
          default: return;
        }
      }
      if (p >= 0x1F801100 && p < 0x1F801130) { this.timerWrite(p, v & 0xFFFF); return; }
    }

    timerWrite(p, v) {
      const c = this.counters[(p - 0x1F801100) >> 4];
      switch (p & 0xC) {
        case 0: c.count = v & 0xFFFF; break;
        case 4: c.writeMode(v); break;
        case 8: c.target = v & 0xFFFF; break;
        default: break;
      }
    }

    // ── DMA ───────────────────────────────────────────────
    dicrWrite(v) {
      // bit24-30 は書き込み 1 でリセット(ack)、bit0-23 は R/W
      const flags = this.dicr & 0x7F000000 & ~(v & 0x7F000000);
      this.dicr = (v & 0x00FFFFFF) | flags;
      this.updateDicrMaster();
    }
    updateDicrMaster() {
      const force = !!(this.dicr & 0x8000);
      const master = !!(this.dicr & 0x800000);
      const flagged = ((this.dicr >>> 24) & 0x7F) & ((this.dicr >>> 16) & 0x7F);
      if (force || (master && flagged)) this.dicr |= 0x80000000; else this.dicr &= 0x7FFFFFFF;
    }
    dmaComplete(ch) {
      this.dmaChcr[ch] &= ~0x11000000; // busy/trigger を落とす
      if ((this.dicr & 0x800000) && (this.dicr & (1 << (16 + ch)))) {
        this.dicr |= (1 << (24 + ch));
        const before = this.dicr & 0x80000000;
        this.updateDicrMaster();
        if (!before && (this.dicr & 0x80000000)) this.raiseIrq(IRQ_DMA);
      }
    }
    dmaChcrWrite(ch, v) {
      this.dmaChcr[ch] = v;
      if (!(v & 0x01000000)) return;                     // start/busy
      if (!(this.dpcr & (8 << (ch * 4)))) return;        // チャンネル無効
      const sync = (v >> 9) & 3;
      if (sync === 0 && !(v & 0x10000000)) return;       // 手動モードはトリガ待ち
      const toDevice = !!(v & 1);
      const step = (v & 2) ? -4 : 4;
      let addr = this.dmaMadr[ch] & 0x1FFFFC;
      const bcr = this.dmaBcr[ch];
      let words;
      if (sync === 0) { words = bcr & 0xFFFF; if (words === 0) words = 0x10000; }
      else if (sync === 1) { const bs = bcr & 0xFFFF, ba = (bcr >>> 16) & 0xFFFF; words = (bs === 0 ? 0x10000 : bs) * (ba === 0 ? 0x10000 : ba); }
      else words = 0; // linked list(GPU)
      switch (ch) {
        case 4: { // SPU
          const spu = this.spu;
          for (let i = 0; i < words; i++) {
            if (toDevice) spu.dmaWrite32(this.ram32[addr >> 2]);
            else this.ram32[addr >> 2] = spu.dmaRead32();
            addr = (addr + step) & 0x1FFFFC;
          }
          break;
        }
        case 6: { // OTC: 逆順リンクリストを RAM に書く
          for (let i = 0; i < words; i++) {
            const next = (i === words - 1) ? 0xFFFFFF : ((addr - 4) & 0x1FFFFC);
            this.ram32[addr >> 2] = next;
            addr = (addr - 4) & 0x1FFFFC;
          }
          break;
        }
        case 2: { // GPU: リンクリストは辿るだけ
          if (sync === 2) {
            let guard = 0;
            let node = addr;
            while (node !== 0xFFFFFC && (node & 0x800000) === 0 && guard++ < 100000) {
              const hdr = this.ram32[node >> 2];
              const next = hdr & 0xFFFFFF;
              if (next === 0xFFFFFF) break;
              node = next & 0x1FFFFC;
            }
          } else {
            addr = (addr + words * step) & 0x1FFFFC;
          }
          break;
        }
        default: // MDEC/CDROM/PIO: 読みは 0 で埋める
          if (!toDevice) for (let i = 0; i < words; i++) { this.ram32[addr >> 2] = 0; addr = (addr + step) & 0x1FFFFC; }
          break;
      }
      this.dmaMadr[ch] = addr;
      this.dmaComplete(ch);
    }

    // ── ユーティリティ ────────────────────────────────────
    /** RAM への一括書き込み(PS-EXE セグメント) */
    loadSegment(addr, data) {
      const p = addr & 0x1FFFFF;
      const n = Math.min(data.length, RAM_SIZE - p);
      this.ram.set(data.subarray(0, n), p);
      return n;
    }
    readString(addr, max) {
      let s = '';
      for (let i = 0; i < (max || 1024); i++) {
        const c = this.read8(addr + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
  }

  PsxBus.CPU_CLOCK = CPU_CLOCK;
  PsxBus.CYCLES_PER_SAMPLE = CYCLES_PER_SAMPLE;
  PsxBus.IRQ = { VBLANK: IRQ_VBLANK, GPU: IRQ_GPU, CDROM: IRQ_CDROM, DMA: IRQ_DMA, TMR0: IRQ_TMR0, TMR1: IRQ_TMR1, TMR2: IRQ_TMR2, SIO0: IRQ_SIO0, SIO1: IRQ_SIO1, SPU: IRQ_SPU, PIO: IRQ_PIO };
  Emu.PsxBus = PsxBus;
})(window);
