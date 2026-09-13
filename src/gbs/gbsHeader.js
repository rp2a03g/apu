/*
 * GBS (Game Boy Sound) ヘッダ解析
 * MML.GBS
 *
 * 参考: OverClocked ReMix "GBS Format Specification"(gbsplayのGBS.txt準拠)、
 *       gbsplay(https://github.com/mmitch/gbsplay) gbs.c、
 *       Game_Music_Emu Gbs_Emu.cpp
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const GBS = MML.GBS = MML.GBS || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キャプチャWorker内など MML.I18n が無い環境では素通し
  const tr = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  GBS.CPU_CLOCK = 4194304; // DMG CPU/APU共通クロック(Hz)
  GBS.VBLANK_FPS = GBS.CPU_CLOCK / 70224; // ≒59.7275Hz(TAC無効時、VBlank駆動でPLAYを呼ぶ頻度)

  // TACビット1-0(クロック選択)ごとの入力クロック分周(Tステート単位、TIMAが1進むごとの周期)
  const TAC_DIVIDER = [1024, 16, 64, 256];

  function decodeAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[offset + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /**
   * GBSファイルのバイト列を解析する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  GBS.parseHeader = function (bytes) {
    if (bytes.length < 0x70) throw new Error(tr('GBSヘッダは最低0x70バイト必要です'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    const magicOk = magic === 'GBS';
    const version = bytes[3];
    const numSongs = bytes[4];
    const firstSong = bytes[5]; // 1始まり(INIT呼出時は呼び出し側で0始まりに変換する)
    const loadAddr = view.getUint16(0x06, true);
    const initAddr = view.getUint16(0x08, true);
    const playAddr = view.getUint16(0x0A, true);
    const stackPointer = view.getUint16(0x0C, true);
    const tma = bytes[0x0E];
    const tac = bytes[0x0F];
    const title = decodeAscii(bytes, 0x10, 32);
    const author = decodeAscii(bytes, 0x30, 32);
    const copyright = decodeAscii(bytes, 0x50, 32);

    // TACビット2=タイマ有効。有効ならTMA/TACから求まる周期でPLAYを呼ぶ(タイマ割込駆動)、
    // 無効ならVBlank駆動(約59.7275Hz)。実機の「どちらの割込ベクタからPLAYを呼ぶか」の
    // 判定をそのままPLAY呼び出し頻度の計算に置き換えている
    // (本エミュレータはCPU割込ディスパッチを実装せず、gbsPlayer.jsがこの頻度で
    // PLAYをサブルーチンとして直接呼び出す簡略設計。詳細はgbsPlayer.js冒頭コメント参照)。
    const timerEnabled = (tac & 0x04) !== 0;
    let playFps;
    if (timerEnabled) {
      const divider = TAC_DIVIDER[tac & 0x03];
      const framesTCycles = divider * (256 - tma);
      playFps = GBS.CPU_CLOCK / framesTCycles;
    } else {
      playFps = GBS.VBLANK_FPS;
    }

    return {
      magic, magicOk, version, numSongs, firstSong,
      loadAddr, initAddr, playAddr, stackPointer,
      tma, tac, timerEnabled, playFps,
      title, author, copyright,
      dataOffset: 0x70
    };
  };
})(window);
