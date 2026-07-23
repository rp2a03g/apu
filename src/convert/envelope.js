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

  const MAX_ENV_FRAMES     = 180; // ループが見つからない場合の上限(SPC変換と同じ約3秒分)
  const MIN_LOOP_PERIOD    = 2;   // 周期1は単なる単一値(=フラット)と区別がつかないので除外
  const MAX_LOOP_PERIOD    = 48;  // これより長い周期は音量ビブラートとしては非現実的
  const MIN_LOOP_REPEATS   = 3;   // 誤検出防止のため最低3周期分の一致を要求する
  const MAX_LOOP_SEARCH_START = 96; // ループ開始位置の探索上限(アタック直後からの範囲で十分)
  const HARDWARE_INDEX_BASE = 100; // ハードウェア減衰エンベロープの採番開始番号

  function isPeriodicFrom(seq, start, period) {
    for (let i = start + period; i < seq.length; i++) {
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
    // ループ無し: 減衰/単発の音量変化として全フレームを記録(末尾保持)
    return { values: seq.slice(0, MAX_ENV_FRAMES), loop: null };
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

  // 既に確定した shape({values,loop})を登録し番号を返す(重複排除)。
  // hardware=true ならHARDWARE_INDEX_BASE以降、falseなら0番から採番する。
  MML.Convert.EnvelopeRegistry.prototype.registerShape = function (shape, hardware) {
    if (!shape) return null;
    const keyMap = hardware ? this.hwKeyToIndex : this.swKeyToIndex;
    const key = shapeKey(shape);
    let idx = keyMap.get(key);
    if (idx === undefined) {
      idx = hardware ? this.nextHwIndex++ : this.nextSwIndex++;
      keyMap.set(key, idx);
      this.tables.set(idx, shape);
    }
    return idx;
  };

  // seq(生音量値の配列)を解析して登録し、テーブル番号を返す。フラットなら null(呼び出し側で
  // volume を使うべき合図)。同一形状は曲全体を通して番号を再利用する(ソフトウェア=0番台)。
  MML.Convert.EnvelopeRegistry.prototype.assign = function (seq) {
    return this.registerShape(MML.Convert.analyzeVolumeShape(seq), false);
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
