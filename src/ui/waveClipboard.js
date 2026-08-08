/*
 * 波形データの汎用クリップボード
 * MML.UI.WaveClipboard
 *
 * 要素数・値域が異なる波形テーブル間(FDS波形メモリ64/変調カーブ、N163波形16、
 * 鍵盤表示の大波形プレビュー等)でもコピー&ペーストできるようにする。
 *
 * 保存方式: アプリ内メモリ(モジュール変数)を主として使う。OSクリップボード
 * (navigator.clipboard)はページにフォーカスが無い/権限が無いと書き込み・
 * 読み取りが黙って失敗し、貼り付け時に古い無関係な内容を数値列として誤読して
 * 「平坦な波形になる」といった不具合につながったため、主経路には使わない
 * (アプリ外へのコピー用に、書き込みだけは失敗を無視するベストエフォートで
 * 併用する。読み取りはアプリ内に何もコピーされていない場合のみのフォールバック)。
 *
 * コピー時は要素数・値をそのまま保持し、変換(要素数・値域の近似)は
 * 貼り付け時にのみ行う。今後追加する波形エディタも同じcopyValues()/
 * pasteValues()を呼ぶだけで相互コピペに参加できる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  let stored = null; // { values: number[] } 直近コピーした波形(要素数・値はコピー時のまま)

  function parseMmlNumber(s) {
    if (s[0] === '$') return parseInt(s.slice(1), 16);
    return parseInt(s, 10);
  }

  function parseValuesText(text) {
    return text.trim().split(/[\s,]+/).filter(s => s.length > 0)
      .map(parseMmlNumber).filter(n => !isNaN(n));
  }

  function formatValuesText(values) {
    return values.join(', ');
  }

  // 元データの実際の最小/最大値を自動検出し、目標の要素数・値域へ近似変換する
  // (要素数・値域が一致しなくても「近い形」で貼り付けられるようにする)。
  // 要素数(インデックス軸)は最近傍で選ぶ(線形補間すると矩形波の立ち上がり/立ち下がりが
  // なだらかな斜めになってしまう=チップ音源のウェーブテーブルは元々階段状のため)
  function resample(values, targetLength, targetMin, targetMax) {
    if (!values || values.length === 0) return new Array(targetLength).fill(0);
    let srcMin = Math.min(...values), srcMax = Math.max(...values);
    if (srcMax === srcMin) { srcMin -= 1; srcMax += 1; } // 定数波形でのゼロ除算防止
    const out = new Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      const srcPos = targetLength === 1 ? 0 : Math.round((i * (values.length - 1)) / (targetLength - 1));
      const normalized = (values[srcPos] - srcMin) / (srcMax - srcMin);
      let v = Math.round(targetMin + normalized * (targetMax - targetMin));
      v = Math.max(targetMin, Math.min(targetMax, v));
      out[i] = v;
    }
    return out;
  }

  // 要素数・値はコピー時のまま保持する(変換は貼り付け時にのみ行う)
  async function copyValues(values) {
    stored = { values: values.slice() };
    // アプリ外への参考コピーとしてOSクリップボードへも書き込みを試みるが、
    // 失敗しても無視する(アプリ内貼り付けはstoredを使うため影響しない)
    try { await navigator.clipboard.writeText(formatValuesText(values)); } catch (e) { /* ignore */ }
    return true;
  }

  function hasData() {
    return !!stored;
  }

  // アプリ内にコピー済みの波形があればそれを、無ければOSクリップボードの
  // テキストをベストエフォートで読み取り、targetLength個・[targetMin,targetMax]の
  // 範囲へ近似変換して返す。どちらも無ければnull
  async function pasteValues(targetLength, targetMin, targetMax) {
    if (stored) return resample(stored.values, targetLength, targetMin, targetMax);
    try {
      const text = await navigator.clipboard.readText();
      const values = parseValuesText(text);
      if (values.length > 0) return resample(values, targetLength, targetMin, targetMax);
    } catch (e) { /* ignore */ }
    return null;
  }

  UI.WaveClipboard = { resample, copyValues, pasteValues, hasData, parseValuesText, formatValuesText };
})(window);
