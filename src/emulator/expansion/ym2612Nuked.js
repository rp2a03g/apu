/*
 * Nuked OPN2 (Yamaha YM3438/YM2612) サイクル精度エミュレータの JavaScript 移植
 * MML.Emu.YM2612Nuked
 *
 * 原著: Nuked OPN2 version 1.0.12  Copyright (C) 2017-2022 Alexey Khokholov (Nuke.YKT)
 *   https://github.com/nukeykt/Nuked-OPN2  (ym3438.c / ym3438.h)
 *   Thanks: Silicon Pr0n (YM3438 decap and die shot, digshadow),
 *           OPLx decapsulated (Matthew Gambrell, Olli Niemitalo): OPL2 ROMs.
 *
 * This file is a derived work of Nuked OPN2 and is licensed under the
 * GNU Lesser General Public License version 2.1 or later (LGPL-2.1+), same as
 * the original. It is combined with the rest of this program (GPL-2.0) which is
 * license-compatible. See the original repository for the full LGPL text.
 *
 * ★用途: src/emulator/expansion/ym2612.js(自作の近似コア、高速)と切り替えて聴き比べる
 *   「実機準拠」コア。ダイショットから起こしたログサイン/EXP ROM、EGの実タイマ挙動、
 *   LFO PMテーブル、SSG-EGの実挙動、YM2612版DACのラダー効果(mode_ym2612)をそのまま持つ。
 *   移植方針: ym3438.c を関数単位で機械的に書き換え(テストピン/ステータス読み出しは省略、
 *   ミュート/音量は出力段(ChOutput)に追加)。1コール=OPN2 1サイクル(マスタークロック/6)、
 *   24サイクルで1サンプル。書込みは実機同様にバス上のタイミングを持つため、内部キューで
 *   OPN2_WRITEBUF_DELAY(15サイクル)間隔に整流してから流す(VGMPlay同梱版と同じ)。
 *   外部インターフェースは ym2612.js と同じ: writeReg(port,reg,val) / clock()(マスタークロック毎)
 *   / mixSample() / mute[7] / vol[7] / snapshot()。
 *   constructor(clock, {chipType}) で 'ym2612'(既定、ラダー効果あり)/'ym3438'(ラダー無し)を選べる。
 *   後者は expansion/ym2610.js(Neo Geo YM2610のFM段)が使う。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const eg_num_attack = 0, eg_num_decay = 1, eg_num_sustain = 2, eg_num_release = 3;
  const ym3438_mode_ym2612 = 0x01;
  const ym3438_mode_readmode = 0x02;
  // chip_type はインスタンスごと(constructorのopts.chipType)。
  //   'ym2612'(既定): メガドライブのYM2612。9bit DACのラダー効果(不連続歪み)を再現、1サンプル中1/4
  //                   サイクルだけ出力して3倍(ym3438.c OPN2_ChOutput)。
  //   'ym3438'      : YM3438(ASIC版OPN2)。ラダー効果無し、3/4サイクル出力。FMオペレータ本体(PG/EG/
  //                   log-sin/exp ROM/LFO/SSG-EG)はOPNファミリで共通設計なので、ラダーの無い
  //                   YM2610(OPNB、expansion/ym2610.js)のFM段としてもこのモードを使う。
  const CHIP_TYPES = { ym2612: ym3438_mode_ym2612 | ym3438_mode_readmode, ym3438: ym3438_mode_readmode };

  const SIGN_EXTEND = (bit, v) => (v & ((1 << bit) - 1)) - (v & (1 << bit));

  const logsinrom = new Uint16Array([
    0x859,0x6c3,0x607,0x58b,0x52e,0x4e4,0x4a6,0x471,0x443,0x41a,0x3f5,0x3d3,0x3b5,0x398,0x37e,0x365,
    0x34e,0x339,0x324,0x311,0x2ff,0x2ed,0x2dc,0x2cd,0x2bd,0x2af,0x2a0,0x293,0x286,0x279,0x26d,0x261,
    0x256,0x24b,0x240,0x236,0x22c,0x222,0x218,0x20f,0x206,0x1fd,0x1f5,0x1ec,0x1e4,0x1dc,0x1d4,0x1cd,
    0x1c5,0x1be,0x1b7,0x1b0,0x1a9,0x1a2,0x19b,0x195,0x18f,0x188,0x182,0x17c,0x177,0x171,0x16b,0x166,
    0x160,0x15b,0x155,0x150,0x14b,0x146,0x141,0x13c,0x137,0x133,0x12e,0x129,0x125,0x121,0x11c,0x118,
    0x114,0x10f,0x10b,0x107,0x103,0x0ff,0x0fb,0x0f8,0x0f4,0x0f0,0x0ec,0x0e9,0x0e5,0x0e2,0x0de,0x0db,
    0x0d7,0x0d4,0x0d1,0x0cd,0x0ca,0x0c7,0x0c4,0x0c1,0x0be,0x0bb,0x0b8,0x0b5,0x0b2,0x0af,0x0ac,0x0a9,
    0x0a7,0x0a4,0x0a1,0x09f,0x09c,0x099,0x097,0x094,0x092,0x08f,0x08d,0x08a,0x088,0x086,0x083,0x081,
    0x07f,0x07d,0x07a,0x078,0x076,0x074,0x072,0x070,0x06e,0x06c,0x06a,0x068,0x066,0x064,0x062,0x060,
    0x05e,0x05c,0x05b,0x059,0x057,0x055,0x053,0x052,0x050,0x04e,0x04d,0x04b,0x04a,0x048,0x046,0x045,
    0x043,0x042,0x040,0x03f,0x03e,0x03c,0x03b,0x039,0x038,0x037,0x035,0x034,0x033,0x031,0x030,0x02f,
    0x02e,0x02d,0x02b,0x02a,0x029,0x028,0x027,0x026,0x025,0x024,0x023,0x022,0x021,0x020,0x01f,0x01e,
    0x01d,0x01c,0x01b,0x01a,0x019,0x018,0x017,0x017,0x016,0x015,0x014,0x014,0x013,0x012,0x011,0x011,
    0x010,0x00f,0x00f,0x00e,0x00d,0x00d,0x00c,0x00c,0x00b,0x00a,0x00a,0x009,0x009,0x008,0x008,0x007,
    0x007,0x007,0x006,0x006,0x005,0x005,0x005,0x004,0x004,0x004,0x003,0x003,0x003,0x002,0x002,0x002,
    0x002,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x000,0x000,0x000,0x000,0x000,0x000,0x000,0x000
  ]);
  const exprom = new Uint16Array([
    0x000,0x003,0x006,0x008,0x00b,0x00e,0x011,0x014,0x016,0x019,0x01c,0x01f,0x022,0x025,0x028,0x02a,
    0x02d,0x030,0x033,0x036,0x039,0x03c,0x03f,0x042,0x045,0x048,0x04b,0x04e,0x051,0x054,0x057,0x05a,
    0x05d,0x060,0x063,0x066,0x069,0x06c,0x06f,0x072,0x075,0x078,0x07b,0x07e,0x082,0x085,0x088,0x08b,
    0x08e,0x091,0x094,0x098,0x09b,0x09e,0x0a1,0x0a4,0x0a8,0x0ab,0x0ae,0x0b1,0x0b5,0x0b8,0x0bb,0x0be,
    0x0c2,0x0c5,0x0c8,0x0cc,0x0cf,0x0d2,0x0d6,0x0d9,0x0dc,0x0e0,0x0e3,0x0e7,0x0ea,0x0ed,0x0f1,0x0f4,
    0x0f8,0x0fb,0x0ff,0x102,0x106,0x109,0x10c,0x110,0x114,0x117,0x11b,0x11e,0x122,0x125,0x129,0x12c,
    0x130,0x134,0x137,0x13b,0x13e,0x142,0x146,0x149,0x14d,0x151,0x154,0x158,0x15c,0x160,0x163,0x167,
    0x16b,0x16f,0x172,0x176,0x17a,0x17e,0x181,0x185,0x189,0x18d,0x191,0x195,0x199,0x19c,0x1a0,0x1a4,
    0x1a8,0x1ac,0x1b0,0x1b4,0x1b8,0x1bc,0x1c0,0x1c4,0x1c8,0x1cc,0x1d0,0x1d4,0x1d8,0x1dc,0x1e0,0x1e4,
    0x1e8,0x1ec,0x1f0,0x1f5,0x1f9,0x1fd,0x201,0x205,0x209,0x20e,0x212,0x216,0x21a,0x21e,0x223,0x227,
    0x22b,0x230,0x234,0x238,0x23c,0x241,0x245,0x249,0x24e,0x252,0x257,0x25b,0x25f,0x264,0x268,0x26d,
    0x271,0x276,0x27a,0x27f,0x283,0x288,0x28c,0x291,0x295,0x29a,0x29e,0x2a3,0x2a8,0x2ac,0x2b1,0x2b5,
    0x2ba,0x2bf,0x2c4,0x2c8,0x2cd,0x2d2,0x2d6,0x2db,0x2e0,0x2e5,0x2e9,0x2ee,0x2f3,0x2f8,0x2fd,0x302,
    0x306,0x30b,0x310,0x315,0x31a,0x31f,0x324,0x329,0x32e,0x333,0x338,0x33d,0x342,0x347,0x34c,0x351,
    0x356,0x35b,0x360,0x365,0x36a,0x370,0x375,0x37a,0x37f,0x384,0x38a,0x38f,0x394,0x399,0x39f,0x3a4,
    0x3a9,0x3ae,0x3b4,0x3b9,0x3bf,0x3c4,0x3c9,0x3cf,0x3d4,0x3da,0x3df,0x3e4,0x3ea,0x3ef,0x3f5,0x3fa
  ]);
  const fn_note = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3];
  const eg_stephi = [[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 0]];
  const eg_am_shift = [7, 3, 1, 0];
  const pg_detune = [16, 17, 19, 20, 22, 24, 27, 29];
  const pg_lfo_sh1 = [
    [7, 7, 7, 7, 7, 7, 7, 7], [7, 7, 7, 7, 7, 7, 7, 7], [7, 7, 7, 7, 7, 7, 1, 1], [7, 7, 7, 7, 1, 1, 1, 1],
    [7, 7, 7, 1, 1, 1, 1, 0], [7, 7, 1, 1, 0, 0, 0, 0], [7, 7, 1, 1, 0, 0, 0, 0], [7, 7, 1, 1, 0, 0, 0, 0]
  ];
  const pg_lfo_sh2 = [
    [7, 7, 7, 7, 7, 7, 7, 7], [7, 7, 7, 7, 2, 2, 2, 2], [7, 7, 7, 2, 2, 2, 7, 7], [7, 7, 2, 2, 7, 7, 2, 2],
    [7, 7, 2, 7, 7, 7, 2, 7], [7, 7, 7, 2, 7, 7, 2, 1], [7, 7, 7, 2, 7, 7, 2, 1], [7, 7, 7, 2, 7, 7, 2, 1]
  ];
  const op_offset = [0x000, 0x001, 0x002, 0x100, 0x101, 0x102, 0x004, 0x005, 0x006, 0x104, 0x105, 0x106];
  const ch_offset = [0x000, 0x001, 0x002, 0x100, 0x101, 0x102];
  const lfo_cycles = [108, 77, 71, 67, 62, 44, 8, 5];
  const fm_algorithm = [
    [[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,1]],
    [[0,1,0,0,0,1,0,0],[0,0,0,0,0,0,0,0],[1,1,1,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,1,1,1]],
    [[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[1,0,0,1,1,1,1,0],[0,0,0,0,0,0,0,0],[0,0,0,0,1,1,1,1]],
    [[0,0,1,0,0,1,0,0],[0,0,0,0,0,0,0,0],[0,0,0,1,0,0,0,0],[1,1,0,1,1,0,0,0],[0,0,1,0,0,0,0,0],[1,1,1,1,1,1,1,1]]
  ];

  const OPN2_WRITEBUF_DELAY = 15; // サイクル
  const CYCLES_PER_SAMPLE = 24;   // OPN2サイクル(=マスタークロック/6)

  // 鍵盤表示用: 1周期ぶんのFM波形を「今のパラメータで再合成した概形」として作る
  // (ym2612.js snapshotYM2612 と同じ簡易合成方針。実機のクロック多重化は模擬しない)。
  // opOutはym3438.c _fmGenerate と同じ式(logsinrom/exprom、位相10bit、eg_out込みの減衰)。
  function nukedOpOut(phase10, egOut) {
    const quarter = (phase10 & 0x100) ? (phase10 ^ 0xff) & 0xff : phase10 & 0xff;
    let level = logsinrom[quarter] + (egOut << 2);
    if (level > 0x1fff) level = 0x1fff;
    let output = ((exprom[(level & 0xff) ^ 0xff] | 0x400) << 2) >> (level >> 8);
    output = (phase10 & 0x200) ? (~output) + 1 : output;
    return SIGN_EXTEND(13, output & 0x3fff);
  }
  // pgInc[0..3]=op1-4の位相増分、egOut[0..3]=op1-4の現在の減衰(TL込み)、algo=0-7、fb=0-7
  function nukedSynthWave(pgInc, egOut, algo, fb) {
    const N = 128;
    const base = pgInc[3] || 1;
    const wave = new Array(N).fill(0);
    let prev0 = 0, prev1 = 0, mx = 1e-6;
    // モジュレーション量はop間>>1、フィードバックは(直近2出力の和)>>(10-fb)。
    // ym3438.c _fmPrepare の op===0(feedback)/それ以外(>>1)と同じ規約
    const m = (x) => x >> 1;
    for (let k = 0; k < N; k++) {
      const ph = pgInc.map((inc) => Math.round((k / N) * 1024 * (inc / base)) & 0x3ff);
      const fbIn = fb ? ((prev0 + prev1) >> (10 - fb)) : 0;
      const o1 = nukedOpOut((ph[0] + fbIn) & 0x3ff, egOut[0]);
      prev0 = prev1; prev1 = o1;
      const op2 = (mod) => nukedOpOut((ph[1] + mod) & 0x3ff, egOut[1]);
      const op3 = (mod) => nukedOpOut((ph[2] + mod) & 0x3ff, egOut[2]);
      const op4 = (mod) => nukedOpOut((ph[3] + mod) & 0x3ff, egOut[3]);
      let v;
      switch (algo) {
        case 0: { const o2 = op2(m(o1)); const o3 = op3(m(o2)); v = op4(m(o3)); break; }
        case 1: { const o2 = op2(0); const o3 = op3(m(o1 + o2)); v = op4(m(o3)); break; }
        case 2: { const o2 = op2(0); const o3 = op3(m(o2)); v = op4(m(o1 + o3)); break; }
        case 3: { const o2 = op2(m(o1)); const o3 = op3(0); v = op4(m(o2 + o3)); break; }
        case 4: { const o2 = op2(m(o1)); const o3 = op3(0); const o4 = op4(m(o3)); v = o2 + o4; break; }
        case 5: { const o2 = op2(m(o1)); const o3 = op3(m(o1)); const o4 = op4(m(o1)); v = o2 + o3 + o4; break; }
        case 6: { const o2 = op2(m(o1)); const o3 = op3(0); const o4 = op4(0); v = o2 + o3 + o4; break; }
        default: { const o2 = op2(0); const o3 = op3(0); const o4 = op4(0); v = o1 + o2 + o3 + o4; break; }
      }
      wave[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
    }
    for (let k = 0; k < N; k++) wave[k] /= mx;
    return wave;
  }

  class YM2612Nuked {
    /**
     * @param {number} [clock=7670453]
     * @param {{chipType?: 'ym2612'|'ym3438'}} [opts]
     */
    constructor(clock, opts) {
      this.clockHz = clock || 7670453;
      this.sampleRate = this.clockHz / 144;
      this.chipType = (opts && opts.chipType) || 'ym2612';
      this.chip_type = CHIP_TYPES[this.chipType] !== undefined ? CHIP_TYPES[this.chipType] : CHIP_TYPES.ym2612;
      this.mute = new Array(7).fill(false); // 0-5=FM ch(ch1-6), 6=DAC
      this.vol = new Array(7).fill(1);
      this.reset();
    }

    reset() {
      const c = this;
      c.cycles = 0; c.channel = 0;
      c.mol = 0; c.mor = 0;
      // IO
      c.write_data = 0; c.write_a = 0; c.write_d = 0; c.write_a_en = 0; c.write_d_en = 0;
      c.write_busy = 0; c.write_busy_cnt = 0; c.write_fm_address = 0; c.write_fm_data = 0; c.write_fm_mode_a = 0;
      c.address = 0; c.data = 0; c.pin_test_in = 0; c.pin_irq = 0; c.busy = 0;
      // LFO
      c.lfo_en = 0; c.lfo_freq = 0; c.lfo_pm = 0; c.lfo_am = 0; c.lfo_cnt = 0; c.lfo_inc = 0; c.lfo_quotient = 0;
      // Phase generator
      c.pg_fnum = 0; c.pg_block = 0; c.pg_kcode = 0;
      c.pg_inc = new Uint32Array(24); c.pg_phase = new Uint32Array(24); c.pg_reset = new Uint8Array(24); c.pg_read = 0;
      // Envelope generator
      c.eg_cycle = 0; c.eg_cycle_stop = 0; c.eg_shift = 0; c.eg_shift_lock = 0; c.eg_timer_low_lock = 0;
      c.eg_timer = 0; c.eg_timer_inc = 0; c.eg_quotient = 0; c.eg_custom_timer = 0; c.eg_rate = 0; c.eg_ksv = 0;
      c.eg_inc = 0; c.eg_ratemax = 0;
      c.eg_sl = [0, 0]; c.eg_lfo_am = 0; c.eg_tl = [0, 0];
      c.eg_state = new Uint8Array(24); c.eg_level = new Uint16Array(24); c.eg_out = new Uint16Array(24);
      c.eg_kon = new Uint8Array(24); c.eg_kon_csm = new Uint8Array(24); c.eg_kon_latch = new Uint8Array(24);
      c.eg_csm_mode = new Uint8Array(24); c.eg_ssg_enable = new Uint8Array(24); c.eg_ssg_pgrst_latch = new Uint8Array(24);
      c.eg_ssg_repeat_latch = new Uint8Array(24); c.eg_ssg_hold_up_latch = new Uint8Array(24);
      c.eg_ssg_dir = new Uint8Array(24); c.eg_ssg_inv = new Uint8Array(24);
      c.eg_read = [0, 0]; c.eg_read_inc = 0;
      // FM
      c.fm_op1 = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]; c.fm_op2 = new Int16Array(6);
      c.fm_out = new Int16Array(24); c.fm_mod = new Uint16Array(24);
      // Channel
      c.ch_acc = new Int16Array(6); c.ch_out = new Int16Array(6); c.ch_lock = 0; c.ch_lock_l = 0; c.ch_lock_r = 0; c.ch_read = 0;
      c.ch_lock_ch = 0; // ミュート/音量用: 現在ロックしているチャンネル
      // Timer (VGM再生では使わないが元コードどおり保持)
      c.timer_a_cnt = 0; c.timer_a_reg = 0; c.timer_a_load_lock = 0; c.timer_a_load = 0; c.timer_a_enable = 0;
      c.timer_a_reset = 0; c.timer_a_load_latch = 0; c.timer_a_overflow_flag = 0; c.timer_a_overflow = 0;
      c.timer_b_cnt = 0; c.timer_b_subcnt = 0; c.timer_b_reg = 0; c.timer_b_load_lock = 0; c.timer_b_load = 0;
      c.timer_b_enable = 0; c.timer_b_reset = 0; c.timer_b_load_latch = 0; c.timer_b_overflow_flag = 0; c.timer_b_overflow = 0;
      // Register set
      c.mode_test_21 = new Uint8Array(8); c.mode_test_2c = new Uint8Array(8);
      c.mode_ch3 = 0; c.mode_kon_channel = 0; c.mode_kon_operator = new Uint8Array(4); c.mode_kon = new Uint8Array(24);
      c.mode_csm = 0; c.mode_kon_csm = 0; c.dacen = 0; c.dacdata = 0;
      c.ks = new Uint8Array(24); c.ar = new Uint8Array(24); c.sr = new Uint8Array(24); c.dt = new Uint8Array(24);
      c.multi = new Uint8Array(24); c.sl = new Uint8Array(24); c.rr = new Uint8Array(24); c.dr = new Uint8Array(24);
      c.am = new Uint8Array(24); c.tl = new Uint8Array(24); c.ssg_eg = new Uint8Array(24);
      c.fnum = new Uint16Array(6); c.block = new Uint8Array(6); c.kcode = new Uint8Array(6);
      c.fnum_3ch = new Uint16Array(6); c.block_3ch = new Uint8Array(6); c.kcode_3ch = new Uint8Array(6);
      c.reg_a4 = 0; c.reg_ac = 0;
      c.connect = new Uint8Array(6); c.fb = new Uint8Array(6); c.pan_l = new Uint8Array(6); c.pan_r = new Uint8Array(6);
      c.ams = new Uint8Array(6); c.pms = new Uint8Array(6);
      c.status = 0; c.status_time = 0;
      for (let i = 0; i < 24; i++) { c.eg_out[i] = 0x3ff; c.eg_level[i] = 0x3ff; c.eg_state[i] = eg_num_release; c.multi[i] = 1; }
      for (let i = 0; i < 6; i++) { c.pan_l[i] = 1; c.pan_r[i] = 1; }
      // 書込みキュー(サイクル単位のタイムスタンプ、OPN2_WRITEBUF_DELAY間隔)
      c.writebuf = []; c.writebuf_lasttime = 0; c.writebuf_samplecnt = 0;
      // 出力(1サンプル=24サイクル合算)
      c.accL = 0; c.accR = 0; c.lastL = 0; c.lastR = 0; c.cyc6 = 0;
      // レジスタ影(スナップショット用: どのチャンネルにどんな書込みがあったか)
      this.regs = [new Uint8Array(256), new Uint8Array(256)];
    }

    // ── 外部インターフェース ──
    /** ym2612.js と同じ: port(0/1) と レジスタ番号・値。実機のバス書込み(アドレス→データ)に展開してキューへ */
    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      this.regs[port & 1][reg] = val;
      this._writeBuffered((port & 1) << 1, reg);      // port 0/2 = address
      this._writeBuffered(((port & 1) << 1) | 1, val); // port 1/3 = data
    }
    _writeBuffered(port, data) {
      let time1 = this.writebuf_lasttime + OPN2_WRITEBUF_DELAY;
      const time2 = this.writebuf_samplecnt;
      if (time1 < time2) time1 = time2;
      this.writebuf.push({ port, data, time: time1 });
      this.writebuf_lasttime = time1;
    }
    /** マスタークロックごとに1回。6クロックでOPN2 1サイクル */
    clock() {
      if (++this.cyc6 < 6) return;
      this.cyc6 = 0;
      this._clock();
      this.accL += this.mol; this.accR += this.mor;
      // 書込みキューの消化(実機の書込みタイミング整流)
      while (this.writebuf.length && this.writebuf[0].time <= this.writebuf_samplecnt) {
        const w = this.writebuf.shift();
        this._write(w.port, w.data);
      }
      this.writebuf_samplecnt++;
      if (this.cycles === 0) { // 24サイクル=1サンプル完了
        // 6ch×(9bit×3 ±ラダー)≒±4608 を ±1.2 程度へ(ym2612.jsの出力尺度に合わせる)
        this.lastL = this.accL / 3840; this.lastR = this.accR / 3840;
        this.accL = 0; this.accR = 0;
      }
    }
    mixSample() { return { left: this.lastL, right: this.lastR }; }

    /**
     * 書込みキューを空になるまでチップを回して適用する。clock()を回さない経路(VGMの先読み
     * キャプチャ regsOnly / シークの fastForward)では、キュー経由の本コアはレジスタ状態が
     * 一切更新されず(鍵盤スナップショット/ロールが空になる、シーク後にキューが山積みのまま
     * 再生が始まる)ため、そこから呼ぶ。実時間再生と同じ順序・間隔(15サイクル刻み)で
     * 適用されるので最終レジスタ状態は同じ。キーオンのEGへの反映など数サイクル遅れて
     * 効く状態のために、空になった後さらに1サンプルぶん(24サイクル)回す。
     */
    flushWrites() {
      let guard = 0;
      while (this.writebuf.length && guard++ < 50000000) this.clock();
      for (let i = 0; i < CYCLES_PER_SAMPLE * 6; i++) this.clock();
    }

    _write(port, data) {
      port &= 3;
      this.write_data = ((port << 7) & 0x100) | data;
      if (port & 1) this.write_d |= 1; else this.write_a |= 1;
    }

    // ── 以下 ym3438.c の機械的な移植 ──
    _doIO() {
      const c = this;
      c.write_a_en = (c.write_a & 0x03) === 0x01 ? 1 : 0;
      c.write_d_en = (c.write_d & 0x03) === 0x01 ? 1 : 0;
      c.write_a = (c.write_a << 1) & 0xff; c.write_d = (c.write_d << 1) & 0xff; // Bit8u
      c.busy = c.write_busy;
      c.write_busy_cnt += c.write_busy;
      c.write_busy = ((c.write_busy && !(c.write_busy_cnt >> 5)) || c.write_d_en) ? 1 : 0;
      c.write_busy_cnt &= 0x1f;
    }

    _doRegWrite() {
      const c = this;
      let slot = c.cycles % 12;
      const channel = c.channel;
      if (c.write_fm_data) {
        if (op_offset[slot] === (c.address & 0x107)) {
          if (c.address & 0x08) slot += 12;
          switch (c.address & 0xf0) {
            case 0x30:
              c.multi[slot] = c.data & 0x0f;
              if (!c.multi[slot]) c.multi[slot] = 1; else c.multi[slot] <<= 1;
              c.dt[slot] = (c.data >> 4) & 0x07;
              break;
            case 0x40: c.tl[slot] = c.data & 0x7f; break;
            case 0x50: c.ar[slot] = c.data & 0x1f; c.ks[slot] = (c.data >> 6) & 0x03; break;
            case 0x60: c.dr[slot] = c.data & 0x1f; c.am[slot] = (c.data >> 7) & 0x01; break;
            case 0x70: c.sr[slot] = c.data & 0x1f; break;
            case 0x80:
              c.rr[slot] = c.data & 0x0f;
              c.sl[slot] = (c.data >> 4) & 0x0f;
              c.sl[slot] |= (c.sl[slot] + 1) & 0x10;
              break;
            case 0x90: c.ssg_eg[slot] = c.data & 0x0f; break;
          }
        }
        if (ch_offset[channel] === (c.address & 0x103)) {
          switch (c.address & 0xfc) {
            case 0xa0:
              c.fnum[channel] = (c.data & 0xff) | ((c.reg_a4 & 0x07) << 8);
              c.block[channel] = (c.reg_a4 >> 3) & 0x07;
              c.kcode[channel] = (c.block[channel] << 2) | fn_note[c.fnum[channel] >> 7];
              break;
            case 0xa4: c.reg_a4 = c.data & 0xff; break;
            case 0xa8:
              c.fnum_3ch[channel] = (c.data & 0xff) | ((c.reg_ac & 0x07) << 8);
              c.block_3ch[channel] = (c.reg_ac >> 3) & 0x07;
              c.kcode_3ch[channel] = (c.block_3ch[channel] << 2) | fn_note[c.fnum_3ch[channel] >> 7];
              break;
            case 0xac: c.reg_ac = c.data & 0xff; break;
            case 0xb0: c.connect[channel] = c.data & 0x07; c.fb[channel] = (c.data >> 3) & 0x07; break;
            case 0xb4:
              c.pms[channel] = c.data & 0x07; c.ams[channel] = (c.data >> 4) & 0x03;
              c.pan_l[channel] = (c.data >> 7) & 0x01; c.pan_r[channel] = (c.data >> 6) & 0x01;
              break;
          }
        }
      }
      if (c.write_a_en || c.write_d_en) {
        if (c.write_a_en) c.write_fm_data = 0;
        if (c.write_fm_address && c.write_d_en) c.write_fm_data = 1;
        if (c.write_a_en) {
          if ((c.write_data & 0xf0) !== 0x00) { c.address = c.write_data; c.write_fm_address = 1; }
          else c.write_fm_address = 0;
        }
        if (c.write_d_en && (c.write_data & 0x100) === 0) {
          switch (c.write_fm_mode_a) {
            case 0x21: for (let i = 0; i < 8; i++) c.mode_test_21[i] = (c.write_data >> i) & 0x01; break;
            case 0x22:
              c.lfo_en = ((c.write_data >> 3) & 0x01) ? 0x7f : 0;
              c.lfo_freq = c.write_data & 0x07;
              break;
            case 0x24: c.timer_a_reg &= 0x03; c.timer_a_reg |= (c.write_data & 0xff) << 2; break;
            case 0x25: c.timer_a_reg &= 0x3fc; c.timer_a_reg |= c.write_data & 0x03; break;
            case 0x26: c.timer_b_reg = c.write_data & 0xff; break;
            case 0x27:
              c.mode_ch3 = (c.write_data & 0xc0) >> 6;
              c.mode_csm = c.mode_ch3 === 2 ? 1 : 0;
              c.timer_a_load = c.write_data & 0x01;
              c.timer_a_enable = (c.write_data >> 2) & 0x01;
              c.timer_a_reset = (c.write_data >> 4) & 0x01;
              c.timer_b_load = (c.write_data >> 1) & 0x01;
              c.timer_b_enable = (c.write_data >> 3) & 0x01;
              c.timer_b_reset = (c.write_data >> 5) & 0x01;
              break;
            case 0x28:
              for (let i = 0; i < 4; i++) c.mode_kon_operator[i] = (c.write_data >> (4 + i)) & 0x01;
              if ((c.write_data & 0x03) === 0x03) c.mode_kon_channel = 0xff;
              else c.mode_kon_channel = (c.write_data & 0x03) + ((c.write_data >> 2) & 1) * 3;
              break;
            case 0x2a: c.dacdata &= 0x01; c.dacdata |= (c.write_data ^ 0x80) << 1; break;
            case 0x2b: c.dacen = c.write_data >> 7; break;
            case 0x2c:
              for (let i = 0; i < 8; i++) c.mode_test_2c[i] = (c.write_data >> i) & 0x01;
              c.dacdata &= 0x1fe; c.dacdata |= c.mode_test_2c[3];
              c.eg_custom_timer = (!c.mode_test_2c[7] && c.mode_test_2c[6]) ? 1 : 0;
              break;
          }
        }
        if (c.write_a_en) c.write_fm_mode_a = c.write_data & 0x1ff;
      }
      if (c.write_fm_data) c.data = c.write_data & 0xff;
    }

    _phaseCalcIncrement() {
      const c = this;
      const chan = c.channel, slot = c.cycles;
      let fnum = c.pg_fnum;
      const fnum_h = fnum >> 4;
      const lfo = c.lfo_pm;
      let lfo_l = lfo & 0x0f;
      const pms = c.pms[chan];
      const dt = c.dt[slot], dt_l = dt & 0x03;
      let detune = 0;
      let kcode = c.pg_kcode;
      fnum <<= 1;
      if (lfo_l & 0x08) lfo_l ^= 0x0f;
      let fm = (fnum_h >> pg_lfo_sh1[pms][lfo_l]) + (fnum_h >> pg_lfo_sh2[pms][lfo_l]);
      if (pms > 5) fm <<= pms - 5;
      fm >>= 2;
      if (lfo & 0x10) fnum -= fm; else fnum += fm;
      fnum &= 0xfff;
      let basefreq = (fnum << c.pg_block) >> 2;
      if (dt_l) {
        if (kcode > 0x1c) kcode = 0x1c;
        const block = kcode >> 2, note = kcode & 0x03;
        const sum = block + 9 + (((dt_l === 3) ? 1 : 0) | (dt_l & 0x02));
        const sum_h = sum >> 1, sum_l = sum & 0x01;
        detune = pg_detune[(sum_l << 2) | note] >> (9 - sum_h);
      }
      if (dt & 0x04) basefreq -= detune; else basefreq += detune;
      basefreq &= 0x1ffff;
      c.pg_inc[slot] = ((basefreq * c.multi[slot]) >> 1) & 0xfffff;
    }

    _phaseGenerate() {
      const c = this;
      let slot = (c.cycles + 20) % 24;
      if (c.pg_reset[slot]) c.pg_inc[slot] = 0;
      slot = (c.cycles + 19) % 24;
      if (c.pg_reset[slot] || c.mode_test_21[3]) c.pg_phase[slot] = 0;
      c.pg_phase[slot] = (c.pg_phase[slot] + c.pg_inc[slot]) & 0xfffff;
    }

    _envelopeSSGEG() {
      const c = this;
      const slot = c.cycles;
      let direction = 0;
      c.eg_ssg_pgrst_latch[slot] = 0; c.eg_ssg_repeat_latch[slot] = 0; c.eg_ssg_hold_up_latch[slot] = 0;
      if (c.ssg_eg[slot] & 0x08) {
        direction = c.eg_ssg_dir[slot];
        if (c.eg_level[slot] & 0x200) {
          if ((c.ssg_eg[slot] & 0x03) === 0x00) c.eg_ssg_pgrst_latch[slot] = 1;
          if ((c.ssg_eg[slot] & 0x01) === 0x00) c.eg_ssg_repeat_latch[slot] = 1;
          if ((c.ssg_eg[slot] & 0x03) === 0x02) direction ^= 1;
          if ((c.ssg_eg[slot] & 0x03) === 0x03) direction = 1;
        }
        if (c.eg_kon_latch[slot] && ((c.ssg_eg[slot] & 0x07) === 0x05 || (c.ssg_eg[slot] & 0x07) === 0x03)) c.eg_ssg_hold_up_latch[slot] = 1;
        direction &= c.eg_kon[slot];
      }
      c.eg_ssg_dir[slot] = direction;
      c.eg_ssg_enable[slot] = (c.ssg_eg[slot] >> 3) & 0x01;
      c.eg_ssg_inv[slot] = (c.eg_ssg_dir[slot] ^ (((c.ssg_eg[slot] >> 2) & 0x01) & ((c.ssg_eg[slot] >> 3) & 0x01))) & c.eg_kon[slot];
    }

    _envelopeADSR() {
      const c = this;
      const slot = (c.cycles + 22) % 24;
      const nkon = c.eg_kon_latch[slot], okon = c.eg_kon[slot];
      let level, nextlevel = 0, ssg_level;
      let nextstate = c.eg_state[slot];
      let inc = 0;
      c.eg_read[0] = c.eg_read_inc;
      c.eg_read_inc = c.eg_inc > 0 ? 1 : 0;
      c.pg_reset[slot] = ((nkon && !okon) || c.eg_ssg_pgrst_latch[slot]) ? 1 : 0;
      const kon_event = (nkon && !okon) || (okon && c.eg_ssg_repeat_latch[slot]);
      const koff_event = okon && !nkon;
      ssg_level = level = c.eg_level[slot];
      if (c.eg_ssg_inv[slot]) { ssg_level = (512 - level) & 0x3ff; }
      if (koff_event) level = ssg_level;
      let eg_off;
      if (c.eg_ssg_enable[slot]) eg_off = level >> 9;
      else eg_off = (level & 0x3f0) === 0x3f0 ? 1 : 0;
      nextlevel = level;
      if (kon_event) {
        nextstate = eg_num_attack;
        if (c.eg_ratemax) nextlevel = 0;
        else if (c.eg_state[slot] === eg_num_attack && level !== 0 && c.eg_inc && nkon) inc = ((~level) << c.eg_inc) >> 5;
      } else {
        switch (c.eg_state[slot]) {
          case eg_num_attack:
            if (level === 0) nextstate = eg_num_decay;
            else if (c.eg_inc && !c.eg_ratemax && nkon) inc = ((~level) << c.eg_inc) >> 5;
            break;
          case eg_num_decay:
            if ((level >> 4) === (c.eg_sl[1] << 1)) nextstate = eg_num_sustain;
            else if (!eg_off && c.eg_inc) { inc = 1 << (c.eg_inc - 1); if (c.eg_ssg_enable[slot]) inc <<= 2; }
            break;
          case eg_num_sustain:
          case eg_num_release:
            if (!eg_off && c.eg_inc) { inc = 1 << (c.eg_inc - 1); if (c.eg_ssg_enable[slot]) inc <<= 2; }
            break;
        }
        if (!nkon) nextstate = eg_num_release;
      }
      if (c.eg_kon_csm[slot]) nextlevel |= c.eg_tl[1] << 3;
      if (!kon_event && !c.eg_ssg_hold_up_latch[slot] && c.eg_state[slot] !== eg_num_attack && eg_off) { nextstate = eg_num_release; nextlevel = 0x3ff; }
      nextlevel += inc;
      c.eg_kon[slot] = c.eg_kon_latch[slot];
      c.eg_level[slot] = nextlevel & 0x3ff;
      c.eg_state[slot] = nextstate;
    }

    _envelopePrepare() {
      const c = this;
      let inc = 0;
      const slot = c.cycles;
      let rate = (c.eg_rate << 1) + c.eg_ksv;
      if (rate > 0x3f) rate = 0x3f;
      const sum = ((rate >> 2) + c.eg_shift_lock) & 0x0f;
      if (c.eg_rate !== 0 && c.eg_quotient === 2) {
        if (rate < 48) {
          switch (sum) {
            case 12: inc = 1; break;
            case 13: inc = (rate >> 1) & 0x01; break;
            case 14: inc = rate & 0x01; break;
          }
        } else {
          inc = eg_stephi[rate & 0x03][c.eg_timer_low_lock] + (rate >> 2) - 11;
          if (inc > 4) inc = 4;
        }
      }
      c.eg_inc = inc;
      c.eg_ratemax = (rate >> 1) === 0x1f ? 1 : 0;
      let rate_sel = c.eg_state[slot];
      if ((c.eg_kon[slot] && c.eg_ssg_repeat_latch[slot]) || (!c.eg_kon[slot] && c.eg_kon_latch[slot])) rate_sel = eg_num_attack;
      switch (rate_sel) {
        case eg_num_attack: c.eg_rate = c.ar[slot]; break;
        case eg_num_decay: c.eg_rate = c.dr[slot]; break;
        case eg_num_sustain: c.eg_rate = c.sr[slot]; break;
        case eg_num_release: c.eg_rate = (c.rr[slot] << 1) | 0x01; break;
      }
      c.eg_ksv = c.pg_kcode >> (c.ks[slot] ^ 0x03);
      if (c.am[slot]) c.eg_lfo_am = c.lfo_am >> eg_am_shift[c.ams[c.channel]];
      else c.eg_lfo_am = 0;
      c.eg_tl[1] = c.eg_tl[0]; c.eg_tl[0] = c.tl[slot];
      c.eg_sl[1] = c.eg_sl[0]; c.eg_sl[0] = c.sl[slot];
    }

    _envelopeGenerate() {
      const c = this;
      const slot = (c.cycles + 23) % 24;
      let level = c.eg_level[slot];
      if (c.eg_ssg_inv[slot]) level = 512 - level;
      if (c.mode_test_21[5]) level = 0;
      level &= 0x3ff;
      level += c.eg_lfo_am;
      if (!(c.mode_csm && c.channel === 2 + 1)) level += c.eg_tl[0] << 3;
      if (level > 0x3ff) level = 0x3ff;
      c.eg_out[slot] = level;
    }

    _updateLFO() {
      const c = this;
      if ((c.lfo_quotient & lfo_cycles[c.lfo_freq]) === lfo_cycles[c.lfo_freq]) { c.lfo_quotient = 0; c.lfo_cnt++; }
      else c.lfo_quotient += c.lfo_inc;
      c.lfo_cnt &= c.lfo_en;
    }

    _fmPrepare() {
      const c = this;
      let slot = (c.cycles + 6) % 24;
      const channel = c.channel;
      const op = (slot / 6) | 0;
      const connect = c.connect[channel];
      const prevslot = (c.cycles + 18) % 24;
      let mod1 = 0, mod2 = 0;
      if (fm_algorithm[op][0][connect]) mod2 |= c.fm_op1[channel][0];
      if (fm_algorithm[op][1][connect]) mod1 |= c.fm_op1[channel][1];
      if (fm_algorithm[op][2][connect]) mod1 |= c.fm_op2[channel];
      if (fm_algorithm[op][3][connect]) mod2 |= c.fm_out[prevslot];
      if (fm_algorithm[op][4][connect]) mod1 |= c.fm_out[prevslot];
      // Bit16s 演算: |= は16bit符号付きの範囲で行われるので明示的に丸める
      mod1 = (mod1 << 16) >> 16; mod2 = (mod2 << 16) >> 16;
      let mod = ((mod1 + mod2) << 16) >> 16;
      if (op === 0) { mod = mod >> (10 - c.fb[channel]); if (!c.fb[channel]) mod = 0; }
      else mod >>= 1;
      c.fm_mod[slot] = mod & 0xffff;
      slot = (c.cycles + 18) % 24;
      if (((slot / 6) | 0) === 0) { c.fm_op1[channel][1] = c.fm_op1[channel][0]; c.fm_op1[channel][0] = c.fm_out[slot]; }
      if (((slot / 6) | 0) === 2) c.fm_op2[channel] = c.fm_out[slot];
    }

    _chGenerate() {
      const c = this;
      const slot = (c.cycles + 18) % 24;
      const channel = c.channel;
      const op = (slot / 6) | 0;
      const test_dac = c.mode_test_2c[5];
      let acc = c.ch_acc[channel];
      let add = test_dac;
      if (op === 0 && !test_dac) acc = 0;
      if (fm_algorithm[op][5][c.connect[channel]] && !test_dac) add += c.fm_out[slot] >> 5;
      let sum = acc + add;
      if (sum > 255) sum = 255; else if (sum < -256) sum = -256;
      if (op === 0 || test_dac) c.ch_out[channel] = c.ch_acc[channel];
      c.ch_acc[channel] = sum;
    }

    _chOutput() {
      const c = this;
      const cycles = c.cycles;
      const slot = c.cycles;
      let channel = c.channel;
      const test_dac = c.mode_test_2c[5];
      let out, sign, out_en;
      c.ch_read = c.ch_lock;
      if (slot < 12) channel++;
      if ((cycles & 3) === 0) {
        if (!test_dac) c.ch_lock = c.ch_out[channel];
        c.ch_lock_l = c.pan_l[channel]; c.ch_lock_r = c.pan_r[channel];
        c.ch_lock_ch = channel;
      }
      let isDac = false;
      if (((cycles >> 2) === 1 && c.dacen) || test_dac) { out = SIGN_EXTEND(8, c.dacdata); isDac = true; }
      else out = c.ch_lock;
      c.mol = 0; c.mor = 0;
      if (this.chip_type & ym3438_mode_ym2612) {
        out_en = ((cycles & 3) === 3) || test_dac;
        sign = out >> 8;
        if (out >= 0) { out++; sign++; }
        c.mol = (c.ch_lock_l && out_en) ? out : sign;
        c.mor = (c.ch_lock_r && out_en) ? out : sign;
        c.mol *= 3; c.mor *= 3;
      } else {
        out_en = ((cycles & 3) !== 0) || test_dac;
        if (c.ch_lock_l && out_en) c.mol = out;
        if (c.ch_lock_r && out_en) c.mor = out;
      }
      // ミュート/ch別音量(本移植での追加。実機には無い): 出力段で丸ごと落とす/掛ける
      const mi = isDac ? 6 : c.ch_lock_ch;
      if (this.mute[mi]) { c.mol = 0; c.mor = 0; }
      else if (this.vol[mi] !== 1) { c.mol *= this.vol[mi]; c.mor *= this.vol[mi]; }
    }

    _fmGenerate() {
      const c = this;
      const slot = (c.cycles + 19) % 24;
      const phase = (c.fm_mod[slot] + (c.pg_phase[slot] >> 10)) & 0x3ff;
      let quarter;
      if (phase & 0x100) quarter = (phase ^ 0xff) & 0xff; else quarter = phase & 0xff;
      let level = logsinrom[quarter];
      level += c.eg_out[slot] << 2;
      if (level > 0x1fff) level = 0x1fff;
      let output = ((exprom[(level & 0xff) ^ 0xff] | 0x400) << 2) >> (level >> 8);
      if (phase & 0x200) output = ((~output) ^ (c.mode_test_21[4] << 13)) + 1;
      else output = output ^ (c.mode_test_21[4] << 13);
      output = SIGN_EXTEND(13, output & 0x3fff);
      c.fm_out[slot] = output;
    }

    _doTimerA() {
      const c = this;
      let time, load = c.timer_a_overflow;
      if (c.cycles === 2) {
        load |= (!c.timer_a_load_lock && c.timer_a_load) ? 1 : 0;
        c.timer_a_load_lock = c.timer_a_load;
        c.mode_kon_csm = c.mode_csm ? load : 0;
      }
      time = c.timer_a_load_latch ? c.timer_a_reg : c.timer_a_cnt;
      c.timer_a_load_latch = load;
      if ((c.cycles === 1 && c.timer_a_load_lock) || c.mode_test_21[2]) time++;
      if (c.timer_a_reset) { c.timer_a_reset = 0; c.timer_a_overflow_flag = 0; }
      else c.timer_a_overflow_flag |= c.timer_a_overflow & c.timer_a_enable;
      c.timer_a_overflow = time >> 10;
      c.timer_a_cnt = time & 0x3ff;
    }

    _doTimerB() {
      const c = this;
      let time, load = c.timer_b_overflow;
      if (c.cycles === 2) { load |= (!c.timer_b_load_lock && c.timer_b_load) ? 1 : 0; c.timer_b_load_lock = c.timer_b_load; }
      time = c.timer_b_load_latch ? c.timer_b_reg : c.timer_b_cnt;
      c.timer_b_load_latch = load;
      if (c.cycles === 1) c.timer_b_subcnt++;
      if ((c.timer_b_subcnt === 0x10 && c.timer_b_load_lock) || c.mode_test_21[2]) time++;
      c.timer_b_subcnt &= 0x0f;
      if (c.timer_b_reset) { c.timer_b_reset = 0; c.timer_b_overflow_flag = 0; }
      else c.timer_b_overflow_flag |= c.timer_b_overflow & c.timer_b_enable;
      c.timer_b_overflow = time >> 8;
      c.timer_b_cnt = time & 0xff;
    }

    _keyOn() {
      const c = this;
      const slot = c.cycles, chan = c.channel;
      c.eg_kon_latch[slot] = c.mode_kon[slot];
      c.eg_kon_csm[slot] = 0;
      if (c.channel === 2 && c.mode_kon_csm) { c.eg_kon_latch[slot] = 1; c.eg_kon_csm[slot] = 1; }
      if (c.cycles === c.mode_kon_channel) {
        c.mode_kon[chan] = c.mode_kon_operator[0];
        c.mode_kon[chan + 12] = c.mode_kon_operator[1];
        c.mode_kon[chan + 6] = c.mode_kon_operator[2];
        c.mode_kon[chan + 18] = c.mode_kon_operator[3];
      }
    }

    _clock() {
      const c = this;
      const slot = c.cycles;
      c.lfo_inc = c.mode_test_21[1];
      c.pg_read >>= 1;
      c.eg_read[1] >>= 1;
      c.eg_cycle++;
      if (c.cycles === 1 && c.eg_quotient === 2) {
        c.eg_shift_lock = c.eg_cycle_stop ? 0 : c.eg_shift + 1;
        c.eg_timer_low_lock = c.eg_timer & 0x03;
      }
      switch (c.cycles) {
        case 0:
          c.lfo_pm = c.lfo_cnt >> 2;
          if (c.lfo_cnt & 0x40) c.lfo_am = c.lfo_cnt & 0x3f; else c.lfo_am = c.lfo_cnt ^ 0x3f;
          c.lfo_am <<= 1;
          break;
        case 1:
          c.eg_quotient++; c.eg_quotient %= 3;
          c.eg_cycle = 0; c.eg_cycle_stop = 1; c.eg_shift = 0;
          c.eg_timer_inc |= c.eg_quotient >> 1;
          c.eg_timer = c.eg_timer + c.eg_timer_inc;
          c.eg_timer_inc = c.eg_timer >> 12;
          c.eg_timer &= 0xfff;
          break;
        case 2:
          c.pg_read = c.pg_phase[21] & 0x3ff;
          c.eg_read[1] = c.eg_out[0];
          break;
        case 13:
          c.eg_cycle = 0; c.eg_cycle_stop = 1; c.eg_shift = 0;
          c.eg_timer = c.eg_timer + c.eg_timer_inc;
          c.eg_timer_inc = c.eg_timer >> 12;
          c.eg_timer &= 0xfff;
          break;
        case 23:
          c.lfo_inc |= 1;
          break;
      }
      c.eg_timer &= ~(c.mode_test_21[5] << c.eg_cycle);
      if (((c.eg_timer >> c.eg_cycle) | (c.pin_test_in & c.eg_custom_timer)) & c.eg_cycle_stop) { c.eg_shift = c.eg_cycle; c.eg_cycle_stop = 0; }

      this._doIO();
      this._doTimerA();
      this._doTimerB();
      this._keyOn();
      this._chOutput();
      this._chGenerate();
      this._fmPrepare();
      this._fmGenerate();
      this._phaseGenerate();
      this._phaseCalcIncrement();
      this._envelopeADSR();
      this._envelopeGenerate();
      this._envelopeSSGEG();
      this._envelopePrepare();

      if (c.mode_ch3) {
        switch (slot) {
          case 1: c.pg_fnum = c.fnum_3ch[1]; c.pg_block = c.block_3ch[1]; c.pg_kcode = c.kcode_3ch[1]; break;
          case 7: c.pg_fnum = c.fnum_3ch[0]; c.pg_block = c.block_3ch[0]; c.pg_kcode = c.kcode_3ch[0]; break;
          case 13: c.pg_fnum = c.fnum_3ch[2]; c.pg_block = c.block_3ch[2]; c.pg_kcode = c.kcode_3ch[2]; break;
          case 19: default:
            c.pg_fnum = c.fnum[(c.channel + 1) % 6]; c.pg_block = c.block[(c.channel + 1) % 6]; c.pg_kcode = c.kcode[(c.channel + 1) % 6];
            break;
        }
      } else {
        c.pg_fnum = c.fnum[(c.channel + 1) % 6]; c.pg_block = c.block[(c.channel + 1) % 6]; c.pg_kcode = c.kcode[(c.channel + 1) % 6];
      }
      this._updateLFO();
      this._doRegWrite();
      c.cycles = (c.cycles + 1) % 24;
      c.channel = c.cycles % 6;
      if (c.status_time) c.status_time--;
    }

    // ── 鍵盤表示用スナップショット(ym2612.js の snapshotYM2612 と同じ形) ──
    // スロット番号: op1=ch, op2=ch+12, op3=ch+6, op4=ch+18
    snapshot() {
      const c = this;
      const fs = this.sampleRate;
      const CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
      const slotOf = (ch, op) => [ch, ch + 12, ch + 6, ch + 18][op];
      const out = { channels: [], dac: null };
      for (let ch = 0; ch < 6; ch++) {
        const fnum = c.fnum[ch], block = c.block[ch];
        const freq = fnum > 0 ? fnum * Math.pow(2, block - 1) * fs / (1 << 20) : 0;
        const algo = c.connect[ch];
        let minOut = 0x3ff, minTl = 127, anyOn = false, keyOn = false;
        for (const op of CARRIERS[algo]) {
          const s = slotOf(ch, op);
          minTl = Math.min(minTl, c.tl[s]);
          if (c.eg_kon[s]) keyOn = true;
          if (c.eg_state[s] !== eg_num_release || c.eg_level[s] < 0x3f0) { anyOn = true; minOut = Math.min(minOut, c.eg_out[s]); }
        }
        const vol = anyOn ? Math.max(0, 1 - minOut / 0x3ff) : 0;
        const tlVol = Math.max(0, 1 - minTl / 127);
        const active = anyOn && vol > 0.02 && freq > 0 && !(ch === 5 && c.dacen);
        let waveData = null;
        if (active) {
          const slots4 = [0, 1, 2, 3].map((op) => slotOf(ch, op));
          waveData = nukedSynthWave(slots4.map((s) => c.pg_inc[s]), slots4.map((s) => c.eg_out[s]), algo, c.fb[ch]);
        }
        out.channels.push({ freq, vol, rawVol: Math.round(vol * 15), active, keyOn, tlVol, algo, fb: c.fb[ch], panL: c.pan_l[ch], panR: c.pan_r[ch], waveData, patch: Emu.decodeOpnPatch(c.regs, ch) });
      }
      const level = ((c.dacdata >> 1) ^ 0x80) & 0xff;
      out.dac = { enabled: !!c.dacen, level, active: !!c.dacen, vol: c.dacen ? Math.min(1, Math.abs(level - 0x80) / 64) : 0 };
      return out;
    }
  }

  Emu.YM2612Nuked = YM2612Nuked;
})(window);
