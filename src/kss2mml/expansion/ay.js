/*
 * AY-3-8910(PSG) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.ay(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0xA0=レジスタ選択, 0xA1=データ書込。reg0/1,2/3,4/5=ch0-2の12bit周期(lo/hi)、
 * reg8/9/10=ch0-2の音量(下位4bit、bit4=エンベロープ使用)。専用アタックレジスタが
 * 無いため音量0→非0の遷移をノートオンとして扱う(nsf2mml/expansion/fme7.jsと同型)。
 * reg6=ノイズ周期(5bit,全ch共有)、reg7=ミキサー(bit0-2=トーン有効/bit3-5=ノイズ有効、
 * どちらも0で有効のactive-low)。ミキサーはppmckの`@<n>`(0=ミュート/1=トーン/2=ノイズ/
 * 3=トーン+ノイズ)へ対応させ、`@2`ではノート番号自体がノイズ周期(0-31)になる。
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
  function toneFreq(period, clock) { return period >= 1 ? clock / (32 * period) : 0; }

  function buildTimeline(writeLog, clock) {
    let addrReg = 0;
    const regs = new Uint8Array(16);
    // ミキサー(reg7)を一度も書かない曲があるため、エミュレータ(ay8910Msx.js)と同じ
    // 既定値から始める。0のまま始めると全chがトーン+ノイズ有効として抽出されてしまう
    regs[7] = 0x38;
    return writeLog.map(writes => {
      for (const { addr, value, io } of writes) {
        if (!io) continue;
        if (addr === 0xA0) addrReg = value & 0x0F;
        else if (addr === 0xA1) regs[addrReg] = value;
      }
      const periods = [
        regs[0] | ((regs[1] & 0x0F) << 8),
        regs[2] | ((regs[3] & 0x0F) << 8),
        regs[4] | ((regs[5] & 0x0F) << 8),
      ];
      const volumes = [0, 1, 2].map(ch => {
        const v = regs[8 + ch];
        return (v & 0x10) ? 15 : (v & 0x0F); // エンベロープ使用時は簡略化して最大音量扱い
      });
      // reg7(ミキサー)のbit0-2=トーン無効(1で無効/active-low)。ここが立っている間は
      // そのチャンネルのトーン周期レジスタが古い値を保持したままノイズ専用や無音に
      // 切り替わっていることがあり(打楽器的なノイズ音とメロディを同じチャンネルで
      // 高速に切り替えるMSXドライバでよくある手法、実ファイルで確認済み)、それを見ずに
      // 周期レジスタだけでノート判定すると、ノイズ区間なのに直前のトーン音程のまま
      // 音量だけ変化する偽ノート(ノイズの減衰エンベロープを別々の短いノートの連打と
      // 誤検出)になっていた。
      const modes = [0, 1, 2].map(ch =>
        (((regs[7] >> ch) & 1) ? 0 : 1) | (((regs[7] >> (3 + ch)) & 1) ? 0 : 2));
      return { periods, volumes, modes, noisePeriod: regs[6] & 0x1F };
    });
  }

  // ピッチ/トーン有効状態が同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/expansion/fme7.jsと同じ考え方)。
  // ただし音量がそれまでの減衰傾向から上向きに跳ね上がった(=エンベロープ再アタック)
  // 場合は、同じ音程・同じ音量のままの同音連打であっても必ず新イベントに区切る。
  // 【周期レジスタへの書込みそのものを合図にする案(periodTouched)は撤回】PSGにも
  // SCC同様キーオン信号が無いため当初は「周期レジスタへの書込み+音量上昇」の両方を
  // 要求していたが、F1 Spirit 64曲目のSCC(同じ手法を移植したscc.js)で「音程が同じ
  // ままの同音連打で周波数レジスタが書き直されない(値が変わらないので省略される)」
  // 曲があり、periodTouchedを必須にすると本来の再アタックを見逃すことが判明した。
  // 音量が上向きに跳ね上がること自体がソフトウェアエンベロープの再アタックを意味する
  // ため、これだけで十分な合図になる(Ys1 12曲目のperiodTouched=falseの偽陽性ケースは
  // 音量も変化しない継続ティックだったため、この条件だけで元々弾かれていた)。
  function extractToneEvents(timeline, chIndex, clock) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.periods[chIndex];
      const volume = t.volumes[chIndex];
      const mode = t.modes[chIndex];
      // @2(ノイズ単独)はノート番号=ノイズ周期。それ以外はトーン周期から音程を求める
      let note = null;
      let freqHz = null; // トーン発音時の実周波数(デチューン検出用、ノイズ単独時はnull)
      if (volume > 0 && mode !== 0) {
        if (mode === 2) note = t.noisePeriod;
        else if (period >= 1) { freqHz = toneFreq(period, clock); note = freqToNoteNumber(freqHz); }
      }
      const noise = mode === 3 ? t.noisePeriod : null; // @3のみN<n>を出す
      if (!cur) { cur = { note, mode, noise, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      const retrigger = note !== null && volume > cur.volSeq[cur.volSeq.length - 1];
      if (retrigger || note !== cur.note || mode !== cur.mode || noise !== cur.noise) {
        // 音量ジャンプ(再アタック推定)が無く、純粋に音程だけが変わった場合はスラー分割の
        // タイ候補とする(src/convert/pitch.js markSlurTies参照。AYには専用アタック
        // レジスタが無いためretrigger推定(音量上昇)を「実アタックの代用」として使う)
        const pureNoteChange = !retrigger && note !== cur.note && mode === cur.mode && noise === cur.noise;
        flush(f);
        cur = { note, mode, noise, freqHz, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.ay = function (writeLog, totalFrames, clock, envReg) {
    const timeline = buildTimeline(writeLog, clock);
    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
    }
    // pitchEp(EP<n>参照)は借用先(FME7)の生レジスタ空間への変換が必要なため、ここでは
    // 付けずev.freqSeq(Hz)だけ残し、呼び出し元のkss2mml/converter.jsが
    // MML.Convert.rescalePitchSeqFromFreqで変換してから登録する(DESIGN-PITCH.md Phase 1、
    // src/convert/pitch.js冒頭コメント参照)。
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.mode } : {},
      ev.note !== null && ev.noise !== null ? { fme7Noise: ev.noise } : {},
      ev.note !== null && ev.freqHz != null
        ? { rawFreq: ev.freqHz, freqSeq: ev.pitchSeq.map(p => toneFreq(p, clock)) } : {},
      toVolumeFields(ev.volSeq)
    );
    return {
      channels: [0, 1, 2].map(ch => ({
        // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2): 半音境界を跨ぐビブラートが
        // 音符連打に化ける問題を、抽出後の後処理パスとして統合する(既存の毎フレーム
        // ループ自体は変えない)+P-5「不明瞭→EPテーブル」側(2026-08-12)
        events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeAlternatingVibrato(extractToneEvents(timeline, ch, clock))).map(toCommon),
        hasVolume: true, hasEnvelope: true, hasInstrument: true, hasFme7Noise: true
      }))
    };
  };
})(window);
