/*
 * PlayStation SPU (CXD2922/CXD2925) エミュレータ
 * MML.Emu.SpuPsx
 *
 * 24ボイスの SPU-ADPCM 再生、ハードADSR、ボイス/メイン音量スイープ、ピッチ変調(PMON)、
 * ノイズ、リバーブ、SPU RAM 転送(FIFO手動書き/DMA読み書き)、IRQ9。
 * clock() 1回で 44.1kHz のステレオ1サンプル(outL/outR、-32768..32767)を生成する。
 * CPU 33.8688MHz ÷ 768 = 44100Hz。
 *
 * 出典は psx-spx "Sound Processing Unit (SPU)" の記述(ガウス表・ADSR のカウンタ式・
 * ノイズ・リバーブ式・39タップFIR はそこから写した)。ADSR は「Counter += Increment、
 * bit15 が立ったら1ステップ」の実機検証済みの形を使う。
 *
 * レジスタは 0x1F801C00.. をハーフワード index(0..0xFF)で扱う:
 *   voice n: n*8 + {0:volL 1:volR 2:pitch 3:startAddr 4:adsrLo 5:adsrHi 6:curAdsrVol 7:repeatAddr}
 *   0xC0 mainL 0xC1 mainR 0xC2 vLOUT 0xC3 vROUT 0xC4/C5 KON 0xC6/C7 KOFF 0xC8/C9 PMON 0xCA/CB NON
 *   0xCC/CD EON 0xCE/CF ENDX 0xD1 mBASE 0xD2 IRQaddr 0xD3 transferAddr 0xD4 FIFO 0xD5 SPUCNT
 *   0xD6 transferCtrl 0xD7 SPUSTAT 0xD8/D9 CD vol 0xDA/DB ext vol 0xDC/DD curMainVol 0xE0..FF reverb
 *   0x100..0x12F current voice volume L/R (read)  0x130..0x13F 不明(RAM扱い)
 *
 * フック:
 *   onWrite(index, value)   レジスタ書き込み(キャプチャ用)
 *   onKeyOn(voice, startAddr) KON でボイスが鳴り始めた時
 *   onIrq()                 IRQ9 発生
 * ミュート/音量: mute[24](bool) / vol[24](0..2)。Emu.applyMute/applyVolume と同じ配列規約。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const SPU_RAM_SIZE = 0x80000;
  const NUM_VOICES = 24;
  const SAMPLES_PER_BLOCK = 28;

  // ── ガウス補間表(psx-spx、512エントリ。4タップの和は 0x7F80 ±1) ──
  const GAUSS = new Int16Array([
        -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,    -1,
         0,     0,     0,     0,     0,     0,     0,     1,     1,     1,     1,     2,     2,     2,     3,     3,
         3,     4,     4,     5,     5,     6,     7,     7,     8,     9,     9,    10,    11,    12,    13,    14,
        15,    16,    17,    18,    19,    21,    22,    24,    25,    27,    28,    30,    32,    33,    35,    37,
        39,    41,    44,    46,    48,    51,    53,    56,    58,    61,    64,    67,    70,    73,    77,    80,
        84,    87,    91,    95,    99,   103,   107,   111,   116,   120,   125,   130,   135,   140,   145,   150,
       156,   161,   167,   173,   179,   186,   192,   199,   205,   212,   219,   227,   234,   242,   250,   257,
       266,   274,   283,   291,   300,   309,   319,   328,   338,   348,   358,   369,   379,   390,   401,   412,
       424,   436,   448,   460,   473,   485,   498,   512,   525,   539,   553,   567,   582,   597,   612,   627,
       643,   659,   675,   692,   708,   726,   743,   761,   779,   797,   816,   835,   854,   874,   894,   914,
       935,   956,   977,   999,  1020,  1043,  1066,  1089,  1112,  1136,  1160,  1184,  1209,  1234,  1260,  1286,
      1312,  1339,  1366,  1394,  1422,  1450,  1479,  1508,  1537,  1567,  1598,  1628,  1660,  1691,  1723,  1756,
      1789,  1822,  1856,  1890,  1924,  1959,  1995,  2031,  2067,  2104,  2141,  2179,  2217,  2256,  2295,  2334,
      2374,  2415,  2456,  2497,  2539,  2582,  2624,  2668,  2712,  2756,  2801,  2846,  2892,  2938,  2985,  3032,
      3079,  3128,  3176,  3225,  3275,  3325,  3376,  3427,  3479,  3531,  3584,  3637,  3691,  3745,  3799,  3855,
      3910,  3967,  4023,  4081,  4138,  4197,  4255,  4315,  4374,  4435,  4495,  4557,  4619,  4681,  4744,  4807,
      4871,  4935,  5000,  5065,  5131,  5197,  5264,  5332,  5399,  5468,  5536,  5606,  5676,  5746,  5817,  5888,
      5959,  6032,  6104,  6177,  6251,  6325,  6400,  6475,  6550,  6626,  6702,  6779,  6856,  6934,  7012,  7091,
      7170,  7249,  7329,  7409,  7490,  7571,  7653,  7735,  7817,  7900,  7983,  8066,  8150,  8234,  8319,  8404,
      8489,  8575,  8661,  8748,  8834,  8922,  9009,  9097,  9185,  9273,  9362,  9451,  9541,  9630,  9720,  9811,
      9901,  9992, 10083, 10174, 10266, 10358, 10450, 10542, 10635, 10727, 10820, 10913, 11007, 11100, 11194, 11288,
     11382, 11476, 11571, 11665, 11760, 11855, 11950, 12045, 12140, 12236, 12331, 12427, 12522, 12618, 12714, 12809,
     12905, 13001, 13097, 13193, 13289, 13385, 13481, 13577, 13673, 13769, 13865, 13961, 14056, 14152, 14248, 14343,
     14439, 14534, 14630, 14725, 14820, 14915, 15010, 15104, 15199, 15293, 15387, 15481, 15575, 15669, 15762, 15855,
     15948, 16041, 16133, 16226, 16317, 16409, 16500, 16592, 16682, 16773, 16863, 16953, 17042, 17131, 17220, 17308,
     17396, 17484, 17571, 17658, 17744, 17830, 17916, 18001, 18086, 18170, 18254, 18337, 18420, 18502, 18584, 18665,
     18746, 18826, 18905, 18985, 19063, 19141, 19219, 19295, 19372, 19447, 19522, 19597, 19671, 19744, 19816, 19888,
     19959, 20030, 20100, 20169, 20238, 20306, 20373, 20439, 20505, 20570, 20634, 20698, 20760, 20822, 20884, 20944,
     21004, 21063, 21121, 21178, 21235, 21290, 21345, 21399, 21452, 21505, 21556, 21607, 21657, 21706, 21754, 21801,
     21848, 21893, 21938, 21982, 22025, 22066, 22107, 22148, 22187, 22225, 22262, 22299, 22334, 22369, 22402, 22435,
     22467, 22498, 22527, 22556, 22584, 22611, 22637, 22662, 22686, 22709, 22731, 22752, 22772, 22791, 22809, 22826,
     22842, 22857, 22872, 22885, 22897, 22908, 22918, 22927, 22935, 22942, 22948, 22953, 22957, 22960, 22962, 22963,
  ]);

  // ── リバーブ入出力の 39 タップ FIR(psx-spx) ──
  const REVERB_FIR = new Int16Array([
        -1,     0,     2,     0,   -10,     0,    35,     0,
      -103,     0,   266,     0,  -616,     0,  1332,     0,
     -2960,     0, 10246, 16384, 10246,     0, -2960,     0,
      1332,     0,  -616,     0,   266,     0,  -103,     0,
        35,     0,   -10,     0,     2,     0,    -1,
  ]);

  // SPU-ADPCM フィルタ係数(XA と同じ)
  const ADPCM_POS = [0, 60, 115, 98, 122];
  const ADPCM_NEG = [0, 0, -52, -55, -60];

  const PH_OFF = 0, PH_ATTACK = 1, PH_DECAY = 2, PH_SUSTAIN = 3, PH_RELEASE = 4;

  function clamp16(v) { return v < -32768 ? -32768 : (v > 32767 ? 32767 : v); }

  /**
   * 音量エンベロープ(ADSR の各相/音量スイープ共通)。psx-spx の式そのまま。
   * @returns 新しいレベル
   */
  function envTick(env, level) {
    // env: {shift, stepVal, decreasing, exponential, negative, counter}
    let step = 7 - env.stepVal;
    if (env.decreasing !== env.negative) step = ~step;      // +7..+4 → -8..-5
    const shift = env.shift;
    step = shift < 11 ? (step << (11 - shift)) : step;
    let inc = shift > 11 ? (0x8000 >> (shift - 11)) : 0x8000;
    if (env.exponential && !env.decreasing && level > 0x6000) {
      if (shift < 10) step >>= 2;
      else if (shift >= 11) inc >>= 2;
      else { step >>= 1; inc >>= 1; }
    } else if (env.exponential && env.decreasing) {
      step = (step * level) >> 15;
    }
    if ((env.stepVal | (shift << 2)) !== 0x7F) { if (inc < 1) inc = 1; }
    env.counter += inc;
    if ((env.counter & 0x8000) === 0) return level;
    env.counter = 0;
    level += step;
    if (!env.decreasing) return level < -0x8000 ? -0x8000 : (level > 0x7FFF ? 0x7FFF : level);
    if (env.negative) return level < -0x8000 ? -0x8000 : (level > 0 ? 0 : level);
    return level < 0 ? 0 : level;
  }

  function makeEnv() { return { shift: 0, stepVal: 0, decreasing: false, exponential: false, negative: false, counter: 0 }; }

  class Voice {
    constructor(index) {
      this.index = index;
      this.buf = new Int16Array(SAMPLES_PER_BLOCK + 3); // [0..2]=前ブロック末尾3サンプル、[3..30]=現ブロック
      this.reset();
    }
    reset() {
      this.buf.fill(0);
      this.curAddr = 0;        // 現在のADPCMブロック(バイトアドレス)
      this.repeatAddr = 0;     // バイトアドレス
      this.counter = 0;        // ピッチカウンタ(bit12以上=ブロック内サンプル、bit4-11=補間index)
      this.hasBlock = false;
      this.blockFlags = 0;
      this.ignoreLoopAddr = false;
      this.phase = PH_OFF;
      this.level = 0;          // ADSR レベル 0..0x7FFF
      this.env = makeEnv();
      this.out = 0;            // VxOUTX(ADSR適用後・音量前)
      this.outL = 0; this.outR = 0;
      this.volL = 0; this.volR = 0;         // 現在の音量(-0x8000..0x7FFF)
      this.sweepL = null; this.sweepR = null; // スイープ中なら makeEnv()
      this.keyOnFrame = -1;
      this.keyOnSerial = 0;    // キーオンの通し番号(同じフレーム内の打ち直し検出用)
    }
  }

  class SpuPsx {
    constructor() {
      this.ram = new Uint8Array(SPU_RAM_SIZE);
      this.ram16 = new Int16Array(this.ram.buffer);
      this.regs = new Uint16Array(0x200);
      this.voices = [];
      for (let i = 0; i < NUM_VOICES; i++) this.voices.push(new Voice(i));
      this.mute = new Array(NUM_VOICES).fill(false);
      this.vol = new Array(NUM_VOICES).fill(1);
      this.onWrite = null; this.onKeyOn = null; this.onIrq = null;
      this.onRamWrite = null; // (byteAddr, int16) 転送(FIFO/DMA)による SPU RAM 書き込み(キャプチャ用)
      // replayMode: 記録済みの書き込みを流し直す再生専用。FIFO/DMA からの RAM 書き込みは
      // 行わない(RAM はキャプチャの onRamWrite 記録を ramWrite16Direct で直接反映する)。
      this.replayMode = false;
      this.reverbBuf = new Int32Array(0); // 未使用(将来のため)
      this.reset();
    }

    reset() {
      this.ram.fill(0);
      this.regs.fill(0);
      for (const v of this.voices) v.reset();
      this.outL = 0; this.outR = 0;
      this.voiceOutL = new Int32Array(NUM_VOICES);
      this.voiceOutR = new Int32Array(NUM_VOICES);
      this.kon = 0; this.koff = 0; this.pmon = 0; this.non = 0; this.eon = 0; this.endx = 0;
      this.cnt = 0; this.stat = 0;
      this.irqAddr = 0; this.irqFlag = false;
      this.transferAddr = 0; this.transferCur = 0;
      this.fifo = new Uint16Array(32); this.fifoLen = 0;
      this.mainVolL = 0; this.mainVolR = 0; this.mainSweepL = null; this.mainSweepR = null;
      this.mainEnvL = makeEnv(); this.mainEnvR = makeEnv();
      this.noiseLevel = 0; this.noiseTimer = 0;
      // リバーブ
      this.rvBase = 0; this.rvCur = 0;
      this.rvDownL = new Int16Array(64); this.rvDownR = new Int16Array(64);
      this.rvUpL = new Int16Array(64); this.rvUpR = new Int16Array(64);
      this.rvPos = 0;
      this.rvOutL = 0; this.rvOutR = 0;
      this.sampleCount = 0;
    }

    // ── レジスタ ──────────────────────────────────────────
    readReg(index) {
      index &= 0x1FF;
      if (index < 0xC0) {
        const v = this.voices[index >> 3];
        switch (index & 7) {
          case 6: return v.level & 0xFFFF;
          case 7: return (v.repeatAddr >>> 3) & 0xFFFF;
          default: return this.regs[index];
        }
      }
      switch (index) {
        case 0xCE: return this.endx & 0xFFFF;
        case 0xCF: return (this.endx >>> 16) & 0xFF;
        case 0xD7: return this.stat;
        case 0xDC: return this.mainVolL & 0xFFFF;
        case 0xDD: return this.mainVolR & 0xFFFF;
        default:
          if (index >= 0x100 && index < 0x130) {
            const v = this.voices[(index - 0x100) >> 1];
            return ((index & 1) ? v.volR : v.volL) & 0xFFFF;
          }
          return this.regs[index];
      }
    }

    writeReg(index, value) {
      index &= 0x1FF; value &= 0xFFFF;
      if (this.onWrite) this.onWrite(index, value);
      this.regs[index] = value;
      if (index < 0xC0) {
        const v = this.voices[index >> 3];
        switch (index & 7) {
          case 0: this.setVoiceVolume(v, 'L', value); break;
          case 1: this.setVoiceVolume(v, 'R', value); break;
          case 6: v.level = value << 16 >> 16; break;
          // 鳴っている最中に書いたときだけ、以後のループ開始フラグより優先する(DuckStation: ignore_loop_address |= IsOn())。
          // 鳴る前に書いた値はキーオン後の最初のループ開始フラグで上書きされうる(FF7 の AKAO はこれでループ先を指定する)
          case 7: v.repeatAddr = (value << 3) & 0x7FFFF; if (v.phase !== PH_OFF) v.ignoreLoopAddr = true; break;
          default: break; // pitch/startAddr/ADSR は regs から都度読む
        }
        return;
      }
      switch (index) {
        case 0xC0: this.setMainVolume('L', value); break;
        case 0xC1: this.setMainVolume('R', value); break;
        case 0xC4: this.kon = (this.kon & 0xFF0000) | value; this.applyKeyOn(value); break;
        case 0xC5: this.kon = (this.kon & 0xFFFF) | ((value & 0xFF) << 16); this.applyKeyOn((value & 0xFF) << 16); break;
        case 0xC6: this.koff = (this.koff & 0xFF0000) | value; this.applyKeyOff(value); break;
        case 0xC7: this.koff = (this.koff & 0xFFFF) | ((value & 0xFF) << 16); this.applyKeyOff((value & 0xFF) << 16); break;
        case 0xC8: this.pmon = (this.pmon & 0xFF0000) | value; break;
        case 0xC9: this.pmon = (this.pmon & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xCA: this.non = (this.non & 0xFF0000) | value; break;
        case 0xCB: this.non = (this.non & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xCC: this.eon = (this.eon & 0xFF0000) | value; break;
        case 0xCD: this.eon = (this.eon & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xCE: this.endx = (this.endx & 0xFF0000) | value; break;
        case 0xCF: this.endx = (this.endx & 0xFFFF) | ((value & 0xFF) << 16); break;
        case 0xD1: this.rvBase = (value << 3) & 0x7FFFF; this.rvCur = this.rvBase; break;
        case 0xD2: this.irqAddr = (value << 3) & 0x7FFFF; break;
        case 0xD3: this.transferAddr = (value << 3) & 0x7FFFF; this.transferCur = this.transferAddr; break;
        case 0xD4: // FIFO
          if (this.fifoLen < 32) this.fifo[this.fifoLen++] = value;
          else { this.fifo.copyWithin(0, 1); this.fifo[31] = value; }
          if (((this.cnt >> 4) & 3) === 1) this.drainFifo(); // 既に手動書きモードなら随時反映
          break;
        case 0xD5: this.setControl(value); break;
        case 0xD6: break; // transfer control(type=2 normal のみ対応)
        default: break;
      }
    }

    setControl(value) {
      const prev = this.cnt;
      this.cnt = value;
      if (!(value & 0x40)) this.irqFlag = false; // IRQ9 disable/acknowledge
      const mode = (value >> 4) & 3;
      if (mode === 1 && ((prev >> 4) & 3) !== 1) this.drainFifo();
      if (mode === 0) this.fifoLen = 0;
      this.updateStat();
    }

    updateStat() {
      const mode = (this.cnt >> 4) & 3;
      let s = this.cnt & 0x3F;
      if (this.irqFlag) s |= 0x40;
      if (mode >= 2) s |= 0x80;
      if (mode === 2) s |= 0x100;
      if (mode === 3) s |= 0x200;
      this.stat = s;
    }

    get irqEnabled() { return (this.cnt & 0x8040) === 0x8040; }

    raiseIrq() {
      if (this.irqFlag) return;
      this.irqFlag = true;
      this.updateStat();
      if (this.onIrq) this.onIrq();
    }

    /** 転送(FIFO/DMA)による RAM 書き込み。IRQ アドレスに触れたら IRQ */
    ramWrite16(addr, value) {
      addr &= 0x7FFFE;
      if (this.replayMode) return;
      if (this.onRamWrite) this.onRamWrite(addr, value << 16 >> 16);
      this.ram16[addr >> 1] = value << 16 >> 16;
      if (this.irqEnabled && ((addr ^ this.irqAddr) & ~7) === 0) this.raiseIrq();
    }

    /** 記録済みの RAM 書き込みを直接反映する(replayMode 用、IRQ/フックなし) */
    ramWrite16Direct(addr, value) {
      this.ram16[(addr & 0x7FFFE) >> 1] = value;
    }

    drainFifo() {
      for (let i = 0; i < this.fifoLen; i++) {
        this.ramWrite16(this.transferCur, this.fifo[i]);
        this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      }
      this.fifoLen = 0;
    }

    /** DMA4 書き込み(1ワード=2ハーフワード) */
    dmaWrite32(word) {
      this.ramWrite16(this.transferCur, word & 0xFFFF);
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      this.ramWrite16(this.transferCur, (word >>> 16) & 0xFFFF);
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
    }

    /** DMA4 読み出し(1ワード) */
    dmaRead32() {
      const lo = this.ram16[this.transferCur >> 1] & 0xFFFF;
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      const hi = this.ram16[this.transferCur >> 1] & 0xFFFF;
      this.transferCur = (this.transferCur + 2) & 0x7FFFF;
      return (lo | (hi << 16)) | 0;
    }

    setVoiceVolume(v, side, value) {
      if (value & 0x8000) {
        const env = makeEnv();
        env.shift = (value >> 2) & 0x1F; env.stepVal = value & 3;
        env.decreasing = !!(value & 0x2000); env.exponential = !!(value & 0x4000); env.negative = !!(value & 0x1000);
        if (side === 'L') v.sweepL = env; else v.sweepR = env;
      } else {
        const vol = (value << 17) >> 16; // 15bit符号付き×2
        if (side === 'L') { v.volL = vol; v.sweepL = null; } else { v.volR = vol; v.sweepR = null; }
      }
    }

    setMainVolume(side, value) {
      if (value & 0x8000) {
        const env = makeEnv();
        env.shift = (value >> 2) & 0x1F; env.stepVal = value & 3;
        env.decreasing = !!(value & 0x2000); env.exponential = !!(value & 0x4000); env.negative = !!(value & 0x1000);
        if (side === 'L') this.mainSweepL = env; else this.mainSweepR = env;
      } else {
        const vol = (value << 17) >> 16;
        if (side === 'L') { this.mainVolL = vol; this.mainSweepL = null; } else { this.mainVolR = vol; this.mainSweepR = null; }
      }
    }

    applyKeyOn(bits) {
      for (let i = 0; i < NUM_VOICES; i++) {
        if (!(bits & (1 << i))) continue;
        const v = this.voices[i];
        v.curAddr = (this.regs[i * 8 + 3] << 3) & 0x7FFFF;
        v.counter = 0;
        v.hasBlock = false;
        v.buf.fill(0);
        v.level = 0;
        v.phase = PH_ATTACK;
        v.env.counter = 0;
        v.ignoreLoopAddr = false;
        v.keyOnFrame = this.sampleCount;
        v.keyOnSerial = (v.keyOnSerial + 1) | 0;
        this.endx &= ~(1 << i);
        if (this.onKeyOn) this.onKeyOn(i, v.curAddr);
      }
    }

    applyKeyOff(bits) {
      for (let i = 0; i < NUM_VOICES; i++) {
        if (!(bits & (1 << i))) continue;
        const v = this.voices[i];
        if (v.phase !== PH_OFF) { v.phase = PH_RELEASE; v.env.counter = 0; }
      }
    }

    // ── ADPCM ────────────────────────────────────────────
    /** v.curAddr のブロックを v.buf[3..30] へ復号する(履歴は buf[1],buf[2]) */
    decodeBlock(v) {
      const ram = this.ram;
      const addr = v.curAddr;
      if (this.irqEnabled && ((addr ^ this.irqAddr) & ~0xF) === 0) this.raiseIrq();
      const hdr = ram[addr];
      let shift = hdr & 0x0F;
      if (shift > 12) shift = 9;
      let filter = (hdr >> 4) & 7;
      if (filter > 4) filter = 4;
      const flags = ram[addr + 1];
      v.blockFlags = flags;
      if ((flags & 4) && !v.ignoreLoopAddr) v.repeatAddr = addr;
      const f0 = ADPCM_POS[filter], f1 = ADPCM_NEG[filter];
      const buf = v.buf;
      // 前ブロック末尾3サンプルを先頭へ
      buf[0] = buf[28]; buf[1] = buf[29]; buf[2] = buf[30];
      let old = buf[2], older = buf[1];
      let o = 3;
      for (let i = 2; i < 16; i++) {
        const b = ram[addr + i];
        for (let n = 0; n < 2; n++) {
          const nib = n ? (b >> 4) : (b & 0x0F);
          let s = ((nib << 12) << 16 >> 16) >> shift;
          s += (old * f0 + older * f1 + 32) >> 6;
          s = clamp16(s);
          buf[o++] = s;
          older = old; old = s;
        }
      }
      v.hasBlock = true;
    }

    /** ブロック末尾に達したとき(ループ終端処理→次ブロック) */
    advanceBlock(v) {
      const flags = v.blockFlags;
      if (flags & 1) { // Loop End
        this.endx |= (1 << v.index);
        v.curAddr = v.repeatAddr;
        // End+Mute。ノイズ再生中のボイスでは無視される(ADPCM の読み進みは続く)
        if (!(flags & 2) && !(this.non & (1 << v.index))) {
          v.phase = PH_OFF; v.level = 0; v.env.counter = 0;
        }
      } else {
        v.curAddr = (v.curAddr + 16) & 0x7FFFF;
      }
      this.decodeBlock(v);
    }

    // ── ADSR ─────────────────────────────────────────────
    adsrTick(v) {
      if (v.phase === PH_OFF) { v.level = 0; return; }
      const lo = this.regs[v.index * 8 + 4], hi = this.regs[v.index * 8 + 5];
      const env = v.env;
      let target = -1, targetIsMin = false;
      switch (v.phase) {
        case PH_ATTACK:
          env.shift = (lo >> 10) & 0x1F; env.stepVal = (lo >> 8) & 3;
          env.decreasing = false; env.exponential = !!(lo & 0x8000); env.negative = false;
          target = 0x7FFF; break;
        case PH_DECAY:
          env.shift = (lo >> 4) & 0x0F; env.stepVal = 0;
          env.decreasing = true; env.exponential = true; env.negative = false;
          target = Math.min(0x7FFF, ((lo & 0x0F) + 1) << 11); targetIsMin = true; break;
        case PH_SUSTAIN:
          env.shift = (hi >> 8) & 0x1F; env.stepVal = (hi >> 6) & 3;
          env.decreasing = !!(hi & 0x4000); env.exponential = !!(hi & 0x8000); env.negative = false;
          break;
        case PH_RELEASE:
          env.shift = hi & 0x1F; env.stepVal = 0;
          env.decreasing = true; env.exponential = !!(hi & 0x20); env.negative = false;
          target = 0; targetIsMin = true; break;
        default: break;
      }
      v.level = envTick(env, v.level);
      if (target >= 0) {
        if (targetIsMin ? (v.level <= target) : (v.level >= target)) {
          if (v.phase === PH_ATTACK) { v.phase = PH_DECAY; env.counter = 0; }
          else if (v.phase === PH_DECAY) { v.phase = PH_SUSTAIN; env.counter = 0; }
          else if (v.phase === PH_RELEASE) { v.phase = PH_OFF; v.level = 0; }
        }
      }
    }

    static sweepTick(env, level) {
      const next = envTick(env, level);
      // 到達したら終了(スイープはそのレベルで止まる)
      const done = env.decreasing ? (env.negative ? next <= -0x8000 : next <= 0) : next >= 0x7FFF;
      return { level: next, done };
    }

    // ── ノイズ ────────────────────────────────────────────
    noiseTick() {
      const shift = (this.cnt >> 10) & 0x0F;
      const step = ((this.cnt >> 8) & 3) + 4;
      this.noiseTimer -= step;
      const lvl = this.noiseLevel;
      const parity = ((lvl >> 15) ^ (lvl >> 12) ^ (lvl >> 11) ^ (lvl >> 10) ^ 1) & 1;
      if (this.noiseTimer < 0) {
        this.noiseLevel = ((lvl << 1) | parity) << 16 >> 16;
        this.noiseTimer += 0x20000 >> shift;
        if (this.noiseTimer < 0) this.noiseTimer += 0x20000 >> shift;
      }
    }

    // ── リバーブ ──────────────────────────────────────────
    rvAddr(off) {
      // off はバイトオフセット。mBASE..0x7FFFE で折り返す
      let a = this.rvCur + off;
      const size = SPU_RAM_SIZE - this.rvBase;
      if (a >= SPU_RAM_SIZE) a = this.rvBase + ((a - this.rvBase) % size);
      else if (a < this.rvBase) a = this.rvBase + (((a - this.rvBase) % size) + size) % size;
      return a & 0x7FFFE;
    }
    rvRead(regIdx, minus2) {
      const off = (this.regs[0xE0 + regIdx] << 3) - (minus2 ? 2 : 0);
      return this.ram16[this.rvAddr(off) >> 1];
    }
    rvReadDisp(regIdx, dispIdx) {
      const off = ((this.regs[0xE0 + regIdx] - this.regs[0xE0 + dispIdx]) << 3);
      return this.ram16[this.rvAddr(off) >> 1];
    }
    rvWrite(regIdx, value) {
      if (!(this.cnt & 0x80)) return; // Reverb Master Enable=0 なら書かない
      const off = this.regs[0xE0 + regIdx] << 3;
      this.ram16[this.rvAddr(off) >> 1] = clamp16(value);
    }

    /** 22.05kHz で1回。inL/inR は FIR で間引いた入力 */
    reverbProcess(inL, inR) {
      const R = this.regs;
      const vol = (i) => R[0xE0 + i] << 16 >> 16;
      const mul = (a, b) => (a * b) >> 15;
      const vIIR = vol(2), vCOMB1 = vol(3), vCOMB2 = vol(4), vCOMB3 = vol(5), vCOMB4 = vol(6), vWALL = vol(7);
      const vAPF1 = vol(8), vAPF2 = vol(9), vLIN = vol(0x1E), vRIN = vol(0x1F);
      const Lin = mul(vLIN, inL), Rin = mul(vRIN, inR);
      // Same side reflection
      const mLSAME2 = this.rvRead(0x0A, true), mRSAME2 = this.rvRead(0x0B, true);
      this.rvWrite(0x0A, mul(clamp16(Lin + mul(this.rvRead(0x10), vWALL) - mLSAME2), vIIR) + mLSAME2);
      this.rvWrite(0x0B, mul(clamp16(Rin + mul(this.rvRead(0x11), vWALL) - mRSAME2), vIIR) + mRSAME2);
      // Different side reflection
      const mLDIFF2 = this.rvRead(0x12, true), mRDIFF2 = this.rvRead(0x13, true);
      this.rvWrite(0x12, mul(clamp16(Lin + mul(this.rvRead(0x19), vWALL) - mLDIFF2), vIIR) + mLDIFF2);
      this.rvWrite(0x13, mul(clamp16(Rin + mul(this.rvRead(0x18), vWALL) - mRDIFF2), vIIR) + mRDIFF2);
      // Comb
      let Lout = clamp16(mul(vCOMB1, this.rvRead(0x0C)) + mul(vCOMB2, this.rvRead(0x0E)) + mul(vCOMB3, this.rvRead(0x14)) + mul(vCOMB4, this.rvRead(0x16)));
      let Rout = clamp16(mul(vCOMB1, this.rvRead(0x0D)) + mul(vCOMB2, this.rvRead(0x0F)) + mul(vCOMB3, this.rvRead(0x15)) + mul(vCOMB4, this.rvRead(0x17)));
      // APF1
      {
        const l = this.rvReadDisp(0x1A, 0x00), r = this.rvReadDisp(0x1B, 0x00);
        Lout = clamp16(Lout - mul(vAPF1, l)); this.rvWrite(0x1A, Lout); Lout = clamp16(mul(Lout, vAPF1) + l);
        Rout = clamp16(Rout - mul(vAPF1, r)); this.rvWrite(0x1B, Rout); Rout = clamp16(mul(Rout, vAPF1) + r);
      }
      // APF2
      {
        const l = this.rvReadDisp(0x1C, 0x01), r = this.rvReadDisp(0x1D, 0x01);
        Lout = clamp16(Lout - mul(vAPF2, l)); this.rvWrite(0x1C, Lout); Lout = clamp16(mul(Lout, vAPF2) + l);
        Rout = clamp16(Rout - mul(vAPF2, r)); this.rvWrite(0x1D, Rout); Rout = clamp16(mul(Rout, vAPF2) + r);
      }
      // 次のバッファ位置
      let next = (this.rvCur + 2) & 0x7FFFE;
      if (next < this.rvBase) next = this.rvBase;
      this.rvCur = next;
      return { l: Lout, r: Rout };
    }

    /** 44.1kHz ごとのリバーブ入出力(FIRで 22.05kHz と往復) */
    reverbTick(inL, inR) {
      const pos = this.rvPos;
      this.rvDownL[pos] = clamp16(inL); this.rvDownR[pos] = clamp16(inR);
      if (pos & 1) {
        // 間引き: 39タップ FIR(中心=19)
        let accL = 0, accR = 0;
        for (let k = 0; k < 39; k += 2) { // 奇数タップは中心以外0
          const c = REVERB_FIR[k];
          const i = (pos - k) & 63;
          accL += c * this.rvDownL[i]; accR += c * this.rvDownR[i];
        }
        {
          const i = (pos - 19) & 63;
          accL += REVERB_FIR[19] * this.rvDownL[i]; accR += REVERB_FIR[19] * this.rvDownR[i];
        }
        const out = this.reverbProcess(clamp16(accL >> 15), clamp16(accR >> 15));
        this.rvUpL[pos >> 1 & 31] = out.l; this.rvUpR[pos >> 1 & 31] = out.r;
      }
      // 補間: 偶数位置は偶数タップの和(×2)、奇数位置は中心タップ
      let oL, oR;
      const upIdx = (pos >> 1) & 31;
      if (pos & 1) {
        let accL = 0, accR = 0;
        for (let k = 0; k < 39; k += 2) {
          const c = REVERB_FIR[k];
          const i = (upIdx - (k >> 1)) & 31;
          accL += c * this.rvUpL[i]; accR += c * this.rvUpR[i];
        }
        oL = clamp16(accL >> 14); oR = clamp16(accR >> 14);
      } else {
        const i = (upIdx - 10) & 31; // 中心タップ(19): 偶数位置では o[m-10] だけが寄与
        oL = this.rvUpL[i]; oR = this.rvUpR[i];
      }
      this.rvPos = (pos + 1) & 63;
      const vLOUT = this.regs[0xC2] << 16 >> 16, vROUT = this.regs[0xC3] << 16 >> 16;
      this.rvOutL = (oL * vLOUT) >> 15; this.rvOutR = (oR * vROUT) >> 15;
    }

    // ── 1サンプル ─────────────────────────────────────────
    clock() {
      const enabled = (this.cnt & 0xC000) === 0xC000;
      this.noiseTick();
      let sumL = 0, sumR = 0, rvL = 0, rvR = 0;
      let prevOut = 0;
      for (let i = 0; i < NUM_VOICES; i++) {
        const v = this.voices[i];
        const base = i * 8;
        if (!v.hasBlock) this.decodeBlock(v);
        // 補間
        const si = (v.counter >> 12) + 3;
        const gi = (v.counter >> 4) & 0xFF;
        const buf = v.buf;
        let s = ((GAUSS[0x0FF - gi] * buf[si - 3]) >> 15)
              + ((GAUSS[0x1FF - gi] * buf[si - 2]) >> 15)
              + ((GAUSS[0x100 + gi] * buf[si - 1]) >> 15)
              + ((GAUSS[0x000 + gi] * buf[si]) >> 15);
        if (this.non & (1 << i)) s = this.noiseLevel;
        // ADSR
        this.adsrTick(v);
        const out = (s * v.level) >> 15;
        v.out = out;
        // 音量スイープ
        if (v.sweepL) { const r = SpuPsx.sweepTick(v.sweepL, v.volL); v.volL = r.level; if (r.done) v.sweepL = null; }
        if (v.sweepR) { const r = SpuPsx.sweepTick(v.sweepR, v.volR); v.volR = r.level; if (r.done) v.sweepR = null; }
        let l = (out * v.volL) >> 15, r = (out * v.volR) >> 15;
        if (this.mute[i]) { l = 0; r = 0; }
        else if (this.vol[i] !== 1) { l = (l * this.vol[i]) | 0; r = (r * this.vol[i]) | 0; }
        this.voiceOutL[i] = l; this.voiceOutR[i] = r;
        v.outL = l; v.outR = r;
        sumL += l; sumR += r;
        if (this.eon & (1 << i)) { rvL += l; rvR += r; }
        // ピッチカウンタ
        let step = this.regs[base + 2];
        if (i > 0 && (this.pmon & (1 << i))) {
          const factor = (prevOut + 0x8000);
          step = ((step << 16 >> 16) * factor) >> 15;
          step &= 0xFFFF;
        }
        if (step > 0x3FFF) step = 0x4000;
        v.counter += step;
        while ((v.counter >> 12) >= SAMPLES_PER_BLOCK) {
          v.counter -= SAMPLES_PER_BLOCK << 12;
          this.advanceBlock(v);
        }
        prevOut = out;
      }
      // メイン音量(スイープ)
      if (this.mainSweepL) { const r = SpuPsx.sweepTick(this.mainSweepL, this.mainVolL); this.mainVolL = r.level; if (r.done) this.mainSweepL = null; }
      if (this.mainSweepR) { const r = SpuPsx.sweepTick(this.mainSweepR, this.mainVolR); this.mainVolR = r.level; if (r.done) this.mainSweepR = null; }
      this.reverbTick(rvL, rvR);
      // リバーブ出力は主音量の前に足す(DuckStation SPU::Execute と同じ順序)
      const outL = (clamp16(sumL + this.rvOutL) * this.mainVolL) >> 15;
      const outR = (clamp16(sumR + this.rvOutR) * this.mainVolR) >> 15;
      this.outL = enabled ? outL : 0; this.outR = enabled ? outR : 0;
      this.sampleCount++;
    }

    // ── 補助(キャプチャ/表示用) ──────────────────────────
    /** ボイスの現在状態の控え(鍵盤表示/ロール用) */
    voiceInfo(i) {
      const v = this.voices[i];
      const base = i * 8;
      return {
        active: v.phase !== PH_OFF,
        phase: v.phase,
        level: v.level,
        pitch: this.regs[base + 2],
        startAddr: (this.regs[base + 3] << 3) & 0x7FFFF,
        curAddr: v.curAddr,
        repeatAddr: v.repeatAddr,
        volL: v.volL, volR: v.volR,
        noise: !!(this.non & (1 << i)),
        pmon: !!(this.pmon & (1 << i)),
        reverb: !!(this.eon & (1 << i)),
        adsr: this.regs[base + 4] | (this.regs[base + 5] << 16),
        keyOnFrame: v.keyOnFrame,
      };
    }
  }

  SpuPsx.NUM_VOICES = NUM_VOICES;
  SpuPsx.GAUSS = GAUSS;
  SpuPsx.PHASE = { OFF: PH_OFF, ATTACK: PH_ATTACK, DECAY: PH_DECAY, SUSTAIN: PH_SUSTAIN, RELEASE: PH_RELEASE };
  SpuPsx.envTick = envTick;

  /**
   * SPU RAM 上の ADPCM サンプルを PCM に復号する(音色抽出/表示用)。
   * addr から Loop End フラグのブロックまで読み、ループ開始点も返す。
   * @returns {{pcm:Int16Array, loopStart:number|null, loopEnd:boolean, blocks:number, endMute:boolean}}
   */
  SpuPsx.decodeSample = function (ram, addr, maxBlocks) {
    const limit = maxBlocks || 4096;
    const out = [];
    let old = 0, older = 0;
    let loopStart = null, loopEnd = false, endMute = false;
    let a = addr & 0x7FFF0;
    let blocks = 0;
    for (; blocks < limit; blocks++) {
      const hdr = ram[a];
      let shift = hdr & 0x0F; if (shift > 12) shift = 9;
      let filter = (hdr >> 4) & 7; if (filter > 4) filter = 4;
      const flags = ram[a + 1];
      if (flags & 4) loopStart = blocks * SAMPLES_PER_BLOCK;
      const f0 = ADPCM_POS[filter], f1 = ADPCM_NEG[filter];
      for (let i = 2; i < 16; i++) {
        const b = ram[a + i];
        for (let n = 0; n < 2; n++) {
          const nib = n ? (b >> 4) : (b & 0x0F);
          let s = ((nib << 12) << 16 >> 16) >> shift;
          s += (old * f0 + older * f1 + 32) >> 6;
          s = clamp16(s);
          out.push(s);
          older = old; old = s;
        }
      }
      if (flags & 1) { loopEnd = true; endMute = !(flags & 2); blocks++; break; }
      a = (a + 16) & 0x7FFFF;
      if (a === 0) break;
    }
    return { pcm: Int16Array.from(out), loopStart, loopEnd, blocks, endMute };
  };

  /**
   * 実際に鳴るとおりのサンプル構造を復号する(音程解析/ドラムパッド/変換用)。
   * start からループ終端フラグまでを「頭」とし、ループする場合の戻り先は
   *   - 頭の中にループ開始フラグがあり、かつ repeat レジスタが鳴っている間に書き換えられていなければそのフラグ
   *   - それ以外はドライバが書いた repeat レジスタ(FF7 の AKAO 等はフラグを使わずレジスタで指定する)
   * 戻り先が頭の外なら、そこからループ終端までを復号して後ろへつなぐ(loopStart = 頭の長さ)。
   * @returns {{pcm:Int16Array, loopStart:number|null, looped:boolean, endMute:boolean, blocks:number,
   *            loopAddr:number|null, byteRanges:Array<[number,number]>}}
   */
  SpuPsx.describeSample = function (ram, start, repeatReg, ignoreFlag) {
    start &= 0x7FFF0;
    const head = SpuPsx.decodeSample(ram, start, 8192);
    const headEnd = start + head.blocks * 16;
    const base = { blocks: head.blocks, endMute: head.endMute, byteRanges: [[start, headEnd]] };
    if (!head.loopEnd || head.endMute) {
      return Object.assign(base, { pcm: head.pcm, loopStart: null, looped: false, loopAddr: null });
    }
    let loopAddr;
    if (!ignoreFlag && head.loopStart != null) loopAddr = start + (head.loopStart / SAMPLES_PER_BLOCK) * 16;
    else loopAddr = repeatReg & 0x7FFF0;
    if (loopAddr >= start && loopAddr < headEnd) {
      return Object.assign(base, { pcm: head.pcm, loopStart: ((loopAddr - start) / 16) * SAMPLES_PER_BLOCK, looped: true, loopAddr });
    }
    const tail = SpuPsx.decodeSample(ram, loopAddr, 8192);
    const pcm = new Int16Array(head.pcm.length + tail.pcm.length);
    pcm.set(head.pcm, 0); pcm.set(tail.pcm, head.pcm.length);
    base.byteRanges.push([loopAddr, loopAddr + tail.blocks * 16]);
    return Object.assign(base, { pcm, loopStart: head.pcm.length, looped: true, loopAddr });
  };

  Emu.SpuPsx = SpuPsx;
  Emu.SPU_PSX_RATE = 44100;
})(window);
