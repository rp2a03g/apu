/*
 * 音量エンベロープ(ソフトウェア書き換え型 / ハードウェア減衰型)共通の { values, loop } 変換。
 * @v<N> = { ... } / @vr<N> = { ... } テーブル構文(src/mml/lexer.js ENVELOPE_DEF_RE)用のデータを作る。
 *
 * MML.Convert.analyzeVolumeShape(seq) -> { values, loop } | null
 *   seq: 1音符区間のフレーム毎の生音量値(0-15)の配列(NSF/KSSのようにCPUが直接音量
 *        レジスタを書き換えるソフトウェアエンベロープ向け)
 *   戻り値 null … 全フレーム同一値(実質フラット)。呼び出し側は envelopeV ではなく
 *                 通常の volume を使うべき
 *   loop === null … 末尾保持(減衰・単発の音量変化のみ、ループではない)
 *   loop === n    … values[n]から末尾までが1周期として繰り返す(音量ビブラート等)
 *
 * ループ判定は「厳密に一致する周期が最低3周期分続く」ことを条件にする。これより緩い
 * 基準だと減衰カーブの途中でたまたま2回一致しただけの箇所を誤ってループと判定しやすい。
 *
 * MML.Convert.simulateHwEnvelope(period, loop, durFrames) -> { values, loop }
 *   2A03/MMC5パルス・ノイズ共通のハードウェア減衰エンベロープ(bit4=0モード)を厳密に
 *   シミュレートする。実測不要(period/loopフラグから数式で一意に決まるため)。
 *
 * MML.Convert.EnvelopeRegistry … 曲全体で共有するテーブル登録先(重複排除)。
 * ソフトウェア由来(analyzeVolumeShape経由)は0番から、ハードウェア由来
 * (simulateHwEnvelope経由)は100番から採番し、@v<N>の一覧を見ただけで
 * どちらの由来か一目でわかるようにする(ユーザー指示)。
 *
 * MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb) … 音符の区切り NOTE_END='next'
 *   (src/convert/options.js)。音符の直後の休符を音符へ吸収して次の音符の頭まで伸ばし、無音区間は
 *   @v表の末尾0またはゲートタイム q<n>/@q<n> で表す(下の同名関数の冒頭コメント参照)。
 *   各 *2mml が emitScore の直前に呼ぶ。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const MAX_ENV_FRAMES     = 180;  // ループが見つからない場合の上限(SPC変換と同じ約3秒分)
  const MIN_LOOP_PERIOD    = 2;    // 周期1は単なる単一値(=フラット)と区別がつかないので除外
  const MAX_LOOP_PERIOD    = 512;  // ゆっくりしたスウェル(数秒周期)も検出できるだけの余裕を持たせる
  const MIN_LOOP_REPEATS   = 3;    // 誤検出防止のため最低3周期分の一致を要求する
  const MAX_LOOP_SEARCH_START = 96; // ループ開始位置の探索上限(アタック直後からの範囲で十分)
  const HARDWARE_INDEX_BASE = 100; // ハードウェア減衰エンベロープの採番開始番号

  // 周期性の確認窓は「MAX_ENV_FRAMES」と「period*MIN_LOOP_REPEATS(この周期を確認するのに
  // 最低限必要な長さ、呼び出し元のmaxPeriod計算が既に保証している)」の大きい方に制限する
  // (seq.length全体ではなく)。
  // 理由(1): ノートが数秒を超える長さ(例: 持続音のパッド)だと、圧縮したい前半区間よりずっと
  // 先(どうせ非ループ時もMAX_ENV_FRAMESで切り詰めて捨てる範囲)にたまたま値が変化する箇所が
  // あるだけで「周期性が全区間で成立しない」と判定されループ検出そのものが握りつぶれ、
  // 本来なら{val | 一定値}と圧縮できるはずの長い一定値ノートが非圧縮の巨大配列(180値
  // フラット)になっていた(女神転生II 27曲目、N163の4秒近い持続音でuser指摘)。
  // 理由(2): MAX_LOOP_PERIODがMAX_ENV_FRAMESを超える場合(例: 320フレーム周期のスウェル)、
  // 確認窓を単純にMAX_ENV_FRAMES(180)固定にすると「period(320)より窓(180)が短く
  // for文が1回も回らずtrueを返してしまう(=検証していないのに周期性ありと誤判定する)」
  // というバグになる(女神転生II 24曲目、320フレーム周期のスウェルがピーク付近で
  // 止まって聞こえる=検出漏れの逆にもなりかねない話としてuser指摘、実際にはこちらの
  // 「確認せず素通りする」方向でなく「180フレームで頭打ちになり長い周期を検出できない」
  // 方向で発現していたが、根本原因である固定180上限そのものを直すため合わせて対応)。
  // period*MIN_LOOP_REPEATSはmaxPeriod計算(呼び出し元)により既にremain以下と保証されて
  // いるため、そこまでは安全に確認できる。
  function isPeriodicFrom(seq, start, period) {
    const limit = Math.min(seq.length, start + Math.max(MAX_ENV_FRAMES, period * MIN_LOOP_REPEATS));
    for (let i = start + period; i < limit; i++) {
      if (seq[i] !== seq[i - period]) return false;
    }
    return true;
  }

  MML.Convert.analyzeVolumeShape = function (seq) {
    if (!seq || seq.length === 0) return null;
    const uniq = new Set(seq);
    if (uniq.size <= 1) return null; // フラット(音量変化なし) → 呼び出し側は通常のvolumeを使う

    const n = seq.length;
    const searchLimit = Math.min(n, MAX_LOOP_SEARCH_START);
    for (let start = 0; start < searchLimit; start++) {
      const remain = n - start;
      const maxPeriod = Math.min(MAX_LOOP_PERIOD, Math.floor(remain / MIN_LOOP_REPEATS));
      for (let period = MIN_LOOP_PERIOD; period <= maxPeriod; period++) {
        if (isPeriodicFrom(seq, start, period)) {
          return { values: seq.slice(0, start + period), loop: start };
        }
      }
    }
    // ループ無し: 減衰/単発の音量変化として記録する(末尾保持)。
    // 末尾が同一値のまま足踏みしている区間はstepEnvelope()の末尾保持で自動的に
    // 続くため、1点を残して切り詰めればよい(データ量の抑制)。★逆に値が変化し
    // 続けている間はMAX_ENV_FRAMESで頭打ちにしてはいけない(女神転生II 24曲目、
    // 320フレーム周期の左右対称スウェルが単発ノートでは1周期分弱しかデータが
    // 無く3周期一致というループ確定基準を満たせない=ループ無し判定は正しいの
    // だが、旧実装はここで無条件にMAX_ENV_FRAMES=180で切り捨てていたため
    // スウェル後半の減衰(180-319フレーム目)が失われ、180フレーム目の値の
    // まま静止して聞こえていた)。
    let end = n;
    while (end > 1 && seq[end - 1] === seq[end - 2]) end--;
    // holdLen: 切り詰めた末尾保持のフレーム数(この音符が末尾値を保持していた長さ)。registerShape の
    // 前方一致共有が「保持していた区間で別の値が続く長い表」に差し替えないための情報
    return { values: seq.slice(0, end), loop: null, holdLen: n - end };
  };

  // 2A03/MMC5の内蔵減衰エンベロープ(4bit period n, loopフラグ)を厳密にシミュレートする。
  // 実機仕様: アタック(長さカウンタロード書込み)で減衰レベル=15から開始し、四分周期
  // (240Hz、1トラックフレーム=4四分周期)ごとに分周器(周期 n+1 四分周期)が1回出力する
  // たびにレベルを1減らす。loop無しなら0で停止、loopありなら0の次に15へ戻り16回の
  // 出力(=4*(n+1)フレーム)で1サイクル。
  // 形状はperiod/loopのみに依存し、ノートの長さには依存しない(loop無しは0に到達したら
  // 打ち切り=以降はstepEnvelopeの末尾保持で自動的に0が続く。loop有りは1サイクル分だけ)。
  // そのため呼び出し側はノート長を渡す必要がなく、曲中で同じperiod/loopを使う音符は
  // すべて同じテーブル番号を共有できる(実測不要、数式で一意に決まるため)。
  MML.Convert.simulateHwEnvelope = function (period, loop) {
    const p = Math.max(0, Math.min(15, period | 0));
    const divider = p + 1;
    const cycleFrames = 4 * divider;
    function levelAt(frameOffset) {
      // アタック直後の最初の四分周期ティック(q=1)では減衰は起きず15のまま
      // (実機Envelope.clockQuarterFrame()のstartFlag分岐)なので、経過ティック数
      // q=4*(frameOffset+1)からの減衰回数kは(q-1)/dividerの整数部になる。
      const q = 4 * (frameOffset + 1);
      const k = Math.floor((q - 1) / divider);
      return loop ? (15 - (k % 16)) : Math.max(0, 15 - k);
    }
    if (loop) {
      const values = [];
      for (let fo = 0; fo < cycleFrames; fo++) values.push(levelAt(fo));
      return { values, loop: 0 };
    }
    const values = [];
    for (let fo = 0; fo < MAX_ENV_FRAMES; fo++) {
      const v = levelAt(fo);
      values.push(v);
      if (v <= 0) break; // 0に到達したら以降はstepEnvelopeの末尾保持に任せて打ち切る
    }
    return { values, loop: null };
  };

  // cmd: src/convert/options.js の変換設定(省略可)。cmd.ENV===false なら登録を一切行わず
  // 常に null を返す(呼び出し側は MML.Convert.plainVolume で v<n> へフォールバックする)。
  // prefix: 定義行の接頭辞(既定 '@v'。リリース表なら '@vr'、デューティ(音色)エンベロープなら '@')
  MML.Convert.EnvelopeRegistry = function (cmd, prefix) {
    this.cmd = MML.Convert.normalizeCmd(cmd);
    this.prefix = prefix || '@v';
    this.tables = new Map();     // index(@v<N>の番号) -> { values, loop }
    this.swKeyToIndex = new Map();
    this.hwKeyToIndex = new Map();
    this.nextSwIndex = 0;
    this.nextHwIndex = HARDWARE_INDEX_BASE;
  };

  function shapeKey(shape) {
    return shape.values.join(',') + '|' + (shape.loop == null ? '-' : shape.loop);
  }

  // aがbの前方一致(prefix)かどうか。同じ形状の音符が音長違いで複数回現れる時、
  // stepEnvelope()はノート自身のゲート長ぶんしかテーブルを読まない(短い方はテーブルの
  // 途中までしか参照しない)ため、短い方は長い方のテーブルをそのまま共有しても再生結果は
  // 変わらない。@v<n>を音長ごとに量産せず1つのテーブルへ統合できる。
  function isPrefix(a, b) {
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // 短い表 shortShape(values の後を holdLen フレーム末尾保持)を長い値列 longValues で置き換えても、
  // 保持していた区間の値が変わらないか
  function holdCompatible(longValues, shortShape) {
    const L = shortShape.values.length;
    const hv = shortShape.values[L - 1];
    const upto = Math.min(longValues.length, L + (shortShape.holdLen || 0));
    for (let i = L; i < upto; i++) if (longValues[i] !== hv) return false;
    return true;
  }

  // 既に確定した shape({values,loop})を登録し番号を返す(重複排除)。
  // hardware=true ならHARDWARE_INDEX_BASE以降、falseなら0番から採番する。
  MML.Convert.EnvelopeRegistry.prototype.registerShape = function (shape, hardware) {
    if (!shape || !this.cmd.ENV) return null;
    if (hardware) {
      const key = shapeKey(shape);
      let idx = this.hwKeyToIndex.get(key);
      if (idx === undefined) {
        idx = this.nextHwIndex++;
        this.hwKeyToIndex.set(key, idx);
        this.tables.set(idx, shape);
      }
      return idx;
    }
    // ソフトウェアエンベロープ同士は生の values 配列が前方一致すれば共有する(例: 8分音符
    // 用の12点減衰カーブと4分音符用の24点減衰カーブが完全に同じ形の前半12点を持つ場合、
    // 片方だけを保持し短い方のノートはその先頭12点だけを読む)。ループ無し同士なら短い方を
    // 長い方で置き換えることもある(Ys1 12曲目で実測: @v12={12 12 10 10 10 10 9 9}
    // (ループ無し)と検出された形が、同じ楽器のより長いノートでは@v13={... 9 9 9 9 9 9 8 7
    // 6 5 4 3}と、9の後も減衰が続くと判明した)。stepEnvelope()は参照側ノート自身の長さ
    // ぶんしかテーブルを読まないため、より長い方へ差し替えても短いノートの再生結果に
    // 影響は無い。
    //
    // ★ループ有り同士(片方でもloop!=null)は前方一致していても共有・置き換えを一切行わない。
    // 理由(1) ループ有無の食い違い: analyzeVolumeShapeが返すloop有りの`values`は「最小の
    // 繰り返し単位」に切り詰められており、その配列長は実際に何フレーム分観測できたかを
    // 反映しない(切り詰め後は数個でも、裏では何十フレームも観測されている場合がある)。
    // このため「配列が長い方が情報量が多い」という前提そのものがループ有り無しの比較には
    // 使えず、「前方一致かつ片方だけ配列が長い」だけを頼りに片方を採用すると、実際には
    // 無関係な別ノート同士を混同する事故が繰り返し起きた(女神転生II 11曲目: 3で保持する
    // ループが、たまたま同じ立ち上がりで0まで減衰する別ノートに上書きされた。同33曲目:
    // 6でループし続ける長いノートに、たまたま同じ内容で終わる短いノート(実際は6の後も
    // ゆっくり減衰する)が紛れ込んだ)。
    // 理由(2) ループ有り同士でも危険: analyzeVolumeShapeは「同一値がMIN_LOOP_REPEATS*period
    // 分以上続く」だけでもloopと判定する(例: 減衰後ずっと一定音量を保持するだけの音符も
    // period=2の自明なループとして検出される)。この「単に保持しているだけ」のループと、
    // 本当に音量が周期的に上下する(トレモロ・リアタック含む)別楽器のループが、たまたま
    // 前半の数値が一致するだけで前方一致と判定されることがある。ループ再生はloop位置以降を
    // 無限に繰り返す仕様のため、短い方のノートがloop開始位置に到達する前に長い方の
    // pre-loop区間(本来そのノートには存在しないはずの再アタック等)を再生してしまい、
    // 1音のはずが2音に聞こえる不具合になる(Getsufuu Maden 5曲目、単発の減衰保持ノート
    // {7 6 5 4 3 2 1|1}が、エコーパートの二重アタックループ{7 6 5 4 3 2 1 1 1 1 7 6 5 4
    // 3 2|1 1}に丸ごと差し替えられ、単発のはずの音が二重アタックに聞こえた)。
    // いずれも「配列長」や「続きの整合性チェック」による特例で都度対処したが、切り詰め後の
    // 配列長という前提自体が壊れているため対症療法では再発した。よってループ有りが
    // 一つでも絡む組み合わせは常に「別ノート」として扱い、それぞれ独立に登録する
    // (ループ同士の重複排除は下のshapeKeyによる完全一致のみで行う)。
    for (const [idx, existing] of this.tables) {
      if (idx >= HARDWARE_INDEX_BASE) continue;
      if (existing.exact) continue; // applyNoteEnd が作った表は共有も置き換えもしない(registerExact参照)
      if (existing.loop != null || shape.loop != null) continue;
      // ★末尾保持の整合(2026-09-08): analyzeVolumeShape は末尾の同一値を1点に切り詰めるので、
      //   「5 4 3 を 7 フレーム保持」した音符の表 {5 4 3} は「5 4 3 2 2 1」の前方一致になってしまい、
      //   共有すると保持していた区間で 2 2 1 が鳴る(悪魔城伝説で実測: 元曲は 3 を保持、旧出力は
      //   2 まで落ちていた)。短い方が保持していた区間(holdLen)の値が長い方でも同じときだけ共有する
      if (isPrefix(existing.values, shape.values)) {
        if (!holdCompatible(shape.values, existing)) continue;
        if (shape.values.length > existing.values.length) {
          const observed = Math.max(existing.values.length + (existing.holdLen || 0), shape.values.length + (shape.holdLen || 0));
          this.tables.set(idx, Object.assign({}, shape, { holdLen: observed - shape.values.length }));
        } else {
          existing.holdLen = Math.max(existing.holdLen || 0, shape.holdLen || 0);
        }
        return idx;
      }
      if (isPrefix(shape.values, existing.values)) {
        if (!holdCompatible(existing.values, shape)) continue;
        existing.holdLen = Math.max(existing.holdLen || 0, shape.values.length + (shape.holdLen || 0) - existing.values.length);
        return idx;
      }
    }
    const key = shapeKey(shape);
    let idx = this.swKeyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextSwIndex++;
      this.swKeyToIndex.set(key, idx);
      this.tables.set(idx, shape);
    }
    return idx;
  };

  // seq(生音量値の配列)を解析して登録し、テーブル番号を返す。フラットなら null(呼び出し側で
  // volume を使うべき合図)。同一形状は曲全体を通して番号を再利用する(ソフトウェア=0番台)。
  MML.Convert.EnvelopeRegistry.prototype.assign = function (seq) {
    if (!this.cmd.ENV) return null;
    return this.registerShape(MML.Convert.analyzeVolumeShape(seq), false);
  };

  // リリース表(@vr)/デューティ表(@)用: ループ検出をせず「末尾の同一値は1点残して切り詰め、
  // 末尾保持」の形で登録する。フラットでも登録する(例: リリースが 4 を保持したまま次の音符に
  // 切られた場合の {4})。空なら null
  MML.Convert.EnvelopeRegistry.prototype.assignHold = function (seq) {
    if (!this.cmd.ENV || !seq || seq.length === 0) return null;
    let end = seq.length;
    while (end > 1 && seq[end - 1] === seq[end - 2]) end--;
    return this.registerShape({ values: seq.slice(0, end), loop: null, holdLen: seq.length - end }, false);
  };

  // チャンネル横断の周期ヒント確認(2026-08-14): アタック/ゲートレジスタを持たない音源
  // (N163等)では、疑似アタックのために音程やピッチを一瞬ずらす曲があり、単体チャンネルの
  // ラン分割がそこで途切れて analyzeVolumeShape が「最低3周期分の一致」というループ確定
  // 基準を満たせなくなることがある(女神転生II 24曲目、N163のP/Rパートで実測: 同時に鳴る
  // 和音の他ボイス(Qパート)は同じ疑似アタックが起きず1本の連続データとして320フレーム
  // 周期のループを確定検出できるのに、P/Rは約320フレームごとに千切れて1周期分弱しか
  // データが無くループ無し判定になり、スウェルが1周期鳴った後は末尾値で張り付いて聞こえる)。
  // 「一瞬のピッチ変化は疑似アタックとみなす」という一般ルールをsplitRetriggers/
  // mergeAlternatingVibrato側に追加すると、本物の装飾音・トリル等を誤って分割/破壊する
  // 副作用の方が大きいと判断し(ユーザー確認済み)、代わりに「同じ音源内の他チャンネルが
  // 確定的にループを検出できている」という外部証拠がある場合に限り、周期を疑わずヒントとして
  // 使い、自分自身の生データ(呼び出し側がラン分割を無視してtimelineから再構成したもの)が
  // その周期と矛盾しないかだけを緩く確認する、という後付けの補完に留める。
  // MIN_LOOP_REPEATSによる独立検出のハードルは課さない(周期の確からしさは呼び出し側が
  // 既に他チャンネルの確定ループで保証している前提)。矛盾が無く、かつ1周期分以上の
  // データがあればその1周期分をloop:0のvaluesとして返す。矛盾する、またはperiod未満しか
  // データが無ければnull(呼び出し側は通常のanalyzeVolumeShapeの結果をそのまま使うこと)。
  MML.Convert.tryConfirmLoopWithHint = function (seq, period) {
    if (!seq || period <= 0 || seq.length < period) return null;
    for (let i = period; i < seq.length; i++) {
      if (seq[i] !== seq[i - period]) return null;
    }
    return { values: seq.slice(0, period), loop: 0 };
  };

  // 完全一致だけで登録し、前方一致の共有・置き換えの対象から外す(exact)。
  // applyNoteEnd 専用。吸収後の音符は「表の音符長以降が全て0」であることを
  // 前提に、自分の可聴長を超えて表を読む。前方一致で {…3 0} が {…3 0 15 12 …}(再アタック
  // を含む実測レベル列)へ差し替えられると、伸ばした区間で再アタックが鳴ってしまうため、
  // この表だけは後から誰にも触らせない。
  MML.Convert.EnvelopeRegistry.prototype.registerExact = function (shape) {
    if (!shape || !this.cmd.ENV) return null;
    const key = shapeKey(shape);
    let idx = this.swKeyToIndex.get(key);
    if (idx === undefined) {
      idx = this.nextSwIndex++;
      this.swKeyToIndex.set(key, idx);
      this.tables.set(idx, { values: shape.values.slice(), loop: shape.loop == null ? null : shape.loop });
    }
    this.tables.get(idx).exact = true;
    return idx;
  };

  // 表 idx を使う音符(元曲で dur フレーム鳴った=コンパイル後 durC フレーム)を次の音符の頭まで
  // 伸ばしても「durC フレーム目以降が無音(0の末尾保持)」になる表の番号を返す。無ければ null。
  //   (a) 表が durC までに 0 へ到達し、以降も 0 だけ … その表のまま(ハードウェア減衰の100番台や、
  //       既に 0 で終わる実測列がこれ)
  //   (b) この音符が実際に読んだ dur フレームぶんの値列(表が短ければ末尾保持で埋める。
  //       analyzeVolumeShape は末尾の同一値を1点に切り詰めるので、1フレーム1段より遅い減衰は
  //       表が音符より短いのが普通: 実測 4 3 2 1 1 → 表 {4 3 2 1})が「自然に 0 へ到達する直前」
  //       で終わっている … コンパイル後の音符長 durC ぶんの値列に 0 を1つ足した表を exact 登録して返す
  //       「自然に」= 最後の値が直前の減衰幅以下(15 12 9 6 3 → 次は 0)、かつ最後の値の
  //       持続フレーム数が直前の段の持続+1 以下(4 4 3 3 2 2 1 1 → 次は 0。「15 10 5 2 を
  //       30 フレーム保持してからゲートオフ」のような減衰後のサステインは対象外)。
  //       減衰の途中で切られた音符(15 12 9 6 でゲートオフ)も対象外: 0 を足すと長い表との
  //       前方一致共有が壊れて表が増える一方、休符のままでも音は同じなので何も得しない
  //   ループ表(トレモロ)は末尾保持で 0 にできないので常に null
  // ★dur と durC(applyNoteEnd の ratio 参照): 元曲のフレームレートがコンパイル後(60Hz)と違う
  //   形式(GBS/HES のタイマー駆動曲、PAL の VGM 等)では、@v 表は元曲のフレーム毎に採った値を
  //   コンパイル後のフレーム毎に読む(従来からの近似)一方、音符長は音価経由で正しく伸縮する。
  //   0 の位置を元曲のフレーム数 dur に置くと音符が ratio 倍だけ早く切れる(GBS 50Hz 曲で実測
  //   10→12 フレームの音符が 10 で切れた)ので、0 は durC 番目に置き、間は末尾値で埋める。
  //   これで NOTE_END='zero'(音符長で切る)と完全に同じ読み方になる。「自然に」の判定は元曲の
  //   フレーム数 dur 側で行う(減衰の形は元曲のフレーム単位で採られているため)
  MML.Convert.EnvelopeRegistry.prototype.silentTailIndex = function (idx, dur, durC) {
    const t = this.tables.get(idx);
    if (durC == null) durC = dur;
    if (!t || t.loop != null || !(dur >= 1) || !(durC >= 1)) return null;
    const v = t.values;
    const last0 = v[v.length - 1];
    if (v.length > durC ? v.slice(durC).every(x => x === 0) : last0 === 0) return idx;
    const headOf = (len) => v.length >= len ? v.slice(0, len) : v.concat(new Array(len - v.length).fill(last0));
    const head = headOf(dur);
    const n = head.length;
    if (n < 2) return null;
    const last = head[n - 1];
    let lastRun = 1;
    while (lastRun < n && head[n - 1 - lastRun] === last) lastRun++;
    if (lastRun >= n) return null; // 読んだ範囲がフラット(減衰していない)
    const prev = head[n - 1 - lastRun];
    let prevRun = 1;
    while (lastRun + prevRun < n && head[n - 1 - lastRun - prevRun] === prev) prevRun++;
    const step = prev - last;
    if (!(last > 0 && last <= Math.max(1, step) && lastRun <= prevRun + 1)) return null;
    return this.registerExact({ values: headOf(durC).concat([0]), loop: null });
  };

  // 参照されなくなった表を捨てて番号を詰める(ソフトウェア0番台/ハードウェア100番台の区別は
  // 保つ)。イベント側の envelopeV も振り直す。applyNoteEnd 専用(吸収で置き換え
  // られた元の表が誰からも参照されなくなるため。NOTE_END='zero' では呼ばれず番号は従来のまま)
  MML.Convert.EnvelopeRegistry.prototype.compact = function (scoreChannels) {
    const used = new Set();
    for (const ch of scoreChannels || []) {
      for (const ev of (ch && ch.events) || []) if (ev.envelopeV != null) used.add(ev.envelopeV);
    }
    const remap = new Map();
    let sw = 0, hw = HARDWARE_INDEX_BASE;
    for (const idx of Array.from(this.tables.keys()).sort((a, b) => a - b)) {
      if (!used.has(idx)) { this.tables.delete(idx); continue; }
      remap.set(idx, idx >= HARDWARE_INDEX_BASE ? hw++ : sw++);
    }
    const tables = new Map();
    for (const [oldIdx, newIdx] of remap) tables.set(newIdx, this.tables.get(oldIdx));
    this.tables = tables;
    this.swKeyToIndex = new Map();
    this.hwKeyToIndex = new Map();
    for (const [idx, t] of tables) (idx >= HARDWARE_INDEX_BASE ? this.hwKeyToIndex : this.swKeyToIndex).set(shapeKey(t), idx);
    this.nextSwIndex = sw;
    this.nextHwIndex = hw;
    for (const ch of scoreChannels || []) {
      for (const ev of (ch && ch.events) || []) if (ev.envelopeV != null) ev.envelopeV = remap.get(ev.envelopeV);
    }
  };

  // ── 音符の区切り NOTE_END='next'(2026-09-07) ──────────────────────────────
  // 抽出器は音量レジスタが 0 になった瞬間(またはキーオフ)に音符を閉じて休符にするため、音長が
  // 「減衰が 0 に達したフレーム」というテンポ格子と無関係な値になり "@v156 d+4&d+64.&d+192 r8.&r64"
  // のような細切れのタイになる。音符を次の音符の頭(キーオン間隔)まで伸ばし、無音区間は次の
  // 2通りのどちらかで表す。どちらも再生結果が変わらない厳密な変形で、近似の譜面整形
  // (SHAPE_REST)とは別物:
  //
  //  (1) @v 表の末尾 0(envelope-zero): @v 付き音符で減衰が自然に 0 へ到達しているとき、表の
  //      末尾に 0 を1つ足す。同じ情報(いつ 0 になるか)が表にもあるので二重表現を片方に寄せる。
  //        @v156 = { 15 12 9 6 3 }  @v156 d+4&d+64.&d+192 r8.&r64  →  @v156 = { 15 12 9 6 3 0 }  @v156 d+2
  //      コンパイラ(src/mml/compiler.js stepEnvelope)も NSF ドライバ(src/driver/ppmckDriver.js)も
  //      表の末尾値を保持し続けるので、0 到達フレーム以降は無音のまま次のキーオンまで進む。
  //      キーオンからのフレーム数で 0 の位置が決まるため、テンポ丸め由来の時間ドリフトの影響も
  //      受けない。休符イベントが消えるぶん NSF のバイトコードは縮む。
  //      対象は非ループの表で「自然に 0 へ到達した」音符だけ(silentTailIndex コメント参照)。
  //      減衰後に一定音量で保持してからゲートオフする音符(例 {5 4 3 2 | 1 1} を 13〜48 フレーム)は
  //      0 の位置が音符長ごとに違い、表を音符長の数だけ量産することになるので (2) に回す。
  //  (2) ゲートタイム q<n> / @q<n>: それ以外の音符(減衰途中で切られた @v 音符、フラットな v<n> の
  //      音符、三角波、ループ表(トレモロ)、VRC7 のキーオフ)。コンパイラはゲートオフを休符と同じ
  //      「音量 0 / キーオフ」として書き(writeVolumeEnvelope の gateFrames 以降。NSF 書き出しは
  //      mckBytecode が 'rest' ブレークポイントに分解する)、ppmck 本家も q を音符+休符に分解する
  //      ので、休符を書くのと同じ音になる。q<n> は round(音長×n/8)、@q<n> は「終端の n フレーム前」
  //      で、元の可聴長に一致する方を使う。
  //      ゲートは状態コマンドで、しかも休符を残す音符やレガートの音符では q8 でなければならない
  //      (q6 のまま `c8 r8` と書くと c8 自体が 3/4 に切られる)ので、切り替えの回数と休符の
  //      トークン数の合計が最小になる割り当てを連鎖列に対する動的計画法で決める(下の DP)。
  //      ドライバのゲートが一様(ppmck 的な比率 q か、Konami 的な「次の音符の n フレーム前」か)
  //      ならチャンネル先頭に 1 回出るだけで済み、そうでない曲では `q4 c4 q8` より `c8 r8` が
  //      選ばれる。(1) で伸ばした音符はゲートオフが可聴長以降なら状態を問わない(無音を切るだけ)
  //      ので、切り替えの数を増やさない。隙間が 2 拍(fpb×2)を超える長い無音は休符のまま
  //      (`@q180 c1&c1&c1` にしない)。
  //      タイ(slurTie)で繋いだ連鎖はコンパイラで 1 セグメントになる(ゲートは連鎖全体に掛かる)ので
  //      連鎖単位で判定し、コマンドは連鎖の先頭イベントに付ける(mmlEmit は slurTie イベントの前に
  //      状態コマンドを出さない)。
  //
  // 対象外:
  //   ・@vr(リリース表)付きの音符 … 音符の終わり=キーオフでリリースが始まる意味論(SPC)。(1) は
  //                                   リリース開始が遅れるので不可。SPC 変換はこの関数を呼ばない
  //                                   (SPC は q<n> を一切出しておらず @vr0 が鳴る経路が無い。別件)
  //   ・VRC7(固定文字 G-L)           … (1) は不可(キーオフで鳴る OPLL のリリース RR を捨てて別の音に
  //                                   なる)。(2) は可(ゲートオフ=キーオフ、元と同じ)
  //   ・曲末尾の無音                 … 次の音符が無い(休符のまま)
  // 伸ばした音符は ev.audibleEnd に元の終端を残す(音程検証 src/convert/verify.js は伸ばした無音区間
  // でなく可聴区間だけをサンプルする)。間に挟まる休符イベントは捨てる。(1) で参照されなくなった表は
  // compact() で捨てて番号を詰める。
  // srcFps: 元曲のフレームレート(各 *2mml の frameRate/FPS)。コンパイル後は常に 60.0988Hz
  //   (compiler.js FRAME_RATE_NTSC)で、音長は音価経由で ratio=60.0988/srcFps 倍のフレーム数になる
  //   (fpb が round(bpm) で計算されているためテンポ丸めの分は fpb 側に吸収済み)。@v 表の 0 の位置と
  //   ゲートのフレーム計算はコンパイル後のフレーム数で行う(silentTailIndex の★参照)
  // 戻り値: { absorbed, gated } … (1)/(2) で伸ばした連鎖の数
  const KEYOFF_RELEASE_LETTERS = /^[G-L]$/; // VRC7 の完全固定チャンネル文字(assignExpansionLetters)
  const GATE_FULL = 'q8';                     // コンパイラの既定(ゲート無し)
  const GATE_SWITCH_COST_EXACT = 4;           // 状態コマンド 1 個のコスト(休符トークン 1 個 = 1 に対して)
  const GATE_SWITCH_COST_APPROX = 4;          // 近似モード: 状態コマンド 1 個のコスト
  const GATE_DEV_COST = 0.5;                  // 近似モード: キーオフ位置のずれ 1 フレームあたりのコスト
  const GATE_AT_BIAS = 0.5;                   // 近似モード: @q/@k より q<n>(比率)を優先する読みやすさの重み
  // 近似モード: 音符の間に残る休符/k トークン 1 個のコスト。読みやすさの目的(ユーザー要望「音が繋がって
  // 演奏が読める」)では休符の細切れが一番の敵なので、状態コマンド 1 個(4)に近い重さにする。Wing Defenders:
  // 13/76/51 フレームの音符が全て「次の 4 フレーム前」でキーオフ → @q4 一本(202 フレームの音符だけ @q10)。
  // 休符 1 個 = 2 だと @q4→@q10→@q4 の切り替え 2 回より q8 のまま k を並べる方が安く見えてしまう
  const GATE_REST_COST_APPROX = 3;

  // ゲート状態 s のとき、音長 D フレームの音符が実際に鳴るフレーム数(compiler.js computeGateFrames
  // =実機ppmckc calcGateTime の切り捨て式。MML.Mml が無い環境(Worker)は使わないので直書きしない)
  function gateFramesOf(s, D) {
    if (s === GATE_FULL) return D;
    if (s[0] === '@') {
      const n = parseInt(s.slice(2), 10);
      return s[1] === 'k' ? Math.max(1, Math.min(D, n)) : Math.max(1, D - n);
    }
    return MML.Mml.ppmckGateFrames(D, parseInt(s.slice(1), 10), 8, 0);
  }
  // 状態 s のまま、音長 A の音符を切らずに(音長いっぱいで)鳴らせるか。休符を残す音符・レガートの
  // 音符・曲末尾の音符はこれを満たす状態でなければならない(q8 のほか @k<n> は n>=A なら可)
  // m(2026-09-19): 書き出す音長のずれの余裕(フレーム)。この関数は音長の量子化(LEN_SNAP/LEN_DP、
  //   src/convert/duration.js)より前に呼ばれるので、実際にコンパイルされる音長は A から最大 2×LEN_SNAP
  //   (両端の境界が逆向きにずれた場合)+1(コンパイラの丸め)長くなりうる。A だけで判定すると、1 フレームの
  //   音符は q1〜q7 でも「切れない」(床関数でも最低1フレーム)ことになり、前の音符の q<n>/@q<n> がそのまま
  //   残る。その音符が 2〜3 フレームに書かれると半分で切られ、音符の間に1フレームの無音が挟まる
  //   (KSS→MML の PSG ドラムで実測: Metal Gear 2 曲153 の X で 30 秒に 40 箇所、Salamander 曲29 で 76 箇所)
  const keepsFull = (s, A, m) => gateFramesOf(s, A + (m || 0)) >= A + (m || 0);
  // 連鎖(inter-onset D フレーム、可聴 A フレーム)を正確に表せるゲートコマンド。
  // ★コンパイル後の音長 D' はテンポの整数丸め由来の carry で D±1 フレームになり得る。q<n> は
  //   floor(D'×n/8) なので D' が 1 違うと可聴長も 1 動くことがある。D±1 でも無音が残り可聴長の
  //   ずれが 1 フレーム以内に収まる n だけを候補にする(@q<k> は k≥1 なら常に満たす)。
  //   @k<A>(キーオンから A フレーム、本ツール独自)は D-A>=2 のとき候補(D'=D-1 でも無音が残る)。
  //   固定オン長のドライバ(Konami 等)ではこれ1つで全音符が表せ、レガート(D<=A)の音符にも
  //   そのまま掛けられる(keepsFull)
  // tol(GATE_TOL、GATE_APPROX 時): キーオフ位置のずれをこのフレーム数まで許し、候補に dev(ずれ)を付ける。
  //   ゲートの近似(2026-09-08、ユーザー要望「音が繋がって演奏が読める方が大事」): 厳密一致だけだと
  //   ドライバのキーオフ位置が比率でも固定フレームでもない曲(Wing Defenders: 短い音符は q6、長い音符は
  //   次の4フレーム前)で統一できるゲートが無く、休符や k が細切れのまま残る。数フレームのずれは
  //   音楽的に聞こえないので、許容内なら同じ q で書く(レガートと長い無音は切らない)
  function gateCandidates(D, A, tol) {
    const c = [];
    if (D - A >= 2) c.push({ s: '@k' + A, dev: 0 });
    for (let n = 1; n <= 7; n++) {
      const q = 'q' + n;
      const g = gateFramesOf(q, D);
      const dev = Math.abs(g - A);
      if (dev > (tol || 0) || g >= D) continue;
      // D±1(コンパイル後の carry)でも無音が残ること。厳密(tol=0)ではずれも1フレーム以内に限る
      let ok = true;
      for (const d of [D - 1, D + 1]) {
        if (d < 2) continue;
        const g2 = gateFramesOf(q, d);
        if (g2 >= d || (!tol && Math.abs(g2 - A) > 1)) ok = false;
      }
      if (ok) c.push({ s: q, dev });
    }
    if (D - A >= 1) c.push({ s: '@q' + (D - A), dev: 0 });
    return c;
  }

  // 出力に現れない @v/@vr の参照を落とす(2026-09-11)。抽出器は音符か休符かに関わらず音量列を
  // envReg へ登録する(sn76489.js/ay.js/scc.js/gbs・hes の toVolumeFields、nsf2mml 各拡張)ため、
  // 休符イベントに envelopeV が付くことがある。mmlEmit は休符では音量系コマンドを一切出さない
  // (note===null の分岐で continue する)ので、この参照は出力に現れない。にもかかわらず
  // compact() からは「使われている表」に見えるため、誰も参照しない @v<n> の定義だけが残り、
  // NSF書き出しのROMを無駄に食っていた(実測: After Burner II(メガドライブ)の X パートで
  // 休符1つに1200要素の @v0 が付き、定義だけが出力に残っていた)。
  // hasEnvelope が無いチャンネル(三角波など)の参照も同じ理由で出力に現れないので一緒に落とす。
  // ★compact() より前、かつ ENV_MERGE(近似統合)より前に行うこと。使われない表を「使われている」
  //   ものとして統合対象に混ぜない。
  MML.Convert.dropUnusedVolumeRefs = function (scoreChannels) {
    for (const ch of scoreChannels || []) {
      if (!ch || !ch.events) continue;
      for (const ev of ch.events) {
        if (ev.note != null && ch.hasEnvelope) continue;
        delete ev.envelopeV; delete ev.envelopeVr;
      }
    }
  };

  MML.Convert.applyNoteEnd = function (scoreChannels, envReg, cmd, fpb, srcFps) {
    const c = MML.Convert.normalizeCmd(cmd);
    const stats = { absorbed: 0, gated: 0 };
    // タイの2音目以降が自分の D<n> を持てないぶん、先頭の D で鳴らすと 10 セント以上外れる音符はタイを切る
    // (src/convert/detune.js splitSlurOnDetune)。スラー連鎖を使う以下の処理より前に行う
    if (MML.Convert.splitSlurOnDetune && c.D !== false) MML.Convert.splitSlurOnDetune(scoreChannels);
    MML.Convert.applyReleaseSplits(scoreChannels); // 印無しリリース(volumeFieldsWithRelease)の終端反映。NOTE_END に関わらず行う
    MML.Convert.dropUnusedVolumeRefs(scoreChannels); // 出力に現れない @v/@vr 参照を落とす(compact/ENV_MERGE より前)
    MML.Convert.mergeSlurVolumes(scoreChannels, envReg); // スラー連鎖の音量列を1本の表へ(同上)
    if (c.ENV_MERGE && envReg) { envReg.mergeSimilar(scoreChannels); if (envReg._release) envReg._release.mergeSimilar(scoreChannels, 'envelopeVr'); } // 近似統合(譜面整形(近似))
    if (c.NOTE_END !== 'next') { if (envReg) envReg.compact(scoreChannels); return stats; }
    const beat = fpb > 0 ? fpb : 60;
    const maxGap = beat * 2;
    const approx = !!c.GATE_APPROX;
    const tol = Math.max(0, Math.min(8, c.GATE_TOL | 0));
    const compiledFps = (MML.Mml && MML.Mml.FRAME_RATE_NTSC) || 60.0988;
    const ratio = srcFps > 0 ? compiledFps / srcFps : 1;
    const toC = (frames) => Math.max(1, Math.round(frames * ratio)); // 元曲フレーム数 → コンパイル後
    // 音長トークン数の見積もり(休符/音符を何個の音価に分けて書くことになるか)
    const lenSnap = MML.Convert.lenSnapOf(c); // 音長の丸め(LEN_SNAP)込みで mmlEmit と同じ分割数にする
    const frags = (frames) => frames <= 0 ? 0 : MML.Convert.framesToLengths(frames, beat, 0, lenSnap).lengths.length;
    const keepMargin = 2 * Math.max(1, lenSnap) + 1; // keepsFull の m(書き出す音長のずれの余裕、同所コメント)

    for (const ch of scoreChannels || []) {
      if (!ch || !ch.events) continue;
      const evs = ch.events.slice().sort((a, b) => a.start - b.start);
      const envOk = !!(c.ENV && envReg && ch.hasEnvelope && !ch.hasVrc7Tone && !KEYOFF_RELEASE_LETTERS.test(ch.letter));

      // 連鎖に分ける(休符は連鎖にしない)
      const chains = [];
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.note == null) continue;
        const prev = chains[chains.length - 1];
        if (ev.slurTie && prev && prev.lastIdx === i - 1) { prev.last = ev; prev.lastIdx = i; continue; }
        chains.push({ head: ev, last: ev, headIdx: i, lastIdx: i });
      }
      if (chains.length === 0) continue;

      const drop = new Set(); // 捨てる休符イベントの index
      const extend = (cn) => {
        cn.last.audibleEnd = cn.last.end;
        cn.last.end = cn.nextStart;
        for (let i = cn.lastIdx + 1; i < evs.length && evs[i].start < cn.nextStart; i++) if (evs[i].note == null) drop.add(i);
      };

      // 連鎖ごとの inter-onset / 可聴長 / 次の音符、(1) の適用
      for (let k = 0; k < chains.length; k++) {
        const cn = chains[k];
        const next = k + 1 < chains.length ? chains[k + 1].head : null;
        cn.A = cn.last.end - cn.head.start;
        cn.gap = next ? next.start - cn.last.end : 0;
        cn.D = next ? next.start - cn.head.start : cn.A;
        cn.Ac = toC(cn.A);                       // コンパイル後の可聴フレーム数
        cn.Dc = next ? Math.max(cn.Ac + 1, toC(cn.D)) : cn.Ac; // 同 inter-onset(隙間があれば必ず1以上残す)
        cn.nextStart = next ? next.start : null;
        cn.kind = 'tight'; // 隙間無し(レガート/曲末尾): q8 のみ
        if (next && cn.gap > 0 && cn.A >= 1) {
          // リリース表が 0 に達しないまま無音になる音符(releaseEnd、mmlEmit が k…r… で出す)は
          // ゲートで吸収すると無音区間もリリースの末尾値で鳴ってしまうので休符のまま
          if (cn.gap > maxGap || cn.head.releaseEnd != null) cn.kind = 'rest'; // 休符のまま(切らない状態のみ)
          else {
            cn.kind = 'gap';                           // 吸収候補
            if (envOk && cn.head.envelopeV != null && cn.head.envelopeVr === undefined) {
              const idx = envReg.silentTailIndex(cn.head.envelopeV, cn.A, cn.Ac);
              if (idx != null) {
                cn.head.envelopeV = idx;
                extend(cn);
                stats.absorbed++;
                cn.kind = 'env';                       // (1) 済み: ゲートオフが可聴長以降なら状態を問わない
              }
            }
            if (cn.kind === 'gap') cn.cands = gateCandidates(cn.Dc, cn.Ac, approx ? tol : 0);
          }
        }
      }

      // (2) 動的計画法: 状態=ゲートコマンド。コスト=状態コマンド数×切り替えコスト + 音長トークン数
      //   (+近似モードではキーオフ位置のずれ×GATE_DEV_COST と @q/@k のバイアス)
      //   costOf(cn, s): この連鎖を状態 s で書くコスト(不可なら null)。absorbed は伸ばすか
      const SWITCH = approx ? GATE_SWITCH_COST_APPROX : GATE_SWITCH_COST_EXACT;
      // @q<n>(ppmck 本家の q8,-n)は独自拡張の @k<n> より優先(同じずれ 0 なら @k を 2 倍重くして同点を避ける)
      const bias = (s) => !approx || s[0] !== '@' ? 0 : (s[1] === 'k' ? GATE_AT_BIAS * 2 : GATE_AT_BIAS);
      const REST = approx ? GATE_REST_COST_APPROX : 1;
      const costOf = (cn, s) => {
        if (cn.kind === 'tight') return keepsFull(s, cn.Ac, keepMargin) ? { cost: frags(cn.A), absorbed: false } : null;
        if (cn.kind === 'rest') return keepsFull(s, cn.Ac, keepMargin) ? { cost: frags(cn.A) + frags(cn.gap) * REST, absorbed: false } : null;
        if (cn.kind === 'env') {
          const g = gateFramesOf(s, cn.Dc);
          if (g >= cn.Ac) return { cost: frags(cn.D), absorbed: false };
          if (approx && cn.Ac - g <= tol) return { cost: frags(cn.D) + (cn.Ac - g) * GATE_DEV_COST, absorbed: false }; // 減衰の尾を数フレーム切るだけ
          return null;
        }
        const cand = cn.cands.find(x => x.s === s);
        if (cand) return { cost: frags(cn.D) + cand.dev * GATE_DEV_COST + bias(s), absorbed: true };
        return keepsFull(s, cn.Ac, keepMargin) ? { cost: frags(cn.A) + frags(cn.gap) * REST, absorbed: false } : null;
      };
      let prevRow = new Map([[GATE_FULL, { cost: 0, from: null, absorbed: false }]]);
      const rows = [];
      for (const cn of chains) {
        const states = new Set([GATE_FULL, ...(cn.cands || []).map(x => x.s), ...prevRow.keys()]);
        const row = new Map();
        for (const s of states) {
          const r = costOf(cn, s);
          if (!r) continue;
          let best = null;
          for (const [p, pr] of prevRow) {
            const total = pr.cost + (p === s ? 0 : SWITCH) + r.cost;
            if (!best || total < best.cost || (total === best.cost && p === s)) best = { cost: total, from: p, absorbed: r.absorbed };
          }
          if (best) row.set(s, best);
        }
        rows.push(row);
        prevRow = row;
      }
      // 終端は q8(曲末尾の連鎖は tight なので必ず q8 が残る)
      let s = GATE_FULL;
      if (!prevRow.has(s)) { // 念のため(起き得ない): 最小コストの状態から辿る
        for (const [k, v] of prevRow) if (!prevRow.has(s) || v.cost < prevRow.get(s).cost) s = k;
      }
      const chosen = new Array(chains.length);
      for (let k = chains.length - 1; k >= 0; k--) {
        const r = rows[k].get(s);
        chosen[k] = { state: s, absorbed: r.absorbed };
        s = r.from;
      }
      let state = GATE_FULL;
      for (let k = 0; k < chains.length; k++) {
        const cn = chains[k];
        if (chosen[k].absorbed) { extend(cn); stats.gated++; }
        if (chosen[k].state !== state) { cn.head.gate = chosen[k].state; state = chosen[k].state; }
      }

      if (drop.size > 0) {
        const out = evs.filter((_, i) => !drop.has(i));
        ch.events.length = 0;
        ch.events.push(...out);
      }
    }
    if (envReg) envReg.compact(scoreChannels);
    return stats;
  };

  // ── スラー連鎖の音量列連結(2026-09-08) ─────────────────────────────────────
  // タイ(&)で繋いだ連鎖はコンパイラで1セグメントになり、音量は連鎖の先頭の @v/v だけが使われる
  // (mmlEmit は slurTie の音符の前に状態コマンドを出さない)。抽出側は各音符ごとに音量列を持って
  // いるので、先頭の表を連鎖全体に当てると後続の音符の減衰が消えていた(実測: GB AMHE.gbs の
  // 波形chで 8→4→2 の減衰が 8 のまま鳴る)。連鎖の各音符が残した生の音量列(_volSeq、音符長ぶん)を
  // 繋いで1本の表として登録し直し、先頭に付ける。後続の音符の envelopeV は捨てる(出力されないので
  // compact で表も消える)。生の列が無い音符(ハードウェア減衰表、SPC)を含む連鎖は触らない
  const LOOP_APPROX_MAX_MISS = 0.15; // mergeSlurVolumes: 長い列をループ表で近似してよい食い違いの割合
  MML.Convert.mergeSlurVolumes = function (scoreChannels, envReg) {
    if (!envReg) return;
    for (const ch of scoreChannels || []) {
      if (!ch || !ch.events || !ch.hasEnvelope) continue;
      const evs = ch.events.slice().sort((a, b) => a.start - b.start);
      let i = 0;
      while (i < evs.length) {
        const head = evs[i];
        if (head.note == null) { i++; continue; }
        let j = i + 1;
        while (j < evs.length && evs[j].note != null && evs[j].slurTie) j++;
        const members = evs.slice(i, j);
        i = j;
        if (members.length < 2 || members.some(m => !m._volSeq)) continue;
        const concat = [];
        for (const m of members) {
          const len = Math.max(0, m.end - m.start);
          const s = m._volSeq;
          for (let k = 0; k < len; k++) concat.push(k < s.length ? s[k] : s[s.length - 1]);
        }
        if (concat.length === 0) continue;
        // ★ループにならず MAX_ENV_FRAMES(約3秒)より長くなる列は、先頭部分のループ表で近似できるならそうする
        //   (2026-09-20、火の鳥 鳳凰編): 分散和音のレガートで音符ごとに同じ減衰をかけ直している連鎖は、長い音符が混ざると
        //   周期の位相がずれてループにならず、360 値の表になって出力が 1597→2944 字に膨らんだ。先頭部分のループ表
        //   {| 7 7 7 7 7 7 7 7 6 5 4 3 } を連鎖全体に当てると食い違いは 5〜12% なのでそれを使う(1684 字)
        const exact = MML.Convert.analyzeVolumeShape(concat);
        let shape = exact;
        if (exact && exact.loop == null && concat.length > MAX_ENV_FRAMES) {
          // 長い音符が混ざる所で周期が崩れるので、崩れる前までの先頭部分で周期を探す(最長のものを採る)
          let pre = null;
          for (const L of [MAX_ENV_FRAMES, 150, 120, 96, 72, 48, 36]) {
            const p = L < concat.length ? MML.Convert.analyzeVolumeShape(concat.slice(0, L)) : null;
            if (p && p.loop != null) { pre = p; break; }
          }
          // ループ表を連鎖全体に当てたときの食い違いが少ない時だけ使う。多い(音符ごとにアクセントの音量が違う等、
          // TP04022.hes)なら従来どおり厳密な長い表でまとめる(音量の忠実さを大きさより優先)
          if (pre) {
            let miss = 0;
            for (let k = 0; k < concat.length; k++) {
              const v = k < pre.values.length ? pre.values[k] : pre.values[pre.loop + ((k - pre.loop) % (pre.values.length - pre.loop))];
              if (v !== concat[k]) miss++;
            }
            if (miss <= concat.length * LOOP_APPROX_MAX_MISS) shape = pre;
          }
        }
        const idx = shape === exact ? envReg.assign(concat) : envReg.registerShape(shape, false);
        if (idx == null) { delete head.envelopeV; head.volume = MML.Convert.plainVolume(concat); }
        else { head.envelopeV = idx; delete head.volume; }
        for (let k = 1; k < members.length; k++) delete members[k].envelopeV;
      }
    }
  };

  // ── 似た表の近似統合(ENV_MERGE、2026-09-08。src/convert/options.js 参照) ──────────────
  // 値の並び(連続する同値を1段にまとめた段の値列)とループ位置が同じで、各段の長さが±1・全体長も
  // ±1以内の表を1つにまとめる。残す変種は参照する音符が最も多いもの。ハードウェア減衰表(100番台)と
  // exact 表(applyNoteEnd の末尾0)は対象外。field: 音符側の参照フィールド名('envelopeV' | 'envelopeVr')
  function runsOf(values) {
    const runs = [];
    for (const v of values) { const r = runs[runs.length - 1]; if (r && r.v === v) r.len++; else runs.push({ v, len: 1 }); }
    return runs;
  }
  MML.Convert.EnvelopeRegistry.prototype.mergeSimilar = function (scoreChannels, field) {
    field = field || 'envelopeV';
    const use = new Map();
    for (const ch of scoreChannels || []) for (const ev of (ch && ch.events) || []) if (ev[field] != null) use.set(ev[field], (use.get(ev[field]) || 0) + 1);
    // グループ化: 段の値列 + ループが始まる段番号
    const groups = new Map();
    for (const [idx, t] of this.tables) {
      if (idx >= HARDWARE_INDEX_BASE || t.exact) continue;
      const runs = runsOf(t.values);
      let loopRun = '-';
      if (t.loop != null) {
        let acc = 0, k = 0;
        while (k < runs.length && acc < t.loop) { acc += runs[k].len; k++; }
        if (acc !== t.loop) continue; // ループ位置が段の途中にある表は対象外
        loopRun = String(k);
      }
      const key = runs.map(r => r.v).join(',') + '|' + loopRun;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ idx, runs, total: t.values.length, uses: use.get(idx) || 0 });
    }
    const remap = new Map();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.uses - a.uses || a.idx - b.idx);
      const canon = [];
      for (const e of list) {
        const target = canon.find(c => Math.abs(c.total - e.total) <= 1 && c.runs.every((r, i) => Math.abs(r.len - e.runs[i].len) <= 1));
        if (target) remap.set(e.idx, target.idx); else canon.push(e);
      }
    }
    if (remap.size === 0) return 0;
    for (const [from, to] of remap) {
      const t = this.tables.get(to), f = this.tables.get(from);
      t.holdLen = Math.max(t.holdLen || 0, f.holdLen || 0);
      this.tables.delete(from);
      for (const [k, v] of this.swKeyToIndex) if (v === from) this.swKeyToIndex.delete(k);
    }
    for (const ch of scoreChannels || []) for (const ev of (ch && ch.events) || []) if (ev[field] != null && remap.has(ev[field])) ev[field] = remap.get(ev[field]);
    return remap.size;
  };

  MML.Convert.EnvelopeRegistry.prototype.defLines = function () {
    const lines = Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      return `${this.prefix}${i} = { ${parts.join(' ')} }`;
    });
    // 自分が持つリリース表(@vr、release 参照)も続けて出す(呼び出し側の headerLines を変えずに済む)
    if (this._release) lines.push(...this._release.defLines());
    return lines;
  };

  // ── 印無しのリリース切り出し(全形式、2026-09-08) ─────────────────────────────
  // 音量列 seq の「サステイン(2フレーム以上同じ値)の後、そのまま終わりまで下がり続ける尾」を
  // リリースとみなし、その開始位置(keyOffAt)を返す。無ければ null。
  //   条件: 尾は非増加で、サステインからの最初の落差が 2 以上、または(サステインが 3 フレーム以上・
  //   尾が 2 フレーム以上で)尾の最後がサステインの 1/3 以下。尾が全部 0 なら null(ただの無音)。
  // 目的: ADSR 型のドライバ(PC エンジン/MSX/GB 等、キーオンの印が無いチップ)の「同じ楽器で
  // サステイン長だけ違う音符」が、サステイン長ごとに別の @v 表になる量産を防ぐ。本体は @v(ループ
  // 検出でサステインが | 保持になる)、尾は共有の @vr になり、音符長=キーオフ位置+k<len> か
  // NOTE_END のゲートで再現する(音は変わらない)。単調減衰だけの音符(プラトー無し)やトレモロ
  // (非増加でない)は対象外。2A03 は $4003 の打ち直しという印(nsf2mml Instrument)を優先し、
  // 無ければこれを使う
  MML.Convert.detectRelease = function (seq) {
    const n = seq ? seq.length : 0;
    if (n < 4) return null;
    let t = n - 1;
    while (t > 0 && seq[t - 1] >= seq[t]) t--;   // seq[t..] = 最長の非増加サフィックス
    // サフィックス内の等値ラン
    const runs = [];
    for (let i = t; i < n; i++) {
      const r = runs[runs.length - 1];
      if (r && r.v === seq[i]) r.len++; else runs.push({ v: seq[i], len: 1, at: i });
    }
    for (let k = runs.length - 2; k >= 0; k--) {
      const p = runs[k];
      if (p.len < 2) continue;
      const keyOff = p.at + p.len;
      if (keyOff < 2) break;
      const tail = seq.slice(keyOff);
      if (tail.every(v => v === 0)) return null;
      // 尾が短い(3フレーム未満)ものは切り出さない: 音符+k<len> の2トークンに分けると音価の丸め(carry)で
      // 本体/尾の境界が±1フレーム動く(表の中に持てばキーオンからのフレーム数で正確)。1〜2フレームの
      // 尾では表の共有もほとんど増えないので、旧来どおり @v 表の末尾に置く
      if (tail.length < 3) return null;
      const drop = p.v - tail[0];
      const last = tail[tail.length - 1];
      if (drop >= 2 || (p.len >= 3 && tail.length >= 2 && last * 3 <= p.v)) return keyOff;
      return null; // 直近のプラトーで条件を満たさなければ、それより前は「サステイン中の段」なので見ない
    }
    return null;
  };
  // リリース表の登録先(遅延生成。defLines が一緒に出す)
  Object.defineProperty(MML.Convert.EnvelopeRegistry.prototype, 'release', {
    get() {
      if (!this._release) this._release = new MML.Convert.EnvelopeRegistry(this.cmd, '@vr');
      return this._release;
    }
  });
  // リリース列の末尾に 0 を足す(2026-09-08): 音符が無音で終わっていて(endedSilent)、リリースの最後の
  // 段が短い(末尾値の連続が RELEASE_TAIL_ZERO_MAX 以下)なら、その無音はリリース表の最終段 0 そのもの
  // ({4 4 3 2} → {4 4 3 2 0})。0 を足せば「表が 0 に達しないまま無音」(releaseEnd、k…r… 書き)に
  // ならず、音符をゲートで伸ばして q<n> だけで書ける。末尾値を長く保持してから切れる列は、0 を足すと
  // 保持長ごとに表が量産されるので足さない(呼び出し側が releaseEnd を付ける)
  const RELEASE_TAIL_ZERO_MAX = 3;
  MML.Convert.releaseWithZero = function (rel, endedSilent) {
    if (!endedSilent || !rel || rel.length === 0 || rel[rel.length - 1] === 0) return rel;
    let run = 1;
    while (run < rel.length && rel[rel.length - 1 - run] === rel[rel.length - 1]) run++;
    return run <= RELEASE_TAIL_ZERO_MAX ? [...rel, 0] : rel;
  };
  // 音量列 → { volume | envelopeV, envelopeVr?, keyOffAt?, releaseTailLast? }
  // keyOffAt が付いた音符は applyReleaseSplits(applyNoteEnd 冒頭)で終端をキーオフ位置へ縮め、
  // リリースが 0 に達しないまま次が休符なら releaseEnd を付ける(mmlEmit が k…r… で出す)
  MML.Convert.EnvelopeRegistry.prototype.volumeFieldsWithRelease = function (seq) {
    if (this.cmd.ENV) {
      const keyOff = MML.Convert.detectRelease(seq);
      if (keyOff != null) {
        const body = seq.slice(0, keyOff);
        const rel = seq.slice(keyOff);
        const vrIdx = this.release.assignHold(rel);
        if (vrIdx != null) {
          const idx = this.assign(body);
          const fields = idx == null ? { volume: MML.Convert.plainVolume(body) } : { envelopeV: idx };
          fields.envelopeVr = vrIdx;
          fields.keyOffAt = keyOff;
          fields.releaseTailLast = rel[rel.length - 1];
          fields._relReg = this;   // applyReleaseSplits が分割を取り消すとき(次がレガート)に全体を登録し直す用
          fields._volSeq = seq;
          return fields;
        }
      }
    }
    const idx = this.assign(seq);
    const fields = idx == null ? { volume: MML.Convert.plainVolume(seq) } : { envelopeV: idx };
    fields._volSeq = seq; // スラー連鎖の音量連結(mergeSlurVolumes)用に生の列を残す
    return fields;
  };
  // volumeFieldsWithRelease が付けた keyOffAt を音符の終端へ反映する(全形式共通の後処理)
  MML.Convert.applyReleaseSplits = function (scoreChannels) {
    for (const ch of scoreChannels || []) {
      if (!ch || !ch.events) continue;
      const evs = ch.events.slice().sort((a, b) => a.start - b.start);
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.keyOffAt == null) continue;
        const keyOffAt = ev.keyOffAt, tailLast = ev.releaseTailLast, reg = ev._relReg, seq = ev._volSeq;
        delete ev.keyOffAt; delete ev.releaseTailLast; delete ev._relReg; // _volSeq は mergeSlurVolumes が使うので残す
        if (!ch.hasEnvelope || ev.note == null) { delete ev.envelopeVr; continue; }
        const next = evs[i + 1];
        // 次の音符がレガート(slurTie、markSlurTies は分割前の終端で判定済み)なら分割しない: 尾を
        // 切り出すと尾の後に再アタックが入り、元の「音量が下がったまま音程だけ変わる」レガートが
        // 壊れる。全体の音量列を登録し直して従来どおり1本の @v にする
        if (next && next.note != null && next.slurTie && reg && seq) {
          delete ev.envelopeVr;
          const idx = reg.assign(seq);
          if (idx == null) { delete ev.envelopeV; ev.volume = MML.Convert.plainVolume(seq); }
          else { ev.envelopeV = idx; delete ev.volume; }
          continue;
        }
        const nextIsRest = !next || next.note == null;
        if (nextIsRest && tailLast !== 0) {
          // 無音で終わる音符: リリースの最終段が短ければ表に 0 を足して登録し直す(releaseWithZero)
          const rel = reg && seq ? MML.Convert.releaseWithZero(seq.slice(keyOffAt), true) : null;
          const vr = rel && rel[rel.length - 1] === 0 ? reg.release.assignHold(rel) : null;
          if (vr != null) ev.envelopeVr = vr; else ev.releaseEnd = ev.end;
        }
        ev.audibleEnd = undefined;
        ev.end = ev.start + keyOffAt;
        if (next && next.note != null && next.start < ev.end) ev.end = next.start;
        // この音符がスラー連鎖の途中/末尾なら、@vr は連鎖の先頭に付ける(mmlEmit は slurTie の音符の
        // 前に状態コマンドを出さない。コンパイラは連鎖を1セグメントにするのでゲートオフ=この音符の
        // 終端でリリースが鳴る)
        let h = i;
        while (h > 0 && evs[h].slurTie) h--;
        if (h !== i) { evs[h].envelopeVr = ev.envelopeVr; if (ev.releaseEnd != null) evs[h].releaseEnd = ev.releaseEnd; }
      }
    }
  };

})(window);
