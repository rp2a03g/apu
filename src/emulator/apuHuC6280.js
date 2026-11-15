/*
 * PC エンジンの波形メモリ音源(HuC6280 に内蔵。NEC/ハドソンの資料や Mesen は「PSG」と呼ぶ)
 * MML.Emu.APUHuC6280 — 2026-11-15 に作り直し(段階 9b)
 *
 * 6ch。各 ch は 32 個・5bit の波形メモリを、12bit の周期で読み進める。ch5/6 はノイズに切り替えられる。
 * どの ch も DDA(波形を止めて、書いた値をそのまま出す。PCM 用)にできる。LFO は ch2 の出力で ch1 の周期を揺らす。
 * 時間の単位は音源のクロック(マスタークロック 21.47727MHz の 1/6 = 3.579545MHz)1 個。
 *
 * 使い方: clockBy(n) で n 個ぶん進め、writeRegister() はその時点で効く。「いつ書かれたか」を合わせたい側
 * (hesPlayer.js)は、書く前に runToMaster(マスタークロックの時刻) で時刻まで進めてから書く。
 * mixSample() は「前に呼んでから今まで」の平均を返す(1 サンプルの間に何度も変わる DDA や高い音、音量の書き換えを、瞬間の値で拾わないため)。
 * 平均するのは「出力 × その時の左右の減衰」。
 *
 * 根拠の札(DESIGN-PCE-CAPTURE.md §2.3)。[参照] は Mesen 2 の Core/PCE/PcePsg.cpp・PcePsgChannel.cpp(読んだだけで写していない):
 *   [参照] 周期タイマは下向きに数え、0 になった所で周期を入れ直して読み位置を 1 つ進める。周期レジスタが 0 の時は $1000 として扱う
 *   [参照] 周期レジスタを書いてもタイマは今の周回を終えるまで変わらない。ch の入/切($0804 bit7)が変わった時だけタイマを入れ直す
 *   [参照] $0804 に「DDA=1」の値を書くたび(切り替わった時に限らない)、ch が切なら読み位置を 0 に戻す。入なら出力をすぐ DDA の値にする
 *   [参照] $0806: DDA 中は出力値。そうでなければ今の読み位置に書く。読み位置が進むのは ch が切の時だけ
 *          (鳴っている最中の書き込みは、今鳴っている 1 個を書き換える。Mesen のコメントに、これが要る曲の名前がある)
 *   [参照] ノイズは 18bit の LFSR。右へずらし、出ていく bit0 が音(1 なら 31、0 なら 0)。bit0・1・11・12・17 の XOR を bit17 へ入れる。
 *          リセットで bit0 だけ 1。ch の入/切やノイズの入/切に関係なく、いつも回り続ける
 *          (Mesen が引いている出典は cgfm2 の調査記事。実機の測定に基づく、と書かれている)
 *   [参照] ノイズの周期: レジスタの下位 5bit を反転して 64 倍。$1F(反転して 0)の時だけ 32
 *   [参照] $0807 は ch5/6 だけが受ける。$0802-$0806 は ch1-6 だけ(ch7/8 を選んでいる間の書き込みは捨てる)
 *   [参照] LFO: $0809 の bit7 が 0 で下位 2bit が 0 以外の時に掛かる。ch1 の周期 = (周期レジスタ + ch2 の出力 × 1/4/16) の下位 12bit。
 *          ch2 自身は周期が $0808 倍(0 は 256 倍)に延びる
 *   [参照] 音量の決まり: 全体($0801)と ch の左右($0805)は 1 段 3dB、ch の音量($0804)は 1 段 1.5dB の減衰として足し合わせ、30 段(45dB)以上で無音。
 *          表の値そのものは自前(10^(-1.5×段/20))。Mesen は 8bit の整数の表なので、下の方の段では 1〜2dB 違う(29 段目で約 4.6dB)
 *   ★ 無音になる段: VGMPlay の MAME 由来の実装は 30 段目がまだ鳴り、31 段目で無音(pce-vgm-ab.js --synth で実測)。Mesen は 30 段目から無音。Mesen に合わせた
 *   ★ LFO が掛かっている間も ch2 自身の音は出したまま(Mesen と同じ)。実機で ch2 が消えるのかは未確認
 *   [推定] リセット直後の全体の音量($0801)と ch の左右($0805)は最大($FF)にしてある(作り直し前と同じ)。
 *          ★ Mesen は 0(何か書くまで無音)。ただし Mesen の 0 は「状態を 0 で埋めただけ」で、実機のリセット値を測った物ではなさそう(推定)。
 *          手元の HES 357 曲のうち、$0801 を一度も書かずに鳴らす曲が 3 曲(1 本)、鳴らす ch の $0805 を一度も書かない曲が 5 曲ある。
 *          HES はゲームの初期化を通らずに曲の INIT から始まるので、0 にするとこれらが無音になる。実機のリセット値は未確認
 *   ★ 出力の中心: Mesen は設定「HuC6280A の音」が入の時、波形の値から 16 を引いて -16〜+15 として扱い、切の時は 0〜31 のまま扱う。
 *      LFO が足す「ch2 の出力」もこの値なので、設定で LFO の掛かり方まで変わる。ここは入(-16〜+15)の側に合わせた。
 *      初代の石(HuC6280)と後の石(HuC6280A)で LFO が本当に違うのかは未確認
 *   ★ ノイズの最初の 1 歩: Mesen はノイズのタイマが 0 から始まり、「最初に時間を進めた時」に 1 歩目を踏む(それがいつかは、
 *      最初の書き込みか最初の画面の終わりで決まる)。実機は電源投入から回り続けるはずなので、乱数の位相はここで実機とずれうる。
 *      照合のために Mesen と同じにしてある(音としては聞き分けられない差)
 *   ★ 「今の出力」が古いままになる瞬間: Mesen は ch の出力を「時間を進めた時」に作り直す。書き込みで ch を切った直後などは、
 *      次に時間が進むまで前の値が残る。LFO はこの値を読むので、照合のために同じ作りにした(_oneChunk)。
 *      音に出す時は、切の ch は 0 として扱う(level())
 *   [推定] 音の大きさの基準(6ch ぶんを 16×6 で割る)は作り直し前のまま。ほかの形式との音量合わせで決めた値で、実機の電圧ではない
 * 確かめ方: tools/headless/pce-apu-ab.js(書き込みのたびの内部状態を Mesen と比べる)。音量と左右の混ぜ方は VGMPlay の WAV と比べる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const WAVE_LEN = 32;
  const CH_COUNT = 6;
  const CENTER = 16;        // 出力の中心(★ 冒頭)
  const MUTE_STEPS = 30;    // 1.5dB × 30 = 45dB で無音

  // 減衰の表(1.5dB 刻み)。添字 = 減衰の段数
  const GAIN = new Float64Array(MUTE_STEPS + 1);
  for (let r = 0; r < MUTE_STEPS; r++) GAIN[r] = Math.pow(10, -1.5 * r / 20);

  class WaveChannel {
    constructor(index, chip) {
      this.index = index;
      this.chip = chip;
      this.hasNoise = index >= 4;
      this.wave = new Uint8Array(WAVE_LEN);
      this.reset();
    }

    reset() {
      this.wave.fill(0);
      this.wavePos = 0;    // 読み位置(ch が切の間は書き位置でもある)
      this.freq = 0;       // $0802/$0803: 12bit の周期
      this.control = 0;    // $0804: bit7 = 入、bit6 = DDA、bit4-0 = 音量
      this.balance = 0xFF; // $0805: 上位 = 左、下位 = 右(リセット値は冒頭 [推定])
      this.dac = 0;        // DDA の出力値(0-31)
      this.noiseCtrl = 0;  // $0807(ch5/6 だけ): bit7 = ノイズ、bit4-0 = 周期
      this.timer = 0;      // 周期タイマの残り
      this.out = 0;        // 今の出力(-16〜+15。切なら 0)。★ 冒頭「古いままになる瞬間」
      this.lfsr = 1;
      this.noiseTimer = 0;
      this.noiseOut = 0;   // 0 か 31
      this.accL = 0;       // 出力 × 左の減衰 × 時間 の積算(mixSample が平均を取って 0 に戻す)
      this.accR = 0;
    }

    get on() { return (this.control & 0x80) !== 0; }
    get dda() { return (this.control & 0x40) !== 0; }
    get volume() { return this.control & 0x1F; }
    get noiseOn() { return this.hasNoise && (this.noiseCtrl & 0x80) !== 0; }

    /** 音に出す値。切の ch は 0 */
    level() { return (this.control & 0x80) ? this.out : 0; }

    /** 次の周回の長さ */
    period() {
      const chip = this.chip;
      let p = this.freq;
      if (this.index === 0 && chip.lfoOn) p = (p + (chip.ch[1].out << (((chip.lfoCtrl & 3) - 1) * 2))) & 0xFFF;
      if (p === 0) p = 0x1000;
      if (this.index === 1 && chip.lfoOn) p *= (chip.lfoFreq || 0x100);
      return p;
    }

    noisePeriod() {
      const f = this.noiseCtrl & 0x1F;
      return f === 0x1F ? 32 : ((~f) & 0x1F) * 64;
    }

    stepNoise() {
      const v = this.lfsr;
      const bit = (v ^ (v >>> 1) ^ (v >>> 11) ^ (v >>> 12) ^ (v >>> 17)) & 1;
      this.noiseOut = (v & 1) ? 31 : 0;
      this.lfsr = (v >>> 1) | (bit << 17);
    }

    write(reg, value) {
      switch (reg) {
        case 2: this.freq = (this.freq & 0xF00) | value; return;
        case 3: this.freq = (this.freq & 0x0FF) | ((value & 0x0F) << 8); return;
        case 4: {
          const now = (value & 0x80) !== 0;
          if (now !== this.on) this.timer = this.period();
          this.control = value;
          if (value & 0x40) { if (now) this.out = this.dac - CENTER; else this.wavePos = 0; }
          return;
        }
        case 5: this.balance = value; return;
        case 6:
          if (this.dda) {
            this.dac = value & 0x1F;
            if (this.on) this.out = this.dac - CENTER;
          } else {
            this.wave[this.wavePos] = value & 0x1F;
            if (!this.on) this.wavePos = (this.wavePos + 1) & (WAVE_LEN - 1);
            if (!this.noiseOn) this.out = this.wave[this.wavePos] - CENTER;
          }
          return;
        default: return;
      }
    }

    // ── 素直な道(Mesen と同じ刻み)。LFO が掛かっている間と、ノイズの最初の 1 歩に使う ──

    /** この ch が「次に何かが起きるまで」の残り。0 は「待つ物が無い」。型の幅(16bit)も Mesen と同じ */
    pending() {
      const t = this.hasNoise ? this.noiseTimer : 0;
      // 16bit に切って 0 になる値(65536 の倍数)は、Mesen では「待つ物が無い」扱いになる。Mesen は 1 回に 1 画面ぶんしか進めないので
      // それで飛び越さないが、こちらは書き込みの間を一度に進めることがあるので、65535 で区切る
      if (this.on && !this.dda && (t === 0 || this.timer < t)) return this.timer > 0 ? ((this.timer & 0xFFFF) || 0xFFFF) : 1;
      return t & 0xFFFF;
    }

    chunk(m) {
      if (this.hasNoise) {
        if (this.noiseTimer <= m) { this.noiseTimer = this.noisePeriod(); this.stepNoise(); }
        else this.noiseTimer -= m;
      }
      if (!this.on) { this.out = 0; return; }
      if (this.dda) { this.out = this.dac - CENTER; return; }
      if (this.noiseOn) { this.out = this.noiseOut - CENTER; return; }
      this.timer -= m;
      if (this.timer <= 0) { this.timer = this.period(); this.wavePos = (this.wavePos + 1) & (WAVE_LEN - 1); }
      this.out = this.wave[this.wavePos] - CENTER;
    }

    // ── 速い道: LFO が掛かっていなければ ch どうしは無関係なので、ch ごとに n 個ぶんを一度に進める ──
    // 結果(タイマ、読み位置、乱数、出力)は素直な道と同じになる(pce-apu-ab.js --selfcheck で確かめる)。

    fast(n) {
      const a = this._advance(n);
      if (a !== 0) { const bal = this.chip.balance; this.accL += a * GAIN[this.steps(bal, true)]; this.accR += a * GAIN[this.steps(bal, false)]; }
    }

    /** n 個ぶん進めて、その間の「出力 × 時間」の合計を返す */
    _advance(n) {
      let acc = 0;
      const audible = this.on;
      if (this.hasNoise) {
        const noisy = audible && !this.dda && this.noiseOn;
        let left = n, lv = this.out;
        while (left >= this.noiseTimer) {
          if (noisy) acc += lv * this.noiseTimer;
          left -= this.noiseTimer;
          this.noiseTimer = this.noisePeriod();
          this.stepNoise();
          lv = this.noiseOut - CENTER;
        }
        this.noiseTimer -= left;
        if (noisy) { acc += lv * left; this.out = this.noiseOut - CENTER; return acc; }
      }
      if (!audible) { this.out = 0; return 0; }
      if (this.dda) { acc = this.out * n; this.out = this.dac - CENTER; return acc; }
      // 波形
      const wave = this.wave;
      if (this.timer <= 0) this.timer = 1;
      if (n < this.timer) {
        acc += this.out * n;
        this.timer -= n;
      } else {
        acc += this.out * this.timer;
        const rem = n - this.timer;
        const P = this.period();
        const steps = Math.floor(rem / P);
        const r = rem - steps * P;
        let pos = (this.wavePos + 1) & (WAVE_LEN - 1);
        if (steps > 0) {
          // pos から steps 個ぶんを P ずつ鳴らした合計。32 個で一周するので、一周ぶんはまとめる
          let sum = 0;
          const full = Math.floor(steps / WAVE_LEN), part = steps - full * WAVE_LEN;
          if (full > 0) { let total = 0; for (let k = 0; k < WAVE_LEN; k++) total += wave[k]; sum += full * (total - WAVE_LEN * CENTER); }
          for (let k = 0; k < part; k++) sum += wave[(pos + k) & (WAVE_LEN - 1)] - CENTER;
          acc += sum * P;
          pos = (pos + part) & (WAVE_LEN - 1);
        }
        acc += (wave[pos] - CENTER) * r;
        this.wavePos = pos;
        this.timer = P - r;
      }
      this.out = wave[this.wavePos] - CENTER;
      return acc;
    }

    /** 左右の減衰の段数(0 = 最大)。MUTE_STEPS 以上は無音 */
    steps(globalBalance, left) {
      const g = left ? (globalBalance >> 4) & 0x0F : globalBalance & 0x0F;
      const p = left ? (this.balance >> 4) & 0x0F : this.balance & 0x0F;
      const r = (15 - g) * 2 + (31 - (this.control & 0x1F)) + (15 - p) * 2;
      return r < MUTE_STEPS ? r : MUTE_STEPS;
    }

    /** 左右の実効ゲイン(0.0-1.0) */
    gainLR(globalBalance) {
      return { left: GAIN[this.steps(globalBalance, true)], right: GAIN[this.steps(globalBalance, false)] };
    }
  }

  class APUHuC6280 {
    constructor() {
      this.ch = [];
      for (let i = 0; i < CH_COUNT; i++) this.ch.push(new WaveChannel(i, this));
      this.mute = { ch0: false, ch1: false, ch2: false, ch3: false, ch4: false, ch5: false };
      this.vol = { ch0: 1, ch1: 1, ch2: 1, ch3: 1, ch4: 1, ch5: 1 };
      this.forceChunked = false; // true にすると、いつも素直な道で進める(速い道との突き合わせ用)
      this.reset();
    }

    reset() {
      for (const c of this.ch) c.reset();
      this.selected = 0;   // $0800: 操作する ch(3bit。6・7 は無い ch)
      this.balance = 0xFF; // $0801: 全体の左右の音量(リセット値は冒頭 [推定])
      this.lfoFreq = 0;    // $0808
      this.lfoCtrl = 0;    // $0809
      this.ticks = 0;      // 進めた音源クロックの通算
      this.accTicks = 0;   // mixSample が前に呼ばれてからの個数
    }

    get lfoOn() { return (this.lfoCtrl & 0x80) === 0 && (this.lfoCtrl & 0x03) !== 0; }

    /** 番地は $0800-$0809(下位 4bit だけ見る) */
    writeRegister(addr, value) {
      value &= 0xFF;
      const reg = addr & 0x0F;
      switch (reg) {
        case 0: this.selected = value & 0x07; return;
        case 1: this.balance = value; return;
        case 2: case 3: case 4: case 5: case 6:
          if (this.selected < CH_COUNT) this.ch[this.selected].write(reg, value);
          return;
        case 7:
          if (this.selected === 4 || this.selected === 5) this.ch[this.selected].noiseCtrl = value;
          return;
        case 8: this.lfoFreq = value; return;
        case 9: this.lfoCtrl = value; return;
        default: return;
      }
    }

    /** 音源は読めない(バス側が I/O バッファを返す) */
    readRegister(addr) { return 0; }

    // 素直な道の 1 区切り: 「どれかの ch で何かが起きる所」まで全 ch をまとめて進める。進めた後の残りを返す
    _oneChunk(n) {
      const ch = this.ch;
      let m = n;
      for (let i = 0; i < CH_COUNT; i++) { const t = ch[i].pending(); if (t !== 0 && t < m) m = t; }
      const bal = this.balance;
      for (let i = 0; i < CH_COUNT; i++) { const c = ch[i], a = c.level() * m; if (a !== 0) { c.accL += a * GAIN[c.steps(bal, true)]; c.accR += a * GAIN[c.steps(bal, false)]; } }
      for (let i = 0; i < CH_COUNT; i++) ch[i].chunk(m); // ch1 から順に。ch1 の周期は「まだ進めていない ch2」の出力を読む
      return n - m;
    }

    /** 音源クロック n 個ぶん進める */
    clockBy(n) {
      if (n <= 0) return;
      this.ticks += n;
      this.accTicks += n;
      const ch = this.ch;
      // ノイズのタイマが 0(電源投入直後)の間は素直な道で(★ 冒頭「ノイズの最初の 1 歩」)
      while (n > 0 && (this.forceChunked || this.lfoOn || ch[4].noiseTimer === 0 || ch[5].noiseTimer === 0)) n = this._oneChunk(n);
      if (n > 0) for (let i = 0; i < CH_COUNT; i++) ch[i].fast(n);
    }

    clock() { this.clockBy(1); }

    /** マスタークロックの時刻(電源投入からの通算)まで進める */
    runToMaster(masterClock) {
      const t = Math.floor(masterClock / 6);
      if (t > this.ticks) this.clockBy(t - this.ticks);
    }

    /**
     * 前に呼んでから今までの平均の出力を {left, right}(概ね -1.0〜1.0)で返す。時間が進んでいなければ今の値。
     * 6ch を足して 16×6 で割る(冒頭 [推定])。
     */
    mixSample() {
      const t = this.accTicks, bal = this.balance;
      let sumL = 0, sumR = 0;
      for (let i = 0; i < CH_COUNT; i++) {
        const c = this.ch[i];
        let l, r;
        if (t > 0) { l = c.accL / t; r = c.accR / t; } else { const v = c.level(); l = v * GAIN[c.steps(bal, true)]; r = v * GAIN[c.steps(bal, false)]; }
        c.accL = 0; c.accR = 0;
        if (this.mute['ch' + i]) continue;
        const k = this.vol['ch' + i];
        sumL += l * k;
        sumR += r * k;
      }
      this.accTicks = 0;
      return { left: sumL / (16 * CH_COUNT), right: sumR / (16 * CH_COUNT) };
    }

    /**
     * mixSample と同じ基準で、ch ごとの値(左右の平均)を配列で返す。ミュートは見ない
     * (hes-stream-player.js の HesBufferedPlayer が、録った後で ch ごとに切り替えられるようにするため)。
     */
    mixChannelSamples() {
      const t = this.accTicks, bal = this.balance;
      const result = new Array(CH_COUNT);
      for (let i = 0; i < CH_COUNT; i++) {
        const c = this.ch[i];
        const lr = t > 0 ? (c.accL + c.accR) / t : c.level() * (GAIN[c.steps(bal, true)] + GAIN[c.steps(bal, false)]);
        c.accL = 0; c.accR = 0;
        result[i] = (lr * 0.5) / (16 * CH_COUNT);
      }
      this.accTicks = 0;
      return result;
    }
  }

  // 鍵盤表示/ロール用のライブの写し。panL/panR は $0805 の上位/下位。
  // 配列そのものに globalPanL/globalPanR($0801)と lfoFreq/lfoCtrl($0808/$0809)を生やす(ch 単位ではないため)。
  // ★ LFO が掛かっている間、ch1 の freq は周期レジスタから出した値で、揺れは入っていない
  // ★ 周期レジスタが 0 の ch は音源の中では周期 $1000(約 27Hz)で回るが、ここでは従来どおり「鳴っていない」として返す(変換側 wave.js も同じ)
  Emu.snapshotHuC6280Apu = function (apu) {
    const arr = apu.ch.map((c, i) => {
      const freqHz = (c.on && !c.dda && c.freq > 0) ? MML.HES.PSG_CLOCK / (32 * c.freq) : 0;
      const noiseOn = c.noiseOn && c.on;
      return {
        on: c.on, dda: c.dda, noiseOn,
        freq: freqHz, vol: c.volume / 31, rawVol: c.volume,
        wave: Array.from(c.wave, v => v / 15.5 - 1),
        active: c.on && c.volume > 0 && (c.dda || noiseOn || freqHz > 0),
        panL: (c.balance >> 4) & 0x0F, panR: c.balance & 0x0F
      };
    });
    arr.globalPanL = (apu.balance >> 4) & 0x0F;
    arr.globalPanR = apu.balance & 0x0F;
    arr.lfoFreq = apu.lfoFreq;
    arr.lfoCtrl = apu.lfoCtrl;
    return arr;
  };

  Emu.APUHuC6280 = APUHuC6280;
  Emu.APUHuC6280_CH_COUNT = CH_COUNT;
  Emu.APUHuC6280_WAVE_LEN = WAVE_LEN;
})(window);
