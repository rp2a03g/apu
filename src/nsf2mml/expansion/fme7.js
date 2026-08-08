/*
 * FME-7(Sunsoft 5B)拡張音源(矩形波x3) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.fme7(writeLog, totalFrames) → { channels: [...] }
 *
 * レジスタ: $C000=アドレスラッチ(0-15), $E000=データ書き込み。
 *   reg0/1,2/3,4/5 = ch A/B/C の12bit周期(lo/hi), reg8/9/10 = ch A/B/C 音量
 *   (bits0-3=固定音量、bit4=1でハードウェアエンベロープ使用(下位4bitは無視される)),
 *   reg11/12 = エンベロープ周期(16bit,全ch共有), reg13 = エンベロープ形状(下位4bit,
 *   書込みで位相リセット=ノートオンに相当、全ch共有)。
 *   reg6 = ノイズ周期(5bit,全ch共有), reg7 = ミキサー(bit0-2=トーン有効/bit3-5=ノイズ有効、
 *   いずれも0で有効のactive-low)。
 * ミキサーの状態はppmckの`@<n>`(0=ミュート/1=トーン/2=ノイズ/3=トーン+ノイズ)へそのまま
 * 対応させる。`@2`のときはppmck仕様に合わせてノート番号自体をノイズ周期(0-31)として出す
 * (n0=o0c〜n31=o2g)ため、この場合の`note`はreg6の生値になる。
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
  // 5B(YM2149)は内蔵1/2プリスケーラにより f=CLOCK/(32*period)(NESdev "Sunsoft 5B audio")。
  // MSXのPSG(kss2mml/expansion/ay.js)は入力クロックが半分なので同じ式で分母32=実質16になる
  function toneFreq(period) { return period >= 1 ? CPU_CLOCK / (32 * period) : 0; }

  // FME7は$C000(アドレスラッチ)+$E000(データ)の間接アドレッシングのため、initRegs
  // (最終値スナップショット)だけでは16個のレジスタ全体を復元できない。initWrites
  // (INIT実行中の全書き込みを順序付きで記録したもの)を先に再生することで、曲中
  // 一度もPLAY側で音色/周期を書き換えない曲でも正しい初期状態から始められる。
  function buildTimeline(writeLog, initWrites) {
    let latch = 0;
    const regs = new Uint8Array(16);
    // ミキサー(reg7)を一度も書かない曲があるため、エミュレータ(fme7.js)と同じ既定値から
    // 始める。0のまま始めると全chがトーン+ノイズ有効として抽出されてしまう
    regs[7] = 0x38;
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
        // ミキサー(active-low)を @<n> の 0-3 へ変換: bit0=トーン, bit1=ノイズ
        modes: [0, 1, 2].map(ch =>
          (((regs[7] >> ch) & 1) ? 0 : 1) | (((regs[7] >> (3 + ch)) & 1) ? 0 : 2)),
        noisePeriod: regs[6] & 0x1F,
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
    function begin(f, ev) { cur = Object.assign({ start: f, end: f, volSeq: [ev.volume] }, ev); }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const period = t.periods[chIndex];
      const volReg = t.volRegs[chIndex];
      const envUsed = !!(volReg & 0x10);
      const volume = envUsed ? 15 : (volReg & 0x0F); // 実際の減衰値はこのツールでは非対応(下記参照)
      const mode = t.modes[chIndex];
      const audible = (envUsed || volume > 0) && mode !== 0;
      // @2(ノイズ単独)はノート番号=ノイズ周期。それ以外はトーン周期から音程を求める
      let note = null, rawFreq = null;
      if (audible) {
        if (mode === 2) note = t.noisePeriod; // ノイズ周期(離散値)であり連続的な周波数ではないのでrawFreqは付けない
        else if (period >= 1) { rawFreq = toneFreq(period); note = freqToNoteNumber(rawFreq); }
      }
      const ev = {
        note, mode, envUsed, envShape: t.envShape, envPeriod: t.envPeriod, volume, rawFreq,
        // @3(トーン+ノイズ)のときだけN<n>を出す(@2はノート番号が周期を兼ねる)
        noise: mode === 3 ? t.noisePeriod : null,
      };

      if (!cur) { begin(f, ev); continue; }

      const restart = envUsed && t.envRestart;
      if (note !== cur.note || mode !== cur.mode || ev.noise !== cur.noise ||
          envUsed !== cur.envUsed || restart ||
          (envUsed && (t.envShape !== cur.envShape || t.envPeriod !== cur.envPeriod))) {
        flush(f);
        begin(f, ev);
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
      { start: ev.start, end: ev.end, note: ev.note, rawFreq: ev.rawFreq },
      ev.note !== null ? { instrument: ev.mode } : {},
      ev.note !== null && ev.noise !== null ? { fme7Noise: ev.noise } : {},
      ev.note !== null ? toVolumeFields(ev) : {}
    );

    const chan = (letter, index) => ({
      letter, events: extractToneEvents(timeline, index).map(toCommon),
      hasVolume: true, hasEnvelope: true, hasFme7Env: true,
      hasInstrument: true, hasFme7Noise: true
    });

    return { channels: [chan('E', 0), chan('F', 1), chan('G', 2)] };
  };

})(window);
