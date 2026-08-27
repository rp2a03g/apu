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
 * が無く、hesPlayer.js captureHesSongAsync が記録する dpcmTrace($0806書込み列)から
 * 実際の再生レートを逆算し、MML.Dpcm.encode()でこのアプリのDPCM(2A03 DMC形式)へ変換する。
 *
 * ★2026-08-26 全面改修(それまでの経緯は下の「旧方式」も参照):
 * NX91002.hes idx33等で「実音は10種以下なのに@DPCM定義が数百件」+打点の頭に
 * キーン系ノイズが乗る問題の真因を実測で特定した:
 *   1. 打点の区切り($0804のoff→次のon)がほぼ常に同一フレーム内で起きる(実測254/255)。
 *      旧トレースはフレーム番号しか持たないため書込み順を復元できず、境界フレームの
 *      $0806書込み(平均約80サンプル≒12ms)が丸ごと次クリップの頭に混入していた。
 *      直前に鳴っていた音の尾は毎回違うので、同じドラムでも頭が毎回異なり、
 *      完全一致/あいまい判定の両方が外れて全打点が別定義になっていた。
 *      混入した異物がクリック/キーン系ノイズの実体でもある。
 *   2. あいまい判定が固定閾値(長さ差≤2サンプル・先頭固定アラインMAD≤1.0)で厳しすぎた。
 *   3. 同じドラムを途中でブツ切りして鳴らす打点(長い定義の前方一致)が全部別定義になっていた。
 *
 * 対策として、キャプチャ(hesPlayer.js)がトレースへ追加した3情報を使う:
 *   seq … controlTrace/dpcmTrace共通の書込み順連番。区切りを書込み1件単位で正確に復元する。
 *   t   … 分数フレーム時刻。クリップの再生レートをフレーム量子化誤差なしで推定する。
 *   src … サンプル値の読出し元ROM物理オフセット(ROM直読み・無加工と検証済みのときだけ、
 *         それ以外は-1)。cpuHuC6280.js fetchOperandのlastDataAddr由来。
 * srcが使えるクリップは「ROM開始アドレス=ドラムのID」として確定的に重複排除でき、
 * アドレスジャンプ=サンプル境界なので$0804トグルより正確な区切りにもなる
 * (実測: NX91002.hesはストリーミングループ LDA (zp) がROMを+1連続で直読みし、
 * 43142/43142件でROMバイトと書込み値が一致。書込みの残り29%はZP保持値の
 * ホールド書きでサンプル内容ではない=srcで自然に除外される)。
 * srcが使えない(RAMバッファ経由・音量テーブル加工などの)ROMは、seq精密区切りで
 * バイト列がほぼ完全一致になるため、完全一致+前方一致+緩和あいまい判定で潰す。
 * ※同じHuC6280曲でもVGM形式はCPU実行が無くこのトレース自体を作れない(空配列が渡る)ので、
 *   HES形式のほうがDPCM抽出精度は原理的に高い。
 *
 * 旧方式(seq/t/srcが無いトレースへのフォールバックとして保持):
 * snapshotsのon&&dda継続で区切る→controlTrace書込み順で区切る、と改善してきた
 * (フレーム未満のon/off切替の取りこぼし対策)。重複排除はWaveRegistry
 * (src/convert/waveRegistry.js)と同じ発想の完全一致+あいまい判定。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  const MIN_CLIP_SAMPLES = 4; // これ未満のクリップはノイズ的単発書込みとみなし無視する
  // run内の書込みのうちROM連続読みセグメントが占める割合がこれ以上なら
  // 「アドレス同定モード」(セグメント=クリップ、開始アドレス=ID)を使う。
  // 下回るROM(バッファ経由等)はバイト列一致モードへフォールバックする。
  const ADDR_COVERAGE_RATIO = 0.7;
  // アドレス同定モードで「1つのサンプル」とみなすROM連続セグメントの最小長(extractBySeq
  // 内のガード参照)。実測のドラム/ボイスは200〜2700サンプルなので十分に安全な下限
  const MIN_ADDR_SEG_SAMPLES = 32;

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

  // PCM品質設定(cmd.PCM_RATE、src/convert/options.js冒頭コメント参照)に従って
  // DMCレートを選ぶ。1bitデルタ変調は1bitあたり±2/127しか動けないため、ソースの
  // バイトレートと同程度のDMCレート(旧来の「最も近いレート」)では
  //   (a) 5bitの1LSB遷移にすら2bit必要でアタックが盛大になまる(スロープ過負荷)
  //   (b) 平坦部の+2/-2交互トグルがレート/2の可聴キーン音になる(実測4.4kHz運用で約2.2kHz)
  // の両方を踏む。倍率を上げるほど追従が効きアイドルトーンも高域へ逃げるが、
  // データ量はレートに比例して増える(ユーザー判断でサイズと品質を選ぶ)。
  //   'max' … 常に最高レート33.1kHz(既定)
  //   8/4/2 … ソースレートのn倍以上となる最小レート(テーブル上限で頭打ち)
  //   1     … 従来互換(最も近いレート、データ最小)
  function dmcRateIndexFor(rateHz, pcmRate) {
    const table = MML.Dpcm.DMC_RATE_TABLE_NTSC;
    if (pcmRate === 'max' || pcmRate == null) return table.length - 1;
    const mult = typeof pcmRate === 'number' ? pcmRate : parseInt(pcmRate, 10) || 4;
    if (mult <= 1) return bestDmcRateIndex(rateHz);
    for (let i = 0; i < table.length; i++) if (table[i] >= rateHz * mult) return i;
    return table.length - 1;
  }

  // controlTrace(書込み順の{frame,on,dda}イベント列)から、on&&ddaが連続している
  // 区間列を作る。書込み順に状態遷移を追うため、1フレーム内で複数回on/offが
  // 切り替わっても取りこぼさない。曲末尾でonのまま終わった場合はtotalFramesまで。
  // seq有りトレースでは{startSeq,endSeq,startFrame,endFrame}、無しでは{start,end}(フレーム)。
  function buildChannelRuns(trace, totalFrames) {
    const runs = [];
    let active = false, runStart = null;
    for (const ev of trace) {
      const newActive = ev.on && ev.dda;
      if (newActive === active) continue;
      if (newActive) {
        runStart = ev;
      } else if (runStart != null) {
        if (ev.frame > runStart.frame || (ev.seq !== undefined && ev.seq > runStart.seq)) {
          runs.push({ start: runStart.frame, end: ev.frame, startSeq: runStart.seq, endSeq: ev.seq, startFrame: runStart.frame, endFrame: ev.frame });
        }
        runStart = null;
      }
      active = newActive;
    }
    if (runStart != null && totalFrames > runStart.frame) {
      runs.push({ start: runStart.frame, end: totalFrames, startSeq: runStart.seq, endSeq: Infinity, startFrame: runStart.frame, endFrame: totalFrames });
    }
    return runs;
  }

  // ---- クリップ登録簿(アドレス同定/バイト列一致の両モード共用) --------------------
  // clips: [{samples:number[](0-31), rateHz}] を蓄積し、同じ音は1つのindexへまとめる。
  // 「同じ音の短いブツ切り打点」(次の打点で切られたハイハット等)は長い方の定義を共有し、
  // 打点の長さは音符長側で表現する(実機DMCの「途中で切る=次のトリガー/停止」と同じ意味論。
  // EnvelopeRegistryの前方一致共有と同じ発想)。逆に既存より長い打点が来たら定義を延長する。
  class ClipRegistry {
    constructor() {
      this.clips = [];
      this.byAddr = new Map();  // ROM開始オフセット -> clipIndex(アドレス同定モード)
      this.exact = new Map();   // samples.join(',') -> clipIndex(バイト列一致の高速パス)
    }

    _register(samples, rateHz) {
      const index = this.clips.length;
      this.clips.push({ samples, rateHz });
      this.exact.set(samples.join(','), index);
      return index;
    }

    // 既存clipのsamplesを長い版へ差し替える(前方一致で内容は同じ、末尾が伸びるだけ)
    _extend(index, samples, rateHz) {
      const clip = this.clips[index];
      this.exact.delete(clip.samples.join(','));
      clip.samples = samples;
      clip.rateHz = rateHz;
      this.exact.set(samples.join(','), index);
    }

    // アドレス同定モード: ROM開始オフセットがIDそのもの
    addByAddr(startAddr, samples, rateHz) {
      const hit = this.byAddr.get(startAddr);
      if (hit !== undefined) {
        if (samples.length > this.clips[hit].samples.length) this._extend(hit, samples, rateHz);
        return hit;
      }
      const index = this._register(samples, rateHz);
      this.byAddr.set(startAddr, index);
      return index;
    }

    // バイト列一致モード: 完全一致 → 前方一致 → 緩和あいまい判定の順で既存を探す。
    // seq精密区切り後はバイト列がほぼ完全一致になるため大半は最初の2つで決まる。
    // あいまい判定は保険: 長さ許容は相対(2%+2サンプル)、±4サンプルのオフセット探索付きで
    // 平均絶対誤差≤1.0(0-31スケール)・重なり90%以上を要求する(旧固定閾値は
    // 「長さ差≤2・先頭固定アライン」で実データの揺れに対して厳しすぎた)。
    addBySamples(samples, rateHz) {
      const exact = this.exact.get(samples.join(','));
      if (exact !== undefined) return exact;
      for (let i = 0; i < this.clips.length; i++) {
        const u = this.clips[i].samples;
        // 前方一致(短い方が長い方の先頭と完全一致)
        const common = Math.min(u.length, samples.length);
        if (common >= MIN_CLIP_SAMPLES) {
          let prefix = true;
          for (let k = 0; k < common; k++) if (u[k] !== samples[k]) { prefix = false; break; }
          if (prefix) {
            if (samples.length > u.length) this._extend(i, samples, rateHz);
            return i;
          }
        }
        // あいまい判定(長さが近いものだけ)
        if (Math.abs(u.length - samples.length) > Math.max(u.length, samples.length) * 0.02 + 2) continue;
        for (let off = -4; off <= 4; off++) {
          let sum = 0, n = 0;
          for (let k = 0; k < samples.length; k++) {
            const j = k + off;
            if (j < 0 || j >= u.length) continue;
            sum += Math.abs(samples[k] - u[j]); n++;
          }
          if (n >= samples.length * 0.9 && sum / n <= 1.0) return i;
        }
      }
      return this._register(samples, rateHz);
    }
  }

  // フォーマット非依存の共通抽出処理。「同じドラム/ボイス音の別打点」を重複排除した
  // 生クリップ(5bit、0-31の生サンプル値。DMCエンコード等の変換は一切していない)と、
  // どのクリップがいつ(何フレーム目〜何フレーム目に)トリガーされたかを返す。
  // MML.Hes2MmlExpansion.dpcm()(hes2mml変換、@DPCM<n>としてDMCエンコードする)と
  // src/audio/hes-stream-player.js HesReplayStreamPlayer(ネイティブ再生、生サンプルを
  // そのままAudioBufferとして再生する)の両方がこの1箇所を共有する(2026-08、
  // ユーザー提案: 「PCMは種類が少ないので最初に軽くバッファして呼び出すだけにすればいい」
  // という方針をネイティブ再生側にも展開)。
  // 戻り値: { channel, clips: [{samples:number[](0-31), rateHz}], events: [{start,end,clipIndex}] }
  MML.Hes2MmlExpansion.extractDdaClips = function (snapshots, dpcmTrace, controlTrace, frameRate) {
    const totalFrames = snapshots.length;

    // @DPCM<n>チャンネルは1つしか無いため(hes2mml側の制約。ネイティブ再生では制約は
    // 無いが、実測上ほぼ常に特定の1chへ集約されるため同じ選び方を踏襲する)、6ch中
    // もっとも実際にDDA区間の合計が長いchを1つだけ選ぶ。
    let bestCh = -1, bestTotal = 0, bestRuns = null;
    for (let ch = 0; ch < 6; ch++) {
      const runs = buildChannelRuns(controlTrace[ch] || [], totalFrames);
      const total = runs.reduce((a, r) => a + (r.end - r.start), 0);
      if (total > bestTotal) { bestTotal = total; bestCh = ch; bestRuns = runs; }
    }
    if (bestCh < 0) return { channel: -1, clips: [], events: [] };

    const trace = dpcmTrace[bestCh] || [];
    const hasSeq = trace.length > 0 && trace[0].seq !== undefined &&
      bestRuns.length > 0 && bestRuns[0].startSeq !== undefined;
    return hasSeq
      ? extractBySeq(bestCh, trace, bestRuns, frameRate)
      : extractByFrames(bestCh, trace, bestRuns, frameRate);
  };

  // クリップのレート推定: 書込みの分数フレーム時刻tが使えるなら
  // 「サンプル間隔の実測平均」= (件数-1) ÷ (最後と最初のtの差の秒数)。
  // t無し(旧トレース)はrun全長ベース(境界がフレーム量子化されるため誤差±10%程度)。
  function estimateRate(writes, from, to, fallbackFrames, frameRate) {
    const n = to - from;
    const first = writes[from], last = writes[to - 1];
    if (n >= 2 && first.t !== undefined && last.t > first.t) {
      return (n - 1) / ((last.t - first.t) / frameRate);
    }
    const seconds = fallbackFrames / frameRate;
    return seconds > 0 ? n / seconds : MML.Dpcm.DMC_RATE_TABLE_NTSC[7];
  }

  // ---- seq/t/src有りトレースの精密抽出(2026-08-26、冒頭コメント参照) ----------------
  function extractBySeq(channel, trace, runs, frameRate) {
    const reg = new ClipRegistry();
    const events = [];
    let pos = 0;

    for (const run of runs) {
      while (pos < trace.length && trace[pos].seq < run.startSeq) pos++;
      const ws = [];
      while (pos < trace.length && trace[pos].seq < run.endSeq) { ws.push(trace[pos]); pos++; }
      if (ws.length < MIN_CLIP_SAMPLES) continue;

      // run内の書込みを3種に分類しつつ、ROM読出しアドレスの連続セグメントに分ける:
      //   ROM内容   … src>=0。サンプル本体。前のROM書込みのsrc+1なら同一セグメント継続。
      //   ホールド  … src<0 かつ 直前の書込みと同じ値。DACの値を保持し直しているだけで
      //               波形情報を持たない(実測: NX91002.hesは書込みの29%がZP保持値の
      //               ホールド書きで、ROMストリームの合間に挟まる。これをセグメントの
      //               切れ目とみなすと1つのドラムが数十セグメントに細切れになる)。
      //               セグメントを切らず、サンプルにも入れない(透過)。
      //   異物内容  … src<0 かつ 値が変化している。出所不明の波形情報(音量加工や
      //               RAMバッファ経由)。これが多いrunはアドレス同定を信用しない。
      const segs = []; // {items:[wsインデックス...](ROM内容のみ)}
      let cur = null, lastSrc = -1;
      let romCount = 0, foreignCount = 0;
      for (let i = 0; i < ws.length; i++) {
        const w = ws[i];
        if (w.src >= 0) {
          romCount++;
          if (!cur || w.src !== lastSrc + 1) { cur = { items: [] }; segs.push(cur); }
          cur.items.push(i);
          lastSrc = w.src;
        } else if (i > 0 && w.value === ws[i - 1].value) {
          // ホールド: 透過(セグメント継続)
        } else {
          foreignCount++;
          cur = null; lastSrc = -1;
        }
      }
      // ★アドレス同定を採用する条件(2026-08-26追加のガード): 「十分に長いROM連続
      // セグメントが支配的」であること。アドレスが数サンプルおきに跳ぶ曲
      // (連続ストリーミングPCMや複数サンプルのソフトミキシング)では、セグメントが
      // MIN_ADDR_SEG_SAMPLES未満に砕けて「1打点=4サンプル」の微細イベントが数千個でき、
      // @DPCM定義も打点も爆発する(実測: SS90002.hesで86定義2902打点、MML 8倍に肥大)。
      // 実際のドラム/ボイスは数十ms=数百サンプルあるので、この閾値を下回るセグメントは
      // 「サンプルの切れ目」ではないと判断し、run全体を1クリップとして扱うストリーム
      // モードへ落とす(音の始まりは$0804のon/offが与えるので情報は失われない)。
      const bigSegs = segs.filter((sg) => sg.items.length >= MIN_ADDR_SEG_SAMPLES);
      const addrCoverage = bigSegs.reduce((a, sg) => a + sg.items.length, 0);

      if (romCount >= MIN_CLIP_SAMPLES && romCount >= (romCount + foreignCount) * ADDR_COVERAGE_RATIO &&
          addrCoverage >= ws.length * ADDR_COVERAGE_RATIO) {
        // アドレス同定モード: セグメントごとに1打点(runの途中でアドレスが跳んだら
        // 別サンプルの連続再生とみなして分割する=$0804トグル無しの垂れ流しにも耐える)。
        for (const sg of bigSegs) {
          const items = sg.items;
          const samples = items.map((i) => ws[i].value);
          const first = ws[items[0]], last = ws[items[items.length - 1]];
          const rateHz = (samples.length >= 2 && first.t !== undefined && last.t > first.t)
            ? (samples.length - 1) / ((last.t - first.t) / frameRate)
            : estimateRate(ws, 0, ws.length, run.endFrame - run.startFrame, frameRate);
          const clipIndex = reg.addByAddr(first.src, samples, rateHz);
          events.push({ start: first.frame, end: last.frame + 1, clipIndex });
        }
      } else {
        // バイト列一致モード: run全体を1クリップとして扱う(seq精密区切りにより
        // 同じ音はバイト列がほぼ完全一致する)
        const samples = ws.map((w) => w.value);
        const rateHz = estimateRate(ws, 0, ws.length, run.endFrame - run.startFrame, frameRate);
        const clipIndex = reg.addBySamples(samples, rateHz);
        events.push({ start: ws[0].frame, end: ws[ws.length - 1].frame + 1, clipIndex });
      }
    }

    // ★イベントendのクランプ(2026-08-26): endは「最終書込みフレーム+1」だが、次の打点が
    // 同一フレーム内で始まる(off→on同一フレームがこの種の曲では常態)と ev[i].end が
    // ev[i+1].start を1フレーム追い越して重複する。MML出力(mmlEmit)は各イベントの
    // dur=end-start を直列に並べるため、重複分がそのままDPCMチャンネルの尺に上乗せされ、
    // 曲が進むほど累積遅延になっていた(実測: NX91002 idx33/60秒で重複103件=+103フレーム
    // =終盤+1.7秒遅れ。PSG各chは3607フレームなのにEだけ3710フレーム)。
    // 発音タイミング(start)は変えず、endだけ次イベントのstartへ切り詰める。
    for (let i = 0; i + 1 < events.length; i++) {
      if (events[i].end > events[i + 1].start) {
        events[i].end = Math.max(events[i].start + 1, events[i + 1].start);
      }
    }

    return { channel, clips: reg.clips, events };
  }

  // ---- 旧トレース(seq無し)のフォールバック抽出(従来ロジック) ------------------------
  // 境界フレームの混入(冒頭コメントの真因1)は原理的に避けられないが、緩和済みの
  // ClipRegistry.addBySamples(前方一致+相対長さ許容+オフセット探索)で旧実装よりは潰せる。
  function extractByFrames(channel, trace, runs, frameRate) {
    const reg = new ClipRegistry();
    const events = [];
    let tracePos = 0;

    for (const run of runs) {
      const samples = [];
      while (tracePos < trace.length && trace[tracePos].frame < run.end) {
        if (trace[tracePos].frame >= run.start) samples.push(trace[tracePos].value);
        tracePos++;
      }
      if (samples.length < MIN_CLIP_SAMPLES) continue;

      const seconds = (run.end - run.start) / frameRate;
      const rateHz = seconds > 0 ? samples.length / seconds : MML.Dpcm.DMC_RATE_TABLE_NTSC[7];
      const clipIndex = reg.addBySamples(samples, rateHz);
      events.push({ start: run.start, end: run.end, clipIndex });
    }

    return { channel, clips: reg.clips, events };
  }

  // channel/defs/files/eventsを返す。defsの各要素にsampleCount(実際のPCMサンプル数。
  // sizeはNSF側配置用のバイト数で16byte境界に切り上げ済みのため別物)も含める。
  // ネイティブ再生(src/audio/hes-stream-player.js HesReplayStreamPlayer)がMML.Dpcm.decode()で
  // 復号する際、この正確なサンプル数が必要(2026-08、ユーザー指摘: ネイティブ再生も
  // 自作の簡略再生ではなく、MML変換と同じencode→decode往復を必ず経由させる)。
  MML.Hes2MmlExpansion.dpcm = function (snapshots, dpcmTrace, controlTrace, frameRate, cmd) {
    const { channel, clips, events: ddaEvents } = MML.Hes2MmlExpansion.extractDdaClips(snapshots, dpcmTrace, controlTrace, frameRate);
    const defs = [], files = [], events = [];
    const pcmRate = cmd && cmd.PCM_RATE != null ? cmd.PCM_RATE : 'max';

    for (const clip of clips) {
      const rateIndex = dmcRateIndexFor(clip.rateHz, pcmRate);
      // 5bit(0-31)を-1..1へ正規化してDPCMエンコーダへ渡す
      const floatSamples = new Float32Array(clip.samples.length);
      for (let i = 0; i < clip.samples.length; i++) floatSamples[i] = (clip.samples[i] / 31) * 2 - 1;
      // 初期DAC: 先頭サンプル値を7bit化してエンコーダのカウンタ開始値にし、同じ値を
      // @DPCM定義のdac($4011初期書込み)へ入れる。旧来のdac=255(書込み省略)+カウンタ64
      // 固定だと、再生開始時のDACが前の音の最終値のままでエンコーダの仮定とズレ、
      // 頭に追従ランプ(クリック)が乗っていた。
      const dac = Math.max(0, Math.min(127, Math.round((clip.samples[0] / 31) * 127)));
      const encoded = MML.Dpcm.encode(floatSamples, clip.rateHz, rateIndex, { startCounter: dac });

      const index = defs.length;
      const name = `hes_dpcm_${index}.dmc`;
      files.push({ name, bytes: encoded.bytes });
      // mode=0固定(ワンショット、ループしない)。
      defs.push({ index, file: name, freq: rateIndex, size: encoded.bytes.length, sampleCount: encoded.sampleCount, dac, mode: 0 });
    }

    for (const ev of ddaEvents) {
      // 実機DMCと同じくノート自体はレートに影響しない(常に基準ノートo4c=48で@<n>を選ぶだけ、
      // nsf2mml/converter.js buildDpcmEventsと同じ設計)。
      events.push({ start: ev.start, end: ev.end, note: 48, instrument: ev.clipIndex });
    }

    return { channel, defs, files, events };
  };
})(window);
