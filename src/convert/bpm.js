/*
 * フォーマット非依存 BPM 自動検出
 * MML.Convert.detectBpm(durationFrames, fps) → bpm(number)
 * MML.Convert.refineBpm(userBpm, durationFrames, fps) → bpm(number)
 * MML.Convert.onsetIntervals(startFrames) → number[]
 *
 * グリッド探索(フレーム/拍 fpq を1〜120で全探索)で「音価の何%がその
 * グリッドの整数倍に近いか(カバー率)」を求める(2026-09-08 から一致1件を、その音価が
 * 素直な音符で書けるかの重み simplicity で数える。材料は音長でなく発音開始間隔 IOI、
 * tempoMaterial 参照)。
 *
 * 旧実装は「閾値を超えた候補のうち最も粗いグリッド」を採用していたが、
 * これには実測済みの構造的欠陥が2つあった:
 *  (1) 曲の最短音符が8分以上だと、真のテンポの半分のグリッド(tick2倍)でも
 *      カバー率100%になり「より粗い」ため常に半テンポ(t60等)が選ばれる。
 *  (2) アルペジオ/効果音の1〜2フレーム音価が混入すると、それを説明できる
 *      極端に細かいグリッドだけが閾値を超え、倍々テンポ(t360等)が選ばれる。
 * 対策として、
 *  - 1〜2フレームの音価(通常テンポの64分未満=ほぼ確実にアルペジオ)は除外し、
 *  - 候補選択を「カバー率 − 典型テンポ帯中心からの対数距離ペナルティ」の
 *    合成スコア最大化に変更した。倍/半テンポは音楽的には同じ演奏の記譜違い
 *    (8分⇔16分)なので、カバー率が同等なら典型帯(130bpm近辺)に寄せるのが安全。
 *    ペナルティ係数を小さくしてあるため、本当に速い/遅いグリッドしか音価を
 *    説明できない曲ではカバー率差が勝ち、極端なテンポもそのまま採用される。
 *
 * それでも自動検出には限界があるため、ユーザーが聴感で入力/タップしたBPMを
 * refineBpm()でエミュレータのフレームグリッド(fps*60/fpq, fpq整数)に吸着補正
 * して使う経路を用意した。ドライバのテンポはフレームカウンタ駆動が普通なので
 * 真のBPMはこの格子上にあり、タップの±数%誤差はここで吸収できる。
 */
(function (global) {
  'use strict';
  const MML     = global.MML     = global.MML     || {};
  MML.Convert   = MML.Convert   || {};

  const REL_TOLERANCE      = 0.15; // マッチ判定の許容誤差(tickに対する割合)
  const COVERAGE_THRESHOLD = 0.85; // 「グリッドで説明できた」と見なす目安(refineBpmで使用)
  const LOG_CENTER         = 130;  // 典型的なゲーム音楽テンポ帯の中心
  const LOG_PENALTY        = 0.10; // 中心から1オクターブ(×2/÷2)離れる毎のカバー率換算減点

  function matches(d, tick, tol) {
    const n = Math.round(d / tick);
    return n >= 1 && Math.abs(d - n * tick) < tol;
  }

  // 音価の「書きやすさ」(2026-09-08): グリッドの何tick(1/32単位)かを n として、2 の冪を除いた
  // 奇数部 m が 1(音符1個)→1.0、3(付点)→0.85、5・7(タイ/複付点)→0.6、それ以上→0.4。
  // 細かいグリッド(tick 2〜3 フレーム)は整数の音価をほとんど何でも「説明」できてしまうので
  // カバー率だけでは常に勝つ(Wing Defenders: 真の t71 より t200 が選ばれ、譜面が付点と
  // タイだらけになる)。そのグリッドで音符がどれだけ素直に書けるかを一致に掛けて選ぶ。
  // 倍/半テンポは n が 2 倍/半分になるだけで m は変わらないので、その判定は従来どおり
  // 典型テンポ帯の事前分布(LOG_PENALTY)に任せる
  function simplicity(n) {
    let m = Math.max(1, n);
    while (m % 2 === 0) m /= 2;
    return m === 1 ? 1.0 : m === 3 ? 0.85 : (m === 5 || m === 7) ? 0.6 : 0.4;
  }

  function coverageFor(ds, fpq) {
    const tick = fpq / 8; // 最小グリッド = 1/32音符
    const tol  = tick * REL_TOLERANCE;
    let matched = 0;
    for (const d of ds) if (matches(d, tick, tol)) matched += simplicity(Math.round(d / tick));
    return matched / ds.length;
  }

  // 1〜2フレームはアルペジオ/効果音(通常テンポでは64分音符未満)なので
  // テンポ検出の材料から外す。混入すると細かすぎるグリッドを誤選択する。
  function cleanDurations(durationFrames) {
    return (durationFrames || [])
      .map(d => Math.round(d))
      .filter(d => d >= 3 && d <= 600);
  }

  // 発音開始時刻の列 → 隣接する発音開始間隔(IOI)の列。
  // 音長(end-start)はドライバのゲートタイム(音符を短く切って発音)で
  // グリッドから外れるが、発音開始の間隔は必ずグリッドに乗るため、
  // 検出材料として音長より頑健。呼び出し側で音長と混ぜて渡す。
  MML.Convert.onsetIntervals = function (startFrames) {
    const out = [];
    for (let i = 1; i < startFrames.length; i++) {
      out.push(startFrames[i] - startFrames[i - 1]);
    }
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
    const ds = cleanDurations(durationFrames);
    if (ds.length < 2) return 120;

    let best = null; // { fpq, bpm, coverage, score }
    for (let fpq = 1; fpq <= 120; fpq++) {
      const bpm = fps * 60 / fpq;
      if (bpm < 40 || bpm > 400) continue;

      const tick = fpq / 8;
      if (tick < 0.4) continue;

      const coverage = coverageFor(ds, fpq);
      const score = coverage - LOG_PENALTY * Math.abs(Math.log2(bpm / LOG_CENTER));
      if (!best || score > best.score) best = { fpq, bpm, coverage, score };
    }
    if (!best) return 120;

    // 丸めずに返す(重要): 真のグリッドは「4分音符=整数フレーム(fpq)」なので
    // 正確なBPMは fps*60/fpq という端数付きの値(例: 60.0988*60/30=120.198)。
    // これを整数に丸めてから呼び出し側で fpb=fps*60/bpm と逆算すると
    // fpb が 30.0494 のような非整数になり、音長量子化のグリッドが曲の実際の
    // フレーム格子から毎拍0.05フレームずつズレて、連打パートに周期的な
    // 補正音符(16..&96等)が混入する。表示用の丸めは表示側で行うこと。
    return Math.max(40, Math.min(400, best.bpm));
  };

  // ユーザー指定(数値入力/タップ)のBPMを、音価データと突き合わせて
  // 近傍(±6%)のフレームグリッドBPMへ吸着させる。グリッド上のどの候補も
  // 指定値の周囲の音価をうまく説明できない場合は指定値をそのまま返す
  // (SPC等、ドライバが独自タイマー駆動でフレーム格子に乗らない場合もあるため)。
  MML.Convert.refineBpm = function (userBpm, durationFrames, fps) {
    let bpm = Number(userBpm);
    if (!isFinite(bpm) || bpm <= 0) return 120;
    bpm = Math.max(40, Math.min(400, bpm));

    const ds = cleanDurations(durationFrames);
    if (ds.length < 2) return Math.round(bpm);

    let best = null; // { bpm, coverage }
    for (let fpq = 1; fpq <= 120; fpq++) {
      const gridBpm = fps * 60 / fpq;
      if (Math.abs(gridBpm / bpm - 1) > 0.06) continue;
      if (fpq / 8 < 0.4) continue;
      const coverage = coverageFor(ds, fpq);
      if (!best || coverage > best.coverage) best = { bpm: gridBpm, coverage };
    }

    // グリッド候補が指定値と同等以上に音価を説明できるならグリッドへ吸着。
    // detectBpm同様、丸めると量子化グリッドがズレるため正確な値のまま返す。
    if (best && best.coverage >= COVERAGE_THRESHOLD * 0.8) {
      return Math.max(40, Math.min(400, best.bpm));
    }
    return bpm;
  };

})(window);
