/*
 * iNES / NES 2.0 ヘッダ (MML.Emu.INES) — 自前 NES エミュレータ(DESIGN-CAPTURE.md §7)の入口
 *
 * 読むのは「遊べる」のに要る項目だけ: PRG/CHR の大きさ、マッパー番号(NES 2.0 なら 12bit)、
 * サブマッパー、ミラーリング、バッテリ、4 画面、トレーナー。PRG RAM の大きさは NES 2.0 の
 * 指数表記を読み、iNES では 8K 固定にする(どの基板でも 8K あれば困らない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const INES = {};

  INES.parse = function (bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 16 || bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) {
      throw new Error('iNES ヘッダではありません');
    }
    const nes2 = (bytes[7] & 0x0C) === 0x08;
    let prgUnits = bytes[4], chrUnits = bytes[5];
    let mapper = (bytes[6] >> 4) | (bytes[7] & 0xF0);
    let submapper = 0;
    let prgRamSize = 0x2000, chrRamSize = 0;
    if (nes2) {
      mapper |= (bytes[8] & 0x0F) << 8;
      submapper = bytes[8] >> 4;
      prgUnits |= (bytes[9] & 0x0F) << 8;
      chrUnits |= (bytes[9] & 0xF0) << 4;
      const prgRamShift = bytes[10] & 0x0F, prgNvShift = bytes[10] >> 4;
      prgRamSize = Math.max(prgRamShift ? 64 << prgRamShift : 0, prgNvShift ? 64 << prgNvShift : 0) || 0x2000;
      const chrRamShift = bytes[11] & 0x0F, chrNvShift = bytes[11] >> 4;
      chrRamSize = Math.max(chrRamShift ? 64 << chrRamShift : 0, chrNvShift ? 64 << chrNvShift : 0);
    } else if ((bytes[7] & 0x0C) === 0x04 || bytes.slice(12, 16).some(b => b !== 0)) {
      // 古いダンプの「ゴミ入り」ヘッダ: 上位マッパービットを信用しない
      mapper &= 0x0F;
    }
    const trainer = (bytes[6] & 0x04) !== 0;
    let p = 16 + (trainer ? 512 : 0);
    const prgSize = prgUnits * 0x4000, chrSize = chrUnits * 0x2000;
    if (p + prgSize > bytes.length) throw new Error('PRG ROM がファイルより大きい(壊れたファイル)');
    const prg = bytes.slice(p, p + prgSize); p += prgSize;
    const chr = chrSize ? bytes.slice(p, Math.min(bytes.length, p + chrSize)) : null;
    if (!chr && !chrRamSize) chrRamSize = 0x2000;
    return {
      nes2, mapper, submapper,
      prg, chr, chrRamSize,
      prgRamSize,
      mirroring: (bytes[6] & 0x08) ? '4' : ((bytes[6] & 0x01) ? 'V' : 'H'),
      fourScreen: (bytes[6] & 0x08) !== 0,
      battery: (bytes[6] & 0x02) !== 0,
      trainer,
    };
  };

  INES.describe = function (rom) {
    return `mapper ${rom.mapper}${rom.submapper ? '.' + rom.submapper : ''}, PRG ${rom.prg.length >> 10}K, CHR ${rom.chr ? (rom.chr.length >> 10) + 'K' : 'RAM ' + (rom.chrRamSize >> 10) + 'K'}, ` +
      `mirror ${rom.mirroring}${rom.battery ? ', battery' : ''}${rom.nes2 ? ', NES2.0' : ''}`;
  };

  Emu.INES = INES;
})(typeof window !== 'undefined' ? window : globalThis);
