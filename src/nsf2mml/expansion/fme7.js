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
    // 丸めは全形式共通(基準ピッチ #TUNING 込み。src/convert/options.js MML.Convert.freqToNote)
    return MML.Convert.freqToNote(freq);
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
    function begin(f, ev, period) { cur = Object.assign({ start: f, end: f, volSeq: [ev.volume], pitchSeq: [period] }, ev); }
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

      if (!cur) { begin(f, ev, period); continue; }

      const restart = envUsed && t.envRestart;
      const hardBoundary = mode !== cur.mode || ev.noise !== cur.noise ||
          envUsed !== cur.envUsed || restart ||
          (envUsed && (t.envShape !== cur.envShape || t.envPeriod !== cur.envPeriod));
      if (note !== cur.note || hardBoundary) {
        // 音色/エンベロープ/ミキサー由来の境界(hardBoundary)を伴わない純粋な音程変化のみ
        // スラー分割のタイ候補とする。★この境界で音量が跳ね上がっていない(=打ち直しでない)ことも要る
        // (2026-09-19。N163 と同じ穴: 5B もアタックレジスタが無く、打ち直しの手がかりは音量の跳ね上がり
        // だけ。見ていなかったので、ギミック! 曲1 は音符ごとに 11 6 4 3… と打ち直しているのに全部タイで
        // 繋がり、2音目以降の @v が消えて音量6のまま鳴り続けていた=音量の食い違いが全フレームの7割)
        const prevVol = cur.volSeq[cur.volSeq.length - 1];
        const reattack = !envUsed && !cur.envUsed && prevVol != null &&
          (volume - prevVol) >= MML.Convert.RETRIGGER_JUMP_THRESHOLD;
        ev.tieCandidate = note !== cur.note && !hardBoundary && !reattack;
        flush(f);
        begin(f, ev, period);
      } else {
        cur.pitchSeq.push(period);
        if (!envUsed) cur.volSeq.push(volume);
      }
    }
    flush(timeline.length);

    // パス2: 同じ音程が続くランの中の打ち直し(同音連打)を分ける(src/convert/retrigger.js、N163 と同じ)。
    // ハードウェアエンベロープ使用中はチップが音量を作るので対象外。
    // ★前の打ち直しの頭より 2 以上小さい音量への跳ね上がりは分けない: 音符の中のエコー
    //   (ギミック! の 11 6 4 3 3 | 8 6 5 4 4…)で、分けても音は同じ(5B は位相リセットが無い)だが、
    //   全音符が「本体+エコー」の2音符に割れて譜面が読めなくなる。1本の @v にしておく
    const out = [];
    for (const run of events) {
      if (run.note == null || run.envUsed || run.volSeq.length < 2) { out.push(run); continue; }
      const ranges = MML.Convert.splitRetriggers(run.volSeq);
      const groups = [];
      for (const r of ranges) {
        const g = groups[groups.length - 1];
        if (g && run.volSeq[r.start] <= run.volSeq[g.start] - 2) g.end = r.end;
        else groups.push({ start: r.start, end: r.end });
      }
      if (groups.length <= 1) { out.push(run); continue; }
      for (const g of groups) {
        out.push(Object.assign({}, run, {
          start: run.start + g.start, end: run.start + g.end,
          volSeq: run.volSeq.slice(g.start, g.end), pitchSeq: run.pitchSeq.slice(g.start, g.end),
          tieCandidate: g.start === 0 ? run.tieCandidate : false,
        }));
      }
    }
    return out;
  }

  MML.Nsf2MmlExpansion.fme7 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites, n163Snapshots, pitchReg, noteEnvReg) {
    const timeline = buildTimeline(writeLog, initWrites);

    // パス1: 3チャンネルぶんの生イベント(volSeqを保持したまま)を先に抽出する。envelopeVの
    // 採番はまだ行わない(次のチャンネル横断パスで、他chの確定ループをヒントに使うため。
    // N163版(src/nsf2mml/expansion/n163.js)と同じ考え方、詳細はsrc/convert/envelope.js参照)。
    // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)+高速アルペジオ→EN統合(2026-08-14)+
    // P-5「不明瞭→EPテーブル」側+スラー分割(別プロジェクトE、2026-08-12)
    const rawByChannel = [0, 1, 2].map(index =>
      MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeVibratoAndArpeggio(extractToneEvents(timeline, index))));

    // パス1.5(2026-08-14): チャンネル横断の周期ヒント収集。FME7も専用アタックレジスタが
    // 無く(N163と同じ穴、[[n163-retrigger-vs-tremolo]]参照)、疑似アタックのための一瞬の
    // ピッチ変化でラン分割が千切れることがある。ハードウェアエンベロープ使用中(envUsed)は
    // チップが直接減衰を生成するため対象外(ソフトウェア音量エンベロープのみが対象)。
    const loopWitnesses = [];
    for (const events of rawByChannel) {
      for (const ev of events) {
        if (ev.note == null || ev.envUsed) continue;
        const shape = MML.Convert.analyzeVolumeShape(ev.volSeq);
        if (shape && shape.loop != null) {
          loopWitnesses.push({ start: ev.start, end: ev.end, period: shape.values.length - shape.loop });
        }
      }
    }
    // このイベント単体ではループを確定できない場合、時間的にこのイベントを完全に包含する
    // 他chの確定ループが無いか探し、あればその周期をヒントに、このチャンネル自身の生音量を
    // timelineから(ラン分割を無視して)読み直して矛盾が無いか確認する。他chの値をそのまま
    // 借用はしない(ボイスごとに音量が微妙に違う可能性があるため、あくまで周期だけを借りる)。
    function resolveVolumeShape(ev, chIndex) {
      const shape = MML.Convert.analyzeVolumeShape(ev.volSeq);
      if (shape && shape.loop != null) return shape;
      for (const w of loopWitnesses) {
        if (w.start > ev.start || w.end < ev.end) continue;
        const seq = [];
        for (let f = w.start; f < w.end; f++) seq.push(timeline[f].volRegs[chIndex] & 0x0F);
        const hinted = MML.Convert.tryConfirmLoopWithHint(seq, w.period);
        if (hinted) return hinted;
      }
      return shape;
    }
    function toVolumeFields(ev, chIndex) {
      // FME7のハードウェアエンベロープは全ch共有の1個しかない(R11/R12/R13はグローバル)ため、
      // 実際のAY/YM2149と同じ形状(のこぎり/三角/ホールド等16種類)をS<n>/M<n>にそのまま
      // 反映する。減衰値そのものをソフトウェア的にシミュレートする必要が無い
      // (2A03/MMC5と違いこちらはチップ内蔵の形状をコンパイラがそのまま再生できるため)。
      // volume:15 は変換設定ENV=OFF(S/M不使用)時の代替(mmlEmit.jsはhasFme7Env側を優先するため
      // 通常時の出力には影響しない)
      if (ev.envUsed) return { fme7EnvShape: ev.envShape, fme7EnvPeriod: ev.envPeriod, volume: 15 };
      if (!envReg) return { volume: ev.volSeq[0] };
      const idx = envReg.registerShape(resolveVolumeShape(ev, chIndex), false);
      return idx == null ? { volume: MML.Convert.plainVolume(ev.volSeq) } : { envelopeV: idx };
    }
    // @2(ノイズ単独)はrawFreqがnullなのでここで自動的に対象外になる。
    // FME7トーンは周期レジスタ(値が下がるほど音程が上がる)なのでdirectionUp=false
    // (src/convert/pitch.js fitVibrato参照)。
    function toPitchFields(ev) {
      if (!pitchReg || ev.rawFreq == null) return {};
      const fields = {};
      MML.Convert.applyPitchAssignment(fields, pitchReg.assign(ev.pitchSeq, false));
      return fields;
    }
    // 高速アルペジオ→EN統合(2026-08-14拡張)。ノイズ単独(@2)はrawFreqが無いため
    // mergeRapidArpeggio側で自動的に対象外になる
    function toNoteEnvFields(ev) {
      if (!noteEnvReg || !ev.noteEnvOffsets) return {};
      const idx = noteEnvReg.registerShape(ev.noteEnvOffsets);
      return idx != null ? { noteEnv: idx } : {};
    }
    const toCommon = (ev, chIndex) => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, rawFreq: ev.rawFreq, tieCandidate: ev.tieCandidate },
      ev.note !== null ? { instrument: ev.mode } : {},
      ev.note !== null && ev.noise !== null ? { fme7Noise: ev.noise } : {},
      ev.note !== null ? toVolumeFields(ev, chIndex) : {},
      ev.note !== null ? toPitchFields(ev) : {},
      ev.note !== null ? toNoteEnvFields(ev) : {}
    );

    const chan = (letter, index) => {
      const events = rawByChannel[index].map(ev => toCommon(ev, index));
      MML.Convert.markSlurTies(events);
      return {
        letter, events,
        hasVolume: true, hasEnvelope: true, hasFme7Env: true,
        hasInstrument: true, hasFme7Noise: true, hasPitchMod: true
      };
    };

    return { channels: [chan('E', 0), chan('F', 1), chan('G', 2)] };
  };

})(window);
