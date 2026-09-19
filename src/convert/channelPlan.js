/*
 * チャンネル割当(変換元ch → NSF側の借用先パート)の共通語彙と現在の割当計画
 * (2026-08-26、鍵盤表示に統合する「案E」の下地)
 *
 * これまで割当UIは2箇所にバラバラに実装されていた:
 *   SPC … ボイスモニターのカード内select(借用先/音色/変換音量)  src/main.js
 *   VGM … VGMパネルの「チャンネル割当」表                        src/main.js
 * どちらも語彙(借用先の一覧・ラベル)は同じなのに実装が別だったため、ここへ集約し、
 * 鍵盤表示(src/ui/keyboard.js)の行から直接編集できるようにする。
 *
 * ★重要な前提: 鍵盤表示のpart列は元々「この元chはNSFのどのパートになるか」を
 *   getPartLetter()のハードコード規則で表示していた(=既に割当表だった)。よってここでは
 *   既定値を作り直さず、「鍵盤が出した既定レター」を targetOfLetter() で借用先タイプへ
 *   逆引きしたものを既定とし、ユーザーが変えた分だけをこのモジュールが保持する。
 *   こうすることで既定の挙動(=従来の変換結果)は一切変わらない。
 *
 * 用語:
 *   target(借用先タイプ) … 'pulse1' | 'n163_3' | 'vrc7_0' | 'skip' 等の文字列。
 *                          語彙は src/vgm2mml/converter.js TARGET_TYPES と同一。
 *   letter               … MML本文のパート文字(A-Z,a,b)。assignExpansionLetters由来。
 *   kind(元chの種別)     … 'square'|'wave'|'noise'|'fm'|'fm4'|'pcm'|'any'。選べる借用先を絞る。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  // ── 借用先の一覧 ───────────────────────────────────────────────
  // 並びはチャンネル文字のアルファベット順(A-Z,ab)。文字は実機ppmck同様、他チップの
  // 有無に関わらず完全固定(assignExpansionLetters: dpcm=E, fds=F, vrc7=G-L, vrc6=M-O,
  // n163=P-W, fme7=X-Z, mmc5=a-b。[[ppmck-fixed-channel-letters]])
  const TARGET_LIST = [
    ['skip', null, null, null],
    ['pulse1', '2a03', 'A', 'pulse'],
    ['pulse2', '2a03', 'B', 'pulse'],
    ['triangle', '2a03', 'C', 'triangle'],
    ['noise', '2a03', 'D', 'noise'],
    ['dpcm', '2a03', 'E', 'dpcm'],
    ['fds', 'fds', 0, 'fds'],
    ['vrc7_0', 'vrc7', 0, 'vrc7'], ['vrc7_1', 'vrc7', 1, 'vrc7'], ['vrc7_2', 'vrc7', 2, 'vrc7'],
    ['vrc7_3', 'vrc7', 3, 'vrc7'], ['vrc7_4', 'vrc7', 4, 'vrc7'], ['vrc7_5', 'vrc7', 5, 'vrc7'],
    ['vrc6pulse1', 'vrc6', 0, 'vrc6pulse'], ['vrc6pulse2', 'vrc6', 1, 'vrc6pulse'], ['vrc6saw', 'vrc6', 2, 'vrc6saw'],
    ['n163_0', 'n163', 0, 'n163'], ['n163_1', 'n163', 1, 'n163'], ['n163_2', 'n163', 2, 'n163'],
    ['n163_3', 'n163', 3, 'n163'], ['n163_4', 'n163', 4, 'n163'], ['n163_5', 'n163', 5, 'n163'],
    ['n163_6', 'n163', 6, 'n163'], ['n163_7', 'n163', 7, 'n163'],
    ['fme7a', 'fme7', 0, 'fme7'], ['fme7b', 'fme7', 1, 'fme7'], ['fme7c', 'fme7', 2, 'fme7'],
    ['mmc5pulse1', 'mmc5', 0, 'pulse'], ['mmc5pulse2', 'mmc5', 1, 'pulse'],
  ];
  // type → { chip, index|letter, family }
  const TARGETS = {};
  for (const item of TARGET_LIST) {
    const type = item[0], chip = item[1], idx = item[2], family = item[3];
    TARGETS[type] = chip === '2a03' ? { chip: chip, letter: idx, family: family }
      : chip ? { chip: chip, index: idx, family: family } : { chip: null, family: null };
  }

  // 借用先の表示名(パート文字は letterOfTarget() が動的に前置するのでここには含めない)
  // ★借用先の名前は全部英語で統一する(ユーザー指示)。チップ名+チャンネル名なので
  //   翻訳する意味が薄く、日英が混ざると一覧としてかえって読みにくいため。
  const TARGET_NAME = function () {
    return {
      skip: T('スキップ'), // これだけは操作(=変換しない)なので訳す
      pulse1: '2A03 Pulse1', pulse2: '2A03 Pulse2', triangle: '2A03 Triangle', noise: '2A03 Noise', dpcm: '2A03 DPCM',
      fds: 'FDS Wave',
      vrc6pulse1: 'VRC6 Pulse1', vrc6pulse2: 'VRC6 Pulse2', vrc6saw: 'VRC6 Saw',
      fme7a: 'FME-7 A', fme7b: 'FME-7 B', fme7c: 'FME-7 C',
      mmc5pulse1: 'MMC5 Pulse1', mmc5pulse2: 'MMC5 Pulse2',
    };
  };

  // 借用先チップごとの色(セレクトの項目とpart列チップの文字色)。音源の区別を色でも付ける
  const CHIP_COLOR = {
    '2a03': '#d1483a', fds: '#c98a00', vrc7: '#8a5cd6', vrc6: '#1e9e5a',
    n163: '#3a6ea5', fme7: '#c2456f', mmc5: '#2a8f96',
  };
  function colorOfTarget(type) {
    const tt = targetInfo(type);
    return (tt && tt.chip && CHIP_COLOR[tt.chip]) || '';
  }

  function targetInfo(type) { return TARGETS[type] || TARGETS.skip; }

  // 借用先 ⇔ MMLパート文字。拡張音源のレターは実機ppmck同様、他チップが使われているか否かに
  // 関わらず**完全固定**(src/mml/compiler.js assignExpansionLetters)なので、全チップを渡して
  // 引いた表を1度だけ作って使い回す。★extractChannels()は再生中に毎フレーム・ロール構築では
  // 全フレームぶん走るので、ここで毎回 assignExpansionLetters を呼ぶと重い(要キャッシュ)。
  let letterMapCache = null;
  let letterToTargetCache = null;
  function fullLetterMap() {
    if (!letterMapCache) {
      letterMapCache = (MML.Mml && MML.Mml.assignExpansionLetters)
        ? MML.Mml.assignExpansionLetters(['dpcm', 'fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5']) : {};
    }
    return letterMapCache;
  }
  function letterOfTarget(type) {
    const tt = targetInfo(type);
    if (!tt.chip) return '';
    if (tt.chip === '2a03') return tt.letter;
    return (fullLetterMap()[tt.chip] || [])[tt.index] || '';
  }
  // MMLパート文字 → 借用先タイプ(鍵盤が出した既定レターを既定の借用先に逆引きする)
  function targetOfLetter(letter) {
    if (!letter) return 'skip';
    if (!letterToTargetCache) {
      letterToTargetCache = {};
      for (const type of Object.keys(TARGETS)) {
        if (type === 'skip') continue;
        const l = letterOfTarget(type);
        if (l && letterToTargetCache[l] === undefined) letterToTargetCache[l] = type;
      }
    }
    return letterToTargetCache[letter] || 'skip';
  }

  // セレクトに出す表示文字列(「P: N163 ch1」)
  function targetLabel(type) {
    if (type === 'skip') return T('スキップ');
    const names = TARGET_NAME();
    const tt = targetInfo(type);
    const name = names[type] || (tt.chip === 'n163' ? 'N163 ch' + (tt.index + 1)
      : tt.chip === 'vrc7' ? 'VRC7 ch' + (tt.index + 1) : type);
    const letter = letterOfTarget(type);
    return letter ? letter + ': ' + name : name;
  }

  // ── 元chの種別 → 選べる借用先 ─────────────────────────────────
  const VRC7_T = ['vrc7_0', 'vrc7_1', 'vrc7_2', 'vrc7_3', 'vrc7_4', 'vrc7_5'];
  const N163_T = ['n163_0', 'n163_1', 'n163_2', 'n163_3', 'n163_4', 'n163_5', 'n163_6', 'n163_7'];
  const PULSE_T = ['pulse1', 'pulse2', 'triangle', 'mmc5pulse1', 'mmc5pulse2',
    'vrc6pulse1', 'vrc6pulse2', 'vrc6saw', 'fme7a', 'fme7b', 'fme7c'];
  const SQUARE_T = PULSE_T.concat(N163_T).concat(VRC7_T);
  // 波形音源(SCC/GB波形/HuC6280 PSG)は波形メモリを持つ先(FDS/N163)を先頭に、矩形波系も選べる
  const WAVE_T = ['fds'].concat(N163_T).concat(VRC7_T).concat(PULSE_T);
  const NOISE_T = ['noise'];
  // サンプルPCM(VGMのC140/C352/QSound/OKIM6295/SegaPCM/MultiPCM/GA20/ADPCM)。ピッチ解析で
  // 音階が取れた時点で「音程と音量を持つ普通の旋律ch」なので、載せ先は矩形波系も含めて brr(SPCボイス)
  // と同じ全部にする。★2026-09-10まで pulse1/pulse2/triangle だけに絞っており、VRC6・FME-7・MMC5が
  //   選べなかった(ユーザー報告「QSoundのPCMでVRC6/FME7/MMC5が選べない」)。絞る理由はコメントにも
  //   変換器側にも無く、実測でも QSound ch→VRC6 は音符1097個がそのまま出てコンパイルも通る。
  const PCM_T = ['dpcm'].concat(SQUARE_T);
  // ★FDSは波形メモリchなので、音程を持つ元chならどの種別からでも選べてよい。
  //   以前は 'wave'/'any' にしか入れておらず、FM/PCM/矩形波の行で F: が出なかった
  //   (ユーザー報告「変換先にF:のFDSがない」)。ノイズだけは対象外。
  // ★'dpcm'(E)は全種別で選べる(2026-09-03、ドラムパッド全形式展開): サンプルPCM以外の行で
  //   E を選ぶと「このchは打楽器」の手動判定になり、他chをミュートして分離レンダリングした
  //   音がドラムパッド(1音高=1パッド)になって @DPCM へ焼かれる(main.js synthDrum参照)。
  //   GBのノイズやPSGのドラム音をDPCM化する道がこれ。
  // ★'brr'(SPCボイス)はサンプルを持つのでPCM系だが、ノイズ(NON)でも鳴るので 'noise'(D)も選べる
  //   (2026-09-04。ユーザー報告「SPCのノイズパートに2A03のノイズが選べない」。spc2mml側は
  //   type 'noise' + ev.non を既に処理できる: src/spc2mml/converter.js spcNoiseNoteNum)
  const KIND_TARGETS = {
    square: ['fds', 'dpcm'].concat(SQUARE_T), wave: ['dpcm'].concat(WAVE_T), noise: ['dpcm'].concat(NOISE_T),
    fm: ['fds', 'dpcm'].concat(VRC7_T, SQUARE_T.filter(function (t) { return VRC7_T.indexOf(t) < 0; })),
    fm4: ['fds', 'dpcm'].concat(VRC7_T, SQUARE_T.filter(function (t) { return VRC7_T.indexOf(t) < 0; })),
    pcm: ['fds'].concat(PCM_T),
    brr: ['fds', 'dpcm', 'noise'].concat(SQUARE_T),
    any: ['fds', 'dpcm'].concat(SQUARE_T),
    // 音程を持たない D/A(KSS 牌の魔術師の KDA)。打楽器化(E=実音のまま DPCM / D=ノイズ)だけが意味を持つ。
    // 打点は分離レンダリングでなく書込みログから取る(main.js kssDacDrumFor)
    dac: ['dpcm', 'noise'],
  };
  // 「E(DPCM)へ載せた合成音ch」か(=他chをミュートして分離レンダリングし、打楽器化する対象)。
  // ★判定は「実サンプル表を持つ行か」であって kind の網羅ではない(2026-09-04修正)。
  //   以前は kind 'pcm'/'any' を除外していたが、'any' は **CH_KIND表に載っていない行の既定値**
  //   でもあるため、実サンプルを持たない行まで巻き添えで除外されていた:
  //     VGM  … YM2612 DAC(YMDA) / 32X PWM(PWL,PWR) / RF5C164・68(RC*,RB*) / OKIM6258(OKI)
  //     NSF  … MMC5 PCM(M5PC)
  //   メガドライブ曲のドラムはDAC(YMDA)に載っていることが多く、Eを選んでも何も起きなかった
  //   (ユーザー報告「アウトランでDPCMを選んでもパッドに出てこない」)。
  //   実サンプルを持つのは VGMのPCMチップ(kind 'pcm')/ SPCボイス(kind 'brr')/ NSFのDM行だけ。
  // ★旋律ch(矩形波/波形/FM/PCM)も D(2A03ノイズ)へ載せられる(2026-09-05、ユーザー要望「FMでノイズを
  //   鳴らしているパートに2A03ノイズを割り当てたい」)。音程はノイズ周期へ写す(noiseIndexFor、
  //   借用先の音色選択 'noisePeriod' で自動/固定を選ぶ)。逆(ノイズ→旋律)は従来どおり不可。
  for (const k of ['square', 'wave', 'fm', 'fm4', 'pcm', 'any']) if (KIND_TARGETS[k].indexOf('noise') < 0) KIND_TARGETS[k].push('noise');
  const SAMPLE_KINDS = { pcm: true, brr: true };
  // ★2026-09-18: 旋律chの D(2A03ノイズ)も打楽器化(分離レンダリング→1音高=1パッド)の対象にする。
  //   入口を1つにするため(ユーザー指示「あれ?どっち?とならないように」): E と同じくパッドに並び、
  //   パッドの載せ先は既定で「割当どおり(ノイズ)」、音色は既定「音程から自動」(=従来の pitchedToNoise と
  //   同じ出力)で、パッドごとにプリセットへ差し替えたり DPCM へ回したりできる(src/convert/drumHits.js noise())。
  //   元がノイズ系の行(GB CH4/AYノイズ等)は周期をそのまま写すだけなので対象外
  function isSynthDrumTarget(chId, target) {
    if ((target !== 'dpcm' && target !== 'noise') || !chId) return false;
    if (chId === 'DM') return false;
    const kind = channelKind(chId);
    if (target === 'noise' && kind === 'noise') return false;
    return !SAMPLE_KINDS[kind];
  }
  // 借用先の並びはチャンネル文字のアルファベット順(A-Z → a,b)。ラベルが「P: N163 ch1」と
  // 文字始まりなので、そのまま読める順になる。localeCompareは環境によっては 'a' < 'B' と
  // 判定するため、実機ppmckの文字順(大文字A-Zのあとに小文字a,b)になるコードポイント比較にする。
  function sortByLetter(list) {
    return list.slice().sort(function (a, b) {
      const la = letterOfTarget(a), lb = letterOfTarget(b);
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  }
  function targetsForKind(kind) {
    return ['skip'].concat(sortByLetter(KIND_TARGETS[kind] || KIND_TARGETS.any));
  }

  // ── 借用先ごとの音色選択(選んだときだけ出す) ────────────────────
  //   duty4 … 2A03/MMC5パルスのデューティ(既定@2=50%)
  //   duty8 … VRC6パルスのデューティ(既定@7=8/16=50%)
  //   wave  … FDS/N163の波形(既定copy=元の波形/サンプル1周期をコピー)
  //   vrc7  … VRC7音色(@0自作=元から変換/@1-15プリセット)
  // フォーマットごとに変換器が実際に受け取れる指定。UIに「効かない選択肢」を出さないための表。
  //   tone   : true=全借用先で音色を選べる / 'vrc7'=VRC7を選んだときだけ
  //   volPct : 変換音量(channelMap[ch].volPct)を受けるか
  const CAPS = {
    spc: { tone: true, volPct: true },
    vgm: { tone: true, volPct: false }, // 2026-09-05: デューティ/波形も vgm2mml adaptEvents が受けるようになった
    kss: { tone: true, volPct: false },
    gbs: { tone: true, volPct: false },
    hes: { tone: true, volPct: false },
    psf: { tone: true, volPct: false }, // PSF は vgm2mml の PCM チップ経路で変換する(src/psf2mml/converter.js)
    // NSFはネイティブ変換で音色は元のまま(同じ音源内の移動しかできないため指定の余地が無い)
    nsf: { tone: false, volPct: false },
  };
  function capsOf(fmt) { return CAPS[fmt || curFormat] || { tone: false, volPct: false }; }

  // 借用先タイプ → 音色指定の種別(形式に依らない対応。変換器と音色ごとの設定 toneSettings.js が使う)
  //   ノイズ(D)は音色選択を出さない(2026-09-18): 旋律chをノイズへ載せた分は打楽器化されてドラム(DPCM)パネルの
  //   パッドになり、周期/音色はパッド側(音程から自動 or プリセット)で決めるため。'noisePeriod' の値自体は
  //   変換器(borrow.js pitchedToNoise 等)が読めるまま残す(以前の音色ごとの保存値を壊さない)
  function toneKindOfTarget(type, srcKind) {
    if (type === 'noise') return null;
    if (/^(pulse1|pulse2|mmc5pulse1|mmc5pulse2)$/.test(type)) return 'duty4';
    if (/^vrc6pulse/.test(type)) return 'duty8';
    if (type === 'fds' || /^n163_/.test(type)) return 'wave';
    if (/^vrc7_/.test(type)) return 'vrc7';
    return null; // triangle/dpcm/vrc6saw/fme7/skip: 音色選択なし
  }
  // srcKind(省略可): 元chの種別。ノイズ借用先の周期選択は旋律chから載せるときだけ出す
  function toneKindFor(type, fmt, srcKind) {
    const cap = capsOf(fmt).tone;
    if (!cap) return null;
    // ★DPCMのDMCレートは「チャンネル単位」ではなく「サンプル単位」で持つ(2026-08-29)。
    //   @DPCM<n>定義は元々サンプルごとにfreqを持てるうえ、プール式チップは同じ太鼓が
    //   毎回別スロットへ移るのでch単位だと指定が飛ぶ。設定はドラム一覧パネル側
    //   (src/convert/drumSamples.js)。ここでは音色セレクトを出さない。
    if (cap === 'vrc7') return /^vrc7_/.test(type) ? 'vrc7' : null;
    return toneKindOfTarget(type, srcKind);
  }
  // 音色セレクトに足す「音色ごとに指定…」の項目値(選ぶと音色一覧パネルが開く。値としては保存しない)
  const TONE_PER_INSTRUMENT = '__perTone';
  // 変換音量スライダー(volPct)を出す借用先か。音量を出力できない先(skip/DPCM/三角波)と、
  // volPctを受け取らないフォーマットには出さない(src/convert/options.js channelVolScale 参照)
  function hasVolSliderFor(type, fmt) {
    if (!capsOf(fmt).volPct) return false;
    return type !== 'skip' && type !== 'dpcm' && type !== 'triangle';
  }
  function toneOptionsFor(kind, srcKind) {
    if (kind === 'duty4') {
      return { def: '2', opts: [['0', '@0 12.5%'], ['1', '@1 25%'], ['2', '@2 50%'], ['3', '@3 75%']] };
    }
    if (kind === 'duty8') {
      return { def: '7', opts: Array.from({ length: 8 }, function (_, i) { return [String(i), '@' + i + ' ' + ((i + 1) * 6.25) + '%']; }) };
    }
    if (kind === 'wave') {
      return { def: 'copy', opts: [
        ['copy', T('元の波形をコピー')], ['pulse50', T('矩形波50%')],
        ['sin', T('サイン波')], ['triangle', T('三角波')], ['saw', T('ノコギリ波')]] };
    }
    if (kind === 'noisePeriod') {
      // 2A03ノイズの周期index(0=最も明るい/447kHz … 15=最も暗い/440Hz)。'auto'は音程から最寄りのレート
      const opts = [['auto', T('ノイズ周期: 音程から自動')]];
      for (let i = 0; i < 16; i++) {
        const rate = 1789773 / NOISE_PERIODS[i];
        const label = rate >= 1000 ? Math.round(rate / 1000) + 'kHz' : Math.round(rate) + 'Hz';
        opts.push([String(i), T('周期 {n}', { n: i }) + ' (' + label + ')']);
      }
      return { def: 'auto', opts: opts };
    }
    // vrc7: 元がFM(OPLL)なら「元の音色」、OPN系4opなら@0(4op→2op自動変換)が既定
    const names = (MML.VGM2MML && MML.VGM2MML.VRC7_PRESET_NAMES) || [];
    const opts = [];
    if (srcKind === 'fm') opts.push(['auto', T('元の音色')]);
    // ★「同時1音色まで」: 実機VRC7の自作音色スロットは$00-$07の1組だけで全ch共有のため、
    //   重なったぶんは変換側でいちばん近い内蔵音色へ落ちる(src/convert/vrc7Tone.js)
    opts.push(['0', srcKind === 'fm4'
      ? T('@0 自作音色(4op→2op自動変換、同時1音色まで)')
      : T('@0 自作音色(元の音から変換、同時1音色まで)')]);
    for (let i = 1; i <= 15; i++) opts.push([String(i), ('@' + i + ' ' + (names[i] || '')).trim()]);
    return { def: srcKind === 'fm' ? 'auto' : srcKind === 'fm4' ? '0' : '1', opts: opts };
  }

  // ── 旋律 → 2A03ノイズの周期 ─────────────────────────────────────
  // 2A03ノイズの周期表(apu2a03.js と同じ)。シフトレート = CPU/周期。
  const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  // 基音 freq[Hz]×mul(FMキャリアの倍率。不明なら1)をノイズのシフトレートとみなし、最寄りの周期indexを返す。
  // レート表は idx15=440Hz から idx0=447kHz までほぼ10オクターブ/15段(1.5段/oct)なので、
  // 「1オクターブ上がると1.5段明るくなる」単調な対応になる(spc2mmlのspcNoiseNoteNumと同じ発想)。
  function noiseIndexForFreq(freq, mul) {
    const f = (freq || 0) * (mul || 1);
    if (!(f > 0)) return 15;
    return Math.max(0, Math.min(15, 15 - Math.round(1.5 * Math.log2(f / 440))));
  }
  // tone('auto'|未指定|'0'-'15') に従って周期indexを決める(変換とプレビューで共用)
  function noiseIndexFor(tone, freq, mul) {
    const n = parseInt(tone, 10);
    if (isFinite(n) && n >= 0 && n <= 15) return n;
    return noiseIndexForFreq(freq, mul);
  }

  // ── 元ch(鍵盤表示のch.id)の種別と、変換器側のソースID ──────────────
  // 鍵盤表示の行IDは extractChannels() が付けるフォーマット固有の文字列。変換器が使う
  // ソースID(VGMの 'ay:0' 等)とは体系が違うので、ここで橋渡しする。
  // 各要素は [正規表現, m => [kind, vgmSourceId]](vgmSourceIdはVGM変換時のみ意味を持つ)
  const CH_KIND = [
    [/^V[0-7]$/, function () { return ['brr', null]; }],                                    // SPC ボイス(BRRサンプル)
    [/^KP([1-6])$/, function (m) { return ['square', (+m[1] <= 3 ? 'ay:' + (+m[1] - 1) : 'ay2:' + (+m[1] - 4))]; }], // AY8910 / 内蔵SSG(KP4-6=2個目のチップ)
    [/^KS([1-5])$/, function (m) { return ['wave', 'scc:' + (+m[1] - 1)]; }],               // SCC
    [/^KF([1-9])$/, function (m) { return ['fm', 'opll:' + (+m[1] - 1)]; }],                // YM2413 / FMPAC メロディ
    [/^KF(BD|SD|TOM|CYM|HH)$/, function () { return ['fm', null]; }],                       // OPLLリズム(割当対象外)
    [/^OL([1-9])$/, function (m) { return ['fm', 'opl:' + (+m[1] - 1)]; }],                 // OPL系(YM3812/YM3526/Y8950/MSX-AUDIO)
    [/^OL(BD|SD|TM|CY|HH|B)$/, function () { return ['fm', null]; }],                       // OPLリズム/ADPCM(割当対象外)
    [/^YM([1-6])$/, function (m) { return ['fm4', 'opn:' + (+m[1] - 1)]; }],                // YM2612
    [/^OM([1-8])$/, function (m) { return ['fm4', 'opm:' + (+m[1] - 1)]; }],                // YM2151
    [/^OP([1-6])$/, function (m) { return ['fm4', 'opn3:' + (+m[1] - 1)]; }],               // YM2203 FM(OP4-6=デュアル2個目のFM1-3。2026-09-06から変換対象)
    [/^OA([1-6])$/, function (m) { return ['fm4', 'opna:' + (+m[1] - 1)]; }],               // YM2608 FM
    [/^OAB$/, function () { return ['pcm', 'pcmb8:0']; }],                                  // YM2608 ADPCM-B
    [/^OA(BD|SD|CY|HH|TM|RM)$/, function () { return ['pcm', null]; }],                     // YM2608 リズム(ドラムパートのみ・割当対象外)
    [/^NF([1-6])$/, function (m) { return ['fm4', 'opnb:' + (+m[1] - 1)]; }],               // YM2610 FM
    [/^NA([1-6])$/, function (m) { return ['pcm', 'pcma:' + (+m[1] - 1)]; }],               // YM2610 ADPCM-A
    [/^NB$/, function () { return ['pcm', 'pcmb:0']; }],                                    // YM2610 ADPCM-B
    [/^GA([1-4])$/, function (m) { return ['pcm', 'ga20:' + (+m[1] - 1)]; }],               // GA20
    [/^K7([1-2])$/, function (m) { return ['pcm', 'k7:' + (+m[1] - 1)]; }],                 // K007232
    [/^K5(\d+)$/, function (m) { const i = +m[1]; return (i >= 1 && i <= 16) ? ['pcm', 'k5:' + (i - 1)] : null; }], // K054539(デュアルはK59-K516)
    [/^SP(\d+)$/, function (m) { return ['pcm', 'spcm:' + (+m[1] - 1)]; }],                 // SegaPCM
    [/^CN(\d+)$/, function (m) { return ['pcm', 'c140:' + (+m[1] - 1)]; }],                 // C140
    [/^CS(\d+)$/, function (m) { return ['pcm', 'c352:' + (+m[1] - 1)]; }],                 // C352
    [/^QS(\d+)$/, function (m) { return ['pcm', 'qs:' + (+m[1] - 1)]; }],                   // QSound
    [/^OK([1-4])$/, function (m) { return ['pcm', 'oki:' + (+m[1] - 1)]; }],                // OKIM6295('OKI'=6258は不一致)
    [/^MP(\d+)$/, function (m) { return ['pcm', 'mp:' + (+m[1] - 1)]; }],                   // MultiPCM
    [/^PX(\d+)$/, function (m) { return ['pcm', 'psx:' + (+m[1] - 1)]; }],                  // PSF(実機スロット=ボイス0-23 / 合成ch=32本 / トラック=レーン番号)
    [/^SN([1-6])$/, function (m) { return ['square', 'sn' + (+m[1] > 3 ? 1 : 0) + ':' + ((+m[1] - 1) % 3)]; }], // SN76489
    [/^SNN(2?)$/, function (m) { return ['noise', 'sn' + (m[1] ? 1 : 0) + ':noise']; }],
    [/^GB[12]$/, function () { return ['square', null]; }],                                 // GB パルス
    [/^GW$/, function () { return ['wave', null]; }],                                       // GB 波形
    [/^GN$/, function () { return ['noise', null]; }],                                      // GB ノイズ
    [/^PSG[0-5]$/, function () { return ['wave', null]; }],                                 // HuC6280 PSG
    [/^KDA$/, function () { return ['dac', null]; }],                                       // KSS 牌の魔術師の 8bit D/A
  ];
  function lookupCh(chId) {
    for (const pair of CH_KIND) { const m = pair[0].exec(chId); if (m) return pair[1](m); }
    return ['any', null];
  }
  function channelKind(chId) { return lookupCh(chId)[0]; }
  // 割当対象外の行(OPLL/OPL/YM2608のリズム・ADPCM)。part列に文字が無い行のうち「変換器が別経路で扱う」もの。
  // 割当プレビュー(「割当先の音で聴く」)ではスキップ扱いにせず元の音のまま鳴らす
  const UNASSIGNABLE_RE = /^(KF(BD|SD|TOM|CYM|HH)|OL(BD|SD|TM|CY|HH|B)|OA(BD|SD|CY|HH|TM|RM))$/;
  function isUnassignable(chId) { return UNASSIGNABLE_RE.test(chId || ''); }
  function vgmSourceId(chId) { return lookupCh(chId)[1]; }

  // 逆引き: 変換器のソースID(VGM) → 鍵盤表示の行ID。VGMの構成駆動の既定割当
  // (MML.VGM2MML.defaultPlan)を鍵盤の行へ移すのに使う。
  const VGM_SRC_TO_CH = { ay: 'KP', scc: 'KS', opll: 'KF', opn: 'YM', opm: 'OM', opn3: 'OP', opna: 'OA', opnb: 'NF', opl: 'OL', pcma: 'NA', ga20: 'GA', k7: 'K7', k5: 'K5', spcm: 'SP', c140: 'CN', c352: 'CS', qs: 'QS', oki: 'OK', mp: 'MP', psx: 'PX' };
  function chIdForVgmSource(srcId) {
    const m = /^([a-z0-9]+):(.+)$/.exec(srcId || '');
    if (!m) return null;
    const kind = m[1], rest = m[2];
    if (kind === 'pcmb') return 'NB';
    if (kind === 'pcmb8') return 'OAB'; // YM2608 ADPCM-B
    if (kind === 'ay2') return /^\d+$/.test(rest) ? 'KP' + (+rest + 4) : null; // 2個目のPSG → KP4-6
    if (/^sn[01]$/.test(kind)) {
      const chip = kind === 'sn1' ? 1 : 0;
      if (rest === 'noise') return chip ? 'SNN2' : 'SNN';
      return 'SN' + (chip * 3 + (+rest) + 1);
    }
    // ドラムパート(`c140:drum` 等)は実機スロットではない合成チャンネルなので、対応する
    // 鍵盤表示の行が無い。null を返して「割当UIからは触れない」ことを明示する
    // (弾かないと prefix+NaN という存在しない行IDになる)
    if (!/^\d+$/.test(rest)) return null;
    const prefix = VGM_SRC_TO_CH[kind];
    return prefix ? prefix + (+rest + 1) : null;
  }

  // 割当を変更できるフォーマット(変換器が options.channelMap を受けるもの)。全形式対応済み。
  const EDITABLE = { spc: true, vgm: true, kss: true, gbs: true, hes: true, nsf: true, psf: true };
  const NOT_EDITABLE_REASON = function () { return {}; };

  // NSFだけは「借用」ではなくネイティブ変換なので、選べるのは同じ音源ファミリの別チャンネル
  // (2A03パルス↔MMC5パルスは周期式・音量尺度が同一なので同じファミリ扱い)とスキップだけ。
  // 他チップへ移すには抽出前に借用先を決める必要がある(src/nsf2mml/converter.js
  // applyNsfChannelMap 冒頭コメント参照)。
  function sameFamilyTargets(defaultTarget) {
    const fam = targetInfo(defaultTarget).family;
    if (!fam) return [];
    const out = [];
    for (const t of Object.keys(TARGETS)) {
      if (t !== 'skip' && TARGETS[t].family === fam) out.push(t);
    }
    return out;
  }
  /**
   * その行で選べる借用先。
   * @param {string} chId    鍵盤表示の行ID
   * @param {string} defTgt  その行の既定の借用先
   * @param {string[]} [avail] NSF等で「この曲に実在するチャンネル」に限りたいときの許可リスト
   */
  function targetsForChannel(chId, defTgt, avail) {
    if (curFormat !== 'nsf') return targetsForKind(channelKind(chId));
    // N163だけは曲ごとに有効ch数が変わり、枠を増やすと周波数式(numCh)が変わってしまうので
    // 実在する枠だけに絞る。他のチップ(VRC7=6/VRC6=3/FME-7=3)はch数が固定、MMC5パルスは
    // 2A03パルスと周期式・音量尺度が同一なので、曲で未使用でも移動先として出してよい。
    const list = sameFamilyTargets(defTgt).filter(t =>
      TARGETS[t].chip !== 'n163' || !avail || !avail.length || avail.indexOf(t) >= 0 || t === defTgt);
    // 打楽器化(E=DPCMへ分離レンダリング)はNSFでも全行で選べる(KIND_TARGETS のコメント参照)
    if (list.indexOf('dpcm') < 0 && chId !== 'DM') list.push('dpcm');
    return ['skip'].concat(sortByLetter(list));
  }

  // ── 現在の割当計画(ユーザーが既定から変更した分だけを持つ) ──────────
  let curFormat = null;
  const entries = new Map(); // chId → { target, tone, volPct }
  const defaults = new Map(); // chId → target(既定。setDefaults()で外から与える)
  const listeners = [];

  // ── ファイルごとの自動保存(2026-09-18、ユーザー指示「CH別割り当てモードの割り当て一覧は自動保存」) ──
  // newFile() に渡された fileKey(形式+ファイル名)をキーに、ユーザーが既定から変えた分(entries)を
  // localStorage へ保存し、同じファイルを開き直したときに読み戻す。既定(defaults)は保存しない
  // (形式側が毎回計算する)。古いものから捨てて上限件数を守る
  const SAVE_KEY = 'channelPlanByFile';
  const SAVE_MAX = 300;
  let curFileKey = null;
  function loadSaved() {
    try { return JSON.parse(global.localStorage.getItem(SAVE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function persist() {
    if (!curFileKey) return;
    const all = loadSaved();
    if (entries.size) {
      const o = {};
      for (const kv of entries) o[kv[0]] = Object.assign({}, kv[1]);
      all[curFileKey] = { t: Date.now(), entries: o };
      const keys = Object.keys(all);
      if (keys.length > SAVE_MAX) {
        keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
        for (const k of keys.slice(0, keys.length - SAVE_MAX)) delete all[k];
      }
    } else {
      delete all[curFileKey];
    }
    try { global.localStorage.setItem(SAVE_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }
  function restore(fileKey) {
    const saved = fileKey ? loadSaved()[fileKey] : null;
    if (!saved || !saved.entries) return;
    for (const chId of Object.keys(saved.entries)) {
      const ent = saved.entries[chId];
      if (ent && typeof ent === 'object' && Object.keys(ent).length) entries.set(chId, Object.assign({}, ent));
    }
  }

  // info: set() からは { chId, patch }(どの行の何が変わったか)。newFile/clear 等の一括操作は undefined
  function notify(info) {
    // UI側の失敗で変換は止めないが、黙って握り潰すとバグが見えないのでログには出す
    for (const fn of listeners) { try { fn(info); } catch (e) { console.error('[ChannelPlan] onChange listener failed:', e); } }
  }

  const Plan = {
    TARGETS: TARGETS,
    targetInfo: targetInfo,
    targetLabel: targetLabel,
    targetsForKind: targetsForKind,
    targetsForChannel: targetsForChannel,
    letterOfTarget: letterOfTarget,
    targetOfLetter: targetOfLetter,
    toneKindFor: toneKindFor,
    toneKindOfTarget: toneKindOfTarget,
    TONE_PER_INSTRUMENT: TONE_PER_INSTRUMENT,
    toneOptionsFor: toneOptionsFor,
    noiseIndexForFreq: noiseIndexForFreq,
    noiseIndexFor: noiseIndexFor,
    hasVolSliderFor: hasVolSliderFor,
    channelKind: channelKind,
    isUnassignable: isUnassignable,
    vgmSourceId: vgmSourceId,
    colorOfTarget: colorOfTarget,
    chIdForVgmSource: chIdForVgmSource,
    isSynthDrumTarget: isSynthDrumTarget,

    // 今どの形式を表示/再生しているか(setKbdSource経由。何度呼ばれても割当は消さない)
    setFormat: function (fmt) {
      if (curFormat === fmt) return;
      curFormat = fmt;
      defaults.clear();
      if (entries.size) entries.clear();
      notify();
    },
    // 新しいファイルを開いたとき(main.jsの各loadXxxFile)に呼ぶ。ユーザー指定は捨てる
    // (前の曲の割当が次の曲へ持ち越されないように)。defaultsMap はフォーマット固有の
    // 既定割当(chId → target)で、SPCの固定既定やVGMの構成駆動既定
    // (MML.VGM2MML.defaultPlan)のようにパート文字から逆引きできないものを外から渡す。
    // fileKey(省略可): ファイルの同定(形式+ファイル名)。渡すと、そのファイル用に保存してある割当を読み戻し、
    // 以後の変更をそのキーで自動保存する(上の SAVE_KEY 参照)
    newFile: function (fmt, defaultsMap, fileKey) {
      curFormat = fmt;
      entries.clear();
      defaults.clear();
      for (const k of Object.keys(defaultsMap || {})) defaults.set(k, defaultsMap[k]);
      curFileKey = fileKey ? (fmt + ':' + fileKey) : null;
      restore(curFileKey);
      notify();
    },
    // 既定の割当だけを差し替える(ユーザーが変えた分は残す)。PSF のトラックモードのように、曲を最後まで
    // 取り込んでから既定が決まる形式が使う(main.js psfRefreshTrackPlan)
    setDefaults: function (defaultsMap) {
      defaults.clear();
      for (const k of Object.keys(defaultsMap || {})) defaults.set(k, defaultsMap[k]);
      notify();
    },
    // 既定の借用先。setDefaults()で与えられていればそれ、無ければ呼び出し側が
    // パート文字から逆引きした値(fallback)を使う。
    defaultTarget: function (chId, fallback) {
      const d = defaults.get(chId);
      return d !== undefined ? d : fallback;
    },
    format: function () { return curFormat; },
    editable: function (fmt) { return !!EDITABLE[fmt || curFormat]; },
    lockReason: function (fmt) { return NOT_EDITABLE_REASON()[fmt || curFormat] || ''; },

    get: function (chId) { return entries.get(chId) || null; },
    // patch: { target?, tone?, volPct? }。既定へ戻すキーには null を渡す
    set: function (chId, patch) {
      const cur = Object.assign({}, entries.get(chId) || {}, patch);
      for (const k of Object.keys(cur)) if (cur[k] === null || cur[k] === undefined) delete cur[k];
      if (Object.keys(cur).length) entries.set(chId, cur); else entries.delete(chId);
      persist();
      notify({ chId, patch });
    },
    clearChannel: function (chId) { if (entries.delete(chId)) { persist(); notify(); } },
    // 全部を既定へ戻す(鍵盤見出しの「割り当てリセット」ボタン)。保存分も消える
    clear: function () { if (entries.size) { entries.clear(); persist(); notify(); } },
    fileKey: function () { return curFileKey; },
    isCustom: function () { return entries.size > 0; },
    all: function () {
      const o = {};
      for (const kv of entries) o[kv[0]] = Object.assign({}, kv[1]);
      return o;
    },
    // chId → 実際に効いている借用先(ユーザー指定が無ければ setDefaults/newFile で与えた既定)。
    // ★all() は「既定から変えた分」しか返さないので、既定で E(DPCM) の行(VGMのDAC等)を
    //   拾うにはこちらを使う(2026-09-04)。
    effectiveTargets: function () {
      const o = {};
      for (const kv of defaults) o[kv[0]] = kv[1];
      for (const kv of entries) if (kv[1].target) o[kv[0]] = kv[1].target;
      return o;
    },
    // fn(info): info は set() 経由なら { chId, patch }、一括操作(newFile/clear)なら undefined
    onChange: function (fn) { listeners.push(fn); },
  };

  MML.Convert.ChannelPlan = Plan;
})(typeof window !== 'undefined' ? window : globalThis);
