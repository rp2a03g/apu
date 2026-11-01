/*
 * NES 本体 (MML.Emu.NesConsole) — CPU(cpu6502.js)/PPU(nes/ppu.js)/APU(apu2a03.js)/マッパー(nes/mappers.js)/
 * 入力の結線と、フレーム/サンプル単位の実行。DOM に依存しない(ヘッドレス tools/headless/nes-run.js、
 * AudioWorklet の中 src/audio/nes-worklet-impl.js、主スレッド src/ui/nesScreen.js のどこでも同じ物が動く)。
 *
 * - 1 命令ごとに消費サイクルぶん APU を進め、PPU を 3 ドットずつ進める。命令のメモリアクセスは最後のサイクルで
 *   起きる近似(基本サイクル数-1 だけ先に周辺を進めてから実行)。$2002 の vblank 待ちやスプライト 0 待ちは、
 *   読みの瞬間とフラグが立つ瞬間の前後関係で結果が変わるため(命令をまるごと先に実行すると NMI ハンドラが
 *   先にフラグを消す側に必ず負けて永久に待つ。実測で踏んだ)。
 * - NMI は PPU の線(vblank フラグ ∧ $2000 bit7)の立ち上がりを命令境界で拾う。IRQ は APU のフレーム/DMC と
 *   マッパー(MMC3/MMC5/N163/VRC6/VRC7/5B)の線の論理和を、I フラグが下りていれば命令境界で受ける。
 * - $4014 OAM DMA は 256 バイトを即座に写し、513/514 サイクルを次の命令に乗せる。
 * - 音: setSampleRate(sr) を呼ぶと周辺を進める中で APU(+拡張音源)の混合をリングバッファへ標本化する。
 *   runFrame() は 1 フレームぶんを返し、runSamples(out) は out.length サンプルぶんだけ進める(AudioWorklet 用)。
 * - 入力: setController(port, bits)。bits は A=1 B=2 Select=4 Start=8 Up=16 Down=32 Left=64 Right=128。
 * - 録音(段階 6b): startRecording() → 以後、音源レジスタの書き込み(2A03/FDS/拡張音源)・N163 $4800 の読み飛ばし・
 *   DPCM の起動(サンプル本体つき)を rec.cur に積み、フレームが終わるたび rec.frames へ移す。書き込みの形は
 *   src/vgm/vgmRecord.js の encodeNesRecording が受ける物({addr,value,t,read?} / {dmc:{addr,data}})。
 *   開始時には今のレジスタ像(2A03 の影 $4000-$4017、拡張音源はマッパーの audioImage())を書き込みとして先頭に置く
 *   (録音は曲の途中から始まるので、鳴っている音の状態が無いと再生側で復元できない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK = 1789773;
  const SAMPLES_PER_FRAME = 735;
  const AUDIO_RING = 1 << 14;

  class NesConsole {
    // opts.bios: FDS の BIOS(disksys.rom、8K)。.fds を開くときだけ要る
    constructor(romBytes, opts) {
      opts = opts || {};
      if (!(romBytes instanceof Uint8Array)) romBytes = new Uint8Array(romBytes);
      if (Emu.FdsDisk && Emu.FdsDisk.isFds(romBytes)) {
        this.rom = Emu.FdsDisk.parse(romBytes);
        this.mapper = new Emu.FdsDisk.Mapper(this.rom, opts.bios);
      } else {
        this.rom = Emu.INES.parse(romBytes);
        this.mapper = Emu.NesMappers.create(this.rom);
      }
      this.ppu = new Emu.PPU(this.mapper);
      this.apu = new Emu.APU2A03(this);
      this.cpu = new Emu.CPU6502(this);
      this.ram = new Uint8Array(0x800);
      this.apuShadow = new Uint8Array(0x18); // $4000-$4017 の最後の書き込み値(録音開始時の像)
      this.openBus = 0;
      this.pad = [0, 0]; this.padShift = [0, 0]; this.padStrobe = false;
      this.dmaCycles = 0;
      this.prevNmi = false; this.pendingNmi = false; this.nmiNext = false;
      this.cpuCycles = 0;
      this.frameCount = 0;
      this._frameFlag = false;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0;
      this.underruns = 0;
      this.onWrite = null;   // (addr, value, frameFrac) 音源レジスタの書き込み(ライブ表示など)
      this.onFrame = null;   // () フレームが描き終わるたび(AudioWorklet が画面を送るのに使う)
      this.rec = null;       // 録音中 { frames: [[write...]], cur: [write...] }
      this.reset();
    }

    reset() {
      this.ram.fill(0);
      this.ppu.reset();
      this.apu.reset();
      this.apuShadow.fill(0);
      this.apu.writeRegister(0x4017, 0x00);
      this.apu.writeRegister(0x4015, 0x00);
      this.cpu.reset();
      this.cpu.PC = this.read(0xFFFC) | (this.read(0xFFFD) << 8);
      this.prevNmi = false; this.pendingNmi = false; this.nmiNext = false; this.dmaCycles = 0;
      this.cpuCycles = 0;
    }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; }
    setController(port, bits) { this.pad[port & 1] = bits & 0xFF; }
    // FDS のディスク(面)。.fds 以外では 0 面
    get diskCount() { return this.mapper.sides ? this.mapper.sides.length : 0; }
    get diskNumber() { return this.mapper.sides ? this.mapper.diskNumber : -1; }
    insertDisk(n) { if (this.mapper.insertDisk) this.mapper.insertDisk(n); }
    ejectDisk() { if (this.mapper.ejectDisk) this.mapper.ejectDisk(); }
    // NSF ヘッダと同じ拡張音源ビット(録音の NESX ヘッダ用)
    extBits() { return this.mapper.audio ? (this.mapper.extBits || 0) : 0; }
    // フレーム内の時刻(0〜1)。PPU の位置から出す(書き込みの t と録音の精度はこれ)
    frameFrac() { return (((this.ppu.scanline + 262 - 241) % 262) * 341 + this.ppu.dot) / (262 * 341); } // vblank の頭を 0 とする

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
      else {
        v = this.mapper.cpuRead(addr);
        if (v < 0) v = this.openBus;
        // N163 $4800 の読み出しは内部ポインタを進める副作用がある(録音には読み飛ばしとして載せる)
        else if (this.rec && addr >= 0x4800) { const ra = this.mapper.audioReadAddr(addr); if (ra >= 0) this.rec.cur.push({ addr: ra, value: 0, read: true, t: this._t() }); }
      }
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
      if (addr < 0x4018) {
        this.apuShadow[addr - 0x4000] = v;
        // DPCM の起動: 再生側が同じサンプルを持てるよう、$4012/$4013 が指す本体をこの瞬間の CPU 空間から写す
        if (addr === 0x4015 && (v & 0x10) && this.rec) this.rec.cur.push({ dmc: this.dmcSample() });
        this.apu.writeRegister(addr, v);
        this._logWrite(addr, v);
        return;
      }
      this.mapper.cpuWrite(addr, v);
      if (this.mapper.audio) { const aa = this.mapper.audioAddr(addr); if (aa >= 0) this._logWrite(aa, v); } // 正規の番地で記録(VRC6b の A0/A1 入れ替えなど)
    }
    _t() { return Math.min(SAMPLES_PER_FRAME - 1, Math.floor(this.frameFrac() * SAMPLES_PER_FRAME)); }
    _logWrite(addr, v) {
      if (this.rec) this.rec.cur.push({ addr, value: v, t: this._t() });
      if (this.onWrite) this.onWrite(addr, v, this.frameFrac());
    }
    // 今の $4012/$4013 が指す DPCM サンプル本体(CPU アドレスと中身)。$FFFF を越えたら $8000 へ折り返す
    dmcSample() {
      const addr = 0xC000 + this.apuShadow[0x12] * 64;
      const len = this.apuShadow[0x13] * 16 + 1;
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        let a = addr + i;
        if (a > 0xFFFF) a = 0x8000 + (a - 0x10000);
        const b = this.mapper.cpuRead(a);
        data[i] = b < 0 ? 0 : b;
      }
      return { addr, data };
    }

    // ── 録音 ──
    startRecording() {
      const cur = [];
      // 今のレジスタ像を先頭に置く(2A03: $4000-$4013, $4015, $4017。$4015 は DPCM 起動なら本体つき)
      for (let r = 0; r < 0x14; r++) cur.push({ addr: 0x4000 + r, value: this.apuShadow[r], t: 0 });
      if (this.apuShadow[0x15] & 0x10) cur.push({ dmc: this.dmcSample() });
      cur.push({ addr: 0x4015, value: this.apuShadow[0x15], t: 0 });
      cur.push({ addr: 0x4017, value: this.apuShadow[0x17], t: 0 });
      // 拡張音源の像(マッパーが影レジスタから作る。N163 は内部 RAM 128 バイト、VRC7/5B はレジスタ番号と値の対)
      if (this.mapper.audio) for (const w of this.mapper.audioImage()) cur.push({ addr: w.addr, value: w.value, t: 0 });
      this.rec = { frames: [], cur };
    }
    // 録音を終えて、フレームごとの書き込み列を返す(最後の途中フレームも含む)
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) rec.frames.push(rec.cur);
      return rec.frames;
    }

    // ── 実行 ──
    // 1 命令(+割り込み)を実行し、消費サイクルぶん周辺を進める。
    // 命令のメモリアクセスは最後のサイクルで起きる: 基本サイクル数ぶん周辺を先に進めてから実行し、
    // ページ跨ぎ/分岐成立の追加サイクルは後ろに付ける(読み出しは実機の φ2 より最大 1 ドット遅いだけ)。
    // NMI の縁は 6502 の規則どおり「命令の最後のサイクルより前に立てばこの命令の後、最後のサイクル
    // (と追加サイクル)で立てば次の命令の後」。$2002 を回して vblank を待つループ(LDA $2002 / BPL)は
    // この 1 命令の遅れで読みが勝ち、NMI ハンドラがフラグを消す前に抜けられる(実機・Mesen と同じ挙動。
    // 抜けられないと 1 フレーム待ち直す=ゲームが 1 フレーム遅れる。実測で 3 フレーム差になった)
    step() {
      const cpu = this.cpu, ppu = this.ppu, apu = this.apu, mapper = this.mapper;
      let cycles;
      if (this.pendingNmi) { this.pendingNmi = false; cycles = cpu.nmi(); this.advance(cycles); this._nmiEdge(ppu.nmiLine(), false); return cycles; }
      if (this.nmiNext) { this.pendingNmi = true; this.nmiNext = false; }
      if (!cpu.irqInhibited() && (apu.frameIrqFlag || apu.dmc.irqFlag || mapper.irqPending())) {
        cycles = cpu.irq(); this.advance(cycles); this._nmiEdge(ppu.nmiLine(), false); return cycles;
      }
      const base = cpu.peekCycles();
      if (base > 1) this.advance(base - 1);
      this._nmiEdge(ppu.nmiLine(), false);   // 最後のサイクルより前の縁 → この命令の後
      this.advance(1);
      this._nmiEdge(ppu.nmiLine(), true);    // 最後のサイクルの縁 → 次の命令の後
      cycles = cpu.step() - base;            // 追加サイクル(ページ跨ぎ・分岐成立)
      cycles += this.dmaCycles; this.dmaCycles = 0;
      if (cycles > 0) { this.advance(cycles); this._nmiEdge(ppu.nmiLine(), true); }
      return base + cycles;
    }
    _nmiEdge(line, late) {
      if (line && !this.prevNmi) { if (late) this.nmiNext = true; else this.pendingNmi = true; }
      this.prevNmi = line;
    }

    // 周辺(APU/拡張音源/PPU/音の標本化/マッパーの IRQ カウンタ)を cycles サイクルぶん進める
    advance(cycles) {
      const ppu = this.ppu, apu = this.apu, mapper = this.mapper;
      this.cpuCycles += cycles;
      mapper.cpuClock(cycles); // ★命令前の先行分にも掛ける(片側だけだと N163 の IRQ カウンタが 1/3 の速さになる。実測)
      const audio = mapper.audio;
      const sr = this.sampleRate;
      for (let c = 0; c < cycles; c++) {
        apu.clock();
        if (audio) audio.clock();
        ppu.step(); ppu.step(); ppu.step();
        // フレームの区切りは vblank の頭(241 行目)。画面はここで描き上がっているし、録音のフレーム分けが Mesen の
        // endFrame(同じく vblank の頭)と揃う(NMI で書く音源ドライバの書き込みが同じフレームに入る。区切りを
        // 261 行目の末尾にすると NMI の書き込みがフレームの末尾 92% の位置になり、Mesen 録音と 1 フレームずれた)
        if (ppu.vblankStarted) { ppu.vblankStarted = false; this.frameCount++; this._frameEnd(); }
        if (sr) {
          this.cycleAccum += sr;
          if (this.cycleAccum >= CPU_CLOCK) {
            this.cycleAccum -= CPU_CLOCK;
            if (this.ringLen < AUDIO_RING) {
              let s = apu.mixSample();
              if (audio) s += audio.mixSample();
              this.ring[(this.ringHead + this.ringLen) & (AUDIO_RING - 1)] = s;
              this.ringLen++;
            }
          }
        }
      }
    }
    _frameEnd() {
      this._frameFlag = true;
      if (this.rec) { this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      if (this.onFrame) this.onFrame();
    }

    // PPU が 1 フレームを描き終えるまで回す。音を有効にしていればそのフレームのサンプル列を返す
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) {
        this.step();
        if (++guard > 200000) break; // 暴走の保険(1 フレームは約 29780 サイクル = 命令 1 万前後)
      }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    // out.length サンプルぶん進めて out に書く(AudioWorklet の process)。setSampleRate が要る
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.step();
      if (this.ringLen < n) this.underruns++; // 間に合わなかった(音切れ)。AudioWorklet の process が時間内に終われなかった印
      this.takeAudioInto(out, n);
    }
    takeAudio(n) {
      const out = new Float32Array(n);
      this.takeAudioInto(out, n);
      return out;
    }
    takeAudioInto(out, n) {
      const take = Math.min(n, this.ringLen);
      for (let i = 0; i < take; i++) out[i] = this.ring[(this.ringHead + i) & (AUDIO_RING - 1)];
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & (AUDIO_RING - 1);
      this.ringLen -= take;
    }

    get frame() { return this.ppu.frame; }
  }

  NesConsole.CPU_CLOCK = CPU_CLOCK;
  NesConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.NesConsole = NesConsole;
})(typeof window !== 'undefined' ? window : globalThis);
