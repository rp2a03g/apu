/*
 * OPL系FM音源エミュレータ — YM3526(OPL) / YM3812(OPL2) / Y8950(MSX-AUDIO) (VGM / KSS)
 * MML.Emu.OPLAudio
 *
 * 2オペレータFM×9ch、またはリズムモード(6メロディ+5打楽器)。EG(AR/DR/SL/RR、EGT=サステイン
 * 保持ビット、KSR)、KSL(キースケールレベル)、固定LFO(AM≈3.7Hz/VIB≈6.1Hz、深度は0xBDの
 * グローバルビット)、フィードバック、接続(CNT: 0=FM直列 1=加算)。モノラル出力。
 *  - YM3812(OPL2)のみ: 波形選択(WS 0-3: サイン/半サイン/絶対値/四半パルス、0x01 bit5で有効化)
 *  - Y8950のみ: ADPCM-B(DELTA-T 1ch)。ym2610.jsの共有クラス(Emu.OpnAdpcm.AdpcmB)を
 *    addrShift=5(YM2608と同じ32バイト単位)で流用し、Y8950レジスタ(0x07-0x12)を
 *    共有クラスのOPNA配置へ写像する。メモリはVGMデータブロック0x88、またはKSS(MSX-AUDIO)の
 *    データレジスタ(0x0F)経由のCPU書込み(REC|MEMDATAモード)で埋まる。
 *
 * 設計は ym2151.js(OPM)と同じ「dB単位のログサイン+EG」方式(EGレベル0..1023、1単位=
 * 0.09375dB、TL=6bit×8単位、振幅=2^(-att/64)、オペレータ出力±8192)。EG増分表/レート選択も
 * 同じOPNファミリ共通表(OPLのレート値は rate=4*R+RKS、EGクロックは毎サンプル=OPNの3倍速。
 * MAME fmopl.cと同じ時間スケール)。
 *
 * ★変調量の尺度(2026-09-07修正): モジュレータ→キャリアは出力>>1(±8192→±4096=サイン表
 *   1024点の4周期ぶん。MAME fmopl/Nuked-OPLLの「12bit出力をそのまま位相へ」と同じ深さ)、
 *   帰還は(直前2出力の和)>>(10-FB)(FB=7で±2048=2周期。Nuked-OPLLの「2出力の平均>>(7-FB)」
 *   =11bit出力で2周期、MAME fmopl の out<<(FB+7)>>16 と同じ)。以前は帰還が >>(9-FB) で
 *   実機の2倍の深さになっており、FB=7の音色(Bubble Bobble FM8等)が実機よりずっと
 *   ノイジーに崩れていた。ym2151.js(OPM)の >>(10-FB) と同じ値に揃えた。
 *
 * ★リズム(HH/SD/CYM)の位相ビット細工とノイズLFSRは、die解析済みの opllNuked.js
 *   (Nuked-OPLL。OPLLのリズム回路はOPL由来で同一)から式を移植:
 *     HH: サイン索引 = rm_bit<<9 | ((rm_bit^noise) ? 0xd0 : 0x34)
 *     SD: hh_bit8<<9 | ((hh_bit8^noise)<<8) / CYM: rm_bit<<9 | 0x100 / TOM,BD: 通常
 *     rm_bit = (hh2^hh7)|(hh3^tc5)|(tc3^tc5)、ノイズ=23bit LFSR(タップ14)
 *   ビブラートの8ステップ表(±f>>7/±f>>8)も同じ(OPLは0xBD bit6=深度で半減)。
 *   KSLも同じ回路(KSLTABLE - (8-block)*8)で、OPL2/OPL3系のビット解釈
 *   {0:off, 1:3dB/oct, 2:1.5dB/oct, 3:6dB/oct} を使う。
 *
 * 音程: F-Number(10bit)+Block。freq = fnum × 2^(block-1) × fs / 2^19、fs = clock/72
 * (3579545Hz → 49716Hz。OPLLと同じ)。A4=440Hz ≒ fnum 577 / block 4。
 *
 * ミュート添字(mute[]/vol[]): 0-8=メロディch、9-13=BD,SD,TOM,CYM,HH(opllNuked.jsの
 * MUTE_*と同じ並び)、14=ADPCM-B(Y8950)。リズムモード中のch7/ch8はスロット単位で
 * SD/HH/TOM/CYMに分離してミュートできる。
 *
 * 外部I/F: writeReg(reg,val) / readStatus()(Y8950: KSSのポート0xC0読出し用) /
 * clock()(マスタークロック毎、/72で1サンプル) / mixSample()(モノラル、数値) /
 * loadRom(romSize,start,data)(Y8950 DELTA-T、VGMデータブロック0x88) /
 * mute[15] / vol[15] / Emu.snapshotOPL(chip)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 9;
  const CYCLES_PER_SAMPLE = 72;
  const EG_MAX = 1023;
  const SIN_LEN = 1024;
  const SIN_MASK = SIN_LEN - 1;
  const PHASE_BITS = 20;
  const PHASE_MASK = (1 << PHASE_BITS) - 1;
  const PHASE_TO_SIN = PHASE_BITS - 10;

  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13, MUTE_ADPCM = 14;
  const NUM_MUTE = 15;

  // ── テーブル(ym2151.jsと同型) ──
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

  const MUL_TAB = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]; // ×2表現(0→0.5、11=10,13=12,14=15,15=15はOPL実機の丸め)
  const SL_TAB = new Uint16Array(16);
  for (let i = 0; i < 16; i++) SL_TAB[i] = i < 15 ? i * 32 : 992; // 3dB/step、15=93dB

  // KSL基礎表(opllNuked.js EG_KSLTABLEと同じ die 由来値)。索引=F-Number上位4bit
  const KSL_TAB = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
  // KSL設定 → 右シフト量(OPL2/OPL3系: 1=3dB/oct, 2=1.5dB/oct, 3=6dB/oct)
  const KSL_SHIFT = [31, 1, 2, 0];

  // EG増分表(OPN/OPM/OPL共通の一般値。ym2151.jsと同一)
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

  // スロットレジスタオフセット(0x00-0x15、グループ8個中6個有効) → (ch, op)
  const SLOT_CH = new Int8Array(32).fill(-1);
  const SLOT_OP = new Int8Array(32);
  for (let s = 0; s < 0x16; s++) {
    const k = s & 7;
    if (k >= 6) continue;
    SLOT_CH[s] = (s >> 3) * 3 + (k % 3);
    SLOT_OP[s] = k < 3 ? 0 : 1;
  }

  const EG_OFF = 0, EG_REL = 1, EG_SUS = 2, EG_DEC = 3, EG_ATT = 4;

  class Slot {
    constructor() { this.reset(); }
    reset() {
      this.am = false; this.vib = false; this.egt = false; this.ksrFlag = false; this.mul = 2;
      this.ksl = 0; this.tl = 0;
      this.ar = 0; this.dr = 0; this.sl = 0; this.rr = 0;
      this.ws = 0;
      this.state = EG_OFF; this.volume = EG_MAX;
      this.phase = 0; this.inc = 0; this.rks = 0; this.kslAtt = 0;
      this.keySrc = 0; // bit0=メロディKON(0xB0 bit5) / bit1=リズム(0xBD)
      this.prev = [0, 0];
    }
    rate(r) { return r === 0 ? 0 : Math.min(63, 4 * r + this.rks); }
  }

  class Channel {
    constructor(idx) { this.idx = idx; this.slots = [new Slot(), new Slot()]; this.reset(); }
    reset() {
      for (const s of this.slots) s.reset();
      this.fnum = 0; this.block = 0; this.kcode = 0; this.fb = 0; this.cnt = 0; this.kon = false;
    }
  }

  // Y8950 ADPCMレジスタ → 共有AdpcmB(OPNA配置)のレジスタ番号
  const Y8950_DT_MAP = { 0x07: 0x00, 0x08: 0x01, 0x09: 0x02, 0x0A: 0x03, 0x0B: 0x04, 0x0C: 0x05, 0x10: 0x09, 0x11: 0x0A, 0x12: 0x0B };
  const Y8950_RAM_SIZE = 256 * 1024; // 仕様上の最大(MSX-AUDIOカートは32KB/256KB)

  class OPLAudio {
    /**
     * @param {number} [clock=3579545] - マスタークロック(サンプルレート=clock/72)
     * @param {{type?: 'ym3526'|'ym3812'|'y8950'}} [opts]
     */
    constructor(clock, opts) {
      this.clockHz = clock || 3579545;
      this.sampleRate = this.clockHz / CYCLES_PER_SAMPLE;
      this.type = (opts && opts.type) || 'ym3812';
      this.hasWave = this.type === 'ym3812';
      this.hasAdpcm = this.type === 'y8950';
      this.mute = new Array(NUM_MUTE).fill(false);
      this.vol = new Array(NUM_MUTE).fill(1);
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) this.channels.push(new Channel(i));
      if (this.hasAdpcm) {
        this.romB = null; // DELTA-Tメモリ(VGM: ROMブロック / KSS: CPU書込みRAM)
        this._pitchCache = new Map();
        this.adpcmB = new Emu.OpnAdpcm.AdpcmB(this, { addrShift: 5, forceExternal: false });
        this._dtWriteAddr = 0;
      }
      this._init();
    }
    _init() {
      for (const c of this.channels) c.reset();
      this.regs = new Uint8Array(256);
      this.cyc = 0;
      this.egCnt = 0;
      this.wse = false;       // 0x01 bit5(OPL2波形選択有効)
      this.nts = false;       // 0x08 bit6(キーボードスプリット)
      this.rhythm = 0;        // 0xBD生値(bit5=リズムモード, bit4-0=BD,SD,TOM,TC,HH)
      this.amDeep = false; this.vibDeep = false;
      this.lfoCnt = 0;        // サンプルカウンタ(vib=>>10で8ステップ、am=>>6で210ステップ三角)
      this.amStep = 0; this.amDir = 0; this.amVal = 0;
      this.noise = 1;         // 23bit LFSR
      this.adpcmOut = 0;
      this.last = 0;
      this._latch = 0;
      if (this.hasAdpcm) { this.adpcmB.reset(); this._dtWriteAddr = 0; }
    }
    reset() { this._init(); }

    /** Y8950 DELTA-Tメモリ(VGMデータブロック0x88) */
    loadRom(romSize, start, data) {
      if (!this.hasAdpcm) return;
      let rom = this.romB;
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this.romB = n; }
      rom.set(data, start);
      if (this._pitchCache) this._pitchCache.clear();
    }

    /** ステータス読出し(Y8950/KSSのポート0xC0)。BUF_RDY(bit3)常時セット、EOS(bit4)=再生終了 */
    readStatus() {
      if (!this.hasAdpcm) return 0x06; // OPL: タイマフラグ無し(未実装)、bit1-2は常に1を返す実装が多い
      const eos = this.adpcmB.seq > 0 && !this.adpcmB.playing;
      return 0x08 | (eos ? 0x10 : 0);
    }

    // ── KSS(MSX-AUDIO)用のI/Oポートインターフェース(kssBus.js chips.opl) ──
    /** port 0xC0=アドレスラッチ / 0xC1=データ */
    ioWrite(port, value) {
      if ((port & 1) === 0) this._latch = value & 0xFF;
      else this.writeReg(this._latch || 0, value);
    }
    /** データポート読出し(レジスタ影を返す。ADPCMメモリ読出しモードは未実装) */
    readData() { return this.regs[this._latch || 0]; }

    writeReg(reg, val) {
      reg &= 0xFF; val &= 0xFF;
      this.regs[reg] = val;
      if (reg < 0x20) {
        if (reg === 0x01) { this.wse = this.hasWave && !!(val & 0x20); return; }
        if (reg === 0x08) { this.nts = !!(val & 0x40); return; } // CSMは未実装(実曲で未使用)
        if (this.hasAdpcm) {
          if (reg === 0x0F) { this._dtWriteData(val); return; }
          const m = Y8950_DT_MAP[reg];
          if (m !== undefined) {
            // 0x08(control2)はY8950にパンが無いので両ch ONを強制(共有クラスのビット位置合わせ)
            if (m === 0x01) val = (val & 0x3F) | 0xC0;
            if (m === 0x00) {
              // REC|MEMDATA=CPU書込みモード: 再生を止めて書込みポインタを開始アドレスへ
              if ((val & 0x60) === 0x60) {
                this.adpcmB.regs[0x00] = val;
                this.adpcmB.playing = false;
                this._dtWriteAddr = (this.adpcmB.regs[0x02] | (this.adpcmB.regs[0x03] << 8)) << 5;
                return;
              }
            }
            this.adpcmB.write(m, val);
            return;
          }
          if (reg <= 0x19) return; // プリスケール/DAC/IOポートは未実装
        }
        return;
      }
      if (reg === 0xBD) {
        const prev = this.rhythm;
        this.rhythm = val;
        this.amDeep = !!(val & 0x80); this.vibDeep = !!(val & 0x40);
        this._rhythmKeys(prev, val);
        return;
      }
      if (reg >= 0xA0 && reg <= 0xA8) { const c = this.channels[reg - 0xA0]; c.fnum = (c.fnum & 0x300) | val; this._refreshCh(c); return; }
      if (reg >= 0xB0 && reg <= 0xB8) {
        const c = this.channels[reg - 0xB0];
        c.fnum = (c.fnum & 0xFF) | ((val & 3) << 8);
        c.block = (val >> 2) & 7;
        this._refreshCh(c);
        const on = !!(val & 0x20);
        if (on !== c.kon) {
          c.kon = on;
          this._key(c.slots[0], 1, on);
          this._key(c.slots[1], 1, on);
        }
        return;
      }
      if (reg >= 0xC0 && reg <= 0xC8) { const c = this.channels[reg - 0xC0]; c.fb = (val >> 1) & 7; c.cnt = val & 1; return; }
      const si = reg & 0x1F;
      const ch = SLOT_CH[si];
      if (ch < 0) return;
      const s = this.channels[ch].slots[SLOT_OP[si]];
      switch (reg & 0xE0) {
        case 0x20:
          s.am = !!(val & 0x80); s.vib = !!(val & 0x40); s.egt = !!(val & 0x20); s.ksrFlag = !!(val & 0x10);
          s.mul = MUL_TAB[val & 0x0F];
          this._refreshCh(this.channels[ch]);
          break;
        case 0x40: s.ksl = (val >> 6) & 3; s.tl = (val & 0x3F) << 3; this._refreshCh(this.channels[ch]); break;
        case 0x60: s.ar = (val >> 4) & 15; s.dr = val & 15; break;
        case 0x80: s.sl = SL_TAB[(val >> 4) & 15]; s.rr = val & 15; break;
        case 0xE0: if (this.hasWave) s.ws = val & 3; break;
      }
    }

    // 位相増分・キースケールレート・KSL減衰を再計算
    _refreshCh(c) {
      c.kcode = (c.block << 1) | (this.nts ? (c.fnum >> 8) & 1 : (c.fnum >> 9) & 1);
      const kslBase = Math.max(0, KSL_TAB[c.fnum >> 6] - ((8 - c.block) << 3)); // 0..64(0.375dB×2単位)
      for (const s of c.slots) {
        s.rks = s.ksrFlag ? c.kcode : (c.kcode >> 2);
        // (kslBase<<1)>>shift は0.375dB単位 → 家内単位(0.09375dB)へ×4
        s.kslAtt = s.ksl ? (((kslBase << 1) >> KSL_SHIFT[s.ksl]) << 2) : 0;
        // incはビブラート適用込みで毎サンプル計算する(_slotInc)ので、素の値だけ持つ
      }
    }

    // ビブラート込みの位相増分。f2 = fnum<<1 の領域で8ステップ表(opllNukedと同じ)を適用
    _slotInc(c, s) {
      let f2 = c.fnum << 1;
      if (s.vib) {
        const step = (this.lfoCnt >> 10) & 7;
        const d = this.vibDeep ? 0 : 1; // 浅い時は半分
        switch (step) {
          case 1: case 3: f2 += f2 >> (8 + d); break;
          case 2: f2 += f2 >> (7 + d); break;
          case 5: case 7: f2 -= f2 >> (8 + d); break;
          case 6: f2 -= f2 >> (7 + d); break;
        }
      }
      return ((((f2 << c.block) >> 1) * s.mul) >> 1) & PHASE_MASK;
    }

    // キーオン/オフ(src: 1=メロディKON, 2=リズム)
    _key(s, src, on) {
      const before = s.keySrc;
      if (on) s.keySrc |= src; else s.keySrc &= ~src;
      if (before === 0 && s.keySrc) {
        s.phase = 0;
        if (s.rate(s.ar) >= 62) { s.volume = 0; s.state = (s.sl === 0) ? EG_SUS : EG_DEC; }
        else { s.state = EG_ATT; }
      } else if (before && s.keySrc === 0) {
        if (s.state > EG_REL) s.state = EG_REL;
      }
    }

    // 0xBDのリズムキービット変化を各スロットへ(BD=ch6両op、HH=ch7 mod、SD=ch7 car、
    // TOM=ch8 mod、CYM(TC)=ch8 car)
    _rhythmKeys(prev, val) {
      const en = !!(val & 0x20);
      const key = (bit, slots) => {
        const on = en && !!(val & bit);
        for (const s of slots) this._key(s, 2, on);
      };
      key(0x10, [this.channels[6].slots[0], this.channels[6].slots[1]]); // BD
      key(0x01, [this.channels[7].slots[0]]);                            // HH
      key(0x08, [this.channels[7].slots[1]]);                            // SD
      key(0x04, [this.channels[8].slots[0]]);                            // TOM
      key(0x02, [this.channels[8].slots[1]]);                            // CYM
    }

    // Y8950: データレジスタ(0x0F)へのCPU書込み(REC|MEMDATAモードでメモリへ格納)
    _dtWriteData(v) {
      if ((this.adpcmB.regs[0x00] & 0x60) !== 0x60) return;
      if (!this.romB || !(this.romB instanceof Uint8Array) || this.romB.length < Y8950_RAM_SIZE) {
        const n = new Uint8Array(Y8950_RAM_SIZE);
        if (this.romB) n.set(this.romB.subarray(0, Math.min(this.romB.length, n.length)), 0);
        this.romB = n;
      }
      this.romB[this._dtWriteAddr & (Y8950_RAM_SIZE - 1)] = v;
      this._dtWriteAddr++;
      if (this._pitchCache) this._pitchCache.clear();
    }

    // ── EG(毎サンプル。OPLのEGクロックはfs) ──
    _advanceEg() {
      const cnt = ++this.egCnt;
      for (const c of this.channels) {
        for (const s of c.slots) {
          switch (s.state) {
            case EG_ATT: {
              const r = s.rate(s.ar);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                const inc = EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                s.volume += (~s.volume * inc) >> 3;
                if (s.volume <= 0) { s.volume = 0; s.state = (s.sl === 0 && s.egt) ? EG_SUS : EG_DEC; }
              }
              break;
            }
            case EG_DEC: {
              const r = s.rate(s.dr);
              const sh = EG_SHIFT[r];
              if ((cnt & ((1 << sh) - 1)) === 0) {
                s.volume += EG_INC[EG_SEL[r] * 8 + ((cnt >> sh) & 7)];
                if (s.volume >= s.sl) {
                  s.volume = Math.min(s.volume, EG_MAX);
                  // EGT=1: SLで保持(キーオフでEG_RELへ) / EGT=0: SL以降もRRレートで減衰(打楽器型。
                  // EG_RELはキーオン状態と無関係に進むのでそのまま流用できる)
                  s.state = s.egt ? EG_SUS : EG_REL;
                }
              }
              break;
            }
            case EG_SUS:
              break; // EGT=1はキーオフまで保持
            case EG_REL: {
              const r = s.rate(s.rr);
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

    // ── LFO(AM: 210ステップ三角×64サンプル≈3.7Hz / VIB: 8ステップ×1024サンプル≈6.1Hz) ──
    _advanceLfo() {
      this.lfoCnt = (this.lfoCnt + 1) & 0xFFFF;
      if ((this.lfoCnt & 63) === 0) {
        // 三角波 0..26(0.1875dB単位、MAME fmopl同様)を0.5ずつ上下(105ステップ×2)
        if (this.amDir === 0) { if (++this.amStep >= 105) this.amDir = 1; }
        else { if (--this.amStep <= 0) this.amDir = 0; }
        this.amVal = (this.amStep * 26 / 105) | 0;
      }
      // ノイズLFSR(23bit、タップ14。opllNuked/実チップと同型)。毎サンプル1シフト
      let nbit = (this.noise ^ (this.noise >>> 14)) & 1;
      nbit |= this.noise === 0 ? 1 : 0;
      this.noise = ((nbit << 22) | (this.noise >>> 1)) >>> 0;
    }
    _amAtt() { // 家内単位(0.09375dB)
      const v = this.amDeep ? this.amVal : (this.amVal >> 2);
      return v << 1; // 0.1875dB → ×2
    }

    // ── オペレータ出力(波形選択込み) ──
    _opOut(s, att, modIndex) {
      const idx = ((s.phase >> PHASE_TO_SIN) + modIndex) & SIN_MASK;
      return this._wave(s.ws, idx, att);
    }
    _wave(ws, idx, att) {
      if (!this.wse || ws === 0) {
        const a = att + SIN_ATT[idx];
        return a >= EXP_LEN ? 0 : SIN_SIGN[idx] * EXP_TAB[a];
      }
      switch (ws) {
        case 1: { // 半サイン(後半無音)
          if (idx & 512) return 0;
          const a = att + SIN_ATT[idx];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
        case 2: { // 絶対値サイン
          const a = att + SIN_ATT[idx & 511];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
        default: { // 四半パルス(各半周期の前半のみ)
          if (idx & 256) return 0;
          const a = att + SIN_ATT[idx & 255];
          return a >= EXP_LEN ? 0 : EXP_TAB[a];
        }
      }
    }
    _egOut(s) { return Math.min(EG_MAX, s.volume + s.tl + s.kslAtt + (s.am ? this._amAtt() : 0)); }

    // リズム用: スロットの位相からサイン索引(HH/SD/CYMは実機の位相ビット細工)
    _rhythmIndex(kind, hhPhase, tcPhase) {
      const hh2 = (hhPhase >> (2 + PHASE_TO_SIN)) & 1, hh3 = (hhPhase >> (3 + PHASE_TO_SIN)) & 1;
      const hh7 = (hhPhase >> (7 + PHASE_TO_SIN)) & 1, hh8 = (hhPhase >> (8 + PHASE_TO_SIN)) & 1;
      const tc3 = (tcPhase >> (3 + PHASE_TO_SIN)) & 1, tc5 = (tcPhase >> (5 + PHASE_TO_SIN)) & 1;
      const rmBit = (hh2 ^ hh7) | (hh3 ^ tc5) | (tc3 ^ tc5);
      const nz = this.noise & 1;
      if (kind === 'hh') return ((rmBit << 9) | ((rmBit ^ nz) ? 0xd0 : 0x34)) & SIN_MASK;
      if (kind === 'sd') return ((hh8 << 9) | ((hh8 ^ nz) << 8)) & SIN_MASK;
      return ((rmBit << 9) | 0x100) & SIN_MASK; // cym(TC)
    }

    _calcSample() {
      this._advanceEg();
      this._advanceLfo();
      const rhythmOn = !!(this.rhythm & 0x20);
      let out = 0;
      // 位相を全スロット進める(進める前の値で今サンプルを計算)
      const phases = [];
      for (const c of this.channels) {
        for (const s of c.slots) {
          phases.push(s.phase);
          s.phase = (s.phase + this._slotInc(c, s)) & PHASE_MASK;
        }
      }
      const melodyN = rhythmOn ? 6 : 9;
      for (let i = 0; i < melodyN; i++) {
        const c = this.channels[i];
        const [m, cr] = c.slots;
        const fbIn = c.fb ? ((m.prev[0] + m.prev[1]) >> (10 - c.fb)) : 0;
        const om = this._opOut(m, this._egOut(m), fbIn);
        m.prev[0] = m.prev[1]; m.prev[1] = om;
        let o;
        if (c.cnt) o = om + this._opOut(cr, this._egOut(cr), 0);
        else o = this._opOut(cr, this._egOut(cr), om >> 1);
        if (!this.mute[i]) out += o * this.vol[i];
      }
      if (rhythmOn) {
        const ch6 = this.channels[6], ch7 = this.channels[7], ch8 = this.channels[8];
        const hhPhase = phases[7 * 2], tcPhase = phases[8 * 2 + 1];
        // BD: 通常の2op FM(×2)
        {
          const [m, cr] = ch6.slots;
          const fbIn = ch6.fb ? ((m.prev[0] + m.prev[1]) >> (10 - ch6.fb)) : 0;
          const om = this._opOut(m, this._egOut(m), fbIn);
          m.prev[0] = m.prev[1]; m.prev[1] = om;
          const o = ch6.cnt ? this._opOut(cr, this._egOut(cr), 0) : this._opOut(cr, this._egOut(cr), om >> 1);
          if (!this.mute[MUTE_BD]) out += 2 * o * this.vol[MUTE_BD];
        }
        // HH(ch7 mod) / SD(ch7 car) / TOM(ch8 mod) / CYM(ch8 car): 単オペ×2
        const one = (s, idx) => { const a = this._egOut(s); return this._wave(0, idx, a); };
        {
          const s = ch7.slots[0];
          const o = one(s, this._rhythmIndex('hh', hhPhase, tcPhase));
          if (!this.mute[MUTE_HH]) out += 2 * o * this.vol[MUTE_HH];
        }
        {
          const s = ch7.slots[1];
          const o = one(s, this._rhythmIndex('sd', hhPhase, tcPhase));
          if (!this.mute[MUTE_SD]) out += 2 * o * this.vol[MUTE_SD];
        }
        {
          const s = ch8.slots[0];
          const o = one(s, (phases[8 * 2] >> PHASE_TO_SIN) & SIN_MASK);
          if (!this.mute[MUTE_TOM]) out += 2 * o * this.vol[MUTE_TOM];
        }
        {
          const s = ch8.slots[1];
          const o = one(s, this._rhythmIndex('cym', hhPhase, tcPhase));
          if (!this.mute[MUTE_CYM]) out += 2 * o * this.vol[MUTE_CYM];
        }
      }
      // ADPCM-B(Y8950): FMサンプルと同レートでクロック
      if (this.hasAdpcm) {
        this.adpcmB.clock();
        this.adpcmOut = (!this.mute[MUTE_ADPCM] && this.adpcmB.playing)
          ? this.adpcmB.value() * this.vol[MUTE_ADPCM] * (8192 / 16384) : 0;
      }
      // 9ch合算を±1.0程度へ(ym2151の按分と同じ感覚)
      this.last = (out + this.adpcmOut) / (8192 * 6);
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this._calcSample();
    }
    mixSample() { return this.last; }
  }

  // 鍵盤表示の波形列/大波形用: いまのEG状態・波形選択(WS)・接続・帰還で2opを定常状態として
  // 1周期(キャリア基準128点)合成する(ym2151.js snapshot の簡易合成と同じ考え方)。
  // ★これが無いと鍵盤の波形アイコンが汎用FMアイコン(=サイン波)になり、YM3812の波形選択も
  //   モジュレーションも見えず「波形が全部サイン波」に見える(2026-09-07)
  function synthOplWave(chip, c) {
    const N = 128;
    const [m, cr] = c.slots;
    const wave = new Array(N).fill(0);
    const ratio = (m.mul || 1) / (cr.mul || 1);
    const attM = chip._egOut(m), attC = chip._egOut(cr);
    let p0 = 0, p1 = 0, mx = 1e-6;
    // 帰還を定常化するため2周期回して後半だけ採る
    for (let n = 0; n < 2 * N; n++) {
      const k = n % N;
      const phm = Math.round(k / N * SIN_LEN * ratio) & SIN_MASK;
      const phc = Math.round(k / N * SIN_LEN) & SIN_MASK;
      const fbIn = c.fb ? ((p0 + p1) >> (10 - c.fb)) : 0;
      const om = chip._wave(m.ws, (phm + fbIn) & SIN_MASK, attM);
      p0 = p1; p1 = om;
      const v = c.cnt ? om + chip._wave(cr.ws, phc, attC) : chip._wave(cr.ws, (phc + (om >> 1)) & SIN_MASK, attC);
      if (n >= N) { wave[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v); }
    }
    for (let k = 0; k < N; k++) wave[k] /= mx;
    return wave;
  }

  // ── 鍵盤表示用スナップショット ──
  // channels[9]: { freq, vol, rawVol, active, keyOn, tlVol, patch, waveData } + rhythm行(rhythmOn時):
  // rhythm: { on, bd:{...}, sd, tom, cym, hh } 各 { keyOn, vol, freq(TOM/HH/SDはch7/8のfnum由来) }
  // opt.skipWave=true で waveData(表示専用の合成波形128点)を作らない(先読みキャプチャ向け)
  Emu.snapshotOPL = function (chip, opt) {
    const skipWave = !!(opt && opt.skipWave);
    const out = { channels: [], rhythm: null };
    const rhythmOn = !!(chip.rhythm & 0x20);
    const melodyN = rhythmOn ? 6 : 9;
    const freqOf = (c, s) => c.fnum > 0 ? c.fnum * Math.pow(2, c.block - 1) * chip.sampleRate / (1 << 19) * (s.mul / 2) : 0;
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.channels[i];
      const cr = c.slots[1];
      const inMelody = i < melodyN;
      const carAtt = Math.min(EG_MAX, cr.volume + cr.tl);
      const modS = c.slots[0];
      const anyOn = inMelody && (cr.state !== EG_OFF || (c.cnt === 1 && modS.state !== EG_OFF));
      const vol = anyOn ? Math.max(0, 1 - carAtt / EG_MAX) : 0;
      const tlVol = Math.max(0, 1 - Math.min(504, cr.tl) / 504);
      const freq = freqOf(c, cr);
      const active = anyOn && vol > 0.02 && freq > 0;
      out.channels.push({
        freq, vol, rawVol: Math.round(vol * 15), active, keyOn: inMelody && c.kon, tlVol,
        panL: 1, panR: 1,
        waveData: (active && !skipWave) ? synthOplWave(chip, c) : null,
        patch: Emu.decodeOplPatch(chip.regs, i, chip.hasWave)
      });
    }
    if (rhythmOn) {
      const r = chip.rhythm;
      // freqSlot: 音程表示に使うスロット(BD=ch6キャリア、TOM=ch8モジュレータ)。SD/CYM/HHは音程なし
      const drum = (slots, bit, c, freqSlot) => {
        let att = EG_MAX;
        let on = false;
        for (const s of slots) { if (s.state !== EG_OFF) { on = true; att = Math.min(att, Math.min(EG_MAX, s.volume + s.tl)); } }
        return { keyOn: !!(r & bit), active: on && att < EG_MAX - 16, vol: on ? Math.max(0, 1 - att / EG_MAX) : 0,
                 freq: c ? freqOf(c, freqSlot) : 0 };
      };
      const ch6 = chip.channels[6], ch7 = chip.channels[7], ch8 = chip.channels[8];
      out.rhythm = {
        on: true,
        bd: drum(ch6.slots, 0x10, ch6, ch6.slots[1]),
        hh: drum([ch7.slots[0]], 0x01, null, null),
        sd: drum([ch7.slots[1]], 0x08, null, null),
        tom: drum([ch8.slots[0]], 0x04, ch8, ch8.slots[0]),
        cym: drum([ch8.slots[1]], 0x02, null, null)
      };
    }
    if (chip.hasAdpcm) {
      const B = chip.adpcmB;
      const lvl = B.regs[0x0B];
      const rateB = B.rate();
      const pb = (B.seq && chip.samplePitch) ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
      out.adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
        panL: 1, panR: 1, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
        pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual),
        sampleKind: pb ? (pb.kindManual || 'auto') : 'auto', sampleHash: pb ? pb.hash : null,
        waveData: pb ? pb.wave : null,
        sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
        refRate: chip.sampleRate / 3 };
    }
    return out;
  };

  // レジスタ影から2op音色を取り出す。鍵盤の音色表示は既存のOPLL書式(formatOpllPatch)を
  // 流用するため type:'opll' 互換の形で返す(PM=VIB, EG=EGT, KR=KSR, KL=KSL, WF=半波近似
  // (OPL2のWS1-3を1bitへ落とす)。CNT=1(加算接続)とWSの2bit値はOPLLに表現が無いので
  // 表示上は落ちる。inst=0は「ユーザー音色」表示のため)。
  Emu.decodeOplPatch = function (regs, ch, hasWave) {
    const so = [(ch % 3) + ((ch / 3) | 0) * 8, (ch % 3) + 3 + ((ch / 3) | 0) * 8];
    const wse = hasWave && !!(regs[0x01] & 0x20);
    const op = (s) => ({
      AM: (regs[0x20 + s] >> 7) & 1, PM: (regs[0x20 + s] >> 6) & 1, EG: (regs[0x20 + s] >> 5) & 1,
      KR: (regs[0x20 + s] >> 4) & 1, ML: regs[0x20 + s] & 15,
      KL: (regs[0x40 + s] >> 6) & 3, TL: regs[0x40 + s] & 0x3F,
      AR: (regs[0x60 + s] >> 4) & 15, DR: regs[0x60 + s] & 15,
      SL: (regs[0x80 + s] >> 4) & 15, RR: regs[0x80 + s] & 15,
      WF: (wse && (regs[0xE0 + s] & 3) >= 1) ? 1 : 0,
      FB: (regs[0xC0 + ch] >> 1) & 7
    });
    return { type: 'opll', inst: 0, cnt: regs[0xC0 + ch] & 1, mod: op(so[0]), car: op(so[1]) };
  };

  // 表示用サンプルピッチ解析API(Y8950 ADPCM-B、romB/_pitchCacheのみ参照)
  if (Emu.OpnAdpcm && Emu.OpnAdpcm.attachSampleApi) Emu.OpnAdpcm.attachSampleApi(OPLAudio.prototype);

  Emu.OPL_MUTE = { BD: MUTE_BD, SD: MUTE_SD, TOM: MUTE_TOM, CYM: MUTE_CYM, HH: MUTE_HH, ADPCM: MUTE_ADPCM, NUM: NUM_MUTE };
  Emu.OPLAudio = OPLAudio;
})(window);
