/*
 * MMC5拡張音源(パルスx2) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.mmc5(writeLog, totalFrames) → { channels: [...] }
 *
 * レジスタ: $5000/$5004=ctrl(bits6-7=duty,bit4=固定音量,bits0-3=音量/envピリオド),
 *   $5002/$5006=periodLo, $5003/$5007=periodHi(bits0-2)。2A03パルスと全く同じ形式。
 * アタック合図: periodHi書き込み(実機はここでエンベロープ再始動、2A03と同じ)。
 * エンベロープモード(bit4=0)は2A03パルスと全く同じハードウェア減衰エンベロープなので、
 * nsf2mml/converter.js と同じくMML.Convert.simulateHwEnvelope()で厳密に再現する
 * (envKey=周期(bits0-3)+ループフラグ(bit5))。
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
  function pulseFreq(period) { return period >= 8 ? CPU_CLOCK / (16 * (period + 1)) : 0; }

  // initRegs(INIT実行後・PLAY開始前のレジスタ状態)からp1/p2/statusEnableの初期状態を
  // 復元する(src/nsf2mml/expansion/fds.jsと同じ問題、duty/envelopeを一度も
  // PLAY側で書き換えない曲があるため)。
  function buildTimeline(writeLog, initRegs) {
    const ir = initRegs || {};
    function reg(addr, def) { return ir[addr] !== undefined ? ir[addr] : def; }
    const p = [
      { ctrl: reg(0x5000, 0), lo: reg(0x5002, 0), hi: reg(0x5003, 0) },
      { ctrl: reg(0x5004, 0), lo: reg(0x5006, 0), hi: reg(0x5007, 0) }
    ];
    let statusEnable = reg(0x5015, 0x03); // $5015 bit0/1
    return writeLog.map(writes => {
      const attack = [false, false];
      for (const { addr, value } of writes) {
        if      (addr === 0x5000) p[0].ctrl = value;
        else if (addr === 0x5002) p[0].lo = value;
        else if (addr === 0x5003) { p[0].hi = value; attack[0] = true; }
        else if (addr === 0x5004) p[1].ctrl = value;
        else if (addr === 0x5006) p[1].lo = value;
        else if (addr === 0x5007) { p[1].hi = value; attack[1] = true; }
        else if (addr === 0x5015) statusEnable = value;
      }
      return { p1: { ...p[0] }, p2: { ...p[1] }, statusEnable, attack };
    });
  }

  // 固定音量モードのまま音量だけ変化する間は区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/converter.jsのパルス抽出と同じ考え方)。
  // エンベロープモード中にenvKey(周期/ループ)が変わった場合のみ別ノートとして区切る。
  function extractPulseEvents(timeline, chKey, statusBit, attackIdx) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const r = t[chKey];
      const active   = !!(t.statusEnable & statusBit);
      const period   = r.lo | ((r.hi & 0x07) << 8);
      const constVol = !!(r.ctrl & 0x10);
      const rawVol   = r.ctrl & 0x0F;
      const envKey   = r.ctrl & 0x2F;
      const volume   = constVol ? rawVol : 15;
      const audible  = constVol ? rawVol > 0 : true;
      const duty     = (r.ctrl >> 6) & 0x03;
      const freq = pulseFreq(period);
      const note = (active && audible && freq > 0) ? freqToNoteNumber(freq) : null;
      const rawFreq = note !== null ? freq : null;
      if (!cur) { cur = { note, duty, constVol, envKey, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      if (t.attack[attackIdx] || note !== cur.note || duty !== cur.duty || constVol !== cur.constVol ||
          (!constVol && envKey !== cur.envKey)) {
        const pureNoteChange = !t.attack[attackIdx] && note !== cur.note && duty === cur.duty &&
          constVol === cur.constVol && (constVol || envKey === cur.envKey);
        flush(f);
        cur = { note, duty, constVol, envKey, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.pitchSeq.push(period);
        if (constVol) cur.volSeq.push(volume);
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Nsf2MmlExpansion.mmc5 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites, n163Snapshots, pitchReg, noteEnvReg) {
    const timeline = buildTimeline(writeLog, initRegs);
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)
    const evP1 = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p1', 1, 0)));
    const evP2 = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p2', 2, 1)));

    function toVolumeFields(ev) {
      if (!envReg) return { volume: ev.volSeq[0] };
      if (!ev.constVol) {
        const period = ev.envKey & 0x0F;
        const loop = !!(ev.envKey & 0x20);
        const shape = MML.Convert.simulateHwEnvelope(period, loop);
        return { envelopeV: envReg.registerShape(shape, true) };
      }
      const idx = envReg.assign(ev.volSeq);
      return idx == null ? { volume: ev.volSeq[0] } : { envelopeV: idx };
    }
    function toPitchFields(ev) {
      if (!pitchReg || ev.rawFreq == null) return {};
      const fields = {};
      MML.Convert.applyPitchAssignment(fields, pitchReg.assign(ev.pitchSeq));
      return fields;
    }
    function toNoteEnvFields(ev) {
      if (!noteEnvReg || !ev.noteEnvOffsets) return {};
      const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
      return idx != null ? { noteEnv: idx } : {};
    }
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, instrument: ev.duty, rawFreq: ev.rawFreq, tieCandidate: ev.tieCandidate },
      ev.note !== null ? toVolumeFields(ev) : {},
      ev.note !== null ? toPitchFields(ev) : {},
      ev.note !== null ? toNoteEnvFields(ev) : {}
    );

    // スラー分割(別プロジェクトE、2026-08-12)
    const chP1 = evP1.map(toCommon); MML.Convert.markSlurTies(chP1);
    const chP2 = evP2.map(toCommon); MML.Convert.markSlurTies(chP2);

    return {
      channels: [
        { letter: 'E', events: chP1, hasVolume: true, hasInstrument: true, hasEnvelope: true },
        { letter: 'F', events: chP2, hasVolume: true, hasInstrument: true, hasEnvelope: true },
      ]
    };
  };

})(window);
