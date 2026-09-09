/*
 * HES PSG 波形ch(0-5) → MML共通イベント形式 抽出(N163への借用を前提)
 * MML.Hes2MmlExpansion.wave(snapshots, waveReg, envReg) → { channels: [ch0..ch5], n163Wave }
 *
 * PC EngineのPSGは6ch全てが同種の32サンプル5bit波形音源で、N163(最大8ch、可変長波形)への
 * 借用が最も自然(DESIGN.md §5)。kss2mml/expansion/scc.js(32サンプル波形チップ→N163)と
 * 同じ設計を踏襲する。5bit(0-31)→N163の4bit(0-31を0-15へ、単純に1bit右シフト)で
 * ビット深度のみ落とす(情報量を最小限の劣化で移す)。
 *
 * PSGには専用アタックレジスタが無い(on/off・音量書換えだけの素朴な発振器)ため、
 * 打ち直し(ロール奏法)の検出はsrc/convert/retrigger.jsの共通ヒューリスティックに委ねる
 * (nsf2mml/expansion/n163.jsと同じ2パス構成: パス1でピッチ/波形が同じ区間をまとめ、
 * パス2でsplitRetriggersにより音量の跳ね上がりを打ち直しとして分割する)。
 *
 * ch4/5はノイズモード(noiseOn)の間、この波形chとしては「休符」として扱う
 * (ノイズ側の抽出はhes2mml/expansion/noise.js が別途担当し、2A03ノイズchへ借用する)。
 * DDAモード(直接D/A、音声ストリーミング用)は@DPCM(hes2mml/expansion/dpcm.js)が担当する。
 *
 * ★巡回シフト(rotation)の正規化について: PSGの波形バッファは「読み出し位相」と
 * 「$0806書込み位相」が同一のカウンタを共有する実機仕様を持つ(ユーザーとの調査で判明。
 * DDAが1→0に落ちた瞬間だけ位相が0にリセットされ、単なる$0806書込みや音符のon/off
 * 切替では0に戻らない)。そのため、多くの曲は演奏中のchに対しDDAを経由せず波形を
 * 再アップロードしており、毎回「前回どこまで読み出しが進んでいたか」という位相から
 * 書込みが始まる。結果、ドライバが送っているのは実質同じ波形データでも、バッファの
 * 中身は送るたびに開始オフセットが違う「巡回シフトしたコピー」になる
 * (聴感上は「音色が切り替わっている」のではなく「同じ波形がスライドして見える」)。
 * これを生の配列比較(完全一致)のまま音符分割・WaveRegistry登録に使うと、1サンプルでも
 * 巡回位置がずれるたびに別音符・別@N<n>として扱われ、音色定義と音符数が異常に
 * 膨れ上がる(ユーザー報告で発覚)。canonicalRotation()で「32通りの巡回シフトのうち
 * 辞書順最小のもの」に正規化してから音符分割・登録の両方に使うことで、巡回シフトだけの
 * 違いを同一波形とみなす。定常音では巡回シフトしても倍音構成(聴感上の音色)は変わらない
 * ため、音楽的忠実度への影響は無視できる(1周期未満、最大でも数ミリ秒の位相ズレのみ)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  MML.Hes2MmlExpansion.CH_COUNT = 6;
  const WAVE_LEN = 32;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }

  // f = PSG_CLOCK / (32 * period) (hesHeader.js HES.PSG_CLOCK、apuHuC6280.jsのclock()と同じ式)
  function waveFreq(periodReg) { return periodReg > 0 ? MML.HES.PSG_CLOCK / (32 * periodReg) : 0; }
  MML.Hes2MmlExpansion._waveFreq = waveFreq; // converter.jsのapplyPitchDetuneから使う

  // ch別バランス($0805)・全体バランス($0801)まで込みの実効音量インデックス(0-31)を返す
  // (apuHuC6280.js PsgChannel.gainLR()と全く同じ式。vol(0-31)は音量レジスタの生値)。
  //
  // ★重要(2026-08-26): $0805は「パン」専用ではなく、音量レジスタと同じインデックスへ
  // 合流する同一スケール(1step≒1.5dB)の減衰器=事実上の第2の音量レジスタである。
  // 実測(NX91002.hes)ではbalance値が左右対称($99/$88/$77…)の曲が多く、パンではなく
  // 純粋なチャンネル別の音量調整として使われている(idx34はch毎に$ee/$cc/$88/$bbで、
  // $88のchは$eeのchより14段=21dB下)。さらにidx34 ch3は音量レジスタを31に固定したまま
  // balanceを$99→$33へ掃引する「balanceだけで作った減衰エンベロープ」だった。
  // 以前はこの関数の代わりにpanSilent()(L/R両方が厳密に0か)を無音判定にだけ使い、
  // 減衰量そのものを完全に無視していたため、チャンネル間のミックスバランスが
  // 平均14.8dB崩れ、balance駆動のフェードは平坦な持続音に化けていた。
  // 実効インデックスを音量として使うことで両方が同時に解決し、無音判定も
  // 「実効インデックス0」として自然に吸収される(panSilentは廃止)。
  //
  // L/Rの扱い: 借用先(N163)にパンの概念が無いため、大きい方の側を採用して
  // 「その音がミックス上どれだけ大きいか」を保つ(SPC(spc2mml/converter.js frameVol)が
  // ボイス音量のVOL L/Rに対して max(|L|,|R|) を採るのと同じ方針)。
  function effectiveVolIndex(vol, balance, globalBalance) {
    const v = vol - 0x1E * 2;
    const lPan = (balance >> 4) & 0x0F, rPan = balance & 0x0F;
    const gL = (globalBalance >> 4) & 0x0F, gR = globalBalance & 0x0F;
    const left = Math.max(0, v + lPan * 2 + gL * 2);
    const right = Math.max(0, v + rPan * 2 + gR * 2);
    return Math.min(31, Math.max(left, right));
  }
  MML.Hes2MmlExpansion._effectiveVolIndex = effectiveVolIndex; // noise.jsから共用

  // ── ソフトウェア音量エンベロープの位相エイリアシング対策(2026-08-26) ──────────
  // HESにはNSF/KSS/GBSのような「PLAYルーチンをフレームレートで呼ぶ」規約が無く、
  // ゲームが内蔵タイマー(TIQ)を自前の周期で回して音量を1段ずつ書く(実測: NX91002は
  // 約54.9Hz=1.094フレーム間隔)。フレーム境界のスナップショットで音量列を作ると、
  // どのステップが2フレームに見えるかがノート開始の位相で毎回変わり、同じエンベロープが
  // 「各段±1フレーム違いの列」として数百種類の@v<n>に化ける(ユーザー実測: NX91002
  // idx34/180秒で@v252個。GBSの64Hzハードエンベロープクロック位相エイリアシングと同類だが、
  // HESはソフトエンベロープなのでレジスタパラメータからの決定論的再現はできない)。
  // 対策: captureHesSongAsyncのcontrolTrace($0804書込み列、音量の生値と分数フレーム時刻t
  // 付き)から volume(t) を区分定数関数として復元し、「ノートの開始書込みを原点にした
  // 相対時刻 t0+k (kフレーム目)」でリサンプルする。位相の基準がグローバルなフレーム格子
  // ではなくノート自身のアタック書込みになるため、同じエンベロープは駆動レートが何Hzでも
  // 必ず同一の列になり、EnvelopeRegistryの完全一致dedupeがそのまま効く。
  // 列の長さ(=ノートのフレーム数)と実時間の対応は変えないので、再生タイミングは不変。

  // controlTraceの1ch分から音量タイムライン[{t, v}](v=4bit音量)を作る。旧形式トレース
  // (vol/tフィールド無し)やVGM経由(トレース自体が空)はnullを返し、呼び出し側は
  // 従来のスナップショット列をそのまま使う。
  // ★bal/gbal(ch別バランス$0805・全体バランス$0801)が記録されているトレースでは、
  // 生の音量レジスタではなく実効音量インデックス(effectiveVolIndex参照)から作る。
  // これらは実質的に第2の音量レジスタで、balanceだけで減衰エンベロープを作る曲もあるため
  // (キャプチャ側hesPlayer.jsは$0805/$0801の書込みも変化点としてこのトレースへ積む)。
  // 旧形式(bal無し)は従来どおり生の音量レジスタで代替する。
  function buildVolTimeline(trace) {
    if (!trace || trace.length === 0 || trace[0].vol === undefined || trace[0].t === undefined) return null;
    const hasBal = trace[0].bal !== undefined;
    return trace.map((e) => ({
      t: e.t,
      v: Math.max(0, Math.min(15, (hasBal ? effectiveVolIndex(e.vol, e.bal, e.gbal) : e.vol) >> 1))
    }));
  }
  MML.Hes2MmlExpansion._buildVolTimeline = buildVolTimeline; // noise.jsから共用

  // pitchTrace($0802/$0803書込み列、hesPlayer.js参照)の1ch分から周期タイムライン
  // [{t, v}](v=12bit周期生値)を作る。音量と同じ位相エイリアシングがビブラート等の
  // ピッチ列(pitchSeq→EP/MPテーブル・音程判定)にも乗るため、同じ仕組みで正規化する。
  function buildPitchTimeline(trace) {
    if (!trace || trace.length === 0 || trace[0].t === undefined) return null;
    return trace.map((e) => ({ t: e.t, v: e.freq }));
  }

  // [startFrame, endFrame)のノートの音量列(長さendFrame-startFrame)を、ノート相対時刻で
  // リサンプルして返す(冒頭コメント参照)。原点t0は「開始フレーム内の最後の書込み」
  // (スナップショットが見るアタック値と同じ書込み。駆動tickは1フレームより長いのが普通で
  // 同一フレーム内に複数書込みがある場合は直前ノートの残りが先行しているだけ)。
  // 開始フレーム内に書込みが無い(音量変化を伴わないノート境界)場合はフレーム原点に
  // フォールバックし、書込みがまだ一度も無い区間はfallbackSeq(スナップショット列)を使う。
  // ★T_EPS: 駆動がフレームと厳密に同期している曲(VGMのVSYNC駆動ドライバ等)では、書込み時刻が
  // 毎フレーム同じ小数部(f + s/735)になり、t0+k と書込みの t が「同じ値のはず」なのに
  // 浮動小数の丸めで1ulp前後する。<= の判定がフレームごとに含む/含まないへ揺れると、
  // 対策前より酷い1フレーム違い変種を量産する(実測: Star Parodier #1 @v101→132)。
  // 同一位相の書込みは必ず含める意味で、微小な許容(1e-6フレーム≒0.0007サンプル)を持たせる。
  const T_EPS = 1e-6;
  // ★サンプル点のオフセット(sampleOffset): t0+k ちょうどで読むか、半フレーム後ろ(t0+k+0.5)で読むか。
  //  - 駆動レートがフレームレートとほぼ同じ曲(VGMのVSYNC駆動ドライバ: 実測1.003フレーム周期、
  //    VGMログ由来の±0.02フレームの揺らぎ付き)では、k番目の書込みが t0+k の直前/直後に揺れて
  //    着地し、ちょうどの時刻で読むと「含む/含まない」がノートごとに変わる=対策前より酷い
  //    1フレーム違い変種を量産する(実測: Star Parodier #1 @v101→132、近似重複ペア78→153)。
  //    半フレームずらせば周期1.00±0.02の書込みからは常に約0.5フレーム離れて読める。
  //  - 一方、タイマー駆動(HES NX91002: 54.9Hz=1.094フレーム周期)は音符開始(VSYNC)と
  //    エンベロープ段(タイマー)が別クロックで位相がノートごとに違い、0.5をずらすと段の
  //    境目とサンプル点の余裕がかえって減る曲がある(実測: idx32 @v33→42)。こちらは
  //    従来どおり t0 ちょうど(オフセット0)が良い。
  //  よって書込み間隔の中央値がほぼ整数フレーム(フレーム同期駆動)のときだけ0.5を使う。
  function sampleOffsetFor(timelines) {
    const gaps = [];
    for (const tl of timelines) {
      if (!tl) continue;
      for (let i = 1; i < tl.length; i++) { const g = tl[i].t - tl[i - 1].t; if (g > 0.05) gaps.push(g); }
    }
    if (gaps.length < 8) return 0;
    gaps.sort((a, b) => a - b);
    const med = gaps[gaps.length >> 1];
    const r = Math.round(med);
    return (r >= 1 && Math.abs(med - r) < 0.05) ? 0.5 : 0;
  }
  MML.Hes2MmlExpansion._sampleOffsetFor = sampleOffsetFor; // noise.jsから共用
  // 開始フレーム [startFrame, startFrame+1) 内の最後の書込み時刻(無ければnull)。
  // 複数のタイムライン(音量とピッチ)を渡せば、その全体で最後のもの=ノートのアタック
  // tick の時刻を返す。★音量列とピッチ列で原点を別々に取ってはいけない: 開始フレームに
  // 音量書込みが無いノート(レガートの音程変化・音量が同値のまま続く打ち直し)は原点が
  // フレーム格子に落ち、駆動tickに対する位相がノートごとに変わって変種を生む
  // (実測: VGM Tengai Makyou II #2 で@EPが8→56に膨れた)。同じtickで書かれた音量と
  // ピッチの時刻差は数μsなので、どちらを原点にしても同じ列になる。
  function noteAnchorT(startFrame, timelines) {
    let t0 = null;
    for (const timeline of timelines) {
      if (!timeline || timeline.length === 0) continue;
      let lo = 0, hi = timeline.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (timeline[m].t < startFrame) lo = m + 1; else hi = m; }
      for (let i = lo; i < timeline.length && timeline[i].t < startFrame + 1; i++) if (t0 === null || timeline[i].t > t0) t0 = timeline[i].t;
    }
    return t0;
  }
  MML.Hes2MmlExpansion._noteAnchorT = noteAnchorT; // noise.jsから共用

  // anchorT: noteAnchorT の結果(省略時はこのタイムライン単独で求め、無ければフレーム原点)
  // sampleOffset: sampleOffsetFor の結果(省略時0)
  function resampleSeq(timeline, startFrame, endFrame, fallbackSeq, anchorT, sampleOffset) {
    if (!timeline || timeline.length === 0) return fallbackSeq;
    let lo = 0, hi = timeline.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (timeline[m].t < startFrame) lo = m + 1; else hi = m; }
    if (anchorT === undefined) anchorT = noteAnchorT(startFrame, [timeline]);
    const t0 = anchorT != null ? anchorT : startFrame;
    const len = endFrame - startFrame;
    const out = new Array(len);
    let j = lo - 1;
    for (let k = 0; k < len; k++) {
      const sampleT = t0 + k + (sampleOffset || 0);
      // ★終端フレーム endFrame 以降の書込みは見ない: そこにあるのは次ノートのアタック/
      // 休符のオフ書込み(スナップショット endFrame が見るのは次ノート)。sampleOffsetで半フレーム
      // 後ろへずらした最後のサンプル点は endFrame を跨ぐことがあり、制限しないと全ての列の
      // 末尾に次ノートの音量(…10 12)やピッチ(…-92)が1個混入して別テーブルに化ける
      // (実測: Dragon Slayer #2 @v42→68、Tengai Makyou II #2 @EP8→56)。
      while (j + 1 < timeline.length && timeline[j + 1].t <= sampleT + T_EPS && timeline[j + 1].t < endFrame) j++;
      out[k] = j >= 0 ? timeline[j].v : (fallbackSeq ? fallbackSeq[k] : 0);
    }
    return out;
  }
  MML.Hes2MmlExpansion._resampleSeq = resampleSeq; // noise.jsから共用
  // KSS/VGM の AY・SCC 抽出器(src/kss2mml/expansion/ay.js, scc.js)からも同じ正規化を使う(2026-09-08)
  MML.Convert.TickResample = { resampleSeq, noteAnchorT, sampleOffsetFor };

  // PSGの5bit(0-31)波形をN163の4bit(0-15)へビット深度変換する(単純な1bit右シフト、
  // 0-31を0-15へ均等対応。情報量の損失は最小限)。
  function resampleTo4bit(wave) {
    const out = new Array(WAVE_LEN);
    for (let i = 0; i < WAVE_LEN; i++) out[i] = Math.max(0, Math.min(15, wave[i] >> 1));
    return out;
  }

  // wave(長さWAVE_LENの配列)の32通りの巡回シフトのうち、要素を","結合した文字列が
  // 辞書順最小になるものを返す(冒頭コメント参照)。WAVE_LEN=32程度なのでO(n^2)の
  // 素朴な全探索で十分高速。
  function canonicalRotation(wave) {
    const n = wave.length;
    let best = wave;
    let bestKey = wave.join(',');
    for (let r = 1; r < n; r++) {
      const rotated = wave.slice(r).concat(wave.slice(0, r));
      const key = rotated.join(',');
      if (key < bestKey) { bestKey = key; best = rotated; }
    }
    return best;
  }

  // useCanonicalRotation: false(既定)だとcanonicalRotation()(32要素のO(n^2)巡回シフト探索)を
  // 省略し、素の4bitリサンプルだけを使う。実際のMML変換(@N<n>の重複排除)ではtrueにして
  // 必ず正規化するが、main.js buildHesRollTimeline()(ネイティブ再生中に先読み進捗のたび
  // 全snapshotsを最初から処理し直すピアノロール表示用)は音符境界の見た目が多少荒くても
  // 実害が無く、フレーム数×6ch分この演算が積み重なると再生中の音声コールバックと
  // メインスレッドを奪い合って「がくがく」の一因になっていた(ユーザー実測。この関数は
  // hes2mml変換とロール表示の両方から共有されているため、変換専用のはずのコストが
  // 意図せずロール表示側にも波及していた)。
  function extractChannelEvents(snapshots, chIndex, useCanonicalRotation) {
    const runs = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) runs.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chIndex];
      // 実効音量(balance込み。effectiveVolIndex冒頭コメント参照)。0=無音なので、
      // 以前のpanSilent判定はこの値が0かどうかに吸収されている
      const effVol = effectiveVolIndex(c.vol, c.balance, snapshots[f].globalBalance);
      const activeWave = c.on && !c.dda && !c.noiseOn && effVol > 0;
      const vol4 = Math.max(0, Math.min(15, effVol >> 1));
      const freqHz = activeWave ? waveFreq(c.freq) : 0;
      const note = (activeWave && vol4 > 0 && freqHz > 0) ? freqToNoteNumber(freqHz) : null;
      // 巡回シフトの正規化(冒頭コメント参照): 音符分割にも@N<n>登録にも常にこの
      // 正規化後の配列を使うことで、位相がズレただけの再アップロードを同一波形とみなす
      // (useCanonicalRotation=falseの場合は上記コメントの理由で省略する)。
      const resampled = resampleTo4bit(c.wave);
      const wave4 = useCanonicalRotation ? canonicalRotation(resampled) : resampled;
      const waveKey = wave4.join(',');
      if (!cur) { cur = { note, wave: wave4, srcWave: c.wave, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol4], pitchSeq: [c.freq], tieCandidate: false }; continue; }
      if (note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // 「純粋な音程変化」(=タイで繋いでよいレガート)の判定。波形切替を伴わないことに加え、
        // ★この境界で音量が跳ね上がっていない(=打ち直しでない)ことも要る(2026-08-26修正)。
        // PSGには専用アタックレジスタが無いため打ち直しの手がかりは音量の跳ね上がりだけだが、
        // それを見るパス2のsplitRetriggersは同一音程ラン内しか走らず、音程が変わる境界は
        // 素通りしていた。結果、実際は再アタックしている音程変化までタイ候補になり、タイ側は
        // @v等を再指定しない仕様のため音量エンベロープが減衰し続けていた(nsf2mml/expansion/
        // n163.jsと同じ穴。女神転生II 12曲目のN163で発覚した同一原因)。
        const prevVol = cur.volSeq[cur.volSeq.length - 1];
        const reattack = prevVol != null && (vol4 - prevVol) >= MML.Convert.RETRIGGER_JUMP_THRESHOLD;
        const pureNoteChange = !reattack && note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave: wave4, srcWave: c.wave, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol4], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol4);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);

    // パス2: 打ち直し(ロール)検出(retrigger.js参照)。休符ランは対象外。
    // tieCandidateはrun先頭のパス1判定をそのまま引き継ぐが、runの途中で打ち直しにより
    // 新設された区間(r.start>0、実際に音量ジャンプで区切られた=本物の再アタック)は
    // 常にfalseにする(パス1では見えていなかった打ち直しがここで確定するため)
    const events = [];
    for (const run of runs) {
      if (run.note == null) { events.push(run); continue; }
      const ranges = MML.Convert.splitRetriggers(run.volSeq);
      for (const r of ranges) {
        events.push({
          note: run.note, wave: run.wave, srcWave: run.srcWave, waveKey: run.waveKey, rawFreq: run.rawFreq,
          start: run.start + r.start, end: run.start + r.end,
          volSeq: run.volSeq.slice(r.start, r.end),
          pitchSeq: run.pitchSeq.slice(r.start, r.end),
          tieCandidate: r.start === 0 ? run.tieCandidate : false
        });
      }
    }
    return events;
  }

  // waveReg/envRegは省略可(ピアノロール用タイムライン構築時は渡されない、
  // kss2mml/expansion/scc.jsと同じ理由)。waveRegが無い(=ロール表示専用)呼び出しでは
  // canonicalRotationを省略し、再生中のメインスレッド負荷を抑える(extractChannelEvents
  // 冒頭コメント参照)。
  // opts.maxAbsorbCents: mergeAlternatingVibratoの統合上限(pitch.js参照)。SA<num>導入後は
  // 深い変調もEP/MPで表現できるため既定は無制限。SA不使用(変換設定PITCH_SA='off')のときだけ
  // 呼び出し元が70を渡し、表現不能な深い統合を音符の交互のまま残す(従来動作)。
  MML.Hes2MmlExpansion.wave = function (snapshots, waveReg, envReg, controlTrace, pitchTrace, opts) {
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(ev.wave) } : {},
      (ev.note !== null && ev.srcWave) ? { srcWave: ev.srcWave } : {}, // 音色の同定(src/convert/toneKey.js)
      ev.note !== null && ev.rawFreq != null ? { rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(waveFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );

    const channels = [];
    for (let i = 0; i < MML.Hes2MmlExpansion.CH_COUNT; i++) {
      const rawEvents = extractChannelEvents(snapshots, i, !!waveReg);
      // ソフトエンベロープの位相エイリアシング対策(buildVolTimeline冒頭コメント参照):
      // 音符イベントのvolSeq(音量列)とpitchSeq(周期生値列、ビブラート/EP検出の入力)を
      // ノート相対時刻リサンプル列へ差し替える。マージ(mergeVibratoAndArpeggio等)より
      // 前に行い、以後の利用は全て正規化済み列を見る。
      const volTimeline = controlTrace ? buildVolTimeline(controlTrace[i]) : null;
      const pitchTimeline = pitchTrace ? buildPitchTimeline(pitchTrace[i]) : null;
      const sampleOffset = sampleOffsetFor([volTimeline, pitchTimeline]);
      for (const ev of rawEvents) {
        if (ev.note === null) continue;
        const anchorT = noteAnchorT(ev.start, [volTimeline, pitchTimeline]); // 音量/ピッチで原点を共有(noteAnchorT参照)
        if (volTimeline) ev.volSeq = resampleSeq(volTimeline, ev.start, ev.end, ev.volSeq, anchorT, sampleOffset);
        if (pitchTimeline) ev.pitchSeq = resampleSeq(pitchTimeline, ev.start, ev.end, ev.pitchSeq, anchorT, sampleOffset);
      }
      channels.push({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
        // P-5「不明瞭→EPテーブル」側(2026-08-12)。統合上限はopts経由(関数冒頭コメント参照)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(rawEvents,
          { maxAbsorbCents: opts && opts.maxAbsorbCents != null ? opts.maxAbsorbCents : null })).map(toCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true
      });
    }

    const finalSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1][0] : null;
    return {
      channels,
      n163Wave: finalSnap ? resampleTo4bit(finalSnap.wave) : new Array(WAVE_LEN).fill(0)
    };
  };
})(window);
