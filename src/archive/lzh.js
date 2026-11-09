/*
 * LZH / LHA アーカイブの読み出し MML.Archive(lzh)。zip/7z/RAR と同じ「曲リストの器」に載せる(2026-11-09)。
 *
 * - ヘッダ: レベル 0 / 1 / 2(LHA 2.x 系。日本のレトロ PC 配布物はほぼこのどれか)。拡張ヘッダはファイル名(0x01)とディレクトリ名(0x02、区切り 0xFF)だけ読む。
 *   ファイル名は Shift-JIS → 駄目なら UTF-8 として解釈(日本のアーカイバは SJIS)。
 * - 圧縮法: -lh0-(無圧縮)、-lh4- / -lh5- / -lh6- / -lh7-(LZSS + 静的ハフマン。辞書 4K/8K/32K/64K)。
 *   -lh1-(LHarc 1.x の適応ハフマン)、-lzs-/-lz5-(LArc)、-lhd-(ディレクトリ)は読まない(readEntry が明示エラー)。
 * - 復号は LHa for UNIX の decode/huf.c の流儀(read_pt_len / read_c_len / decode_c / decode_p / make_table)をそのまま JS に。
 *   CRC16(ANSI、多項式 0xA001)を照合し、合わなければエラーにする。
 * 外部ライブラリは使わない(INV-1)。DOM 非依存(INV-4)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Archive = MML.Archive = MML.Archive || {};

  let sjis = null; try { sjis = new TextDecoder('shift_jis'); } catch (e) { sjis = null; }
  const utf8 = new TextDecoder('utf-8');
  function decodeName(b) {
    if (sjis) { try { const s = sjis.decode(b); if (!s.includes('�')) return s; } catch (e) { /* fallthrough */ } }
    return utf8.decode(b);
  }
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  Archive.isLzh = function (bytes) {
    return !!bytes && bytes.length > 22 && bytes[2] === 0x2D && bytes[3] === 0x6C && (bytes[4] === 0x68 || bytes[4] === 0x7A) && bytes[6] === 0x2D; // "-lh?-" / "-lz?-"
  };

  // ヘッダ列を読んでエントリ一覧に。entry = { name, size, compressedSize, method, dataOffset, crc, isDir, lzh: true }
  Archive.parseLzh = function (bytes) {
    const entries = [];
    let p = 0;
    while (p + 21 < bytes.length) {
      const hsize0 = bytes[p];
      if (hsize0 === 0) break; // 終端
      const level = bytes[p + 20];
      const method = String.fromCharCode(bytes[p + 2], bytes[p + 3], bytes[p + 4], bytes[p + 5], bytes[p + 6]);
      let compressedSize = u32(bytes, p + 7), size = u32(bytes, p + 11);
      let name = '', dir = '', dataOffset, crc = -1, next;
      // 拡張ヘッダの鎖: [size][type][data][next size]... size は type+data+次の size 欄を含む(LHa header.c の get_extended_header と同じ)。size=0 で終わり。
      // sizeAt: 最初の size 欄の位置。返り値: 鎖の直後の位置と、size の総和(レベル 1 の圧縮サイズから引く)
      const readExt = (sizeAt, sizeLen) => {
        const rd = (o) => (sizeLen === 2 ? u16(bytes, o) : u32(bytes, o));
        let sz = rd(sizeAt), q = sizeAt + sizeLen, total = 0;
        while (sz !== 0 && q + sz <= bytes.length) {
          total += sz;
          const type = bytes[q], data = bytes.subarray(q + 1, q + sz - sizeLen);
          if (type === 0x01) name = decodeName(data);
          else if (type === 0x02) dir = decodeName(data).replace(/￿|\xFF/g, '/').replace(/\\/g, '/');
          const nextSz = rd(q + sz - sizeLen);
          q += sz; sz = nextSz;
        }
        return { q, total };
      };
      if (level === 0 || level === 1) {
        const nameLen = bytes[p + 21];
        let nb = bytes.subarray(p + 22, p + 22 + nameLen); const nul = nb.indexOf(0); if (nul >= 0) nb = nb.subarray(0, nul); // 古い LHarc は名前の後ろに 0x00 とコメントを付ける
        name = decodeName(nb).replace(/\\/g, '/');
        crc = u16(bytes, p + 22 + nameLen);
        const headerEnd = p + 2 + hsize0; // ヘッダ本体の終わり(レベル 0 はここからデータ。レベル 1 は最初の拡張ヘッダの size 欄が本体の末尾 2 バイト)
        if (level === 0) { dataOffset = headerEnd; next = dataOffset + compressedSize; }
        else { // レベル 1: compressedSize は拡張ヘッダぶんを含む
          const ext = readExt(headerEnd - 2, 2);
          dataOffset = ext.q; compressedSize -= ext.total; next = dataOffset + compressedSize;
        }
      } else if (level === 2) {
        const total = u16(bytes, p);
        crc = u16(bytes, p + 21);
        readExt(p + 24, 2);
        dataOffset = p + total; next = dataOffset + compressedSize;
      } else if (level === 3) {
        const total = u32(bytes, p + 24);
        crc = u16(bytes, p + 21);
        readExt(p + 28, 4);
        dataOffset = p + total; next = dataOffset + compressedSize;
      } else throw new Error('lzh: unknown header level ' + level);
      if (dir && !name.includes('/')) name = dir.endsWith('/') ? dir + name : dir + '/' + name;
      const isDir = method === '-lhd-' || name.endsWith('/');
      entries.push({ name, size, compressedSize, method, dataOffset, crc, isDir, level, lzh: true });
      if (next <= p) break;
      p = next;
    }
    return { type: 'lzh', entries };
  };

  // ── 復号(lh4〜lh7)──
  const NC = 510, NT = 19, THRESHOLD = 3, MAXMATCH = 256;
  const DIC = { '-lh4-': 12, '-lh5-': 13, '-lh6-': 15, '-lh7-': 16 };
  const PBIT = { '-lh4-': 4, '-lh5-': 4, '-lh6-': 5, '-lh7-': 5 };

  function makeCrcTable() { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xA001 : c >>> 1; t[i] = c; } return t; }
  const CRC_TABLE = makeCrcTable();
  function crc16(b) { let c = 0; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return c & 0xFFFF; }

  function decodeLzh(src, outSize, method) {
    const dicbit = DIC[method], pbit = PBIT[method];
    const NP = dicbit + 1;
    const out = new Uint8Array(outSize);
    // ビット読み(16bit のバッファ。LHa の fillbuf/getbits と同じ向き)
    let pos = 0, bitbuf = 0, subbitbuf = 0, bitcount = 0;
    const fillbuf = (n) => {
      bitbuf = (bitbuf << n) & 0xFFFF;
      while (n > bitcount) {
        bitbuf |= (subbitbuf << (n -= bitcount)) & 0xFFFF;
        subbitbuf = pos < src.length ? src[pos++] : 0;
        bitcount = 8;
      }
      bitbuf |= subbitbuf >>> (bitcount -= n);
      bitbuf &= 0xFFFF;
    };
    const getbits = (n) => { const x = bitbuf >>> (16 - n); fillbuf(n); return x; };
    fillbuf(16);
    const left = new Uint16Array(2 * NC - 1), right = new Uint16Array(2 * NC - 1);
    const c_len = new Uint8Array(NC), pt_len = new Uint8Array(NT > NP ? NT : NP);
    const c_table = new Uint16Array(4096), pt_table = new Uint16Array(256);
    // ハフマン表(LHa の make_table)
    function makeTable(nchar, bitlen, tablebits, table) {
      const count = new Uint16Array(17), weight = new Uint16Array(17), start = new Uint16Array(18);
      for (let i = 0; i < nchar; i++) count[bitlen[i]]++;
      start[1] = 0;
      for (let i = 1; i <= 16; i++) start[i + 1] = (start[i] + (count[i] << (16 - i))) & 0xFFFF;
      // start[17] は 16bit で 0 にならなければ符号長の総和が合わない(LHa の "Bad table")
      let total = 0; for (let i = 1; i <= 16; i++) total += count[i] << (16 - i);
      if ((total & 0xFFFF) !== 0) throw new Error('lzh: bad huffman table');
      const jutbits = 16 - tablebits;
      for (let i = 1; i <= tablebits; i++) { start[i] >>>= jutbits; weight[i] = 1 << (tablebits - i); }
      for (let i = tablebits + 1; i <= 16; i++) weight[i] = 1 << (16 - i);
      let i = start[tablebits + 1] >>> jutbits;
      if (i !== 0) { const k = 1 << tablebits; while (i !== k) table[i++] = 0; }
      let avail = nchar;
      const mask = 1 << (15 - tablebits);
      for (let ch = 0; ch < nchar; ch++) {
        const len = bitlen[ch];
        if (len === 0) continue;
        const nextcode = (start[len] + weight[len]) & 0xFFFF;
        if (len <= tablebits) { for (let j = start[len]; j < (start[len] + weight[len]); j++) table[j] = ch; }
        else {
          // 表より長い符号: 表の枠から left/right の木を辿る(LHa maketbl.c の *p 歩き。arr/idx がポインタ)
          let k = start[len], arr = table, idx = k >>> jutbits, n = len - tablebits;
          while (n !== 0) {
            if (arr[idx] === 0) { right[avail] = left[avail] = 0; arr[idx] = avail++; }
            const node = arr[idx];
            if (k & mask) { arr = right; idx = node; } else { arr = left; idx = node; }
            k = (k << 1) & 0xFFFF; n--;
          }
          arr[idx] = ch;
        }
        start[len] = nextcode;
      }
    }
    function readPtLen(nn, nbit, iSpecial) {
      let n = getbits(nbit);
      if (n === 0) { const c = getbits(nbit); for (let i = 0; i < nn; i++) pt_len[i] = 0; for (let i = 0; i < 256; i++) pt_table[i] = c; return; }
      let i = 0;
      while (i < n) {
        let c = bitbuf >>> 13;
        if (c === 7) { let m = 1 << 12; while (m & bitbuf) { m >>>= 1; c++; } }
        fillbuf(c < 7 ? 3 : c - 3);
        pt_len[i++] = c;
        if (i === iSpecial) { let k = getbits(2); while (--k >= 0) pt_len[i++] = 0; }
      }
      while (i < nn) pt_len[i++] = 0;
      makeTable(nn, pt_len, 8, pt_table);
    }
    function readCLen() {
      let n = getbits(9);
      if (n === 0) { const c = getbits(9); for (let i = 0; i < NC; i++) c_len[i] = 0; for (let i = 0; i < 4096; i++) c_table[i] = c; return; }
      let i = 0;
      while (i < n) {
        let c = pt_table[bitbuf >>> 8];
        if (c >= NT) { let m = 1 << 7; do { c = (bitbuf & m) ? right[c] : left[c]; m >>>= 1; } while (c >= NT); }
        fillbuf(pt_len[c]);
        if (c <= 2) {
          if (c === 0) c = 1; else if (c === 1) c = getbits(4) + 3; else c = getbits(9) + 20;
          while (--c >= 0) c_len[i++] = 0;
        } else c_len[i++] = c - 2;
      }
      while (i < NC) c_len[i++] = 0;
      makeTable(NC, c_len, 12, c_table);
    }
    let blocksize = 0;
    function decodeC() {
      if (blocksize === 0) { blocksize = getbits(16); readPtLen(NT, 5, 3); readCLen(); readPtLen(NP, pbit, -1); }
      blocksize--;
      let j = c_table[bitbuf >>> 4];
      if (j >= NC) { let m = 1 << 3; do { j = (bitbuf & m) ? right[j] : left[j]; m >>>= 1; } while (j >= NC); }
      fillbuf(c_len[j]);
      return j;
    }
    function decodeP() {
      let j = pt_table[bitbuf >>> 8];
      if (j >= NP) { let m = 1 << 7; do { j = (bitbuf & m) ? right[j] : left[j]; m >>>= 1; } while (j >= NP); }
      fillbuf(pt_len[j]);
      if (j !== 0) j = (1 << (j - 1)) + getbits(j - 1);
      return j;
    }
    let o = 0;
    while (o < outSize) {
      const c = decodeC();
      if (c < 256) { out[o++] = c; continue; }
      let len = c - 256 + THRESHOLD;
      const dist = decodeP() + 1;
      let from = o - dist;
      if (from < 0) throw new Error('lzh: bad distance');
      while (len-- > 0 && o < outSize) out[o++] = out[from++];
    }
    void MAXMATCH;
    return out;
  }

  Archive.readLzhEntry = async function (bytes, entry) {
    if (entry.isDir) return new Uint8Array(0);
    const src = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let out;
    if (entry.method === '-lh0-' || entry.method === '-lz4-') out = src.slice();
    else if (DIC[entry.method]) out = decodeLzh(src, entry.size, entry.method);
    else throw new Error('lzh: unsupported method ' + entry.method);
    if (entry.crc >= 0 && crc16(out) !== entry.crc) throw new Error('lzh: CRC mismatch');
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
