/*
 * GB ノイズch(CH4) → MML共通イベント形式 抽出(2A03ノイズchへの借用を前提)
 * MML.Gbs2MmlExpansion.noise(snapshots) → { events }
 *
 * GBのノイズは(クロックシフト4bit×幅モード1bit×分周コード3bit)=256通りの設定を持つが、
 * 借用先の2A03ノイズは固定16周期しか持たない(src/mml/compiler.jsのnoisePeriodIndex、
 * ノート番号31-nでperiodIndex nを表す ppmck 準拠の固定対応)。このため実測周波数に
 * 一番近い2A03周期を探して割り当てる近似変換になる(音程は近似できるが、GBのLFSR幅
 * モード(7bit/15bit)によるノイズの質感の違いまでは2A03側で再現できない)。
 * ネイティブ変換(NSF→2A03自身)のノイズがそもそも音程補正(D<n>)を行っていないのと同じ
 * 理由(離散的な周期の入れ替えであり連続量の微調整という概念が無い)で、ここでも
 * detune補正は行わない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};
  const { volumeAt, updateAnchor } = MML.Gbs2MmlExpansion.hwEnvelope;

  // GBノイズ周期(Tステート) = 16 * divisor * 2^shift (apuGb.jsのNoiseChannel.periodT()と同じ式)
  const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];
  const GB_CLOCK = 4194304;
  function gbNoiseFreq(divisorCode, clockShift) {
    const periodT = 16 * NOISE_DIVISOR[divisorCode] * (1 << clockShift);
    return GB_CLOCK / periodT;
  }

  // 2A03ノイズの実測16周期(NTSC、apu2a03.jsのNOISE_PERIODと同じテーブル)
  const NES_CPU_CLOCK = 1789773;
  const NES_NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  const NES_NOISE_FREQS = NES_NOISE_PERIOD.map(p => NES_CPU_CLOCK / p);

  // 実測周波数(対数距離)に一番近い2A03周期indexを探し、noisePeriodIndexの逆写像
  // (31-idx)でノート番号にする(src/mml/compiler.jsのnoisePeriodIndexと正確に対応する)。
  function gbNoiseFreqToNote(freqHz) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return 31 - best;
  }

  function extractEvents(snapshots, playFps) {
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    let anchor = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f].ch4;
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      anchor = updateAnchor(anchor, c, f, triggered);
      const vol = volumeAt(anchor, f, playFps);
      // NR51パンニングの両出力バスとも0ならch4無音扱い(pulse.jsのpanAudible冒頭コメント
      // 参照)。CH4はNR51上のch index=3。
      const on = c.enabled && vol > 0 && MML.Gbs2MmlExpansion._panAudible(snapshots[f].nr51, 3);
      const note = on ? gbNoiseFreqToNote(gbNoiseFreq(c.divisorCode, c.clockShift)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [vol] }; continue; }
      if (triggered || note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [vol] };
      } else {
        cur.volSeq.push(vol);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.noise = function (snapshots, envReg, playFps) {
    const events = extractEvents(snapshots, playFps);
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      toVolumeFields(ev.volSeq)
    );
    return { events: events.map(toCommon), hasVolume: true, hasEnvelope: true };
  };
})(window);
