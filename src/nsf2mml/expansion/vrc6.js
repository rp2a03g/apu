/*
 * VRC6拡張音源(パルスx2+サウ) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.vrc6(writeLog, totalFrames) → { channels: [...] }
 *
 * レジスタ(直書き、ラッチ不要): $9000-2=パルス1, $A000-2=パルス2, $B000-2=サウ
 *   ctrl: パルスはbits4-6=duty bits0-3=volume, サウはbits0-5=accumRate(≈volume*4)
 *   periodLo/periodHi(bit7=enable)
 * アタック合図: periodHi書き込み(コンパイラ側 segmentsToWriteLogVrc6 が毎ノート必ず書く)
 *
 * 音程は src/mml/compiler.js の pulsePeriod()/sawPeriod() の逆関数で求める。
 * パルスのduty(ctrl bits4-6, 0-7の8段階)は@<n>(instrument)としてそのまま出力する
 * (compiler.js側もseg.instrument%8を読むよう対応済み)。サウには波形/duty概念が無い。
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
  function pulseFreq(period) { return CPU_CLOCK / (16 * (period + 1)); }
  function sawFreq(period)   { return CPU_CLOCK / (14 * (period + 1)); }

  // initRegs(INIT実行後・PLAY開始前のレジスタ状態)からp1/p2/sawの初期状態を復元する。
  // 音色(duty)やサウのaccumRateを曲中一度もPLAY側で書き換えず、INIT時の1回だけ設定する
  // 曲があるため、これが無いと常に初期値(duty=0/無音)のまま検出されてしまう
  // (src/nsf2mml/expansion/fds.jsと同じ問題、3D Hot Rallyで実際に確認)。
  function buildTimeline(writeLog, initRegs) {
    const ir = initRegs || {};
    function reg(addr, def) { return ir[addr] !== undefined ? ir[addr] : def; }
    const p = [
      { ctrl: reg(0x9000, 0), lo: reg(0x9001, 0), hi: reg(0x9002, 0) },
      { ctrl: reg(0xA000, 0), lo: reg(0xA001, 0), hi: reg(0xA002, 0) }
    ];
    const s = { ctrl: reg(0xB000, 0), lo: reg(0xB001, 0), hi: reg(0xB002, 0) };
    return writeLog.map(writes => {
      const attack = [false, false, false];
      for (const { addr, value } of writes) {
        if      (addr === 0x9000) p[0].ctrl = value;
        else if (addr === 0x9001) p[0].lo = value;
        else if (addr === 0x9002) { p[0].hi = value; attack[0] = true; }
        else if (addr === 0xA000) p[1].ctrl = value;
        else if (addr === 0xA001) p[1].lo = value;
        else if (addr === 0xA002) { p[1].hi = value; attack[1] = true; }
        else if (addr === 0xB000) s.ctrl = value;
        else if (addr === 0xB001) s.lo = value;
        else if (addr === 0xB002) { s.hi = value; attack[2] = true; }
      }
      return { p1: { ...p[0] }, p2: { ...p[1] }, saw: { ...s }, attack };
    });
  }

  // ピッチ/duty/enabledが同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/converter.jsのパルス抽出と同じ考え方)。
  function extractPulseEvents(timeline, chKey, attackIdx) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const r = t[chKey];
      const period  = r.lo | ((r.hi & 0x0F) << 8);
      const enabled = !!(r.hi & 0x80);
      const volume  = r.ctrl & 0x0F;
      const duty    = (r.ctrl >> 4) & 0x07;
      const freq = pulseFreq(period);
      const note = (enabled && volume > 0 && period >= 4) ? freqToNoteNumber(freq) : null;
      const rawFreq = note !== null ? freq : null;
      if (!cur) { cur = { note, duty, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      if (t.attack[attackIdx] || note !== cur.note || duty !== cur.duty) {
        const pureNoteChange = !t.attack[attackIdx] && note !== cur.note && duty === cur.duty;
        flush(f);
        cur = { note, duty, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(timeline.length);
    return events;
  }

  function extractSawEvents(timeline) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const t = timeline[f];
      const r = t.saw;
      const period    = r.lo | ((r.hi & 0x0F) << 8);
      const enabled   = !!(r.hi & 0x80);
      const accumRate = r.ctrl & 0x3F;
      const volume    = Math.min(15, Math.round(accumRate / 4));
      const freq = sawFreq(period);
      const note = (enabled && accumRate > 0 && period >= 4) ? freqToNoteNumber(freq) : null;
      const rawFreq = note !== null ? freq : null;
      if (!cur) { cur = { note, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      if (t.attack[2] || note !== cur.note) {
        const pureNoteChange = !t.attack[2] && note !== cur.note;
        flush(f);
        cur = { note, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Nsf2MmlExpansion.vrc6 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites, n163Snapshots, pitchReg, noteEnvReg) {
    const timeline = buildTimeline(writeLog, initRegs);
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)
    const evP1  = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p1', 0)));
    const evP2  = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p2', 1)));
    const evSaw = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractSawEvents(timeline)));

    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: volSeq[0] } : { envelopeV: idx };
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
    const toCommonPulse = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, instrument: ev.duty, rawFreq: ev.rawFreq, tieCandidate: ev.tieCandidate },
      toVolumeFields(ev.volSeq), toPitchFields(ev), toNoteEnvFields(ev)
    );
    const toCommonSaw = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, rawFreq: ev.rawFreq, tieCandidate: ev.tieCandidate },
      toVolumeFields(ev.volSeq), toPitchFields(ev), toNoteEnvFields(ev)
    );

    // スラー分割(別プロジェクトE、2026-08-12): pitchEp/portamentoが確定した直後に行う
    const chP1 = evP1.map(toCommonPulse); MML.Convert.markSlurTies(chP1);
    const chP2 = evP2.map(toCommonPulse); MML.Convert.markSlurTies(chP2);
    const chSaw = evSaw.map(toCommonSaw); MML.Convert.markSlurTies(chSaw);

    return {
      channels: [
        { letter: 'E', events: chP1, hasVolume: true, hasEnvelope: true, hasInstrument: true },
        { letter: 'F', events: chP2, hasVolume: true, hasEnvelope: true, hasInstrument: true },
        { letter: 'G', events: chSaw, hasVolume: true, hasEnvelope: true },
      ]
    };
  };

})(window);
