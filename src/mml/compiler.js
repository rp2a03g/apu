/*
 * MMLコンパイラ (ppmck互換 基本コマンド + 拡張音源)
 * MML.Mml.compile(source, opt) -> {
 *   tracks: { A: [[ {addr, value}, ... ], ...frames], B: [...], ... },
 *   totalFrames: number,
 *   tempo: number,
 *   expansions: ('dpcm'|'fds'|'vrc7'|'vrc6'|'n163'|'fme7'|'mmc5')[],
 *   expansionLetterMap: { チップ名: [割当チャンネル文字...] },
 *   errors: [...]
 * }
 *
 * 対応チャンネル (2A03、常時):
 *   A = パルス1 ($4000-$4003)
 *   B = パルス2 ($4004-$4007)
 *   C = 三角波 ($4008-$400B)
 *   D = ノイズ ($400C-$400F)
 *
 * 拡張音源チャンネル (opt.expansions の配列で複数同時指定可。実機ppmck
 * (src/ppmckc/mckc.hの_TRACK_STR/BxxxTRACK定義)と同じ固定優先順位
 * dpcm→fds→vrc7→vrc6→n163→fme7→mmc5で、宣言順に関わらずE以降を
 * 詰めて連続割当てする(未使用チップの枠は消費しない)。実機同様、
 * mmc5だけ大文字を使い切った後の小文字a,bを使う(E-Zの22字+a,bの2字=24字):
 *   dpcm : DPCMサンプル再生 (1ch、フェーズ1.7で実装予定、現状は未実装で無音)
 *   fds  : 波形メモリ音源 (1ch)
 *   vrc7 : FM音源 (6ch)
 *   vrc6 : パルス1 パルス2 矩形波(サウ) (3ch)
 *   n163 : 波形音源 (8ch, 16サンプル波形を全ch共有)
 *   fme7 : 矩形波A 矩形波B 矩形波C (3ch)
 *   mmc5 : パルス1 パルス2 (2ch)
 * (後方互換: opt.expansion に単一文字列を渡した場合は1要素の配列として扱う)
 *
 * 対応コマンド:
 *   c d e f g a b  音符 (+ / # でシャープ, - でフラット, 数値で音長, . で付点)
 *   r              休符
 *   n<num>[,<len>] 直接音程指定 (オクターブ2のCを0とした通し番号)
 *   o<n> > <       オクターブ指定 / 上げ / 下げ
 *   l<n>[.]        デフォルト音長
 *   v<n>           音量 (0-15、絶対指定)
 *   v+<n> v-<n>    音量の相対増減 (省略時は±1)
 *   q<n>           ゲートタイム (0-8, 8で音長いっぱい)
 *   @q<n>          ゲートタイムをフレーム単位で指定(音符終端の<n>フレーム前でノートオフ)
 *   t<n>           テンポ (BPM。曲中の任意の位置で変更可)
 *   K<n>           移調 (半音、符号あり)
 *   D<n>           デチューン (周期/周波数レジスタへの生オフセット、符号あり。以降の音符に
 *                  持続適用。同じ音を別チャンネルでわずかにずらして鳴らすコーラス効果等に使う。
 *                  2A03パルス/三角/ノイズ(A/B/C/D)・VRC6・MMC5・FME7・FDS・N163対応(N163は
 *                  周波数レジスタが18bit相当のスケールのため同じ値でも変化量は小さくなる)。
 *                  VRC7はfnum/blockの対数的表現のため対象外。EP/MPと全く同じ「生レジスタへの
 *                  加算」空間の値(下記参照)なので、この3つは同時に足し合わされる
 *   @<n>           音色番号 (パルスのデューティ比 = n % 4 / VRC6パルスのデューティ比 = n % 8
 *                  (実機同様8段階) / VRC7の音色番号 = n % 16)
 *   &              タイ（直前の音を伸ばす）
 *   L              ループ地点マーカー(パラメータなし)。このチャンネルの再生が末尾まで
 *                  達したとき、Lの位置まで戻って演奏を続ける(実機ppmck同様、曲全体を
 *                  無限ループさせるための地点指定。[ ... ]nの小節単位の繰り返しとは別物)。
 *                  ブラウザ再生・シークバーの「曲の長さ」は、Lへ2回戻る(=イントロ1回+
 *                  ループ区間2回)までとして扱う。NSF書き出し(src/driver/ppmckDriver.js)は
 *                  このチャンネルを実際に無限ループさせる
 *   [ ... ]n       繰り返し (n回)
 *   [ ... | ... ]n 繰り返し (最後の周回だけ | から ] までを演奏しない)
 *   { ... }<len>   連符 (中の音符列を<len>の音長で等分)
 *   EN<n> / ENOF   ノートエンベロープ(高速アルペジオ)。@EN<n>={...}で定義(前回値からの
 *                  相対値・累積、仕様通り厳密実装)。「発音ノート番号の値に加算」される
 *                  (ppmck公式リファレンス通りの半音・ノート番号空間)。2A03全4ch(A-D)・
 *                  VRC6・MMC5・FME7(トーンモード)・FDS・N163・VRC7全対応
 *   EP<n> / EPOF   ピッチエンベロープ。@EP<n>={...}で定義。D<n>と全く同じ「周期/周波数
 *                  レジスタへの生オフセット」空間の値(ppmck公式リファレンスのD/EPの説明が
 *                  一字一句同じ「発音周波数の値に加算されます」であること、実機ドライバの
 *                  sound_pitch_enveropeが detune と同じ freq_add_mcknumber を呼ぶことを
 *                  実ソースで確認済み。以前の実装は値/128を半音とみなしていたが誤りだった)。
 *                  対応チャンネルはD<n>と同じ(2A03全4ch・VRC6・MMC5・FME7・FDS・N163、
 *                  VRC7は対象外)
 *   MP<n> / MPOF   ソフトウェアビブラート。@MP<n>={delay,speed,depth}で定義。depthはEP/Dと
 *                  同じ生レジスタ単位(実機ドライバのsound_lfoも同じfreq_add_mcknumberを
 *                  呼ぶため)。波形は実機のlfo_sub/warizan_start(nes_include/ppmck/
 *                  sounddrv.h、AoiMoe/ppmck)をそのまま状態遷移として移植(2026-08-11、
 *                  DESIGN-PITCH.md 別プロジェクトB)。滑らかな三角波ではなく「1フレームごと
 *                  ±1、またはNフレームごと±S」という階段状の変化で、Nまたは
 *                  Sは(1/4周期)と(depth)の割り算(割り切れない場合はceil側に丸まる、実測
 *                  確認済み)で決まる。方向(最初に+/-どちらへ動くか)はperiodFnが周波数の
 *                  増加関数か減少関数かで自動判定(periodFnIncreasing、実機の
 *                  freq_vector_table相当)。対応チャンネルはEPと同じ
 *   s<n0>,<n1>     スイープ。ppmck実機ではソフトウェア効果ではなく2A03パルスの実ハードウェア
 *                  スイープユニット($4001/$4005)への生バイト書き込み(CMD_SWEEPが1回書くだけ
 *                  と実ソースで確認済み)なので、2A03パルスA/Bにしか存在しない
 *                  (三角波・ノイズ・拡張音源は対象外。以前の実装は三角波にまで架空の
 *                  ソフトウェア近似を適用していたが誤りだった)。n1(0-15)の下位4bitは
 *                  そのままnegate(符号)+shift(かかり具合)、n0(0-15、0=OFF)は
 *                  「1が最速・15が最遅」の記載に沿ったperiod(0-7)への線形近似
 *                  (この換算式のみ資料未確認の近似、他は実ソースで確認済み)
 *   @OP<n>={8バイト} / @OT<n>={TL,FB,...} VRC7カスタム音色(パッチ0)。曲中`OP<n>`が
 *                    出現するたびその時点でロードし直す(実機同様スロットは1つだけ、
 *                    全ch共有)。@OTはMGSDRV互換形式(近似変換、下記参照)
 *   @FM<n>={64値}    FDS波形メモリ。`@<n>`(音色番号)で選択し、直前の音符と選択が
 *                    変わったときだけ再ロードする(全ch共有のため動的切り替えは1音源内)
 *   @N<n>={buf,...}  N163波形。先頭のバッファ番号は無視。`@<n>`で選択、FMと同様に
 *                    選択変化時だけ再ロード(全ch共有16サンプル固定)
 *   @MW<n>={32値}    FDSモジュレータ(ピッチ変調)テーブル。値の意味は実機と同じ
 *                    0=無変化,1=+1,2=+2,3=+4,4=リセット,5=-4,6=-2,7=-1
 *   @MH<n>={delay,freq,depth,waveform} / MH<n> / MHOF
 *                    FDSモジュレータ設定・有効化コマンド。waveformは@MW<n>のインデックス。
 *                    曲中`MH<n>`が出現した位置(+delayフレーム)で有効化される
 *   S<n>             FME7ハードウェアエンベロープ形状(0-15)
 *   M<n>             FME7ハードウェアエンベロープ周期(0-65535)
 *   N<n>             FME7ノイズ周波数(0-31、R6)。@2の時は無効(ノート番号が周期になるため)
 *   @<n>(X/Y/Z)      FME7のみ音色番号ではなくミキサー指定(ppmck仕様):
 *                    0=ミュート, 1=トーン(既定), 2=ノイズ, 3=トーン+ノイズ。
 *                    @2ではノート番号がそのままノイズ周波数になる(n0=o0c 〜 n31=o2g)
 *   #TITLE/#COMPOSER/#MAKER/#PROGRAMER <str>  メタ情報(戻り値のmetaに格納。再生には影響しない)
 *   #OCTAVE-REV <n>  0以外で`>``<`(オクターブ上げ/下げ)の意味を反転
 *   #GATE-DENOM <n>  q<n>のゲート分母を8から変更(既定8)
 *   #EX-VRC6/#EX-VRC7/#EX-DISKFM/#EX-MMC5/#EX-NAMCO106/#EX-FME7
 *                    拡張音源の使用宣言。opt.expansions(UI選択)と統合される
 *                    (MML本文がこれらを含めば、UIで選択していなくてもその音源が有効になる)
 *   #AUTO-BANKSWITCH/#BANK-CHANGE/#SETBANK/#NO-BANKSWITCH
 *                    バンキング指示子。本ツールはROMバンク分割を前提にしないため認識のみ・無視
 *   #INCLUDE/#EFFECT-INCLUDE  外部ファイル読込。静的ホスティングのみで完結する設計上、
 *                    未対応(認識のみ・無視。INV-1参照)
 *   $<char> <mml>    マクロ定義。以降そのチャンネル本文中の<char>を<mml>に1回だけ展開する
 *                    (再帰展開はしない。o l v q t K n N S E M s @ & [ | ] { } > < 空白
 *                    数字 . + # - および音符文字 a-g r は既存コマンドと衝突するため
 *                    マクロ文字に使わないこと)
 *
 * 注意: 2026-08-10、実機ppmckドライバ(nes_include/ppmck/{internal,sounddrv}.h)を
 * 直接確認し、D<n>/EP/MPが同一のfreq_add_mcknumberルーチンを共有する「周期/周波数
 * レジスタへの生オフセット」であること、sweep(s)はソフトウェア効果ではなく2A03パルスの
 * 実ハードウェアスイープユニットへの1回書き込みであることを確認、それに合わせて
 * EP/MP/sの実装を全面的に修正した(以前のEP=値/128を半音とみなす換算、sweep=三角波の
 * 半音空間ソフトウェア近似はいずれも仕様に無い誤りだった)。2026-08-11、MPの三角波の
 * 形状自体(内部除算ルーチンwarizan)も実ソース(AoiMoe/ppmck、nes_include/ppmck/
 * sounddrv.h)を完全にトレースして忠実移植した(DESIGN-PITCH.md 別プロジェクトB)。
 * 近似が残るのはsweepのn0(speed)→period変換式、@OT(VRC7のMGSDRV互換音色フォーマットの
 * DTパラメータ解釈)のみ(EN・D/EP/MPの空間そのもの・MPの波形・sweepのレジスタ形式・
 * FME7のS/M/N・VRC7の@OP生バイト形式は仕様・実ソースと一致を確認済み)。
 * 詳細はROADMAP.mdフェーズ1.5・DESIGN-PITCH.md §8参照。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キーは日本語の原文。MML.I18nが無い環境でも動くよう素通し
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const CPU_CLOCK_NTSC = 1789773;
  const FRAME_RATE_NTSC = 60.0988;

  const NOTE_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

  // 2A03チャンネルのベースアドレス
  const CHANNEL_BASE = { A: 0x4000, B: 0x4004, C: 0x4008, D: 0x400C };
  const STATUS_ADDR = 0x4015;

  // 拡張音源ごとのチャンネル数。実機ppmck(mckc.h)の_TRACK_STR "ABCDEFGHIJKLMNOPQRSTUVWXYZab"
  // 上で各チップの開始トラック番号が固定(BDPCMTRACK=4/BFMTRACK=5/BVRC7TRACK=6/
  // BVRC6TRACK=12/BN106TRACK=15/BFME7TRACK=23/BMMC5TRACK=26)であり、これは他の拡張音源が
  // 使われているかどうかに関わらず完全固定(https://wikiwiki.jp/mck/チャンネル別MML一覧 参照)。
  // 例えばVRC6だけを使う曲でもチャンネル文字は常にM-Oになり、E-Lは(DPCM/FDS/VRC7が
  // 未使用のため)そのまま空く。EXPANSION_PRIORITYの順に「常にカウント分だけ読み進める」
  // ことで、この固定オフセットをそのまま再現する(assignExpansionLetters参照)。
  const CHIP_CHANNEL_COUNTS = { dpcm: 1, fds: 1, vrc7: 6, vrc6: 3, n163: 8, fme7: 3, mmc5: 2 };
  const EXPANSION_PRIORITY = ['dpcm', 'fds', 'vrc7', 'vrc6', 'n163', 'fme7', 'mmc5'];
  const LETTER_POOL = 'EFGHIJKLMNOPQRSTUVWXYZab'.split('');

  const N163_WAVE_LEN = 16;
  const N163_CHANNEL_COUNT = 8; // 実機は1-8chが可変だが、常に8ch分確保する

  // 有効なチップ名配列(重複除去済み、宣言順は問わない)を受け取り、
  // { チップ名: [割当チャンネル文字...] } を返す。実機ppmck同様、各チップの文字範囲は
  // 他の拡張音源が使われているか否かに関わらず完全固定(未使用チップの分もliを進めて
  // 空き枠として残す。詰めて再割当てはしない)
  function assignExpansionLetters(expansions) {
    const used = new Set(expansions);
    const map = {};
    let li = 0;
    for (const exp of EXPANSION_PRIORITY) {
      const count = CHIP_CHANNEL_COUNTS[exp];
      if (used.has(exp)) map[exp] = LETTER_POOL.slice(li, li + count);
      li += count;
    }
    return map;
  }

  // opt.expansions(配列)または後方互換のopt.expansion(単一文字列)を
  // 正規化した文字列配列にする(未知の値・重複は除去)
  function normalizeExpansions(opt) {
    const list = Array.isArray(opt.expansions) ? opt.expansions
      : (opt.expansion && opt.expansion !== 'none' ? [opt.expansion] : []);
    const seen = new Set();
    const result = [];
    for (const exp of list) {
      if (CHIP_CHANNEL_COUNTS[exp] && !seen.has(exp)) { seen.add(exp); result.push(exp); }
    }
    return result;
  }

  function noteFrequency(noteNumber) {
    // noteNumber: o4 a (A4=440Hz) を基準(57)とした半音単位の値
    return 440 * Math.pow(2, (noteNumber - 57) / 12);
  }

  // D<n>(デチューン)。算出済みの周期/周波数レジスタ値へ生のオフセットを加算し、
  // レジスタ幅でクランプする。2A03パルス/三角・VRC6・MMC5・FME7・FDS(2047/4095幅)に加え
  // N163(freqReg、262143幅。18bitスケールなので同じ値でも変化量は小さい)、
  // VRC7(fnum、511幅。block自体は動かさずfnumだけをクランプするため、blockの境界を
  // またぐような大きなデチューン量では近似精度が落ちるが、コーラス効果程度の
  // 小さなずれなら十分機能する)も対応。
  function applyDetune(period, detune, max) {
    return Math.max(0, Math.min(max, period + (detune || 0)));
  }

  // s<n0>,<n1>(スイープ)。実機ppmckのCMD_SWEEP(nes_include/ppmck/internal.h)は
  // MMLの値をソフトウェアでピッチ計算するのではなく、2A03パルスの実ハードウェア
  // スイープユニット($4001/$4005)へ生バイトをそのまま1回書き込むだけと確認済み
  // (よって2A03パルスA/Bにしか存在せず、三角波・拡張音源には無い。以前の実装は
  // 「speed*4フレームで線形に到達する半音オフセット」という架空のソフトウェア近似を
  // 三角波にまで適用していたが誤りだった)。
  // n1(depth,0-15)の下位4bitは公式リファレンスの変化量対応表(1-7=マイナス/8=変化無し/
  // 9-15=プラス)が標準的なNES APUスイープの符号(negate,bit3)+シフト量(bit2-0)の
  // ビット表現と完全に一致するため、そのままnegate+shiftとして使える。
  // n0(speed,0-15。0=OFF、1=最速…15=最遅)からperiod(0-7)への正確な換算式は資料からは
  // 確認できなかったため、「1が最速・15が最遅」の記述に沿った線形近似を用いる
  // (この部分は未検証の近似。他は実ソースで確認済み)
  function sweepRegisterByte(speed, depth) {
    if (!speed) return 0x08; // OFF: 誤ミュート防止のnegateビットだけ立てる定石を維持
    const period = Math.max(0, Math.min(7, Math.round((speed - 1) / 2)));
    return 0x80 | (period << 4) | ((depth || 0) & 0x0F);
  }

  function pulsePeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (16 * freq)) - 1;
    return Math.max(0, Math.min(2047, p));
  }

  function trianglePeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (32 * freq)) - 1;
    return Math.max(0, Math.min(2047, p));
  }

  function noisePeriodIndex(noteNumber) {
    const idx = ((noteNumber % 16) + 16) % 16;
    return 15 - idx;
  }

  // VRC6 矩形波(サウ): freq = CLOCK / (14 * (period+1))
  function sawPeriod(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (14 * freq)) - 1;
    return Math.max(0, Math.min(4095, p));
  }

  // FME-7: freq = CLOCK / (32 * period)
  // ★MSXのPSG(AY-3-8910)は f=clock/(16*TP) だが、NESの5B(YM2149)は内蔵の1/2プリスケーラが
  // 効いており分母が32になる(NESdev "Sunsoft 5B audio": Frequency = Clock/(32*Period))。
  // 16で計算すると実際の発音が1オクターブ低くなる(鍵盤表示で低音が範囲外の"??"になる)。
  function fme7Period(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (32 * freq));
    return Math.max(1, Math.min(4095, p));
  }

  // FDS: freq = CLOCK * period / (65536 * 64)
  function fdsFreqToPeriod(freq) {
    let p = Math.round((freq * 65536 * 64) / CPU_CLOCK_NTSC);
    return Math.max(0, Math.min(4095, p));
  }

  // N163: 実機の出力周波数は f = CLOCK * freqReg / (15 * 65536 * waveLen * numCh)。
  // (時間多重のため有効ch数が多いほど1chの更新頻度が下がり、同じ freqReg でも音程が下がる)
  // これを反転して freqReg を求める。numCh を含めないと再生/NSF書き出しで音程がズレる。
  function n163FreqReg(freq, waveLen, numCh) {
    let r = Math.round((freq * 15 * 65536 * waveLen * (numCh || 1)) / CPU_CLOCK_NTSC);
    return Math.max(0, Math.min(262143, r));
  }

  // VRC7: freq = fnum * 2^block * 49716 / 2^19
  function vrc7FreqToFnumBlock(freq) {
    for (let block = 0; block <= 7; block++) {
      const fnum = Math.round((freq * 524288) / (49716 * Math.pow(2, block)));
      if (fnum <= 511) return { fnum: Math.max(0, fnum), block };
    }
    return { fnum: 511, block: 7 };
  }

  // ループ([...]n / [...|...]n)をフラットなトークン列に展開する。
  // "|" がある場合、そこから "]" までは最後の周回では演奏しない
  // (ppmck仕様: "|があるときは最後の繰り返しのときに|から]までの演奏をしません")
  function expandLoops(tokens, errors) {
    let i = 0;

    function parseUntil(stopSet) {
      const seq = [];
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === 'loopStart') {
          i++;
          const before = parseUntil(LOOP_BREAK_OR_END);
          let after = null;
          if (i < tokens.length && tokens[i].type === 'loopBreak') {
            i++;
            after = parseUntil(LOOP_END_ONLY);
          }
          if (i < tokens.length && tokens[i].type === 'loopEnd') {
            const count = tokens[i].count == null ? 2 : tokens[i].count;
            i++;
            for (let r = 0; r < count; r++) {
              seq.push(...before);
              if (after && r < count - 1) seq.push(...after);
            }
          } else {
            errors.push({ message: T('ループ終端 "]" が見つかりません') });
            seq.push(...before);
            if (after) seq.push(...after);
          }
        } else if (stopSet.has(tok.type)) {
          return seq;
        } else {
          seq.push(tok);
          i++;
        }
      }
      return seq;
    }

    const LOOP_BREAK_OR_END = new Set(['loopBreak', 'loopEnd']);
    const LOOP_END_ONLY = new Set(['loopEnd']);
    return parseUntil(new Set());
  }

  // 付点n個 → 倍率 1 + 1/2 + 1/4 + ... + 1/2^n (付点1個=1.5倍, 付点2個=1.75倍, ...)。
  // 旧実装は付点の有無だけを見て常に1.5倍していたため、付点2個(".. ")の音符が
  // 実際より短く(1.75倍のはずが1.5倍で)解釈され、SPC2MML等が生成する".."を
  // 多用するMMLで総再生時間が実際より短くなり、曲が進むほど元音源からズレていく
  // 原因になっていた。
  function dotMultiplier(dots) {
    let mult = 1, add = 1;
    for (let i = 0; i < dots; i++) { add /= 2; mult += add; }
    return mult;
  }

  // carryIn/carryOut: 各音符を独立にMath.roundすると端数(最大0.5フレーム)が
  // 毎回切り捨て/切り上げられ、同じ方向の丸め誤差が短い音符の多いパートで
  // 蓄積し、曲が進むほど元音源からズレていく(SPC2MML実測で最大約1秒/60秒の
  // 系統的ドリフトを確認)。直前の余り誤差をcarryInとして次の音符のtargetに
  // 足し込み、carryOutを次へ引き継ぐことで誤差を蓄積させない
  // (src/convert/duration.jsのframesToLengthsと同じ手法)。
  function framesForLength(len, dots, defaultLength, tempo, carryIn) {
    const n = len || defaultLength;
    const framesPerWhole = (240 / tempo) * FRAME_RATE_NTSC;
    const ideal = (framesPerWhole / n) * dotMultiplier(dots);
    const target = ideal + (carryIn || 0);
    const frames = Math.max(1, Math.round(target));
    return { frames, carryOut: target - frames };
  }

  // ループ展開後のトークン列に対し、{ ... }<len> 連符を等分の固定フレーム数に変換する
  // (該当する note/directNote トークンに forcedFrames を直接付与し、
  // tupletStart/tupletEnd 自体は取り除く)。l<n>/t<n> だけを軽く追跡する事前パス。
  function applyTuplets(tokens, initialTempo, errors) {
    const result = [];
    let defaultLength = 4;
    let tempo = initialTempo;
    let i = 0;

    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.type === 'length') { defaultLength = tok.value || defaultLength; result.push(tok); i++; continue; }
      if (tok.type === 'tempo') { tempo = tok.value; result.push(tok); i++; continue; }
      if (tok.type === 'tupletStart') {
        let j = i + 1, depth = 0;
        while (j < tokens.length) {
          if (tokens[j].type === 'tupletStart') depth++;
          else if (tokens[j].type === 'tupletEnd') { if (depth === 0) break; depth--; }
          j++;
        }
        const inner = tokens.slice(i + 1, j);
        const endTok = tokens[j];
        if (!endTok) {
          errors.push({ message: T('タプレット終端 "}" が見つかりません') });
          result.push(...inner);
          i = j;
          continue;
        }
        const tupletLen = endTok.length != null ? endTok.length : defaultLength;
        const totalFrames = framesForLength(tupletLen, endTok.dots || 0, defaultLength, tempo, 0).frames;
        const noteToks = inner.filter(t => t.type === 'note' || t.type === 'directNote');
        const count = noteToks.length;
        if (count > 0) {
          let carry = 0;
          let assigned = 0;
          noteToks.forEach((nt, k) => {
            let frames;
            if (k === count - 1) {
              frames = Math.max(1, totalFrames - assigned);
            } else {
              const target = (totalFrames / count) + carry;
              frames = Math.max(1, Math.round(target));
              carry = target - frames;
            }
            nt.forcedFrames = frames;
            assigned += frames;
          });
        }
        result.push(...inner);
        i = j + 1;
        continue;
      }
      result.push(tok);
      i++;
    }

    return result;
  }

  // チャンネルのトークン列 -> 音符セグメント列
  // settings: #OCTAVE-REV(>/<を反転)・#GATE-DENOM(qのゲート分母、既定8)などの曲全体設定
  // defaultInstrument: @<n>が一度も書かれていないときの音色番号。FME7だけはこの値が
  // ミキサー指定(0=ミュート)を兼ねるため、ppmck同様に既定を1(トーン)にする必要がある
  function buildSegments(tokens, initialTempo, errors, settings, defaultInstrument) {
    const cfg = settings || { octaveRev: 0, gateDenom: 8 };
    const state = {
      octave: 4, defaultLength: 4, volume: 15, gate: 8, instrument: defaultInstrument || 0,
      envelopeV: null, envelopeVr: 255, transpose: 0, detune: 0, qFrames: null,
      vibrato: null, pitchEnv: null, pitchEnvDelay: 0, noteEnv: null, sweepSpeed: 0, sweepDepth: 0,
      fme7Noise: null, fme7EnvShape: null, fme7EnvPeriod: 0
    };
    const segments = [];
    // OP<n>(VRC7音色ロード)/MH<n>(FDS変調)のような「音符に紐付かない、その時点のフレーム
    // 位置で即座に効くコマンド」を記録する。frameはこのトークンに達するまでに
    // 消費された(=直前までのセグメントの合計)フレーム数
    const immediateWrites = [];
    let lengthCarry = 0;
    let tempo = initialTempo;
    let elapsedFrames = 0;
    // L(ループ地点マーカー)が出現した時点でのelapsedFrames。複数回書かれた場合は
    // 最初の1回だけを採用する(2回目以降は無視)
    let loopFrame = null;

    // srcStart/srcEnd: 元MMLソース上のこの音符/休符トークンの絶対文字範囲(再生ハイライト用、
    // lexer.tokenizeがoffsets付きで呼ばれた場合のみ付与される。無ければundefined)
    function pushNote(frames, freq, noteNumber, srcStart, srcEnd) {
      elapsedFrames += frames;
      const prev = segments.length > 0 ? segments[segments.length - 1] : null;
      if (prev && prev.tieNext) {
        prev.durationFrames += frames;
        prev.tieNext = false;
        if (srcEnd != null) prev.srcEnd = srcEnd;
      } else {
        segments.push({
          durationFrames: frames,
          freq,
          noteNumber,
          srcStart,
          srcEnd,
          volume: state.volume,
          instrument: state.instrument,
          envelopeV: state.envelopeV,
          envelopeVr: state.envelopeVr,
          gate: state.gate,
          gateDenom: cfg.gateDenom,
          qFrames: state.qFrames,
          vibrato: state.vibrato,
          pitchEnv: state.pitchEnv,
          pitchEnvDelay: state.pitchEnvDelay,
          noteEnv: state.noteEnv,
          sweepSpeed: state.sweepSpeed,
          sweepDepth: state.sweepDepth,
          detune: state.detune,
          fme7Noise: state.fme7Noise,
          fme7EnvShape: state.fme7EnvShape,
          fme7EnvPeriod: state.fme7EnvPeriod,
          tieNext: false
        });
      }
    }

    for (const tok of tokens) {
      switch (tok.type) {
        case 'octave': state.octave = tok.value; break;
        case 'octaveUp': state.octave += cfg.octaveRev ? -1 : 1; break;
        case 'octaveDown': state.octave += cfg.octaveRev ? 1 : -1; break;
        case 'length': state.defaultLength = tok.value || state.defaultLength; break;
        // 明示的なv<n>は実機でも音量レジスタをbit4=0(固定音量)で書き直すのと同じことなので、
        // ソフトウェアエンベロープ(envelopeV)だけでなくFME7ハードウェアエンベロープ
        // (fme7EnvShape、S<n>で設定・解除するコマンドが無く一度設定すると残り続けるため
        // ここで明示的に解除する)も同時にクリアする
        case 'volume': state.volume = Math.max(0, Math.min(15, tok.value)); state.envelopeV = null; state.fme7EnvShape = null; break;
        case 'volumeRel': state.volume = Math.max(0, Math.min(15, state.volume + tok.delta)); state.envelopeV = null; state.fme7EnvShape = null; break;
        case 'gate': state.gate = Math.max(0, Math.min(8, tok.value)); state.qFrames = null; break;
        case 'quantizeFrames': state.qFrames = Math.max(0, tok.value); break;
        case 'tempo': tempo = tok.value; break;
        case 'transpose': state.transpose = tok.value; break;
        case 'detune': state.detune = tok.value; break;
        case 'instrument': state.instrument = tok.value; break;
        case 'envelopeV': state.envelopeV = tok.value; break;
        case 'envelopeVr': state.envelopeVr = tok.value; break;
        case 'vibrato': state.vibrato = tok.value; break;
        case 'pitchEnv': state.pitchEnv = tok.value; state.pitchEnvDelay = tok.delay || 0; break;
        case 'noteEnv': state.noteEnv = tok.value; break;
        case 'sweep': state.sweepSpeed = tok.speed; state.sweepDepth = tok.depth; break;
        case 'fme7Noise': state.fme7Noise = tok.value; break;
        case 'fme7EnvShape': state.fme7EnvShape = tok.value; break;
        case 'fme7EnvPeriod': state.fme7EnvPeriod = tok.value; break;
        case 'loopPoint': if (loopFrame == null) loopFrame = elapsedFrames; break;
        case 'vrc7Tone': immediateWrites.push({ kind: 'vrc7Tone', frame: elapsedFrames, value: tok.value }); break;
        case 'fdsMod': immediateWrites.push({ kind: 'fdsMod', frame: elapsedFrames, value: tok.value }); break;
        case 'tie': {
          if (segments.length > 0) segments[segments.length - 1].tieNext = true;
          break;
        }
        case 'note': {
          let frames;
          if (tok.forcedFrames != null) {
            frames = tok.forcedFrames;
          } else {
            const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
            frames = lenResult.frames;
            lengthCarry = lenResult.carryOut;
          }
          let freq = null;
          let noteNumber = null;
          if (tok.name !== 'r') {
            noteNumber = state.octave * 12 + NOTE_SEMITONES[tok.name] + tok.accidental + state.transpose;
            freq = noteFrequency(noteNumber);
          }
          pushNote(frames, freq, noteNumber, tok.srcStart, tok.srcEnd);
          break;
        }
        case 'directNote': {
          let frames;
          if (tok.forcedFrames != null) {
            frames = tok.forcedFrames;
          } else {
            const lenResult = framesForLength(tok.length, tok.dots, state.defaultLength, tempo, lengthCarry);
            frames = lenResult.frames;
            lengthCarry = lenResult.carryOut;
          }
          // n<num>: オクターブ2のCを0とした通し番号
          const noteNumber = tok.num + 24 + state.transpose;
          const freq = noteFrequency(noteNumber);
          pushNote(frames, freq, noteNumber, tok.srcStart, tok.srcEnd);
          break;
        }
        default:
          break;
      }
    }

    return { segments, immediateWrites, loopFrame };
  }

  // セグメントのゲート長(フレーム数)を算出する。@q<n>(フレーム単位の早期ノートオフ)が
  // 指定されていればそちらを優先し、無ければ従来通り q<n>(0-8, 8分率)を使う
  function computeGateFrames(seg, dur) {
    if (seg.qFrames != null) return Math.max(1, dur - seg.qFrames);
    return Math.max(1, Math.round(dur * (seg.gate / (seg.gateDenom || 8))));
  }

  // ノートエンベロープ(EN)は「前回値からの相対値」の累積(cumulative)。
  // ループがあれば周回後もループ区間の合計を繰り返し足し込み、無ければ全体の合計で頭打ちにする。
  function cumulativeEnvelopeValue(table, tick) {
    const { values, loop } = table;
    if (values.length === 0) return 0;
    if (tick < values.length) {
      let sum = 0;
      for (let i = 0; i <= tick; i++) sum += values[i];
      return sum;
    }
    let full = 0;
    for (let i = 0; i < values.length; i++) full += values[i];
    if (loop == null || loop >= values.length) return full;
    let loopSum = 0;
    for (let i = loop; i < values.length; i++) loopSum += values[i];
    const loopLen = values.length - loop;
    const extra = tick - values.length + 1;
    const fullCycles = Math.floor(extra / loopLen);
    const remainder = extra % loopLen;
    let result = full + fullCycles * loopSum;
    for (let i = 0; i < remainder; i++) result += values[loop + i];
    return result;
  }

  // ソフトウェアビブラート(MP)の生レジスタ単位オフセット列。
  // ★2026-08-11(DESIGN-PITCH.md 別プロジェクトB): 以前は「delay後、四半周期=speedフレーム
  // でdepthに到達する対称三角波」という近似実装だった(内部除算ルーチンwarizanの詳細を
  // 追い切れていなかったため)。実ソース(nes_include/ppmck/sounddrv.h の lfo_sub /
  // warizan_start、AoiMoe/ppmck)を完全にトレースした結果、実機は滑らかな三角波ではなく
  // 「1フレームごとに±1、またはNフレームごとに±Sというカクカクした階段状の変化」を
  // フレーム単位のカウンタで刻む方式だと判明したため、近似式をやめてその状態遷移を
  // そのまま1フレーム=1ステップで再現する(音量エンベロープのstepEnvelopeと同じ発想)。
  //
  // 実機の対応(lfo_set_sub): mp.delay→lfo_start_time(遅延フレーム数)、
  // mp.speed→lfo_reverse_time(LFO周期の1/4)、mp.depth→lfo_depth(warizan_start前の
  // 生のY軸ピーク指定)。
  //
  // warizan_start(lfo_setで1回だけ実行): 「1/4周期」と「Y軸ピーク」の大小関係で、
  // (a) 1/4周期の方が大きい(傾き<1): 単位ステップ=1、(1/4周期)/(Yピーク)フレームごとに
  //     変化させる、(b) Yピークの方が大きい(傾き>1): 1フレームごとに(Yピーク)/(1/4周期)
  //     ぶん変化させる、(c) 等しければ1フレームごとに±1、の3通り。除算はwarizan
  //     (.quotient += floor(a/.divisor)というコメントだが、実際はA>=Mの間incして
  //     引き続けるbcs/bccループのため、割り切れない場合は実質ceil(a/b)を返す。実測
  //     トレース済み: 10/3→4=ceil、9/3→3=floor=ceil(割り切れる場合は一致))。
  function ceilDivPpmck(a, b) {
    if (a === b) return 1; // warizan_startの.plus_one分岐(1/4周期とYピークが等しい場合)
    let q = 0, rem = a;
    while (rem > 0) { q++; rem -= b; }
    return q;
  }

  // periodFnが周波数の増加関数か減少関数かを実測判定する(ppmck実機のfreq_vector_table相当。
  // MPのdepthは符号無しのため、実機は音源チップごとに「周期レジスタ(値が下がるほど音程が
  // 上がる: 2A03/VRC6/MMC5/FME7)」か「周波数レジスタ(値が上がるほど音程が上がる: FDS/N163)」
  // かを引いて最初の変化方向を決める(PITCH_CORRECTIONモード、lfo_initial_vector)。
  // どちらの場合も結果は「最初のクォーター周期で音程が上がる」で共通になるため、実機の
  // 固定テーブルを持たずperiodFn自身の単調増減を実測して同じ効果を得る。
  function periodFnIncreasing(periodFn) {
    return periodFn(2000) > periodFn(200);
  }

  // lfo_sub本体の忠実移植。1音符ぶん(dur フレーム)を一度に状態遷移させ、フレーム毎の
  // オフセット値配列を返す(stepEnvelopeの事前計算版と同じ考え方)。direction(+1/-1)は
  // periodFnIncreasing(あるいはノイズ等periodFnが無いチャンネルでは固定値)で決める。
  function vibratoSequence(mp, dur, direction) {
    if (!mp || dur <= 0) return null;
    const delay = Math.max(0, mp.delay || 0);
    const quarter = Math.max(1, mp.speed || 1);   // lfo_reverse_time(1/4周期)
    const rawDepth = Math.max(1, mp.depth || 1);  // lfo_depth(warizan_start前)

    let stepSize, stepInterval;
    if (quarter === rawDepth) { stepSize = 1; stepInterval = 1; }
    else if (quarter > rawDepth) { stepInterval = ceilDivPpmck(quarter, rawDepth); stepSize = 1; }
    else { stepSize = ceilDivPpmck(rawDepth, quarter); stepInterval = 1; }

    const seq = new Array(dur);
    let startCounter = delay;          // lfo_start_counter
    let reverseCounter = quarter;      // effect_init: reverse_time初期値のまま開始
    let adcSbcCounter = stepInterval;  // effect_init: adc_sbc_time初期値のまま開始
    let dir = direction;
    let value = 0;

    for (let t = 0; t < dur; t++) {
      if (startCounter > 0) { startCounter--; seq[t] = value; continue; } // 遅延中(dec;rts相当)
      // 反転判定: 2×quarterごとに反転(asl/cmp/lsrの実質。lfo_sub参照)
      if (reverseCounter === quarter * 2) { reverseCounter = 0; dir = -dir; }
      // 変分処理: stepIntervalごとにstepSizeぶん加減算
      if (adcSbcCounter === stepInterval) { adcSbcCounter = 0; value += dir * stepSize; }
      reverseCounter++;
      adcSbcCounter++;
      seq[t] = value;
    }
    return seq;
  }

  // セグメントに音程変調(EN/EP/MP)が何か効いているかどうか。
  // sweep(s<n0>,<n1>)はここに含まない: 実機ppmckのCMD_SWEEPはソフトウェア効果ではなく
  // 2A03パルスの実ハードウェアスイープユニット($4001/$4005)へバイトを1回書くだけの
  // 機能だと判明したため、フレームごとの再計算パイプラインからは分離した
  // (sweepRegisterByte/2A03パルスの書き込み箇所を参照)
  function hasPitchModulation(seg) {
    return (seg.noteEnv != null && seg.noteEnv !== 255) ||
      (seg.pitchEnv != null && seg.pitchEnv !== 255) ||
      (seg.vibrato != null && seg.vibrato !== 255);
  }

  // EN(ノートエンベロープ)は「発音ノート番号の値に加算」(ppmck公式リファレンス通り、
  // 半音・ノート番号空間、前回値からの相対値の累積)。この関数だけがノート番号空間を扱う。
  function noteEnvelopeOffset(seg, envelopes, tick) {
    if (seg.noteEnv == null || seg.noteEnv === 255) return 0;
    const table = envelopes.en[seg.noteEnv];
    return table ? cumulativeEnvelopeValue(table, tick) : 0;
  }

  // D<n>(デチューン)・EP(ピッチエンベロープ)・MP(ビブラート)は、実機ppmckドライバでは
  // 3つとも同一のサブルーチン(freq_add_mcknumber)を共有し、いずれも「発音周波数の値」
  // =周期/周波数レジスタへ書き込む直前の生の値へそのまま加算される(ppmck公式リファレンスの
  // D/EPの説明文言が一字一句同じ「発音周波数の値に加算されます」であることと、実ソース
  // (nes_include/ppmck/sounddrv.h)でsound_pitch_enverope・sound_lfoが共にfreq_add_mcknumber
  // を呼ぶことで確認済み。2026-08-10修正: 以前のEPは値/128を半音とみなしnoteFrequency()で
  // 再計算していたが、この換算は仕様に存在しない誤りだった)。
  // ここで3つを合算してから、呼び出し側がapplyDetune相当のクランプ済み加算を1回だけ行う。
  // vibSeq: 呼び出し側がwritePitchModulation冒頭で1音符ぶん事前計算したvibratoSequence
  // (未使用/MP無効ならnull)。tick索引で読むだけなので状態を持たない。
  function pitchRegisterOffset(seg, envelopes, tick, vibSeq) {
    let offset = seg.detune || 0;
    if (seg.pitchEnv != null && seg.pitchEnv !== 255) {
      const table = envelopes.ep[seg.pitchEnv];
      // EP<n>,<delay>(2026-08-11 別プロジェクトA): delay経過前はテーブルへ触れず0のまま
      // (MPのvibratoSequenceのdelay処理・実機lfo_sub delay中rtsと同じ考え方)。delay経過後は
      // tickをdelayぶん巻き戻してテーブル先頭(index0)から辿る。
      const delay = seg.pitchEnvDelay || 0;
      if (table && tick >= delay) offset += stepEnvelope(table, tick - delay);
    }
    if (vibSeq) offset += vibSeq[tick];
    return offset;
  }

  // 音程変調(EN/EP/MP)ありのセグメントについて、フレームごとに周期/周波数レジスタを
  // 再計算し、前フレームと値が変わったときだけ書き込む(無変調時の1回書きより負荷は
  // 高いが、総フレーム数は曲の長さ相当なので実用上問題にならない)。
  // periodFn: 基準Hz -> 変調前の周期/周波数レジスタ値。max: applyDetune相当のクランプ上限。
  // writeFn(frame, value): そのフレームの周期/周波数レジスタ書き込みをwriteLogへpushする
  // コールバック(チップごとにアドレス・バイト配置が異なるため、書き込み自体は
  // 呼び出し側に委ねる。writeVolumeEnvelopeと同じ設計)
  function writePitchModulation(writeLog, startFrame, dur, seg, envelopes, periodFn, max, writeFn) {
    const mpActive = seg.vibrato != null && seg.vibrato !== 255;
    const vibSeq = mpActive
      ? vibratoSequence(envelopes.mp[seg.vibrato], dur, periodFnIncreasing(periodFn) ? 1 : -1)
      : null;
    let last = null;
    for (let t = 0; t < dur; t++) {
      const enOffset = noteEnvelopeOffset(seg, envelopes, t);
      const freq = enOffset === 0 ? seg.freq : noteFrequency(seg.noteNumber + enOffset);
      const regOffset = pitchRegisterOffset(seg, envelopes, t, vibSeq);
      const value = applyDetune(periodFn(freq), regOffset, max);
      if (value !== last) {
        writeFn(startFrame + t, value);
        last = value;
      }
    }
  }

  function newWriteLog(totalFrames) {
    const writeLog = new Array(totalFrames);
    for (let f = 0; f < totalFrames; f++) writeLog[f] = [];
    return writeLog;
  }

  // 音量エンベロープテーブルを1フレーム1ステップで進めた値を返す。
  // loopが設定されていればそこへ周回し、無ければ末尾の値を保持し続ける。
  function stepEnvelope(table, tick) {
    const { values, loop } = table;
    if (values.length === 0) return 0;
    if (tick < values.length) return values[tick];
    if (loop != null && loop < values.length) {
      const loopLen = values.length - loop;
      return values[loop + ((tick - values.length) % loopLen)];
    }
    return values[values.length - 1];
  }

  // ゲートON区間はvTable、ゲートOFF区間(あれば)はvrTableを1フレーム1ステップで
  // 進めながら、直前と異なる値のフレームでのみwriteFn(frame, vol)を呼ぶ。
  // vrTableが無ければ従来通りゲートOFF時に1回だけ音量0で呼ぶ。
  // writeFnはそのフレームに必要なレジスタ書き込み(1個とは限らない。例:FME7は
  // アドレスラッチ+データの2書き込み)をwriteLog[frame]へ自分でpushする。
  function writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, writeFn) {
    let lastVol = -1;
    for (let t = 0; t < gateFrames; t++) {
      const vol = Math.max(0, Math.min(15, stepEnvelope(vTable, t)));
      if (vol !== lastVol) {
        writeFn(startFrame + t, vol);
        lastVol = vol;
      }
    }
    if (gateFrames < dur) {
      if (vrTable) {
        let lastRVol = -1;
        for (let t = gateFrames; t < dur; t++) {
          const vol = Math.max(0, Math.min(15, stepEnvelope(vrTable, t - gateFrames)));
          if (vol !== lastRVol) {
            writeFn(startFrame + t, vol);
            lastRVol = vol;
          }
        }
      } else {
        writeFn(startFrame + gateFrames, 0);
      }
    }
  }

  // --- 2A03 (A-D) ---
  function segmentsToWriteLog2A03(channel, segments, totalFrames, envelopes) {
    const base = CHANNEL_BASE[channel];
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { v: {}, vr: {}, ep: {}, en: {}, mp: {} };

    // パルスチャンネルのスイープレジスタ($4001/$4005)はこのツールでは表現しないが、
    // 未書込のままだとAPU2A03のPulseChannelがデフォルト(negate=false, shift=0)のまま
    // になり、ハードウェア実機と同じ「スイープ無効時でもtarget=period*2>0x7FFで
    // ミュートされる」オーバーフロー判定バグ(period>=1024の低音全て)が働いてしまう。
    // 最初の音符が来るまでのデフォルトとして、negateビットだけ立てて回避する定石
    // ($4001=$08)を書いておく(誤ミュート防止のみ、スイープ自体は作動しない)。
    // 実際のs<n0>,<n1>によるスイープは音符ごとにsweepRegisterByte()で書き直す(下記)
    if (totalFrames > 0 && (channel === 'A' || channel === 'B')) {
      writeLog[0].push({ addr: base + 1, value: 0x08 });
    }

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
      const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;

      if (channel === 'A' || channel === 'B') {
        const duty = seg.instrument % 4;
        if (seg.freq != null) {
          // s<n0>,<n1>(スイープ)は実機ハードウェアスイープユニットへの生バイト書き込み
          // なので、EN/EP/MPの周期再計算パイプラインとは無関係に音符ごとへ一度だけ書く
          writeLog[startFrame].push({ addr: base + 1, value: sweepRegisterByte(seg.sweepSpeed, seg.sweepDepth) });
          if (hasPitchModulation(seg)) {
            // $4003/$4007(addr+3)への書込みは実機で長さカウンタのロード+デューティ位相の
            // リセットを引き起こすため、値が変わっていなくても毎回書くと(EP/MPで周期が
            // 毎フレーム変わるたび)パルス波が意図せず打ち直され続けてしまう
            // (DESIGN-PITCH.md Phase 1で実測発覚)。上位バイトが実際に変わった時だけ書く。
            let lastHi = -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, pulsePeriod, 0x7FF,
              (f, period) => {
                writeLog[f].push({ addr: base + 2, value: period & 0xFF });
                const hi = (period >> 8) & 0x07;
                if (hi !== lastHi) { writeLog[f].push({ addr: base + 3, value: hi }); lastHi = hi; }
              });
          } else {
            const period = applyDetune(pulsePeriod(seg.freq), seg.detune, 0x7FF);
            writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
            writeLog[startFrame].push({ addr: base + 3, value: (period >> 8) & 0x07 });
          }
          if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol) => writeLog[f].push({ addr: base + 0, value: (duty << 6) | 0x30 | vol }));
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: (duty << 6) | 0x30 | seg.volume });
            if (gateFrames < dur) {
              writeLog[startFrame + gateFrames].push({ addr: base + 0, value: (duty << 6) | 0x30 | 0 });
            }
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: 0x30 });
        }
      } else if (channel === 'C') {
        if (seg.freq != null) {
          if (hasPitchModulation(seg)) {
            // $400B(addr+3)への書込みは実機で線形カウンタのreload flagを立てる副作用があり、
            // 値が変わっていなくても毎回書くと(EP/MPで周期が毎フレーム変わるたび)三角波が
            // 意図せず打ち直され続けてしまう。上位バイトの値が実際に変わった時だけ書く
            // (下位バイト単体の書込みには副作用が無いため毎フレーム書いてよい)。
            let lastHi = -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, trianglePeriod, 0x7FF,
              (f, period) => {
                writeLog[f].push({ addr: base + 2, value: period & 0xFF });
                const hi = (period >> 8) & 0x07;
                if (hi !== lastHi) { writeLog[f].push({ addr: base + 3, value: hi }); lastHi = hi; }
              });
          } else {
            const period = applyDetune(trianglePeriod(seg.freq), seg.detune, 0x7FF);
            writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
            writeLog[startFrame].push({ addr: base + 3, value: (period >> 8) & 0x07 });
          }
          writeLog[startFrame].push({ addr: base + 0, value: seg.volume > 0 ? 0xFF : 0x80 });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: base + 0, value: 0x80 });
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: 0x80 });
        }
      } else if (channel === 'D') {
        if (seg.freq != null) {
          // ノイズは4bitインデックス(0-15)のみなので、周期/周波数レジスタの代わりに
          // インデックスへ直接足し引きする。EN(ノート番号空間)でベースindexを求めた後、
          // D/EP/MP(生オフセット空間、pitchRegisterOffset)を同じくindexへ加算しクランプする
          if (hasPitchModulation(seg) || seg.detune) {
            let lastIdx = -1;
            // ノイズchは周期/周波数レジスタではなく離散indexなのでperiodFnが無く、
            // periodFnIncreasingによる方向自動判定ができない。実機のfreq_vector_table
            // 相当の値も未確認のため、direction=+1固定とする(DESIGN.md §7でD/EP/MPの
            // 適用対象外と位置づけているノイズchの中では既存の簡略対応の範囲内)。
            const mpActive = seg.vibrato != null && seg.vibrato !== 255;
            const vibSeq = mpActive ? vibratoSequence(env.mp[seg.vibrato], dur, 1) : null;
            for (let t = 0; t < dur; t++) {
              const enOffset = noteEnvelopeOffset(seg, env, t);
              const baseIdx = noisePeriodIndex(Math.round(seg.noteNumber + enOffset));
              const regOffset = pitchRegisterOffset(seg, env, t, vibSeq);
              const idx = Math.max(0, Math.min(15, Math.round(baseIdx + regOffset)));
              if (idx !== lastIdx) {
                writeLog[startFrame + t].push({ addr: base + 2, value: idx & 0x0F });
                writeLog[startFrame + t].push({ addr: base + 3, value: 0x00 });
                lastIdx = idx;
              }
            }
          } else {
            const periodIdx = noisePeriodIndex(seg.noteNumber);
            writeLog[startFrame].push({ addr: base + 2, value: periodIdx & 0x0F });
            writeLog[startFrame].push({ addr: base + 3, value: 0x00 });
          }
          if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol) => writeLog[f].push({ addr: base + 0, value: 0x30 | vol }));
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: 0x30 | seg.volume });
            if (gateFrames < dur) {
              writeLog[startFrame + gateFrames].push({ addr: base + 0, value: 0x30 });
            }
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: 0x30 });
        }
      }

      frame += dur;
    }

    return writeLog;
  }

  // --- VRC6 ---
  function segmentsToWriteLogVrc6(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { v: {}, vr: {} };

    if (index === 0 || index === 1) {
      const base = index === 0 ? 0x9000 : 0xA000;
      let frame = 0;
      for (const seg of segments) {
        if (frame >= totalFrames) break;
        const startFrame = frame;
        const dur = Math.min(seg.durationFrames, totalFrames - frame);
        const gateFrames = computeGateFrames(seg, dur);
        // VRC6パルスのduty(bits4-6)は実機同様8段階(0-7)。@<n>のnをそのまま使う
        // (2A03/MMC5の4段階=n%4とは異なるチップ固有の範囲)。既定値7=約50%幅
        const duty = ((seg.instrument != null ? seg.instrument : 7) % 8) << 4;
        const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
        const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;
        if (seg.freq != null) {
          if (hasPitchModulation(seg)) {
            // 上位バイト(enableビット込み)は*2mml抽出側でアタック合図として扱われるため
            // (nsf2mml/expansion/vrc6.js buildTimeline参照)、値が変わった時だけ書く
            // (2A03と同じ理由、DESIGN-PITCH.md Phase 1)。
            let lastHi = -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, pulsePeriod, 0xFFF,
              (f, period) => {
                writeLog[f].push({ addr: base + 1, value: period & 0xFF });
                const hi = 0x80 | ((period >> 8) & 0x0F);
                if (hi !== lastHi) { writeLog[f].push({ addr: base + 2, value: hi }); lastHi = hi; }
              });
          } else {
            const period = applyDetune(pulsePeriod(seg.freq), seg.detune, 0xFFF);
            writeLog[startFrame].push({ addr: base + 1, value: period & 0xFF });
            writeLog[startFrame].push({ addr: base + 2, value: 0x80 | ((period >> 8) & 0x0F) });
          }
          if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol) => writeLog[f].push({ addr: base + 0, value: duty | vol }));
          } else {
            writeLog[startFrame].push({ addr: base + 0, value: duty | seg.volume });
            if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: base + 0, value: duty });
          }
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: duty });
        }
        frame += dur;
      }
    } else {
      let frame = 0;
      for (const seg of segments) {
        if (frame >= totalFrames) break;
        const startFrame = frame;
        const dur = Math.min(seg.durationFrames, totalFrames - frame);
        const gateFrames = computeGateFrames(seg, dur);
        const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
        const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;
        if (seg.freq != null) {
          if (hasPitchModulation(seg)) {
            let lastHi = -1;
            writePitchModulation(writeLog, startFrame, dur, seg, env, sawPeriod, 0xFFF,
              (f, period) => {
                writeLog[f].push({ addr: 0xB001, value: period & 0xFF });
                const hi = 0x80 | ((period >> 8) & 0x0F);
                if (hi !== lastHi) { writeLog[f].push({ addr: 0xB002, value: hi }); lastHi = hi; }
              });
          } else {
            const period = applyDetune(sawPeriod(seg.freq), seg.detune, 0xFFF);
            writeLog[startFrame].push({ addr: 0xB001, value: period & 0xFF });
            writeLog[startFrame].push({ addr: 0xB002, value: 0x80 | ((period >> 8) & 0x0F) });
          }
          if (vTable) {
            writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
              (f, vol) => writeLog[f].push({ addr: 0xB000, value: Math.min(63, vol * 4) }));
          } else {
            const accumRate = Math.min(63, seg.volume * 4);
            writeLog[startFrame].push({ addr: 0xB000, value: accumRate });
            if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: 0xB000, value: 0 });
          }
        } else {
          writeLog[startFrame].push({ addr: 0xB000, value: 0 });
        }
        frame += dur;
      }
    }

    return writeLog;
  }

  // --- MMC5 ---
  function segmentsToWriteLogMmc5(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const base = index === 0 ? 0x5000 : 0x5004;
    const env = envelopes || { v: {}, vr: {} };

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      const duty = seg.instrument % 4;
      const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
      const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;
      if (seg.freq != null) {
        if (hasPitchModulation(seg)) {
          let lastHi = -1;
          writePitchModulation(writeLog, startFrame, dur, seg, env, pulsePeriod, 0x7FF,
            (f, period) => {
              writeLog[f].push({ addr: base + 2, value: period & 0xFF });
              const hi = (period >> 8) & 0x07;
              if (hi !== lastHi) { writeLog[f].push({ addr: base + 3, value: hi }); lastHi = hi; }
            });
        } else {
          const period = applyDetune(pulsePeriod(seg.freq), seg.detune, 0x7FF);
          writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
          writeLog[startFrame].push({ addr: base + 3, value: (period >> 8) & 0x07 });
        }
        if (vTable) {
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
            (f, vol) => writeLog[f].push({ addr: base + 0, value: (duty << 6) | 0x30 | vol }));
        } else {
          writeLog[startFrame].push({ addr: base + 0, value: (duty << 6) | 0x30 | seg.volume });
          if (gateFrames < dur) writeLog[startFrame + gateFrames].push({ addr: base + 0, value: (duty << 6) | 0x30 });
        }
      } else {
        writeLog[startFrame].push({ addr: base + 0, value: 0x30 });
      }
      frame += dur;
    }

    return writeLog;
  }

  function mmc5InitWrites() {
    return [{ addr: 0x5015, value: 0x03 }];
  }

  // --- FME-7 (Sunsoft 5B) ---
  // @<n>はppmck準拠のミキサー指定(0=ミュート/1=トーン(既定)/2=ノイズ/3=トーン+ノイズ)。
  // ミキサーレジスタ(R7)は3ch共有の1バイトなので、ここ(chごと)では書かず
  // fme7MixerWrites()が全chぶんをまとめて1本のタイムラインとして生成する。
  function fme7Mode(seg) {
    const m = seg.instrument == null ? 1 : seg.instrument;
    return m & 3;
  }

  function segmentsToWriteLogFme7(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { v: {}, vr: {} };
    const periodRegLo = index * 2;
    const periodRegHi = index * 2 + 1;
    const volReg = 8 + index;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      const mode = fme7Mode(seg);
      if (seg.freq != null && mode !== 0) {
        if (mode === 2) {
          // @2(ノイズ)はppmck仕様で「ノート番号(n0=o0c〜n31=o2g)がそのままノイズ周期」に
          // なる。トーン周期は書かない(ミキサーでトーンを切っているため無意味)
          writeLog[startFrame].push({ addr: 0xC000, value: 6 });
          writeLog[startFrame].push({ addr: 0xE000, value: Math.max(0, Math.min(31, Math.round(seg.noteNumber))) });
        } else {
          if (hasPitchModulation(seg)) {
            writePitchModulation(writeLog, startFrame, dur, seg, env, fme7Period, 0xFFF,
              (f, period) => {
                writeLog[f].push({ addr: 0xC000, value: periodRegLo });
                writeLog[f].push({ addr: 0xE000, value: period & 0xFF });
                writeLog[f].push({ addr: 0xC000, value: periodRegHi });
                writeLog[f].push({ addr: 0xE000, value: (period >> 8) & 0x0F });
              });
          } else {
            const period = applyDetune(fme7Period(seg.freq), seg.detune, 0xFFF);
            writeLog[startFrame].push({ addr: 0xC000, value: periodRegLo });
            writeLog[startFrame].push({ addr: 0xE000, value: period & 0xFF });
            writeLog[startFrame].push({ addr: 0xC000, value: periodRegHi });
            writeLog[startFrame].push({ addr: 0xE000, value: (period >> 8) & 0x0F });
          }
          // R6: ノイズ周期(3chで共有の1レジスタ。実機PSGも同様の制約)。
          // ppmckでは@2のときN<n>は無効(ノート番号が周期になるため)
          if (seg.fme7Noise != null) {
            writeLog[startFrame].push({ addr: 0xC000, value: 6 });
            writeLog[startFrame].push({ addr: 0xE000, value: seg.fme7Noise & 0x1F });
          }
        }
        const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
        const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;
        if (seg.fme7EnvShape != null) {
          // R11/R12: エンベロープ周期(16bit), R13: 形状。この音符はハードウェアエンベロープ
          // 制御(音量レジスタのbit4=1)で鳴らす(Gimmick!ベース等のハードエンベロープ効果用)
          const period16 = seg.fme7EnvPeriod || 0;
          writeLog[startFrame].push({ addr: 0xC000, value: 11 });
          writeLog[startFrame].push({ addr: 0xE000, value: period16 & 0xFF });
          writeLog[startFrame].push({ addr: 0xC000, value: 12 });
          writeLog[startFrame].push({ addr: 0xE000, value: (period16 >> 8) & 0xFF });
          writeLog[startFrame].push({ addr: 0xC000, value: 13 });
          writeLog[startFrame].push({ addr: 0xE000, value: seg.fme7EnvShape & 0x0F });
          writeLog[startFrame].push({ addr: 0xC000, value: volReg });
          writeLog[startFrame].push({ addr: 0xE000, value: 0x10 });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: 0xC000, value: volReg });
            writeLog[startFrame + gateFrames].push({ addr: 0xE000, value: 0 });
          }
        } else if (vTable) {
          // ソフトウェア音量エンベロープ(@v<n>、AY自体の固定音量レジスタを1フレーム
          // ずつ書き換える。ハードウェアエンベロープ(S<n>/M<n>)とは別の仕組み)
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, (f, vol) => {
            writeLog[f].push({ addr: 0xC000, value: volReg });
            writeLog[f].push({ addr: 0xE000, value: vol });
          });
        } else {
          writeLog[startFrame].push({ addr: 0xC000, value: volReg });
          writeLog[startFrame].push({ addr: 0xE000, value: seg.volume });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: 0xC000, value: volReg });
            writeLog[startFrame + gateFrames].push({ addr: 0xE000, value: 0 });
          }
        }
      } else {
        writeLog[startFrame].push({ addr: 0xC000, value: volReg });
        writeLog[startFrame].push({ addr: 0xE000, value: 0 });
      }
      frame += dur;
    }

    return writeLog;
  }

  // R7(ミキサー): bit0-2=トーン有効(0で有効), bit3-5=ノイズ有効(0で有効)。
  // 初期状態は全ch無音(全bit=1)にしておき、実際の有効化は音符ごとの@<n>から
  // fme7MixerWrites()が組み立てるタイムラインに任せる
  function fme7InitWrites() {
    return [{ addr: 0xC000, value: 7 }, { addr: 0xE000, value: 0x3F }];
  }

  // R7は3ch共有の1バイトなので、chごとのwriteLogから独立に書くと他chのビットを
  // 壊してしまう。ここで3ch分の@<n>(ミキサーモード)をフレーム単位に展開し、
  // 値が変化したフレームにだけR7書き込みを出す1本のタイムラインへまとめる。
  function fme7MixerWrites(letters, segmentsByChannel, totalFrames) {
    // 各chの「フレーム→モード(0-3)」。音符の無い(=まだ何も鳴らしていない)区間は
    // ミュート扱いにして、そのchのビットを立てたままにする
    const modeByFrame = letters.map(ch => {
      const arr = new Uint8Array(totalFrames);
      let frame = 0;
      for (const seg of (segmentsByChannel[ch] || [])) {
        const end = Math.min(totalFrames, frame + seg.durationFrames);
        const mode = seg.freq == null ? 0 : fme7Mode(seg);
        for (let f = frame; f < end; f++) arr[f] = mode;
        frame = end;
        if (frame >= totalFrames) break;
      }
      return arr;
    });

    const writes = [];
    let prev = -1;
    for (let f = 0; f < totalFrames; f++) {
      let mixer = 0x3F; // 全bit=1(トーン・ノイズとも無効)から必要な分だけ落とす
      for (let ch = 0; ch < modeByFrame.length; ch++) {
        const mode = modeByFrame[ch][f];
        if (mode & 1) mixer &= ~(1 << ch);        // トーン有効
        if (mode & 2) mixer &= ~(1 << (3 + ch));  // ノイズ有効
      }
      if (mixer !== prev) {
        writes.push({ frame: f, writes: [{ addr: 0xC000, value: 7 }, { addr: 0xE000, value: mixer }] });
        prev = mixer;
      }
    }
    return writes;
  }

  // --- FDS ---
  // @<n>(instrument, ppmck表記では"M/N"チャンネルの音色番号)で @FM<n> 波形を選択する。
  // FDSは波形メモリが1系統しか無く全ch共有のため(実機の制約)、選択している番号が
  // 前の音符から変わったときだけ64byteの波形を書き直す
  function fdsWaveLoadWrites(wave) {
    if (!wave || wave.length !== 64) return [];
    const writes = [{ addr: 0x4089, value: 0x80 }];
    for (let i = 0; i < 64; i++) writes.push({ addr: 0x4040 + i, value: wave[i] & 0x3F });
    writes.push({ addr: 0x4089, value: 0x00 });
    return writes;
  }

  function segmentsToWriteLogFds(segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const fm = (envelopes && envelopes.fm) || {};
    const env = envelopes || { v: {}, vr: {} };
    let lastInstrument = null;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        if (fm[seg.instrument] && seg.instrument !== lastInstrument) {
          writeLog[startFrame].push(...fdsWaveLoadWrites(fm[seg.instrument]));
          lastInstrument = seg.instrument;
        }
        let period;
        if (hasPitchModulation(seg)) {
          period = null;
          // $4083(addr+3相当)は*2mml抽出側でアタック合図として扱われる(bit7=disableの
          // 立ち下がり/立ち上がりで波形位相をリセットする実機仕様、nsf2mml/expansion/fds.js
          // 参照)ため、値が変わった時だけ書く(2A03と同じ理由)。
          let lastHi = -1;
          writePitchModulation(writeLog, startFrame, dur, seg, env, fdsFreqToPeriod, 0xFFF,
            (f, p) => {
              period = p;
              writeLog[f].push({ addr: 0x4082, value: p & 0xFF });
              const hi = (p >> 8) & 0x0F;
              if (hi !== lastHi) { writeLog[f].push({ addr: 0x4083, value: hi }); lastHi = hi; }
            });
          if (period == null) period = applyDetune(fdsFreqToPeriod(seg.freq), seg.detune, 0xFFF);
        } else {
          period = applyDetune(fdsFreqToPeriod(seg.freq), seg.detune, 0xFFF);
          writeLog[startFrame].push({ addr: 0x4082, value: period & 0xFF });
          writeLog[startFrame].push({ addr: 0x4083, value: (period >> 8) & 0x0F });
        }
        const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
        const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;
        if (vTable) {
          // 直接指定モード(bit7=1)のまま、@v<n>テーブルの値でゲインを1フレームずつ
          // 書き換える(FDSの実機ハードウェアエンベロープ(bit7=0)は使わない。あちらは
          // nsf2mml側の抽出でのみ使う独立した経路)
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable,
            (f, vol) => writeLog[f].push({ addr: 0x4080, value: 0x80 | Math.min(32, vol * 2) }));
        } else {
          const gain = Math.min(32, seg.volume * 2);
          writeLog[startFrame].push({ addr: 0x4080, value: 0x80 | gain });
        }
        if (gateFrames < dur) {
          writeLog[startFrame + gateFrames].push({ addr: 0x4083, value: 0x80 | ((period >> 8) & 0x0F) });
        }
      } else {
        writeLog[startFrame].push({ addr: 0x4083, value: 0x80 });
      }
      frame += dur;
    }

    return writeLog;
  }

  function fdsDefaultWave() {
    const wave = new Array(64);
    for (let i = 0; i < 64; i++) {
      wave[i] = Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * i) / 64));
    }
    return wave;
  }

  function fdsInitWrites(customWave) {
    const wave = (customWave && customWave.length === 64) ? customWave : fdsDefaultWave();
    const writes = [];
    writes.push({ addr: 0x4089, value: 0x80 }); // 波形メモリ書き込み許可
    for (let i = 0; i < 64; i++) {
      writes.push({ addr: 0x4040 + i, value: wave[i] & 0x3F });
    }
    writes.push({ addr: 0x4089, value: 0x00 }); // 書き込み禁止・マスター音量フル
    return writes;
  }

  // --- N163 ---
  function n163DefaultWave() {
    return [0, 2, 4, 6, 8, 10, 12, 14, 15, 13, 11, 9, 7, 5, 3, 1];
  }

  // 実機の$4800書き込みはRAMへの「1バイト」書き込みで、波形読み出し側(+6=波形アドレス、
  // N163Audio._sample/resampleWave参照)は「1ニブル=4bitサンプル」単位でその領域を読む。
  // つまり書き込み側も2サンプルを1バイトに詰めて書く必要がある(以前は0-15の値をそのまま
  // 1バイト=1サンプルとして書いていたため、読み出し側は毎回上位ニブル=0を挟んで読んでしまい
  // 波形が[0,0,2,0,4,0,...]のように歯抜けに壊れていた)。waveは既にnormalizeN163Waveで
  // 実際に使う長さへ揃え済みなので、wave.length分だけ詰める。
  function n163PackWaveBytes(wave) {
    const bytes = [];
    for (let i = 0; i < wave.length; i += 2) {
      bytes.push((wave[i] & 0x0F) | ((wave[i + 1] & 0x0F) << 4));
    }
    return bytes;
  }

  function n163InitWrites(numN163Ch) {
    const num = Math.max(1, Math.min(N163_CHANNEL_COUNT, numN163Ch || N163_CHANNEL_COUNT));
    // 波形データの配置は共有アロケータ(MML.N163Alloc、segmentsToWriteLogN163内で使用)が
    // 曲の実際の使用状況に応じて動的に行うため、ここではchごとの専用スロットへの既定波形の
    // 事前書き込みは行わない(@N<n>を一度も呼ばないchは波形が不定になる既知の制限。
    // 予約領域を作らずRAM全体を共有プールにする、というユーザー確認済みの設計)。
    // $7F(内部アドレス、ゼロページではなくポート経由)に有効ch数だけを設定する。
    return [
      { addr: 0xF800, value: 0x7F | 0x80 },
      { addr: 0x4800, value: (num - 1) << 4 }
    ];
  }

  // @<n>(instrument)で @N<n> 波形を選択する。共有アロケータが割り当てたbyteOffsetは
  // chごとに固定ではなくなったため、波形本体だけでなく波形アドレス(+6、ニブル単位=
  // byteOffset*2)も毎回書き直す(以前は初期化時のみで不変という前提だったが、その前提は
  // もう成り立たない)。
  function n163WaveLoadWrites(wave, byteOffset, regBase) {
    if (!wave) return [];
    const packed = n163PackWaveBytes(wave);
    const writes = [{ addr: 0xF800, value: byteOffset | 0x80 }];
    for (const b of packed) writes.push({ addr: 0x4800, value: b });
    writes.push({ addr: 0xF800, value: (regBase + 6) | 0x80 });
    writes.push({ addr: 0x4800, value: byteOffset * 2 });
    return writes;
  }

  // occurrences: MML.N163Alloc.allocate()が返す配列全体(全N163ch分)。このch(ch文字)の
  // ものだけを開始フレームで引けるようにする
  function segmentsToWriteLogN163(ch, index, segments, totalFrames, envelopes, numN163Ch, occurrences) {
    const writeLog = newWriteLog(totalFrames);
    // 実機は内部8ch中「上位 num 個」だけを巡回・ミックスする。letters[index] の内部インデックスは
    // (8-num)+index(下位アドレス側から)。0番から詰めると鳴らないため必ずオフセットする。
    const num = Math.max(1, Math.min(N163_CHANNEL_COUNT, numN163Ch || N163_CHANNEL_COUNT));
    const internalIdx = (N163_CHANNEL_COUNT - num) + index;
    const regBase = 0x40 + internalIdx * 8;
    const nMap = (envelopes && envelopes.n) || {};
    const env = envelopes || { v: {}, vr: {} };
    let lastInstrument = null;
    // @N<n>を一度も呼んでいない間の既定値(無難なフォールバック。実際に鳴らす場合は
    // 作曲者が必ず@<n>で切り替えるはずなので、この値が実際に使われることはまず無い)
    let currentLengthByte = 0xF0, currentRoundedLen = 16;
    const occByStart = new Map();
    for (const occ of (occurrences || [])) if (occ.channel === ch) occByStart.set(occ.startFrame, occ);
    // 最上位ch(internalIdx=7)の音量レジスタ(+7)は $7F で有効ch数ビット(4-6)と共用のため、
    // 音量を書くときも numCh ビットを保持する必要がある(他chの+7上位ビットは未使用)。
    const isTopCh = (regBase + 7) === 0x7F;
    const volByte = vol => (isTopCh ? ((num - 1) << 4) : 0) | (vol & 0x0F);

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        if (nMap[seg.instrument] && seg.instrument !== lastInstrument) {
          const occ = occByStart.get(startFrame);
          if (occ) {
            currentRoundedLen = MML.N163Alloc.roundedLen(nMap[seg.instrument].length);
            currentLengthByte = occ.lengthByte;
            writeLog[startFrame].push(...n163WaveLoadWrites(
              normalizeN163Wave(nMap[seg.instrument], currentRoundedLen), occ.byteOffset, regBase));
          }
          // occが無い場合はRAM配置に失敗している(compiled.errorsにconflictとして記録済み・
          // 呼び出し元は既にコンパイルを中断しているはず)。書き込みは行わず現状維持に留める
          lastInstrument = seg.instrument;
        }
        // 周波数は実機のインターリーブ配置に従い +0/+2/+4 へ書く(間の位相バイト +1/+3 は
        // 触らない)。オートインクリメントに頼らずアドレスを都度選択する。波形長は +4 の上位に共用。
        const writeN163Freq = (f, freqReg) => {
          writeLog[f].push({ addr: 0xF800, value: (regBase + 0) });
          writeLog[f].push({ addr: 0x4800, value: freqReg & 0xFF });
          writeLog[f].push({ addr: 0xF800, value: (regBase + 2) });
          writeLog[f].push({ addr: 0x4800, value: (freqReg >> 8) & 0xFF });
          writeLog[f].push({ addr: 0xF800, value: (regBase + 4) });
          writeLog[f].push({ addr: 0x4800, value: currentLengthByte | ((freqReg >> 16) & 0x03) });
        };
        if (hasPitchModulation(seg)) {
          writePitchModulation(writeLog, startFrame, dur, seg, env,
            freq => n163FreqReg(freq, currentRoundedLen, num), 262143, writeN163Freq);
        } else {
          const freqReg = applyDetune(n163FreqReg(seg.freq, currentRoundedLen, num), seg.detune, 262143);
          writeN163Freq(startFrame, freqReg);
        }
        const vTable = seg.envelopeV != null ? env.v[seg.envelopeV] : null;
        const vrTable = (vTable && seg.envelopeVr !== 255) ? env.vr[seg.envelopeVr] : null;
        if (vTable) {
          writeVolumeEnvelope(writeLog, startFrame, gateFrames, dur, vTable, vrTable, (f, vol) => {
            writeLog[f].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
            writeLog[f].push({ addr: 0x4800, value: volByte(vol) });
          });
        } else {
          writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
          writeLog[startFrame].push({ addr: 0x4800, value: volByte(seg.volume) });
          if (gateFrames < dur) {
            writeLog[startFrame + gateFrames].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
            writeLog[startFrame + gateFrames].push({ addr: 0x4800, value: volByte(0) });
          }
        }
      } else {
        writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 7) | 0x80 });
        writeLog[startFrame].push({ addr: 0x4800, value: volByte(0) });
      }
      frame += dur;
    }

    return writeLog;
  }

  // --- VRC7 ---
  function segmentsToWriteLogVrc7(index, segments, totalFrames, envelopes) {
    const writeLog = newWriteLog(totalFrames);
    const env = envelopes || { en: {} };
    const ch = index;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        const { fnum: baseFnum, block } = vrc7FreqToFnumBlock(seg.freq);
        // fnumは同一block内では周波数に比例するため、他チップと同じ生レジスタへの単純加算
        // オフセットでデチューンできる(0-511の9bit幅でクランプ、block自体は変えない)。
        // block境界をまたぐ本来のデチューン量が必要な場合でも、この曲の狭い範囲の
        // デチューン効果には影響しない程度の近似として十分(他チップのapplyDetuneも
        // 同様に単純クランプのみでキャリー処理はしていない)。
        const fnum = applyDetune(baseFnum, seg.detune, 511);
        const instrument = seg.instrument % 16;
        writeLog[startFrame].push({ addr: 0x9010, value: 0x10 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: fnum & 0xFF });
        // キーオン(bit4)はYM2413実機同様エッジトリガ(src/emulator/expansion/vrc7.js
        // slotOn: keyStatusが既に1のままだとエンベロープが再スタートしない)。前の音符が
        // レガート(ゲート=フル、無音区間なし)で直前まで鳴っていた場合、単にbit4=1を
        // 書くだけでは0→1の遷移が起きず、2音目以降が完全に無音になっていた
        // (Final Fantasy(MSX)で実測)。必ずキーオフを1回挟んでからキーオンを書き、
        // 前の状態に関わらずエッジを保証する。
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: (block << 1) | ((fnum >> 8) & 1) });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0x10 | (block << 1) | ((fnum >> 8) & 1) });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x30 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: (instrument << 4) | seg.volume });
        // EN(ノートエンベロープ)はノート番号空間なのでfnum/block両方に影響しうる
        // (ここだけ他チップと違いvrc7FreqToFnumBlock()でblockごと再計算する)。
        // D<n>/EP/MPはfnum/blockの対数的表現のため対象外(上のapplyDetuneのコメント通り、
        // このチップだけ既存のD<n>実装から一貫して除外している)。
        // キーオン後の再書き込みはkeyonビット(0x10)を立てたまま行い、エッジトリガを
        // 再発生させない(音符の頭でのみ発生させる、上の一連の書き込みと同じ理由)
        if (seg.noteEnv != null && seg.noteEnv !== 255) {
          const table = env.en[seg.noteEnv];
          if (table) {
            let lastFnum = fnum, lastBlock = block;
            for (let t = 1; t < gateFrames; t++) {
              const delta = cumulativeEnvelopeValue(table, t);
              if (delta === 0) continue;
              const { fnum: f2, block: b2 } = vrc7FreqToFnumBlock(noteFrequency(seg.noteNumber + delta));
              if (f2 === lastFnum && b2 === lastBlock) continue;
              writeLog[startFrame + t].push({ addr: 0x9010, value: 0x10 + ch });
              writeLog[startFrame + t].push({ addr: 0x9030, value: f2 & 0xFF });
              writeLog[startFrame + t].push({ addr: 0x9010, value: 0x20 + ch });
              writeLog[startFrame + t].push({ addr: 0x9030, value: 0x10 | (b2 << 1) | ((f2 >> 8) & 1) });
              lastFnum = f2; lastBlock = b2;
            }
          }
        }
        if (gateFrames < dur) {
          writeLog[startFrame + gateFrames].push({ addr: 0x9010, value: 0x20 + ch });
          writeLog[startFrame + gateFrames].push({ addr: 0x9030, value: (block << 1) | ((fnum >> 8) & 1) });
        }
      } else {
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0 });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x30 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0 });
      }
      frame += dur;
    }

    return writeLog;
  }

  // @OP<n>で定義した8バイトをVRC7のカスタム音色(パッチ0)レジスタ($00-$07)へロードする。
  // VRC7はカスタム音色スロットが1つしか無く全ch共有のため(FDS波形メモリ・N163共有波形と
  // 同様の制約)、曲開始時に一度だけ読み込む
  function vrc7InitWrites(bytes) {
    if (!bytes || bytes.length !== 8) return [];
    const writes = [];
    for (let i = 0; i < 8; i++) {
      writes.push({ addr: 0x9010, value: i });
      writes.push({ addr: 0x9030, value: bytes[i] & 0xFF });
    }
    return writes;
  }

  // @N<n>の波形値をtargetLen(共有アロケータが決めた、実機レジスタ丸め後の長さ)へ
  // 正規化する(不足はゼロ埋め、超過は切り詰め)。作曲者が書いた要素数がそのまま
  // 波形長になる仕様なので、以前のような固定16サンプルへの強制丸めはしない。
  function normalizeN163Wave(values, targetLen) {
    if (!values || values.length === 0) return null;
    const len = targetLen || values.length;
    const wave = values.slice(0, len);
    while (wave.length < len) wave.push(0);
    return wave;
  }

  // OP<n>(VRC7)/MH<n>(FDS)のような音符に紐付かない即時コマンドを、記録された
  // フレーム位置のwriteLogへ差し込む。resolverはimmediateWrite 1件から
  // { writes, frameOffset } (frameOffsetは省略可、delay等の追加オフセット用)を返す
  function spliceImmediateWrites(writeLog, immediateWrites, kind, totalFrames, resolver) {
    for (const iw of immediateWrites) {
      if (iw.kind !== kind) continue;
      const resolved = resolver(iw);
      if (!resolved || !resolved.writes || resolved.writes.length === 0) continue;
      const frame = Math.min(Math.max(0, iw.frame + (resolved.frameOffset || 0)), totalFrames - 1);
      writeLog[frame] = [...writeLog[frame], ...resolved.writes];
    }
  }

  function resolveVrc7ToneWrite(iw, envelopes) {
    if (iw.value === 255) return null; // OPOFに相当する明確な仕様が無いため何もしない
    const bytes = envelopes.op && envelopes.op[iw.value];
    return { writes: vrc7InitWrites(bytes) };
  }

  function resolveFdsModWrite(iw, envelopes) {
    if (iw.value === 255) {
      // MHOF: gain=0にするだけでなく$4087のbit7=1で変調ユニット自体を停止する
      // (実機Almana no Kisekiで実測: 常に[$4084=gain0, $4087=stop]の2本組で書かれる)。
      // 停止しないとカウンタ/テーブル位置が裏で回り続け、次にMH<n>で再開したとき
      // (直後に$4085リセットが無いような書き方をされた場合)想定と違う位相から
      // 再開してしまう
      return { writes: [{ addr: 0x4084, value: 0x80 }, { addr: 0x4087, value: 0x80 }] };
    }
    const mh = envelopes.mh && envelopes.mh[iw.value];
    if (!mh) return null;
    const wave = envelopes.mw && envelopes.mw[mh.waveform];
    const writes = [];
    writes.push({ addr: 0x4087, value: 0x80 }); // 一旦停止(テーブル書込み許可・書込位置リセット)
    // モジュレータカウンタを0にリセットする。実機の$4085直接設定書込みに相当し、
    // これが無いと前回のMH<n>で溜まったカウンタ値が残ったまま新しい変調に引き継がれ、
    // 意図しない偏った(非対称な)ピッチ変調になる(実測: Almana no Kisekiは
    // モジュレーション再ロードのたび必ず$4085=0を書いている)
    writes.push({ addr: 0x4085, value: 0 });
    if (wave) {
      for (let k = 0; k < 32; k++) writes.push({ addr: 0x4088, value: (wave[k] || 0) & 0x07 });
    }
    writes.push({ addr: 0x4086, value: (mh.freq || 0) & 0xFF });
    writes.push({ addr: 0x4087, value: ((mh.freq || 0) >> 8) & 0x0F }); // bit7=0で再開
    writes.push({ addr: 0x4084, value: 0x80 | ((mh.depth || 0) & 0x3F) });
    return { writes, frameOffset: mh.delay || 0 };
  }

  // --- DPCM ---
  // @DPCM<n>で解決済みのサンプルバイト列(dpcmSamples、opt.dpcmSamplesで実バイトが
  // 埋まったもの)を、DMCハードウェアが読める$C000-$FFFF(16KB)へ64バイト境界で
  // 順に敷き詰め、$4010-4013相当のレジスタ値を計算する。
  // 注意: 実機の$4013(サンプル長)は「(値×16)+1」バイトという奇妙な単位のため、
  // 元データの長さそのままでは割り切れないことが多い。ここでは元データ全体が
  // 必ず収まるよう切り上げて(元データより最大15バイト多く、末尾はゼロパディング)
  // レジスタ値を決める(データが途中で切れることはない)。
  // ブラウザ内プレビュー(player.js)用の仮想メモリ配置であり、実際のNSF書き出し時の
  // ROM配置(フェーズ1.7タスク4、$5FFC-$5FFFの専用バンク)とは別
  function layoutDpcmSamples(dpcmSamples) {
    const layout = {};
    let offset = 0; // $C000からのオフセット(バイト)
    for (const idx of Object.keys(dpcmSamples)) {
      const def = dpcmSamples[idx];
      if (!def.bytes || def.bytes.length === 0) continue;
      const rawLen = def.bytes.length;
      const lengthReg = Math.min(255, Math.max(0, Math.ceil((rawLen - 1) / 16)));
      const playLen = lengthReg * 16 + 1;
      if (offset % 64 !== 0) offset += 64 - (offset % 64);
      if (offset + playLen > 0x4000) continue; // 16KB上限を超える分は配置しない(該当サンプルは無音)
      const addr = 0xC000 + offset;
      layout[idx] = {
        addr,
        addrReg: offset >> 6,
        lengthReg,
        playLen,
        // dac===255(またはundefined)は「DAC値を変更しない」という実機ppmck driverの
        // 慣例(dpcm.hのskipラベル)に合わせ、$4011書き込み自体を省略する
        dac: (def.dac == null || def.dac === 255) ? null : (def.dac & 0x7F),
        // $4013(長さレジスタ)は8bitのため実機DMCはplayLenバイトまでしか読み出さない。
        // rawLenがplayLenを超える(=lengthRegが255で頭打ちになった)場合、元データを
        // そのまま保持するとここで確保した領域(offsetの増分もplayLen基準)を超えて
        // 書き込まれ、64KB仮想メモリ(src/audio/stream-player.js buildDpcmBus)の
        // 境界超過(RangeError)やNSF書き出し側(ppmckDriver.js)の固定領域破壊を招く
        // (HESの長いDDA/PCM抽出で実測)。再生されない末尾は切り詰めて安全側に倒す。
        bytes: def.bytes.slice(0, playLen)
      };
      offset += playLen;
    }
    return layout;
  }

  // o4 c (noteNumber=48) を基準ノートとする。@DPCM<n>のfreq(0-15)は「基準ノートを
  // 鳴らした時のレート」を表し、他の音高はDMC_RATE_TABLE_NTSC上で基準からの
  // オクターブ比(2^(半音差/12))に最も近い(対数距離で比較)レートへ丸める
  const DPCM_BASE_NOTE = 48;

  // ノート音高(noteNumber)から、@DPCM<n>のfreq(基準レート)を起点に最も近い
  // DMCレート(0-15)を選ぶ。実機のレート表は等間隔の音階ではない(実機自体の制約)ため、
  // 半音単位の完全な音程は出せず最近傍への量子化になる
  function dpcmRateIndexForNote(baseFreqIndex, noteNumber) {
    const table = (MML.Dpcm && MML.Dpcm.DMC_RATE_TABLE_NTSC) || null;
    if (!table) return baseFreqIndex & 0x0F;
    const baseHz = table[baseFreqIndex & 0x0F] || table[8];
    const targetHz = baseHz * Math.pow(2, (noteNumber - DPCM_BASE_NOTE) / 12);
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < table.length; i++) {
      const diff = Math.abs(Math.log2(table[i] / targetHz));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  // @<n>(instrument)で選択した@DPCM<n>サンプルを、音符が来るたびにトリガーする。
  // ノートの音高(noteNumber)は、そのサンプル定義のfreq(基準レート)を起点に
  // dpcmRateIndexForNoteで最も近いDMCレートへ変換し、$4010の下位4bitとして使う
  // (実機同様、疑似的な音階表現に対応。ただしDMCレート表自体が均等な音階ではないため
  // 厳密な半音は出ない)。このツール独自の簡略化点: 実機ppmckはノートバイトの値が
  // 直接dpcm_dataテーブルのインデックスになる(サンプル選択そのものがノート値)方式だが、
  // 本実装では既存のFDS/N163と同じ「@<n>でサンプルを選び、ノートは音高+トリガー」
  // 方式に統一した(サンプル選択と音高を分離できる分、MML表現としては柔軟)
  function segmentsToWriteLogDpcm(segments, totalFrames, dpcmLayout, dpcmSamples) {
    const writeLog = newWriteLog(totalFrames);
    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        const layout = dpcmLayout[seg.instrument];
        const def = dpcmSamples[seg.instrument];
        if (layout && def) {
          const rateIndex = dpcmRateIndexForNote(def.freq, seg.noteNumber);
          const control = ((def.mode ? 0x40 : 0) | (rateIndex & 0x0F)) & 0x7F;
          writeLog[startFrame].push({ addr: 0x4015, value: 0x0F }); // DMC一旦停止(2A03他chは維持)
          writeLog[startFrame].push({ addr: 0x4010, value: control });
          if (layout.dac != null) writeLog[startFrame].push({ addr: 0x4011, value: layout.dac });
          writeLog[startFrame].push({ addr: 0x4012, value: layout.addrReg });
          writeLog[startFrame].push({ addr: 0x4013, value: layout.lengthReg });
          writeLog[startFrame].push({ addr: 0x4015, value: 0x1F }); // 再生開始
        }
        if (gateFrames < dur) {
          writeLog[startFrame + gateFrames].push({ addr: 0x4015, value: 0x0F }); // ゲート終了で停止
        }
      }
      frame += dur;
    }
    return writeLog;
  }

  function buildExpansionWriteLog(expansion, ch, index, segments, totalFrames, envelopes, dpcmLayout, dpcmSamples, extra) {
    switch (expansion) {
      case 'vrc6': return segmentsToWriteLogVrc6(index, segments, totalFrames, envelopes);
      case 'mmc5': return segmentsToWriteLogMmc5(index, segments, totalFrames, envelopes);
      case 'fme7': return segmentsToWriteLogFme7(index, segments, totalFrames, envelopes);
      case 'fds': return segmentsToWriteLogFds(segments, totalFrames, envelopes);
      case 'n163': return segmentsToWriteLogN163(ch, index, segments, totalFrames, envelopes,
        extra && extra.numN163Ch, extra && extra.n163Occurrences);
      case 'vrc7': return segmentsToWriteLogVrc7(index, segments, totalFrames, envelopes);
      case 'dpcm': return segmentsToWriteLogDpcm(segments, totalFrames, dpcmLayout, dpcmSamples);
      default: return newWriteLog(totalFrames);
    }
  }

  // VRC7(OP<n>)/FDS(@<n>によるFM<n>選択)/N163(@<n>によるN<n>選択)は曲中の動的切り替えに
  // 対応した(segmentsToWriteLogFds/N163の instrument変化検出、および
  // spliceImmediateWritesによるOP<n>の差し込み)ため、ここでの「@OP0/@FM0/@N0を
  // 曲頭に自動プリロード」は行わない(初回使用時に自然にロードされる/composerが
  // 明示的にOP<n>を呼ぶのが実機の挙動)。opt.fdsWave/opt.n163Wave(波形エディタUI由来、
  // MML本文に@FM/@N定義が無い場合の既定波形)はこれとは別物として引き続き曲頭に適用する
  function expansionInitWrites(expansion, opt, envelopes, extra) {
    switch (expansion) {
      case 'mmc5': return mmc5InitWrites();
      case 'fme7': return fme7InitWrites();
      case 'fds': return fdsInitWrites(opt && opt.fdsWave);
      case 'n163': return n163InitWrites(extra && extra.numN163Ch);
      default: return [];
    }
  }

  Mml.compile = function (source, opt = {}) {
    const errors = [];
    const { channels, errors: splitErrors, envelopes, meta, settings, detectedExpansions } = Mml.splitChannels(source);
    errors.push(...splitErrors);

    // #EX-VRC6等でMML本文が宣言した拡張音源は、opt.expansions(UI選択)と統合する
    // (INV-2: MMLテキストが正典。UIの選択有無に関わらずMML側の宣言を尊重する)
    const expansions = normalizeExpansions({ expansions: [...(opt.expansions || (opt.expansion ? [opt.expansion] : [])), ...detectedExpansions] });
    const expansionLetterMap = assignExpansionLetters(expansions);
    const expansionLetters = expansions.flatMap(exp => expansionLetterMap[exp]);

    // @DPCM<n>定義と opt.dpcmSamples[filename]=Uint8Array(UI層でファイル選択・変換済みの
    // バイト列)を突き合わせる。フェーズA: ここではまだ実際の再生チャンネルへは配線しない
    // (専用チャンネル文字の割当は別タスク。ROADMAP.mdフェーズ9参照)。bytesがnullの場合は
    // 未読込(該当ファイルがopt.dpcmSamplesに渡されていない)ことを示す
    const dpcmSamples = {};
    for (const idx of Object.keys(envelopes.dpcm)) {
      const def = envelopes.dpcm[idx];
      dpcmSamples[idx] = { ...def, bytes: (opt.dpcmSamples && opt.dpcmSamples[def.file]) || null };
    }
    const dpcmLayout = layoutDpcmSamples(dpcmSamples);

    // グローバルテンポ: 最初に出現した t<n> を採用 (デフォルト120)
    let tempo = 120;
    for (const ch of Object.keys(channels)) {
      const tokens = Mml.tokenize(channels[ch].text);
      const t = tokens.find(tok => tok.type === 'tempo');
      if (t) { tempo = t.value; break; }
    }

    const channelLetters = ['A', 'B', 'C', 'D', ...expansionLetters];
    const segmentsByChannel = {};
    const immediateWritesByChannel = {};
    const loopFrameByChannel = {};
    let totalFrames = 0;

    const fme7Letters = new Set(expansionLetterMap.fme7 || []);
    for (const ch of channelLetters) {
      const raw = channels[ch] || { text: '', offsets: [] };
      let tokens = Mml.tokenize(raw.text, raw.offsets);
      tokens = expandLoops(tokens, errors);
      tokens = applyTuplets(tokens, tempo, errors);
      const { segments, immediateWrites, loopFrame } = buildSegments(tokens, tempo, errors, settings, fme7Letters.has(ch) ? 1 : 0);
      segmentsByChannel[ch] = segments;
      immediateWritesByChannel[ch] = immediateWrites;
      loopFrameByChannel[ch] = loopFrame;
      const sum = segments.reduce((a, s) => a + s.durationFrames, 0);
      totalFrames = Math.max(totalFrames, sum);
    }

    totalFrames = Math.max(1, totalFrames);

    // L(ループ地点)は全チャンネルに同じフレーム位置で置くのが前提の使い方のため、
    // チャンネルレターの並び順(A,B,C,D,拡張...)で最初に見つかったチャンネルの値を
    // 曲全体のループ地点として採用する
    let loopPointFrame = null;
    for (const ch of channelLetters) {
      if (loopFrameByChannel[ch] != null) { loopPointFrame = loopFrameByChannel[ch]; break; }
    }

    // 再生ハイライト用: フレーム位置 -> ソース文字範囲の対応表(全チャンネル)
    const highlightRanges = {};
    for (const ch of channelLetters) {
      const ranges = [];
      let frame = 0;
      for (const seg of segmentsByChannel[ch]) {
        if (seg.srcStart != null) {
          ranges.push({ startFrame: frame, endFrame: frame + seg.durationFrames, srcStart: seg.srcStart, srcEnd: seg.srcEnd });
        }
        frame += seg.durationFrames;
      }
      highlightRanges[ch] = ranges;
    }

    const tracks = {};
    for (const ch of ['A', 'B', 'C', 'D']) {
      tracks[ch] = segmentsToWriteLog2A03(ch, segmentsByChannel[ch], totalFrames, envelopes);
    }

    for (const exp of expansions) {
      const letters = expansionLetterMap[exp];
      // 拡張音源ごとの追加情報(ライト生成・初期化の両方で使う)。N163は実際に使われている
      // チャンネル数(音符を持つ最上位レターの位置+1)を有効ch数として全ライトへ伝える。
      let extra;
      if (exp === 'n163') {
        let numN163Ch = 0;
        letters.forEach((ch, index) => {
          if ((segmentsByChannel[ch] || []).some(s => s.freq != null)) numN163Ch = index + 1;
        });
        // 共有バッファアロケータ: 曲全体のN163使用状況から、時間軸で重ならない範囲だけ
        // 波形データを再利用しながらRAM上のバイト位置を割り当てる。128byteを超えて
        // 同時使用される場合はconflictとして記録し、コンパイルエラーへ変換する
        const allocResult = MML.N163Alloc.allocate(letters, segmentsByChannel, envelopes.n, totalFrames);
        for (const c of allocResult.conflicts) errors.push({ message: c.message });
        extra = { numN163Ch: Math.max(1, numN163Ch), n163Occurrences: allocResult.occurrences };
      }
      letters.forEach((ch, index) => {
        tracks[ch] = buildExpansionWriteLog(exp, ch, index, segmentsByChannel[ch], totalFrames, envelopes, dpcmLayout, dpcmSamples, extra);
        // OP<n>(VRC7音色)/MH<n>(FDS変調)による曲中の動的切り替えをこのchへ差し込む
        if (exp === 'vrc7') {
          spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'vrc7Tone', totalFrames,
            iw => resolveVrc7ToneWrite(iw, envelopes));
        } else if (exp === 'fds') {
          spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'fdsMod', totalFrames,
            iw => resolveFdsModWrite(iw, envelopes));
        }
      });
      // ミキサー(R7)は3ch共有のため、chごとのwriteLogではなく先頭chへ1本にまとめて挿す
      if (exp === 'fme7' && letters.length > 0) {
        for (const { frame, writes } of fme7MixerWrites(letters, segmentsByChannel, totalFrames)) {
          tracks[letters[0]][frame] = [...writes, ...tracks[letters[0]][frame]];
        }
      }
      const initWrites = expansionInitWrites(exp, opt, envelopes, extra);
      if (initWrites.length > 0 && letters.length > 0) {
        tracks[letters[0]][0] = [...initWrites, ...tracks[letters[0]][0]];
      }
    }

    // L(ループ地点)が使われている場合、このツール(ブラウザ再生・シークバー)での
    // 「曲の長さ」は "曲頭からLへ2回戻るまで"(=イントロ1回 + ループ区間を2回)とする。
    // 各セグメント生成関数(segmentsToWriteLogXxx)は音符ごとに周波数・音量・音色を
    // 必ずフルに書き直す設計(未書込のまま前フレームの値を引き継ぐ書き方をしていない)
    // ため、書き込みログの[loopPointFrame, naturalEndFrame)を単純に複製して末尾へ
    // 追加するだけで「実際にそこへ戻って演奏した場合」と同じ結果になる。
    // NSF書き出し側(src/driver/ppmckDriver.js)はこれとは別に、loopFrameByChannelを使って
    // 実機同様の(このツールの都合による打ち切りが無い)本当の無限ループを行う
    if (loopPointFrame != null && loopPointFrame < totalFrames) {
      const naturalEndFrame = totalFrames;
      const loopLen = naturalEndFrame - loopPointFrame;
      for (const ch of Object.keys(tracks)) {
        tracks[ch] = tracks[ch].concat(tracks[ch].slice(loopPointFrame, naturalEndFrame));
      }
      for (const ch of Object.keys(highlightRanges)) {
        const extraRanges = [];
        for (const r of highlightRanges[ch]) {
          if (r.endFrame <= loopPointFrame) continue;
          extraRanges.push({
            startFrame: Math.max(r.startFrame, loopPointFrame) + loopLen,
            endFrame: r.endFrame + loopLen,
            srcStart: r.srcStart,
            srcEnd: r.srcEnd
          });
        }
        highlightRanges[ch] = highlightRanges[ch].concat(extraRanges);
      }
      totalFrames = naturalEndFrame + loopLen;
    }

    return {
      tracks,
      totalFrames,
      tempo,
      expansions,
      expansionLetterMap,
      channelLetters,
      loopFrameByChannel,
      loopPointFrame,
      highlightRanges,
      errors,
      frameRate: FRAME_RATE_NTSC,
      statusAddr: STATUS_ADDR,
      meta,
      settings,
      detectedExpansions,
      dpcmSamples,
      dpcmLayout,
      segmentsByChannel,
      envelopes,
      immediateWritesByChannel
    };
  };

  Mml.CHANNEL_BASE = CHANNEL_BASE;
  Mml.CHIP_CHANNEL_COUNTS = CHIP_CHANNEL_COUNTS;
  Mml.EXPANSION_PRIORITY = EXPANSION_PRIORITY;
  Mml.assignExpansionLetters = assignExpansionLetters;
  Mml.FRAME_RATE_NTSC = FRAME_RATE_NTSC;
  Mml.N163_WAVE_LEN = N163_WAVE_LEN;
  Mml.N163_CHANNEL_COUNT = N163_CHANNEL_COUNT;
  Mml.fdsDefaultWave = fdsDefaultWave;
  Mml.n163DefaultWave = n163DefaultWave;
  Mml.dpcmRateIndexForNote = dpcmRateIndexForNote;
  Mml.DPCM_BASE_NOTE = DPCM_BASE_NOTE;
})(window);
