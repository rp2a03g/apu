/*
 * 入力レイテンシと時間軸の写像 (MML.Input.Latency) — コア層
 *
 * リアルタイム入力(PC鍵盤/画面鍵盤/Web MIDI/マイク)を録音するとき、
 * イベントの時刻は performance.now() 系(DOMHighResTimeStamp)で来るのに対し、
 * 音の基準は AudioContext.currentTime 系である。この2つを取り違えると
 * 「メトロノームには合っているのに録れたMMLがずれる」という形で必ず破綻する。
 * ここで写像を1箇所に閉じ込める。
 *
 * ★ AudioContext.getOutputTimestamp() の {contextTime, performanceTime} は
 *   「そのサンプルが実際にスピーカーから出た瞬間」の対応表になっている。
 *   したがってこのペアで写像すると出力レイテンシは自動的に相殺され、
 *   残るのは「人間と入力機器の遅れ」だけになる ＝ それが較正で測る値。
 *   getOutputTimestamp() が無い/値が不正な環境ではフォールバック式を使うが、
 *   その場合は出力レイテンシも較正値に吸収される(どちらでも結果は合う)。
 *
 * DOM非依存。localStorageのみ使用(file://でも動く。fetch等は使わない)。
 */
(function (global) {
  'use strict';
  const MML   = global.MML = global.MML || {};
  const Input = MML.Input  = MML.Input  || {};

  const STORAGE_KEY = 'mml.input.offsetSec';
  const MAX_OFFSET  = 0.5;  // ±500ms を超える値は誤操作とみなす

  function clampOffset(sec) {
    if (!Number.isFinite(sec)) return 0;
    return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, sec));
  }

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    if (n === 0) return 0;
    return (n % 2) ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  const Latency = Input.Latency = {

    MAX_OFFSET_SEC: MAX_OFFSET,

    /*
     * 入力オフセット(秒)。「生の入力時刻からこの値を引くと、本人が意図した
     * タイミングになる」という符号で持つ。クリックより遅れて叩く人はプラス。
     */
    getOffsetSec() {
      try {
        const raw = parseFloat(localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(raw)) return clampOffset(raw);
      } catch (e) { /* ignore */ }
      return 0;
    },

    setOffsetSec(sec) {
      const v = clampOffset(sec);
      try { localStorage.setItem(STORAGE_KEY, String(v)); } catch (e) { /* ignore */ }
      return v;
    },

    /*
     * 出力レイテンシ(秒)。診断表示用。outputLatencyはChrome系のみ、
     * baseLatencyはそれより広く実装されている。どちらも無ければ0。
     */
    outputLatencySec(ctx) {
      if (!ctx) return 0;
      if (Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0) return ctx.outputLatency;
      if (Number.isFinite(ctx.baseLatency)   && ctx.baseLatency   > 0) return ctx.baseLatency;
      return 0;
    },

    /* performance.now() 系のミリ秒 → AudioContext.currentTime 系の秒 */
    perfToContextTime(ctx, perfMs) {
      if (!ctx) return 0;
      if (ctx.getOutputTimestamp) {
        const ts = ctx.getOutputTimestamp();
        if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) &&
            ts.contextTime > 0 && ts.performanceTime > 0) {
          return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
        }
      }
      // フォールバック: 「今」を基準に経過時間で引き戻す(出力レイテンシは含まれない)
      return ctx.currentTime - (global.performance.now() - perfMs) / 1000;
    },

    /*
     * DOMイベント(keydown/pointerdown/MIDIMessageEvent)の発生時刻を
     * contextTime系へ。timeStampが0や欠損の実装があるので必ずフォールバックする。
     */
    contextTimeFromEvent(ctx, evt) {
      const ts = evt && evt.timeStamp;
      const perfMs = (Number.isFinite(ts) && ts > 0) ? ts : global.performance.now();
      return Latency.perfToContextTime(ctx, perfMs);
    },

    /*
     * タップ較正。deltas = 各タップの「拍からのずれ(秒、遅れがプラス)」。
     * 戻り値 { offsetSec, jitterSec, used, rejected } / 測定不能なら null。
     *
     * ★ 単純平均にしてはいけない。16回中1回の叩き損ねで結果が数十ms動く。
     *   中央値+MAD(中央絶対偏差)で外れ値を落としてから平均を取る。
     */
    estimateTapOffset(deltas, opts = {}) {
      const minCount = (opts.minCount != null) ? opts.minCount : 4;
      const maxAbs   = (opts.maxAbs   != null) ? opts.maxAbs   : 0.25;
      const all  = (deltas || []).filter(d => Number.isFinite(d));
      const raw  = all.filter(d => Math.abs(d) <= maxAbs);
      if (raw.length < minCount) return null;

      const med = median(raw);
      const mad = median(raw.map(d => Math.abs(d - med)));
      // MADが0(全部同値)でも潰れないよう許容幅に下限20msを置く
      const tol = Math.max(0.020, mad * 3);
      const kept = raw.filter(d => Math.abs(d - med) <= tol);
      const use  = (kept.length >= minCount) ? kept : raw;

      const mean = use.reduce((a, b) => a + b, 0) / use.length;
      const varSum = use.reduce((a, b) => a + (b - mean) * (b - mean), 0);
      return {
        offsetSec: clampOffset(mean),
        jitterSec: Math.sqrt(varSum / use.length),
        used: use.length,
        rejected: all.length - use.length
      };
    }
  };

})(window);
