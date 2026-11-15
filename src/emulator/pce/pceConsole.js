/*
 * PC エンジン本体(段階 9c: HuCard、2 ボタンパッド 1 個、波形メモリ音源、VDC/VCE 1 組)
 * MML.Emu.PceConsole
 *
 * 作り: CPU(cpuHuC6280.js)が 1 サイクルごとに tick() を呼ぶ。tick はマスタークロック(21.47727MHz)を高速時 3、低速時 12 進め、
 *   3 個ごとに タイマ → VDC → 音の標本化 の順で進める。本体がそのまま CPU のバス(read / write / stWrite / setMpr …)。
 *   NesConsole / MsxConsole / GbConsole と同じ形の口を持つ(runFrame / runSamples / setController / startRecording …)。
 *   1 画面の区切りは「走査線 256 に入った所」(VDC が絵を出し終えた所。Mesen と同じ)。
 *
 * 番地: 論理 64K を 8K×8 に切り、MPR でバンク(0-255)を選ぶ。
 *   $00-$7F カード、$80-$87 CD 本体の RAM、$F7 バックアップ RAM、$F8-$FB RAM(8K の鏡像)、$FF I/O、ほかは $FF。
 *   I/O(1K ごと): $0000 VDC、$0400 VCE、$0800 波形メモリ音源、$0C00 タイマ、$1000 パッド、$1400 割り込み、$1800 CD。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/PCE/(読んだだけで写していない):
 *   [参照] PceMemoryManager.cpp: I/O の番地の分け方、I/O バッファ(タイマ/割り込みレジスタの上位ビットに前の値が残る)、
 *          VDC/VCE を読み書きすると CPU が 1 サイクル待たされる、1 サイクルの中の順番はタイマ → VDC、電源投入で低速・割り込みマスク 0・MPR7=0、
 *          バックアップ RAM は頭の 2K だけ(鏡像なし)
 *   [参照] PceControlManager.cpp / PceController.h: パッドは $1000 への書き込み bit0 = SEL(1 で十字)、bit1 = CLR(1 で読みが 0)。
 *          読みの下位 4bit = SEL が 1 なら 上/右/下/左、0 なら I/II/SELECT/RUN(押すと 0)
 *   [参照] CdRom/PceCdRom.cpp: CD 本体を付けていない HuCard でも、Mesen は既定で CD 本体の「バックアップ RAM と RAM」が見える形にしている。
 *          バックアップ RAM は電源投入時は開いていて、$1803 を読むと閉じ、$1807 に bit7=1 を書くと開く
 *   ★ $1000 の読みの上位: bit6 = 0(北米本体のふり。Mesen の既定「自動」と同じ。bit6 が 1 だと動かない北米版がある、というコメント)、
 *      bit7 = 0(CD 本体あり)。国内版の本体は bit6 = 1 のはずで、それを見るソフトがあるかは未確認(opts.region = 'pce' で 1 にできる)
 *   [推定] RAM とバックアップ RAM 以外のメモリは 0 で始める(実機は不定)
 *   [参照] $1800-$1BFF の読み(CD に何も入っておらず何も動いていない時の値。PceCdRom.cpp / PceAdpcm.cpp / PceAudioFader.cpp):
 *          $1800/$1801/$1805-$180A = 0、$1802 = 割り込み許可(書いた値の下位 7bit)、$1803 = $02、$1804 = 書いた値の下位 4bit、
 *          $180B/$180D/$180E/$180F = 書いた値、$180C = 0、$18C0-$18C3 = 00 AA 55 03(Super システムカード相当の印)、ほかは $FF。
 *          実ソフト 1 本(54 本中)が、CD を使わないのに $1807-$180A を毎回読んでいて分かった
 *   ★ $180C(ADPCM の状態): $180A を読むと bit7(読み出し中)、$180A へ書くと bit2(書き込み中)が立ち、$180D に bit7(リセット)を書くまで立ったまま。
 *      Mesen は HuCard の時、CD 本体のレジスタは見せるが CD 本体の時計は進めない。そのため「数十クロックで終わるはずの読み書き」が終わらず、
 *      印が立ちっぱなしになる。実機(CD 本体をつないだ時)は印がすぐ下りるはずで、つないでいなければ $18xx は読めない(未確認)。
 *      実ソフト 1 本(54 本中)がこの印で分岐していて、Mesen と同じ動きにするためにそのまま合わせた。CD を作る 9e で決め直す
 *   [推定] CD の中身(SCSI、ADPCM の再生と RAM、CD-DA、フェーダの効き)は 9e。$18C0-$18C3 の印は Mesen の設定(CD-ROM の種類)しだいで $FF にもなる
 *   [推定] 色: VCE の 9bit(緑 3・赤 3・青 3)を 各 3bit → 8bit に直線で伸ばす。白黒の印(VCE $0400 bit7)は輝度 0.299R+0.587G+0.114B
 * 確かめ方: tools/headless/pce-mesen-ab.js --rom(I/O の時刻つきの並びと画面を Mesen と比べる)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const MASTER = 21477270;
  const LINE = 1365;
  const BANK = 0x2000;
  const AUDIO_RING = 1 << 14;
  const LINE_IRQ2 = 1, LINE_IRQ1 = 2, LINE_TIMER = 4;
  const OVERSCAN = 18; // 5MHz の時に左右に見せる枠のドット数(Mesen の RowOverscanSize と同じ)

  // 9bit の色 → ABGR。$200 の印つきは白黒
  const COLORS = (() => {
    const t = new Uint32Array(0x400);
    for (let c = 0; c < 0x200; c++) {
      const g = Math.round(((c >> 6) & 7) * 255 / 7), r = Math.round(((c >> 3) & 7) * 255 / 7), b = Math.round((c & 7) * 255 / 7);
      t[c] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
      const y = Math.max(0, Math.min(255, Math.floor(0.299 * r + 0.587 * g + 0.114 * b)));
      t[c | 0x200] = (0xFF000000 | (y << 16) | (y << 8) | y) >>> 0;
    }
    return t;
  })();
  // ドットクロックごとの「見せる幅」と「左の切り落とし」(Mesen の PceConstants と同じ決め方: 5MHz で 256+枠 18×2)
  const rowWidth = (div) => div === 2 ? 512 + OVERSCAN * 4 : div === 3 ? 341 + ((OVERSCAN * 4 / 3) | 0) * 2 : 256 + OVERSCAN * 2;
  const leftCut = (div) => div === 2 ? 120 - OVERSCAN * 2 : div === 3 ? 72 - ((OVERSCAN * 4 / 3) | 0) : 48 - OVERSCAN;

  class PceConsole {
    constructor(romBytes, opts) {
      opts = opts || {};
      this.card = opts.card || new Emu.PceCard(romBytes);
      this.region = opts.region || 'auto';
      this.mpr = new Uint8Array(8);
      this.ram = new Uint8Array(BANK);
      this.cdRam = new Uint8Array(0x10000);
      this.bram = PceConsole.blankBram();
      this.timer = new Emu.PceTimer();
      this.vce = new Emu.PceVce();
      this.vdc = new Emu.PceVdc(this);
      this.apu = new Emu.APUHuC6280();
      this.cpu = new Emu.CPUHuC6280(this);
      this.pad = [0, 0]; this.padHeld = [0, 0]; this.padTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.sampleRate = 0; this.sampleAcc = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringR = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0; this.underruns = 0;
      this.onWrite = null;   // (reg(0-9), value, frameFrac) 波形メモリ音源への書き込み
      this.onFrame = null;   // 1 画面できた(命令の境目で呼ぶ。ここでステートを取っても続きが同じになる)
      this.onFrameExact = null; // 画面の区切りの瞬間(命令の途中のことがある。照合の道具がメモリを控えるのに使う。ここでステートは取れない)
      this.onIo = null;      // (kind 'R'/'W', 論理番地, 値) I/O の読み書き(照合の道具用。ST0-2 は番地 0/2/3)
      this.rec = null;
      this._frame = new Uint32Array(rowWidth(4) * Emu.PceVdc.ROWS);
      this._frameIdx = new Uint16Array(rowWidth(4) * Emu.PceVdc.ROWS); // 同じ絵を色の番号(VCE の 9bit+白黒の印 $200)で
      this._frameW = rowWidth(4); this._frameDirty = true;
      this.bramDirty = false;
      this.reset();
    }

    reset() {
      this.ram.fill(0); this.cdRam.fill(0);
      this.mpr.fill(0);
      this.timer.reset(); this.vce.reset(); this.vdc.reset(); this.apu.reset && this.apu.reset();
      this.clock = 0; this.cycleSteps = 4;
      this.timerIrq = false; this.irq2 = false; this.irqDisable = 0; this.ioBuffer = 0; this.mprBuffer = 0;
      this.padSel = false; this.padClr = false;
      this.bramLocked = false; this.cdIrqEnable = 0; this.cdReset = 0; this.cdRegs = new Uint8Array(16); this.cdAdpcmBusy = 0;
      this.frameCount = 0; this.frameStart = 0; this._frameFlag = false; this._frameCb = false; this.lastFrameLen = LINE * 262;
      this.sampleAcc = 0;
      this.cpu.powerOn();
    }

    // バックアップ RAM の初期の中身(CD 本体の BIOS が「全消去」した直後の形。頭 8 バイトが見出し)
    static blankBram() { const b = new Uint8Array(0x800); b.set([0x48, 0x55, 0x42, 0x4D, 0x00, 0xA0, 0x10, 0x80]); return b; }

    setSampleRate(sr) { this.sampleRate = sr; this.sampleAcc = 0; this.ringHead = 0; this.ringLen = 0; }
    // ボタンのビットは NesConsole.BUTTON と同じ並び(A B SELECT START UP DOWN LEFT RIGHT)。A = I、B = II、START = RUN
    setController(port, bits, turbo) { if (port) return; this.padHeld[0] = bits & 0xFF; this.padTurbo[0] = (turbo | 0) & 0xFF; this._applyPad(); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(); }
    _applyPad() {
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      let p = this.padHeld[0] | (on ? this.padTurbo[0] : 0);
      if ((p & 0x30) === 0x30) p &= ~0x30; // [参照] 上+下、左+右を同時に押したら、どちらも押していない扱い(PceController.h の既定)
      if ((p & 0xC0) === 0xC0) p &= ~0xC0;
      this.pad[0] = p;
    }
    _padRead() {
      if (this.padClr) return 0;
      const p = this.pad[0];
      let v = 0x0F;
      if (this.padSel) v &= ~(((p >> 4) & 1) | (((p >> 7) & 1) << 1) | (((p >> 5) & 1) << 2) | (((p >> 6) & 1) << 3)); // 上 右 下 左
      else v &= ~(p & 0x0F);                                                                                           // I II SELECT RUN
      return v & 0x0F;
    }

    get hasBattery() { return true; }
    get batteryDirty() { return this.bramDirty; }
    clearBatteryDirty() { this.bramDirty = false; }
    getBattery() { return this.bram.slice(); }
    setBattery(bytes) { const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); if (b.length < 0x800) return false; this.bram.set(b.subarray(0, 0x800)); return true; }
    get frameRate() { return MASTER / LINE / this.vce.lines; }
    get stereo() { return true; }
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['huc6280']; }
    applyMix(mute, volume) {
      const put = (t, s, conv) => { if (s) for (const k of Object.keys(t)) if (s[k] !== undefined) t[k] = conv(s[k]); };
      // 鍵盤表示の名前は HES と同じ 'hes'({ ch0..ch5 })
      if (mute && mute.hes) put(this.apu.mute, mute.hes, (v) => !!v);
      if (volume && volume.hes) put(this.apu.vol, volume.hes, (v) => Math.max(0, Math.min(2, +v || 0)));
    }
    frameFrac() { return Math.min(0.999999, (this.clock - this.frameStart) / (LINE * this.vce.lines)); }

    // ── 絵(242 行。幅はドットクロックで変わる: 292 / 389 / 584。1 画面の中で混ざる時は 1168 に引き伸ばす) ──
    _buildFrame() {
      const vdc = this.vdc, ROWS = Emu.PceVdc.ROWS, ROW_W = Emu.PceVdc.ROW_W, out = vdc.out, rd = vdc.rowDiv;
      let div = rd[0];
      for (let i = 1; i < ROWS; i++) if (rd[i] !== div) { div = 0; break; }
      const w = div ? rowWidth(div) : rowWidth(4) * 4;
      if (this._frame.length !== w * ROWS) { this._frame = new Uint32Array(w * ROWS); this._frameIdx = new Uint16Array(w * ROWS); }
      this._frameW = w; this.frameDivider = div;
      const f = this._frame, fi = this._frameIdx;
      for (let y = 0; y < ROWS; y++) {
        const d = rd[y] || 4, src = y * ROW_W + leftCut(d), dst = y * w;
        if (div) for (let x = 0; x < w; x++) { const c = out[src + x] & 0x3FF; fi[dst + x] = c; f[dst + x] = COLORS[c]; }
        else { const ratio = rowWidth(d) / w; for (let x = 0; x < w; x++) { const c = out[src + ((x * ratio) | 0)] & 0x3FF; fi[dst + x] = c; f[dst + x] = COLORS[c]; } }
      }
      this._frameDirty = false;
    }
    get frame() { if (this._frameDirty) this._buildFrame(); return this._frame; }
    get frameIdx() { if (this._frameDirty) this._buildFrame(); return this._frameIdx; }
    get frameWidth() { if (this._frameDirty) this._buildFrame(); return this._frameW; }
    get frameHeight() { return Emu.PceVdc.ROWS; }
    // 画素の横:縦(5MHz の 1 ドットを 1 とした時の幅)。画面側が横幅を決めるのに使う
    get pixelAspect() { if (this._frameDirty) this._buildFrame(); return this.frameDivider ? this.frameDivider / 4 : 0.25; }

    // ── 時計 ──
    setSpeed(high) { this.cycleSteps = high ? 1 : 4; }
    /** CPU 1 サイクル */
    tick() { for (let i = this.cycleSteps; i > 0; i--) this.execFast(); }
    /** マスタークロック 3 個ぶん: タイマ → VDC → 音 */
    execFast() {
      this.clock += 3;
      if (this.timer.advance(3)) this.timerIrq = true;
      this.vdc.exec();
      const sr = this.sampleRate;
      if (sr) {
        this.sampleAcc += sr * 3;
        if (this.sampleAcc >= MASTER) {
          this.sampleAcc -= MASTER;
          if (this.ringLen < AUDIO_RING) {
            this.apu.runToMaster(this.clock);
            const s = this.apu.mixSample();
            const i = (this.ringHead + this.ringLen) & (AUDIO_RING - 1);
            this.ring[i] = s.left; this.ringR[i] = s.right;
            this.ringLen++;
          }
        }
      }
    }
    onVdcFrame() {
      this.frameCount++;
      this._frameFlag = true; this._frameDirty = true;
      this.lastFrameLen = this.clock - this.frameStart;
      if (this.padTurbo[0] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(); }
      if (this.rec) { this.rec.cur.len = this.lastFrameLen; this.rec.frames.push(this.rec.cur); this.rec.cur = []; }
      this.frameStart = this.clock;
      if (!this.sampleRate) this.apu.runToMaster(this.clock); // 音を取らない時も、音源の時計を溜めすぎない
      // ここは VDC の行末処理の途中で、CPU も命令の途中。onFrame(巻き戻しの控えを取る)は命令が終わってから呼ぶ(step)。
      // ここで取ると、復元後に「命令の途中の PC」から新しい命令として走り出して別の動きになる(見直しで実測して分かった)
      this._frameCb = true;
      if (this.onFrameExact) this.onFrameExact();
    }

    // ── 割り込み ──
    get irqActive() { return (this.irq2 ? LINE_IRQ2 : 0) | (this.vdc.irq ? LINE_IRQ1 : 0) | (this.timerIrq ? LINE_TIMER : 0); }
    irqLines() { return this.irqActive & ~this.irqDisable; }

    // ── MPR ──
    setMpr(i, bank) { this.mpr[i & 7] = bank & 0xFF; }
    getMpr(i) { return this.mpr[i & 7]; }

    // ── バス ──
    read(addr) {
      const bank = this.mpr[addr >>> 13], off = addr & 0x1FFF;
      if (bank < 0x80) return this.card.rom[this.card.offset[bank] + off];
      if (bank === 0xFF) { const v = this.readIo(off); if (this.onIo) this.onIo('R', addr, v); return v; }
      if (bank >= 0xF8 && bank <= 0xFB) return this.ram[off];
      if (bank === 0xF7) return (!this.bramLocked && off < 0x800) ? this.bram[off] : 0xFF;
      if (bank < 0x88) return this.cdRam[((bank - 0x80) << 13) | off];
      return 0xFF;
    }
    write(addr, value) {
      const bank = this.mpr[addr >>> 13], off = addr & 0x1FFF;
      if (bank === 0xFF) { if (this.onIo) this.onIo('W', addr, value); this.writeIo(off, value); return; }
      if (bank >= 0xF8 && bank <= 0xFB) { this.ram[off] = value; return; }
      if (bank === 0xF7) { if (!this.bramLocked && off < 0x800) { this.bram[off] = value; this.bramDirty = true; } return; }
      if (bank >= 0x80 && bank < 0x88) this.cdRam[((bank - 0x80) << 13) | off] = value;
    }
    /** ST0/ST1/ST2 の書き先(VDC のポート 0/2/3)。MPR を通らない */
    stWrite(port, value) {
      if (this.onIo) this.onIo('W', port & 3, value);
      this.vdc.write(port, value);
      this.cpu.idle();
    }

    readIo(off) {
      if (off < 0x0400) { this.tick(); return this.vdc.read(off); }                       // VDC(1 サイクル待たされる)
      if (off < 0x0800) { this.tick(); this.vdc.draw(); return this.vce.read(off); }      // VCE(同上)
      if (off < 0x0C00) return this.ioBuffer;                                             // 波形メモリ音源は読めない
      if (off < 0x1000) { this.ioBuffer = (this.ioBuffer & 0x80) | (this.timer.read() & 0x7F); return this.ioBuffer; }
      if (off < 0x1400) { this.ioBuffer = (this.region === 'pce' ? 0x40 : 0) | 0x30 | this._padRead(); return this.ioBuffer; }
      if (off < 0x1800) {
        switch (off & 3) {
          case 2: this.ioBuffer = (this.ioBuffer & 0xF8) | (this.irqDisable & 7); break;
          case 3: this.ioBuffer = (this.ioBuffer & 0xF8) | (this.irqActive & 7); break;
        }
        return this.ioBuffer;
      }
      if (off < 0x1C00) return this._cdRead(off & 0x3FF);
      return 0xFF;
    }

    writeIo(off, value) {
      if (off < 0x0400) { this.vdc.write(off, value); this.cpu.idle(); return; }
      if (off < 0x0800) { this.vdc.draw(); this.vce.write(off, value); this.cpu.idle(); return; }
      if (off < 0x0C00) {
        const reg = off & 0x0F;
        this.apu.runToMaster(this.clock);
        this.apu.writeRegister(0x0800 | reg, value);
        this.ioBuffer = value;
        if (reg <= 9) {
          if (this.rec) this.rec.cur.push({ addr: reg, value, t: this.clock - this.frameStart });
          if (this.onWrite) this.onWrite(reg, value, this.frameFrac());
        }
        return;
      }
      if (off < 0x1000) { this.timer.write(off, value); this.ioBuffer = value; return; }
      if (off < 0x1400) { this.padSel = (value & 1) !== 0; this.padClr = (value & 2) !== 0; this.ioBuffer = value; return; }
      if (off < 0x1800) {
        switch (off & 3) {
          case 2: this.irqDisable = value & 7; break;
          case 3: this.timerIrq = false; break;
        }
        this.ioBuffer = value;
        return;
      }
      if (off < 0x1C00) this._cdWrite(off & 0x3FF, value);
    }

    // CD 本体の口(9c では「バックアップ RAM の鍵」だけ本物。ほかは 9e)
    _cdRead(reg) {
      switch (reg) {
        case 0x00: case 0x01: return 0;
        case 0x02: return this.cdIrqEnable;
        case 0x03: this.bramLocked = true; return 0x02;
        case 0x04: return this.cdReset;
        case 0x05: case 0x06: case 0x07: case 0x08: case 0x09: return 0;
        case 0x0A: this.cdAdpcmBusy |= 0x80; return 0;
        case 0x0C: return this.cdAdpcmBusy;
        case 0x0B: case 0x0D: case 0x0E: case 0x0F: return this.cdRegs[reg];
        case 0xC0: return 0x00;
        case 0xC1: return 0xAA;
        case 0xC2: return 0x55;
        case 0xC3: return 0x03;
        default: return 0xFF;
      }
    }
    _cdWrite(reg, value) {
      switch (reg) {
        case 0x02: this.cdIrqEnable = value & 0x7F; break;
        case 0x04: this.cdReset = value & 0x0F; if (value & 2) this.cdIrqEnable &= 0x8F; break;
        case 0x07: this.bramLocked = (value & 0x80) === 0; break;
        case 0x0A: this.cdAdpcmBusy |= 0x04; break;
        case 0x0D: if (value & 0x80) this.cdAdpcmBusy = 0; this.cdRegs[reg] = value; break;
        case 0x0B: this.cdRegs[reg] = value & 0xFE; break; // bit0 は転送が走っていなければ立たない(HuCard では常に)
        case 0x0E: case 0x0F: this.cdRegs[reg] = value; break;
        default: break;
      }
    }

    // ── 録音(VGM への符号化は別。書き込みの t は画面の頭からのマスタークロック、画面の長さは frames[f].len) ──
    startRecording() {
      const cur = [], apu = this.apu, w = (addr, value) => cur.push({ addr, value: value & 0xFF, t: 0 });
      // 今の音源の像を、書き込みの並びに直して頭に置く(波形は ch を切ってから 32 個。読み位置は 0 に戻る)
      for (let i = 0; i < 6; i++) {
        const c = apu.ch[i];
        w(0, i); w(4, 0x40); w(4, 0x00);
        for (let k = 0; k < 32; k++) w(6, c.wave[k]);
        w(2, c.freq & 0xFF); w(3, (c.freq >> 8) & 0x0F); w(5, c.balance);
        if (i >= 4) w(7, c.noiseCtrl);
        w(4, c.control);
        if (c.control & 0x40) w(6, c.dac);
      }
      w(1, apu.balance); w(8, apu.lfoFreq); w(9, apu.lfoCtrl); w(0, apu.selected);
      this.rec = { frames: [], cur };
    }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      this.rec = null;
      if (rec.cur.length) { rec.cur.len = this.clock - this.frameStart; rec.frames.push(rec.cur); }
      return rec.frames;
    }

    // ── 実行 ──
    /** 1 命令。画面ができていたら、命令が終わった所で onFrame を呼ぶ */
    step() { const n = this.cpu.step(); if (this._frameCb) { this._frameCb = false; if (this.onFrame) this.onFrame(); } return n; }
    runFrame() {
      this._frameFlag = false;
      let guard = 0;
      while (!this._frameFlag) { this.step(); if (++guard > 400000) break; }
      return this.sampleRate ? this.takeAudio(this.ringLen) : null;
    }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 800000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    runSamplesStereo(outL, outR) {
      const n = outL.length;
      if (!this.sampleRate) { outL.fill(0); outR.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 800000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(outL, n, outR);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    takeAudioInto(out, n, outR) {
      const take = Math.min(n, this.ringLen), M = AUDIO_RING - 1, h = this.ringHead;
      if (outR) { for (let i = 0; i < take; i++) { out[i] = this.ring[(h + i) & M]; outR[i] = this.ringR[(h + i) & M]; } for (let i = take; i < n; i++) outR[i] = 0; }
      else for (let i = 0; i < take; i++) out[i] = (this.ring[(h + i) & M] + this.ringR[(h + i) & M]) * 0.5;
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (this.ringHead + take) & M;
      this.ringLen -= take;
    }

    static describe(pce) {
      const c = pce.card;
      return `HuCard ${c.fileSize >> 10}K(${c.banks} バンク)${c.hadHeader ? ' ヘッダ 512 バイトを外した' : ''}${c.reversed ? ' ビットの逆順を戻した' : ''}${c.oversize ? ' 1MB 超=未対応' : ''}`;
    }
  }

  PceConsole.MASTER = MASTER;
  PceConsole.LINE = LINE;
  PceConsole.COLORS = COLORS;
  PceConsole.rowWidth = rowWidth;
  PceConsole.leftCut = leftCut;
  PceConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.PceConsole = PceConsole;
})(typeof window !== 'undefined' ? window : globalThis);
