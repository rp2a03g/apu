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
  // 周期」と「実測値の周期」から D<n> を求めるため、ここでは丸めない。丸めは detune.js 側で
  // 「D = round(実測) − round(理論値)」として行う(再生側がテーブルの整数値+D を鳴らす以上、
  // 両方が同じ整数へ丸まるなら D0 が正しい=テーブル値が既に実測へ一番近い格子点。
  // ★2026-09-07 まで round(実測−理論値) としていたため、テーブル側の丸めと逆向きに出ると
  // 1格子ずれていた。detune.js の履歴コメント参照)。
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

  // VRC7: fnum換算は src/convert/borrow.js に集約(block は音符の理論値側で固定。境界をまたぐ
  // 実測値で D が上限に張り付く件の修正、2026-09-07)
  function vrc7FnumRaw(freq, ev) { return MML.Convert.Borrow.vrc7FnumRaw(freq, ev); }

  MML.KSS2MML.fromKss = async function (kssBytes, songIndex, durationSeconds, options) {
    options = options || {};
    const header = MML.KSS.parseHeader(kssBytes);
    const capture = await MML.Emu.captureKssSongAsync(kssBytes, {
      songIndex: songIndex || 0,
      durationSeconds: durationSeconds || 60,
      sampleRate: 44100
    }, options.onProgress || null);
    return MML.KSS2MML.convertCapture({
      writeLog: capture.writeLog,
      frameRate: capture.frameRate,
      clock: MML.KSS.Z80_CLOCK,
      hasOpll: header.device.mode === 'MSX' && header.device.fmpac,
      hasOpl: header.device.mode === 'MSX' && header.device.msxAudio,
      songLabel: String(songIndex)
    }, options);
  };

  /**
   * キャプチャ済みデータからMMLへ変換する(fromKssの後半)。VGM(src/vgm2mml)がAY8910/SCC/
   * YM2413由来のVGMを同じ抽出・出力経路で変換するために分離した(抽出器を複製しない方針、
   * ROADMAP.md VGM節)。fromKss経由の出力は分離前と完全に同一。
   * @param {object} cap - {
   *   writeLog: フレーム毎の{addr,value,io}配列(PSG=io 0xA0/0xA1, OPLL=io 0x7C/0x7D,
   *             SCC=mem 0x9800/0xB800台。kss2mml/expansion/*.jsが読む形),
   *   frameRate, clock(Z80クロック基準3579545。AY/SCCの実チップクロックの2倍),
   *   hasOpll, songLabel(コメント用), sourceLabel(コメント用、既定'KSS') }
   */
  // ── チャンネル割当(案E) ────────────────────────────────────────
  // 変換元チャンネルのIDは鍵盤表示の行IDと同じ体系にする(KP1-3=PSG, KS1-5=SCC, KF1-9=FMPAC)。
  // こうすると鍵盤の割当UIが選んだ値をそのまま options.channelMap として渡せる。
  // chip名は vgm2mml/converter.js の sourceChannels と同じ語彙(共通の借用層が使う)。
  MML.KSS2MML.sourceChannels = function (caps) {
    caps = caps || {};
    const out = [];
    for (let i = 0; i < 3; i++) out.push({ id: `KP${i + 1}`, label: `PSG ch${i + 1}`, chip: 'ay8910', kind: 'square', ch: i, nativeFamily: 'fme7' });
    if (caps.hasScc) for (let i = 0; i < 5; i++) out.push({ id: `KS${i + 1}`, label: `SCC ch${i + 1}`, chip: 'k051649', kind: 'wave', ch: i, nativeFamily: 'n163' });
    if (caps.hasOpll) for (let i = 0; i < 9; i++) out.push({ id: `KF${i + 1}`, label: `FMPAC ch${i + 1}`, chip: 'ym2413', kind: 'fm', ch: i, nativeFamily: 'vrc7' });
    // MSX-AUDIO(Y8950): 2op FM×9ch。音色はOPLLカスタム音色へ直接変換(kss2mml/expansion/opl.js)
    if (caps.hasOpl) for (let i = 0; i < 9; i++) out.push({ id: `OL${i + 1}`, label: `MSX-AUDIO ch${i + 1}`, chip: 'opl', kind: 'fm', ch: i, nativeFamily: 'vrc7' });
    return out;
  };
  // 既定の割当(従来の固定割当と同じ: PSG→FME-7、SCC→N163、FMPAC→VRC7の先頭6ch)
  MML.KSS2MML.defaultPlan = function (caps) {
    const plan = {};
    ['fme7a', 'fme7b', 'fme7c'].forEach((t, i) => { plan[`KP${i + 1}`] = t; });
    for (const s of MML.KSS2MML.sourceChannels(caps)) {
      if (/^KS/.test(s.id)) plan[s.id] = `n163_${s.ch}`;
      else if (/^KF/.test(s.id)) plan[s.id] = s.ch < 6 ? `vrc7_${s.ch}` : 'skip';
      // MSX-AUDIOはFMPAC非搭載時のみVRC7へ(両搭載時はVRC7 6枠をFMPACが取る)
      else if (/^OL/.test(s.id)) plan[s.id] = (!caps.hasOpll && s.ch < 6) ? `vrc7_${s.ch}` : 'skip';
    }
    return plan;
  };

  // 基準ピッチ(#TUNING)の自動検出: 変換本体(convertKssOnce)を必要なら2回走らせる
  // (src/convert/options.js MML.Convert.autoTune 参照。全 *2mml 共通の入口の作り)
  MML.KSS2MML.convertCapture = function (cap, options) {
    return MML.Convert.autoTune(options, (o) => convertKssOnce(cap, o));
  };
  function convertKssOnce(cap, options) {
    options = options || {};
    // 変換設定(src/convert/options.js): コマンド使用/不使用・譜面整形(全レジストリ・
    // detune.js・emitScore へ同じ cmd を渡す)
    const cmd = MML.Convert.normalizeCmd(options.cmd);
    const writeLog = cap.writeLog;
    const totalFrames = writeLog.length;
    const clock = cap.clock || MML.KSS.Z80_CLOCK;
    const frameRate = cap.frameRate;
    const hasOpll = !!cap.hasOpll;
    const hasOpl = !!cap.hasOpl;
    const songIndex = cap.songLabel;
    const sourceLabel = cap.sourceLabel || 'KSS';

    // 音量変化をソフトウェアエンベロープとして曲全体で共有登録するレジストリ
    // (nsf2mml/converter.jsと同じ考え方。PSG/SCC両方の抽出で共有し、偶然同じ減衰形状が
    // 出ればチップをまたいでも1つの@v<n>にまとめられる)。
    const envReg = new MML.Convert.EnvelopeRegistry(cmd);
    // ピッチエンベロープ(厳密周期ビブラート)の共有レジストリ(DESIGN-PITCH.md Phase 1)。
    // 借用先(PSG→FME7、SCC→N163)チップのEP対応範囲と一致させる(DESIGN-PITCH.md §7)。
    const pitchReg = new MML.Convert.PitchEnvelopeRegistry(cmd);
    // ノートエンベロープ(高速アルペジオ)の共有レジストリ(2026-08-14)。
    const noteEnvReg = new MML.Convert.NoteEnvelopeRegistry(cmd);

    // SCCの自作波形もN163形式へ変換した上で曲全体で共有登録する(@N<n>としてMML本文の
    // ヘッダに埋め込む)。曲中に音色が切り替わる曲でも全て登録され、@<n>で選択される。
    const n163WaveReg = MML.Convert.n163WaveRegistry();

    // SCCはヘッダフラグに現れないため(kssBus.jsが常時バスに配線している都合)、
    // ヘッダだけでは搭載有無を判定できない。実際にSCCレジスタへ音符として意味のある
    // 書込み(有効な音程)があったかをwriteLogから検出し、無ければn163を出力に含めない
    // (PSGのみの曲でP-W(SCC近似)の空チャンネルが常に付与されてしまう問題への対処)。
    // VRC7カスタム音色(ユーザー定義音色、レジスタ0x00-0x07)。全ch共有の1系統のみで、
    // @OP<n>定義+曲中の切替はOP<n>即時コマンド(mmlEmit.jsのhasVrc7Tone)で表現する
    // (nsf2mml/converter.jsと同じ考え方)。これが無いと@0(カスタム音色)を使う曲は
    // ノート自体は正しく検出されても波形が読み込まれず無音になっていた。
    const vrc7ToneReg = new MML.Convert.WaveRegistry('@OP');

    // ユーザーがチャンネル割当(鍵盤表示、案E)を既定から変えたときだけ通る共通借用層
    // (src/convert/borrow.js)。既定のときは以下の従来コードをそのまま使う=出力は不変。
    const customPlan = options.channelMap || null;
    // SCC搭載判定用の抽出。ユーザー指定があるときは共有レジストリを汚さないよう使い捨ての
    // レジストリで判定だけ行う(本抽出は借用先ファミリごとにcompose()が走らせ直すため、
    // ここで登録した@v/@Nが誰にも使われない定義として本文に残ってしまう)
    const sccProbeEnv = customPlan ? new MML.Convert.EnvelopeRegistry(cmd) : envReg;
    const sccProbeWave = customPlan ? MML.Convert.n163WaveRegistry() : n163WaveReg;
    const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock, sccProbeWave, sccProbeEnv);
    const hasScc = sccResult.channels.some(ch => ch.events.some(ev => ev.note !== null));

    let expansions, expansionLetterMap, scoreChannels, borrowNotes = [], chanDesc = '';
    // E(DPCM)へ載せたch(打楽器化、ユーザー指定経路のみ): 分離レンダリングした打点
    // (options.drumHits、main.js synthDrum)を共通コア(src/convert/drumHits.js)で @DPCM 化する
    const dpcmDefLines = [], dpcmFiles = [];
    let drumNote = null;
    let preferOplForNote = false; // 既定経路で「FMPAC無音→MSX-AUDIOがVRC7枠を使用」になったか(ヘッダコメント用)
    if (customPlan) {
      const caps = { hasScc, hasOpll, hasOpl };
      const r = MML.Convert.Borrow.compose({
        sources: MML.KSS2MML.sourceChannels(caps),
        plan: Object.assign({}, MML.KSS2MML.defaultPlan(caps), customPlan),
        cmd,
        regs: { envReg, pitchReg, noteEnvReg, n163WaveReg, vrc7ToneReg },
        toneOf: (id) => (options.tone || {})[id],
        n163WaveLen: MML.Kss2MmlExpansion.SCC_WAVE_LEN,
        extract: (chip, fam, reg) => {
          // 波形/音色レジストリは借用先がその音源のときだけ本物を渡す(他のファミリへ載せる
          // 抽出でも登録してしまうと、誰も参照しない@N/@OP定義がMML本文に残るため)
          const waveReg = fam === 'n163' ? n163WaveReg : MML.Convert.n163WaveRegistry();
          const toneReg = fam === 'vrc7' ? vrc7ToneReg : new MML.Convert.WaveRegistry('@OP');
          if (chip === 'ay8910') return MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock, reg).channels;
          if (chip === 'k051649') return MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock, waveReg, reg).channels;
          if (chip === 'ym2413') return MML.Kss2MmlExpansion.opll(writeLog, totalFrames, toneReg).channels;
          if (chip === 'opl') return MML.Kss2MmlExpansion.opl(writeLog, totalFrames, clock, toneReg).channels;
          return null;
        },
      });
      scoreChannels = r.scoreChannels;
      expansions = r.expansions;
      expansionLetterMap = r.letterMap;
      borrowNotes = r.notes;
      if (cmd.DRUM !== false && options.drumHits && options.drumHits.length && MML.Convert.DrumHits && MML.Dpcm) {
        const d = MML.Convert.DrumHits.dpcm(options.drumHits, frameRate, {
          totalFrames, dmcRate: cmd.DMC_RATE, rateMix: cmd.RATE_MIX, poly: cmd.DRUM_POLY, prefix: 'kss_drum', maxClipSec: 10 });
        if (d.defs.length) {
          for (const def of d.defs) dpcmDefLines.push(`@DPCM${def.index} = { "${def.file}", ${def.freq}, ${def.size}, ${def.dac}, ${def.mode} }`);
          dpcmFiles.push(...d.files);
          scoreChannels.push({ letter: 'E', events: d.events, hasInstrument: true, isDrum: true });
          MML.Convert.sortChannelsByLetter(scoreChannels);
          drumNote = `打楽器化したchを実音のままDPCM(E)へ変換しました: 定義${d.stats.clips}件 / 打点${d.stats.segments}個 / ROM ${(d.stats.bytes / 1024).toFixed(1)}KB`;
        }
      }
      chanDesc = Object.keys(r.placed)
        .map(t => `${MML.Convert.ChannelPlan.letterOfTarget(t)}=${r.placed[t].source.label}`)
        .sort().join(' ');
    } else {
    expansions = ['fme7'].concat(hasScc ? ['n163'] : []).concat((hasOpll || hasOpl) ? ['vrc7'] : []);
    expansionLetterMap = MML.Mml.assignExpansionLetters(expansions);

    scoreChannels = [];

    // PSG(3ch) → fme7 (AY-3-8910互換なのでそのまま正しく再生できる)
    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock, envReg);
    // 音程補正: 複数chが同じ音程を同時に鳴らしている(コーラス)場合だけ実測周波数の
    // 差をD<n>で明示する(detectChorusDetune、src/convert/detune.js)。単独音は理論値
    // (12平均律)にそのまま丸める。★2026-08-02: 以前はapplyPitchDetune(単独音も含め常に
    // 実測値ベースで補正)を使っていたが、KSSのドライバのノートテーブル自体がA440/12平均律
    // から系統的に数十セントずれている曲があり(Gofer no Yabou II実測)、単独音まで
    // 大きくズラしてしまい聞くに堪えなかった。ユーザー確認の上detectChorusDetune方式を
    // 正式採用。
    MML.Convert.detectChorusDetune(ayResult.channels, fme7PeriodRaw, { cmd });
    // 高速アルペジオ→EN統合(2026-08-14拡張)。★必ずassignPitchEnvelopeより先に呼ぶこと:
    // assignPitchEnvelopeは内部でmarkSlurTiesを呼び、qualifiesForSlurがev.noteEnvの
    // 有無を見てタイ化を抑制する。ev.noteEnvが未確定(noteEnvOffsetsのまま)の状態で
    // markSlurTiesが走ると、アルペジオ統合済みイベントが誤ってタイ候補と判定され、
    // mmlEmit側のEN再送出がスキップされる退行になる(SPC変換で実測発覚)。
    MML.Convert.assignNoteEnvelope(ayResult.channels, noteEnvReg);
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
        sccResult.channels, n163FreqRegRaw(MML.Kss2MmlExpansion.SCC_WAVE_LEN, n163ActualNumCh), { cmd });
      // 高速アルペジオ→EN統合(2026-08-14拡張)。ay.jsのブロックと同じ理由で
      // assignPitchEnvelope(内部でmarkSlurTiesを呼ぶ)より必ず先に呼ぶこと。
      MML.Convert.assignNoteEnvelope(sccResult.channels, noteEnvReg);
      MML.Convert.assignPitchEnvelope(
        sccResult.channels, n163FreqRegRaw(MML.Kss2MmlExpansion.SCC_WAVE_LEN, n163ActualNumCh), pitchReg,
        { saMode: cmd.PITCH_SA }); // 出力先N163: SA<num>自動選択(pitch.js n163SaForBase参照)
      const n163Letters = expansionLetterMap.n163;
      for (let i = 0; i < n163Letters.length; i++) {
        const ch = sccResult.channels[i] || { events: [], hasVolume: true, hasInstrument: true };
        scoreChannels.push(Object.assign({}, ch, { letter: n163Letters[i], hasDetune: true, hasPitchMod: true }));
      }
    }

    // FMPAC(6ch) → vrc7 (OPLL=YM2413そのものなのでそのまま正しく再生できる)。
    // ★FMPACとMSX-AUDIOを両方宣言するKSS(コンパイル系。曲番号+64でMSX-AUDIO版を選ぶ
    //   Xevious Fardraut等)は、FMPACが完全に無音の曲ならVRC7枠をMSX-AUDIOへ譲る
    //   (実際に鳴っている方を変換する)。FMPACだけの曲は従来どおり(無音でも枠を出す)。
    const opllProbe = hasOpll ? MML.Kss2MmlExpansion.opll(writeLog, totalFrames, vrc7ToneReg) : null;
    const opllSilent = !opllProbe || !opllProbe.channels.some(ch => ch.events.some(ev => ev.note !== null));
    const preferOpl = hasOpl && hasOpll && opllSilent;
    if (hasOpll && !preferOpl) {
      const opllResult = opllProbe;
      // PSG/SCCと同じ理由でVRC7側も音程補正する(VRC7のfnum式を使用)。
      MML.Convert.detectChorusDetune(opllResult.channels, vrc7FnumRaw, { cmd });
      const vrc7Letters = expansionLetterMap.vrc7;
      // EN(ノートエンベロープ)はfnum/blockを都度再計算するだけなのでOPLL(=VRC7)でも使える
      // (D/EP/MPと違い生レジスタへの単純加算を必要としない、nsf2mml/converter.jsと同じ理由)。
      // OPLLはmarkSlurTiesが掛からない(ay.js/scc.jsと違い、これらのチャンネルには
      // タイ分割の仕組み自体が無い)ため、ay/sccのような呼び出し順序の制約は無い。
      MML.Convert.assignNoteEnvelope(opllResult.channels, noteEnvReg);
      // ★2026-08-22: 抽出側がYM2413本来の9chを返すようになったが、出力先のVRC7は6ch固定
      // (ppmckの拡張チャンネル文字は固定。[[ppmck-fixed-channel-letters]])。溢れるぶんは
      // 落とすしかないので、7ch目以降に実音がある曲に限り「実際に鳴っているchだけを
      // 前詰め」して取りこぼしを減らす。6ch以内に収まる従来の曲は前詰めが起きないため
      // MML出力は完全に従来通りになる。
      let opllChannels = opllResult.channels;
      const cap = vrc7Letters.length;
      if (opllChannels.length > cap) {
        const sounding = opllChannels.filter(ch => ch.events.some(ev => ev.note !== null));
        const overflow = opllChannels.slice(cap).some(ch => ch.events.some(ev => ev.note !== null));
        opllChannels = (overflow && sounding.length <= cap) ? sounding : opllChannels.slice(0, cap);
        if (opllChannels.length > cap) opllChannels = opllChannels.slice(0, cap);
      }
      opllChannels.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: vrc7Letters[i], hasDetune: true, hasNoteEnv: true })));
    }

    // MSX-AUDIO(Y8950、9ch) → vrc7(音色はOPLLカスタム音色へ直接変換=2op同士でほぼ忠実)。
    // FMPACと両搭載の曲はVRC7 6枠をFMPACが取るので対象外(割当UIで振り替え可能)。
    // 溢れ時の前詰めはFMPACブロックと同じ。リズムモード打楽器とADPCMは変換対象外
    // (kss2mml/expansion/opl.js冒頭コメント)。
    if (hasOpl && (!hasOpll || preferOpl)) {
      preferOplForNote = preferOpl;
      const oplResult = MML.Kss2MmlExpansion.opl(writeLog, totalFrames, clock, vrc7ToneReg);
      MML.Convert.detectChorusDetune(oplResult.channels, vrc7FnumRaw, { cmd });
      const vrc7Letters = expansionLetterMap.vrc7;
      MML.Convert.assignNoteEnvelope(oplResult.channels, noteEnvReg);
      let oplChannels = oplResult.channels;
      const cap6 = vrc7Letters.length;
      if (oplChannels.length > cap6) {
        const sounding = oplChannels.filter(ch => ch.events.some(ev => ev.note !== null));
        const overflow = oplChannels.slice(cap6).some(ch => ch.events.some(ev => ev.note !== null));
        oplChannels = (overflow && sounding.length <= cap6) ? sounding : oplChannels.slice(0, cap6);
        if (oplChannels.length > cap6) oplChannels = oplChannels.slice(0, cap6);
      }
      oplChannels.forEach((ch, i) => scoreChannels.push(Object.assign({}, ch, { letter: vrc7Letters[i], hasDetune: true, hasNoteEnv: true })));
    }
    } // ← 既定割当の従来経路ここまで(customPlanのときは上のBorrow.compose()を使う)

    // チャンネル毎の発音開始間隔(IOI)を検出材料にする(MML.Convert.tempoMaterial、src/convert/bpm.js。
    // ゲートタイムで音符が短く切られてもIOIはグリッドに乗るため頑健)。
    const noteDurations = [];
    for (const ch of scoreChannels) {
      if (ch.isDrum) continue; // ドラム(E)はテンポ推定から外す(vgm2mml と同じ理由)
      const sounding = ch.events.filter(ev => ev.note !== null);
      noteDurations.push(...MML.Convert.tempoMaterial(sounding.map(ev => ev.start), sounding.map(ev => ev.end - ev.start)));
    }
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.detectBpm(noteDurations, frameRate);
    // MML本文に埋め込まれるテンポは整数(t<n>)に丸められる(mmlEmit.js)。音長量子化の
    // グリッド(fpb)も同じ丸め後の値で計算しないと、書き出し時と再生(コンパイル)時で
    // 基準テンポが食い違い、打ち直しの多いパートで誤差が蓄積してドリフトする
    // ([[tempo-rounding-drift-future-issue]]参照)。
    const fpb = frameRate * 60 / Math.round(bpm);

    // VRC7自作音色(@0)の同時使用を1系統へ(src/convert/vrc7Tone.js)。
    // ★元がOPLLでも衝突しうる: ドライバが音符ごとに$00-$07を書き直す曲だと、フレーム単位の
    //   スナップショットがchごとに別の瞬間の値を拾い、抽出結果としてch別の音色になる
    //   (実測: Labyrinth 魔王の迷宮でG-Jが4種)。放置するとMMLがコンパイルできず全パート無音。
    //   ユーザー割当経路(borrow.compose)は既に解決済みなので、そちらから来た場合は何もしない
    const vrc7Notes = MML.Convert.Vrc7Tone.resolveForScore(scoreChannels, vrc7ToneReg);

    const headerComment = [
      `; =========================================================`,
      `; ${sourceLabel} → MML 変換 (MSX: PSG${hasScc ? ' + SCC' : ''}${hasOpll ? ' + FMPAC' : ''}${hasOpl ? ' + MSX-AUDIO' : ''})`,
      `; 曲番号   : ${songIndex}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      customPlan
        ? `; チャンネル: ${chanDesc || '-'} (借用先の割当: ユーザー指定)`
        : `; チャンネル: A-D=未使用(2A03) X-Z=PSG(FME-7として再生)${hasScc ? ' P-W=SCC(N163として近似再生)' : ''}`,
      (!customPlan && hasOpll && !preferOplForNote) ? `;             G-L=FMPAC(VRC7として再生)` : `;`,
      // MSX-AUDIO関連の2行は該当時のみ挿入(空の`;`行を足すと全KSSの出力が変わるため)
      ...((!customPlan && hasOpl && (!hasOpll || preferOplForNote)) ? [`;             G-L=MSX-AUDIO(Y8950、音色をOPLL/VRC7自作音色へ変換して再生。リズム/ADPCMは対象外)`] : []),
      ...((!customPlan && hasOpl && hasOpll && !preferOplForNote) ? [`; ※ MSX-AUDIOはVRC7の枠をFMPACが使用しているため変換対象外です(鍵盤表示のチャンネル割当で変更できます)。`] : []),
      `; ※ このアプリのMMLプレイヤーはNES音源専用のため、MSX音源はレジスタ互換/構造が`,
      `;    近いNES拡張音源(PSG→FME-7, FMPAC→VRC7, SCC→N163)を借りて再生します`,
      `;    (割当は鍵盤表示のpart列/「借用先」列で変更できます)。`,
      hasScc ? `;    SCCの波形はN163形式(4bit,32点)に変換した近似のため音色は完全一致しません。` : `;`,
      ...borrowNotes.map(n => `; ※ ${n}`),
      ...vrc7Notes.map(n => `; ※ ${n}`),
      ...(drumNote ? [`; ※ ${drumNote}`] : []),
      ...MML.Convert.tuningCommentLines(),
      `; =========================================================`,
      ``
    ].join('\n');

    // #EX-*(機能する本文ディレクティブ。上の`; `コメントとは別。これがないと
    // MML本文だけからは拡張音源が有効にならず、UI側の操作が必要になってしまう)
    const directiveLines = expansions.map(chip => chip === 'n163'
      ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${(expansionLetterMap.n163 || []).length}`
      : MML.Mml.EX_CHIP_DIRECTIVE[chip]);

    // 音符の区切り(NOTE_END、src/convert/envelope.js)。@v表を書き換えるので defLines() より前
    MML.Convert.applyNoteEnd(scoreChannels, envReg, cmd, fpb, frameRate);
    const scoreText = MML.Convert.emitScore(scoreChannels, fpb, {
      totalFrames, tempoBpm: bpm, cmd,
      headerLines: [
        ...MML.Convert.tuningHeaderLines(), ...directiveLines, ...dpcmDefLines, ...envReg.defLines(), ...pitchReg.defLines(), ...noteEnvReg.defLines(),
        ...(expansions.indexOf('n163') >= 0 ? n163WaveReg.defLines() : []),
        ...(expansions.indexOf('vrc7') >= 0 ? vrc7ToneReg.defLines() : [])
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
      chips: ['PSG'].concat(hasScc ? ['SCC'] : []).concat(hasOpll ? ['FMPAC'] : []).concat(hasOpl ? ['MSX-AUDIO'] : []),
      expansions,
      n163Wave: sccResult.n163Wave,
      dpcmFiles // 打楽器化したchの @DPCM(ユーザー指定経路のみ。main.js が dpcmSampleCache へ)
    };
  };
})(window);
