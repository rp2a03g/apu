/*
 * GB パルスch(CH1/CH2) → MML共通イベント形式 抽出
 * MML.Gbs2MmlExpansion.pulse(snapshots, chKey, envReg) → { events }
 *
 * writeLogの再生ではなく、captureGbsSongAsyncが積んだ「APUライブスナップショット」を
 * そのまま読む(gbsPlayer.js冒頭コメント参照。CH1の周波数スイープはレジスタ再書込み無しに
 * 内部クロックだけで進行するため、writeLog再生では追えない)。
 * GBは実際のトリガbit(NRx4 bit7)を持つため、triggerSeq(apuGb.js)の変化を見るだけで
 * 音符の頭を確実に検出できる(ay.js/scc.jsが使う「音量が上向きに跳ね上がったら再アタック」
 * というヒューリスティックより確実)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};

  // f = 131072 / (2048 - freqReg) (Pan Docs、apuGb.jsのPulseChannel.clockTimer()と同じ式)
  function pulseFreq(freqReg) { return freqReg < 2048 ? 131072 / (2048 - freqReg) : 0; }

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  function extractEvents(snapshots, chKey) {
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chKey];
      const freqHz = (c.enabled && c.vol > 0) ? pulseFreq(c.freq) : 0;
      const note = freqHz > 0 ? freqToNoteNumber(freqHz) : null;
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      if (!cur) {
        cur = { note, duty: c.duty, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [c.vol], pitchSeq: [c.freq], tieCandidate: false };
        continue;
      }
      if (triggered || note !== cur.note || c.duty !== cur.duty) {
        // トリガbit変化が無く、純粋に音程だけが変わった場合はスラー分割のタイ候補
        const pureNoteChange = !triggered && note !== cur.note && c.duty === cur.duty;
        flush(f);
        cur = { note, duty: c.duty, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [c.vol], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(c.vol);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.pulse = function (snapshots, chKey, envReg) {
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+P-5「不明瞭→EPテーブル」側(2026-08-12)
    const events = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeAlternatingVibrato(extractEvents(snapshots, chKey)));
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.duty, rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(pulseFreq) } : {},
      toVolumeFields(ev.volSeq)
    );
    return { events: events.map(toCommon), hasVolume: true, hasEnvelope: true, hasInstrument: true };
  };
})(window);
