/*
 * KSS → MML コンバータ (PSG + SCC + FMPAC)
 * MML.KSS2MML.fromKss(kssBytes, songIndex, durationSeconds)
 *   → Promise<{ mml: string, bpm: number, chips: string[], expansions: string[], n163Wave: number[] }>
 *
 * このアプリのMMLコンパイラ/プレイヤーはNES(6502+2A03+NES拡張音源)専用であり、
 * MSXのPSG/SCC/FMPACをネイティブに再生する経路を持たない。しかし偶然にも
 * NES拡張音源のうち FME-7 は AY-3-8910/YM2149 とレジスタ・DSP的に実質同一、
 * VRC7 は OPLL(YM2413) そのものであるため、PSGはFME-7として、FMPACはVRC7として
 * 実際に正しく再生できる。SCCに直接対応するNES拡張音源は無いため、構造が近い
 * N163(波形音源)へ波形/ノートを載せて近似する(音色は完全一致しない)。
 * これにより「MML変換して即このアプリで再生できる」体験を保つ。
 *
 * 出力チャンネル: fme7(3ch, 元PSG) / n163(8ch, 元SCC 5ch+空きch3) / vrc7(6ch, 元FMPAC、搭載時のみ)
 * レターは src/mml/compiler.js の assignExpansionLetters をそのまま使う。実機ppmck準拠で
 * 各チップの文字範囲は他の拡張音源の有無に関わらず完全固定(X-Z=fme7, P-W=n163, G-L=vrc7)
 * であり、E-Gから詰めて再割当てはしない(https://wikiwiki.jp/mck/チャンネル別MML一覧 参照)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.KSS2MML = {};

  const CPU_CLOCK_NTSC = 1789773; // NES CPUクロック(src/mml/compiler.jsと同じ値)

  // FME-7: freq = CLOCK / (32 * period)。src/mml/compiler.jsのfme7Period()と同じ式だが、
  // ここでは丸めない(生の連続値)。detectChorusDetune(src/convert/detune.js)は「理論値の
  // 周期」と「実測値の周期」の差をD<n>として使うため、この2つを個別に整数へ丸めてから
  // 引き算すると、両方が同じ整数へ丸め込まれて差が消えてしまうことがある(Ys1 12曲目の
  // F5で実測: 高い音域ほど1周期あたりのHz幅が広がり、四捨五入で相殺されて本来必要な
  // 補正がD0に消えてしまっていた)。丸めるのは差を求めた後の1回だけにする(detune.js側で行う)。
  function fme7PeriodRaw(freq) {
    return CPU_CLOCK_NTSC / (32 * freq);
  }

  // N163: freqReg = freq * 15 * 65536 * waveLen * numCh / CLOCK (src/mml/compiler.jsの
  // n163FreqReg()と同じ式、丸めない生の連続値)。period系(FME-7等)と違いfreqRegは
  // 周波数に「比例」する(位相加算方式のため)が、detectChorusDetuneの計算自体は
  // 「理論値と理論値+差分、それぞれのレジスタ値の差」という一般形なので比例/反比例を
  // 問わずそのまま使える。
  // ★2026-08-02修正: numChは固定8ではなくcompiler.js側の実際の自動検出値(音符を持つ
  // 最上位レターの位置+1、下のcomputeActualN163ChannelCount参照)を渡すこと。以前は
  // ここだけ8固定にしていたが、#EX-NAMCO106の後ろの数値はcompiler.js側では一切パースされず
  // (単なる目印コメント、lexer.jsはディレクティブ名しか見ない)、実際に使われるnumN163Chは
  // 常にsegmentsByChannelから自動検出した値(このゲームでは5)になる。freqRegはnumChに
  // 比例するため、ここで8を使うとD<n>が実際に必要な量の8/5=1.6倍(例: 13.5セント→21.6セント)
  // で書き込まれ、原曲の音程ズレそのものより大きく音痴になるバグだった(Gofer no Yabou II
  // index4で実測)。
  function n163FreqRegRaw(waveLen, numCh) {
    return freq => freq * 15 * 65536 * waveLen * numCh / CPU_CLOCK_NTSC;
  }

  // compiler.js(1497行目付近)と全く同じロジック: n163Letters(P-W、常に8個)を先頭から見て
  // 音符を持つ最上位レターの位置+1。kss2mmlはletters[i]==sccResult.channels[i]で1:1対応させて
  // おり、SCCが5ch固定なのでindex5-7は常に空(rest)。ここで検出した値がそのままcompiler.js側の
  // 自動検出結果と一致する(でなければ上記のD<n>スケール不一致バグが再発する)。
  function computeActualN163ChannelCount(channels) {
    let n = 0;
    channels.forEach((ch, i) => { if (ch.events.some(ev => ev.note !== null)) n = i + 1; });
    return Math.max(1, n);
  }

  // VRC7: freq = fnum * 2^block * 49716 / 2^19 (src/mml/compiler.jsのvrc7FreqToFnumBlock()
  // と同じ式・同じblock選択、丸めない生の連続値)。fnumは同一block内では周波数に比例する
  // ため、block自体は変えずfnumだけの差としてD<n>を計算できる(compiler.js側もblockは
  // 動かさずfnumだけにapplyDetuneするよう対応済み)。デチューン量はごく小さい(数Hz程度)
  // ため、理論値とズラした値でblockの選択が食い違うことは通常無い。
  function vrc7FnumRaw(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = (freq * 524288) / (49716 * Math.pow(2, block));
      if (fnum <= 511) return fnum;
    }
    return 511;
  }

  MML.KSS2MML.fromKss = async function (kssBytes, songIndex, durationSeconds, options) {
    options = options || {};
    const header = MML.KSS.parseHeader(kssBytes);
    const capture = await MML.Emu.captureKssSongAsync(kssBytes, {
      songIndex: songIndex || 0,
      durationSeconds: durationSeconds || 60,
      sampleRate: 44100
    });
    const writeLog = capture.writeLog;
    const totalFrames = writeLog.length;
    const clock = MML.KSS.Z80_CLOCK;
    const frameRate = capture.frameRate;
    const hasOpll = header.device.mode === 'MSX' && header.device.fmpac;

    // 音量変化をソフトウェアエンベロープとして曲全体で共有登録するレジストリ
    // (nsf2mml/converter.jsと同じ考え方。PSG/SCC両方の抽出で共有し、偶然同じ減衰形状が
    // 出ればチップをまたいでも1つの@v<n>にまとめられる)。
    const envReg = new MML.Convert.EnvelopeRegistry();
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    // 借用先(PSG→FME7、SCC→N163)チップのEP対応範囲と一致させる(DESIGN-PITCH.md §7)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry();

    // SCCの自作波形もN163形式へ変換した上で曲全体で共有登録する(@N<n>としてMML本文の
    // ヘッダに埋め込む)。曲中に音色が切り替わる曲でも全て登録され、@<n>で選択される。
    const n163WaveReg = new MML.Convert.WaveRegistry('@N', v => [0, ...v]);

    // SCCはヘッダフラグに現れないため(kssBus.jsが常時バスに配線している都合)、
    // ヘッダだけでは搭載有無を判定できない。実際にSCCレジスタへ音符として意味のある
    // 書込み(有効な音程)があったかをwriteLogから検出し、無ければn163を出力に含めない
    // (PSGのみの曲でP-W(SCC近似)の空チャンネルが常に付与されてしまう問題への対処)。
    const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock, n163WaveReg, envReg);
    const hasScc = sccResult.channels.some(ch => ch.events.some(ev => ev.note !== null));

    const expansions = ['fme7'].concat(hasScc ? ['n163'] : []).concat(hasOpll ? ['vrc7'] : []);
    const expansionLetterMap = MML.Mml.assignExpansionLetters(expansions);

    const scoreChannels = [];

    // PSG(3ch) → fme7 (AY-3-8910互換なのでそのまま正しく再生できる)
    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock, envReg);
    // 音程補正: 複数chが同じ音程を同時に鳴らしている(コーラス)場合だけ実測周波数の
    // 差をD<n>で明示する(detectChorusDetune、src/convert/detune.js)。単独音は理論値
    // (12平均律)にそのまま丸める。★2026-08-02: 以前はapplyPitchDetune(単独音も含め常に
    // 実測値ベースで補正)を使っていたが、KSSのドライバのノートテーブル自体がA440/12平均律
    // から系統的に数十セントずれている曲があり(Gofer no Yabou II実測)、単独音まで
    // 大きくズラしてしまい聞くに堪えなかった。ユーザー確認の上detectChorusDetune方式を
    // 正式採用。
    MML.Convert.detectChorusDetune(ayResult.channels, fme7PeriodRaw);
    // ピッチエンベロープ(厳密周期ビブラート)も同じfme7PeriodRawで借用先の生レジスタ
    // 空間へ変換してから分類・登録する(DESIGN-PITCH.md Phase 1、D<n>の直後に置くのは
    // 両方とも同じ「借用先レジスタ空間への変換」処理系列だから)。
    MML.Convert.assignPitchEnvelope(ayResult.channels, fme7PeriodRaw, pitchReg);
    const fme7Letters = expansionLetterMap.fme7;
    ayResult.channels.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: fme7Letters[i], hasDetune: true, hasPitchMod: true })));

    // SCC(5ch) → n163(8ch分の枠のうち実際に使うのは音符を持つ最上位chまで) 波形近似
    // (実際に使われている場合のみ)
    if (hasScc) {
      // PSGと同じ理由でN163側も音程補正する(N163の周波数レジスタ式を使用)。numChは
      // compiler.js側の自動検出値と一致させる(上のn163FreqRegRawのコメント参照)。
      const n163ActualNumCh = computeActualN163ChannelCount(sccResult.channels);
      MML.Convert.detectChorusDetune(
        sccResult.channels, n163FreqRegRaw(MML.Kss2MmlExpansion.SCC_WAVE_LEN, n163ActualNumCh));
      MML.Convert.assignPitchEnvelope(
        sccResult.channels, n163FreqRegRaw(MML.Kss2MmlExpansion.SCC_WAVE_LEN, n163ActualNumCh), pitchReg);
      const n163Letters = expansionLetterMap.n163;
      for (let i = 0; i < n163Letters.length; i++) {
        const ch = sccResult.channels[i] || { events: [], hasVolume: true, hasInstrument: true };
        scoreChannels.push(Object.assign({}, ch, { letter: n163Letters[i], hasDetune: true, hasPitchMod: true }));
      }
    }

    // FMPAC(6ch) → vrc7 (OPLL=YM2413そのものなのでそのまま正しく再生できる)
    // VRC7カスタム音色(ユーザー定義音色、レジスタ0x00-0x07)。全ch共有の1系統のみで、
    // @OP<n>定義+曲中の切替はOP<n>即時コマンド(mmlEmit.jsのhasVrc7Tone)で表現する
    // (nsf2mml/converter.jsと同じ考え方)。これが無いと@0(カスタム音色)を使う曲は
    // ノート自体は正しく検出されても波形が読み込まれず無音になっていた。
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');
    if (hasOpll) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames, vrc7ToneReg);
      // PSG/SCCと同じ理由でVRC7側も音程補正する(VRC7のfnum式を使用)。
      MML.Convert.detectChorusDetune(opllResult.channels, vrc7FnumRaw);
      const vrc7Letters = expansionLetterMap.vrc7;
      opllResult.channels.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: vrc7Letters[i], hasDetune: true })));
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
    // 基準テンポが食い違い、打ち直しの多いパートで誤差が蓄積してドリフトする
    // ([[tempo-rounding-drift-future-issue]]参照)。
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; KSS → MML 変換 (MSX: PSG${hasScc ? ' + SCC' : ''}${hasOpll ? ' + FMPAC' : ''})`,
      `; 曲番号   : ${songIndex}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      `; チャンネル: A-D=未使用(2A03) X-Z=PSG(FME-7として再生)${hasScc ? ' P-W=SCC(N163として近似再生)' : ''}`,
      hasOpll ? `;             G-L=FMPAC(VRC7として再生)` : `;`,
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、MSX音源はレジスタ互換/構造が`,
      `;    近いNES拡張音源(PSG→FME-7, FMPAC→VRC7, SCC→N163)を借りて再生します。`,
      hasScc ? `;    SCCの波形はN163形式(4bit,32点)に変換した近似のため音色は完全一致しません。` : `;`,
      `; =========================================================`,
      ``
    ].join('\n');

    // #EX-*(機能する本文ディレクティブ。上の`; `コメントとは別。これがないと
    // MML本文だけからは拡張音源が有効にならず、UI側の操作が必要になってしまう)
    const directiveLines = expansions.map(chip => chip === 'n163'
      ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${expansionLetterMap.n163.length}`
      : MML.Mml.EX_CHIP_DIRECTIVE[chip]);

    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm,
      headerLines: [
        ...directiveLines, ...envReg.defLines(), ...pitchReg.defLines(),
        ...(hasScc ? n163WaveReg.defLines() : []),
        ...(hasOpll ? vrc7ToneReg.defLines() : [])
      ]
    });
    const mml = [headerComment, scoreText].join('\n');

    return {
      mml, bpm: Math.round(bpm),
      chips: ['PSG'].concat(hasScc ? ['SCC'] : []).concat(hasOpll ? ['FMPAC'] : []),
      expansions,
      n163Wave: sccResult.n163Wave
    };
  };
})(window);
