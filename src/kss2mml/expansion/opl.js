/*
 * OPL系(Y8950=MSX-AUDIO / YM3812 / YM3526) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.opl(writeLog, totalFrames, clock, toneReg) → { channels: [9], rhythm, adpcm }
 *
 * ポート0xC0=アドレスラッチ, 0xC1=データ書込(MSX-AUDIOの実I/Oポート。VGMのYM3812/YM3526/
 * Y8950も captureVgmSongAsync が同じ形でwriteLogへ流すので、KSS/VGMで本抽出器を共有する)。
 *   0xA0+ch=fnum下位8bit, 0xB0+ch=bit5キーオン/bit4-2ブロック/bit1-0 fnum上位,
 *   0xC0+ch=FB/CNT, スロット別 0x20/0x40/0x60/0x80/0xE0(+オフセット表)。
 *   0xBD: bit5=リズムモード, bit4-0=BD,SD,TOM,CYM,HH キーオン。
 * 音程: freq = fnum × 2^(block-1) × fs / 2^19、fs = clock/72(3.58MHzで49716Hz)。
 * 音量: キャリアTL(6bit×0.75dB)→ OPLL流の減衰値 v = TL>>2(0-15、3dB/step。値が大きいほど
 * 小さい音=OPLL/VRC7と同じ向き。roll側は attenuated=true で反転表示する)。
 *
 * ★音色はOPLLカスタム音色(@OP 8バイト)へ直接変換して vrc7Tone で出す(2op同士なので
 *   4op→2op変換より遥かに忠実。opllNuked.jsのPATCH_*と同じバイト並び):
 *     b0/b1 = AM|VIB|EGT|KSR|MULT (mod/car)
 *     b2    = KSL(mod)<<6 | TL(mod)   ※CNT=1(加算接続)はOPLLに無いのでTL=63(キャリアのみ)
 *     b3    = KSL(car)<<6 | DC<<4 | DM<<3 | FB  ※DC/DM=半波フラグ。OPL2のWS1(半サイン)を
 *             そのまま写像、WS2/WS3も半波で近似(YM3526はWS無し=常に0)
 *     b4-b7 = AR|DR(mod,car), SL|RR(mod,car)
 *
 * リズムモード: OPLLと同じ流儀(kss2mml/expansion/opll.js RHYTHM_DEFS)で、リズムを使う曲は
 * メロディ6ch+打楽器5種(BD/TOMは実音程、SD/CYM/HHは疑似音程レーン)。channelsは常に9本
 * 固定でリズム時のch7-9は空(ロールの進捗再構築でトラック集合が変わらないようにする)。
 *
 * ADPCM-B(Y8950): writeLogからはサンプル内容が見えない(CPUがデータポートへ流し込むため)
 * ので、音符化はせず打点だけを1レーンの疑似音程で出す(rhythmと同じ noiseRollIndex 方式、
 * ロール/鍵盤のOLB行用)。MML変換ではチャンネルにしない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  const NUM_MELODY_MAX = 9;
  const NUM_MELODY_RHYTHM = 6;

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }

  // ch → (mod, car) スロットレジスタオフセット
  function slotOf(ch) {
    const g = (ch / 3) | 0, k = ch % 3;
    return [g * 8 + k, g * 8 + k + 3];
  }

  function buildTimeline(writeLog) {
    let latch = 0;
    const regs = new Uint8Array(256);
    const keyon = new Array(NUM_MELODY_MAX).fill(false);
    let rhythmKeys = 0;
    let rhythmUsed = false;
    let adpcmOn = false;
    const frames = writeLog.map(writes => {
      const attack = new Array(NUM_MELODY_MAX).fill(false);
      const rhythmAttack = { bd: false, sd: false, tom: false, cym: false, hh: false };
      let adpcmAttack = false;
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (!io) continue;
        if (addr === 0xC0) { latch = value & 0xFF; continue; }
        if (addr !== 0xC1) continue;
        regs[latch] = value;
        if (latch >= 0xB0 && latch <= 0xB8) {
          const ch = latch - 0xB0;
          const on = !!(value & 0x20);
          if (on && !keyon[ch]) attack[ch] = true;
          keyon[ch] = on;
        } else if (latch === 0xBD) {
          if (value & 0x20) {
            rhythmUsed = true;
            const rising = value & ~rhythmKeys;
            if (rising & 0x10) rhythmAttack.bd = true;
            if (rising & 0x08) rhythmAttack.sd = true;
            if (rising & 0x04) rhythmAttack.tom = true;
            if (rising & 0x02) rhythmAttack.cym = true;
            if (rising & 0x01) rhythmAttack.hh = true;
            rhythmKeys = value & 0x1F;
          } else {
            rhythmKeys = 0;
          }
        } else if (latch === 0x07) {
          // ADPCM-B(Y8950)制御: START(bit7)かつRECでない書込みを打点とする
          const on = (value & 0x80) !== 0 && (value & 0x40) === 0;
          if (on && !adpcmOn) adpcmAttack = true;
          adpcmOn = on;
        }
      }
      return { regs: regs.slice(), attack, rhythmAttack, adpcmAttack };
    });
    return { frames, rhythmUsed };
  }

  // 現在のレジスタ影から ch の音色をOPLLカスタム音色8バイトへ(冒頭コメント参照)
  function opllToneBytes(regs, ch) {
    const [m, c] = slotOf(ch);
    const wse = !!(regs[0x01] & 0x20);
    const half = (s) => (wse && (regs[0xE0 + s] & 3) >= 1) ? 1 : 0;
    const b20 = (s) => regs[0x20 + s] & 0xFF; // AM|VIB|EGT|KSR|MULT: OPLLと同じビット並び
    const cnt = regs[0xC0 + ch] & 1;
    const fb = (regs[0xC0 + ch] >> 1) & 7;
    const mTL = cnt ? 0x3F : (regs[0x40 + m] & 0x3F);
    return [
      b20(m), b20(c),
      ((regs[0x40 + m] >> 6) << 6) | mTL,
      ((regs[0x40 + c] >> 6) << 6) | (half(c) << 4) | (half(m) << 3) | fb,
      regs[0x60 + m], regs[0x60 + c],
      regs[0x80 + m], regs[0x80 + c]
    ];
  }

  function extractChannelEvents(timeline, ch, fs, toneReg, keepSeq) {
    const events = [];
    const [, car] = slotOf(ch);
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, attack } = timeline[f];
      const fnum = regs[0xA0 + ch] | ((regs[0xB0 + ch] & 3) << 8);
      const block = (regs[0xB0 + ch] >> 2) & 7;
      const keyon = !!(regs[0xB0 + ch] & 0x20);
      const volume = Math.min(15, (regs[0x40 + car] & 0x3F) >> 2); // 減衰値(0=最大、OPLL向き)
      const freqHz = (keyon && fnum > 0) ? fnum * Math.pow(2, block - 1) * fs / 524288 : null;
      const note = freqHz != null ? freqToNoteNumber(freqHz) : null;
      const srcTone = note !== null ? opllToneBytes(regs, ch) : undefined; // 音色の同定(src/convert/toneKey.js)
      const vrc7Tone = (toneReg && srcTone) ? toneReg.assign(srcTone) : undefined;
      if (!cur) { cur = { note, volume, instrument: 0, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: false, volSeq: keepSeq ? [volume] : undefined }; continue; }
      if (attack[ch] || note !== cur.note || (!keepSeq && volume !== cur.volume) || vrc7Tone !== cur.vrc7Tone) {
        flush(f);
        cur = { note, volume, instrument: 0, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: !!attack[ch], volSeq: keepSeq ? [volume] : undefined };
      } else if (keepSeq) cur.volSeq.push(volume);
    }
    flush(timeline.length);
    return events;
  }

  // リズム5種(OPLLのRHYTHM_DEFSと同じ流儀。BD/TOMは実音程、他は疑似音程レーン)。
  // 音量はスロットのTL>>2(BD=ch6car, SD=ch7car, TOM=ch8mod, CYM=ch8car, HH=ch7mod)
  const RHYTHM_DEFS = [
    { key: 'bd',  bit: 0x10, tlSlot: () => slotOf(6)[1], rollIndex: 0, fnumCh: 6 },
    { key: 'sd',  bit: 0x08, tlSlot: () => slotOf(7)[1], rollIndex: 2, fnumCh: null },
    { key: 'tom', bit: 0x04, tlSlot: () => slotOf(8)[0], rollIndex: 4, fnumCh: 8 },
    { key: 'cym', bit: 0x02, tlSlot: () => slotOf(8)[1], rollIndex: 6, fnumCh: null },
    { key: 'hh',  bit: 0x01, tlSlot: () => slotOf(7)[0], rollIndex: 8, fnumCh: null }
  ];

  function extractRhythmEvents(timeline, def, fs) {
    const events = [];
    const tlSlot = def.tlSlot();
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, rhythmAttack } = timeline[f];
      const on = (regs[0xBD] & 0x20) !== 0 && (regs[0xBD] & def.bit) !== 0;
      if (!on) { flush(f); continue; }
      const volume = Math.min(15, (regs[0x40 + tlSlot] & 0x3F) >> 2);
      let note = def.rollIndex, useRollIndex = true;
      if (def.fnumCh !== null) {
        const ch = def.fnumCh;
        const fnum = regs[0xA0 + ch] | ((regs[0xB0 + ch] & 3) << 8);
        const block = (regs[0xB0 + ch] >> 2) & 7;
        const n = fnum > 0 ? freqToNoteNumber(fnum * Math.pow(2, block - 1) * fs / 524288) : null;
        if (n !== null && n + 12 >= 24) { note = n; useRollIndex = false; }
      }
      const attack = !!rhythmAttack[def.key];
      const mk = (retrigger) => useRollIndex
        ? { note, noiseRollIndex: def.rollIndex, volume, start: f, end: f, retrigger }
        : { note, volume, start: f, end: f, retrigger };
      if (!cur) { cur = mk(true); continue; }
      if (attack || volume !== cur.volume || note !== cur.note) { flush(f); cur = mk(attack); }
      else cur.end = f;
    }
    flush(timeline.length);
    return events;
  }

  // ADPCM-B(Y8950)の打点(1レーンの疑似音程。ロール/鍵盤のOLB行用、MML変換対象外)
  function extractAdpcmEvents(timeline) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const { regs, adpcmAttack } = timeline[f];
      const on = (regs[0x07] & 0x80) !== 0 && (regs[0x07] & 0x40) === 0;
      if (!on) { flush(f); continue; }
      const volume = Math.min(15, 15 - (regs[0x12] >> 4)); // level(0-255)→減衰値の向きへ
      if (!cur) { cur = { note: 10, noiseRollIndex: 10, volume, start: f, end: f, retrigger: true }; continue; }
      if (adpcmAttack || volume !== cur.volume) { flush(f); cur = { note: 10, noiseRollIndex: 10, volume, start: f, end: f, retrigger: !!adpcmAttack }; }
      else cur.end = f;
    }
    flush(timeline.length);
    return events;
  }

  // opts.envelope: opll.js と同じ(音量の変わり目で切らず attSeq で持つ。VGM→VRC7 用、2026-09-20)
  MML.Kss2MmlExpansion.opl = function (writeLog, totalFrames, clock, toneReg, opts) {
    const keepSeq = !!(opts && opts.envelope);
    const fs = (clock || 3579545) / 72;
    const { frames: timeline, rhythmUsed } = buildTimeline(writeLog);
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument, retrigger: ev.retrigger },
      ev.note !== null && ev.freqHz != null ? { rawFreq: ev.freqHz } : {},
      ev.vrc7Tone !== undefined ? { vrc7Tone: ev.vrc7Tone } : {},
      ev.srcTone ? { srcTone: ev.srcTone } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {},
      (ev.note !== null && ev.volSeq && ev.volSeq.some(v => v !== ev.volSeq[0])) ? { attSeq: ev.volSeq.map(v => v * 3) } : {}
    );
    const rhythm = rhythmUsed
      ? RHYTHM_DEFS.reduce((acc, def) => { acc[def.key] = extractRhythmEvents(timeline, def, fs); return acc; }, {})
      : null;
    const adpcm = extractAdpcmEvents(timeline);
    return {
      rhythmUsed,
      rhythm,
      adpcm: adpcm.length ? adpcm : null,
      channels: Array.from({ length: NUM_MELODY_MAX }, (_, ch) => ({
        events: (rhythmUsed && ch >= NUM_MELODY_RHYTHM)
          ? []
          : MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, fs, toneReg, keepSeq)).map(toCommon),
        hasVolume: true,
        hasInstrument: true,
        hasVrc7Tone: !!toneReg
      }))
    };
  };
})(window);
