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
  const N163_SLOTS = 6;           // PSG 6ch をそのまま N163 の先頭6スロットへ載せる

  // N163周波数式の逆関数(nsf2mml/expansion/n163.jsと同じ式): freq = CPU*freqReg/(15*65536*length*numCh)
  // detune計算は差を取ってから1回だけ丸めるため、呼び出し側で先に丸めてはいけない
  // (src/convert/detune.js冒頭コメント)。
  // ★numChは変換設定 N163_CH で決めた実効ch数を渡すこと。以前は6固定で、コンパイラが
  //   本文から検出する値(音符を持つ最上位+1)と食い違う曲ではD<n>とEPの尺度がずれていた
  //   (コーパス119曲中40曲で発生。2026-09-11修正)
  function n163PeriodRawFor(numCh) {
    return function (freqHz, ev) {
      const length = (ev && ev.rawLength) || 32;
      return (freqHz * 15 * 65536 * length * numCh) / CPU_CLOCK_NTSC;
    };
  }

  // ── 音量: PSGの対数インデックス → N163/2A03ノイズの線形音量(2026-09-19) ──────────────
  // 抽出器(wave.js/noise.js)の音量は実効インデックス effVol>>1(0-15、1段=3dB の対数。
  // apuHuC6280.js gainFromIndex)。★以前はこれを N163 と 2A03ノイズ(どちらも音量値が振幅に比例する
  // 線形4bit)へ生値のまま書いていたため、強弱の差が大きく縮んでいた(idx12=-9dB が v12=-1.9dB)。
  // 小さいch・小さいノイズほど持ち上がるので、ノイズ(元はトーンより3〜6段小さい曲が多い)が
  // 元のトーン:ノイズ比より平均 +8.4dB(N163 8ch)/ +4.4dB(使ったch数)大きく、減衰も緩かった
  // (コーパス12曲の実測。ノイズだけ直すとトーン側の持ち上がりが残るので逆に平均 -4〜-5dB 小さくなる)。
  // トーンch同士の音量差も元との食い違いが平均 3.0dB → 1.3dB(8曲38ch)に縮む。
  // 借用層(borrow.js CHIP_VOL_LAW huc6280: 3dB/段)が2A03パルス等へ載せるときに使う換算と同じ考え方。
  //
  // 正規化: 曲全体で下位1%の減衰(=上位1%の大きさのインデックス)を v15 に寄せる
  // (opn.js normalizeAtt と同じ「チップ単位」。ch単位にするとch間の差が壊れる)。
  // 全体に小さく鳴らす曲(実効インデックスの平均が5〜7の曲がある)が v1-v2 に張り付かないようにするため
  const PSG_DB_PER_STEP = 3;
  function logToLinearTable(offsetDb) {
    const t = new Array(16);
    for (let v = 0; v < 16; v++) {
      t[v] = v === 0 ? 0 : Math.max(1, Math.min(15, Math.round(15 * Math.pow(10, (offsetDb - PSG_DB_PER_STEP * (15 - v)) / 20))));
    }
    return t;
  }
  // 曲全体の正規化量[dB](トーン/ノイズの鳴っているフレームの実効インデックス上位1%を15へ)
  function normalizeOffsetDb(snapshots) {
    const hist = new Array(16).fill(0);
    let n = 0;
    for (const s of snapshots) {
      for (let c = 0; c < 6; c++) {
        const x = s[c];
        if (!x || !x.on || x.dda) continue;
        const idx = MML.Hes2MmlExpansion._effectiveVolIndex(x.vol, x.balance, s.globalBalance) >> 1;
        if (idx > 0) { hist[Math.min(15, idx)]++; n++; }
      }
    }
    if (!n) return 0;
    let acc = 0;
    for (let v = 15; v >= 1; v--) { acc += hist[v]; if (acc >= n * 0.01) return (15 - v) * PSG_DB_PER_STEP; }
    return 0;
  }
  // 2A03ノイズを N163 のトーンに釣り合わせる補正[dB]。元の PSG ではノイズと全振幅の矩形波が
  // 同じインデックスで同じ大きさ(apuHuC6280.js: どちらも 0/31 の2値。単独再生の実測 -15.8dB で一致)。
  // 借用先では 2A03ノイズ v15 が -21.1dB(apu2a03.js tnd式、実測)、N163 の全振幅矩形波 v15 が
  // -24.6dB + 20log10(8/numCh)(n163.js mixSample は有効ch数で割る)なので、その差だけノイズを動かす
  // (8ch: -3.5dB / 6ch: -1.0dB / 5ch: +0.6dB)。N163 を使わない割当では補正しない
  function noiseBalanceDb(n163NumCh) {
    return n163NumCh > 0 ? -3.5 + 20 * Math.log10(8 / n163NumCh) : 0;
  }
  // envReg を写像テーブル経由にするプロキシ(抽出器が使う assign / volumeFieldsWithRelease の両方。
  // 定数音量 ev.volume も volumeFieldsWithRelease が写像後の列から作るので別途の写像は要らない)
  function mappedEnvReg(envReg, table) {
    const map = seq => seq.map(v => table[Math.max(0, Math.min(15, v))]);
    return {
      assign: seq => envReg.assign(map(seq)),
      volumeFieldsWithRelease: seq => (envReg.volumeFieldsWithRelease
        ? envReg.volumeFieldsWithRelease(map(seq))
        : (() => { const idx = envReg.assign(map(seq)); return idx == null ? { volume: MML.Convert.plainVolume(map(seq)) } : { envelopeV: idx }; })())
    };
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
   * VGMを同じ抽出・出力経路で変換するために分離した(抽出器を複製しない方針、作業計画
   * VGM節)。fromHes経由の出力は分離前と完全に同一。
   * @param {object} cap - { snapshots(hesPlayer.js snapshotApu形式のフレーム配列),
   *   dpcmTrace, controlTrace(captureHesSongAsync由来。無ければ空配列でDDA(PCM)は抽出されない),
   *   frameRate, trackLabel(コメント用), sourceLabel(コメント用、既定'HES') }
   */
  // ── チャンネル割当(案E) ────────────────────────────────────────
  // 変換元チャンネルのIDは鍵盤表示の行IDと同じ体系(PSG0-5)。音量は抽出時点では対数インデックス(0-15)で、
  // N163(nativeFamily、借用層は素通し)へ載せる分は convertHesOnce が線形へ写像済み
  // (logToLinearTable)。それ以外の借用先へは借用層が CHIP_VOL_LAW で換算する。
  // ノイズ(ch4/5のノイズモード)とDDA(PCM)は「chのモード」であって別チャンネルではないため、
  // 割当の対象にはせず従来どおりD/Eへ固定で出す。
  MML.HES2MML.sourceChannels = function () {
    return Array.from({ length: 6 }, (_, i) => ({
      id: `PSG${i}`, label: `PSG ch${i}`, chip: 'huc6280', kind: 'wave', ch: i,
      // ★音量則は chip 名から引く(src/convert/borrow.js CHIP_VOL_LAW)。ここに linear: true と
      //   書いてあったが誤りで、HuC6280のPSG音量は対数(MAME c6280「48dBを32段」=1.5dB/段。
      //   抽出器が effVol>>1 で16段へ落とすので実効3dB/段)。2026-09-11訂正
      nativeFamily: 'n163',
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
    // 音量は対数インデックス → 線形(logToLinearTable 冒頭コメント)。N163へ載せるトーンはここで写像済みの
    // レジストリで抽出する(借用層で N163 以外へ載せる分は下の extract が生のインデックスで取り直す)
    const volNormDb = normalizeOffsetDb(snapshots);
    const volNormSteps = Math.round(volNormDb / PSG_DB_PER_STEP);
    const normShiftTable = Array.from({ length: 16 }, (_, v) => (v === 0 ? 0 : Math.min(15, v + volNormSteps)));
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots, n163WaveReg, mappedEnvReg(envReg, logToLinearTable(volNormDb)),
      capture.controlTrace, capture.pitchTrace,
      // SA不使用設定のときだけ深い統合を止める(wave.js冒頭コメント参照)
      { maxAbsorbCents: cmd.PITCH_SA === 'off' ? 70 : null });
    // ノイズの音量は N163 の実効ch数で補正量が変わる(noiseBalanceDb)ので、ch数が決まってから抽出する。
    // ここでは有無の判定だけ(レジストリを渡さないので @v は登録されない。音程/区切りは音量写像に依らない)
    const hasNoise = MML.Hes2MmlExpansion.noise(snapshots, null, capture.controlTrace).events.some(ev => ev.note !== null);
    const extractNoise = (n163NumCh) => MML.Hes2MmlExpansion.noise(snapshots,
      mappedEnvReg(envReg, logToLinearTable(volNormDb + noiseBalanceDb(n163NumCh))), capture.controlTrace);
    // options.drumHits: 合成音ch(PSG波形ch)を打楽器化した打点(main.js synthDrum)。DDAと一緒にEへ
    const dpcmResult = MML.Hes2MmlExpansion.dpcm(snapshots, capture.dpcmTrace, capture.controlTrace, frameRate, cmd,
      cmd.DRUM !== false ? (options.drumHits || null) : null);
    const hasDpcm = dpcmResult.defs.length > 0;
    // E(DPCM)へ載った音の出どころ表記。既定はHESの想定どおり「PSG DDA」だが、VGM経由の
    // PC Engine CD曲は中身がMSM5205のADPCMなので呼び出し側が差し替える(vgm2mml converter)。
    // ★両方が同時に載っている曲ではこの見出しは一方しか名乗らない(打点の内訳は別注記で出る)。
    const dpcmSrcLabel = options.dpcmLabel || 'PSG DDA';

    // rawLength(N163波形の実サンプル数、常に32)を付与してからdetune計算に渡す
    // (applyPitchDetuneのperiodForFreqがev経由でlengthを参照するため)。
    for (const ch of waveResult.channels) {
      for (const ev of ch.events) if (ev.note !== null) ev.rawLength = 32;
    }

    // N163内蔵RAM(波形に使えるのは128-8*有効ch数バイト)に収まらない曲を収まる形へ
    // (変換設定 N163_WAVE。src/convert/n163Fit.js)。★音程補正より前に呼ぶこと:
    // N163の周波数式は波形長を含むため、縮めた後の長さで生レジスタ値を出さないとズレる。
    // ユーザー割当経路(customPlan)は借用層 borrow.compose 側で同じ処理を通す
    // 既定経路(PSG 6ch → N163)の実効ch数。音符のあるスロットだけ数える('used')か8固定
    const hesN163NumCh = MML.Convert.n163NumChFor(cmd,
      waveResult.channels.map((ch, i) => (ch.events.some(ev => ev.note !== null) ? i : -1)).filter(i => i >= 0));
    const n163PeriodRaw = n163PeriodRawFor(hesN163NumCh);
    const n163FitNotes = options.channelMap ? []
      : MML.Convert.N163Fit.apply(waveResult.channels, n163WaveReg, cmd, hesN163NumCh);

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
    let expansions, expansionLetterMap, scoreChannels, borrowNotes = [], chanDesc = '', toneDemotions = [];
    let n163NumCh = hesN163NumCh; // N163の実効ch数(#EX-N163の数値。周波数式・波形RAM枠と必ず同じ値)
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
        toneSettings: options.toneSettings || null, // 音色ごとの設定(src/convert/toneSettings.js)
        // PSGの抽出は借用先ファミリに依らず1回でよい(既に上で済ませてある)。ただし音量尺度が
        // 違うファミリ(FME-7/VRC7/2A03パルス等)へ載せる分は @v テーブルを写像した registry で取り直す。
        // 借用層の写像(CHIP_VOL_LAW huc6280: 3dB/段)は生のインデックスを受けるので、曲全体の正規化
        // (normalizeOffsetDb、3dBの整数倍)はインデックスを同じ段数だけ持ち上げて揃える
        extract: (chip, fam, reg) => (reg === envReg ? waveResult.channels
          : MML.Hes2MmlExpansion.wave(snapshots, MML.Convert.n163WaveRegistry(),
              volNormSteps ? mappedEnvReg(reg, normShiftTable) : reg,
              capture.controlTrace, capture.pitchTrace,
              { maxAbsorbCents: cmd.PITCH_SA === 'off' ? 70 : null }).channels),
      });
      expansions = r.expansions.slice();
      if (hasDpcm && expansions.indexOf('dpcm') < 0) expansions.unshift('dpcm');
      expansionLetterMap = MML.Mml.assignExpansionLetters(expansions);
      scoreChannels = r.scoreChannels;
      n163NumCh = r.n163NumCh;
      borrowNotes = r.notes;
      toneDemotions = r.demotions || [];
      chanDesc = Object.keys(r.placed)
        .map(t => `${MML.Convert.ChannelPlan.letterOfTarget(t)}=${r.placed[t].source.label}`).sort().join(' ');
      // N163 を使わない割当ではノイズの補正をしない(noiseBalanceDb)
      if (hasNoise) scoreChannels.push(Object.assign({}, extractNoise(expansions.indexOf('n163') >= 0 ? n163NumCh : 0), { letter: 'D' }));
      if (hasDpcm) scoreChannels.push({ letter: expansionLetterMap.dpcm[0], events: dpcmResult.events }); // E: 音符=@DPCM番号(ppmck準拠)
      MML.Convert.sortChannelsByLetter(scoreChannels);
    } else {
    expansions = ['n163'];
    // dpcmは実機ppmck同様レター体系上は常にEを固定占有する(使わなくても他チップの
    // レター位置には影響しない。src/mml/compiler.js assignExpansionLetters参照)。
    expansionLetterMap = MML.Mml.assignExpansionLetters(hasDpcm ? ['dpcm', 'n163'] : expansions);
    const n163Letters = expansionLetterMap.n163;
    const dpcmLetter = hasDpcm ? expansionLetterMap.dpcm[0] : null;

    // ★休符だけのチャンネルは出さない(方針 2026-09-11)。実効ch数は
    //   #EX-N163 の数値で伝わるので、空チャンネルで位置を示す必要がなくなった。
    //   ただし全部休符の曲(15秒間まったく鳴らないHESが実測28曲)で全滅させると
    //   本文にチャンネル行が1つも無いMMLになり「 t120」だけが残ってコンパイルエラーになる。
    //   最低1本(P)は残して、無音のまま成立する従来どおりのMMLにする
    const allWave = waveResult.channels
      .map((ch, i) => Object.assign({}, ch, { letter: n163Letters[i], hasDetune: true, hasPitchMod: true }));
    scoreChannels = allWave.filter(ch => ch.events.some(ev => ev.note !== null));
    if (!scoreChannels.length) scoreChannels = allWave.slice(0, 1);
    if (hasNoise) scoreChannels.push(Object.assign({}, extractNoise(n163NumCh), { letter: 'D' }));
    if (hasDpcm) scoreChannels.push({ letter: dpcmLetter, events: dpcmResult.events }); // E: 音符=@DPCM番号(ppmck準拠)
    }
    // ノイズパッド(2026-09-18): 載せ先=ノイズのパッドの打点(DDA/合成音ch)を2A03ノイズ(D)へ
    // (既存の D=PSGノイズ と単音マージ。src/convert/drumHits.js applyNoise)
    if (dpcmResult.noiseHits && dpcmResult.noiseHits.length && MML.Convert.DrumHits && MML.Convert.DrumHits.applyNoise) {
      // DDAの打点の音量(dpcm.js ddaGain、エミュレータと同じ線形振幅)を、PSGノイズ→D と同じ尺度へ
      // (曲全体の正規化 volNormDb+ノイズの釣り合い noiseBalanceDb。extractNoise と同じ)。
      // パッドの「自動」はこの vol×15 を v にする(drumHits.js noiseToneOf)。合成音chの打点(extraHits)は
      // 別の尺度なので触らない
      const padNoiseDb = volNormDb + noiseBalanceDb(customPlan ? (expansions.indexOf('n163') >= 0 ? n163NumCh : 0) : n163NumCh);
      const padGain = Math.pow(10, padNoiseDb / 20);
      const noiseHits = dpcmResult.noiseHits.map(h => (/^dda/.test(h.key || '')
        ? Object.assign({}, h, { vol: Math.min(1, (h.vol || 0) * padGain) }) : h));
      MML.Convert.DrumHits.applyNoise(scoreChannels, noiseHits, frameRate, {
        totalFrames, regs: { envReg, pitchReg, noteEnvReg }, presets: options.noisePresets });
    }

    const noteDurations = [];
    for (const ch of scoreChannels) {
      const sounding = ch.events.filter(ev => ev.note !== null);
      noteDurations.push(...MML.Convert.tempoMaterial(sounding.map(ev => ev.start), sounding.map(ev => ev.end - ev.start)));
    }
    // 2倍/半分の決着は「実際に音価を書いてみて素直な方」(MML.Convert.chooseTempoOctave、src/convert/mmlEmit.js)
    const bpm = options.bpm
      ? MML.Convert.refineBpm(options.bpm, noteDurations, frameRate)
      : MML.Convert.chooseTempoOctave(MML.Convert.detectBpm(noteDurations, frameRate), scoreChannels, frameRate, { totalFrames, cmd });
    const fpb = frameRate * 60 / Math.round(bpm);

    const headerComment = [
      `; =========================================================`,
      `; ${sourceLabel} → MML 変換 (PC Engine/TurboGrafx-16: PSG 6ch)`,
      `; トラック番号 : ${trackNo}${isFinite(+trackNo) ? ` (0x${(+trackNo & 0xFF).toString(16).toUpperCase()})` : ''}`,
      `; Tempo    : ${Math.round(bpm)} BPM (${options.bpm ? '指定' : '推定'})`,
      `; 分解能   : 480 TPQN (MIDI準拠)`,
      `; 変換     : Sound Emulation Foundry`,
      customPlan
        ? `; チャンネル: ${chanDesc || '-'}${hasDpcm ? ` ${expansionLetterMap.dpcm[0]}=${dpcmSrcLabel}(PCM)` : ''}${hasNoise ? ' D=PSGノイズ' : ''} (借用先の割当: ユーザー指定)`
        : `; チャンネル: ${hasDpcm ? expansionLetterMap.dpcm[0] + '=' + dpcmSrcLabel + '(PCM、2A03 DMCとして近似再生) ' : ''}${(expansionLetterMap.n163 || []).slice(0, N163_SLOTS).join('')}=PSG ch0-5(N163として近似再生)${hasNoise ? ' D=PSGノイズ(ch4/5、2A03ノイズとして近似再生)' : ''}`,
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
    // #EX-*: 既定は常にN163。ユーザー指定のときは実際に使った拡張音源だけ宣言する。
    // ★N163の数値はどちらの経路も n163NumCh(変換設定 N163_CH で決めた値。周波数式・波形RAM枠と同じ)。
    //   以前はユーザー割当のとき本文から数え直していて、「8固定」でも使ったch数(5等)が出ていた(2026-09-19修正)
    const directiveLines = customPlan
      ? expansions.filter(chip => chip !== 'dpcm').map(chip => chip === 'n163'
        ? `${MML.Mml.EX_CHIP_DIRECTIVE[chip]} ${n163NumCh}`
        : MML.Mml.EX_CHIP_DIRECTIVE[chip])
      : [`${MML.Mml.EX_CHIP_DIRECTIVE.n163} ${n163NumCh}`];

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
      dpcmFiles: dpcmResult.files,
      toneDemotions // 音色一覧パネル用(VRC7自作音色→プリセットへ落ちた音色)
    };
  };
})(window);
