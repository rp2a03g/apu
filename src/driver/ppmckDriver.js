/*
 * MML.NSF.MckBytecode が生成するバイトコードを再生する6502サウンドドライバ+
 * NSFバンク切り替え対応の書き出し一式。ROADMAP.mdフェーズ1.6タスク2/3/5/6。
 * 実機ppmck(nes_include/ppmck/{sounddrv,internal}.h、https://github.com/munshkr/ppmck)の
 * 設計(状態を1フレームごとにカウンタで管理し、カウンタが0になったらデータを
 * 読み進める。バンク切り替えはチャンネルごとに「現在のバンク番号」を持ち、
 * データ読み出し直前に$5FF8へ反映する)を土台にしているが、コード自体は
 * このプロジェクトの独自アセンブラ(src/asm/assembler.js。マクロ・.include・
 * 条件アセンブル・ラベルへの定数代入(`LABEL = 値`)なし)向けに新規に書き起こした
 * もの(1ファイルで完結させる必要があるため)。
 *
 * 対応範囲(現時点): 2A03のパルス1/パルス2/三角波/ノイズ(A-D)、および拡張音源全種
 * (VRC6・MMC5・FME7・FDS・N163・VRC7)。ただしFDS/N163は波形メモリとして常に
 * デフォルト波形(fdsDefaultWave/n163DefaultWave相当)を使う(`@FM`/`@N`によるMML側の
 * カスタム波形定義はNSF書き出しには未反映)。VRC7はROMプリセット音色(1-15)のみ対応
 * (`OP<n>`によるカスタム音色0番のロードは未反映、常にプリセットのみ)。
 * ループ命令(0xA0/0xA1)・EN(0xF7、ノートエンベロープ=アルペジオ)は引き続き未対応
 * (オペコードを読み飛ばすだけ)。
 * FME7のノイズ(0xF1=N<n>)と@<n>によるミキサー制御(0=ミュート/1=トーン/2=ノイズ/
 * 3=トーン+ノイズ、@2はノート番号がノイズ周期)、およびハードウェアエンベロープ
 * (0xF2=S<n>/M<n>)は2026-07-28に実装(FME7_PREP/FME7_WRITE_VOL参照)。
 * デチューン(0xFA、D<n>)は2026-07-24実装(APPLY_DETUNE/APPLY_DETUNE_N163参照)。
 * ピッチエンベロープ(0xF8、EP<n>)・ソフトウェアビブラート(0xFB、MP<n>)は2026-08-11実装
 * (EP_LOOKUP/LFO_SUB/WRITE_FREQ_ONLY参照)。D<n>と全く同じ「発音周波数レジスタへの
 * 生オフセット加算」空間をAPPLY_DETUNE/APPLY_DETUNE_N163内で合算する。
 * D<n>/EP<n>/MP<n>いずれも2A03パルス/三角・VRC6・MMC5・FME7・FDS・N163に対応、
 * VRC7・ノイズは対象外(compiler.js側のブラウザ再生と同じ対応範囲、DESIGN-PITCH.md §7)。
 *
 * --- データ埋め込みは実際に使うチップの分だけ ---
 * 各拡張チップの周波数テーブル・波形データ・レジスタ書き込みハンドラは、
 * そのチップが `opt.expansions` で実際に選択されているときだけソースへ埋め込む。
 * 2A03のみの曲であれば、VRC6/MMC5/FME7/FDS/N163/VRC7関連のコード・データは
 * 一切含まれない(以前の版はVRC6/FME7のテーブルを常時埋め込んでいたが、
 * 無駄なので選択式に修正した)。
 *
 * --- NSFバンク切り替えのメモリレイアウト ---
 * $5FF8-$5FFF の8レジスタで$8000-$FFFFを4KB単位8窓に分割してバンク切り替えする
 * (標準的なNSFバンクスイッチ方式。src/emulator/nsfBus.jsの実装と対応)。
 *   窓0 ($8000-$8FFF, $5FF8) : 曲データ専用の切り替え窓。バンク8以降を動的にマップする
 *   窓1-7($9000-$FFFF, $5FF9-$5FFF) : ドライバ本体(コード+テーブル類)を固定配置(バンク1-7固定)
 *   バンク0                          : 未使用(窓0の初期値。使用前に必ず上書きされる)
 *   バンク8以降                      : 各チャンネルのバイトコード。1チャンネルが4096バイトを
 *                                       超える場合は複数バンクにまたがり、コマンド境界を
 *                                       跨がない位置で0xEE(バンクジャンプ)を挿入してつなぐ
 *
 * 0xEE(バンクジャンプ)は [0xEE, 新バンク番号, 新アドレス下位, 新アドレス上位] の4バイト。
 * 新バンクは常に$8000から始まるチャンクとして生成するため、新アドレスは常に$00,$80。
 *
 * --- チャンネル数可変対応 ---
 * 2A03固定4ch + 選択された拡張音源のchが並ぶ(MML.Mml.compile()の channelLetters と
 * 同じ順序・同じ数)。ゼロページの各配列(CNT/VOL/DUTY/NOTE/PTRLO/PTRHI/BANK/CHTYPE)は
 * チャンネル数Nぶん確保し、続く固定スクラッチ領域(CURPTR/CHIDX/PERIOD/JMPPTR)は
 * 8*N番地から始まる(全てzp()ヘルパーで動的に計算しコードへ埋め込む)。
 * CHTYPEは各チャンネルの音源種別(下記TYPE_*)を示し、WRITE_FREQ_VOL/SILENCE_CHは
 * この値をもとにジャンプテーブル(WFV_JUMPTABLE/SIL_JUMPTABLE)経由で該当ハンドラへ
 * 間接ジャンプする(チャンネル数に応じて分岐チェーンが伸びて範囲外エラーになるのを防ぐため)。
 * 未使用チップの種別スロットは、そのチップ用の実ハンドラを埋め込まない代わりに
 * 共有の無音スタブ(TYPE_UNIMPLEMENTED)を指す。
 *
 * 音程テーブルは9オクターブ分(0-107)。これを超える音程は範囲内に丸める。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Driver = MML.Driver = MML.Driver || {};

  const CPU_CLOCK_NTSC = 1789773;
  const NOTE_TABLE_SIZE = 108; // 9オクターブ分(o0-o8相当)
  const TABLE_MAX = NOTE_TABLE_SIZE - 1;
  const BANK_SIZE = 4096;
  const DATA_START_BANK = 8; // 曲データの開始バンク(0=未使用, 1-3=ドライバ本体固定, 4-7=DPCM専用)
  // ドライバ本体の割当上限(バンク0-3=$8000-$BFFF、16384バイト)。DPCM使用時は
  // バンク4-7($C000-$FFFF)が実機DMCハードウェアの読み出し範囲としてサンプル専用になるため、
  // ドライバ本体はここに収める必要がある(超過時はbuildBankedNsfBytesがエラーを返す)
  const DRIVER_CODE_LIMIT = 4 * BANK_SIZE;
  const N163_WAVE_LEN = 16;
  const N163_CHANNEL_COUNT = 8;

  // チャンネル種別ID(WFV_JUMPTABLE/SIL_JUMPTABLEのインデックスと対応)
  const TYPE_2A03_PULSE_A = 0;
  const TYPE_2A03_PULSE_B = 1;
  const TYPE_2A03_TRI = 2;
  const TYPE_2A03_NOISE = 3;
  const TYPE_VRC6_PULSE1 = 4;
  const TYPE_VRC6_PULSE2 = 5;
  const TYPE_VRC6_SAW = 6;
  const TYPE_MMC5_PULSE1 = 7;
  const TYPE_MMC5_PULSE2 = 8;
  const TYPE_FME7_CH0 = 9;
  const TYPE_FME7_CH1 = 10;
  const TYPE_FME7_CH2 = 11;
  const TYPE_UNIMPLEMENTED = 12; // 未使用チップの穴埋め・常時無音スタブ
  const TYPE_FDS = 13;
  const TYPE_N163_BASE = 14; // 14-21 (8ch)
  const TYPE_VRC7_BASE = 22; // 22-27 (6ch)
  const TYPE_DPCM = 28;
  const TYPE_COUNT = 29;

  function noteFrequency(noteNumber) {
    return 440 * Math.pow(2, (noteNumber - 57) / 12);
  }
  function pulsePeriod(freq) {
    return Math.max(0, Math.min(2047, Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1));
  }
  function trianglePeriod(freq) {
    return Math.max(0, Math.min(2047, Math.round(CPU_CLOCK_NTSC / (32 * freq)) - 1));
  }
  function sawPeriod(freq) {
    return Math.max(0, Math.min(4095, Math.round(CPU_CLOCK_NTSC / (14 * freq)) - 1));
  }
  // FME7(5B)は f=CLOCK/(32*period)。MSXのPSG(f=clock/(16*TP))とは分母が異なる
  // (NESdev "Sunsoft 5B audio")。src/mml/compiler.js の fme7Period と必ず一致させること
  function fme7Period(freq) {
    return Math.max(1, Math.min(4095, Math.round(CPU_CLOCK_NTSC / (32 * freq))));
  }
  function fdsPeriod(freq) {
    return Math.max(0, Math.min(4095, Math.round((freq * 65536 * 64) / CPU_CLOCK_NTSC)));
  }
  // 実機の出力周波数 f = CLOCK * freqReg / (15 * 65536 * waveLen * numCh) を反転。
  // 有効ch数(numCh、実行時に$7Fへ設定する値)を含めないと音程がズレる(compiler.jsと同じ式)。
  // waveLenは共有バッファアロケータ(src/mml/n163Alloc.js)が決めた実際の波形長
  // (compiler.js側と同じくインスツルメントごとに異なりうる。固定16ではない)。
  function n163FreqReg(freq, waveLen, numCh) {
    return Math.max(0, Math.min(262143, Math.round((freq * 15 * 65536 * (waveLen || N163_WAVE_LEN) * (numCh || 1)) / CPU_CLOCK_NTSC)));
  }
  function vrc7FnumBlock(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = Math.round((freq * 524288) / (49716 * Math.pow(2, block)));
      if (fnum <= 511) return { fnum: Math.max(0, fnum), block };
    }
    return { fnum: 511, block: 7 };
  }

  function buildPeriodTable(periodFn) {
    const words = [];
    for (let n = 0; n < NOTE_TABLE_SIZE; n++) words.push(periodFn(noteFrequency(n)));
    return words;
  }

  function wordsToDb(words) {
    const lines = [];
    for (let i = 0; i < words.length; i += 8) {
      const chunk = words.slice(i, i + 8).map(w => '$' + (w & 0xffff).toString(16).padStart(4, '0'));
      lines.push('    .word ' + chunk.join(','));
    }
    return lines.join('\n');
  }

  function bytesToDb(bytes) {
    if (bytes.length === 0) return '    .byte $ff';
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = Array.from(bytes.slice(i, i + 16)).map(b => '$' + b.toString(16).padStart(2, '0'));
      lines.push('    .byte ' + chunk.join(','));
    }
    return lines.join('\n');
  }

  function hex(n) {
    return '$' + (n & 0xffff).toString(16).toUpperCase();
  }

  // チャンネル1個分のバイトコードを、コマンド境界を跨がない位置で4KBバンクに分割する。
  // 収まりきらない場合は末尾に0xEE(バンクジャンプ)4バイトを追加して次バンクへつなぐ。
  // markOffset: 省略可。分割前のbytes上のバイトオフセット(MckBytecode.serialize()の
  // loopByteOffset)。指定されると、分割後にそのオフセットが実際にどのバンク・
  // アドレスへ配置されたかをmarkLocation({bank, addr})として返す(Lコマンドの
  // ループ先アドレス解決に使う。新バンクは常に$8000開始のチャンクとして生成するため、
  // addrは常にそのバンク先頭からのオフセット+$8000になる)。
  function layoutChannelBanks(bytes, startBank, markOffset) {
    const banks = [];
    const boundaries = MML.NSF.MckBytecode.commandBoundaries(bytes);
    let offset = 0;
    let bankNum = startBank;
    let markLocation = null;
    for (;;) {
      const remaining = bytes.length - offset;
      if (remaining <= BANK_SIZE) {
        banks.push({ bankNum, data: bytes.slice(offset) });
        if (markOffset != null && markLocation == null && markOffset >= offset && markOffset < bytes.length) {
          markLocation = { bank: bankNum, addr: 0x8000 + (markOffset - offset) };
        }
        bankNum += 1;
        break;
      }
      const limit = offset + BANK_SIZE - 4; // バンクジャンプ4バイト分を残す
      let splitAt = offset + 1; // 保険(通常発生しない)
      for (const b of boundaries) {
        if (b > offset && b <= limit) splitAt = b;
        else if (b > limit) break;
      }
      const chunk = bytes.slice(offset, splitAt);
      const nextBank = bankNum + 1;
      const data = new Uint8Array(chunk.length + 4);
      data.set(chunk, 0);
      data[chunk.length] = 0xee;
      data[chunk.length + 1] = nextBank & 0xff;
      data[chunk.length + 2] = 0x00;
      data[chunk.length + 3] = 0x80;
      banks.push({ bankNum, data });
      if (markOffset != null && markLocation == null && markOffset >= offset && markOffset < splitAt) {
        markLocation = { bank: bankNum, addr: 0x8000 + (markOffset - offset) };
      }
      offset = splitAt;
      bankNum = nextBank;
    }
    return { banks, startBank, nextFreeBank: bankNum, markLocation };
  }

  // channelLetters(['A','B','C','D',...拡張]) と expansions/expansionLetterMap から、
  // 各チャンネル(添字=X値)の種別IDを決定する
  function computeChannelTypes(expansions, expansionLetterMap) {
    const types = [TYPE_2A03_PULSE_A, TYPE_2A03_PULSE_B, TYPE_2A03_TRI, TYPE_2A03_NOISE];
    for (const exp of expansions || []) {
      const letters = expansionLetterMap[exp] || [];
      for (let k = 0; k < letters.length; k++) {
        let t = TYPE_UNIMPLEMENTED;
        if (exp === 'vrc6') t = [TYPE_VRC6_PULSE1, TYPE_VRC6_PULSE2, TYPE_VRC6_SAW][k];
        else if (exp === 'mmc5') t = [TYPE_MMC5_PULSE1, TYPE_MMC5_PULSE2][k];
        else if (exp === 'fme7') t = [TYPE_FME7_CH0, TYPE_FME7_CH1, TYPE_FME7_CH2][k];
        else if (exp === 'fds') t = TYPE_FDS;
        else if (exp === 'n163') t = TYPE_N163_BASE + k;
        else if (exp === 'vrc7') t = TYPE_VRC7_BASE + k;
        else if (exp === 'dpcm') t = TYPE_DPCM;
        types.push(t);
      }
    }
    return types;
  }

  // ドライバ本体(固定領域、$9000-$BFFF=バンク1-3。$C000-$FFFF=バンク4-7はDPCMサンプル専用、
  // 下記dpcmLayout参照)のアセンブリソースを組み立てる。
  // channelTypes: computeChannelTypes()の戻り値。songBank: チャンネルごとの開始バンク配列。
  // expansions: 実際に使われている拡張音源名の配列(この分だけコード・データを埋め込む)
  // envelopes: MML.Mml.compile()の戻り値のenvelopes(@FM/@N/@OPのカスタム波形・音色定義)。
  // 各チップが実際に使われ、かつ該当のカスタム定義が実際に存在する場合のみテーブル・
  // 再ロード処理を埋め込む(未使用の場合は既定波形/ROMプリセットのみの従来動作のまま)
  // dpcmLayout/dpcmSamples: MML.Mml.compile()の戻り値のdpcmLayout/dpcmSamples
  // (layoutDpcmSamples()が計算した$C000-$FFFF上のアドレス配置と、@DPCM<n>定義本体)
  // envIndexList: 曲全体で実際に使われているenvelopeV値を昇順に並べた配列(添字がROM上の
  // コンパクトなテーブル番号=mckBytecode.jsのenvIndexRemapと一致する。buildBankedNsfBytes参照)
  // songLoop: 省略可。Lコマンド(ループ地点マーカー)対応。{act,bank,lo,hi}の4配列
  // (いずれもchannelTypes.length件)。act[i]=1のチャンネルは、トラック終端到達時に
  // 無音化して止まる代わりにbank[i]/lo[i]/hi[i]が指す位置へジャンプして再生を続ける
  // (buildBankedNsfBytes参照)。省略時は全チャンネルact=0(従来通り終端で停止)
  function buildFixedSource(channelTypes, songBank, expansions, envelopes, dpcmLayout, dpcmSamples, envIndexList, songLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak) {
    envelopes = envelopes || {};
    dpcmLayout = dpcmLayout || {};
    dpcmSamples = dpcmSamples || {};
    envIndexList = envIndexList || [];
    epIndexList = epIndexList || [];
    mpIndexList = mpIndexList || [];
    usesPortamento = !!usesPortamento;
    usesPitchBreak = !!usesPitchBreak;
    const loopAct = (songLoop && songLoop.act) || channelTypes.map(() => 0);
    const loopBank = (songLoop && songLoop.bank) || channelTypes.map(() => 0);
    const loopLo = (songLoop && songLoop.lo) || channelTypes.map(() => 0);
    const loopHi = (songLoop && songLoop.hi) || channelTypes.map(() => 0);
    const n = channelTypes.length;
    const usesVrc6 = expansions.includes('vrc6');
    const usesMmc5 = expansions.includes('mmc5');
    const usesFme7 = expansions.includes('fme7');
    const usesFds = expansions.includes('fds');
    const usesN163 = expansions.includes('n163');
    const usesVrc7 = expansions.includes('vrc7');
    const usesDpcm = expansions.includes('dpcm');
    // 実際にレイアウト済み(=ファイルが読み込まれ、16KB領域に収まった)サンプルのみ対象
    const dpcmIndices = usesDpcm ? Object.keys(dpcmLayout).map(Number).sort((a, b) => a - b) : [];
    // N163実チャンネル数: ハードウェアは内部8ch中「上位num個」だけを巡回・ミックスするため
    // (numChannels()参照)、使用チャンネル数numN163Chを$7Fに設定し、regBaseも
    // (8-numN163Ch)+ch にオフセットする必要がある(0番から詰めると鳴らない)。
    const numN163Ch = channelTypes.filter(t => t >= TYPE_N163_BASE && t < TYPE_N163_BASE + 8).length;

    // カスタム波形・音色定義(その音源が使われている場合のみ収集。「使う時だけ組み込む」の
    // 対象範囲をチップ単位からカスタム定義の有無単位までさらに絞る)
    const fdsCustomWaves = usesFds ? Object.keys(envelopes.fm || {}).map(Number).sort((a, b) => a - b) : [];
    const n163CustomWaves = usesN163 ? Object.keys(envelopes.n || {}).map(Number).sort((a, b) => a - b) : [];
    const vrc7CustomTones = usesVrc7 ? Object.keys(envelopes.op || {}).map(Number).sort((a, b) => a - b) : [];
    // N163が@N<n>カスタム波形を実際に使う曲でのみ、共有バッファアロケータ用の追加zp配列
    // (WAVEOFS/TBLLO/TBLHI)を確保する。使わない曲は従来通りの固定16サンプル単一テーブル・
    // 絶対アドレッシングのまま(回帰リスクを抑えるため、この場合はコード自体を変更しない)。
    const usesN163CustomWaves = n163CustomWaves.length > 0;

    // ゼロページレイアウト。6502の(zp),Y間接アドレッシング(ENV_LOOKUP/EP_LOOKUP/
    // N163のtableRead/READ_BYTEが使う)はポインタが物理ゼロページ(アドレス0-255)に
    // 無ければならないという6502自体のハード制約がある(アセンブラはこの制約を
    // 検知できない=範囲外でも黙って下位8bitに切り詰めてしまうため、超えるとサイレントに
    // メモリ破壊するバグになる。EP/MP追加でチャンネルごとの状態が大幅に増え、この間接
    // ポインタ群を他のチャンネル配列群より後ろに置いていた旧レイアウトでは、チャンネル数が
    // 多い曲(拡張音源を複数使う曲)で255番地を超えてしまっていた)。そのため間接ポインタ
    // として使う変数(CURLO/CURHI・PERLO/PERHI・PTBLLO/PTBLHI)はチャンネル数nに依存しない
    // 固定8バイトとして最優先で先頭(0-7番地)に固定配置する。チャンネル数で伸縮する配列群
    // (CNT以降)はその後ろに置く(255番地を超えても、,X直接インデックスは絶対,Xアドレッシング
    // へ自動的にフォールバックするだけで6502的に正しく動作するため問題ない。JMPLO/JMPHIも
    // JMP間接絶対なので同様に無問題)。
    const CURLO = 0, CURHI = 1, CHIDX = 2, PERLO = 3, PERHI = 4, PERLO2 = 5,
      // WFV_T側でTBLLO/TBLHI,Xを一時的にコピーしてind,Yアドレッシングするための共有ポインタ
      PTBLLO = 6, PTBLHI = 7;
    const PTR_FIXED_SIZE = 8;

    // 各チャンネル配列のブロック数を先に確定する(usesEp/usesMp判定・EP/MP用ブロック数
    // 込みで、実際のアドレス割付けより前に必要なため)
    const n163ExtraSlots = usesN163CustomWaves ? 3 : 0;
    const fme7ExtraSlots = usesFme7 ? 1 : 0;
    const usesEp = epIndexList.length > 0;
    // EPDELAY/EPDELAYSET(2026-08-11 別プロジェクトA、EP<n>,<delay>): 5→7スロットに拡張
    const epExtraSlots = usesEp ? 7 : 0;
    const usesMp = mpIndexList.length > 0;
    const mpExtraSlots = usesMp ? 11 : 0;
    // PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC): 11byte/ch(MPと同数)
    const ptExtraSlots = usesPortamento ? 11 : 0;
    // タイ(&)による異音程レガート(2026-08-12): 専用のZP状態は持たない(NOTE,Xを
    // 直接書き替えるだけ)ため追加スロットは不要。WRITE_FREQ_ONLY自体は必要なので
    // usesFreqOnlyの判定にだけ加える
    const usesFreqOnly = usesEp || usesMp || usesPortamento || usesPitchBreak;
    const freqOnlyExtraSlots = usesFreqOnly ? 1 : 0;
    const totalPerChanBlocks = 14 + n163ExtraSlots + fme7ExtraSlots + epExtraSlots + mpExtraSlots + ptExtraSlots + freqOnlyExtraSlots;
    // fixedBase以降(JMPLO,JMPHI,FME7専用グローバル,CEILDIVスクラッチ)の固定個数。
    // 下のchArrayBase判定に含める(このブロックも$0100-$01FFに掛かってはいけないため)
    const TRAILING_FIXED_SIZE = 13;
    // CNT以降のチャンネル配列群の開始番地。$0100-$01FFは6502のハードウェアスタック
    // (JSR/RTS/PHA/PLAが暗黙に使う)なので、,X直接インデックスの配列であっても
    // 絶対に踏んではいけない(踏むとJSRの戻り先が化けて実機で不定動作/暴走する。
    // EP/MP追加でチャンネルごとの状態が大幅に増え、旧レイアウトでは拡張音源を複数使う
    // 曲でこの領域に踏み込んでいた=asmエラーは出ないサイレントな暴走バグだった)。
    // ゼロページ(0-255)にチャンネル配列群+末尾の固定グローバルまで全て収まりきる場合は
    // PTR_FIXED_SIZE直後(8番地)からそのまま詰める(zp,Xの高速な1バイトアドレッシングを
    // 使える)。収まらない場合は$0100-$01FF全体を素通りして$0200から確保する(絶対,X
    // アドレッシングになるだけで6502的に正しく動く。CURLO/PERLO/PTBLLO等の物理ゼロページ
    // 必須組は既に先頭0-7番地に固定済みなので、ここが$0200に移っても影響しない)
    const chArrayBase = (PTR_FIXED_SIZE + totalPerChanBlocks * n + TRAILING_FIXED_SIZE <= 0x100) ? PTR_FIXED_SIZE : 0x0200;

    // LASTINSはFDS/N163/VRC7のカスタム波形・音色の「直近ロードした音色番号」を覚えておく
    // ためのチャンネルごとのスクラッチ(音符ごとのinstrumentがこれと変わった時だけ
    // 再ロードする、compiler.jsのlastInstrument diffと同じロジックを6502側で再現する)。
    // ENVACT/ENVSEL/ENVTICKはソフトウェア音量エンベロープ(@v<n>)用のチャンネルごとの
    // 状態(有効フラグ・選択中のテーブル番号・現在のtick)。ENV_LOOKUP/SERVICE_CH参照
    const CNT = chArrayBase, VOL = chArrayBase + n, DUTY = chArrayBase + 2 * n,
      NOTE = chArrayBase + 3 * n, PTRLO = chArrayBase + 4 * n, PTRHI = chArrayBase + 5 * n,
      BANK = chArrayBase + 6 * n, CHTYPE = chArrayBase + 7 * n, LASTINS = chArrayBase + 8 * n,
      ENVACT = chArrayBase + 9 * n, ENVSEL = chArrayBase + 10 * n, ENVTICK = chArrayBase + 11 * n,
      // D<n>(デチューン)。チャンネルごとの符号付き16bit生オフセット(下位/上位バイト)。
      // APPLY_DETUNE/APPLY_DETUNE_N163参照
      DETUNE_LO = chArrayBase + 12 * n, DETUNE_HI = chArrayBase + 13 * n;
    // N163共有バッファアロケータ用(usesN163CustomWaves時のみ実際に使う。未使用時も定数
    // 自体は計算するがコード上参照されない): WAVEOFS=このchが今使っている波形のバイト
    // オフセット(OP_N163_WAVE_RELOADで動的に書き換わる)、TBLLO/TBLHI=このchが今使っている
    // 音色の周波数テーブル(N163_TABLE_<L>)への間接ポインタ(音色ロード時に固定値を設定。
    // TBLLO/TBLHI自体は,X直接インデックスのみで使われ間接アドレッシングのポインタとしては
    // 使わないため255番地を超えても問題ない=PTBLLO/PTBLHIへ都度コピーしてから間接読みする)
    const WAVEOFS = chArrayBase + 14 * n, TBLLO = chArrayBase + 15 * n, TBLHI = chArrayBase + 16 * n;
    // FME7ハードウェアエンベロープ(S<n>/M<n>)使用中フラグ。チャンネルごとに持つ必要が
    // あるのはこれだけで、形状・周期(R11-R13)はチップ内に1組しか無いためグローバル
    // (FMEESH/FMEEPL/FMEEPH)に持つ。usesFme7の時のみ実際に使う
    const FMEEACT = chArrayBase + (14 + n163ExtraSlots) * n;
    // EP<n>(ピッチエンベロープ)用チャンネルごとの状態。usesEpの時のみ実際に使う。
    // EPACT=有効フラグ、EPSEL=選択中のROMテーブル番号(EP_LEN/EP_LOOP/EP_PTRの添字)、
    // EPTICK=経過フレーム(ENVTICKと同じ意味、ただしdelay経過後から0起算)。
    // EPVALLO/EPVALHIはEP_LOOKUPが書き込む符号付き16bitの現在値(APPLY_DETUNE/
    // APPLY_DETUNE_N163が読む)。EPDELAYSET=EP<n>,<delay>で指定されたdelay値(RD_PITCHENVで
    // セット)、EPDELAY=その残りカウントダウン(RD_NOTEでEPDELAYSETから再初期化、実機
    // lfo_start_counterと同じ「delay中はdec;この音符ではEP無反映」という考え方。
    // 2026-08-11 別プロジェクトA、compiler.jsのseg.pitchEnvDelay/EP_STEPと対応)
    const EPACT = chArrayBase + (14 + n163ExtraSlots + fme7ExtraSlots) * n,
      EPSEL = EPACT + n, EPTICK = EPACT + 2 * n,
      EPVALLO = EPACT + 3 * n, EPVALHI = EPACT + 4 * n,
      EPDELAY = EPACT + 5 * n, EPDELAYSET = EPACT + 6 * n;
    // MP<n>(ソフトウェアビブラート)用チャンネルごとの状態。usesMpの時のみ実際に使う。
    // ppmck実機lfo_sub/warizan_startの状態機械をそのまま6502へ移植したもの
    // (compiler.jsのvibratoSequence/ceilDivPpmckが1音符分を事前計算するのに対し、
    // 6502側はフレームごとにLFO_SUBを呼んで1ステップずつ進める)。
    // MPACT=有効フラグ、MPSEL=選択中のROMテーブル番号(MP_DELAY/MP_SPEED/MP_DEPTHの添字)、
    // MPSTARTCNT=lfo_start_counter(delay残り)、MPREVCNT=lfo_reverse_counter、
    // MPQUARTER2=quarter*2(反転判定の比較先、RD_NOTEでMP_SPEEDから毎回再計算)、
    // MPADCCNT=lfo_adc_sbc_counter、MPSTEPSZ/MPSTEPINT=MP<n>選択時に計算した
    // warizan_start結果(1ステップの増減量/その間隔)、MPDIR=現在の方向(+1=$01/-1=$FF)、
    // MPVALLO/MPVALHI=累積オフセット(符号付き16bit、APPLY_DETUNE/APPLY_DETUNE_N163が読む)
    const mpBase = EPACT + epExtraSlots * n;
    const MPACT = mpBase, MPSEL = mpBase + n, MPSTARTCNT = mpBase + 2 * n,
      MPREVCNT = mpBase + 3 * n, MPQUARTER2 = mpBase + 4 * n, MPADCCNT = mpBase + 5 * n,
      MPSTEPSZ = mpBase + 6 * n, MPSTEPINT = mpBase + 7 * n, MPDIR = mpBase + 8 * n,
      MPVALLO = mpBase + 9 * n, MPVALHI = mpBase + 10 * n;
    // PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC)用チャンネルごとの状態。
    // usesPortamentoの時のみ実際に使う。compiler.jsのportamentoSequenceと同じアルゴリズム
    // (MPのwarizan_start片道版、反転無し)を1フレームずつ状態遷移させる。
    // PTACT=有効フラグ、PTDIR=方向(+1=$00/-1=$FF。targetの符号拡張バイトをそのまま
    // 使う、MPと違い符号付きtarget自身が方向を持つのでCHTYPE方向テーブルは不要)、
    // PTDURSET/PTDELAYSET=PT<n>選択時(RD_PORTAMENTO)に保存したduration/delayの生値、
    // PTSTEPSZ/PTSTEPINT=RD_PORTAMENTOでCEILDIVにより確定した1ステップの増減量/間隔、
    // PTDELAY=delay残りカウントダウン、PTDUR=duration残りカウントダウン(0になったら
    // 以降は何もせずPTVALLO/HIを保持=最終値の永久ホールド)、PTSTEPCNT=次のステップまでの
    // カウンタ(MPのMPADCCNT相当)、PTVALLO/PTVALHI=累積オフセット(符号付き16bit、
    // APPLY_DETUNE/APPLY_DETUNE_N163が読む)。RD_NOTEで毎音符PTDELAY/PTDUR/PTSTEPCNT/
    // PTVALLO/HIを再初期化する(EP_STEPと同じpost-increment単一ルーチン設計、off-by-one
    // バグの教訓を踏まえMP LFO_SUBのような初回/継続分離はしない)。
    const ptBase = mpBase + mpExtraSlots * n;
    const PTACT = ptBase, PTDIR = ptBase + n, PTDURSET = ptBase + 2 * n,
      PTDELAYSET = ptBase + 3 * n, PTSTEPSZ = ptBase + 4 * n, PTSTEPINT = ptBase + 5 * n,
      PTDELAY = ptBase + 6 * n, PTDUR = ptBase + 7 * n, PTSTEPCNT = ptBase + 8 * n,
      PTVALLO = ptBase + 9 * n, PTVALHI = ptBase + 10 * n;
    // LASTHI: EP/MP/PTの継続フレーム再書込み(WRITE_FREQ_ONLY)で、位相リセット副作用を持つ
    // 上位バイトレジスタを「実際に変わった時だけ」書くための直近書込み値
    // (compiler.js writePitchModulationのlastHiと同じロジック、n×1byte)。
    // EP・MP・PTのいずれかを使う曲でのみ確保する
    const freqOnlyBase = ptBase + ptExtraSlots * n;
    const LASTHI = freqOnlyBase;
    // fixedBaseから先はチャンネル数nと無関係な固定個数のグローバルスクラッチ(,Xインデックス
    // なし)。JMPLOはJMP間接絶対(2バイトアドレスなので物理ゼロページ外でも正しく動く)、
    // FME7専用グローバル・CEILDIV用スクラッチも通常のLDA/STA(間接アドレッシングではない)
    // なので255番地を超えても問題ない(CURLO/PERLO/PTBLLO等の物理ゼロページ必須組は
    // 既に先頭0-7番地に固定済み、このコメント直前を参照)
    const fixedBase = freqOnlyBase + freqOnlyExtraSlots * n;
    const JMPLO = fixedBase, JMPHI = fixedBase + 1,
      // FME7専用(usesFme7時のみ参照)。FMEMIX=ミキサ(R7)のシャドウ(チップから読み出せない
      // ため保持が必要)、FMEMODE=処理中chの@<n>(0-3)、FMETM/FMENM=そのchのトーン/ノイズ
      // 有効ビットマスク。FME7_PREP参照
      FMEMIX = fixedBase + 2, FMEMODE = fixedBase + 3,
      FMETM = fixedBase + 4, FMENM = fixedBase + 5,
      // FME7ハードウェアエンベロープ(S<n>/M<n>)。形状(R13)・周期(R11/R12)はチップに
      // 1組しか無いため全ch共通。FMEVREGはFME7_WRITE_VOLへ渡す音量レジスタ番号
      FMEESH = fixedBase + 6, FMEEPL = fixedBase + 7, FMEEPH = fixedBase + 8,
      FMEVREG = fixedBase + 9,
      // CEILDIV(ceilDivPpmck相当の除算ループ)用スクラッチ。MP<n>選択時(0xFB処理)にのみ
      // 使う一時変数で、チャンネル非依存(n倍しない固定1byteずつ)
      CDA = fixedBase + 10, CDB = fixedBase + 11, CDQ = fixedBase + 12;

    const playLines = [];
    for (let i = 0; i < n; i++) playLines.push(`    LDX #${hex(i)}\n    JSR SERVICE_CH`);

    const initExtra = [];
    if (usesMmc5) initExtra.push('    LDA #$03\n    STA $5015       ; MMC5パルス1/2有効化');
    // FME7のミキサ(R7)は音符ごとの@<n>で組み立てる(FME7_PREP)。初期値は全ch無音にし、
    // シャドウ変数(FMEMIX)も同じ値に合わせておく
    if (usesFme7) initExtra.push(`    LDA #$3F\n    STA ${hex(FMEMIX)}\n    LDA #$07\n    STA $C000\n    LDA #$3F\n    STA $E000       ; FME7ミキサ: 全chトーン/ノイズ無効(@<n>で有効化)`);
    if (usesFds) {
      const wave = new Array(64);
      for (let i = 0; i < 64; i++) wave[i] = Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * i) / 64)) & 0x3f;
      initExtra.push(`    LDA #$80\n    STA $4089       ; FDS波形メモリ書込み許可\n    LDX #$00\nINIT_FDS_WAVE:\n    LDA FDS_WAVE_DATA,X\n    STA $4040,X\n    INX\n    CPX #$40\n    BNE INIT_FDS_WAVE\n    LDA #$00\n    STA $4089       ; 書込み禁止・マスター音量フル`);
    }
    if (usesN163) {
      // 波形データの配置は共有バッファアロケータ(MML.N163Alloc、compiler.jsと同じ計算)が
      // 曲の実際の使用状況に応じて動的に行うため、ここではchごとの専用スロットへの
      // 既定波形の事前書き込みは行わない(@N<n>を一度も呼ばないchは波形が不定になる
      // 既知の制限。予約領域を作らずRAM全体を共有プールにする設計、compiler.js側と同じ)。
      // $7F(ゼロページではなくポート経由、N163内部RAMアドレス0x7F)に有効チャンネル数だけ
      // 設定する。実機は内部8ch中「上位numN163Ch個」だけを巡回・ミックスするため
      // (下位から詰めると鳴らない)。
      initExtra.push(`    LDA #$FF\n    STA $F800       ; N163内部アドレス$7Fを選択\n    LDA #${hex((numN163Ch - 1) << 4)}\n    STA $4800       ; 有効チャンネル数=${numN163Ch}`);
    }

    // --- 拡張音源ごとのハンドラ+テーブルのソース片(使うチップのみ生成) ---
    const extraHandlers = [];
    const extraTables = [];
    const wfvEntries = new Array(TYPE_COUNT).fill('WFV_T12');
    const silEntries = new Array(TYPE_COUNT).fill('SIL_T12');
    wfvEntries[0] = 'WFV_T0'; wfvEntries[1] = 'WFV_T1'; wfvEntries[2] = 'WFV_T2'; wfvEntries[3] = 'WFV_T3';
    silEntries[0] = 'SIL_T0'; silEntries[1] = 'SIL_T1'; silEntries[2] = 'SIL_T2'; silEntries[3] = 'SIL_T3';
    // WFV_VOL_T*: ソフトウェア音量エンベロープの毎フレームtick更新専用ハンドラ(音量
    // レジスタのみ書き込み、周期/コントロールレジスタは触らない)。音符アタック時のフル
    // 書込み(WFV_T*、周期含む)とは別にする理由はWRITE_VOL_ONLYのコメント参照
    const wfvVolEntries = new Array(TYPE_COUNT).fill('WFV_VOL_NONE');
    wfvVolEntries[0] = 'WFV_VOL_T0'; wfvVolEntries[1] = 'WFV_VOL_T1'; wfvVolEntries[3] = 'WFV_VOL_T3';
    // WFO_T*: EP<n>/MP<n>の毎フレーム継続再計算専用ハンドラ(周期/周波数レジスタのみ
    // 書き込み、音量レジスタは触らない)。WRITE_FREQ_ONLYのコメント参照。対象チップ
    // (2A03パルス/三角・VRC6・MMC5・FME7・FDS・N163、DESIGN-PITCH.md §7)のみエントリを
    // 持ち、それ以外(VRC7・ノイズ・未使用スロット)はWFO_NONE(何もしない)を指す
    const wfoEntries = new Array(TYPE_COUNT).fill('WFO_NONE');
    if (usesFreqOnly) { wfoEntries[0] = 'WFO_T0'; wfoEntries[1] = 'WFO_T1'; wfoEntries[2] = 'WFO_T2'; }

    // ソフトウェア音量エンベロープ(@v<n>)のテーブル本体をROMへ埋め込む(実際に使われて
    // いる場合のみ)。envIndexList[i]がmckBytecode.jsのOP_VOL_ENVで参照する番号iに対応する。
    // ENV_LEN/ENV_LOOP はコンパクト番号→長さ/ループ位置($FF=ループ無し)の直接引き
    // (.byte配列)、ENV_PTR はコンパクト番号→データ本体アドレスの直接引き(.word配列、
    // WFV_JUMPTABLE等と同じくASL Aで2倍したオフセットでアクセスする)
    const envTableCount = envIndexList.length;
    if (envTableCount > 0) {
      const envLens = envIndexList.map(idx => ((envelopes.v[idx] || {}).values || []).length);
      const envLoops = envIndexList.map(idx => {
        const loop = (envelopes.v[idx] || {}).loop;
        return (loop == null) ? 0xff : loop;
      });
      const envDataLabels = envIndexList.map((idx, i) => `ENV_DATA_${i}`);
      const envDataBlocks = envIndexList.map((idx, i) => {
        const values = ((envelopes.v[idx] || {}).values || []).map(v => Math.max(0, Math.min(15, v | 0)));
        return `ENV_DATA_${i}:\n${bytesToDb(new Uint8Array(values))}`;
      });
      extraTables.push(
        `ENV_LEN:\n    .byte ${envLens.join(',')}\n` +
        `ENV_LOOP:\n    .byte ${envLoops.join(',')}\n` +
        `ENV_PTR:\n    .word ${envDataLabels.join(',')}\n` +
        envDataBlocks.join('\n')
      );
      // --- ソフトウェア音量エンベロープ: X=チャンネル番号のまま呼ぶ。ENVSEL[X]/ENVTICK[X]から
      // テーブルを引き、末尾に達していたらループ位置へ戻すか(ENV_LOOP[Y]<>$FF)末尾保持
      // (ENVTICKを1戻す。以降このtick値をcompareし続けるので次フレーム以降もずっと最終値を
      // 指し続ける)、結果をVOL[X]へ書く。PERLO/PERHI/PERLO2は他の場所で使用後の
      // 使い回しスクラッチ(このルーチンの直後にWRITE_FREQ_VOLが呼ばれるだけなので安全)。
      // ASL Aで2倍するテーブル番号は他のジャンプテーブルと同じ理由でTYPE_COUNT程度の
      // 範囲を前提にしている(曲中の実際のエンベロープ形状数が128を超えることは無い想定)。
      extraHandlers.push(`
ENV_LOOKUP:
    LDA ${hex(ENVSEL)},X
    TAY
    LDA ENV_LEN,Y
    STA ${hex(PERLO2)}
    LDA ${hex(ENVTICK)},X
    CMP ${hex(PERLO2)}
    BCC ENVLK_INBOUNDS
    LDA ENV_LOOP,Y
    CMP #$FF
    BNE ENVLK_DOLOOP
    LDA ${hex(PERLO2)}
    SEC
    SBC #$01
    STA ${hex(ENVTICK)},X
    JMP ENVLK_INBOUNDS
ENVLK_DOLOOP:
    STA ${hex(ENVTICK)},X
ENVLK_INBOUNDS:
    TYA
    ASL A
    TAY
    LDA ENV_PTR,Y
    STA ${hex(PERLO)}
    LDA ENV_PTR+1,Y
    STA ${hex(PERHI)}
    LDA ${hex(ENVTICK)},X
    CLC
    ADC ${hex(PERLO)}
    STA ${hex(PERLO)}
    BCC ENVLK_NOCARRY
    INC ${hex(PERHI)}
ENVLK_NOCARRY:
    LDY #$00
    LDA (${hex(PERLO)}),Y
    STA ${hex(VOL)},X
    RTS`);
    }

    // --- EP<n>(ピッチエンベロープ)。@v(ソフトウェア音量エンベロープ)と全く同じ「使われている
    // インデックスだけをコンパクトに詰める」方式(epIndexList/pitchEnvIndexRemap、
    // buildBankedNsfBytes参照)。値は符号付きbyte(-128〜127)でMath.max/minの0-15クランプは
    // 行わない点がENV_LEN/ENV_DATAと異なる ---
    const epTableCount = epIndexList.length;
    if (epTableCount > 0) {
      const epLens = epIndexList.map(idx => ((envelopes.ep[idx] || {}).values || []).length);
      const epLoops = epIndexList.map(idx => {
        const loop = (envelopes.ep[idx] || {}).loop;
        return (loop == null) ? 0xff : loop;
      });
      const epDataLabels = epIndexList.map((idx, i) => `EP_DATA_${i}`);
      const epDataBlocks = epIndexList.map((idx, i) => {
        const values = ((envelopes.ep[idx] || {}).values || []).map(v => Math.max(-128, Math.min(127, v | 0)) & 0xff);
        return `EP_DATA_${i}:\n${bytesToDb(new Uint8Array(values))}`;
      });
      extraTables.push(
        `EP_LEN:\n    .byte ${epLens.join(',')}\n` +
        `EP_LOOP:\n    .byte ${epLoops.join(',')}\n` +
        `EP_PTR:\n    .word ${epDataLabels.join(',')}\n` +
        epDataBlocks.join('\n')
      );
      // --- EP<n>: X=チャンネル番号のまま呼ぶ。ENV_LOOKUPと全く同じテーブル探索
      // (EPSEL[X]/EPTICK[X]からEP_LEN/EP_LOOPを引き、末尾ならループかホールド)だが、
      // 結果を0-15にクランプするVOL[X]書込みではなく、符号付きbyteをそのまま16bitへ
      // 符号拡張してEPVALLO/EPVALHI[X]へ書く(APPLY_DETUNE/APPLY_DETUNE_N163が読む)。
      // PERLO/PERHI/PERLO2はENV_LOOKUPと同じ理由で使い回しスクラッチ(このルーチンの
      // 呼び出し元は直後に周期テーブル参照でこれらを上書きするだけなので安全) ---
      extraHandlers.push(`
EP_LOOKUP:
    LDA ${hex(EPSEL)},X
    TAY
    LDA EP_LEN,Y
    STA ${hex(PERLO2)}
    LDA ${hex(EPTICK)},X
    CMP ${hex(PERLO2)}
    BCC EPLK_INBOUNDS
    LDA EP_LOOP,Y
    CMP #$FF
    BNE EPLK_DOLOOP
    LDA ${hex(PERLO2)}
    SEC
    SBC #$01
    STA ${hex(EPTICK)},X
    JMP EPLK_INBOUNDS
EPLK_DOLOOP:
    STA ${hex(EPTICK)},X
EPLK_INBOUNDS:
    TYA
    ASL A
    TAY
    LDA EP_PTR,Y
    STA ${hex(PERLO)}
    LDA EP_PTR+1,Y
    STA ${hex(PERHI)}
    LDA ${hex(EPTICK)},X
    CLC
    ADC ${hex(PERLO)}
    STA ${hex(PERLO)}
    BCC EPLK_NOCARRY
    INC ${hex(PERHI)}
EPLK_NOCARRY:
    LDY #$00
    LDA (${hex(PERLO)}),Y
    STA ${hex(EPVALLO)},X
    BPL EPLK_POS
    LDA #$FF
    STA ${hex(EPVALHI)},X
    JMP EPLK_DONE
EPLK_POS:
    LDA #$00
    STA ${hex(EPVALHI)},X
EPLK_DONE:
    RTS

; --- EP<n>,<delay>(2026-08-11 別プロジェクトA): delayカウントダウン+テーブル参照を
; 1フレーム1回として統一的に処理する(RD_NOTE(音符アタック時、EPDELAY/EPTICKの初期化後に
; 呼ぶ)とSERVICE_CH継続フレームの両方から同じルーチンを呼ぶ)。
; ★post-increment設計(重要): EPTICKは「今回のlookupで使うindex」を指した状態でEP_LOOKUPを
; 呼び、その"後"にインクリメントする(先にインクリメントするとdelay消化直後の最初の
; lookupがtable[1]から始まってしまうoff-by-oneになる。実装中に実機6502エミュレータでの
; 検証で発覚・修正済み)。EPDELAYはEPDELAYSETから数えてEPDELAY回ぶんの「無効果フレーム」
; (contribute 0、その都度decrement)を消化してから初めてlookup側へ抜ける、という単純な
; カウントダウンにすることで、RD_NOTE(1回目の呼び出し)とSERVICE_CH(2回目以降)を
; 区別する必要が無くなり単一ルーチンで済む(実機lfo_sub「delay中はdec;rts」と同じ考え方、
; compiler.jsのpitchRegisterOffsetのtick>=delay判定に対応)。X=チャンネル番号のまま呼ぶ ---
EP_STEP:
    LDA ${hex(EPDELAY)},X
    BEQ EP_STEP_LOOKUP
    DEC ${hex(EPDELAY)},X
    LDA #$00
    STA ${hex(EPVALLO)},X
    STA ${hex(EPVALHI)},X
    RTS
EP_STEP_LOOKUP:
    JSR EP_LOOKUP
    INC ${hex(EPTICK)},X
    RTS`);
    }

    // --- MP<n>(ソフトウェアビブラート)。ppmck実機lfo_set_sub/warizan_startの忠実移植
    // (compiler.jsのvibratoSequence/ceilDivPpmckと同じ状態遷移。DESIGN-PITCH.md
    // 別プロジェクトB参照)。MP_DELAY/MP_SPEED/MP_DEPTHは生の3値(delay/quarter/rawDepth)
    // をそのまま埋め込み、warizan(除算)はMP<n>選択時(0xFB処理)にCEILDIVサブルーチンで
    // その場で計算する(実機と同じタイミング) ---
    const mpTableCount = mpIndexList.length;
    // --- CEILDIV: ceilDivPpmck(a,b)相当。呼び出し前提: ${hex(CDA)}=a, ${hex(CDB)}=bを
    // セットして呼ぶ(b>=1前提)。「while(rem>0){q++;rem-=b}」をそのまま減算ループで
    // 再現(割り切れない場合はceil側に丸まる、実機トレース済みの仕様。compiler.js
    // ceilDivPpmckのコメント参照)。戻り値=A(0-255)。${hex(CDA)}は呼び出し後に破壊される。
    // チャンネル非依存の使い捨てスクラッチなのでXは使わない(呼び出し元でX退避不要)。
    // MP(warizan_start)とポルタメント(RD_PORTAMENTO)の両方が共有するため、
    // どちらか一方でも使われていれば1回だけ埋め込む(2026-08-11 別プロジェクトC)。
    if (mpTableCount > 0 || usesPortamento) {
      extraHandlers.push(`
CEILDIV:
    LDA #$00
    STA ${hex(CDQ)}
CEILDIV_LOOP:
    LDA ${hex(CDA)}
    BEQ CEILDIV_DONE
    INC ${hex(CDQ)}
    SEC
    SBC ${hex(CDB)}
    BCS CEILDIV_NOBORROW
    LDA #$00
CEILDIV_NOBORROW:
    STA ${hex(CDA)}
    JMP CEILDIV_LOOP
CEILDIV_DONE:
    LDA ${hex(CDQ)}
    RTS`);
    }
    if (mpTableCount > 0) {
      const mpDelays = mpIndexList.map(idx => Math.max(0, Math.min(255, ((envelopes.mp[idx] || {}).delay) || 0)));
      const mpSpeeds = mpIndexList.map(idx => Math.max(1, Math.min(255, ((envelopes.mp[idx] || {}).speed) || 0)));
      const mpDepths = mpIndexList.map(idx => Math.max(1, Math.min(255, ((envelopes.mp[idx] || {}).depth) || 0)));
      extraTables.push(
        `MP_DELAY:\n    .byte ${mpDelays.join(',')}\n` +
        `MP_SPEED:\n    .byte ${mpSpeeds.join(',')}\n` +
        `MP_DEPTH:\n    .byte ${mpDepths.join(',')}`
      );
      // 方向テーブル(compiler.jsのperiodFnIncreasing相当。実機のfreq_vector_table)。
      // CHTYPEをキーにした固定.byte配列: 周期レジスタ系(2A03/VRC6/MMC5/FME7、値が
      // 下がるほど音程が上がる)は初期方向-1($FF)、周波数レジスタ系(FDS/N163、値が
      // 上がるほど音程が上がる)は+1($01)。対象外チップ(VRC7/ノイズ/未使用)は
      // $FFで埋めるが、これらのCHTYPEでMPACTが立つことはない(mmlEmit側がD/EP/MPを
      // 対象チップにしか出力しないため)ので値自体は参照されない
      const mpDirTable = new Array(TYPE_COUNT).fill(0xff);
      [TYPE_2A03_PULSE_A, TYPE_2A03_PULSE_B, TYPE_2A03_TRI, TYPE_VRC6_PULSE1, TYPE_VRC6_PULSE2,
        TYPE_VRC6_SAW, TYPE_MMC5_PULSE1, TYPE_MMC5_PULSE2, TYPE_FME7_CH0, TYPE_FME7_CH1, TYPE_FME7_CH2]
        .forEach(t => { mpDirTable[t] = 0xff; });
      mpDirTable[TYPE_FDS] = 0x01;
      for (let ch = 0; ch < N163_CHANNEL_COUNT; ch++) mpDirTable[TYPE_N163_BASE + ch] = 0x01;
      extraTables.push(`MP_DIR_TABLE:\n${bytesToDb(new Uint8Array(mpDirTable))}`);
      extraHandlers.push(`
; --- LFO_SUB: lfo_sub本体の忠実移植。X=チャンネル番号のまま呼ぶ(1フレーム分だけ状態を
; 進める。compiler.jsのvibratoSequence内側ループの1反復と同一)。delay中はデクリメントして
; 即リターン(値は変えない)。reverseCounterがquarter*2(MPQUARTER2)に達したら0へ戻し方向反転、
; adcSbcCounterがstepInterval(MPSTEPINT)に達したら0へ戻しMPVALLO/HIへ±MPSTEPSZを
; 符号付き16bit加算する。どちらのカウンタも(delay中でなければ)毎フレーム必ず+1する ---
LFO_SUB:
    LDA ${hex(MPSTARTCNT)},X
    BEQ LFO_NODELAY
    DEC ${hex(MPSTARTCNT)},X
    RTS
LFO_NODELAY:
    LDA ${hex(MPREVCNT)},X
    CMP ${hex(MPQUARTER2)},X
    BNE LFO_NOREV
    LDA #$00
    STA ${hex(MPREVCNT)},X
    LDA ${hex(MPDIR)},X
    EOR #$FF
    CLC
    ADC #$01
    STA ${hex(MPDIR)},X
LFO_NOREV:
    LDA ${hex(MPADCCNT)},X
    CMP ${hex(MPSTEPINT)},X
    BNE LFO_NOSTEP
    LDA #$00
    STA ${hex(MPADCCNT)},X
    LDA ${hex(MPDIR)},X
    BMI LFO_NEG
    CLC
    LDA ${hex(MPVALLO)},X
    ADC ${hex(MPSTEPSZ)},X
    STA ${hex(MPVALLO)},X
    LDA ${hex(MPVALHI)},X
    ADC #$00
    STA ${hex(MPVALHI)},X
    JMP LFO_NOSTEP
LFO_NEG:
    SEC
    LDA ${hex(MPVALLO)},X
    SBC ${hex(MPSTEPSZ)},X
    STA ${hex(MPVALLO)},X
    LDA ${hex(MPVALHI)},X
    SBC #$00
    STA ${hex(MPVALHI)},X
LFO_NOSTEP:
    INC ${hex(MPREVCNT)},X
    INC ${hex(MPADCCNT)},X
    RTS`);
    }

    // --- PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC)。ppmck本家
    // ドキュメント(doc/mck.txt)に専用コマンドが無く「ピッチエンベロープ(EP)で
    // 代用してください」と明記されているため、このツール独自の拡張。compiler.jsの
    // portamentoSequence(MPのwarizan_start片道版・反転無し)と同一アルゴリズムを
    // フレームごとの状態遷移として移植する。target/duration/delayはバイトコード上に
    // 直接の即値として乗る(EP/MPのようなROM共有テーブルは無い)ため、PT<n>選択時
    // (0xF9処理)にCEILDIVでその場でPTSTEPSZ/PTSTEPINTを確定する ---
    if (usesPortamento) {
      extraHandlers.push(`
; --- PT_STEP: ポルタメントの1フレーム分の状態遷移。EP_STEPと同じpost-increment単一
; ルーチン設計(RD_NOTE/SERVICE_CH継続フレームの両方から呼ぶ。EP実装時に踏んだ
; init/tick分離によるoff-by-oneバグの教訓を踏まえ、最初から単一ルーチンにしてある)。
; X=チャンネル番号のまま呼ぶ ---
PT_STEP:
    LDA ${hex(PTDELAY)},X
    BEQ PT_STEP_ACTIVE
    DEC ${hex(PTDELAY)},X
    LDA #$00
    STA ${hex(PTVALLO)},X
    STA ${hex(PTVALHI)},X
    RTS
PT_STEP_ACTIVE:
    LDA ${hex(PTDUR)},X
    BEQ PT_STEP_DONE
    LDA ${hex(PTSTEPCNT)},X
    CMP ${hex(PTSTEPINT)},X
    BNE PT_STEP_ADVANCE
    LDA #$00
    STA ${hex(PTSTEPCNT)},X
    LDA ${hex(PTDIR)},X
    BEQ PT_STEP_ADD
    LDA ${hex(PTVALLO)},X
    SEC
    SBC ${hex(PTSTEPSZ)},X
    STA ${hex(PTVALLO)},X
    LDA ${hex(PTVALHI)},X
    SBC #$00
    STA ${hex(PTVALHI)},X
    JMP PT_STEP_ADVANCE
PT_STEP_ADD:
    LDA ${hex(PTVALLO)},X
    CLC
    ADC ${hex(PTSTEPSZ)},X
    STA ${hex(PTVALLO)},X
    LDA ${hex(PTVALHI)},X
    ADC #$00
    STA ${hex(PTVALHI)},X
PT_STEP_ADVANCE:
    INC ${hex(PTSTEPCNT)},X
    DEC ${hex(PTDUR)},X
PT_STEP_DONE:
    RTS`);
    }

    if (usesVrc6) {
      extraTables.push(`SAW_TABLE:\n${wordsToDb(buildPeriodTable(sawPeriod))}`);
      extraHandlers.push(`
LOOKUP_SAW_PERIOD:
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC LSP_OK
    LDA #${hex(TABLE_MAX)}
LSP_OK:
    ASL A
    TAX
    LDA SAW_TABLE,X
    STA ${hex(PERLO)}
    LDA SAW_TABLE+1,X
    STA ${hex(PERHI)}
    RTS

; --- VRC6パルス1 ($9000)。デューティ(bit4-6)は@<n>命令のn%8(compiler.jsのsegmentsToWriteLogVrc6と同一式) ---
WFV_T4:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $9001
    LDA ${hex(PERHI)}
    ORA #$80
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $9002
    LDA ${hex(DUTY)},X
    AND #$07
    ASL A
    ASL A
    ASL A
    ASL A
    ORA ${hex(VOL)},X
    STA $9000
    RTS
SIL_T4:
    LDA ${hex(DUTY)},X
    AND #$07
    ASL A
    ASL A
    ASL A
    ASL A
    STA $9000
    RTS

; --- VRC6パルス2 ($A000) ---
WFV_T5:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $A001
    LDA ${hex(PERHI)}
    ORA #$80
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $A002
    LDA ${hex(DUTY)},X
    AND #$07
    ASL A
    ASL A
    ASL A
    ASL A
    ORA ${hex(VOL)},X
    STA $A000
    RTS
SIL_T5:
    LDA ${hex(DUTY)},X
    AND #$07
    ASL A
    ASL A
    ASL A
    ASL A
    STA $A000
    RTS

; --- VRC6矩形波(サウ) ($B000)。音量0-15を4倍して蓄積レート(0-60)にする ---
WFV_T6:
    STX ${hex(CHIDX)}
    JSR LOOKUP_SAW_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $B001
    LDA ${hex(PERHI)}
    ORA #$80
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $B002
    LDA ${hex(VOL)},X
    ASL A
    ASL A
    STA $B000
    RTS
SIL_T6:
    LDA #$00
    STA $B000
    RTS`);
      wfvEntries[4] = 'WFV_T4'; wfvEntries[5] = 'WFV_T5'; wfvEntries[6] = 'WFV_T6';
      silEntries[4] = 'SIL_T4'; silEntries[5] = 'SIL_T5'; silEntries[6] = 'SIL_T6';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak) {
        extraHandlers.push(`
; --- VRC6パルス1/2・矩形波(サウ)のEP<n>/MP<n>継続フレーム専用(周期のみ再書込み) ---
WFO_T4:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $9001
    LDA ${hex(PERHI)}
    ORA #$80
    CMP ${hex(LASTHI)},X
    BEQ WFO4_SKIPHI
    STA ${hex(LASTHI)},X
    STA $9002
WFO4_SKIPHI:
    RTS
WFO_T5:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $A001
    LDA ${hex(PERHI)}
    ORA #$80
    CMP ${hex(LASTHI)},X
    BEQ WFO5_SKIPHI
    STA ${hex(LASTHI)},X
    STA $A002
WFO5_SKIPHI:
    RTS
WFO_T6:
    STX ${hex(CHIDX)}
    JSR LOOKUP_SAW_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $B001
    LDA ${hex(PERHI)}
    ORA #$80
    CMP ${hex(LASTHI)},X
    BEQ WFO6_SKIPHI
    STA ${hex(LASTHI)},X
    STA $B002
WFO6_SKIPHI:
    RTS`);
        wfoEntries[4] = 'WFO_T4'; wfoEntries[5] = 'WFO_T5'; wfoEntries[6] = 'WFO_T6';
      }
      if (envTableCount > 0) {
        extraHandlers.push(`
WFV_VOL_T4:
    LDA ${hex(DUTY)},X
    AND #$07
    ASL A
    ASL A
    ASL A
    ASL A
    ORA ${hex(VOL)},X
    STA $9000
    RTS
WFV_VOL_T5:
    LDA ${hex(DUTY)},X
    AND #$07
    ASL A
    ASL A
    ASL A
    ASL A
    ORA ${hex(VOL)},X
    STA $A000
    RTS
WFV_VOL_T6:
    LDA ${hex(VOL)},X
    ASL A
    ASL A
    STA $B000
    RTS`);
        wfvVolEntries[4] = 'WFV_VOL_T4'; wfvVolEntries[5] = 'WFV_VOL_T5'; wfvVolEntries[6] = 'WFV_VOL_T6';
      }
    }

    if (usesMmc5) {
      extraHandlers.push(`
; --- MMC5パルス1 ($5000) ---
WFV_T7:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $5002
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $5003
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $5000
    RTS
SIL_T7:
    LDA #$30
    STA $5000
    RTS

; --- MMC5パルス2 ($5004) ---
WFV_T8:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $5006
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $5007
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $5004
    RTS
SIL_T8:
    LDA #$30
    STA $5004
    RTS`);
      wfvEntries[7] = 'WFV_T7'; wfvEntries[8] = 'WFV_T8';
      silEntries[7] = 'SIL_T7'; silEntries[8] = 'SIL_T8';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak) {
        extraHandlers.push(`
; --- MMC5パルス1/2のEP<n>/MP<n>継続フレーム専用(周期のみ再書込み) ---
WFO_T7:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $5002
    LDA ${hex(PERHI)}
    CMP ${hex(LASTHI)},X
    BEQ WFO7_SKIPHI
    STA ${hex(LASTHI)},X
    STA $5003
WFO7_SKIPHI:
    RTS
WFO_T8:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $5006
    LDA ${hex(PERHI)}
    CMP ${hex(LASTHI)},X
    BEQ WFO8_SKIPHI
    STA ${hex(LASTHI)},X
    STA $5007
WFO8_SKIPHI:
    RTS`);
        wfoEntries[7] = 'WFO_T7'; wfoEntries[8] = 'WFO_T8';
      }
      if (envTableCount > 0) {
        extraHandlers.push(`
WFV_VOL_T7:
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $5000
    RTS
WFV_VOL_T8:
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $5004
    RTS`);
        wfvVolEntries[7] = 'WFV_VOL_T7'; wfvVolEntries[8] = 'WFV_VOL_T8';
      }
    }

    if (usesFme7) {
      extraTables.push(`FME7_TABLE:\n${wordsToDb(buildPeriodTable(fme7Period))}`);
      extraHandlers.push(`
LOOKUP_FME7_PERIOD:
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC LFP_OK
    LDA #${hex(TABLE_MAX)}
LFP_OK:
    ASL A
    TAX
    LDA FME7_TABLE,X
    STA ${hex(PERLO)}
    LDA FME7_TABLE+1,X
    STA ${hex(PERHI)}
    RTS

; --- FME7共通: @<n>(=DUTY,X。ppmck仕様で 0=ミュート/1=トーン/2=ノイズ/3=トーン+ノイズ)を
;     ミキサ(R7)へ反映する。R7は3ch共有かつ読み出し不可なのでFMEMIXにシャドウを持つ。
;     呼び出し前に FMETM へこのchのトーン有効ビット(1<<ch)を入れておくこと。
;     @2(ノイズ単独)のときはノート番号がそのままノイズ周期(R6)になる(ppmck仕様)。
;     戻り値: キャリー=1ならトーン周期レジスタの書き込みが必要 ---
FME7_PREP:
    LDA ${hex(FMETM)}
    ASL A
    ASL A
    ASL A
    STA ${hex(FMENM)}      ; ノイズ有効ビット = トーン有効ビット<<3
    LDA ${hex(DUTY)},X
    AND #$03
    STA ${hex(FMEMODE)}
    LDA ${hex(FMEMIX)}
    ORA ${hex(FMETM)}
    ORA ${hex(FMENM)}
    STA ${hex(FMEMIX)}     ; いったんこのchのトーン・ノイズとも無効(bit=1)にする
    LDA ${hex(FMEMODE)}
    LSR A
    BCC FP_NOTONE
    LDA ${hex(FMEMIX)}
    EOR ${hex(FMETM)}      ; bitは必ず1なのでEORで0(=有効)にできる
    STA ${hex(FMEMIX)}
FP_NOTONE:
    LDA ${hex(FMEMODE)}
    AND #$02
    BEQ FP_NONOISE
    LDA ${hex(FMEMIX)}
    EOR ${hex(FMENM)}
    STA ${hex(FMEMIX)}
    LDA ${hex(FMEMODE)}
    CMP #$02
    BNE FP_NONOISE  ; @3(トーン+ノイズ)の周期はN<n>(0xF1)で設定済みの値をそのまま使う
    LDA #$06
    STA $C000
    LDA ${hex(NOTE)},X
    AND #$1F
    STA $E000       ; @2: ノート番号(0-31)をノイズ周期として書く
FP_NONOISE:
    LDA #$07
    STA $C000
    LDA ${hex(FMEMIX)}
    STA $E000
    LDA ${hex(FMEMODE)}
    LSR A           ; bit0(トーン有効)をキャリーへ
    RTS

; --- FME7共通: このチャンネルの音量レジスタ(A=$08-$0A)を書く。
;     ハードウェアエンベロープ(S<n>/M<n>)使用中は固定音量ではなくbit4=1を書き、
;     さらに音符ごとにR11/R12/R13を書き直してエンベロープの位相をリセットする
;     (R13への書き込みが実機のキーオン相当。compiler.jsも音符ごとに書いている) ---
FME7_WRITE_VOL:
    STA ${hex(FMEVREG)}
    LDA ${hex(FMEEACT)},X
    BEQ FWV_PLAIN
    LDA #$0B
    STA $C000
    LDA ${hex(FMEEPL)}
    STA $E000
    LDA #$0C
    STA $C000
    LDA ${hex(FMEEPH)}
    STA $E000
    LDA #$0D
    STA $C000
    LDA ${hex(FMEESH)}
    STA $E000       ; 形状の書き直し=位相リセット
    LDA ${hex(FMEVREG)}
    STA $C000
    LDA #$10
    STA $E000       ; 音量レジスタbit4=1: ハードウェアエンベロープ制御
    RTS
FWV_PLAIN:
    LDA ${hex(FMEVREG)}
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS

; --- FME7 ch0 ($C000アドレス選択/$E000データ書込の間接方式。reg0/1=周期,reg8=音量) ---
WFV_T9:
    LDA #$01
    STA ${hex(FMETM)}
    JSR FME7_PREP
    BCS WFV_T9_TONE
    JMP WFV_T9_VOL  ; @0/@2はトーン周期を書かない
WFV_T9_TONE:
    STX ${hex(CHIDX)}
    JSR LOOKUP_FME7_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA #$00
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA #$01
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFV_T9_VOL:
    LDA #$08
    JMP FME7_WRITE_VOL
SIL_T9:
    LDA #$08
    STA $C000
    LDA #$00
    STA $E000
    RTS

; --- FME7 ch1 (reg2/3=周期,reg9=音量) ---
WFV_T10:
    LDA #$02
    STA ${hex(FMETM)}
    JSR FME7_PREP
    BCS WFV_T10_TONE
    JMP WFV_T10_VOL
WFV_T10_TONE:
    STX ${hex(CHIDX)}
    JSR LOOKUP_FME7_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA #$02
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA #$03
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFV_T10_VOL:
    LDA #$09
    JMP FME7_WRITE_VOL
SIL_T10:
    LDA #$09
    STA $C000
    LDA #$00
    STA $E000
    RTS

; --- FME7 ch2 (reg4/5=周期,reg10=音量) ---
WFV_T11:
    LDA #$04
    STA ${hex(FMETM)}
    JSR FME7_PREP
    BCS WFV_T11_TONE
    JMP WFV_T11_VOL
WFV_T11_TONE:
    STX ${hex(CHIDX)}
    JSR LOOKUP_FME7_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA #$04
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA #$05
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFV_T11_VOL:
    LDA #$0A
    JMP FME7_WRITE_VOL
SIL_T11:
    LDA #$0A
    STA $C000
    LDA #$00
    STA $E000
    RTS`);
      wfvEntries[9] = 'WFV_T9'; wfvEntries[10] = 'WFV_T10'; wfvEntries[11] = 'WFV_T11';
      silEntries[9] = 'SIL_T9'; silEntries[10] = 'SIL_T10'; silEntries[11] = 'SIL_T11';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak) {
        // FME7は間接アドレッシング($C000選択/$E000データ)のみで、2A03等のような
        // 「上位バイト書込みで位相リセット」という副作用が無いため(compiler.jsの
        // segmentsToWriteLogFme7もlastHiガード無しで毎フレーム両バイトを書く)、
        // LASTHIチェックは不要で毎フレーム無条件に書く。@<n>のモード(DUTY,Xの下位2bit、
        // FME7_PREPと同じ判定)でトーンが無効(@0/@2)の間は周期を書かない
        extraHandlers.push(`
; --- FME7 ch0/1/2のEP<n>/MP<n>継続フレーム専用(トーン周期のみ再書込み、@<n>の
; トーン有効ビットが立っている間だけ) ---
WFO_T9:
    LDA ${hex(DUTY)},X
    AND #$01
    BEQ WFO9_DONE
    STX ${hex(CHIDX)}
    JSR LOOKUP_FME7_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA #$00
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA #$01
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFO9_DONE:
    RTS
WFO_T10:
    LDA ${hex(DUTY)},X
    AND #$01
    BEQ WFO10_DONE
    STX ${hex(CHIDX)}
    JSR LOOKUP_FME7_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA #$02
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA #$03
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFO10_DONE:
    RTS
WFO_T11:
    LDA ${hex(DUTY)},X
    AND #$01
    BEQ WFO11_DONE
    STX ${hex(CHIDX)}
    JSR LOOKUP_FME7_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA #$04
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA #$05
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFO11_DONE:
    RTS`);
        wfoEntries[9] = 'WFO_T9'; wfoEntries[10] = 'WFO_T10'; wfoEntries[11] = 'WFO_T11';
      }
      if (envTableCount > 0) {
        extraHandlers.push(`
WFV_VOL_T9:
    LDA #$08
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS
WFV_VOL_T10:
    LDA #$09
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS
WFV_VOL_T11:
    LDA #$0A
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS`);
        wfvVolEntries[9] = 'WFV_VOL_T9'; wfvVolEntries[10] = 'WFV_VOL_T10'; wfvVolEntries[11] = 'WFV_VOL_T11';
      }
    }

    if (usesFds) {
      const wave = new Array(64);
      for (let i = 0; i < 64; i++) wave[i] = Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * i) / 64)) & 0x3f;
      extraTables.push(`FDS_TABLE:\n${wordsToDb(buildPeriodTable(fdsPeriod))}\nFDS_WAVE_DATA:\n${bytesToDb(new Uint8Array(wave))}`);
      // @FM<n>カスタム波形。FDSは波形メモリが1系統のみで全ch共有のため(実機の制約。
      // n163WaveLoadWritesと同様)、compiler.jsのfdsWaveLoadWritesと同じく「選択中の
      // 音色番号が前の音符から変わり、かつその番号に定義がある時だけ」再ロードする
      let fdsReload = '';
      if (fdsCustomWaves.length > 0) {
        // 波形の種類数が増えると(BEQの到達先が)CMP/BEQ連鎖・LOADブロック群全体を
        // 飛び越える距離になり、6502の分岐(±127byte)を超えて「分岐範囲外」で
        // アセンブル失敗することがある(FDSは音符ごとに波形が変わりやすく実測で
        // 発生)。BEQ/BNEは直後のJMP(範囲無制限)へ短距離分岐するだけにし、実際の
        // 長距離ジャンプは全てJMPで行う。
        const cmpChain = fdsCustomWaves.map((idx, i) =>
          `    CMP #${hex(idx)}\n    BNE WFV13_SKIP_${i}\n    JMP WFV13_LOAD_${i}\nWFV13_SKIP_${i}:`).join('\n');
        const loadBlocks = fdsCustomWaves.map((idx, i) => `
WFV13_LOAD_${i}:
    STA ${hex(LASTINS)},X
    STX ${hex(CHIDX)}
    LDA #$80
    STA $4089       ; 波形メモリ書込み許可
    LDX #$00
WFV13_LOAD_${i}_LP:
    LDA FDS_CUSTOM_WAVE_${i},X
    STA $4040,X
    INX
    CPX #$40
    BNE WFV13_LOAD_${i}_LP
    LDA #$00
    STA $4089       ; 書込み禁止・マスター音量フル
    LDX ${hex(CHIDX)}
    JMP WFV13_TONE_OK`).join('\n');
        fdsReload = `    LDA ${hex(DUTY)},X
    CMP ${hex(LASTINS)},X
    BNE WFV13_CHECK
    JMP WFV13_TONE_OK
WFV13_CHECK:
${cmpChain}
    JMP WFV13_TONE_OK
${loadBlocks}
WFV13_TONE_OK:
`;
        const toneTables = fdsCustomWaves
          .map((idx, i) => `FDS_CUSTOM_WAVE_${i}:\n${bytesToDb(new Uint8Array(envelopes.fm[idx].map(v => v & 0x3f)))}`)
          .join('\n');
        extraTables.push(toneTables);
      }
      extraHandlers.push(`
; --- FDS ($4082/4083=周期, $4080=ゲイン(音量*2)) ---
WFV_T13:
${fdsReload}    STX ${hex(CHIDX)}
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC WFV13_OK
    LDA #${hex(TABLE_MAX)}
WFV13_OK:
    ASL A
    TAX
    LDA FDS_TABLE,X
    STA ${hex(PERLO)}
    LDA FDS_TABLE+1,X
    STA ${hex(PERHI)}
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4082
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $4083
    LDA ${hex(VOL)},X
    ASL A
    ORA #$80
    STA $4080
    RTS
SIL_T13:
    LDA #$80
    STA $4083
    RTS`);
      wfvEntries[13] = 'WFV_T13';
      silEntries[13] = 'SIL_T13';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak) {
        extraHandlers.push(`
; --- FDSのEP<n>/MP<n>継続フレーム専用(周期のみ再書込み。波形再ロードは音符アタック時
; のみなのでここでは行わない) ---
WFO_T13:
    STX ${hex(CHIDX)}
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC WFO13_OK
    LDA #${hex(TABLE_MAX)}
WFO13_OK:
    ASL A
    TAX
    LDA FDS_TABLE,X
    STA ${hex(PERLO)}
    LDA FDS_TABLE+1,X
    STA ${hex(PERHI)}
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4082
    LDA ${hex(PERHI)}
    CMP ${hex(LASTHI)},X
    BEQ WFO13_SKIPHI
    STA ${hex(LASTHI)},X
    STA $4083
WFO13_SKIPHI:
    RTS`);
        wfoEntries[13] = 'WFO_T13';
      }
      if (envTableCount > 0) {
        extraHandlers.push(`
WFV_VOL_T13:
    LDA ${hex(VOL)},X
    ASL A
    ORA #$80
    STA $4080
    RTS`);
        wfvVolEntries[13] = 'WFV_VOL_T13';
      }

      // MH<n>/MHOF: 曲中のモジュレーション再ロード(音符に紐付かない即時コマンド、0xF5)。
      // FDSはモジュレーションユニットが1系統のみで全ch共有のため、どのチャンネルの
      // バイトコードストリームに現れても効果はチップ全体に及ぶ(compiler.jsの
      // resolveFdsModWriteと同じ)。@MH<n>で波形(@MW<n>)が未定義の場合はcompiler.jsに
      // 合わせテーブル書込みを省略する(既存のモジュレータテーブルをそのまま使う)。
      // fdsModDefsが空でも(@MH<n>を1つも定義せずMHOFだけ書かれた場合でも)0xF5自体は
      // 常にバイトコードへ出現しうるため、ハンドラ自体はusesFdsだけを条件にする
      // (fdsModDefs.length依存にすると未知オペコードとして音符バイトへ誤読される)。
      const fdsModDefs = Object.keys(envelopes.mh || {}).map(Number).sort((a, b) => a - b);
      const modBranches = fdsModDefs.length > 0
        ? fdsModDefs.map((idx, i) =>
            `    CMP #${hex(idx)}\n    BNE RD_FDSMOD_SKIP_${i}\n    JMP RD_FDSMOD_LOAD_${i}\nRD_FDSMOD_SKIP_${i}:`).join('\n')
        : '';
      const modBlocks = fdsModDefs.map((idx, i) => {
        const mh = envelopes.mh[idx] || {};
        const wave = envelopes.mw && envelopes.mw[mh.waveform];
        const freq = mh.freq || 0;
        const depth = mh.depth || 0;
        // Xはこのバイトコード読み出し処理全体を通して「現在処理中のチャンネル配列
        // index」を保持する共有レジスタなので、ここでの32byteコピーループ用カウンタと
        // して破壊する前に必ずCHIDXへ退避し、抜ける前に復元する(WFV13の波形ロードと
        // 同じ規約。復元を忘れるとRD_LOOP復帰後に別チャンネルのデータを読み込んでしまい、
        // 再生が止まる/暴走するバグになる)。
        // モジュレータカウンタ($4085)は常に0へリセットする(resolveFdsModWriteと同じ
        // 理由。実機Almana no Kisekiで実測: 再ロードのたび必ず$4085=0を書いている。
        // 無いと前回の変調で溜まったカウンタが残り非対称なピッチ変調になる)
        const waveLoad = wave ? `    STX ${hex(CHIDX)}
    LDX #$00
RD_FDSMOD_LOAD_${i}_LP:
    LDA FDS_MOD_WAVE_${i},X
    STA $4088
    INX
    CPX #$20
    BNE RD_FDSMOD_LOAD_${i}_LP
    LDX ${hex(CHIDX)}
` : '';
        return `
RD_FDSMOD_LOAD_${i}:
    LDA #$80
    STA $4087       ; 停止・テーブル書込み許可
    LDA #$00
    STA $4085       ; モジュレータカウンタリセット
${waveLoad}    LDA #${hex(freq & 0xff)}
    STA $4086
    LDA #${hex((freq >> 8) & 0x0f)}
    STA $4087       ; bit7=0で再開
    LDA #${hex(0x80 | (depth & 0x3f))}
    STA $4084
    JMP RD_LOOP`;
      }).join('\n');
      extraHandlers.push(`
; --- MH<n>/MHOF: FDSモジュレーション再ロード(音符に紐付かない即時コマンド、0xF5) ---
RD_FDSMOD:
    JSR READ_BYTE
    CMP #$FF
    BNE RD_FDSMOD_CHECK
    LDA #$80
    STA $4084       ; MHOF: gain=0で変調オフ
    STA $4087       ; モジュレータユニット自体も停止する(compiler.jsのresolveFdsModWriteと同じ)
    JMP RD_LOOP
RD_FDSMOD_CHECK:
${modBranches}
    JMP RD_LOOP     ; 対応するMH<n>定義が無ければ何もしない(compiler.jsと同じ)
${modBlocks}`);
      if (fdsModDefs.length > 0) {
        const modWaveTables = fdsModDefs
          .map((idx, i) => {
            const mh = envelopes.mh[idx] || {};
            const wave = envelopes.mw && envelopes.mw[mh.waveform];
            if (!wave) return '';
            const bytes32 = new Array(32);
            for (let k = 0; k < 32; k++) bytes32[k] = (wave[k] || 0) & 0x07;
            return `FDS_MOD_WAVE_${i}:\n${bytesToDb(new Uint8Array(bytes32))}`;
          })
          .filter(s => s.length > 0)
          .join('\n');
        if (modWaveTables) extraTables.push(modWaveTables);
      }
    }

    if (usesN163) {
      // usesN163CustomWaves===falseの場合は従来通り: 波形長16固定・単一テーブル・
      // 絶対アドレッシング(コードは一切変更しない。回帰リスクを抑えるため)。
      // usesN163CustomWaves===trueの場合は共有バッファアロケータ(MML.N163Alloc、
      // compiler.jsと全く同じ計算)に対応した可変長版を生成する:
      // インスツルメントごとに実際の波形長(4の倍数へ丸め)を持てるようにし、
      // ・波形の書込み先バイトオフセットはOP_N163_WAVE_RELOAD(ch別バイトコードに
      //   埋め込み済み、buildBankedNsfBytes参照)でWAVEOFS,Xへ動的に設定する
      // ・使う周波数テーブルはインスツルメントごとに固定(N163_LOAD_<i>がTBLLO/TBLHI,Xへ
      //   設定する。長さはインスツルメント固有でコンパイル時に決まるため、
      //   オフセットと違って音符ごとに変わらない)
      const n163LengthByIdx = {};
      n163CustomWaves.forEach(idx => {
        n163LengthByIdx[idx] = MML.N163Alloc.roundedLen((envelopes.n[idx] || []).length);
      });
      const n163LengthsUsed = usesN163CustomWaves
        ? Array.from(new Set(Object.values(n163LengthByIdx)))
        : [N163_WAVE_LEN];

      const n163TableLabel = L => usesN163CustomWaves ? `N163_TABLE_${L}` : 'N163_TABLE';
      const n163TableBlocks = n163LengthsUsed.map(L => {
        const words3 = [];
        for (let noteN = 0; noteN < NOTE_TABLE_SIZE; noteN++) {
          // 実行時に $7F へ設定する有効ch数(numN163Ch)で符号化する(復号側と一致させる)
          const reg = n163FreqReg(noteFrequency(noteN), L, numN163Ch);
          const lenByte = MML.N163Alloc ? MML.N163Alloc.lengthByte(L) : (256 - L) & 0xFC;
          words3.push(reg & 0xff, (reg >> 8) & 0xff, lenByte | ((reg >> 16) & 0x03));
        }
        return `${n163TableLabel(L)}:\n${bytesToDb(new Uint8Array(words3))}`;
      });
      extraTables.push(n163TableBlocks.join('\n'));

      let n163ToneCheckCall = '';
      if (usesN163CustomWaves) {
        // FDS(WFV13)と同じ理由(src/driver/ppmckDriver.js usesFdsブロック参照)で、
        // BEQ/BNEは直後のJMP(範囲無制限)への短距離分岐のみに使い、長距離ジャンプは
        // 全てJMPで行う(波形の種類が増えるとBEQの分岐距離が±127byteを超えうる)。
        const cmpChain = n163CustomWaves.map((idx, i) =>
          `    CMP #${hex(idx)}\n    BNE N163_SKIP_${i}\n    JMP N163_LOAD_${i}\nN163_SKIP_${i}:`).join('\n');
        const loadBlocks = n163CustomWaves.map((idx, i) => {
          const L = n163LengthByIdx[idx];
          const byteLen = L / 2;
          return `
N163_LOAD_${i}:
    STA ${hex(LASTINS)},X
    STX ${hex(CHIDX)}
    LDA ${hex(WAVEOFS)},X
    ORA #$80
    STA $F800       ; 共有アロケータが決めたバイト位置を選択、オートインクリメントON
    LDX #$00
N163_LOAD_${i}_LP:
    LDA N163_CUSTOM_WAVE_${i},X
    STA $4800
    INX
    CPX #${hex(byteLen)}
    BNE N163_LOAD_${i}_LP
    LDX ${hex(CHIDX)}
    LDA #<${n163TableLabel(L)}
    STA ${hex(TBLLO)},X
    LDA #>${n163TableLabel(L)}
    STA ${hex(TBLHI)},X
    JMP N163_TONE_OK`;
        }).join('\n');
        extraHandlers.push(`
; --- N163共通: @N<n>カスタム波形の再ロードチェック(X=チャンネル配列index) ---
N163_TONE_CHECK:
    LDA ${hex(DUTY)},X
    CMP ${hex(LASTINS)},X
    BNE N163_CHECK
    JMP N163_TONE_OK
N163_CHECK:
${cmpChain}
    JMP N163_TONE_OK
${loadBlocks}
N163_TONE_OK:
    RTS`);
        const toneTables = n163CustomWaves.map((idx, i) => {
          const L = n163LengthByIdx[idx];
          const raw = envelopes.n[idx] || [];
          const wave = raw.slice(0, L);
          while (wave.length < L) wave.push(0);
          const packed = new Array(L / 2);
          for (let k = 0; k < packed.length; k++) packed[k] = (wave[2 * k] & 0x0f) | ((wave[2 * k + 1] & 0x0f) << 4);
          return `N163_CUSTOM_WAVE_${i}:\n${bytesToDb(new Uint8Array(packed))}`;
        }).join('\n');
        extraTables.push(toneTables);
        n163ToneCheckCall = `    JSR N163_TONE_CHECK\n`;
      }
      // N163はテーブル1エントリ3バイトのため、Xレジスタ(8bit、最大255)でインデックス
      // 可能な範囲は音程0-85まで(85*3=255)。TABLE_MAX(107)のままだと107*3=321で
      // 8bitからあふれて誤ったテーブル位置を読んでしまうため、N163だけ上限を下げる
      const n163TableMax = Math.floor(255 / 3); // 85
      const n163Handlers = [];
      for (let ch = 0; ch < N163_CHANNEL_COUNT; ch++) {
        // 実チャンネルは内部8ch中「上位numN163Ch個」に配置される(numN163Ch=0の場合は
        // このハンドラ自体が参照されないため internalIdx の値は無関係)
        const internalIdx = (N163_CHANNEL_COUNT - Math.max(numN163Ch, 1)) + ch;
        const regBase = 0x40 + internalIdx * 8;
        const t = TYPE_N163_BASE + ch;
        // internalIdx=7(最上位ch)のみ、音量レジスタ(regBase+7=$7F)が「有効チャンネル数」
        // 設定ビット(4-6)と共用のため、単純上書きすると壊れる。読み戻して上位ビットを保持する。
        const isTopCh = internalIdx === 7;
        const wfvVolWrite = isTopCh
          ? `    LDA #${hex((regBase + 7) | 0x80)}\n    STA $F800\n    LDA $4800       ; 現在値読出し(有効ch数ビットを保持するため)\n    AND #$F0\n    STA ${hex(PERLO)}\n    LDA #$10\n    ORA ${hex(VOL)},X\n    AND #$0F\n    ORA ${hex(PERLO)}\n    STA ${hex(PERLO)}\n    LDA #${hex((regBase + 7) | 0x80)}\n    STA $F800       ; 読出しでアドレスが進むため再選択\n    LDA ${hex(PERLO)}\n    STA $4800`
          : `    LDA #${hex((regBase + 7) | 0x80)}\n    STA $F800\n    LDA #$10\n    ORA ${hex(VOL)},X\n    STA $4800`;
        const silWrite = isTopCh
          ? `    LDA #${hex((regBase + 7) | 0x80)}\n    STA $F800\n    LDA $4800       ; 現在値読出し(有効ch数ビットを保持するため)\n    AND #$F0\n    STA ${hex(PERLO)}\n    LDA #${hex((regBase + 7) | 0x80)}\n    STA $F800       ; 読出しでアドレスが進むため再選択\n    LDA ${hex(PERLO)}\n    STA $4800`
          : `    LDA #${hex((regBase + 7) | 0x80)}\n    STA $F800\n    LDA #$00\n    STA $4800`;
        // 波形長テーブル参照は、カスタム波形を使う曲ではインスツルメントごとに異なる
        // N163_TABLE_<L>を間接(ptr),Yで、使わない曲は従来通り単一N163_TABLEを絶対,Yで読む
        // (絶対/間接どちらもYを使うよう統一しているだけで、Xは温存されchannel indexのまま)
        const tableRead = usesN163CustomWaves
          ? `    LDA ${hex(TBLLO)},X\n    STA ${hex(PTBLLO)}\n    LDA ${hex(TBLHI)},X\n    STA ${hex(PTBLHI)}\n` +
            `    LDA (${hex(PTBLLO)}),Y\n    STA ${hex(PERLO)}\n    INY\n` +
            `    LDA (${hex(PTBLLO)}),Y\n    STA ${hex(PERHI)}\n    INY\n` +
            `    LDA (${hex(PTBLLO)}),Y\n    STA ${hex(PERLO2)}`
          : `    LDA N163_TABLE,Y\n    STA ${hex(PERLO)}\n    LDA N163_TABLE+1,Y\n    STA ${hex(PERHI)}\n` +
            `    LDA N163_TABLE+2,Y\n    STA ${hex(PERLO2)}`;
        const waveAddrRewrite = usesN163CustomWaves
          ? `    LDA #${hex((regBase + 6) | 0x80)}\n    STA $F800       ; 波形アドレス(+6)。` +
            `共有アロケータのオフセットは固定でなくなったため毎回書き直す\n    LDA ${hex(WAVEOFS)},X\n    ASL A\n    STA $4800\n`
          : '';
        n163Handlers.push(`
; --- N163 ch${ch} (regBase=${hex(regBase)}、$F800アドレス選択/$4800データ書込) ---
WFV_T${t}:
${n163ToneCheckCall}    STX ${hex(CHIDX)}
    LDA ${hex(NOTE)},X
    CMP #${hex(n163TableMax)}
    BCC WFV${t}_OK
    LDA #${hex(n163TableMax)}
WFV${t}_OK:
    ; note*3 (テーブルは1エントリ3バイト) = note+note+note (音程は85までなので8bitで安全)
    STA ${hex(PERLO)}
    CLC
    ADC ${hex(PERLO)}
    CLC
    ADC ${hex(PERLO)}
    TAY
${tableRead}
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE_N163
    LDA #${hex(regBase | 0x80)}
    STA $F800       ; regBase+0(freq lo)を選択、オートインクリメントON
    LDA ${hex(PERLO)}
    STA $4800       ; +0=freq lo書込み、addrは+1(位相byte)へ進む
    LDA $4800       ; +1(位相lo)を空読みして読み飛ばす、addrは+2へ
    LDA ${hex(PERHI)}
    STA $4800       ; +2=freq mid書込み、addrは+3(位相byte)へ進む
    LDA $4800       ; +3(位相mid)を空読みして読み飛ばす、addrは+4へ
    LDA ${hex(PERLO2)}
    STA $4800       ; +4=freq hi|波形長書込み
${waveAddrRewrite}${wfvVolWrite}
    RTS
SIL_T${t}:
${silWrite}
    RTS`);
        wfvEntries[t] = `WFV_T${t}`;
        silEntries[t] = `SIL_T${t}`;
        if (envTableCount > 0) {
          n163Handlers.push(`
WFV_VOL_T${t}:
${wfvVolWrite}
    RTS`);
          wfvVolEntries[t] = `WFV_VOL_T${t}`;
        }
        if (usesEp || usesMp || usesPortamento || usesPitchBreak) {
          // N163は間接アドレッシング(オートインクリメント+位相byte空読み)のみで、
          // 2A03等のような「上位バイト書込みで位相リセット」という副作用が無いため
          // (compiler.jsのwriteN163Freqもlastガード無しで毎フレーム全バイトを書く)、
          // LASTHIチェックは不要で毎フレーム無条件に書く。波形アドレス(+6)の再書込みは
          // 音符アタック時のみなのでここでは行わない
          n163Handlers.push(`
; --- N163 ch${ch}のEP<n>/MP<n>継続フレーム専用(周波数のみ再書込み) ---
WFO_T${t}:
    STX ${hex(CHIDX)}
    LDA ${hex(NOTE)},X
    CMP #${hex(n163TableMax)}
    BCC WFO${t}_OK
    LDA #${hex(n163TableMax)}
WFO${t}_OK:
    STA ${hex(PERLO)}
    CLC
    ADC ${hex(PERLO)}
    CLC
    ADC ${hex(PERLO)}
    TAY
${tableRead}
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE_N163
    LDA #${hex(regBase | 0x80)}
    STA $F800
    LDA ${hex(PERLO)}
    STA $4800
    LDA $4800
    LDA ${hex(PERHI)}
    STA $4800
    LDA $4800
    LDA ${hex(PERLO2)}
    STA $4800
    RTS`);
          wfoEntries[t] = `WFO_T${t}`;
        }
      }
      extraHandlers.push(n163Handlers.join('\n'));
      extraHandlers.push(`
; --- N163用D<n>/EP<n>/MP<n>共通処理。PERLO/PERHI/PERLO2に freqReg(18bit、3バイト:
; 下位/中位/上位2bit)が入っている状態で呼ぶ(呼出し前提はAPPLY_DETUNEと同じ、
; X=チャンネル番号)。PERLO2の上位6bitは波形長定数($F0)がOR済みなので、まず
; AND #$03で真の上位2bitだけを取り出してから16bit加算+3バイト目への符号拡張
; (各オフセットのbit7)を通常の多倍長2の補数加算として行う(D<n>のブロックの直後の
; ADC PERLO2はD<n>16bit加算のキャリーを引き継ぐ。CLCを挟まないのが重要。EP/MPも
; 同様に自ブロック内のキャリーを引き継ぐ)。3つとも加算し終えた最終結果が負(PERLO2の
; bit7が立つ)ならPERLO/PERHI/PERLO2=0にクランプし、そうでなければ上位2bitを
; 再度AND #$03でマスクしてから波形長定数を戻す ---
APPLY_DETUNE_N163:
    LDA ${hex(PERLO2)}
    AND #$03
    STA ${hex(PERLO2)}
    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(DETUNE_LO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(DETUNE_HI)},X
    STA ${hex(PERHI)}
    LDA ${hex(DETUNE_HI)},X
    AND #$80
    BEQ ADN163_D_POS
    LDA #$FF
    JMP ADN163_D_EXT
ADN163_D_POS:
    LDA #$00
ADN163_D_EXT:
    ADC ${hex(PERLO2)}
    STA ${hex(PERLO2)}
${usesEp ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(EPVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(EPVALHI)},X
    STA ${hex(PERHI)}
    LDA ${hex(EPVALHI)},X
    AND #$80
    BEQ ADN163_EP_POS
    LDA #$FF
    JMP ADN163_EP_EXT
ADN163_EP_POS:
    LDA #$00
ADN163_EP_EXT:
    ADC ${hex(PERLO2)}
    STA ${hex(PERLO2)}
` : ''}${usesMp ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(MPVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(MPVALHI)},X
    STA ${hex(PERHI)}
    LDA ${hex(MPVALHI)},X
    AND #$80
    BEQ ADN163_MP_POS
    LDA #$FF
    JMP ADN163_MP_EXT
ADN163_MP_POS:
    LDA #$00
ADN163_MP_EXT:
    ADC ${hex(PERLO2)}
    STA ${hex(PERLO2)}
` : ''}${usesPortamento ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(PTVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(PTVALHI)},X
    STA ${hex(PERHI)}
    LDA ${hex(PTVALHI)},X
    AND #$80
    BEQ ADN163_PT_POS
    LDA #$FF
    JMP ADN163_PT_EXT
ADN163_PT_POS:
    LDA #$00
ADN163_PT_EXT:
    ADC ${hex(PERLO2)}
    STA ${hex(PERLO2)}
` : ''}    LDA ${hex(PERLO2)}
    BPL ADN163_OK
    LDA #$00
    STA ${hex(PERLO)}
    STA ${hex(PERHI)}
    STA ${hex(PERLO2)}
    JMP ADN163_DONE
ADN163_OK:
    LDA ${hex(PERLO2)}
    AND #$03
    STA ${hex(PERLO2)}
ADN163_DONE:
    LDA ${hex(PERLO2)}
    ORA #$F0
    STA ${hex(PERLO2)}
    RTS`);
    }

    if (usesVrc7) {
      // VRC7: fnum(9bit)+block(3bit)。テーブルには
      // バイト1に「(block<<1)|(fnum上位1bit)」を事前計算して格納しておく
      // (実機レジスタ$20+chの下位ビットそのままの形)
      const words2 = [];
      for (let noteN = 0; noteN < NOTE_TABLE_SIZE; noteN++) {
        const { fnum, block } = vrc7FnumBlock(noteFrequency(noteN));
        words2.push(fnum & 0xff, (block << 1) | ((fnum >> 8) & 1));
      }
      extraTables.push(`VRC7_TABLE:\n${bytesToDb(new Uint8Array(words2))}`);
      const vrc7Handlers = [];
      for (let ch = 0; ch < 6; ch++) {
        const t = TYPE_VRC7_BASE + ch;
        vrc7Handlers.push(`
; --- VRC7 ch${ch} ($9010アドレス選択/$9030データ書込) ---
WFV_T${t}:
    STX ${hex(CHIDX)}
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC WFV${t}_OK
    LDA #${hex(TABLE_MAX)}
WFV${t}_OK:
    ASL A
    TAX
    LDA VRC7_TABLE,X
    STA ${hex(PERLO)}
    LDA VRC7_TABLE+1,X
    STA ${hex(PERHI)}
    LDX ${hex(CHIDX)}
    LDA #${hex(0x10 + ch)}
    STA $9010
    LDA ${hex(PERLO)}
    STA $9030
    LDA #${hex(0x20 + ch)}
    STA $9010
    LDA ${hex(PERHI)}
    ORA #$10
    STA $9030
    LDA #${hex(0x30 + ch)}
    STA $9010
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ORA ${hex(VOL)},X
    STA $9030
    RTS
SIL_T${t}:
    LDA #${hex(0x20 + ch)}
    STA $9010
    LDA #$00
    STA $9030
    LDA #${hex(0x30 + ch)}
    STA $9010
    LDA #$00
    STA $9030
    RTS`);
        wfvEntries[t] = `WFV_T${t}`;
        silEntries[t] = `SIL_T${t}`;
      }
      extraHandlers.push(vrc7Handlers.join('\n'));

      // カスタム音色(@OP<n>/@OT<n>)のOP<n>による曲中再ロード。VRC7はカスタム音色
      // スロットが$00-$07の1系統のみで全ch共有(patch=0で使われる)ため、どのチャンネルの
      // バイトコードストリームにOP<n>(0xF0オペコード)が出現しても、レジスタ書き込みの
      // 効果はチップ全体に及ぶ(compiler.jsのvrc7InitWrites/resolveVrc7ToneWriteと同じ)
      if (vrc7CustomTones.length > 0) {
        // src/driver/ppmckDriver.js usesFdsブロックのWFV13と同じ理由(音色の種類が
        // 増えるとBEQの分岐距離が±127byteを超えうる)で、BEQ/BNEは直後のJMP(範囲
        // 無制限)への短距離分岐のみに使う。
        const toneLoadBranches = vrc7CustomTones
          .map((idx, i) =>
            `    CMP #${hex(idx)}\n    BNE RD_VRC7TONE_SKIP_${i}\n    JMP RD_VRC7TONE_LOAD_${i}\nRD_VRC7TONE_SKIP_${i}:`).join('\n');
        const toneLoadBlocks = vrc7CustomTones.map((idx, i) => `
RD_VRC7TONE_LOAD_${i}:
    LDY #$00
RD_VRC7TONE_LOAD_${i}_LP:
    TYA
    STA $9010
    LDA VRC7_CUSTOM_TONE_${i},Y
    STA $9030
    INY
    CPY #$08
    BNE RD_VRC7TONE_LOAD_${i}_LP
    JMP RD_LOOP`).join('\n');
        extraHandlers.push(`
; --- OP<n>: VRC7カスタム音色再ロード(音符に紐付かない即時コマンド、0xF0) ---
RD_VRC7TONE:
    JSR READ_BYTE
    AND #$7F
${toneLoadBranches}
    JMP RD_LOOP     ; 対応するカスタム音色定義が無ければ何もしない(compiler.jsと同じ)
${toneLoadBlocks}`);
        const toneTables = vrc7CustomTones
          .map((idx, i) => `VRC7_CUSTOM_TONE_${i}:\n    .byte ${envelopes.op[idx].map(b => hex(b & 0xff)).join(',')}`)
          .join('\n');
        extraTables.push(toneTables);
      }
    }

    if (usesDpcm && dpcmIndices.length > 0) {
      // @<n>(instrument)で選択した@DPCM<n>サンプルを、音符が来るたびにトリガーする
      // (compiler.jsのsegmentsToWriteLogDpcmと同じロジック)。ノート音高(NOTE,X)は
      // そのサンプルのfreq(基準レート)を起点にdpcmRateIndexForNoteで最も近いDMCレートへ
      // 変換した値を108ノート分(NOTE_TABLE_SIZE)事前計算したテーブルを引く。
      // サンプル本体のバイト列自体はここでは埋め込まない($C000-$FFFF固定バンク4-7に
      // buildBankedNsfBytesが直接配置する。ここでは$4010-4013用のレジスタ値のみ埋め込む)
      const dpcmBranches = dpcmIndices.map((idx, i) => `    CMP #${hex(idx)}\n    BEQ DPCM_TRIGGER_${i}`).join('\n');
      const dpcmBlocks = dpcmIndices.map((idx, i) => {
        const layout = dpcmLayout[idx];
        const def = dpcmSamples[idx] || {};
        const rateTable = new Array(NOTE_TABLE_SIZE);
        for (let noteN = 0; noteN < NOTE_TABLE_SIZE; noteN++) {
          rateTable[noteN] = MML.Mml.dpcmRateIndexForNote(def.freq || 0, noteN) & 0x0F;
        }
        extraTables.push(`DPCM_RATE_TABLE_${i}:\n${bytesToDb(new Uint8Array(rateTable))}`);
        const modeBit = def.mode ? 0x40 : 0x00;
        return `
DPCM_TRIGGER_${i}:
    STX ${hex(CHIDX)}
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC DPCM_OK_${i}
    LDA #${hex(TABLE_MAX)}
DPCM_OK_${i}:
    TAX
    LDA DPCM_RATE_TABLE_${i},X
    ORA #${hex(modeBit)}
    STA ${hex(PERLO)}
    LDX ${hex(CHIDX)}
    LDA #$0F
    STA $4015       ; DMC一旦停止(2A03他chは維持)
    LDA ${hex(PERLO)}
    STA $4010
${layout.dac != null ? `    LDA #${hex(layout.dac)}\n    STA $4011\n` : ''}    LDA #${hex(layout.addrReg)}
    STA $4012
    LDA #${hex(layout.lengthReg)}
    STA $4013
    LDA #$1F
    STA $4015       ; 再生開始
    RTS`;
      }).join('\n');
      extraHandlers.push(`
; --- DPCM ($4010-4013、サンプル本体は固定バンク4-7=$C000-$FFFFに直接配置) ---
WFV_T${TYPE_DPCM}:
    LDA ${hex(DUTY)},X
${dpcmBranches}
    RTS     ; 対応するサンプルが無ければ何もしない(compiler.jsと同じ)
${dpcmBlocks}
SIL_T${TYPE_DPCM}:
    LDA #$0F
    STA $4015       ; DMC停止(2A03他chは維持)
    RTS`);
      wfvEntries[TYPE_DPCM] = `WFV_T${TYPE_DPCM}`;
      silEntries[TYPE_DPCM] = `SIL_T${TYPE_DPCM}`;
    }

    return `; ==========================================
; Sound Emulation Foundry - ppmck方式バイトコード再生ドライバ(バンク切り替え+拡張音源対応)
; チャンネル数: ${n} / 使用拡張音源: ${expansions.length ? expansions.join(',') : 'なし'}
; ==========================================
    .org $8000
    .res ${BANK_SIZE}       ; バンク0(未使用、窓0の初期表示分。使用前に必ず上書きされる)

    .org $9000

INIT:
    LDA #$0F
    STA $4015       ; 2A03全チャンネル有効化
    LDA #$00
    STA $4001       ; スイープ無効(パルス1)
    STA $4005       ; スイープ無効(パルス2)
${initExtra.join('\n')}

    LDX #$00
INIT_LOOP:
    LDA #$00
    STA ${hex(PTRLO)},X    ; PTRLO=0 (新バンクは常に$8000開始)
    LDA #$80
    STA ${hex(PTRHI)},X    ; PTRHI=$80
    LDA SONG_BANK,X
    STA ${hex(BANK)},X     ; このチャンネルの開始バンク番号
    LDA CH_TYPE_TABLE,X
    STA ${hex(CHTYPE)},X   ; このチャンネルの種別
    LDA #$01
    STA ${hex(CNT)},X      ; CNT=1 -> 最初のPLAYで即データ読み込み
    LDA #$00
    STA ${hex(VOL)},X      ; VOL=0
    STA ${hex(DUTY)},X     ; DUTY=0
    STA ${hex(ENVACT)},X   ; ENVACT=0(ソフトウェア音量エンベロープ無効)
${usesFme7 ? `    STA ${hex(FMEEACT)},X  ; FMEEACT=0(FME7ハードウェアエンベロープ無効)` : ''}
    LDA #$FF
    STA ${hex(LASTINS)},X  ; LASTINS=$FF(番兵。有効な音色番号0-127とは重複しない)
    LDA #$00
    STA ${hex(DETUNE_LO)},X ; DETUNE=0(D<n>未指定時の既定値)
    STA ${hex(DETUNE_HI)},X
${usesEp ? `    STA ${hex(EPACT)},X    ; EPACT=0(EP<n>未指定時の既定値)
    STA ${hex(EPVALLO)},X  ; ★EPVALLO/HIも0初期化(実機RAMの電源投入時の値は不定なため。
    STA ${hex(EPVALHI)},X  ;  下記RD_PITCHENV/RD_REST側の教訓と同じ理由、2026-08-11)` : ''}
${usesMp ? `    STA ${hex(MPACT)},X    ; MPACT=0(MP<n>未指定時の既定値)
    STA ${hex(MPVALLO)},X  ; ★MPVALLO/HIも0初期化(同上)
    STA ${hex(MPVALHI)},X` : ''}
${usesPortamento ? `    STA ${hex(PTACT)},X    ; PTACT=0(PT<n>未指定時の既定値)
    STA ${hex(PTVALLO)},X  ; ★PTVALLO/HIも0初期化(同上)
    STA ${hex(PTVALHI)},X` : ''}
    INX
    CPX #${hex(n)}
    BNE INIT_LOOP
    RTS

PLAY:
${playLines.join('\n')}
    RTS

; --- チャンネルX(0-N-1)を1フレーム分処理する ---
SERVICE_CH:
    DEC ${hex(CNT)},X
    BEQ SERVICE_CH_READ
${envTableCount === 0 && !usesFreqOnly ? '    JMP SERVICE_CH_END' : `${envTableCount > 0 ? `    ; 音符継続中(カウンタがまだ尽きていない)。ソフトウェア音量エンベロープが
    ; 有効なら、このフレーム分tickを進めて音量レジスタ"のみ"書き直す(周期/コントロール
    ; レジスタは書き直さない。WRITE_VOL_ONLYのコメント参照)
    LDA ${hex(ENVACT)},X
    BEQ SVC_NOENV
    INC ${hex(ENVTICK)},X
    JSR ENV_LOOKUP
    JSR WRITE_VOL_ONLY
SVC_NOENV:` : ''}
${usesEp ? `    ; EP<n>が有効なら、このフレーム分tickを進める(周期/周波数レジスタの再書込み自体は
    ; ENVACTと独立にSVC_FREQCHECKでまとめて行う。@vとD/EP/MPは音量側/周波数側で
    ; 完全に独立したパスなので、それぞれ個別に判定する)。delayの消化・テーブル参照は
    ; EP_STEP内で行う(RD_NOTEと共通のルーチン、2026-08-11 別プロジェクトA)
    LDA ${hex(EPACT)},X
    BEQ SVC_NOEP
    JSR EP_STEP
SVC_NOEP:` : ''}
${usesMp ? `    LDA ${hex(MPACT)},X
    BEQ SVC_NOMP
    JSR LFO_SUB
SVC_NOMP:` : ''}
${usesPortamento ? `    ; PT<n>が有効なら、このフレーム分の状態を進める(delayの消化・ステップ加算は
    ; PT_STEP内で行う、2026-08-11 別プロジェクトC)
    LDA ${hex(PTACT)},X
    BEQ SVC_NOPT
    JSR PT_STEP
SVC_NOPT:` : ''}
${usesFreqOnly ? `    LDA #$00
${usesEp ? `    ORA ${hex(EPACT)},X` : ''}
${usesMp ? `    ORA ${hex(MPACT)},X` : ''}
${usesPortamento ? `    ORA ${hex(PTACT)},X` : ''}
    BEQ SVC_NOFREQ
    JSR WRITE_FREQ_ONLY
SVC_NOFREQ:` : ''}
    JMP SERVICE_CH_END`}
SERVICE_CH_READ:
    JSR READ_DATA
SERVICE_CH_END:
    RTS

; --- A=[CURPTR]を読み、CURPTRを1進める ---
READ_BYTE:
    LDY #$00
    LDA (${hex(CURLO)}),Y
    PHA
    INC ${hex(CURLO)}
    BNE RB_DONE
    INC ${hex(CURHI)}
RB_DONE:
    PLA
    RTS

; --- チャンネルX(0-N-1)のデータを、カウンタが尽きるまで読み進める ---
; データ読み出し前に必ずこのチャンネルの現在バンクを窓0($5FF8)へ反映する
READ_DATA:
    LDA ${hex(BANK)},X
    STA $5FF8
    LDA ${hex(PTRLO)},X
    STA ${hex(CURLO)}
    LDA ${hex(PTRHI)},X
    STA ${hex(CURHI)}
; ディスパッチ本体から遠いラベル(RD_ENDTRACK等)へは直接BEQできない場合があるため
; (6502の分岐命令は±127バイトの範囲制限がある)、いったん直近のRD_JMP_*で
; 受けてからJMPで飛ぶ2段構成にする
RD_LOOP:
    JSR READ_BYTE
    CMP #$FF
    BEQ RD_JMP_ENDTRACK
    CMP #$EE
    BEQ RD_JMP_BANKJUMP
${usesPitchBreak ? '    CMP #$ED\n    BEQ RD_JMP_PITCHBREAK' : ''}
    CMP #$FD
    BEQ RD_JMP_VOL
    CMP #$FE
    BEQ RD_JMP_TONE
    CMP #$FC
    BEQ RD_JMP_REST
    CMP #$F4
    BEQ RD_JMP_WAIT
    CMP #$F7
    BEQ RD_SKIP1
${usesEp ? '    CMP #$F8\n    BEQ RD_JMP_PITCHENV' : '    CMP #$F8\n    BEQ RD_SKIP1'}
${usesMp ? '    CMP #$FB\n    BEQ RD_JMP_VIBRATO' : '    CMP #$FB\n    BEQ RD_SKIP1'}
${usesPortamento ? '    CMP #$F9\n    BEQ RD_JMP_PORTAMENTO' : '    CMP #$F9\n    BEQ RD_SKIP4'}
    CMP #$FA
    BEQ RD_JMP_DETUNE
${envTableCount > 0 ? '    CMP #$F3\n    BEQ RD_JMP_VOLENV' : ''}
${usesFme7 ? '    CMP #$F1\n    BEQ RD_JMP_FME7NOISE\n    CMP #$F2\n    BEQ RD_JMP_FME7HENV' : ''}
${vrc7CustomTones.length > 0 ? '    CMP #$F0\n    BEQ RD_JMP_VRC7TONE' : ''}
${usesFds ? '    CMP #$F5\n    BEQ RD_JMP_FDSMOD' : ''}
${usesN163CustomWaves ? '    CMP #$F6\n    BEQ RD_JMP_N163RELOC' : ''}
    JMP RD_NOTE

RD_JMP_ENDTRACK:
    JMP RD_ENDTRACK
RD_JMP_BANKJUMP:
    JMP RD_BANKJUMP
${usesPitchBreak ? 'RD_JMP_PITCHBREAK:\n    JMP RD_PITCHBREAK' : ''}
RD_JMP_REST:
    JMP RD_REST
RD_JMP_WAIT:
    JMP RD_WAIT
RD_JMP_VOL:
    JMP RD_VOL
RD_JMP_TONE:
    JMP RD_TONE
RD_JMP_DETUNE:
    JMP RD_DETUNE
${usesEp ? 'RD_JMP_PITCHENV:\n    JMP RD_PITCHENV' : ''}
${usesMp ? 'RD_JMP_VIBRATO:\n    JMP RD_VIBRATO' : ''}
${usesPortamento ? 'RD_JMP_PORTAMENTO:\n    JMP RD_PORTAMENTO' : ''}
${envTableCount > 0 ? 'RD_JMP_VOLENV:\n    JMP RD_VOLENV' : ''}
${vrc7CustomTones.length > 0 ? 'RD_JMP_VRC7TONE:\n    JMP RD_VRC7TONE' : ''}
${usesFds ? 'RD_JMP_FDSMOD:\n    JMP RD_FDSMOD' : ''}
${usesFme7 ? 'RD_JMP_FME7NOISE:\n    JMP RD_FME7NOISE\nRD_JMP_FME7HENV:\n    JMP RD_FME7HENV' : ''}
${usesN163CustomWaves ? 'RD_JMP_N163RELOC:\n    JMP RD_N163RELOC' : ''}

; 0xEEマーカーの残り3バイト(新バンク番号,新アドレス下位,新アドレス上位)は
; まだ「現在のバンク」の中に物理的に置かれているため、3バイト全て読み終えるまでは
; CURPTRを書き換えてはいけない(新アドレス下位を即書きすると、CURPTRの下位バイトが
; 新バンクの位置に化けてしまい、3バイト目を旧バンクの正しい続きから読めなくなる
; バグがあった)。PERLO/PERHI(未使用のPERIOD一時領域)にいったん退避し、
; 3バイト全部読み終えてから最後にCURPTRとバンクを更新する
RD_BANKJUMP:
    JSR READ_BYTE
    STA ${hex(BANK)},X     ; 新バンク番号を記憶(まだ$5FF8には反映しない)
    JSR READ_BYTE
    STA ${hex(PERLO)}      ; 新アドレス下位を一時保存(まだCURPTRには書かない)
    JSR READ_BYTE
    STA ${hex(PERHI)}      ; 新アドレス上位を一時保存
    LDA ${hex(BANK)},X
    STA $5FF8       ; ここで新バンクを反映
    LDA ${hex(PERLO)}
    STA ${hex(CURLO)}      ; ここでようやくCURPTRを新アドレスへ更新
    LDA ${hex(PERHI)}
    STA ${hex(CURHI)}
    JMP RD_LOOP

RD_SKIP1:
    JSR READ_BYTE
    JMP RD_LOOP

RD_SKIP3:
    JSR READ_BYTE
    JSR READ_BYTE
    JSR READ_BYTE
    JMP RD_LOOP

RD_SKIP4:
    JSR READ_BYTE
    JSR READ_BYTE
    JSR READ_BYTE
    JSR READ_BYTE
    JMP RD_LOOP
${usesFme7 ? `
; --- N<n>(0xF1): FME7ノイズ周期(R6、3ch共有)。直後1バイトが0-31。
; READ_BYTEはAを返すので、先にレジスタ番号6をラッチしてから読む(退避用zpが要らない) ---
RD_FME7NOISE:
    LDA #$06
    STA $C000
    JSR READ_BYTE
    AND #$1F
    STA $E000
    JMP RD_LOOP

; --- S<n>/M<n>(0xF2): FME7ハードウェアエンベロープ。直後3バイトが[形状,周期下位,周期上位]。
; 実際のレジスタ書き込みは音符ごとにFME7_WRITE_VOLが行う(音符のたびに位相を
; リセットする必要があるため、ここでは値を覚えてこのchを有効化するだけ) ---
RD_FME7HENV:
    JSR READ_BYTE
    AND #$0F
    STA ${hex(FMEESH)}
    JSR READ_BYTE
    STA ${hex(FMEEPL)}
    JSR READ_BYTE
    STA ${hex(FMEEPH)}
    LDA #$01
    STA ${hex(FMEEACT)},X
    JMP RD_LOOP` : ''}

RD_VOL:
    JSR READ_BYTE
    AND #$0F
    STA ${hex(VOL)},X
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X   ; 明示的な音量指定はソフトウェアエンベロープを解除する` : ''}
${usesFme7 ? `    LDA #$00\n    STA ${hex(FMEEACT)},X  ; 同じくFME7ハードウェアエンベロープも解除する` : ''}
    JMP RD_LOOP
${envTableCount > 0 ? `
RD_VOLENV:
    JSR READ_BYTE
    STA ${hex(ENVSEL)},X
    LDA #$01
    STA ${hex(ENVACT)},X
    LDA #$00
    STA ${hex(ENVTICK)},X
${usesFme7 ? `    STA ${hex(FMEEACT)},X  ; @v<n>とFME7ハードウェアエンベロープは排他` : ''}
    JMP RD_LOOP` : ''}

RD_TONE:
    JSR READ_BYTE
    AND #$7F       ; OP_TONEバイトコードの0-127全域を保持(以前は#$0Fで4bitに切り詰めていた
                    ; バグ。ASL A連鎖で使うVRC7パッチ選択等は256の剰余により結果不変なので
                    ; マスク幅を広げても既存チップの挙動には影響しない)
    STA ${hex(DUTY)},X
    JMP RD_LOOP
${usesN163CustomWaves ? `
; --- N163共有バッファアロケータ(0xF6): 直後1バイトがこのchの波形バイトオフセット。
; 波形の中身自体はこの後に続くOP_TONE(音色番号)の変化検知(N163_TONE_CHECK)で選ばれる ---
RD_N163RELOC:
    JSR READ_BYTE
    STA ${hex(WAVEOFS)},X
    JMP RD_LOOP` : ''}

; --- D<n>デチューン(0xFA): 直後2バイトが符号付き16bit値(下位,上位)。次の音符から
; APPLY_DETUNE/APPLY_DETUNE_N163が使う。値そのものを覚えるだけで周期計算はしない ---
RD_DETUNE:
    JSR READ_BYTE
    STA ${hex(DETUNE_LO)},X
    JSR READ_BYTE
    STA ${hex(DETUNE_HI)},X
    JMP RD_LOOP
${usesEp ? `
; --- EP<n>,<delay>ピッチエンベロープ選択(0xF8): 次の2バイトが[ROM上のコンパクトな
; テーブル番号($FF=EPOF、解除),delay]。delayはEPDELAYSETへ保存するだけ(2026-08-11
; 別プロジェクトA)。実際の値の反映(EPDELAY/EPTICKリセット+EP_STEP)はRD_NOTE
; (音符アタック時)で行う。ここではEPACT/EPSEL/EPDELAYSETを更新するだけ
; (@v<n>のRD_VOLENVと同じ設計)。offでも2バイト目(delay)は固定長デコードのため読み捨てる ---
RD_PITCHENV:
    JSR READ_BYTE
    CMP #$FF
    BNE RD_PITCHENV_ON
    JSR READ_BYTE
    LDA #$00
    STA ${hex(EPACT)},X
    STA ${hex(EPVALLO)},X  ; ★EPOFで累積値も0に戻す(2026-08-11修正: 戻さないと次に
    STA ${hex(EPVALHI)},X  ;  EP無指定の音符が続いた時、直前のEP値がAPPLY_DETUNEへ
                            ;  漏れ続ける暴走バグだった。PT実装時の往復検証で発覚)
    JMP RD_LOOP
RD_PITCHENV_ON:
    STA ${hex(EPSEL)},X
    JSR READ_BYTE
    STA ${hex(EPDELAYSET)},X
    LDA #$01
    STA ${hex(EPACT)},X
    LDA #$00
    STA ${hex(EPTICK)},X
    JMP RD_LOOP` : ''}
${usesMp ? `
; --- MP<n>ビブラート選択(0xFB): 次バイトはROM上のコンパクトなテーブル番号($FF=MPOF、解除)。
; MP<n>選択の瞬間にwarizan(除算)を1回だけ行いMPSTEPSZ/MPSTEPINTを確定する(実機
; lfo_set_sub+warizan_start相当。DESIGN-PITCH.md別プロジェクトB参照)。状態の初期化
; (delay/quarterのリセット・LFO_SUB初回呼び出し)はRD_NOTE(音符アタック時)で行う ---
RD_VIBRATO:
    JSR READ_BYTE
    CMP #$FF
    BNE RD_VIBRATO_ON
    LDA #$00
    STA ${hex(MPACT)},X
    STA ${hex(MPVALLO)},X  ; ★MPOFで累積値も0に戻す(RD_PITCHENVと同じ2026-08-11修正)
    STA ${hex(MPVALHI)},X
    JMP RD_LOOP
RD_VIBRATO_ON:
    STA ${hex(MPSEL)},X
    TAY
    LDA #$01
    STA ${hex(MPACT)},X
    LDA MP_SPEED,Y
    STA ${hex(CDA)}        ; quarter(候補a)
    LDA MP_DEPTH,Y
    STA ${hex(CDB)}        ; rawDepth(候補b)
    LDA ${hex(CDA)}
    CMP ${hex(CDB)}
    BCC RDV_DEPTHBIG
    ; quarter >= rawDepth: stepInterval=ceilDiv(quarter,rawDepth), stepSize=1
    JSR CEILDIV
    STA ${hex(MPSTEPINT)},X
    LDA #$01
    STA ${hex(MPSTEPSZ)},X
    JMP RD_LOOP
RDV_DEPTHBIG:
    ; rawDepth > quarter: stepSize=ceilDiv(rawDepth,quarter), stepInterval=1
    LDA ${hex(CDB)}
    PHA
    LDA ${hex(CDA)}
    STA ${hex(CDB)}
    PLA
    STA ${hex(CDA)}
    JSR CEILDIV
    STA ${hex(MPSTEPSZ)},X
    LDA #$01
    STA ${hex(MPSTEPINT)},X
    JMP RD_LOOP` : ''}
${usesPortamento ? `
; --- PT<target>,<duration>[,<delay>]ポルタメント選択(0xF9): 次の4バイトが
; [target下位,target上位,duration,delay]。duration=0を番兵としてoff(PTOF)を表す。
; target上位バイトは|target|<=255前提の単なる符号拡張バイト($00/$FF)なので、そのまま
; PTDIRとして使う(MPのような方向テーブルは不要、targetの符号自体が方向を持つ)。
; |target|とdurationの大小比較+CEILDIVでPTSTEPSZ/PTSTEPINTを確定する(RD_VIBRATOと
; 同型)。状態の初期化(delay/durationリセット・PT_STEP初回呼び出し)はRD_NOTE
; (音符アタック時)で行う ---
RD_PORTAMENTO:
    JSR READ_BYTE
    STA ${hex(PERLO)}          ; target下位(このハンドラ内だけのスクラッチとして再利用)
    JSR READ_BYTE
    STA ${hex(PTDIR)},X        ; target上位=$00(+)/$FF(-)をそのままdirとして使う
    JSR READ_BYTE
    STA ${hex(PTDURSET)},X
    JSR READ_BYTE
    STA ${hex(PTDELAYSET)},X
    LDA ${hex(PTDURSET)},X
    BNE RD_PORTAMENTO_ON
    LDA #$00
    STA ${hex(PTACT)},X
    STA ${hex(PTVALLO)},X  ; ★PTOFで累積値も0に戻す(RD_PITCHENVと同じ2026-08-11修正)
    STA ${hex(PTVALHI)},X
    JMP RD_LOOP
RD_PORTAMENTO_ON:
    LDA #$01
    STA ${hex(PTACT)},X
    LDA ${hex(PTDIR)},X
    BEQ RD_PORTAMENTO_POS
    LDA #$00
    SEC
    SBC ${hex(PERLO)}
    JMP RD_PORTAMENTO_ABSDONE
RD_PORTAMENTO_POS:
    LDA ${hex(PERLO)}
RD_PORTAMENTO_ABSDONE:
    STA ${hex(CDB)}            ; |target|(候補b)
    LDA ${hex(PTDURSET)},X
    STA ${hex(CDA)}            ; duration(候補a)
    CMP ${hex(CDB)}
    BCC RD_PORTAMENTO_TARGETBIG
    ; duration >= |target|: stepInterval=ceilDiv(duration,|target|), stepSize=1
    JSR CEILDIV
    STA ${hex(PTSTEPINT)},X
    LDA #$01
    STA ${hex(PTSTEPSZ)},X
    JMP RD_LOOP
RD_PORTAMENTO_TARGETBIG:
    ; |target| > duration: stepSize=ceilDiv(|target|,duration), stepInterval=1
    LDA ${hex(CDB)}
    PHA
    LDA ${hex(CDA)}
    STA ${hex(CDB)}
    PLA
    STA ${hex(CDA)}
    JSR CEILDIV
    STA ${hex(PTSTEPSZ)},X
    LDA #$01
    STA ${hex(PTSTEPINT)},X
    JMP RD_LOOP` : ''}

RD_REST:
    JSR READ_BYTE
    STA ${hex(CNT)},X
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X   ; 休符中はソフトウェアエンベロープを進めない` : ''}
    ; ★2026-08-11修正(PT実装時の往復検証で発覚): EP<n>/MP<n>/PT<n>はここでEPACT/MPACT/
    ; PTACTをクリアしていなかった/していた版いずれも問題があった。compiler.js側は休符
    ; トークンでstate.pitchEnv/vibrato/portamentoを一切変更しない(EPOF/MPOF/PTOFや
    ; 新しいEP/MP/PT<n>コマンドでのみ変わる)ため、休符明けの次の音符は休符前の設定を
    ; そのまま引き継いで最初からグライド/LFOし直す、という仕様。旧実装はここでACTを
    ; クリアしていたためRD_NOTEの再初期化ブロックが丸ごとスキップされ、休符明けの
    ; 音符でEP/MP/PTが無効化されたまま復帰しない別バグになっていた。ACTは触らず
    ; そのまま維持する(次の音符はRD_NOTEが常にdelay/tick/累積値を再初期化するので、
    ; 休符中に値が古いままでも実害は無い。休符中もEP_STEP/LFO_SUB/PT_STEPは走り続ける
    ; ため周期レジスタへの無音時の余分な書込みは発生するが、SILENCE_CHが音量を0にして
    ; いるため無音のまま)
    JSR SILENCE_CH
    JMP RD_RETURN

RD_WAIT:
    JSR READ_BYTE
    STA ${hex(CNT)},X
    JMP RD_RETURN
${usesPitchBreak ? `
; --- タイ(&)による異音程レガート(0xED、2026-08-12): 次の2バイトが[新ノート番号,音長]。
; RD_NOTEと違い音量/エンベロープ/EP・MP・PTのdelay/tick再初期化(reset)は一切行わない
; (compiler.jsのpitchBreaks/activePitchAtが「タイで繋いだ1つのセグメント全体を通して
; vibSeq/ptSeqを連続したtickで参照し続ける、区切りでは再スタートしない」設計のため、
; 6502側もEPTICK/MPADCCNT/PTSTEPCNTを触らずそのまま続行させる必要がある)。
; このフレームはCNTがちょうど0になりSERVICE_CH本体の継続処理(EP_STEP/LFO_SUB/PT_STEP
; +WRITE_FREQ_ONLYの毎フレーム呼び出し)がスキップされてここへディスパッチされてくるため、
; そのぶんを肩代わりして1tickだけ進めてから書く(進めないとcompiler.js側のtickと
; 1フレームずれる。RD_NOTEが音符アタック時に一度だけEP_STEP等を呼ぶのと対称の理由) ---
RD_PITCHBREAK:
    JSR READ_BYTE
    STA ${hex(NOTE)},X
    JSR READ_BYTE
    STA ${hex(CNT)},X
${usesEp ? `    LDA ${hex(EPACT)},X
    BEQ RPB_NOEP
    JSR EP_STEP
RPB_NOEP:` : ''}
${usesMp ? `    LDA ${hex(MPACT)},X
    BEQ RPB_NOMP
    JSR LFO_SUB
RPB_NOMP:` : ''}
${usesPortamento ? `    LDA ${hex(PTACT)},X
    BEQ RPB_NOPT
    JSR PT_STEP
RPB_NOPT:` : ''}
    JSR WRITE_FREQ_ONLY
    JMP RD_RETURN
` : ''}
RD_NOTE:
    STA ${hex(NOTE)},X
    JSR READ_BYTE
    STA ${hex(CNT)},X
${envTableCount > 0 ? `    LDA ${hex(ENVACT)},X   ; エンベロープ有効なら"この音符から"必ずtick0で再スタートする。\n                    ; mckBytecode.js側はテーブル番号が前の音符と同じ場合OP_VOL_ENVを\n                    ; 出し直さない(バイトコード節約)ため、ここでENVACTを見るだけで\n                    ; ENVTICKのリセットを省略すると前の音符の続きから再生されてしまう\n                    ; バグになる(compiler.js側は音符ごとに独立してtick0から辿るため\n                    ; この問題が起きない。JS側との差異はここだけだった)\n    BEQ RD_NOTE_NOENV\n    LDA #$00\n    STA ${hex(ENVTICK)},X\n    JSR ENV_LOOKUP\nRD_NOTE_NOENV:` : ''}
${usesEp ? `    ; EP<n>,<delay>も同じ理由(@v<n>のRD_NOTE_NOENVと同一のバグパターン)で"この音符から"
    ; 必ずEPDELAYSET/tick0から再初期化する(2026-08-11 別プロジェクトA)。リセット後は
    ; SERVICE_CHの継続フレームと同じEP_STEPを呼ぶ(post-increment設計によりRD_NOTE専用の
    ; 特別扱いが不要になった、EP_STEP冒頭コメント参照)
    LDA ${hex(EPACT)},X
    BEQ RD_NOTE_NOEP
    LDA ${hex(EPDELAYSET)},X
    STA ${hex(EPDELAY)},X
    LDA #$00
    STA ${hex(EPTICK)},X
    JSR EP_STEP
RD_NOTE_NOEP:` : ''}
${usesMp ? `    ; MP<n>も"この音符から"必ずdelay/quarterからリセットする(実機effect_init相当)。
    ; MPSTEPSZ/MPSTEPINTはMP<n>選択時(RD_VIBRATO)に計算済みの値をそのまま使う。
    ; リセット直後にLFO_SUB を1回呼び、1フレーム目(delay=0なら即座に動き出す)の値まで
    ; 進めてからWRITE_FREQ_VOL(APPLY_DETUNE)に渡す(compiler.jsのvibratoSequenceが
    ; t=0から通常のフレーム処理ループに入るのと同じ)
    LDA ${hex(MPACT)},X
    BEQ RD_NOTE_NOMP
    LDA ${hex(MPSEL)},X
    TAY
    LDA MP_DELAY,Y
    STA ${hex(MPSTARTCNT)},X
    LDA MP_SPEED,Y
    STA ${hex(MPREVCNT)},X
    ASL A
    STA ${hex(MPQUARTER2)},X
    LDA ${hex(MPSTEPINT)},X
    STA ${hex(MPADCCNT)},X
    LDA #$00
    STA ${hex(MPVALLO)},X
    STA ${hex(MPVALHI)},X
    LDA ${hex(CHTYPE)},X
    TAY
    LDA MP_DIR_TABLE,Y
    STA ${hex(MPDIR)},X
    JSR LFO_SUB
RD_NOTE_NOMP:` : ''}
${usesPortamento ? `    ; PT<n>も"この音符から"必ずdelay/duration/stepcnt/累積値を再初期化する
    ; (2026-08-11 別プロジェクトC。EP_STEPと同じpost-increment単一ルーチン設計、
    ; MPのようなRD_NOTE専用の特別扱いは不要)
    LDA ${hex(PTACT)},X
    BEQ RD_NOTE_NOPT
    LDA ${hex(PTDELAYSET)},X
    STA ${hex(PTDELAY)},X
    LDA ${hex(PTDURSET)},X
    STA ${hex(PTDUR)},X
    LDA ${hex(PTSTEPINT)},X
    STA ${hex(PTSTEPCNT)},X
    LDA #$00
    STA ${hex(PTVALLO)},X
    STA ${hex(PTVALHI)},X
    JSR PT_STEP
RD_NOTE_NOPT:` : ''}
    JSR WRITE_FREQ_VOL
    JMP RD_RETURN

RD_ENDTRACK:
    ; トラック終端。このチャンネルにL(ループ地点マーカー)があれば、SONG_LOOP_ACTで
    ; 無音化せずそこへジャンプして演奏を続ける(実機同様の無限ループ。0xA0/0xA1による
    ; 小節単位の繰り返しループは引き続き未対応)。無ければ従来通り無音化して停止する
    ; (音符が1つも無い空トラックでも安全なように、ポインタ/バンクは変更せず
    ; カウンタだけ最大にして抜ける。次にCNTが尽きたら同じ0xFFに再度到達し、
    ; また安全に停止するだけ)
    LDA SONG_LOOP_ACT,X
    BEQ RD_ENDTRACK_STOP
    LDA SONG_LOOP_BANK,X
    STA ${hex(BANK)},X
    STA $5FF8
    LDA SONG_LOOP_PTR_LO,X
    STA ${hex(CURLO)}
    STA ${hex(PTRLO)},X
    LDA SONG_LOOP_PTR_HI,X
    STA ${hex(CURHI)}
    STA ${hex(PTRHI)},X
    JMP RD_LOOP
RD_ENDTRACK_STOP:
    JSR SILENCE_CH
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X` : ''}
    LDA #$FF
    STA ${hex(CNT)},X
    RTS

RD_RETURN:
    LDA ${hex(CURLO)}
    STA ${hex(PTRLO)},X
    LDA ${hex(CURHI)}
    STA ${hex(PTRHI)},X
    RTS

; --- チャンネルX(0-N-1)を無音化する(種別テーブル経由でハンドラへ間接ジャンプ) ---
SILENCE_CH:
    LDA ${hex(CHTYPE)},X
    ASL A
    TAY
    LDA SIL_JUMPTABLE,Y
    STA ${hex(JMPLO)}
    LDA SIL_JUMPTABLE+1,Y
    STA ${hex(JMPHI)}
    JMP (${hex(JMPLO)})

; --- チャンネルX(0-N-1)の現在のNOTE/VOL/DUTYをAPUレジスタへ反映する ---
; (種別テーブル経由でハンドラへ間接ジャンプする)
WRITE_FREQ_VOL:
    LDA ${hex(CHTYPE)},X
    ASL A
    TAY
    LDA WFV_JUMPTABLE,Y
    STA ${hex(JMPLO)}
    LDA WFV_JUMPTABLE+1,Y
    STA ${hex(JMPHI)}
    JMP (${hex(JMPLO)})
${envTableCount > 0 ? `
; --- チャンネルX(0-N-1)の音量レジスタ"のみ"をAPUへ反映する(ソフトウェア音量エンベロープの
; 毎フレームtick更新専用。周期/コントロールレジスタは書き換えない)。
; SERVICE_CHが音符継続中に毎フレームWRITE_FREQ_VOLを呼ぶと、2A03/MMC5パルスの
; $4003/$4007/$5003/$5007等(ハイバイト書込みでシーケンサ位相をリセットする実機の仕様)を
; 毎フレーム書き直すことになり、音符が鳴っている間ずっと位相リセットが繰り返されて
; 濁った/音程が揺れて聞こえる音になってしまうバグがあった。compiler.js側のJS参照実装
; (writeVolumeEnvelope)は元々音量レジスタしか書いておらず、周期の再書き込みはしていない
; ── 6502側の実装だけがこの前提から外れていたのが原因(RD_NOTE、音符アタック時のみは
; 引き続きWRITE_FREQ_VOLのフル書込みを使う。JS側も音符先頭では周期を書くため一致する) ---
WRITE_VOL_ONLY:
    LDA ${hex(CHTYPE)},X
    ASL A
    TAY
    LDA WFV_VOL_JUMPTABLE,Y
    STA ${hex(JMPLO)}
    LDA WFV_VOL_JUMPTABLE+1,Y
    STA ${hex(JMPHI)}
    JMP (${hex(JMPLO)})
` : ''}
${usesFreqOnly ? `
; --- チャンネルX(0-N-1)の周期/周波数レジスタ"のみ"をAPUへ反映する(EP<n>/MP<n>の
; 毎フレーム継続再計算専用。音量レジスタは書き換えない、WRITE_VOL_ONLYの対称形)。
; D<n>と同じ「発音周波数レジスタへの生オフセット」空間で毎フレーム値が変わりうるため、
; 位相リセット等の副作用を持つ上位バイトはLASTHI,Xと比較し実際に変わった時だけ書く
; (WFV_T*内のコメント・compiler.js writePitchModulationのlastHiと同じ理由)。
; 下位バイト単体の書込みには副作用が無いため毎フレーム無条件で書いてよい ---
WRITE_FREQ_ONLY:
    LDA ${hex(CHTYPE)},X
    ASL A
    TAY
    LDA WFO_JUMPTABLE,Y
    STA ${hex(JMPLO)}
    LDA WFO_JUMPTABLE+1,Y
    STA ${hex(JMPHI)}
    JMP (${hex(JMPLO)})
` : ''}
; ============================================================
; 周波数テーブル参照の共通処理(2A03分は常に埋め込む。呼び出し前提: Xはチャンネル番号のまま。
; ${hex(NOTE)},Xから音程を読み、該当テーブルを引いてPERLO/PERHIへ格納する。
; 呼び出し後はXが破壊されるので、呼び出し元は${hex(CHIDX)}から復元すること)
; ============================================================
LOOKUP_PULSE_PERIOD:
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC LPP_OK
    LDA #${hex(TABLE_MAX)}
LPP_OK:
    ASL A
    TAX
    LDA PULSE_TABLE,X
    STA ${hex(PERLO)}
    LDA PULSE_TABLE+1,X
    STA ${hex(PERHI)}
    RTS

LOOKUP_TRI_PERIOD:
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC LTP_OK
    LDA #${hex(TABLE_MAX)}
LTP_OK:
    ASL A
    TAX
    LDA TRI_TABLE,X
    STA ${hex(PERLO)}
    LDA TRI_TABLE+1,X
    STA ${hex(PERHI)}
    RTS

; --- D<n>/EP<n>/MP<n>/PT<n>共通処理。呼出し前提: Xはチャンネル番号、PERLO/PERHIに
; テーブル参照済みの周期値が入っている状態で呼ぶ。DETUNE_LO/HI,X(符号付き16bit)を通常の
; 16bit ADCで加算し、続けてEP(EPVALLO/HI,X、有効時のみ)・MP(MPVALLO/HI,X、有効時のみ)・
; PT(PTVALLO/HI,X、有効時のみ、2026-08-11 別プロジェクトC)を同じく16bit ADCで加算する
; (2の補数表現なので符号付き値でもビット演算は加算と同一。compiler.jsの
; pitchRegisterOffsetがD+EP+MP+PTを1つの生オフセットに合算してから1回だけクランプ加算
; するのと数学的に同じ結果になる、逐次加算でも結合則で等価)。
; 最終的な加算結果が負(PERHIのbit7が立つ)ならPERLO/PERHI=0にクランプする(JS側=
; compiler.jsのapplyDetuneのMath.max(0,...)と同じ意図。上限側のクランプは行わない=
; 極端に大きいオフセットでレジスタ幅を超えるケースは非対応、通常の用途の値では発生しない)。
; Xは破壊しない ---
APPLY_DETUNE:
    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(DETUNE_LO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(DETUNE_HI)},X
    STA ${hex(PERHI)}
${usesEp ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(EPVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(EPVALHI)},X
    STA ${hex(PERHI)}
` : ''}${usesMp ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(MPVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(MPVALHI)},X
    STA ${hex(PERHI)}
` : ''}${usesPortamento ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(PTVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(PTVALHI)},X
    STA ${hex(PERHI)}
` : ''}    LDA ${hex(PERHI)}
    BPL APPLY_DETUNE_OK
    LDA #$00
    STA ${hex(PERLO)}
    STA ${hex(PERHI)}
APPLY_DETUNE_OK:
    RTS

; ============================================================
; 種別ごとのレジスタ書き込みハンドラ(WFV_T*)・無音化ハンドラ(SIL_T*)
; 2A03(T0-T3)は常時、拡張音源分(T4-T27)は実際に使うチップのみ埋め込む
; ============================================================

; --- 2A03パルスA ($4000) ---
WFV_T0:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4002
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $4003
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $4000
    RTS
SIL_T0:
    LDA #$30
    STA $4000
    RTS

; --- 2A03パルスB ($4004) ---
WFV_T1:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4006
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $4007
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $4004
    RTS
SIL_T1:
    LDA #$30
    STA $4004
    RTS

; --- 2A03三角波 ($4008、1chのみなので固定アドレス) ---
WFV_T2:
    STX ${hex(CHIDX)}
    JSR LOOKUP_TRI_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $400A
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $400B
    LDA ${hex(VOL)},X
    BEQ SIL_T2
    LDA #$FF
    STA $4008
    RTS
SIL_T2:
    LDA #$80
    STA $4008
    RTS

; --- 2A03ノイズ ($400C、1chのみなので固定アドレス) ---
WFV_T3:
    LDA ${hex(NOTE)},X
    AND #$0F
    STA ${hex(PERLO)}
    LDA #$0F
    SEC
    SBC ${hex(PERLO)}      ; A = 15 - (note & 15)
    STA $400E
    LDA #$00
    STA $400F
    LDA #$30
    ORA ${hex(VOL)},X
    STA $400C
    RTS
SIL_T3:
    LDA #$30
    STA $400C
    RTS

; --- 未対応/未使用チップのチャンネル: 何もしない(常時無音) ---
WFV_T12:
    RTS
SIL_T12:
    RTS
${usesFreqOnly ? `; --- EP<n>/MP<n>継続フレーム再計算: 2A03パルスA/B/三角波(常時)。対象外チップ
; (VRC7・ノイズ・未使用スロット等)はWFO_NONE(何もしない)を指す ---
WFO_NONE:
    RTS
WFO_T0:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4002
    LDA ${hex(PERHI)}
    CMP ${hex(LASTHI)},X
    BEQ WFO0_SKIPHI
    STA ${hex(LASTHI)},X
    STA $4003
WFO0_SKIPHI:
    RTS
WFO_T1:
    STX ${hex(CHIDX)}
    JSR LOOKUP_PULSE_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4006
    LDA ${hex(PERHI)}
    CMP ${hex(LASTHI)},X
    BEQ WFO1_SKIPHI
    STA ${hex(LASTHI)},X
    STA $4007
WFO1_SKIPHI:
    RTS
WFO_T2:
    STX ${hex(CHIDX)}
    JSR LOOKUP_TRI_PERIOD
    LDX ${hex(CHIDX)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $400A
    LDA ${hex(PERHI)}
    CMP ${hex(LASTHI)},X
    BEQ WFO2_SKIPHI
    STA ${hex(LASTHI)},X
    STA $400B
WFO2_SKIPHI:
    RTS` : ''}
${envTableCount > 0 ? `; --- ソフトウェア音量エンベロープ毎フレームtick更新: 音量のみ書込むハンドラ(WFV_VOL_T*)。
; 2A03パルスA/B/ノイズは常時、拡張音源分は実際に使うチップのみ埋め込む。エンベロープが
; 適用され得ないチップ種別(2A03三角波・未対応チップ等)はWFV_VOL_NONEを指す(何もしない) ---
WFV_VOL_NONE:
    RTS
WFV_VOL_T0:
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $4000
    RTS
WFV_VOL_T1:
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ASL A
    ORA #$30
    ORA ${hex(VOL)},X
    STA $4004
    RTS
WFV_VOL_T3:
    LDA #$30
    ORA ${hex(VOL)},X
    STA $400C
    RTS` : ''}
${extraHandlers.join('\n')}

WFV_JUMPTABLE:
    .word ${wfvEntries.join(',')}
SIL_JUMPTABLE:
    .word ${silEntries.join(',')}
${envTableCount > 0 ? `WFV_VOL_JUMPTABLE:\n    .word ${wfvVolEntries.join(',')}` : ''}
${usesFreqOnly ? `WFO_JUMPTABLE:\n    .word ${wfoEntries.join(',')}` : ''}

PULSE_TABLE:
${wordsToDb(buildPeriodTable(pulsePeriod))}

TRI_TABLE:
${wordsToDb(buildPeriodTable(trianglePeriod))}
${extraTables.join('\n\n')}

; チャンネルごとの種別(CH_TYPE_TABLE)と開始バンク番号(SONG_BANK)
CH_TYPE_TABLE:
    .byte ${channelTypes.join(',')}
SONG_BANK:
    .byte ${songBank.join(',')}
; L(ループ地点マーカー)対応: このチャンネルがトラック終端に達したときループするか
; (SONG_LOOP_ACT、0/1)、するならどこへ戻るか(バンク番号+アドレス下位/上位)。
; Lを使わないチャンネルはact=0で、バンク/アドレスの値自体は無視される(RD_ENDTRACK参照)
SONG_LOOP_ACT:
    .byte ${loopAct.join(',')}
SONG_LOOP_BANK:
    .byte ${loopBank.join(',')}
SONG_LOOP_PTR_LO:
    .byte ${loopLo.join(',')}
SONG_LOOP_PTR_HI:
    .byte ${loopHi.join(',')}
`;
  }

  // segmentsByChannel: Mml.compile()の戻り値の segmentsByChannel(2A03のA-Dのみ使用)。
  // 戻り値: 6502アセンブリソース文字列(固定領域のみ、2A03のみの簡易版。バンク非対応)。
  // 通常は buildBankedNsfBytes() を使うこと(拡張音源・バンク切り替え対応)
  Driver.buildPpmckSource = function (segmentsByChannel) {
    const channelTypes = [TYPE_2A03_PULSE_A, TYPE_2A03_PULSE_B, TYPE_2A03_TRI, TYPE_2A03_NOISE];
    const songBank = [DATA_START_BANK, DATA_START_BANK, DATA_START_BANK, DATA_START_BANK];
    return buildFixedSource(channelTypes, songBank, []);
  };

  // compileResult: MML.Mml.compile()の戻り値そのもの
  // (segmentsByChannel, channelLetters, expansions, expansionLetterMap を使う)。
  // headerOpt: NSF.buildHeaderと同じオプション。
  // 戻り値: { nsfBytes, asmErrors, bankCount, unsupportedExpansions }
  Driver.buildBankedNsfBytes = function (compileResult, headerOpt) {
    const channelLetters = compileResult.channelLetters || ['A', 'B', 'C', 'D'];
    const expansions = compileResult.expansions || [];
    const expansionLetterMap = compileResult.expansionLetterMap || {};
    const segmentsByChannel = compileResult.segmentsByChannel || {};
    const envelopes = compileResult.envelopes || {};
    const immediateWritesByChannel = compileResult.immediateWritesByChannel || {};

    const dpcmLayout = compileResult.dpcmLayout || {};
    const dpcmSamples = compileResult.dpcmSamples || {};

    const channelTypes = computeChannelTypes(expansions, expansionLetterMap);
    const SUPPORTED = ['vrc6', 'mmc5', 'fme7', 'fds', 'n163', 'vrc7', 'dpcm'];
    const unsupportedExpansions = expansions.filter(e => !SUPPORTED.includes(e));
    const usedExpansions = expansions.filter(e => SUPPORTED.includes(e));

    // OP<n>(VRC7カスタム音色再ロード)/MH<n>・MHOF(FDSモジュレーション再ロード)は
    // compiler.js側もそれぞれ対応するチップのチャンネルに書かれた場合のみ適用し、
    // それ以外のチャンネルに書かれたものは無視する(compiler.js:1146のexp==='vrc7'/
    // exp==='fds'判定と同じ挙動をここでも再現する)
    const vrc7Letters = new Set(expansionLetterMap.vrc7 || []);
    const fdsLetters = new Set(expansionLetterMap.fds || []);
    const n163Letters = new Set(expansionLetterMap.n163 || []);

    // N163共有バッファアロケータ: ブラウザプレビュー(compiler.js)と全く同じ計算
    // (MML.N163Alloc)をNSF書き出し時にも行い、両者が同じ音程・波形になるようにする
    // (周波数式・バイトオフセット計算を2箇所で独立実装して食い違わせた過去のN163バグと
    // 同種の事故を防ぐため、必ずこの1箇所だけを両者が呼ぶ)。128byteに収まらない場合は
    // compiler.js側と同じくエラーとして書き出しを中断する。
    const n163RelocsByChannel = {};
    if (expansions.includes('n163')) {
      const allocResult = MML.N163Alloc.allocate(
        Array.from(n163Letters), segmentsByChannel, envelopes.n, compileResult.totalFrames);
      if (allocResult.conflicts.length > 0) {
        return {
          nsfBytes: null,
          asmErrors: allocResult.conflicts.map(c => ({ lineNo: 0, message: c.message })),
          bankCount: 0,
          unsupportedExpansions
        };
      }
      for (const occ of allocResult.occurrences) {
        if (!n163RelocsByChannel[occ.channel]) n163RelocsByChannel[occ.channel] = [];
        n163RelocsByChannel[occ.channel].push({ kind: 'n163WaveReload', frame: occ.startFrame, value: occ.byteOffset });
      }
    }

    // ソフトウェア音量エンベロープ(@v<n>)のROM埋め込み用: 曲全体(全チャンネル)で
    // 実際に使われているenvelopeV値だけを集め、0始まりの連番(envIndexRemap)に詰め直す
    // (元の値は0-99=ソフトウェア由来/100番台=ハードウェア由来と範囲が空いているため、
    // そのままROM上の配列添字にすると無駄が大きい)。envelopes.vに実体が無い値は
    // (異常なMMLでない限り無いはずだが、念のため)除外する。
    const usedEnvIndices = new Set();
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.envelopeV != null && envelopes.v && envelopes.v[seg.envelopeV]) {
          usedEnvIndices.add(seg.envelopeV);
        }
      }
    }
    const envIndexList = Array.from(usedEnvIndices).sort((a, b) => a - b);
    const envIndexRemap = {};
    envIndexList.forEach((origIdx, i) => { envIndexRemap[origIdx] = i; });

    // EP<n>(ピッチエンベロープ)・MP<n>(ソフトウェアビブラート)も@vと全く同じ「実際に
    // 使われているインデックスだけをコンパクトに詰める」方式(2026-08-11実装)。
    // seg.pitchEnv/seg.vibratoは255=off、それ以外がenvelopes.ep/envelopes.mpへの生の添字
    const usedEpIndices = new Set();
    const usedMpIndices = new Set();
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.pitchEnv != null && seg.pitchEnv !== 255 && envelopes.ep && envelopes.ep[seg.pitchEnv]) {
          usedEpIndices.add(seg.pitchEnv);
        }
        if (seg.vibrato != null && seg.vibrato !== 255 && envelopes.mp && envelopes.mp[seg.vibrato]) {
          usedMpIndices.add(seg.vibrato);
        }
      }
    }
    const epIndexList = Array.from(usedEpIndices).sort((a, b) => a - b);
    const epIndexRemap = {};
    epIndexList.forEach((origIdx, i) => { epIndexRemap[origIdx] = i; });
    const mpIndexList = Array.from(usedMpIndices).sort((a, b) => a - b);
    const mpIndexRemap = {};
    mpIndexList.forEach((origIdx, i) => { mpIndexRemap[origIdx] = i; });

    // PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC): target/duration/delayは
    // バイトコード上に直接の即値として乗る(EP/MPのようなROM上の共有テーブル・
    // インデックス圧縮の概念が無い)ため、「1曲中で使われているかどうか」の真偽値だけを
    // 判定すればよい(ZP確保・オペコードハンドラの条件付き埋め込みに使う)
    let usesPortamento = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.portamento != null) { usesPortamento = true; break; }
      }
      if (usesPortamento) break;
    }

    // タイ(&)による異音程レガート(compiler.jsのpitchBreaks、2026-08-12)。PTと同じく
    // 曲中で使われているかどうかの真偽値だけ判定する(ZP確保・オペコードハンドラの
    // 条件付き埋め込みに使う。値そのものはmckBytecode.js側がseg.pitchBreaksから直接
    // 拾うのでremapテーブルは不要)
    let usesPitchBreak = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.pitchBreaks != null && seg.pitchBreaks.length > 0) { usesPitchBreak = true; break; }
      }
      if (usesPitchBreak) break;
    }

    // L(ループ地点マーカー)。compiler.jsのbuildSegments()がチャンネルごとに記録した値
    // (このツールのブラウザ再生・シークバー向けの「song全体で1つに揃えたloopPointFrame」
    // とは別物。NSF書き出しはチャンネルごとに独立して本当の無限ループを行うため、
    // チャンネルごとの生の値をそのまま使う)
    const loopFrameByChannel = compileResult.loopFrameByChannel || {};
    const chSerialized = channelLetters.map(ch => MML.NSF.MckBytecode.serialize(
      segmentsByChannel[ch] || [],
      [
        ...((vrc7Letters.has(ch) || fdsLetters.has(ch)) ? (immediateWritesByChannel[ch] || []) : []),
        ...(n163Letters.has(ch) ? (n163RelocsByChannel[ch] || []) : [])
      ],
      envIndexRemap,
      loopFrameByChannel[ch],
      epIndexRemap,
      mpIndexRemap));
    const chBytes = chSerialized.map(r => r.bytes);

    // 各チャンネルを順にバンク配置する。ループ地点(あれば)が最終的にどのバンク・
    // アドレスへ配置されたかもここで解決する
    const songBank = [];
    const allDataBanks = [];
    const loopAct = [], loopBank = [], loopLo = [], loopHi = [];
    let nextBank = DATA_START_BANK;
    for (let i = 0; i < channelLetters.length; i++) {
      const layout = layoutChannelBanks(chBytes[i], nextBank, chSerialized[i].loopByteOffset);
      songBank.push(layout.startBank);
      allDataBanks.push(...layout.banks);
      nextBank = layout.nextFreeBank;
      if (layout.markLocation) {
        loopAct.push(1);
        loopBank.push(layout.markLocation.bank);
        loopLo.push(layout.markLocation.addr & 0xff);
        loopHi.push((layout.markLocation.addr >> 8) & 0xff);
      } else {
        loopAct.push(0);
        loopBank.push(0);
        loopLo.push(0);
        loopHi.push(0);
      }
    }
    const songLoop = { act: loopAct, bank: loopBank, lo: loopLo, hi: loopHi };

    const src = buildFixedSource(channelTypes, songBank, usedExpansions, envelopes, dpcmLayout, dpcmSamples, envIndexList, songLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak);
    const asm = MML.Asm.assemble(src, { origin: 0x8000 });
    if (asm.errors.length > 0) {
      return { nsfBytes: null, asmErrors: asm.errors, bankCount: 0, unsupportedExpansions };
    }
    // ドライバ本体はバンク0-3($8000-$BFFF、バンク0は未使用の.res分含む)に収まる必要がある。
    // バンク4-7($C000-$FFFF)はDPCMサンプル専用の固定領域として直接バイトを配置するため
    // (下記)、ドライバがそこまで肥大化すると衝突する
    if (asm.bytes.length > DRIVER_CODE_LIMIT) {
      return {
        nsfBytes: null,
        asmErrors: [{ lineNo: 0, message: `ドライバ本体が${asm.bytes.length}バイトあり、割当領域` +
          `(バンク0-3、${DRIVER_CODE_LIMIT}バイト)を超えています。カスタム音色/波形の定義数を` +
          '減らしてください(DPCM使用時はバンク4-7がサンプル専用のため、ドライバはバンク0-3に収める必要があります)' }],
        bankCount: 0,
        unsupportedExpansions
      };
    }

    // 固定領域(バンク0-7 = 32768バイト)を確保し、アセンブル結果を敷き詰める。
    // 末尾に満たない分は0でパディングする
    const fixedRegionSize = DATA_START_BANK * BANK_SIZE;
    const fixedRegion = new Uint8Array(fixedRegionSize);
    fixedRegion.set(asm.bytes.slice(0, fixedRegionSize), 0);
    // DPCMサンプル本体をバンク4-7($C000-$FFFF)へ直接配置する(実機DMCハードウェアは
    // このアドレス範囲からしかサンプルを読めないため、NSFのバンク切り替え初期値
    // (下記opt.bankswitch、既存のまま[0,1,2,3,4,5,6,7])で最初からこの窓に固定マップしておく。
    // 追加の6502コードは不要 — NSFロード時にNsfBus/実機側で$5FF8-$5FFFへ反映される)
    for (const idx of Object.keys(dpcmLayout)) {
      const layout = dpcmLayout[idx];
      fixedRegion.set(layout.bytes, layout.addr - 0x8000);
    }

    // 曲データバンクをバンク番号順に並べ、それぞれ4096バイトへパディングして結合
    allDataBanks.sort((a, b) => a.bankNum - b.bankNum);
    const totalBanks = allDataBanks.length > 0
      ? allDataBanks[allDataBanks.length - 1].bankNum + 1
      : DATA_START_BANK;
    const programBytes = new Uint8Array(Math.max(fixedRegionSize, totalBanks * BANK_SIZE));
    programBytes.set(fixedRegion, 0);
    for (const b of allDataBanks) {
      const dst = b.bankNum * BANK_SIZE;
      programBytes.set(b.data, dst);
      // バンク内の未使用領域は0xFF(トラック終端相当)で埋めておく(念のための安全策)
      for (let i = dst + b.data.length; i < dst + BANK_SIZE; i++) programBytes[i] = 0xff;
    }

    const opt = Object.assign({}, headerOpt);
    opt.loadAddr = 0x8000;
    opt.initAddr = asm.symbols.INIT;
    opt.playAddr = asm.symbols.PLAY;
    // 窓0(バンクデータ用)の初期値は使用前に必ず上書きされるので何でもよい。
    // 窓1-7は固定領域のバンク1-7を指す(ドライバ本体の配置と一致させる)
    opt.bankswitch = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    if (MML.NSF.CHIP_FLAGS) {
      let extraChips = 0;
      const F = MML.NSF.CHIP_FLAGS;
      if (usedExpansions.includes('vrc6')) extraChips |= F.VRC6;
      if (usedExpansions.includes('vrc7')) extraChips |= F.VRC7;
      if (usedExpansions.includes('fds')) extraChips |= F.FDS;
      if (usedExpansions.includes('mmc5')) extraChips |= F.MMC5;
      if (usedExpansions.includes('n163')) extraChips |= F.N163;
      if (usedExpansions.includes('fme7')) extraChips |= F.FME7;
      opt.extraChips = extraChips;
    }

    const nsfBytes = MML.NSF.buildNSF(opt, programBytes);
    return {
      nsfBytes, asmErrors: [], bankCount: Math.ceil(programBytes.length / BANK_SIZE),
      unsupportedExpansions
    };
  };
})(window);
