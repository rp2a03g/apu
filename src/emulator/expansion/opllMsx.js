/*
 * FMPAC(MSX-MUSIC) 拡張音源エミュレータ (OPLL / YM2413)
 * MML.Emu.OPLLAudio
 *
 * ★2026-08-22: 既定の再生コアは opllNuked.js (Nuked-OPLL移植) に移行した。このファイルの
 * 実装は MML.Emu.OPLL_CORE = 'emu2413' を指定したときのA/B比較用として残してある。
 *
 * src/emulator/expansion/vrc7.js のOPLLコア(Mitsutaka Okazaki emu2413移植)をそのまま
 * 流用し、バス面のみMSX実機のFMPAC I/Oポート(0x7C=アドレス, 0x7D=データ)に置き換えている。
 * VRC7とFMPACはハードウェア的に同一のYM2413(OPLL)であるため、DSPコアは変更していない。
 * 出力49716Hz。clock()はOPLLマスタクロック(=MSXでは3.579545MHz、Z80と同一)基準で
 * 呼ばれるため分周は72(3579545/72=49716)。★VRC7(vrc7.js)はNES CPUクロック1.79MHz
 * =マスタの半分を渡される設計なので分周36。両者で定数が違うのは正しい。
 *
 * ノイズ合成(short_noise)アルゴリズムは digital-sound-antiques/emu2413
 * (MIT License, Copyright (c) 2001-2019 Mitsutaka Okazaki) の emu2413.c を参照して移植。
 * 音色ROM(メロディ15音色・リズム3音色)は nukeykt/Nuked-OPLL (GPLv2) の patch_ym2413
 * = YM2413実チップの die shot 読み出し値。本リポジトリもGPLv2。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // FMPAC(YM2413)は9メロディチャンネル。リズムモード時はch6-8が
  // BD(ch6両slot)/HH+SD(ch7 mod+car)/TOM+CYM(ch8 mod+car)に化ける。
  // VRC7(6ch専用・リズムモード無し)から移植したコアをここで9ch+リズム対応に拡張している。
  const NUM_CH = 9;
  // ミュート/音量の添字: 0-8=メロディch, 9-13=リズム(BD,SD,TOM,CYM,HH)。
  // SDとHH(TOMとCYM)は実機では同じchだが鍵盤には別行で出るため、実ch単位の添字だと
  // getMuteConfig()の書き込み順で片方が無視される(opllNuked.js RHYTHM_CH のコメント参照)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14;
  const CYCLES_PER_SAMPLE = 72; // ★2026-08-22: 36は誤り(1オクターブ高かった)。ファイル冒頭コメント参照
  const SAMPLE_RATE = 49716;

  const PG_BITS = 10, PG_WIDTH = 1 << PG_BITS; // emu2413本家に合わせて9→10bit化
  const DP_BITS = 19, DP_WIDTH = 1 << DP_BITS, DP_BASE_BITS = DP_BITS - PG_BITS;
  const DB_STEP = 0.375, DB_BITS = 7, DB_MUTE = 1 << DB_BITS;
  const EG_STEP = 0.375, EG_BITS = 7;
  const EG2DB = 1;
  const TL2EG = 2;
  const DB2LIN_AMP_BITS = 10, SLOT_AMP_BITS = DB2LIN_AMP_BITS;
  const EG_DP_BITS = 22, EG_DP_WIDTH = 1 << EG_DP_BITS;
  const PM_PG_BITS = 8, PM_PG_WIDTH = 1 << PM_PG_BITS;
  const PM_DP_BITS = 16, PM_DP_WIDTH = 1 << PM_DP_BITS;
  const AM_PG_BITS = 8, AM_PG_WIDTH = 1 << AM_PG_BITS;
  const AM_DP_BITS = 16, AM_DP_WIDTH = 1 << AM_DP_BITS;
  const PM_AMP_BITS = 8, PM_AMP = 1 << PM_AMP_BITS;
  const PM_SPEED = 6.4, PM_DEPTH = 13.75, AM_SPEED = 3.7, AM_DEPTH = 4.8;

  const SETTLE = 0, ATTACK = 1, DECAY = 2, SUSHOLD = 3, SUSTINE = 4, RELEASE = 5, FINISH = 6;

  // 音色ROM(YM2413本来の内蔵15音色)。
  // ★2026-08-22: emu2413本家(2413tone.h)の値から、nukeykt/Nuked-OPLL の patch_ym2413 へ
  // 差し替え。emu2413のROM値は本家Wikiが "Estimated ROM Instruments" と明記している通り
  // YM2413B実機録音からの耳コピ推定だが、Nuked-OPLL のものは decap/die shot
  // (siliconpr0n: digshadow, John McMaster)から読み出したROM内容そのもの。
  // 同じ経緯で vrc7.js の VRC7(DS1001)側テーブルも patch_ds1001 へ差し替え済み。
  // ★2026-08-02(履歴): それ以前はVirtuaNESのvrc7tone.h(=VRC7固有ROM)を「FMPAC/YM2413も
  // 同一ROM」という誤った前提で流用していた。VRC7とYM2413のROMは別物。
  const OPLL_INST = [
    [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // 0: ユーザー音色枠(@0所定値なし)
    [0x71,0x61,0x1e,0x17,0xd0,0x78,0x00,0x17], // 1: Violin
    [0x13,0x41,0x1a,0x0d,0xd8,0xf7,0x23,0x13], // 2: Guitar
    [0x13,0x01,0x99,0x00,0xf2,0xc4,0x11,0x23], // 3: Piano
    [0x31,0x61,0x0e,0x07,0xa8,0x64,0x70,0x27], // 4: Flute
    [0x32,0x21,0x1e,0x06,0xe0,0x76,0x00,0x28], // 5: Clarinet
    [0x31,0x22,0x16,0x05,0xe0,0x71,0x00,0x18], // 6: Oboe
    [0x21,0x61,0x1d,0x07,0x82,0x81,0x10,0x07], // 7: Trumpet
    [0x23,0x21,0x2d,0x14,0xa2,0x72,0x00,0x07], // 8: Organ
    [0x61,0x61,0x1b,0x06,0x64,0x65,0x10,0x17], // 9: Horn
    [0x41,0x61,0x0b,0x18,0x85,0xf7,0x71,0x07], // 10: Synthesizer
    [0x13,0x01,0x83,0x11,0xfa,0xe4,0x10,0x04], // 11: Harpsichord
    [0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12], // 12: Vibraphone
    [0x61,0x50,0x0c,0x05,0xc2,0xf5,0x20,0x42], // 13: Synth Bass
    [0x01,0x01,0x55,0x03,0xc9,0x95,0x03,0x02], // 14: Acoustic Bass
    [0x61,0x41,0x89,0x03,0xf1,0xe4,0x40,0x13]  // 15: Electric Guitar
  ];

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
  const PATCH = OPLL_INST.map(dump2patch);

  // リズム音色。★2026-08-22: メロディ音色と同じく Nuked-OPLL の patch_ym2413 由来の
  // die shot 読み出し値へ差し替え。Nuked側はドラムをmod半分(drum_0..2)とcar半分
  // (drum_3..5)に分けて持つので、$00-$07 の8バイト形式へは対になる2エントリをORして復元
  // (BDの結果 01 01 18 0F DF F8 6A 6D は NESdev Wiki "VRC7 audio" のドラム表とも一致)。
  const RHYTHM_PATCH_BD  = dump2patch([0x01, 0x01, 0x18, 0x0f, 0xdf, 0xf8, 0x6a, 0x6d]);
  const RHYTHM_PATCH_HHSD = dump2patch([0x01, 0x01, 0x00, 0x00, 0xc8, 0xd8, 0xa7, 0x48]);
  const RHYTHM_PATCH_TOMCYM = dump2patch([0x05, 0x01, 0x00, 0x00, 0xf8, 0xaa, 0x59, 0x55]);

  function Min(a, b) { return a < b ? a : b; }

  const AR_ADJUST = new Uint32Array(1 << EG_BITS);
  AR_ADJUST[0] = 1 << EG_BITS;
  for (let i = 1; i < 128; i++)
    AR_ADJUST[i] = ((1 << EG_BITS) - 1 - (1 << EG_BITS) * Math.log(i) / Math.log(128)) | 0;

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

  const fullsin = new Uint32Array(PG_WIDTH);
  const halfsin = new Uint32Array(PG_WIDTH);
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[i] = lin2db(Math.sin(2.0 * Math.PI * i / PG_WIDTH));
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[PG_WIDTH / 2 - 1 - i] = fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) fullsin[PG_WIDTH / 2 + i] = DB_MUTE + DB_MUTE + fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) halfsin[i] = fullsin[i];
  for (let i = PG_WIDTH / 2; i < PG_WIDTH; i++) halfsin[i] = fullsin[0];
  const WAVEFORM = [fullsin, halfsin];

  const pmtable = new Int32Array(PM_PG_WIDTH);
  for (let i = 0; i < PM_PG_WIDTH; i++)
    pmtable[i] = (PM_AMP * Math.pow(2, PM_DEPTH * Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH) / 1200)) | 0;
  const amtable = new Int32Array(AM_PG_WIDTH);
  for (let i = 0; i < AM_PG_WIDTH; i++)
    amtable[i] = (AM_DEPTH / 2 / DB_STEP * (1.0 + Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH))) | 0;

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

  const rksTable = [];
  for (let f8 = 0; f8 < 2; f8++) {
    const a = []; rksTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Int32Array(2); a.push(b);
      b[0] = block >> 1;
      b[1] = (block << 1) + f8;
    }
  }

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

  const SL_DB = [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,48];
  const SL = new Uint32Array(16);
  for (let i = 0; i < 16; i++) SL[i] = ((((SL_DB[i] / 3.0) * 8) | 0) << (EG_DP_BITS - EG_BITS)) >>> 0;

  const pm_dphase = ((PM_SPEED * PM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;
  const am_dphase = ((AM_SPEED * AM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;

  class Slot {
    constructor(type) {
      this.type = type;
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

  // emu2413本家 calc_slot_car: modOut = 2*(fm>>1) (fmのLSBを切り捨てるだけで倍化はしない)
  function modToCarPhase(fm) { return 2 * (fm >> 1); }

  // emu2413.c の _PD マクロ: リズム位相定数は10bit(PG_BITS=10)テーブル基準の値。
  // 自前のPG_BITSも10なので通常は恒等変換だが、将来PG_BITSを変える場合に備え式のまま残す。
  function PD(phase) {
    return ((PG_BITS < 10 ? phase >> (10 - PG_BITS) : phase << (PG_BITS - 10)) & (PG_WIDTH - 1));
  }

  function rhythmOut(slot, egout, pgout) {
    if (egout >= DB_MUTE - 1) return 0;
    return DB2LIN[slot.sintbl[pgout] + egout];
  }

  class OpllChannel {
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
        // emu2413本家: fm = (output[1]+output[0]) >> (9-FB)。s.feedbackは(output[1]+output[0])>>1で
        // 既に1bitシフト済みのため、ここでのシフト量は(9-FB)-1 = (8-FB)。
        const fm = (s.feedback) >> (8 - s.patch.FB);
        s.output[0] = DB2LIN[s.sintbl[(pgout + fm) & (PG_WIDTH - 1)] + egout];
      } else {
        s.output[0] = DB2LIN[s.sintbl[pgout] + egout];
      }
      // s.feedbackは自己変調(次回calcModulator呼び出し時のfm計算)専用。キャリアへ渡すのは
      // emu2413本家同様、平均化前の生のoutput[0]。
      s.feedback = (s.output[1] + s.output[0]) >> 1;
      return s.output[0];
    }
    calcCarrier(fm, lfo_am, lfo_pm) {
      const s = this.car;
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) return 0;
      return DB2LIN[s.sintbl[(pgout + modToCarPhase(fm)) & (PG_WIDTH - 1)] + egout];
    }
  }

  class OPLLAudio {
    constructor(opts) {
      // ★2026-08-22: 既定ではNuked-OPLLコア(opllNuked.js)へ委譲する。
      // MML.Emu.OPLL_CORE = 'emu2413' を指定するとこの下の旧コア(emu2413 0.6x系移植)に戻る。
      // opts.core === 'legacy' でもこの下の旧コアになる。無音自動送りの先読みスキャンのように
      // 「音が鳴っているかどうかしか見ない」用途では、サイクルアキュレートである必要が無い一方
      // 主スレッドを食うため軽い方を明示的に選ぶ(kss-stream-player.js _scanBuildChips参照)。
      const useNuked = !(opts && opts.core === 'legacy') && Emu.OPLL_CORE !== 'emu2413' && Emu.OPLLNuked;
      if (useNuked) return new Emu.OPLLNuked({ chipType: 'ym2413' });
      this._init(); this.mute = new Array(NUM_MUTE_SLOTS).fill(false); this.vol = new Array(NUM_MUTE_SLOTS).fill(1); }
    _init() {
      this.addr = 0;
      this.reg = new Uint8Array(0x40);
      this.patches = [];
      for (let i = 0; i < 16; i++) this.patches.push({ mod: Object.assign({}, PATCH[i].mod), car: Object.assign({}, PATCH[i].car) });
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) { const c = new OpllChannel(); this.channels.push(c); this._setPatch(i, 0); }
      this.pm_phase = 0; this.am_phase = 0; this.lfo_pm = 0; this.lfo_am = 0;
      this.cyc = 0; this.lastSample = 0;
      this.rhythmMode = false;
      this.noiseLfsr = 1;
    }
    reset() { this._init(); }

    _setPatch(i, num) {
      const c = this.channels[i];
      c.patchNumber = num;
      c.mod.patch = this.patches[num].mod;
      c.car.patch = this.patches[num].car;
    }

    // port: 0x7C=アドレス, 0x7D=データ (FMPAC/MSX-MUSIC)
    ioWrite(port, value) {
      value &= 0xFF;
      if (port === 0x7C) this.addr = value & 0x3F;
      else if (port === 0x7D) this.writeReg(this.addr, value);
    }

    writeReg(reg, data) {
      reg &= 0x3F; data &= 0xFF;
      const cust = this.patches[0];
      if (reg <= 0x07) {
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
      } else if (reg === 0x0E) {
        this._writeRhythmReg(data);
      } else if (reg >= 0x10 && reg <= 0x18) {
        const ch = reg - 0x10, c = this.channels[ch];
        const fnum = data + ((this.reg[0x20 + ch] & 1) << 8);
        c.mod.fnum = c.car.fnum = fnum;
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x20 && reg <= 0x28) {
        const ch = reg - 0x20, c = this.channels[ch];
        const fnum = ((data & 1) << 8) + this.reg[0x10 + ch];
        const block = (data >> 1) & 7;
        c.mod.fnum = c.car.fnum = fnum; c.mod.block = c.car.block = block;
        if ((this.reg[reg] ^ data) & 0x20) { c.car.sustine = (data >> 5) & 1; }
        // リズムモード中のch6-8はキーオン/オフを0x0Eのビットで行うため、ここでは無視する
        // (周波数/ブロックの更新自体はBD/TOM等のピッチに使うので常に行う)。
        if (!(this.rhythmMode && ch >= 6)) {
          const key = (data & 0x10) !== 0;
          if (key) { if (!c.keyStatus) { c.mod.slotOn(); c.car.slotOn(); } c.keyStatus = 1; }
          else { if (c.keyStatus) c.car.slotOff(); c.keyStatus = 0; }
        }
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x30 && reg <= 0x38) {
        // emu2413.c OPLL_writeReg(): リズムモード中のch7/8上位ニブルはHH/TOMの音量(mod側の
        // TLLをTLでなくvolumeから引く、cf. mod.type=1切替はrhythmMode切替時)。
        // 下位ニブルはBD/SD/CYMも含め常にCAR側の音量として通常のTLLパスに乗る。
        const ch = reg - 0x30, c = this.channels[ch];
        if (this.rhythmMode && ch >= 6) {
          if (reg === 0x37 || reg === 0x38) { c.mod.volume = ((data >> 4) & 15) << 2; c.mod.updateTLL(); }
          c.car.volume = (data & 15) << 2;
          c.car.updateTLL();
        } else {
          this._setPatch(ch, (data >> 4) & 15);
          c.car.volume = (data & 15) << 2;
          c.mod.updateAll(); c.car.updateAll();
        }
      }
      this.reg[reg] = data;
    }

    // レジスタ0x0E: bit5=リズムモード有効, bit4-0=BD/SD/TOM/CYM/HHのキーオン
    _writeRhythmReg(data) {
      const old = this.reg[0x0E] || 0;
      const wasRhythm = this.rhythmMode;
      const newRhythm = !!(data & 0x20);
      if (newRhythm && !wasRhythm) {
        // ch6-8を専用リズム音色に切替。HH(ch7.mod)/TOM(ch8.mod)は本来モジュレータだが
        // リズムモードでは独立した音声出力になり、TLLもTL固定でなくvolumeレジスタ由来に
        // なる(emu2413 commit_slot_update: type&1==0以外はvolumeを参照)ためtypeを1にする。
        this.channels[6].mod.patch = RHYTHM_PATCH_BD.mod; this.channels[6].car.patch = RHYTHM_PATCH_BD.car;
        this.channels[7].mod.patch = RHYTHM_PATCH_HHSD.mod; this.channels[7].car.patch = RHYTHM_PATCH_HHSD.car;
        this.channels[8].mod.patch = RHYTHM_PATCH_TOMCYM.mod; this.channels[8].car.patch = RHYTHM_PATCH_TOMCYM.car;
        this.channels[7].mod.type = 1; this.channels[8].mod.type = 1;
        // 0x37/0x38の上位ニブルはレジスタとして常に保持されているため、直前の値を反映する
        this.channels[7].mod.volume = ((this.reg[0x37] >> 4) & 15) << 2;
        this.channels[8].mod.volume = ((this.reg[0x38] >> 4) & 15) << 2;
        for (const ch of [6, 7, 8]) { this.channels[ch].mod.updateAll(); this.channels[ch].car.updateAll(); }
      } else if (!newRhythm && wasRhythm) {
        // 通常モードに戻す: mod側のtypeを戻し、直前の0x36-38値で音色/音量を再設定
        this.channels[7].mod.type = 0; this.channels[8].mod.type = 0;
        for (const ch of [6, 7, 8]) {
          const rv = this.reg[0x30 + ch] || 0;
          this._setPatch(ch, (rv >> 4) & 15);
          this.channels[ch].car.volume = (rv & 15) << 2;
          this.channels[ch].mod.updateAll(); this.channels[ch].car.updateAll();
        }
      }
      this.rhythmMode = newRhythm;
      // slotOn/slotOffはeg_modeを変えるだけでeg_dphaseを再計算しないため、通常チャンネルの
      // キーオン(reg 0x20-0x28ハンドラ)同様にupdateEG()で追従させる必要がある。
      const trig = (bit, slots) => {
        if (!this.rhythmMode) return;
        const on = !!(data & bit), wasOn = !!(old & bit);
        if (on && !wasOn) for (const s of slots) { s.slotOn(); s.updateEG(); }
        else if (!on && wasOn) for (const s of slots) { s.slotOff(); s.updateEG(); }
      };
      trig(0x10, [this.channels[6].mod, this.channels[6].car]); // BD
      trig(0x08, [this.channels[7].car]); // SD
      trig(0x04, [this.channels[8].mod]); // TOM
      trig(0x02, [this.channels[8].car]); // CYM
      trig(0x01, [this.channels[7].mod]); // HH
    }

    _updateAMPM() {
      this.pm_phase = (this.pm_phase + pm_dphase) & (PM_DP_WIDTH - 1);
      this.am_phase = (this.am_phase + am_dphase) & (AM_DP_WIDTH - 1);
      this.lfo_am = amtable[this.am_phase >>> (AM_DP_BITS - AM_PG_BITS)];
      this.lfo_pm = pmtable[this.pm_phase >>> (PM_DP_BITS - PM_PG_BITS)];
    }

    _calc() {
      this._updateAMPM();
      // ノイズLFSR(HH/SD/CYMの疑似ノイズ合成用)を1サンプルにつき1回進める
      if (this.noiseLfsr & 1) this.noiseLfsr ^= 0x800200;
      this.noiseLfsr = (this.noiseLfsr >>> 1) || 1;
      const noiseBit = this.noiseLfsr & 1;

      let inst = 0;
      const lastCh = this.rhythmMode ? 6 : NUM_CH;
      for (let i = 0; i < lastCh; i++) {
        const c = this.channels[i];
        if (c.car.eg_mode === FINISH) continue;
        const fm = c.calcModulator(this.lfo_am, this.lfo_pm);
        const out = c.calcCarrier(fm, this.lfo_am, this.lfo_pm);
        if (!this.mute[i]) inst += out * this.vol[i];
      }
      if (this.rhythmMode) {
        const ch6 = this.channels[6], ch7 = this.channels[7], ch8 = this.channels[8];
        // BD: 通常チャンネルと同じmod→car 2opFM接続(emu2413はcalc_slot_mod/carをch6にも
        // そのまま流用している)。
        if (ch6.car.eg_mode !== FINISH) {
          const fm = ch6.calcModulator(this.lfo_am, this.lfo_pm);
          const out = ch6.calcCarrier(fm, this.lfo_am, this.lfo_pm);
          if (!this.mute[MUTE_BD]) inst += out * this.vol[MUTE_BD];
        }

        // HH/SD/TOM/CYM: 先に位相を進めてからshort_noiseを計算し(emu2413 update_short_noise)、
        // それを使って各スロットの出力サイン位相を選ぶ。音量はEG/TLL経由(rhythmOut内でegout
        // が既にvolumeレジスタ由来のTLLを反映済み)。
        const hh = ch7.mod, sd = ch7.car, tom = ch8.mod, cym = ch8.car;
        const hhPg = hh.calcPhase(this.lfo_pm);
        const sdPg = sd.calcPhase(this.lfo_pm);
        const tomPg = tom.calcPhase(this.lfo_pm);
        const cymPg = cym.calcPhase(this.lfo_pm);
        // emu2413 update_short_noise: BIT位置はPG_BITS基準の相対式のままにしておく
        const h_bit2 = (hhPg >> (PG_BITS - 8)) & 1;
        const h_bit7 = (hhPg >> (PG_BITS - 3)) & 1;
        const h_bit3 = (hhPg >> (PG_BITS - 7)) & 1;
        const c_bit3 = (cymPg >> (PG_BITS - 7)) & 1;
        const c_bit5 = (cymPg >> (PG_BITS - 5)) & 1;
        const shortNoise = (h_bit2 ^ h_bit7) | (h_bit3 ^ c_bit5) | (c_bit3 ^ c_bit5);

        const hhEg = hh.calcEnvelope(this.lfo_am);
        const sdEg = sd.calcEnvelope(this.lfo_am);
        const tomEg = tom.calcEnvelope(this.lfo_am);
        const cymEg = cym.calcEnvelope(this.lfo_am);

        if (tom.eg_mode !== FINISH && !this.mute[MUTE_TOM]) inst += rhythmOut(tom, tomEg, tomPg) * this.vol[MUTE_TOM];
        if (hh.eg_mode !== FINISH && !this.mute[MUTE_HH]) {
          const ph = shortNoise ? (noiseBit ? PD(0x2d0) : PD(0x234)) : (noiseBit ? PD(0x34) : PD(0xd0));
          inst += rhythmOut(hh, hhEg, ph) * this.vol[MUTE_HH];
        }
        if (sd.eg_mode !== FINISH && !this.mute[MUTE_SD]) {
          const sdOwnBit = (sdPg >> (PG_BITS - 2)) & 1;
          const ph = sdOwnBit ? (noiseBit ? PD(0x300) : PD(0x200)) : (noiseBit ? PD(0x0) : PD(0x100));
          inst += rhythmOut(sd, sdEg, ph) * this.vol[MUTE_SD];
        }
        if (cym.eg_mode !== FINISH && !this.mute[MUTE_CYM]) {
          const ph = shortNoise ? PD(0x300) : PD(0x100);
          inst += rhythmOut(cym, cymEg, ph) * this.vol[MUTE_CYM];
        }
      }
      return inst;
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this.lastSample = this._calc();
    }

    mixSample() {
      return (this.lastSample / 4096) * 0.5;
    }
  }

  function melodySnapshot(c, N) {
    const mod = c.mod, car = c.car;
    const freq = (c.keyStatus && car.fnum > 0) ? SAMPLE_RATE * car.fnum / Math.pow(2, 19 - car.block) : 0;
    const active = c.keyStatus && car.eg_mode !== FINISH && car.eg_mode !== SETTLE;
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
    return {
      freq,
      vol: (15 - (c.car.volume >> 2)) / 15,
      rawVol: c.car.volume >> 2,
      instrument: c.patchNumber,
      active,
      waveData: active ? wave : new Array(N).fill(0),
      // patch: 鍵盤の大波形表示の下に音色データ(@OT形式)を出すためのパラメータ
      // (現在選択中の音色のスロット {mod,car}。emu2413のpatch構造体そのまま)
      patch: { type: 'opll', inst: c.patchNumber, mod: mod.patch, car: car.patch }
    };
  }

  function rhythmSlotInfo(slot, keyOn, freq) {
    const active = keyOn && slot.eg_mode !== FINISH;
    return { freq: active ? freq : 0, vol: active ? 1 : 0, active };
  }

  // 通常モード: 9メロディチャンネル分を返す({rhythmMode:false, melody:[9]})。
  // リズムモード: melodyは0-5chの6要素のみ、加えてrhythm{bd,sd,tom,cym,hh}を返す
  // (ch6-8の8スロットが5種の打楽器に化けるため、鍵盤表示側は6melody+5rhythmの
  // 11行として描画する)。
  Emu.snapshotOPLL = function (chip) {
    if (typeof chip.snapshot === 'function') return chip.snapshot(); // Nukedコア
    const N = 128;
    const melodyCount = chip.rhythmMode ? 6 : NUM_CH;
    const melody = [];
    for (let i = 0; i < melodyCount; i++) melody.push(melodySnapshot(chip.channels[i], N));

    if (!chip.rhythmMode) return { rhythmMode: false, melody };

    const ch6 = chip.channels[6], ch7 = chip.channels[7], ch8 = chip.channels[8];
    const bdFreq = ch6.car.fnum > 0 ? SAMPLE_RATE * ch6.car.fnum / Math.pow(2, 19 - ch6.car.block) : 0;
    const tomFreq = ch8.mod.fnum > 0 ? SAMPLE_RATE * ch8.mod.fnum / Math.pow(2, 19 - ch8.mod.block) : 0;
    const rhythm = {
      bd: rhythmSlotInfo(ch6.car, true, bdFreq),
      sd: rhythmSlotInfo(ch7.car, true, 0),
      tom: rhythmSlotInfo(ch8.mod, true, tomFreq),
      cym: rhythmSlotInfo(ch8.car, true, 0),
      hh: rhythmSlotInfo(ch7.mod, true, 0),
    };
    return { rhythmMode: true, melody, rhythm };
  };

  Emu.OPLLAudio = OPLLAudio;
})(window);
