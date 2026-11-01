/*
 * NES 本体 (MML.Emu.NesConsole) — CPU(cpu6502.js)/PPU(nes/ppu.js)/APU(apu2a03.js)/マッパー(nes/mappers.js)/
 * 入力の結線と、1 フレームの実行。DOM に依存しない(ヘッドレス tools/headless/nes-run.js でも動く)。
 *
 * - 1 命令ごとに消費サイクルぶん APU を進め、PPU を 3 ドットずつ進める(命令の途中では割り込まない)。
 * - NMI は PPU の線(vblank フラグ ∧ $2000 bit7)の立ち上がりを命令境界で拾う。IRQ は APU のフレーム/DMC と
 *   マッパー(MMC3/N163)の線の論理和を、I フラグが下りていれば命令境界で受ける。
 * - $4014 OAM DMA は 256 バイトを即座に写し、513/514 サイクルを次の命令に乗せる。
 * - 音: setSampleRate(sr) を呼ぶと、runFrame() が 1 フレームぶんのサンプル(Float32Array)を返す。
 *   APU の混合は NsfPlayer と同じ(apu.mixSample + 拡張音源)。呼ばなければ音の計算はしない。
 * - 入力: setController(port, bits)。bits は A=1 B=2 Select=4 Start=8 Up=16 Down=32 Left=64 Right=128。
 * - 録音(6b): bus の書き込みフック onWrite(addr, value, frameFrac) を APU/拡張音源の書き込みで呼ぶ。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 1789773;

  class NesConsole {
    constructor(romBytes) {
      this.rom = Emu.INES.parse(romBytes);
      this.mapper = Emu.NesMappers.create(this.rom);
      this.ppu = new Emu.PPU(this.mapper);
      this.apu = new Emu.APU2A03(this);
      this.cpu = new Emu.CPU6502(this);
      this.ram = new Uint8Array(0x800);
      this.openBus = 0;
      this.pad = [0, 0]; this.padShift = [0, 0]; this.padStrobe = false;
      this.dmaCycles = 0;
      this.prevNmi = false; this.pendingNmi = false;
      this.cpuCycles = 0;
      this.sampleRate = 0; this.cycleAccum = 0; this.audioOut = null; this.audioLen = 0;
      this.onWrite = null;
      this.reset();
    }

    reset() {
      this.ram.fill(0);
      this.ppu.reset();
      this.apu.reset();
      this.apu.writeRegister(0x4017, 0x00);
      this.apu.writeRegister(0x4015, 0x00);
      this.cpu.reset();
      this.cpu.PC = this.read(0xFFFC) | (this.read(0xFFFD) << 8);
      this.prevNmi = false; this.pendingNmi = false; this.dmaCycles = 0;
      this.cpuCycles = 0;
    }

    setSampleRate(sr) {
      this.sampleRate = sr;
      this.audioOut = sr ? new Float32Array(Math.ceil(sr / 50)) : null;
      this.cycleAccum = 0;
    }
    setController(port, bits) { this.pad[port & 1] = bits & 0xFF; }

    // ── バス ──
    read(addr) {
      addr &= 0xFFFF;
      let v;
      if (addr < 0x2000) v = this.ram[addr & 0x7FF];
      else if (addr < 0x4000) v = this.ppu.readReg(addr & 7);
      else if (addr === 0x4015) v = this.apu.readStatus();
      else if (addr === 0x4016 || addr === 0x4017) {
        const p = addr & 1;
        if (this.padStrobe) v = this.pad[p] & 1;
        else { v = this.padShift[p] & 1; this.padShift[p] = (this.padShift[p] >> 1) | 0x80; }
        v |= this.openBus & 0xE0;
      } else if (addr < 0x4020) v = this.openBus;
      else { v = this.mapper.cpuRead(addr); if (v < 0) v = this.openBus; }
      this.openBus = v;
      return v;
    }
    write(addr, v) {
      addr &= 0xFFFF; v &= 0xFF;
      this.openBus = v;
      if (addr < 0x2000) { this.ram[addr & 0x7FF] = v; return; }
      if (addr < 0x4000) { this.ppu.writeReg(addr & 7, v); return; }
      if (addr === 0x4014) {
        const base = v << 8;
        for (let i = 0; i < 256; i++) this.ppu.dmaWrite(i, this.read(base + i));
        this.dmaCycles += 513 + (this.cpuCycles & 1);
        return;
      }
      if (addr === 0x4016) {
        const was = this.padStrobe;
        this.padStrobe = (v & 1) !== 0;
        if (was && !this.padStrobe) { this.padShift[0] = this.pad[0]; this.padShift[1] = this.pad[1]; }
        return;
      }
      if (addr < 0x4018) { this.apu.writeRegister(addr, v); if (this.onWrite) this.onWrite(addr, v, this.frameFrac); return; }
      this.mapper.cpuWrite(addr, v);
      if (this.onWrite && (addr === 0x4800 || addr === 0xF800) && this.mapper.audio) this.onWrite(addr, v, this.frameFrac);
    }

    // ── 実行 ──
    // 1 命令(+割り込み)を実行し、消費サイクルぶん周辺を進める
    step() {
      const cpu = this.cpu, ppu = this.ppu, apu = this.apu, mapper = this.mapper;
      let cycles;
      if (this.pendingNmi) { this.pendingNmi = false; cycles = cpu.nmi(); }
      else if (!cpu.irqInhibited() && (apu.frameIrqFlag || apu.dmc.irqFlag || mapper.irqPending())) cycles = cpu.irq();
      else {
        // 命令のメモリアクセスは最後のサイクルで起きる近似: 基本サイクル数-1 だけ先に周辺を進めてから実行する。
        // $2002 を回して vblank を待つループ(LDA $2002 / BPL)やスプライト 0 ヒット待ちは、読みの瞬間と
        // フラグが立つ瞬間の前後関係で結果が変わる。命令をまるごと先に実行すると読みが常に「命令の頭」に
        // なり、NMI ハンドラが先にフラグを消す側に必ず負けて永久に待つ(実測: 本体がタイトルを出さない)
        const pre = cpu.peekCycles() - 1;
        if (pre > 0) this.advance(pre);
        cycles = cpu.step() - pre;
      }
      cycles += this.dmaCycles; this.dmaCycles = 0;
      this.advance(cycles);
      const nmi = ppu.nmiLine();
      if (nmi && !this.prevNmi) this.pendingNmi = true;
      this.prevNmi = nmi;
      return cycles;
    }

    // 周辺(APU/拡張音源/PPU/音の標本化)を cycles サイクルぶん進める
    advance(cycles) {
      const ppu = this.ppu, apu = this.apu, mapper = this.mapper;
      this.cpuCycles += cycles;
      mapper.cpuClock(cycles); // ★命令前の先行分(pre)にも掛けること。step() 側でだけ呼ぶと N163 の IRQ カウンタが 1/3 の速さになり、毎 NMI に再装填する曲では IRQ が永遠に来ない(実測)
      const audio = mapper.audio;
      const sr = this.sampleRate;
      for (let c = 0; c < cycles; c++) {
        apu.clock();
        if (audio) audio.clock();
        ppu.step(); ppu.step(); ppu.step();
        if (sr) {
          this.cycleAccum += sr;
          if (this.cycleAccum >= CPU_CLOCK) {
            this.cycleAccum -= CPU_CLOCK;
            if (this.audioLen < this.audioOut.length) {
              let s = apu.mixSample();
              if (audio) s += audio.mixSample();
              this.audioOut[this.audioLen++] = s;
            }
          }
        }
      }
    }

    // PPU が 1 フレームを描き終えるまで回す。音を有効にしていればそのフレームのサンプル列を返す
    runFrame() {
      const ppu = this.ppu;
      ppu.frameDone = false;
      this.audioLen = 0;
      const startCycles = this.cpuCycles;
      let guard = 0;
      while (!ppu.frameDone) {
        this.frameFrac = Math.min(1, (this.cpuCycles - startCycles) / 29780);
        this.step();
        if (++guard > 200000) break; // 暴走の保険(1 フレームは約 29780 サイクル = 命令 1 万前後)
      }
      return this.audioOut ? this.audioOut.subarray(0, this.audioLen) : null;
    }

    get frame() { return this.ppu.frame; }
  }

  NesConsole.CPU_CLOCK = CPU_CLOCK;
  NesConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.NesConsole = NesConsole;
})(typeof window !== 'undefined' ? window : globalThis);
