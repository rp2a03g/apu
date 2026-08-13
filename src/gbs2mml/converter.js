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
    const header = MML.GBS.parseHeader(gbsBytes);
    const capture = await MML.Emu.captureGbsSongAsync(gbsBytes, {
      songIndex: songIndex || 0,
      durationSeconds: durationSeconds || 60,
      sampleRate: 44100
    });
    const snapshots = capture.snapshots;
    const totalFrames = snapshots.length;
    const frameRate = capture.frameRate;

    // 音量変化をソフトウェアエンベロープとして曲全体で共有登録するレジストリ
    // (kss2mml/nsf2mmlと同じ考え方。CH1/CH2/CH3/CH4すべてで共有し、偶然同じ減衰形状が
    // 出ればチャンネルをまたいでも1つの@v<n>にまとめられる)。
    const envReg = new MML.Convert.EnvelopeRegistry();
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry();
    // GBの波形(4bit/32点→FDSの6bit/64点へビット拡張)を曲全体で共有登録する
    // (@FM<n>としてMML本文のヘッダに埋め込む。nsf2mml/expansion/fds.jsと同じ形式)。
    const fdsWaveReg = new MML.Convert.WaveRegistry('@FM');

    const ch1Result = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', envReg, frameRate);
    const ch2Result = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', envReg, frameRate);
    const noiseResult = MML.Gbs2MmlExpansion.noise(snapshots, envReg, frameRate);
    const waveResult = MML.Gbs2MmlExpansion.wave(snapshots, fdsWaveReg, envReg);
    const hasWave = waveResult.events.some(ev => ev.note !== null);

    // 借用変換(DESIGN.md §5): 変換元と変換先でチップ・クロックが異なる二重量子化を
    // 補正する。GBSはまずapplyPitchDetune(既定)を採用し、実測でKSSのような系統的な
    // ズレが見つかれば見直す方針(ユーザー確認済み)。
    MML.Convert.applyPitchDetune([{ events: ch1Result.events }], pulsePeriodRaw);
    MML.Convert.applyPitchDetune([{ events: ch2Result.events }], pulsePeriodRaw);
    if (hasWave) {
      MML.Convert.applyPitchDetune([{ events: waveResult.events }], MML.Gbs2MmlExpansion._fdsPeriodRaw);
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

    // 音長に加え、チャンネル毎の発音開始間隔(IOI)も検出材料にする
    // (ゲートタイムで音符が短く切られてもIOIはグリッドに乗るため頑健)。
    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      for (const ev of sounding) noteDurations.push(ev.end - ev.start);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパート(ノイズ等)で誤差が蓄積してドリフトする
    // (詳細は[[tempo-rounding-drift-future-issue]]参照、GBSノイズchで実測22フレーム/60秒の
    // ドリフトを確認して修正)。
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; GBS → MML 変換 (Game Boy: CH1/CH2パルス + CH3波形${hasWave ? '' : '(未使用)'} + CH4ノイズ)`,
      `; 曲番号   : ${songIndex}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: A=CH1(2A03パルス1) B=CH2(2A03パルス2) D=CH4(2A03ノイズ)${hasWave ? ' E=CH3(FDSとして近似再生)' : ''}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、GBのCH1/CH2/CH4はレジスタ構造が`,
      `;    近い2A03コアへそのまま、CH3(波形メモリ)は実機較正済みの音量バランスを持つFDSへ載せています。`,
      hasWave ? `;    FDS波形はGBの4bit値をビット拡張して6bitへ、音量は4段階(mute/100/50/25%)を0/15/8/4へ対応させた値です。` : `;`,
      `; =========================================================`,
      ``
    ].join('\n');

    const directiveLines = hasWave ? [MML.Mml.EX_CHIP_DIRECTIVE.fds] : [];

    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [
        ...directiveLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(hasWave ? fdsWaveReg.defLines() : [])
      ]
    });
    const mml = [headerComment, scoreText].join('\n');

    return {
      mml, bpm: Math.round(bpm),
      chips: ['CH1', 'CH2', 'CH4'].concat(hasWave ? ['CH3'] : []),
      expansions,
      fdsWave: waveResult.fdsWave
    };
  };
})(window);
