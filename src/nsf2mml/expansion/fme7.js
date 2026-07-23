/*
 * FME-7(Sunsoft 5B)拡張音源(矩形波x3) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.fme7(writeLog, totalFrames) → { channels: [...] }
 *
 * レジスタ: $C000=アドレスラッチ(0-15), $E000=データ書き込み。
 *   reg0/1,2/3,4/5 = ch A/B/C の12bit周期(lo/hi), reg8/9/10 = ch A/B/C 音量
 *   (bits0-3=固定音量、bit4=1でハードウェアエンベロープ使用(下位4bitは無視される)),
 *   reg11/12 = エンベロープ周期(16bit,全ch共有), reg13 = エンベロープ形状(下位4bit,
 *   書込みで位相リセット=ノートオンに相当、全ch共有)。
 * コンパイラ側(segmentsToWriteLogFme7)はノイズを一切使わず常時トーン有効固定
 * (fme7InitWrites)なので、ここでもノイズは無視し3トーンチャンネルのみ扱う。
 * 専用のアタックレジスタが無いため、固定音量時は音量 0→非0 の遷移を、エンベロープ
 * 使用時はreg13書込み(位相リセット)をノートオンとして扱う。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Nsf2MmlExpansion = MML.Nsf2MmlExpansion || {};

  const CPU_CLOCK = 1789773;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }
  function toneFreq(period) { return period >= 1 ? CPU_CLOCK / (16 * period) : 0; }

  // FME7は$C000(アドレスラッチ)+$E000(データ)の間接アドレッシングのため、initRegs
  // (最終値スナップショット)だけでは16個のレジスタ全体を復元できない。initWrites
  // (INIT実行中の全書き込みを順序付きで記録したもの)を先に再生することで、曲中
  // 一度もPLAY側で音色/周期を書き換えない曲でも正しい初期状態から始められる。
  function buildTimeline(writeLog, initWrites) {
    let latch = 0;
    const regs = new Uint8Array(16);
    for (const { addr: a, value } of (initWrites || [])) {
      if      (a === 0xC000) latch = value & 0x0F;
      else if (a === 0xE000) regs[latch] = value;
    }
    return writeLog.map(writes => {
      let envRestart = false;
      for (const { addr, value } of writes) {
        if      (addr === 0xC000) latch = value & 0x0F;
        else if (addr === 0xE000) {
          regs[latch] = value;
          if (latch === 13) envRestart = true;
        }
      }
      return {
        periods: [
          regs[0] | ((regs[1] & 0x0F) << 8),
          regs[2] | ((regs[3] & 0x0F) << 8),
          regs[4] | ((regs[5] & 0x0F) << 8),
        ],
        volRegs: [regs[8], regs[9], regs[10]],
        envPeriod: regs[11] | (regs[12] << 8),
        envShape: regs[13] & 0x0F,
        envRestart,
      };
    });
  }

  // ピッチが同じ間(かつ有音のまま)は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用)。ただし専用アタックレジスタが無いため、
  // 有音→無音→有音の遷移(volume 0を経由)は従来通り別ノートとして区切る。
  // ハードウェアエンベロープ使用時(音量レジスタbit4=1)はreg13書込み(位相リセット)や
  // 周期/形状の変化を別ノートの区切りとして扱う。
  function extractToneEvents(timeline, chIndex) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    function begin(f, note, envUsed, envShape, envPeriod, volume) {
      cur = { note, envUsed, envShape, envPeriod, start: f, end: f, volSeq: [volume] };
    }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.periods[chIndex];
      const volReg = t.volRegs[chIndex];
      const envUsed = !!(volReg & 0x10);
      const volume = envUsed ? 15 : (volReg & 0x0F); // 実際の減衰値はこのツールでは非対応(下記参照)
      const note = ((envUsed || volume > 0) && period >= 1) ? freqToNoteNumber(toneFreq(period)) : null;

      if (!cur) { begin(f, note, envUsed, t.envShape, t.envPeriod, volume); continue; }

      const restart = envUsed && t.envRestart;
      if (note !== cur.note || envUsed !== cur.envUsed || restart ||
          (envUsed && (t.envShape !== cur.envShape || t.envPeriod !== cur.envPeriod))) {
        flush(f);
        begin(f, note, envUsed, t.envShape, t.envPeriod, volume);
      } else if (!envUsed) {
        cur.volSeq.push(volume);
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Nsf2MmlExpansion.fme7 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites) {
    const timeline = buildTimeline(writeLog, initWrites);
    function toVolumeFields(ev) {
      // FME7のハードウェアエンベロープは全ch共有の1個しかない(R11/R12/R13はグローバル)ため、
      // 実際のAY/YM2149と同じ形状(のこぎり/三角/ホールド等16種類)をS<n>/M<n>にそのまま
      // 反映する。減衰値そのものをソフトウェア的にシミュレートする必要が無い
      // (2A03/MMC5と違いこちらはチップ内蔵の形状をコンパイラがそのまま再生できるため)。
      if (ev.envUsed) return { fme7EnvShape: ev.envShape, fme7EnvPeriod: ev.envPeriod };
      const idx = envReg ? envReg.assign(ev.volSeq) : null;
      return idx == null ? { volume: ev.volSeq[0] } : { envelopeV: idx };
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note },
      ev.note !== null ? toVolumeFields(ev) : {}
    );

    return {
      channels: [
        { letter: 'E', events: extractToneEvents(timeline, 0).map(toCommon), hasVolume: true, hasEnvelope: true, hasFme7Env: true },
        { letter: 'F', events: extractToneEvents(timeline, 1).map(toCommon), hasVolume: true, hasEnvelope: true, hasFme7Env: true },
        { letter: 'G', events: extractToneEvents(timeline, 2).map(toCommon), hasVolume: true, hasEnvelope: true, hasFme7Env: true },
      ]
    };
  };

})(window);
