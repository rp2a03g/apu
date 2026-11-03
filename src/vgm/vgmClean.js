/*
 * VGM の録音補正(ゲームプレイ録音向け。変換設定 SFX_REMOVE / LAG_FIX、既定はどちらも OFF)
 *
 *   MML.VGM.cleanCapture(bytes, { sfx, lag }) → { bytes, report }
 *   MML.VGM.describeClean(report)             → MML ヘッダコメントに書く説明文の配列
 *
 * ゲームを遊びながら録った VGM(tools/mesen/vgm-recorder.lua)は、曲のほかに効果音・ジングル・処理落ちが
 * そのまま入っている。それが録音の本体なので既定では何もしない(DESIGN-CAPTURE.md P-6)。
 * ここは「あとから選べる選択肢」として、VGM のバイト列をフレーム単位で組み直してから既存の
 * キャプチャ(vgmPlayer.js captureVgmSongAsync)→ 変換(vgm2mml)へ渡す。どのチップの書き込みも
 * VGM のコマンドとして同じに扱えるので、変換器(NES/GB/PCE/SN…)側には分岐が要らない。
 *
 * ── 周期と周回の対応付け(両方の補正が使う) ──
 *   1. フレームごとの書き込み列(データブロックを除く)の署名を取る。
 *   2. 周期の候補: 同じ署名を持つフレームの組の間隔をヒストグラムにし(±SFX_HIST_WIN で均す)、
 *      山の上位 SFX_CANDIDATES 個を候補にする。処理落ちで周回が 1〜2 フレームずれていても山は残る。
 *      ★既存のループ自動検出(mmlEmit.js detectLoop)は音符列で 0.3% の食い違いしか許さないので、
 *        効果音が混ざった録音では周期を出せない。ここは書き込み列の一致を見る。
 *   3. 各候補で周期性の始まり s(窓 SFX_START_WIN の一致率が SFX_START_RATE 以上になる最初の位置。
 *      ±SFX_START_SHIFT のずれは許す)を出し、1 周目 [s, s+T) と 2 周目を帯付き DP で対応付けた一致率で
 *      候補を採点する。最良の SFX_NEAR_BEST 倍以上のうち最短の T を周期にする(倍周期を避ける)。
 *   4. 2 周目以降は直前の周回の終わりから順に 1 周目へ対応付ける(帯 ±SFX_BAND フレーム)。
 *      DP のギャップ=その周回だけにある余分なフレーム(処理落ち)/その周回に無いフレーム。
 *
 * ── 効果音除去(SFX_REMOVE) ──
 *   同じ位相のフレームを周回で並べ、過半数が同じ署名ならそれを正とし、違う周回のフレームの書き込み列を
 *   正の列に置き換える(効果音で上書きされた音楽の書き込みも復元される)。周回が 2 つしか無いと
 *   「どちらにも無い」は分からないので、違うフレームはそのまま残る(3 周以上を推奨)。
 *   周期性が始まる前(イントロ)は多数決できないので手を付けない。
 *   データブロック(DPCM の 0xC2、NESX ヘッダ等)は置き換えの対象外でその場に残す(初回だけ出る
 *   サンプル本体が多数決で消えないように)。NESX の書き込み列ブロック(kind 1)は書き込みとして扱う。
 *
 * ── 処理落ち補正(LAG_FIX) ──
 *   a. 毎フレーム書くドライバ: 曲の間の LAG_EVERY_FRAME_RATE 以上のフレームに書き込みがあるドライバでは、
 *      書き込みが 1 つも無いフレームを処理落ちとして詰める(音楽ルーチンが走らなかったフレーム)。録音の先頭と
 *      末尾に接する区間、LAG_MAX_RUN フレームより長い区間(ポーズや曲の終わり)は詰めない。
 *      ★「ほぼ毎フレーム書かれるレジスタが無いフレーム」を処理落ちとみなす版は、休符の間だけそのレジスタを
 *        書かないドライバで曲の 1 割を消した(人工テストで 1956 フレーム)。書き込みが全く無いフレームに限る。
 *   b. 周回の対応付け: 変化したときだけ書くドライバでは a が効かないので、上の DP で「その周回だけに
 *      ある空フレーム」(ギャップ)を処理落ちとして詰める。1 周目の余分なフレームは他の周回の過半数で
 *      ギャップになっているもの。書き込みのあるフレームは詰めない。
 *   詰めたフレームにあった書き込み(効果音だけのフレーム等)は捨てずに次のフレームの頭へ移す。
 *
 * 出力は 1 フレーム=735 サンプルの格子に乗せ直す(録音スクリプトの VGM は元からこの格子)。
 * フレーム内の時刻(0x61 の端数)は各書き込みの相対位置として保つ。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const VGM = MML.VGM = MML.VGM || {};

  const SPF = 735; // 1 フレームのサンプル数(44100/60)
  const LAG_EVERY_FRAME_RATE = 0.98; // 曲の間のフレームのうち書き込みがある割合がこれ以上なら「毎フレーム書くドライバ」
  const LAG_MIN_FRAMES = 120;    // 判定に要る「書き込みのあるフレーム」の最小数
  const LAG_MAX_RUN = 60;        // これより長く続く無書き込み区間は処理落ちでなくポーズ/曲の終わり
  const SFX_MIN_PERIOD = 240;    // detectLoop の LOOP_MIN_PERIOD と同じ(4 秒未満の周期は見ない)
  const SFX_MAX_OCC = 64;        // これより多く現れる署名(無音の書き直し等)は周期の手がかりにしない
  const SFX_HIST_WIN = 8;        // ヒストグラムを均す幅(±フレーム。処理落ちによる周回のずれを吸収)
  const SFX_CANDIDATES = 4;      // 採点する周期候補の数(候補ごとに近傍 33 本の T で DP を回すので多くしない)
  const SFX_MIN_SCORE = 0.4;     // 周期として採る一致率の下限
  const SFX_NEAR_BEST = 0.05;    // 最良の一致率からこれ以内の候補を同格とみなす(曲の中で繰り返す 1 小節のような短い周期は、
                                 // 小節ごとの違いのぶん一致率が落ちるので外れる)
  const SFX_PREFER_LAPS = 3;     // 同格の候補のうち、これだけの周回が録音に入る最長の T を採る(A A' A'' のような周回内の
                                 // 変奏を多数決で消さないよう長い方を選び、多数決に要る 3 周が入らなければ短い方へ)
  const SFX_START_WIN = 120;     // 周期性の始まりを探す窓(フレーム)
  const SFX_START_RATE = 0.6;    // 窓の中の一致率がこれ以上なら周期性が始まっている
  const SFX_START_MIN_DECISIVE = 4; // 窓の中に一致/不一致を判定できるフレームがこれだけ無ければ見ない
  const SFX_START_SHIFT = 8;     // 始まりを探すときに許す周回のずれ(±フレーム)
  const SFX_BAND = 64;           // 周回の対応付け DP の帯(±フレーム。周回内で許す処理落ちの累計)
  // DP の得点: 署名が同じ(どちらも書き込みあり)/どちらも空/違う/ギャップ(空フレーム)/ギャップ(書き込みあり)
  const DP_EQ = 2, DP_BOTH_EMPTY = 1, DP_MIS = -1, DP_GAP_EMPTY = -1, DP_GAP_FULL = -4;
  // 多数決で決まらない(周回ごとに書き込みが少し揺れる曲で、効果音の周回と揺れの周回が同じ位相に重なる)とき:
  // 書き込みの組(レジスタ×値)の Jaccard 類似度で、他と最も似ているフレーム(メドイド)に SFX_OUTLIER 未満しか
  // 似ていないフレームを置き換える。メドイドは別の周回が SFX_CORROBORATE 以上似ていることを条件にする
  const SFX_OUTLIER = 0.5, SFX_CORROBORATE = 0.7;

  // ── VGM コマンドの種類(多数決で決まらないときの似ている度合いの判定用) ──────────
  // 「どのレジスタへの書き込みか」を 1 つの整数にする。書き込みは keyOf()*256+値 の組(pairs)で持つ。
  function keyOf(b, off, op) {
    if (op === 0x50 || op === 0x30) { // SN76489: ラッチ(bit7)ならチャンネル+種類、データバイトは 1 種類にまとめる
      const dd = b[off + 1];
      return (op << 16) | ((dd & 0x80) ? (dd & 0xF0) : 0x100);
    }
    if (op === 0x4F || (op >= 0x80 && op <= 0x8F) || (op >= 0x90 && op <= 0x95) || op === 0x68) return (op & 0xF0) << 16;
    if (op >= 0x30 && op <= 0x3F) return (op << 16) | b[off + 1];
    if ((op >= 0x40 && op <= 0x4E) || (op >= 0x51 && op <= 0x5F) || (op >= 0xA0 && op <= 0xBF)) return (op << 16) | b[off + 1];
    return (op << 16) | (b[off + 1] << 8) | b[off + 2]; // 0xC0-0xFF: アドレス 16bit(ポート+アドレス)
  }

  function fnv(h, v) { return Math.imul(h ^ (v & 0xFF), 16777619) | 0; }

  // ── 解析: コマンド列 → フレーム配列 ───────────────────────────────────────
  // frames[f] = { pass: [item], body: [item] }  item = { off, len, sub, pairs?, rewrite? }
  //   pass … そのフレームに残すデータブロック(多数決・署名の対象外)
  //   body … 書き込み(署名・多数決・定期書き込みの対象)
  function parse(bytes, hdr) {
    const frames = [];
    const frameAt = (f) => { while (frames.length <= f) frames.push({ pass: [], body: [] }); return frames[f]; };
    const end = hdr.gd3Offset && hdr.gd3Offset > hdr.dataOffset ? Math.min(hdr.gd3Offset, bytes.length) : bytes.length;
    let p = hdr.dataOffset, t = 0, loopFrame = -1;
    const opLen = VGM.operandLength;
    while (p < end) {
      const op = bytes[p];
      if (hdr.loopOffset && loopFrame < 0 && p >= hdr.loopOffset) loopFrame = Math.floor(t / SPF);
      if (op === 0x66) break;
      const f = Math.floor(t / SPF), sub = t - f * SPF;
      if (op === 0x61) { t += bytes[p + 1] | (bytes[p + 2] << 8); p += 3; continue; }
      if (op === 0x62) { t += SPF; p++; continue; }
      if (op === 0x63) { t += 882; p++; continue; }
      if (op >= 0x70 && op <= 0x7F) { t += (op & 0xF) + 1; p++; continue; }
      if (op === 0x67) { // データブロック
        if (p + 7 > end) break;
        const size = (bytes[p + 3] | (bytes[p + 4] << 8) | (bytes[p + 5] << 16) | (bytes[p + 6] << 24)) & 0x7FFFFFFF;
        const len = 7 + size, type = bytes[p + 2], block = bytes.subarray(p + 7, p + len);
        const fr = frameAt(f);
        if (VGM.isNesxBlock && VGM.isNesxBlock(type, block) && block[5] === VGM.NESX.KIND_WRITES) {
          // NES 拡張音源の書き込み列: addr16 value8 meta8 × n。レジスタ種類は addr
          const pairs = [];
          for (let q = 6; q + 4 <= block.length; q += 4) pairs.push((0x1000000 | block[q] | (block[q + 1] << 8)) * 256 + block[q + 2]);
          fr.body.push({ off: p, len, sub, pairs });
        } else fr.pass.push({ off: p, len, sub });
        p += len; continue;
      }
      if (op === 0x64) return { error: 'cmd64' }; // 0x62/0x63 の長さの上書き: 格子が崩れるので扱わない
      const n = opLen(op);
      if (n < 0) return { error: 'cmd' + op.toString(16) };
      const len = 1 + n;
      if (p + len > end) break;
      const item = { off: p, len, sub, pairs: [keyOf(bytes, p, op) * 256 + bytes[p + len - 1]] };
      if (op >= 0x80 && op <= 0x8F) { item.rewrite = 0x80; t += op & 0xF; } // YM2612 DAC 書き込み+待ち: 待ちは格子側で数える
      frameAt(f).body.push(item);
      p += len;
    }
    const n = Math.max(frames.length, Math.round(t / SPF));
    frameAt(Math.max(0, n - 1));
    return { frames, loopFrame };
  }

  function sigOf(bytes, fr) {
    if (!fr.body.length) return 0;
    let h = 2166136261 | 0;
    for (const it of fr.body) {
      if (it.rewrite != null) { h = fnv(h, it.rewrite); for (let i = 1; i < it.len; i++) h = fnv(h, bytes[it.off + i]); continue; }
      for (let i = 0; i < it.len; i++) h = fnv(h, bytes[it.off + i]);
    }
    return h || 1;
  }

  // drop[f]=1 のフレームを詰める。そのフレームの書き込みは次に残るフレームの頭へ移す(順序はそのまま)
  function dropFrames(frames, drop) {
    const out = [];
    const map = new Int32Array(frames.length);
    let carryPass = [], carryBody = [];
    for (let f = 0; f < frames.length; f++) {
      const fr = frames[f];
      map[f] = out.length;
      if (drop[f]) {
        for (const it of fr.pass) carryPass.push(Object.assign({}, it, { sub: 0 }));
        for (const it of fr.body) carryBody.push(Object.assign({}, it, { sub: 0 }));
        continue;
      }
      out.push(carryPass.length || carryBody.length ? { pass: carryPass.concat(fr.pass), body: carryBody.concat(fr.body) } : fr);
      carryPass = []; carryBody = [];
    }
    if (carryPass.length || carryBody.length) out.push({ pass: carryPass, body: carryBody });
    return { frames: out, map };
  }

  // ── 処理落ち補正 a: 毎フレーム書くドライバで書き込みが全く無いフレーム ───────────────
  function lagByRegular(frames, report) {
    const N = frames.length;
    const has = new Uint8Array(N);
    let written = 0;
    for (let f = 0; f < N; f++) if (frames[f].body.length) { has[f] = 1; written++; }
    if (written < LAG_MIN_FRAMES) { report.regularReason = 'short'; return null; }
    let first = 0; while (first < N && !has[first]) first++;
    let last = N - 1; while (last > first && !has[last]) last--;
    const span = last - first + 1;
    report.writtenRate = written / span;
    if (written < span * LAG_EVERY_FRAME_RATE) { report.regularReason = 'noRegular'; return null; }
    const drop = new Uint8Array(N);
    let runs = 0, removed = 0;
    for (let f = first + 1; f < last;) {
      if (has[f]) { f++; continue; }
      let g = f; while (g < last && !has[g]) g++;
      if (g - f <= LAG_MAX_RUN) { for (let x = f; x < g; x++) drop[x] = 1; runs++; removed += g - f; }
      f = g;
    }
    report.removedRegular = removed; report.runsRegular = runs;
    return removed ? drop : null;
  }

  // ── 周回の対応付け(帯付き DP) ─────────────────────────────────────────────
  // 1 周目 ref=[refStart, refStart+T) と、segStart から始まる区間を対応付ける。
  // 戻り値 { phaseOf: Int32Array(L)(区間の各フレームの位相。-1=その周回だけにある余分なフレーム),
  //          refHas: Uint8Array(T)(1 周目の各位相がこの周回にもあるか), consumed(区間で使ったフレーム数),
  //          score(判定できた組のうち一致した割合), maxPhase }
  function alignLap(sig, refStart, T, segStart, N) {
    const B = SFX_BAND, W = 2 * B + 1;
    const truncated = segStart + T + B > N;
    const L = Math.min(N - segStart, T + B);
    if (L <= 0) return null;
    const NEG = -1e9;
    // S[i*W + d] … ref の先頭 i フレームと区間の先頭 j=i+d-B フレームを対応付けた最良得点
    const S = new Float64Array((T + 1) * W).fill(NEG);
    const dir = new Int8Array((T + 1) * W); // 1=斜め 2=ref ギャップ(区間のフレームが余分) 3=区間ギャップ(ref のフレームが無い)
    S[0 * W + B] = 0;
    for (let i = 0; i <= T; i++) {
      for (let d = 0; d < W; d++) {
        const j = i + d - B;
        if (j < 0 || j > L) continue;
        let best = (i === 0 && j === 0) ? 0 : NEG, bd = 0;
        if (i > 0 && j > 0) { // 斜め
          const a = sig[refStart + i - 1], b = sig[segStart + j - 1];
          const sc = (a === b) ? (a ? DP_EQ : DP_BOTH_EMPTY) : DP_MIS;
          const v = S[(i - 1) * W + d] + sc;
          if (v > best) { best = v; bd = 1; }
        }
        if (j > 0 && d > 0) { // 区間のフレーム j-1 が余分(ref に相手が無い)
          const v = S[i * W + d - 1] + (sig[segStart + j - 1] ? DP_GAP_FULL : DP_GAP_EMPTY);
          if (v > best) { best = v; bd = 2; }
        }
        if (i > 0 && d + 1 < W) { // ref のフレーム i-1 がこの周回に無い
          const v = S[(i - 1) * W + d + 1] + (sig[refStart + i - 1] ? DP_GAP_FULL : DP_GAP_EMPTY);
          if (v > best) { best = v; bd = 3; }
        }
        S[i * W + d] = best; dir[i * W + d] = bd;
      }
    }
    // 終点: ref を使い切った所(区間の残りは次の周回)。区間が録音の末尾で切れていれば途中でも終われる
    let ei = -1, ed = -1, ev = NEG;
    for (let d = 0; d < W; d++) { const j = T + d - B; if (j >= 0 && j <= L && S[T * W + d] > ev) { ev = S[T * W + d]; ei = T; ed = d; } }
    if (truncated) for (let i = 0; i <= T; i++) { const d = L - i + B; if (d >= 0 && d < W && S[i * W + d] > ev) { ev = S[i * W + d]; ei = i; ed = d; } }
    if (ei < 0) return null;
    const phaseOf = new Int32Array(L).fill(-1);
    const refHas = new Uint8Array(T);
    let i = ei, d = ed, eq = 0, decisive = 0, maxPhase = -1, gapCost = 0, gaps = 0;
    const consumed = ei + ed - B;
    while (i > 0 || (i + d - B) > 0) {
      const j = i + d - B;
      const bd = dir[i * W + d];
      if (bd === 1) {
        phaseOf[j - 1] = i - 1; refHas[i - 1] = 1; if (maxPhase < 0) maxPhase = i - 1;
        const a = sig[refStart + i - 1], b = sig[segStart + j - 1];
        if (a || b) { decisive++; if (a === b) eq++; }
        i--;
      } else if (bd === 2) { gaps++; if (sig[segStart + j - 1]) { decisive++; gapCost++; } d--; }
      else if (bd === 3) { gaps++; if (sig[refStart + i - 1]) decisive++; gapCost++; i--; d++; }
      else break;
    }
    // gapCost: 処理落ち(空フレームの挿入)以外のギャップの数。真の周期なら周回の対応付けに
    // 「書き込みのあるフレームの挿入」も「1 周目のフレームが無い」も要らないので 0 に近い
    return { phaseOf, refHas, consumed, score: decisive ? eq / decisive : 0, maxPhase, eq, gapCost, gaps };
  }

  // 周期性の始まり: f と f+T(±SFX_START_SHIFT)の窓の一致率が SFX_START_RATE 以上になる最初の f
  function findStart(sig, N, T) {
    const W = Math.min(SFX_START_WIN, T);
    for (let f = 0; f + W <= N - T; f++) {
      for (let s = 0; s <= SFX_START_SHIFT * 2; s++) {
        const d = s === 0 ? 0 : (s % 2 ? (s + 1) >> 1 : -(s >> 1));
        if (f + T + d < 0 || f + W + T + d > N) continue;
        let m = 0, dec = 0;
        for (let x = f; x < f + W; x++) { const a = sig[x], b = sig[x + T + d]; if (!a && !b) continue; dec++; if (a === b) m++; }
        if (dec >= SFX_START_MIN_DECISIVE && m >= dec * SFX_START_RATE) {
          // 窓の頭でなく、窓の中で最初に一致したフレームを始まりにする(曲の頭の数フレームだけ 2 周目以降と違う
          // 曲で、そこを多数決の対象にしない)
          for (let x = f; x < f + W; x++) if (sig[x] && sig[x] === sig[x + T + d]) return x;
          return f;
        }
      }
    }
    return -1;
  }

  // 周期の候補 → 採点 → 全周回の対応付け。戻り値 { T, start, laps:[{base, phaseOf?, refHas?, consumed, maxPhase}], score } か null
  function analyzePeriod(sig, N, report) {
    if (N < SFX_MIN_PERIOD * 2) { report.reason = 'short'; return null; }
    const occ = new Map();
    for (let f = 0; f < N; f++) { if (!sig[f]) continue; let l = occ.get(sig[f]); if (!l) occ.set(sig[f], l = []); l.push(f); }
    const hist = new Float64Array(N);
    for (const list of occ.values()) {
      const c = list.length;
      if (c < 2 || c > SFX_MAX_OCC) continue;
      const w = 1 / (c - 1);
      for (let i = 0; i < c; i++) for (let k = i + 1; k < c; k++) { const d = list[k] - list[i]; if (d >= SFX_MIN_PERIOD && d * 2 <= N) hist[d] += w; }
    }
    const win = new Float64Array(N);
    for (let T = SFX_MIN_PERIOD; T * 2 <= N; T++) { let s = 0; for (let x = Math.max(0, T - SFX_HIST_WIN); x <= T + SFX_HIST_WIN && x < N; x++) s += hist[x]; win[T] = s; }
    const taken = new Uint8Array(N);
    const cands = [];
    for (let k = 0; k < SFX_CANDIDATES; k++) {
      let bestT = -1, bv = 0;
      for (let T = SFX_MIN_PERIOD; T * 2 <= N; T++) if (!taken[T] && win[T] > bv) { bv = win[T]; bestT = T; }
      if (bestT < 0) break;
      cands.push(bestT);
      for (let x = Math.max(0, bestT - 2 * SFX_HIST_WIN); x <= bestT + 2 * SFX_HIST_WIN && x < N; x++) taken[x] = 1;
    }
    if (!cands.length) { report.reason = 'noPeriod'; report.score = 0; return null; }
    // 候補の山は ±SFX_HIST_WIN で均してあるうえ、処理落ちがあると「T ずらして一致する数」は真の周期より
    // 少し長い T(ずれた後半どうしが合う)で最大になる。そこで近傍の T それぞれで 2 周目・3 周目を 1 周目へ
    // 対応付け、処理落ち(空フレームの挿入)以外のギャップ(gapCost)が最少、同点なら一致数が最多の T に寄せる。
    // 真の周期なら周回の違いは効果音と空フレームの挿入だけなので gapCost は 0 に近い
    const scored = [];
    for (const T0 of cands) {
      const s = findStart(sig, N, T0); // ±SFX_START_SHIFT のずれを許すので候補のままで足りる
      if (s < 0) continue;
      let pick = null;
      for (let T = Math.max(SFX_MIN_PERIOD, T0 - 2 * SFX_HIST_WIN); T <= T0 + 2 * SFX_HIST_WIN && s + T * 2 <= N; T++) {
        const a1 = alignLap(sig, s, T, s + T, N);
        if (!a1) continue;
        let gap = a1.gapCost, gaps = a1.gaps, eq = a1.eq;
        const c2 = s + T + a1.consumed;
        if (c2 < N) { const a2 = alignLap(sig, s, T, c2, N); if (a2) { gap += a2.gapCost; gaps += a2.gaps; eq += a2.eq; } }
        // 同点なら空フレームも含めたギャップの総数が少ない T(T が δ ずれていると毎周回の頭に δ 個の空ギャップが要る)、
        // それも同じなら一致数
        if (!pick || gap < pick.gap || (gap === pick.gap && (gaps < pick.gaps || (gaps === pick.gaps && eq > pick.eq)))) pick = { T, s, score: a1.score, gap, gaps, eq };
      }
      if (pick && !scored.some(c => c.T === pick.T)) scored.push(pick);
    }
    let best = 0;
    for (const c of scored) if (c.score > best) best = c.score;
    report.candidates = scored.map(c => `${c.T}@${c.s}:${(c.score * 100).toFixed(0)}%`).join(' '); // 周期@始まり:一致率
    if (best < SFX_MIN_SCORE) { report.reason = 'noPeriod'; report.score = best; return null; }
    let pick = null;
    const lapsOf = (c) => Math.floor((N - c.s) / c.T);
    for (const c of scored) {
      if (c.score < best - SFX_NEAR_BEST) continue;
      if (!pick) { pick = c; continue; }
      const a = lapsOf(c) >= SFX_PREFER_LAPS, b = lapsOf(pick) >= SFX_PREFER_LAPS;
      if (a !== b ? a : c.T > pick.T) pick = c;
    }
    const T = pick.T, start = pick.s;
    report.period = T; report.start = start; report.score = pick.score;
    // 全周回
    const laps = [{ base: start, consumed: T, maxPhase: T - 1 }];
    let c = start + T;
    while (c < N) {
      const al = alignLap(sig, start, T, c, N);
      if (!al || al.consumed <= 0) break;
      laps.push({ base: c, phaseOf: al.phaseOf, refHas: al.refHas, consumed: al.consumed, maxPhase: al.maxPhase });
      c += al.consumed;
    }
    report.laps = laps.filter(l => l.maxPhase >= T - 1).length;
    return { T, start, laps, score: pick.score };
  }

  // 位相 → 各周回のフレーム番号(-1=その周回に無い)
  function framesByPhase(per, N) {
    const { T, laps } = per;
    const table = laps.map(() => new Int32Array(T).fill(-1));
    for (let j = 0; j < laps.length; j++) {
      const lap = laps[j];
      if (!lap.phaseOf) { for (let p = 0; p < T && lap.base + p < N; p++) table[j][p] = lap.base + p; continue; }
      for (let x = 0; x < lap.phaseOf.length; x++) { const p = lap.phaseOf[x]; if (p >= 0) table[j][p] = lap.base + x; }
    }
    return table;
  }

  // フレームの書き込みの組(ソート済み配列、キャッシュ)
  function pairsOf(fr) {
    if (fr._pairs) return fr._pairs;
    const a = [];
    for (const it of fr.body) if (it.pairs) for (const p of it.pairs) a.push(p);
    a.sort((x, y) => x - y);
    return (fr._pairs = a);
  }
  // 多重集合の Jaccard 類似度(どちらも空なら 1)
  function similarity(a, b) {
    if (!a.length && !b.length) return 1;
    let i = 0, j = 0, inter = 0;
    while (i < a.length && j < b.length) { if (a[i] === b[j]) { inter++; i++; j++; } else if (a[i] < b[j]) i++; else j++; }
    return inter / (a.length + b.length - inter);
  }

  // ── 効果音除去: 位相ごとの多数決 ──────────────────────────────────────────
  function removeSfx(sig, frames, per, report) {
    const N = frames.length;
    const table = framesByPhase(per, N);
    if (per.laps.length < 2) { report.reason = 'oneLap'; return; }
    const rep = new Map(); // 署名 → その署名を持つフレーム(置き換えの元)
    for (let f = 0; f < N; f++) if (sig[f] && !rep.has(sig[f])) rep.set(sig[f], frames[f]);
    let replaced = 0, dropped = 0, restored = 0, outliers = 0;
    const counts = new Map();
    for (let p = 0; p < per.T; p++) {
      const entries = [];
      for (let j = 0; j < table.length; j++) if (table[j][p] >= 0) entries.push(table[j][p]);
      if (entries.length < 2) continue;
      counts.clear();
      let mode = 0, modeN = 0;
      for (const f of entries) { const c = (counts.get(sig[f]) || 0) + 1; counts.set(sig[f], c); if (c > modeN) { modeN = c; mode = sig[f]; } }
      let src = null, targets = null;
      if (modeN >= 2 && modeN * 2 > entries.length) {
        src = mode ? rep.get(mode) : null;
        targets = entries.filter(f => sig[f] !== mode);
      } else if (entries.length >= 3) {
        // 過半数が無い: 書き込みの組の類似度で外れ値(効果音)を見つける
        const ps = entries.map(f => pairsOf(frames[f]));
        let med = -1, medSum = -1;
        for (let a = 0; a < entries.length; a++) { let sum = 0; for (let b = 0; b < entries.length; b++) if (a !== b) sum += similarity(ps[a], ps[b]); if (sum > medSum) { medSum = sum; med = a; } }
        let corroborated = false;
        targets = [];
        for (let b = 0; b < entries.length; b++) { if (b === med) continue; const sim = similarity(ps[med], ps[b]); if (sim >= SFX_CORROBORATE) corroborated = true; else if (sim < SFX_OUTLIER) targets.push(entries[b]); }
        if (!corroborated || !targets.length) continue;
        src = frames[entries[med]];
        outliers += targets.length;
      } else continue;
      for (const f of targets) {
        // フレーム 0 は録音開始時のレジスタ復元(初期状態)がまとめて書かれているので、多数決で消さない
        if (f === 0) continue;
        const fr = frames[f];
        const before = fr.body.length, after = src ? src.body.length : 0;
        frames[f] = { pass: fr.pass, body: src ? src.body : [], _pairs: src ? pairsOf(src) : [] };
        replaced++;
        if (before > after) dropped += before - after; else restored += after - before;
      }
    }
    report.replaced = replaced; report.droppedWrites = dropped; report.restoredWrites = restored; report.outliers = outliers;
    report.applied = replaced > 0;
    if (!replaced) report.reason = 'none';
  }

  // ── 処理落ち補正 b: 周回の対応付けでその周回だけにある空フレーム ────────────────
  function lagByAlign(sig, frames, per, drop, report) {
    const N = frames.length;
    let removed = 0;
    const { T, laps } = per;
    for (let j = 1; j < laps.length; j++) {
      const lap = laps[j];
      for (let x = 0; x < lap.consumed; x++) {
        const f = lap.base + x;
        if (lap.phaseOf[x] < 0 && f < N && !sig[f] && !drop[f]) { drop[f] = 1; removed++; }
      }
    }
    // 1 周目の余分なフレーム: 他の周回(その位相まで届いているもの)の過半数で「無い」
    for (let p = 0; p < T; p++) {
      const f = laps[0].base + p;
      if (f >= N || sig[f] || drop[f]) continue;
      let have = 0, miss = 0;
      for (let j = 1; j < laps.length; j++) { if (laps[j].maxPhase < p) continue; if (laps[j].refHas[p]) have++; else miss++; }
      if (miss && miss > have) { drop[f] = 1; removed++; }
    }
    report.removedAlign = removed;
    return removed;
  }

  // ── 書き出し ──────────────────────────────────────────────────────────────
  function serialize(bytes, hdr, frames, loopFrame) {
    const chunks = [];
    let total = 0;
    const push = (arr) => { chunks.push(arr); total += arr.length; };
    push(bytes.subarray(0, hdr.dataOffset));
    const waitBytes = (n) => {
      const o = [];
      while (n > 0) {
        if (n === SPF) { o.push(0x62); n = 0; }
        else if (n === 882) { o.push(0x63); n = 0; }
        else if (n <= 16) { o.push(0x70 + n - 1); n = 0; }
        else { const m = Math.min(n, 0xFFFF); o.push(0x61, m & 0xFF, m >> 8); n -= m; }
      }
      return o;
    };
    let loopPos = -1;
    const body = [];
    for (let f = 0; f < frames.length; f++) {
      if (f === loopFrame) loopPos = body.length;
      const fr = frames[f];
      const items = fr.pass.concat(fr.body).sort((a, b) => a.sub - b.sub || 0); // sort は安定(pass → body の順は保たれる)
      let cur = 0;
      for (const it of items) {
        if (it.sub > cur) { for (const b of waitBytes(it.sub - cur)) body.push(b); cur = it.sub; }
        if (it.rewrite != null) body.push(it.rewrite); else body.push(bytes[it.off]);
        for (let i = 1; i < it.len; i++) body.push(bytes[it.off + i]);
      }
      for (const b of waitBytes(SPF - cur)) body.push(b);
    }
    body.push(0x66);
    const bodyArr = Uint8Array.from(body);
    const bodyStart = total;
    push(bodyArr);
    let gd3Pos = 0;
    if (hdr.gd3Offset && hdr.gd3Offset + 12 <= bytes.length) {
      const len = bytes[hdr.gd3Offset + 8] | (bytes[hdr.gd3Offset + 9] << 8) | (bytes[hdr.gd3Offset + 10] << 16) | (bytes[hdr.gd3Offset + 11] << 24);
      gd3Pos = total;
      push(bytes.subarray(hdr.gd3Offset, Math.min(bytes.length, hdr.gd3Offset + 12 + len)));
    }
    const out = new Uint8Array(total);
    let q = 0;
    for (const c of chunks) { out.set(c, q); q += c.length; }
    const u32 = (off, v) => { out[off] = v & 0xFF; out[off + 1] = (v >> 8) & 0xFF; out[off + 2] = (v >> 16) & 0xFF; out[off + 3] = (v >>> 24) & 0xFF; };
    u32(0x04, total - 4);
    u32(0x14, gd3Pos ? gd3Pos - 0x14 : 0);
    u32(0x18, frames.length * SPF);
    if (loopPos >= 0 && loopFrame < frames.length) {
      u32(0x1C, bodyStart + loopPos - 0x1C);
      u32(0x20, (frames.length - loopFrame) * SPF);
    } else { u32(0x1C, 0); u32(0x20, 0); }
    return out;
  }

  /**
   * @param {Uint8Array} bytes 解凍済み VGM
   * @param {{sfx?:boolean, lag?:boolean}} opt
   * @returns {{bytes:Uint8Array, report:object}} 何もしなかったときは bytes が入力そのもの
   */
  VGM.cleanCapture = function (bytes, opt) {
    opt = opt || {};
    const report = { lag: { on: !!opt.lag, applied: false, removedRegular: 0, removedAlign: 0 }, sfx: { on: !!opt.sfx, applied: false } }; // removedRegular: a の方式 / removedAlign: b の方式
    if (!opt.sfx && !opt.lag) return { bytes, report };
    const hdr = VGM.parseHeader(bytes);
    if (!hdr || !hdr.magicOk) { report.error = 'header'; return { bytes, report }; }
    const parsed = parse(bytes, hdr);
    if (parsed.error) { report.error = parsed.error; return { bytes, report }; }
    let frames = parsed.frames;
    let loopFrame = parsed.loopFrame;
    report.frames = frames.length;
    // a. 定期書き込みによる処理落ち補正(周回の対応付けより前に。周回のずれが減る)
    if (opt.lag) {
      const drop = lagByRegular(frames, report.lag);
      if (drop) {
        const r = dropFrames(frames, drop);
        frames = r.frames;
        if (loopFrame >= 0) loopFrame = r.map[loopFrame];
      }
    }
    // 周期と周回の対応付け
    const N = frames.length;
    const sig = new Int32Array(N);
    for (let f = 0; f < N; f++) sig[f] = sigOf(bytes, frames[f]);
    const perReport = {};
    const per = analyzePeriod(sig, N, perReport);
    Object.assign(report.sfx, perReport);
    report.period = per ? { T: per.T, start: per.start, laps: perReport.laps, score: per.score } : null;
    if (opt.sfx) {
      if (per) removeSfx(sig, frames, per, report.sfx);
    }
    // b. 周回の対応付けによる処理落ち補正
    if (opt.lag && per) {
      const drop = new Uint8Array(N);
      if (lagByAlign(sig, frames, per, drop, report.lag)) {
        const r = dropFrames(frames, drop);
        frames = r.frames;
        if (loopFrame >= 0) loopFrame = r.map[loopFrame];
      }
    }
    report.lag.applied = (report.lag.removedRegular + report.lag.removedAlign) > 0;
    if (opt.lag && !report.lag.applied) report.lag.reason = report.lag.regularReason === 'noRegular' && !per ? 'noPeriod' : (report.lag.regularReason || 'none');
    if (!report.lag.applied && !report.sfx.applied) return { bytes, report };
    report.outFrames = frames.length;
    return { bytes: serialize(bytes, hdr, frames, loopFrame), report };
  };

  // MML ヘッダコメント用の説明(vgm2mml/converter.js が「; ※ 」に続けて書く)
  // 補正済みの印: GD3 の notes 欄に "cleaned: sfx lag"(録音側で補正した VGM。変換側は同じ補正を重ねない)
  VGM.CLEAN_NOTE = 'cleaned:';
  VGM.cleanNoteOf = function (flags) { return VGM.CLEAN_NOTE + (flags.sfx ? ' sfx' : '') + (flags.lag ? ' lag' : ''); };
  VGM.cleanedFlags = function (hdr) {
    const n = hdr && hdr.gd3 && hdr.gd3.notes ? String(hdr.gd3.notes) : '';
    const i = n.indexOf(VGM.CLEAN_NOTE);
    if (i < 0) return { sfx: false, lag: false };
    const w = n.slice(i + VGM.CLEAN_NOTE.length).split(/[^a-z]+/);
    return { sfx: w.includes('sfx'), lag: w.includes('lag') };
  };
  // GD3 の notes 欄を書き換える(他の欄はそのまま)。GD3 は末尾にある前提(無ければ足す)
  VGM.setGd3Notes = function (bytes, notes) {
    const hdr = VGM.parseHeader(bytes);
    if (!hdr || !hdr.magicOk) return bytes;
    const g = hdr.gd3 || {};
    const utf16 = (s) => { const o = []; for (const ch of String(s || '')) { const c = ch.codePointAt(0); if (c < 0x10000) o.push(c & 0xFF, c >> 8); else o.push(0x3F, 0); } o.push(0, 0); return o; };
    const fields = [].concat(utf16(g.trackEn), utf16(g.trackJa), utf16(g.gameEn), utf16(g.gameJa), utf16(g.systemEn), utf16(g.systemJa),
      utf16(g.authorEn), utf16(g.authorJa), utf16(g.date), utf16(g.dumper), utf16(notes));
    const u32 = (n) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF];
    const gd3 = [].concat([0x47, 0x64, 0x33, 0x20], u32(0x100), u32(fields.length), fields);
    const cut = hdr.gd3Offset && hdr.gd3Offset > hdr.dataOffset ? hdr.gd3Offset : bytes.length;
    const out = new Uint8Array(cut + gd3.length);
    out.set(bytes.subarray(0, cut), 0); out.set(gd3, cut);
    const w32 = (off, n) => { out[off] = n & 0xFF; out[off + 1] = (n >> 8) & 0xFF; out[off + 2] = (n >> 16) & 0xFF; out[off + 3] = (n >>> 24) & 0xFF; };
    w32(0x04, out.length - 4);
    w32(0x14, cut - 0x14);
    return out;
  };

  VGM.describeClean = function (report) {
    if (!report) return [];
    const out = [];
    if (report.pre && (report.pre.sfx || report.pre.lag)) {
      out.push('録音の補正: ' + [report.pre.sfx ? '効果音除去' : '', report.pre.lag ? '処理落ち補正' : ''].filter(Boolean).join('と') + 'は録音時に適用済みの VGM なので、変換ではその補正を重ねていません。');
    }
    if (report.error) {
      out.push(`録音の補正: VGM を解釈できなかったため何もしませんでした(${report.error})。`);
      return out;
    }
    const L = report.lag, S = report.sfx, P = report.period;
    const perText = P ? `周期 ${P.T} フレーム(一致率 ${(P.score * 100).toFixed(0)}%)、周期性の始まり ${P.start} フレーム、${P.laps} 周` : null;
    if (L && L.on) {
      if (L.applied) {
        const parts = [];
        if (L.removedRegular) parts.push(`毎フレーム書くドライバで書き込みが無かった ${L.removedRegular} フレーム(${L.runsRegular} 箇所)`);
        if (L.removedAlign) parts.push(`周回を重ねて余分だった空フレーム ${L.removedAlign} 枚(${perText})`);
        out.push(`処理落ち補正: ${parts.join('、')}を詰めました。${report.frames}→${report.outFrames} フレーム。`);
      } else out.push('処理落ち補正: ' + ({
        short: '書き込みのあるフレームが少なく判定できませんでした。',
        noRegular: `毎フレーム書くドライバではないので空フレームでは判定できず、周回の対応付け(${perText})でも余分なフレームはありませんでした。`,
        noPeriod: '毎フレーム書くドライバではないので空フレームでは判定できず、周回で一致する周期も見つかりませんでした(曲が 2 周以上入るように録音すると周回の対応付けで判定できます)。',
        none: '詰めるフレームはありませんでした。'
      }[L.reason] || '何もしませんでした。'));
    }
    if (S && S.on) {
      if (S.applied) {
        out.push(`効果音除去: ${perText}。周回の多数決で ${S.replaced} フレームを置き換えました(書き込み ${S.droppedWrites} 件を落とし ${S.restoredWrites} 件を復元)。`);
        if (P && P.laps < 3) out.push('効果音除去: 周回が 2 つしか無いので、両方の周回で違うフレームはどちらが曲か決められず残しています。3 周以上録音すると確実です。');
        out.push('効果音除去: 周期性が始まる前(イントロ)の効果音は多数決できないので残っています。');
      } else out.push('効果音除去: ' + ({
        short: '録音が短く(周期の 2 倍未満)周期を出せませんでした。',
        noPeriod: `周回で一致する周期が見つかりませんでした(候補と一致率: ${S.candidates || '-'})。曲が 2 周以上入るように録音してください。`,
        oneLap: `周期 ${S.period} フレームは出ましたが 2 周目が録音に収まっていません。`,
        none: `${perText}で周回ごとに違うフレームはありませんでした。`
      }[S.reason] || '何もしませんでした。'));
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
