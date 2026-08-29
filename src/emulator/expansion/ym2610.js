/*
 * YM2610 (OPNB) 音源エミュレータ — FM + ADPCM-A + ADPCM-B (Neo Geo / VGM)
 * MML.Emu.YM2610Audio
 *
 * YM2610は SSG(AY-3-8910互換,3ch) + FM(4ch) + ADPCM-A(6ch) + ADPCM-B(1ch) を1チップに
 * 内蔵する。このファイルは FM と ADPCM-A/B を扱う(SSGはEmu.AY8910Audioをそのまま再利用)。
 * VGM上は 0x58(ポート0)/0x59(ポート1) のレジスタ書込みでまとめて叩かれるので、SSG/FMの
 * 振り分けは呼び出し側(vgmPlayer.js)が行う(SSGはここに来ても弾くだけ)。
 *
 * ★FM部は YM2612コア(ym2612Nuked.js=Nuked-OPN2移植)の薄いラッパー。
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
 * コアは chipType:'ym3438' で使う: FMオペレータ本体(PG/EG/log-sin・exp ROM/LFO/SSG-EG)は
 * OPNファミリ共通設計だが、YM2612固有の9bit DACラダー効果はYM2610には無い
 * (OPNA/OPNBは内部加算して16bit出力)ため、ラダー無しモードが正しい。
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
 *   (実測)なのでADPCM出力は ×0.2/4096 で同じ比率に合わせる(ADPCM_SCALE)。
 *
 * ★表示専用のサンプルピッチ解析(samplePitch / decodeAdpcmA・B / detectCps): 音程レジスタの無い
 *   ADPCM-Aと、Δ-Nしか無いADPCM-Bに絶対音名を出すため、ROM上のサンプルを1回だけデコードして
 *   基本周期(cps=1入力サンプルあたりの周期数)を求めキャッシュする(詳細は同関数群のコメント)。
 *
 *   手動キャリブレーション(setSampleTuning: cps上書き、localStorage 'ym2610AdpcmTuning' にサンプル内容の
 *   ハッシュをキーで永続化)と、波形アイコン用の1周期/概形波形(makeSampleWave)もここで作る。
 *
 * 外部I/F: writeReg(port,reg,val) / clock()(マスタークロック毎) / mixSample() / loadRom(kind,...) /
 * samplePitch(kind,start,end) / setSampleTuning(kind,start,end,cps|null) /
 * mute[fmCh] / vol[fmCh] / muteAdpcm[7](A1-6,B) / volAdpcm[7](書き換えたら syncMuteVol()) /
 * core / numFm(4 or 6) / flushWrites() / Emu.snapshotYM2610(chip)。
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
        // 鳴っているサンプルの範囲(バイト)。ドライバがキーオン後に次の音のレジスタを先書きしても
        // 表示側(ピッチ解析)が正しいサンプルを見られるようキーオン時点で確定させる
        c.smpStart = c.curaddress;
        c.smpEnd = ((this.regs[0x20 + i] | (this.regs[0x28 + i] << 8)) + 1) << ADPCMA_ADDR_SHIFT;
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
      this.smpStart = this.curaddress; // 鳴っているサンプルの範囲(AdpcmA.ch[].smpStart/Endと同じ用途)
      this.smpEnd = ((this.regs[0x04] | (this.regs[0x05] << 8)) + 1) << ADPCMB_ADDR_SHIFT;
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

  // ── サンプルのピッチ解析(鍵盤/ロールの音程表示用。再生には一切関与しない) ──
  // ADPCM-A/B のサンプルは ROM 上の固定データなので、同じ範囲(開始/終了アドレス)は毎回同じ波形。
  // 初めて見たサンプルを1回だけ丸ごとデコードして基本周期を求め、「1入力サンプルあたりの周期数
  // cps」(再生レート非依存)としてキャッシュする。表示周波数 = cps × 現在の再生レート
  // (ADPCM-A: 固定18518Hz、ADPCM-B: Δ-N由来)。ADPCM-Bは「1つのサンプルをΔ-Nで音階演奏」が
  // 典型なので、Δ-Nの比で正確な音程差 + 解析で正確な基準、の組み合わせで絶対音名まで出せる。
  // ADPCM-Aは「音程ごとに別サンプル」の場合にサンプルごとの検出値がそのまま絶対音になる。
  // ドラム/ノイズ系は検出信頼度(conf)が低くなるので、表示側はしきい値で音程なし表示に落とす。
  //
  // 検出は McLeod の NSDF(正規化二乗差関数、実体は正規化自己相関)。アタック部(先頭15%)を避けて
  // 最大 PITCH_FRAMES 個の窓を等間隔に取り、各窓で「最初の主要ピーク」(グローバル最大の90%以上で
  // 最初に現れる正の山、放物線補間)を周期とする。窓ごとの結果の中央値を採用し、中央値±3%以内で
  // 一致した窓の割合を conf(0-1)にする(オクターブ誤りや非周期部分があると下がる)。
  // コスト: 窓1600×ラグ800×6窓≒8M積和/サンプル、ユニークなサンプルごとに1回だけ(数ms〜十数ms)。
  // PITCH_MIN_LAG: 検出上限周波数=レート/16(ADPCM-A 18518Hz→1157Hz、ADPCM-B 55kHz→3.4kHz)。
  // 小さくするとハイハット等の高域ノイズが最小ラグ境界に偽ピークを作る(初版は8で 18518/8=2314.8Hz
  // が実曲のハイハットに出た)。境界(τ==PITCH_MIN_LAG)で最大となる山も真の極大でないので捨てる。
  const PITCH_WIN = 1600, PITCH_MAX_LAG = 800, PITCH_MIN_LAG = 16, PITCH_FRAMES = 6, PITCH_CLARITY = 0.85;

  function decodeAdpcmA(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, stepIndex = 0, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * ADPCMA_STEPS[stepIndex]) >> 3;
        if (data & 8) delta = -delta;
        acc = (acc + delta) & 0xFFF;
        stepIndex = Math.max(0, Math.min(48, stepIndex + ADPCMA_STEP_INC[data & 7]));
        let s = acc; if (s & 0x800) s -= 0x1000;
        out[k++] = s / 2048;
      }
    }
    return out;
  }
  function decodeAdpcmB(rom, start, end) {
    const n = Math.max(0, Math.min(end, rom.length) - start);
    const out = new Float32Array(n * 2);
    let acc = 0, step = ADPCMB_STEP_MIN, k = 0;
    for (let a = start; a < start + n; a++) {
      const byte = rom[a];
      for (const data of [byte >> 4, byte & 0x0F]) {
        let delta = ((2 * (data & 7) + 1) * step) >> 3;
        if (data & 8) delta = -delta;
        acc = Math.max(-32768, Math.min(32767, acc + delta));
        step = Math.max(ADPCMB_STEP_MIN, Math.min(ADPCMB_STEP_MAX, ((step * ADPCMB_STEP_SCALE[data & 7]) / 64) | 0));
        out[k++] = acc / 32768;
      }
    }
    return out;
  }

  // 1窓のNSDFから周期(ラグ、小数)と明瞭度(0-1)を返す
  function nsdfPeriod(pcm, off, W, maxLag) {
    let mean = 0;
    for (let i = 0; i < W; i++) mean += pcm[off + i];
    mean /= W;
    const x = new Float32Array(W);
    for (let i = 0; i < W; i++) x[i] = pcm[off + i] - mean;
    const nsdf = new Float32Array(maxLag + 1);
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      let acf = 0, m = 0;
      for (let i = 0; i + tau < W; i++) { const a = x[i], b = x[i + tau]; acf += a * b; m += a * a + b * b; }
      nsdf[tau] = m > 0 ? 2 * acf / m : 0;
    }
    // 正の山ごとの最大値を集める(負→正の交差から次の負への交差まで)
    const peaks = [];
    let inPos = false, best = -1, bestTau = 0;
    for (let tau = PITCH_MIN_LAG; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (!inPos) { inPos = true; best = -1; }
        if (v > best) { best = v; bestTau = tau; }
      } else if (inPos) {
        inPos = false;
        if (bestTau > PITCH_MIN_LAG) peaks.push({ tau: bestTau, v: best }); // 境界の偽ピークは捨てる
      }
    }
    if (inPos && best > 0 && bestTau > PITCH_MIN_LAG && bestTau < maxLag) peaks.push({ tau: bestTau, v: best });
    if (!peaks.length) return null;
    let gmax = 0;
    for (const p of peaks) if (p.v > gmax) gmax = p.v;
    const p = peaks.find(q => q.v >= gmax * 0.9);
    // 放物線補間
    let tau = p.tau;
    if (tau > PITCH_MIN_LAG && tau < maxLag) {
      const y0 = nsdf[tau - 1], y1 = nsdf[tau], y2 = nsdf[tau + 1];
      const d = y0 - 2 * y1 + y2;
      if (d < 0) tau += 0.5 * (y0 - y2) / d;
    }
    return { lag: tau, clarity: p.v };
  }

  // pcm(Float32Array)から {cps, conf}。conf<0.5 は表示側で「音程なし」扱い
  function detectCps(pcm) {
    const len = pcm.length;
    if (len < 256) return { cps: 0, conf: 0 };
    const W = Math.min(PITCH_WIN, Math.floor(len * 0.6));
    const maxLag = Math.min(PITCH_MAX_LAG, Math.floor(W / 2));
    if (maxLag <= PITCH_MIN_LAG + 2) return { cps: 0, conf: 0 };
    const first = Math.floor(len * 0.15);
    const span = len - first - W;
    const frames = span <= 0 ? 1 : Math.min(PITCH_FRAMES, Math.floor(span / (W / 2)) + 1);
    const lags = [];
    for (let f = 0; f < frames; f++) {
      const off = span <= 0 ? Math.max(0, len - W) : first + Math.floor(span * f / Math.max(1, frames - 1));
      const r = nsdfPeriod(pcm, off, W, maxLag);
      if (r && r.clarity >= PITCH_CLARITY) lags.push(r.lag);
    }
    if (!lags.length) return { cps: 0, conf: 0 };
    lags.sort((a, b) => a - b);
    const med = lags[lags.length >> 1];
    let agree = 0;
    for (const l of lags) if (Math.abs(l - med) / med <= 0.03) agree++;
    return { cps: 1 / med, conf: agree / frames };
  }

  // サンプル内容のハッシュ(FNV-1a、先頭4KB+長さ)。手動キャリブレーションのキー。ROM上のアドレスは
  // ゲームごと/ダンプごとに違いうるが、サンプル内容が同じなら同じ音なので内容で同定する。
  function sampleHash(rom, start, end) {
    let h = 0x811c9dc5;
    const n = Math.min(end, rom.length) - start;
    const lim = Math.min(n, 4096);
    for (let i = 0; i < lim; i++) { h ^= rom[start + i]; h = Math.imul(h, 0x01000193); }
    h ^= n; h = Math.imul(h, 0x01000193);
    return (h >>> 0).toString(16) + '-' + n.toString(16);
  }
  const TUNING_KEY = 'ym2610AdpcmTuning'; // localStorage: { [sampleHash]: cps }
  // 毎回localStorageから読む(サンプル初出時とキャリブレーション時だけなので頻度は低い。
  // メモリキャッシュにすると開発者ツール等で消した設定が残り続けて紛らわしい)
  function getTuningMap() {
    try { return JSON.parse(global.localStorage.getItem(TUNING_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveTuningMap(map) {
    try { global.localStorage.setItem(TUNING_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  // ── 打楽器/音階の手動上書き ────────────────────────────────────────────
  // 「このサンプルは打楽器か、音階楽器か」はピッチ解析の信頼度(conf>=0.5)で自動判定して
  // いるが、外れる曲がある。ユーザーが耳で決めた指定をここへ集約する。
  // ★applyKindOverride を samplePitch() の中で conf に反映させることで、
  //   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換の4箇所が
  //   すべて自動的に追随する(判定の分岐を増やさない)。
  // キーはサンプル内容のハッシュ(チューニングと同じ)。ROM上のアドレスと違い、
  // 別のゲーム/別のリビジョンでも同じ音なら同じ指定が効く。
  const KIND_KEY = 'samplePitchKind'; // localStorage: { [sampleHash]: 'drum' | 'pitch' }
  function getKindMap() {
    try { return JSON.parse(global.localStorage.getItem(KIND_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveKindMap(map) {
    try { global.localStorage.setItem(KIND_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }
  /** samplePitch() の結果 r に手動指定を反映する(r.kindManual に指定内容を残す) */
  function applyKindOverride(r) {
    if (!r || !r.hash) return r;
    const k = getKindMap()[r.hash];
    if (k === 'drum') { r.conf = 0; r.kindManual = 'drum'; }
    else if (k === 'pitch' && r.cps > 0) { r.conf = 1; r.kindManual = 'pitch'; }
    else r.kindManual = null;
    return r;
  }
  /** 手動指定の設定/解除。kind: 'drum' | 'pitch' | null(=自動へ戻す) */
  function setKindOverride(hash, kind) {
    if (!hash) return;
    const map = getKindMap();
    if (kind === 'drum' || kind === 'pitch') map[hash] = kind; else delete map[hash];
    saveKindMap(map);
  }

  // 波形アイコン用の128点。cps>0(音程あり)なら持続部(先頭40%位置)から1周期を線形補間で切り出し、
  // 音程なし(ドラム等)ならサンプル全体を128区間に分け各区間の絶対値最大(符号付き)=概形。
  // どちらも最大絶対値で正規化(±1)。
  function makeSampleWave(pcm, cps) {
    const N = 128;
    const len = pcm.length;
    if (len < 8) return null;
    const out = new Float32Array(N);
    let mx = 1e-9;
    if (cps > 0) {
      const period = 1 / cps;
      let off = Math.floor(len * 0.4);
      if (off + period + 1 >= len) off = Math.max(0, len - period - 2);
      for (let k = 0; k < N; k++) {
        const pos = off + period * k / N;
        const i = Math.floor(pos), f = pos - i;
        const v = pcm[i] * (1 - f) + (pcm[Math.min(len - 1, i + 1)] || 0) * f;
        out[k] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
      }
    } else {
      for (let k = 0; k < N; k++) {
        const a = Math.floor(len * k / N), b = Math.max(a + 1, Math.floor(len * (k + 1) / N));
        let best = 0;
        for (let i = a; i < b; i++) if (Math.abs(pcm[i]) > Math.abs(best)) best = pcm[i];
        out[k] = best; if (Math.abs(best) > mx) mx = Math.abs(best);
      }
    }
    for (let k = 0; k < N; k++) out[k] /= mx;
    return out;
  }

  class YM2610Audio {
    /**
     * @param {number} [clock=8000000] - マスタークロック(サンプルレート=clock/144)
     * @param {{ym2610b?: boolean}} [opts] - ym2610b: YM2610B(FM 6ch全部が実チャンネル)
     */
    constructor(clock, opts) {
      this.clockHz = clock || 8000000;
      this.core = new Emu.YM2612Nuked(this.clockHz, { chipType: 'ym3438' });
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
      this._pitchCache = new Map(); // 'a:start:end' / 'b:start:end' → {cps, conf}(samplePitch)
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
      this._pitchCache.clear(); // ROMが変わったら解析結果は無効
    }

    /**
     * サンプル(ROM上のstart..end-1バイト)の基本周期解析結果(キャッシュ)。表示専用。
     * @param {'a'|'b'} kind
     * @returns {{cps:number, conf:number, cpsAuto:number, confAuto:number, manual:boolean, hash:string, wave:Float32Array|null}|null}
     *   cps=1入力サンプルあたりの周期数(手動補正があればその値、conf=1)。cpsAuto/confAutoは自動検出値。
     *   wave=波形アイコン用128点(音程あり: 持続部の1周期 / 無し: サンプル全体の概形)
     */
    samplePitch(kind, start, end) {
      if (start === undefined || end === undefined || !(end > start)) return null;
      const key = kind + ':' + start + ':' + end;
      let r = this._pitchCache.get(key);
      if (r) return r;
      const rom = kind === 'b' ? this.romB : this.romA;
      if (!rom) return null;
      const pcm = this._decodeSample(kind, start, end);
      const auto = detectCps(pcm);
      r = { cps: auto.cps, conf: auto.conf, cpsAuto: auto.cps, confAuto: auto.conf, manual: false, hash: sampleHash(rom, start, end), wave: null };
      // 手動キャリブレーション(localStorage、サンプル内容のハッシュがキーなので同じゲームの他トラックでも効く)
      const t = getTuningMap()[r.hash];
      if (t !== undefined && t > 0) { r.cps = t; r.conf = 1; r.manual = true; }
      // 打楽器/音階の手動上書きをconfへ反映(ロール/鍵盤/変換の4箇所がこの1点で追随する)
      applyKindOverride(r);
      r.wave = makeSampleWave(pcm, r.conf >= 0.5 ? r.cps : 0);
      this._pitchCache.set(key, r);
      return r;
    }
    _decodeSample(kind, start, end) {
      const rom = kind === 'b' ? this.romB : this.romA;
      // 極端に長いサンプル(ADPCM-Bのループ曲データ等)は先頭部分だけ見る(解析コスト上限)
      const MAX_BYTES = 64 * 1024;
      const e = Math.min(end, start + MAX_BYTES);
      return kind === 'b' ? decodeAdpcmB(rom, start, e) : decodeAdpcmA(rom, start, e);
    }

    /**
     * スナップショットの sample({kind,start,end}) → デコード済みPCM(Float32Array、-1..1)。
     * vgm2mmlのドラム→@DPCM変換が実サンプルを必要とするための公開口。
     * ROMはこのチップ(=キャプチャWorker側)にしか無く、関数はpostMessageを越えられないので、
     * キャプチャの最後にここを呼んで実データだけをメインスレッドへ渡す
     * (src/emulator/vgmPlayer.js の collectUsedSamples 参照)。
     */
    /**
     * 打楽器/音階の手動上書き。kind: 'drum' | 'pitch' | null(=自動へ戻す)。
     * ピッチ解析の信頼度(conf)による自動判定が外れた曲を、ユーザーが耳で直すための口。
     * 指定はサンプル内容のハッシュをキーに localStorage へ入る(setSampleTuningと同じ流儀。
     * ROMアドレスと違い、同じ音なら別のゲーム/リビジョンでも効く)。
     * ★confへの反映は Emu.SamplePitchUtil.applyKindOverride が samplePitch() の中で行うので、
     *   ロールのドラム区画・鍵盤のnote列・vgm2mmlのドラムパート・DPCM変換が自動的に追随する。
     */
    setSampleKind(sample, kind) {
      if (!sample) return null;
      const r = this.samplePitch(sample.kind, sample.start, sample.end);
      if (!r || !r.hash) return null;
      Emu.SamplePitchUtil.setKindOverride(r.hash, kind);
      // 「音階として扱う」を選んでも、周期がまったく検出できていない(cps=0)サンプルは
      // 使える音程が無い。呼び出し側へ知らせて基準音の手動補正を促す(黙って無視しない)
      const needsTuning = kind === 'pitch' && !(r.cps > 0);
      this._pitchCache.delete(sample.kind + ':' + sample.start + ':' + sample.end); // 次回参照で上書きを反映し直す
      return { kind: kind || null, needsTuning: needsTuning };
    }

    samplePcm(sample) {
      if (!sample) return null;
      return this._decodeSample(sample.kind, sample.start, sample.end);
    }

    /**
     * サンプルの手動ピッチ補正(表示専用)。cps=null で解除。localStorage に永続化し、
     * 同じ内容のサンプル(ハッシュ一致)なら別トラック/別セッションでも効く。
     */
    setSampleTuning(kind, start, end, cps) {
      const r = this.samplePitch(kind, start, end);
      if (!r) return null;
      const map = getTuningMap();
      if (cps && cps > 0) { map[r.hash] = cps; r.cps = cps; r.conf = 1; r.manual = true; }
      else { delete map[r.hash]; r.cps = r.cpsAuto; r.conf = r.confAuto; r.manual = false; }
      saveTuningMap(map);
      r.wave = makeSampleWave(this._decodeSample(kind, start, end), r.conf >= 0.5 ? r.cps : 0);
      return r;
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
    // 書込みキュー適用(clock()を回さない先読み/シーク経路用)
    flushWrites() { if (this.core.flushWrites) this.core.flushWrites(); }
  }

  // 鍵盤表示用スナップショット: FMはYM2612版の6chから実チャンネルを抜き出す(形は同じ)。
  // adpcmA[6]/adpcmB: {active, vol(0-1), rawVol, rawVolMax, panL, panR, rate, pitchHz, pitchConf, ...}
  //   pitchHz/pitchConf: 鳴っているサンプルのピッチ解析(samplePitch)結果 × 現在の再生レート。
  //   conf<0.5 は表示側で音程なし扱い(ドラム等)。ADPCM-Aは音程レジスタが無いのでこれが唯一の音程情報、
  //   ADPCM-Bは refRate ベースの仮基準(下記)より優先して使う。
  Emu.snapshotYM2610 = function (chip) {
    const s = Emu.snapshotYM2612(chip.core);
    const A = chip.adpcmA, B = chip.adpcmB;
    const tl = (A.regs[0x01] & 0x3F);
    const adpcmA = [];
    const rateA = chip.sampleRate / 3;
    for (let i = 0; i < 6; i++) {
      const il = A.regs[0x08 + i] & 0x1F;
      const att = (il ^ 0x1F) + (tl ^ 0x3F); // 0=最大
      const vol = att >= 63 ? 0 : Math.max(0, 1 - att / 63);
      const c = A.ch[i];
      const p = c.seq ? chip.samplePitch('a', c.smpStart, c.smpEnd) : null;
      // seq/lenSec: clock()を回さない先読みキャプチャ(vgmPlayer.js captureVgmSongAsync)が、キーオン通番の
      // 変化とサンプル長から「鳴っている区間」を推定するために使う(ライブ表示は playing で足りる)
      adpcmA.push({ active: c.playing && vol > 0, vol, rawVol: il, rawVolMax: 31, panL: A.panL(i) ? 1 : 0, panR: A.panR(i) ? 1 : 0,
        rate: rateA, seq: c.seq, lenSec: A.lengthSeconds(i),
        pitchHz: p ? p.cps * rateA : 0, pitchConf: p ? p.conf : 0, pitchManual: !!(p && p.manual), sampleKind: p ? (p.kindManual || 'auto') : 'auto',
        waveData: p ? p.wave : null,
        sample: c.seq ? { kind: 'a', start: c.smpStart, end: c.smpEnd } : null }); // 手動キャリブレーション用の同定情報
    }
    const lvl = B.regs[0x0B];
    const rateB = B.rate();
    const pb = B.seq ? chip.samplePitch('b', B.smpStart, B.smpEnd) : null;
    const adpcmB = { active: B.playing && !!(B.regs[0x00] & 0x80) && lvl > 0, vol: lvl / 255, rawVol: lvl, rawVolMax: 255,
      panL: B.panL() ? 1 : 0, panR: B.panR() ? 1 : 0, rate: rateB, seq: B.seq, lenSec: B.lengthSeconds(), executing: !!(B.regs[0x00] & 0x80),
      pitchHz: pb ? pb.cps * rateB : 0, pitchConf: pb ? pb.conf : 0, pitchManual: !!(pb && pb.manual), sampleKind: pb ? (pb.kindManual || 'auto') : 'auto',
      waveData: pb ? pb.wave : null,
      sample: B.seq ? { kind: 'b', start: B.smpStart, end: B.smpEnd } : null,
      // refRate: ピッチ解析が信頼できない時のフォールバック用。ADPCM-Bの再生レート(Delta-N由来)を
      // 鍵盤/ロールで疑似音程表示する際の基準(=C4扱い)。ADPCM-Bには「これが基準ピッチ」という
      // レジスタは無いので、同チップのADPCM-A固定レート(chip.sampleRate/3)を基準に採用した
      // (keyboard.js側の相対表示。絶対音名は目安)
      refRate: rateA };
    return { channels: chip.coreCh.map(i => s.channels[i]), adpcmA, adpcmB };
  };

  Emu.YM2610Audio = YM2610Audio;

  // サンプルピッチ解析ユーティリティの共有(GA20等、他のPCMチップからの流用。抽出器を複製しない)。
  // getTuningMap/saveTuningMap の localStorage キーはYM2610と共通('ym2610AdpcmTuning')だが、
  // キーはサンプル内容ハッシュなのでチップをまたいで共有しても衝突しない(むしろ同じサンプルなら
  // 同じ補正が効くのが望ましい)。
  // ループ区間の基本周期推定(qsound.jsで実証した「ループ因数分解方式」の共有版)。
  // ハードウェアループは継ぎ目なく繋がる=ループ長は基本周期の整数倍。k=2..64の lag=N/k で
  // 巡回自己相関(補間つき)を測り、最大相関の90%以上の中で最大のk(=最高周波数解釈)を採る。
  // 汎用detectCpsは探索上限(PITCH_MAX_LAG)を長周期ベースが超えるが、この方式は上限なし。
  // どのkも通らなければ「ループ全体=1周期」(単一周期シンセ波形。≤1024サンプルに限る)。
  // 返り値は detectCps 互換 {cps, conf} または null。
  function loopCps(one) {
    const N = one.length;
    if (N < 16) return null;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += one[i];
    mean /= N;
    const x = new Float32Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) { x[i] = one[i] - mean; e += x[i] * x[i]; }
    if (e < 1e-9) return null;
    let bestK = 0, bestCorr = 0;
    const cands = [];
    for (let k = 2; k <= 64; k++) {
      const lag = N / k;
      if (lag < 8) break;
      let acf = 0;
      for (let i = 0; i < N; i++) {
        const pos = (i + lag) % N;
        const j = Math.floor(pos), f = pos - j;
        const v = x[j] * (1 - f) + x[(j + 1) % N] * f;
        acf += x[i] * v;
      }
      const corr = acf / e;
      cands.push([k, corr]);
      if (corr > bestCorr) { bestCorr = corr; bestK = k; }
    }
    if (bestCorr >= 0.85) {
      for (const [k, corr] of cands) if (corr >= bestCorr * 0.9 && k > bestK) bestK = k;
      return { cps: bestK / N, conf: Math.min(1, bestCorr) };
    }
    if (N <= 1024) return { cps: 1 / N, conf: 0.75 };
    return null;
  }

  Emu.SamplePitchUtil = { detectCps, makeSampleWave, sampleHash, getTuningMap, saveTuningMap, loopCps,
                          getKindMap, saveKindMap, applyKindOverride, setKindOverride };
})(window);
