/*
 * YM2612 (OPN2) FM音源エミュレータ (メガドライブ / VGM 段階4)
 * MML.Emu.YM2612Audio
 *
 * 4オペレータFM×6ch、8アルゴリズム、EG(AR/D1R/D2R/SL/RR、キースケール)、DT/MUL、
 * LFO(AM/PM)、SSG-EG、ch3特殊モード(オペレータ別周波数)、ch6 DAC(0x2A/0x2B)、L/R出力。
 * タイマ/CSMは持たない(VGMのログ再生には不要)。
 *
 * 設計は opllMsx.js(emu2413移植)と同じ「dB単位のログサイン+EG」方式。単位系:
 *   EGレベル 0..1023、1単位 = 0.09375dB(=96dB幅)。TLは7bit×8単位(0.75dB/step)、
 *   SLは3dB(32単位)/step(15=93dB)。振幅 = 2^(-att/64)(64単位=6dB)。
 *   オペレータ出力は±8192(14bit相当)、被変調側は(変調出力>>1)を1024刻みの位相へ加算、
 *   op1のフィードバックは (前2出力の和) >> (10-FB)。位相・EGの進み方(dt表、EG増分表、
 *   キーコード、LFO周波数)は MAME fm2612 / Nemesis の実測に基づく一般に知られた値。
 * サンプルレート = clock/144(MD: 7670453Hz → 53267Hz)。clock() はマスタークロックごとに
 * 呼び、内部で144分周して1サンプル計算する(他チップと同じ呼び出し規約)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 6;
  const CYCLES_PER_SAMPLE = 144;
  const EG_MAX = 1023;        // 最大減衰(無音)
  const SIN_LEN = 1024;
  const SIN_MASK = SIN_LEN - 1;
  const PHASE_BITS = 20;      // 位相カウンタ幅(1周=2^20)
  const PHASE_MASK = (1 << PHASE_BITS) - 1;
  const PHASE_TO_SIN = PHASE_BITS - 10; // 上位10bitがサイン表index

  // ── テーブル ──
  // ログサイン: |sin| の減衰(0.09375dB単位)。0交差付近は最大減衰
  const SIN_ATT = new Uint16Array(SIN_LEN);
  const SIN_SIGN = new Int8Array(SIN_LEN);
  for (let i = 0; i < SIN_LEN; i++) {
    const s = Math.sin((i + 0.5) * 2 * Math.PI / SIN_LEN);
    SIN_SIGN[i] = s < 0 ? -1 : 1;
    const a = Math.abs(s);
    SIN_ATT[i] = a < 1e-6 ? EG_MAX : Math.min(EG_MAX, Math.round(-20 * Math.log10(a) / 0.09375));
  }
  // 減衰→振幅(±8192)。EG(1023)+TL(1016)+AM(126)+SIN(1023) の合計まで引ける長さ
  const EXP_LEN = 4096;
  const EXP_TAB = new Float32Array(EXP_LEN);
  for (let i = 0; i < EXP_LEN; i++) EXP_TAB[i] = i >= EG_MAX ? 0 : 8192 * Math.pow(2, -i / 64);

  // デチューン表(dt_tab: dt=0..3、キーコード0..31)。単位は基本位相増分 (fnum<<block)>>1 のLSB
  // (=fs/2^20 Hz、MD:0.05Hz)。実機の検出値は小さい(A4でDT1≒0.4セント)が、これが実機どおり
  const DT_TAB = [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7],
    [1,1,1,1,2,2,2,2,2,2,2,2,3,3,3,3,4,4,4,4,5,5,6,6,7,8,8,9,10,11,12,13],
    [2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7,8,8,9,10,11,12,13,14,16,16,16,16,16,16,16,16]
  ];
  const DT_SCALE = 1; // dt_tabは基本増分(fnum<<block>>1)のLSB単位そのもの(Nuked-OPN2 pg_detuneと同じ)
  // fnum上位4bit → キーコード下位2bit
  const FKTABLE = [0,0,0,0,0,0,0,1,2,3,3,3,3,3,3,3];
  // MUL: 0→0.5、1..15→n (×2して整数化)
  const MUL_TAB = [1,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30];
  // SL: 0..14 → 3dB刻み、15 → 93dB
  const SL_TAB = new Uint16Array(16);
  for (let i = 0; i < 16; i++) SL_TAB[i] = i < 15 ? i * 32 : 992;

  // EG増分表(MAME fm2612 eg_inc)。行=rate select(0..18)、列=eg_cnt下位3bit
  const EG_INC = [
    0,1,0,1,0,1,0,1,  0,1,0,1,1,1,0,1,  0,1,1,1,0,1,1,1,  0,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,  1,1,1,2,1,1,1,2,  1,2,1,2,1,2,1,2,  1,2,2,2,1,2,2,2,
    2,2,2,2,2,2,2,2,  2,2,2,4,2,2,2,4,  2,4,2,4,2,4,2,4,  2,4,4,4,2,4,4,4,
    4,4,4,4,4,4,4,4,  4,4,4,8,4,4,4,8,  4,8,4,8,4,8,4,8,  4,8,8,8,4,8,8,8,
    8,8,8,8,8,8,8,8,  16,16,16,16,16,16,16,16,  0,0,0,0,0,0,0,0
  ];
  // rate(0..63) → EG_INCの行, シフト量
  const EG_SEL = new Uint8Array(64);
  const EG_SHIFT = new Uint8Array(64);
  // rate = 2*R + ksr (0..63)。rateNum = rate>>2 (0..15)、sub = rate&3。MAME fm2612 eg_rate_select/shift と同じ
  for (let r = 0; r < 64; r++) {
    const rn = r >> 2, sub = r & 3;
    if (rn === 0) { EG_SEL[r] = sub < 2 ? 18 : 0; EG_SHIFT[r] = 11; continue; }
    if (rn === 1) { EG_SEL[r] = sub < 2 ? 0 : 2; EG_SHIFT[r] = 10; continue; }
    if (rn <= 11) { EG_SEL[r] = sub; EG_SHIFT[r] = 11 - rn; continue; }
    if (rn <= 14) { EG_SEL[r] = 4 + (rn - 12) * 4 + sub; EG_SHIFT[r] = 0; continue; }
    EG_SEL[r] = 16; EG_SHIFT[r] = 0;
  }
  // LFO周波数(Hz@53267Hz)と128ステップ
  const LFO_HZ = [3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2];
  const LFO_AMS_SHIFT = [8, 3, 1, 0]; // AMS: 0=なし, 1=1.4dB, 2=5.9dB, 3=11.8dB
  // FMS: 0..7 → ピーク変調(セント)。実機の三角波PMを近似
  const LFO_FMS_CENTS = [0, 3.4, 6.7, 10, 14, 20, 40, 80];

  const EG_OFF = 0, EG_REL = 1, EG_SUS = 2, EG_DEC = 3, EG_ATT = 4;

  class Slot {
    constructor() { this.reset(); }
    reset() {
      this.dt = 0; this.mul = 2; this.tl = 0; this.ks = 0;
      this.ar = 0; this.d1r = 0; this.d2r = 0; this.rr = 0; this.sl = 0; this.am = false; this.ssg = 0;
      this.state = EG_OFF; this.volume = EG_MAX; this.ssgn = 0;
      this.phase = 0; this.inc = 0; this.ksr = 0; this.keyOn = false;
      this.out = 0; this.prev = [0, 0];
    }
    rate(r) { return r === 0 ? 0 : Math.min(63, 2 * r + this.ksr); }
  }

  class Channel {
    constructor(idx) { this.idx = idx; this.slots = [new Slot(), new Slot(), new Slot(), new Slot()]; this.reset(); }
    reset() {
      for (const s of this.slots) s.reset();
      this.fnum = 0; this.block = 0; this.kcode = 0;
      this.fnumLatch = 0; // A4-A6 に先に書かれる上位バイト
      this.fb = 0; this.algo = 0; this.left = true; this.right = true; this.ams = 0; this.fms = 0;
      // ch3特殊モード用(op1,op2,op3の個別周波数。op4はch共通)
      this.opFnum = [0, 0, 0]; this.opBlock = [0, 0, 0]; this.opKcode = [0, 0, 0]; this.opLatch = [0, 0, 0];
      this.out = 0; // 直近サンプルの出力(スナップショット用)
    }
  }

  class YM2612Audio {
    /**
     * @param {number} [clock=7670453] - マスタークロック(サンプルレート=clock/144)
     */
    constructor(clock) {
      this.clockHz = clock || 7670453;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) this.channels.push(new Channel(i));
      this.mute = new Array(7).fill(false); // 0-5=FM ch, 6=DAC
      this.vol = new Array(7).fill(1);
      this._init();
    }
    _init() {
      for (const c of this.channels) c.reset();
      this.regs = [new Uint8Array(256), new Uint8Array(256)];
      this.cyc = 0;
      this.egTimer = 0; this.egCnt = 0;
      this.lfoEnable = false; this.lfoFreq = 0; this.lfoCnt = 0; this.lfoAcc = 0; this.lfoAM = 0; this.lfoPM = 0;
      this.ch3Mode = 0;
      this.dacEnable = false; this.dac = 0;
      this.lastL = 0; this.lastR = 0;
    }
    reset() { this._init(); }

    // ── レジスタ書込み(port 0/1 = ch1-3 / ch4-6) ──
    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      this.regs[port][reg] = val;
      if (port === 0 && reg < 0x30) {
        switch (reg) {
          case 0x22: this.lfoEnable = !!(val & 8); this.lfoFreq = val & 7; if (!this.lfoEnable) { this.lfoCnt = 0; this.lfoAM = 0; this.lfoPM = 0; } break;
          case 0x27: this.ch3Mode = (val >> 6) & 3; break;
          case 0x28: {
            const c = val & 7; if (c === 3 || c === 7) break;
            const ch = this.channels[c < 3 ? c : c - 1];
            // bit4..7 = op1,op2,op3,op4(論理順)
            for (let op = 0; op < 4; op++) this._key(ch, ch.slots[op], !!(val & (0x10 << op)));
            break;
          }
          case 0x2A: this.dac = val; break;
          case 0x2B: this.dacEnable = !!(val & 0x80); break;
        }
        return;
      }
      const c = reg & 3;
      if (c === 3) return;
      const ch = this.channels[port * 3 + c];
      // レジスタ上のスロット順(offset 0,4,8,12) = op1,op3,op2,op4 → 論理op index
      const slotIdx = [0, 2, 1, 3][(reg >> 2) & 3];
      const s = ch.slots[slotIdx];
      switch (reg & 0xF0) {
        case 0x30: s.mul = MUL_TAB[val & 0x0F]; s.dt = (val >> 4) & 7; this._refreshCh(ch); break;
        case 0x40: s.tl = (val & 0x7F) << 3; break;
        case 0x50: s.ks = 3 - ((val >> 6) & 3); s.ar = val & 0x1F; this._refreshCh(ch); break;
        case 0x60: s.am = !!(val & 0x80); s.d1r = val & 0x1F; break;
        case 0x70: s.d2r = val & 0x1F; break;
        case 0x80: s.sl = SL_TAB[val >> 4]; s.rr = val & 0x0F; break;
        case 0x90: s.ssg = val & 0x0F; break;
        case 0xA0:
          switch (reg & 0x0C) {
            case 0x00: // A0-A2: fnum low(ラッチ済み上位と合成)
              ch.fnum = ((ch.fnumLatch & 7) << 8) | val; ch.block = (ch.fnumLatch >> 3) & 7;
              ch.kcode = (ch.block << 2) | FKTABLE[ch.fnum >> 7];
              this._refreshCh(ch); break;
            case 0x04: ch.fnumLatch = val; break; // A4-A6
            case 0x08: { // A8-AA: ch3特殊 (c=0→op3, 1→op1, 2→op2)
              const ch3 = this.channels[2];
              const opi = [2, 0, 1][c];
              ch3.opFnum[opi] = ((ch3.opLatch[opi] & 7) << 8) | val; ch3.opBlock[opi] = (ch3.opLatch[opi] >> 3) & 7;
              ch3.opKcode[opi] = (ch3.opBlock[opi] << 2) | FKTABLE[ch3.opFnum[opi] >> 7];
              this._refreshCh(ch3); break;
            }
            case 0x0C: { const ch3 = this.channels[2]; ch3.opLatch[[2, 0, 1][c]] = val; break; } // AC-AE
          }
          break;
        case 0xB0:
          if (reg & 4) { ch.left = !!(val & 0x80); ch.right = !!(val & 0x40); ch.ams = (val >> 4) & 3; ch.fms = val & 7; }
          else { ch.fb = (val >> 3) & 7; ch.algo = val & 7; }
          break;
      }
    }

    // 位相増分とキースケールレートを再計算
    _refreshCh(ch) {
      const special = ch.idx === 2 && this.ch3Mode !== 0;
      for (let op = 0; op < 4; op++) {
        const s = ch.slots[op];
        let fnum = ch.fnum, block = ch.block, kcode = ch.kcode;
        if (special && op < 3) { fnum = ch.opFnum[op]; block = ch.opBlock[op]; kcode = ch.opKcode[op]; }
        s.kcodeCache = kcode; s.fnumCache = fnum; s.blockCache = block;
        const base = (fnum << block) >> 1; // fnum * 2^(block-1)
        let dt = DT_TAB[s.dt & 3][kcode] * DT_SCALE;
        if (s.dt & 4) dt = -dt;
        s.inc = Math.max(0, ((base + dt) * s.mul) >> 1); // MUL_TABは×2済み
        s.ksr = kcode >> s.ks;
      }
    }

    _key(ch, s, on) {
      if (on && !s.keyOn) {
        s.keyOn = true;
        s.phase = 0; s.ssgn = 0;
        // アタック: レートが十分速ければ即最大レベル
        if (s.rate(s.ar) >= 62) { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
        else { s.state = EG_ATT; if (s.volume >= EG_MAX) s.volume = EG_MAX; }
      } else if (!on && s.keyOn) {
        s.keyOn = false;
        if (s.state > EG_REL) {
          s.state = EG_REL;
          // SSG-EG反転中にキーオフすると実レベルを反転値へ写す
          if ((s.ssg & 8) && (s.ssgn ^ (s.ssg & 4))) s.volume = (0x200 - s.volume) & EG_MAX;
        }
      }
    }

    // ── EG(3サンプルに1回) ──
    _advanceEg() {
      this.egCnt++;
      const cnt = this.egCnt;
      for (const ch of this.channels) {
        for (const s of ch.slots) {
          switch (s.state) {
            case EG_ATT: {
              const r = s.rate(s.ar);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                const inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                s.volume += (~s.volume * inc) >> 4;
                if (s.volume <= 0) { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
              }
              break;
            }
            case EG_DEC: {
              const r = s.rate(s.d1r);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                let inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.ssg & 8) inc <<= 2; // SSG-EG時は4倍速
                s.volume += inc;
                if (s.volume >= s.sl) { s.volume = Math.min(s.volume, EG_MAX); s.state = EG_SUS; }
              }
              break;
            }
            case EG_SUS: {
              const r = s.rate(s.d2r);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                let inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.ssg & 8) inc <<= 2;
                s.volume += inc;
                if (s.volume >= EG_MAX) { s.volume = EG_MAX; if (!(s.ssg & 8)) { /* 保持 */ } }
              }
              break;
            }
            case EG_REL: {
              const r = s.rate(s.rr * 2 + 1); // RRは4bit×2+1
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                let inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.ssg & 8) inc <<= 2;
                s.volume += inc;
                if (s.volume >= EG_MAX) { s.volume = EG_MAX; s.state = EG_OFF; }
              }
              break;
            }
          }
          // SSG-EG: 減衰が-48dB(0x200)に達したら hold/alternate/repeat
          if ((s.ssg & 8) && s.volume >= 0x200 && s.state > EG_REL) {
            if (s.ssg & 1) { // hold
              if (s.ssg & 2) s.ssgn = 4;
              if (s.state !== EG_ATT && !(s.ssgn ^ (s.ssg & 4))) s.volume = EG_MAX;
            } else { // repeat
              if (s.ssg & 2) s.ssgn ^= 4; else s.phase = 0;
              if (s.state !== EG_ATT) {
                if (s.rate(s.ar) < 62) { s.state = EG_ATT; }
                else { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
              }
            }
          }
        }
      }
    }

    // ── LFO ──
    _advanceLfo() {
      if (!this.lfoEnable) return;
      // 128ステップ/周期
      this.lfoAcc += LFO_HZ[this.lfoFreq] * 128 / this.sampleRate;
      while (this.lfoAcc >= 1) { this.lfoAcc -= 1; this.lfoCnt = (this.lfoCnt + 1) & 127; }
      // AM: 三角波 0..126 (実機: 0x00→0x7E→0x00)
      const pos = this.lfoCnt;
      this.lfoAM = pos < 64 ? pos * 2 : (127 - pos) * 2;
      // PM: 三角波 -1..1 (位相は AM と 1/4 周期ずれるが近似)
      const p = ((pos + 32) & 127);
      this.lfoPM = p < 64 ? (p - 32) / 32 : (96 - p) / 32;
    }

    // ── 合成 ──
    _opOut(s, att, modIndex) {
      // att: EG+TL+AM の合計減衰。modIndex: 変調位相(1024刻み)
      const idx = (((s.phase >> PHASE_TO_SIN) + modIndex) & SIN_MASK);
      const a = att + SIN_ATT[idx];
      const v = a >= EXP_LEN ? 0 : EXP_TAB[a];
      return SIN_SIGN[idx] * v;
    }
    _egOut(s) {
      let v = s.volume;
      if ((s.ssg & 8) && (s.ssgn ^ (s.ssg & 4)) && s.state > EG_REL) v = (0x200 - v) & EG_MAX;
      return Math.min(EG_MAX, v + s.tl);
    }

    _calcChannel(ch) {
      const sl = ch.slots;
      const am = this.lfoAM >> LFO_AMS_SHIFT[ch.ams];
      const att = (s) => { let a = this._egOut(s); if (s.am) a += am; return a; };
      // 位相を進める(PM: FMSによる周波数偏差を増分に掛ける)
      let pmScale = 1;
      if (this.lfoEnable && ch.fms) pmScale = Math.pow(2, LFO_FMS_CENTS[ch.fms] * this.lfoPM / 1200);
      for (let i = 0; i < 4; i++) {
        const s = sl[i];
        s.phase = (s.phase + (pmScale === 1 ? s.inc : Math.round(s.inc * pmScale))) & PHASE_MASK;
      }
      // op1 (フィードバック)
      const s1 = sl[0];
      const fbIn = ch.fb ? ((s1.prev[0] + s1.prev[1]) >> (10 - ch.fb)) : 0;
      const o1 = this._opOut(s1, att(s1), fbIn);
      s1.prev[0] = s1.prev[1]; s1.prev[1] = o1;
      const m = (x) => x >> 1; // 変調入力→位相index
      let out;
      switch (ch.algo) {
        case 0: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), m(o2)); out = this._opOut(sl[3], att(sl[3]), m(o3)); break; }
        case 1: { const o2 = this._opOut(sl[1], att(sl[1]), 0); const o3 = this._opOut(sl[2], att(sl[2]), m(o1 + o2)); out = this._opOut(sl[3], att(sl[3]), m(o3)); break; }
        case 2: { const o2 = this._opOut(sl[1], att(sl[1]), 0); const o3 = this._opOut(sl[2], att(sl[2]), m(o2)); out = this._opOut(sl[3], att(sl[3]), m(o1 + o3)); break; }
        case 3: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), 0); out = this._opOut(sl[3], att(sl[3]), m(o2 + o3)); break; }
        case 4: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), 0); const o4 = this._opOut(sl[3], att(sl[3]), m(o3)); out = o2 + o4; break; }
        case 5: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), m(o1)); const o4 = this._opOut(sl[3], att(sl[3]), m(o1)); out = o2 + o3 + o4; break; }
        case 6: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), 0); const o4 = this._opOut(sl[3], att(sl[3]), 0); out = o2 + o3 + o4; break; }
        default: { const o2 = this._opOut(sl[1], att(sl[1]), 0); const o3 = this._opOut(sl[2], att(sl[2]), 0); const o4 = this._opOut(sl[3], att(sl[3]), 0); out = o1 + o2 + o3 + o4; break; }
      }
      // 実機は14bitに飽和
      if (out > 8191) out = 8191; else if (out < -8192) out = -8192;
      ch.out = out;
      return out;
    }

    _calcSample() {
      // EGは3サンプルに1回
      if (++this.egTimer >= 3) { this.egTimer = 0; this._advanceEg(); }
      this._advanceLfo();
      let l = 0, r = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const ch = this.channels[i];
        let o;
        if (i === 5 && this.dacEnable) { o = (this.dac - 0x80) << 6; ch.out = o; if (this.mute[6]) o = 0; else o *= this.vol[6]; }
        else { o = this._calcChannel(ch); if (this.mute[i]) o = 0; else o *= this.vol[i]; }
        if (ch.left) l += o;
        if (ch.right) r += o;
      }
      // 6ch分の合算を±1.0程度へ(1chフルスケール8192、6ch同時で±1.0を少し超える程度)
      this.lastL = l / (8192 * 5);
      this.lastR = r / (8192 * 5);
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }

    mixSample() { return { left: this.lastL, right: this.lastR }; }
  }

  // ── 鍵盤表示用スナップショット ──
  // 各chの freq(キャリア=op4の周波数、ch3特殊は同様)、vol(キャリアの実EG出力から)、
  // active(キーオン中またはリリース途中で可聴)、algo/fb、waveData(1周期のFM波形)。
  const CARRIER_OPS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];

  // OPN(YM2612/YM2610)のレジスタ影(regs[port][reg]、高速コア/Nukedコアとも同じ配置)から
  // ch(0-5)の音色パラメータを取り出す(鍵盤の大波形表示の下に音色データを出すため)。
  // ops はop1,op2,op3,op4の論理順(レジスタ上のスロット順 +0,+4,+8,+12 は op1,op3,op2,op4)。
  Emu.decodeOpnPatch = function (regs, ch) {
    const port = ch < 3 ? 0 : 1, off = ch % 3;
    const r = regs[port];
    const ops = [];
    for (const so of [0, 8, 4, 12]) { // 論理op1..op4 → レジスタスロットオフセット
      const o = off + so;
      ops.push({
        DT: (r[0x30 + o] >> 4) & 7, ML: r[0x30 + o] & 15,
        TL: r[0x40 + o] & 127,
        KS: (r[0x50 + o] >> 6) & 3, AR: r[0x50 + o] & 31,
        AM: (r[0x60 + o] >> 7) & 1, DR: r[0x60 + o] & 31,
        SR: r[0x70 + o] & 31,
        SL: (r[0x80 + o] >> 4) & 15, RR: r[0x80 + o] & 15,
        SE: r[0x90 + o] & 15
      });
    }
    const b0 = r[0xB0 + off], b4 = r[0xB4 + off];
    return { type: 'opn', AL: b0 & 7, FB: (b0 >> 3) & 7, AMS: (b4 >> 4) & 3, PMS: b4 & 7, L: (b4 >> 7) & 1, R: (b4 >> 6) & 1, ops };
  };

  Emu.snapshotYM2612 = function (chip) {
    if (typeof chip.snapshot === 'function') return chip.snapshot(); // Nuked-OPN2移植版(ym2612Nuked.js)は自前のsnapshot()
    const N = 128;
    const fs = chip.sampleRate;
    const out = { channels: [], dac: null };
    for (let i = 0; i < NUM_CH; i++) {
      const ch = chip.channels[i];
      const s4 = ch.slots[3];
      const fnum = s4.fnumCache || ch.fnum, block = s4.blockCache !== undefined ? s4.blockCache : ch.block;
      const freq = fnum > 0 ? fnum * Math.pow(2, block - 1) * fs / (1 << 20) : 0;
      // キャリアの最小減衰(EG+TL)を音量に
      let minAtt = EG_MAX;
      let anyOn = false;
      for (const op of CARRIER_OPS[ch.algo]) {
        const s = ch.slots[op];
        if (s.state !== EG_OFF) { anyOn = true; minAtt = Math.min(minAtt, chip._egOut(s)); }
      }
      const vol = anyOn ? Math.max(0, 1 - minAtt / EG_MAX) : 0;
      const keyOn = ch.slots.some(s => s.keyOn);
      // tlVol: EGを回さない先読みキャプチャ(規則的な音符抽出/ロール用)向けの、キャリアTLだけから
      // 決まる音量(0-1)。EG依存のvolはclock()が回るライブ表示でのみ意味を持つ
      let minTl = 1023;
      for (const op of CARRIER_OPS[ch.algo]) minTl = Math.min(minTl, ch.slots[op].tl);
      const tlVol = Math.max(0, 1 - minTl / 1016);
      const active = anyOn && vol > 0.02 && freq > 0 && !(i === 5 && chip.dacEnable);
      // 波形: 直近の出力履歴は持たないので、現在のパラメータで1周期ぶん合成せずに
      // 位相を走査したFM波形の概形(op位相を仮想的に0..1周)を作る
      const wave = new Array(N).fill(0);
      if (active) {
        // 簡易: 各opの相対周波数比とアルゴリズムで1周期を合成(EG/TLの現在値を使用)
        const incs = ch.slots.map(s => s.inc || 1);
        const base = incs[3] || 1;
        let mx = 1e-6;
        const attv = ch.slots.map(s => chip._egOut(s));
        for (let k = 0; k < N; k++) {
          const ph = ch.slots.map((s, oi) => Math.round((k / N) * SIN_LEN * (incs[oi] / base)) & SIN_MASK);
          const op = (oi, mod) => { const idx = (ph[oi] + mod) & SIN_MASK; const a = attv[oi] + SIN_ATT[idx]; return SIN_SIGN[idx] * (a >= EXP_LEN ? 0 : EXP_TAB[a]); };
          const o1 = op(0, 0);
          let v;
          switch (ch.algo) {
            case 0: v = op(3, op(2, op(1, o1 >> 1) >> 1) >> 1); break;
            case 1: v = op(3, op(2, (o1 + op(1, 0)) >> 1) >> 1); break;
            case 2: v = op(3, (o1 + op(2, op(1, 0) >> 1)) >> 1); break;
            case 3: v = op(3, (op(1, o1 >> 1) + op(2, 0)) >> 1); break;
            case 4: v = op(1, o1 >> 1) + op(3, op(2, 0) >> 1); break;
            case 5: v = op(1, o1 >> 1) + op(2, o1 >> 1) + op(3, o1 >> 1); break;
            case 6: v = op(1, o1 >> 1) + op(2, 0) + op(3, 0); break;
            default: v = o1 + op(1, 0) + op(2, 0) + op(3, 0);
          }
          wave[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
        }
        for (let k = 0; k < N; k++) wave[k] /= mx;
      }
      out.channels.push({ freq, vol, rawVol: Math.round(vol * 15), active, keyOn, tlVol, algo: ch.algo, fb: ch.fb, panL: ch.left ? 1 : 0, panR: ch.right ? 1 : 0, waveData: wave, patch: Emu.decodeOpnPatch(chip.regs, i) });
    }
    out.dac = { enabled: chip.dacEnable, level: chip.dac, active: chip.dacEnable, vol: chip.dacEnable ? Math.min(1, Math.abs(chip.dac - 0x80) / 64) : 0 };
    return out;
  };

  Emu.YM2612Audio = YM2612Audio;
})(window);
