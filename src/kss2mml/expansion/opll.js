/*
 * FMPAC(OPLL/YM2413) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.opll(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0x7C=アドレスラッチ, 0x7D=データ書込。
 *   0x10+ch=fnum下位, 0x20+ch=bit0=fnum上位,bits1-3=block,bit4=キーオン,
 *   0x30+ch=bits4-7=音色番号,bits0-3=音量。
 * アタック合図: 0x20+ch書き込みのbit4(キーオン)。ネイティブ出力レート49716Hz
 * (src/emulator/expansion/opllMsx.js/vrc7.jsと同じ、VRC7=OPLLなので式も同一)。
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
  function opllFreq(fnum, block) { return (fnum * 49716 * Math.pow(2, block)) / 524288; }

  function buildTimeline(writeLog) {
    let latch = 0;
    const regs = new Uint8Array(0x40);
    // キーオンの立ち上がり(0→1)だけを打ち直しとみなす。$2xはビブラート/音程更新の
    // ために毎フレーム書き直すドライバが多く、「キーオンビットが立った書込み」を
    // 全部アタック扱いにすると、1つのロングトーンが毎フレーム打ち直しに見えて
    // イベントが1フレーム単位に分解されてしまう(ピアノロールが短冊だらけになる)。
    // 実機YM2413もキーオン中に再度キーオンを書いてもエンベロープは再スタートしない。
    const keyon = [false, false, false, false, false, false];
    return writeLog.map(writes => {
      const attack = [false, false, false, false, false, false];
      for (const { addr, value, io } of writes) {
        if (!io) continue;
        // 0xF0/0xF1 は FM-PAC の別名ポート(src/emulator/kssBus.js ioWrite 参照)
        if (addr === 0x7C || addr === 0xF0) { latch = value & 0x3F; continue; }
        if (addr !== 0x7D && addr !== 0xF1) continue;
        regs[latch] = value;
        if (latch >= 0x20 && latch <= 0x25) {
          const ch = latch - 0x20;
          const on = !!(value & 0x10);
          if (on && !keyon[ch]) attack[ch] = true; // フレームを跨ぐ/跨がない両方の立ち上がりを拾う
          keyon[ch] = on;
        }
      }
      return { regs: regs.slice(), attack };
    });
  }

  // instrument===0(ユーザー定義音色)のときだけ、その時点の0x00-0x07(全ch共有の
  // カスタム音色スロット)8バイトをtoneRegに登録してインデックスを付与する
  // (nsf2mml/expansion/vrc7.jsと同じ考え方。VRC7=OPLLなのでレジスタ配置も同一)。
  // toneRegが無い(呼び出し元が対応していない)場合はvrc7Toneを付けず従来通り。
  function extractChannelEvents(timeline, ch, toneReg) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, attack } = timeline[f];
      const fnumLo = regs[0x10 + ch];
      const reg20 = regs[0x20 + ch];
      const block = (reg20 >> 1) & 0x07;
      const keyon = !!(reg20 & 0x10);
      const fnum = fnumLo | ((reg20 & 0x01) << 8);
      const reg30 = regs[0x30 + ch];
      const instrument = (reg30 >> 4) & 0x0F;
      const volume = reg30 & 0x0F;
      const freqHz = (keyon && fnum > 0) ? opllFreq(fnum, block) : null;
      const note = freqHz != null ? freqToNoteNumber(freqHz) : null;
      const vrc7Tone = (toneReg && note !== null && instrument === 0)
        ? toneReg.assign(Array.from(regs.slice(0, 8))) : undefined;
      if (!cur) { cur = { note, volume, instrument, vrc7Tone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: false }; continue; }
      if (attack[ch] || note !== cur.note || volume !== cur.volume || instrument !== cur.instrument ||
          vrc7Tone !== cur.vrc7Tone) {
        flush(f);
        // retrigger: このイベントが「キーオン(アタック)による打ち直し」で始まったか。
        // 音量エンベロープによる細切れ(1フレームごとの音量書換え)と区別するための印で、
        // ピアノロール側(src/main.js buildKssRollTimeline)が同音程の連結可否に使う。
        cur = { note, volume, instrument, vrc7Tone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: !!attack[ch] };
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.opll = function (writeLog, totalFrames, toneReg) {
    const timeline = buildTimeline(writeLog);
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument, retrigger: ev.retrigger },
      ev.note !== null && ev.freqHz != null ? { rawFreq: ev.freqHz } : {},
      ev.vrc7Tone !== undefined ? { vrc7Tone: ev.vrc7Tone } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}
    );
    return {
      channels: [0, 1, 2, 3, 4, 5].map(ch => ({
        // 高速アルペジオ→EN統合(2026-08-14拡張)。VRC7(=OPLL)はfnum/block対数空間の
        // ためD/EP/MPは使えないが、ENはノート番号→fnum/blockを都度再計算するだけなので
        // 使える(src/mml/compiler.js segmentsToWriteLogVrc7参照)
        events: MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, toneReg)).map(toCommon),
        hasVolume: true,
        hasInstrument: true,
        hasVrc7Tone: !!toneReg
      }))
    };
  };
})(window);
