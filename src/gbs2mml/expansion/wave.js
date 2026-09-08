/*
 * GB 波形ch(CH3) → MML共通イベント形式 抽出(FDSへの借用を前提)
 * MML.Gbs2MmlExpansion.wave(snapshots, waveReg, envReg) → { events, fdsWave }
 *
 * ★当初はN163(4bitニブル詰めでビット深度が完全一致、リサンプリング不要)を採用していたが、
 * 実測でN163⇔2A03間の音量バランスがどうしても安定しなかったため、ユーザー確認の上でFDSへ
 * 変更した。理由: FDSの出力式(src/emulator/expansion/fds.js mixSample())は
 * `(センタリング済みサンプル/32) * (volGain/32) * masterScale * 0.20` で、この0.20が
 * **実機NESの抵抗網(FDS=47Ω直列・2A03=100Ω直列・負荷=39Ω)から算出した実測較正値**。
 * N163はこの手の実機較正が無い純粋な乗算式(sample-8)*volumeで、GBの波形chが
 * ほぼ常に「100%(レジスタ最大)」でしか鳴らない特性と組み合わさると、波形の中身
 * (振れ幅)次第でバランスが大きくブレた(2A03パルスの非線形ミキサーは音量を上げても
 * 頭打ちになるが、N163の式には圧縮が無いため)。FDSなら実機較正済みの0.20に乗っかれる。
 *
 * GBの波形(4bit,32点)→FDSの波形(6bit,64点)はビット拡張(ビット複製 (v<<2)|(v>>2) で
 * 0-15を0-63へ均等に対応させる、情報を捨てない)。音量はFDSがMML側では他chと同じv0-15
 * (compiler.js側で内部0-32ゲインへ2倍される、src/mml/compiler.js参照)なので、GBの実比率
 * (100:50:25=4:2:1)をそのまま余裕を持って{0,15,8,4}へ対応させる(N163のときのような
 * 解像度の潰れが起きない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Gbs2MmlExpansion = MML.Gbs2MmlExpansion || {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(FDS)のクロック。src/mml/compiler.js・nsf2mml/expansion/fds.jsと同じ値

  // f = 65536 / (2048 - freqReg) (Pan Docs、apuGb.jsのWaveChannel.clockTimer()と同じ式)
  function waveFreq(freqReg) { return freqReg < 2048 ? 65536 / (2048 - freqReg) : 0; }

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }

  // FDS周波数レジスタ(12bit、period)の連続値換算。fdsFreq(period)=period*CLOCK/(65536*64)
  // (src/nsf2mml/expansion/fds.jsと同じ式)の逆関数。detune計算用に丸めない生の値を返す
  // (src/convert/detune.js冒頭コメント: 差を取ってから1回だけ丸めること)。
  function fdsPeriodRaw(freq) { return (freq * 65536 * 64) / CPU_CLOCK_NTSC; }
  MML.Gbs2MmlExpansion._fdsPeriodRaw = fdsPeriodRaw; // converter.jsのapplyPitchDetune呼び出しで使う

  // GBの波形ch(32サンプル/周期)をFDSの波形ch(64サンプル/周期)へ変換する。
  // ①各サンプルを2回ずつ複製してサンプル数を32→64へ引き伸ばす(1周期の長さを合わせる。
  //   これをやらないとcompiler.js側が64個中の後半32個を未定義値=0で埋めてしまい、
  //   波形の後半が無音になった状態でFDSの1周期(64サンプル)を読み切ってしまう。
  //   結果、実際に鳴る波形は「前半だけ本来の形・後半は無音」という別物になり、
  //   fdsPeriodRaw()が前提とする「64サンプル=元のGB波形1周期分」ともズレて音程も狂う)。
  // ②4bit(0-15)を6bit(0-63)へビット複製で均等拡大する(情報を捨てない拡張)。
  function expandTo6bit(wave) {
    const upsampled = new Array(64);
    for (let i = 0; i < 32; i++) { upsampled[i * 2] = wave[i]; upsampled[i * 2 + 1] = wave[i]; }
    return upsampled.map(v => ((v << 2) | (v >> 2)) & 0x3F);
  }

  // GBの音量シフト(0=mute,1=100%,2=50%,3=25%)をFDSの音量(MML側0-15スケール、
  // compiler.js側で内部0-32ゲインへ2倍される)へ対応させる。GBの実比率(4:2:1)をそのまま
  // ラダーで表現する(N163のときのような解像度の潰れが起きない)。
  // ★2026-08-07: ユーザー実測で「まだ少し大きい」との指摘を都度反映し段階的に引き下げ
  // (15,8,4 → 12,6,3 → 10,5,2 → ユーザー指定で8,4,2に決定。ちょうど4:2:1の整数比)。
  const VOLUME_SHIFT_TO_FDS = { 0: 0, 1: 8, 2: 4, 3: 2 };

  function extractEvents(snapshots) {
    const events = [];
    let cur = null;
    let lastTriggerSeq = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < snapshots.length; f++) {
      const c = snapshots[f].ch3;
      const vol = VOLUME_SHIFT_TO_FDS[c.volumeShift] || 0;
      // NR51パンニングの両出力バスとも0ならch3(音量シフトは非0でも)無音扱い
      // (pulse.jsのpanAudible冒頭コメント参照)。CH3はNR51上のch index=2。
      const audible = c.enabled && c.dacOn && vol > 0 && MML.Gbs2MmlExpansion._panAudible(snapshots[f].nr51, 2);
      const freqHz = audible ? waveFreq(c.freq) : 0;
      const note = freqHz > 0 ? freqToNoteNumber(freqHz) : null;
      const wave = c.wave; // 元の4bit値(waveKey判定・スケーリング前の保持用)
      const waveKey = wave.join(',');
      const triggered = lastTriggerSeq !== null && c.triggerSeq !== lastTriggerSeq;
      lastTriggerSeq = c.triggerSeq;
      if (!cur) {
        cur = { note, wave, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: false };
        continue;
      }
      if (triggered || note !== cur.note || (note !== null && waveKey !== cur.waveKey)) {
        // トリガbit変化・波形切替が無く、純粋に音程だけが変わった場合はスラー分割のタイ候補
        const pureNoteChange = !triggered && note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave, waveKey, rawFreq: note !== null ? freqHz : null, start: f, end: f, volSeq: [vol], pitchSeq: [c.freq], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(vol);
        cur.pitchSeq.push(c.freq);
      }
    }
    flush(snapshots.length);
    return events;
  }

  MML.Gbs2MmlExpansion.wave = function (snapshots, waveReg, envReg) {
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)
    const events = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractEvents(snapshots)));
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
      (ev.note !== null && waveReg) ? { instrument: waveReg.assign(expandTo6bit(ev.wave)) } : {},
      ev.note !== null && ev.rawFreq != null ? { rawFreq: ev.rawFreq, freqSeq: ev.pitchSeq.map(waveFreq) } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      toVolumeFields(ev.volSeq)
    );
    const finalSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1].ch3 : null;
    return {
      events: events.map(toCommon),
      hasVolume: true, hasEnvelope: true, hasInstrument: true,
      fdsWave: finalSnap ? expandTo6bit(finalSnap.wave) : new Array(64).fill(0)
    };
  };
})(window);
