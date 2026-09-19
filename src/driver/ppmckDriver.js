/*
 * SPDX-License-Identifier: 0BSD
 * Copyright (C) 2026 rp2a03g
 *
 * ★このファイルだけは本体(GPL-2.0)と別に 0BSD で配布する(全文は LICENSE.0BSD)。
 *   ここで生成する6502コードと各種テーブルは、書き出したNSFにそのまま埋め込まれる。
 *   書き出したNSFを使う人に、ライセンス上の義務も著作権表示も求めないため。
 *   ⇒ このファイルにGPL/LGPLのコード(Nuked系など)を持ち込まないこと。
 *
 * ppmck系からの由来: MP(ソフトウェアLFO)の状態機械は ppmck の lfo_sub /
 * warizan_start(mck由来の機能)に合わせてある。PS は後年のフォーク AoiMoe/ppmck の
 * process_ps / pitchshift_setup のアルゴリズムを、このドライバの状態遷移として
 * 書き直したもの。mck・ppmck ともに再利用・改変を制限しない配布条件。
 *
 * MML.NSF.MckBytecode が生成するバイトコードを再生する6502サウンドドライバ+
 * NSFバンク切り替え対応の書き出し一式。作業計画フェーズ1.6タスク2/3/5/6。
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
 * ノイズも2026-09-14から対象(LOOKUP_NOISE_PERIOD: NOTE=周期index直値、(NOTE+ENVAL)&15 に D/EP/MP/PT を
 * 8bitで加減算し桁あふれの bit7=短周期、@<n>のbit0も bit7 へ OR。ppmck準拠、2026-09-18)。SPCブラウザ側
 * 抽出は対応済みだがSPCはNSF書き出し経路を持たないためこのドライバとは無関係。
 * FME7のノイズ(0xF1=N<n>)と@<n>によるミキサー制御(0=ミュート/1=トーン/2=ノイズ/
 * 3=トーン+ノイズ、@2はノート番号がノイズ周期)、およびハードウェアエンベロープ
 * (0xF2=S<n>/M<n>)は2026-07-28に実装(FME7_PREP/FME7_WRITE_VOL参照)。
 * デチューン(0xFA、D<n>)は2026-07-24実装(APPLY_DETUNE/APPLY_DETUNE_N163参照)。
 * ピッチエンベロープ(0xF8、EP<n>)・ソフトウェアビブラート(0xFB、MP<n>)は2026-08-11実装
 * (EP_LOOKUP(累積、2026-09-13)/LFO_SUB/WRITE_FREQ_ONLY参照)。D<n>と全く同じ「発音周波数レジスタへの
 * 生オフセット加算」空間をAPPLY_DETUNE/APPLY_DETUNE_N163内で合算する。
 * D<n>/EP<n>/MP<n>いずれも2A03パルス/三角・VRC6・MMC5・FME7・FDS・N163に対応、
 * VRC7は対象外(compiler.js側のブラウザ再生と同じ対応範囲、DESIGN-PITCH.md §7)。ノイズは
 * 2026-09-14から対象。2026-09-18からはppmck準拠で周期index(0-15)へD/EP/MP/PTを8bit加減算し
 * クランプしない(D16 n0 → $F0 のように桁あふれで bit7=短周期が立つ。compiler.jsのノイズ経路と同じ、
 * 実ppmck09aのNSFと$400E列で一致確認)。
 * @n<num>(直接周波数指定、0xE5)は2026-09-19実装(RD_DIRECT/LOOKUP_DIRECT/DIRACT参照)。使う曲にだけ埋め込む。
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
 *                                       bankswitch初期値で決め、ドライバは実行時に窓0しか切り替えない。
 *                                       例外はDPCMが16KB(1ページ)に収まらない曲(2026-09-10): サンプルを
 *                                       16KB=4バンクの「ページ」に分けて置き、トリガー時にそのページへ
 *                                       窓4-7($5FFC-$5FFF)をまとめて切り替える(WFV_T28、DPCM_PAGE_TBL)
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
  // 表示文言の翻訳 (src/i18n/i18n.js)。MML.I18n が無い環境(ヘッドレス等)では素通し
  const tr = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const CPU_CLOCK_NTSC = 1789773;
  const NOTE_TABLE_SIZE = 108; // 9オクターブ分(o0-o8相当)
  const TABLE_MAX = NOTE_TABLE_SIZE - 1;
  // o9 の段(o9c〜o9b、ノート番号108〜119)まで持つ表の大きさ(2026-09-19)。曲の中でそのチップが o9 の音
  // (EN・タイ・SD・PS で届く音も含む)を実際に使い、かつ o9 の値が o8b(107番)と違う表だけをこの大きさにする
  // (buildFixedSource の noteTableSize、buildBankedNsfBytes の noteReach)。o8b までの曲は108音のままで、
  // NSF は従来とバイト単位で同じ。例: AY/PSG の曲は 10kHz 前後のトーン+ノイズで打楽器を作ることがあり
  // (Metal Gear 2 のスネア: AY周期10〜11 → FME7 の o9d+/o9f)、o8b で頭打ちにすると金属的に鳴っていた。
  // index×2 は 238 で1バイト、N163 の index×3 も 357 で16bit加算の範囲に収まる。
  // 120以上・負の音符は compiler.js が鳴らさない(NOTE_TABLE_TOP)ので、表はこれ以上要らない
  const NOTE_TABLE_SIZE_WIDE = 120;
  const BANK_SIZE = 4096;
  const DATA_START_BANK = 8; // 曲データの開始バンク(0=未使用, 1-3=ドライバ本体固定, 4-7=DPCM専用)
  const DATA_DPCM_BANK = 4;  // DPCMサンプル領域の先頭窓($C000)。実機DMCの読出し範囲$C000-$FFFF
  const DPCM_PAGE_BANKS = 4; // 1ページ=16KB=4バンク(窓4-7をまとめて切り替える単位)
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

  // #TUNING(基準ピッチ、セント)の周波数比。buildBankedNsfBytes が compileResult.settings.tuningCents から
  // 設定する。compiler.js の noteFrequency と同じ比にすることでブラウザ再生とNSF書き出しの音程が一致する
  // (周波数テーブルの数値が変わるだけで、6502側のドライバコードは一切変わらない)
  // #TUNING-NOTE(音名別、compileResult.settings.tuningNotes)も compiler.js noteFrequency と同じ式で掛ける
  let tuningRatio = 1;
  let tuningNoteRatios = null;
  function noteFrequency(noteNumber) {
    const nr = tuningNoteRatios ? tuningNoteRatios[((Math.round(noteNumber) % 12) + 12) % 12] : 1;
    return 440 * Math.pow(2, (noteNumber - 57) / 12) * tuningRatio * nr;
  }
  function pulsePeriod(freq) {
    return Math.max(0, Math.min(2047, Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1));
  }
  // VRC6 パルスは同じ式で周期12bit(o0a まで出る)。compiler.js vrc6PulsePeriod と必ず一致させること
  function vrc6PulsePeriod(freq) {
    return Math.max(0, Math.min(4095, Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1));
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

  function buildPeriodTable(periodFn, size) {
    const words = [];
    for (let n = 0; n < (size || NOTE_TABLE_SIZE); n++) words.push(periodFn(noteFrequency(n)));
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
  // 心配は無い=ノート間の意味論の取り違えとは
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
  // noteBase: バイトコードの1バイト形式音符の基点(serialize に渡した chanOpts.noteBase と同じ値)
  function layoutChannelBanks(bytes, startBank, startOffset, markOffset, reserved, noteBase) {
    const banks = [];
    const boundaries = MML.NSF.MckBytecode.commandBoundaries(bytes, noteBase);
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
      let splitAt = null;
      for (const b of boundaries) {
        if (b > offset && b <= limit) splitAt = b;
        else if (b > limit) break;
      }
      if (splitAt == null) {
        // 残りにコマンドが1つも丸ごと入らない(2026-09-19)。以前は offset+1 で切っていたため、
        // 直前チャンネルの続きがバンク末尾の数バイト(例: 残り5バイトに2バイトの休符)に当たると
        // コマンドの途中でバンクジャンプが入り、ドライバがパラメータをオペコードとして読んで
        // そのチャンネルが最後まで化けていた。バンクの途中から置き始めた場合は何も置かずに
        // 次のバンクの先頭から仕切り直す(新しいバンクの先頭なら4092バイト入るので必ず境界がある)
        if (posInBank > 0) {
          bankNum = advanceBank(bankNum + 1);
          posInBank = 0;
          continue;
        }
        splitAt = offset + 1; // 保険(1コマンドが4KB近い、は起きない)
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
    // 開始位置は「実際に最初のチャンクを置いた場所」を返す(2026-09-19)。直前チャンネルの続きが
    // バンク末尾の数バイト(ジャンプマーカーも入らない残り)に当たると上のループが次のバンクの先頭へ
    // 仕切り直すので、引数の startBank/startOffset のままだと、ドライバはこのチャンネルを何も置いて
    // いないバンク末尾から読み始めていた(KSS→MMLで N163 の1chだけが最後まで無音、$8FFF 開始で発覚)
    return { banks, startBank: banks[0].bankNum, startOffset: banks[0].offset, nextFreeBank: bankNum, nextFreeOffset: posInBank, markLocation };
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
  // dpcmPageBank0(2026-09-10): DPCMページ0のファイル上バンク番号(=dpcmFileBank)。DPCM_PAGE_TBL の値
  // (ページk=dpcmPageBank0+4k)に使う。サイズ測定用の1回目アセンブルでは0でよい(テーブル長は変わらない)
  // usesDirect(2026-09-19): @n<num>(直接周波数指定、mckBytecode.js OP_DIRECT_FREQ=0xE5)が曲中で使われているか。
  // 使う曲だけ DIRACT/DIRLO/DIRHI(3byte/ch)・RD_DIRECT・各 LOOKUP_*_PERIOD 冒頭の分岐を埋め込む
  function buildFixedSource(channelTypes, songBank, expansions, envelopes, dpcmLayout, dpcmSamples, envIndexList, songLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak, usesSmooth, usesPitchShift, usesRawWrite, vrIndexList, enIndexList, dutyIndexList, usesRelTone, songAddrLo, songAddrHi, usesDetune, driverOrg, usesSweep, usesPitchSa, dpcmPageBank0, usesDirect, noteReach, noteBase, volMask4) {
    dpcmPageBank0 = dpcmPageBank0 | 0;
    usesDirect = !!usesDirect;
    // noteReach(2026-09-19): 表ごと(pulse/tri/saw/fme7/fds/n163/vrc7)に、曲が引く最大のノート索引
    // (buildBankedNsfBytes の noteReach 参照)。noteBase: バイトコードの1バイト形式音符の基点
    // (mckBytecode.js NOTE_BASE_DEFAULT/NOTE_BASE_WIDE。RD_NOTE の CMP/SBC 即値)
    noteReach = noteReach || {};
    noteBase = noteBase || MML.NSF.MckBytecode.NOTE_BASE_DEFAULT;
    // 表の大きさ: o9 の索引(108〜)まで引く曲で、しかもその値が107番(o8b)と違うときだけ120音にする。
    // 同じ値なら108音の表の上限クランプで同じ周期になるので広げない(FDS の o6a 以上=4095貼り付き、
    // VRC7 の o8g 以上=fnum 511/block 7 など。compiler.js enTableNote のコメント参照)
    // valueAt(n): ノート番号 n の表の値(比較できる数値/文字列)
    const noteTableSize = (key, valueAt) => {
      const r = noteReach[key];
      if (!(r >= NOTE_TABLE_SIZE)) return NOTE_TABLE_SIZE;
      const top = Math.min(r, NOTE_TABLE_SIZE_WIDE - 1);
      const v107 = valueAt(NOTE_TABLE_SIZE - 1);
      for (let n = NOTE_TABLE_SIZE; n <= top; n++) if (valueAt(n) !== v107) return NOTE_TABLE_SIZE_WIDE;
      return NOTE_TABLE_SIZE;
    };
    // PULSE_TABLE は 2A03 パルス・MMC5・VRC6 パルス(VRC6P_LOW_TABLE より上)で共有するので1つの大きさ
    const pulseTableSize = noteTableSize('pulse', n => pulsePeriod(noteFrequency(n)) + ',' + vrc6PulsePeriod(noteFrequency(n)));
    const triTableSize = noteTableSize('tri', n => trianglePeriod(noteFrequency(n)));
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
    // DPCMのページ数(compiler.js layoutDpcmSamples。16KB=1ページ)。2以上ならトリガーで窓4-7を切り替える
    const dpcmPageCount = dpcmIndices.reduce((m, idx) => Math.max(m, (dpcmLayout[idx].page | 0) + 1), 0);
    const usesDpcmPaging = usesDpcm && dpcmPageCount > 1;
    // N163実チャンネル数: ハードウェアは内部8ch中「上位num個」だけを巡回・ミックスするため
    // (numChannels()参照)、使用チャンネル数numN163Chを$7Fに設定し、regBaseも
    // (8-numN163Ch)+ch にオフセットする必要がある(0番から詰めると鳴らない)。
    const numN163Ch = channelTypes.filter(t => t >= TYPE_N163_BASE && t < TYPE_N163_BASE + 8).length;

    // カスタム波形・音色定義(その音源が使われている場合のみ収集。「使う時だけ組み込む」の
    // 対象範囲をチップ単位からカスタム定義の有無単位までさらに絞る)
    // 番号は0〜127だけ(音色バイト/OP<n>のバイトは bit7 が別の意味なので、それより大きい番号の音符は
    // checkBytecodeLimits がエラーにする。大きい番号の定義をCMPの表に入れると下位8bitで別の番号に一致してしまう)
    const fdsCustomWaves = usesFds ? Object.keys(envelopes.fm || {}).map(Number).filter(i => i <= 127).sort((a, b) => a - b) : [];
    const n163CustomWaves = usesN163 ? Object.keys(envelopes.n || {}).map(Number).filter(i => i <= 127).sort((a, b) => a - b) : [];
    const vrc7CustomTones = usesVrc7 ? Object.keys(envelopes.op || {}).map(Number).filter(i => i <= 127).sort((a, b) => a - b) : [];
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
    // epWide(2026-09-19): 長さ(またはループ位置)が255を超える@EPを使う曲だけEPTICKHIを足して8スロット
    // (EP_LOOKUP参照)。それ以外の曲はRAM配置もROMも従来と同じ
    const epWide = usesEp && epIndexList.some(idx => {
      const e = (envelopes.ep && envelopes.ep[idx]) || {};
      return ((e.values || []).length > 0xff) || (e.loop != null && e.loop >= 0xff);
    });
    const epExtraSlots = usesEp ? (epWide ? 8 : 7) : 0;
    // @v/@vr/@@(デューティ)/EN も同じ(2026-09-19): 長さ256以上のテーブルを使う曲だけ、その種類のtickを
    // 16bit(上位=ENVTICKHI/RELTICKHI/DUTYTICKHI/ENTICKHI)にし、LEN/LOOPに上位バイト表を足す。
    // 以前は長さが .byte で黙って下位8bitに切り詰められ(300→44)、そこで末尾扱いになっていた。
    // 使わない曲は RAM 配置も ROM も従来と同じ(スロットは下の wideBase 以降に足す)
    const tableLongerThanByte = t => (((t && t.values) || []).length > 0xff);
    const envWide = envIndexList.some(idx => tableLongerThanByte(envelopes.v && envelopes.v[idx]));
    const vrWide = vrIndexList.some(idx => tableLongerThanByte((envelopes.vr && envelopes.vr[idx]) || (envelopes.v && envelopes.v[idx])));
    const dutyWide = dutyIndexList.some(idx => tableLongerThanByte(envelopes.duty && envelopes.duty[idx]));
    const enWide = enIndexList.some(idx => tableLongerThanByte(envelopes.en && envelopes.en[idx]));
    const wideExtraSlots = (envWide ? 1 : 0) + (vrWide ? 1 : 0) + (dutyWide ? 1 : 0) + (enWide ? 1 : 0);
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
    // VRC7 は LASTHI を $20+ch のシャドウ(キー状態+block+fnum上位1bit)として常に使う(SIL_VRC7 のキーオフが
    // block/fnum を保ったまま書くため。2026-09-20)
    const freqOnlyExtraSlots = (needsLastHi || usesVrc7) ? 1 : 0;
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
    // SA<num>(N163ピッチシフト量、2026-08-26、ppmckpitch_shift_amount相当): 1byte/ch。
    // usesPitchSaの時のみ実際に使う。APPLY_DETUNE_N163のSA_ADD16参照
    const saExtraSlots = usesPitchSa ? 1 : 0;
    // LASTVOL(音量書込みスキップ用の直近値、2026-08-26): 1byte/ch。音量のみ書込み経路
    // (WRITE_VOL_ONLY=TICK_VOL_FXの継続フレーム)が存在する曲でのみ確保する。
    // 条件はusesVolOnly(下方で定義)と同一だが、ZPレイアウト計算がそれより手前に
    // あるためここで同じ式を展開する(片方だけ変更しないこと)
    const usesVolSkip = envIndexList.length > 0 || usesVr || usesDutyEnv;
    const lastVolExtraSlots = usesVolSkip ? 1 : 0;
    // @n(直接周波数指定、2026-09-19): DIRACT/DIRLO/DIRHI の3byte/ch(下の DIRACT 定義参照)
    const directExtraSlots = usesDirect ? 3 : 0;
    // NOTELEN/RESTLEN(sticky音長、2026-08-16): 直前に読んだ音符/休符の音長バイト。
    // バイトコードの1バイト形式(音長省略)がこの値を再利用する(mckBytecode.js参照)
    const totalPerChanBlocks = 11 + n163ExtraSlots + fme7ExtraSlots + epExtraSlots + mpExtraSlots +
      ptExtraSlots + enExtraSlots + freqOnlyExtraSlots + smoothExtraSlots + psExtraSlots + vrExtraSlots +
      dutyExtraSlots + detuneExtraSlots + sweepExtraSlots + envActExtraSlots + saExtraSlots + lastVolExtraSlots +
      directExtraSlots + wideExtraSlots;
    // fixedBase以降(JMPLO,JMPHI,FME7専用グローバル,CEILDIVスクラッチ,PLAYIDX)の固定個数。
    // 下のchArrayBase判定に含める(このブロックも$0100-$01FFに掛かってはいけないため)。
    // PS(2026-08-13)使用時は16bit÷8bit版CEILDIV16のスクラッチ(CDA16LO/HI)+
    // RD_PITCHSHIFT設定用スクラッチ(PSNEWNOTE/PSOLDLO/PSOLDHI)の5byteを追加する。
    // PLAYIDX(2026-08-16 最適化)はPLAYのチャンネルループカウンタ1byte(旧実装は
    // LDX #i/JSR SERVICE_CHをチャンネル数ぶんアンロールしており5byte/chを消費していた)
    // DPCMPAGE(2026-09-10、DPCMバンク切替): いま窓4-7に見せているページの先頭バンク番号(1byte)。
    // サンプルが2ページ(32KB)以上あるときだけ確保する
    // トラック終端(Lの無いチャンネルのデータの終わり、2026-09-19)。無音化したあとも SERVICE_CH は毎フレーム
    // 継続効果を進めるので、@vr のリリース(RELPLAY)や @@ のデューティエンベロープ(DUTYSEL)が残っていると
    // WRITE_VOL_ONLY がそのchの音量を書き戻し、最後の音がまた鳴り出していた(N163で曲末に音量5のまま鳴り続けた。
    // JS再生=compiler.js は曲より先に終わるchの末尾に休符を足して無音にする)。そこで終端に達したchは
    // 種別を TYPE_UNIMPLEMENTED(全ハンドラが何もしない)へ切り替え、以降レジスタへ一切書かせない
    // (ppmckcはLの無いトラックの末尾に「r(255フレーム)へのループ」を置き、休符中はエフェクトを止める)。
    // 書き戻しが起きうる曲(@vr/@@ を使う曲)だけ入れる。それ以外の曲は従来とバイト単位で同じ
    // ループ指定(mode=1)のDPCMがある曲は、全chが終端に達した(=曲が終わった)ところで DMC も止める
    // (JS再生は曲の終わりで全部止まる。E のデータが先に終わるだけなら止めない=休符と同じく鳴り切る/回り続ける)。
    // ENDCNT=まだ終端に達していないchの数
    // 全chにLがある曲は終端に達しないので入れない
    const anyChannelEnds = channelTypes.some((t, i) => t !== TYPE_UNIMPLEMENTED && loopAct[i] !== 1);
    const dpcmLoopStop = anyChannelEnds && usesDpcm && dpcmIndices.some(idx => (((dpcmSamples[idx] || {}).mode | 0) & 1) === 1);
    const endMute = anyChannelEnds && (usesVr || usesDutyEnv || dpcmLoopStop);
    const TRAILING_FIXED_SIZE = 14 + (usesPitchShift ? 5 : 0) + (usesPitchSa ? 3 : 0) + (usesDpcmPaging ? 1 : 0) + (dpcmLoopStop ? 1 : 0);
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
      EPDELAY = EPACT + 5 * n, EPDELAYSET = EPACT + 6 * n, EPTICKHI = EPACT + 7 * n;
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
    // PTACT=有効フラグ、PTSTEPHI=1ステップの増減量(符号付き16bit)の上位バイト
    // (2026-09-19まではtargetの符号拡張バイト=方向($00/$FF)だった。PTSTEPSZ参照)、
    // PTDURSET/PTDELAYSET=PT<n>選択時(RD_PORTAMENTO)に保存したduration/delayの生値、
    // PTSTEPSZ/PTSTEPINT=1ステップの増減量(符号付き16bitの下位バイト)/間隔。どちらも
    // mckBytecode.js(serialize)が compiler.js portamentoSequence と同じ式で前計算した値を
    // 0xF9のパラメータから読むだけ(以前は6502側でCEILDIVしていたが、|target|>255 や
    // target=0 で除数0の無限ループになりドライバごと止まっていた。KSS→MMLの PT-512,4 で発覚)、
    // PTDELAY=delay残りカウントダウン、PTDUR=duration残りカウントダウン(0になったら
    // 以降は何もせずPTVALLO/HIを保持=最終値の永久ホールド)、PTSTEPCNT=次のステップまでの
    // カウンタ(MPのMPADCCNT相当)、PTVALLO/PTVALHI=累積オフセット(符号付き16bit、
    // APPLY_DETUNE/APPLY_DETUNE_N163が読む)。RD_NOTEで毎音符PTDELAY/PTDUR/PTSTEPCNT/
    // PTVALLO/HIを再初期化する(EP_STEPと同じpost-increment単一ルーチン設計、off-by-one
    // バグの教訓を踏まえMP LFO_SUBのような初回/継続分離はしない)。
    const ptBase = mpBase + mpExtraSlots * n;
    const PTACT = ptBase, PTSTEPHI = ptBase + n, PTDURSET = ptBase + 2 * n,
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
    // 旧PTDIR(2026-09-19廃止)と同じ規約)、PSSTEPSZ/PSSTEPINT=RD_PITCHSHIFTでCEILDIV16により確定した
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
    // @n(直接周波数指定、2026-09-19)。DIRLO/DIRHI=指定された周期/周波数レジスタ値、DIRACT=その値で鳴らす音符か。
    // DIRACT は RD_DIRECT(0xE5)が2を入れ、続く音符の RD_NOTE_BODY が LSR で1にする(=この音符は指定値)。
    // 次の通常の音符では同じ LSR で0に戻る(OP_DIRECT_FREQ は必ず音符の直前に置かれるので2のまま残らない)。
    // LOOKUP_*_PERIOD は DIRACT≠0 なら音階テーブル(と EN の ENVAL)を使わず DIRLO/DIRHI を返す
    // (D<n>は compiler.js が @n の音符で0にしてバイトコードへ出すので、APPLY_DETUNE はそのままでよい)
    const directBase = lastVolBase + lastVolExtraSlots * n;
    const DIRACT = directBase, DIRLO = directBase + n, DIRHI = directBase + 2 * n;
    // 長いエンベロープ用のtick上位バイト(2026-09-19、上の envWide 等を参照)。使う種類だけ詰めて確保する
    const wideBase = directBase + directExtraSlots * n;
    let wideNext = wideBase;
    const takeWide = on => { if (!on) return 0; const a = wideNext; wideNext += n; return a; };
    const ENVTICKHI = takeWide(envWide), RELTICKHI = takeWide(vrWide), DUTYTICKHI = takeWide(dutyWide), ENTICKHI = takeWide(enWide);
    // fixedBaseから先はチャンネル数nと無関係な固定個数のグローバルスクラッチ(,Xインデックス
    // なし)。JMPLOはJMP間接絶対(2バイトアドレスなので物理ゼロページ外でも正しく動く)、
    // FME7専用グローバル・CEILDIV用スクラッチも通常のLDA/STA(間接アドレッシングではない)
    // なので255番地を超えても問題ない(CURLO/PERLO/PTBLLO等の物理ゼロページ必須組は
    // 既に先頭0-7番地に固定済み、このコメント直前を参照)
    const fixedBase = wideBase + wideExtraSlots * n;
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
    // DPCMPAGE: 窓4-7にいま見せているDPCMページの先頭バンク番号(usesDpcmPaging時のみ確保・参照。
    // INITで$FF=未確定にし、最初のトリガーで必ず切り替える)
    const DPCMPAGE = PLAYIDX + 1 + (usesPitchSa ? 3 : 0);
    // ENDCNT: まだトラック終端に達していないchの数(dpcmLoopStop時のみ確保・参照。上の endMute 参照)
    const ENDCNT = DPCMPAGE + (usesDpcmPaging ? 1 : 0);
    const liveChCount = channelTypes.filter(t => t !== TYPE_UNIMPLEMENTED).length;

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
    if (dpcmLoopStop) initExtra.push(`    LDA #${hex(liveChCount)}\n    STA ${hex(ENDCNT)}       ; まだ終わっていないch数(RD_ENDTRACK_STOP参照)`);
    if (usesDpcmPaging) initExtra.push(`    LDA #$FF\n    STA ${hex(DPCMPAGE)}       ; DPCMページ未確定(最初のトリガーで窓4-7を必ず切り替える)`);
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
    // 持ち(VRC7はWFO_VRC7、2026-09-19からEN以外でも)、それ以外(未使用スロット)はWFO_NONE(何もしない)を指す。ノイズ(WFO_T3)は
    // 2026-09-14から対象(ppmckもノイズ周期にEP/ENが効く。compiler.jsのノイズ経路と同じ)
    const wfoEntries = new Array(TYPE_COUNT).fill('WFO_NONE');
    if (usesFreqOnly) { wfoEntries[0] = 'WFO_T0'; wfoEntries[1] = 'WFO_T1'; wfoEntries[2] = 'WFO_T2'; wfoEntries[3] = 'WFO_T3'; }

    // ソフトウェア音量エンベロープ(@v<n>)のテーブル本体をROMへ埋め込む(実際に使われて
    // いる場合のみ)。envIndexList[i]がmckBytecode.jsのOP_VOL_ENVで参照する番号iに対応する。
    // ENV_LEN/ENV_LOOP はコンパクト番号→長さ/ループ位置($FF=ループ無し)の直接引き
    // (.byte配列)、ENV_PTRLO/ENV_PTRHI はコンパクト番号→データ本体アドレスの下位/上位の直接引き
    // (.byte配列2本。2026-09-19まではASL Aで2倍して引く.word配列だったため、テーブル数が128を
    // 超えると番号が桁あふれして別のテーブルを読んでいた。KSS→MMLで@EPが177本の曲で発覚。
    // VRENV/DUTYENV/EP/ENも同じ形)。引いたアドレスへはtickをYにして(ptr),Yで読む
    const envTableCount = envIndexList.length;
    // LEN/LOOP 表(ENV/VRENV/DUTYENV/EN/EP 共通、2026-09-19)。ループ位置が長さ以上(定義の末尾に「|」)は
    // ループ無し扱いにする(compiler.js stepEnvelope/cumulativeEnvelopeValue/pitchEnvelopeValue と同じ結果。
    // 以前はループ位置=長さをそのまま置いていたため、末尾を過ぎるとテーブルの外のバイトを読んでいた)。
    // wide(長さ256以上のテーブルがある種類)は下位/上位の2本ずつにする(ループ無しは上位$FF)
    function lenLoopTables(prefix, tables, wide) {
      const lens = tables.map(t => ((t && t.values) || []).length);
      const loops = tables.map((t, i) => (t && t.loop != null && t.loop < lens[i]) ? t.loop : (wide ? 0xffff : 0xff));
      if (!wide) return `${prefix}_LEN:\n    .byte ${lens.join(',')}\n${prefix}_LOOP:\n    .byte ${loops.join(',')}\n`;
      const lo = a => a.map(v => v & 0xff).join(','), hi = a => a.map(v => (v >> 8) & 0xff).join(',');
      return `${prefix}_LEN:\n    .byte ${lo(lens)}\n${prefix}_LENHI:\n    .byte ${hi(lens)}\n` +
        `${prefix}_LOOP:\n    .byte ${lo(loops)}\n${prefix}_LOOPHI:\n    .byte ${hi(loops)}\n`;
    }
    // @v/@vr/@@ の毎フレーム値の読み出し(X=チャンネル番号のまま呼ぶ)。sel,X のテーブルの tick,X 番目を dest,X へ書く。
    // 末尾に達したらループ位置へ戻すか(LOOP<>$FF)末尾保持(tickを1戻す。以降このtick値を比べ続けるので
    // 次フレーム以降もずっと最終値を指し続ける)。PERLO/PERHIは使い捨てスクラッチ。
    // wide: tickを16bit(上位=tickHi,X)で数え、データの読み出しアドレスの上位にも tickHi を足す
    // mask: 省略可。結果を STA する前に AND するラベル(VOLMASK,X。下記 volMask4 参照)
    const holdLookup = (label, L, P, sel, tick, tickHi, dest, wide, mask) => wide ? `
${label}:
    LDY ${hex(sel)},X
    LDA ${hex(tick)},X
    CMP ${P}_LEN,Y
    LDA ${hex(tickHi)},X
    SBC ${P}_LENHI,Y
    BCC ${L}_INBOUNDS
    LDA ${P}_LOOPHI,Y
    CMP #$FF
    BNE ${L}_DOLOOP
    LDA ${P}_LEN,Y
    SEC
    SBC #$01
    STA ${hex(tick)},X
    LDA ${P}_LENHI,Y
    SBC #$00
    STA ${hex(tickHi)},X
    JMP ${L}_INBOUNDS
${L}_DOLOOP:
    STA ${hex(tickHi)},X
    LDA ${P}_LOOP,Y
    STA ${hex(tick)},X
${L}_INBOUNDS:
    LDA ${P}_PTRLO,Y
    STA ${hex(PERLO)}
    LDA ${P}_PTRHI,Y
    CLC
    ADC ${hex(tickHi)},X
    STA ${hex(PERHI)}
    LDY ${hex(tick)},X
    LDA (${hex(PERLO)}),Y
${mask ? `    AND ${mask},X
` : ''}    STA ${hex(dest)},X
    RTS` : `
${label}:
    LDA ${hex(sel)},X
    TAY
    LDA ${hex(tick)},X
    CMP ${P}_LEN,Y
    BCC ${L}_INBOUNDS
    LDA ${P}_LOOP,Y
    CMP #$FF
    BNE ${L}_DOLOOP
    LDA ${P}_LEN,Y
    SEC
    SBC #$01
    STA ${hex(tick)},X
    JMP ${L}_INBOUNDS
${L}_DOLOOP:
    STA ${hex(tick)},X
${L}_INBOUNDS:
    LDA ${P}_PTRLO,Y
    STA ${hex(PERLO)}
    LDA ${P}_PTRHI,Y
    STA ${hex(PERHI)}
    LDY ${hex(tick)},X
    LDA (${hex(PERLO)}),Y
${mask ? `    AND ${mask},X
` : ''}    STA ${hex(dest)},X
    RTS`;
    // 16bit tick の +1(INC tick,X の直後に置く。wide でなければ何も出さない)
    const incHi = (tickHi, wide, L) => wide ? `    BNE ${L}\n    INC ${hex(tickHi)},X\n${L}:\n` : '';
    // @vr<n>の実体テーブル。ppmckの@vr<n>は@v<n>定義そのものへの参照なので、
    // 本ツール独自の@vr<n>={...}定義が無ければ@v<n>の定義へフォールバックする
    // (compiler.jsのresolveEnvTablesと同じ規則)
    const vrTableOf = idx => (envelopes.vr && envelopes.vr[idx]) || (envelopes.v && envelopes.v[idx]) || {};
    // @@<n>(デューティ=音色エンベロープ)の実体テーブル(@<n>={...}の定義)
    const dutyTableOf = idx => (envelopes.duty && envelopes.duty[idx]) || {};
    // 音量レジスタのみを書くハンドラ群(WRITE_VOL_ONLY/WFV_VOL_*)が必要かどうか。
    // @v(ソフトウェア音量エンベロープ)だけでなく、@vr(リリースエンベロープ)単独でも
    // 毎フレームの音量書き換えに使うため、どちらか一方でも使われていれば埋め込む
    const usesVolOnly = envTableCount > 0 || usesVr || usesDutyEnv;
    // volMask4(2026-09-20): 4bit音量のチャンネルが 16〜63 の値を含む @v/@vr 表を使う曲だけ、表から引いた
    // 音量を下位4bitに切る(FDS/VRC6のこぎり波は6bitのまま)。ppmckは表の値をそのままレジスタの
    // 上位ビットへ OR するので、2A03/MMC5 は下位4bit(bit4-5は$30で元々立っている)が音量になる。
    // 以前の本ドライバも 2A03/MMC5/N163 はそれと同じ結果だったが、VRC6パルスはデューティへ、FME7 は
    // エンベロープモードのビットへ漏れ、VRC7 は音量の反転計算が桁あふれしていた(ブラウザ再生は15で
    // 頭打ちにしていたので食い違っていた)。ブラウザ再生も同じく下位4bitにする(compiler.js envVolume)
    if (volMask4) {
      extraTables.push(`VOLMASK:
    .byte ${channelTypes.map(t => (t === TYPE_FDS || t === TYPE_VRC6_SAW) ? '$3F' : '$0F').join(',')}`);
    }
    if (envTableCount > 0) {
      const { ptrExprs: envPtrExprs, dataBlocks: envDataBlocks } = packEnvelopeTables(
        envIndexList, 'ENV',
        // FDS/VRC6のこぎり波は6bit音量なので63でクランプ(他chは各WFV_*が4bitマスクするか
        // レジスタ側が下位bitしか見ない。compiler.js writeVolumeEnvelopeのvolMaxと対)
        idx => ((envelopes.v[idx] || {}).values || []).map(v => Math.max(0, Math.min(63, v | 0)))
      );
      extraTables.push(
        lenLoopTables('ENV', envIndexList.map(idx => envelopes.v[idx]), envWide) +
        `ENV_PTRLO:\n    .byte ${envPtrExprs.map(e => '<' + e).join(',')}\n` +
        `ENV_PTRHI:\n    .byte ${envPtrExprs.map(e => '>' + e).join(',')}\n` +
        envDataBlocks.join('\n')
      );
      // --- ソフトウェア音量エンベロープ: X=チャンネル番号のまま呼ぶ。ENVSEL[X]/ENVTICK[X]から
      // テーブルを引き、末尾に達していたらループ位置へ戻すか(ENV_LOOP[Y]<>$FF)末尾保持
      // (ENVTICKを1戻す。以降このtick値をcompareし続けるので次フレーム以降もずっと最終値を
      // 指し続ける)、結果をVOL[X]へ書く。PERLO/PERHI/PERLO2は他の場所で使用後の
      // 使い回しスクラッチ(このルーチンの直後にWRITE_FREQ_VOLが呼ばれるだけなので安全)。
      // テーブル番号はそのままYで PTRLO/PTRHI を引く(255本まで。上のコメント参照)。
      extraHandlers.push(holdLookup('ENV_LOOKUP', 'ENVLK', 'ENV', ENVSEL, ENVTICK, ENVTICKHI, VOL, envWide, volMask4 ? 'VOLMASK' : null));
    }

    // --- @vr<n>(リリースエンベロープ、2026-08-13)のテーブル本体をROMへ埋め込む
    // (実際に使われている場合のみ)。ENV_LEN/ENV_LOOP/ENV_PTR/ENV_DATA_*と全く同じ
    // 構造をVR接頭辞で並行して持つ(@vと同じ0-15クランプ値)。実際のレジスタ書込みは
    // 既存のWRITE_VOL_ONLY(WFV_VOL_JUMPTABLE)をそのまま再利用するため、専用の
    // WRITE_*ジャンプテーブルは不要でREL_LOOKUP(ENV_LOOKUPの並行実装)だけを追加する ---
    const vrTableCount = vrIndexList.length;
    if (vrTableCount > 0) {
      const { ptrExprs: vrPtrExprs, dataBlocks: vrDataBlocks } = packEnvelopeTables(
        vrIndexList, 'VRENV',
        idx => (vrTableOf(idx).values || []).map(v => Math.max(0, Math.min(63, v | 0)))
      );
      extraTables.push(
        lenLoopTables('VRENV', vrIndexList.map(vrTableOf), vrWide) +
        `VRENV_PTRLO:\n    .byte ${vrPtrExprs.map(e => '<' + e).join(',')}\n` +
        `VRENV_PTRHI:\n    .byte ${vrPtrExprs.map(e => '>' + e).join(',')}\n` +
        vrDataBlocks.join('\n')
      );
      // --- リリースエンベロープ: X=チャンネル番号のまま呼ぶ。VRSEL[X]/RELTICK[X]から
      // テーブルを引き(ENV_LOOKUPと全く同じロジック)、結果をVOL[X]へ書く。
      // 呼び出し元(RD_REST/SERVICE_CH)がこの直後にWRITE_VOL_ONLYを呼んで実際の
      // レジスタへ反映する ---
      extraHandlers.push(holdLookup('REL_LOOKUP', 'RELLK', 'VRENV', VRSEL, RELTICK, RELTICKHI, VOL, vrWide, volMask4 ? 'VOLMASK' : null));
    }

    // --- @@<n>(デューティ=音色エンベロープ、2026-08-15)のテーブル本体をROMへ埋め込む
    // (実際に使われている場合のみ)。ENV_*/VRENV_*と全く同じ構造をDUTYENV接頭辞で持つ
    // (値は実機ppmckのgetTone同様0-7へクランプ)。レジスタ書込みは音量と同じ
    // WRITE_VOL_ONLY(デューティは音量レジスタに同居する)をそのまま再利用するので、
    // DUTY_LOOKUP(ENV_LOOKUPの並行実装、結果をDUTY[X]へ書く)だけを追加する ---
    if (usesDutyEnv) {
      const { ptrExprs: dutyPtrExprs, dataBlocks: dutyDataBlocks } = packEnvelopeTables(
        dutyIndexList, 'DUTYENV',
        idx => (dutyTableOf(idx).values || []).map(v => Math.max(0, Math.min(7, v | 0)))
      );
      extraTables.push(
        lenLoopTables('DUTYENV', dutyIndexList.map(dutyTableOf), dutyWide) +
        `DUTYENV_PTRLO:\n    .byte ${dutyPtrExprs.map(e => '<' + e).join(',')}\n` +
        `DUTYENV_PTRHI:\n    .byte ${dutyPtrExprs.map(e => '>' + e).join(',')}\n` +
        dutyDataBlocks.join('\n')
      );
      extraHandlers.push(holdLookup('DUTY_LOOKUP', 'DUTYLK', 'DUTYENV', DUTYSEL, DUTYTICK, DUTYTICKHI, DUTY, dutyWide));
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
${dutyWide ? `    STA ${hex(DUTYTICKHI)},X\n` : ''}
    JMP DUTY_LOOKUP` : ''}`);
    }

    // --- EP<n>(ピッチエンベロープ)。@v(ソフトウェア音量エンベロープ)と全く同じ「使われている
    // インデックスだけをコンパクトに詰める」方式(epIndexList/pitchEnvIndexRemap、
    // buildBankedNsfBytes参照)。値は符号付きbyte(-128〜127)でMath.max/minの0-15クランプは
    // 行わない点がENV_LEN/ENV_DATAと異なる ---
    const epTableCount = epIndexList.length;
    if (epTableCount > 0) {
      const { ptrExprs: epPtrExprs, dataBlocks: epDataBlocks } = packEnvelopeTables(
        epIndexList, 'EP',
        idx => ((envelopes.ep[idx] || {}).values || []).map(v => Math.max(-128, Math.min(127, v | 0)) & 0xff)
      );
      // epWide(長さ256以上の@EPがある曲だけ): 長さ/ループ位置を下位/上位の2本ずつにする
      // (ループ無しは上位$FF。EP_LOOKUP参照)。ループ位置が長さ以上(末尾の「|」)はループ無し=末尾値を
      // 足し続ける(compiler.js pitchEnvelopeValue がループ位置を末尾にするのと同じ結果)
      extraTables.push(
        lenLoopTables('EP', epIndexList.map(idx => envelopes.ep[idx]), epWide) +
        `EP_PTRLO:\n    .byte ${epPtrExprs.map(e => '<' + e).join(',')}\n` +
        `EP_PTRHI:\n    .byte ${epPtrExprs.map(e => '>' + e).join(',')}\n` +
        epDataBlocks.join('\n')
      );
      // --- EP<n>: X=チャンネル番号のまま呼ぶ。ENV_LOOKUPと全く同じテーブル探索
      // (EPSEL[X]/EPTICK[X]からEP_LEN/EP_LOOPを引き、末尾ならループか末尾値の繰り返し)だが、
      // 結果を0-15にクランプするVOL[X]書込みではなく、符号付きbyteを16bitへ符号拡張して
      // ★累積値EPVALLO/EPVALHI[X]へ足し込む(APPLY_DETUNE/APPLY_DETUNE_N163が読む)。
      // 2026-09-13修正: ppmck(sounddrv.h sound_pitch_enverope→freq_add_mcknumber)は
      // テーブル値を「現在のレジスタ値」へ毎フレーム加減算する累積方式(compiler.js
      // pitchEnvelopeValue参照)。以前は@v同様に値を毎フレーム読み直す絶対方式でppmckと違っていた。
      // 「|」無しのテーブルは末尾値を繰り返し足し続ける(ppmckc checkLoopが末尾1値の前に
      // ループ点を差し込むのと同じ結果。末尾が0なら止まる)。累積値はRD_NOTEで0へ戻す。
      // ENVAL(EN_STEP)と同じ考え方だが、EPは16bit幅なので2バイトの符号付き加算になる。
      // PERLO/PERHI/PERLO2はENV_LOOKUPと同じ理由で使い回しスクラッチ(このルーチンの
      // 呼び出し元は直後に周期テーブル参照でこれらを上書きするだけなので安全)。
      // epWide(2026-09-19): 長さ256以上の@EPがある曲だけ、EPTICKを16bit(上位=EPTICKHI)にして
      // EP_LEN/EP_LOOPも上位バイト表を持つ。ppmckはエンベロープを16bitポインタで進めるので
      // 定義の長さに上限が無い(ppmckc datamake.c のテーブルは1024値)。以前は長さが8bitに
      // 切り詰められ(372→116)、そこで末尾扱いになって音程の揺れが止まっていた ---
      extraHandlers.push(`${epWide ? `
EP_LOOKUP:
    LDY ${hex(EPSEL)},X
    LDA ${hex(EPTICK)},X
    CMP EP_LEN,Y
    LDA ${hex(EPTICKHI)},X
    SBC EP_LENHI,Y
    BCC EPLK_INBOUNDS
    LDA EP_LOOPHI,Y
    CMP #$FF
    BNE EPLK_DOLOOP
    LDA EP_LEN,Y
    SEC
    SBC #$01
    STA ${hex(EPTICK)},X
    LDA EP_LENHI,Y
    SBC #$00
    STA ${hex(EPTICKHI)},X
    JMP EPLK_INBOUNDS
EPLK_DOLOOP:
    STA ${hex(EPTICKHI)},X
    LDA EP_LOOP,Y
    STA ${hex(EPTICK)},X
EPLK_INBOUNDS:` : `
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
EPLK_INBOUNDS:`}
    LDA EP_PTRLO,Y
    STA ${hex(PERLO)}
    LDA EP_PTRHI,Y
${epWide ? `    CLC
    ADC ${hex(EPTICKHI)},X
` : ''}    STA ${hex(PERHI)}
    LDY ${hex(EPTICK)},X
    LDA (${hex(PERLO)}),Y
    STA ${hex(PERLO)}         ; 今回の差分(符号付きbyte)。PERLOはこの後どうせ上書きされるスクラッチ
    BPL EPLK_POS
    LDA #$FF
    JMP EPLK_ADD
EPLK_POS:
    LDA #$00
EPLK_ADD:
    STA ${hex(PERHI)}         ; 符号拡張した上位バイト
    CLC
    LDA ${hex(EPVALLO)},X
    ADC ${hex(PERLO)}
    STA ${hex(EPVALLO)},X
    LDA ${hex(EPVALHI)},X
    ADC ${hex(PERHI)}
    STA ${hex(EPVALHI)},X
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
${epWide ? `    BNE EP_STEP_NOHI
    INC ${hex(EPTICKHI)},X
EP_STEP_NOHI:
` : ''}    RTS`);
    }

    // --- EN<n>(ノートエンベロープ=高速アルペジオ、2026-08-14)。EPと同じ「使われている
    // インデックスだけをコンパクトに詰める」方式(enIndexList/noteEnvIndexRemap、
    // buildBankedNsfBytes参照)。値は符号付きbyte(-128〜127、EP_DATAと同じ範囲)。
    // EP_LOOKUP(2026-09-13以降は同じ累積方式)と同様、前回の
    // 累積値(ENVAL,X)へ今回ぶんの差分を足し込む方式(compiler.jsのcumulativeEnvelopeValue
    // が「values[0..tick]の総和」であることの、フレームごとの逐次計算版) ---
    const enTableCount = enIndexList.length;
    if (enTableCount > 0) {
      const enDataLabels = enIndexList.map((idx, i) => `EN_DATA_${i}`);
      const enDataBlocks = enIndexList.map((idx, i) => {
        // 値は下位8bitをそのまま置く(2026-09-19)。ENVAL は8bitで足し続け、ノート番号との和の bit7 で負と見なす
        // ので、compiler.js enTableNote(累積値を256で割った余りで扱う)と -128〜127 の外でも同じ結果になる。
        // 以前は -128〜127 に切り詰めていたため、それを超える値でJS再生と食い違った
        const values = ((envelopes.en[idx] || {}).values || []).map(v => (v | 0) & 0xff);
        return `EN_DATA_${i}:\n${bytesToDb(new Uint8Array(values))}`;
      });
      extraTables.push(
        lenLoopTables('EN', enIndexList.map(idx => envelopes.en[idx]), enWide) +
        `EN_PTRLO:\n    .byte ${enDataLabels.map(e => '<' + e).join(',')}\n` +
        `EN_PTRHI:\n    .byte ${enDataLabels.map(e => '>' + e).join(',')}\n` +
        enDataBlocks.join('\n')
      );
      // --- EN<n>: X=チャンネル番号のまま呼ぶ。テーブル探索自体はEP_LOOKUPと同型
      // (ENSEL[X]/ENTICK[X]からEN_LEN/EN_LOOPを引く)だが、末尾に達し「ループ無し」なら
      // それ以上は何もせず現状の累積値を保持したまま抜ける(compiler.js側の「非ループは
      // 最終累積値を永久ホールド」と同じ意味。★ppmckは末尾の差分を足し続ける
      // (ppmckc checkLoop)ので、ENのこの頭打ちはppmckと違う既知の差。EPは2026-09-13に
      // ppmck準拠(末尾値を足し続ける、EP_LOOKUP参照)へ直した)。ループ有りなら末尾を過ぎた分は
      // ENTICKをループ開始位置へ巻き戻してから通常通り加算する ---
      // enWide(長さ256以上のENがある曲だけ): ENTICKを16bit(上位=ENTICKHI)で数える(EP_LOOKUPのepWideと同じ)
      extraHandlers.push(`
EN_STEP:
    LDA ${hex(ENACT)},X
    BEQ EN_STEP_DONE
${enWide ? `    LDY ${hex(ENSEL)},X
    LDA ${hex(ENTICK)},X
    CMP EN_LEN,Y
    LDA ${hex(ENTICKHI)},X
    SBC EN_LENHI,Y
    BCC ENLK_ADD
    LDA EN_LOOPHI,Y
    CMP #$FF
    BEQ EN_STEP_DONE
    STA ${hex(ENTICKHI)},X
    LDA EN_LOOP,Y
    STA ${hex(ENTICK)},X
ENLK_ADD:
    LDA EN_PTRLO,Y
    STA ${hex(PERLO)}
    LDA EN_PTRHI,Y
    CLC
    ADC ${hex(ENTICKHI)},X
    STA ${hex(PERHI)}` : `    LDA ${hex(ENSEL)},X
    TAY
    LDA ${hex(ENTICK)},X
    CMP EN_LEN,Y
    BCC ENLK_ADD
    LDA EN_LOOP,Y
    CMP #$FF
    BEQ EN_STEP_DONE
    STA ${hex(ENTICK)},X
ENLK_ADD:
    LDA EN_PTRLO,Y
    STA ${hex(PERLO)}
    LDA EN_PTRHI,Y
    STA ${hex(PERHI)}`}
    LDY ${hex(ENTICK)},X
    LDA (${hex(PERLO)}),Y
    CLC
    ADC ${hex(ENVAL)},X
    STA ${hex(ENVAL)},X
    INC ${hex(ENTICK)},X
${enWide ? `    BNE EN_STEP_DONE
    INC ${hex(ENTICKHI)},X
` : ''}EN_STEP_DONE:
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
    // MP(warizan_start)だけが使う(2026-09-19まではポルタメントのRD_PORTAMENTOも共有していたが、
    // PTの増減量/間隔はmckBytecode.jsが前計算するようになった。RD_PORTAMENTO参照)。
    if (mpTableCount > 0) {
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
    // 音程方向テーブル PITCH_DIR_TABLE(compiler.jsのperiodFnIncreasing/pitchRegDir相当。実機の
    // freq_vector_table)。CHTYPEをキーにした固定.byte配列: 周期レジスタ系(2A03パルス/三角・
    // VRC6・MMC5・FME7、値が下がるほど音程が上がる)とノイズ(周期index、小さいほど高い)は$FF、
    // 周波数レジスタ系(FDS/N163、値が上がるほど音程が上がる)は$01。用途は2つ:
    //  ・LFO_SUB: MPの初期方向(「最初に音程が上がる」向き)
    //  ・APPLY_DETUNE: D/EP/PTの符号(MML上は全音源「正=音程が上がる」なので、$FFの
    //    チップではレジスタから減算する。2026-09-14統一)
    // VRC7のfnumも周波数レジスタ系なので$01(2026-09-19、VRC7_PITCH参照。VRC7を使わない曲は従来どおり$FFのまま
    // =バイト単位で同じ)。未使用スロットは$FFで埋めるが参照されない
    if (usesMp || usesAnyPitchOffset) {
      const pitchDirTable = new Array(TYPE_COUNT).fill(0xff);
      pitchDirTable[TYPE_FDS] = 0x01;
      for (let ch = 0; ch < N163_CHANNEL_COUNT; ch++) pitchDirTable[TYPE_N163_BASE + ch] = 0x01;
      if (usesVrc7) for (let ch = 0; ch < 6; ch++) pitchDirTable[TYPE_VRC7_BASE + ch] = 0x01;
      extraTables.push(`PITCH_DIR_TABLE:\n${bytesToDb(new Uint8Array(pitchDirTable))}`);
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

    // --- PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC)。ppmck
    // ドキュメント(doc/mck.txt)に専用コマンドが無く「ピッチエンベロープ(EP)で
    // 代用してください」と明記されているため、このツール独自の拡張。compiler.jsの
    // portamentoSequence(MPのwarizan_start片道版・反転無し)と同一アルゴリズムを
    // フレームごとの状態遷移として移植する。1ステップの増減量(符号付き16bit)/間隔/
    // duration/delayはバイトコード上に直接の即値として乗る(EP/MPのようなROM共有テーブルは
    // 無い。増減量と間隔はmckBytecode.jsがportamentoSequenceと同じ式で前計算済み) ---
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
    ; 増減量は符号付き16bit(PTSTEPSZ=下位/PTSTEPHI=上位)なので方向で分岐せず足すだけ
    LDA ${hex(PTVALLO)},X
    CLC
    ADC ${hex(PTSTEPSZ)},X
    STA ${hex(PTVALLO)},X
    LDA ${hex(PTVALHI)},X
    ADC ${hex(PTSTEPHI)},X
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
; 同じ「while(rem>0){q++;rem-=b}」=ceil(a/b))。qが255以上なら255で打ち切る(PSSTEPSZ/
; PSSTEPINTが1byteのため。実用上は音程差がここまで極端に大きくなることは無い)。b=0はa>0なら255、a=0なら0
; (旧減算ループと同じ値)。
; ★2026-09-20: 旧実装は1回引くごとに1周する減算ループで、差分が0(同じ音への PS)や1の時は
;   255周=約9000サイクルかかった。3ch同時に PS が始まると1フレーム(29780サイクル)に収まらず
;   NSFだけ全chが1フレーム遅れていた(syn/ps_hi.mml で実測)。16回固定の筆算(桁ごとの引き戻し除算)に
;   置き換え、floor((a+b-1)/b) で同じ値を約450サイクルで出す。
; 戻り値=A(0-255)。${hex(CDA16LO)}/${hex(CDA16HI)}は呼び出し後に破壊される。Yも壊す ---
CEILDIV16:
    LDA ${hex(CDB)}
    BEQ CEILDIV16_BZERO
    SEC
    SBC #$01               ; A=b-1(キャリーは立ったまま)
    CLC
    ADC ${hex(CDA16LO)}
    STA ${hex(CDA16LO)}
    BCC CEILDIV16_NOCARRY
    INC ${hex(CDA16HI)}
CEILDIV16_NOCARRY:
    LDA #$00               ; A=余り
    LDY #$10
CEILDIV16_LOOP:
    ASL ${hex(CDA16LO)}    ; 被除数を1桁送り、空いた最下位ビットへ商を立てる
    ROL ${hex(CDA16HI)}
    ROL A
    BCS CEILDIV16_SUB      ; 余りが8bitからあふれた=bより大きい(キャリー=1のままSBCで正しく引ける)
    CMP ${hex(CDB)}
    BCC CEILDIV16_NEXT
CEILDIV16_SUB:
    SBC ${hex(CDB)}
    INC ${hex(CDA16LO)}
CEILDIV16_NEXT:
    DEY
    BNE CEILDIV16_LOOP
    LDA ${hex(CDA16HI)}
    BNE CEILDIV16_SAT
    LDA ${hex(CDA16LO)}
    RTS
CEILDIV16_BZERO:
    LDA ${hex(CDA16LO)}
    ORA ${hex(CDA16HI)}
    BEQ CEILDIV16_RET
CEILDIV16_SAT:
    LDA #$FF
CEILDIV16_RET:
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
      const sawTableSize = noteTableSize('saw', n => sawPeriod(noteFrequency(n)));
      extraTables.push(`SAW_TABLE:\n${wordsToDb(buildPeriodTable(sawPeriod, sawTableSize))}`);
      // VRC6 パルスの周期表。2A03 の PULSE_TABLE(11bit)と違うのは A1 未満で2047に貼り付いている低音側だけなので、
      // その区間(VRC6P_LOW_TABLE)だけを持ち、残りは PULSE_TABLE を共有する(ROM 節約。#TUNING で区間の長さは変わる)。
      // ★2026-09-14まで VRC6 パルスも PULSE_TABLE を引いていて、A1 より下が A1 に貼り付いていた
      const pulseWords = buildPeriodTable(pulsePeriod, pulseTableSize), vrc6pWords = buildPeriodTable(vrc6PulsePeriod, pulseTableSize);
      let vrc6pLow = 0;
      while (vrc6pLow < pulseTableSize && vrc6pWords[vrc6pLow] !== pulseWords[vrc6pLow]) vrc6pLow++;
      // 念のため: 区間より上がすべて一致しなければ全音ぶんの表を持つ
      if (vrc6pWords.some((w, i) => i >= vrc6pLow && w !== pulseWords[i])) vrc6pLow = pulseTableSize;
      const lookupVrc6p = vrc6pLow ? 'LOOKUP_VRC6P_PERIOD' : 'LOOKUP_PULSE_PERIOD';
      if (vrc6pLow) {
        extraTables.push(`VRC6P_LOW_TABLE:\n${wordsToDb(vrc6pWords.slice(0, vrc6pLow))}`);
        extraHandlers.push(`
; --- VRC6パルスの周期参照: ノート番号が ${vrc6pLow} 未満なら VRC6P_LOW_TABLE(12bit)、以上は PULSE_TABLE を共有 ---
LOOKUP_VRC6P_PERIOD:
${usesDirect ? `    LDA ${hex(DIRACT)},X
    BEQ LVP_TBL
    JMP LOOKUP_DIRECT
LVP_TBL:` : ''}
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LVP_NONNEG
    LDA #$00
    JMP LVP_INDEX
LVP_NONNEG:` : ''}
    CMP #${hex(pulseTableSize - 1)}
    BCC LVP_OK
    LDA #${hex(pulseTableSize - 1)}
LVP_OK:
LVP_INDEX:
    ASL A
    TAY
${vrc6pLow < pulseTableSize ? `    CPY #${hex(vrc6pLow * 2)}
    BCS LVP_SHARED
` : ''}    LDA VRC6P_LOW_TABLE,Y
    STA ${hex(PERLO)}
    LDA VRC6P_LOW_TABLE+1,Y
    STA ${hex(PERHI)}
    RTS
${vrc6pLow < pulseTableSize ? `LVP_SHARED:
    LDA PULSE_TABLE,Y
    STA ${hex(PERLO)}
    LDA PULSE_TABLE+1,Y
    STA ${hex(PERHI)}
    RTS` : ''}`);
      }
      extraHandlers.push(`
LOOKUP_SAW_PERIOD:
${usesDirect ? `    LDA ${hex(DIRACT)},X
    BEQ LSP_TBL
    JMP LOOKUP_DIRECT
LSP_TBL:` : ''}
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LSP_NONNEG
    LDA #$00
    JMP LSP_INDEX
LSP_NONNEG:` : ''}
    CMP #${hex(sawTableSize - 1)}
    BCC LSP_OK
    LDA #${hex(sawTableSize - 1)}
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
    JSR ${lookupVrc6p}
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
    JSR ${lookupVrc6p}
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

; --- VRC6矩形波(サウ) ($B000)。音量(0-63)をそのまま蓄積レートへ(ppmck同様) ---
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
    JSR ${lookupVrc6p}
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
    JSR ${lookupVrc6p}
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
      const fme7TableSize = noteTableSize('fme7', n => fme7Period(noteFrequency(n)));
      extraTables.push(`FME7_TABLE:\n${wordsToDb(buildPeriodTable(fme7Period, fme7TableSize))}`);
      extraHandlers.push(`
LOOKUP_FME7_PERIOD:
${usesDirect ? `    LDA ${hex(DIRACT)},X
    BEQ LFP_TBL
    JMP LOOKUP_DIRECT
LFP_TBL:` : ''}
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LFP_NONNEG
    LDA #$00
    JMP LFP_INDEX
LFP_NONNEG:` : ''}
    CMP #${hex(fme7TableSize - 1)}
    BCC LFP_OK
    LDA #${hex(fme7TableSize - 1)}
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
      const fdsTableSize = noteTableSize('fds', n => fdsPeriod(noteFrequency(n)));
      extraTables.push(`FDS_TABLE:\n${wordsToDb(buildPeriodTable(fdsPeriod, fdsTableSize))}\nFDS_WAVE_DATA:\n${bytesToDb(new Uint8Array(wave))}`);
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
${fdsReload}${usesDirect ? `    LDA ${hex(DIRACT)},X   ; @n: 指定値(周波数レジスタ12bit)をそのまま使う
    BEQ WFV13_TBL
    JSR LOOKUP_DIRECT
    JMP WFV13_DIRDONE
WFV13_TBL:
` : ''}    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFV13_NONNEG
    LDA #$00
    JMP WFV13_INDEX
WFV13_NONNEG:` : ''}
    CMP #${hex(fdsTableSize - 1)}
    BCC WFV13_OK
    LDA #${hex(fdsTableSize - 1)}
WFV13_OK:
WFV13_INDEX:
    ASL A
    TAY
    LDA FDS_TABLE,Y
    STA ${hex(PERLO)}
    LDA FDS_TABLE+1,Y
    STA ${hex(PERHI)}
${usesDirect ? 'WFV13_DIRDONE:' : ''}
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
${usesDirect ? `    LDA ${hex(DIRACT)},X   ; @n: WFV_T13と同じ
    BEQ WFO13_TBL
    JSR LOOKUP_DIRECT
    JMP WFO13_DIRDONE
WFO13_TBL:
` : ''}    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFO13_NONNEG
    LDA #$00
    JMP WFO13_INDEX
WFO13_NONNEG:` : ''}
    CMP #${hex(fdsTableSize - 1)}
    BCC WFO13_OK
    LDA #${hex(fdsTableSize - 1)}
WFO13_OK:
WFO13_INDEX:
    ASL A
    TAY
    LDA FDS_TABLE,Y
    STA ${hex(PERLO)}
    LDA FDS_TABLE+1,Y
    STA ${hex(PERHI)}
${usesDirect ? 'WFO13_DIRDONE:' : ''}
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
      // 波形長ごとの表はクランプ(WFV_N163/WFO_N163)を共有するので、どれか1つでも o9 の値が違えば全部広げる
      const n163TableSize = noteTableSize('n163', n => n163LengthsUsed.map(L => n163FreqReg(noteFrequency(n), L, numN163Ch)).join(','));
      const n163TableBlocks = n163LengthsUsed.map(L => {
        const words3 = [];
        for (let noteN = 0; noteN < n163TableSize; noteN++) {
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
; --- N163周波数テーブル読み出し(共用): A=ノート索引(0-${n163TableSize - 1})、X=チャンネル番号。
; PERLO/PERHI/PERLO2 <- テーブル3バイト(freq lo / freq mid / lenByte|freq hi)。
; ポインタ=テーブル先頭+ノート×3(16bit)。Xは温存、Yは破壊 ---
N163_TBL_LOOKUP:
    STA ${hex(PERLO)}
    ASL A                   ; ノート×2(最大238、C=0)
    ADC ${hex(PERLO)}       ; ノート×3(最大357、C=9bit目)
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
    CMP #${hex(n163TableSize - 1)}
    BCC WFVN163_OK
    LDA #${hex(n163TableSize - 1)}
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
    CMP #${hex(n163TableSize - 1)}
    BCC WFON163_OK
    LDA #${hex(n163TableSize - 1)}
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
    JSR SA_ADD16           ; D<n>をSAAMT,X回左シフトして加算(SA<num>、ppmck仕様)
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
; PERLO/PERHI/PERLO2へ加算する(ppmcksounddrv.h freq_add_mcknumber_with_aslの
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
      const vrc7TableSize = noteTableSize('vrc7', n => { const { fnum, block } = vrc7FnumBlock(noteFrequency(n)); return fnum + ',' + block; });
      const words2 = [];
      for (let noteN = 0; noteN < vrc7TableSize; noteN++) {
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
    CMP #${hex(vrc7TableSize - 1)}
    BCC WFVVRC7_OK
    LDA #${hex(vrc7TableSize - 1)}
WFVVRC7_OK:
WFVVRC7_INDEX:
    ASL A
    TAY
    LDA VRC7_TABLE,Y
    STA ${hex(PERLO)}
    LDA VRC7_TABLE+1,Y
    STA ${hex(PERHI)}
${usesAnyPitchOffset ? `    JSR VRC7_PITCH
` : ''}    LDA VRC7_SEL1,X
    STA $9010
    LDA ${hex(PERLO)}
    STA $9030
    ; ★キーオン(bit4)はYM2413実機同様0→1のエッジトリガ(src/emulator/expansion/vrc7.js
    ; slotOn)。前の音符がフルゲートで直前まで鳴っていた場合、単にbit4=1を書くだけでは
    ; エッジが起きず2音目以降が再アタックしない(compiler.js segmentsToWriteLogVrc7・
    ; ppmckvrc7.h vrc7_oto_set→vrc7_key_offと同じく、必ずキーオフを1回挟んでから
    ; キーオンを書く。2026-08-16、6502側だけこの修正が漏れていた=実機相当エミュで
    ; c4 d4 e4 のRMSが減衰し続けることを実測)。$9010のアドレスラッチは保持されるので
    ; 2回の$9030データ書込みの間で$9010を再選択する必要は無い
    LDA VRC7_SEL2,X
    STA $9010
    LDA ${hex(PERHI)}
    STA $9030
    ORA #$10
    STA ${hex(LASTHI)},X   ; VRC7ではLASTHI=直近の$20+ch書込値(キー状態シャドウ、WFO_VRC7/SIL_VRC7参照)
    STA $9030
${usesVolOnly ? 'WFV_VOL_VRC7:           ; @v/@vr の毎フレーム音量もここ(音色 DUTY,X と音量 VOL,X を$30+chへ)\n' : ''}VRC7_TONEVOL:
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
; --- 休符/ゲートオフ/曲末のキーオフ(2026-09-20): $20+ch へ「直近の値(LASTHI)からキーオンのbitだけ落とした値」を書く。
; block/fnum は変えず、$30+ch(音色/音量)も書かない=余韻はその音の音色・音量・音程のまま減衰する
; (ppmck vrc7.h vrc7_key_off と同じ。2026-09-20までは$20+ch/$30+chとも0を書いており、余韻の途中で
; block0・音色0・最大音量へ切り替わっていた)。既にキーオフ中なら書かない(compiler.js segmentsToWriteLogVrc7 の keyOff と同じ)。
; @@r<n> のゲートオフだけは先に音色(APPLY_REL_TONE で DUTY,X へ入った番号)と音量を$30+chへ書く(余韻をリリース音色で鳴らす)。
; RELTONE,X が有効な間は休符でも同じ値を書き直すが、レジスタの値は変わらない ---
SIL_VRC7:
${usesToneState ? `    LDA ${hex(RELTONE)},X
    CMP #$FF
    BEQ SILVRC7_KOFF
    JSR VRC7_TONEVOL
SILVRC7_KOFF:
` : ''}    LDA ${hex(LASTHI)},X
    AND #$EF
    CMP ${hex(LASTHI)},X
    BEQ SILVRC7_END
    STA ${hex(LASTHI)},X
    LDY VRC7_SEL2,X
    STY $9010
    STA $9030
SILVRC7_END:
    RTS`);
      // @v/@vr の毎フレーム音量(2026-09-20。それまでVRC7はWFV_VOL_NONEで、@vは音符頭の1値だけだった)は WFV_VRC7 末尾の
      // WFV_VOL_VRC7 ラベル。VOL,X は既にレジスタ値(減衰値。buildBankedNsfBytes の vrc7RegisterView が表ごと反転済み)なので
      // そのまま音色(DUTY,X)と合わせて$30+chへ書く(compiler.js segmentsToWriteLogVrc7 の writeVolumeEnvelope と同じ)
      if (usesAnyPitchOffset) {
        vrc7Handlers.push(`
; --- VRC7: D/EP/MP/PT(APPLY_DETUNE)をfnum(9bit)へ足す(2026-09-19)。blockは変えず、0〜511でクランプする
; (compiler.js segmentsToWriteLogVrc7 の applyDetune(fnum, pitchRegisterOffset(...), 511) と同じ。向きは
; PITCH_DIR_TABLE=$01=加算)。入力/出力: PERLO=fnum下位、PERHI=(block<<1)|fnum上位1bit(VRC7_TABLEの形)。
; PERLO2 は使い捨てスクラッチ(blockの控え) ---
VRC7_PITCH:
    LDA ${hex(PERHI)}
    AND #$0E
    STA ${hex(PERLO2)}
    LDA ${hex(PERHI)}
    AND #$01
    STA ${hex(PERHI)}
    JSR APPLY_DETUNE
    LDA ${hex(PERHI)}
    CMP #$02
    BCC VRC7P_OK
    LDA #$FF
    STA ${hex(PERLO)}
    LDA #$01
    STA ${hex(PERHI)}
VRC7P_OK:
    ORA ${hex(PERLO2)}
    STA ${hex(PERHI)}
    RTS`);
      }
      if (usesFreqOnly) {
        // VRC7のEN/EP/MP/PT/PS/タイの異音程の継続フレーム専用(fnum/blockのみ再計算・再書込み。音量/音色・
        // キーオンのトグルは行わない=既に鳴っている音符のフレーム継続のため、
        // $20+ch書込みは常にkeyonビット(0x10)を立てたまま送ってエッジを再発生させない
        // (src/mml/compiler.js segmentsToWriteLogVrc7のEN継続ループと同じ理由)。
        // 2026-09-19まではVRC7はD/EP/MP/PT非対応でENのときだけこれを入れていた(今はfnumへ足す。VRC7_PITCH参照)。
        // ★2026-08-16修正: 休符/ゲートオフ中(SIL_VRC7がキーオフ済み)は
        // 何も書かない。RD_RESTはENACTを維持する設計(EP/MP/PTと同じ、RD_RESTのコメント
        // 参照)のためSERVICE_CHは休符中もここを呼び続けるが、旧実装は無条件に
        // keyonビット付きで$20+chを書いていたため、キーオフ直後のフレームで0→1エッジが
        // 再発生し休符中に再発音(音色0/音量0)し、しかも次の音符のWFV_VRC7が「既にキーオン中」
        // でエッジを起こせず再アタックしないという二重の実バグだった(JS参照実装との
        // 毎フレームレジスタ突き合わせで発覚)。キー状態はLASTHI,X(他チップでは
        // 「位相リセット副作用のある上位バイトの直近書込値」、VRC7では$20+chの直近書込値=
        // bit4がキー状態)で判定する。ppmckvrc7.hの vrc7_do_effect(rest_flagで全効果
        // スキップ)/sound_vrc7_write(vrc7_key_statをOR)と同じ設計・compiler.jsの
        // 「gateFrames以降はEN書込みをしない」と同じ結果になる。
        // usesFreqOnly ⇒ needsLastHi なのでLASTHIは必ず確保されている
        vrc7Handlers.push(`
WFO_VRC7:
    LDA ${hex(LASTHI)},X
    AND #$10
    BNE WFOVRC7_KEYED
    RTS
WFOVRC7_KEYED:
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL WFOVRC7_NONNEG
    LDA #$00
    JMP WFOVRC7_INDEX
WFOVRC7_NONNEG:
` : ''}    CMP #${hex(vrc7TableSize - 1)}
    BCC WFOVRC7_OK
    LDA #${hex(vrc7TableSize - 1)}
WFOVRC7_OK:
WFOVRC7_INDEX:
    ASL A
    TAY
    LDA VRC7_TABLE,Y
    STA ${hex(PERLO)}
    LDA VRC7_TABLE+1,Y
    STA ${hex(PERHI)}
${usesAnyPitchOffset ? `    JSR VRC7_PITCH
` : ''}    LDA VRC7_SEL1,X
    STA $9010
    LDA ${hex(PERLO)}
    STA $9030
    LDA VRC7_SEL2,X
    STA $9010
    LDA ${hex(PERHI)}
    ORA #$10
    STA ${hex(LASTHI)},X   ; block/fnum上位もシャドウへ(SIL_VRC7 のキーオフがこの値を使う。2026-09-20)
    STA $9030
    RTS`);
      }
      // ジャンプテーブルは6チャンネル(TYPE 22-27)全てが同じ共用ルーチンを指す
      for (let ch = 0; ch < 6; ch++) {
        const t = TYPE_VRC7_BASE + ch;
        wfvEntries[t] = 'WFV_VRC7';
        silEntries[t] = 'SIL_VRC7';
        if (usesVolOnly) wfvVolEntries[t] = 'WFV_VOL_VRC7';
        if (usesFreqOnly) wfoEntries[t] = 'WFO_VRC7';
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
      // ppmck準拠(2026-09-19、nes_include/ppmck/dpcm.h dpcm_set と同じ構造): 音符バイトが
      // 「どの @DPCM<n> を鳴らすか」の番号で、その番号×4で DPCM_DATA(制御/DAC/アドレス/長さの4バイト×行)を
      // 引く。レートは定義の freq で固定なので、以前の「@<n>で選んだスロットを DUTY,X から逆引きし、
      // freq別108バイトのレート表を NOTE,X で引く」独自方式は廃止した。音符バイト(NOTE,X)は compiler.js の
      // noteNumber = DPCM_NOTE_BASE(24) + 番号 のままなので、ハンドラ側で 24 を引く。
      // 行は 0〜最大番号まで詰めて出す(ppmck writeDPCM も max まで。未使用行はppmckでは 0,0,0,0 だが、
      // ここでは制御バイトの bit7 を立てて「鳴らさない」印にし、compiler.js(未定義=無音)と揃える)。
      // 同じファイルを共有する定義(layout.shared)は addr/len が同じ行になるだけ。
      // サンプル本体はここでは埋め込まない($C000-$FFFF 窓4-7に buildBankedNsfBytes が直接配置する)
      const dpcmMaxIdx = dpcmIndices[dpcmIndices.length - 1];
      const dpcmDataBytes = [], dpcmPageBytes = [];
      for (let idx = 0; idx <= dpcmMaxIdx; idx++) {
        const layout = dpcmLayout[idx];
        const def = dpcmSamples[idx];
        if (!layout || !def) { dpcmDataBytes.push(0x80, 0xFF, 0x00, 0x00); dpcmPageBytes.push(0); continue; }
        // $4010 = (mode<<6)|freq(ppmck writeDPCM の1バイト目 freq|(mode<<6)。bit7=IRQは落とす)
        dpcmDataBytes.push((((def.mode | 0) & 3) << 6 | ((def.freq | 0) & 0x0F)) & 0x7F);
        // DAC=$FF(bit7)は「$4011を書かない」印(layout.dac===null、ppmck dpcm.h の .skip と同じ)
        dpcmDataBytes.push(layout.dac != null ? (layout.dac & 0x7F) : 0xFF);
        dpcmDataBytes.push(layout.addrReg & 0xff);
        dpcmDataBytes.push(layout.lengthReg & 0xff);
        // ページの先頭バンク(ファイル上)。usesDpcmPaging のときだけテーブルに出す
        dpcmPageBytes.push((dpcmPageBank0 + (layout.page | 0) * DPCM_PAGE_BANKS) & 0xff);
      }
      extraTables.push(
        `DPCM_DATA:\n${bytesToDb(new Uint8Array(dpcmDataBytes))}` +
        (usesDpcmPaging ? `\nDPCM_PAGE_TBL:\n${bytesToDb(new Uint8Array(dpcmPageBytes))}` : ''));
      extraHandlers.push(`
; --- DPCM ($4010-4013、サンプル本体は窓4-7=$C000-$FFFFに直接配置。16KBを超える曲は
;     16KBごとの「ページ」に分け、トリガー時に DPCM_PAGE_TBL のページへ窓4-7を切り替える) ---
; NOTE,X(=24+@DPCM番号、compiler.js DPCM_NOTE_BASE)から番号を出し、番号×4で DPCM_DATA を引く
; (ppmck dpcm.h の asl/asl/tax と同じ)。制御バイトの bit7 が立つ行=未定義は何もしない。X(チャンネル)は保存
WFV_T${TYPE_DPCM}:
    LDA ${hex(NOTE)},X
    SEC
    SBC #${hex(MML.Mml.DPCM_NOTE_BASE)}
    BCC DPCM_NONE
    CMP #${hex(dpcmMaxIdx + 1)}
    BCS DPCM_NONE
    STA ${hex(PERLO2)}    ; 番号(ページ表の索引に使う)
    ASL A
    ASL A
    TAY
    LDA DPCM_DATA,Y     ; 制御($4010の値)。bit7=未定義
    BMI DPCM_NONE
    STA ${hex(PERLO)}
    LDA #$0F
    STA $4015       ; DMC一旦停止(2A03他chは維持)
    LDA ${hex(PERLO)}
    STA $4010
    LDA DPCM_DATA+1,Y   ; DAC初期値($FF=書かない)
    BMI DPCM_NODAC
    STA $4011
DPCM_NODAC:
${usesDpcmPaging ? `    LDY ${hex(PERLO2)}
    LDA DPCM_PAGE_TBL,Y ; そのサンプルのページ(ファイル上の先頭バンク番号)。窓4-7が別ページなら切り替える
    CMP ${hex(DPCMPAGE)}
    BEQ DPCM_PAGE_OK
    STA ${hex(DPCMPAGE)}
    STA $5FFC       ; 窓4-7 ← ページの4バンク(上で$4015=$0FによりDMCは止めてあるので読出し中の切替は無い)
    CLC
    ADC #$01
    STA $5FFD
    ADC #$01
    STA $5FFE
    ADC #$01
    STA $5FFF
DPCM_PAGE_OK:
    LDA ${hex(PERLO2)}
    ASL A
    ASL A
    TAY` : ''}
    LDA DPCM_DATA+2,Y
    STA $4012
    LDA DPCM_DATA+3,Y
    STA $4013
    LDA #$1F
    STA $4015       ; 再生開始
DPCM_NONE:
    RTS
SIL_T${TYPE_DPCM}:
    RTS             ; 休符/ゲートオフではDMCを止めない(サンプルは末尾まで鳴り切る)。
                    ; 実機ppmck(dpcm.h no_dpcm、DPCM_RESTSTOP無効の既定)およびcompiler.js
                    ; segmentsToWriteLogDpcmと同じ`);
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
${(needsLastHi || usesVrc7) ? `    STA ${hex(LASTHI)},X   ; LASTHI=0(VRC7ではキー状態シャドウを兼ねる、WFO_VRC7/SIL_VRC7参照。同上の理由)` : ''}
${usesSmooth ? `    STA ${hex(SMOOTHACT)},X  ; SMOOTHACT=0(SM未指定時の既定値、SMOF相当)` : ''}
${usesPitchSa ? `    STA ${hex(SAAMT)},X    ; SAAMT=0(SA未指定時の既定値=シフト無し)` : ''}
${usesDirect ? `    STA ${hex(DIRACT)},X   ; DIRACT=0(@n未使用の音符=音階テーブルで鳴らす)` : ''}
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
${incHi(DUTYTICKHI, dutyWide, 'TVF_DUTYHI')}    JSR DUTY_LOOKUP
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
${incHi(ENVTICKHI, envWide, 'TVF_ENVHI')}    JSR ENV_LOOKUP
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
${incHi(RELTICKHI, vrWide, 'TVF_RELHI')}    JSR REL_LOOKUP
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
; 2026-08-20にOP_SWEEP=0xE3を追加した際、境界を0xE7から0xE3へ下げた。その後0xE4=SA、0xE5=@n
; (2026-09-19)が埋まり、0xE6だけが未使用でここをすり抜けるが、末尾のJMP RD_NOTEへ落ちるだけで従来と同じ)。
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
${usesDirect ? '    CMP #$E5\n    BEQ RD_JMP_DIRECT' : ''}
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
${usesDirect ? 'RD_JMP_DIRECT:\n    JMP RD_DIRECT' : ''}

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
${envTableCount > 0 ? `    LDA #$00
    STA ${hex(ENVACT)},X   ; ★2026-09-19: ソフトウェア音量エンベロープ(@v)も解除する。compiler.js は
    LDA #$FF                ; 「S<n> > @v > v」の優先順で S<n> の音符に @v を掛けないが、ここで残していたため
    STA ${hex(ENVSEL)},X   ; @v の音符の後の S<n> の音符で @v が毎フレーム音量(bit4=0)を書き、エンベロープが消えていた
` : ''}    JMP RD_LOOP` : ''}

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
${envWide ? `    STA ${hex(ENVTICKHI)},X
` : ''}${usesFme7 ? `    LDA #$00
    STA ${hex(FMEEACT)},X  ; @v<n>とFME7ハードウェアエンベロープは排他` : ''}
    JMP RD_LOOP` : ''}

${usesToneState ? `RD_TONE:
    ; 音色バイトはbit7で「固定音色(1)」と「デューティエンベロープ番号(0)」を区別する
    ; (実機ppmck internal.h duty_set と同じ)。TONEBASEへ控えておき、@@r<n>で
    ; リリース音色へ差し替えられた後の音符で自分の音色へ戻せるようにする
    JSR READ_BYTE
    STA ${hex(TONEBASE)},X
${usesDutyEnv && usesPitchShift ? `    ORA #$00               ; APPLY_TONEのBPLは呼び出し時のNフラグで固定音色/@@を分ける。STAはフラグを
                           ; 変えないので、ここではREAD_BYTEのINC(読取りポインタ)のフラグが残っていた。
                           ; 通常の音符はRD_NOTE_BODYがTONEBASEをLDAし直して選び直すので表に出ないが、
                           ; PS音符(選び直さない)の直前の @<n> が @@<n> 扱いになり、でたらめな表を
                           ; 引いていた(2026-09-20、syn/ps_duty1.mml で実測)
` : ''}    JSR APPLY_TONE
${usesDutyEnv && usesPitchShift ? `    ; @@<n>を選び直した直後がPS音符(RD_PITCHSHIFT=キーオン無し)でも、その先頭をtick0にする
    ; (RD_PITCHSHIFTはTICK_VOL_FXを1回肩代わりするので、0のままだと先頭がtick1になる。
    ; RD_VOLENVのENVTICK=$FFと同じ作法。通常の音符はRD_NOTE_BODYがTONEBASEからtick0で
    ; 選び直すので影響しない。2026-09-20、compiler.js dutyPlan と一致させる)
    LDA ${hex(DUTYSEL)},X
    CMP #$FF
    BEQ RDT_NODUTY
    LDA #$FF
    STA ${hex(DUTYTICK)},X
${dutyWide ? `    STA ${hex(DUTYTICKHI)},X\n` : ''}RDT_NODUTY:
` : ''}    JMP RD_LOOP

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
; --- SA<num>(N163ピッチシフト量、0xE4、2026-08-26、ppmckpitch_shift_amount相当):
; 直後1バイトがシフト量(0-8)。保持するだけで、実際の適用はAPPLY_DETUNE_N163の
; SA_ADD16(D/EP/MPの16bit値を左シフトしながら18bit周波数へ加算)が毎回行う ---
RD_PITCHSA:
    JSR READ_BYTE
    STA ${hex(SAAMT)},X
    JMP RD_LOOP` : ''}
${usesDirect ? `
; --- @n<num>(直接周波数指定、0xE5、2026-09-19、ppmckのMCK_DIRECT_FREQ/direct_freq_sub相当):
; 直後2バイトが[周期/周波数の下位,上位]。値を控えて DIRACT=2 にし、続く音符(必ず直後に来る)の
; RD_NOTE_BODY が LSR で1にする=その音符だけ LOOKUP_*_PERIOD が音階テーブルの代わりにこの値を返す ---
RD_DIRECT:
    JSR READ_BYTE
    STA ${hex(DIRLO)},X
    JSR READ_BYTE
    STA ${hex(DIRHI)},X
    LDA #$02
    STA ${hex(DIRACT)},X
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
${enWide ? `    STA ${hex(ENTICKHI)},X
` : ''}    STA ${hex(ENVAL)},X
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
${epWide ? `    STA ${hex(EPTICKHI)},X
` : ''}    JMP RD_LOOP` : ''}
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
    LDA PITCH_DIR_TABLE,Y
    STA ${hex(MPDIR)},X
    RTS` : ''}
${usesPortamento ? `
; --- PT<target>,<duration>[,<delay>]ポルタメント選択(0xF9): 次の5バイトが
; [増減量下位,増減量上位,間隔,duration,delay]。duration=0を番兵としてoff(PTOF)を表す。
; 増減量(符号付き16bit)と間隔はmckBytecode.jsがcompiler.jsのportamentoSequenceと同じ式
; (|target|とdurationの大小比較+ceilDivPpmck)で前計算して置く(2026-09-19)。以前はここで
; target(|target|<=255前提)からCEILDIVしていたため、PT-512,4(下位バイト0)やPT0,<n>で
; 除数0の無限ループになり、そのフレームでドライバ全体が止まっていた。状態の初期化
; (delay/durationリセット・PT_STEP初回呼び出し)はRD_NOTE(音符アタック時)で行う ---
RD_PORTAMENTO:
    JSR READ_BYTE
    STA ${hex(PTSTEPSZ)},X
    JSR READ_BYTE
    STA ${hex(PTSTEPHI)},X
    JSR READ_BYTE
    STA ${hex(PTSTEPINT)},X
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
${usesFreqOnly && usesVrc7 ? `    ; VRC7: 先にキーオフする(下の WRITE_FREQ_ONLY=WFO_VRC7 はキーオフ中は書かないので、余韻の音程は
    ; 直前の音符の最後のフレームのまま。ppmck vrc7_do_effect も休符のフレームは効果を書かない。compiler.js と同じ)。
    ; 他のチップは下の SILENCE_CH がもう一度無音化するので結果は変わらない
    JSR SILENCE_CH
` : ''}${usesFreqOnly ? `    ; 読取りフレームぶんの周期側継続効果tick(SERVICE_CH冒頭コメント参照。休符中も
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
; compiler.js側をresolveEnvTablesでppmck準拠(v<n>固定音量でも@vrが効く)に直したので、
; こちらもENVSELの判定を外して揃える。
; ★@@r<n>(リリース音色)もこの瞬間に適用する(実機putReleaseEffectがリリース
; エンベロープの切替と音色の切替を同じ場所で出力するのと同じ)。@vrを使わず
; @@r<n>だけを使う曲でもこのオペコードが使われる(usesGateOffVr) ---
RD_GATEOFFVR:
    JSR READ_BYTE
    STA ${hex(CNT)},X
${usesFreqOnly && usesVrc7 ? `${usesVr ? `    LDA ${hex(VRSEL)},X
    CMP #$FF
    BNE RGV_KEEPKEY
` : ''}    JSR SILENCE_CH         ; VRC7: @vr の無いゲートオフは先にキーオフ(RD_REST と同じ理由。@vr ならキーオンのまま)
${usesVr ? 'RGV_KEEPKEY:\n' : ''}` : ''}${usesFreqOnly ? `    JSR TICK_PITCH_FX      ; 読取りフレームぶんの周期側継続効果tick(RD_RESTと同じ)
    BEQ RGV_NOFREQ
    JSR WRITE_FREQ_ONLY
RGV_NOFREQ:` : ''}
${usesDutyEnv ? `    ; 読取りフレームぶんのデューティエンベロープtick(TICK_VOL_FXの@@部分の肩代わり。2026-09-20まで
    ; 抜けていて、@vrのリリースに入った音はデューティだけ1フレーム遅れていた=compiler.jsの
    ; dutyAtは毎フレーム連続。@@r<n>があれば直後のAPPLY_REL_TONEがtick0から選び直す)
    LDA ${hex(DUTYSEL)},X
    CMP #$FF
    BEQ RGV_NODUTY
    INC ${hex(DUTYTICK)},X
${incHi(DUTYTICKHI, dutyWide, 'RGV_DUTYHI')}    JSR DUTY_LOOKUP
RGV_NODUTY:` : ''}
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X` : ''}
${usesToneState ? `    JSR APPLY_REL_TONE` : ''}
${usesVr ? `    LDA ${hex(VRSEL)},X
    CMP #$FF
    BEQ RD_GATEOFFVR_NOVR
    LDA #$00
    STA ${hex(RELTICK)},X
${vrWide ? `    STA ${hex(RELTICKHI)},X
` : ''}    LDA #$01
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
${usesDirect ? `    LSR ${hex(DIRACT)},X   ; @n の音符のリリースでも差し替え先は音階の音(1→0)` : ''}
    JSR READ_BYTE
    STA ${hex(CNT)},X
${usesDutyEnv ? `    ; デューティエンベロープの読取りフレームぶんのtick(RD_GATEOFFVRと同じ。compiler.jsのdutyAtは
    ; SDの差し替えでも途切れず進む)
    LDA ${hex(DUTYSEL)},X
    CMP #$FF
    BEQ RGVSD_NODUTY
    INC ${hex(DUTYTICK)},X
${incHi(DUTYTICKHI, dutyWide, 'RGVSD_DUTYHI')}    JSR DUTY_LOOKUP
RGVSD_NODUTY:` : ''}
${envTableCount > 0 ? `    LDA #$00\n    STA ${hex(ENVACT)},X` : ''}
${usesToneState ? `    JSR APPLY_REL_TONE` : ''}
${usesVr ? `    LDA ${hex(VRSEL)},X
    CMP #$FF
    BEQ RD_GATEOFFVRSD_NOVR
    LDA #$00
    STA ${hex(RELTICK)},X
${vrWide ? `    STA ${hex(RELTICKHI)},X
` : ''}    LDA #$01
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
;   A=${hex(noteBase)}-$E1        … ノート番号(A-${hex(noteBase)})+直前と同じ音長の1バイト音符
;   A=$00-${hex(noteBase - 1)}        … 従来の[音符,音長]2バイト形式(音長はNOTELEN,Xへも控える)
;   (基点は曲ごと: 通常$76、2バイト形式で o9a+/o9b(118/119)を書く曲だけ$78。mckBytecode.js NOTE_BASE_DEFAULT 参照)
RD_NOTE:
    CMP #$E2
    BNE RD_NOTE_CHK
    JMP RD_REST_SAME
RD_NOTE_CHK:
    CMP #${hex(noteBase)}
    BCC RD_NOTE_EXPL
    SBC #${hex(noteBase)}        ; BCC非成立=C=1なのでSEC不要
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
${usesDirect ? `    LSR ${hex(DIRACT)},X   ; @n: 直前がOP_DIRECT_FREQ(2)なら1=この音符は指定値、それ以外は0=音階テーブル` : ''}
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
${envWide ? `    STA ${hex(ENVTICKHI)},X
` : ''}    JSR ENV_LOOKUP
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
${epWide ? `    STA ${hex(EPTICKHI)},X
` : ''}    STA ${hex(EPVALLO)},X  ; ★累積値も0から(2026-09-13、累積方式化。実機のfrequency_setが
    STA ${hex(EPVALHI)},X  ;  ノートオンで基準値へ戻すのに対応。ENVALのRD_NOTEリセットと同じ)
    JSR EP_STEP
RD_NOTE_NOEP:` : ''}
${usesEn ? `    ; EN<n>も"この音符から"必ずtick0/累積値0から再初期化する(@v<n>のRD_NOTE_NOENVと
    ; 同じ理由。ENACT継続時に前の音符のENTICK/ENVALをそのまま引き継ぐと、アルペジオの
    ; 違う位相から再生されてしまう)
    LDA ${hex(ENACT)},X
    BEQ RD_NOTE_NOEN
    LDA #$00
    STA ${hex(ENTICK)},X
${enWide ? `    STA ${hex(ENTICKHI)},X
` : ''}    STA ${hex(ENVAL)},X
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
; ★PS音符はキーオンではない(ppmckpitchshift_setupがeffect_initを通らないのと同じ)
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
${endMute ? `    ; 以降このchは何も書かない(種別を未使用スロットへ。buildFixedSource冒頭の endMute 参照)
${dpcmLoopStop ? `    LDA ${hex(CHTYPE)},X
    CMP #${hex(TYPE_UNIMPLEMENTED)}
    BEQ RD_ENDTRACK_IDLE    ; 2回目以降(255フレームごとに終端を読み直す)は数えない
` : ''}    LDA #${hex(TYPE_UNIMPLEMENTED)}
    STA ${hex(CHTYPE)},X
${dpcmLoopStop ? `    DEC ${hex(ENDCNT)}
    BNE RD_ENDTRACK_IDLE
    LDA #$0F
    STA $4015       ; 全chが終端に達した=曲の終わり。ループ指定のDPCMもここで止める
RD_ENDTRACK_IDLE:
` : ''}` : ''}    LDA #$FF
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
; (このアプリのfreqテーブルは0-107の108音分、o9 を使う曲のチップだけ0-119の120音)。上限側(表の末尾超過)の
; クランプは元からある。加算結果が127を超えた場合も bit7 で負と見なして0になる(compiler.js enTableNote が同じ規則)。逆に極端に大きい正のオフセットで8bit符号付き加算がオーバーフロー
; するケースは非対応(APPLY_DETUNEの上限側同様、通常の用途の値では発生しない)
LOOKUP_PULSE_PERIOD:
${usesDirect ? `    LDA ${hex(DIRACT)},X
    BEQ LPP_TBL
    JMP LOOKUP_DIRECT
LPP_TBL:` : ''}
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LPP_NONNEG
    LDA #$00
    JMP LPP_INDEX
LPP_NONNEG:` : ''}
    CMP #${hex(pulseTableSize - 1)}
    BCC LPP_OK
    LDA #${hex(pulseTableSize - 1)}
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
${usesDirect ? `    LDA ${hex(DIRACT)},X
    BEQ LTP_TBL
    JMP LOOKUP_DIRECT
LTP_TBL:` : ''}
    LDA ${hex(NOTE)},X
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X
    BPL LTP_NONNEG
    LDA #$00
    JMP LTP_INDEX
LTP_NONNEG:` : ''}
    CMP #${hex(triTableSize - 1)}
    BCC LTP_OK
    LDA #${hex(triTableSize - 1)}
LTP_OK:
LTP_INDEX:
    ASL A
    TAY
    LDA TRI_TABLE,Y
    STA ${hex(PERLO)}
    LDA TRI_TABLE+1,Y
    STA ${hex(PERHI)}
    RTS
${usesDirect ? `
; --- @n(直接周波数指定): 各 LOOKUP_*_PERIOD が DIRACT≠0 のとき JMP で来る(RTS は呼び出し元の JSR へ戻る)。
; 指定値そのものを返す(EN の ENVAL は足さない。compiler.js writePitchModulation と同じ) ---
LOOKUP_DIRECT:
    LDA ${hex(DIRLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(DIRHI)},X
    STA ${hex(PERHI)}
    RTS
` : ''}
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
; ★符号(2026-09-14統一): MML上のD/EP/PTは全音源「正=音程が上がる」。PITCH_DIR_TABLE[CHTYPE]が
; $FF(周期レジスタ系・ノイズ)なら D/EP/PT を減算、$01(FDS。N163はAPPLY_DETUNE_N163側)なら加算する。
; MP(MPVAL、LFO_SUBが方向テーブルで既に向きを決めている)とPS(レジスタ差から直接算出)は常に加算。
; compiler.js pitchRegisterOffset の offset = dir*(D+EP) + MP、+ dir*PT + PS と同じ。Yは破壊する。
; Xは破壊しない。D/EP/MP/PT/PS全部未使用の曲ではルーチン本体も全JSRも省略される
; (usesAnyPitchOffset、buildFixedSource末尾の行フィルタ参照) ---
APPLY_DETUNE:
` : ''}${usesAnyPitchOffset && (usesDetune || usesEp || usesPortamento) ? `    LDY ${hex(CHTYPE)},X
    LDA PITCH_DIR_TABLE,Y
    BMI AD_SUB
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
` : ''}${usesPortamento ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(PTVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(PTVALHI)},X
    STA ${hex(PERHI)}
` : ''}${usesAnyPitchOffset && (usesDetune || usesEp || usesPortamento) ? `    JMP AD_MPPS
AD_SUB:
` : ''}${usesAnyPitchOffset && usesDetune ? `    SEC
    LDA ${hex(PERLO)}
    SBC ${hex(DETUNE_LO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    SBC ${hex(DETUNE_HI)},X
    STA ${hex(PERHI)}
` : ''}${usesEp ? `    SEC
    LDA ${hex(PERLO)}
    SBC ${hex(EPVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    SBC ${hex(EPVALHI)},X
    STA ${hex(PERHI)}
` : ''}${usesPortamento ? `    SEC
    LDA ${hex(PERLO)}
    SBC ${hex(PTVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    SBC ${hex(PTVALHI)},X
    STA ${hex(PERHI)}
` : ''}${usesAnyPitchOffset && (usesDetune || usesEp || usesPortamento) ? `AD_MPPS:
` : ''}${usesMp ? `    CLC
    LDA ${hex(PERLO)}
    ADC ${hex(MPVALLO)},X
    STA ${hex(PERLO)}
    LDA ${hex(PERHI)}
    ADC ${hex(MPVALHI)},X
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
; $400E = (((NOTE + ENVAL) & 15) − D − EP − MP − PT) & $FF | (@<n> bit0 << 7)
; ppmck準拠(2026-09-18): NOTEは周期index(0-15)の直値、D/EP/MP/PTは他chと同じ生加減算で
; クランプしない → D16 n0 = 0−16 = $F0 のように桁あふれで bit7(短周期)が立つ(wikiの
; 「短周期ノイズは D16〜D1」の技)。@1(本ツール独自の短周期指定)は bit7 を OR。
; compiler.jsのノイズ経路(segmentsToWriteLog2A03 'D')と同じ式で、実ppmck09aのNSFと$400E列が一致 ---
LOOKUP_NOISE_PERIOD:
${usesDirect ? `    LDA ${hex(DIRACT)},X   ; @n: 指定値の下位バイトをそのまま使う(ppmck: $400E へ sound_freq_low。bit7=短周期)
    BEQ LNP_TBL
    LDA ${hex(DIRLO)},X
    JMP LNP_SET
LNP_TBL:` : ''}
    LDA ${hex(NOTE)},X     ; NOTE=周期index(0-15)の直値(compiler.js noisePeriodIndex、ppmck準拠)
${usesEn ? `    CLC
    ADC ${hex(ENVAL)},X    ; EN(ノート空間)は index に足して16で巡回
` : ''}    AND #$0F
${usesDirect ? 'LNP_SET:' : ''}
    STA ${hex(PERLO)}
    LDA #$40
    STA ${hex(PERHI)}      ; ★上位を$40にしておく: APPLY_DETUNEは16bit結果が負なら0へクランプするが、
                           ;   ノイズは下位バイトの桁あふれ(D16 n0 → $F0=bit7=短周期)がppmck仕様なので
                           ;   クランプに掛からない正の下駄を履かせ、下位8bit(PERLO)だけを$400Eへ書く
${usesAnyPitchOffset ? `    JSR APPLY_DETUNE
` : ''}    LDA ${hex(DUTY)},X     ; @<n>のbit0=短周期(本ツール独自拡張) → $400E bit7 へ(桁あふれとOR)
    LSR A
    LDA #$00
    ROR A
    ORA ${hex(PERLO)}
    STA ${hex(PERLO)}
    RTS
WFV_T3:
    JSR LOOKUP_NOISE_PERIOD
    LDA ${hex(PERLO)}
    STA $400E
    LDA #$00
    STA $400F
    LDA #$30
    ORA ${hex(VOL)},X
    STA $400C
    RTS
${usesFreqOnly ? `; ノイズのEP/MP/PT/EN継続フレーム(周期indexのみ再書込み)
WFO_T3:
    JSR LOOKUP_NOISE_PERIOD
    LDA ${hex(PERLO)}
    STA $400E
    RTS` : ''}
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
${wordsToDb(buildPeriodTable(pulsePeriod, pulseTableSize))}

TRI_TABLE:
${wordsToDb(buildPeriodTable(trianglePeriod, triTableSize))}
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

  // NSFのバイトコード(mckBytecode.js)とドライバの表が1バイトで持つ番号・値のうち、曲がその範囲を超えて
  // 使っているものを列挙する(2026-09-19、buildBankedNsfBytes 参照)。戻り値は asmErrors と同じ形の配列。
  //  ・エンベロープの種類数: 曲中で実際に使う番号は0始まりに詰め直して1バイトで運ぶ。$FF は「解除/未選択」の
  //    番兵(@vr255・EPOF・ENOF・MPOF・ENVSEL=$FF)なので @v/@vr/EP/EN/MP は255種類まで。@@(デューティ
  //    エンベロープ)は音色バイトの bit7=0 側に入るので128種類まで
  //  ・EP の値: 1バイトの符号付き差分(-128〜127)。JS再生はそれを超える値もそのまま足す
  //  ・MP の定義: delay・depth は 0〜255、speed は 2倍を1バイトで比べるので 0〜127
  //  ・FDS/N163 の音色番号(@<n>・@@<n>): 音色バイトは bit7 が種別なので 0〜127(番号で波形を選ぶ)
  //  ・@@r<n> の固定音色: $FF が OFF なので 0〜126
  //  ・OP<n>(VRC7 ユーザー音色の再ロード): 0x80|番号 なので 0〜127。MH<n>(FDS): 255 が MHOF なので 0〜254
  // EN の値は ENVAL を8bitで足し続けても JS 再生(256で割った余りで扱う)と同じ結果になるので検査しない。
  // 長さ256以上のエンベロープは tick を16bitにして書き出せる(buildFixedSource の envWide 等)
  function checkBytecodeLimits(compileResult, channelLetters, expansionLetterMap, envelopes, lists) {
    const errors = [];
    const segmentsByChannel = compileResult.segmentsByChannel || {};
    const immediateWritesByChannel = compileResult.immediateWritesByChannel || {};
    // kind: 呼び出し側(main.js 等)が「内部エラー」ではなく曲側の制限だと見分けるための印
    const push = (key, params) => errors.push({ lineNo: 0, kind: 'bytecodeLimit', message: tr(key, params) });
    const kinds = [
      ['@v<n>', lists.envIndexList, 255], ['@vr<n>', lists.vrIndexList, 255], ['EP<n>', lists.epIndexList, 255],
      ['EN<n>', lists.enIndexList, 255], ['MP<n>', lists.mpIndexList, 255], ['@@<n>', lists.dutyIndexList, 128]
    ];
    for (const [kind, list, max] of kinds) {
      if (list.length > max) {
        push('NSF書き出し: {kind} を{count}種類使っていますが、NSFのバイトコードで区別できるのは{max}種類までです(番号を1バイトで持つため)。使う種類を減らしてください',
          { kind, count: list.length, max });
      }
    }
    for (const idx of lists.epIndexList) {
      const bad = ((envelopes.ep && envelopes.ep[idx] && envelopes.ep[idx].values) || []).find(v => (v | 0) < -128 || (v | 0) > 127);
      if (bad !== undefined) {
        push('NSF書き出し: {def} の値 {value} は、NSFのバイトコードで表せる {min}〜{max} の範囲外です(値を1バイトで持つため)',
          { def: '@EP' + idx, value: bad, min: -128, max: 127 });
      }
    }
    for (const idx of lists.mpIndexList) {
      const mp = (envelopes.mp && envelopes.mp[idx]) || {};
      for (const [name, max] of [['delay', 255], ['speed', 127], ['depth', 255]]) {
        const v = mp[name] || 0;
        if (v > max) {
          push('NSF書き出し: {def} の値 {value} は、NSFのバイトコードで表せる {min}〜{max} の範囲外です(値を1バイトで持つため)',
            { def: `@MP${idx} (${name})`, value: v, min: 0, max });
        }
      }
    }
    // チャンネルごとの番号(同じch・同じコマンドは最初の1件だけ報告する)
    const seen = new Set();
    const numErr = (ch, cmd, value, max) => {
      if (seen.has(ch + cmd)) return;
      seen.add(ch + cmd);
      push('NSF書き出し: {ch} の {cmd}{value} は、NSFのバイトコードで表せる {max} を超えています(番号を1バイトで持つため)',
        { ch, cmd, value, max });
    };
    const waveChips = new Set([...(expansionLetterMap.fds || []), ...(expansionLetterMap.n163 || [])]);
    const vrc7Set = new Set(expansionLetterMap.vrc7 || []);
    const fdsSet = new Set(expansionLetterMap.fds || []);
    for (const ch of channelLetters) {
      for (const seg of (segmentsByChannel[ch] || [])) {
        if (seg.freq == null) continue;
        if (waveChips.has(ch) && seg.instrument != null && seg.instrument > 127) numErr(ch, '@', seg.instrument, 127);
        if (seg.releaseTone != null && seg.releaseTone !== 255 && !seg.releaseToneDuty && seg.releaseTone > 126) {
          numErr(ch, '@@r', seg.releaseTone, 126);
        }
      }
      for (const iw of (immediateWritesByChannel[ch] || [])) {
        if (iw.kind === 'vrc7Tone' && vrc7Set.has(ch) && iw.value !== 255 && iw.value > 127) numErr(ch, 'OP', iw.value, 127);
        if (iw.kind === 'fdsMod' && fdsSet.has(ch) && iw.value !== 255 && iw.value > 254) numErr(ch, 'MH', iw.value, 254);
      }
    }
    return errors;
  }

  // VRC7の音量をレジスタ値(減衰値、0=最大)へ反転した見え方を作る(2026-09-20)。MMLの v/@v/@vr は
  // 他の音源と同じ向き(15=最大)で、反転はコンパイラが吸収する約束(compiler.js vrc7VolReg と同じ)。
  // 6502ドライバ(WFV_VRC7/WFV_VOL_VRC7)は VOL,X をそのまま$30+chへ書くので、ここで
  //   ・VRC7チャンネルのセグメントの volume を 15-v に
  //   ・VRC7チャンネルが使う @v/@vr の表を「下位4bitを反転した別の表」(番号 VRC7_ENV_BASE+n)に
  // 差し替えてからバイトコードとROMの表を作る。同じ @v を他の音源でも使う曲では表が2本になる。
  // VRC7を使わない曲は元の segmentsByChannel/envelopes をそのまま返す(NSFはバイト単位で従来と同じ)
  const VRC7_ENV_BASE = 0x10000;
  function vrc7RegisterView(segmentsByChannel, envelopes, vrc7Letters) {
    const letters = (vrc7Letters || []).filter(ch => (segmentsByChannel[ch] || []).length);
    if (!letters.length) return { segmentsByChannel, envelopes };
    const inv = t => Object.assign({}, t, { values: ((t && t.values) || []).map(x => 15 - (Math.max(0, Math.min(63, x | 0)) & 15)) });
    const v = Object.assign({}, envelopes.v || {});
    const vr = Object.assign({}, envelopes.vr || {});
    const segs = Object.assign({}, segmentsByChannel);
    for (const ch of letters) {
      segs[ch] = segmentsByChannel[ch].map(seg => {
        const s = Object.assign({}, seg);
        if (s.volume != null) s.volume = 15 - Math.max(0, Math.min(15, s.volume | 0));
        if (s.envelopeV != null && envelopes.v && envelopes.v[s.envelopeV]) {
          const k = VRC7_ENV_BASE + s.envelopeV;
          if (!v[k]) v[k] = inv(envelopes.v[s.envelopeV]);
          s.envelopeV = k;
        }
        if (s.envelopeVr != null && s.envelopeVr !== 255) {
          const t = (envelopes.vr && envelopes.vr[s.envelopeVr]) || (envelopes.v && envelopes.v[s.envelopeVr]);
          if (t) {
            const k = VRC7_ENV_BASE + s.envelopeVr;
            if (!vr[k]) vr[k] = inv(t);
            s.envelopeVr = k;
          }
        }
        return s;
      });
    }
    return { segmentsByChannel: segs, envelopes: Object.assign({}, envelopes, { v, vr }) };
  }

  // compileResult: MML.Mml.compile()の戻り値そのもの
  // (segmentsByChannel, channelLetters, expansions, expansionLetterMap を使う)。
  // headerOpt: NSF.buildHeaderと同じオプション。
  // 戻り値: { nsfBytes, asmErrors, bankCount, unsupportedExpansions }
  Driver.buildBankedNsfBytes = function (compileResult, headerOpt) {
    let channelLetters = compileResult.channelLetters || ['A', 'B', 'C', 'D'];
    const expansions = compileResult.expansions || [];
    let expansionLetterMap = compileResult.expansionLetterMap || {};
    let segmentsByChannel = compileResult.segmentsByChannel || {};
    // #TUNING(基準ピッチ): 全チップの周波数テーブル(buildPeriodTable/N163/VRC7)を compiler.js と同じ比でずらす
    tuningRatio = Math.pow(2, ((compileResult.settings && compileResult.settings.tuningCents) || 0) / 1200);
    tuningNoteRatios = (compileResult.settings && compileResult.settings.tuningNotes)
      ? compileResult.settings.tuningNotes.map(c => Math.pow(2, (c || 0) / 1200)) : null;

    // N163の有効チャンネル数($7Fに書く値、周波数テーブルの符号化、レジスタ配置の
    // (8-num)+chオフセットの全てに効く)をcompiler.js(n163NumChOf)と完全に同じ規則で決める。
    // ★2026-09-11: 規則は「#EX-N163 <n> の数値があればそれ、無ければ音符を持つ最上位レター+1」。
    //   数値優先はppmck(datamake.c _EX_NAMCO106)と同じで、変換設定 N163_CH の
    //   「8ch固定」を実際に効かせるために要る。以前は常に自動検出だった。以前は#EX-NAMCO106で
    // 宣言された8レター全部をチャンネルとして組み込み常に8ch扱いだったため、ブラウザ再生
    // (実使用ch数)とNSF書き出しで$7F・周波数値・レジスタ配置が全て食い違っていた
    // (女神転生II 11曲目=4ch使用曲で発覚)。有効ch数より上のレター(音符無し)は実機上の
    // 実体が無い(レジスタ配置がRAM範囲外へはみ出す)ためドライバのチャンネル一覧から除外する
    // 有効ch数は下のN163共有バッファ割り当て(波形に使えるバイト数=128-8*numCh)でも要るので
    // ブロックの外へ出しておく
    let numN163Ch = 8;
    if (expansions.includes('n163')) {
      const n163All = expansionLetterMap.n163 || [];
      const declared = compileResult.settings && compileResult.settings.n163NumCh;
      if (declared) {
        numN163Ch = Math.max(1, Math.min(8, declared));
      } else {
        numN163Ch = 0;
        n163All.forEach((ch, index) => {
          if ((segmentsByChannel[ch] || []).some(s => s.freq != null)) numN163Ch = index + 1;
        });
        numN163Ch = Math.max(1, numN163Ch);
      }
      if (numN163Ch < n163All.length) {
        const dropped = new Set(n163All.slice(numN163Ch));
        expansionLetterMap = Object.assign({}, expansionLetterMap, { n163: n163All.slice(0, numN163Ch) });
        channelLetters = channelLetters.filter(ch => !dropped.has(ch));
      }
    }
    let envelopes = compileResult.envelopes || {};
    // VRC7の音量はここでレジスタ値へ反転する(vrc7RegisterView 参照)。以降の segmentsByChannel/envelopes は反転済み
    ({ segmentsByChannel, envelopes } = vrc7RegisterView(segmentsByChannel, envelopes, expansionLetterMap.vrc7));
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
    // resolveEnvTablesをppmck準拠に直したのに合わせ、@v無し(v<n>固定音量)の音符でも
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
    // 4bit音量のチャンネル(FDS/VRC6のこぎり波以外)が 16 以上の値を含む @v/@vr 表を使うか
    // (buildFixedSource の volMask4 参照。使わない曲はドライバがバイト単位で従来と同じ)
    const over15 = t => ((t && t.values) || []).some(v => (v | 0) > 15);
    const vrTableOfTop = idx => (envelopes.vr && envelopes.vr[idx]) || (envelopes.v && envelopes.v[idx]);
    const volMask4 = channelLetters.some((ch, i) => channelTypes[i] !== TYPE_FDS && channelTypes[i] !== TYPE_VRC6_SAW &&
      (segmentsByChannel[ch] || []).some(seg =>
        (seg.envelopeV != null && over15(envelopes.v && envelopes.v[seg.envelopeV])) ||
        (seg.envelopeVr != null && seg.envelopeVr !== 255 && over15(vrTableOfTop(seg.envelopeVr)))));

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

    // バイトコードの1バイトに収まらない番号・値の検査(2026-09-19)。以前は黙って下位ビットに切り詰め
    // (または -128〜127 等へ丸め)ていたため、別のテーブル・波形を選んだり値が変わったりして、NSFだけが
    // JS再生と違う音になっていた(KSS→MMLで @v を370種類使う曲: 256番目以降が先頭のテーブルを指した)。
    // 書き出しを止めて理由を返す(main.js / mml-check.js は asmErrors を表示する)
    const limitErrors = checkBytecodeLimits(compileResult, channelLetters, expansionLetterMap, envelopes, {
      envIndexList, vrIndexList, epIndexList, mpIndexList, enIndexList, dutyIndexList
    });
    if (limitErrors.length > 0) {
      return { nsfBytes: null, asmErrors: limitErrors, bankCount: 0, unsupportedExpansions };
    }

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

    // SA<num>(N163ピッチシフト量、2026-08-26、ppmckcのpitch_shift_amount相当)。
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

    // @n<num>(直接周波数指定、2026-09-19)。使う曲にだけ DIRACT/DIRLO/DIRHI・RD_DIRECT・LOOKUP の分岐を入れる
    // (使わない曲のNSFは従来とバイト単位で同じ)
    let usesDirect = false;
    for (const ch of channelLetters) {
      if ((segmentsByChannel[ch] || []).some(seg => seg.directPeriod != null && seg.freq != null)) { usesDirect = true; break; }
    }

    // o9 の段の表(2026-09-19、NOTE_TABLE_SIZE_WIDE 参照)。周期表ごとに「曲が実際に引く最大のノート索引」を求め、
    // buildFixedSource がそれを見て 108音/120音を決める。索引は 6502 側と同じ規則で数える:
    //  ・音符・タイの異音程(pitchBreaks)・SD の差し替え先・PS のグライド元のノート番号(compiler.js が0〜119に収めている)
    //  ・EN 中はそれに累積オフセットを足した値(8bit加算で bit7 が立てば0、compiler.js enTableNote と同じ)
    // EN は PS の音符で前の音符から続くので、直前のアタックからの経過フレームぶんまで見る(実際より広めに数えるのは
    // 表が大きくなるだけで安全。狭く数えると JS 再生と食い違うので、迷うときは広い側に倒している)。
    // @n の音符は表を引かない(DIRACT)。FME7 のトーン無し(@0/@2)の音符もトーン周期を鳴らさないので数えない
    const noteTableKeyOf = { A: 'pulse', B: 'pulse', C: 'tri' };
    (expansionLetterMap.vrc6 || []).forEach((L, k) => { noteTableKeyOf[L] = k === 2 ? 'saw' : 'pulse'; });
    (expansionLetterMap.mmc5 || []).forEach(L => { noteTableKeyOf[L] = 'pulse'; });
    (expansionLetterMap.fme7 || []).forEach(L => { noteTableKeyOf[L] = 'fme7'; });
    (expansionLetterMap.fds || []).forEach(L => { noteTableKeyOf[L] = 'fds'; });
    (expansionLetterMap.n163 || []).forEach(L => { noteTableKeyOf[L] = 'n163'; });
    (expansionLetterMap.vrc7 || []).forEach(L => { noteTableKeyOf[L] = 'vrc7'; });
    const tableTop = NOTE_TABLE_SIZE_WIDE - 1;
    const plainIdx = n => Math.max(0, Math.min(tableTop, Math.round(n)));
    const enIdx = n => { const v = ((Math.round(n) % 256) + 256) % 256; return v >= 128 ? 0 : Math.min(tableTop, v); };
    // EN テーブルの累積値列(compiler.js cumulativeEnvelopeValue と同じ: ループがあれば周回して足し続け、
    // 無ければ全体の合計で止まる)。必要な長さまで伸ばしながら使い回す
    const enCumCache = new Map();
    const enCumAt = (idx, table, t) => {
      let c = enCumCache.get(idx);
      if (!c) { c = { seq: [], sum: 0, pos: 0 }; enCumCache.set(idx, c); }
      const values = table.values || [];
      const loop = (table.loop != null && table.loop < values.length) ? table.loop : null;
      while (c.seq.length <= t) {
        if (c.pos < values.length) { c.sum += values[c.pos] | 0; c.pos++; }
        else if (loop != null) { c.pos = loop; c.sum += values[c.pos] | 0; c.pos++; }
        c.seq.push(c.sum);
      }
      return c.seq[t];
    };
    const noteReach = {};
    for (const ch of channelLetters) {
      const key = noteTableKeyOf[ch];
      if (!key) continue;
      let r = noteReach[key] != null ? noteReach[key] : -1;
      let frame = 0, attackFrame = 0;
      for (const seg of (segmentsByChannel[ch] || [])) {
        const dur = seg.durationFrames;
        if (seg.freq != null) {
          if (!seg.psGlide) attackFrame = frame;
          const fme7Tone = key !== 'fme7' || ((seg.instrument == null ? 1 : seg.instrument) & 1);
          if (fme7Tone) {
            const bases = [];
            if (seg.directPeriod == null && seg.noteNumber != null) bases.push(seg.noteNumber);
            for (const pb of (seg.pitchBreaks || [])) if (pb.noteNumber != null) bases.push(pb.noteNumber);
            if (seg.psGlide && seg.psGlide.fromNoteNumber != null) bases.push(seg.psGlide.fromNoteNumber);
            for (const b of bases) r = Math.max(r, plainIdx(b));
            const enTable = (seg.noteEnv != null && seg.noteEnv !== 255 && envelopes.en) ? envelopes.en[seg.noteEnv] : null;
            if (enTable && bases.length) {
              const span = frame - attackFrame + dur;
              for (let t = 0; t < span && r < tableTop; t++) {
                const e = enCumAt(seg.noteEnv, enTable, t);
                for (const b of bases) r = Math.max(r, enIdx(b + e));
              }
            }
          }
        }
        frame += dur;
      }
      noteReach[key] = r;
    }
    // バイトコードの1バイト形式音符の基点(mckBytecode.js NOTE_BASE_DEFAULT 参照)。2バイト形式で書く音符バイトに
    // 118/119(o9a+/o9b)がある曲だけ 0x78 にする(@n の代表値・PS のグライド先も音符バイトなので数える)。
    // E(DPCM)の音符バイトは @DPCM 番号+24 で、0x76 以上は定義の上限(63)を超えた未定義番号しかない
    // (serialize が基点未満へ切る。ドライバは未定義として何もしない)ので数えない
    const dpcmLetterSet = new Set(expansionLetterMap.dpcm || []);
    let noteBase = MML.NSF.MckBytecode.NOTE_BASE_DEFAULT;
    for (const ch of channelLetters) {
      if (dpcmLetterSet.has(ch)) continue;
      if ((segmentsByChannel[ch] || []).some(seg => seg.freq != null && seg.noteNumber != null &&
          Math.round(seg.noteNumber) >= MML.NSF.MckBytecode.NOTE_BASE_DEFAULT)) {
        noteBase = MML.NSF.MckBytecode.NOTE_BASE_WIDE;
        break;
      }
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
      dutyIndexRemap,
      // E(DPCM)は音量/音色オペコードを出さない(ppmck準拠で v/@ が無く、ドライバも見ない)
      { dpcm: (expansionLetterMap.dpcm || []).includes(ch), noteBase }));
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
    // 飛び越え、バンク0から真っ先に詰めていく(方針: データ領域として使えるなら
    // 真っ先に埋める)
    function layoutAllChannels(reservedBank) {
      const songBank = [], songAddrLo = [], songAddrHi = [];
      const allDataBanks = [];
      const loopAct = [], loopBank = [], loopLo = [], loopHi = [];
      let bankNum = 0, offsetInBank = 0;
      for (let i = 0; i < channelLetters.length; i++) {
        const layout = layoutChannelBanks(chBytes[i], bankNum, offsetInBank, chSerialized[i].loopByteOffset, reservedBank, noteBase);
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
    // ★L(ループ地点)を使う曲は、計測にも同じ形のループ情報を渡す(2026-09-19)。以前は undefined を渡していたので
    //   計測時だけループ用のコードと表(SONG_LOOP_*)が入らず、本番のほうが数十バイト大きくなった。ドライバが
    //   バンク境界をまたぐ曲で「計測時と再アセンブル時でサイズが一致しません」の内部エラーになる
    //   (Crisis Force をループ自動検出つきで変換したMMLで発覚: 4062 → 4115 バイト)
    const probeLoop = { act: chSerialized.map(r => (r.loopByteOffset != null ? 1 : 0)), bank: dummyBank, lo: dummyBank, hi: dummyBank };
    const probeSrc = buildFixedSource(channelTypes, dummyBank, usedExpansions, envelopes, dpcmLayout, dpcmSamples, envIndexList,
      probeLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak, usesSmooth, usesPitchShift, usesRawWrite,
      vrIndexList, enIndexList, dutyIndexList, usesRelTone, dummyBank, dummyBank, usesDetune, undefined, usesSweep, usesPitchSa, 0, usesDirect, noteReach, noteBase, volMask4);
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
          asmErrors: [{ lineNo: 0, message: tr('ドライバ本体が{size}バイトあり、割当領域(バンク0-3、{limit}バイト)を超えています。' +
            'カスタム音色/波形の定義数を減らしてください(DPCM使用時はバンク4-7がサンプル専用のため、ドライバはバンク0-3に収める必要があります)',
            { size: probeAsm.bytes.length, limit: DRIVER_CODE_LIMIT }) }],
          bankCount: 0,
          unsupportedExpansions
        };
      }
      // DPCMサンプル本体は16KBの「ページ」ごとに$C000から連続配置される(layoutDpcmSamples)。
      // 最後のページは実際に使っている末尾までのバンク数だけ、それより前のページは4バンク丸ごと
      // 確保する(トリガー時に窓4-7をページ単位でまとめて切り替えるため。2026-09-10)
      const endByPage = [];
      for (const idx of Object.keys(dpcmLayout)) {
        const layout = dpcmLayout[idx];
        const pg = layout.page | 0;
        endByPage[pg] = Math.max(endByPage[pg] || 0, layout.addr - 0xC000 + layout.bytes.length);
      }
      const lastPage = endByPage.length - 1;
      dpcmBanks = lastPage * DPCM_PAGE_BANKS + Math.max(1, Math.ceil((endByPage[lastPage] || 0) / BANK_SIZE));
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

    const src = buildFixedSource(channelTypes, songBank, usedExpansions, envelopes, dpcmLayout, dpcmSamples, envIndexList, songLoop, epIndexList, mpIndexList, usesPortamento, usesPitchBreak, usesSmooth, usesPitchShift, usesRawWrite, vrIndexList, enIndexList, dutyIndexList, usesRelTone, songAddrLo, songAddrHi, usesDetune, driverOrg, usesSweep, usesPitchSa, dpcmFileBank, usesDirect, noteReach, noteBase, volMask4);
    const asm = MML.Asm.assemble(src, { origin: 0x8000 });
    if (asm.errors.length > 0) {
      return { nsfBytes: null, asmErrors: asm.errors, bankCount: 0, unsupportedExpansions };
    }
    const driverBytes = asm.bytes.slice(driverOrg - 0x8000);
    if (driverBytes.length > driverCodeBanks * BANK_SIZE) {
      return {
        nsfBytes: null,
        asmErrors: [{ lineNo: 0, message: tr('内部エラー: ドライバ本体のサイズが計測時({a}バイト)と再アセンブル時({b}バイト)で一致しません',
          { a: probeAsm.bytes.length - BANK_SIZE, b: driverBytes.length }) }],
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
      if (layout.shared) continue; // 同じファイルを共有する定義(compiler.js layoutDpcmSamples)。本体は共有元が焼く
      programBytes.set(layout.bytes, (dpcmFileBank + (layout.page | 0) * DPCM_PAGE_BANKS) * BANK_SIZE + (layout.addr - 0xC000));
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
      // DPCMは初期状態でページ0を窓4-7へ(2ページ以上ある曲はトリガー時にドライバが切り替える)
      if (dpcmUsed && w >= DATA_DPCM_BANK && w < DATA_DPCM_BANK + Math.min(DPCM_PAGE_BANKS, dpcmBanks)) return dpcmFileBank + (w - DATA_DPCM_BANK);
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
    for (const idx of Object.keys(dpcmLayout)) if (!dpcmLayout[idx].shared) dpcmBytes += dpcmLayout[idx].bytes.length;
    return {
      nsfBytes, asmErrors: [], bankCount: Math.ceil(programBytes.length / BANK_SIZE),
      unsupportedExpansions,
      driverBytes: driverBytes.length,
      songDataBytes: chBytes.reduce((s, b) => s + b.length, 0),
      dpcmBytes
    };
  };
})(window);
