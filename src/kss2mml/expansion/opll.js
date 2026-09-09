/*
 * FMPAC(OPLL/YM2413) → MML共通イベント形式 抽出
 * MML.Kss2MmlExpansion.opll(writeLog, totalFrames) → { channels: [...] }
 *
 * ポート0x7C=アドレスラッチ, 0x7D=データ書込。
 *   0x10+ch=fnum下位, 0x20+ch=bit0=fnum上位,bits1-3=block,bit4=キーオン,
 *   0x30+ch=bits4-7=音色番号,bits0-3=音量。
 * アタック合図: 0x20+ch書き込みのbit4(キーオン)。ネイティブ出力レート49716Hz
 * (src/emulator/expansion/opllMsx.js/vrc7.jsと同じ、VRC7=OPLLなので式も同一)。
 *
 * ★2026-08-22: メロディ9ch対応。それまで6chしか見ておらず($20-$25のみ)、YM2413本来の
 * 7-9ch目($26-$28)の音がピアノロールにもMML変換にも出てこなかった。VRC7(6ch固定)用に
 * 書いたものをFM-PACに流用したことによる取りこぼし。
 * リズムモード(レジスタ$0E bit5)中はch7-9がBD/HH+SD/TOM+CYMに化けてメロディではなく
 * なるため、曲中で一度でもリズムモードが使われたら6chとして返す(鍵盤表示側が
 * 6メロディ+5リズムの行構成になるのと一致させる。src/ui/keyboard.js の kssOpll 分岐参照)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Kss2MmlExpansion = MML.Kss2MmlExpansion || {};

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
  }
  function opllFreq(fnum, block) { return (fnum * 49716 * Math.pow(2, block)) / 524288; }

  // YM2413のメロディch数。リズムモード中はch7-9が打楽器に化けるので6として扱う。
  const NUM_MELODY_MAX = 9;
  const NUM_MELODY_RHYTHM = 6;

  function buildTimeline(writeLog) {
    let latch = 0;
    const regs = new Uint8Array(0x40);
    // キーオンの立ち上がり(0→1)だけを打ち直しとみなす。$2xはビブラート/音程更新の
    // ために毎フレーム書き直すドライバが多く、「キーオンビットが立った書込み」を
    // 全部アタック扱いにすると、1つのロングトーンが毎フレーム打ち直しに見えて
    // イベントが1フレーム単位に分解されてしまう(ピアノロールが短冊だらけになる)。
    // 実機YM2413もキーオン中に再度キーオンを書いてもエンベロープは再スタートしない。
    const keyon = new Array(NUM_MELODY_MAX).fill(false);
    let rhythmUsed = false;
    const frames = writeLog.map(writes => {
      const attack = new Array(NUM_MELODY_MAX).fill(false);
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite): addr=bit0-15 / value=bit16-23 / io=bit24
      for (const pw of writes) {
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF, io = (pw >> 24) & 1;
        if (!io) continue;
        // 0xF0/0xF1 は FM-PAC の別名ポート(src/emulator/kssBus.js ioWrite 参照)
        if (addr === 0x7C || addr === 0xF0) { latch = value & 0x3F; continue; }
        if (addr !== 0x7D && addr !== 0xF1) continue;
        regs[latch] = value;
        if (latch === 0x0E && (value & 0x20)) rhythmUsed = true; // リズムモード有効化
        if (latch >= 0x20 && latch <= 0x20 + NUM_MELODY_MAX - 1) {
          const ch = latch - 0x20;
          const on = !!(value & 0x10);
          if (on && !keyon[ch]) attack[ch] = true; // フレームを跨ぐ/跨がない両方の立ち上がりを拾う
          keyon[ch] = on;
        }
      }
      return { regs: regs.slice(), attack };
    });
    return { frames, rhythmUsed };
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
      // srcTone: 自作音色の実体(音色の同定 src/convert/toneKey.js 用。toneReg 無しのロール構築でも載せる)
      const srcTone = (note !== null && instrument === 0) ? Array.from(regs.slice(0, 8)) : undefined;
      if (!cur) { cur = { note, volume, instrument, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: false }; continue; }
      if (attack[ch] || note !== cur.note || volume !== cur.volume || instrument !== cur.instrument ||
          vrc7Tone !== cur.vrc7Tone) {
        flush(f);
        // retrigger: このイベントが「キーオン(アタック)による打ち直し」で始まったか。
        // 音量エンベロープによる細切れ(1フレームごとの音量書換え)と区別するための印で、
        // ピアノロール側(src/main.js buildKssRollTimeline)が同音程の連結可否に使う。
        cur = { note, volume, instrument, vrc7Tone, srcTone, freqHz: note !== null ? freqHz : null, start: f, end: f, retrigger: !!attack[ch] };
      }
    }
    flush(timeline.length);
    return events;
  }

  // ---- リズム音源(リズムモード時のch6-8が化ける5打楽器)の打点抽出 ----
  // レジスタ$0E: bit5=リズムモード有効、bit4=BD/bit3=SD/bit2=TOM/bit1=CYM/bit0=HH のキーオン
  // (ビット割当は src/emulator/expansion/opllNuked.js の RM_* と同じ)。
  // 音量は ch6-8 の $36-$38 を上下ニブルで分け合う:
  //   $36 下位=BD / $37 上位=HH・下位=SD / $38 上位=TOM・下位=CYM
  // ★音程の扱い(鍵盤表示と必ず揃えること):
  //   BD(ch6)とTOM(ch8)は実際にfnum/blockの音程を持つ打楽器なので**実音程**で置く。
  //     鍵盤側もこの2つだけ freq を出しているので、両者のノートが一致する。
  //   SD/CYM/HHは音程を持たない(ノイズ由来)ので、疑似音程 rollIndex で3レーンに分ける
  //     (roll-builders.js の toNotes が midi = 24 + noiseRollIndex で置く。AYノイズ行と同じ
  //      仕組み。鍵盤側も同じindexを noiseIndex として渡すので鍵盤のキーとも一致する)。
  //   fnumRegの組(下位/上位+block)から音程を求める。fnum=0や描画範囲(MIDI_MIN=24)より
  //   低くなる場合は疑似音程へフォールバックする。
  const RHYTHM_DEFS = [
    { key: 'bd',  bit: 4, volReg: 0x36, volShift: 0, rollIndex: 0, fnumLo: 0x16, fnumHi: 0x26 },
    { key: 'sd',  bit: 3, volReg: 0x37, volShift: 0, rollIndex: 2, fnumLo: null, fnumHi: null },
    { key: 'tom', bit: 2, volReg: 0x38, volShift: 4, rollIndex: 4, fnumLo: 0x18, fnumHi: 0x28 },
    { key: 'cym', bit: 1, volReg: 0x38, volShift: 0, rollIndex: 6, fnumLo: null, fnumHi: null },
    { key: 'hh',  bit: 0, volReg: 0x37, volShift: 4, rollIndex: 8, fnumLo: null, fnumHi: null }
  ];

  function extractRhythmEvents(timeline, def) {
    const events = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) events.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const regs = timeline[f].regs;
      const rm = (regs[0x0E] & 0x20) !== 0;
      const on = rm && ((regs[0x0E] >> def.bit) & 1) !== 0;
      if (!on) { flush(f); continue; }
      const volume = (regs[def.volReg] >> def.volShift) & 0x0F;
      // BD/TOMは実音程。範囲外(MIDI_MIN=24未満)や無音程時は疑似音程へ落とす
      let note = def.rollIndex, useRollIndex = true;
      if (def.fnumLo !== null) {
        const fnum = regs[def.fnumLo] | ((regs[def.fnumHi] & 0x01) << 8);
        const block = (regs[def.fnumHi] >> 1) & 0x07;
        const n = fnum > 0 ? freqToNoteNumber(opllFreq(fnum, block)) : null;
        if (n !== null && n + 12 >= 24) { note = n; useRollIndex = false; }
      }
      const mk = (retrigger) => useRollIndex
        ? { note, noiseRollIndex: def.rollIndex, volume, start: f, end: f, retrigger }
        : { note, volume, start: f, end: f, retrigger };
      if (!cur) { cur = mk(true); continue; }
      if (volume !== cur.volume || note !== cur.note) {
        flush(f);
        cur = mk(false);
      } else {
        cur.end = f;
      }
    }
    flush(timeline.length);
    return events;
  }

  MML.Kss2MmlExpansion.opll = function (writeLog, totalFrames, toneReg) {
    const { frames: timeline, rhythmUsed } = buildTimeline(writeLog);
    const toCommon = ev => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, volume: ev.volume, instrument: ev.instrument, retrigger: ev.retrigger },
      ev.note !== null && ev.freqHz != null ? { rawFreq: ev.freqHz } : {},
      ev.vrc7Tone !== undefined ? { vrc7Tone: ev.vrc7Tone } : {},
      ev.srcTone ? { srcTone: ev.srcTone } : {},
      ev.noteEnvOffsets ? { noteEnvOffsets: ev.noteEnvOffsets } : {}
    );
    // ★返すチャンネル本数は常に NUM_MELODY_MAX で固定する。
    // ピアノロールは再生しながら writeLog が伸びるたびに再構築される(進捗配信)ので、
    // 「リズムモードが使われたか」で本数を変えると、リズムが有効化される前の配信は9本・
    // 後の配信は6本…とトラック集合が途中で変わってしまい、鍵盤の行との1対1対応が崩れる。
    // 本数は固定したまま、リズムモード中に打楽器へ化けるch7-9のイベントだけを空にする。
    // リズム打楽器の打点。リズムモードを使う曲でだけ返す(呼び出し元=roll-builders.jsが
    // 5トラック作る。MML変換側は channels しか見ないのでここは無視される)。
    const rhythm = rhythmUsed
      ? RHYTHM_DEFS.reduce((acc, def) => { acc[def.key] = extractRhythmEvents(timeline, def); return acc; }, {})
      : null;

    return {
      rhythmUsed,
      rhythm,
      channels: Array.from({ length: NUM_MELODY_MAX }, (_, ch) => ({
        // 高速アルペジオ→EN統合(2026-08-14拡張)。VRC7(=OPLL)はfnum/block対数空間の
        // ためD/EP/MPは使えないが、ENはノート番号→fnum/blockを都度再計算するだけなので
        // 使える(src/mml/compiler.js segmentsToWriteLogVrc7参照)
        events: (rhythmUsed && ch >= NUM_MELODY_RHYTHM)
          ? []
          : MML.Convert.mergeVibratoAndArpeggio(extractChannelEvents(timeline, ch, toneReg)).map(toCommon),
        hasVolume: true,
        hasInstrument: true,
        hasVrc7Tone: !!toneReg
      }))
    };
  };
})(window);
