/*
 * Konami SCC/SCC+ → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.scc(writeLog, totalFrames) → { channels: [...] }
 *
 * 書込アドレスは0x9800-9FFF(classic)/0xB800-BFFF(SCC+)のどちらもオフセット構造が同じ
 * (src/emulator/expansion/sccAudio.js参照)なので、絶対アドレスからベースを引いた
 * オフセットで統一的に扱う。0x80-89=周波数(12bit,lo/hi), 0x8A-8E=音量(4bit),
 * 0x8F=有効ビット(bit0-4)。波形自体はここでは抽出せずノート検出のみ行う。
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

  function offsetOf(addr) {
    if (addr >= 0x9800 && addr <= 0x9FFF) return addr - 0x9800;
    if (addr >= 0xB800 && addr <= 0xBFFF) return addr - 0xB800;
    return -1;
  }

  function buildTimeline(writeLog, clock) {
    const freq = new Uint16Array(5);
    const volume = new Uint8Array(5);
    let enable = 0x1F;
    const wave0 = new Int8Array(32); // ch0波形(N163波形抽出用に最終状態を保持)
    return writeLog.map(writes => {
      for (const { addr, value, io } of writes) {
        if (io) continue;
        const off = offsetOf(addr);
        if (off < 0) continue;
        if (off < 0x20) { wave0[off] = value; continue; }
        if (off < 0x80 || off > 0x8F) continue;
        if (off <= 0x89) {
          const ch = (off - 0x80) >> 1;
          if (off & 1) freq[ch] = (freq[ch] & 0x00FF) | ((value & 0x0F) << 8);
          else freq[ch] = (freq[ch] & 0x0F00) | value;
        } else if (off <= 0x8E) {
          volume[off - 0x8A] = value & 0x0F;
        } else if (off === 0x8F) {
          enable = value & 0x1F;
        }
      }
      return { freq: Array.from(freq), volume: Array.from(volume), enable, wave0 };
    });
  }

  // SCC ch0の符号付き8bit波形(32点)を N163形式(4bit符号無し, 16点)へ変換する。
  // N163エンコーダ経由でしか再生できないため(compiler.jsにSCCネイティブ経路が無い)、
  // 波形が完全一致するわけではないが近似として抽出する。
  function extractWave(wave0) {
    const OUT_LEN = 16;
    const wave = new Array(OUT_LEN);
    for (let i = 0; i < OUT_LEN; i++) {
      const srcPos = Math.floor((i / OUT_LEN) * 32) % 32;
      wave[i] = Math.max(0, Math.min(15, (wave0[srcPos] + 128) >> 4));
    }
    return wave;
  }

  function extractChannelEvents(timeline, ch, clock) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.freq[ch];
      const volume = t.volume[ch];
      const enabled = !!((t.enable >> ch) & 1);
      const freqHz = period > 8 ? clock / (32 * (period + 1)) : 0;
      const note = (enabled && volume > 0 && freqHz > 0) ? freqToNoteNumber(freqHz) : null;
      if (!cur) { cur = { note, volume, start: f, end: f }; continue; }
      if (note !== cur.note || volume !== cur.volume) {
        flush(f);
        cur = { note, volume, start: f, end: f };
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.scc = function (writeLog, totalFrames, clock) {
    const timeline = buildTimeline(writeLog, clock);
    const toCommon = ev => ({ start: ev.start, end: ev.end, note: ev.note, volume: ev.volume });
    const finalWave0 = timeline.length > 0 ? timeline[timeline.length - 1].wave0 : new Int8Array(32);
    return {
      channels: [0, 1, 2, 3, 4].map(ch => ({
        events: extractChannelEvents(timeline, ch, clock).map(toCommon),
        hasVolume: true
      })),
      n163Wave: extractWave(finalWave0)
    };
  };
})(window);
