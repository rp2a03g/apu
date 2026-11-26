/*
 * CHD(MAME の圧縮ディスクイメージ)の CD を読む
 * MML.Emu.Chd
 *
 * 対応: 版 5、CD 用の圧縮(cdlz = LZMA、cdzl = Deflate、cdfl = FLAC)と無圧縮。親を持つ CHD、版 4 以前、cdzs(Zstandard)は読めない(断る)。
 * DOM 非依存。LZMA は MML.LZMA(archive/lzma.js)を使う。Deflate と FLAC の展開はこの中に持つ(どちらも 1 かたまりずつ同期で解く必要がある)。
 *
 * 出どころ:
 *   [文書] 入れ物の形(見出し 124 バイト、かたまりの表、メタデータの連なり)は MAME の chd.h の冒頭の説明による。
 *   [文書] かたまりの表の圧縮(ハフマン 16 符号+連長、自分と同じ中身・親を指す印)と CD 用の圧縮の並び
 *          (誤り訂正の印 → 本体の長さ → 本体 → サブコード)は MAME の chd.cpp / chdcodec.cpp の作りに合わせた。コードは写していない。
 *   [試験] 手元の chdman で作った CHD(cdlz+cdzl+cdfl の既定、cdzl だけ、cdfl だけ)を、元の bin と 1 バイトずつ比べる(tools/headless/chd-test.js)。
 *
 * CD の 1 フレームは CHD の中で 2448 バイト(2352 の本体+96 のサブコード)。かたまり(ハンク)は 8 フレーム。
 *   音声は CHD の中では上位バイトが先(ビッグエンディアン)。取り出す時に下位が先へ直す。
 *   2352 のデータの同期信号と誤り訂正は、印が立っているフレームでは省かれている。ここでは作り直さない(読むのは頭 16 バイトの後ろの 2048 バイトだけ)。
 *   各トラックは 4 フレームの倍数に詰め物をして並んでいる。
 *
 * 使い方: const chd = Chd.open(bytes);  await Chd.toCdSet(bytes, onProgress) → { kind: 'cue', text, files: [bin 1 個] }(PceDisc.fromSet に渡せる形)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  const u48 = (b, o) => u16(b, o) * 0x100000000 + u32(b, o + 2);
  const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);
  const tag = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
  const TAG_CDLZ = tag('cdlz'), TAG_CDZL = tag('cdzl'), TAG_CDFL = tag('cdfl'), TAG_CDZS = tag('cdzs');
  const tagName = (t) => t ? String.fromCharCode((t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255) : 'none';

  const CD_FRAME = 2448, CD_DATA = 2352, CD_SUB = 96;

  // ── 上位ビットが先のビット列(かたまりの表、FLAC) ──
  class BitsMsb {
    constructor(buf, pos, end) { this.b = buf; this.p = pos; this.end = end; this.acc = 0; this.n = 0; }
    read(count) { // 0〜32 ビット
      let v = 0;
      while (count > 0) {
        if (this.n === 0) { this.acc = this.p < this.end ? this.b[this.p] : 0; this.p++; this.n = 8; }
        const take = count < this.n ? count : this.n;
        v = v * (1 << take) + ((this.acc >> (this.n - take)) & ((1 << take) - 1));
        this.n -= take; count -= take;
      }
      return v;
    }
    readSigned(count) { const v = this.read(count); return count && v >= Math.pow(2, count - 1) ? v - Math.pow(2, count) : v; }
    unary() { let n = 0; while (this.read(1) === 0) { n++; if (this.p > this.end + 4) throw new Error('chd: ビット列が終わっています'); } return n; }
    align() { this.n = 0; }
    get bytePos() { return this.p; } // align の後で: 次に読むバイトの位置
  }

  // ── かたまりの表のハフマン(16 符号、最長 8 ビット。符号長は連長つきで入っている) ──
  function readMapHuffman(bits) {
    const NUM = 16, MAX = 8, lens = new Uint8Array(NUM);
    for (let i = 0; i < NUM;) {
      let nb = bits.read(4);
      if (nb !== 1) { lens[i++] = nb; continue; }
      nb = bits.read(4);
      if (nb === 1) { lens[i++] = 1; continue; }
      let rep = bits.read(4) + 3;
      while (rep-- > 0 && i < NUM) lens[i++] = nb;
    }
    // 符号の割り当て: 長い符号から順に、同じ長さの中では番号順
    const histo = new Uint32Array(33); for (let i = 0; i < NUM; i++) histo[lens[i]]++;
    let cur = 0; for (let l = 32; l > 0; l--) { const next = (cur + histo[l]) >> 1; histo[l] = cur; cur = next; }
    const table = new Uint16Array(1 << MAX).fill(0xFFFF);
    for (let i = 0; i < NUM; i++) {
      const l = lens[i]; if (!l) continue;
      const code = histo[l]++, sh = MAX - l;
      for (let k = code << sh; k < ((code + 1) << sh); k++) table[k] = (i << 4) | l;
    }
    return () => {
      // 8 ビット先読みの代わりに、1 ビットずつ足して引き当てる(表は小さいので十分)
      let code = 0;
      for (let l = 1; l <= MAX; l++) {
        code = (code << 1) | bits.read(1);
        const e = table[code << (MAX - l)];
        if (e !== 0xFFFF && (e & 15) === l) return e >> 4;
      }
      throw new Error('chd: かたまりの表が壊れています');
    };
  }

  // ── Deflate(生。zlib の見出しなし) ──
  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  // 符号長の並びから引き当て表を作る。表[下位 max ビット] = 記号 << 4 | 長さ(符号はビットを逆順にして入れる)
  function buildInflateTable(lens, n) {
    let max = 0; const count = new Uint16Array(16);
    for (let i = 0; i < n; i++) { count[lens[i]]++; if (lens[i] > max) max = lens[i]; }
    if (max === 0) return { table: new Uint32Array(1), max: 0 };
    const next = new Uint16Array(16); let code = 0; count[0] = 0;
    for (let l = 1; l <= max; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
    const table = new Uint32Array(1 << max);
    for (let i = 0; i < n; i++) {
      const l = lens[i]; if (!l) continue;
      let c = next[l]++, rev = 0; for (let k = 0; k < l; k++) { rev = (rev << 1) | (c & 1); c >>= 1; }
      for (let k = rev; k < (1 << max); k += (1 << l)) table[k] = (i << 4) | l;
    }
    return { table, max };
  }
  let FIXED_LIT = null, FIXED_DIST = null;
  function inflateRaw(src, pos, end, out, outPos, outEnd) {
    let buf = 0, cnt = 0;
    const need = (n) => { while (cnt < n) { buf |= (pos < end ? src[pos] : 0) << cnt; pos++; cnt += 8; } };
    const bits = (n) => { if (n === 0) return 0; need(n); const v = buf & ((1 << n) - 1); buf >>>= n; cnt -= n; return v; };
    const sym = (t) => { need(t.max); const e = t.table[buf & ((1 << t.max) - 1)], l = e & 15; if (!l) throw new Error('chd: Deflate の符号が壊れています'); buf >>>= l; cnt -= l; return e >>> 4; };
    for (;;) {
      const last = bits(1), type = bits(2);
      if (type === 0) {
        buf = 0; cnt = 0; // バイトの境目へ(先読みは 1 バイトずつなので、読み過ぎは無い)
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        for (let i = 0; i < len && outPos < outEnd; i++) out[outPos++] = src[pos + i];
        pos += len;
      } else if (type === 1 || type === 2) {
        let lit, dist;
        if (type === 1) {
          if (!FIXED_LIT) {
            const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
            FIXED_LIT = buildInflateTable(l, 288); FIXED_DIST = buildInflateTable(new Uint8Array(30).fill(5), 30);
          }
          lit = FIXED_LIT; dist = FIXED_DIST;
        } else {
          const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          const cl = new Uint8Array(19); for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
          const clt = buildInflateTable(cl, 19), lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const s = sym(clt);
            if (s < 16) lens[i++] = s;
            else { let rep, v = 0; if (s === 16) { v = lens[i - 1]; rep = 3 + bits(2); } else if (s === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep-- > 0 && i < hlit + hdist) lens[i++] = v; }
          }
          lit = buildInflateTable(lens.subarray(0, hlit), hlit); dist = buildInflateTable(lens.subarray(hlit), hdist);
        }
        for (;;) {
          const s = sym(lit);
          if (s < 256) { if (outPos < outEnd) out[outPos] = s; outPos++; continue; }
          if (s === 256) break;
          const len = LEN_BASE[s - 257] + bits(LEN_EXTRA[s - 257]);
          const ds = sym(dist), d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
          for (let i = 0; i < len; i++) { if (outPos < outEnd) out[outPos] = out[outPos - d]; outPos++; }
        }
      } else throw new Error('chd: Deflate のかたまりの種類が不正です');
      if (last) break;
    }
    return outPos;
  }

  // ── FLAC(見出しなしでフレームが並ぶ。ステレオ 16 ビット)。out に上位バイトが先で書き、読んだ所までの位置を返す ──
  const FLAC_BLOCK = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  function flacSubframe(br, bps, n, out) {
    br.read(1);
    const type = br.read(6);
    let wasted = 0; if (br.read(1)) { wasted = br.unary() + 1; bps -= wasted; }
    if (type === 0) { const v = br.readSigned(bps); for (let i = 0; i < n; i++) out[i] = v; }
    else if (type === 1) { for (let i = 0; i < n; i++) out[i] = br.readSigned(bps); }
    else if ((type >= 8 && type <= 12) || type >= 32) {
      const order = type >= 32 ? type - 31 : type - 8;
      for (let i = 0; i < order; i++) out[i] = br.readSigned(bps);
      let coef = null, shift = 0;
      if (type >= 32) { const prec = br.read(4) + 1; shift = br.readSigned(5); coef = new Array(order); for (let i = 0; i < order; i++) coef[i] = br.readSigned(prec); }
      // 残差
      const method = br.read(2), pbits = method === 0 ? 4 : 5, esc = method === 0 ? 15 : 31;
      const po = br.read(4), parts = 1 << po;
      let i = order;
      for (let p = 0; p < parts; p++) {
        const cnt = (n >> po) - (p === 0 ? order : 0), k = br.read(pbits);
        if (k === esc) { const nb = br.read(5); for (let j = 0; j < cnt; j++) out[i++] = nb ? br.readSigned(nb) : 0; }
        else for (let j = 0; j < cnt; j++) { const q = br.unary(), u = q * (1 << k) + (k ? br.read(k) : 0); out[i++] = (u & 1) ? -((u + 1) / 2) : u / 2; }
      }
      // 予測を足す
      if (type >= 32) {
        const div = Math.pow(2, shift);
        for (let j = order; j < n; j++) { let sum = 0; for (let c = 0; c < order; c++) sum += coef[c] * out[j - 1 - c]; out[j] += Math.floor(sum / div); }
      } else if (order === 1) { for (let j = 1; j < n; j++) out[j] += out[j - 1]; }
      else if (order === 2) { for (let j = 2; j < n; j++) out[j] += 2 * out[j - 1] - out[j - 2]; }
      else if (order === 3) { for (let j = 3; j < n; j++) out[j] += 3 * out[j - 1] - 3 * out[j - 2] + out[j - 3]; }
      else if (order === 4) { for (let j = 4; j < n; j++) out[j] += 4 * out[j - 1] - 6 * out[j - 2] + 4 * out[j - 3] - out[j - 4]; }
    } else throw new Error('chd: FLAC の小枠の種類が不正です');
    if (wasted) { const m = 1 << wasted; for (let i = 0; i < n; i++) out[i] *= m; }
  }
  function flacDecode(src, pos, end, out, outPos, samples) {
    const br = new BitsMsb(src, pos, end);
    const ch0 = new Float64Array(65536), ch1 = new Float64Array(65536);
    let done = 0;
    while (done < samples) {
      if (br.read(14) !== 0x3FFE) throw new Error('chd: FLAC のフレームの頭が見つかりません');
      br.read(2);
      const bsCode = br.read(4), srCode = br.read(4), chCode = br.read(4), szCode = br.read(3); br.read(1);
      // 通し番号(UTF-8 と同じ可変長)
      { let lead = br.read(8), extra = 0; while (lead & 0x80) { lead = (lead << 1) & 0xFF; extra++; } for (let i = 1; i < extra; i++) br.read(8); }
      let n = FLAC_BLOCK[bsCode];
      if (bsCode === 6) n = br.read(8) + 1; else if (bsCode === 7) n = br.read(16) + 1;
      if (srCode === 12) br.read(8); else if (srCode === 13 || srCode === 14) br.read(16);
      br.read(8); // CRC-8
      if (!n || szCode !== 4 || chCode < 1 || chCode > 10) throw new Error('chd: FLAC の形が想定と違います(ステレオ 16 ビットのみ)');
      const a = ch0.subarray(0, n), b = ch1.subarray(0, n);
      flacSubframe(br, 16 + (chCode === 9 ? 1 : 0), n, a);
      flacSubframe(br, 16 + (chCode === 8 || chCode === 10 ? 1 : 0), n, b);
      br.align(); br.read(16); // CRC-16
      for (let i = 0; i < n && done < samples; i++, done++) {
        let l = a[i], r = b[i];
        if (chCode === 8) r = l - r;            // 左+差
        else if (chCode === 9) l = l + r;       // 差+右
        else if (chCode === 10) { const side = r; let mid = l * 2 + (side & 1); l = (mid + side) / 2; r = (mid - side) / 2; }
        out[outPos++] = (l >> 8) & 0xFF; out[outPos++] = l & 0xFF; out[outPos++] = (r >> 8) & 0xFF; out[outPos++] = r & 0xFF;
      }
    }
    return br.bytePos;
  }

  // ── 入れ物 ──
  class Chd {
    constructor(bytes) {
      const b = this.bytes = bytes;
      if (b.length < 124 || String.fromCharCode.apply(null, b.subarray(0, 8)) !== 'MComprHD') throw new Error('chd: CHD ではありません');
      const version = u32(b, 12);
      if (version !== 5) throw new Error('chd: 版 ' + version + ' は読めません(版 5 だけ。chdman で作り直してください)');
      this.compressors = [u32(b, 16), u32(b, 20), u32(b, 24), u32(b, 28)];
      this.logicalBytes = u64(b, 32);
      const mapOffset = u64(b, 40); this.metaOffset = u64(b, 48);
      this.hunkBytes = u32(b, 56); this.unitBytes = u32(b, 60);
      for (let i = 104; i < 124; i++) if (b[i]) throw new Error('chd: 親の CHD が要る物は読めません');
      this.hunkCount = Math.ceil(this.logicalBytes / this.hunkBytes);
      for (const c of this.compressors) {
        if (c === TAG_CDZS) throw new Error('chd: 圧縮 cdzs(Zstandard)は読めません(chdman createcd -c cdlz,cdzl,cdfl で作り直してください)');
        if (c && c !== TAG_CDLZ && c !== TAG_CDZL && c !== TAG_CDFL) throw new Error('chd: CD の CHD ではありません(圧縮 ' + tagName(c) + ')');
      }
      this._readMap(mapOffset);
      this._readMeta();
      this._tmp = new Uint8Array((this.hunkBytes / CD_FRAME) * CD_DATA);
    }

    _readMap(mapOffset) {
      const b = this.bytes, n = this.hunkCount;
      const comp = this.mapComp = new Uint8Array(n), off = this.mapOffset = new Float64Array(n), len = this.mapLength = new Uint32Array(n);
      if (!this.compressors[0]) { // 無圧縮: 4 バイトずつ「何かたまり目に置いてあるか」
        for (let i = 0; i < n; i++) { comp[i] = 4; off[i] = u32(b, mapOffset + i * 4) * this.hunkBytes; len[i] = this.hunkBytes; }
        return;
      }
      const mapBytes = u32(b, mapOffset), first = u48(b, mapOffset + 4), lengthBits = b[mapOffset + 12], selfBits = b[mapOffset + 13], parentBits = b[mapOffset + 14];
      const bits = new BitsMsb(b, mapOffset + 16, mapOffset + 16 + mapBytes), next = readMapHuffman(bits);
      let lastComp = 0, rep = 0;
      for (let i = 0; i < n; i++) {
        if (rep > 0) { comp[i] = lastComp; rep--; continue; }
        const v = next();
        if (v === 7) { comp[i] = lastComp; rep = 2 + next(); }
        else if (v === 8) { comp[i] = lastComp; rep = 2 + 16 + (next() << 4); rep += next(); }
        else comp[i] = lastComp = v;
      }
      let cur = first, lastSelf = 0;
      for (let i = 0; i < n; i++) {
        switch (comp[i]) {
          case 0: case 1: case 2: case 3: off[i] = cur; len[i] = bits.read(lengthBits); cur += len[i]; bits.read(16); break;
          case 4: off[i] = cur; len[i] = this.hunkBytes; cur += len[i]; bits.read(16); break;
          case 5: lastSelf = off[i] = bits.read(selfBits); break;
          case 10: lastSelf++; /* そのまま下へ */
          case 9: comp[i] = 5; off[i] = lastSelf; break;
          case 6: case 11: case 12: case 13: throw new Error('chd: 親の CHD が要る物は読めません');
          default: throw new Error('chd: かたまりの表に知らない種類があります(' + comp[i] + ')');
        }
      }
    }

    _readMeta() {
      const b = this.bytes; this.meta = [];
      for (let o = this.metaOffset, guard = 0; o && o + 16 <= b.length && guard < 1000; guard++) {
        const t = u32(b, o), length = (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7], next = u64(b, o + 8);
        let text = ''; for (let i = 0; i < length; i++) { const c = b[o + 16 + i]; if (c) text += String.fromCharCode(c); }
        this.meta.push({ tag: tagName(t), text });
        o = next;
      }
    }

    /** かたまり i を out(hunkBytes ぶん)へ。CD の並び(2352 の本体+96 のサブコード × フレーム数)。音声は上位バイトが先のまま */
    readHunk(i, out) {
      const b = this.bytes, type = this.mapComp[i], off = this.mapOffset[i], hb = this.hunkBytes;
      if (type === 4) { out.set(b.subarray(off, off + hb)); return; }
      if (type === 5) { this.readHunk(off, out); return; }
      const codec = this.compressors[type], frames = hb / CD_FRAME, len = this.mapLength[i], tmp = this._tmp;
      let subAt;
      if (codec === TAG_CDFL) {
        subAt = flacDecode(b, off, off + len, tmp, 0, frames * CD_DATA / 4);
      } else {
        const ecc = (frames + 7) >> 3, lb = hb < 65536 ? 2 : 3;
        let baseLen = (b[off + ecc] << 8) | b[off + ecc + 1]; if (lb > 2) baseLen = (baseLen << 8) | b[off + ecc + 2];
        const at = off + ecc + lb;
        if (codec === TAG_CDLZ) tmp.set(MML.LZMA.decodeLzma1(LZMA_PROPS, b, at, baseLen, frames * CD_DATA));
        else inflateRaw(b, at, at + baseLen, tmp, 0, frames * CD_DATA);
        subAt = at + baseLen;
      }
      const sub = this._sub || (this._sub = new Uint8Array(frames * CD_SUB));
      inflateRaw(b, subAt, off + len, sub, 0, frames * CD_SUB);
      for (let f = 0; f < frames; f++) {
        out.set(tmp.subarray(f * CD_DATA, (f + 1) * CD_DATA), f * CD_FRAME);
        out.set(sub.subarray(f * CD_SUB, (f + 1) * CD_SUB), f * CD_FRAME + CD_DATA);
      }
    }

    /** CD のトラックの表(メタデータ CHT2 / CHTR)。[{ number, type, frames, pregap, pgType, postgap, chdFrame(CHD の中の始まりのフレーム) }] */
    cdTracks() {
      const out = []; let at = 0;
      for (const m of this.meta) {
        if (m.tag !== 'CHT2' && m.tag !== 'CHTR') continue;
        const f = {}; m.text.trim().split(/\s+/).forEach(kv => { const k = kv.indexOf(':'); if (k > 0) f[kv.slice(0, k)] = kv.slice(k + 1); });
        const frames = parseInt(f.FRAMES, 10) || 0;
        out.push({ number: parseInt(f.TRACK, 10), type: f.TYPE || '', frames, pregap: parseInt(f.PREGAP, 10) || 0, pgType: f.PGTYPE || '', postgap: parseInt(f.POSTGAP, 10) || 0, chdFrame: at });
        at += Math.ceil(frames / 4) * 4; // トラックごとに 4 フレームの倍数へ詰めてある
      }
      if (!out.length) throw new Error('chd: CD のトラックの表がありません(CD の CHD ではありません)');
      return out;
    }
  }
  const LZMA_PROPS = new Uint8Array([0x5D]); // lc=3 lp=0 pb=2(MAME の LZMA の決まった設定)

  const msf = (fr) => { const p = (v) => String(v).padStart(2, '0'); return p(Math.floor(fr / 4500)) + ':' + p(Math.floor(fr / 75) % 60) + ':' + p(fr % 75); };

  /**
   * CD の CHD を全部展開して、cue と 1 個のデータ(全トラックを 2352 バイトずつ並べた物)の組にする(PceDisc.fromSet に渡せる形)。
   * 目次の計算を cue の読み方(cdImage.js。Mesen と突き合わせ済み)に任せるため、「bin 1 個+cue」と同じ形に組み立てて渡す。
   *   2048 バイトのデータのトラック(MODE1)は、2352 の枠の 16 バイト目から置いて MODE1/2352 として渡す(読むのはその 2048 バイトだけ)。
   *   前置き(プリギャップ)は、CHD の中に実物がある時(PGTYPE が V で始まる)は INDEX 00 と INDEX 01、無い時は PREGAP。
   * 展開は重い(数百 MB)ので、onProgress(済んだ割合 0〜1)を呼びながら、時々ブラウザへ手を返す。
   */
  Chd.toCdSet = async function (bytes, onProgress) {
    const chd = new Chd(bytes), tracks = chd.cdTracks(), hb = chd.hunkBytes, per = hb / CD_FRAME, hunk = new Uint8Array(hb);
    const total = tracks.reduce((x, t) => x + t.frames, 0); let done = 0, lastYield = Date.now();
    const data = new Uint8Array(total * CD_DATA);
    let text = 'FILE "disc.bin" BINARY\n', pos = 0;
    for (const t of tracks) {
      const audio = t.type === 'AUDIO', cooked = t.type === 'MODE1' || t.type === 'MODE2_FORM1';
      if (!audio && !cooked && t.type !== 'MODE1_RAW' && t.type !== 'MODE2_RAW') throw new Error('chd: トラック ' + t.number + ' の種類(' + t.type + ')は読めません');
      let cur = -1;
      for (let f = 0; f < t.frames; f++) {
        const g = t.chdFrame + f, h = Math.floor(g / per);
        if (h !== cur) { chd.readHunk(h, hunk); cur = h; }
        const src = (g % per) * CD_FRAME, dst = (pos + f) * CD_DATA;
        if (audio) { for (let k = 0; k < CD_DATA; k += 2) { data[dst + k] = hunk[src + k + 1]; data[dst + k + 1] = hunk[src + k]; } }
        else if (cooked) data.set(hunk.subarray(src, src + 2048), dst + 16);
        else data.set(hunk.subarray(src, src + CD_DATA), dst);
        if ((++done & 255) === 0 && Date.now() - lastYield > 60) { if (onProgress) onProgress(done / total); await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
      }
      text += '  TRACK ' + String(t.number).padStart(2, '0') + ' ' + (audio ? 'AUDIO' : 'MODE1/2352') + '\n';
      const inData = t.pgType.charAt(0) === 'V' && t.pregap > 0 && t.pregap < t.frames;
      if (inData) text += '    INDEX 00 ' + msf(pos) + '\n    INDEX 01 ' + msf(pos + t.pregap) + '\n';
      else { if (t.pregap > 0) text += '    PREGAP ' + msf(t.pregap) + '\n'; text += '    INDEX 01 ' + msf(pos) + '\n'; }
      pos += t.frames;
    }
    if (onProgress) onProgress(1);
    return { kind: 'cue', text, files: [{ name: 'disc.bin', data }], names: ['disc.bin'] };
  };
  Chd.open = (bytes) => new Chd(bytes);
  Chd.isChd = (bytes) => bytes && bytes.length >= 8 && String.fromCharCode.apply(null, bytes.subarray(0, 8)) === 'MComprHD';
  Chd._inflateRaw = inflateRaw; // 試験用

  Emu.Chd = Chd;
})(typeof window !== 'undefined' ? window : globalThis);
