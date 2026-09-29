/*
 * 1つの元チャンネルを別の借用先へも載せる「複製」— MML.Convert.ChannelCopy (2026-09-29)
 *
 * 「まとめる」(channelMerge.js)の鏡像。鍵盤の割当で元chの下に複製行(ID '<元ch>#<n>'、ChannelPlan の
 * 項目 copyOf)を作ると、各 *2mml は抽出直後に元chのイベント列を写した仮想chを足し、あとは普通の行として
 * 配置する(借用先・音色・変換音量・まとめる印は複製ごとに独立)。
 *
 * 複製ならではの加工(段階2)はここで1回だけイベント列に施す:
 *   transpose … 移調(半音、整数)。音符番号を動かし、周波数の項目も同じ比で動かす
 *   detune    … デチューン(セント)。周波数の項目だけを動かす(音符はそのまま)ので、既存の D<n> 抽出が
 *               「実測が理論値からずれている」として D を出す
 *   delay     … 遅延(フレーム)。エコー用。曲末を越えた分は切る
 *
 *   ChannelCopy.transform(events, { transpose, detune, delay, totalFrames }, spec)
 *     spec: GENERIC({start,end,note,freqHz/rawFreq/freqSeq}、休符込みの連続被覆) / SPC({frame,len,pitchSemi,pitch/pitchSeq/rawFreq})
 *   ChannelCopy.label(baseLabel, id) … 'V0 ⧉1'
 *   ChannelCopy.describe(label, ofLabel, targetLabel, opt) … 注記
 * DOM 非依存(INV-4)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const COPY_RE = /^(.+)#(\d+)$/;
  const PER_FRAME_SEQ = ['volSeq', 'pitchSeq', 'freqSeq', 'dutySeq', 'attSeq', 'hwEnvSeq'];

  // 周波数に比例する項目(比で動かす)。SPC の pitch/pitchSeq は DSP のピッチレジスタ(周波数に比例、整数)
  const GENERIC = { time: 'startEnd', noteKey: 'note', freqKeys: ['freqHz', 'rawFreq', 'freqSeq'], intFreq: false };
  const SPC = { time: 'frameLen', noteKey: 'pitchSemi', freqKeys: ['pitch', 'pitchSeq', 'rawFreq'], intFreq: true };

  function scaleVal(v, ratio, int) {
    if (typeof v !== 'number' || !isFinite(v)) return v;
    const r = v * ratio;
    return int ? Math.round(r) : r;
  }
  function scaleField(ev, key, ratio, spec) {
    if (!(key in ev) || ev[key] == null) return;
    // pitch(SPC)だけは整数レジスタ。rawFreq は Hz の実数
    const int = spec.intFreq && key !== 'rawFreq';
    if (Array.isArray(ev[key])) ev[key] = ev[key].map(v => scaleVal(v, ratio, int));
    else ev[key] = scaleVal(ev[key], ratio, int);
  }

  function transform(events, opt, spec) {
    opt = opt || {};
    spec = spec || GENERIC;
    const semi = Math.round(opt.transpose || 0);
    const cents = +opt.detune || 0;
    const delay = Math.max(0, Math.round(opt.delay || 0));
    const total = opt.totalFrames;
    const ratio = Math.pow(2, semi / 12 + cents / 1200);
    const isFrameLen = spec.time === 'frameLen';
    const out = [];
    let firstStart = null;
    for (const src of (events || [])) {
      const ev = Object.assign({}, src);
      for (const k of PER_FRAME_SEQ) if (Array.isArray(ev[k])) ev[k] = ev[k].slice();
      const isNote = ev[spec.noteKey] !== null && ev[spec.noteKey] !== undefined;
      // 音程(ノイズ音符 non はそのまま)
      if (isNote && !ev.non && (semi || cents)) {
        if (semi) ev[spec.noteKey] = ev[spec.noteKey] + semi;
        for (const k of spec.freqKeys) scaleField(ev, k, ratio, spec);
      }
      // 遅延(曲末を越えた分は切る)
      let start = isFrameLen ? ev.frame : ev.start;
      let end = isFrameLen ? ev.frame + ev.len : ev.end;
      if (firstStart === null) firstStart = start;
      if (delay) {
        const len0 = end - start;
        start += delay; end += delay;
        if (total != null && start >= total) continue;
        if (total != null && end > total) end = total;
        const len1 = end - start;
        if (len1 !== len0) for (const k of PER_FRAME_SEQ) if (Array.isArray(ev[k]) && ev[k].length === len0) ev[k] = ev[k].slice(0, len1);
        if (isFrameLen) { ev.frame = start; ev.len = len1; } else { ev.start = start; ev.end = end; }
      }
      out.push(ev);
    }
    // 連続被覆の形式は、ずらした分だけ頭に休符を足す(SPC の {frame,len} は音符だけの列なので不要)
    if (delay && !isFrameLen && firstStart !== null && out.length) out.unshift({ start: firstStart, end: firstStart + delay, note: null });
    return out;
  }

  function parseId(id) {
    const m = COPY_RE.exec(id || '');
    return m ? { of: m[1], n: +m[2] } : null;
  }
  function label(baseLabel, id) {
    const p = parseId(id);
    return baseLabel + ' ⧉' + (p ? p.n : '');
  }
  function describe(lbl, ofLabel, targetLabel, opt) {
    opt = opt || {};
    const parts = [];
    if (opt.transpose) parts.push(`移調 ${opt.transpose > 0 ? '+' : ''}${opt.transpose}半音`);
    if (opt.detune) parts.push(`デチューン ${opt.detune > 0 ? '+' : ''}${opt.detune}セント`);
    if (opt.delay) parts.push(`遅延 ${opt.delay}フレーム`);
    return `${lbl} は ${ofLabel} の複製です: ${targetLabel} へ載せました${parts.length ? '(' + parts.join('、') + ')' : ''}。`;
  }

  MML.Convert.ChannelCopy = { transform, parseId, label, describe, GENERIC, SPC, COPY_RE };
})(typeof window !== 'undefined' ? window : globalThis);
