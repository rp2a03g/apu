/*
 * JAN/EAN バーコード(13 桁・8 桁)の共通部品 MML.Emu.Ean
 *
 * ゲームボーイのバーコードボーイ、ファミコンのデータック(マッパー 157)とバーコードバトラー II、カメラ読み取り(input/barcodeScan.js)が使う。
 *   check(digits)        検査数字が合っているか(13 桁か 8 桁)
 *   withCheck(digits)    12 桁/7 桁なら検査数字を足して返す
 *   modules(digits)      バーの並び(1 = 黒、0 = 白)。13 桁は 95 個、8 桁は 67 個(左右の余白は含まない)
 *   decodeRuns(runs, i)  黒白の幅の並び(runs[i] が開始ガードの最初の黒)から数字を読む(カメラ読み取り用)。読めなければ null
 * DOM 非依存。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 左側の奇数パリティ(L)の幅 4 本(白 黒 白 黒、合計 7)。偶数パリティ(G)は逆順、右側(R)は同じ幅で黒から始まる
  const L_WIDTHS = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'];
  // 13 桁の先頭の数字 = 左 6 桁のパリティの並び(0 = L、1 = G)
  const PARITY = ['000000', '001011', '001101', '001110', '010011', '011001', '011100', '010101', '010110', '011010'];

  const clean = (d) => String(d == null ? '' : d).replace(/\D/g, '');
  function checkDigit(body) { // body = 検査数字を除いた 12 桁か 7 桁
    let sum = 0;
    for (let i = 0; i < body.length; i++) { const w = ((body.length - i) & 1) ? 3 : 1; sum += (body.charCodeAt(i) - 48) * w; }
    return (10 - (sum % 10)) % 10;
  }
  function check(digits) {
    const s = clean(digits);
    if (s.length !== 13 && s.length !== 8) return false;
    return checkDigit(s.slice(0, -1)) === s.charCodeAt(s.length - 1) - 48;
  }
  function withCheck(digits) {
    const s = clean(digits);
    return s.length === 12 || s.length === 7 ? s + checkDigit(s) : s;
  }
  function pushWidths(out, widths, first) { let v = first; for (let i = 0; i < 4; i++) { for (let k = widths.charCodeAt(i) - 48; k > 0; k--) out.push(v); v ^= 1; } }
  function modules(digits) {
    const s = clean(digits), out = [];
    if (s.length !== 13 && s.length !== 8) return null;
    out.push(1, 0, 1);
    if (s.length === 13) {
      const par = PARITY[s.charCodeAt(0) - 48];
      for (let i = 0; i < 6; i++) { const w = L_WIDTHS[s.charCodeAt(1 + i) - 48]; pushWidths(out, par[i] === '1' ? w.split('').reverse().join('') : w, 0); }
      out.push(0, 1, 0, 1, 0);
      for (let i = 0; i < 6; i++) pushWidths(out, L_WIDTHS[s.charCodeAt(7 + i) - 48], 1);
    } else {
      for (let i = 0; i < 4; i++) pushWidths(out, L_WIDTHS[s.charCodeAt(i) - 48], 0);
      out.push(0, 1, 0, 1, 0);
      for (let i = 0; i < 4; i++) pushWidths(out, L_WIDTHS[s.charCodeAt(4 + i) - 48], 1);
    }
    out.push(1, 0, 1);
    return out;
  }

  // 幅 4 本(画素)を 7 モジュールに割り付けて '3211' の形にする
  function normalize(runs, at) {
    const total = runs[at] + runs[at + 1] + runs[at + 2] + runs[at + 3];
    if (!(total > 0)) return null;
    const unit = total / 7, e = [0, 0, 0, 0], r = [0, 0, 0, 0];
    let sum = 0;
    for (let i = 0; i < 4; i++) { e[i] = runs[at + i] / unit; r[i] = Math.max(1, Math.min(4, Math.round(e[i]))); sum += r[i]; }
    for (let guard = 0; sum !== 7 && guard < 6; guard++) {
      let best = -1, bestV = -Infinity;
      for (let i = 0; i < 4; i++) { const v = sum > 7 ? r[i] - e[i] : e[i] - r[i]; if (v > bestV && (sum > 7 ? r[i] > 1 : r[i] < 4)) { bestV = v; best = i; } }
      if (best < 0) return null;
      if (sum > 7) { r[best]--; sum--; } else { r[best]++; sum++; }
    }
    return sum === 7 ? '' + r[0] + r[1] + r[2] + r[3] : null;
  }
  // 開始ガード(黒 白 黒)が runs[i] から始まるとして数字を読む。len = 13 か 8
  function decodeAt(runs, i, len) {
    const half = len === 13 ? 6 : 4, need = 3 + half * 4 + 5 + half * 4 + 3;
    if (i + need > runs.length) return null;
    const unit = (runs[i] + runs[i + 1] + runs[i + 2]) / 3;
    for (let k = 0; k < 3; k++) if (runs[i + k] < unit * 0.4 || runs[i + k] > unit * 1.8) return null;
    let p = i + 3, digits = '', par = '';
    for (let d = 0; d < half; d++, p += 4) {
      const w = normalize(runs, p);
      if (!w) return null;
      let v = L_WIDTHS.indexOf(w), g = false;
      if (v < 0) { v = L_WIDTHS.indexOf(w.split('').reverse().join('')); g = true; }
      if (v < 0 || (g && len === 8)) return null;
      digits += v; par += g ? '1' : '0';
    }
    for (let k = 0; k < 5; k++) if (runs[p + k] > unit * 2.2) return null; // 中央ガード
    p += 5;
    for (let d = 0; d < half; d++, p += 4) {
      const w = normalize(runs, p);
      if (!w) return null;
      const v = L_WIDTHS.indexOf(w);
      if (v < 0) return null;
      digits += v;
    }
    if (len === 13) { const first = PARITY.indexOf(par); if (first < 0) return null; digits = first + digits; }
    return check(digits) ? digits : null;
  }
  function decodeRuns(runs, i) { return decodeAt(runs, i, 13) || decodeAt(runs, i, 8); }

  Emu.Ean = { check, withCheck, modules, decodeRuns, clean };
})(typeof window !== 'undefined' ? window : globalThis);
