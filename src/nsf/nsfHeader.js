/*
 * NSF (Nintendo Sound Format) 1.x 128バイトヘッダ生成 / NSFe(チャンク形式)の解析
 * 参考: NESdev Wiki "NSF" フォーマット仕様
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const NSF = MML.NSF = MML.NSF || {};

  // 拡張音源フラグ (オフセット 0x7A / 122)
  NSF.CHIP_FLAGS = {
    VRC6: 0x01,
    VRC7: 0x02,
    FDS: 0x04,
    MMC5: 0x08,
    N163: 0x10,
    FME7: 0x20
  };

  function writeAsciiPadded(view, offset, text, length) {
    const bytes = new Uint8Array(length); // 0 埋め
    const enc = (text || '').slice(0, length);
    for (let i = 0; i < enc.length; i++) {
      bytes[i] = enc.charCodeAt(i) & 0xFF;
    }
    for (let i = 0; i < length; i++) view.setUint8(offset + i, bytes[i]);
  }

  /**
   * 128バイトのNSFヘッダを生成する
   * @param {object} opt
   * @param {number} [opt.totalSongs=1]
   * @param {number} [opt.startingSong=1]
   * @param {number} [opt.loadAddr=0x8000]
   * @param {number} [opt.initAddr=0x8000]
   * @param {number} [opt.playAddr=0x8003]
   * @param {string} [opt.songName='']
   * @param {string} [opt.artist='']
   * @param {string} [opt.copyright='']
   * @param {number} [opt.ntscSpeed=16639]  - 1/1000000秒単位 (NTSC ≒ 60.0988Hz)
   * @param {number} [opt.palSpeed=19997]   - 1/1000000秒単位 (PAL ≒ 50.0070Hz)
   * @param {Uint8Array|number[]} [opt.bankswitch] - 8バイトのバンクスイッチ初期値
   * @param {number} [opt.palNtscBit=0]     - bit0: 0=NTSC,1=PAL / bit1: dual mode
   * @param {number} [opt.extraChips=0]     - NSF.CHIP_FLAGS の OR
   * @returns {Uint8Array} 128バイトのヘッダ
   */
  NSF.buildHeader = function (opt = {}) {
    const buf = new ArrayBuffer(128);
    const view = new DataView(buf);

    // 0-4: マジック "NESM" + 0x1A
    const magic = [0x4E, 0x45, 0x53, 0x4D, 0x1A];
    magic.forEach((b, i) => view.setUint8(i, b));

    // 5: バージョン番号
    view.setUint8(5, 1);

    // 6: トータルソング数
    view.setUint8(6, opt.totalSongs !== undefined ? opt.totalSongs : 1);
    // 7: 開始曲番号 (1始まり)
    view.setUint8(7, opt.startingSong !== undefined ? opt.startingSong : 1);

    // 8-9 / 10-11 / 12-13: Load / Init / Play アドレス (LE)
    view.setUint16(8, (opt.loadAddr !== undefined ? opt.loadAddr : 0x8000) & 0xFFFF, true);
    view.setUint16(10, (opt.initAddr !== undefined ? opt.initAddr : 0x8000) & 0xFFFF, true);
    view.setUint16(12, (opt.playAddr !== undefined ? opt.playAddr : 0x8003) & 0xFFFF, true);

    // 14-45-77: 曲名 / アーティスト / 著作権 (各32バイト、ASCII、0終端/0埋め)
    writeAsciiPadded(view, 14, opt.songName, 32);
    writeAsciiPadded(view, 46, opt.artist, 32);
    writeAsciiPadded(view, 78, opt.copyright, 32);

    // 110-111: NTSC再生スピード (1/1000000秒)
    view.setUint16(110, opt.ntscSpeed !== undefined ? opt.ntscSpeed : 16639, true);

    // 112-119: バンクスイッチ初期値 (8バイト)
    const bs = opt.bankswitch || [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 8; i++) view.setUint8(112 + i, bs[i] || 0);

    // 120-121: PAL再生スピード
    view.setUint16(120, opt.palSpeed !== undefined ? opt.palSpeed : 19997, true);

    // 122: PAL/NTSC ビット
    view.setUint8(122, opt.palNtscBit !== undefined ? opt.palNtscBit : 0);

    // 123: 拡張音源フラグ
    view.setUint8(123, opt.extraChips !== undefined ? opt.extraChips : 0);

    // 124-127: NSF2/予約領域 (0埋め)
    view.setUint32(124, 0, true);

    return new Uint8Array(buf);
  };

  /*
   * 旧ppmckドライバ(Famicompo mini / FCM3〜4 時代、2004〜2005年頃)の N106 判定。
   *
   * 当時の N106(N163) 仕様理解は VirtuaNES 0.97 / VirtuaNSF 1.0.x 系の実装
   * (波形長レジスタ +4 は bit2-4 の3bit、length = 0x20 - (+4 & 0x1C) = 最大32サンプル)
   * に基づいており、ドライバは波形設定で `ORA #$80` を書いていた。実機/現行仕様では
   * +4 の bit2-7 が波形長(length = 256 - (+4 & 0xFC))なので、同じ値が実機では
   * 128 - 4n サンプル(4倍長)と解釈され、音程が2オクターブ落ち、波形メモリの他領域
   * (他の波形・レジスタ)まで読んで音色も崩れる。現行ppmckは同じ箇所で `ORA #$E0`
   * (= 256 - 32 + 4n の現行エンコード)を書く。
   *
   * 判定はその波形設定ルーチンの機械語列で行う(変数アドレスはビルドごとに違うので
   * ワイルドカード):
   *   ORA #$80 / STA abs,X / STA $4800 / LSR abs / LDA #$10 / SEC / SBC abs
   *   (n106_7c,x に保存 → $4800 へ波形長 → temporary を半分にして 16 - n = 転送バイト数)
   * `emu sound/famicompo` の実ファイル25本がこの列に一致し、現行ppmck生成物(ORA #$E0)
   * は22本とも不一致(2026-09-07 実測)。
   *
   * @param {Uint8Array} program - ヘッダ(128バイト)を除いたプログラムイメージ
   * @returns {boolean}
   */
  const LEGACY_N106_SIG = [0x09, 0x80, 0x9D, null, null, 0x8D, 0x00, 0x48, 0x4E, null, null, 0xA9, 0x10, 0x38, 0xED];
  NSF.detectLegacyN163Driver = function (program) {
    if (!program || program.length < LEGACY_N106_SIG.length) return false;
    const sig = LEGACY_N106_SIG;
    outer: for (let i = 0, n = program.length - sig.length; i <= n; i++) {
      for (let j = 0; j < sig.length; j++) {
        if (sig[j] !== null && program[i + j] !== sig[j]) continue outer;
      }
      return true;
    }
    return false;
  };

  /**
   * 128バイトのNSFヘッダを解析してオブジェクトに変換する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  NSF.parseHeader = function (bytes) {
    if (bytes.length < 128) throw new Error('NSFヘッダは128バイト必要です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, 128);
    const magicOk = bytes[0] === 0x4E && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x4D && bytes[4] === 0x1A;
    const readAscii = (offset, len) => {
      let s = '';
      for (let i = 0; i < len; i++) {
        const c = view.getUint8(offset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    return {
      magicOk,
      version: view.getUint8(5),
      totalSongs: view.getUint8(6),
      startingSong: view.getUint8(7),
      loadAddr: view.getUint16(8, true),
      initAddr: view.getUint16(10, true),
      playAddr: view.getUint16(12, true),
      songName: readAscii(14, 32),
      artist: readAscii(46, 32),
      copyright: readAscii(78, 32),
      ntscSpeed: view.getUint16(110, true),
      bankswitch: Array.from(bytes.slice(112, 120)),
      palSpeed: view.getUint16(120, true),
      palNtscBit: view.getUint8(122),
      extraChips: view.getUint8(123)
    };
  };
  // =========================================================================
  // NSFe (拡張NSF、チャンク形式)
  // 参考: NESdev Wiki "NSFe" / Disch の原仕様(2003)
  //
  //   "NSFE" (4バイト) の後に { size:u32LE, id:4文字ASCII, data[size] } のチャンクが並ぶ。
  //   idの先頭が大文字のチャンクは必須(理解できなければ再生不可)、小文字は任意(無視可)。
  //     INFO  load/init/play(各u16LE)、PAL/NTSCビット、拡張音源フラグ、曲数、開始曲(0始まり)
  //     DATA  プログラムイメージ(NSFの128バイト以降と同じもの)
  //     BANK  バンクスイッチ初期値(最大8バイト、不足分は0)
  //     RATE  NTSC/PAL/Dendy再生速度(各u16LE、1/1000000秒。NSFの$6E/$78と同じ単位)
  //     NSF2  NSF2機能フラグ(1バイト、NSFヘッダ$7Cと同じ)
  //     plst  再生順(曲番号の列、0始まり)   time/fade  曲ごとの演奏時間/フェード(i32LE、ms、-1=既定)
  //     tlbl/taut  曲ごとのラベル/作者(0終端文字列の列)   auth  タイトル/アーティスト/著作権/リッパー
  //     text  自由文   regn  地域対応ビット+推奨地域   mixe  ミックスレベル   VRC7  VRC7/YM2413種別+パッチ
  //     NEND  終端
  //
  //   このツールでは、NSFe を「128バイトのNSFヘッダ + DATA」の素のNSFバイト列へ変換して
  //   既存の再生/キャプチャ/変換経路(全てNSFバイト列を受け取る)へそのまま流し、曲ラベルや
  //   演奏時間などNSFヘッダに載らない情報は header.nsfe に別枠で持たせる(UI側で表示/利用)。
  //   曲番号は内部では0始まり(NSFeのINFO/plst/time等の番号と同じ)、NSFヘッダの開始曲は
  //   1始まりなので +1 して詰める。
  // =========================================================================

  NSF.isNsfe = function (bytes) {
    return !!bytes && bytes.length >= 4 &&
      bytes[0] === 0x4E && bytes[1] === 0x53 && bytes[2] === 0x46 && bytes[3] === 0x45; // "NSFE"
  };

  // 0終端文字列の列をデコードする。仕様上はUTF-8だが2003年頃(Famicompo)のファイルは
  // Shift-JIS/Latin-1で書かれているものがあるので、UTF-8として不正ならShift-JIS→Latin-1の順に落とす
  let _utf8 = null, _sjis = null;
  function decodeText(u8) {
    if (typeof TextDecoder === 'undefined') return String.fromCharCode.apply(null, u8);
    if (!_utf8) {
      try { _utf8 = new TextDecoder('utf-8', { fatal: true }); } catch (e) { _utf8 = null; }
      try { _sjis = new TextDecoder('shift_jis'); } catch (e) { _sjis = null; }
    }
    if (_utf8) { try { return _utf8.decode(u8); } catch (e) { /* not UTF-8 */ } }
    let ascii = true;
    for (let i = 0; i < u8.length; i++) if (u8[i] >= 0x80) { ascii = false; break; }
    if (ascii) return String.fromCharCode.apply(null, u8);
    if (_sjis) { try { return _sjis.decode(u8); } catch (e) { /* fallthrough */ } }
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  // 0終端文字列の列 → 文字列配列。末尾の空白は落とす(Famicompo 2003の一部はNSFヘッダ流用の31文字空白詰め)
  function splitZStrings(u8) {
    const out = [];
    let start = 0;
    for (let i = 0; i < u8.length; i++) {
      if (u8[i] === 0) { out.push(decodeText(u8.subarray(start, i)).replace(/\s+$/, '')); start = i + 1; }
    }
    if (start < u8.length) out.push(decodeText(u8.subarray(start)).replace(/\s+$/, '')); // 0終端が無い最後の文字列
    return out;
  }

  /**
   * NSFeを解析し、素のNSFバイト列とメタ情報に変換する。
   * @param {Uint8Array} bytes - "NSFE"で始まるファイル全体
   * @returns {{bytes:Uint8Array, header:object}}
   *   bytes  … 128バイトNSFヘッダ + DATA(既存のNSF経路へそのまま渡せる)
   *   header … parseHeader() と同じ形 + 以下
   *     songName/artist/copyright … authチャンクの全文(NSFヘッダの31文字制限を受けない)
   *     nsfe … { ripper, text, trackLabels[], trackAuthors[], times[](ms or null), fades[](ms or null),
   *              playlist[](0始まりの曲番号 or null), dendySpeed, nsf2Flags, regn, vrc7, mixe, chunks[] }
   * @throws 必須チャンクの欠落/未知の必須チャンク/壊れたチャンク
   */
  NSF.parseNsfe = function (bytes) {
    if (!NSF.isNsfe(bytes)) throw new Error('NSFeのマジックナンバーが不正です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let info = null, data = null, bank = null, rate = null;
    const meta = {
      ripper: '', text: '', trackLabels: null, trackAuthors: null, times: null, fades: null,
      playlist: null, dendySpeed: null, nsf2Flags: 0, regn: null, vrc7: null, mixe: null, chunks: []
    };
    let auth = null;
    let p = 4;
    let ended = false;
    while (p + 8 <= bytes.length && !ended) {
      const size = view.getUint32(p, true);
      const id = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (p + 8 + size > bytes.length) throw new Error('NSFeのチャンクがファイル末尾を越えています: ' + id);
      const body = bytes.subarray(p + 8, p + 8 + size);
      meta.chunks.push(id);
      const bv = new DataView(bytes.buffer, bytes.byteOffset + p + 8, size);
      switch (id) {
        case 'INFO':
          if (size < 8) throw new Error('NSFeのINFOチャンクが短すぎます');
          info = {
            loadAddr: bv.getUint16(0, true), initAddr: bv.getUint16(2, true), playAddr: bv.getUint16(4, true),
            palNtscBit: body[6], extraChips: body[7],
            totalSongs: size >= 9 ? (body[8] || 1) : 1,
            startingSong: size >= 10 ? body[9] : 0 // 0始まり
          };
          break;
        case 'DATA': data = body; break;
        case 'BANK': bank = Array.from(body.subarray(0, 8)); while (bank.length < 8) bank.push(0); break;
        case 'RATE':
          rate = {};
          if (size >= 2) rate.ntsc = bv.getUint16(0, true);
          if (size >= 4) rate.pal = bv.getUint16(2, true);
          if (size >= 6) rate.dendy = bv.getUint16(4, true);
          break;
        case 'NSF2': if (size >= 1) meta.nsf2Flags = body[0]; break;
        case 'plst': meta.playlist = Array.from(body); break;
        case 'time': case 'fade': {
          const arr = [];
          for (let i = 0; i + 4 <= size; i += 4) { const v = bv.getInt32(i, true); arr.push(v < 0 ? null : v); }
          meta[id === 'time' ? 'times' : 'fades'] = arr;
          break;
        }
        case 'tlbl': meta.trackLabels = splitZStrings(body); break;
        case 'taut': meta.trackAuthors = splitZStrings(body); break;
        case 'auth': auth = splitZStrings(body); break;
        case 'text': meta.text = decodeText(body).replace(/\0+$/, ''); break;
        case 'regn': meta.regn = { support: body[0] || 0, preferred: size >= 2 ? body[1] : null }; break;
        case 'mixe': meta.mixe = Array.from(body); break;
        case 'VRC7': meta.vrc7 = { variant: body[0] || 0, patches: size > 1 ? Array.from(body.subarray(1)) : null }; break;
        case 'NEND': ended = true; break;
        default:
          // 大文字始まり=必須チャンク。理解できないものがあれば正しく鳴らせないので中断する
          if (id.charCodeAt(0) >= 0x41 && id.charCodeAt(0) <= 0x5A) throw new Error('未対応の必須NSFeチャンクです: ' + id);
          break;
      }
      p += 8 + size;
    }
    if (!info) throw new Error('NSFeにINFOチャンクがありません');
    if (!data) throw new Error('NSFeにDATAチャンクがありません');

    const songName = auth && auth[0] ? auth[0] : '';
    const artist = auth && auth[1] ? auth[1] : '';
    const copyright = auth && auth[2] ? auth[2] : '';
    meta.ripper = auth && auth[3] ? auth[3] : '';
    const toAscii = s => s.replace(/[^\x20-\x7E]/g, '?').slice(0, 31); // NSFヘッダは0終端込み32バイトASCII

    const hdr = NSF.buildHeader({
      totalSongs: Math.min(255, info.totalSongs),
      startingSong: info.startingSong + 1,
      loadAddr: info.loadAddr, initAddr: info.initAddr, playAddr: info.playAddr,
      songName: toAscii(songName), artist: toAscii(artist), copyright: toAscii(copyright),
      ntscSpeed: rate && rate.ntsc !== undefined ? rate.ntsc : 16639,
      palSpeed: rate && rate.pal !== undefined ? rate.pal : 19997,
      bankswitch: bank || [0, 0, 0, 0, 0, 0, 0, 0],
      palNtscBit: info.palNtscBit,
      extraChips: info.extraChips
    });
    if (meta.nsf2Flags) {
      // NSF2機能フラグを持つならNSF2ヘッダとして詰める($05=2、$7C=フラグ、$7D-$7F=データ長)
      hdr[5] = 2;
      hdr[0x7C] = meta.nsf2Flags;
      hdr[0x7D] = data.length & 0xFF; hdr[0x7E] = (data.length >> 8) & 0xFF; hdr[0x7F] = (data.length >> 16) & 0xFF;
    }
    if (rate && rate.dendy !== undefined) meta.dendySpeed = rate.dendy;

    const out = new Uint8Array(128 + data.length);
    out.set(hdr, 0);
    out.set(data, 128);
    const header = NSF.parseHeader(out);
    header.isNsfe = true;
    header.songName = songName;
    header.artist = artist;
    header.copyright = copyright;
    header.nsfe = meta;
    return { bytes: out, header };
  };

  /**
   * NSF/NSFe どちらでも受け取り、素のNSFバイト列とヘッダを返す(読み込み口はこれを使う)。
   * NSFのときは bytes をそのまま返す(header.isNsfe = false, header.nsfe = null)。
   * @param {Uint8Array} bytes
   * @returns {{bytes:Uint8Array, header:object, isNsfe:boolean}}
   */
  NSF.normalize = function (bytes) {
    if (NSF.isNsfe(bytes)) {
      const r = NSF.parseNsfe(bytes);
      return { bytes: r.bytes, header: r.header, isNsfe: true };
    }
    if (bytes.length < 128) throw new Error('NSFヘッダは128バイト必要です');
    const header = NSF.parseHeader(bytes);
    header.isNsfe = false;
    header.nsfe = null;
    return { bytes, header, isNsfe: false };
  };

  /** NSFeの曲ラベル(無ければnull)。songIndexは0始まり */
  NSF.trackLabel = function (header, songIndex) {
    const m = header && header.nsfe;
    if (!m || !m.trackLabels) return null;
    const s = m.trackLabels[songIndex];
    return s ? s : null;
  };

  /** NSFeの演奏時間(ms、無ければnull)。songIndexは0始まり */
  NSF.trackTimeMs = function (header, songIndex) {
    const m = header && header.nsfe;
    if (!m || !m.times) return null;
    const v = m.times[songIndex];
    return (v === undefined || v === null) ? null : v;
  };
})(window);
