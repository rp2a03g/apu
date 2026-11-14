/*
 * スーパーゲームボーイ本体(段階 8g-5): SNES(snesConsole.js)+ICD2(icd2.js)+ゲームボーイ(gb/gbConsole.js)を 1 台にまとめる
 * MML.Emu.SgbConsole / MML.Emu.SgbState
 *
 * 外形は GbConsole / NesConsole と同じ(Worklet と画面がそのまま扱える): setSampleRate / runSamplesStereo / runFrame / frame /
 * setController / startRecording / stopRecording / セーブ RAM / 周辺(傾き、赤外線、プリンタ…は中の GbConsole へ素通し)。
 *   - 画面は SNES の 256×224(枠つき)。1 フレーム = SNES の 1 フレーム(60.0988Hz)
 *   - 時計: 初代は SNES のマスタークロック ÷5 = 4,295,454Hz(実機のゲームボーイより約 2.4% 速い)。SGB2 は専用の水晶で 4,194,304Hz
 *   - 音: ゲームボーイの APU(出力レートで直接標本化)+SNES の DSP(32kHz を線形補間で出力レートへ)を足す。
 *     SPC700 は出力 1 サンプルごとに追いつかせる(ポートを触った時だけだと 1 フレームぶん固まって届く)
 *   - 録音: ゲームボーイの書き込み列(GbConsole の録音)に、SNES 側の音源の控え(.spc の形の像)と APU ポートへの書き込みを混ぜる。
 *     VGM では規格外ブロック GBXX の種類 1 に載る(vgmRecord.js encodeGbRecording)
 *   - パッド: NesConsole.BUTTON の並びを SNES のパッドへ写す(A→A、B→B、SELECT、START、十字)。2P も渡す(多人数対応ソフト用)
 * ステート(SgbState)は SNES 側を木ごと写し、ゲームボーイは GbState に任せる。巻き戻し(SgbRewind)は 30 秒ぶん。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const MASTER = 21477272, SGB2_XTAL = 20971520;
  const RING = 16384, SPC_FIFO = 4096, SPC_RATE = 32000;
  // NesConsole.BUTTON(A B SELECT START UP DOWN LEFT RIGHT)→ SNES のパッド
  const PAD_MAP = [0x0080, 0x8000, 0x2000, 0x1000, 0x0800, 0x0400, 0x0200, 0x0100];
  const toSnesPad = (bits) => { let o = 0; for (let i = 0; i < 8; i++) if (bits & (1 << i)) o |= PAD_MAP[i]; return o; };

  class SgbConsole {
    // opts: { bios: SGB の BIOS(256K = 初代、512K = SGB2), bootRom: ゲームボーイ側のブート ROM 256 バイト(任意), revision: 1 | 2(省略時は BIOS の大きさ) }
    constructor(gbRom, opts) {
      opts = opts || {};
      if (!opts.bios) throw new Error('SGB BIOS が要ります');
      const bios = opts.bios instanceof Uint8Array ? opts.bios : new Uint8Array(opts.bios);
      this.revision = opts.revision || (bios.length > 0x40000 ? 2 : 1);
      this.icd = new Emu.SgbIcd2(gbRom, { bootRom: opts.bootRom || null, revision: this.revision });
      this.gb = this.icd.gb;
      this.snes = new Emu.SnesConsole(bios, { ext: this.icd });
      this.icd.baseHz = this.revision === 2 ? SGB2_XTAL : MASTER;
      this.icd.clkScale = this.revision === 2 ? SGB2_XTAL / MASTER : 1;
      this.icd._applyClock();
      this.model = 'sgb'; this.cgb = false; this.isSgb = true;
      this.cart = this.gb.cart; this.ppu = this.gb.ppu; this.apu = this.gb.apu;
      this.sampleRate = 0; this.acc = 0; this.underruns = 0;
      this.ring = new Float32Array(RING); this.ringR = new Float32Array(RING); this.ringHead = 0; this.ringLen = 0;
      this.spcL = new Float32Array(SPC_FIFO); this.spcR = new Float32Array(SPC_FIFO); this.spcHead = 0; this.spcLen = 0; this.spcFrac = 0; this.spcStep = 0;
      this.spcGain = 1; this.gbGain = 1;
      this.padHeld = [0, 0]; this.padTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.pad = [0, 0]; // 今効いているパッド値(NesConsole.BUTTON の並び)。巻き戻し(SgbRewind)が記録し、進め直す時は直接書く
      this.onFrame = null;
      this.recBase = 0; this.recPort = [0, 0, 0, 0]; this.menuFrames = 0;
      this.snes.apu.onSample = (l, r) => {
        if (!this.sampleRate) return;
        if (this.spcLen >= SPC_FIFO) { this.spcHead = (this.spcHead + 1) & (SPC_FIFO - 1); this.spcLen--; }
        const i = (this.spcHead + this.spcLen) & (SPC_FIFO - 1);
        this.spcL[i] = l; this.spcR[i] = r; this.spcLen++;
      };
      // 録音: APU ポートへの書き込み。c = 録音の頭からの SPC700 のサイクル数(再生はこの刻印どおりに書く)
      this.snes.onApuPort = (port, v) => { const rec = this.gb.rec; if (rec && this.recPort[port & 3] === (v & 0xFF)) return; if (rec) this.recPort[port & 3] = v & 0xFF; if (rec) rec.cur.push({ sgbPort: port & 3, value: v & 0xFF, t: this.gb.frameT, c: (this.snes.apu.cycles - this.recBase) >>> 0 }); };
      this.icd.onClock = (clk) => this._clock(clk);
      this.snes.onFrame = () => {
        if (this.menuFrames > 0 && --this.menuFrames === 0) this._applyPad();
        if (this.padTurbo[0] || this.padTurbo[1] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(); }
        if (this.onFrame) this.onFrame();
      };
    }

    reset() {
      this.icd.reset(); this.gb.reset(); this.snes.reset(); this.icd._applyClock();
      this.acc = 0; this.ringHead = 0; this.ringLen = 0; this.spcHead = 0; this.spcLen = 0; this.spcFrac = 0;
      this._applyPad();
    }

    // ── 音 ──
    setSampleRate(sr) {
      this.sampleRate = sr; this.acc = 0; this.ringHead = 0; this.ringLen = 0; this.spcHead = 0; this.spcLen = 0; this.spcFrac = 0;
      this.spcStep = sr ? SPC_RATE / sr : 0;
      this.gb.setSampleRate(sr);
    }
    // SNES のマスタークロックが clk 進んだ(ICD2 から)。出力 1 サンプルぶん溜まるたびに GB と SPC の音を足して輪へ
    _clock(clk) {
      const sr = this.sampleRate;
      if (!sr) return;
      this.acc += clk * sr;
      while (this.acc >= MASTER) {
        this.acc -= MASTER;
        this.snes.syncApu();
        // SPC: 32kHz → 出力レート(線形補間)
        let sl = 0, sp = 0;
        const M = SPC_FIFO - 1;
        while (this.spcFrac >= 1 && this.spcLen > 1) { this.spcFrac -= 1; this.spcHead = (this.spcHead + 1) & M; this.spcLen--; }
        if (this.spcLen > 1) {
          const a = this.spcHead, b = (a + 1) & M, f = this.spcFrac < 1 ? this.spcFrac : 1;
          sl = this.spcL[a] + (this.spcL[b] - this.spcL[a]) * f; sp = this.spcR[a] + (this.spcR[b] - this.spcR[a]) * f;
          this.spcFrac += this.spcStep;
        } else if (this.spcLen === 1) { sl = this.spcL[this.spcHead]; sp = this.spcR[this.spcHead]; }
        // GB: 中の GbConsole が同じ出力レートで自分の輪に溜めている(止められている間は空)
        let gl = 0, gr = 0;
        const gb = this.gb;
        if (gb.ringLen > 0) {
          const GM = gb.ring.length - 1;
          if (gb.ringLen > 256) { gb.ringHead = (gb.ringHead + gb.ringLen - 8) & GM; gb.ringLen = 8; } // 溜まり過ぎ(時計の切り替え直後など)は捨てて遅れを持ち越さない
          gl = gb.ring[gb.ringHead]; gr = gb.ringR[gb.ringHead]; gb.ringHead = (gb.ringHead + 1) & GM; gb.ringLen--;
        }
        if (this.ringLen < RING) {
          const i = (this.ringHead + this.ringLen) & (RING - 1);
          this.ring[i] = gl * this.gbGain + sl * this.spcGain; this.ringR[i] = gr * this.gbGain + sp * this.spcGain;
          this.ringLen++;
        }
      }
    }
    runFrame() { this._pushPad(); this.snes.runFrame(); return this.sampleRate ? this.takeAudio(this.ringLen) : null; }
    runSamples(out) {
      const n = out.length;
      if (!this.sampleRate) { out.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.snes.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(out, n);
    }
    runSamplesStereo(outL, outR) {
      const n = outL.length;
      if (!this.sampleRate) { outL.fill(0); outR.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.snes.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(outL, n, outR);
    }
    takeAudio(n) { const out = new Float32Array(n); this.takeAudioInto(out, n); return out; }
    takeAudioInto(out, n, outR) {
      const take = Math.min(n, this.ringLen), M = RING - 1, h = this.ringHead;
      if (outR) { for (let i = 0; i < take; i++) { out[i] = this.ring[(h + i) & M]; outR[i] = this.ringR[(h + i) & M]; } for (let i = take; i < n; i++) outR[i] = 0; }
      else for (let i = 0; i < take; i++) out[i] = (this.ring[(h + i) & M] + this.ringR[(h + i) & M]) * 0.5;
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringHead = (h + take) & M; this.ringLen -= take;
    }
    applyMix(mute, volume) { return this.gb.applyMix(mute, volume); }

    // ── 画面と時間 ──
    get frame() { return this.snes.frame; }
    get frameWidth() { return 256; }
    get frameHeight() { return 224; }
    get frameRate() { return MASTER / (1364 * 262); }
    get frameCount() { return this.snes.frameCount; }
    set frameCount(v) { this.snes.frameCount = v; }
    get stereo() { return true; }
    get clockHz() { return this.gb.clockHz; } // 録音の VGM ヘッダに入れるゲームボーイのクロック

    // ── パッド ──
    setController(port, bits, turbo) { const p = port ? 1 : 0; this.padHeld[p] = bits & 0xFF; this.padTurbo[p] = (turbo | 0) & 0xFF; this._applyPad(); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(); }
    _applyPad() {
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      for (let p = 0; p < 2; p++) this.pad[p] = this.padHeld[p] | (on ? this.padTurbo[p] : 0);
      this._pushPad();
    }
    _pushPad() {
      for (let p = 0; p < 2; p++) this.snes.setController(p, toSnesPad(this.pad[p]) | (p === 0 && this.menuFrames > 0 ? 0x0030 : 0));
    }
    // スーパーゲームボーイのメニュー(配色・枠の変更)を開く: SNES のパッドの L と R を同時に少しの間押す
    pressMenu() { this.menuFrames = 8; this._applyPad(); }

    // ── 録音 ──
    get rec() { return this.gb.rec; }
    set rec(v) { this.gb.rec = v; } // 巻き戻しが録音を止める(null を入れる)
    startRecording() {
      this.gb.startRecording();
      this.snes.syncApu();
      this.recBase = this.snes.apu.cycles;
      this.recPort = Array.from(this.snes.apu.in); // 同じ値の書き直しは録音に入れない(SPC700 から見て変化が無い。BIOS は毎フレーム書く)
      this.gb.rec.cur.unshift({ sgbSpc: this.snes.apu.toSpc(), t: 0 }); // SNES 側の音源の今の像(.spc の形)。VGM の先頭に来るよう、GB のレジスタ像より前へ
    }
    stopRecording() { return this.gb.stopRecording(); }

    // ── 中のゲームボーイへ素通し ──
    get hasBattery() { return this.gb.hasBattery; }
    get batteryDirty() { return this.gb.batteryDirty; }
    clearBatteryDirty() { this.gb.clearBatteryDirty(); }
    getBattery() { return this.gb.getBattery(); }
    setBattery(b) { return this.gb.setBattery(b); }
    setTilt(x, y) { this.gb.setTilt(x, y); }
    get hasTilt() { return this.gb.hasTilt; }
    setLight(on) { this.gb.setLight(on); }
    get irWanted() { return this.gb.irWanted; }
    get rumble() { return this.gb.rumble; }
    takePrints() { return this.gb.takePrints(); }
    setCameraImage(u8) { this.gb.setCameraImage(u8); }
    get cameraWanted() { return this.gb.cameraWanted; }
    get barcodeWanted() { return this.gb.barcodeWanted; }
    scanBarcode(d) { return this.gb.scanBarcode(d); }
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['gb']; }

    static describe(sgb) { return Emu.GbConsole.describe(sgb.gb) + (sgb.revision === 2 ? ' / Super Game Boy 2' : ' / Super Game Boy'); }
  }

  // ── ステート ──
  // SNES 側(本体、CPU、PPU、APU、DSP、ICD2)は木ごと写す。関数と、親や ROM への参照(下の SKIP)は写さない
  const SKIP = new Set(['bus', 'rom', 'cart', 'ext', 'gb', 'frame', 'con', 'sgb', 'bootImage']);
  function snap(o) {
    const out = {};
    for (const k of Object.keys(o)) {
      if (SKIP.has(k)) continue;
      const v = o[k];
      if (typeof v === 'function') continue;
      out[k] = snapVal(v);
    }
    return out;
  }
  function snapVal(v) {
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) return v.slice();
    if (Array.isArray(v)) return v.map(snapVal);
    return snap(v);
  }
  function restore(o, s) {
    for (const k of Object.keys(s)) {
      const v = s[k], cur = o[k];
      if (v === null || typeof v !== 'object') { o[k] = v; continue; }
      if (ArrayBuffer.isView(v)) { if (cur && ArrayBuffer.isView(cur) && cur.length === v.length) cur.set(v); else o[k] = v.slice(); continue; }
      if (Array.isArray(v)) {
        const plainObjs = v.length > 0 && Array.isArray(cur) && cur.length === v.length && v.every((e) => e && typeof e === 'object' && !ArrayBuffer.isView(e) && !Array.isArray(e));
        if (plainObjs) for (let i = 0; i < v.length; i++) restore(cur[i], v[i]);
        else o[k] = v.map(snapVal);
        continue;
      }
      if (cur && typeof cur === 'object') restore(cur, v); else o[k] = snapVal(v);
    }
  }
  const SgbState = {
    VERSION: 1,
    save(sgb) {
      sgb.snes.syncApu();
      const snes = snap(sgb.snes);
      if (snes.apu && snes.apu.dsp) delete snes.apu.dsp.ram; // APU の RAM と同じ物
      return { kind: 'sgb', v: SgbState.VERSION, revision: sgb.revision, snes, icd: snap(sgb.icd), gb: Emu.GbState.save(sgb.gb), gbBoot: !!sgb.gb.bootRom, gbClock: sgb.gb.clockHz };
    },
    load(sgb, st) {
      if (!st || st.kind !== 'sgb' || st.v !== SgbState.VERSION || st.revision !== sgb.revision) return false;
      if (!Emu.GbState.load(sgb.gb, st.gb)) return false;
      restore(sgb.snes, st.snes);
      restore(sgb.icd, st.icd);
      sgb.gb.bootRom = st.gbBoot ? sgb.gb.bootImage : null;
      sgb.gb.clockHz = st.gbClock;
      sgb.acc = 0; sgb.ringHead = 0; sgb.ringLen = 0; sgb.spcHead = 0; sgb.spcLen = 0; sgb.spcFrac = 0;
      sgb.gb.ringHead = 0; sgb.gb.ringLen = 0;
      sgb._applyPad();
      return true;
    },
  };

  // ── 巻き戻し ──
  // NES の物(nes/nesRewind.js)をそのまま使う。状態が 1 個 400KB ほどあるので控えるのは 30 秒ぶん(0.5 秒ごと × 60 個 ≒ 24MB)。
  // 逆再生の映像は SNES の画面(色は直接指定)を 8bit(R3 G3 B2)に丸めて輪に控える(戻っている間だけ色が粗い)。
  // メニューボタン(L+R)は記録しないので、メニューを開いた所をまたいで戻ると、進め直しではメニューが開かない
  class SgbRewind extends (Emu.NesRewind || class {}) {
    constructor(sgb) {
      super(sgb, { State: SgbState, frameBytes: 256 * 224, interval: 30, keep: 60 });
      this.idxWidth = 256;
      this.regenEvery = 3; // 1 フレームの計算が重いので、逆再生中の作り直しは process 3 回に 1 フレーム
      const p = new Uint32Array(256);
      for (let i = 0; i < 256; i++) { const r = (i >> 5) & 7, g = (i >> 2) & 7, b = i & 3; p[i] = (0xFF000000 | ((b * 85) << 16) | (((g * 255 / 7) | 0) << 8) | ((r * 255 / 7) | 0)) >>> 0; }
      this._pal = p;
    }
    get palette() { return this._pal; }
    _capture(f) {
      const FB = this.frameBytes, RING = Emu.NesRewind.RING;
      if (!this.ring) this.ring = new Uint8Array(RING * FB);
      const slot = f % RING, src = this.nes.frame, ring = this.ring, base = slot * FB;
      for (let i = 0; i < FB; i++) { const c = src[i]; ring[base + i] = ((c & 0xE0)) | ((c >> 11) & 0x1C) | ((c >> 22) & 3); } // ABGR → R3 G3 B2
      this.ringFrame[slot] = f;
    }
  }

  Emu.SgbRewind = SgbRewind;
  Emu.SgbConsole = SgbConsole;
  Emu.SgbState = SgbState;
})(typeof window !== 'undefined' ? window : globalThis);
