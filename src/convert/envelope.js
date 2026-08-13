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
    return { values: seq.slice(0, end), loop: null };
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

  MML.Convert.EnvelopeRegistry = function () {
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

  // 既に確定した shape({values,loop})を登録し番号を返す(重複排除)。
  // hardware=true ならHARDWARE_INDEX_BASE以降、falseなら0番から採番する。
  MML.Convert.EnvelopeRegistry.prototype.registerShape = function (shape, hardware) {
    if (!shape) return null;
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
      if (existing.loop != null || shape.loop != null) continue;
      if (isPrefix(existing.values, shape.values)) {
        if (shape.values.length > existing.values.length) this.tables.set(idx, shape);
        return idx;
      }
      if (isPrefix(shape.values, existing.values)) return idx;
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
    return this.registerShape(MML.Convert.analyzeVolumeShape(seq), false);
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

  MML.Convert.EnvelopeRegistry.prototype.defLines = function () {
    return Array.from(this.tables.keys()).sort((a, b) => a - b).map(i => {
      const t = this.tables.get(i);
      const parts = t.values.map(String);
      if (t.loop != null) parts.splice(t.loop, 0, '|');
      return `@v${i} = { ${parts.join(' ')} }`;
    });
  };

})(window);
