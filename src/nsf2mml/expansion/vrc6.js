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
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
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

  // ピッチ/enabledが同じ間は音量変化だけでは区切らずvolSeqに積む
  // (ソフトウェア音量エンベロープ抽出用。src/nsf2mml/converter.jsのパルス抽出と同じ考え方)。
  // 楽器化(2026-09-19、2A03/MMC5 パルスと同じ規則。判定は MML.NSF2MML.Instrument を共有):
  //   ・デューティ変化では区切らず dutySeq に積む(→ @@<n> デューティエンベロープ)。以前は区切って
  //     いたので、音符の頭1フレームだけデューティ0・音量15にする音色(悪魔城伝説 曲1 のパルス1)が
  //     「96分音符+本体」の2音符に割れ、本体のエンベロープも打ち直しになっていた
  //   ・周期上位($9002/$A002)の書き込みは VRC6 では位相リセットを伴わない(リセットは有効ビットを
  //     0 にしたときだけ)。同じ音程のまま音量が上がらない書き直しは音に一切現れないので区切らない
  //     (Konami のドライバは長い音符の途中で3レジスタを同じ値で書き直す。以前はここで割れて
  //     「@v13 d8 v3 d8.」になっていた)。その後減衰していくならリリース開始(keyOffAt)
  //   ・デューティ変化+音量上昇は再トリガーとして区切る
  function extractPulseEvents(timeline, chKey, attackIdx) {
    const events = [];
    let cur = null;
    const Inst = MML.NSF2MML.Instrument;
    const frameInfo = (f2) => {
      const t2 = timeline[f2];
      if (!t2) return null;
      return { attack: !!t2.attack[attackIdx], constVol: true, vol: t2[chKey].ctrl & 0x0F };
    };
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
      const begin = (tieCandidate) => { cur = { note, duty, vol: volume, constVol: true, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], dutySeq: [duty], keyOffAt: null, tieCandidate }; };
      if (!cur) { begin(false); continue; }
      const attack = !!t.attack[attackIdx];
      // ビブラート中は毎フレーム周期上位まで書き直す(=毎フレーム attack)。同じ音符の範囲なら pitchSeq に積んで EP/MP へ回す
      const samePitch = note !== null && note === cur.note;
      const lastDuty = cur.dutySeq[cur.dutySeq.length - 1];
      // 音に現れない書き直し: 同じ音符・同じデューティのまま音量が上がらない
      // ★音量は「同じ、または1だけ下がる」まで(減衰の1段がビブラートの書き直しと同じフレームに来る)。それより大きく
      //   下がる書き直しは、小さい音量から始まる音色の同音連打(新しい音符)でありうるので区切る
      const silentRewrite = attack && samePitch && duty === lastDuty && volume <= cur.vol && volume >= cur.vol - 1;
      const releaseMark = silentRewrite && Inst.isReleaseRewrite(frameInfo, f, cur, true, true, volume);
      const retrigger = Inst.isRetrigger(cur, true, duty, volume);
      if ((attack && !silentRewrite) || retrigger || note !== cur.note) {
        const pureNoteChange = !attack && !retrigger && note !== cur.note && duty === lastDuty;
        flush(f); begin(pureNoteChange);
      } else {
        if (releaseMark) cur.keyOffAt = f - cur.start;
        cur.vol = volume;
        cur.volSeq.push(volume);
        cur.pitchSeq.push(period);
        cur.dutySeq.push(duty);
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
      // MMLのVRC6のこぎり波音量は$B000蓄積レートの生値(0-63、本家ppmck同様。2026-08-24)
      const volume    = accumRate;
      const freq = sawFreq(period);
      const note = (enabled && accumRate > 0 && period >= 4) ? freqToNoteNumber(freq) : null;
      const rawFreq = note !== null ? freq : null;
      if (!cur) { cur = { note, rawFreq, start: f, end: f, volSeq: [volume], pitchSeq: [period], tieCandidate: false }; continue; }
      // 同じ音符のまま音量が上がらない $B002 の書き直しは音に現れない(パルスと同じ)ので区切らない
      const sawRewrite = t.attack[2] && note !== null && note === cur.note &&
        volume <= cur.volSeq[cur.volSeq.length - 1] && volume >= cur.volSeq[cur.volSeq.length - 1] - 4; // のこぎり波の音量は0-63(パルスの約4倍)
      if ((t.attack[2] && !sawRewrite) || note !== cur.note) {
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

  // inst: { vrReg, dutyReg, cmd }(楽器化の登録先。converter.js が渡す。無ければ従来どおり)
  MML.Nsf2MmlExpansion.vrc6 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites, n163Snapshots, pitchReg, noteEnvReg, inst) {
    const timeline = buildTimeline(writeLog, initRegs);
    const Inst = MML.NSF2MML.Instrument;
    const cmd = (inst && inst.cmd) || MML.Convert.normalizeCmd(null);
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側(2026-08-12)
    const evP1  = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p1', 0)));
    const evP2  = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractPulseEvents(timeline, 'p2', 1)));
    const evSaw = MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractSawEvents(timeline)));

    function toVolumeFields(volSeq) {
      const idx = envReg ? envReg.assign(volSeq) : null;
      return idx == null ? { volume: MML.Convert.plainVolume(volSeq) } : { envelopeV: idx };
    }
    // VRC6パルス/サウトゥースは周期レジスタ(値が下がるほど音程が上がる)なので
    // directionUp=false(src/convert/pitch.js fitVibrato参照)。
    function toPitchFields(ev) {
      if (!pitchReg || ev.rawFreq == null) return {};
      const fields = {};
      MML.Convert.applyPitchAssignment(fields, pitchReg.assign(ev.pitchSeq, false));
      return fields;
    }
    function toNoteEnvFields(ev) {
      if (!noteEnvReg || !ev.noteEnvOffsets) return {};
      const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
      return idx != null ? { noteEnv: idx } : {};
    }
    for (const evs of [evP1, evP2]) {
      for (const ev of evs) if (ev.note !== null) Inst.decideKeyOff(ev, cmd);
      Inst.markSilence(evs, e => e.note === null);
    }
    const toCommonPulse = ev => Object.assign(
      { start: ev.start, end: ev.note !== null ? Inst.endOf(ev) : ev.end, note: ev.note, instrument: ev.duty, rawFreq: ev.rawFreq, tieCandidate: ev.tieCandidate },
      ev.note !== null ? Inst.toneFields(ev, inst && inst.dutyReg, cmd) : {},
      ev.note !== null && envReg ? Inst.volumeFields(ev, envReg, inst && inst.vrReg) : toVolumeFields(ev.volSeq),
      toPitchFields(ev), toNoteEnvFields(ev)
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
