/*
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Built by tools/build-capture-workers.ps1 at 2026-09-16 23:01:12
 *
 * regsOnly capture worker bundle (nsfCapture). Loaded on the main thread as a plain
 * script, but the emulator code inside MML.WorkerBundles.nsfCapture is never
 * executed there; capture-worker-client.js stringifies it into a Blob Worker.
 */
(function (global) {
  var MML = global.MML = global.MML || {};
  MML.WorkerBundles = MML.WorkerBundles || {};
  MML.WorkerBundles.nsfCaptureBuiltAt = '2026-09-16 23:01:12';
  MML.WorkerBundles.nsfCapture = function () {
/*
 * NSF (Nintendo Sound Format) 1.x 128バイトヘッダ生成 / NSFe(チャンク形式)の解析
 * 参考: NESdev Wiki "NSF" フォーマット仕様
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const NSF = MML.NSF = MML.NSF || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キャプチャWorker内など MML.I18n が無い環境では素通し
  const tr = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

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
    if (bytes.length < 128) throw new Error(tr('NSFヘッダは128バイト必要です'));
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
    if (!NSF.isNsfe(bytes)) throw new Error(tr('NSFeのマジックナンバーが不正です'));
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
      if (p + 8 + size > bytes.length) throw new Error(tr('NSFeのチャンクがファイル末尾を越えています: {id}', { id }));
      const body = bytes.subarray(p + 8, p + 8 + size);
      meta.chunks.push(id);
      const bv = new DataView(bytes.buffer, bytes.byteOffset + p + 8, size);
      switch (id) {
        case 'INFO':
          if (size < 8) throw new Error(tr('NSFeのINFOチャンクが短すぎます'));
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
          if (id.charCodeAt(0) >= 0x41 && id.charCodeAt(0) <= 0x5A) throw new Error(tr('未対応の必須NSFeチャンクです: {id}', { id }));
          break;
      }
      p += 8 + size;
    }
    if (!info) throw new Error(tr('NSFeにINFOチャンクがありません'));
    if (!data) throw new Error(tr('NSFeにDATAチャンクがありません'));

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
    if (bytes.length < 128) throw new Error(tr('NSFヘッダは128バイト必要です'));
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
})(globalThis);

/*
 * 6502 CPUコア（NES/NSF用、デコードモード無効）
 * MML.Emu.CPU6502
 *
 * - 全151正規オペコードに対応
 * - bus.read(addr) / bus.write(addr, value) を介してメモリアクセス
 * - call(addr) で「addrをCALLして RTS で戻るまで実行」を行うヘルパーを提供
 *   (NSFのINIT/PLAYルーチン呼び出しに使用)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // フラグビット
  const F_C = 0x01; // Carry
  const F_Z = 0x02; // Zero
  const F_I = 0x04; // IRQ disable
  const F_D = 0x08; // Decimal (NESでは演算に影響しない)
  const F_B = 0x10; // Break
  const F_U = 0x20; // Unused (常に1)
  const F_V = 0x40; // Overflow
  const F_N = 0x80; // Negative

  // CALL終了検知のためのスタックに積む「番兵」リターンアドレス。
  // RTSでこのアドレスに戻ったら呼び出し終了とみなす。
  const CALL_SENTINEL = 0xFFFF;

  class CPU6502 {
    /**
     * @param {{read:(addr:number)=>number, write:(addr:number, value:number)=>void}} bus
     */
    constructor(bus) {
      this.bus = bus;
      this.reset();
    }

    reset() {
      this.A = 0;
      this.X = 0;
      this.Y = 0;
      this.S = 0xFD;
      this.P = F_U | F_I;
      this.PC = 0;
      this.cycles = 0;
      this.halted = false;
      this.callActive = false;
    }

    // --- メモリアクセス ---
    read(addr) { return this.bus.read(addr & 0xFFFF) & 0xFF; }
    write(addr, value) { this.bus.write(addr & 0xFFFF, value & 0xFF); }
    // PCから1バイト読んでPCを16bitでラップさせながら進める
    fetchByte() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }
    read16(addr) {
      return this.read(addr) | (this.read(addr + 1) << 8);
    }
    // JMP (ind) のページ境界バグ: 下位バイトが$xxFFの場合、上位バイトは$xx00から読む
    read16Bug(addr) {
      const lo = this.read(addr);
      const hiAddr = (addr & 0xFF00) | ((addr + 1) & 0xFF);
      const hi = this.read(hiAddr);
      return lo | (hi << 8);
    }

    // --- フラグ操作 ---
    getFlag(mask) { return (this.P & mask) !== 0; }
    setFlag(mask, on) { this.P = on ? (this.P | mask) : (this.P & ~mask); }
    setZN(value) {
      value &= 0xFF;
      this.setFlag(F_Z, value === 0);
      this.setFlag(F_N, (value & 0x80) !== 0);
    }

    // --- スタック ---
    push(value) {
      this.write(0x0100 + this.S, value);
      this.S = (this.S - 1) & 0xFF;
    }
    pop() {
      this.S = (this.S + 1) & 0xFF;
      return this.read(0x0100 + this.S);
    }

    // --- オペランド取得 ---
    // 戻り値: { addr: number|null, value: number, pageCrossed: boolean }
    // skipRead=true の場合、書き込み先アドレスのみ算出し値の読み出しをしない。
    // (STA/STX/STY 等のストア命令用。実機のストアは書き込み先を読まないため、
    //  $4800(N163) や $4015 等の読み出し副作用を持つレジスタで空読みが悪影響を与える)
    fetchOperand(mode, skipRead = false) {
      let addr = null, value = 0, pageCrossed = false;
      switch (mode) {
        case 'imm':
          value = this.fetchByte();
          break;
        case 'acc':
          value = this.A;
          break;
        case 'impl':
          break;
        case 'zp':
          addr = this.fetchByte();
          if (!skipRead) value = this.read(addr);
          break;
        case 'zpx':
          addr = (this.fetchByte() + this.X) & 0xFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'zpy':
          addr = (this.fetchByte() + this.Y) & 0xFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'abs':
          addr = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          if (!skipRead) value = this.read(addr);
          break;
        case 'absx': {
          const base = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.X) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'absy': {
          const base = this.read16(this.PC);
          this.PC = (this.PC + 2) & 0xFFFF;
          addr = (base + this.Y) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'indx': {
          const zp = (this.fetchByte() + this.X) & 0xFF;
          addr = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'indy': {
          const zp = this.fetchByte();
          const base = this.read(zp) | (this.read((zp + 1) & 0xFF) << 8);
          addr = (base + this.Y) & 0xFFFF;
          pageCrossed = (base & 0xFF00) !== (addr & 0xFF00);
          if (!skipRead) value = this.read(addr);
          break;
        }
        case 'rel': {
          const off = this.fetchByte();
          addr = off; // 呼び出し側で符号付きオフセットとして解釈
          break;
        }
        default:
          throw new Error(`未知のアドレッシングモード: ${mode}`);
      }
      return { addr, value, pageCrossed };
    }

    writeOperand(mode, addr, value) {
      if (mode === 'acc') this.A = value & 0xFF;
      else this.write(addr, value);
    }

    // --- 命令実行（1命令）---
    // 戻り値: 消費サイクル数
    step() {
      const opcode = this.fetchByte();
      const def = OPS[opcode];
      if (!def) {
        // 未定義オペコードは2サイクルNOP相当として無視する
        return 2;
      }
      const extra = def.exec(this, def.mode);
      return def.cycles + (extra || 0);
    }

    /**
     * addr のサブルーチンを呼び出し、RTS で戻るまで実行する。
     * NSFのINITやPLAYの呼び出しに使用。
     * @param {number} addr
     * @param {number} [maxSteps=200000] - 無限ループ対策の上限命令数
     * @returns {number} 実行した命令数
     */
    call(addr, maxSteps = 200000) {
      // 番兵アドレス-1 をリターンアドレスとしてプッシュ（RTSで+1されてCALL_SENTINELに戻る）
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF);
      this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;

      let steps = 0;
      while (this.PC !== CALL_SENTINEL && steps < maxSteps) {
        this.step();
        steps++;
      }
      return steps;
    }

    // --- 呼び出しをAPUクロックとインターリーブするための逐次実行API ---
    // beginCall で番兵を積んでPCを設定し callActive=true にする。以後 stepCall() を
    // 呼ぶたびに1命令実行し、RTSで番兵に戻ったら callActive=false になる。
    // ($4011直書きPCMのように、PLAY中のレジスタ書き込みをサンプル精度で反映するため)
    beginCall(addr) {
      const ret = (CALL_SENTINEL - 1) & 0xFFFF;
      this.push((ret >> 8) & 0xFF);
      this.push(ret & 0xFF);
      this.PC = addr & 0xFFFF;
      this.callActive = true;
    }

    // callActive中に1命令実行し、消費CPUサイクル数を返す。番兵到達でcallActive=false。
    stepCall() {
      const c = this.step();
      if (this.PC === CALL_SENTINEL) this.callActive = false;
      return c;
    }
  }

  // --- 命令ハンドラ ---

  function ADC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const sum = cpu.A + op.value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (op.value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function SBC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    const value = op.value ^ 0xFF;
    const sum = cpu.A + value + c;
    const result = sum & 0xFF;
    cpu.setFlag(F_V, ((cpu.A ^ result) & (value ^ result) & 0x80) !== 0);
    cpu.setFlag(F_C, sum > 0xFF);
    cpu.A = result;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function AND(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A & op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function ORA(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A | op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function EOR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.A = (cpu.A ^ op.value) & 0xFF;
    cpu.setZN(cpu.A);
    return op.pageCrossed ? 1 : 0;
  }

  function ASL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = (op.value << 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function LSR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = (op.value >> 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function ROL(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x80) !== 0);
    const result = ((op.value << 1) | c) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function ROR(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const c = cpu.getFlag(F_C) ? 1 : 0;
    cpu.setFlag(F_C, (op.value & 0x01) !== 0);
    const result = ((op.value >> 1) | (c << 7)) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function INC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value + 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function DEC(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    const result = (op.value - 1) & 0xFF;
    cpu.setZN(result);
    cpu.writeOperand(mode, op.addr, result);
    return 0;
  }

  function compare(cpu, reg, value) {
    const result = (reg - value) & 0x1FF;
    cpu.setFlag(F_C, reg >= value);
    cpu.setZN(result & 0xFF);
  }
  function CMP(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.A, op.value); return op.pageCrossed ? 1 : 0; }
  function CPX(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.X, op.value); return 0; }
  function CPY(cpu, mode) { const op = cpu.fetchOperand(mode); compare(cpu, cpu.Y, op.value); return 0; }

  function BIT(cpu, mode) {
    const op = cpu.fetchOperand(mode);
    cpu.setFlag(F_Z, (cpu.A & op.value) === 0);
    cpu.setFlag(F_V, (op.value & 0x40) !== 0);
    cpu.setFlag(F_N, (op.value & 0x80) !== 0);
    return 0;
  }

  function branch(cpu, mode, cond) {
    const op = cpu.fetchOperand(mode);
    if (!cond) return 0;
    const offset = op.addr < 0x80 ? op.addr : op.addr - 0x100;
    const oldPC = cpu.PC;
    cpu.PC = (cpu.PC + offset) & 0xFFFF;
    const pageCrossed = (oldPC & 0xFF00) !== (cpu.PC & 0xFF00);
    return pageCrossed ? 2 : 1;
  }

  function LDA(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.A = op.value; cpu.setZN(cpu.A); return op.pageCrossed ? 1 : 0; }
  function LDX(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.X = op.value; cpu.setZN(cpu.X); return op.pageCrossed ? 1 : 0; }
  function LDY(cpu, mode) { const op = cpu.fetchOperand(mode); cpu.Y = op.value; cpu.setZN(cpu.Y); return op.pageCrossed ? 1 : 0; }

  function STA(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.A); return 0; }
  function STX(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.X); return 0; }
  function STY(cpu, mode) { const op = cpu.fetchOperand(mode, true); cpu.write(op.addr, cpu.Y); return 0; }

  function JMP(cpu, mode) {
    if (mode === 'abs') {
      cpu.PC = cpu.read16(cpu.PC);
    } else { // ind
      const ptr = cpu.read16(cpu.PC);
      cpu.PC = cpu.read16Bug(ptr);
    }
    return 0;
  }

  function JSR(cpu) {
    const target = cpu.read16(cpu.PC);
    const ret = (cpu.PC + 1) & 0xFFFF; // JSR命令最後のバイトのアドレス
    cpu.push((ret >> 8) & 0xFF);
    cpu.push(ret & 0xFF);
    cpu.PC = target;
    return 0;
  }

  function RTS(cpu) {
    const lo = cpu.pop();
    const hi = cpu.pop();
    cpu.PC = ((hi << 8) | lo) + 1;
    cpu.PC &= 0xFFFF;
    return 0;
  }

  function BRK(cpu) {
    cpu.PC = (cpu.PC + 1) & 0xFFFF;
    cpu.push((cpu.PC >> 8) & 0xFF);
    cpu.push(cpu.PC & 0xFF);
    cpu.push(cpu.P | F_B | F_U);
    cpu.setFlag(F_I, true);
    cpu.PC = cpu.read16(0xFFFE);
    return 0;
  }

  function RTI(cpu) {
    cpu.P = (cpu.pop() | F_U) & ~F_B;
    const lo = cpu.pop();
    const hi = cpu.pop();
    cpu.PC = (hi << 8) | lo;
    return 0;
  }

  function PHA(cpu) { cpu.push(cpu.A); return 0; }
  function PHP(cpu) { cpu.push(cpu.P | F_B | F_U); return 0; }
  function PLA(cpu) { cpu.A = cpu.pop(); cpu.setZN(cpu.A); return 0; }
  function PLP(cpu) { cpu.P = (cpu.pop() | F_U) & ~F_B; return 0; }

  function TAX(cpu) { cpu.X = cpu.A; cpu.setZN(cpu.X); return 0; }
  function TAY(cpu) { cpu.Y = cpu.A; cpu.setZN(cpu.Y); return 0; }
  function TXA(cpu) { cpu.A = cpu.X; cpu.setZN(cpu.A); return 0; }
  function TYA(cpu) { cpu.A = cpu.Y; cpu.setZN(cpu.A); return 0; }
  function TSX(cpu) { cpu.X = cpu.S; cpu.setZN(cpu.X); return 0; }
  function TXS(cpu) { cpu.S = cpu.X; return 0; }

  function INX(cpu) { cpu.X = (cpu.X + 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function INY(cpu) { cpu.Y = (cpu.Y + 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }
  function DEX(cpu) { cpu.X = (cpu.X - 1) & 0xFF; cpu.setZN(cpu.X); return 0; }
  function DEY(cpu) { cpu.Y = (cpu.Y - 1) & 0xFF; cpu.setZN(cpu.Y); return 0; }

  function SEC(cpu) { cpu.setFlag(F_C, true); return 0; }
  function CLC(cpu) { cpu.setFlag(F_C, false); return 0; }
  function SEI(cpu) { cpu.setFlag(F_I, true); return 0; }
  function CLI(cpu) { cpu.setFlag(F_I, false); return 0; }
  function SED(cpu) { cpu.setFlag(F_D, true); return 0; }
  function CLD(cpu) { cpu.setFlag(F_D, false); return 0; }
  function CLV(cpu) { cpu.setFlag(F_V, false); return 0; }

  function NOP(cpu, mode) {
    if (mode !== 'impl') cpu.fetchOperand(mode); // オペランド読み飛ばし(通常未使用)
    return 0;
  }

  // mnemonic -> {mode: [opcodeByte, cycles]}
  const TABLE = {
    ADC: { fn: ADC, modes: { imm: [0x69, 2], zp: [0x65, 3], zpx: [0x75, 4], abs: [0x6D, 4], absx: [0x7D, 4], absy: [0x79, 4], indx: [0x61, 6], indy: [0x71, 5] } },
    AND: { fn: AND, modes: { imm: [0x29, 2], zp: [0x25, 3], zpx: [0x35, 4], abs: [0x2D, 4], absx: [0x3D, 4], absy: [0x39, 4], indx: [0x21, 6], indy: [0x31, 5] } },
    ASL: { fn: ASL, modes: { acc: [0x0A, 2], zp: [0x06, 5], zpx: [0x16, 6], abs: [0x0E, 6], absx: [0x1E, 7] } },
    BCC: { fn: (c, m) => branch(c, m, !c.getFlag(F_C)), modes: { rel: [0x90, 2] } },
    BCS: { fn: (c, m) => branch(c, m, c.getFlag(F_C)), modes: { rel: [0xB0, 2] } },
    BEQ: { fn: (c, m) => branch(c, m, c.getFlag(F_Z)), modes: { rel: [0xF0, 2] } },
    BMI: { fn: (c, m) => branch(c, m, c.getFlag(F_N)), modes: { rel: [0x30, 2] } },
    BNE: { fn: (c, m) => branch(c, m, !c.getFlag(F_Z)), modes: { rel: [0xD0, 2] } },
    BPL: { fn: (c, m) => branch(c, m, !c.getFlag(F_N)), modes: { rel: [0x10, 2] } },
    BVC: { fn: (c, m) => branch(c, m, !c.getFlag(F_V)), modes: { rel: [0x50, 2] } },
    BVS: { fn: (c, m) => branch(c, m, c.getFlag(F_V)), modes: { rel: [0x70, 2] } },
    BIT: { fn: BIT, modes: { zp: [0x24, 3], abs: [0x2C, 4] } },
    BRK: { fn: BRK, modes: { impl: [0x00, 7] } },
    CLC: { fn: CLC, modes: { impl: [0x18, 2] } },
    CLD: { fn: CLD, modes: { impl: [0xD8, 2] } },
    CLI: { fn: CLI, modes: { impl: [0x58, 2] } },
    CLV: { fn: CLV, modes: { impl: [0xB8, 2] } },
    CMP: { fn: CMP, modes: { imm: [0xC9, 2], zp: [0xC5, 3], zpx: [0xD5, 4], abs: [0xCD, 4], absx: [0xDD, 4], absy: [0xD9, 4], indx: [0xC1, 6], indy: [0xD1, 5] } },
    CPX: { fn: CPX, modes: { imm: [0xE0, 2], zp: [0xE4, 3], abs: [0xEC, 4] } },
    CPY: { fn: CPY, modes: { imm: [0xC0, 2], zp: [0xC4, 3], abs: [0xCC, 4] } },
    DEC: { fn: DEC, modes: { zp: [0xC6, 5], zpx: [0xD6, 6], abs: [0xCE, 6], absx: [0xDE, 7] } },
    DEX: { fn: DEX, modes: { impl: [0xCA, 2] } },
    DEY: { fn: DEY, modes: { impl: [0x88, 2] } },
    EOR: { fn: EOR, modes: { imm: [0x49, 2], zp: [0x45, 3], zpx: [0x55, 4], abs: [0x4D, 4], absx: [0x5D, 4], absy: [0x59, 4], indx: [0x41, 6], indy: [0x51, 5] } },
    INC: { fn: INC, modes: { zp: [0xE6, 5], zpx: [0xF6, 6], abs: [0xEE, 6], absx: [0xFE, 7] } },
    INX: { fn: INX, modes: { impl: [0xE8, 2] } },
    INY: { fn: INY, modes: { impl: [0xC8, 2] } },
    JMP: { fn: JMP, modes: { abs: [0x4C, 3], ind: [0x6C, 5] } },
    JSR: { fn: JSR, modes: { abs: [0x20, 6] } },
    LDA: { fn: LDA, modes: { imm: [0xA9, 2], zp: [0xA5, 3], zpx: [0xB5, 4], abs: [0xAD, 4], absx: [0xBD, 4], absy: [0xB9, 4], indx: [0xA1, 6], indy: [0xB1, 5] } },
    LDX: { fn: LDX, modes: { imm: [0xA2, 2], zp: [0xA6, 3], zpy: [0xB6, 4], abs: [0xAE, 4], absy: [0xBE, 4] } },
    LDY: { fn: LDY, modes: { imm: [0xA0, 2], zp: [0xA4, 3], zpx: [0xB4, 4], abs: [0xAC, 4], absx: [0xBC, 4] } },
    LSR: { fn: LSR, modes: { acc: [0x4A, 2], zp: [0x46, 5], zpx: [0x56, 6], abs: [0x4E, 6], absx: [0x5E, 7] } },
    NOP: { fn: NOP, modes: { impl: [0xEA, 2] } },
    ORA: { fn: ORA, modes: { imm: [0x09, 2], zp: [0x05, 3], zpx: [0x15, 4], abs: [0x0D, 4], absx: [0x1D, 4], absy: [0x19, 4], indx: [0x01, 6], indy: [0x11, 5] } },
    PHA: { fn: PHA, modes: { impl: [0x48, 3] } },
    PHP: { fn: PHP, modes: { impl: [0x08, 3] } },
    PLA: { fn: PLA, modes: { impl: [0x68, 4] } },
    PLP: { fn: PLP, modes: { impl: [0x28, 4] } },
    ROL: { fn: ROL, modes: { acc: [0x2A, 2], zp: [0x26, 5], zpx: [0x36, 6], abs: [0x2E, 6], absx: [0x3E, 7] } },
    ROR: { fn: ROR, modes: { acc: [0x6A, 2], zp: [0x66, 5], zpx: [0x76, 6], abs: [0x6E, 6], absx: [0x7E, 7] } },
    RTI: { fn: RTI, modes: { impl: [0x40, 6] } },
    RTS: { fn: RTS, modes: { impl: [0x60, 6] } },
    SBC: { fn: SBC, modes: { imm: [0xE9, 2], zp: [0xE5, 3], zpx: [0xF5, 4], abs: [0xED, 4], absx: [0xFD, 4], absy: [0xF9, 4], indx: [0xE1, 6], indy: [0xF1, 5] } },
    SEC: { fn: SEC, modes: { impl: [0x38, 2] } },
    SED: { fn: SED, modes: { impl: [0xF8, 2] } },
    SEI: { fn: SEI, modes: { impl: [0x78, 2] } },
    STA: { fn: STA, modes: { zp: [0x85, 3], zpx: [0x95, 4], abs: [0x8D, 4], absx: [0x9D, 5], absy: [0x99, 5], indx: [0x81, 6], indy: [0x91, 6] } },
    STX: { fn: STX, modes: { zp: [0x86, 3], zpy: [0x96, 4], abs: [0x8E, 4] } },
    STY: { fn: STY, modes: { zp: [0x84, 3], zpx: [0x94, 4], abs: [0x8C, 4] } },
    TAX: { fn: TAX, modes: { impl: [0xAA, 2] } },
    TAY: { fn: TAY, modes: { impl: [0xA8, 2] } },
    TSX: { fn: TSX, modes: { impl: [0xBA, 2] } },
    TXA: { fn: TXA, modes: { impl: [0x8A, 2] } },
    TXS: { fn: TXS, modes: { impl: [0x9A, 2] } },
    TYA: { fn: TYA, modes: { impl: [0x98, 2] } }
  };

  // 256エントリのオペコードディスパッチテーブルを構築
  const OPS = new Array(256).fill(null);
  for (const mnemonic in TABLE) {
    const { fn, modes } = TABLE[mnemonic];
    for (const mode in modes) {
      const [byte, cycles] = modes[mode];
      OPS[byte] = { mnemonic, mode, exec: fn, cycles };
    }
  }

  Emu.CPU6502 = CPU6502;
  Emu.FLAGS = { C: F_C, Z: F_Z, I: F_I, D: F_D, B: F_B, U: F_U, V: F_V, N: F_N };
  Emu.OPS = OPS; // デバッグ/逆アセンブル用に公開
})(globalThis);

/*
 * RP2A03 内蔵音源（APU）エミュレータ
 * MML.Emu.APU2A03
 *
 * パルス波x2, 三角波, ノイズ, DPCM(DMC) の4チャンネルを実装。
 * clock() を1 CPUサイクルごとに呼び出し、mixSample() で現在の合成出力(0.0〜1.0)を取得する。
 * レジスタ $4000-$4017 への書き込みは writeRegister() で受け付ける。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];

  const TRIANGLE_SEQ = [
    15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
  ];

  // NTSC ノイズ周期テーブル（NESdev準拠。値=シフトレジスタ更新間のCPUサイクル数）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // NTSC DMC レート(タイマ周期)テーブル
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  class Envelope {
    constructor() {
      this.startFlag = false;
      this.divider = 0;
      this.decay = 0;
      this.loop = false;
      this.constant = false;
      this.volume = 0; // constant時の音量 or envelope period
    }
    clockQuarterFrame() {
      if (this.startFlag) {
        this.startFlag = false;
        this.decay = 15;
        this.divider = this.volume;
      } else if (this.divider > 0) {
        this.divider--;
      } else {
        this.divider = this.volume;
        if (this.decay > 0) this.decay--;
        else if (this.loop) this.decay = 15;
      }
    }
    output() {
      return this.constant ? this.volume : this.decay;
    }
  }

  class PulseChannel {
    constructor(channelNum) {
      this.channelNum = channelNum; // 1 or 2 (スイープの符号反転に使用)
      this.enabled = false;
      this.duty = 0;
      this.dutyStep = 0;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.timerPeriod = 0;
      this.timer = 0;
      this.envelope = new Envelope();
      // スイープ
      this.sweepEnabled = false;
      this.sweepPeriod = 0;
      this.sweepDivider = 0;
      this.sweepNegate = false;
      this.sweepShift = 0;
      this.sweepReload = false;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4000/$4004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.envelope.loop = this.lengthCounterHalt;
          this.envelope.constant = (value & 0x10) !== 0;
          this.envelope.volume = value & 0x0F;
          break;
        case 1: // $4001/$4005
          this.sweepEnabled = (value & 0x80) !== 0;
          this.sweepPeriod = (value >> 4) & 0x07;
          this.sweepNegate = (value & 0x08) !== 0;
          this.sweepShift = value & 0x07;
          this.sweepReload = true;
          break;
        case 2: // $4002/$4006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $4003/$4007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envelope.startFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      this.envelope.clockQuarterFrame();
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;

      if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0) {
        const target = this.sweepTarget();
        if (target <= 0x7FF) this.timerPeriod = target;
      }
      if (this.sweepDivider === 0 || this.sweepReload) {
        this.sweepDivider = this.sweepPeriod;
        this.sweepReload = false;
      } else {
        this.sweepDivider--;
      }
    }

    sweepTarget() {
      const change = this.timerPeriod >> this.sweepShift;
      if (this.sweepNegate) {
        // パルス1は1の補数(さらに-1)、パルス2は2の補数
        return this.timerPeriod - change - (this.channelNum === 1 ? 1 : 0);
      }
      return this.timerPeriod + change;
    }

    isMuted() {
      return this.timerPeriod < 8 || this.sweepTarget() > 0x7FF;
    }

    output() {
      if (!this.enabled || this.lengthCounter === 0 || this.isMuted()) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.envelope.output();
    }
  }

  class TriangleChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.linearCounterReload = 0;
      this.linearCounter = 0;
      this.linearReloadFlag = false;
      this.timerPeriod = 0;
      this.timer = 0;
      // 初期位相は出力0の位置(TRIANGLE_SEQ[16]=0)に置く。消音時も最後の値を保持する仕様上、
      // seqStep=0(=最大値15)で始めると再生開始時に 0→15 のDC段差が生じプチノイズになるため。
      // 16 から進むと 0,1,2… と滑らかに立ち上がる。
      this.seqStep = 16;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4008
          this.lengthCounterHalt = (value & 0x80) !== 0;
          this.linearCounterReload = value & 0x7F;
          break;
        case 2: // $400A
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $400B
          // 実機の三角波はレジスタ書き込みでシーケンサ位相をリセットしない。
          // 位相を保持したまま発音を再開することで、音符の頭でのプチノイズ(位相跳躍)を防ぐ。
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.linearReloadFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        // 消音中(linear/length=0)や超音波域(period<2)はシーケンサを停止し、
        // 最後の位相＝最後の出力値をそのまま保持する（実機と同じ挙動）。
        if (this.linearCounter > 0 && this.lengthCounter > 0 && this.timerPeriod >= 2) {
          this.seqStep = (this.seqStep + 1) & 31;
        }
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      if (this.linearReloadFlag) this.linearCounter = this.linearCounterReload;
      else if (this.linearCounter > 0) this.linearCounter--;
      if (!this.lengthCounterHalt) this.linearReloadFlag = false;
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }

    output() {
      // 消音時も最後のシーケンサ値(DC)を保持する。0へ落とすと音符境界で段差が生じ、
      // プチノイズになる。保持したDC成分は出力段のDCブロッカー(Emu.dcBlock)が除去する。
      return TRIANGLE_SEQ[this.seqStep];
    }
  }

  class NoiseChannel {
    constructor() {
      this.enabled = false;
      this.lengthCounterHalt = false;
      this.lengthCounter = 0;
      this.envelope = new Envelope();
      this.modeFlag = false;
      this.timerPeriod = (NOISE_PERIOD[0] >> 1) - 1;
      this.timer = 0;
      this.shiftReg = 1;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $400C
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.envelope.loop = this.lengthCounterHalt;
          this.envelope.constant = (value & 0x10) !== 0;
          this.envelope.volume = value & 0x0F;
          break;
        case 2: // $400E
          this.modeFlag = (value & 0x80) !== 0;
          // テーブル値はCPUサイクル周期。ノイズタイマはAPUサイクル(2 CPU)ごとに進むので÷2し、
          // カウンタは0到達で発火(reload+1周期)するため -1 する → 実効LFSR周期 = テーブル値CPUサイクル。
          this.timerPeriod = (NOISE_PERIOD[value & 0x0F] >> 1) - 1;
          break;
        case 3: // $400F
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.envelope.startFlag = true;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        const bit0 = this.shiftReg & 1;
        const other = this.modeFlag ? ((this.shiftReg >> 6) & 1) : ((this.shiftReg >> 1) & 1);
        const feedback = bit0 ^ other;
        this.shiftReg = (this.shiftReg >> 1) | (feedback << 14);
      } else {
        this.timer--;
      }
    }

    clockQuarterFrame() {
      this.envelope.clockQuarterFrame();
    }

    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }

    output() {
      if (!this.enabled || this.lengthCounter === 0 || (this.shiftReg & 1) === 1) return 0;
      return this.envelope.output();
    }
  }

  class DmcChannel {
    constructor(bus) {
      this.bus = bus;
      this.enabled = false;
      this.irqEnable = false;
      this.loop = false;
      this.rate = DMC_RATE[0];
      this.timer = 0;
      this.outputLevel = 0;
      this.sampleAddr = 0xC000;
      this.sampleLength = 0;
      this.currentAddr = 0xC000;
      this.bytesRemaining = 0;
      this.sampleBuffer = null;
      this.bitsRemaining = 0;
      this.shiftReg = 0;
      this.silence = true;
      this.irqFlag = false;
      // ── DAC振幅(体感音量)の計測 ──────────────────────────────
      // $4011/outputLevel は「波形の現在位置」であって音量ではない(実測: SMB3のスネアは
      // 減衰しても現在値の中央値は46のまま動かない)。1フレーム分のDAC値の振幅(peak-to-peak)を
      // 取ると体感音量そのものになる(ミックス全体の実振幅との相関 r=0.91、$4011直書きスピーチで
      // r=0.99)。DPCMサンプル再生と$4011直書きのどちらも同じ扱いで測れる。
      this.ampMin = 127; this.ampMax = 0; this.ampCount = 0;
      this.ampLast = 0; // 直近の計測窓の値(窓が空のまま読まれても直前値を保つ)
      // キーオン通番: $4015 bit4 でサンプル再生が始まるたびに +1。ロールのドラム区画が
      // 「同じサンプルの連打」を1本に融合させない区切りに使う(VGMのサンプルPCMの seq と同じ役割)
      this.seq = 0;
    }

    writeReg(index, value) {
      switch (index) {
        case 0: // $4010
          this.irqEnable = (value & 0x80) !== 0;
          this.loop = (value & 0x40) !== 0;
          this.rate = DMC_RATE[value & 0x0F];
          if (!this.irqEnable) this.irqFlag = false;
          break;
        case 1: // $4011
          this.outputLevel = value & 0x7F;
          // 直書きPCM(スピーチ)もDACが動く。振幅計測に含める
          if (this.outputLevel < this.ampMin) this.ampMin = this.outputLevel;
          if (this.outputLevel > this.ampMax) this.ampMax = this.outputLevel;
          this.ampCount++;
          break;
        case 2: // $4012
          this.sampleAddr = 0xC000 + (value * 64);
          break;
        case 3: // $4013
          this.sampleLength = (value * 16) + 1;
          break;
      }
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) {
        this.bytesRemaining = 0;
      } else if (this.bytesRemaining === 0) {
        this.currentAddr = this.sampleAddr;
        this.bytesRemaining = this.sampleLength;
        this.seq++;
      }
    }

    clockTimer() {
      if (this.timer === 0) {
        this.timer = this.rate;
        this.clockOutput();
      } else {
        this.timer--;
      }
    }

    clockOutput() {
      if (this.bitsRemaining === 0) {
        this.bitsRemaining = 8;
        if (this.bytesRemaining > 0 && this.bus) {
          this.shiftReg = this.bus.read(this.currentAddr);
          this.silence = false;
          this.currentAddr = (this.currentAddr + 1) & 0xFFFF;
          if (this.currentAddr > 0xFFFF || this.currentAddr === 0x0000) this.currentAddr = 0x8000;
          this.bytesRemaining--;
          if (this.bytesRemaining === 0) {
            if (this.loop) {
              this.currentAddr = this.sampleAddr;
              this.bytesRemaining = this.sampleLength;
            } else if (this.irqEnable) {
              this.irqFlag = true;
            }
          }
        } else {
          this.silence = true;
        }
      }
      if (!this.silence) {
        if (this.shiftReg & 1) {
          if (this.outputLevel <= 125) this.outputLevel += 2;
        } else {
          if (this.outputLevel >= 2) this.outputLevel -= 2;
        }
        this.shiftReg >>= 1;
      }
      // 体感音量(DAC振幅)の計測。毎CPUサイクルではなくDACが動きうるここだけで拾う
      // (毎サイクル版はキャプチャが実測+10%重くなった)。無音中もここは回るので
      // 「動いていない=振幅0=無音」も正しく出る。
      if (this.outputLevel < this.ampMin) this.ampMin = this.outputLevel;
      if (this.outputLevel > this.ampMax) this.ampMax = this.outputLevel;
      this.ampCount++;
      this.bitsRemaining--;
    }

    /**
     * 前回の呼び出しからのDAC振幅(peak-to-peak, 0〜127)を返して計測窓をリセットする。
     * これがDPCMの体感音量。窓が空(前回から1サイクルも進んでいない)なら直前の値を返す。
     */
    takeAmplitude() {
      if (this.ampCount > 0) {
        this.ampLast = this.ampMax >= this.ampMin ? this.ampMax - this.ampMin : 0;
        this.ampMin = 127; this.ampMax = 0; this.ampCount = 0;
      }
      return this.ampLast;
    }

    output() {
      return this.outputLevel;
    }
  }

  class APU2A03 {
    /**
     * @param {{read:(addr:number)=>number}} [bus] - DMCのサンプルデータ読み出しに使用
     */
    constructor(bus) {
      this.pulse1 = new PulseChannel(1);
      this.pulse2 = new PulseChannel(2);
      this.triangle = new TriangleChannel();
      this.noise = new NoiseChannel();
      this.dmc = new DmcChannel(bus || null);

      this.frameCounter = 0;
      this.frameMode5Step = false;
      this.frameIrqInhibit = false;
      this.frameIrqFlag = false;
      this.cycleParity = 0; // 0/1 交互（パルス・ノイズ・DMCはAPUサイクル=CPU2サイクルごと）

      // チャンネルごとのミュート設定（再生ON/OFF）
      this.mute = { pulse1: false, pulse2: false, triangle: false, noise: false, dmc: false };
      // チャンネルごとの音量(0〜1、既定1=無調整)。鍵盤表示のch別音量バー用(src/ui/keyboard.js)
      this.vol = { pulse1: 1, pulse2: 1, triangle: 1, noise: 1, dmc: 1 };
    }

    reset() {
      this.pulse1.setEnabled(false);
      this.pulse2.setEnabled(false);
      this.triangle.setEnabled(false);
      this.triangle.seqStep = 16; // 曲開始時は三角波を出力0の位相にして開始時DC段差を防ぐ
      this.noise.setEnabled(false);
      this.dmc.setEnabled(false);
      this.frameCounter = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x4000: case 0x4001: case 0x4002: case 0x4003:
          this.pulse1.writeReg(addr - 0x4000, value); break;
        case 0x4004: case 0x4005: case 0x4006: case 0x4007:
          this.pulse2.writeReg(addr - 0x4004, value); break;
        case 0x4008: case 0x4009: case 0x400A: case 0x400B:
          this.triangle.writeReg(addr - 0x4008, value); break;
        case 0x400C: case 0x400D: case 0x400E: case 0x400F:
          this.noise.writeReg(addr - 0x400C, value); break;
        case 0x4010: case 0x4011: case 0x4012: case 0x4013:
          this.dmc.writeReg(addr - 0x4010, value); break;
        case 0x4015:
          this.pulse1.setEnabled((value & 0x01) !== 0);
          this.pulse2.setEnabled((value & 0x02) !== 0);
          this.triangle.setEnabled((value & 0x04) !== 0);
          this.noise.setEnabled((value & 0x08) !== 0);
          this.dmc.setEnabled((value & 0x10) !== 0);
          if ((value & 0x10) === 0) this.dmc.irqFlag = false;
          break;
        case 0x4017:
          this.frameMode5Step = (value & 0x80) !== 0;
          this.frameIrqInhibit = (value & 0x40) !== 0;
          if (this.frameIrqInhibit) this.frameIrqFlag = false;
          this.frameCounter = 0;
          if (this.frameMode5Step) { this.clockQuarterFrame(); this.clockHalfFrame(); }
          break;
        default:
          // NSF方式のバンク切替($5FF8-$5FFF)はAPUのレジスタではないが、MMLのブラウザ再生では
          // DMCの読出し元(player.js/stream-player.js buildDpcmBus)のページ切替として使う(2026-09-10)
          if (addr >= 0x5FF8 && addr <= 0x5FFF && this.bus && this.bus.write) this.bus.write(addr, value);
          break;
      }
    }

    readStatus() {
      let v = 0;
      if (this.pulse1.lengthCounter > 0) v |= 0x01;
      if (this.pulse2.lengthCounter > 0) v |= 0x02;
      if (this.triangle.lengthCounter > 0) v |= 0x04;
      if (this.noise.lengthCounter > 0) v |= 0x08;
      if (this.dmc.bytesRemaining > 0) v |= 0x10;
      if (this.frameIrqFlag) v |= 0x40;
      if (this.dmc.irqFlag) v |= 0x80;
      this.frameIrqFlag = false;
      return v;
    }

    clockQuarterFrame() {
      this.pulse1.clockQuarterFrame();
      this.pulse2.clockQuarterFrame();
      this.triangle.clockQuarterFrame();
      this.noise.clockQuarterFrame();
    }

    clockHalfFrame() {
      this.pulse1.clockHalfFrame();
      this.pulse2.clockHalfFrame();
      this.triangle.clockHalfFrame();
      this.noise.clockHalfFrame();
    }

    // 1 CPUサイクル分進める
    clock() {
      // 三角波とDMCは毎CPUサイクル、パルス・ノイズはAPUサイクル(2 CPUサイクル)ごと。
      // DMC_RATE表はCPUサイクル単位の周期なので、DMCタイマもCPUクロックで進める
      // （APUサイクルで進めると周期が2倍=再生速度・音程が半分になる）。
      this.triangle.clockTimer();
      this.dmc.clockTimer();
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clockTimer();
        this.pulse2.clockTimer();
        this.noise.clockTimer();
      }

      this.frameCounter++;
      if (!this.frameMode5Step) {
        switch (this.frameCounter) {
          case 7457: this.clockQuarterFrame(); break;
          case 14913: this.clockQuarterFrame(); this.clockHalfFrame(); break;
          case 22371: this.clockQuarterFrame(); break;
          case 29829:
            this.clockQuarterFrame();
            this.clockHalfFrame();
            if (!this.frameIrqInhibit) this.frameIrqFlag = true;
            this.frameCounter = 0;
            break;
        }
      } else {
        switch (this.frameCounter) {
          case 7457: this.clockQuarterFrame(); break;
          case 14913: this.clockQuarterFrame(); this.clockHalfFrame(); break;
          case 22371: this.clockQuarterFrame(); break;
          case 37281:
            this.clockQuarterFrame();
            this.clockHalfFrame();
            this.frameCounter = 0;
            break;
        }
      }
    }

    /**
     * 現在の出力レベルを 0.0〜1.0 で取得する（NESの非線形ミキサー近似）
     */
    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : this.pulse1.output() * this.vol.pulse1;
      const p2 = this.mute.pulse2 ? 0 : this.pulse2.output() * this.vol.pulse2;
      const tri = this.mute.triangle ? 0 : this.triangle.output() * this.vol.triangle;
      const noi = this.mute.noise ? 0 : this.noise.output() * this.vol.noise;
      const dmc = this.mute.dmc ? 0 : this.dmc.output() * this.vol.dmc;

      let pulseOut = 0;
      if (p1 + p2 > 0) pulseOut = 95.88 / (8128 / (p1 + p2) + 100);

      let tndOut = 0;
      const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
      if (tndSum > 0) tndOut = 159.79 / (1 / tndSum + 100);

      return pulseOut + tndOut; // おおよそ 0.0 〜 1.16
    }
  }

  Emu.APU2A03 = APU2A03;
  Emu.LENGTH_TABLE = LENGTH_TABLE;
})(globalThis);

/*
 * VRC6 拡張音源エミュレータ
 * MML.Emu.VRC6Audio
 *
 * パルス x2 ($9000-$9002 / $A000-$A002) + 矩形波(サウ) ($B000-$B002)
 * パルスはデューティ比1/16刻みで指定可能(0=幅1/16 ... 15=幅16/16)。
 * サウ(sawtooth)はNESdev準拠の14ステップアキュムレータ実装(Vrc6Saw.clock()参照)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  class Vrc6Pulse {
    constructor() {
      this.duty = 0;
      this.volume = 0;
      this.digitized = false;
      this.enabled = false;
      this.period = 0;
      this.timer = 0;
      this.step = 15; // dutyカウンタは 15→0 のダウンカウント。先頭=15
    }
    writeCtrl(value) {
      this.duty = (value >> 4) & 0x07;
      this.volume = value & 0x0F;
      this.digitized = (value & 0x80) !== 0;
    }
    writePeriodLo(value) {
      this.period = (this.period & 0x0F00) | value;
    }
    writePeriodHi(value) {
      this.period = (this.period & 0x00FF) | ((value & 0x0F) << 8);
      this.enabled = (value & 0x80) !== 0;
      // NESdev: E=0 で duty カウンタを即リセット＋停止（再有効化で先頭から）
      if (!this.enabled) { this.step = 15; this.timer = 0; }
    }
    clock() {
      if (!this.enabled) return; // 無効時は停止（カウンタを進めない）
      if (this.timer === 0) {
        this.timer = this.period;
        this.step = (this.step - 1) & 0x0F; // 15→0 ダウンカウント
      } else {
        this.timer--;
      }
    }
    output() {
      if (!this.enabled) return 0;
      if (this.digitized) return this.volume;
      return (this.step <= this.duty) ? this.volume : 0;
    }
  }

  class Vrc6Saw {
    constructor() {
      this.accumRate = 0;
      this.accum = 0;
      this.enabled = false;
      this.period = 0;
      this.timer = 0;
      this.step = 0; // 14ステップ周期のカウンタ (0-13)
    }
    writeCtrl(value) {
      this.accumRate = value & 0x3F;
    }
    writePeriodLo(value) {
      this.period = (this.period & 0x0F00) | value;
    }
    writePeriodHi(value) {
      this.period = (this.period & 0x00FF) | ((value & 0x0F) << 8);
      this.enabled = (value & 0x80) !== 0;
    }
    // NESdev準拠: タイマは1 CPUサイクルごと。14ステップ周期で、偶数ステップに accumRate を
    // 6回加算し、14ステップ目で加算せずアキュムレータを0リセット（＝7段のこぎり波、f=CPU/(14*(t+1))）。
    clock() {
      if (!this.enabled) { this.accum = 0; return; } // E=0 でアキュムレータ0固定
      if (this.timer === 0) {
        this.timer = this.period;
        this.step++;
        if (this.step >= 14) {
          this.step = 0;
          this.accum = 0;                 // 7回目の作用クロック = リセット
        } else if ((this.step & 1) === 0) {
          this.accum = (this.accum + this.accumRate) & 0xFF; // 偶数ステップで加算(計6回)
        }
      } else {
        this.timer--;
      }
    }
    output() {
      if (!this.enabled) return 0;
      return (this.accum >> 3) & 0x1F; // 上位5bit (0-31)
    }
  }

  class VRC6Audio {
    constructor() {
      this.pulse1 = new Vrc6Pulse();
      this.pulse2 = new Vrc6Pulse();
      this.saw = new Vrc6Saw();
      this.mute = { pulse1: false, pulse2: false, saw: false };
      this.vol = { pulse1: 1, pulse2: 1, saw: 1 };
    }

    reset() {
      this.pulse1 = new Vrc6Pulse();
      this.pulse2 = new Vrc6Pulse();
      this.saw = new Vrc6Saw();
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      switch (addr) {
        case 0x9000: this.pulse1.writeCtrl(value); break;
        case 0x9001: this.pulse1.writePeriodLo(value); break;
        case 0x9002: this.pulse1.writePeriodHi(value); break;
        case 0xA000: this.pulse2.writeCtrl(value); break;
        case 0xA001: this.pulse2.writePeriodLo(value); break;
        case 0xA002: this.pulse2.writePeriodHi(value); break;
        case 0xB000: this.saw.writeCtrl(value); break;
        case 0xB001: this.saw.writePeriodLo(value); break;
        case 0xB002: this.saw.writePeriodHi(value); break;
      }
    }

    clock() {
      this.pulse1.clock();
      this.pulse2.clock();
      this.saw.clock();
    }

    // 0.0 ~ 約0.65 (2A03と同程度のレベル感)
    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : (this.pulse1.output() / 15) * this.vol.pulse1;   // 0-1
      const p2 = this.mute.pulse2 ? 0 : (this.pulse2.output() / 15) * this.vol.pulse2;   // 0-1
      const sw = this.mute.saw ? 0 : (this.saw.output() / 31) * this.vol.saw;         // 0-1
      return (p1 + p2 + sw) * 0.2;
    }
  }

  Emu.VRC6Audio = VRC6Audio;
})(globalThis);

/*
 * OPLL (Yamaha YM2413 / Konami VRC VII = DS1001) サイクルアキュレート・エミュレータ
 * MML.Emu.OPLLNuked
 *
 * nukeykt/Nuked-OPLL (opll.c v1.0.2, GPLv2, Copyright (C) 2019-2023 Nuke.YKT) の移植。
 * 音色ROM・アルゴリズムとも siliconpr0n (digshadow, John McMaster) による
 * VRC VII decap / die shot 由来。本リポジトリもGPLv2なのでライセンス上の問題は無い。
 *
 * 従来の emu2413 0.6x系移植(vrc7.js / opllMsx.js)との違い:
 *   - 演算器が1個しか無い実チップの18スロット時分割パイプラインをそのまま再現する。
 *     1サンプル = 18サイクル、各サイクルが1スロットぶんの演算と1chぶんのDAC出力を担う。
 *   - EGは位相蓄積(dphaseARTable等の近似)ではなく、実機のeg_timer + シフト量テーブル方式。
 *     キーオン時のDAMP(rate12まで一旦落としてからアタック)も含む。
 *   - AM/PM LFOがfloat sin近似ではなく実機の整数カウンタ/テーブル。
 *   - 出力は9bit相当の時分割DACをそのまま合算するため、実機特有の量子化感が出る。
 *
 * チップ種別 (constructor の opts.chipType):
 *   'ds1001'(VRC7): 6メロディch、リズムモード無し(rhythm常時0x20)、音色ROM=patch_ds1001。
 *   'ym2413'(FMPAC/VGM、既定): 9メロディch、リズムモード有り、音色ROM=patch_ym2413。
 *
 * クロック: clock() は「呼び出し側のホストクロック1サイクル」ごとに呼ぶ。OPLLの1内部
 * サイクルは実チップのマスタクロック4個ぶんなので、
 *   VRC7 (NSF)      : ホスト=NES CPU 1.789773MHz = マスタ/2 → 2ホストサイクルで1内部サイクル
 *   FMPAC/VGM       : ホスト=3.579545MHz = マスタそのもの   → 4ホストサイクルで1内部サイクル
 * どちらも 18内部サイクル = 1サンプル で 49716Hz になる(36 / 72 ホストサイクル)。
 * ★この非対称は [[opll-fmpac-clock-divider-octave-bug]] と同じ理由。取り違えると1オクターブずれる。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // ---- EG状態 ----
  const EG_ATTACK = 0, EG_DECAY = 1, EG_SUSTAIN = 2, EG_RELEASE = 3;
  // ---- リズムスロット選択 ----
  const RM_BD0 = 0, RM_HH = 1, RM_TOM = 2, RM_BD1 = 3, RM_SD = 4, RM_TC = 5;
  const PATCH_DRUM_0 = 15; // patchrom内のドラム音色開始index

  const SAMPLE_RATE = 49716;
  const CYCLES_PER_SAMPLE = 18; // OPLL内部サイクル/サンプル

  const LOGSIN = new Uint16Array([
    0x859,0x6c3,0x607,0x58b,0x52e,0x4e4,0x4a6,0x471,0x443,0x41a,0x3f5,0x3d3,0x3b5,0x398,0x37e,
    0x365,0x34e,0x339,0x324,0x311,0x2ff,0x2ed,0x2dc,0x2cd,0x2bd,0x2af,0x2a0,0x293,0x286,0x279,
    0x26d,0x261,0x256,0x24b,0x240,0x236,0x22c,0x222,0x218,0x20f,0x206,0x1fd,0x1f5,0x1ec,0x1e4,
    0x1dc,0x1d4,0x1cd,0x1c5,0x1be,0x1b7,0x1b0,0x1a9,0x1a2,0x19b,0x195,0x18f,0x188,0x182,0x17c,
    0x177,0x171,0x16b,0x166,0x160,0x15b,0x155,0x150,0x14b,0x146,0x141,0x13c,0x137,0x133,0x12e,
    0x129,0x125,0x121,0x11c,0x118,0x114,0x10f,0x10b,0x107,0x103,0x0ff,0x0fb,0x0f8,0x0f4,0x0f0,
    0x0ec,0x0e9,0x0e5,0x0e2,0x0de,0x0db,0x0d7,0x0d4,0x0d1,0x0cd,0x0ca,0x0c7,0x0c4,0x0c1,0x0be,
    0x0bb,0x0b8,0x0b5,0x0b2,0x0af,0x0ac,0x0a9,0x0a7,0x0a4,0x0a1,0x09f,0x09c,0x099,0x097,0x094,
    0x092,0x08f,0x08d,0x08a,0x088,0x086,0x083,0x081,0x07f,0x07d,0x07a,0x078,0x076,0x074,0x072,
    0x070,0x06e,0x06c,0x06a,0x068,0x066,0x064,0x062,0x060,0x05e,0x05c,0x05b,0x059,0x057,0x055,
    0x053,0x052,0x050,0x04e,0x04d,0x04b,0x04a,0x048,0x046,0x045,0x043,0x042,0x040,0x03f,0x03e,
    0x03c,0x03b,0x039,0x038,0x037,0x035,0x034,0x033,0x031,0x030,0x02f,0x02e,0x02d,0x02b,0x02a,
    0x029,0x028,0x027,0x026,0x025,0x024,0x023,0x022,0x021,0x020,0x01f,0x01e,0x01d,0x01c,0x01b,
    0x01a,0x019,0x018,0x017,0x017,0x016,0x015,0x014,0x014,0x013,0x012,0x011,0x011,0x010,0x00f,
    0x00f,0x00e,0x00d,0x00d,0x00c,0x00c,0x00b,0x00a,0x00a,0x009,0x009,0x008,0x008,0x007,0x007,
    0x007,0x006,0x006,0x005,0x005,0x005,0x004,0x004,0x004,0x003,0x003,0x003,0x002,0x002,0x002,
    0x002,0x001,0x001,0x001,0x001,0x001,0x001,0x001,0x000,0x000,0x000,0x000,0x000,0x000,0x000,
    0x000
  ]);

  const EXPROM = new Uint16Array([
    0x7fa,0x7f5,0x7ef,0x7ea,0x7e4,0x7df,0x7da,0x7d4,0x7cf,0x7c9,0x7c4,0x7bf,0x7b9,0x7b4,0x7ae,
    0x7a9,0x7a4,0x79f,0x799,0x794,0x78f,0x78a,0x784,0x77f,0x77a,0x775,0x770,0x76a,0x765,0x760,
    0x75b,0x756,0x751,0x74c,0x747,0x742,0x73d,0x738,0x733,0x72e,0x729,0x724,0x71f,0x71a,0x715,
    0x710,0x70b,0x706,0x702,0x6fd,0x6f8,0x6f3,0x6ee,0x6e9,0x6e5,0x6e0,0x6db,0x6d6,0x6d2,0x6cd,
    0x6c8,0x6c4,0x6bf,0x6ba,0x6b5,0x6b1,0x6ac,0x6a8,0x6a3,0x69e,0x69a,0x695,0x691,0x68c,0x688,
    0x683,0x67f,0x67a,0x676,0x671,0x66d,0x668,0x664,0x65f,0x65b,0x657,0x652,0x64e,0x649,0x645,
    0x641,0x63c,0x638,0x634,0x630,0x62b,0x627,0x623,0x61e,0x61a,0x616,0x612,0x60e,0x609,0x605,
    0x601,0x5fd,0x5f9,0x5f5,0x5f0,0x5ec,0x5e8,0x5e4,0x5e0,0x5dc,0x5d8,0x5d4,0x5d0,0x5cc,0x5c8,
    0x5c4,0x5c0,0x5bc,0x5b8,0x5b4,0x5b0,0x5ac,0x5a8,0x5a4,0x5a0,0x59c,0x599,0x595,0x591,0x58d,
    0x589,0x585,0x581,0x57e,0x57a,0x576,0x572,0x56f,0x56b,0x567,0x563,0x560,0x55c,0x558,0x554,
    0x551,0x54d,0x549,0x546,0x542,0x53e,0x53b,0x537,0x534,0x530,0x52c,0x529,0x525,0x522,0x51e,
    0x51b,0x517,0x514,0x510,0x50c,0x509,0x506,0x502,0x4ff,0x4fb,0x4f8,0x4f4,0x4f1,0x4ed,0x4ea,
    0x4e7,0x4e3,0x4e0,0x4dc,0x4d9,0x4d6,0x4d2,0x4cf,0x4cc,0x4c8,0x4c5,0x4c2,0x4be,0x4bb,0x4b8,
    0x4b5,0x4b1,0x4ae,0x4ab,0x4a8,0x4a4,0x4a1,0x49e,0x49b,0x498,0x494,0x491,0x48e,0x48b,0x488,
    0x485,0x482,0x47e,0x47b,0x478,0x475,0x472,0x46f,0x46c,0x469,0x466,0x463,0x460,0x45d,0x45a,
    0x457,0x454,0x451,0x44e,0x44b,0x448,0x445,0x442,0x43f,0x43c,0x439,0x436,0x433,0x430,0x42d,
    0x42a,0x428,0x425,0x422,0x41f,0x41c,0x419,0x416,0x414,0x411,0x40e,0x40b,0x408,0x406,0x403,
    0x400
  ]);

  const CH_OFFSET = new Uint8Array([1, 2, 0, 1, 2, 3, 4, 5, 3, 4, 5, 6, 7, 8, 6, 7, 8, 0]);
  const PG_MULTI = new Uint8Array([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30]);
  const EG_STEPHI = [
    new Uint8Array([0, 0, 0, 0]),
    new Uint8Array([1, 0, 0, 0]),
    new Uint8Array([1, 0, 1, 0]),
    new Uint8Array([1, 1, 1, 0])
  ];
  const EG_KSLTABLE = new Uint8Array([0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64]);

  // PATCH_DS1001
  const PATCH_DS1001 = [
    { tl: 5, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[0,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[14, 8], dr:[ 8, 1], sl:[ 4, 2], rr:[ 2, 7] }, // @1
    { tl:20, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 6], sl:[ 2, 1], rr:[ 3, 2] }, // @2
    { tl: 8, dc:0, dm:1, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,1], multi:[ 1, 1], ksl:[0,0], ar:[15,11], dr:[10, 2], sl:[ 2, 1], rr:[ 0, 2] }, // @3
    { tl:12, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 6, 2], rr:[ 1, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 1, 6], sl:[ 0, 2], rr:[ 1, 8] }, // @5
    { tl: 6, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 2, 1], ksl:[0,0], ar:[10,14], dr:[ 3, 2], sl:[15,15], rr:[ 4, 4] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 1, 7] }, // @7
    { tl:34, dc:1, dm:0, fb:7, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 1], rr:[ 1, 7] }, // @8
    { tl:37, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[1,0], ksr:[1,1], multi:[ 5, 1], ksl:[0,0], ar:[ 4, 7], dr:[ 0, 3], sl:[ 7, 0], rr:[ 2, 1] }, // @9
    { tl:15, dc:0, dm:1, fb:7, am:[1,0], vib:[0,0], et:[1,0], ksr:[1,0], multi:[ 5, 1], ksl:[0,0], ar:[10,10], dr:[ 8, 5], sl:[ 5, 0], rr:[ 1, 2] }, // @10
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @11
    { tl:17, dc:0, dm:0, fb:6, am:[0,0], vib:[1,0], et:[1,1], ksr:[1,0], multi:[ 1, 3], ksl:[0,0], ar:[ 6, 7], dr:[ 5, 4], sl:[ 1, 1], rr:[ 8, 6] }, // @12
    { tl:19, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 2], ksl:[3,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @13
    { tl:12, dc:0, dm:0, fb:0, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 3], ksl:[0,0], ar:[ 9,12], dr:[ 4, 0], sl:[ 3,15], rr:[ 3, 6] }, // @14
    { tl:13, dc:0, dm:0, fb:0, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,1], multi:[ 1, 2], ksl:[0,0], ar:[12,13], dr:[ 1, 5], sl:[ 5, 0], rr:[ 6, 6] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // PATCH_YM2413
  const PATCH_YM2413 = [
    { tl:30, dc:1, dm:0, fb:7, am:[0,0], vib:[1,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[13, 7], dr:[ 0, 8], sl:[ 0, 1], rr:[ 0, 7] }, // @1
    { tl:26, dc:0, dm:1, fb:5, am:[0,0], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[0,0], ar:[13,15], dr:[ 8, 7], sl:[ 2, 1], rr:[ 3, 3] }, // @2
    { tl:25, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,12], dr:[ 2, 4], sl:[ 1, 2], rr:[ 1, 3] }, // @3
    { tl:14, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[1,0], multi:[ 1, 1], ksl:[0,0], ar:[10, 6], dr:[ 8, 4], sl:[ 7, 2], rr:[ 0, 7] }, // @4
    { tl:30, dc:0, dm:0, fb:6, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 2, 1], ksl:[0,0], ar:[14, 7], dr:[ 0, 6], sl:[ 0, 2], rr:[ 0, 8] }, // @5
    { tl:22, dc:0, dm:0, fb:5, am:[0,0], vib:[0,0], et:[1,1], ksr:[1,0], multi:[ 1, 2], ksl:[0,0], ar:[14, 7], dr:[ 0, 1], sl:[ 0, 1], rr:[ 0, 8] }, // @6
    { tl:29, dc:0, dm:0, fb:7, am:[0,0], vib:[0,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8, 8], dr:[ 2, 1], sl:[ 1, 0], rr:[ 0, 7] }, // @7
    { tl:45, dc:1, dm:0, fb:4, am:[0,0], vib:[0,0], et:[1,1], ksr:[0,0], multi:[ 3, 1], ksl:[0,0], ar:[10, 7], dr:[ 2, 2], sl:[ 0, 0], rr:[ 0, 7] }, // @8
    { tl:27, dc:0, dm:0, fb:6, am:[0,0], vib:[1,1], et:[1,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 6, 6], dr:[ 4, 5], sl:[ 1, 1], rr:[ 0, 7] }, // @9
    { tl:11, dc:1, dm:1, fb:0, am:[0,0], vib:[1,1], et:[0,1], ksr:[0,0], multi:[ 1, 1], ksl:[0,0], ar:[ 8,15], dr:[ 5, 7], sl:[ 7, 0], rr:[ 1, 7] }, // @10
    { tl: 3, dc:1, dm:0, fb:1, am:[0,0], vib:[0,0], et:[0,0], ksr:[1,0], multi:[ 3, 1], ksl:[2,0], ar:[15,14], dr:[10, 4], sl:[ 1, 0], rr:[ 0, 4] }, // @11
    { tl:36, dc:0, dm:0, fb:7, am:[0,1], vib:[0,1], et:[0,0], ksr:[1,0], multi:[ 7, 1], ksl:[0,0], ar:[15,15], dr:[ 8, 8], sl:[ 2, 1], rr:[ 2, 2] }, // @12
    { tl:12, dc:0, dm:0, fb:5, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,1], multi:[ 1, 0], ksl:[0,0], ar:[12,15], dr:[ 2, 5], sl:[ 2, 4], rr:[ 0, 2] }, // @13
    { tl:21, dc:0, dm:0, fb:3, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 1], ksl:[1,0], ar:[12, 9], dr:[ 9, 5], sl:[ 0, 0], rr:[ 3, 2] }, // @14
    { tl: 9, dc:0, dm:0, fb:3, am:[0,0], vib:[1,1], et:[1,0], ksr:[0,0], multi:[ 1, 1], ksl:[2,0], ar:[15,14], dr:[ 1, 4], sl:[ 4, 1], rr:[ 0, 3] }, // @15
    { tl:24, dc:0, dm:1, fb:7, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[13, 0], dr:[15, 0], sl:[ 6, 0], rr:[10, 0] }, // drum_0
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 1, 0], ksl:[0,0], ar:[12, 0], dr:[ 8, 0], sl:[10, 0], rr:[ 7, 0] }, // drum_1
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 5, 0], ksl:[0,0], ar:[15, 0], dr:[ 8, 0], sl:[ 5, 0], rr:[ 9, 0] }, // drum_2
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,15], dr:[ 0, 8], sl:[ 0, 6], rr:[ 0,13] }, // drum_3
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,13], dr:[ 0, 8], sl:[ 0, 4], rr:[ 0, 8] }, // drum_4
    { tl: 0, dc:0, dm:0, fb:0, am:[0,0], vib:[0,0], et:[0,0], ksr:[0,0], multi:[ 0, 1], ksl:[0,0], ar:[ 0,10], dr:[ 0,10], sl:[ 0, 5], rr:[ 0, 5] }, // drum_5
  ];

  // ---- サイクル→チャンネル対応表 ----
  // output_m は ismod=(cycles/3)&1 が0のサイクルだけ「そのchのキャリア出力」を運ぶ。
  // 担当chは CH_OFFSET を演算パイプラインの段数ぶん遡った位置。段数は解析で出すより
  // 実測が確実なので、1chずつ鳴らして output_m が立つサイクルを調べた結果 11 と判明
  // (cycle 0,1,2→ch6,7,8 / 6,7,8→ch0,1,2 / 12,13,14→ch3,4,5)。
  const PIPELINE_DELAY = 11;
  const CARRIER_CH = new Int8Array(18).fill(-1);
  for (let c = 0; c < 18; c++) {
    if (((c / 3) | 0) & 1) continue;          // モジュレータ側のサイクルは出力しない
    CARRIER_CH[c] = CH_OFFSET[(c + PIPELINE_DELAY) % 18];
  }
  // output_r(リズム)も同様に実測(太鼓を1種ずつ鳴らして output_r が立つサイクルを特定)。
  // 各太鼓は1巡で2回ぶん出力される(実機の時分割DACがリズムchを2回読むため。旧コアには
  // 無かった挙動で、リズムがメロディに対して相対的に大きく出るのはこれが理由)。
  //   BD:cycle 0,5 / SD:1,9 / CYM:2,10 / HH:3,16 / TOM:4,17
  // 鍵盤のミュート枠は旧コア(opllMsx.js)と同じく BD=ch6 / HH,SD=ch7 / TOM,CYM=ch8。
  // ★2026-08-22: 打楽器のミュート/音量は実チャンネル(6-8)ではなく専用の添字9-13を使う。
  // SDとHHは実機では同じch7、TOMとCYMは同じch8だが、鍵盤には5行が別々に出るため
  // 実ch単位だと2行が同じ添字を共有し、getMuteConfig()の書き込み順で片方が無視される。
  // ここは出力サイクルで打楽器を識別できるので5種を独立させられる(keyboard.js KF_RHYTHM_INDEX)。
  const MUTE_BD = 9, MUTE_SD = 10, MUTE_TOM = 11, MUTE_CYM = 12, MUTE_HH = 13;
  const NUM_MUTE_SLOTS = 14; // 0-8=メロディch / 9-13=BD,SD,TOM,CYM,HH
  const RHYTHM_CH = new Int8Array(18).fill(-1);
  RHYTHM_CH[0] = MUTE_BD;  RHYTHM_CH[5] = MUTE_BD;       // BD
  RHYTHM_CH[1] = MUTE_SD;  RHYTHM_CH[9] = MUTE_SD;       // SD
  RHYTHM_CH[3] = MUTE_HH;  RHYTHM_CH[16] = MUTE_HH;      // HH
  RHYTHM_CH[4] = MUTE_TOM; RHYTHM_CH[17] = MUTE_TOM;     // TOM
  RHYTHM_CH[2] = MUTE_CYM; RHYTHM_CH[10] = MUTE_CYM;     // CYM

  // ---- eg_level[] のスロット番号 ↔ (ch, mod/car) 対応 ----
  // eg_level は「サイクル番号=スロット番号」で索かれ、そのスロットの担当は
  // ch=CH_OFFSET[c] / mcsel=((c+1)/3)&1 (1がキャリア)。鍵盤スナップショット用に逆引きを作る。
  const SLOT_MOD = new Int8Array(9).fill(-1);
  const SLOT_CAR = new Int8Array(9).fill(-1);
  for (let c = 0; c < 18; c++) {
    const ch = CH_OFFSET[c];
    if (((((c + 1) / 3) | 0) & 1) === 1) SLOT_CAR[ch] = c; else SLOT_MOD[ch] = c;
  }

  // 打楽器5種が使う eg_level のスロット番号(bd,sd,tom,cym,hh)。実測で確認済み
  // (1種ずつ鳴らして下がるスロットを特定: BD=11と14, SD=15, TOM=13, CYM=16, HH=12)。
  const RHYTHM_SLOT = [SLOT_CAR[6], SLOT_CAR[7], SLOT_MOD[8], SLOT_CAR[8], SLOT_MOD[7]];

  const s8 = (v) => (v << 24) >> 24; // int8_t への切り詰め(rm_enableの算術右シフト用)

  function newPatch() {
    return {
      tl: 0, dc: 0, dm: 0, fb: 0,
      am: [0, 0], vib: [0, 0], et: [0, 0], ksr: [0, 0],
      multi: [0, 0], ksl: [0, 0], ar: [0, 0], dr: [0, 0], sl: [0, 0], rr: [0, 0]
    };
  }

  class OPLLNuked {
    constructor(opts) {
      opts = opts || {};
      this.chipType = (opts.chipType === 'ds1001') ? 'ds1001' : 'ym2413';
      this.isDs1001 = this.chipType === 'ds1001';
      this.patchrom = this.isDs1001 ? PATCH_DS1001 : PATCH_YM2413;
      this.numCh = this.isDs1001 ? 6 : 9;
      // ホストクロック→内部サイクルの分周(冒頭コメント参照)
      this.hostPerOpll = opts.hostCyclesPerOpllCycle || (this.isDs1001 ? 2 : 4);
      // 0-8=メロディch / 9-13=リズム(BD,SD,TOM,CYM,HH)。RHYTHM_CH のコメント参照
      this.mute = new Array(NUM_MUTE_SLOTS).fill(false);
      this.vol = new Array(NUM_MUTE_SLOTS).fill(1);
      this._alloc();
      this.reset();
    }

    _alloc() {
      this.eg_state = new Uint8Array(18);
      this.eg_level = new Uint8Array(18);
      this.pg_phase = new Uint32Array(18);
      this.op_fb1 = new Int16Array(9);
      this.op_fb2 = new Int16Array(9);
      this.fnum = new Uint16Array(9);
      this.block = new Uint8Array(9);
      this.kon = new Uint8Array(9);
      this.son = new Uint8Array(9);
      this.regVol = new Uint8Array(9);
      this.inst = new Uint8Array(9);
      this.patch = newPatch();
      this.regShadow = new Uint8Array(0x40); // $00-$3F の素の値(スナップショット/デバッグ用)
      this._rhythmPeak = new Uint8Array(5); // 打楽器のピークホールド(_rhythmSlotInfo参照)
      this.writebuf = [];
      this.writeHead = 0; // shift()を使わないための取り出し位置
    }

    reset() {
      this.cycles = 0; this.slot = 0;
      this.write_data = 0; this.write_a = 0; this.write_d = 0;
      this.write_a_en = 0; this.write_d_en = 0;
      this.write_fm_address = 0; this.write_fm_data = 0; this.write_mode_address = 0;
      this.address = 0; this.data = 0;

      this.eg_counter_state = 0; this.eg_counter_state_prev = 0;
      this.eg_timer = 0; this.eg_timer_low_lock = 0; this.eg_timer_carry = 0;
      this.eg_timer_shift = 0; this.eg_timer_shift_lock = 0; this.eg_timer_shift_stop = 0;
      this.eg_kon = 0; this.eg_dokon = 0; this.eg_off = 0;
      this.eg_rate = 0; this.eg_maxrate = 0; this.eg_zerorate = 0;
      this.eg_inc_lo = 0; this.eg_inc_hi = 0; this.eg_rate_hi = 0;
      this.eg_sl = 0; this.eg_ksltl = 0; this.eg_out = 0x7f; this.eg_silent = 0;

      this.pg_fnum = 0; this.pg_block = 0; this.pg_out = 0; this.pg_inc = 0; this.pg_phase_next = 0;

      this.op_fbsum = 0; this.op_mod = 0; this.op_neg = 0;
      this.op_logsin = 0; this.op_exp_m = 0; this.op_exp_s = 0;

      this.ch_out = 0; this.ch_out_hh = 0; this.ch_out_tm = 0;
      this.ch_out_bd = 0; this.ch_out_sd = 0; this.ch_out_tc = 0;

      this.lfo_counter = 0; this.lfo_vib_counter = 0; this.lfo_am_counter = 0;
      this.lfo_am_step = 0; this.lfo_am_dir = 0; this.lfo_am_car = 0; this.lfo_am_out = 0;

      this.rhythm = 0; this.testmode = 0;
      this.c_instr = 0; this.c_op = 0; this.c_tl = 0; this.c_dc = 0; this.c_dm = 0; this.c_fb = 0;
      this.c_am = 0; this.c_vib = 0; this.c_et = 0; this.c_ksr = 0;
      this.c_ksr_freq = 0; this.c_ksl_freq = 0; this.c_ksl_block = 0;
      this.c_multi = 0; this.c_ksl = 0;
      this.c_adrr = [0, 0, 0];
      this.c_sl = 0; this.c_fnum = 0; this.c_block = 0;

      this.rm_enable = 0; this.rm_noise = 0; this.rm_select = RM_TC + 1;
      this.rm_hh_bit2 = 0; this.rm_hh_bit3 = 0; this.rm_hh_bit7 = 0; this.rm_hh_bit8 = 0;
      this.rm_tc_bit3 = 0; this.rm_tc_bit5 = 0;

      this.output_m = 0; this.output_r = 0;

      this.eg_state.fill(EG_RELEASE);
      this.eg_level.fill(0x7f);
      this._rhythmPeak.fill(0x7f);
      this.pg_phase.fill(0);
      this.op_fb1.fill(0); this.op_fb2.fill(0);
      this.fnum.fill(0); this.block.fill(0); this.kon.fill(0); this.son.fill(0);
      this.regVol.fill(0); this.inst.fill(0);
      this.regShadow.fill(0);
      const p = this.patch;
      p.tl = p.dc = p.dm = p.fb = 0;
      for (let i = 0; i < 2; i++) {
        p.am[i] = p.vib[i] = p.et[i] = p.ksr[i] = 0;
        p.multi[i] = p.ksl[i] = p.ar[i] = p.dr[i] = p.sl[i] = p.rr[i] = 0;
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      this._addrLatch = 0;
      this._writePhase = 0;

      if (this.isDs1001) { // VRC7はリズムモードが常時ON扱い
        this.rhythm = 0x20;
        this.rm_enable = s8(0x80);
      }

      this.hostAccum = 0;
      this.sampleAccum = 0;
      this.sampleCycles = 0;
      this.lastSample = 0;
      this.dcX = 0; this.dcY = 0; this.dcPrimed = 0;
    }

    // ────────── OPLL_DoIO ──────────
    _doIO() {
      this.write_a_en = ((this.write_a & 0x03) === 0x01) ? 1 : 0;
      this.write_d_en = ((this.write_d & 0x03) === 0x01) ? 1 : 0;
      this.write_a = (this.write_a << 1) & 0xff;
      this.write_d = (this.write_d << 1) & 0xff;
    }

    // ────────── OPLL_DoModeWrite ──────────
    _doModeWrite() {
      if (!((this.write_mode_address & 0x10) && this.write_d_en)) return;
      const slot = this.write_mode_address & 0x01;
      const d = this.write_data;
      const p = this.patch;
      switch (this.write_mode_address & 0x0f) {
        case 0x00: case 0x01:
          p.multi[slot] = d & 0x0f;
          p.ksr[slot] = (d >> 4) & 0x01;
          p.et[slot] = (d >> 5) & 0x01;
          p.vib[slot] = (d >> 6) & 0x01;
          p.am[slot] = (d >> 7) & 0x01;
          break;
        case 0x02: p.ksl[0] = (d >> 6) & 0x03; p.tl = d & 0x3f; break;
        case 0x03:
          p.ksl[1] = (d >> 6) & 0x03;
          p.dc = (d >> 4) & 0x01; p.dm = (d >> 3) & 0x01; p.fb = d & 0x07;
          break;
        case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
        case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        case 0x0e:
          this.rhythm = d & 0x3f;
          if (this.isDs1001) this.rhythm |= 0x20;
          this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
          break;
        case 0x0f: this.testmode = d & 0x0f; break;
      }
    }

    // ────────── OPLL_DoRegWrite ──────────
    _doRegWrite() {
      if (this.write_a_en) {
        if ((this.write_data & 0xc0) === 0x00) {
          this.write_fm_address = 1;
          this.address = this.write_data;
        } else {
          this.write_fm_address = 0;
        }
      }
      if (this.write_fm_address && this.write_d_en) this.data = this.write_data;

      if (this.write_fm_data && !this.write_a_en) {
        if ((this.address & 0x0f) === this.cycles && this.cycles < 16) {
          const channel = this.cycles % 9;
          switch (this.address & 0xf0) {
            case 0x10:
              this.fnum[channel] = (this.fnum[channel] & 0x100) | this.data;
              break;
            case 0x20:
              this.fnum[channel] = (this.fnum[channel] & 0xff) | ((this.data & 0x01) << 8);
              this.block[channel] = (this.data >> 1) & 0x07;
              this.kon[channel] = (this.data >> 4) & 0x01;
              this.son[channel] = (this.data >> 5) & 0x01;
              break;
            case 0x30:
              this.regVol[channel] = this.data & 0x0f;
              this.inst[channel] = (this.data >> 4) & 0x0f;
              break;
          }
        }
      }

      if (this.write_a_en) this.write_fm_data = 0;
      if (this.write_fm_address && this.write_d_en) this.write_fm_data = 1;
      if (this.write_a_en) {
        this.write_mode_address = ((this.write_data & 0xf0) === 0x00)
          ? (0x10 | (this.write_data & 0x0f)) : 0x00;
      }
    }

    // ────────── OPLL_PreparePatch1 / 2 ──────────
    _selectPatch(mcsel) {
      const ch = CH_OFFSET[this.cycles];
      const instr = this.inst[ch];
      if (this.rm_select <= RM_TC) return this.patchrom[PATCH_DRUM_0 + this.rm_select];
      if (instr > 0) return this.patchrom[instr - 1];
      return this.patch;
    }

    _preparePatch1() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      if (this.rm_select === RM_HH || this.rm_select === RM_TOM) this.c_tl = this.inst[ch] << 2;
      else if (mcsel === 1) this.c_tl = this.regVol[ch] << 2;
      else this.c_tl = patch.tl;

      this.c_adrr[0] = patch.ar[mcsel];
      this.c_adrr[1] = patch.dr[mcsel];
      this.c_adrr[2] = patch.rr[mcsel];
      this.c_et = patch.et[mcsel];
      this.c_ksr = patch.ksr[mcsel];
      this.c_ksl = patch.ksl[mcsel];
      this.c_ksr_freq = (this.block[ch] << 1) | (this.fnum[ch] >> 8);
      this.c_ksl_freq = this.fnum[ch] >> 5;
      this.c_ksl_block = this.block[ch];
    }

    _preparePatch2() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;
      const ch = CH_OFFSET[this.cycles];
      const patch = this._selectPatch(mcsel);

      this.c_fnum = this.fnum[ch];
      this.c_block = this.block[ch];
      this.c_multi = patch.multi[mcsel];
      this.c_sl = patch.sl[mcsel];
      this.c_fb = patch.fb;
      this.c_vib = patch.vib[mcsel];
      this.c_am = patch.am[mcsel];
      this.c_dc = ((this.c_dc << 1) | patch.dc) & 0xff;
      this.c_dm = ((this.c_dm << 1) | patch.dm) & 0xff;
    }

    // ────────── OPLL_PhaseGenerate ──────────
    _phaseGenerate() {
      this.pg_phase[(this.cycles + 17) % 18] = (this.pg_phase_next + this.pg_inc) >>> 0;

      let ismod;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod = 0;
      else ismod = (((this.cycles + 3) / 3) | 0) & 1;

      const phase = this.pg_phase[this.cycles];
      if ((this.testmode & 0x04)
        || (ismod && (this.eg_dokon & 0x8000)) || (!ismod && (this.eg_dokon & 0x01))) {
        this.pg_phase_next = 0;
      } else {
        this.pg_phase_next = phase;
      }

      if (this.cycles === 13) {
        this.rm_hh_bit2 = (phase >>> (2 + 9)) & 1;
        this.rm_hh_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_hh_bit7 = (phase >>> (7 + 9)) & 1;
        this.rm_hh_bit8 = (phase >>> (8 + 9)) & 1;
      } else if (this.cycles === 17 && (this.rm_enable & 0x80)) {
        this.rm_tc_bit3 = (phase >>> (3 + 9)) & 1;
        this.rm_tc_bit5 = (phase >>> (5 + 9)) & 1;
      }

      let pg_out;
      if (this.rm_enable & 0x80) {
        let rm_bit;
        switch (this.cycles) {
          case 13: // HH
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = rm_bit << 9;
            pg_out |= (rm_bit ^ (this.rm_noise & 1)) ? 0xd0 : 0x34;
            break;
          case 16: // SD
            pg_out = (this.rm_hh_bit8 << 9)
                   | ((this.rm_hh_bit8 ^ (this.rm_noise & 1)) << 8);
            break;
          case 17: // TC
            rm_bit = (this.rm_hh_bit2 ^ this.rm_hh_bit7)
                   | (this.rm_hh_bit3 ^ this.rm_tc_bit5)
                   | (this.rm_tc_bit3 ^ this.rm_tc_bit5);
            pg_out = (rm_bit << 9) | 0x100;
            break;
          default:
            pg_out = phase >>> 9;
        }
      } else {
        pg_out = phase >>> 9;
      }
      this.pg_out = pg_out & 0xffff;
    }

    // ────────── OPLL_PhaseCalcIncrement ──────────
    _phaseCalcIncrement() {
      let freq = this.c_fnum << 1;
      const block = this.c_block;
      if (this.c_vib) {
        switch (this.lfo_vib_counter) {
          case 0: case 4: break;
          case 1: case 3: freq += freq >> 8; break;
          case 2: freq += freq >> 7; break;
          case 5: case 7: freq -= freq >> 8; break;
          case 6: freq -= freq >> 7; break;
        }
      }
      freq = (freq << block) >> 1;
      this.pg_inc = (freq * PG_MULTI[this.c_multi]) >>> 1;
    }

    // ────────── OPLL_EnvelopeKSLTL ──────────
    _envelopeKSLTL() {
      let ksl = EG_KSLTABLE[this.c_ksl_freq] - ((8 - this.c_ksl_block) << 3);
      if (ksl < 0) ksl = 0;
      ksl <<= 1;
      ksl = this.c_ksl ? (ksl >> (3 - this.c_ksl)) : 0;
      this.eg_ksltl = ksl + (this.c_tl << 1);
    }

    // ────────── OPLL_EnvelopeOutput ──────────
    _envelopeOutput() {
      let level = this.eg_level[(this.cycles + 17) % 18];
      level += this.eg_ksltl;
      if (this.c_am) level += this.lfo_am_out;
      if (level >= 128) level = 127;
      if (this.testmode & 0x01) level = 0;
      this.eg_out = level;
    }

    // ────────── OPLL_EnvelopeGenerate ──────────
    _envelopeGenerate() {
      const mcsel = (((this.cycles + 1) / 3) | 0) & 0x01;

      // --- EGタイマ ---
      let timer_inc;
      if ((this.eg_counter_state & 3) !== 3) timer_inc = 0;
      else if (this.cycles === 0) timer_inc = 1;
      else timer_inc = this.eg_timer_carry;

      const timer_low = this.eg_timer & 3;
      let timer_bit = (this.eg_timer & 1) + timer_inc;
      this.eg_timer_carry = timer_bit >> 1;
      this.eg_timer = (((timer_bit & 1) << 17) | (this.eg_timer >>> 1)) >>> 0;
      if (this.testmode & 0x08) {
        this.eg_timer &= 0x2ffff;
        this.eg_timer |= (this.write_data << (16 - 2)) & 0x10000;
      }
      if (!this.eg_timer_shift_stop && ((this.eg_timer >>> 16) & 1)) {
        this.eg_timer_shift = this.cycles;
      }
      if (this.cycles === 0 && (this.eg_counter_state_prev & 1) === 1) {
        this.eg_timer_low_lock = timer_low;
        this.eg_timer_shift_lock = this.eg_timer_shift;
        if (this.eg_timer_shift_lock > 13) this.eg_timer_shift_lock = 0;
        this.eg_timer_shift = 0;
      }
      this.eg_timer_shift_stop |= (this.eg_timer >>> 16) & 1;
      if (this.cycles === 0) this.eg_timer_shift_stop = 0;
      this.eg_counter_state_prev = this.eg_counter_state;
      if (this.cycles === 17) this.eg_counter_state = (this.eg_counter_state + 1) & 0xff;

      // --- レベル更新 ---
      const idx = (this.cycles + 16) % 18;
      const level = this.eg_level[idx];
      let next_level = level;
      const zero = (level === 0);
      this.eg_silent = (level === 0x7f) ? 1 : 0;

      if (this.eg_state[idx] !== EG_ATTACK && (this.eg_off & 2) && !(this.eg_dokon & 2)) {
        next_level = 0x7f;
      }
      if (this.eg_maxrate && (this.eg_dokon & 2)) next_level = 0x00;

      const state = this.eg_state[idx];
      let next_state = EG_ATTACK;
      let step = 0;
      const sl = this.eg_sl;

      switch (state) {
        case EG_ATTACK:
          if (!this.eg_maxrate && (this.eg_kon & 2) && !zero) {
            const shift = (this.eg_rate_hi < 12) ? this.eg_inc_lo : (this.eg_rate_hi - 11 + this.eg_inc_hi);
            if (shift > 0) step = (~level) >> (5 - shift);
          }
          next_state = zero ? EG_DECAY : EG_ATTACK;
          break;
        case EG_DECAY:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2) && (level >> 3) !== sl) {
            step = this._egStep();
          }
          next_state = ((level >> 3) === sl) ? EG_SUSTAIN : EG_DECAY;
          break;
        case EG_SUSTAIN:
        case EG_RELEASE:
          if (!(this.eg_off & 2) && !(this.eg_dokon & 2)) step = this._egStep();
          next_state = state;
          break;
      }

      if (!(this.eg_kon & 2)) next_state = EG_RELEASE;
      if (this.eg_dokon & 2) next_state = EG_ATTACK;

      this.eg_level[idx] = (next_level + step) & 0xff;
      this.eg_state[idx] = next_state;

      // --- 次サイクルぶんのレート計算 ---
      const rate_hi = this.eg_rate >> 2;
      const rate_lo = this.eg_rate & 3;
      this.eg_inc_hi = EG_STEPHI[rate_lo][this.eg_timer_low_lock];
      const sum = (this.eg_timer_shift_lock + rate_hi) & 0x0f;
      this.eg_inc_lo = 0;
      if (rate_hi < 12 && !this.eg_zerorate) {
        switch (sum) {
          case 12: this.eg_inc_lo = 1; break;
          case 13: this.eg_inc_lo = (rate_lo >> 1) & 1; break;
          case 14: this.eg_inc_lo = rate_lo & 1; break;
        }
      }
      this.eg_maxrate = (rate_hi === 0x0f) ? 1 : 0;
      this.eg_rate_hi = rate_hi;

      this.eg_kon = ((this.eg_kon << 1) | this.kon[CH_OFFSET[this.cycles]]) & 0xff;
      this.eg_off = ((this.eg_off << 1) | (((this.eg_level[this.cycles] >> 2) === 0x1f) ? 1 : 0)) & 0xff;

      switch (this.rm_select) {
        case RM_BD0: case RM_BD1: this.eg_kon |= (this.rhythm >> 4) & 1; break;
        case RM_SD:  this.eg_kon |= (this.rhythm >> 3) & 1; break;
        case RM_TOM: this.eg_kon |= (this.rhythm >> 2) & 1; break;
        case RM_TC:  this.eg_kon |= (this.rhythm >> 1) & 1; break;
        case RM_HH:  this.eg_kon |= this.rhythm & 1; break;
      }

      let rate = 0;
      this.eg_dokon = (this.eg_dokon << 1) & 0xffff;
      let state_rate = this.eg_state[this.cycles];
      if (state_rate === EG_RELEASE && (this.eg_kon & 1) && (this.eg_off & 1)) {
        state_rate = EG_ATTACK;
        this.eg_dokon |= 1;
      }
      switch (state_rate) {
        case EG_ATTACK: rate = this.c_adrr[0]; break;
        case EG_DECAY: rate = this.c_adrr[1]; break;
        case EG_SUSTAIN: if (!this.c_et) rate = this.c_adrr[2]; break;
        case EG_RELEASE: rate = this.son[CH_OFFSET[this.cycles]] ? 5 : this.c_adrr[2]; break;
      }
      if (!(this.eg_kon & 1) && !mcsel && this.rm_select !== RM_TOM && this.rm_select !== RM_HH) rate = 0;
      if ((this.eg_kon & 1) && this.eg_state[this.cycles] === EG_RELEASE && !(this.eg_off & 1)) rate = 12;
      if (!(this.eg_kon & 1) && !this.son[CH_OFFSET[this.cycles]] && mcsel === 1 && !this.c_et) rate = 7;

      this.eg_zerorate = (rate === 0) ? 1 : 0;
      let ksr = this.c_ksr_freq;
      if (!this.c_ksr) ksr >>= 2;
      this.eg_rate = (rate << 2) + ksr;
      if (this.eg_rate & 0x40) this.eg_rate = 0x3c | (ksr & 3);
      this.eg_sl = this.c_sl;
    }

    // DECAY/SUSTAIN/RELEASE共通の増分(opll.cで同じ式が2箇所に展開されているもの)
    _egStep() {
      const rh = this.eg_rate_hi, ih = this.eg_inc_hi, il = this.eg_inc_lo;
      const cs = this.eg_counter_state_prev;
      const i0 = (rh === 15 || (rh === 14 && ih)) ? 1 : 0;
      const i1 = ((rh === 14 && !ih) || (rh === 13 && ih)
        || (rh === 13 && !ih && (cs & 1))
        || (rh === 12 && ih && (cs & 1))
        || (rh === 12 && !ih && ((cs & 3) === 3))
        || (il && ((cs & 3) === 3))) ? 1 : 0;
      return (i0 << 1) | i1;
    }

    // ────────── OPLL_Channel ──────────
    _channel() {
      let ch_out = this.ch_out;
      const ismod = ((this.cycles / 3) | 0) & 1;
      const mute_m = ismod || ((this.rm_enable & 0x40) && (this.cycles + 15) % 18 >= 12);

      if (this.isDs1001) {
        this.output_m = ch_out;
        if (this.output_m >= 0) this.output_m++;
        if (mute_m) this.output_m = 0;
        this.output_r = 0;
      } else {
        let mute_r = 1;
        if (this.rm_enable & 0x40) {
          switch (this.cycles) {
            case 16: case 17: case 0: case 1: case 2:
            case 3: case 4: case 5: case 9: case 10:
              mute_r = 0; break;
          }
        }
        const sign0 = ch_out >> 8;
        let sign = sign0;
        if (ch_out >= 0) { ch_out++; sign++; }
        this.output_m = mute_m ? sign : ch_out;
        this.output_r = mute_r ? sign : ch_out;
      }

      // ── ch別ミュート/音量(実機には無い機能) ──
      // output_m / output_r は最終DAC出力なので、ここで倍率を掛けても合成には一切影響しない。
      const cm = CARRIER_CH[this.cycles];
      if (cm >= 0) {
        if (this.mute[cm]) this.output_m = 0;
        else if (this.vol[cm] !== 1) this.output_m = this.output_m * this.vol[cm];
      }
      const cr = RHYTHM_CH[this.cycles];
      if (cr >= 0 && this.output_r !== 0) {
        if (this.mute[cr]) this.output_r = 0;
        else if (this.vol[cr] !== 1) this.output_r = this.output_r * this.vol[cr];
      }
    }

    // ────────── OPLL_Operator ──────────
    _operator() {
      let ismod1, ismod2, ismod3;
      if ((this.rm_enable & 0x80) && (this.cycles === 15 || this.cycles === 16)) ismod1 = 0;
      else ismod1 = (((this.cycles + 1) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 13 || this.cycles === 14)) ismod2 = 0;
      else ismod2 = (((this.cycles + 3) / 3) | 0) & 1;
      if ((this.rm_enable & 0x40) && (this.cycles === 16 || this.cycles === 17)) ismod3 = 0;
      else ismod3 = ((this.cycles / 3) | 0) & 1;

      let op_mod = 0;
      if (ismod3) op_mod |= this.op_mod << 1;
      if (ismod2 && this.c_fb) op_mod |= this.op_fbsum >> (7 - this.c_fb);

      let exp_shift = this.op_exp_s;
      if (this.eg_silent || ((this.op_neg & 2) && (ismod1 ? (this.c_dm & 4) : (this.c_dc & 4)))) {
        exp_shift |= 12;
      }

      let output = this.op_exp_m >> exp_shift;
      if (!this.eg_silent && (this.op_neg & 2)) output = ~output;

      let level = this.op_logsin + (this.eg_out << 4);
      if (level >= 4096) level = 4095;
      this.op_exp_m = EXPROM[level & 0xff];
      this.op_exp_s = level >> 8;

      let phase = (op_mod + this.pg_out) & 0x3ff;
      if (phase & 0x100) phase ^= 0xff;
      this.op_logsin = LOGSIN[phase & 0xff];
      this.op_neg = ((this.op_neg << 1) | (phase >> 9)) & 0xff;
      this.op_fbsum = (this.op_fb1[(this.cycles + 3) % 9] + this.op_fb2[(this.cycles + 3) % 9]) >> 1;

      if (ismod1) {
        this.op_fb2[this.cycles % 9] = this.op_fb1[this.cycles % 9];
        this.op_fb1[this.cycles % 9] = output;
      }
      this.op_mod = output & 0x1ff;

      let routput = 0;
      if (!this.isDs1001) {
        switch (this.cycles) {
          case 2: routput = this.ch_out_hh; break;
          case 3: routput = this.ch_out_tm; break;
          case 4: routput = this.ch_out_bd; break;
          case 8: routput = this.ch_out_sd; break;
          case 9: routput = this.ch_out_tc; break;
        }
        switch (this.cycles) {
          case 15: this.ch_out_hh = output >> 3; break;
          case 16: this.ch_out_tm = output >> 3; break;
          case 17: this.ch_out_bd = output >> 3; break;
          case 0: this.ch_out_sd = output >> 3; break;
          case 1: this.ch_out_tc = output >> 3; break;
        }
      }
      if (!(this.rm_enable & 0x80)) routput = 0;

      this.ch_out = ismod1 ? routput : (output >> 3);
    }

    // ────────── OPLL_DoRhythm / OPLL_DoLFO ──────────
    _doRhythm() {
      let nbit = (this.rm_noise ^ (this.rm_noise >>> 14)) & 0x01;
      nbit |= ((this.rm_noise === 0x00) ? 1 : 0) | ((this.testmode >> 1) & 0x01);
      this.rm_noise = ((nbit << 22) | (this.rm_noise >>> 1)) >>> 0;
    }

    _doLFO() {
      let am_inc = 0;
      if (this.cycles === 17) {
        let vib_step = (((this.lfo_counter & 0x3ff) + 1) >> 10);
        this.lfo_am_step = ((this.lfo_counter & 0x3f) + 1) >> 6;
        vib_step |= (this.testmode >> 3) & 0x01;
        this.lfo_vib_counter = (this.lfo_vib_counter + vib_step) & 0x07;
        this.lfo_counter = (this.lfo_counter + 1) & 0xffff;
      }
      if ((this.lfo_am_step || (this.testmode & 0x08)) && this.cycles < 9) {
        am_inc = this.lfo_am_dir | ((this.cycles === 0) ? 1 : 0);
      }
      if (this.cycles >= 9) this.lfo_am_car = 0;
      if (this.cycles === 0) {
        if (this.lfo_am_dir && (this.lfo_am_counter & 0x7f) === 0) this.lfo_am_dir = 0;
        else if (!this.lfo_am_dir && (this.lfo_am_counter & 0x69) === 0x69) this.lfo_am_dir = 1;
      }
      let am_bit = (this.lfo_am_counter & 0x01) + am_inc + this.lfo_am_car;
      this.lfo_am_car = am_bit >> 1;
      am_bit &= 0x01;
      this.lfo_am_counter = ((am_bit << 8) | (this.lfo_am_counter >>> 1)) & 0x1ff;

      if (this.testmode & 0x02) {
        this.lfo_vib_counter = 0;
        this.lfo_counter = 0;
        this.lfo_am_dir = 0;
        this.lfo_am_counter &= 0xff;
      }
    }

    // ────────── OPLL_Clock 1回ぶん ──────────
    _stepOpll() {
      // buffer[0]/[1] 相当。前サイクルの OPLL_Channel が確定させた値を取り込む
      this.sampleAccum += this.output_m + this.output_r;

      if (this.cycles === 0) this.lfo_am_out = (this.lfo_am_counter >> 3) & 0x0f;
      this.rm_enable = s8(this.rm_enable) >> 1;
      this._doModeWrite();
      this.rm_select++;
      if (this.rm_select > RM_TC) this.rm_select = RM_TC + 1;
      if (this.cycles === 11 && (this.rm_enable & 0x80) === 0x80) this.rm_select = RM_BD0;

      this._preparePatch1();
      this._channel();
      this._phaseGenerate();
      this._operator();
      this._phaseCalcIncrement();
      this._envelopeOutput();
      this._envelopeKSLTL();
      this._envelopeGenerate();
      this._doLFO();
      this._doRhythm();
      this._preparePatch2();
      this._doRegWrite();
      this._doIO();

      this.cycles = (this.cycles + 1) % 18;

      if (++this.sampleCycles >= CYCLES_PER_SAMPLE) {
        this.sampleCycles = 0;
        // 打楽器のピークホールド更新(1サンプルごとで十分。減衰は最短でも数千サンプル続く)
        for (let i = 0; i < 5; i++) {
          const lv = this.eg_level[RHYTHM_SLOT[i]];
          if (lv < this._rhythmPeak[i]) this._rhythmPeak[i] = lv;
        }
        // 実チップの時分割DACは無音時も基準レベル(OPLL_Channelのsign)を出し続けるため
        // 出力にDC成分が乗る。実機ではAC結合で落ちるぶんなので1次ハイパスで除去する。
        // カットオフ約5Hz。[[hes-dda-gain-clipping-fix]]の教訓で立ち上がりのオーバー
        // シュートを避けるため十分低く取っている。
        const x = this.sampleAccum;
        if (this.dcPrimed === 0) { this.dcX = x; this.dcPrimed = 1; } // 初回は段差を作らない
        this.dcY = x - this.dcX + DC_BLOCK_R * this.dcY;
        this.dcX = x;
        this.lastSample = this.dcY;
        this.sampleAccum = 0;
      }
    }

    // ────────── 書き込み ──────────
    // アドレス/データは実機同様「別々のタイミング」で入らないと取りこぼす(write_dataが共用の
    // 1バイトラッチのため)。バス経由(nsfBus/kssBus)は元々CPUサイクルが空くので問題ないが、
    // writeReg()のような即時2連書きのために最小間隔を空けるキューを通す。
    // ★キューの単位は「レジスタ書き込み1件(アドレス+データの対)」。エントリ形式は
    // reg | (data << 8)。実チップは2フェーズ(アドレスポート→データポート)だが、
    // **キュー上で対を分割してはいけない**。
    // 以前はアドレスとデータを別エントリにしていたため、「アドレスだけ先に取り出されて
    // パイプラインへ入り、データがまだキューに居るときに溢れて _drainDirect() が走る」と
    // 宙に浮いたアドレスが捨てられ、直後のデータが**アドレス無しのデータ書き込み**として
    // パイプラインに入り、そのレジスタ書き込みが丸ごと消えていた。
    // (Illusion City KSS 1曲目で実測: カスタム音色の $00 が一度も適用されず multi[0] が
    //  0 のままになり、@0 を多用する FM2/FM4 の音色が変わっていた。VGMは書き込み密度が
    //  低くて溢れないため無傷で、同じ曲なのに KSS と VGM で聞こえ方が違う原因だった)
    _pushWrite(reg, data) {
      this.writebuf.push((reg & 0x3f) | ((data & 0xff) << 8));
      // ★clock()を呼ばずに書き込みだけ流し込む経路(無音先読みスキャンの早送り
      // stream-player.js/_resetScan、kss-stream-player.js/_resetScan など)への保険。
      // 実チップ相当のウェイト間隔でしか掃けないキューに数十万件積まれると、
      // shift()がO(n)化して主スレッドごと焼き付く。上限を超えたらパイプラインを
      // 介さずレジスタへ直接反映する(そもそもclock()が無い=時間が進まない経路なので
      // サイクル精度に意味が無く、旧コアの「即時反映」と同じ挙動になる)。
      if (this.writebuf.length - this.writeHead > WRITE_QUEUE_MAX) this._drainDirect();
    }

    /** 溜まった書き込みをパイプラインを介さずレジスタへ直接反映してキューを空にする */
    _drainDirect() {
      for (let i = this.writeHead; i < this.writebuf.length; i++) {
        const w = this.writebuf[i];
        this._applyRegDirect(w & 0x3f, (w >> 8) & 0xff);
      }
      this.writebuf.length = 0;
      this.writeHead = 0;
      this.writeDelay = 0;
      // 対の途中(アドレスだけ出した状態)なら先頭から出し直す。宙に浮いたアドレスは
      // 次の対が自分のアドレスを出し直すので害が無い。
      this._writePhase = 0;
    }

    /** レジスタ1本を即時反映(_doModeWrite / _doRegWrite と同じデコード) */
    _applyRegDirect(reg, d) {
      reg &= 0x3f; d &= 0xff;
      const p = this.patch;
      if (reg <= 0x07) {
        const slot = reg & 0x01;
        switch (reg) {
          case 0x00: case 0x01:
            p.multi[slot] = d & 0x0f; p.ksr[slot] = (d >> 4) & 1;
            p.et[slot] = (d >> 5) & 1; p.vib[slot] = (d >> 6) & 1; p.am[slot] = (d >> 7) & 1;
            break;
          case 0x02: p.ksl[0] = (d >> 6) & 3; p.tl = d & 0x3f; break;
          case 0x03: p.ksl[1] = (d >> 6) & 3; p.dc = (d >> 4) & 1; p.dm = (d >> 3) & 1; p.fb = d & 7; break;
          case 0x04: case 0x05: p.dr[slot] = d & 0x0f; p.ar[slot] = (d >> 4) & 0x0f; break;
          case 0x06: case 0x07: p.rr[slot] = d & 0x0f; p.sl[slot] = (d >> 4) & 0x0f; break;
        }
        return;
      }
      if (reg === 0x0e) {
        this.rhythm = d & 0x3f;
        if (this.isDs1001) this.rhythm |= 0x20;
        this.rm_enable = s8((this.rm_enable & 0x7f) | ((this.rhythm << 2) & 0x80));
        return;
      }
      if (reg === 0x0f) { this.testmode = d & 0x0f; return; }
      const ch = reg & 0x0f;
      if (ch > 8) return;
      switch (reg & 0xf0) {
        case 0x10: this.fnum[ch] = (this.fnum[ch] & 0x100) | d; break;
        case 0x20:
          this.fnum[ch] = (this.fnum[ch] & 0xff) | ((d & 1) << 8);
          this.block[ch] = (d >> 1) & 7;
          this.kon[ch] = (d >> 4) & 1;
          this.son[ch] = (d >> 5) & 1;
          break;
        case 0x30: this.regVol[ch] = d & 0x0f; this.inst[ch] = (d >> 4) & 0x0f; break;
      }
    }

    // 先頭の1件を実チップと同じ2フェーズ(アドレス→データ)へ展開して流す。
    // _writePhase が対の途中を表すので、キューから取り出すのはデータを出す時だけ。
    _pumpWrites() {
      if (this.writeHead >= this.writebuf.length) return;
      if (this.writeDelay > 0) { this.writeDelay--; return; }
      const w = this.writebuf[this.writeHead];
      if (this._writePhase === 0) {
        this.write_data = w & 0x3f;   // アドレスフェーズ
        this.write_a |= 1;
        this._writePhase = 1;
        this.writeDelay = WRITE_GAP_ADDR;
      } else {
        this.write_data = (w >> 8) & 0xff; // データフェーズ
        this.write_d |= 1;
        this._writePhase = 0;
        this.writeHead++;
        if (this.writeHead > 1024 && this.writeHead * 2 > this.writebuf.length) {
          this.writebuf = this.writebuf.slice(this.writeHead); this.writeHead = 0; // たまに詰める
        }
        this.writeDelay = WRITE_GAP_DATA;
      }
    }

    /** レジスタ番号を直接指定して書く(VGM / テスト用) */
    writeReg(reg, data) {
      reg &= 0x3f; data &= 0xff;
      this.regShadow[reg] = data;
      this._addrLatch = reg;
      this._pushWrite(reg, data);
    }

    /** VRC7のNSFバス: $9010=アドレス, $9030=データ */
    writeRegister(addr, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (addr === 0x9010) { this._addrLatch = value & 0x3f; }
      else if (addr === 0x9030) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** FMPACのMSX I/Oポート: 0x7C=アドレス, 0x7D=データ */
    ioWrite(port, value) {
      value &= 0xff;
      // アドレスポートはラッチするだけ。実際にキューへ積むのはデータが来た時(対で1件)。
      if (port === 0x7C) { this._addrLatch = value & 0x3f; }
      else if (port === 0x7D) { this.regShadow[this._addrLatch | 0] = value; this._pushWrite(this._addrLatch | 0, value); }
    }

    /** ホストクロック1サイクル。hostPerOpll個で内部1サイクル進む */
    clock() {
      if (++this.hostAccum < this.hostPerOpll) return;
      this.hostAccum = 0;
      this._pumpWrites();
      this._stepOpll();
    }

    /**
     * clock()を回さない経路(regsOnlyキャプチャ等)で溜まった書き込みを反映させる。
     * [[capture-worker-plan]] のym2612Nuked.flushWrites()と同じ用途。
     */
    flushWrites() {
      let guard = 0;
      while (this.writeHead < this.writebuf.length && guard++ < 1000000) this.clock();
      for (let i = 0; i < this.hostPerOpll * CYCLES_PER_SAMPLE * 2; i++) this.clock();
    }

    mixSample() { return this.lastSample * OUTPUT_GAIN; }

    get rhythmMode() { return !this.isDs1001 && !!(this.rhythm & 0x20); }

    // ────────── 鍵盤表示用スナップショット ──────────
    // 実機のレジスタ影から音色パラメータを取り出し、波形は「今のパラメータでの概形」を
    // 再合成する(時分割パイプラインは模擬しない)。ym2612Nuked.js の nukedSynthWave と同方針。
    _patchOf(ch) {
      const instr = this.inst[ch];
      return instr > 0 ? this.patchrom[instr - 1] : this.patch;
    }

    _dumpPatch(ch) {
      const p = this._patchOf(ch);
      return {
        type: 'opll', inst: this.inst[ch],
        mod: { AM: p.am[0], PM: p.vib[0], EG: p.et[0], KR: p.ksr[0], ML: p.multi[0],
               KL: p.ksl[0], TL: p.tl, FB: p.fb, WF: p.dm,
               AR: p.ar[0], DR: p.dr[0], SL: p.sl[0], RR: p.rr[0] },
        car: { AM: p.am[1], PM: p.vib[1], EG: p.et[1], KR: p.ksr[1], ML: p.multi[1],
               KL: p.ksl[1], TL: 0, FB: 0, WF: p.dc,
               AR: p.ar[1], DR: p.dr[1], SL: p.sl[1], RR: p.rr[1] }
      };
    }

    /** 1周期ぶんのFM波形(-1..1, N点)。egは現在値を使う */
    _synthWave(ch, N) {
      const p = this._patchOf(ch);
      const modEg = this.eg_level[SLOT_MOD[ch]] + (p.tl << 1);
      const carEg = this.eg_level[SLOT_CAR[ch]] + (this.regVol[ch] << 3);
      const ratio = PG_MULTI[p.multi[0]] / (PG_MULTI[p.multi[1]] || 1);
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const mp = Math.round((k / N) * ratio * 1024) & 0x3ff;
        const mo = opOut(mp, modEg, p.dm);
        const cp = (Math.round((k / N) * 1024) + (mo >> 0)) & 0x3ff;
        const co = opOut(cp, carEg, p.dc);
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      return wave;
    }

    _melodySnapshot(ch, N) {
      const fnum = this.fnum[ch], block = this.block[ch];
      const carLevel = this.eg_level[SLOT_CAR[ch]];
      const active = !!this.kon[ch] && carLevel < 0x7f;
      return {
        freq: (this.kon[ch] && fnum > 0) ? SAMPLE_RATE * fnum / Math.pow(2, 19 - block) : 0,
        vol: (15 - this.regVol[ch]) / 15,
        rawVol: this.regVol[ch],
        instrument: this.inst[ch],
        active,
        waveData: active ? this._synthWave(ch, N) : new Array(N).fill(0),
        patch: this._dumpPatch(ch)
      };
    }

    // ★2026-08-22: 打楽器はピークホールドで返す。
    // 鍵盤表示はrAF(約16ms間隔)でスナップショットを読むが、チップはオーディオバッファ単位
    // (ScriptProcessorNodeで50〜90ms)にまとめて進むため、瞬時値だけ見ると短い打楽器の
    // 減衰がサンプリングの隙間に丸ごと落ちる。実測: Aleste Gaiden 7曲目のBDは約50msで
    // 減衰しきり(eg_level 16→33→96→127)、鍵盤のBD行が一度も点灯しなかった
    // (SDは減衰が緩いので見えていた)。前回読んだ時点以降の最小レベル(=最大音量)を保持する。
    _rhythmSlotInfo(peakIdx, slotIdx, freq) {
      const now = this.eg_level[slotIdx];
      const level = Math.min(this._rhythmPeak[peakIdx], now);
      this._rhythmPeak[peakIdx] = now; // 次の窓は現在値から測り直す
      return { freq, active: level < 0x7f, vol: (0x7f - level) / 0x7f };
    }

    snapshot() {
      const N = 128;
      if (this.isDs1001) {
        const out = [];
        for (let i = 0; i < 6; i++) out.push(this._melodySnapshot(i, N));
        return out;
      }
      // ★2026-08-22: melody は常に9本、rhythm も常に付けて返す。
      // リズムモードのビット($0E bit5)を「打つ瞬間だけ立てて即降ろす」ドライバが実在し
      // (SMS版After Burnerは毎秒10〜16回トグル)、返す形をビットに追随させると鍵盤の
      // 行構成が激しく入れ替わって読めなくなる。どちらを表示するかは表示側(keyboard.js)が
      // 「一度リズムを見たら以後保持」する単調な運用で決める。
      const rhythmMode = this.rhythmMode;
      const melody = [];
      for (let i = 0; i < 9; i++) melody.push(this._melodySnapshot(i, N));

      const f = (ch) => this.fnum[ch] > 0 ? SAMPLE_RATE * this.fnum[ch] / Math.pow(2, 19 - this.block[ch]) : 0;
      return {
        rhythmMode,
        melody,
        rhythm: {
          bd:  this._rhythmSlotInfo(0, RHYTHM_SLOT[0], f(6)),
          sd:  this._rhythmSlotInfo(1, RHYTHM_SLOT[1], 0),
          tom: this._rhythmSlotInfo(2, RHYTHM_SLOT[2], f(8)),
          cym: this._rhythmSlotInfo(3, RHYTHM_SLOT[3], 0),
          hh:  this._rhythmSlotInfo(4, RHYTHM_SLOT[4], 0)
        }
      };
    }
  }

  // 書き込みキューの最小間隔(内部サイクル)。実チップのウェイト仕様に対応する。
  //  - アドレス書き込み後: write_dataラッチを取り合わないよう数サイクル空ければよい。
  //  - データ書き込み後  : ★18以上必須。FMレジスタ($10/$20/$30系)は _doRegWrite が
  //    「(address&0x0f) == cycles」の1サイクルでしか反映しないため、次のアドレス書き込みが
  //    write_fm_data を落とす前に18サイクル(全cycles値)を一巡させないと書き込みが消える。
  //    実機YM2413のデータ書き込み後ウェイト84マスタサイクル(=21内部サイクル)とも符合する。
  // キュー上限。超えたら直接反映へ切り替える(_pushWrite のコメント参照)
  // ★キュー上限は「実ドライバの通常の書き込みバーストでは絶対に届かない」値にすること。
  // 32では実測でIllusion City(KSS)の通常再生中に80フレームで95回も直接反映が発動し、
  // 実チップのウェイトを踏んだ書き込みタイミングが壊れてFM2の音が変わっていた
  // (直接反映を止めるとVGM経路と完全一致した)。KSSのOPLL書き込みは最大74件/フレーム。
  // 取り出しは writeHead 方式(shift不使用)なので、キューが長くても取り出しコストは一定。
  // ここが効くのは clock() が呼ばれない早送り経路だけで、そこは数万〜数十万件積まれる。
  const WRITE_QUEUE_MAX = 4096;
  const WRITE_GAP_ADDR = 4;
  const WRITE_GAP_DATA = 20;

  // 出力ゲイン。旧コア(emu2413移植)とラウドネスを揃えるための実測較正値。
  // 新コアの生の出力は「18サイクルぶんの時分割DAC出力の総和」。@1/@4/@8/@12/@15
  // を単音で鳴らしてRMSを旧コアと突き合わせ、平均比が1.0になるよう決めた(音色ごとの比は
  // 0.4〜1.2とばらつく。コアが違えばEG/出力段が違うので一致はしない)
  // ([[emu-loudness-balance-and-master-volume]] のフォーマット間バランスを崩さないため)。
  const OUTPUT_GAIN = 1 / 2000;

  // DC遮断フィルタ係数(1 - 2π*5Hz/49716)
  const DC_BLOCK_R = 0.99937;

  // 波形プレビュー用の1オペレータ出力(実機と同じ対数sin→exp経路)
  function opOut(phase10, egLevel, halfWave) {
    let phase = phase10 & 0x3ff;
    const neg = (phase >> 9) & 1;
    if (phase & 0x100) phase ^= 0xff;
    let level = LOGSIN[phase & 0xff] + (Math.min(127, egLevel) << 4);
    if (level >= 4096) level = 4095;
    const out = EXPROM[level & 0xff] >> (level >> 8);
    if (halfWave && neg) return 0;
    return neg ? ~out : out;
  }

  // 音色エディタの逆算(src/ui/vrc7ToneSolver.js)が定常状態の1周期を実機と同じ演算で
  // 作るために使う。LOGSIN/EXPROM表そのものは外へ出さない(表を持ち出すと写しがずれる)
  OPLLNuked.opOut = opOut;

  // 内蔵音色ROMをレジスタ$00-$07と同じ8バイト並びで返す(type: 'ym2413' | 'ds1001'(VRC7)、inst 1-15)。
  // 変換側(src/convert/toneDerive.js)が「YM2413のプリセット音色の波形」をN163等へ写すときに使う。
  // ★VRC7(ds1001)側の写しは src/convert/vrc7Tone.js PRESETS にもある(Workerバンドル都合の複製)
  OPLLNuked.presetBytes = function (type, inst) {
    const rom = type === 'ds1001' ? PATCH_DS1001 : PATCH_YM2413;
    const p = rom[(inst | 0) - 1];
    if (!p) return null;
    const b20 = (i) => (p.am[i] << 7) | (p.vib[i] << 6) | (p.et[i] << 5) | (p.ksr[i] << 4) | (p.multi[i] & 15);
    return [
      b20(0), b20(1),
      ((p.ksl[0] & 3) << 6) | (p.tl & 63),
      ((p.ksl[1] & 3) << 6) | ((p.dc & 1) << 4) | ((p.dm & 1) << 3) | (p.fb & 7),
      (p.ar[0] << 4) | p.dr[0], (p.ar[1] << 4) | p.dr[1],
      (p.sl[0] << 4) | p.rr[0], (p.sl[1] << 4) | p.rr[1]
    ];
  };

  Emu.OPLLNuked = OPLLNuked;
})(globalThis);

/*
 * VRC7 拡張音源エミュレータ (OPLL / YM2413)
 * MML.Emu.VRC7Audio
 *
 * ★2026-08-22: 既定の再生コアは opllNuked.js (Nuked-OPLL移植) に移行した。このファイルの
 * 実装は MML.Emu.OPLL_CORE = 'emu2413' を指定したときのA/B比較用として残してある。
 *
 * Mitsutaka Okazaki の emu2413 (VirtuaNES同梱版) を忠実に移植した2オペレータFM。
 * 6メロディチャンネル。DB単位系(0.375dB/step)・1024点対数sin・DB2LIN・正確なEG状態機械。
 * 音色ROMは nukeykt/Nuked-OPLL (GPLv2) の patch_ds1001 = VRC7実チップの die shot 読み出し値。
 *   $9010 : アドレスポート  $9030 : データポート
 * 出力49716Hz (VRC7マスタ3.58MHz/72 = CPUクロック/36)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CH = 6;
  const CYCLES_PER_SAMPLE = 36;
  const SAMPLE_RATE = 49716;

  // ---- 定数 (emu2413) ----
  const PG_BITS = 10, PG_WIDTH = 1 << PG_BITS;       // 1024点波形(emu2413本家に合わせて9→10bit化)
  const DP_BITS = 19, DP_WIDTH = 1 << DP_BITS, DP_BASE_BITS = DP_BITS - PG_BITS; // 9
  const DB_STEP = 0.375, DB_BITS = 7, DB_MUTE = 1 << DB_BITS;   // 128
  const EG_STEP = 0.375, EG_BITS = 7;
  const EG2DB = 1;                                    // EG_STEP/DB_STEP
  const TL2EG = 2;                                    // TL_STEP/EG_STEP (0.75/0.375)
  const DB2LIN_AMP_BITS = 10, SLOT_AMP_BITS = DB2LIN_AMP_BITS;
  const EG_DP_BITS = 22, EG_DP_WIDTH = 1 << EG_DP_BITS;
  const PM_PG_BITS = 8, PM_PG_WIDTH = 1 << PM_PG_BITS;
  const PM_DP_BITS = 16, PM_DP_WIDTH = 1 << PM_DP_BITS;
  const AM_PG_BITS = 8, AM_PG_WIDTH = 1 << AM_PG_BITS;
  const AM_DP_BITS = 16, AM_DP_WIDTH = 1 << AM_DP_BITS;
  const PM_AMP_BITS = 8, PM_AMP = 1 << PM_AMP_BITS;
  const PM_SPEED = 6.4, PM_DEPTH = 13.75, AM_SPEED = 3.7, AM_DEPTH = 4.8;

  // EGモード
  const SETTLE = 0, ATTACK = 1, DECAY = 2, SUSHOLD = 3, SUSTINE = 4, RELEASE = 5, FINISH = 6;

  // ---- 音色ROM (実チップ内蔵ROM。各8バイト=$00-$07) ----
  // ★2026-08-22: 従来の VirtuaNES vrc7tone.h は実測値ではなく耳コピ推定で、実体は
  // YM2413用テーブルの微改変だった(@2 Guitar が opllMsx.js の YM2413 値と1バイト違い)。
  // nukeykt/Nuked-OPLL の patch_ds1001 は VRC7(Konami DS1001)を decap/die shot
  // (siliconpr0n: digshadow, John McMaster)から読み出した本物のROM内容なので差し替え。
  // NESdev Wiki "VRC7 audio" の音色表と全15音色一致を確認済み。音色名はNESdev Wiki準拠。
  const VRC7_INST = [
    [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00], // 0: ユーザー音色枠($00-$07で可変)
    [0x03,0x21,0x05,0x06,0xe8,0x81,0x42,0x27], // 1: Buzzy Bell
    [0x13,0x41,0x14,0x0d,0xd8,0xf6,0x23,0x12], // 2: Guitar
    [0x11,0x11,0x08,0x08,0xfa,0xb2,0x20,0x12], // 3: Wurly
    [0x31,0x61,0x0c,0x07,0xa8,0x64,0x61,0x27], // 4: Flute
    [0x32,0x21,0x1e,0x06,0xe1,0x76,0x01,0x28], // 5: Clarinet
    [0x02,0x01,0x06,0x00,0xa3,0xe2,0xf4,0xf4], // 6: Synth
    [0x21,0x61,0x1d,0x07,0x82,0x81,0x11,0x07], // 7: Trumpet
    [0x23,0x21,0x22,0x17,0xa2,0x72,0x01,0x17], // 8: Organ
    [0x35,0x11,0x25,0x00,0x40,0x73,0x72,0x01], // 9: Bells
    [0xb5,0x01,0x0f,0x0f,0xa8,0xa5,0x51,0x02], // 10: Vibes
    [0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12], // 11: Vibraphone
    [0x71,0x23,0x11,0x06,0x65,0x74,0x18,0x16], // 12: Tutti
    [0x01,0x02,0xd3,0x05,0xc9,0x95,0x03,0x02], // 13: Fretless
    [0x61,0x63,0x0c,0x00,0x94,0xc0,0x33,0xf6], // 14: Synth Bass
    [0x21,0x72,0x0d,0x00,0xc1,0xd5,0x56,0x06]  // 15: Sweep
  ];

  // dump(8byte) → {mod,car} パッチ (emu2413 dump2patch)
  function dump2patch(d) {
    return {
      mod: { AM:(d[0]>>7)&1, PM:(d[0]>>6)&1, EG:(d[0]>>5)&1, KR:(d[0]>>4)&1, ML:d[0]&15,
             KL:(d[2]>>6)&3, TL:d[2]&63, FB:d[3]&7, WF:(d[3]>>3)&1,
             AR:(d[4]>>4)&15, DR:d[4]&15, SL:(d[6]>>4)&15, RR:d[6]&15 },
      car: { AM:(d[1]>>7)&1, PM:(d[1]>>6)&1, EG:(d[1]>>5)&1, KR:(d[1]>>4)&1, ML:d[1]&15,
             KL:(d[3]>>6)&3, TL:0, FB:0, WF:(d[3]>>4)&1,
             AR:(d[5]>>4)&15, DR:d[5]&15, SL:(d[7]>>4)&15, RR:d[7]&15 }
    };
  }
  const PATCH = VRC7_INST.map(dump2patch); // [16] {mod,car}
  // 変換側(src/convert/vrc7Tone.js の「近いプリセット探し」)にも同じ表が要る。あちらは
  // Workerバンドルにエミュレータを同梱できない都合で自前の写しを持っているので、
  // tools/headless/check-all.js がこの export と突き合わせて食い違いを検出する。
  Emu.VRC7_INST = VRC7_INST;

  // ---- テーブル ----
  function Min(a, b) { return a < b ? a : b; }

  // AR用 線形→対数
  const AR_ADJUST = new Uint32Array(1 << EG_BITS);
  AR_ADJUST[0] = 1 << EG_BITS;
  for (let i = 1; i < 128; i++)
    AR_ADJUST[i] = ((1 << EG_BITS) - 1 - (1 << EG_BITS) * Math.log(i) / Math.log(128)) | 0;

  // DB2LIN
  const DB2LIN = new Int32Array((DB_MUTE + DB_MUTE) * 2);
  for (let i = 0; i < DB_MUTE + DB_MUTE; i++) {
    let v = (((1 << DB2LIN_AMP_BITS) - 1) * Math.pow(10, -i * DB_STEP / 20)) | 0;
    if (i >= DB_MUTE) v = 0;
    DB2LIN[i] = v;
    DB2LIN[i + DB_MUTE + DB_MUTE] = -v;
  }

  function lin2db(d) {
    if (d === 0) return DB_MUTE - 1;
    return Min(-(((20.0 * Math.log10(d)) / DB_STEP) | 0), DB_MUTE - 1);
  }

  // sinテーブル (0=full, 1=half)
  const fullsin = new Uint32Array(PG_WIDTH);
  const halfsin = new Uint32Array(PG_WIDTH);
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[i] = lin2db(Math.sin(2.0 * Math.PI * i / PG_WIDTH));
  for (let i = 0; i < PG_WIDTH / 4; i++) fullsin[PG_WIDTH / 2 - 1 - i] = fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) fullsin[PG_WIDTH / 2 + i] = DB_MUTE + DB_MUTE + fullsin[i];
  for (let i = 0; i < PG_WIDTH / 2; i++) halfsin[i] = fullsin[i];
  for (let i = PG_WIDTH / 2; i < PG_WIDTH; i++) halfsin[i] = fullsin[0];
  const WAVEFORM = [fullsin, halfsin];

  // LFO
  const pmtable = new Int32Array(PM_PG_WIDTH);
  for (let i = 0; i < PM_PG_WIDTH; i++)
    pmtable[i] = (PM_AMP * Math.pow(2, PM_DEPTH * Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH) / 1200)) | 0;
  const amtable = new Int32Array(AM_PG_WIDTH);
  for (let i = 0; i < AM_PG_WIDTH; i++)
    amtable[i] = (AM_DEPTH / 2 / DB_STEP * (1.0 + Math.sin(2.0 * Math.PI * i / PM_PG_WIDTH))) | 0;

  // clk/rate はネイティブ(49716Hz)固定なので rate_adjust=恒等。
  // dphaseTable[fnum][block][ML]
  const MLT = [1, 1*2, 2*2, 3*2, 4*2, 5*2, 6*2, 7*2, 8*2, 9*2, 10*2, 10*2, 12*2, 12*2, 15*2, 15*2];
  const dphaseTable = [];
  for (let fnum = 0; fnum < 512; fnum++) {
    const a = []; dphaseTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Uint32Array(16); a.push(b);
      for (let ML = 0; ML < 16; ML++)
        b[ML] = (((fnum * MLT[ML]) << block) >> (20 - DP_BITS)) >>> 0;
    }
  }

  // tllTable[fnum4][block][TL][KL]
  const KL_DB2 = [0.000,9.000,12.000,13.875,15.000,16.125,16.875,17.625,18.000,18.750,19.125,19.500,19.875,20.250,20.625,21.000].map(x => (x * 2) | 0);
  const tllTable = [];
  for (let fnum = 0; fnum < 16; fnum++) {
    const a = []; tllTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = []; a.push(b);
      for (let TL = 0; TL < 64; TL++) {
        const c = new Uint32Array(4); b.push(c);
        for (let KL = 0; KL < 4; KL++) {
          if (KL === 0) c[KL] = (TL2EG * TL) >>> 0;
          else {
            const tmp = KL_DB2[fnum] - (3 * 2) * (7 - block);
            if (tmp <= 0) c[KL] = (TL2EG * TL) >>> 0;
            else c[KL] = (((tmp >> (3 - KL)) / EG_STEP) | 0) + TL2EG * TL;
          }
        }
      }
    }
  }

  // rksTable[fnum8][block][KR]
  const rksTable = [];
  for (let f8 = 0; f8 < 2; f8++) {
    const a = []; rksTable.push(a);
    for (let block = 0; block < 8; block++) {
      const b = new Int32Array(2); a.push(b);
      b[0] = block >> 1;
      b[1] = (block << 1) + f8;
    }
  }

  // dphaseARTable[AR][Rks], dphaseDRTable[DR][Rks]
  const dphaseARTable = [], dphaseDRTable = [];
  for (let AR = 0; AR < 16; AR++) {
    const a = new Uint32Array(16); dphaseARTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = AR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (AR === 0) a[Rks] = 0;
      else if (AR === 15) a[Rks] = EG_DP_WIDTH;
      else a[Rks] = ((3 * (RL + 4)) << (RM + 1)) >>> 0;
    }
  }
  for (let DR = 0; DR < 16; DR++) {
    const a = new Uint32Array(16); dphaseDRTable.push(a);
    for (let Rks = 0; Rks < 16; Rks++) {
      let RM = DR + (Rks >> 2); if (RM > 15) RM = 15; const RL = Rks & 3;
      if (DR === 0) a[Rks] = 0;
      else a[Rks] = ((RL + 4) << (RM - 1)) >>> 0;
    }
  }

  // SL[16] (eg_phase単位)
  const SL_DB = [0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,48];
  const SL = new Uint32Array(16);
  for (let i = 0; i < 16; i++) SL[i] = ((((SL_DB[i] / 3.0) * 8) | 0) << (EG_DP_BITS - EG_BITS)) >>> 0;

  const pm_dphase = ((PM_SPEED * PM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;
  const am_dphase = ((AM_SPEED * AM_DP_WIDTH / (SAMPLE_RATE)) + 0.5) | 0;

  // ---- スロット ----
  class Slot {
    constructor(type) {
      this.type = type; // 0=mod 1=car
      this.patch = PATCH[0].mod;
      this.reset();
    }
    reset() {
      this.sintbl = WAVEFORM[0];
      this.phase = 0; this.dphase = 0; this.pgout = 0;
      this.output = [0, 0]; this.feedback = 0;
      this.eg_mode = SETTLE; this.eg_phase = EG_DP_WIDTH; this.eg_dphase = 0; this.egout = 0;
      this.fnum = 0; this.block = 0; this.volume = 0; this.sustine = 0;
      this.tll = 0; this.rks = 0;
    }
    calcEgDphase() {
      const p = this.patch;
      switch (this.eg_mode) {
        case ATTACK: return dphaseARTable[p.AR][this.rks];
        case DECAY: return dphaseDRTable[p.DR][this.rks];
        case SUSHOLD: return 0;
        case SUSTINE: return dphaseDRTable[p.RR][this.rks];
        case RELEASE:
          if (this.sustine) return dphaseDRTable[5][this.rks];
          else if (p.EG) return dphaseDRTable[p.RR][this.rks];
          else return dphaseDRTable[7][this.rks];
        default: return 0;
      }
    }
    updatePG() { this.dphase = dphaseTable[this.fnum][this.block][this.patch.ML]; }
    updateTLL() {
      this.tll = (this.type === 0)
        ? tllTable[this.fnum >> 5][this.block][this.patch.TL][this.patch.KL]
        : tllTable[this.fnum >> 5][this.block][this.volume][this.patch.KL];
    }
    updateRKS() { this.rks = rksTable[this.fnum >> 8][this.block][this.patch.KR]; }
    updateWF() { this.sintbl = WAVEFORM[this.patch.WF]; }
    updateEG() { this.eg_dphase = this.calcEgDphase(); }
    updateAll() { this.updatePG(); this.updateTLL(); this.updateRKS(); this.updateWF(); this.updateEG(); }
    slotOn() { this.eg_mode = ATTACK; this.phase = 0; this.eg_phase = 0; }
    slotOff() {
      if (this.eg_mode === ATTACK)
        this.eg_phase = (AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F] << (EG_DP_BITS - EG_BITS)) >>> 0;
      this.eg_mode = RELEASE;
    }
    calcPhase(lfo_pm) {
      if (this.patch.PM) this.phase = (this.phase + (((this.dphase * lfo_pm) >> PM_AMP_BITS) >>> 0)) >>> 0;
      else this.phase = (this.phase + this.dphase) >>> 0;
      this.phase &= (DP_WIDTH - 1);
      this.pgout = this.phase >>> DP_BASE_BITS;
      return this.pgout;
    }
    calcEnvelope(lfo_am) {
      let egout;
      switch (this.eg_mode) {
        case ATTACK:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          if (this.eg_phase & EG_DP_WIDTH) { egout = 0; this.eg_phase = 0; this.eg_mode = DECAY; this.updateEG(); }
          else egout = AR_ADJUST[(this.eg_phase >>> (EG_DP_BITS - EG_BITS)) & 0x7F];
          break;
        case DECAY:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.eg_phase >= SL[this.patch.SL]) {
            this.eg_phase = SL[this.patch.SL];
            this.eg_mode = this.patch.EG ? SUSHOLD : SUSTINE;
            this.updateEG();
            egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          }
          break;
        case SUSHOLD:
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (this.patch.EG === 0) { this.eg_mode = SUSTINE; this.updateEG(); }
          break;
        case SUSTINE:
        case RELEASE:
          this.eg_phase = (this.eg_phase + this.eg_dphase) >>> 0;
          egout = this.eg_phase >>> (EG_DP_BITS - EG_BITS);
          if (egout >= (1 << EG_BITS)) { this.eg_mode = FINISH; egout = (1 << EG_BITS) - 1; }
          break;
        case FINISH: default:
          egout = (1 << EG_BITS) - 1;
          break;
      }
      egout = this.patch.AM ? (EG2DB * (egout + this.tll) + lfo_am) : (EG2DB * (egout + this.tll));
      if (egout >= DB_MUTE) egout = DB_MUTE - 1;
      this.egout = egout;
      return egout;
    }
  }

  // emu2413本家 calc_slot_car: modOut = 2*(fm>>1) (fmのLSBを切り捨てるだけで倍化はしない)
  function modToCarPhase(fm) { return 2 * (fm >> 1); }

  class Vrc7Channel {
    constructor() {
      this.mod = new Slot(0);
      this.car = new Slot(1);
      this.patchNumber = 0;
      this.keyStatus = 0;
    }
    reset() { this.mod.reset(); this.car.reset(); this.keyStatus = 0; }

    calcModulator(lfo_am, lfo_pm) {
      const s = this.mod;
      s.output[1] = s.output[0];
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) s.output[0] = 0;
      else if (s.patch.FB !== 0) {
        // emu2413本家: fm = (output[1]+output[0]) >> (9-FB)。s.feedbackは(output[1]+output[0])>>1で
        // 既に1bitシフト済みのため、ここでのシフト量は(9-FB)-1 = (8-FB)。
        const fm = (s.feedback) >> (8 - s.patch.FB);
        s.output[0] = DB2LIN[s.sintbl[(pgout + fm) & (PG_WIDTH - 1)] + egout];
      } else {
        s.output[0] = DB2LIN[s.sintbl[pgout] + egout];
      }
      // s.feedbackは自己変調(次回calcModulator呼び出し時のfm計算)専用。キャリアへ渡すのは
      // emu2413本家同様、平均化前の生のoutput[0]。
      s.feedback = (s.output[1] + s.output[0]) >> 1;
      return s.output[0];
    }
    calcCarrier(fm, lfo_am, lfo_pm) {
      const s = this.car;
      const egout = s.calcEnvelope(lfo_am);
      const pgout = s.calcPhase(lfo_pm);
      if (egout >= DB_MUTE - 1) return 0;
      return DB2LIN[s.sintbl[(pgout + modToCarPhase(fm)) & (PG_WIDTH - 1)] + egout];
    }
  }

  class VRC7Audio {
    constructor() { 
      // ★2026-08-22: 既定ではNuked-OPLLコア(opllNuked.js)へ委譲する。
      // MML.Emu.OPLL_CORE = 'emu2413' を指定するとこの下の旧コア(emu2413 0.6x系移植)に戻る。
      if (Emu.OPLL_CORE !== 'emu2413' && Emu.OPLLNuked) return new Emu.OPLLNuked({ chipType: 'ds1001' });
      this._init(); this.mute = new Array(NUM_CH).fill(false); this.vol = new Array(NUM_CH).fill(1); }
    _init() {
      this.addr = 0;
      this.reg = new Uint8Array(0x40);
      this.patches = [];               // [16] {mod,car} (音色0はカスタム, 可変)
      for (let i = 0; i < 16; i++) this.patches.push({ mod: Object.assign({}, PATCH[i].mod), car: Object.assign({}, PATCH[i].car) });
      this.channels = [];
      for (let i = 0; i < NUM_CH; i++) { const c = new Vrc7Channel(); this.channels.push(c); this._setPatch(i, 0); }
      this.pm_phase = 0; this.am_phase = 0; this.lfo_pm = 0; this.lfo_am = 0;
      this.cyc = 0; this.lastSample = 0;
    }
    reset() { this._init(); }

    _setPatch(i, num) {
      const c = this.channels[i];
      c.patchNumber = num;
      c.mod.patch = this.patches[num].mod;
      c.car.patch = this.patches[num].car;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0x9010) this.addr = value & 0x3F;
      else if (addr === 0x9030) this.writeReg(this.addr, value);
    }

    writeReg(reg, data) {
      reg &= 0x3F; data &= 0xFF;
      const cust = this.patches[0];
      if (reg <= 0x07) {
        // カスタム音色
        switch (reg) {
          case 0x00: cust.mod.AM=(data>>7)&1; cust.mod.PM=(data>>6)&1; cust.mod.EG=(data>>5)&1; cust.mod.KR=(data>>4)&1; cust.mod.ML=data&15; break;
          case 0x01: cust.car.AM=(data>>7)&1; cust.car.PM=(data>>6)&1; cust.car.EG=(data>>5)&1; cust.car.KR=(data>>4)&1; cust.car.ML=data&15; break;
          case 0x02: cust.mod.KL=(data>>6)&3; cust.mod.TL=data&63; break;
          case 0x03: cust.car.KL=(data>>6)&3; cust.car.WF=(data>>4)&1; cust.mod.WF=(data>>3)&1; cust.mod.FB=data&7; break;
          case 0x04: cust.mod.AR=(data>>4)&15; cust.mod.DR=data&15; break;
          case 0x05: cust.car.AR=(data>>4)&15; cust.car.DR=data&15; break;
          case 0x06: cust.mod.SL=(data>>4)&15; cust.mod.RR=data&15; break;
          case 0x07: cust.car.SL=(data>>4)&15; cust.car.RR=data&15; break;
        }
        for (let i = 0; i < NUM_CH; i++) if (this.channels[i].patchNumber === 0) { this.channels[i].mod.updateAll(); this.channels[i].car.updateAll(); }
      } else if (reg >= 0x10 && reg <= 0x15) {
        const ch = reg - 0x10, c = this.channels[ch];
        const fnum = data + ((this.reg[0x20 + ch] & 1) << 8);
        c.mod.fnum = c.car.fnum = fnum;
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x20 && reg <= 0x25) {
        const ch = reg - 0x20, c = this.channels[ch];
        const fnum = ((data & 1) << 8) + this.reg[0x10 + ch];
        const block = (data >> 1) & 7;
        c.mod.fnum = c.car.fnum = fnum; c.mod.block = c.car.block = block;
        // sustine
        if ((this.reg[reg] ^ data) & 0x20) { c.car.sustine = (data >> 5) & 1; }
        // key on/off
        const key = (data & 0x10) !== 0;
        if (key) { if (!c.keyStatus) { c.mod.slotOn(); c.car.slotOn(); } c.keyStatus = 1; }
        else { if (c.keyStatus) c.car.slotOff(); c.keyStatus = 0; }
        c.mod.updateAll(); c.car.updateAll();
      } else if (reg >= 0x30 && reg <= 0x35) {
        const ch = reg - 0x30, c = this.channels[ch];
        this._setPatch(ch, (data >> 4) & 15);
        c.car.volume = (data & 15) << 2; // 6bit
        c.mod.updateAll(); c.car.updateAll();
      }
      this.reg[reg] = data;
    }

    _updateAMPM() {
      this.pm_phase = (this.pm_phase + pm_dphase) & (PM_DP_WIDTH - 1);
      this.am_phase = (this.am_phase + am_dphase) & (AM_DP_WIDTH - 1);
      this.lfo_am = amtable[this.am_phase >>> (AM_DP_BITS - AM_PG_BITS)];
      this.lfo_pm = pmtable[this.pm_phase >>> (PM_DP_BITS - PM_PG_BITS)];
    }

    _calc() {
      this._updateAMPM();
      let inst = 0;
      for (let i = 0; i < NUM_CH; i++) {
        const c = this.channels[i];
        if (c.car.eg_mode === FINISH) continue;
        const fm = c.calcModulator(this.lfo_am, this.lfo_pm);
        const out = c.calcCarrier(fm, this.lfo_am, this.lfo_pm);
        if (!this.mute[i]) inst += out * this.vol[i];
      }
      return inst; // ±(1023*6)
    }

    clock() {
      if (++this.cyc < CYCLES_PER_SAMPLE) return;
      this.cyc = 0;
      this.lastSample = this._calc();
    }

    mixSample() {
      // emu2413: out16 = clamp(inst*8). ここでは -1..1 に正規化しゲイン調整。
      return (this.lastSample / 4096) * 0.5;
    }
  }

  // ---- 鍵盤表示用スナップショット ----
  Emu.snapshotVRC7 = function (chip) {
    if (typeof chip.snapshot === 'function') return chip.snapshot(); // Nukedコア
    const out = [];
    const N = 128; // FM連続波形なので線形補間前提で高めの解像度
    for (let i = 0; i < NUM_CH; i++) {
      const c = chip.channels[i];
      const mod = c.mod, car = c.car;
      const freq = (c.keyStatus && car.fnum > 0) ? SAMPLE_RATE * car.fnum / Math.pow(2, 19 - car.block) : 0;
      const active = c.keyStatus && car.eg_mode !== FINISH && car.eg_mode !== SETTLE;
      // 現在のオペレータ状態で1周期のFM波形を合成
      const modEg = mod.egout, carEg = car.egout;
      const ratio = car.dphase > 0 ? mod.dphase / car.dphase : 1;
      const wave = new Array(N);
      let mx = 1e-6;
      for (let k = 0; k < N; k++) {
        const cp = Math.round((k / N) * PG_WIDTH) & (PG_WIDTH - 1);
        const mp = Math.round((k / N) * ratio * PG_WIDTH) & (PG_WIDTH - 1);
        const mo = DB2LIN[mod.sintbl[mp] + Math.min(DB_MUTE - 1, modEg)];
        const co = (carEg >= DB_MUTE - 1) ? 0 : DB2LIN[car.sintbl[(cp + (mo << 1)) & (PG_WIDTH - 1)] + carEg];
        wave[k] = co;
        if (Math.abs(co) > mx) mx = Math.abs(co);
      }
      for (let k = 0; k < N; k++) wave[k] /= mx;
      // patch: 鍵盤の大波形表示の下に音色データ(@OT形式)を出すためのパラメータ
      // (chip.patches[n] の {mod,car}。emu2413のpatch構造体そのまま: AM/PM/EG/KR/ML/KL/TL/FB/WF/AR/DR/SL/RR)
      const pt = chip.patches[c.patchNumber];
      out.push({
        freq,
        vol: (15 - (c.car.volume >> 2)) / 15,
        rawVol: c.car.volume >> 2,
        instrument: c.patchNumber,
        active,
        waveData: active ? wave : new Array(N).fill(0),
        patch: pt ? { type: 'opll', inst: c.patchNumber, mod: pt.mod, car: pt.car } : null
      });
    }
    return out;
  };

  Emu.VRC7Audio = VRC7Audio;
})(globalThis);

/*
 * FDS (ディスクシステム) 拡張音源エミュレータ
 * MML.Emu.FDSAudio
 *
 * 64サンプル(6bit)のウェーブテーブル波形メモリ音源 + ボリュームエンベロープ + ピッチモジュレータ。
 *
 *   $4040-$407F : 波形メモリ(6bit, $4089 bit7=1 の間のみ書き込み可)
 *   $4080       : ボリュームエンベロープ (bit7=1:直接指定, bit6=方向, bits0-5=速度/ゲイン)
 *   $4082       : 周波数下位8bit
 *   $4083       : bits0-3=周波数上位4bit, bit6=エンベロープ停止, bit7=1で消音/波形リセット
 *   $4084       : モジュレータゲイン/エンベロープ (同形式)。ゲインはピッチ変調の深さを決める(0=変調なし)
 *   $4085       : モジュレータカウンタ直接設定 (7bit符号付き)
 *   $4086       : モジュレータ周波数下位8bit
 *   $4087       : bits0-3=モジュレータ周波数上位4bit, bit7=1で停止
 *   $4088       : モジュレータテーブル書き込み (停止中のみ有効, 下位3bit)
 *   $4089       : bit7=波形メモリ書き込み許可, bits0-1=マスターボリューム
 *   $408A       : エンベロープ速度マスタ (0=最速, 値が大きいほど遅い)
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // NESdev 準拠: マスターボリューム 0=全量, 1=2/3, 2=2/4, 3=2/5
  const MASTER_VOLUME_SCALE = [1.0, 2 / 3, 2 / 4, 2 / 5];

  // モジュレータテーブルの3bitエントリをカウンタ増分に変換
  // 0=+0, 1=+1, 2=+2, 3=+4, 4=リセット(0), 5=-4, 6=-2, 7=-1
  const MOD_TABLE_DELTA = [0, 1, 2, 4, 0, -4, -2, -1];

  class FDSAudio {
    constructor() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;

      // ボリュームエンベロープ
      this.volEnvEnabled = false; // bit7=0 のとき有効
      this.volEnvIncrease = false; // bit6
      this.volEnvSpeed = 0;        // bits0-5 (リロード値)
      this.volGain = 32;           // 実際の出力ゲイン (0-32)
      this.volEnvTimer = 0;

      // メインチャンネル
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false; // $4083 bit6
      this.phaseAcc = 0;
      this.effectiveFreq = 0; // モジュレーション適用後の実ピッチ(内部単位、鍵盤表示用)

      // モジュレータエンベロープ
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;

      // モジュレータ
      this.modFreq = 0;
      this.modEnabled = false; // bit7=0 のとき有効
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(32); // 生3bit値 (0-7)
      this.modWritePos = 0;
      this.modTablePos = 0;   // 再生位置
      this.modCounter = 0;    // 現在のモジュレータ出力値 (-64..63)

      // エンベロープマスタ速度レジスタ ($408A)
      // FDS 電源ON時デフォルト = $E8 = 232 (実機ハードウェア仕様)
      // ゲームが $408A を書かない場合もこの値が使われる
      this.envRate = 0xE8;
      this.envRateClock = 0;

      this.mute = { wave: false };
      this.vol = { wave: 1 };
    }

    reset() {
      this.wave = new Uint8Array(64);
      this.waveWriteEnable = false;
      this.masterVolume = 0;
      this.volEnvEnabled = false;
      this.volEnvIncrease = false;
      this.volEnvSpeed = 0;
      this.volGain = 32;
      this.volEnvTimer = 0;
      this.freq = 0;
      this.disabled = true;
      this.envHalt = false;
      this.phaseAcc = 0;
      this.effectiveFreq = 0;
      this.modEnvEnabled = false;
      this.modEnvIncrease = false;
      this.modEnvSpeed = 0;
      this.modGain = 32;
      this.modEnvTimer = 0;
      this.modFreq = 0;
      this.modEnabled = false;
      this.modPhaseAcc = 0;
      this.modTable = new Uint8Array(32);
      this.modWritePos = 0;
      this.modTablePos = 0;
      this.modCounter = 0;
      this.envRate = 0xE8; // FDS 電源ON時デフォルト
      this.envRateClock = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x4040 && addr <= 0x407F) {
        if (this.waveWriteEnable) this.wave[addr - 0x4040] = value & 0x3F;
      } else if (addr === 0x4080) {
        if (value & 0x80) {
          // 直接指定モード: bits0-5 をゲインとして即時反映(6bit生値を保持。出力段で32に
          // 頭打ちするのはmixSample側。エンベロープ減衰は書かれた値から数え始めるため)
          this.volEnvEnabled = false;
          this.volGain = value & 0x3F;
        } else {
          // エンベロープモード
          this.volEnvEnabled = true;
          this.volEnvIncrease = (value & 0x40) !== 0;
          this.volEnvSpeed = value & 0x3F;
          this.volEnvTimer = this.volEnvSpeed + 1;
        }
      } else if (addr === 0x4082) {
        this.freq = (this.freq & 0x0F00) | value;
      } else if (addr === 0x4083) {
        this.freq = (this.freq & 0x00FF) | ((value & 0x0F) << 8);
        this.envHalt = (value & 0x40) !== 0;
        this.disabled = (value & 0x80) !== 0;
        if (this.disabled) this.phaseAcc = 0;
      } else if (addr === 0x4084) {
        if (value & 0x80) {
          this.modEnvEnabled = false;
          this.modGain = value & 0x3F;
        } else {
          this.modEnvEnabled = true;
          this.modEnvIncrease = (value & 0x40) !== 0;
          this.modEnvSpeed = value & 0x3F;
          this.modEnvTimer = this.modEnvSpeed + 1;
        }
      } else if (addr === 0x4085) {
        // モジュレータカウンタを直接設定 (7bit符号付き)
        const v = value & 0x7F;
        this.modCounter = (v >= 64) ? (v - 128) : v;
      } else if (addr === 0x4086) {
        this.modFreq = (this.modFreq & 0x0F00) | value;
      } else if (addr === 0x4087) {
        this.modFreq = (this.modFreq & 0x00FF) | ((value & 0x0F) << 8);
        this.modEnabled = (value & 0x80) === 0;
        if (!this.modEnabled) {
          // 停止時: 書き込み位置・再生位置・位相をリセット
          this.modPhaseAcc = 0;
          this.modWritePos = 0;
          this.modTablePos = 0;
        }
      } else if (addr === 0x4088) {
        // モジュレータ停止中にテーブルを書き込む (1エントリ = 3bit)
        if (!this.modEnabled) {
          this.modTable[this.modWritePos] = value & 0x07;
          this.modWritePos = (this.modWritePos + 1) & 0x1F;
        }
      } else if (addr === 0x4089) {
        this.waveWriteEnable = (value & 0x80) !== 0;
        this.masterVolume = value & 0x03;
      } else if (addr === 0x408A) {
        this.envRate = value;
        this.envRateClock = 0;
      }
    }

    // バス読み出し ($4090 = ボリュームエンベロープ出力, $4092 = モジュレータエンベロープ出力)
    readRegister(addr) {
      if (addr === 0x4090) return this.volGain & 0x3F;
      if (addr === 0x4092) return this.modGain & 0x3F;
      return 0;
    }

    // エンベロープを1ティック進める (エンベロープマスタ速度に応じて呼ばれる)
    _clockEnvelope() {
      // ボリュームエンベロープ
      if (this.volEnvEnabled && !this.envHalt) {
        this.volEnvTimer--;
        if (this.volEnvTimer <= 0) {
          this.volEnvTimer = this.volEnvSpeed + 1;
          if (this.volEnvIncrease) {
            if (this.volGain < 32) this.volGain++;
          } else {
            if (this.volGain > 0) this.volGain--;
          }
        }
      }
      // モジュレータエンベロープ
      if (this.modEnvEnabled && !this.envHalt) {
        this.modEnvTimer--;
        if (this.modEnvTimer <= 0) {
          this.modEnvTimer = this.modEnvSpeed + 1;
          if (this.modEnvIncrease) {
            if (this.modGain < 32) this.modGain++;
          } else {
            if (this.modGain > 0) this.modGain--;
          }
        }
      }
    }

    clock() {
      // エンベロープクロック: NESdev "c = 8 * (e+1) * (m+1)" のm(マスタ速度)部分。
      // period = 8 * (envRate + 1) CPU サイクルに1回(envRate=0→8, envRate=$E8=232→1864 cycles)。
      // 旧実装は envRate×8 (envRate=0のみ特別扱い)で、envRate>0全域で周期が短すぎた
      // (envRate=1で本来16のところ8になる等、小さい値ほど相対誤差が大きいバグ)
      this.envRateClock++;
      const envPeriod = (this.envRate + 1) * 8;
      if (this.envRateClock >= envPeriod) {
        this.envRateClock = 0;
        this._clockEnvelope();
      }

      // モジュレータ: APUクロック(CPU/2)相当、オーバーフロー閾値 = 2 × 65536 = 131072
      // レジスタログ実測: modFreq=16 で 6.83 Hz ビブラート → 16×1789773/(32×131072)=6.83Hz ✓
      if (this.modEnabled && this.modFreq > 0) {
        this.modPhaseAcc += this.modFreq;
        while (this.modPhaseAcc >= 131072) {
          this.modPhaseAcc -= 131072;
          const raw = this.modTable[this.modTablePos];
          this.modTablePos = (this.modTablePos + 1) & 0x1F;
          if (raw === 4) {
            // リセット: カウンタを0に
            this.modCounter = 0;
          } else {
            this.modCounter += MOD_TABLE_DELTA[raw];
            // クランプ (-64..63)
            if (this.modCounter > 63) this.modCounter = 63;
            if (this.modCounter < -64) this.modCounter = -64;
          }
        }
      }

      // メインチャンネル
      if (this.disabled || this.freq === 0) return;

      // ピッチ変調: NESdev FDS audio 準拠の実機アルゴリズム
      //   1. temp = modCounter × modGain          （gain=$4084。gain=0なら変調ゼロ）
      //   2. 4bit右シフト(符号保持)、下位4bitに端数があり結果が非負なら+1(切り上げ)
      //   3. effectiveFreq = freq + freq × delta / 64
      // ★注意: 以前は「+0x400してから8bitマスク、-64」という手順で(2)(3)を行って
      // いたが、これは|temp|(=|modCounter×modGain|)が0x400(1024)未満の範囲でしか
      // 正しく機能しない近似で、modGainが大きくmodCounterが強く負に振れる(絶対値の
      // 積が1024を超える)と8bitマスクで符号が反転し、逆方向の桁違いなピッチになる
      // 深刻なバグだった(実測: modGain=32,modCounter=-64で本来delta=-128のところ
      // +128を返す)。Almana no Kiseki(FDS)2曲目でモジュレーション有効時に音痴に
      // なる不具合の原因。旧実装の校正根拠だったmodGain=16のケースはtemp>>4の結果が
      // ±64に収まるため両実装で一致し、回帰は無い。
      let effectiveFreq = this.freq;
      if (this.modEnabled) {
        const temp = this.modCounter * this.modGain;
        const rem = temp & 0x0F;
        let delta = temp >> 4; // 算術シフト(符号保持)。|temp|<=64*63なので32bit範囲内で安全
        if (rem !== 0 && delta >= 0) delta += 1;
        if (delta !== 0) {
          const bias = Math.round((delta * this.freq) / 64);
          effectiveFreq = Math.max(0, this.freq + bias);
        }
      }
      // 鍵盤表示等の外部参照用(実際に揺れているピッチをHz換算する際、$4082/4083の
      // 生の周期値ではなくこちらを使う。単位はthis.freqと同じ内部単位)
      this.effectiveFreq = effectiveFreq;

      this.phaseAcc += effectiveFreq;
      const cycleLen = 64 * 65536;
      if (this.phaseAcc >= cycleLen) this.phaseAcc -= cycleLen;
    }

    mixSample() {
      if (this.disabled || this.mute.wave) return 0;
      const index = Math.floor(this.phaseAcc / 65536) % 64;
      const sample = this.wave[index] & 0x3F; // 0-63
      const centered = sample - 32; // -32..31
      // 実機の有効ゲインは32で頭打ち(33-63を書いても32相当。以前はクランプ漏れで最大約2倍
      // 大きく鳴っていた、2026-08-24)
      const volScale = Math.min(32, this.volGain) / 32;
      const masterScale = MASTER_VOLUME_SCALE[this.masterVolume & 0x03];
      // FDS 混合係数: NES 実機の抵抗網 (FDS=47Ω直列, 2A03=100Ω直列, 負荷=39Ω) から
      // FDS 出力は 2A03 の約 39% 程度に相当。係数 0.20 は実機バランスに合わせた値。
      return (centered / 32) * volScale * masterScale * 0.20 * this.vol.wave;
    }
  }

  Emu.FDSAudio = FDSAudio;
})(globalThis);

/*
 * MMC5 拡張音源エミュレータ
 * MML.Emu.MMC5Audio
 *
 * パルス x2 ($5000-$5003 / $5004-$5007, 有効化は $5015)。
 * レジスタ形式は2A03のパルスチャンネルと同様だが、スイープユニットを持たない。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const DUTY_TABLE = [
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [1, 0, 0, 1, 1, 1, 1, 1]
  ];
  const LENGTH_TABLE = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
  ];

  class Mmc5Pulse {
    constructor() {
      this.enabled = false;
      this.duty = 0;
      this.lengthCounterHalt = false; // = エンベロープループフラグ
      this.constantVolume = true;
      this.volume = 0;                // 固定音量 or エンベロープ周期
      this.timerPeriod = 0;
      this.timer = 0;
      this.dutyStep = 0;
      this.lengthCounter = 0;
      // エンベロープ(2A03パルスと同形式)
      this.envStart = false;
      this.envDivider = 0;
      this.envDecay = 0;
    }
    writeReg(index, value) {
      switch (index) {
        case 0: // $5000/$5004
          this.duty = (value >> 6) & 0x03;
          this.lengthCounterHalt = (value & 0x20) !== 0;
          this.constantVolume = (value & 0x10) !== 0;
          this.volume = value & 0x0F;
          break;
        case 2: // $5002/$5006
          this.timerPeriod = (this.timerPeriod & 0x700) | value;
          break;
        case 3: // $5003/$5007
          this.timerPeriod = (this.timerPeriod & 0xFF) | ((value & 0x07) << 8);
          if (this.enabled) this.lengthCounter = LENGTH_TABLE[(value >> 3) & 0x1F];
          this.dutyStep = 0;
          this.envStart = true; // 書き込みでエンベロープ再スタート
          break;
      }
    }
    setEnabled(on) {
      this.enabled = on;
      if (!on) this.lengthCounter = 0;
    }
    clock() {
      if (this.timer === 0) {
        this.timer = this.timerPeriod;
        this.dutyStep = (this.dutyStep + 1) & 7;
      } else {
        this.timer--;
      }
    }
    // エンベロープ更新(240Hzでクロック)。2A03パルスと同一ロジック。
    clockEnvelope() {
      if (this.envStart) {
        this.envStart = false;
        this.envDecay = 15;
        this.envDivider = this.volume;
      } else if (this.envDivider === 0) {
        this.envDivider = this.volume;
        if (this.envDecay > 0) this.envDecay--;
        else if (this.lengthCounterHalt) this.envDecay = 15; // ループ
      } else {
        this.envDivider--;
      }
    }
    clockHalfFrame() {
      if (!this.lengthCounterHalt && this.lengthCounter > 0) this.lengthCounter--;
    }
    output() {
      // MMC5はスイープを持たないため 2A03 の「period<8で消音」は無い(超音波域も出力)。
      if (!this.enabled || this.lengthCounter === 0) return 0;
      if (DUTY_TABLE[this.duty][this.dutyStep] === 0) return 0;
      return this.constantVolume ? this.volume : this.envDecay;
    }
  }

  class MMC5Audio {
    constructor() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;   // $5011 8bit 生PCM DAC 出力
      this.pcmReadMode = false; // $5010 bit0
      this.mute = { pulse1: false, pulse2: false, pcm: false };
      this.vol = { pulse1: 1, pulse2: 1, pcm: 1 };
    }

    reset() {
      this.pulse1 = new Mmc5Pulse();
      this.pulse2 = new Mmc5Pulse();
      this.frameCounter = 0;
      this.cycleParity = 0;
      this.pcmLevel = 0;
      this.pcmReadMode = false;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr >= 0x5000 && addr <= 0x5003) {
        this.pulse1.writeReg(addr - 0x5000, value);
      } else if (addr >= 0x5004 && addr <= 0x5007) {
        this.pulse2.writeReg(addr - 0x5004, value);
      } else if (addr === 0x5010) {
        this.pcmReadMode = (value & 0x01) !== 0; // bit0: 0=writeモード, 1=readモード
      } else if (addr === 0x5011) {
        // 8bit 生PCM。writeモードのみ出力を更新($4011相当だが8bit)。
        if (!this.pcmReadMode) this.pcmLevel = value;
      } else if (addr === 0x5015) {
        this.pulse1.setEnabled((value & 0x01) !== 0);
        this.pulse2.setEnabled((value & 0x02) !== 0);
      }
    }

    clock() {
      // パルスタイマは 2A03 と同じくAPUサイクル(2 CPUサイクル)ごとに進める。
      // f = CPU/(16*(period+1))。毎CPUサイクルで進めると1オクターブ高くなる。
      this.cycleParity ^= 1;
      if (this.cycleParity === 0) {
        this.pulse1.clock();
        this.pulse2.clock();
      }
      // MMC5はエンベロープ・長さカウンタとも 240Hz 固定(APU長さカウンタの2倍速)。
      // 7457 CPUサイクル(≒240Hz)ごとに両方クロックする。
      this.frameCounter++;
      if (this.frameCounter >= 7457) {
        this.frameCounter = 0;
        this.pulse1.clockEnvelope();
        this.pulse2.clockEnvelope();
        this.pulse1.clockHalfFrame();
        this.pulse2.clockHalfFrame();
      }
    }

    mixSample() {
      const p1 = this.mute.pulse1 ? 0 : (this.pulse1.output() / 15) * this.vol.pulse1;
      const p2 = this.mute.pulse2 ? 0 : (this.pulse2.output() / 15) * this.vol.pulse2;
      const pcm = this.mute.pcm ? 0 : (this.pcmLevel / 255) * this.vol.pcm;
      return (p1 + p2) * 0.25 + pcm * 0.30;
    }
  }

  // 鍵盤表示用: ライブチップから pulse1/pulse2/pcm のスナップショットを作る。
  // 音量はエンベロープ実出力(constantVolume=false時はenvDecay)を反映。
  Emu.snapshotMMC5 = function (chip) {
    const CPU = 1789773;
    const pulse = (p) => {
      const eff = p.constantVolume ? p.volume : p.envDecay; // 実効音量
      const freq = (p.timerPeriod >= 8) ? CPU / (16 * (p.timerPeriod + 1)) : 0;
      return {
        freq,
        vol: eff / 15,
        rawVol: eff,
        duty: p.duty,
        active: p.enabled && p.lengthCounter > 0 && eff > 0 && freq > 0
      };
    };
    return {
      pulse1: pulse(chip.pulse1),
      pulse2: pulse(chip.pulse2),
      pcm: { level: chip.pcmLevel, vol: chip.pcmLevel / 255, active: chip.pcmLevel > 0 }
    };
  };

  Emu.MMC5Audio = MMC5Audio;
})(globalThis);

/*
 * N163 (Namco 163) 拡張音源エミュレータ
 * MML.Emu.N163Audio
 *
 * 128バイト内部RAMにチャンネルレジスタ($40-$7F)と波形データを保持する
 * ウェーブテーブル音源(最大8チャンネル)。
 *
 *   $F800 : 内部RAMアドレス設定 (bit7=1で$4800書き込み毎にオートインクリメント)
 *   $4800 : 現在のアドレスへデータ書き込み
 *
 * チャンネル ch(0-7) のレジスタは RAM (0x40 + ch*8) の8バイト (インターリーブ配置):
 *   +0 周波数 Low   +2 周波数 Mid   +4 周波数 High(bit0-1) | 波形長(bit2-7)
 *   +1 位相 Low     +3 位相 Mid     +5 位相 High   (24bit位相アキュムレータ, RAMに格納)
 *   +6 波形アドレス(4bitサンプル単位)
 *   +7 音量(bit0-3) | 有効ch数(bit4-6, $7Fのみ)
 * 周波数=18bit, 波形長 length = 256 - (+4 & 0xFC) サンプル(4-256)。
 * 波形は4bitサンプルを1バイトに2つ(リトルエンディアン)格納。
 * 有効チャンネルは上位 (($7F>>4)&7)+1 個で、15 CPUサイクルごとに1chずつ巡回更新される。
 * 出力周波数 f = CPU * freq / (15 * 65536 * length * numChannels)。
 *
 * 注: 実機は freq/phase をインターリーブ配置。ドライバは freq を +0/+2/+4 に書き、
 *     間の位相バイト +1/+3/+5 を LDA $4800 で「読み飛ばし」て保存する(読み出しも
 *     オートインクリメントするのを利用)。Rolling Thunder のCPUトレースで確定。
 *
 * 注2: 波形長は NESdev Wiki 準拠で bit2-7 の6bit(4-256サンプル, length=256-(+4&0xFC))。
 *     これが標準の N163 挙動(NSFPlay/Mesen/VirtuaNSF既定と同じ)。ただし「古いドライバ」で
 *     作られた一部NSF(例: Famicompo mini vol.3 entry023)は波形長を最大32サンプル前提で
 *     使っており、256版だと音程・波形テーブルが崩れる。VirtuaNSFはこれ用に「N163を32サンプル
 *     に制限するモード」を別途用意している(readme 1.0.7.1)。
 *     → legacyWaveLen=true で対応(2026-09-07)。旧ドライバは +4 に (n<<2)|$80 を書く
 *     (VirtuaNES 0.97 の APU_N106: tonelen = 0x20-(data&0x1C))。VirtuaNESの周波数式は
 *     実機式と同じ f = CPU*freq/(15*65536*length*numCh) なので、違いは波形長の解釈だけ。
 *     そこで「+4 への書き込み値を現行エンコードへ書き換えて RAM に置く」方式にした:
 *       (v & 0x1F) | 0xE0   … 256-(0xE0|(n<<2)) = 32-4n = 0x20-(v&0x1C) と同じ長さ
 *     RAM 自体が現行仕様の値になるため、音声合成・鍵盤/ロール(snapshotN163)・
 *     nsf2mml の波形抽出・n163Snapshots 経由の再生(NsfReplayStreamPlayer)が全て
 *     無変更で正しくなる。判定は MML.NSF.detectLegacyN163Driver(nsfBus.js から設定)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const NUM_CHANNELS = 8;
  const UPDATE_CYCLES = 15; // 1チャンネル更新に要するCPUサイクル

  class N163Audio {
    constructor() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0; // 15CPUサイクルごとに1ch更新
      this.rrIndex = 0;       // 有効ch内の巡回位置
      this.mute = new Array(NUM_CHANNELS).fill(false);
      this.vol = new Array(NUM_CHANNELS).fill(1);
      // 旧ppmckドライバ(波形長32サンプル形式)互換。true のとき +4 レジスタへの書き込みを
      // 現行エンコードへ変換して格納する(ファイル冒頭コメント 注2 参照)。
      this.legacyWaveLen = false;
    }

    reset() {
      this.ram = new Uint8Array(128);
      this.addr = 0;
      this.autoInc = false;
      this.updateCounter = 0;
      this.rrIndex = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xF800) {
        this.addr = value & 0x7F;
        this.autoInc = (value & 0x80) !== 0;
      } else if (addr === 0x4800) {
        // 旧ドライバ互換: チャンネルレジスタ +4(波形長|周波数上位)への書き込みは
        // bit2-4 の3bit波形長(0x20-(v&0x1C))を現行の6bit形式(0xE0|(v&0x1C))へ変換する。
        // 周波数上位2bit(bit0-1)はそのまま。
        if (this.legacyWaveLen && this.addr >= 0x40 && (this.addr & 7) === 4) {
          value = (value & 0x1F) | 0xE0;
        }
        this.ram[this.addr] = value;
        if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      }
    }

    // $4800 読み出し: 現在のアドレスの内部RAMを返し、オートインクリメント時はアドレスも進める。
    // (書き込みとアドレス/オートインクリメントを共有。実機同様、読み出しでもインクリメント。
    //  ※ ストア命令の空読みはCPU側で抑止済み。ここに来るのは真の LDA $4800 のみ)
    readData() {
      const v = this.ram[this.addr];
      if (this.autoInc) this.addr = (this.addr + 1) & 0x7F;
      return v;
    }

    numChannels() {
      return ((this.ram[0x7F] >> 4) & 0x07) + 1;
    }

    // ch(0-7, 7=$78が最上位)を1回更新: 位相を進めてRAM(+1/+3/+5)へ書き戻す
    _updateChannel(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const freq = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC); // 4-256 サンプル
      let phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      phase = (phase + freq) % (length * 0x10000);
      ram[base + 1] = phase & 0xFF;
      ram[base + 3] = (phase >> 8) & 0xFF;
      ram[base + 5] = (phase >> 16) & 0xFF;
    }

    // ch の現在の出力サンプル(0-15)。位相上位8bitで波形を索引。
    _sample(ch) {
      const base = 0x40 + ch * 8;
      const ram = this.ram;
      const length = 256 - (ram[base + 4] & 0xFC);
      const phase = ram[base + 1] | (ram[base + 3] << 8) | (ram[base + 5] << 16);
      const sampleIndex = (phase >> 16) % length;
      const nibbleAddr = (ram[base + 6] + sampleIndex) & 0xFF; // 波形アドレスは4bitサンプル単位
      const byte = ram[(nibbleAddr >> 1) & 0x7F];
      return (nibbleAddr & 1) ? ((byte >> 4) & 0x0F) : (byte & 0x0F);
    }

    clock() {
      // 実機は15 CPUサイクルで1チャンネルを更新・出力し、有効ch(上位num個)を巡回する。
      if (++this.updateCounter < UPDATE_CYCLES) return;
      this.updateCounter = 0;
      const num = this.numChannels();
      this.rrIndex = (this.rrIndex + 1) % num;
      this._updateChannel((NUM_CHANNELS - num) + this.rrIndex);
    }

    mixSample() {
      const num = this.numChannels();
      let sum = 0;
      for (let ch = NUM_CHANNELS - num; ch < NUM_CHANNELS; ch++) {
        if (this.mute[ch]) continue;
        const volume = this.ram[0x40 + ch * 8 + 7] & 0x0F;
        sum += (this._sample(ch) - 8) * volume * this.vol[ch]; // -120..105
      }
      // 時間多重出力の可聴成分は有効ch平均。120で正規化してゲイン。
      // ゲインは他チップとのバランスで調整(0.8→0.3で全体を半分以下に下げた)。
      return (sum / num / 120) * 0.5;
    }
  }

  // 鍵盤表示用: 128バイトRAMから各チャンネルの freq/vol/波形 スナップショットを作る。
  // 表示スロット i(0..7) → ハードウェアch (7-i)。有効なのは上位 numCh 個($78が常にN1)。
  // 事前キャプチャ(writeLogから復元したRAM)・リアルタイム(ライブチップのRAM)双方から使う。
  Emu.snapshotN163 = function (ram) {
    const CPU = 1789773;
    const sampleAt = (a) => (ram[(a >> 1) & 0x7F] >> ((a & 1) * 4)) & 0x0F;
    const numCh = ((ram[0x7F] >> 4) & 7) + 1;
    const channels = [];
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = 7 - i;
      const base = 0x40 + ch * 8;
      const f18 = ram[base] | (ram[base + 2] << 8) | ((ram[base + 4] & 0x03) << 16);
      const length = 256 - (ram[base + 4] & 0xFC);
      const rawVol = ram[base + 7] & 0x0F;
      const vol = rawVol / 15;
      const freq = f18 > 0 ? f18 * CPU / (15 * 65536 * length * numCh) : 0;
      const waveData = new Array(length);
      for (let k = 0; k < length; k++) waveData[k] = (sampleAt((ram[base + 6] + k) & 0xFF) - 8) / 8;
      channels.push({ freq, vol, rawVol, active: (i < numCh) && vol > 0 && freq > 0, waveData });
    }
    return { channels, numCh };
  };

  Emu.N163Audio = N163Audio;
})(globalThis);

/*
 * FME-7 (Sunsoft 5B) 拡張音源エミュレータ
 * MML.Emu.FME7Audio
 *
 * AY-3-8910/YM2149 系。矩形波(50%)x3 + ノイズ + ハードウェアエンベロープ。
 * アドレスラッチ $C000 でレジスタ番号(0-15)を選択し、$E000 で書き込む。
 *   $00/$01,$02/$03,$04/$05 : 各chの12bitトーン周期(下位8bit/上位4bit)
 *   $06                     : ノイズ周期(5bit)
 *   $07                     : ミキサー。bit0-2=トーン有効(0で有効), bit3-5=ノイズ有効(0で有効)
 *   $08/$09/$0A             : 各chの音量。bit0-3=固定音量, bit4=1でエンベロープ制御
 *   $0B/$0C                 : 16bitエンベロープ周期
 *   $0D                     : エンベロープ形状 (bit0=Hold,bit1=Alternate,bit2=Attack,bit3=Continue)
 *
 * トーン: f = CPU/(32*period) (period=0は1扱い、+1しない)。
 * ノイズ: 17bit LFSR(タップ bit0^bit3)、f = CPU/(32*period)。
 * エンベロープ: 5bit(0-31)、1ステップ = CPU/(16*period)。
 * 音量DAC: 5bit対数(1.5dB/step、level0-1=無音)。固定音量Vは 5bit=2V+1。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  // 5B/AY 32段対数DAC。1.5dB/step、最大(31)=1.0、level0-1は無音。
  const AY_DAC = new Float32Array(32);
  for (let i = 0; i < 32; i++) AY_DAC[i] = i < 2 ? 0 : Math.pow(10, (i - 31) * 1.5 / 20);

  const NUM_CH = 3;

  // トーン(矩形波)。period チャンネルクロックごとにレベル反転。
  class Fme7Tone {
    constructor() { this.period = 1; this.timer = 0; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.level = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1; // period クロックごとに反転
        this.level ^= 1;
      } else {
        this.timer--;
      }
    }
  }

  // ノイズ。17bit LFSR。period チャンネルクロックごとに flip をトグルし、
  // flip立ち上がりでシフト(=2*period チャンネルクロック=32*period CPUクロックごと)。
  class Fme7Noise {
    constructor() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    reset() { this.period = 1; this.timer = 0; this.lfsr = 1; this.flip = 0; this.out = 0; }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this.flip ^= 1;
        if (this.flip) {
          const fb = (this.lfsr ^ (this.lfsr >> 3)) & 1; // タップ bit0 ^ bit3
          this.lfsr = ((this.lfsr >> 1) | (fb << 16)) & 0x1FFFF;
        }
        this.out = this.lfsr & 1;
      } else {
        this.timer--;
      }
    }
  }

  // ハードウェアエンベロープ。5bit(0-31)出力。
  class Fme7Envelope {
    constructor() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.cont = false; this.alt = false; this.hold = false; this.holding = false; this.level = 0; }
    reset() { this.period = 1; this.timer = 0; this.step = 0; this.att = false; this.holding = false; this.level = 0; }
    writeShape(s) {
      this.hold = (s & 1) !== 0;
      this.alt = (s & 2) !== 0;
      this.att = (s & 4) !== 0;
      this.cont = (s & 8) !== 0;
      this.step = 0;
      this.holding = false;
      this.timer = 0;
      this.level = this.att ? 0 : 31; // Attack=上昇なら0から、下降なら31から
    }
    clock() {
      if (this.timer === 0) {
        this.timer = Math.max(1, this.period) - 1;
        this._step();
      } else {
        this.timer--;
      }
    }
    _step() {
      if (this.holding) return;
      this.step++;
      if (this.step > 31) {
        this.step = 0;
        if (!this.cont) { this.holding = true; this.level = 0; return; }          // 一発(減衰/上昇後に無音)
        if (this.hold) { this.holding = true; this.level = this.alt ? (this.att ? 0 : 31) : (this.att ? 31 : 0); return; }
        if (this.alt) this.att = !this.att; // 交互(三角)なら方向反転
      }
      this.level = this.att ? this.step : (31 - this.step);
    }
  }

  class FME7Audio {
    constructor() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38; // 既定: トーンON・ノイズOFF
      this.tones = [new Fme7Tone(), new Fme7Tone(), new Fme7Tone()];
      this.noise = new Fme7Noise();
      this.env = new Fme7Envelope();
      this._div = 0;
      this.mute = [false, false, false];
      this.vol = [1, 1, 1];
    }

    reset() {
      this.addr = 0;
      this.regs = new Uint8Array(16);
      this.regs[7] = 0x38;
      for (const t of this.tones) t.reset();
      this.noise.reset();
      this.env.reset();
      this._div = 0;
    }

    writeRegister(addr, value) {
      value &= 0xFF;
      if (addr === 0xC000) {
        this.addr = value & 0x0F;
      } else if (addr === 0xE000) {
        this.writeInternal(this.addr, value);
      }
    }

    writeInternal(reg, value) {
      this.regs[reg] = value;
      switch (reg) {
        case 0: case 1: this.tones[0].period = this.regs[0] | ((this.regs[1] & 0x0F) << 8); break;
        case 2: case 3: this.tones[1].period = this.regs[2] | ((this.regs[3] & 0x0F) << 8); break;
        case 4: case 5: this.tones[2].period = this.regs[4] | ((this.regs[5] & 0x0F) << 8); break;
        case 6: this.noise.period = value & 0x1F; break;
        case 11: case 12: this.env.period = this.regs[11] | (this.regs[12] << 8); break;
        case 13: this.env.writeShape(value); break;
        // 7=ミキサー, 8-10=音量 は出力時に参照
      }
    }

    clock() {
      // 内部クロックはCPUクロックの1/16
      if (++this._div >= 16) {
        this._div = 0;
        this.tones[0].clock();
        this.tones[1].clock();
        this.tones[2].clock();
        this.noise.clock();
        this.env.clock();
      }
    }

    // ch(0-2)の5bit音量レベル(0-31)。bit4でエンベロープ、固定音量Vは 2V+1。
    channelLevel(ch) {
      const volReg = this.regs[8 + ch];
      if (volReg & 0x10) return this.env.level;
      return ((volReg & 0x0F) * 2) + 1; // V=0→1(DAC上無音), V=15→31
    }

    mixSample() {
      const mix = this.regs[7];
      let sum = 0;
      for (let i = 0; i < NUM_CH; i++) {
        if (this.mute[i]) continue;
        const toneOn = ((mix >> i) & 1) === 0;
        const noiseOn = ((mix >> (i + 3)) & 1) === 0;
        const t = toneOn ? this.tones[i].level : 1;
        const n = noiseOn ? this.noise.out : 1;
        if (t && n) sum += AY_DAC[this.channelLevel(i)] * this.vol[i];
      }
      // 3ch分の対数振幅和。他チップとのバランスでゲイン調整。
      return sum * 0.35;
    }
  }

  // 鍵盤表示用: ライブチップから3ch分の {freq,vol,rawVol,active,noise,envMode} を作る。
  // freq=CPU/(32*period)(修正後), vol/rawVolはエンベロープ含む実効5bitレベル由来。
  Emu.snapshotFME7 = function (chip) {
    const CPU = 1789773;
    const mix = chip.regs[7];
    const out = [];
    for (let i = 0; i < NUM_CH; i++) {
      const period = chip.tones[i].period;
      const toneOn = ((mix >> i) & 1) === 0;
      const noiseOn = ((mix >> (i + 3)) & 1) === 0;
      const level = chip.channelLevel(i);          // 0-31
      const envMode = (chip.regs[8 + i] & 0x10) !== 0;
      const freq = (toneOn && period > 0) ? CPU / (32 * period) : 0;
      out.push({
        freq,
        vol: level / 31,
        rawVol: Math.round(level / 2),             // 0-15 表示用
        active: (toneOn ? (level > 0 && freq > 0) : (noiseOn && level > 0)),
        noise: noiseOn,
        envMode
      });
    }
    return out;
  };

  Emu.FME7Audio = FME7Audio;
})(globalThis);

/*
 * NSF実行用メモリバス
 * MML.Emu.NsfBus
 *
 * 64KBのフラットメモリ空間を提供し、$4000-$4017 へのアクセスをAPUにルーティングする。
 * $5FF8-$5FFF へのバンクスイッチ書き込みにも対応（NSFバンクスイッチング方式）。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const BANK_SIZE = 0x1000; // 4KB

  class NsfBus {
    /**
     * @param {object} opt
     * @param {Uint8Array} opt.program - ロードするプログラムイメージ（ヘッダを除いたバイナリ）
     * @param {number} opt.loadAddr - プログラムのロード先アドレス
     * @param {Uint8Array} [opt.bankswitch] - ヘッダのバンクスイッチ初期値8バイト（全て0ならバンクスイッチ無効）
     */
    constructor(opt) {
      this.mem = new Uint8Array(0x10000);
      this.apu = null; // setApu() で後から設定
      this.onWrite = null; // (addr, value) => void のフック（レジスタ書き込みログ用）

      // 拡張音源 (NSF.CHIP_FLAGS の組み合わせ)
      this.expansion = {};
      const extraChips = opt.extraChips || 0;
      const FLAGS = MML.NSF.CHIP_FLAGS;
      if (extraChips & FLAGS.VRC6) this.expansion.vrc6 = new Emu.VRC6Audio();
      if (extraChips & FLAGS.VRC7) this.expansion.vrc7 = new Emu.VRC7Audio();
      if (extraChips & FLAGS.FDS) this.expansion.fds = new Emu.FDSAudio();
      if (extraChips & FLAGS.MMC5) this.expansion.mmc5 = new Emu.MMC5Audio();
      if (extraChips & FLAGS.N163) this.expansion.n163 = new Emu.N163Audio();
      if (extraChips & FLAGS.FME7) this.expansion.fme7 = new Emu.FME7Audio();
      // 旧ppmckドライバ(Famicompo mini 時代、N106波形長を32サンプル形式で書く)の判定。
      // opt.n163Legacy で明示指定がなければプログラム本体の機械語列から自動判定する
      // (NsfPlayer/NsfReplayStreamPlayer/キャプチャWorker/ヘッドレスの全経路がここを通る)。
      // 詳細は nsfHeader.js detectLegacyN163Driver と n163.js 冒頭コメント 注2。
      if (this.expansion.n163) {
        this.n163Legacy = opt.n163Legacy !== undefined
          ? !!opt.n163Legacy
          : !!(MML.NSF.detectLegacyN163Driver && MML.NSF.detectLegacyN163Driver(opt.program));
        this.expansion.n163.legacyWaveLen = this.n163Legacy;
      }

      this.loadAddr = opt.loadAddr;
      this.useBankswitch = (opt.bankswitch || []).some(b => b !== 0);

      if (this.useBankswitch) {
        // バンクスイッチ時: ロードアドレス下位12bit分だけ先頭をゼロパディングした
        // ROMイメージを作り、4KBバンク単位で $8000-$FFFF にマッピングする。
        // (NSF仕様: padding = loadAddr & 0x0FFF。これが無いとINIT/PLAYが別バイトを指す)
        const pad = this.loadAddr & 0x0FFF;
        this.romImage = new Uint8Array(pad + opt.program.length);
        this.romImage.set(opt.program, pad);
        this.bankCount = Math.max(1, Math.ceil(this.romImage.length / BANK_SIZE));
        this.banks = new Array(8).fill(0).map((_, i) => (opt.bankswitch[i] || 0) % this.bankCount);
        for (let slot = 0; slot < 8; slot++) this.mapBank(0x8000 + slot * BANK_SIZE, this.banks[slot]);
        // FDS NSF: バイト0x76/0x77 は $E000/$F000 に加え $6000/$7000 も初期化する
        if (this.expansion.fds) {
          this.mapBank(0x6000, this.banks[6]);
          this.mapBank(0x7000, this.banks[7]);
        }
      } else {
        // 通常: loadAddr から program をそのまま配置
        for (let i = 0; i < opt.program.length; i++) {
          const addr = (this.loadAddr + i) & 0xFFFF;
          this.mem[addr] = opt.program[i];
        }
      }

      // MMC5実機のPRGバンクレジスタ($5100=モード, $5113-$5117=8KBウィンドウ選択)。
      // NSF仕様の$5FF8-$5FFFバンクスイッチとは別に、実機ROMからそのまま抜き出した
      // ドライバはこちらの本物のMMC5レジスタで$8000-$FFFFを切り替えることがある
      // (Just Breed等)。これを無視すると初期バンクのまま固定され、曲の途中で
      // ドライバが本来別バンクにあるはずのデータ(0埋め)を読んで無限ループに陥る。
      if (this.expansion.mmc5) {
        if (!this.romImage) {
          const pad = this.loadAddr & 0x0FFF;
          this.romImage = new Uint8Array(pad + opt.program.length);
          this.romImage.set(opt.program, pad);
        }
        this.mmc5PrgMode = 3; // 実機の電源投入直後の挙動に合わせた既定値(最も細かい8KB×4分割)
        this.mmc5PrgReg = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; // $5113,5114,5115,5116,5117の生値
        // $5205/$5206: 実機の8bit×8bit=16bit符号なし乗算器。書き込みは被乗数/乗数だが
        // 読み出しは積の下位/上位バイトを返す(実機の二重機能レジスタ)。これが無いと
        // 読み出し側は直前に書き込んだ生値をそのまま読み返してしまい、乗算結果を使う
        // ポインタ計算(音楽データテーブルの索引など)が壊れる(Just Breed等)。
        this.mmc5MultOperand = [0, 0];
        this.mmc5MultProduct = 0;
      }
    }

    setApu(apu) { this.apu = apu; }

    // MMC5実機のPRGバンクレジスタ書き込みを $8000-$FFFF に反映する。
    // regIndex: 1=$5114 2=$5115 3=$5116 4=$5117 (書き込まれたレジスタのみ)、
    // regIndex省略時は$5100(モード)変更に伴う全ウィンドウ再計算。
    // NSFはドライバ本体の起動処理を経ずINIT/PLAYだけを叩くため、触れられていない
    // レジスタは実機のリセット直後値ではなくヘッダのバンクスイッチで既に正しく
    // 割り当て済みの内容を持っている。よって「書き込まれたレジスタが担当する
    // ウィンドウだけ」を差し替え、他のウィンドウは既存の内容(ヘッダ由来 or
    // 以前のMMC5書き込みの結果)をそのまま保持する。
    mmc5RemapPrg(regIndex) {
      const rom = this.romImage;
      const bankCount8k = Math.max(1, Math.floor(rom.length / 0x2000));
      const romBankNum = (regVal) => (regVal & 0x7F) % bankCount8k;
      const copyWindow = (dst, bank8k) => {
        const src = (((bank8k % bankCount8k) + bankCount8k) % bankCount8k) * 0x2000;
        for (let i = 0; i < 0x2000; i++) {
          this.mem[dst + i] = rom[src + i] !== undefined ? rom[src + i] : 0;
        }
      };
      const r = this.mmc5PrgReg; // [5113, 5114, 5115, 5116, 5117]
      const mode = this.mmc5PrgMode;

      const remap5114 = () => { if (mode === 3) copyWindow(0x8000, romBankNum(r[1])); };
      const remap5115 = () => {
        if (mode === 3) copyWindow(0xA000, romBankNum(r[2]));
        else if (mode === 1 || mode === 2) {
          const lo16 = ((r[2] & 0x7F) >> 1) * 2;
          copyWindow(0x8000, lo16);
          copyWindow(0xA000, lo16 + 1);
        }
      };
      const remap5116 = () => { if (mode === 2 || mode === 3) copyWindow(0xC000, romBankNum(r[3])); };
      const remap5117 = () => {
        if (mode === 0) {
          const base8k = ((r[4] & 0x7F) >> 2) * 4;
          for (let w = 0; w < 4; w++) copyWindow(0x8000 + w * 0x2000, base8k + w);
        } else if (mode === 1) {
          const hi16 = ((r[4] & 0x7F) >> 1) * 2;
          copyWindow(0xC000, hi16);
          copyWindow(0xE000, hi16 + 1);
        } else {
          copyWindow(0xE000, romBankNum(r[4]));
        }
      };

      if (regIndex === 1) remap5114();
      else if (regIndex === 2) remap5115();
      else if (regIndex === 3) remap5116();
      else if (regIndex === 4) remap5117();
      else { remap5114(); remap5115(); remap5116(); remap5117(); } // $5100モード変更時: 全ウィンドウ再計算
    }

    // ROMイメージの bankIndex 番目の4KBバンクを dstBase に配置する
    mapBank(dstBase, bankIndex) {
      const src = (bankIndex % this.bankCount) * BANK_SIZE;
      for (let i = 0; i < BANK_SIZE; i++) {
        this.mem[dstBase + i] = this.romImage[src + i] !== undefined ? this.romImage[src + i] : 0;
      }
    }

    read(addr) {
      addr &= 0xFFFF;
      if (addr === 0x4015 && this.apu) return this.apu.readStatus();
      // FDS レジスタ読み出し ($4090=ボリューム出力, $4092=モジュレータ出力)
      if (this.expansion.fds && (addr === 0x4090 || addr === 0x4092)) {
        return this.expansion.fds.readRegister(addr);
      }
      // N163 内部RAM読み出し ($4800)。ドライバが register の read-modify-write に使う。
      if (this.expansion.n163 && addr === 0x4800) {
        return this.expansion.n163.readData();
      }
      // MMC5乗算器: $5205=積の下位バイト, $5206=積の上位バイト
      if (this.expansion.mmc5 && addr === 0x5205) return this.mmc5MultProduct & 0xFF;
      if (this.expansion.mmc5 && addr === 0x5206) return (this.mmc5MultProduct >> 8) & 0xFF;
      return this.mem[addr];
    }

    write(addr, value) {
      addr &= 0xFFFF;
      value &= 0xFF;

      if (addr >= 0x4000 && addr <= 0x4017) {
        if (this.apu) this.apu.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      const exp = this.expansion;
      if (exp.vrc6 && ((addr >= 0x9000 && addr <= 0x9002) || (addr >= 0xA000 && addr <= 0xA002) || (addr >= 0xB000 && addr <= 0xB002))) {
        exp.vrc6.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.vrc7 && (addr === 0x9010 || addr === 0x9030)) {
        exp.vrc7.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.fds && (addr === 0x4023 || (addr >= 0x4040 && addr <= 0x408A))) {
        exp.fds.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr >= 0x5000 && addr <= 0x5015) {
        exp.mmc5.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr === 0x5100) {
        this.mmc5PrgMode = value & 0x03;
        this.mmc5RemapPrg();
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && addr >= 0x5113 && addr <= 0x5117) {
        const regIndex = addr - 0x5113;
        this.mmc5PrgReg[regIndex] = value;
        if (regIndex > 0) this.mmc5RemapPrg(regIndex); // $5113($6000-7FFF RAM)は非対応・素通し
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.mmc5 && (addr === 0x5205 || addr === 0x5206)) {
        this.mmc5MultOperand[addr - 0x5205] = value;
        this.mmc5MultProduct = this.mmc5MultOperand[0] * this.mmc5MultOperand[1];
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.n163 && (addr === 0xF800 || addr === 0x4800)) {
        exp.n163.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }
      if (exp.fme7 && (addr === 0xC000 || addr === 0xE000)) {
        exp.fme7.writeRegister(addr, value);
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      if (this.useBankswitch && addr >= 0x5FF8 && addr <= 0x5FFF) {
        const slot = addr - 0x5FF8;
        this.banks[slot] = value % this.bankCount;
        this.mapBank(0x8000 + slot * BANK_SIZE, this.banks[slot]);
        // バンクスイッチ書き込みもwriteLogに記録する。$4000-$4017の音源レジスタと
        // 違い元々onWriteを呼んでいなかったため、nsf2mml側でDPCMサンプルの実バイト列を
        // 再現する際に「その時点でどのバンクが$C000-$FFFF等にマップされていたか」を
        // 再現できなかった(常に初期状態のまま=最初のバンク切替以降がズレる)
        if (this.onWrite) this.onWrite(addr, value);
        return;
      }

      // FDS NSF 専用: $5FF6/$5FF7 は $6000/$7000 へのバンクスイッチ
      if (this.useBankswitch && this.expansion.fds && (addr === 0x5FF6 || addr === 0x5FF7)) {
        this.mapBank(0x6000 + (addr - 0x5FF6) * BANK_SIZE, value % this.bankCount);
        return;
      }

      this.mem[addr] = value;
    }
  }

  Emu.NsfBus = NsfBus;
})(globalThis);

/*
 * NSFプレイヤー（CPU + APU + Bus の統合）
 * MML.Emu.NsfPlayer
 *
 * - initSong(index): INITルーチンを呼び出して曲を初期化
 * - renderFrame(sampleRate): PLAYルーチンを1回呼び出し、1/60秒分の音声サンプルを生成
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const CPU_CLOCK_NTSC = 1789773;
  const FRAME_RATE_NTSC = 60.0988;

  class NsfPlayer {
    /**
     * @param {Uint8Array} nsfBytes - 128バイトヘッダを含む完全なNSFバイナリ
     */
    constructor(nsfBytes) {
      this.header = MML.NSF.parseHeader(nsfBytes);
      const program = nsfBytes.slice(128);

      this.bus = new Emu.NsfBus({
        program,
        loadAddr: this.header.loadAddr,
        bankswitch: this.header.bankswitch,
        extraChips: this.header.extraChips
      });
      this.apu = new Emu.APU2A03(this.bus);
      this.bus.setApu(this.apu);
      this.cpu = new Emu.CPU6502(this.bus);

      this.cycleAccum = 0;
      this.cpuDebt = 0; // CPUが先行実行したサイクル数(フレーム跨ぎで持ち越す)

      // 再生速度(1=等速 〜 1/8=低速)。PLAY呼び出し頻度のみを間引き、
      // APU/拡張音源のクロック(=音程)は常に実時間のまま進めるため、
      // 音程を保ったままテンポだけを落とせる。
      this.speedFactor = 1;
      this._playFrameAccum = 0;
    }

    /**
     * 指定した曲番号(0始まり)で初期化する
     * @param {number} songIndex
     * @param {boolean} [pal=false]
     */
    initSong(songIndex, pal = false) {
      this.apu.reset();
      this.cpu.reset();
      // NSF仕様: INIT呼び出し前に全チャンネルを有効化しておく。
      // これにより INIT/PLAY 中の $4003 書き込みで lengthCounter が正しく設定される。
      this.apu.writeRegister(0x4017, 0x40); // フレームカウンタリセット・IRQ禁止
      this.apu.writeRegister(0x4015, 0x0F); // 全チャンネル有効
      this.cpu.A = songIndex & 0xFF;
      this.cpu.X = pal ? 1 : 0;
      this.cpu.Y = 0;
      this.cpu.call(this.header.initAddr);
      this.cpu.callActive = false; // INITは完了。最初のrenderFrameでPLAYを開始する
      this.cycleAccum = 0;
      this.cpuDebt = 0;
      this._playFrameAccum = 0;
    }

    /**
     * 1フレーム(1/60秒)分の音声サンプルを生成する。
     * 各フレームの先頭でPLAYを呼ぶが、PLAYが1フレーム内に終わらない
     * 「ブロッキング型」(例:水戸黄門/Sunsoftは1回のPLAYで約612フレーム=10秒ぶんの
     * $4011直書きPCMスピーチをストリーミングしてからRTSする)にも対応するため、
     * PLAYが実行中の間はrenderFrameを跨いで継続し、完了するまで再呼び出ししない。
     * @param {number} sampleRate
     * @returns {Float32Array} 0.0〜1.16程度の振幅の波形データ
     */
    renderFrame(sampleRate) {
      const cyclesPerSample = CPU_CLOCK_NTSC / sampleRate;
      const samplesThisFrame = Math.round(sampleRate / FRAME_RATE_NTSC);
      const out = new Float32Array(samplesThisFrame);

      // 拡張音源は添字ループで回す(毎CPUサイクル呼ぶ内側ループなので for...of の
      // イテレータ確保を避ける)。拡張なし(2A03のみ)なら nExp=0 でループ自体スキップ。
      const expansion = Object.values(this.bus.expansion);
      const nExp = expansion.length;
      const apu = this.apu, cpu = this.cpu;

      // 前フレームでPLAYが完了していれば新たに呼び出す。まだ実行中(複数フレームに
      // 跨るブロッキングPLAY)ならその実行を継続する。
      // speedFactor<1のときはPLAY呼び出し自体を間引いてテンポだけを落とす。
      // APU/拡張音源のクロックは下のループで常に実時間のまま進むため音程は変わらない。
      if (!cpu.callActive) {
        this._playFrameAccum += this.speedFactor;
        if (this._playFrameAccum >= 1) {
          this._playFrameAccum -= 1;
          cpu.beginCall(this.header.playAddr);
        }
      }

      // CPU実行とAPUクロックをインターリーブし、各出力サンプル時点のレジスタ状態
      // ($4011直書きPCM等)を正しく反映する。cpuDebt(CPUが先行実行したサイクル)は
      // フレーム境界を跨いで持ち越す。
      for (let i = 0; i < samplesThisFrame; i++) {
        this.cycleAccum += cyclesPerSample;
        while (this.cycleAccum >= 1) {
          if (this.cpuDebt <= 0) {
            if (cpu.callActive) this.cpuDebt += cpu.stepCall();
            else this.cpuDebt = 1; // PLAY完了後、次フレームまではCPUアイドルでAPUのみ進む
          }
          this.cpuDebt--;
          apu.clock();
          for (let e = 0; e < nExp; e++) expansion[e].clock();
          this.cycleAccum -= 1;
        }
        let sample = apu.mixSample();
        for (let e = 0; e < nExp; e++) sample += expansion[e].mixSample();
        out[i] = sample;
      }
      return out;
    }
  }

  Emu.NsfPlayer = NsfPlayer;
  Emu.CPU_CLOCK_NTSC = CPU_CLOCK_NTSC;
  Emu.FRAME_RATE_NTSC = FRAME_RATE_NTSC;
})(globalThis);

/*
 * 再生ログ一括キャプチャ（プリレンダー）
 * MML.Emu.captureSong / MML.Emu.dcBlock
 *
 * INIT実行後、指定秒数分のPLAYルーチンを毎フレーム実行し、
 * - 全レジスタ書き込みのタイムラインログ
 * - 全フレーム分の音声波形（DCブロック済み）
 * を一括生成する。生成後はシーク・早送り・巻き戻しが
 * 音声バッファへのアクセスのみで完結する。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  /**
   * KSS形式writeLogの1書込みを1つの整数へ詰める(2026-09-04)。
   *   bit0-15 = addr(メモリアドレス or I/Oポート) / bit16-23 = value / bit24 = io(1ならI/O)
   *
   * {addr,value,io}のJSオブジェクトは実測75〜90B/件で、KSSは1フレーム平均84〜152件書くため
   * 60秒で27〜41MB(実RSS)を占めていた。詰めればフレームごとの Int32Array で4B/件になる
   * (実測 xak.kss 60秒: 27MB → 1.2MB)。型付き配列なので構造化クローン(キャプチャWorkerの
   * 差分送信)もそのまま通る。読む側は kss2mml/expansion/*.js と kss-stream-player.js と
   * roll-builders.js。
   *
   * ★定義場所はここ(capture.js)。KSS(kssPlayer.js)とVGM(vgmPlayer.js: AY/SSG/SCC/OPLL/OPLの
   *   書込みをKSS形式で積む)の両方が使い、両方のWorkerバンドルに入る唯一の共通ファイルのため。
   *   以前は kssPlayer.js にあり、VGMのWorkerバンドル(kssPlayer.jsを含まない)で
   *   「Emu.kssPackWrite is not a function」で落ちて、AY/SSG/OPLを使うVGMのロールが空になる
   *   (途中で落ちると取得済み範囲で打ち切られる)不具合の原因になっていた(2026-09-07)。
   */
  // frac: フレーム内の書込み時刻(0〜1、省略時0)を bit25-30 に 1/64 フレーム刻みで詰める(2026-09-08)。
  // kss2mml の AY/SCC 抽出器がソフトエンベロープの位相エイリアシング対策(hes2mml/expansion/wave.js
  // resampleSeq)に使う。writeLog の形(Int32Array のフレーム配列)は変えないので Worker プロトコルと
  // ロール構築(addr/value/io だけを見る)はそのまま。旧ログ(frac 無し)は 0 として扱われ従来どおり
  Emu.kssPackWrite = (addr, value, io, frac) => (addr & 0xFFFF) | ((value & 0xFF) << 16) | (io ? 0x1000000 : 0) |
    ((frac > 0 ? Math.min(63, Math.round(frac * 64)) : 0) << 25);
  Emu.kssUnpackFrac = (pw) => ((pw >>> 25) & 0x3F) / 64;

  /**
   * チャンネルごとのミュート設定をチップの mute プロパティへ反映する。
   * target がオブジェクトならキー一致、配列ならインデックス一致で上書きする。
   */
  Emu.applyMute = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = !!source[i];
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = !!source[k];
      }
    }
  };

  /**
   * チャンネルごとの音量(0〜2、1=100%で2まではブースト)設定をチップの vol プロパティへ
   * 反映する。applyMuteと同じkey/index一致方式(未指定のチャンネルは既存値=通常1のまま
   * 変更しない)。
   */
  Emu.applyVolume = function (target, source) {
    if (!target || !source) return;
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        if (source[i] !== undefined) target[i] = Math.max(0, Math.min(2, source[i]));
      }
    } else {
      for (const k of Object.keys(target)) {
        if (source[k] !== undefined) target[k] = Math.max(0, Math.min(2, source[k]));
      }
    }
  };

  // NESの非線形ミキサー出力(DCオフセット付き)をAC成分に変換するDCブロッカー
  Emu.dcBlock = function (samples) {
    const out = new Float32Array(samples.length);
    let prevX = 0, prevY = 0;
    const R = 0.999;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = x - prevX + R * prevY;
      out[i] = y;
      prevX = x;
      prevY = y;
    }
    return out;
  };

  /**
   * 楽曲キャプチャの共通セットアップ。player・バッファ・ログ配列を返す。
   * @private
   */
  function _setupCapture(nsfBytes, opt) {
    const songIndex = opt.songIndex || 0;
    const durationSeconds = opt.durationSeconds || 10;
    const sampleRate = opt.sampleRate || 44100;

    const player = new Emu.NsfPlayer(nsfBytes);
    // initSong の書き込みを runningRegs に先取りしてスナップショットの初期状態とする。
    // initWrites は同じ書き込みを順序付きで(重複アドレスも全て)記録したもの。
    // $F800/$4800(N163)・$C000/$E000(FME7)・$9010/$9030(VRC7)のようなラッチ+データ間接
    // アドレッシングのチップは、runningRegsの最終値スナップショットだけでは内部レジスタ
    // 全体を復元できない(同じ2アドレスに何度も書き込むため)ので、拡張音源の
    // buildTimeline側で書き込みシーケンスをそのまま再生できるようにこちらも保持する。
    const runningRegs = {};
    const initWrites = [];
    // NsfPlayer.initSong()は$4017(フレームカウンタリセット)・$4015(全チャンネル有効化)を
    // bus.write()を経由せずAPU.writeRegister()へ直接書き込むため、onWriteフックを
    // 通らずinitWritesに記録されない。NSF自体のINITルーチンがこれらを書き直さない曲
    // (例: アルマナの軌跡のようなFDS曲で2A03パルス/三角/ノイズ側を$4015再設定しない
    // ドライバ)だと、initWritesの再生だけで音源を組み立てるNsfReplayStreamPlayerでは
    // $4015が一度も有効化されず2A03が全チャンネル無音になる不具合があった。
    // initSong()内部の書き込み順序と同じ順で先に記録しておく(曲のINITが実際に
    // 書き直した場合は後続の通常記録で上書きされるので問題ない)。
    runningRegs[0x4017] = 0x40; initWrites.push({ addr: 0x4017, value: 0x40 });
    runningRegs[0x4015] = 0x0F; initWrites.push({ addr: 0x4015, value: 0x0F });
    player.bus.onWrite = (a, val) => { runningRegs[a] = val; initWrites.push({ addr: a, value: val }); };
    player.initSong(songIndex, !!opt.pal);
    player.bus.onWrite = null;

    if (opt.mute) {
      if (opt.mute.apu) Emu.applyMute(player.apu.mute, opt.mute.apu);
      if (opt.mute.expansion) {
        for (const [name, chip] of Object.entries(player.bus.expansion)) {
          if (opt.mute.expansion[name]) Emu.applyMute(chip.mute, opt.mute.expansion[name]);
        }
      }
    }

    const frameRate = opt.pal ? (1000000 / 19997) : Emu.FRAME_RATE_NTSC;
    const totalFrames = Math.max(1, Math.ceil(durationSeconds * frameRate));
    const samplesPerFrame = sampleRate / frameRate;
    // regsOnly モードでは音声バッファ不要（巨大配列の確保・dcBlock をスキップ）
    const regsOnly = !!opt.regsOnly;
    const totalSamples = regsOnly ? 0 : Math.ceil(totalFrames * samplesPerFrame);

    const raw = new Float32Array(totalSamples);
    const writeLog = new Array(totalFrames);
    const regSnapshots = new Array(totalFrames);
    const cpuSnapshots = new Array(totalFrames);
    const memSnapshots = new Array(totalFrames);
    const apuEnvSnapshots = new Array(totalFrames);
    // N163内部128byte RAMのフレームごとスナップショット。N163は$F800(アドレスラッチ)+$4800
    // (データ)の間接アドレッシングで、しかもドライバは位相バイトを「読み飛ばし」でスキップする
    // (読み出しもオートインクリメントを進める)。writeLogは書き込みしか記録しないため、
    // ログの再生だけではアドレスポインタがズレて内部RAMを正しく復元できない。ライブチップの
    // RAMを直接採取して nsf2mml抽出/ピアノロールへ渡す(この不一致がN163変換崩れの根因)。
    const n163Snapshots = new Array(totalFrames);

    let pendingWrites = [];
    player.bus.onWrite = (addr, value) => pendingWrites.push({ addr, value });

    // INIT後・PLAY前の初期レジスタ状態をスナップショット
    const initRegs = Object.assign({}, runningRegs);

    return { player, sampleRate, frameRate, totalFrames, samplesPerFrame, totalSamples,
             raw, writeLog, regSnapshots, cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, initRegs, initWrites,
             pendingWritesRef: { get current() { return pendingWrites; }, set(v) { pendingWrites = v; player.bus.onWrite = (a, val) => pendingWrites.push({ addr: a, value: val }); } } };
  }

  /**
   * APU矩形波1/2・ノイズの「実際に出力中の音量レベル」を取得する。
   * ハードウェアエンベロープ(減衰)使用時、レジスタの下位4bitは音量ではなく減衰速度なので、
   * 内部の decay 値(0-15)を読む必要がある。env=true なら減衰モード。
   * envelope.output() は constant時=設定音量 / 減衰時=現在のdecay値 を返す。
   */
  // DPCMサンプルのデルタ復号キャッシュ（(addr,len)が変わった時だけ再復号）
  let _dmcCache = { key: '' };
  function _dmcSample(bus, addr, len) {
    if (!bus || !len) return null;
    const key = addr + ':' + len;
    if (_dmcCache.key !== key) {
      const n = len * 8;
      const samples = new Float32Array(n);
      let level = 64; // 7bit DAC の中央から delta(+2/-2, 0..127クランプ) で再構成
      let k = 0;
      for (let b = 0; b < len; b++) {
        const byte = bus.read((addr + b) & 0xFFFF) & 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          if (byte & (1 << bit)) { if (level <= 125) level += 2; }
          else { if (level >= 2) level -= 2; }
          samples[k++] = (level - 64) / 64; // -1..1
        }
      }
      _dmcCache = { key, addr, len, samples };
    }
    return { addr, len, samples: _dmcCache.samples };
  }

  Emu.snapshotApuEnv = function (apu, fds, bus) {
    // level/env=音量エンベロープの実出力。len/period/mutedは「レジスタ値だけでは分からない
    // 実状態」で、長さカウンタによる自然消音・スイープユニットが書き換えた実周期・スイープ
    // 強制ミュートを鍵盤/ピアノロールの発音判定と音程表示に使う(nsf2mml/converter.jsの
    // extractPulseEvents/extractNoiseEventsが行うシミュレーションと同じ情報)。
    const rd = (ch) => ({ level: ch.envelope.output(), env: !ch.envelope.constant,
      len: ch.lengthCounter, period: ch.timerPeriod,
      muted: typeof ch.isMuted === 'function' ? ch.isMuted() : false });
    const out = { pulse1: rd(apu.pulse1), pulse2: rd(apu.pulse2), noise: rd(apu.noise) };
    // 三角波は音量レジスタが無く、長さカウンタ+線形カウンタだけで発音が止まる
    // seq: シーケンサ位置。三角波は消音中も最後の値をDCとして保持し、そのDCが
    // 非線形tndミキサー経由でノイズ/DPCMの聞こえ方に効くため、見かけ音量の計算に要る
    if (apu.triangle) out.triangle = { len: apu.triangle.lengthCounter, linear: apu.triangle.linearCounter,
                                       seq: apu.triangle.seqStep };
    // FDS $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を採取。
    // effectiveFreq: モジュレーション適用後の実ピッチ(内部単位)。鍵盤表示でMH<n>使用中の
    // 実際に揺れているピッチをHz換算する用途(生の$4082/4083周期だけでは変調前の値になる)。
    // modEnabled: モジュレーションユニットの実際の有効状態。$4087が一度も書かれていない
    // (曲がMH<n>を全く使わない)場合、生レジスタは既定値0のままでbit7=0=有効に見えて
    // しまう(実際は一度も有効化されていないのに鍵盤表示が常時ON扱いになるバグの原因)。
    // fds.modEnabled(インスタンスの実状態、既定false)を使えばこの誤検出を避けられる。
    if (fds) out.fds = { gain: fds.volGain, env: !!fds.volEnvEnabled, effectiveFreq: fds.effectiveFreq, modEnabled: !!fds.modEnabled };
    // DPCM: 実出力レベル(outputLevel 0-127)と、メモリ上のサンプルをデルタ復号した波形
    if (apu.dmc) {
      // playing: 実際にサンプルを読み進めている最中か($4015 bit4 の書込み値ではなく実状態。
      // 鍵盤/ロールの発声判定用。鳴り終わると bytesRemaining=0 かつ shiftReg を出し切る)
      // amp: 直近1フレームのDAC振幅(0〜127)=DPCMの体感音量。level(現在値)は波形の
      // 位置でしかなく音量にならないため、鍵盤表示の音量数値はこちらを使う
      const dmc = { level: apu.dmc.outputLevel, amp: apu.dmc.takeAmplitude(), seq: apu.dmc.seq || 0,
                    playing: apu.dmc.bytesRemaining > 0 || (apu.dmc.bitsRemaining > 0 && !apu.dmc.silence) };
      if (bus) {
        const s = _dmcSample(bus, apu.dmc.sampleAddr, apu.dmc.sampleLength);
        if (s) { dmc.addr = s.addr; dmc.len = s.len; dmc.samples = s.samples; }
      }
      out.dmc = dmc;
    }
    return out;
  };

  /** 1フレーム分を処理してバッファ・ログを更新する。posを返す。 */
  function _processFrame(ctx, f, pos) {
    const { player, sampleRate, totalSamples, raw, writeLog, regSnapshots,
            cpuSnapshots, memSnapshots, apuEnvSnapshots, n163Snapshots, runningRegs, pendingWritesRef } = ctx;
    pendingWritesRef.set([]);
    const frame = player.renderFrame(sampleRate);
    writeLog[f] = pendingWritesRef.current;
    for (const w of pendingWritesRef.current) runningRegs[w.addr] = w.value;
    // 書き込みが1件も無かったフレームは前フレームとスナップショットが同一なので、
    // オブジェクトを共有してアロケーション(=GC圧)を減らす。消費側(ピアノロール/
    // モニタ/nsf2mml)はいずれも読み取り専用アクセスのため共有しても安全。
    regSnapshots[f] = (f > 0 && pendingWritesRef.current.length === 0)
      ? regSnapshots[f - 1] : Object.assign({}, runningRegs);
    const n163 = player.bus.expansion && player.bus.expansion.n163;
    if (n163) n163Snapshots[f] = n163.ram.slice();
    cpuSnapshots[f] = {
      A: player.cpu.A, X: player.cpu.X, Y: player.cpu.Y,
      P: player.cpu.P, S: player.cpu.S, PC: player.cpu.PC
    };
    memSnapshots[f] = player.bus.mem.slice(0, 0x100);
    apuEnvSnapshots[f] = Emu.snapshotApuEnv(player.apu, player.bus.expansion && player.bus.expansion.fds, player.bus);
    for (let i = 0; i < frame.length && pos < totalSamples; i++, pos++) {
      raw[pos] = frame[i];
    }
    return pos;
  }

  function _buildResult(ctx) {
    return {
      audio: ctx.raw.length > 0 ? Emu.dcBlock(ctx.raw) : ctx.raw,
      sampleRate: ctx.sampleRate,
      totalFrames: ctx.totalFrames,
      samplesPerFrame: ctx.samplesPerFrame,
      writeLog: ctx.writeLog,
      regSnapshots: ctx.regSnapshots,
      cpuSnapshots: ctx.cpuSnapshots,
      memSnapshots: ctx.memSnapshots,
      apuEnvSnapshots: ctx.apuEnvSnapshots,
      n163Snapshots: ctx.n163Snapshots,
      initRegs: ctx.initRegs,
      initWrites: ctx.initWrites
    };
  }

  /**
   * 楽曲を一括キャプチャする（同期版・後方互換）
   * @param {Uint8Array} nsfBytes - 完全なNSFバイナリ（128バイトヘッダ含む）
   * @param {object} opt
   * @param {number} [opt.songIndex=0]
   * @param {number} [opt.durationSeconds=10]
   * @param {number} [opt.sampleRate=44100]
   * @param {boolean} [opt.pal=false]
   */
  Emu.captureSong = function (nsfBytes, opt = {}) {
    const ctx = _setupCapture(nsfBytes, opt);
    let pos = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      pos = _processFrame(ctx, f, pos);
    }
    return _buildResult(ctx);
  };

  /**
   * 楽曲を非同期でキャプチャする（UI をブロックしない）
   * CHUNK_FRAMES フレームごとにブラウザへ制御を返すため、長尺でも UI がフリーズしない。
   * regsOnly時はチャンクを細かくし(ピアノロールの先読み用途で使われ、実再生と
   * メインスレッドを共有するため)、onProgressにはその時点までのregSnapshots/writeLog
   * (末尾は未確定=空のまま伸びていく同一配列参照)も渡すので、キャプチャ完了を待たずに
   * 途中経過だけでピアノロールを段階的に埋めていける。
   * @param {Uint8Array} nsfBytes
   * @param {object} opt - captureSong と同じオプション
   * @param {function(done:number, total:number, regSnapshots:Array, writeLog:Array, n163Snapshots:Array):void} [onProgress] - 進捗コールバック
   * @returns {Promise<object>} captureSong と同じ戻り値
   */
  Emu.captureSongAsync = async function (nsfBytes, opt = {}, onProgress = null) {
    const ctx = _setupCapture(nsfBytes, opt);
    const regsOnly = !!opt.regsOnly;
    // ★2026-08-20 スライス制御を「フレーム数固定(CHUNK_FRAMES)」から「時間予算固定」へ変更。
    // 端末の速度差(同じフレーム数でも掛かる時間はバラバラ)を自動吸収し、メインスレッド
    // 実行時は1スライスあたり最大~sliceBudgetMsしかブロックしない。Worker実行時
    // (src/audio/capture-worker-client.js経由)はUIをブロックしないため、呼び出し側が
    // 大きい予算とsetTimeoutより高速なyield(opt.yieldFn、4msクランプ回避)を渡して
    // スループット優先にできる。
    const sliceBudgetMs = opt.sliceBudgetMs > 0 ? opt.sliceBudgetMs : (regsOnly ? 5 : 15);
    const yieldFn = opt.yieldFn || (() => new Promise(r => setTimeout(r, 0)));
    let sliceStart = performance.now();
    let pos = 0;
    // regsOnly専用: 1フレーム=CPUサイクルCYCLES_PER_FRAME分、というサイクル駆動で
    // PLAYを刻む(NsfPlayer.renderFrame()と全く同じサイクル会計方式・クロック呼び出し)。
    // 省略するのはaudio.mixSample()と出力バッファへの書き込みだけ(regsOnlyの目的である
    // 「音声波形は要らない」を満たすのに必要十分)。
    // ★当初はapu.clock()/expansion.clock()自体も丸ごと省略していたが、これは誤りだった。
    // FDSの$4090(エンベロープ実測値読み出し)のように、ドライバがチップの内部状態を
    // 読み戻して「エンベロープが既定値まで減衰したら次の命令へ分岐する」種類の楽器
    // マクロを使う曲(Ai Senshi Nicol(FDS)等)では、clock()を呼ばないとエンベロープが
    // 初期値のまま一切減衰しないため、この分岐条件が実際のプレイとは異なる結果になり
    // (常に「まだ減衰していない」ため)、本来発生するはずの命令分岐先の書き込みが
    // 丸ごとwriteLogから欠落する不具合があった。clock()自体はmixSample()に比べて
    // 十分軽い(波形合成をしないだけ)ため、追加しても速度上のメリットはほぼ失われない。
    // cpuDebtは端数サイクルを次のフレームへ確実に持ち越す必要があるため、
    // renderFrame()と同じく「+=」で加算する(「=」で上書きすると端数が失われる)。
    const CYCLES_PER_FRAME = Emu.CPU_CLOCK_NTSC / Emu.FRAME_RATE_NTSC;
    let regsOnlyCycleAccum = 0;
    let regsOnlyCpuDebt = 0;
    for (let f = 0; f < ctx.totalFrames; f++) {
      if (regsOnly) {
        // CPU実行 + チップのクロック(エンベロープ等の内部状態更新)のみ。
        // 音声波形合成(mixSample())と出力バッファ書き込みだけを省略する。
        ctx.pendingWritesRef.set([]);
        if (!ctx.player.cpu.callActive) ctx.player.cpu.beginCall(ctx.player.header.playAddr);
        const regsOnlyExpansion = Object.values(ctx.player.bus.expansion);
        regsOnlyCycleAccum += CYCLES_PER_FRAME;
        while (regsOnlyCycleAccum >= 1) {
          if (regsOnlyCpuDebt <= 0) {
            if (ctx.player.cpu.callActive) regsOnlyCpuDebt += ctx.player.cpu.stepCall();
            else regsOnlyCpuDebt = 1;
          }
          regsOnlyCpuDebt--;
          ctx.player.apu.clock();
          for (let e = 0; e < regsOnlyExpansion.length; e++) regsOnlyExpansion[e].clock();
          regsOnlyCycleAccum -= 1;
        }
        ctx.writeLog[f] = ctx.pendingWritesRef.current;
        for (const w of ctx.pendingWritesRef.current) ctx.runningRegs[w.addr] = w.value;
        // 書き込み無しフレームは前フレームとスナップショット同一なのでオブジェクトを共有
        // (_processFrame側の同名コメント参照)
        ctx.regSnapshots[f] = (f > 0 && ctx.pendingWritesRef.current.length === 0)
          ? ctx.regSnapshots[f - 1] : Object.assign({}, ctx.runningRegs);
        const n163 = ctx.player.bus.expansion && ctx.player.bus.expansion.n163;
        if (n163) ctx.n163Snapshots[f] = n163.ram.slice();
      } else {
        pos = _processFrame(ctx, f, pos);
      }
      // f===0でも必ず一度onProgressを発火する(最初のonProgressで実再生のplayer.load()が
      // 走るため、時間予算いっぱいまで溜めると再生開始が遅れる)。以降は時間予算を
      // 超えたときだけスライス境界にする。
      if (f === 0 || performance.now() - sliceStart >= sliceBudgetMs) {
        // initRegs/initWritesは末尾に追加(既存呼び出し元は無視するだけで後方互換)。
        // NSF実再生をこのwriteLogから直接合成する新エンジン(NsfReplayStreamPlayer)が
        // INIT時点の初期状態を再生開始前に必要とするため、完了(Promise解決)を待たずに
        // 最初のonProgressの時点で渡せるようにした。
        if (onProgress) onProgress(f + 1, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
        await yieldFn();
        sliceStart = performance.now();
        // 呼び出し元が「もう不要」と判断したら(曲切替/停止の連打で先読みが積み上がるのを防ぐ)
        // ここで即座に打ち切る。onProgress側だけをトークンで無視する方式だと、キャプチャ
        // ループ自体(重いCPUエミュレーション)は最後まで回り続けてしまい、連打するたびに
        // 積み重なって実再生と競合しUIが重くなる不具合があったため。
        if (opt.shouldCancel && opt.shouldCancel()) return _buildResult(ctx);
      }
    }
    if (onProgress) onProgress(ctx.totalFrames, ctx.totalFrames, ctx.regSnapshots, ctx.writeLog, ctx.n163Snapshots, ctx.initRegs, ctx.initWrites);
    return _buildResult(ctx);
  };
})(globalThis);

/*
 * チャンネル別鍵盤表示ウィジェット (ミュート統合版)
 * MML.UI.KeyboardDisplay
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  // 表示文言の翻訳(src/i18n/i18n.js)。キーは日本語の原文そのもの
  const T = (key, params) => MML.I18n.t(key, params);

  const CPU_CLOCK = 1789773;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // canvasはCSSを継承しないので、style.cssの --sans / --mono を実行時に読んでフォント指定に使う。
  // 総称ファミリ(sans-serif/monospace)任せだと日本語フォント未導入の環境で豆腐(□)になり、
  // 中国語ロケールでは漢字が簡体字の字形で描かれる(canvasにはlang属性が効かない)。
  let _fontStacks = null;
  function fontStack(kind) {
    if (!_fontStacks) {
      const cs = getComputedStyle(document.documentElement);
      const pick = (name, fallback) =>
        (cs.getPropertyValue(name) || '').replace(/\s+/g, ' ').trim() || fallback;
      _fontStacks = {
        sans: pick('--sans', 'sans-serif'),
        mono: pick('--mono', 'monospace'),
      };
    }
    return _fontStacks[kind];
  }

  const MIDI_MIN = 24;
  const MIDI_MAX = 108;
  const TOTAL_WHITE = 50;

  // ピアノロールの時間軸スケール(px/秒)。先読み時間幅(秒)は「時間軸の長さ(px)÷この値」で
  // 決まる(=ロールが長いほど遠い未来まで見える)。従来の固定値(高さ320px/4秒)と同じ80px/秒。
  const ROLL_PX_PER_SEC = 80;

  // ピアノロールcanvasの高さ(ロールを一覧の下に置く配置のとき)。style.cssの .kbd-roll { height }
  // と必ず一致させること(折りたたみ時にウィンドウ高さをこの値ぶん増減させるため、
  // ズレると鍵盤の位置がずれる)。
  const ROLL_CANVAS_HEIGHT = 320;
  const MIN_WINDOW_HEIGHT = 160;
  // 鍵盤canvasの「鍵の長さ」方向のpx数(縦向きロール=鍵盤の高さ、横向きロール=鍵盤の幅)。
  // style.cssの .kbd-piano-wrap { height } / .kbd-roll-wrap--horizontal .kbd-piano-wrap { width } と一致させること。
  const PIANO_KEY_LEN = 68;
  // SPCボイス一覧(part/mute/ch/L/R/vol/env/wave/PM/note/freq/echo)の全列が収まる一覧幅。
  // style.cssの .kbd-left.kbd-left--spc { width } と一致させること
  const SPC_LIST_MIN_WIDTH = 512;
  // チャンネル割当の「借用先/音色」列(.kbd-h-assign/.kbd-assign の230px + gap)。
  // style.css の .kbd-left--assign の各幅(=各フォーマットの固定幅+この値)と一致させること
  const ASSIGN_COL_WIDTH = 236;
  // 一覧の固定幅(style.css の .kbd-left / --hes / --gbs / --spc と一致させること)
  const LIST_WIDTH_NSF = 320, LIST_WIDTH_PAN = 370;

  // ── 鍵盤表示レイアウト設定 ────────────────────────────────────
  // rollOrientation: 'vertical'  = Synthesia式(音程=横軸、音符が上から鍵盤へ降る。鍵盤は下)
  //                  'horizontal'= DAW式(音程=縦軸、音符が右から鍵盤へ流れる。鍵盤は左)
  // rollPlacement:   'bottom' = チャンネル一覧の下 / 'right' = 一覧の右 / 'window' = 別ウィンドウ
  // listColumns:     'single' = 1列 / 'auto' = 幅に応じて自動多段
  // rollLanes:       'all' = 全チャンネルを1つの鍵盤/ロールに重ねて表示
  //                  'perChannel' = 使用チャンネルごとに鍵盤+ロールのレーンを並べる(縦向き=横に並ぶ、
  //                                 横向き=縦に積む。各レーンはそのchの音域ぶんの大きさを持ち、
  //                                 収まらない分は .kbd-lanes 全体がスクロールする)
  // fileInfoPlacement: 開いているサウンドファイルのヘッダ情報(=ファイル情報ペイン)の置き場。
  //                  'auto' = 他の置き場に合わせて自動で決める(_effectiveFileInfoPlacement)
  //                  'top' / 'bottom' = チャンネル一覧の上 / 下
  //                  'left' / 'right' = チャンネル一覧の左 / 右
  //                  下配置のとき大波形も一覧の下にある(=一覧が多段)なら、ファイル情報と
  //                  大波形は同じ帯(.kbd-below)に左右で並ぶ(ユーザー指示 2026-09-10)
  // 既定値は従来の見た目(縦・下・1列・まとめて)+ファイル情報は自動。localStorageに永続化する。
  const LAYOUT_STORAGE_KEY = 'mml_keyboardLayout_v1';
  // rollView:        'roll' = ピアノロール(鍵盤の音程軸に音符の棒)
  //                  'score' = 楽譜(音程軸を五線に置き換え、時間軸はロールと同じ実時間比例。MMLの
  //                            コンパイル結果から作る表記モデル(src/score/notation.js)を setScore() で
  //                            受け取ったときだけ有効で、実ファイル再生中はロールに戻る。
  //                            ROADMAP「フェーズ外: 楽譜出力」段階3、2026-09-16)
  const LAYOUT_DEFAULTS = Object.freeze({ rollOrientation: 'vertical', rollPlacement: 'bottom', listColumns: 'single', rollLanes: 'all', fileInfoPlacement: 'auto', rollView: 'roll' });
  const LAYOUT_CHOICES = Object.freeze({
    rollOrientation: ['vertical', 'horizontal'],
    rollPlacement: ['bottom', 'right', 'window'],
    listColumns: ['single', 'auto'],
    rollLanes: ['all', 'perChannel'],
    fileInfoPlacement: ['auto', 'top', 'bottom', 'left', 'right'],
    rollView: ['roll', 'score'],
  });
  // チャンネルごとのレーン: そのchが曲全体で鳴らす音域(+使っているドラムレーン)だけを
  // 音程軸いっぱいに表示する(_updateLaneRanges)。音域はchごとに違うので拡大率もchごとに違い、
  // 音程方向のスクロール/自動追従は無い(白鍵10本の窓を自動スクロールさせる旧方式は、
  // 窓が動くたびに音程の基準が変わって見づらかった)。
  // レーンの大きさ(音程軸方向のpx。縦向き=幅、横向き=高さ)は既定で LANE_PX_PER_WHITE×音域幅、
  // レーンの境目のスプリッターをドラッグすると個別に変えられる(=そのレーンだけ拡大縮小する)。
  // 全レーンの合計が入り切らないぶんは .kbd-lanes が音程軸方向にスクロールする。
  const FILE_INFO_DEFAULT_W = 260; // ファイル情報ペインの既定の幅(左右に並ぶ置き場)
  const FILE_INFO_DEFAULT_H = 120; // ファイル情報ペインの既定の高さ(上下に積む置き場)
  const LANE_PX_PER_WHITE = 15;  // 既定の拡大率(白鍵1本あたりpx)。旧実装の窓(白鍵10本=150px)と同じ
  const LANE_MIN_PX = 40;        // レーンの音程軸方向の最小px(ドラッグの下限)
  const LANE_MIN_WHITE = 7;      // 音域が狭いchでも最低このぶんは見せる(白鍵7本=1オクターブ)
  const LANE_RANGE_PAD = 0.5;    // 音域の両端に足す余白(白鍵)。端の音符が枠に張り付かないように
  const LANE_UNKNOWN_PX = 150;   // 音域が分からないレーン(1音も鳴らないch/先読み未完)の既定の大きさ
  const LANE_LABEL_PX = 14;      // .kbd-lane-labelの高さ。横向きではレーンの大きさに含まれる
                                 // (style.cssの.kbd-lane-labelのheightと一致させること)
  // スポットライト(案D): チャンネル一覧の行にホバー/クリックすると、ロール上でその行の
  // ノートだけを原色・最前面で描き、他chはこの不透明度まで減光する。ミュート(=音も消える)
  // とは別軸の「注目だけ」の仕組みで、PCM多chがドラムを叩いていて音符が重なるときに
  // 「今どの行を見ているか」を切り分けるために使う。
  const SPOTLIGHT_DIM_ALPHA = 0.16;
  // ── ドラム区画(音程ロールと同じcanvasの低音側に置く) ─────────────
  // 打楽器として鳴っているサンプルPCM(pcmSampleRow の drumKey)は音程軸に載せられないので、
  // 音程鍵盤(MIDI_MIN=C1)より低音側に「1レーン=1サンプル」の区画を作ってそこへ置く。
  // 音程軸の単位は白鍵1本ぶん(wk)で、ドラム1レーンは DRUM_LANE_WHITE 本ぶんの幅を持つ
  // (白鍵と同じ幅だとラベルが入らないので少し広くしてある)。ドラムが1つも無い曲では
  // レーン数0=区画の幅0になり、音程軸の座標は従来と完全に一致する。
  // レーン割当そのもの(どのサンプルが何番レーンか・上限・溢れの扱い)は
  // src/convert/drumMap.js に置いてある。vgm2mmlのドラム音符出力と同じ表を使うため。
  /**
   * 音源の識別色 '#rrggbb' → セレクトの候補一覧に敷く薄い背景色。
   * 明度は明暗テーマの両方で文字が読めるよう、下地へ薄く乗せるだけにする。
   */
  function tintOf(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.18)`;
  }

  const DRUM_LANE_WHITE = 1.5;  // ドラム1レーンの幅(白鍵何本ぶんか)
  // レーンの色 = どの太鼓か。チャンネルの色(=どのスロットが鳴らしたか)とは別軸なので、
  // 打点は「塗り=このレーン色 / 枠線=チャンネル色」の二重符号化で描く。プール式チップ
  // (C140/C352/QSound/MultiPCM)は同じ太鼓が毎回別スロットへ移るため、色をchに割り当てると
  // 太鼓の色が踊ってしまう。塗りをサンプル側に固定するとその問題が出ない。
  const DRUM_LANE_COLORS = ['#e8564a', '#f0a232', '#4a9de8', '#9b6ef3', '#22b3a4', '#d94fa0',
                            '#7a8a99', '#c2a03a', '#5ac47a', '#ff7fa8', '#8ab4ff', '#d0703a',
                            '#59c2c9', '#b06ee0', '#9aa832', '#e06060'];
  const DRUM_OTHER_COLOR = '#8a93a1'; // 「その他」レーン

  // 曲が終わった後の挙動。ヘッダの1つのアイコンをクリックのたびに巡回して選ぶ
  // 複数の元chを1本にまとめて載せられる借用先(重複=競合ではない)。
  // DPCMは「選んだPCMチャンネルの打楽器を、同時発音ぶんはミックスして1本のサンプル列にする」
  // という作りなので、何本選んでもよい
  const MULTI_SOURCE_TARGETS = new Set(['dpcm']);

  const REPEAT_MODES = ['next', 'one', 'shuffle', 'stop'];
  const REPEAT_MODE_KEY = 'mml_repeatMode';
  const REPEAT_ICONS = {
    next: { label: () => T('曲が終わったら: 次の曲へ'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9.5M11.5 4.8 14 7l-2.5 2.2"/><path d="M16 13H6.5M8.5 10.8 6 13l2.5 2.2"/></svg>' },
    one: { label: () => T('曲が終わったら: 同じ曲を繰り返す'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8.5A4.5 4.5 0 0 1 10 4h5M12.5 1.8 15 4l-2.5 2.2"/><path d="M14.5 11.5A4.5 4.5 0 0 1 10 16H5M7.5 13.8 5 16l2.5 2.2"/><text x="10" y="12.6" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text></svg>' },
    shuffle: { label: () => T('曲が終わったら: ランダム再生'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h3l8 8h3M3 14h3l8-8h3"/><path d="M14.8 3.8 17 6l-2.2 2.2M14.8 11.8 17 14l-2.2 2.2"/></svg>' },
    stop: { label: () => T('曲が終わったら: 停止'),
      svg: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="10" height="10" rx="1.5"/></svg>' },
  };
  function loadLayoutSettings() {
    const out = Object.assign({}, LAYOUT_DEFAULTS);
    try {
      const raw = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(LAYOUT_DEFAULTS)) {
          if (LAYOUT_CHOICES[k].includes(raw[k])) out[k] = raw[k];
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function saveLayoutSettings(s) {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  // ── ロール/鍵盤の座標系 ───────────────────────────────────────
  // ロールと鍵盤は「音程軸(p)」と「時間軸(t)」の2軸で描き、向き(orientation)に応じて
  // canvasのx/yへ写像する。描画ルーチン側は向きを意識せずp/tだけで書けるようにするための抽象。
  //   p: 0(最低音側の端) → pitchLen(最高音側の端)。keyX()と同じ単位(白鍵1本=wk px)
  //   t: 0(現在=鍵盤に接する端) → timeLen(先読みの果て)
  //   vertical  : p→x(左→右)、t→y(下→上)   … 音符が上から降ってくる
  //   horizontal: p→y(下→上)、t→x(左→右)   … 音符が右から流れてくる
  // 縦向きの写像は従来実装と同じ式(H - t)になるよう書いてあり、丸めまで含めて描画結果は不変。
  // visibleWhite: 音程軸に収める白鍵の本数(省略=鍵盤全体TOTAL_WHITE。チャンネルごとのレーンは
  // そのchの音域ぶん=lane.visWhiteで、表示窓の低音側の端(lane.offWhite)は呼び出し側がkeyX()の結果から引く)
  // nDrum: ドラム区画のレーン数(0=区画なし)。音程軸は [ドラム区画][音程鍵盤] の並びで、
  // 全体の長さは (nDrum * DRUM_LANE_WHITE + TOTAL_WHITE) 白鍵ぶん。keyX()が返す音程側の
  // 座標には drumOff(区画の幅px)を足して使う。
  function makeRollGeom(orientation, W, H, visibleWhite, nDrum) {
    const vertical = orientation !== 'horizontal';
    const pitchLen = vertical ? W : H;
    const timeLen = vertical ? H : W;
    const drumUnits = (nDrum || 0) * DRUM_LANE_WHITE;
    const wk = pitchLen / (visibleWhite || (TOTAL_WHITE + drumUnits));
    const bk = Math.max(3, wk * 0.60);
    // 先読み時間幅(秒)と、秒→時間軸pxの変換。時間軸320pxのとき従来通り4秒/80px/秒になる
    const windowSec = timeLen / ROLL_PX_PER_SEC;
    const tPx = (sec) => (sec / windowSec) * timeLen;
    return {
      vertical, W, H, pitchLen, timeLen, wk, bk, windowSec, tPx,
      nDrum: nDrum || 0, drumOff: drumUnits * wk, drumLaneW: DRUM_LANE_WHITE * wk,
      // 音程軸[pLo, pLo+pSize) × 時間軸[tLo, tHi) の矩形をcanvas座標{x,y,w,h}へ。
      // minT: 時間軸方向の最小サイズ(px)。短い音符も見えるように下限を設ける用途
      rect(pLo, pSize, tLo, tHi, minT) {
        if (vertical) {
          const y0 = H - tHi, y1 = H - tLo;
          return { x: pLo, y: y0, w: pSize, h: Math.max(minT || 0, y1 - y0) };
        }
        return { x: tLo, y: H - pLo - pSize, w: Math.max(minT || 0, tHi - tLo), h: pSize };
      },
      // 点(p, t) → canvas座標
      point(p, t) { return vertical ? { x: p, y: H - t } : { x: t, y: H - p }; },
    };
  }

  // ドラム区画のレーン lane の音程軸上の範囲(px)。sub/subN を渡すと、レーンをsubN分割した
  // うちの sub 番目(同時発音の横並び)の範囲を返す。
  // note列クリックで「打楽器/音階の指定」を出す行(サンプルPCM系のチャンネル)。
  // NA/NB=YM2610 ADPCM、GA=GA20、SP=SegaPCM、CN=C140、CS=C352、QS=QSound、
  // OK=OKIM6295、MP=MultiPCM
  const SAMPLE_ROW_RE = /^(N[AB]\d?|GA\d|SP\d+|CN\d+|CS\d+|QS\d+|OK\d|MP\d+)$/;

  function drumLaneX(lane, sub, subN, laneW) {
    const n = Math.max(1, subN || 1);
    const s = Math.min(n - 1, Math.max(0, sub || 0));
    const w = laneW / n;
    return { x: lane * laneW + s * w, size: w };
  }

  const WHITE_IDX = [0,-1,1,-1,2,3,-1,4,-1,5,-1,6];
  const IS_BLACK   = [0, 1,0, 1,0,0, 1,0, 1,0, 1,0];

  // APU パルスのデューティ比 (High 区間の割合): 12.5% / 25% / 50% / 75%
  const APU_DUTY = [0.125, 0.25, 0.5, 0.75];

  // ノイズ周期テーブル（$400E bits0-3 → LFSRシフト間のCPU待機サイクル数, NTSC）
  // ノイズ周波数 = CPU_CLOCK / NOISE_PERIOD[index]（idx0≈447kHz … idx15≈440Hz）
  const NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // GBノイズの実測周波数(c.freq、256通りのclockShift×divisorCode)を、既存の2A03ノイズ
  // 16周期のうち対数距離で最も近いものにマッチさせた素のindex(0-15)に変換する
  // (gbs2mml/expansion/noise.jsのgbNoiseFreqToNote()と同じ考え方だが、MMLノート番号
  // ではなく鍵盤表示のnote列にそのまま出す周期indexが欲しいだけなので31-idxはしない)。
  function gbNoiseFreqToIndex(freqHz) {
    if (!freqHz) return 0;
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < NOISE_PERIOD.length; i++) {
      const diff = Math.abs(Math.log2(freqHz / (CPU_CLOCK / NOISE_PERIOD[i])));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return best;
  }

  // DMC(DPCM)レートテーブル（$4010 bits0-3 → サンプル1bitあたりのCPUサイクル数, NTSC）
  // 再生周波数 = CPU_CLOCK / DMC_RATE[index]（idx0≈4182Hz … idx15≈33144Hz）
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];

  // ── チャンネル色のユーザーカスタマイズ ────────────────────────
  // 鍵盤左上のチャンネル一覧の丸(kbd-dot)クリックで選べる色一覧、
  // および localStorage への保存/読込。ロール・鍵盤・波形表示すべてがこの
  // 上書き色を参照するため、変更は即座に全表示へ反映される。
  const CHANNEL_COLOR_STORAGE_KEY = 'mml_channelColors';

  function loadColorOverrides() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(CHANNEL_COLOR_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const id in obj) map.set(id, obj[id]);
      }
    } catch (e) { /* ignore */ }
    return map;
  }

  function saveColorOverrides(map) {
    try {
      const obj = {};
      for (const [id, color] of map) obj[id] = color;
      localStorage.setItem(CHANNEL_COLOR_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  // ── マスター音量 ──────────────────────────────────────────
  // src/audio/stream-player.js MML.Audio.getMasterGain() と同じキー/値域(0〜1)。
  // 音声グラフ側(getMasterGain)も新規AudioContext生成時にこの値を読むため、
  // どちらが先にロードされても一致する。
  const MASTER_VOLUME_STORAGE_KEY = 'mml_masterVolume';
  function loadMasterVolume() {
    try {
      const raw = parseFloat(localStorage.getItem(MASTER_VOLUME_STORAGE_KEY));
      if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
    } catch (e) { /* ignore */ }
    return 1;
  }
  function saveMasterVolume(vol) {
    try { localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, String(vol)); } catch (e) { /* ignore */ }
  }

  // ── ch別音量(通常フォーマット: channelId → 0〜1) ─────────────────
  // 色オーバーライドと同じ流儀(localStorage永続化、新規ファイルを開いても保持=
  // ミュートのようなファイル切替時クリアはしない。音量調整は「一度決めたら
  // ずっと使う」EQ的な設定なので、ファイルをまたいで残ってほしいという想定)。
  const CHANNEL_VOLUME_STORAGE_KEY = 'mml_channelVolumes';
  function loadChannelVolumes() {
    const map = new Map();
    try {
      const raw = localStorage.getItem(CHANNEL_VOLUME_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const id in obj) {
          const v = parseFloat(obj[id]);
          if (Number.isFinite(v)) map.set(id, Math.max(0, Math.min(2, v)));
        }
      }
    } catch (e) { /* ignore */ }
    return map;
  }
  function saveChannelVolumes(map) {
    try {
      const obj = {};
      for (const [id, vol] of map) obj[id] = vol;
      localStorage.setItem(CHANNEL_VOLUME_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  }

  // ── SPCボイス音量(V0〜V7、配列index=ボイス番号) ─────────────────
  const SPC_VOLUME_STORAGE_KEY = 'mml_spcVoiceVolumes';
  function loadSpcVoiceVolumes() {
    try {
      const raw = JSON.parse(localStorage.getItem(SPC_VOLUME_STORAGE_KEY) || 'null');
      if (Array.isArray(raw) && raw.length === 8) {
        return raw.map((v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1; });
      }
    } catch (e) { /* ignore */ }
    return new Array(8).fill(1);
  }
  function saveSpcVoiceVolumes(arr) {
    try { localStorage.setItem(SPC_VOLUME_STORAGE_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }

  // ── 静的ミュートパス定義 ──────────────────────────────────────
  const MUTE_INFO_MAP = {
    P1:   { section: 'apu', key: 'pulse1' },
    P2:   { section: 'apu', key: 'pulse2' },
    TR:   { section: 'apu', key: 'triangle' },
    NO:   { section: 'apu', key: 'noise' },
    DM:   { section: 'apu', key: 'dmc' },
    V6P1: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'pulse1' },
    V6P2: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'pulse2' },
    V6SW: { section: 'expansion', chip: 'vrc6', type: 'object', key: 'saw' },
    FDS:  { section: 'expansion', chip: 'fds',  type: 'object', key: 'wave' },
    M5P1: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pulse1' },
    M5P2: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pulse2' },
    M5PC: { section: 'expansion', chip: 'mmc5', type: 'object', key: 'pcm' },
    GB1:  { section: 'expansion', chip: 'gb', type: 'object', key: 'ch1' },
    GB2:  { section: 'expansion', chip: 'gb', type: 'object', key: 'ch2' },
    GN:   { section: 'expansion', chip: 'gb', type: 'object', key: 'ch4' },
    GW:   { section: 'expansion', chip: 'gb', type: 'object', key: 'ch3' },
    PSG0: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch0' },
    PSG1: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch1' },
    PSG2: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch2' },
    PSG3: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch3' },
    PSG4: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch4' },
    PSG5: { section: 'expansion', chip: 'hes', type: 'object', key: 'ch5' },
  };

  // リズムchのミュート添字。★2026-08-22: 以前は実チャンネル(BD=6, SD/HH=7, TOM/CYM=8)を
  // そのまま使っていたが、SDとHH(およびTOMとCYM)が同じ添字を共有するため
  // getMuteConfig() が行順に config[index] = muted を書く際に**後の行が前の行を上書き**し、
  // 「SDをミュートしても消えず、鳴っていないHHをミュートすると消える」状態になっていた。
  // OPLLコア(opllNuked.js)は打楽器ごとに出力サイクルを識別できるので、5種に独立した
  // 添字(9-13)を与える。0-8はメロディch用なので衝突しない。
  const KF_RHYTHM_INDEX = { KFBD: 9, KFSD: 10, KFTOM: 11, KFCYM: 12, KFHH: 13 };

  function getMuteInfo(id) {
    if (MUTE_INFO_MAP[id]) return MUTE_INFO_MAP[id];
    const vrc7 = id.match(/^VR(\d+)$/);
    if (vrc7) return { section: 'expansion', chip: 'vrc7', type: 'array', index: +vrc7[1] - 1 };
    // N163: 表示 N{k} はハードウェアch (8-k)。N1=$78(ch7), N8=$40(ch0)。
    // chip.mute[] はハードch索引なので index にハードch番号を返す(表示行→muteの対応を一致させる)。
    const n163 = id.match(/^N(\d+)$/);
    if (n163) return { section: 'expansion', chip: 'n163', type: 'array', index: 8 - (+n163[1]) };
    const fme7 = id.match(/^FE(\d+)$/);
    if (fme7) return { section: 'expansion', chip: 'fme7', type: 'array', index: +fme7[1] - 1 };
    // KSS: PSG(KP1-3)/SCC(KS1-5)/FMPAC(KF1-9、リズムモード中はKFBD/KFSD/KFTOM/KFCYM/KFHH)
    const kp = id.match(/^KP(\d+)$/);
    if (kp) return { section: 'expansion', chip: 'psg', type: 'array', index: +kp[1] - 1 };
    const ks = id.match(/^KS(\d+)$/);
    if (ks) return { section: 'expansion', chip: 'scc', type: 'array', index: +ks[1] - 1 };
    const kf = id.match(/^KF(\d+)$/);
    if (kf) return { section: 'expansion', chip: 'opll', type: 'array', index: +kf[1] - 1 };
    // VGM: SN76489(SN1-3=トーン, SNN=ノイズ)。chip.mute[]はトーン0-2,ノイズ3の4要素
    // VGMのデュアルチップ(2個目)はSN4-6/SNN2=index 4-7(vgmPlayer.js側が2個目のch0-3として読む)
    const sn = id.match(/^SN(\d)$/);
    if (sn) return { section: 'expansion', chip: 'sn76489', type: 'array', index: +sn[1] <= 3 ? +sn[1] - 1 : +sn[1] };
    if (id === 'SNN') return { section: 'expansion', chip: 'sn76489', type: 'array', index: 3 };
    if (id === 'SNN2') return { section: 'expansion', chip: 'sn76489', type: 'array', index: 7 };
    // VGM: YM2612(YM1-6=FM ch、YMDA=DAC)。chip.mute[]はFM 0-5、DAC 6
    const ym = id.match(/^YM(\d)$/);
    if (ym) return { section: 'expansion', chip: 'ym2612', type: 'array', index: +ym[1] - 1 };
    if (id === 'YMDA') return { section: 'expansion', chip: 'ym2612', type: 'array', index: 6 };
    // VGM: YM2151(OPM、OM1-8=FM ch)。chip.mute[]はch 0-7
    const om = id.match(/^OM(\d)$/);
    if (om) return { section: 'expansion', chip: 'ym2151', type: 'array', index: +om[1] - 1 };
    // VGM: YM2203(OPN、OP1-3=FM ch、デュアル2個目はOP4-6=index 3-5。vgmPlayer.js側が
    // 2個目のch0-2として読む)。内蔵SSGはKP1-3(KP4-6)行(chip 'psg')を流用
    const op = id.match(/^OP(\d)$/);
    if (op) return { section: 'expansion', chip: 'ym2203fm', type: 'array', index: +op[1] - 1 };
    // VGM: YM2608(OPNA、OA1-6=FM ch)。内蔵リズム(OABD/OASD/OACY/OAHH/OATM/OARM)と
    // ADPCM-B(OAB)は chip.muteAdpcm[] の 0-5 / 6。内蔵SSGはKP1-3行(chip 'psg')を流用
    const OA_RHYTHM = { OABD: 0, OASD: 1, OACY: 2, OAHH: 3, OATM: 4, OARM: 5, OAB: 6 };
    if (OA_RHYTHM[id] !== undefined) return { section: 'expansion', chip: 'ym2608adpcm', type: 'array', index: OA_RHYTHM[id] };
    const oa = id.match(/^OA(\d)$/);
    if (oa) return { section: 'expansion', chip: 'ym2608fm', type: 'array', index: +oa[1] - 1 };
    // OPL系(KSSのMSX-AUDIO / VGMのYM3812・YM3526・Y8950): OL1-9=メロディch、リズム/ADPCMは
    // chip.mute[]の9-14(Emu.OPL_MUTE: BD=9,SD=10,TOM=11,CYM=12,HH=13,ADPCM=14)
    const OL_FIXED = { OLBD: 9, OLSD: 10, OLTM: 11, OLCY: 12, OLHH: 13, OLB: 14 };
    if (OL_FIXED[id] !== undefined) return { section: 'expansion', chip: 'opl', type: 'array', index: OL_FIXED[id] };
    const ol = id.match(/^OL(\d)$/);
    if (ol) return { section: 'expansion', chip: 'opl', type: 'array', index: +ol[1] - 1 };
    // VGM: GA20(Irem PCM、GA1-4)。chip.mute[]はch 0-3(GALLはGB行なので\dで区別される)
    const ga = id.match(/^GA(\d)$/);
    if (ga) return { section: 'expansion', chip: 'ga20', type: 'array', index: +ga[1] - 1 };
    // VGM: K007232(コナミPCM、K71-K72)。chip.mute[]はch 0-1
    const k7 = id.match(/^K7(\d)$/);
    if (k7) return { section: 'expansion', chip: 'k007232', type: 'array', index: +k7[1] - 1 };
    // VGM: K054539(コナミ8ch PCM、K51-K58)。chip.mute[]はch 0-7
    const k5 = id.match(/^K5(\d+)$/);
    if (k5) return { section: 'expansion', chip: 'k054539', type: 'array', index: +k5[1] - 1 };
    // VGM: MSM5205/6585(PC Engine CD ADPCM等、1ch)。chip.mute[]は1要素
    if (id === 'M5') return { section: 'expansion', chip: 'msm5205', type: 'array', index: 0 };
    // VGM: SegaPCM(SP1-16)。chip.mute[]はch 0-15
    const sp = id.match(/^SP(\d+)$/);
    if (sp) return { section: 'expansion', chip: 'segapcm', type: 'array', index: +sp[1] - 1 };
    // VGM: C140(CN1-24)。chip.mute[]はch 0-23
    const cn = id.match(/^CN(\d+)$/);
    if (cn) return { section: 'expansion', chip: 'c140', type: 'array', index: +cn[1] - 1 };
    // VGM: C352(CS1-32)。chip.mute[]はch 0-31
    const cs = id.match(/^CS(\d+)$/);
    if (cs) return { section: 'expansion', chip: 'c352', type: 'array', index: +cs[1] - 1 };
    // PSF: PlayStation SPU(PX1-24 = ボイス0-23)。PsfReplayStreamPlayer.applyMute の配列 index
    const px = id.match(/^PX(\d+)$/);
    if (px) return { section: 'expansion', chip: 'psx', type: 'array', index: +px[1] - 1 };
    // VGM: OKIM6258(X68000 ADPCM、1ch)。chip.mute[]は1要素
    if (id === 'OKI') return { section: 'expansion', chip: 'okim6258', type: 'array', index: 0 };
    // VGM: QSound(QS1-16)。chip.mute[]はch 0-15
    const qs = id.match(/^QS(\d+)$/);
    if (qs) return { section: 'expansion', chip: 'qsound', type: 'array', index: +qs[1] - 1 };
    // VGM: OKIM6295(OK1-4)。chip.mute[]はch 0-3('OKI'=OKIM6258は上の完全一致で先に拾われる)
    const ok = id.match(/^OK(\d)$/);
    if (ok) return { section: 'expansion', chip: 'okim6295', type: 'array', index: +ok[1] - 1 };
    // VGM: MultiPCM(MP1-28)。chip.mute[]はch 0-27('M5P1'等MMC5とは前方不一致)
    const mp = id.match(/^MP(\d+)$/);
    if (mp) return { section: 'expansion', chip: 'multipcm', type: 'array', index: +mp[1] - 1 };
    // VGM: YM2610(Neo Geo) FM(NF1-4)。内蔵SSGはKP1-3行(chip 'psg')を流用し、vgmPlayer.jsの
    // YM2610アダプタが e.psg を自分のSSGへ適用する
    const nf = id.match(/^NF(\d)$/);
    if (nf) return { section: 'expansion', chip: 'ym2610fm', type: 'array', index: +nf[1] - 1 };
    // YM2610 ADPCM-A(NA1-6)/ADPCM-B(NB)。chip.muteAdpcm[]は A=0-5, B=6
    const na = id.match(/^NA(\d)$/);
    if (na) return { section: 'expansion', chip: 'ym2610adpcm', type: 'array', index: +na[1] - 1 };
    if (id === 'NB') return { section: 'expansion', chip: 'ym2610adpcm', type: 'array', index: 6 };
    // VGM: 32X PWM(PWL/PWR)。chip.mute[]は L=0, R=1
    if (id === 'PWL') return { section: 'expansion', chip: 'pwm', type: 'array', index: 0 };
    if (id === 'PWR') return { section: 'expansion', chip: 'pwm', type: 'array', index: 1 };
    // VGM: RF5C164(メガCD PCM、RC1-8) / RF5C68(RB1-8)
    const rc = id.match(/^RC(\d)$/);
    if (rc) return { section: 'expansion', chip: 'rf5c164', type: 'array', index: +rc[1] - 1 };
    const rb = id.match(/^RB(\d)$/);
    if (rb) return { section: 'expansion', chip: 'rf5c68', type: 'array', index: +rb[1] - 1 };
    if (KF_RHYTHM_INDEX[id] !== undefined) return { section: 'expansion', chip: 'opll', type: 'array', index: KF_RHYTHM_INDEX[id] };
    return null;
  }

  // ── チップ名見出し + 短縮ch名 ──────────────────────────────────
  // ch.id(P1/VR3/N5など内部識別子)はチップごとに命名規則がバラバラで一覧性が
  // 低いため、表示上はチップ名を見出し行として挟み、行側は見出し配下で完結する
  // 短い名前(P1/FM3/W5など)にする。ch.id自体は変更しない(ミュート状態のキー・
  // getPartLetterのパターンマッチ・大波形選択などが全てch.id前提のため)。
  // 完全一致(ids)を先に見て、無ければ前方一致(prefix)にフォールバックする
  // (例: 'NO'は2A03グループの完全一致で先に拾われ、N163のprefix:'N'とは衝突しない)。
  const CHANNEL_DISPLAY_GROUPS = [
    { header: 'RP2A03 (Family Computer / Nintendo Entertainment System)', ids: { P1: 'P1', P2: 'P2', TR: 'Tri', NO: 'No', DM: 'DPCM' } },
    { header: 'RP2C33 (Family Computer Disk System)', ids: { FDS: 'FDS' } },
    { header: 'VRC6 (Virtual Rom Controller 6)', ids: { V6P1: 'P1', V6P2: 'P2', V6SW: 'Saw' } },
    { header: 'VRC7 (Virtual Rom Controller 7)', prefix: 'VR', name: (id) => 'FM' + id.slice(2) },
    { header: 'N163 (Namco 163)', prefix: 'N', name: (id) => 'W' + id.slice(1) },
    { header: 'SUNSOFT5B (FME-7 , YM2149)', ids: { FE1: 'P1', FE2: 'P2', FE3: 'P3' } },
    { header: 'MMC5 (Memory Management Controller 5)', ids: { M5P1: 'P1', M5P2: 'P2', M5PC: 'PCM' } },
    { header: 'YM2149 (Software controlled Sound Generator)', ids: { KP1: 'P1', KP2: 'P2', KP3: 'P3', KP4: 'P1(2)', KP5: 'P2(2)', KP6: 'P3(2)' } },
    { header: 'SCC (Sound Creative Chip)', prefix: 'KS', name: (id) => 'W' + id.slice(2) },
    { header: 'YM2413 (MSX-MUSIC , OPLL)', ids: { KFBD: 'BD', KFSD: 'SD', KFTOM: 'Tom', KFCYM: 'Cym', KFHH: 'HH' }, prefix: 'KF', name: (id) => 'FM' + id.slice(2) },
    { header: 'LR35902 (Game Boy)', ids: { GALL: 'ALL', GB1: 'P1', GB2: 'P2', GN: 'No', GW: 'Wave' } },
    { header: 'HuC6280(PC Engine / TurboGrafx-16)', ids: { HALL: 'ALL', PSG0: 'Ch0', PSG1: 'Ch1', PSG2: 'Ch2', PSG3: 'Ch3', PSG4: 'Ch4', PSG5: 'Ch5' } },
    { header: 'SN76489 (SG-1000 / Master System / Game Gear / Mega Drive PSG)', ids: { SN1: 'P1', SN2: 'P2', SN3: 'P3', SNN: 'No', SN4: 'P1(2)', SN5: 'P2(2)', SN6: 'P3(2)', SNN2: 'No(2)' } },
    { header: 'YM2612 (OPN2 , Mega Drive FM)', ids: { YMDA: 'DAC' }, prefix: 'YM', name: (id) => 'FM' + id.slice(2) },
    { header: 'YM2151 (OPM , X68000 / Arcade)', prefix: 'OM', name: (id) => 'FM' + id.slice(2) },
    // OP4-6はデュアルチップ2個目のFM1-3(内蔵SSGはKP1-6行を流用)
    { header: 'YM2203 (OPN , PC-8801 / Arcade)', prefix: 'OP', name: (id) => { const n = +id.slice(2); return n <= 3 ? 'FM' + n : 'FM' + (n - 3) + '(2)'; } },
    // OABD等=内蔵リズム、OAB=ADPCM-B(完全一致で先に拾う)。内蔵SSGはKP1-3行を流用
    { header: 'YM2608 (OPNA , PC-8801 SB2 / PC-9801)', ids: { OABD: 'BD', OASD: 'SD', OACY: 'Cym', OAHH: 'HH', OATM: 'Tom', OARM: 'Rim', OAB: 'PCMB' },
      prefix: 'OA', name: (id) => 'FM' + id.slice(2) },
    // OPL系(YM3812/YM3526/Y8950): OLBD等=リズムモード打楽器、OLB=Y8950 ADPCM-B
    { header: 'OPL (YM3812 / YM3526 / Y8950 MSX-AUDIO)', ids: { OLBD: 'BD', OLSD: 'SD', OLTM: 'Tom', OLCY: 'Cym', OLHH: 'HH', OLB: 'ADPCM' },
      prefix: 'OL', name: (id) => 'FM' + id.slice(2) },
    // GA1-4は完全一致(ids)で拾う(GBの'GALL'と prefix 'GA' を衝突させない)
    { header: 'GA20 (Irem M92 / M107 PCM)', ids: { GA1: 'PCM1', GA2: 'PCM2', GA3: 'PCM3', GA4: 'PCM4' } },
    // pool: サンプルPCM系はドライバがスロットをペア交互/巡回割当する曲がある
    // (実測: SegaPCM 8-23%移動 / C140 37-100% / C352 74-79% / QSound 8-63% / MultiPCM 100%)。
    // ヘッダに「合成ch/実機スロット」トグルを出し、割当逆算した表示・変換と選べるようにする
    { header: 'SegaPCM (315-5218 , OutRun / After Burner)', prefix: 'SP', name: (id) => 'PCM' + id.slice(2), pool: 'segapcm' },
    { header: 'C140 (Namco System 2 / 21)', prefix: 'CN', name: (id) => 'PCM' + id.slice(2), pool: 'c140' },
    { header: 'C352 (Namco System 11 / 12 / 22)', prefix: 'CS', name: (id) => 'PCM' + id.slice(2), pool: 'c352' },
    { header: 'OKIM6258 (MSM6258 , Sharp X68000)', ids: { OKI: 'ADPCM' } },
    // PSF(PS1): ボイス番号は実機どおり0始まりで表示(PX1=Voice0)。ドライバがボイスを動的に割り当てるので pool
    // poolModes: 表示モード切替の段(既定は2段 logical/phys)。PSF はドライバ内部トラック単位の「トラック」を先頭に足す
    { header: 'SPU (CXD2922 , PlayStation)', prefix: 'PX', name: (id) => 'V' + (+id.slice(2) - 1), pool: 'psx', poolModes: ['track', 'logical', 'phys'] },
    { header: 'QSound (DL-1425 , Capcom CPS2)', prefix: 'QS', name: (id) => 'PCM' + id.slice(2), pool: 'qsound' },
    // ★prefix 'OK' は 'OKI'(OKIM6258)にも前方一致するが、完全一致(ids)が全グループ横断で
    //   先に評価されるので衝突しない(getChannelDisplayの2段ループ参照)
    { header: 'OKIM6295 (MSM6295 , Toaplan / Raizing etc.)', prefix: 'OK', name: (id) => 'ADPCM' + id.slice(2) },
    // pool: チャンネルプール式(ドライバがボイスを巡回割当する)チップの印。ヘッダ行に
    // 「実機スロット/合成ch」の表示モード切替を出す(_rebuildRows参照)
    { header: 'MultiPCM (315-5560 , Sega Model 1 / 2)', prefix: 'MP', name: (id) => 'PCM' + id.slice(2), pool: 'multipcm' },
    // NF1-4は完全一致(ids)で先に拾う(N163のprefix 'N' と衝突させない)
    { header: 'YM2610 (OPNB , Neo Geo)', ids: { NF1: 'FM1', NF2: 'FM2', NF3: 'FM3', NF4: 'FM4', NF5: 'FM5', NF6: 'FM6',
        NA1: 'PCMA1', NA2: 'PCMA2', NA3: 'PCMA3', NA4: 'PCMA4', NA5: 'PCMA5', NA6: 'PCMA6', NB: 'PCMB' } }, // NA=ADPCM-A, NB=ADPCM-B
    { header: 'PWM (Sega 32X)', ids: { PWL: 'L', PWR: 'R' } },
    { header: 'RF5C164 (Mega-CD PCM)', prefix: 'RC', name: (id) => 'PCM' + id.slice(2) },
    { header: 'RF5C68 (PCM)', prefix: 'RB', name: (id) => 'PCM' + id.slice(2) },
  ];
  function getChannelDisplay(id) {
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.ids && g.ids[id]) return { header: g.header, name: g.ids[id], pool: g.pool };
    }
    for (const g of CHANNEL_DISPLAY_GROUPS) {
      if (g.prefix && id.startsWith(g.prefix)) return { header: g.header, name: g.name(id), pool: g.pool, poolModes: g.poolModes };
    }
    return { header: '', name: id };
  }

  // ── MMLパート文字(A-Z,a,b)の算出 ──────────────────────────────
  // 実際のMML変換(nsf2mml/kss2mml)が振るチャンネル文字を鍵盤表示にも出す。
  // 2A03固定4ch=A-D、DPCM=E(未使用でも常にこのスロット)、拡張音源以降は
  // src/mml/compiler.jsのassignExpansionLettersで機種に関わらず完全固定。
  // GB1/GB2/GNは2A03コア(自チップ、拡張音源宣言不要)を借用するのでA/B/Dに固定
  // (src/gbs2mml/converter.js参照。GBのCH1/CH2/CH4はそのままNESパルス1/2/ノイズへ乗る)。
  // SN76489(VGM)のノイズchも2A03ノイズ(D)へ借用する(vgm2mml、ROADMAP VGM節 段階3)。
  const APU_PART_LETTER = { P1: 'A', P2: 'B', TR: 'C', NO: 'D', DM: 'E', GB1: 'A', GB2: 'B', GN: 'D', SNN: 'D' };

  // chips(内部chip名の配列)をassignExpansionLettersが受け取る拡張音源名に変換する。
  // KSSはPSG→FME-7・SCC→N163・FMPAC→VRC7、GBSは波形ch→FDS(実機較正済みの音量バランスを
  // 持つため、当初のN163から変更した。src/gbs2mml/expansion/wave.js冒頭コメント参照)を
  // 借用して再生するため(src/kss2mml/converter.js・src/gbs2mml/converter.js参照)、
  // レター体系もそれらをそのまま流用する。
  const BORROWED_CHIP_TO_EXPANSION = { kssPsg: 'fme7', kssScc: 'n163', kssOpll: 'vrc7', gbs: 'fds', hes: 'n163', sn76489: 'fme7' };
  function chipsToExpansions(chips) {
    const priority = MML.Mml && MML.Mml.EXPANSION_PRIORITY;
    const set = new Set();
    for (const c of chips) {
      const exp = BORROWED_CHIP_TO_EXPANSION[c] || c;
      if (priority && priority.includes(exp)) set.add(exp);
    }
    return Array.from(set);
  }

  // チャンネル割当(変換元ch → NSF側の借用先パート)の共通モジュール。読み込み順の都合で
  // 未定義でも鍵盤表示は動く(その場合はpart列が従来どおりの固定表示になるだけ)。
  function channelPlan() { return (MML.Convert && MML.Convert.ChannelPlan) || null; }
  // 今の表示元がMML再生か(setSourceInfo経由)。MML側に切り替えている間はチャンネル割当も
  // 「割当先の音で聴く」も意味が無いので、両方まとめて無効にする(ユーザー指定 2026-09-06)。
  // ★ChannelPlan.setFormat は MML では呼ばれず直前のサウンドファイルの形式が残るため、
  //   plan.editable() だけで判定すると MML 再生に割当プレビューのミュートが掛かって無音になる
  //   (実際に起きた: VGMで🎧をONにした後のMML再生が全chミュート)。
  let sourceIsMml = false;
  function assignEditable() {
    const plan = channelPlan();
    return !!plan && plan.editable() && !sourceIsMml;
  }
  function assignLockReason() {
    if (sourceIsMml) return T('MML再生中はチャンネル割当と「割当先の音で聴く」は使えません(サウンドファイルの再生時だけ意味があります)');
    const plan = channelPlan();
    return plan ? (plan.lockReason() || '') : '';
  }

  // part列(丸の隣のパート文字)。クリックで1行ぶんの割当ポップオーバーを開けるチップにする。
  // 割当を変更できないフォーマット(NSF等)では従来どおりただの文字表示のまま。
  function partChipHtml(ch) {
    const editable = assignEditable() && !ch.isAllRow && ch.target !== undefined;
    const cls = 'kbd-part' + (editable ? ' kbd-part--editable' : '');
    return `<span class="${cls}" data-ch="${ch.id || ''}">${ch.letter || (editable ? '—' : '')}</span>`;
  }

  // 見出しの part 列に置くチャンネル割当トグル(案E)。ONで一覧に「借用先/音色」列が生える。
  // 「part」という文字の代わりにアイコンだけを置く(列の意味そのものがボタンになっている)。
  function headerAssignBtnHtml() {
    return `<button type="button" class="kbd-h-part kbd-assign-btn"` +
      ` aria-label="${T('チャンネル割当(変換元ch → NSF側のパート)を表示')}">` +
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 6h5M3 14h5"/><path d="M12 6h5M12 14h5"/><path d="M8 6c2.5 0 1.5 8 4 8"/><path d="M8 14c2.5 0 1.5-8 4-8"/></svg></button>';
  }
  // 見出しの「借用先」列に置く「割当先の音で聴く」トグル(src/audio/assign-preview.js)。
  // ONで元chをミュートし、借用先のNSF音源で鳴らし直す(変換後の音色を再生中に確かめる)。
  function headerPreviewBtnHtml() {
    return `<button type="button" class="kbd-preview-btn" aria-label="${T('割当先の音で聴く')}">\u{1F3A7}</button>`;
  }
  // 試聴ボタンの右に出す、割当表示ONの間だけのモード表示(ユーザー指示 2026-09-12)。
  // 置き場は借用先列(230px)の余白の中なので、列幅も行との縦揃えも変わらない
  function headerAssignModeHtml() {
    return `<span class="kbd-h-assign-mode">${T('チャンネル別割り当てモード')}</span>`;
  }
  // 見出しの mute 列に置く一括ミュートボタン。全chミュートでなければ全ミュート、
  // 全ミュート済みなら全解除(トグル)。
  function headerMuteAllBtnHtml() {
    return `<button type="button" class="kbd-h-mute-solo kbd-muteall-btn" aria-label="${T('全チャンネルをミュート')}">\u{1F507}</button>`;
  }
  // 見出しの vol 列に置く一括音量リセットボタン。押すと全chの音量スライダーを100%へ戻す
  // (行ごとのダブルクリックでの100%復帰と同じ動作を全chまとめて行う)。
  function headerVolResetBtnHtml() {
    return `<button type="button" class="kbd-h-vol kbd-volreset-btn" title="${T('全チャンネルの音量を100%に戻す')}">vol</button>`;
  }

  // 割当表示ONのときだけ現れる「借用先 / 音色」のセレクト2つ(案Eの列展開)
  function assignCellHtml(ch) {
    if (ch.isAllRow) return `<span class="kbd-assign"></span>`;
    return `<span class="kbd-assign">` +
      `<select class="kbd-assign-target"></select>` +
      `<select class="kbd-assign-tone"></select>` +
      // 借用先にDPCMを選んだ行だけ出す「パッド」ボタン(ドラム(DPCM)パネルを開く)。
      // ツールバーではなくここに置く: DPCMを選んだ流れでそのまま詰められるため
      `<button type="button" class="kbd-assign-drum" style="display:none">${T('パッド')}</button>` +
      // 音色が1つしかない借用先(三角波/のこぎり波/FME-7)に出す注記。空欄だと「未設定」に見えるため
      `<i class="kbd-assign-plain" style="display:none"></i>` +
      // 音色一覧(音色ごとの載せ先/音色)を開くボタン。指定がある行は件数を出す(_syncAssignSelects)
      `<button type="button" class="kbd-assign-tones" style="display:none">♪</button>` +
      `</span>`;
  }

  // ch.id → MMLパート文字。letterMapはassignExpansionLettersの戻り値
  // ({ チップ名: [割当文字...] })。該当なし(対応するMML文字を持たないチャンネル、
  // 例: MMC5の$5011直接PCM)は空文字を返す。
  function getPartLetter(id, letterMap, n163NumCh) {
    if (APU_PART_LETTER[id]) return APU_PART_LETTER[id];
    const lm = letterMap || {};
    let m;
    if (id === 'FDS') return (lm.fds || [])[0] || '';
    if ((m = id.match(/^V6(P1|P2|SW)$/))) return (lm.vrc6 || [])[{ P1: 0, P2: 1, SW: 2 }[m[1]]] || '';
    if ((m = id.match(/^M5(P1|P2)$/))) return (lm.mmc5 || [])[{ P1: 0, P2: 1 }[m[1]]] || '';
    if (id === 'M5PC') return ''; // $5011直接PCMはppmckのMML文字を持たない
    if ((m = id.match(/^VR(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^FE(\d+)$/))) return (lm.fme7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^N(\d+)$/))) {
      // 表示N{k}はハードウェアch(8-k)。MML文字は下位アドレス側(ch0)から順に振られる
      // (src/nsf2mml/expansion/n163.js参照)ため、曲全体の有効ch数numChに対し文字indexはnumCh-k。
      // numChは静的なletterMap.n163.length(常に8)ではなく、実際にこの曲で使われているch数
      // (extractChannelsのnumRows、呼び出し側から渡される)を使う必要がある。
      const letters = lm.n163 || [];
      const numCh = n163NumCh || letters.length || 8;
      return letters[numCh - (+m[1])] || '';
    }
    if ((m = id.match(/^KP(\d+)$/))) return (lm.fme7 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^SN(\d)$/))) return (lm.fme7 || [])[+m[1] - 1] || ''; // SN76489トーン3本→FME7(vgm2mml)
    if ((m = id.match(/^KS(\d+)$/))) return (lm.n163 || [])[+m[1] - 1] || '';
    if ((m = id.match(/^KF(\d+)$/))) return (lm.vrc7 || [])[+m[1] - 1] || '';
    if (id === 'GW') return (lm.fds || [])[0] || ''; // GBの波形chはFDS(1ch)を借用(src/gbs2mml/converter.js参照)
    // HESのPSG ch0-5はN163へ直接(反転無し)の順で借用する(src/hes2mml/converter.js参照。
    // N163実機のアドレッシングに基づく反転(上のKS/N163ケース)とは異なる独自の割当規則)。
    if ((m = id.match(/^PSG(\d)$/))) return (lm.n163 || [])[+m[1]] || '';
    if (KF_RHYTHM_INDEX[id] !== undefined) return (lm.vrc7 || [])[KF_RHYTHM_INDEX[id]] || '';
    return '';
  }

  // ── 周波数 / MIDI 変換 ────────────────────────────────────────

  // 基準ピッチ(#TUNING、セント)。MML再生(setSource の result.tuningCents)と変換結果の音程検証
  // (buildRollTracksFromRegSnapshotsPure の extra.tuningCents)が設定する。実ファイル再生は0
  let rollTuningCents = 0;
  function freqToMidi(f) {
    if (!f || f <= 0) return null;
    const m = Math.round(69 + 12 * Math.log2(f / 440) - rollTuningCents / 100);
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
  }

  // ノイズchの周期index(ch.noiseIndex、0〜15。NSF/GBSどちらも同じ2A03の16段階スケールへ
  // 揃えている)を、そのままC1(MIDI 24)〜D#2(MIDI 39)の16音に1:1対応させる(ユーザー指定)。
  function noisePeriodIndexToMidi(idx) {
    if (idx === undefined || idx === null) return null;
    return 24 + Math.max(0, Math.min(15, idx)); // idx0=C1 〜 idx15=D#2
  }

  // DPCM($4010再生速度index、ch.dmcRateIdx、0〜15)もノイズと同じC1〜D#2に1:1対応させる
  // (ユーザー指定: ノイズchとバンドが重なってよい)。
  function dmcRateIndexToMidi(idx) {
    if (idx === undefined || idx === null) return null;
    return 24 + Math.max(0, Math.min(15, idx)); // idx0=C1 〜 idx15=D#2(ノイズと同じ)
  }

  // YM2610 ADPCM-A/B(ch.adpcmPitch、NA/NB行)の音程。
  //  - ch.adpcmExact: ym2610.js のサンプルピッチ解析(ROM上のサンプルをデコードして基本周期を検出)
  //    ×再生レートの実周波数が ch.freq に入っているので通常の freqToMidi。
  //  - それ以外(ADPCM-Bで解析が信頼できない時): Delta-Nは連続値の再生レートだが、実際の音程は
  //    元サンプルの収録内容に依存し絶対音名を保証するレジスタは無い。同チップのADPCM-A固定レート
  //    (refRate=chip.sampleRate/3)を基準ピッチ(C4=MIDI60)とみなしレートの比を半音数へ変換する
  //    (目安。ピッチベンド等の相対的な上下動は正しく追従する)。
  // 解析の信頼度しきい値(pitchConf、0-1: 窓ごとの検出周期が中央値±3%で一致した割合)
  const ADPCM_PITCH_CONF = 0.5;

  // PSF トラックモードのレーン(Emu.PsfTrackVoicer の出力。各要素に lane={index, group, track, voice, groupIndex})の
  // 並び順と行名。ロール構築は全フレームぶん呼ぶので、レーン数とレーン表(最後の lane の同一性)が同じなら使い回す。
  // 並び: トラックの分かった順(トラック番号)→ トラック不明の疑似トラック(出現順)、同じトラック内は声部順
  let psxTrackOrderCache = null;
  function psxTrackOrder(s) {
    const n = s.length, last = s[n - 1].lane;
    // 複製の印(lane.copyOf)は後から付くので、付け替えのたびに上がる版数も鍵に入れる
    // 言語を切り替えたら説明文(title)も作り直す
    const copyKey = ((MML.Emu && MML.Emu.PsfTrackVoicer && MML.Emu.PsfTrackVoicer.copyVersion) || 0) + ':' + (MML.I18n ? MML.I18n.getLang() : '');
    if (psxTrackOrderCache && psxTrackOrderCache.n === n && psxTrackOrderCache.last === last && psxTrackOrderCache.copyKey === copyKey) return psxTrackOrderCache;
    const lanes = s.map(c => c.lane);
    const voices = new Map();
    for (const l of lanes) voices.set(l.group, (voices.get(l.group) || 0) + 1);
    // 並び順: 元トラックの番号 → その声部 → その複製。複製は元トラック名(T8 等)から番号を引く
    const numOf = (l) => {
      if (l.copyOf) {
        const num = parseInt(l.copyOf.slice(1), 10);
        if (isFinite(num)) return (l.copyOf[0] === 'T' ? 0 : 100000) + num;
      }
      return l.track >= 0 ? l.track : 100000 + l.groupIndex;
    };
    const rank = (l) => numOf(l) * 1000 + (l.copyOf ? 500 : 0) + l.voice;
    const hueNum = lanes.map(numOf);
    const order = lanes.map((l, i) => i).sort((a, b) => rank(lanes[a]) - rank(lanes[b]));
    const name = MML.Emu && MML.Emu.PsfTrackVoicer ? MML.Emu.PsfTrackVoicer.laneName : (l) => String(l.index);
    // 行名の列は狭い(32px)ので、複製は「T9≈」とだけ出し、何の複製かは行名の説明(title)に出す
    const label = lanes.map(l => name(l, voices.get(l.group)) + (l.copyOf ? '≈' : ''));
    // ロールの区画(rollLanes='perChannel')は「ドライバのトラック1本=1区画」。和音の声部は同じ区画へ重ね、
    // 複製(デチューン二重化/エコー)は元トラックの区画へ点線で重ねる
    const group = lanes.map(l => l.copyOf || name(l, 1));
    const copy = lanes.map(l => !!l.copyOf);
    // (Worker のロール構築には翻訳辞書が無いので、そこでは説明を作らない)
    const title = lanes.map(l => l.copyOf && MML.I18n ? T('{name} は {of} の複製(デチューン二重化/エコー)', { name: name(l, voices.get(l.group)), of: l.copyOf }) : '');
    psxTrackOrderCache = { n, last, copyKey, order, label, title, group, copy, hueNum };
    return psxTrackOrderCache;
  }

  // サンプルPCM系チップ(GA20/SegaPCM/C140/C352/QSound/MultiPCM/OKIM6295/YM2610 ADPCM-A)の
  // 「ピッチ解析が信頼できなかった」行の共通形。音階演奏していない=打楽器/効果音なので、
  // ロールでは音程軸ではなくドラム区画(音程鍵盤より低音側のレーン群)へ置く。
  //  drumKey: どの太鼓かの同定キー。ドラム区画のレーンはこのキー単位で割り当てる。
  //           sample.start はサンプルROM上の開始アドレスで、同じ音なら曲中ずっと同じ値になる
  //           (vgm2mml/expansion/opn.js が既にリトリガー判定のキーに使っているのと同じ考え方)。
  //           サンプル同定情報を持たないチップ(OKIM6258/PWM/RF5C68/164 = ROMもアドレスも無い
  //           ストリーミングDAC)ではnullになり、従来どおり dmcRateIdx 経由の疑似音程に落ちる。
  //  drumSeq: キーオン通番。同じ太鼓を連打したとき区間が1本に融合しないよう区切りに使う。
  function pcmSampleRow(c) {
    return {
      sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
      drumKey: c.sample ? (c.sample.kind + ':' + c.sample.start) : null,
      drumSeq: c.seq || 0,
    };
  }
  function adpcmPitchToMidi(ch) {
    if (ch.adpcmExact) return ch.freq > 0 ? freqToMidi(ch.freq) : null;
    const rateHz = ch.freq, refRate = ch.adpcmRefRate;
    if (!rateHz || rateHz <= 0 || !refRate) return null;
    const m = Math.round(60 + 12 * Math.log2(rateHz / refRate));
    return (m >= MIDI_MIN && m <= MIDI_MAX) ? m : null;
  }

  // セント偏差オーバーレイ(DESIGN-PITCH.md Phase 0)用。丸め後のMIDIノート番号の
  // 理論周波数からのズレをセントで返す(detune.jsの cents=1200*log2(raw/ideal) と同じ式)。
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // セント偏差オーバーレイの線色をノート帯の色に合わせて自動で切り替えるための輝度計算。
  // チャンネル色はhex('#66ddff')/hsl(...)/ユーザーのカラーピッカー選択色など形式が混在するため、
  // 自前でパースせず1x1canvasにfillして実際に描画されるRGBを読み戻す(どんな形式でも
  // ブラウザ自身のCSS色パーサーに任せられる)。同じ色文字列を毎フレーム読み戻すのは
  // 無駄なのでキャッシュする(色は基本的にユーザーが変更した時だけ変わる)。
  const _lumCache = new Map();
  let _lumProbeCtx = null;
  function relativeLuminance(colorStr) {
    if (_lumCache.has(colorStr)) return _lumCache.get(colorStr);
    if (!_lumProbeCtx) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      _lumProbeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    _lumProbeCtx.fillStyle = colorStr;
    _lumProbeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b] = _lumProbeCtx.getImageData(0, 0, 1, 1).data;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    _lumCache.set(colorStr, lum);
    return lum;
  }
  // 明るい帯(輝度0.55超)には暗い線、暗い帯には白い線を重ねてコントラストを確保する。
  // ★暗い線側は純黒(0,0,0)にすると、偏差が帯からはみ出てロール背景(#14141a、
  // 輝度8%程度とほぼ黒)に重なった瞬間アルファ合成の結果もほぼ黒のまま=見えなくなる
  // (黒を黒に重ねてもアルファ値に関わらず黒のまま、という合成の性質による)。
  // ★中間グレーへ変更したところ、白鍵境界のグリッド線(#3d3d4a、無彩色の青灰色)と
  // 色味が近く紛らわしいとの指摘。無彩色同士の衝突を避けるため彩度のある暖色(赤系)にする。
  // 黄色/橙は明るい帯の既定色候補(黄色いチャンネル色等)と被って見えにくくなりうるため避け、
  // 赤系(色相環上で黄色から離れている)を選ぶ。
  function overlayLineColor(bgColorStr) {
    return relativeLuminance(bgColorStr) > 0.55 ? 'rgba(214,69,65,0.9)' : 'rgba(255,255,255,0.85)';
  }

  function midiToName(m) {
    return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  }
  // 鍵盤の描画範囲(C1〜C8)の外でも音名を返す(note列の表示用)。以前は範囲外を '??' にしていたが、
  // OPMのキャリアMUL0.5のベース(21Hz=E0付近)やMUL3の高音(8kHz=B8)は実在の音程なので、
  // 「何の音か分からない」より音名(範囲外は色を落として区別)の方が読める(2026-09-07)
  function freqToMidiAny(f) {
    if (!f || f <= 0) return null;
    const m = Math.round(69 + 12 * Math.log2(f / 440) - rollTuningCents / 100);
    return (m >= 0 && m <= 127) ? m : null;
  }

  // ── APU 2A03 周波数計算 ───────────────────────────────────────

  function pulseFreq(lo, hi3) {
    const p = lo | ((hi3 & 7) << 8);
    return p >= 8 ? CPU_CLOCK / (16 * (p + 1)) : 0;
  }

  function pulseVol(reg0) {
    return (reg0 & 0x10) ? (reg0 & 0xF) / 15 : ((reg0 & 0xF) > 0 ? 1 : 0);
  }

  function pulseActive(reg0) {
    if (reg0 & 0x10) return (reg0 & 0xF) > 0;
    return true;
  }

  // NESの非線形 tnd ミキサー近似 (apu2a03.js の mixSample() と同じ式)。
  // triangle/noise/dmc は単純加算ではなくこの共有ミキサーを通るため、
  // 一方の出力レベルが上がるともう一方の相対的な聞こえ方が変化する。
  function tndOut(tri, noi, dmc) {
    const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
    return tndSum > 0 ? 159.79 / (1 / tndSum + 100) : 0;
  }

  // ── 見かけ音量(tnd非線形ミキサーの干渉) ──────────────────────────
  // ある1chの「実際の寄与」= そのchを鳴らした時と消した時の出力差。他chの出力が上がるほど小さくなる。
  // ★非線形なので「他chの平均値を1回だけ式に入れる」やり方では合わない。他chが取りうる各状態で
  //   寄与を出し、その出現比で平均する必要がある(Jensenの不等式)。各chの状態の動き方:
  //     ノイズ … LFSRで 0 と level を往復する(実測デューティ0.518。ここでは1/2として扱う)
  //     三角波 … 32段シーケンサで 0〜15 を往復する(消音中も最後の値をDCとして保持する)
  //     DPCM  … その瞬間のDAC値そのもの(往復しないのでそのまま入れる)
  //   APUを実際に回して三角波の寄与振幅を測った実測との比較(ノイズ15/DPCM0):
  //     実測 0.920 / 状態を平均する今の式 0.900 / 平均値を1回入れる旧式 0.807
  // シーケンサ位置(0〜31) → 出力レベル(0〜15)。apu2a03.js の TRIANGLE_SEQ と同じ対応
  const TRIANGLE_SEQ_LEVEL = (seq) => (seq & 31) < 16 ? 15 - (seq & 31) : (seq & 31) - 16;
  const TRI_FULL = tndOut(15, 0, 0);   // 三角波が単独で鳴っている時の寄与
  const NOISE_FULL = tndOut(0, 15, 0); // ノイズが単独で最大レベルで鳴っている時の寄与

  /**
   * 三角波の実際の寄与(0〜1)。1 = 干渉なし。
   * @param {number} noiseLevel 実際に聞こえているノイズのレベル(消音中は0を渡すこと)
   * @param {number} dmcLevel   DPCMの現在のDAC値(0〜127)
   */
  function triApparent(noiseLevel, dmcLevel) {
    const off = tndOut(15, 0, dmcLevel) - tndOut(0, 0, dmcLevel);
    if (!(noiseLevel > 0)) return TRI_FULL > 0 ? Math.max(0, Math.min(1, off / TRI_FULL)) : 1;
    const on = tndOut(15, noiseLevel, dmcLevel) - tndOut(0, noiseLevel, dmcLevel);
    return Math.max(0, Math.min(1, ((on + off) / 2) / TRI_FULL));
  }

  /**
   * ノイズの実際の寄与(0〜1)。1 = 単独で最大レベル。レベル自体の低さも含んだ絶対値。
   * @param {number} noiseLevel ノイズのエンベロープ出力(0〜15)
   * @param {?number} triSeq    三角波のシーケンサ値(0〜15)。不明ならnull=0〜15の平均で代表する
   * @param {number} dmcLevel   DPCMの現在のDAC値(0〜127)
   */
  function noiseApparent(noiseLevel, triSeq, dmcLevel) {
    if (!(noiseLevel > 0)) return 0;
    let sum = 0, n = 0;
    if (triSeq === null || triSeq === undefined) {
      for (let v = 0; v <= 15; v++) { sum += tndOut(v, noiseLevel, dmcLevel) - tndOut(v, 0, dmcLevel); n++; }
    } else {
      sum = tndOut(triSeq, noiseLevel, dmcLevel) - tndOut(triSeq, 0, dmcLevel); n = 1;
    }
    return Math.max(0, Math.min(1, (sum / n) / NOISE_FULL));
  }

  // 見かけ音量の表示文字列。音量数値欄は20px=10pxフォントで3文字ぶんしかないため、
  // 1未満は先頭の0を落として ".98" の3文字にし、1に丸まる時だけ "1.0" とする。
  function apparentStr(r) {
    if (!(r >= 0)) return null;
    if (r >= 0.995) return "1.0";
    return "." + String(Math.round(r * 100)).padStart(2, "0");
  }

  // 干渉源の名前(ツールチップの{src}に入る)。maskBy の値がそのままキー
  const MASK_SRC = {
    // ★「原文|文脈」形式。"三角波"等は波形名/チャンネル名として既にen.jsにあり、素のキーだと衝突して既存の訳を壊す(実測で重複を検出)
    noise: "ノイズ|干渉源", dpcm: "DPCM($4011)|干渉源", noisedpcm: "ノイズとDPCM($4011)|干渉源",
    tri: "三角波|干渉源", tridpcm: "三角波とDPCM($4011)|干渉源",
  };
  // 三角波は音量レジスタが無いので数値そのものが比率。ノイズは数値がレジスタ値なので言い方を変える
  const MASK_TIP_RATIO = "{src}と同じDACを共有しているため音量が下がっています(表示は実際に鳴っている割合)";
  const MASK_TIP_REG = "{src}と同じDACを共有しているため、実際の音量はこのレジスタ値より下がっています";


  // ── チャンネル状態抽出 ────────────────────────────────────────

  function extractChannels(snap, extraSnaps, frameIdx, chips) {
    const channels = [];
    let n163NumRows = null; // MMLパート文字算出用(N163のnumChはgetPartLetterのフォールバックでは分からない)
    snap = snap || {};
    const status = snap[0x4015] || 0;
    // このフレームのAPUエンベロープ実出力。ライブ関数優先→静的配列→無ければレジスタ直読みにフォールバック。
    let apuEnv = null;
    if (extraSnaps) {
      if (extraSnaps.apuEnvLive) apuEnv = extraSnaps.apuEnvLive();
      if (!apuEnv && extraSnaps.apuEnv) apuEnv = extraSnaps.apuEnv[frameIdx];
    }

    // KSS(MSX)/GBS(Game Boy)/HES(PC Engine)再生中はNES内蔵チャンネル(2A03)を表示しない
    // (KSSはPSG/SCC/FMPACのみ、GBSはGB1/GB2/GN/GWのみ、HESはPSG0-5のみを表示する)。
    const isKss = chips.includes('kss');
    const isGbs = chips.includes('gbs');
    const isHes = chips.includes('hes');
    // VGMはヘッダで使うチップが決まる: NES APUを含まないVGM(MSX/GB/PCE系)では2A03行を出さない
    // (main.js側が chips に 'vgm' と、NES APU使用時のみ 'nes' を入れる)。
    const isVgmNoNes = chips.includes('vgm') && !chips.includes('nes');
    if (!isKss && !isGbs && !isHes && !isVgmNoNes) {
    // 2A03パルスのスイープユニット強制ミュート(emulator apu2a03.js PulseChannel.isMuted /
    // nsf2mml converter.js extractPulseEventsと同じ規則): 周期<8 または目標周期>$7FF
    // (特に$4001/$4005=$00のまま周期$400以上=o2a以下)は実際には鳴らないので非アクティブ表示
    const pulseSweepMuted = (sweepReg, period, isPulse1) => {
      const change = period >> (sweepReg & 7);
      const target = (sweepReg & 8) ? period - change - (isPulse1 ? 1 : 0) : period + change;
      return period < 8 || target > 0x7FF;
    };
    // ライブAPU状態(apuEnv)があるときは、レジスタ値では分からない実状態を優先する:
    //  ・period … スイープユニットが書き換えた実周期(レジスタは書いた瞬間の値のまま止まって
    //     見えるため、これが無いとスイープの上昇/下降が表示に一切出ない)
    //  ・muted … スイープ強制ミュート(上のpulseSweepMutedと同じ判定を実機側で行った結果)
    //  ・len … 長さカウンタ。halt=0の短い打楽器的な音は次の書込みを待たず自然消音する
    // (2026-08-19、FamicomBox「Game Select」。nsf2mml/converter.js側の同名シミュレーションと
    //  同じ情報で、ロール表示と変換MMLが食い違わないようにする)
    const pulseChannelState = (e, regPeriod, sweepReg, isPulse1) => {
      const period = (e && e.period != null) ? e.period : regPeriod;
      const muted = (e && e.muted !== undefined) ? e.muted : pulseSweepMuted(sweepReg, period, isPulse1);
      const lenOk = (e && e.len !== undefined) ? e.len > 0 : true;
      return { freq: period >= 8 ? CPU_CLOCK / (16 * (period + 1)) : 0, muted, lenOk };
    };
    // APU Pulse 1
    {
      const r = snap[0x4000] || 0;
      const regPeriod = (snap[0x4002] || 0) | (((snap[0x4003] || 0) & 7) << 8);
      const e = apuEnv ? apuEnv.pulse1 : null;
      const { freq, muted, lenOk } = pulseChannelState(e, regPeriod, snap[0x4001] || 0, true);
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P1', color: '#ff4466', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false, duty: (r >> 6) & 3,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 1) && pulseActive(r) && freq > 0 && !muted && lenOk });
    }
    // APU Pulse 2
    {
      const r = snap[0x4004] || 0;
      const regPeriod = (snap[0x4006] || 0) | (((snap[0x4007] || 0) & 7) << 8);
      const e = apuEnv ? apuEnv.pulse2 : null;
      const { freq, muted, lenOk } = pulseChannelState(e, regPeriod, snap[0x4005] || 0, false);
      const rv = e ? e.level : (r & 0xF);
      channels.push({ id: 'P2', color: '#ff8800', freq, vol: e ? e.level / 15 : pulseVol(r), rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false, duty: (r >> 6) & 3,
        wave: { t: 'pulse', hi: APU_DUTY[(r >> 6) & 3], nx: 8, ny: 2 },
        active: !!(status & 2) && pulseActive(r) && freq > 0 && !muted && lenOk });
    }
    // Triangleの「見かけ音量」計算に使う Noise/DMC の現在値を先読みしておく
    // (NOブロック・DMブロックでも同じ値を使い回す)。
    const noiseRegPre = snap[0x400C] || 0;
    const eNoisePre = apuEnv ? apuEnv.noise : null;
    const noiseLevelPre = eNoisePre ? eNoisePre.level : (noiseRegPre & 0xF);
    // ★干渉源になるのは「実際に音が出ているノイズ」だけ。$4015で無効、または長さカウンタが0の
    //   ノイズはレベル値がレジスタに残っていても出力0で、三角波は一切減衰しない
    //   (APUを回した実測でも減衰0。以前はレジスタ値だけを見て無音のノイズでも減衰表示していた)
    const noiseAudiblePre = !!(status & 8) && noiseLevelPre > 0 &&
      (!eNoisePre || eNoisePre.len === undefined || eNoisePre.len > 0);
    const noiseMaskPre = noiseAudiblePre ? noiseLevelPre : 0;
    // 三角波は消音中も最後のシーケンサ値をDCとして保持し、そのDCもtndミキサーに効く
    const triSeqPre = (apuEnv && apuEnv.triangle && apuEnv.triangle.seq !== undefined)
      ? TRIANGLE_SEQ_LEVEL(apuEnv.triangle.seq) : null;
    const dmcRegPre = (snap[0x4011] || 0) & 0x7F; // $4011 レジスタ値（直接書き込み検出用）
    const dmcPre = apuEnv ? apuEnv.dmc : null;
    const dmcLevelPre = (dmcPre && dmcPre.level !== undefined) ? dmcPre.level : dmcRegPre;

    // APU Triangle
    // 音量レジスタが無いチャンネルなので、普段は音量数値を出さない(空欄)。
    // ノイズ/DPCMと共有する非線形tndミキサーの干渉で実際の寄与が下がっている時だけ、
    // その割合を ".98" の形で黄色表示する(レジスタ値ではないと分かる書き方にしてある)。
    {
      const lo = snap[0x400A] || 0, hi = snap[0x400B] || 0;
      const p = lo | ((hi & 7) << 8);
      const freq = p >= 4 ? CPU_CLOCK / (32 * (p + 1)) : 0;
      const ratio = triApparent(noiseMaskPre, dmcLevelPre);
      const masked = ratio < 0.995;
      const maskBy = !masked ? null
        : (noiseMaskPre > 0 && dmcLevelPre > 0) ? "noisedpcm" : (dmcLevelPre > 0 ? "dpcm" : "noise");
      channels.push({ id: "TR", color: "#00cc44", freq, vol: ratio,
        rawVol: masked ? apparentStr(ratio) : null, rawVolMax: 1,
        envMode: false, maskBy, maskTip: MASK_TIP_RATIO,
        wave: { t: "tri", nx: 32, ny: 16 },
        // 三角波は長さカウンタ/線形カウンタのどちらかが0になると消音する(レジスタ値は
        // 変わらないためライブ状態が無いと判定できない。nsf2mml側のtriangleAudibleFrames相当)
        active: !!(status & 4) && freq > 0 &&
          (!apuEnv || !apuEnv.triangle || (apuEnv.triangle.len > 0 && apuEnv.triangle.linear > 0)) });
    }

    // APU Noise
    {
      // $400E bit7=1 で短周期(93step)、0で長周期(32767step)。bit0-3 は周期テーブルのインデックス
      const noiseReg = snap[0x400E] || 0;
      const noiseShort = !!(noiseReg & 0x80);
      const noiseIndex = noiseReg & 0x0F;
      const e = eNoisePre;
      const rv = noiseLevelPre;
      const noiseFreq = CPU_CLOCK / NOISE_PERIOD[noiseIndex]; // LFSRシフトレート
      const triAudible = !!(status & 4) &&
        (!apuEnv || !apuEnv.triangle || (apuEnv.triangle.len > 0 && apuEnv.triangle.linear > 0));
      // ★三角波は鳴っている間 0〜15 を往復する。1フレームの瞬間値をそのまま使うと
      //   フレームごとに 0〜15 へばらつき、ノイズのバーが毎フレーム暴れる。鳴っている間は
      //   「0〜15の平均」で代表させ(null)、消音して値が固定されている時だけ保持値を使う。
      const triMaskSeq = triAudible ? null : triSeqPre;
      const triMasks = triAudible || (triSeqPre !== null && triSeqPre > 0);
      const noiseRatio = noiseApparent(rv, triMaskSeq, dmcLevelPre);
      const noiseMaskBy = (rv > 0 && (triMasks || dmcLevelPre > 0))
        ? ((triMasks && dmcLevelPre > 0) ? 'tridpcm' : (dmcLevelPre > 0 ? 'dpcm' : 'tri')) : null;
      // ★vol は「レジスタどおりの大きさ」のままにする。ピアノロールがこれを音の濃さに使っており、
      //   ロールはMML変換の突き合わせ用(MMLに載るのはレジスタ値)なので、干渉ぶんを混ぜると
      //   一定音量のドラムが濃淡バラバラに見えて変換バグと紛らわしくなる。
      //   干渉を含んだ「実際に聞こえる大きさ」は volApparent に分け、鍵盤表示の音量バーだけが使う。
      channels.push({ id: "NO", color: "#888888", freq: 0, vol: e ? e.level / 15 : pulseVol(noiseRegPre),
        volApparent: noiseRatio, rawVol: rv, rawVolMax: 15,
        envMode: e ? e.env : false, maskBy: noiseMaskBy, maskTip: MASK_TIP_REG,
        wave: { t: 'noise', short: noiseShort, nx: noiseShort ? 93 : 32767, ny: 2 },
        active: !!(status & 8) && pulseActive(noiseRegPre) && (!e || e.len === undefined || e.len > 0),
        noise: true, noiseShort, noiseIndex, noiseFreq });
    }
    // APU DMC
    {
      const dv = dmcRegPre;
      const dmcRateIdx = (snap[0x4010] || 0) & 0x0F;
      const dmcFreq = CPU_CLOCK / DMC_RATE[dmcRateIdx]; // DPCM再生周波数
      // DPCMサンプルをデルタ復号した波形（apuEnv.dmc 経由）。無ければ "固有波形なし" 扱い。
      const dmc = dmcPre;
      // ★音量数値/バーは「DACの現在値」ではなく「直近1フレームのDAC振幅(0〜127)」を使う。
      //   現在値は波形の位置でしかなく音量にならない(実測: SMB3のスネアが減衰しても現在値は
      //   中央値46のまま。振幅は 94→68→42→28→16→10 と減衰をそのまま描く)。
      //   振幅が取れない経路(キャプチャ済みログにampが無い等)だけ従来どおり現在値に落とす。
      const level = (dmcPre && dmcPre.amp !== undefined) ? dmcPre.amp : dmcLevelPre;
      const wave = (dmc && dmc.len > 0)
        ? { t: 'wave', data: dmc.samples, nx: dmc.len * 8, ny: 128, sig: dmc.addr + ':' + dmc.len, pcm: true }
        : { t: 'sample', nx: 0, ny: 0 };
      // dmcDirect: $4011 直接書込み(生PCM)の検出対象はこの行だけ(update()参照)
      // drumKey/drumSeq(2026-09-03): サンプル(アドレス+長さ)が分かるときはロールをレート
      // 疑似音程ではなくドラム区画(1サンプル=1レーン)へ。VGMのサンプルPCM行と同じ形。
      // キーは nsf2mml/converter.js dmcHits と同じ 'dmc:<addr>:<len>'
      // APUエンベロープが無い経路(キャプチャWorkerのロール構築)では $4012/$4013 のレジスタ値から
      // 同じキーを組む。通番は extraSnaps.dmcSeq(writeLogの$4015 bit4書込みの累計。nsf2mml
      // extractDmcTriggers と同じ数え方)から取る
      const regLen = snap[0x4013];
      const regKey = (regLen !== undefined) ? ('dmc:' + (0xC000 + (snap[0x4012] || 0) * 64) + ':' + (regLen * 16 + 1)) : null;
      const dmcKey = (dmc && dmc.len > 0) ? ('dmc:' + dmc.addr + ':' + dmc.len) : regKey;
      const dmcSeq = (dmc && dmc.seq) ? dmc.seq
        : ((extraSnaps && extraSnaps.dmcSeq && extraSnaps.dmcSeq[frameIdx]) || 0);
      // 発声中か: $4015 bit4(最後に書かれた値)だけでは鳴り終わりが分からない。ライブ経路は
      // APUの実状態(bytesRemaining/bitsRemaining)、履歴経路は buildDmcTimeline が $4013 の長さと
      // $4010 のレート/ループから求めた終了フレームで切る
      const dmcPlaying = (dmc && dmc.playing !== undefined) ? dmc.playing
        : ((extraSnaps && extraSnaps.dmcEnd) ? frameIdx < extraSnaps.dmcEnd[frameIdx] : true);
      channels.push({ id: 'DM', color: '#aa44ff', freq: 0, vol: level / 127, rawVol: level, rawVolMax: 127,
        wave, active: !!(status & 0x10) && dmcPlaying, sample: true, dmcRateIdx, dmcFreq, dmcReg: dv, dmcDirect: true,
        drumKey: dmcKey, drumSeq: dmcSeq });
    }
    } // !isKss && !isGbs

    if (chips.includes('fds')) {
      const lo = snap[0x4082] || 0, hi = snap[0x4083] || 0;
      const f12 = lo | ((hi & 0xF) << 8);
      const disabled = !!(hi & 0x80);
      // $4080: bit7=1で直接ゲイン, bit7=0でエンベロープ(減衰)。実ゲイン(volGain 0-32)を優先し、
      // 無ければレジスタ直読み(直接ゲイン時のみ正しい)にフォールバック。
      // 実効ゲインは32で頭打ち(v33-63を書いても32相当、src/emulator/expansion/fds.js mixSample)
      // なのでバーは32=100%固定。以前はレジスタ直読みフォールバック時だけ/63にしていたため
      // 同じ音量でもライブ時と半分の長さに見えていた(2026-08-24)
      const fe = apuEnv ? apuEnv.fds : null;
      const gain = fe ? fe.gain : ((snap[0x4080] || 0) & 0x3F);
      const gainMax = 32;
      const vol = Math.min(1, gain / gainMax);
      const freq = (!disabled && f12 > 0) ? f12 * CPU_CLOCK / (64 * 65536) : 0;
      // 波形メモリ $4040-$407F (6bit, 0-63) を -1..1 に正規化
      const fdsWave = new Array(64);
      for (let i = 0; i < 64; i++) fdsWave[i] = ((snap[0x4040 + i] || 0) & 0x3F) / 31.5 - 1;
      // $4087 bit7=0 でピッチモジュレーションユニットが有効(MH<n>使用中)。
      // 実機は明示的に$4087 bit7=1で停止するまで有効なままなので、gain(=$4084)が
      // 0でもここは別途チェックする(MHOF時は両方0/1になる。src/mml/compiler.jsの
      // resolveFdsModWriteを参照)。fe(apuEnv.fds)があれば実インスタンスの実状態
      // (既定false)を使う。$4087が曲中一度も書かれない場合、生レジスタスナップショットは
      // 未定義→0扱いになりbit7=0=有効に誤検出してしまう(MH<n>を全く使っていないのに
      // 鍵盤表示が常時ON扱いになるバグの原因だった)ため、レジスタ直読みは
      // feが取れない場合のフォールバックに留める
      const modActive = fe ? !!fe.modEnabled : !((snap[0x4087] || 0) & 0x80);
      // 実際に揺れている実ピッチ(Hz)。fe.effectiveFreq(src/emulator/expansion/fds.js
      // clock()で計算済み)はfreqと同じ内部単位(f12と同スケール)なので同じ式でHz換算する。
      // note(音名)は表示のちらつきを避けるため変調前のfreqのまま据え置き、freq列の
      // 数値表示だけをこちらに差し替える(モジュレーション無効時はfreqと同じ値になる)
      const modFreq = (fe && modActive && !disabled) ? fe.effectiveFreq * CPU_CLOCK / (64 * 65536) : freq;
      channels.push({ id: 'FDS', color: '#ff88aa', freq, modFreq, vol, rawVol: gain, rawVolMax: gainMax,
        envMode: fe ? fe.env : false, modActive,
        wave: { t: 'wave', data: fdsWave, nx: 64, ny: 64 },
        active: !disabled && vol > 0 && freq > 0 });
    }

    if (chips.includes('vrc6')) {
      for (const [id, color, b0, blo, bhi, div] of [
        ['V6P1', '#00ccff', 0x9000, 0x9001, 0x9002, 16],
        ['V6P2', '#0088ff', 0xA000, 0xA001, 0xA002, 16],
      ]) {
        const ctrl = snap[b0] || 0, lo = snap[blo] || 0, hi = snap[bhi] || 0;
        const period = lo | ((hi & 0xF) << 8);
        const en = !!(hi & 0x80);
        const rv = ctrl & 0xF;
        const vol = rv / 15;
        const duty = (ctrl >> 4) & 7; // VRC6 は High 区間 = (duty+1)/16
        const freq = (en && period > 0) ? CPU_CLOCK / (div * (period + 1)) : 0;
        channels.push({ id, color, freq, vol, rawVol: rv, rawVolMax: 15, duty,
          wave: { t: 'pulse', hi: (duty + 1) / 16, nx: 16, ny: 2 },
          active: en && vol > 0 && freq > 0 });
      }
      {
        const ctrl = snap[0xB000] || 0, lo = snap[0xB001] || 0, hi = snap[0xB002] || 0;
        const period = lo | ((hi & 0xF) << 8);
        const en = !!(hi & 0x80);
        const rv = ctrl & 0x3F;
        const vol = Math.min(1, rv / 42);
        const freq = (en && period > 0) ? CPU_CLOCK / (14 * (period + 1)) : 0;
        // 波形表示にも蓄積レートを渡す(43以上は実機の8bit桁溢れで鋸波が崩れる。waveSampleValue参照)
        channels.push({ id: 'V6SW', color: '#00ffcc', freq, vol, rawVol: rv, rawVolMax: 42,
          wave: { t: 'saw', nx: 7, ny: 32, rate: rv },
          active: en && rv > 0 && freq > 0 });
      }
    }

    if (chips.includes('vrc7')) {
      // リアルタイムはライブVRC7(実FM波形付き)、事前キャプチャは writeLog由来。
      const live = extraSnaps && extraSnaps.vrc7Live;
      const snaps = live ? live() : (extraSnaps && extraSnaps.vrc7 ? extraSnaps.vrc7[frameIdx] : null);
      const COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc'];
      for (let ch = 0; ch < 6; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false, rawVol: 15 };
        // VRC7: rawVol は 0=最大, 15=無音 なので内部値をそのまま表示
        // FM合成波形があれば波形表示、無ければFMアイコン
        // VRC7はFM=連続波形なので smooth:true で線形補間(階段でなく曲線)表示
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `VR${ch+1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave, active: c.active, fmPatch: c.patch || null });
      }
    }

    if (chips.includes('n163')) {
      // リアルタイム再生はライブN163関数、事前キャプチャは writeLog 由来の配列。
      const live = extraSnaps && extraSnaps.n163Live;
      const arr = extraSnaps && extraSnaps.n163;
      let snaps, numRows;
      if (live) {
        snaps = live(); // { channels, numCh, maxNumCh }
        numRows = snaps ? (snaps.maxNumCh || snaps.numCh || 1) : 1;
      } else {
        snaps = arr ? arr[frameIdx] : null;
        // 行数は曲全体の最大numChで固定（frame0=1chに縛られない・行が増減しない）
        numRows = (arr && arr.maxNumCh) ? arr.maxNumCh : 1;
      }
      n163NumRows = numRows;
      // 表示順は下位アドレス側(MML文字の若い方)を上段にするため i を降順で積む
      // (id自体はN{i+1}=ハードch(8-(i+1))のまま。getMuteInfo等の対応関係は変えない)。
      for (let i = numRows - 1; i >= 0; i--) {
        const c = snaps ? snaps.channels[i] : { freq: 0, vol: 0, active: false };
        const hue = (180 + i * 25) % 360;
        channels.push({ id: `N${i+1}`, color: `hsl(${hue},80%,60%)`, freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: { t: 'wave', data: c.waveData || [0, 0], nx: (c.waveData ? c.waveData.length : 0), ny: 16 },
          active: c.active });
      }
    }

    if (chips.includes('fme7')) {
      // リアルタイムはライブFME7関数(ラッチ式で復元不可)、事前キャプチャは writeLog由来配列。
      const live = extraSnaps && extraSnaps.fme7Live;
      const snaps = live ? live() : (extraSnaps && extraSnaps.fme7 ? extraSnaps.fme7[frameIdx] : null);
      const COLS = ['#88ff44','#55dd22','#33bb00'];
      for (let ch = 0; ch < 3; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        channels.push({ id: `FE${ch+1}`, color: COLS[ch], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          // ノイズ有効chはノイズ波形、それ以外は50%矩形波
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active });
      }
    }

    if (chips.includes('mmc5')) {
      // リアルタイムはライブMMC5(エンベロープ実出力・PCM反映)、事前キャプチャはレジスタ値。
      const ls = extraSnaps && extraSnaps.mmc5Live ? extraSnaps.mmc5Live() : null;
      const mst = snap[0x5015] || 0;
      for (const [i, base, bit] of [[0, 0x5000, 1], [1, 0x5004, 2]]) {
        const r = snap[base] || 0;
        let c;
        if (ls) {
          c = i === 0 ? ls.pulse1 : ls.pulse2;
        } else {
          const freq = pulseFreq(snap[base + 2] || 0, snap[base + 3] || 0);
          c = { freq, vol: pulseVol(r), rawVol: r & 0xF, duty: (r >> 6) & 3,
                active: !!(mst & bit) && pulseActive(r) && freq > 0 };
        }
        channels.push({ id: i === 0 ? 'M5P1' : 'M5P2',
          color: i === 0 ? '#ff6655' : '#ffaa44', freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          duty: c.duty !== undefined ? c.duty : ((r >> 6) & 3),
          wave: { t: 'pulse', hi: APU_DUTY[c.duty !== undefined ? c.duty : ((r >> 6) & 3)], nx: 8, ny: 2 },
          active: c.active });
      }
      // $5011 生PCM チャンネル
      const pcm = ls ? ls.pcm : { level: snap[0x5011] || 0, vol: (snap[0x5011] || 0) / 255, active: (snap[0x5011] || 0) > 0 };
      channels.push({ id: 'M5PC', color: '#ff4488', freq: 0, vol: pcm.vol, rawVol: pcm.level, rawVolMax: 255,
        wave: { t: 'sample' }, active: pcm.active });
    }

    if (chips.includes('kssPsg')) {
      // PSG(AY-3-8910): 2A03のFME-7表示と同じ考え方(50%矩形波固定、noise有効chはノイズ波形)。
      const live = extraSnaps && extraSnaps.kssPsgLive;
      const snaps = live ? live() : null;
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      // VGMのデュアルAY8910(2個目)はスナップショットが6要素で返るのでKP4-6行も出す
      const nKp = snaps && snaps.length > 3 ? snaps.length : 3;
      for (let ch = 0; ch < nKp; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        // ★2026-08-22: ノイズ専用ch(トーン無効 or トーン周期0でノイズだけ鳴らす打楽器)は
        // SN76489/GBSのノイズ行と同じ扱いにして、note列に周期indexを出す。
        // 従来は波形アイコンだけノイズにしていたため、note列が空のままで何のchか読めなかった。
        const noiseRow = { id: `KP${ch + 1}`, color: COLS[ch % 3], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: c.noise ? { t: 'noise', short: false, nx: 32767, ny: 2 } : { t: 'pulse', hi: 0.5, nx: 2, ny: 2 },
          active: c.active };
        if (c.noiseOnly) {
          noiseRow.noise = true;
          noiseRow.noiseFreq = c.noiseFreq;
          noiseRow.noiseIndex = gbNoiseFreqToIndex(c.noiseFreq);
          noiseRow.noiseShort = false;
          noiseRow.freq = 0; // 音程は持たない(古いトーン周期の残骸を出さない)
        }
        channels.push(noiseRow);
      }
    }

    if (chips.includes('kssScc')) {
      // SCC: N163と同じ波形メモリ音源(要素数のみ異なる: SCCは32点符号付き8bit)。
      const live = extraSnaps && extraSnaps.kssSccLive;
      const snaps = live ? live() : null;
      for (let ch = 0; ch < 5; ch++) {
        const c = snaps ? snaps[ch] : { freq: 0, vol: 0, active: false };
        const hue = (280 + ch * 20) % 360;
        channels.push({ id: `KS${ch + 1}`, color: `hsl(${hue},80%,60%)`, freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave: { t: 'wave', data: c.waveData || [0, 0], nx: (c.waveData ? c.waveData.length : 0), ny: 32 },
          active: c.active });
      }
    }

    if (chips.includes('kssOpll')) {
      // FMPAC(YM2413): VRC7と同じFM表示だが、9メロディモードとリズムモード(6melody+BD/SD/TOM/CYM/HH)
      // の両方に対応する(VRC7ハードウェアにはリズムモードが存在しないため6ch固定だった)。
      const live = extraSnaps && extraSnaps.kssOpllLive;
      const snap2 = live ? live() : null;
      // ★2026-08-22: リズムモード(レジスタ$0E bit5)は「打つ瞬間だけ立てて即降ろす」ドライバが
      // 実在する(SMS版After Burnerは毎秒10〜16回トグル)。生ビットに追随すると9ch表示と
      // 6ch+リズム表示が激しく入れ替わって読めないため、**一度でも見たら以後は保持する**
      // 単調な運用にする(SCC行を出したら消さないのと同じ考え方)。フラグはextraSnapsに
      // 持たせているのでsetSource()の this._extraSnaps = {} で曲ごとにリセットされる。
      if (snap2 && snap2.rhythmMode && extraSnaps) extraSnaps.opllRhythmSeen = true;
      const opllRhythm = !!(extraSnaps && extraSnaps.opllRhythmSeen);
      const melody = snap2 ? snap2.melody : [];
      const MCOLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      for (let ch = 0; ch < (opllRhythm ? 6 : (melody.length || 9)); ch++) {
        const c = melody[ch] || { freq: 0, vol: 0, active: false, rawVol: 15 };
        const wave = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `KF${ch + 1}`, color: MCOLS[ch % MCOLS.length], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol !== undefined ? c.rawVol : null, rawVolMax: 15,
          wave, active: c.active, fmPatch: c.patch || null });
      }
      if (opllRhythm && snap2 && snap2.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        // ★ロールと同じ規則で音程を決める(ここを変えたら src/kss2mml/expansion/opll.js の
        // RHYTHM_DEFS / extractRhythmEvents も必ず同じに直すこと。両者がずれると
        // 「ロールと鍵盤で音符が違う」状態になる)。
        //   BD(ch6)/TOM(ch8) … fnum/blockの実音程を持つので、描画範囲(MIDI_MIN以上)なら実音程
        //   それ以外(音程なし=SD/CYM/HH、または実音程が低すぎて範囲外) … 疑似音程 index
        //     (ロールは midi = 24 + index に置く。鍵盤は noiseIndex 経由で同じキーになる)
        const RPSEUDO = { bd: 0, sd: 2, tom: 4, cym: 6, hh: 8 };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          const r = snap2.rhythm[key];
          const realMidi = freqToMidi(r.freq); // 範囲外はnullが返る
          const row = { id: `KF${RLABEL[key]}`, color: RCOLS[key], freq: realMidi !== null ? r.freq : 0, vol: r.vol,
            rawVol: null, rawVolMax: null,
            wave: realMidi !== null ? { t: 'pulse', hi: 0.5, nx: 2, ny: 2 } : { t: 'noise', short: true, nx: 93, ny: 2 },
            active: r.active, drum: true };
          if (realMidi === null) {
            row.noise = true;
            row.noiseIndex = RPSEUDO[key];
            row.noiseShort = true;
            row.noiseLabel = RLABEL[key]; // note列は周期indexでなく打楽器名を出す
          }
          channels.push(row);
        }
      }
    }

    if (chips.includes('sn76489')) {
      // SN76489(VGM: SMS/GG/SG-1000/MD PSG): 矩形3本(50%固定)+ノイズ1ch。ライブ関数優先、
      // 無ければ先読みスナップショット配列(extraSnaps.sn[frameIdx]、ロール構築用)。
      // L/R列はGame Gearのステレオレジスタ(他機種では常に1/1)。
      const live = extraSnaps && extraSnaps.snLive;
      const sAll = live ? live() : (extraSnaps && extraSnaps.sn ? extraSnaps.sn[frameIdx] : null);
      const COLS = ['#66ddff', '#33aaff', '#0077dd'];
      // デュアルチップ(2個目)はスナップショットが8要素(4+4)で返る: 2組目はSN4-6/SNN2行
      const nGroups = sAll && sAll.length >= 8 ? 2 : 1;
      for (let g = 0; g < nGroups; g++) {
      const s = sAll ? sAll.slice(g * 4, g * 4 + 4) : null;
      for (let ch = 0; ch < 3; ch++) {
        const c = s ? s[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1 };
        channels.push({ id: `SN${g * 3 + ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'pulse', hi: 0.5, nx: 2, ny: 2 }, active: c.active, panL: c.panL, panR: c.panR });
      }
      {
        const c = s ? s[3] : { freq: 0, vol: 0, rawVol: 0, active: false, white: true, noiseFreq: 0, panL: 1, panR: 1 };
        // 周期性ノイズ(white=false)は短周期の繰り返し=2A03の短周期ノイズ表示に寄せる。
        // note列はシフトレートを2A03ノイズ16周期の最寄りindexに写像(GBのGN行と同じ考え方)。
        channels.push({ id: g === 0 ? 'SNN' : 'SNN2', color: '#888888', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave: { t: 'noise', short: !c.white, nx: c.white ? 65535 : 16, ny: 2 },
          active: c.active, noise: true, noiseIndex: gbNoiseFreqToIndex(c.noiseFreq), noiseFreq: c.noiseFreq, noiseShort: !c.white,
          panL: c.panL, panR: c.panR });
      }
      }
    }

    if (chips.includes('ym2612')) {
      // YM2612(VGM: メガドライブ): 4op FM×6ch(VRC7/OPLL行と同じFM波形表示)+DAC行。ライブ関数
      // 優先、無ければ先読みスナップショット配列(extraSnaps.ym2612[frameIdx]、ロール構築用)。
      const live = extraSnaps && extraSnaps.ymLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2612 ? extraSnaps.ym2612[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      for (let ch = 0; ch < 6; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `YM${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
      {
        const d = s ? s.dac : { enabled: false, level: 0, vol: 0, active: false };
        channels.push({ id: 'YMDA', color: '#aa44ff', freq: 0, vol: d.vol, rawVol: d.enabled ? d.level : null, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!d.active, sample: true, dmcReg: d.level, dmcRateIdx: 15, dmcFreq: 0 });
      }
    }

    if (chips.includes('ym2608fm')) {
      // YM2608(VGM: OPNA、PC-88 SB2/PC-98): 4op FM×6ch(YM2612と同じFM波形表示)+
      // 内蔵リズム6行(BD/SD/Cym/HH/Tom/Rim。固定サンプルなので音程なしの「サンプル」行)+
      // ADPCM-B行(NB行と同じ3段階表示)。内蔵SSGは 'kssPsg' のKP1-3行として別途出す。
      const live = extraSnaps && extraSnaps.ym2608FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2608fm ? extraSnaps.ym2608fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffd422', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa'];
      for (let ch = 0; ch < 6; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OA${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
      // 内蔵リズム: NA行と同じデータ形状(ロール/ドラム区画/パッド流用)。ピッチ解析は
      // ドラム音なので通常conf<0.5=「サンプル」行のまま。リズムROM未読込でもキーオンは
      // 見えるので行は光る(音は出ない)。
      const RIDS = ['OABD', 'OASD', 'OACY', 'OAHH', 'OATM', 'OARM'];
      const adpcmWave8 = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 6; ch++) {
        const c = s && s.adpcmA ? s.adpcmA[ch] : { vol: 0, rawVol: 0, rawVolMax: 31, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (20 + ch * 12) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: RIDS[ch], color: `hsl(${hue},80%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave: adpcmWave8(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
      {
        const c = s && s.adpcmB ? s.adpcmB : { vol: 0, rawVol: 0, rawVolMax: 255, active: false, panL: 1, panR: 1, rate: 0, refRate: 1, pitchHz: 0, pitchConf: 0 };
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'OAB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: adpcmWave8(c), active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          panL: c.panL, panR: c.panR });
      }
    }

    if (chips.includes('opl')) {
      // OPL系(VGM: YM3812/YM3526/Y8950、KSS: MSX-AUDIO): 2op FM×9ch、またはリズムモード
      // (6メロディ+BD/SD/TOM/CYM/HH)。表示流儀はkssOpll(FMPAC)と同じで、リズムモードは
      // 一度見たら以後保持する単調運用(extraSnaps.oplRhythmSeen)。
      const live = extraSnaps && extraSnaps.oplLive;
      const s = live ? live() : null;
      if (s && s.rhythm && s.rhythm.on && extraSnaps) extraSnaps.oplRhythmSeen = true;
      const oplRhythm = !!(extraSnaps && extraSnaps.oplRhythmSeen);
      const MCOLS = ['#66ffcc', '#55eebb', '#44ddaa', '#33cc99', '#22bb88', '#11aa77', '#66e0d0', '#55d0c0', '#44c0b0'];
      for (let ch = 0; ch < (oplRhythm ? 6 : 9); ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, waveData: null };
        // 波形列はOPN/OPM行と同じく実際の合成波形(opl.js snapshotOPL の waveData。波形選択WS/
        // 接続/帰還込み)。無い時だけ汎用FMアイコン
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OL${ch + 1}`, color: MCOLS[ch % MCOLS.length], freq: c.freq, vol: c.vol,
          rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, fmPatch: c.patch || null });
      }
      if (oplRhythm) {
        // ★ロール(src/kss2mml/expansion/opl.js RHYTHM_DEFS)と同じ規則で音程を決める:
        //   BD(ch6)/TOM(ch8)は実音程(範囲内なら)、SD/CYM/HHは疑似音程レーン
        const r = (s && s.rhythm) || null;
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RIDS = { bd: 'OLBD', sd: 'OLSD', tom: 'OLTM', cym: 'OLCY', hh: 'OLHH' };
        const RPSEUDO = { bd: 0, sd: 2, tom: 4, cym: 6, hh: 8 };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          const d = r ? r[key] : { keyOn: false, active: false, vol: 0, freq: 0 };
          const realMidi = freqToMidi(d.freq);
          const row = { id: RIDS[key], color: RCOLS[key], freq: realMidi !== null ? d.freq : 0, vol: d.vol,
            rawVol: null, rawVolMax: null,
            wave: realMidi !== null ? { t: 'pulse', hi: 0.5, nx: 2, ny: 2 } : { t: 'noise', short: true, nx: 93, ny: 2 },
            active: d.active, drum: true };
          if (realMidi === null) { row.noise = true; row.noiseIndex = RPSEUDO[key]; row.noiseShort = true; row.noiseLabel = RLABEL[key]; }
          channels.push(row);
        }
      }
      // Y8950 ADPCM-B行(NB/OAB行と同じ3段階表示。スナップショットが持つ時だけ)
      if (s && s.adpcmB) {
        const c = s.adpcmB;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'OLB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' },
          active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          panL: 1, panR: 1 });
      }
    }

    if (chips.includes('ym2203fm')) {
      // YM2203(VGM: OPN、PC-88/PC-98/アーケード): 4op FM×3ch(YM2612と同じFM波形表示)。
      // 内蔵SSGは 'kssPsg' のKP1-3行として別途出す(main.js vgmKeyboardChips)。デュアルチップは
      // ライブスナップショットが6ch(3+3)で返り、OP4-6/KP4-6行が2個目になる。
      const live = extraSnaps && extraSnaps.ym2203FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2203fm ? extraSnaps.ym2203fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      const nFm = s && s.channels ? s.channels.length : 3;
      for (let ch = 0; ch < nFm; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OP${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
    }

    if (chips.includes('ym2151')) {
      // YM2151(VGM: OPM、X68000/アーケード): 4op FM×8ch(YM2612と同じFM波形表示)。
      // ch8はノイズモード(c.noise)がありうるが表示は通常のFM行(ノイズ中はfreq=0で無音符扱い)。
      const live = extraSnaps && extraSnaps.ym2151Live;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2151 ? extraSnaps.ym2151[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffd422', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff6bb', '#fff8cc'];
      for (let ch = 0; ch < 8; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `OM${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
    }

    if (chips.includes('ga20')) {
      // GA20(VGM: アイレムM92/M107 PCM): 4ch 8bit PCM。YM2610 ADPCM行(NA/NB)と同じ3段階表示:
      // サンプルピッチ解析(ga20.js samplePitch=Emu.SamplePitchUtil共有)が信頼できれば
      // 実周波数×再生レートの通常音名(adpcmExact)、できなければ「サンプル」行。
      // GA20はレートレジスタで1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // note列クリックの手動キャリブレーション(adpcmSample)もNA/NB行と共通(main.js onAdpcmCalibrate)。
      const live = extraSnaps && extraSnaps.ga20Live;
      const s = live ? live() : (extraSnaps && extraSnaps.ga20 ? extraSnaps.ga20[frameIdx] : null);
      const gaWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 4; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (170 + ch * 14) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `GA${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: gaWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('k007232')) {
      // K007232(VGM: コナミ・アーケードPCM): 2ch 7bit PCM。GA1-4行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、できなければ「サンプル」行)。ピッチレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列はch毎の左右音量レジスタ(0-255)を0-1へ正規化した値(片側0=完全に振り切り)。
      const live = extraSnaps && extraSnaps.k007232Live;
      const s = live ? live() : (extraSnaps && extraSnaps.k007232 ? extraSnaps.k007232[frameIdx] : null);
      const kWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 2; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (285 + ch * 20) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `K7${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: kWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('k054539')) {
      // K054539(VGM: コナミ・アーケード8ch PCM): GA1-4行と同じ3段階表示(ピッチ解析が
      // 信頼できれば絶対音名、できなければ「サンプル」行)。24bitのピッチレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列は定パワーのパン表(pantab)を 0-1 で出した値。8bit PCM / 16bit PCM / 4bit DPCM が混在する。
      const live = extraSnaps && extraSnaps.k054539Live;
      const s = live ? live() : (extraSnaps && extraSnaps.k054539 ? extraSnaps.k054539[frameIdx] : null);
      const kWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      // デュアルチップはスナップショットが16要素(8+8)で返る。2組目は K59-K516 行
      const nCh = s && s.length >= 16 ? 16 : 8;
      for (let ch = 0; ch < nCh; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (25 + ch * 16) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `K5${ch + 1}`, color: `hsl(${hue},75%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: kWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('msm5205')) {
      // MSM5205/6585(VGM: PC Engine CD ADPCM等): 1chストリーミングADPCM。ROMも音程レジスタも
      // 無く、さらにPC EngineのVGMはDACストリームではなく 0x32 の直書きなので、サンプルの
      // 同定キー(=波形アイコン)も取れない。OKI行と同じ「サンプル」行(音量=現在振幅)。
      const live = extraSnaps && extraSnaps.msm5205Live;
      const s = live ? live() : (extraSnaps && extraSnaps.msm5205 ? extraSnaps.msm5205[frameIdx] : null);
      const c = s ? s[0] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0 };
      channels.push({ id: 'M5', color: '#ffbb55', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
        wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
        panL: c.panL, panR: c.panR });
    }

    if (chips.includes('segapcm')) {
      // SegaPCM(VGM: OutRun/After Burner等): 16ch ステレオPCM。GA1-4行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。デルタレジスタで
      // 1サンプルを音階演奏するチップなので、音程が取れれば絶対音名になる。
      // L/R列はch毎のL/R音量(7bit)を0-15へ丸めた値。手動キャリブレーションもGA/NA行と共通。
      const live = extraSnaps && extraSnaps.segapcmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.segapcm ? extraSnaps.segapcm[frameIdx] : null);
      const spWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 16; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (200 + ch * 9) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `SP${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 127,
          wave: spWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('c140')) {
      // C140(VGM: ナムコSystem 2/21): 24ch ステレオPCM。SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。System 2はメロディも
      // C140で弾く曲が多く、周波数レジスタ由来のrateがピッチベンドも追従する。
      const live = extraSnaps && extraSnaps.c140Live;
      const s = live ? live() : (extraSnaps && extraSnaps.c140 ? extraSnaps.c140[frameIdx] : null);
      const cnWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 24; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (330 + ch * 6) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `CN${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: cnWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('c352')) {
      // C352(VGM: ナムコSystem 11/12/22等): 32ch PCM。CN/SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。ノイズフラグの
      // ボイス(LFSR)はサンプルが無いのでピッチ解析対象外=「サンプル」行のまま。
      const live = extraSnaps && extraSnaps.c352Live;
      const s = live ? live() : (extraSnaps && extraSnaps.c352 ? extraSnaps.c352[frameIdx] : null);
      const csWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 32; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (30 + ch * 5) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `CS${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: csWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('psx')) {
      // PSF(PlayStation SPU): 24ボイスのADPCMサンプル再生。C352/C140と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行=ドラム区画)。
      // スナップショットは src/emulator/psxSampleBank.js Emu.snapshotPsx が C352 と同じ形で作る。
      const live = extraSnaps && extraSnaps.psxLive;
      const s = live ? live() : (extraSnaps && extraSnaps.psx ? extraSnaps.psx[frameIdx] : null);
      const pxWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      // 行数はスナップショットの長さ(実機スロット=24ボイス、合成ch=32本。Emu.POOL_CHIP_CHANNELS.psx 参照)
      // (トラックモードは曲頭でまだレーンが1本も無いフレームが空配列になる → 0行)
      const nPx = s ? s.length : 24;
      // トラックモード(要素に lane がある。Emu.PsfTrackVoicer): 行はトラック順・声部順に並べ、行名はトラック名、
      // 色はトラックごと(声部は明るさ違い)。行ID PX<n> はレーン番号のまま(割当/変換のソースID psx:<n-1> と対応)
      const pxOrder = (s && nPx && s[0] && s[0].lane) ? psxTrackOrder(s) : null;
      for (let k = 0; k < nPx; k++) {
        const ch = pxOrder ? pxOrder.order[k] : k;
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const lane = pxOrder ? s[ch].lane : null;
        const hueNum = lane ? (lane.copyOf ? pxOrder.hueNum[ch] : (lane.track >= 0 ? lane.track : 40 + lane.groupIndex)) : 0;
        const color = lane
          // 複製は元トラックと同じ色相のまま彩度と明度を落とす(点線でも色で元が分かるように)
          ? `hsl(${(200 + hueNum * 137.508) % 360},${lane.copyOf ? 55 : 75}%,${Math.min(80, (lane.copyOf ? 45 : 58) + lane.voice * 7)}%)`
          : `hsl(${(200 + ch * 7) % 360},75%,62%)`;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `PX${ch + 1}`, color, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          ...(lane ? { label: pxOrder.label[ch], labelTitle: pxOrder.title[ch], laneGroup: pxOrder.group[ch], laneCopy: pxOrder.copy[ch] } : {}),
          wave: pxWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('ym2610fm')) {
      // YM2610(VGM: Neo Geo): 4op FM×4ch(YM2612と同じFM波形表示)。内蔵SSGは 'kssPsg' の
      // KP1-3行として別途出す(main.js vgmKeyboardChips)。ライブ関数優先、無ければ先読み
      // スナップショット配列(extraSnaps.ym2610fm[frameIdx]、ロール構築用)。
      const live = extraSnaps && extraSnaps.ym2610FmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.ym2610fm ? extraSnaps.ym2610fm[frameIdx] : null);
      const COLS = ['#ffcc00', '#ffdd44', '#ffe566', '#ffee88', '#fff2aa', '#fff8cc'];
      const nFm = s && s.channels ? s.channels.length : 4; // YM2610B は6ch
      for (let ch = 0; ch < nFm; ch++) {
        const c = s ? s.channels[ch] : { freq: 0, vol: 0, rawVol: 0, active: false, panL: 1, panR: 1, waveData: null };
        const wave = (c.waveData && c.waveData.length && c.active)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'fm', nx: 256, ny: 256 };
        channels.push({ id: `NF${ch + 1}`, color: COLS[ch], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          wave, active: c.active, panL: c.panL, panR: c.panR, fmPatch: c.patch || null });
      }
      // ADPCM-A(6ch)/ADPCM-B(1ch)の音程表示(3段階、adpcmPitchToMidi参照):
      //  (1) サンプルのピッチ解析(ym2610.js samplePitch: ROM上のサンプルを1回デコードして基本周期を
      //      検出、×再生レート)が信頼できる(pitchConf>=ADPCM_PITCH_CONF) → 実周波数として通常の
      //      音名表示(adpcmExact)。ADPCM-Aは「音程ごとに別サンプル」の場合、ADPCM-Bは
      //      「1サンプルをΔ-Nで音階演奏」の場合にこれで絶対音名が出る。
      //  (2) ADPCM-Bで解析が信頼できない → Δ-N由来レートを仮基準(refRate=C4)からの相対音程として
      //      表示(目安、noteに'?')。
      //  (3) ADPCM-Aで解析が信頼できない(ドラム/ノイズ等) → 音程レジスタが無い(再生レート固定
      //      18518Hz、開始/終了アドレスで別サンプルを選ぶだけ)ので DMC/RF5C164 と同じ「サンプル」行。
      // 音量=音色レベル(A)/レベル(B)、L/Rはパン。
      // 波形アイコン: ym2610.js がデコード済みサンプルから作った128点(音程あり=持続部の1周期、無し=
      // サンプル全体の概形)。無ければ従来の「サンプル」グリフ。
      // adpcmSample: 手動キャリブレーション(note列クリック→onAdpcmCalibrate)用のサンプル同定情報。
      const adpcmWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 6; ch++) {
        const c = s && s.adpcmA ? s.adpcmA[ch] : { vol: 0, rawVol: 0, rawVolMax: 31, active: false, panL: 1, panR: 1, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (20 + ch * 12) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `NA${ch + 1}`, color: `hsl(${hue},80%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave: adpcmWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
      {
        const c = s && s.adpcmB ? s.adpcmB : { vol: 0, rawVol: 0, rawVolMax: 255, active: false, panL: 1, panR: 1, rate: 0, refRate: 1, pitchHz: 0, pitchConf: 0 };
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: 'NB', color: '#cc66ff', freq: exact ? c.pitchHz : (c.rate || 0), vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: adpcmWave(c), active: !!c.active, adpcmPitch: true, adpcmExact: exact, adpcmRefRate: c.refRate || 1, adpcmRate: c.rate || 0,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto',
          panL: c.panL, panR: c.panR });
      }
    }

    if (chips.includes('qsound')) {
      // QSound(VGM: カプコンCPS1ダッシュ/CPS2): 16ch PCM。CS/SP/GA行と同じ3段階表示
      // (ピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。
      const live = extraSnaps && extraSnaps.qsoundLive;
      const s = live ? live() : (extraSnaps && extraSnaps.qsound ? extraSnaps.qsound[frameIdx] : null);
      const qsWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 16; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (260 + ch * 7) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `QS${ch + 1}`, color: `hsl(${hue},75%,62%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: qsWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('multipcm')) {
      // MultiPCM(VGM: セガModel 1/2/Multi 32): 28ch PCM。CS/QS行と同じ3段階表示
      // (F-number/octで1サンプルを音階演奏するチップなのでピッチ解析が通れば絶対音名)。
      const live = extraSnaps && extraSnaps.multipcmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.multipcm ? extraSnaps.multipcm[frameIdx] : null);
      const mpWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 28; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (190 + ch * 6) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `MP${ch + 1}`, color: `hsl(${hue},72%,60%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: mpWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('okim6295')) {
      // OKIM6295(VGM: 東亜プラン/ライジング等): 4ch ADPCM。音程レジスタは無い(固定レート)が
      // 「音程ごとに別サンプル」方式の曲があるので、NA/GA行と同じ3段階表示
      // (フレーズのピッチ解析が信頼できれば絶対音名、なければ「サンプル」行)。モノラル。
      const live = extraSnaps && extraSnaps.okim6295Live;
      const s = live ? live() : (extraSnaps && extraSnaps.okim6295 ? extraSnaps.okim6295[frameIdx] : null);
      const okWave = (c) => (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      for (let ch = 0; ch < 4; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, pitchHz: 0, pitchConf: 0 };
        const hue = (100 + ch * 15) % 360;
        const exact = c.pitchConf >= ADPCM_PITCH_CONF && c.pitchHz > 0;
        channels.push({ id: `OK${ch + 1}`, color: `hsl(${hue},70%,58%)`, freq: exact ? c.pitchHz : 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 0x20,
          wave: okWave(c), active: !!c.active, panL: c.panL, panR: c.panR,
          adpcmSample: c.sample || null, sampleHash: c.sampleHash || null, adpcmManual: !!c.pitchManual, sampleKind: c.sampleKind || 'auto', adpcmRate: c.rate || 0,
          ...(exact ? { adpcmPitch: true, adpcmExact: true }
                    : pcmSampleRow(c)) });
      }
    }

    if (chips.includes('okim6258')) {
      // OKIM6258(VGM: X68000 ADPCM): 1chストリーミングADPCM。ROMも音程レジスタも無いので
      // YMDA/PWMと同じ「サンプル」行(音量=現在振幅、キャプチャ時は再生中の下限0.3)。
      // 波形アイコンはDACストリームで流れているサンプルの128点(okim6258.js snapshot の waveData、
      // NA行等と同じ makeSampleWave: 音程あり=1周期/無し=全体の概形)。無ければ従来の破線
      const live = extraSnaps && extraSnaps.okim6258Live;
      const s = live ? live() : (extraSnaps && extraSnaps.okim6258 ? extraSnaps.okim6258[frameIdx] : null);
      const c = s ? s[0] : { vol: 0, rawVol: 0, active: false, panL: 15, panR: 15, rate: 0, waveData: null };
      const okiWave = (c.waveData && c.waveData.length) ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 } : { t: 'sample' };
      channels.push({ id: 'OKI', color: '#ff9944', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
        wave: okiWave, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
        panL: c.panL, panR: c.panR });
    }

    if (chips.includes('pwm')) {
      // 32X PWM(VGM): 左右2chのPCM DAC。DMC/YMDAと同じ「サンプル」行(音量=振幅)
      const live = extraSnaps && extraSnaps.pwmLive;
      const s = live ? live() : (extraSnaps && extraSnaps.pwm ? extraSnaps.pwm[frameIdx] : null);
      // wave列は直近に流れたサンプル128点(pwm32x.js waveOf)。32X側で合成済みの
      // 1本のストリームなので音色は読み取れないが、鳴っているかは一目で分かる
      // (ユーザー要望 2026-09-09)。先読みキャプチャ側には波形が無いので従来の破線
      for (const [id, key, color] of [['PWL', 'l', '#66ddff'], ['PWR', 'r', '#ff8866']]) {
        const c = s ? s[key] : { level: 0, vol: 0, active: false };
        const w = (c.waveData && c.waveData.length)
          ? { t: 'wave', data: c.waveData, smooth: true, nx: c.waveData.length, ny: 32 }
          : { t: 'sample' };
        channels.push({ id, color, freq: 0, vol: c.vol, rawVol: c.level, rawVolMax: s ? s.cycle : 4095,
          wave: w, active: !!c.active, sample: true, dmcReg: c.level, dmcRateIdx: 15, dmcFreq: 0,
          panL: key === 'l' ? 1 : 0, panR: key === 'r' ? 1 : 0 });
      }
    }

    for (const [tok, prefix, liveKey] of [['rf5c164', 'RC', 'rf5c164Live'], ['rf5c68', 'RB', 'rf5c68Live']]) {
      if (!chips.includes(tok)) continue;
      // RF5C68/164(VGM): 8ch PCM。音程はサンプル依存で不明なのでDMCと同じ「サンプル」行、音量=env×パン
      const live = extraSnaps && extraSnaps[liveKey];
      const s = live ? live() : (extraSnaps && extraSnaps[tok] ? extraSnaps[tok][frameIdx] : null);
      for (let ch = 0; ch < 8; ch++) {
        const c = s ? s[ch] : { vol: 0, rawVol: 0, active: false, panL: 0, panR: 0 };
        const hue = (200 + ch * 18) % 360;
        channels.push({ id: `${prefix}${ch + 1}`, color: `hsl(${hue},70%,60%)`, freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 255,
          wave: { t: 'sample' }, active: !!c.active, sample: true, dmcReg: c.rawVol, dmcRateIdx: 15, dmcFreq: c.rate || 0,
          panL: c.panL, panR: c.panR });
      }
    }

    if (isGbs) {
      const live = extraSnaps && extraSnaps.gbsApuLive;
      const s = live ? live() : null;
      // NR50(マスター音量+VIN)/NR51(パンニング)。ライブでなければ全て0(無音扱い)。
      const nr50 = s ? s.nr50 : 0;
      const nr51 = s ? s.nr51 : 0;
      const volL = (nr50 >> 4) & 0x07, volR = nr50 & 0x07;
      const vinL = !!(nr50 & 0x80), vinR = !!(nr50 & 0x08);
      // ALL行($FF24、全体バランス。HESのALL行と同じ考え方): 実チャンネルではないので
      // L/R列(NR50のマスター音量0-7)だけを持つ。VINが有効な側は数字を黄色にする。
      channels.push({ id: 'GALL', color: '#888', isAllRow: true, panL: volL, panR: volR, vinL, vinR });
      // GB CH1/CH2(パルス+スイープ/パルス): 2A03パルス表示と同じ考え方(duty波形)。
      // エンベロープperiod=0(ハード任せでなく実質固定/ドライバ管理)は白、1-7(ハード自動増減)は黄。
      const PCOLS = [['GB1', '#66ddff'], ['GB2', '#0077dd']];
      for (let i = 0; i < 2; i++) {
        const c = s ? s['ch' + (i + 1)] : { freq: 0, vol: 0, rawVol: 0, duty: 2, envPeriod: 0, active: false };
        channels.push({ id: PCOLS[i][0], color: PCOLS[i][1], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          envMode: (c.envPeriod || 0) > 0, duty: c.duty,
          wave: { t: 'pulse', hi: APU_DUTY[c.duty], nx: 8, ny: 2 },
          active: c.active, panL: (nr51 >> (4 + i)) & 1, panR: (nr51 >> i) & 1 });
      }
      // GB CH4(ノイズ): 7bit/15bit幅モードで短周期/長周期のノイズ波形を切り替える。
      // note列は実測周波数を既存2A03ノイズ16周期の最寄りにマッチさせたindex(0-15)、
      // freq列はGB自体の実測再生速度(Hz)。note色は15bit=白/7bit=黄(ch.noiseShort)。
      {
        const c = s ? s.ch4 : { freq: 0, vol: 0, rawVol: 0, widthMode: 0, envPeriod: 0, active: false };
        channels.push({ id: 'GN', color: '#888888', freq: 0, vol: c.vol, rawVol: c.rawVol, rawVolMax: 15,
          envMode: (c.envPeriod || 0) > 0,
          wave: { t: 'noise', short: !!c.widthMode, nx: c.widthMode ? 127 : 32767, ny: 2 },
          active: c.active, noise: true, noiseIndex: gbNoiseFreqToIndex(c.freq), noiseFreq: c.freq, noiseShort: !!c.widthMode,
          panL: (nr51 >> 7) & 1, panR: (nr51 >> 3) & 1 });
      }
      // GB CH3(波形メモリ): N163と同じ波形メモリ表示(要素数のみ異なる: GBは32点符号無し4bit)。
      // CH3にはエンベロープが無いためvol色は変更しない(envMode未設定=通常色のまま)。
      {
        const c = s ? s.ch3 : { freq: 0, vol: 0, rawVol: 0, waveData: [0, 0], active: false };
        channels.push({ id: 'GW', color: '#ffcc00', freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 3,
          wave: { t: 'wave', data: c.waveData, nx: c.waveData.length, ny: 16 },
          active: c.active, panL: (nr51 >> 6) & 1, panR: (nr51 >> 2) & 1 });
      }
    }

    if (isHes) {
      // PSG(PC Engine) 6ch: 32サンプル5bit波形音源。ch4/5はノイズモード中のみノイズ波形表示に
      // 切り替わる(hesBus.js/apuHuC6280.js参照。物理的にノイズ生成回路を持つのはch4/5のみ)。
      const live = extraSnaps && extraSnaps.hesApuLive;
      const s = live ? live() : null;
      const PCOLS = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
      // ALL行($0801、全体バランス。SPCのALL行と同じ考え方): 実チャンネルではないので
      // active/wave/note/freqは無く、L/R列だけを持つ(_rebuildRows()のisAllRow参照)。
      channels.push({
        id: 'HALL', color: '#888', isAllRow: true,
        panL: s ? s.globalPanL : 15, panR: s ? s.globalPanR : 15
      });
      for (let i = 0; i < 6; i++) {
        const c = s ? s[i] : { freq: 0, vol: 0, rawVol: 0, wave: [0, 0], noiseOn: false, active: false, dda: false, panL: 15, panR: 15 };
        const wave = c.noiseOn
          ? { t: 'noise', short: false, nx: 131071, ny: 2 }
          : { t: 'wave', data: c.wave, nx: c.wave.length, ny: 32 };
        channels.push({ id: `PSG${i}`, color: PCOLS[i], freq: c.freq, vol: c.vol, rawVol: c.rawVol, rawVolMax: 31,
          wave, active: c.active, noise: c.noiseOn, noiseLabel: c.noiseOn ? 'noise' : undefined,
          dda: c.dda, panL: c.panL, panR: c.panR });
      }
    }

    const letterMap = (MML.Mml && MML.Mml.assignExpansionLetters) ? MML.Mml.assignExpansionLetters(chipsToExpansions(chips)) : {};
    // part列は元々「この元chはNSF側のどのパートになるか」の表示(=既に割当表だった)。
    // 既定はgetPartLetter()のハードコード規則(従来の変換結果と同一)のままで、チャンネル割当
    // (src/convert/channelPlan.js)でユーザーが変えた行だけ、その借用先のレターへ差し替える。
    const plan = channelPlan();
    for (const c of channels) {
      const hardLetter = getPartLetter(c.id, letterMap, n163NumRows);
      if (!plan || c.isAllRow) { c.letter = hardLetter; continue; }
      c.defaultTarget = plan.defaultTarget(c.id, plan.targetOfLetter(hardLetter));
      const ent = plan.get(c.id);
      c.target = (ent && ent.target) || c.defaultTarget;
      // 既定のままなら従来どおりgetPartLetter()の文字をそのまま使う(表示を変えない)
      c.letter = (ent && ent.target) ? plan.letterOfTarget(ent.target)
        : (hardLetter || plan.letterOfTarget(c.defaultTarget));
    }

    return channels;
  }

  // 音量(0-1)を9段階(0-8)に量子化する。ピアノロールの音量シェーディングは連続値ではなく
  // 「段階的に暗く」なる見た目にするため、ノート区間の分割もこの量子化レベル単位で行う。
  const ROLL_VOL_LEVELS = 8;
  function quantizeVol(v) {
    return Math.max(0, Math.min(ROLL_VOL_LEVELS, Math.round((v || 0) * ROLL_VOL_LEVELS)));
  }

  // ── ピアノロール: フレーム単位のチャンネル状態からノート区間を抽出 ──
  // getChannelsAtFrame(frameIdx) は extractChannels() と同じ形の channels[] を返す関数。
  // 同じMIDIノート・同じ量子化音量レベルが連続する区間を1つのノートにまとめる
  // (ノイズ/サンプルチャンネルは対象外)。
  // freqSeq: DESIGN-PITCH.md Phase 0のセント偏差オーバーレイ用。ノート区間内フレーム毎の
  // 生周波数(Hz)をvolSeqと同じ「区切らず積む」考え方で保持する(丸め後のmidiは一定のまま、
  // 実際の周波数だけがビブラート等で揺れている様子を後で細線描画するため)。
  function buildNoteTimelineFromChannelFrames(getChannelsAtFrame, totalFrames, frameDur) {
    const tracks = new Map(); // id → { id, color, notes:[], cur:{startFrame,midi,drumKey,volQ,freqs}|null }
    // ドラム区画のレーン割当はここではやらない。RollBuild.vgm はチップごとに
    // この関数を別々に呼んでタイムラインを連結するので、ここで割り当てると
    // 2つのサンプルチップを積んだVGMで両方が「レーン0」から番号を振ってしまう。
    // noteにはdrumKeyだけ載せ、曲全体が揃った受け取り側で一括して割り当てる
    // (KeyboardDisplay._rebuildDrumLanes → MML.Convert.DrumMap.build)。
    const TK = MML.Convert && MML.Convert.ToneKey; // 音色キー(音色一覧パネル用。roll-builders.js toneOf と同じ役割)
    const pushNote = (track, endSec) => {
      const c = track.cur;
      const note = { startSec: c.startFrame * frameDur, endSec, midi: c.midi,
                     vol: c.volQ / ROLL_VOL_LEVELS, freqSeq: c.freqs };
      if (c.drumKey) note.drumKey = c.drumKey;
      if (c.tone) note.tone = c.tone;
      // sampleRow: サンプル再生ch(2A03 DMC/YM2612 DAC/32X PWM/RF5C…)のノート。midiは
      // レート由来の疑似音程なので「音高=楽器の区別」にならない。E(DPCM)へ載せて打楽器化する
      // ときは1発ごとに切り出して内容で束ねる必要があるため、印だけ付けておく
      // (main.js synthDrumNotes / buildSynthHits。2026-09-04)
      if (c.sampleRow) note.sampleRow = true;
      track.notes.push(note);
      track.cur = null;
    };
    for (let f = 0; f < totalFrames; f++) {
      const channels = getChannelsAtFrame(f) || [];
      for (const ch of channels) {
        let track = tracks.get(ch.id);
        if (!track) { track = { id: ch.id, color: ch.color, notes: [], tones: {}, cur: null }; tracks.set(ch.id, track); }
        track.color = ch.color;
        // laneGroup: ロールの区画キー(PSF のトラックモード)。laneCopy: 複製パート(点線で描く)
        if (ch.laneGroup !== undefined) { track.laneGroup = ch.laneGroup; track.laneCopy = !!ch.laneCopy; }
        // ノイズch/DPCM(サンプル)chはch.freqが常に0(実波形の「音程」ではないため)なので、
        // 代わりに周期選択レジスタのindex(0-15)をそのまま16音へ1:1対応させた疑似ノート番号
        // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)として使う。GBSのロール
        // (main.js buildGbsRollTimeline)は元々noise.jsの周期判定で音程付きで表示できていたが、
        // この共通経路(NSF/MML再生のロール、および全フォーマット共通の鍵盤ハイライトdrawPiano)は
        // ノイズ・DPCM双方を丸ごと除外していたため、NSFのノイズ/DPCMがロールにも鍵盤にも出ない・
        // GBSのノイズが鍵盤に出ない、という食い違いになっていた。
        //  drumKey付き(打楽器として鳴っているサンプルPCM)は音程を持たないので、midiではなく
        //  drumKeyの側で同一性を判断する。以降 midi と drumKey は排他(どちらか一方だけ非null)。
        let midi, pitchFreq, drumKey = null, drumSeq = 0;
        if (!ch.active) { midi = null; pitchFreq = 0; }
        else if (ch.drumKey) { midi = null; pitchFreq = 0; drumKey = ch.drumKey; drumSeq = ch.drumSeq || 0; }
        else if (ch.noise) { midi = noisePeriodIndexToMidi(ch.noiseIndex); pitchFreq = ch.noiseFreq; }
        else if (ch.adpcmPitch) { midi = adpcmPitchToMidi(ch); pitchFreq = ch.freq; }
        else if (ch.sample) { midi = dmcRateIndexToMidi(ch.dmcRateIdx); pitchFreq = ch.dmcFreq; }
        else { midi = ch.freq ? freqToMidi(ch.freq) : null; pitchFreq = ch.freq; }
        const sounding = midi !== null || drumKey !== null;
        const volQ = sounding ? quantizeVol(ch.vol) : 0;
        const cur = track.cur;
        // drumSeqはキーオン通番。同じ太鼓を同じ音量で連打したとき(16分のハイハット等)、
        // これを見ないと区間が1本の長い棒に融合してしまう
        // ★ドラム区画(drumKey)のノートは音量変化で割らない: DPCMは出力レベル=波形そのもの、
        //   サンプルPCMも減衰はサンプル自身が持つので、割ると1打点が数十の細切れになり
        //   パッドの打点数も実トリガー数と食い違う(実測: Super C 126トリガー→1707ノート)
        if (cur && (!sounding || midi !== cur.midi || drumKey !== cur.drumKey || drumSeq !== cur.drumSeq || (!drumKey && volQ !== cur.volQ))) {
          pushNote(track, f * frameDur);
        }
        if (sounding && !track.cur) {
          // 音色キーは発音開始の瞬間だけ引く(毎フレーム引くと重い。ノート途中の音色変化は次のノートで拾う)
          let tone;
          if (TK && midi !== null) {
            tone = TK.ofLive(ch);
            if (tone && !track.tones[tone]) track.tones[tone] = TK.infoOfLive(ch, tone);
          }
          track.cur = { startFrame: f, midi, drumKey, drumSeq, volQ, freqs: [], tone,
                        sampleRow: !!ch.sample && !drumKey };
        }
        if (track.cur) track.cur.freqs.push(pitchFreq);
      }
    }
    const totalSec = totalFrames * frameDur;
    const result = [];
    for (const track of tracks.values()) {
      if (track.cur) pushNote(track, totalSec);
      result.push({ id: track.id, color: track.color, notes: track.notes, tones: track.tones });
    }
    result.frameDur = frameDur; // セント偏差オーバーレイ描画時にfreqSeqのフレーム間隔を復元するため
    return result;
  }

  // ── 間接アクセス音源の内部状態再構築 ─────────────────────────

  function buildVrc7Snapshots(writeLog) {
    const regs = new Uint8Array(64);
    let latch = 0;
    return writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0x9010) latch = w.value & 0x3F;
        else if (w.addr === 0x9030) regs[latch] = w.value;
      }
      return Array.from({ length: 6 }, (_, ch) => {
        const fnumLo = regs[0x10 + ch];
        const b2 = regs[0x20 + ch];
        const keyOn = !!(b2 & 0x10);
        const block = (b2 >> 1) & 7;
        const fnum = fnumLo | ((b2 & 1) << 8);
        const rawVol = regs[0x30 + ch] & 0xF; // 0=最大, 15=無音
        const vol = (15 - rawVol) / 15;
        const freq = (keyOn && fnum > 0) ? fnum * Math.pow(2, block) * 49716 / 524288 : 0;
        return { freq, vol, rawVol, active: keyOn && rawVol < 15 };
      });
    });
  }

  // 事前キャプチャ経路: writeLog($F800/$4800)から128バイトRAMを復元し、
  // フレームごとに Emu.snapshotN163() でスナップショット化する。
  function buildN163Snapshots(writeLog) {
    const ram = new Uint8Array(128);
    let latch = 0, autoInc = false;
    let maxNumCh = 1;
    const frames = writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0xF800) { latch = w.value & 0x7F; autoInc = !!(w.value & 0x80); }
        else if (w.addr === 0x4800) { ram[latch] = w.value; if (autoInc) latch = (latch + 1) & 0x7F; }
      }
      const snap = MML.Emu.snapshotN163(ram);
      if (snap.numCh > maxNumCh) maxNumCh = snap.numCh;
      return snap;
    });
    frames.maxNumCh = maxNumCh;
    return frames;
  }

  // ライブキャプチャ経路: capture.jsがフレームごとに採取した実チップRAM(128byte)の配列から
  // 直接スナップショット化する(writeLog再生による間接アドレッシングのポインタずれが無い、
  // buildN163Snapshots()より正確な代替)。
  function buildN163SnapshotsFromLiveRam(n163Snapshots) {
    let maxNumCh = 1;
    const frames = n163Snapshots.map(ram => {
      const snap = MML.Emu.snapshotN163(ram || new Uint8Array(128));
      if (snap.numCh > maxNumCh) maxNumCh = snap.numCh;
      return snap;
    });
    frames.maxNumCh = maxNumCh;
    return frames;
  }

  function buildFme7Snapshots(writeLog) {
    const regs = new Uint8Array(16);
    let latch = 0;
    regs[7] = 0x38;
    return writeLog.map(writes => {
      for (const w of writes) {
        if (w.addr === 0xC000) latch = w.value & 0xF;
        else if (w.addr === 0xE000) regs[latch] = w.value;
      }
      return Array.from({ length: 3 }, (_, ch) => {
        const period = regs[ch * 2] | ((regs[ch * 2 + 1] & 0xF) << 8);
        const toneOn = !((regs[7] >> ch) & 1);
        const noiseOn = !((regs[7] >> (3 + ch)) & 1);
        const rawVol = regs[8 + ch] & 0xF;
        const vol = rawVol / 15;
        // 実機5B/AYは +1 しない。f = CPU/(32*period)。
        const freq = (toneOn && period > 0) ? CPU_CLOCK / (32 * period) : 0;
        // ノイズ単独(@2)はトーンが止まっていても発音中(Emu.snapshotFME7と同じ判定)
        return { freq, vol, rawVol, noise: noiseOn,
                 active: toneOn ? (vol > 0 && freq > 0) : (noiseOn && vol > 0) };
      });
    });
  }

  // ── 鍵盤描画 ────────────────────────────────────────────────

  // 演奏入力で押している鍵の色(チャンネル色と衝突しにくい彩度の高い青緑)
  const PERFORM_KEY_COLOR = '#22d3ee';

  function keyX(midi, wkW) {
    if (midi < MIDI_MIN || midi > MIDI_MAX) return null;
    const rel = midi - MIDI_MIN;
    const oct = Math.floor(rel / 12);
    const semi = rel % 12;
    if (!IS_BLACK[semi]) {
      return { x: (oct * 7 + WHITE_IDX[semi]) * wkW, isBlack: false };
    }
    const lw = oct * 7 + WHITE_IDX[semi - 1];
    return { x: (lw + 1) * wkW, isBlack: true };
  }

  // ── 素波形アイコン描画 ────────────────────────────────────────
  // ピッチ・音量を含まない、そのチャンネルの1周期ぶんの生波形を表示する。

  // 位相 phase(0..1) に対する正規化振幅 (-1..1)
  function waveSampleValue(wave, phase) {
    switch (wave.t) {
      case 'pulse': return phase < wave.hi ? 1 : -1;
      case 'tri': {
        // NES三角波: 32ステップ / 16段の階段波 (15→0→15)
        const step = Math.floor(phase * 32) % 32;
        const v = step < 16 ? (15 - step) : (step - 16); // 0..15
        return (v / 15) * 2 - 1;
      }
      case 'saw': {
        // VRC6のこぎり波: 8bitアキュムレータへ蓄積レートを6回加算→リセットの7段階段状。
        // 出力は上位5bit(0-31)。実機通り&0xFFで折り返すので、レート43以上は桁溢れで
        // 波形が崩れる(src/emulator/expansion/vrc6.js Vrc6Saw.clock()と同じ計算)。
        // rate未指定(ロール等の静的アイコン)は理想形(=レート42相当)
        const step = Math.floor(phase * 7) % 7;
        const rate = wave.rate == null ? 42 : wave.rate;
        const out = ((step * rate) & 0xFF) >> 3;
        return (out / 31) * 2 - 1;
      }
      case 'fm':    return Math.sin(phase * Math.PI * 2);
      case 'wave': {
        const d = wave.data;
        if (!d.length) return 0;
        if (wave.smooth) {
          // FM等の連続波形: サンプル間を線形補間して滑らかな曲線にする
          const x = phase * d.length;
          const i0 = Math.floor(x) % d.length;
          const i1 = (i0 + 1) % d.length;
          const f = x - Math.floor(x);
          return d[i0] * (1 - f) + d[i1] * f;
        }
        // ウェーブテーブル(N163等)は本当に階段状なので最近傍
        return d[Math.floor(phase * d.length) % d.length];
      }
    }
    return 0;
  }

  // 波形クリップボード用: そのチャンネルの1周期ぶんを具体的な数値配列にして返す。
  // pulse/saw/tri等はwave.hi等のパラメータだけで実データ配列を持たないため
  // waveSampleValue()で一定解像度サンプリングして配列化する。noise(LFSR)/fm(実データ
  // 無しの代替アイコン)/sample(固有波形無し)はコピー対象外としてnullを返す
  function getCopyableWaveSamples(wave) {
    if (!wave) return null;
    if (wave.t === 'wave') {
      // SPCの多層波形は素のBRR値(層0)を代表として使う
      if (wave.layers && wave.layers.length && wave.layers[0].data && wave.layers[0].data.length) {
        return Array.from(wave.layers[0].data);
      }
      return (wave.data && wave.data.length) ? Array.from(wave.data) : null;
    }
    if (wave.t === 'pulse' || wave.t === 'saw' || wave.t === 'tri') {
      const resolution = Math.max(8, Math.min(256, wave.nx || 32));
      const arr = [];
      for (let i = 0; i < resolution; i++) arr.push(waveSampleValue(wave, i / resolution));
      return arr;
    }
    return null;
  }

  // 再描画要否判定用シグネチャ（形状 or 表示状態が変わった時だけ描き直す）
  function waveSig(wave, on) {
    if (!wave) return 'x';
    let s = wave.t + (on ? '1' : '0');
    if (wave.t === 'pulse') s += wave.hi.toFixed(3);
    else if (wave.t === 'saw') s += wave.rate == null ? '' : wave.rate;
    else if (wave.t === 'noise') s += wave.short ? 'S' : 'L';
    else if (wave.t === 'wave') {
      if (wave.layers) {
        // SPCの多層波形(素/ガウス補間/PM変調後)は各レイヤーをまとめてハッシュ化
        for (const layer of wave.layers) {
          const d = layer.data;
          let h = d.length;
          for (let i = 0; i < d.length; i++) h = (h * 31 + Math.round(d[i] * 1000)) | 0;
          if (layer.xs) for (let i = 0; i < layer.xs.length; i++) h = (h * 31 + Math.round(layer.xs[i] * 1000)) | 0;
          s += ':' + d.length + ':' + h;
        }
      } else if (wave.sig) {
        s += ':' + wave.sig; // DPCM等の大容量データはキャッシュキー(addr:len)で判定しハッシュ省略
      } else {
        const d = wave.data;
        let h = d.length;
        for (let i = 0; i < d.length; i++) h = (h * 31 + Math.round(d[i] * 100)) | 0;
        s += ':' + d.length + ':' + h;
      }
    }
    return s;
  }

  // ノイズを離散バー(階段)で描く。周期全体(短=93 / 長=32767)を表示幅ぶんに間引いて
  // 1周期を表現する（長周期は省略表示）。X軸 0..周期-1 と対応。
  function drawNoiseStairs(ctx, short, x0, w, mid, amp) {
    const period = short ? 93 : 32767;
    const maxBars = Math.max(8, Math.floor(w / 3)); // 1バー最低3px確保
    const bars = Math.min(period, maxBars);
    const barW = w / bars;
    let sr = 1, step = 0;
    ctx.beginPath();
    for (let k = 0; k < bars; k++) {
      const target = Math.round(k * (period - 1) / Math.max(1, bars - 1));
      while (step < target) { // LFSR を target ステップまで進める
        const b0 = sr & 1;
        const other = short ? ((sr >> 6) & 1) : ((sr >> 1) & 1);
        sr = (sr >> 1) | ((b0 ^ other) << 14);
        step++;
      }
      const y = mid - ((sr & 1) ? -1 : 1) * amp; // bit0=0→出力ON(上), 1→無音(下)
      const xa = x0 + k * barW, xb = x0 + (k + 1) * barW;
      if (k === 0) ctx.moveTo(xa, y); else ctx.lineTo(xa, y);
      ctx.lineTo(xb, y);
    }
    ctx.stroke();
  }

  function drawWaveIcon(canvas, wave, color, on) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!wave) return;
    const mid = H / 2, amp = H / 2 - 3;
    ctx.strokeStyle = on ? color : '#4a4a58';
    ctx.lineWidth = on ? 2 : 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    if (wave.t === 'sample') {
      // DMC/PCM: 固有波形なし。中央に破線を引く
      ctx.setLineDash([4, 4]);
      ctx.moveTo(3, mid); ctx.lineTo(W - 3, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (wave.t === 'noise') {
      // 1周期を表示幅ぶんに間引いた離散バーで描画（short/longで異なるパターン）
      drawNoiseStairs(ctx, wave.short, 0, W, mid, amp);
      return;
    }

    const PERIODS = 2; // 周期性が読み取れるよう2周期ぶん描く
    for (let x = 0; x <= W; x++) {
      const phase = ((x / W) * PERIODS) % 1;
      const y = mid - waveSampleValue(wave, phase) * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 波形タイプの表示名
  function waveTypeLabel(wave) {
    if (!wave) return '';
    switch (wave.t) {
      case 'pulse':  return 'Pulse';
      case 'tri':    return 'Triangle';
      case 'saw':    return 'Sawtooth';
      case 'noise':  return 'Noise (' + (wave.short ? 'short' : 'long') + ')';
      case 'wave':
        if (wave.layers) return wave.layers.length > 2
          ? T('BRR (素 + ガウス補間 + PM)') : T('BRR (素 + ガウス補間)');
        return wave.smooth ? 'FM' : (wave.pcm ? 'DPCM' : 'Wavetable');
      case 'fm':     return 'FM';
      case 'sample': return 'PCM (DMC)';
    }
    return wave.t;
  }

  // ── FM音色データのテキスト化(大波形表示の下に出す・コピー用) ──
  // 数値行は各値を width 桁に右寄せして sep で繋ぎ、見出し行(コメント)は同じ幅のラベルを " " で
  // 繋ぐので列が縦に揃う(ユーザー指定の書式:
  //   ; TL FB
  //     20, 0,
  //   ; AR DR SL RR KL ML AM VB EG KR DT
  //     15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0,
  //     15, 4, 2, 4, 0, 1, 0, 0, 1, 0, 0
  // )。表示は行ごとに「コメント(先頭が ; の行、または行中の ; 以降)」と「データ」を色分けする
  // (renderFmPatchHtml)。書式はドライバごとに選べる(FM_PATCH_FORMATS、localStorageに保存)。
  // 各書式の並びは公式ドキュメントで確認済み:
  //   PMD    : `; nm alg fbl` / `@nnn alg fbl` / `; ar dr sr rr sl tl ks ml dt ams` ×op1-4 (3桁ゼロ埋めが慣例)
  //   FMP7   : `'@ FA n` / `'@ AR,DR,SR,RR,SL,TL,KS,ML,DT,AM` ×4 / `'@ AL,FB` (' の無い行はコメント)
  //   MUCOM88: `  @n`(先頭空白2つ以上) / `FB,AL` / `AR,DR,SR,RR,SL,TL,KS,ML,DT ; opN` ×4
  //   op1..op4 はいずれも論理順(op2=レジスタ+8)。SSG-EGはPMD/FMP7/MUCOM88の書式に無いので、
  //   使われている時だけコメントで添える。
  //   OPLL系: @OT(このツール/mck、MGSDRV互換の並び)、@v(MGSDRV)、@OP(生8バイト、mck)。
  const FM_PATCH_FORMATS = {
    opn:  [{ id: 'pmd', label: 'PMD' }, { id: 'fmp7', label: 'FMP7' }, { id: 'mucom88', label: 'MUCOM88' }, { id: 'regs', label: 'レジスタ(バイナリ)' }],
    opll: [{ id: 'ot', label: '@OT (mck)' }, { id: 'mgs', label: '@v (MGSDRV)' }, { id: 'op', label: '@OP (バイナリ8バイト)' }]
  };
  const FM_PATCH_FMT_KEY = { opn: 'kbdFmPatchFmtOpn', opll: 'kbdFmPatchFmtOpll' };
  function getFmPatchFormat(type) {
    const list = FM_PATCH_FORMATS[type] || [];
    let id = null;
    try { id = localStorage.getItem(FM_PATCH_FMT_KEY[type]); } catch (e) { /* ignore */ }
    return list.some(f => f.id === id) ? id : (list[0] ? list[0].id : null);
  }
  function setFmPatchFormat(type, id) {
    try { localStorage.setItem(FM_PATCH_FMT_KEY[type], id); } catch (e) { /* ignore */ }
  }

  function fmtPatchRows(width, groups, sep, indent) {
    // groups: [{ labels:[...], rows:[[...],[...]], prefix?, tail?:[..] }, ...]
    sep = sep === undefined ? ',' : sep; indent = indent === undefined ? '  ' : indent;
    const lines = [];
    for (const g of groups) {
      if (g.labels) lines.push('; ' + g.labels.map(l => String(l).padStart(width)).join(' '));
      g.rows.forEach((row, i) => {
        const tail = g.tails && g.tails[i] ? g.tails[i] : '';
        lines.push((g.prefix !== undefined ? g.prefix : indent) + row.map(v => String(v).padStart(width)).join(sep) + (g.trailingComma === false ? '' : ',') + tail);
      });
    }
    // 最終行の末尾カンマだけ落とす(コメント末尾なら手前のデータ行)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*;/.test(lines[i])) continue;
      lines[i] = lines[i].replace(/,(\s*;.*)?$/, '$1');
      break;
    }
    return lines.join('\n');
  }

  // ---- OPLL / VRC7 (YM2413系) ----
  const opllOpRow = (o) => [o.AR, o.DR, o.SL, o.RR, o.KL, o.ML, o.AM, o.PM, o.EG, o.KR, o.WF];
  const OPLL_OP_LABELS = ['AR', 'DR', 'SL', 'RR', 'KL', 'ML', 'AM', 'VB', 'EG', 'KR', 'DT'];
  // {mod,car} → VRC7/OPLLのカスタム音色レジスタ8バイト(lexer.js parseVrc7ToneAltDef / vrc7.js dump2patch の逆)
  function opllPatchBytes(p) {
    const m = p.mod, c = p.car;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15)
    ];
  }
  function formatOpllPatch(p, fmt, ch) {
    const m = p.mod, c = p.car;
    const head = `; ${ch.id} inst ${p.inst}${p.inst === 0 ? ' (user)' : ' (ROM)'}`;
    if (fmt === 'op') {
      return head + '\n@OP0 = {\n  ' + opllPatchBytes(p).map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(',') + '\n}';
    }
    const body = fmtPatchRows(2, [
      { labels: ['TL', 'FB'], rows: [[m.TL, m.FB]] },
      { labels: OPLL_OP_LABELS, rows: [opllOpRow(m), opllOpRow(c)] }
    ]);
    if (fmt === 'mgs') return head + '\n@v0 = {\n' + body + '\n}';
    return head + '\n@OT0 = {\n' + body + '\n}';
  }

  // ---- OPN (YM2612 / YM2610) ----
  function opnExtraComments(p) {
    const lines = [];
    if (p.ops.some(o => o.SE)) lines.push('; ssg-eg ' + p.ops.map(o => o.SE).join(' ') + ' (op1..op4)');
    // OPM(YM2151)のみ: DT2(粗デチューン 0/+600/+781/+950セント)。OPNには無いフィールド
    if (p.ops.some(o => o.DT2)) lines.push('; dt2 ' + p.ops.map(o => o.DT2 || 0).join(' ') + ' (op1..op4)');
    lines.push(`; ams ${p.AMS} pms ${p.PMS} pan ${p.L ? 'L' : '-'}${p.R ? 'R' : '-'}`);
    return lines.join('\n');
  }
  function formatOpnPatch(p, fmt, ch) {
    const head = `; ${ch.id}`;
    const pmdRow = (o) => [o.AR, o.DR, o.SR, o.RR, o.SL, o.TL, o.KS, o.ML, o.DT, o.AM];
    if (fmt === 'fmp7') {
      const body = fmtPatchRows(3, [
        { labels: ['AR', 'DR', 'SR', 'RR', 'SL', 'TL', 'KS', 'ML', 'DT', 'AM'], rows: p.ops.map(pmdRow), prefix: "'@ ", trailingComma: false },
        { labels: ['AL', 'FB'], rows: [[p.AL, p.FB]], prefix: "'@ ", trailingComma: false }
      ]);
      return `${head}\n'@ FA 0\n` + body + '\n' + opnExtraComments(p);
    }
    if (fmt === 'mucom88') {
      const body = fmtPatchRows(3, [
        { labels: ['FB', 'AL'], rows: [[p.FB, p.AL]], prefix: '   ', trailingComma: false },
        { labels: ['AR', 'DR', 'SR', 'RR', 'SL', 'TL', 'KS', 'ML', 'DT'], rows: p.ops.map(o => [o.AR, o.DR, o.SR, o.RR, o.SL, o.TL, o.KS, o.ML, o.DT]),
          prefix: '  ', trailingComma: false, tails: [' ; op1', ' ; op2', ' ; op3', ' ; op4'] }
      ]);
      return `${head}\n  @0\n` + body + '\n' + opnExtraComments(p);
    }
    if (fmt === 'regs') {
      // レジスタ順(op1,op3,op2,op4)で $30〜$90 の各グループと $B0/$B4。ch1相当のオフセット0で表記
      const regOrder = [0, 2, 1, 3]; // 論理op → レジスタスロット順に並べ替え
      const hx = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
      const grp = (label, f) => `; ${label}\n  ` + regOrder.map(i => hx(f(p.ops[i]))).join(',');
      return [head + ' (register order op1,op3,op2,op4 = +0,+4,+8,+12)',
        grp('$30 DT/ML', o => (o.DT << 4) | o.ML),
        grp('$40 TL', o => o.TL),
        grp('$50 KS/AR', o => (o.KS << 6) | o.AR),
        grp('$60 AM/DR', o => (o.AM << 7) | o.DR),
        grp('$70 SR', o => o.SR),
        grp('$80 SL/RR', o => (o.SL << 4) | o.RR),
        grp('$90 SSG-EG', o => o.SE),
        '; $B0 FB/AL\n  ' + hx((p.FB << 3) | p.AL),
        '; $B4 L/R/AMS/PMS\n  ' + hx((p.L << 7) | (p.R << 6) | (p.AMS << 4) | p.PMS)
      ].join('\n');
    }
    // PMD(既定): 3桁ゼロ埋め・空白区切りが慣例
    const z3 = (v) => String(v).padStart(3, '0');
    const lines = [head, '; nm  alg fbl', `@000 ${z3(p.AL)} ${z3(p.FB)}`, ';  ar  dr  sr  rr  sl  tl  ks  ml  dt ams'];
    for (const o of p.ops) lines.push(' ' + pmdRow(o).map(z3).join(' '));
    lines.push(opnExtraComments(p));
    return lines.join('\n');
  }

  // ch.fmPatch → 表示テキスト(無ければnull)。fmt省略時は保存済み/既定の書式
  function formatFmPatch(ch, fmt) {
    const p = ch && ch.fmPatch;
    if (!p) return null;
    const f = fmt || getFmPatchFormat(p.type);
    if (p.type === 'opll') return formatOpllPatch(p, f, ch);
    if (p.type === 'opn') return formatOpnPatch(p, f, ch);
    return null;
  }
  // テキスト → 色分けHTML(コメント=先頭';'の行と行中の';'以降、それ以外=データ)
  function renderFmPatchHtml(text) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split('\n').map((line) => {
      const i = line.indexOf(';');
      if (i < 0) return `<span class="kbd-patch-data">${esc(line)}</span>`;
      if (/^\s*;/.test(line)) return `<span class="kbd-patch-comment">${esc(line)}</span>`;
      return `<span class="kbd-patch-data">${esc(line.slice(0, i))}</span><span class="kbd-patch-comment">${esc(line.slice(i))}</span>`;
    }).join('\n');
  }

  // ── SPC エンベロープ(env列)アイコン描画 ─────────────────────────
  // ADSRモード限定: AR/DR/SL/SRの生値から模式的なエンベロープ形状(Attack→Decay→
  // Sustain→Release)を描く。レートが速いほど傾きが急峻になる簡易表現（時間軸は正確ではない）。
  function drawEnvIcon(canvas, env, color, on) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!env || env.mode !== 'adsr') return;
    const arT = env.ar / 15, drT = env.dr / 7;
    const slY = env.sl / 7; // サステインレベル 0-7 → 0-1
    const wA = 3 + (1 - arT) * (W * 0.30);
    const wD = 3 + (1 - drT) * (W * 0.24);
    const wS = W * 0.18;
    const wR = Math.max(3, W - wA - wD - wS - 2);
    const x0 = 1, yTop = 2, yBase = H - 2;
    const ySus = yBase - slY * (yBase - yTop);
    ctx.strokeStyle = on ? color : '#4a4a58';
    ctx.lineWidth = on ? 1.6 : 1.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, yBase);
    ctx.lineTo(x0 + wA, yTop);                  // Attack
    ctx.lineTo(x0 + wA + wD, ySus);              // Decay → Sustain level
    ctx.lineTo(x0 + wA + wD + wS, ySus);         // Sustain (簡易的に水平)
    ctx.lineTo(x0 + wA + wD + wS + wR, yBase);   // Release
    ctx.stroke();
  }

  // 再描画要否判定用シグネチャ（大波形用: 形状＋要素数）
  function bigWaveSig(wave) {
    if (!wave) return 'x';
    return waveSig(wave, true) + '|' + wave.nx + 'x' + wave.ny;
  }

  // 選択チャンネルの素波形を拡大表示する。表示サイズ固定・1周期ぶん。
  // 軸目盛りは0始まりで、原点0は左下1か所のみ、各軸の最大値(要素数-1)を端に表示する。
  function drawBigWave(canvas, wave, color) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    // 全ての余白・線幅・フォントサイズは基準解像度560px幅に対して調整済みの値を
    // Sでスケールする（キャンバス解像度を変えても比率を保ったまま拡大縮小できる）。
    const S = W / 560;
    // signed: SPC(BRR)のような符号付き16bit系列。桁数が多く("-32768"等)、
    // 既定の余白・フォントだと左端からはみ出すため余白を広げてフォントを一段階小さくする。
    const signed = !!(wave && wave.signed);
    // 軸ラベル用の余白（左=Y目盛り, 下=X目盛り）
    const mL = (signed ? 74 : 56) * S, mR = 18 * S, mT = 14 * S, mB = 38 * S;
    const x0 = mL, x1 = W - mR, y0 = mT, y1 = H - mB;
    const w = x1 - x0, mid = (y0 + y1) / 2, amp = (y1 - y0) / 2;
    const tickGap = 8 * S;

    // プロット枠・中心線
    ctx.strokeStyle = '#3a3a46';
    ctx.lineWidth = 1 * S;
    ctx.strokeRect(x0, y0, w, y1 - y0);
    ctx.beginPath();
    ctx.setLineDash([3 * S, 5 * S]);
    ctx.moveTo(x0, mid); ctx.lineTo(x1, mid);
    ctx.strokeStyle = '#4a4a58';
    ctx.stroke();
    ctx.setLineDash([]);

    if (!wave || wave.t === 'sample') {
      ctx.fillStyle = '#777788';
      ctx.font = Math.round(20 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(wave ? 'PCM (no fixed waveform)' : '—', (x0 + x1) / 2, mid);
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 * S;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (wave.t === 'noise') {
      // 1周期を間引いた離散バーで表示（短=93=実1周期 / 長=32767を省略表示）
      drawNoiseStairs(ctx, wave.short, x0, w, mid, amp);
    } else if (wave.t === 'wave' && wave.layers) {
      // SPC: 素のBRR値(階段状+ドット、他のウェーブテーブル表示と同じ最近傍表現)・
      // ガウス補間後の滑らかな波形(線)・PM変調後(破線)を重ね描き＋凡例
      for (const layer of wave.layers) {
        const d = layer.data;
        if (!d || !d.length) continue;
        ctx.strokeStyle = layer.color;
        ctx.fillStyle = layer.color;
        ctx.setLineDash((layer.dash || []).map(v => v * S));
        if (layer.mode === 'steps') {
          // 階段状(最近傍)表示。BRRデコード直後の生サンプル値をそのまま示す。
          ctx.lineWidth = 2 * S;
          ctx.beginPath();
          for (let i = 0; i <= w; i++) {
            const phase = (i / w) % 1;
            const idx = Math.floor(phase * d.length) % d.length;
            const y = mid - d[idx] * amp;
            const x = x0 + i;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          // サンプル点をドット表示（要素数が視覚的に分かる）
          for (let k = 0; k < d.length; k++) {
            const x = x0 + (k / d.length) * w;
            const y = mid - d[k] * amp;
            ctx.beginPath();
            ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (layer.mode === 'dots') {
          // 出力サンプル(点)。xs[k] は横位置(0〜1、サンプル位置/16)。hollow は輪郭だけ(PM変調後)
          ctx.lineWidth = 1.5 * S;
          for (let k = 0; k < d.length; k++) {
            const x = x0 + (layer.xs ? layer.xs[k] : k / d.length) * w;
            const y = mid - d[k] * amp;
            ctx.beginPath();
            ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
            if (layer.hollow) ctx.stroke(); else ctx.fill();
          }
        } else {
          // ガウス補間後: 連続的な線形補間曲線(横軸=サンプル位置、BRRの階段と同じ)
          ctx.lineWidth = 2.2 * S;
          ctx.beginPath();
          for (let i = 0; i <= w; i++) {
            const phase = (i / w) % 1;
            const x2 = phase * d.length;
            const i0 = Math.floor(x2) % d.length;
            const i1 = (i0 + 1) % d.length;
            const f = x2 - Math.floor(x2);
            const val = d[i0] * (1 - f) + d[i1] * f;
            const y = mid - val * amp;
            const x = x0 + i;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      // 凡例（プロット左上に色見本＋ラベル）
      ctx.font = Math.round(13 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      let ly = y0 + 4 * S;
      for (const layer of wave.layers) {
        ctx.fillStyle = layer.color;
        ctx.fillRect(x0 + 4 * S, ly + 2 * S, 10 * S, 3 * S);
        ctx.fillText(layer.label, x0 + 18 * S, ly);
        ly += 15 * S;
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i <= w; i++) {
        const phase = (i / w) % 1; // 全音源1周期ぶん
        const y = mid - waveSampleValue(wave, phase) * amp;
        const x = x0 + i;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // ウェーブテーブルは各サンプル点をドット表示（要素数が視覚的に分かる）。
      // FM(smooth)の連続波形やDPCMのような大容量データはドットを省く（線のみ）。
      if (wave.t === 'wave' && !wave.smooth && wave.data && wave.data.length && wave.data.length <= 256) {
        const d = wave.data;
        ctx.fillStyle = color;
        for (let k = 0; k < d.length; k++) {
          const x = x0 + (k / d.length) * w;
          const y = mid - d[k] * amp;
          ctx.beginPath();
          ctx.arc(x, y, 3 * S, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (wave.smooth) {
      // FM等の連続波形: 要素数(描画解像度)や振幅は素の値が存在しない(音階/音量/EG依存)
      // ため数値目盛りは出さない。位相=1周期・中心0(相対波形)だけを示す。
      ctx.fillStyle = '#8a8a98';
      ctx.font = Math.round(17 * S) + 'px ' + fontStack('sans');
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText('0', x0 - tickGap, mid); // Y中心(ゼロ交差)のみ
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(T('1 周期 (相対波形)'), x0 + w / 2, y1 + tickGap);
    } else {
      // ウェーブテーブル等: 軸目盛り。signed=trueのPCM系(BRR等)は符号付きレンジ
      // (-ny 〜 0 〜 ny-1。例: ny=32768 なら -32768〜0〜32767)、それ以外は
      // 従来通り0始まり(0 〜 ny-1)で表示する。
      ctx.fillStyle = '#b6b6c6';
      // canvasは var() 非対応。実フォント名を指定
      ctx.font = Math.round((signed ? 18 : 22) * S) + 'px ' + fontStack('mono');
      const nxMax = wave.nx - 1, nyMax = wave.ny - 1;
      const nxMid = Math.floor(nxMax / 2);
      let yBottomLabel, yMidLabel;
      if (signed) {
        yBottomLabel = String(-wave.ny);
        yMidLabel = '0';
      } else {
        const nyMid = Math.floor(nyMax / 2);
        yBottomLabel = '0';
        yMidLabel = nyMid > 0 ? String(nyMid) : null;
      }
      // Y軸（左）: 下=yBottomLabel → 上=nyMax(signed時は符号付き最大値と一致)
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(yBottomLabel, x0 - tickGap, y1);                   // 原点/最小値 (左下)
      if (yMidLabel !== null) ctx.fillText(yMidLabel, x0 - tickGap, mid); // Y中間
      ctx.fillText(String(nyMax), x0 - tickGap, y0);                  // Y最大 (左上)
      // X軸（下）: 左=0 → 右=nxMax
      ctx.textBaseline = 'top';
      if (nxMid > 0) { ctx.textAlign = 'center'; ctx.fillText(String(nxMid), x0 + w / 2, y1 + tickGap); } // X中間
      ctx.textAlign = 'right'; ctx.fillText(String(nxMax), x1, y1 + tickGap); // X最大 (右下)
    }
  }

  // 鍵盤描画。orientation='vertical'(既定)は横並びの鍵盤(鍵の長さ=canvasの高さ、黒鍵は
  // 上=ロール側に付く)、'horizontal'は縦並びの鍵盤(鍵の長さ=canvasの幅、黒鍵は右=ロール側に
  // 付く、高音が上)。音程軸の座標はロール側と同じkeyX()を共有する。
  // visibleWhite/offsetWhite(省略可): 鍵盤全体でなく白鍵visibleWhite本ぶんの音程窓を、白鍵offsetWhite
  // (小数可)から表示する(チャンネルごとのレーン用。ロール側と同じ窓を使う)
  // drums: {lanes:[{label,color}], laneOf:Map(drumKey→レーン番号)} ドラム区画のパッド。
  // 省略/空なら区画なし(音程軸の座標は従来と完全に一致する)。
  // performNotes: 演奏入力(src/ui/performInput.js)で今押されている音のMIDIノート番号。
  // 再生中のチャンネルとは別の色(アクセント色)で点灯させ、自分が弾いた音を区別できるようにする
  function drawPiano(canvas, channels, orientation, visibleWhite, offsetWhite, drums, performNotes) {
    const vertical = orientation !== 'horizontal';
    // 内部解像度は表示サイズ(CSS px、border除く)に合わせる。表示サイズは_cachedWidth/_cachedHeight
    // (ResizeObserverでキャッシュ)を優先し、毎フレームoffsetWidth/clientHeightを読んで
    // 強制レイアウトが走るのを避ける
    const newW = canvas._cachedWidth || canvas.clientWidth || (vertical ? 560 : PIANO_KEY_LEN);
    const newH = canvas._cachedHeight || canvas.clientHeight || (vertical ? PIANO_KEY_LEN : 560);
    if (newW === 0 || newH === 0) return;
    if (canvas.width !== newW) canvas.width = newW;   // サイズ変化時のみ再割り当て（毎フレームのリフロー防止）
    if (canvas.height !== newH) canvas.height = newH;
    const W = canvas.width, H = canvas.height;
    const pitchLen = vertical ? W : H;   // 音程軸の長さ
    const keyLen = vertical ? H : W;     // 鍵の長さ
    const drumLanes = (drums && drums.lanes) || [];
    const drumUnits = drumLanes.length * DRUM_LANE_WHITE;
    const wkW = pitchLen / (visibleWhite || (TOTAL_WHITE + drumUnits));  // 白鍵1本の太さ(音程軸方向)
    const offPx = (offsetWhite || 0) * wkW;  // 表示窓の低音側の端(px)。keyX()の結果からこれを引く
    const drumLaneW = DRUM_LANE_WHITE * wkW;
    const pitchOff = drumUnits * wkW - offPx; // 音程側の座標補正(ドラム区画ぶん右へ + 窓スクロール)
    const bkW = Math.max(3, wkW * 0.60); // 黒鍵の太さ
    const bkH = Math.round(keyLen * 0.62); // 黒鍵の長さ
    const ctx = canvas.getContext('2d');
    // ★クリック位置→ノート番号の逆写像(_noteAtPoint)のために、この描画で使った幾何を
    //   canvasへ焼き付けておく。向き・レーンごとの音程窓・ドラム区画の有無で値が変わるため、
    //   逆写像側で計算し直すと必ずどこかの組み合わせでずれる
    canvas._pianoGeom = { vertical, wkW, bkW, bkH, pitchOff, pitchLen, keyLen, W, H };

    const keyColors = {};
    const laneColors = {}; // ドラム区画: レーン番号 → 今そこを鳴らしているchの色
    for (const ch of channels) {
      if (!ch.active) continue;
      // 打楽器として鳴っているサンプルPCMは音程を持たないのでドラム区画のパッドを光らせる
      if (ch.drumKey && drums && drums.laneOf) {
        const lane = drums.laneOf.get(ch.drumKey);
        if (lane !== undefined && laneColors[lane] === undefined) laneColors[lane] = ch.color;
        continue;
      }
      // パッドに載っている行(_applyPadKeys)で打点が当たっていない間は、音程鍵盤側は光らせない
      // (レート由来の疑似音程D#2に貼り付いて見えるのを避ける)
      if (ch.padRow) continue;
      // ノイズch/DPCM(サンプル)chはそれぞれch.noiseIndex/ch.dmcRateIdxを疑似ノートとして使う
      // (noisePeriodIndexToMidi/dmcRateIndexToMidi冒頭コメント参照)。YM2610 ADPCM-A/Bは
      // 解析済みピッチ(adpcmExact)またはDelta-N由来レートを adpcmPitchToMidi で音程へ。
      const midi = ch.noise ? noisePeriodIndexToMidi(ch.noiseIndex)
        : ch.adpcmPitch ? adpcmPitchToMidi(ch)
        : ch.sample ? dmcRateIndexToMidi(ch.dmcRateIdx)
        : (ch.freq ? freqToMidi(ch.freq) : null);
      if (midi !== null && !keyColors[midi]) keyColors[midi] = ch.color;
    }
    // 自分が弾いている音は再生中の音より手前(上書き)で光らせる
    for (const m of (performNotes || [])) keyColors[m] = PERFORM_KEY_COLOR;

    ctx.clearRect(0, 0, W, H);

    // ドラム区画のパッド(鍵盤の代わり)。1パッド=1サンプル。手前側(=ロールと反対の端)に
    // レーン色の帯とラベルを出し、鳴っている間は鍵と同じくchの色で点灯する。
    for (let i = 0; i < drumLanes.length; i++) {
      const x0 = i * drumLaneW - offPx;
      if (x0 + drumLaneW < 0 || x0 > pitchLen) continue; // 表示窓の外
      const laneColor = drumLanes[i].color || DRUM_OTHER_COLOR;
      const lit = laneColors[i];
      ctx.fillStyle = lit || '#2f2c3a';
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      if (vertical) {
        ctx.fillRect(x0 + 0.5, 0.5, drumLaneW - 1, keyLen - 1);
        ctx.strokeRect(x0 + 0.5, 0.5, drumLaneW - 1, keyLen - 1);
        ctx.fillStyle = laneColor; // ロール側(上端)にレーン色の帯 = ロールの打点の塗りと同じ色
        ctx.fillRect(x0 + 1.5, 1.5, drumLaneW - 3, 5);
        if (drumLaneW >= 9) { // ラベルは縦書き(90度回転)。レーンが細いときは省略
          ctx.save();
          ctx.translate(x0 + drumLaneW / 2, keyLen - 5);
          ctx.rotate(-Math.PI / 2);
          ctx.fillStyle = lit ? '#1a1830' : '#a9a3bb';
          ctx.font = Math.min(9, Math.floor(drumLaneW) - 2) + 'px ' + fontStack('mono');
          ctx.textBaseline = 'middle';
          // ★名前はユーザーが自由に付けられるので、パッドの長さに収める(はみ出すと
          //   隣のレーンや音程鍵盤の上に文字が乗る)
          ctx.fillText(drumLanes[i].label, 0, 0, keyLen - 10);
          ctx.restore();
        }
      } else {
        const y = H - x0 - drumLaneW;
        ctx.fillRect(0.5, y + 0.5, keyLen - 1, drumLaneW - 1);
        ctx.strokeRect(0.5, y + 0.5, keyLen - 1, drumLaneW - 1);
        ctx.fillStyle = laneColor; // ロール側(右端)にレーン色の帯
        ctx.fillRect(keyLen - 6.5, y + 1.5, 5, drumLaneW - 3);
        if (drumLaneW >= 9) {
          ctx.fillStyle = lit ? '#1a1830' : '#a9a3bb';
          ctx.font = Math.min(9, Math.floor(drumLaneW) - 2) + 'px ' + fontStack('mono');
          ctx.textBaseline = 'middle';
          ctx.fillText(drumLanes[i].label, 4, y + drumLaneW / 2 + 0.5, keyLen - 12);
        }
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x += pitchOff;
      if (pos.x + wkW < 0 || pos.x > pitchLen) continue; // 表示窓の外
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#d4cfbc';
      ctx.strokeStyle = '#44404a';
      ctx.lineWidth = 0.5;
      if (vertical) {
        ctx.fillRect(pos.x + 0.5, 0.5, wkW - 1, keyLen - 1);
        ctx.strokeRect(pos.x + 0.5, 0.5, wkW - 1, keyLen - 1);
        if (color) { // 発音中: 手前(下端)に濃い帯
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(pos.x + 0.5, keyLen - 8, wkW - 1, 7);
          ctx.globalAlpha = 1;
        }
        // Cの音名(横向きと同じく鍵に書く)。黒鍵に隠れない手前側=下端寄りへ
        if (semi === 0 && wkW >= 8) {
          ctx.fillStyle = color ? '#1a1830' : '#6b6b7a';
          ctx.font = Math.min(9, Math.floor(wkW) - 1) + 'px ' + fontStack('sans');
          ctx.textBaseline = 'bottom';
          ctx.fillText(midiToName(midi), pos.x + 2, keyLen - 9);
        }
      } else {
        const y = H - pos.x - wkW; // 高音が上: 音程軸pをcanvasの下から上へ
        ctx.fillRect(0.5, y + 0.5, keyLen - 1, wkW - 1);
        ctx.strokeRect(0.5, y + 0.5, keyLen - 1, wkW - 1);
        if (color) { // 発音中: 手前(左端)に濃い帯
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(1, y + 0.5, 7, wkW - 1);
          ctx.globalAlpha = 1;
        }
        // Cの音名は鍵の上(黒鍵に隠れない手前側)に書く。鍵が細すぎるときは省略する
        if (semi === 0 && wkW >= 8) {
          ctx.fillStyle = color ? '#1a1830' : '#6b6b7a';
          ctx.font = Math.min(9, Math.floor(wkW) - 1) + 'px ' + fontStack('sans');
          ctx.textBaseline = 'middle';
          ctx.fillText(midiToName(midi), 10, y + wkW / 2 + 0.5);
        }
      }
    }

    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      const rel = midi - MIDI_MIN;
      const semi = rel % 12;
      if (!IS_BLACK[semi]) continue;
      const pos = keyX(midi, wkW);
      if (!pos) continue;
      pos.x += pitchOff;
      if (pos.x + bkW < 0 || pos.x - bkW > pitchLen) continue; // 表示窓の外
      const color = keyColors[midi];
      ctx.fillStyle = color ? color : '#1a1830';
      if (vertical) {
        ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH);
        if (color) {
          ctx.fillStyle = '#1a1830';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(pos.x - bkW / 2, 0, bkW, bkH * 0.65);
          ctx.globalAlpha = 1;
        }
      } else {
        const y = H - pos.x - bkW / 2;
        ctx.fillRect(keyLen - bkH, y, bkH, bkW); // 黒鍵はロール側(右端)に付く
        if (color) {
          ctx.fillStyle = '#1a1830';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(keyLen - bkH * 0.65, y, bkH * 0.65, bkW);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  // ── KeyboardDisplay クラス ────────────────────────────────────

  class KeyboardDisplay {
    constructor(container) {
      this.container = container;
      container._kbdInstance = this; // 検証/デバッグ用の逆参照(DevToolsからインスタンスに触るため)
      this._state = null;
      this._extraSnaps = null;
      this._chips = [];
      this._rowEls = [];
      this._prevChannels = [];
      this._muteState = new Map(); // channelId → true(muted)
      this._spcVoices = [];       // SPC ボイス状態 [{label,freq,vol,active,color,wave,muted,rawVol,env,volL,volR,pmOn,noiseOn,echoOn}]
      this._spcRowEls = [];       // SPC 用行要素(V0-V7)
      this._spcAllRow = null;     // SPC ALL行(マスター音量/エコー/FIRフィルタ)要素
      this._prevSpcVoices = [];   // 大波形選択用の直近SPCボイス状態
      this._mode = 'nsf';         // 'nsf' | 'spc' — 再生中のファイル種別に応じて表示を排他切替
      this._lastDmc4011 = null;   // DMC $4011 直接書き込み検出用（前回のレジスタ値）
      this._speedDenom = 1;        // 再生速度分母(1〜8。実速度=1/_speedDenom)
      this._rollTimeline = null;  // ピアノロール用ノート区間 [{color, notes:[{startSec,endSec,midi}]}]
      this._drumLanes = [];       // ドラム区画のレーン表 [{key,label,color,subN}](_rebuildDrumLanes)
      this._drumLaneOf = new Map(); // drumKey → レーン番号(鍵盤のパッド点灯用)
      this._drumLaneNames = {};   // drumKey → ユーザーが付けた表示名(ドラム(DPCM)パネルから同期)
      this._rollCursor = {};      // track.id → 「もう画面上端より上に流れ去った」最初のnote index(_renderRollの走査起点キャッシュ)
      this._rollSongTimeBase = 0; // 最後に実測位置が更新された時点での「曲内基準の経過時間」(確定値)
      this._rollLastRawPos = null; // 直前に_renderRollへ渡された実時間(壁時計)位置
      this._rollBaseWallMs = null; // _rollSongTimeBase確定時点のperformance.now()(補間の起点)
      this.onMuteChange = null;
      // 割当プレビュー(「割当先の音で聴く」)。セッション内だけの状態(再読込で必ずOFF=元の音)
      this._previewMode = false;
      this.onPreviewChange = null;      // () => void  ON/OFF・割当・ミュートが変わったとき(main.js syncAssignPreview)
      this.spcLiveRows = null;          // () => rows[] SPC再生中のボイス状態(main.js spcPreviewRows)。getLiveChannels()が使う
      this._poolModes = {};             // チャンネルプール式チップの表示モード(chipToken → 'logical'|'phys')
      this.onPoolModeChange = null;     // (chipToken, mode) => void  ヘッダのモード切替
      this.onSpcMuteChange = null; // (voiceIndex:number, muted:bool) => void
      this.onSpeedChange = null;   // (factor:number) => void  曲切替をまたいで保持する
      this.onMasterVolumeChange = null; // (vol:0〜1) => void  曲切替をまたいで保持する
      this.onLayoutChange = null;       // (layout) => void  setLayout()で設定が変わった時
      this.onRollSeek = null;           // (seconds:実時間) => 実際にシークした秒|null  ロールのドラッグシーク(_attachRollSeekDrag)
      this._rollDrag = null;            // ドラッグシーク中の状態 {id,x,y,startPos,pos,moved}
      this._spotlightHoverId = null;    // スポットライト(案D): ホバー中の行のch.id(一時的)
      this._spotlightPinnedId = null;   // スポットライト(案D): ch名クリックで固定した行のch.id(ホバーより優先)
      this._rollSeekBarEls = null;      // ロール見出し行に置くシークバー要素(setRollSeekBar)
      this._lanes = [];                 // チャンネルごとのレーン [{id, laneEl, rollCanvas, pianoCanvas, offWhite, visWhite}](_rebuildLanes)
      this._laneSizes = new Map();      // id → レーンの音程軸方向のpx。スプリッターで変えた分だけ入る(空=既定の自動割り付け)
      this._lanesEl = null;
      this._sizeObserver = null;
      this._sourceInfo = null;          // 表示中の再生ソース {kind, name}(setSourceInfo)。タイトル行のバッジに出す
      this._srcBadgeEl = null;
      this._titleEl = null;
      this._transportEl = null;         // タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭)。バッジの右に置く
      this._transportBtns = null;       // { prev, play, stop, next }
      // 再生コントロールの状態(main.js が setTransportState() で更新する)。canPrevNext は
      // 「m3u/アーカイブを開いていればその曲送り、実ファイル単体なら曲番号送り」が可能か
      // どうかで、MML再生を表示中は常に false(=グレーアウト)。
      this._transportState = { playing: false, canPlay: false, canStop: false, canPrevNext: false, canToggleSource: false };
      this.onTransport = null;          // (action:'play'|'stop'|'prev'|'next') => void
      this.onSourceToggle = null;       // () => void  バッジ(MML/FILE)クリックでMML↔サウンドファイル切替
      this.onSourceListRequest = null;  // () => { name, listName?, items:[string]|null, index } | null  表示名(アーカイブなら曲名)と曲一覧(main.js)
      this.onSourceSelect = null;       // (index) => void  ファイル名の一覧から曲を選んだとき
      this._rollLastDrawnPos = 0;       // _renderRoll()が最後に描いた曲内秒(ドラッグ開始位置の基準)
      this._pendingSelectionReset = false; // reset()が立てるフラグ。次に実データでチャンネル一覧が
                                            // 判明した時(setSource()/updateSpcVoices())、大波形の選択
                                            // (_selectedId)がそこにも存在すれば維持・無ければ一番若い
                                            // chへ切替える一度きりの判定を行う(_consumePendingSelectionReset)
      this._masterVolume = loadMasterVolume(); // localStorage永続化(mml_masterVolume)
      this.onVolumeChange = null;       // () => void  ch別音量バー操作時(getVolumeConfig()参照)
      this.onAdpcmCalibrate = null;     // (ch) => void  YM2610 ADPCM行のnote列クリック(手動ピッチ補正。ch.adpcmSample={kind,start,end})
      // ドラム区画のパッドクリック試聴。(sampleKey, mode:'raw'|'dpcm') => void
      // ★PCM→DMCは必ず劣化するので、レートを耳で決められることが必須(ユーザー指示)。
      //   パッドは1枚=1サンプルなので「複数chが同時に鳴っていて何を聴いているか分からない」
      //   問題が原理的に起きない。
      this.onDrumAudition = null;
      this._drumAuditionMode = 'raw';
      this.onOpenDrumPanel = null;    // 割当セルの「パッド」ボタン(ドラム(DPCM)パネルを開く)
      this.onOpenTonePanel = null;    // (chId) => void 音色セレクトの「音色ごとに指定…」(音色一覧を開く。main.js)
      this.toneOverrideCount = null;  // (chId) => number そのchの音色のうち音色ごとの指定を持つ数(main.js)
      this.onOpenFile = null;         // ヘッダの「ファイルを開く」
      this.onToMml = null;            // ヘッダの「to MML」
      this.onMaxSecondsChange = null; // ロール見出しの演奏最大時間(秒)が変わったとき (sec) => void
      this.onExport = null;           // ロール見出しの「出力」 (formatId, seconds) => void
      this._exportOpt = null;         // setExportControls() の最後の内容(見出し再構築時に戻す)
      this._exportFmtSig = null;      // 出力形式リストの中身(変わった時だけ作り直す)
      this.onRepeatModeChange = null; // 曲が終わった後の挙動が変わったとき
      this._repeatBtnEl = null;
      this._repeatMode = 'next';
      try {
        const m = localStorage.getItem(REPEAT_MODE_KEY);
        if (m && REPEAT_MODES.indexOf(m) >= 0) this._repeatMode = m;
      } catch (e) { /* ignore */ }
      // (ch, kind:'drum'|'pitch'|null) => void  note列の小メニューでの打楽器/音階の手動指定
      this.onSampleKind = null;
      this._sampleMenuEl = null;
      this._sampleMenuOutside = null;
      this.onSpcVolumeChange = null;    // (volArray:number[8]) => void
      this._channelVolumes = loadChannelVolumes();   // channelId → 0〜2(1=100%、localStorage永続化)
      this._spcVoiceVolumes = loadSpcVoiceVolumes(); // [V0..V7] → 0〜2(1=100%、localStorage永続化)
      this._colorOverrides = loadColorOverrides(); // channelId → ユーザー指定色(localStorage永続化)
      // チャンネル割当(案E): 一覧に「借用先」列を出すか(トグル状態はlocalStorage永続化)。
      // 幅が足りないレイアウトでは列を隠し、part列チップ→ポップオーバー経由で編集する。
      try { this._assignMode = localStorage.getItem('mml_kbdAssignMode') === '1'; } catch (e) { this._assignMode = false; }
      this._assignPop = null;
      this._assignPopClose = null;
      this._layout = loadLayoutSettings();         // ロールの向き/置き場/一覧の多段(localStorage永続化)
      // 下配置でのロール高さ / 右配置での一覧幅(どちらもスプリッターで変更、localStorage永続化)
      this._rollHeight = ROLL_CANVAS_HEIGHT;
      // 一覧/大波形のサイズ(スプリッターで可変。0=未設定でCSS既定)
      this._listRowsHeight = 0;
      this._bigWaveWidth = 0;
      try {
        const rh = parseInt(localStorage.getItem('mml_keyboardRowsHeight'), 10);
        if (Number.isFinite(rh) && rh >= 60) this._listRowsHeight = rh;
        const ww = parseInt(localStorage.getItem('mml_keyboardWaveWidth'), 10);
        if (Number.isFinite(ww) && ww >= 120) this._bigWaveWidth = ww;
      } catch (e) { /* ignore */ }
      this._listWidth = null;
      try {
        const h = parseInt(localStorage.getItem('mml_pianoRollHeight'), 10);
        if (Number.isFinite(h) && h >= 80) this._rollHeight = h;
        const w = parseInt(localStorage.getItem('mml_keyboardListWidth'), 10);
        if (Number.isFinite(w) && w >= 200) this._listWidth = w;
      } catch (e) { /* ignore */ }
      this._rollCollapsed = false;
      this._bigWaveCollapsed = false;
      // ファイル情報ペイン(開いているサウンドファイルのヘッダ情報。旧「サウンドファイルを開く」
      // ウィンドウから移設)。置き場は _layout.fileInfoPlacement、大きさはスプリッターで可変
      this._fileInfoWidth = 0;
      this._fileInfoHeight = 0;
      this._fileInfoCollapsed = false;
      try {
        const fw = parseInt(localStorage.getItem('mml_kbdFileInfoWidth'), 10);
        if (Number.isFinite(fw) && fw >= 120) this._fileInfoWidth = fw;
        const fh = parseInt(localStorage.getItem('mml_kbdFileInfoHeight'), 10);
        if (Number.isFinite(fh) && fh >= 48) this._fileInfoHeight = fh;
        this._fileInfoCollapsed = localStorage.getItem('mml_kbdFileInfoCollapsed') === '1';
      } catch (e) { /* ignore */ }
      // 音源(チップ)ごとのch一覧の折りたたみ。キーは見出し文字列(getChannelDisplay().header)
      // そのもの。音源単位で覚えておきたい設定なので曲やフォーマットをまたいで残す
      this._chipCollapsed = new Set();
      try {
        const raw = JSON.parse(localStorage.getItem('mml_kbdChipCollapsed') || '[]');
        if (Array.isArray(raw)) this._chipCollapsed = new Set(raw.filter(v => typeof v === 'string'));
      } catch (e) { /* ignore */ }
      this._fileInfoTitleKey = '';  // 見出しの原文(日本語)。言語切替のたびにT()で引き直す
      this._fileInfoNodes = [];     // main.jsから預かった表示要素(#xxxFileHeader / #xxxFileStatus)
      this._build();

      /*
       * 言語切替時の作り直し。行のtitle等は "P1 ミュート" のようにチャンネル名を
       * 埋め込んだ文字列なので、i18nDom.js のDOM走査(辞書の完全一致で引く)では
       * 訳せない。T()を通す生成処理そのものを走らせ直す必要がある。
       */
      if (MML.I18n) {
        MML.I18n.onChange(() => {
          const mode = this._mode;
          this._build();               // ウィジェット枠(速度ラベル/ロール見出し/コピーボタン)を作り直す
          // _build() がコンテナを空にするので、行要素の参照も捨てて次のupdate()で作り直させる
          this._rowEls = [];
          this._spcRowEls = [];
          this._spcAllRow = null;
          if (this._prevChannels) this._rebuildRows(this._prevChannels);
          this.setMode(mode);
        });
      }
    }

    _build() {
      // ロールペインは別ウィンドウ(#pianoRollDisplay)に取り付けられていることがあり、
      // container.innerHTML=''では消えないので明示的に外す(言語切替時の作り直し用)
      if (this._rollPaneEl && this._rollPaneEl.parentNode) this._rollPaneEl.parentNode.removeChild(this._rollPaneEl);
      this.container.innerHTML = '';
      this._selectedId = null;   // 大波形表示にユーザーが選んだチャンネルID(ファイル読込でのみリセット)
      this._shownWaveId = null;  // 大波形に今表示しているチャンネルID(選択chが一覧に無い間は若いchを一時表示、_syncShownWave参照)
      this._bigWaveSig = '';     // 大波形の再描画要否判定用

      // 上段: 左=速度バー+チャンネル一覧(+大波形の詳細帯) / 右=選択波形の拡大表示 or ロールペイン
      // (置き場はレイアウト設定で決まる: _mountBigWave()/_mountRollPane()参照。
      //  SPCモードは列数が多いため setMode() で専用レイアウトに切り替える)
      const main = document.createElement('div');
      main.className = 'kbd-main';
      this._mainEl = main;

      const left = document.createElement('div');
      left.className = 'kbd-left';
      this._leftEl = left;

      // マスター音量バー(0〜100%)。フォーマットを問わず全ての音声出力に効く
      // (MML.Audio.getMasterGain、src/audio/stream-player.js参照)。速度バーの
      // すぐ左に置く。localStorageへ即保存し、次回起動時も値を維持する。
      const masterVolBar = document.createElement('div');
      masterVolBar.className = 'kbd-mastervol kbd-mastervol--header';
      const initialPct = Math.round((this._masterVolume != null ? this._masterVolume : 1) * 100);
      masterVolBar.innerHTML =
        `<span class="kbd-mastervol-label">${T('音量')}</span>` +
        `<input type="range" class="kbd-mastervol-range" min="0" max="100" step="1" value="${initialPct}">` +
        `<span class="kbd-mastervol-value">${initialPct}%</span>`;
      const masterVolRange = masterVolBar.querySelector('.kbd-mastervol-range');
      const masterVolValueEl = masterVolBar.querySelector('.kbd-mastervol-value');
      masterVolRange.addEventListener('input', () => {
        const pct = parseInt(masterVolRange.value, 10) || 0;
        const vol = pct / 100;
        this._masterVolume = vol;
        masterVolValueEl.textContent = `${pct}%`;
        saveMasterVolume(vol);
        if (this.onMasterVolumeChange) this.onMasterVolumeChange(vol);
      });

      // 再生速度バー(1/1〜1/8)。音程を保ったままテンポだけを落とす。
      // ウィンドウのタイトル行(タイトル文字の右)に置く。本体側は毎回_build()で
      // 作り直されるため、タイトル行に前回挿入した分を先に取り除いてから差し替える。
      const speedBar = document.createElement('div');
      speedBar.className = 'kbd-speed kbd-speed--header';
      speedBar.innerHTML =
        `<span class="kbd-speed-label">${T('速度')}</span>` +
        `<input type="range" class="kbd-speed-range" min="1" max="8" step="1" value="1">` +
        `<span class="kbd-speed-value">1/1</span>`;
      const speedRange = speedBar.querySelector('.kbd-speed-range');
      const speedValueEl = speedBar.querySelector('.kbd-speed-value');
      speedRange.value = String(this._speedDenom || 1);
      speedValueEl.textContent = `1/${this._speedDenom || 1}`;
      speedRange.addEventListener('input', () => {
        const denom = parseInt(speedRange.value, 10) || 1;
        this._speedDenom = denom;
        speedValueEl.textContent = `1/${denom}`;
        if (this.onSpeedChange) this.onSpeedChange(1 / denom);
      });
      // レイアウト設定ボタン(⚙)。クリックでポップオーバー(_openLayoutPopover)を開く。
      // 速度バーの右(閉じるボタンの手前)に置く
      const layoutBtn = document.createElement('button');
      layoutBtn.type = 'button';
      layoutBtn.className = 'kbd-layout-btn';
      layoutBtn.title = T('鍵盤表示のレイアウト設定');
      layoutBtn.setAttribute('aria-label', T('鍵盤表示のレイアウト設定'));
      layoutBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="1"/><path d="M3 12h14M9 3v9"/></svg>';
      layoutBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openLayoutPopover(layoutBtn); });

      // 再生コントロール(⏮ ▶/⏸ ■ ⏭)。バッジ(=今どちらを表示中かのファイル名)の右に置き、
      // 「今鳴っている方(MML側 / サウンドファイル側)」をそのまま操作する。⏮⏭ は
      // アーカイブ(m3u)を開いていればその曲送り、実ファイル単体なら曲番号送りで、
      // MML再生を表示中は操作対象が無いのでグレーアウトする(setTransportState)。
      const transportBar = this._buildTransportBar();
      // 曲が終わった後の挙動(次の曲 / 1曲リピート / ランダム / 停止)。1つのアイコンが
      // クリックのたびに切り替わる。ファイル名バッジの左に置く
      const repeatBtn = this._buildRepeatBtn();
      // ファイルを開く / to MML。ヘッダ左端(旧「鍵盤表示」の文字の位置)へ移す。
      // 元のツールバー側のボタンをそのまま押す複製なので、動作の実体は1箇所のまま
      const openBtn = this._buildProxyBtn('kbd-open-btn', T('ファイルを開く'),
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5c0-.83.67-1.5 1.5-1.5h3.4l1.4 1.6H16c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5v-8.6Z"/></svg>',
        () => { if (this.onOpenFile) this.onOpenFile(); });
      const toMmlBtn = this._buildProxyBtn('kbd-tomml-btn', T('MMLへ変換'),
        '<span class="kbd-tomml-text">to MML</span>',
        () => { if (this.onToMml) this.onToMml(); });

      const winEl = this.container.closest('.float-window');
      const headerEl = winEl && winEl.querySelector('.float-window-header');
      if (headerEl) {
        for (const sel of ['.kbd-mastervol', '.kbd-speed', '.kbd-layout-btn', '.kbd-src-badge', '.kbd-transport']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        for (const sel of ['.kbd-open-btn', '.kbd-tomml-btn', '.kbd-repeat-btn', '.kbd-src-name']) {
          const old = headerEl.querySelector(sel);
          if (old) old.remove();
        }
        const closeBtn = headerEl.querySelector('.float-window-close');
        headerEl.insertBefore(speedBar, closeBtn || null);
        headerEl.insertBefore(masterVolBar, speedBar);
        // ★ヘッダ左端は「鍵盤表示」という文字ではなく[ファイルを開く][レイアウト][to MML]。
        //   タイトル文字はウィンドウの見出しとして自明なので置かない(ユーザー指示)
        const titleEl = headerEl.querySelector('span');
        if (titleEl && !titleEl.classList.contains('kbd-src-badge')) {
          titleEl.textContent = '';
          titleEl.style.display = 'none';
          this._titleEl = titleEl;
        }
        // 並びは [ファイルを開く][to MML][レイアウト](ユーザー指示で to MML と レイアウトを入れ替え)
        headerEl.insertBefore(openBtn, titleEl || masterVolBar);
        headerEl.insertBefore(toMmlBtn, titleEl || masterVolBar);
        headerEl.insertBefore(layoutBtn, titleEl || masterVolBar);
        this._srcBadgeEl = document.createElement('span');
        this._srcBadgeEl.className = 'kbd-src-badge';
        this._srcBadgeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!this._transportState.canToggleSource) return;
          if (this.onSourceToggle) this.onSourceToggle();
        });
        // 並びは [再生コントロール][MML/FILEバッジ][終了後の挙動][ファイル名/リスト名](ユーザー指示 2026-09-06)。
        // バッジは「今どちらを表示しているか」だけを示し、名前は右の別ボタンに出す。名前のボタンは
        // 曲一覧(アーカイブのm3u/複数曲形式の曲番号)から選べるドロップダウンになる
        this._srcNameEl = document.createElement('button');
        this._srcNameEl.type = 'button';
        this._srcNameEl.className = 'kbd-hdr-btn kbd-src-name';
        this._srcNameEl.addEventListener('click', (e) => { e.stopPropagation(); this._openSourcePopover(); });
        headerEl.insertBefore(this._srcBadgeEl, masterVolBar);
        headerEl.insertBefore(this._srcNameEl, masterVolBar);
        headerEl.insertBefore(transportBar, this._srcBadgeEl);
        headerEl.insertBefore(repeatBtn, this._srcNameEl);
        this._renderSourceBadge();
        this._renderTransport();
      } else {
        left.appendChild(transportBar); // フォールバック(タイトル行が見つからない場合)
        left.appendChild(masterVolBar);
        left.appendChild(speedBar);

        left.appendChild(layoutBtn);
        this._renderTransport();
      }

      const header = document.createElement('div');
      header.className = 'kbd-header';
      header.innerHTML =
        headerAssignBtnHtml() +
        headerMuteAllBtnHtml() +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-assign">${T('借用先')}${headerPreviewBtnHtml()}${headerAssignModeHtml()}</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        headerVolResetBtnHtml() +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbd-h-freq">freq</span>`;
      // L/R列(SPCのステレオパン表示と同じクラスを流用)はHES(PSG)のみ値が入り、
      // 他フォーマットは空欄のまま(_rebuildRows参照)。
      // dot 列オフセット不要（kbd-h-part が dot+パート文字両方をカバー）
      this._headerEl = header;
      // DPCM(打楽器を実サンプルのまま焼く)の実コスト表示。借用先にDPCMを選んだ瞬間に
      // 「1本増やしたらROMが何KB増えるか」が見えないと選びようがないため、割当UIのすぐ下に出す
      // (ユーザー要望。実機ROMの容量を意識する方針 [[nsf-export-size-consciousness]])
      this._dpcmCostEl = document.createElement('div');
      this._dpcmCostEl.className = 'kbd-dpcm-cost';
      this._dpcmCostEl.style.display = 'none';
      // ドラムパッドの下ごしらえ(分離レンダリング)の進捗。曲の長さぶん再エミュレーション
      // するので数十秒〜数分かかる。ドラム(DPCM)パネルを開いていないと何も起きていないように
      // 見えてしまうため、パッドと同じ鍵盤表示の中にも出す(ユーザー要望 2026-09-09)
      this._dpcmStatusEl = document.createElement('div');
      this._dpcmStatusEl.className = 'kbd-dpcm-status';
      this._dpcmStatusEl.style.display = 'none';
      this._dpcmStatusEl.innerHTML = '<span class="kbd-dpcm-status-text"></span>' +
        '<span class="kbd-dpcm-status-bar"><i></i></span>';
      left.appendChild(header);

      this._rowsEl = document.createElement('div');
      this._rowsEl.className = 'kbd-rows';
      // 行本体は内側の要素に入れる(.kbd-rowsは縦スクロールの箱、.kbd-rows-innerが1列/多段の
      // 並べ方を担当。多段のとき高さauto=中身なりに伸びるので、はみ出しは横でなく縦スクロールになる)
      left.appendChild(this._dpcmCostEl);
      left.appendChild(this._dpcmStatusEl);
      this._rowsInnerEl = document.createElement('div');
      this._rowsInnerEl.className = 'kbd-rows-inner';
      this._rowsEl.appendChild(this._rowsInnerEl);
      left.appendChild(this._rowsEl);

      // SPC ボイス用セクション（再生中のみ表示）。列数がNSFと異なるため専用ヘッダーを持つが、
      // NSF側と同じく left 直下に置く（left 側の幅は .kbd-left--spc で少し広げる）。
      // ボイス単位のレジスタが無いマスター値(エコー音量L/R、FIR係数C0-C7)は列にせず、
      // ALL行の下の1行(.kbds-master、updateSpcVoices参照)にまとめて表示する。
      this._spcHeaderEl = document.createElement('div');
      this._spcHeaderEl.className = 'kbd-header kbds-header';
      this._spcHeaderEl.style.display = 'none';
      this._spcHeaderEl.innerHTML =
        headerAssignBtnHtml() +
        headerMuteAllBtnHtml() +
        `<span class="kbd-h-name">ch</span>` +
        `<span class="kbd-h-assign">${T('借用先')}${headerPreviewBtnHtml()}${headerAssignModeHtml()}</span>` +
        `<span class="kbds-h-lr kbds-h-l">L</span>` +
        `<span class="kbds-h-lr">R</span>` +
        headerVolResetBtnHtml() +
        `<span class="kbds-h-env">env</span>` +
        `<span class="kbd-h-wave">wave</span>` +
        `<span class="kbds-h-pm">PM</span>` +
        `<span class="kbd-h-note">note</span>` +
        `<span class="kbds-h-freq">freq</span>` +
        `<span class="kbds-h-echo">echo</span>`;
      left.appendChild(this._spcHeaderEl);

      this._spcSectionEl = document.createElement('div');
      this._spcSectionEl.className = 'kbd-rows';
      this._spcSectionEl.style.display = 'none';
      left.appendChild(this._spcSectionEl);

      // 見出しのボタン(part列=チャンネル割当トグル / mute列=一括ミュート)を配線する。
      // メイン一覧とSPC一覧で見出しが2つあるので、両方まとめて拾って同じ動作にする。
      this._assignBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-assign-btn'));
      for (const b of this._assignBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._setAssignMode(!this._assignMode); });
      }
      this._previewBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-preview-btn'));
      for (const b of this._previewBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._setPreviewMode(!this._previewMode); });
      }
      this._renderPreviewToggle();
      this._muteAllBtns = Array.prototype.slice.call(left.querySelectorAll('.kbd-muteall-btn'));
      for (const b of this._muteAllBtns) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._toggleAllMute(); });
      }
      for (const b of left.querySelectorAll('.kbd-volreset-btn')) {
        b.addEventListener('click', (e) => { e.stopPropagation(); this._resetAllVolumes(); });
      }

      // 選択チャンネルの素波形を拡大表示（表示サイズ固定・要素数はX/Y数値で表現）。
      // 置き場は一覧の右(従来)または一覧の下の折りたたみ帯(_mountBigWave()参照)
      const big = document.createElement('div');
      big.className = 'kbd-bigwave';
      const bigHeader = document.createElement('div');
      bigHeader.className = 'kbd-bigwave-header';
      // 折りたたみトグル(一覧の下に置く配置でだけ表示。状態はlocalStorageに保存)。既定は畳んだ状態
      // (一覧の高さを優先)で、波形アイコンをクリックして選んだときに自動で開く(_selectWave参照)
      try { this._bigWaveCollapsed = localStorage.getItem('mml_bigWaveCollapsed') !== '0'; } catch (e) { this._bigWaveCollapsed = true; }
      this._bigToggleEl = document.createElement('span');
      this._bigToggleEl.className = 'kbd-bigwave-toggle';
      this._bigToggleEl.textContent = this._bigWaveCollapsed ? '▶' : '▼';
      this._bigToggleEl.title = T('大波形の表示/非表示');
      this._bigToggleEl.addEventListener('click', () => {
        this._bigWaveCollapsed = !this._bigWaveCollapsed;
        try { localStorage.setItem('mml_bigWaveCollapsed', this._bigWaveCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      });
      this._bigTitleEl = document.createElement('div');
      this._bigTitleEl.className = 'kbd-bigwave-title';
      this._bigTitleEl.textContent = 'Click a wave icon to enlarge';
      // 波形エディタ(FDS波形エディタ等)との相互コピペ用。実際の波形テーブルを
      // 持つ表示(t:'wave')のときだけ有効化する(ノイズ/PCM等は固有波形が無いため不可)
      this._bigCopyBtn = document.createElement('button');
      this._bigCopyBtn.className = 'kbd-bigwave-copy secondary';
      this._bigCopyBtn.textContent = T('📋波形');
      this._bigCopyBtn.title = T('この波形データをクリップボードへコピー(他の波形エディタへ貼り付け可)');
      this._bigCopyBtn.disabled = true;
      this._bigWaveCopyData = null;
      this._bigCopyBtn.addEventListener('click', () => {
        if (!this._bigWaveCopyData || !(MML.UI && MML.UI.WaveClipboard)) return;
        MML.UI.WaveClipboard.copyValues(this._bigWaveCopyData).then((ok) => {
          const orig = T('📋波形');
          this._bigCopyBtn.textContent = ok ? T('✓ コピー完了') : T('✗ 失敗');
          setTimeout(() => { this._bigCopyBtn.textContent = orig; }, 1000);
        });
      });
      // FM音色データ(OPLL/VRC7=@OT形式、YM2612/YM2610=OPN形式)のコピー。大波形の下の
      // テキスト(_bigPatchEl)と同じ内容をクリップボードへ(formatFmPatch参照)
      this._bigPatchCopyBtn = document.createElement('button');
      this._bigPatchCopyBtn.className = 'kbd-bigwave-copy secondary';
      this._bigPatchCopyBtn.textContent = T('📋音色');
      this._bigPatchCopyBtn.title = T('このFM音色データ(下のテキスト)をクリップボードへコピー');
      this._bigPatchCopyBtn.style.display = 'none';
      this._bigPatchText = null;
      this._bigPatchCopyBtn.addEventListener('click', () => {
        if (!this._bigPatchText) return;
        const orig = T('📋音色');
        navigator.clipboard.writeText(this._bigPatchText).then(
          () => { this._bigPatchCopyBtn.textContent = T('✓ コピー完了'); },
          () => { this._bigPatchCopyBtn.textContent = T('✗ 失敗'); }
        ).finally(() => setTimeout(() => { this._bigPatchCopyBtn.textContent = orig; }, 1000));
      });
      // 音色データの書式選択(FM_PATCH_FORMATS: OPN=PMD/FMP7/MUCOM88/レジスタ、OPLL=@OT/@v/@OP)。
      // FMチャンネル選択時だけ表示、選択は音源種別ごとにlocalStorageへ保存
      this._bigPatchFmtSel = document.createElement('select');
      this._bigPatchFmtSel.className = 'kbd-bigwave-fmt';
      this._bigPatchFmtSel.title = T('音色データの書式');
      this._bigPatchFmtSel.style.display = 'none';
      this._bigPatchFmtType = null; // 今optionを入れてある音源種別('opn'/'opll')
      this._bigPatchCh = null;      // 音色テキストを出している対象ch(書式変更時の再描画用)
      this._bigPatchFmtSel.addEventListener('change', () => {
        if (!this._bigPatchFmtType) return;
        setFmPatchFormat(this._bigPatchFmtType, this._bigPatchFmtSel.value);
        this._bigPatchText = null; // 強制更新
        if (this._bigPatchCh) this._renderBigWave(this._bigPatchCh);
      });
      bigHeader.appendChild(this._bigToggleEl);
      bigHeader.appendChild(this._bigTitleEl);
      bigHeader.appendChild(this._bigCopyBtn);
      bigHeader.appendChild(this._bigPatchFmtSel);
      bigHeader.appendChild(this._bigPatchCopyBtn);
      this._bigCanvas = document.createElement('canvas');
      this._bigCanvas.className = 'kbd-bigwave-canvas';
      this._bigCanvas.width = 560;   // 内部解像度(表示の2倍)。表示サイズは.kbd-bigwave-canvasで指定
      this._bigCanvas.height = 280;
      // 表示サイズが変わったら(一覧の下に幅いっぱいで置く配置など)内部解像度を表示幅の2倍に
      // 合わせて描き直す(drawBigWave()は幅基準でスケールするので解像度が変わっても比率は保たれる)。
      // ★高さは表示高さから取らず常に幅の1/2にする: height:autoのcanvasは属性の縦横比で表示高さが
      // 決まるため、表示高さ→属性高さと決めると互いに追いかけて比率が崩れる
      new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cw = Math.round(entry.contentRect.width * 2), chh = Math.round(cw / 2);
          if (cw <= 0 || chh <= 0) continue;
          if (this._bigCanvas.width === cw && this._bigCanvas.height === chh) continue;
          this._bigCanvas.width = cw;
          this._bigCanvas.height = chh;
          this._bigWaveSig = '';
          if (this._shownWaveId) {
            const sel = (this._prevChannels || []).concat(this._prevSpcVoices || []).find(c => c.id === this._shownWaveId);
            if (sel) this._renderBigWave(sel);
          }
        }
      }).observe(this._bigCanvas);
      big.appendChild(bigHeader);
      // 本体 = 大波形canvas + FM音色データ(FMチャンネル選択時のみ表示、_renderBigWave が更新)。
      // 音色データの箱は大波形と同じ大きさ(CSS .kbd-bigwave-patch)で、置き場は
      //  ・ロールが右(大波形が一覧の左下)      → 大波形の下(従来どおり)
      //  ・ロールが下で一覧が1列               → 大波形の下
      //  ・ロールが下/別窓で一覧が幅に応じて多段 → 大波形の右(.kbd-bigwave--patch-right、_applyLayoutClasses)
      const bigBody = document.createElement('div');
      bigBody.className = 'kbd-bigwave-body';
      bigBody.appendChild(this._bigCanvas);
      this._bigPatchEl = document.createElement('pre');
      this._bigPatchEl.className = 'kbd-bigwave-patch';
      this._bigPatchEl.style.display = 'none';
      bigBody.appendChild(this._bigPatchEl);
      big.appendChild(bigBody);
      this._bigWaveEl = big;

      // ファイル情報ペイン(見出し=折りたたみトグル+タイトル / 本体=main.jsから預かる
      // #xxxFileHeader・#xxxFileStatus の置き場)。旧「サウンドファイルを開く」ウィンドウに
      // 唯一残っていたヘッダ情報を鍵盤表示へ引き取ったもの(ユーザー指示 2026-09-10)。
      // 置き場(上/下/左/右/自動)はレイアウト設定で選ぶ → _mountPanes()
      const fi = document.createElement('div');
      fi.className = 'kbd-fileinfo';
      const fiHeader = document.createElement('div');
      fiHeader.className = 'kbd-fileinfo-header';
      this._fiToggleEl = document.createElement('span');
      this._fiToggleEl.className = 'kbd-fileinfo-toggle';
      this._fiToggleEl.textContent = this._fileInfoCollapsed ? '▶' : '▼';
      this._fiTitleEl = document.createElement('div');
      this._fiTitleEl.className = 'kbd-fileinfo-title';
      fiHeader.title = T('ファイル情報の表示/非表示');
      fiHeader.addEventListener('click', () => {
        this._fileInfoCollapsed = !this._fileInfoCollapsed;
        try { localStorage.setItem('mml_kbdFileInfoCollapsed', this._fileInfoCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      });
      fiHeader.appendChild(this._fiToggleEl);
      fiHeader.appendChild(this._fiTitleEl);
      this._fiBodyEl = document.createElement('div');
      this._fiBodyEl.className = 'kbd-fileinfo-body';
      fi.appendChild(fiHeader);
      fi.appendChild(this._fiBodyEl);
      this._fileInfoEl = fi;
      this._renderFileInfo();

      // 一覧の下の帯。大波形とファイル情報のうち「一覧の下」に置かれる方が入る箱で、
      // 両方が下に来たときは左右に並ぶ(ファイル情報が左、大波形が右)
      this._belowEl = document.createElement('div');
      this._belowEl.className = 'kbd-below';

      // 一覧と右隣(大波形 or ロールペイン)の間のスプリッター(ロールを右に置く配置でのみ表示。
      // ドラッグで一覧の幅を変える。幅はlocalStorageに保存)
      this._listSplitterEl = this._makeSplitter('vertical', (delta, start) => {
        const w = Math.max(200, Math.round(start + delta));
        this._listWidth = w;
        left.style.width = w + 'px';
      }, () => left.offsetWidth, () => {
        try { localStorage.setItem('mml_keyboardListWidth', String(this._listWidth)); } catch (e) { /* ignore */ }
      });
      // 一覧(音源ごとのCH表示)と大波形の間のスプリッター。大波形が一覧の下にあるとき(縦並び)
      // はCH一覧の高さを、右にあるとき(横並び)は大波形の幅を変える。ユーザー要望で
      // 「各表示の境目でサイズを変えられる」ようにするためのもの
      // ★対象は「いま見えている一覧」(_activeRowsEl)。SPC再生中はボイス一覧が別要素
      //   (_spcSectionEl)で、隠れている _rowsEl の高さを変えても何も起きなかった
      //   (ユーザー報告「SPC鳴らしてるときch枠が下に広げられない」2026-09-10)
      this._waveSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
        const h = Math.max(60, Math.round(start + delta));
        this._listRowsHeight = h;
        const el = this._activeRowsEl();
        el.style.flex = 'none';
        el.style.height = h + 'px';
      }, () => this._activeRowsEl().offsetHeight, () => {
        try { localStorage.setItem('mml_keyboardRowsHeight', String(this._listRowsHeight)); } catch (e) { /* ignore */ }
      });
      this._waveSplitterVEl = this._makeSplitter('vertical', (delta, start) => {
        const w = Math.max(120, Math.round(start - delta)); // 左へドラッグ=大波形が広くなる
        this._bigWaveWidth = w;
        this._bigWaveEl.style.flex = 'none';
        this._bigWaveEl.style.width = w + 'px';
      }, () => this._bigWaveEl.offsetWidth, () => {
        try { localStorage.setItem('mml_keyboardWaveWidth', String(this._bigWaveWidth)); } catch (e) { /* ignore */ }
      });
      // 一覧(上段)とロールペイン(下段)の間のスプリッター(ロールを下に置く配置でのみ表示。
      // ドラッグでロールの高さを変える。高さはlocalStorageに保存)
      this._rollSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
        const h = Math.max(80, Math.round(start - delta)); // 上へドラッグ=ロールが高くなる
        this._setRollHeight(h);
      }, () => this._rollHeight, () => {
        try { localStorage.setItem('mml_pianoRollHeight', String(this._rollHeight)); } catch (e) { /* ignore */ }
      });

      main.appendChild(left);
      this.container.appendChild(main);

      // ピアノロール+鍵盤(ロールペイン)。自己完結したDOM塊として作り、レイアウト設定に
      // 応じた置き場(一覧の下/右/別ウィンドウ)へ_mountRollPane()で取り付ける。
      this._buildRollPane();
      this._mountRollPane();
      this._mountPanes();
      this._leftEl.classList.toggle('kbd-left--assign', !!this._assignMode && !sourceIsMml);
      this._applyLayoutClasses();
      // チャンネル割当が変わったら(この鍵盤表示のセレクト経由でも、他のUI経由でも)
      // part列の文字・スキップ減光・重複警告を貼り直す
      // ★_build()は言語切替のたびに走るので、購読は初回だけ(毎回足すとリスナーが増え続ける)
      const plan = channelPlan();
      if (plan && !this._planHooked) {
        this._planHooked = true;
        plan.onChange(() => this._refreshAssignUi());
      }
      this._renderAssignToggle();
    }

    // ドラッグ可能な仕切り。orientation='vertical'は縦線(左右のペインを分ける、横ドラッグ)、
    // 'horizontal'は横線(上下のペインを分ける、縦ドラッグ)。
    // onDrag(delta, startSize): ドラッグ中に毎回、startSizeはgetStart()でドラッグ開始時に取得。
    // onEnd(): ドラッグ終了時(永続化用)。
    _makeSplitter(orientation, onDrag, getStart, onEnd) {
      const el = document.createElement('div');
      el.className = 'kbd-splitter kbd-splitter--' + orientation;
      let startPos = 0, startSize = 0, active = false;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        active = true;
        startPos = orientation === 'vertical' ? e.clientX : e.clientY;
        startSize = getStart();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => {
        if (!active) return;
        const cur = orientation === 'vertical' ? e.clientX : e.clientY;
        onDrag(cur - startPos, startSize);
      });
      const finish = (e) => {
        if (!active) return;
        active = false;
        el.classList.remove('dragging');
        try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (onEnd) onEnd();
      };
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
      return el;
    }

    // ロールを一覧の下に置く配置でのロールcanvasの高さ(px)を設定する(スプリッター/初期化から)
    _setRollHeight(h) {
      this._rollHeight = h;
      if (this._rollCanvas) this._applyLayoutClasses(); // ロールcanvas/レーン群の高さへ反映
    }

    // ── ロールペイン(ピアノロール見出し+ロールcanvas+鍵盤canvas)の構築 ─────────
    // ロールは未来の音符を鍵盤へ向かって流して表示する(向きは_layout.rollOrientation、
    // 座標系はmakeRollGeom()参照)。折りたたみ状態は localStorage に保存し次回起動時も維持する。
    _buildRollPane() {
      const rollWrap = document.createElement('div');
      rollWrap.className = 'kbd-roll-wrap';
      this._rollPaneEl = rollWrap;
      const rollHeader = document.createElement('div');
      rollHeader.className = 'kbd-roll-header';
      let rollCollapsed = false;
      try { rollCollapsed = localStorage.getItem('mml_pianoRollCollapsed') === '1'; } catch (e) { /* ignore */ }
      try { this._showCentsOverlay = localStorage.getItem('mml_pianoRollCentsOverlay') === '1'; } catch (e) { this._showCentsOverlay = false; }
      rollHeader.innerHTML =
        `<span class="kbd-roll-toggle">${rollCollapsed ? '▶' : '▼'}</span>` +
        `<span class="kbd-roll-label">${T('ピアノロール')}</span>` +
        `<span class="kbd-roll-seek-slot"></span>` + // main.jsから渡されるシークバー(setRollSeekBar)の置き場
        // 演奏最大時間(秒)+出力。時間表示の「/ 総時間」だった場所を入力欄にして、
        // その右に出力形式と出力ボタンを置く(ユーザー指示 2026-09-09)。
        // 実体は各フォーマットのパネルにある再生時間欄/書き出しボタンで、ここはその代理
        `<span class="kbd-roll-export" style="display:none">` +
          `<span class="kbd-roll-export-sep">/</span>` +
          `<input type="number" class="kbd-max-sec" min="1" max="3600" step="1" title="${T('演奏最大時間(秒)')}">` +
          `<span class="kbd-roll-export-unit">${T('秒')}</span>` +
          `<select class="kbd-export-fmt" title="${T('出力形式')}"></select>` +
          `<button type="button" class="kbd-export-btn" title="${T('この長さで書き出す')}">${T('出力')}</button>` +
        `</span>` +
        `<span class="kbd-roll-drum-audition" style="display:none">` +
          `<span class="kbd-roll-drum-label">${T('パッド試聴')}</span>` +
          `<button type="button" class="kbd-drum-aud-btn kbd-drum-aud-btn--on" data-mode="raw">${T('原音')}</button>` +
          `<button type="button" class="kbd-drum-aud-btn" data-mode="dpcm">DPCM</button>` +
        `</span>` +
        `<label class="kbd-roll-cents-toggle">` +
        `<input type="checkbox" class="kbd-roll-cents-checkbox"${this._showCentsOverlay ? ' checked' : ''}>` +
        `${T('セント偏差')}</label>`;
      // シークバー(range input/ハンドル)の操作でロールの折りたたみ(見出しclick)を起こさない
      const seekSlot = rollHeader.querySelector('.kbd-roll-seek-slot');
      seekSlot.addEventListener('click', (e) => e.stopPropagation());
      seekSlot.addEventListener('mousedown', (e) => e.stopPropagation());
      this._mountRollSeekBar(seekSlot);
      // 演奏最大時間+出力(setExportControls で main.js から中身と表示可否をもらう)
      this._exportEl = rollHeader.querySelector('.kbd-roll-export');
      this._maxSecEl = rollHeader.querySelector('.kbd-max-sec');
      this._exportFmtEl = rollHeader.querySelector('.kbd-export-fmt');
      const exportBtn = rollHeader.querySelector('.kbd-export-btn');
      // 見出し行のクリック(ロールの折りたたみ)を起こさない
      this._exportEl.addEventListener('click', (e) => e.stopPropagation());
      this._exportEl.addEventListener('mousedown', (e) => e.stopPropagation());
      this._maxSecEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this._maxSecEl.blur(); });
      this._maxSecEl.addEventListener('change', () => {
        const v = Math.max(1, Math.min(3600, parseInt(this._maxSecEl.value, 10) || 0));
        this._maxSecEl.value = String(v);
        if (this.onMaxSecondsChange) this.onMaxSecondsChange(v);
      });
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.onExport) return;
        const sec = Math.max(1, Math.min(3600, parseInt(this._maxSecEl.value, 10) || 0));
        this.onExport(this._exportFmtEl.value, sec);
      });
      // 言語切替で見出しを作り直した後も状態を戻す(selectは新品なので必ず作り直させる)
      this._exportFmtSig = null;
      this.setExportControls(this._exportOpt);
      // オーバーレイのON/OFFはロール見出しクリック(折りたたみ)とは独立させるため、
      // クリックイベントの伝播をここで止める(bubbling先のrollHeaderハンドラを発火させない)。
      // ドラム区画のパッド試聴の切替(原音 / DPCM変換後)。区画があるときだけ出す
      this._drumAuditionEl = rollHeader.querySelector('.kbd-roll-drum-audition');
      for (const btn of rollHeader.querySelectorAll('.kbd-drum-aud-btn')) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._drumAuditionMode = btn.dataset.mode;
          for (const b of rollHeader.querySelectorAll('.kbd-drum-aud-btn')) {
            b.classList.toggle('kbd-drum-aud-btn--on', b.dataset.mode === this._drumAuditionMode);
          }
        });
      }

      const centsCheckbox = rollHeader.querySelector('.kbd-roll-cents-checkbox');
      centsCheckbox.addEventListener('click', (e) => e.stopPropagation());
      centsCheckbox.addEventListener('change', () => {
        this._showCentsOverlay = centsCheckbox.checked;
        try { localStorage.setItem('mml_pianoRollCentsOverlay', this._showCentsOverlay ? '1' : '0'); } catch (e) { /* ignore */ }
      });
      this._rollCanvas = document.createElement('canvas');
      this._rollCanvas.className = 'kbd-roll';
      this._rollCanvas.height = ROLL_CANVAS_HEIGHT;
      // 折りたたみは「一覧の下」配置でのみ有効(右/別ウィンドウ配置ではロールがペインの
      // 主役なので畳む意味が薄く、別ウィンドウは閉じれば済む)。表示状態の反映は
      // _applyLayoutClasses()に集約する
      rollHeader.addEventListener('click', () => {
        if (this._effectivePlacement() !== 'bottom') return;
        const collapsed = !this._rollCollapsed;
        this._rollCollapsed = collapsed;
        try { localStorage.setItem('mml_pianoRollCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        // 畳んだらロールの高さぶんウィンドウ自体を縮め(=鍵盤が上へ詰まる)、
        // 開いたらロールの高さぶん広げる(=鍵盤がロールの下へ移動する)。
        // こうしないとチャンネル一覧(.kbd-main, flex:1 1 auto)が伸縮を全部吸収してしまい、
        // 折りたたんでも窓の高さが変わらず鍵盤の位置も動かない。増減量はペインの実測高さの
        // 差分(まとめ表示ならロール高さ、レーン表示ならレーン全体の高さ)。
        // 高さの永続化は floatingWindows.js の ResizeObserver → persist() が行う。
        const win = rollWrap.closest('.float-window');
        const before = rollWrap.offsetHeight;
        this._applyLayoutClasses();
        const after = rollWrap.offsetHeight;
        if (win) {
          const cur = parseInt(win.style.height, 10) || win.offsetHeight;
          win.style.height = Math.max(MIN_WINDOW_HEIGHT, cur + (after - before)) + 'px';
        }
      });
      this._rollCollapsed = rollCollapsed;
      this._rollHeaderEl = rollHeader;
      this._attachRollSeekDrag(this._rollCanvas);

      // 鍵盤canvas。ロールと同じペインに入れる(音符が鍵盤へ流れ着く一体表示のため、
      // ロールの置き場が変わっても必ず一緒に動く)
      this._canvas = document.createElement('canvas');
      this._canvas.className = 'kbd-piano';
      this._canvas.height = PIANO_KEY_LEN;
      // 鍵盤canvasはサイズ決め用のラッパー(.kbd-piano-wrap)の中に絶対配置で入れる。
      // canvas要素はwidth/height属性が「固有サイズ」としてレイアウトに効くため、横向きの
      // 横並びレイアウトで古い属性値(前の配置での高さ)が行の高さを押し広げてしまう。
      // 絶対配置ならレイアウトに寄与せず、常にラッパーのサイズに追随する
      const pianoWrap = document.createElement('div');
      pianoWrap.className = 'kbd-piano-wrap';
      pianoWrap.appendChild(this._canvas);
      this._pianoWrapEl = pianoWrap;

      // 本体(ロール+鍵盤)。縦向きは縦積み(ロールの下に鍵盤)、横向きは横並び(鍵盤の右にロール)。
      // 向きの切替はCSSクラス(.kbd-roll-wrap--horizontal)で行う(_applyLayoutClasses参照)
      const body = document.createElement('div');
      body.className = 'kbd-roll-body';
      body.appendChild(this._rollCanvas);
      body.appendChild(pianoWrap);
      this._rollBodyEl = body;

      // チャンネルごとのレーン表示(rollLanes='perChannel')用のコンテナ。中身(各レーンの
      // ロール+鍵盤canvas)は_rebuildLanes()が使用チャンネルに合わせて作り直す。
      // 縦向きはレーンが横に並び(横スクロール)、横向きは縦に積まれる(縦スクロール)
      const lanes = document.createElement('div');
      lanes.className = 'kbd-lanes';
      this._lanesEl = lanes;
      this._lanes = [];

      rollWrap.appendChild(rollHeader);
      rollWrap.appendChild(body);
      rollWrap.appendChild(lanes);

      // drawPiano()/_renderRoll()は毎フレーム(60fps)canvasの表示サイズを必要とするが、
      // canvas.offsetWidth/Heightを直接読むと毎回強制同期レイアウトが走る(要素のサイズ自体は
      // リサイズ時以外変わらないのに)。MML再生ハイライト機能の毎フレームDOM更新と
      // 同じフレーム内で両方が動くと、この強制レイアウトがお互いの保留中のDOM変更を
      // 巻き込んで重くなる(レイアウトスラッシング)。ResizeObserverで実際にリサイズ
      // された時だけ幅・高さをキャッシュし、毎フレームの読み取りをキャッシュ参照に置き換える
      // (レーンのcanvasも_rebuildLanes()で同じオブザーバに登録する)
      this._sizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          entry.target._cachedWidth = Math.round(entry.contentRect.width);
          entry.target._cachedHeight = Math.round(entry.contentRect.height);
        }
      });
      this._sizeObserver.observe(this._rollCanvas);
      this._sizeObserver.observe(this._canvas);
      this._rebuildLanes();
      this._applyLayoutClasses();
    }

    // チャンネルごとのレーン表示の中身を、現在の一覧(NSF等: _rowEls / SPC: _spcRowEls)に
    // 合わせて作り直す。各レーンは [ラベル(色丸+パート文字+ch名)] + [ロールcanvas+鍵盤canvas]で、
    // 間にはドラッグで大きさ(=拡大率)を変えるスプリッターを挟む。
    // 一覧が組み直された時(_rebuildRows/updateSpcVoices/setMode)と設定切替時に呼ぶ。
    // 'all'モードでは中身を空にしておく(描画コストをかけない)
    _rebuildLanes() {
      const lanesEl = this._lanesEl;
      if (!lanesEl) return;
      // 古いcanvasの監視解除
      for (const l of this._lanes) {
        try { this._sizeObserver.unobserve(l.rollCanvas); this._sizeObserver.unobserve(l.pianoCanvas); } catch (e) { /* ignore */ }
      }
      const prevIds = this._lanes.map(l => l.id).join('\u0000');
      this._lanes = [];
      lanesEl.innerHTML = '';
      if (this._layout.rollLanes !== 'perChannel') return;
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.waveCanvas);
      // チャンネルの顔ぶれが変わったら(=別の曲/別のフォーマット)、手で変えた大きさは捨てて既定へ戻す
      if (rows.map(r => r.id).join('\u0000') !== prevIds) this._laneSizes.clear();
      // 区画の単位: 既定は1行1区画。laneGroup を持つ行(PSF のトラックモード)は同じトラックの声部と
      // その複製をまとめて1区画にする(和音が声部ごとにバラバラの区画へ散らないように)
      const groups = [];
      const groupByKey = new Map();
      for (const rowEl of rows) {
        const g = rowEl.laneGroup ? groupByKey.get(rowEl.laneGroup) : null;
        if (g) { g.push(rowEl); continue; }
        const fresh = [rowEl];
        if (rowEl.laneGroup) groupByKey.set(rowEl.laneGroup, fresh);
        groups.push(fresh);
      }
      for (const groupRows of groups) {
        const rowEl = groupRows[0];
        if (this._lanes.length) lanesEl.appendChild(this._makeLaneSplitter(this._lanes.length - 1));
        const lane = document.createElement('div');
        lane.className = 'kbd-lane';
        const label = document.createElement('div');
        label.className = 'kbd-lane-label';
        const nameEl = rowEl.row.querySelector('.kbd-name');
        const laneName = rowEl.laneGroup || (nameEl ? nameEl.textContent : rowEl.id);
        const letters = groupRows.map(r => r.letter).filter(Boolean).join(' ');
        label.innerHTML = `<span class="kbd-lane-dot" style="background:${rowEl.color}"></span>` +
          `<span class="kbd-lane-text">${letters ? letters + ' ' : ''}${laneName}</span>`;
        label.title = groupRows.map(r => r.id + (r.laneCopy ? ' ≈' : '')).join(', ');
        const rollCanvas = document.createElement('canvas');
        rollCanvas.className = 'kbd-roll';
        rollCanvas.height = ROLL_CANVAS_HEIGHT;
        this._attachRollSeekDrag(rollCanvas);
        const pianoCanvas = document.createElement('canvas');
        pianoCanvas.className = 'kbd-piano';
        pianoCanvas.height = PIANO_KEY_LEN;
        const pianoWrap = document.createElement('div');
        pianoWrap.className = 'kbd-piano-wrap';
        pianoWrap.appendChild(pianoCanvas);
        const body = document.createElement('div');
        body.className = 'kbd-roll-body kbd-lane-body';
        body.appendChild(rollCanvas);
        body.appendChild(pianoWrap);
        lane.appendChild(label);
        lane.appendChild(body);
        lanesEl.appendChild(lane);
        this._sizeObserver.observe(rollCanvas);
        this._sizeObserver.observe(pianoCanvas);
        // offWhite/visWhite(音程窓)は_updateLaneRanges()がタイムラインから決める。
        // それまでの初期値は鍵盤全体(まとめ表示と同じ見え方)
        this._lanes.push({ id: rowEl.id, ids: groupRows.map(r => r.id), laneEl: lane, rollCanvas, pianoCanvas, offWhite: 0, visWhite: 0, rangeKnown: false });
      }
      this._updateLaneRanges();
    }

    // レーンの境目のスプリッター。ドラッグでその手前(縦向き=左、横向き=上)のレーンの大きさを
    // 変える = そのchのロール/鍵盤だけが拡大縮小する。全体が入り切らなくなったぶんは
    // .kbd-lanes がスクロールする。ダブルクリックで全レーンを既定の大きさへ戻す。
    _makeLaneSplitter(index) {
      const horizontal = this._layout.rollOrientation === 'horizontal';
      const el = this._makeSplitter(horizontal ? 'horizontal' : 'vertical', (delta, start) => {
        const lane = this._lanes[index];
        if (!lane) return;
        this._laneSizes.set(lane.id, Math.max(LANE_MIN_PX, Math.round(start + delta)));
        this._applyLaneSizes();
      }, () => {
        // 掴んだ瞬間に全レーンの「今の実寸」を固定値へ焼き付ける。自動割り付け(flex-grow)の
        // ままだと1つ変えた余りが他レーンへ再配分され、掴んだ境目がポインタからズレるため
        this._freezeLaneSizes();
        const lane = this._lanes[index];
        return lane ? (this._laneSizes.get(lane.id) || 0) : 0;
      });
      el.classList.add('kbd-lane-splitter');
      el.title = T('ドラッグでこのチャンネルの表示幅(拡大率)を変える / ダブルクリックで既定に戻す');
      el.addEventListener('dblclick', () => {
        this._laneSizes.clear();
        this._applyLaneSizes();
      });
      return el;
    }

    // 各レーンの音程窓を「そのchが曲全体で鳴らす音域」に合わせる。
    //   lane.offWhite = 窓の低音側の端(白鍵単位。ドラム区画を含む音程軸の座標)
    //   lane.visWhite = 窓の幅(白鍵の本数)。canvasの音程軸長さ÷これが拡大率になる
    // タイムラインが無い/そのchの音符が1つも無い間は鍵盤全体(まとめ表示と同じ)にする。
    // タイムラインやドラム区画が変わるたびに呼ぶ(_rebuildDrumLanes の呼び出し元と対)。
    _updateLaneRanges() {
      if (!this._lanes.length) return;
      const drumUnits = (this._drumLanes || []).length * DRUM_LANE_WHITE;
      const total = TOTAL_WHITE + drumUnits;
      for (const lane of this._lanes) {
        const laneIds = lane.ids || [lane.id];
        const tracks = (this._rollTimeline || []).filter(t => laneIds.indexOf(t.id) >= 0);
        let lo = Infinity, hi = -Infinity;
        for (const note of [].concat(...tracks.map(t => t.notes))) {
          let p0, p1;
          if (note.drumLane !== undefined) {
            // ドラムの打点はレーン番号が音程軸上の位置(1レーン=DRUM_LANE_WHITE白鍵ぶん)
            const d = drumLaneX(note.drumLane, 0, 1, DRUM_LANE_WHITE);
            p0 = d.x; p1 = d.x + d.size;
          } else {
            const kp = keyX(note.midi, 1);
            if (!kp) continue;
            p0 = (kp.isBlack ? kp.x - 0.3 : kp.x) + drumUnits;
            p1 = (kp.isBlack ? kp.x + 0.3 : kp.x + 1) + drumUnits;
          }
          if (p0 < lo) lo = p0;
          if (p1 > hi) hi = p1;
        }
        if (lo === Infinity) {
          // 1音も鳴らないch(や先読みキャプチャ完了前)は音域が決まらない。鍵盤全体を出すが、
          // 音域が分かっているレーンと同じ拡大率で場所を取らないよう大きさは控えめにする
          lane.offWhite = 0; lane.visWhite = total; lane.rangeKnown = false;
          continue;
        }
        lane.rangeKnown = true;
        lo -= LANE_RANGE_PAD; hi += LANE_RANGE_PAD;
        if (hi - lo < LANE_MIN_WHITE) {  // 1音しか鳴らさないch等が極端に拡大されないように
          const c = (lo + hi) / 2;
          lo = c - LANE_MIN_WHITE / 2;
          hi = c + LANE_MIN_WHITE / 2;
        }
        lo = Math.max(0, lo); hi = Math.min(total, hi);
        lane.offWhite = lo;
        lane.visWhite = Math.max(1, hi - lo);
      }
      this._applyLaneSizes();
    }

    // レーンの音程軸方向の大きさをDOMへ反映する。
    // 既定(手で変えていない状態)は音域幅×LANE_PX_PER_WHITE = どのレーンも同じ拡大率にし、
    // 音程軸に余りがあれば音域幅に比例して配って隙間を埋める(flex-growを大きさに比例させる)。
    // スプリッターで1つでも変えたら全レーンを固定px(=はみ出したぶんはスクロール)へ切り替える。
    _applyLaneSizes() {
      const extra = this._layout.rollOrientation === 'horizontal' ? LANE_LABEL_PX : 0; // 横向きはラベル行もレーンの高さに含まれる
      const fixed = this._laneSizes.size > 0;
      for (const lane of this._lanes) {
        const base = lane.rangeKnown
          ? Math.max(LANE_MIN_PX, Math.round((lane.visWhite || 0) * LANE_PX_PER_WHITE) + extra)
          : LANE_UNKNOWN_PX + extra;
        const size = fixed ? (this._laneSizes.get(lane.id) || base) : base;
        lane.laneEl.style.flex = fixed ? ('0 0 ' + size + 'px') : (base + ' 0 ' + base + 'px');
      }
      this._scheduleLaneRedraw();
    }

    // レーンの大きさを変えた直後の描き直し。停止中はrAFが回っていないので自分で1回描く。
    // canvasの表示サイズはResizeObserverがキャッシュするが反映は次フレーム以降なので、
    // ここではレイアウト確定後(rAF)に実寸を読んでキャッシュを更新してから描く。
    _scheduleLaneRedraw() {
      if (this._laneRedrawPending || !this._lanes.length) return;
      this._laneRedrawPending = true;
      const run = () => {
        this._laneRedrawPending = false;
        for (const lane of this._lanes) {
          for (const c of [lane.rollCanvas, lane.pianoCanvas]) {
            const w = c.clientWidth, h = c.clientHeight;
            if (w) c._cachedWidth = w;
            if (h) c._cachedHeight = h;
          }
        }
        this._redrawRollForSpotlight();
        this._drawPianos(this._lastChannels || []);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else run();
    }

    // 自動割り付け中のレーンを「今の実寸」で固定値に置き換える(スプリッターを掴んだ瞬間に呼ぶ)
    _freezeLaneSizes() {
      const horizontal = this._layout.rollOrientation === 'horizontal';
      for (const lane of this._lanes) {
        if (this._laneSizes.has(lane.id)) continue;
        const px = horizontal ? lane.laneEl.offsetHeight : lane.laneEl.offsetWidth;
        this._laneSizes.set(lane.id, Math.max(LANE_MIN_PX, Math.round(px) || LANE_MIN_PX));
      }
    }

    // 鍵盤だけ描き直す。停止中(rAFが回っていない)に演奏入力で押した鍵を点灯させるために、
    // src/ui/performInput.js が押鍵のたびに呼ぶ。ロールは触らないので安い
    refreshPianos() {
      this._drawPianos(this._lastChannels || []);
    }

    // 鍵盤描画: 全チャンネルまとめ(1枚)か、レーンごと(そのchだけ)か
    _drawPianos(allChannels) {
      const PI = MML.UI && MML.UI.PerformInput;
      const performNotes = (PI && PI.isArmed()) ? PI.heldNotes() : null;
      if (this._layout.rollLanes === 'perChannel' && this._lanes.length) {
        for (const l of this._lanes) {
          // 音程窓はロール側と共通(_updateLaneRanges が決めたそのchの音域)
          const laneIds = l.ids || [l.id];
          drawPiano(l.pianoCanvas, allChannels.filter(c => laneIds.indexOf(c.id) >= 0), this._layout.rollOrientation, l.visWhite || 0, l.offWhite || 0, this._drumsForPiano(), performNotes);
          if (this._drumLanes && this._drumLanes.length) this._attachDrumAudition(l.pianoCanvas);
          this._attachPerformInput(l.pianoCanvas);
        }
        return;
      }
      drawPiano(this._canvas, allChannels, this._layout.rollOrientation, 0, 0, this._drumsForPiano(), performNotes);
      this._attachPerformInput(this._canvas);
      // ドラム区画があるときだけパッド試聴を有効にする(区画=パッドが無ければ押す物が無い)
      const hasDrums = !!(this._drumLanes && this._drumLanes.length);
      if (hasDrums) this._attachDrumAudition(this._canvas);
      if (this._drumAuditionEl) this._drumAuditionEl.style.display = (hasDrums && this.onDrumAudition) ? '' : 'none';
    }

    // 表示中の再生ソースをタイトル行のバッジに出す。kind: 'mml' | 'nsf'|'spc'|'kss'|'gbs'|'hes'
    // (サウンドファイル) | null(未ロード)。name: ファイル名や曲名(省略可)。
    // main.js が MML再生の準備(prepareMmlStream)と各loadXxxFile()で呼ぶ。
    setSourceInfo(kind, name) {
      this._sourceInfo = kind ? { kind, name: name || '' } : null;
      this._renderSourceBadge();
      // MML側へ切り替えたら割当UI(part列・借用先列・🎧)をまとめて無効に、ファイル側へ戻したら復帰
      const wasMml = sourceIsMml;
      sourceIsMml = kind === 'mml';
      if (wasMml !== sourceIsMml) {
        if (this._leftEl) this._leftEl.classList.toggle('kbd-left--assign', !!this._assignMode && !sourceIsMml);
        this._renderAssignToggle();
        this._renderPreviewToggle();
        if (this._previewMode) this._notifyPreview(); // ミュート設定/プレビュー計画を今の表示元で組み直す
      }
    }
    _renderSourceBadge() {
      const el = this._srcBadgeEl;
      if (!el) return;
      const info = this._sourceInfo;
      el.classList.remove('kbd-src-badge--mml', 'kbd-src-badge--file');
      if (!info) { el.textContent = ''; el.title = ''; el.style.display = 'none'; return; }
      el.style.display = '';
      const isMml = info.kind === 'mml';
      el.classList.add(isMml ? 'kbd-src-badge--mml' : 'kbd-src-badge--file');
      // バッジは MML / FILE の2択(今どちらの再生を表示・操作しているか)。名前は右の別ボタンへ
      el.textContent = isMml ? 'MML' : 'FILE';
      const base = isMml ? T('MML再生を表示中') : T('サウンドファイル再生を表示中');
      el.title = this._transportState.canToggleSource
        ? base + '\n' + T('クリックでMML再生 / サウンドファイル再生を切り替え')
        : base;
      el.classList.toggle('kbd-src-badge--clickable', !!this._transportState.canToggleSource);
      this._renderSourceName();
    }
    // ファイル名(MMLならタイトル)/アーカイブのリスト名。曲一覧があればクリックで選べる
    _renderSourceName() {
      const el = this._srcNameEl;
      if (!el) return;
      const info = this._sourceInfo;
      const list = (info && this.onSourceListRequest) ? (this.onSourceListRequest() || null) : null;
      const name = (list && list.name) || (info && info.name) || '';
      const pickable = !!(list && list.items && list.items.length > 1);
      if (!name) { el.style.display = 'none'; el.textContent = ''; return; }
      el.style.display = '';
      if (el.textContent !== name) el.textContent = name;
      el.classList.toggle('kbd-src-name--pick', pickable);
      // アーカイブなら1行目にリスト名(zip/m3u)、2行目に曲名
      el.title = (list && list.listName ? list.listName + '\n' : '') + name + (pickable ? '\n' + T('クリックで曲を選ぶ') : '');
    }
    refreshSourceName() { this._renderSourceName(); }
    // 今表示している曲の名前(タイトル行のファイル名ボタンと同じ文字列)。
    // ミニ操作窓の見出しと Media Session の曲名に使う
    getSourceName() {
      const info = this._sourceInfo;
      const list = (info && this.onSourceListRequest) ? (this.onSourceListRequest() || null) : null;
      return (list && list.name) || (info && info.name) || '';
    }
    _openSourcePopover() {
      this._closeSourcePopover();
      const list = this.onSourceListRequest ? this.onSourceListRequest() : null;
      if (!list || !list.items || list.items.length < 2) return;
      const pop = document.createElement('div');
      pop.className = 'kbd-src-pop';
      let curEl = null;
      list.items.forEach((label, i) => {
        const row = document.createElement('div');
        row.className = 'kbd-src-pop-item' + (i === list.index ? ' kbd-src-pop-item--cur' : '');
        row.textContent = label;
        row.title = label;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSourcePopover();
          if (this.onSourceSelect) this.onSourceSelect(i);
        });
        pop.appendChild(row);
        if (i === list.index) curEl = row;
      });
      const r = this._srcNameEl.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 430)) + 'px';
      pop.style.top = (r.bottom + 4) + 'px';
      document.body.appendChild(pop);
      this._srcPopEl = pop;
      if (curEl) curEl.scrollIntoView({ block: 'center' });
      const onDown = (e) => { if (!pop.contains(e.target)) this._closeSourcePopover(); };
      const onKey = (e) => { if (e.key === 'Escape') this._closeSourcePopover(); };
      this._srcPopCleanup = () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
      setTimeout(() => { document.addEventListener('mousedown', onDown, true); document.addEventListener('keydown', onKey, true); }, 0);
    }
    _closeSourcePopover() {
      if (this._srcPopCleanup) { this._srcPopCleanup(); this._srcPopCleanup = null; }
      if (this._srcPopEl) { this._srcPopEl.remove(); this._srcPopEl = null; }
    }

    // ── タイトル行の再生コントロール(⏮ ▶/⏸ ■ ⏭) ───────────────────
    // 操作対象は「今表示している方」(バッジと同じ = MML再生 or サウンドファイル再生)。
    // 実際の再生/停止/曲送りはmain.js側が持っているので、ここは押されたことを
    // onTransport(action)で伝えるだけにして、状態(有効/無効・再生中か)は
    // setTransportState()で外から流し込む。
    _buildTransportBar() {
      const ICONS = {
        prev: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.6 4.5v11h1.8v-11zM16 5.2c0-.8-.9-1.2-1.5-.8l-5.1 4.1a1 1 0 0 0 0 1.6l5.1 4.1c.6.5 1.5 0 1.5-.8z"/></svg>',
        play: '<svg class="icon-play" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.2v11.6c0 .8.9 1.3 1.6.9l9-5.8c.6-.4.6-1.4 0-1.8l-9-5.8c-.7-.4-1.6.1-1.6.9Z"/></svg>' +
              '<svg class="icon-pause" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3.4" height="12"/><rect x="11.6" y="4" width="3.4" height="12"/></svg>',
        stop: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.2"/></svg>',
        next: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.4 4.5v11h-1.8v-11zM4 5.2c0-.8.9-1.2 1.5-.8l5.1 4.1a1 1 0 0 1 0 1.6l-5.1 4.1c-.6.5-1.5 0-1.5-.8z"/></svg>'
      };
      const bar = document.createElement('div');
      bar.className = 'kbd-transport';
      this._transportBtns = {};
      for (const action of ['prev', 'play', 'stop', 'next']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kbd-tp-btn kbd-tp-btn--' + action;
        btn.innerHTML = ICONS[action];
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (btn.disabled) return;
          if (this.onTransport) this.onTransport(action);
        });
        bar.appendChild(btn);
        this._transportBtns[action] = btn;
      }
      return bar;
    }

    // ヘッダへ置く小さな代理ボタン(実体は別の場所のボタン/main.jsのコールバック)
    _buildProxyBtn(cls, title, innerHtml, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-hdr-btn ' + cls;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = innerHtml;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    }

    // 曲が終わった後の挙動。1つのアイコンをクリックのたびに次のモードへ回す
    _buildRepeatBtn() {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-hdr-btn kbd-repeat-btn';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = REPEAT_MODES.indexOf(this._repeatMode);
        this.setRepeatMode(REPEAT_MODES[(i + 1) % REPEAT_MODES.length]);
        if (this.onRepeatModeChange) this.onRepeatModeChange(this._repeatMode);
      });
      this._repeatBtnEl = b;
      this._renderRepeatBtn();
      return b;
    }

    setRepeatMode(mode) {
      if (REPEAT_MODES.indexOf(mode) < 0) mode = 'next';
      this._repeatMode = mode;
      try { localStorage.setItem(REPEAT_MODE_KEY, mode); } catch (e) { /* ignore */ }
      this._renderRepeatBtn();
    }
    getRepeatMode() { return this._repeatMode; }

    // ── ミニ操作窓(src/ui/miniTransport.js)から使う公開API ────────────────
    // 小窓はタイトル行のボタン群と同じ操作を提供するが、DOMは別に作るので
    // 「今の見た目」と「切り替え方」だけをここから渡す(状態の持ち主はこのクラスのまま)。
    getRepeatIcon() {
      const info = REPEAT_ICONS[this._repeatMode] || REPEAT_ICONS.next;
      return { svg: info.svg, label: info.label() };
    }
    cycleRepeatMode() {
      const i = REPEAT_MODES.indexOf(this._repeatMode);
      this.setRepeatMode(REPEAT_MODES[(i + 1) % REPEAT_MODES.length]);
      if (this.onRepeatModeChange) this.onRepeatModeChange(this._repeatMode);
      return this._repeatMode;
    }
    // 今表示しているチャンネル行のミュート状態。ALL行は含めない
    getMuteRows() {
      const spc = this._mode === 'spc';
      const rows = (spc ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.checkbox);
      // 色は行の丸(.kbd-dot)に実際に出ている値をそのまま渡す。ユーザーが色を
      // 変えた場合もこれで追随する(_getColorの上書きが既に入っているため)
      return rows.map((el) => {
        const dot = el.row && el.row.querySelector('.kbd-dot');
        return {
          id: el.id, label: el.id, muted: !el.checkbox.checked,
          color: (dot && dot.style.background) || '',
          chip: el.chip || '',
        };
      });
    }
    // 行のミュートを反転する。実体は行のチェックボックスを押すのと同じ経路を通すので、
    // SPC(onSpcMuteChange)との分岐もチェックボックス側のハンドラがそのまま面倒を見る
    toggleMuteRow(id) {
      const all = this._rowEls.concat(this._spcRowEls);
      const el = all.find(x => x.id === id && x.checkbox);
      if (!el) return false;
      el.checkbox.checked = !el.checkbox.checked;
      el.checkbox.dispatchEvent(new Event('change'));
      return true;
    }

    _renderRepeatBtn() {
      const b = this._repeatBtnEl;
      if (!b) return;
      const info = REPEAT_ICONS[this._repeatMode] || REPEAT_ICONS.next;
      b.innerHTML = info.svg;
      b.title = info.label();
      b.setAttribute('aria-label', info.label());
      b.classList.toggle('kbd-repeat-btn--stop', this._repeatMode === 'stop');
    }

    // main.js が再生状態の変化ごとに呼ぶ。state: { playing, canPlay, canStop, canPrevNext, canToggleSource }
    setTransportState(state) {
      const s = this._transportState;
      let changed = false;
      for (const k of ['playing', 'canPlay', 'canStop', 'canPrevNext', 'canToggleSource']) {
        const v = !!(state && state[k]);
        if (s[k] !== v) { s[k] = v; changed = true; }
      }
      if (!changed) return; // 毎フレーム呼ばれても実際に変わった時だけDOMを触る
      this._renderTransport();
      this._renderSourceBadge(); // バッジのクリック可否(カーソル/ツールチップ)も一緒に更新
    }

    _renderTransport() {
      const b = this._transportBtns;
      if (!b) return;
      const s = this._transportState;
      b.prev.disabled = !s.canPrevNext;
      b.next.disabled = !s.canPrevNext;
      b.play.disabled = !s.canPlay;
      b.stop.disabled = !s.canStop;
      b.play.classList.toggle('is-playing', s.playing);
      b.play.title = s.playing ? T('一時停止') : T('再生');
      b.stop.title = T('停止');
      b.prev.title = T('前の曲');
      b.next.title = T('次の曲');
    }

    // 大波形に「今表示するch」(_shownWaveId)を、表示中の一覧(rowEls)に合わせて決め直す。
    // ユーザーが選んだch(_selectedId)が一覧にあればそれ、無ければ一番若いch(波形アイコンを
    // 持つ最初の行)を一時的に表示する。_selectedId自体はここでは変えない(停止→再生や曲送りで
    // 一覧が一時的に2A03だけになっても、選択が勝手に若いchへ変わってしまわないように)。
    // ファイルの読み込み直しに伴う「選択を捨てて若いchへ戻すか、同じchが新ファイルにも
    // あるなら維持するか」の判定は_consumePendingSelectionReset()が別途行う(こちらを呼ぶ前に
    // 呼ばれる想定)。一覧の下の折りたたみ帯は自動で開かない(ユーザーがクリックしたときだけ開く)
    _syncShownWave(rowEls) {
      const rows = (rowEls || []).filter(el => el.waveCanvas);
      const keep = rows.find(el => el.id === this._selectedId);
      const target = keep || rows[0];
      const id = target ? target.id : null;
      if (id !== this._shownWaveId) this._bigWaveSig = '';
      this._shownWaveId = id;
      for (const el of this._rowEls.concat(this._spcRowEls)) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === id);
      }
      if (!id) return;
      const ch = (this._prevChannels || []).find(c => c.id === id) ||
                 (this._prevSpcVoices || []).find(c => c.id === id);
      if (ch) this._renderBigWave(ch);
    }

    // reset()(ファイルの読み込み直し)が立てたフラグを、新ファイルの実際のチャンネル一覧
    // (waveIds: 波形を持つ行のid配列)が判明した最初の1回だけ消費して、大波形の選択
    // (_selectedId)を確定させる。同じch(id)が新ファイルにもあれば選択を維持(同じ音源構成の
    // 別ファイルを続けて開いた場合など)、無ければ一番若いchへ切り替える。
    // waveIdsが空(まだ実データが来ていない一覧)の間は消費せず次回に持ち越す。
    // 呼び出し側は結果を_syncShownWave()に反映させるため、この直後に必ず_syncShownWave()を呼ぶこと。
    _consumePendingSelectionReset(waveIds) {
      if (!this._pendingSelectionReset || !waveIds || !waveIds.length) return;
      this._pendingSelectionReset = false;
      if (!waveIds.includes(this._selectedId)) this._selectedId = waveIds[0];
    }

    // ロール見出し行に置くシークバー(MMLエディタのトランスポート行と同じもの。DOMはmain.jsが
    // createSeekBarInstance()で作り位置/範囲/時間表示を同期し続けるので、ここでは置くだけ)。
    // 言語切替で見出しを作り直しても同じ要素を差し戻す(_buildRollPane→_mountRollSeekBar)。
    setRollSeekBar(wrapEl, timeEl) {
      this._rollSeekBarEls = wrapEl ? { wrapEl, timeEl } : null;
      const slot = this._rollHeaderEl && this._rollHeaderEl.querySelector('.kbd-roll-seek-slot');
      if (slot) this._mountRollSeekBar(slot);
    }

    /**
     * ロール見出しの「演奏最大時間+出力」を更新する(main.jsが唯一の呼び出し元)。
     * opt = { visible, seconds, formats:[[value,label], ...] }
     * サウンドファイル再生中だけ出す(MML再生の総時間は曲の長さそのもので、指定する物ではない)。
     */
    setExportControls(opt) {
      this._exportOpt = opt || null;
      if (!this._exportEl) return;
      const on = !!(opt && opt.visible);
      this._exportEl.style.display = on ? '' : 'none';
      if (!on) return;
      // 中身が変わったときだけ作り直す(毎フレーム呼ばれるので、選択中の値を消さないため)
      const sig = opt.formats ? opt.formats.map((f) => f[0]).join(',') : '';
      if (opt.formats && this._exportFmtSig !== sig) {
        this._exportFmtSig = sig;
        const keep = this._exportFmtEl.value;
        this._exportFmtEl.innerHTML = '';
        for (const [value, label] of opt.formats) {
          const o = document.createElement('option');
          o.value = value; o.textContent = label;
          this._exportFmtEl.appendChild(o);
        }
        if (opt.formats.some((f) => f[0] === keep)) this._exportFmtEl.value = keep;
      }
      // 入力中(フォーカス中)は書き換えない。打っている途中の値が毎フレーム消えてしまうため
      if (document.activeElement !== this._maxSecEl && opt.seconds != null) {
        const v = String(Math.round(opt.seconds));
        if (this._maxSecEl.value !== v) this._maxSecEl.value = v;
      }
    }
    _mountRollSeekBar(slot) {
      const els = this._rollSeekBarEls;
      slot.innerHTML = '';
      if (!els) return;
      slot.appendChild(els.wrapEl);
      if (els.timeEl) slot.appendChild(els.timeEl);
    }

    // ── ロールをドラッグしてシーク ─────────────────────────────────
    // ロール上でポインタを押して動かすと、音符の流れる方向に沿って再生位置を動かす
    // (縦向き=上下: 下へ引くと未来の音符が鍵盤へ近づく=進む / 横向き=左右: 左へ引くと進む)。
    // 1px = 1/ROLL_PX_PER_SEC 秒(ロールの時間軸スケールと同じなので、つかんだ音符が指に付いてくる)。
    // 実際のシークは onRollSeek(実時間の秒) に委ね(main.js: seekToSeconds)、ドラッグ中は
    // 間引いて呼び、離した時に最終位置で呼ぶ。返ってきた(クランプ後の)秒で表示位置を合わせる。
    // ドラッグ中の描画は _renderRoll() が _rollDrag.pos を優先する。
    // ロール上の点(clientX/Y)にノートがあればそのトラックidを返す(無ければnull)。
    // 判定は _drawRollCanvas の描画と同じ座標計算を使う。
    //  ・ノートの上 → そのchを大波形へフォーカスする(ドラッグシークはしない)
    //  ・ノートの無いところ → 従来どおりドラッグでシーク
    _trackAtRollPoint(canvas, clientX, clientY, onlyId, lane) {
      if (!this._rollTimeline || !this._rollTimeline.length) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const nDrum = (this._drumLanes || []).length;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? (lane.visWhite || 0) : 0, nDrum);
      // CSS表示サイズ → canvas内部解像度
      const cx = (clientX - r.left) * (canvas.width / r.width);
      const cy = (clientY - r.top) * (canvas.height / r.height);
      // canvas座標 → (音程軸p, 時間軸t)。makeRollGeom の point() の逆変換
      const p = g.vertical ? cx : (g.H - cy);
      const t = g.vertical ? (g.H - cy) : cx;
      if (t < 0 || t > g.timeLen) return null;
      const pos = this._rollLastDrawnPos || 0;
      const sec = pos + t / ROLL_PX_PER_SEC;
      const wkW = g.wk, bkW = g.bk;
      const offPx = lane ? (lane.offWhite || 0) * wkW : 0;
      const pitchOff = g.drumOff - offPx;
      // 手前(描画順が後=最前面)から探したいので逆順に見る
      for (let ti = this._rollTimeline.length - 1; ti >= 0; ti--) {
        const track = this._rollTimeline[ti];
        if (!this._inLane(onlyId, track.id)) continue;
        for (const note of track.notes) {
          if (note.startSec > sec || note.endSec <= sec) continue;
          let pLo, pSize;
          if (note.drumLane !== undefined) {
            if (note.drumLane >= nDrum) continue;
            const d = drumLaneX(note.drumLane, note.drumSub, note.drumSubN, g.drumLaneW);
            pLo = d.x - offPx + 1;
            pSize = Math.max(2, d.size - 2);
          } else {
            const kp = keyX(note.midi, wkW);
            if (!kp) continue;
            kp.x += pitchOff;
            pLo = kp.isBlack ? kp.x - bkW / 2 : kp.x + 0.5;
            pSize = kp.isBlack ? bkW : (wkW - 1);
          }
          if (p >= pLo && p < pLo + pSize) return track.id;
        }
      }
      return null;
    }

    _attachRollSeekDrag(canvas) {
      canvas.classList.add('kbd-roll--seekable');
      canvas.title = T('音符をクリックでそのchを波形表示へ / 音符の無いところをドラッグでシーク');
      const SEEK_THROTTLE_MS = 60;
      let lastSeekMs = 0;
      const applySeek = (songSec, force) => {
        const nowMs = performance.now();
        if (!force && nowMs - lastSeekMs < SEEK_THROTTLE_MS) return;
        lastSeekMs = nowMs;
        if (!this.onRollSeek) return;
        // ロールの位置は曲内の絶対秒。プレイヤー/シークバーの秒は「現在の再生速度での実時間」
        // なので速度分母を掛けて渡す(逆変換は _renderRoll のrawPos*speedFactor参照)
        const denom = this._speedDenom || 1;
        const got = this.onRollSeek(songSec * denom);
        if (typeof got === 'number' && Number.isFinite(got)) this._rollDrag.pos = got / denom;
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this._rollTimeline) return;
        // ノートの上で押した場合はシークせず、そのchを大波形へフォーカスする
        const hit = this._trackAtRollPoint(canvas, e.clientX, e.clientY, canvas._rollOnlyId != null ? canvas._rollOnlyId : null, canvas._rollLane || null);
        if (hit) { this._selectWave(hit); e.preventDefault(); return; }
        this._rollDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, startPos: this._rollLastDrawnPos || 0, pos: this._rollLastDrawnPos || 0, moved: false };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* キャプチャ不可でも要素上のmoveで追従する */ }
        canvas.classList.add('dragging');
        e.preventDefault();
      });
      canvas.addEventListener('pointermove', (e) => {
        const d = this._rollDrag;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return; // クリック程度の揺れでは動かさない
        d.moved = true;
        const vertical = this._layout.rollOrientation !== 'horizontal';
        const deltaSec = (vertical ? dy : -dx) / ROLL_PX_PER_SEC;
        d.pos = Math.max(0, d.startPos + deltaSec);
        applySeek(d.pos, false);
        this._renderRoll(this._rollLastRawPosForDrag()); // 即座に追従して描く
      });
      const finish = (e) => {
        const d = this._rollDrag;
        if (!d || e.pointerId !== d.id) return;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        canvas.classList.remove('dragging');
        if (d.moved) applySeek(d.pos, true);
        this._rollDrag = null;
        // 次の実測位置から補間を組み直す(シーク後の位置に即座に揃える)
        this._rollLastRawPos = null;
        this._rollCursor = {};
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
    }
    // ドラッグ中に_renderRoll()を即時呼びするための「直前の実測位置」(無ければ0)。
    // _renderRoll()はドラッグ中は表示位置に_rollDrag.posを使うので値自体は補間の帳尻用
    _rollLastRawPosForDrag() { return this._rollLastRawPos == null ? 0 : this._rollLastRawPos; }

    // ── スポットライト(案D) ────────────────────────────────────────
    // チャンネル一覧の行にホバー(一時)/ch名クリック(固定)で「注目ch」を決め、ロール描画で
    // そのchだけを原色・最前面に、他chをSPOTLIGHT_DIM_ALPHAまで減光する。
    // ★ホバー中はホバーが勝ち、マウスが一覧から離れたら固定へ戻る。固定は「マウスを離しても
    //   注目を失わない」ためのもので、他の行を覗く操作を殺すためのものではないため。
    _effectiveSpotlightId() { return this._spotlightHoverId || this._spotlightPinnedId; }

    // 停止中はrAFが回っていないので、注目chが変わったらその場で描き直す。
    // _renderRoll()は同じrawPosを渡しても位置を進めない(実測差分ぶんしか加算しない)ので安全。
    _redrawRollForSpotlight() {
      if (!this._rollTimeline) return;
      this._renderRoll(this._rollLastRawPosForDrag());
    }

    // ★ホバーでのピックアップは「その行の小波形が大波形として選択されている」ときだけ効かせる
    //   (ユーザー指示)。一覧の上をマウスが通るだけで次々ロールが切り替わるのを避け、
    //   「注目したいchを波形で選んでから、その行を指す」という操作に揃える。
    _setSpotlightHover(id) {
      if (id !== null && id !== this._shownWaveId) id = null;
      if (this._spotlightHoverId === id) return;
      this._spotlightHoverId = id;
      this._redrawRollForSpotlight();
    }

    // ch名クリックで固定のON/OFF。同じ行をもう一度クリックすると解除する
    _toggleSpotlightPin(id) {
      this._spotlightPinnedId = (this._spotlightPinnedId === id) ? null : id;
      this._applySpotlightClasses();
      this._redrawRollForSpotlight();
    }

    // 固定中の行に目印クラスを付ける(行の再構築後にも呼んで状態を復元する)
    _applySpotlightClasses() {
      for (const r of (this._rowEls || []).concat(this._spcRowEls || [])) {
        if (!r || !r.row) continue;
        r.row.classList.toggle('kbd-ch-row--spot', r.id === this._spotlightPinnedId);
      }
    }

    // 1行にスポットライトの操作を取り付ける(メイン一覧・SPCボイス行の両方から呼ぶ)。
    // ホバーは行全体、固定はch名セルのクリック(丸=色ピッカー/波形=大波形/note=キャリブレーションと
    // 衝突しない場所を選ぶ)
    _attachSpotlight(row, id) {
      row.addEventListener('mouseenter', () => this._setSpotlightHover(id));
      row.addEventListener('mouseleave', () => this._setSpotlightHover(null));
      const nameEl = row.querySelector('.kbd-name');
      if (!nameEl) return;
      nameEl.classList.add('kbd-name--clickable');
      // 行名に説明が付いている行(PSF トラックモードの複製「T9≈」)はそれを先頭に残す
      const spotHint = T('クリックでこのチャンネルに注目(他chを減光)。もう一度クリックで解除');
      nameEl.title = nameEl.title && nameEl.title !== spotHint ? nameEl.title + '\n' + spotHint : spotHint;
      nameEl.addEventListener('click', () => this._toggleSpotlightPin(id));
    }

    // 実効的なロールの置き場。'window'は別ウィンドウのコンテナ(#pianoRollDisplay)が
    // 無いページでは'bottom'扱いにする
    _effectivePlacement() {
      const p = this._layout.rollPlacement;
      if (p === 'window' && !document.getElementById('pianoRollDisplay')) return 'bottom';
      return p;
    }

    // ロールペインをレイアウト設定(_layout.rollPlacement)に応じた親へ取り付ける。
    //   'bottom': チャンネル一覧(.kbd-main)の下(従来配置)。手前にロール高さ用スプリッター
    //   'right' : 一覧の右(.kbd-main内)。手前に一覧幅用スプリッター
    //   'window': 別ウィンドウ(#pianoRollDisplay)
    _mountRollPane() {
      const pane = this._rollPaneEl;
      if (!pane) return;
      if (pane.parentNode) pane.parentNode.removeChild(pane);
      for (const sp of [this._listSplitterEl, this._rollSplitterEl]) {
        if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
      }
      const placement = this._effectivePlacement();
      if (placement === 'right') {
        this._mainEl.appendChild(this._listSplitterEl);
        this._mainEl.appendChild(pane);
      } else if (placement === 'window') {
        document.getElementById('pianoRollDisplay').appendChild(pane);
      } else {
        this.container.appendChild(this._rollSplitterEl);
        this.container.appendChild(pane);
      }
    }

    // 大波形パネルの置き場。ロールが一覧の下で一覧が1列(従来レイアウト)のときは一覧の右、
    // それ以外(右側をロールが使う/一覧が幅いっぱいに広がる)は一覧の下の折りたたみ帯に置く
    _bigWaveBelow() {
      return this._effectivePlacement() !== 'bottom' || this._layout.listColumns === 'auto';
    }
    // チャンネル一覧が幅いっぱいに広がる配置か(下配置で多段、または別ウィンドウ配置)
    _listFlexible() {
      const placement = this._effectivePlacement();
      return placement === 'window' || (placement === 'bottom' && this._layout.listColumns === 'auto');
    }
    // ファイル情報ペインの実際の置き場。'auto' は他の置き場から自動で決める:
    //  ・大波形が一覧の下にあり、かつ一覧が幅いっぱい(多段/別ウィンドウ)
    //      → 一覧の下(大波形と同じ帯に左右で並ぶ。ユーザー指示 2026-09-10)
    //  ・それ以外(一覧が固定幅で左右に余裕が無い)
    //      → 一覧の上(縦に足す方が場所を食わない)
    _effectiveFileInfoPlacement() {
      const p = this._layout.fileInfoPlacement;
      if (LAYOUT_CHOICES.fileInfoPlacement.includes(p) && p !== 'auto') return p;
      return (this._bigWaveBelow() && this._listFlexible()) ? 'bottom' : 'top';
    }

    // 大波形パネルとファイル情報ペインを、レイアウト設定に応じた置き場へ取り付ける。
    //   大波形    : 一覧の右(.kbd-main内) or 一覧の下の帯(.kbd-below)
    //   ファイル情報: 一覧の上/下(.kbd-left内) or 一覧の左/右(.kbd-main内)
    // 「一覧の下」に来たものは .kbd-below にまとめ、両方が下なら左右に並べる(ファイル情報が左)。
    _mountPanes() {
      const big = this._bigWaveEl, fi = this._fileInfoEl, band = this._belowEl;
      if (!big || !fi || !band) return;
      // いったん全部外してから置き直す(置き場が変わるとスプリッターの向きも変わるため)
      for (const el of [big, fi, band, this._waveSplitterEl, this._waveSplitterVEl,
                        this._fiSplitterEl, this._bandSplitterEl]) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      this._fiSplitterEl = null;
      this._bandSplitterEl = null;
      // 置き場が変わったらインラインサイズは捨てる(縦横で意味が変わるため)
      big.style.flex = '';
      big.style.width = '';
      const fiPlace = this._effectiveFileInfoPlacement();
      const bigBelow = this._bigWaveBelow();

      // ── 一覧の下の帯(.kbd-below) ─────────────────────────────
      band.classList.toggle('kbd-below--row', fiPlace === 'bottom' && bigBelow);
      if (fiPlace === 'bottom') band.appendChild(fi);
      if (bigBelow) {
        if (fiPlace === 'bottom') {
          // 帯の中の仕切り。右へ引く=ファイル情報が広くなる
          this._fiSplitterEl = this._makeSplitter('vertical', (delta, start) => {
            const w = Math.max(120, Math.round(start + delta));
            this._fileInfoWidth = w;
            fi.style.flex = 'none';
            fi.style.width = w + 'px';
          }, () => fi.offsetWidth, () => this._saveFileInfoSize());
          band.appendChild(this._fiSplitterEl);
        }
        band.appendChild(big);
      }
      if (band.firstChild) {
        if (bigBelow) {
          // 従来どおり「一覧の高さ」を変える仕切り(帯は中身なりの高さ)
          this._leftEl.appendChild(this._waveSplitterEl);
        } else {
          // 帯にファイル情報しか無いとき。上へ引く=ファイル情報が高くなる
          this._bandSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
            const h = Math.max(48, Math.round(start - delta));
            this._fileInfoHeight = h;
            fi.style.flex = 'none';
            fi.style.height = h + 'px';
          }, () => fi.offsetHeight, () => this._saveFileInfoSize());
          this._leftEl.appendChild(this._bandSplitterEl);
        }
        this._leftEl.appendChild(band);
      }
      this._applyRowsHeight();

      // ── 大波形が一覧の右(.kbd-main内) ───────────────────────────
      if (!bigBelow) {
        this._mainEl.appendChild(this._waveSplitterVEl);
        this._mainEl.appendChild(big);
        if (this._bigWaveWidth) {
          big.style.flex = 'none';
          big.style.width = this._bigWaveWidth + 'px';
        }
      }

      // ── ファイル情報が一覧の上/左/右 ────────────────────────────
      if (fiPlace === 'top') {
        // 下へ引く=ファイル情報が高くなる
        this._fiSplitterEl = this._makeSplitter('horizontal', (delta, start) => {
          const h = Math.max(48, Math.round(start + delta));
          this._fileInfoHeight = h;
          fi.style.flex = 'none';
          fi.style.height = h + 'px';
        }, () => fi.offsetHeight, () => this._saveFileInfoSize());
        this._leftEl.insertBefore(this._fiSplitterEl, this._leftEl.firstChild);
        this._leftEl.insertBefore(fi, this._leftEl.firstChild);
      } else if (fiPlace === 'left' || fiPlace === 'right') {
        const toRight = fiPlace === 'right'; // 仕切りがペインの左に来るのでドラッグの向きが逆
        this._fiSplitterEl = this._makeSplitter('vertical', (delta, start) => {
          const w = Math.max(120, Math.round(toRight ? start - delta : start + delta));
          this._fileInfoWidth = w;
          fi.style.flex = 'none';
          fi.style.width = w + 'px';
        }, () => fi.offsetWidth, () => this._saveFileInfoSize());
        if (toRight) {
          this._mainEl.insertBefore(this._fiSplitterEl, this._leftEl.nextSibling);
          this._mainEl.insertBefore(fi, this._fiSplitterEl.nextSibling);
        } else {
          this._mainEl.insertBefore(this._fiSplitterEl, this._leftEl);
          this._mainEl.insertBefore(fi, this._fiSplitterEl);
        }
      }
      this._applyFileInfoSize();
    }

    _saveFileInfoSize() {
      try {
        localStorage.setItem('mml_kbdFileInfoWidth', String(this._fileInfoWidth || 0));
        localStorage.setItem('mml_kbdFileInfoHeight', String(this._fileInfoHeight || 0));
      } catch (e) { /* ignore */ }
    }

    // ファイル情報ペインの置き場クラス・大きさ・折りたたみをインラインスタイルへ反映する
    _applyFileInfoSize() {
      const fi = this._fileInfoEl;
      if (!fi) return;
      const place = this._effectiveFileInfoPlacement();
      const collapsed = this._fileInfoCollapsed;
      for (const p of ['top', 'bottom', 'left', 'right']) fi.classList.toggle('kbd-fileinfo--' + p, p === place);
      fi.classList.toggle('kbd-fileinfo--collapsed', collapsed);
      if (this._fiToggleEl) this._fiToggleEl.textContent = collapsed ? '▶' : '▼';
      fi.style.flex = '';
      fi.style.width = '';
      fi.style.height = '';
      // 畳んだ間、およびサウンドファイルをまだ開いていない間(案内文1行だけ)は中身なりの
      // 大きさにする。MMLしか使わない人の鍵盤表示から、空のペインが場所を取らないように。
      // ★flex:'none'(縮まない)まで指定すること。このペインは一覧の列(.kbd-left)の中で唯一
      //   flex-shrinkが効く箱なので、ch数の多い曲(VGMのNamco System 2で33行など)で
      //   一覧が縦に溢れると、見出し1行ぶんの高さごと0まで潰されて消えてしまう
      //   (「畳むと畳むボタンの行まで消える」ユーザー報告 2026-09-12)
      if (collapsed || !(this._fileInfoNodes || []).length) { fi.style.flex = 'none'; return; }
      // 左右に並ぶ置き場は幅を、上下に積む置き場は高さをスプリッターの値で固定する
      const sideways = place === 'left' || place === 'right' || (place === 'bottom' && this._bigWaveBelow());
      fi.style.flex = 'none';
      if (sideways) fi.style.width = (this._fileInfoWidth || FILE_INFO_DEFAULT_W) + 'px';
      else fi.style.height = (this._fileInfoHeight || FILE_INFO_DEFAULT_H) + 'px';
    }

    // ファイル情報ペインの中身を貼り直す(main.jsから預かった要素+見出し)。
    // 見出しは原文(日本語)で持ち、言語切替で作り直されるたびにT()で引き直す
    _renderFileInfo() {
      if (!this._fiTitleEl || !this._fiBodyEl) return;
      this._fiTitleEl.textContent = this._fileInfoTitleKey ? T(this._fileInfoTitleKey) : T('ファイル情報');
      // 今出ている要素は「元の親」(#soundFileControls)へ返してから入れ替える。
      // ★捨ててはいけない: これらは main.js / convertSettings.js が id で引く実体なので、
      //   親から外れたままだと document.getElementById() が null になり、別のフォーマットへ
      //   切り替えた後にヘッダ情報も変換ログも出なくなる
      while (this._fiBodyEl.firstChild) {
        const n = this._fiBodyEl.firstChild;
        if (n._kbdFiHome) n._kbdFiHome.appendChild(n);
        else this._fiBodyEl.removeChild(n);
      }
      const nodes = (this._fileInfoNodes || []).filter(n => n);
      for (const n of nodes) {
        if (!n._kbdFiHome && n.parentNode && n.parentNode !== this._fiBodyEl) n._kbdFiHome = n.parentNode;
      }
      if (!nodes.length) {
        const empty = document.createElement('div');
        empty.className = 'kbd-fileinfo-empty';
        empty.textContent = T('サウンドファイルを開くと、ここにヘッダ情報が出ます。');
        this._fiBodyEl.appendChild(empty);
        return;
      }
      for (const n of nodes) this._fiBodyEl.appendChild(n);
    }

    /**
     * ファイル情報ペインの中身を差し替える(main.jsのsyncKeyboardFileInfoから呼ぶ)。
     * @param {string} titleKey 見出しの原文(日本語)。翻訳はこちら側でT()を通す
     * @param {Element[]} nodes 表示する要素。main.jsが持つ #xxxFileHeader / #xxxFileStatus を付け替える
     */
    setFileInfo(titleKey, nodes) {
      this._fileInfoTitleKey = titleKey || '';
      this._fileInfoNodes = Array.isArray(nodes) ? nodes.slice() : [];
      this._renderFileInfo();
      this._applyFileInfoSize(); // 空↔中身ありで大きさの決め方が変わる
    }

    // レイアウト設定をCSSクラス/インラインサイズへ反映する(向き・置き場・多段・折りたたみ)
    _applyLayoutClasses() {
      const L = this._layout;
      const placement = this._effectivePlacement();
      const horizontal = L.rollOrientation === 'horizontal';
      const below = this._bigWaveBelow();
      const pane = this._rollPaneEl;
      if (pane) {
        pane.classList.toggle('kbd-roll-wrap--horizontal', horizontal);
        // 右/別ウィンドウ配置ではペインが親いっぱいに広がる(ロールがflex:1)。下配置は固定高さ
        pane.classList.toggle('kbd-roll-wrap--fill', placement !== 'bottom');
        pane.classList.toggle('kbd-roll-wrap--nocollapse', placement !== 'bottom');
        pane.classList.toggle('kbd-roll-wrap--window', placement === 'window'); // 窓のタイトルと二重になる見出しラベルを隠す
        // チャンネルごとのレーン表示: まとめ表示の本体(.kbd-roll-body)を隠してレーン群を出す
        const lanesMode = L.rollLanes === 'perChannel';
        pane.classList.toggle('kbd-roll-wrap--lanes', lanesMode);
        const collapsed = placement === 'bottom' && this._rollCollapsed;
        this._rollCanvas.style.display = collapsed ? 'none' : '';
        if (this._lanesEl) this._lanesEl.style.display = (collapsed || !lanesMode) ? 'none' : '';
        const toggle = this._rollHeaderEl && this._rollHeaderEl.querySelector('.kbd-roll-toggle');
        if (toggle) toggle.textContent = collapsed ? '▶' : '▼';
        // 下配置は固定高さ(スプリッターで可変)。レーン表示のコンテナは各レーンに鍵盤も含むので、
        // 縦向きはロール高さ+鍵盤高さぶん確保して全体の高さをまとめ表示と揃える
        this._rollCanvas.style.height = placement === 'bottom' ? (this._rollHeight + 'px') : '';
        if (this._lanesEl) {
          this._lanesEl.style.height = placement === 'bottom'
            ? ((this._rollHeight + (horizontal ? 0 : PIANO_KEY_LEN)) + 'px') : '';
        }
      }
      const left = this._leftEl;
      if (left) {
        // 一覧の幅: 右配置=スプリッターで決めた固定幅 / 下配置で1列=CSS既定の固定幅(従来) /
        // それ以外(下配置で多段、別ウィンドウ配置)=幅いっぱい
        const flexible = this._listFlexible();
        left.classList.toggle('kbd-left--flex', flexible);
        left.classList.toggle('kbd-left--multicol', L.listColumns === 'auto');
        // 大波形を一覧の下に置くときは、行一覧を伸ばして最下部に張り付けるのでなく
        // チャンネル行のすぐ下に続ける(行が少ないと間が空いて「左下」に見えるため)
        left.classList.toggle('kbd-left--wave-below', below);
        // 右配置の一覧幅。SPCモードは列が多いので全列が収まる幅(SPC_LIST_MIN_WIDTH)を下限にする
        let w = '';
        if (placement === 'right') {
          // 割当表示ONのときは「借用先/音色」列(ASSIGN_COL_WIDTH)が入る幅を下限にする
          // (スプリッターで狭めた幅のままだと右側の列が押し出されて見えなくなるため)
          const base = this._mode === 'spc' ? SPC_LIST_MIN_WIDTH
            : (left.classList.contains('kbd-left--hes') || left.classList.contains('kbd-left--gbs'))
              ? LIST_WIDTH_PAN : LIST_WIDTH_NSF;
          const min = this._assignMode ? base + ASSIGN_COL_WIDTH : (this._mode === 'spc' ? SPC_LIST_MIN_WIDTH : 0);
          const want = Math.max(this._listWidth || 0, min);
          if (want > 0) w = want + 'px';
        }
        left.style.width = w;
      }
      const big = this._bigWaveEl;
      if (big) {
        big.classList.toggle('kbd-bigwave--below', below);
        big.classList.toggle('kbd-bigwave--collapsed', below && this._bigWaveCollapsed);
        // FM音色データの箱: ロールが下/別窓で一覧が多段(幅いっぱい)のときだけ大波形の右、他は下
        big.classList.toggle('kbd-bigwave--patch-right', placement !== 'right' && L.listColumns === 'auto');
        this._bigToggleEl.textContent = this._bigWaveCollapsed ? '▶' : '▼';
      }
      if (this._mainEl) this._mainEl.classList.toggle('kbd-main--roll-right', placement === 'right');
      this._applyFileInfoSize(); // ファイル情報ペインの折りたたみ/大きさも一緒に反映する
    }

    // 現在のレイアウト設定(コピー)を返す
    getLayout() { return Object.assign({}, this._layout); }

    // レイアウト設定を部分的に変更して即反映・永続化する。
    // 例: setLayout({ rollOrientation: 'horizontal' })
    setLayout(partial) {
      let changed = false;
      for (const k of Object.keys(LAYOUT_DEFAULTS)) {
        if (partial && LAYOUT_CHOICES[k].includes(partial[k]) && partial[k] !== this._layout[k]) {
          this._layout[k] = partial[k];
          changed = true;
        }
      }
      if (!changed) return;
      // 手で変えたレーンの大きさは向き(幅⇔高さ)や分割方法が変わると意味が変わるので捨てる
      this._laneSizes.clear();
      saveLayoutSettings(this._layout);
      this._mountRollPane();
      this._mountPanes();
      this._rebuildLanes();
      this._applyLayoutClasses();
      // canvasの内部解像度は次の描画でサイズキャッシュから決め直す。向きが変わると
      // 表示サイズも変わるので、古いキャッシュ値で1フレーム描かないよう捨てておく
      for (const c of [this._rollCanvas, this._canvas]) {
        if (!c) continue;
        delete c._cachedWidth;
        delete c._cachedHeight;
      }
      this._rollCursor = {};
      this._rollLastRawPos = null;
      if (this._shownWaveId) this._bigWaveSig = ''; // 置き場が変わった大波形は描き直す
      if (this.onLayoutChange) this.onLayoutChange(this.getLayout());
    }

    // レイアウト設定のポップオーバー(⚙ボタン直下)。ラジオ3組(向き/置き場/一覧)で即反映。
    // 外側クリック/Escで閉じる。既に開いていれば閉じる(トグル)。
    _openLayoutPopover(anchorEl) {
      if (this._layoutPopEl) { this._closeLayoutPopover(); return; }
      const groups = [
        { key: 'rollOrientation', label: T('ピアノロールの向き'), options: [
          ['vertical', T('縦 (音符が上から鍵盤へ降る)')],
          ['horizontal', T('横 (音符が右から鍵盤へ流れる)')],
        ] },
        { key: 'rollPlacement', label: T('ピアノロールの置き場'), options: [
          ['bottom', T('チャンネル一覧の下')],
          ['right', T('チャンネル一覧の右')],
          ['window', T('別ウィンドウ')],
        ] },
        { key: 'listColumns', label: T('チャンネル一覧'), options: [
          ['single', T('1列')],
          ['auto', T('幅に応じて自動で多段')],
        ] },
        { key: 'rollLanes', label: T('ピアノロールの鍵盤'), options: [
          ['all', T('全チャンネルを1つの鍵盤に')],
          ['perChannel', T('チャンネルごとに分割 (収まらない分はスクロール)')],
        ] },
        { key: 'rollView', label: T('ピアノロールの表示'), options: [
          ['roll', T('ピアノロール')],
          ['score', T('楽譜 (五線、時間比例。MML再生のみ)')],
        ] },
        { key: 'fileInfoPlacement', label: T('ファイル情報の置き場'), options: [
          ['auto', T('自動 (他の置き場に合わせる)')],
          ['top', T('チャンネル一覧の上')],
          ['bottom', T('チャンネル一覧の下')],
          ['left', T('チャンネル一覧の左')],
          ['right', T('チャンネル一覧の右')],
        ] },
      ];
      const pop = document.createElement('div');
      pop.className = 'kbd-layout-pop';
      pop.addEventListener('mousedown', (e) => e.stopPropagation()); // ウィンドウのドラッグ/前面化を起こさない
      pop.addEventListener('click', (e) => e.stopPropagation());
      for (const g of groups) {
        const sec = document.createElement('div');
        sec.className = 'kbd-layout-sec';
        const title = document.createElement('div');
        title.className = 'kbd-layout-sec-title';
        title.textContent = g.label;
        sec.appendChild(title);
        for (const [value, text] of g.options) {
          const lab = document.createElement('label');
          lab.className = 'kbd-layout-opt';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'kbd-layout-' + g.key;
          radio.value = value;
          radio.checked = this._layout[g.key] === value;
          radio.addEventListener('change', () => { if (radio.checked) this.setLayout({ [g.key]: value }); });
          lab.appendChild(radio);
          lab.appendChild(document.createTextNode(text));
          sec.appendChild(lab);
        }
        pop.appendChild(sec);
      }
      document.body.appendChild(pop);
      // アンカー(⚙)の直下、右端揃え。画面からはみ出す場合は左へ寄せる
      const r = anchorEl.getBoundingClientRect();
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let left = r.right - pw, top = r.bottom + 4;
      if (left < 4) left = 4;
      if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      this._layoutPopEl = pop;
      this._layoutPopClose = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        if (e.type === 'mousedown' && (pop.contains(e.target) || anchorEl.contains(e.target))) return;
        this._closeLayoutPopover();
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this._layoutPopClose, true);
        document.addEventListener('keydown', this._layoutPopClose, true);
      }, 0);
    }
    _closeLayoutPopover() {
      if (!this._layoutPopEl) return;
      this._layoutPopEl.remove();
      this._layoutPopEl = null;
      document.removeEventListener('mousedown', this._layoutPopClose, true);
      document.removeEventListener('keydown', this._layoutPopClose, true);
      this._layoutPopClose = null;
    }

    setSource(result, chips) {
      this._chips = Array.isArray(chips) ? chips.filter(c => c && c !== 'none') : [];
      // 楽譜モードの表記モデルは曲ごと(MML のコンパイル結果)なので、ソースが変わったら捨てる。
      // MML 再生なら main.js が setMonitorSource() の直後に setScore() で入れ直す
      this._score = null;
      this._scoreCursor = {};
      // 基準ピッチ(#TUNING): MML再生(main.js setMonitorSource が compiled.settings.tuningCents を渡す)の
      // 鍵盤ハイライト/ロールを、ずらした基準で音名に丸める。実ファイル再生は未指定=0
      rollTuningCents = (result && result.tuningCents) ? +result.tuningCents : 0;
      // L/R(ステレオパン)列はHES/GBSのみ意味を持つため、他フォーマットでは非表示にする
      // (表示/パネル幅はCSS側の.kbd-left--hes/.kbd-left--gbsで切り替え、詳細はstyle.css参照)。
      this._leftEl.classList.toggle('kbd-left--hes', this._chips.includes('hes'));
      // VGMのステレオ定位を持つチップ(SN76489=Game Gearステレオ、YM2612/YM2610=FM/ADPCMのL/R、
      // 32X PWM、RF5C68/164=パン)もGBS用のL/R列表示を流用する。
      // ★以前は gbs/sn76489 だけだったため、SN76489の無い Neo Geo(YM2610)では L/R 列が出ていなかった
      const PAN_CHIPS = ['gbs', 'sn76489', 'ym2612', 'ym2610fm', 'ym2151', 'ym2608fm', 'segapcm', 'c140', 'c352', 'psx', 'okim6258', 'k007232', 'k054539', 'qsound', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
      this._leftEl.classList.toggle('kbd-left--gbs', PAN_CHIPS.some(c => this._chips.includes(c)));
      this._extraSnaps = {};
      const wl = result.writeLog || [];
      if (this._chips.includes('vrc7')) this._extraSnaps.vrc7 = buildVrc7Snapshots(wl);
      if (this._chips.includes('n163')) this._extraSnaps.n163 = buildN163Snapshots(wl);
      if (this._chips.includes('fme7')) this._extraSnaps.fme7 = buildFme7Snapshots(wl);
      // APU矩形波1/2・ノイズのエンベロープ実出力レベル。
      // 事前キャプチャ経路は静的配列(apuEnv)、リアルタイム再生経路は毎回ライブAPUを読む関数(apuEnvLive)。
      this._extraSnaps.apuEnv = result.apuEnvSnapshots || null;
      this._extraSnaps.apuEnvLive = typeof result.getApuEnv === 'function' ? result.getApuEnv : null;
      this._extraSnaps.n163Live = typeof result.getN163 === 'function' ? result.getN163 : null;
      this._extraSnaps.fme7Live = typeof result.getFME7 === 'function' ? result.getFME7 : null;
      this._extraSnaps.mmc5Live = typeof result.getMmc5 === 'function' ? result.getMmc5 : null;
      this._extraSnaps.vrc7Live = typeof result.getVRC7 === 'function' ? result.getVRC7 : null;
      this._extraSnaps.kssPsgLive = typeof result.getKssPsg === 'function' ? result.getKssPsg : null;
      this._extraSnaps.kssSccLive = typeof result.getKssScc === 'function' ? result.getKssScc : null;
      this._extraSnaps.kssOpllLive = typeof result.getKssOpll === 'function' ? result.getKssOpll : null;
      this._extraSnaps.gbsApuLive = typeof result.getGbsApu === 'function' ? result.getGbsApu : null;
      this._extraSnaps.hesApuLive = typeof result.getHesApu === 'function' ? result.getHesApu : null;
      this._extraSnaps.snLive = typeof result.getSn76489 === 'function' ? result.getSn76489 : null;
      this._extraSnaps.ymLive = typeof result.getYm2612 === 'function' ? result.getYm2612 : null;
      this._extraSnaps.ym2610FmLive = typeof result.getYm2610Fm === 'function' ? result.getYm2610Fm : null;
      this._extraSnaps.ym2151Live = typeof result.getYm2151 === 'function' ? result.getYm2151 : null;
      this._extraSnaps.ym2203FmLive = typeof result.getYm2203Fm === 'function' ? result.getYm2203Fm : null;
      this._extraSnaps.ym2608FmLive = typeof result.getYm2608Fm === 'function' ? result.getYm2608Fm : null;
      this._extraSnaps.oplLive = typeof result.getOpl === 'function' ? result.getOpl : null;
      this._extraSnaps.ga20Live = typeof result.getGa20 === 'function' ? result.getGa20 : null;
      this._extraSnaps.k007232Live = typeof result.getK007232 === 'function' ? result.getK007232 : null;
      this._extraSnaps.k054539Live = typeof result.getK054539 === 'function' ? result.getK054539 : null;
      this._extraSnaps.msm5205Live = typeof result.getMsm5205 === 'function' ? result.getMsm5205 : null;
      this._extraSnaps.segapcmLive = typeof result.getSegaPcm === 'function' ? result.getSegaPcm : null;
      this._extraSnaps.c140Live = typeof result.getC140 === 'function' ? result.getC140 : null;
      this._extraSnaps.c352Live = typeof result.getC352 === 'function' ? result.getC352 : null;
      this._extraSnaps.psxLive = typeof result.getPsx === 'function' ? result.getPsx : null;
      this._extraSnaps.okim6258Live = typeof result.getOkim6258 === 'function' ? result.getOkim6258 : null;
      this._extraSnaps.qsoundLive = typeof result.getQsound === 'function' ? result.getQsound : null;
      this._extraSnaps.okim6295Live = typeof result.getOkim6295 === 'function' ? result.getOkim6295 : null;
      this._extraSnaps.multipcmLive = typeof result.getMultiPcm === 'function' ? result.getMultiPcm : null;
      this._extraSnaps.pwmLive = typeof result.getPwm === 'function' ? result.getPwm : null;
      this._extraSnaps.rf5c164Live = typeof result.getRf5c164 === 'function' ? result.getRf5c164 : null;
      this._extraSnaps.rf5c68Live = typeof result.getRf5c68 === 'function' ? result.getRf5c68 : null;
      this._lastDmc4011 = null; // 曲切替時にDMC書き込み検出をリセット
      this._rollSongTimeBase = 0; // 曲切替時にピアノロールの経過時間もリセット
      this._rollLastRawPos = null;
      this._rollBaseWallMs = null;
      this._state = {
        regSnapshots: result.regSnapshots || [],
        writeLog: result.writeLog || [], // ロール構築でDPCMの発声終了(buildDmcTimeline)を出すのに使う
        totalFrames: result.totalFrames || 0,
        samplesPerFrame: result.samplesPerFrame || 735,
        sampleRate: result.sampleRate || 44100,
      };

      const snap0 = this._state.regSnapshots[0] || {};
      this._prevChannels = extractChannels(snap0, this._extraSnaps, 0, this._chips);
      this._rebuildRows(this._prevChannels);
      this.setMode('nsf');

      // 全曲分のレジスタスナップショットが既にある場合(MML/事前キャプチャ済みNSF)は
      // ピアノロールを即座に構築できる。ライブ追跡のみ(totalFrames=1)の場合は
      // 未構築のままにし、setRollTimelineFromRegSnapshots()/setRollTimeline() による
      // 非同期の先読みキャプチャ結果を待つ。
      if (this._state.totalFrames > 1) {
        const frameDur = this._state.samplesPerFrame / this._state.sampleRate;
        // ロール構築はフレームfごとの「過去の履歴」を辿る必要があるが、n163Live/fme7Live/
        // vrc7Live/mmc5Liveは「今まさに再生中のライブチップの現在状態」を返す関数であり、
        // フレームに関わらず常に同じ値を返してしまう(全フレームがその場のスナップショットの
        // コピーになる=事実上ずっと無音として扱われる)。extractChannelsはchips.includes(...)の
        // 各分岐で「Live関数があれば無条件にそちらを優先」するため、setSource()をMML再生
        // (呼び出し時点ではまだ再生開始前でactivePlayerが無く、Live関数は必ずnullを返す)
        // から呼んだ場合にN163/FME7の音符がピアノロールに一切出ない不具合があった。
        // ロール構築専用にLive系を外し、writeLog由来の履歴配列(n163/fme7/vrc7)または
        // レジスタスナップショット直読み(mmc5)にフォールバックさせる
        // (setRollTimelineFromRegSnapshots()と同じ考え方)。
        const dmcTl = buildDmcTimeline(this._state.writeLog || [], this._state.totalFrames, frameDur);
        const rollExtraSnaps = Object.assign({}, this._extraSnaps,
          { n163Live: null, fme7Live: null, vrc7Live: null, mmc5Live: null, dmcSeq: dmcTl.seq, dmcEnd: dmcTl.end });
        this._rollTimeline = buildNoteTimelineFromChannelFrames(
          (f) => extractChannels(this._state.regSnapshots[f] || {}, rollExtraSnaps, f, this._chips),
          this._state.totalFrames, frameDur
        );
      } else {
        this._rollTimeline = null;
      }
      this._rebuildDrumLanes();
      this._updateLaneRanges();
    }

    // ピアノロール用タイムラインを直接差し替える(共通形状: [{color, notes:[{startSec,endSec,midi}]}])。
    // SPC/KSSのような完全リアルタイム合成フォーマットで、裏で走らせた先読みキャプチャの
    // 結果を非同期に反映する際に main.js から呼ばれる。
    setRollTimeline(timeline) {
      this._rollTimeline = timeline || null;
      this._rollCursor = {};
      this._rebuildDrumLanes();
      this._updateLaneRanges();
    }

    // ロールのトラックの区画情報を後から更新する。metaById: 行ID → {laneGroup, laneCopy}。
    // PSF のトラックモードは複製(デチューン二重化/エコー)の判定が曲を最後まで取り込んでから決まるので、
    // 既に組んであるタイムラインへ印だけ足して描き直す(ロールを組み直すと重いため。main.js psfRefreshTrackPlan)
    setRollTrackLaneMeta(metaById) {
      if (!this._rollTimeline || !metaById) return;
      for (const t of this._rollTimeline) {
        const m = metaById[t.id];
        if (!m) continue;
        t.laneGroup = m.laneGroup;
        t.laneCopy = !!m.laneCopy;
      }
      this._updateLaneRanges();
      this._redrawRollForSpotlight();
    }

    // 楽譜モード(レイアウト設定 rollView='score')の材料。score = { notation(src/score/notation.js の
    // 表記モデル), fps(コンパイラのフレームレート), loopPointFrame, totalFrames } | null。
    // 表記モデルの各音符片は frameStart/frameEnd(コンパイラのフレーム)を持つので、fps で秒に直せば
    // ロールと同じ「再生位置 pos からの相対秒」で描ける。null で楽譜なし(ロール表示に戻る)
    setScore(score) {
      this._score = score && score.notation ? score : null;
      this._scoreCursor = {};
      if (!this._score) return;
      // 毎フレームの走査用に、パートごとの音符片を時間順に平らに並べておく(小節の入れ子を辿らない)
      for (const part of this._score.notation.parts) {
        const flat = [];
        for (const m of part.measures) for (const it of m.items) flat.push(it);
        part.flatItems = flat;
      }
    }
    getScore() { return this._score; }

    // ドラム区画のレーン表を、タイムラインのノートに書き込まれた drumLane/drumKey から組み直す。
    // ★配列に生やしたプロパティ(result.drumLanes のような形)はWorkerからのpostMessageの
    //   構造化複製で消えるため、レーン表そのものは渡さず「noteが持っている情報から復元する」
    //   方式にしてある(assignDrumLanes冒頭のコメント参照)。
    // this._drumLanes: [{key, label, color, subN}]  区画に出す順(=レーン番号順)
    // this._drumLaneOf: Map(drumKey → レーン番号)   鍵盤のパッド点灯(drawPiano)用
    // drawPiano()へ渡すドラム区画の情報。区画が無いときはundefinedを返し、鍵盤の描画を
    // 従来と完全に同じにする
    /**
     * DPCMの実コスト表示。cost = {clips, segments, bytes} | null(=DPCM未使用で非表示)。
     * 'pending' を渡すと計算中の表示にする。
     */
    setDpcmCost(cost) {
      if (!this._dpcmCostEl) return;
      if (!cost) { this._dpcmCostEl.style.display = 'none'; return; }
      this._dpcmCostEl.style.display = '';
      if (cost === 'pending') { this._dpcmCostEl.textContent = T('DPCM: 計算中…'); return; }
      const kb = (cost.bytes / 1024).toFixed(1);
      this._dpcmCostEl.innerHTML =
        `<span class="kbd-dpcm-cost-label">DPCM</span>` +
        T('定義 {clips} / 打点 {segments} / ROM {kb} KB', { clips: cost.clips, segments: cost.segments, kb });
      // ROMが大きいときは色で知らせる。16KB(DMC領域1ページ)を超えると16KBごとのページに分けて
      // トリガー時にバンク切替する(2026-09-10、無音にはならない)ので、16KB超=黄色「大きい」だけ
      this._dpcmCostEl.classList.toggle('kbd-dpcm-cost--warn', cost.bytes >= 16 * 1024);
      this._dpcmCostEl.classList.remove('kbd-dpcm-cost--over');
    }

    /**
     * ドラムパッドの下ごしらえ(分離レンダリング)の進捗表示。
     * text を空/nullにすると消える。frac は 0〜1(不明なら省略)。
     * 呼び出し元は main.js setDrumRenderStatus(ドラム(DPCM)パネルの表示と対)。
     */
    setDpcmRenderStatus(text, frac) {
      const el = this._dpcmStatusEl;
      if (!el) return;
      if (!text) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.querySelector('.kbd-dpcm-status-text').textContent = text;
      const bar = el.querySelector('.kbd-dpcm-status-bar');
      const pct = (typeof frac === 'number' && frac > 0) ? Math.max(0, Math.min(1, frac)) : 0;
      bar.style.display = pct > 0 ? '' : 'none';
      bar.firstChild.style.width = (pct * 100).toFixed(1) + '%';
    }

    // note列クリックの小メニュー。「このサンプルは打楽器か音階か」の手動指定と、
    // 既存の基準音キャリブレーションをまとめて出す。
    // ★指定はサンプル単位(chではない)。プール式チップは同じ太鼓が毎回別スロットへ移るので、
    //   ch単位で持つと指定が飛ぶ。
    _openSampleMenu(anchorEl, ch) {
      this._closeSampleMenu();
      const menu = document.createElement('div');
      menu.className = 'kbd-sample-menu';
      const cur = ch.sampleKind || 'auto'; // 'auto'|'drum'|'pitch'(extractChannelsが載せる)
      const items = [
        ['auto', T('自動判定にまかせる')],
        ['drum', T('打楽器として扱う')],
        ['pitch', T('音階として扱う')],
      ];
      for (const [kind, label] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kbd-sample-menu-item' + (kind === cur ? ' kbd-sample-menu-item--on' : '');
        b.textContent = label;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSampleMenu();
          if (this.onSampleKind) this.onSampleKind(ch, kind === 'auto' ? null : kind);
        });
        menu.appendChild(b);
      }
      if (this.onAdpcmCalibrate) {
        const sep = document.createElement('div');
        sep.className = 'kbd-sample-menu-sep';
        menu.appendChild(sep);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kbd-sample-menu-item';
        b.textContent = T('基準音を手動補正…');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeSampleMenu();
          this.onAdpcmCalibrate(ch);
        });
        menu.appendChild(b);
      }
      document.body.appendChild(menu);
      const r = anchorEl.getBoundingClientRect();
      menu.style.left = Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.round(Math.min(r.bottom + 2, window.innerHeight - menu.offsetHeight - 8)) + 'px';
      this._sampleMenuEl = menu;
      // 次のクリックで閉じる(メニュー内のクリックは上でstopPropagation済み)
      this._sampleMenuOutside = () => this._closeSampleMenu();
      setTimeout(() => document.addEventListener('click', this._sampleMenuOutside, { once: true }), 0);
    }

    _closeSampleMenu() {
      if (this._sampleMenuOutside) {
        document.removeEventListener('click', this._sampleMenuOutside);
        this._sampleMenuOutside = null;
      }
      if (this._sampleMenuEl && this._sampleMenuEl.parentNode) this._sampleMenuEl.parentNode.removeChild(this._sampleMenuEl);
      this._sampleMenuEl = null;
    }

    /** ドラム区画のレーン表(ドラム(DPCM)パネル用)。[{key,label,color,subN}] */
    getDrumLanes() { return (this._drumLanes || []).slice(); }
    /** ロールのタイムライン(音色一覧の目録 main.js rebuildToneInventory 用) */
    getRollTimeline() { return this._rollTimeline; }
    /** そのchに今効いている借用先(ユーザー指定 → 行の既定 → 割当計画の既定) */
    getEffectiveTarget(chId) {
      const plan = channelPlan();
      if (!plan) return 'skip';
      const ent = plan.get(chId) || {};
      return ent.target || this._defaultTargetOf(chId) || 'skip';
    }
    /** MMLのチャンネル文字(part列)から表示色を引く(楽譜ウィンドウのパート色用) */
    getChannelColorByLetter(letter) {
      const el = this._rowEls.find(e => e.letter === letter);
      return el ? el.color : null;
    }
    /** そのchの表示色(色の上書き込み) */
    getChannelColor(chId) {
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      return el ? el.color : null;
    }
    /** 割当UI(part列/セレクト/重複警告)の再描画を外から促す(音色ごとの指定の件数表示など) */
    refreshAssignUi() { this._refreshAssignUi(); }

    /**
     * ドラム区画のパッド名を差し替える。map は { drumKey → 表示名 }。
     * ★名前の実体は「サンプル内容のハッシュ」で持っている(src/convert/drumSamples.js)。
     *   ロールのノートはハッシュを持たない(Workerからの構造化複製で載せる情報を増やしたくない)ので、
     *   drumKey↔ハッシュの対応を知っている main.js 側から名前だけを流し込む形にしてある。
     */
    setDrumLaneNames(map) {
      this._drumLaneNames = map || {};
      if (!this._drumLanes || !this._drumLanes.length) return;
      for (const l of this._drumLanes) {
        if (l.key && this._drumLaneNames[l.key]) l.label = this._drumLaneNames[l.key];
        else if (l.key) l.label = l.autoLabel;
      }
      // 停止中でもその場で見た目を更新する(パッドの文字はロールと鍵盤の両方に出る)
      this._redrawRollForSpotlight();
      this._drawPianos(this._lastChannels || []);
    }

    /** サンプルごとの打点数(ドラム(DPCM)パネルの「打点」列)。drumKey → 件数 */
    getDrumHitCounts() {
      const out = {};
      for (const track of (this._rollTimeline || [])) {
        for (const n of track.notes) if (n.drumKey) out[n.drumKey] = (out[n.drumKey] || 0) + 1;
      }
      return out;
    }

    _drumsForPiano() {
      if (!this._drumLanes || !this._drumLanes.length) return undefined;
      return { lanes: this._drumLanes, laneOf: this._drumLaneOf };
    }

    // 鍵盤canvasのクリック位置 → ドラム区画のレーン番号(区画の外なら-1)。
    // 座標系は drawPiano と同じ(音程軸は縦向き=x、横向き=下から上へのy)
    _drumLaneAtPoint(canvas, clientX, clientY) {
      const lanes = this._drumLanes || [];
      if (!lanes.length) return -1;
      const r = canvas.getBoundingClientRect();
      const vertical = this._layout.rollOrientation !== 'horizontal';
      const pitchLen = vertical ? r.width : r.height;
      const p = vertical ? (clientX - r.left) : (r.bottom - clientY);
      const wk = pitchLen / (TOTAL_WHITE + lanes.length * DRUM_LANE_WHITE);
      const lane = Math.floor(p / (DRUM_LANE_WHITE * wk));
      return (lane >= 0 && lane < lanes.length) ? lane : -1;
    }

    // 鍵盤canvasのクリック位置 → MIDIノート番号(鍵の上でなければ null)。
    // 幾何は直前の drawPiano が canvas._pianoGeom へ焼き付けたものを使う。
    // 黒鍵は白鍵の手前(ロール側)に乗っているので先に判定する。
    _noteAtPoint(canvas, clientX, clientY) {
      const g = canvas._pianoGeom;
      if (!g) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      // canvasの内部解像度は表示サイズに合わせてあるが、途中で変わる瞬間に備えて比率補正する
      const cx = (clientX - r.left) * (g.W / r.width);
      const cy = (clientY - r.top) * (g.H / r.height);
      // p: 音程軸(低音→高音)、q: 鍵の長さ方向(0=ロール側の端)
      const p = g.vertical ? cx : (g.H - cy);
      const q = g.vertical ? cy : (g.keyLen - cx);
      if (q < 0 || q > g.keyLen || p < 0 || p > g.pitchLen) return null;
      if (q <= g.bkH) {
        for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
          const rel = midi - MIDI_MIN;
          if (!IS_BLACK[rel % 12]) continue;
          const pos = keyX(midi, g.wkW);
          if (!pos) continue;
          const x = pos.x + g.pitchOff;
          if (p >= x - g.bkW / 2 && p <= x + g.bkW / 2) return midi;
        }
      }
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        if (IS_BLACK[rel % 12]) continue;
        const pos = keyX(midi, g.wkW);
        if (!pos) continue;
        const x = pos.x + g.pitchOff;
        if (p >= x && p < x + g.wkW) return midi;
      }
      return null;
    }

    // 鍵盤canvasに演奏入力(押している間だけ鳴らす/ドラッグでグリッサンド)を取り付ける。
    // 実際に効くのは演奏入力モード中だけ。ドラム区画の上では null が返るのでパッド試聴と衝突しない
    _attachPerformInput(canvas) {
      if (!canvas || canvas._performWired) return;
      canvas._performWired = true;
      const PI = () => (MML.UI && MML.UI.PerformInput);
      let playing = null;   // 今このcanvasから鳴らしている音
      const release = (e) => {
        if (playing == null) return;
        const pi = PI();
        if (pi) pi.noteOff(playing, 'piano', e);
        playing = null;
      };
      canvas.addEventListener('pointerdown', (e) => {
        const pi = PI();
        if (!pi || !pi.isArmed()) return;
        const midi = this._noteAtPoint(canvas, e.clientX, e.clientY);
        if (midi == null) return;
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        release(e);
        playing = midi;
        pi.noteOn(midi, 'piano', e);
      });
      canvas.addEventListener('pointermove', (e) => {
        const pi = PI();
        if (!pi) return;
        if (playing == null) {
          if (pi.isArmed()) {
            canvas.style.cursor = (this._noteAtPoint(canvas, e.clientX, e.clientY) != null) ? 'pointer' : '';
          }
          return;
        }
        // 押したままなぞる = グリッサンド。同じ鍵の中では打ち直さない
        const midi = this._noteAtPoint(canvas, e.clientX, e.clientY);
        if (midi == null || midi === playing) return;
        pi.noteOff(playing, 'piano', e);
        playing = midi;
        pi.noteOn(midi, 'piano', e);
      });
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
      canvas.addEventListener('pointerleave', release);
    }

    // 鍵盤canvasにパッド試聴のクリックを取り付ける(_buildRollPane / _rebuildLanes から)
    _attachDrumAudition(canvas) {
      if (!canvas || canvas._drumAuditionWired) return;
      canvas._drumAuditionWired = true;
      canvas.addEventListener('click', (e) => {
        const lane = this._drumLaneAtPoint(canvas, e.clientX, e.clientY);
        if (lane < 0 || !this.onDrumAudition) return;
        const info = this._drumLanes[lane];
        if (!info || !info.key || info.key === '*') return;
        this.onDrumAudition(info.key, this._drumAuditionMode);
      });
      canvas.addEventListener('mousemove', (e) => {
        const lane = this._drumLaneAtPoint(canvas, e.clientX, e.clientY);
        canvas.style.cursor = (lane >= 0 && this.onDrumAudition) ? 'pointer' : '';
      });
    }

    // ── 鍵盤側でパッドを光らせるための索引(2026-09-09) ──────────────────────
    // ロールの打点(drumKey付きノート)は「行ID → 時刻順の区間表」で持っておく。
    // 分離レンダリング由来のパッド(VGMのDAC/32X PWM、GBのノイズ等)やSPCのE指定ボイスは、
    // ライブのレジスタ抽出(extractChannels)からは drumKey が分からない(サンプル同定情報が
    // 無い)。そのため鍵盤表示は疑似音程(dmcRateIdx=15 → D#2)に落ちてしまい、ロールでは
    // パッドに出ているのに鍵盤だけ D#2 に貼り付く、という食い違いが起きていた。
    // 再生位置でこの表を引き、鳴っている打点の drumKey をライブの行へ被せて解消する。
    _buildDrumNoteIndex(tracks) {
      const idx = new Map();
      for (const track of tracks) {
        let list = null;
        for (const n of track.notes) {
          if (!n.drumKey) continue;
          (list || (list = [])).push(n);
        }
        if (!list) continue;
        list.sort((a, b) => a.startSec - b.startSec);
        idx.set(track.id, list);
      }
      this._drumNotesByTrack = idx;
    }

    /**
     * ライブのチャンネル配列へ「今この行が鳴らしている打点」の drumKey を被せる。
     * 既に drumKey を持つ行(実サンプルのアドレスが分かるチップ)はそのまま。
     * posSeconds はロールと同じ曲内の秒。
     */
    _applyPadKeys(channels, posSeconds) {
      const idx = this._drumNotesByTrack;
      if (!idx || !idx.size) return;
      const t = (this._rollLastDrawnPos != null ? this._rollLastDrawnPos : posSeconds) || 0;
      for (const ch of channels) {
        if (!ch || ch.drumKey) continue;
        // ★サンプルを自力で同定できる行(adpcmSampleを持つサンプルPCM系: MultiPCM/C352/
        //   QSound/C140/SegaPCM/GA20/OKIM6295/YM2610 ADPCM)は対象外。打楽器として鳴って
        //   いる間は extractChannels 側が既に drumKey を入れており、音階として鳴っている
        //   間は本物の音程を持っている。ここで「この行はパッドに載っている」を行単位で
        //   決めてしまうと、**プール割当チップ(同じ物理行が曲中で打楽器と音階楽器を
        //   行き来する)で音階側の鍵盤が一度も光らなくなる**(Daytona USAで発覚 2026-09-12。
        //   28行のうち1度でも打楽器を鳴らした行が全部padRow=音程鍵盤の点灯対象外になっていた)。
        if ('adpcmSample' in ch) continue;
        const list = idx.get(ch.id);
        if (!list) continue;
        // この行はパッドに載っている。打点が来ていない間もレートの疑似音程(D#2)へは
        // 落とさない(音程を持たない行なのでそこに意味は無く、ずっと貼り付いて見える)
        ch.padRow = true;
        // 打点は短い(数十ms)ので線形走査でよいが、曲が長いと件数が多い。
        // 開始秒でソート済みなので二分探索で「開始が t 以下の最後の打点」を取る
        let lo = 0, hi = list.length - 1, at = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid].startSec <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
        }
        // 同時発音(同じ行で区間が重なる)もあるので、少し手前まで遡って被っている物を探す
        for (let i = at; i >= 0 && i > at - 8; i--) {
          const n = list[i];
          if (n.endSec > t) { ch.drumKey = n.drumKey; ch.active = true; break; }
        }
      }
    }

    _rebuildDrumLanes() {
      this._drumLanes = [];
      this._drumLaneOf = new Map();
      this._drumNotesByTrack = null;
      const DrumMap = MML.Convert && MML.Convert.DrumMap;
      const tracks = this._rollTimeline || [];
      if (!DrumMap || !tracks.length) return;
      this._buildDrumNoteIndex(tracks);

      // 1) 曲全体の打点を集めてレーンを決める(vgm2mmlのドラム音符出力と同じ表)
      const obs = [];
      for (const track of tracks) {
        for (const n of track.notes) if (n.drumKey) obs.push({ key: n.drumKey, sec: n.startSec });
      }
      if (!obs.length) return;
      // 表示用は上限を広く取る(DISPLAY_MAX_LANES)。16はドラムパートを2A03ノイズへ焼くときの
      // ノート数制約で、ロールを縛る理由が無い。先頭16レーンの番号は変換側と一致する
      const map = DrumMap.build(obs, { maxLanes: DrumMap.DISPLAY_MAX_LANES });

      // 2) 各打点にレーン番号を書き戻し、レーンごとに集める
      const byLane = map.lanes.map(() => []);
      for (const track of tracks) {
        for (const n of track.notes) {
          if (!n.drumKey) continue;
          const lane = map.laneOf.has(n.drumKey) ? map.laneOf.get(n.drumKey) : map.otherLane;
          if (lane < 0 || lane >= byLane.length) { delete n.drumLane; continue; }
          n.drumLane = lane;
          byLane[lane].push(n);
        }
      }

      // 3) レーン内の同時発音をサブスロットへ振る(貪欲な区間彩色。開始時刻の昇順に、
      //    「まだ前の打点が終わっている」一番若いサブスロットへ入れる)。分割数は曲全体で
      //    決まるので、再生位置によって打点の幅が踊らない。
      const lanes = [];
      const labels = DrumMap.labels(map.lanes.map((l) => l.key));
      for (let i = 0; i < byLane.length; i++) {
        const notes = byLane[i];
        notes.sort((a, b) => a.startSec - b.startSec);
        const ends = [];
        for (const n of notes) {
          let s = 0;
          while (s < ends.length && ends[s] > n.startSec + 1e-9) s++;
          n.drumSub = s;
          ends[s] = n.endSec;
        }
        const subN = Math.max(1, ends.length);
        for (const n of notes) n.drumSubN = subN;
        const isOther = map.lanes[i].key === null;
        const auto = isOther ? T('他') : (labels[i] || '');
        const named = (!isOther && this._drumLaneNames) ? this._drumLaneNames[map.lanes[i].key] : null;
        lanes.push({
          key: map.lanes[i].key,
          autoLabel: auto,   // 名前を消したときに戻す既定ラベル(ROMアドレスの16進)
          label: named || auto,
          color: isOther ? DRUM_OTHER_COLOR : DRUM_LANE_COLORS[i % DRUM_LANE_COLORS.length],
          subN,
        });
      }
      this._drumLanes = lanes;
      this._drumLaneOf = map.laneOf;
    }

    // regSnapshots形式(NSFのライブ再生を裏で先読みキャプチャした結果など)からピアノロールの
    // タイムラインを構築して差し替える。setSource()と同じ抽出ロジックをそのまま再利用する。
    // n163Snapshots(省略可): capture.jsが毎フレーム採取したN163チップの生RAM(128byte)配列。
    // 渡された場合はwriteLog再生によるbuildN163Snapshots()の代わりにこちらを使う。
    // N163は$F800(アドレスラッチ)+$4800(データ)の間接アドレッシングで、実機ドライバは
    // 位相バイトを「$4800の空読み」で読み飛ばす(読み出しもオートインクリメントを進める)ため、
    // writeLogの書き込みだけを再生するbuildN163Snapshots()はアドレスポインタがズレて
    // 誤ったチャンネル/周波数/波形を復元してしまう(Rolling Thunder等で顕著、
    // [[n163-capture-snapshot-and-numch]]参照)。ライブRAMスナップショットなら常に正しい。
    setRollTimelineFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
      this._rollCursor = {};
      this._rollTimeline = this.buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
      this._rebuildDrumLanes();
      this._updateLaneRanges();
    }

    // setRollTimelineFromRegSnapshots()のトラック構築部分。VGM(main.js playVgmStream)のように
    // NES APU由来のトラックと他チップ(GB/HuC6280/AY/SCC/OPLL)由来のトラックを1本の
    // タイムラインへ連結したい呼び出し側のために、差し替えず配列を返す版を分離した。
    // extra(省略可): extraSnapsへ追加でマージする先読み配列({sn: [...]}等。VGMのSN76489ロール用)。
    buildRollTracksFromRegSnapshots(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
      // 実体はモジュールレベルの純粋関数(buildRollTracksFromRegSnapshotsPure)。
      // thisに依存しないため、キャプチャWorker(ロール構築のオフスレッド化、
      // src/audio/roll-builders.js)からも UI.buildRollTracksFromRegSnapshots 経由で
      // 同じコードを使えるよう分離した。
      return buildRollTracksFromRegSnapshotsPure(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra);
    }

    // 新しいファイルを読み込んだ直後などに呼ぶ。前のファイルの発音色が鍵盤/ピアノロールに
    // 残ったまま次のファイルを読み込んだように見えてしまう問題(再生ボタンを押すまで
    // update()/updateSpcVoices()に新しいデータが渡らず、直前の描画がそのまま残る)を防ぐため、
    // 表示を無音状態に戻して即座に再描画する。
    // 新しいファイルを開いた時に呼ぶ(main.jsの各loadXxxFile()冒頭)。曲送り/トラック送り
    // (同一ファイル内での切替)ではミュート状態を保持したいため、ここでしかクリアしない。
    // _muteStateはチャンネルid('P1'等、フォーマット固有だがファイルをまたいで共通)をキーに
    // 永続化されており、以前は新しいファイルを開いてもクリアされなかった。結果、
    // 再生開始直後にgetChannelMuteConfig()が(_rebuildRows前の空/旧チャンネル一覧を反映した)
    // 「何もミュートされていない」設定を再生側へ渡してしまう一方、直後のロール/鍵盤再構築が
    // 古い_muteStateを見て該当chを再びミュート表示するため、表示は「ミュートのまま」なのに
    // 実際の再生は「全ch鳴る」という食い違いが起きていた。新規ファイルではミュートを
    // 引き継がない方針にして解消する。
    // *2MML変換の音程検証(src/convert/verify.js)で見つかった不一致箇所。ロールに赤枠で
    // 重ね描きする({sec,endSec,expectedMidi,gotMidi,letter}の配列)。次のファイル/変換で更新。
    setConversionDiffs(diffs) {
      this._conversionDiffs = (diffs && diffs.length) ? diffs : null;
    }

    reset() {
      this._spcVoices = [];
      this._conversionDiffs = null;
      this._prevSpcVoices = [];
      this._muteState.clear();
      // スポットライト(案D)の固定も新ファイルへは持ち越さない(ミュート状態と同じ扱い。
      // 前の曲にしか無いch.idが固定されたまま残ると、注目が効かない見た目になるため)
      this._spotlightPinnedId = null;
      this._spotlightHoverId = null;
      // 大波形の選択(_selectedId)はここでは変えない。新ファイルの実際のチャンネル構成が
      // 判明した時点(次のsetSource()/updateSpcVoices()の実データ呼び出し)で、同じchが
      // 新ファイルにもあれば維持、無ければ一番若いchへ切り替える判定を1回だけ行う
      // (_pendingSelectionResetフラグ、_consumePendingSelectionReset参照)。曲送り/停止→再生
      // (同一ファイル内での切替)ではこのフラグは立てないため選択はそのまま保たれる。
      // ここより前に消費されていない古いフラグが残っていたら(短時間に連続でファイルを
      // 読み込み直した場合)、直後のダミーsetSource()呼び出しがその場で誤って消費してしまう
      // 前に破棄しておく。
      this._pendingSelectionReset = false;
      this.setSource({ regSnapshots: [{}], totalFrames: 1, samplesPerFrame: 735, sampleRate: 44100, writeLog: [] }, []);
      this._pendingSelectionReset = true;
      this.update(0);
    }

    /** いま見えている一覧の枠。SPC再生中はボイス一覧(_spcSectionEl)が本体で _rowsEl は非表示 */
    _activeRowsEl() { return this._mode === 'spc' ? this._spcSectionEl : this._rowsEl; }
    /** 一覧の高さ(スプリッターで決めた値)を、見えている方だけに適用する */
    _applyRowsHeight() {
      const on = this._activeRowsEl();
      const off = (on === this._rowsEl) ? this._spcSectionEl : this._rowsEl;
      if (off) { off.style.flex = ''; off.style.height = ''; }
      if (!on) return;
      // 大波形が右にあるときは縦の取り合いが無いので高さ指定は捨てる(従来どおり)
      if (this._bigWaveBelow() && this._listRowsHeight) { on.style.flex = 'none'; on.style.height = this._listRowsHeight + 'px'; }
      else { on.style.flex = ''; on.style.height = ''; }
    }

    // 表示モード切替: NSF/MMLチャンネル一覧 と SPCボイス一覧 は同時表示せず、
    // 再生中のファイル種別に応じて排他的に切り替える。
    setMode(mode) {
      if (this._mode === mode) return;
      this._mode = mode;
      const spc = mode === 'spc';
      this._headerEl.style.display = spc ? 'none' : '';
      this._rowsEl.style.display = spc ? 'none' : '';
      this._spcHeaderEl.style.display = spc ? '' : 'none';
      this._spcSectionEl.style.display = spc ? '' : 'none';
      // SPCはNSFより列が多い(L/R/env/PM/echo)ぶん一覧の幅を少し広げる(.kbd-left--spc)。
      // レイアウト(ロールの置き場/大波形の置き場)はNSF等と共通のまま(以前はSPC専用の
      // 1000px幅テーブル+大波形の重ね配置だったが、マスター値を1行にまとめて廃止した)
      this._leftEl.classList.toggle('kbd-left--spc', spc);
      this._applyRowsHeight();    // 一覧の高さ指定を、切り替えた先の枠へ移す
      this._applyLayoutClasses(); // 右配置の一覧幅(SPCは下限あり)を反映
      // 大波形に表示するchを表示中の一覧に合わせる(選択chが無ければ一番若いch/V0を一時表示)
      this._syncShownWave(spc ? this._spcRowEls : this._rowEls);
      this._rebuildLanes(); // チャンネルごとのレーン表示も表示中の一覧に合わせる
      this._refreshAssignUi(); // 借用先の重複判定は「表示中の一覧」が対象なので切替のたびに計算し直す
      this._renderMuteAllBtn(); // 一括ミュートの状態も表示中の一覧が対象

      // ウィンドウが狭くて一覧の全列が収まらない場合だけ、収まる幅まで自動拡張する
      // (縮小はしない。ユーザーが既に手動でそれ以上広げていればそのまま尊重する)
      if (spc) {
        const winEl = this.container.closest('.float-window');
        if (winEl && this._effectivePlacement() !== 'window') {
          const minW = this._effectivePlacement() === 'bottom' && this._layout.listColumns === 'single' ? 720 : 560;
          if (winEl.offsetWidth < minW) winEl.style.width = minW + 'px';
        }
      }
    }

    // 上書き色があればそれを、無ければ既定色をそのまま返す
    _getColor(id, defaultColor) {
      const ov = this._colorOverrides.get(id);
      return ov || defaultColor;
    }

    // kbd-dot に色ピッカーを割り当てる。defaultColor は「既定色に戻す」用に
    // そのチャンネルの本来の色(上書き適用前)を保持しておく必要がある。
    _attachColorPicker(dotEl, id, defaultColor) {
      dotEl.addEventListener('click', (e) => {
        e.stopPropagation();
        UI.ColorPicker.open(
          dotEl,
          this._getColor(id, defaultColor),
          (color) => this._setColorOverride(id, color),
          () => this._setColorOverride(id, null),
        );
      });
    }

    // 色の変更を反映: 上書きマップ更新→永続化→表示中の行/大波形/次フレームの
    // ロール・鍵盤描画すべてに反映されるようにする。
    _setColorOverride(id, color) {
      if (color) this._colorOverrides.set(id, color);
      else this._colorOverrides.delete(id);
      saveColorOverrides(this._colorOverrides);

      for (const el of this._rowEls.concat(this._spcRowEls)) {
        if (el.id !== id) continue;
        const newColor = this._getColor(id, el.defaultColor || el.color);
        el.color = newColor;
        const dot = el.row.querySelector('.kbd-dot');
        if (dot) dot.style.background = newColor;
      }

      if (this._shownWaveId === id) {
        this._bigWaveSig = ''; // 色はwave形状に含まれないため強制再描画
        const sel = (this._prevChannels || []).concat(this._prevSpcVoices || [])
          .find((c) => c.id === id);
        if (sel) this._renderBigWave(sel);
      }
    }

    // ── チャンネル割当(案E: 鍵盤表示の行で借用先を決める) ────────────────
    // part列の文字とセレクトのラベル(「P: N163 ch1」)は channelPlan.js 側が持つ固定レター表
    // (assignExpansionLettersは他チップの有無に関わらず同じ文字を返す)から引くので、
    // ここで曲ごとのletterMapを作る必要はない。

    // 1行ぶんのpart列チップと「借用先/音色」セレクトを配線する。セレクトは割当表示ON
    // (_assignMode)のときだけ見えるが、DOMは常に作っておく(トグルのたびに行を組み直すと
    // 再生中の描画が途切れるため)。
    _wireAssign(row, ch) {
      const plan = channelPlan();
      if (!plan) return;
      const chId = ch.id;
      const editable = assignEditable();
      const partEl = row.querySelector('.kbd-part');
      const targetSel = row.querySelector('.kbd-assign-target');
      const toneSel = row.querySelector('.kbd-assign-tone');
      if (partEl) {
        if (editable) {
          partEl.title = T('クリックで借用先(NSF側のパート)を選ぶ');
          partEl.addEventListener('click', (e) => { e.stopPropagation(); this._openAssignPopover(partEl, chId); });
        } else {
          partEl.title = assignLockReason();
        }
      }
      if (!targetSel || !toneSel) return;
      targetSel.disabled = toneSel.disabled = !editable;
      if (!editable) targetSel.title = assignLockReason();
      targetSel.addEventListener('change', () => this._setAssignTarget(chId, targetSel.value));
      toneSel.addEventListener('change', () => {
        // 「音色ごとに指定…」: 値ではなく音色一覧(src/ui/tonePanel.js)をこのchで開く操作
        if (toneSel.value === plan.TONE_PER_INSTRUMENT) {
          const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
          if (el) this._syncAssignSelects(el);
          if (this.onOpenTonePanel) this.onOpenTonePanel(chId);
          return;
        }
        const cur = plan.get(chId) || {};
        const kind = plan.toneKindFor(cur.target || this._defaultTargetOf(chId), undefined, plan.channelKind(chId));
        const def = kind ? plan.toneOptionsFor(kind, plan.channelKind(chId)).def : null;
        plan.set(chId, { tone: toneSel.value === def ? null : toneSel.value });
      });
      // クリックが行の他の操作(大波形選択・色ピッカー)に伝播しないようにする
      for (const el of [targetSel, toneSel]) el.addEventListener('click', (e) => e.stopPropagation());
      const drumBtn = row.querySelector('.kbd-assign-drum');
      if (drumBtn) drumBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onOpenDrumPanel) this.onOpenDrumPanel();
      });
      // 音色の選択肢が無い借用先(三角波/FME-7/のこぎり波等)でも音色ごとの載せ先は指定できるので、
      // 音色セレクトが隠れるときはこのボタンで音色一覧を開く
      const tonesBtn = row.querySelector('.kbd-assign-tones');
      if (tonesBtn) tonesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onOpenTonePanel) this.onOpenTonePanel(chId);
      });
    }

    // この曲に実在する借用先(表示中の各行の既定の借用先)。NSFのように「同じ音源の
    // 別チャンネルへ移す」しかできない形式で、存在しない枠を候補に出さないために使う。
    _availTargets() {
      const rows = this._mode === 'spc' ? this._spcRowEls : this._rowEls;
      return rows.map(el => el.defaultTarget).filter(Boolean);
    }

    _defaultTargetOf(chId) {
      const plan = channelPlan();
      if (!plan) return 'skip';
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      return (el && el.defaultTarget) || plan.defaultTarget(chId, 'skip');
    }

    // 借用先を選び直す。既定と同じ値を選んだらユーザー指定を消して「自動」に戻す。
    // 借用先が他のchと重なったときの扱いは全形式「赤い重複警告を出すだけ」に統一(2026-09-09、
    // ユーザー指示)。以前はNSF側の行(_rowEls)だけ「先に居たchを自動でスキップへ落とす」ラジオ動作で、
    // SPCの行(_spcRowEls)は警告だけ、と形式で挙動が違っていた。自動解除は選んだ側の意図を
    // 越えて他の行を書き換えてしまうので、どちらを鳴らすかはユーザーが赤い行を見て決める。
    // 変換器側は従来どおり先着優先(後のchは「変換対象外」の注記)。
    _setAssignTarget(chId, value) {
      const plan = channelPlan();
      if (!plan) return;
      const def = this._defaultTargetOf(chId);
      plan.set(chId, { target: value === def ? null : value, tone: null });
    }

    // セレクトの中身を現在の割当に合わせて作り直す(借用先を変えると音色の選択肢も変わる)
    _syncAssignSelects(el) {
      const plan = channelPlan();
      if (!plan || !el.targetSel) return;
      const srcKind = plan.channelKind(el.id);
      const ent = plan.get(el.id) || {};
      const target = ent.target || el.defaultTarget || 'skip';
      const opts = plan.targetsForChannel(el.id, el.defaultTarget, this._availTargets());
      // 既定の借用先が候補に無い(種別判定と既定がずれている)場合も選べるように足す
      const list = opts.indexOf(target) >= 0 ? opts : opts.concat([target]);
      const sig = list.join(',') + '|' + target;
      if (el.targetSig !== sig) {
        el.targetSig = sig;
        el.targetSel.innerHTML = '';
        for (const t of list) {
          const o = document.createElement('option');
          o.value = t;
          // 行内のセレクトは幅が狭いので「(既定)」は付けない(既定から変えた行はpart列の
          // チップがアクセント色になるので区別はつく)。ポップオーバー側には付ける。
          // サンプルPCMでない行の E(DPCM) は「このchを打楽器として分離レンダリングしてDPCM化」
          // (main.js synthDrum)なので、そう読める語を添える
          o.textContent = plan.targetLabel(t) + ((t === 'dpcm' && plan.isSynthDrumTarget && plan.isSynthDrumTarget(el.id, t)) ? T('(打楽器化)') : '');
          // 音源ごとの色分けは「選ぶとき(=リストを開いたとき)」だけ、薄い背景色で出す。
          // ★文字色は塗らない(読みづらいというユーザー指摘)。行に閉じているセレクト本体も
          //   既定の見た目のままにして、色は候補一覧の中でのグルーピングだけに使う。
          const c = plan.colorOfTarget ? plan.colorOfTarget(t) : '';
          if (c) o.style.backgroundColor = tintOf(c);
          el.targetSel.appendChild(o);
        }
      }
      el.targetSel.value = target;
      // 以前は借用先の色をセレクト本文とpart列の文字色に塗っていた。もう塗らないので、
      // 行を作り直さずに切り替わったときのために明示的に消しておく
      el.targetSel.style.color = '';
      if (el.partEl) el.partEl.style.color = '';

      if (el.drumBtn) el.drumBtn.style.display = (target === 'dpcm') ? '' : 'none';
      const toneKind = plan.toneKindFor(target, undefined, srcKind);
      // 音色ごとの指定(src/convert/toneSettings.js)を持つ音色の数。セレクト/ボタンの表示に添える
      const nTone = this.toneOverrideCount ? this.toneOverrideCount(el.id) : 0;
      const perToneLabel = T('音色ごとに指定…') + (nTone ? ` (${nTone})` : '');
      // ★♪ボタンは「音色ごとの指定が使える行」には常に出す(2026-09-10)。以前は音色セレクトが
      //   隠れる行だけだったので、音色一覧で指定してもチャンネル一覧の見た目が変わらなかった
      //   (件数がセレクトの最終項目にしか出ず、開かないと見えない。ユーザー報告)
      const perOk = plan.editable() && target !== 'skip' && target !== 'dpcm' && plan.format() !== 'nsf';
      if (el.tonesBtn) {
        el.tonesBtn.style.display = perOk ? '' : 'none';
        el.tonesBtn.textContent = nTone ? `♪${nTone}` : '♪';
        el.tonesBtn.title = perToneLabel;
        el.tonesBtn.classList.toggle('kbd-assign-tones--custom', nTone > 0);
      }
      // 音色が1つしかない借用先は選ぶものが無い。音源そのままで鳴ることを明示する
      if (el.plainEl) {
        const showPlain = !toneKind && target !== 'skip' && target !== 'dpcm';
        el.plainEl.style.display = showPlain ? '' : 'none';
        if (showPlain) {
          el.plainEl.textContent = T('音源そのまま');
          el.plainEl.title = T('{t} は音色が1つだけなので、音源の音色そのままで鳴ります', { t: plan.targetLabel(target) });
        }
      }
      if (!toneKind) { el.toneSel.style.display = 'none'; el.toneSig = ''; return; }
      el.toneSel.style.display = '';
      const to = plan.toneOptionsFor(toneKind, srcKind);
      const tsig = toneKind + '|' + srcKind;
      if (el.toneSig !== tsig) {
        el.toneSig = tsig;
        el.toneSel.innerHTML = '';
        for (const pair of to.opts) {
          const o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          el.toneSel.appendChild(o);
        }
        // 末尾に「音色ごとに指定…」(選ぶと音色一覧が開く。値としては保存しない。NSFは対象外)
        if (plan.format() !== 'nsf') {
          const o = document.createElement('option');
          o.value = plan.TONE_PER_INSTRUMENT; o.className = 'kbd-assign-tone-per';
          el.toneSel.appendChild(o);
          el.perToneOpt = o;
        } else el.perToneOpt = null;
      }
      if (el.perToneOpt) el.perToneOpt.textContent = perToneLabel;
      el.toneSel.classList.toggle('kbd-assign-tone--per', nTone > 0);
      el.toneSel.title = nTone ? T('この行の音色 {n} 件に音色ごとの指定があります(音色一覧で変更)', { n: nTone }) : '';
      el.toneSel.value = ent.tone !== undefined ? ent.tone : to.def;
    }

    // 割当が変わったとき(plan.onChange)に呼ぶ。part列の文字・スキップの減光・
    // 借用先の重複(赤)を表示中の全行へ反映する。
    _refreshAssignUi() {
      const plan = channelPlan();
      if (!plan) return;
      // ★対象は「今表示中の一覧」だけ。両方(_rowEls+_spcRowEls)を混ぜると、SPC表示中に
      //   隠れているNSF側の行(A/B/C/D…)まで数えてしまい、全行が重複警告になる
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls)
        .filter(el => !el.isAllRow && el.partEl);
      const count = {};
      for (const el of rows) {
        const ent = plan.get(el.id) || {};
        el.target = ent.target || el.defaultTarget || 'skip';
        if (el.target !== 'skip') count[el.target] = (count[el.target] || 0) + 1;
      }
      // スキップの減光と重複警告は「割当が意味を持つ形式」だけに出す。NSFのようにMMLパート文字を
      // 持たない行(MMC5の$5011直接PCM等)まで一律に減光すると、従来の見た目を壊してしまう
      const editable = plan.editable();
      for (const el of rows) {
        const custom = !!(plan.get(el.id) || {}).target;
        el.letter = el.target === 'skip' ? '' : plan.letterOfTarget(el.target);
        el.partEl.textContent = el.letter || (editable ? '—' : '');
        el.partEl.classList.toggle('kbd-part--custom', custom);
        // スキップ行の減光は「割当表示ON(=借用先を編集している最中)」の間だけ。割当表示を
        // 切ったら、割当が無い行も普通の明るさに戻す(減光したままだと、ただ曲を聴いている間も
        // 半分の行が沈んで見える。ユーザー指示 2026-09-12)
        el.row.classList.toggle('kbd-ch-row--skip', this._assignMode && editable && el.target === 'skip');
        // DPCMは複数chをまとめて載せる先なので重複扱いにしない(上の MULTI_SOURCE_TARGETS 参照)
        const dup = editable && el.target !== 'skip' && !MULTI_SOURCE_TARGETS.has(el.target) && count[el.target] > 1;
        el.row.classList.toggle('kbd-ch-row--conflict', dup);
        if (el.partEl) {
          el.partEl.title = dup ? T('この借用先は他のチャンネルと重複しています')
            : plan.editable() ? T('クリックで借用先(NSF側のパート)を選ぶ') : (plan.lockReason() || '');
        }
        this._syncAssignSelects(el);
      }
      this._renderAssignToggle();
      this._renderPreviewToggle();
      this._notifyPreview();
    }

    // part列チップのクリックで開く1行ぶんの割当ポップオーバー(縦置き・多段・別窓など
    // 幅が足りないレイアウトでも必ず使える経路。案Eの土台)
    _openAssignPopover(anchorEl, chId) {
      const plan = channelPlan();
      if (!plan || !plan.editable()) return;
      this._closeAssignPopover();
      const el = this._rowEls.concat(this._spcRowEls).find(e => e.id === chId);
      if (!el) return;
      const pop = document.createElement('div');
      pop.className = 'kbd-assign-pop';
      const srcKind = plan.channelKind(chId);
      const ent = plan.get(chId) || {};
      const target = ent.target || el.defaultTarget || 'skip';

      const rowOf = (labelText, control) => {
        const r = document.createElement('label');
        r.className = 'kbd-assign-pop-row';
        const s = document.createElement('span');
        s.textContent = labelText;
        r.appendChild(s); r.appendChild(control);
        return r;
      };
      const targetSel = document.createElement('select');
      const list = plan.targetsForChannel(chId, el.defaultTarget, this._availTargets());
      for (const t of (list.indexOf(target) >= 0 ? list : list.concat([target]))) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = plan.targetLabel(t)
          + ((t === 'dpcm' && plan.isSynthDrumTarget && plan.isSynthDrumTarget(chId, t)) ? T('(打楽器化)') : '')
          + (t === el.defaultTarget ? T('(既定)') : '');
        targetSel.appendChild(o);
      }
      targetSel.value = target;
      targetSel.addEventListener('change', () => { this._setAssignTarget(chId, targetSel.value); this._openAssignPopover(anchorEl, chId); });
      pop.appendChild(rowOf(T('借用先'), targetSel));

      const toneKind = plan.toneKindFor(target, undefined, srcKind);
      if (toneKind) {
        const to = plan.toneOptionsFor(toneKind, srcKind);
        const toneSel = document.createElement('select');
        for (const pair of to.opts) {
          const o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          toneSel.appendChild(o);
        }
        toneSel.value = ent.tone !== undefined ? ent.tone : to.def;
        toneSel.addEventListener('change', () => plan.set(chId, { tone: toneSel.value === to.def ? null : toneSel.value }));
        pop.appendChild(rowOf(T('音色'), toneSel));
      }
      // 音色ごとの指定(音色一覧パネル)。NSFはネイティブ変換なので対象外
      if (plan.format() !== 'nsf' && target !== 'skip' && target !== 'dpcm') {
        const nTone = this.toneOverrideCount ? this.toneOverrideCount(chId) : 0;
        const tonesBtn = document.createElement('button');
        tonesBtn.type = 'button';
        tonesBtn.className = 'kbd-assign-pop-tones';
        tonesBtn.textContent = T('音色ごとに指定…') + (nTone ? ` (${nTone})` : '');
        tonesBtn.title = T('このchで使われている音色ごとに、載せ先と音色を指定する(音色一覧を開く)');
        tonesBtn.addEventListener('click', () => { this._closeAssignPopover(); if (this.onOpenTonePanel) this.onOpenTonePanel(chId); });
        pop.appendChild(rowOf(T('音色別'), tonesBtn));
      }
      if (plan.hasVolSliderFor(target)) {
        const volWrap = document.createElement('span');
        volWrap.className = 'kbd-assign-pop-vol';
        const vol = document.createElement('input');
        vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5';
        vol.value = String(ent.volPct !== undefined ? ent.volPct : 100);
        const volNum = document.createElement('span');
        volNum.textContent = vol.value + '%';
        vol.addEventListener('input', () => { volNum.textContent = vol.value + '%'; });
        vol.addEventListener('change', () => plan.set(chId, { volPct: vol.value === '100' ? null : parseInt(vol.value, 10) }));
        volWrap.appendChild(vol); volWrap.appendChild(volNum);
        pop.appendChild(rowOf(T('変換音量'), volWrap));
      }
      const foot = document.createElement('div');
      foot.className = 'kbd-assign-pop-foot';
      const pvLabel = document.createElement('label');
      pvLabel.className = 'kbd-assign-pop-preview';
      pvLabel.title = T('割当先の音で聴く(元chをミュートし、借用先のNSF音源で鳴らす。スキップは無音、DPCMは元のまま)');
      const pvChk = document.createElement('input');
      pvChk.type = 'checkbox'; pvChk.checked = this._previewMode;
      pvChk.addEventListener('change', () => this._setPreviewMode(pvChk.checked));
      pvLabel.appendChild(pvChk); pvLabel.appendChild(document.createTextNode('\u{1F3A7} ' + T('割当先の音で聴く')));
      foot.appendChild(pvLabel);
      const auto = document.createElement('button');
      auto.type = 'button';
      auto.textContent = T('自動に戻す');
      auto.addEventListener('click', () => { plan.clearChannel(chId); this._closeAssignPopover(); });
      foot.appendChild(auto);
      pop.appendChild(foot);

      document.body.appendChild(pop);
      const r = anchorEl.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(window.innerWidth - pop.offsetWidth - 4, r.left)) + 'px';
      pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 4, r.bottom + 2) + 'px';
      this._assignPop = pop;
      this._assignPopClose = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) this._closeAssignPopover(); };
      setTimeout(() => document.addEventListener('mousedown', this._assignPopClose), 0);
    }

    _closeAssignPopover() {
      if (this._assignPopClose) document.removeEventListener('mousedown', this._assignPopClose);
      this._assignPopClose = null;
      if (this._assignPop) { this._assignPop.remove(); this._assignPop = null; }
    }

    // 一覧の「割当」トグル(幅が足りるときだけ列展開する。案Eの2段目)
    _setAssignMode(on) {
      this._assignMode = !!on;
      try { localStorage.setItem('mml_kbdAssignMode', on ? '1' : '0'); } catch (e) { /* private browsing等 */ }
      this._leftEl.classList.toggle('kbd-left--assign', this._assignMode && !sourceIsMml);
      this._applyLayoutClasses();
      this._refreshAssignUi();
      // 「借用先/音色」列(200px)が入りきらない幅のままだと右側の列(L/R・vol・wave)が
      // 押し出されて見えなくなるので、収まる幅まで自動拡張する(setMode()のSPC下限と同じ考え方。
      // 縮小はしない=ユーザーが既に広げていればそのまま尊重する)
      if (this._assignMode) {
        const winEl = this.container.closest('.float-window');
        const placement = this._effectivePlacement();
        if (winEl && placement !== 'window') {
          // 一覧の幅(CSSの.kbd-left--assignで広がった値)+ロールの最低限が収まる窓幅を確保する
          const need = this._leftEl.offsetWidth + (placement === 'right' ? 260 : 24);
          if (winEl.offsetWidth < need) winEl.style.width = need + 'px';
        }
      }
    }

    // ── 割当プレビュー(「割当先の音で聴く」、src/audio/assign-preview.js) ────────────
    // ONの間、割当を持つ行は元chをミュートして借用先のNSF音源で鳴らす。スキップ行は無音、
    // E(DPCM)行と割当対象外の行(リズム等)は元の音のまま。再生側の実体は main.js が持ち、
    // ここは「何を・どの音色で」(getPreviewPlan)と「今の元chの状態」(getLiveChannels)を渡すだけ。
    _setPreviewMode(on) {
      this._previewMode = !!on;
      this._renderPreviewToggle();
      this._notifyPreview();
    }
    isPreviewMode() { return !!this._previewMode; }
    _notifyPreview() { if (this.onPreviewChange) this.onPreviewChange(); }
    _renderPreviewToggle() {
      if (!this._previewBtns) return;
      const editable = assignEditable();
      for (const btn of this._previewBtns) {
        btn.classList.toggle('kbd-preview-btn--on', !!this._previewMode);
        btn.disabled = !editable;
        btn.title = editable ? T('割当先の音で聴く(元chをミュートし、借用先のNSF音源で鳴らす。スキップは無音、DPCMは元のまま)') : assignLockReason();
      }
    }
    // 表示中の一覧の行ごとの割当(プレビュー用)。tone は選択が無ければ借用先ごとの既定値
    getPreviewPlan() {
      const plan = channelPlan();
      if (!assignEditable()) return [];
      const rows = (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.partEl && el.checkbox);
      const out = [];
      for (const el of rows) {
        if (plan.isUnassignable && plan.isUnassignable(el.id)) continue;
        const ent = plan.get(el.id) || {};
        const target = ent.target || el.defaultTarget || 'skip';
        const kind = plan.channelKind(el.id);
        const toneKind = plan.toneKindFor(target, undefined, kind);
        const tone = ent.tone !== undefined ? ent.tone : (toneKind ? plan.toneOptionsFor(toneKind, kind).def : null);
        out.push({ id: el.id, target, tone, kind, muted: !el.checkbox.checked });
      }
      return out;
    }
    // プレビュー中に元chをミュートする行か(getMuteConfig/previewSpcMuteMaskが使う)
    _previewMutesRow(el) {
      if (!this._previewMode || el.isAllRow || !el.partEl) return false;
      const plan = channelPlan();
      if (!assignEditable()) return false;   // MML表示中は元chを消さない
      if (plan.isUnassignable && plan.isUnassignable(el.id)) return false;
      const target = (plan.get(el.id) || {}).target || el.defaultTarget || 'skip';
      return target !== 'dpcm';
    }
    // SPC: プレビューで消す元ボイスのビットマスク(main.js effectiveSpcMute が spcMutedVoices とORする)
    previewSpcMuteMask() {
      let mask = 0;
      this._spcRowEls.forEach((el, idx) => { if (this._previewMutesRow(el)) mask |= (1 << idx); });
      return mask;
    }
    // 「今の元chの状態」を extractChannels() と同じ形で返す(再生側の onaudioprocess から毎フレーム呼ばれる)。
    // ライブ追跡のフォーマット(regSnapshots=[liveSnap]+Live関数)ではフレーム番号に関わらず現在値、
    // 全フレーム分のスナップショットがある場合はそのフレームの値。SPCはmain.jsのライブ関数へ委譲
    getLiveChannels(frameIdx) {
      if (this._mode === 'spc') return this.spcLiveRows ? this.spcLiveRows() : null;
      if (!this._state) return null;
      const snaps = this._state.regSnapshots || [];
      const live = snaps.length <= 1;
      const fi = live ? 0 : Math.max(0, Math.min(snaps.length - 1, frameIdx | 0));
      return extractChannels(snaps[fi] || {}, this._extraSnaps, fi, this._chips);
    }

    _renderAssignToggle() {
      const plan = channelPlan();
      if (!this._assignBtns) return;
      const editable = assignEditable();
      for (const btn of this._assignBtns) {
        btn.classList.toggle('kbd-assign-btn--on', !!this._assignMode);
        btn.classList.toggle('kbd-assign-btn--custom', !!plan && plan.isCustom());
        btn.disabled = !editable;
        btn.title = editable ? T('チャンネル割当(変換元ch → NSF側のパート)を表示') : assignLockReason();
      }
    }

    // ── 一括ミュート(見出しのミュート列のボタン) ──────────────────────
    // 表示中の一覧(SPCモードならボイス一覧)の実チャンネルだけを対象にする。
    // 全chミュートでなければ全ミュート、全ミュート済みなら全解除。
    _muteRows() {
      return (this._mode === 'spc' ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow && el.checkbox);
    }
    _allMuted() {
      const rows = this._muteRows();
      return rows.length > 0 && rows.every(el => !el.checkbox.checked);
    }
    _toggleAllMute() {
      const rows = this._muteRows();
      if (!rows.length) return;
      const muted = !this._allMuted(); // 全ミュートでなければ全ミュート、そうなら全解除
      if (this._mode === 'spc') {
        // SPCはボイス番号でミュート機構が別(main.js onSpcMuteChange → ビットマスク)
        rows.forEach((el, idx) => {
          el.checkbox.checked = !muted;
          if (this.onSpcMuteChange) this.onSpcMuteChange(idx, muted);
        });
      } else {
        for (const el of rows) {
          el.checkbox.checked = !muted;
          this._muteState.set(el.id, muted);
        }
        // 行ごとに呼ぶとその都度再生側へ設定が飛ぶので、まとめて1回だけ通知する
        if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
      }
      this._renderMuteAllBtn();
      this._notifyPreview();
    }
    // 見出しの vol 列のボタン: 全chの音量スライダーを100%へ戻す(行ごとのダブルクリックの
    // 全ch版)。ミュートと違いトグルではなく常にリセット。
    _resetAllVolumes() {
      const spc = this._mode === 'spc';
      const rows = (spc ? this._spcRowEls : this._rowEls).filter(el => !el.isAllRow);
      if (!rows.length) return;
      for (const el of rows) {
        const slider = el.row.querySelector('.kbd-vol-slider');
        if (slider) slider.value = '100';
      }
      if (spc) {
        for (let i = 0; i < this._spcVoiceVolumes.length; i++) this._spcVoiceVolumes[i] = 1;
        saveSpcVoiceVolumes(this._spcVoiceVolumes);
        if (this.onSpcVolumeChange) this.onSpcVolumeChange(this._spcVoiceVolumes.slice());
      } else {
        for (const el of rows) this._channelVolumes.set(el.id, 1);
        saveChannelVolumes(this._channelVolumes);
        if (this.onVolumeChange) this.onVolumeChange();
      }
    }

    // ボタンの見た目: 全ミュート中は押し込み表示にして「もう一度押すと解除」だと分かるようにする
    _renderMuteAllBtn() {
      if (!this._muteAllBtns) return;
      const all = this._allMuted();
      for (const btn of this._muteAllBtns) {
        btn.classList.toggle('kbd-muteall-btn--on', all);
        btn.title = all ? T('全チャンネルのミュートを解除') : T('全チャンネルをミュート');
      }
    }

    // 音源(チップ)単位でch一覧を開閉する。見出しクリックから呼ばれ、状態はlocalStorageへ。
    // ch行を隠すだけで、ミュート・音量・ピアノロールのレーンには一切触れない
    // (「見えていないチャンネルが勝手に黙る」を避けるため)。
    _toggleChipCollapse(chip) {
      if (!chip) return;
      if (this._chipCollapsed.has(chip)) this._chipCollapsed.delete(chip);
      else this._chipCollapsed.add(chip);
      try {
        localStorage.setItem('mml_kbdChipCollapsed', JSON.stringify([...this._chipCollapsed]));
      } catch (e) { /* ignore */ }
      this._applyChipCollapse();
    }

    // 折りたたみ状態を現在の行へ反映する(行の再構築後と開閉のたび)。畳んだ音源の見出しには
    // 隠れているch数を出し、行の更新はupdate()側で丸ごと省く(el.collapsed)
    _applyChipCollapse() {
      const groups = this._rowsInnerEl.querySelectorAll('.kbd-chip-group');
      for (const group of groups) {
        const chip = group.dataset.chip || '';
        const collapsed = !!chip && this._chipCollapsed.has(chip);
        group.classList.toggle('kbd-chip-group--collapsed', collapsed);
        const tog = group.querySelector('.kbd-chip-toggle');
        if (tog) tog.textContent = collapsed ? '▶' : '▼';
        const count = group.querySelector('.kbd-chip-count');
        if (count) count.textContent = T('({n}ch)', { n: group.querySelectorAll('.kbd-ch-row').length });
      }
      for (const el of this._rowEls) {
        const collapsed = !!el.chip && this._chipCollapsed.has(el.chip);
        // 畳んでいる間は更新を止めているので、開いた行は次のupdate()で必ず描き直させる
        if (el.collapsed && !collapsed) el.waveSig = '';
        el.collapsed = collapsed;
      }
    }

    _rebuildRows(channels) {
      this._rowsInnerEl.innerHTML = '';
      this._rowEls = [];
      let lastHeader = null;
      // チップごとに .kbd-chip-group で括る(多段表示のとき同じチップの行が列をまたいで
      // 千切れないようにするため。1列表示では見た目に影響しない)
      let group = null;
      for (const ch of channels) {
        const mi = getMuteInfo(ch.id);
        const muted = this._muteState.get(ch.id) || false;
        const disp = getChannelDisplay(ch.id);

        if (!group || (disp.header && disp.header !== lastHeader)) {
          group = document.createElement('div');
          group.className = 'kbd-chip-group';
          this._rowsInnerEl.appendChild(group);
          if (disp.header) {
            const headerRow = document.createElement('div');
            headerRow.className = 'kbd-chip-header kbd-chip-header--toggle';
            headerRow.title = T('クリックでこの音源のch一覧を開閉');
            // 見出しをクリックするとこの音源のch行だけを畳む(音源ごとの状態はlocalStorageへ保存)。
            // 畳んだ側はch数だけを見出しに出し、行の更新(波形描画など)もupdate()側で省く
            group.dataset.chip = disp.header;
            const tog = document.createElement('span');
            tog.className = 'kbd-chip-toggle';
            const label = document.createElement('span');
            label.className = 'kbd-chip-label';
            label.textContent = disp.header;
            const count = document.createElement('span');
            count.className = 'kbd-chip-count';
            headerRow.appendChild(tog);
            headerRow.appendChild(label);
            headerRow.appendChild(count);
            headerRow.addEventListener('click', () => this._toggleChipCollapse(disp.header));
            // チャンネルプール/ペア交互割当のチップ: 表示モード切替(実機スロット=素材のまま /
            // 合成ch=割当逆算)。行構成は同じでデータ系列だけが替わる。見た目は2状態の
            // トグルスイッチ(クリックで切替、点灯側が現在モード)。
            if (disp.pool) {
              const sw = document.createElement('span');
              sw.className = 'kbd-pool-toggle';
              sw.dataset.pool = disp.pool;
              sw.style.cssText = 'display:inline-flex;margin-left:8px;font-size:9px;border:1px solid #444;border-radius:8px;overflow:hidden;cursor:pointer;user-select:none;vertical-align:middle;';
              const modes = disp.poolModes || ['logical', 'phys'];
              sw.title = modes.indexOf('track') >= 0
                ? T('表示モード: トラック=ドライバ内部のトラックごと(和音は声部ごとの行) / 合成ch=音色と音程の連続性でメロディを同じ行へ束ね直す / 実機スロット=ドライバの割当そのまま')
                : T('チャンネルプール式音源の表示モード: 実機スロット=ドライバの巡回割当そのまま / 合成ch=音色と音程の連続性でメロディを同じ行へ束ね直す');
              const MODE_LABEL = { track: T('トラック'), logical: T('合成ch'), phys: T('実機スロット') };
              const segs = modes.map((m) => {
                const s = document.createElement('span');
                s.textContent = MODE_LABEL[m];
                s.style.cssText = 'padding:1px 6px;';
                s.dataset.mode = m;
                sw.appendChild(s);
                return s;
              });
              const current = () => this._poolModes[disp.pool] || modes[0];
              const paint = () => {
                const cur = current();
                for (const s of segs) {
                  const on = s.dataset.mode === cur;
                  s.style.background = on ? '#3a6ea5' : '#22242e';
                  s.style.color = on ? '#fff' : '#667';
                }
              };
              sw._paint = paint; // setPoolModes()からの再描画用
              paint();
              sw.addEventListener('click', (e) => {
                e.stopPropagation(); // 見出しクリック(折りたたみ)と二重に反応させない
                // 押した段へ切り替える(段の外=枠線の上なら2段のときだけ従来どおり反転)
                const seg = e.target && e.target.dataset && e.target.dataset.mode;
                const cur = current();
                const mode = seg || (modes.length === 2 ? modes[1 - modes.indexOf(cur)] : cur);
                if (mode === cur) return;
                this._poolModes[disp.pool] = mode;
                paint();
                if (this.onPoolModeChange) this.onPoolModeChange(disp.pool, mode);
              });
              headerRow.appendChild(sw);
            }
            group.appendChild(headerRow);
          }
          lastHeader = disp.header;
        }

        const row = document.createElement('div');
        const rowColor = this._getColor(ch.id, ch.color);
        row.className = 'kbd-ch-row';
        // ALL行(ch.isAllRow、HESの$0801全体バランス用。SPCのALL行と同じ考え方)は
        // 実チャンネルではないのでミュートチェックボックスの代わりにプレースホルダを置き、
        // wave/note/freqは何も表示しない(空欄のまま)。
        row.innerHTML =
          `<span class="kbd-dot" style="background:${rowColor}"></span>` +
          partChipHtml(ch) +
          (ch.isAllRow
            ? `<span class="kbd-mute-ph"></span>`
            : `<input type="checkbox" class="kbd-mute"${muted ? '' : ' checked'} title="${T('{ch} ミュート', { ch: ch.id })}">`) +
          `<span class="kbd-name"${ch.labelTitle ? ` title="${ch.labelTitle}"` : ''}>${ch.label || disp.name}</span>` +
          assignCellHtml(ch) +
          `<span class="kbds-lr kbds-l"></span>` +
          `<span class="kbds-lr"></span>` +
          `<span class="kbd-vol-num">0</span>` +
          `<span class="kbd-vol-wrap">` +
            `<span class="kbd-vol-bar" style="background:transparent"></span>` +
            (ch.isAllRow ? '' :
              `<input type="range" class="kbd-vol-slider" min="0" max="200" step="1" value="${Math.round((this._channelVolumes.get(ch.id) ?? 1) * 100)}" title="${T('{ch} 音量(中央100%・ダブルクリックで100%)', { ch: ch.id })}">` +
              `<span class="kbd-vol-tooltip"></span>`) +
          `</span>` +
          (ch.isAllRow ? `<span class="kbd-wave" style="visibility:hidden"></span>` : `<canvas class="kbd-wave" width="68" height="28"></canvas>`) +
          `<span class="kbd-note">${ch.isAllRow ? '' : '—'}</span>` +
          `<span class="kbd-freq"></span>`;

        let checkbox = null;
        if (!ch.isAllRow) {
          checkbox = row.querySelector('.kbd-mute');
          checkbox.addEventListener('change', () => {
            this._muteState.set(ch.id, !checkbox.checked);
            if (this.onMuteChange) this.onMuteChange(this.getMuteConfig());
            this._notifyPreview();
            this._renderMuteAllBtn(); // 見出しの一括ミュートボタンの状態を追随させる
            // ミュートはロールの見え方(減光)にも効くので、停止中でもその場で描き直す
            this._redrawRollForSpotlight();
          });
        }
        if (!ch.isAllRow) this._attachVolumeSlider(row, ch.id);

        // 波形アイコンをクリックで大波形表示に選択(ALL行には波形アイコン自体が無い)
        const waveCanvas = ch.isAllRow ? null : row.querySelector('.kbd-wave');
        const chId = ch.id;
        if (waveCanvas) {
          waveCanvas.classList.add('kbd-wave--clickable');
          if (chId === this._shownWaveId) waveCanvas.classList.add('kbd-wave--selected');
          waveCanvas.addEventListener('click', () => {
            this._selectWave(chId);
            // ★選んだ直後はカーソルがその行の上にあるので、そのままピックアップさせる。
            //   ホバーはmouseenterでしか発火しないため、クリックで選んだだけでは
            //   ロールが反応しなかった(ユーザー報告)
            this._setSpotlightHover(chId);
          });
        }

        // 丸のクリックで色ピッカーを開く(選んだ色は即localStorageへ保存され全表示に反映)
        this._attachColorPicker(row.querySelector('.kbd-dot'), ch.id, ch.color);

        // YM2610 ADPCM行(NA1-6/NB): note列クリックで手動ピッチキャリブレーション(onAdpcmCalibrate、
        // main.jsがプロンプトを出してチップの setSampleTuning を呼ぶ)。対象は「今その行で鳴っている
        // サンプル」(ch.adpcmSample)なので、直近の update() の channels(_lastChannels)から引く
        // (_prevChannelsは行再構築時にしか更新されず古い)
        // note列クリック: サンプルPCM系の行(adpcmSampleを持つ行)なら「打楽器/音階の手動指定 +
        // 基準音の手動補正」の小メニューを出す。★どちらもサンプル単位の指定なので、
        // 「今その行で鳴っているサンプル」(_lastChannels)を対象にする
        if (SAMPLE_ROW_RE.test(ch.id)) {
          const noteElForClick = row.querySelector('.kbd-note');
          noteElForClick.classList.add('kbd-note--clickable');
          noteElForClick.title = T('クリックで打楽器/音階の指定と基準音の手動補正');
          noteElForClick.addEventListener('click', () => {
            const cur = (this._lastChannels || this._prevChannels || []).find(c => c.id === chId);
            if (cur && cur.adpcmSample) this._openSampleMenu(noteElForClick, cur);
          });
        }

        const lrEls = row.querySelectorAll('.kbds-lr');

        // チャンネル割当(part列のチップ + 割当表示ONのときのセレクト。案E)
        if (!ch.isAllRow) this._wireAssign(row, ch);
        // スポットライト(案D): 行ホバー=一時的に注目、ch名クリック=固定
        if (!ch.isAllRow) this._attachSpotlight(row, ch.id);

        group.appendChild(row);
        this._rowEls.push({
          row,
          id: ch.id,
          chip: lastHeader || '', // この行が属する音源の見出し(折りたたみ判定用)
          collapsed: false,
          isAllRow: !!ch.isAllRow,
          volBar: row.querySelector('.kbd-vol-bar'),
          volNum: row.querySelector('.kbd-vol-num'),
          volWrap: row.querySelector('.kbd-vol-wrap'), volMasked: false, volTip: '',
          lEl: lrEls[0], rEl: lrEls[1],
          waveCanvas,
          waveSig: '',
          noteEl: row.querySelector('.kbd-note'),
          freqEl: row.querySelector('.kbd-freq'),
          checkbox,
          muteInfo: mi,
          color: rowColor,
          defaultColor: ch.color,
          letter: ch.letter,
          laneGroup: ch.laneGroup || null, // ロールの区画キー(PSF トラックモード。null=1行1区画)
          laneCopy: !!ch.laneCopy,
          // チャンネル割当(案E): part列チップとセレクトの参照+この行の既定の借用先
          partEl: row.querySelector('.kbd-part'),
          targetSel: row.querySelector('.kbd-assign-target'),
          toneSel: row.querySelector('.kbd-assign-tone'),
          drumBtn: row.querySelector('.kbd-assign-drum'),
          tonesBtn: row.querySelector('.kbd-assign-tones'),
          plainEl: row.querySelector('.kbd-assign-plain'),
          defaultTarget: ch.defaultTarget,
          target: ch.target,
        });
      }
      this._applyChipCollapse(); // 音源ごとの折りたたみ状態を新しい行へ反映
      // 大波形に表示するchを新しい一覧に合わせる(SPCモード中はSPC側の一覧が表示中なので触らない)
      if (this._mode !== 'spc') {
        this._consumePendingSelectionReset(this._rowEls.filter(el => el.waveCanvas).map(el => el.id));
        this._syncShownWave(this._rowEls);
        this._rebuildLanes(); // チャンネルごとのレーン表示も一覧に合わせる
      }
      this._refreshAssignUi(); // part列の文字・スキップ減光・重複警告を新しい行へ反映
      this._renderMuteAllBtn();
      this._applySpotlightClasses(); // 固定中のスポットライトの目印を新しい行へ復元
    }

    // ch別音量スライダー(音量バー領域に重ねる半透明オーバーレイ)を1行ぶん配線する。
    // 通常は薄く見えるだけで、ドラッグ中(またはホバー/フォーカス中)だけ数値ツールチップを
    // 出す。値は0〜200%(中央=100%)のrange inputで、_channelVolumes(localStorage永続化)を
    // 直接操作する。ダブルクリックで100%へ戻る。
    // getVolumeConfig()の項参照: 適用先はこのMapを直接読むため、ここではUIの見た目の
    // 同期(初期値反映・スライダー操作時の即時保存)だけを担当すればよい。
    _attachVolumeSlider(row, id) {
      const slider = row.querySelector('.kbd-vol-slider');
      const tooltip = row.querySelector('.kbd-vol-tooltip');
      if (!slider) return;
      const showTooltip = () => {
        tooltip.textContent = `${slider.value}%`;
        tooltip.classList.add('visible');
      };
      const hideTooltip = () => tooltip.classList.remove('visible');
      slider.addEventListener('pointerdown', () => { slider.classList.add('dragging'); showTooltip(); });
      slider.addEventListener('pointerup', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('pointercancel', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('keydown', () => showTooltip()); // キーボード操作(矢印キー)にも対応
      slider.addEventListener('blur', hideTooltip);
      slider.addEventListener('input', () => {
        const vol = (parseInt(slider.value, 10) || 0) / 100;
        showTooltip();
        this._channelVolumes.set(id, vol);
        saveChannelVolumes(this._channelVolumes);
        if (this.onVolumeChange) this.onVolumeChange();
      });
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
      });
    }

    // SPCボイス(V0〜V7)版。_spcVoiceVolumes(配列index=ボイス番号)を直接操作する点以外は
    // _attachVolumeSlider()と同じ(見た目・ツールチップ挙動を統一するため実装も揃えている)。
    _attachSpcVolumeSlider(row, idx) {
      const slider = row.querySelector('.kbd-vol-slider');
      const tooltip = row.querySelector('.kbd-vol-tooltip');
      if (!slider) return;
      const showTooltip = () => {
        tooltip.textContent = `${slider.value}%`;
        tooltip.classList.add('visible');
      };
      const hideTooltip = () => tooltip.classList.remove('visible');
      slider.addEventListener('pointerdown', () => { slider.classList.add('dragging'); showTooltip(); });
      slider.addEventListener('pointerup', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('pointercancel', () => { slider.classList.remove('dragging'); hideTooltip(); });
      slider.addEventListener('keydown', () => showTooltip());
      slider.addEventListener('blur', hideTooltip);
      slider.addEventListener('input', () => {
        const vol = (parseInt(slider.value, 10) || 0) / 100;
        showTooltip();
        this._spcVoiceVolumes[idx] = vol;
        saveSpcVoiceVolumes(this._spcVoiceVolumes);
        if (this.onSpcVolumeChange) this.onSpcVolumeChange(this._spcVoiceVolumes.slice());
      });
      slider.addEventListener('dblclick', () => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input'));
      });
    }

    // 波形アイコンのクリック: 選択チャンネルを切り替え、拡大表示を更新
    // NSF/SPC どちらの行がクリックされても対応できるよう両リストを見る（IDは重複しない）
    _selectWave(chId) {
      this._selectedId = chId;
      this._shownWaveId = chId;
      this._bigWaveSig = '';   // 強制再描画
      // 一覧の下の折りたたみ帯に置かれていて畳まれていたら、選んだ時点で開く
      if (this._bigWaveCollapsed && this._bigWaveBelow()) {
        this._bigWaveCollapsed = false;
        try { localStorage.setItem('mml_bigWaveCollapsed', '0'); } catch (e) { /* ignore */ }
        this._applyLayoutClasses();
      }
      // HESのALL行はwaveCanvasを持たない(el.waveCanvas===null)ため、他行を飛ばして
      // 例外にならないようガードする(ガード無しだとALL行で例外→以降の行のtoggleが
      // 一件も実行されず青枠が付かなくなる。大波形表示自体はupdate()側の毎フレーム
      // 再描画で別途追従するため気付かれにくい)。
      for (const el of this._rowEls) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      for (const el of this._spcRowEls) {
        if (el.waveCanvas) el.waveCanvas.classList.toggle('kbd-wave--selected', el.id === chId);
      }
      // 直近のチャンネル状態で即時描画
      const ch = (this._prevChannels || []).find(c => c.id === chId) ||
                 (this._prevSpcVoices || []).find(c => c.id === chId);
      if (ch) this._renderBigWave(ch);
    }

    // 選択チャンネルの素波形を右パネルへ描画（形状変化時のみ再描画）
    _renderBigWave(ch) {
      if (!ch || !ch.wave) return;
      // コピー可否は再描画をスキップする場合でも常に最新化する(表示形状のsigが
      // 同じでもチャンネル切替直後にボタン状態が古いままになるのを防ぐため)
      this._bigWaveCopyData = getCopyableWaveSamples(ch.wave);
      if (this._bigCopyBtn) this._bigCopyBtn.disabled = !this._bigWaveCopyData;

      // FM音色データ(OPLL/VRC7/YM2612/YM2610)。波形の見た目(sig)が同じでもパラメータは
      // 変わりうるので、sig判定より前に毎回テキストを比較して更新する
      if (this._bigPatchEl) {
        const ptype = ch.fmPatch ? ch.fmPatch.type : null;
        this._bigPatchCh = ptype ? ch : null;
        // 書式selectのoptionを音源種別に合わせる(種別が変わった時だけ作り直す)
        if (ptype !== this._bigPatchFmtType) {
          this._bigPatchFmtType = ptype;
          this._bigPatchFmtSel.innerHTML = '';
          for (const f of (FM_PATCH_FORMATS[ptype] || [])) {
            const o = document.createElement('option'); o.value = f.id; o.textContent = T(f.label);
            this._bigPatchFmtSel.appendChild(o);
          }
          if (ptype) this._bigPatchFmtSel.value = getFmPatchFormat(ptype);
          this._bigPatchFmtSel.style.display = ptype ? '' : 'none';
        }
        const text = formatFmPatch(ch);
        if (text !== this._bigPatchText) {
          this._bigPatchText = text;
          this._bigPatchEl.innerHTML = text ? renderFmPatchHtml(text) : '';
          this._bigPatchEl.style.display = text ? '' : 'none';
          this._bigPatchCopyBtn.style.display = text ? '' : 'none';
        }
      }

      const sig = bigWaveSig(ch.wave);
      if (sig === this._bigWaveSig) return;
      this._bigWaveSig = sig;
      const color = this._getColor(ch.id, ch.color);
      drawBigWave(this._bigCanvas, ch.wave, color);
      this._bigTitleEl.innerHTML =
        `<span class="kbd-bigwave-dot" style="background:${color}"></span>` +
        `${ch.id}　${waveTypeLabel(ch.wave)}`;
    }

    // 現在のチェックボックス状態からミュート設定を返す
    /** 1つでもミュートされている行があるか(無音自動送りの判定を止めるため。main.js参照) */
    hasAnyMute() {
      for (const el of this._rowEls) if (el.checkbox && !el.checkbox.checked) return true;
      for (const el of (this._spcRowEls || [])) if (el.checkbox && !el.checkbox.checked) return true;
      return false;
    }

    // 行ID → ミュート設定の座標({section, chip, key|index, type})。main.js の合成音ch打楽器化
    // (他chを全部ミュートして1chだけレンダリング)が「1chだけ生かした設定」を組むのに使う
    getMuteInfoFor(id) { return getMuteInfo(id) || null; }
    // 現在のピアノロールのタイムライン(共通形状 [{id, color, notes:[{startSec,endSec,midi,vol,drumKey?}]}])
    getRollTimeline() { return this._rollTimeline || null; }

    // opts.ignorePreview: 「割当先の音で聴く」中の元ch消し込みを含めない(WAV書き出しは常に元の音)
    getMuteConfig(opts) {
      const config = { apu: {}, expansion: {} };
      const withPreview = !(opts && opts.ignorePreview);
      for (const el of this._rowEls) {
        const mi = el.muteInfo;
        if (!mi) continue;
        const muted = !el.checkbox.checked || (withPreview && this._previewMutesRow(el));
        if (mi.section === 'apu') {
          config.apu[mi.key] = muted;
        } else {
          if (!config.expansion[mi.chip]) {
            config.expansion[mi.chip] = mi.type === 'array' ? [] : {};
          }
          if (mi.type === 'array') {
            config.expansion[mi.chip][mi.index] = muted;
          } else {
            config.expansion[mi.chip][mi.key] = muted;
          }
        }
      }
      return config;
    }

    // 現在のch別音量設定を返す(getMuteConfig()と同じ形状、値は0〜1)。getMuteConfig()と
    // 違い_rowEls(現在表示中の行のDOM)ではなく永続化Map(_channelVolumes)から直接組み立てる
    // (getMuteInfo(id)はidの文字列だけから決まる純粋関数のため、行がまだ再構築されて
    // いない/別フォーマットの行のままでも正しく引ける。ミュートで「再生開始直後、行が
    // まだ古いままの状態でgetMuteConfig()を呼ぶと的外れな設定を返す」問題が起きていた
    // [[keyboard-mute-state-new-file-leak]]のと同じ穴を音量では踏まないための設計)。
    getVolumeConfig() {
      const config = { apu: {}, expansion: {} };
      for (const [id, vol] of this._channelVolumes) {
        const mi = getMuteInfo(id);
        if (!mi) continue;
        if (mi.section === 'apu') {
          config.apu[mi.key] = vol;
        } else {
          if (!config.expansion[mi.chip]) {
            config.expansion[mi.chip] = mi.type === 'array' ? [] : {};
          }
          if (mi.type === 'array') {
            config.expansion[mi.chip][mi.index] = vol;
          } else {
            config.expansion[mi.chip][mi.key] = vol;
          }
        }
      }
      return config;
    }

    // SPCボイス音量(配列、V0〜V7)。呼び出し側が書き換えても影響しないようコピーを返す
    getSpcVolumeConfig() {
      return this._spcVoiceVolumes.slice();
    }

    // MMLチャンネル文字(A,B,...拡張音源含む) → 現在ミュート中かどうか。
    // 再生ハイライト機能(main.js)がハイライト表示をミュート状態と連動させるために使う
    isChannelMuted(letter) {
      if (!letter) return false;
      for (const el of this._rowEls) {
        if (el.letter === letter) return !el.checkbox.checked;
      }
      return false;
    }

    update(posSeconds) {
      if (!this._state) return;
      const { regSnapshots, totalFrames, samplesPerFrame, sampleRate } = this._state;
      if (!regSnapshots || totalFrames === 0) return;

      const frameDur = samplesPerFrame / sampleRate;
      const fi = Math.max(0, Math.min(totalFrames - 1, Math.floor(posSeconds / frameDur)));

      const snap = regSnapshots[fi] || {};
      const channels = extractChannels(snap, this._extraSnaps, fi, this._chips);
      // ドラムパッドへ載せた行(分離レンダリング由来など)は、ロールの打点から
      // 「今どのパッドが鳴っているか」を補う(_applyPadKeys 冒頭コメント参照)
      this._applyPadKeys(channels, posSeconds);
      // 直近の抽出結果(_prevChannelsは行の再構築時にしか更新されない=行構成の基準用。
      // 「今この行で鳴っているもの」を要する処理(ADPCM手動キャリブレーションのクリック等)はこちらを見る)
      this._lastChannels = channels;

      // 行数が同じでも並び/行名が変わったら組み直す(PSF のトラックモードは行名を持ち、表示モード切替や
      // 複製の印で行の意味が変わる。行名を持たない形式は ID の並びだけを見る)
      const rowSig = channels.some(c => c.label !== undefined) ? channels.map(c => c.id + '' + (c.label || '') + '' + (c.labelTitle || '')).join('') : null;
      if (channels.length !== this._rowEls.length || rowSig !== this._rowSig) {
        this._rowSig = rowSig;
        this._prevChannels = channels;
        this._rebuildRows(channels);
      }

      for (let i = 0; i < channels.length && i < this._rowEls.length; i++) {
        const ch = channels[i];
        const el = this._rowEls[i];

        // 音源ごと折りたたみで隠れている行は見えないので、波形アイコンの描画ごと省く
        // (鍵盤・ピアノロールは channels から直接描くのでここを飛ばしても欠けない)
        if (el.collapsed) continue;

        // L/R列(SPCのステレオパン表示と同じ考え方、色もSPCの.kbds-lrに合わせグレー固定)。
        // panL/panRを持つch(HES: ALL行の$0801, 各chの$0805。GBS: ALL行のNR50, 各chのNR51)
        // だけ値を出し、他フォーマットは空欄のまま。GBSのALL行はVIN有効時だけ黄色にする。
        if (el.lEl) { el.lEl.textContent = ch.panL !== undefined ? String(ch.panL) : ''; el.lEl.style.color = ch.vinL ? '#ffcc44' : ''; }
        if (el.rEl) { el.rEl.textContent = ch.panR !== undefined ? String(ch.panR) : ''; el.rEl.style.color = ch.vinR ? '#ffcc44' : ''; }

        // ALL行(実チャンネルではない)はL/R以外に表示するものが無いので、以降のvol/wave/note/freq
        // 更新はスキップする(チェックボックスも無いためel.checkbox.checkedへのアクセスもできない)。
        if (el.isAllRow) continue;

        const muted = !el.checkbox.checked;

        // DMC: $4011 が書き込まれた瞬間だけ検出（レジスタ値の変化＝直接DAC書き込み）。
        // 直接PCM再生中は発声扱いにし、その瞬間だけ数値を黄色にする。
        // ★対象は 2A03 DM 行(ch.dmcDirect)だけ。以前は sample:true の全行(RF5C164/PWM/ADPCM等)で
        //   1つの _lastDmc4011 を共有していたため、サンプル行が複数あると隣の行の値と比較して
        //   常に「書き換わった」と判定され、PCM行の音量数値が意味なく黄色になり active も強制されていた
        let dmcWritten = false;
        if (ch.dmcDirect && ch.dmcReg !== undefined) {
          if (this._lastDmc4011 !== null && ch.dmcReg !== this._lastDmc4011) {
            dmcWritten = true;
            ch.active = true;
          }
          this._lastDmc4011 = ch.dmcReg;
        }

        const showVol = ch.active && !muted;
        // volApparent(干渉ぶんを含む実際に聞こえる大きさ)があればバーはそちらを出す。
        // vol はロールが使うレジスタどおりの値なので混ぜない。
        const volShown = ch.volApparent !== undefined ? ch.volApparent : ch.vol;
        const pct = showVol ? Math.round(volShown * 100) : 0;
        el.volBar.style.width = pct + '%';
        el.volBar.style.background = pct > 0 ? el.color : 'transparent';

        // 減衰エンベロープ、DMC直接書き込み、または見かけ音量が下がっている(maskBy)時は
        // 音量数値を黄色にして「レジスタをそのまま読んだ値ではない/そのとおりには鳴っていない」を示す。
        const masked = showVol && !!ch.maskBy;
        const rawStr = (showVol && ch.rawVol !== null && ch.rawVol !== undefined)
          ? String(ch.rawVol) : '';
        el.volNum.textContent = rawStr;
        el.volNum.style.color = !rawStr ? '#555566'
          : ((ch.envMode === true || dmcWritten || masked) ? '#ffcc44' : '#e6e6ef');
        // 干渉で音量が下がっている行は音量バーの枠も黄色にして、バーの短さが
        // 「レジスタが小さい」ではなく「干渉で削られている」ことを示す。
        if (el.volWrap && el.volMasked !== masked) {
          el.volWrap.classList.toggle('kbd-vol-wrap--masked', masked);
          el.volMasked = masked;
        }
        // カーソルを合わせた時の説明。干渉源(ノイズ/三角波/DPCM)を名指しする。
        // 三角波は数値そのものが比率、ノイズは数値がレジスタ値なので言い回しを変える(maskTip)。
        const tip = masked ? T(ch.maskTip || MASK_TIP_RATIO, { src: T(MASK_SRC[ch.maskBy] || '') }) : '';
        if (el.volTip !== tip) {
          el.volNum.title = tip;
          if (el.volWrap) el.volWrap.title = tip;
          el.volTip = tip;
        }

        // 素波形アイコン: 発声中のみ更新。使っていないチャンネルは更新しない
        // （発声→停止の遷移時に1回だけ暗色で描き、以後は据え置き＝波形データのハッシュ計算も省略）。
        const waveOn = ch.active && !muted;
        if (waveOn || el.waveOn !== waveOn) {
          const wsig = waveSig(ch.wave, waveOn);
          if (wsig !== el.waveSig) {
            el.waveSig = wsig;
            drawWaveIcon(el.waveCanvas, ch.wave, el.color, waveOn);
          }
          el.waveOn = waveOn;
        }

        if (!ch.active || muted) {
          // APUチャンネルが$4015で無効化されている場合は "-" を表示
          const apuIds = ['P1','P2','TR','NO','DM'];
          const isApuDisabled = apuIds.includes(ch.id) && !muted;
          el.noteEl.textContent = muted ? '(M)' : (isApuDisabled ? '-' : '—');
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else if (ch.dda) {
          // HES PSG: DDA(ソフトウェアPCM)モードで生DAC値を直接再生中
          el.noteEl.textContent = 'PCM';
          el.noteEl.style.color = '#e6e6ef';
          el.freqEl.textContent = '';
        } else if (ch.noise) {
          // note: 周期インデックス数値。長周期=白 / 短周期=黄。ch.noiseLabelがあれば
          // (HES: 固定文字列'noise'。ノイズ周期がindex化されていない音源向け)そちらを優先。
          el.noteEl.textContent = ch.noiseLabel !== undefined ? ch.noiseLabel : String(ch.noiseIndex);
          el.noteEl.style.color = ch.noiseShort ? '#ffcc44' : '#e6e6ef';
          // freq: ノイズ周波数 (Hz)。ノイズ周波数の実測値を持たない音源では空欄のまま。
          el.freqEl.textContent = (ch.noiseFreq !== undefined) ? (Math.round(ch.noiseFreq).toLocaleString() + ' Hz') : '';
        } else if (ch.adpcmPitch) {
          // YM2610 ADPCM-A/B: adpcmExact(サンプル解析ピッチ×再生レート)なら通常の音名+実周波数、
          // それ以外(ADPCM-Bの解析不能時)は目安の音名に'?'を付け、freq列にはDelta-N由来の
          // 再生レート(Hz、=元のPCMサンプリングレート)を出す
          const midi = adpcmPitchToMidi(ch);
          if (ch.adpcmExact) {
            el.noteEl.textContent = midi !== null ? midiToName(midi) : '??';
            el.noteEl.style.color = ch.adpcmManual ? '#ffcc44' : '#e6e6ef'; // 手動補正済みは黄色
            el.freqEl.textContent = ch.freq > 0 ? ch.freq.toFixed(1) + ' Hz' : '';
          } else {
            el.noteEl.textContent = midi !== null ? midiToName(midi) + '?' : '??';
            el.noteEl.style.color = midi !== null ? '#e6e6ef' : '#555566';
            el.freqEl.textContent = ch.freq > 0 ? Math.round(ch.freq).toLocaleString() + ' Hz' : '';
          }
        } else if (ch.drumKey && this._drumLaneOf && this._drumLaneOf.has(ch.drumKey)) {
          // 打楽器として鳴っているサンプルPCM: note列は「今このスロットが鳴らしている太鼓」
          // (ドラム区画のレーンのラベルと色)。プール式チップは同じ太鼓が毎回別スロットへ
          // 移るので、行を見ただけでどの音か分かるこの表示が効く。
          // (従来はdmcRateIdxを出していたが、この経路では常に固定値15で情報が無かった)
          const laneIdx = this._drumLaneOf.get(ch.drumKey);
          const laneInfo = this._drumLanes[laneIdx];
          el.noteEl.textContent = (laneInfo && laneInfo.label) || '?';
          el.noteEl.style.color = (laneInfo && laneInfo.color) || '#e6e6ef';
          el.freqEl.textContent = ch.dmcFreq > 0 ? Math.round(ch.dmcFreq).toLocaleString() + ' Hz' : '';
        } else if (ch.padRow) {
          // パッドに載っている行(_applyPadKeys)で、今この瞬間に当たっている打点が無い場合。
          // レートの疑似音程を出しても意味が無いので空欄にする
          el.noteEl.textContent = '—';
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else if (ch.sample) {
          // note: $4010 再生速度インデックス / freq: DPCM再生周波数
          el.noteEl.textContent = String(ch.dmcRateIdx);
          el.noteEl.style.color = '#e6e6ef';
          el.freqEl.textContent = Math.round(ch.dmcFreq).toLocaleString() + ' Hz';
        } else {
          el.noteEl.style.color = '#e6e6ef';
          const midi = freqToMidi(ch.freq);
          // freq列はFDSモジュレーション適用後の実ピッチ(ch.modFreq)があればそちらを表示する。
          // note(音名)は表示のちらつきを避けるため変調前のch.freqのまま判定する
          const dispFreq = ch.modFreq !== undefined ? ch.modFreq : ch.freq;
          if (midi !== null) {
            el.noteEl.textContent = midiToName(midi);
            el.freqEl.textContent = dispFreq.toFixed(1) + ' Hz';
          } else {
            // 鍵盤範囲外(C1未満/C8超)は音名を出しつつ色を落とす(freqToMidiAny参照)。
            // 周波数はあるのに音名が決まらないときだけ '??'
            const any = freqToMidiAny(ch.freq);
            el.noteEl.textContent = any !== null ? midiToName(any) : (ch.freq > 0 ? '??' : '—');
            if (any !== null) el.noteEl.style.color = '#9a9ab0';
            el.freqEl.textContent = ch.freq > 0 ? dispFreq.toFixed(1) + ' Hz' : '';
          }
          // FDSのピッチモジュレーション(MH<n>)有効中はfreq列を黄色で強調し、
          // どのレジスタ条件によるものかtitle属性(ツールチップ)で示す。
          // ★注意: title自体はfreqEl(モジュレーション中は毎フレームtextContentが
          // 変化する要素)ではなくrow(行全体、変調中でも中身が変わらない要素)に
          // 付ける。freqElに付けるとブラウザがtextContent変化のたびhoverタイマーを
          // リセットしてしまい、ネイティブツールチップが実質出せなくなる(SPCのADSR
          // ツールチップは値が音符の間ほぼ変化しないため同じ問題が起きなかっただけ)
          el.freqEl.style.color = ch.modActive ? '#ffcc44' : '';
          el.row.title = ch.modActive ? T('$4087 bit7=0 (モジュレーション有効)') : '';
        }
      }

      // 選択チャンネルの大波形を更新（FDS/N163 等は波形が変化するため毎フレーム判定）
      if (this._shownWaveId) {
        const sel = channels.find(c => c.id === this._shownWaveId);
        if (sel) this._renderBigWave(sel);
      }

      // SPC ボイスを合流させてピアノに反映(色はユーザー上書きを解決してから渡す)
      const allChannels = channels.map(c => ({ ...c, color: this._getColor(c.id, c.color) }))
        .concat(this._spcVoices.map(v => ({
          id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
          active: v.active, rawVol: null, rawVolMax: null,
        })));
      this._drawPianos(allChannels);

      // ピアノロールはSPCモード中は updateSpcVoices() 側が描画するため、ここでは
      // それ以外(NSF/MML/KSS)のときだけ描画する(同じcanvasへの二重描画を避ける)。
      if (this._mode !== 'spc') this._renderRoll(posSeconds);
    }

    /** チャンネルプール式チップの表示モード初期値(main.jsがlocalStorageから復元して渡す)。 */
    setPoolModes(modes) {
      Object.assign(this._poolModes, modes || {});
      for (const sw of this._rowsInnerEl.querySelectorAll('.kbd-pool-toggle')) {
        if (sw._paint) sw._paint(); // data-poolごとに自分のモードを塗り直す
      }
    }

    // トラックid(NSF:'P1'等/SPC:'V0'-'V7'/KSS:'KP1'等)がミュート中かどうかを判定する。
    // SPCボイスは _muteState を経由しない専用のミュート機構(spc-row checkbox)を使うため、
    // _spcRowEls から直接読む。それ以外は通常のチャンネル一覧と共通の _muteState を使う。
    _isTrackMuted(id) {
      if (typeof id === 'string' && /^V\d+$/.test(id)) {
        const idx = parseInt(id.slice(1), 10);
        const el = this._spcRowEls[idx];
        if (el) return !el.checkbox.checked;
      }
      return this._muteState.get(id) || false;
    }

    // ピアノロール描画。音程軸は鍵盤とkeyX()で共有し、時間軸は「現在(鍵盤に接する端)→未来」
    // へ向かって音符を流す。向き(縦=上から降る/横=右から流れる)はmakeRollGeom()が吸収する。
    // _rollTimeline が無い間(先読みキャプチャ完了前など)は前回の描画内容をクリアするだけにする。
    // 描画先: 全チャンネルまとめ(rollLanes='all')なら_rollCanvas 1枚(フィルタ無し)、
    // チャンネルごと(rollLanes='perChannel')なら各レーンのcanvas(そのchのノートだけ)。
    // onlyId: null=全ch / 文字列=その行だけ / 配列=その区画に属する行だけ(PSF トラックモードの和音の声部+複製)
    _inLane(onlyId, id) {
      if (onlyId === null || onlyId === undefined) return true;
      return Array.isArray(onlyId) ? onlyId.indexOf(id) >= 0 : onlyId === id;
    }
    _rollTargets() {
      if (this._layout.rollLanes === 'perChannel' && this._lanes && this._lanes.length) {
        return this._lanes.map(l => ({ canvas: l.rollCanvas, onlyId: l.ids || l.id, lane: l }));
      }
      return [{ canvas: this._rollCanvas, onlyId: null, lane: null }];
    }

    _renderRoll(posSeconds) {
      const targets = this._rollTargets();
      if (!targets.length || !targets[0].canvas) return;
      // 折りたたみ中(表示要素がdisplay:none)は描かない
      const host = targets[0].onlyId === null ? this._rollCanvas : this._lanesEl;
      if (!host || host.style.display === 'none') return;

      // posSeconds(実プレイヤーのgetPosition())はオーディオコールバック単位(数十〜100ms程度)
      // でしか更新されないため、rAF(約16ms間隔)からは同じ値が何フレームも続いた後に一気に
      // 進む「カクつき」に見える。そこで「最後に実測位置が更新された時点の確定値」
      // (_rollSongTimeBase)は実測差分だけで進め(二重加算を避けるため補間分は加算しない)、
      // 描画に使うposはそこに「その後の壁時計経過分」をその場で足すだけにする(蓄積しない)。
      // 実測値が来るたびbaseが実測差分ぶんだけ更新され、補間分は自動的に上書きされる。
      // また、実測位置がしばらく(ROLL_INTERP_CAP_MS以上)更新されない=再生していない状態
      // とみなし、補間による経過をそこで頭打ちにして停止中はロールが動き続けないようにする。
      const ROLL_INTERP_CAP_MS = 400;
      const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const rawPos = posSeconds || 0;
      const speedFactor = 1 / (this._speedDenom || 1);
      if (this._rollLastRawPos === null || rawPos < this._rollLastRawPos - 0.001) {
        // 新規再生開始(rawPos=0)またはシークによる巻き戻り。rawPosは「現在の速度で
        // 曲頭から目標地点まで再生した場合の実時間」(stream-player.jsのseek()参照)
        // なので、rawPos*speedFactorが常に正しい曲内絶対秒になる(新規再生開始時は
        // rawPos=0なので特別扱い不要で0と一致する)。
        this._rollSongTimeBase = rawPos * speedFactor;
        this._rollBaseWallMs = nowMs;
        this._rollCursor = {}; // 巻き戻り時は各trackの走査起点キャッシュも巻き戻す
      } else if (rawPos > this._rollLastRawPos + 1e-6) {
        this._rollSongTimeBase += (rawPos - this._rollLastRawPos) * speedFactor; // 実測位置が更新された
        this._rollBaseWallMs = nowMs;
      }
      this._rollLastRawPos = rawPos;
      const elapsedSinceBaseMs = Math.min(ROLL_INTERP_CAP_MS, Math.max(0, nowMs - (this._rollBaseWallMs || nowMs)));
      let pos = this._rollSongTimeBase + (elapsedSinceBaseMs / 1000) * speedFactor;
      // ロールをドラッグしてシーク中は、実測位置でなくドラッグ位置を表示する(_attachRollSeekDrag参照)。
      // 巻き戻し方向にも動くので走査起点キャッシュは使わない
      if (this._rollDrag) {
        pos = this._rollDrag.pos;
        this._rollCursor = {};
      }
      this._rollLastDrawnPos = pos;
      for (const t of targets) {
        // ヒットテスト(_trackAtRollPoint)が同じ座標系を使えるよう、そのcanvasの表示条件を控える
        t.canvas._rollOnlyId = t.onlyId;
        t.canvas._rollLane = t.lane || null;
        this._drawRollCanvas(t.canvas, pos, t.onlyId, t.lane || null);
      }
    }

    // 時間軸: 曲内の絶対秒(0,1,2,3…)ごとに音程軸方向の線を引き、ノートと同じ式でスクロールさせる。
    // 再生が進むにつれて線が鍵盤側へ流れ、新しい秒の線が先読みの果て(縦向き=上端、横向き=右端)
    // から現れる(累積の経過時間)。ロールと楽譜モードで共通
    _drawRollTimeGrid(ctx, g, pos) {
      const H = g.H;
      const winEnd = pos + g.windowSec;
      ctx.strokeStyle = '#3d3d4a';
      ctx.fillStyle = '#6b6b7a';
      ctx.font = '9px ' + fontStack('sans');
      const firstSec = Math.ceil(pos);
      for (let s = firstSec; s < winEnd; s++) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        if (g.vertical) {
          const y = Math.round(H - g.tPx(s - pos)) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(g.W, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${s}s`, 2, y - 1);
        } else {
          const x = Math.round(g.tPx(s - pos)) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.textBaseline = 'top';
          ctx.fillText(`${s}s`, x + 2, 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    // ── 楽譜モード(五線、時間比例。ROADMAP「フェーズ外: 楽譜出力」段階3) ──────────────
    // ロールと同じ座標系(makeRollGeom: 時間軸 t=再生位置からの相対秒、音程軸 p)で、音程軸だけを
    // 五線に置き換える。描くのは五線・小節線・符頭・加線・臨時記号・休符の目印・パート名まで
    // (旗/連桁/音価の型は描かない=段階4の本記譜)。音符の長さは時間比例の棒で示す。
    // 再生位置の「今」は鍵盤側の端(t=0)で、鳴っている音符の符頭は端に留まって光る。
    // データは setScore() の表記モデル。frameStart/frameEnd(コンパイラのフレーム)を fps で秒にする。
    _drawScoreCanvas(canvas, ctx, g, pos, onlyId, lane) {
      const score = this._score;
      const notation = score.notation;
      const fps = score.fps || 60;
      const H = g.H;
      this._drawRollTimeGrid(ctx, g, pos);
      // ループ地点(L)より後ろの末尾複製(compile() が tracks に足す区間)は譜面には無いので、
      // その区間の再生位置はループ地点からの相対位置へ戻して描く
      let posFrame = pos * fps;
      if (score.loopPointFrame != null && score.totalFrames > 0) {
        const natural = (score.totalFrames + score.loopPointFrame) / 2;
        const loopLen = natural - score.loopPointFrame;
        if (loopLen > 0 && posFrame >= natural) posFrame = score.loopPointFrame + ((posFrame - natural) % loopLen);
      }
      const posSec = posFrame / fps;
      const windowSec = g.windowSec;
      // 描くパート: チャンネルごとのレーン表示ならそのchの文字に対応するパートだけ
      const rowByLetter = new Map();
      for (const el of this._rowEls) if (el.letter) rowByLetter.set(el.letter, el);
      let parts = notation.parts;
      if (onlyId !== null && onlyId !== undefined) {
        const firstId = Array.isArray(onlyId) ? onlyId[0] : onlyId;
        const row = this._rowEls.find(e => e.id === firstId);
        parts = parts.filter(p => row && p.letter === row.letter);
      }
      if (!parts.length) return;
      const spotId = this._effectiveSpotlightId();
      const n = parts.length;
      const bandH = g.pitchLen / n;                      // 1パートの帯(音程軸方向のpx)
      const sp = Math.max(1.5, Math.min(7, bandH / 11)); // 五線の間隔
      const r = Math.max(1.5, sp * 0.55);                // 符頭の半径
      const labelPx = Math.max(8, Math.min(11, sp * 1.8));
      const LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
      const ACC_TEXT = { '-2': '♭♭', '-1': '♭', '0': '♮', '1': '♯', '2': '\u{1D12A}' };
      // 音程軸の線を [pLo, pHi] × 時間 t で引く/時間軸の線を p で引く(向きの違いは g が吸収)
      const lineT = (t, pLo, pHi) => { const a = g.point(pLo, t), b = g.point(pHi, t); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };
      const lineP = (p, tLo, tHi) => { const a = g.point(p, tLo), b = g.point(p, tHi); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); };

      parts.forEach((part, pi) => {
        // 先頭のパートを最高音側(縦向き=右、横向き=上)へ。帯の中央に五線を置く
        const bandLo = g.pitchLen - (pi + 1) * bandH;
        const pBase = bandLo + bandH / 2 - 2 * sp;       // 第1線(いちばん低い線)
        const row = rowByLetter.get(part.letter);
        const color = row ? row.color : '#9a9ab0';
        const muted = row ? this._isTrackMuted(row.id) : false;
        const dim = (muted || (spotId && row && row.id !== spotId)) ? SPOTLIGHT_DIM_ALPHA : 1;
        // 音部記号ごとの第1線の音(全音階の段番号: オクターブ*7+文字)。ト音=E4、ヘ音=G2、打楽器=E4(unpitched の表示位置)
        const ref = (part.clef && part.clef.sign === 'F') ? 2 * 7 + 4 : 4 * 7 + 2;
        // 帯の境目(薄く)と五線
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#3d3d4a';
        ctx.lineWidth = 1;
        ctx.beginPath(); lineP(Math.round(bandLo) + 0.5, 0, g.timeLen); ctx.stroke();
        ctx.globalAlpha = 0.9 * dim;
        ctx.strokeStyle = '#8a8aa0';
        ctx.beginPath();
        for (let i = 0; i < 5; i++) lineP(Math.round(pBase + i * sp) + 0.5, 0, g.timeLen);
        ctx.stroke();
        // 小節線と小節番号
        ctx.fillStyle = '#9a9ab0';
        ctx.font = `${labelPx}px ` + fontStack('sans');
        for (const m of part.measures) {
          const t = m.frameStart / fps - posSec;
          if (t < 0 || t > windowSec) continue;
          ctx.globalAlpha = 0.8 * dim;
          ctx.strokeStyle = '#c0c0d0';
          ctx.beginPath(); lineT(g.tPx(t), pBase, pBase + 4 * sp); ctx.stroke();
          if (sp >= 3) {
            const pt = g.point(pBase + 4 * sp + 2, g.tPx(t) + 2);
            ctx.textBaseline = g.vertical ? 'bottom' : 'bottom';
            ctx.textAlign = 'left';
            ctx.fillText(String(m.number), pt.x, pt.y);
          }
        }
        // 音符片(時間順)。鍵盤側へ流れ去った片は走査起点をキャッシュして飛ばす(ロールと同じ)
        const flat = part.flatItems || [];
        let idx = this._scoreCursor[part.letter] || 0;
        if (idx > flat.length) idx = flat.length;
        while (idx < flat.length && flat[idx].frameEnd / fps <= posSec) idx++;
        this._scoreCursor[part.letter] = idx;
        for (let i = idx; i < flat.length; i++) {
          const it = flat[i];
          const t0 = it.frameStart / fps - posSec;
          if (t0 >= windowSec) break;
          const t1 = Math.min(windowSec, it.frameEnd / fps - posSec);
          const tA = Math.max(0, t0);
          if (it.rest) {
            // 休符: 第3線の上に薄い帯(小節休符はさらに薄く)
            if (t1 <= tA) continue;
            ctx.globalAlpha = (it.measureRest ? 0.10 : 0.22) * dim;
            ctx.fillStyle = '#c0c0d0';
            const rr = g.rect(pBase + 2 * sp - sp * 0.3, sp * 0.6, g.tPx(tA), g.tPx(t1), 1);
            ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
            continue;
          }
          const sym = it.pitch || it.unpitched;
          if (!sym) continue;
          const sounding = t0 <= 0 && t1 > 0;
          // 和音(ピアノ譜の表記モデル)は各音を同じ手順で描く
          const syms = it.chord && it.chord.length > 1 ? it.chord.map(c => c.pitch) : [sym];
          for (const sy of syms) {
          const stepIdx = sy.octave * 7 + LETTER_INDEX[sy.step];
          const d = stepIdx - ref;                       // 第1線からの半段数
          const p = pBase + d * sp / 2;
          if (p < bandLo - sp || p > bandLo + bandH + sp) continue; // 帯の外(極端な音域)は描かない
          // 音長の棒(時間比例)。タイの続き片も棒だけは描く
          ctx.globalAlpha = 0.45 * dim;
          ctx.fillStyle = color;
          const bar = g.rect(p - sp * 0.18, sp * 0.36, g.tPx(tA), g.tPx(t1), 2);
          ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
          if (it.tieStop) continue;                      // タイで繋いだ続きの片: 符頭は打ち直さない
          const tHead = g.tPx(tA) + r;                   // 符頭の中心(時間軸)。鳴っている間は端に留まる
          // 加線(第1線より下/第5線より上の、線の位置に当たる半段ごと)
          ctx.globalAlpha = 0.9 * dim;
          ctx.strokeStyle = '#8a8aa0';
          ctx.lineWidth = 1;
          if (d < 0 || d > 8) {
            ctx.beginPath();
            const ks = d < 0 ? -2 : 10, ke = d, kd = d < 0 ? -2 : 2;
            for (let k = ks; (kd < 0 ? k >= ke : k <= ke); k += kd) {
              const a = g.point(pBase + k * sp / 2, tHead - r * 1.7), b = g.point(pBase + k * sp / 2, tHead + r * 1.7);
              ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
            }
            ctx.stroke();
          }
          // 符頭(打楽器は×)
          const c = g.point(p, tHead);
          ctx.globalAlpha = dim;
          ctx.fillStyle = color;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, r * 0.5);
          if (part.percussion) {
            ctx.beginPath();
            ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x + r, c.y + r);
            ctx.moveTo(c.x - r, c.y + r); ctx.lineTo(c.x + r, c.y - r);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.ellipse(c.x, c.y, g.vertical ? r * 1.15 : r * 1.3, g.vertical ? r * 1.3 : r * 1.15, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          if (sounding) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(c.x, c.y, r * 1.9, 0, Math.PI * 2);
            ctx.stroke();
          }
          // 臨時記号(符頭の手前=鍵盤側)
          if (it.accidental && sp >= 3) {
            const acc = ACC_TEXT[String(sy.alter)] || '';
            if (acc) {
              ctx.font = `${Math.round(sp * 2.2)}px ` + fontStack('sans');
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = '#e6e6ef';
              const ap = g.point(p, tHead - r * 2.6);
              ctx.fillText(acc, ap.x, ap.y);
            }
          }
          }
        }
        // パート名(帯の高音側の端、鍵盤側)
        ctx.globalAlpha = 0.9 * dim;
        ctx.fillStyle = color;
        ctx.font = `${labelPx}px ` + fontStack('sans');
        ctx.textAlign = 'left';
        if (g.vertical) { ctx.textBaseline = 'bottom'; ctx.fillText(part.name, bandLo + 2, H - 2); }
        else { ctx.textBaseline = 'top'; ctx.fillText(part.name, 2, H - (bandLo + bandH) + 2); }
      });
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    // 1枚のロールcanvasを曲内秒posの状態で描く。onlyId!=nullならそのチャンネルのノートだけ描く
    // (チャンネルごとのレーン表示用。laneが渡されたら音程窓=そのchの音域[lane.offWhite,
    // +lane.visWhite)だけを音程軸いっぱいに描く。窓は_updateLaneRanges()が曲全体から決めた
    // 固定値で、再生中に動かない)。
    _drawRollCanvas(canvas, pos, onlyId, lane) {
      // 内部解像度は表示サイズ(CSS px)に追随させる(縦向き・一覧の下配置ではCSSの固定高さ
      // ROLL_CANVAS_HEIGHTと一致する)。フォールバックのclientHeightはborder-topを含まない値
      const newW = canvas._cachedWidth || canvas.offsetWidth || 560;
      const newH = canvas._cachedHeight || canvas.clientHeight || canvas.height;
      if (newW === 0 || newH === 0) return;
      if (canvas.width !== newW) canvas.width = newW;
      if (canvas.height !== newH) canvas.height = newH;
      const nDrum = (this._drumLanes || []).length;
      const g = makeRollGeom(this._layout.rollOrientation, canvas.width, canvas.height, lane ? (lane.visWhite || 0) : 0, nDrum);
      const { wk: wkW, bk: bkW, H } = g;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, H);
      // 楽譜モード: 表記モデルがあるとき(MML再生中)だけ五線で描く。無ければ従来のロール
      if (this._layout.rollView === 'score' && this._score) {
        this._drawScoreCanvas(canvas, ctx, g, pos, onlyId, lane);
        return;
      }
      const windowSec = g.windowSec;
      const winEnd = pos + windowSec;
      const offPx = lane ? (lane.offWhite || 0) * wkW : 0; // 音程窓の低音側端(px)。keyX()の結果から引く
      const pitchOff = g.drumOff - offPx; // 音程側の座標補正(ドラム区画ぶん右へ + 窓スクロール)

      // ドラム区画のレーングリッド(淡い下地+レーン境界)。音程鍵盤より低音側に置く。
      for (let i = 0; i < nDrum; i++) {
        const d = drumLaneX(i, 0, 1, g.drumLaneW);
        const x0 = d.x - offPx;
        if (x0 + d.size < 0 || x0 > g.pitchLen) continue;
        ctx.fillStyle = '#000000';
        ctx.globalAlpha = i % 2 ? 0.06 : 0.12; // 交互の縞でレーンの境目を分かりやすく(黒鍵の網掛けと同系)
        let r = g.rect(x0, d.size, 0, g.timeLen);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#3d3d4a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.vertical) { const x = Math.round(x0) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        else { const y = Math.round(H - x0) + 0.5; ctx.moveTo(0, y); ctx.lineTo(g.W, y); }
        ctx.stroke();
      }
      // ドラム区画と音程鍵盤の境目(区画があるときだけ)
      if (nDrum) {
        ctx.strokeStyle = '#7a86a8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (g.vertical) { const x = Math.round(g.drumOff - offPx) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        else { const y = Math.round(H - (g.drumOff - offPx)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(g.W, y); }
        ctx.stroke();
      }

      // 鍵盤ごとの音程グリッド(白鍵の境界線+黒鍵レーンの淡い網掛け)とCの音名ラベル。
      // グリッドは音程軸に直交する全時間帯の帯/線なので、時間軸[0, timeLen)いっぱいに引く。
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const rel = midi - MIDI_MIN;
        const semi = rel % 12;
        const keyPos = keyX(midi, wkW);
        if (!keyPos) continue;
        keyPos.x += pitchOff;
        if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
        if (IS_BLACK[semi]) {
          ctx.fillStyle = '#000000';
          ctx.globalAlpha = 0.25;
          const r = g.rect(keyPos.x - bkW / 2, bkW, 0, g.timeLen);
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = '#3d3d4a';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (g.vertical) {
            const x = Math.round(keyPos.x) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
          } else {
            const y = Math.round(H - keyPos.x) + 0.5;
            ctx.moveTo(0, y);
            ctx.lineTo(g.W, y);
          }
          ctx.stroke();
          // ★音名ラベルはロールではなく鍵盤(drawPiano)に書く。以前は縦向きだけロールの
          //   上端に書いていたが、横向きは鍵に書いており置き場が食い違っていた(ユーザー指摘)。
        }
      }

      this._drawRollTimeGrid(ctx, g, pos);

      if (!this._rollTimeline || !this._rollTimeline.length) return;
      const frameDur = this._rollTimeline.frameDur || (1 / 60);

      // track.notesはstartSec昇順(buildNoteTimelineFromChannelFrames参照)なので、
      // 「もう鍵盤側へ流れ去った(endSec<=pos)」ノートを読み飛ばす起点を
      // trackごとにキャッシュし、次フレームはそこから再開する(巻き戻り時は上でリセット済み)。
      // 曲が長い/ノート数が多いほど毎フレーム全ノート走査のコストが線形に効いてくるため、
      // 未再生ノートだけを毎フレーム定数時間で拾えるようにする最適化(文字数の多いMMLで
      // ピアノロールがカクつく問題の対策)
      // スポットライト(案D): 注目chがあるときは他chを減光し、注目chは最後=最前面に描く
      // (ノートは不透明塗りなので、描画順が後のchが必ず勝つ。並べ替えないと注目chが
      // 他chに上書きされて「注目しているのに見えない」ことがある)。
      const spotId = this._effectiveSpotlightId();
      const spotActive = !!spotId && this._rollTimeline.some(t => t.id === spotId);
      const liveColor = {};
      for (const c of (this._lastChannels || [])) if (c && c.id) liveColor[c.id] = c.color;
      const byCopy = (list) => list.filter(t => !t.laneCopy).concat(list.filter(t => t.laneCopy));
      const drawOrder = byCopy(spotActive
        ? this._rollTimeline.filter(t => t.id !== spotId).concat(this._rollTimeline.filter(t => t.id === spotId))
        : this._rollTimeline);

      for (const track of drawOrder) {
        if (!this._inLane(onlyId, track.id)) continue; // レーン表示: この区画の行のノートだけ
        // ミュート中のchは「消す」のではなくスポットライトと同じ減光で描く。
        // 消してしまうと、そのchが元々何も鳴っていないのか消しているのか区別できない
        const muted = this._isTrackMuted(track.id);
        const dimAlpha = (muted || (spotActive && track.id !== spotId)) ? SPOTLIGHT_DIM_ALPHA : 1;
        const notes = track.notes;
        let idx = this._rollCursor[track.id] || 0;
        if (idx > notes.length) idx = notes.length;
        while (idx < notes.length && notes[idx].endSec <= pos) idx++;
        this._rollCursor[track.id] = idx;
        for (let i = idx; i < notes.length; i++) {
          const note = notes[i];
          if (note.startSec >= winEnd) break; // 以降は全て未来のノート(startSec昇順のため打ち切れる)
          // 音量による濃淡はやめ、常にチャンネル本来の色をそのまま(不透明・フィルタ無し)で描く。
          const noteColor = this._getColor(track.id, liveColor[track.id] || track.color);
          const isDrum = note.drumLane !== undefined;
          let pLo, pSize;
          if (isDrum) {
            // ドラム区画の打点。レーン=どのサンプルか、レーン内の分割=同時発音の横並び
            if (note.drumLane >= nDrum) continue; // レーン表より後に来たタイムライン(再構築待ち)
            const d = drumLaneX(note.drumLane, note.drumSub, note.drumSubN, g.drumLaneW);
            const x0 = d.x - offPx;
            if (x0 + d.size < 0 || x0 > g.pitchLen) continue;
            pLo = x0 + 1;
            pSize = Math.max(2, d.size - 2);
          } else {
            const keyPos = keyX(note.midi, wkW);
            if (!keyPos) continue;
            keyPos.x += pitchOff;
            if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue; // 音程窓の外
            // 音程軸: 白鍵は境界線1px内側、黒鍵はレーン幅いっぱい
            pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
            pSize = keyPos.isBlack ? bkW : (wkW - 1);
          }
          const relEnd = Math.min(windowSec, note.endSec - pos);
          const relStart = Math.max(0, note.startSec - pos);
          // 時間軸: 最低2pxは見えるようにする
          const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
          ctx.globalAlpha = dimAlpha;
          if (isDrum) {
            // 塗り=サンプル(どの太鼓か) / 枠線=チャンネル(どのスロットが鳴らしたか)の二重符号化。
            // プール式チップでは同じ太鼓が毎回別スロットへ移るので、色をchに割り当てると
            // 太鼓の色が踊る。塗りをサンプル側に固定するとその問題が出ない。
            const laneInfo = this._drumLanes[note.drumLane];
            ctx.fillStyle = (laneInfo && laneInfo.color) || DRUM_OTHER_COLOR;
            ctx.fillRect(r.x, r.y, r.w, r.h);
            if (r.w > 3 && r.h > 3) {
              ctx.strokeStyle = noteColor;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
            }
            ctx.globalAlpha = 1;
            continue; // ドラムの打点にセント偏差オーバーレイは無い(音程を持たないため)
          }
          if (track.laneCopy) {
            // 複製パート(デチューン二重化/エコー。src/convert/poolDoubles.js)は元トラックと同じ区画へ
            // 点線の枠だけで重ねる(元の音符と見分けが付き、かつ元を隠さない)
            ctx.strokeStyle = noteColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = noteColor;
            ctx.fillRect(r.x, r.y, r.w, r.h);
          }

          // セント偏差オーバーレイ(DESIGN-PITCH.md Phase 0): freqSeq(ノート区間内フレーム毎の
          // 生周波数)を丸め後noteの理論周波数と比較し、音程軸方向のズレとして細線描画する。
          // 「±100セント=±1鍵盤幅」を音程軸オフセット(wkW基準)として表現する。
          if (this._showCentsOverlay && note.freqSeq && note.freqSeq.length) {
            const idealFreq = midiToFreq(note.midi);
            const centerP = pLo + pSize / 2;
            ctx.beginPath();
            let started = false;
            for (let k = 0; k < note.freqSeq.length; k++) {
              const freq = note.freqSeq[k];
              if (!freq || freq <= 0) continue;
              const tAbs = note.startSec + k * frameDur;
              if (tAbs < pos || tAbs > winEnd) continue;
              const cents = 1200 * Math.log2(freq / idealFreq);
              const pt = g.point(centerP + (cents / 100) * wkW, g.tPx(tAbs - pos));
              if (!started) { ctx.moveTo(pt.x, pt.y); started = true; } else { ctx.lineTo(pt.x, pt.y); }
            }
            if (started) {
              ctx.strokeStyle = overlayLineColor(noteColor);
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
          ctx.globalAlpha = 1;
        }
      }

      // *2MML変換の音程検証で見つかった不一致箇所(setConversionDiffs)を赤枠で重ね描きする。
      // 塗り(gotMidi=実際に鳴る高さ)と枠(expectedMidi=元の高さ)の両方を示す。
      // 時間軸はソースの秒(ロールと同じ)なのでそのまま描ける。
      if (this._conversionDiffs && onlyId === null) {
        for (const d of this._conversionDiffs) {
          if (d.endSec <= pos || d.sec >= winEnd) continue;
          const relStart = Math.max(0, d.sec - pos);
          const relEnd = Math.min(windowSec, d.endSec - pos);
          for (const [midi, fill] of [[d.gotMidi, true], [d.expectedMidi, false]]) {
            const keyPos = keyX(midi, wkW);
            if (!keyPos) continue;
            keyPos.x += pitchOff;
            if (keyPos.x + wkW < 0 || keyPos.x - wkW > g.pitchLen) continue;
            const pLo = keyPos.isBlack ? keyPos.x - bkW / 2 : keyPos.x + 0.5;
            const pSize = keyPos.isBlack ? bkW : (wkW - 1);
            const r = g.rect(pLo, pSize, g.tPx(relStart), g.tPx(relEnd), 2);
            if (fill) {
              ctx.fillStyle = 'rgba(255,40,40,0.35)';
              ctx.fillRect(r.x, r.y, r.w, r.h);
            }
            ctx.strokeStyle = '#ff2828';
            ctx.lineWidth = fill ? 2 : 1;
            if (!fill) ctx.setLineDash([3, 3]);
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
            ctx.setLineDash([]);
          }
        }
      }
    }

    // ── SPC ボイス行 DOM構築 ─────────────────────────────────────
    // mute,ch,L,R,vol,env,wave,PM,note,freq,echo,echoL,echoR,C0-C7 の列を持つ。
    // echoL/echoR/C0-C7 はチャンネル単位のレジスタが存在しないため常に空欄
    // （ALL行のみそこにマスター値を表示する）。
    _buildSpcRow(v, idx) {
      const row = document.createElement('div');
      const rowColor = this._getColor(v.label, v.color);
      const plan = channelPlan();
      // SPCのボイスは元々パート文字を持たない(getPartLetterが空を返す)。既定の借用先は
      // main.jsが setDefaults() で与える(V0→A、V1→B、V2→C、V3→D、V4-7→スキップ)。
      const defaultTarget = plan ? plan.defaultTarget(v.label, 'skip') : 'skip';
      const ent = plan ? (plan.get(v.label) || {}) : {};
      const target = ent.target || defaultTarget;
      const letter = plan ? plan.letterOfTarget(target) : '';
      row.className = 'kbd-ch-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:${rowColor}"></span>` +
        partChipHtml({ id: v.label, letter, target }) +
        `<input type="checkbox" class="kbd-mute" checked title="${T('{ch} ミュート', { ch: v.label })}">` +
        `<span class="kbd-name">${v.label}</span>` +
        assignCellHtml({ id: v.label }) +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbd-vol-num">0</span>` +
        `<span class="kbd-vol-wrap">` +
          `<span class="kbd-vol-bar" style="background:transparent"></span>` +
          `<input type="range" class="kbd-vol-slider" min="0" max="200" step="1" value="${Math.round((this._spcVoiceVolumes[idx] ?? 1) * 100)}" title="${T('{ch} 音量(中央100%・ダブルクリックで100%)', { ch: v.label })}">` +
          `<span class="kbd-vol-tooltip"></span>` +
        `</span>` +
        `<span class="kbds-env"><canvas class="kbds-env-canvas" width="34" height="16"></canvas><span class="kbds-env-text"></span></span>` +
        `<canvas class="kbd-wave" width="68" height="28"></canvas>` +
        `<span class="kbds-pm">-</span>` +
        `<span class="kbd-note">—</span>` +
        `<span class="kbds-freq"></span>` +
        `<span class="kbds-echo">-</span>`;

      const checkbox = row.querySelector('.kbd-mute');
      checkbox.addEventListener('change', () => {
        if (this.onSpcMuteChange) this.onSpcMuteChange(idx, !checkbox.checked);
        this._renderMuteAllBtn(); // 見出しの一括ミュートボタンの状態を追随させる
        this._notifyPreview();
      });
      this._attachSpcVolumeSlider(row, idx);

      // 波形アイコンをクリックで大波形表示に選択（NSF側と同じ挙動）
      const waveCanvas = row.querySelector('.kbd-wave');
      const chId = v.label;
      waveCanvas.classList.add('kbd-wave--clickable');
      if (chId === this._shownWaveId) waveCanvas.classList.add('kbd-wave--selected');
      waveCanvas.addEventListener('click', () => {
        this._selectWave(chId);
        this._setSpotlightHover(chId); // NSF側と同じく、選んだ直後にロールもピックアップ
      });

      // 丸のクリックで色ピッカーを開く
      this._attachColorPicker(row.querySelector('.kbd-dot'), v.label, v.color);
      // チャンネル割当(part列チップ + 割当表示ONのときのセレクト)
      this._wireAssign(row, { id: v.label, target: target });
      // スポットライト(案D): メイン一覧と同じ操作をSPCボイス行にも付ける
      this._attachSpotlight(row, v.label);

      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        id: v.label,
        row,
        partEl: row.querySelector('.kbd-part'),
        targetSel: row.querySelector('.kbd-assign-target'),
        toneSel: row.querySelector('.kbd-assign-tone'),
        // ★「パッド」ボタン(_syncAssignSelects が target===dpcm のとき表示する)。NSF側の行(_rowEls)には
        //   あったがSPCボイス行では参照を持っておらず、Eを選んでもボタンが出なかった(2026-09-07修正)
        drumBtn: row.querySelector('.kbd-assign-drum'),
        tonesBtn: row.querySelector('.kbd-assign-tones'),
        plainEl: row.querySelector('.kbd-assign-plain'),
        defaultTarget,
        target,
        letter,
        volBar: row.querySelector('.kbd-vol-bar'),
        volNum: row.querySelector('.kbd-vol-num'),
        lEl: lrEls[0], rEl: lrEls[1],
        envCanvas: row.querySelector('.kbds-env-canvas'),
        envText: row.querySelector('.kbds-env-text'),
        waveCanvas,
        waveSig: '',
        waveOn: false,
        pmEl: row.querySelector('.kbds-pm'),
        noteEl: row.querySelector('.kbd-note'),
        freqEl: row.querySelector('.kbds-freq'),
        echoEl: row.querySelector('.kbds-echo'),
        checkbox,
        color: rowColor,
        defaultColor: v.color,
      };
    }

    // ALL行: L・R にマスター音量($0C/$1C)。それより右(vol以降)はボイス単位の値が無いので、
    // 1つのセル(.kbds-master)にエコー音量L/R($2C/$3C)とFIRフィルタ係数C0-C7をまとめて表示する
    // (以前は echoL/echoR/C0-C7 を独立した列にしていたが、ALL行以外は常に空欄で幅ばかり
    // 食っていたため、一覧幅を他フォーマット並みに収める目的で1セルにした)。
    _buildSpcAllRow() {
      const row = document.createElement('div');
      row.className = 'kbd-ch-row kbds-all-row';
      row.innerHTML =
        `<span class="kbd-dot" style="background:#888"></span>` +
        `<span class="kbd-part"></span>` +
        `<span class="kbd-mute-ph"></span>` +
        `<span class="kbd-name">ALL</span>` +
        `<span class="kbd-assign"></span>` +
        `<span class="kbds-lr kbds-l"></span>` +
        `<span class="kbds-lr"></span>` +
        `<span class="kbds-master" title="echo L/R = ${'$'}2C/${'$'}3C, FIR = C0..C7"></span>`;
      const lrEls = row.querySelectorAll('.kbds-lr');
      return {
        row,
        lEl: lrEls[0], rEl: lrEls[1],
        masterEl: row.querySelector('.kbds-master'),
      };
    }

    // ── SPC ボイス同期 ────────────────────────────────────────────
    // voices: [{label:'V0', freq:Hz, vol:0-1, rawVol:0-0x7FF, active:bool, muted:bool,
    //   color:'hsl(...)', wave:{t:'wave',data,layers,nx,ny}|null, env:{mode,...},
    //   volL, volR, pmOn, noiseOn, echoOn}] × 8
    // master: { volL, volR, echoL, echoR, fir:[C0..C7] } — ALL行用のマスター値。
    // posSeconds: 現在の再生位置(秒)。ピアノロールの先読み描画位置に使う。
    updateSpcVoices(voices, master, posSeconds) {
      this._spcVoices = voices || [];
      this._prevSpcVoices = this._spcVoices.map(v => ({
        id: v.label, color: v.color, freq: v.freq, vol: v.vol, active: v.active, wave: v.wave,
      }));
      const anyActive = this._spcVoices.some(v => v.active);

      // ALL行は初回のみ構築（内容は毎回更新）。見出しは理屈上はALL行含む全体に
      // かかるべきだが、見た目はALL行をヘッダ扱いにしたいのでALLとV0の間に置く。
      if (!this._spcAllRow) {
        this._spcSectionEl.innerHTML = '';
        this._spcAllRow = this._buildSpcAllRow();
        this._spcSectionEl.appendChild(this._spcAllRow.row);
        const chipHeader = document.createElement('div');
        chipHeader.className = 'kbd-chip-header';
        chipHeader.textContent = 'SPC700 (Super Famicom / Super Nintendo Entertainment System)';
        this._spcSectionEl.appendChild(chipHeader);
      }

      // 行数が変化した場合だけ per-voice 行を再構築（通常は初回の8行のみ。ALL行は保持）
      const spcRowsChanged = this._spcRowEls.length !== this._spcVoices.length;
      if (spcRowsChanged) {
        for (const el of this._spcRowEls) el.row.remove();
        this._spcRowEls = this._spcVoices.map((v, idx) => {
          const el = this._buildSpcRow(v, idx);
          this._spcSectionEl.appendChild(el.row);
          return el;
        });
        this._refreshAssignUi(); // part列の文字・スキップ減光・重複警告を新しい行へ反映
        this._renderMuteAllBtn();
        this._applySpotlightClasses(); // 固定中のスポットライトの目印を新しい行へ復元
      }
      // 大波形に表示するボイスを新しい一覧に合わせる(選択がSPCボイス以外ならV0を一時表示)。
      // ★SPCのボイス数は常に8で固定のため、reset()でファイルを読み込み直しても行の再構築
      // (spcRowsChanged)自体は2回目以降起きない。ファイル読み込み直し直後の選択判定
      // (_consumePendingSelectionReset)は行の再構築有無に関わらずここで必ず試みる必要がある
      if (this._mode === 'spc' && this._spcVoices.length) {
        const hadPending = this._pendingSelectionReset;
        this._consumePendingSelectionReset(this._spcRowEls.filter(el => el.waveCanvas).map(el => el.id));
        if (spcRowsChanged || hadPending) {
          this._syncShownWave(this._spcRowEls);
          this._rebuildLanes(); // チャンネルごとのレーン表示もボイス一覧に合わせる
        }
      }

      // ALL行データ更新（マスター音量・エコー音量・FIRフィルタ、各 -128〜127）
      if (master && this._spcAllRow) {
        const a = this._spcAllRow;
        a.lEl.textContent = String(master.volL);
        a.rEl.textContent = String(master.volR);
        const fir = (master.fir || []).map(v => String(v)).join(' ');
        const txt = `echo ${master.echoL}/${master.echoR}  FIR ${fir}`;
        if (a.masterEl.textContent !== txt) a.masterEl.textContent = txt;
      }

      // 各ボイス行データ更新
      for (let i = 0; i < this._spcVoices.length && i < this._spcRowEls.length; i++) {
        const v  = this._spcVoices[i];
        const el = this._spcRowEls[i];
        const muted = v.muted !== undefined ? v.muted : !el.checkbox.checked;
        el.checkbox.checked = !muted; // ボイスモニター側のMUTEボタンとも同期

        // L/R: ステレオパンレジスタ（-128〜127、発声状態に関わらず常時表示）
        el.lEl.textContent = v.volL !== undefined ? String(v.volL) : '';
        el.rEl.textContent = v.volR !== undefined ? String(v.volR) : '';

        const showVol = v.active && !muted;
        const pct = showVol ? Math.round(v.vol * 100) : 0;
        el.volBar.style.width      = pct + '%';
        el.volBar.style.background = pct > 0 ? el.color : 'transparent';
        el.volNum.textContent = (showVol && v.rawVol !== null && v.rawVol !== undefined)
          ? String(v.rawVol) : '';
        el.volNum.style.color = showVol ? '#e6e6ef' : '#555566';

        // env列: ADSRモードは簡易グラフアイコン、GAINモードはモード名+数値のテキスト
        if (v.env && v.env.mode === 'adsr') {
          el.envCanvas.style.display = '';
          el.envText.style.display = 'none';
          el.envCanvas.title = `ADSR AR=${v.env.ar} DR=${v.env.dr} SL=${v.env.sl} SR=${v.env.sr}`;
          drawEnvIcon(el.envCanvas, v.env, el.color, showVol);
        } else if (v.env) {
          el.envCanvas.style.display = 'none';
          el.envText.style.display = '';
          // 表示は略号のみ（D/LD/E/LA/BA）、正式名はtitle属性のツールチップで示す
          const GAIN_KIND = {
            direct:  { abbr: 'D',  full: 'direct' },
            lindec:  { abbr: 'LD', full: 'linear decay' },
            exp:     { abbr: 'E',  full: 'exponential' },
            linatk:  { abbr: 'LA', full: 'linear attack' },
            bentatk: { abbr: 'BA', full: 'bent attack' },
          }[v.env.kind] || { abbr: v.env.kind, full: v.env.kind };
          el.envText.textContent = `${GAIN_KIND.abbr} ${v.env.value}`;
          el.envText.title = `${GAIN_KIND.full} ${v.env.value}`;
          el.envText.style.color = showVol ? '#cfcfe0' : '#555566';
        }

        // 素波形アイコン: 発声中のみ更新（NSF側と同じく発声→停止の遷移時のみ暗色で描き直す）
        const waveOn = v.active && !muted;
        if (waveOn || el.waveOn !== waveOn) {
          const wsig = waveSig(v.wave, waveOn);
          if (wsig !== el.waveSig) {
            el.waveSig = wsig;
            drawWaveIcon(el.waveCanvas, v.wave, el.color, waveOn);
          }
          el.waveOn = waveOn;
        }

        // PM列: $2Dのビットでon/off
        el.pmEl.textContent = v.pmOn ? 'on' : '-';
        el.pmEl.style.color = v.pmOn ? el.color : '#555566';

        // echo列: $4Dのビットが立っていれば $7D(EDL)下位4bitから求めたエコーディレイ時間を表示
        el.echoEl.textContent = v.echoOn ? `${v.echoDelayMs}ms` : '-';
        el.echoEl.style.color = v.echoOn ? '#e6e6ef' : '#555566';

        if (!showVol) {
          el.noteEl.textContent = muted ? '(M)' : '—';
          el.noteEl.style.color = '#555566';
          el.freqEl.textContent = '';
        } else {
          const midi = freqToMidi(v.freq);
          if (midi !== null) {
            el.noteEl.textContent = midiToName(midi);
            el.freqEl.textContent = v.freq.toFixed(1) + ' Hz';
          } else {
            const any = freqToMidiAny(v.freq);
            el.noteEl.textContent = any !== null ? midiToName(any) : (v.freq > 0 ? '??' : '—');
            if (any !== null) el.noteEl.style.color = '#9a9ab0';
            el.freqEl.textContent = v.freq > 0 ? v.freq.toFixed(1) + ' Hz' : '';
          }
          // $3Dでノイズ発声中のchはnote列を黄色で強調
          el.noteEl.style.color = v.noiseOn ? '#ffcc44' : '#e6e6ef';
        }
      }

      // 選択チャンネルの大波形を更新
      if (this._shownWaveId) {
        const sel = this._prevSpcVoices.find(c => c.id === this._shownWaveId);
        if (sel) this._renderBigWave(sel);
      }

      // ピアノを即時再描画（SPC のみ再生中も更新）
      if (anyActive) {
        const snap = this._state && this._state.regSnapshots
          ? (this._state.regSnapshots[0] || {}) : {};
        const nesChannels = (this._state
          ? extractChannels(snap, this._extraSnaps, 0, this._chips)
          : []).map(c => ({ ...c, color: this._getColor(c.id, c.color) }));
        const allChannels = nesChannels.concat(this._spcVoices.map(v => ({
          id: v.label, color: this._getColor(v.label, v.color), freq: v.freq, vol: v.vol,
          active: v.active, rawVol: null, rawVolMax: null,
        })));
        this._drawPianos(allChannels);
      }

      if (this._mode === 'spc') this._renderRoll(posSeconds || 0);
    }

    // SPCはNSF/MML/KSSと違いupdate()(=rAFのmonitorLoopから毎フレーム呼ばれる)を経由せず、
    // updateSpcVoices()が専用の80ms setInterval(ボイス詳細UIの更新にはこれで十分)からしか
    // 呼ばれない設計のため、ロールの再描画までそれに引きずられて12.5fps相当になり、
    // NSF/KSS(rAF=約60fps)と比べて明らかにカクカクして見えていた(2026-07-18、ユーザー報告)。
    // ボイス詳細表示は変えずに、ロールの再描画だけ切り離してrAF頻度で呼べるようにする軽量メソッド。
    updateRollPosition(posSeconds) {
      this._renderRoll(posSeconds);
    }

  }

  // regSnapshots形式からピアノロールのトラック配列を構築する(KeyboardDisplayの
  // 同名メソッドの実体。this非依存の純粋関数なので、キャプチャWorkerバンドル
  // (NSF/VGMのロール構築オフスレッド化)からも直接呼べるようモジュールレベルに置く。
  // 詳細コメントはKeyboardDisplay.setRollTimelineFromRegSnapshots参照)。
  // DPCMの発声タイムライン(writeLogから)。フレームごとに
  //   seq[f] … キーオン通番の累計($4015 bit4書込みを1トリガーと数える。nsf2mml extractDmcTriggers と同じ)
  //   end[f] … いま鳴っているサンプルが鳴り終わるフレーム(ループなら Infinity、鳴っていなければ 0)
  // を返す。★$4015 のbit4は「最後に書かれた値」なので、それだけを見るとサンプルが鳴り終わっても
  // 次のトリガー/停止書込みまで発声中に見える(ロールの棒が実発声より長く伸びていた)。
  // 実機DMCは $4013 の長さ(len*16+1 バイト×8bit)を $4010 のレート(CPUクロック÷周期)で
  // 読み切ったら止まる(bit6のループ時は再開)ので、それを計算して発声の終わりにする。
  // 再生中の再トリガー(bytesRemaining>0 のときの bit4 書込み)は実機では無視されるので、
  // 終了時刻の更新も「鳴り終わってからのトリガー」だけにする(通番は従来どおり全部数える)。
  function buildDmcTimeline(wl, totalFrames, frameDur) {
    const seq = new Int32Array(totalFrames);
    const end = new Float64Array(totalFrames);
    let n = 0, curEnd = 0;
    let rateIdx = 0, loop = false, lenReg = 0;
    for (let f = 0; f < totalFrames; f++) {
      for (const w of (wl[f] || [])) {
        if (w.addr === 0x4010) { rateIdx = w.value & 0x0F; loop = !!(w.value & 0x40); }
        else if (w.addr === 0x4013) lenReg = w.value & 0xFF;
        else if (w.addr === 0x4015) {
          if (w.value & 0x10) {
            n++;
            if (f >= curEnd) {
              const bytes = lenReg * 16 + 1;
              const rateHz = CPU_CLOCK / DMC_RATE[rateIdx];
              curEnd = loop ? Infinity : f + (bytes * 8 / rateHz) / frameDur;
            }
          } else {
            curEnd = 0; // bit4クリア=停止
          }
        }
      }
      seq[f] = n;
      end[f] = curEnd;
    }
    return { seq, end };
  }

  function buildRollTracksFromRegSnapshotsPure(regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots, extra) {
    if (!regSnapshots || totalFrames <= 0) return null;
    const wl = writeLog || [];
    const frameDur = samplesPerFrame / sampleRate;
    const dmcTl = buildDmcTimeline(wl, totalFrames, frameDur);
    const extraSnaps = Object.assign({}, extra || {}, {
      dmcSeq: dmcTl.seq, dmcEnd: dmcTl.end,
      vrc7: chips.includes('vrc7') ? buildVrc7Snapshots(wl) : null,
      n163: chips.includes('n163')
        ? (n163Snapshots && n163Snapshots.length ? buildN163SnapshotsFromLiveRam(n163Snapshots) : buildN163Snapshots(wl))
        : null,
      fme7: chips.includes('fme7') ? buildFme7Snapshots(wl) : null,
    });
    // extra.tuningCents(#TUNING、verify.js): 構築の間だけ音名の丸め基準をずらす(呼び出し元は
    // 変換中のメインスレッドで、鍵盤が別ファイルを表示中かもしれないので必ず元へ戻す)
    const prevTuning = rollTuningCents;
    if (extra && extra.tuningCents != null) rollTuningCents = +extra.tuningCents || 0;
    try {
      return buildNoteTimelineFromChannelFrames(
        (f) => extractChannels(regSnapshots[f] || {}, extraSnaps, f, chips),
        totalFrames, frameDur
      );
    } finally { rollTuningCents = prevTuning; }
  }

  UI.KeyboardDisplay = KeyboardDisplay;
  UI.buildRollTracksFromRegSnapshots = buildRollTracksFromRegSnapshotsPure; // roll-builders.js(Worker)用
  UI.midiToNoteName = midiToName; // main.js(ADPCM手動キャリブレーションのプロンプト表示)用
})(globalThis);

/*
 * 音色の同定キー — MML.Convert.ToneKey (2026-09-09、音色別指定「音色一覧」の土台)
 *
 * 「変換元チャンネルの中で使われている音色(楽器)1つ」を、形式に依らない文字列キーで同定する。
 * 設定(src/convert/toneSettings.js)はこのキーで持つので、同じ音色が別チャンネルに出ても・
 * 同じゲームの別トラックでも同じ設定が効く(DPCMパッドの「サンプル内容ハッシュ」と同じ考え方。
 * src/convert/drumSamples.js 冒頭参照)。
 *
 * キーの形(先頭の種別で見分ける):
 *   'brr:<hash>'    SPCのBRRサンプル(MML.SPC2MML.brrHash と同じ値)
 *   'pcm:<hash>'    VGMのサンプルPCM(Emu.SamplePitchUtil.sampleHash)
 *   'opn:<hash>'    OPN/OPM系4op FM音色(キャリアのTLは音量なので除いて同定)
 *   'opll:<n>'      OPLL/VRC7の内蔵音色 @1-@15
 *   'opllc:<hash>'  OPLL/VRC7 自作音色(レジスタ$00-$07の8バイト)。OPL(2op)の音色はOPLL形式へ
 *                   変換済みのバイト列で同定する(抽出器 kss2mml/expansion/opl.js が変換する)
 *   'wave:<hash>'   波形メモリ(SCC/GB波形/HuC6280/N163/FDS)。32点・0..15へ正規化してから同定
 *   'duty:<n>'      デューティ矩形波(2A03/MMC5/GB=0-3、VRC6=0-7)
 *   'sq:<chip>'     デューティ固定の矩形波(AY/SN76489)。チップに1音色
 *   'tri' / 'saw' / 'noise' / 'sample'  音色の区別を持たない行
 *
 * ★同じ音色を「抽出器のイベント」(ofEvent)と「鍵盤/ロールのライブ状態」(ofLive)の両方から
 *   同じキーに落とせることが要件。ロールのノートに載せたキーで音色一覧を組み、変換側は
 *   イベントから引いた同じキーで設定を適用する。片方だけ変えるとキーが食い違って設定が効かなくなる。
 *
 * Worker(ロール構築 src/audio/roll-builders.js)でも動かすのでDOM/localStorageは触らない。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.Convert = MML.Convert || {};

  const WAVE_LEN = 32;

  // FNV-1a 32bit(整数列)。sampleHash と同じ系のハッシュだが入力が整数配列なので別実装
  function fnv(values, seed) {
    let h = seed === undefined ? 0x811c9dc5 : seed;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] | 0;
      h ^= v & 0xff; h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  /** 任意長・任意値域の1周期波形 → 32点・0..15 の正規化波形(同定と表示に使う) */
  function normalizeWave(data) {
    if (!data || !data.length) return null;
    const n = data.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = +data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new Array(WAVE_LEN);
    if (!(hi > lo)) { out.fill(8); return out; }
    for (let i = 0; i < WAVE_LEN; i++) {
      const v = +data[Math.floor(i * n / WAVE_LEN)];
      out[i] = Math.max(0, Math.min(15, Math.round((v - lo) / (hi - lo) * 15)));
    }
    return out;
  }
  function waveKey(data) {
    const w = normalizeWave(data);
    return w ? 'wave:' + fnv(w) : null;
  }

  // ── OPN/OPM 4op ───────────────────────────────────────────────────
  // 各アルゴリズムのキャリア(出力に直結するop、論理op番号0-3)。キャリアのTLは音量なので同定から外す
  const OPN_CARRIERS = [[3], [3], [3], [3], [1, 3], [1, 2, 3], [1, 2, 3], [0, 1, 2, 3]];
  const OP_FIELDS = ['DT', 'ML', 'TL', 'KS', 'AR', 'DR', 'SR', 'SL', 'RR', 'AM', 'SE', 'DT2'];
  function opnKey(p) {
    if (!p || !p.ops || !p.ops.length) return null;
    const alg = (p.AL || 0) & 7;
    const carriers = OPN_CARRIERS[alg];
    const vals = [alg, (p.FB || 0) & 7];
    for (let i = 0; i < p.ops.length; i++) {
      const o = p.ops[i] || {};
      for (const f of OP_FIELDS) {
        let v = o[f];
        if (v === undefined) v = 0;
        if (f === 'TL' && carriers.indexOf(i) >= 0) v = 0;
        vals.push(v);
      }
    }
    return 'opn:' + fnv(vals);
  }

  // ── OPLL/VRC7 ─────────────────────────────────────────────────────
  // {mod, car} 形式の音色 → レジスタ$00-$07の8バイト(src/ui/keyboard.js opllPatchBytes と同じ並び)
  function opllBytesOf(p) {
    const m = p && p.mod, c = p && p.car;
    if (!m || !c) return null;
    return [
      ((m.AM & 1) << 7) | ((m.PM & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.PM & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (m.FB & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15),
    ];
  }
  function opllCustomKey(bytes) {
    if (!bytes || bytes.length < 8) return null;
    return 'opllc:' + fnv(Array.from(bytes).slice(0, 8));
  }
  function opllKey(inst, bytes) {
    const n = inst | 0;
    if (n > 0 && n <= 15) return 'opll:' + n;
    return opllCustomKey(bytes);
  }

  // ── 抽出器イベント → キー ─────────────────────────────────────────
  // ctx: { chip, kind, brrSamples? }(borrow.js の source s をそのまま渡せる)
  // 抽出器がイベントに載せる同定情報:
  //   ev.srcn(SPC) / ev.sampleHash(VGM PCM) / ev.opnPatch(OPN系) / ev.srcTone(OPLL/OPL 8バイト) /
  //   ev.instrument(OPLLの内蔵音色番号・GB/2A03デューティ) / ev.srcWave(波形メモリの生波形)
  function ofEvent(ev, ctx) {
    if (!ev || ev.note === null) return null;
    const chip = ctx && ctx.chip;
    if (ev.srcn !== undefined && ctx && ctx.brrSamples) {
      const h = MML.SPC2MML && MML.SPC2MML.brrHash ? MML.SPC2MML.brrHash(ctx.brrSamples[ev.srcn]) : null;
      return h ? 'brr:' + h : 'brr:srcn' + ev.srcn;
    }
    if (ev.sampleHash) return 'pcm:' + ev.sampleHash;
    if (ev.opnPatch) return opnKey(ev.opnPatch);
    if (chip === 'ym2413' || chip === 'opl' || chip === 'vrc7') {
      if (ev.srcTone) return opllCustomKey(ev.srcTone);
      if (ev.instrument > 0) return 'opll:' + (ev.instrument & 15);
      return null;
    }
    if (ev.srcWave) return waveKey(ev.srcWave);
    if (chip === 'ay8910' || chip === 'sn76489') return 'sq:' + chip;
    if (chip === 'gb' && ctx.kind === 'square') return ev.instrument !== undefined ? 'duty:' + (ev.instrument & 3) : 'duty:2';
    return null;
  }

  // ── 鍵盤/ロールのライブ状態(extractChannels の1行) → キー ─────────────────
  // 同定に使うのは: ch.fmPatch(OPN/OPM/OPLL) / ch.sampleHash(サンプルPCM) / ch.wave(波形) / ch.duty
  const patchKeyCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ofLive(ch) {
    if (!ch) return null;
    if (ch.srcn !== undefined && ch.brrHash) return 'brr:' + ch.brrHash;
    if (ch.sampleHash) return 'pcm:' + ch.sampleHash;
    const p = ch.fmPatch;
    if (p) {
      if (patchKeyCache && typeof p === 'object') {
        const c = patchKeyCache.get(p);
        if (c !== undefined) return c;
      }
      let k = null;
      if (p.type === 'opll') k = opllKey(p.inst, opllBytesOf(p));
      else if (p.ops) k = opnKey(p);
      if (patchKeyCache && typeof p === 'object') patchKeyCache.set(p, k);
      return k;
    }
    const w = ch.wave;
    if (ch.noise) return 'noise';
    if (!w) return null;
    if (w.t === 'wave' && w.data && w.data.length) return waveKey(w.data);
    if (w.t === 'pulse') {
      if (ch.duty !== undefined && ch.duty !== null) return 'duty:' + ch.duty;
      if (/^(KP|SN)\d/.test(ch.id || '')) return 'sq:' + (/^SN/.test(ch.id) ? 'sn76489' : 'ay8910');
      return null;
    }
    if (w.t === 'tri') return 'tri';
    if (w.t === 'saw') return 'saw';
    if (w.t === 'sample') return 'sample';
    return null;
  }

  // ── 表示・試聴用の付随情報(キーだけでは音が作れないので、初出時に一緒に控える) ────
  //   { kind:'brr'|'pcm'|'opn'|'opll'|'wave'|'duty'|'sq'|'other', label, wave?(32点0..15), patch?, bytes?, inst?, duty? }
  function infoOfLive(ch, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    const p = ch.fmPatch;
    if (info.kind === 'opll' && p) {
      info.inst = p.inst | 0;
      info.bytes = opllBytesOf(p);
      info.label = info.inst > 0 ? '@' + info.inst : 'OP';
    } else if (info.kind === 'opn' && p) {
      info.patch = p;
      info.label = 'FM' + (p.AL !== undefined ? ' AL' + p.AL : '');
    } else if (info.kind === 'wave' && ch.wave && ch.wave.data) {
      info.wave = normalizeWave(ch.wave.data);
      info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ch.duty | 0;
      info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'pcm') {
      info.sample = ch.adpcmSample || null;
      info.label = 'PCM';
    }
    return info;
  }
  function infoOfEvent(ev, ctx, key) {
    if (!key) return null;
    const kind = key.split(':')[0];
    const info = { kind: kind === 'opllc' ? 'opll' : kind, label: '' };
    if (info.kind === 'opll') {
      if (ev.srcTone) { info.bytes = Array.from(ev.srcTone).slice(0, 8); info.inst = 0; info.label = 'OP'; }
      else { info.inst = ev.instrument | 0; info.label = '@' + info.inst; }
    } else if (info.kind === 'opn') {
      info.patch = ev.opnPatch; info.label = 'FM AL' + (ev.opnPatch.AL | 0);
    } else if (info.kind === 'wave') {
      info.wave = normalizeWave(ev.srcWave); info.label = 'wave';
    } else if (info.kind === 'duty') {
      info.duty = ev.instrument | 0; info.label = 'duty ' + info.duty;
    } else if (info.kind === 'sq') {
      info.label = 'square';
    } else if (info.kind === 'brr') {
      info.srcn = ev.srcn; info.label = 'srcn' + ev.srcn;
    } else if (info.kind === 'pcm') {
      info.label = 'PCM';
    }
    return info;
  }

  /** 設定を持てるキーか(音色の区別が無い 'tri'/'saw'/'noise'/'sample' は対象外) */
  function isAssignable(key) {
    return !!key && /^(brr|pcm|opn|opll|opllc|wave|duty|sq):/.test(key);
  }

  MML.Convert.ToneKey = {
    WAVE_LEN, fnv, normalizeWave, waveKey, opnKey, opllBytesOf, opllKey, opllCustomKey,
    ofEvent, ofLive, infoOfLive, infoOfEvent, isAssignable,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * ピアノロール タイムライン構築(全フォーマット共通・純粋関数)
 * MML.RollBuild
 *
 * 元はmain.jsのbuildXxxRollTimeline群(+keyboard.jsのbuildRollTracksFromRegSnapshots)
 * としてメインスレッド専用だったが、キャプチャWorker化に伴い「1回あたりO(曲全体)の
 * タイムライン構築」がメインスレッドの長タスク(実測~90ms=オーディオバッファ級)として
 * 残ったため、構築そのものをキャプチャWorker内で実行できるようここへ分離した
 * (README-worker-build.txt参照)。メインスレッド(Workerフォールバック時)とWorker
 * バンドルの両方から同じコードが使われる。
 *
 * 依存(すべて実行時参照なので読み込み順は問わない。Workerバンドルには
 * tools/build-capture-workers.ps1が対応フォーマットぶんだけ同梱する):
 *   nsf/vgm: MML.UI.buildRollTracksFromRegSnapshots (src/ui/keyboard.js)
 *   kss/vgm: MML.Kss2MmlExpansion.ay/scc/opll (+MML.Convert: convert/pitch.js)
 *   gbs/vgm: MML.Gbs2MmlExpansion.pulse/noise/wave
 *   hes/vgm: MML.Hes2MmlExpansion.wave/noiseChannel/extractDdaClips
 *   spc:     MML.SPC2MML.extractVoiceEvents
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const RollBuild = MML.RollBuild = MML.RollBuild || {};

  // ── 高速アルペジオ(@EN)の展開 ────────────────────────────────────────
  // MML.Convert.mergeRapidArpeggio(src/convert/pitch.js)は、フレーム単位で音程が
  // 周期的に切り替わる高速アルペジオを「基準ノート1音 + ev.noteEnvOffsets(=@EN<n>、
  // フレーム毎の累積半音差分)」へ畳む。MML本文としてはそれが正しい表現だが、
  // ロールはそのイベントをそのまま描くため、基準ノート1本の長い帯になり、毎フレームの
  // 実レジスタ値を出している鍵盤表示と見た目が食い違う
  // (Space Manbow(MSX) 60曲目のSCC ch3=Rで実測。3.2秒以降のアルペジオ全域)。
  // @ENは「前フレームからの半音差分」なので基準ノートから順に足し込めば元の音程列が
  // 完全に復元でき、それは実レジスタ列とも(MMLを再生したときの実発音とも)一致する。
  // deltas省略時は分割せず元の1区間をそのまま返すので、呼び出し側は無条件に通してよい。
  RollBuild.expandNoteEnv = function (start, end, note, deltas) {
    if (!deltas || !deltas.length) return [{ start, end, note }];
    const out = [];
    let cur = note;
    let segStart = start;
    for (let f = start; f < end; f++) {
      const d = deltas[(f - start) % deltas.length];
      if (!d) continue;
      if (f > start) { out.push({ start: segStart, end: f, note: cur }); segStart = f; }
      cur += d;
    }
    out.push({ start: segStart, end, note: cur });
    return out;
  };

  // ── SPC ──────────────────────────────────────────────────────────────
  // drumKinds(省略可): srcn → 'drum' | 'pitch' の手動上書き(main.jsがBRR内容ハッシュで引く)。
  // 打楽器と判定したsrcnの発音は音程ノートではなく drumKey 付きノート(ドラム区画/パッド)に
  // する。判定はMML変換と同じ MML.SPC2MML.drumSrcns(ロール=MML変換デバッガの方針)。
  // 音色キー(src/convert/toneKey.js)をロールのノートに載せ、トラックの tones 表に表示/試聴用の
  // 付随情報を控える(音色一覧パネル src/ui/tonePanel.js の材料。main.js rebuildToneInventory)。
  // ★ノートに載せるのは文字列キーだけ(Workerからの構造化複製で運ぶ量を増やさない)。
  //   付随情報は音色ごとに1回、トラックオブジェクトのプロパティ tones に置く(配列に生やした
  //   プロパティは複製で消えるので、必ずトラック(オブジェクト)側に置く)
  RollBuild.toneOf = function (ev, ctx, tones) {
    const TK = MML.Convert && MML.Convert.ToneKey;
    if (!TK || !ctx) return undefined;
    const k = TK.ofEvent(ev, ctx);
    if (!k) return undefined;
    if (tones && !tones[k]) tones[k] = TK.infoOfEvent(ev, ctx, k);
    return k;
  };

  RollBuild.spc = function (log, frameRate, srcnFineTune, drumKinds) {
    const frameDur = 1 / frameRate;
    // MML変換と同じ原音チューニング補正を渡し、ロール表示の音程も実機発音に一致させる
    // (ロール=MML変換デバッガの方針。補正マップは再生開始時に一度だけ算出して使い回す)。
    const voiceEvents = MML.SPC2MML.extractVoiceEvents(log, { srcnFineTune });
    const drumSrcns = (drumKinds !== false && MML.SPC2MML.drumSrcns)
      ? MML.SPC2MML.drumSrcns(voiceEvents, srcnFineTune, drumKinds || null) : new Set();
    let drumSeq = 0;
    return voiceEvents.map((events, ch) => ({
      id: `V${ch}`,
      color: `hsl(${ch * 45},90%,65%)`,
      notes: events
        .filter(e => e.pitchSemi !== null)
        // 打楽器サンプルの発音: 音程軸ではなくドラム区画へ(midi無し、drumKey='brr:<srcn>')
        .map(e => (!e.non && drumSrcns.has(e.srcn))
          ? { drum: true, startSec: e.frame * frameDur, endSec: (e.frame + e.len) * frameDur, midi: null,
              drumKey: 'brr:' + e.srcn, drumSeq: ++drumSeq, vol: Math.max(0, Math.min(1, (e.vol || 0) / 127)), freqSeq: [] }
          : e)
        // 音量シェーディング用の簡易近似: ADSRモード(adsr1 bit7=1)ならサスティンレベル(adsr2 bit5-7、
        // 0-7)を目安の音量とする。GAINモード(直接指定)は減衰カーブを追わず常に最大音量扱い。
        // pitchSemi は note-number 空間(57=A4=MIDI69)なので MIDI へは +12。
        .reduce((acc, e) => {
          if (e.drum) { acc.push(e); return acc; } // ドラム区画のノートはそのまま
          // freqSeq(セント偏差オーバーレイ用): DSPピッチレジスタ(pitch=0x1000で原音32kHz)を
          // pitchToSemitone(src/spc2mml/converter.js)と同じ式でHzへ変換する。
          const tune = (srcnFineTune && srcnFineTune[e.srcn]) || 0;
          const tuneFactor = Math.pow(2, (tune + 3) / 12);
          const vol = (e.adsr1 & 0x80) ? (((e.adsr2 >> 5) & 7) / 7) : 1;
          const freqSeq = (e.pitchSeq || []).map(p => 440 * (p / 4096) * tuneFactor);
          // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
          // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)
          const steps = RollBuild.expandNoteEnv(e.frame, e.frame + e.len, e.pitchSemi + 12, e.noteEnvOffsets);
          for (let si = 0; si < steps.length; si++) {
            acc.push({
              startSec: steps[si].start * frameDur, endSec: steps[si].end * frameDur, midi: steps[si].note,
              vol, freqSeq: si === 0 ? freqSeq : [],
              // srcn: 借用先にE(DPCM)を選んだボイスをロール上でパッドへ置き換えるのに使う
              // (main.js applySynthDrumToRoll。ノートからBRRサンプルを特定できるのはこれだけ)
              srcn: e.srcn,
            });
          }
          return acc;
        }, []),
    }));
  };

  // ── KSS ──────────────────────────────────────────────────────────────
  // headerがSCCデコーダを持ちうる構成か(16Kバンク+RAMモードはバス側でSCCが殺される)
  RollBuild.kssHasSccDecoder = function (header) {
    return !!header && !(header.bankMode === '16K' && header.device.ramMode);
  };

  // writeLogのフレーム範囲[from,to)にSCC音源レジスタ(周波数/音量/有効ビット)への
  // 書込みがあるか。波形テーブルはクリア目的で0書きされることがあるため判定材料にせず、
  // 実際に発音に効くレジスタだけを見る。classic(SCC)は0x80-0x8F、SCC+(SCC-I)は
  // 0xA0-0xAF側も見る。
  RollBuild.kssWriteLogUsesScc = function (writeLog, from, to) {
    for (let f = from; f < to && f < writeLog.length; f++) {
      // 書込みは1整数へ詰めてある(src/emulator/kssPlayer.js packWrite)
      for (const pw of writeLog[f]) {
        if ((pw >> 24) & 1) continue;
        const addr = pw & 0xFFFF, value = (pw >> 16) & 0xFF;
        const off = (addr >= 0x9800 && addr <= 0x98FF) ? addr - 0x9800
          : (addr >= 0xB800 && addr <= 0xB8FF) ? addr - 0xB800 : -1;
        if (off < 0 || value === 0) continue;
        if ((off >= 0x80 && off <= 0x8F) || (off >= 0xA0 && off <= 0xAF)) return true;
      }
    }
    return false;
  };

  // PSG→KP/SCC→KS/FMPAC→KF は src/ui/keyboard.js の extractChannels() の色分けと揃える。
  // clockOverride(省略可): AY/SCC抽出器に渡すZ80相当クロック。KSSは常にMSXの3.58MHz、
  // VGMはチップごとに違う(vgmPlayer.js captureVgmSongAsync の kss.clock)ので呼び出し側が渡す。
  // oplOpts(省略可): { used, clock, adpcm } — OPL系(KSSのMSX-AUDIO / VGMのYM3812・YM3526・
  // Y8950)のOL行を作る。KSSは header.device.msxAudio から、VGMは data.kss.opl/oplClock から。
  RollBuild.kss = function (writeLog, totalFrames, frameRate, header, sccUsed, clockOverride, oplOpts) {
    const frameDur = 1 / frameRate;
    const clock = clockOverride || (MML.KSS ? MML.KSS.Z80_CLOCK : 3579545);
    // volume は ay/scc/opll いずれも0-15(4bit)なので/15で0-1に正規化する。
    // ★2026-08-22: ただし **OPLLだけ向きが逆**。AY/SCCの音量は「大きいほど大音量」だが、
    // OPLLのレジスタ$30下位4bitは減衰値で0が最大音量・15が無音(3dB/step)。
    // レジスタ生値の向きは変えられない(MML変換が v<n> をそのまま $30 のニブルへ書き戻す
    // 往復経路になっている。src/mml/compiler.js segmentsToWriteLogVrc7 の
    // `(instrument << 4) | seg.volume`、src/vgm2mml/converter.js の `ev.volume * 3` 参照)。
    // そのため反転はこの表示用正規化の中だけで行う。
    // note: Kss2MmlExpansionのfreqToNoteNumberはMML変換共通のノート番号体系(57=A4)で、
    // 標準MIDIより1オクターブ(12)低い。鍵盤描画に合わせるロール側でのみ+12補正する。
    // ★抽出イベントは「音量が1でも変わったら別イベント」に切れているため、音程が同じまま
    // 途切れず続いている区間を1本の音符に統合する(retriggerだけは区切りとして残す)。
    const toNotes = (events, attenuated, ctx, tones) => {
      const norm = (v) => {
        const n = Math.max(0, Math.min(15, v || 0));
        return (attenuated ? (15 - n) : n) / 15;
      };
      // ノイズ行(AYの@2)は note がノイズ周期そのもの(ppmckのFME-7仕様)なので、
      // そのまま +12 すると MIDI_MIN(24) を下回って描画されない。抽出器が付けてくれる
      // noiseRollIndex(0-15)を使い、他チップのノイズ行と同じ C1〜D#2 に並べる
      // (keyboard.js noisePeriodIndexToMidi と同じ 24+idx)。
      const midiOf = (e) => (e.noiseRollIndex !== undefined) ? 24 + e.noiseRollIndex : e.note + 12;
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        // @EN(高速アルペジオ)統合済みイベントはフレーム単位の音程列へ戻す
        // (RollBuild.expandNoteEnv参照。未統合イベントは1区間のまま素通りする)。
        // freqSeq(セント偏差オーバーレイ)と retrigger は元イベント先頭の区間にだけ効く。
        const steps = RollBuild.expandNoteEnv(e.start, e.end, midiOf(e), e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && !(e.retrigger && si === 0) && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, norm(e.volume));
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: norm(e.volume), freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    // 音色キー付きのトラック(ctx は toneKey.js ofEvent の文脈=チップと種別)
    const mk = (id, color, events, attenuated, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, attenuated, ctx, tones), tones }; };

    const ayResult = MML.Kss2MmlExpansion.ay(writeLog, totalFrames, clock);
    const KP_COLS = ['#66ddff', '#33aaff', '#0077dd'];
    ayResult.channels.forEach((ch, i) => tracks.push(mk(`KP${i + 1}`, KP_COLS[i], ch.events, false, { chip: 'ay8910', kind: 'square' })));

    // SCC未使用の曲では鍵盤表示側にもKS行を出さないので、ロールのトラックも作らない
    // (トラックidと鍵盤の行が1対1で対応している必要がある)
    if (sccUsed) {
      const sccResult = MML.Kss2MmlExpansion.scc(writeLog, totalFrames, clock);
      sccResult.channels.forEach((ch, i) => tracks.push(mk(`KS${i + 1}`, `hsl(${(280 + i * 20) % 360},80%,60%)`, ch.events, false, { chip: 'k051649', kind: 'wave' })));
    }

    if (header && header.device.mode === 'MSX' && header.device.fmpac) {
      const opllResult = MML.Kss2MmlExpansion.opll(writeLog, totalFrames);
      const KF_COLS = ['#ffcc00','#ffdd44','#ffe566','#ffee88','#fff2aa','#fff8cc','#ffd9a0','#ffe0b0','#ffe8c0'];
      // 第2引数true = OPLLの音量は減衰値なので表示用に反転する(toNotes冒頭のコメント参照)
      opllResult.channels.forEach((ch, i) => tracks.push(mk(`KF${i + 1}`, KF_COLS[i % KF_COLS.length], ch.events, true, { chip: 'ym2413', kind: 'fm' })));
      // リズムモードの打楽器5行。id/色/並び順は鍵盤側(keyboard.js の kssOpll 分岐、
      // RCOLS/RLABEL)と1対1で合わせる。音程を持たないので疑似音程(noiseRollIndex)で
      // 5レーンに分けている(kss2mml/expansion/opll.js の RHYTHM_DEFS 参照)。
      if (opllResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RLABEL = { bd: 'BD', sd: 'SD', tom: 'TOM', cym: 'CYM', hh: 'HH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: `KF${RLABEL[key]}`, color: RCOLS[key],
            notes: toNotes(opllResult.rhythm[key] || [], true) });
        }
      }
    }

    // OPL系(MSX-AUDIO/YM3812/YM3526/Y8950): KF行と同じ流儀でOL行。音量はOPLL同様
    // 減衰値(attenuated=true)。リズムモード曲は打楽器5行、Y8950 ADPCM打点はOLB行。
    if (oplOpts && oplOpts.used && MML.Kss2MmlExpansion.opl) {
      const oplResult = MML.Kss2MmlExpansion.opl(writeLog, totalFrames, oplOpts.clock);
      const OL_COLS = ['#66ffcc', '#55eebb', '#44ddaa', '#33cc99', '#22bb88', '#11aa77', '#66e0d0', '#55d0c0', '#44c0b0'];
      oplResult.channels.forEach((ch, i) => tracks.push(mk(`OL${i + 1}`, OL_COLS[i % OL_COLS.length], ch.events, true, { chip: 'opl', kind: 'fm' })));
      if (oplResult.rhythm) {
        const RCOLS = { bd: '#ff5555', sd: '#ffaa55', tom: '#aaff55', cym: '#55ffaa', hh: '#55aaff' };
        const RIDS = { bd: 'OLBD', sd: 'OLSD', tom: 'OLTM', cym: 'OLCY', hh: 'OLHH' };
        for (const key of ['bd', 'sd', 'tom', 'cym', 'hh']) {
          tracks.push({ id: RIDS[key], color: RCOLS[key], notes: toNotes(oplResult.rhythm[key] || [], true) });
        }
      }
      if (oplResult.adpcm) tracks.push({ id: 'OLB', color: '#cc66ff', notes: toNotes(oplResult.adpcm, true) });
    }

    return tracks;
  };

  // ── GBS ──────────────────────────────────────────────────────────────
  RollBuild.gbs = function (snapshots, frameRate) {
    const frameDur = 1 / frameRate;
    // toNotes: 音程が同じまま途切れず続いている区間を1本の音符に統合する(GBは実トリガbitが
    // あるためretrigger判定はtriggerSeqの変化そのもの=抽出側で既にイベント境界として反映済み)。
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const mk = (id, color, events, ctx) => { const tones = {}; return { id, color, notes: toNotes(events, ctx, tones), tones }; };
    // ★pulse()の音量はhwEnvelope.js側で64Hz実機クロックとplayFps(=frameRate)の位相を
    // 見て再計算するため、frameRateを渡さないとvolumeAt()内でNaNになり無音扱いになる。
    const ch1 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch1', null, frameRate);
    const ch2 = MML.Gbs2MmlExpansion.pulse(snapshots, 'ch2', null, frameRate);
    const noise = MML.Gbs2MmlExpansion.noise(snapshots, null, frameRate);
    const wave = MML.Gbs2MmlExpansion.wave(snapshots);
    tracks.push(mk('GB1', '#66ddff', ch1.events, { chip: 'gb', kind: 'square' }));
    tracks.push(mk('GB2', '#0077dd', ch2.events, { chip: 'gb', kind: 'square' }));
    tracks.push({ id: 'GN', color: '#aaaaaa', notes: toNotes(noise.events) });
    tracks.push(mk('GW', '#ffcc00', wave.events, { chip: 'gb', kind: 'wave' }));
    return tracks;
  };

  // ── HES ──────────────────────────────────────────────────────────────
  // dpcmTrace/controlTrace(省略可): 渡されると DDA(PCM)の打点を drumKey 付きノートとして
  // 該当chのトラックへ足す(ロールのドラム区画/パッドに出る。VGMのサンプルPCMと同じ形)。
  // 打点の同定は hes2mml/expansion/dpcm.js ddaHits(MML変換と同じ登録簿)なので、
  // ロールで見た太鼓と変換で出る @DPCM が一致する([[roll-as-mml-debugger]])。
  RollBuild.hes = function (snapshots, frameRate, dpcmTrace, controlTrace) {
    const frameDur = 1 / frameRate;
    // @EN(高速アルペジオ)統合済みイベントの展開はKSS側と同じ(RollBuild.expandNoteEnv参照)。
    const toNotes = (events, ctx, tones) => {
      const out = [];
      let endFrame = -1;
      for (const e of events) {
        if (e.note === null) { endFrame = -1; continue; }
        const steps = RollBuild.expandNoteEnv(e.start, e.end, e.note + 12, e.noteEnvOffsets);
        const tone = RollBuild.toneOf(e, ctx, tones);
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const prev = out[out.length - 1];
          if (prev && endFrame === st.start && prev.midi === st.note) {
            prev.endSec = st.end * frameDur;
            prev.vol = Math.max(prev.vol, (e.volume || 0) / 15);
            if (si === 0 && e.freqSeq) prev.freqSeq.push(...e.freqSeq);
            if (!prev.tone && tone) prev.tone = tone;
          } else {
            const n = { startSec: st.start * frameDur, endSec: st.end * frameDur, midi: st.note, vol: (e.volume || 0) / 15, freqSeq: (si === 0 && e.freqSeq) ? e.freqSeq.slice() : [] };
            if (tone) n.tone = tone;
            out.push(n);
          }
          endFrame = st.end;
        }
      }
      return out;
    };
    const tracks = [];
    const waveResult = MML.Hes2MmlExpansion.wave(snapshots);
    // id/色はkeyboard.js extractChannels()のisHesブロック(PSG0-5, PCOLS)と揃える。
    const colors = ['#66ddff', '#33aaff', '#0099ff', '#33cc99', '#ffaa00', '#ff6699'];
    // ノイズはch4/5独自の発音で、行/鍵盤表示でも同じPSG4/PSG5の行がwave/noiseを兼ねる
    // (wave/noiseは同一chで排他なので時間的に重ならず、単純にマージしてよい)。
    waveResult.channels.forEach((ch, i) => {
      const tones = {};
      let notes = toNotes(ch.events, { chip: 'huc6280', kind: 'wave' }, tones);
      if (i === 4 || i === 5) {
        const noiseNotes = toNotes(MML.Hes2MmlExpansion.noiseChannel(snapshots, i).events);
        if (noiseNotes.length) notes = notes.concat(noiseNotes).sort((a, b) => a.startSec - b.startSec);
      }
      tracks.push({ id: `PSG${i}`, color: colors[i % colors.length], notes, tones });
    });
    // DDA(PCM)の打点 → ドラム区画のノート(midi無し、drumKey/drumSeq付き)。
    // 同じ太鼓の連打が1本に融合しないよう drumSeq に打点の通番を入れる
    if (dpcmTrace && controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.ddaHits) {
      try {
        const { hits } = MML.Hes2MmlExpansion.ddaHits(snapshots, dpcmTrace, controlTrace, frameRate);
        hits.forEach((h, i) => {
          const tr = tracks[h.ch];
          if (!tr) return;
          tr.notes.push({ startSec: h.startFrame * frameDur, endSec: h.endFrame * frameDur, midi: null,
                          drumKey: h.key, drumSeq: i + 1, vol: h.vol, freqSeq: [] });
        });
        for (const tr of tracks) tr.notes.sort((a, b) => a.startSec - b.startSec);
      } catch (e) { /* DDA抽出の失敗でロール全体を落とさない */ }
    }
    return tracks;
  };

  // ── NSF(keyboard.jsの共通抽出経路への橋渡し)──────────────────────────
  RollBuild.nsf = function (regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots) {
    return MML.UI.buildRollTracksFromRegSnapshots(
      regSnapshots, writeLog, totalFrames, samplesPerFrame, sampleRate, chips, n163Snapshots);
  };

  // ── VGM(チップファミリごとに上の各ビルダー/共通抽出経路を連結)─────────
  // opts.poolMode: チャンネルプール式チップの表示モード({multipcm:'logical'|'phys'})。
  // 'logical'なら割当逆算済みスナップショット(data.multipcm.logical)でロールを組む
  RollBuild.vgm = function (data, done, opts) {
    const frameRate = data.frameRate;
    const sr = 44100;
    const buildTracks = MML.UI.buildRollTracksFromRegSnapshots;
    let tracks = [];
    if (data.nes) {
      const nesChips = ['nes'].concat(data.nes.fds ? ['fds'] : []);
      const t = buildTracks(data.nes.regSnapshots, data.nes.writeLog, done, sr / frameRate, sr, nesChips, null);
      if (t) tracks = tracks.concat(t);
    }
    if (data.gb) tracks = tracks.concat(RollBuild.gbs(data.gb.snapshots.slice(0, done), frameRate));
    if (data.hes) tracks = tracks.concat(RollBuild.hes(data.hes.snapshots.slice(0, done), frameRate));
    if (data.kss) {
      const wl = data.kss.writeLog.slice(0, done);
      const fakeHeader = { device: { mode: 'MSX', fmpac: data.kss.opll } };
      const kssTracks = RollBuild.kss(wl, done, frameRate, fakeHeader, data.kss.scc, data.kss.clock,
        data.kss.opl ? { used: true, clock: data.kss.oplClock } : null);
      // AY未使用(SCC/OPLLのみ)のVGMではKP行が鍵盤に無いのでロール側も落とす
      tracks = tracks.concat(data.kss.ay ? kssTracks : kssTracks.filter(t => !/^KP\d/.test(t.id)));
    }
    // 2個目のPSG(vgmPlayer.js captureVgmSongAsync の kss2): 同じKSS抽出器で作って KP4-6 へ付け替える
    if (data.kss2) {
      const wl2 = data.kss2.writeLog.slice(0, done);
      const t2 = RollBuild.kss(wl2, done, frameRate, { device: { mode: 'MSX', fmpac: false } }, false, data.kss2.clock, null)
        .filter(t => /^KP[1-3]$/.test(t.id))
        .map(t => Object.assign({}, t, { id: 'KP' + (+t.id.slice(2) + 3) }));
      tracks = tracks.concat(t2);
    }
    // スナップショット型チップ: extractChannels(keyboard.js)が読むextraSnapsに
    // フレーム毎スナップショット配列を渡して同じ抽出経路でトラック化する
    const snapChips = ['sn', 'ym2612', 'ym2610fm', 'ym2151', 'ym2203fm', 'ym2608fm', 'ga20', 'k007232', 'k054539', 'msm5205', 'segapcm', 'c140', 'c352', 'okim6258', 'qsound', 'okim6295', 'multipcm', 'pwm', 'rf5c164', 'rf5c68'];
    const chipToken = { sn: 'sn76489' };
    const poolMode = (opts && opts.poolMode) || {};
    for (const key of snapChips) {
      if (!data[key]) continue;
      const token = chipToken[key] || key;
      const snaps = (poolMode[key] === 'logical') ? (RollBuild.poolLogical(data, key) || data[key].snapshots) : data[key].snapshots;
      const extra = {}; extra[key] = snaps;
      const t = buildTracks(snaps, [], done, sr / frameRate, sr, ['vgm', token], null, extra);
      if (t) tracks = tracks.concat(t);
    }
    return tracks;
  };

  // ── PSF(PlayStation SPU)────────────────────────────────────────────
  // キャプチャ(psfPlayer.js capturePsfSongAsync / Worker の鏡像)の Int32Array スナップショットを
  // Emu.snapshotPsx で C352 と同じ形のオブジェクトへ変換し、VGM の PCM チップと同じ抽出経路
  // (keyboard.js extractChannels の 'psx' 行)でトラック化する。変換済みのフレームは state に
  // 溜めて次回は続きだけ作る(ロールは曲が伸びるたびに何度も組み直すため)。
  // opts.poolMode.psx === 'phys' なら実機ボイス、それ以外は合成ch(Emu.PoolChannelRegrouper)。
  RollBuild.psfObjectSnapshots = function (cap, state) {
    const Emu = MML.Emu;
    if (!state.bank || state.bank.samples !== cap.samples) state.bank = new Emu.PsxSampleBank(cap.samples);
    if (!state.data) state.data = { psx: { snapshots: [] } };
    const out = state.data.psx.snapshots;
    const n = cap.snapshots.length;
    for (let i = out.length; i < n; i++) {
      if (!cap.snapshots[i]) break; // Worker の鏡像は穴が空かない想定だが、念のため途中で止める
      out.push(Emu.snapshotPsx(cap.snapshots[i], state.bank));
    }
    return state.data;
  };
  RollBuild.psf = function (cap, done, opts, state) {
    const frameRate = cap.frameRate || 60;
    const sr = 44100;
    const data = RollBuild.psfObjectSnapshots(cap, state || {});
    const poolMode = (opts && opts.poolMode) || {};
    const snaps = RollBuild.psxFrames(data, poolMode.psx);
    const n = Math.min(done, snaps.length);
    const t = MML.UI.buildRollTracksFromRegSnapshots(snaps, [], n, sr / frameRate, sr, ['vgm', 'psx'], null, { psx: snaps });
    return t || [];
  };

  // PSF の表示モード別のレーン列: 'phys'=実機ボイス / 'logical'=合成ch / 'track'(既定)=トラック×声部
  RollBuild.psxFrames = function (data, mode) {
    if (mode === 'phys') return data.psx.snapshots;
    if (mode === 'logical') return RollBuild.poolLogical(data, 'psx') || data.psx.snapshots;
    return RollBuild.psxTrackFrames(data) || data.psx.snapshots;
  };

  // ── PSF の「トラック」レーン(Emu.PsfTrackVoicer) ───────────────────────
  // poolLogical と同じく snapshots が伸びた分だけ続きから足す(声部の割り当ては状態を持つので同じインスタンスで続ける)。
  // d.__trackState.vc.lanes がレーン表(鍵盤の行名/変換のソース名)
  RollBuild.psxTrackFrames = function (data) {
    const d = data && data.psx;
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots) || !Emu.PsfTrackVoicer) return null;
    let S = d.__trackState;
    if (!S) {
      Object.defineProperty(d, '__trackState', { value: { vc: new Emu.PsfTrackVoicer(), out: [] }, configurable: true, writable: true });
      S = d.__trackState;
    }
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.vc.step(d.snapshots[i]));
    return S.out;
  };

  // ── プール式PCMチップの「合成ch」スナップショット ─────────────────────
  // logical は snapshots を Emu.PoolChannelRegrouper に先頭から順に通しただけの決定的なデータ。
  // キャプチャWorkerは通信量を減らすため logical を送らない(2026-09-13。c140 では progress の
  // 復元時間の約4割がこれだった)ので、画面側で合成ch表示が要るときだけここで作る。
  // snapshots が伸びていれば続きから足す(回帰器は状態を持つので同じインスタンスで続ける)。
  // メインスレッドで丸ごとキャプチャした data には logical が揃っているので、そのまま返す。
  RollBuild.poolLogical = function (data, key) {
    const d = data && data[key];
    const Emu = MML.Emu;
    if (!d || !Array.isArray(d.snapshots)) return null;
    const st = d.__logicalState;
    if (!st && Array.isArray(d.logical) && d.logical.length >= d.snapshots.length) return d.logical;
    const numCh = Emu && Emu.POOL_CHIP_CHANNELS && Emu.POOL_CHIP_CHANNELS[key];
    if (!numCh || !Emu.PoolChannelRegrouper) return null;
    if (!st || d.logical !== st.out) {
      // 列挙されない印にして、構造化複製やJSON化で運ばれないようにする
      Object.defineProperty(d, '__logicalState', { value: { rg: new Emu.PoolChannelRegrouper(numCh), out: [] }, configurable: true, writable: true });
      d.logical = d.__logicalState.out;
    }
    const S = d.__logicalState;
    for (let i = S.out.length; i < d.snapshots.length; i++) S.out.push(S.rg.step(d.snapshots[i]));
    return S.out;
  };

  // ── 構築スロットル ────────────────────────────────────────────────────
  // 壁時計ベース+直前の構築実測コスト×10を次回までの最小間隔にする適応制御
  // (構築のCPU占有率を~10%以下に自動制御。曲が進み1回の走査が重くなるほど自動的に
  // 間遠になる)。メインスレッドでは加えて非表示タブ中は最終回以外スキップする
  // (Worker内にはdocumentが無いので可視性チェックは自動的に無効=常時構築でよい。
  // Worker内の構築はメインスレッドをブロックしないため)。
  RollBuild.makeThrottle = function () {
    let lastBuildEnd = -Infinity;
    let minIntervalMs = 300;
    return {
      shouldBuild(done, total) {
        if (done >= total) return true; // 最終回は必ず構築(取りこぼし防止)
        if (typeof document !== 'undefined' && document.hidden) return false;
        return performance.now() - lastBuildEnd >= minIntervalMs;
      },
      didBuild(buildStartMs) {
        lastBuildEnd = performance.now();
        minIntervalMs = Math.max(300, Math.min(5000, (lastBuildEnd - buildStartMs) * 10));
      },
      force() { lastBuildEnd = -Infinity; }
    };
  };

  // ── ロール構築ジョブ(フォーマット差異の吸収)─────────────────────────
  // Worker実装(capture-worker-*-impl.js)とクライアントのフォールバック
  // (capture-worker-client.js)の両方から使う。build(data, done, total)は
  // {timeline, info} を返す(infoはフォーマット固有の副産物: KSSのsccUsed、
  // HESのddaChannel)。dataの形はフォーマットごとのキャプチャ進行データ:
  //   nsf: {regSnapshots, writeLog, n163Snapshots} / kss: {writeLog}
  //   gbs: {snapshots} / hes: {snapshots, dpcmTrace, controlTrace}
  //   spc: {frameLog} / vgm: captureVgmSongAsyncのdataそのもの
  //   psf: capturePsfSongAsync の cap({snapshots, samples, frameRate})
  RollBuild.createRollJob = function (format, params) {
    params = params || {};
    if (format === 'nsf') {
      return { build: (data, done) => ({
        timeline: RollBuild.nsf(data.regSnapshots, data.writeLog, done,
          params.samplesPerFrame, params.sampleRate, params.chips || [], data.n163Snapshots),
        info: {}
      }) };
    }
    if (format === 'kss') {
      const sccPossible = RollBuild.kssHasSccDecoder(params.header);
      let sccUsed = false;
      let scanned = 0;
      // MSX-AUDIO(Y8950)を積むKSSはOL行も作る(クロックはMSX固定3.58MHz)
      const oplOpts = (params.header && params.header.device && params.header.device.msxAudio)
        ? { used: true, clock: 3579545 } : null;
      return { build: (data, done) => {
        // SCCは「使われたと分かった時点で行を足す」単調運用(main.js playKssStream参照)
        if (sccPossible && !sccUsed && RollBuild.kssWriteLogUsesScc(data.writeLog, scanned, done)) sccUsed = true;
        scanned = done;
        return {
          timeline: RollBuild.kss(data.writeLog.slice(0, done), done, params.frameRate, params.header, sccUsed, null, oplOpts),
          info: { sccUsed }
        };
      } };
    }
    if (format === 'gbs') {
      return { build: (data, done) => ({
        timeline: RollBuild.gbs(data.snapshots.slice(0, done), params.frameRate), info: {}
      }) };
    }
    if (format === 'hes') {
      return { build: (data, done) => {
        const snaps = data.snapshots.slice(0, done);
        const out = { timeline: RollBuild.hes(snaps, params.frameRate, data.dpcmTrace, data.controlTrace), info: {} };
        // DDA(PCM)を担当するchの判定(曲全体でDDA区間が最も長い1ch)も同じ頻度で更新する。
        // 実際の再生に使う生のdpcmTrace列はメインスレッド側が保持しているので、
        // ここではチャンネル番号だけをinfoで返す(main.js側でsetDdaChannel)。
        if (data.dpcmTrace && data.controlTrace && MML.Hes2MmlExpansion && MML.Hes2MmlExpansion.extractDdaClips) {
          out.info.ddaChannel = MML.Hes2MmlExpansion.extractDdaClips(
            snaps, data.dpcmTrace, data.controlTrace, params.frameRate).channel;
        }
        return out;
      } };
    }
    if (format === 'spc') {
      return { build: (data, done) => ({
        timeline: RollBuild.spc(data.frameLog.slice(0, done), params.frameRate, params.fineTune || null, params.drumKinds || null),
        info: {}
      }) };
    }
    if (format === 'psf') {
      const state = {};
      return { build: (data, done) => ({ timeline: RollBuild.psf(data, done, params, state), info: {} }) };
    }
    if (format === 'vgm') {
      // params.poolMode: プール式チップの表示モード(Worker実行時はopt.roll経由で届く)
      return { build: (data, done) => ({ timeline: RollBuild.vgm(data, done, params), info: {} }) };
    }
    return null;
  };
})(globalThis);

/*
 * NSF regsOnlyキャプチャ Worker本体
 *
 * このファイル単体ではメインスレッドに読み込まれない。README-worker-build.txt の
 * PowerShellスクリプトがエミュレータ一式と結合して src/audio/nsf-capture-worker.js
 * (メインスレッドでは「実行されない関数」として定義されるバンドル)を生成し、
 * src/audio/capture-worker-client.js が Function.prototype.toString + Blob URL で
 * Web Worker として起動する(fetch()不使用、file://直開きでも動作)。
 *
 * プロトコル(capture-worker-client.jsと対):
 *   受信 {cmd:'capture', nsfBytes, opt}  … キャプチャ開始(optはstructured clone可能な値のみ)
 *   受信 {cmd:'cancel'}                  … 次のスライス境界で打ち切り
 *   送信 {type:'progress', done, total, start, writeLog, regSnapshots, n163Snapshots,
 *         [initRegs, initWrites]}        … start..done-1フレーム分の差分(初回のみinit*付き)
 *   送信 {type:'done'} / {type:'error', message}
 *   送信 {type:'roll', done, total, timeline, info} … opt.roll={samplesPerFrame,
 *         sampleRate, chips}が渡された場合のみ。ピアノロールのタイムライン構築
 *         (O(done)の全走査、メインスレッドの長タスク=カクつきの主因だった)を
 *         Worker内で行い完成品だけを送る(src/audio/roll-builders.js参照)
 *   送信 {type:'rollError', message} … ロール構築失敗(以後この曲では送らない)
 */
(function (global) {
  const MML = global.MML;

  // WorkerにはsetTimeout(0)の4msクランプ回避手段としてMessageChannelによる
  // マクロタスクyieldを使う(スライスごとの待ち時間を実質ゼロにしつつ、
  // 'cancel'メッセージの受信機会は確保する)。
  function macroYield() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  }

  let cancelled = false;

  global.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { cancelled = true; return; }
    if (msg.cmd !== 'capture') return;

    cancelled = false;
    const opt = Object.assign({}, msg.opt, {
      shouldCancel: () => cancelled,
      yieldFn: macroYield,
      // Worker内はUIをブロックしないのでスライスを大きめに取り、メッセージ数を抑える。
      // 30ms = cancel応答性とprogress粒度の上限でもある。
      // (NSFの受信は軽いので細かく区切らない。細かく区切るのはVGMだけ: capture-worker-multi-impl.js WORKER_SLICE_MS_VGM)
      sliceBudgetMs: 30
    });

    // ロール構築(opt.rollが無ければ無効。capture-worker-multi-impl.jsのmakeRollSenderと
    // 同じ考え方: スロットルの可視性チェックはWorker内では自動的に素通り=常時構築)
    let sendRoll = null;
    if (MML.RollBuild && msg.opt.roll) {
      const job = MML.RollBuild.createRollJob('nsf', msg.opt.roll);
      const throttle = MML.RollBuild.makeThrottle();
      let rollFailed = false;
      if (job) sendRoll = (data, done, total) => {
        if (rollFailed || !throttle.shouldBuild(done, total)) return;
        const t0 = performance.now();
        try {
          const r = job.build(data, done, total);
          throttle.didBuild(t0);
          global.postMessage({ type: 'roll', done, total, timeline: r.timeline, info: r.info });
        } catch (err) {
          rollFailed = true;
          global.postMessage({ type: 'rollError', message: String((err && err.stack) || err) });
        }
      };
    }

    // onProgressは進行中配列(全体)への参照を渡してくるので、前回送信位置からの
    // 差分だけをpostMessageする(structured cloneのコストを送信ごとに一定に保つ)。
    let lastSent = 0;
    let initSent = false;
    const onProgress = (done, total, regSnapshots, writeLog, n163Snapshots, initRegs, initWrites) => {
      if (done <= lastSent) return;
      const chunk = {
        type: 'progress',
        done, total,
        start: lastSent,
        writeLog: writeLog.slice(lastSent, done),
        regSnapshots: regSnapshots.slice(lastSent, done),
        n163Snapshots: n163Snapshots.slice(lastSent, done)
      };
      if (!initSent) {
        initSent = true;
        chunk.initRegs = initRegs;
        chunk.initWrites = initWrites;
      }
      lastSent = done;
      global.postMessage(chunk);
      if (sendRoll) sendRoll({ regSnapshots, writeLog, n163Snapshots }, done, total);
    };

    try {
      await MML.Emu.captureSongAsync(msg.nsfBytes, opt, onProgress);
      global.postMessage({ type: 'done', cancelled });
    } catch (err) {
      global.postMessage({ type: 'error', message: String((err && err.stack) || err) });
    }
  };
})(globalThis);

  };
})(window);