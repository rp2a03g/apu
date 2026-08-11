/*
 * HES → MML コンバータ (PC Engine/TurboGrafx-16: PSG 6ch)
 * MML.HES2MML.fromHes(hesBytes, track, durationSeconds)
 *   → Promise<{ mml: string, bpm: number, chips: string[], expansions: string[], n163Wave: number[],
 *               dpcmFiles: [{name, bytes}] }>
 *
 * このアプリのMMLコンパイラ/プレイヤーはNES(6502+2A03+NES拡張音源)専用であり、PC Engineを
 * ネイティブに再生する経路を持たない。DESIGN.md §5の「借用チップ」規約に従い、PSGの
 * 6ch全て(構造が同一の32サンプル5bit波形音源)をN163(最大8ch可変長波形)へ、
 * ch4/5のノイズモードは2A03ノイズ(D)へ借用する(詳細はexpansion/wave.js・noise.js参照)。
 * PSGのDDA(直接D/A、PCM/音声サンプル再生)モードは2A03 DMC(@DPCM<n>、実機ppmck準拠で
 * 常にEチャンネル1本)へ変換する(詳細はexpansion/dpcm.js参照)。
 *
 * 出力チャンネル: E(DPCM、DDA使用時のみ) + P-U(N163、PSG ch0-5) + D(2A03ノイズ、ノイズ使用時のみ)。
 * A/B/C(2A03パルス/三角波)は使用しない(PSGに対応するチップが無いため空のまま)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.HES2MML = {};

  const CPU_CLOCK_NTSC = 1789773; // 借用先(N163)のクロック。src/mml/compiler.jsと同じ値
  const N163_NUM_CH = 6;          // 借用に使うNSF側N163の実効チャンネル数(固定)

  // N163周波数式の逆関数(nsf2mml/expansion/n163.jsと同じ式): freq = CPU*freqReg/(15*65536*length*numCh)
  // detune計算は差を取ってから1回だけ丸めるため、呼び出し側で先に丸めてはいけない
  // (src/convert/detune.js冒頭コメント)。
  function n163PeriodRaw(freqHz, ev) {
    const length = (ev && ev.rawLength) || 32;
    return (freqHz * 15 * 65536 * length * N163_NUM_CH) / CPU_CLOCK_NTSC;
  }

  MML.HES2MML.fromHes = async function (hesBytes, track, durationSeconds, options) {
    options = options || {};
    const header = MML.HES.parseHeader(hesBytes);
    const trackNo = track != null ? track : header.firstTrack;
    // regsOnly: hes2mmlはsnapshots/dpcmTraceしか使わずcapture.audioを一切参照しないため、
    // 音声合成(apu.mixSample())をスキップして高速化する(captureHesSongAsync冒頭コメント参照)。
    const capture = await MML.Emu.captureHesSongAsync(hesBytes, {
      track: trackNo,
      durationSeconds: durationSeconds || 60,
      sampleRate: 44100,
      regsOnly: true
    });
    const snapshots = capture.snapshots;
    const totalFrames = snapshots.length;
    const frameRate = capture.frameRate;

    const envReg = new MML.Convert.EnvelopeRegistry();
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();
    const n163WaveReg = new MML.Convert.WaveRegistry('@N', v => [0, ...v]);

    const waveResult = MML.Hes2MmlExpansion.wave(snapshots, n163WaveReg, envReg);
    const noiseResult = MML.Hes2MmlExpansion.noise(snapshots, envReg);
    const hasNoise = noiseResult.events.some(ev => ev.note !== null);
    const dpcmResult = MML.Hes2MmlExpansion.dpcm(snapshots, capture.dpcmTrace, capture.controlTrace, frameRate);
    const hasDpcm = dpcmResult.defs.length > 0;

    // rawLength(N163波形の実サンプル数、常に32)を付与してからdetune計算に渡す
    // (applyPitchDetuneのperiodForFreqがev経由でlengthを参照するため)。
    for (const ch of waveResult.channels) {
      for (const ev of ch.events) if (ev.note !== null) ev.rawLength = 32;
    }

    // 借用変換(DESIGN.md §5): PC EngineのPSGとNES N163はチップ・クロックが異なるため、
    // 二重量子化を補正するapplyPitchDetuneを使う(ネイティブ変換のdetectChorusDetuneではない)。
    for (const ch of waveResult.channels) {
      MML.Convert.applyPitchDetune([{ events: ch.events }], n163PeriodRaw);
    }
    // ノイズは2A03固定16周期の離散選択であり連続量の微調整という概念が無いためdetune対象外。

    // ピッチエンベロープも同じn163PeriodRawで借用先の生レジスタ空間へ変換してから
    // 分類・登録する(DESIGN-PITCH.md Phase 1、rawLength付与後・applyPitchDetuneと同じ変換系列)。
    for (const ch of waveResult.channels) {
      MML.Convert.assignPitchEnvelope([{ events: ch.events }], n163PeriodRaw, pitchReg);
    }

    const expansions = ['n163'];
    // dpcmは実機ppmck同様レター体系上は常にEを固定占有する(使わなくても他チップの
    // レター位置には影響しない。src/mml/compiler.js assignExpansionLetters参照)。
    const expansionLetterMap = MML.Mml.assignExpansionLetters(hasDpcm ? ['dpcm', 'n163'] : expansions);
    const n163Letters = expansionLetterMap.n163;
    const dpcmLetter = hasDpcm ? expansionLetterMap.dpcm[0] : null;

    const scoreChannels = waveResult.channels.map((ch, i) =>
      Object.assign({}, ch, { letter: n163Letters[i], hasDetune: true, hasPitchMod: true }));
    if (hasNoise) scoreChannels.push(Object.assign({}, noiseResult, { letter: 'D' }));
    if (hasDpcm) scoreChannels.push({ letter: dpcmLetter, events: dpcmResult.events, hasInstrument: true });

    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      for (const ev of sounding) noteDurations.push(ev.end - ev.start);
      noteDurations.push(...MML.Convert.onsetIntervals(sounding.map(ev => ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; HES → MML 変換 (PC Engine/TurboGrafx-16: PSG 6ch)`,
      `; トラック番号 : ${trackNo} (0x${(trackNo & 0xFF).toString(16).toUpperCase()})`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: ${dpcmLetter ? dpcmLetter + '=PSG DDA(PCM、2A03 DMCとして近似再生) ' : ''}${n163Letters.slice(0, N163_NUM_CH).join('')}=PSG ch0-5(N163として近似再生)${hasNoise ? ' D=PSGノイズ(ch4/5、2A03ノイズとして近似再生)' : ''}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、PSGの6ch(いずれも32サンプル5bit`,
      `;    波形音源)はレジスタ構造が近いN163へ、ノイズモードは2A03ノイズへ、DDA(PCM)は`,
      `;    2A03 DMCへ載せています。DPCMサンプルは抽出済み.dmcファイルとして自動でダウンロード`,
      `;    ・読込済みになるため、変換直後の再生・NSF書き出しでそのまま鳴らせます。`,
      `; =========================================================`,
      ``
    ].join('\n');

    const dpcmDefLines = dpcmResult.defs.map(d =>
      `@DPCM${d.index} = { "${d.file}", ${d.freq}, ${d.size}, ${d.dac}, ${d.mode} }`);
    const directiveLines = [`${MML.Mml.EX_CHIP_DIRECTIVE.n163} ${N163_NUM_CH}`];

    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...pitchReg.defLines(), ...n163WaveReg.defLines()]
    });
    const mml = [headerComment, scoreText].join('\n');

    // 波形エディタUI(MML.WaveformEditor.n163Wave)は固定16サンプル枠のため、実波形(32サンプル)
    // はそのまま切り詰めず概形を保ってリサンプルする(nsf2mml/expansion/n163.jsの
    // resampleWaveForUiDefaultと同じ理由。実際の音色データ(@N<n>定義)は32サンプルのまま)。
    const UI_WAVE_LEN = 16;
    const uiWave = new Array(UI_WAVE_LEN);
    for (let i = 0; i < UI_WAVE_LEN; i++) {
      const srcPos = Math.floor((i / UI_WAVE_LEN) * waveResult.n163Wave.length) % waveResult.n163Wave.length;
      uiWave[i] = waveResult.n163Wave[srcPos] || 0;
    }

    return {
      mml, bpm: Math.round(bpm),
      chips: ['PSG0', 'PSG1', 'PSG2', 'PSG3', 'PSG4', 'PSG5'].concat(hasNoise ? ['NOISE'] : []).concat(hasDpcm ? ['DDA'] : []),
      expansions,
      n163Wave: uiWave,
      dpcmFiles: dpcmResult.files
    };
  };
})(window);
