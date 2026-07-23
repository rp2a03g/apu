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
 *                  2A03パルス/三角(A/B/C)・VRC6・MMC5・FME7・FDS・N163対応(N163は
 *                  周波数レジスタが18bit相当のスケールのため同じ値でも変化量は小さくなる)。
 *                  VRC7はfnum/blockの対数的表現のため対象外
 *   @<n>           音色番号 (パルスのデューティ比 = n % 4 / VRC6パルスのデューティ比 = n % 8
 *                  (実機同様8段階) / VRC7の音色番号 = n % 16)
 *   &              タイ（直前の音を伸ばす）
 *   [ ... ]n       繰り返し (n回)
 *   [ ... | ... ]n 繰り返し (最後の周回だけ | から ] までを演奏しない)
 *   { ... }<len>   連符 (中の音符列を<len>の音長で等分)
 *   EN<n> / ENOF   ノートエンベロープ(高速アルペジオ)。@EN<n>={...}で定義(前回値からの
 *                  相対値・累積、仕様通り厳密実装)。A/B/C/D全チャンネルで使用可
 *   EP<n> / EPOF   ピッチエンベロープ。@EP<n>={...}で定義(値/128を半音として加算)。
 *                  A/B/Cチャンネルのみ(近似実装、下記参照)
 *   MP<n> / MPOF   ソフトウェアビブラート。@MP<n>={delay,speed,depth}で定義。
 *                  A/B/Cチャンネルのみ(近似実装、下記参照)
 *   s<speed>,<depth> スイープ(半音、符号付き)。A/B/Cチャンネルのみ(近似実装、下記参照)
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
 *   N<n>             FME7ノイズ周波数(0-31)。曲全体でN<n>を使うchだけ曲開始時にミキサーで有効化
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
 * 注意: EP/MP/s/@OTはppmck実機ドライバ(sounddrv.h)の内部除算ルーチンや音色データの
 * ビット配置まで確証を得られていない箇所があり、「妥当な近似」として実装している
 * (EN・FME7のS/M/N・VRC7の@OP生バイト形式は仕様・実例と厳密一致を確認済み)。
 * 詳細はROADMAP.mdフェーズ1.5参照。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Mml = MML.Mml = MML.Mml || {};

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
  // N163(freqReg、262143幅。18bitスケールなので同じ値でも変化量は小さい)も対応。
  // VRC7(fnum/blockの対数的な表現)は単純な加算オフセットが意味を持たないため対象外
  function applyDetune(period, detune, max) {
    return Math.max(0, Math.min(max, period + (detune || 0)));
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

  // FME-7: freq = CLOCK / (16 * period)
  function fme7Period(freq) {
    let p = Math.round(CPU_CLOCK_NTSC / (16 * freq));
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
            errors.push({ message: 'ループ終端 "]" が見つかりません' });
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
          errors.push({ message: 'タプレット終端 "}" が見つかりません' });
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
  function buildSegments(tokens, initialTempo, errors, settings) {
    const cfg = settings || { octaveRev: 0, gateDenom: 8 };
    const state = {
      octave: 4, defaultLength: 4, volume: 15, gate: 8, instrument: 0,
      envelopeV: null, envelopeVr: 255, transpose: 0, detune: 0, qFrames: null,
      vibrato: null, pitchEnv: null, noteEnv: null, sweepSpeed: 0, sweepDepth: 0,
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
        case 'pitchEnv': state.pitchEnv = tok.value; break;
        case 'noteEnv': state.noteEnv = tok.value; break;
        case 'sweep': state.sweepSpeed = tok.speed; state.sweepDepth = tok.depth; break;
        case 'fme7Noise': state.fme7Noise = tok.value; break;
        case 'fme7EnvShape': state.fme7EnvShape = tok.value; break;
        case 'fme7EnvPeriod': state.fme7EnvPeriod = tok.value; break;
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

    return { segments, immediateWrites };
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

  // ソフトウェアビブラート(MP)の三角波オフセット(半音単位、近似実装)。
  // ppmckドライバのlfo_subは delay 経過後、lfo_reverse_time(=speed)ごとに方向反転しながら
  // depthぶんの増減を繰り返す三角波だが、内部の除算ルーチン(warizan)の詳細は本実装では
  // 追い切れていないため、「delay後、四半周期=speedフレームでdepthに到達する対称三角波」
  // という単純化した近似で実装している(depth/128を半音相当として換算)。
  function vibratoValue(mp, tick) {
    if (!mp || tick < mp.delay) return 0;
    const t = tick - mp.delay;
    const quarter = Math.max(1, mp.speed);
    const period = quarter * 4;
    const phase = t % period;
    const depth = mp.depth / 128;
    let ratio;
    if (phase < quarter) ratio = phase / quarter;
    else if (phase < quarter * 2) ratio = 1 - (phase - quarter) / quarter;
    else if (phase < quarter * 3) ratio = -(phase - quarter * 2) / quarter;
    else ratio = -1 + (phase - quarter * 3) / quarter;
    return ratio * depth;
  }

  // スイープ(s<speed>,<depth>)の半音オフセット(近似実装)。
  // ppmckドライバ側に対応するsweepルーチンの実体が見つからなかったため、
  // 「speed*4フレームかけてdepth(符号付き半音)まで線形に到達し、以降は保持する」
  // という単純な近似で実装している。
  function sweepValue(speed, depth, tick) {
    if (!depth) return 0;
    const frames = Math.max(1, speed) * 4;
    if (tick >= frames) return depth;
    return depth * (tick / frames);
  }

  // セグメントに音程変調(EN/EP/MP/sweep)が何か効いているかどうか
  function hasPitchModulation(seg) {
    return (seg.noteEnv != null && seg.noteEnv !== 255) ||
      (seg.pitchEnv != null && seg.pitchEnv !== 255) ||
      (seg.vibrato != null && seg.vibrato !== 255) ||
      !!seg.sweepDepth;
  }

  // 指定フレーム(セグメント内の経過フレームtick)時点の半音オフセット合計を返す。
  // EN(累積・整数半音)は仕様通り厳密実装、EP/MP/sweepは実機ドライバの内部係数まで
  // 追い切れていないため近似実装(compiler.js冒頭コメント参照)。
  function pitchOffsetSemitones(seg, envelopes, tick) {
    let offset = 0;
    if (seg.noteEnv != null && seg.noteEnv !== 255) {
      const table = envelopes.en[seg.noteEnv];
      if (table) offset += cumulativeEnvelopeValue(table, tick);
    }
    if (seg.pitchEnv != null && seg.pitchEnv !== 255) {
      const table = envelopes.ep[seg.pitchEnv];
      if (table) offset += stepEnvelope(table, tick) / 128;
    }
    if (seg.vibrato != null && seg.vibrato !== 255) {
      offset += vibratoValue(envelopes.mp[seg.vibrato], tick);
    }
    if (seg.sweepDepth) {
      offset += sweepValue(seg.sweepSpeed, seg.sweepDepth, tick);
    }
    return offset;
  }

  // 音程変調ありのセグメントについて、フレームごとに周波数レジスタを再計算し、
  // 前フレームと値が変わったときだけ書き込む(無変調時の1回書きより負荷は高いが、
  // 総フレーム数は曲の長さ相当なので実用上問題にならない)
  function writePitchModulation(writeLog, base, startFrame, dur, seg, envelopes, periodFn) {
    let lastLo = -1, lastHi = -1;
    for (let t = 0; t < dur; t++) {
      const offset = pitchOffsetSemitones(seg, envelopes, t);
      const freq = offset === 0 ? seg.freq : noteFrequency(seg.noteNumber + offset);
      const period = applyDetune(periodFn(freq), seg.detune, 0x7FF);
      const lo = period & 0xFF;
      const hi = (period >> 8) & 0x07;
      if (lo !== lastLo || hi !== lastHi) {
        writeLog[startFrame + t].push({ addr: base + 2, value: lo });
        writeLog[startFrame + t].push({ addr: base + 3, value: hi });
        lastLo = lo; lastHi = hi;
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
    // 実機ドライバもnegateビットだけ立てて回避する定石($4001=$08)を踏襲し、
    // スイープを実際には作動させない(enable=0,shift=0)まま誤ミュートだけ防ぐ。
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
          if (hasPitchModulation(seg)) {
            writePitchModulation(writeLog, base, startFrame, dur, seg, env, pulsePeriod);
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
            writePitchModulation(writeLog, base, startFrame, dur, seg, env, trianglePeriod);
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
          // ノイズは4bitインデックスのみのため、対応する音程変調はEN(ノートエンベロープ)に限定する
          if (seg.noteEnv != null && seg.noteEnv !== 255) {
            const table = env.en[seg.noteEnv];
            let lastIdx = -1;
            for (let t = 0; t < dur; t++) {
              const delta = table ? cumulativeEnvelopeValue(table, t) : 0;
              const idx = noisePeriodIndex(Math.round(seg.noteNumber + delta));
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
          const period = applyDetune(pulsePeriod(seg.freq), seg.detune, 0xFFF);
          writeLog[startFrame].push({ addr: base + 1, value: period & 0xFF });
          writeLog[startFrame].push({ addr: base + 2, value: 0x80 | ((period >> 8) & 0x0F) });
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
          const period = applyDetune(sawPeriod(seg.freq), seg.detune, 0xFFF);
          writeLog[startFrame].push({ addr: 0xB001, value: period & 0xFF });
          writeLog[startFrame].push({ addr: 0xB002, value: 0x80 | ((period >> 8) & 0x0F) });
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
        const period = applyDetune(pulsePeriod(seg.freq), seg.detune, 0x7FF);
        writeLog[startFrame].push({ addr: base + 2, value: period & 0xFF });
        writeLog[startFrame].push({ addr: base + 3, value: (period >> 8) & 0x07 });
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
      if (seg.freq != null) {
        const period = applyDetune(fme7Period(seg.freq), seg.detune, 0xFFF);
        writeLog[startFrame].push({ addr: 0xC000, value: periodRegLo });
        writeLog[startFrame].push({ addr: 0xE000, value: period & 0xFF });
        writeLog[startFrame].push({ addr: 0xC000, value: periodRegHi });
        writeLog[startFrame].push({ addr: 0xE000, value: (period >> 8) & 0x0F });
        // R6: ノイズ周期(3chで共有の1レジスタ。実機PSGも同様の制約)
        if (seg.fme7Noise != null) {
          writeLog[startFrame].push({ addr: 0xC000, value: 6 });
          writeLog[startFrame].push({ addr: 0xE000, value: seg.fme7Noise & 0x1F });
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

  // R7(ミキサー): bit0-2=トーン有効(0で有効,既定で全ch有効), bit3-5=ノイズ有効(0で有効)。
  // ノイズは3ch共有の1レジスタ(R6)なので、曲全体でN<n>を使うchだけをbit3-5で有効化する
  // (曲中の動的な有効/無効切り替えは他chとの競合リスクがあるため未対応、初期化時に固定)
  function fme7InitWrites(noiseChannels) {
    let mixer = 0x38;
    for (const idx of (noiseChannels || [])) mixer &= ~(1 << (3 + idx));
    return [{ addr: 0xC000, value: 7 }, { addr: 0xE000, value: mixer }];
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
        const period = applyDetune(fdsFreqToPeriod(seg.freq), seg.detune, 0xFFF);
        writeLog[startFrame].push({ addr: 0x4082, value: period & 0xFF });
        writeLog[startFrame].push({ addr: 0x4083, value: (period >> 8) & 0x0F });
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

  // 波形長レジスタ(+4のbit2-7)の値。length = 256-(値&0xFC) なので N=16 → 0xF0。
  function n163LengthByte() {
    return (256 - N163_WAVE_LEN) & 0xFC;
  }

  // 実機の$4800書き込みはRAMへの「1バイト」書き込みで、波形読み出し側(+6=波形アドレス、
  // N163Audio._sample/resampleWave参照)は「1ニブル=4bitサンプル」単位でその領域を読む。
  // つまり書き込み側も2サンプルを1バイトに詰めて書く必要がある(以前は0-15の値をそのまま
  // 1バイト=1サンプルとして書いていたため、読み出し側は毎回上位ニブル=0を挟んで読んでしまい
  // 波形が[0,0,2,0,4,0,...]のように歯抜けに壊れていた)。
  function n163PackWaveBytes(wave) {
    const bytes = [];
    for (let i = 0; i < N163_WAVE_LEN; i += 2) {
      bytes.push((wave[i] & 0x0F) | ((wave[i + 1] & 0x0F) << 4));
    }
    return bytes;
  }

  // 各chが専用に使う波形スロットのバイトオフセット。N163_WAVE_LEN(16)サンプル=8byte/ch、
  // 8ch分でも 8*8=64byte で ちょうどレジスタ領域($40-$7F)の手前(0-63)に収まる。
  // 以前は全ch共有(waveBase=0固定)だったため、あるchが別の音色(@N<n>)へ切り替えて再ロード
  // すると、まだ同じ音色のまま鳴り続けている他chの波形まで巻き添えで書き換わってしまい、
  // 曲中に複数のN163波形を同時使用する曲(例: Megami Tensei II)で音色が別chの物にすり替わる
  // 不具合があった。chごとに独立領域を持たせることで解消する。
  function n163WaveByteOffset(internalIdx) {
    return internalIdx * (N163_WAVE_LEN / 2);
  }

  function n163InitWrites(customWave, numN163Ch) {
    const writes = [];
    const wave = (customWave && customWave.length === N163_WAVE_LEN) ? customWave : n163DefaultWave();
    const packed = n163PackWaveBytes(wave);
    const num = Math.max(1, Math.min(N163_CHANNEL_COUNT, numN163Ch || N163_CHANNEL_COUNT));

    // 実機は内部8ch中「上位 num 個」だけを巡回・ミックスするため、各chの内部インデックスは
    // (8-num)+i。各chの専用波形スロットに既定波形を書き、波形長(+4)・波形アドレス(+6、
    // ニブル単位=バイトオフセット*2)を初期化する(位相 +1/+3/+5 は触らない)。
    for (let i = 0; i < num; i++) {
      const internalIdx = (N163_CHANNEL_COUNT - num) + i;
      const regBase = 0x40 + internalIdx * 8;
      const byteOffset = n163WaveByteOffset(internalIdx);
      writes.push({ addr: 0xF800, value: byteOffset | 0x80 });
      for (const b of packed) writes.push({ addr: 0x4800, value: b });
      writes.push({ addr: 0xF800, value: (regBase + 4) | 0x80 });
      writes.push({ addr: 0x4800, value: n163LengthByte() });
      writes.push({ addr: 0xF800, value: (regBase + 6) | 0x80 });
      writes.push({ addr: 0x4800, value: byteOffset * 2 });
    }
    // $7F(内部アドレス、ゼロページではなくポート経由)に有効ch数を設定する。
    writes.push({ addr: 0xF800, value: 0x7F | 0x80 });
    writes.push({ addr: 0x4800, value: (num - 1) << 4 });
    return writes;
  }

  // @<n>(instrument)で @N<n> 波形を選択する。選択している番号が前の音符から変わったときだけ
  // このchの専用スロット(byteOffset)へ8byteの波形を書き直す(波形アドレス+6は初期化済みで
  // 不変のため書き直さない)
  function n163WaveLoadWrites(wave, byteOffset) {
    if (!wave) return [];
    const packed = n163PackWaveBytes(wave);
    const writes = [{ addr: 0xF800, value: byteOffset | 0x80 }];
    for (const b of packed) writes.push({ addr: 0x4800, value: b });
    return writes;
  }

  function segmentsToWriteLogN163(index, segments, totalFrames, envelopes, numN163Ch) {
    const writeLog = newWriteLog(totalFrames);
    // 実機は内部8ch中「上位 num 個」だけを巡回・ミックスする。letters[index] の内部インデックスは
    // (8-num)+index(下位アドレス側から)。0番から詰めると鳴らないため必ずオフセットする。
    const num = Math.max(1, Math.min(N163_CHANNEL_COUNT, numN163Ch || N163_CHANNEL_COUNT));
    const internalIdx = (N163_CHANNEL_COUNT - num) + index;
    const regBase = 0x40 + internalIdx * 8;
    const waveByteOffset = n163WaveByteOffset(internalIdx);
    const nMap = (envelopes && envelopes.n) || {};
    const env = envelopes || { v: {}, vr: {} };
    let lastInstrument = null;
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
          writeLog[startFrame].push(...n163WaveLoadWrites(normalizeN163Wave(nMap[seg.instrument]), waveByteOffset));
          lastInstrument = seg.instrument;
        }
        const freqReg = applyDetune(n163FreqReg(seg.freq, N163_WAVE_LEN, num), seg.detune, 262143);
        // 周波数は実機のインターリーブ配置に従い +0/+2/+4 へ書く(間の位相バイト +1/+3 は
        // 触らない)。オートインクリメントに頼らずアドレスを都度選択する。波形長は +4 の上位に共用。
        writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 0) });
        writeLog[startFrame].push({ addr: 0x4800, value: freqReg & 0xFF });
        writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 2) });
        writeLog[startFrame].push({ addr: 0x4800, value: (freqReg >> 8) & 0xFF });
        writeLog[startFrame].push({ addr: 0xF800, value: (regBase + 4) });
        writeLog[startFrame].push({ addr: 0x4800, value: n163LengthByte() | ((freqReg >> 16) & 0x03) });
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
  function segmentsToWriteLogVrc7(index, segments, totalFrames) {
    const writeLog = newWriteLog(totalFrames);
    const ch = index;

    let frame = 0;
    for (const seg of segments) {
      if (frame >= totalFrames) break;
      const startFrame = frame;
      const dur = Math.min(seg.durationFrames, totalFrames - frame);
      const gateFrames = computeGateFrames(seg, dur);
      if (seg.freq != null) {
        const { fnum, block } = vrc7FreqToFnumBlock(seg.freq);
        const instrument = seg.instrument % 16;
        writeLog[startFrame].push({ addr: 0x9010, value: 0x10 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: fnum & 0xFF });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x20 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: 0x10 | (block << 1) | ((fnum >> 8) & 1) });
        writeLog[startFrame].push({ addr: 0x9010, value: 0x30 + ch });
        writeLog[startFrame].push({ addr: 0x9030, value: (instrument << 4) | seg.volume });
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

  // @N<n>の波形値をN163_WAVE_LEN(16)固定に正規化する(不足はゼロ埋め、超過は切り詰め)
  function normalizeN163Wave(values) {
    if (!values || values.length === 0) return null;
    const wave = values.slice(0, N163_WAVE_LEN);
    while (wave.length < N163_WAVE_LEN) wave.push(0);
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
        bytes: def.bytes
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

  function buildExpansionWriteLog(expansion, index, segments, totalFrames, envelopes, dpcmLayout, dpcmSamples, extra) {
    switch (expansion) {
      case 'vrc6': return segmentsToWriteLogVrc6(index, segments, totalFrames, envelopes);
      case 'mmc5': return segmentsToWriteLogMmc5(index, segments, totalFrames, envelopes);
      case 'fme7': return segmentsToWriteLogFme7(index, segments, totalFrames, envelopes);
      case 'fds': return segmentsToWriteLogFds(segments, totalFrames, envelopes);
      case 'n163': return segmentsToWriteLogN163(index, segments, totalFrames, envelopes, extra && extra.numN163Ch);
      case 'vrc7': return segmentsToWriteLogVrc7(index, segments, totalFrames);
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
      case 'fme7': return fme7InitWrites(extra && extra.noiseChannels);
      case 'fds': return fdsInitWrites(opt && opt.fdsWave);
      case 'n163': return n163InitWrites(opt && opt.n163Wave, extra && extra.numN163Ch);
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
    let totalFrames = 0;

    for (const ch of channelLetters) {
      const raw = channels[ch] || { text: '', offsets: [] };
      let tokens = Mml.tokenize(raw.text, raw.offsets);
      tokens = expandLoops(tokens, errors);
      tokens = applyTuplets(tokens, tempo, errors);
      const { segments, immediateWrites } = buildSegments(tokens, tempo, errors, settings);
      segmentsByChannel[ch] = segments;
      immediateWritesByChannel[ch] = immediateWrites;
      const sum = segments.reduce((a, s) => a + s.durationFrames, 0);
      totalFrames = Math.max(totalFrames, sum);
    }

    totalFrames = Math.max(1, totalFrames);

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
        extra = { numN163Ch: Math.max(1, numN163Ch) };
      }
      letters.forEach((ch, index) => {
        tracks[ch] = buildExpansionWriteLog(exp, index, segmentsByChannel[ch], totalFrames, envelopes, dpcmLayout, dpcmSamples, extra);
        // OP<n>(VRC7音色)/MH<n>(FDS変調)による曲中の動的切り替えをこのchへ差し込む
        if (exp === 'vrc7') {
          spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'vrc7Tone', totalFrames,
            iw => resolveVrc7ToneWrite(iw, envelopes));
        } else if (exp === 'fds') {
          spliceImmediateWrites(tracks[ch], immediateWritesByChannel[ch], 'fdsMod', totalFrames,
            iw => resolveFdsModWrite(iw, envelopes));
        }
      });
      // 拡張音源の初期化書き込みをそのチップの先頭チャンネルのフレーム0に挿入
      if (exp === 'fme7') {
        extra = {
          noiseChannels: letters
            .map((ch, index) => (segmentsByChannel[ch].some(s => s.fme7Noise != null) ? index : -1))
            .filter(i => i >= 0)
        };
      }
      const initWrites = expansionInitWrites(exp, opt, envelopes, extra);
      if (initWrites.length > 0 && letters.length > 0) {
        tracks[letters[0]][0] = [...initWrites, ...tracks[letters[0]][0]];
      }
    }

    return {
      tracks,
      totalFrames,
      tempo,
      expansions,
      expansionLetterMap,
      channelLetters,
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
