/*
 * ppmck方式のコンパクトなバイトコードでMMLの音符セグメント列をシリアライズする。
 * MML.Mml.compile()が返すフレーム単位レジスタ書き込みログ(tracks)は、そのまま
 * NSFへ書き出すには32KBを簡単に超えて非現実的なため採用しない(ROADMAP.mdフェーズ1.6)。
 * 代わりに、音符1個を基本2〜3バイトで表現できるコマンドバイト列形式を使う。
 *
 * オペコード(ppmck実機ソース https://github.com/munshkr/ppmck の
 * src/ppmckc/mckc.h ・ nes_include/ppmck/internal.h ・各拡張音源.h を実測して採用。
 * 値は実機と同一。全チャンネル種別(2A03パルス/三角/ノイズ・VRC6・VRC7・FDS・N106・
 * FME7・MMC5)が共有するコア命令セットで、実機もこの命令セットを全チップ共通で
 * 使い回している):
 *   0x00-0xF0 : 音符(音程)。直後1バイトが音長(フレーム数、1-255)
 *   0xF4      : ウェイト。直後1バイトがフレーム数を直前のイベントへ加算する
 *               (256以上の音長を255バイトずつに分割して継続するために使う)
 *   0xF7      : ノートエンベロープ(EN)選択。次バイトはインデックス(255=off)
 *   0xF8      : ピッチエンベロープ(EP)選択。次の2バイトが[インデックス(255=off),delay]。
 *               delayはEP<n>,<delay>のdelayフレーム数(0-255、2026-08-11 別プロジェクトA。
 *               ppmck本家仕様には無いこのツール独自の拡張。offでも固定長デコードのため
 *               2バイト目を読む、値は無視される)
 *   0xF9      : ポルタメント(PT)選択。次の4バイトが[target下位,target上位(符号付き16bit
 *               LE、D<n>と同じ),duration,delay]。offはduration=0を番兵とする
 *               (2026-08-11 別プロジェクトC。ppmck本家ドキュメント(doc/mck.txt)には
 *               専用のポルタメントコマンドが無く「ピッチエンベロープ(EP)で代用してください」
 *               と明記されているため、このツール独自の拡張。実機では0xF9は生ハードウェア
 *               スイープ書込み用に予約された値だが、本ツールのsweepはソフトウェア近似で
 *               バイトコード化されておらず(実質未使用)、こちらに転用した)
 *   0xED      : タイ(&)による異音程レガート(ピッチブレーク)。次の2バイトが
 *               [新しいノート番号(0-0xEC),音長(フレーム数、1-255)]。音符アタック
 *               (WRITE_FREQ_VOL、音量/エンベロープ/EP・MP・PTの再初期化を伴う)を
 *               一切行わず、周期/周波数レジスタだけをその場で書き替える
 *               (WRITE_FREQ_ONLYを流用、D<n>/EP/MP/PTの継続フレーム再計算と全く同じ
 *               経路。2026-08-12、compiler.jsのpitchBreaks/activePitchAt参照)。
 *               ★NOTE_MAXを0xEDから0xECへ1つ下げてこの値を確保した(実際に使われる
 *               ノート番号の範囲には遠く届かない、既存のNOTE_MAX切り下げの延長)
 *   0xFB      : ビブラート(MP)選択。次バイトはインデックス(255=off)
 *   0xFC      : 休符。直後1バイトがフレーム数
 *   0xFD      : 音量直接指定。次バイトは 0x80|(0-15)。このチャンネルのソフトウェア
 *               音量エンベロープ(下記0xF3)を解除する(compiler.js側の明示的なv<n>が
 *               state.envelopeVをnullクリアするのと同じ意味)
 *   0xFE      : 音色(デューティ/音色番号)直接指定。次バイトは 0x80|値
 *   0xFF      : トラック終端
 *
 * チップ固有の追加オペコード:
 *   0xF0      : VRC7カスタム音色再ロード(OP<n>、音符に紐付かない即時イベント)。
 *               次バイトは 0x80|(音色テーブルindex 0-127)。本実装の独自拡張
 *               (実機ppmckにも同種のオペコードはあるが値は異なる)
 *   0xF5      : FDSモジュレーション再ロード(MH<n>/MHOF、音符に紐付かない即時イベント)。
 *               次バイトは@MH<n>のn(0-254)、255ならMHOF(モジュレーション停止=$4084に
 *               gain0を書くだけ)。本実装の独自拡張(実機ppmckに同種オペコードは無い)
 *   0xF1      : ノイズ周波数(N<n>、FME7)。次バイトは0-31
 *   0xF2      : ハードウェアエンベロープ(FME7)。次の3バイトが[形状,周期下位,周期上位]
 *               (実機は形状と周期を別オペコードに分けて2回書くが、本実装はデータ量を
 *               減らすため1つのオペコードにまとめている。実機とは非互換の独自拡張)
 *   0xF3      : ソフトウェア音量エンベロープ(@v<n>)選択。本実装の独自拡張(実機ppmckには
 *               無い)。次バイトはremap後のコンパクトなテーブル番号(0-254、曲中で実際に
 *               使われているenvelopeVだけを詰めた番号。src/driver/ppmckDriver.jsが
 *               ROM上に埋め込むENV_PTR_LO/HI等のテーブルへの添字と一致させる)。
 *               このチャンネルの次の音符から有効になり、音符が続く間は6502ドライバ側が
 *               毎フレーム値を進める(ノートオンでtick=0にリセット、テーブル終端は
 *               ループ指定が無ければ末尾保持、あればループ位置へ戻る)。0xFDで解除される
 *
 * 音符バイトの音程エンコードのみ実機と異なる: 実機は4bit音名+4bitオクターブ
 * シフト(右シフト1回=1オクターブ上げ)というテーブル参照+シフト方式だが、
 * 本実装ではMML.Mml.compile()が既に計算しているnoteNumber(octave*12+semitone、
 * c=0)をそのままバイト値として使う(0-0xF0=0-240の範囲に収まり十分な音域がある。
 * 0xF1以降はFME7拡張オペコード等と衝突するため使わない)。
 * オペコードのバイト値と「音符+音長を最小単位にするコンパクトなバイトコード」という
 * 設計思想は実機と揃えているが、生成したバイト列そのものは実機ppmckcの出力とは
 * バイナリ互換ではない。
 *
 * segmentsByChannel(Mml.compile()の戻り値)はチャンネル種別に関わらず同じ形の
 * セグメント列(buildSegments()の出力)なので、このシリアライザは2A03/拡張音源
 * すべてのチャンネルに共通で使える(音源固有のレジスタ変換は行わず、MML上の値
 * (noteNumber・volume・instrument・各種インデックス)をそのまま記録する。
 * 実際のレジスタ値への変換は再生側=6502ドライバの仕事になる)。
 *
 * 未対応(ROADMAP.mdフェーズ1.6タスク1の続き、意図的に見送っている理由をそれぞれ記載):
 *   - ループ([...]n → 0xA0/0xA1): 実機のループ命令はジャンプ先アドレス(バンク+
 *     オフセット)を埋め込む方式で、これは最終的なROM上のバイト配置が決まらないと
 *     生成できない(0xEEのバンク切り替えと同じ仕組みを流用しているため)。つまり
 *     「セグメント列→バイト列」の変換だけでは完結せず、ドライバ組み立て・ROM配置
 *     (タスク2-4)の段階で扱うべき機能であり、本タスク(タスク1)の対象外とする。
 *     現状はコンパイラ側で既にループを展開済み(expandLoops)のセグメント列をそのまま
 *     線形にシリアライズする(サイズは大きくなるがループの有無で再生内容は変わらない)。
 *   - スイープ(0xF9): 本ツールのsweep実装はソフトウェア近似(半音オフセットを毎フレーム
 *     計算する方式)であり、実機の生ハードウェアスイープレジスタ直接書き込み(0xF9)とは
 *     表現形式が異なるため、そのまま流用できない。
 *   - デチューン(0xFA、D<n>): 2026-07-24実装完了。compiler.jsが算出した周期/周波数
 *     レジスタ値への生オフセットをそのまま2バイト(符号付き16bit、リトルエンディアン)で
 *     書き出す(0xF9のスイープと違い、こちらは単純な加算オフセットなのでバイトコード化に
 *     表現形式のギャップが無い)。6502ドライバ側(src/driver/ppmckDriver.js)のAPPLY_DETUNE
 *     (2A03/VRC6/MMC5/FME7/FDS共通)・APPLY_DETUNE_N163(N163専用、3バイト精度)が
 *     実際の加算・負方向クランプを行う。実機6502エミュレータ上でのNSF書き出し往復
 *     検証済み(全対応チップで期待通りの周期差、高音+大きな負のデチューンでも
 *     0クランプでラップアラウンドしないことを確認)。
 *   - DPCM: フェーズ1.7でチャンネル文字の割当・NSF書き出し(TYPE_DPCM)まで実装済み
 *     (このコメントは実装前に書かれたまま更新されていなかった。DPCMチャンネルの
 *     セグメント列も他チップと同じくこのserialize()を通る。noteByteはdpcm_dataの
 *     インデックスではなく音符音高そのもので、レートインデックスへの変換は
 *     src/driver/ppmckDriver.jsのTYPE_DPCMハンドラが行う)。
 *   - FDSの`MH<n>`(曲中の変調再ロード)はVRC7の`OP<n>`(0xF0)と同じ音符に紐付かない
 *     即時コマンドとして0xF5オペコードで対応する(下記OP_FDS_MOD_RELOAD参照)。
 *   - L(ループ地点マーカー): 2026-08-09実装。serialize()はloopFrame引数を受け取り、
 *     対応するバイト列オフセット(loopByteOffset)を返すだけ。実際のジャンプ命令の
 *     生成・アドレス解決はROM配置が決まった後でないとできない(0xEEバンクジャンプと
 *     同じ理由)ため、src/driver/ppmckDriver.js側(layoutChannelBanks/buildFixedSource)の
 *     責務とする。
 *   - EP(0xF8、ピッチエンベロープ)・MP(0xFB、ビブラート)デチューン(0xFA)と
 *     全く同じ「発音周波数レジスタへの生オフセット加算」空間を共有するため(compiler.jsの
 *     pitchRegisterOffset参照)、6502ドライバ側もAPPLY_DETUNE自体を拡張してD<n>と
 *     一緒に加算する設計を取る。EP_LOOKUP/LFO_SUB・WRITE_FREQ_ONLY(継続フレームの
 *     周期/周波数レジスタ再書込み専用、音符アタック時のWRITE_FREQ_VOLとは別経路)は
 *     src/driver/ppmckDriver.js参照。pitchEnvIndexRemap/vibratoIndexRemapで
 *     曲中の使用インデックスだけをROMへコンパクトに詰める(envIndexRemapと同じ方式)。
 *   - EN(0xF7、ノートエンベロープ=アルペジオ)は引き続き未実装(オペコードを読み捨てるだけ、
 *     RD_SKIP1)。EN/EP/MPのうちEP/MPを優先実装した経緯はメモリ
 *     (ppmck-nsf-export-en-ep-mp-implementation-plan)参照。ENはノート番号空間への
 *     加算(周期/周波数レジスタ空間のD/EP/MPとは別のノート単位の値の重ね方)が必要で
 *     設計が別になるため、別途対応する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const NSF = MML.NSF = MML.NSF || {};
  const MckBytecode = NSF.MckBytecode = NSF.MckBytecode || {};

  const OP_NOTE_ENV = 0xf7;
  const OP_PITCH_ENV = 0xf8;
  // PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC)。次の4バイトが
  // [target下位,target上位(符号付き16bit LE、D<n>と同じ),duration,delay]。offはduration=0を
  // 番兵とする(実際のポルタメントはduration>=1が必須、src/convert/pitch.jsのfitPortamento
  // 参照)。★0xF9は実機ppmckでは生ハードウェアスイープ書込み用に予約された値だが、
  // 本ツールのsweepはソフトウェア近似でバイトコード化されていない(下記「未対応」節参照、
  // 実質未使用)ため、このツール独自拡張のポルタメントに転用した
  const OP_PORTAMENTO = 0xf9;
  const OP_DETUNE = 0xfa; // D<n>デチューン選択。次の2バイトが符号付き16bit値(下位,上位、リトルエンディアン)
  const OP_VIBRATO = 0xfb;
  const OP_WAIT = 0xf4;
  const OP_REST = 0xfc;
  const OP_VOL = 0xfd;
  const OP_VOL_ENV = 0xf3; // ソフトウェア音量エンベロープ(@v<n>)選択。本実装の独自拡張
  const OP_TONE = 0xfe;
  const OP_END = 0xff;
  // タイ(&)による異音程レガート(2026-08-12)。次の2バイトが[新ノート番号,音長]。
  // アタック(音量/エンベロープ/EP・MP・PT再初期化)を伴わずに周期/周波数レジスタだけを
  // その場で書き替える。ファイル冒頭コメント参照
  const OP_PITCH_BREAK = 0xed;
  // 注意: NOTE_MAXは全オペコードより小さくすること。元は0xF3だったが、
  // 0xF1/0xF2(FME7拡張)と重複し得るバグのため0xF0に修正し、さらに
  // バンク切り替え(0xEE、src/driver/ppmckDriver.js側でシリアライズ後に挿入する
  // バンクジャンプマーカー)とも重複しないよう0xEDまで下げていた。2026-08-12、
  // タイの異音程レガート(OP_PITCH_BREAK=0xED)用にもう1つ確保するため0xECまでさらに
  // 下げた(実際に使われるノート番号の範囲には遠く届かない安全な切り下げ)
  const NOTE_MAX = 0xec;

  // FME7専用の追加オペコード(実機と非互換の独自拡張。ファイル冒頭コメント参照)
  const OP_FME7_NOISE = 0xf1;
  const OP_FME7_HARDENV = 0xf2;
  // VRC7専用: OP<n>(曲中のカスタム音色再ロード、音符に紐付かない即時イベント)。
  // 次バイトは 0x80|(音色テーブルindex, 0-127)。serialize()の第2引数
  // immediateWrites(kind:'vrc7Tone')から、対応するフレーム位置のセグメント直前に挿入する
  const OP_VRC7_TONE_RELOAD = 0xf0;
  // FDS専用: MH<n>/MHOF(曲中のモジュレーション再ロード、音符に紐付かない即時イベント)。
  // 次バイトは@MH<n>のn(0-254)、255=MHOF
  const OP_FDS_MOD_RELOAD = 0xf5;
  const FDS_MOD_OFF = 0xff;
  // N163専用: 共有バッファアロケータ(src/mml/n163Alloc.js)が決めた波形のRAM上の
  // バイト位置再設定(曲中の再ロード、音符に紐付かない即時イベント)。次バイトは
  // byteOffset(0-63)。波形の中身自体は既存のOP_TONE(音色番号)切替検出で選ぶので、
  // このオペコードは「行き先」だけを運ぶ
  const OP_N163_WAVE_RELOAD = 0xf6;

  // 音長(フレーム数)を、255ずつのチャンクに分割して書き込む。
  // 最初のチャンクはそのまま直後に、2つ目以降は 0xF4(ウェイト) + チャンクの形で続ける
  function pushLength(bytes, frames) {
    let rest = Math.max(0, Math.round(frames));
    if (rest > 0xff) {
      bytes.push(0xff);
      rest -= 0xff;
    } else {
      bytes.push(rest);
      return;
    }
    while (rest > 0) {
      bytes.push(OP_WAIT);
      if (rest > 0xff) {
        bytes.push(0xff);
        rest -= 0xff;
      } else {
        bytes.push(rest);
        rest = 0;
      }
    }
  }

  // segments: buildSegments()と同じ形の音符セグメント列
  // (MML.Mml.compile()の戻り値の segmentsByChannel['A'] 等)。
  // 2A03・拡張音源共通(チップ固有レジスタへの変換はしない。ファイル冒頭コメント参照)。
  // immediateWrites: 省略可。compile()の戻り値のimmediateWritesByChannel[ch]
  // (音符に紐付かないOP<n>=VRC7カスタム音色再ロード等)。kind:'vrc7Tone'のみ対応
  // (frame位置はセグメントの累積durationFrames境界と必ず一致する。buildSegments()が
  // OP<n>トークン処理時点のelapsedFramesをそのまま記録しており、OP<n>自体は時間を
  // 消費しないため)。value===255(OPOF相当)はcompiler.js側の解釈と合わせ無視する
  // envIndexRemap: 省略可。{元のenvelopeV値: ROM上のコンパクトなテーブル番号(0始まり)}。
  // src/driver/ppmckDriver.jsが曲全体で実際に使われているenvelopeV値だけを詰めて
  // 採番したもの(0-99のソフトウェア由来・100番台のハードウェア由来を区別せず同じ
  // 番号空間として扱う)。省略時(nullや未指定のenvelopeVは)常にプレーン音量(OP_VOL)
  // として出力する
  // loopFrame: 省略可。Lコマンド(ループ地点マーカー)が出現した時点のフレーム数
  // (compiler.js buildSegments()の戻り値のloopFrame、このチャンネル自身の値)。
  // 指定された場合、そのフレーム位置に対応するバイト列中のオフセットを
  // 戻り値のloopByteOffsetとして返す(src/driver/ppmckDriver.jsがNSFバンク配置後の
  // 実アドレスへ変換し、トラック終端でそこへジャンプする本当の無限ループを組み立てる)。
  // 戻り値は従来のUint8Arrayではなく{ bytes, loopByteOffset }になる点に注意
  // (呼び出し元はsrc/driver/ppmckDriver.jsのみ)
  // pitchEnvIndexRemap/vibratoIndexRemap: 省略可。envIndexRemapと同じ考え方で、曲全体で
  // 実際に使われているEP<n>/MP<n>のインデックスだけを詰めて0始まりで再採番したもの
  // (2026-08-11、EN/EP/MPのNSF書き出し実装。src/driver/ppmckDriver.jsのEP_LEN/EP_PTR等・
  // MP_DELAY/MP_SPEED/MP_DEPTHテーブルの添字と一致させる)。省略時は元のインデックスを
  // そのまま使う(255=off はremap対象外で常にそのまま)。remapが渡されているのに対応する
  // エントリが無い(未定義のEP<n>/MP<n>を参照)場合はオペコード自体を出力しない
  // (compiler.js側もそのセグメントは効果0として扱うため、無出力=無効果で整合する)
  MckBytecode.serialize = function (segments, immediateWrites, envIndexRemap, loopFrame, pitchEnvIndexRemap, vibratoIndexRemap, noteEnvIndexRemap) {
    const bytes = [];
    let loopByteOffset = null;
    let lastVolume = null;
    let lastVolMode = null; // 'plain' | 'env' | 'fme7env' (src/convert/mmlEmit.jsのcurVolModeと
                             // 同じ考え方。モード切替時は値/番号が前回と同じでも必ず出し直す)
    let lastEnvIdx = null;
    let lastTone = null;
    let lastNoteEnv = null;
    let lastPitchEnv = null;
    let lastPitchEnvDelay = null; // EP<n>,<delay>のdelay(2026-08-11 別プロジェクトA)
    let lastPortamentoTarget = null, lastPortamentoDuration = 0, lastPortamentoDelay = 0; // 別プロジェクトC
    let lastVibrato = null;
    let lastFme7Noise = null;
    let lastFme7EnvShape = null;
    let lastFme7EnvPeriod = null;
    let lastDetune = 0; // D<n>の既定値は0(compiler.jsのstate.detune初期値と同じ)

    const tonereloads = (immediateWrites || [])
      .filter(iw => iw.kind === 'vrc7Tone' && iw.value !== 255)
      .slice()
      .sort((a, b) => a.frame - b.frame);
    let tonereloadIdx = 0;
    let elapsed = 0;
    const flushToneReloadsUpTo = (frame) => {
      while (tonereloadIdx < tonereloads.length && tonereloads[tonereloadIdx].frame <= frame) {
        bytes.push(OP_VRC7_TONE_RELOAD, 0x80 | (tonereloads[tonereloadIdx].value & 0x7f));
        tonereloadIdx++;
      }
    };

    // FDSのMH<n>/MHOF。VRC7のOP<n>と違い255(MHOF)も意味のある値(モジュレーション
    // 停止)なのでフィルタで除外しない
    const modreloads = (immediateWrites || [])
      .filter(iw => iw.kind === 'fdsMod')
      .slice()
      .sort((a, b) => a.frame - b.frame);
    let modreloadIdx = 0;
    const flushModReloadsUpTo = (frame) => {
      while (modreloadIdx < modreloads.length && modreloads[modreloadIdx].frame <= frame) {
        const v = modreloads[modreloadIdx].value;
        bytes.push(OP_FDS_MOD_RELOAD, v === 255 ? FDS_MOD_OFF : (v & 0xff));
        modreloadIdx++;
      }
    };

    // N163共有バッファアロケータが決めたbyteOffsetの再設定(kind:'n163WaveReload')
    const n163reloads = (immediateWrites || [])
      .filter(iw => iw.kind === 'n163WaveReload')
      .slice()
      .sort((a, b) => a.frame - b.frame);
    let n163reloadIdx = 0;
    const flushN163ReloadsUpTo = (frame) => {
      while (n163reloadIdx < n163reloads.length && n163reloads[n163reloadIdx].frame <= frame) {
        bytes.push(OP_N163_WAVE_RELOAD, n163reloads[n163reloadIdx].value & 0xff);
        n163reloadIdx++;
      }
    };

    for (const seg of segments) {
      flushToneReloadsUpTo(elapsed);
      flushModReloadsUpTo(elapsed);
      flushN163ReloadsUpTo(elapsed);
      // このセグメントの開始位置がちょうどLの位置なら、これから出力するバイト列の
      // 先頭(=このセグメントの最初のオペコード)をループ入り口として記録する。
      // buildSegments()のloopFrameはセグメント境界上のelapsedFramesをそのまま
      // 記録したものなので、ここでのelapsed(このセグメントを加算する前の値)と
      // 必ず一致する
      if (loopFrame != null && loopByteOffset == null && elapsed === loopFrame) {
        loopByteOffset = bytes.length;
      }
      elapsed += seg.durationFrames;
      const gateDenom = seg.gateDenom || 8;
      const gate = seg.gate == null ? 8 : seg.gate;
      const gateFrames = seg.qFrames != null
        ? Math.max(1, seg.durationFrames - seg.qFrames)
        : Math.max(1, Math.round(seg.durationFrames * (gate / gateDenom)));

      if (seg.freq != null) {
        // 音量の指定方法は3つ排他で、compiler.jsのsegmentsToWriteLogFme7と同じ優先順位
        // (FME7ハードウェアエンベロープ > ソフトウェア音量エンベロープ > 固定音量)。
        // ハードウェアエンベロープ中はVOL/VOL_ENVを出さない(6502側はこれらのオペコードで
        // ハードウェアエンベロープを解除するため。compiler.js側もv<n>でのみ解除される)
        const remapIdx = (envIndexRemap && seg.envelopeV != null && seg.fme7EnvShape == null)
          ? envIndexRemap[seg.envelopeV] : undefined;
        if (seg.fme7EnvShape != null) {
          const period = seg.fme7EnvPeriod || 0;
          // モードが切り替わった直後は形状・周期が前回と同じでも必ず出し直す
          // (6502側はOP_VOL/OP_VOL_ENVでハードウェアエンベロープを解除しているため)
          if (seg.fme7EnvShape !== lastFme7EnvShape || period !== lastFme7EnvPeriod ||
              lastVolMode !== 'fme7env') {
            bytes.push(OP_FME7_HARDENV, seg.fme7EnvShape & 0x0f, period & 0xff, (period >> 8) & 0xff);
            lastFme7EnvShape = seg.fme7EnvShape;
            lastFme7EnvPeriod = period;
          }
          lastVolMode = 'fme7env';
        } else if (remapIdx !== undefined) {
          // ソフトウェア音量エンベロープ選択。モードが切り替わった直後は番号が前回と
          // 同じでも必ず出し直す(6502ドライバ側もOP_VOLでENVACTをクリアするため、
          // 出し直さないとエンベロープが再度有効化されない)
          if (remapIdx !== lastEnvIdx || lastVolMode !== 'env') {
            bytes.push(OP_VOL_ENV, remapIdx & 0xff);
            lastEnvIdx = remapIdx;
          }
          lastVolMode = 'env';
        } else {
          const volume = Math.max(0, Math.min(15, seg.volume));
          if (volume !== lastVolume || lastVolMode !== 'plain') {
            bytes.push(OP_VOL, 0x80 | volume);
            lastVolume = volume;
          }
          lastVolMode = 'plain';
        }
        const tone = seg.instrument || 0;
        if (tone !== lastTone) {
          bytes.push(OP_TONE, 0x80 | (tone & 0x7f));
          lastTone = tone;
        }
        if (seg.noteEnv != null && seg.noteEnv !== lastNoteEnv) {
          // @v<n>/EP<n>と同じ「実際に使われているインデックスだけをコンパクトに詰める」方式
          // (2026-08-14実装)。255(ENOF)はそのまま素通し(remapテーブルには存在しない値)。
          const ne = seg.noteEnv === 255 ? 255
            : (noteEnvIndexRemap ? noteEnvIndexRemap[seg.noteEnv] : seg.noteEnv);
          if (ne != null) {
            bytes.push(OP_NOTE_ENV, ne & 0xff);
            lastNoteEnv = seg.noteEnv;
          }
        }
        // EP<n>,<delay>(2026-08-11 別プロジェクトA): 番号だけでなくdelayも音符ごとの状態
        // なので、番号が前回と同じでもdelayが違えば出し直す(src/convert/mmlEmit.jsの
        // curPitchEp/curPitchEpDelay判定と同じ理由)。offはdelayの概念が無いので0固定で
        // 出す(6502側は常に2バイト固定長で読むためoff時も1バイト分空読みが必要)。
        const pitchEnvDelay = seg.pitchEnv === 255 ? 0 : Math.max(0, Math.min(255, seg.pitchEnvDelay || 0));
        if (seg.pitchEnv != null && (seg.pitchEnv !== lastPitchEnv || pitchEnvDelay !== lastPitchEnvDelay)) {
          const pe = seg.pitchEnv === 255 ? 255
            : (pitchEnvIndexRemap ? pitchEnvIndexRemap[seg.pitchEnv] : seg.pitchEnv);
          if (pe != null) {
            bytes.push(OP_PITCH_ENV, pe & 0xff, pitchEnvDelay & 0xff);
            lastPitchEnv = seg.pitchEnv;
            lastPitchEnvDelay = pitchEnvDelay;
          }
        }
        if (seg.vibrato != null && seg.vibrato !== lastVibrato) {
          const mp = seg.vibrato === 255 ? 255
            : (vibratoIndexRemap ? vibratoIndexRemap[seg.vibrato] : seg.vibrato);
          if (mp != null) {
            bytes.push(OP_VIBRATO, mp & 0xff);
            lastVibrato = seg.vibrato;
          }
        }
        // PT<target>,<duration>[,<delay>](2026-08-11 別プロジェクトC): src/convert/mmlEmit.jsの
        // curPortamentoTarget/Duration/Delay判定と同じく3値まとめて前回状態と比較する
        // (targetが同じでもduration/delayが違えば出し直す)。offはduration=0の番兵で表す。
        {
          const pt = seg.portamento || null;
          const ptTarget = pt ? pt.target : null;
          const ptDuration = pt ? pt.duration : 0;
          const ptDelay = pt ? (pt.delay || 0) : 0;
          if (ptTarget !== lastPortamentoTarget || ptDuration !== lastPortamentoDuration ||
              ptDelay !== lastPortamentoDelay) {
            const t16 = (ptTarget || 0) & 0xffff;
            bytes.push(OP_PORTAMENTO, t16 & 0xff, (t16 >> 8) & 0xff, ptDuration & 0xff, ptDelay & 0xff);
            lastPortamentoTarget = ptTarget;
            lastPortamentoDuration = ptDuration;
            lastPortamentoDelay = ptDelay;
          }
        }
        const detune = seg.detune || 0;
        if (detune !== lastDetune) {
          // 符号付き16bit、リトルエンディアン(6502側は2バイトの通常のADC加算でそのまま
          // 符号付き値として扱える。詳細はsrc/driver/ppmckDriver.jsのAPPLY_DETUNE参照)
          const d16 = detune & 0xffff;
          bytes.push(OP_DETUNE, d16 & 0xff, (d16 >> 8) & 0xff);
          lastDetune = detune;
        }
        if (seg.fme7Noise != null && seg.fme7Noise !== lastFme7Noise) {
          bytes.push(OP_FME7_NOISE, seg.fme7Noise & 0x1f);
          lastFme7Noise = seg.fme7Noise;
        }

        const noteByte = Math.max(0, Math.min(NOTE_MAX, Math.round(seg.noteNumber)));
        bytes.push(noteByte);
        // タイ(&)で異音程へレガートしたセグメント(compiler.jsのpitchBreaks)は、
        // ゲートオフ(OP_REST)と同じく「このセグメント内の相対フレーム位置」の
        // マーカーとして扱う。両方を時系列でマージし、各区間の長さをpushLengthで
        // 書いてから区切りのオペコード(ゲートオフ=OP_REST/ピッチブレーク=
        // OP_PITCH_BREAK+新ノート番号)を出す(2026-08-12)。pitchBreaksが無ければ
        // 従来通りOP_REST 1箇所だけの分岐になる
        const breakpoints = [];
        if (seg.pitchBreaks) {
          for (const pb of seg.pitchBreaks) {
            if (pb.atFrame > 0 && pb.atFrame < seg.durationFrames) {
              breakpoints.push({ atFrame: pb.atFrame, kind: 'pitch', noteNumber: pb.noteNumber });
            }
          }
        }
        if (gateFrames < seg.durationFrames) {
          breakpoints.push({ atFrame: gateFrames, kind: 'rest' });
        }
        breakpoints.sort((a, b) => a.atFrame - b.atFrame);
        let cursor = 0;
        for (const bp of breakpoints) {
          pushLength(bytes, bp.atFrame - cursor);
          cursor = bp.atFrame;
          if (bp.kind === 'rest') {
            bytes.push(OP_REST);
          } else {
            const nb = Math.max(0, Math.min(NOTE_MAX, Math.round(bp.noteNumber)));
            bytes.push(OP_PITCH_BREAK, nb);
          }
        }
        pushLength(bytes, seg.durationFrames - cursor);
      } else {
        bytes.push(OP_REST);
        pushLength(bytes, seg.durationFrames);
      }
    }
    flushToneReloadsUpTo(elapsed);
    flushModReloadsUpTo(elapsed);
    flushN163ReloadsUpTo(elapsed);
    // Lが曲(このチャンネル)の末尾ちょうどに置かれていた場合(末尾に音符が続かない)のための
    // 保険。この場合ループ先はOP_END自身になり、以降は無音のまま無限ループする
    if (loopFrame != null && loopByteOffset == null && elapsed === loopFrame) {
      loopByteOffset = bytes.length;
    }

    bytes.push(OP_END);
    return { bytes: new Uint8Array(bytes), loopByteOffset };
  };

  // シリアライズ結果を読み戻し、イベント列にする(往復テスト用。実際の6502ドライバの
  // 代わりにJSで同じ解釈をする)。noteEnv/pitchEnv/vibrato/fme7*はその時点で選択中の
  // 値として各noteイベントに載せる
  MckBytecode.deserialize = function (bytes) {
    const rawEvents = [];
    let i = 0;
    let volume = null, tone = null;
    let noteEnv = null, pitchEnv = null, pitchEnvDelay = 0, portamento = null, vibrato = null;
    let fme7Noise = null, fme7EnvShape = null, fme7EnvPeriod = null;
    let detune = 0;
    let envIdx = null; // OP_VOL_ENVで選択中のコンパクトなテーブル番号(nullならプレーン音量)

    while (i < bytes.length) {
      const b = bytes[i]; i++;
      if (b === OP_END) break;
      // OP_VOL/OP_VOL_ENVはFME7ハードウェアエンベロープも解除する(6502ドライバ側の
      // RD_VOL/RD_VOLENVがFMEEACTをクリアするのと同じ意味)
      if (b === OP_VOL) { volume = bytes[i] & 0x7f; envIdx = null; fme7EnvShape = null; i++; continue; }
      if (b === OP_VOL_ENV) { envIdx = bytes[i]; fme7EnvShape = null; i++; continue; }
      if (b === OP_TONE) { tone = bytes[i] & 0x7f; i++; continue; }
      if (b === OP_VRC7_TONE_RELOAD) {
        const toneIndex = bytes[i] & 0x7f; i++;
        rawEvents.push({ type: 'vrc7ToneReload', toneIndex });
        continue;
      }
      if (b === OP_FDS_MOD_RELOAD) {
        const v = bytes[i]; i++;
        rawEvents.push({ type: 'fdsModReload', mhIndex: v === FDS_MOD_OFF ? 255 : v });
        continue;
      }
      if (b === OP_N163_WAVE_RELOAD) {
        const byteOffset = bytes[i]; i++;
        rawEvents.push({ type: 'n163WaveReload', byteOffset });
        continue;
      }
      if (b === OP_NOTE_ENV) { noteEnv = bytes[i]; i++; continue; }
      if (b === OP_PITCH_ENV) { pitchEnv = bytes[i]; pitchEnvDelay = bytes[i + 1]; i += 2; continue; }
      if (b === OP_PORTAMENTO) {
        const t16 = bytes[i] | (bytes[i + 1] << 8);
        const target = t16 >= 0x8000 ? t16 - 0x10000 : t16;
        const duration = bytes[i + 2], delay = bytes[i + 3];
        i += 4;
        portamento = duration === 0 ? null : { target, duration, delay };
        continue;
      }
      if (b === OP_DETUNE) {
        const d16 = bytes[i] | (bytes[i + 1] << 8);
        detune = d16 >= 0x8000 ? d16 - 0x10000 : d16;
        i += 2;
        continue;
      }
      if (b === OP_VIBRATO) { vibrato = bytes[i]; i++; continue; }
      if (b === OP_FME7_NOISE) { fme7Noise = bytes[i]; i++; continue; }
      if (b === OP_FME7_HARDENV) {
        fme7EnvShape = bytes[i]; i++;
        fme7EnvPeriod = bytes[i] | (bytes[i + 1] << 8); i += 2;
        continue;
      }
      if (b === OP_REST) { const frames = bytes[i]; i++; rawEvents.push({ type: 'rest', frames }); continue; }
      if (b === OP_WAIT) { const frames = bytes[i]; i++; rawEvents.push({ type: 'wait', frames }); continue; }
      if (b === OP_PITCH_BREAK) {
        // タイ(&)による異音程レガート(2026-08-12)。アタックを伴わないので独立した
        // 'pitchBreak'イベントとして扱う(volume/tone/envIdx等の状態はnoteイベントと
        // 同じくその時点の選択中の値をそのまま引き継いで載せる、音程だけが変わる)
        const noteNumber = bytes[i];
        const frames = bytes[i + 1];
        i += 2;
        rawEvents.push({
          type: 'pitchBreak', noteNumber, frames, volume, tone, envIdx,
          noteEnv, pitchEnv, pitchEnvDelay, portamento, vibrato, fme7Noise, fme7EnvShape, fme7EnvPeriod, detune
        });
        continue;
      }
      const frames = bytes[i]; i++;
      rawEvents.push({
        type: 'note', noteNumber: b, frames, volume, tone, envIdx,
        noteEnv, pitchEnv, pitchEnvDelay, portamento, vibrato, fme7Noise, fme7EnvShape, fme7EnvPeriod, detune
      });
    }

    // ウェイトは直前のイベントの音長に合算する(実機と同じ「カウンタ延長」の意味で、
    // 新しいノートオン/ノートオフを発生させない)
    const events = [];
    for (const e of rawEvents) {
      if (e.type === 'wait' && events.length > 0) {
        events[events.length - 1].frames += e.frames;
      } else {
        events.push(e);
      }
    }
    return events;
  };

  // 各コマンドの開始バイト位置を列挙する(トラック終端0xFFの位置も含む)。
  // NSFバンク切り替え(src/driver/ppmckDriver.js)で、4KBバンク境界をコマンドの
  // 途中で跨がないよう安全な分割点を選ぶために使う
  MckBytecode.commandBoundaries = function (bytes) {
    const offsets = [];
    let i = 0;
    while (i < bytes.length) {
      offsets.push(i);
      const b = bytes[i]; i++;
      if (b === OP_END) break;
      if (b === OP_FME7_HARDENV) { i += 3; continue; }
      if (b === OP_PORTAMENTO) { i += 4; continue; }
      // ★2026-08-12修正: OP_PITCH_ENV(EP<n>,<delay>、別プロジェクトA)は[インデックス,delay]の
      // 2バイトパラメータなのに、以前はここに特別扱いが無く後述の「1バイト」扱いへ
      // フォールスルーしていた(OP_PORTAMENTOも同様に4バイトなのに1バイト扱いだった)。
      // どちらも実データでは踏み抜いていなかった(バンク境界が偶然ズレなかった)ため
      // 見過ごされていたが、EP<n>,<delay>/PT<n>を使う長い曲でバンク分割点がたまたま
      // この2バイト目/4バイト目に重なると、そこでバンクを分割してしまい6502側が
      // パラメータバイトをオペコードとして誤読する重大なサイレント破損バグだった。
      // OP_PITCH_BREAK(タイの異音程レガート)も同じく2バイトパラメータなので合わせて追加
      if (b === OP_PITCH_ENV || b === OP_PITCH_BREAK) { i += 2; continue; }
      if (b === OP_DETUNE) { i += 2; continue; }
      // OP_VOL/OP_TONE/OP_NOTE_ENV/OP_VIBRATO/OP_FME7_NOISE/
      // OP_REST/OP_WAIT/音符バイト は、いずれも直後1バイトのパラメータを持つ
      i += 1;
    }
    return offsets;
  };
})(window);
