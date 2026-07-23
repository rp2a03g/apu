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
})(window);
