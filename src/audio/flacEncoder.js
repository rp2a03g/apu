/*
 * FLAC エンコーダ(自前実装、外部ライブラリ無し) MML.Audio.Flac
 *
 *   await MML.Audio.Flac.encode(chans, sampleRate, opt) -> Blob('audio/flac')
 *     chans      … [Float32Array] (1本=モノラル / 2本=ステレオ)。値は -1..1
 *     sampleRate … Hz
 *     opt        … { gain, tags, blockSize, maxLpcOrder, onProgress(0..1), yieldFn }
 *
 * ブラウザには音声のデコーダは載っているがエンコーダはほぼ無い(WebCodecsのAAC/Opusだけ)。
 * FLACは自分で書くしかないので、別プロジェクト(cdrip)の自前エンコーダを移植した。
 * Node依存(node:fs / node:crypto)は外し、MD5は下の md5Bytes() で自前計算している
 * ([[flac-encoder-from-scratch]] [[flac-lpc-implementation]])。
 *
 * 中身: 固定予測(次数0-4)+LPC(次数1-12)、ステレオ相関除去(L/R・L/S・R/S・M/S)、
 * 分割Riceコード。44.1kHzのstreamable subset(LPC次数<=12・係数精度15)に収まる。
 *
 * ★残差の右シフトは算術シフト(Math.floor)でなければならない。truncだと負の合計だけ
 *   静かに壊れて可逆でなくなる([[flac-lpc-implementation]])。
 * ★検証は「WAVとFLACを decodeAudioData 経由で float 同士で比較」する。
 *   int16へ戻して比べると v/32767 の丸めで誤検知する([[flac-encoder-from-scratch]])。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Audio = MML.Audio = MML.Audio || {};

  // ── MD5(STREAMINFOの音声データハッシュ用。RFC 1321) ──────────────────────
  // FLACのMD5は「符号化前のPCMを、1サンプル=ビット深度をバイト単位に切り上げた
  // リトルエンディアン整数として、インターリーブ順に並べたバイト列」に対して取る。
  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const MD5_K = new Int32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) | 0;

  /** 64バイトずつ食わせる逐次MD5。update()で流し、digest()で16バイトのUint8Arrayを返す */
  class Md5 {
    constructor() {
      this.a = 0x67452301 | 0; this.b = 0xefcdab89 | 0;
      this.c = 0x98badcfe | 0; this.d = 0x10325476 | 0;
      this.block = new Uint8Array(64);
      this.view = new DataView(this.block.buffer);
      this.fill = 0;
      this.len = 0; // 総バイト数(2^53未満で足りる)
    }
    update(bytes) {
      this.len += bytes.length;
      let off = 0;
      if (this.fill > 0) {
        const take = Math.min(64 - this.fill, bytes.length);
        this.block.set(bytes.subarray(0, take), this.fill);
        this.fill += take; off = take;
        if (this.fill < 64) return;
        this._round(this.view, 0);
        this.fill = 0;
      }
      // 64バイト境界に乗っている間は元の配列を直接見る(コピーを避ける)
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (; off + 64 <= bytes.length; off += 64) this._round(dv, off);
      if (off < bytes.length) {
        this.block.set(bytes.subarray(off), 0);
        this.fill = bytes.length - off;
      }
    }
    digest() {
      const tail = new Uint8Array(this.fill + 72);
      tail.set(this.block.subarray(0, this.fill), 0);
      tail[this.fill] = 0x80;
      let padded = this.fill + 1;
      while ((padded % 64) !== 56) { tail[padded++] = 0; }
      const dv = new DataView(tail.buffer);
      const bits = this.len * 8;
      dv.setUint32(padded, bits >>> 0, true);
      dv.setUint32(padded + 4, Math.floor(bits / 4294967296) >>> 0, true);
      padded += 8;
      for (let o = 0; o < padded; o += 64) this._round(dv, o);
      const out = new Uint8Array(16);
      const ov = new DataView(out.buffer);
      ov.setInt32(0, this.a, true); ov.setInt32(4, this.b, true);
      ov.setInt32(8, this.c, true); ov.setInt32(12, this.d, true);
      return out;
    }
    _round(dv, off) {
      let a = this.a, b = this.b, c = this.c, d = this.d;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
        else { f = c ^ (b | ~d); g = (7 * i) & 15; }
        const tmp = d;
        d = c; c = b;
        const x = (a + f + MD5_K[i] + dv.getUint32(off + g * 4, true)) | 0;
        const s = MD5_S[i];
        b = (b + (((x << s) | (x >>> (32 - s))) | 0)) | 0;
        a = tmp;
      }
      this.a = (this.a + a) | 0; this.b = (this.b + b) | 0;
      this.c = (this.c + c) | 0; this.d = (this.d + d) | 0;
    }
  }

  // ── ビット書き出しとCRC ────────────────────────────────────────────────
  const CRC8 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    CRC8[i] = c;
  }
  const CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = (c & 0x8000) ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    CRC16[i] = c;
  }
  function crc8(buf, start, end) {
    let c = 0;
    for (let i = start; i < end; i++) c = CRC8[c ^ buf[i]];
    return c;
  }
  function crc16(buf, start, end) {
    let c = 0;
    for (let i = start; i < end; i++) c = ((c << 8) ^ CRC16[((c >> 8) ^ buf[i]) & 0xff]) & 0xffff;
    return c;
  }

  class BitWriter {
    constructor(capacity) {
      this.buf = new Uint8Array(capacity || (1 << 17));
      this.len = 0;   // 出力済みバイト数
      this.acc = 0;   // 端数ビット(右詰め)
      this.nbits = 0; // 端数ビット数(呼び出し間では常に8未満)
    }
    reset() { this.len = 0; this.acc = 0; this.nbits = 0; }
    ensure(extra) {
      if (this.len + extra <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < this.len + extra) cap *= 2;
      const b = new Uint8Array(cap);
      b.set(this.buf.subarray(0, this.len));
      this.buf = b;
    }
    /** v の下位 n ビットを MSB 側から詰める(n <= 32) */
    writeBits(v, n) {
      if (n > 16) { this.writeBits(v >>> 16, n - 16); this.writeBits(v & 0xffff, 16); return; }
      this.acc = ((this.acc << n) | (v & (n === 32 ? 0xffffffff : (1 << n) - 1))) >>> 0;
      this.nbits += n;
      this.ensure(4);
      while (this.nbits >= 8) {
        this.nbits -= 8;
        this.buf[this.len++] = (this.acc >>> this.nbits) & 0xff;
      }
    }
    writeZeros(n) {
      while (n >= 16) { this.writeBits(0, 16); n -= 16; }
      if (n > 0) this.writeBits(0, n);
    }
    /** Riceコード: q個の0、1、続いて余りのkビット */
    writeRice(u, k) {
      const q = u >>> k;
      if (q >= 16) this.writeZeros(q); else if (q > 0) this.writeBits(0, q);
      this.writeBits((1 << k) | (u & ((1 << k) - 1)), k + 1);
    }
    /** FLACのUTF-8風符号(36bitまで。フレーム番号用) */
    writeUtf8(n) {
      if (n < 0x80) { this.writeBits(n, 8); return; }
      let bytes, lead;
      if (n < 0x800) { bytes = 2; lead = 0xc0; }
      else if (n < 0x10000) { bytes = 3; lead = 0xe0; }
      else if (n < 0x200000) { bytes = 4; lead = 0xf0; }
      else if (n < 0x4000000) { bytes = 5; lead = 0xf8; }
      else { bytes = 6; lead = 0xfc; }
      const shift = 6 * (bytes - 1);
      this.writeBits(lead | (Math.floor(n / Math.pow(2, shift)) & 0xff), 8);
      for (let s = shift - 6; s >= 0; s -= 6) {
        this.writeBits(0x80 | (Math.floor(n / Math.pow(2, s)) & 0x3f), 8);
      }
    }
    align() { if (this.nbits) this.writeBits(0, 8 - this.nbits); }
    bytes() { return this.buf.subarray(0, this.len); }
  }

  // ── メタデータブロック ─────────────────────────────────────────────────
  const BLOCK = { STREAMINFO: 0, SEEKTABLE: 3, VORBIS_COMMENT: 4 };
  const STREAMINFO_SIZE = 34;

  function blockHeader(type, length, last) {
    const b = new Uint8Array(4);
    b[0] = (last ? 0x80 : 0) | (type & 0x7f);
    b[1] = (length >>> 16) & 0xff; b[2] = (length >>> 8) & 0xff; b[3] = length & 0xff;
    return b;
  }
  function streamInfo(o) {
    const b = new Uint8Array(STREAMINFO_SIZE);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, o.minBlockSize);
    dv.setUint16(2, o.maxBlockSize);
    const u24 = (off, v) => { b[off] = (v >>> 16) & 0xff; b[off + 1] = (v >>> 8) & 0xff; b[off + 2] = v & 0xff; };
    u24(4, o.minFrameSize || 0);
    u24(7, o.maxFrameSize || 0);
    // 20bit rate | 3bit (ch-1) | 5bit (bps-1) | 36bit totalSamples の64bitを上下32bitに分ける。
    // ★ビットシフトではなく掛け算で組む: rate<<12 は20bitフルのレートで符号ビットを踏む
    const hi = o.sampleRate * 4096 + (o.channels - 1) * 512 + (o.bitsPerSample - 1) * 16
      + (Math.floor(o.totalSamples / 4294967296) & 0x0f);
    dv.setUint32(10, hi);
    dv.setUint32(14, o.totalSamples >>> 0);
    b.set(o.md5 || new Uint8Array(16), 18);
    return b;
  }
  function vorbisComment(tags, vendor) {
    const enc = new TextEncoder();
    const entries = [];
    for (const k of Object.keys(tags || {})) {
      const v = tags[k];
      if (v === undefined || v === null || v === '') continue;
      entries.push(enc.encode(k + '=' + v));
    }
    const v = enc.encode(vendor || 'Sound Emulation Foundry');
    let size = 4 + v.length + 4;
    for (const e of entries) size += 4 + e.length;
    const b = new Uint8Array(size);
    const dv = new DataView(b.buffer);
    let o = 0;
    dv.setUint32(o, v.length, true); o += 4;
    b.set(v, o); o += v.length;
    dv.setUint32(o, entries.length, true); o += 4;
    for (const e of entries) { dv.setUint32(o, e.length, true); o += 4; b.set(e, o); o += e.length; }
    return b;
  }
  /** points: [{sampleNumber, streamOffset, frameSamples}]。数値を渡すとその数だけ空点を作る */
  function seekTable(points) {
    const n = typeof points === 'number' ? points : points.length;
    const b = new Uint8Array(n * 18);
    const dv = new DataView(b.buffer);
    for (let i = 0; i < n; i++) {
      const p = typeof points === 'number' ? null : points[i];
      if (!p) { b.fill(0xff, i * 18, i * 18 + 8); continue; } // 空点(sampleNumber=全1)
      // 総サンプル数は2^32を超えないので上位32bitは0固定でよい(44.1kHzで27時間)
      dv.setUint32(i * 18, 0); dv.setUint32(i * 18 + 4, p.sampleNumber >>> 0);
      dv.setUint32(i * 18 + 8, Math.floor(p.streamOffset / 4294967296));
      dv.setUint32(i * 18 + 12, p.streamOffset >>> 0);
      dv.setUint16(i * 18 + 16, p.frameSamples);
    }
    return b;
  }

  // ── 符号化本体 ────────────────────────────────────────────────────────
  const BLOCKSIZE_CODE = new Map([
    [192, 1], [576, 2], [1152, 3], [2304, 4], [4608, 5],
    [256, 8], [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13], [16384, 14], [32768, 15],
  ]);
  const RATE_CODE = new Map([
    [88200, 1], [176400, 2], [192000, 3], [8000, 4], [16000, 5], [22050, 6],
    [24000, 7], [32000, 8], [44100, 9], [48000, 10], [96000, 11],
  ]);
  const BPS_CODE = new Map([[8, 1], [12, 2], [16, 4], [20, 5], [24, 6], [32, 7]]);

  const SUBFRAME_CONSTANT = 0b000000;
  const SUBFRAME_VERBATIM = 0b000001;
  const SUBFRAME_FIXED = 0b001000;   // | order
  const SUBFRAME_LPC = 0b100000;     // | (order - 1)

  const MAX_LPC_ORDER = 12;
  const QLP_PRECISION = 15;
  const MAX_QLP_SHIFT = 15;

  /** Tukey(0.5)窓。libFLACが自己相関の前に既定で掛けるもの */
  function tukeyWindow(n, alpha) {
    alpha = alpha === undefined ? 0.5 : alpha;
    const w = new Float64Array(n);
    const edge = (alpha * (n - 1)) / 2;
    for (let i = 0; i < n; i++) {
      if (i < edge) w[i] = 0.5 * (1 + Math.cos(Math.PI * (i / edge - 1)));
      else if (i > n - 1 - edge) w[i] = 0.5 * (1 + Math.cos(Math.PI * ((i - (n - 1 - edge)) / edge)));
      else w[i] = 1;
    }
    return w;
  }

  // Levinson-Durbin。lpcOut[order-1]にその次数の係数、errOut[order-1]に予測誤差。
  // 保存時に符号を反転しているのは pred = Σ coef[j]*x[n-1-j] の形で使うため(libFLACと同じ)
  function levinson(autoc, maxOrder, lpcOut, errOut) {
    const a = new Float64Array(maxOrder);
    let err = autoc[0];
    for (let i = 0; i < maxOrder; i++) {
      let r = -autoc[i + 1];
      for (let j = 0; j < i; j++) r -= a[j] * autoc[i - j];
      r /= err;
      a[i] = r;
      for (let j = 0; j < (i >> 1); j++) {
        const tmp = a[j];
        a[j] += r * a[i - 1 - j];
        a[i - 1 - j] += r * tmp;
      }
      if (i & 1) a[i >> 1] += a[i >> 1] * r;
      err *= (1 - r * r);
      const dst = lpcOut[i];
      for (let j = 0; j <= i; j++) dst[j] = -a[j];
      errOut[i] = err;
      if (!(err > 0)) return i + 1;
    }
    return maxOrder;
  }

  // 実数係数 → 格納用の整数。丸め誤差を次の係数へ送ると素の四捨五入より確実に縮む
  function quantizeLpc(coef, order, precision, out) {
    let cmax = 0;
    for (let i = 0; i < order; i++) { const v = Math.abs(coef[i]); if (v > cmax) cmax = v; }
    if (!(cmax > 0)) return null;
    let shift = precision - 1 - Math.floor(Math.log2(cmax)) - 1;
    if (shift > MAX_QLP_SHIFT) shift = MAX_QLP_SHIFT;
    if (shift < 0) return null;
    const qmax = (1 << (precision - 1)) - 1;
    const qmin = -(1 << (precision - 1));
    const scale = Math.pow(2, shift);
    let error = 0;
    for (let i = 0; i < order; i++) {
      error += coef[i] * scale;
      let q = Math.round(error);
      if (q > qmax) q = qmax; else if (q < qmin) q = qmin;
      error -= q;
      out[i] = q;
    }
    return shift;
  }

  // residual[i] = x[i] - (Σ qlp[j]*x[i-1-j] >> shift)
  // ★シフトは必ず算術シフト(Math.floor)。デコーダ側がそうなので、切り捨てにすると
  //   合計が負のときだけ食い違って可逆でなくなる
  function lpcResidual(x, n, order, qlp, shift, out) {
    const scale = Math.pow(2, shift);
    for (let i = order; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < order; j++) sum += qlp[j] * x[i - 1 - j];
      out[i] = x[i] - Math.floor(sum / scale);
    }
  }

  /** count個の残差(絶対値の合計sumAbs)をRice符号化したときのおおよそのビット数 */
  function riceEstimate(sumAbs, count) {
    if (count <= 0) return 0;
    const sumU = 2 * sumAbs;
    let k = 0;
    while (k < 30 && count * Math.pow(2, k) < sumU) k++;
    return count * (k + 1) + Math.floor(sumU / Math.pow(2, k));
  }

  function bestFixed(x, n, bps) {
    if (n < 5) return { order: 0, bits: n * bps };
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 4; i < n; i++) {
      const a = x[i], b = x[i - 1], c = x[i - 2], d = x[i - 3], e = x[i - 4];
      const r1 = a - b, r2 = r1 - (b - c), r3 = r2 - ((b - c) - (c - d));
      const r4 = r3 - (((b - c) - (c - d)) - ((c - d) - (d - e)));
      s0 += a < 0 ? -a : a;
      s1 += r1 < 0 ? -r1 : r1;
      s2 += r2 < 0 ? -r2 : r2;
      s3 += r3 < 0 ? -r3 : r3;
      s4 += r4 < 0 ? -r4 : r4;
    }
    const cnt = n - 4, sums = [s0, s1, s2, s3, s4];
    let order = 0, bits = Infinity;
    for (let p = 0; p <= 4; p++) {
      const c = p * bps + riceEstimate(sums[p], cnt);
      if (c < bits) { bits = c; order = p; }
    }
    return { order, bits };
  }

  function fixedResidual(x, n, p, out) {
    switch (p) {
      case 0: for (let i = 0; i < n; i++) out[i] = x[i]; break;
      case 1: for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1]; break;
      case 2: for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: for (let i = 3; i < n; i++) out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      case 4: for (let i = 4; i < n; i++) out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
    }
  }

  function bestRiceParam(u, s, e) {
    const n = e - s;
    if (n <= 0) return { k: 0, bits: 0 };
    let sum = 0;
    for (let i = s; i < e; i++) sum += u[i];
    let k = 0;
    while (k < 30 && n * Math.pow(2, k) < sum) k++;
    let bestK = 0, bestBits = Infinity;
    for (let kk = Math.max(0, k - 1); kk <= Math.min(30, k + 1); kk++) {
      let bits = n * (kk + 1);
      for (let i = s; i < e; i++) bits += u[i] >>> kk;
      if (bits < bestBits) { bestBits = bits; bestK = kk; }
    }
    return { k: bestK, bits: bestBits };
  }

  class FlacEncoder {
    constructor(o) {
      o = o || {};
      const sampleRate = o.sampleRate || 44100;
      const channels = o.channels || 2;
      const bitsPerSample = o.bitsPerSample || 16;
      const blockSize = o.blockSize || 4096;
      if (!BPS_CODE.has(bitsPerSample)) throw new Error('未対応のビット深度 ' + bitsPerSample);
      if (!BLOCKSIZE_CODE.has(blockSize)) throw new Error('未対応のブロックサイズ ' + blockSize);
      if (!(sampleRate > 0 && sampleRate < 1048576)) throw new Error('未対応のサンプルレート ' + sampleRate);
      this.sampleRate = sampleRate;
      this.channels = channels;
      this.bitsPerSample = bitsPerSample;
      this.blockSize = blockSize;
      this.maxPartitionOrder = o.maxPartitionOrder === undefined ? 6 : o.maxPartitionOrder;
      this.onFrame = o.onFrame;
      this.maxLpcOrder = o.maxLpcOrder === undefined ? MAX_LPC_ORDER
        : Math.max(0, Math.min(MAX_LPC_ORDER, o.maxLpcOrder));

      this.ch = [];
      for (let i = 0; i < channels; i++) this.ch.push(new Int32Array(blockSize));
      this.mid = new Int32Array(blockSize);
      this.side = new Int32Array(blockSize);
      this.res = new Int32Array(blockSize);
      this.u = new Uint32Array(blockSize);
      this.scratch = new Int32Array(blockSize);
      this.paramsA = new Int32Array(1 << this.maxPartitionOrder);
      this.paramsB = new Int32Array(1 << this.maxPartitionOrder);
      this.bw = new BitWriter(blockSize * channels * 4 + 1024);
      this.window = tukeyWindow(blockSize);
      this.winBuf = new Float64Array(blockSize);
      this.autoc = new Float64Array(MAX_LPC_ORDER + 1);
      this.lpcSets = [];
      for (let i = 0; i < MAX_LPC_ORDER; i++) this.lpcSets.push(new Float64Array(MAX_LPC_ORDER));
      this.lpcErr = new Float64Array(MAX_LPC_ORDER);
      this.qlp = new Int32Array(MAX_LPC_ORDER);
      this.shortWindow = null; this.shortWindowN = -1;

      this.fill = 0;
      this.frameNumber = 0;
      this.totalSamples = 0;
      this.minFrameSize = 0xffffff;
      this.maxFrameSize = 0;
      this.md5 = new Md5();
      // レートが表に無いときはフレームヘッダのコードを0(=STREAMINFOを見よ)にする。
      // streamable subsetからは外れるが、どのデコーダも読める正当なFLACではある
      this.rateCode = RATE_CODE.has(sampleRate) ? RATE_CODE.get(sampleRate) : 0;
    }

    /** インターリーブされた16bit LEのPCM(Uint8Array)を流し込む */
    write(pcmBytes) {
      this.md5.update(pcmBytes);
      let src;
      if ((pcmBytes.byteOffset & 1) === 0) {
        src = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length >> 1);
      } else {
        src = new Int16Array(new Uint8Array(pcmBytes).buffer);
      }
      const nch = this.channels;
      let frames = (src.length / nch) | 0, off = 0;
      while (frames > 0) {
        const take = Math.min(frames, this.blockSize - this.fill);
        for (let c = 0; c < nch; c++) {
          const dst = this.ch[c];
          for (let i = 0, p = off * nch + c; i < take; i++, p += nch) dst[this.fill + i] = src[p];
        }
        this.fill += take; off += take; frames -= take;
        if (this.fill === this.blockSize) this._emitBlock(this.blockSize);
      }
    }

    finish() {
      if (this.fill > 0) this._emitBlock(this.fill);
      return this.getStreamInfo();
    }

    getStreamInfo() {
      return streamInfo({
        minBlockSize: this.blockSize, maxBlockSize: this.blockSize,
        minFrameSize: this.minFrameSize === 0xffffff ? 0 : this.minFrameSize,
        maxFrameSize: this.maxFrameSize,
        sampleRate: this.sampleRate, channels: this.channels,
        bitsPerSample: this.bitsPerSample, totalSamples: this.totalSamples,
        md5: this.md5Digest || new Uint8Array(16),
      });
    }

    _emitBlock(n) {
      const bw = this.bw;
      bw.reset();
      const bps = this.bitsPerSample;

      // ステレオ相関除去: L/R・L/S・R/S・M/S を見積もって一番安いものを採る
      let assign = this.channels - 1;
      let subs;
      if (this.channels === 2) {
        const L = this.ch[0], R = this.ch[1], M = this.mid, S = this.side;
        for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; M[i] = (l + r) >> 1; S[i] = l - r; }
        const cL = bestFixed(L, n, bps).bits, cR = bestFixed(R, n, bps).bits;
        const cM = bestFixed(M, n, bps).bits, cS = bestFixed(S, n, bps + 1).bits;
        const cand = [
          [cL + cR, 1, [[L, bps], [R, bps]]],
          [cL + cS, 8, [[L, bps], [S, bps + 1]]],
          [cS + cR, 9, [[S, bps + 1], [R, bps]]],
          [cM + cS, 10, [[M, bps], [S, bps + 1]]],
        ];
        let best = cand[0];
        for (const c of cand) if (c[0] < best[0]) best = c;
        assign = best[1]; subs = best[2];
      } else {
        subs = this.ch.map((c) => [c, bps]);
      }

      // フレームヘッダ(ここまで全てバイト境界に乗るのでCRC-8は素のバイト範囲でよい)
      bw.writeBits(0x3ffe, 14);        // 同期
      bw.writeBits(0, 1);              // 予約
      bw.writeBits(0, 1);              // 固定ブロックサイズ
      const bsCode = BLOCKSIZE_CODE.has(n) ? BLOCKSIZE_CODE.get(n) : (n <= 256 ? 6 : 7);
      bw.writeBits(bsCode, 4);
      bw.writeBits(this.rateCode, 4);
      bw.writeBits(assign, 4);
      bw.writeBits(BPS_CODE.get(bps), 3);
      bw.writeBits(0, 1);              // 予約
      bw.writeUtf8(this.frameNumber);
      if (bsCode === 6) bw.writeBits(n - 1, 8);
      else if (bsCode === 7) bw.writeBits(n - 1, 16);
      bw.writeBits(crc8(bw.buf, 0, bw.len), 8);

      for (const s of subs) this._encodeSubframe(bw, s[0], n, s[1]);

      bw.align();
      bw.writeBits(crc16(bw.buf, 0, bw.len), 16);

      const frame = bw.bytes().slice(); // bwは次のブロックで使い回すのでコピー
      if (frame.length < this.minFrameSize) this.minFrameSize = frame.length;
      if (frame.length > this.maxFrameSize) this.maxFrameSize = frame.length;
      this.frameNumber++;
      this.totalSamples += n;
      this.fill = 0;
      if (this.onFrame) this.onFrame(frame, n);
    }

    _encodeSubframe(bw, x, n, bps) {
      let constant = true;
      for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
      if (constant) {
        bw.writeBits(0, 1); bw.writeBits(SUBFRAME_CONSTANT, 6); bw.writeBits(0, 1);
        bw.writeBits(x[0], bps);
        return;
      }

      // 全サンプルが共有する下位の0ビットは捨てても情報が減らない
      let orAll = 0;
      for (let i = 0; i < n; i++) orAll |= x[i];
      let wasted = 0;
      while ((orAll & 1) === 0) { orAll >>>= 1; wasted++; }
      let data = x, ebps = bps;
      if (wasted > 0) {
        const t = this.scratch;
        for (let i = 0; i < n; i++) t[i] = x[i] >> wasted;
        data = t; ebps = bps - wasted;
      }

      const fixed = bestFixed(data, n, ebps);
      const lpc = this.maxLpcOrder > 0 ? this._bestLpc(data, n, ebps) : null;
      const header = (type) => {
        bw.writeBits(0, 1);
        bw.writeBits(type, 6);
        if (wasted) { bw.writeBits(1, 1); bw.writeBits(1, wasted); } // (wasted-1)個の0のあと1
        else bw.writeBits(0, 1);
      };

      const best = (lpc && lpc.bits < fixed.bits) ? lpc : fixed;
      if (best.bits >= n * ebps) { // そのまま書いた方が安い
        header(SUBFRAME_VERBATIM);
        for (let i = 0; i < n; i++) bw.writeBits(data[i], ebps);
        return;
      }

      if (best === lpc) {
        header(SUBFRAME_LPC | (lpc.order - 1));
        for (let i = 0; i < lpc.order; i++) bw.writeBits(data[i], ebps);
        bw.writeBits(QLP_PRECISION - 1, 4);
        bw.writeBits(lpc.shift, 5);
        for (let i = 0; i < lpc.order; i++) bw.writeBits(lpc.qlp[i], QLP_PRECISION);
        lpcResidual(data, n, lpc.order, lpc.qlp, lpc.shift, this.res);
        this._encodeResidual(bw, this.res, n, lpc.order);
        return;
      }

      header(SUBFRAME_FIXED | fixed.order);
      for (let i = 0; i < fixed.order; i++) bw.writeBits(data[i], ebps);
      fixedResidual(data, n, fixed.order, this.res);
      this._encodeResidual(bw, this.res, n, fixed.order);
    }

    _bestLpc(x, n, bps) {
      const maxOrder = Math.min(this.maxLpcOrder, n >> 3);
      if (maxOrder < 1) return null;

      // 最後のブロックだけ短い。全長用の窓の頭を使うと終端が窓掛けされず自己相関が歪むので、
      // 短いブロック用の窓を1つだけ作って使い回す
      let win = this.window;
      if (n !== this.blockSize) {
        if (this.shortWindowN !== n) { this.shortWindow = tukeyWindow(n); this.shortWindowN = n; }
        win = this.shortWindow;
      }
      const d = this.winBuf;
      for (let i = 0; i < n; i++) d[i] = x[i] * win[i];

      const autoc = this.autoc;
      for (let k = 0; k <= maxOrder; k++) {
        let s = 0;
        for (let i = k; i < n; i++) s += d[i] * d[i - k];
        autoc[k] = s;
      }
      if (!(autoc[0] > 0)) return null; // 無音

      const got = levinson(autoc, maxOrder, this.lpcSets, this.lpcErr);

      let bestOrder = 0, bestEst = Infinity;
      for (let o = 1; o <= got; o++) {
        const err = this.lpcErr[o - 1];
        if (!(err > 0)) continue;
        const perSample = Math.max(0, 0.5 * Math.log2(err / n));
        const est = n * (perSample + 1.5) + o * (bps + QLP_PRECISION) + 9;
        if (est < bestEst) { bestEst = est; bestOrder = o; }
      }
      if (!bestOrder) return null;

      const qlp = this.qlp;
      const shift = quantizeLpc(this.lpcSets[bestOrder - 1], bestOrder, QLP_PRECISION, qlp);
      if (shift === null) return null;

      lpcResidual(x, n, bestOrder, qlp, shift, this.res);
      let sumAbs = 0;
      for (let i = bestOrder; i < n; i++) { const v = this.res[i]; sumAbs += v < 0 ? -v : v; }
      const bits = bestOrder * bps + 4 + 5 + bestOrder * QLP_PRECISION
        + riceEstimate(sumAbs, n - bestOrder);
      return { order: bestOrder, qlp, shift, bits };
    }

    _encodeResidual(bw, res, n, order) {
      const u = this.u;
      for (let i = order; i < n; i++) { const v = res[i]; u[i] = ((v << 1) ^ (v >> 31)) >>> 0; }

      let maxPo = 0;
      while (maxPo < this.maxPartitionOrder
        && (n % (1 << (maxPo + 1))) === 0
        && (n >> (maxPo + 1)) > order) maxPo++;

      let bestPo = 0, bestCost = Infinity, bestMethod = 0;
      let cur = this.paramsA, keep = this.paramsB;
      for (let po = 0; po <= maxPo; po++) {
        const parts = 1 << po, psize = n >> po;
        let total = 0, maxK = 0;
        for (let p = 0; p < parts; p++) {
          const s = p === 0 ? order : p * psize;
          const r = bestRiceParam(u, s, (p + 1) * psize);
          cur[p] = r.k; total += r.bits; if (r.k > maxK) maxK = r.k;
        }
        if (maxK > 30) continue;
        const method = maxK <= 14 ? 0 : 1;
        total += parts * (method ? 5 : 4);
        if (total < bestCost) {
          bestCost = total; bestPo = po; bestMethod = method;
          const t = keep; keep = cur; cur = t;
        }
      }
      this.paramsA = cur; this.paramsB = keep;

      bw.writeBits(bestMethod, 2);
      bw.writeBits(bestPo, 4);
      const parts = 1 << bestPo, psize = n >> bestPo, pb = bestMethod ? 5 : 4;
      for (let p = 0; p < parts; p++) {
        const k = keep[p];
        bw.writeBits(k, pb);
        const s = p === 0 ? order : p * psize, e = (p + 1) * psize;
        for (let i = s; i < e; i++) bw.writeRice(u[i], k);
      }
    }
  }

  // ── 公開API ───────────────────────────────────────────────────────────
  function f32ToI16(chans, from, count, gain) {
    const nch = chans.length;
    const out = new Uint8Array(count * nch * 2);
    const dv = new DataView(out.buffer);
    let o = 0;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < nch; c++) {
        let v = chans[c][from + i] * gain;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        // WAV書き出しと同じ丸め(32767倍→四捨五入)。両者の音を突き合わせられるように揃える
        dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
        o += 2;
      }
    }
    return out;
  }

  /**
   * Float32のチャンネル配列をFLACへ符号化して Blob を返す。
   * 長い曲でもUIが固まらないよう、opt.yieldFn(既定=setTimeout 0)で定期的に手を離す。
   */
  async function encode(chans, sampleRate, opt) {
    opt = opt || {};
    const gain = opt.gain === undefined ? 1 : opt.gain;
    const blockSize = opt.blockSize || 4096;
    const total = chans[0] ? chans[0].length : 0;
    const yieldFn = opt.yieldFn || (() => new Promise((r) => setTimeout(r, 0)));

    const frames = [];
    let streamOffset = 0, samplesWritten = 0;
    const seekIntervalSamples = 10 * sampleRate;
    const seekCap = total ? Math.max(1, Math.min(1000, Math.ceil(total / seekIntervalSamples))) : 0;
    const points = [];
    let nextSeekSample = 0;

    const enc = new FlacEncoder({
      sampleRate, channels: chans.length, bitsPerSample: 16, blockSize,
      maxLpcOrder: opt.maxLpcOrder,
      onFrame: (frame, n) => {
        if (points.length < seekCap && samplesWritten >= nextSeekSample) {
          points.push({ sampleNumber: samplesWritten, streamOffset, frameSamples: n });
          nextSeekSample += seekIntervalSamples;
        }
        frames.push(frame);
        streamOffset += frame.length;
        samplesWritten += n;
      },
    });

    // 1回あたり約1秒ぶんずつ流し、その都度進捗を出して手を離す
    const chunk = Math.max(blockSize, sampleRate);
    for (let at = 0; at < total; at += chunk) {
      const take = Math.min(chunk, total - at);
      enc.write(f32ToI16(chans, at, take, gain));
      if (opt.onProgress) opt.onProgress((at + take) / total);
      await yieldFn();
    }
    enc.md5Digest = enc.md5.digest();
    const info = enc.finish();

    const head = [];
    head.push(new TextEncoder().encode('fLaC'));
    head.push(blockHeader(BLOCK.STREAMINFO, STREAMINFO_SIZE, false));
    head.push(info);
    if (seekCap) {
      head.push(blockHeader(BLOCK.SEEKTABLE, seekCap * 18, false));
      // 実際に置けた点だけ埋め、残りは空点のまま(空点も正当なSEEKTABLEの一部)
      const t = seekTable(seekCap);
      const real = seekTable(points);
      t.set(real.subarray(0, Math.min(real.length, t.length)), 0);
      head.push(t);
    }
    const vc = vorbisComment(opt.tags, opt.vendor);
    head.push(blockHeader(BLOCK.VORBIS_COMMENT, vc.length, true), vc);

    // 全部メモリ上で組むので、Node版のような「後からSTREAMINFOを書き戻す」処理は要らない
    return new Blob(head.concat(frames), { type: 'audio/flac' });
  }

  Audio.Flac = { encode, FlacEncoder, Md5 };
})(window);
