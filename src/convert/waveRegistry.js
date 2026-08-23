/*
 * 波形メモリ(FDS @FM<n> / N163 @N<n>)を曲全体で重複排除して登録する共有レジストリ。
 * 音量エンベロープ(envelope.js)と違って形状解析(ループ判定等)は不要で、完全一致の
 * 配列だけを同一番号にまとめる単純な辞書引きでよい。
 *
 * MML.Convert.WaveRegistry(prefix, formatValues?)
 *   prefix       … 定義行の先頭('@FM' / '@N')
 *   formatValues … (値配列, 定義番号, 全波形配列) → 出力用配列 への変換(省略時はそのまま)。
 *                  第2/第3引数は「他の波形の内容も見ないと決まらない値」(N163の
 *                  バッファ番号)のためにある。
 *
 * N163の@N<n>定義は先頭にバッファ番号を1つ要求する(src/mml/lexer.js parseN163WaveDef)。
 * このツールでは読み捨てられるが、出力MMLを本家ppmckへ持って行った時のために
 * MML.Convert.n163WaveRegistry()が準互換の番号を振る(src/mml/n163Alloc.js参照)。
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
    return this.waves.map((values, i) =>
      `${this.prefix}${i} = { ${this.formatValues(values, i, this.waves).join(' ')} }`);
  };

  // N163(@N<n>)用のレジストリ。先頭のバッファ番号は書き出す時に、全波形の長さを見て
  // 本家ppmckでなるべく踏み合わない値を割り当てる(このツールの再生・NSF書き出しは
  // この値を読まない。MML.N163Alloc.ppmckBufferNumbers参照)
  MML.Convert.n163WaveRegistry = function () {
    let buffers = null, computedFor = -1; // 1行ごとに全体を再計算しないためのメモ(波形は増える一方)
    return new MML.Convert.WaveRegistry('@N', (values, index, waves) => {
      if (computedFor !== waves.length) {
        buffers = MML.N163Alloc.ppmckBufferNumbers(waves);
        computedFor = waves.length;
      }
      return [buffers[index], ...values];
    });
  };

})(window);
