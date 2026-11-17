/*
 * CP システム III — ゲーム画面(src/ui/nesScreen.js)と音スレッド(src/audio/nes-worklet-impl.js)が期待する「本体」の形。
 * MML.Emu.Cps3Console。DESIGN-CPS3-CAPTURE.md §10。
 *
 * 中身は Cps3.Machine(CPU、周辺、画面)+ Cps3Audio(音源)。他の機種の本体(PceConsole など)と同じ口を持つ:
 *   setSampleRate / runSamples / runSamplesStereo / runFrame / frame / frameWidth / frameHeight / frameRate / frameCount / onFrame
 *   setController / setTurboRate / reset / startRecording / stopRecording / chips / extBits / diskCount / hasBattery / applyMix
 * ステートセーブと巻き戻しは cps3State.js。EEPROM(設定とハイスコア)は他の機種の「セーブ」と同じ口で出し入れする。
 *
 * 入力(setController の bits)。下位 8bit は他の機種と同じ並び、CPS3 だけの物を上に足した:
 *   0x01 A = ショット 1(弱パンチ)、0x02 B = ショット 2(中パンチ)、0x04 Select = コイン、0x08 Start = スタート、0x10-0x80 = 上下左右
 *   0x100 = ショット 3(強パンチ)、0x200/0x400/0x800 = ショット 4-6(弱・中・強キック)、0x1000 = テスト、0x2000 = サービス
 *
 * 録音(rec): フレームごとに { n0, n1, w: [レジスタ番号, 値, n, …] }。n は音源の通算サンプル番号(「何サンプル目の前に効くか」)。
 * VGM にするのは主スレッドの MML.VGM.encodeCps3Recording(波形は主スレッドが持っている)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};
  const Cps3 = Emu.Cps3 = Emu.Cps3 || {};

  const W = 384, H = 224;
  const GAIN = 1.0;   // MAME と同じ尺度のまま。効果音が重なると 1.0 を超えるので出口で切る

  class Cps3Console {
    /** @param rom 使わない(他の機種と引数の位置を合わせるだけ) @param opts { bios, simm1, simm2, gfx, game } */
    constructor(rom, opts) {
      this.opts = opts;
      this.game = opts.game;
      this.sampleRate = 48000;
      this.frame = new Uint32Array(512 * H);                            // 幅は 384 か 495(ソフトが選ぶ)。広い方に合わせて確保
      this._rgba = new Uint8Array(this.frame.buffer);
      this.frameWidth = W; this.frameHeight = H;
      this.frameRate = Cps3.CPU_HZ / Cps3.FRAME_CYCLES;
      this.clockHz = 42954545 / 3;
      this.onFrame = null;
      this.rec = null;
      this.underruns = 0;
      this.eepromInit = null;            // 前回の EEPROM(setBattery で受け取る。リセットしても残す)
      this.pad = [0, 0]; this.padHeld = [0, 0]; this.padTurbo = [0, 0];
      this._boot();
    }
    _boot() {
      const o = this.opts, k = Cps3.KEYS[o.game];
      if (!k) throw new Error('CPS3: 知らないゲーム ' + o.game);
      const m = this.machine = new Cps3.Machine({ bios: o.bios, simm1: o.simm1, simm2: o.simm2, gfx: o.gfx, key1: k[0], key2: k[1], alt: k[2] });
      const chip = this.chip = new Emu.Cps3Audio(this.clockHz);
      chip.rom = o.gfx; chip.romBase = 0x400000; chip.romXor = 1;       // 波形は CD の並びのまま持ち、読む時に 2 バイトずつ入れ替える
      this.period = Cps3.CPU_HZ / chip.sampleRate;                      // 音源の 1 サンプルぶんの CPU サイクル
      this.nextSample = this.period;
      this.outAt = 0;
      this.frameCount = 0;
      m.onSoundWrite = (off, data, mask) => {
        this._catchUp(m.cpu.cycles);
        const reg = off >> 1, rec = this.rec;
        if (mask & 0xFFFF0000) { chip.write(reg, data >>> 16); if (rec) rec.cur.w.push(reg, data >>> 16, chip.nat); }
        if (mask & 0x0000FFFF) { chip.write(reg + 1, data & 0xFFFF); if (rec) rec.cur.w.push(reg + 1, data & 0xFFFF, chip.nat); }
      };
      m.onFrameEnd = () => {
        this._catchUp(m.cpu.cycles);
        this.frameCount = m.frame;
        const rec = this.rec;
        if (rec) { rec.cur.n1 = chip.nat; rec.frames.push(rec.cur); rec.cur = { n0: chip.nat, n1: chip.nat, w: [] }; }
        if (this.onFrame) this.onFrame();
      };
      // 絵は垂直帰線に入った時の状態で作る(MAME と同じ時点。フレームの終わりだと、ソフトが次の絵の用意を始めている)
      m.onVblank = () => { m.renderScreen(this._rgba); this.frameWidth = m.screenWidth; };
      if (this.eepromInit) m.eeprom.set(this.eepromInit);
      this._applyPad();
    }
    // ── EEPROM(設定とハイスコア。0x80 バイト)。他の機種の「セーブ」と同じ口で、ゲーム画面がブラウザへ保存する ──
    get hasBattery() { return true; }
    get batteryDirty() { return this.machine.eepromDirty; }
    clearBatteryDirty() { this.machine.eepromDirty = false; }
    getBattery() { const e = this.machine.eeprom, b = new Uint8Array(e.length * 2); for (let i = 0; i < e.length; i++) { b[i * 2] = e[i] >> 8; b[i * 2 + 1] = e[i] & 0xFF; } return b; }
    setBattery(bytes) {
      if (!bytes || bytes.length !== 0x80) return false;
      const e = new Uint16Array(0x40); for (let i = 0; i < 0x40; i++) e[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
      this.eepromInit = e; this.machine.eeprom.set(e); this.machine.eepromDirty = false;
      return true;
    }
    static describe(c) { return 'CP System III — ' + ((Cps3.Image && Cps3.Image.NAMES[c.game]) || c.game); }

    setSampleRate(sr) { this.sampleRate = sr > 0 ? sr : 48000; }
    get stereo() { return true; }
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['cps3']; }
    reset() { const rec = !!this.rec; this.rec = null; this.eepromInit = this.machine.eeprom.slice(); this._boot(); if (rec) this.startRecording(); }   // EEPROM は電源を切っても残る
    applyMix(mute, volume) {
      const put = (target, source, conv) => { if (source) for (let i = 0; i < target.length; i++) if (source[i] !== undefined) target[i] = conv(source[i]); };
      if (mute) put(this.chip.mute, (mute.expansion || mute).cps3, (v) => !!v);
      if (volume) put(this.chip.vol, (volume.expansion || volume).cps3, (v) => Math.max(0, Math.min(2, +v || 0)));
    }

    // ── 入力 ───────────────────────────────────────────────────
    setController(port, bits) { this.pad[port & 1] = bits | 0; this.padHeld[port & 1] = bits | 0; this._applyPad(); }
    setTurboRate() {}
    _applyPad() {
      const a = this.pad[0], b = this.pad[1];
      let in0 = 0, ex = 0;
      if (a & 0x10) in0 |= 0x1; if (a & 0x20) in0 |= 0x2; if (a & 0x40) in0 |= 0x4; if (a & 0x80) in0 |= 0x8;
      if (a & 0x01) in0 |= 0x10; if (a & 0x02) in0 |= 0x20; if (a & 0x100) in0 |= 0x40;
      if (a & 0x200) ex |= 0x80000; if (a & 0x400) ex |= 0x40000; if (a & 0x800) ex |= 0x20000;
      if (a & 0x04) in0 |= 0x01000000; if (a & 0x08) in0 |= 0x10000000;
      if (a & 0x1000) in0 |= 0x20000; if (a & 0x2000) in0 |= 0x10000;
      if (b & 0x10) in0 |= 0x100; if (b & 0x20) in0 |= 0x200; if (b & 0x40) in0 |= 0x400; if (b & 0x80) in0 |= 0x800;
      if (b & 0x01) in0 |= 0x1000; if (b & 0x02) in0 |= 0x2000; if (b & 0x100) in0 |= 0x4000;
      if (b & 0x200) ex |= 0x100000; if (b & 0x400) ex |= 0x200000; if (b & 0x800) in0 |= 0x04000000;
      if (b & 0x04) in0 |= 0x02000000; if (b & 0x08) in0 |= 0x20000000;
      this.machine.inputs = (~in0) >>> 0; this.machine.extra = (~ex) >>> 0;   // 押すと 0
    }

    // ── 音と進行 ───────────────────────────────────────────────
    _catchUp(cycles) { const chip = this.chip; while (this.nextSample <= cycles) { chip.clock(); this.nextSample += this.period; } }
    runSamplesStereo(outL, outR) {
      const m = this.machine, chip = this.chip, step = Cps3.CPU_HZ / this.sampleRate;
      for (let i = 0; i < outL.length; i++) {
        this.outAt += step;
        m.advanceTo(this.outAt);
        this._catchUp(this.outAt);
        const l = chip.outL * GAIN, r = chip.outR * GAIN;
        outL[i] = l > 1 ? 1 : l < -1 ? -1 : l;
        if (outR) outR[i] = r > 1 ? 1 : r < -1 ? -1 : r; else outL[i] = (outL[i] + (r > 1 ? 1 : r < -1 ? -1 : r)) * 0.5;
      }
    }
    runSamples(out) { this.runSamplesStereo(out, null); }
    /** 1 フレーム進める(音スレッドが使えない時の主スレッド実行と、検査用。音は返さない) */
    runFrame() {
      const m = this.machine;
      m.runFrame();
      this.outAt = m.frameStart;
      return null;
    }

    // ── 録音 ───────────────────────────────────────────────────
    startRecording() {
      const chip = this.chip, w = [];
      // 今のレジスタの中身を書き込みとして置く。キーは落とした状態から始める(鳴っている途中の声は位置が分からないので拾わない)
      for (let r = 0; r < 0x100; r++) w.push(r, chip.regs[r], chip.nat);
      w.push(0x100, 0, chip.nat);
      this.rec = { frames: [], cur: { n0: chip.nat, n1: chip.nat, w } };
    }
    stopRecording() {
      const rec = this.rec;
      if (!rec) return [];
      rec.cur.n1 = this.chip.nat; rec.frames.push(rec.cur);
      this.rec = null;
      return rec.frames;
    }
  }

  Emu.Cps3Console = Cps3Console;
})(typeof window !== 'undefined' ? window : globalThis);
