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

  /**
   * PCMサンプル(-1..1, srcRate Hz)をDPCMバイト列にエンコードする
   * @param {Float32Array} samples
   * @param {number} srcRate - 入力サンプルレート(Hz)
   * @param {number} rateIndex - DMCレートインデックス(0-15)
   * @returns {{bytes: Uint8Array, rateIndex: number, rateHz: number, sampleCount: number}}
   */
  function encode(samples, srcRate, rateIndex) {
    rateIndex = Math.max(0, Math.min(15, rateIndex | 0));
    const rateHz = DMC_RATE_TABLE_NTSC[rateIndex];
    const resampled = resample(samples, srcRate, rateHz);

    const bits = new Array(resampled.length);
    let counter = 64;
    for (let i = 0; i < resampled.length; i++) {
      const target = (resampled[i] * 0.5 + 0.5) * 127; // 0-127
      const bit = target >= counter ? 1 : 0;
      counter += bit ? 2 : -2;
      counter = Math.max(0, Math.min(127, counter));
      bits[i] = bit;
    }

    // DMCサンプルはバイト単位(8サンプル/byte, LSBが先頭)で、
    // 長さは16バイト境界に揃える必要がある(不足分は0bitでパディング)
    const sampleCount = bits.length;
    const byteCount = Math.ceil(sampleCount / 8 / 16) * 16 || 16;
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < sampleCount; i++) {
      if (bits[i]) bytes[i >> 3] |= (1 << (i & 7));
    }

    return { bytes, rateIndex, rateHz, sampleCount };
  }

  /**
   * DPCMバイト列をプレビュー用PCM波形(-1..1)に復号する
   * @param {Uint8Array} bytes
   * @param {number} sampleCount
   * @returns {Float32Array}
   */
  function decode(bytes, sampleCount) {
    const out = new Float32Array(sampleCount);
    let counter = 64;
    for (let i = 0; i < sampleCount; i++) {
      const bit = (bytes[i >> 3] >> (i & 7)) & 1;
      counter += bit ? 2 : -2;
      counter = Math.max(0, Math.min(127, counter));
      out[i] = (counter / 127) * 2 - 1;
    }
    return out;
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
    hexDump
  };
})(window);
