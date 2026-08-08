/*
 * HES PSG DDA(直接D/A、PCM/音声サンプル再生)モード → @DPCM<n> 抽出
 * MML.Hes2MmlExpansion.dpcm(snapshots, dpcmTrace, controlTrace, frameRate) → { defs, files, events }
 *
 * PSGはどのch(0-5)もDDAモードに切替可能だが、実機DMC(NES)と同じくこのアプリの
 * @DPCM<n>チャンネル文字は1つしか存在しない(src/mml/compiler.js CHIP_CHANNEL_COUNTS.dpcm=1、
 * 実機ppmck準拠)。曲全体でDDA区間の合計が最も長い1chだけを採用し、他chは無視する
 * (実測ではPCM/音声は特定の1ch(例: NX91002.hesのch5)に集約されることが多く、
 * 実用上の影響は小さいと判断)。
 *
 * DDAは実機DMCと違い「トリガー時に固定レート・固定長のサンプルを鳴らす」ハードウェアが
 * 無く、CPUが$0806へ生の5bitサンプル値を直接・高頻度(1フレームあたり数十〜百回)に
 * 書き込み続けることで音を作る(ソフトウェアPCM)。そのためNSFのDMCトリガー抽出
 * (nsf2mml/converter.js extractDmcTriggers)のような「レジスタから直接読める固定パラメータ」
 * が無く、代わりに hesPlayer.js captureHesSongAsync が記録する dpcmTrace
 * (ch別の{frame,value}列、$0806書込みをそのまま記録したもの)から実際の再生レートを
 * 逆算し、MML.Dpcm.encode()でこのアプリのDPCM(2A03 DMC形式)へ変換する。
 *
 * 区間(クリップ)の切れ目は、on&&ddaが連続している間を1クリップとする。
 * ★2026-08: 当初はsnapshots(1/60秒ごとのフレーム単位スナップショット)のon&&dda継続を
 * 見て区切っていたが、打楽器のように1音ごとに$0804(on/dda制御)をオン→オフし直す曲では
 * その切替がフレーム未満の間隔で起きることが多く、フレーム単位のサンプリングでは
 * 取りこぼして「全ての打点が1本の連続音に結合される」不具合になっていた(ユーザー実測:
 * NX91002.hesでリズムパートが単一の伸ばした音になってしまう)。hesPlayer.jsが新たに
 * 記録するcontrolTrace(ch別・書込み順の$0804イベント列。1フレームに複数回の切替が
 * あってもすべて個別のイベントとして残る)を使い、書込み順にon&&ddaの状態遷移を
 * 追うことで実際の打点区切りを取りこぼさず検出する。
 * レートは「クリップの総サンプル数 ÷ クリップの経過秒数」で推定する(1フレームより短い
 * 極端に短いクリップは誤差が大きくなりうるが、聴感上の影響が小さい単発ノイズ的書込みと
 * して許容する)。
 *
 * ★2026-08: 打点の区切り検出(上記)を直しただけでは、検出できた各クリップを無条件に
 * 新規@DPCM<n>として登録していたため、実際は3〜4種類しか無いドラム音が(打点の数だけ)
 * 何百件も重複登録されてしまう問題が残っていた(ユーザー実測: NX91002.hesで980件)。
 * ドラム/ボイスサンプルは同じROMデータをソフトPCMで毎回同じように流し込んでいるだけ
 * (N163波形のような回転位相ズレとは別の話)なので、生サンプル列がほぼ同一になる。
 * WaveRegistry(src/convert/waveRegistry.js、N163/FDS波形の重複排除に使用)と同じ発想で、
 * クリップごとにDPCMエンコード(重い処理)する前に「意味的に同じ音」をまとめる
 * dedupeClip()を追加した。完全一致はMapで即座に、長さ・波形が近い場合は正規化相関で
 * 判定する(キャプチャのタイミング量子化により1サンプル程度前後することがあるため)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  const MIN_CLIP_SAMPLES = 4; // これ未満のクリップはノイズ的単発書込みとみなし無視する

  // 実測レート(Hz)に対数距離で最も近いDMCレートインデックス(0-15)を選ぶ
  function bestDmcRateIndex(rateHz) {
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < table.length; i++) {
      const diff = Math.abs(Math.log2(rateHz / table[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  // 「同じドラム/ボイス音の別の打点」をまとめて再利用するための重複排除。
  // 完全一致(同じROMデータをそのまま再生しているケース、大半はこちらでヒットする)は
  // Mapで即座に引ける。長さ・振幅が近いが1サンプルもズレていないとは限らないケース
  // (捕捉タイミングの量子化による前後1サンプル程度のジッタ)は、短い方の長さに揃えて
  // 平均絶対誤差を見るフォールバックで拾う。閾値は「別のドラム音を誤って同一視しない」
  // ことを優先し、かなり厳しめに設定してある。
  const FUZZY_LEN_TOLERANCE = 2;      // 許容する長さの差(サンプル数)
  const FUZZY_MEAN_ABS_DIFF = 1.0;    // 許容する平均絶対誤差(0-31スケール上)
  function findDuplicateIndex(samples, exactMap, uniqueList) {
    const exact = exactMap.get(samples.join(','));
    if (exact !== undefined) return exact;
    for (const u of uniqueList) {
      if (Math.abs(u.samples.length - samples.length) > FUZZY_LEN_TOLERANCE) continue;
      const len = Math.min(u.samples.length, samples.length);
      let sum = 0;
      for (let i = 0; i < len; i++) sum += Math.abs(u.samples[i] - samples[i]);
      if (sum / len <= FUZZY_MEAN_ABS_DIFF) return u.index;
    }
    return -1;
  }

  // controlTrace[ch](書込み順の{frame,on,dda}イベント列)から、on&&ddaが連続している
  // 区間列({start,end}、半開区間)を作る。書込み順に状態遷移を追うため、1フレーム内で
  // 複数回on/offが切り替わっても取りこぼさない(冒頭コメント参照)。曲末尾でonのまま
  // 終わった場合はtotalFramesまでを区間とする。
  function buildChannelRuns(trace, totalFrames) {
    const runs = [];
    let active = false, runStart = null;
    for (const ev of trace) {
      const newActive = ev.on && ev.dda;
      if (newActive === active) continue;
      if (newActive) {
        runStart = ev.frame;
      } else if (runStart != null) {
        if (ev.frame > runStart) runs.push({ start: runStart, end: ev.frame });
        runStart = null;
      }
      active = newActive;
    }
    if (runStart != null && totalFrames > runStart) runs.push({ start: runStart, end: totalFrames });
    return runs;
  }

  MML.Hes2MmlExpansion.dpcm = function (snapshots, dpcmTrace, controlTrace, frameRate) {
    const totalFrames = snapshots.length;
    const defs = [], files = [], events = [];

    // @DPCM<n>チャンネルは1つしか無いため(冒頭コメント参照)、6ch中もっとも実際に
    // DDA区間の合計が長いchを1つだけ選ぶ(同時使用時に毎フレームchを切り替えていた
    // 旧実装より単純かつ、実測上ほぼ常に特定の1chへ集約される実態に合っている)。
    let bestCh = -1, bestTotal = 0, bestRuns = null;
    for (let ch = 0; ch < 6; ch++) {
      const runs = buildChannelRuns(controlTrace[ch] || [], totalFrames);
      const total = runs.reduce((a, r) => a + (r.end - r.start), 0);
      if (total > bestTotal) { bestTotal = total; bestCh = ch; bestRuns = runs; }
    }
    if (bestCh < 0) return { defs, files, events };

    const trace = dpcmTrace[bestCh] || [];
    let tracePos = 0;
    const exactMap = new Map();   // samples.join(',') -> defIndex(完全一致の高速パス)
    const uniqueList = [];        // [{index, samples}](あいまい一致のフォールバック用)

    for (const run of bestRuns) {
      const samples = [];
      while (tracePos < trace.length && trace[tracePos].frame < run.end) {
        if (trace[tracePos].frame >= run.start) samples.push(trace[tracePos].value);
        tracePos++;
      }
      if (samples.length < MIN_CLIP_SAMPLES) continue;

      // 既に登録済みの音と(完全一致 or ほぼ同一)なら新規登録せず使い回す。実際には
      // 3〜4種類しか無いドラム/ボイス音が打点の数だけ重複登録される事故を防ぐ
      // (冒頭コメント参照。DPCMエンコード自体もそこそこ重いため、ここで弾くほど軽くなる)。
      const dupIndex = findDuplicateIndex(samples, exactMap, uniqueList);
      if (dupIndex >= 0) {
        events.push({ start: run.start, end: run.end, note: 48, instrument: dupIndex });
        continue;
      }

      // レート推定: クリップの総サンプル数 ÷ 経過秒数
      const seconds = (run.end - run.start) / frameRate;
      const rateHz = seconds > 0 ? samples.length / seconds : MML.Dpcm.DMC_RATE_TABLE_NTSC[7];
      const rateIndex = bestDmcRateIndex(rateHz);

      // 5bit(0-31)を-1..1へ正規化してDPCMエンコーダへ渡す
      const floatSamples = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) floatSamples[i] = (samples[i] / 31) * 2 - 1;
      const encoded = MML.Dpcm.encode(floatSamples, rateHz, rateIndex);

      const index = defs.length;
      const name = `hes_dpcm_${index}.dmc`;
      files.push({ name, bytes: encoded.bytes });
      // dac=255は「初期DAC値の書込みを省略する」既定値(ROADMAP.md @DPCMフェーズA参照、
      // ppmck driverの慣例に合わせる)。mode=0固定(ワンショット、ループしない)。
      defs.push({ index, file: name, freq: rateIndex, size: encoded.bytes.length, dac: 255, mode: 0 });
      exactMap.set(samples.join(','), index);
      uniqueList.push({ index, samples });
      // 実機DMCと同じくノート自体はレートに影響しない(常に基準ノートo4c=48で@<n>を選ぶだけ、
      // nsf2mml/converter.js buildDpcmEventsと同じ設計)。
      events.push({ start: run.start, end: run.end, note: 48, instrument: index });
    }

    return { defs, files, events };
  };
})(window);
