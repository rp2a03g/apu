/*
 * VRC7(OPLL) 音色エディタの「出力波形からの逆算」
 * MML.UI.Vrc7ToneSolver
 *
 * 目標の1周期波形(手描き / 倍音バー)に近い音になる 2オペFMのパラメータ
 * {DM, DC, MLm, MLc, FB, TL} を総当たりで探す。
 *
 * 照合は**倍音の振幅**(位相を捨てる)で行う。理由:
 *   - 位相は聴感にほぼ効かないのに、時間領域で照合すると同じ音が「形が違う」と
 *     はねられる(手描きの波形は位相まで正確に描けない)
 *   - 時間シフトに不変なので、切り出し位置を合わせる必要がない
 *
 * ★候補の波形は「普通のsin(θc + I·sin(θm))」ではなく **Nuked-OPLL の演算そのもの**
 * (LOGSIN→EXPROM の対数経路、9bit出力を<<1して位相へ、帰還は直前2出力の平均>>(7-FB)、
 * 半波整流)を定常状態で回して作る(Emu.OPLLNuked.opOut)。浮動小数のsinモデルで作ると
 * 実チップと一致率0.3〜0.6しか出ず、探索が正しい答えを最良と判定できなかった
 * (実測 2026-09-06: 厳密モデルなら TL24〜40 で 0.999〜1.000)。
 *
 * ここは純粋な計算だけ(DOM非依存)。ヘッドレス点検(tools/headless/check-all.js)からも
 * 呼べるように、時間スライス無しの同期版 searchSync も持つ。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  const N = 128;   // 1周期のサンプル数
  const H = 16;    // 照合する倍音の数
  const PG_MULTI = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]; // ×0.5(vrc7.js/opllNuked.jsと同じ)

  // DFT用のcos/sin表(N×H)
  const COS = new Float64Array((H + 1) * N), SIN = new Float64Array((H + 1) * N);
  for (let k = 1; k <= H; k++) for (let i = 0; i < N; i++) {
    COS[k * N + i] = Math.cos(2 * Math.PI * k * i / N);
    SIN[k * N + i] = Math.sin(2 * Math.PI * k * i / N);
  }

  const opOut = () => MML.Emu && MML.Emu.OPLLNuked && MML.Emu.OPLLNuked.opOut;

  // ── 定常状態の1周期 ──────────────────────────────────────────────
  // 変調波(モジュレータ)の出力列。帰還を定常化するため3周期回して最後の1周期を返す
  function modCycle(dm, mlm, fb, tl, out) {
    const op = opOut();
    const m = out || new Int32Array(N);
    let fb1 = 0, fb2 = 0;
    const eg = tl << 1;                    // eg_out = TL<<1(KSL/EGレベル0)
    for (let n = 0; n < 3 * N; n++) {
      const pm = Math.floor((n % N) / N * PG_MULTI[mlm] * 512) & 0x3ff;
      const modIn = fb ? (((fb1 + fb2) >> 1) >> (7 - fb)) : 0;
      const v = op((pm + modIn) & 0x3ff, eg, dm);
      fb2 = fb1; fb1 = v;
      if (n >= 2 * N) m[n - 2 * N] = v;
    }
    return m;
  }
  // 搬送波(キャリア)の出力列(=チップ出力)。変調波の9bit出力を<<1して位相へ足す
  function carCycle(m, dc, mlc, out) {
    const op = opOut();
    const c = out || new Float64Array(N);
    for (let n = 0; n < N; n++) {
      const pc = Math.floor(n / N * PG_MULTI[mlc] * 512) & 0x3ff;
      c[n] = op((pc + ((m[n] & 0x1ff) << 1)) & 0x3ff, 0, dc) >> 3;
    }
    return c;
  }
  function steadyCycle(dm, dc, mlm, mlc, fb, tl) {
    return carCycle(modCycle(dm, mlm, fb, tl), dc, mlc);
  }

  // ── スペクトル ──────────────────────────────────────────────────
  // 倍音1..Hの振幅(L2正規化)と位相
  function analyze(x) {
    const mag = new Float64Array(H + 1), phase = new Float64Array(H + 1);
    let e = 0;
    for (let k = 1; k <= H; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) { re += x[i] * COS[k * N + i]; im -= x[i] * SIN[k * N + i]; }
      mag[k] = Math.hypot(re, im); phase[k] = Math.atan2(im, re); e += mag[k] * mag[k];
    }
    e = Math.sqrt(e) || 1;
    for (let k = 1; k <= H; k++) mag[k] /= e;
    return { mag, phase };
  }
  // 振幅だけの距離(照合用)。magはL2正規化済みなので 0(同じ)〜√2(無相関)
  function magDist(mag, x) {
    let e = 0, d = 0;
    const m = new Float64Array(H + 1);
    for (let k = 1; k <= H; k++) {
      let re = 0, im = 0;
      const o = k * N;
      for (let i = 0; i < N; i++) { re += x[i] * COS[o + i]; im += x[i] * SIN[o + i]; }
      m[k] = Math.sqrt(re * re + im * im); e += m[k] * m[k];
    }
    e = Math.sqrt(e) || 1;
    for (let k = 1; k <= H; k++) { const t = m[k] / e - mag[k]; d += t * t; }
    return Math.sqrt(d);
  }
  // 倍音から1周期を合成(ピークを1に正規化)
  function synth(mag, phase) {
    const x = new Float64Array(N);
    let p = 0;
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let k = 1; k <= H; k++) v += mag[k] * Math.cos(2 * Math.PI * k * i / N + phase[k]);
      x[i] = v; p = Math.max(p, Math.abs(v));
    }
    if (p > 0) for (let i = 0; i < N; i++) x[i] /= p;
    return x;
  }
  // 任意長の1周期をN点へ線形補間
  function resample(src, n) {
    const out = new Float64Array(n || N), L = src.length;
    for (let i = 0; i < out.length; i++) {
      const t = i / out.length * L, a = Math.floor(t), f = t - a;
      out[i] = src[a % L] * (1 - f) + src[(a + 1) % L] * f;
    }
    return out;
  }
  // 時間領域の一致率: 円環シフトと極性を総当たりした最良の正規化相関(0〜1)
  function corr(a, b) {
    let best = 0, ea = 0, eb = 0;
    for (let i = 0; i < N; i++) { ea += a[i] * a[i]; eb += b[i] * b[i]; }
    const den = Math.sqrt(ea * eb) || 1;
    for (let s = 0; s < N; s++) {
      let d = 0;
      for (let i = 0; i < N; i++) d += a[i] * b[(i + s) % N];
      const c = Math.abs(d) / den;
      if (c > best) best = c;
    }
    return best;
  }

  // ── 探索 ───────────────────────────────────────────────────────
  // 粗: TL 4刻み × 全 DM/DC/MLm/MLc/FB(115200候補) → 上位 coarseTop を TL±3 で細かく →
  // 上位 keep を返す。変調波の列は (DM,MLm,FB,TL) ごとに1回だけ作り、(DC,MLc) は使い回す。
  // ★ML=0(×0.5)は両オペレータとも探索から外す。周期が2倍(=1オクターブ下)になり、1周期の
  //   窓では半分しか見えないのに「形」が目標に似て最良に選ばれてしまう(ノコギリ波を描いたら
  //   ML0.5:0.5 が一致率90%で1位になった実例)。音の高さが変わる候補は答えとして不適
  const TL_STEP = 4;
  function* candidates(targetMag, coarseTop, keep, onProgress) {
    const m = new Int32Array(N), c = new Float64Array(N);
    const coarse = [];
    const total = 2 * 15 * 8 * (64 / TL_STEP);
    let done = 0;
    for (let dm = 0; dm < 2; dm++) for (let mlm = 1; mlm < 16; mlm++) for (let fb = 0; fb < 8; fb++) for (let tl = 0; tl < 64; tl += TL_STEP) {
      modCycle(dm, mlm, fb, tl, m);
      for (let dc = 0; dc < 2; dc++) for (let mlc = 1; mlc < 16; mlc++) {
        carCycle(m, dc, mlc, c);
        coarse.push({ dist: magDist(targetMag, c), dm, dc, mlm, mlc, fb, tl });
      }
      done++;
      if ((done & 63) === 0) { if (onProgress) onProgress(done / total * 0.9); yield; }
    }
    coarse.sort((a, b) => a.dist - b.dist);
    const fine = [];
    const seen = new Set();
    for (const s of coarse.slice(0, coarseTop)) {
      for (let tl = Math.max(0, s.tl - TL_STEP + 1); tl <= Math.min(63, s.tl + TL_STEP - 1); tl++) {
        const key = [s.dm, s.dc, s.mlm, s.mlc, s.fb, tl].join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        modCycle(s.dm, s.mlm, s.fb, tl, m); carCycle(m, s.dc, s.mlc, c);
        fine.push({ dist: magDist(targetMag, c), dm: s.dm, dc: s.dc, mlm: s.mlm, mlc: s.mlc, fb: s.fb, tl });
      }
      yield;
    }
    fine.sort((a, b) => a.dist - b.dist);
    if (onProgress) onProgress(1);
    return fine.slice(0, keep);
  }
  // UIを止めないよう MessageChannel で実ターンを返しながら回す
  function nextTurn() {
    return new Promise((resolve) => {
      if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return; }
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }
  async function search(targetMag, opt = {}) {
    const it = candidates(targetMag, opt.coarseTop || 40, opt.keep || 12, opt.onProgress);
    let last = performance.now();
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
      if (opt.cancelled && opt.cancelled()) return null;
      const now = performance.now();
      if (now - last > 8) { await nextTurn(); last = performance.now(); }
    }
  }
  function searchSync(targetMag, opt = {}) {
    const it = candidates(targetMag, opt.coarseTop || 40, opt.keep || 12, null);
    for (;;) { const r = it.next(); if (r.done) return r.value; }
  }

  UI.Vrc7ToneSolver = { N, H, steadyCycle, analyze, synth, resample, corr, search, searchSync };
})(window);
