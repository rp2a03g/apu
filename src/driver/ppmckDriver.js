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
 * ループ命令(0xA0/0xA1)・EN/EP/MP/FME7拡張オペコード(0xF1/0xF2)の実際の効果適用
 * (現状は読み飛ばすだけ)も未対応。
 * デチューン(0xFA、D<n>)は2026-07-24実装(APPLY_DETUNE/APPLY_DETUNE_N163参照)。
 * 2A03パルス/三角・VRC6・MMC5・FME7・FDS・N163に対応、VRC7は対象外。
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
  function fme7Period(freq) {
    return Math.max(1, Math.min(4095, Math.round(CPU_CLOCK_NTSC / (16 * freq))));
  }
  function fdsPeriod(freq) {
    return Math.max(0, Math.min(4095, Math.round((freq * 65536 * 64) / CPU_CLOCK_NTSC)));
  }
  // 実機の出力周波数 f = CLOCK * freqReg / (15 * 65536 * waveLen * numCh) を反転。
  // 有効ch数(numCh、実行時に$7Fへ設定する値)を含めないと音程がズレる(compiler.jsと同じ式)。
  function n163FreqReg(freq, numCh) {
    return Math.max(0, Math.min(262143, Math.round((freq * 15 * 65536 * N163_WAVE_LEN * (numCh || 1)) / CPU_CLOCK_NTSC)));
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
  function layoutChannelBanks(bytes, startBank) {
    const banks = [];
    const boundaries = MML.NSF.MckBytecode.commandBoundaries(bytes);
    let offset = 0;
    let bankNum = startBank;
    for (;;) {
      const remaining = bytes.length - offset;
      if (remaining <= BANK_SIZE) {
        banks.push({ bankNum, data: bytes.slice(offset) });
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
      offset = splitAt;
      bankNum = nextBank;
    }
    return { banks, startBank, nextFreeBank: bankNum };
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
  function buildFixedSource(channelTypes, songBank, expansions, envelopes, dpcmLayout, dpcmSamples, envIndexList) {
    envelopes = envelopes || {};
    dpcmLayout = dpcmLayout || {};
    dpcmSamples = dpcmSamples || {};
    envIndexList = envIndexList || [];
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

    // ゼロページレイアウト(チャンネル数nに応じて動的に配置)。LASTINSはFDS/N163/VRC7の
    // カスタム波形・音色の「直近ロードした音色番号」を覚えておくためのチャンネルごとの
    // スクラッチ(音符ごとのinstrumentがこれと変わった時だけ再ロードする、compiler.jsの
    // lastInstrument diffと同じロジックを6502側で再現する)。
    // ENVACT/ENVSEL/ENVTICKはソフトウェア音量エンベロープ(@v<n>)用のチャンネルごとの
    // 状態(有効フラグ・選択中のテーブル番号・現在のtick)。ENV_LOOKUP/SERVICE_CH参照
    const CNT = 0, VOL = n, DUTY = 2 * n, NOTE = 3 * n, PTRLO = 4 * n, PTRHI = 5 * n,
      BANK = 6 * n, CHTYPE = 7 * n, LASTINS = 8 * n,
      ENVACT = 9 * n, ENVSEL = 10 * n, ENVTICK = 11 * n,
      // D<n>(デチューン)。チャンネルごとの符号付き16bit生オフセット(下位/上位バイト)。
      // APPLY_DETUNE/APPLY_DETUNE_N163参照
      DETUNE_LO = 12 * n, DETUNE_HI = 13 * n;
    const CURLO = 14 * n, CURHI = 14 * n + 1, CHIDX = 14 * n + 2,
      PERLO = 14 * n + 3, PERHI = 14 * n + 4, PERLO2 = 14 * n + 5, JMPLO = 14 * n + 6, JMPHI = 14 * n + 7;

    const playLines = [];
    for (let i = 0; i < n; i++) playLines.push(`    LDX #${hex(i)}\n    JSR SERVICE_CH`);

    const initExtra = [];
    if (usesMmc5) initExtra.push('    LDA #$03\n    STA $5015       ; MMC5パルス1/2有効化');
    if (usesFme7) initExtra.push('    LDA #$07\n    STA $C000\n    LDA #$38\n    STA $E000       ; FME7ミキサ: トーンA/B/C有効・ノイズ無効');
    if (usesFds) {
      const wave = new Array(64);
      for (let i = 0; i < 64; i++) wave[i] = Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * i) / 64)) & 0x3f;
      initExtra.push(`    LDA #$80\n    STA $4089       ; FDS波形メモリ書込み許可\n    LDX #$00\nINIT_FDS_WAVE:\n    LDA FDS_WAVE_DATA,X\n    STA $4040,X\n    INX\n    CPX #$40\n    BNE INIT_FDS_WAVE\n    LDA #$00\n    STA $4089       ; 書込み禁止・マスター音量フル`);
    }
    if (usesN163) {
      // 波形RAMは4bitサンプルを1バイトに2つ(下位/上位ニブル)格納するため、
      // N163_WAVE_LEN(サンプル数)の半分のバイト数だけ書き込む。
      // 長さレジスタは NESdev準拠で length = 256 - (regByte & 0xFC) なので、
      // 16サンプルにするには regByte の上位6bit = 256-16 = 0xF0。
      // 実機は内部8ch中「上位numN163Ch個」だけを巡回・ミックスするため(下位から詰めると鳴らない)、
      // 各chの内部インデックスは (8-numN163Ch)+ch。$7Fに(numN163Ch-1)<<4を設定する必要がある。
      // 各chが専用の波形スロット(internalIdx*8byte、compiler.jsのn163WaveByteOffsetと同じ)に
      // 既定波形を書き込む。以前は全ch共有(waveBase=0固定)だったため、あるchが@N<n>で
      // 別波形へ切り替えると他chの波形まで巻き添えで書き換わっていた(compiler.js側の修正と
      // 同種のバグ。詳細はn163WaveLoadWrites/n163WaveByteOffsetのコメント参照)。
      const n163InitLines = [];
      for (let ch = 0; ch < numN163Ch; ch++) {
        const internalIdx = (N163_CHANNEL_COUNT - numN163Ch) + ch;
        const regBase = 0x40 + internalIdx * 8;
        const byteOffset = internalIdx * (N163_WAVE_LEN / 2);
        n163InitLines.push(`    LDA #${hex(byteOffset | 0x80)}\n    STA $F800       ; ch${ch}専用波形スロットを選択\n    LDX #$00\nINIT_N163_WAVE_${ch}:\n    LDA N163_WAVE_DATA,X\n    STA $4800\n    INX\n    CPX #${hex(N163_WAVE_LEN / 2)}\n    BNE INIT_N163_WAVE_${ch}\n    LDA #${hex((regBase + 4) | 0x80)}\n    STA $F800\n    LDA #$F0        ; 波形長=256-240=16サンプル\n    STA $4800\n    LDA #${hex((regBase + 6) | 0x80)}\n    STA $F800\n    LDA #${hex(byteOffset * 2)}        ; waveBase=byteOffset*2(ニブルアドレス)\n    STA $4800`);
      }
      // $7Fはゼロページではなくポート経由(N163内部RAMアドレス0x7F)で書く必要がある
      n163InitLines.push(`    LDA #$FF\n    STA $F800       ; N163内部アドレス$7Fを選択\n    LDA #${hex((numN163Ch - 1) << 4)}\n    STA $4800       ; 有効チャンネル数=${numN163Ch}`);
      initExtra.push(n163InitLines.join('\n'));
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
    STA $9002
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
    STA $A002
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
    STA $B002
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
    STA $5003
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
    STA $5007
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

; --- FME7 ch0 ($C000アドレス選択/$E000データ書込の間接方式。reg0/1=周期,reg8=音量) ---
WFV_T9:
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
    LDA #$08
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS
SIL_T9:
    LDA #$08
    STA $C000
    LDA #$00
    STA $E000
    RTS

; --- FME7 ch1 (reg2/3=周期,reg9=音量) ---
WFV_T10:
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
    LDA #$09
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS
SIL_T10:
    LDA #$09
    STA $C000
    LDA #$00
    STA $E000
    RTS

; --- FME7 ch2 (reg4/5=周期,reg10=音量) ---
WFV_T11:
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
    LDA #$0A
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS
SIL_T11:
    LDA #$0A
    STA $C000
    LDA #$00
    STA $E000
    RTS`);
      wfvEntries[9] = 'WFV_T9'; wfvEntries[10] = 'WFV_T10'; wfvEntries[11] = 'WFV_T11';
      silEntries[9] = 'SIL_T9'; silEntries[10] = 'SIL_T10'; silEntries[11] = 'SIL_T11';
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
    STA $4083
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
      // N163: 周波数レジスタは18bit(3バイト)。テーブルには
      // バイト2に波形長レジスタ(0x3C固定)を事前にORして格納しておく
      const words3 = [];
      for (let noteN = 0; noteN < NOTE_TABLE_SIZE; noteN++) {
        // 実行時に $7F へ設定する有効ch数(numN163Ch)で符号化する(復号側と一致させる)
        const reg = n163FreqReg(noteFrequency(noteN), numN163Ch);
        // 0xF0 = 波形長256-240=16サンプル(bit2-7)。周波数上位2bitはbit0-1にOR
        words3.push(reg & 0xff, (reg >> 8) & 0xff, 0xf0 | ((reg >> 16) & 0x03));
      }
      extraTables.push(`N163_TABLE:\n${bytesToDb(new Uint8Array(words3))}`);
      // 既定波形(サイン波、4bitサンプル16個をニブル詰めで8バイトに格納)
      const n163Wave = new Array(N163_WAVE_LEN);
      for (let i = 0; i < N163_WAVE_LEN; i++) {
        n163Wave[i] = Math.max(0, Math.min(15, Math.round(7.5 + 7.5 * Math.sin((2 * Math.PI * i) / N163_WAVE_LEN))));
      }
      const n163WaveBytes = new Array(N163_WAVE_LEN / 2);
      for (let i = 0; i < n163WaveBytes.length; i++) {
        n163WaveBytes[i] = (n163Wave[2 * i] & 0x0f) | ((n163Wave[2 * i + 1] & 0x0f) << 4);
      }
      extraTables.push(`N163_WAVE_DATA:\n${bytesToDb(new Uint8Array(n163WaveBytes))}`);
      // @N<n>カスタム波形。各chは専用の波形スロット(internalIdx*8byte、init時と同じ
      // n163WaveByteOffset相当のオフセット)を持つため、「選択中の音色番号が前の音符から
      // 変わり、かつ定義がある時だけ」再ロードする共通サブルーチンをJSRで呼ぶ際は、
      // 呼び出し元chの全体配列インデックス(X)から自chの波形バイトオフセットを
      // N163_CH_WAVEOFS テーブルで動的に引く(以前はオフセット0固定で全ch共有バッファに
      // 書いていたため、複数chが異なる@N<n>波形を同時使用する曲で後からロードしたchが
      // 他chの波形まで巻き添えで上書きしていた。compiler.js側の同種修正と対応)。
      let n163ToneCheckCall = '';
      if (n163CustomWaves.length > 0) {
        // X(呼び出し元の全体chインデックス)→波形バイトオフセットの対応表。N163ch以外の
        // インデックスは参照されないため値は未使用(0のまま)でよい。
        const chWaveOfs = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
          const t = channelTypes[i];
          if (t >= TYPE_N163_BASE && t < TYPE_N163_BASE + N163_CHANNEL_COUNT) {
            const internalIdx = (N163_CHANNEL_COUNT - numN163Ch) + (t - TYPE_N163_BASE);
            chWaveOfs[i] = internalIdx * (N163_WAVE_LEN / 2);
          }
        }
        extraTables.push(`N163_CH_WAVEOFS:\n${bytesToDb(new Uint8Array(chWaveOfs))}`);
        // FDS(WFV13)と同じ理由(src/driver/ppmckDriver.js usesFdsブロック参照)で、
        // BEQ/BNEは直後のJMP(範囲無制限)への短距離分岐のみに使い、長距離ジャンプは
        // 全てJMPで行う(波形の種類が増えるとBEQの分岐距離が±127byteを超えうる)。
        const cmpChain = n163CustomWaves.map((idx, i) =>
          `    CMP #${hex(idx)}\n    BNE N163_SKIP_${i}\n    JMP N163_LOAD_${i}\nN163_SKIP_${i}:`).join('\n');
        const loadBlocks = n163CustomWaves.map((idx, i) => `
N163_LOAD_${i}:
    STA ${hex(LASTINS)},X
    STX ${hex(CHIDX)}
    LDA N163_CH_WAVEOFS,X
    ORA #$80
    STA $F800       ; ch専用波形スロットを選択、オートインクリメントON
    LDX #$00
N163_LOAD_${i}_LP:
    LDA N163_CUSTOM_WAVE_${i},X
    STA $4800
    INX
    CPX #${hex(N163_WAVE_LEN / 2)}
    BNE N163_LOAD_${i}_LP
    LDX ${hex(CHIDX)}
    JMP N163_TONE_OK`).join('\n');
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
          const wave = envelopes.n[idx].slice(0, N163_WAVE_LEN);
          while (wave.length < N163_WAVE_LEN) wave.push(0);
          const packed = new Array(N163_WAVE_LEN / 2);
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
    TAX
    LDA N163_TABLE,X
    STA ${hex(PERLO)}
    LDA N163_TABLE+1,X
    STA ${hex(PERHI)}
    LDA N163_TABLE+2,X
    STA ${hex(PERLO2)}
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
${wfvVolWrite}
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
      }
      extraHandlers.push(n163Handlers.join('\n'));
      extraHandlers.push(`
; --- N163用D<n>デチューン共通処理。PERLO/PERHI/PERLO2に freqReg(18bit、3バイト:
; 下位/中位/上位2bit)が入っている状態で呼ぶ(呼出し前提はAPPLY_DETUNEと同じ、
; X=チャンネル番号)。PERLO2の上位6bitは波形長定数($F0)がOR済みなので、まず
; AND #$03で真の上位2bitだけを取り出してから16bit加算+3バイト目への符号拡張
; (DETUNE_HIのbit7)を通常の多倍長2の補数加算として行う。結果が負(PERLO2の
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
    BEQ ADN163_POS
    LDA #$FF
    JMP ADN163_EXT
ADN163_POS:
    LDA #$00
ADN163_EXT:
    ADC ${hex(PERLO2)}
    STA ${hex(PERLO2)}
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
; FamiMML Studio - ppmck方式バイトコード再生ドライバ(バンク切り替え+拡張音源対応)
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
    LDA #$FF
    STA ${hex(LASTINS)},X  ; LASTINS=$FF(番兵。有効な音色番号0-127とは重複しない)
    LDA #$00
    STA ${hex(DETUNE_LO)},X ; DETUNE=0(D<n>未指定時の既定値)
    STA ${hex(DETUNE_HI)},X
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
${envTableCount > 0 ? `    ; 音符継続中(カウンタがまだ尽きていない)。ソフトウェア音量エンベロープが
    ; 有効なら、このフレーム分tickを進めて音量レジスタ"のみ"書き直す(周期/コントロール
    ; レジスタは書き直さない。WRITE_VOL_ONLYのコメント参照)
    LDA ${hex(ENVACT)},X
    BEQ SERVICE_CH_END
    INC ${hex(ENVTICK)},X
    JSR ENV_LOOKUP
    JSR WRITE_VOL_ONLY
    JMP SERVICE_CH_END` : '    JMP SERVICE_CH_END'}
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
    CMP #$F8
    BEQ RD_SKIP1
    CMP #$FB
    BEQ RD_SKIP1
    CMP #$FA
    BEQ RD_JMP_DETUNE
${envTableCount > 0 ? '    CMP #$F3\n    BEQ RD_JMP_VOLENV' : ''}
${usesFme7 ? '    CMP #$F1\n    BEQ RD_SKIP1\n    CMP #$F2\n    BEQ RD_SKIP3' : ''}
${vrc7CustomTones.length > 0 ? '    CMP #$F0\n    BEQ RD_JMP_VRC7TONE' : ''}
${usesFds ? '    CMP #$F5\n    BEQ RD_JMP_FDSMOD' : ''}
    JMP RD_NOTE

RD_JMP_ENDTRACK:
    JMP RD_ENDTRACK
RD_JMP_BANKJUMP:
    JMP RD_BANKJUMP
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
${envTableCount > 0 ? 'RD_JMP_VOLENV:\n    JMP RD_VOLENV' : ''}
${vrc7CustomTones.length > 0 ? 'RD_JMP_VRC7TONE:\n    JMP RD_VRC7TONE' : ''}
${usesFds ? 'RD_JMP_FDSMOD:\n    JMP RD_FDSMOD' : ''}

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

RD_VOL:
    JSR READ_BYTE
    AND #$0F
    STA ${hex(VOL)},X
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X   ; 明示的な音量指定はソフトウェアエンベロープを解除する` : ''}
    JMP RD_LOOP
${envTableCount > 0 ? `
RD_VOLENV:
    JSR READ_BYTE
    STA ${hex(ENVSEL)},X
    LDA #$01
    STA ${hex(ENVACT)},X
    LDA #$00
    STA ${hex(ENVTICK)},X
    JMP RD_LOOP` : ''}

RD_TONE:
    JSR READ_BYTE
    AND #$7F       ; OP_TONEバイトコードの0-127全域を保持(以前は#$0Fで4bitに切り詰めていた
                    ; バグ。ASL A連鎖で使うVRC7パッチ選択等は256の剰余により結果不変なので
                    ; マスク幅を広げても既存チップの挙動には影響しない)
    STA ${hex(DUTY)},X
    JMP RD_LOOP

; --- D<n>デチューン(0xFA): 直後2バイトが符号付き16bit値(下位,上位)。次の音符から
; APPLY_DETUNE/APPLY_DETUNE_N163が使う。値そのものを覚えるだけで周期計算はしない ---
RD_DETUNE:
    JSR READ_BYTE
    STA ${hex(DETUNE_LO)},X
    JSR READ_BYTE
    STA ${hex(DETUNE_HI)},X
    JMP RD_LOOP

RD_REST:
    JSR READ_BYTE
    STA ${hex(CNT)},X
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X   ; 休符中はソフトウェアエンベロープを進めない` : ''}
    JSR SILENCE_CH
    JMP RD_RETURN

RD_WAIT:
    JSR READ_BYTE
    STA ${hex(CNT)},X
    JMP RD_RETURN

RD_NOTE:
    STA ${hex(NOTE)},X
    JSR READ_BYTE
    STA ${hex(CNT)},X
${envTableCount > 0 ? `    LDA ${hex(ENVACT)},X   ; エンベロープ有効なら"この音符から"必ずtick0で再スタートする。\n                    ; mckBytecode.js側はテーブル番号が前の音符と同じ場合OP_VOL_ENVを\n                    ; 出し直さない(バイトコード節約)ため、ここでENVACTを見るだけで\n                    ; ENVTICKのリセットを省略すると前の音符の続きから再生されてしまう\n                    ; バグになる(compiler.js側は音符ごとに独立してtick0から辿るため\n                    ; この問題が起きない。JS側との差異はここだけだった)\n    BEQ RD_NOTE_NOENV\n    LDA #$00\n    STA ${hex(ENVTICK)},X\n    JSR ENV_LOOKUP\nRD_NOTE_NOENV:` : ''}
    JSR WRITE_FREQ_VOL
    JMP RD_RETURN

RD_ENDTRACK:
    ; トラック終端: 無音化して停止する(0xA0/0xA1によるループは未対応)。
    ; 音符が1つも無い空トラックでも安全なように、ポインタ/バンクは変更せず
    ; カウンタだけ最大にして抜ける(次にCNTが尽きたら同じ0xFFに再度到達し、
    ; また安全に停止するだけ)
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

; --- D<n>デチューン共通処理。呼出し前提: Xはチャンネル番号、PERLO/PERHIにテーブル
; 参照済みの周期値が入っている状態で呼ぶ。DETUNE_LO/HI,X(符号付き16bit)を通常の
; 16bit ADCで加算する(2の補数表現なので符号付き値でもビット演算は加算と同一)。
; 加算結果が負(PERHIのbit7が立つ)ならPERLO/PERHI=0にクランプする(JS側=compiler.jsの
; applyDetuneのMath.max(0,...)と同じ意図。上限側のクランプは行わない=極端に大きい
; デチューン値でレジスタ幅を超えるケースは非対応、通常のコーラス用途の値では発生しない)。
; Xは破壊しない ---
APPLY_DETUNE:
    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(DETUNE_LO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(DETUNE_HI)},X
    STA ${hex(PERHI)}
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
    STA $4003
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
    STA $4007
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
    STA $400B
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

    const chBytes = channelLetters.map(ch => MML.NSF.MckBytecode.serialize(
      segmentsByChannel[ch] || [],
      (vrc7Letters.has(ch) || fdsLetters.has(ch)) ? (immediateWritesByChannel[ch] || []) : [],
      envIndexRemap));

    // 各チャンネルを順にバンク配置する
    const songBank = [];
    const allDataBanks = [];
    let nextBank = DATA_START_BANK;
    for (let i = 0; i < channelLetters.length; i++) {
      const layout = layoutChannelBanks(chBytes[i], nextBank);
      songBank.push(layout.startBank);
      allDataBanks.push(...layout.banks);
      nextBank = layout.nextFreeBank;
    }

    const src = buildFixedSource(channelTypes, songBank, usedExpansions, envelopes, dpcmLayout, dpcmSamples, envIndexList);
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
