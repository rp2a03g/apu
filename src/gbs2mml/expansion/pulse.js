/*
 * GB パルスch(CH1/CH2) → MML共通イベント形式 抽出
 * MML.Gbs2MmlExpansion.pulse(snapshots, chKey, envReg, playFps) → { events }
 *
 * writeLogの再生ではなく、captureGbsSongAsyncが積んだ「APUライブスナップショット」を
 * そのまま読む(gbsPlayer.js冒頭コメント参照。CH1の周波数スイープはレジスタ再書込み無しに
 * 内部クロックだけで進行するため、writeLog再生では追えない)。
 * GBは実際のトリガbit(NRx4 bit7)を持つため、triggerSeq(apuGb.js)の変化を見るだけで
 * 音符の頭を確実に検出できる(ay.js/scc.jsが使う「音量が上向きに跳ね上がったら再アタック」
 * というヒューリスティックより確実)。
 *
 * 音量エンベロープの値はスナップショットの生volを使わず、hwEnvelope.jsの解析式で
 * 起点(トリガー時点)から計算し直す(64Hz実機クロックとplayFpsの位相ズレによる
 * 疑似重複対策、hwEnvelope.js冒頭コメント参照)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};
  const { volumeAt, updateAnchor } = MML.Gbs2MmlExpansion.hwEnvelope;

  // NR51($FF25、パンニング)の対応するchビットがL/R両方とも0なら、音量レジスタが
  // 非0でも実際にはどちらの出力バスにも混ざらず無音になる(Pan Docs: bit(4+ch)=L出力へ
  // ミックス、bit(ch)=R出力へミックス。ch=0-3がCH1-4に対応)。従来の抽出は音量レジスタ
  // だけを見ていたため、作曲側がパンニングだけで消音するケース(Last Bible DMG-M7J.gbs
  // 実測で発覚)を無音として検出できていなかった。電源投入時の既定値$F3(全ch L ON、
  // CH1/2のみR ON)ではどのchも無音にならないため、明示的にNR51を書き換えた曲でのみ影響する。
  function panAudible(nr51, chIndex) {
    return (((nr51 >> (4 + chIndex)) & 1) !== 0) || (((nr51 >> chIndex) & 1) !== 0);
  }
  MML.Gbs2MmlExpansion._panAudible = panAudible; // wave.js/noise.jsから共用

  // f = 131072 / (2048 - freqReg) (Pan Docs、apuGb.jsのPulseChannel.clockTimer()と同じ式)
  function pulseFreq(freqReg) { return freqReg < 2048 ? 131072 / (2048 - freqReg) : 0; }

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }

  const CH_INDEX = { ch1: 0, ch2: 1 };

  function extractEvents(snapshots, chKey, playFps) {
    const chIndex = CH_INDEX[chKey];
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    let anchor = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chKey];
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      anchor = updateAnchor(anchor, c, f, triggered);
      const vol = volumeAt(anchor, f, playFps);
      const freqHz = (c.enabled && vol > 0 && panAudible(snapshots[f].nr51, chIndex)) ? pulseFreq(c.freq) : 0;
      const note = freqHz > 0 ? freqToNoteNumber(freqHz) : null;
      if (!cur) {
        cur = { note, duty: c.duty, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: false };
        continue;
      }
      if (triggered || note !== cur.note || c.duty !== cur.duty) {
        // トリガbit変化が無く、純粋に音程だけが変わった場合はスラー分割のタイ候補
        const pureNoteChange = !triggered && note !== cur.note && c.duty === cur.duty;
        flush(f);
        cur = { note, duty: c.duty, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.pulse = function (snapshots, chKey, envReg, playFps) {
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)。mergeUnclearPitchRunsは
    // mergeVibratoAndArpeggio(mergeRapidArpeggio+mergeAlternatingVibrato)の直後に
    // 呼ぶ既存の呼び出し規約通り(pitch.js mergeUnclearPitchRuns冒頭コメント参照)。
    const events = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractEvents(snapshots, chKey, playFps)));
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.duty, rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(pulseFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    return { events: events.map(toCommon), hasVolume: true, hasEnvelope: true, hasInstrument: true };
  };
})(window);
