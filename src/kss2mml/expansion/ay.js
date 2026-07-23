/*
 * AY-3-8910(PSG) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.ay(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0xA0=レジスタ選択, 0xA1=データ書込。reg0/1,2/3,4/5=ch0-2の12bit周期(lo/hi)、
 * reg8/9/10=ch0-2の音量(下位4bit、bit4=エンベロープ使用)。専用アタックレジスタが
 * 無いため音量0→非0の遷移をノートオンとして扱う(nsf2mml/expansion/fme7.jsと同型)。
 * ノイズは(FME7抽出と同様)対象外、3トーンチャンネルのみ扱う。
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
      const toneEnabled = [0, 1, 2].map(ch => !(regs[7] & (1 << ch)));
      return { periods, volumes, toneEnabled };
    });
  }

  // ピッチ/トーン有効状態が同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/expansion/fme7.jsと同じ考え方)。
  function extractToneEvents(timeline, chIndex, clock) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.periods[chIndex];
      const volume = t.volumes[chIndex];
      const toneOn = t.toneEnabled[chIndex];
      const note = (toneOn && volume > 0 && period >= 1) ? freqToNoteNumber(toneFreq(period, clock)) : null;
      if (!cur) { cur = { note, start: f, end: f, volSeq: [volume] }; continue; }
      if (note !== cur.note) {
        flush(f);
        cur = { note, start: f, end: f, volSeq: [volume] };
      } else {
        cur.volSeq.push(volume);
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
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note }, toVolumeFields(ev.volSeq)
    );
    return {
      channels: [0, 1, 2].map(ch => ({
        events: extractToneEvents(timeline, ch, clock).map(toCommon),
        hasVolume: true, hasEnvelope: true
      }))
    };
  };
})(window);
