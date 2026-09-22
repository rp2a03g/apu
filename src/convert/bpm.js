/*
 * フォーマット非依存 BPM 自動検出 (2026-09-09 全面改訂: 混合モデル尤度方式)
 * MML.Convert.detectBpm(durationFrames, fps) → bpm(number、小数)
 * MML.Convert.refineBpm(userBpm, durationFrames, fps) → bpm(number)
 * MML.Convert.tempoPrior(bpm) → テンポ事前分布のペナルティ(mmlEmit.js chooseTempoOctave と共有)
 * MML.Convert.onsetIntervals(startFrames) → number[]
 * MML.Convert.tempoMaterial(startFrames, durationFrames) → number[]
 *
 * 材料は発音開始間隔(IOI、tempoMaterial 参照)。候補テンポごとに「各 IOI が
 *   IOI = k × (4分音符のフレーム数 / 24) + ジッタ(σ フレーム) 、または外れ値(ε)
 * という混合分布からどれだけ出やすいか」の対数尤度を合計し、最大の候補を採る。
 * k(4分音符=24 のグリッド単位)ごとに音価としての事前重み NOTE_WEIGHTS を持つ:
 *   4分/8分/16分=1.0(オクターブ中立)、32分・付点・2分/全音符は低め、
 *   3連系(k=8,4,16 …)はさらに低め、タイ2個相当(k=30,15,…)は僅か。
 *
 * 旧実装(2026-09-08 まで)は「fpq/8 = 1/32音符グリッドに IOI の何%が乗るか」のカバー率で、
 * 実測で次の構造的欠陥があった(合成36曲の往復テストで正解 10/36、
 * tools/headless/tempo-bench.js で再現できる):
 *  (1) グリッドが2進固定なので三連(fpq/3)は原理的に乗らない。三連だけの音列では
 *      当てられず、三連が半分以上の曲は全滅していた。→ グリッドを 1/24 拍にし、
 *      三連位置は事前重みを下げて「説明はできるが2進より不利」にする。
 *  (2) マッチ許容誤差がグリッド比例(tick×0.15)だったため、±1フレームのジッタがある曲
 *      (SPC のタイマー駆動ドライバ等)は粗いグリッド=半分のテンポに転んでいた
 *      (In the Wind: 56、真は113)。→ ジッタは絶対量 σ=0.6 フレームの正規分布で扱う。
 *  (3) 説明できない IOI(アルペジオ/効果音の残り)が細かいグリッド=2倍テンポを有利にする。
 *      → 外れ値の床 ε=0.1 と、IOI 値ごとの出現数を √ で圧縮(ハイハット175連打が
 *      メロディ30音を押し流さないように)。4フレーム未満の IOI は材料から外す。
 *  (4) 2倍/半分は音楽的に同じ演奏の記譜違いで、データだけでは決まらない。
 *      → 典型テンポ帯の事前分布 PRIOR_QUAD × log2(bpm/125)² を足す。最終決定は
 *      各 *2mml が MML.Convert.chooseTempoOctave(mmlEmit.js)で「B/2・B・2B で実際に
 *      音価を書いてみて、譜面の複雑さ+この事前分布が最小のもの」を選ぶ。
 *
 * 探索は整数 BPM 40〜400 の全候補(小数テンポも隣の整数が拾う)→ 最良候補の近傍 ±1.5% を
 * 小数 fpq で精密化(refineFpq)し、小数のまま返す。呼び出し側は MML 本文に埋め込む
 * 整数 t<n> へ丸め、音長量子化の fpb も同じ丸め後の値で計算する(書き出し時と再生時の
 * 基準テンポを揃える)。精密化は「149 と 150 の
 * どちらに丸めるべきか」を尤度で決めるためにある。
 *
 * 処理時間: 実測 5ms(整数探索)+30ms(精密化)/60秒キャプチャ。
 *
 * それでも自動検出には限界があるため、ユーザーが聴感で入力/タップしたBPMを
 * refineBpm()で近傍の最良テンポへ吸着補正して使う経路を用意した。
 */
(function (global) {
  'use strict';
  const MML     = global.MML     = global.MML     || {};
  MML.Convert   = MML.Convert   || {};

  // 音価の事前重み(k = 4分音符を24としたグリッド単位)
  const NOTE_WEIGHTS = [
    [24, 1.0], [12, 1.0], [6, 1.0],              // 4分 8分 16分
    [3, 0.3],                                    // 32分
    [48, 0.7], [96, 0.35],                       // 2分 全音符
    [36, 0.5], [18, 0.5], [9, 0.35], [72, 0.25], // 付点4分 付点8分 付点16分 付点2分
    [8, 0.35], [4, 0.25], [16, 0.25], [2, 0.05], // 3連8分 3連16分 3連4分 3連32分
    [30, 0.1], [15, 0.1], [42, 0.1], [60, 0.1], [21, 0.08], [54, 0.08], [66, 0.08], [84, 0.08], // タイ2個相当
  ];
  const SIGMA     = 0.6;   // ジッタ(フレーム)。ドライバの小数テンポ/タイマー駆動で IOI は ±1 フレーム揺れる
  const EPS       = 0.1;   // 外れ値の床(どの音価でも説明できない IOI の確率)
  const MIN_IOI   = 4;     // これ未満のフレーム数はアルペジオ/効果音として材料から外す
  const MAX_IOI   = 600;
  const COUNT_POW = 0.5;   // IOI 値ごとの出現数の圧縮(√)
  const PRIOR_CENTER = 125, PRIOR_QUAD = 0.8; // テンポ事前分布: PRIOR_QUAD × log2(bpm/PRIOR_CENTER)²
  const BPM_MIN = 40, BPM_MAX = 400;

  // テンポ事前分布のペナルティ(対数尤度と同じ単位、1音あたり)
  MML.Convert.tempoPrior = function (bpm) {
    const d = Math.log2(bpm / PRIOR_CENTER);
    return PRIOR_QUAD * d * d;
  };

  // IOI の平坦配列 → [値, 重み] の一覧(値ごとにまとめ、出現数を pow で圧縮)
  function ioiItems(durationFrames, pow) {
    const hist = new Map();
    for (const raw of durationFrames || []) {
      const d = Math.round(raw);
      if (d >= MIN_IOI && d <= MAX_IOI) hist.set(d, (hist.get(d) || 0) + 1);
    }
    const items = [];
    let wsum = 0;
    for (const [d, c] of hist) { const w = Math.pow(c, pow); items.push([d, w]); wsum += w; }
    return { items, wsum };
  }

  // 「4分音符 = fpq フレーム」のときの平均対数尤度
  function meanLogLik(items, wsum, fpq) {
    const tick = fpq / 24;
    let ll = 0;
    for (const [d, wt] of items) {
      let p = EPS;
      for (const [k, w] of NOTE_WEIGHTS) {
        const z = (d - k * tick) / SIGMA;
        if (z > -5 && z < 5) p += w * Math.exp(-0.5 * z * z);
      }
      ll += wt * Math.log(p);
    }
    return ll / wsum;
  }

  // 整数 BPM 候補の近傍(±1.5%)で 4分音符のフレーム数(小数)を細かく総当たりし、尤度最大の値を返す。
  // 精密化は出現数を圧縮しない(pow=1)全 IOI で行う(格子そのものを合わせる段なので数の多い音符が正)
  function refineFpq(durationFrames, fps, bpm) {
    const { items, wsum } = ioiItems(durationFrames, 1);
    const f0 = fps * 60 / bpm;
    if (wsum < 2) return f0;
    let best = null;
    const step = f0 * 0.0002;
    for (let f = f0 * 0.985; f <= f0 * 1.015; f += step) {
      const ll = meanLogLik(items, wsum, f);
      if (!best || ll > best.ll) best = { f, ll };
    }
    return best.f;
  }

  // 発音開始時刻の列 → 隣接する発音開始間隔(IOI)の列。
  // 音長(end-start)はドライバのゲートタイム(音符を短く切って発音)で
  // グリッドから外れるが、発音開始の間隔は必ずグリッドに乗るため、
  // 検出材料として音長より頑健。呼び出し側で音長と混ぜて渡す。
  // ★1フレーム後に続く発音開始は同じ打点の一部としてひとかたまりに扱い、間隔は「かたまりの
  // 末尾」どうしで測る(2026-09-22)。三角波ドラムの「1フレームの高い音→本体」やコナミの
  // 「本体の1フレーム前の前打ち」があると、素の隣接差では「本体→次の打点」が 5/11/23
  // フレーム(本当は 6/12/24)として材料に入り、拍がわずかに短いテンポ(女神転生II 3曲目: 真150
  // に対し158)へ引きずられ、16分が16分と3連の交互に化ける。かたまりの形は曲内で揃っている
  // ので末尾どうし(先頭どうしでも同じ)で測れば正しい間隔になる。2フレーム以上離れた短い
  // 発音(速いテンポの32分、アルペジオ)はまとめない(t175の32分=2.6フレームをまとめると
  // 2音分が1つの音価に見え半分のテンポに転ぶ)。MIN_IOI 未満の間隔を捨てるのは従来どおり(ioiItems)
  const JOIN_GAP = 1;
  MML.Convert.onsetIntervals = function (startFrames) {
    const out = [];
    if (!startFrames.length) return out;
    let prevEnd = null, end = startFrames[0];
    for (let i = 1; i < startFrames.length; i++) {
      const t = startFrames[i];
      if (t - end <= JOIN_GAP) { end = t; continue; } // 同じかたまり
      if (prevEnd !== null) out.push(end - prevEnd);
      prevEnd = end; end = t;
    }
    if (prevEnd !== null) out.push(end - prevEnd);
    return out;
  };

  // テンポ検出の材料(2026-09-08): 発音開始間隔(IOI)を主とし、音長(end-start)は IOI が取れない
  // チャンネル最後の音符だけ使う。以前は全音符の音長も混ぜていたが、ドライバのゲートタイムで
  // 切られた音長(例: Wing Defenders は13フレーム間隔の音符が9フレームで切れる)がグリッドを
  // 引っ張り、ゲート長のほうを16分音符とみなす速いテンポ(t106、真は t69)を選んでいた。
  // NOTE_END='next'(既定)では音符の書き長さが IOI そのものなので、IOI がグリッドに乗る
  // テンポこそが譜面をきれいにする。休符を挟む音符も「音長+休符=次の IOI」で IOI に含まれる
  MML.Convert.tempoMaterial = function (startFrames, durationFrames) {
    const out = MML.Convert.onsetIntervals(startFrames);
    const n = startFrames.length;
    if (n > 0 && durationFrames && durationFrames.length === n) out.push(durationFrames[n - 1]);
    return out;
  };

  MML.Convert.detectBpm = function (durationFrames, fps) {
    const { items, wsum } = ioiItems(durationFrames, COUNT_POW);
    if (wsum < 2) return 120;

    let best = null; // { bpm, score }
    for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm++) {
      const score = meanLogLik(items, wsum, fps * 60 / bpm) - MML.Convert.tempoPrior(bpm);
      if (!best || score > best.score) best = { bpm, score };
    }
    // 小数のまま返す(重要): 真のグリッドは「4分音符=整数フレーム」であることが多く、
    // 正確なBPMは fps*60/fpq という端数付きの値(例: 60.0988*60/24=150.25)。
    // 呼び出し側が整数へ丸めて t<n> と fpb の両方に使う(冒頭コメント参照)。
    const fpq = refineFpq(durationFrames, fps, best.bpm);
    return Math.max(BPM_MIN, Math.min(BPM_MAX, fps * 60 / fpq));
  };

  // ユーザー指定(数値入力/タップ)のBPMを、IOI と突き合わせて近傍(±6%)の最良テンポへ
  // 吸着させる。指定値の周囲に材料をよく説明する候補が無い(尤度が指定値と同程度)なら
  // 指定値をそのまま返す(SPC等、ドライバが独自タイマー駆動でフレーム格子に乗らない場合もあるため)。
  MML.Convert.refineBpm = function (userBpm, durationFrames, fps) {
    let bpm = Number(userBpm);
    if (!isFinite(bpm) || bpm <= 0) return 120;
    bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, bpm));

    const { items, wsum } = ioiItems(durationFrames, COUNT_POW);
    if (wsum < 2) return Math.round(bpm);

    const base = meanLogLik(items, wsum, fps * 60 / bpm);
    let best = null;
    for (let cand = Math.ceil(bpm * 0.94); cand <= Math.floor(bpm * 1.06); cand++) {
      const ll = meanLogLik(items, wsum, fps * 60 / cand);
      if (!best || ll > best.ll) best = { bpm: cand, ll };
    }
    // 指定値より明らかに(1音あたり 0.05 nat 以上)良く説明できる候補があればそちらへ吸着
    if (best && best.ll > base + 0.05) {
      const fpq = refineFpq(durationFrames, fps, best.bpm);
      return Math.max(BPM_MIN, Math.min(BPM_MAX, fps * 60 / fpq));
    }
    return bpm;
  };

})(window);
