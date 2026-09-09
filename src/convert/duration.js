/*
 * フォーマット非依存 音長量子化 (MIDI標準分解能 480 TPQN)
 * MML.Convert.framesToLengths(frames, fpb, carryIn, slackFrames) → { lengths: ['4','8.',...], carryOut }
 * MML.Convert.quantizeSeq(durs, fpb, slackFrames) → lengths[][] (チャンネル全体の最適化、2026-09-09)
 * MML.Convert.detectDefaultLength(events, fpb, slackFrames, plan) → l<n> の n
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
 * 3連2分(3)と3連4分(6)は付点なしのみ(2026-09-09): 無いと 3連4分が `12..` と `8.` の交互
 * (平均は合うが1音ずつ±2フレームずれる)、3連2分が `4&12` のタイに化けていた。付点つき
 * (`3..`=1120tick 等)を許すと、2進の音符が持ち越し込みで `3..&24` のように食われる
 * (After Burner で28箇所)ので入れない。
 *
 * quantizeSeq(2026-09-09、変換設定 LEN_DP「音長をチャンネル全体で最適化」): framesToLengths を
 * 音符ごとに順に呼ぶ greedy は、直前の音符の余り(carry)だけを見て「今の音符に最も近い音価」を
 * 選ぶので、速いテンポで16分音符が 5,5,5,6 フレームと揺れると 6 の音符が `24..`(140tick)に
 * なり、3連8分の隣で持ち越しが逆向きに溜まると `16.` に化ける。quantizeSeq はチャンネルの
 * 全イベント列を見渡し、「トークンの書きにくさ + 各境界の位置ずれ(フレーム)の二乗」の合計が
 * 最小になる音価の割り当てを動的計画法で選ぶ(状態=書いた累積tick、遷移=1〜3トークンの和)。
 * 合成曲の往復テスト(tools/headless/tempo-bench.js)で正しいテンポのときの音長一致 91%→97%。
 * 境界の位置ずれは常に slackFrames 以内に収める(greedy は carry の超過分を捨てるので、曲が
 * 進むと黙ってずれていく)。その厳密さの代償として、格子に乗らない音符が多い実曲では
 * greedy より 3連系やタイが少し増える(忠実さ優先。プレーン譜面プリセットでは OFF)。
 */
(function (global) {
  'use strict';
  const MML     = global.MML     = global.MML     || {};
  MML.Convert   = MML.Convert   || {};

  const TPQN  = 480;        // MIDI標準分解能 (tick/4分音符)
  const WHOLE = TPQN * 4;   // 全音符 = 1920 tick
  MML.Convert.TPQN = TPQN;  // 将来のMIDI入出力/ピアノロールと共有するための公開定数

  const DIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 192];
  const NO_DOT_DIVISIONS = new Set([3, 6]); // 冒頭コメント参照
  const TRIPLET_DIVISIONS = new Set([3, 6, 12, 24, 48, 96]);

  // 音価テーブル(整数tick)はfpbに依存しないためモジュールロード時に1回だけ構築
  const TABLE = [];
  for (const div of DIVISIONS) {
    const base = WHOLE / div;
    TABLE.push([base, String(div)]);
    if (NO_DOT_DIVISIONS.has(div)) continue;
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

  // ── チャンネル全体の音長最適化(DP、冒頭コメント quantizeSeq) ─────────────────────
  // トークン1個の「書きにくさ」: 素の音価 1、付点 +0.5/個、3連系 +0.15、64分以下 +1、192分 +1
  function tokenCost(name) {
    const m = /^(\d+)(\.*)$/.exec(name);
    const den = parseInt(m[1], 10), dots = m[2].length;
    let c = 1 + 0.5 * dots;
    if (TRIPLET_DIVISIONS.has(den)) c += 0.15;
    if (den >= 64) c += 1.0;
    if (den >= 192) c += 1.0;
    return c;
  }
  const TOKEN_COST = new Map(TABLE.map(([, n]) => [n, tokenCost(n)]));
  MML.Convert.lengthTokenCost = (name) => TOKEN_COST.has(name) ? TOKEN_COST.get(name) : 3;

  // 1〜3トークンの和 → 最小コストのトークン列(タイは1個につき +0.2)。fpb に依存しないので1回だけ構築
  const SUMS = new Map();
  function putSum(s, c, toks) { const e = SUMS.get(s); if (!e || c < e.c) SUMS.set(s, { c, toks }); }
  for (let i = 0; i < TABLE.length; i++) {
    const [t1, n1] = TABLE[i];
    putSum(t1, TOKEN_COST.get(n1), [n1]);
    for (let j = i; j < TABLE.length; j++) {
      const [t2, n2] = TABLE[j];
      putSum(t1 + t2, TOKEN_COST.get(n1) + TOKEN_COST.get(n2) + 0.2, [n1, n2]);
      for (let k = j; k < TABLE.length; k++) {
        const [t3, n3] = TABLE[k];
        putSum(t1 + t2 + t3, TOKEN_COST.get(n1) + TOKEN_COST.get(n2) + TOKEN_COST.get(n3) + 0.4, [n1, n2, n3]);
      }
    }
  }
  const SUM_KEYS = [...SUMS.keys()].sort((a, b) => a - b);
  function lowerBound(v) {
    let lo = 0, hi = SUM_KEYS.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (SUM_KEYS[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  // durs: イベント列の長さ(フレーム)。戻り値は各イベントの音価トークン列(framesToLengths の lengths と同型)。
  // 誤差コスト = ERR_COST × (境界のずれフレーム)²、境界のずれは ±tol(slackFrames、最低1フレーム)以内に制限。
  // 状態数は各段 MAX_STATES に刈り込む(実測: 状態は多くても数十)
  // exactMask(任意、2026-09-09): true のイベント(分割したDPCM=ストリーム再生の区間、src/convert/drumHits.js)
  //   とその直前のイベントは、境界の「位置」を ±5tick(192分の半分=0.3フレーム未満)に拘束する。
  //   区間の頭は元曲でフレーム整数なので、位置がそこまで近ければコンパイラの累積丸めで必ず元の
  //   フレームにトリガーが乗り、区間の音の長さ(=固定)と次のトリガーの間隔が一致して継ぎ目が消える。
  //   ★「長さ」で拘束してはいけない: 32フレーム=238.9tick に対して安い `8`(240tick)を選び続けると
  //     1.1tick/区間ずつ位置が流れ、5区間で0.7フレーム→1フレーム遅れる(Truxton II で実測)
  const ERR_COST = 0.5, MAX_STATES = 64;
  MML.Convert.quantizeSeq = function (durs, fpb, slackFrames, exactMask) {
    const tpf = TPQN / fpb;
    const tol = Math.max(SLACK, Math.max(1, slackFrames || 0) * tpf);
    const n = durs.length;
    const P = new Array(n + 1); // 元曲の累積位置(tick)
    P[0] = 0;
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + Math.max(0, durs[i]) * tpf;

    let states = new Map([[0, { cost: 0, prev: null, toks: null }]]); // 書いた累積tick → 最小コスト
    const hist = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!(durs[i] > 0)) { hist[i] = null; continue; }
      const next = new Map();
      // 厳密な境界 = exact なイベントの終端と、その直前のイベントの終端(チェーンの頭)
      const strict = !!(exactMask && (exactMask[i] || exactMask[i + 1]));
      const posTol = strict ? SLACK : tol;
      const lo = P[i + 1] - posTol, hi = P[i + 1] + posTol;
      for (const [w, st] of states) {
        let found = false;
        for (let k = lowerBound(lo - w); k < SUM_KEYS.length && w + SUM_KEYS[k] <= hi; k++) {
          const S = SUM_KEYS[k], e = SUMS.get(S);
          const ef = (w + S - P[i + 1]) / tpf;
          const c = st.cost + e.c + ERR_COST * ef * ef;
          const cur = next.get(w + S);
          if (!cur || c < cur.cost) next.set(w + S, { cost: c, prev: w, toks: e.toks });
          found = true;
        }
        if (!found) {
          // 窓内に和が無い(192分未満の極端に短いイベント等): 最も近い和で強行し、重いペナルティ
          const r = Math.max(QUANTUM, P[i + 1] - w);
          let k = Math.min(SUM_KEYS.length - 1, lowerBound(r));
          if (k > 0 && Math.abs(SUM_KEYS[k - 1] - r) < Math.abs(SUM_KEYS[k] - r)) k--;
          const S = SUM_KEYS[k], e = SUMS.get(S);
          const c = st.cost + e.c + 3;
          const cur = next.get(w + S);
          if (!cur || c < cur.cost) next.set(w + S, { cost: c, prev: w, toks: e.toks });
        }
      }
      if (next.size > MAX_STATES) {
        states = new Map([...next].sort((a, b) => a[1].cost - b[1].cost).slice(0, MAX_STATES));
      } else states = next;
      hist[i] = states;
    }

    let bestKey = null, bestCost = Infinity;
    for (const [w, st] of states) if (st.cost < bestCost) { bestCost = st.cost; bestKey = w; }
    const out = new Array(n);
    let w = bestKey;
    for (let i = n - 1; i >= 0; i--) {
      if (!hist[i]) { out[i] = [TABLE[TABLE.length - 1][1]]; continue; }
      const st = hist[i].get(w);
      out[i] = st.toks.slice();
      w = st.prev;
    }
    return out;
  };

  // events(隙間補完済み、note=null休符含む)を通しでframesToLengths相当の量子化を行い、
  // 生成される音価(付点は無視し数値部分のみ)のうち最も出現回数が多いものを返す。
  // l<n>(デフォルト音長)をチャンネル先頭で宣言し、以後その値と一致する音符/休符は
  // 数値部分を省略してMMLを見やすくするための下調べに使う(呼び出し側の
  // src/convert/mmlEmit.js参照)。該当データが無ければMML既定値の4を返す。
  // plan(任意): quantizeSeq の結果(イベント → lengths の Map)。あればそれを数える
  MML.Convert.detectDefaultLength = function (events, fpb, slackFrames, plan) {
    const counts = new Map();
    let carry = 0;
    const sorted = (events || []).slice().sort((a, b) => a.start - b.start);
    for (const ev of sorted) {
      const dur = ev.end - ev.start;
      if (dur <= 0) continue;
      let lengths;
      if (plan && plan.has(ev)) lengths = plan.get(ev);
      else {
        const q = MML.Convert.framesToLengths(dur, fpb, carry, slackFrames);
        carry = q.carryOut;
        lengths = q.lengths;
      }
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
