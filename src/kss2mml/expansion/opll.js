/*
 * FMPAC(OPLL/YM2413) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.opll(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0x7C=アドレスラッチ, 0x7D=データ書込。
 *   0x10+ch=fnum下位, 0x20+ch=bit0=fnum上位,bits1-3=block,bit4=キーオン,
 *   0x30+ch=bits4-7=音色番号,bits0-3=音量。
 * アタック合図: 0x20+ch書き込みのbit4(キーオン)。ネイティブ出力レート49716Hz
 * (src/emulator/expansion/opllMsx.js/vrc7.jsと同じ、VRC7=OPLLなので式も同一)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }
  function opllFreq(fnum, block) { return (fnum * 49716 * Math.pow(2, block)) / 524288; }

  function buildTimeline(writeLog) {
    let latch = 0;
    const regs = new Uint8Array(0x40);
    return writeLog.map(writes => {
      const attack = [false, false, false, false, false, false];
      for (const { addr, value, io } of writes) {
        if (!io) continue;
        if (addr === 0x7C) { latch = value & 0x3F; continue; }
        if (addr !== 0x7D) continue;
        regs[latch] = value;
        if (latch >= 0x20 && latch <= 0x25 && (value & 0x10)) attack[latch - 0x20] = true;
      }
      return { regs: regs.slice(), attack };
    });
  }

  function extractChannelEvents(timeline, ch) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, attack } = timeline[f];
      const fnumLo = regs[0x10 + ch];
      const reg20 = regs[0x20 + ch];
      const block = (reg20 >> 1) & 0x07;
      const keyon = !!(reg20 & 0x10);
      const fnum = fnumLo | ((reg20 & 0x01) << 8);
      const reg30 = regs[0x30 + ch];
      const instrument = (reg30 >> 4) & 0x0F;
      const volume = reg30 & 0x0F;
      const note = (keyon && fnum > 0) ? freqToNoteNumber(opllFreq(fnum, block)) : null;
      if (!cur) { cur = { note, volume, instrument, start: f, end: f }; continue; }
      if (attack[ch] || note !== cur.note || volume !== cur.volume || instrument !== cur.instrument) {
        flush(f);
        cur = { note, volume, instrument, start: f, end: f };
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.opll = function (writeLog, totalFrames) {
    const timeline = buildTimeline(writeLog);
    const toCommon = ev => ({ start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument });
    return {
      channels: [0, 1, 2, 3, 4, 5].map(ch => ({
        events: extractChannelEvents(timeline, ch).map(toCommon),
        hasVolume: true,
        hasInstrument: true
      }))
    };
  };
})(window);
