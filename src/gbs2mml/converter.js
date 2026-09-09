/*
 * GBS → MML コンバータ (Game Boy: CH1/CH2パルス + CH3波形 + CH4ノイズ)
 * MML.GBS2MML.fromGbs(gbsBytes, songIndex, durationSeconds)
 *   → Promise<{ mml: string, bpm: number, chips: string[], expansions: string[], fdsWave: number[] }>
 *
 * このアプリのMMLコンパイラ/プレイヤーはNES(6502+2A03+NES拡張音源)専用であり、GBを
 * ネイティブに再生する経路を持たない。DESIGN.md §5の「借用チップ」規約に従い、
 * GBのCH1/CH2パルス・CH4ノイズは構造がほぼ同じNESコア(2A03)のパルス/ノイズへそのまま
 * (拡張音源宣言不要で)乗せる。
 *
 * CH3(波形メモリ)は当初N163(4bitニブル詰めでビット深度が完全一致)へ載せていたが、
 * 実測でN163⇔2A03間の音量バランスが安定しなかったため**FDSへ変更した**(ユーザー確認済み、
 * 詳細はsrc/gbs2mml/expansion/wave.js冒頭コメント参照。要旨: FDSの出力式は実機NESの
 * 抵抗網から実測較正済みの係数を持つが、N163の出力式には圧縮が無くGBの「ほぼ常に
 * 100%」という特性と組み合わさるとバランスが安定しなかった)。GBの4bit波形→FDSの6bit波形は
 * ビット拡張(情報を捨てない)。
 *
 * 出力チャンネル: A/B=CH1/CH2(2A03パルス、拡張音源宣言不要) / D=CH4(2A03ノイズ、同上) /
 *   E=CH3(FDS、1chのみ)
 * A-D(2A03コア)のC(三角波)は使用しない(GBに対応する第3の持続音源が無いため空のまま)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.GBS2MML = {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(2A03/FDS)のクロック。src/mml/compiler.jsと同じ値

  // 2A03パルス周期の連続値換算(src/mml/compiler.jsのpulsePeriod()と同じ式、丸めない)。
  // detune計算は差を取ってから1回だけ丸めるため、呼び出し側で先に丸めてはいけない
  // (src/convert/detune.js冒頭コメント、kss2mml/converter.jsのfme7PeriodRawと同じ理由)。
  function pulsePeriodRaw(freq) { return CPU_CLOCK_NTSC / (16 * freq) - 1; }

  MML.GBS2MML.fromGbs = async function (gbsBytes, songIndex, durationSeconds, options) {
    options = options || {};
    const capture = await MML.Emu.captureGbsSongAsync(gbsBytes, {
      songIndex: songIndex || 0,
      durationSeconds: durationSeconds || 60,
      sampleRate: 44100
    }, options.onProgress || null);
    return MML.GBS2MML.convertCapture({
      snapshots: capture.snapshots,
      frameRate: capture.frameRate,
      songLabel: String(songIndex)
    }, options);
  };

  /**
   * キャプチャ済みデータからMMLへ変換する(fromGbsの後半)。VGM(src/vgm2mml)がGB DMG由来の
   * VGMを同じ抽出・出力経路で変換するために分離した(抽出器を複製しない方針、ROADMAP.md
   * VGM節)。fromGbs経由の出力は分離前と完全に同一。
   * @param {object} cap - { snapshots(gbsPlayer.js snapshotApu形式のフレーム配列), frameRate,
   *   songLabel(コメント用), sourceLabel(コメント用、既定'GBS') }
   */
  // ── チャンネル割当(案E) ────────────────────────────────────────
  // 変換元チャンネルのIDは鍵盤表示の行IDと同じ体系(GB1/GB2=パルス, GW=波形, GN=ノイズ)。
  // 音量は抽出時点で線形4bitなので linear:true(借用層の音量写像が対数の借用先へ換算する)。
  MML.GBS2MML.sourceChannels = function () {
    return [
      { id: 'GB1', label: 'GB CH1(パルス)', chip: 'gb', kind: 'square', ch: 0, linear: true, nativeFamily: 'pulse' },
      { id: 'GB2', label: 'GB CH2(パルス)', chip: 'gb', kind: 'square', ch: 1, linear: true, nativeFamily: 'pulse' },
      { id: 'GW', label: 'GB CH3(波形)', chip: 'gb', kind: 'wave', ch: 2, linear: true, nativeFamily: 'fds' },
      { id: 'GN', label: 'GB CH4(ノイズ)', chip: 'gb', kind: 'noise', ch: 3, linear: true, nativeFamily: 'noise' },
    ];
  };
  MML.GBS2MML.defaultPlan = function () {
    return { GB1: 'pulse1', GB2: 'pulse2', GW: 'fds', GN: 'noise' };
  };

  // 基準ピッチ(#TUNING)の自動検出: 変換本体(convertGbsOnce)を必要なら2回走らせる
  // (src/convert/options.js MML.Convert.autoTune 参照。全 *2mml 共通の入口の作り)
  MML.GBS2MML.convertCapture = function (cap, options) {
    return MML.Convert.autoTune(options, (o) => convertGbsOnce(cap, o));
  };
  function convertGbsOnce(cap, options) {
    options = options || {};
    // 変換設定(src/convert/options.js): コマンド使用/不使用・譜面整形(全レジストリ・
    // detune.js・emitScore へ同じ cmd を渡す)
    const cmd = MML.Convert.normalizeCmd(options.cmd);
    const snapshots = cap.snapshots;
    const totalFrames = snapshots.length;
    const frameRate = cap.frameRate;
    const songIndex = cap.songLabel;
    const sourceLabel = cap.sourceLabel || 'GBS';

    // 音量変化をソフトウェアエンベロープとして曲全体で共有登録するレジストリ
    // (kss2mml/nsf2mmlと同じ考え方。CH1/CH2/CH3/CH4すべてで共有し、偶然同じ減衰形状が
    // 出ればチャンネルをまたいでも1つの@v<n>にまとめられる)。
    const envReg = new MML.Convert.EnvelopeRegistry(cmd);
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry(cmd);
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry(cmd);
    // GBの波形(4bit/32点→FDSの6bit/64点へビット拡張)を曲全体で共有登録する
    // (@FM<n>としてMML本文のヘッダに埋め込む。nsf2mml/expansion/fds.jsと同じ形式)。
    const fdsWaveReg = new MML.Convert.WaveRegistry('@FM');

    // ユーザーがチャンネル割当(鍵盤表示、案E)を既定から変えたときだけ通る共通借用層
    // (src/convert/borrow.js)。既定のときは以下の従来コードをそのまま使う=出力は不変。
    const customPlan = options.channelMap || null;
    if (customPlan) {
      return convertWithPlan(cap, options, customPlan, { cmd, envReg, pitchReg, noteEnvReg, fdsWaveReg });
    }

    const ch1Result = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', envReg, frameRate);
    const ch2Result = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', envReg, frameRate);
    const noiseResult = MML.Gbs2MmlExpansion.noise(snapshots, envReg, frameRate);
    const waveResult = MML.Gbs2MmlExpansion.wave(snapshots, fdsWaveReg, envReg);
    const hasWave = waveResult.events.some(ev => ev.note !== null);

    // 借用変換(DESIGN.md §5): 変換元と変換先でチップ・クロックが異なる二重量子化を
    // 補正する。GBSはまずapplyPitchDetune(既定)を採用し、実測でKSSのような系統的な
    // ズレが見つかれば見直す方針(ユーザー確認済み)。
    MML.Convert.applyPitchDetune([{ events: ch1Result.events }], pulsePeriodRaw, { cmd });
    MML.Convert.applyPitchDetune([{ events: ch2Result.events }], pulsePeriodRaw, { cmd });
    if (hasWave) {
      MML.Convert.applyPitchDetune([{ events: waveResult.events }], MML.Gbs2MmlExpansion._fdsPeriodRaw, { cmd });
    }
    // 高速アルペジオ→EN統合(mergeVibratoAndArpeggioがev.noteEnvOffsetsを付与済みの
    // イベントを、曲全体で共有するnoteEnvRegへ登録してev.noteEnvを確定する。
    // pitchReg(EP)と同じく複数チャンネルをまたいだ重複排除のため1つの呼び出しにまとめる)。
    // ★必ずassignPitchEnvelopeより先に呼ぶこと(2026-08-14修正): assignPitchEnvelopeは
    // 内部でmarkSlurTiesを呼び、qualifiesForSlurがev.noteEnvの有無を見てタイ化を
    // 抑制する。ev.noteEnvがまだ未確定(noteEnvOffsetsのまま)の状態でmarkSlurTiesが
    // 走ると、アルペジオ統合済みイベントが誤ってタイ候補と判定され、mmlEmit側の
    // EN再送出(前回状態との差分判定)がスキップされて「@EN<n>定義は出力されるが
    // どの音符も参照していない」という気付きにくい退行になる(SPC変換で実測発覚)。
    MML.Convert.assignNoteEnvelope(
      hasWave ? [ch1Result, ch2Result, waveResult] : [ch1Result, ch2Result], noteEnvReg);

    // ピッチエンベロープも同じperiodFnで借用先の生レジスタ空間へ変換してから
    // 分類・登録する(DESIGN-PITCH.md Phase 1、applyPitchDetuneと同じ変換系列)。
    MML.Convert.assignPitchEnvelope([{ events: ch1Result.events }], pulsePeriodRaw, pitchReg);
    MML.Convert.assignPitchEnvelope([{ events: ch2Result.events }], pulsePeriodRaw, pitchReg);
    if (hasWave) {
      MML.Convert.assignPitchEnvelope([{ events: waveResult.events }], MML.Gbs2MmlExpansion._fdsPeriodRaw, pitchReg);
    }
    // ノイズは離散的な周期選択(2A03固定16通り)であり連続量の微調整という概念が無いため
    // detune補正の対象外(nsf2mml自体のネイティブノイズ抽出と同じ扱い)。

    const expansions = hasWave ? ['fds'] : [];
    const expansionLetterMap = expansions.length ? MML.Mml.assignExpansionLetters(expansions) : {};

    const scoreChannels = [
      Object.assign({}, ch1Result, { letter: 'A', hasDetune: true, hasPitchMod: true }),
      Object.assign({}, ch2Result, { letter: 'B', hasDetune: true, hasPitchMod: true }),
      Object.assign({}, noiseResult, { letter: 'D' })
    ];
    if (hasWave) {
      scoreChannels.push(Object.assign({}, waveResult, { letter: expansionLetterMap.fds[0], hasDetune: true, hasPitchMod: true }));
    }

    // チャンネル毎の発音開始間隔(IOI)を検出材料にする(MML.Convert.tempoMaterial、src/convert/bpm.js。
    // ゲートタイムで音符が短く切られてもIOIはグリッドに乗るため頑健)。
    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      noteDurations.push(...MML.Convert.tempoMaterial(sounding.map(ev => ev.start), sounding.map(ev => ev.end - ev.start)));
    }
    // 2倍/半分の決着は「実際に音価を書いてみて素直な方」(MML.Convert.chooseTempoOctave、src/convert/mmlEmit.js)
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.chooseTempoOctave(MML.Convert.detectBpm(noteDurations, frameRate), scoreChannels, frameRate, { totalFrames, cmd });
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパート(ノイズ等)で誤差が蓄積してドリフトする
    // (詳細は[[tempo-rounding-drift-future-issue]]参照、GBSノイズchで実測22フレーム/60秒の
    // ドリフトを確認して修正)。
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; ${sourceLabel} → MML 変換 (Game Boy: CH1/CH2パルス + CH3波形${hasWave ? '' : '(未使用)'} + CH4ノイズ)`,
      `; 曲番号   : ${songIndex}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: A=CH1(2A03パルス1) B=CH2(2A03パルス2) D=CH4(2A03ノイズ)${hasWave ? ' E=CH3(FDSとして近似再生)' : ''}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、GBのCH1/CH2/CH4はレジスタ構造が`,
      `;    近い2A03コアへそのまま、CH3(波形メモリ)は実機較正済みの音量バランスを持つFDSへ載せています。`,
      hasWave ? `;    FDS波形はGBの4bit値をビット拡張して6bitへ、音量は4段階(mute/100/50/25%)を0/15/8/4へ対応させた値です。` : `;`,
      ...MML.Convert.tuningCommentLines(),
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = hasWave ? [MML.Mml.EX_CHIP_DIRECTIVE.fds] : [];

    // 音符の区切り(NOTE_END、src/convert/envelope.js)。@v表を書き換えるので defLines() より前
    MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb, frameRate);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, cmd,
      headerLines: [
        ...MML.Convert.tuningHeaderLines(), ...directiveLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(hasWave ? fdsWaveReg.defLines() : [])
      ]
    });
    const mml = [headerComment, scoreText].join('\n');

    // 変換結果の音程検証(src/convert/verify.js): 最終MMLを実コンパイルして
    // 「実際に鳴る音の高さ」を変換元イベントと突き合わせる(失敗しても変換は妨げない)
    const pitchCheck = MML.Convert.verifyPitch
      ? MML.Convert.verifyPitch(mml, scoreChannels, { frameRate: frameRate, totalFrames: totalFrames })
      : null;

    return {
      mml, bpm: Math.round(bpm), pitchCheck, scoreChannels,
      chips: ['CH1', 'CH2', 'CH4'].concat(hasWave ? ['CH3'] : []),
      expansions,
      fdsWave: waveResult.fdsWave
    };
  };

  // ── ユーザー指定の割当で変換する(共通借用層 src/convert/borrow.js 経由) ──────
  // 既定の割当のときは上の従来コードが担当する(出力を変えないため)。ここは
  // 「GBのどのchをNES側のどのパートに載せるか」をユーザーが選び直したときだけ通る。
  function convertWithPlan(cap, options, customPlan, ctx) {
    const Plan = MML.Convert.ChannelPlan;
    const { cmd, envReg, pitchReg, noteEnvReg, fdsWaveReg } = ctx;
    const snapshots = cap.snapshots;
    const totalFrames = snapshots.length;
    const frameRate = cap.frameRate;
    const songIndex = cap.songLabel;
    const sourceLabel = cap.sourceLabel || 'GBS';
    const n163WaveReg = MML.Convert.n163WaveRegistry();
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');
    let fdsWave = null;

    const r = MML.Convert.Borrow.compose({
      sources: MML.GBS2MML.sourceChannels(),
      plan: Object.assign({}, MML.GBS2MML.defaultPlan(), customPlan),
      cmd,
      // GBSは借用変換(二重量子化の補正)なのでapplyPitchDetune方針を保つ
      // ([[kss2mml-pitch-detune-correction]]、従来経路と同じ)
      detuneMode: 'apply',
      regs: { envReg, pitchReg, noteEnvReg, n163WaveReg, vrc7ToneReg },
      toneOf: (id) => (options.tone || {})[id],
      extract: (chip, fam, reg) => {
        // FDS波形は借用先がFDSのときだけ本物のレジストリへ登録する(他のファミリへ載せる
        // 抽出でも登録すると、誰も参照しない@FM定義がMML本文に残るため)
        const waveReg = fam === 'fds' ? fdsWaveReg : new MML.Convert.WaveRegistry('@FM');
        const wave = MML.Gbs2MmlExpansion.wave(snapshots, waveReg, reg);
        if (fam === 'fds') fdsWave = wave.fdsWave;
        return {
          0: MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', reg, frameRate),
          1: MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', reg, frameRate),
          2: wave,
          3: MML.Gbs2MmlExpansion.noise(snapshots, reg, frameRate),
        };
      },
    });
    const { scoreChannels, expansions, letterMap } = r;

    // E(DPCM)へ載せたch(打楽器化): 分離レンダリングした打点(options.drumHits、main.js synthDrum)を
    // 共通コア(src/convert/drumHits.js)で @DPCM 化してEパートにする。GBのノイズドラム等がこれで
    // 実音のままNESへ渡る。定義があればEチャンネルは自動で有効(#EX宣言は不要)
    const dpcmDefLines = [], dpcmFiles = [];
    let drumNote = null;
    if (cmd.DRUM !== false && options.drumHits && options.drumHits.length && MML.Convert.DrumHits && MML.Dpcm) {
      const d = MML.Convert.DrumHits.dpcm(options.drumHits, frameRate, {
        totalFrames, dmcRate: cmd.DMC_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY, prefix: 'gb_drum', maxClipSec: 10 });
      if (d.defs.length) {
        for (const def of d.defs) dpcmDefLines.push(`@DPCM${def.index} = { "${def.file}", ${def.freq}, ${def.size}, ${def.dac}, ${def.mode} }`);
        dpcmFiles.push(...d.files);
        scoreChannels.push({ letter: 'E', events: d.events, hasInstrument: true, isDrum: true });
        MML.Convert.sortChannelsByLetter(scoreChannels);
        drumNote = `打楽器化したchを実音のままDPCM(E)へ変換しました: 定義${d.stats.clips}件 / 打点${d.stats.segments}個 / ROM ${(d.stats.bytes / 1024).toFixed(1)}KB`;
      }
    }

    const noteDurations = [];
    for (const ch of scoreChannels) {
      if (ch.isDrum) continue; // ドラムはテンポ推定から外す(vgm2mml と同じ理由)
      const sounding = ch.events.filter(ev => ev.note !== null);
      noteDurations.push(...MML.Convert.tempoMaterial(sounding.map(ev => ev.start), sounding.map(ev => ev.end - ev.start)));
    }
    // 2倍/半分の決着は「実際に音価を書いてみて素直な方」(MML.Convert.chooseTempoOctave、src/convert/mmlEmit.js)
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.chooseTempoOctave(MML.Convert.detectBpm(noteDurations, frameRate), scoreChannels, frameRate, { totalFrames, cmd });
    const fpb = frameRate * 60 / Math.round(bpm);

    const chanDesc = Object.keys(r.placed)
      .map(t => `${Plan.letterOfTarget(t)}=${r.placed[t].source.label}`).sort().join(' ');
    const headerComment = [
      `; =========================================================`,
      `; ${sourceLabel} → MML 変換 (Game Boy)`,
      `; 曲番号   : ${songIndex}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: ${chanDesc || '-'} (借用先の割当: ユーザー指定)`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、GBの各chはNES側の音源へ載せています`,
      `;    (割当は鍵盤表示のpart列/「借用先」列で変更できます)。`,
      ...r.notes.map(n => `; ※ ${n}`),
      ...(drumNote ? [`; ※ ${drumNote}`] : []),
      ...MML.Convert.tuningCommentLines(),
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = expansions.map(chip => chip === 'n163'
      ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${(letterMap.n163 || []).length}`
      : MML.Mml.EX_CHIP_DIRECTIVE[chip]);
    // 音符の区切り(NOTE_END、src/convert/envelope.js)。@v表を書き換えるので defLines() より前
    MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb, frameRate);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, cmd,
      headerLines: [
        ...MML.Convert.tuningHeaderLines(), ...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(expansions.indexOf('fds') >= 0 ? fdsWaveReg.defLines() : []),
        ...(expansions.indexOf('n163') >= 0 ? n163WaveReg.defLines() : []),
        ...(expansions.indexOf('vrc7') >= 0 ? vrc7ToneReg.defLines() : [])
      ]
    });
    const mml = [headerComment, scoreText].join('\n');
    const pitchCheck = MML.Convert.verifyPitch
      ? MML.Convert.verifyPitch(mml, scoreChannels, { frameRate: frameRate, totalFrames: totalFrames })
      : null;

    return {
      mml, bpm: Math.round(bpm), pitchCheck, scoreChannels,
      chips: ['CH1', 'CH2', 'CH3', 'CH4'],
      expansions,
      fdsWave,
      dpcmFiles // 打楽器化したchの @DPCM(main.js が dpcmSampleCache へ入れて即再生/NSF書き出し)
    };
  }
})(window);
