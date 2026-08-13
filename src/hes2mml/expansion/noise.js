/*
 * HES PSG ノイズ(ch4/5のnoiseOnモード) → MML共通イベント形式 抽出(2A03ノイズchへの借用)
 * MML.Hes2MmlExpansion.noise(snapshots) → { events }
 *
 * ノイズ生成回路を持つのはPSGのch4/5の2chのみ(hesBus.js/apuHuC6280.js参照)だが、
 * 借用先の2A03ノイズは物理的に1chしか無い。両方が同時にノイズモードになるケースは稀と
 * 見込み、両方アクティブな場合はch5を優先する(単純な優先順位、gbs2mml/expansion/noise.js
 * のGB(元々1ch)と違いここは近似が必要な箇所として明記しておく)。
 *
 * 周波数式(文献): freq = PSG_CLOCK / (64 * (5bit値 XOR 31))。借用先の2A03ノイズは固定16
 * 周期しか持たないため、実測周波数に一番近い2A03周期を選ぶ近似変換になる
 * (gbs2mml/expansion/noise.jsと同じ考え方。detune補正の対象外である理由も同じ:
 * 離散的な周期の入れ替えであり連続量の微調整という概念が無い)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Hes2MmlExpansion = MML.Hes2MmlExpansion || {};

  const NES_CPU_CLOCK = 1789773;
  const NES_NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  const NES_NOISE_FREQS = NES_NOISE_PERIOD.map(p => NES_CPU_CLOCK / p);

  function psgNoiseFreq(noiseCtrl) {
    const invVal = Math.max(1, (~noiseCtrl) & 0x1F);
    return MML.HES.PSG_CLOCK / (64 * invVal);
  }

  function psgNoiseFreqToNote(freqHz) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return 31 - best;
  }

  // 物理ch(4 or 5)単独のノイズイベント列(マージ無し)。noise()はMML書き出し用に
  // 2A03への借用(物理1chしか無い)を前提としてch5優先でch4/5をマージするが、
  // ピアノロール/鍵盤表示はch4・ch5を別々の行として独立に持つため、マージせず
  // 物理chごとのイベント列が必要(main.js buildHesRollTimeline参照。
  // 「ないチャンネルの表示がロールにある」バグ調査で発覚: 従来はnoise()のマージ結果を
  // どの行にも属さない別idのゴースト行として表示していたため、ミュートが効かず色も
  // 一致しなかった)。
  function extractChannelNoiseEvents(snapshots, chIndex) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][chIndex];
      const active = c.on && c.noiseOn &&
        !MML.Hes2MmlExpansion._panSilent(c.vol, c.balance, snapshots[f].globalBalance);
      const vol4 = active ? Math.max(0, Math.min(15, c.vol >> 1)) : 0;
      const note = (active && vol4 > 0) ? psgNoiseFreqToNote(psgNoiseFreq(c.noiseCtrl)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [vol4] }; continue; }
      if (note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [vol4] };
      } else {
        cur.volSeq.push(vol4);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Hes2MmlExpansion.noiseChannel = function (snapshots, chIndex) {
    const events = extractChannelNoiseEvents(snapshots, chIndex)
      .map(ev => ({ note: ev.note, start: ev.start, end: ev.end, volume: ev.volSeq[0] }));
    return { events };
  };

  function pickSource(snapFrame) {
    const c5 = snapFrame[5], c4 = snapFrame[4];
    const audible = c => !MML.Hes2MmlExpansion._panSilent(c.vol, c.balance, snapFrame.globalBalance);
    if (c5.on && c5.noiseOn && audible(c5)) return c5;
    if (c4.on && c4.noiseOn && audible(c4)) return c4;
    return null;
  }

  function extractEvents(snapshots) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const src = pickSource(snapshots[f]);
      const vol4 = src ? Math.max(0, Math.min(15, src.vol >> 1)) : 0;
      const note = (src && vol4 > 0) ? psgNoiseFreqToNote(psgNoiseFreq(src.noiseCtrl)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [vol4] }; continue; }
      if (note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [vol4] };
      } else {
        cur.volSeq.push(vol4);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Hes2MmlExpansion.noise = function (snapshots, envReg) {
    const events = extractEvents(snapshots);
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
