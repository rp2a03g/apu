/*
 * LZMA / LZMA2 展開器(7zアーカイブ用)
 * MML.LZMA
 *
 * 7zの圧縮方式はLZMA/LZMA2が既定で、zipと違いブラウザ標準の DecompressionStream では
 * 解けない。外部ライブラリは使わない方針(INV-1)なので、LZMA SDK(public domain)の
 * 展開部だけをJSへ移植した。圧縮は行わない。DOM非依存(INV-4)。
 *
 * 実装メモ:
 *  - 辞書窓は出力バッファそのもの(7zは展開後サイズがヘッダに書かれているので先に確保できる)。
 *    リングバッファが要らないぶん素直に書ける。LZMA2の辞書リセットは dictStart で表す。
 *  - レンジデコーダの range/code は32bit符号無し。JSのビット演算(符号付き32bit)では壊れる
 *    ため、通常のNumber(倍精度=53bit整数まで正確)で持ち、code < range の不変条件のもとで
 *    乗算による桁上げ(<<8 の代わりに *256)を使う。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const LZMA = MML.LZMA = MML.LZMA || {};

  const kNumBitModelTotalBits = 11;
  const kBitModelTotal = 1 << kNumBitModelTotalBits;
  const kNumMoveBits = 5;
  const kTopValue = 1 << 24;

  const kNumPosBitsMax = 4;
  const kNumLenToPosStates = 4;
  const kNumAlignBits = 4;
  const kEndPosModelIndex = 14;
  const kNumFullDistances = 1 << (kEndPosModelIndex >> 1);
  const kMatchMinLen = 2;

  // 長さデコーダのprob配列レイアウト(1本のUint16Arrayに詰める)
  const LEN_CHOICE = 0, LEN_CHOICE2 = 1, LEN_LOW = 2, LEN_MID = 130, LEN_HIGH = 258, LEN_SIZE = 514;

  class RangeDecoder {
    constructor(buf, pos, end) { this.buf = buf; this.pos = pos; this.end = end; this.range = 0; this.code = 0; }
    nextByte() { return this.pos < this.end ? this.buf[this.pos++] : 0; }
    init() {
      const first = this.nextByte();
      if (first !== 0) throw new Error('lzma: bad range coder header');
      this.range = 4294967295;
      this.code = 0;
      for (let i = 0; i < 4; i++) this.code = this.code * 256 + this.nextByte();
      if (this.code >= this.range) throw new Error('lzma: bad range coder init');
    }
    normalize() {
      while (this.range < kTopValue) { this.range *= 256; this.code = this.code * 256 + this.nextByte(); }
    }
    decodeBit(probs, i) {
      const prob = probs[i];
      const bound = (this.range >>> kNumBitModelTotalBits) * prob;
      let sym;
      if (this.code < bound) {
        this.range = bound;
        probs[i] = prob + ((kBitModelTotal - prob) >>> kNumMoveBits);
        sym = 0;
      } else {
        this.range -= bound;
        this.code -= bound;
        probs[i] = prob - (prob >>> kNumMoveBits);
        sym = 1;
      }
      this.normalize();
      return sym;
    }
    decodeDirectBits(numBits) {
      let res = 0;
      for (let i = 0; i < numBits; i++) {
        this.range = Math.floor(this.range / 2);
        let bit = 0;
        if (this.code >= this.range) { this.code -= this.range; bit = 1; }
        this.normalize();
        res = res * 2 + bit;
      }
      return res;
    }
    bitTreeDecode(probs, off, numBits) {
      let m = 1;
      for (let i = 0; i < numBits; i++) m = (m << 1) | this.decodeBit(probs, off + m);
      return m - (1 << numBits);
    }
    bitTreeReverseDecode(probs, off, numBits) {
      let m = 1, sym = 0;
      for (let i = 0; i < numBits; i++) {
        const bit = this.decodeBit(probs, off + m);
        m = (m << 1) | bit;
        sym |= bit << i;
      }
      return sym;
    }
  }

  class LzmaDecoder {
    /** @param {Uint8Array} out 出力バッファ(辞書窓を兼ねる) */
    constructor(out) {
      this.out = out;
      this.outPos = 0;
      this.dictStart = 0; // 辞書リセット位置(ここより前は参照できない)
      this.lc = 3; this.lp = 0; this.pb = 2;
      this.litProbs = null;
      this.isMatch = new Uint16Array(12 << kNumPosBitsMax);
      this.isRep = new Uint16Array(12);
      this.isRepG0 = new Uint16Array(12);
      this.isRepG1 = new Uint16Array(12);
      this.isRepG2 = new Uint16Array(12);
      this.isRep0Long = new Uint16Array(12 << kNumPosBitsMax);
      this.posSlotProbs = new Uint16Array(kNumLenToPosStates << 6);
      this.posProbs = new Uint16Array(1 + kNumFullDistances - kEndPosModelIndex);
      this.alignProbs = new Uint16Array(1 << kNumAlignBits);
      this.lenProbs = new Uint16Array(LEN_SIZE);
      this.repLenProbs = new Uint16Array(LEN_SIZE);
      this.state = 0;
      this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    }

    /** プロパティバイト(lc/lp/pbをまとめた1バイト)を設定する */
    setProps(d) {
      if (d >= 9 * 5 * 5) throw new Error('lzma: bad properties byte');
      this.lc = d % 9; d = (d / 9) | 0;
      this.lp = d % 5;
      this.pb = (d / 5) | 0;
      this.litProbs = new Uint16Array(0x300 << (this.lc + this.lp));
    }

    resetState() {
      const half = kBitModelTotal >>> 1;
      const all = [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2,
        this.isRep0Long, this.posSlotProbs, this.posProbs, this.alignProbs,
        this.lenProbs, this.repLenProbs];
      for (const a of all) a.fill(half);
      if (!this.litProbs) throw new Error('lzma: properties not set');
      this.litProbs.fill(half);
      this.state = 0;
      this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    }

    decodeLen(rc, probs, posState) {
      if (rc.decodeBit(probs, LEN_CHOICE) === 0) return rc.bitTreeDecode(probs, LEN_LOW + (posState << 3), 3);
      if (rc.decodeBit(probs, LEN_CHOICE2) === 0) return 8 + rc.bitTreeDecode(probs, LEN_MID + (posState << 3), 3);
      return 16 + rc.bitTreeDecode(probs, LEN_HIGH, 8);
    }

    /** out[outPos] から limit まで展開する。戻り値=終端マーカーに達したか。 */
    decode(rc, limit) {
      const out = this.out;
      const pbMask = (1 << this.pb) - 1;
      const lpMask = (1 << this.lp) - 1;
      const lc = this.lc;
      while (this.outPos < limit) {
        const pos = this.outPos - this.dictStart;
        const posState = pos & pbMask;
        const state = this.state;
        if (rc.decodeBit(this.isMatch, (state << kNumPosBitsMax) + posState) === 0) {
          // リテラル
          const prevByte = pos > 0 ? out[this.outPos - 1] : 0;
          const off = 0x300 * (((pos & lpMask) << lc) + (prevByte >>> (8 - lc)));
          const probs = this.litProbs;
          let symbol = 1;
          if (state >= 7) {
            if (this.rep0 >= pos) throw new Error('lzma: distance out of range');
            let matchByte = out[this.outPos - this.rep0 - 1];
            do {
              const matchBit = (matchByte >> 7) & 1;
              matchByte = (matchByte << 1) & 0xFF;
              const bit = rc.decodeBit(probs, off + ((1 + matchBit) << 8) + symbol);
              symbol = (symbol << 1) | bit;
              if (matchBit !== bit) break;
            } while (symbol < 0x100);
          }
          while (symbol < 0x100) symbol = (symbol << 1) | rc.decodeBit(probs, off + symbol);
          out[this.outPos++] = symbol & 0xFF;
          this.state = state < 4 ? 0 : (state < 10 ? state - 3 : state - 6);
          continue;
        }
        let len;
        if (rc.decodeBit(this.isRep, state) !== 0) {
          // 直近の距離を再利用するマッチ
          if (pos === 0) throw new Error('lzma: rep match at stream start');
          if (rc.decodeBit(this.isRepG0, state) === 0) {
            if (rc.decodeBit(this.isRep0Long, (state << kNumPosBitsMax) + posState) === 0) {
              this.state = state < 7 ? 9 : 11;
              if (this.rep0 >= pos) throw new Error('lzma: distance out of range');
              out[this.outPos] = out[this.outPos - this.rep0 - 1];
              this.outPos++;
              continue;
            }
          } else {
            let dist;
            if (rc.decodeBit(this.isRepG1, state) === 0) dist = this.rep1;
            else {
              if (rc.decodeBit(this.isRepG2, state) === 0) dist = this.rep2;
              else { dist = this.rep3; this.rep3 = this.rep2; }
              this.rep2 = this.rep1;
            }
            this.rep1 = this.rep0;
            this.rep0 = dist;
          }
          len = this.decodeLen(rc, this.repLenProbs, posState);
          this.state = state < 7 ? 8 : 11;
        } else {
          // 新しい距離のマッチ
          this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0;
          len = this.decodeLen(rc, this.lenProbs, posState);
          this.state = state < 7 ? 7 : 10;
          const lenToPosState = len < kNumLenToPosStates ? len : kNumLenToPosStates - 1;
          const posSlot = rc.bitTreeDecode(this.posSlotProbs, lenToPosState << 6, 6);
          let dist;
          if (posSlot < 4) dist = posSlot;
          else {
            const numDirect = (posSlot >> 1) - 1;
            dist = (2 | (posSlot & 1)) * Math.pow(2, numDirect);
            if (posSlot < kEndPosModelIndex) {
              dist += rc.bitTreeReverseDecode(this.posProbs, dist - posSlot, numDirect);
            } else {
              dist += rc.decodeDirectBits(numDirect - kNumAlignBits) * (1 << kNumAlignBits);
              dist += rc.bitTreeReverseDecode(this.alignProbs, 0, kNumAlignBits);
            }
          }
          if (dist === 4294967295) return true; // 終端マーカー
          this.rep0 = dist;
        }
        len += kMatchMinLen;
        if (this.rep0 >= pos) throw new Error('lzma: distance out of range');
        if (this.outPos + len > limit) len = limit - this.outPos;
        let src = this.outPos - this.rep0 - 1;
        for (let i = 0; i < len; i++) out[this.outPos++] = out[src++];
      }
      return false;
    }
  }

  /**
   * LZMA1(7zのcoder 030101)を展開する。
   * @param {Uint8Array} props 5バイトのcoderプロパティ(先頭=lc/lp/pb、以降=辞書サイズ)
   */
  LZMA.decodeLzma1 = function (props, input, inOff, inLen, outSize) {
    if (!props || props.length < 1) throw new Error('lzma: missing properties');
    const out = new Uint8Array(outSize);
    const dec = new LzmaDecoder(out);
    dec.setProps(props[0]);
    dec.resetState();
    const rc = new RangeDecoder(input, inOff, inOff + inLen);
    rc.init();
    dec.decode(rc, outSize);
    if (dec.outPos !== outSize) throw new Error('lzma: truncated stream');
    return out;
  };

  /** LZMA2(7zのcoder 21)を展開する。チャンク列(制御バイト先頭)を順に処理する。 */
  LZMA.decodeLzma2 = function (input, inOff, inLen, outSize) {
    const out = new Uint8Array(outSize);
    const dec = new LzmaDecoder(out);
    let p = inOff;
    const end = inOff + inLen;
    let needProps = true, needState = true;
    while (dec.outPos < outSize) {
      if (p >= end) throw new Error('lzma2: unexpected end of data');
      const control = input[p++];
      if (control === 0) break;
      if (control <= 2) {
        // 非圧縮チャンク(1=辞書リセット付き)。この後のLZMAチャンクは必ず状態リセットが要る。
        if (control === 1) dec.dictStart = dec.outPos;
        else if (dec.outPos === 0) throw new Error('lzma2: missing dictionary reset');
        const size = ((input[p] << 8) | input[p + 1]) + 1;
        p += 2;
        if (p + size > end || dec.outPos + size > outSize) throw new Error('lzma2: bad chunk size');
        out.set(input.subarray(p, p + size), dec.outPos);
        dec.outPos += size;
        p += size;
        needState = true;
      } else if (control >= 0x80) {
        const unpackSize = ((control & 0x1F) << 16) + (input[p] << 8) + input[p + 1] + 1;
        const packSize = ((input[p + 2] << 8) | input[p + 3]) + 1;
        p += 4;
        const mode = (control >> 5) & 3;
        if (mode >= 2) { dec.setProps(input[p++]); needProps = false; }
        else if (needProps) throw new Error('lzma2: properties missing');
        if (mode >= 1) { dec.resetState(); needState = false; }
        else if (needState) throw new Error('lzma2: state reset missing');
        if (mode === 3) dec.dictStart = dec.outPos;
        else if (dec.outPos === 0) throw new Error('lzma2: missing dictionary reset');
        if (p + packSize > end || dec.outPos + unpackSize > outSize) throw new Error('lzma2: bad chunk size');
        const rc = new RangeDecoder(input, p, p + packSize);
        rc.init();
        dec.decode(rc, dec.outPos + unpackSize);
        p += packSize;
      } else {
        throw new Error('lzma2: bad control byte 0x' + control.toString(16));
      }
    }
    if (dec.outPos !== outSize) throw new Error('lzma2: truncated stream');
    return out;
  };
})(window);
