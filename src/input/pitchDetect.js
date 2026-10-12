/*
 * 単旋律のピッチ検出 (MML.Input.PitchDetect) — コア層
 *
 * 聴音(鼻歌・口笛・楽器の単音 → MML、src/ui/dictationPanel.js)の最初の段。
 * PCM(Float32、モノラル)を 5ms 刻みのフレーム列 { t, f, conf, rms, rmsShort } にする。
 * f は基本周波数(Hz)、無声/無音なら null。
 *
 * ■ 方式: YIN(de Cheveigné & Kawahara 2002)
 *   差分関数 d(τ) → 累積平均正規化 d'(τ) → しきい値を最初に割った谷 → 放物線補間。
 *   2026-10-12 の合成テスト(鼻歌 144 件・楽器 14 件)で、2倍音が基音より強い音色でも
 *   オクターブ誤りが 0 だったので採用。MPM(McLeod)は口笛で 12〜15 件のオクターブ誤りが出た。
 *   処理は 24kHz・窓 25ms・刻み 5ms で実時間の 2〜4%(メインスレッドで足りる)。
 *
 * ■ サンプルレート
 *   32kHz を超える入力は 1/2 に間引いてから解く(4点の簡易ローパス)。音程の分解能は
 *   放物線補間で 0.1 サンプル程度=500Hz で 4 セント。窓は 25ms なので下限 70Hz(周期 14ms)
 *   までは窓内に 1.7 周期入る。楽器(ベース)で 40Hz まで下げるときは窓も自動で伸ばす。
 *
 * ■ 2つの RMS
 *   rms は検出窓(25ms)の音量、rmsShort は窓中央の 10ms の音量。同音連打の「谷」と
 *   撥弦の「立ち上がり」は 10ms の方でないと 25ms 窓の揺らぎに埋もれる(noteSegment.js)。
 *
 * DOM 非依存・デバイス非依存。tools/headless/dictation-bench.js が合成音で回帰を取る。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  const DEFAULTS = Object.freeze({
    fmin: 70,              // Hz。声は 70、楽器(ベース)は 40
    fmax: 1100,            // Hz
    winSec: 0.025,         // 検出窓。fmin が低いときは 1.7 周期ぶんまで自動で伸ばす
    hopSec: 0.005,         // フレーム間隔
    threshold: 0.15,       // YIN の絶対しきい値(小さいほど厳密=無声が増える)
    maxAperiodicity: 0.35, // d'(τ) がこれ以上なら無声扱い(雑音・息)
    gateDb: -45,           // これより小さい音量(dBFS)は無音
    shortWinSec: 0.01      // rmsShort の窓
  });

  const toMidi = (f) => 69 + 12 * Math.log2(f / 440);

  function decimate2(x) {
    const n = x.length >> 1, y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = x[2 * i - 1] || 0, b = x[2 * i], c = x[2 * i + 1] || 0, d = x[2 * i + 2] || 0;
      y[i] = 0.125 * a + 0.375 * b + 0.375 * c + 0.125 * d;
    }
    return y;
  }

  function rmsDb(x, off, n) {
    let s = 0;
    for (let i = 0; i < n; i++) { const v = x[off + i]; s += v * v; }
    return 20 * Math.log10(Math.sqrt(s / n) + 1e-9);
  }

  function parabolic(arr, i) {
    if (i <= 0 || i >= arr.length - 1) return i;
    const a = arr[i - 1], b = arr[i], c = arr[i + 1], den = a - 2 * b + c;
    return den === 0 ? i : i + 0.5 * (a - c) / den;
  }

  /*
   * YIN 1フレーム。x[off .. off+W+tauMax) を使う。
   * work: { d: Float64Array(tauMax+1), cm: Float64Array(tauMax+1) } 再利用用(省略可)
   * 戻り値 { tau(小数サンプル), aper(d' の値。0 が完全周期) }
   */
  function yinFrame(x, off, W, tauMin, tauMax, threshold, work) {
    const d  = (work && work.d)  || new Float64Array(tauMax + 1);
    const cm = (work && work.cm) || new Float64Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const diff = x[off + j] - x[off + j + tau]; s += diff * diff; }
      d[tau] = s;
    }
    cm[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cm[t] < threshold) {
        while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) { // しきい値を割らない: 最小の谷(低信頼)
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (cm[t] < cm[best]) best = t;
      tau = best;
    }
    return { tau: parabolic(cm, tau), aper: Math.max(0, cm[tau]) };
  }

  /* 解析パラメータの具体値(サンプル数)を決める */
  function plan(sampleRate, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const fmin = Math.max(20, o.fmin), fmax = Math.max(fmin * 2, o.fmax);
    // 下限の 1.7 周期が窓に入るよう伸ばす(ベース 40Hz → 42ms)
    const winSec = Math.max(o.winSec, 1.7 / fmin);
    const W = Math.round(winSec * sampleRate);
    const hop = Math.max(1, Math.round(o.hopSec * sampleRate));
    const tauMin = Math.max(2, Math.floor(sampleRate / fmax));
    const tauMax = Math.min(W, Math.ceil(sampleRate / fmin));
    const Ws = Math.max(8, Math.round(o.shortWinSec * sampleRate));
    return { o, W, hop, tauMin, tauMax, Ws, need: W + tauMax + 1 };
  }

  function frameAt(x, off, sampleRate, P, work) {
    const db = rmsDb(x, off, P.W);
    let f = null, conf = 0;
    if (db > P.o.gateDb) {
      const r = yinFrame(x, off, P.W, P.tauMin, P.tauMax, P.o.threshold, work);
      conf = 1 - r.aper;
      if (r.aper < P.o.maxAperiodicity && r.tau > 0) f = sampleRate / r.tau;
    }
    const offS = off + ((P.W - P.Ws) >> 1);
    return { t: (off + P.W / 2) / sampleRate, f, conf, rms: db, rmsShort: rmsDb(x, offS, P.Ws) };
  }

  /*
   * ストリーミング用トラッカー。push() した PCM を全部保持し(=テイク)、
   * 窓が揃ったフレームから順に返す。保持した PCM は analyze() で設定を変えて解き直せる。
   */
  class Tracker {
    constructor(sampleRate, opts) {
      this.inputRate = sampleRate;
      this.decim = sampleRate > 32000 ? 2 : 1;
      this.sampleRate = sampleRate / this.decim;
      this.opts = Object.assign({}, DEFAULTS, opts || {});
      this.P = plan(this.sampleRate, this.opts);
      this.work = { d: new Float64Array(this.P.tauMax + 1), cm: new Float64Array(this.P.tauMax + 1) };
      this.buf = new Float32Array(this.sampleRate * 30); // 30秒ぶんから倍々で伸ばす
      this.len = 0;
      this.pos = 0;        // 次に解くフレームの先頭
      this.carry = null;   // 間引きの端数(1サンプル)
      this.frames = [];
    }
    /* block: Float32Array(入力レートのサンプル)。新しく確定したフレームの配列を返す */
    push(block) {
      let src = block;
      if (this.decim === 2) {
        if (this.carry != null) { const b = new Float32Array(block.length + 1); b[0] = this.carry; b.set(block, 1); src = b; this.carry = null; }
        if (src.length & 1) { this.carry = src[src.length - 1]; src = src.subarray(0, src.length - 1); }
        src = decimate2(src);
      }
      if (this.len + src.length > this.buf.length) {
        const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + src.length));
        nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
      }
      this.buf.set(src, this.len); this.len += src.length;
      const out = [];
      while (this.pos + this.P.need <= this.len) {
        const fr = frameAt(this.buf, this.pos, this.sampleRate, this.P, this.work);
        this.frames.push(fr); out.push(fr);
        this.pos += this.P.hop;
      }
      return out;
    }
    durationSec() { return this.len / this.sampleRate; }
    /* 保持している PCM(間引き後、sampleRate は this.sampleRate) */
    samples() { return this.buf.slice(0, this.len); }
    /* 最新フレーム(ライブ表示用) */
    latest() { return this.frames.length ? this.frames[this.frames.length - 1] : null; }
    /* 入力の音量(dBFS)。ゲート判定と同じ尺度 */
    levelDb() { const fr = this.latest(); return fr ? fr.rms : -120; }
  }

  /*
   * オフライン解析。x: Float32Array、sampleRate: その実レート。
   * 戻り値 { frames, sampleRate(解析レート), samples(間引き後の PCM) }
   */
  function analyze(x, sampleRate, opts) {
    let s = x, sr = sampleRate;
    if (sr > 32000) { s = decimate2(x); sr /= 2; }
    const P = plan(sr, opts);
    const work = { d: new Float64Array(P.tauMax + 1), cm: new Float64Array(P.tauMax + 1) };
    const frames = [];
    for (let off = 0; off + P.need <= s.length; off += P.hop) frames.push(frameAt(s, off, sr, P, work));
    return { frames, sampleRate: sr, samples: s };
  }

  Input.PitchDetect = { DEFAULTS, toMidi, decimate2, yinFrame, analyze, Tracker, plan };

})(window);
