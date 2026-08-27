/*
 * 音源非依存: 専用アタックレジスタを持たないチップ(N163, FME7等)向けの、
 * 同一ピッチ内での「打ち直し(ロール奏法)」検出。
 *
 * N163やFME7(AY-3-8910互換)は2A03/VRC6/MMC5の長さカウンタ+アタック専用書込みや、
 * VRC7のキーオン、FDSの音量エンベロープ回路のような「ノートオン」のハードウェア概念を
 * 持たず、CPUが直接音量レジスタを書き換えるだけの素朴な発振器である。そのため
 * 「同じ音程・同じ波形/モードのまま音量だけリセットして音符を打ち直す」ロール奏法と、
 * 「同じ音程のまま音量が緩やかに上下するトレモロ」を、ピッチ/波形の変化だけを見る
 * 抽出処理では区別できず、ロールを1本の長い音符に誤結合してしまう
 * (女神転生II 25曲目、N163 Sパートで実測・報告。11曲目のN163ベースも当初トレモロと
 * 誤解釈していたが実際はロールだったとユーザー確認済み)。
 *
 * 判定方針(ユーザーとの設計検討の結論):
 *   A. 単フレームのジャンプ量: 前フレームよりopts.jumpThreshold以上音量が増えたら
 *      打ち直しの合図とする(周期性が無くても機能する。単発の打ち直しにも対応できる
 *      唯一の手段)。
 *   B. 周期の起伏+振幅: 音量列に繰り返し周期がある場合、1周期の中で「山から谷まで
 *      (立ち下がり)」「谷から次の山まで(立ち上がり、周期をまたぐ)」何フレームか、
 *      振幅(山-谷)がどれだけかを見る。トレモロは立ち上がり・立ち下がりが同程度の
 *      時間をかける(対称)のに対し、ロールは立ち下がりだけゆっくりで立ち上がりは
 *      ほぼ一瞬(非対称)、かつ振幅もその音符全体の最大音量付近まで戻る。
 *
 *   AとBは同じ判定を別の方法でやっているのではなく守備範囲が違う: Bは周期が
 *   検出できて初めて使える(最低3周期分の一致が必要、envelope.jsのループ判定と同じ
 *   考え方)。周期が見つかりBで「ロールらしい」と判定できた区間はBの結果(周期ごとの
 *   機械的な分割)を採用し、それ以外(周期が見つからない、または見つかったが
 *   トレモロと判定された)はAに任せる。両者を突き合わせて多数決するのではなく、
 *   担当領域を分けることで「判定が食い違ったらどうするか」という問題自体を無くしている。
 *
 * MML.Convert.splitRetriggers(volSeq, opts) -> [{start, end}, ...]
 *   volSeq: 同一ピッチ・同一波形/モードの区間のフレーム毎の生音量値(0始まりのローカル配列)
 *   opts.jumpThreshold (既定2): Aの閾値
 *   opts.minPeriod/maxPeriod/minRepeats/maxSearchStart: Bの周期探索パラメータ。
 *     envelope.jsのループ探索と考え方は同じだが、この用途向けに別定数として独立させて
 *     いる(ロール奏法とトレモロ効果の実測される周期長の傾向が異なりうるため、
 *     チューニングを混ぜない)。
 *   戻り値: volSeq を start/end (半開区間、volSeq自身のインデックス基準) に分割した配列。
 *     呼び出し側はこの範囲ごとにvolSeqをスライスして別々の音符イベントとして扱うこと。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const DEFAULT_JUMP_THRESHOLD = 2;
  // ★抽出パス1(音程変化の境界)からも同じ基準を使うために公開する(2026-08-26)。
  // アタックレジスタを持たないチップ(N163・HES PSG)は「音量の跳ね上がり」だけが
  // 打ち直しの手がかりだが、splitRetriggersは同一音程ラン内(パス2)しか走らないため、
  // 音程が変わる境界での再アタックは各extractorのpureNoteChange判定側で見る必要がある
  // (見落とすと、実際は打ち直している音程変化をレガートと誤認してタイ(&)で繋いでしまい、
  // タイ側では@v等を再指定しない仕様のため音量エンベロープが減衰し続ける。
  // 実測: 女神転生II 12曲目のN163 Q/Rパートで発覚)。
  MML.Convert.RETRIGGER_JUMP_THRESHOLD = DEFAULT_JUMP_THRESHOLD;
  const DEFAULT_MIN_PERIOD = 2;
  const DEFAULT_MAX_PERIOD = 48;
  const DEFAULT_MIN_REPEATS = 3;
  const DEFAULT_MAX_SEARCH_START = 96;
  const RISE_RATIO_DIVISOR = 3;       // 立ち上がりが周期の1/3以下ならロールらしいとみなす
  const MIN_AMPLITUDE = 2;            // 振幅がこれ未満ならロールとはみなさない
  const PEAK_NEAR_MAX_TOLERANCE = 1;  // 山がこの範囲内で全体最大値に近ければ「フルで戻った」とみなす

  // envelope.jsのisPeriodicFromと同じ考え方だが、この用途向けにパラメータを独立させて
  // 別途持つ(意図的に共有しない。用途によってチューニングしたい値が変わりうるため)。
  function findRepeatingPeriod(seq, minPeriod, maxPeriod, minRepeats, maxSearchStart) {
    const n = seq.length;
    const searchLimit = Math.min(n, maxSearchStart);
    for (let start = 0; start < searchLimit; start++) {
      const remain = n - start;
      const maxP = Math.min(maxPeriod, Math.floor(remain / minRepeats));
      for (let period = minPeriod; period <= maxP; period++) {
        let ok = true;
        for (let i = start + period; i < n; i++) {
          if (seq[i] !== seq[i - period]) { ok = false; break; }
        }
        if (ok) return { start, period };
      }
    }
    return null;
  }

  // 1周期分の値(cycle)を見て「ロール(アタックの繰り返し)らしいか」を判定する(Method B)。
  // 山(peak)は周期の先頭側、谷(trough)は周期の末尾側にあるという実測パターン
  // (例: 5,5,5,4,3,3,3,3,2,2)を前提に、立ち下がり(peak→trough)と立ち上がり
  // (trough→次周期のpeak、周期をまたぐ分)のフレーム数を比較する。
  function isAttackLikeCycle(cycle, overallMax) {
    const period = cycle.length;
    const peakVal = Math.max(...cycle);
    const peakIdx = cycle.indexOf(peakVal);
    const troughVal = Math.min(...cycle);
    const troughIdx = cycle.lastIndexOf(troughVal);
    const fallFrames = Math.max(0, troughIdx - peakIdx);
    const riseFrames = period - fallFrames;
    const amplitude = peakVal - troughVal;
    return riseFrames * RISE_RATIO_DIVISOR <= period &&
      amplitude >= MIN_AMPLITUDE &&
      peakVal >= overallMax - PEAK_NEAR_MAX_TOLERANCE;
  }

  // Method A: 前フレームよりthreshold以上音量が増えた地点で区切る
  function splitByJump(seq, threshold, offset) {
    const ranges = [];
    let segStart = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] - seq[i - 1] >= threshold) {
        ranges.push({ start: offset + segStart, end: offset + i });
        segStart = i;
      }
    }
    ranges.push({ start: offset + segStart, end: offset + seq.length });
    return ranges;
  }

  MML.Convert.splitRetriggers = function (volSeq, opts) {
    opts = opts || {};
    const jumpThreshold = opts.jumpThreshold != null ? opts.jumpThreshold : DEFAULT_JUMP_THRESHOLD;
    const n = volSeq.length;
    if (n <= 1) return [{ start: 0, end: n }];

    const period = findRepeatingPeriod(
      volSeq,
      opts.minPeriod || DEFAULT_MIN_PERIOD,
      opts.maxPeriod || DEFAULT_MAX_PERIOD,
      opts.minRepeats || DEFAULT_MIN_REPEATS,
      opts.maxSearchStart || DEFAULT_MAX_SEARCH_START
    );

    if (period) {
      const cycle = volSeq.slice(period.start, period.start + period.period);
      const overallMax = Math.max(...volSeq);
      if (isAttackLikeCycle(cycle, overallMax)) {
        // 周期部分は機械的に1周期=1音符として分割。その手前(リード部分)だけMethod Aを適用
        const ranges = period.start > 0 ? splitByJump(volSeq.slice(0, period.start), jumpThreshold, 0) : [];
        let i = period.start;
        while (i < n) {
          const end = Math.min(i + period.period, n);
          ranges.push({ start: i, end });
          i = end;
        }
        return ranges.filter(r => r.end > r.start);
      }
      // トレモロ判定: 分割せず1つの音符のまま(周期はanalyzeVolumeShape側で改めて検出される)
      return [{ start: 0, end: n }];
    }

    // 周期が見つからない: 全区間をMethod A(単フレームジャンプ)だけで判定
    return splitByJump(volSeq, jumpThreshold, 0);
  };
})(window);
