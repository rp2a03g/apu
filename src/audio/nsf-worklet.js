/*
 * NSF (Nintendo Sound Format) 1.x 128バイトヘッダ生成
 * 参考: NESdev Wiki "NSF" フォーマット仕様
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const NSF = MML.NSF = MML.NSF || {};

  // 拡張音源フラグ (オフセット 0x7A / 122)
  NSF.CHIP_FLAGS = {
    VRC6: 0x01,
    VRC7: 0x02,
    FDS: 0x04,
    MMC5: 0x08,
    N163: 0x10,
    FME7: 0x20
  };

  function writeAsciiPadded(view, offset, text, length) {
    const bytes = new Uint8Array(length); // 0 埋め
    const enc = (text || '').slice(0, length);
    for (let i = 0; i < enc.length; i++) {
      bytes[i] = enc.charCodeAt(i) & 0xFF;
    }
    for (let i = 0; i < length; i++) view.setUint8(offset + i, bytes[i]);
  }

  /**
   * 128バイトのNSFヘッダを生成する
   * @param {object} opt
   * @param {number} [opt.totalSongs=1]
   * @param {number} [opt.startingSong=1]
   * @param {number} [opt.loadAddr=0x8000]
   * @param {number} [opt.initAddr=0x8000]
   * @param {number} [opt.playAddr=0x8003]
   * @param {string} [opt.songName='']
   * @param {string} [opt.artist='']
   * @param {string} [opt.copyright='']
   * @param {number} [opt.ntscSpeed=16639]  - 1/1000000秒単位 (NTSC ≒ 60.0988Hz)
   * @param {number} [opt.palSpeed=19997]   - 1/1000000秒単位 (PAL ≒ 50.0070Hz)
   * @param {Uint8Array|number[]} [opt.bankswitch] - 8バイトのバンクスイッチ初期値
   * @param {number} [opt.palNtscBit=0]     - bit0: 0=NTSC,1=PAL / bit1: dual mode
   * @param {number} [opt.extraChips=0]     - NSF.CHIP_FLAGS の OR
   * @returns {Uint8Array} 128バイトのヘッダ
   */
  NSF.buildHeader = function (opt = {}) {
    const buf = new ArrayBuffer(128);
    const view = new DataView(buf);

    // 0-4: マジック "NESM" + 0x1A
    const magic = [0x4E, 0x45, 0x53, 0x4D, 0x1A];
    magic.forEach((b, i) => view.setUint8(i, b));

    // 5: バージョン番号
    view.setUint8(5, 1);

    // 6: トータルソング数
    view.setUint8(6, opt.totalSongs !== undefined ? opt.totalSongs : 1);
    // 7: 開始曲番号 (1始まり)
    view.setUint8(7, opt.startingSong !== undefined ? opt.startingSong : 1);

    // 8-9 / 10-11 / 12-13: Load / Init / Play アドレス (LE)
    view.setUint16(8, (opt.loadAddr !== undefined ? opt.loadAddr : 0x8000) & 0xFFFF, true);
    view.setUint16(10, (opt.initAddr !== undefined ? opt.initAddr : 0x8000) & 0xFFFF, true);
    view.setUint16(12, (opt.playAddr !== undefined ? opt.playAddr : 0x8003) & 0xFFFF, true);

    // 14-45-77: 曲名 / アーティスト / 著作権 (各32バイト、ASCII、0終端/0埋め)
    writeAsciiPadded(view, 14, opt.songName, 32);
    writeAsciiPadded(view, 46, opt.artist, 32);
    writeAsciiPadded(view, 78, opt.copyright, 32);

    // 110-111: NTSC再生スピード (1/1000000秒)
    view.setUint16(110, opt.ntscSpeed !== undefined ? opt.ntscSpeed : 16639, true);

    // 112-119: バンクスイッチ初期値 (8バイト)
    const bs = opt.bankswitch || [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 8; i++) view.setUint8(112 + i, bs[i] || 0);

    // 120-121: PAL再生スピード
    view.setUint16(120, opt.palSpeed !== undefined ? opt.palSpeed : 19997, true);

    // 122: PAL/NTSC ビット
    view.setUint8(122, opt.palNtscBit !== undefined ? opt.palNtscBit : 0);

    // 123: 拡張音源フラグ
    view.setUint8(123, opt.extraChips !== undefined ? opt.extraChips : 0);

    // 124-127: NSF2/予約領域 (0埋め)
    view.setUint32(124, 0, true);

    return new Uint8Array(buf);
  };

  /**
   * 128バイトのNSFヘッダを解析してオブジェクトに変換する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  NSF.parseHeader = function (bytes) {
    if (bytes.length < 128) throw new Error('NSFヘッダは128バイト必要です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, 128);
    const magicOk = bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x4D && bytes[4] === 0x1A;
    const readAscii = (offset, len) => {
      let s = '';
      for (let i = 0; i < len; i++) {
        const c = view.getUint8(offset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    return {
      magicOk,
      version: view.getUint8(5),
      totalSongs: view.getUint8(6),
      startingSong: view.getUint8(7),
      loadAddr: view.getUint16(8, true),
      initAddr: view.getUint16(10, true),
      playAddr: view.getUint16(12, true),
      songName: readAscii(14, 32),
      artist: readAscii(46, 32),
      copyright: readAscii(78, 32),
      ntscSpeed: view.getUint16(110, true),
      bankswitch: Array.from(bytes.slice(112, 120)),
      palSpeed: view.getUint16(120, true),
      palNtscBit: view.getUint8(122),
      extraChips: view.getUint8(123)
    };
  };
})(globalThis);

/*
 * RP2A03 内蔵音源（APU）エミュレータ
 * MML.Emu.APU2A03
 *
 * パルス波x2, 三角波, ノイズ, DPCM(DMC) の4チャンネルを実装。
 * clock() を1 CPUサイクルごとに呼び出し、mixSample() で現在の合成出力(0.0〜1.0)を取得する。
 * レジスタ $4000-$4017 への書き込みは writeRegister() で受け付ける。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];

  const TRIANGLE_SEQ = [
    15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  ];

  // NTSC ノイズ周期テーブル（NESdev準拠。値=シフトレジスタ更新間のCPUサイクル数）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // NTSC DMC レート(タイマ周期)テーブル
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  class Envelope {
    constructor() {
      this.startFlag = false;
      this.divider = 0;
      this.decay = 0;
      this.loop = false;
      this.constant = false;
      this.volume = 0; // constant時の音量 or envelope period
    }
    clockQuarterFrame() {
      if (this.startFlag) {
        this.startFlag = false;
        this.decay = 15;
        this.divider = this.volume;
      } else if (this.divider > 0) {
        this.divider--;
      } else {
        this.divider = this.volume;
        if (this.decay > 0) this.decay--;
        else if (this.loop) this.decay = 15;
      }
    }
    output() {
      return this.constant ? this.volume : this.decay;
    }
  }

  class PulseChannel {
    constructor(channelNum) {
      this.channelNum = channelNum; // 1 or 2 (スイープの符号反転に使用)
      this.enabled = false;
      this.duty = 0;
      this.dutyStep = 0;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.timerPeriod = 0;
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ
      this.sweepEnabled = false;
      this.sweepPeriod = 0;
      this.sweepDivider = 0;
      this.sweepNegate = false;
      this.sweepShift = 0;
      this.sweepReload = false;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4000/$4004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.envelope.loop = this.lengthCounterHalt;
          this.envelope.constant = (value & 0x10) !== 0;
          this.envelope.volume = value & 0x0F;
          break;
        case 1: // $4001/$4005
          this.sweepEnabled = (value & 0x80) !== 0;
          this.sweepPeriod = (value >> 4) & 0x07;
          this.sweepNegate = (value & 0x08) !== 0;
          this.sweepShift = value & 0x07;
          this.sweepReload = true;
          break;
        case 2: // $4002/$4006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $4003/$4007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envelope.startFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      this.envelope.clockQuarterFrame();
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;

      if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0) {
        const target = this.sweepTarget();
        if (target <= 0x7FF) this.timerPeriod = target;
      }
      if (this.sweepDivider === 0 || this.sweepReload) {
        this.sweepDivider = this.sweepPeriod;
        this.sweepReload = false;
      } else {
        this.sweepDivider--;
      }
    }

    sweepTarget() {
      const change = this.timerPeriod >> this.sweepShift;
      if (this.sweepNegate) {
        // パルス1は1の補数(さらに-1)、パルス2は2の補数
        return this.timerPeriod - change - (this.channelNum === 1 ? 1 : 0);
      }
      return this.timerPeriod + change;
    }

    isMuted() {
      return this.timerPeriod < 8 || this.sweepTarget() > 0x7FF;
    }

    output() {
      if (!this.enabled || this.lengthCounter === 0 || this.isMuted()) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.envelope.output();
    }
  }

  class TriangleChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.linearCounterReload = 0;
      this.linearCounter = 0;
      this.linearReloadFlag = false;
      this.timerPeriod = 0;
      this.timer = 0;
      // 初期位相は出力0の位置(TRIANGLE_SEQ[16]=0)に置く。消音時も最後の値を保持する仕様上、
      // seqStep=0(=最大値15)で始めると再生開始時に 0→15 のDC段差が生じプチノイズになるため。
      // 16 から進むと 0,1,2… と滑らかに立ち上がる。
      this.seqStep = 16;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4008
          this.lengthCounterHalt = (value & 0x80) !== 0;
          this.linearCounterReload = value & 0x7F;
          break;
        case 2: // $400A
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $400B
          // 実機の三角波はレジスタ書き込みでシーケンサ位相をリセットしない。
          // 位相を保持したまま発音を再開することで、音符の頭でのプチノイズ(位相跳躍)を防ぐ。
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.linearReloadFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        // 消音中(linear/length=0)や超音波域(period<2)はシーケンサを停止し、
        // 最後の位相＝最後の出力値をそのまま保持する（実機と同じ挙動）。
        if (this.linearCounter > 0 && this.lengthCounter > 0 && this.timerPeriod >= 2) {
          this.seqStep = (this.seqStep + 1) & 31;
        }
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      if (this.linearReloadFlag) this.linearCounter = this.linearCounterReload;
      else if (this.linearCounter > 0) this.linearCounter--;
      if (!this.lengthCounterHalt) this.linearReloadFlag = false;
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }

    output() {
      // 消音時も最後のシーケンサ値(DC)を保持する。0へ落とすと音符境界で段差が生じ、
      // プチノイズになる。保持したDC成分は出力段のDCブロッカー(Emu.dcBlock)が除去する。
      return TRIANGLE_SEQ[this.seqStep];
    }
  }

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.envelope = new Envelope();
      this.modeFlag = false;
      this.timerPeriod = (NOISE_PERIOD[0] >> 1) - 1;
      this.timer = 0;
      this.shiftReg = 1;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $400C
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.envelope.loop = this.lengthCounterHalt;
          this.envelope.constant = (value & 0x10) !== 0;
          this.envelope.volume = value & 0x0F;
          break;
        case 2: // $400E
          this.modeFlag = (value & 0x80) !== 0;
          // テーブル値はCPUサイクル周期。ノイズタイマはAPUサイクル(2 CPU)ごとに進むので÷2し、
          // カウンタは0到達で発火(reload+1周期)するため -1 する → 実効LFSR周期 = テーブル値CPUサイクル。
          this.timerPeriod = (NOISE_PERIOD[value & 0x0F] >> 1) - 1;
          break;
        case 3: // $400F
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.envelope.startFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        const bit0 = this.shiftReg & 1;
        const other = this.modeFlag ? ((this.shiftReg >> 6) & 1) : ((this.shiftReg >> 1) & 1);
        const feedback = bit0 ^ other;
        this.shiftReg = (this.shiftReg >> 1) | (feedback << 14);
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      this.envelope.clockQuarterFrame();
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }

    output() {
      if (!this.enabled || this.lengthCounter === 0 || (this.shiftReg & 1) === 1) return 0;
      return this.envelope.output();
    }
  }

  class DmcChannel {
    constructor(bus) {
      this.bus = bus;
      this.enabled = false;
      this.irqEnable = false;
      this.loop = false;
      this.rate = DMC_RATE[0];
      this.timer = 0;
      this.outputLevel = 0;
      this.sampleAddr = 0xC000;
      this.sampleLength = 0;
      this.currentAddr = 0xC000;
      this.bytesRemaining = 0;
      this.sampleBuffer = null;
      this.bitsRemaining = 0;
      this.shiftReg = 0;
      this.silence = true;
      this.irqFlag = false;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4010
          this.irqEnable = (value & 0x80) !== 0;
          this.loop = (value & 0x40) !== 0;
          this.rate = DMC_RATE[value & 0x0F];
          if (!this.irqEnable) this.irqFlag = false;
          break;
        case 1: // $4011
          this.outputLevel = value & 0x7F;
          break;
        case 2: // $4012
          this.sampleAddr = 0xC000 + (value * 64);
          break;
        case 3: // $4013
          this.sampleLength = (value * 16) + 1;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) {
        this.bytesRemaining = 0;
      } else if (this.bytesRemaining === 0) {
        this.currentAddr = this.sampleAddr;
        this.bytesRemaining = this.sampleLength;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.rate;
        this.clockOutput();
      } else {
        this.timer--;
      }
    }

    clockOutput() {
      if (this.bitsRemaining === 0) {
        this.bitsRemaining = 8;
        if (this.bytesRemaining > 0 && this.bus) {
          this.shiftReg = this.bus.read(this.currentAddr);
          this.silence = false;
          this.currentAddr = (this.currentAddr + 1) & 0xFFFF;
          if (this.currentAddr > 0xFFFF || this.currentAddr === 0x0000) this.currentAddr = 0x8000;
          this.bytesRemaining--;
          if (this.bytesRemaining === 0) {
            if (this.loop) {
              this.currentAddr = this.sampleAddr;
              this.bytesRemaining = this.sampleLength;
            } else if (this.irqEnable) {
              this.irqFlag = true;
            }
          }
        } else {
          this.silence = true;
        }
      }
      if (!this.silence) {
        if (this.shiftReg & 1) {
          if (this.outputLevel <= 125) this.outputLevel += 2;
        } else {
          if (this.outputLevel >= 2) this.outputLevel -= 2;
        }
        this.shiftReg >>= 1;
      }
      this.bitsRemaining--;
    }

    output() {
      return this.outputLevel;
    }
  }

  class APU2A03 {
    /**
     * @param {{read:(addr:number)=>number}} [bus] - DMCのサンプルデータ読み出しに使用
     */
    constructor(bus) {
      this.pulse1 = new PulseChannel(1);
      this.pulse2 = new PulseChannel(2);
      this.triangle = new TriangleChannel();
      this.noise = new NoiseChannel();
      this.dmc = new DmcChannel(bus || null);

      this.frameCounter = 0;
      this.frameMode5Step = false;
      this.frameIrqInhibit = false;
      this.frameIrqFlag = false;
      this.cycleParity = 0; // 0/1 交互（パルス・ノイズ・DMCはAPUサイクル=CPU2サイクルごと）

      // チャンネルごとのミュート設定（再生ON/OFF）
      this.mute = { pulse1: false, pulse2: false, triangle: false, noise: false, dmc: false };
    }

    reset() {
      this.pulse1.setEnabled(false);
      this.pulse2.setEnabled(false);
      this.triangle.setEnabled(false);
      this.triangle.seqStep = 16; // 曲開始時は三角波を出力0の位相にして開始時DC段差を防ぐ
      this.noise.setEnabled(false);
      this.dmc.setEnabled(false);
      this.frameCounter = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x4000: case 0x4001: case 0x4002: case 0x4003:
          this.pulse1.writeReg(addr - 0x4000, value); break;
        case 0x4004: case 0x4005: case 0x4006: case 0x4007:
          this.pulse2.writeReg(addr - 0x4004, value); break;
        case 0x4008: case 0x4009: case 0x400A: case 0x400B:
          this.triangle.writeReg(addr - 0x4008, value); break;
        case 0x400C: case 0x400D: case 0x400E: case 0x400F:
          this.noise.writeReg(addr - 0x400C, value); break;
        case 0x4010: case 0x4011: case 0x4012: case 0x4013:
          this.dmc.writeReg(addr - 0x4010, value); break;
        case 0x4015:
          this.pulse1.setEnabled((value & 0x01) !== 0);
          this.pulse2.setEnabled((value & 0x02) !== 0);
          this.triangle.setEnabled((value & 0x04) !== 0);
          this.noise.setEnabled((value & 0x08) !== 0);
          this.dmc.setEnabled((value & 0x10) !== 0);
          if ((value & 0x10) === 0) this.dmc.irqFlag = false;
          break;
        case 0x4017:
          this.frameMode5Step = (value & 0x80) !== 0;
          this.frameIrqInhibit = (value & 0x40) !== 0;
          if (this.frameIrqInhibit) this.frameIrqFlag = false;
          this.frameCounter = 0;
          if (this.frameMode5Step) { this.clockQuarterFrame(); this.clockHalfFrame(); }
          break;
      }
    }

    readStatus() {
      let v = 0;
      if (this.pulse1.lengthCounter > 0) v |= 0x01;
      if (this.pulse2.lengthCounter > 0) v |= 0x02;
      if (this.triangle.lengthCounter > 0) v |= 0x04;
      if (this.noise.lengthCounter > 0) v |= 0x08;
      if (this.dmc.bytesRemaining > 0) v |= 0x10;
      if (this.frameIrqFlag) v |= 0x40;
      if (this.dmc.irqFlag) v |= 0x80;
      this.frameIrqFlag = false;
      return v;
    }

    clockQuarterFrame() {
      this.pulse1.clockQuarterFrame();
      this.pulse2.clockQuarterFrame();
      this.triangle.clockQuarterFrame();
      this.noise.clockQuarterFrame();
    }

    clockHalfFrame() {
      this.pulse1.clockHalfFrame();
      this.pulse2.clockHalfFrame();
      this.triangle.clockHalfFrame();
      this.noise.clockHalfFrame();
    }

    // 1 CPUサイクル分進める
    clock() {
      // 三角波とDMCは毎CPUサイクル、パルス・ノイズはAPUサイクル(2 CPUサイクル)ごと。
      // DMC_RATE表はCPUサイクル単位の周期なので、DMCタイマもCPUクロックで進める
      // （APUサイクルで進めると周期が2倍=再生速度・音程が半分になる）。
      this.triangle.clockTimer();
      this.dmc.clockTimer();
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clockTimer();
        this.pulse2.clockTimer();
        this.noise.clockTimer();
      }

      this.frameCounter++;
      if (!this.frameMode5Step) {
        switch (this.frameCounter) {
          case 7457: this.clockQuarterFrame(); break;
          case 14913: this.clockQuarterFrame(); this.clockHalfFrame(); break;
          case 22371: this.clockQuarterFrame(); break;
          case 29829:
            this.clockQuarterFrame();
            this.clockHalfFrame();
            if (!this.frameIrqInhibit) this.frameIrqFlag = true;
            this.frameCounter = 0;
            break;
        }
      } else {
        switch (this.frameCounter) {
          case 7457: this.clockQuarterFrame(); break;
          case 14913: this.clockQuarterFrame(); this.clockHalfFrame(); break;
          case 22371: this.clockQuarterFrame(); break;
          case 37281:
            this.clockQuarterFrame();
            this.clockHalfFrame();
            this.frameCounter = 0;
            break;
        }
      }
    }

    /**
     * 現在の出力レベルを 0.0〜1.0 で取得する（NESの非線形ミキサー近似）
     */
    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : this.pulse1.output();
      const p2 = this.mute.pulse2 ? 0 : this.pulse2.output();
      const tri = this.mute.triangle ? 0 : this.triangle.output();
      const noi = this.mute.noise ? 0 : this.noise.output();
      const dmc = this.mute.dmc ? 0 : this.dmc.output();

      let pulseOut = 0;
      if (p1 + p2 > 0) pulseOut = 95.88 / (8128 / (p1 + p2) + 100);

      let tndOut = 0;
      const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
      if (tndSum > 0) tndOut = 159.79 / (1 / tndSum + 100);

      return pulseOut + tndOut; // おおよそ 0.0 〜 1.16
    }
  }

  Emu.APU2A03 = APU2A03;
  Emu.LENGTH_TABLE = LENGTH_TABLE;
})(globalThis);

/*
 * VRC6 拡張音源エミュレータ
 * MML.Emu.VRC6Audio
 *
 * パルス x2 ($9000-$9002 / $A000-$A002) + 矩形波(サウ) ($B000-$B002)
 * パルスはデューティ比1/16刻みで指定可能(0=幅1/16 ... 15=幅16/16)。
 * サウ(sawtooth)はNESdev準拠の14ステップアキュムレータ実装。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class Vrc6Pulse {
    constructor() {
      this.duty = 0;
      this.volume = 0;
      this.digitized = false;
      this.enabled = false;
      this.period = 0;
      this.timer = 0;
      this.step = 15; // dutyカウンタは 15→0 のダウンカウント。先頭=15
    }
    writeCtrl(value) {
      this.duty = (value >> 4) & 0x07;
      this.volume = value & 0x0F;
      this.digitized = (value & 0x80) !== 0;
    }
    writePeriodLo(value) {
      this.period = (this.period & 0x0F00) | value;
    }
    writePeriodHi(value) {
      this.period = (this.period & 0x00FF) | ((value & 0x0F) << 8);
      this.enabled = (value & 0x80) !== 0;
      // NESdev: E=0 で duty カウンタを即リセット＋停止（再有効化で先頭から）
      if (!this.enabled) { this.step = 15; this.timer = 0; }
    }
    clock() {
      if (!this.enabled) return; // 無効時は停止（カウンタを進めない）
      if (this.timer === 0) {
        this.timer = this.period;
        this.step = (this.step - 1) & 0x0F; // 15→0 ダウンカウント
      } else {
        this.timer--;
      }
    }
    output() {
      if (!this.enabled) return 0;
      if (this.digitized) return this.volume;
      return (this.step <= this.duty) ? this.volume : 0;
    }
  }

  class Vrc6Saw {
    constructor() {
      this.accumRate = 0;
      this.accum = 0;
      this.enabled = false;
      this.period = 0;
      this.timer = 0;
      this.step = 0; // 14ステップ周期のカウンタ (0-13)
    }
    writeCtrl(value) {
      this.accumRate = value & 0x3F;
    }
    writePeriodLo(value) {
      this.period = (this.period & 0x0F00) | value;
    }
    writePeriodHi(value) {
      this.period = (this.period & 0x00FF) | ((value & 0x0F) << 8);
      this.enabled = (value & 0x80) !== 0;
    }
    // NESdev準拠: タイマは1 CPUサイクルごと。14ステップ周期で、偶数ステップに accumRate を
    // 6回加算し、14ステップ目で加算せずアキュムレータを0リセット（＝7段のこぎり波、f=CPU/(14*(t+1))）。
    clock() {
      if (!this.enabled) { this.accum = 0; return; } // E=0 でアキュムレータ0固定
      if (this.timer === 0) {
        this.timer = this.period;
        this.step++;
        if (this.step >= 14) {
          this.step = 0;
          this.accum = 0;                 // 7回目の作用クロック = リセット
        } else if ((this.step & 1) === 0) {
          this.accum = (this.accum + this.accumRate) & 0xFF; // 偶数ステップで加算(計6回)
        }
      } else {
        this.timer--;
      }
    }
    output() {
      if (!this.enabled) return 0;
      return (this.accum >> 3) & 0x1F; // 上位5bit (0-31)
    }
  }

  class VRC6Audio {
    constructor() {
      this.pulse1 = new Vrc6Pulse();
      this.pulse2 = new Vrc6Pulse();
      this.saw = new Vrc6Saw();
      this.mute = { pulse1: false, pulse2: false, saw: false };
    }

    reset() {
      this.pulse1 = new Vrc6Pulse();
      this.pulse2 = new Vrc6Pulse();
      this.saw = new Vrc6Saw();
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x9000: this.pulse1.writeCtrl(value); break;
        case 0x9001: this.pulse1.writePeriodLo(value); break;
        case 0x9002: this.pulse1.writePeriodHi(value); break;
        case 0xA000: this.pulse2.writeCtrl(value); break;
        case 0xA001: this.pulse2.writePeriodLo(value); break;
        case 0xA002: this.pulse2.writePeriodHi(value); break;
        case 0xB000: this.saw.writeCtrl(value); break;
        case 0xB001: this.saw.writePeriodLo(value); break;
        case 0xB002: this.saw.writePeriodHi(value); break;
      }
    }

    clock() {
      this.pulse1.clock();
      this.pulse2.clock();
      this.saw.clock();
    }

    // 0.0 ~ 約0.65 (2A03と同程度のレベル感)
    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : this.pulse1.output() / 15;   // 0-1
      const p2 = this.mute.pulse2 ? 0 : this.pulse2.output() / 15;   // 0-1
      const sw = this.mute.saw ? 0 : this.saw.output() / 31;         // 0-1
      return (p1 + p2 + sw) * 0.2;
    }
  }

  Emu.VRC6Audio = VRC6Audio;
})(globalThis);

/*
 * VRC7 拡張音源エミュレータ (OPLL / YM2413)
 * MML.Emu.VRC7Audio
 *
 * Mitsutaka Okazaki の emu2413 (VirtuaNES同梱版) を忠実に移植した2オペレータFM。
 * 6メロディチャンネル。DB単位系(0.375dB/step)・512点対数sin・DB2LIN・正確なEG状態機械。
 * 音色ROMは VirtuaNES vrc7tone.h。
 *   $9010 : アドレスポート  $9030 : データポート
 * 出力49716Hz (VRC7マスタ3.58MHz/72 = CPUクロック/36)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 6;
  const CYCLES_PER_SAMPLE = 36;
  const SAMPLE_RATE = 49716;

  // ---- 定数 (emu2413) ----
  const PG_BITS = 9, PG_WIDTH = 1 << PG_BITS;        // 512点波形
  const DP_BITS = 18, DP_WIDTH = 1 << DP_BITS, DP_BASE_BITS = DP_BITS - PG_BITS; // 9
  const DB_STEP = 0.375, DB_BITS = 7, DB_MUTE = 1 << DB_BITS;   // 128
  const EG_STEP = 0.375, EG_BITS = 7;
  const EG2DB = 1;                                    // EG_STEP/DB_STEP
  const TL2EG = 2;                                    // TL_STEP/EG_STEP (0.75/0.375)
  const DB2LIN_AMP_BITS = 10, SLOT_AMP_BITS = DB2LIN_AMP_BITS;
  const EG_DP_BITS = 22, EG_DP_WIDTH = 1 << EG_DP_BITS;
  const PM_PG_BITS = 8, PM_PG_WIDTH = 1 << PM_PG_BITS;
  const PM_DP_BITS = 16, PM_DP_WIDTH = 1 << PM_DP_BITS;
  const AM_PG_BITS = 8, AM_PG_WIDTH = 1 << AM_PG_BITS;
  const AM_DP_BITS = 16, AM_DP_WIDTH = 1 << AM_DP_BITS;
  const PM_AMP_BITS = 8, PM_AMP = 1 << PM_AMP_BITS;
  const PM_SPEED = 6.4, PM_DEPTH = 13.75, AM_SPEED = 3.7, AM_DEPTH = 4.8;

  // EGモード
  const SETTLE = 0, ATTACK = 1, DECAY = 2, SUSHOLD = 3, SUSTINE = 4, RELEASE = 5, FINISH = 6;

  // ---- 音色ROM (VirtuaNES vrc7tone.h, 各8バイト=$00-$07) ----
  const VRC7_INST = [
    [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00],
    [0x33,0x01,0x09,0x0e,0x94,0x90,0x40,0x01],
    [0x13,0x41,0x0f,0x0d,0xce,0xd3,0x43,0x13],
    [0x01,0x12,0x1b,0x06,0xff,0xd2,0x00,0x32],
    [0x61,0x61,0x1b,0x07,0xaf,0x63,0x20,0x28],
    [0x22,0x21,0x1e,0x06,0xf0,0x76,0x08,0x28],
    [0x66,0x21,0x15,0x00,0x93,0x94,0x20,0xf8],
    [0x21,0x61,0x1c,0x07,0x82,0x81,0x10,0x17],
    [0x23,0x21,0x20,0x1f,0xc0,0x71,0x07,0x47],
    [0x25,0x31,0x26,0x05,0x64,0x41,0x18,0xf8],
    [0x17,0x21,0x28,0x07,0xff,0x83,0x02,0xf8],
    [0x97,0x81,0x25,0x07,0xcf,0xc8,0x02,0x14],
    [0x21,0x21,0x54,0x0f,0x80,0x7f,0x07,0x07],
    [0x01,0x01,0x56,0x03,0xd3,0xb2,0x43,0x58],
    [0x31,0x21,0x0c,0x03,0x82,0xc0,0x40,0x07],
    [0x21,0x01,0x0c,0x03,0xd4,0xd3,0x40,0x84]
  ];

  // dump(8byte) → {mod,car} パッチ (emu2413 dump2patch)
  function dump2patch(d) {
    return {
      mod: { AM:(d[0]>>7)&1, PM:(d[0]>>6)&1, EG:(d[0]>>5)&1, KR:(d[0]>>4)&1, ML:d[0]&15,
             KL:(d[2]>>6)&3, TL:d[2]&63, FB:d[3]&7, WF:(d[3]>>3)&1,
             AR:(d[4]>>4)&15, DR:d[4]&15, SL:(d[6]>>4)&15, RR:d[6]&15 },
      car: { AM:(d[1]>>7)&1, PM:(d[1]>>6)&1, EG:(d[1]>>5)&1, KR:(d[1]>>4)&1, ML:d[1]&15,
             KL:(d[3]>>6)&3, TL:0, FB:0, WF:(d[3]>>4)&1,
             AR:(d[5]>>4)&15, DR:d[5]&15, SL:(d[7]>>4)&15, RR:d[7]&15 }
    };
  }
  const PATCH = VRC7_INST.map(dump2patch); // [16] {mod,car}

  // ---- テーブル ----
  function Min(a, b) { return a < b ? a : b; }

  // AR用 線形→対数
  const AR_ADJUST = new Uint32Array(1 << EG_BITS);
  AR_ADJUST[0] = 1 << EG_BITS;
  for (let i = 1; i < 128; i++)
    AR_ADJUST[i] = ((1 << EG_BITS) - 1 - (1 << EG_BITS) * Math.log(i) / Math.log(128)) | 0;

  // DB2LIN
  const DB2LIN = new Int32Array((DB_MUTE + DB_MUTE) * 2);
  for (let i = 0; i < DB_MUTE + DB_MUTE; i++) {
    let v = (((1 << DB2LIN_AMP_BITS) - 1) * Math.pow(10, -i * DB_STEP / 20)) | 0;
    if (i >= DB_MUTE) v = 0;
    DB2LIN[i] = v;
    DB2LIN[i + DB_MUTE + DB_MUTE] = -v;
  }

  function lin2db(d) {
    if (d === 0) return DB_MUTE - 1;
    return Min(-(((20.0 * Math.log10(d)) / DB_STEP) | 0), DB_MUTE - 1);
  }

  // sinテーブル (0=full, 1=half)
  const fullsin = new Uint32Array(PG_WIDTH);
  const halfsin = new Uint32Array(PG_WIDTH);
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[i] = lin2db(Math.sin(2.0 * Math.PI * i / PG_WIDTH));
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[PG_WIDTH / 2 - 1 - i] = fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) fullsin[PG_WIDTH / 2 + i] = DB_MUTE + DB_MUTE + fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) halfsin[i] = fullsin[i];
  for (let i = PG_WIDTH / 2; i < PG_WIDTH; i++) halfsin[i] = fullsin[0];
  const WAVEFORM = [fullsin, halfsin];

  // LFO
  const pmtable = new Int32Array(PM_PG_WIDTH);
  for (let i = 0; i < PM_PG_WIDTH; i++)
    pmtable[i] = (PM_AMP * Math.pow(2, PM_DEPTH * Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH) / 1200)) | 0;
  const amtable = new Int32Array(AM_PG_WIDTH);
  for (let i = 0; i < AM_PG_WIDTH; i++)
    amtable[i] = (AM_DEPTH / 2 / DB_STEP * (1.0 + Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH))) | 0;

  // clk/rate はネイティブ(49716Hz)固定なので rate_adjust=恒等。
  // dphaseTable[fnum][block][ML]
  const MLT = [1, 1*2, 2*2, 3*2, 4*2, 5*2, 6*2, 7*2, 8*2, 9*2, 10*2, 10*2, 12*2, 12*2, 15*2, 15*2];
  const dphaseTable = [];
  for (let fnum = 0; fnum < 512; fnum++) {
    const a = []; dphaseTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Uint32Array(16); a.push(b);
      for (let ML = 0; ML < 16; ML++)
        b[ML] = (((fnum * MLT[ML]) << block) >> (20 - DP_BITS)) >>> 0;
    }
  }

  // tllTable[fnum4][block][TL][KL]
  const KL_DB2 = [0.000,9.000,12.000,13.875,15.000,16.125,16.875,17.625,18.000,18.750,19.125,19.500,19.875,20.250,20.625,21.000].map(x => (x * 2) | 0);
  const tllTable = [];
  for (let fnum = 0; fnum < 16; fnum++) {
    const a = []; tllTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = []; a.push(b);
      for (let TL = 0; TL < 64; TL++) {
        const c = new Uint32Array(4); b.push(c);
        for (let KL = 0; KL < 4; KL++) {
          if (KL === 0) c[KL] = (TL2EG * TL) >>> 0;
          else {
            const tmp = KL_DB2[fnum] - (3 * 2) * (7 - block);
            if (tmp <= 0) c[KL] = (TL2EG * TL) >>> 0;
            else c[KL] = (((tmp >> (3 - KL)) / EG_STEP) | 0) + TL2EG * TL;
          }
        }
      }
    }
  }

  // rksTable[fnum8][block][KR]
  const rksTable = [];
  for (let f8 = 0; f8 < 2; f8++) {
    const a = []; rksTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Int32Array(2); a.push(b);
      b[0] = block >> 1;
      b[1] = (block << 1) + f8;
    }
  }

  // dphaseARTable[AR][Rks], dphaseDRTable[DR][Rks]
  const dphaseARTable = [], dphaseDRTable = [];
  for (let AR = 0; AR < 16; AR++) {
    const a = new Uint32Array(16); dphaseARTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = AR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (AR === 0) a[Rks] = 0;
      else if (AR === 15) a[Rks] = EG_DP_WIDTH;
      else a[Rks] = ((3 * (RL + 4)) << (RM + 1)) >>> 0;
    }
  }
  for (let DR = 0; DR < 16; DR++) {
    const a = new Uint32Array(16); dphaseDRTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = DR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (DR === 0) a[Rks] = 0;
      else a[Rks] = ((RL + 4) << (RM - 1)) >>> 0;
    }
  }

  // SL[16] (eg_phase単位)
  const SL_DB = [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,48];
  const SL = new Uint32Array(16);
  for (let i = 0; i < 16; i++) SL[i] = ((((SL_DB[i] / 3.0) * 8) | 0) << (EG_DP_BITS - EG_BITS)) >>> 0;

  const pm_dphase = ((PM_SPEED * PM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;
  const am_dphase = ((AM_SPEED * AM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;

  // ---- スロット ----
  class Slot {
    constructor(type) {
      this.type = type; // 0=mod 1=car
      this.patch = PATCH[0].mod;
      this.reset();
    }
    reset() {
      this.sintbl = WAVEFORM[0];
      this.phase = 0; this.dphase = 0; this.pgout = 0;
      this.output = [0, 0]; this.feedback = 0;
      this.eg_mode = SETTLE; this.eg_phase = EG_DP_WIDTH; this.eg_dphase = 0; this.egout = 0;
      this.fnum = 0; this.block = 0; this.volume = 0; this.sustine = 0;
      this.tll = 0; this.rks = 0;
    }
    calcEgDphase() {
      const p = this.patch;
      switch (this.eg_mode) {
        case ATTACK: return dphaseARTable[p.AR][this.rks];
        case DECAY: return dphaseDRTable[p.DR][this.rks];
        case SUSHOLD: return 0;
        case SUSTINE: return dphaseDRTable[p.RR][this.rks];
        case RELEASE:
          if (this.sustine) return dphaseDRTable[5][this.rks];
          else if (p.EG) return dphaseDRTable[p.RR][this.rks];
          else return dphaseDRTable[7][this.rks];
        default: return 0;
      }
    }
    updatePG() { this.dphase = dphaseTable[this.fnum][this.block][this.patch.ML]; }
    updateTLL() {
      this.tll = (this.type === 0)
        ? tllTable[this.fnum >> 5][this.block][this.patch.TL][this.patch.KL]
        : tllTable[this.fnum >> 5][this.block][this.volume][this.patch.KL];
    }
    updateRKS() { this.rks = rksTable[this.fnum >> 8][this.block][this.patch.KR]; }
    updateWF() { this.sintbl = WAVEFORM[this.patch.WF]; }
    updateEG() { this.eg_dphase = this.calcEgDphase(); }
    updateAll() { this.updatePG(); this.updateTLL(); this.updateRKS(); this.updateWF(); this.updateEG(); }
    slotOn() { this.eg_mode = ATTACK; this.phase = 0; this.eg_phase = 0; }
    slotOff() {
      if (this.eg_mode === ATTACK)
        this.eg_phase = (AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F] << (EG_DP_BITS - EG_BITS)) >>> 0;
      this.eg_mode = RELEASE;
    }
    calcPhase(lfo_pm) {
      if (this.patch.PM) this.phase = (this.phase + (((this.dphase * lfo_pm) >> PM_AMP_BITS) >>> 0)) >>> 0;
      else this.phase = (this.phase + this.dphase) >>> 0;
      this.phase &= (DP_WIDTH - 1);
      this.pgout = this.phase >>> DP_BASE_BITS;
      return this.pgout;
    }
    calcEnvelope(lfo_am) {
      let egout;
      switch (this.eg_mode) {
        case ATTACK:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          if (this.eg_phase & EG_DP_WIDTH) { egout = 0; this.eg_phase = 0; this.eg_mode = DECAY; this.updateEG(); }
          else egout = AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F];
          break;
        case DECAY:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.eg_phase >= SL[this.patch.SL]) {
            this.eg_phase = SL[this.patch.SL];
            this.eg_mode = this.patch.EG ? SUSHOLD : SUSTINE;
            this.updateEG();
            egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          }
          break;
        case SUSHOLD:
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.patch.EG === 0) { this.eg_mode = SUSTINE; this.updateEG(); }
          break;
        case SUSTINE:
        case RELEASE:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (egout >= (1 << EG_BITS)) { this.eg_mode = FINISH; egout = (1 << EG_BITS) - 1; }
          break;
        case FINISH: default:
          egout = (1 << EG_BITS) - 1;
          break;
      }
      egout = this.patch.AM ? (EG2DB * (egout + this.tll) + lfo_am) : (EG2DB * (egout + this.tll));
      if (egout >= DB_MUTE) egout = DB_MUTE - 1;
      this.egout = egout;
      return egout;
    }
  }

  // wave2_8pi(e) = e<<1 (SLOT_AMP_BITS-PG_BITS-2 = -1)
  function wave2_8pi(e) { return e << 1; }
  // wave2_4pi(e) = e (SLOT_AMP_BITS-PG_BITS-1 = 0)

  class Vrc7Channel {
    constructor() {
      this.mod = new Slot(0);
      this.car = new Slot(1);
      this.patchNumber = 0;
      this.keyStatus = 0;
    }
    reset() { this.mod.reset(); this.car.reset(); this.keyStatus = 0; }

    calcModulator(lfo_am, lfo_pm) {
      const s = this.mod;
      s.output[1] = s.output[0];
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) s.output[0] = 0;
      else if (s.patch.FB !== 0) {
        const fm = (s.feedback) >> (7 - s.patch.FB); // wave2_4pi(feedback)=feedback
        s.output[0] = DB2LIN[s.sintbl[(pgout + fm) & (PG_WIDTH - 1)] + egout];
      } else {
        s.output[0] = DB2LIN[s.sintbl[pgout] + egout];
      }
      s.feedback = (s.output[1] + s.output[0]) >> 1;
      return s.feedback;
    }
    calcCarrier(fm, lfo_am, lfo_pm) {
      const s = this.car;
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) return 0;
      return DB2LIN[s.sintbl[(pgout + wave2_8pi(fm)) & (PG_WIDTH - 1)] + egout];
    }
  }

  class VRC7Audio {
    constructor() { this._init(); this.mute = new Array(NUM_CH).fill(false); }
    _init() {
      this.addr = 0;
      this.reg = new Uint8Array(0x40);
      this.patches = [];               // [16] {mod,car} (音色0はカスタム, 可変)
      for (let i = 0; i < 16; i++) this.patches.push({ mod: Object.assign({}, PATCH[i].mod), car: Object.assign({}, PATCH[i].car) });
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) { const c = new Vrc7Channel(); this.channels.push(c); this._setPatch(i, 0); }
      this.pm_phase = 0; this.am_phase = 0; this.lfo_pm = 0; this.lfo_am = 0;
      this.cyc = 0; this.lastSample = 0;
    }
    reset() { this._init(); }

    _setPatch(i, num) {
      const c = this.channels[i];
      c.patchNumber = num;
      c.mod.patch = this.patches[num].mod;
      c.car.patch = this.patches[num].car;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0x9010) this.addr = value & 0x3F;
      else if (addr === 0x9030) this.writeReg(this.addr, value);
    }

    writeReg(reg, data) {
      reg &= 0x3F; data &= 0xFF;
      const cust = this.patches[0];
      if (reg <= 0x07) {
        // カスタム音色
        switch (reg) {
          case 0x00: cust.mod.AM=(data>>7)&1; cust.mod.PM=(data>>6)&1; cust.mod.EG=(data>>5)&1; cust.mod.KR=(data>>4)&1; cust.mod.ML=data&15; break;
          case 0x01: cust.car.AM=(data>>7)&1; cust.car.PM=(data>>6)&1; cust.car.EG=(data>>5)&1; cust.car.KR=(data>>4)&1; cust.car.ML=data&15; break;
          case 0x02: cust.mod.KL=(data>>6)&3; cust.mod.TL=data&63; break;
          case 0x03: cust.car.KL=(data>>6)&3; cust.car.WF=(data>>4)&1; cust.mod.WF=(data>>3)&1; cust.mod.FB=data&7; break;
          case 0x04: cust.mod.AR=(data>>4)&15; cust.mod.DR=data&15; break;
          case 0x05: cust.car.AR=(data>>4)&15; cust.car.DR=data&15; break;
          case 0x06: cust.mod.SL=(data>>4)&15; cust.mod.RR=data&15; break;
          case 0x07: cust.car.SL=(data>>4)&15; cust.car.RR=data&15; break;
        }
        for (let i = 0; i < NUM_CH; i++) if (this.channels[i].patchNumber === 0) { this.channels[i].mod.updateAll(); this.channels[i].car.updateAll(); }
      } else if (reg >= 0x10 && reg <= 0x15) {
        const ch = reg - 0x10, c = this.channels[ch];
        const fnum = data + ((this.reg[0x20 + ch] & 1) << 8);
        c.mod.fnum = c.car.fnum = fnum;
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x20 && reg <= 0x25) {
        const ch = reg - 0x20, c = this.channels[ch];
        const fnum = ((data & 1) << 8) + this.reg[0x10 + ch];
        const block = (data >> 1) & 7;
        c.mod.fnum = c.car.fnum = fnum; c.mod.block = c.car.block = block;
        // sustine
        if ((this.reg[reg] ^ data) & 0x20) { c.car.sustine = (data >> 5) & 1; }
        // key on/off
        const key = (data & 0x10) !== 0;
        if (key) { if (!c.keyStatus) { c.mod.slotOn(); c.car.slotOn(); } c.keyStatus = 1; }
        else { if (c.keyStatus) c.car.slotOff(); c.keyStatus = 0; }
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x30 && reg <= 0x35) {
        const ch = reg - 0x30, c = this.channels[ch];
        this._setPatch(ch, (data >> 4) & 15);
        c.car.volume = (data & 15) << 2; // 6bit
        c.mod.updateAll(); c.car.updateAll();
      }
      this.reg[reg] = data;
    }

    _updateAMPM() {
      this.pm_phase = (this.pm_phase + pm_dphase) & (PM_DP_WIDTH - 1);
      this.am_phase = (this.am_phase + am_dphase) & (AM_DP_WIDTH - 1);
      this.lfo_am = amtable[this.am_phase >>> (AM_DP_BITS - AM_PG_BITS)];
      this.lfo_pm = pmtable[this.pm_phase >>> (PM_DP_BITS - PM_PG_BITS)];
    }

    _calc() {
      this._updateAMPM();
      let inst = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.channels[i];
        if (c.car.eg_mode === FINISH) continue;
        const fm = c.calcModulator(this.lfo_am, this.lfo_pm);
        const out = c.calcCarrier(fm, this.lfo_am, this.lfo_pm);
        if (!this.mute[i]) inst += out;
      }
      return inst; // ±(1023*6)
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this.lastSample = this._calc();
    }

    mixSample() {
      // emu2413: out16 = clamp(inst*8). ここでは -1..1 に正規化しゲイン調整。
      return (this.lastSample / 4096) * 0.5;
    }
  }

  // ---- 鍵盤表示用スナップショット ----
  Emu.snapshotVRC7 = function (chip) {
    const out = [];
    const N = 128; // FM連続波形なので線形補間前提で高めの解像度
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.channels[i];
      const mod = c.mod, car = c.car;
      const freq = (c.keyStatus && car.fnum > 0) ? SAMPLE_RATE * car.fnum / Math.pow(2, 19 - car.block) : 0;
      const active = c.keyStatus && car.eg_mode !== FINISH && car.eg_mode !== SETTLE;
      // 現在のオペレータ状態で1周期のFM波形を合成
      const modEg = mod.egout, carEg = car.egout;
      const ratio = car.dphase > 0 ? mod.dphase / car.dphase : 1;
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const cp = Math.round((k / N) * PG_WIDTH) & (PG_WIDTH - 1);
        const mp = Math.round((k / N) * ratio * PG_WIDTH) & (PG_WIDTH - 1);
        const mo = DB2LIN[mod.sintbl[mp] + Math.min(DB_MUTE - 1, modEg)];
        const co = (carEg >= DB_MUTE - 1) ? 0 : DB2LIN[car.sintbl[(cp + (mo << 1)) & (PG_WIDTH - 1)] + carEg];
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      out.push({
        freq,
        vol: (15 - (c.car.volume >> 2)) / 15,
        rawVol: c.car.volume >> 2,
        instrument: c.patchNumber,
        active,
        waveData: active ? wave : new Array(N).fill(0)
      });
    }
    return out;
  };

  Emu.VRC7Audio = VRC7Audio;
})(globalThis);

/*
 * FDS (ディスクシステム) 拡張音源エミュレータ
 * MML.Emu.FDSAudio
 *
 * 64サンプル(6bit)のウェーブテーブル波形メモリ音源 + ボリュームエンベロープ + ピッチモジュレータ。
 *
 *   $4040-$407F : 波形メモリ(6bit, $4089 bit7=1 の間のみ書き込み可)
 *   $4080       : ボリュームエンベロープ (bit7=1:直接指定, bit6=方向, bits0-5=速度/ゲイン)
 *   $4082       : 周波数下位8bit
 *   $4083       : bits0-3=周波数上位4bit, bit6=エンベロープ停止, bit7=1で消音/波形リセット
 *   $4084       : モジュレータゲイン/エンベロープ (同形式)。ゲインはピッチ変調の深さを決める(0=変調なし)
 *   $4085       : モジュレータカウンタ直接設定 (7bit符号付き)
 *   $4086       : モジュレータ周波数下位8bit
 *   $4087       : bits0-3=モジュレータ周波数上位4bit, bit7=1で停止
 *   $4088       : モジュレータテーブル書き込み (停止中のみ有効, 下位3bit)
 *   $4089       : bit7=波形メモリ書き込み許可, bits0-1=マスターボリューム
 *   $408A       : エンベロープ速度マスタ (0=最速, 値が大きいほど遅い)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // NESdev 準拠: マスターボリューム 0=全量, 1=2/3, 2=2/4, 3=2/5
  const MASTER_VOLUME_SCALE = [1.0, 2 / 3, 2 / 4, 2 / 5];

  // モジュレータテーブルの3bitエントリをカウンタ増分に変換
  // 0=+0, 1=+1, 2=+2, 3=+4, 4=リセット(0), 5=-4, 6=-2, 7=-1
  const MOD_TABLE_DELTA = [0, 1, 2, 4, 0, -4, -2, -1];

  class FDSAudio {
    constructor() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;

      // ボリュームエンベロープ
      this.volEnvEnabled = false; // bit7=0 のとき有効
      this.volEnvIncrease = false; // bit6
      this.volEnvSpeed = 0;        // bits0-5 (リロード値)
      this.volGain = 32;           // 実際の出力ゲイン (0-32)
      this.volEnvTimer = 0;

      // メインチャンネル
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false; // $4083 bit6
      this.phaseAcc = 0;

      // モジュレータエンベロープ
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;

      // モジュレータ
      this.modFreq = 0;
      this.modEnabled = false; // bit7=0 のとき有効
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(32); // 生3bit値 (0-7)
      this.modWritePos = 0;
      this.modTablePos = 0;   // 再生位置
      this.modCounter = 0;    // 現在のモジュレータ出力値 (-64..63)

      // エンベロープマスタ速度レジスタ ($408A)
      // FDS 電源ON時デフォルト = $E8 = 232 (実機ハードウェア仕様)
      // ゲームが $408A を書かない場合もこの値が使われる
      this.envRate = 0xE8;
      this.envRateClock = 0;

      this.mute = { wave: false };
    }

    reset() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;
      this.volEnvEnabled = false;
      this.volEnvIncrease = false;
      this.volEnvSpeed = 0;
      this.volGain = 32;
      this.volEnvTimer = 0;
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false;
      this.phaseAcc = 0;
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;
      this.modFreq = 0;
      this.modEnabled = false;
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(32);
      this.modWritePos = 0;
      this.modTablePos = 0;
      this.modCounter = 0;
      this.envRate = 0xE8; // FDS 電源ON時デフォルト
      this.envRateClock = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x4040 && addr <= 0x407F) {
        if (this.waveWriteEnable) this.wave[addr - 0x4040] = value & 0x3F;
      } else if (addr === 0x4080) {
        if (value & 0x80) {
          // 直接指定モード: bits0-5 をゲインとして即時反映
          this.volEnvEnabled = false;
          this.volGain = value & 0x3F;
        } else {
          // エンベロープモード
          this.volEnvEnabled = true;
          this.volEnvIncrease = (value & 0x40) !== 0;
          this.volEnvSpeed = value & 0x3F;
          this.volEnvTimer = this.volEnvSpeed + 1;
        }
      } else if (addr === 0x4082) {
        this.freq = (this.freq & 0x0F00) | value;
      } else if (addr === 0x4083) {
        this.freq = (this.freq & 0x00FF) | ((value & 0x0F) << 8);
        this.envHalt = (value & 0x40) !== 0;
        this.disabled = (value & 0x80) !== 0;
        if (this.disabled) this.phaseAcc = 0;
      } else if (addr === 0x4084) {
        if (value & 0x80) {
          this.modEnvEnabled = false;
          this.modGain = value & 0x3F;
        } else {
          this.modEnvEnabled = true;
          this.modEnvIncrease = (value & 0x40) !== 0;
          this.modEnvSpeed = value & 0x3F;
          this.modEnvTimer = this.modEnvSpeed + 1;
        }
      } else if (addr === 0x4085) {
        // モジュレータカウンタを直接設定 (7bit符号付き)
        const v = value & 0x7F;
        this.modCounter = (v >= 64) ? (v - 128) : v;
      } else if (addr === 0x4086) {
        this.modFreq = (this.modFreq & 0x0F00) | value;
      } else if (addr === 0x4087) {
        this.modFreq = (this.modFreq & 0x00FF) | ((value & 0x0F) << 8);
        this.modEnabled = (value & 0x80) === 0;
        if (!this.modEnabled) {
          // 停止時: 書き込み位置・再生位置・位相をリセット
          this.modPhaseAcc = 0;
          this.modWritePos = 0;
          this.modTablePos = 0;
        }
      } else if (addr === 0x4088) {
        // モジュレータ停止中にテーブルを書き込む (1エントリ = 3bit)
        if (!this.modEnabled) {
          this.modTable[this.modWritePos] = value & 0x07;
          this.modWritePos = (this.modWritePos + 1) & 0x1F;
        }
      } else if (addr === 0x4089) {
        this.waveWriteEnable = (value & 0x80) !== 0;
        this.masterVolume = value & 0x03;
      } else if (addr === 0x408A) {
        this.envRate = value;
        this.envRateClock = 0;
      }
    }

    // バス読み出し ($4090 = ボリュームエンベロープ出力, $4092 = モジュレータエンベロープ出力)
    readRegister(addr) {
      if (addr === 0x4090) return this.volGain & 0x3F;
      if (addr === 0x4092) return this.modGain & 0x3F;
      return 0;
    }

    // エンベロープを1ティック進める (エンベロープマスタ速度に応じて呼ばれる)
    _clockEnvelope() {
      // ボリュームエンベロープ
      if (this.volEnvEnabled && !this.envHalt) {
        this.volEnvTimer--;
        if (this.volEnvTimer <= 0) {
          this.volEnvTimer = this.volEnvSpeed + 1;
          if (this.volEnvIncrease) {
            if (this.volGain < 32) this.volGain++;
          } else {
            if (this.volGain > 0) this.volGain--;
          }
        }
      }
      // モジュレータエンベロープ
      if (this.modEnvEnabled && !this.envHalt) {
        this.modEnvTimer--;
        if (this.modEnvTimer <= 0) {
          this.modEnvTimer = this.modEnvSpeed + 1;
          if (this.modEnvIncrease) {
            if (this.modGain < 32) this.modGain++;
          } else {
            if (this.modGain > 0) this.modGain--;
          }
        }
      }
    }

    clock() {
      // エンベロープクロック: period = MAX(8, envRate × 8) CPU サイクルに1回
      // $408A=0 → period=8 (最速), $408A=$E8=232(デフォルト) → period=1864 cycles
      this.envRateClock++;
      const envPeriod = this.envRate === 0 ? 8 : this.envRate * 8;
      if (this.envRateClock >= envPeriod) {
        this.envRateClock = 0;
        this._clockEnvelope();
      }

      // モジュレータ: APUクロック(CPU/2)相当、オーバーフロー閾値 = 2 × 65536 = 131072
      // レジスタログ実測: modFreq=16 で 6.83 Hz ビブラート → 16×1789773/(32×131072)=6.83Hz ✓
      if (this.modEnabled && this.modFreq > 0) {
        this.modPhaseAcc += this.modFreq;
        while (this.modPhaseAcc >= 131072) {
          this.modPhaseAcc -= 131072;
          const raw = this.modTable[this.modTablePos];
          this.modTablePos = (this.modTablePos + 1) & 0x1F;
          if (raw === 4) {
            // リセット: カウンタを0に
            this.modCounter = 0;
          } else {
            this.modCounter += MOD_TABLE_DELTA[raw];
            // クランプ (-64..63)
            if (this.modCounter > 63) this.modCounter = 63;
            if (this.modCounter < -64) this.modCounter = -64;
          }
        }
      }

      // メインチャンネル
      if (this.disabled || this.freq === 0) return;

      // ピッチ変調: NESdev FDS audio 準拠の実機アルゴリズム
      //   1. temp = modCounter × modGain          （gain=$4084。gain=0なら変調ゼロ）
      //   2. 4bit右シフト(符号保持)、下位4bitに端数があり結果が非負なら+1(切り上げ)
      //   3. effectiveFreq = freq + freq × delta / 64
      // ★注意: 以前は「+0x400してから8bitマスク、-64」という手順で(2)(3)を行って
      // いたが、これは|temp|(=|modCounter×modGain|)が0x400(1024)未満の範囲でしか
      // 正しく機能しない近似で、modGainが大きくmodCounterが強く負に振れる(絶対値の
      // 積が1024を超える)と8bitマスクで符号が反転し、逆方向の桁違いなピッチになる
      // 深刻なバグだった。src/emulator/expansion/fds.jsと同じ修正(詳細はそちら参照)。
      let effectiveFreq = this.freq;
      if (this.modEnabled) {
        const temp = this.modCounter * this.modGain;
        const rem = temp & 0x0F;
        let delta = temp >> 4;
        if (rem !== 0 && delta >= 0) delta += 1;
        if (delta !== 0) {
          const bias = Math.round((delta * this.freq) / 64);
          effectiveFreq = Math.max(0, this.freq + bias);
        }
      }

      this.phaseAcc += effectiveFreq;
      const cycleLen = 64 * 65536;
      if (this.phaseAcc >= cycleLen) this.phaseAcc -= cycleLen;
    }

    mixSample() {
      if (this.disabled || this.mute.wave) return 0;
      const index = Math.floor(this.phaseAcc / 65536) % 64;
      const sample = this.wave[index] & 0x3F; // 0-63
      const centered = sample - 32; // -32..31
      const volScale = this.volGain / 32;
      const masterScale = MASTER_VOLUME_SCALE[this.masterVolume & 0x03];
      // FDS 混合係数: NES 実機の抵抗網 (FDS=47Ω直列, 2A03=100Ω直列, 負荷=39Ω) から
      // FDS 出力は 2A03 の約 39% 程度に相当。係数 0.20 は実機バランスに合わせた値。
      return (centered / 32) * volScale * masterScale * 0.20;
    }
  }

  Emu.FDSAudio = FDSAudio;
})(globalThis);

/*
 * MMC5 拡張音源エミュレータ
 * MML.Emu.MMC5Audio
 *
 * パルス x2 ($5000-$5003 / $5004-$5007, 有効化は $5015)。
 * レジスタ形式は2A03のパルスチャンネルと同様だが、スイープユニットを持たない。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];
  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  class Mmc5Pulse {
    constructor() {
      this.enabled = false;
      this.duty = 0;
      this.lengthCounterHalt = false; // = エンベロープループフラグ
      this.constantVolume = true;
      this.volume = 0;                // 固定音量 or エンベロープ周期
      this.timerPeriod = 0;
      this.timer = 0;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      // エンベロープ(2A03パルスと同形式)
      this.envStart = false;
      this.envDivider = 0;
      this.envDecay = 0;
    }
    writeReg(index, value) {
      switch (index) {
        case 0: // $5000/$5004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.constantVolume = (value & 0x10) !== 0;
          this.volume = value & 0x0F;
          break;
        case 2: // $5002/$5006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $5003/$5007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envStart = true; // 書き込みでエンベロープ再スタート
          break;
      }
    }
    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }
    clock() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }
    // エンベロープ更新(240Hzでクロック)。2A03パルスと同一ロジック。
    clockEnvelope() {
      if (this.envStart) {
        this.envStart = false;
        this.envDecay = 15;
        this.envDivider = this.volume;
      } else if (this.envDivider === 0) {
        this.envDivider = this.volume;
        if (this.envDecay > 0) this.envDecay--;
        else if (this.lengthCounterHalt) this.envDecay = 15; // ループ
      } else {
        this.envDivider--;
      }
    }
    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }
    output() {
      // MMC5はスイープを持たないため 2A03 の「period<8で消音」は無い(超音波域も出力)。
      if (!this.enabled || this.lengthCounter === 0) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.constantVolume ? this.volume : this.envDecay;
    }
  }

  class MMC5Audio {
    constructor() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;   // $5011 8bit 生PCM DAC 出力
      this.pcmReadMode = false; // $5010 bit0
      this.mute = { pulse1: false, pulse2: false, pcm: false };
    }

    reset() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;
      this.pcmReadMode = false;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x5000 && addr <= 0x5003) {
        this.pulse1.writeReg(addr - 0x5000, value);
      } else if (addr >= 0x5004 && addr <= 0x5007) {
        this.pulse2.writeReg(addr - 0x5004, value);
      } else if (addr === 0x5010) {
        this.pcmReadMode = (value & 0x01) !== 0; // bit0: 0=writeモード, 1=readモード
      } else if (addr === 0x5011) {
        // 8bit 生PCM。writeモードのみ出力を更新($4011相当だが8bit)。
        if (!this.pcmReadMode) this.pcmLevel = value;
      } else if (addr === 0x5015) {
        this.pulse1.setEnabled((value & 0x01) !== 0);
        this.pulse2.setEnabled((value & 0x02) !== 0);
      }
    }

    clock() {
      // パルスタイマは 2A03 と同じくAPUサイクル(2 CPUサイクル)ごとに進める。
      // f = CPU/(16*(period+1))。毎CPUサイクルで進めると1オクターブ高くなる。
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clock();
        this.pulse2.clock();
      }
      // MMC5はエンベロープ・長さカウンタとも 240Hz 固定(APU長さカウンタの2倍速)。
      // 7457 CPUサイクル(≒240Hz)ごとに両方クロックする。
      this.frameCounter++;
      if (this.frameCounter >= 7457) {
        this.frameCounter = 0;
        this.pulse1.clockEnvelope();
        this.pulse2.clockEnvelope();
        this.pulse1.clockHalfFrame();
        this.pulse2.clockHalfFrame();
      }
    }

    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : this.pulse1.output() / 15;
      const p2 = this.mute.pulse2 ? 0 : this.pulse2.output() / 15;
      const pcm = this.mute.pcm ? 0 : (this.pcmLevel / 255);
      return (p1 + p2) * 0.25 + pcm * 0.30;
    }
  }

  // 鍵盤表示用: ライブチップから pulse1/pulse2/pcm のスナップショットを作る。
  // 音量はエンベロープ実出力(constantVolume=false時はenvDecay)を反映。
  Emu.snapshotMMC5 = function (chip) {
    const CPU = 1789773;
    const pulse = (p) => {
      const eff = p.constantVolume ? p.volume : p.envDecay; // 実効音量
      const freq = (p.timerPeriod >= 8) ? CPU / (16 * (p.timerPeriod + 1)) : 0;
      return {
        freq,
        vol: eff / 15,
        rawVol: eff,
        duty: p.duty,
        active: p.enabled && p.lengthCounter > 0 && eff > 0 && freq > 0
      };
    };
    return {
      pulse1: pulse(chip.pulse1),
      pulse2: pulse(chip.pulse2),
      pcm: { level: chip.pcmLevel, vol: chip.pcmLevel / 255, active: chip.pcmLevel > 0 }
    };
  };

  Emu.MMC5Audio = MMC5Audio;
})(globalThis);

/*
 * N163 (Namco 163) 拡張音源エミュレータ
 * MML.Emu.N163Audio
 *
 * 128バイト内部RAMにチャンネルレジスタ($40-$7F)と波形データを保持する
 * ウェーブテーブル音源(最大8チャンネル)。
 *
 *   $F800 : 内部RAMアドレス設定 (bit7=1で$4800書き込み毎にオートインクリメント)
 *   $4800 : 現在のアドレスへデータ書き込み
 *
 * チャンネル ch(0-7) のレジスタは RAM (0x40 + ch*8) の8バイト (インターリーブ配置):
 *   +0 周波数 Low   +2 周波数 Mid   +4 周波数 High(bit0-1) | 波形長(bit2-7)
 *   +1 位相 Low     +3 位相 Mid     +5 位相 High   (24bit位相アキュムレータ, RAMに格納)
 *   +6 波形アドレス(4bitサンプル単位)
 *   +7 音量(bit0-3) | 有効ch数(bit4-6, $7Fのみ)
 * 周波数=18bit, 波形長 length = 256 - (+4 & 0xFC) サンプル(4-256)。
 * 波形は4bitサンプルを1バイトに2つ(リトルエンディアン)格納。
 * 有効チャンネルは上位 (($7F>>4)&7)+1 個で、15 CPUサイクルごとに1chずつ巡回更新される。
 * 出力周波数 f = CPU * freq / (15 * 65536 * length * numChannels)。
 *
 * 注: 実機は freq/phase をインターリーブ配置。ドライバは freq を +0/+2/+4 に書き、
 *     間の位相バイト +1/+3/+5 を LDA $4800 で「読み飛ばし」て保存する(読み出しも
 *     オートインクリメントするのを利用)。Rolling Thunder のCPUトレースで確定。
 *
 * 注2: 波形長は NESdev Wiki 準拠で bit2-7 の6bit(4-256サンプル, length=256-(+4&0xFC))。
 *     これが標準の N163 挙動(NSFPlay/Mesen/VirtuaNSF既定と同じ)。ただし「古いドライバ」で
 *     作られた一部NSF(例: Famicompo mini vol.3 entry023)は波形長を最大32サンプル前提で
 *     使っており、256版だと音程・波形テーブルが崩れる。VirtuaNSFはこれ用に「N163を32サンプル
 *     に制限するモード」を別途用意している(readme 1.0.7.1)。必要なら length を
 *     `0x20-(+4&0x1C)` に切替えるオプション化で対応可能(現状は標準の256版を既定とする)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CHANNELS = 8;
  const UPDATE_CYCLES = 15; // 1チャンネル更新に要するCPUサイクル

  class N163Audio {
    constructor() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0; // 15CPUサイクルごとに1ch更新
      this.rrIndex = 0;       // 有効ch内の巡回位置
      this.mute = new Array(NUM_CHANNELS).fill(false);
    }

    reset() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0;
      this.rrIndex = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xF800) {
        this.addr = value & 0x7F;
        this.autoInc = (value & 0x80) !== 0;
      } else if (addr === 0x4800) {
        this.ram[this.addr] = value;
        if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      }
    }

    // $4800 読み出し: 現在のアドレスの内部RAMを返し、オートインクリメント時はアドレスも進める。
    // (書き込みとアドレス/オートインクリメントを共有。実機同様、読み出しでもインクリメント。
    //  ※ ストア命令の空読みはCPU側で抑止済み。ここに来るのは真の LDA $4800 のみ)
    readData() {
      const v = this.ram[this.addr];
      if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      return v;
    }

    numChannels() {
      return ((this.ram[0x7F] >> 4) & 0x07) + 1;
    }

    // ch(0-7, 7=$78が最上位)を1回更新: 位相を進めてRAM(+1/+3/+5)へ書き戻す
    _updateChannel(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const freq = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC); // 4-256 サンプル
      let phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      phase = (phase + freq) % (length * 0x10000);
      ram[base + 1] = phase & 0xFF;
      ram[base + 3] = (phase >> 8) & 0xFF;
      ram[base + 5] = (phase >> 16) & 0xFF;
    }

    // ch の現在の出力サンプル(0-15)。位相上位8bitで波形を索引。
    _sample(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const length = 256 - (ram[base + 4] & 0xFC);
      const phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      const sampleIndex = (phase >> 16) % length;
      const nibbleAddr = (ram[base + 6] + sampleIndex) & 0xFF; // 波形アドレスは4bitサンプル単位
      const byte = ram[(nibbleAddr >> 1) & 0x7F];
      return (nibbleAddr & 1) ? ((byte >> 4) & 0x0F) : (byte & 0x0F);
    }

    clock() {
      // 実機は15 CPUサイクルで1チャンネルを更新・出力し、有効ch(上位num個)を巡回する。
      if (++this.updateCounter < UPDATE_CYCLES) return;
      this.updateCounter = 0;
      const num = this.numChannels();
      this.rrIndex = (this.rrIndex + 1) % num;
      this._updateChannel((NUM_CHANNELS - num) + this.rrIndex);
    }

    mixSample() {
      const num = this.numChannels();
      let sum = 0;
      for (let ch = NUM_CHANNELS - num; ch < NUM_CHANNELS; ch++) {
        if (this.mute[ch]) continue;
        const volume = this.ram[0x40 + ch * 8 + 7] & 0x0F;
        sum += (this._sample(ch) - 8) * volume; // -120..105
      }
      // 時間多重出力の可聴成分は有効ch平均。120で正規化してゲイン。
      // ゲインは他チップとのバランスで調整(0.8→0.3で全体を半分以下に下げた)。
      return (sum / num / 120) * 0.5;
    }
  }

  // 鍵盤表示用: 128バイトRAMから各チャンネルの freq/vol/波形 スナップショットを作る。
  // 表示スロット i(0..7) → ハードウェアch (7-i)。有効なのは上位 numCh 個($78が常にN1)。
  // 事前キャプチャ(writeLogから復元したRAM)・リアルタイム(ライブチップのRAM)双方から使う。
  Emu.snapshotN163 = function (ram) {
    const CPU = 1789773;
    const sampleAt = (a) => (ram[(a >> 1) & 0x7F] >> ((a & 1) * 4)) & 0x0F;
    const numCh = ((ram[0x7F] >> 4) & 7) + 1;
    const channels = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = 7 - i;
      const base = 0x40 + ch * 8;
      const f18 = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC);
      const rawVol = ram[base + 7] & 0x0F;
      const vol = rawVol / 15;
      const freq = f18 > 0 ? f18 * CPU / (15 * 65536 * length * numCh) : 0;
      const waveData = new Array(length);
      for (let k = 0; k < length; k++) waveData[k] = (sampleAt((ram[base + 6] + k) & 0xFF) - 8) / 8;
      channels.push({ freq, vol, rawVol, active: (i < numCh) && vol > 0 && freq > 0, waveData });
    }
    return { channels, numCh };
  };

  Emu.N163Audio = N163Audio;
})(globalThis);

/*
 * FME-7 (Sunsoft 5B) 拡張音源エミュレータ
 * MML.Emu.FME7Audio
 *
 * AY-3-8910/YM2149 系。矩形波(50%)x3 + ノイズ + ハードウェアエンベロープ。
 * アドレスラッチ $C000 でレジスタ番号(0-15)を選択し、$E000 で書き込む。
 *   $00/$01,$02/$03,$04/$05 : 各chの12bitトーン周期(下位8bit/上位4bit)
 *   $06                     : ノイズ周期(5bit)
 *   $07                     : ミキサー。bit0-2=トーン有効(0で有効), bit3-5=ノイズ有効(0で有効)
 *   $08/$09/$0A             : 各chの音量。bit0-3=固定音量, bit4=1でエンベロープ制御
 *   $0B/$0C                 : 16bitエンベロープ周期
 *   $0D                     : エンベロープ形状 (bit0=Hold,bit1=Alternate,bit2=Attack,bit3=Continue)
 *
 * トーン: f = CPU/(32*period) (period=0は1扱い、+1しない)。
 * ノイズ: 17bit LFSR(タップ bit0^bit3)、f = CPU/(32*period)。
 * エンベロープ: 5bit(0-31)、1ステップ = CPU/(16*period)。
 * 音量DAC: 5bit対数(1.5dB/step、level0-1=無音)。固定音量Vは 5bit=2V+1。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 5B/AY 32段対数DAC。1.5dB/step、最大(31)=1.0、level0-1は無音。
  const AY_DAC = new Float32Array(32);
  for (let i = 0; i < 32; i++) AY_DAC[i] = i < 2 ? 0 : Math.pow(10, (i - 31) * 1.5 / 20);

  const NUM_CH = 3;

  // トーン(矩形波)。period チャンネルクロックごとにレベル反転。
  class Fme7Tone {
    constructor() { this.period = 1; this.timer = 0; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.level = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1; // period クロックごとに反転
        this.level ^= 1;
      } else {
        this.timer--;
      }
    }
  }

  // ノイズ。17bit LFSR。period チャンネルクロックごとに flip をトグルし、
  // flip立ち上がりでシフト(=2*period チャンネルクロック=32*period CPUクロックごと)。
  class Fme7Noise {
    constructor() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    reset() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.flip ^= 1;
        if (this.flip) {
          const fb = (this.lfsr ^ (this.lfsr >> 3)) & 1; // タップ bit0 ^ bit3
          this.lfsr = ((this.lfsr >> 1) | (fb << 16)) & 0x1FFFF;
        }
        this.out = this.lfsr & 1;
      } else {
        this.timer--;
      }
    }
  }

  // ハードウェアエンベロープ。5bit(0-31)出力。
  class Fme7Envelope {
    constructor() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.cont = false; this.alt = false; this.hold = false; this.holding = false; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.holding = false; this.level = 0; }
    writeShape(s) {
      this.hold = (s & 1) !== 0;
      this.alt = (s & 2) !== 0;
      this.att = (s & 4) !== 0;
      this.cont = (s & 8) !== 0;
      this.step = 0;
      this.holding = false;
      this.timer = 0;
      this.level = this.att ? 0 : 31; // Attack=上昇なら0から、下降なら31から
    }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this._step();
      } else {
        this.timer--;
      }
    }
    _step() {
      if (this.holding) return;
      this.step++;
      if (this.step > 31) {
        this.step = 0;
        if (!this.cont) { this.holding = true; this.level = 0; return; }          // 一発(減衰/上昇後に無音)
        if (this.hold) { this.holding = true; this.level = this.alt ? (this.att ? 0 : 31) : (this.att ? 31 : 0); return; }
        if (this.alt) this.att = !this.att; // 交互(三角)なら方向反転
      }
      this.level = this.att ? this.step : (31 - this.step);
    }
  }

  class FME7Audio {
    constructor() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38; // 既定: トーンON・ノイズOFF
      this.tones = [new Fme7Tone(), new Fme7Tone(), new Fme7Tone()];
      this.noise = new Fme7Noise();
      this.env = new Fme7Envelope();
      this._div = 0;
      this.mute = [false, false, false];
    }

    reset() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38;
      for (const t of this.tones) t.reset();
      this.noise.reset();
      this.env.reset();
      this._div = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xC000) {
        this.addr = value & 0x0F;
      } else if (addr === 0xE000) {
        this.writeInternal(this.addr, value);
      }
    }

    writeInternal(reg, value) {
      this.regs[reg] = value;
      switch (reg) {
        case 0: case 1: this.tones[0].period = this.regs[0] | ((this.regs[1] & 0x0F) << 8); break;
        case 2: case 3: this.tones[1].period = this.regs[2] | ((this.regs[3] & 0x0F) << 8); break;
        case 4: case 5: this.tones[2].period = this.regs[4] | ((this.regs[5] & 0x0F) << 8); break;
        case 6: this.noise.period = value & 0x1F; break;
        case 11: case 12: this.env.period = this.regs[11] | (this.regs[12] << 8); break;
        case 13: this.env.writeShape(value); break;
        // 7=ミキサー, 8-10=音量 は出力時に参照
      }
    }

    clock() {
      // 内部クロックはCPUクロックの1/16
      if (++this._div >= 16) {
        this._div = 0;
        this.tones[0].clock();
        this.tones[1].clock();
        this.tones[2].clock();
        this.noise.clock();
        this.env.clock();
      }
    }

    // ch(0-2)の5bit音量レベル(0-31)。bit4でエンベロープ、固定音量Vは 2V+1。
    channelLevel(ch) {
      const volReg = this.regs[8 + ch];
      if (volReg & 0x10) return this.env.level;
      return ((volReg & 0x0F) * 2) + 1; // V=0→1(DAC上無音), V=15→31
    }

    mixSample() {
      const mix = this.regs[7];
      let sum = 0;
      for (let i = 0; i < NUM_CH; i++) {
        if (this.mute[i]) continue;
        const toneOn = ((mix >> i) & 1) === 0;
        const noiseOn = ((mix >> (i + 3)) & 1) === 0;
        const t = toneOn ? this.tones[i].level : 1;
        const n = noiseOn ? this.noise.out : 1;
        if (t && n) sum += AY_DAC[this.channelLevel(i)];
      }
      // 3ch分の対数振幅和。他チップとのバランスでゲイン調整。
      return sum * 0.35;
    }
  }

  // 鍵盤表示用: ライブチップから3ch分の {freq,vol,rawVol,active,noise,envMode} を作る。
  // freq=CPU/(32*period)(修正後), vol/rawVolはエンベロープ含む実効5bitレベル由来。
  Emu.snapshotFME7 = function (chip) {
    const CPU = 1789773;
    const mix = chip.regs[7];
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const period = chip.tones[i].period;
      const toneOn = ((mix >> i) & 1) === 0;
      const noiseOn = ((mix >> (i + 3)) & 1) === 0;
      const level = chip.channelLevel(i);          // 0-31
      const envMode = (chip.regs[8 + i] & 0x10) !== 0;
      const freq = (toneOn && period > 0) ? CPU / (32 * period) : 0;
      out.push({
        freq,
        vol: level / 31,
        rawVol: Math.round(level / 2),             // 0-15 表示用
        active: (toneOn ? (level > 0 && freq > 0) : (noiseOn && level > 0)),
        noise: noiseOn,
        envMode
      });
    }
    return out;
  };

  Emu.FME7Audio = FME7Audio;
})(globalThis);

/*
 * 6502 CPUコア（NES/NSF用、デコードモード無効）
 * MML.Emu.CPU6502
 *
 * - 全151正規オペコードに対応
 * - bus.read(addr) / bus.write(addr, value) を介してメモリアクセス
 * - call(addr) で「addrをCALLして RTS で戻るまで実行」を行うヘルパーを提供
 *   (NSFのINIT/PLAYルーチン呼び出しに使用)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // フラグビット
  const F_C = 0x01; // Carry
  const F_Z = 0x02; // Zero
  const F_I = 0x04; // IRQ disable
  const F_D = 0x08; // Decimal (NESでは演算に影響しない)
  const F_B = 0x10; // Break
  const F_U = 0x20; // Unused (常に1)
  const F_V = 0x40; // Overflow
  const F_N = 0x80; // Negative

  // CALL終了検知のためのスタックに積む「番兵」リターンアドレス。
  // RTSでこのアドレスに戻ったら呼び出し終了とみなす。
  const CALL_SENTINEL = 0xFFFF;

  class CPU6502 {
    /**
     * @param {{read:(addr:number)=>number, write:(addr:number, value:number)=>void}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.A = 0;
      this.X = 0;
      this.Y = 0;
      this.S = 0xFD;
      this.P = F_U | F_I;
      this.PC = 0;
      this.cycles = 0;
      this.halted = false;
      this.callActive = false;
    }

    // --- メモリアクセス ---
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }
    // PCから1バイト読んでPCを16bitでラップさせながら進める
    fetchByte() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    read16(addr) {
      return this.read(addr) | (this.read(addr + 1) << 8);
    }
    // JMP (ind) のページ境界バグ: 下位バイトが$xxFFの場合、上位バイトは$xx00から読む
    read16Bug(addr) {
      const lo = this.read(addr);
      const hiAddr = (addr & 0xFF00) | ((addr + 1) & 0xFF);
      const hi = this.read(hiAddr);
      return lo | (hi << 8);
    }

    // --- フラグ操作 ---
    getFlag(mask) { return (this.P & mask) !== 0; }
    setFlag(mask, on) { this.P = on ? (this.P | mask) : (this.P & ~mask); }
    setZN(value) {
      value &= 0xFF;
      this.setFlag(F_Z, value === 0);
      this.setFlag(F_N, (value & 0x80) !== 0);
    }

    // --- スタック ---
    push(value) {
      this.write(0x0100 + this.S, value);
      this.S = (this.S - 1) & 0xFF;
    }
    pop() {
      this.S = (this.S + 1) & 0xFF;
      return this.read(0x0100 + this.S);
    }

    // --- オペランド取得 ---
    // 戻り値: { addr: number|null, value: number, pageCrossed: boolean }
    // skipRead=true の場合、書き込み先アドレスのみ算出し値の読み出しをしない。
    // (STA/STX/STY 等のストア命令用。実機のストアは書き込み先を読まないため、
    //  $4800(N163) や $4015 等の読み出し副作用を持つレジスタで空読みが悪影響を与える)
    fetchOperand(mode, skipRead = false) {
      let addr = null, value = 0, pageCrossed = false;
      switch (mode) {
        case 'imm':
          value = this.fetchByte();
          break;
        case 'acc':
          value = this.A;
          break;
        case 'impl':
          break;
        case 'zp':
          addr = this.fetchByte();
          if (!skipRead) value = this.read(addr);
          break;
        case 'zpx':
          addr = (this.fetchByte() + this.X) & 0xFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'zpy':
          addr = (this.fetchByte() + this.Y) & 0xFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'abs':
          addr = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'absx': {
          const base = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.X) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'absy': {
          const base = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.Y) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'indx': {
          const zp = (this.fetchByte() + this.X) & 0xFF;
          addr = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'indy': {
          const zp = this.fetchByte();
          const base = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
          addr = (base + this.Y) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'rel': {
          const off = this.fetchByte();
          addr = off; // 呼び出し側で符号付きオフセットとして解釈
          break;
        }
        default:
          throw new Error(`未知のアドレッシングモード: ${mode}`);
      }
      return { addr, value, pageCrossed };
    }

    writeOperand(mode, addr, value) {
      if (mode === 'acc') this.A = value & 0xFF;
      else this.write(addr, value);
    }

    // --- 命令実行（1命令）---
    // 戻り値: 消費サイクル数
    step() {
      const opcode = this.fetchByte();
      const def = OPS[opcode];
      if (!def) {
        // 未定義オペコードは2サイクルNOP相当として無視する
        return 2;
      }
      const extra = def.exec(this, def.mode);
      return def.cycles + (extra || 0);
    }

    /**
     * addr のサブルーチンを呼び出し、RTS で戻るまで実行する。
     * NSFのINITやPLAYの呼び出しに使用。
     * @param {number} addr
     * @param {number} [maxSteps=200000] - 無限ループ対策の上限命令数
     * @returns {number} 実行した命令数
     */
    call(addr, maxSteps = 200000) {
      // 番兵アドレス-1 をリターンアドレスとしてプッシュ（RTSで+1されてCALL_SENTINELに戻る）
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF);
      this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;

      let steps = 0;
      while (this.PC !== CALL_SENTINEL && steps < maxSteps) {
        this.step();
        steps++;
      }
      return steps;
    }

    // --- 呼び出しをAPUクロックとインターリーブするための逐次実行API ---
    // beginCall で番兵を積んでPCを設定し callActive=true にする。以後 stepCall() を
    // 呼ぶたびに1命令実行し、RTSで番兵に戻ったら callActive=false になる。
    // ($4011直書きPCMのように、PLAY中のレジスタ書き込みをサンプル精度で反映するため)
    beginCall(addr) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF);
      this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      this.callActive = true;
    }

    // callActive中に1命令実行し、消費CPUサイクル数を返す。番兵到達でcallActive=false。
    stepCall() {
      const c = this.step();
      if (this.PC === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  // --- 命令ハンドラ ---

  function ADC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const sum = cpu.A + op.value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (op.value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function SBC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const value = op.value ^ 0xFF;
    const sum = cpu.A + value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function AND(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A & op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function ORA(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A | op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function EOR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A ^ op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function ASL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = (op.value << 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function LSR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = (op.value >> 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function ROL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = ((op.value << 1) | c) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function ROR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = ((op.value >> 1) | (c << 7)) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function INC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value + 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function DEC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value - 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function compare(cpu, reg, value) {
    const result = (reg - value) & 0x1FF;
    cpu.setFlag(F_C, reg >= value);
    cpu.setZN(result & 0xFF);
  }
  function CMP(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.A, op.value); return op.pageCrossed ? 1 : 0; }
  function CPX(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.X, op.value); return 0; }
  function CPY(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.Y, op.value); return 0; }

  function BIT(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_Z, (cpu.A & op.value) === 0);
    cpu.setFlag(F_V, (op.value & 0x40) !== 0);
    cpu.setFlag(F_N, (op.value & 0x80) !== 0);
    return 0;
  }

  function branch(cpu, mode, cond) {
    const op = cpu.fetchOperand(mode);
    if (!cond) return 0;
    const offset = op.addr < 0x80 ? op.addr : op.addr - 0x100;
    const oldPC = cpu.PC;
    cpu.PC = (cpu.PC + offset) & 0xFFFF;
    const pageCrossed = (oldPC & 0xFF00) !== (cpu.PC & 0xFF00);
    return pageCrossed ? 2 : 1;
  }

  function LDA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function LDX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.X = op.value; cpu.setZN(cpu.X); return op.pageCrossed ? 1 : 0; }
  function LDY(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.Y = op.value; cpu.setZN(cpu.Y); return op.pageCrossed ? 1 : 0; }

  function STA(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A); return 0; }
  function STX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.X); return 0; }
  function STY(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.Y); return 0; }

  function JMP(cpu, mode) {
    if (mode === 'abs') {
      cpu.PC = cpu.read16(cpu.PC);
    } else { // ind
      const ptr = cpu.read16(cpu.PC);
      cpu.PC = cpu.read16Bug(ptr);
    }
    return 0;
  }

  function JSR(cpu) {
    const target = cpu.read16(cpu.PC);
    const ret = (cpu.PC + 1) & 0xFFFF; // JSR命令最後のバイトのアドレス
    cpu.push((ret >> 8) & 0xFF);
    cpu.push(ret & 0xFF);
    cpu.PC = target;
    return 0;
  }

  function RTS(cpu) {
    const lo = cpu.pop();
    const hi = cpu.pop();
    cpu.PC = ((hi << 8) | lo) + 1;
    cpu.PC &= 0xFFFF;
    return 0;
  }

  function BRK(cpu) {
    cpu.PC = (cpu.PC + 1) & 0xFFFF;
    cpu.push((cpu.PC >> 8) & 0xFF);
    cpu.push(cpu.PC & 0xFF);
    cpu.push(cpu.P | F_B | F_U);
    cpu.setFlag(F_I, true);
    cpu.PC = cpu.read16(0xFFFE);
    return 0;
  }

  function RTI(cpu) {
    cpu.P = (cpu.pop() | F_U) & ~F_B;
    const lo = cpu.pop();
    const hi = cpu.pop();
    cpu.PC = (hi << 8) | lo;
    return 0;
  }

  function PHA(cpu) { cpu.push(cpu.A); return 0; }
  function PHP(cpu) { cpu.push(cpu.P | F_B | F_U); return 0; }
  function PLA(cpu) { cpu.A = cpu.pop(); cpu.setZN(cpu.A); return 0; }
  function PLP(cpu) { cpu.P = (cpu.pop() | F_U) & ~F_B; return 0; }

  function TAX(cpu) { cpu.X = cpu.A; cpu.setZN(cpu.X); return 0; }
  function TAY(cpu) { cpu.Y = cpu.A; cpu.setZN(cpu.Y); return 0; }
  function TXA(cpu) { cpu.A = cpu.X; cpu.setZN(cpu.A); return 0; }
  function TYA(cpu) { cpu.A = cpu.Y; cpu.setZN(cpu.A); return 0; }
  function TSX(cpu) { cpu.X = cpu.S; cpu.setZN(cpu.X); return 0; }
  function TXS(cpu) { cpu.S = cpu.X; return 0; }

  function INX(cpu) { cpu.X = (cpu.X + 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function INY(cpu) { cpu.Y = (cpu.Y + 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function DEX(cpu) { cpu.X = (cpu.X - 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function DEY(cpu) { cpu.Y = (cpu.Y - 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }

  function SEC(cpu) { cpu.setFlag(F_C, true); return 0; }
  function CLC(cpu) { cpu.setFlag(F_C, false); return 0; }
  function SEI(cpu) { cpu.setFlag(F_I, true); return 0; }
  function CLI(cpu) { cpu.setFlag(F_I, false); return 0; }
  function SED(cpu) { cpu.setFlag(F_D, true); return 0; }
  function CLD(cpu) { cpu.setFlag(F_D, false); return 0; }
  function CLV(cpu) { cpu.setFlag(F_V, false); return 0; }

  function NOP(cpu, mode) {
    if (mode !== 'impl') cpu.fetchOperand(mode); // オペランド読み飛ばし(通常未使用)
    return 0;
  }

  // mnemonic -> {mode: [opcodeByte, cycles]}
  const TABLE = {
    ADC: { fn: ADC, modes: { imm: [0x69, 2], zp: [0x65, 3], zpx: [0x75, 4], abs: [0x6D, 4], absx: [0x7D, 4], absy: [0x79, 4], indx: [0x61, 6], indy: [0x71, 5] } },
    AND: { fn: AND, modes: { imm: [0x29, 2], zp: [0x25, 3], zpx: [0x35, 4], abs: [0x2D, 4], absx: [0x3D, 4], absy: [0x39, 4], indx: [0x21, 6], indy: [0x31, 5] } },
    ASL: { fn: ASL, modes: { acc: [0x0A, 2], zp: [0x06, 5], zpx: [0x16, 6], abs: [0x0E, 6], absx: [0x1E, 7] } },
    BCC: { fn: (c, m) => branch(c, m, !c.getFlag(F_C)), modes: { rel: [0x90, 2] } },
    BCS: { fn: (c, m) => branch(c, m, c.getFlag(F_C)), modes: { rel: [0xB0, 2] } },
    BEQ: { fn: (c, m) => branch(c, m, c.getFlag(F_Z)), modes: { rel: [0xF0, 2] } },
    BMI: { fn: (c, m) => branch(c, m, c.getFlag(F_N)), modes: { rel: [0x30, 2] } },
    BNE: { fn: (c, m) => branch(c, m, !c.getFlag(F_Z)), modes: { rel: [0xD0, 2] } },
    BPL: { fn: (c, m) => branch(c, m, !c.getFlag(F_N)), modes: { rel: [0x10, 2] } },
    BVC: { fn: (c, m) => branch(c, m, !c.getFlag(F_V)), modes: { rel: [0x50, 2] } },
    BVS: { fn: (c, m) => branch(c, m, c.getFlag(F_V)), modes: { rel: [0x70, 2] } },
    BIT: { fn: BIT, modes: { zp: [0x24, 3], abs: [0x2C, 4] } },
    BRK: { fn: BRK, modes: { impl: [0x00, 7] } },
    CLC: { fn: CLC, modes: { impl: [0x18, 2] } },
    CLD: { fn: CLD, modes: { impl: [0xD8, 2] } },
    CLI: { fn: CLI, modes: { impl: [0x58, 2] } },
    CLV: { fn: CLV, modes: { impl: [0xB8, 2] } },
    CMP: { fn: CMP, modes: { imm: [0xC9, 2], zp: [0xC5, 3], zpx: [0xD5, 4], abs: [0xCD, 4], absx: [0xDD, 4], absy: [0xD9, 4], indx: [0xC1, 6], indy: [0xD1, 5] } },
    CPX: { fn: CPX, modes: { imm: [0xE0, 2], zp: [0xE4, 3], abs: [0xEC, 4] } },
    CPY: { fn: CPY, modes: { imm: [0xC0, 2], zp: [0xC4, 3], abs: [0xCC, 4] } },
    DEC: { fn: DEC, modes: { zp: [0xC6, 5], zpx: [0xD6, 6], abs: [0xCE, 6], absx: [0xDE, 7] } },
    DEX: { fn: DEX, modes: { impl: [0xCA, 2] } },
    DEY: { fn: DEY, modes: { impl: [0x88, 2] } },
    EOR: { fn: EOR, modes: { imm: [0x49, 2], zp: [0x45, 3], zpx: [0x55, 4], abs: [0x4D, 4], absx: [0x5D, 4], absy: [0x59, 4], indx: [0x41, 6], indy: [0x51, 5] } },
    INC: { fn: INC, modes: { zp: [0xE6, 5], zpx: [0xF6, 6], abs: [0xEE, 6], absx: [0xFE, 7] } },
    INX: { fn: INX, modes: { impl: [0xE8, 2] } },
    INY: { fn: INY, modes: { impl: [0xC8, 2] } },
    JMP: { fn: JMP, modes: { abs: [0x4C, 3], ind: [0x6C, 5] } },
    JSR: { fn: JSR, modes: { abs: [0x20, 6] } },
    LDA: { fn: LDA, modes: { imm: [0xA9, 2], zp: [0xA5, 3], zpx: [0xB5, 4], abs: [0xAD, 4], absx: [0xBD, 4], absy: [0xB9, 4], indx: [0xA1, 6], indy: [0xB1, 5] } },
    LDX: { fn: LDX, modes: { imm: [0xA2, 2], zp: [0xA6, 3], zpy: [0xB6, 4], abs: [0xAE, 4], absy: [0xBE, 4] } },
    LDY: { fn: LDY, modes: { imm: [0xA0, 2], zp: [0xA4, 3], zpx: [0xB4, 4], abs: [0xAC, 4], absx: [0xBC, 4] } },
    LSR: { fn: LSR, modes: { acc: [0x4A, 2], zp: [0x46, 5], zpx: [0x56, 6], abs: [0x4E, 6], absx: [0x5E, 7] } },
    NOP: { fn: NOP, modes: { impl: [0xEA, 2] } },
    ORA: { fn: ORA, modes: { imm: [0x09, 2], zp: [0x05, 3], zpx: [0x15, 4], abs: [0x0D, 4], absx: [0x1D, 4], absy: [0x19, 4], indx: [0x01, 6], indy: [0x11, 5] } },
    PHA: { fn: PHA, modes: { impl: [0x48, 3] } },
    PHP: { fn: PHP, modes: { impl: [0x08, 3] } },
    PLA: { fn: PLA, modes: { impl: [0x68, 4] } },
    PLP: { fn: PLP, modes: { impl: [0x28, 4] } },
    ROL: { fn: ROL, modes: { acc: [0x2A, 2], zp: [0x26, 5], zpx: [0x36, 6], abs: [0x2E, 6], absx: [0x3E, 7] } },
    ROR: { fn: ROR, modes: { acc: [0x6A, 2], zp: [0x66, 5], zpx: [0x76, 6], abs: [0x6E, 6], absx: [0x7E, 7] } },
    RTI: { fn: RTI, modes: { impl: [0x40, 6] } },
    RTS: { fn: RTS, modes: { impl: [0x60, 6] } },
    SBC: { fn: SBC, modes: { imm: [0xE9, 2], zp: [0xE5, 3], zpx: [0xF5, 4], abs: [0xED, 4], absx: [0xFD, 4], absy: [0xF9, 4], indx: [0xE1, 6], indy: [0xF1, 5] } },
    SEC: { fn: SEC, modes: { impl: [0x38, 2] } },
    SED: { fn: SED, modes: { impl: [0xF8, 2] } },
    SEI: { fn: SEI, modes: { impl: [0x78, 2] } },
    STA: { fn: STA, modes: { zp: [0x85, 3], zpx: [0x95, 4], abs: [0x8D, 4], absx: [0x9D, 5], absy: [0x99, 5], indx: [0x81, 6], indy: [0x91, 6] } },
    STX: { fn: STX, modes: { zp: [0x86, 3], zpy: [0x96, 4], abs: [0x8E, 4] } },
    STY: { fn: STY, modes: { zp: [0x84, 3], zpx: [0x94, 4], abs: [0x8C, 4] } },
    TAX: { fn: TAX, modes: { impl: [0xAA, 2] } },
    TAY: { fn: TAY, modes: { impl: [0xA8, 2] } },
    TSX: { fn: TSX, modes: { impl: [0xBA, 2] } },
    TXA: { fn: TXA, modes: { impl: [0x8A, 2] } },
    TXS: { fn: TXS, modes: { impl: [0x9A, 2] } },
    TYA: { fn: TYA, modes: { impl: [0x98, 2] } }
  };

  // 256エントリのオペコードディスパッチテーブルを構築
  const OPS = new Array(256).fill(null);
  for (const mnemonic in TABLE) {
    const { fn, modes } = TABLE[mnemonic];
    for (const mode in modes) {
      const [byte, cycles] = modes[mode];
      OPS[byte] = { mnemonic, mode, exec: fn, cycles };
    }
  }

  Emu.CPU6502 = CPU6502;
  Emu.FLAGS = { C: F_C, Z: F_Z, I: F_I, D: F_D, B: F_B, U: F_U, V: F_V, N: F_N };
  Emu.OPS = OPS; // デバッグ/逆アセンブル用に公開
})(globalThis);

/*
 * NSF実行用メモリバス
 * MML.Emu.NsfBus
 *
 * 64KBのフラットメモリ空間を提供し、$4000-$4017 へのアクセスをAPUにルーティングする。
 * $5FF8-$5FFF へのバンクスイッチ書き込みにも対応（NSFバンクスイッチング方式）。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const BANK_SIZE = 0x1000; // 4KB

  class NsfBus {
    /**
     * @param {object} opt
     * @param {Uint8Array} opt.program - ロードするプログラムイメージ（ヘッダを除いたバイナリ）
     * @param {number} opt.loadAddr - プログラムのロード先アドレス
     * @param {Uint8Array} [opt.bankswitch] - ヘッダのバンクスイッチ初期値8バイト（全て0ならバンクスイッチ無効）
     */
    constructor(opt) {
      this.mem = new Uint8Array(0x10000);
      this.apu = null; // setApu() で後から設定
      this.onWrite = null; // (addr, value) => void のフック（レジスタ書き込みログ用）

      // 拡張音源 (NSF.CHIP_FLAGS の組み合わせ)
      this.expansion = {};
      const extraChips = opt.extraChips || 0;
      const FLAGS = MML.NSF.CHIP_FLAGS;
      if (extraChips & FLAGS.VRC6) this.expansion.vrc6 = new Emu.VRC6Audio();
      if (extraChips & FLAGS.VRC7) this.expansion.vrc7 = new Emu.VRC7Audio();
      if (extraChips & FLAGS.FDS) this.expansion.fds = new Emu.FDSAudio();
      if (extraChips & FLAGS.MMC5) this.expansion.mmc5 = new Emu.MMC5Audio();
      if (extraChips & FLAGS.N163) this.expansion.n163 = new Emu.N163Audio();
      if (extraChips & FLAGS.FME7) this.expansion.fme7 = new Emu.FME7Audio();

      this.loadAddr = opt.loadAddr;
      this.useBankswitch = (opt.bankswitch || []).some(b => b !== 0);

      if (this.useBankswitch) {
        // バンクスイッチ時: ロードアドレス下位12bit分だけ先頭をゼロパディングした
        // ROMイメージを作り、4KBバンク単位で $8000-$FFFF にマッピングする。
        // (NSF仕様: padding = loadAddr & 0x0FFF。これが無いとINIT/PLAYが別バイトを指す)
        const pad = this.loadAddr & 0x0FFF;
        this.romImage = new Uint8Array(pad + opt.program.length);
        this.romImage.set(opt.program, pad);
        this.bankCount = Math.max(1, Math.ceil(this.romImage.length / BANK_SIZE));
        this.banks = new Array(8).fill(0).map((_, i) => (opt.bankswitch[i] || 0) % this.bankCount);
        for (let slot = 0; slot < 8; slot++) this.mapBank(0x8000 + slot * BANK_SIZE, this.banks[slot]);
        // FDS NSF: バイト0x76/0x77 は $E000/$F000 に加え $6000/$7000 も初期化する
        if (this.expansion.fds) {
          this.mapBank(0x6000, this.banks[6]);
          this.mapBank(0x7000, this.banks[7]);
        }
      } else {
        // 通常: loadAddr から program をそのまま配置
        for (let i = 0; i < opt.program.length; i++) {
          const addr = (this.loadAddr + i) & 0xFFFF;
          this.mem[addr] = opt.program[i];
        }
      }

      // MMC5実機のPRGバンクレジスタ($5100=モード, $5113-$5117=8KBウィンドウ選択)。
      // NSF仕様の$5FF8-$5FFFバンクスイッチとは別に、実機ROMからそのまま抜き出した
      // ドライバはこちらの本物のMMC5レジスタで$8000-$FFFFを切り替えることがある
      // (Just Breed等)。これを無視すると初期バンクのまま固定され、曲の途中で
      // ドライバが本来別バンクにあるはずのデータ(0埋め)を読んで無限ループに陥る。
      if (this.expansion.mmc5) {
        if (!this.romImage) {
          const pad = this.loadAddr & 0x0FFF;
          this.romImage = new Uint8Array(pad + opt.program.length);
          this.romImage.set(opt.program, pad);
        }
        this.mmc5PrgMode = 3; // 実機の電源投入直後の挙動に合わせた既定値(最も細かい8KB×4分割)
        this.mmc5PrgReg = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; // $5113,5114,5115,5116,5117の生値
        // $5205/$5206: 実機の8bit×8bit=16bit符号なし乗算器。書き込みは被乗数/乗数だが
        // 読み出しは積の下位/上位バイトを返す(実機の二重機能レジスタ)。これが無いと
        // 読み出し側は直前に書き込んだ生値をそのまま読み返してしまい、乗算結果を使う
        // ポインタ計算(音楽データテーブルの索引など)が壊れる(Just Breed等)。
        this.mmc5MultOperand = [0, 0];
        this.mmc5MultProduct = 0;
      }
    }

    setApu(apu) { this.apu = apu; }

    // MMC5実機のPRGバンクレジスタ書き込みを $8000-$FFFF に反映する。
    // regIndex: 1=$5114 2=$5115 3=$5116 4=$5117 (書き込まれたレジスタのみ)、
    // regIndex省略時は$5100(モード)変更に伴う全ウィンドウ再計算。
    // NSFはドライバ本体の起動処理を経ずINIT/PLAYだけを叩くため、触れられていない
    // レジスタは実機のリセット直後値ではなくヘッダのバンクスイッチで既に正しく
    // 割り当て済みの内容を持っている。よって「書き込まれたレジスタが担当する
    // ウィンドウだけ」を差し替え、他のウィンドウは既存の内容(ヘッダ由来 or
    // 以前のMMC5書き込みの結果)をそのまま保持する。
    mmc5RemapPrg(regIndex) {
      const rom = this.romImage;
      const bankCount8k = Math.max(1, Math.floor(rom.length / 0x2000));
      const romBankNum = (regVal) => (regVal & 0x7F) % bankCount8k;
      const copyWindow = (dst, bank8k) => {
        const src = (((bank8k % bankCount8k) + bankCount8k) % bankCount8k) * 0x2000;
        for (let i = 0; i < 0x2000; i++) {
          this.mem[dst + i] = rom[src + i] !== undefined ? rom[src + i] : 0;
        }
      };
      const r = this.mmc5PrgReg; // [5113, 5114, 5115, 5116, 5117]
      const mode = this.mmc5PrgMode;

      const remap5114 = () => { if (mode === 3) copyWindow(0x8000, romBankNum(r[1])); };
      const remap5115 = () => {
        if (mode === 3) copyWindow(0xA000, romBankNum(r[2]));
        else if (mode === 1 || mode === 2) {
          const lo16 = ((r[2] & 0x7F) >> 1) * 2;
          copyWindow(0x8000, lo16);
          copyWindow(0xA000, lo16 + 1);
        }
      };
      const remap5116 = () => { if (mode === 2 || mode === 3) copyWindow(0xC000, romBankNum(r[3])); };
      const remap5117 = () => {
        if (mode === 0) {
          const base8k = ((r[4] & 0x7F) >> 2) * 4;
          for (let w = 0; w < 4; w++) copyWindow(0x8000 + w * 0x2000, base8k + w);
        } else if (mode === 1) {
          const hi16 = ((r[4] & 0x7F) >> 1) * 2;
          copyWindow(0xC000, hi16);
          copyWindow(0xE000, hi16 + 1);
        } else {
          copyWindow(0xE000, romBankNum(r[4]));
        }
      };

      if (regIndex === 1) remap5114();
      else if (regIndex === 2) remap5115();
      else if (regIndex === 3) remap5116();
      else if (regIndex === 4) remap5117();
      else { remap5114(); remap5115(); remap5116(); remap5117(); } // $5100モード変更時: 全ウィンドウ再計算
    }

    // ROMイメージの bankIndex 番目の4KBバンクを dstBase に配置する
    mapBank(dstBase, bankIndex) {
      const src = (bankIndex % this.bankCount) * BANK_SIZE;
      for (let i = 0; i < BANK_SIZE; i++) {
        this.mem[dstBase + i] = this.romImage[src + i] !== undefined ? this.romImage[src + i] : 0;
      }
    }

    read(addr) {
      addr &= 0xFFFF;
      if (addr === 0x4015 && this.apu) return this.apu.readStatus();
      // FDS レジスタ読み出し ($4090=ボリューム出力, $4092=モジュレータ出力)
      if (this.expansion.fds && (addr === 0x4090 || addr === 0x4092)) {
        return this.expansion.fds.readRegister(addr);
      }
      // N163 内部RAM読み出し ($4800)。ドライバが register の read-modify-write に使う。
      if (this.expansion.n163 && addr === 0x4800) {
        return this.expansion.n163.readData();
      }
      // MMC5乗算器: $5205=積の下位バイト, $5206=積の上位バイト
      if (this.expansion.mmc5 && addr === 0x5205) return this.mmc5MultProduct & 0xFF;
      if (this.expansion.mmc5 && addr === 0x5206) return (this.mmc5MultProduct >> 8) & 0xFF;
      return this.mem[addr];
    }

    write(addr, value) {
      addr &= 0xFFFF;
      value &= 0xFF;

      if (addr >= 0x4000 && addr <= 0x4017) {
        if (this.apu) this.apu.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      const exp = this.expansion;
      if (exp.vrc6 && ((addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002))) {
        exp.vrc6.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.vrc7 && (addr === 0x9010 || addr === 0x9030)) {
        exp.vrc7.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.fds && (addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A))) {
        exp.fds.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr >= 0x5000 && addr <= 0x5015) {
        exp.mmc5.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr === 0x5100) {
        this.mmc5PrgMode = value & 0x03;
        this.mmc5RemapPrg();
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr >= 0x5113 && addr <= 0x5117) {
        const regIndex = addr - 0x5113;
        this.mmc5PrgReg[regIndex] = value;
        if (regIndex > 0) this.mmc5RemapPrg(regIndex); // $5113($6000-7FFF RAM)は非対応・素通し
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && (addr === 0x5205 || addr === 0x5206)) {
        this.mmc5MultOperand[addr - 0x5205] = value;
        this.mmc5MultProduct = this.mmc5MultOperand[0] * this.mmc5MultOperand[1];
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.n163 && (addr === 0xF800 || addr === 0x4800)) {
        exp.n163.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.fme7 && (addr === 0xC000 || addr === 0xE000)) {
        exp.fme7.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      if (this.useBankswitch && addr >= 0x5FF8 && addr <= 0x5FFF) {
        const slot = addr - 0x5FF8;
        this.banks[slot] = value % this.bankCount;
        this.mapBank(0x8000 + slot * BANK_SIZE, this.banks[slot]);
        return;
      }

      // FDS NSF 専用: $5FF6/$5FF7 は $6000/$7000 へのバンクスイッチ
      if (this.useBankswitch && this.expansion.fds && (addr === 0x5FF6 || addr === 0x5FF7)) {
        this.mapBank(0x6000 + (addr - 0x5FF6) * BANK_SIZE, value % this.bankCount);
        return;
      }

      this.mem[addr] = value;
    }
  }

  Emu.NsfBus = NsfBus;
})(globalThis);

/*
 * NSFプレイヤー（CPU + APU + Bus の統合）
 * MML.Emu.NsfPlayer
 *
 * - initSong(index): INITルーチンを呼び出して曲を初期化
 * - renderFrame(sampleRate): PLAYルーチンを1回呼び出し、1/60秒分の音声サンプルを生成
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK_NTSC = 1789773;
  const FRAME_RATE_NTSC = 60.0988;

  class NsfPlayer {
    /**
     * @param {Uint8Array} nsfBytes - 128バイトヘッダを含む完全なNSFバイナリ
     */
    constructor(nsfBytes) {
      this.header = MML.NSF.parseHeader(nsfBytes);
      const program = nsfBytes.slice(128);

      this.bus = new Emu.NsfBus({
        program,
        loadAddr: this.header.loadAddr,
        bankswitch: this.header.bankswitch,
        extraChips: this.header.extraChips
      });
      this.apu = new Emu.APU2A03(this.bus);
      this.bus.setApu(this.apu);
      this.cpu = new Emu.CPU6502(this.bus);

      this.cycleAccum = 0;
      this.cpuDebt = 0; // CPUが先行実行したサイクル数(フレーム跨ぎで持ち越す)
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     * @param {boolean} [pal=false]
     */
    initSong(songIndex, pal = false) {
      this.apu.reset();
      this.cpu.reset();
      // NSF仕様: INIT呼び出し前に全チャンネルを有効化しておく。
      // これにより INIT/PLAY 中の $4003 書き込みで lengthCounter が正しく設定される。
      this.apu.writeRegister(0x4017, 0x40); // フレームカウンタリセット・IRQ禁止
      this.apu.writeRegister(0x4015, 0x0F); // 全チャンネル有効
      this.cpu.A = songIndex & 0xFF;
      this.cpu.X = pal ? 1 : 0;
      this.cpu.Y = 0;
      this.cpu.call(this.header.initAddr);
      this.cpu.callActive = false; // INITは完了。最初のrenderFrameでPLAYを開始する
      this.cycleAccum = 0;
      this.cpuDebt = 0;
    }

    /**
     * 1フレーム(1/60秒)分の音声サンプルを生成する。
     * 各フレームの先頭でPLAYを呼ぶが、PLAYが1フレーム内に終わらない
     * 「ブロッキング型」(例:水戸黄門/Sunsoftは1回のPLAYで約612フレーム=10秒ぶんの
     * $4011直書きPCMスピーチをストリーミングしてからRTSする)にも対応するため、
     * PLAYが実行中の間はrenderFrameを跨いで継続し、完了するまで再呼び出ししない。
     * @param {number} sampleRate
     * @returns {Float32Array} 0.0〜1.16程度の振幅の波形データ
     */
    renderFrame(sampleRate) {
      const cyclesPerSample = CPU_CLOCK_NTSC / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / FRAME_RATE_NTSC);
      const out = new Float32Array(samplesThisFrame);

      // 拡張音源は添字ループで回す(毎CPUサイクル呼ぶ内側ループなので for...of の
      // イテレータ確保を避ける)。拡張なし(2A03のみ)なら nExp=0 でループ自体スキップ。
      const expansion = Object.values(this.bus.expansion);
      const nExp = expansion.length;
      const apu = this.apu, cpu = this.cpu;

      // 前フレームでPLAYが完了していれば新たに呼び出す。まだ実行中(複数フレームに
      // 跨るブロッキングPLAY)ならその実行を継続する。
      if (!cpu.callActive) cpu.beginCall(this.header.playAddr);

      // CPU実行とAPUクロックをインターリーブし、各出力サンプル時点のレジスタ状態
      // ($4011直書きPCM等)を正しく反映する。cpuDebt(CPUが先行実行したサイクル)は
      // フレーム境界を跨いで持ち越す。
      for (let i = 0; i < samplesThisFrame; i++) {
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          if (this.cpuDebt <= 0) {
            if (cpu.callActive) this.cpuDebt += cpu.stepCall();
            else this.cpuDebt = 1; // PLAY完了後、次フレームまではCPUアイドルでAPUのみ進む
          }
          this.cpuDebt--;
          apu.clock();
          for (let e = 0; e < nExp; e++) expansion[e].clock();
          this.cycleAccum -= 1;
        }
        let sample = apu.mixSample();
        for (let e = 0; e < nExp; e++) sample += expansion[e].mixSample();
        out[i] = sample;
      }
      return out;
    }
  }

  Emu.NsfPlayer = NsfPlayer;
  Emu.CPU_CLOCK_NTSC = CPU_CLOCK_NTSC;
  Emu.FRAME_RATE_NTSC = FRAME_RATE_NTSC;
})(globalThis);

/*
 * 再生ログ一括キャプチャ（プリレンダー）
 * MML.Emu.captureSong / MML.Emu.dcBlock
 *
 * INIT実行後、指定秒数分のPLAYルーチンを毎フレーム実行し、
 * - 全レジスタ書き込みのタイムラインログ
 * - 全フレーム分の音声波形（DCブロック済み）
 * を一括生成する。生成後はシーク・早送り・巻き戻しが
 * 音声バッファへのアクセスのみで完結する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * チャンネルごとのミュート設定をチップの mute プロパティへ反映する。
   * target がオブジェクトならキー一致、配列ならインデックス一致で上書きする。
   */
  Emu.applyMute = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = !!source[i];
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = !!source[k];
      }
    }
  };

  // NESの非線形ミキサー出力(DCオフセット付き)をAC成分に変換するDCブロッカー
  Emu.dcBlock = function (samples) {
    const out = new Float32Array(samples.length);
    let prevX = 0, prevY = 0;
    const R = 0.999;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = x - prevX + R * prevY;
      out[i] = y;
      prevX = x;
      prevY = y;
    }
    return out;
  };

  /**
   * 楽曲キャプチャの共通セットアップ。player・バッファ・ログ配列を返す。
   * @private
   */
  function _setupCapture(nsfBytes, opt) {
    const songIndex = opt.songIndex || 0;
    const durationSeconds = opt.durationSeconds || 10;
    const sampleRate = opt.sampleRate || 44100;

    const player = new Emu.NsfPlayer(nsfBytes);
    // initSong の書き込みを runningRegs に先取りしてスナップショットの初期状態とする
    const runningRegs = {};
    player.bus.onWrite = (a, val) => { runningRegs[a] = val; };
    player.initSong(songIndex, !!opt.pal);
    player.bus.onWrite = null;

    // initSong は bus.write を経由せず APU.writeRegister を直接呼ぶため
    // $4015 (チャンネル有効化) が onWrite を通らず regSnapshots に記録されない。
    // NSF の INIT が $4015 を書かなかった場合は initSong のデフォルト値 $0F を補完する。
    if (runningRegs[0x4015] === undefined) {
      runningRegs[0x4015] = 0x0F;
    }

    if (opt.mute) {
      if (opt.mute.apu) Emu.applyMute(player.apu.mute, opt.mute.apu);
      if (opt.mute.expansion) {
        for (const [name, chip] of Object.entries(player.bus.expansion)) {
          if (opt.mute.expansion[name]) Emu.applyMute(chip.mute, opt.mute.expansion[name]);
        }
      }
    }

    const frameRate = opt.pal ? (1000000 / 19997) : Emu.FRAME_RATE_NTSC;
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * frameRate));
    const samplesPerFrame = sampleRate / frameRate;
    // regsOnly モードでは音声バッファ不要（巨大配列の確保・dcBlock をスキップ）
    const regsOnly = !!opt.regsOnly;
    const totalSamples = regsOnly ? 0 : Math.ceil(totalFrames * samplesPerFrame);

    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(totalFrames);
    const regSnapshots = new Array(totalFrames);
    const cpuSnapshots = new Array(totalFrames);
    const memSnapshots = new Array(totalFrames);
    const apuEnvSnapshots = new Array(totalFrames);

    let pendingWrites = [];
    player.bus.onWrite = (addr, value) => pendingWrites.push({ addr, value });

    // INIT後・PLAY前の初期レジスタ状態をスナップショット
    const initRegs = Object.assign({}, runningRegs);

    return { player, sampleRate, frameRate, totalFrames, samplesPerFrame, totalSamples,
             raw, writeLog, regSnapshots, cpuSnapshots, memSnapshots, apuEnvSnapshots, runningRegs, initRegs,
             pendingWritesRef: { get current() { return pendingWrites; }, set(v) { pendingWrites = v; player.bus.onWrite = (a, val) => pendingWrites.push({ addr: a, value: val }); } } };
  }

  /**
   * APU矩形波1/2・ノイズの「実際に出力中の音量レベル」を取得する。
   * ハードウェアエンベロープ(減衰)使用時、レジスタの下位4bitは音量ではなく減衰速度なので、
   * 内部の decay 値(0-15)を読む必要がある。env=true なら減衰モード。
   * envelope.output() は constant時=設定音量 / 減衰時=現在のdecay値 を返す。
   */
  // DPCMサンプルのデルタ復号キャッシュ（(addr,len)が変わった時だけ再復号）
  let _dmcCache = { key: '' };
  function _dmcSample(bus, addr, len) {
    if (!bus || !len) return null;
    const key = addr + ':' + len;
    if (_dmcCache.key !== key) {
      const n = len * 8;
      const samples = new Float32Array(n);
      let level = 64; // 7bit DAC の中央から delta(+2/-2, 0..127クランプ) で再構成
      let k = 0;
      for (let b = 0; b < len; b++) {
        const byte = bus.read((addr + b) & 0xFFFF) & 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          if (byte & (1 << bit)) { if (level <= 125) level += 2; }
          else { if (level >= 2) level -= 2; }
          samples[k++] = (level - 64) / 64; // -1..1
        }
      }
      _dmcCache = { key, addr, len, samples };
    }
    return { addr, len, samples: _dmcCache.samples };
  }

  Emu.snapshotApuEnv = function (apu, fds, bus) {
    const rd = (ch) => ({ level: ch.envelope.output(), env: !ch.envelope.constant });
    const out = { pulse1: rd(apu.pulse1), pulse2: rd(apu.pulse2), noise: rd(apu.noise) };
    // FDS $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を採取。
    if (fds) out.fds = { gain: fds.volGain, env: !!fds.volEnvEnabled };
    // DPCM: 実出力レベル(outputLevel 0-127)と、メモリ上のサンプルをデルタ復号した波形
    if (apu.dmc) {
      const dmc = { level: apu.dmc.outputLevel };
      if (bus) {
        const s = _dmcSample(bus, apu.dmc.sampleAddr, apu.dmc.sampleLength);
        if (s) { dmc.addr = s.addr; dmc.len = s.len; dmc.samples = s.samples; }
      }
      out.dmc = dmc;
    }
    return out;
  };

  /** 1フレーム分を処理してバッファ・ログを更新する。posを返す。 */
  function _processFrame(ctx, f, pos) {
    const { player, sampleRate, totalSamples, raw, writeLog, regSnapshots,
            cpuSnapshots, memSnapshots, apuEnvSnapshots, runningRegs, pendingWritesRef } = ctx;
    pendingWritesRef.set([]);
    const frame = player.renderFrame(sampleRate);
    writeLog[f] = pendingWritesRef.current;
    for (const w of pendingWritesRef.current) runningRegs[w.addr] = w.value;
    regSnapshots[f] = Object.assign({}, runningRegs);
    cpuSnapshots[f] = {
      A: player.cpu.A, X: player.cpu.X, Y: player.cpu.Y,
      P: player.cpu.P, S: player.cpu.S, PC: player.cpu.PC
    };
    memSnapshots[f] = player.bus.mem.slice(0, 0x100);
    apuEnvSnapshots[f] = Emu.snapshotApuEnv(player.apu, player.bus.expansion && player.bus.expansion.fds, player.bus);
    for (let i = 0; i < frame.length && pos < totalSamples; i++, pos++) {
      raw[pos] = frame[i];
    }
    return pos;
  }

  function _buildResult(ctx) {
    return {
      audio: ctx.raw.length > 0 ? Emu.dcBlock(ctx.raw) : ctx.raw,
      sampleRate: ctx.sampleRate,
      totalFrames: ctx.totalFrames,
      samplesPerFrame: ctx.samplesPerFrame,
      writeLog: ctx.writeLog,
      regSnapshots: ctx.regSnapshots,
      cpuSnapshots: ctx.cpuSnapshots,
      memSnapshots: ctx.memSnapshots,
      apuEnvSnapshots: ctx.apuEnvSnapshots,
      initRegs: ctx.initRegs
    };
  }

  /**
   * 楽曲を一括キャプチャする（同期版・後方互換）
   * @param {Uint8Array} nsfBytes - 完全なNSFバイナリ（128バイトヘッダ含む）
   * @param {object} opt
   * @param {number} [opt.songIndex=0]
   * @param {number} [opt.durationSeconds=10]
   * @param {number} [opt.sampleRate=44100]
   * @param {boolean} [opt.pal=false]
   */
  Emu.captureSong = function (nsfBytes, opt = {}) {
    const ctx = _setupCapture(nsfBytes, opt);
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      pos = _processFrame(ctx, f, pos);
    }
    return _buildResult(ctx);
  };

  /**
   * 楽曲を非同期でキャプチャする（UI をブロックしない）
   * CHUNK_FRAMES フレームごとにブラウザへ制御を返すため、長尺でも UI がフリーズしない。
   * @param {Uint8Array} nsfBytes
   * @param {object} opt - captureSong と同じオプション
   * @param {function(done:number, total:number):void} [onProgress] - 進捗コールバック
   * @returns {Promise<object>} captureSong と同じ戻り値
   */
  Emu.captureSongAsync = async function (nsfBytes, opt = {}, onProgress = null) {
    const CHUNK_FRAMES = 60; // ~1秒ぶんごとに yield
    const ctx = _setupCapture(nsfBytes, opt);
    const regsOnly = !!opt.regsOnly;
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      if (regsOnly) {
        // 音声生成を省略し CPU 実行のみ（鍵盤表示用の高速キャプチャ）
        ctx.pendingWritesRef.set([]);
        ctx.player.cpu.call(ctx.player.header.playAddr);
        ctx.writeLog[f] = ctx.pendingWritesRef.current;
        for (const w of ctx.pendingWritesRef.current) ctx.runningRegs[w.addr] = w.value;
        ctx.regSnapshots[f] = Object.assign({}, ctx.runningRegs);
      } else {
        pos = _processFrame(ctx, f, pos);
      }
      if ((f + 1) % CHUNK_FRAMES === 0) {
        if (onProgress) onProgress(f + 1, ctx.totalFrames);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (onProgress) onProgress(ctx.totalFrames, ctx.totalFrames);
    return _buildResult(ctx);
  };
})(globalThis);

/*
 * NSF AudioWorklet プロセッサ実装
 * worklet-loader.js によって emulator コードと連結されて Blob URL として読み込まれる。
 * globalThis.MML.Emu.NsfPlayer が使用可能な前提。
 */

class NsfProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player       = null;
    this._songIndex   = 0;
    this.frameBuffer  = null;
    this.frameOffset  = 0;
    this.totalFrames  = 0; // 0 = ループ無限
    this.currentFrame = 0;
    this.dcPrevX      = 0;
    this.dcPrevY      = 0;
    this.playing      = false;

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'load':
        this._load(msg);
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        this.port.postMessage({ type: 'paused', frame: this.currentFrame });
        break;
      case 'stop':
        this.playing = false;
        if (this.player) this.player.initSong(this._songIndex);
        this.frameBuffer  = null;
        this.frameOffset  = 0;
        this.currentFrame = 0;
        this.dcPrevX = this.dcPrevY = 0;
        break;
      case 'mute':
        this._applyMute(msg.mute);
        break;
    }
  }

  _load(data) {
    const Emu = globalThis.MML.Emu;
    this._songIndex   = data.songIndex || 0;
    this.player       = new Emu.NsfPlayer(new Uint8Array(data.nsfBytes));
    this.player.initSong(this._songIndex);
    this.totalFrames  = data.totalFrames || 0;
    this.currentFrame = 0;
    this.frameBuffer  = null;
    this.frameOffset  = 0;
    this.dcPrevX = this.dcPrevY = 0;
    this.playing      = false;
    if (data.mute) this._applyMute(data.mute);
  }

  _applyMute(mute) {
    if (!mute || !this.player) return;
    const Emu = globalThis.MML.Emu;
    if (mute.apu) Emu.applyMute(this.player.apu.mute, mute.apu);
    if (mute.expansion) {
      for (const [name, chip] of Object.entries(this.player.bus.expansion)) {
        if (mute.expansion[name]) Emu.applyMute(chip.mute, mute.expansion[name]);
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.player || !this.playing) { out.fill(0); return true; }

    let outPos = 0;
    while (outPos < out.length) {
      // フレームバッファが尽きたら次のフレームをレンダリング
      if (!this.frameBuffer || this.frameOffset >= this.frameBuffer.length) {
        if (this.totalFrames > 0 && this.currentFrame >= this.totalFrames) {
          for (let i = outPos; i < out.length; i++) out[i] = 0;
          this.playing = false;
          this.port.postMessage({ type: 'ended' });
          return true;
        }
        this.frameBuffer  = this.player.renderFrame(sampleRate);
        this.frameOffset  = 0;
        this.currentFrame++;
        // 定期的にフレーム番号を通知（モニタ用）
        if (this.currentFrame % 60 === 0) {
          this.port.postMessage({ type: 'frame', frame: this.currentFrame });
        }
      }

      const toCopy = Math.min(this.frameBuffer.length - this.frameOffset, out.length - outPos);
      for (let i = 0; i < toCopy; i++) {
        const raw = this.frameBuffer[this.frameOffset + i];
        // DCブロック（サンプル単位のIIR）
        const y = raw - this.dcPrevX + 0.999 * this.dcPrevY;
        this.dcPrevX = raw;
        this.dcPrevY = y;
        out[outPos + i] = y;
      }
      outPos          += toCopy;
      this.frameOffset += toCopy;
    }

    return true;
  }
}

registerProcessor('nsf-processor', NsfProcessor);
