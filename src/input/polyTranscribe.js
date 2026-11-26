/*
 * 混ざった音の採譜 (MML.Input.PolyTranscribe) — コア層
 *
 * 伴奏入りの音(曲の WAV/MP3、または外で分けたステム)から、MML にできる音符列を取り出す。
 * 単旋律の聴音(pitchDetect.js / noteSegment.js)の隣に置く「複数の音が同時に鳴っている場合」の段。
 *
 * ■ 3 つの取り出し方(2026-11-26 の実測で決めた組み合わせ。_tmp_test/wav2mml/ の検証スクリプト参照)
 *   1. multiPitch  … 多重音。24kHz・窓 2048(85ms)・1/60 秒刻みの振幅スペクトルを、音高ごとの倍音テンプレート
 *                     (全倍音 1/h・奇数倍音 1/h・奇数倍音 1/h²・全倍音 1/h²)の和で説明する固定辞書 NMF(KL)。
 *                     2 声以上が混ざると YIN は使えない(「250Hz 以上を YIN」は再現 0〜21%)ので、旋律はこれで取る。
 *   2. bassBand    … 低音。遮断周波数より下だけ残して単音検出(YIN)にかける。帯域で切るだけで三角波ベースは
 *                     再現 93〜100% になる。ただしベースが遮断より上へ動く曲は取りこぼすので、遮断は multiPitch の
 *                     最低声部の音域から決める(suggestBassCutoff)。
 *   3. drumOnsets  … 打点。スペクトルの立ち上がりを拾い、重心で 3 種に分ける。音程楽器の強い発音も拾うことがある
 *                     (感度 drumSensitivity で調整)。
 *
 * ■ 分けて入ってきた音(ステム)はそのまま使う
 *   外のツールで分けた bass は bassBand(遮断を上げる)か単音検出へ、other は multiPitch へ、drums は drumOnsets へ。
 *   分離そのものはここでは持たない(分離の重みは配れない・重い)。
 *
 * ■ 限界(実測)
 *   内声(2 声目以降)は不安定。外れの大半はオクターブ違い。サンプル音源の曲は混ざったままだと音符の一致が
 *   2〜4 割まで落ちる。結果は「編曲の出発点」で、手直しが前提。
 *
 * DOM 非依存。tools/headless/wav2mml-bench.js が自作曲(正解つき)で回帰を取る。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  const SR = 24000, WIN = 2048, NFFT = 4096, FB = 1024, FPS = 60, HOP = SR / FPS;
  const MIDI_LO = 28, MIDI_HI = 100, NP = MIDI_HI - MIDI_LO + 1;
  const ENVELOPES = [h => 1 / h, h => (h & 1) ? 1 / h : 0, h => (h & 1) ? 1 / (h * h) : 0, h => 1 / (h * h)];
  const NE = ENVELOPES.length, K = NP * NE;

  const DEFAULTS = Object.freeze({
    iterations: 30,      // NMF の反復回数
    threshold: 0.3,      // 全体の基準(活性の 99 パーセンタイル)に対する音符のしきい値。小さいほど弱い音も拾う
    frameRel: 0.2,       // その瞬間の最大に対するしきい値。小さいほど同時に鳴る弱い声部を拾う
    minFrames: 4,        // これ未満(1/60 秒単位)の音符は捨てる(3 だと打点の瞬間のにじみが音符になる)
    ghostRatio: 0.5,     // 倍音の位置(+12/+19/+24)で下の音が鳴っている間だけ立つ音が、下の音のこの倍率未満なら倍音の影として捨てる。0 で切る
    reattack: 1.7,       // 同音連打: いったん落ちてからこの倍率以上に立ち上がったら切る
    bassCutoffHz: 250,   // 低音の遮断。suggestBassCutoff が曲から決める
    bassFminHz: 35,
    bassSplitMidi: 52,   // 声部分け: 最低声部のうちこれ未満の音は旋律の候補から外す
    melodyJump: 0.3,     // 旋律: 1 オクターブの跳躍の罰(中くらいの音量の音が何秒鳴ったぶんに当たるか)。大きいほど跳ばない
    melodyHigh: 1.2,     // 旋律: 1 オクターブ高いごとに得点を何割増すか(同じ長さ・音量なら上の声部を選ぶ)
    drumSensitivity: 2,  // 打点: 周りの中央値の何倍で打点とみなすか。小さいほど拾う
    drumFlatness: 0      // 打点: 立ち上がりが広い帯域に及ぶ度合いの下限(0〜1)。★既定は切る: 矩形波の発音も広い帯域に
                         //   立ち上がるので、自作曲では正解(中央 0.95)と誤検出(0.86〜0.96)を分けられなかった。生楽器の曲用に残す
  });

  // ---- 下ごしらえ ---------------------------------------------------------

  /* 任意のレートのモノラル PCM を 24kHz へ(窓つき sinc)。 */
  function toMono24k(x, sampleRate) {
    if (sampleRate === SR) return x;
    const ratio = sampleRate / SR, cut = Math.min(1, SR / sampleRate) * 0.92, half = 12;
    const n = Math.floor(x.length / ratio), y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio, c = Math.floor(p);
      let a = 0, wsum = 0;
      for (let k = c - half + 1; k <= c + half; k++) {
        if (k < 0 || k >= x.length) continue;
        const d = k - p, t = d * cut;
        const s = Math.abs(t) < 1e-6 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const w = 0.5 + 0.5 * Math.cos(Math.PI * d / half);
        const g = s * w; a += x[k] * g; wsum += g;
      }
      y[i] = wsum ? a / wsum : 0;
    }
    return y;
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  function median(buf, n) {
    const a = Array.prototype.slice.call(buf, 0, n).sort((p, q) => p - q);
    return a.length ? a[a.length >> 1] : 0;
  }

  // ---- 辞書(初回だけ作る)---------------------------------------------------

  let dict = null, hann = null;
  function dictionary() {
    if (dict) return dict;
    const BINHZ = SR / NFFT, idxs = [], vals = [];
    // ハン窓の主ローブ(ゼロ詰め 2 倍の bin 単位)
    const lobe = (d) => {
      const x = Math.abs(d) * WIN / NFFT;
      if (x >= 2) return 0;
      if (x < 1e-6) return 1;
      if (Math.abs(x - 1) < 1e-6) return 0.5;
      return Math.abs(Math.sin(Math.PI * x) / (Math.PI * x) / (1 - x * x));
    };
    const tmp = new Float32Array(FB);
    for (let p = 0; p < NP; p++) for (let e = 0; e < NE; e++) {
      const f0 = 440 * Math.pow(2, (p + MIDI_LO - 69) / 12);
      tmp.fill(0);
      for (let h = 1; h <= 24; h++) {
        const a = ENVELOPES[e](h); if (!a) continue;
        const fc = f0 * h; if (fc > 5800) break;
        const kc = fc / BINHZ, spread = kc * (Math.pow(2, 25 / 1200) - 1); // ±25 セントの音程ずれを許す
        for (let k = Math.max(1, Math.floor(kc - spread - 4)); k <= Math.min(FB - 1, Math.ceil(kc + spread + 4)); k++) {
          const d = Math.abs(k - kc), v = a * lobe(d <= spread ? 0 : d - spread);
          if (v > tmp[k]) tmp[k] = v;
        }
      }
      let s = 0; for (let k = 0; k < FB; k++) s += tmp[k];
      const ix = [], vl = [];
      for (let k = 0; k < FB; k++) if (tmp[k] > 1e-4) { ix.push(k); vl.push(tmp[k] / s); }
      idxs.push(Int32Array.from(ix)); vals.push(Float32Array.from(vl));
    }
    hann = new Float32Array(WIN);
    for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN);
    dict = { idxs, vals };
    return dict;
  }

  // ---- 1. 多重音 ----------------------------------------------------------

  /*
   * 音高ごとの活性(1/60 秒刻み)。戻り値 { P: Float32Array(T*NP), T, NP, midiLo, fps, offsetSec }。
   * 重い(Node で実時間の約 1/5)ので、UI からは step を小分けに呼ぶ multiPitchAsync を使う。
   */
  function createMultiPitch(x, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const D = dictionary(), T = Math.max(0, Math.floor((x.length - WIN) / HOP));
    const P = new Float32Array(T * NP);
    const re = new Float32Array(NFFT), im = new Float32Array(NFFT), v = new Float32Array(FB);
    const h = new Float32Array(K), est = new Float32Array(FB), ratio = new Float32Array(FB);
    let t = 0;
    return {
      T,
      get done() { return t >= T; },
      get progress() { return T ? t / T : 1; },
      step(maxFrames) {
        const end = Math.min(T, t + (maxFrames || T));
        for (; t < end; t++) {
          re.fill(0); im.fill(0);
          const off = Math.round(t * HOP);
          for (let i = 0; i < WIN; i++) re[i] = x[off + i] * hann[i];
          fft(re, im);
          let tot = 0;
          for (let k = 0; k < FB; k++) { v[k] = Math.hypot(re[k], im[k]); tot += v[k]; }
          if (tot < 1e-3) continue;
          h.fill(tot / K);
          for (let it = 0; it < o.iterations; it++) {
            est.fill(1e-9);
            for (let j = 0; j < K; j++) {
              const hj = h[j]; if (hj < 1e-9) continue;
              const ix = D.idxs[j], vl = D.vals[j];
              for (let q = 0; q < ix.length; q++) est[ix[q]] += hj * vl[q];
            }
            for (let k = 0; k < FB; k++) ratio[k] = v[k] / est[k];
            for (let j = 0; j < K; j++) {
              const hj = h[j]; if (hj < 1e-9) { h[j] = 0; continue; }
              const ix = D.idxs[j], vl = D.vals[j];
              let a = 0;
              for (let q = 0; q < ix.length; q++) a += ratio[ix[q]] * vl[q];
              h[j] = hj * a;
            }
          }
          for (let p = 0; p < NP; p++) { let a = 0; for (let e = 0; e < NE; e++) a += h[p * NE + e]; P[t * NP + p] = a; }
        }
        return t >= T;
      },
      // offsetSec: フレーム t の時刻は窓の中心で数える(曲中の発音は実測でこれが合う)。
      // ★曲の頭の音だけは窓が 0 秒より前へ出られないので 40ms ほど遅れて出る(ずらして合わせようとしない)
      result() { return { P, T, NP, midiLo: MIDI_LO, fps: FPS, offsetSec: (WIN / 2) / SR }; }
    };
  }

  function multiPitch(x, opts) { const job = createMultiPitch(x, opts); job.step(); return job.result(); }

  /* yieldFn(progress) を挟みながら解く。yieldFn は Promise を返してよい(UI に描画の機会を渡す) */
  async function multiPitchAsync(x, opts, yieldFn) {
    const job = createMultiPitch(x, opts);
    while (!job.step(30)) { if (yieldFn) await yieldFn(job.progress); }
    return job.result();
  }

  /* 活性 → 音符 [{ midi, startSec, endSec, amp }](発音順) */
  function notes(act, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const { P, T } = act, off = act.offsetSec;
    const pos = []; for (let i = 0; i < P.length; i++) if (P[i] > 0) pos.push(P[i]);
    pos.sort((a, b) => a - b);
    const base = pos.length ? pos[Math.floor(pos.length * 0.99)] : 1, thr = base * o.threshold;
    const fmax = new Float32Array(T);
    for (let t = 0; t < T; t++) { let m = 0; for (let p = 0; p < NP; p++) if (P[t * NP + p] > m) m = P[t * NP + p]; fmax[t] = m; }
    const out = [];
    const push = (p, on, end, sum) => { if (end - on >= o.minFrames) out.push({ midi: p + MIDI_LO, startSec: on / FPS + off, endSec: end / FPS + off, amp: sum / (end - on), f0: on, f1: end }); };
    // p=0(いちばん下のテンプレート)は受け皿: 打点の雑音や音域外の低い成分がここへ集まるので音符にしない
    for (let p = 1; p < NP; p++) {
      let on = -1, peak = 0, lo = 0, gap = 0, sum = 0;
      for (let t = 0; t <= T; t++) {
        const q = t < T ? P[t * NP + p] : 0;
        // 半音隣より大きい山だけ採る(隣の音高へのにじみを音符にしない)
        const act1 = t < T && q > thr && q > fmax[t] * o.frameRel
          && q >= (p > 0 ? P[t * NP + p - 1] : 0) && q >= (p < NP - 1 ? P[t * NP + p + 1] : 0);
        if (act1) {
          if (on < 0) { on = t; peak = q; lo = q; sum = 0; }
          else {
            if (q < lo) lo = q;
            if (o.reattack > 0 && q > lo * o.reattack && lo < peak * 0.6 && t - on >= o.minFrames) { push(p, on, t, sum); on = t; peak = q; lo = q; sum = 0; }
            if (q > peak) { peak = q; lo = q; }
          }
          sum += q; gap = 0;
        } else if (on >= 0) {
          if (++gap > 1) { push(p, on, t - gap + 1, sum); on = -1; gap = 0; }
        }
      }
    }
    // 倍音の影: 下の音と同時に立ち、音量が下の ghostRatio 倍に満たない上の音を捨てる
    let res = out;
    if (o.ghostRatio > 0) {
      const byMidi = new Map();
      for (const n of out) { if (!byMidi.has(n.midi)) byMidi.set(n.midi, []); byMidi.get(n.midi).push(n); }
      res = out.filter(n => {
        for (const d of [12, 19, 24]) {
          const lower = byMidi.get(n.midi - d); if (!lower) continue;
          for (const m of lower) {
            if (n.f0 >= m.f0 - 2 && n.f1 <= m.f1 + 2 && n.amp < m.amp * o.ghostRatio) return false;
          }
        }
        return true;
      });
    }
    return res.sort((a, b) => (a.startSec - b.startSec) || (a.midi - b.midi)).map(n => ({ midi: n.midi, startSec: n.startSec, endSec: n.endSec, amp: n.amp }));
  }

  /*
   * 音符の束を声部に分ける。{ melody, bass, inner }(どれも単音の列)。
   *   bass   … その瞬間いちばん下の音(最低声部)。低音の遮断を決める材料にも使う(suggestBassCutoff)
   *   melody … 旋律。重ならない音符の並びのうち「音量×長さ(高い音ほど少し有利)の合計 − 跳躍の罰」が最大のもの。
   *            ★「その瞬間いちばん上」(スカイライン)にしない理由: 1 オクターブ上に立つ倍音の影が旋律を乗っ取る
   *              (自作曲で再現 18〜84% まで落ちた)。旋律は順次進行が多いので、跳躍に罰を付けると影を拾わない
   *   inner  … 残りのうち、その瞬間いちばん上の音(2 声目。和音の中身は 1 本にしか入らない)
   */
  function voices(noteList, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const minSec = o.minFrames / FPS, JOIN = 0.06;
    const key = (n) => n.startSec + ':' + n.midi;
    const line = (cands, pickHigher) => {
      // 発音順に、今の音より「上(または下)」が来たら今の音を切って乗り換える。そうでない音は余りへ
      const lineOut = [], rest = [];
      let cur = null;
      for (const n of cands) {
        if (cur && n.startSec >= cur.endSec - 1e-9) cur = null;
        if (!cur) { cur = Object.assign({}, n); lineOut.push(cur); continue; }
        // 今の音がもうすぐ終わる(60ms 以内)なら、上下に関係なく次の音として受ける(音の継ぎ目の重なり)
        const wins = (pickHigher ? n.midi > cur.midi : n.midi < cur.midi) || (cur.endSec - n.startSec < JOIN);
        if (wins) { cur.endSec = n.startSec; cur = Object.assign({}, n); lineOut.push(cur); }
        else rest.push(n);
      }
      return { line: lineOut.filter(n => n.endSec - n.startSec >= minSec), rest };
    };
    const byStartLow = noteList.slice().sort((a, b) => (a.startSec - b.startSec) || (a.midi - b.midi));
    const bassLine = line(byStartLow, false).line;
    const bassKeys = new Set(bassLine.filter(n => n.midi < o.bassSplitMidi).map(key));

    // 旋律: 動的計画法。cand は発音順、best[i] = i で終わる並びの最大得点
    const cand = noteList.filter(n => !bassKeys.has(key(n))).sort((a, b) => (a.startSec - b.startSec) || (b.midi - a.midi));
    const amps = cand.map(n => n.amp || 1).sort((a, b) => a - b), medAmp = amps.length ? amps[amps.length >> 1] : 1;
    const jump = medAmp * o.melodyJump / 12;   // 1 オクターブの跳躍 = 中くらいの音量の melodyJump 秒ぶん
    const reward = (n) => (n.amp || 1) * (n.endSec - n.startSec) * (1 + o.melodyHigh * (n.midi - 60) / 12);
    const best = new Float64Array(cand.length), prev = new Int32Array(cand.length).fill(-1);
    let top = -1;
    for (let i = 0; i < cand.length; i++) {
      const n = cand[i]; let b = 0, bp = -1;
      for (let j = i - 1; j >= 0 && j >= i - 96; j--) {
        const m = cand[j];
        if (m.endSec - n.startSec >= JOIN || m.startSec >= n.startSec - 1e-9) continue;  // 重なる音は並べられない
        const v = best[j] - jump * Math.abs(n.midi - m.midi);
        if (v > b) { b = v; bp = j; }
      }
      best[i] = b + reward(n); prev[i] = bp;
      if (top < 0 || best[i] > best[top]) top = i;
    }
    const melody = [], used = new Set();
    for (let i = top; i >= 0; i = prev[i]) { melody.push(Object.assign({}, cand[i])); used.add(i); }
    melody.reverse();
    for (let i = 0; i + 1 < melody.length; i++) if (melody[i].endSec > melody[i + 1].startSec) melody[i].endSec = melody[i + 1].startSec;
    const rest = cand.filter((n, i) => !used.has(i));
    return { melody: melody.filter(n => n.endSec - n.startSec >= minSec), bass: bassLine, inner: line(rest, true).line };
  }

  // ---- 2. 低音 ------------------------------------------------------------

  /* 多重音の最低声部の音域から、低音の遮断周波数を決める(150〜700Hz)。材料が無ければ既定 */
  function suggestBassCutoff(bassNotes, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!bassNotes || bassNotes.length < 4) return o.bassCutoffHz;
    const ms = bassNotes.map(n => n.midi).sort((a, b) => a - b);
    // 最低声部はベースが休みの間に上の声部を拾うので、上側 2 割は見ない
    const hi = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.8))];
    const f = 440 * Math.pow(2, (hi - 69) / 12) * 1.5;
    return Math.max(150, Math.min(700, Math.round(f)));
  }

  /* 遮断より下だけ残して単音検出。戻り値は noteSegment.js と同じ形の音符列 */
  function bassBand(x24, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const PD = Input.PitchDetect, NS = Input.NoteSegment;
    // 1/8 に間引いて 3kHz に(4 段の 1 次ローパスで遮断)
    const R = 8, n = Math.floor(x24.length / R), y = new Float32Array(n);
    const a = Math.exp(-2 * Math.PI * o.bassCutoffHz / SR);
    const z = [0, 0, 0, 0];
    for (let i = 0, j = 0; i < x24.length; i++) {
      let s = x24[i];
      for (let k = 0; k < 4; k++) { z[k] = z[k] * a + s * (1 - a); s = z[k]; }
      if (i % R === R - 1 && j < n) y[j++] = s;
    }
    const sr = SR / R;
    const { frames } = PD.analyze(y, sr, { fmin: o.bassFminHz, fmax: Math.min(1100, o.bassCutoffHz * 1.1), gateDb: -50 });
    const seg = NS.segment(frames, Object.assign({}, NS.PRESETS.instrument.segment, { keySnap: false, midiMin: 24 }));
    return seg.notes.map(nn => ({ midi: nn.midi, startSec: nn.startSec, endSec: nn.endSec }));
  }

  // ---- 3. 打点 ------------------------------------------------------------

  /*
   * 打点 [{ timeSec, strength, centroidHz, kind:'kick'|'snare'|'hat' }]。
   * 立ち上がりの量が周りの中央値の drumSensitivity 倍を超え、かつ広い帯域に及ぶ(雑音らしい)ものだけ。
   */
  function drumOnsets(x24, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const N = 1024, H = 240, KB = N / 2 + 1, T = Math.max(0, Math.floor((x24.length - N) / H));
    const w = new Float32Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const re = new Float32Array(N), im = new Float32Array(N);
    let prev = new Float32Array(KB), cur = new Float32Array(KB);
    const flux = new Float32Array(T), flat = new Float32Array(T), cent = new Float32Array(T);
    const NBAND = 24, band = new Float32Array(NBAND);
    for (let t = 0; t < T; t++) {
      im.fill(0);
      for (let i = 0; i < N; i++) re[i] = x24[t * H + i] * w[i];
      fft(re, im);
      let fl = 0, cs = 0, cw = 0; band.fill(0);
      for (let k = 1; k < KB; k++) {
        cur[k] = Math.log1p(50 * Math.hypot(re[k], im[k]));
        const d = cur[k] - prev[k];
        if (t > 0 && d > 0) { fl += d; cs += d * k; cw += d; band[Math.min(NBAND - 1, Math.floor(k * NBAND / KB))] += d; }
      }
      flux[t] = fl; cent[t] = cw ? (cs / cw) * SR / N : 0;
      // 帯域ごとの立ち上がりの平たさ(幾何平均/算術平均)。音程楽器の発音は少数の帯域に偏る
      let g = 0, ar = 0; for (let b = 0; b < NBAND; b++) { g += Math.log(band[b] + 1e-6); ar += band[b]; }
      flat[t] = ar > 0 ? Math.exp(g / NBAND) / (ar / NBAND + 1e-9) : 0;
      const sw = prev; prev = cur; cur = sw;
    }
    const out = [], buf = new Float32Array(41);
    for (let t = 2; t < T - 2; t++) {
      if (!(flux[t] > flux[t - 1] && flux[t] >= flux[t + 1] && flux[t] > flux[t - 2] && flux[t] >= flux[t + 2])) continue;
      let n = 0; for (let d = -20; d <= 20; d++) { const tt = t + d; if (tt >= 0 && tt < T) buf[n++] = flux[tt]; }
      const med = median(buf, n);
      if (flux[t] <= med * o.drumSensitivity + 1) continue;
      if (flat[t] < o.drumFlatness) continue;
      const c = cent[t];
      out.push({ timeSec: (t * H + N / 2 - H) / SR, strength: flux[t] / (med + 1), centroidHz: c, flatness: flat[t], kind: c < 900 ? 'kick' : (c < 3500 ? 'snare' : 'hat') });
    }
    return out;
  }

  // ---- MML へ -------------------------------------------------------------

  const DRUM_NOISE = { kick: { idx: 11, vol: 13 }, snare: { idx: 6, vol: 12 }, hat: { idx: 1, vol: 8 } };

  /*
   * 声部ごとの音符列を MML にする。
   *   parts: [{ letter, notes:[{midi,startSec,endSec}], transpose }] と drums: { letter:'D', hits }
   *   opts:  { bpm(省略時は推定), grid, rests, originSec(省略時は最初の発音), tempoFrom(テンポを推定するパートの文字、既定 'C') }
   * 戻り値 { text, bpm, originSec, totalTicks, lines:[{letter,text,noteCount}] }
   * 全パートの長さは同じ小節数に揃える(ch 間で長さが食い違うとループでずれる)。
   */
  function buildMml(parts, drums, opts) {
    const o = Object.assign({ grid: 16, rests: true, beatsPerBar: 4, tempoFrom: 'C' }, opts || {});
    const NS = Input.NoteSegment, TPQN = MML.Convert.TPQN;
    const tonal = (parts || []).filter(p => p && p.notes && p.notes.length);
    const hits = (drums && drums.hits) || [];
    const onsetsOf = () => {
      // テンポの材料: tempoFrom で指定されたパート(低音。誤検出がいちばん少ない)→ いちばん音数の多いパート → 打点。
      // ★打点を先にしない: 音程楽器の発音を拾った誤検出が混じると、テンポが大きく外れる(自作曲で 150 → 133)
      const pref = tonal.find(p => p.letter === o.tempoFrom && p.notes.length >= 8);
      if (pref) return pref.notes;
      let best = []; for (const p of tonal) if (p.notes.length > best.length) best = p.notes;
      if (best.length >= 8) return best;
      return hits.map(h => ({ startSec: h.timeSec }));
    };
    let bpm = o.bpm;
    if (!Number.isFinite(bpm) || bpm <= 0) bpm = NS.estimateBpm(onsetsOf(), 120);
    let origin = o.originSec;
    if (!Number.isFinite(origin)) {
      origin = Infinity;
      for (const p of tonal) origin = Math.min(origin, p.notes[0].startSec);
      if (hits.length) origin = Math.min(origin, hits[0].timeSec);
      if (!Number.isFinite(origin)) origin = 0;
    }
    let endSec = origin;
    for (const p of tonal) endSec = Math.max(endSec, p.notes[p.notes.length - 1].endSec);
    if (hits.length) endSec = Math.max(endSec, hits[hits.length - 1].timeSec + 0.1);

    const qs = tonal.map(p => MML.Input.quantize(NS.toTimedEvents(p.notes, p.transpose || 0), {
      bpm, originSec: origin, endSec, grid: o.grid, strength: 1, legato: !o.rests, gate: 1, beatsPerBar: o.beatsPerBar
    }));
    const gridTicks = TPQN * 4 / o.grid, barTicks = TPQN * o.beatsPerBar;
    const toTick = (sec) => Math.round(((sec - origin) * (bpm / 60) * TPQN) / gridTicks) * gridTicks;
    const drumEv = [];
    for (const h of hits) {
      const s = toTick(h.timeSec); if (s < 0) continue;
      const d = DRUM_NOISE[h.kind] || DRUM_NOISE.snare;
      const last = drumEv[drumEv.length - 1];
      if (last && last.start === s) { if (d.vol > last.volume) { last.note = MML.Convert.noiseIndexToNote(d.idx); last.volume = d.vol; } continue; }
      if (last && last.end > s) last.end = s;
      drumEv.push({ start: s, end: s + gridTicks, note: MML.Convert.noiseIndexToNote(d.idx), volume: d.vol });
    }
    let total = 0;
    for (const q of qs) total = Math.max(total, q.totalTicks);
    if (drumEv.length) total = Math.max(total, Math.ceil(drumEv[drumEv.length - 1].end / barTicks) * barTicks);

    const lines = [];
    tonal.forEach((p, i) => {
      const text = MML.Convert.emitChannel(p.letter, qs[i].events.map(e => Object.assign({}, e)), TPQN,
        { totalFrames: total, wrapCol: 80, cmd: { SHAPE_REST: false }, tempoPrefix: lines.length ? '' : `t${Math.round(bpm)} ` });
      lines.push({ letter: p.letter, text, noteCount: qs[i].noteCount });
    });
    if (drumEv.length) {
      const text = MML.Convert.emitChannel(drums.letter || 'D', drumEv, TPQN,
        { totalFrames: total, wrapCol: 80, hasVolume: true, cmd: { SHAPE_REST: false }, tempoPrefix: lines.length ? '' : `t${Math.round(bpm)} ` });
      lines.push({ letter: drums.letter || 'D', text, noteCount: drumEv.length });
    }
    return { text: lines.map(l => l.text).join('\n'), bpm, originSec: origin, totalTicks: total, lines };
  }

  Input.PolyTranscribe = {
    DEFAULTS, SAMPLE_RATE: SR, FPS,
    toMono24k, createMultiPitch, multiPitch, multiPitchAsync, notes, voices,
    suggestBassCutoff, bassBand, drumOnsets, buildMml
  };

})(window);
