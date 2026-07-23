/*
 * NSF (Nintendo Sound Format) 1.x 128バイトヘッダ生成
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
})(window);
