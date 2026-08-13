/*
 * N163拡張音源(波形音源、最大8ch・可変) → MML共通イベント形式 抽出
 * MML.Nsf2MmlExpansion.n163(writeLog, totalFrames, envReg, waveReg, initRegs, initWrites)
 *   → { channels: [...], n163Wave }
 *
 * レジスタ: $F800=内部RAMアドレス(bits0-6)+自動インクリメント(bit7), $4800=データ。
 *   有効チャンネル数 numCh = (($7F>>4)&7)+1。実機は内部8ch中「上位 numCh 個」だけを
 *   15CPUサイクルごとに巡回・ミックスする。チャンネルchのレジスタブロックは 0x40+ch*8:
 *     +0/+2/+4 = 18bit周波数(+4のbit2-7は波形長フィールドと共用, +1/+3/+5は位相),
 *     +6 = 波形開始オフセット(4bitサンプル単位), +7 = bits0-3=音量($7Fのみbits4-6=numCh)。
 *   出力周波数 f = CPU * freqReg / (15 * 65536 * length * numCh)、length = 256-(+4&0xFC)。
 * 専用のアタックレジスタが無いため、音量 0→非0 の遷移をノートオンとして扱う。
 *
 * 【重要】以前の実装は「常に8ch・ch0(0x40)の波形を全ch共有」と決め打っていたため、
 *  4chの曲では実チャンネル(上位4個=0x60/0x68/0x70/0x78)を読まず、未使用領域(0x40-0x58、
 *  実際には波形データが入る)をチャンネルとして誤読していた。ここでは $7F から numCh を求め、
 *  上位 numCh 個だけを「下位アドレス側から」letters[0..] に割り当てる(コンパイラ/ppmckDriver
 *  の internalIdx = (8-numCh)+i と一致)。周波数も numCh を含む実機式で算出する。
 *
 * 波形は各チャンネルが自分の波形(+6のオフセット/+4の長さ)を持つため、ch0共有ではなく
 * チャンネルごとに実波形を読み出し、waveReg(WaveRegistry、曲全体で共有・重複排除)に
 * 登録し、@<n>(instrument)で選択する。★波形は実機の生の長さのまま(16サンプルへの
 * リサンプリングはしない)抽出する。コンパイラ側(src/mml/n163Alloc.js共有バッファ
 * アロケータ)は既に可変長の@N<n>に対応済みだったが、抽出側だけが古い「常に16サンプルへ
 * 縮小」のままだったため、実機の波形長(例: 32サンプル)がある曲では音色の解像度が
 * 半分以下に失われ聴感上の「キレ」が損なわれていた(女神転生II 20曲目のベースで
 * ユーザー報告・実測: 実機は32サンプルなのに抽出は16サンプルに間引いていた)。
 * N163にはハードウェア音量エンベロープが無く音量は完全にソフトウェア書き込みのみなので、
 * ピッチ/波形が同じ間は音量変化だけでは区切らずvolSeqに積み、envReg(EnvelopeRegistry)へ
 * 実測形状として登録する(2A03等と同じ考え方)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Nsf2MmlExpansion = MML.Nsf2MmlExpansion || {};

  const CPU_CLOCK = 1789773;
  const UI_DEFAULT_WAVE_LEN = 16; // 波形エディタUI(MML.WaveformEditor)の固定枠に合わせた表示専用の長さ

  function freqToNoteNumber(freq) {
    if (freq <= 0) return null;
    const n = Math.round(57 + 12 * Math.log2(freq / 440));
    return (n >= 0 && n <= 119) ? n : null;
  }

  // 128byte RAM から base のチャンネルの波形を、実機の生の長さのまま読み出す(リサンプリング
  // しない)。波形アドレス(+6)・波形長(+4)は各チャンネル固有。サンプルは4bit(ニブル)単位で
  // RAMに詰まる。長さは256-(+4&0xFC)というレジスタの丸め規則そのものが既に4の倍数
  // (MML.N163Alloc.roundedLenと同じ規則)なので、ここで改めて丸め直す必要はない。
  function readNativeWave(ram, base) {
    const waveOffset = ram[base + 6];
    const length = Math.max(1, 256 - (ram[base + 4] & 0xFC));
    const sampleAt = a => (ram[(a >> 1) & 0x7F] >> ((a & 1) * 4)) & 0x0F;
    const wave = new Array(length);
    for (let i = 0; i < length; i++) wave[i] = sampleAt((waveOffset + i) & 0xFF);
    return wave;
  }

  // 波形エディタUIの既定波形表示専用(MML.WaveformEditorが固定16サンプル枠のため)。
  // 実際の音符の音色にはreadNativeWaveの生の長さをそのまま使う。
  function resampleWaveForUiDefault(ram, base) {
    const raw = readNativeWave(ram, base);
    const wave = new Array(UI_DEFAULT_WAVE_LEN);
    for (let i = 0; i < UI_DEFAULT_WAVE_LEN; i++) {
      const srcPos = Math.floor((i / UI_DEFAULT_WAVE_LEN) * raw.length) % raw.length;
      wave[i] = raw[srcPos] || 0;
    }
    return wave;
  }

  // フレームごとの 128byte RAM スナップショットと有効ch数の配列を作る。
  // 【最優先】capture.js が採取したライブチップの n163Snapshots があればそれを使う。
  //   N163は$F800(アドレスラッチ)+$4800(データ)の間接アドレッシングで、ドライバは位相バイトを
  //   $4800の「読み飛ばし」でスキップする(読み出しもオートインクリメントを進める)。writeLogは
  //   書き込みしか記録しないため、ログ再生ではアドレスポインタがズレて周波数/波形/音量が
  //   全て誤った位置から読まれる(Rolling Thunder等のインターリーブ配置ドライバで顕著)。
  // 【フォールバック】スナップショットが無い場合のみ writeLog を再生する(近似・非インターリーブ用)。
  function buildTimeline(writeLog, initWrites, n163Snapshots) {
    if (n163Snapshots && n163Snapshots.length) {
      return n163Snapshots.map(snap => {
        const ram = snap || new Uint8Array(128);
        return { ram, numCh: ((ram[0x7F] >> 4) & 0x07) + 1 };
      });
    }
    const ram = new Uint8Array(128);
    let addr = 0, autoInc = false;
    function applyWrite(a, value) {
      if      (a === 0xF800) { addr = value & 0x7F; autoInc = !!(value & 0x80); }
      else if (a === 0x4800) { ram[addr] = value; if (autoInc) addr = (addr + 1) & 0x7F; }
    }
    for (const { addr: a, value } of (initWrites || [])) applyWrite(a, value);
    return writeLog.map(writes => {
      for (const { addr: a, value } of writes) applyWrite(a, value);
      return { ram: ram.slice(), numCh: ((ram[0x7F] >> 4) & 0x07) + 1 };
    });
  }

  // ピッチ/波形が同じ間は音量変化だけでは区切らずvolSeqに積む(ソフトウェア音量エンベロープ抽出用、
  // パス1)。★N163には2A03/MMC5の$4003/$400B相当の専用アタックレジスタが無く、同じ音程・
  // 同じ波形のまま音量だけリセットしてノートを打ち直す(ロール奏法)場合、ピッチ/波形の
  // 変化だけを見ていると別々の発音を1つの音符に merge してしまう(女神転生II 25曲目、
  // N163 Sパートで同じ音程のまま5→4→3→5→4→3→5→4→3と3回打ち直されている「d+ f f f」相当の
  // ロールが、1本の長い音符+2周期分では足りずloop検出もできない中途半端なエンベロープに
  // 丸め込まれていた、とユーザー報告で発覚)。この「同ピッチ内の打ち直し検出」自体は
  // N163固有の話ではなく(FME7等アタックレジスタを持たないチップ全般に言える)ため、
  // src/convert/retrigger.js に音源非依存の判定として切り出し、パス2でランごとに適用する
  // (詳細な判定方針はそちらのコメント参照)。
  function extractChannelEvents(timeline, base) {
    const runs = [];
    let cur = null;
    function flush(end) { if (cur) { cur.end = end; if (cur.end > cur.start) runs.push(cur); cur = null; } }
    for (let f = 0; f < timeline.length; f++) {
      const ram = timeline[f].ram;
      const numCh = timeline[f].numCh;
      const freqReg = ram[base + 0] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const volume  = ram[base + 7] & 0x0F;
      const length  = Math.max(1, 256 - (ram[base + 4] & 0xFC));
      const freq = (freqReg * CPU_CLOCK) / (15 * 65536 * length * numCh);
      const wave = readNativeWave(ram, base);
      const waveKey = wave.join(',');
      const note = (volume > 0 && freqReg > 0) ? freqToNoteNumber(freq) : null;
      const rawFreq = note !== null ? freq : null;
      if (!cur) { cur = { note, wave, waveKey, rawFreq, rawNumCh: numCh, start: f, end: f, volSeq: [volume], pitchSeq: [freqReg], tieCandidate: false }; continue; }
      if (note !== cur.note || waveKey !== cur.waveKey) {
        // 打ち直し(パス2)判定前なので、ここでの「純粋な音程変化」は波形切替を伴わない
        // ことのみで判定する(hes2mml/expansion/wave.jsと同じ考え方)
        const pureNoteChange = note !== cur.note && waveKey === cur.waveKey;
        flush(f);
        cur = { note, wave, waveKey, rawFreq, rawNumCh: numCh, start: f, end: f, volSeq: [volume], pitchSeq: [freqReg], tieCandidate: pureNoteChange };
      } else {
        cur.volSeq.push(volume);
        cur.pitchSeq.push(freqReg);
      }
    }
    flush(timeline.length);

    // パス2: 各ラン(同ピッチ・同波形の区間)ごとに、打ち直し境界が無いか判定して分割する。
    // 休符(note===null)は対象外。
    const events = [];
    for (const run of runs) {
      if (run.note == null) { events.push(run); continue; }
      const ranges = MML.Convert.splitRetriggers(run.volSeq);
      for (const r of ranges) {
        events.push({
          note: run.note, wave: run.wave, waveKey: run.waveKey,
          rawFreq: run.rawFreq, rawNumCh: run.rawNumCh,
          start: run.start + r.start, end: run.start + r.end,
          volSeq: run.volSeq.slice(r.start, r.end),
          pitchSeq: run.pitchSeq.slice(r.start, r.end),
          tieCandidate: r.start === 0 ? run.tieCandidate : false
        });
      }
    }
    return events;
  }

  MML.Nsf2MmlExpansion.n163 = function (writeLog, totalFrames, envReg, waveReg, initRegs, initWrites, n163Snapshots, pitchReg) {
    const timeline = buildTimeline(writeLog, initWrites, n163Snapshots);
    // 曲を通しての有効ch数(通常は一定)。上位 numCh 個を下位アドレス側から letters[0..] に割当てる。
    let songNumCh = 1;
    for (const t of timeline) if (t.numCh > songNumCh) songNumCh = t.numCh;

    const letters = 'EFGHIJKL'.split(''); // 仮のレター。converter.js が expansionLetterMap['n163'] で振り直す

    // パス1: 全チャンネルぶんの生イベント(volSeqを保持したまま)を先に抽出する。envelopeVの
    // 採番はまだ行わない(次のチャンネル横断パスで、他chの確定ループをヒントに使うため)。
    const rawByChannel = [];
    for (let i = 0; i < songNumCh; i++) {
      const base = 0x40 + (8 - songNumCh + i) * 8; // internalIdx = (8-numCh)+i、下位側から
      // 分節のヒステリシス化(DESIGN-PITCH.md Phase 2)。順序はsplitRetriggers(打ち直し
      // 分割)の後(§5の手順順序: ハード境界→打ち直し分割→ピッチヒステリシスの順を維持)。
      // その後にP-5「不明瞭→EPテーブル」側+スラー分割(別プロジェクトE、2026-08-12)。
      rawByChannel.push({ base, events: MML.Convert.mergeUnclearPitchRuns(MML.Convert.mergeAlternatingVibrato(extractChannelEvents(timeline, base))) });
    }

    // パス1.5(2026-08-14): チャンネル横断の周期ヒント収集。あるチャンネルのイベントが
    // 自力でループを確定検出できていれば、その時間範囲・周期を「証拠(witness)」として
    // 集めておく(女神転生II 24曲目対応、詳細はsrc/convert/envelope.jsのコメント参照)。
    const loopWitnesses = [];
    for (const { events } of rawByChannel) {
      for (const ev of events) {
        if (ev.note == null) continue;
        const shape = MML.Convert.analyzeVolumeShape(ev.volSeq);
        if (shape && shape.loop != null) {
          loopWitnesses.push({ start: ev.start, end: ev.end, period: shape.values.length - shape.loop });
        }
      }
    }
    // このイベント単体ではループを確定できない場合、時間的にこのイベントを完全に包含する
    // 他chの確定ループが無いか探し、あればその周期をヒントに、このチャンネル自身の生データを
    // timelineから(ラン分割を無視して)読み直して矛盾が無いか確認する。他chの値をそのまま
    // 借用はしない(ボイスごとに音量が微妙に違う可能性があるため、あくまで周期だけを借りる)。
    function resolveVolumeShape(ev, base) {
      const shape = MML.Convert.analyzeVolumeShape(ev.volSeq);
      if (shape && shape.loop != null) return shape;
      for (const w of loopWitnesses) {
        if (w.start > ev.start || w.end < ev.end) continue;
        const seq = [];
        for (let f = w.start; f < w.end; f++) seq.push(timeline[f].ram[base + 7] & 0x0F);
        const hinted = MML.Convert.tryConfirmLoopWithHint(seq, w.period);
        if (hinted) return hinted;
      }
      return shape;
    }
    function toVolumeFields(ev, base) {
      if (!envReg) return { volume: ev.volSeq[0] };
      const idx = envReg.registerShape(resolveVolumeShape(ev, base), false);
      return idx == null ? { volume: ev.volSeq[0] } : { envelopeV: idx };
    }
    // freqRegは18bitの生レジスタ(numCh依存)なので、セント換算では浅いビブラートでも
    // 生レジスタ差分は大きくなりうる。符号付きbyte範囲(-127~126)を超える場合は
    // pitch.js側のclassifyPitchModが自動的にEP化を諦める(D<n>のみの既存動作を維持)。
    function toPitchFields(ev) {
      if (!pitchReg || ev.rawFreq == null) return {};
      const fields = {};
      MML.Convert.applyPitchAssignment(fields, pitchReg.assign(ev.pitchSeq));
      return fields;
    }
    const toCommon = (ev, base) => Object.assign(
      { start: ev.start, end: ev.end, note: ev.note, rawFreq: ev.rawFreq, rawNumCh: ev.rawNumCh,
        rawLength: ev.note !== null ? ev.wave.length : undefined, tieCandidate: ev.tieCandidate },
      ev.note !== null ? Object.assign(
        { instrument: waveReg ? waveReg.assign(ev.wave) : 0 },
        toVolumeFields(ev, base), toPitchFields(ev)
      ) : {}
    );

    const channels = [];
    for (let i = 0; i < songNumCh; i++) {
      const { base, events } = rawByChannel[i];
      const chEvents = events.map(ev => toCommon(ev, base));
      MML.Convert.markSlurTies(chEvents);
      channels.push({
        letter: letters[i],
        events: chEvents,
        hasVolume: true,
        hasEnvelope: true,
        hasInstrument: true
      });
    }

    // 波形エディタUIの既定波形として、最終フレームの先頭(最下位アドレス)チャンネルの波形を返す
    const lastRam = timeline.length > 0 ? timeline[timeline.length - 1].ram : null;
    const n163Wave = lastRam ? resampleWaveForUiDefault(lastRam, 0x40 + (8 - songNumCh) * 8) : null;

    return { channels, n163Wave };
  };

})(window);
