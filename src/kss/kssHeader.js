/*
 * KSS (MSX/SEGA chiptune) ヘッダ解析
 * 参考: libkss (digital-sound-antiques) kssxspec.md / src/kss/kss.c
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const KSS = MML.KSS = MML.KSS || {};

  // 拡張チップフラグ (オフセット 0x0F) の意味
  // MSXモード (bit1=0):
  //   bit0: FMPAC(FM-PAC/OPLL) or FMUNIT (bit1で判別、MSXモードなのでFMPAC)
  //   bit2: RAM使用
  //   bit3: MSX-AUDIO使用
  //   bit4: (MSX-AUDIO使用時) ステレオ
  //   bit6: 0=NTSC, 1=PAL
  // SEGAモード (bit1=1):
  //   bit0: FMUNIT使用
  //   bit1: 1固定(SN76489使用)
  //   bit2: GGステレオ
  //   bit3: RAM使用
  //   bit6: 0=NTSC, 1=PAL
  function decodeDeviceFlag(flag) {
    const sn76489 = !!(flag & 0x02);
    const palMode = !!(flag & 0x40);
    if (sn76489) {
      return {
        mode: 'SEGA',
        fmunit: !!(flag & 0x01),
        fmpac: false,
        sn76489: true,
        ggStereo: !!(flag & 0x04),
        ramMode: !!(flag & 0x08),
        msxAudio: false,
        stereo: !!(flag & 0x04),
        palMode
      };
    }
    const msxAudio = !!(flag & 0x08);
    return {
      mode: 'MSX',
      fmpac: !!(flag & 0x01),
      fmunit: !!(flag & 0x01),
      sn76489: false,
      ramMode: !!(flag & 0x04),
      msxAudio,
      stereo: msxAudio ? !!(flag & 0x10) : false,
      palMode
    };
  }

  /**
   * KSSファイルのバイト列を解析する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  KSS.parseHeader = function (bytes) {
    if (bytes.length < 16) throw new Error('KSSヘッダは最低16バイト必要です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magicStr = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const magicOk = magicStr === 'KSCC' || magicStr === 'KSSX';
    const isExtended = magicStr === 'KSSX';

    const loadAddr = view.getUint16(0x04, true);
    const dataLength = view.getUint16(0x06, true);
    const initAddr = view.getUint16(0x08, true);
    const playAddr = view.getUint16(0x0A, true);
    const bankOffset = view.getUint8(0x0C);
    const bankByte = view.getUint8(0x0D);
    const bankNum = bankByte & 0x7F;
    const bankMode = (bankByte & 0x80) ? '8K' : '16K';
    const extraHeaderSize = view.getUint8(0x0E); // 0x00 (KSCC) or 0x10 (KSSX)
    const deviceFlag = view.getUint8(0x0F);
    const device = decodeDeviceFlag(deviceFlag);

    let firstSong = 0;
    let lastSong = 0;
    let hasSongRange = false;
    let volumes = null;
    let fileSize = null;
    if (isExtended && extraHeaderSize >= 0x10 && bytes.length >= 0x10 + 0x10) {
      const ext = new DataView(bytes.buffer, bytes.byteOffset + 0x10, 0x10);
      fileSize = ext.getUint32(0x00, true);
      firstSong = ext.getUint16(0x08, true);
      lastSong = ext.getUint16(0x0A, true);
      hasSongRange = true;
      volumes = {
        psg: ext.getUint8(0x0C),
        scc: ext.getUint8(0x0D),
        opll: ext.getUint8(0x0E),
        opl: ext.getUint8(0x0F)
      };
    }

    const dataOffset = 0x10 + extraHeaderSize;

    return {
      magic: magicStr,
      magicOk,
      isExtended,
      loadAddr,
      dataLength,
      initAddr,
      playAddr,
      bankOffset,
      bankNum,
      bankMode,
      extraHeaderSize,
      deviceFlag,
      device,
      hasSongRange,
      firstSong,
      lastSong,
      volumes,
      fileSize,
      dataOffset
    };
  };

  /**
   * チップフラグを人間可読な文字列配列にする(ヘッダ表示用)
   */
  KSS.describeChips = function (header) {
    const list = ['PSG(AY-3-8910)'];
    if (header.bankNum > 0) list.push('SCC/SCC+ (Konami、使用時のみ)');
    const d = header.device;
    if (d.mode === 'SEGA') {
      if (d.sn76489) list.push('SN76489');
      if (d.fmunit) list.push('FM Unit (Y8950)');
    } else {
      if (d.fmpac) list.push('FMPAC (OPLL/YM2413)');
      if (d.msxAudio) list.push('MSX-AUDIO (Y8950, 未対応)');
    }
    return list;
  };

  // Z80クロック(MSX標準)とNTSC/PAL再生周波数
  KSS.Z80_CLOCK = 3579545;
  KSS.NTSC_FPS = KSS.Z80_CLOCK / 59718; // ≒ 59.9256Hz (libkss NTSC_FREQ)
  KSS.PAL_FPS = 50.0;
})(window);
