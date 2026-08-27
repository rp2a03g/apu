/*
 * SN76489(VGM: SG-1000/Master System/Game Gear/Mega Drive PSG) → MML共通イベント形式 抽出
 * MML.Vgm2MmlExpansion.sn76489(snapshots, clock, envReg) → { tones: [3ch], noise: {events} }
 *
 * 借用先(DESIGN.md §5「借用チップ」規約): トーン3本 → FME-7(3ch矩形波、@1=トーンのみ)、
 * ノイズ → 2A03ノイズ(D)。SN76489はAY系と別系統だが「矩形3本+ノイズ1本、4bit音量」という
 * 外形はFME-7に素直に載る。SN76489のトーンは f=clock/(32*period)(10bit)、FME-7は
 * f=CPU/(32*period)(12bit)でクロックが丁度2倍なので、FME-7側の周期=SN周期×2で厳密に
 * 表現できる(音程補正はkss2mml(PSG→FME-7)と同じ detectChorusDetune 方針で呼び出し側が行う)。
 *
 * 入力の snapshots は src/emulator/expansion/sn76489.js の Emu.snapshotSN76489 が返す
 * フレーム毎の配列([tone0,tone1,tone2,noise]、rawVol=0-15、period、noiseFreq(LFSRシフトHz)、
 * white、noiseRate)。captureVgmSongAsync(vgmPlayer.js)がフレーム(1/60秒)ごとに積む。
 *
 * イベントの切り方は kss2mml/expansion/ay.js の extractToneEvents と同じ考え方:
 *  - 音程/発音状態が同じ間は音量変化だけでは区切らず volSeq に積む(ソフトウェア
 *    エンベロープ抽出用)。SN76489にはキーオン信号もハードエンベロープも無いので、
 *    音量が上向きに跳ねたら再アタック(retrigger)とみなして区切る。
 *  - SMSのドライバは「周期<6でDC固定+音量書き換え」でPCM風の技法を使うことがあるが、
 *    snapshot側で active=false(音程なし)になるので自然に休符になる。
 *  - ノイズ: 2A03固定16周期のうち実測シフトレートに最も近い周期へ写像(gbs2mml/expansion/
 *    noise.jsと同じ近似)。周期性ノイズ(white=false)は2A03の短周期モードに相当するが、
 *    ネイティブNSF変換でもノイズのモードビットは出力していないので周期選択のみ写像する。
 *    ノイズレート3(トーンch2追従)はch2の周期変化のたびに周波数が変わるので、そのまま
 *    シフトHz→最寄り周期で追従させる(ドラム音程のスライドとして現れる)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Vgm2MmlExpansion = MML.Vgm2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  const NES_CPU_CLOCK = 1789773;
  const NES_NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  const NES_NOISE_FREQS = NES_NOISE_PERIOD.map(p => NES_CPU_CLOCK / p);
  function noiseFreqToNote(freqHz) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NES_NOISE_FREQS.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / NES_NOISE_FREQS[i]));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return 31 - best; // ppmck準拠: ノート番号31-n = periodIndex n(src/mml/compiler.js noisePeriodIndex)
  }

  function extractToneEvents(snapshots, ch, clock) { // ch: スナップショット配列内の要素index(2個目チップは+4)
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][ch];
      const volume = c.rawVol;
      let note = null, freqHz = null;
      if (volume > 0 && c.active && c.freq > 0) { freqHz = c.freq; note = freqToNoteNumber(freqHz); }
      const period = c.period;
      if (!cur) { cur = { note, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note) {
        // 音量ジャンプ(再アタック推定)が無く純粋に音程だけ変わった場合はスラー分割のタイ候補
        // (src/convert/pitch.js markSlurTies。ay.jsと同じく音量上昇を実アタックの代用にする)
        const pureNoteChange = !retrigger && note !== cur.note;
        flush(f);
        cur = { note, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(snapshots.length);
    return events;
  }

  function extractNoiseEvents(snapshots, idx) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][idx];
      const volume = c.rawVol;
      const on = volume > 0 && c.active && c.noiseFreq > 0;
      const note = on ? noiseFreqToNote(c.noiseFreq) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [volume] }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [volume] };
      } else {
        cur.volSeq.push(volume);
      }
    }
    flush(snapshots.length);
    return events;
  }

  /**
   * @param {Array} snapshots - Emu.snapshotSN76489 のフレーム配列
   * @param {number} clock - チップクロック(Hz)
   * @param {object} [envReg] - MML.Convert.EnvelopeRegistry(音量エンベロープ@v<n>の共有登録)。
   *   assign(volSeq)を持つ任意のオブジェクト可(借用先に合わせた音量写像プロキシ等)
   * @param {number} [chip=0] - デュアルチップの何個目か(スナップショットは1個目[0-3]+2個目[4-7]の連結)
   */
  MML.Vgm2MmlExpansion.sn76489 = function (snapshots, clock, envReg, chip) {
    const base = (chip || 0) * 4;
    if (base > 0 && !(snapshots.length && snapshots[0].length > base)) return { tones: [0, 1, 2].map(() => ({ events: [], hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true })), noise: { events: [], hasVolume: true, hasEnvelope: true } };
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx };
    }
    const toneToCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      // FME-7の@1(トーンのみ、ノイズ無し)。ay.jsのmode(1=tone)と同じ意味
      ev.note !== null ? { instrument: 1 } : {},
      ev.note !== null && ev.freqHz != null
        ? { rawFreq: ev.freqHz, freqSeq: ev.pitchSeq.map(p => (p > 0 ? clock / (32 * p) : 0)) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    const noiseToCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      toVolumeFields(ev.volSeq)
    );
    return {
      tones: [0, 1, 2].map(ch => ({
        // 分節のヒステリシス化+高速アルペジオ→EN統合+不明瞭連なり統合(ay.jsと同じ後処理列)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractToneEvents(snapshots, base + ch, clock))).map(toneToCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true
      })),
      noise: { events: extractNoiseEvents(snapshots, base + 3).map(noiseToCommon), hasVolume: true, hasEnvelope: true }
    };
  };
})(window);
