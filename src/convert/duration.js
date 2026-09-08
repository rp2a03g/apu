/*
 * フォーマット非依存 音長量子化 (MIDI標準分解能 480 TPQN)
 * MML.Convert.framesToLengths(frames, fpb, carryIn) → { lengths: ['4','8.',...], carryOut }
 *
 * fpb = 1拍(4分音符)あたりのフレーム数。呼び出し側が実効fpsと検出/指定bpmから
 * 算出して渡す。
 *
 * 内部の量子化はフレーム値を直接使わず、MIDI規格の標準分解能である
 * TPQN=480 (4分音符=480tick、全音符=1920tick) のtickドメインへ変換してから行う。
 *  - 音価テーブルが全て整数tickになり(4分=480, 8分=240, 3連16分=80, 192分=10)、
 *    浮動小数のフレーム値テーブル(fpb*4/div)同士を±0.4フレームの恣意的な
 *    許容誤差で突き合わせていた旧実装の丸め挙動がテンポ非依存の厳密な
 *    整数演算になる。
 *  - 生成される全ての音符/休符の境界はMIDIの480TPQNグリッド上に正確に乗るため、
 *    将来のMIDI入出力(ROADMAPフェーズ3)やピアノロールとそのまま時間軸を共有できる。
 *  - マッチ許容誤差は「最小音価(192分=10tick)の半分」=5tick(4分音符の1/96)と
 *    音楽的な単位で定義される(旧0.4フレームはテンポとフレームレート次第で
 *    意味が変わっていた)。
 *
 * carryIn/carryOut: ノートを1つずつ独立に丸めると端数が毎回切り捨てられ、
 * 同じ方向の丸め誤差が連打パートで蓄積して発音位置が実際のタイミングから
 * どんどんズレていく(Bresenham型の誤差拡散をしない単純丸めの既知の欠点)。
 * 呼び出し側でチャンネル内の直前ノートの余り誤差を carryIn として次のノートに
 * 足し込み、carryOut を次の呼び出しに引き継ぐことで誤差を蓄積させない。
 * carryの単位はtick(この関数の内部単位)であり、呼び出し側は初期値0で渡して
 * 返り値をそのまま次に渡すだけでよい(単位を解釈してはならない)。
 *
 * DIVISIONS: 生成する音価の分母を、編集しやすい標準的な値(2進系+3連符系)に
 * 限定する。r140/r256のような任意の分母は一切生成しない。テーブルに収まらない
 * 極端に短い音価は最小分解能(192分)に丸め、その誤差はcarryOutとして次の音符に
 * 持ち越して吸収する(その場の1音は多少ズレても曲全体では帳尻が合う)。
 * 複付点(×1.75)はtickが整数になるものだけ採用する(64..=52.5tick等は
 * 480TPQNグリッドに乗らないため除外。単付点×1.5は全音価で整数)。
 */
(function (global) {
  'use strict';
  const MML     = global.MML     = global.MML     || {};
  MML.Convert   = MML.Convert   || {};

  const TPQN  = 480;        // MIDI標準分解能 (tick/4分音符)
  const WHOLE = TPQN * 4;   // 全音符 = 1920 tick
  MML.Convert.TPQN = TPQN;  // 将来のMIDI入出力/ピアノロールと共有するための公開定数

  const DIVISIONS = [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 192];

  // 音価テーブル(整数tick)はfpbに依存しないためモジュールロード時に1回だけ構築
  const TABLE = [];
  for (const div of DIVISIONS) {
    const base = WHOLE / div;
    TABLE.push([base, String(div)]);
    TABLE.push([base * 1.5, `${div}.`]);
    if (Number.isInteger(base * 1.75)) TABLE.push([base * 1.75, `${div}..`]);
  }
  TABLE.sort((a, b) => b[0] - a[0]); // 降順(最小分解能=192分=10tickが末尾)

  const QUANTUM = TABLE[TABLE.length - 1][0]; // 10 tick (192分音符)
  const SLACK   = QUANTUM / 2;                // マッチ許容誤差 = 5 tick

  // slackFrames(2026-09-08、変換設定 LEN_SNAP「音長を丸める」): 音符の境界が元曲からこのフレーム数まで
  // ずれてよい(0/省略なら 192 分の半分=5tick の厳密量子化)。ドライバのテンポが小数(ppmck t71 は 4分=
  // 50.8 フレーム)だと音符長が格子から ±1〜2 フレームずれ続け、全音符が 4&2&8..&64.&192 のような
  // タイの列になる。
  //   ・境界のずれ = carry(元曲の位置 − 書いた位置)。carryOut は ±tol に収める(超過分は捨てる)
  //   ・音価の一致は rem + 2·tol まで許す: 持ち越しが逆向きに最大 tol 溜まっていても、音符自身のずれが
  //     tol 以内なら必ず 1 個の音価に乗るように(tol だけだと Wing Defenders の 16 分×8 連続で +0.3
  //     フレームずつ溜まった carry が次の 4 分音符を 8..&64. に割っていた)
  //   ・余り(rem)は tol 以下になったら止める(tol〜2tol の余りは小さな音価で埋めてから carry へ)
  MML.Convert.framesToLengths = function (frames, fpb, carryIn, slackFrames) {
    carryIn = carryIn || 0;
    const ticksPerFrame = TPQN / fpb;
    const target = frames * ticksPerFrame + carryIn;
    const tol = Math.max(SLACK, (slackFrames || 0) * ticksPerFrame);
    const slack = slackFrames > 0 ? tol * 2 : tol;

    const result = [];
    let rem = target;
    while (rem > tol) {
      let best = null;
      if (slackFrames > 0) {
        // 丸めモード: 許容内(t ≤ rem+2tol)の音価のうち rem に最も近いもの(降順表なので最初に見つかる
        // 大きい方を無条件に取ると、16分(120tick)の音符が 24..(140tick)に化ける)
        for (const [t, name] of TABLE) {
          if (t > rem + slack) continue;
          if (!best || Math.abs(t - rem) < Math.abs(best[0] - rem)) best = [t, name];
          if (t < rem) break; // これより小さい音価は遠ざかるだけ
        }
      } else {
        for (const [t, name] of TABLE) {
          if (t <= rem + slack) { best = [t, name]; break; }
        }
      }
      if (!best) break;
      result.push(best[1]);
      rem -= best[0];
    }

    let consumed;
    if (result.length > 0) {
      consumed = target - rem;
    } else {
      // targetがテーブル最小音価(最終手段として192分音符)未満だった場合。
      // 非標準の分母を発明せず、必ずDIVISIONS内の最小音価を使う。
      result.push(TABLE[TABLE.length - 1][1]);
      consumed = QUANTUM;
    }

    const carryOut = target - consumed;
    return { lengths: result, carryOut: slackFrames > 0 ? Math.max(-tol, Math.min(tol, carryOut)) : carryOut };
  };

  // events(隙間補完済み、note=null休符含む)を通しでframesToLengths相当の量子化を行い、
  // 生成される音価(付点は無視し数値部分のみ)のうち最も出現回数が多いものを返す。
  // l<n>(デフォルト音長)をチャンネル先頭で宣言し、以後その値と一致する音符/休符は
  // 数値部分を省略してMMLを見やすくするための下調べに使う(呼び出し側の
  // src/convert/mmlEmit.js参照)。該当データが無ければMML既定値の4を返す。
  MML.Convert.detectDefaultLength = function (events, fpb, slackFrames) {
    const counts = new Map();
    let carry = 0;
    const sorted = (events || []).slice().sort((a, b) => a.start - b.start);
    for (const ev of sorted) {
      const dur = ev.end - ev.start;
      if (dur <= 0) continue;
      const { lengths, carryOut } = MML.Convert.framesToLengths(dur, fpb, carry, slackFrames);
      carry = carryOut;
      for (const l of lengths) {
        const m = /^(\d+)/.exec(l);
        if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      }
    }
    let best = null, bestCount = -1;
    for (const [num, cnt] of counts) {
      if (cnt > bestCount) { bestCount = cnt; best = num; }
    }
    return best ? parseInt(best, 10) : 4;
  };

})(window);
