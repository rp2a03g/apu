/*
 * YM2151 (OPM) FM音源エミュレータ (アーケード / X68000 / VGM)
 * MML.Emu.YM2151Audio
 *
 * 4オペレータFM×8ch、8アルゴリズム(OPNと同一配置)、EG(AR/D1R/D2R/D1L/RR、キースケール)、
 * DT1/DT2/MUL、LFO(波形4種: のこぎり/矩形/三角/ノイズ、AMD/PMD、ch別PMS/AMS)、
 * ch8スロットC2のノイズモード、L/R出力(reg 0x20 bit6=L, bit7=R)。
 * タイマ/CSM/CT出力は持たない(VGMのログ再生には不要)。
 *
 * 設計は opllMsx.js(emu2413移植)と同じ「dB単位のログサイン+EG」方式(EGレベル0..1023、
 * 1単位=0.09375dB、TL=7bit×8単位、振幅=2^(-att/64)、オペレータ出力±8192)。
 * EG増分表/レート選択は OPN と共通の一般に知られた値(MAME fm2612 / ym2151 とも同型)。
 *
 * ── OPNとの相違点(実装メモ) ──
 *  - 音程はF-Number+BlockではなくKC(キーコード: オクターブ3bit+音名4bit)+KF(半音の1/64)。
 *    KC=0x4A(O4A)=440Hz(クロック3579545Hz時)。音名コードは4値ごとに1つ飛ぶ
 *    (n-(n>>2)で半音0..11、0=C#)。実周波数はクロックに比例。
 *  - DT2(粗デチューン): 0/+600/+781/+950セント(スロット単位、効果音向け)。
 *  - スロットのレジスタ順(off=ch+8*slot)は M1,M2,C1,C2 = 論理op1,op3,op2,op4
 *    (OPNの+0,+4,+8,+12と同じ交互配置)。キーオン(reg 0x08)のbit3-6も同順。
 *  - LFOは1基でAMD/PMD(7bit)を持ち、ch側PMS/AMSは深度スケール。周波数は
 *    fs*(16+LFRQ下位)*2^(LFRQ上位)/2^26 (MAME ym2151の counter_add/overflow から導出)。
 *  - ノイズ: reg 0x0F bit7=NE、bit0-4=NFRQ(周期32-NFRQサンプル)。ch8のC2(op4)の
 *    サイン出力を±EG振幅の2値に置き換える。
 * サンプルレート = clock/64(3579545Hz → 55930Hz)。clock()はマスタークロックごとに呼び、
 * 内部で64分周して1サンプル計算する(他チップと同じ呼び出し規約)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 8;
  const CYCLES_PER_SAMPLE = 64;
  const NOMINAL_CLOCK = 3579545;           // KC→Hz換算の基準クロック
  const NOMINAL_SR = NOMINAL_CLOCK / CYCLES_PER_SAMPLE; // 55930.39Hz
  const EG_MAX = 1023;
  const SIN_LEN = 1024;
  const SIN_MASK = SIN_LEN - 1;
  const PHASE_BITS = 20;
  const PHASE_MASK = (1 << PHASE_BITS) - 1;
  const PHASE_TO_SIN = PHASE_BITS - 10;

  // ── テーブル ──
  const SIN_ATT = new Uint16Array(SIN_LEN);
  const SIN_SIGN = new Int8Array(SIN_LEN);
  for (let i = 0; i < SIN_LEN; i++) {
    const s = Math.sin((i + 0.5) * 2 * Math.PI / SIN_LEN);
    SIN_SIGN[i] = s < 0 ? -1 : 1;
    const a = Math.abs(s);
    SIN_ATT[i] = a < 1e-6 ? EG_MAX : Math.min(EG_MAX, Math.round(-20 * Math.log10(a) / 0.09375));
  }
  const EXP_LEN = 4096;
  const EXP_TAB = new Float32Array(EXP_LEN);
  for (let i = 0; i < EXP_LEN; i++) EXP_TAB[i] = i >= EG_MAX ? 0 : 8192 * Math.pow(2, -i / 64);

  // DT1表(キーコード0..31、単位=位相増分LSB≒fs/2^20 Hz)。OPNと同型の実測値を流用
  const DT_TAB = [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7],
    [1,1,1,1,2,2,2,2,2,2,2,2,3,3,3,3,4,4,4,4,5,5,6,6,7,8,8,9,10,11,12,13],
    [2,2,2,2,2,3,3,3,4,4,4,5,5,6,6,7,8,8,9,10,11,12,13,14,16,16,16,16,16,16,16,16]
  ];
  // DT2: 0 / +600 / +781 / +950 セント(周波数倍率)
  const DT2_MUL = [1, Math.pow(2, 600 / 1200), Math.pow(2, 781 / 1200), Math.pow(2, 950 / 1200)];
  const MUL_TAB = [1,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30]; // 0→0.5(×2して整数化)
  const SL_TAB = new Uint16Array(16);
  for (let i = 0; i < 16; i++) SL_TAB[i] = i < 15 ? i * 32 : 992;

  // EG増分表(OPN/OPM共通の一般値)
  // ★値は MAME ym2151.cpp の eg_inc と同じ(GPL-2.0+, Copyright Jarek Burczynski, Ernesto Corvi)。THIRD-PARTY-NOTICES.md 参照
  const EG_INC = [
    0,1,0,1,0,1,0,1,  0,1,0,1,1,1,0,1,  0,1,1,1,0,1,1,1,  0,1,1,1,1,1,1,1,
    1,1,1,1,1,1,1,1,  1,1,1,2,1,1,1,2,  1,2,1,2,1,2,1,2,  1,2,2,2,1,2,2,2,
    2,2,2,2,2,2,2,2,  2,2,2,4,2,2,2,4,  2,4,2,4,2,4,2,4,  2,4,4,4,2,4,4,4,
    4,4,4,4,4,4,4,4,  4,4,4,8,4,4,4,8,  4,8,4,8,4,8,4,8,  4,8,8,8,4,8,8,8,
    8,8,8,8,8,8,8,8,  16,16,16,16,16,16,16,16,  0,0,0,0,0,0,0,0
  ];
  const EG_SEL = new Uint8Array(64);
  const EG_SHIFT = new Uint8Array(64);
  for (let r = 0; r < 64; r++) {
    const rn = r >> 2, sub = r & 3;
    if (rn === 0) { EG_SEL[r] = sub < 2 ? 18 : 0; EG_SHIFT[r] = 11; continue; }
    if (rn === 1) { EG_SEL[r] = sub < 2 ? 0 : 2; EG_SHIFT[r] = 10; continue; }
    if (rn <= 11) { EG_SEL[r] = sub; EG_SHIFT[r] = 11 - rn; continue; }
    if (rn <= 14) { EG_SEL[r] = 4 + (rn - 12) * 4 + sub; EG_SHIFT[r] = 0; continue; }
    EG_SEL[r] = 16; EG_SHIFT[r] = 0;
  }

  // KC下位4bitの音名コード → 半音(0=C#..11=C)。4値ごとに重複(3,7,11,15は次と同じ)
  function kcSemitone(n) { return (n & 15) - ((n & 15) >> 2); }
  // KC/KF → 基準クロック時の周波数(Hz)。KC=0x4A(O4 A)=440Hz
  function kcToFreq(kc, kf) {
    const oct = (kc >> 4) & 7;
    const semi = kcSemitone(kc);
    return 440 * Math.pow(2, (oct - 4) + (semi - 8) / 12 + kf / 768);
  }

  const EG_OFF = 0, EG_REL = 1, EG_SUS = 2, EG_DEC = 3, EG_ATT = 4;

  class Slot {
    constructor() { this.reset(); }
    reset() {
      this.dt1 = 0; this.dt2 = 0; this.mul = 2; this.tl = 0; this.ks = 3;
      this.ar = 0; this.d1r = 0; this.d2r = 0; this.rr = 0; this.sl = 0; this.am = false;
      this.state = EG_OFF; this.volume = EG_MAX;
      this.phase = 0; this.inc = 0; this.ksr = 0; this.keyOn = false;
      this.out = 0; this.prev = [0, 0];
    }
    rate(r) { return r === 0 ? 0 : Math.min(63, 2 * r + this.ksr); }
  }

  class Channel {
    constructor(idx) { this.idx = idx; this.slots = [new Slot(), new Slot(), new Slot(), new Slot()]; this.reset(); }
    reset() {
      for (const s of this.slots) s.reset();
      this.kc = 0; this.kf = 0; this.kcode = 0;
      this.fb = 0; this.algo = 0; this.left = false; this.right = false; this.ams = 0; this.pms = 0;
      this.out = 0;
    }
  }

  class YM2151Audio {
    /**
     * @param {number} [clock=3579545] - マスタークロック(サンプルレート=clock/64)
     */
    constructor(clock) {
      this.clockHz = clock || NOMINAL_CLOCK;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      // KC→Hzの基準は3579545Hz固定(位相増分表がクロック非依存)。実周波数=公称×clock/3579545
      this.freqScale = this.clockHz / NOMINAL_CLOCK;
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) this.channels.push(new Channel(i));
      this.mute = new Array(NUM_CH).fill(false);
      this.vol = new Array(NUM_CH).fill(1);
      this._init();
    }
    _init() {
      for (const c of this.channels) c.reset();
      this.regs = new Uint8Array(256);
      this.cyc = 0;
      this.egTimer = 0; this.egCnt = 0;
      // LFO
      this.lfoReset = false; this.lfrq = 0; this.amd = 0; this.pmd = 0; this.lfoWave = 0;
      this.lfoPhase = 0; this.lfoAcc = 0; this.lfoNoise = 0;
      this.lfoAM = 0;   // 0..255(波形生値)
      this.lfoPM = 0;   // -128..127(波形生値)
      // ノイズ(ch8 C2)
      this.noiseEnable = false; this.noiseFreq = 0; this.noiseAcc = 0; this.noiseRng = 0x1FFFF; this.noiseBit = 0;
      this.lastL = 0; this.lastR = 0;
    }
    reset() { this._init(); }

    // ── レジスタ書込み(アドレス空間は1ポート256バイト) ──
    writeReg(reg, val) {
      reg &= 0xFF; val &= 0xFF;
      this.regs[reg] = val;
      if (reg < 0x20) {
        switch (reg) {
          case 0x01: this.lfoReset = !!(val & 2); if (this.lfoReset) { this.lfoPhase = 0; this.lfoAcc = 0; } break;
          case 0x08: { // キーオン/オフ: bit0-2=ch、bit3-6=M1,C1,M2,C2(★論理=接続順。
            // スロットレジスタのM1,M2,C1,C2順とは違う。MAME ym2151 envelope_KONKOFF:
            // v&0x08→M1, v&0x10→C1, v&0x20→M2, v&0x40→C2。OPNのreg 0x28も同じく論理順)。
            // 論理op配列はop1=M1,op2=C1,op3=M2,op4=C2なのでbit順=配列順そのまま。
            // R-Type Leo(M92)はFM6を0x6D(C1だけオフ)で選択的にキーオンするので、
            // 順序を間違えるとM2が鳴らず直列アルゴリズムが素通り=キャリアのサイン波になる。
            const ch = this.channels[val & 7];
            for (let i = 0; i < 4; i++) this._key(ch, ch.slots[i], !!(val & (8 << i)));
            break;
          }
          case 0x0F: this.noiseEnable = !!(val & 0x80); this.noiseFreq = val & 0x1F; break;
          case 0x18: this.lfrq = val; break;
          case 0x19: if (val & 0x80) this.pmd = val & 0x7F; else this.amd = val & 0x7F; break;
          case 0x1B: this.lfoWave = val & 3; break; // bit6-7のCT出力は未実装
        }
        return;
      }
      const c = reg & 7;
      const ch = this.channels[c];
      if (reg < 0x40) {
        switch (reg & 0x38) {
          case 0x20: // RL/FB/CONNECT
            ch.left = !!(val & 0x40); ch.right = !!(val & 0x80);
            ch.fb = (val >> 3) & 7; ch.algo = val & 7;
            break;
          case 0x28: ch.kc = val & 0x7F; ch.kcode = ch.kc >> 2; this._refreshCh(ch); break;
          case 0x30: ch.kf = (val >> 2) & 0x3F; this._refreshCh(ch); break;
          case 0x38: ch.pms = (val >> 4) & 7; ch.ams = val & 3; break;
        }
        return;
      }
      // スロットパラメータ: off = ch + 8*slot(M1,M2,C1,C2) → 論理op index [0,2,1,3]
      const s = ch.slots[[0, 2, 1, 3][(reg >> 3) & 3]];
      switch (reg & 0xE0) {
        case 0x40: s.dt1 = (val >> 4) & 7; s.mul = MUL_TAB[val & 0x0F]; this._refreshCh(ch); break;
        case 0x60: s.tl = (val & 0x7F) << 3; break;
        case 0x80: s.ks = 3 - ((val >> 6) & 3); s.ar = val & 0x1F; this._refreshCh(ch); break;
        case 0xA0: s.am = !!(val & 0x80); s.d1r = val & 0x1F; break;
        case 0xC0: s.dt2 = (val >> 6) & 3; s.d2r = val & 0x1F; this._refreshCh(ch); break;
        case 0xE0: s.sl = SL_TAB[val >> 4]; s.rr = val & 0x0F; break;
      }
    }

    // 位相増分とキースケールレートを再計算
    _refreshCh(ch) {
      const base = kcToFreq(ch.kc, ch.kf) * (1 << PHASE_BITS) / NOMINAL_SR; // 公称クロックの増分
      for (let op = 0; op < 4; op++) {
        const s = ch.slots[op];
        const b = Math.round(base * DT2_MUL[s.dt2]);
        let dt = DT_TAB[s.dt1 & 3][ch.kcode];
        if (s.dt1 & 4) dt = -dt;
        s.inc = Math.max(0, ((b + dt) * s.mul) >> 1); // MUL_TABは×2済み
        s.ksr = ch.kcode >> s.ks;
      }
    }

    _key(ch, s, on) {
      if (on && !s.keyOn) {
        s.keyOn = true;
        s.phase = 0;
        if (s.rate(s.ar) >= 62) { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
        else { s.state = EG_ATT; if (s.volume >= EG_MAX) s.volume = EG_MAX; }
      } else if (!on && s.keyOn) {
        s.keyOn = false;
        if (s.state > EG_REL) s.state = EG_REL;
      }
    }

    // ── EG(3サンプルに1回。OPMはSSG-EG無し) ──
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
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= s.sl) { s.volume = Math.min(s.volume, EG_MAX); s.state = EG_SUS; }
              }
              break;
            }
            case EG_SUS: {
              const r = s.rate(s.d2r);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= EG_MAX) s.volume = EG_MAX;
              }
              break;
            }
            case EG_REL: {
              const r = s.rate(s.rr * 2 + 1);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= EG_MAX) { s.volume = EG_MAX; s.state = EG_OFF; }
              }
              break;
            }
          }
        }
      }
    }

    // ── LFO ──
    // 位相0..255。カウンタ増分 = (16+LFRQ下位)<<(LFRQ上位) /サンプル、位相はカウンタの
    // bit22-29(=1周期2^30カウント)。ymfm opm_registers::clock_noise_and_lfo と同じで、
    // アプリケーションマニュアルの周波数表と一致する(LFRQ=0xFFで最大52.9Hz@3.58MHz)。
    // 1サンプルの位相(0-255)の進み = (16+下位)*2^(上位)/2^22 ステップ。
    // ★当初 /2^18 と誤っており16倍速だった(悪魔城ドラキュラX68000のビブラートが
    //   LFRQ=0xC0で54.6Hz=「ギュイーン」になる報告で発覚。正しくは3.41Hz)。
    _advanceLfo() {
      if (this.lfoReset) { this.lfoPhase = 0; this.lfoAM = this._lfoAmOf(0); this.lfoPM = this._lfoPmOf(0); return; }
      this.lfoAcc += (16 + (this.lfrq & 15)) * Math.pow(2, this.lfrq >> 4) / (1 << 22);
      while (this.lfoAcc >= 1) {
        this.lfoAcc -= 1;
        this.lfoPhase = (this.lfoPhase + 1) & 255;
        if (this.lfoWave === 3) this.lfoNoise = (Math.random() * 256) | 0; // ランダム(LFSR近似)
      }
      this.lfoAM = this._lfoAmOf(this.lfoPhase);
      this.lfoPM = this._lfoPmOf(this.lfoPhase);
    }
    _lfoAmOf(p) { // 0..255(255=減衰最大側)
      switch (this.lfoWave) {
        case 0: return 255 - p;                                  // のこぎり
        case 1: return p < 128 ? 255 : 0;                        // 矩形
        case 2: return p < 128 ? p * 2 : (255 - p) * 2;          // 三角
        default: return this.lfoNoise;                           // ノイズ
      }
    }
    _lfoPmOf(p) { // -128..127
      switch (this.lfoWave) {
        case 0: return p < 128 ? p : p - 256;                    // のこぎり
        case 1: return p < 128 ? 127 : -128;                     // 矩形
        case 2: { const q = (p + 64) & 255; return q < 128 ? q * 2 - 128 : 383 - q * 2; } // 三角
        default: return this.lfoNoise - 128;                     // ノイズ
      }
    }

    // ── ノイズ(ch8 C2) ──
    _advanceNoise() {
      // 周期 = (32-NFRQ) サンプル(NFRQ=31で毎サンプル)。17bit LFSR(MAME ym2151と同型)
      this.noiseAcc += 1 / (32 - this.noiseFreq);
      while (this.noiseAcc >= 1) {
        this.noiseAcc -= 1;
        const j = ((this.noiseRng ^ (this.noiseRng >> 3)) & 1) ^ 1;
        this.noiseRng = ((j << 16) | (this.noiseRng >> 1)) & 0x1FFFF;
        this.noiseBit = this.noiseRng & 1;
      }
    }

    // ── 合成 ──
    _opOut(s, att, modIndex) {
      const idx = (((s.phase >> PHASE_TO_SIN) + modIndex) & SIN_MASK);
      const a = att + SIN_ATT[idx];
      const v = a >= EXP_LEN ? 0 : EXP_TAB[a];
      return SIN_SIGN[idx] * v;
    }
    _egOut(s) { return Math.min(EG_MAX, s.volume + s.tl); }

    _calcChannel(ch) {
      const sl = ch.slots;
      // AM: lfa = (波形生値0..255 × AMD)>>7、AMS(0..3)で 0/×1/×2/×4(EG減衰単位)
      const lfa = (this.lfoAM * this.amd) >> 7;
      const amAtt = ch.ams ? (lfa << (ch.ams - 1)) : 0;
      const att = (s) => { let a = this._egOut(s); if (s.am) a += amAtt; return a; };
      // PM: mod = (波形生値-128..127 × PMD)>>7 をPMSでスケールしKF(1/64半音)単位で加える
      let pmScale = 1;
      if (ch.pms && this.pmd) {
        let mod = (this.lfoPM * this.pmd) >> 7; // -127..126
        mod = ch.pms < 6 ? (mod >> (6 - ch.pms)) : (mod << (ch.pms - 5));
        if (mod) pmScale = Math.pow(2, mod * (100 / 64) / 1200); // KF単位→セント
      }
      for (let i = 0; i < 4; i++) {
        const s = sl[i];
        s.phase = (s.phase + (pmScale === 1 ? s.inc : Math.round(s.inc * pmScale))) & PHASE_MASK;
      }
      const s1 = sl[0];
      const fbIn = ch.fb ? ((s1.prev[0] + s1.prev[1]) >> (10 - ch.fb)) : 0;
      const o1 = this._opOut(s1, att(s1), fbIn);
      s1.prev[0] = s1.prev[1]; s1.prev[1] = o1;
      const m = (x) => x >> 1;
      // ch8(idx7)のC2=op4はノイズモード中はサイン波の代わりに±EG振幅の2値
      const noiseCh = this.noiseEnable && ch.idx === 7;
      const op4 = (mod) => {
        if (!noiseCh) return this._opOut(sl[3], att(sl[3]), m(mod));
        const a = att(sl[3]);
        const v = a >= EXP_LEN ? 0 : EXP_TAB[Math.min(EXP_LEN - 1, a)];
        return this.noiseBit ? v : -v;
      };
      let out;
      switch (ch.algo) {
        case 0: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), m(o2)); out = op4(o3); break; }
        case 1: { const o2 = this._opOut(sl[1], att(sl[1]), 0); const o3 = this._opOut(sl[2], att(sl[2]), m(o1 + o2)); out = op4(o3); break; }
        case 2: { const o2 = this._opOut(sl[1], att(sl[1]), 0); const o3 = this._opOut(sl[2], att(sl[2]), m(o2)); out = op4(o1 + o3); break; }
        case 3: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), 0); out = op4(o2 + o3); break; }
        case 4: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), 0); out = o2 + op4(o3); break; }
        case 5: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), m(o1)); out = o2 + o3 + op4(o1); break; }
        case 6: { const o2 = this._opOut(sl[1], att(sl[1]), m(o1)); const o3 = this._opOut(sl[2], att(sl[2]), 0); out = o2 + o3 + op4(0); break; }
        default: { const o2 = this._opOut(sl[1], att(sl[1]), 0); const o3 = this._opOut(sl[2], att(sl[2]), 0); out = o1 + o2 + o3 + op4(0); break; }
      }
      if (out > 8191) out = 8191; else if (out < -8192) out = -8192;
      ch.out = out;
      return out;
    }

    _calcSample() {
      if (++this.egTimer >= 3) { this.egTimer = 0; this._advanceEg(); }
      this._advanceLfo();
      if (this.noiseEnable) this._advanceNoise();
      let l = 0, r = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const ch = this.channels[i];
        let o = this._calcChannel(ch);
        if (this.mute[i]) o = 0; else o *= this.vol[i];
        if (ch.left) l += o;
        if (ch.right) r += o;
      }
      // 8ch分の合算を±1.0程度へ(YM2612の6ch/(8192*5)と同じ按分感覚)
      this.lastL = l / (8192 * 6);
      this.lastR = r / (8192 * 6);
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }

    mixSample() { return { left: this.lastL, right: this.lastR }; }
  }

  // ── 鍵盤表示用スナップショット ──
  const CARRIER_OPS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];

  // レジスタ影から音色パラメータを取り出す。フィールド構成はOPN(decodeOpnPatch)と互換
  // (DT/ML/TL/KS/AR/DR/SR/SL/RR/AM、SSG-EGは無いのでSE=0)なので type:'opn' とし、
  // 鍵盤の音色表示・vgm2mmlの4op→2op変換(opnToOpllBytes)をそのまま使えるようにする。
  // OPM固有のDT2は ops[].DT2 に追加で持つ(表示はコメント行、変換では無視)。
  Emu.decodeOpmPatch = function (regs, ch) {
    const r = regs;
    const ops = [];
    for (const so of [0, 16, 8, 24]) { // 論理op1..op4(M1,C1,M2,C2) → off=ch+8*slot(M1,M2,C1,C2)
      const o = ch + so;
      ops.push({
        DT: (r[0x40 + o] >> 4) & 7, ML: r[0x40 + o] & 15,
        TL: r[0x60 + o] & 127,
        KS: (r[0x80 + o] >> 6) & 3, AR: r[0x80 + o] & 31,
        AM: (r[0xA0 + o] >> 7) & 1, DR: r[0xA0 + o] & 31,
        DT2: (r[0xC0 + o] >> 6) & 3, SR: r[0xC0 + o] & 31,
        SL: (r[0xE0 + o] >> 4) & 15, RR: r[0xE0 + o] & 15,
        SE: 0
      });
    }
    const b = r[0x20 + ch];
    return { type: 'opn', chip: 'opm', AL: b & 7, FB: (b >> 3) & 7,
      AMS: r[0x38 + ch] & 3, PMS: (r[0x38 + ch] >> 4) & 7,
      L: (b >> 6) & 1, R: (b >> 7) & 1, ops };
  };

  // 音色パラメータが載っているレジスタ(ch内オフセット)。中身が同じなら decodeOpmPatch を
  // 呼び直さず前回のオブジェクトを使い回すための比較に使う(ym2612Nuked.js _patchOf と同じ理屈)
  const OPM_PATCH_REGS = [0x40, 0x60, 0x80, 0xA0, 0xC0, 0xE0];
  function opmPatchOf(chip, i) {
    const cache = chip._patchCache || (chip._patchCache = []);
    let e = cache[i];
    if (!e) e = cache[i] = { bytes: new Uint8Array(OPM_PATCH_REGS.length * 4 + 2), patch: null };
    const b = e.bytes, r = chip.regs;
    let k = 0, same = !!e.patch;
    for (const base of OPM_PATCH_REGS) {
      for (let op = 0; op < 4; op++) { const v = r[base + i + op * 8]; if (b[k] !== v) { b[k] = v; same = false; } k++; }
    }
    for (const base of [0x20, 0x38]) { const v = r[base + i]; if (b[k] !== v) { b[k] = v; same = false; } k++; }
    if (!same) e.patch = Emu.decodeOpmPatch(chip.regs, i);
    return e.patch;
  }

  /**
   * @param {object} [opt] opt.skipWave=true で表示専用の合成波形を作らない。
   *   先読みキャプチャ(regsOnly)はロール構築と変換しか読まないので、毎フレーム
   *   8ch×128点の配列を抱えるのは無駄(ym2612Nuked.js snapshot と同じ扱い)。
   */
  Emu.snapshotYM2151 = function (chip, opt) {
    const N = 128;
    const skipWave = !!(opt && opt.skipWave);
    const out = { channels: [] };
    for (let i = 0; i < NUM_CH; i++) {
      const ch = chip.channels[i];
      // 表示/抽出用の周波数はキャリア(op4)基準: KC/KF×クロック比×DT2×MUL。
      // (OPNスナップショットはMULを含めないが、OPMはKCがほぼ音名なのでキャリアの
      //  MUL/DT2まで含めた実効音程を出す方が実曲の音名と一致する)
      const s4 = ch.slots[3];
      const noiseCh = chip.noiseEnable && i === 7 && ch.algo < 4; // 単一キャリアが丸ごとノイズ
      const freq = (ch.kc > 0 && !noiseCh)
        ? kcToFreq(ch.kc, ch.kf) * chip.freqScale * DT2_MUL[s4.dt2] * (s4.mul / 2)
        : 0;
      let minAtt = EG_MAX;
      let anyOn = false;
      for (const op of CARRIER_OPS[ch.algo]) {
        const s = ch.slots[op];
        if (s.state !== EG_OFF) { anyOn = true; minAtt = Math.min(minAtt, chip._egOut(s)); }
      }
      const vol = anyOn ? Math.max(0, 1 - minAtt / EG_MAX) : 0;
      const keyOn = ch.slots.some(s => s.keyOn);
      let minTl = 1023;
      for (const op of CARRIER_OPS[ch.algo]) minTl = Math.min(minTl, ch.slots[op].tl);
      const tlVol = Math.max(0, 1 - minTl / 1016);
      const active = anyOn && vol > 0.02 && freq > 0;
      // 波形の概形(現在のパラメータからの簡易合成)
      const wave = skipWave ? null : new Array(N).fill(0);
      if (active && !skipWave) {
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
      out.channels.push({ freq, vol, rawVol: Math.round(vol * 15), active, keyOn, tlVol,
        algo: ch.algo, fb: ch.fb, panL: ch.left ? 1 : 0, panR: ch.right ? 1 : 0,
        noise: chip.noiseEnable && i === 7,
        waveData: wave, patch: opmPatchOf(chip, i) });
    }
    return out;
  };

  Emu.YM2151Audio = YM2151Audio;
})(window);
