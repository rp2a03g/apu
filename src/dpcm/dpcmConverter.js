/*
 * DPCMコンバータ
 * MML.Dpcm
 *
 * PCM音声(WAV等、ブラウザのdecodeAudioDataが対応する形式)を
 * 2A03 DMCチャンネル用の1bit デルタ変調(DPCM)データへ変換する。
 *
 * - DMC_RATE_TABLE_NTSC: $4010 のレート値(0-15)に対応する再生周波数(Hz)
 * - encode(samples, sourceRate, rateIndex) -> { bytes: Uint8Array, rateIndex, rateHz, sampleCount }
 * - decode(bytes, sampleCount) -> Float32Array (-1..1, プレビュー用)
 */
(function (global) {
  const MML = global.MML = global.MML || {};

  // NTSC版 2A03 DMCレートテーブル ($4010 下位4bit -> 再生周波数Hz)
  const DMC_RATE_TABLE_NTSC = [
    4181.71, 4709.93, 5264.04, 5593.04, 6257.95, 7046.35, 7919.35, 8363.42,
    9419.86, 11186.10, 12604.00, 13982.64, 16884.6, 21306.8, 24858.0, 33143.9
  ];

  // 線形補間によるリサンプリング
  function resample(samples, srcRate, dstRate) {
    if (srcRate === dstRate) return samples.slice();
    const dstLength = Math.max(1, Math.round((samples.length * dstRate) / srcRate));
    const out = new Float32Array(dstLength);
    for (let i = 0; i < dstLength; i++) {
      const srcPos = (i * (samples.length - 1)) / Math.max(1, dstLength - 1);
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(samples.length - 1, i0 + 1);
      const frac = srcPos - i0;
      out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return out;
  }

  // ── 1bit列の生成 ──────────────────────────────────────────────────
  // DACカウンタの遷移は実機DMC(およびsrc/emulator/apu2a03.js clockOutput())と同じ:
  //   bit=1: counter<=125 なら +2、それ以外は変化なし
  //   bit=0: counter>=2   なら -2、それ以外は変化なし
  // (以前は0/127でclampしていたが、実機は125/2で頭打ちし±1の飛び越えは起きない=
  //  カウンタの偶奇は初期値のまま保存される。エンコーダの想定と再生側の実挙動を
  //  完全一致させるためこちらへ統一した)
  function stepUp(c) { return c <= 125 ? c + 2 : c; }
  function stepDown(c) { return c >= 2 ? c - 2 : c; }

  // 貪欲法(旧方式): その場その場で目標に近づく方だけを選ぶ。O(N)で省メモリ。
  // Viterbiのメモリ上限を超える長大入力のフォールバック用に残す。
  function encodeBitsGreedy(targets, startCounter) {
    const bits = new Uint8Array(targets.length);
    let counter = startCounter;
    for (let i = 0; i < targets.length; i++) {
      const bit = targets[i] >= counter ? 1 : 0;
      counter = bit ? stepUp(counter) : stepDown(counter);
      bits[i] = bit;
    }
    return bits;
  }

  // Viterbi(動的計画法): カウンタ128状態×サンプル数の格子で二乗誤差合計が最小になる
  // bit列を選ぶ(2026-08、貪欲法からの品質改善)。貪欲法は「今」最善のbitしか選べないため、
  //   ・平坦部で目標の上下どちらに張り付くかの位相が最適にならない(アイドルトーン悪化)
  //   ・大きなジャンプの直前に「助走」できない(スロープ過負荷の増幅)
  // が起きる。DPは全体最適なのでどちらも自動的に解決する。計算量O(64N)
  // (±2遷移で偶奇が保存されるため実際に到達しうる状態は64個)。
  // バックポインタは1状態あたり2bit(採用bit+自己ループか)をパックして持つ
  // (N*32バイト。上限VITERBI_MAX_SAMPLESを超える入力は貪欲法へフォールバック)。
  const VITERBI_MAX_SAMPLES = 2000000; // バックポインタ約64MBまで許容
  function encodeBitsViterbi(targets, startCounter) {
    const N = targets.length;
    if (N > VITERBI_MAX_SAMPLES) return encodeBitsGreedy(targets, startCounter);
    const par = startCounter & 1; // 偶奇は保存される(上のコメント参照)
    let prev = new Float64Array(128).fill(Infinity);
    let next = new Float64Array(128);
    prev[startCounter] = 0;
    const bp = new Uint8Array((N * 128 + 3) >> 2); // (i,状態)ごとに2bit
    for (let i = 0; i < N; i++) {
      next.fill(Infinity);
      const t = targets[i];
      const base = i * 128;
      for (let c = par; c < 128; c += 2) {
        const pc = prev[c];
        if (pc === Infinity) continue;
        const n1 = stepUp(c);
        const e1 = n1 - t;
        const c1 = pc + e1 * e1;
        if (c1 < next[n1]) {
          next[n1] = c1;
          const idx = base + n1, code = 1 | (n1 === c ? 2 : 0);
          bp[idx >> 2] = (bp[idx >> 2] & ~(3 << ((idx & 3) * 2))) | (code << ((idx & 3) * 2));
        }
        const n0 = stepDown(c);
        const e0 = n0 - t;
        const c0 = pc + e0 * e0;
        if (c0 < next[n0]) {
          next[n0] = c0;
          const idx = base + n0, code = (n0 === c ? 2 : 0);
          bp[idx >> 2] = (bp[idx >> 2] & ~(3 << ((idx & 3) * 2))) | (code << ((idx & 3) * 2));
        }
      }
      const tmp = prev; prev = next; next = tmp;
    }
    // 終端: 最小コストの状態から逆順にbitと前状態を復元する
    let best = par, bestCost = Infinity;
    for (let c = par; c < 128; c += 2) if (prev[c] < bestCost) { bestCost = prev[c]; best = c; }
    const bits = new Uint8Array(N);
    let s = best;
    for (let i = N - 1; i >= 0; i--) {
      const idx = i * 128 + s;
      const code = (bp[idx >> 2] >> ((idx & 3) * 2)) & 3;
      const bit = code & 1;
      bits[i] = bit;
      if (!(code & 2)) s = bit ? s - 2 : s + 2; // 自己ループでなければ遷移を巻き戻す
    }
    return bits;
  }

  /**
   * PCMサンプル(-1..1, srcRate Hz)をDPCMバイト列にエンコードする
   * @param {Float32Array} samples
   * @param {number} srcRate - 入力サンプルレート(Hz)
   * @param {number} rateIndex - DMCレートインデックス(0-15)
   * @param {{startCounter?:number}} [opt] - startCounter: DACカウンタの開始値(0-127、既定64)。
   *   再生側が@DPCM定義のdac値($4011初期書込み)で同じ値から開始する前提で、先頭サンプル値を
   *   渡すと頭の追従ランプ(クリック)が消える(hes2mml/expansion/dpcm.js参照)。
   * @returns {{bytes: Uint8Array, rateIndex: number, rateHz: number, sampleCount: number, startCounter: number}}
   */
  function encode(samples, srcRate, rateIndex, opt) {
    rateIndex = Math.max(0, Math.min(15, rateIndex | 0));
    const rateHz = DMC_RATE_TABLE_NTSC[rateIndex];
    const resampled = resample(samples, srcRate, rateHz);
    const startCounter = Math.max(0, Math.min(127, (opt && opt.startCounter != null) ? opt.startCounter | 0 : 64));

    const targets = new Float64Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) targets[i] = (resampled[i] * 0.5 + 0.5) * 127; // 0-127
    const bits = encodeBitsViterbi(targets, startCounter);

    // DMCサンプルはバイト単位(8サンプル/byte, LSBが先頭)で、
    // 長さは16バイト境界に揃える必要がある。
    // ★パディングは0bit詰めではなく+2/-2交互の「ホールド」で埋める。実機DMCは
    // 16バイト境界までの全bitを再生するため、0詰めだと末尾でDACが-2/bitで滑り落ちて
    // プチッと鳴る(プレビューのdecode()はsampleCountで止まるため気づけない)。
    const sampleCount = bits.length;
    const byteCount = Math.ceil(sampleCount / 8 / 16) * 16 || 16;
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < sampleCount; i++) {
      if (bits[i]) bytes[i >> 3] |= (1 << (i & 7));
    }
    for (let i = sampleCount; i < byteCount * 8; i++) {
      // 最後のデータbitと逆から始めて交互に(±2の往復=値を保持)
      const bit = ((i - sampleCount) & 1) === 0 ? (sampleCount > 0 ? 1 - bits[sampleCount - 1] : 1) : (sampleCount > 0 ? bits[sampleCount - 1] : 0);
      if (bit) bytes[i >> 3] |= (1 << (i & 7));
    }

    return { bytes, rateIndex, rateHz, sampleCount, startCounter };
  }

  /**
   * DPCMバイト列をプレビュー用PCM波形(-1..1)に復号する
   * @param {Uint8Array} bytes
   * @param {number} sampleCount
   * @param {number} [startCounter] - encode時のstartCounterと同じ値(既定64)
   * @returns {Float32Array}
   */
  function decode(bytes, sampleCount, startCounter) {
    const out = new Float32Array(sampleCount);
    let counter = (startCounter != null) ? Math.max(0, Math.min(127, startCounter | 0)) : 64;
    for (let i = 0; i < sampleCount; i++) {
      const bit = (bytes[i >> 3] >> (i & 7)) & 1;
      counter = bit ? stepUp(counter) : stepDown(counter); // 実機DMC/エンコーダと同一遷移
      out[i] = (counter / 127) * 2 - 1;
    }
    return out;
  }

  // ── 曲全体の音量正規化(焼き込み経路で共有する方針) ─────────────────────────
  // DMC(DPCM)チャンネルには音量指定が無く、焼いた波形の振幅がそのまま再生音量になる。
  // ところが素材の振幅スケールは形式・経路ごとに桁が違う(HESのDDAは5bit値を[-1,1]へ
  // 写すので常にほぼ全振幅、SPCのBRRは実測でピーク中央値0.43)。そのままだと
  // 「この形式だけDPCMが小さい」という食い違いになるので、曲内で最も大きい素材が
  // 全振幅に届くゲインを全体へ掛ける(素材どうしの音量比は保つ)。
  // 持ち上げのみ・上限あり(無音付近のノイズを増幅しないため)。
  // 呼ぶ側は「曲内の最大ピーク(素材の音量係数を掛けた後)」を渡す。
  const NORM_MAX_BOOST = 12;   // SPC40曲の実測で必要ゲインは中央5.3・90%点9.7・最大12.2
  const NORM_DEADBAND = 1.05;  // これ未満の持ち上げはしない(既に全振幅の形式は出力不変)
  function normGain(maxPeak) {
    const wanted = maxPeak > 0 ? 1 / maxPeak : 1;
    return wanted > NORM_DEADBAND ? Math.min(NORM_MAX_BOOST, wanted) : 1;
  }

  // ── DMC 1本の上限 ─────────────────────────────────────────────────────
  // 実機 $4013 は 255 → 255*16+1 = 4081 バイトが上限。encode() は16バイト単位で出すので
  // 実質 4080 バイト = 32640 サンプルまで。これを超えるサンプルは分割して
  // 別々の @DPCM 定義にし、連続して鳴らす(src/convert/drumHits.js の分割、src/ui/dpcmEditor.js)。
  const HW_MAX_BYTES = 4081;
  const MAX_ENCODED_BYTES = 4080;
  const MAX_ENCODED_SAMPLES = MAX_ENCODED_BYTES * 8;

  /** DPCMバイト列を復号し終えた時点のDACカウンタ(0-127)。分割した次の区間の $4011 初期値に使う */
  function endCounter(bytes, sampleCount, startCounter) {
    let counter = (startCounter != null) ? Math.max(0, Math.min(127, startCounter | 0)) : 64;
    for (let i = 0; i < sampleCount; i++) {
      const bit = (bytes[i >> 3] >> (i & 7)) & 1;
      counter = bit ? stepUp(counter) : stepDown(counter);
    }
    return counter;
  }

  /**
   * 16進数文字列ダンプ
   */
  function hexDump(bytes, perLine) {
    perLine = perLine || 16;
    const lines = [];
    for (let i = 0; i < bytes.length; i += perLine) {
      const chunk = Array.from(bytes.slice(i, i + perLine));
      lines.push(chunk.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
    }
    return lines.join('\n');
  }

  MML.Dpcm = {
    DMC_RATE_TABLE_NTSC,
    resample,
    encode,
    decode,
    hexDump,
    normGain,
    endCounter,
    NORM_MAX_BOOST,
    NORM_DEADBAND,
    HW_MAX_BYTES,
    MAX_ENCODED_BYTES,
    MAX_ENCODED_SAMPLES
  };
})(window);
