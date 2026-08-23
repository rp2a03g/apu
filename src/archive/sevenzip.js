/*
 * 7z(7-Zip)アーカイブのリーダー
 * MML.Archive の 7z 部分(zip側は archive.js)。
 *
 * zipと同じく「1アーカイブ = 1ゲーム分の複数トラック(+.m3u)」の器として扱うためのもの。
 * エントリ一覧の形は archive.js の zip エントリと揃えてあり(name/size/isDir)、曲リスト構築
 * (Archive.buildPlaylist)はそのまま共用できる。
 *
 * zipとの構造的な違い:
 *  - ヘッダが末尾にあり、しかもヘッダ自体が圧縮されている場合がある(kEncodedHeader)。
 *    そのため「ヘッダを読む」にも展開器が要る(下の decodeFolder を再帰的に使う)。
 *  - ファイル単位ではなく「フォルダ(=ソリッドブロック)」単位で圧縮される。1ファイルを
 *    取り出すにはそのブロック全体の展開が必要なので、直近に展開したブロックを1つ
 *    キャッシュする(曲送りは概ねブロック順に進むので実用上これで足りる)。
 *  - 圧縮方式はLZMA/LZMA2が既定でブラウザ標準では解けない(src/archive/lzma.js を使う)。
 *
 * 非対応: 暗号化(AES)、PPMd、BZip2、BCJ2、マルチボリューム。該当エントリを開こうとした時に
 * 方式名を添えて明示エラーにする(黙って壊れたデータを返さない)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Archive = MML.Archive = MML.Archive || {};

  const SIGNATURE = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]; // '7z' BC AF 27 1C
  const SIGNATURE_HEADER_SIZE = 32;

  // ヘッダのプロパティID
  const kEnd = 0x00, kHeader = 0x01, kArchiveProperties = 0x02, kAdditionalStreamsInfo = 0x03,
    kMainStreamsInfo = 0x04, kFilesInfo = 0x05, kPackInfo = 0x06, kUnPackInfo = 0x07,
    kSubStreamsInfo = 0x08, kSize = 0x09, kCRC = 0x0A, kFolder = 0x0B, kCodersUnPackSize = 0x0C,
    kNumUnPackStream = 0x0D, kEmptyStream = 0x0E, kEmptyFile = 0x0F, kAnti = 0x10, kName = 0x11,
    kEncodedHeader = 0x17;

  // coder ID(16進文字列) -> 表示名。未対応方式のエラーメッセージ用も兼ねる。
  const CODER_NAMES = {
    '00': 'Copy', '21': 'LZMA2', '030101': 'LZMA', '03': 'Delta',
    '04': 'BCJ(x86)', '03030103': 'BCJ(x86)', '040108': 'Deflate',
    '030401': 'PPMd', '040202': 'BZip2', '0303011b': 'BCJ2',
    '06f10701': 'AES-256 + SHA-256',
  };

  Archive.is7z = function (bytes) {
    if (!bytes || bytes.length < SIGNATURE_HEADER_SIZE) return false;
    for (let i = 0; i < SIGNATURE.length; i++) if (bytes[i] !== SIGNATURE[i]) return false;
    return true;
  };

  // ---- ヘッダ読み出し用の小さなリーダー ----
  class Reader {
    constructor(buf, pos, end) { this.buf = buf; this.pos = pos; this.end = end === undefined ? buf.length : end; }
    byte() {
      if (this.pos >= this.end) throw new Error('7z: unexpected end of header');
      return this.buf[this.pos++];
    }
    bytes(n) {
      if (this.pos + n > this.end) throw new Error('7z: unexpected end of header');
      const r = this.buf.subarray(this.pos, this.pos + n);
      this.pos += n;
      return r;
    }
    u32() {
      let v = 0;
      for (let i = 0; i < 4; i++) v += this.byte() * Math.pow(2, i * 8);
      return v;
    }
    u64() {
      let v = 0;
      for (let i = 0; i < 8; i++) v += this.byte() * Math.pow(2, i * 8);
      return v;
    }
    /** 7z可変長数値(先頭バイトの上位ビットで後続バイト数を表す) */
    num() {
      const first = this.byte();
      let mask = 0x80, value = 0;
      for (let i = 0; i < 8; i++) {
        if ((first & mask) === 0) return value + (first & (mask - 1)) * Math.pow(2, i * 8);
        value += this.byte() * Math.pow(2, i * 8);
        mask >>= 1;
      }
      return value;
    }
    /** ビットベクタ(各バイトMSBから) */
    bitVector(n) {
      const v = new Array(n);
      let b = 0, mask = 0;
      for (let i = 0; i < n; i++) {
        if (mask === 0) { b = this.byte(); mask = 0x80; }
        v[i] = (b & mask) !== 0;
        mask >>= 1;
      }
      return v;
    }
    /** allAreDefinedバイト付きのビットベクタ */
    boolVector(n) {
      if (this.byte() !== 0) return new Array(n).fill(true);
      return this.bitVector(n);
    }
  }

  function coderIdHex(idBytes) {
    let s = '';
    for (const b of idBytes) s += (b < 16 ? '0' : '') + b.toString(16);
    return s;
  }

  function readFolderDef(r) {
    const numCoders = r.num();
    if (numCoders === 0 || numCoders > 32) throw new Error('7z: bad coder count');
    const coders = [];
    let numInStreams = 0, numOutStreams = 0;
    for (let i = 0; i < numCoders; i++) {
      const flags = r.byte();
      if (flags & 0x80) throw new Error('7z: alternative methods unsupported');
      const idSize = flags & 0x0F;
      const id = coderIdHex(r.bytes(idSize));
      let numIn = 1, numOut = 1;
      if (flags & 0x10) { numIn = r.num(); numOut = r.num(); }
      let props = null;
      if (flags & 0x20) props = r.bytes(r.num()).slice();
      coders.push({ id, props, numIn, numOut, inFirst: numInStreams, outFirst: numOutStreams });
      numInStreams += numIn;
      numOutStreams += numOut;
    }
    const bindPairs = [];
    for (let i = 0; i < numOutStreams - 1; i++) bindPairs.push({ inIndex: r.num(), outIndex: r.num() });
    const numPacked = numInStreams - bindPairs.length;
    const packedIndices = [];
    if (numPacked === 1) {
      let idx = -1;
      for (let i = 0; i < numInStreams; i++) {
        if (!bindPairs.some(b => b.inIndex === i)) { idx = i; break; }
      }
      if (idx < 0) throw new Error('7z: bad folder (no packed stream)');
      packedIndices.push(idx);
    } else {
      for (let i = 0; i < numPacked; i++) packedIndices.push(r.num());
    }
    return { coders, bindPairs, packedIndices, numInStreams, numOutStreams, unpackSizes: null };
  }

  /** フォルダ全体の展開後サイズ = どのバインドペアにも使われない出力ストリームのサイズ */
  function folderUnpackSize(folder) {
    for (let i = folder.numOutStreams - 1; i >= 0; i--) {
      if (!folder.bindPairs.some(b => b.outIndex === i)) return folder.unpackSizes[i];
    }
    throw new Error('7z: bad folder (no output stream)');
  }

  function readDigests(r, num) {
    const defined = r.boolVector(num);
    const crcs = new Array(num).fill(null);
    for (let i = 0; i < num; i++) if (defined[i]) crcs[i] = r.u32();
    return crcs;
  }

  function readPackInfo(r, info) {
    info.packPos = r.num();
    const num = r.num();
    for (;;) {
      const id = r.num();
      if (id === kEnd) break;
      if (id === kSize) { for (let i = 0; i < num; i++) info.packSizes.push(r.num()); }
      else if (id === kCRC) readDigests(r, num);
      else throw new Error('7z: unexpected id ' + id + ' in pack info');
    }
  }

  function readUnpackInfo(r, info) {
    if (r.num() !== kFolder) throw new Error('7z: kFolder expected');
    const numFolders = r.num();
    if (r.byte() !== 0) throw new Error('7z: external folder data unsupported');
    for (let i = 0; i < numFolders; i++) info.folders.push(readFolderDef(r));
    if (r.num() !== kCodersUnPackSize) throw new Error('7z: kCodersUnPackSize expected');
    for (const f of info.folders) {
      f.unpackSizes = [];
      for (let i = 0; i < f.numOutStreams; i++) f.unpackSizes.push(r.num());
    }
    for (;;) {
      const id = r.num();
      if (id === kEnd) break;
      if (id === kCRC) {
        const crcs = readDigests(r, info.folders.length);
        info.folders.forEach((f, i) => { f.crc = crcs[i]; });
      } else throw new Error('7z: unexpected id ' + id + ' in unpack info');
    }
  }

  function readSubStreamsInfo(r, info) {
    const folders = info.folders;
    let numUnpackStreams = folders.map(() => 1);
    let id = r.num();
    if (id === kNumUnPackStream) {
      numUnpackStreams = folders.map(() => r.num());
      id = r.num();
    }
    const sizes = [];
    if (id === kSize) {
      for (let i = 0; i < folders.length; i++) {
        const n = numUnpackStreams[i];
        if (n === 0) continue;
        let sum = 0;
        for (let j = 1; j < n; j++) { const s = r.num(); sizes.push(s); sum += s; }
        sizes.push(folderUnpackSize(folders[i]) - sum);
      }
      id = r.num();
    } else {
      for (let i = 0; i < folders.length; i++) {
        const n = numUnpackStreams[i];
        if (n === 0) continue;
        if (n !== 1) throw new Error('7z: substream sizes missing');
        sizes.push(folderUnpackSize(folders[i]));
      }
    }
    // 「1フォルダ1ストリーム」でフォルダCRCが既に書かれている分は、ここには現れない。
    // 個数分きっちり読まないと後続がずれるので、その判定は正確に行う。
    const known = [];
    let numDigests = 0;
    for (let i = 0; i < folders.length; i++) {
      const n = numUnpackStreams[i];
      const folderCrc = (n === 1 && folders[i].crc !== null && folders[i].crc !== undefined) ? folders[i].crc : null;
      for (let j = 0; j < n; j++) known.push(folderCrc);
      if (folderCrc === null) numDigests += n;
    }
    let crcs = known;
    for (;;) {
      if (id === kEnd) break;
      if (id === kCRC) {
        const d = readDigests(r, numDigests);
        let k = 0;
        crcs = known.map(c => (c !== null ? c : d[k++]));
      } else throw new Error('7z: unexpected id ' + id + ' in substreams info');
      id = r.num();
    }
    info.numUnpackStreams = numUnpackStreams;
    info.subSizes = sizes;
    info.subCrcs = crcs;
  }

  function readStreamsInfo(r) {
    const info = { packPos: 0, packSizes: [], folders: [], numUnpackStreams: null, subSizes: null };
    for (;;) {
      const id = r.num();
      if (id === kEnd) break;
      if (id === kPackInfo) readPackInfo(r, info);
      else if (id === kUnPackInfo) readUnpackInfo(r, info);
      else if (id === kSubStreamsInfo) readSubStreamsInfo(r, info);
      else throw new Error('7z: unexpected id ' + id + ' in streams info');
    }
    if (!info.numUnpackStreams) {
      info.numUnpackStreams = info.folders.map(() => 1);
      info.subSizes = info.folders.map(f => folderUnpackSize(f));
      info.subCrcs = info.folders.map(f => (f.crc === undefined ? null : f.crc));
    }
    return info;
  }

  function readFilesInfo(r) {
    const numFiles = r.num();
    const files = [];
    for (let i = 0; i < numFiles; i++) files.push({ name: '', hasStream: true, isDir: false });
    let emptyStream = null, emptyFile = null, anti = null, numEmpty = 0;
    for (;;) {
      const type = r.num();
      if (type === kEnd) break;
      const size = r.num();
      const next = r.pos + size;
      if (next > r.end) throw new Error('7z: bad files info');
      if (type === kEmptyStream) {
        emptyStream = r.bitVector(numFiles);
        numEmpty = emptyStream.reduce((n, b) => n + (b ? 1 : 0), 0);
      } else if (type === kEmptyFile) {
        emptyFile = r.bitVector(numEmpty);
      } else if (type === kAnti) {
        anti = r.bitVector(numEmpty);
      } else if (type === kName) {
        if (r.byte() !== 0) throw new Error('7z: external file names unsupported');
        // UTF-16LE、NUL区切りで numFiles 個ぶん並ぶ
        let idx = 0, units = [];
        while (r.pos + 1 < next) {
          const c = r.byte() | (r.byte() << 8);
          if (c === 0) {
            if (idx < numFiles) files[idx].name = units.length ? String.fromCharCode.apply(null, units) : '';
            idx++;
            units = [];
          } else {
            units.push(c);
          }
        }
      }
      // 未知プロパティ(タイムスタンプ/属性/kDummy等)はサイズぶん読み飛ばす
      r.pos = next;
    }
    let e = 0;
    for (let i = 0; i < numFiles; i++) {
      const isEmptyStream = emptyStream ? emptyStream[i] : false;
      files[i].hasStream = !isEmptyStream;
      if (isEmptyStream) {
        const isEmptyFile = emptyFile ? emptyFile[e] : false;
        const isAnti = anti ? anti[e] : false;
        files[i].isDir = !isEmptyFile && !isAnti;
        e++;
      }
      files[i].name = files[i].name.replace(/\\/g, '/');
    }
    return files;
  }

  // ---- フォルダ(ソリッドブロック)の展開 ----

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unsupported');
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  /** Deltaフィルタ(展開方向): data[i] += data[i - delta] */
  function deltaDecode(data, props) {
    const delta = (props && props.length ? props[0] : 0) + 1;
    const out = data.slice();
    for (let i = delta; i < out.length; i++) out[i] = (out[i] + out[i - delta]) & 0xFF;
    return out;
  }

  // x86 BCJフィルタ(展開方向)。LZMA SDK Bra86.c の x86_Convert(encoding=0, ip=0) の移植。
  const kMaskToAllowedStatus = [1, 1, 1, 0, 1, 0, 0, 0];
  const kMaskToBitNumber = [0, 1, 2, 2, 3, 3, 3, 3];
  function isX86MSByte(b) { return b === 0 || b === 0xFF; }
  function bcjX86Decode(input) {
    const data = input.slice();
    const size = data.length;
    if (size < 5) return data;
    const ip = 5; // 7zのBCJは開始位置0固定。SDK同様 ip += 5 しておく
    const limit = size - 4;
    let pos = 0;
    let prevMask = 0;
    let prevPos = -1;
    for (;;) {
      let p = pos;
      while (p < limit && (data[p] & 0xFE) !== 0xE8) p++;
      pos = p;
      if (p >= limit) break;
      let d = pos - prevPos;
      if (d > 3) prevMask = 0;
      else {
        prevMask = (prevMask << (d - 1)) & 0x7;
        if (prevMask !== 0) {
          const b = data[pos + 4 - kMaskToBitNumber[prevMask]];
          if (!kMaskToAllowedStatus[prevMask] || isX86MSByte(b)) {
            prevPos = pos;
            prevMask = ((prevMask << 1) & 0x7) | 1;
            pos++;
            continue;
          }
        }
      }
      prevPos = pos;
      if (isX86MSByte(data[pos + 4])) {
        let src = ((data[pos + 4] << 24) | (data[pos + 3] << 16) | (data[pos + 2] << 8) | data[pos + 1]) >>> 0;
        let dest;
        for (;;) {
          dest = (src - (ip + pos)) >>> 0;
          if (prevMask === 0) break;
          const index = kMaskToBitNumber[prevMask] * 8;
          const b = (dest >>> (24 - index)) & 0xFF;
          if (!isX86MSByte(b)) break;
          src = (dest ^ (((1 << (32 - index)) - 1) >>> 0)) >>> 0;
        }
        data[pos + 4] = (~(((dest >>> 24) & 1) - 1)) & 0xFF;
        data[pos + 3] = (dest >>> 16) & 0xFF;
        data[pos + 2] = (dest >>> 8) & 0xFF;
        data[pos + 1] = dest & 0xFF;
        pos += 5;
      } else {
        prevMask = ((prevMask << 1) & 0x7) | 1;
        pos++;
      }
    }
    return data;
  }

  async function runCoder(coder, ins, outSize) {
    const input = ins[0];
    if (!input) throw new Error('7z: missing input stream');
    switch (coder.id) {
      case '00': // Copy
        return input.length === outSize ? input.slice() : input.slice(0, outSize);
      case '21': // LZMA2
        return MML.LZMA.decodeLzma2(input, 0, input.length, outSize);
      case '030101': // LZMA
        return MML.LZMA.decodeLzma1(coder.props, input, 0, input.length, outSize);
      case '03': // Delta
        return deltaDecode(input, coder.props);
      case '04': case '03030103': // BCJ(x86)
        return bcjX86Decode(input);
      case '040108': // Deflate
        return inflateRaw(input);
      default: {
        const name = CODER_NAMES[coder.id] || ('ID ' + coder.id);
        throw new Error('7z: unsupported compression method (' + name + ')');
      }
    }
  }

  /**
   * フォルダ(ソリッドブロック)を展開する。coderはバインドペアで数珠つなぎになりうるので、
   * 「どのバインドペアにも使われない出力」から入力側へ再帰的に辿って解く。
   */
  async function decodeFolder(bytes, folder, packOffset, packSizes, packIndex) {
    const inputs = {};
    let off = packOffset;
    for (let i = 0; i < folder.packedIndices.length; i++) {
      const size = packSizes[packIndex + i];
      if (off + size > bytes.length) throw new Error('7z: packed stream out of range');
      inputs[folder.packedIndices[i]] = bytes.subarray(off, off + size);
      off += size;
    }
    const cache = new Map();
    const inProgress = new Set();
    async function getOut(outIndex) {
      if (cache.has(outIndex)) return cache.get(outIndex);
      if (inProgress.has(outIndex)) throw new Error('7z: coder loop');
      inProgress.add(outIndex);
      const coder = folder.coders.find(c => outIndex >= c.outFirst && outIndex < c.outFirst + c.numOut);
      if (!coder) throw new Error('7z: bad output stream index');
      const ins = [];
      for (let i = 0; i < coder.numIn; i++) {
        const gi = coder.inFirst + i;
        const bp = folder.bindPairs.find(b => b.inIndex === gi);
        ins.push(bp ? await getOut(bp.outIndex) : inputs[gi]);
      }
      const res = await runCoder(coder, ins, folder.unpackSizes[outIndex]);
      inProgress.delete(outIndex);
      cache.set(outIndex, res);
      return res;
    }
    for (let i = folder.numOutStreams - 1; i >= 0; i--) {
      if (!folder.bindPairs.some(b => b.outIndex === i)) return getOut(i);
    }
    throw new Error('7z: bad folder (no output stream)');
  }

  /** フォルダごとの「パックストリーム開始インデックス」と「ファイル先頭オフセット」を求める */
  function buildFolderOffsets(info, baseOffset) {
    const starts = [];
    let packIndex = 0;
    let offset = baseOffset + info.packPos;
    for (const f of info.folders) {
      starts.push({ packIndex, offset });
      for (let i = 0; i < f.packedIndices.length; i++) offset += info.packSizes[packIndex + i];
      packIndex += f.packedIndices.length;
    }
    return starts;
  }

  /**
   * 7zを解析してエントリ一覧を返す。エントリの形はzip側(archive.js)と揃えてある。
   * @param {Uint8Array} bytes
   * @returns {Promise<{type:string, entries:Array}>}
   */
  Archive.parse7z = async function (bytes) {
    if (!Archive.is7z(bytes)) throw new Error('not a 7z');
    const sh = new Reader(bytes, 12, SIGNATURE_HEADER_SIZE);
    const nextHeaderOffset = sh.u64();
    const nextHeaderSize = sh.u64();
    if (nextHeaderSize === 0) return { type: '7z', entries: [] };
    const start = SIGNATURE_HEADER_SIZE + nextHeaderOffset;
    if (start + nextHeaderSize > bytes.length) throw new Error('7z: header out of range');

    let r = new Reader(bytes, start, start + nextHeaderSize);
    let id = r.num();
    if (id === kEncodedHeader) {
      // ヘッダ自体が圧縮されている: まずそれを展開してから読み直す
      const info = readStreamsInfo(r);
      if (info.folders.length === 0) throw new Error('7z: bad encoded header');
      const offs = buildFolderOffsets(info, SIGNATURE_HEADER_SIZE);
      const headerBytes = await decodeFolder(bytes, info.folders[0], offs[0].offset, info.packSizes, offs[0].packIndex);
      r = new Reader(headerBytes, 0, headerBytes.length);
      id = r.num();
    }
    if (id === kEnd) return { type: '7z', entries: [] };
    if (id !== kHeader) throw new Error('7z: unexpected header id ' + id);

    let streams = null;
    let files = null;
    for (;;) {
      const pid = r.num();
      if (pid === kEnd) break;
      if (pid === kMainStreamsInfo) streams = readStreamsInfo(r);
      else if (pid === kFilesInfo) { files = readFilesInfo(r); break; }
      else if (pid === kArchiveProperties) {
        for (;;) { const t = r.num(); if (t === kEnd) break; r.pos += r.num(); }
      } else if (pid === kAdditionalStreamsInfo) {
        readStreamsInfo(r); // 使わないが読み飛ばしのため解析は必要
      } else throw new Error('7z: unexpected id ' + pid + ' in header');
    }
    if (!files) files = [];
    if (!streams) streams = { packPos: 0, packSizes: [], folders: [], numUnpackStreams: [], subSizes: [], subCrcs: [] };

    // サブストリーム(=中身を持つファイル)ごとの、所属フォルダと展開後オフセット
    const subs = [];
    let si = 0;
    for (let fi = 0; fi < streams.folders.length; fi++) {
      let off = 0;
      for (let j = 0; j < streams.numUnpackStreams[fi]; j++) {
        const size = streams.subSizes[si];
        subs.push({ folderIndex: fi, offset: off, size, crc: streams.subCrcs ? streams.subCrcs[si] : null });
        si++;
        off += size;
      }
    }

    const ctx = {
      bytes,
      folders: streams.folders,
      packSizes: streams.packSizes,
      folderOffsets: buildFolderOffsets(streams, SIGNATURE_HEADER_SIZE),
      cacheIndex: -1,
      cacheData: null,
    };

    const entries = [];
    let k = 0;
    for (const f of files) {
      if (f.hasStream) {
        const s = subs[k++];
        if (!s) throw new Error('7z: stream count mismatch');
        entries.push({
          name: f.name, size: s.size, isDir: false, encrypted: false, sevenZip: ctx,
          folderIndex: s.folderIndex, folderOffset: s.offset, crc: s.crc,
        });
      } else {
        entries.push({
          name: f.isDir ? f.name + '/' : f.name, size: 0, isDir: f.isDir, encrypted: false,
          sevenZip: ctx, folderIndex: -1, folderOffset: 0,
        });
      }
    }
    return { type: '7z', entries };
  };

  /** parse7z()のエントリの中身を取り出す(所属フォルダを展開して切り出す) */
  Archive.read7zEntry = async function (entry) {
    const ctx = entry.sevenZip;
    if (!ctx) throw new Error('7z: not a 7z entry');
    if (entry.isDir || entry.folderIndex < 0 || entry.size === 0) return new Uint8Array(0);
    if (ctx.cacheIndex !== entry.folderIndex) {
      const folder = ctx.folders[entry.folderIndex];
      const off = ctx.folderOffsets[entry.folderIndex];
      // 直近の1ブロックだけ持つ(ソリッドブロックは大きくなりうるので溜め込まない)
      ctx.cacheData = null;
      ctx.cacheIndex = -1;
      ctx.cacheData = await decodeFolder(ctx.bytes, folder, off.offset, ctx.packSizes, off.packIndex);
      ctx.cacheIndex = entry.folderIndex;
    }
    return ctx.cacheData.subarray(entry.folderOffset, entry.folderOffset + entry.size).slice();
  };
})(window);
