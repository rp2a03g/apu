/*
 * スーパーファミコン本体の骨格(段階 8g-2)
 * MML.Emu.SnesConsole / MML.Emu.SnesApu
 *
 * スーパーゲームボーイ(DESIGN-GB-CAPTURE.md §5)の SNES 側。SGB の BIOS を動かすのに要る範囲から作る:
 *   - 65816(cpu65816.js)、メモリ配置(LoROM/HiROM、WRAM 128K、SRAM)、番地ごとのアクセスの速さ
 *   - $4200 台: NMI/IRQ(H/V タイマ)、乗除算、パッドの自動読み、$4016/$4017 の直列読み
 *   - DMA(一括)と HDMA(行ごと)
 *   - PPU(snes/ppu.js)を行単位で描く。1 行 = 1364 マスタークロック、262 行(NTSC)
 *   - APU: 既存の SPC700(spc700.js、IPL ROM つき)と DSP(spcDsp.js)。ポート $2140-$2143 の読み書きのたびに時間を合わせる
 *   - 拡張の口 ext($6000-$7FFF。SGB の ICD2 が挿さる)
 * 時間はマスタークロック(21.477MHz)で数える。CPU の 1 サイクルは番地で 6/8/12 クロック、内部サイクルは 6。
 * まだ無い物: 行の長さの例外、DRAM リフレッシュ、DMA/HDMA の細かい時刻、PAL、オープンバスの細部、音の出力(8g-5)
 *
 * 参考: fullsnes(nocash)、SNESdev Wiki
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LINE_CLK = 1364, LINES = 262, VBLANK_LINE = 225;
  const APU_RATIO = 1024000 / 21477272; // SPC700 のサイクル / マスタークロック
  const DMA_PATTERN = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];

  // ── APU(SPC700+DSP)。SNES 側とは 4 本のポートでつながる ──
  class SnesApu {
    constructor() {
      this.ram = new Uint8Array(65536);
      this.dsp = Emu.SpcDsp ? new Emu.SpcDsp(this.ram) : null;
      this.in = new Uint8Array(4);  // SNES → SPC($F4-$F7 を読むと見える)
      this.out = new Uint8Array(4); // SPC → SNES($2140-$2143 を読むと見える)
      this.cpu = new Emu.SPC700(this);
      this.onSample = null;         // (L, R) DSP の 1 サンプル(32kHz)
      this.reset();
    }
    reset() {
      this.ram.fill(0); this.in.fill(0); this.out.fill(0);
      this.dspAddr = 0; this.romEnable = true;
      this.timers = [0, 0, 0]; this.timerDiv = [0, 0, 0]; this.timerCnt = [0, 0, 0]; this.timerEn = [false, false, false]; this.timerClk = [0, 0, 0];
      this.dspClk = 0;
      this.cycles = 0; // 走らせた SPC700 のサイクルの通算(録音がポート書き込みの刻印に使う)
      if (this.dsp) { this.dsp.reset(); this.dsp.regs[0x6C] = 0xE0; } // 電源投入時の FLG は $E0(リセット+ミュート+エコー書き込み禁止)。0 だとエコーが RAM $0000 台を壊し、IPL の転送先が化ける
      this.cpu.halted = false;
      this.cpu.reset(); // IPL ROM の先頭($FFC0)から
    }
    read(addr) {
      if (this.romEnable && addr >= 0xFFC0) return Emu.SPC_IPL_ROM[addr - 0xFFC0];
      if (addr >= 0xF0 && addr <= 0xFF) {
        switch (addr) {
          case 0xF2: return this.dspAddr;
          case 0xF3: return this.dsp ? this.dsp.readReg(this.dspAddr & 0x7F) : 0;
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.in[addr - 0xF4];
          case 0xFD: case 0xFE: case 0xFF: { const c = this.timerCnt[addr - 0xFD]; this.timerCnt[addr - 0xFD] = 0; return c; }
          case 0xF0: case 0xF1: case 0xFA: case 0xFB: case 0xFC: return 0;
        }
      }
      return this.ram[addr];
    }
    write(addr, v) {
      if (addr >= 0xF0 && addr <= 0xFF) {
        switch (addr) {
          case 0xF1:
            this.romEnable = (v & 0x80) !== 0;
            for (let t = 0; t < 3; t++) { const en = (v & (1 << t)) !== 0; if (en && !this.timerEn[t]) { this.timers[t] = 0; this.timerCnt[t] = 0; } this.timerEn[t] = en; }
            if (v & 0x10) { this.in[0] = 0; this.in[1] = 0; }
            if (v & 0x20) { this.in[2] = 0; this.in[3] = 0; }
            return;
          case 0xF2: this.dspAddr = v; return;
          case 0xF3: if (this.dsp && !(this.dspAddr & 0x80)) this.dsp.writeReg(this.dspAddr, v); return;
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: this.out[addr - 0xF4] = v; return;
          case 0xFA: case 0xFB: case 0xFC: this.timerDiv[addr - 0xFA] = v; return;
        }
      }
      this.ram[addr] = v;
    }
    // .spc ファイルの形の像(toSpc の逆)から始める。VGM の再生(GBXX 種類 1)が使う。DSP の内部(エンベロープの途中など)は像に無いので、鳴っていた音は次のキーオンから
    loadSpc(img) {
      if (!img || img.length < 0x10180) return false;
      this.reset();
      const c = this.cpu;
      this.ram.set(img.subarray(0x100, 0x10100));
      c.PC = img[0x25] | (img[0x26] << 8); c.A = img[0x27]; c.X = img[0x28]; c.Y = img[0x29]; c.PSW = img[0x2A]; c.SP = img[0x2B];
      const ctl = img[0x1F1];
      this.romEnable = (ctl & 0x80) !== 0;
      for (let t = 0; t < 3; t++) { this.timerEn[t] = (ctl & (1 << t)) !== 0; this.timerDiv[t] = img[0x1FA + t]; this.timerCnt[t] = img[0x1FD + t] & 0x0F; }
      this.dspAddr = img[0x1F2];
      for (let i = 0; i < 4; i++) this.in[i] = img[0x1F4 + i];
      if (this.dsp) for (let i = 0; i < 128; i++) { if (i === 0x4C || i === 0x5C) continue; this.dsp.writeReg(i, img[0x10100 + i]); } // KON/KOFF は書かない(鳴り直さない)
      if (this.dsp) this.dsp.regs[0x6C] = img[0x10100 + 0x6C];
      return true;
    }
    // シークの控え用(VGM 再生のチェックポイント)。関数と RAM への別名は写さない
    getState() {
      const cp = (v) => { if (v === null || typeof v !== 'object') return v; if (ArrayBuffer.isView(v)) return v.slice(); if (Array.isArray(v)) return v.map(cp); const o = {}; for (const k of Object.keys(v)) { if (typeof v[k] === 'function' || k === 'bus' || k === 'ram' || k === 'origRam') continue; o[k] = cp(v[k]); } return o; };
      return { ram: this.ram.slice(), in: this.in.slice(), out: this.out.slice(), dspAddr: this.dspAddr, romEnable: this.romEnable, timers: this.timers.slice(), timerDiv: this.timerDiv.slice(), timerCnt: this.timerCnt.slice(), timerEn: this.timerEn.slice(), timerClk: this.timerClk.slice(), dspClk: this.dspClk, cycles: this.cycles,
        cpu: cp(this.cpu), dsp: this.dsp ? cp(this.dsp) : null };
    }
    setState(s) {
      const put = (o, v) => { for (const k of Object.keys(v)) { const x = v[k], cur = o[k]; if (x === null || typeof x !== 'object') o[k] = x; else if (ArrayBuffer.isView(x)) { if (cur && ArrayBuffer.isView(cur) && cur.length === x.length) cur.set(x); else o[k] = x.slice(); } else if (Array.isArray(x)) { if (Array.isArray(cur) && cur.length === x.length && x.length && x[0] && typeof x[0] === 'object' && !ArrayBuffer.isView(x[0])) for (let i = 0; i < x.length; i++) put(cur[i], x[i]); else o[k] = x.map((e) => (ArrayBuffer.isView(e) ? e.slice() : e)); } else if (cur && typeof cur === 'object') put(cur, x); else o[k] = x; } };
      this.ram.set(s.ram); this.in.set(s.in); this.out.set(s.out); this.dspAddr = s.dspAddr; this.romEnable = s.romEnable;
      this.timers = s.timers.slice(); this.timerDiv = s.timerDiv.slice(); this.timerCnt = s.timerCnt.slice(); this.timerEn = s.timerEn.slice(); this.timerClk = s.timerClk.slice(); this.dspClk = s.dspClk; this.cycles = s.cycles || 0;
      put(this.cpu, s.cpu); if (this.dsp && s.dsp) put(this.dsp, s.dsp);
    }
    // 今の状態を .spc ファイルの形(0x10200 バイト)にする。録音の頭に入れる(SPC の再生系がそのまま読める形)
    toSpc() {
      const out = new Uint8Array(0x10200), c = this.cpu;
      const sig = 'SNES-SPC700 Sound File Data v0.30';
      for (let i = 0; i < sig.length; i++) out[i] = sig.charCodeAt(i);
      out[0x21] = 26; out[0x22] = 26; out[0x23] = 27; out[0x24] = 30; // 27 = ID666 タグ無し
      out[0x25] = c.PC & 0xFF; out[0x26] = (c.PC >> 8) & 0xFF; out[0x27] = c.A; out[0x28] = c.X; out[0x29] = c.Y; out[0x2A] = c.PSW; out[0x2B] = c.SP;
      out.set(this.ram, 0x100);
      // $F0-$FF はレジスタの値を入れておく(.spc の約束)
      out[0x1F1] = (this.romEnable ? 0x80 : 0) | (this.timerEn[0] ? 1 : 0) | (this.timerEn[1] ? 2 : 0) | (this.timerEn[2] ? 4 : 0);
      out[0x1F2] = this.dspAddr;
      for (let i = 0; i < 4; i++) out[0x1F4 + i] = this.in[i];
      for (let i = 0; i < 3; i++) { out[0x1FA + i] = this.timerDiv[i]; out[0x1FD + i] = this.timerCnt[i]; }
      if (this.dsp) for (let i = 0; i < 128; i++) out[0x10100 + i] = this.dsp.regs[i];
      out.set(this.ram.subarray(0xFFC0, 0x10000), 0x101C0);
      return out;
    }
    // SPC700 を cycles サイクルぶん進める。戻り値は実際に進んだサイクル(命令の切れ目まで)
    run(cycles) {
      let spent = 0;
      const cpu = this.cpu;
      while (spent < cycles) {
        const c = cpu.halted ? 2 : cpu.step();
        spent += c;
        for (let t = 0; t < 3; t++) {
          if (!this.timerEn[t]) continue;
          const period = t < 2 ? 128 : 16;
          this.timerClk[t] += c;
          while (this.timerClk[t] >= period) {
            this.timerClk[t] -= period;
            if (++this.timers[t] >= (this.timerDiv[t] || 256)) { this.timers[t] = 0; this.timerCnt[t] = (this.timerCnt[t] + 1) & 0x0F; }
          }
        }
        this.cycles += c;
        this.dspClk += c;
        while (this.dspClk >= 32) { this.dspClk -= 32; if (this.dsp) { this.dsp.clock(); if (this.onSample) this.onSample(this.dsp.outL, this.dsp.outR); } }
      }
      return spent;
    }
  }

  // ── カートリッジ(LoROM/HiROM。SGB の BIOS は LoROM 256K)──
  function parseRom(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if ((bytes.length & 0x3FF) === 0x200) bytes = bytes.subarray(0x200); // コピー機のヘッダ
    const score = (at) => {
      if (at + 0x40 > bytes.length) return -1;
      let s = 0;
      const ck = bytes[at + 0x1E] | (bytes[at + 0x1F] << 8), cc = bytes[at + 0x1C] | (bytes[at + 0x1D] << 8);
      if (((ck ^ cc) & 0xFFFF) === 0xFFFF) s += 4;
      const map = bytes[at + 0x15] & 0x0F;
      if (at === 0x7FC0 && (map & 1) === 0) s += 2;
      if (at === 0xFFC0 && (map & 1) === 1) s += 2;
      const reset = bytes[at + 0x3C] | (bytes[at + 0x3D] << 8);
      if (reset >= 0x8000) s += 2;
      for (let i = 0; i < 21; i++) { const c = bytes[at + i]; if (c >= 0x20 && c < 0x7F) s += 0.05; }
      return s;
    };
    const hi = score(0xFFC0) > score(0x7FC0);
    const at = hi ? 0xFFC0 : 0x7FC0;
    let title = ''; for (let i = 0; i < 21; i++) { const c = bytes[at + i]; title += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ' '; }
    const ramCode = bytes[at + 0x18];
    return { rom: bytes, hirom: hi, title: title.trim(), sramSize: ramCode ? (0x400 << ramCode) : 0 };
  }

  class SnesConsole {
    constructor(romBytes, opts) {
      opts = opts || {};
      this.cart = parseRom(romBytes);
      this.rom = this.cart.rom;
      this.romMask = 1; while (this.romMask < this.rom.length) this.romMask <<= 1; this.romMask -= 1;
      this.sram = new Uint8Array(Math.max(this.cart.sramSize, 0));
      this.wram = new Uint8Array(0x20000);
      this.ppu = new Emu.SnesPpu();
      this.apu = new SnesApu();
      this.ext = opts.ext || null; // $6000-$7FFF(バンク $00-$3F/$80-$BF)に挿さる機器: { read(a), write(a, v), tick?(clk) }
      // CPU は生成時にリセットベクタを読む(= advance が走る)ので、時計を先に置く
      this.clock = 0; this.hclk = 0; this.vline = 0; this.apuAcc = 0; this.lineStage = 0; this.irqMode = 0; this.hdmaEn = 0; this.fastRom = false; this.openBus = 0;
      this.cpu = new Emu.CPU65816(this);
      this.pad = [0, 0];          // パッド 1/2(16bit: B Y Sel Start ↑ ↓ ← → A X L R 0 0 0 0)
      this.dma = Array.from({ length: 8 }, () => ({ dmap: 0xFF, bbad: 0xFF, a1t: 0xFFFF, a1b: 0xFF, das: 0xFFFF, dasb: 0xFF, a2a: 0xFFFF, nltr: 0xFF, done: true, doXfer: false }));
      this.onFrame = null;
      this.onApuPort = null; // (port, value) APU ポート $2140-$2143 への書き込み(録音用)
      this.frameCount = 0;
      this.reset();
    }

    reset() {
      this.wram.fill(0x55);
      this.ppu.reset(); this.apu.reset();
      this.clock = 0; this.hclk = 0; this.vline = 0; this.apuAcc = 0;
      this.nmiEnable = false; this.irqMode = 0; this.autoJoy = false;
      this.nmiFlag = false; this.nmiPending = false; this.irqFlag = false; this.irqDone = false;
      this.htime = 0x1FF; this.vtime = 0x1FF;
      this.wrio = 0xFF; this.mpyA = 0xFF; this.rdmpy = 0; this.rddiv = 0; this.dividend = 0xFFFF;
      this.hdmaEn = 0; this.fastRom = false;
      this.joy = [0, 0, 0, 0]; this.joyStrobe = false; this.joyShift = [0, 0]; this.autoJoyBusyUntil = -1;
      this.wmAddr = 0;
      this.openBus = 0;
      this.lineStage = 0;
      this._frameFlag = false;
      for (const d of this.dma) { d.done = true; d.doXfer = false; }
      this.cpu.reset();
    }

    setController(port, bits) { this.pad[port & 1] = bits & 0xFFFF; }
    get frame() { return this.ppu.frame; }
    get frameWidth() { return 256; }
    get frameHeight() { return 224; }

    // ── 時間 ──
    // CPU の 1 サイクルが何マスタークロックか(番地で決まる)
    speed(addr) {
      const bank = addr >> 16, a = addr & 0xFFFF;
      if ((bank & 0x40) === 0) { // $00-$3F / $80-$BF
        if (a < 0x2000) return 8;
        if (a < 0x4000) return 6;
        if (a < 0x4200) return 12;
        if (a < 0x6000) return 6;
        if (a < 0x8000) return 8;
        return (bank & 0x80) && this.fastRom ? 6 : 8;
      }
      if (bank >= 0xC0) return this.fastRom ? 6 : 8;
      return 8;
    }
    // マスタークロックを進め、行の中の出来事(行頭、描画、HBlank、H/V タイマ)を起こす
    advance(clk) {
      this.clock += clk;
      this.apuAcc += clk * APU_RATIO;
      if (this.ext && this.ext.tick) this.ext.tick(clk);
      let h = (this.hclk += clk);
      for (;;) {
        if (this.lineStage === 0) { if (h < 2) break; this.lineStage = 1; this._lineStart(); }
        if (this.lineStage === 1) { if (h < 88) break; this.lineStage = 2; if (this.vline >= 1 && this.vline < VBLANK_LINE) this.ppu.renderLine(this.vline); }
        if (this.lineStage === 2) { if (h < 1112) break; this.lineStage = 3; if (this.vline < VBLANK_LINE && this.hdmaEn) this._hdmaRun(); }
        if (h < LINE_CLK) break;
        h = (this.hclk -= LINE_CLK);
        this.lineStage = 0; this.irqDone = false;
        if (++this.vline >= LINES) this.vline = 0;
      }
      // H/V タイマの IRQ: モード 1 = 毎行 HTIME、2 = VTIME の行頭、3 = VTIME の行の HTIME
      if (this.irqMode && !this.irqDone) {
        const vOk = this.irqMode === 1 || this.vline === this.vtime;
        const ht = this.irqMode === 2 ? 10 : this.htime * 4 + 14;
        if (vOk && this.hclk >= ht && ht < LINE_CLK) { this.irqDone = true; this.irqFlag = true; }
      }
    }
    _lineStart() {
      const v = this.vline;
      if (v === VBLANK_LINE) {
        this.nmiFlag = true;
        if (this.nmiEnable) this.nmiPending = true;
        this.ppu.vblank();
        if (this.autoJoy) { this.joy[0] = this.pad[0]; this.joy[1] = this.pad[1]; this.joy[2] = 0; this.joy[3] = 0; this.autoJoyBusyUntil = this.clock + 4224; }
        this.syncApu();
        this.frameCount++; this._frameFlag = true;
        if (this.onFrame) this.onFrame();
      } else if (v === 0) {
        this.nmiFlag = false;
        if (this.hdmaEn) this._hdmaInit();
      }
    }
    syncApu() {
      const n = Math.floor(this.apuAcc);
      if (n > 0) this.apuAcc -= this.apu.run(n);
    }

    // ── バス(CPU から)──
    read(addr) { this.advance(this.speed(addr)); const v = this.peek(addr); this.openBus = v; return v; }
    write(addr, v) { this.advance(this.speed(addr)); this.openBus = v; this.poke(addr, v); }
    idle() { this.advance(6); }

    _romAddr(bank, a) { return this.cart.hirom ? (((bank & 0x3F) << 16) | a) : (((bank & 0x7F) << 15) | (a & 0x7FFF)); }
    peek(addr) {
      const bank = addr >> 16, a = addr & 0xFFFF;
      if (bank === 0x7E || bank === 0x7F) return this.wram[addr & 0x1FFFF];
      if ((bank & 0x40) === 0) {
        if (a < 0x2000) return this.wram[a];
        if (a < 0x6000) return this._ioRead(a);
        if (a < 0x8000) {
          if (this.ext) return this.ext.read(a);
          if (this.cart.hirom && this.sram.length && (bank & 0x3F) >= 0x20) return this.sram[(((bank & 0x1F) << 13) | (a & 0x1FFF)) % this.sram.length];
          return this.openBus;
        }
        return this.rom[this._romAddr(bank, a) & this.romMask] | 0;
      }
      // $40-$7D / $C0-$FF
      if (!this.cart.hirom && (bank & 0x7F) >= 0x70 && a < 0x8000) return this.sram.length ? this.sram[((((bank & 0x7F) - 0x70) << 15) | a) % this.sram.length] : this.openBus;
      return this.rom[this._romAddr(bank, a) & this.romMask] | 0;
    }
    poke(addr, v) {
      const bank = addr >> 16, a = addr & 0xFFFF;
      if (bank === 0x7E || bank === 0x7F) { this.wram[addr & 0x1FFFF] = v; return; }
      if ((bank & 0x40) === 0) {
        if (a < 0x2000) { this.wram[a] = v; return; }
        if (a < 0x6000) { this._ioWrite(a, v); return; }
        if (a < 0x8000) {
          if (this.ext) this.ext.write(a, v);
          else if (this.cart.hirom && this.sram.length && (bank & 0x3F) >= 0x20) this.sram[(((bank & 0x1F) << 13) | (a & 0x1FFF)) % this.sram.length] = v;
        }
        return;
      }
      if (!this.cart.hirom && (bank & 0x7F) >= 0x70 && a < 0x8000 && this.sram.length) this.sram[((((bank & 0x7F) - 0x70) << 15) | a) % this.sram.length] = v;
    }

    _ioRead(a) {
      if (a >= 0x2100 && a < 0x2140) {
        if (a === 0x2137) { if (this.wrio & 0x80) this.ppu.latchCounters((this.hclk >> 2) & 0x1FF, this.vline); return this.openBus; }
        return this.ppu.read(a - 0x2100);
      }
      if (a >= 0x2140 && a < 0x2180) { this.syncApu(); return this.apu.out[a & 3]; }
      if (a === 0x2180) { const v = this.wram[this.wmAddr]; this.wmAddr = (this.wmAddr + 1) & 0x1FFFF; return v; }
      if (a === 0x4016 || a === 0x4017) { // 直列読み(B から 1 ビットずつ)。読み切ると 1
        const p = a & 1;
        if (this.joyStrobe) return (this.openBus & 0xFC) | ((this.pad[p] >> 15) & 1);
        const bit = (this.joyShift[p] >> 15) & 1;
        this.joyShift[p] = ((this.joyShift[p] << 1) | 1) & 0xFFFF;
        return (this.openBus & 0xFC) | bit | (p ? 0x1C : 0);
      }
      if (a >= 0x4300 && a < 0x4380) {
        const d = this.dma[(a >> 4) & 7];
        switch (a & 0x0F) {
          case 0x0: return d.dmap; case 0x1: return d.bbad;
          case 0x2: return d.a1t & 0xFF; case 0x3: return d.a1t >> 8; case 0x4: return d.a1b;
          case 0x5: return d.das & 0xFF; case 0x6: return d.das >> 8; case 0x7: return d.dasb;
          case 0x8: return d.a2a & 0xFF; case 0x9: return d.a2a >> 8; case 0xA: return d.nltr;
        }
        return this.openBus;
      }
      switch (a) {
        case 0x4210: { const v = (this.nmiFlag ? 0x80 : 0) | 0x02 | (this.openBus & 0x70); this.nmiFlag = false; return v; }
        case 0x4211: { const v = (this.irqFlag ? 0x80 : 0) | (this.openBus & 0x7F); this.irqFlag = false; return v; }
        case 0x4212: return (this.vline >= VBLANK_LINE ? 0x80 : 0) | (this.hclk < 4 || this.hclk >= 1096 ? 0x40 : 0) | (this.clock < this.autoJoyBusyUntil ? 1 : 0) | (this.openBus & 0x3E);
        case 0x4213: return this.wrio;
        case 0x4214: return this.rddiv & 0xFF; case 0x4215: return this.rddiv >> 8;
        case 0x4216: return this.rdmpy & 0xFF; case 0x4217: return this.rdmpy >> 8;
        case 0x4218: case 0x421A: case 0x421C: case 0x421E: return this.joy[(a - 0x4218) >> 1] & 0xFF;
        case 0x4219: case 0x421B: case 0x421D: case 0x421F: return this.joy[(a - 0x4218) >> 1] >> 8;
      }
      return this.openBus;
    }
    _ioWrite(a, v) {
      if (a >= 0x2100 && a < 0x2140) { this.ppu.write(a - 0x2100, v); return; }
      if (a >= 0x2140 && a < 0x2180) { this.syncApu(); this.apu.in[a & 3] = v; if (this.onApuPort) this.onApuPort(a & 3, v); return; }
      if (a >= 0x2180 && a < 0x2184) {
        if (a === 0x2180) { this.wram[this.wmAddr] = v; this.wmAddr = (this.wmAddr + 1) & 0x1FFFF; }
        else if (a === 0x2181) this.wmAddr = (this.wmAddr & 0x1FF00) | v;
        else if (a === 0x2182) this.wmAddr = (this.wmAddr & 0x100FF) | (v << 8);
        else this.wmAddr = (this.wmAddr & 0x0FFFF) | ((v & 1) << 16);
        return;
      }
      if (a === 0x4016) { const was = this.joyStrobe; this.joyStrobe = (v & 1) !== 0; if (was && !this.joyStrobe) { this.joyShift[0] = this.pad[0]; this.joyShift[1] = this.pad[1]; } return; }
      if (a >= 0x4300 && a < 0x4380) {
        const d = this.dma[(a >> 4) & 7];
        switch (a & 0x0F) {
          case 0x0: d.dmap = v; break; case 0x1: d.bbad = v; break;
          case 0x2: d.a1t = (d.a1t & 0xFF00) | v; break; case 0x3: d.a1t = (d.a1t & 0xFF) | (v << 8); break; case 0x4: d.a1b = v; break;
          case 0x5: d.das = (d.das & 0xFF00) | v; break; case 0x6: d.das = (d.das & 0xFF) | (v << 8); break; case 0x7: d.dasb = v; break;
          case 0x8: d.a2a = (d.a2a & 0xFF00) | v; break; case 0x9: d.a2a = (d.a2a & 0xFF) | (v << 8); break; case 0xA: d.nltr = v; break;
        }
        return;
      }
      switch (a) {
        case 0x4200: {
          const was = this.nmiEnable;
          this.nmiEnable = (v & 0x80) !== 0; this.irqMode = (v >> 4) & 3; this.autoJoy = (v & 1) !== 0;
          if (!was && this.nmiEnable && this.nmiFlag) this.nmiPending = true; // VBlank の最中に許可すると、その場で入る
          if (!this.irqMode) this.irqFlag = false;
          break;
        }
        case 0x4201: if ((this.wrio & 0x80) && !(v & 0x80)) this.ppu.latchCounters((this.hclk >> 2) & 0x1FF, this.vline); this.wrio = v; break;
        case 0x4202: this.mpyA = v; break;
        case 0x4203: this.rdmpy = this.mpyA * v; break;
        case 0x4204: this.dividend = (this.dividend & 0xFF00) | v; break;
        case 0x4205: this.dividend = (this.dividend & 0xFF) | (v << 8); break;
        case 0x4206: if (v) { this.rddiv = (this.dividend / v) | 0; this.rdmpy = this.dividend % v; } else { this.rddiv = 0xFFFF; this.rdmpy = this.dividend; } break;
        case 0x4207: this.htime = (this.htime & 0x100) | v; break;
        case 0x4208: this.htime = (this.htime & 0xFF) | ((v & 1) << 8); break;
        case 0x4209: this.vtime = (this.vtime & 0x100) | v; break;
        case 0x420A: this.vtime = (this.vtime & 0xFF) | ((v & 1) << 8); break;
        case 0x420B: if (v) this._dmaRun(v); break;
        case 0x420C: this.hdmaEn = v; break;
        case 0x420D: this.fastRom = (v & 1) !== 0; break;
      }
    }

    // ── DMA ──
    _bRead(reg) { return this._ioRead(0x2100 | reg); }
    _bWrite(reg, v) { this._ioWrite(0x2100 | reg, v); }
    _dmaRun(mask) {
      this.advance(8);
      for (let ch = 0; ch < 8; ch++) {
        if (!(mask & (1 << ch))) continue;
        const d = this.dma[ch], pat = DMA_PATTERN[d.dmap & 7], toA = (d.dmap & 0x80) !== 0;
        const step = (d.dmap & 0x08) ? 0 : (d.dmap & 0x10) ? -1 : 1;
        this.advance(8);
        let i = 0;
        do {
          const aaddr = (d.a1b << 16) | d.a1t, breg = (d.bbad + pat[i % pat.length]) & 0xFF;
          if (toA) this.poke(aaddr, this._bRead(breg)); else this._bWrite(breg, this.peek(aaddr));
          d.a1t = (d.a1t + step) & 0xFFFF;
          d.das = (d.das - 1) & 0xFFFF;
          i++;
          this.advance(8);
        } while (d.das !== 0);
      }
    }
    // HDMA: フレームの頭で表を読み始め、行ごとの HBlank で決まったバイト数を B バスへ書く
    _hdmaLoad(d) {
      d.nltr = this.peek((d.a1b << 16) | d.a2a); d.a2a = (d.a2a + 1) & 0xFFFF;
      if (d.nltr === 0) { d.done = true; return; }
      if (d.dmap & 0x40) { // 間接: 表にはデータの番地が入っている
        const lo = this.peek((d.a1b << 16) | d.a2a), hi = this.peek((d.a1b << 16) | ((d.a2a + 1) & 0xFFFF));
        d.a2a = (d.a2a + 2) & 0xFFFF; d.das = lo | (hi << 8);
      }
      d.doXfer = true;
    }
    _hdmaInit() {
      for (let ch = 0; ch < 8; ch++) {
        const d = this.dma[ch];
        if (!(this.hdmaEn & (1 << ch))) { d.done = true; continue; }
        d.done = false; d.a2a = d.a1t;
        this._hdmaLoad(d);
      }
    }
    _hdmaRun() {
      for (let ch = 0; ch < 8; ch++) {
        const d = this.dma[ch];
        if (!(this.hdmaEn & (1 << ch)) || d.done) continue;
        if (d.doXfer) {
          const pat = DMA_PATTERN[d.dmap & 7], ind = (d.dmap & 0x40) !== 0;
          for (let i = 0; i < pat.length; i++) {
            let v;
            if (ind) { v = this.peek((d.dasb << 16) | d.das); d.das = (d.das + 1) & 0xFFFF; }
            else { v = this.peek((d.a1b << 16) | d.a2a); d.a2a = (d.a2a + 1) & 0xFFFF; }
            this._bWrite((d.bbad + pat[i]) & 0xFF, v);
          }
        }
        d.nltr = (d.nltr - 1) & 0xFF;
        d.doXfer = (d.nltr & 0x80) !== 0;
        if ((d.nltr & 0x7F) === 0) this._hdmaLoad(d);
      }
    }

    // ── 実行 ──
    step() {
      const cpu = this.cpu;
      if (this.nmiPending) { this.nmiPending = false; cpu.nmi(); return; }
      if (this.irqFlag && this.irqMode) {
        if (!(cpu.p & 0x04)) { cpu.irq(); return; }
        if (cpu.waiting) cpu.waiting = false; // I が立っていても WAI は抜ける
      }
      cpu.step();
    }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag && ++guard < 400000) this.step();
      this.syncApu();
    }
  }

  SnesConsole.BUTTON = { B: 0x8000, Y: 0x4000, SELECT: 0x2000, START: 0x1000, UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100, A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010 };
  Emu.SnesConsole = SnesConsole;
  Emu.SnesApu = SnesApu;
  Emu.parseSnesRom = parseRom;
})(typeof window !== 'undefined' ? window : globalThis);
