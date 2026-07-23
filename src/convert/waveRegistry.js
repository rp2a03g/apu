/*
 * 波形メモリ(FDS @FM<n> / N163 @N<n>)を曲全体で重複排除して登録する共有レジストリ。
 * 音量エンベロープ(envelope.js)と違って形状解析(ループ判定等)は不要で、完全一致の
 * 配列だけを同一番号にまとめる単純な辞書引きでよい。
 *
 * MML.Convert.WaveRegistry(prefix, formatValues?)
 *   prefix       … 定義行の先頭('@FM' / '@N')
 *   formatValues … 登録済みの値配列 → 出力用配列 への変換(省略時はそのまま)。
 *                  N163の@N<n>定義は先頭に読み飛ばされるバッファ番号を1つ要求する
 *                  (src/mml/lexer.js parseN163WaveDef参照)ため、これで補う。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  MML.Convert.WaveRegistry = function (prefix, formatValues) {
    this.prefix = prefix;
    this.formatValues = formatValues || (v => v);
    this.waves = [];          // [values] (index = 定義番号)
    this.keyToIndex = new Map();
  };

  // values(生の波形サンプル配列)を登録し、番号を返す。同一配列は曲全体で番号を再利用する。
  MML.Convert.WaveRegistry.prototype.assign = function (values) {
    const key = values.join(',');
    let idx = this.keyToIndex.get(key);
    if (idx === undefined) {
      idx = this.waves.length;
      this.keyToIndex.set(key, idx);
      this.waves.push(values);
    }
    return idx;
  };

  MML.Convert.WaveRegistry.prototype.defLines = function () {
    return this.waves.map((values, i) => `${this.prefix}${i} = { ${this.formatValues(values).join(' ')} }`);
  };

})(window);
