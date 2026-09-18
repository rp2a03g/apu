/*
 * GB ノイズch(CH4) → MML共通イベント形式 抽出(2A03ノイズchへの借用を前提)
 * MML.Gbs2MmlExpansion.noise(snapshots) → { events }
 *
 * GBのノイズは(クロックシフト4bit×幅モード1bit×分周コード3bit)=256通りの設定を持つが、
 * 借用先の2A03ノイズは固定16周期しか持たない(変換イベント空間ではノート番号31-nで
 * periodIndex nを表す約束。MMLへは mmlEmit が n<idx> で書く、MML.Convert.noiseNoteToIndex参照)。
 * このため実測周波数に一番近い2A03周期を探して割り当てる近似変換になる。GBのLFSR幅モード
 * (7bit=127step/15bit)は2A03の短周期(93step)/長周期に対応させ、@1/@0 で出す(2026-09-18。
 * 周期長は違うが「金属的な音程感のあるノイズ」という質感は同じ)。
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
      const mode = c.widthMode ? 1 : 0; // NR43 bit3: 1=7bit幅(短周期) → 2A03の @1
      if (!cur) { cur = { note, mode, start: f, end: f, volSeq: [vol] }; continue; }
      if (triggered || note !== cur.note || (note !== null && mode !== cur.mode)) {
        flush(f);
        cur = { note, mode, start: f, end: f, volSeq: [vol] };
      } else {
        cur.volSeq.push(vol);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.noise = function (snapshots, envReg, playFps) {
    const events = extractEvents(snapshots, playFps);
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      ev.note !== null ? { instrument: ev.mode } : {}, // @0=長周期/@1=短周期(borrow.js が hasInstrument を立てる)
      toVolumeFields(ev.volSeq)
    );
    return { events: events.map(toCommon), hasVolume: true, hasEnvelope: true, hasInstrument: true };
  };
})(window);
