/*
 * OPLL (Yamaha YM2413 / Konami VRC VII = DS1001) サイクルアキュレート・エミュレータ
 * MML.Emu.OPLLNuked
 *
 * nukeykt/Nuked-OPLL (opll.c v1.0.2, GPLv2, Copyright (C) 2019-2023 Nuke.YKT) の移植。
 * 音色ROM・アルゴリズムとも siliconpr0n (digshadow, John McMaster) による
 * VRC VII decap / die shot 由来。本リポジトリもGPLv2なのでライセンス上の問題は無い。
 *
 * 従来の emu2413 0.6x系移植(vrc7.js / opllMsx.js)との違い:
 *   - 演算器が1個しか無い実チップの18スロット時分割パイプラインをそのまま再現する。
 *     1サンプル = 18サイクル、各サイクルが1スロットぶんの演算と1chぶんのDAC出力を担う。
 *   - EGは位相蓄積(dphaseARTable等の近似)ではなく、実機のeg_timer + シフト量テーブル方式。
 *     キーオン時のDAMP(rate12まで一旦落としてからアタック)も含む。
 *   - AM/PM LFOがfloat sin近似ではなく実機の整数カウンタ/テーブル。
 *   - 出力は9bit相当の時分割DACをそのまま合算するため、実機特有の量子化感が出る。
 *
 * チップ種別 (constructor の opts.chipType):
 *   'ds1001'(VRC7): 6メロディch、リズムモード無し(rhythm常時0x20)、音色ROM=patch_ds1001。
 *   'ym2413'(FMPAC/VGM、既定): 9メロディch、リズムモード有り、音色ROM=patch_ym2413。
 *
 * クロック: clock() は「呼び出し側のホストクロック1サイクル」ごとに呼ぶ。OPLLの1内部
 * サイクルは実チップのマスタクロック4個ぶんなので、
 *   VRC7 (NSF)      : ホスト=NES CPU 1.789773MHz = マスタ/2 → 2ホストサイクルで1内部サイクル
 *   FMPAC/VGM       : ホスト=3.579545MHz = マスタそのもの   → 4ホストサイクルで1内部サイクル
 * どちらも 18内部サイクル = 1サンプル で 49716Hz になる(36 / 72 ホストサイクル)。
 * ★この非対称は [[opll-fmpac-clock-divider-octave-bug]] と同じ理由。取り違えると1オクターブずれる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ---- EG状態 ----
  const EG_ATTACK = 0, EG_DECAY = 1, EG_SUSTAIN = 2, EG_RELEASE = 3;
  // ---- リズムスロット選択 ----
  const RM_BD0 = 0, RM_HH = 1, RM_TOM = 2, RM_BD1 = 3, RM_SD = 4, RM_TC = 5;
  const PATCH_DRUM_0 = 15; // patchrom内のドラム音色開始index

  const SAMPLE_RATE = 49716;
  const CYCLES_PER_SAMPLE = 18; // OPLL内部サイクル/サンプル

  const LOGSIN = new Uint16Array([
    0x859,0x6c3,0x607,0x58b,0x52e,0x4e4,0x4a6,0x471,0x443,0x41a,0x3f5,0x3d3,0x3b5,0x398,0x37e,
    0x365,0x34e,0x339,0x324,0x311,0x2ff,0x2ed,0x2dc,0x2cd,0x2bd,0x2af,0x2a0,0x293,0x286,0x279,
    0x26d,0x261,0x256,0x24b,0x240,0x236,0x22c,0x222,0x218,0x20f,0x206,0x1fd,0x1f5,0x1ec,0x1e4,
    0x1dc,0x1d4,0x1cd,0x1c5,0x1be,0x1b7,0x1b0,0x1a9,0x1a2,0x19b,0x195,0x18f,0x188,0x182,0x17c,
    0x177,0x171,0x16b,0x166,0x160,0x15b,0x155,0x150,0x14b,0x146,0x141,0x13c,0x137,0x133,0x12e,
    0x129,0x125,0x121,0x11c,0x118,0x114,0x10f,0x10b,0x107,0x103,0x0ff,0x0fb,0x0f8,0x0f4,0x0f0,
    0x0ec,0x0e9,0x0e5,0x0e2,0x0de,0x0db,0x0d7,0x0d4,0x0d1,0x0cd,0x0ca,0x0c7,0x0c4,0x0c1,0x0be,
    0x0bb,0x0b8,0x0b5,0x0b2,0x0af,0x0ac,0x0a9,0x0a7,0x0a4,0x0a1,0x09f,0x09c,0x099,0x097,0x094,
    0x092,0x08f,0x08d,0x08a,0x088,0x086,0x083,0x081,0x07f,0x07d,0x07a,0x078,0x076,0x074,0x072,
    0x070,0x06e,0x06c,0x06a,0x068,0x066,0x064,0x062,0x060,0x05e,0x05c,0x05b,0x059,0x057,0x055,
    0x053,0x052,0x050,0x04e,0x04d,0x04b,0x04a,0x048,0x046,0x045,0x043,0x042,0x040,0x03f,0x03e,
    0x03c,0x03b,0x039,0x038,0x037,0x035,0x034,0x033,0x031,0x030,0x02f,0x02e,0x02d,0x02b,0x02a,
    0x029,0x028,0x027,0x026,0x025,0x024,0x023,0x022,0x021,0x020,0x01f,0x01e,0x01d,0x01c,0x01b,
    0x01a,0x019,0x018,0x017,0x017,0x016,0x015,0x014,0x014,0x013,0x012,0x011,0x011,0x010,0x00f,
    0x00f,0x00e,0x00d,0x00d,0x00c,0x00c,0x00b,0x00a,0x00a,0x009,0x009,0x008,0x008,0x007,0x007,
    0x007,0x006,0x006,0x005,0x005,0x005,0x004,0x004,0x004,0x003,0x003,0x003,0x002,0x002,0x002,
    0x002,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x000,0x000,0x000,0x000,0x000,0x000,0x000,
    0x000
  ]);

  const EXPROM = new Uint16Array([
    0x7fa,0x7f5,0x7ef,0x7ea,0x7e4,0x7df,0x7da,0x7d4,0x7cf,0x7c9,0x7c4,0x7bf,0x7b9,0x7b4,0x7ae,
    0x7a9,0x7a4,0x79f,0x799,0x794,0x78f,0x78a,0x784,0x77f,0x77a,0x775,0x770,0x76a,0x765,0x760,
    0x75b,0x756,0x751,0x74c,0x747,0x742,0x73d,0x738,0x733,0x72e,0x729,0x724,0x71f,0x71a,0x715,
    0x710,0x70b,0x706,0x702,0x6fd,0x6f8,0x6f3,0x6ee,0x6e9,0x6e5,0x6e0,0x6db,0x6d6,0x6d2,0x6cd,
    0x6c8,0x6c4,0x6bf,0x6ba,0x6b5,0x6b1,0x6ac,0x6a8,0x6a3,0x69e,0x69a,0x695,0x691,0x68c,0x688,
    0x683,0x67f,0x67a,0x676,0x671,0x66d,0x668,0x664,0x65f,0x65b,0x657,0x652,0x64e,0x649,0x645,
    0x641,0x63c,0x638,0x634,0x630,0x62b,0x627,0x623,0x61e,0x61a,0x616,0x612,0x60e,0x609,0x605,
    0x601,0x5fd,0x5f9,0x5f5,0x5f0,0x5ec,0x5e8,0x5e4,0x5e0,0x5dc,0x5d8,0x5d4,0x5d0,0x5cc,0x5c8,
    0x5c4,0x5c0,0x5bc,0x5b8,0x5b4,0x5b0,0x5ac,0x5a8,0x5a4,0x5a0,0x59c,0x599,0x595,0x591,0x58d,
    0x589,0x585,0x581,0x57e,0x57a,0x576,0x572,0x56f,0x56b,0x567,0x563,0x560,0x55c,0x558,0x554,
    0x551,0x54d,0x549,0x546,0x542,0x53e,0x53b,0x537,0x534,0x530,0x52c,0x529,0x525,0x522,0x51e,
    0x51b,0x517,0x514,0x510,0x50c,0x509,0x506,0x502,0x4ff,0x4fb,0x4f8,0x4f4,0x4f1,0x4ed,0x4ea,
    0x4e7,0x4e3,0x4e0,0x4dc,0x4d9,0x4d6,0x4d2,0x4cf,0x4cc,0x4c8,0x4c5,0x4c2,0x4be,0x4bb,0x4b8,
    0x4b5,0x4b1,0x4ae,0x4ab,0x4a8,0x4a4,0x4a1,0x49e,0x49b,0x498,0x494,0x491,0x48e,0x48b,0x488,
    0x485,0x482,0x47e,0x47b,0x478,0x475,0x472,0x46f,0x46c,0x469,0x466,0x463,0x460,0x45d,0x45a,
    0x457,0x454,0x451,0x44e,0x44b,0x448,0x445,0x442,0x43f,0x43c,0x439,0x436,0x433,0x430,0x42d,
    0x42a,0x428,0x425,0x422,0x41f,0x41c,0x419,0x416,0x414,0x411,0x40e,0x40b,0x408,0x406,0x403,
    0x400
  ]);

  const CH_OFFSET = new Uint8Array([1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 6, 7, 8, 0]);
  const PG_MULTI = new Uint8Array([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
  const EG_STEPHI = [
    new Uint8Array([0, 0, 0, 0]),
    new Uint8Array([1, 0, 0, 0]),
    new Uint8Array([1, 0, 1, 0]),
    new Uint8Array([1, 1, 1, 0])
  ];
  const EG_KSLTABLE = new Uint8Array([0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64]);

  // PATCH_DS1001
  const PATCH_DS1001 = [
    { tl: 5, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[0,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[14, 8], dr:[ 8, 1], sl:[ 4, 2], rr:[ 2, 7] }, // @1
    { tl:20, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 6], sl:[ 2, 1], rr:[ 3, 2] }, // @2
    { tl: 8, dc:0, dm:1, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,1], multi:[ 1, 1], ksl:[0,0], ar:[15,11], dr:[10, 2], sl:[ 2, 1], rr:[ 0, 2] }, // @3
    { tl:12, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 6, 2], rr:[ 1, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 1, 6], sl:[ 0, 2], rr:[ 1, 8] }, // @5
    { tl: 6, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 2, 1], ksl:[0,0], ar:[10,14], dr:[ 3, 2], sl:[15,15], rr:[ 4, 4] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 1, 7] }, // @7
    { tl:34, dc:1, dm:0, fb:7, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 1], rr:[ 1, 7] }, // @8
    { tl:37, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[1,0], ksr:[1,1], multi:[ 5, 1], ksl:[0,0], ar:[ 4, 7], dr:[ 0, 3], sl:[ 7, 0], rr:[ 2, 1] }, // @9
    { tl:15, dc:0, dm:1, fb:7, am:[1,0], vib:[0,0], et:[1,0], ksr:[1,0], multi:[ 5, 1], ksl:[0,0], ar:[10,10], dr:[ 8, 5], sl:[ 5, 0], rr:[ 1, 2] }, // @10
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @11
    { tl:17, dc:0, dm:0, fb:6, am:[0,0], vib:[1,0], et:[1,1], ksr:[1,0], multi:[ 1, 3], ksl:[0,0], ar:[ 6, 7], dr:[ 5, 4], sl:[ 1, 1], rr:[ 8, 6] }, // @12
    { tl:19, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 2], ksl:[3,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @13
    { tl:12, dc:0, dm:0, fb:0, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 3], ksl:[0,0], ar:[ 9,12], dr:[ 4, 0], sl:[ 3,15], rr:[ 3, 6] }, // @14
    { tl:13, dc:0, dm:0, fb:0, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,1], multi:[ 1, 2], ksl:[0,0], ar:[12,13], dr:[ 1, 5], sl:[ 5, 0], rr:[ 6, 6] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // PATCH_YM2413
  const PATCH_YM2413 = [
    { tl:30, dc:1, dm:0, fb:7, am:[0,0], vib:[1,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[13, 7], dr:[ 0, 8], sl:[ 0, 1], rr:[ 0, 7] }, // @1
    { tl:26, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 7], sl:[ 2, 1], rr:[ 3, 3] }, // @2
    { tl:25, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,12], dr:[ 2, 4], sl:[ 1, 2], rr:[ 1, 3] }, // @3
    { tl:14, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 7, 2], rr:[ 0, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 0, 6], sl:[ 0, 2], rr:[ 0, 8] }, // @5
    { tl:22, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 1, 2], ksl:[0,0], ar:[14, 7], dr:[ 0, 1], sl:[ 0, 1], rr:[ 0, 8] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 0, 7] }, // @7
    { tl:45, dc:1, dm:0, fb:4, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 0], rr:[ 0, 7] }, // @8
    { tl:27, dc:0, dm:0, fb:6, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 6, 6], dr:[ 4, 5], sl:[ 1, 1], rr:[ 0, 7] }, // @9
    { tl:11, dc:1, dm:1, fb:0, am:[0,0], vib:[1,1], et:[0,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8,15], dr:[ 5, 7], sl:[ 7, 0], rr:[ 1, 7] }, // @10
    { tl: 3, dc:1, dm:0, fb:1, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,14], dr:[10, 4], sl:[ 1, 0], rr:[ 0, 4] }, // @11
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @12
    { tl:12, dc:0, dm:0, fb:5, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,1], multi:[ 1, 0], ksl:[0,0], ar:[12,15], dr:[ 2, 5], sl:[ 2, 4], rr:[ 0, 2] }, // @13
    { tl:21, dc:0, dm:0, fb:3, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 1], ksl:[1,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @14
    { tl: 9, dc:0, dm:0, fb:3, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,0], multi:[ 1, 1], ksl:[2,0], ar:[15,14], dr:[ 1, 4], sl:[ 4, 1], rr:[ 0, 3] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // ---- サイクル→チャンネル対応表 ----
  // output_m は ismod=(cycles/3)&1 が0のサイクルだけ「そのchのキャリア出力」を運ぶ。
  // 担当chは CH_OFFSET を演算パイプラインの段数ぶん遡った位置。段数は解析で出すより
  // 実測が確実なので、1chずつ鳴らして output_m が立つサイクルを調べた結果 11 と判明
  // (cycle 0,1,2→ch6,7,8 / 6,7,8→ch0,1,2 / 12,13,14→ch3,4,5)。
  const PIPELINE_DELAY = 11;
  const CARRIER_CH = new Int8Array(18).fill(-1);
  for (let c = 0; c < 18; c++) {
    if (((c / 3) | 0) & 1) continue;          // モジュレータ側のサイクルは出力しない
    CARRIER_CH[c] = CH_OFFSET[(c + PIPELINE_DELAY) % 18];
  }
  // output_r(リズム)も同様に実測(太鼓を1種ずつ鳴らして output_r が立つサイクルを特定)。
  // 各太鼓は1巡で2回ぶん出力される(実機の時分割DACがリズムchを2回読むため。旧コアには
  // 無かった挙動で、リズムがメロディに対して相対的に大きく出るのはこれが理由)。
  //   BD:cycle 0,5 / SD:1,9 / CYM:2,10 / HH:3,16 / TOM:4,17
  // 鍵盤のミュート枠は旧コア(opllMsx.js)と同じく BD=ch6 / HH,SD=ch7 / TOM,CYM=ch8。
  // ★2026-08-22: 打楽器のミュート/音量は実チャンネル(6-8)ではなく専用の添字9-13を使う。
  // SDとHHは実機では同じch7、TOMとCYMは同じch8だが、鍵盤には5行が別々に出るため
  // 実ch単位だと2行が同じ添字を共有し、getMuteConfig()の書き込み順で片方が無視される。
  // ここは出力サイクルで打楽器を識別できるので5種を独立させられる(keyboard.js KF_RHYTHM_INDEX)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14; // 0-8=メロディch / 9-13=BD,SD,TOM,CYM,HH
  const RHYTHM_CH = new Int8Array(18).fill(-1);
  RHYTHM_CH[0] = MUTE_BD;  RHYTHM_CH[5] = MUTE_BD;       // BD
  RHYTHM_CH[1] = MUTE_SD;  RHYTHM_CH[9] = MUTE_SD;       // SD
  RHYTHM_CH[3] = MUTE_HH;  RHYTHM_CH[16] = MUTE_HH;      // HH
  RHYTHM_CH[4] = MUTE_TOM; RHYTHM_CH[17] = MUTE_TOM;     // TOM
  RHYTHM_CH[2] = MUTE_CYM; RHYTHM_CH[10] = MUTE_CYM;     // CYM

  // ---- eg_level[] のスロット番号 ↔ (ch, mod/car) 対応 ----
  // eg_level は「サイクル番号=スロット番号」で索かれ、そのスロットの担当は
  // ch=CH_OFFSET[c] / mcsel=((c+1)/3)&1 (1がキャリア)。鍵盤スナップショット用に逆引きを作る。
  const SLOT_MOD = new Int8Array(9).fill(-1);
  const SLOT_CAR = new Int8Array(9).fill(-1);
  for (let c = 0; c < 18; c++) {
    const ch = CH_OFFSET[c];
    if (((((c + 1) / 3) | 0) & 1) === 1) SLOT_CAR[ch] = c; else SLOT_MOD[ch] = c;
  }

  // 打楽器5種が使う eg_level のスロット番号(bd,sd,tom,cym,hh)。実測で確認済み
  // (1種ずつ鳴らして下がるスロットを特定: BD=11と14, SD=15, TOM=13, CYM=16, HH=12)。
  const RHYTHM_SLOT = [SLOT_CAR[6], SLOT_CAR[7], SLOT_MOD[8], SLOT_CAR[8], SLOT_MOD[7]];

  const s8 = (v) => (v << 24) >> 24; // int8_t への切り詰め(rm_enableの算術右シフト用)

  function newPatch() {
    return {
      tl: 0, dc: 0, dm: 0, fb: 0,
      am: [0, 0], vib: [0, 0], et: [0, 0], ksr: [0, 0],
      multi: [0, 0], ksl: [0, 0], ar: [0, 0], dr: [0, 0], sl: [0, 0], rr: [0, 0]
    };
  }

  class OPLLNuked {
    constructor(opts) {
      opts = opts || {};
      this.chipType = (opts.chipType === 'ds1001') ? 'ds1001' : 'ym2413';
      this.isDs1001 = this.chipType === 'ds1001';
      this.patchrom = this.isDs1001 ? PATCH_DS1001 : PATCH_YM2413;
      this.numCh = this.isDs1001 ? 6 : 9;
      // ホストクロック→内部サイクルの分周(冒頭コメント参照)
      this.hostPerOpll = opts.hostCyclesPerOpllCycle || (this.isDs1001 ? 2 : 4);
      // 0-8=メロディch / 9-13=リズム(BD,SD,TOM,CYM,HH)。RHYTHM_CH のコメント参照
      this.mute = new Array(NUM_MUTE_SLOTS).fill(false);
      this.vol = new Array(NUM_MUTE_SLOTS).fill(1);
      this._alloc();
      this.reset();
    }

    _alloc() {
      this.eg_state = new Uint8Array(18);
      this.eg_level = new Uint8Array(18);
      this.pg_phase = new Uint32Array(18);
      this.op_fb1 = new Int16Array(9);
      this.op_fb2 = new Int16Array(9);
      this.fnum = new Uint16Array(9);
      this.block = new Uint8Array(9);
      this.kon = new Uint8Array(9);
      this.son = new Uint8Array(9);
      this.regVol = new Uint8Array(9);
      this.inst = new Uint8Array(9);
      this.patch = newPatch();
      this.regShadow = new Uint8Array(0x40); // $00-$3F の素の値(スナップショット/デバッグ用)
      this._rhythmPeak = new Uint8Array(5); // 打楽器のピークホールド(_rhythmSlotInfo参照)
      this.writebuf = [];
      this.writeHead = 0; // shift()を使わないための取り出し位置
    }

    reset() {
      this.cycles = 0; this.slot = 0;
      this.write_data = 0; this.write_a = 0; this.write_d = 0;
      this.write_a_en = 0; this.write_d_en = 0;
      this.write_fm_address = 0; this.write_fm_data = 0; this.write_mode_address = 0;
      this.address = 0; this.data = 0;

      this.eg_counter_state = 0; this.eg_counter_state_prev = 0;
      this.eg_timer = 0; this.eg_timer_low_lock = 0; this.eg_timer_carry = 0;
      this.eg_timer_shift = 0; this.eg_timer_shift_lock = 0; this.eg_timer_shift_stop = 0;
      this.eg_kon = 0; this.eg_dokon = 0; this.eg_off = 0;
      this.eg_rate = 0; this.eg_maxrate = 0; this.eg_zerorate = 0;
      this.eg_inc_lo = 0; this.eg_inc_hi = 0; this.eg_rate_hi = 0;
      this.eg_sl = 0; this.eg_ksltl = 0; this.eg_out = 0x7f; this.eg_silent = 0;

      this.pg_fnum = 0; this.pg_block = 0; this.pg_out = 0; this.pg_inc = 0; this.pg_phase_next = 0;

      this.op_fbsum = 0; this.op_mod = 0; this.op_neg = 0;
      this.op_logsin = 0; this.op_exp_m = 0; this.op_exp_s = 0;

      this.ch_out = 0; this.ch_out_hh = 0; this.ch_out_tm = 0;
      this.ch_out_bd = 0; this.ch_out_sd = 0; this.ch_out_tc = 0;

      this.lfo_counter = 0; this.lfo_vib_counter = 0; this.lfo_am_counter = 0;
      this.lfo_am_step = 0; this.lfo_am_dir = 0; this.lfo_am_car = 0; this.lfo_am_out = 0;

      this.rhythm = 0; this.testmode = 0;
      this.c_instr = 0; this.c_op = 0; this.c_tl = 0; this.c_dc = 0; this.c_dm = 0; this.c_fb = 0;
      this.c_am = 0; this.c_vib = 0; this.c_et = 0; this.c_ksr = 0;
      this.c_ksr_freq = 0; this.c_ksl_freq = 0; this.c_ksl_block = 0;
      this.c_multi = 0; this.c_ksl = 0;
      this.c_adrr = [0, 0, 0];
      this.c_sl = 0; this.c_fnum = 0; this.c_block = 0;

      this.rm_enable = 0; this.rm_noise = 0; this.rm_select = RM_TC + 1;
      this.rm_hh_bit2 = 0; this.rm_hh_bit3 = 0; this.rm_hh_bit7 = 0; this.rm_hh_bit8 = 0;
      this.rm_tc_bit3 = 0; this.rm_tc_bit5 = 0;

      this.output_m = 0; this.output_r = 0;

      this.eg_state.fill(EG_RELEASE);
      this.eg_level.fill(0x7f);
      this._rhythmPeak.fill(0x7f);
      this.pg_phase.fill(0);
      this.op_fb1.fill(0); this.op_fb2.fill(0);
      this.fnum.fill(0); this.block.fill(0); this.kon.fill(0); this.son.fill(0);
      this.regVol.fill(0); this.inst.fill(0);
      this.regShadow.fill(0);
      const p = this.patch;
      p.tl = p.dc = p.dm = p.fb = 0;
      for (let i = 0; i < 2; i++) {
        p.am[i] = p.vib[i] = p.et[i] = p.ksr[i] = 0;
        p.multi[i] = p.ksl[i] = p.ar[i] = p.dr[i] = p.sl[i] = p.rr[i] = 0;
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      this._addrLatch = 0;
      this._writePhase = 0;

      if (this.isDs1001) { // VRC7はリズムモードが常時ON扱い
        this.rhythm = 0x20;
        this.rm_enable = s8(0x80);
      }

      this.hostAccum = 0;
      this.sampleAccum = 0;
      this.sampleCycles = 0;
      this.lastSample = 0;
      this.dcX = 0; this.dcY = 0; this.dcPrimed = 0;
    }

    // ────────── OPLL_DoIO ──────────
    _doIO() {
      this.write_a_en = ((this.write_a & 0x03) === 0x01) ? 1 : 0;
      this.write_d_en = ((this.write_d & 0x03) === 0x01) ? 1 : 0;
      this.write_a = (this.write_a << 1) & 0xff;
      this.write_d = (this.write_d << 1) & 0xff;
    }

    // ────────── OPLL_DoModeWrite ──────────
    _doModeWrite() {
      if (!((this.write_mode_address & 0x10) && this.write_d_en)) return;
      const slot = this.write_mode_address & 0x01;
      const d = this.write_data;
      const p = this.patch;
      switch (this.write_mode_address & 0x0f) {
        case 0x00: case 0x01:
          p.multi[slot] = d & 0x0f;
          p.ksr[slot] = (d >> 4) & 0x01;
          p.et[slot] = (d >> 5) & 0x01;
          p.vib[slot] = (d >> 6) & 0x01;
          p.am[slot] = (d >> 7) & 0x01;
          break;
        case 0x02: p.ksl[0] = (d >> 6) & 0x03; p.tl = d & 0x3f; break;
        case 0x03:
          p.ksl[1] = (d >> 6) & 0x03;
          p.dc = (d >> 4) & 0x01; p.dm = (d >> 3) & 0x01; p.fb = d & 0x07;
          break;
        case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
        case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        case 0x0e:
          this.rhythm = d & 0x3f;
          if (this.isDs1001) this.rhythm |= 0x20;
          this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
          break;
        case 0x0f: this.testmode = d & 0x0f; break;
      }
    }

    // ────────── OPLL_DoRegWrite ──────────
    _doRegWrite() {
      if (this.write_a_en) {
        if ((this.write_data & 0xc0) === 0x00) {
          this.write_fm_address = 1;
          this.address = this.write_data;
        } else {
          this.write_fm_address = 0;
        }
      }
      if (this.write_fm_address && this.write_d_en) this.data = this.write_data;

      if (this.write_fm_data && !this.write_a_en) {
        if ((this.address & 0x0f) === this.cycles && this.cycles < 16) {
          const channel = this.cycles % 9;
          switch (this.address & 0xf0) {
            case 0x10:
              this.fnum[channel] = (this.fnum[channel] & 0x100) | this.data;
              break;
            case 0x20:
              this.fnum[channel] = (this.fnum[channel] & 0xff) | ((this.data & 0x01) << 8);
              this.block[channel] = (this.data >> 1) & 0x07;
              this.kon[channel] = (this.data >> 4) & 0x01;
              this.son[channel] = (this.data >> 5) & 0x01;
              break;
            case 0x30:
              this.regVol[channel] = this.data & 0x0f;
              this.inst[channel] = (this.data >> 4) & 0x0f;
              break;
          }
        }
      }

      if (this.write_a_en) this.write_fm_data = 0;
      if (this.write_fm_address && this.write_d_en) this.write_fm_data = 1;
      if (this.write_a_en) {
        this.write_mode_address = ((this.write_data & 0xf0) === 0x00)
          ? (0x10 | (this.write_data & 0x0f)) : 0x00;
      }
    }

    // ────────── OPLL_PreparePatch1 / 2 ──────────
    _selectPatch(mcsel) {
      const ch = CH_OFFSET[this.cycles];
      const instr = this.inst[ch];
      if (this.rm_select <= RM_TC) return this.patchrom[PATCH_DRUM_0 + this.rm_select];
      if (instr > 0) return this.patchrom[instr - 1];
      return this.patch;
    }

    _preparePatch1() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      if (this.rm_select === RM_HH || this.rm_select === RM_TOM) this.c_tl = this.inst[ch] << 2;
      else if (mcsel === 1) this.c_tl = this.regVol[ch] << 2;
      else this.c_tl = patch.tl;

      this.c_adrr[0] = patch.ar[mcsel];
      this.c_adrr[1] = patch.dr[mcsel];
      this.c_adrr[2] = patch.rr[mcsel];
      this.c_et = patch.et[mcsel];
      this.c_ksr = patch.ksr[mcsel];
      this.c_ksl = patch.ksl[mcsel];
      this.c_ksr_freq = (this.block[ch] << 1) | (this.fnum[ch] >> 8);
      this.c_ksl_freq = this.fnum[ch] >> 5;
      this.c_ksl_block = this.block[ch];
    }

    _preparePatch2() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      this.c_fnum = this.fnum[ch];
      this.c_block = this.block[ch];
      this.c_multi = patch.multi[mcsel];
      this.c_sl = patch.sl[mcsel];
      this.c_fb = patch.fb;
      this.c_vib = patch.vib[mcsel];
      this.c_am = patch.am[mcsel];
      this.c_dc = ((this.c_dc << 1) | patch.dc) & 0xff;
      this.c_dm = ((this.c_dm << 1) | patch.dm) & 0xff;
    }

    // ────────── OPLL_PhaseGenerate ──────────
    _phaseGenerate() {
      this.pg_phase[(this.cycles + 17) % 18] = (this.pg_phase_next + this.pg_inc) >>> 0;

      let ismod;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod = 0;
      else ismod = (((this.cycles + 3) / 3) | 0) & 1;

      const phase = this.pg_phase[this.cycles];
      if ((this.testmode & 0x04)
        || (ismod && (this.eg_dokon & 0x8000)) || (!ismod && (this.eg_dokon & 0x01))) {
        this.pg_phase_next = 0;
      } else {
        this.pg_phase_next = phase;
      }

      if (this.cycles === 13) {
        this.rm_hh_bit2 = (phase >>> (2 + 9)) & 1;
        this.rm_hh_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_hh_bit7 = (phase >>> (7 + 9)) & 1;
        this.rm_hh_bit8 = (phase >>> (8 + 9)) & 1;
      } else if (this.cycles === 17 && (this.rm_enable & 0x80)) {
        this.rm_tc_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_tc_bit5 = (phase >>> (5 + 9)) & 1;
      }

      let pg_out;
      if (this.rm_enable & 0x80) {
        let rm_bit;
        switch (this.cycles) {
          case 13: // HH
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = rm_bit << 9;
            pg_out |= (rm_bit ^ (this.rm_noise & 1)) ? 0xd0 : 0x34;
            break;
          case 16: // SD
            pg_out = (this.rm_hh_bit8 << 9)
                   | ((this.rm_hh_bit8 ^ (this.rm_noise & 1)) << 8);
            break;
          case 17: // TC
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = (rm_bit << 9) | 0x100;
            break;
          default:
            pg_out = phase >>> 9;
        }
      } else {
        pg_out = phase >>> 9;
      }
      this.pg_out = pg_out & 0xffff;
    }

    // ────────── OPLL_PhaseCalcIncrement ──────────
    _phaseCalcIncrement() {
      let freq = this.c_fnum << 1;
      const block = this.c_block;
      if (this.c_vib) {
        switch (this.lfo_vib_counter) {
          case 0: case 4: break;
          case 1: case 3: freq += freq >> 8; break;
          case 2: freq += freq >> 7; break;
          case 5: case 7: freq -= freq >> 8; break;
          case 6: freq -= freq >> 7; break;
        }
      }
      freq = (freq << block) >> 1;
      this.pg_inc = (freq * PG_MULTI[this.c_multi]) >>> 1;
    }

    // ────────── OPLL_EnvelopeKSLTL ──────────
    _envelopeKSLTL() {
      let ksl = EG_KSLTABLE[this.c_ksl_freq] - ((8 - this.c_ksl_block) << 3);
      if (ksl < 0) ksl = 0;
      ksl <<= 1;
      ksl = this.c_ksl ? (ksl >> (3 - this.c_ksl)) : 0;
      this.eg_ksltl = ksl + (this.c_tl << 1);
    }

    // ────────── OPLL_EnvelopeOutput ──────────
    _envelopeOutput() {
      let level = this.eg_level[(this.cycles + 17) % 18];
      level += this.eg_ksltl;
      if (this.c_am) level += this.lfo_am_out;
      if (level >= 128) level = 127;
      if (this.testmode & 0x01) level = 0;
      this.eg_out = level;
    }

    // ────────── OPLL_EnvelopeGenerate ──────────
    _envelopeGenerate() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;

      // --- EGタイマ ---
      let timer_inc;
      if ((this.eg_counter_state & 3) !== 3) timer_inc = 0;
      else if (this.cycles === 0) timer_inc = 1;
      else timer_inc = this.eg_timer_carry;

      const timer_low = this.eg_timer & 3;
      let timer_bit = (this.eg_timer & 1) + timer_inc;
      this.eg_timer_carry = timer_bit >> 1;
      this.eg_timer = (((timer_bit & 1) << 17) | (this.eg_timer >>> 1)) >>> 0;
      if (this.testmode & 0x08) {
        this.eg_timer &= 0x2ffff;
        this.eg_timer |= (this.write_data << (16 - 2)) & 0x10000;
      }
      if (!this.eg_timer_shift_stop && ((this.eg_timer >>> 16) & 1)) {
        this.eg_timer_shift = this.cycles;
      }
      if (this.cycles === 0 && (this.eg_counter_state_prev & 1) === 1) {
        this.eg_timer_low_lock = timer_low;
        this.eg_timer_shift_lock = this.eg_timer_shift;
        if (this.eg_timer_shift_lock > 13) this.eg_timer_shift_lock = 0;
        this.eg_timer_shift = 0;
      }
      this.eg_timer_shift_stop |= (this.eg_timer >>> 16) & 1;
      if (this.cycles === 0) this.eg_timer_shift_stop = 0;
      this.eg_counter_state_prev = this.eg_counter_state;
      if (this.cycles === 17) this.eg_counter_state = (this.eg_counter_state + 1) & 0xff;

      // --- レベル更新 ---
      const idx = (this.cycles + 16) % 18;
      const level = this.eg_level[idx];
      let next_level = level;
      const zero = (level === 0);
      this.eg_silent = (level === 0x7f) ? 1 : 0;

      if (this.eg_state[idx] !== EG_ATTACK && (this.eg_off & 2) && !(this.eg_dokon & 2)) {
        next_level = 0x7f;
      }
      if (this.eg_maxrate && (this.eg_dokon & 2)) next_level = 0x00;

      const state = this.eg_state[idx];
      let next_state = EG_ATTACK;
      let step = 0;
      const sl = this.eg_sl;

      switch (state) {
        case EG_ATTACK:
          if (!this.eg_maxrate && (this.eg_kon & 2) && !zero) {
            const shift = (this.eg_rate_hi < 12) ? this.eg_inc_lo : (this.eg_rate_hi - 11 + this.eg_inc_hi);
            if (shift > 0) step = (~level) >> (5 - shift);
          }
          next_state = zero ? EG_DECAY : EG_ATTACK;
          break;
        case EG_DECAY:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2) && (level >> 3) !== sl) {
            step = this._egStep();
          }
          next_state = ((level >> 3) === sl) ? EG_SUSTAIN : EG_DECAY;
          break;
        case EG_SUSTAIN:
        case EG_RELEASE:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2)) step = this._egStep();
          next_state = state;
          break;
      }

      if (!(this.eg_kon & 2)) next_state = EG_RELEASE;
      if (this.eg_dokon & 2) next_state = EG_ATTACK;

      this.eg_level[idx] = (next_level + step) & 0xff;
      this.eg_state[idx] = next_state;

      // --- 次サイクルぶんのレート計算 ---
      const rate_hi = this.eg_rate >> 2;
      const rate_lo = this.eg_rate & 3;
      this.eg_inc_hi = EG_STEPHI[rate_lo][this.eg_timer_low_lock];
      const sum = (this.eg_timer_shift_lock + rate_hi) & 0x0f;
      this.eg_inc_lo = 0;
      if (rate_hi < 12 && !this.eg_zerorate) {
        switch (sum) {
          case 12: this.eg_inc_lo = 1; break;
          case 13: this.eg_inc_lo = (rate_lo >> 1) & 1; break;
          case 14: this.eg_inc_lo = rate_lo & 1; break;
        }
      }
      this.eg_maxrate = (rate_hi === 0x0f) ? 1 : 0;
      this.eg_rate_hi = rate_hi;

      this.eg_kon = ((this.eg_kon << 1) | this.kon[CH_OFFSET[this.cycles]]) & 0xff;
      this.eg_off = ((this.eg_off << 1) | (((this.eg_level[this.cycles] >> 2) === 0x1f) ? 1 : 0)) & 0xff;

      switch (this.rm_select) {
        case RM_BD0: case RM_BD1: this.eg_kon |= (this.rhythm >> 4) & 1; break;
        case RM_SD:  this.eg_kon |= (this.rhythm >> 3) & 1; break;
        case RM_TOM: this.eg_kon |= (this.rhythm >> 2) & 1; break;
        case RM_TC:  this.eg_kon |= (this.rhythm >> 1) & 1; break;
        case RM_HH:  this.eg_kon |= this.rhythm & 1; break;
      }

      let rate = 0;
      this.eg_dokon = (this.eg_dokon << 1) & 0xffff;
      let state_rate = this.eg_state[this.cycles];
      if (state_rate === EG_RELEASE && (this.eg_kon & 1) && (this.eg_off & 1)) {
        state_rate = EG_ATTACK;
        this.eg_dokon |= 1;
      }
      switch (state_rate) {
        case EG_ATTACK: rate = this.c_adrr[0]; break;
        case EG_DECAY: rate = this.c_adrr[1]; break;
        case EG_SUSTAIN: if (!this.c_et) rate = this.c_adrr[2]; break;
        case EG_RELEASE: rate = this.son[CH_OFFSET[this.cycles]] ? 5 : this.c_adrr[2]; break;
      }
      if (!(this.eg_kon & 1) && !mcsel && this.rm_select !== RM_TOM && this.rm_select !== RM_HH) rate = 0;
      if ((this.eg_kon & 1) && this.eg_state[this.cycles] === EG_RELEASE && !(this.eg_off & 1)) rate = 12;
      if (!(this.eg_kon & 1) && !this.son[CH_OFFSET[this.cycles]] && mcsel === 1 && !this.c_et) rate = 7;

      this.eg_zerorate = (rate === 0) ? 1 : 0;
      let ksr = this.c_ksr_freq;
      if (!this.c_ksr) ksr >>= 2;
      this.eg_rate = (rate << 2) + ksr;
      if (this.eg_rate & 0x40) this.eg_rate = 0x3c | (ksr & 3);
      this.eg_sl = this.c_sl;
    }

    // DECAY/SUSTAIN/RELEASE共通の増分(opll.cで同じ式が2箇所に展開されているもの)
    _egStep() {
      const rh = this.eg_rate_hi, ih = this.eg_inc_hi, il = this.eg_inc_lo;
      const cs = this.eg_counter_state_prev;
      const i0 = (rh === 15 || (rh === 14 && ih)) ? 1 : 0;
      const i1 = ((rh === 14 && !ih) || (rh === 13 && ih)
        || (rh === 13 && !ih && (cs & 1))
        || (rh === 12 && ih && (cs & 1))
        || (rh === 12 && !ih && ((cs & 3) === 3))
        || (il && ((cs & 3) === 3))) ? 1 : 0;
      return (i0 << 1) | i1;
    }

    // ────────── OPLL_Channel ──────────
    _channel() {
      let ch_out = this.ch_out;
      const ismod = ((this.cycles / 3) | 0) & 1;
      const mute_m = ismod || ((this.rm_enable & 0x40) && (this.cycles + 15) % 18 >= 12);

      if (this.isDs1001) {
        this.output_m = ch_out;
        if (this.output_m >= 0) this.output_m++;
        if (mute_m) this.output_m = 0;
        this.output_r = 0;
      } else {
        let mute_r = 1;
        if (this.rm_enable & 0x40) {
          switch (this.cycles) {
            case 16: case 17: case 0: case 1: case 2:
            case 3: case 4: case 5: case 9: case 10:
              mute_r = 0; break;
          }
        }
        const sign0 = ch_out >> 8;
        let sign = sign0;
        if (ch_out >= 0) { ch_out++; sign++; }
        this.output_m = mute_m ? sign : ch_out;
        this.output_r = mute_r ? sign : ch_out;
      }

      // ── ch別ミュート/音量(実機には無い機能) ──
      // output_m / output_r は最終DAC出力なので、ここで倍率を掛けても合成には一切影響しない。
      const cm = CARRIER_CH[this.cycles];
      if (cm >= 0) {
        if (this.mute[cm]) this.output_m = 0;
        else if (this.vol[cm] !== 1) this.output_m = this.output_m * this.vol[cm];
      }
      const cr = RHYTHM_CH[this.cycles];
      if (cr >= 0 && this.output_r !== 0) {
        if (this.mute[cr]) this.output_r = 0;
        else if (this.vol[cr] !== 1) this.output_r = this.output_r * this.vol[cr];
      }
    }

    // ────────── OPLL_Operator ──────────
    _operator() {
      let ismod1, ismod2, ismod3;
      if ((this.rm_enable & 0x80) && (this.cycles === 15 || this.cycles === 16)) ismod1 = 0;
      else ismod1 = (((this.cycles + 1) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod2 = 0;
      else ismod2 = (((this.cycles + 3) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 16 || this.cycles === 17)) ismod3 = 0;
      else ismod3 = ((this.cycles / 3) | 0) & 1;

      let op_mod = 0;
      if (ismod3) op_mod |= this.op_mod << 1;
      if (ismod2 && this.c_fb) op_mod |= this.op_fbsum >> (7 - this.c_fb);

      let exp_shift = this.op_exp_s;
      if (this.eg_silent || ((this.op_neg & 2) && (ismod1 ? (this.c_dm & 4) : (this.c_dc & 4)))) {
        exp_shift |= 12;
      }

      let output = this.op_exp_m >> exp_shift;
      if (!this.eg_silent && (this.op_neg & 2)) output = ~output;

      let level = this.op_logsin + (this.eg_out << 4);
      if (level >= 4096) level = 4095;
      this.op_exp_m = EXPROM[level & 0xff];
      this.op_exp_s = level >> 8;

      let phase = (op_mod + this.pg_out) & 0x3ff;
      if (phase & 0x100) phase ^= 0xff;
      this.op_logsin = LOGSIN[phase & 0xff];
      this.op_neg = ((this.op_neg << 1) | (phase >> 9)) & 0xff;
      this.op_fbsum = (this.op_fb1[(this.cycles + 3) % 9] + this.op_fb2[(this.cycles + 3) % 9]) >> 1;

      if (ismod1) {
        this.op_fb2[this.cycles % 9] = this.op_fb1[this.cycles % 9];
        this.op_fb1[this.cycles % 9] = output;
      }
      this.op_mod = output & 0x1ff;

      let routput = 0;
      if (!this.isDs1001) {
        switch (this.cycles) {
          case 2: routput = this.ch_out_hh; break;
          case 3: routput = this.ch_out_tm; break;
          case 4: routput = this.ch_out_bd; break;
          case 8: routput = this.ch_out_sd; break;
          case 9: routput = this.ch_out_tc; break;
        }
        switch (this.cycles) {
          case 15: this.ch_out_hh = output >> 3; break;
          case 16: this.ch_out_tm = output >> 3; break;
          case 17: this.ch_out_bd = output >> 3; break;
          case 0: this.ch_out_sd = output >> 3; break;
          case 1: this.ch_out_tc = output >> 3; break;
        }
      }
      if (!(this.rm_enable & 0x80)) routput = 0;

      this.ch_out = ismod1 ? routput : (output >> 3);
    }

    // ────────── OPLL_DoRhythm / OPLL_DoLFO ──────────
    _doRhythm() {
      let nbit = (this.rm_noise ^ (this.rm_noise >>> 14)) & 0x01;
      nbit |= ((this.rm_noise === 0x00) ? 1 : 0) | ((this.testmode >> 1) & 0x01);
      this.rm_noise = ((nbit << 22) | (this.rm_noise >>> 1)) >>> 0;
    }

    _doLFO() {
      let am_inc = 0;
      if (this.cycles === 17) {
        let vib_step = (((this.lfo_counter & 0x3ff) + 1) >> 10);
        this.lfo_am_step = ((this.lfo_counter & 0x3f) + 1) >> 6;
        vib_step |= (this.testmode >> 3) & 0x01;
        this.lfo_vib_counter = (this.lfo_vib_counter + vib_step) & 0x07;
        this.lfo_counter = (this.lfo_counter + 1) & 0xffff;
      }
      if ((this.lfo_am_step || (this.testmode & 0x08)) && this.cycles < 9) {
        am_inc = this.lfo_am_dir | ((this.cycles === 0) ? 1 : 0);
      }
      if (this.cycles >= 9) this.lfo_am_car = 0;
      if (this.cycles === 0) {
        if (this.lfo_am_dir && (this.lfo_am_counter & 0x7f) === 0) this.lfo_am_dir = 0;
        else if (!this.lfo_am_dir && (this.lfo_am_counter & 0x69) === 0x69) this.lfo_am_dir = 1;
      }
      let am_bit = (this.lfo_am_counter & 0x01) + am_inc + this.lfo_am_car;
      this.lfo_am_car = am_bit >> 1;
      am_bit &= 0x01;
      this.lfo_am_counter = ((am_bit << 8) | (this.lfo_am_counter >>> 1)) & 0x1ff;

      if (this.testmode & 0x02) {
        this.lfo_vib_counter = 0;
        this.lfo_counter = 0;
        this.lfo_am_dir = 0;
        this.lfo_am_counter &= 0xff;
      }
    }

    // ────────── OPLL_Clock 1回ぶん ──────────
    _stepOpll() {
      // buffer[0]/[1] 相当。前サイクルの OPLL_Channel が確定させた値を取り込む
      this.sampleAccum += this.output_m + this.output_r;

      if (this.cycles === 0) this.lfo_am_out = (this.lfo_am_counter >> 3) & 0x0f;
      this.rm_enable = s8(this.rm_enable) >> 1;
      this._doModeWrite();
      this.rm_select++;
      if (this.rm_select > RM_TC) this.rm_select = RM_TC + 1;
      if (this.cycles === 11 && (this.rm_enable & 0x80) === 0x80) this.rm_select = RM_BD0;

      this._preparePatch1();
      this._channel();
      this._phaseGenerate();
      this._operator();
      this._phaseCalcIncrement();
      this._envelopeOutput();
      this._envelopeKSLTL();
      this._envelopeGenerate();
      this._doLFO();
      this._doRhythm();
      this._preparePatch2();
      this._doRegWrite();
      this._doIO();

      this.cycles = (this.cycles + 1) % 18;

      if (++this.sampleCycles >= CYCLES_PER_SAMPLE) {
        this.sampleCycles = 0;
        // 打楽器のピークホールド更新(1サンプルごとで十分。減衰は最短でも数千サンプル続く)
        for (let i = 0; i < 5; i++) {
          const lv = this.eg_level[RHYTHM_SLOT[i]];
          if (lv < this._rhythmPeak[i]) this._rhythmPeak[i] = lv;
        }
        // 実チップの時分割DACは無音時も基準レベル(OPLL_Channelのsign)を出し続けるため
        // 出力にDC成分が乗る。実機ではAC結合で落ちるぶんなので1次ハイパスで除去する。
        // カットオフ約5Hz。[[hes-dda-gain-clipping-fix]]の教訓で立ち上がりのオーバー
        // シュートを避けるため十分低く取っている。
        const x = this.sampleAccum;
        if (this.dcPrimed === 0) { this.dcX = x; this.dcPrimed = 1; } // 初回は段差を作らない
        this.dcY = x - this.dcX + DC_BLOCK_R * this.dcY;
        this.dcX = x;
        this.lastSample = this.dcY;
        this.sampleAccum = 0;
      }
    }

    // ────────── 書き込み ──────────
    // アドレス/データは実機同様「別々のタイミング」で入らないと取りこぼす(write_dataが共用の
    // 1バイトラッチのため)。バス経由(nsfBus/kssBus)は元々CPUサイクルが空くので問題ないが、
    // writeReg()のような即時2連書きのために最小間隔を空けるキューを通す。
    // ★キューの単位は「レジスタ書き込み1件(アドレス+データの対)」。エントリ形式は
    // reg | (data << 8)。実チップは2フェーズ(アドレスポート→データポート)だが、
    // **キュー上で対を分割してはいけない**。
    // 以前はアドレスとデータを別エントリにしていたため、「アドレスだけ先に取り出されて
    // パイプラインへ入り、データがまだキューに居るときに溢れて _drainDirect() が走る」と
    // 宙に浮いたアドレスが捨てられ、直後のデータが**アドレス無しのデータ書き込み**として
    // パイプラインに入り、そのレジスタ書き込みが丸ごと消えていた。
    // (Illusion City KSS 1曲目で実測: カスタム音色の $00 が一度も適用されず multi[0] が
    //  0 のままになり、@0 を多用する FM2/FM4 の音色が変わっていた。VGMは書き込み密度が
    //  低くて溢れないため無傷で、同じ曲なのに KSS と VGM で聞こえ方が違う原因だった)
    _pushWrite(reg, data) {
      this.writebuf.push((reg & 0x3f) | ((data & 0xff) << 8));
      // ★clock()を呼ばずに書き込みだけ流し込む経路(無音先読みスキャンの早送り
      // stream-player.js/_resetScan、kss-stream-player.js/_resetScan など)への保険。
      // 実チップ相当のウェイト間隔でしか掃けないキューに数十万件積まれると、
      // shift()がO(n)化して主スレッドごと焼き付く。上限を超えたらパイプラインを
      // 介さずレジスタへ直接反映する(そもそもclock()が無い=時間が進まない経路なので
      // サイクル精度に意味が無く、旧コアの「即時反映」と同じ挙動になる)。
      if (this.writebuf.length - this.writeHead > WRITE_QUEUE_MAX) this._drainDirect();
    }

    /** 溜まった書き込みをパイプラインを介さずレジスタへ直接反映してキューを空にする */
    _drainDirect() {
      for (let i = this.writeHead; i < this.writebuf.length; i++) {
        const w = this.writebuf[i];
        this._applyRegDirect(w & 0x3f, (w >> 8) & 0xff);
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      // 対の途中(アドレスだけ出した状態)なら先頭から出し直す。宙に浮いたアドレスは
      // 次の対が自分のアドレスを出し直すので害が無い。
      this._writePhase = 0;
    }

    /** レジスタ1本を即時反映(_doModeWrite / _doRegWrite と同じデコード) */
    _applyRegDirect(reg, d) {
      reg &= 0x3f; d &= 0xff;
      const p = this.patch;
      if (reg <= 0x07) {
        const slot = reg & 0x01;
        switch (reg) {
          case 0x00: case 0x01:
            p.multi[slot] = d & 0x0f; p.ksr[slot] = (d >> 4) & 1;
            p.et[slot] = (d >> 5) & 1; p.vib[slot] = (d >> 6) & 1; p.am[slot] = (d >> 7) & 1;
            break;
          case 0x02: p.ksl[0] = (d >> 6) & 3; p.tl = d & 0x3f; break;
          case 0x03: p.ksl[1] = (d >> 6) & 3; p.dc = (d >> 4) & 1; p.dm = (d >> 3) & 1; p.fb = d & 7; break;
          case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
          case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        }
        return;
      }
      if (reg === 0x0e) {
        this.rhythm = d & 0x3f;
        if (this.isDs1001) this.rhythm |= 0x20;
        this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
        return;
      }
      if (reg === 0x0f) { this.testmode = d & 0x0f; return; }
      const ch = reg & 0x0f;
      if (ch > 8) return;
      switch (reg & 0xf0) {
        case 0x10: this.fnum[ch] = (this.fnum[ch] & 0x100) | d; break;
        case 0x20:
          this.fnum[ch] = (this.fnum[ch] & 0xff) | ((d & 1) << 8);
          this.block[ch] = (d >> 1) & 7;
          this.kon[ch] = (d >> 4) & 1;
          this.son[ch] = (d >> 5) & 1;
          break;
        case 0x30: this.regVol[ch] = d & 0x0f; this.inst[ch] = (d >> 4) & 0x0f; break;
      }
    }

    // 先頭の1件を実チップと同じ2フェーズ(アドレス→データ)へ展開して流す。
    // _writePhase が対の途中を表すので、キューから取り出すのはデータを出す時だけ。
    _pumpWrites() {
      if (this.writeHead >= this.writebuf.length) return;
      if (this.writeDelay > 0) { this.writeDelay--; return; }
      const w = this.writebuf[this.writeHead];
      if (this._writePhase === 0) {
        this.write_data = w & 0x3f;   // アドレスフェーズ
        this.write_a |= 1;
        this._writePhase = 1;
        this.writeDelay = WRITE_GAP_ADDR;
      } else {
        this.write_data = (w >> 8) & 0xff; // データフェーズ
        this.write_d |= 1;
        this._writePhase = 0;
        this.writeHead++;
        if (this.writeHead > 1024 && this.writeHead * 2 > this.writebuf.length) {
          this.writebuf = this.writebuf.slice(this.writeHead); this.writeHead = 0; // たまに詰める
        }
        this.writeDelay = WRITE_GAP_DATA;
      }
    }

    /** レジスタ番号を直接指定して書く(VGM / テスト用) */
    writeReg(reg, data) {
      reg &= 0x3f; data &= 0xff;
      this.regShadow[reg] = data;
      this._addrLatch = reg;
      this._pushWrite(reg, data);
    }

    /** VRC7のNSFバス: $9010=アドレス, $9030=データ */
    writeRegister(addr, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (addr === 0x9010) { this._addrLatch = value & 0x3f; }
      else if (addr === 0x9030) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** FMPACのMSX I/Oポート: 0x7C=アドレス, 0x7D=データ */
    ioWrite(port, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (port === 0x7C) { this._addrLatch = value & 0x3f; }
      else if (port === 0x7D) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** ホストクロック1サイクル。hostPerOpll個で内部1サイクル進む */
    clock() {
      if (++this.hostAccum < this.hostPerOpll) return;
      this.hostAccum = 0;
      this._pumpWrites();
      this._stepOpll();
    }

    /**
     * clock()を回さない経路(regsOnlyキャプチャ等)で溜まった書き込みを反映させる。
     * [[capture-worker-plan]] のym2612Nuked.flushWrites()と同じ用途。
     */
    flushWrites() {
      let guard = 0;
      while (this.writeHead < this.writebuf.length && guard++ < 1000000) this.clock();
      for (let i = 0; i < this.hostPerOpll * CYCLES_PER_SAMPLE * 2; i++) this.clock();
    }

    mixSample() { return this.lastSample * OUTPUT_GAIN; }

    get rhythmMode() { return !this.isDs1001 && !!(this.rhythm & 0x20); }

    // ────────── 鍵盤表示用スナップショット ──────────
    // 実機のレジスタ影から音色パラメータを取り出し、波形は「今のパラメータでの概形」を
    // 再合成する(時分割パイプラインは模擬しない)。ym2612Nuked.js の nukedSynthWave と同方針。
    _patchOf(ch) {
      const instr = this.inst[ch];
      return instr > 0 ? this.patchrom[instr - 1] : this.patch;
    }

    _dumpPatch(ch) {
      const p = this._patchOf(ch);
      return {
        type: 'opll', inst: this.inst[ch],
        mod: { AM: p.am[0], PM: p.vib[0], EG: p.et[0], KR: p.ksr[0], ML: p.multi[0],
               KL: p.ksl[0], TL: p.tl, FB: p.fb, WF: p.dm,
               AR: p.ar[0], DR: p.dr[0], SL: p.sl[0], RR: p.rr[0] },
        car: { AM: p.am[1], PM: p.vib[1], EG: p.et[1], KR: p.ksr[1], ML: p.multi[1],
               KL: p.ksl[1], TL: 0, FB: 0, WF: p.dc,
               AR: p.ar[1], DR: p.dr[1], SL: p.sl[1], RR: p.rr[1] }
      };
    }

    /** 1周期ぶんのFM波形(-1..1, N点)。egは現在値を使う */
    _synthWave(ch, N) {
      const p = this._patchOf(ch);
      const modEg = this.eg_level[SLOT_MOD[ch]] + (p.tl << 1);
      const carEg = this.eg_level[SLOT_CAR[ch]] + (this.regVol[ch] << 3);
      const ratio = PG_MULTI[p.multi[0]] / (PG_MULTI[p.multi[1]] || 1);
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const mp = Math.round((k / N) * ratio * 1024) & 0x3ff;
        const mo = opOut(mp, modEg, p.dm);
        const cp = (Math.round((k / N) * 1024) + (mo >> 0)) & 0x3ff;
        const co = opOut(cp, carEg, p.dc);
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      return wave;
    }

    _melodySnapshot(ch, N) {
      const fnum = this.fnum[ch], block = this.block[ch];
      const carLevel = this.eg_level[SLOT_CAR[ch]];
      const active = !!this.kon[ch] && carLevel < 0x7f;
      return {
        freq: (this.kon[ch] && fnum > 0) ? SAMPLE_RATE * fnum / Math.pow(2, 19 - block) : 0,
        vol: (15 - this.regVol[ch]) / 15,
        rawVol: this.regVol[ch],
        instrument: this.inst[ch],
        active,
        waveData: active ? this._synthWave(ch, N) : new Array(N).fill(0),
        patch: this._dumpPatch(ch)
      };
    }

    // ★2026-08-22: 打楽器はピークホールドで返す。
    // 鍵盤表示はrAF(約16ms間隔)でスナップショットを読むが、チップはオーディオバッファ単位
    // (ScriptProcessorNodeで50〜90ms)にまとめて進むため、瞬時値だけ見ると短い打楽器の
    // 減衰がサンプリングの隙間に丸ごと落ちる。実測: Aleste Gaiden 7曲目のBDは約50msで
    // 減衰しきり(eg_level 16→33→96→127)、鍵盤のBD行が一度も点灯しなかった
    // (SDは減衰が緩いので見えていた)。前回読んだ時点以降の最小レベル(=最大音量)を保持する。
    _rhythmSlotInfo(peakIdx, slotIdx, freq) {
      const now = this.eg_level[slotIdx];
      const level = Math.min(this._rhythmPeak[peakIdx], now);
      this._rhythmPeak[peakIdx] = now; // 次の窓は現在値から測り直す
      return { freq, active: level < 0x7f, vol: (0x7f - level) / 0x7f };
    }

    snapshot() {
      const N = 128;
      if (this.isDs1001) {
        const out = [];
        for (let i = 0; i < 6; i++) out.push(this._melodySnapshot(i, N));
        return out;
      }
      // ★2026-08-22: melody は常に9本、rhythm も常に付けて返す。
      // リズムモードのビット($0E bit5)を「打つ瞬間だけ立てて即降ろす」ドライバが実在し
      // (SMS版After Burnerは毎秒10〜16回トグル)、返す形をビットに追随させると鍵盤の
      // 行構成が激しく入れ替わって読めなくなる。どちらを表示するかは表示側(keyboard.js)が
      // 「一度リズムを見たら以後保持」する単調な運用で決める。
      const rhythmMode = this.rhythmMode;
      const melody = [];
      for (let i = 0; i < 9; i++) melody.push(this._melodySnapshot(i, N));

      const f = (ch) => this.fnum[ch] > 0 ? SAMPLE_RATE * this.fnum[ch] / Math.pow(2, 19 - this.block[ch]) : 0;
      return {
        rhythmMode,
        melody,
        rhythm: {
          bd:  this._rhythmSlotInfo(0, RHYTHM_SLOT[0], f(6)),
          sd:  this._rhythmSlotInfo(1, RHYTHM_SLOT[1], 0),
          tom: this._rhythmSlotInfo(2, RHYTHM_SLOT[2], f(8)),
          cym: this._rhythmSlotInfo(3, RHYTHM_SLOT[3], 0),
          hh:  this._rhythmSlotInfo(4, RHYTHM_SLOT[4], 0)
        }
      };
    }
  }

  // 書き込みキューの最小間隔(内部サイクル)。実チップのウェイト仕様に対応する。
  //  - アドレス書き込み後: write_dataラッチを取り合わないよう数サイクル空ければよい。
  //  - データ書き込み後  : ★18以上必須。FMレジスタ($10/$20/$30系)は _doRegWrite が
  //    「(address&0x0f) == cycles」の1サイクルでしか反映しないため、次のアドレス書き込みが
  //    write_fm_data を落とす前に18サイクル(全cycles値)を一巡させないと書き込みが消える。
  //    実機YM2413のデータ書き込み後ウェイト84マスタサイクル(=21内部サイクル)とも符合する。
  // キュー上限。超えたら直接反映へ切り替える(_pushWrite のコメント参照)
  // ★キュー上限は「実ドライバの通常の書き込みバーストでは絶対に届かない」値にすること。
  // 32では実測でIllusion City(KSS)の通常再生中に80フレームで95回も直接反映が発動し、
  // 実チップのウェイトを踏んだ書き込みタイミングが壊れてFM2の音が変わっていた
  // (直接反映を止めるとVGM経路と完全一致した)。KSSのOPLL書き込みは最大74件/フレーム。
  // 取り出しは writeHead 方式(shift不使用)なので、キューが長くても取り出しコストは一定。
  // ここが効くのは clock() が呼ばれない早送り経路だけで、そこは数万〜数十万件積まれる。
  const WRITE_QUEUE_MAX = 4096;
  const WRITE_GAP_ADDR = 4;
  const WRITE_GAP_DATA = 20;

  // 出力ゲイン。旧コア(emu2413移植)とラウドネスを揃えるための実測較正値。
  // 新コアの生の出力は「18サイクルぶんの時分割DAC出力の総和」。@1/@4/@8/@12/@15
  // を単音で鳴らしてRMSを旧コアと突き合わせ、平均比が1.0になるよう決めた(音色ごとの比は
  // 0.4〜1.2とばらつく。コアが違えばEG/出力段が違うので一致はしない)
  // ([[emu-loudness-balance-and-master-volume]] のフォーマット間バランスを崩さないため)。
  const OUTPUT_GAIN = 1 / 2000;

  // DC遮断フィルタ係数(1 - 2π*5Hz/49716)
  const DC_BLOCK_R = 0.99937;

  // 波形プレビュー用の1オペレータ出力(実機と同じ対数sin→exp経路)
  function opOut(phase10, egLevel, halfWave) {
    let phase = phase10 & 0x3ff;
    const neg = (phase >> 9) & 1;
    if (phase & 0x100) phase ^= 0xff;
    let level = LOGSIN[phase & 0xff] + (Math.min(127, egLevel) << 4);
    if (level >= 4096) level = 4095;
    const out = EXPROM[level & 0xff] >> (level >> 8);
    if (halfWave && neg) return 0;
    return neg ? ~out : out;
  }

  Emu.OPLLNuked = OPLLNuked;
})(window);
