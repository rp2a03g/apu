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
 * (VRC6・MMC5・FME7・FDS・N163・VRC7)。FDS/N163の`@FM`/`@N`によるMML側のカスタム波形
 * 定義(`fdsCustomWaves`/`n163CustomWaves`、未使用時はデフォルト波形にフォールバック)、
 * VRC7の`OP<n>`によるカスタム音色0番のロード(`vrc7CustomTones`、未使用時はROMプリセット
 * (1-15)のみ)も、いずれもNSF書き出しに反映される。
 * ループ命令(0xA0/0xA1)は引き続き未対応(オペコードを読み飛ばすだけ)。
 * EN(0xF7、ノートエンベロープ=アルペジオ)は2026-08-14実装(EN_STEP/RD_NOTEENV参照)。
 * ノート番号空間の累積オフセット(compiler.jsのcumulativeEnvelopeValueと同じ)をNOTE,Xへ
 * 加算してから周波数テーブルを引き直す方式。2A03パルスA/B・三角波・MMC5パルス1/2・
 * VRC6パルス1/2/矩形波(サウ)・FME7(LOOKUP_FME7_PERIOD)・FDS(WFV_T13/WFO_T13直書き)・
 * N163(WFV_Tn/WFO_Tnテンプレート、3byte/entryテーブルのためTABLE_MAX縮小版)・
 * VRC7(WFO_Tn新設、NOTE+ENVALからfnum/blockを再計算し$9010/$9030を再書込み)が対象。
 * ノイズのみ対象外(離散周期選択でアルペジオという概念が馴染まないため)。SPCブラウザ側
 * 抽出は対応済みだがSPCはNSF書き出し経路を持たないためこのドライバとは無関係。
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
 *   窓0 ($8000-$8FFF, $5FF8) : 曲データ専用の切り替え窓。曲データバンクを動的にマップする
 *   窓1-7($9000-$FFFF, $5FF9-$5FFF) : ドライバ本体(コード+テーブル類)とDPCMサンプル($C000以降)を
 *                                       固定配置。窓→ファイル上バンク番号はNSFヘッダの
 *                                       bankswitch初期値で決め、ドライバは実行時に窓0しか切り替えない
 *   ファイル上のバンク配置(2026-08-16、buildBankedNsfBytes参照):
 *     [0]=曲データ(窓0の初期値でもある) / [1..]=ドライバ本体(DPCM使用時はさらにDPCMサンプル) /
 *     その後ろ=残りの曲データ。1チャンネルが4096バイトを超える場合は複数バンクにまたがり、
 *     コマンド境界を跨がない位置で0xEE(バンクジャンプ)を挿入してつなぐ
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
  const DATA_DPCM_BANK = 4;  // DPCMサンプル領域の先頭バンク($C000)。実機DMCの読出し範囲$C000-$FFFF
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

  // needleがhayの中に連続部分列として現れる先頭位置を返す(無ければ-1)。空配列は常に0で一致。
  function indexOfSubsequence(hay, needle) {
    if (needle.length === 0) return 0;
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) { if (hay[i + j] !== needle[j]) continue outer; }
      return i;
    }
    return -1;
  }

  // @v<n>/@vr<n>/EP<n>のROM埋め込み共通処理: 各テーブルのバイト列を突き合わせ、あるテーブルが
  // 別の(より長い)テーブルの完全な連続部分列になっている場合は専用の.byteブロックを新たに
  // 確保せず、既存ブロックの途中(LABEL+offset)を指す式で済ませる(実行時のENV_LOOKUP等は
  // ENV_PTRが指すアドレスを読むだけなので、6502コード側・ENV_LEN/ENV_LOOPの意味は不変。
  // 各インデックスは従来通り自分専用のLEN/LOOPを持ち続けるため、値の解釈がすり替わる
  // 心配は無い=[[envelope-registry-loop-upgrade-bug]]のようなノート間の意味論の取り違えとは
  // 別層の、確定済みバイト列同士の機械的な一致判定)。
  // indexList: envIndexList等(0始まりの連番)。valuesOf(origIdx)は対象のクランプ済みbyte配列。
  // 戻り値: { ptrExprs: indexList順のENV_PTR用アドレス式配列, dataBlocks: 実際に確保する.byteブロック配列 }
  function packEnvelopeTables(indexList, prefix, valuesOf) {
    const tables = indexList.map(valuesOf);
    // 長いテーブルほど「他を内包する受け皿」になりやすいので先に確保する
    const order = tables.map((_, i) => i).sort((a, b) => tables[b].length - tables[a].length);
    const anchors = []; // { label, bytes }
    const refFor = new Array(tables.length);
    for (const i of order) {
      const bytes = tables[i];
      let ref = null;
      for (const anchor of anchors) {
        const off = indexOfSubsequence(anchor.bytes, bytes);
        if (off >= 0) { ref = { label: anchor.label, offset: off }; break; }
      }
      if (!ref) {
        const label = `${prefix}_DATA_${anchors.length}`;
        anchors.push({ label, bytes });
        ref = { label, offset: 0 };
      }
      refFor[i] = ref;
    }
    const ptrExprs = tables.map((_, i) => {
      const { label, offset } = refFor[i];
      return offset === 0 ? label : `${label}+${offset}`;
    });
    const dataBlocks = anchors.map(a => `${a.label}:\n${bytesToDb(new Uint8Array(a.bytes))}`);
    return { ptrExprs, dataBlocks };
  }

  // チャンネル1個分のバイトコードを、コマンド境界を跨がない位置で4KBバンクに分割する。
  // 収まりきらない場合は末尾に0xEE(バンクジャンプ)4バイトを追加して次バンクへつなぐ。
  // startOffset(2026-08-15、ROM圧縮対応): このチャンネルの先頭を、必ず新しいバンクの$8000
  // からではなく、startBankの途中(直前のチャンネルの続き)から詰めて配置できるようにする。
  // バンク境界を跨いだ後(0xEEジャンプ後)のチャンクは、実行時ルーチン(RD_BANKJUMP)が
  // ジャンプ先アドレスをマーカーから読むだけで動くため、これまで通り常に$8000開始のままで
  // よい(=詰め込みが要るのは「このチャンネルの最初のチャンク」だけ)。
  // markOffset: 省略可。分割前のbytes上のバイトオフセット(MckBytecode.serialize()の
  // loopByteOffset)。指定されると、分割後にそのオフセットが実際にどのバンク・
  // アドレスへ配置されたかをmarkLocation({bank, addr})として返す(Lコマンドの
  // ループ先アドレス解決に使う)。
  // reserved(2026-08-16、ROM圧縮対応): チャンネルデータを置いてはいけないバンク番号
  // (ドライバ本体・DPCMサンプルが占有する「穴」)。数値なら[1, reserved)、関数なら
  // bank番号→真偽値の述語。穴に当たるバンクは素直に+1する代わりに飛び越える
  // (0xEEバンクジャンプは元々任意のバンク・アドレスへ飛べるため追加のランタイムコストは
  // 無い)。バンク0(窓0)はドライバが動的に読み替える場所そのもの=コードさえ置かなければ
  // 自由に使えるため、「バンク0だけ先に使い切ってからドライバ領域を飛び越す」という
  // 配置に使う。戻り値のbanks[].offsetはそのバンク内での配置開始位置(0-4095、$8000からの
  // オフセット)。
  function layoutChannelBanks(bytes, startBank, startOffset, markOffset, reserved) {
    const banks = [];
    const boundaries = MML.NSF.MckBytecode.commandBoundaries(bytes);
    const MIN_CHUNK_WITH_JUMP = 5; // 実データ最低1byte + バンクジャンプマーカー4byte
    const isReserved = typeof reserved === 'function'
      ? reserved
      : (n => reserved != null && n >= 1 && n < reserved);
    function advanceBank(n) {
      while (isReserved(n)) n++;
      return n;
    }
    let offset = 0;
    let bankNum = startBank;
    let posInBank = startOffset || 0;
    let markLocation = null;
    for (;;) {
      if (posInBank >= BANK_SIZE) { bankNum = advanceBank(bankNum + 1); posInBank = 0; }
      const remaining = bytes.length - offset;
      const spaceInBank = BANK_SIZE - posInBank;
      if (remaining <= spaceInBank) {
        banks.push({ bankNum, data: bytes.slice(offset), offset: posInBank });
        if (markOffset != null && markLocation == null && markOffset >= offset && markOffset < bytes.length) {
          markLocation = { bank: bankNum, addr: 0x8000 + posInBank + (markOffset - offset) };
        }
        posInBank += remaining;
        break;
      }
      if (spaceInBank < MIN_CHUNK_WITH_JUMP) {
        // このバンクの残りにはジャンプマーカーすら収まらない(直前チャンネルの続きに詰めた
        // 結果、残りが極端に少ない場合)。何も置かずに次のバンクの先頭から仕切り直す
        bankNum = advanceBank(bankNum + 1);
        posInBank = 0;
        continue;
      }
      const limit = offset + spaceInBank - 4; // バンクジャンプ4バイト分を残す
      let splitAt = offset + 1; // 保険(通常発生しない)
      for (const b of boundaries) {
        if (b > offset && b <= limit) splitAt = b;
        else if (b > limit) break;
      }
      const chunk = bytes.slice(offset, splitAt);
      const nextBank = advanceBank(bankNum + 1);
      const data = new Uint8Array(chunk.length + 4);
      data.set(chunk, 0);
      data[chunk.length] = 0xee;
      data[chunk.length + 1] = nextBank & 0xff;
      data[chunk.length + 2] = 0x00;
      data[chunk.length + 3] = 0x80;
      banks.push({ bankNum, data, offset: posInBank });
      if (markOffset != null && markLocation == null && markOffset >= offset && markOffset < splitAt) {
        markLocation = { bank: bankNum, addr: 0x8000 + posInBank + (markOffset - offset) };
      }
      offset = splitAt;
      bankNum = nextBank;
      posInBank = 0;
    }
    return { banks, startBank, startOffset: startOffset || 0, nextFreeBank: bankNum, nextFreeOffset: posInBank, markLocation };
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
  // songAddrLo/songAddrHi: チャンネルごとの開始アドレス下位/上位(2026-08-15、ROM圧縮対応)。
  // 各チャンネルのバイトコードを新しいバンクの$8000から必ず始めるのではなく、直前の
  // チャンネルの続きに(バンク境界を跨がない範囲で)詰めて配置できるようにするための拡張
  // (buildBankedNsfBytes参照)。省略時(buildPpmckSource等の簡易呼び出し)は全チャンネル
  // $8000開始の従来動作のまま。
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
  // driverOrg(2026-08-16、DPCM曲のROM圧縮): ドライバ本体の配置先アドレス(既定$9000=窓1先頭)。
  // DPCM使用曲ではサンプル($C000固定)の直下に詰めるため$C000-コードバンク数×4KBを渡す
  // (buildBankedNsfBytes参照)。ドライバは絶対アドレスで自分自身を参照するのでorgで
  // 一意に決まり、窓→ファイル上バンク番号の対応はNSFヘッダのbankswitch初期値で吸収する
  function buildFixedSource(channelTypes, songBank, expansions, envelopes, dpcmLayout, dpcmSamples, envIndexList, songLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak, usesSmooth, usesPitchShift, usesRawWrite, vrIndexList, enIndexList, dutyIndexList, usesRelTone, songAddrLo, songAddrHi, usesDetune, driverOrg, usesSweep, usesPitchSa) {
    driverOrg = driverOrg || 0x9000;
    usesSweep = !!usesSweep;
    songAddrLo = songAddrLo || channelTypes.map(() => 0x00);
    songAddrHi = songAddrHi || channelTypes.map(() => 0x80);
    envelopes = envelopes || {};
    dpcmLayout = dpcmLayout || {};
    dpcmSamples = dpcmSamples || {};
    envIndexList = envIndexList || [];
    epIndexList = epIndexList || [];
    mpIndexList = mpIndexList || [];
    vrIndexList = vrIndexList || [];
    enIndexList = enIndexList || [];
    dutyIndexList = dutyIndexList || [];
    usesPortamento = !!usesPortamento;
    usesPitchBreak = !!usesPitchBreak;
    usesSmooth = !!usesSmooth;
    usesPitchShift = !!usesPitchShift;
    usesRawWrite = !!usesRawWrite;
    const usesVr = vrIndexList.length > 0;
    // @@<n>(デューティ=音色エンベロープ)が曲中で使われているか。@vと同じく、使われて
    // いない曲にはテーブルもハンドラも一切埋め込まない。usesRelTone(@@r<n>)は
    // デューティエンベロープ非使用のチップ(FDS/VRC7=固定音色番号)でも使われうるので別フラグ。
    // 音色状態(TONEBASE/RELTONE等)はどちらか一方でも使われていれば必要になる
    const usesDutyEnv = dutyIndexList.length > 0;
    usesRelTone = !!usesRelTone;
    const usesToneState = usesDutyEnv || usesRelTone;
    // 音符内部のゲートオフ専用オペコード(0xEC/0xE8)を使うかどうか。@vr(リリース
    // エンベロープ)だけでなく@@r(リリース音色)も「音符のゲートオフ」を捕まえる必要が
    // あるため、どちらか一方でも使われていれば専用オペコード側へ寄せる
    // (素のOP_REST=0xFCは独立したr休符専用のまま。mckBytecode.js serializeのusesVr引数も
    // 同じ値を渡すこと)
    const usesGateOffVr = usesVr || usesRelTone;
    const loopAct = (songLoop && songLoop.act) || channelTypes.map(() => 0);
    const loopBank = (songLoop && songLoop.bank) || channelTypes.map(() => 0);
    const loopLo = (songLoop && songLoop.lo) || channelTypes.map(() => 0);
    const loopHi = (songLoop && songLoop.hi) || channelTypes.map(() => 0);
    // L(ループ地点マーカー、2026-08-16 ROM圧縮対応): 曲中のどのチャンネルも1個もLを
    // 使っていなければ、SONG_LOOP_*の4テーブル(4byte/ch)自体を埋め込まない
    const usesLoop = loopAct.some(v => v === 1);
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
    // @v<n>(ソフトウェア音量エンベロープ、2026-08-16 ROM圧縮対応): ENVACT/ENVSEL/ENVTICKの
    // 3byte/ch。ENV_LOOKUP本体・ディスパッチ・SERVICE_CH側は既にenvTableCount>0でガード
    // 済みだったが、ZP確保だけ他の項目と違って無条件だった(D<n>と同種の穴)
    const envActExtraSlots = envIndexList.length > 0 ? 3 : 0;
    const usesEp = epIndexList.length > 0;
    // EPDELAY/EPDELAYSET(2026-08-11 別プロジェクトA、EP<n>,<delay>): 5→7スロットに拡張
    const epExtraSlots = usesEp ? 7 : 0;
    const usesMp = mpIndexList.length > 0;
    const mpExtraSlots = usesMp ? 11 : 0;
    // PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC): 11byte/ch(MPと同数)
    const ptExtraSlots = usesPortamento ? 11 : 0;
    // EN<n>(ノートエンベロープ=高速アルペジオ、2026-08-14): ENACT/ENSEL/ENTICK/ENVALの
    // 4byte/ch。EPと違いdelay概念が無く、値もノート番号空間の符号付き累積オフセット
    // (1byteで十分な範囲)なので16bit(EPVALLO/HI)ではなく1byte(ENVAL)で済む
    const usesEn = enIndexList.length > 0;
    const enExtraSlots = usesEn ? 4 : 0;
    // タイ(&)による異音程レガート(2026-08-12): 専用のZP状態は持たない(NOTE,Xを
    // 直接書き替えるだけ)ため追加スロットは不要。WRITE_FREQ_ONLY自体は必要なので
    // usesFreqOnlyの判定にだけ加える。PS(2026-08-13)・EN<n>(2026-08-14)も毎フレーム
    // 継続再計算・再書込みが必要なので同じくusesFreqOnlyに加える
    const usesFreqOnly = usesEp || usesMp || usesPortamento || usesPitchBreak || usesPitchShift || usesEn;
    // LASTHI(位相リセット副作用のある上位バイトの直近書込み値)はusesFreqOnly由来の
    // 継続再計算に加え、SM(音符アタック時の書込み省略判定)でも必要
    const needsLastHi = usesFreqOnly || usesSmooth;
    // 周期/周波数レジスタへの生オフセット系(D/EP/MP/PT/PS)を一切使わない曲では、
    // APPLY_DETUNE(_N163)は「何も加算せず負クランプ判定だけする」無意味な呼び出しに
    // なる(テーブル由来の周期は常に非負)ため、ルーチン本体も全ハンドラからのJSRも
    // 丸ごと省略する(2026-08-16 最適化。buildFixedSource末尾の行フィルタ参照)
    const usesAnyPitchOffset = usesDetune || usesEp || usesMp || usesPortamento || usesPitchShift;
    const freqOnlyExtraSlots = needsLastHi ? 1 : 0;
    // SM/SMOF(2026-08-13、対応ABC): 音符ごとのON/OFF状態を持つ1byte/ch
    const smoothExtraSlots = usesSmooth ? 1 : 0;
    // PS(ポルタメント、実機準拠、2026-08-13、対応ABC): PSACT/PSDIR/PSSTEPSZ/PSSTEPINT/
    // PSSTEPCNT/PSVALLO/PSVALHIの7byte/ch(PT_STEPと同型の状態遷移だが、duration/delayの
    // 持続的なパラメータ保持が不要な分PTより少ない=CNT,Xが尽きたら次のRD_NOTEが
    // PSACTをクリアするだけで十分)
    const psExtraSlots = usesPitchShift ? 7 : 0;
    // @vr<n>(リリースエンベロープ、2026-08-13): VRSEL(選択中のコンパクトなROMテーブル
    // 番号、$FF=未選択)/RELPLAY(ゲートオフ後の再生中フラグ)/RELTICKの3byte/ch。
    // 実際のレジスタ書込み自体はENV_LOOKUP/WRITE_VOL_ONLYと同型の仕組み
    // (REL_LOOKUP/既存のWRITE_VOL_ONLYをそのまま再利用)を流用する
    // VRSEL/RELPLAY/RELTICK + VOLBASE(v<n>で設定された素の音量の控え。リリース再生が
    // VOL,Xを上書きしてしまうため、次の音符のアタックで復元するのに使う)の4本
    const vrExtraSlots = usesVr ? 4 : 0;
    // @@<n>(デューティ=音色エンベロープ、2026-08-15): DUTYSEL(選択中のコンパクトな
    // ROMテーブル番号、$FF=未選択=@<n>の固定音色)/DUTYTICK(経過フレーム)/
    // TONEBASE(直前のOP_TONEバイトの控え。@@r<n>で音色が差し替わった後、次の音符で
    // 自分の音色へ戻すのに使う。VOLBASEと同じ考え方)/RELTONE(@@r<n>の音色バイト、
    // $FF=OFF)の4byte/ch。値の反映は@vと同じくWRITE_VOL_ONLY(音量レジスタにデューティが
    // 同居する)を再利用する
    const dutyExtraSlots = usesToneState ? 4 : 0;
    // D<n>(デチューン、2026-08-16 ROM圧縮対応): DETUNE_LO/HIの2byte/ch。usesDetuneの時のみ
    // 実際に使う(以前は全曲・全チャンネル無条件に確保・初期化・毎音符APPLY_DETUNEで
    // 加算していた唯一の「拡張音源以外なのにガードされていないコマンド」だった)
    const detuneExtraSlots = usesDetune ? 2 : 0;
    // s<speed>,<depth>(ハードウェアスイープ、2026-08-20): $4001/$4005へ書く生バイトを
    // 保持する1byte/ch。2A03パルスA/B以外のチャンネルでは使わないが、,Xインデックスの
    // 配列として他の状態と同じ形で確保する(D<n>等と同じ扱い)
    const sweepExtraSlots = usesSweep ? 1 : 0;
    // SA<num>(N163ピッチシフト量、2026-08-26、本家pitch_shift_amount相当): 1byte/ch。
    // usesPitchSaの時のみ実際に使う。APPLY_DETUNE_N163のSA_ADD16参照
    const saExtraSlots = usesPitchSa ? 1 : 0;
    // LASTVOL(音量書込みスキップ用の直近値、2026-08-26): 1byte/ch。音量のみ書込み経路
    // (WRITE_VOL_ONLY=TICK_VOL_FXの継続フレーム)が存在する曲でのみ確保する。
    // 条件はusesVolOnly(下方で定義)と同一だが、ZPレイアウト計算がそれより手前に
    // あるためここで同じ式を展開する(片方だけ変更しないこと)
    const usesVolSkip = envIndexList.length > 0 || usesVr || usesDutyEnv;
    const lastVolExtraSlots = usesVolSkip ? 1 : 0;
    // NOTELEN/RESTLEN(sticky音長、2026-08-16): 直前に読んだ音符/休符の音長バイト。
    // バイトコードの1バイト形式(音長省略)がこの値を再利用する(mckBytecode.js参照)
    const totalPerChanBlocks = 11 + n163ExtraSlots + fme7ExtraSlots + epExtraSlots + mpExtraSlots +
      ptExtraSlots + enExtraSlots + freqOnlyExtraSlots + smoothExtraSlots + psExtraSlots + vrExtraSlots +
      dutyExtraSlots + detuneExtraSlots + sweepExtraSlots + envActExtraSlots + saExtraSlots + lastVolExtraSlots;
    // fixedBase以降(JMPLO,JMPHI,FME7専用グローバル,CEILDIVスクラッチ,PLAYIDX)の固定個数。
    // 下のchArrayBase判定に含める(このブロックも$0100-$01FFに掛かってはいけないため)。
    // PS(2026-08-13)使用時は16bit÷8bit版CEILDIV16のスクラッチ(CDA16LO/HI)+
    // RD_PITCHSHIFT設定用スクラッチ(PSNEWNOTE/PSOLDLO/PSOLDHI)の5byteを追加する。
    // PLAYIDX(2026-08-16 最適化)はPLAYのチャンネルループカウンタ1byte(旧実装は
    // LDX #i/JSR SERVICE_CHをチャンネル数ぶんアンロールしており5byte/chを消費していた)
    const TRAILING_FIXED_SIZE = 14 + (usesPitchShift ? 5 : 0) + (usesPitchSa ? 3 : 0);
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
      // sticky音長(2026-08-16): 直前に明示形式で読んだ音符/休符の音長。バイトコードの
      // 1バイト形式(mckBytecode.jsのNOTE_IMPLICIT_BASE/OP_REST_SAME)がこれを再利用する
      NOTELEN = chArrayBase + 9 * n, RESTLEN = chArrayBase + 10 * n;
    // N163共有バッファアロケータ用(usesN163CustomWaves時のみ実際に使う。未使用時も定数
    // 自体は計算するがコード上参照されない): WAVEOFS=このchが今使っている波形のバイト
    // オフセット(OP_N163_WAVE_RELOADで動的に書き換わる)、TBLLO/TBLHI=このchが今使っている
    // 音色の周波数テーブル(N163_TABLE_<L>)への間接ポインタ(音色ロード時に固定値を設定。
    // TBLLO/TBLHI自体は,X直接インデックスのみで使われ間接アドレッシングのポインタとしては
    // 使わないため255番地を超えても問題ない=PTBLLO/PTBLHIへ都度コピーしてから間接読みする)
    const WAVEOFS = chArrayBase + 11 * n, TBLLO = chArrayBase + 12 * n, TBLHI = chArrayBase + 13 * n;
    // FME7ハードウェアエンベロープ(S<n>/M<n>)使用中フラグ。チャンネルごとに持つ必要が
    // あるのはこれだけで、形状・周期(R11-R13)はチップ内に1組しか無いためグローバル
    // (FMEESH/FMEEPL/FMEEPH)に持つ。usesFme7の時のみ実際に使う
    const FMEEACT = chArrayBase + (11 + n163ExtraSlots) * n;
    // EP<n>(ピッチエンベロープ)用チャンネルごとの状態。usesEpの時のみ実際に使う。
    // EPACT=有効フラグ、EPSEL=選択中のROMテーブル番号(EP_LEN/EP_LOOP/EP_PTRの添字)、
    // EPTICK=経過フレーム(ENVTICKと同じ意味、ただしdelay経過後から0起算)。
    // EPVALLO/EPVALHIはEP_LOOKUPが書き込む符号付き16bitの現在値(APPLY_DETUNE/
    // APPLY_DETUNE_N163が読む)。EPDELAYSET=EP<n>,<delay>で指定されたdelay値(RD_PITCHENVで
    // セット)、EPDELAY=その残りカウントダウン(RD_NOTEでEPDELAYSETから再初期化、実機
    // lfo_start_counterと同じ「delay中はdec;この音符ではEP無反映」という考え方。
    // 2026-08-11 別プロジェクトA、compiler.jsのseg.pitchEnvDelay/EP_STEPと対応)
    const EPACT = chArrayBase + (11 + n163ExtraSlots + fme7ExtraSlots) * n,
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
    // EN<n>(ノートエンベロープ=高速アルペジオ、2026-08-14)用チャンネルごとの状態。
    // usesEnの時のみ実際に使う。EP_LOOKUPと違い「値を直接読み直す」方式ではなく、
    // 前回値へ差分を足し込む累積方式(compiler.jsのcumulativeEnvelopeValueと同じ)。
    // ENACT=有効フラグ、ENSEL=選択中のROMテーブル番号(EN_LEN/EN_LOOP/EN_PTRの添字)、
    // ENTICK=次に読むテーブル位置(post-increment、EPTICKと同じ考え方だが値を直接読む
    // のではなく都度加算していく点が違う)、ENVAL=現在の累積オフセット(符号付き1byte、
    // ノート番号(0-107)空間なので16bitは不要。LOOKUP_PULSE_PERIOD等がNOTE,Xへ
    // 加算してからテーブル参照する)
    const enBase = ptBase + ptExtraSlots * n;
    const ENACT = enBase, ENSEL = enBase + n, ENTICK = enBase + 2 * n, ENVAL = enBase + 3 * n;
    // LASTHI: EP/MP/PT/PS/ENの継続フレーム再書込み(WRITE_FREQ_ONLY)、およびSMの音符アタック時
    // 書込み省略判定で、位相リセット副作用を持つ上位バイトレジスタを「実際に変わった時だけ」
    // 書くための直近書込み値(compiler.js writePitchModulation/WFV_T*のsmoothLastHiと
    // 同じロジック、n×1byte)。needsLastHi(EP・MP・PT・PS・SM・ENのいずれかを使う)曲でのみ確保する
    const freqOnlyBase = enBase + enExtraSlots * n;
    const LASTHI = freqOnlyBase;
    // SM/SMOF(2026-08-13、対応ABC): 音符ごとのON/OFF状態。usesSmoothの時のみ実際に使う
    const smoothBase = freqOnlyBase + freqOnlyExtraSlots * n;
    const SMOOTHACT = smoothBase;
    // PS(ポルタメント、実機準拠、2026-08-13、対応ABC)用チャンネルごとの状態。
    // usesPitchShiftの時のみ実際に使う。PT_STEPと同型の「post-increment、ceildivで
    // 確定したstepSz/stepIntごとに1歩ずつ進める」状態遷移だが、目標(0)に到達したら
    // PSACTを自らクリアして停止する点がPT(到達後も値を保持し続ける)と異なる
    // (RD_PITCHSHIFT/PS_STEP参照)。PSACT=有効フラグ、PSDIR=方向(0=加算/非0=減算、
    // PTDIRと同じ規約)、PSSTEPSZ/PSSTEPINT=RD_PITCHSHIFTでCEILDIV16により確定した
    // 1ステップの増減量/間隔、PSSTEPCNT=次のステップまでのカウンタ、PSVALLO/PSVALHI=
    // 累積オフセット(符号付き16bit、APPLY_DETUNE/APPLY_DETUNE_N163が読む。グライド元との
    // 差分から0への収束値)
    const psBase = smoothBase + smoothExtraSlots * n;
    const PSACT = psBase, PSDIR = psBase + n, PSSTEPSZ = psBase + 2 * n, PSSTEPINT = psBase + 3 * n,
      PSSTEPCNT = psBase + 4 * n, PSVALLO = psBase + 5 * n, PSVALHI = psBase + 6 * n;
    // @vr<n>(リリースエンベロープ、2026-08-13)用チャンネルごとの状態。usesVrの時のみ
    // 実際に使う。VRSEL=選択中のコンパクトなROMテーブル番号($FF=未選択、@vr<n>選択時に
    // 更新するだけで音符アタックでは変更しない=実機同様v<n>等でも解除されない)、
    // RELPLAY=ゲートオフ後にリリースエンベロープを再生中かどうかのフラグ(RD_RESTで
    // VRSEL<>$FFなら1、RD_NOTEで新しい音符が始まるたび0にリセット)、RELTICK=
    // リリーステーブル内の経過tick(ENVTICKと同じ意味、ゲートオフ時に0から起算)
    const vrBase = psBase + psExtraSlots * n;
    // VOLBASE=v<n>(OP_VOL)で設定された素の音量の控え。@vrのリリース再生はVOL,Xを
    // リリーステーブルの値(通常は末尾0)で上書きしてしまうため、@v<n>による毎音符の
    // 再初期化が無い(v<n>固定音量の)曲では次の音符が音量0のまま鳴らなくなる。
    // RD_NOTEのアタックで必ずここから復元する(2026-08-15)
    const VRSEL = vrBase, RELPLAY = vrBase + n, RELTICK = vrBase + 2 * n, VOLBASE = vrBase + 3 * n;
    // @@<n>/@@r<n>(デューティ=音色エンベロープ、2026-08-15)。usesDutyEnvの時のみ実際に使う
    const dutyBase = vrBase + vrExtraSlots * n;
    const DUTYSEL = dutyBase, DUTYTICK = dutyBase + n, TONEBASE = dutyBase + 2 * n,
      RELTONE = dutyBase + 3 * n;
    // D<n>(デチューン、2026-08-16 ROM圧縮対応)。チャンネルごとの符号付き16bit生オフセット
    // (下位/上位バイト)。usesDetuneの時のみ実際に使う。APPLY_DETUNE/APPLY_DETUNE_N163参照
    // (以前は他の全項目と違ってusesXxxで条件付き確保されていなかった)
    const detuneBase = dutyBase + dutyExtraSlots * n;
    const DETUNE_LO = detuneBase, DETUNE_HI = detuneBase + n;
    // ENVACT/ENVSEL/ENVTICK(@v<n>、2026-08-16 ROM圧縮対応)。envIndexList.length>0の時のみ
    // 実際に使う。ENV_LOOKUP本体・SERVICE_CH側の毎フレーム処理・RD_VOL/RD_NOTE等は
    // 既にenvTableCount>0でガード済み(このZP確保だけが唯一無条件だった)
    // s<speed>,<depth>(ハードウェアスイープ、2026-08-20)。$4001/$4005へそのまま書く生バイト
    // (mckBytecode.jsのOP_SWEEP=0xE3が運んでくる。compiler.jsのsweepRegisterByteと同じ値)
    const sweepBase = detuneBase + detuneExtraSlots * n;
    const SWEEPREG = sweepBase;
    const envActBase = sweepBase + sweepExtraSlots * n;
    const ENVACT = envActBase, ENVSEL = envActBase + n, ENVTICK = envActBase + 2 * n;
    const saBase = envActBase + envActExtraSlots * n;
    const SAAMT = saBase;
    // LASTVOL(2026-08-26): 直近に音量レジスタへ書いたVOL,Xの値。TICK_VOL_FXの継続フレームで
    // 「前フレームと同じ音量なら書込みごと省く」ための比較用(下記TICK_VOL_FXのコメント参照)。
    // $FF=無効(音量は0-63しか取らないので番兵として使える)。usesVolOnlyの時のみ確保する
    const lastVolBase = saBase + saExtraSlots * n;
    const LASTVOL = lastVolBase;
    // fixedBaseから先はチャンネル数nと無関係な固定個数のグローバルスクラッチ(,Xインデックス
    // なし)。JMPLOはJMP間接絶対(2バイトアドレスなので物理ゼロページ外でも正しく動く)、
    // FME7専用グローバル・CEILDIV用スクラッチも通常のLDA/STA(間接アドレッシングではない)
    // なので255番地を超えても問題ない(CURLO/PERLO/PTBLLO等の物理ゼロページ必須組は
    // 既に先頭0-7番地に固定済み、このコメント直前を参照)
    const fixedBase = lastVolBase + lastVolExtraSlots * n;
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
    // PS(2026-08-13)専用のグローバルスクラッチ。CDA16LO/HI=CEILDIV16(16bit÷8bit版)の
    // 被除数(結果はCDQへ、CDBは既存の8bit版と共用)。周期レジスタの差分は最大2047程度
    // (11bit)になりうるため、MP/PTが使う8bit版CEILDIVでは桁あふれする(RD_PITCHSHIFT参照)。
    // PSNEWNOTE=読み取った目標ノート番号の一時保存、PSOLDLO/PSOLDHI=グライド元
    // (直前のNOTE,X)の周期/周波数レジスタ値の一時保存(いずれもチャンネル非依存、
    // RD_PITCHSHIFTの実行中だけ使う使い捨てスクラッチ)
    const CDA16LO = usesPitchShift ? fixedBase + 13 : 0, CDA16HI = usesPitchShift ? fixedBase + 14 : 0,
      PSNEWNOTE = usesPitchShift ? fixedBase + 15 : 0, PSOLDLO = usesPitchShift ? fixedBase + 16 : 0,
      PSOLDHI = usesPitchShift ? fixedBase + 17 : 0;
    // PLAYのチャンネルループカウンタ(SERVICE_CHがXを保存する保証は無いため、メモリへ
    // 退避して回す。2026-08-16 最適化: アンロール5byte/ch→固定13byteのループ化)
    const PLAYIDX = fixedBase + 13 + (usesPitchShift ? 5 : 0);
    // SA<num>用の24bitシフト加算スクラッチ(SA_ADD16参照、チャンネル非依存の使い捨て)
    const SAT0 = PLAYIDX + 1, SAT1 = PLAYIDX + 2, SAT2 = PLAYIDX + 3;

    const playLines = [];
    playLines.push(`    LDX #$00
PLAY_CHLOOP:
    STX ${hex(PLAYIDX)}
    JSR SERVICE_CH
    LDX ${hex(PLAYIDX)}
    INX
    CPX #${hex(n)}
    BNE PLAY_CHLOOP`);

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
    // @vr<n>の実体テーブル。本家ppmckの@vr<n>は@v<n>定義そのものへの参照なので、
    // 本ツール独自の@vr<n>={...}定義が無ければ@v<n>の定義へフォールバックする
    // (compiler.jsのresolveEnvTablesと同じ規則)
    const vrTableOf = idx => (envelopes.vr && envelopes.vr[idx]) || (envelopes.v && envelopes.v[idx]) || {};
    // @@<n>(デューティ=音色エンベロープ)の実体テーブル(@<n>={...}の定義)
    const dutyTableOf = idx => (envelopes.duty && envelopes.duty[idx]) || {};
    // 音量レジスタのみを書くハンドラ群(WRITE_VOL_ONLY/WFV_VOL_*)が必要かどうか。
    // @v(ソフトウェア音量エンベロープ)だけでなく、@vr(リリースエンベロープ)単独でも
    // 毎フレームの音量書き換えに使うため、どちらか一方でも使われていれば埋め込む
    const usesVolOnly = envTableCount > 0 || usesVr || usesDutyEnv;
    if (envTableCount > 0) {
      const envLens = envIndexList.map(idx => ((envelopes.v[idx] || {}).values || []).length);
      const envLoops = envIndexList.map(idx => {
        const loop = (envelopes.v[idx] || {}).loop;
        return (loop == null) ? 0xff : loop;
      });
      const { ptrExprs: envPtrExprs, dataBlocks: envDataBlocks } = packEnvelopeTables(
        envIndexList, 'ENV',
        // FDS/VRC6のこぎり波は6bit音量なので63でクランプ(他chは各WFV_*が4bitマスクするか
        // レジスタ側が下位bitしか見ない。compiler.js writeVolumeEnvelopeのvolMaxと対)
        idx => ((envelopes.v[idx] || {}).values || []).map(v => Math.max(0, Math.min(63, v | 0)))
      );
      extraTables.push(
        `ENV_LEN:\n    .byte ${envLens.join(',')}\n` +
        `ENV_LOOP:\n    .byte ${envLoops.join(',')}\n` +
        `ENV_PTR:\n    .word ${envPtrExprs.join(',')}\n` +
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
    LDA ${hex(ENVTICK)},X
    CMP ENV_LEN,Y
    BCC ENVLK_INBOUNDS
    LDA ENV_LOOP,Y
    CMP #$FF
    BNE ENVLK_DOLOOP
    LDA ENV_LEN,Y
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

    // --- @vr<n>(リリースエンベロープ、2026-08-13)のテーブル本体をROMへ埋め込む
    // (実際に使われている場合のみ)。ENV_LEN/ENV_LOOP/ENV_PTR/ENV_DATA_*と全く同じ
    // 構造をVR接頭辞で並行して持つ(@vと同じ0-15クランプ値)。実際のレジスタ書込みは
    // 既存のWRITE_VOL_ONLY(WFV_VOL_JUMPTABLE)をそのまま再利用するため、専用の
    // WRITE_*ジャンプテーブルは不要でREL_LOOKUP(ENV_LOOKUPの並行実装)だけを追加する ---
    const vrTableCount = vrIndexList.length;
    if (vrTableCount > 0) {
      const vrLens = vrIndexList.map(idx => (vrTableOf(idx).values || []).length);
      const vrLoops = vrIndexList.map(idx => {
        const loop = vrTableOf(idx).loop;
        return (loop == null) ? 0xff : loop;
      });
      const { ptrExprs: vrPtrExprs, dataBlocks: vrDataBlocks } = packEnvelopeTables(
        vrIndexList, 'VRENV',
        idx => (vrTableOf(idx).values || []).map(v => Math.max(0, Math.min(63, v | 0)))
      );
      extraTables.push(
        `VRENV_LEN:\n    .byte ${vrLens.join(',')}\n` +
        `VRENV_LOOP:\n    .byte ${vrLoops.join(',')}\n` +
        `VRENV_PTR:\n    .word ${vrPtrExprs.join(',')}\n` +
        vrDataBlocks.join('\n')
      );
      // --- リリースエンベロープ: X=チャンネル番号のまま呼ぶ。VRSEL[X]/RELTICK[X]から
      // テーブルを引き(ENV_LOOKUPと全く同じロジック)、結果をVOL[X]へ書く。
      // 呼び出し元(RD_REST/SERVICE_CH)がこの直後にWRITE_VOL_ONLYを呼んで実際の
      // レジスタへ反映する ---
      extraHandlers.push(`
REL_LOOKUP:
    LDA ${hex(VRSEL)},X
    TAY
    LDA ${hex(RELTICK)},X
    CMP VRENV_LEN,Y
    BCC RELLK_INBOUNDS
    LDA VRENV_LOOP,Y
    CMP #$FF
    BNE RELLK_DOLOOP
    LDA VRENV_LEN,Y
    SEC
    SBC #$01
    STA ${hex(RELTICK)},X
    JMP RELLK_INBOUNDS
RELLK_DOLOOP:
    STA ${hex(RELTICK)},X
RELLK_INBOUNDS:
    TYA
    ASL A
    TAY
    LDA VRENV_PTR,Y
    STA ${hex(PERLO)}
    LDA VRENV_PTR+1,Y
    STA ${hex(PERHI)}
    LDA ${hex(RELTICK)},X
    CLC
    ADC ${hex(PERLO)}
    STA ${hex(PERLO)}
    BCC RELLK_NOCARRY
    INC ${hex(PERHI)}
RELLK_NOCARRY:
    LDY #$00
    LDA (${hex(PERLO)}),Y
    STA ${hex(VOL)},X
    RTS`);
    }

    // --- @@<n>(デューティ=音色エンベロープ、2026-08-15)のテーブル本体をROMへ埋め込む
    // (実際に使われている場合のみ)。ENV_*/VRENV_*と全く同じ構造をDUTYENV接頭辞で持つ
    // (値は実機ppmckのgetTone同様0-7へクランプ)。レジスタ書込みは音量と同じ
    // WRITE_VOL_ONLY(デューティは音量レジスタに同居する)をそのまま再利用するので、
    // DUTY_LOOKUP(ENV_LOOKUPの並行実装、結果をDUTY[X]へ書く)だけを追加する ---
    if (usesDutyEnv) {
      const dutyLens = dutyIndexList.map(idx => (dutyTableOf(idx).values || []).length);
      const dutyLoops = dutyIndexList.map(idx => {
        const loop = dutyTableOf(idx).loop;
        return (loop == null) ? 0xff : loop;
      });
      const { ptrExprs: dutyPtrExprs, dataBlocks: dutyDataBlocks } = packEnvelopeTables(
        dutyIndexList, 'DUTYENV',
        idx => (dutyTableOf(idx).values || []).map(v => Math.max(0, Math.min(7, v | 0)))
      );
      extraTables.push(
        `DUTYENV_LEN:\n    .byte ${dutyLens.join(',')}\n` +
        `DUTYENV_LOOP:\n    .byte ${dutyLoops.join(',')}\n` +
        `DUTYENV_PTR:\n    .word ${dutyPtrExprs.join(',')}\n` +
        dutyDataBlocks.join('\n')
      );
      extraHandlers.push(`
DUTY_LOOKUP:
    LDA ${hex(DUTYSEL)},X
    TAY
    LDA ${hex(DUTYTICK)},X
    CMP DUTYENV_LEN,Y
    BCC DUTYLK_INBOUNDS
    LDA DUTYENV_LOOP,Y
    CMP #$FF
    BNE DUTYLK_DOLOOP
    LDA DUTYENV_LEN,Y
    SEC
    SBC #$01
    STA ${hex(DUTYTICK)},X
    JMP DUTYLK_INBOUNDS
DUTYLK_DOLOOP:
    STA ${hex(DUTYTICK)},X
DUTYLK_INBOUNDS:
    TYA
    ASL A
    TAY
    LDA DUTYENV_PTR,Y
    STA ${hex(PERLO)}
    LDA DUTYENV_PTR+1,Y
    STA ${hex(PERHI)}
    LDA ${hex(DUTYTICK)},X
    CLC
    ADC ${hex(PERLO)}
    STA ${hex(PERLO)}
    BCC DUTYLK_NOCARRY
    INC ${hex(PERHI)}
DUTYLK_NOCARRY:
    LDY #$00
    LDA (${hex(PERLO)}),Y
    STA ${hex(DUTY)},X
    RTS`);
    }

    // --- 音色バイト(A)をこのチャンネルへ適用する共通ルーチン(2026-08-15)。
    // 実機ppmck internal.h duty_set と同じくbit7で分岐する:
    //   1 = 固定音色(@<n>) … DUTY,Xへ値を入れ、デューティエンベロープを解除
    //   0 = デューティエンベロープ番号(@@<n>) … 選択してtick0から引き直す
    // デューティエンベロープを一度も使わない曲(FDS/VRC7で@@r<n>だけを使う等)では
    // bit7=1しか来ないので、固定音色側だけを埋め込む ---
    if (usesToneState) {
      extraHandlers.push(`
APPLY_TONE:
${usesDutyEnv ? `    BPL APPLY_TONE_ENV` : ''}
    AND #$7F
    STA ${hex(DUTY)},X
${usesDutyEnv ? `    LDA #$FF
    STA ${hex(DUTYSEL)},X` : ''}
    RTS
${usesDutyEnv ? `APPLY_TONE_ENV:
    STA ${hex(DUTYSEL)},X
    LDA #$00
    STA ${hex(DUTYTICK)},X
    JMP DUTY_LOOKUP` : ''}`);
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
      const { ptrExprs: epPtrExprs, dataBlocks: epDataBlocks } = packEnvelopeTables(
        epIndexList, 'EP',
        idx => ((envelopes.ep[idx] || {}).values || []).map(v => Math.max(-128, Math.min(127, v | 0)) & 0xff)
      );
      extraTables.push(
        `EP_LEN:\n    .byte ${epLens.join(',')}\n` +
        `EP_LOOP:\n    .byte ${epLoops.join(',')}\n` +
        `EP_PTR:\n    .word ${epPtrExprs.join(',')}\n` +
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
    LDA ${hex(EPTICK)},X
    CMP EP_LEN,Y
    BCC EPLK_INBOUNDS
    LDA EP_LOOP,Y
    CMP #$FF
    BNE EPLK_DOLOOP
    LDA EP_LEN,Y
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

    // --- EN<n>(ノートエンベロープ=高速アルペジオ、2026-08-14)。EPと同じ「使われている
    // インデックスだけをコンパクトに詰める」方式(enIndexList/noteEnvIndexRemap、
    // buildBankedNsfBytes参照)。値は符号付きbyte(-128〜127、EP_DATAと同じ範囲)。
    // ただしEP_LOOKUPと違い「テーブルの値をそのまま読み直す」方式ではなく、前回の
    // 累積値(ENVAL,X)へ今回ぶんの差分を足し込む方式(compiler.jsのcumulativeEnvelopeValue
    // が「values[0..tick]の総和」であることの、フレームごとの逐次計算版) ---
    const enTableCount = enIndexList.length;
    if (enTableCount > 0) {
      const enLens = enIndexList.map(idx => ((envelopes.en[idx] || {}).values || []).length);
      const enLoops = enIndexList.map(idx => {
        const loop = (envelopes.en[idx] || {}).loop;
        return (loop == null) ? 0xff : loop;
      });
      const enDataLabels = enIndexList.map((idx, i) => `EN_DATA_${i}`);
      const enDataBlocks = enIndexList.map((idx, i) => {
        const values = ((envelopes.en[idx] || {}).values || []).map(v => Math.max(-128, Math.min(127, v | 0)) & 0xff);
        return `EN_DATA_${i}:\n${bytesToDb(new Uint8Array(values))}`;
      });
      extraTables.push(
        `EN_LEN:\n    .byte ${enLens.join(',')}\n` +
        `EN_LOOP:\n    .byte ${enLoops.join(',')}\n` +
        `EN_PTR:\n    .word ${enDataLabels.join(',')}\n` +
        enDataBlocks.join('\n')
      );
      // --- EN<n>: X=チャンネル番号のまま呼ぶ。テーブル探索自体はEP_LOOKUPと同型
      // (ENSEL[X]/ENTICK[X]からEN_LEN/EN_LOOPを引く)だが、末尾に達し「ループ無し」なら
      // それ以上は何もせず現状の累積値を保持したまま抜ける(compiler.js側の「非ループは
      // 最終累積値を永久ホールド」と同じ意味。同じ末尾要素を足し込み続けるとドリフトする
      // ため、EPの「末尾値を読み直す」方式とはここが違う)。ループ有りなら末尾を過ぎた分は
      // ENTICKをループ開始位置へ巻き戻してから通常通り加算する ---
      extraHandlers.push(`
EN_STEP:
    LDA ${hex(ENACT)},X
    BEQ EN_STEP_DONE
    LDA ${hex(ENSEL)},X
    TAY
    LDA ${hex(ENTICK)},X
    CMP EN_LEN,Y
    BCC ENLK_ADD
    LDA EN_LOOP,Y
    CMP #$FF
    BEQ EN_STEP_DONE
    STA ${hex(ENTICK)},X
ENLK_ADD:
    TYA
    ASL A
    TAY
    LDA EN_PTR,Y
    STA ${hex(PERLO)}
    LDA EN_PTR+1,Y
    STA ${hex(PERHI)}
    LDA ${hex(ENTICK)},X
    CLC
    ADC ${hex(PERLO)}
    STA ${hex(PERLO)}
    BCC ENLK_NOCARRY
    INC ${hex(PERHI)}
ENLK_NOCARRY:
    LDY #$00
    LDA (${hex(PERLO)}),Y
    CLC
    ADC ${hex(ENVAL)},X
    STA ${hex(ENVAL)},X
    INC ${hex(ENTICK)},X
EN_STEP_DONE:
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

    // --- PS(ポルタメント、実機準拠、2026-08-13、対応ABC)。実ソース
    // (nes_include/ppmck/sounddrv.hのprocess_ps/pitchshift_setup、AoiMoe/ppmck)を
    // 移植したcompiler.jsのpitchShiftOffsetSequenceと同じアルゴリズムを、PT_STEPと
    // 同型のフレームごとの状態遷移として実装する ---
    if (usesPitchShift) {
      extraHandlers.push(`
; --- CEILDIV16: ceilDivPpmck(a,b)相当だが被除数aが16bit(${hex(CDA16LO)}/${hex(CDA16HI)})、
; 除数bは8bit(${hex(CDB)}、既存CEILDIVと共用)。PSの周期レジスタ差分は最大2047程度
; (11bit)になりうり、MP/PTが使う8bit版CEILDIVでは桁あふれするため新設した(アルゴリズムは
; 同じ「while(rem>0){q++;rem-=b}」の16bit版)。qが255に達したらそこで打ち切る(PSSTEPSZ/
; PSSTEPINTが1byteのため。実用上は音程差がここまで極端に大きくなることは無い)。
; 戻り値=A(0-255)。${hex(CDA16LO)}/${hex(CDA16HI)}は呼び出し後に破壊される ---
CEILDIV16:
    LDA #$00
    STA ${hex(CDQ)}
CEILDIV16_LOOP:
    LDA ${hex(CDQ)}
    CMP #$FF
    BEQ CEILDIV16_DONE
    LDA ${hex(CDA16HI)}
    BNE CEILDIV16_SUB
    LDA ${hex(CDA16LO)}
    BEQ CEILDIV16_DONE
CEILDIV16_SUB:
    INC ${hex(CDQ)}
    SEC
    LDA ${hex(CDA16LO)}
    SBC ${hex(CDB)}
    STA ${hex(CDA16LO)}
    LDA ${hex(CDA16HI)}
    SBC #$00
    STA ${hex(CDA16HI)}
    BCS CEILDIV16_LOOP
    LDA #$00
    STA ${hex(CDA16LO)}
    STA ${hex(CDA16HI)}
CEILDIV16_DONE:
    LDA ${hex(CDQ)}
    RTS

; --- PS_STEP: PSの1フレーム分の状態遷移。PT_STEPと同型のpost-increment単一ルーチン
; 設計(RD_PITCHSHIFT/SERVICE_CH継続フレームの両方から呼ぶ)だが、オフセットが0(=目標の
; 新ノートの本来のピッチ)へ到達したらPSACTを自らクリアして以降の呼び出しを無効化する点が
; PT(到達後も最終値を保持し続ける)と異なる。X=チャンネル番号のまま呼ぶ ---
PS_STEP:
    LDA ${hex(PSSTEPCNT)},X
    CMP ${hex(PSSTEPINT)},X
    BNE PS_STEP_ADVANCE
    LDA #$00
    STA ${hex(PSSTEPCNT)},X
    LDA ${hex(PSDIR)},X
    BEQ PS_STEP_ADD
    ; SUBTRACT方向(PSDIR<>0): 正の値から0へ向かって減算していく
    LDA ${hex(PSVALLO)},X
    SEC
    SBC ${hex(PSSTEPSZ)},X
    STA ${hex(PSVALLO)},X
    LDA ${hex(PSVALHI)},X
    SBC #$00
    STA ${hex(PSVALHI)},X
    BPL PS_STEP_ADVANCE
    JMP PS_STEP_CLAMP
PS_STEP_ADD:
    ; ADD方向(PSDIR=0): 負の値から0へ向かって加算していく
    LDA ${hex(PSVALLO)},X
    CLC
    ADC ${hex(PSSTEPSZ)},X
    STA ${hex(PSVALLO)},X
    LDA ${hex(PSVALHI)},X
    ADC #$00
    STA ${hex(PSVALHI)},X
    BMI PS_STEP_ADVANCE
PS_STEP_CLAMP:
    ; 0を通過(=目標に到達)したので0にクランプして停止する
    LDA #$00
    STA ${hex(PSVALLO)},X
    STA ${hex(PSVALHI)},X
    STA ${hex(PSACT)},X
PS_STEP_ADVANCE:
    INC ${hex(PSSTEPCNT)},X
    RTS`);
    }

    if (usesVrc6) {
      extraTables.push(`SAW_TABLE:\n${wordsToDb(buildPeriodTable(sawPeriod))}`);
      extraHandlers.push(`
LOOKUP_SAW_PERIOD:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LSP_NONNEG
    LDA #$00
    JMP LSP_INDEX
LSP_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC LSP_OK
    LDA #${hex(TABLE_MAX)}
LSP_OK:
LSP_INDEX:
    ASL A
    TAY
    LDA SAW_TABLE,Y
    STA ${hex(PERLO)}
    LDA SAW_TABLE+1,Y
    STA ${hex(PERHI)}
    RTS

; --- VRC6パルス1 ($9000)。デューティ(bit4-6)は@<n>命令のn%8(compiler.jsのsegmentsToWriteLogVrc6と同一式) ---
WFV_T4:
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_PULSE_PERIOD
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

; --- VRC6矩形波(サウ) ($B000)。音量(0-63)をそのまま蓄積レートへ(本家ppmck同様) ---
WFV_T6:
    JSR LOOKUP_SAW_PERIOD
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $B001
    LDA ${hex(PERHI)}
    ORA #$80
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $B002
    LDA ${hex(VOL)},X
    STA $B000
    RTS
SIL_T6:
    LDA #$00
    STA $B000
    RTS`);
      wfvEntries[4] = 'WFV_T4'; wfvEntries[5] = 'WFV_T5'; wfvEntries[6] = 'WFV_T6';
      silEntries[4] = 'SIL_T4'; silEntries[5] = 'SIL_T5'; silEntries[6] = 'SIL_T6';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak || usesEn) {
        extraHandlers.push(`
; --- VRC6パルス1/2・矩形波(サウ)のEP<n>/MP<n>継続フレーム専用(周期のみ再書込み) ---
WFO_T4:
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_SAW_PERIOD
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
      if (usesVolOnly) {
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
    STA $B000
    RTS`);
        wfvVolEntries[4] = 'WFV_VOL_T4'; wfvVolEntries[5] = 'WFV_VOL_T5'; wfvVolEntries[6] = 'WFV_VOL_T6';
      }
    }

    if (usesMmc5) {
      extraHandlers.push(`
; --- MMC5パルス1 ($5000) ---
WFV_T7:
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_PULSE_PERIOD
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
      if (usesEp || usesMp || usesPortamento || usesPitchBreak || usesEn) {
        extraHandlers.push(`
; --- MMC5パルス1/2のEP<n>/MP<n>継続フレーム専用(周期のみ再書込み) ---
WFO_T7:
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_PULSE_PERIOD
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
      if (usesVolOnly) {
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
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LFP_NONNEG
    LDA #$00
    JMP LFP_INDEX
LFP_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC LFP_OK
    LDA #${hex(TABLE_MAX)}
LFP_OK:
LFP_INDEX:
    ASL A
    TAY
    LDA FME7_TABLE,Y
    STA ${hex(PERLO)}
    LDA FME7_TABLE+1,Y
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

; --- FME7共用 ($C000アドレス選択/$E000データ書込の間接方式)。X=チャンネル番号のまま呼ぶ。
; チャンネル差分(トーン有効ビット1<<ch/周期レジスタ番号ch*2/音量レジスタ番号8+ch)は
; FME7_TMASK/FME7_PREG/FME7_VREG,Xから引く(2026-08-16 ROM圧縮対応、N163と同じ方式。
; 周期上位レジスタ番号はFME7_PREG|1で導出=PREGは常に偶数0/2/4なのでORで+1と等価) ---
WFV_FME7:
    LDA FME7_TMASK,X
    STA ${hex(FMETM)}
    JSR FME7_PREP
    BCS WFVFME7_TONE
    JMP WFVFME7_VOL  ; @0/@2はトーン周期を書かない
WFVFME7_TONE:
    JSR LOOKUP_FME7_PERIOD
    JSR APPLY_DETUNE
    LDA FME7_PREG,X
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA FME7_PREG,X
    ORA #$01
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFVFME7_VOL:
    LDA FME7_VREG,X
    JMP FME7_WRITE_VOL
SIL_FME7:
    LDA FME7_VREG,X
    STA $C000
    LDA #$00
    STA $E000
    RTS`);
      // チャンネル差分テーブル(Xで直接引く。FME7以外のチャンネル行は0=ジャンプテーブルが
      // 飛ばないため未参照)
      const fme7TmaskByX = [], fme7PregByX = [], fme7VregByX = [];
      for (let i = 0; i < channelTypes.length; i++) {
        const ct = channelTypes[i];
        const fch = (ct === TYPE_FME7_CH0) ? 0 : (ct === TYPE_FME7_CH1) ? 1 : (ct === TYPE_FME7_CH2) ? 2 : null;
        fme7TmaskByX.push(fch == null ? 0 : (1 << fch));
        fme7PregByX.push(fch == null ? 0 : fch * 2);
        fme7VregByX.push(fch == null ? 0 : 8 + fch);
      }
      extraTables.push(
        `FME7_TMASK:\n    .byte ${fme7TmaskByX.join(',')}\n` +
        `FME7_PREG:\n    .byte ${fme7PregByX.join(',')}\n` +
        `FME7_VREG:\n    .byte ${fme7VregByX.join(',')}`
      );
      wfvEntries[9] = 'WFV_FME7'; wfvEntries[10] = 'WFV_FME7'; wfvEntries[11] = 'WFV_FME7';
      silEntries[9] = 'SIL_FME7'; silEntries[10] = 'SIL_FME7'; silEntries[11] = 'SIL_FME7';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak || usesEn) {
        // FME7は間接アドレッシング($C000選択/$E000データ)のみで、2A03等のような
        // 「上位バイト書込みで位相リセット」という副作用が無いため(compiler.jsの
        // segmentsToWriteLogFme7もlastHiガード無しで毎フレーム両バイトを書く)、
        // LASTHIチェックは不要で毎フレーム無条件に書く。@<n>のモード(DUTY,Xの下位2bit、
        // FME7_PREPと同じ判定)でトーンが無効(@0/@2)の間は周期を書かない
        extraHandlers.push(`
; --- FME7共用: EP<n>/MP<n>継続フレーム専用(トーン周期のみ再書込み、@<n>の
; トーン有効ビットが立っている間だけ) ---
WFO_FME7:
    LDA ${hex(DUTY)},X
    AND #$01
    BEQ WFOFME7_DONE
    JSR LOOKUP_FME7_PERIOD
    JSR APPLY_DETUNE
    LDA FME7_PREG,X
    STA $C000
    LDA ${hex(PERLO)}
    STA $E000
    LDA FME7_PREG,X
    ORA #$01
    STA $C000
    LDA ${hex(PERHI)}
    STA $E000
WFOFME7_DONE:
    RTS`);
        wfoEntries[9] = 'WFO_FME7'; wfoEntries[10] = 'WFO_FME7'; wfoEntries[11] = 'WFO_FME7';
      }
      if (usesVolOnly) {
        extraHandlers.push(`
WFV_VOL_FME7:
    LDA FME7_VREG,X
    STA $C000
    LDA ${hex(VOL)},X
    STA $E000
    RTS`);
        wfvVolEntries[9] = 'WFV_VOL_FME7'; wfvVolEntries[10] = 'WFV_VOL_FME7'; wfvVolEntries[11] = 'WFV_VOL_FME7';
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
        // 波形の再ロード判定はサブルーチン化する(音符アタックのWFV_T13だけでなく、
        // @@r<n>のリリース音色でゲートオフの瞬間にも呼ぶ必要があるため、2026-08-15)
        extraHandlers.push(`
; --- FDSカスタム波形(@FM<n>)の再ロード判定。選択中の音色番号(DUTY,X)が
; 直近ロード済み(LASTINS,X)と違う時だけ64バイトを転送する。Xは保存される ---
FDS_TONE_CHECK:
    LDA ${hex(DUTY)},X
    CMP ${hex(LASTINS)},X
    BNE WFV13_CHECK
    JMP WFV13_TONE_OK
WFV13_CHECK:
${cmpChain}
    JMP WFV13_TONE_OK
${loadBlocks}
WFV13_TONE_OK:
    RTS`);
        fdsReload = `    JSR FDS_TONE_CHECK\n`;
        const toneTables = fdsCustomWaves
          .map((idx, i) => `FDS_CUSTOM_WAVE_${i}:\n${bytesToDb(new Uint8Array(envelopes.fm[idx].map(v => v & 0x3f)))}`)
          .join('\n');
        extraTables.push(toneTables);
      }
      extraHandlers.push(`
; --- FDS ($4082/4083=周期, $4080=ゲイン(音量0-63そのまま。実効32で頭打ち)) ---
WFV_T13:
${fdsReload}    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFV13_NONNEG
    LDA #$00
    JMP WFV13_INDEX
WFV13_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC WFV13_OK
    LDA #${hex(TABLE_MAX)}
WFV13_OK:
WFV13_INDEX:
    ASL A
    TAY
    LDA FDS_TABLE,Y
    STA ${hex(PERLO)}
    LDA FDS_TABLE+1,Y
    STA ${hex(PERHI)}
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $4082
    LDA ${hex(PERHI)}
${usesFreqOnly ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $4083
    LDA ${hex(VOL)},X
    ORA #$80
    STA $4080
    RTS
SIL_T13:
    LDA #$80
    STA $4083
    RTS`);
      wfvEntries[13] = 'WFV_T13';
      silEntries[13] = 'SIL_T13';
      if (usesEp || usesMp || usesPortamento || usesPitchBreak || usesEn) {
        extraHandlers.push(`
; --- FDSのEP<n>/MP<n>継続フレーム専用(周期のみ再書込み。波形再ロードは音符アタック時
; のみなのでここでは行わない) ---
WFO_T13:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFO13_NONNEG
    LDA #$00
    JMP WFO13_INDEX
WFO13_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC WFO13_OK
    LDA #${hex(TABLE_MAX)}
WFO13_OK:
WFO13_INDEX:
    ASL A
    TAY
    LDA FDS_TABLE,Y
    STA ${hex(PERLO)}
    LDA FDS_TABLE+1,Y
    STA ${hex(PERHI)}
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
      if (usesVolOnly) {
        extraHandlers.push(`
WFV_VOL_T13:
    LDA ${hex(VOL)},X
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
      // (2026-08-16まで: N163はテーブル1エントリ3バイトのためYで索引できるのは音程85まで、と
      //  上限を下げていた。現在はN163_TBL_LOOKUPが16bitオフセットで引くため上限はTABLE_MAX)

      // --- N163ハンドラ共用化(2026-08-16 ROM圧縮対応) ---
      // 以前はWFV_T/SIL_T/WFV_VOL_T/WFO_Tを8チャンネルぶん丸ごと複製していた(チャンネル間の
      // 差分は$F800へ書くレジスタ選択即値3種と「最上位chのみ音量レジスタ読み戻し」の構造差
      // だけなのに約1.7KBを占有)。レジスタ選択値をXで引く小さなROMテーブル(N163_SEL0/6/7、
      // チャンネル数nエントリ)へ追い出し、ハンドラ本体は全チャンネル共用の1本にする。
      // 命令列は複製時代と厳密に同一(即値LDAがテーブルLDAに変わる+top判定のCMP/BEQが
      // 増えるのみで、$F800/$4800への書込み値・順序は完全一致)。
      // ・最上位ch(internalIdx=7、音量レジスタ$7Fが有効ch数ビット4-6と共用)の判定は、
      //   コード生成時のisTopChではなく「N163_SEL7,X == $FF」の実行時判定で行う
      //   (regBase+7|0x80が$FFになるのは内部レジスタ$7F=最上位chのみ。未使用スロットの
      //   bogus値($47-$F7)を含め他chでは$FFに到達しないことを確認済み)
      const n163Sel0ByX = [], n163Sel6ByX = [], n163Sel7ByX = [];
      for (let i = 0; i < channelTypes.length; i++) {
        const ct = channelTypes[i];
        let s0 = 0, s6 = 0, s7 = 0;
        if (ct >= TYPE_N163_BASE && ct < TYPE_N163_BASE + N163_CHANNEL_COUNT) {
          // 実チャンネルは内部8ch中「上位numN163Ch個」に配置される(numN163Ch=0の場合は
          // このハンドラ自体が参照されないため internalIdx の値は無関係)
          const internalIdx = (N163_CHANNEL_COUNT - Math.max(numN163Ch, 1)) + (ct - TYPE_N163_BASE);
          const regBase = 0x40 + internalIdx * 8;
          s0 = (regBase | 0x80) & 0xff;
          s6 = ((regBase + 6) | 0x80) & 0xff;
          s7 = ((regBase + 7) | 0x80) & 0xff;
        }
        n163Sel0ByX.push(s0);
        n163Sel6ByX.push(s6);
        n163Sel7ByX.push(s7);
      }
      extraTables.push(
        `N163_SEL0:\n    .byte ${n163Sel0ByX.join(',')}\n` +
        `N163_SEL7:\n    .byte ${n163Sel7ByX.join(',')}` +
        (usesN163CustomWaves ? `\nN163_SEL6:\n    .byte ${n163Sel6ByX.join(',')}` : '')
      );
      // 波形長テーブル参照は、カスタム波形を使う曲ではインスツルメントごとに異なる
      // N163_TABLE_<L>を間接(ptr),Yで、使わない曲は従来通り単一N163_TABLEを絶対,Yで読む
      // (絶対/間接どちらもYを使うよう統一しているだけで、Xは温存されchannel indexのまま)
      // ★2026-08-16: 以前は「Y=ノート番号×3」でテーブルを引いていたため8bitのYに収まる
      // ノート85(=索引255)までしか扱えず(それ以上は85にクランプ=C#7以上が出せない)、
      // しかもカスタム波形時の間接(ptr),Y読みは索引255→INYで0へ折り返し(256/257番地の
      // 代わりに0/1番地)を読んでデタラメな周波数になっていた(女神転生II実リップのRパート
      // ノート85が別の音程で書き出されていた原因)。ノート×3を16bitで計算してポインタ
      // (PTBLLO/PTBLHI)に加算し(ptr),Y(Y=0/1/2)で読む方式に改め、2A03等と同じ全108ノートを
      // 扱えるようにした。カスタム波形の有無はポインタの元(TBLLO/HI,X か 固定N163_TABLE)の
      // 差だけになるので、両方とも共用サブルーチンN163_TBL_LOOKUPで読む(A=ノート索引)
      const tableRead = `    JSR N163_TBL_LOOKUP`;
      const n163TableLookupRoutine = `
; --- N163周波数テーブル読み出し(共用): A=ノート索引(0-${TABLE_MAX})、X=チャンネル番号。
; PERLO/PERHI/PERLO2 <- テーブル3バイト(freq lo / freq mid / lenByte|freq hi)。
; ポインタ=テーブル先頭+ノート×3(16bit)。Xは温存、Yは破壊 ---
N163_TBL_LOOKUP:
    STA ${hex(PERLO)}
    ASL A                   ; ノート×2(最大214、C=0)
    ADC ${hex(PERLO)}       ; ノート×3(最大321、C=9bit目)
    STA ${hex(PERLO2)}
    LDA #$00
    ADC #$00
    STA ${hex(PERHI)}       ; オフセット上位(0/1)
    CLC
${usesN163CustomWaves
    ? `    LDA ${hex(TBLLO)},X\n    ADC ${hex(PERLO2)}\n    STA ${hex(PTBLLO)}\n    LDA ${hex(TBLHI)},X\n    ADC ${hex(PERHI)}\n    STA ${hex(PTBLHI)}`
    : `    LDA #<N163_TABLE\n    ADC ${hex(PERLO2)}\n    STA ${hex(PTBLLO)}\n    LDA #>N163_TABLE\n    ADC ${hex(PERHI)}\n    STA ${hex(PTBLHI)}`}
    LDY #$00
    LDA (${hex(PTBLLO)}),Y
    STA ${hex(PERLO)}
    INY
    LDA (${hex(PTBLLO)}),Y
    STA ${hex(PERHI)}
    INY
    LDA (${hex(PTBLLO)}),Y
    STA ${hex(PERLO2)}
    RTS`;
      const waveAddrRewrite = usesN163CustomWaves
        ? `    LDA N163_SEL6,X\n    STA $F800       ; 波形アドレス(+6)。` +
          `共有アロケータのオフセットは固定でなくなったため毎回書き直す\n    LDA ${hex(WAVEOFS)},X\n    ASL A\n    STA $4800\n`
        : '';
      const n163Handlers = [];
      n163Handlers.push(n163TableLookupRoutine);
      n163Handlers.push(`
; --- N163共用: 音量レジスタ(regBase+7)書込み。X=チャンネル番号のまま呼ぶ。
; 最上位ch(N163_SEL7,X=$FF)のみ、$7Fの有効チャンネル数ビット(4-6)を読み戻して保持する ---
N163_WVOL:
    LDA N163_SEL7,X
    CMP #$FF
    BEQ NWVOL_TOP
    STA $F800
    LDA ${hex(VOL)},X
    AND #$0F        ; compiler.js volByte(非最上位ch)と同じくbit4-7は0(以前は#$10を
    STA $4800       ; ORしていた。実機は非$7Fの上位ビットを無視するが、ブラウザ再生との
    RTS             ; レジスタトレース比較で常時食い違う唯一の点だったので揃える)
NWVOL_TOP:
    STA $F800
    LDA $4800       ; 現在値読出し(有効ch数ビットを保持するため)
    AND #$F0
    STA ${hex(PERLO)}
    LDA #$10
    ORA ${hex(VOL)},X
    AND #$0F
    ORA ${hex(PERLO)}
    STA ${hex(PERLO)}
    LDA N163_SEL7,X
    STA $F800       ; 読出しでアドレスが進むため再選択
    LDA ${hex(PERLO)}
    STA $4800
    RTS

; --- N163共用: 無音化。X=チャンネル番号のまま呼ぶ。最上位chの読み戻しはN163_WVOLと同じ理由 ---
SIL_N163:
    LDA N163_SEL7,X
    CMP #$FF
    BEQ NSIL_TOP
    STA $F800
    LDA #$00
    STA $4800
    RTS
NSIL_TOP:
    STA $F800
    LDA $4800       ; 現在値読出し(有効ch数ビットを保持するため)
    AND #$F0
    STA ${hex(PERLO)}
    LDA N163_SEL7,X
    STA $F800       ; 読出しでアドレスが進むため再選択
    LDA ${hex(PERLO)}
    STA $4800
    RTS

; --- N163共用: 音符の周波数+波形+音量書込み($F800アドレス選択/$4800データ書込)。
; X=チャンネル番号のまま呼ぶ。レジスタ選択値はN163_SEL0/6/7,Xから引く。
; 末尾はN163_WVOLへのtail call(旧複製版のインライン音量書込み+RTSと等価) ---
WFV_N163:
${n163ToneCheckCall}    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFVN163_NONNEG
    LDA #$00
    JMP WFVN163_INDEX
WFVN163_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC WFVN163_OK
    LDA #${hex(TABLE_MAX)}
WFVN163_OK:
WFVN163_INDEX:
    ; このルーチンはXを一切破壊しない(索引はY・(ptr),Yのみ)ため、旧複製版にあった
    ; STX/LDX CHIDXの退避・復元は不要(2026-08-16 最適化)
${tableRead}
    JSR APPLY_DETUNE_N163
    LDA N163_SEL0,X
    STA $F800       ; regBase+0(freq lo)を選択、オートインクリメントON
    LDA ${hex(PERLO)}
    STA $4800       ; +0=freq lo書込み、addrは+1(位相byte)へ進む
    LDA $4800       ; +1(位相lo)を空読みして読み飛ばす、addrは+2へ
    LDA ${hex(PERHI)}
    STA $4800       ; +2=freq mid書込み、addrは+3(位相byte)へ進む
    LDA $4800       ; +3(位相mid)を空読みして読み飛ばす、addrは+4へ
    LDA ${hex(PERLO2)}
    STA $4800       ; +4=freq hi|波形長書込み
${waveAddrRewrite}    JMP N163_WVOL`);
      if (usesEp || usesMp || usesPortamento || usesPitchBreak || usesEn) {
        // N163は間接アドレッシング(オートインクリメント+位相byte空読み)のみで、
        // 2A03等のような「上位バイト書込みで位相リセット」という副作用が無いため
        // (compiler.jsのwriteN163Freqもlastガード無しで毎フレーム全バイトを書く)、
        // LASTHIチェックは不要で毎フレーム無条件に書く。波形アドレス(+6)の再書込みは
        // 音符アタック時のみなのでここでは行わない
        n163Handlers.push(`
; --- N163共用: EP<n>/MP<n>継続フレーム専用(周波数のみ再書込み) ---
WFO_N163:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFON163_NONNEG
    LDA #$00
    JMP WFON163_INDEX
WFON163_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC WFON163_OK
    LDA #${hex(TABLE_MAX)}
WFON163_OK:
WFON163_INDEX:
${tableRead}
    JSR APPLY_DETUNE_N163
    LDA N163_SEL0,X
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
      }
      // ジャンプテーブルは8チャンネル(TYPE 14-21)全てが同じ共用ルーチンを指す
      for (let ch = 0; ch < N163_CHANNEL_COUNT; ch++) {
        const t = TYPE_N163_BASE + ch;
        wfvEntries[t] = 'WFV_N163';
        silEntries[t] = 'SIL_N163';
        if (usesVolOnly) wfvVolEntries[t] = 'N163_WVOL';
        if (usesEp || usesMp || usesPortamento || usesPitchBreak || usesEn) wfoEntries[t] = 'WFO_N163';
      }
      extraHandlers.push(n163Handlers.join('\n'));
      if (usesAnyPitchOffset) extraHandlers.push(`
; --- N163用D<n>/EP<n>/MP<n>共通処理。PERLO/PERHI/PERLO2に freqReg(18bit、3バイト:
; 下位/中位/上位2bit)が入っている状態で呼ぶ(呼出し前提はAPPLY_DETUNEと同じ、
; X=チャンネル番号)。PERLO2の上位6bitは波形長定数($F0)がOR済みなので、まず
; AND #$03で真の上位2bitだけを取り出してから16bit加算+3バイト目への符号拡張
; (各オフセットのbit7)を通常の多倍長2の補数加算として行う(D<n>のブロックの直後の
; ADC PERLO2はD<n>16bit加算のキャリーを引き継ぐ。CLCを挟まないのが重要。EP/MPも
; 同様に自ブロック内のキャリーを引き継ぐ)。3つとも加算し終えた最終結果が負(PERLO2の
; bit7が立つ)ならPERLO/PERHI/PERLO2=0にクランプし、そうでなければ上位2bitを
; 再度AND #$03でマスクしてから波形長ビットを戻す。
; ★2026-08-16修正: 波形長ビット(bit2-7)は以前 ORA #$F0 (=16サンプル固定)で戻していた。
; @N<n>が16サンプル以外(32サンプル等)の曲でD/EP/MP/PT/PSのいずれかを使うと、テーブル
; (N163_TABLE_<L>)がLに合わせて符号化した周波数値に対し波形長だけ16に潰されて書き込まれ、
; 実機は波形の先頭16サンプルだけを1オクターブ上で鳴らしていた(女神転生II実リップ変換で
; P/Q/Sの音色崩れ+1オクターブ上、Rは16サンプル波形だったため無事、という症状で発覚)。
; 入口でPERLO2の波形長ビットをPTBLHIへ退避し(tableRead直後で以後この呼出し内では
; 未使用のスクラッチ)、出口でそれをORして戻す ---
APPLY_DETUNE_N163:
    LDA ${hex(PERLO2)}
    AND #$FC
    STA ${hex(PTBLHI)}     ; 波形長ビット退避
    LDA ${hex(PERLO2)}
    AND #$03
    STA ${hex(PERLO2)}
${usesDetune ? (usesPitchSa ? `    LDA ${hex(DETUNE_LO)},X
    STA ${hex(SAT0)}
    LDA ${hex(DETUNE_HI)},X
    STA ${hex(SAT1)}
    JSR SA_ADD16           ; D<n>をSAAMT,X回左シフトして加算(SA<num>、本家仕様)
` : `    CLC
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
`) : ''}${usesEp ? (usesPitchSa ? `    LDA ${hex(EPVALLO)},X
    STA ${hex(SAT0)}
    LDA ${hex(EPVALHI)},X
    STA ${hex(SAT1)}
    JSR SA_ADD16           ; EP値をSAAMT,X回左シフトして加算(SA<num>)
` : `    CLC
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
`) : ''}${usesMp ? (usesPitchSa ? `    LDA ${hex(MPVALLO)},X
    STA ${hex(SAT0)}
    LDA ${hex(MPVALHI)},X
    STA ${hex(SAT1)}
    JSR SA_ADD16           ; MP累積値をSAAMT,X回左シフトして加算(SA<num>)
` : `    CLC
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
`) : ''}${usesPortamento ? `    CLC
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
    BPL ADN163_NONNEG
    LDA #$00
    STA ${hex(PERLO)}
    STA ${hex(PERHI)}
    STA ${hex(PERLO2)}
    JMP ADN163_DONE
ADN163_NONNEG:
    CMP #$04
    BCC ADN163_DONE        ; 0-3=18bit範囲内
    LDA #$FF               ; 正方向の18bit溢れは最大値$3FFFFへクランプ
    STA ${hex(PERLO)}      ; (compiler.js applyDetune/n163FreqRegのmin(262143)と同じ。
    STA ${hex(PERHI)}      ; 以前は負方向のみクランプし正方向は18bitで折り返していた)
    LDA #$03
    STA ${hex(PERLO2)}
ADN163_DONE:
    LDA ${hex(PERLO2)}
    ORA ${hex(PTBLHI)}     ; 退避しておいた波形長ビットを戻す(以前は#$F0固定=バグ)
    STA ${hex(PERLO2)}
    RTS${usesPitchSa ? `

; --- SA<num>共用: SAT0/SAT1(符号付き16bit)をSAAMT,X回左シフト(符号拡張24bit)して
; PERLO/PERHI/PERLO2へ加算する(本家sounddrv.h freq_add_mcknumber_with_aslの
; asl t0/rol t1/rol t2ループと同じ考え方)。Yは破壊する(APPLY_DETUNE_N163の呼び出し元は
; JSR後にYを再利用しない、WFV_N163/WFO_N163参照)。SAAMT=0なら素の16bit加算と等価 ---
SA_ADD16:
    LDA ${hex(SAT1)}
    AND #$80
    BEQ SAADD_POS
    LDA #$FF
    BNE SAADD_EXT
SAADD_POS:
    LDA #$00
SAADD_EXT:
    STA ${hex(SAT2)}
    LDY ${hex(SAAMT)},X
    BEQ SAADD_ADD
SAADD_SHIFT:
    ASL ${hex(SAT0)}
    ROL ${hex(SAT1)}
    ROL ${hex(SAT2)}
    DEY
    BNE SAADD_SHIFT
SAADD_ADD:
    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(SAT0)}
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(SAT1)}
    STA ${hex(PERHI)}
    LDA ${hex(PERLO2)}
    ADC ${hex(SAT2)}
    STA ${hex(PERLO2)}
    RTS` : ''}`);
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
      // --- VRC7ハンドラ共用化(2026-08-16 ROM圧縮対応、N163と同じ方式) ---
      // 以前はWFV_T/SIL_T(+EN使用時WFO_T)を6チャンネルぶん丸ごと複製していた。チャンネル間の
      // 差分はレジスタ番号即値3種($10+ch/$20+ch/$30+ch)のみ(ポート$9010/$9030は固定)なので、
      // Xで引くROMテーブル(VRC7_SEL1/2/3、チャンネル数nエントリ)へ追い出し共用1本にする。
      // N163と違い最上位ch特殊処理のような構造差も無く、命令列は即値LDA→テーブルLDAの
      // 置換のみで厳密同一。VRC7以外のチャンネル行は0(ジャンプテーブルが飛ばないため未参照)
      const vrc7Sel1ByX = [], vrc7Sel2ByX = [], vrc7Sel3ByX = [];
      for (let i = 0; i < channelTypes.length; i++) {
        const ct = channelTypes[i];
        const vch = (ct >= TYPE_VRC7_BASE && ct < TYPE_VRC7_BASE + 6) ? (ct - TYPE_VRC7_BASE) : null;
        vrc7Sel1ByX.push(vch == null ? 0 : 0x10 + vch);
        vrc7Sel2ByX.push(vch == null ? 0 : 0x20 + vch);
        vrc7Sel3ByX.push(vch == null ? 0 : 0x30 + vch);
      }
      extraTables.push(
        `VRC7_SEL1:\n    .byte ${vrc7Sel1ByX.join(',')}\n` +
        `VRC7_SEL2:\n    .byte ${vrc7Sel2ByX.join(',')}\n` +
        `VRC7_SEL3:\n    .byte ${vrc7Sel3ByX.join(',')}`
      );
      const vrc7Handlers = [];
      vrc7Handlers.push(`
; --- VRC7共用 ($9010アドレス選択/$9030データ書込)。X=チャンネル番号のまま呼ぶ。
; レジスタ番号($10+ch/$20+ch/$30+ch)はVRC7_SEL1/2/3,Xから引く ---
WFV_VRC7:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFVVRC7_NONNEG
    LDA #$00
    JMP WFVVRC7_INDEX
WFVVRC7_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC WFVVRC7_OK
    LDA #${hex(TABLE_MAX)}
WFVVRC7_OK:
WFVVRC7_INDEX:
    ASL A
    TAY
    LDA VRC7_TABLE,Y
    STA ${hex(PERLO)}
    LDA VRC7_TABLE+1,Y
    STA ${hex(PERHI)}
    LDA VRC7_SEL1,X
    STA $9010
    LDA ${hex(PERLO)}
    STA $9030
    ; ★キーオン(bit4)はYM2413実機同様0→1のエッジトリガ(src/emulator/expansion/vrc7.js
    ; slotOn)。前の音符がフルゲートで直前まで鳴っていた場合、単にbit4=1を書くだけでは
    ; エッジが起きず2音目以降が再アタックしない(compiler.js segmentsToWriteLogVrc7・
    ; ppmck本家vrc7.h vrc7_oto_set→vrc7_key_offと同じく、必ずキーオフを1回挟んでから
    ; キーオンを書く。2026-08-16、6502側だけこの修正が漏れていた=実機相当エミュで
    ; c4 d4 e4 のRMSが減衰し続けることを実測)。$9010のアドレスラッチは保持されるので
    ; 2回の$9030データ書込みの間で$9010を再選択する必要は無い
    LDA VRC7_SEL2,X
    STA $9010
    LDA ${hex(PERHI)}
    STA $9030
    ORA #$10
${needsLastHi ? `    STA ${hex(LASTHI)},X   ; VRC7ではLASTHI=直近の$20+ch書込値(キー状態シャドウ、WFO_VRC7参照)\n` : ''}    STA $9030
    LDA VRC7_SEL3,X
    STA $9010
    LDA ${hex(DUTY)},X
    ASL A
    ASL A
    ASL A
    ASL A
    ORA ${hex(VOL)},X
    STA $9030
    RTS
SIL_VRC7:
    LDA VRC7_SEL2,X
    STA $9010
    LDA #$00
${needsLastHi ? `    STA ${hex(LASTHI)},X   ; キーオフ(bit4=0)をシャドウにも反映\n` : ''}    STA $9030
    LDA VRC7_SEL3,X
    STA $9010
    LDA #$00
    STA $9030
    RTS`);
      if (usesEn) {
        // VRC7のEN<n>継続フレーム専用(fnum/blockのみ再計算・再書込み。音量/音色・
        // キーオンのトグルは行わない=既に鳴っている音符のフレーム継続のため、
        // $20+ch書込みは常にkeyonビット(0x10)を立てたまま送ってエッジを再発生させない
        // (src/mml/compiler.js segmentsToWriteLogVrc7のEN継続ループと同じ理由)。
        // VRC7は元々D/EP/MP/PT非対応(fnum/block対数空間)だったためWFO自体が
        // 無かったが、ENは対応可能なのでここで新設する。
        // ★2026-08-16修正: 休符/ゲートオフ中(SIL_VRC7が$20+ch=0でキーオフ済み)は
        // 何も書かない。RD_RESTはENACTを維持する設計(EP/MP/PTと同じ、RD_RESTのコメント
        // 参照)のためSERVICE_CHは休符中もここを呼び続けるが、旧実装は無条件に
        // keyonビット付きで$20+chを書いていたため、キーオフ直後のフレームで0→1エッジが
        // 再発生し休符中に再発音(音色0/音量0)し、しかも次の音符のWFV_VRC7が「既にキーオン中」
        // でエッジを起こせず再アタックしないという二重の実バグだった(JS参照実装との
        // 毎フレームレジスタ突き合わせで発覚)。キー状態はLASTHI,X(他チップでは
        // 「位相リセット副作用のある上位バイトの直近書込値」、VRC7では$20+chの直近書込値=
        // bit4がキー状態)で判定する。ppmck本家vrc7.hの vrc7_do_effect(rest_flagで全効果
        // スキップ)/sound_vrc7_write(vrc7_key_statをOR)と同じ設計・compiler.jsの
        // 「gateFrames以降はEN書込みをしない」と同じ結果になる。
        // usesEn ⇒ needsLastHi なのでLASTHIは必ず確保されている
        vrc7Handlers.push(`
WFO_VRC7:
    LDA ${hex(LASTHI)},X
    AND #$10
    BNE WFOVRC7_KEYED
    RTS
WFOVRC7_KEYED:
    LDA ${hex(NOTE)},X
    CLC
    ADC ${hex(ENVAL)},X
    BPL WFOVRC7_NONNEG
    LDA #$00
    JMP WFOVRC7_INDEX
WFOVRC7_NONNEG:
    CMP #${hex(TABLE_MAX)}
    BCC WFOVRC7_OK
    LDA #${hex(TABLE_MAX)}
WFOVRC7_OK:
WFOVRC7_INDEX:
    ASL A
    TAY
    LDA VRC7_TABLE,Y
    STA ${hex(PERLO)}
    LDA VRC7_TABLE+1,Y
    STA ${hex(PERHI)}
    LDA VRC7_SEL1,X
    STA $9010
    LDA ${hex(PERLO)}
    STA $9030
    LDA VRC7_SEL2,X
    STA $9010
    LDA ${hex(PERHI)}
    ORA #$10
    STA $9030
    RTS`);
      }
      // ジャンプテーブルは6チャンネル(TYPE 22-27)全てが同じ共用ルーチンを指す
      for (let ch = 0; ch < 6; ch++) {
        const t = TYPE_VRC7_BASE + ch;
        wfvEntries[t] = 'WFV_VRC7';
        silEntries[t] = 'SIL_VRC7';
        if (usesEn) wfoEntries[t] = 'WFO_VRC7';
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
      // 2026-08-16: 以前はサンプルごとにDPCM_TRIGGER_<i>ブロック(約48byte)を複製し
      // `CMP #idx / BEQ DPCM_TRIGGER_<i>`で分岐していたが、サンプルが3個以上ある曲で
      // BEQの分岐距離が±127byteを超えアセンブル失敗していた(悪魔城伝説1曲目で発覚)。
      // 分岐トランポリン化ではなく、サンプルごとの差分(レート表・モードビット・DAC・
      // アドレス・長さ)を全て,Y索引のテーブルに追い出した共用1本のルーチンに改める
      // (N163/VRC7/FME7ハンドラ共用化と同じ方針。サンプル数に依らずコードは固定長、
      // 分岐は全て短距離)。レート表(108byte)は基準freqが同じサンプル同士で共有する
      const rateTableSlotByFreq = new Map();
      const dpcmRateLabels = [];
      const dpcmIdxBytes = [], dpcmModeBytes = [], dpcmDacBytes = [], dpcmAddrBytes = [], dpcmLenBytes = [];
      dpcmIndices.forEach((idx) => {
        const layout = dpcmLayout[idx];
        const def = dpcmSamples[idx] || {};
        const freq = (def.freq || 0) & 0x0F;
        if (!rateTableSlotByFreq.has(freq)) {
          const rateTable = new Array(NOTE_TABLE_SIZE);
          for (let noteN = 0; noteN < NOTE_TABLE_SIZE; noteN++) {
            rateTable[noteN] = MML.Mml.dpcmRateIndexForNote(freq, noteN) & 0x0F;
          }
          const label = `DPCM_RATE_TABLE_F${freq}`;
          extraTables.push(`${label}:\n${bytesToDb(new Uint8Array(rateTable))}`);
          rateTableSlotByFreq.set(freq, label);
        }
        dpcmRateLabels.push(rateTableSlotByFreq.get(freq));
        dpcmIdxBytes.push(idx & 0xff);
        dpcmModeBytes.push(def.mode ? 0x40 : 0x00);
        // DAC=$FF(bit7)は「$4011を書かない」印(layout.dac===null、実機ppmck driverの
        // dpcm.h skipラベル相当)。有効値は0-127なのでBMIで判別できる
        dpcmDacBytes.push(layout.dac != null ? (layout.dac & 0x7F) : 0xFF);
        dpcmAddrBytes.push(layout.addrReg & 0xff);
        dpcmLenBytes.push(layout.lengthReg & 0xff);
      });
      extraTables.push(
        `DPCM_IDX_TBL:\n${bytesToDb(new Uint8Array(dpcmIdxBytes))}\n` +
        `DPCM_MODE_TBL:\n${bytesToDb(new Uint8Array(dpcmModeBytes))}\n` +
        `DPCM_DAC_TBL:\n${bytesToDb(new Uint8Array(dpcmDacBytes))}\n` +
        `DPCM_ADDR_TBL:\n${bytesToDb(new Uint8Array(dpcmAddrBytes))}\n` +
        `DPCM_LEN_TBL:\n${bytesToDb(new Uint8Array(dpcmLenBytes))}\n` +
        `DPCM_RATE_LO:\n    .byte ${dpcmRateLabels.map(l => `<${l}`).join(',')}\n` +
        `DPCM_RATE_HI:\n    .byte ${dpcmRateLabels.map(l => `>${l}`).join(',')}`);
      extraHandlers.push(`
; --- DPCM ($4010-4013、サンプル本体は固定バンク4-7=$C000-$FFFFに直接配置) ---
; DUTY,X(@<n>で選択した@DPCM<n>番号)をDPCM_IDX_TBLから逆引きしてスロットYを得て、
; 以降は全て,Yテーブル参照(サンプル数に依らずコード固定長)。X(チャンネル)は保存
WFV_T${TYPE_DPCM}:
    LDA ${hex(DUTY)},X
    LDY #${hex(dpcmIndices.length - 1)}
DPCM_FIND:
    CMP DPCM_IDX_TBL,Y
    BEQ DPCM_FOUND
    DEY
    BPL DPCM_FIND
    RTS     ; 対応するサンプルが無ければ何もしない(compiler.jsと同じ)
DPCM_FOUND:
    STY ${hex(PERLO2)}
    LDA DPCM_RATE_LO,Y
    STA ${hex(PTBLLO)}
    LDA DPCM_RATE_HI,Y
    STA ${hex(PTBLHI)}
    LDA ${hex(NOTE)},X
    CMP #${hex(TABLE_MAX)}
    BCC DPCM_OK
    LDA #${hex(TABLE_MAX)}
DPCM_OK:
    TAY
    LDA (${hex(PTBLLO)}),Y
    LDY ${hex(PERLO2)}
    ORA DPCM_MODE_TBL,Y
    STA ${hex(PERLO)}
    LDA #$0F
    STA $4015       ; DMC一旦停止(2A03他chは維持)
    LDA ${hex(PERLO)}
    STA $4010
    LDA DPCM_DAC_TBL,Y
    BMI DPCM_NODAC
    STA $4011
DPCM_NODAC:
    LDA DPCM_ADDR_TBL,Y
    STA $4012
    LDA DPCM_LEN_TBL,Y
    STA $4013
    LDA #$1F
    STA $4015       ; 再生開始
    RTS
SIL_T${TYPE_DPCM}:
    RTS             ; 休符/ゲートオフではDMCを止めない(サンプルは末尾まで鳴り切る)。
                    ; 実機ppmck(dpcm.h no_dpcm、DPCM_RESTSTOP無効の既定)およびcompiler.js
                    ; segmentsToWriteLogDpcmと同じ。以前はここで$4015=$0Fを書いており、
                    ; ブラウザ再生(休符で止めない)とNSFで食い違っていた(2026-08-16)`);
      wfvEntries[TYPE_DPCM] = `WFV_T${TYPE_DPCM}`;
      silEntries[TYPE_DPCM] = `SIL_T${TYPE_DPCM}`;
    }

    const fullSrc = `; ==========================================
; Sound Emulation Foundry - ppmck方式バイトコード再生ドライバ(バンク切り替え+拡張音源対応)
; チャンネル数: ${n} / 使用拡張音源: ${expansions.length ? expansions.join(',') : 'なし'}
; ==========================================
    .org $8000
    .res ${driverOrg - 0x8000}       ; 窓0(バンク0)〜ドライバ本体開始位置までのダミー(曲データ用に後で上書きされる)

    .org ${hex(driverOrg)}

INIT:
    LDA #$0F
    STA $4015       ; 2A03全チャンネル有効化
    LDA #$08
    STA $4001       ; スイープ無効(パルス1)。$00でなく$08(negate)にするのが定石:
    STA $4005       ; スイープ無効(パルス2)。$00だとスイープユニットの目標周期
                    ; (period+period>>0=2倍)が$7FFを超える周期$400以上の低音を実機/
                    ; エミュレータが常時ミュートしてしまう(compiler.jsのsweepRegisterByteと
                    ; 同じ0x08。Batman Prototype 1曲目のPulse2ベースが無音になった原因)
${initExtra.join('\n')}

    LDX #$00
INIT_LOOP:
    LDA SONG_ADDR_LO,X
    STA ${hex(PTRLO)},X    ; このチャンネルの開始アドレス下位(ROM圧縮対応、通常は$8000開始だが
                            ; 直前チャンネルの続きに詰めて配置された場合はバンク途中から始まる)
    LDA SONG_ADDR_HI,X
    STA ${hex(PTRHI)},X    ; 開始アドレス上位
    LDA SONG_BANK,X
    STA ${hex(BANK)},X     ; このチャンネルの開始バンク番号
    LDA CH_TYPE_TABLE,X
    STA ${hex(CHTYPE)},X   ; このチャンネルの種別
    LDA #$01
    STA ${hex(CNT)},X      ; CNT=1 -> 最初のPLAYで即データ読み込み
    STA ${hex(NOTELEN)},X  ; sticky音長の安全な初期値(シリアライザは最初の音符/休符を
    STA ${hex(RESTLEN)},X  ; 必ず明示形式で出すため実際には参照前に上書きされる)
    LDA #$00
    STA ${hex(VOL)},X      ; VOL=0
    STA ${hex(DUTY)},X     ; DUTY=0
${envTableCount > 0 ? `    STA ${hex(ENVACT)},X   ; ENVACT=0(ソフトウェア音量エンベロープ無効)` : ''}
${usesFme7 ? `    STA ${hex(FMEEACT)},X  ; FMEEACT=0(FME7ハードウェアエンベロープ無効)` : ''}
    LDA #$FF
    STA ${hex(LASTINS)},X  ; LASTINS=$FF(番兵。有効な音色番号0-127とは重複しない)
${envTableCount > 0 ? `    STA ${hex(ENVSEL)},X   ; ENVSEL=$FF(@v<n>未選択の番兵、2026-08-14)` : ''}
    LDA #$00
${usesDetune ? `    STA ${hex(DETUNE_LO)},X ; DETUNE=0(D<n>未指定時の既定値)
    STA ${hex(DETUNE_HI)},X` : ''}
${usesSweep ? `    LDA #$08
    STA ${hex(SWEEPREG)},X ; スイープOFF($08=negateのみ。上のINITが$4001/$4005へ書く値と同じ)
    LDA #$00` : ''}
${usesEp ? `    STA ${hex(EPACT)},X    ; EPACT=0(EP<n>未指定時の既定値)
    STA ${hex(EPVALLO)},X  ; ★EPVALLO/HIも0初期化(実機RAMの電源投入時の値は不定なため。
    STA ${hex(EPVALHI)},X  ;  下記RD_PITCHENV/RD_REST側の教訓と同じ理由、2026-08-11)` : ''}
${usesMp ? `    STA ${hex(MPACT)},X    ; MPACT=0(MP<n>未指定時の既定値)
    STA ${hex(MPVALLO)},X  ; ★MPVALLO/HIも0初期化(同上)
    STA ${hex(MPVALHI)},X` : ''}
${usesPortamento ? `    STA ${hex(PTACT)},X    ; PTACT=0(PT<n>未指定時の既定値)
    STA ${hex(PTVALLO)},X  ; ★PTVALLO/HIも0初期化(同上)
    STA ${hex(PTVALHI)},X` : ''}
${usesEn ? `    STA ${hex(ENACT)},X    ; ENACT=0(EN<n>未指定時の既定値、2026-08-16追加。同上の理由)
    STA ${hex(ENVAL)},X    ; ★ENVALも0初期化(LOOKUP_*_PERIOD/WFV_*がNOTEへ無条件加算するため)` : ''}
${needsLastHi ? `    STA ${hex(LASTHI)},X   ; LASTHI=0(VRC7ではキー状態シャドウを兼ねる、WFO_VRC7参照。同上の理由)` : ''}
${usesSmooth ? `    STA ${hex(SMOOTHACT)},X  ; SMOOTHACT=0(SM未指定時の既定値、SMOF相当)` : ''}
${usesPitchSa ? `    STA ${hex(SAAMT)},X    ; SAAMT=0(SA未指定時の既定値=シフト無し)` : ''}
${usesVolSkip ? `    LDA #$FF
    STA ${hex(LASTVOL)},X  ; LASTVOL=$FF(無効。初回は必ず書く)
    LDA #$00` : ''}
${usesPitchShift ? `    STA ${hex(PSACT)},X     ; PSACT=0(PS未使用時の既定値)
    STA ${hex(PSVALLO)},X  ; ★PSVALLO/HIも0初期化(同上)
    STA ${hex(PSVALHI)},X` : ''}
${usesVr ? `    STA ${hex(RELPLAY)},X  ; RELPLAY=0(まだリリース再生中ではない)
    LDA #$FF
    STA ${hex(VRSEL)},X    ; VRSEL=$FF(@vr<n>未指定時の既定値、未選択の番兵)
    LDA #$00` : ''}
${usesToneState ? `    LDA #$FF
    STA ${hex(RELTONE)},X  ; RELTONE=$FF(@@r<n>未指定=リリース音色OFFの番兵)
${usesDutyEnv ? `    STA ${hex(DUTYSEL)},X  ; DUTYSEL=$FF(@@<n>未選択=固定音色の番兵)` : ''}
    LDA #$80
    STA ${hex(TONEBASE)},X ; TONEBASE=$80(固定音色0。OP_TONEが来るまでの既定値)
    LDA #$00` : ''}
    INX
    CPX #${hex(n)}
    BEQ INIT_DONE
    JMP INIT_LOOP     ; ★BNE INIT_LOOPだと機能全部盛りの曲(EN/EP/MP/PT/PS/SM/@vr/@@…同時使用)で
                      ; ループ本体が128byteを超え「分岐範囲外」でアセンブル失敗する(2026-08-16、
                      ; sampleMml.js相当のMMLで実測offset=-143)。+2byteでJMP経由にして恒久回避
INIT_DONE:
    RTS

PLAY:
${playLines.join('\n')}
    RTS

; --- チャンネルX(0-N-1)を1フレーム分処理する ---
; 音符継続中(カウンタがまだ尽きていない)は、継続効果のtick(TICK_VOL_FX=音量+デューティ側、
; TICK_PITCH_FX=周期側)だけを進める。カウンタが尽きたフレーム(READ_DATA経由で次のデータを
; 読む「読取りフレーム」)では、通常の音符(RD_NOTE_BODY)は全効果を再初期化するので継続tickは
; 不要だが、キーオン無しでデータを読み進めるだけのオペコード(RD_PITCHSHIFT/RD_PITCHBREAK/
; RD_WAIT/RD_REST/RD_GATEOFFVR/RD_GATEOFFVRSD)は自分で同じtickを1回肩代わりする(そうしないと
; compiler.js側の連続したtickと1フレームずれる。★2026-08-16: 以前はRD_PITCHBREAKだけが
; 周期側を肩代わりし、音量側(@v)は誰も肩代わりしていなかったため、タイ境界のフレームだけ
; @vが1フレーム足踏みしていた) ---
SERVICE_CH:
    DEC ${hex(CNT)},X
    BEQ SERVICE_CH_READ
${usesVolOnly ? '    JSR TICK_VOL_FX' : ''}
${usesFreqOnly ? `    JSR TICK_PITCH_FX
    BEQ SERVICE_CH_END
    JSR WRITE_FREQ_ONLY` : ''}
SERVICE_CH_END:
    RTS
SERVICE_CH_READ:
    JMP READ_DATA
${usesVolOnly ? `
; --- 音量側の継続効果(duty tick + @v tick + @vr tick)を1フレームぶん進める(X=チャンネル
; 番号)。@@<n>(デューティ=音色エンベロープ)が選択中ならまずtickを進めてDUTY,Xを更新する
; (デューティは音量と同じレジスタに同居しているので、直後の@v/@vr側がWRITE_VOL_ONLYを
; 呼ぶならそちらがまとめて反映する。どちらも動いていない(v<n>固定音量)ときだけ、
; ここで自分で書き込む)。次にソフトウェア音量エンベロープ(@v、ENVACT)が有効ならtickを
; 進めて音量レジスタ"のみ"書き直す(周期/コントロールレジスタは書き直さない。
; WRITE_VOL_ONLYのコメント参照)。@vr(リリースエンベロープ)再生中(RELPLAY)も同様
; (ENVACTはRD_RESTで既に0クリア済みなので通常は同一フレームで両方発火することは無い。
; PS音符の直前で@vが再選択された場合だけ両方立ちうるが、その場合は後に書くリリース側が勝つ) ---
TICK_VOL_FX:
${usesDutyEnv ? `    LDA ${hex(DUTYSEL)},X
    CMP #$FF
    BEQ TVF_NODUTY
    INC ${hex(DUTYTICK)},X
    JSR DUTY_LOOKUP
    LDA #$00
${envTableCount > 0 ? `    ORA ${hex(ENVACT)},X` : ''}
${usesVr ? `    ORA ${hex(RELPLAY)},X` : ''}
    BNE TVF_NODUTY
${usesVolSkip ? `    LDA #$FF
    STA ${hex(LASTVOL)},X  ; ここは無条件で書くので音量シャドウを無効化しておく
                           ; (更新せずに書くとシャドウが古いまま残り、次の@v/@vr継続
                           ;  フレームで「同値だから書かない」と誤判定する)
` : ''}    JSR WRITE_VOL_ONLY
TVF_NODUTY:` : ''}
${envTableCount > 0 ? `    LDA ${hex(ENVACT)},X
    BEQ TVF_NOENV
    INC ${hex(ENVTICK)},X
    JSR ENV_LOOKUP
    ; ★前フレームと同じ音量なら書込みごと省く(2026-08-26)。音量レジスタへの同値の
    ; 再書込みはどのチップでも副作用が無い(2A03/MMC5のエンベロープディバイダのリロードは
    ; $4003/$4007側、FDSは常にbit7=1の直接ゲインモード、N163/FME7/VRC6/VRC7は単純代入)
    ; ため、丸ごと飛ばしてよい。WRITE_VOL_ONLYはジャンプテーブル分岐+チップ別ハンドラで
    ; 60サイクル前後かかるのに対し、この判定は19サイクルで済む(実測で音量書込みの
    ; 55〜99%が同値。特にN163の平坦ホールドは94〜99%)。
    ; ★デューティエンベロープ(@@<n>)選択中は除外する: dutyは音量と同じバイトに同居して
    ; おり(WFV_VOL_T0参照)、上のTVF_NODUTY側は「@v/@vrが動いていればそちらが書く」前提で
    ; 自分では書かない。音量が同値でもdutyだけ変わったフレームを握り潰さないよう、
    ; @@が動いている間は無条件で書く。
    LDA ${hex(VOL)},X
${usesDutyEnv ? `    LDY ${hex(DUTYSEL)},X
    INY                    ; DUTYSEL=$FF(未選択)なら0になりZセット
    BNE TVF_ENVWRITE       ; @@動作中は無条件で書く
` : ''}    CMP ${hex(LASTVOL)},X
    BEQ TVF_NOENV
TVF_ENVWRITE:
    STA ${hex(LASTVOL)},X
    JSR WRITE_VOL_ONLY
TVF_NOENV:` : ''}
${usesVr ? `    LDA ${hex(RELPLAY)},X
    BEQ TVF_NOREL
    INC ${hex(RELTICK)},X
    JSR REL_LOOKUP
    ; @v側と同じ「同値なら書込みごと省く」判定(上のコメント参照)
    LDA ${hex(VOL)},X
${usesDutyEnv ? `    LDY ${hex(DUTYSEL)},X
    INY
    BNE TVF_RELWRITE
` : ''}    CMP ${hex(LASTVOL)},X
    BEQ TVF_NOREL
TVF_RELWRITE:
    STA ${hex(LASTVOL)},X
    JSR WRITE_VOL_ONLY
TVF_NOREL:` : ''}
    RTS` : ''}
${usesFreqOnly ? `
; --- 周期側の継続効果(EP/MP/PT/PS/EN)を1フレームぶん進める(X=チャンネル番号)。
; 周期/周波数レジスタ自体は書かず、A=「いずれかの効果が有効(=呼び出し側がWRITE_FREQ_ONLYを
; 呼ぶべき)なら非0」(Zフラグもそれに応じてセット)で返す。@vとD/EP/MPは音量側/周波数側で
; 完全に独立したパスなので、それぞれ個別に判定する ---
TICK_PITCH_FX:
${usesEp ? `    ; EP<n>: delayの消化・テーブル参照はEP_STEP内で行う(RD_NOTEと共通のルーチン、
    ; 2026-08-11 別プロジェクトA)
    LDA ${hex(EPACT)},X
    BEQ TPF_NOEP
    JSR EP_STEP
TPF_NOEP:` : ''}
${usesMp ? `    LDA ${hex(MPACT)},X
    BEQ TPF_NOMP
    JSR LFO_SUB
TPF_NOMP:` : ''}
${usesPortamento ? `    ; PT<n>: delayの消化・ステップ加算はPT_STEP内で行う(2026-08-11 別プロジェクトC)
    LDA ${hex(PTACT)},X
    BEQ TPF_NOPT
    JSR PT_STEP
TPF_NOPT:` : ''}
${usesPitchShift ? `    ; PS(ポルタメント、実機準拠、2026-08-13)。
    ; ★PS_STEPは目標(オフセット0)に到達すると自らPSACTを0クリアするため、
    ; WRITE_FREQ_ONLYを呼ぶかどうかの判定にPS_STEP呼び出し後のPSACTを使うと、
    ; ちょうど目標に到達した最後のフレームだけ書き込みが漏れる(クランプした値が
    ; レジスタへ反映されないまま次のフレームまでレジスタが古い値を保持し続ける)
    ; バグになる。呼ぶ前の値を${hex(CDA)}(チャンネル非依存の使い捨てスクラッチ、
    ; 通常はRD_PORTAMENTO/RD_PITCHENVのCEILDIV専用だがこのルーチン実行中には未使用)
    ; へ退避しておき、判定にはそちらを使う。★PERLO2はこの直後のEN_STEP(2026-08-14
    ; 追加)がテーブル長比較の一時スクラッチとして使うため、ここでは使えない
    ; (使うとEN_STEP実行後にPS_STEP呼び出し前のPSACT値が失われる)
    LDA ${hex(PSACT)},X
    STA ${hex(CDA)}
    BEQ TPF_NOPS
    JSR PS_STEP
TPF_NOPS:` : ''}
${usesEn ? `    ; EN<n>: テーブル探索・累積加算・ループ処理はEN_STEP内で行う(RD_NOTEと共通)
    LDA ${hex(ENACT)},X
    BEQ TPF_NOEN
    JSR EN_STEP
TPF_NOEN:` : ''}
    LDA #$00
${usesEp ? `    ORA ${hex(EPACT)},X` : ''}
${usesMp ? `    ORA ${hex(MPACT)},X` : ''}
${usesPortamento ? `    ORA ${hex(PTACT)},X` : ''}
${usesPitchShift ? `    ORA ${hex(CDA)}` : ''}
${usesEn ? `    ORA ${hex(ENACT)},X` : ''}
    RTS` : ''}

; --- A=[CURPTR]を読み、CURPTRを1進める ---
READ_BYTE:
    LDY #$00
    LDA (${hex(CURLO)}),Y
; INC(メモリ)はAを変更しないため、読んだ値の退避(旧実装のPHA/PLA、7サイクル)は不要
; (2026-08-16 最適化。全呼び出し元が直後にCMP/AND(フラグ再設定)かSTA/PHA(フラグ非依存)で
; あることを監査済み=INCが残すフラグに依存する呼び出し元は無い)
    INC ${hex(CURLO)}
    BNE RB_DONE
    INC ${hex(CURHI)}
RB_DONE:
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
; ノート早期判定(2026-08-16 最適化): ノートバイトは0x00-0xE2、コマンドは0xE3-0xFFと
; 完全分離済み(mckBytecode.jsのNOTE_MAX=0xE2はこの境界を保証するためのクランプ。
; 2026-08-20にOP_SWEEP=0xE3を追加した際、境界を0xE7から0xE3へ下げた。0xE4-0xE6は
; 引き続き未使用でここをすり抜けるが、末尾のJMP RD_NOTEへ落ちるだけで従来と同じ)。
; 最頻のノートを2命令で即ディスパッチする(以前は下のCMP/BEQ連鎖を全てすり抜けてから
; 末尾のJMP RD_NOTEに到達しており、機能の多い曲では1ノートあたり約80サイクル掛かっていた)
    CMP #$E3
    BCS RD_ISCMD
    JMP RD_NOTE
RD_ISCMD:
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
${usesEn ? '    CMP #$F7\n    BEQ RD_JMP_NOTEENV' : '    CMP #$F7\n    BEQ RD_JMP_SKIP1'}
${usesEp ? '    CMP #$F8\n    BEQ RD_JMP_PITCHENV' : '    CMP #$F8\n    BEQ RD_JMP_SKIP2'}
${usesMp ? '    CMP #$FB\n    BEQ RD_JMP_VIBRATO' : '    CMP #$FB\n    BEQ RD_JMP_SKIP1'}
${usesPortamento ? '    CMP #$F9\n    BEQ RD_JMP_PORTAMENTO' : '    CMP #$F9\n    BEQ RD_JMP_SKIP4'}
${usesDetune ? '    CMP #$FA\n    BEQ RD_JMP_DETUNE' : '    CMP #$FA\n    BEQ RD_JMP_SKIP2'}
${envTableCount > 0 ? '    CMP #$F3\n    BEQ RD_JMP_VOLENV' : ''}
${usesFme7 ? '    CMP #$F1\n    BEQ RD_JMP_FME7NOISE\n    CMP #$F2\n    BEQ RD_JMP_FME7HENV' : ''}
${vrc7CustomTones.length > 0 ? '    CMP #$F0\n    BEQ RD_JMP_VRC7TONE' : ''}
${usesFds ? '    CMP #$F5\n    BEQ RD_JMP_FDSMOD' : ''}
${usesN163CustomWaves ? '    CMP #$F6\n    BEQ RD_JMP_N163RELOC' : ''}
${usesRawWrite ? '    CMP #$EB\n    BEQ RD_JMP_RAWWRITE' : ''}
${usesSmooth ? '    CMP #$EA\n    BEQ RD_JMP_SMOOTH' : ''}
${usesPitchShift ? '    CMP #$E9\n    BEQ RD_JMP_PITCHSHIFT' : ''}
${usesVr ? '    CMP #$EF\n    BEQ RD_JMP_VRENV' : ''}
${usesGateOffVr ? '    CMP #$EC\n    BEQ RD_JMP_GATEOFFVR\n    CMP #$E8\n    BEQ RD_JMP_GATEOFFVRSD' : ''}
${usesToneState ? '    CMP #$E7\n    BEQ RD_JMP_RELTONE' : ''}
${usesSweep ? '    CMP #$E3\n    BEQ RD_JMP_SWEEP' : ''}
${usesPitchSa ? '    CMP #$E4\n    BEQ RD_JMP_PITCHSA' : ''}
    JMP RD_NOTE

; ★トランポリンの並びは必ず上のCMP/BEQ連鎖と同じ順序に保つこと(2026-08-20)。
; 各BEQからその行き先までの距離は「自分より後ろのCMP連鎖の長さ + 自分より前の
; トランポリンの長さ」で決まるため、同順なら全機能を使う曲でも±95バイト程度に収まり
; 6502の分岐範囲(±127)に余裕で入る。以前は連鎖の早い方でテストされるVOL/TONEの
; トランポリンが並びの後ろ半分に置かれており、機能全部盛りの曲(sampleMml.js相当)で
; offset=126=上限まで1バイトという綱渡り状態だった(OP_SWEEP追加で実際に溢れた)
RD_JMP_ENDTRACK:
    JMP RD_ENDTRACK
RD_JMP_BANKJUMP:
    JMP RD_BANKJUMP
${usesPitchBreak ? 'RD_JMP_PITCHBREAK:\n    JMP RD_PITCHBREAK' : ''}
RD_JMP_VOL:
    JMP RD_VOL
RD_JMP_TONE:
    JMP RD_TONE
RD_JMP_REST:
    JMP RD_REST
RD_JMP_WAIT:
    JMP RD_WAIT
${usesEn ? 'RD_JMP_NOTEENV:\n    JMP RD_NOTEENV' : ''}
${usesEp ? 'RD_JMP_PITCHENV:\n    JMP RD_PITCHENV' : ''}
${usesMp ? 'RD_JMP_VIBRATO:\n    JMP RD_VIBRATO' : ''}
${usesPortamento ? 'RD_JMP_PORTAMENTO:\n    JMP RD_PORTAMENTO' : ''}
${usesDetune ? 'RD_JMP_DETUNE:\n    JMP RD_DETUNE' : ''}
${(!usesEn || !usesMp) ? 'RD_JMP_SKIP1:\n    JMP RD_SKIP1' : ''}
${(!usesDetune || !usesEp) ? 'RD_JMP_SKIP2:\n    JMP RD_SKIP2' : ''}
${!usesPortamento ? 'RD_JMP_SKIP4:\n    JMP RD_SKIP4' : ''}
${envTableCount > 0 ? 'RD_JMP_VOLENV:\n    JMP RD_VOLENV' : ''}
${usesFme7 ? 'RD_JMP_FME7NOISE:\n    JMP RD_FME7NOISE\nRD_JMP_FME7HENV:\n    JMP RD_FME7HENV' : ''}
${vrc7CustomTones.length > 0 ? 'RD_JMP_VRC7TONE:\n    JMP RD_VRC7TONE' : ''}
${usesFds ? 'RD_JMP_FDSMOD:\n    JMP RD_FDSMOD' : ''}
${usesN163CustomWaves ? 'RD_JMP_N163RELOC:\n    JMP RD_N163RELOC' : ''}
${usesRawWrite ? 'RD_JMP_RAWWRITE:\n    JMP RD_RAWWRITE' : ''}
${usesSmooth ? 'RD_JMP_SMOOTH:\n    JMP RD_SMOOTH' : ''}
${usesPitchShift ? 'RD_JMP_PITCHSHIFT:\n    JMP RD_PITCHSHIFT' : ''}
${usesVr ? 'RD_JMP_VRENV:\n    JMP RD_VRENV' : ''}
${usesGateOffVr ? 'RD_JMP_GATEOFFVR:\n    JMP RD_GATEOFFVR\nRD_JMP_GATEOFFVRSD:\n    JMP RD_GATEOFFVRSD' : ''}
${usesToneState ? 'RD_JMP_RELTONE:\n    JMP RD_RELTONE' : ''}
${usesSweep ? 'RD_JMP_SWEEP:\n    JMP RD_SWEEP' : ''}
${usesPitchSa ? 'RD_JMP_PITCHSA:\n    JMP RD_PITCHSA' : ''}

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

RD_SKIP2:
    JSR READ_BYTE
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
    AND #$3F        ; FDS/VRC6サウは6bit音量(0-63)。他chはコンパイラ側で0-15保証済み
    STA ${hex(VOL)},X
${usesVr ? `    STA ${hex(VOLBASE)},X   ; リリース再生でVOL,Xが潰れるため素の音量を控えておく` : ''}
${envTableCount > 0 ? `    LDA #$00
    STA ${hex(ENVACT)},X   ; 明示的な音量指定はソフトウェアエンベロープを解除する
    LDA #$FF
    STA ${hex(ENVSEL)},X   ; ★2026-08-14修正: ENVSELも$FF(未選択)へ戻す。ENVACTだけを
                            ; クリアしていた旧実装は、次にRD_NOTE_BODYが来た時「選択済みか」を
                            ; ENVACTで判定していたため、v<n>で明示解除した後の音符でも
                            ; ENVSELが古い値のまま残っていると再度誤って有効化されうる
                            ; バグの芽があった(下記RD_NOTE_BODY修正と対) ` : ''}
${usesFme7 ? `    LDA #$00\n    STA ${hex(FMEEACT)},X  ; 同じくFME7ハードウェアエンベロープも解除する` : ''}
    JMP RD_LOOP
${envTableCount > 0 ? `
RD_VOLENV:
    JSR READ_BYTE
    STA ${hex(ENVSEL)},X
    LDA #$01
    STA ${hex(ENVACT)},X
    ; ENVTICKは$FF(=tick0の1つ手前)で初期化する(2026-08-16)。通常の音符ではRD_NOTE_BODYが
    ; 改めて0にしてtick0の値を書くので無関係だが、直後がPS音符(RD_PITCHSHIFT=キーオン
    ; 無し)の場合はTICK_VOL_FXのINCでちょうど0になり、compiler.jsの「@vの選択が変わった
    ; PS音符はその先頭からtick0で再スタート」と一致する(0で初期化すると先頭がtick1に
    ; なってしまう)。RD_VOLENVは必ず同じ読取り内で音長を伴うオペコードに続くので、
    ; $FFのままSERVICE_CHのINCに達することは無い
    LDA #$FF
    STA ${hex(ENVTICK)},X
${usesFme7 ? `    LDA #$00
    STA ${hex(FMEEACT)},X  ; @v<n>とFME7ハードウェアエンベロープは排他` : ''}
    JMP RD_LOOP` : ''}

${usesToneState ? `RD_TONE:
    ; 音色バイトはbit7で「固定音色(1)」と「デューティエンベロープ番号(0)」を区別する
    ; (実機ppmck internal.h duty_set と同じ)。TONEBASEへ控えておき、@@r<n>で
    ; リリース音色へ差し替えられた後の音符で自分の音色へ戻せるようにする
    JSR READ_BYTE
    STA ${hex(TONEBASE)},X
    JSR APPLY_TONE
    JMP RD_LOOP

; --- @@r<n>(リリース音色、0xE7): 直後1バイトが音色バイト($FF=OFF) ---
RD_RELTONE:
    JSR READ_BYTE
    STA ${hex(RELTONE)},X
    JMP RD_LOOP` : `RD_TONE:
    JSR READ_BYTE
    AND #$7F       ; OP_TONEバイトコードの0-127全域を保持(以前は#$0Fで4bitに切り詰めていた
                    ; バグ。ASL A連鎖で使うVRC7パッチ選択等は256の剰余により結果不変なので
                    ; マスク幅を広げても既存チップの挙動には影響しない)
    STA ${hex(DUTY)},X
    JMP RD_LOOP`}
${usesN163CustomWaves ? `
; --- N163共有バッファアロケータ(0xF6): 直後1バイトがこのchの波形バイトオフセット。
; 波形の中身自体はこの後に続くOP_TONE(音色番号)の変化検知(N163_TONE_CHECK)で選ばれる ---
RD_N163RELOC:
    JSR READ_BYTE
    STA ${hex(WAVEOFS)},X
    JMP RD_LOOP` : ''}

${usesDetune ? `
; --- D<n>デチューン(0xFA): 直後2バイトが符号付き16bit値(下位,上位)。次の音符から
; APPLY_DETUNE/APPLY_DETUNE_N163が使う。値そのものを覚えるだけで周期計算はしない ---
RD_DETUNE:
    JSR READ_BYTE
    STA ${hex(DETUNE_LO)},X
    JSR READ_BYTE
    STA ${hex(DETUNE_HI)},X
    JMP RD_LOOP` : ''}
${usesSweep ? `
; --- s<speed>,<depth>(ハードウェアスイープ、0xE3、2026-08-20、対応AB=2A03パルスのみ):
; 直後1バイトが$4001/$4005へ書く生バイト(mckBytecode.jsのOP_SWEEP、値はcompiler.jsの
; sweepRegisterByteが計算済み)。ここでは保持するだけで、実際のレジスタ書き込みは
; 音符アタック(WFV_T0/T1)が毎回行う。実機のスイープユニットは$4003/$4007書込みでは
; リロードされない(=音符ごとに$4001/$4005を書き直さないと2音目以降スイープが
; 掛からない)ため、ブラウザ再生(compiler.jsがセグメント先頭で毎回書く)と同じ挙動にする ---
RD_SWEEP:
    JSR READ_BYTE
    STA ${hex(SWEEPREG)},X
    JMP RD_LOOP` : ''}
${usesPitchSa ? `
; --- SA<num>(N163ピッチシフト量、0xE4、2026-08-26、本家pitch_shift_amount相当):
; 直後1バイトがシフト量(0-8)。保持するだけで、実際の適用はAPPLY_DETUNE_N163の
; SA_ADD16(D/EP/MPの16bit値を左シフトしながら18bit周波数へ加算)が毎回行う ---
RD_PITCHSA:
    JSR READ_BYTE
    STA ${hex(SAAMT)},X
    JMP RD_LOOP` : ''}
${usesRawWrite ? `
; --- y<adr>,<num>(0xEB、2026-08-13): 直後3バイトが[アドレス下位,アドレス上位,値]。
; 指定アドレスへ生バイトを1回だけ書き込む(チップ非依存)。(${hex(PERLO)}),Yの間接
; アドレッシングを使うため、値は一旦スタックへ退避してから書く(Xはチャンネル番号のまま
; 破壊しないよう、${hex(PERLO)}/${hex(PERHI)}を一時ポインタとして使い捨てる) ---
RD_RAWWRITE:
    JSR READ_BYTE
    STA ${hex(PERLO)}
    JSR READ_BYTE
    STA ${hex(PERHI)}
    JSR READ_BYTE
    PHA
    LDY #$00
    PLA
    STA (${hex(PERLO)}),Y
    JMP RD_LOOP` : ''}
${usesSmooth ? `
; --- SM/SMOF(0xEA、2026-08-13、対応ABC): 直後1バイトが0(SMOF)/1(SM)。
; 実際の書込み省略判定はWFV_T0/T1/T2(音符アタック時)が${hex(SMOOTHACT)},Xを見て行う ---
RD_SMOOTH:
    JSR READ_BYTE
    STA ${hex(SMOOTHACT)},X
    JMP RD_LOOP` : ''}
${usesVr ? `
; --- @vr<n>(0xEF、2026-08-13): 直後1バイトがROM上のコンパクトなテーブル番号。
; VRSELを更新するだけ(実機同様v<n>等でも解除されない、次にゲートオフした時に
; RD_RESTがこの値を見てリリースエンベロープへ入るかどうかを判定する) ---
RD_VRENV:
    JSR READ_BYTE
    STA ${hex(VRSEL)},X
    JMP RD_LOOP` : ''}
${usesEn ? `
; --- EN<n>ノートエンベロープ選択(0xF7): 直後1バイトが[ROM上のコンパクトなテーブル
; 番号($FF=ENOF、解除)]。MP<n>と同じくdelay概念が無い1バイト固定長。実際の値の反映
; (ENTICK/ENVALリセット+EN_STEP初回呼び出し)はRD_NOTE(音符アタック時)で行う。
; ここではENACT/ENSELを更新するだけ(@v<n>のRD_VOLENVと同じ設計) ---
RD_NOTEENV:
    JSR READ_BYTE
    CMP #$FF
    BNE RD_NOTEENV_ON
    LDA #$00
    STA ${hex(ENACT)},X
    STA ${hex(ENVAL)},X  ; ★ENOFで累積値も0に戻す(RD_PITCHENVと同じ教訓、2026-08-14)
    JMP RD_LOOP
RD_NOTEENV_ON:
    STA ${hex(ENSEL)},X
    LDA #$01
    STA ${hex(ENACT)},X
    ; 選択時点でtick/累積値も再初期化する(2026-08-16)。通常の音符ではRD_NOTE_BODYが
    ; どのみち再初期化するので無関係だが、直後がPS音符(キーオン無し、RD_PITCHSHIFT)の
    ; 場合に「選択が変わった効果はPS音符の先頭からtick0で再スタート」(compiler.jsの
    ; psGlideFxOffsets)と一致させるため。RD_PITCHENV/RD_VIBRATO/RD_PORTAMENTOも同様
    LDA #$00
    STA ${hex(ENTICK)},X
    STA ${hex(ENVAL)},X
    JMP RD_LOOP` : ''}
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
    STA ${hex(EPDELAY)},X   ; 選択時点でdelay/tickも再初期化(2026-08-16、RD_NOTEENV_ONのコメント参照)
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
    JMP RDV_DONE
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
RDV_DONE:
    ; 選択時点でLFO状態(delay/quarter/累積値)も再初期化する(2026-08-16、RD_NOTEENV_ONの
    ; コメント参照。通常の音符ではRD_NOTE_BODYが改めて同じMP_INITを呼ぶ)
    JSR MP_INIT
    JMP RD_LOOP

; --- MP<n>のLFO状態を音符先頭の初期状態にする(実機effect_init相当。X=チャンネル番号、
; MPSEL/MPSTEPINTは設定済み前提)。呼び出し側がこの後LFO_SUBを1回呼んで1フレーム目
; (delay=0なら即座に動き出す)の値まで進める ---
MP_INIT:
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
    RTS` : ''}
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
    JMP RDP_DONE
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
RDP_DONE:
    ; 選択時点でPT状態も再初期化する(2026-08-16、RD_NOTEENV_ONのコメント参照。
    ; 通常の音符ではRD_NOTE_BODYが改めて同じPT_INITを呼ぶ)
    JSR PT_INIT
    JMP RD_LOOP

; --- PT<n>の状態(delay/duration/stepcnt/累積値)を音符先頭の初期状態にする(X=チャンネル
; 番号、PTDELAYSET/PTDURSET/PTSTEPINTは設定済み前提)。呼び出し側がこの後PT_STEPを
; 1回呼ぶ(EP_STEPと同じpost-increment単一ルーチン設計) ---
PT_INIT:
    LDA ${hex(PTDELAYSET)},X
    STA ${hex(PTDELAY)},X
    LDA ${hex(PTDURSET)},X
    STA ${hex(PTDUR)},X
    LDA ${hex(PTSTEPINT)},X
    STA ${hex(PTSTEPCNT)},X
    LDA #$00
    STA ${hex(PTVALLO)},X
    STA ${hex(PTVALHI)},X
    RTS` : ''}

; OP_REST_SAME($E2、sticky音長): 直前の休符と同じ長さ。RESTLEN,Xから読み戻すだけで
; 音長バイトを持たない(RD_NOTE先頭の判定から飛んで来る)
RD_REST_SAME:
    LDA ${hex(RESTLEN)},X
    JMP RD_REST_GO
RD_REST:
    JSR READ_BYTE
    STA ${hex(RESTLEN)},X  ; sticky音長を更新(OP_REST_SAMEが再利用する)
RD_REST_GO:
    STA ${hex(CNT)},X
${usesFreqOnly ? `    ; 読取りフレームぶんの周期側継続効果tick(SERVICE_CH冒頭コメント参照。休符中も
    ; EP/MP/PT/ENは進み続けるので、この1フレームだけ止まらないようにする)。
    ; SILENCE_CH(キーオフ)より前に行い、キーオン状態を伴う周波数書込みを持つチップ
    ; でもキーオフが必ず後勝ちするようにする
    JSR TICK_PITCH_FX
    BEQ RR_NOFREQ
    JSR WRITE_FREQ_ONLY
RR_NOFREQ:` : ''}
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
    ; いるため無音のまま。★例外はVRC7: 周波数上位レジスタ$20+chにキーオンビットが同居する
    ; ため「音量0で無音のまま」が成り立たず、キーオフ直後の再書込みで0→1エッジ=再発音に
    ; なる。EN<n>用のWFO_VRC7側でLASTHI,X(=直近の$20+ch書込値)のキー状態を見て休符中は
    ; 何も書かないことで対処済み(2026-08-16、ENACTはここでは同じくクリアしない))
${usesVr ? `    ; ★独立したr休符(0xFC)は常に無音(@vrを一切見ない。compiler.jsのwriteVolumeEnvelopeも
    ; 「vTableが有効な音符自身がゲートオフした時だけ」vrTableへ切り替える設計で、
    ; 独立したr休符はこの対象外=常にプレーンな無音のため、6502側も合わせる。
    ; 音符内部のゲートオフは別オペコード0xEC=RD_GATEOFFVRが担当する、下記参照)
    LDA #$00
    STA ${hex(RELPLAY)},X` : ''}
${usesDutyEnv ? `    ; 無音区間ではデューティエンベロープも止める(進め続けると毎フレーム
    ; WRITE_VOL_ONLYで音量を書き戻してしまい、無音化した音がまた鳴り出す)。
    ; 次の音符のRD_NOTE_BODYがTONEBASEから必ず選び直すので状態は失われない
    LDA #$FF
    STA ${hex(DUTYSEL)},X` : ''}
    JSR SILENCE_CH
    JMP RD_RETURN
${usesGateOffVr ? `
; --- 音符内部のゲートオフ(0xEC、q<n>による打ち切り、2026-08-13): 直後1バイトが
; フレーム数(素のOP_REST=0xFCと同じ形式)。VRSEL(@vr<n>選択中)が有効なら無音化せず
; リリーステーブルの再生へ移行する。未選択($FF)なら通常のRD_RESTと同じく
; SILENCE_CHへフォールバックする。
; ★2026-08-15: 以前はENVSEL(@v<n>選択中)も条件に入れていた(当時のcompiler.jsが
; 「vTable(@v)が有効な音符のゲートオフでのみ」vrTableへ切り替えていたため)が、
; 実機ppmck(ppmckc datamake.c putReleaseEffect)はリリース発動条件に@vの有無を見ない。
; compiler.js側をresolveEnvTablesで本家準拠(v<n>固定音量でも@vrが効く)に直したので、
; こちらもENVSELの判定を外して揃える。
; ★@@r<n>(リリース音色)もこの瞬間に適用する(実機putReleaseEffectがリリース
; エンベロープの切替と音色の切替を同じ場所で出力するのと同じ)。@vrを使わず
; @@r<n>だけを使う曲でもこのオペコードが使われる(usesGateOffVr) ---
RD_GATEOFFVR:
    JSR READ_BYTE
    STA ${hex(CNT)},X
${usesFreqOnly ? `    JSR TICK_PITCH_FX      ; 読取りフレームぶんの周期側継続効果tick(RD_RESTと同じ)
    BEQ RGV_NOFREQ
    JSR WRITE_FREQ_ONLY
RGV_NOFREQ:` : ''}
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X` : ''}
${usesToneState ? `    JSR APPLY_REL_TONE` : ''}
${usesVr ? `    LDA ${hex(VRSEL)},X
    CMP #$FF
    BEQ RD_GATEOFFVR_NOVR
    LDA #$00
    STA ${hex(RELTICK)},X
    LDA #$01
    STA ${hex(RELPLAY)},X
    JSR REL_LOOKUP
${usesVolSkip ? `    LDA #$FF
    STA ${hex(LASTVOL)},X  ; TVF_NODUTYと同じ理由で音量シャドウを無効化(無条件書込み)
` : ''}    JSR WRITE_VOL_ONLY
    JMP RD_RETURN
RD_GATEOFFVR_NOVR:
    LDA #$00
    STA ${hex(RELPLAY)},X` : ''}
${usesDutyEnv ? `    ; 無音化する側の分岐ではデューティエンベロープも止める(RD_RESTと同じ理由)
    LDA #$FF
    STA ${hex(DUTYSEL)},X` : ''}
    JSR SILENCE_CH
    JMP RD_RETURN

${usesToneState ? `; --- @@r<n>(リリース音色)の適用。RELTONE,Xが$FF(OFF)なら何もしない。
; FDSは音色=波形メモリなので、音色番号を差し替えたら64バイトの波形も
; その場でロードし直す(compiler.jsのsegmentsToWriteLogFdsがゲートオフの
; フレームでfdsWaveLoadWritesを積むのと対応) ---
APPLY_REL_TONE:
    LDA ${hex(RELTONE)},X
    CMP #$FF
    BEQ APPLY_REL_TONE_END
    JSR APPLY_TONE
${usesFds && fdsCustomWaves.length > 0 ? `    LDA ${hex(CHTYPE)},X
    CMP #${hex(TYPE_FDS)}
    BNE APPLY_REL_TONE_END
    JSR FDS_TONE_CHECK` : ''}
APPLY_REL_TONE_END:
    RTS` : ''}

; --- SD(セルフディレイ)のゲートオフ(0xE8、2026-08-15): 直後2バイトが
; [差し替え先ノート番号,フレーム数]。RD_GATEOFFVRと同じリリース突入に加えて、
; 音程を<n>個前のノートへ差し替えたうえで打ち直す(実機ppmckのputReleaseEffectが
; リリースエンベロープへの切替と差し替えたノートの発音を同時に出力するのと同じ)。
; REL_LOOKUPがVOL,Xへリリーステーブルの先頭値を入れるので、そのまま
; WRITE_FREQ_VOL(音符アタックと同じフル書込み)を呼べば、周期の上位バイトごと
; 書き直す=位相/カウンタがリセットされる実機同様のノートオンになる
; (SM有効時はWFV_T*側がSMOOTHACTを見て上位バイトを抑止する。compiler.jsの
; attackWritesHi()と同じ条件) ---
RD_GATEOFFVRSD:
    JSR READ_BYTE
    STA ${hex(NOTE)},X
    JSR READ_BYTE
    STA ${hex(CNT)},X
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X` : ''}
${usesToneState ? `    JSR APPLY_REL_TONE` : ''}
${usesVr ? `    LDA ${hex(VRSEL)},X
    CMP #$FF
    BEQ RD_GATEOFFVRSD_NOVR
    LDA #$00
    STA ${hex(RELTICK)},X
    LDA #$01
    STA ${hex(RELPLAY)},X
    JSR REL_LOOKUP
    JSR WRITE_FREQ_VOL
    JMP RD_RETURN
RD_GATEOFFVRSD_NOVR:
    LDA #$00
    STA ${hex(RELPLAY)},X` : ''}
${usesDutyEnv ? `    ; 無音化する側の分岐ではデューティエンベロープも止める(RD_RESTと同じ理由)
    LDA #$FF
    STA ${hex(DUTYSEL)},X` : ''}
    JSR SILENCE_CH
    JMP RD_RETURN` : ''}

RD_WAIT:
    JSR READ_BYTE
    STA ${hex(CNT)},X
    ; 音長255フレーム超の継続チャンク。読取りフレームだが音符は続いているので、
    ; SERVICE_CHの継続フレームと同じtickを肩代わりする(SERVICE_CH冒頭コメント参照)
${usesVolOnly ? '    JSR TICK_VOL_FX' : ''}
${usesFreqOnly ? `    JSR TICK_PITCH_FX
    BEQ RW_NOFREQ
    JSR WRITE_FREQ_ONLY
RW_NOFREQ:` : ''}
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
; 1フレームずれる。RD_NOTEが音符アタック時に一度だけEP_STEP等を呼ぶのと対称の理由)。
; ★2026-08-16: 音量側(@v、TICK_VOL_FX)も同じ理由で肩代わりする(以前は周期側だけ
; だったため、タイ境界のフレームだけ@vが1フレーム足踏みしていた) ---
RD_PITCHBREAK:
    JSR READ_BYTE
    STA ${hex(NOTE)},X
    JSR READ_BYTE
    STA ${hex(CNT)},X
${usesVolOnly ? '    JSR TICK_VOL_FX' : ''}
    JSR TICK_PITCH_FX
    JSR WRITE_FREQ_ONLY
    JMP RD_RETURN
` : ''}
; sticky音長エンコード対応(2026-08-16、mckBytecode.js参照):
;   A=$E2            … 直前と同じ長さの休符(OP_REST_SAME)
;   A=$76-$E1        … ノート番号(A-$76)+直前と同じ音長の1バイト音符
;   A=$00-$75        … 従来の[音符,音長]2バイト形式(音長はNOTELEN,Xへも控える)
RD_NOTE:
    CMP #$E2
    BNE RD_NOTE_CHK
    JMP RD_REST_SAME
RD_NOTE_CHK:
    CMP #$76
    BCC RD_NOTE_EXPL
    SBC #$76        ; BCC非成立=C=1なのでSEC不要
    STA ${hex(NOTE)},X
    LDA ${hex(NOTELEN)},X
    STA ${hex(CNT)},X
    JMP RD_NOTE_BODY
RD_NOTE_EXPL:
    STA ${hex(NOTE)},X
    JSR READ_BYTE
    STA ${hex(NOTELEN)},X
    STA ${hex(CNT)},X
; RD_NOTE_BODY: NOTE,X/CNT,Xが既に設定済みの状態から先の共通処理(音符アタック本体)。
; PS(0xE9)が対象外チップに使われた場合(RD_PITCHSHIFT参照)、既にノート番号・音長を
; 読み終えているので、ここへ直接JMPして二重読みを避ける
RD_NOTE_BODY:
${usesPitchShift ? `    ; PS(実機準拠)は通常のノートオンで必ず無効化される(実機ppmck keyon_setの
    ; 「ポルタメントを無効化する」処理と同じ、compiler.jsの新規セグメント生成が
    ; psGlideを持たない限りグライドしないのと対応)
    LDA #$00
    STA ${hex(PSACT)},X
    STA ${hex(PSVALLO)},X
    STA ${hex(PSVALHI)},X` : ''}
${usesVr ? `    ; @vr(リリースエンベロープ)は新しい音符が始まったら必ず再生を止める
    ; (compiler.jsのwriteVolumeEnvelopeも音符ごとに独立してゲートON区間から
    ; 再スタートする設計のため、前の音符のリリース再生を引きずらない)
    LDA #$00
    STA ${hex(RELPLAY)},X
    ; リリース再生はVOL,Xをリリーステーブルの値(通常は末尾0)で潰しているので、
    ; v<n>で設定された素の音量へ必ず戻してからアタックする。@v<n>が選択されていれば
    ; この直後のENV_LOOKUPがさらに上書きするので無害(2026-08-15、@v無しで@vrだけを
    ; 使う曲で2音目以降が音量0のまま鳴らなくなる実バグを6502エミュ実測で発見)
    LDA ${hex(VOLBASE)},X
    STA ${hex(VOL)},X` : ''}
${usesToneState ? `    ; 音色も同じ理由で音符ごとに必ず入れ直す。@@r<n>のリリース音色で差し替わった
    ; 後や、@@<n>のデューティエンベロープを途中まで進めた後でも、この音符本来の
    ; 音色(TONEBASE=直前のOP_TONEバイト)からtick0で再スタートする
    ; (compiler.js側もdutyAtが音符先頭のtick0からテーブルを辿る)
    LDA ${hex(TONEBASE)},X
    JSR APPLY_TONE` : ''}
${envTableCount > 0 ? `    ; エンベロープが選択済みなら"この音符から"必ずtick0で再スタートする。
                    ; mckBytecode.js側はテーブル番号が前の音符と同じ場合OP_VOL_ENVを
                    ; 出し直さない(バイトコード節約)ため、判定にENVACTを使うとバグになる
                    ; (★2026-08-14修正: 旧実装はここでENVACT,Xを見ていたが、ENVACTは
                    ; ゲートオフ中RD_REST/RD_GATEOFFVRが0クリアする「今ティックしてよいか」
                    ; の一時フラグを兼ねていたため、直前の音符がq<n>で内部ゲートオフした
                    ; 場合にここが0になり、同じ@v<n>を使い回す次の音符が再初期化されずに
                    ; 前の音符の最終値(またはゲートオフ後の値)を引きずって鳴ってしまう
                    ; 実バグがあった=実機さながらの6502+APUエミュレータで実測発覚。
                    ; 「選択済みかどうか」はENVACTと独立なENVSEL($FF=未選択の番兵、
                    ; RD_VOLENVで選択・RD_VOLで解除)で判定し、選択済みなら毎回ENVACTも
                    ; 1に立て直す)
    LDA ${hex(ENVSEL)},X
    CMP #$FF
    BEQ RD_NOTE_NOENV
    LDA #$01
    STA ${hex(ENVACT)},X
    LDA #$00
    STA ${hex(ENVTICK)},X
    JSR ENV_LOOKUP
RD_NOTE_NOENV:` : ''}
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
${usesEn ? `    ; EN<n>も"この音符から"必ずtick0/累積値0から再初期化する(@v<n>のRD_NOTE_NOENVと
    ; 同じ理由。ENACT継続時に前の音符のENTICK/ENVALをそのまま引き継ぐと、アルペジオの
    ; 違う位相から再生されてしまう)
    LDA ${hex(ENACT)},X
    BEQ RD_NOTE_NOEN
    LDA #$00
    STA ${hex(ENTICK)},X
    STA ${hex(ENVAL)},X
    JSR EN_STEP
RD_NOTE_NOEN:` : ''}
${usesMp ? `    ; MP<n>も"この音符から"必ずdelay/quarterからリセットする(実機effect_init相当)。
    ; MPSTEPSZ/MPSTEPINTはMP<n>選択時(RD_VIBRATO)に計算済みの値をそのまま使う。
    ; リセット直後にLFO_SUB を1回呼び、1フレーム目(delay=0なら即座に動き出す)の値まで
    ; 進めてからWRITE_FREQ_VOL(APPLY_DETUNE)に渡す(compiler.jsのvibratoSequenceが
    ; t=0から通常のフレーム処理ループに入るのと同じ)
    LDA ${hex(MPACT)},X
    BEQ RD_NOTE_NOMP
    JSR MP_INIT
    JSR LFO_SUB
RD_NOTE_NOMP:` : ''}
${usesPortamento ? `    ; PT<n>も"この音符から"必ずdelay/duration/stepcnt/累積値を再初期化する
    ; (2026-08-11 別プロジェクトC。EP_STEPと同じpost-increment単一ルーチン設計、
    ; MPのようなRD_NOTE専用の特別扱いは不要)
    LDA ${hex(PTACT)},X
    BEQ RD_NOTE_NOPT
    JSR PT_INIT
    JSR PT_STEP
RD_NOTE_NOPT:` : ''}
    JSR WRITE_FREQ_VOL
    JMP RD_RETURN
${usesPitchShift ? `
; --- PS(ポルタメント、実機準拠、2026-08-13、0xE9、対応ABC=2A03パルスA/B/三角波):
; 次の2バイトが[目標ノート番号,音長]。対象外チップではグライドせず通常のアタックとして
; 扱う(RD_NOTE_BODYへフォールバック)。対象チップでは、まず現在のNOTE,X(まだ書き換えて
; いない=直前の音)から周期/周波数レジスタ値(oldReg)を求め、次にNOTE,Xを目標ノートへ
; 切り替えてから同じ計算(newReg)を求める。差分をCEILDIV16で段階的に埋めるstep/addfreqへ
; 変換し、PSVALLO/HI(APPLY_DETUNEが読む生オフセット)をoldReg-newRegで初期化する。
; アタック(音量/デューティ再書込み)は行わず、WRITE_FREQ_ONLYで周期/周波数レジスタのみ
; このフレーム分反映する(compiler.jsのpitchShiftOffsetSequence/writePitchModulation
; のtick=0相当)。
; ★PS音符はキーオンではない(ppmck本家pitchshift_setupがeffect_initを通らないのと同じ)
; ので、@v/@vr/EP/MP/PT/ENは前の音からそのまま継続する(@@<n>デューティエンベロープは
; 対象外、compiler.jsのwritePsGlideVolume注記参照)。この読取りフレームはSERVICE_CHの
; 継続処理がスキップされるため、TICK_VOL_FX/TICK_PITCH_FXで1tickぶん肩代わりする
; (RD_PITCHBREAKと同じ理由。★2026-08-16: 以前は肩代わりしていなかったため、
; PS音符の先頭フレームだけ@v等が1フレーム足踏みしcompiler.jsと食い違っていた)。
; ★tickはoldReg/newRegの表引きより前に行う: EN(ノートエンベロープ)継続中は
; LOOKUP_*_PERIODがNOTE+ENVALで表を引くので、このフレームのEN値で
; グライド元/先を求める(compiler.jsのwritePitchModulationのen0と対応)。
; PS音符の直前で選択が変わった効果(RD_VOLENV/RD_PITCHENV/RD_VIBRATO/RD_PORTAMENTO/
; RD_NOTEENVが状態を再初期化済み)は、このtickでちょうどtick0の値になる ---
RD_PITCHSHIFT:
    JSR READ_BYTE
    STA ${hex(PSNEWNOTE)}
    JSR READ_BYTE
    STA ${hex(CNT)},X
    LDA ${hex(CHTYPE)},X
    CMP #${hex(TYPE_2A03_PULSE_A)}
    BEQ RPS_GLIDE
    CMP #${hex(TYPE_2A03_PULSE_B)}
    BEQ RPS_GLIDE
    CMP #${hex(TYPE_2A03_TRI)}
    BEQ RPS_GLIDE
    ; 対象外チップ: グライドせず通常のアタックとして扱う(音長は既に読み込み・設定済み)
    LDA ${hex(PSNEWNOTE)}
    STA ${hex(NOTE)},X
    JMP RD_NOTE_BODY
RPS_GLIDE:
${usesVolOnly ? '    JSR TICK_VOL_FX' : ''}
    JSR TICK_PITCH_FX
    LDA ${hex(CHTYPE)},X
    CMP #${hex(TYPE_2A03_TRI)}
    BEQ RPS_TRI
RPS_PULSE:
    JSR LOOKUP_PULSE_PERIOD
    LDA ${hex(PERLO)}
    STA ${hex(PSOLDLO)}
    LDA ${hex(PERHI)}
    STA ${hex(PSOLDHI)}
    LDA ${hex(PSNEWNOTE)}
    STA ${hex(NOTE)},X
    JSR LOOKUP_PULSE_PERIOD
    JMP RPS_SETUP
RPS_TRI:
    JSR LOOKUP_TRI_PERIOD
    LDA ${hex(PERLO)}
    STA ${hex(PSOLDLO)}
    LDA ${hex(PERHI)}
    STA ${hex(PSOLDHI)}
    LDA ${hex(PSNEWNOTE)}
    STA ${hex(NOTE)},X
    JSR LOOKUP_TRI_PERIOD
RPS_SETUP:
    ; ここでPERLO/PERHI=newReg、PSOLDLO/PSOLDHI=oldReg。
    ; diff = newReg-oldReg (符号付き16bit)を求め、符号で方向を決める
    SEC
    LDA ${hex(PERLO)}
    SBC ${hex(PSOLDLO)}
    PHA
    LDA ${hex(PERHI)}
    SBC ${hex(PSOLDHI)}
    STA ${hex(CDA16HI)}
    PLA
    STA ${hex(CDA16LO)}
    LDA ${hex(CDA16HI)}
    BMI RPS_DIR_SUB
    ; ADD方向(newReg>=oldReg): PSVALLO/HI = oldReg-newReg(負または0)。
    ; |diff| = newReg-oldReg は既にCDA16LO/HIに入っている値そのまま
    LDA #$00
    STA ${hex(PSDIR)},X
    SEC
    LDA ${hex(PSOLDLO)}
    SBC ${hex(PERLO)}
    STA ${hex(PSVALLO)},X
    LDA ${hex(PSOLDHI)}
    SBC ${hex(PERHI)}
    STA ${hex(PSVALHI)},X
    JMP RPS_ABSDONE
RPS_DIR_SUB:
    ; SUBTRACT方向(newReg<oldReg): PSVALLO/HI = oldReg-newReg(正)。
    ; |diff| = oldReg-newReg = 上で求めたnewReg-oldRegを2の補数反転する
    LDA #$FF
    STA ${hex(PSDIR)},X
    SEC
    LDA ${hex(PSOLDLO)}
    SBC ${hex(PERLO)}
    STA ${hex(PSVALLO)},X
    LDA ${hex(PSOLDHI)}
    SBC ${hex(PERHI)}
    STA ${hex(PSVALHI)},X
    SEC
    LDA #$00
    SBC ${hex(CDA16LO)}
    STA ${hex(CDA16LO)}
    LDA #$00
    SBC ${hex(CDA16HI)}
    STA ${hex(CDA16HI)}
RPS_ABSDONE:
    LDA #$01
    STA ${hex(PSACT)},X
    ; duration(既にCNT,Xに設定済み)と|diff|(CDA16LO/HI)の大小でstep/addfreqを決める
    ; (compiler.jsのpitchShiftOffsetSequenceと同じceil除算方式)
    LDA ${hex(CDA16HI)}
    BNE RPS_DIFFBIG
    LDA ${hex(CDA16LO)}
    CMP ${hex(CNT)},X
    BCS RPS_DIFFBIG
    ; duration > diff: stepSize=1, stepInterval=ceilDiv(duration,diff)
    LDA ${hex(CDA16LO)}
    STA ${hex(CDB)}
    LDA ${hex(CNT)},X
    STA ${hex(CDA16LO)}
    LDA #$00
    STA ${hex(CDA16HI)}
    JSR CEILDIV16
    STA ${hex(PSSTEPINT)},X
    LDA #$01
    STA ${hex(PSSTEPSZ)},X
    JMP RPS_STEPDONE
RPS_DIFFBIG:
    ; diff >= duration: stepSize=ceilDiv(diff,duration), stepInterval=1
    LDA ${hex(CNT)},X
    STA ${hex(CDB)}
    JSR CEILDIV16
    STA ${hex(PSSTEPSZ)},X
    LDA #$01
    STA ${hex(PSSTEPINT)},X
RPS_STEPDONE:
    ; PSSTEPCNT=PSSTEPINTから開始してPS_STEPを1回呼ぶことで、compiler.jsの
    ; pitchShiftOffsetSequence(counter=stepから開始し1回目のtickで即座に1歩進む)と
    ; 同じタイミングにする(PT_STEPをRD_NOTEから初回呼び出しするのと同じ作法)
    LDA ${hex(PSSTEPINT)},X
    STA ${hex(PSSTEPCNT)},X
    JSR PS_STEP
    JSR WRITE_FREQ_ONLY
    JMP RD_RETURN` : ''}

RD_ENDTRACK:
    ; トラック終端。このチャンネルにL(ループ地点マーカー)があれば、SONG_LOOP_ACTで
    ; 無音化せずそこへジャンプして演奏を続ける(実機同様の無限ループ。0xA0/0xA1による
    ; 小節単位の繰り返しループは引き続き未対応)。無ければ従来通り無音化して停止する
    ; (音符が1つも無い空トラックでも安全なように、ポインタ/バンクは変更せず
    ; カウンタだけ最大にして抜ける。次にCNTが尽きたら同じ0xFFに再度到達し、
    ; また安全に停止するだけ)
${usesLoop ? `    LDA SONG_LOOP_ACT,X
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
    JMP RD_LOOP` : ''}
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
${usesVolSkip ? `    LDA #$FF
    STA ${hex(LASTVOL)},X  ; 同上(無音化も音量レジスタを直接書くためシャドウを無効化)
` : ''}    LDA ${hex(CHTYPE)},X
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
${usesVolSkip ? `    LDA #$FF
    STA ${hex(LASTVOL)},X  ; 音量シャドウを無効化。チップ別ハンドラが音量レジスタを直接
                           ; 書くため、TICK_VOL_FXの同値スキップ判定が古い値を参照して
                           ; 必要な書込みを飛ばすのを防ぐ($FFは音量が取り得ない番兵)
` : ''}    LDA ${hex(CHTYPE)},X
    ASL A
    TAY
    LDA WFV_JUMPTABLE,Y
    STA ${hex(JMPLO)}
    LDA WFV_JUMPTABLE+1,Y
    STA ${hex(JMPHI)}
    JMP (${hex(JMPLO)})
${usesVolOnly ? `
; --- チャンネルX(0-N-1)の音量レジスタ"のみ"をAPUへ反映する(ソフトウェア音量エンベロープ
; および@vrリリースエンベロープの毎フレームtick更新専用。周期/コントロールレジスタは
; 書き換えない)。
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
; テーブル索引はYで行いXは温存する(2026-08-16 最適化: 以前はTAXでXを潰していたため
; 全呼び出し元がSTX/LDX ${hex(CHIDX)}の退避・復元ペアを持っていた=6サイクル+4バイト×約20箇所)
; ============================================================
; EN<n>(ノートエンベロープ)有効時、ノート番号にENVAL,X(符号付き累積オフセット)を
; 加算してからテーブルを引く(compiler.jsのnoteFrequency(baseNoteNumber+enOffset)と
; 同じ「ノート番号空間で加算してから周波数化」の6502側実装。D<n>/EP<n>/MP<n>のような
; 生レジスタ空間への加算ではない点に注意)。加算結果が負に振れた場合は0へクランプする
; (このアプリのfreqテーブルは0-107の108音分しか無いため)。上限側(TABLE_MAX超過)の
; クランプは元からある。逆に極端に大きい正のオフセットで8bit符号付き加算がオーバーフロー
; するケースは非対応(APPLY_DETUNEの上限側同様、通常の用途の値では発生しない)
LOOKUP_PULSE_PERIOD:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LPP_NONNEG
    LDA #$00
    JMP LPP_INDEX
LPP_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC LPP_OK
    LDA #${hex(TABLE_MAX)}
LPP_OK:
LPP_INDEX:
    ASL A
    TAY
    LDA PULSE_TABLE,Y
    STA ${hex(PERLO)}
    LDA PULSE_TABLE+1,Y
    STA ${hex(PERHI)}
    RTS

LOOKUP_TRI_PERIOD:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LTP_NONNEG
    LDA #$00
    JMP LTP_INDEX
LTP_NONNEG:` : ''}
    CMP #${hex(TABLE_MAX)}
    BCC LTP_OK
    LDA #${hex(TABLE_MAX)}
LTP_OK:
LTP_INDEX:
    ASL A
    TAY
    LDA TRI_TABLE,Y
    STA ${hex(PERLO)}
    LDA TRI_TABLE+1,Y
    STA ${hex(PERHI)}
    RTS

${usesAnyPitchOffset ? `; --- D<n>/EP<n>/MP<n>/PT<n>共通処理。呼出し前提: Xはチャンネル番号、PERLO/PERHIに
; テーブル参照済みの周期値が入っている状態で呼ぶ。DETUNE_LO/HI,X(符号付き16bit)を通常の
; 16bit ADCで加算し、続けてEP(EPVALLO/HI,X、有効時のみ)・MP(MPVALLO/HI,X、有効時のみ)・
; PT(PTVALLO/HI,X、有効時のみ、2026-08-11 別プロジェクトC)を同じく16bit ADCで加算する
; (2の補数表現なので符号付き値でもビット演算は加算と同一。compiler.jsの
; pitchRegisterOffsetがD+EP+MP+PTを1つの生オフセットに合算してから1回だけクランプ加算
; するのと数学的に同じ結果になる、逐次加算でも結合則で等価)。
; 最終的な加算結果が負(PERHIのbit7が立つ)ならPERLO/PERHI=0にクランプする(JS側=
; compiler.jsのapplyDetuneのMath.max(0,...)と同じ意図。上限側のクランプは行わない=
; 極端に大きいオフセットでレジスタ幅を超えるケースは非対応、通常の用途の値では発生しない)。
; Xは破壊しない。D/EP/MP/PT/PS全部未使用の曲ではルーチン本体も全JSRも省略される
; (usesAnyPitchOffset、buildFixedSource末尾の行フィルタ参照) ---
APPLY_DETUNE:
` : ''}${usesAnyPitchOffset && usesDetune ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(DETUNE_LO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(DETUNE_HI)},X
    STA ${hex(PERHI)}
` : ''}${usesEp ? `    CLC
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
` : ''}${usesPitchShift ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(PSVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(PSVALHI)},X
    STA ${hex(PERHI)}
` : ''}${usesAnyPitchOffset ? `    LDA ${hex(PERHI)}
    BPL APPLY_DETUNE_OK
    LDA #$00
    STA ${hex(PERLO)}
    STA ${hex(PERHI)}
APPLY_DETUNE_OK:
    RTS
` : ''}
; ============================================================
; 種別ごとのレジスタ書き込みハンドラ(WFV_T*)・無音化ハンドラ(SIL_T*)
; 2A03(T0-T3)は常時、拡張音源分(T4-T27)は実際に使うチップのみ埋め込む
; ============================================================

; --- 2A03パルスA ($4000) ---
WFV_T0:
    JSR LOOKUP_PULSE_PERIOD
    JSR APPLY_DETUNE
${usesSweep ? `    LDA ${hex(SWEEPREG)},X
    STA $4001       ; s<speed>,<depth>。音符アタックごとに書き直す(RD_SWEEP参照)
` : ''}    LDA ${hex(PERLO)}
    STA $4002
    LDA ${hex(PERHI)}
${usesSmooth ? `    LDY ${hex(SMOOTHACT)},X    ; SM無効(0)なら常に書く、有効なら変化時のみ(WFV0_HI_SKIP)
    BEQ WFV0_HI_GO
    CMP ${hex(LASTHI)},X
    BEQ WFV0_HI_SKIP
WFV0_HI_GO:
` : ''}${needsLastHi ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $4003
${usesSmooth ? 'WFV0_HI_SKIP:\n' : ''}    LDA ${hex(DUTY)},X
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
    JSR LOOKUP_PULSE_PERIOD
    JSR APPLY_DETUNE
${usesSweep ? `    LDA ${hex(SWEEPREG)},X
    STA $4005       ; s<speed>,<depth>(パルスB)
` : ''}    LDA ${hex(PERLO)}
    STA $4006
    LDA ${hex(PERHI)}
${usesSmooth ? `    LDY ${hex(SMOOTHACT)},X
    BEQ WFV1_HI_GO
    CMP ${hex(LASTHI)},X
    BEQ WFV1_HI_SKIP
WFV1_HI_GO:
` : ''}${needsLastHi ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $4007
${usesSmooth ? 'WFV1_HI_SKIP:\n' : ''}    LDA ${hex(DUTY)},X
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
    JSR LOOKUP_TRI_PERIOD
    JSR APPLY_DETUNE
    LDA ${hex(PERLO)}
    STA $400A
    LDA ${hex(PERHI)}
${usesSmooth ? `    LDY ${hex(SMOOTHACT)},X
    BEQ WFV2_HI_GO
    CMP ${hex(LASTHI)},X
    BEQ WFV2_HI_SKIP
WFV2_HI_GO:
` : ''}${needsLastHi ? `    STA ${hex(LASTHI)},X\n` : ''}    STA $400B
${usesSmooth ? 'WFV2_HI_SKIP:\n' : ''}    LDA ${hex(VOL)},X
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
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_PULSE_PERIOD
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
    JSR LOOKUP_TRI_PERIOD
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
${usesVolOnly ? `; --- 音量エンベロープ(@v)/リリースエンベロープ(@vr)の毎フレームtick更新: 音量のみ書込むハンドラ(WFV_VOL_T*)。
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
${usesVolOnly ? `WFV_VOL_JUMPTABLE:\n    .word ${wfvVolEntries.join(',')}` : ''}
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
SONG_ADDR_LO:
    .byte ${songAddrLo.join(',')}
SONG_ADDR_HI:
    .byte ${songAddrHi.join(',')}
${usesLoop ? `; L(ループ地点マーカー)対応: このチャンネルがトラック終端に達したときループするか
; (SONG_LOOP_ACT、0/1)、するならどこへ戻るか(バンク番号+アドレス下位/上位)。
; Lを使わないチャンネルはact=0で、バンク/アドレスの値自体は無視される(RD_ENDTRACK参照)。
; 曲中どのチャンネルも1個もLを使っていない場合はこの4テーブルごと埋め込まない
; (2026-08-16 ROM圧縮対応、RD_ENDTRACK側のusesLoopガードと対)
SONG_LOOP_ACT:
    .byte ${loopAct.join(',')}
SONG_LOOP_BANK:
    .byte ${loopBank.join(',')}
SONG_LOOP_PTR_LO:
    .byte ${loopLo.join(',')}
SONG_LOOP_PTR_HI:
    .byte ${loopHi.join(',')}` : ''}
`;
    // D/EP/MP/PT/PS(周期への生オフセット系)を一切使わない曲では、各ハンドラに埋め込まれた
    // JSR APPLY_DETUNE(_N163)を全て除去する(ルーチン本体も上で未生成)。ハンドラ側の
    // テンプレートを個別に条件分岐させる代わりに、生成済みソースから該当行だけを
    // 一括で落とす(呼び出し行は厳密にこの2形しか無い)
    if (usesAnyPitchOffset) return fullSrc;
    return fullSrc.split('\n').filter(l => {
      const t = l.trim();
      return t !== 'JSR APPLY_DETUNE' && t !== 'JSR APPLY_DETUNE_N163';
    }).join('\n');
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
    let channelLetters = compileResult.channelLetters || ['A', 'B', 'C', 'D'];
    const expansions = compileResult.expansions || [];
    let expansionLetterMap = compileResult.expansionLetterMap || {};
    const segmentsByChannel = compileResult.segmentsByChannel || {};

    // N163の有効チャンネル数($7Fに書く値、周波数テーブルの符号化、レジスタ配置の
    // (8-num)+chオフセットの全てに効く)をcompiler.js(segmentsToWriteLogN163の呼び出し元)と
    // 完全に同じ規則=「音符を持つ最上位レターの位置+1」で決める。以前は#EX-NAMCO106で
    // 宣言された8レター全部をチャンネルとして組み込み常に8ch扱いだったため、ブラウザ再生
    // (実使用ch数)とNSF書き出しで$7F・周波数値・レジスタ配置が全て食い違っていた
    // (女神転生II 11曲目=4ch使用曲で発覚)。有効ch数より上のレター(音符無し)は実機上の
    // 実体が無い(レジスタ配置がRAM範囲外へはみ出す)ためドライバのチャンネル一覧から除外する
    // 有効ch数は下のN163共有バッファ割り当て(波形に使えるバイト数=128-8*numCh)でも要るので
    // ブロックの外へ出しておく
    let numN163Ch = 8;
    if (expansions.includes('n163')) {
      const n163All = expansionLetterMap.n163 || [];
      numN163Ch = 0;
      n163All.forEach((ch, index) => {
        if ((segmentsByChannel[ch] || []).some(s => s.freq != null)) numN163Ch = index + 1;
      });
      numN163Ch = Math.max(1, numN163Ch);
      if (numN163Ch < n163All.length) {
        const dropped = new Set(n163All.slice(numN163Ch));
        expansionLetterMap = Object.assign({}, expansionLetterMap, { n163: n163All.slice(0, numN163Ch) });
        channelLetters = channelLetters.filter(ch => !dropped.has(ch));
      }
    }
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
      // ★numN163Ch(=$7Fへ書く有効ch数)で波形に使えるバイト数が決まる(128-8*numCh)。
      //   compiler.js側と同じ値を渡さないと、プレビューは通るのに書き出しだけ落ちる
      const allocResult = MML.N163Alloc.allocate(
        Array.from(n163Letters), segmentsByChannel, envelopes.n, compileResult.totalFrames, numN163Ch);
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

    // @vr<n>(リリースエンベロープ、2026-08-13)も@v/@EP/@MPと同じ「実際に使われている
    // インデックスだけをコンパクトに詰める」方式。
    // ★2026-08-15: 以前は「seg.envelopeV(@v)も有効な場合」に限ってカウントしていたが、
    // 実機ppmck(putReleaseEffect)は@vの有無をリリース発動条件にしない。compiler.jsの
    // resolveEnvTablesを本家準拠に直したのに合わせ、@v無し(v<n>固定音量)の音符でも
    // カウントする。テーブル実体は@vr<n>定義が無ければ@v<n>定義へフォールバックする
    // (buildFixedSourceのvrTableOfと同じ規則)。この変更でenvTableCount=0のまま
    // usesVr=trueになり得るため、WRITE_VOL_ONLY等の埋め込み条件はusesVolOnlyで判定する
    const vrTableExists = idx => (envelopes.vr && envelopes.vr[idx]) || (envelopes.v && envelopes.v[idx]);
    const usedVrIndices = new Set();
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.envelopeVr != null && seg.envelopeVr !== 255 && vrTableExists(seg.envelopeVr)) {
          usedVrIndices.add(seg.envelopeVr);
        }
      }
    }
    const vrIndexList = Array.from(usedVrIndices).sort((a, b) => a - b);
    const vrIndexRemap = {};
    vrIndexList.forEach((origIdx, i) => { vrIndexRemap[origIdx] = i; });

    // @@<n>(デューティ=音色エンベロープ、2026-08-15)も同じ「実際に使われているインデックス
    // だけをコンパクトに詰める」方式。seg.toneEnvが選択中の番号(null=@<n>の固定音色)で、
    // @@r<n>のリリース音色もデューティ系チップ(seg.releaseToneDuty)なら同じテーブルを指す。
    // usesRelToneは「@@r<n>が曲中で1回でも使われたか」(FDS/VRC7のように固定音色番号を
    // 指すだけでデューティエンベロープを使わない場合もあるため独立したフラグにする)
    const usedDutyIndices = new Set();
    let usesRelTone = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.toneEnv != null && envelopes.duty && envelopes.duty[seg.toneEnv]) {
          usedDutyIndices.add(seg.toneEnv);
        }
        if (seg.releaseTone != null && seg.releaseTone !== 255) {
          usesRelTone = true;
          if (seg.releaseToneDuty && envelopes.duty && envelopes.duty[seg.releaseTone]) {
            usedDutyIndices.add(seg.releaseTone);
          }
        }
      }
    }
    const dutyIndexList = Array.from(usedDutyIndices).sort((a, b) => a - b);
    const dutyIndexRemap = {};
    dutyIndexList.forEach((origIdx, i) => { dutyIndexRemap[origIdx] = i; });

    // EN<n>(ノートエンベロープ=高速アルペジオ)も@v/EP/MPと全く同じ「実際に使われている
    // インデックスだけをコンパクトに詰める」方式(2026-08-14実装)。
    // seg.noteEnvは255=off、それ以外がenvelopes.enへの生の添字
    const usedEnIndices = new Set();
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.noteEnv != null && seg.noteEnv !== 255 && envelopes.en && envelopes.en[seg.noteEnv]) {
          usedEnIndices.add(seg.noteEnv);
        }
      }
    }
    const enIndexList = Array.from(usedEnIndices).sort((a, b) => a - b);
    const enIndexRemap = {};
    enIndexList.forEach((origIdx, i) => { enIndexRemap[origIdx] = i; });

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

    // D<n>(デチューン、2026-08-16 ROM圧縮対応)。PT/pitchBreakと同じく曲中で使われて
    // いるかどうかの真偽値だけを判定する(値そのものはmckBytecode.js側がseg.detuneから
    // 直接拾うのでremapテーブルは不要)。0はD<n>未指定時の既定値なので対象外
    let usesDetune = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.detune) { usesDetune = true; break; }
      }
      if (usesDetune) break;
    }

    // SA<num>(N163ピッチシフト量、2026-08-26、本家ppmckcのpitch_shift_amount相当)。
    // D<n>と同じ真偽値のみの判定。0はSA未指定時の既定値なので対象外
    let usesPitchSa = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.pitchSa) { usesPitchSa = true; break; }
      }
      if (usesPitchSa) break;
    }

    // s<speed>,<depth>(ハードウェアスイープ、2026-08-20、対応AB=2A03パルスのみ)。
    // D<n>と同じく真偽値のみ判定する(生バイトはmckBytecode.jsがseg.sweepSpeed/Depthから
    // compiler.jsのsweepRegisterByteで直接作るのでremapテーブルは不要)。
    // speed=0はs未指定/OFFの既定値なので対象外
    let usesSweep = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.sweepSpeed) { usesSweep = true; break; }
      }
      if (usesSweep) break;
    }

    // SM/SMOF(スムース、2026-08-13、対応ABC=2A03パルスA/B/三角波)。PT/pitchBreakと
    // 同じく曲中で使われているかどうかの真偽値だけを判定する
    let usesSmooth = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.smooth) { usesSmooth = true; break; }
      }
      if (usesSmooth) break;
    }

    // PS(ポルタメント、実機準拠、2026-08-13、対応ABC)。同じく真偽値のみ判定
    let usesPitchShift = false;
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.psGlide != null) { usesPitchShift = true; break; }
      }
      if (usesPitchShift) break;
    }

    // y<adr>,<num>(レジスタ直接書き込み、2026-08-13)。immediateWritesByChannelに
    // kind:'rawWrite'として記録されている(チップ非依存、全チャンネル対象)
    let usesRawWrite = false;
    for (const ch of channelLetters) {
      if ((immediateWritesByChannel[ch] || []).some(iw => iw.kind === 'rawWrite')) { usesRawWrite = true; break; }
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
        ...(n163Letters.has(ch) ? (n163RelocsByChannel[ch] || []) : []),
        ...(usesRawWrite ? (immediateWritesByChannel[ch] || []).filter(iw => iw.kind === 'rawWrite') : [])
      ],
      envIndexRemap,
      loopFrameByChannel[ch],
      epIndexRemap,
      mpIndexRemap,
      enIndexRemap,
      vrIndexRemap,
      // 音符内部のゲートオフ専用オペコードを使うか(@vrだけでなく@@rでも必要。
      // buildFixedSourceのusesGateOffVrと同じ条件にすること)
      vrIndexList.length > 0 || usesRelTone,
      dutyIndexRemap));
    const chBytes = chSerialized.map(r => r.bytes);

    // 各チャンネルを順にバンク配置する。ループ地点(あれば)が最終的にどのバンク・
    // アドレスへ配置されたかもここで解決する。
    //
    // ROM圧縮(2026-08-15): ドライバ本体・曲データ用のバンク数を、常に固定(バンク0-7=
    // 32KB、うち多くの曲で半分以上が中身の無い予約領域)ではなく実サイズに合わせて
    // 動的に決める。
    //  1. まずダミーのSONG_BANK/SONG_ADDR_*/SONG_LOOP_*(値は何でもよい。.byteテーブルの
    //     長さ=チャンネル数だけ合っていればアセンブル後のバイト数は変わらない)で
    //     ドライバ本体を1回アセンブルし、実際に必要なバンク数(driverCodeBanks)を測る。
    //  2. DPCMを使う曲は、実機DMCハードウェアが$C000-$FFFFからしかサンプルを読めない
    //     制約上サンプルを$C000以降の窓に置く必要があるが、ファイル上のバンク番号は
    //     窓番号と独立に詰められる(下記「ROM上のバンク配置」参照。2026-08-16、以前は
    //     バンク4-7=16KBを無条件予約していた)。
    //  3. 各チャンネルは(従来のように必ず新しいバンクの$8000から始めるのではなく)
    //     直前のチャンネルの続きに、バンクを跨がない範囲で詰めて配置する
    //     (layoutChannelBanksのstartOffset)。未使用/ほぼ空の拡張音源チャンネルが
    //     丸ごと1バンク(4096バイト)を専有してしまう無駄を無くす。
    const dpcmUsed = Object.keys(dpcmLayout).length > 0;

    // バンク0(窓0)はドライバが動的に読み替える場所そのもので、コードさえ置かなければ
    // チャンネルデータ用に自由に使える(READ_DATA参照)。ドライバ本体(+DPCM使用時は
    // その専用領域)が占有するバンク(reservedBank述語が真になる番号)だけを「穴」として
    // 飛び越え、バンク0から真っ先に詰めていく(ユーザー指示: データ領域として使えるなら
    // 真っ先に埋める)
    function layoutAllChannels(reservedBank) {
      const songBank = [], songAddrLo = [], songAddrHi = [];
      const allDataBanks = [];
      const loopAct = [], loopBank = [], loopLo = [], loopHi = [];
      let bankNum = 0, offsetInBank = 0;
      for (let i = 0; i < channelLetters.length; i++) {
        const layout = layoutChannelBanks(chBytes[i], bankNum, offsetInBank, chSerialized[i].loopByteOffset, reservedBank);
        songBank.push(layout.startBank);
        songAddrLo.push((0x8000 + layout.startOffset) & 0xff);
        songAddrHi.push((0x8000 + layout.startOffset) >> 8);
        allDataBanks.push(...layout.banks);
        bankNum = layout.nextFreeBank;
        offsetInBank = layout.nextFreeOffset;
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
      return { songBank, songAddrLo, songAddrHi, allDataBanks, songLoop: { act: loopAct, bank: loopBank, lo: loopLo, hi: loopHi } };
    }

    // 1回目: サイズ測定専用のダミー割当(値そのものはアセンブル後のバイト数に影響しない)
    const dummyBank = channelLetters.map(() => 0);
    const probeSrc = buildFixedSource(channelTypes, dummyBank, usedExpansions, envelopes, dpcmLayout, dpcmSamples, envIndexList,
      undefined, epIndexList, mpIndexList, usesPortamento, usesPitchBreak, usesSmooth, usesPitchShift, usesRawWrite,
      vrIndexList, enIndexList, dutyIndexList, usesRelTone, dummyBank, dummyBank, usesDetune, undefined, usesSweep, usesPitchSa);
    const probeAsm = MML.Asm.assemble(probeSrc, { origin: 0x8000 });
    if (probeAsm.errors.length > 0) {
      return { nsfBytes: null, asmErrors: probeAsm.errors, bankCount: 0, unsupportedExpansions };
    }
    // ドライバ本体(コード+テーブル)のバンク数(窓0=バンク0のダミー4KBは含まない)
    const driverCodeBanks = Math.max(1, Math.ceil((probeAsm.bytes.length - BANK_SIZE) / BANK_SIZE));

    // ROM上のバンク配置(2026-08-16、DPCM曲のROM圧縮):
    // ファイル上のバンク番号と実行時の窓番号は同じである必要が無い(窓→バンクの対応は
    // NSFヘッダのbankswitch初期値で自由に決められ、ドライバ自身は窓0($5FF8)しか
    // 切り替えない)。これを使ってDPCM使用曲でも空きバンクを一切作らない:
    //   ・DPCM未使用: [0]=曲データ / [1..d]=ドライバ($9000〜、窓1..d) / [d+1..]=曲データ
    //     (従来通り。窓とバンクは同番号)
    //   ・DPCM使用  : [0]=曲データ / [1..d]=ドライバ($C000-d×4KB〜=窓4-d..3) /
    //                 [d+1..d+p]=DPCMサンプル($C000〜=窓4..3+p) / [d+p+1..]=曲データ
    //     以前はDPCM使用曲は無条件にバンク0-7=32KBを固定確保しており(ドライバ$9000固定+
    //     サンプル$C000固定の間の空きバンクも、サンプル末尾以降のバンク5-7も全部空のまま)、
    //     Batman Prototype 1曲目のようにDPCM 1個・曲データ2KBでも常に32896バイトになっていた
    let driverOrg = 0x9000;
    let driverFileBank = 1;          // ドライバ本体のファイル上の先頭バンク
    let dpcmFileBank = 0, dpcmBanks = 0; // DPCMサンプル領域のファイル上の先頭バンクとバンク数
    if (dpcmUsed) {
      // DPCM使用時はサンプルが$C000固定なので、ドライバはその直下(窓1-3=最大12KB)に収める必要がある
      if (probeAsm.bytes.length > DRIVER_CODE_LIMIT) {
        return {
          nsfBytes: null,
          asmErrors: [{ lineNo: 0, message: `ドライバ本体が${probeAsm.bytes.length}バイトあり、割当領域` +
            `(バンク0-3、${DRIVER_CODE_LIMIT}バイト)を超えています。カスタム音色/波形の定義数を` +
            '減らしてください(DPCM使用時はバンク4-7がサンプル専用のため、ドライバはバンク0-3に収める必要があります)' }],
          bankCount: 0,
          unsupportedExpansions
        };
      }
      // DPCMサンプル本体は$C000から連続配置される(layoutDpcmSamples)。実際に使っている
      // 末尾までのバンク数だけを確保する
      let dpcmEnd = 0;
      for (const idx of Object.keys(dpcmLayout)) {
        const layout = dpcmLayout[idx];
        dpcmEnd = Math.max(dpcmEnd, layout.addr - 0xC000 + layout.bytes.length);
      }
      dpcmBanks = Math.max(1, Math.ceil(dpcmEnd / BANK_SIZE));
      driverOrg = 0xC000 - driverCodeBanks * BANK_SIZE;
      dpcmFileBank = driverFileBank + driverCodeBanks;
    }
    const fixedEndBank = driverFileBank + driverCodeBanks + dpcmBanks; // これ未満(1以上)がデータ禁止
    const channelStartBank = fixedEndBank;
    const reservedBank = n => (n >= 1 && n < fixedEndBank);

    // 2回目: 実際のチャンネルデータ配置(詰め込み込み)を確定し、それを使ってドライバ本体を
    // 再アセンブルする(songBank等の値とorgが変わるだけでバイト数は1回目と一致するはず。
    // orgの違いはゼロページ/絶対の選択や分岐距離に影響しないため)
    const { songBank, songAddrLo, songAddrHi, allDataBanks, songLoop } = layoutAllChannels(reservedBank);

    const src = buildFixedSource(channelTypes, songBank, usedExpansions, envelopes, dpcmLayout, dpcmSamples, envIndexList, songLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak, usesSmooth, usesPitchShift, usesRawWrite, vrIndexList, enIndexList, dutyIndexList, usesRelTone, songAddrLo, songAddrHi, usesDetune, driverOrg, usesSweep, usesPitchSa);
    const asm = MML.Asm.assemble(src, { origin: 0x8000 });
    if (asm.errors.length > 0) {
      return { nsfBytes: null, asmErrors: asm.errors, bankCount: 0, unsupportedExpansions };
    }
    const driverBytes = asm.bytes.slice(driverOrg - 0x8000);
    if (driverBytes.length > driverCodeBanks * BANK_SIZE) {
      return {
        nsfBytes: null,
        asmErrors: [{ lineNo: 0, message: `内部エラー: ドライバ本体のサイズが計測時(${(probeAsm.bytes.length - BANK_SIZE)}バイト)と` +
          `再アセンブル時(${driverBytes.length}バイト)で一致しません` }],
        bankCount: 0,
        unsupportedExpansions
      };
    }

    // 曲データバンクをバンク番号順に並べ、それぞれのオフセットへ配置する。バンク内の
    // 隙間・末尾の未使用領域は0xFF(トラック終端相当)で埋めておく(念のための安全策)。
    // 複数チャンネルが同じバンクを分け合う(ROM圧縮対応)ため、programBytes全体を
    // あらかじめ0xFFで埋めてから実データを上書きする(個別に末尾だけ埋める旧方式だと、
    // 同じバンクの別オフセットに来る他チャンネルのデータとの順序依存が生じるため)
    allDataBanks.sort((a, b) => a.bankNum - b.bankNum);
    // 固定領域(ドライバ本体+DPCMサンプル)の末尾バンクは、チャンネルデータがそれより
    // 手前(バンク0)だけに収まった場合でも必ず含める
    const totalBanks = Math.max(
      fixedEndBank,
      allDataBanks.length > 0 ? allDataBanks[allDataBanks.length - 1].bankNum + 1 : channelStartBank);
    const programBytes = new Uint8Array(totalBanks * BANK_SIZE);
    programBytes.fill(0xff);
    // ドライバ本体(ファイル上バンク[driverFileBank..))
    programBytes.set(driverBytes, driverFileBank * BANK_SIZE);
    // DPCMサンプル本体(ファイル上バンク[dpcmFileBank..)。実行時は窓4以降=$C000以降に
    // 見える。実機DMCハードウェアはこのアドレス範囲からしかサンプルを読めないため、
    // NSFのバンク切り替え初期値(下記opt.bankswitch)で最初からこの窓に固定マップしておく。
    // 追加の6502コードは不要 — NSFロード時にNsfBus/実機側で$5FF8-$5FFFへ反映される)
    for (const idx of Object.keys(dpcmLayout)) {
      const layout = dpcmLayout[idx];
      programBytes.set(layout.bytes, dpcmFileBank * BANK_SIZE + (layout.addr - 0xC000));
    }
    for (const b of allDataBanks) {
      programBytes.set(b.data, b.bankNum * BANK_SIZE + b.offset);
    }

    const opt = Object.assign({}, headerOpt);
    opt.loadAddr = 0x8000;
    opt.initAddr = asm.symbols.INIT;
    opt.playAddr = asm.symbols.PLAY;
    // 窓→ファイル上バンク番号の初期値(上のROM配置コメント参照)。
    // 窓0(曲データ用)は使用前に必ず上書きされるので何でもよい。ドライバ本体の窓
    // (driverOrgから始まるdriverCodeBanks個)とDPCMサンプルの窓(4以降dpcmBanks個)を
    // それぞれのファイル上バンクへ向け、それ以外の窓(実行時に一度も参照されない)は
    // 実在しないバンク番号を初期値テーブルへ書かないよう0にしておく(存在しないバンク
    // 番号を初期値表に載せると、NSFプレイヤー実装によっては未定義動作になりうるための保険)
    const driverWin0 = (driverOrg - 0x8000) / BANK_SIZE;
    opt.bankswitch = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7].map(w => {
      if (w >= driverWin0 && w < driverWin0 + driverCodeBanks) return driverFileBank + (w - driverWin0);
      if (dpcmUsed && w >= DATA_DPCM_BANK && w < DATA_DPCM_BANK + dpcmBanks) return dpcmFileBank + (w - DATA_DPCM_BANK);
      return 0;
    }));
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
    // 内訳(UIの完了メッセージ用): ドライバ本体(バンク0の.resぶんを除いた実コード+テーブル)、
    // 曲データ(全チャンネルのバイトコード合計、バンクジャンプマーカー等は含まない)、DPCM
    let dpcmBytes = 0;
    for (const idx of Object.keys(dpcmLayout)) dpcmBytes += dpcmLayout[idx].bytes.length;
    return {
      nsfBytes, asmErrors: [], bankCount: Math.ceil(programBytes.length / BANK_SIZE),
      unsupportedExpansions,
      driverBytes: driverBytes.length,
      songDataBytes: chBytes.reduce((s, b) => s + b.length, 0),
      dpcmBytes
    };
  };
})(window);
