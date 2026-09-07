/*
 * VRC7拡張音源(FM音源x6ch) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.vrc7(writeLog, totalFrames) → { channels: [...] }
 *
 * レジスタ: $9010=アドレスラッチ, $9030=データ書き込み。
 *   $10+ch=fnum下位, $20+ch=bit0=fnum上位,bits1-3=block,bit4=キーオン,
 *   $30+ch=bits4-7=音色番号(そのまま@Nに転記),bits0-3=音量(コンパイラの書式に
 *   合わせ反転せずそのまま使う)。
 * アタック合図: $20+ch書き込みのbit4(0x10)が立っている書き込み。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Nsf2MmlExpansion = MML.Nsf2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }
  // vrc7FreqToFnumBlock()の逆関数: freq = fnum * 2^block * 49716 / 2^19
  function vrc7Freq(fnum, block) { return (fnum * 49716 * Math.pow(2, block)) / 524288; }

  // VRC7は$9010(アドレスラッチ)+$9030(データ)の間接アドレッシングのため、initRegs
  // (最終値スナップショット)だけではレジスタ全体を復元できない。initWrites(INIT実行中の
  // 全書き込みを順序付きで記録したもの)を先に再生することで、曲中一度もPLAY側で
  // 音色/音程を書き換えない曲でも正しい初期状態から始められる。
  function buildTimeline(writeLog, initWrites) {
    let latch = 0;
    const regs = new Uint8Array(0x40);
    for (const { addr: a, value } of (initWrites || [])) {
      if (a === 0x9010) { latch = value & 0x3F; continue; }
      if (a !== 0x9030) continue;
      regs[latch] = value;
    }
    return writeLog.map(writes => {
      const attack = [false, false, false, false, false, false];
      for (const { addr, value } of writes) {
        if (addr === 0x9010) { latch = value & 0x3F; continue; }
        if (addr !== 0x9030) continue;
        regs[latch] = value;
        if (latch >= 0x20 && latch <= 0x25 && (value & 0x10)) attack[latch - 0x20] = true;
      }
      return { regs: regs.slice(), attack };
    });
  }

  // instrument===0(ユーザー定義音色)のときだけ、その時点の$00-$07(全ch共有の
  // カスタム音色スロット)8バイトをtoneRegに登録してインデックスを付与する。
  // toneRegが無い(呼び出し元が対応していない)場合はvrc7Toneを付けず従来通り。
  function extractChannelEvents(timeline, ch, toneReg) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, attack } = timeline[f];
      const fnumLo = regs[0x10 + ch];
      const reg20  = regs[0x20 + ch];
      const block  = (reg20 >> 1) & 0x07;
      const keyon  = !!(reg20 & 0x10);
      const fnum   = fnumLo | ((reg20 & 0x01) << 8);
      const reg30  = regs[0x30 + ch];
      const instrument = (reg30 >> 4) & 0x0F;
      const volume      = reg30 & 0x0F;
      const freq = vrc7Freq(fnum, block);
      const note = (keyon && fnum > 0) ? freqToNoteNumber(freq) : null;
      const rawFreq = note !== null ? freq : null;
      const vrc7Tone = (toneReg && note !== null && instrument === 0)
        ? toneReg.assign(Array.from(regs.slice(0, 8))) : undefined;
      if (!cur) { cur = { note, volume, instrument, vrc7Tone, rawFreq, start: f, end: f }; continue; }
      if (attack[ch] || note !== cur.note || volume !== cur.volume || instrument !== cur.instrument ||
          vrc7Tone !== cur.vrc7Tone) {
        flush(f);
        cur = { note, volume, instrument, vrc7Tone, rawFreq, start: f, end: f };
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Nsf2MmlExpansion.vrc7 = function (writeLog, totalFrames, envReg, toneReg, initRegs, initWrites, n163Snapshots, pitchReg, noteEnvReg) {
    const timeline = buildTimeline(writeLog, initWrites);
    const letters = 'EFGHIJ'.split('');
    // 高速アルペジオ→EN統合(2026-08-14拡張)。VRC7はfnum/block対数空間のためD/EP/MPは
    // 使えないが、ENはノート番号→fnum/blockを都度再計算するだけなので使える
    // (src/mml/compiler.js segmentsToWriteLogVrc7参照。hasNoteEnvフラグは
    // nsf2mml/converter.jsのdispatcherがhasPitchModと独立にVRC7へも常時付与する)
    function toNoteEnvFields(ev) {
      if (!noteEnvReg || !ev.noteEnvOffsets) return {};
      const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
      return idx != null ? { noteEnv: idx } : {};
    }
    const toCommon = ev => Object.assign({
      start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument,
      vrc7Tone: ev.vrc7Tone, rawFreq: ev.rawFreq
    }, toNoteEnvFields(ev));

    const channels = letters.map((letter, ch) => ({
      letter,
      events: MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, toneReg)).map(toCommon),
      hasVolume: true,
      hasInstrument: true,
      hasVrc7Tone: !!toneReg
    }));

    return { channels };
  };

})(window);
