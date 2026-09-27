/*
 * RAR(1.5〜4.x 形式)アーカイブのリーダー
 * MML.Archive の RAR 部分(zip側は archive.js、7z側は sevenzip.js)。
 *
 * 用途: SNESmusic.org の SPC 曲集(.rsn = 拡張子を変えただけの RAR3)をはじめ、RAR で配られる
 * 曲集を zip/7z と同じ「曲リストの器」として開く。エントリの形(name/size/isDir)は archive.js の
 * zip エントリと揃えてあり、Archive.buildPlaylist はそのまま共用できる。
 *
 * 対応範囲:
 *  - 書庫形式: RAR 1.5〜4.x(署名 "Rar!\x1a\x07\x00")。RAR5(署名 "Rar!\x1a\x07\x01\x00")は
 *    ヘッダも圧縮方式も別物なので非対応(明示エラー)。
 *  - 圧縮方式: 無圧縮(-m0)と RAR 2.9/3.x/4.x の方式(ファイルヘッダの UNP_VER=29)。
 *    LZ+ハフマン、PPMd(var.H)、定番フィルタ(E8/E8E9/ITANIUM/DELTA/RGB/AUDIO)。
 *    RAR 1.5/2.0 の方式(UNP_VER=15/20/26。RAR 2.x 以前で圧縮したもの)は非対応(明示エラー)。
 *  - ソリッド書庫: 1ファイルを取り出すにはそれより前のファイルを全部展開する必要があるので、
 *    展開した順に中身を控えておき、戻る方向の読み出しは控えから返す。
 *  - 非対応: 暗号化、マルチボリューム、独自VMコードのフィルタ(定番以外)。該当エントリを開こうと
 *    した時に明示エラーにする(黙って壊れたデータを返さない)。展開結果はファイルヘッダの CRC32 と
 *    照合し、合わなければエラーにする。
 *
 * 展開器は unrar(unpack30.cpp / rarvm.cpp / model.cpp / suballoc.cpp)と同じ手順で書いてある。
 * 変数名もなるべくそちらに合わせた(照合しやすくするため)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Archive = MML.Archive = MML.Archive || {};

  const SIG_RAR4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
  const SIG_RAR5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];

  const HEAD_MAIN = 0x73, HEAD_FILE = 0x74, HEAD_END = 0x7b;
  const MHD_VOLUME = 0x0001, MHD_SOLID = 0x0008, MHD_PASSWORD = 0x0080;
  const LHD_SPLIT_BEFORE = 0x01, LHD_SPLIT_AFTER = 0x02, LHD_PASSWORD = 0x04, LHD_SOLID = 0x10;
  const LHD_WINDOWMASK = 0xe0, LHD_DIRECTORY = 0xe0, LHD_LARGE = 0x100, LHD_UNICODE = 0x200;
  const LONG_BLOCK = 0x8000;

  const utf8 = new TextDecoder('utf-8');
  let sjis = null;
  try { sjis = new TextDecoder('shift_jis'); } catch (e) { sjis = null; }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function hasSig(b, sig) {
    if (!b || b.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
    return true;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  Archive._crc32 = crc32;

  Archive.isRar = function (bytes) { return hasSig(bytes, SIG_RAR4) || hasSig(bytes, SIG_RAR5); };

  // ---- ファイル名 ----
  // LHD_UNICODE: 「ASCII(OEM)名 \0 符号化したUnicode名」の2本立て。符号化の解き方は unrar の
  // EncodeFileName::Decode と同じ。
  function decodeUnicodeName(nameBytes, enc) {
    const out = [];
    let encPos = 0;
    const highByte = encPos < enc.length ? enc[encPos++] : 0;
    let flags = 0, flagBits = 0;
    while (encPos < enc.length) {
      if (flagBits === 0) { flags = enc[encPos++]; flagBits = 8; }
      switch (flags >> 6) {
        case 0: out.push(enc[encPos++]); break;
        case 1: out.push(enc[encPos++] + (highByte << 8)); break;
        case 2: out.push(enc[encPos] + (enc[encPos + 1] << 8)); encPos += 2; break;
        case 3: {
          let length = enc[encPos++];
          if (length & 0x80) {
            const correction = enc[encPos++];
            for (length = (length & 0x7f) + 2; length > 0; length--) {
              const d = out.length;
              out.push(((nameBytes[d] + correction) & 0xff) + (highByte << 8));
            }
          } else {
            for (length += 2; length > 0; length--) out.push(nameBytes[out.length] | 0);
          }
          break;
        }
      }
      flags = (flags << 2) & 0xff;
      flagBits -= 2;
    }
    let s = '';
    for (const c of out) s += String.fromCharCode(c);
    return s;
  }
  function decodeName(raw, unicode) {
    if (unicode) {
      const z = raw.indexOf(0);
      if (z >= 0) return decodeUnicodeName(raw.subarray(0, z), raw.subarray(z + 1));
      return utf8.decode(raw); // WinRAR は Unicode 名を UTF-8 で書くこともある(区切り \0 無し)
    }
    // OEM/ANSI コードページ。日本製アーカイバなら Shift-JIS(zip と同じ判定)
    const asUtf8 = utf8.decode(raw);
    return (asUtf8.includes('�') && sjis) ? sjis.decode(raw) : asUtf8;
  }

  /**
   * RAR4 のブロックを辿ってエントリ一覧を返す(データは読まない)。
   * @returns {Promise<{type:'rar', entries:Array}>}
   */
  Archive.parseRar = async function (bytes) {
    if (hasSig(bytes, SIG_RAR5)) throw new Error('RAR5 is not supported (RAR 1.5-4.x only)');
    if (!hasSig(bytes, SIG_RAR4)) throw new Error('not a RAR');
    const ctx = {
      bytes, solid: false, files: [],
      // ソリッド展開の進み具合: 次に展開するファイルの添字と、そこまでの展開器の状態
      nextIndex: 0, unpacker: null, cache: new Map(),
    };
    const entries = [];
    let p = SIG_RAR4.length;
    while (p + 7 <= bytes.length) {
      const type = bytes[p + 2];
      const flags = u16(bytes, p + 3);
      const headSize = u16(bytes, p + 5);
      if (headSize < 7) throw new Error('RAR: bad block header');
      let addSize = (flags & LONG_BLOCK) ? u32(bytes, p + 7) : 0;
      if (type === HEAD_MAIN) {
        if (flags & MHD_PASSWORD) throw new Error('RAR: encrypted headers are not supported');
        if (flags & MHD_VOLUME) ctx.volume = true;
        ctx.solid = !!(flags & MHD_SOLID);
      } else if (type === HEAD_FILE) {
        addSize = u32(bytes, p + 7); // PACK_SIZE(ファイルヘッダは LONG_BLOCK の有無によらずある)
        let packSize = addSize;
        let size = u32(bytes, p + 11);
        const fileCrc = u32(bytes, p + 16);
        const unpVer = bytes[p + 24];
        const method = bytes[p + 25];
        const nameSize = u16(bytes, p + 26);
        let nameOff = p + 32;
        if (flags & LHD_LARGE) {
          const hiPack = u32(bytes, p + 32), hiUnp = u32(bytes, p + 36);
          packSize += hiPack * 0x100000000;
          size += hiUnp * 0x100000000;
          addSize = packSize;
          nameOff += 8;
        }
        const name = decodeName(bytes.subarray(nameOff, nameOff + nameSize), !!(flags & LHD_UNICODE)).replace(/\\/g, '/');
        const isDir = (flags & LHD_WINDOWMASK) === LHD_DIRECTORY;
        const dataStart = p + headSize;
        const file = {
          index: ctx.files.length, name, size, packSize, fileCrc, unpVer, method, flags, dataStart,
          isDir,
          solidFlag: !!(flags & LHD_SOLID),
          encrypted: !!(flags & LHD_PASSWORD),
          split: !!(flags & (LHD_SPLIT_BEFORE | LHD_SPLIT_AFTER)),
        };
        ctx.files.push(file);
        entries.push({ name: isDir && !name.endsWith('/') ? name + '/' : name, size, compressedSize: packSize, isDir, crc: isDir ? null : fileCrc, rar: ctx, rarIndex: file.index });
      } else if (type === HEAD_END) {
        break;
      }
      p += headSize + addSize;
    }
    return { type: 'rar', entries };
  };

  /** エントリの中身を展開して返す。 */
  Archive.readRarEntry = async function (entry) {
    const ctx = entry.rar;
    if (!ctx) throw new Error('RAR: not a RAR entry');
    const file = ctx.files[entry.rarIndex];
    if (file.isDir || file.size === 0) return new Uint8Array(0);
    if (file.encrypted) throw new Error('RAR: encrypted entry');
    if (file.split || ctx.volume) throw new Error('RAR: multi-volume archives are not supported');
    const cached = ctx.cache.get(file.index);
    if (cached) return cached.slice();
    if (file.method === 0x30) return verified(file, ctx.bytes.slice(file.dataStart, file.dataStart + file.packSize));

    // ソリッドの鎖: file より前で LHD_SOLID の無い(=状態を初期化する)ファイルまで遡る
    let start = file.index;
    if (file.solidFlag) {
      while (start > 0 && !(ctx.files[start].solidFlag === false && isPacked(ctx.files[start]))) start--;
    }
    // 途中まで展開済みで同じ鎖の上なら続きから
    let i = start;
    if (ctx.unpacker && ctx.nextIndex > start && ctx.nextIndex <= file.index) i = ctx.nextIndex;
    else ctx.unpacker = null;
    for (; i <= file.index; i++) {
      const f = ctx.files[i];
      if (!isPacked(f)) continue; // ディレクトリ/空/無圧縮は鎖の状態に関わらない
      const solid = i !== start && f.solidFlag;
      if (!solid || !ctx.unpacker) ctx.unpacker = new Unpacker();
      const out = ctx.unpacker.unpackFile(ctx.bytes.subarray(f.dataStart, f.dataStart + f.packSize), f.size, f.unpVer, solid);
      ctx.nextIndex = i + 1;
      if (i === file.index) return verified(f, out);
      if (ctx.solid) ctx.cache.set(i, verifiedOrNull(f, out));
    }
    throw new Error('RAR: internal error');
  };

  function isPacked(f) { return !f.isDir && f.size > 0 && f.method !== 0x30 && !f.encrypted; }
  function verified(f, out) {
    if (crc32(out) !== f.fileCrc) throw new Error('RAR: CRC mismatch (' + f.name + ')');
    return out;
  }
  function verifiedOrNull(f, out) {
    return crc32(out) === f.fileCrc ? out : null;
  }

  // =====================================================================
  // 展開器(RAR 2.9 方式)
  // =====================================================================
  const MAX_WIN_SIZE = 0x400000, MAX_WIN_MASK = MAX_WIN_SIZE - 1;
  const NC = 299, DC = 60, LDC = 17, RC = 28, BC = 20;
  const HUFF_TABLE_SIZE = NC + DC + RC + LDC;
  const LOW_DIST_REP_COUNT = 16;
  const BLOCK_LZ = 0, BLOCK_PPM = 1;

  const LDecode = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224];
  const LBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5];
  const SDDecode = [0, 4, 8, 16, 32, 64, 128, 192];
  const SDBits = [2, 2, 3, 4, 5, 6, 6, 6];
  const DDecode = new Uint32Array(DC), DBits = new Uint8Array(DC);
  (() => {
    const DBitLengthCounts = [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 14, 0, 12];
    let dist = 0, slot = 0;
    for (let bitLength = 0; bitLength < DBitLengthCounts.length; bitLength++) {
      for (let n = 0; n < DBitLengthCounts[bitLength]; n++, slot++, dist += (1 << bitLength)) {
        DDecode[slot] = dist;
        DBits[slot] = bitLength;
      }
    }
  })();

  // ---- ビット入力(MSB 先頭) ----
  class BitInput {
    constructor(data) {
      // 末尾を越えて先読みしても 0 が返るよう余白を付けて写す
      this.buf = new Uint8Array(data.length + 64);
      this.buf.set(data);
      this.size = data.length;
      this.addr = 0;
      this.bit = 0;
    }
    getbits() {
      const b = this.buf, a = this.addr;
      return (((b[a] << 16) | (b[a + 1] << 8) | b[a + 2]) >>> (8 - this.bit)) & 0xffff;
    }
    addbits(n) {
      n += this.bit;
      this.addr += n >> 3;
      this.bit = n & 7;
    }
    getChar() { return this.addr < this.buf.length ? this.buf[this.addr++] : 0; }
    overrun() { return this.addr > this.size; }
  }

  // ---- ハフマン表(unrar の MakeDecodeTables / DecodeNumber と同じ) ----
  class DecodeTable {
    constructor(size) {
      this.maxNum = size;
      this.decodeLen = new Uint32Array(16);
      this.decodePos = new Uint32Array(16);
      this.decodeNum = new Uint16Array(size);
    }
    build(lengths, off, size) {
      const lengthCount = new Uint32Array(16);
      for (let i = 0; i < size; i++) lengthCount[lengths[off + i] & 0xf]++;
      lengthCount[0] = 0;
      this.decodeNum.fill(0);
      this.decodePos[0] = 0;
      this.decodeLen[0] = 0;
      let upperLimit = 0;
      for (let i = 1; i < 16; i++) {
        upperLimit += lengthCount[i];
        this.decodeLen[i] = upperLimit << (16 - i);
        upperLimit *= 2;
        this.decodePos[i] = this.decodePos[i - 1] + lengthCount[i - 1];
      }
      const copyPos = this.decodePos.slice();
      for (let i = 0; i < size; i++) {
        const len = lengths[off + i] & 0xf;
        if (len !== 0) this.decodeNum[copyPos[len]++] = i;
      }
      this.maxNum = size;
    }
    decode(inp) {
      const bitField = inp.getbits() & 0xfffe;
      const dl = this.decodeLen;
      let bits = 15;
      for (let i = 1; i < 15; i++) if (bitField < dl[i]) { bits = i; break; }
      inp.addbits(bits);
      const dist = (bitField - dl[bits - 1]) >>> (16 - bits);
      let pos = this.decodePos[bits] + dist;
      if (pos >= this.maxNum) pos = 0;
      return this.decodeNum[pos];
    }
  }

  // ---- 定番フィルタ(RarVM の標準フィルタ。VM コードは長さで見分ける) ----
  const VMSF_NONE = 0, VMSF_E8 = 1, VMSF_E8E9 = 2, VMSF_ITANIUM = 3, VMSF_RGB = 4, VMSF_AUDIO = 5, VMSF_DELTA = 6;
  // 標準フィルタの VM コードは中身が決まっているので、長さと CRC32 で判別する(unrar の StdList)
  const STD_FILTERS = [
    { len: 53, crc: 0xad576887, type: VMSF_E8 },
    { len: 57, crc: 0x3cd7e57e, type: VMSF_E8E9 },
    { len: 120, crc: 0x3769893f, type: VMSF_ITANIUM },
    { len: 29, crc: 0x0e06077d, type: VMSF_DELTA },
    { len: 149, crc: 0x1c2c5dc8, type: VMSF_RGB },
    { len: 216, crc: 0xbc85e701, type: VMSF_AUDIO },
  ];
  const VM_MEMSIZE = 0x40000;
  const MAX3_UNPACK_FILTERS = 8192;
  const MAX3_UNPACK_CHANNELS = 1024;

  function identifyFilter(code) {
    const crc = crc32(code);
    for (const f of STD_FILTERS) if (f.len === code.length && f.crc === crc) return f.type;
    return VMSF_NONE;
  }

  // RarVM::ReadData
  function vmReadData(inp) {
    let data = inp.getbits();
    switch (data & 0xc000) {
      case 0:
        inp.addbits(6);
        return (data >> 10) & 0xf;
      case 0x4000:
        if ((data & 0x3c00) === 0) {
          data = (0xffffff00 | ((data >> 2) & 0xff)) >>> 0;
          inp.addbits(14);
        } else {
          data = (data >> 6) & 0xff;
          inp.addbits(10);
        }
        return data;
      case 0x8000:
        inp.addbits(2);
        data = inp.getbits();
        inp.addbits(16);
        return data;
      default: {
        inp.addbits(2);
        let d = inp.getbits() * 0x10000;
        inp.addbits(16);
        d += inp.getbits();
        inp.addbits(16);
        return d >>> 0;
      }
    }
  }

  function itaniumGetBits(data, bitPos, bitCount) {
    const inAddr = bitPos >> 3, inBit = bitPos & 7;
    let bitField = (data[inAddr] | (data[inAddr + 1] << 8) | (data[inAddr + 2] << 16) | (data[inAddr + 3] << 24)) >>> 0;
    bitField >>>= inBit;
    return (bitField & (0xffffffff >>> (32 - bitCount))) >>> 0;
  }
  /**
   * 標準フィルタを実行する。mem は VM メモリ(VM_MEMSIZE+4)。戻り値は {data, size}。
   * R: InitR(R[0..6])。
   */
  function executeStdFilter(type, mem, R) {
    switch (type) {
      case VMSF_E8: case VMSF_E8E9: {
        const dataSize = R[4], fileOffset = R[6] >>> 0;
        if (dataSize > VM_MEMSIZE || dataSize < 4) return null;
        const FILE_SIZE = 0x1000000;
        const cmpByte2 = type === VMSF_E8E9 ? 0xe9 : 0xe8;
        for (let curPos = 0; curPos < dataSize - 4;) {
          const curByte = mem[curPos++];
          if (curByte === 0xe8 || curByte === cmpByte2) {
            const offset = (curPos + fileOffset) >>> 0;
            const addr = (mem[curPos] | (mem[curPos + 1] << 8) | (mem[curPos + 2] << 16) | (mem[curPos + 3] << 24)) >>> 0;
            let nv = -1;
            if (addr & 0x80000000) {
              if (((addr + offset) & 0x80000000) === 0) nv = (addr + FILE_SIZE) >>> 0;
            } else if (((addr - FILE_SIZE) & 0x80000000) !== 0) {
              nv = (addr - offset) >>> 0;
            }
            if (nv >= 0) {
              mem[curPos] = nv & 0xff; mem[curPos + 1] = (nv >>> 8) & 0xff;
              mem[curPos + 2] = (nv >>> 16) & 0xff; mem[curPos + 3] = (nv >>> 24) & 0xff;
            }
            curPos += 4;
          }
        }
        return { off: 0, size: dataSize };
      }
      case VMSF_ITANIUM: {
        const dataSize = R[4];
        let fileOffset = R[6] >>> 0;
        if (dataSize > VM_MEMSIZE || dataSize < 21) return null;
        const MASKS = [4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];
        fileOffset >>>= 4;
        for (let curPos = 0; curPos < dataSize - 21; curPos += 16, fileOffset++) {
          const b = (mem[curPos] & 0x1f) - 0x10;
          if (b >= 0) {
            const cmdMask = MASKS[b];
            if (cmdMask !== 0) {
              const d = mem.subarray(curPos);
              for (let i = 0; i <= 2; i++) {
                if (cmdMask & (1 << i)) {
                  const startPos = i * 41 + 5;
                  const opType = itaniumGetBits(d, startPos + 37, 4);
                  if (opType === 5) {
                    const offset = itaniumGetBits(d, startPos + 13, 20);
                    itaniumSetBitsExact(d, ((offset - fileOffset) & 0xfffff) >>> 0, startPos + 13, 20);
                  }
                }
              }
            }
          }
        }
        return { off: 0, size: dataSize };
      }
      case VMSF_DELTA: {
        const dataSize = R[4], channels = R[0];
        if (dataSize > VM_MEMSIZE / 2 || channels > MAX3_UNPACK_CHANNELS || channels === 0) return null;
        let srcPos = 0;
        const border = dataSize * 2;
        for (let ch = 0; ch < channels; ch++) {
          let prevByte = 0;
          for (let destPos = dataSize + ch; destPos < border; destPos += channels) {
            prevByte = (prevByte - mem[srcPos++]) & 0xff;
            mem[destPos] = prevByte;
          }
        }
        return { off: dataSize, size: dataSize };
      }
      case VMSF_RGB: {
        const dataSize = R[4], width = (R[0] - 3) >>> 0, posR = R[1];
        if (dataSize > VM_MEMSIZE / 2 || dataSize < 3 || width > dataSize || posR > 2) return null;
        const dest = dataSize;
        let src = 0;
        for (let ch = 0; ch < 3; ch++) {
          let prevByte = 0;
          for (let i = ch; i < dataSize; i += 3) {
            let predicted;
            if (i >= width + 3) {
              const upper = dest + i - width;
              const upperByte = mem[upper];
              const upperLeftByte = mem[upper - 3];
              predicted = prevByte + upperByte - upperLeftByte;
              const pa = Math.abs(predicted - prevByte);
              const pb = Math.abs(predicted - upperByte);
              const pc = Math.abs(predicted - upperLeftByte);
              if (pa <= pb && pa <= pc) predicted = prevByte;
              else if (pb <= pc) predicted = upperByte;
              else predicted = upperLeftByte;
            } else predicted = prevByte;
            prevByte = (predicted - mem[src++]) & 0xff;
            mem[dest + i] = prevByte;
          }
        }
        for (let i = posR, border = dataSize - 2; i < border; i += 3) {
          const g = mem[dest + i + 1];
          mem[dest + i] = (mem[dest + i] + g) & 0xff;
          mem[dest + i + 2] = (mem[dest + i + 2] + g) & 0xff;
        }
        return { off: dataSize, size: dataSize };
      }
      case VMSF_AUDIO: {
        const dataSize = R[4], channels = R[0];
        if (dataSize > VM_MEMSIZE / 2 || channels > MAX3_UNPACK_CHANNELS || channels === 0) return null;
        const dest = dataSize;
        let src = 0;
        for (let ch = 0; ch < channels; ch++) {
          let prevByte = 0, prevDelta = 0;
          const dif = [0, 0, 0, 0, 0, 0, 0];
          let d1 = 0, d2 = 0, d3;
          let k1 = 0, k2 = 0, k3 = 0;
          for (let i = ch, byteCount = 0; i < dataSize; i += channels, byteCount++) {
            d3 = d2;
            d2 = prevDelta - d1;
            d1 = prevDelta;
            let predicted = 8 * prevByte + k1 * d1 + k2 * d2 + k3 * d3;
            predicted = (predicted >> 3) & 0xff;
            const curByte = mem[src++];
            predicted = (predicted - curByte) & 0xff;
            mem[dest + i] = predicted;
            prevDelta = ((predicted - prevByte) << 24) >> 24;
            prevByte = predicted;
            const d = ((curByte << 24) >> 24) * 8;
            dif[0] += Math.abs(d);
            dif[1] += Math.abs(d - d1);
            dif[2] += Math.abs(d + d1);
            dif[3] += Math.abs(d - d2);
            dif[4] += Math.abs(d + d2);
            dif[5] += Math.abs(d - d3);
            dif[6] += Math.abs(d + d3);
            if ((byteCount & 0x1f) === 0) {
              let minDif = dif[0], numMinDif = 0;
              dif[0] = 0;
              for (let j = 1; j < 7; j++) {
                if (dif[j] < minDif) { minDif = dif[j]; numMinDif = j; }
                dif[j] = 0;
              }
              switch (numMinDif) {
                case 1: if (k1 >= -16) k1--; break;
                case 2: if (k1 < 16) k1++; break;
                case 3: if (k2 >= -16) k2--; break;
                case 4: if (k2 < 16) k2++; break;
                case 5: if (k3 >= -16) k3--; break;
                case 6: if (k3 < 16) k3++; break;
              }
            }
          }
        }
        return { off: dataSize, size: dataSize };
      }
    }
    return null;
  }

  // unrar の FilterItanium_SetBits(ビット単位で書き戻す。マスクは 32bit で回す)
  function itaniumSetBitsExact(data, bitField, bitPos, bitCount) {
    const inAddr = bitPos >> 3, inBit = bitPos & 7;
    let andMask = (~(((0xffffffff >>> (32 - bitCount)) << inBit) >>> 0)) >>> 0;
    bitField = (bitField << inBit) >>> 0;
    for (let i = 0; i < 4; i++) {
      data[inAddr + i] &= andMask & 0xff;
      data[inAddr + i] |= bitField & 0xff;
      andMask = ((andMask >>> 8) | 0xff000000) >>> 0;
      bitField >>>= 8;
    }
  }

  // ---- 展開器本体 ----
  class Unpacker {
    constructor() {
      this.window = new Uint8Array(MAX_WIN_SIZE);
      this.unpPtr = 0;
      this.wrPtr = 0;
      this.oldDist = [0, 0, 0, 0];
      this.lastLength = 0;
      this.prevLowDist = 0;
      this.lowDistRepCount = 0;
      this.LD = new DecodeTable(NC);
      this.DD = new DecodeTable(DC);
      this.LDD = new DecodeTable(LDC);
      this.RD = new DecodeTable(RC);
      this.BD = new DecodeTable(BC);
      this.unpOldTable = new Uint8Array(HUFF_TABLE_SIZE);
      this.tablesRead = false;
      this.blockType = BLOCK_LZ;
      this.ppmEscChar = 2;
      this.ppm = null;
      // フィルタ
      this.filters = [];          // Filters30: 定義(種類)
      this.oldFilterLengths = [];
      this.lastFilter = 0;
      this.prgStack = [];
      this.vmMem = new Uint8Array(VM_MEMSIZE + 4);
    }

    /**
     * 1ファイル分を展開する。solid=true なら直前のファイルの状態(窓・表・PPMモデル)を引き継ぐ。
     */
    unpackFile(packed, destSize, unpVer, solid) {
      this.inp = new BitInput(packed);
      this.out = new Uint8Array(destSize);
      this.destUnpSize = destSize;
      this.writtenFileSize = 0;
      if (unpVer === 29 || unpVer === 36) {
        this.unpack29(solid);
      } else {
        throw new Error('RAR: unsupported compression version ' + unpVer);
      }
      return this.out;
    }

    // ---- 出力 ----
    unpWriteData(src, off, size) {
      if (this.writtenFileSize < this.destUnpSize) {
        const n = Math.min(size, this.destUnpSize - this.writtenFileSize);
        this.out.set(src.subarray(off, off + n), this.writtenFileSize);
      }
      this.writtenFileSize += size;
    }
    unpWriteArea(startPtr, endPtr) {
      if (endPtr !== startPtr) this.unpSomeRead = true;
      if (endPtr < startPtr) {
        this.unpWriteData(this.window, startPtr, MAX_WIN_SIZE - startPtr);
        this.unpWriteData(this.window, 0, endPtr);
      } else {
        this.unpWriteData(this.window, startPtr, endPtr - startPtr);
      }
    }

    // ---- RAR 2.9 ----
    initData29(solid) {
      if (!solid) {
        this.oldDist.fill(0);
        this.lastLength = 0;
        this.unpPtr = this.wrPtr = 0;
        this.window.fill(0);
        this.tablesRead = false;
        this.unpOldTable.fill(0);
        this.ppmEscChar = 2;
        this.blockType = BLOCK_LZ;
      }
      this.initFilters(solid);
    }
    initFilters(solid) {
      if (!solid) {
        this.oldFilterLengths = [];
        this.lastFilter = 0;
        this.filters = [];
      }
      this.prgStack = [];
    }

    insertOldDist(d) {
      const o = this.oldDist;
      o[3] = o[2]; o[2] = o[1]; o[1] = o[0]; o[0] = d;
    }
    copyString(length, distance) {
      const w = this.window;
      let dst = this.unpPtr, src = (dst - distance) & MAX_WIN_MASK;
      while (length-- > 0) {
        w[dst] = w[src];
        dst = (dst + 1) & MAX_WIN_MASK;
        src = (src + 1) & MAX_WIN_MASK;
      }
      this.unpPtr = dst;
    }

    unpack29(solid) {
      this.initData29(solid);
      const inp = this.inp;
      if (this.ppm) this.ppm.inp = inp; // ソリッドで PPM が続く場合、レンジコーダは新しいファイルの頭から読む
      if ((!solid || !this.tablesRead) && !this.readTables30()) return;
      const w = this.window;
      for (;;) {
        this.unpPtr &= MAX_WIN_MASK;
        if (inp.overrun()) break;
        if (((this.wrPtr - this.unpPtr) & MAX_WIN_MASK) < 260 && this.wrPtr !== this.unpPtr) {
          this.unpWriteBuf30();
          if (this.writtenFileSize > this.destUnpSize) return;
        }
        if (this.blockType === BLOCK_PPM) {
          const ch = this.ppm.decodeChar();
          if (ch === -1) {
            this.ppm.cleanUp();
            this.blockType = BLOCK_LZ;
            break;
          }
          if (ch === this.ppmEscChar) {
            const nextCh = this.ppm.decodeChar();
            if (nextCh === 0) { if (!this.readTables30()) break; continue; }
            if (nextCh === 2 || nextCh === -1) break;
            if (nextCh === 3) { if (!this.readVMCodePPM()) break; continue; }
            if (nextCh === 4) {
              let distance = 0, length = 0, failed = false;
              for (let i = 0; i < 4 && !failed; i++) {
                const c = this.ppm.decodeChar();
                if (c === -1) failed = true;
                else if (i === 3) length = c;
                else distance = (distance << 8) + c;
              }
              if (failed) break;
              this.copyString(length + 32, distance + 2);
              continue;
            }
            if (nextCh === 5) {
              const length = this.ppm.decodeChar();
              if (length === -1) break;
              this.copyString(length + 4, 1);
              continue;
            }
            // nextCh === 1 など: エスケープ文字そのものを出力する
          }
          w[this.unpPtr++] = ch;
          continue;
        }

        let number = this.LD.decode(inp);
        if (number < 256) {
          w[this.unpPtr++] = number;
          continue;
        }
        if (number >= 271) {
          number -= 271;
          let length = LDecode[number] + 3;
          let bits = LBits[number];
          if (bits > 0) { length += inp.getbits() >>> (16 - bits); inp.addbits(bits); }
          const distNumber = this.DD.decode(inp);
          let distance = DDecode[distNumber] + 1;
          bits = DBits[distNumber];
          if (bits > 0) {
            if (distNumber > 9) {
              if (bits > 4) {
                distance += (inp.getbits() >>> (20 - bits)) << 4;
                inp.addbits(bits - 4);
              }
              if (this.lowDistRepCount > 0) {
                this.lowDistRepCount--;
                distance += this.prevLowDist;
              } else {
                const lowDist = this.LDD.decode(inp);
                if (lowDist === 16) {
                  this.lowDistRepCount = LOW_DIST_REP_COUNT - 1;
                  distance += this.prevLowDist;
                } else {
                  distance += lowDist;
                  this.prevLowDist = lowDist;
                }
              }
            } else {
              distance += inp.getbits() >>> (16 - bits);
              inp.addbits(bits);
            }
          }
          if (distance >= 0x2000) {
            length++;
            if (distance >= 0x40000) length++;
          }
          this.insertOldDist(distance);
          this.lastLength = length;
          this.copyString(length, distance);
          continue;
        }
        if (number === 256) {
          if (!this.readEndOfBlock()) break;
          continue;
        }
        if (number === 257) {
          if (!this.readVMCode()) break;
          continue;
        }
        if (number === 258) {
          if (this.lastLength !== 0) this.copyString(this.lastLength, this.oldDist[0]);
          continue;
        }
        if (number < 263) {
          const distNum = number - 259;
          const o = this.oldDist;
          const distance = o[distNum];
          for (let i = distNum; i > 0; i--) o[i] = o[i - 1];
          o[0] = distance;
          const lengthNumber = this.RD.decode(inp);
          let length = LDecode[lengthNumber] + 2;
          const bits = LBits[lengthNumber];
          if (bits > 0) { length += inp.getbits() >>> (16 - bits); inp.addbits(bits); }
          this.lastLength = length;
          this.copyString(length, distance);
          continue;
        }
        if (number < 272) {
          number -= 263;
          let distance = SDDecode[number] + 1;
          const bits = SDBits[number];
          if (bits > 0) { distance += inp.getbits() >>> (16 - bits); inp.addbits(bits); }
          this.insertOldDist(distance);
          this.lastLength = 2;
          this.copyString(2, distance);
          continue;
        }
      }
      this.unpWriteBuf30();
    }

    readEndOfBlock() {
      const inp = this.inp;
      const bitField = inp.getbits();
      let newTable, newFile = false;
      if (bitField & 0x8000) {
        newTable = true;
        inp.addbits(1);
      } else {
        newFile = true;
        newTable = (bitField & 0x4000) !== 0;
        inp.addbits(2);
      }
      this.tablesRead = !newTable;
      if (newFile) return false;
      return !newTable || this.readTables30();
    }

    readTables30() {
      const inp = this.inp;
      inp.addbits((8 - inp.bit) & 7);
      const bitField = inp.getbits();
      if (bitField & 0x8000) {
        this.blockType = BLOCK_PPM;
        if (!Archive._RarPPM) throw new Error('RAR: PPMd compression is not supported');
        if (!this.ppm) this.ppm = new Archive._RarPPM();
        const r = this.ppm.decodeInit(inp);
        if (r.escChar !== undefined) this.ppmEscChar = r.escChar;
        return r.ok;
      }
      this.blockType = BLOCK_LZ;
      this.prevLowDist = 0;
      this.lowDistRepCount = 0;
      if (!(bitField & 0x4000)) this.unpOldTable.fill(0);
      inp.addbits(2);

      const bitLength = new Uint8Array(BC);
      for (let i = 0; i < BC; i++) {
        const length = inp.getbits() >>> 12;
        inp.addbits(4);
        if (length === 15) {
          let zeroCount = inp.getbits() >>> 12;
          inp.addbits(4);
          if (zeroCount === 0) bitLength[i] = 15;
          else {
            zeroCount += 2;
            while (zeroCount-- > 0 && i < BC) bitLength[i++] = 0;
            i--;
          }
        } else bitLength[i] = length;
      }
      this.BD.build(bitLength, 0, BC);

      const table = new Uint8Array(HUFF_TABLE_SIZE);
      for (let i = 0; i < HUFF_TABLE_SIZE;) {
        if (inp.overrun()) return false;
        const number = this.BD.decode(inp);
        if (number < 16) {
          table[i] = (number + this.unpOldTable[i]) & 0xf;
          i++;
        } else if (number < 18) {
          let n;
          if (number === 16) { n = (inp.getbits() >>> 13) + 3; inp.addbits(3); }
          else { n = (inp.getbits() >>> 9) + 11; inp.addbits(7); }
          if (i === 0) return false;
          while (n-- > 0 && i < HUFF_TABLE_SIZE) { table[i] = table[i - 1]; i++; }
        } else {
          let n;
          if (number === 18) { n = (inp.getbits() >>> 13) + 3; inp.addbits(3); }
          else { n = (inp.getbits() >>> 9) + 11; inp.addbits(7); }
          while (n-- > 0 && i < HUFF_TABLE_SIZE) table[i++] = 0;
        }
      }
      this.tablesRead = true;
      if (inp.overrun()) return false;
      this.LD.build(table, 0, NC);
      this.DD.build(table, NC, DC);
      this.LDD.build(table, NC + DC, LDC);
      this.RD.build(table, NC + DC + LDC, RC);
      this.unpOldTable.set(table);
      return true;
    }

    readVMCode() {
      const inp = this.inp;
      const firstByte = inp.getbits() >>> 8;
      inp.addbits(8);
      let length = (firstByte & 7) + 1;
      if (length === 7) { length = (inp.getbits() >>> 8) + 7; inp.addbits(8); }
      else if (length === 8) { length = inp.getbits(); inp.addbits(16); }
      if (length === 0) return false;
      const code = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        if (inp.overrun()) return false;
        code[i] = inp.getbits() >>> 8;
        inp.addbits(8);
      }
      return this.addVMCode(firstByte, code);
    }
    readVMCodePPM() {
      const ppm = this.ppm;
      const firstByte = ppm.decodeChar();
      if (firstByte === -1) return false;
      let length = (firstByte & 7) + 1;
      if (length === 7) {
        const b1 = ppm.decodeChar();
        if (b1 === -1) return false;
        length = b1 + 7;
      } else if (length === 8) {
        const b1 = ppm.decodeChar();
        if (b1 === -1) return false;
        const b2 = ppm.decodeChar();
        if (b2 === -1) return false;
        length = b1 * 256 + b2;
      }
      if (length === 0) return false;
      const code = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        const ch = ppm.decodeChar();
        if (ch === -1) return false;
        code[i] = ch;
      }
      return this.addVMCode(firstByte, code);
    }

    addVMCode(firstByte, code) {
      const vin = new BitInput(code);
      let filtPos;
      if (firstByte & 0x80) {
        filtPos = vmReadData(vin);
        if (filtPos === 0) this.initFilters(false);
        else filtPos--;
      } else {
        filtPos = this.lastFilter;
      }
      if (filtPos > this.filters.length || filtPos > this.oldFilterLengths.length) return false;
      this.lastFilter = filtPos;
      const newFilter = filtPos === this.filters.length;

      const stackFilter = { parentFilter: 0, blockStart: 0, blockLength: 0, nextWindow: false, initR: new Uint32Array(7), type: VMSF_NONE };
      let filter;
      if (newFilter) {
        if (filtPos > MAX3_UNPACK_FILTERS) return false;
        filter = { type: VMSF_NONE };
        this.filters.push(filter);
        stackFilter.parentFilter = this.filters.length - 1;
        this.oldFilterLengths.push(0);
      } else {
        filter = this.filters[filtPos];
        stackFilter.parentFilter = filtPos;
      }

      // 使い終わった(null の)枠を詰めてから末尾に積む
      const stack = this.prgStack.filter(f => f !== null);
      if (stack.length > MAX3_UNPACK_FILTERS) return false;
      stack.push(stackFilter);
      this.prgStack = stack;

      let blockStart = vmReadData(vin);
      if (firstByte & 0x40) blockStart += 258;
      stackFilter.blockStart = (blockStart + this.unpPtr) & MAX_WIN_MASK;
      if (firstByte & 0x20) {
        stackFilter.blockLength = vmReadData(vin);
        this.oldFilterLengths[filtPos] = stackFilter.blockLength;
      } else {
        stackFilter.blockLength = filtPos < this.oldFilterLengths.length ? this.oldFilterLengths[filtPos] : 0;
      }
      stackFilter.nextWindow = this.wrPtr !== this.unpPtr && ((this.wrPtr - this.unpPtr) & MAX_WIN_MASK) <= blockStart;

      stackFilter.initR[4] = stackFilter.blockLength;
      if (firstByte & 0x10) {
        const initMask = vin.getbits() >>> 9;
        vin.addbits(7);
        for (let i = 0; i < 7; i++) if (initMask & (1 << i)) stackFilter.initR[i] = vmReadData(vin);
      }

      if (newFilter) {
        const vmCodeSize = vmReadData(vin);
        if (vmCodeSize >= 0x10000 || vmCodeSize === 0 || vin.addr + vmCodeSize > code.length) return false;
        const vmCode = new Uint8Array(vmCodeSize);
        for (let i = 0; i < vmCodeSize; i++) {
          vmCode[i] = vin.getbits() >>> 8;
          vin.addbits(8);
        }
        filter.type = identifyFilter(vmCode);
        if (filter.type === VMSF_NONE) throw new Error('RAR: unsupported VM filter');
      }
      stackFilter.type = filter.type;
      // (firstByte & 8) の後ろの「グローバルデータ」は標準フィルタでは使わないので読まない
      return true;
    }

    runFilter(flt) {
      flt.initR[6] = this.writtenFileSize >>> 0;
      const r = executeStdFilter(flt.type, this.vmMem, flt.initR);
      if (!r) return { data: this.vmMem, off: 0, size: 0 };
      return { data: this.vmMem, off: r.off, size: r.size };
    }

    unpWriteBuf30() {
      let writtenBorder = this.wrPtr;
      let writeSize = (this.unpPtr - writtenBorder) & MAX_WIN_MASK;
      const stack = this.prgStack;
      for (let i = 0; i < stack.length; i++) {
        const flt = stack[i];
        if (flt === null) continue;
        if (flt.nextWindow) { flt.nextWindow = false; continue; }
        const blockStart = flt.blockStart;
        const blockLength = flt.blockLength;
        if (((blockStart - writtenBorder) & MAX_WIN_MASK) < writeSize) {
          if (writtenBorder !== blockStart) {
            this.unpWriteArea(writtenBorder, blockStart);
            writtenBorder = blockStart;
            writeSize = (this.unpPtr - writtenBorder) & MAX_WIN_MASK;
          }
          if (blockLength <= writeSize) {
            const blockEnd = (blockStart + blockLength) & MAX_WIN_MASK;
            const mem = this.vmMem;
            if (blockLength > VM_MEMSIZE) throw new Error('RAR: filter block too large');
            if (blockStart < blockEnd || blockEnd === 0) {
              mem.set(this.window.subarray(blockStart, blockStart + blockLength), 0);
            } else {
              const firstPartLength = MAX_WIN_SIZE - blockStart;
              mem.set(this.window.subarray(blockStart, MAX_WIN_SIZE), 0);
              mem.set(this.window.subarray(0, blockEnd), firstPartLength);
            }
            let res = this.runFilter(flt);
            stack[i] = null;
            while (i + 1 < stack.length) {
              const next = stack[i + 1];
              if (next === null || next.blockStart !== blockStart || next.blockLength !== res.size || next.nextWindow) break;
              // 同じ区間に複数のフィルタを重ねがけ
              const tmp = res.data.slice(res.off, res.off + res.size);
              mem.set(tmp, 0);
              res = this.runFilter(next);
              i++;
              stack[i] = null;
            }
            this.unpWriteData(res.data, res.off, res.size);
            writtenBorder = blockEnd;
            writeSize = (this.unpPtr - writtenBorder) & MAX_WIN_MASK;
          } else {
            // フィルタ区間がまだ出揃っていない: 次回に回す
            for (let j = i; j < stack.length; j++) {
              const f = stack[j];
              if (f !== null && f.nextWindow) f.nextWindow = false;
            }
            this.wrPtr = writtenBorder;
            return;
          }
        }
      }
      this.unpWriteArea(writtenBorder, this.unpPtr);
      this.wrPtr = this.unpPtr;
    }
  }

  Archive._RarUnpacker = Unpacker;
  Archive._RarBitInput = BitInput;
  Archive._RarDecodeTable = DecodeTable;
})(typeof window !== 'undefined' ? window : globalThis);
