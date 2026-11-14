/*
 * ゲームボーイ本体(段階 8a: DMG の骨格)
 * MML.Emu.GbConsole
 *
 * CPU(cpuSm83.js)がバスに触るたび(1 M サイクル)に tick() で本体を 4T 進める。進むのは
 * タイマ(DIV/TIMA)、シリアル、OAM DMA、PPU、APU、音の標本化。NesConsole/MsxConsole と同じ形の API を持つ
 * (runFrame / runSamples / setController / startRecording / getBattery …)。
 *
 * CGB(段階 8d): 倍速(KEY1+STOP。CPU/タイマ/シリアル/OAM DMA は CPU の速さ、PPU と APU は元の速さのまま)、VRAM 2 バンク、WRAM 8 バンク、
 *   HDMA(一括/HBlank ごと)、パレット、赤外線ポート(受光なし)、PCM12/34。機種は opts.model('dmg' / 'cgb' / 'auto'=カートリッジのヘッダで決める)。
 * まだ無い物(DESIGN-GB-CAPTURE.md §9): 
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
  // HuC3 のブザー: 音の番号 0-3 の高さと 1 回の長さ。★実機の値は分からない(推定の仮の値)。分かったらここだけ直す
  const BUZZ_HZ = [2048, 2560, 3072, 4096], BUZZ_SEC = 0.2, BUZZ_LEVEL = 0.06;
  const APU_BIT = 1 << 12;   // APU のフレームシーケンサ 512Hz = DIV bit12 の立ち下がり(CGB の倍速時は bit13。this.apuBit)

  class GbConsole {
    // opts.model: 'dmg'(既定)/ 'cgb' / 'auto'(カートリッジがカラー対応なら cgb)。'sgb' は後の段階
    constructor(romBytes, opts) {
      opts = opts || {};
      // opts.cart: 出来合いのカートリッジを挿す(GBS プレイヤーが使う)。opts.lcdAlwaysOn / opts.noRender も GBS 用
      this.cart = opts.cart || new Emu.GbCart(romBytes);
      this.model = opts.model === 'auto' ? (this.cart.header.cgb ? 'cgb' : 'dmg') : (opts.model || 'dmg');
      // カラー本体に白黒専用ソフトを挿した時: カラーの機能は閉じて白黒として動き、色だけ本体が付ける(BG/OBJ0/OBJ1 に別の色。ppu.setShades)
      this.dmgOnCgb = this.model === 'cgb' && !this.cart.header.cgb;
      this.cgb = this.model === 'cgb' && !this.dmgOnCgb;
      this.lcdAlwaysOn = !!opts.lcdAlwaysOn;
      this.ppu = new Emu.GbPpu(this);
      this.ppu.cgb = this.cgb;
      this.ppu.noRender = !!opts.noRender;
      this.apu = new Emu.APUGb(this.model === 'cgb' ? 'cgb' : 'dmg');
      this.apu.externalSeq = true;
      this.apuBit = APU_BIT;
      this.apu.divBit = () => (this.div & this.apuBit) !== 0;
      this.cpu = new Emu.CPUSm83(this);
      this.wram = new Uint8Array(0x8000); // 4K × 8 バンク(DMG は 0 と 1 だけ使う)
      this.hram = new Uint8Array(0x7F);
      // パッドは NesConsole と同じ形(配列の [0] だけ使う。巻き戻し NesRewind/GbRewind が pad[0]/pad[1] を記録する)
      this.pad = [0, 0]; this.padHeld = [0, 0]; this.padTurbo = [0, 0]; this.turboRate = 2; this.turboPhase = 0;
      this.cpuCycles = 0; this.frameCount = 0; this.frameT = 0; this._frameFlag = false;
      this.sampleRate = 0; this.cycleAccum = 0;
      this.ring = new Float32Array(AUDIO_RING); this.ringR = new Float32Array(AUDIO_RING); this.ringHead = 0; this.ringLen = 0; this.underruns = 0;
      this.onWrite = null;  // (addr, value, frameFrac) 音源レジスタの書き込み
      this.onFrame = null;
      this.onSerial = null; // (byte) シリアルへ 1 バイト送り終えた(テスト ROM の結果表示など)
      this.serialDevice = null; // (byte) => 受け取るバイト。未接続は $FF
      // 通信ポートのポケットプリンタ(opts.printer === false で外す)。刷り上がった絵は prints に溜まる(画面側が takePrints で取る)
      this.prints = [];
      this.printer = opts.printer === false || !Emu.GbPrinter ? null : new Emu.GbPrinter();
      if (this.printer) this.printer.onPrint = (page) => { this.prints.push(page); };
      // バーコードボーイも同じ口に。ゲームが送る最初のバイトで見分かれる(握手 $10 $07… はバーコードボーイ、$88 $33… はプリンタ)
      this.barcode = opts.barcode === false || !Emu.GbBarcodeBoy ? null : new Emu.GbBarcodeBoy();
      if (this.printer || this.barcode) this.serialDevice = (b) => { const r = this.barcode ? this.barcode.exchange(b) : null; return r !== null ? r : (this.printer ? this.printer.exchange(b) : 0xFF); };
      // カートリッジ内ブザー(HuC3)。音の高さと長さは資料が無く仮の値(BUZZ_HZ / BUZZ_SEC)。録音には「鳴らした時刻と音の番号」を載せる
      this.bzLeft = 0; this.bzPhase = 0; this.bzStep = 0;
      this.irIn = false; // 赤外線の受光(CGB 本体のポートと HuC1 のカートリッジ。画面側が setLight で入れる)
      this.serialOut = [];  // 送り終えたバイト
      this.serialSent = []; // 送り始めたバイト(完了を待たずに次を送るソフトの出力も拾える。mooneye のテスト ROM の合否)
      if (this.dmgOnCgb) this.ppu.setShades(GbConsole.CGB_TINT.cgb);
      this.rec = null;
      // スーパーゲームボーイ: opts.sgb = ICD2(snes/icd2.js。パッドの線と LCD の行を横取りする)、opts.bootRom = ブート ROM 256 バイト(任意)
      this.sgb = opts.sgb || null;
      this.clockHz = CLOCK; // 音の標本化に使う時計。スーパーゲームボーイ(初代)は 4295454Hz で動くので ICD2 が入れ直す
      this.bootImage = opts.bootRom || null; this.bootRom = null;
      this.reset();
    }

    // 電源投入+ブート ROM 実行後の状態(DMG)
    reset() {
      this.wram.fill(0); this.hram.fill(0);
      this.cart.reset(); this.ppu.reset(); this.apu.reset();
      const cpu = this.cpu;
      cpu.reset();
      cpu.a = 0x01; cpu.f = 0xB0; cpu.b = 0x00; cpu.c = 0x13; cpu.d = 0x00; cpu.e = 0xD8; cpu.h = 0x01; cpu.l = 0x4D;
      if (this.cgb) { cpu.a = 0x11; cpu.f = 0x80; cpu.b = 0x00; cpu.c = 0x00; cpu.d = 0xFF; cpu.e = 0x56; cpu.h = 0x00; cpu.l = 0x0D; }
      if (this.dmgOnCgb) { cpu.a = 0x11; cpu.f = 0x80; cpu.b = 0x00; cpu.c = 0x00; cpu.d = 0x00; cpu.e = 0x08; cpu.h = 0x00; cpu.l = 0x7C; } // カラー本体が白黒ソフトを起動した時の値
      cpu.sp = 0xFFFE; cpu.pc = 0x0100;
      this.bootRom = this.bootImage;
      // CGB のレジスタ
      this.stepT = 4;          // CPU の 1 M サイクルが元のクロックで何 T か(倍速なら 2)
      this.apuBit = APU_BIT;
      this.key1 = 0; this.doubleSpeed = false; this.svbk = 1; this.rp = 0;
      this.hdmaSrc = 0; this.hdmaDst = 0; this.hdmaLeft = 0; this.hdmaActive = false; this.hdmaDue = false; this.hdmaReg = [0xFF, 0xFF, 0xFF, 0xFF];
      this.undoc = [0, 0, 0, 0]; // $FF72-$FF75
      this.ie = 0; this.if = 0x01;
      this.div = this.cgb ? 0x2674 : 0xABC8; // CGB の値は mooneye の boot_div-cgbABCDE を総当たりして決めた(白黒ソフトを CGB で起動した時の値。カラー対応ソフトでも同じとみなす=推定) this.tima = 0; this.tma = 0; this.tac = 0; this.timaReload = false; this.timaReloading = false;
      this.p1 = 0x00; this.sb = 0; this.sc = 0; this.serialBits = 0;
      // タイマ。ここで 0 を入れておかないと、TMA を一度も書かないソフトで TIMA が NaN→0 のままあふれ続ける(実ソフトの総当たりで見つけた)
      this.tima = 0; this.tma = 0; this.tac = 0; this.timaReload = false; this.timaReloading = false;
      this.dma = 0xFF; this.dmaActive = false; this.dmaPos = 0; this.dmaSrc = 0; this.dmaStart = 0; this.dmaNext = 0; this.dmaByte = 0xFF;
      // ブート ROM が「ポーン」を鳴らした後のレジスタ。CH1 は鳴り終わりかけで有効のまま(NR52=$F1)。
      // 残響の音量は分からないので 0 にしておく(起動直後に余韻は鳴らさない)
      const apu = this.apu;
      for (const [a, v] of [[0xFF26, 0x80], [0xFF10, 0x80], [0xFF11, 0xBF], [0xFF12, 0xF3], [0xFF13, 0xC1], [0xFF14, 0x87], [0xFF16, 0x3F], [0xFF18, 0xFF],
        [0xFF1A, 0x7F], [0xFF1B, 0xFF], [0xFF1C, 0x9F], [0xFF1D, 0xFF], [0xFF20, 0xFF], [0xFF24, 0x77], [0xFF25, 0xF3]]) apu.writeRegister(a, v);
      apu.ch1.envelope.volume = 0; apu.ch1.envelope.running = false;
      apu.regRaw[0x03] = 0xFF; apu.ch1.triggerSeq = 0;
      this.cpuCycles = 0; this.frameT = 0;
      if (this.bootRom) { // ブート ROM を $0000 から実行する(LCD は消えた状態から。$FF50 に書くとカートリッジに切り替わる)
        cpu.a = 0; cpu.f = 0; cpu.b = 0; cpu.c = 0; cpu.d = 0; cpu.e = 0; cpu.h = 0; cpu.l = 0; cpu.sp = 0; cpu.pc = 0;
        this.ppu.writeReg(0xFF40, 0x00); this.if = 0; this.div = 0;
      }
    }

    setSampleRate(sr) { this.sampleRate = sr; this.cycleAccum = 0; this.ringHead = 0; this.ringLen = 0; if (sr) this.apu.setSampleRate(sr); }
    // ボタンのビットは NesConsole.BUTTON と同じ並び(A B SELECT START UP DOWN LEFT RIGHT)。画面側の入力をそのまま使える
    setController(port, bits, turbo) { if (port) return; this.padHeld[0] = bits & 0xFF; this.padTurbo[0] = (turbo | 0) & 0xFF; this._applyPad(0); }
    setTurboRate(frames) { this.turboRate = Math.max(1, frames | 0); this.turboPhase = 0; this._applyPad(0); }
    _applyPad(port) {
      if (port) return;
      const on = ((this.turboPhase / this.turboRate) | 0) === 0;
      const before = this._p1Low();
      this.pad[0] = this.padHeld[0] | (on ? this.padTurbo[0] : 0);
      if (before & ~this._p1Low() & 0x0F) this.requestIrq(4); // 選ばれている線が H→L
    }
    // P1 の下位 4bit(押すと 0)。bit4=0 で十字(右左上下)、bit5=0 でボタン(A B SELECT START)
    _p1Low() {
      if (this.sgb) return this.sgb.p1Low(this.p1);
      const p = this.pad[0];
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
    get frameRate() { return CLOCK / FRAME_T; } // 59.7275Hz
    get stereo() { return true; }
    // ── 周辺の入出力(段階 8e)──
    // 傾き(MBC7): −1〜+1、右/下が正、1 = 重力 1 個ぶん
    setTilt(x, y) { this.cart.tiltX = +x || 0; this.cart.tiltY = +y || 0; }
    get hasTilt() { return !!this.cart.hasTilt; }
    // 赤外線の受光(押している間 true)
    setLight(on) { this.irIn = !!on; this.cart.irIn = !!on; }
    // ゲームが今、赤外線を読もうとしているか(画面側が受光ボタンを出す目安)
    get irWanted() { return !!(this.cart.hasIr && this.cart.irMode) || (this.cgb && (this.rp & 0xC0) === 0xC0); }
    // 振動モータ(MBC5 の振動つき)
    get rumble() { return !!this.cart.rumble; }
    takePrints() { return this.prints.length ? this.prints.splice(0) : null; }
    // ポケットカメラ: 元の絵(128×112、0〜255 の明るさ)を入れる。cameraWanted はゲームが撮影を始めたか(画面側が Web カメラを動かす目安)
    setCameraImage(u8) { if (this.cart.hasCamera) this.cart.camImage = u8; }
    get cameraWanted() { return !!(this.cart.hasCamera && this.cart.cam && this.cart.cam.shots > 0); }
    // バーコードボーイ: ゲームが握手を済ませて読み取りを待っているか/13 桁を読ませる
    get barcodeWanted() { return !!(this.barcode && this.barcode.armed && !this.barcode.queue.length); }
    scanBarcode(digits) { return !!(this.barcode && this.barcode.scan(digits)); }
    _buzz(tones) {
      for (const tone of tones) {
        if (this.rec) this.rec.cur.push({ buzz: tone & 3, t: this.frameT });
        this.bzLeft = Math.round(BUZZ_SEC * (this.sampleRate || 44100)); this.bzPhase = 0; this.bzStep = BUZZ_HZ[tone & 3] / (this.sampleRate || 44100);
      }
    }
    // ゲーム画面(nesScreen.js / nes-worklet-impl.js)が機種を問わず呼ぶ口
    extBits() { return 0; }
    get diskCount() { return 0; }
    chips() { return ['gb']; }
    // 鍵盤表示のミュート/音量: { gb: { ch1..ch4 } }
    applyMix(mute, volume) {
      const put = (t, s, conv) => { if (s) for (const k of Object.keys(t)) if (s[k] !== undefined) t[k] = conv(s[k]); };
      if (mute && mute.gb) put(this.apu.mute, mute.gb, (v) => !!v);
      if (volume && volume.gb) put(this.apu.vol, volume.gb, (v) => Math.max(0, Math.min(2, +v || 0)));
    }
    frameFrac() { return Math.min(0.999999, this.frameT / FRAME_T); }

    // ── 割り込み(CPU から呼ばれる)──
    requestIrq(bit) { this.if |= 1 << bit; }
    irqPending() { return this.ie & this.if & 0x1F; }
    irqAck(bit) { this.if &= ~(1 << bit); }
    // STOP: CGB で KEY1 bit0 が立っていれば速度切り替え(DIV は 0 に戻る)。それ以外はボタンが押されるまで止まる
    stop(cpu) {
      if (this.cgb && (this.key1 & 1)) {
        this.key1 = 0;
        this.doubleSpeed = !this.doubleSpeed;
        this.stepT = this.doubleSpeed ? 2 : 4;
        this.apuBit = this.doubleSpeed ? APU_BIT << 1 : APU_BIT;
        this._setDiv(0);
        return;
      }
      cpu.stopped = true;
    }
    // WRAM の番地 → 配列の位置($C000-$CFFF はバンク 0、$D000-$DFFF は SVBK のバンク。$E000 台は写し)
    _w(addr) { const a = addr & 0x1FFF; return a < 0x1000 ? a : (this.svbk << 12) | (a & 0xFFF); }
    // HDMA の 1 ブロック(16 バイト)を VRAM へ
    _hdmaBlock() {
      const ppu = this.ppu;
      for (let i = 0; i < 16; i++) { ppu.vram[ppu.vbk * 0x2000 + (this.hdmaDst & 0x1FFF)] = this._busRead(this.hdmaSrc & 0xFFFF); this.hdmaSrc++; this.hdmaDst++; }
      this.hdmaLeft--;
      const stall = this.doubleSpeed ? 16 : 8; // 1 ブロックは元のクロックで 32T。その間 CPU は止まる
      for (let i = 0; i < stall; i++) this.tick();
    }
    hblank() { if (this.hdmaActive) this.hdmaDue = true; } // PPU がモード 0 に入った

    // ── CPU の 1 M サイクルぶん進める(元のクロックで 4T。CGB の倍速なら 2T)──
    tick() {
      const st = this.stepT;
      this.cpuCycles += st;
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
      ppu.tick(st);
      const apu = this.apu;
      apu.advance(st);

      this.frameT += st;
      // フレームの区切りは VBlank の頭。LCD が消えている間は 70224T ごとに刻む(音と録音の時間を止めない)
      if (ppu.vblankStarted) { ppu.vblankStarted = false; this._frameEnd(); }
      else if (this.frameT >= FRAME_T && !ppu.on) this._frameEnd();

      const sr = this.sampleRate;
      if (sr) {
        this.cycleAccum += sr * st;
        if (this.cycleAccum >= this.clockHz) {
          this.cycleAccum -= this.clockHz;
          if (this.ringLen < AUDIO_RING) {
            const s = apu.mixSample();
            const i = (this.ringHead + this.ringLen) & (AUDIO_RING - 1);
            let bz = 0;
            if (this.bzLeft > 0) { this.bzLeft--; this.bzPhase += this.bzStep; if (this.bzPhase >= 1) this.bzPhase -= 1; bz = this.bzPhase < 0.5 ? BUZZ_LEVEL : -BUZZ_LEVEL; }
            this.ring[i] = s.left + bz; this.ringR[i] = s.right + bz;
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
      if ((old & this.apuBit) && !(nv & this.apuBit)) {
        this.apu.seqTick();
        // 外部クロックで待っているゲームへ、つないだ機器(バーコードボーイ)の側から 1 バイト送る(512Hz に 1 回見る)
        if ((this.sc & 0x81) === 0x80 && this.barcode) { const b = this.barcode.pull(); if (b >= 0) { this.sb = b; this.sc &= 0x7F; this.if |= 8; } }
      }
      const sbit = (this.sc & 2) ? 1 << 3 : SERIAL_BIT; // CGB の高速クロック(SC bit1)
      if (this.serialBits && (old & sbit) && !(nv & sbit)) {
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
      if (this.padTurbo[0] || this.turboPhase) { this.turboPhase = (this.turboPhase + 1) % (this.turboRate * 2); this._applyPad(0); }
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
        // バスは DMG が 2 本(外部=ROM/カートリッジ RAM/WRAM、VRAM)、CGB は WRAM が別で 3 本。
        // CGB で WRAM から運んでいる間も ROM のコードは普通に走る(倍速のソフトが HRAM の待ちを早く抜けて ROM へ戻る例があった)
        const busOf = (x) => x >= 0x8000 && x < 0xA000 ? 1 : (this.cgb && x >= 0xC000 ? 2 : 0);
        if (busOf(this.dmaSrc) === busOf(addr)) return this.dmaByte;
      }
      // モード 3 の VRAM、モード 2/3 の OAM は PPU が使っていて読めない
      if (addr >= 0x8000 && addr < 0xA000) { if (this.ppu.vramBlocked()) return 0xFF; }
      else if (addr >= 0xFE00 && addr < 0xFEA0) { if (this.ppu.oamBlocked()) return 0xFF; }
      return this._busRead(addr);
    }
    _busRead(addr) {
      if (addr < 0x8000) return this.bootRom && addr < 0x100 ? this.bootRom[addr] : this.cart.read(addr);
      if (addr < 0xA000) return this.ppu.vram[this.ppu.vbk * 0x2000 + addr - 0x8000];
      if (addr < 0xC000) return this.cart.readRam(addr);
      if (addr < 0xFE00) return this.wram[this._w(addr)]; // $E000-$FDFF は WRAM の写し
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
      if (this.cgb) {
        const ppu = this.ppu;
        switch (addr) {
          case 0xFF4D: return (this.doubleSpeed ? 0x80 : 0) | (this.key1 & 1) | 0x7E;
          case 0xFF4F: return ppu.vbk | 0xFE;
          case 0xFF55: return this.hdmaActive ? ((this.hdmaLeft - 1) & 0x7F) : (this.hdmaLeft > 0 ? 0x80 | ((this.hdmaLeft - 1) & 0x7F) : 0xFF);
          case 0xFF56: return (this.rp & 0xC1) | 0x3C | (this.irIn && (this.rp & 0xC0) === 0xC0 ? 0 : 2); // 赤外線: 読み取りを有効にしていて光があれば bit1=0
          case 0xFF68: return ppu.bcps | 0x40;
          case 0xFF69: return ppu.bgPalRam[ppu.bcps & 0x3F];
          case 0xFF6A: return ppu.ocps | 0x40;
          case 0xFF6B: return ppu.objPalRam[ppu.ocps & 0x3F];
          case 0xFF6C: return ppu.opri | 0xFE;
          case 0xFF70: return this.svbk | 0xF8;
          case 0xFF72: return this.undoc[0];
          case 0xFF73: return this.undoc[1];
          case 0xFF74: return this.undoc[2];
          case 0xFF75: return this.undoc[3] | 0x8F;
          case 0xFF76: return this.apu.readPcm12();
          case 0xFF77: return this.apu.readPcm34();
        }
      }
      return 0xFF;
    }

    write(addr, v) {
      if (addr < 0x8000) { this.cart.write(addr, v); return; }
      if (addr < 0xA000) { if (!this.ppu.vramBlocked()) this.ppu.vram[this.ppu.vbk * 0x2000 + addr - 0x8000] = v; return; }
      if (addr < 0xC000) { this.cart.writeRam(addr, v); if (this.cart.buzzQueue && this.cart.buzzQueue.length) this._buzz(this.cart.takeBuzz()); return; } // buzzQueue: GBS 用のカートリッジには無い
      if (addr < 0xFE00) { this.wram[this._w(addr)] = v; return; }
      if (addr < 0xFEA0) { if (!this.dmaActive && !this.ppu.oamBlocked()) this.ppu.oam[addr - 0xFE00] = v; return; }
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
        case 0xFF50: if (v & 1) this.bootRom = null; break;
        case 0xFF00: { const before = this._p1Low(); this.p1 = v & 0x30; if (this.sgb) this.sgb.joypWrite((v >> 4) & 1, (v >> 5) & 1); if (before & ~this._p1Low() & 0x0F) this.requestIrq(4); break; }
        case 0xFF01: this.sb = v; break;
        case 0xFF02:
          this.sc = v & (this.cgb ? 0x83 : 0x81);
          // 内部クロックで開始。外部クロック(bit0=0)は相手がいないので終わらない
          this.serialBits = (v & 0x81) === 0x81 ? 8 : 0;
          if (this.serialBits) { this.serialSent.push(this.sb); if (this.serialSent.length > 4096) this.serialSent.splice(0, 2048); }
          break;
        case 0xFF04: this._setDiv(0); break;
        default: if (this.cgb) this._writeCgb(addr, v); break;
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

    // CGB だけのレジスタ
    _writeCgb(addr, v) {
      const ppu = this.ppu;
      switch (addr) {
        case 0xFF4D: this.key1 = v & 1; break;
        case 0xFF4F: ppu.vbk = v & 1; break;
        case 0xFF51: case 0xFF52: case 0xFF53: case 0xFF54: this.hdmaReg[addr - 0xFF51] = v; break;
        case 0xFF55: {
          if (this.hdmaActive && !(v & 0x80)) { this.hdmaActive = false; break; } // HBlank ごとの転送を止める(残りは読める)
          const r = this.hdmaReg;
          this.hdmaSrc = ((r[0] << 8) | r[1]) & 0xFFF0;
          this.hdmaDst = ((r[2] << 8) | r[3]) & 0x1FF0;
          this.hdmaLeft = (v & 0x7F) + 1;
          if (v & 0x80) { this.hdmaActive = true; this.hdmaDue = false; if (!ppu.on) this._hdmaBlock(); } // HBlank ごと(LCD が消えていれば 1 ブロックはすぐ)
          else { this.hdmaActive = false; while (this.hdmaLeft > 0) this._hdmaBlock(); }                    // 一括
          break;
        }
        case 0xFF56: this.rp = v & 0xC1; break;
        case 0xFF68: ppu.bcps = v & 0xBF; break;
        case 0xFF69: ppu.writePal(0, v); break;
        case 0xFF6A: ppu.ocps = v & 0xBF; break;
        case 0xFF6B: ppu.writePal(1, v); break;
        case 0xFF6C: ppu.opri = v & 1; break;
        case 0xFF70: this.svbk = (v & 7) || 1; break;
        case 0xFF72: this.undoc[0] = v; break;
        case 0xFF73: this.undoc[1] = v; break;
        case 0xFF74: this.undoc[2] = v; break;
        case 0xFF75: this.undoc[3] = v & 0x70; break;
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
        if ((this.pad[0] & 0xFF) !== 0) cpu.stopped = false;
        else { this.tick(); return 4; }
      }
      // CGB の HBlank ごとの HDMA: モード 0 に入るたびに 1 ブロック(CPU が HALT 中は運ばない)
      if (this.hdmaDue) { this.hdmaDue = false; if (this.hdmaActive && !cpu.halted) { this._hdmaBlock(); if (this.hdmaLeft <= 0) this.hdmaActive = false; } }
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
    // 左右別(AudioWorklet の process)
    runSamplesStereo(outL, outR) {
      const n = outL.length;
      if (!this.sampleRate) { outL.fill(0); outR.fill(0); return; }
      let guard = 0;
      while (this.ringLen < n && ++guard < 400000) this.step();
      if (this.ringLen < n) this.underruns++;
      this.takeAudioInto(outL, n, outR);
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
  // 色(ABGR)。rgb('RRGGBB') の並びで書く
  const rgb = (h) => (0xFF000000 | (parseInt(h.slice(4, 6), 16) << 16) | (parseInt(h.slice(2, 4), 16) << 8) | parseInt(h.slice(0, 2), 16)) >>> 0;
  const tint = (bg, o0, o1) => bg.concat(o0 || bg, o1 || o0 || bg).map(rgb);
  // 白黒の画面の色(4 階調)
  GbConsole.SHADES = {
    gray: tint(['FFFFFF', 'AAAAAA', '555555', '000000']),
    green: tint(['9BBC0F', '8BAC0F', '306230', '0F380F']),   // 初代の液晶風
    pocket: tint(['C4CFA1', '8B956D', '4D533C', '1F1F1F']),  // ポケット風
  };
  // カラー本体が白黒ソフトに付ける色(BG、OBJ0、OBJ1)。実機はソフトごとの表と起動時のボタンで選ぶ。ここは既定と、ボタンで選べる物のうち 3 つ
  // (色の値は記憶によるもので、実機の表との照合はしていない)
  GbConsole.CGB_TINT = {
    cgb: tint(['FFFFFF', '7BFF31', '0063C5', '000000'], ['FFFFFF', 'FF8484', '943A3A', '000000']),
    brown: tint(['FFFFFF', 'FFAD63', '843100', '000000']),
    blue: tint(['FFFFFF', '63A5FF', '0000FF', '000000'], ['FFFFFF', 'FF8484', '943A3A', '000000'], ['FFFFFF', '7BFF31', '008400', '000000']),
    pastel: tint(['FFFFA5', 'FF9494', '9494FF', '000000']),
  };
  // 設定の名前 → 12 色。'auto' は 白黒本体 = 灰色、カラー本体で白黒ソフト = カラー本体の既定
  GbConsole.shadesFor = function (name, dmgOnCgb) {
    if (!name || name === 'auto') return dmgOnCgb ? GbConsole.CGB_TINT.cgb : GbConsole.SHADES.gray;
    return GbConsole.SHADES[name] || GbConsole.CGB_TINT[name] || GbConsole.SHADES.gray;
  };
  GbConsole.BUZZ = { HZ: BUZZ_HZ, SEC: BUZZ_SEC, LEVEL: BUZZ_LEVEL }; // VGM の再生(vgmPlayer.js)も同じ値で鳴らす
  GbConsole.BUTTON = { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
  Emu.GbConsole = GbConsole;
})(typeof window !== 'undefined' ? window : globalThis);
