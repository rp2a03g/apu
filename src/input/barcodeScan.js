/*
 * カメラの絵から JAN/EAN バーコード(13 桁・8 桁)を読む MML.Input.BarcodeScan
 *
 *   scanRow(lum, n)                明るさ 1 行(Uint8Array、長さ n)から数字を読む。読めなければ null
 *   scanImage(rgba, width, height) 画像(RGBA)の中ほどの何行かを試す。読めた数字か null
 *
 * 1 行ごとに: 明るさを黒白に分ける(その行の最小と最大の中間。影のある絵用に 3 通りのしきい値)→ 幅の並びにする →
 * 開始ガード(黒 白 黒がほぼ同じ幅)の候補ごとに ean.js の decodeRuns で読む。左右どちら向きでも読めるように逆順も試す。
 * 検査数字が合った物だけを返すので、誤読はまず出ない(読めないことはある)。
 * DOM 非依存(絵は呼び出し側が ImageData などで渡す)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Input = MML.Input = MML.Input || {};

  function runsOf(lum, n, thr, reverse) {
    const runs = [];
    let cur = -1, len = 0;
    for (let k = 0; k < n; k++) {
      const v = lum[reverse ? n - 1 - k : k] < thr ? 1 : 0;
      if (v === cur) len++;
      else { if (cur >= 0) runs.push(len); cur = v; len = 1; }
    }
    runs.push(len);
    return { runs, firstDark: lum[reverse ? n - 1 : 0] < thr };
  }
  function scanRow(lum, n) {
    const Ean = MML.Emu && MML.Emu.Ean;
    if (!Ean) return null;
    let lo = 255, hi = 0;
    for (let k = 0; k < n; k++) { const v = lum[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 40) return null; // のっぺりした行
    for (const f of [0.5, 0.4, 0.6]) {
      const thr = lo + (hi - lo) * f;
      for (let rev = 0; rev < 2; rev++) {
        const { runs, firstDark } = runsOf(lum, n, thr, rev === 1);
        // 黒の並びは firstDark なら偶数番目、でなければ奇数番目
        for (let i = firstDark ? 0 : 1; i + 30 < runs.length; i += 2) {
          if (i > 0 && runs[i - 1] < runs[i] * 2) continue; // 手前に余白が無い
          const d = Ean.decodeRuns(runs, i);
          if (d) return d;
        }
      }
    }
    return null;
  }
  function scanImage(rgba, width, height) {
    const lum = new Uint8Array(width);
    const rows = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75];
    for (const r of rows) {
      const y = Math.min(height - 1, Math.max(0, Math.round(height * r)));
      // 縦に 3 行ならして雑音を減らす
      for (let x = 0; x < width; x++) {
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= height) continue; const o = (yy * width + x) * 4; s += rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29; c++; }
        lum[x] = (s / c) >> 8;
      }
      const d = scanRow(lum, width);
      if (d) return d;
    }
    return null;
  }

  Input.BarcodeScan = { scanRow, scanImage };
})(typeof window !== 'undefined' ? window : globalThis);
