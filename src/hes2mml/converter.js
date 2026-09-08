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
    }, options.onProgress || null);
    return MML.HES2MML.convertCapture({
      snapshots: capture.snapshots,
      dpcmTrace: capture.dpcmTrace,
      controlTrace: capture.controlTrace,
      pitchTrace: capture.pitchTrace,
      frameRate: capture.frameRate,
      trackLabel: String(trackNo)
    }, options);
  };

  /**
   * キャプチャ済みデータからMMLへ変換する(fromHesの後半)。VGM(src/vgm2mml)がHuC6280由来の
   * VGMを同じ抽出・出力経路で変換するために分離した(抽出器を複製しない方針、ROADMAP.md
   * VGM節)。fromHes経由の出力は分離前と完全に同一。
   * @param {object} cap - { snapshots(hesPlayer.js snapshotApu形式のフレーム配列),
   *   dpcmTrace, controlTrace(captureHesSongAsync由来。無ければ空配列でDDA(PCM)は抽出されない),
   *   frameRate, trackLabel(コメント用), sourceLabel(コメント用、既定'HES') }
   */
  // ── チャンネル割当(案E) ────────────────────────────────────────
  // 変換元チャンネルのIDは鍵盤表示の行IDと同じ体系(PSG0-5)。音量は抽出時点で線形4bitなので
  // linear:true(借用層の音量写像が対数の借用先=FME-7/VRC7へ換算する)。
  // ノイズ(ch4/5のノイズモード)とDDA(PCM)は「chのモード」であって別チャンネルではないため、
  // 割当の対象にはせず従来どおりD/Eへ固定で出す。
  MML.HES2MML.sourceChannels = function () {
    return Array.from({ length: 6 }, (_, i) => ({
      id: `PSG${i}`, label: `PSG ch${i}`, chip: 'huc6280', kind: 'wave', ch: i,
      linear: true, nativeFamily: 'n163',
    }));
  };
  MML.HES2MML.defaultPlan = function () {
    const plan = {};
    for (let i = 0; i < 6; i++) plan[`PSG${i}`] = `n163_${i}`;
    return plan;
  };

  // 基準ピッチ(#TUNING)の自動検出: 変換本体(convertHesOnce)を必要なら2回走らせる
  // (src/convert/options.js MML.Convert.autoTune 参照。全 *2mml 共通の入口の作り)
  MML.HES2MML.convertCapture = function (cap, options) {
    return MML.Convert.autoTune(options, (o) => convertHesOnce(cap, o));
  };
  function convertHesOnce(cap, options) {
    options = options || {};
    // 変換設定(src/convert/options.js): コマンド使用/不使用・譜面整形(全レジストリ・
    // detune.js・emitScore へ同じ cmd を渡す)
    const cmd = MML.Convert.normalizeCmd(options.cmd);
    const capture = { dpcmTrace: cap.dpcmTrace || [], controlTrace: cap.controlTrace || [], pitchTrace: cap.pitchTrace || [] };
    const snapshots = cap.snapshots;
    const totalFrames = snapshots.length;
    const frameRate = cap.frameRate;
    const trackNo = cap.trackLabel;
    const sourceLabel = cap.sourceLabel || 'HES';

    const envReg = new MML.Convert.EnvelopeRegistry(cmd);
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry(cmd);
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry(cmd);
    const n163WaveReg = MML.Convert.n163WaveRegistry();

    // controlTrace($0804書込み列)はソフト音量エンベロープの位相エイリアシング対策の
    // リサンプルに使う(wave.js buildVolTimeline冒頭コメント参照)。VGM経由は空配列で
    // 従来のスナップショット列にフォールバックする。
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots, n163WaveReg, envReg, capture.controlTrace, capture.pitchTrace,
      // SA不使用設定のときだけ深い統合を止める(wave.js冒頭コメント参照)
      { maxAbsorbCents: cmd.PITCH_SA === 'off' ? 70 : null });
    const noiseResult = MML.Hes2MmlExpansion.noise(snapshots, envReg, capture.controlTrace);
    const hasNoise = noiseResult.events.some(ev => ev.note !== null);
    // options.drumHits: 合成音ch(PSG波形ch)を打楽器化した打点(main.js synthDrum)。DDAと一緒にEへ
    const dpcmResult = MML.Hes2MmlExpansion.dpcm(snapshots, capture.dpcmTrace, capture.controlTrace, frameRate, cmd,
      cmd.DRUM !== false ? (options.drumHits || null) : null);
    const hasDpcm = dpcmResult.defs.length > 0;

    // rawLength(N163波形の実サンプル数、常に32)を付与してからdetune計算に渡す
    // (applyPitchDetuneのperiodForFreqがev経由でlengthを参照するため)。
    for (const ch of waveResult.channels) {
      for (const ev of ch.events) if (ev.note !== null) ev.rawLength = 32;
    }

    // N163内蔵RAM(波形に使えるのは128-8*有効ch数バイト)に収まらない曲を収まる形へ
    // (変換設定 N163_WAVE。src/convert/n163Fit.js)。★音程補正より前に呼ぶこと:
    // N163の周波数式は波形長を含むため、縮めた後の長さで生レジスタ値を出さないとズレる。
    // ユーザー割当経路(customPlan)は借用層 borrow.compose 側で同じ処理を通す
    const n163FitNotes = options.channelMap ? []
      : MML.Convert.N163Fit.apply(waveResult.channels, n163WaveReg, cmd);

    // ユーザーがチャンネル割当(鍵盤表示、案E)を既定から変えたときは、以下の音程補正/EN/EPは
    // 借用先ファミリごとに共通借用層(src/convert/borrow.js)側で行う(借用先が変われば
    // 生周期の換算式が変わるため、ここでN163前提の補正を掛けてはいけない)。
    const customPlan = options.channelMap || null;
    if (!customPlan) {
    // 借用変換(DESIGN.md §5): PC EngineのPSGとNES N163はチップ・クロックが異なるため、
    // 二重量子化を補正するapplyPitchDetuneを使う(ネイティブ変換のdetectChorusDetuneではない)。
    for (const ch of waveResult.channels) {
      MML.Convert.applyPitchDetune([{ events: ch.events }], n163PeriodRaw, { cmd });
    }
    // ノイズは2A03固定16周期の離散選択であり連続量の微調整という概念が無いためdetune対象外。

    // 高速アルペジオ→EN統合(mergeVibratoAndArpeggioがev.noteEnvOffsetsを付与済みの
    // イベントを、曲全体で共有するnoteEnvRegへ登録してev.noteEnvを確定する)。
    // ★必ずassignPitchEnvelopeより先に呼ぶこと(2026-08-14修正、gbs2mml/converter.jsと
    // 同じ理由): assignPitchEnvelopeは内部でmarkSlurTiesを呼び、qualifiesForSlurが
    // ev.noteEnvの有無を見てタイ化を抑制するため。
    MML.Convert.assignNoteEnvelope(waveResult.channels, noteEnvReg);

    // ピッチエンベロープも同じn163PeriodRawで借用先の生レジスタ空間へ変換してから
    // 分類・登録する(DESIGN-PITCH.md Phase 1、rawLength付与後・applyPitchDetuneと同じ変換系列)。
    // saMode: 出力先がN163なのでSA<num>自動選択を有効化(pitch.js n163SaForBase参照)。
    // これによりbyte幅を超える深いビブラート等もSA付きEP/MPで表現できる。
    for (const ch of waveResult.channels) {
      MML.Convert.assignPitchEnvelope([{ events: ch.events }], n163PeriodRaw, pitchReg, { saMode: cmd.PITCH_SA });
    }
    } // ← 既定割当のときの音程補正/EN/EPここまで

    // 割当の適用。既定のときは従来どおりPSG 6ch→N163固定で出力する=出力は不変。
    // ノイズ(D)とDDA(E=DPCM)は「PSGのモード」であってch単位の借用先ではないため、
    // どちらの経路でも従来どおり別枠で追加する。
    let expansions, expansionLetterMap, scoreChannels, borrowNotes = [], chanDesc = '';
    if (customPlan) {
      const r = MML.Convert.Borrow.compose({
        sources: MML.HES2MML.sourceChannels(),
        plan: Object.assign({}, MML.HES2MML.defaultPlan(), customPlan),
        cmd,
        // HESも借用変換(二重量子化の補正)なのでapplyPitchDetune方針を保つ(従来経路と同じ)
        detuneMode: 'apply',
        regs: {
          envReg, pitchReg, noteEnvReg, n163WaveReg,
          vrc7ToneReg: new MML.Convert.WaveRegistry('@OP'),
        },
        toneOf: (id) => (options.tone || {})[id],
        // PSGの抽出は借用先ファミリに依らず1回でよい(既に上で済ませてある)。ただし音量尺度が
        // 違うファミリ(FME-7/VRC7)へ載せる分は @v テーブルを写像した registry で取り直す
        extract: (chip, fam, reg) => (reg === envReg ? waveResult.channels
          : MML.Hes2MmlExpansion.wave(snapshots, MML.Convert.n163WaveRegistry(), reg,
              capture.controlTrace, capture.pitchTrace,
              { maxAbsorbCents: cmd.PITCH_SA === 'off' ? 70 : null }).channels),
      });
      expansions = r.expansions.slice();
      if (hasDpcm && expansions.indexOf('dpcm') < 0) expansions.unshift('dpcm');
      expansionLetterMap = MML.Mml.assignExpansionLetters(expansions);
      scoreChannels = r.scoreChannels;
      borrowNotes = r.notes;
      chanDesc = Object.keys(r.placed)
        .map(t => `${MML.Convert.ChannelPlan.letterOfTarget(t)}=${r.placed[t].source.label}`).sort().join(' ');
      if (hasNoise) scoreChannels.push(Object.assign({}, noiseResult, { letter: 'D' }));
      if (hasDpcm) scoreChannels.push({ letter: expansionLetterMap.dpcm[0], events: dpcmResult.events, hasInstrument: true });
      MML.Convert.sortChannelsByLetter(scoreChannels);
    } else {
    expansions = ['n163'];
    // dpcmは実機ppmck同様レター体系上は常にEを固定占有する(使わなくても他チップの
    // レター位置には影響しない。src/mml/compiler.js assignExpansionLetters参照)。
    expansionLetterMap = MML.Mml.assignExpansionLetters(hasDpcm ? ['dpcm', 'n163'] : expansions);
    const n163Letters = expansionLetterMap.n163;
    const dpcmLetter = hasDpcm ? expansionLetterMap.dpcm[0] : null;

    scoreChannels = waveResult.channels.map((ch, i) =>
      Object.assign({}, ch, { letter: n163Letters[i], hasDetune: true, hasPitchMod: true }));
    if (hasNoise) scoreChannels.push(Object.assign({}, noiseResult, { letter: 'D' }));
    if (hasDpcm) scoreChannels.push({ letter: dpcmLetter, events: dpcmResult.events, hasInstrument: true });
    }

    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      noteDurations.push(...MML.Convert.tempoMaterial(sounding.map(ev => ev.start), sounding.map(ev => ev.end - ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; ${sourceLabel} → MML 変換 (PC Engine/TurboGrafx-16: PSG 6ch)`,
      `; トラック番号 : ${trackNo}${isFinite(+trackNo) ? ` (0x${(+trackNo & 0xFF).toString(16).toUpperCase()})` : ''}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      customPlan
        ? `; チャンネル: ${chanDesc || '-'}${hasDpcm ? ` ${expansionLetterMap.dpcm[0]}=PSG DDA(PCM)` : ''}${hasNoise ? ' D=PSGノイズ' : ''} (借用先の割当: ユーザー指定)`
        : `; チャンネル: ${hasDpcm ? expansionLetterMap.dpcm[0] + '=PSG DDA(PCM、2A03 DMCとして近似再生) ' : ''}${(expansionLetterMap.n163 || []).slice(0, N163_NUM_CH).join('')}=PSG ch0-5(N163として近似再生)${hasNoise ? ' D=PSGノイズ(ch4/5、2A03ノイズとして近似再生)' : ''}`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、PSGの6ch(いずれも32サンプル5bit`,
      `;    波形音源)はレジスタ構造が近いN163へ、ノイズモードは2A03ノイズへ、DDA(PCM)は`,
      `;    2A03 DMCへ載せています。DPCMサンプルは抽出済み.dmcファイルとして自動でダウンロード`,
      `;    ・読込済みになるため、変換直後の再生・NSF書き出しでそのまま鳴らせます`,
      `;    (借用先の割当は鍵盤表示のpart列/「借用先」列で変更できます)。`,
      ...borrowNotes.map(n => `; ※ ${n}`),
      ...n163FitNotes.map(n => `; ※ ${n}`),
      ...MML.Convert.tuningCommentLines(),
      `; =========================================================`,
      ``
    ].join('\n');

    const dpcmDefLines = dpcmResult.defs.map(d =>
      `@DPCM${d.index} = { "${d.file}", ${d.freq}, ${d.size}, ${d.dac}, ${d.mode} }`);
    // #EX-*: 既定は常にN163(6ch宣言)。ユーザー指定のときは実際に使った拡張音源だけ宣言する
    const directiveLines = customPlan
      ? expansions.filter(chip => chip !== 'dpcm').map(chip => chip === 'n163'
        ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${(expansionLetterMap.n163 || []).length}`
        : MML.Mml.EX_CHIP_DIRECTIVE[chip])
      : [`${MML.Mml.EX_CHIP_DIRECTIVE.n163} ${N163_NUM_CH}`];

    // 音符の区切り(NOTE_END、src/convert/envelope.js)。@v表を書き換えるので defLines() より前
    MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb, frameRate);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, cmd,
      headerLines: [...MML.Convert.tuningHeaderLines(), ...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(!customPlan || expansions.indexOf('n163') >= 0 ? n163WaveReg.defLines() : [])]
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

    // 変換結果の音程検証(src/convert/verify.js): 最終MMLを実コンパイルして
    // 「実際に鳴る音の高さ」を変換元イベントと突き合わせる(失敗しても変換は妨げない)
    const pitchCheck = MML.Convert.verifyPitch
      ? MML.Convert.verifyPitch(mml, scoreChannels, { frameRate, totalFrames })
      : null;

    return {
      mml, bpm: Math.round(bpm), pitchCheck, scoreChannels,
      chips: ['PSG0', 'PSG1', 'PSG2', 'PSG3', 'PSG4', 'PSG5'].concat(hasNoise ? ['NOISE'] : []).concat(hasDpcm ? ['DDA'] : []),
      expansions,
      n163Wave: uiWave,
      dpcmFiles: dpcmResult.files
    };
  };
})(window);
