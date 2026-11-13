/*
 * ゲームボーイ本体(段階 8a: DMG の骨格)
 * MML.Emu.GbConsole
 *
 * CPU(cpuSm83.js)がバスに触るたび(1 M サイクル)に tick() で本体を 4T 進める。進むのは
 * タイマ(DIV/TIMA)、シリアル、OAM DMA、PPU、APU、音の標本化。NesConsole/MsxConsole と同じ形の API を持つ
 * (runFrame / runSamples / setController / startRecording / getBattery …)。
 *
 * まだ無い物(DESIGN-GB-CAPTURE.md §9): PPU は行単位(8c)、
 * CGB(8d)、周辺と残りの MBC(8e)、SGB(8g)。ブート ROM は使わず起動後の状態を直接セットする。
 *
 * 参考: Pan Docs "Timer obscure behaviour" "Interrupts" "Power-Up Sequence"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CLOCK = 4194304;
  const FRAME_T = 70224; // 154 行 × 456T(59.7275Hz)
  const AUDIO_RING = 1 << 14;
  // TAC の下位 2bit → TIMA を進める DIV(16bit)のビット。そのビットと許可の AND の立ち下がりで +1
  const TAC_BIT = [1 << 9, 1 << 3, 1 << 5, 1 << 7];
  const SERIAL_BIT = 1 << 8; // 内部クロック 8192Hz = DIV bit8 の立ち下がり
  const APU_BIT = 1 << 12;   // APU のフレームシーケンサ 512Hz = DIV bit12 の立ち下がり(CGB の倍速時は bit13)

  class GbConsole {
    // opts.model: 'dmg'(既定)。'cgb' / 'sgb' は後の段階
    constructor(romBytes, opts) {
      opts = opts || {};
      this.model = opts.model || 'dmg';
      // opts.cart: 出来合いのカートリッジを挿す(GBS プレイヤーが使う)。opts.lcdAlwaysOn / opts.noRender も GBS 用
      this.cart = opts.cart || new Emu.GbCart(romBytes);
      this.lcdAlwaysOn = !!opts.lcdAlwaysOn;
      this.ppu = new Emu.GbPpu(this);
      this.ppu.noRender = !!opts.noRender;
      this.apu = new Emu.APUGb(this.model === 'cgb' ? 'cgb' : 'dmg');
      this.apu.externalSeq = true;
      this.apu.divBit = () => (this.div & APU_BIT) !== 0;
      this.cpu = new Emu.CPUSm83(this);
      this.wram = new Uint8Array(0x2000);
      this.hram = new Uint8Array(0x7F);
      this.pad = 0; this.padHeld = 0; this.padTurbo = 0; this.turboRate = 2; this.turboPhase = 0;
      this.cpuCycles = 0; this.frameCount = 0; this.frameT = 0; this._frameFlag = false;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringR = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0; this.underruns = 0;
      this.onWrite = null;  // (addr, value, frameFrac) 音源レジスタの書き込み
      this.onFrame = null;
      this.onSerial = null; // (byte) シリアルへ 1 バイト送り終えた(テスト ROM の結果表示など)
      this.serialDevice = null; // (byte) => 受け取るバイト。未接続は $FF
      this.serialOut = [];  // 送り終えたバイト
      this.serialSent = []; // 送り始めたバイト(完了を待たずに次を送るソフトの出力も拾える。mooneye のテスト ROM の合否)
      this.rec = null;
      this.reset();
    }

    // 電源投入+ブート ROM 実行後の状態(DMG)
    reset() {
      this.wram.fill(0); this.hram.fill(0);
      this.cart.reset(); this.ppu.reset(); this.apu.reset();
      const cpu = this.cpu;
      cpu.reset();
      cpu.a = 0x01; cpu.f = 0xB0; cpu.b = 0x00; cpu.c = 0x13; cpu.d = 0x00; cpu.e = 0xD8; cpu.h = 0x01; cpu.l = 0x4D;
      cpu.sp = 0xFFFE; cpu.pc = 0x0100;
      this.ie = 0; this.if = 0x01;
      this.div = 0xABC8; this.tima = 0; this.tma = 0; this.tac = 0; this.timaReload = false; this.timaReloading = false;
      this.p1 = 0x00; this.sb = 0; this.sc = 0; this.serialBits = 0;
      this.dma = 0xFF; this.dmaActive = false; this.dmaPos = 0; this.dmaSrc = 0; this.dmaStart = 0; this.dmaNext = 0; this.dmaByte = 0xFF;
      // ブート ROM が「ポーン」を鳴らした後のレジスタ。CH1 は鳴り終わりかけで有効のまま(NR52=$F1)。
      // 残響の音量は分からないので 0 にしておく(起動直後に余韻は鳴らさない)
      const apu = this.apu;
      for (const [a, v] of [[0xFF26, 0x80], [0xFF10, 0x80], [0xFF11, 0xBF], [0xFF12, 0xF3], [0xFF13, 0xC1], [0xFF14, 0x87], [0xFF16, 0x3F], [0xFF18, 0xFF],
        [0xFF1A, 0x7F], [0xFF1B, 0xFF], [0xFF1C, 0x9F], [0xFF1D, 0xFF], [0xFF20, 0xFF], [0xFF24, 0x77], [0xFF25, 0xF3]]) apu.writeRegister(a, v);
      apu.ch1.envelope.volume = 0; apu.ch1.envelope.running = false;
      apu.regRaw[0x03] = 0xFF; apu.ch1.triggerSeq = 0;
      this.cpuCycles = 0; this.frameT = 0;
    }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; if (sr) this.apu.setSampleRate(sr); }
    // ボタンのビットは NesConsole.BUTTON と同じ並び(A B SELECT START UP DOWN LEFT RIGHT)。画面側の入力をそのまま使える
    setController(port, bits, turbo) { if (port) return; this.padHeld = bits & 0xFF; this.padTurbo = (turbo | 0) & 0xFF; this._applyPad(); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(); }
    _applyPad() {
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      const before = this._p1Low();
      this.pad = this.padHeld | (on ? this.padTurbo : 0);
      if (before & ~this._p1Low() & 0x0F) this.requestIrq(4); // 選ばれている線が H→L
    }
    // P1 の下位 4bit(押すと 0)。bit4=0 で十字(右左上下)、bit5=0 でボタン(A B SELECT START)
    _p1Low() {
      const p = this.pad;
      let low = 0x0F;
      if (!(this.p1 & 0x10)) low &= ~(((p >> 7) & 1) | (((p >> 6) & 1) << 1) | (((p >> 4) & 1) << 2) | (((p >> 5) & 1) << 3));
      if (!(this.p1 & 0x20)) low &= ~(p & 0x0F);
      return low & 0x0F;
    }

    get hasBattery() { return this.cart.hasBattery; }
    get batteryDirty() { return this.cart.dirty; }
    clearBatteryDirty() { this.cart.dirty = false; }
    getBattery() { return this.cart.getBattery(); }
    setBattery(bytes) { return this.cart.setBattery(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    get frame() { return this.ppu.frame; }
    get frameWidth() { return 160; }
    get frameHeight() { return 144; }
    frameFrac() { return Math.min(0.999999, this.frameT / FRAME_T); }

    // ── 割り込み(CPU から呼ばれる)──
    requestIrq(bit) { this.if |= 1 << bit; }
    irqPending() { return this.ie & this.if & 0x1F; }
    irqAck(bit) { this.if &= ~(1 << bit); }
    // STOP: DMG はボタンが押されるまで止まる(CGB の速度切り替えは 8d)
    stop(cpu) { cpu.stopped = true; }

    // ── 4T 進める ──
    tick() {
      this.cpuCycles += 4;
      // TIMA があふれた 1 M サイクル後に TMA を読み込んで割り込む(その間 TIMA は 0)
      this.timaReloading = false;
      if (this.timaReload) { this.timaReload = false; this.timaReloading = true; this.tima = this.tma; this.if |= 4; }
      this._setDiv((this.div + 4) & 0xFFFF);

      // OAM DMA: $FF46 に書いた M サイクルの 2 つ後から 160 サイクル、1 サイクルに 1 バイト。
      // 走っている最中に書き直すと、古い方は新しい方が始まる直前まで続く
      if (this.dmaActive && this.dmaPos >= 0xA0) this.dmaActive = false;
      if (this.dmaStart > 0 && --this.dmaStart === 0) { this.dmaActive = true; this.dmaPos = 0; this.dmaSrc = this.dmaNext; }
      if (this.dmaActive) {
        this.dmaByte = this._busRead((this.dmaSrc + this.dmaPos) & 0xFFFF);
        this.ppu.oam[this.dmaPos++] = this.dmaByte;
      }

      const ppu = this.ppu;
      ppu.tick();
      const apu = this.apu;
      apu.advance(4);

      this.frameT += 4;
      // フレームの区切りは VBlank の頭。LCD が消えている間は 70224T ごとに刻む(音と録音の時間を止めない)
      if (ppu.vblankStarted) { ppu.vblankStarted = false; this._frameEnd(); }
      else if (this.frameT >= FRAME_T && !ppu.on) this._frameEnd();

      const sr = this.sampleRate;
      if (sr) {
        this.cycleAccum += sr * 4;
        if (this.cycleAccum >= CLOCK) {
          this.cycleAccum -= CLOCK;
          if (this.ringLen < AUDIO_RING) {
            const s = apu.mixSample();
            const i = (this.ringHead + this.ringLen) & (AUDIO_RING - 1);
            this.ring[i] = s.left; this.ringR[i] = s.right;
            this.ringLen++;
          }
        }
      }
    }

    // DIV(16bit)を書き換える。TIMA とシリアルは DIV のビットの立ち下がりで進むので、DIV への書き込み(0 に戻る)でも進み得る
    _setDiv(nv) {
      const old = this.div;
      this.div = nv;
      if (this.tac & 4) { const b = TAC_BIT[this.tac & 3]; if ((old & b) && !(nv & b)) this._incTima(); }
      if ((old & APU_BIT) && !(nv & APU_BIT)) this.apu.seqTick();
      if (this.serialBits && (old & SERIAL_BIT) && !(nv & SERIAL_BIT)) {
        if (--this.serialBits === 0) {
          const out = this.sb;
          this.sb = this.serialDevice ? (this.serialDevice(out) & 0xFF) : 0xFF;
          this.sc &= 0x7F; this.if |= 8;
          this.serialOut.push(out);
          if (this.onSerial) this.onSerial(out);
        }
      }
    }
    _incTima() {
      this.tima = (this.tima + 1) & 0xFF;
      if (this.tima === 0) this.timaReload = true;
    }

    _frameEnd() {
      this.cart.tickRtc(this.frameT, CLOCK);
      this.frameCount++;
      this._frameFlag = true;
      if (this.padTurbo || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(); }
      if (this.rec) { this.rec.cur.len = this.frameT; this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      this.frameT = 0;
      if (this.onFrame) this.onFrame();
    }

    // ── バス(CPU から。tick は CPU 側が先に呼んでいる)──
    read(addr) {
      if (this.dmaActive && addr < 0xFF00) {
        // OAM DMA の間: OAM は $FF。DMA の読み元と同じバス(外部バス=ROM/カートリッジ RAM/WRAM、または VRAM)を読むと、
        // DMA が今運んでいるバイトが見える(DMG)。I/O と HRAM は普通に読める
        if (addr >= 0xFE00) return 0xFF;
        const srcVram = this.dmaSrc >= 0x8000 && this.dmaSrc < 0xA000, adrVram = addr >= 0x8000 && addr < 0xA000;
        if (srcVram === adrVram) return this.dmaByte;
      }
      return this._busRead(addr);
    }
    _busRead(addr) {
      if (addr < 0x8000) return this.cart.read(addr);
      if (addr < 0xA000) return this.ppu.vram[addr - 0x8000];
      if (addr < 0xC000) return this.cart.readRam(addr);
      if (addr < 0xFE00) return this.wram[addr & 0x1FFF]; // $E000-$FDFF は WRAM の写し
      if (addr < 0xFEA0) return this.ppu.oam[addr - 0xFE00];
      if (addr < 0xFF00) return 0x00;
      if (addr >= 0xFF80) return addr === 0xFFFF ? this.ie : this.hram[addr - 0xFF80];
      if (addr >= 0xFF10 && addr <= 0xFF3F) return this.apu.readRegister(addr);
      if (addr >= 0xFF40 && addr <= 0xFF4B) return addr === 0xFF46 ? this.dma : this.ppu.readReg(addr);
      switch (addr) {
        case 0xFF00: return 0xC0 | (this.p1 & 0x30) | this._p1Low();
        case 0xFF01: return this.sb;
        case 0xFF02: return this.sc | 0x7E;
        case 0xFF04: return this.div >> 8;
        case 0xFF05: return this.tima;
        case 0xFF06: return this.tma;
        case 0xFF07: return this.tac | 0xF8;
        case 0xFF0F: return this.if | 0xE0;
      }
      return 0xFF;
    }

    write(addr, v) {
      if (addr < 0x8000) { this.cart.write(addr, v); return; }
      if (addr < 0xA000) { this.ppu.vram[addr - 0x8000] = v; return; }
      if (addr < 0xC000) { this.cart.writeRam(addr, v); return; }
      if (addr < 0xFE00) { this.wram[addr & 0x1FFF] = v; return; }
      if (addr < 0xFEA0) { if (!this.dmaActive) this.ppu.oam[addr - 0xFE00] = v; return; }
      if (addr < 0xFF00) return;
      if (addr >= 0xFF80) { if (addr === 0xFFFF) this.ie = v; else this.hram[addr - 0xFF80] = v; return; }
      if (addr >= 0xFF10 && addr <= 0xFF3F) {
        this.apu.writeRegister(addr, v);
        if (this.rec) this.rec.cur.push({ addr, value: v, t: this.frameT });
        if (this.onWrite) this.onWrite(addr, v, this.frameFrac());
        return;
      }
      if (addr >= 0xFF40 && addr <= 0xFF4B) {
        if (addr === 0xFF46) { this.dma = v; this.dmaNext = (v >= 0xE0 ? v - 0x20 : v) << 8; this.dmaStart = 2; } // $E0 以上は WRAM の写し側を読む
        else if (addr === 0xFF40 && this.lcdAlwaysOn) this.ppu.writeReg(addr, v | 0x80);
        else this.ppu.writeReg(addr, v);
        return;
      }
      switch (addr) {
        case 0xFF00: { const before = this._p1Low(); this.p1 = v & 0x30; if (before & ~this._p1Low() & 0x0F) this.requestIrq(4); break; }
        case 0xFF01: this.sb = v; break;
        case 0xFF02:
          this.sc = v & 0x81;
          // 内部クロックで開始。外部クロック(bit0=0)は相手がいないので終わらない
          this.serialBits = (v & 0x81) === 0x81 ? 8 : 0;
          if (this.serialBits) { this.serialSent.push(this.sb); if (this.serialSent.length > 4096) this.serialSent.splice(0, 2048); }
          break;
        case 0xFF04: this._setDiv(0); break;
        // あふれた直後のサイクルの書き込みは再読込を取り消す。再読込のサイクルの書き込みは無視される(TMA が勝つ)
        case 0xFF05: if (!this.timaReloading) { this.tima = v; this.timaReload = false; } break;
        case 0xFF06: this.tma = v; if (this.timaReloading) this.tima = v; break; // 再読込のサイクルなら新しい値がそのまま入る
        case 0xFF07: { // 許可/選択を変えた瞬間に選択ビットの AND が落ちると 1 進む
          const was = (this.tac & 4) && (this.div & TAC_BIT[this.tac & 3]);
          this.tac = v & 7;
          const now = (this.tac & 4) && (this.div & TAC_BIT[this.tac & 3]);
          if (was && !now) this._incTima();
          break;
        }
        case 0xFF0F: this.if = v & 0x1F; break;
      }
    }

    // ── 録音(VGM への符号化は段階 8c)。書き込みの t はフレーム頭からの T、フレームの長さは frames[f].len ──
    startRecording() {
      const cur = [];
      const apu = this.apu;
      // 今のレジスタ像(NR52 を先に。OFF だと他が書けない)と波形 RAM
      cur.push({ addr: 0xFF26, value: apu.powerOn ? 0x80 : 0x00, t: 0 });
      for (let a = 0xFF10; a < 0xFF26; a++) {
        if (a === 0xFF15 || a === 0xFF1F) continue;
        let v = apu.regRaw[a - 0xFF10];
        if (a === 0xFF14 || a === 0xFF19 || a === 0xFF1E || a === 0xFF23) v &= 0x7F; // トリガは写さない(鳴り直してしまう)
        cur.push({ addr: a, value: v, t: 0 });
      }
      for (let i = 0; i < 16; i++) cur.push({ addr: 0xFF30 + i, value: apu.ch3.readWaveRam(i), t: 0 });
      this.rec = { frames: [], cur };
    }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) { rec.cur.len = this.frameT; rec.frames.push(rec.cur); }
      return rec.frames;
    }

    // ── 実行 ──
    step() {
      const cpu = this.cpu;
      if (cpu.stopped) { // STOP 中: ボタンが押されるまで時間だけ進む
        if ((this.pad & 0xFF) !== 0) cpu.stopped = false;
        else { this.tick(); return 4; }
      }
      return cpu.step();
    }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) { this.step(); if (++guard > 200000) break; }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    // 音はステレオ(NR51 の左右振り分け)。outR を渡せば左右別、渡さなければ左右の平均を out へ
    takeAudioInto(out, n, outR) {
      const take = Math.min(n, this.ringLen), M = AUDIO_RING - 1, h = this.ringHead;
      if (outR) { for (let i = 0; i < take; i++) { out[i] = this.ring[(h + i) & M]; outR[i] = this.ringR[(h + i) & M]; } for (let i = take; i < n; i++) outR[i] = 0; }
      else for (let i = 0; i < take; i++) out[i] = (this.ring[(h + i) & M] + this.ringR[(h + i) & M]) * 0.5;
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & (AUDIO_RING - 1);
      this.ringLen -= take;
    }

    static describe(gb) {
      const h = gb.cart.header;
      return `${h.title || '(no title)'} [${gb.cart.mbc}${gb.cart.unsupported ? ' 未対応種別 $' + h.type.toString(16) : ''}] ROM ${gb.cart.rom.length >> 10}K RAM ${gb.cart.ram.length}` +
        `${gb.cart.hasBattery ? ' battery' : ''}${gb.cart.hasRtc ? ' rtc' : ''}${h.cgb ? (h.cgbOnly ? ' CGB専用' : ' CGB対応') : ''}${h.sgb ? ' SGB対応' : ''}${h.checksumOk ? '' : ' ヘッダ不整合'}`;
    }
  }

  GbConsole.CLOCK = CLOCK;
  GbConsole.FRAME_T = FRAME_T;
  GbConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.GbConsole = GbConsole;
})(typeof window !== 'undefined' ? window : globalThis);
