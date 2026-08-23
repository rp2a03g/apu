/*
 * アーカイブ/圧縮の汎用リーダー
 * MML.Archive
 *
 * 目的: 「1アーカイブ = 1ゲーム分の複数トラック(+.m3u)」という配布単位(vgmrips等)を、
 * VGMだけでなく SPC/NSF/KSS/GBS/HES すべてに被せられる「曲リストの器」として扱う。
 * VGM(1ファイル1曲)/SPC(1ファイル1曲)のように単体では曲番号の概念が無い形式でも、
 * アーカイブを開けば他形式と同じ「曲送り」UIが成立する。
 *
 * 外部ライブラリは使わない(INV-1)。zip/gzipの解凍はブラウザ標準の DecompressionStream
 * ('deflate-raw' / 'gzip')。DOM非依存(INV-4)。
 * 7zは同じ器に載せるが、ヘッダ解析と LZMA/LZMA2 展開が別物なので src/archive/sevenzip.js
 * (+ src/archive/lzma.js)に分けてある。入口は Archive.parse() / Archive.readEntry()。
 *
 * - zip: セントラルディレクトリを末尾のEOCDから辿る。対応する圧縮方式は
 *   store(0)とdeflate(8)のみ。それ以外は readEntry() が明示エラーを投げる。
 *   zip64・暗号化・マルチパートは非対応(vgmrips/zophar系の配布物には出てこない)。
 * - gzip: 拡張子は当てにせず先頭2バイト(1f 8b)で判別する
 *   (「.vgm」拡張子で中身がgzipのファイルが実在する。ROADMAP.md VGM節参照)。
 * - m3u: アーカイブ内に .m3u があればその行順をトラック順にする。無ければファイル名の自然順。
 *   NEZplug系の拡張行 "file.kss::KSS,song,title,..." は曲番号付きの項目になる
 *   (KSS/NSF等の1ファイル多曲形式でも m3u の曲順で曲送りできる)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Archive = MML.Archive = MML.Archive || {};

  const SIG_LOCAL = 0x04034b50;   // 'PK\x03\x04'
  const SIG_CENTRAL = 0x02014b50; // 'PK\x01\x02'
  const SIG_EOCD = 0x06054b50;    // 'PK\x05\x06'

  const utf8 = new TextDecoder('utf-8');
  // zip仕様上、bit11(EFS)が立っていなければファイル名の文字コードは規定されない
  // (歴史的にはCP437、日本製アーカイバはShift-JIS)。ブラウザ標準のTextDecoderは
  // Shift-JISも扱えるので、EFS無しなら一度Shift-JISとして解釈を試みる。
  let sjis = null;
  try { sjis = new TextDecoder('shift_jis'); } catch (e) { sjis = null; }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  Archive.isZip = function (bytes) {
    return bytes && bytes.length >= 4 && u32(bytes, 0) === SIG_LOCAL;
  };

  Archive.isGzip = function (bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  };

  /** 中身の署名からアーカイブ種別を返す('zip' / '7z' / null)。拡張子は当てにしない。 */
  Archive.detect = function (bytes) {
    if (Archive.isZip(bytes)) return 'zip';
    if (Archive.is7z && Archive.is7z(bytes)) return '7z';
    return null;
  };

  /**
   * zip / 7z を種別に応じて解析してエントリ一覧を返す(呼び出し側は種別を意識しなくてよい)。
   * エントリの形は両者で揃えてあるので buildPlaylist / readEntry はそのまま共用できる。
   * @returns {Promise<{type:string, entries:Array}>}
   */
  Archive.parse = async function (bytes) {
    if (Archive.is7z && Archive.is7z(bytes)) return Archive.parse7z(bytes); // src/archive/sevenzip.js
    return { type: 'zip', entries: Archive.parseZip(bytes).entries };
  };

  async function decompress(bytes, format) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream unsupported'); // 呼び出し側でi18n化する
    }
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  /** gzip(.vgz等)を解凍する。gzipでなければそのまま返す。 */
  Archive.gunzipIfNeeded = async function (bytes) {
    if (!Archive.isGzip(bytes)) return bytes;
    return decompress(bytes, 'gzip');
  };

  /**
   * zipのセントラルディレクトリを解析してエントリ一覧を返す(同期・データは読まない)。
   * @param {Uint8Array} bytes
   * @returns {{entries: Array<{name:string, size:number, compressedSize:number, method:number, localOffset:number, isDir:boolean}>}}
   */
  Archive.parseZip = function (bytes) {
    if (!Archive.isZip(bytes)) throw new Error('not a zip');
    // EOCD(22バイト固定+コメント最大65535)を末尾から探す
    const minPos = Math.max(0, bytes.length - 22 - 65535);
    let eocd = -1;
    for (let p = bytes.length - 22; p >= minPos; p--) {
      if (u32(bytes, p) === SIG_EOCD) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('zip: EOCD not found');
    const count = u16(bytes, eocd + 10);
    const cdSize = u32(bytes, eocd + 12);
    const cdOffset = u32(bytes, eocd + 16);
    if (cdOffset + cdSize > bytes.length) throw new Error('zip: central directory out of range');

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (u32(bytes, p) !== SIG_CENTRAL) throw new Error('zip: bad central directory entry');
      const flags = u16(bytes, p + 8);
      const method = u16(bytes, p + 10);
      const compressedSize = u32(bytes, p + 20);
      const size = u32(bytes, p + 24);
      const nameLen = u16(bytes, p + 28);
      const extraLen = u16(bytes, p + 30);
      const commentLen = u16(bytes, p + 32);
      const localOffset = u32(bytes, p + 42);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const efs = !!(flags & 0x0800);
      let name;
      if (efs || !sjis) name = utf8.decode(nameBytes);
      else {
        // EFS無し: ASCII範囲のみならどちらでも同じ。非ASCIIを含むならShift-JISを優先
        // (UTF-8として不正なら置換文字U+FFFDが出るのでそれで判定する)
        const asUtf8 = utf8.decode(nameBytes);
        name = asUtf8.includes('�') ? sjis.decode(nameBytes) : asUtf8;
      }
      name = name.replace(/\\/g, '/');
      entries.push({ name, size, compressedSize, method, localOffset, isDir: name.endsWith('/'), encrypted: !!(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries };
  };

  /**
   * エントリの中身を解凍して返す。
   * @param {Uint8Array} bytes - アーカイブ全体
   * @param {object} entry - parseZip()/parse7z()のエントリ
   * @returns {Promise<Uint8Array>}
   */
  Archive.readEntry = async function (bytes, entry) {
    if (entry.sevenZip) return Archive.read7zEntry(entry); // 7zはブロック単位(src/archive/sevenzip.js)
    const p = entry.localOffset;
    if (u32(bytes, p) !== SIG_LOCAL) throw new Error('zip: bad local header');
    if (entry.encrypted) throw new Error('zip: encrypted entry');
    const nameLen = u16(bytes, p + 26);
    const extraLen = u16(bytes, p + 28);
    const dataStart = p + 30 + nameLen + extraLen;
    const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return raw.slice();
    if (entry.method === 8) return decompress(raw, 'deflate-raw');
    throw new Error('zip: unsupported compression method ' + entry.method);
  };

  function baseName(path) {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
  }
  function extOf(name) {
    const b = baseName(name);
    const i = b.lastIndexOf('.');
    return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
  }
  Archive.baseName = baseName;
  Archive.extOf = extOf;

  // ファイル名の自然順(数字は数値として比較: "2" < "10")
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  Archive.naturalCompare = (a, b) => collator.compare(a, b);


  // NEZplug/in_kss 系の拡張m3u行 "file.kss::KSS,song,title,length,loop,fade" を分解する。
  // 通常のm3u(ファイル名のみ)なら {fname} だけ返す。title 内の "\," はエスケープされたカンマ。
  const ESC_COMMA = '⁣'; // 分割時にエスケープ済みカンマを一時退避する印(不可視分離子、m3uには現れない)
  // 曲番号は10進のほか "$00"(NEZplug/in_kss系の16進表記)でも書かれる。実際に出回っている
  // KSSの.m3uはほぼ$表記で、これを取りこぼすと全行が同じ曲扱いになり曲リストが1件に潰れる。
  function parseSongNumber(s) {
    if (s === undefined || s === null) return null;
    s = s.trim();
    let m = /^\$([0-9a-fA-F]+)$/.exec(s) || /^0[xX]([0-9a-fA-F]+)$/.exec(s);
    if (m) return parseInt(m[1], 16);
    return /^\d+$/.test(s) ? +s : null;
  }
  function parseM3uLine(line) {
    const sep = line.indexOf('::');
    if (sep < 0) return { fname: line.split('|')[0].trim(), song: null, title: null };
    const fname = line.slice(0, sep).trim();
    const rest = line.slice(sep + 2);
    const fields = rest.replace(/\\,/g, ESC_COMMA).split(',').map(s => s.split(ESC_COMMA).join(',').trim());
    const song = fields.length >= 2 ? parseSongNumber(fields[1]) : null;
    const title = fields.length >= 3 && fields[2] ? fields[2] : null;
    return { fname, type: fields[0] || null, song, title };
  }

  /**
   * アーカイブのエントリ一覧から「曲リスト」を作る。
   * @param {Array} entries - parseZip().entries
   * @param {Set<string>|string[]} exts - 対象拡張子(小文字、ドット無し)
   * @param {(entry)=>Promise<Uint8Array>} [readFn] - .m3uを読むための関数(省略時はm3u無視)
   * @returns {Promise<Array<{entry:object, title:string, song:number|null}>>}
   *   - song: 拡張m3u("file::TYPE,song,title,...")が曲番号を持つ場合その値(形式ごとの
   *     ネイティブ表記のまま: NSF/GBSは1始まり、KSS/HESは0始まりで書かれるのが慣例)。
   *     同じファイルを曲番号違いで複数回列挙するm3u(KSSの1ファイル多曲)は別項目になる。
   *   - title: 拡張m3uのタイトル、無ければファイル名(拡張子除く)
   */
  Archive.buildPlaylist = async function (entries, exts, readFn) {
    const extSet = new Set(Array.from(exts).map(e => e.toLowerCase()));
    const files = entries.filter(e => !e.isDir && extSet.has(extOf(e.name)));
    if (files.length === 0) return [];

    // .m3u があれば行順を優先する。複数ある場合(zophar系は "01 xxx.m3u" のように
    // 曲ごとに1本置く配布物がある: GG Aleste = KSS 1本 + m3u 13本)は、全m3uを
    // ファイル名の自然順に連結して1つの並びとみなす(同一 entry+song の重複は除外)。
    const ordered = [];
    const seenKey = new Set();
    if (readFn) {
      const m3us = entries.filter(e => !e.isDir && (extOf(e.name) === 'm3u' || extOf(e.name) === 'm3u8'))
        .sort((a, b) => Archive.naturalCompare(a.name, b.name));
      for (const m of m3us) {
        let text;
        try {
          const raw = await readFn(m);
          text = utf8.decode(raw);
          if (text.includes('�') && sjis) text = sjis.decode(raw);
        } catch (e) { continue; }
        const dirOfM3u = m.name.includes('/') ? m.name.slice(0, m.name.lastIndexOf('/') + 1) : '';
        for (let line of text.split(/\r?\n/)) {
          line = line.trim();
          if (!line || line.startsWith('#')) continue;
          const info = parseM3uLine(line);
          const fname = info.fname.replace(/\\/g, '/');
          const key = baseName(fname).toLowerCase();
          const hit = files.find(f => f.name.toLowerCase() === (dirOfM3u + fname).toLowerCase())
                   || files.find(f => baseName(f.name).toLowerCase() === key);
          if (!hit) continue;
          const k = hit.name + '::' + (info.song === null ? '' : info.song);
          if (seenKey.has(k)) continue;
          seenKey.add(k);
          ordered.push({ entry: hit, song: info.song, title: info.title });
        }
      }
    }

    const listedEntries = new Set(ordered.map(o => o.entry));
    const rest = files.filter(f => !listedEntries.has(f)).sort((a, b) => Archive.naturalCompare(a.name, b.name))
      .map(entry => ({ entry, song: null, title: null }));
    return ordered.concat(rest).map(item => {
      const b = baseName(item.entry.name);
      const dot = b.lastIndexOf('.');
      return { entry: item.entry, song: item.song, title: item.title || (dot > 0 ? b.slice(0, dot) : b) };
    });
  };
})(window);
