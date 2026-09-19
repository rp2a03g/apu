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
 *    noise.jsと同じ近似)。周期性ノイズ(white=false)は変換設定 SN_PERIODIC で写し先を選ぶ: 'white'(既定)は
 *    長周期のまま、'short' は2A03の短周期 @1 へ写し周期は基本周波数が合うものを選ぶ(extractNoiseEvents 直前のコメント)。
 *    ノイズレート3(トーンch2追従)はch2の周期変化のたびに周波数が変わるので、そのまま
 *    シフトHz→最寄り周期で追従させる(ドラム音程のスライドとして現れる)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Vgm2MmlExpansion = MML.Vgm2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
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
    return 31 - best; // 変換イベント空間の約束: ノート番号31-n = periodIndex n(MML.Convert.noiseNoteToIndex、MMLへは n<idx>)
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

  // 周期性ノイズの周期の選び方(2026-09-19): SN76489 の周期性ノイズは「シフトレジスタ幅(SMS/GG=16、
  // 素のSN76489=15)に1ビットだけ立った列」を回すので、シフトレート÷幅 の周波数の細いパルス(=音程のある音)になる。
  // 2A03 の短周期(93ステップ)の基本周波数は シフトレート÷93。以前はシフトレートどうしで最寄りを取っていたため、
  // 基本周波数が 幅/93 ≒ 1/5.8(約2.5オクターブ)低い周期を選んでいた。基本周波数どうしが合う周期を選ぶ
  // (=シフトレート×93/幅 を長周期と同じ表で引く)。2A03 の周期表は16段しかないので、音程は最寄りの段どまり
  const NES_SHORT_NOISE_STEPS = 93;

  function extractNoiseEvents(snapshots, idx, shiftWidth, periodicShort) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f][idx];
      const volume = c.rawVol;
      const on = volume > 0 && c.active && c.noiseFreq > 0;
      // 周期性ノイズ(white=false) → 2A03の短周期 @1(2026-09-18)。変換設定 SN_PERIODIC='white'(既定)なら
      // 長周期(ホワイト)のまま、周期もシフトレートどうしで合わせる(2026-09-19 選択式に)
      const mode = (periodicShort && c.white === false) ? 1 : 0;
      const note = on ? noiseFreqToNote(mode === 1 ? c.noiseFreq * NES_SHORT_NOISE_STEPS / shiftWidth : c.noiseFreq) : null;
      if (!cur) { cur = { note, mode, start: f, end: f, volSeq: [volume] }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note || (note !== null && mode !== cur.mode)) {
        flush(f);
        cur = { note, mode, start: f, end: f, volSeq: [volume] };
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
   * @param {object} [opts] - { shiftWidth: ノイズのシフトレジスタ幅(VGMヘッダ。既定16=SMS/GG/MD),
   *   periodic: 周期ノイズの写し先 'white'(既定)|'short'(変換設定 SN_PERIODIC) }
   */
  MML.Vgm2MmlExpansion.sn76489 = function (snapshots, clock, envReg, chip, opts) {
    const shiftWidth = (opts && opts.shiftWidth > 0) ? opts.shiftWidth : 16;
    const base = (chip || 0) * 4;
    if (base > 0 && !(snapshots.length && snapshots[0].length > base)) return { tones: [0, 1, 2].map(() => ({ events: [], hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true })), noise: { events: [], hasVolume: true, hasEnvelope: true } };
    // 楽器化(2026-09-08): 減衰の終わり(サステイン後の急な落ち)を印無しで切り出して @vr(リリース表)へ
    // (MML.Convert.EnvelopeRegistry.volumeFieldsWithRelease、src/convert/envelope.js detectRelease)。
    // 返る keyOffAt/releaseTailLast は applyNoteEnd 冒頭の applyReleaseSplits が音符の終端へ反映する
    function toVolumeFields(volSeq) {
      if (!envReg) return { volume: MML.Convert.plainVolume(volSeq) };
      return envReg.volumeFieldsWithRelease ? envReg.volumeFieldsWithRelease(volSeq)
        : (() => { const idx = envReg.assign(volSeq); return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx }; })();
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
      ev.note !== null ? { instrument: ev.mode } : {}, // @0=長周期/@1=短周期(borrow.js が hasInstrument を立てる)
      toVolumeFields(ev.volSeq)
    );
    return {
      tones: [0, 1, 2].map(ch => ({
        // 分節のヒステリシス化+高速アルペジオ→EN統合+不明瞭連なり統合(ay.jsと同じ後処理列)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractToneEvents(snapshots, base + ch, clock))).map(toneToCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true
      })),
      noise: { events: extractNoiseEvents(snapshots, base + 3, shiftWidth, !!(opts && opts.periodic === 'short')).map(noiseToCommon), hasVolume: true, hasEnvelope: true }
    };
  };
})(window);
