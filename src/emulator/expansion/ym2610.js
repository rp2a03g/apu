/*
 * YM2610 (OPNB) 音源エミュレータ — FM + ADPCM-A + ADPCM-B (Neo Geo / VGM)
 * MML.Emu.YM2610Audio
 *
 * YM2610は SSG(AY-3-8910互換,3ch) + FM(4ch) + ADPCM-A(6ch) + ADPCM-B(1ch) を1チップに
 * 内蔵する。このファイルは FM と ADPCM-A/B を扱う(SSGはEmu.AY8910Audioをそのまま再利用)。
 * VGM上は 0x58(ポート0)/0x59(ポート1) のレジスタ書込みでまとめて叩かれるので、SSG/FMの
 * 振り分けは呼び出し側(vgmPlayer.js)が行う(SSGはここに来ても弾くだけ)。
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植 または ym2612.js=高速近似)の薄いラッパー。
 * 理由: YM2610のFMレジスタ配置はYM2612と完全に同一(0x30 DT/MUL … 0xB4 L/R/AMS/PMS、0x22 LFO、
 * 0x27 ch3モード、0x28 キーオン、サンプルレート=clock/144、周波数式も同じ)で、違いは
 *   (1) 6chぶんのアドレス空間のうち実チャンネルが各ポートのオフセット1,2だけ
 *       (オフセット0,3は結線されていないダミー。ymfm(aaronsgiles/ymfm, BSD-3)の
 *       ym2610 channel_mask=0x36=YM2612番号でch1,2,4,5 と一致。YM2610Bは6ch全部が実チャンネル)、
 *   (2) ch6 DAC(0x2A/0x2B、YM2612固有)が無い、
 *   (3) SSG/ADPCM-A/ADPCM-Bのレジスタ領域(port0 0x00-0x1F, port1 0x00-0x2F)が挟まる、
 * の3点だけなので、YM2612コアを6chのまま動かしてダミーch/DACを常時ミュートし、
 * 該当領域の書込みを弾くだけで済む。ch3特殊モード(0x27上位ビット、YM2612のch3=port0
 * オフセット2=YM2610のFM2に相当。MAME fm.cppのym2610もCH[2]に適用)もそのまま効く。
 * キーオン0x28の値1,2,5,6 → YM2612コアのch1,2,4,5 = 本クラスのFM1-4。
 *
 * コアの選択は makeYm2612Adapter(vgmPlayer.js)と同じ Emu.ym2612CorePref: 既定=Nuked-OPN2
 * (実機準拠)、'fast'=高速近似。Nukedは chipType:'ym3438' で使う: FMオペレータ本体(PG/EG/
 * log-sin・exp ROM/LFO/SSG-EG)はOPNファミリ共通設計だが、YM2612固有の9bit DACラダー効果は
 * YM2610には無い(OPNA/OPNBは内部加算して16bit出力)ため、ラダー無しモードが正しい。
 *
 * ★ADPCM-A/B は ymfm(ymfm_adpcm.cpp / ymfm_opn.cpp ym2610)の関数単位の移植:
 *   ADPCM-A: 6ch、4bit ADPCM(MSM5205系、12bit累算器はラップ)、アドレスは 開始/終了レジスタ<<8、
 *            終了比較は下位20bitのみ(twinspri等の実挙動)、FMサンプル3回に1回クロック
 *            (=EGサイクル、Neo Geo 8MHz で 18518Hz)。音量=(IL^0x1f)+(TL^0x3f) を乗数15-(v&7)と
 *            シフト5+(v>>3)へ。パンL/R。
 *   ADPCM-B: 1ch、4bit ADPCM(累算器16bitクランプ、ステップ127〜24576を0.9〜2.4倍)、
 *            Δ-N(16bit位相累算、fs=ΔN×55555/65536)、線形補間、レベル(0-255)、リピート、
 *            リミット/終了アドレス(<<8)、YM2610では常に外部メモリ(ROM)モード。
 *   ROMは VGM データブロック 0x82(ADPCM-A)/0x83(ADPCM-B=DELTA-T) を loadRom() で受け取る。
 *   出力尺度: ymfmでは FMチャンネルのフルスケール=4096(13bit>>1)、ADPCM-A最大≒15360、
 *   ADPCM-B最大≒16320(レベル255、YM2610はrshift=1)。本クラスのFMコアはフルスケール0.2
 *   (高速/Nuked両コアで実測一致)なのでADPCM出力は ×0.2/4096 で同じ比率に合わせる(ADPCM_SCALE)。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample() / loadRom(kind,...) /
 * mute[fmCh] / vol[fmCh] / muteAdpcm[7](A1-6,B) / volAdpcm[7](書き換えたら syncMuteVol()) /
 * core / coreName / numFm(4 or 6) / flushWrites() / Emu.snapshotYM2610(chip)。
 * Neo Geo: 8000000Hz → 55555Hz。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CYCLES_PER_SAMPLE = 144;
  const ADPCM_SCALE = 0.2 / 4096; // ymfm出力単位 → 本クラスのFM尺度(FMチャンネルのフルスケール0.2)

  // ── ADPCM-A (ymfm adpcm_a_channel/engine) ──
  const ADPCMA_STEPS = [
    16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552
  ];
  const ADPCMA_STEP_INC = [-1, -1, -1, -1, 2, 5, 7, 9];
  const ADPCMA_ADDR_SHIFT = 8;

  class AdpcmA {
    constructor(owner) {
      this.owner = owner;
      this.regs = new Uint8Array(0x30);
      this.ch = [];
      // seq: キーオン通番(clock()を回さない先読みキャプチャがキーオンを検出するため。ロール用)
      for (let i = 0; i < 6; i++) this.ch.push({ playing: false, curnibble: 0, curbyte: 0, curaddress: 0, acc: 0, stepIndex: 0, seq: 0 });
      this.reset();
    }
    // ch i の現在の開始/終了レジスタから求めたサンプル長(秒)。ADPCM-Aは18518Hz(=FMサンプルレート/3)固定
    lengthSeconds(i) {
      const start = (this.regs[0x10 + i] | (this.regs[0x18 + i] << 8)) << ADPCMA_ADDR_SHIFT;
      const end = ((this.regs[0x20 + i] | (this.regs[0x28 + i] << 8)) + 1) << ADPCMA_ADDR_SHIFT;
      const bytes = Math.max(0, end - start);
      return bytes * 2 / (this.owner.sampleRate / 3);
    }
    reset() {
      this.regs.fill(0);
      // パンは両方ON・音色レベル最大が既定(Neo Geoホームブリュー(ffeast等)が依存する。ymfmと同じ)
      for (let i = 0x08; i <= 0x0D; i++) this.regs[i] = 0xDF;
      for (const c of this.ch) { c.playing = false; c.curnibble = 0; c.curbyte = 0; c.curaddress = 0; c.acc = 0; c.stepIndex = 0; }
    }
    write(reg, data) {
      this.regs[reg] = data;
      if (reg === 0x00) {
        const on = !(data & 0x80); // bit7=1 dump(停止)、0=キーオン
        for (let i = 0; i < 6; i++) if (data & (1 << i)) this._keyonoff(i, on);
      }
    }
    _keyonoff(i, on) {
      const c = this.ch[i];
      c.playing = on;
      if (on) {
        c.curaddress = (this.regs[0x10 + i] | (this.regs[0x18 + i] << 8)) << ADPCMA_ADDR_SHIFT;
        c.curnibble = 0; c.curbyte = 0; c.acc = 0; c.stepIndex = 0;
        c.seq++;
      }
    }
    // FMサンプル3回に1回。
    clock() {
      const rom = this.owner.romA;
      for (let i = 0; i < 6; i++) {
        const c = this.ch[i];
        if (!c.playing) { c.acc = 0; continue; }
        let data;
        if (c.curnibble === 0) {
          // 終了アドレス(inclusive)の次のバイトを読もうとした時点で停止。比較は下位20bitのみ
          const end = ((this.regs[0x20 + i] | (this.regs[0x28 + i] << 8)) + 1) << ADPCMA_ADDR_SHIFT;
          if (((c.curaddress ^ end) & 0xFFFFF) === 0) { c.playing = false; c.acc = 0; continue; }
          c.curbyte = rom && c.curaddress < rom.length ? rom[c.curaddress] : 0;
          c.curaddress = (c.curaddress + 1) & 0xFFFFFF;
          data = c.curbyte >> 4; c.curnibble = 1;
        } else {
          data = c.curbyte & 0x0F; c.curnibble = 0;
        }
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[c.stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        c.acc = (c.acc + delta) & 0xFFF; // 12bit累算器はラップ(MSM5205と同じ)
        c.stepIndex = Math.max(0, Math.min(48, c.stepIndex + ADPCMA_STEP_INC[data & 7]));
      }
    }
    // ch i の現在出力(ymfm単位、パン適用前)。0=無音
    value(i) {
      const c = this.ch[i];
      const vol = ((this.regs[0x08 + i] & 0x1F) ^ 0x1F) + ((this.regs[0x01] & 0x3F) ^ 0x3F);
      if (vol >= 63) return 0;
      const mul = 15 - (vol & 7);
      const shift = 4 + 1 + (vol >> 3);
      let a = c.acc & 0xFFF; if (a & 0x800) a -= 0x1000; // 12bit符号拡張
      return (((a << 4) * mul) >> shift) & ~3;
    }
    panL(i) { return !!(this.regs[0x08 + i] & 0x80); }
    panR(i) { return !!(this.regs[0x08 + i] & 0x40); }
  }

  // ── ADPCM-B (ymfm adpcm_b_channel/engine、YM2610=外部メモリ固定・addrshift 8) ──
  const ADPCMB_STEP_MIN = 127, ADPCMB_STEP_MAX = 24576;
  const ADPCMB_STEP_SCALE = [57, 57, 57, 57, 77, 102, 128, 153];
  const ADPCMB_ADDR_SHIFT = 8;

  class AdpcmB {
    constructor(owner) {
      this.owner = owner;
      this.regs = new Uint8Array(0x11);
      this.reset();
    }
    reset() {
      this.regs.fill(0);
      this.regs[0x0C] = this.regs[0x0D] = 0xFF; // リミット既定=全開
      this._resetChannel();
    }
    _resetChannel() {
      this.playing = false; this.curnibble = 0; this.curbyte = 0; this.position = 0; this.curaddress = 0;
      this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      if (this.seq === undefined) this.seq = 0; // 開始通番(先読みキャプチャ用、AdpcmA.ch[].seqと同じ役割)。リセットでは戻さない
    }
    // 現在の開始/終了/Δ-Nから求めたサンプル長(秒)。リピート時は無限(Infinity)
    lengthSeconds() {
      const start = (this.regs[0x02] | (this.regs[0x03] << 8)) << ADPCMB_ADDR_SHIFT;
      const end = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << ADPCMB_ADDR_SHIFT;
      const rate = this.rate();
      if (this.regs[0x00] & 0x10) return Infinity;
      return rate > 0 ? Math.max(0, end - start) * 2 / rate : 0;
    }
    // reg = port0 アドレス - 0x10 (0x00-0x0B)
    write(reg, data) {
      // YM2610は外部モード強制・録音無効(ymfm ym2610::write_data)
      if (reg === 0x00) data = (data | 0x20) & ~0x40;
      this.regs[reg] = data;
      if (reg === 0x00) {
        if (data & 0x80) this._loadStart(); // start
        if (data & 0x01) this._resetChannel(); // reset
      }
    }
    _loadStart() {
      this.playing = true;
      this.curaddress = (this.regs[0x02] | (this.regs[0x03] << 8)) << ADPCMB_ADDR_SHIFT;
      this.curnibble = 0; this.curbyte = 0; this.position = 0; this.acc = 0; this.prevAcc = 0; this.step = ADPCMB_STEP_MIN;
      this.seq++;
    }
    _atEnd() { return this.curaddress === ((((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << ADPCMB_ADDR_SHIFT) - 1); }
    _atLimit() { return this.curaddress === ((((this.regs[0x0C] | (this.regs[0x0D] << 8)) + 1) << ADPCMB_ADDR_SHIFT) - 1); }
    // FMサンプル毎
    clock() {
      if (!(this.regs[0x00] & 0x80) || !this.playing) { this.playing = false; return; }
      const deltaN = this.regs[0x09] | (this.regs[0x0A] << 8);
      const position = this.position + deltaN;
      this.position = position & 0xFFFF;
      if (position < 0x10000) return;
      const rom = this.owner.romB;
      if (this.curnibble === 0) this.curbyte = rom && this.curaddress < rom.length ? rom[this.curaddress] : 0;
      const data = ((this.curbyte << (4 * this.curnibble)) & 0xFF) >> 4;
      this.curnibble ^= 1;
      if (this.curnibble === 0) {
        if (this._atEnd()) {
          if (this.regs[0x00] & 0x10) this._loadStart(); // repeat
          else { this.acc = 0; this.prevAcc = 0; this.playing = false; return; }
        } else if (this._atLimit()) {
          this.curaddress = 0;
        } else {
          this.curaddress = (this.curaddress + 1) & 0xFFFFFF;
        }
      }
      this.prevAcc = this.acc;
      let delta = ((2 * (data & 7) + 1) * this.step) >> 3;
      if (data & 8) delta = -delta;
      this.acc = Math.max(-32768, Math.min(32767, this.acc + delta));
      this.step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((this.step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
    }
    // 現在出力(ymfm単位、パン適用前)。線形補間×レベル(/256)、さらにYM2610では>>1
    // (ymfm ym2610::clock_fm_and_adpcm の m_adpcm_b.output(…, rshift=1))
    value() {
      const r = ((this.prevAcc * ((this.position ^ 0xFFFF) + 1) + this.acc * this.position) >> 16);
      return (r * this.regs[0x0B]) >> 9;
    }
    panL() { return !!(this.regs[0x01] & 0x80); }
    panR() { return !!(this.regs[0x01] & 0x40); }
    // 表示用: 現在の再生レート(Hz)
    rate() { return (this.regs[0x09] | (this.regs[0x0A] << 8)) * this.owner.sampleRate / 65536; }
  }

  class YM2610Audio {
    /**
     * @param {number} [clock=8000000] - マスタークロック(サンプルレート=clock/144)
     * @param {{core?: 'nuked'|'fast', ym2610b?: boolean}} [opts]
     *   core: 省略時は Emu.ym2612CorePref('fast' 以外=Nuked)。ym2610b: YM2610B(FM 6ch全部が実チャンネル)
     */
    constructor(clock, opts) {
      this.clockHz = clock || 8000000;
      const pref = (opts && opts.core) || Emu.ym2612CorePref;
      const useNuked = pref !== 'fast' && !!Emu.YM2612Nuked;
      this.coreName = useNuked ? 'nuked' : 'fast';
      this.core = useNuked ? new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' }) : new Emu.YM2612Audio(this.clockHz);
      this.sampleRate = this.core.sampleRate;
      this.isB = !!(opts && opts.ym2610b);
      // 本クラスのFM1-n → YM2612コア(6ch)上のチャンネル番号
      this.coreCh = this.isB ? [0, 1, 2, 3, 4, 5] : [1, 2, 4, 5];
      this.numFm = this.coreCh.length;
      this.mute = new Array(this.numFm).fill(false);
      this.vol = new Array(this.numFm).fill(1);
      this.muteAdpcm = new Array(7).fill(false); // 0-5=ADPCM-A ch1-6, 6=ADPCM-B
      this.volAdpcm = new Array(7).fill(1);
      this.romA = null; this.romB = null;
      this.adpcmA = new AdpcmA(this);
      this.adpcmB = new AdpcmB(this);
      this.cyc = 0; this.cycA = 0;
      this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    // mute[]/vol[]をコアの6要素へ写す。ダミーch(YM2610の0,3)とDAC(6)は常時ミュート。
    syncMuteVol() {
      const c = this.core;
      for (let i = 0; i < 7; i++) c.mute[i] = true;
      for (let i = 0; i < this.numFm; i++) { c.mute[this.coreCh[i]] = !!this.mute[i]; c.vol[this.coreCh[i]] = this.vol[i]; }
    }

    reset() {
      this.core.reset(); this.adpcmA.reset(); this.adpcmB.reset();
      this.cyc = 0; this.cycA = 0; this.adpcmL = 0; this.adpcmR = 0;
      this.syncMuteVol();
    }

    /**
     * VGMデータブロック 0x82(ADPCM-A ROM)/0x83(ADPCM-B ROM)。
     * @param {'a'|'b'} kind  @param {number} romSize  @param {number} start  @param {Uint8Array} data
     */
    loadRom(kind, romSize, start, data) {
      const key = kind === 'b' ? 'romB' : 'romA';
      let rom = this[key];
      const need = Math.max(romSize >>> 0, start + data.length);
      if (!rom || rom.length < need) { const n = new Uint8Array(need); if (rom) n.set(rom, 0); rom = this[key] = n; }
      rom.set(data, start);
    }

    // レジスタ書込み(port 0/1)。SSG(port0 0x00-0x0F)は呼び出し側がAY8910Audioへ振り分ける前提
    // (渡ってきても弾く)。
    writeReg(port, reg, val) {
      reg &= 0xFF; val &= 0xFF;
      if (port === 0) {
        if (reg < 0x10) return;                              // SSG / I/Oポート
        if (reg < 0x1C) { this.adpcmB.write(reg - 0x10, val); return; } // ADPCM-B
        if (reg === 0x1C) return;                            // EOSフラグ制御(再生には無関係)
        if (reg < 0x20) return;
        if (reg === 0x2A || reg === 0x2B) return;            // YM2612のDAC。YM2610には無い
      } else if (reg < 0x30) {
        this.adpcmA.write(reg, val); return;                 // ADPCM-A
      }
      this.core.writeReg(port, reg, val);
    }

    clock() {
      this.core.clock();
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      // FMサンプル毎: ADPCM-B。3回に1回(EGサイクル): ADPCM-A
      this.adpcmB.clock();
      if (++this.cycA >= 3) { this.cycA = 0; this.adpcmA.clock(); }
      let l = 0, r = 0;
      const A = this.adpcmA;
      for (let i = 0; i < 6; i++) {
        if (this.muteAdpcm[i] || !A.ch[i].playing) continue;
        const v = A.value(i) * this.volAdpcm[i];
        if (A.panL(i)) l += v;
        if (A.panR(i)) r += v;
      }
      if (!this.muteAdpcm[6] && this.adpcmB.playing) {
        const v = this.adpcmB.value() * this.volAdpcm[6];
        if (this.adpcmB.panL()) l += v;
        if (this.adpcmB.panR()) r += v;
      }
      this.adpcmL = l * ADPCM_SCALE; this.adpcmR = r * ADPCM_SCALE;
    }
    mixSample() {
      const s = this.core.mixSample();
      return { left: s.left + this.adpcmL, right: s.right + this.adpcmR };
    }
    // Nukedコアの書込みキュー適用(clock()を回さない先読み/シーク経路用。高速コアでは不要)
    flushWrites() { if (this.core.flushWrites) this.core.flushWrites(); }
  }

  // 鍵盤表示用スナップショット: FMはYM2612版の6chから実チャンネルを抜き出す(形は同じ)。
  // adpcmA[6]/adpcmB: {active, vol(0-1), rawVol, rawVolMax, panL, panR, rate}
  Emu.snapshotYM2610 = function (chip) {
    const s = Emu.snapshotYM2612(chip.core);
    const A = chip.adpcmA, B = chip.adpcmB;
    const tl = (A.regs[0x01] & 0x3F);
    const adpcmA = [];
    for (let i = 0; i < 6; i++) {
      const il = A.regs[0x08 + i] & 0x1F;
      const att = (il ^ 0x1F) + (tl ^ 0x3F); // 0=最大
      const vol = att >= 63 ? 0 : Math.max(0, 1 - att / 63);
      // seq/lenSec: clock()を回さない先読みキャプチャ(vgmPlayer.js captureVgmSongAsync)が、キーオン通番の
      // 変化とサンプル長から「鳴っている区間」を推定するために使う(ライブ表示は playing で足りる)
      adpcmA.push({ active: A.ch[i].playing && vol > 0, vol, rawVol: il, rawVolMax: 31, panL: A.panL(i) ? 1 : 0, panR: A.panR(i) ? 1 : 0,
        rate: chip.sampleRate / 3, seq: A.ch[i].seq, lenSec: A.lengthSeconds(i) });
    }
    const lvl = B.regs[0x0B];
    const adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
      panL: B.panL() ? 1 : 0, panR: B.panR() ? 1 : 0, rate: B.rate(), seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
      // refRate: ADPCM-Bの再生レート(Delta-N由来)を鍵盤/ロールで疑似音程表示する際の基準(=C4扱い)。
      // ADPCM-Bには「これが基準ピッチ」というレジスタは無いので、同チップのADPCM-A固定レート
      // (chip.sampleRate/3)を基準に採用した(keyboard.js側の相対表示。絶対音名は目安)
      refRate: chip.sampleRate / 3 };
    return { channels: chip.coreCh.map(i => s.channels[i]), adpcmA, adpcmB };
  };

  Emu.YM2610Audio = YM2610Audio;
})(window);
