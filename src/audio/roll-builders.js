/*
 * ピアノロール タイムライン構築(全フォーマット共通・純粋関数)
 * MML.RollBuild
 *
 * 元はmain.jsのbuildXxxRollTimeline群(+keyboard.jsのbuildRollTracksFromRegSnapshots)
 * としてメインスレッド専用だったが、キャプチャWorker化に伴い「1回あたりO(曲全体)の
 * タイムライン構築」がメインスレッドの長タスク(実測~90ms=オーディオバッファ級)として
 * 残ったため、構築そのものをキャプチャWorker内で実行できるようここへ分離した
 * (README-worker-build.txt参照)。メインスレッド(Workerフォールバック時)とWorker
 * バンドルの両方から同じコードが使われる。
 *
 * 依存(すべて実行時参照なので読み込み順は問わない。Workerバンドルには
 * tools/build-capture-workers.ps1が対応フォーマットぶんだけ同梱する):
 *   nsf/vgm: MML.UI.buildRollTracksFromRegSnapshots (src/ui/keyboard.js)
 *   kss/vgm: MML.Kss2MmlExpansion.ay/scc/opll (+MML.Convert: convert/pitch.js)
 *   gbs/vgm: MML.Gbs2MmlExpansion.pulse/noise/wave
 *   hes/vgm: MML.Hes2MmlExpansion.wave/noiseChannel/extractDdaClips
 *   spc:     MML.SPC2MML.extractVoiceEvents
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const RollBuild = MML.RollBuild = MML.RollBuild || {};

  // ── 高速アルペジオ(@EN)の展開 ────────────────────────────────────────
  // MML.Convert.mergeRapidArpeggio(src/convert/pitch.js)は、フレーム単位で音程が
  // 周期的に切り替わる高速アルペジオを「基準ノート1音 + ev.noteEnvOffsets(=@EN<n>、
  // フレーム毎の累積半音差分)」へ畳む。MML本文としてはそれが正しい表現だが、
  // ロールはそのイベントをそのまま描くため、基準ノート1本の長い帯になり、毎フレームの
  // 実レジスタ値を出している鍵盤表示と見た目が食い違う
  // (Space Manbow(MSX) 60曲目のSCC ch3=Rで実測。3.2秒以降のアルペジオ全域)。
  // @ENは「前フレームからの半音差分」なので基準ノートから順に足し込めば元の音程列が
  // 完全に復元でき、それは実レジスタ列とも(MMLを再生したときの実発音とも)一致する。
  // deltas省略時は分割せず元の1区間をそのまま返すので、呼び出し側は無条件に通してよい。
  RollBuild.expandNoteEnv = function (start, end, note, deltas) {
    if (!deltas || !deltas.length) return [{ start, end, note }];
    const out = [];
    let cur = note;
    let segStart = start;
    for (let f = start; f < end; f++) {
      const d = deltas[(f - start) % deltas.length];
      if (!d) continue;
      if (f > start) { out.push({ start: segStart, end: f, note: cur }); segStart = f; }
      cur += d;
    }
    out.push({ start: segStart, end, note: cur });
    return out;
  };

  // ── SPC ──────────────────────────────────────────────────────────────
  // drumKinds(省略可): srcn → 'drum' | 'pitch' の手動上書き(main.jsがBRR内容ハッシュで引く)。
  // 打楽器と判定したsrcnの発音は音程ノートではなく drumKey 付きノート(ドラム区画/パッド)に
  // する。判定はMML変換と同じ MML.SPC2MML.drumSrcns(ロール=MML変換デバッガの方針)。
  // 音色キー(src/convert/toneKey.js)をロールのノートに載せ、トラックの tones 表に表示/試聴用の
  // 付随情報を控える(音色一覧パネル src/ui/tonePanel.js の材料。main.js rebuildToneInventory)。
  // ★ノートに載せるのは文字列キーだけ(Workerからの構造化複製で運ぶ量を増やさない)。
  //   付随情報は音色ごとに1回、トラックオブジェクトのプロパティ tones に置く(配列に生やした
  //   プロパティは複製で消えるので、必ずトラック(オブジェクト)側に置く)
  RollBuild.toneOf = function (ev, ctx, tones) {
    const TK = MML.Convert && MML.Convert.ToneKey;
    if (!TK || !ctx) return undefined;
    const k = TK.ofEvent(ev, ctx);
    if (!k) return undefined;
    if (tones && !tones[k]) tones[k] = TK.infoOfEvent(ev, ctx, k);
    return k;
  };

  RollBuild.spc = function (log, frameRate, srcnFineTune, drumKinds) {
    const frameDur = 1 / frameRate;
    // MML変換と同じ原音チューニング補正を渡し、ロール表示の音程も実機発音に一致させる
    // (ロール=MML変換デバッガの方針。補正マップは再生開始時に一度だけ算出して使い回す)。
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    const drumSrcns = (drumKinds !== false && MML.SPC2MML.drumSrcns)
      ? MML.SPC2MML.drumSrcns(voiceEvents, srcnFineTune, drumKinds || null) : new Set();
    let drumSeq = 0;
    return voiceEvents.map((events, ch) => ({
      id: `V${ch}`,
      color: `hsl(${ch * 45},90%,65%)`,
      notes: events
        .filter(e => e.pitchSemi !== null)
        // 打楽器サンプルの発音: 音程軸ではなくドラム区画へ(midi無し、drumKey='brr:<srcn>')
        .map(e => (!e.non && drumSrcns.has(e.srcn))
          ? { drum: true, startSec: e.frame * frameDur, endSec: (e.frame + e.len) * frameDur, midi: null,
              drumKey: 'brr:' + e.srcn, drumSeq: ++drumSeq, vol: Math.max(0, Math.min(1, (e.vol || 0) / 127)), freqSeq: [] }
          : e)
        // 音量シェーディング用の簡易近似: ADSRモード(adsr1 bit7=1)ならサスティンレベル(adsr2 bit5-7、
        // 0-7)を目安の音量とする。GAINモード(直接指定)は減衰カーブを追わず常に最大音量扱い。
        // pitchSemi は note-number 空間(57=A4=MIDI69)なので MIDI へは +12。
        .reduce((acc, e) => {
          if (e.drum) { acc.push(e); return acc; } // ドラム区画のノートはそのまま
          // freqSeq(セント偏差オーバーレイ用): DSPピッチレジスタ(pitch=0x1000で原音32kHz)を
          // pitchToSemitone(src/spc2mml/converter.js)と同じ式でHzへ変換する。
          const tune = (srcnFineTune && srcnFineTune[e.srcn]) || 0;
          const tuneFactor = Math.pow(2, (tune + 3) / 12);
          const vol = (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1;
          const freqSeq = (e.pitchSeq || []).map(p => 440 * (p / 4096) * tuneFactor);
          // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
          // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)
          const steps = RollBuild.expandNoteEnv(e.frame, e.frame + e.len, e.pitchSemi + 12, e.noteEnvOffsets);
          for (let si = 0; si < steps.length; si++) {
            acc.push({
              startSec: steps[si].start * frameDur, endSec: steps[si].end * frameDur, midi: steps[si].note,
              vol, freqSeq: si === 0 ? freqSeq : [],
              // srcn: 借用先にE(DPCM)を選んだボイスをロール上でパッドへ置き換えるのに使う
              // (main.js applySynthDrumToRoll。ノートからBRRサンプルを特定できるのはこれだけ)
              srcn: e.srcn,
            });
          }
          return acc;
        }, []),
    }));
  };

  // ── KSS ──────────────────────────────────────────────────────────────
  // headerがSCCデコーダを持ちうる構成か(16Kバンク+RAMモードはバス側でSCCが殺される)
  RollBuild.kssHasSccDecoder = function (header) {
    return !!header && !(header.bankMode === '16K' && header.device.ramMode);
  };

  // writeLogのフレーム範囲[from,to)にSCC音源レジスタ(周波数/音量/有効ビット)への
  // 書込みがあるか。波形テーブルはクリア目的で0書きされることがあるため判定材料にせず、
  // 実際に発音に効くレジスタだけを見る。classic(SCC)は0x80-0x8F、SCC+(SCC-I)は
  // 0xA0-0xAF側も見る。
  RollBuild.kssWriteLogUsesScc = function (writeLog, from, to) {
    for (let f = from; f < to && f < writeLog.length; f++) {
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite)
      for (const pw of writeLog[f]) {
        if ((pw >> 24) & 1) continue;
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF;
        const off = (addr >= 0x9800 && addr <= 0x98FF) ? addr - 0x9800
          : (addr >= 0xB800 && addr <= 0xB8FF) ? addr - 0xB800 : -1;
        if (off < 0 || value === 0) continue;
        if ((off >= 0x80 && off <= 0x8F) || (off >= 0xA0 && off <= 0xAF)) return true;
      }
    }
    return false;
  };

  // PSG→KP/SCC→KS/FMPAC→KF は src/ui/keyboard.js の extractChannels() の色分けと揃える。
  // clockOverride(省略可): AY/SCC抽出器に渡すZ80相当クロック。KSSは常にMSXの3.58MHz、
  // VGMはチップごとに違う(vgmPlayer.js captureVgmSongAsync の kss.clock)ので呼び出し側が渡す。
  // oplOpts(省略可): { used, clock, adpcm } — OPL系(KSSのMSX-AUDIO / VGMのYM3812・YM3526・
  // Y8950)のOL行を作る。KSSは header.device.msxAudio から、VGMは data.kss.opl/oplClock から。
  RollBuild.kss = function (writeLog, totalFrames, frameRate, header, sccUsed, clockOverride, oplOpts) {
    const frameDur = 1 / frameRate;
    const clock = clockOverride || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // ★2026-08-22: ただし **OPLLだけ向きが逆**。AY/SCCの音量は「大きいほど大音量」だが、
    // OPLLのレジスタ$30下位4bitは減衰値で0が最大音量・15が無音(3dB/step)。
    // レジスタ生値の向きは変えられない(MML変換が v<n> をそのまま $30 のニブルへ書き戻す
    // 往復経路になっている。src/mml/compiler.js segmentsToWriteLogVrc7 の
    // `(instrument << 4) | seg.volume`、src/vgm2mml/converter.js の `ev.volume * 3` 参照)。
    // そのため反転はこの表示用正規化の中だけで行う。
    // note: Kss2MmlExpansionのfreqToNoteNumberはMML変換共通のノート番号体系(57=A4)で、
    // 標準MIDIより1オクターブ(12)低い。鍵盤描画に合わせるロール側でのみ+12補正する。
    // ★抽出イベントは「音量が1でも変わったら別イベント」に切れているため、音程が同じまま
    // 途切れず続いている区間を1本の音符に統合する(retriggerだけは区切りとして残す)。
    const toNotes = (events, attenuated, ctx, tones) => {
      const norm = (v) => {
        const n = Math.max(0, Math.min(15, v || 0));
        return (attenuated ? (15 - n) : n) / 15;
      };
      // ノイズ行(AYの@2)は note がノイズ周期そのもの(ppmckのFME-7仕様)なので、
      // そのまま +12 すると MIDI_MIN(24) を下回って描画されない。抽出器が付けてくれる
      // noiseRollIndex(0-15)を使い、他チップのノイズ行と同じ C1〜D#2 に並べる
      // (keyboard.js noisePeriodIndexToMidi と同じ 24+idx)。
      const midiOf = (e) => (e.noiseRollIndex !== undefined) ? 24 + e.noiseRollIndex : e.note + 12;
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
        // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)。
        // freqSeq(セント偏差オーバーレイ)と retrigger は元イベント先頭の区間にだけ効く。
        const steps = RollBuild.expandNoteEnv(e.start, e.end, midiOf(e), e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && !(e.retrigger && si === 0) && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, norm(e.volume));
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: norm(e.volume), freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    // 音色キー付きのトラック(ctx は toneKey.js ofEvent の文脈=チップと種別)
    const mk = (id, color, events, attenuated, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, attenuated, ctx, tones), tones }; };

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push(mk(`KP${i + 1}`, KP_COLS[i], ch.events, false, { chip: 'ay8910', kind: 'square' })));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push(mk(`KS${i + 1}`, `hsl(${(280 + i * 20) % 360},80%,60%)`, ch.events, false, { chip: 'k051649', kind: 'wave' })));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      // 第2引数true = OPLLの音量は減衰値なので表示用に反転する(toNotes冒頭のコメント参照)
      opllResult.channels.forEach((ch, i) => tracks.push(mk(`KF${i + 1}`, KF_COLS[i % KF_COLS.length], ch.events, true, { chip: 'ym2413', kind: 'fm' })));
      // リズムモードの打楽器5行。id/色/並び順は鍵盤側(keyboard.js の kssOpll 分岐、
      // RCOLS/RLABEL)と1対1で合わせる。音程を持たないので疑似音程(noiseRollIndex)で
      // 5レーンに分けている(kss2mml/expansion/opll.js の RHYTHM_DEFS 参照)。
      if (opllResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: `KF${RLABEL[key]}`, color: RCOLS[key],
            notes: toNotes(opllResult.rhythm[key] || [], true) });
        }
      }
    }

    // OPL系(MSX-AUDIO/YM3812/YM3526/Y8950): KF行と同じ流儀でOL行。音量はOPLL同様
    // 減衰値(attenuated=true)。リズムモード曲は打楽器5行、Y8950 ADPCM打点はOLB行。
    if (oplOpts && oplOpts.used && MML.Kss2MmlExpansion.opl) {
      const oplResult = MML.Kss2MmlExpansion.opl(writeLog, totalFrames, oplOpts.clock);
      const OL_COLS = ['#66ffcc', '#55eebb', '#44ddaa', '#33cc99', '#22bb88', '#11aa77', '#66e0d0', '#55d0c0', '#44c0b0'];
      oplResult.channels.forEach((ch, i) => tracks.push(mk(`OL${i + 1}`, OL_COLS[i % OL_COLS.length], ch.events, true, { chip: 'opl', kind: 'fm' })));
      if (oplResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RIDS = { bd: 'OLBD', sd: 'OLSD', tom: 'OLTM', cym: 'OLCY', hh: 'OLHH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: RIDS[key], color: RCOLS[key], notes: toNotes(oplResult.rhythm[key] || [], true) });
        }
      }
      if (oplResult.adpcm) tracks.push({ id: 'OLB', color: '#cc66ff', notes: toNotes(oplResult.adpcm, true) });
    }

    return tracks;
  };

  // ── GBS ──────────────────────────────────────────────────────────────
  RollBuild.gbs = function (snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // toNotes: 音程が同じまま途切れず続いている区間を1本の音符に統合する(GBは実トリガbitが
    // あるためretrigger判定はtriggerSeqの変化そのもの=抽出側で既にイベント境界として反映済み)。
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const mk = (id, color, events, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, ctx, tones), tones }; };
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになり無音扱いになる。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push(mk('GB1', '#66ddff', ch1.events, { chip: 'gb', kind: 'square' }));
    tracks.push(mk('GB2', '#0077dd', ch2.events, { chip: 'gb', kind: 'square' }));
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push(mk('GW', '#ffcc00', wave.events, { chip: 'gb', kind: 'wave' }));
    return tracks;
  };

  // ── HES ──────────────────────────────────────────────────────────────
  // dpcmTrace/controlTrace(省略可): 渡されると DDA(PCM)の打点を drumKey 付きノートとして
  // 該当chのトラックへ足す(ロールのドラム区画/パッドに出る。VGMのサンプルPCMと同じ形)。
  // 打点の同定は hes2mml/expansion/dpcm.js ddaHits(MML変換と同じ登録簿)なので、
  // ロールで見た太鼓と変換で出る @DPCM が一致する([[roll-as-mml-debugger]])。
  RollBuild.hes = function (snapshots, frameRate, dpcmTrace, controlTrace) {
    const frameDur = 1 / frameRate;
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots);
    // id/色はkeyboard.js extractChannels()のisHesブロック(PSG0-5, PCOLS)と揃える。
    const colors = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
    // ノイズはch4/5独自の発音で、行/鍵盤表示でも同じPSG4/PSG5の行がwave/noiseを兼ねる
    // (wave/noiseは同一chで排他なので時間的に重ならず、単純にマージしてよい)。
    waveResult.channels.forEach((ch, i) => {
      const tones = {};
      let notes = toNotes(ch.events, { chip: 'huc6280', kind: 'wave' }, tones);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes, tones });
    });
    // DDA(PCM)の打点 → ドラム区画のノート(midi無し、drumKey/drumSeq付き)。
    // 同じ太鼓の連打が1本に融合しないよう drumSeq に打点の通番を入れる
    if (dpcmTrace && controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.ddaHits) {
      try {
        const { hits } = MML.Hes2MmlExpansion.ddaHits(snapshots, dpcmTrace, controlTrace, frameRate);
        hits.forEach((h, i) => {
          const tr = tracks[h.ch];
          if (!tr) return;
          tr.notes.push({ startSec: h.startFrame * frameDur, endSec: h.endFrame * frameDur, midi: null,
                          drumKey: h.key, drumSeq: i + 1, vol: h.vol, freqSeq: [] });
        });
        for (const tr of tracks) tr.notes.sort((a, b) => a.startSec - b.startSec);
      } catch (e) { /* DDA抽出の失敗でロール全体を落とさない */ }
    }
    return tracks;
  };

  // ── NSF(keyboard.jsの共通抽出経路への橋渡し)──────────────────────────
  RollBuild.nsf = function (regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
    return MML.UI.buildRollTracksFromRegSnapshots(
      regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
  };

  // ── VGM(チップファミリごとに上の各ビルダー/共通抽出経路を連結)─────────
  // opts.poolMode: チャンネルプール式チップの表示モード({multipcm:'logical'|'phys'})。
  // 'logical'なら割当逆算済みスナップショット(data.multipcm.logical)でロールを組む
  RollBuild.vgm = function (data, done, opts) {
    const frameRate = data.frameRate;
    const sr = 44100;
    const buildTracks = MML.UI.buildRollTracksFromRegSnapshots;
    let tracks = [];
    if (data.nes) {
      const nesChips = ['nes'].concat(data.nes.fds ? ['fds'] : []);
      const t = buildTracks(data.nes.regSnapshots, data.nes.writeLog, done, sr / frameRate, sr, nesChips, null);
      if (t) tracks = tracks.concat(t);
    }
    if (data.gb) tracks = tracks.concat(RollBuild.gbs(data.gb.snapshots.slice(0, done), frameRate));
    if (data.hes) tracks = tracks.concat(RollBuild.hes(data.hes.snapshots.slice(0, done), frameRate));
    if (data.kss) {
      const wl = data.kss.writeLog.slice(0, done);
      const fakeHeader = { device: { mode: 'MSX', fmpac: data.kss.opll } };
      const kssTracks = RollBuild.kss(wl, done, frameRate, fakeHeader, data.kss.scc, data.kss.clock,
        data.kss.opl ? { used: true, clock: data.kss.oplClock } : null);
      // AY未使用(SCC/OPLLのみ)のVGMではKP行が鍵盤に無いのでロール側も落とす
      tracks = tracks.concat(data.kss.ay ? kssTracks : kssTracks.filter(t => !/^KP\d/.test(t.id)));
    }
    // 2個目のPSG(vgmPlayer.js captureVgmSongAsync の kss2): 同じKSS抽出器で作って KP4-6 へ付け替える
    if (data.kss2) {
      const wl2 = data.kss2.writeLog.slice(0, done);
      const t2 = RollBuild.kss(wl2, done, frameRate, { device: { mode: 'MSX', fmpac: false } }, false, data.kss2.clock, null)
        .filter(t => /^KP[1-3]$/.test(t.id))
        .map(t => Object.assign({}, t, { id: 'KP' + (+t.id.slice(2) + 3) }));
      tracks = tracks.concat(t2);
    }
    // スナップショット型チップ: extractChannels(keyboard.js)が読むextraSnapsに
    // フレーム毎スナップショット配列を渡して同じ抽出経路でトラック化する
    const snapChips = ['sn', 'ym2612', 'ym2610fm', 'ym2151', 'ym2203fm', 'ym2608fm', 'ga20', 'segapcm', 'c140', 'c352', 'okim6258', 'qsound', 'okim6295', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
    const chipToken = { sn: 'sn76489' };
    const poolMode = (opts && opts.poolMode) || {};
    for (const key of snapChips) {
      if (!data[key]) continue;
      const token = chipToken[key] || key;
      const snaps = (poolMode[key] === 'logical') ? (RollBuild.poolLogical(data, key) || data[key].snapshots) : data[key].snapshots;
      const extra = {}; extra[key] = snaps;
      const t = buildTracks(snaps, [], done, sr / frameRate, sr, ['vgm', token], null, extra);
      if (t) tracks = tracks.concat(t);
    }
    return tracks;
  };

  // ── プール式PCMチップの「合成ch」スナップショット ─────────────────────
  // logical は snapshots を Emu.PoolChannelRegrouper に先頭から順に通しただけの決定的なデータ。
  // キャプチャWorkerは通信量を減らすため logical を送らない(2026-09-13。c140 では progress の
  // 復元時間の約4割がこれだった)ので、画面側で合成ch表示が要るときだけここで作る。
  // snapshots が伸びていれば続きから足す(回帰器は状態を持つので同じインスタンスで続ける)。
  // メインスレッドで丸ごとキャプチャした data には logical が揃っているので、そのまま返す。
  RollBuild.poolLogical = function (data, key) {
    const d = data && data[key];
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots)) return null;
    const st = d.__logicalState;
    if (!st && Array.isArray(d.logical) && d.logical.length >= d.snapshots.length) return d.logical;
    const numCh = Emu && Emu.POOL_CHIP_CHANNELS && Emu.POOL_CHIP_CHANNELS[key];
    if (!numCh || !Emu.PoolChannelRegrouper) return null;
    if (!st || d.logical !== st.out) {
      // 列挙されない印にして、構造化複製やJSON化で運ばれないようにする
      Object.defineProperty(d, '__logicalState', { value: { rg: new Emu.PoolChannelRegrouper(numCh), out: [] }, configurable: true, writable: true });
      d.logical = d.__logicalState.out;
    }
    const S = d.__logicalState;
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.rg.step(d.snapshots[i]));
    return S.out;
  };

  // ── 構築スロットル ────────────────────────────────────────────────────
  // 壁時計ベース+直前の構築実測コスト×10を次回までの最小間隔にする適応制御
  // (構築のCPU占有率を~10%以下に自動制御。曲が進み1回の走査が重くなるほど自動的に
  // 間遠になる)。メインスレッドでは加えて非表示タブ中は最終回以外スキップする
  // (Worker内にはdocumentが無いので可視性チェックは自動的に無効=常時構築でよい。
  // Worker内の構築はメインスレッドをブロックしないため)。
  RollBuild.makeThrottle = function () {
    let lastBuildEnd = -Infinity;
    let minIntervalMs = 300;
    return {
      shouldBuild(done, total) {
        if (done >= total) return true; // 最終回は必ず構築(取りこぼし防止)
        if (typeof document !== 'undefined' && document.hidden) return false;
        return performance.now() - lastBuildEnd >= minIntervalMs;
      },
      didBuild(buildStartMs) {
        lastBuildEnd = performance.now();
        minIntervalMs = Math.max(300, Math.min(5000, (lastBuildEnd - buildStartMs) * 10));
      },
      force() { lastBuildEnd = -Infinity; }
    };
  };

  // ── ロール構築ジョブ(フォーマット差異の吸収)─────────────────────────
  // Worker実装(capture-worker-*-impl.js)とクライアントのフォールバック
  // (capture-worker-client.js)の両方から使う。build(data, done, total)は
  // {timeline, info} を返す(infoはフォーマット固有の副産物: KSSのsccUsed、
  // HESのddaChannel)。dataの形はフォーマットごとのキャプチャ進行データ:
  //   nsf: {regSnapshots, writeLog, n163Snapshots} / kss: {writeLog}
  //   gbs: {snapshots} / hes: {snapshots, dpcmTrace, controlTrace}
  //   spc: {frameLog} / vgm: captureVgmSongAsyncのdataそのもの
  RollBuild.createRollJob = function (format, params) {
    params = params || {};
    if (format === 'nsf') {
      return { build: (data, done) => ({
        timeline: RollBuild.nsf(data.regSnapshots, data.writeLog, done,
          params.samplesPerFrame, params.sampleRate, params.chips || [], data.n163Snapshots),
        info: {}
      }) };
    }
    if (format === 'kss') {
      const sccPossible = RollBuild.kssHasSccDecoder(params.header);
      let sccUsed = false;
      let scanned = 0;
      // MSX-AUDIO(Y8950)を積むKSSはOL行も作る(クロックはMSX固定3.58MHz)
      const oplOpts = (params.header && params.header.device && params.header.device.msxAudio)
        ? { used: true, clock: 3579545 } : null;
      return { build: (data, done) => {
        // SCCは「使われたと分かった時点で行を足す」単調運用(main.js playKssStream参照)
        if (sccPossible && !sccUsed && RollBuild.kssWriteLogUsesScc(data.writeLog, scanned, done)) sccUsed = true;
        scanned = done;
        return {
          timeline: RollBuild.kss(data.writeLog.slice(0, done), done, params.frameRate, params.header, sccUsed, null, oplOpts),
          info: { sccUsed }
        };
      } };
    }
    if (format === 'gbs') {
      return { build: (data, done) => ({
        timeline: RollBuild.gbs(data.snapshots.slice(0, done), params.frameRate), info: {}
      }) };
    }
    if (format === 'hes') {
      return { build: (data, done) => {
        const snaps = data.snapshots.slice(0, done);
        const out = { timeline: RollBuild.hes(snaps, params.frameRate, data.dpcmTrace, data.controlTrace), info: {} };
        // DDA(PCM)を担当するchの判定(曲全体でDDA区間が最も長い1ch)も同じ頻度で更新する。
        // 実際の再生に使う生のdpcmTrace列はメインスレッド側が保持しているので、
        // ここではチャンネル番号だけをinfoで返す(main.js側でsetDdaChannel)。
        if (data.dpcmTrace && data.controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.extractDdaClips) {
          out.info.ddaChannel = MML.Hes2MmlExpansion.extractDdaClips(
            snaps, data.dpcmTrace, data.controlTrace, params.frameRate).channel;
        }
        return out;
      } };
    }
    if (format === 'spc') {
      return { build: (data, done) => ({
        timeline: RollBuild.spc(data.frameLog.slice(0, done), params.frameRate, params.fineTune || null, params.drumKinds || null),
        info: {}
      }) };
    }
    if (format === 'vgm') {
      // params.poolMode: プール式チップの表示モード(Worker実行時はopt.roll経由で届く)
      return { build: (data, done) => ({ timeline: RollBuild.vgm(data, done, params), info: {} }) };
    }
    return null;
  };
})(window);
