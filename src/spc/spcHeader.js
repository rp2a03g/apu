/*
 * SPC (SNES-SPC700 Sound File) v0.30 ヘッダ / ID666 タグ解析
 * MML.SPC.parseHeader(bytes) → { magicOk, pc, a, x, y, psw, sp, id666, ... }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const SPC = MML.SPC = MML.SPC || {};

  // ファイル識別子 (先頭33バイト)
  const MAGIC = 'SNES-SPC700 Sound File Data v0.30';

  function readAsciiZ(bytes, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function readLE16(bytes, off) {
    return bytes[off] | (bytes[off + 1] << 8);
  }

  function readLE32(bytes, off) {
    return (bytes[off] | (bytes[off+1]<<8) | (bytes[off+2]<<16) | (bytes[off+3]<<24)) >>> 0;
  }

  /**
   * SPC ファイルを解析してヘッダ情報を返す
   * @param {Uint8Array} bytes - SPCファイル全体
   * @returns {object}
   */
  SPC.parseHeader = function (bytes) {
    if (bytes.length < 0x100) throw new Error('SPCファイルが短すぎます（最低256バイト必要）');

    // マジック確認
    let magic = '';
    for (let i = 0; i < 33; i++) magic += String.fromCharCode(bytes[i]);
    const magicOk = magic === MAGIC && bytes[0x21] === 0x1A && bytes[0x22] === 0x1A;

    // ID666 タグ有無
    const hasId666 = bytes[0x23] === 0x1A;
    const minorVer = bytes[0x24];

    // SPC700 レジスタ初期値 (0x25-0x2D)
    const pc  = readLE16(bytes, 0x25);
    const a   = bytes[0x27];
    const x   = bytes[0x28];
    const y   = bytes[0x29];
    const psw = bytes[0x2A];
    const sp  = bytes[0x2B];

    // ID666 タグ (0x2E-0xFF, 210 bytes)
    let id666 = null;
    if (hasId666 && bytes.length >= 0x100) {
      id666 = {
        songTitle:  readAsciiZ(bytes, 0x2E, 32),
        gameTitle:  readAsciiZ(bytes, 0x4E, 32),
        dumperName: readAsciiZ(bytes, 0x6E, 16),
        comments:   readAsciiZ(bytes, 0x7E, 32),
        dumpDate:   readAsciiZ(bytes, 0x9E, 11),
        playSeconds: _parseDecStr(bytes, 0xA9, 3),
        fadeMs:      _parseDecStr(bytes, 0xAC, 5),
        artistName: readAsciiZ(bytes, 0xB1, 32),
        defaultChannelEnable: bytes[0xD1],
        emulatorUsed: bytes[0xD2],
      };
    }

    // RAM / DSP レジスタ / XRAM 存在確認
    const hasRam    = bytes.length >= 0x10100;
    const hasDspReg = bytes.length >= 0x10180;
    const hasXram   = bytes.length >= 0x101C0;

    return {
      magicOk,
      hasId666,
      minorVer,
      pc, a, x, y, psw, sp,
      id666,
      hasRam,
      hasDspReg,
      hasXram,
    };
  };

  /** 数字文字列デコード (ASCII 数字、スペース含む) */
  function _parseDecStr(bytes, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[off + i];
      if (c >= 0x30 && c <= 0x39) s += String.fromCharCode(c);
    }
    return s ? parseInt(s, 10) : 0;
  }

  /**
   * SPC ファイルから64KBのRAMダンプを取得
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} 65536バイト
   */
  SPC.getRam = function (bytes) {
    if (bytes.length < 0x10100) throw new Error('RAM領域がありません');
    return bytes.slice(0x100, 0x10100);
  };

  /**
   * SPC ファイルから128バイトのDSPレジスタダンプを取得
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} 128バイト
   */
  SPC.getDspRegs = function (bytes) {
    if (bytes.length < 0x10180) throw new Error('DSPレジスタ領域がありません');
    return bytes.slice(0x10100, 0x10180);
  };

  /**
   * SPC ファイルから64バイトのXRAMを取得
   * @param {Uint8Array} bytes
   * @returns {Uint8Array|null}
   */
  SPC.getXram = function (bytes) {
    if (bytes.length < 0x101C0) return null;
    return bytes.slice(0x10180, 0x101C0);
  };

})(window);
