/*
 * HES (Hudson Entertainment Sound / PC Engine) ヘッダ解析
 * MML.HES
 *
 * 参考: Game_Music_Emu(kode54/Game_Music_Emu) gme/Hes_Core.h の header_t 構造体
 *       (フィールドのオフセット・意味を実装から直接確認。本体コードは移植せず、
 *       構造体レイアウトという事実のみをクリーンルームで再実装している)。
 *
 * HESヘッダは32byte固定:
 *   0x00 tag[4]        "HESM"
 *   0x04 vers           バージョン(通常0)
 *   0x05 firstTrack     既定トラック番号(INIT呼出時にAレジスタへそのまま渡す値。
 *                       0始まり/1始まりの規約は無く、ゲームのプログラムが直接解釈する
 *                       任意の8bit値。NSF/GBSと違い「曲数」フィールドは存在しない
 *                       ─ 有効なトラック番号の集合はゲーム依存で、通常M3Uで個別に案内される)
 *   0x06 initAddr[2]    LE、INITルーチンの開始アドレス(CPU論理アドレス)
 *   0x08 banks[8]       MPR0-7の初期バンク番号(8bit×8。TAM/TMAでアクセスする
 *                       8KBページのバンク割当をそのまま初期値として書き込む)
 *   0x10 dataTag[4]     "DATA"(無くても警告のみで続行)
 *   0x14 dataSize[4]    LE、DATAブロックのバイト数
 *   0x18 addr[4]        LE、DATAブロックが物理アドレス空間(21bit、最大1MB)上で
 *                       開始する位置。banks[i]*0x2000 がこの範囲内に入っているページだけ
 *                       ROMデータとして読める(それ以外は0xFF=未マップ)
 *   0x1C unused[4]
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const HES = MML.HES = MML.HES || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。キャプチャWorker内など MML.I18n が無い環境では素通し
  const tr = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  HES.HEADER_SIZE = 0x20;
  HES.PAGE_SIZE = 0x2000; // 8KB
  HES.PAGE_COUNT = 8;     // MPR0-7
  HES.ROM_MAX = 0x100000; // 21bit物理アドレス空間(1MB)

  // PC Engine高速クロック(21477270/3。GME Hes_Emu.cppのsetup_buffer(7159091)相当、
  // ここでは colorburst*6/3 から誤差の無い整数で導出する)。
  HES.CPU_CLOCK_HIGH = 7159090; // 21477270 / 3
  HES.CPU_CLOCK_LOW = HES.CPU_CLOCK_HIGH / 4; // CSL時(/12)。CSHとの比は12/3=4倍。
  HES.PSG_CLOCK = 3579545; // colorburst(NTSC)、CPU_CLOCK_HIGH/2相当。PSG周波数式の基準クロック
  HES.VBLANK_FPS = HES.CPU_CLOCK_HIGH / (262 * 455); // ≒60.05Hz(走査線262本×455クロック)

  function decodeAscii(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[offset + i];
      if (c === undefined || c === 0) break;
      if (c < 0x20 || c > 0x7E) return ''; // 非テキストは無視(GME copy_field と同じ考え方)
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /**
   * HESファイルのバイト列を解析する
   * @param {Uint8Array} bytes
   * @returns {object}
   */
  HES.parseHeader = function (bytes) {
    if (bytes.length < HES.HEADER_SIZE) throw new Error(tr('HESヘッダは最低0x20バイト必要です'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const magicOk = tag === 'HESM';
    const vers = bytes[4];
    const firstTrack = bytes[5];
    const initAddr = view.getUint16(0x06, true);
    const banks = Array.from(bytes.slice(0x08, 0x10));
    const dataTag = String.fromCharCode(bytes[0x10], bytes[0x11], bytes[0x12], bytes[0x13]);
    const dataTagOk = dataTag === 'DATA';
    const dataSize = view.getUint32(0x14, true);
    const addr = view.getUint32(0x18, true) & (HES.ROM_MAX - 1);

    // タイトル/作者/著作権は正式なヘッダフィールドではなく、一部のリップツールが
    // DATAブロックの直後(header+0x20の位置、NSFの32byteテキストフィールドと同じ発想)に
    // 追加で書き出すことがある「おまけ」情報(GME Hes_Emu.cpp copy_hes_fields 相当)。
    // 無い曲がほとんどなので読めなくてもエラーにしない。
    let title = '', author = '', copyright = '';
    const infoOffset = HES.HEADER_SIZE + dataSize;
    if (infoOffset + 0x60 <= bytes.length) {
      title = decodeAscii(bytes, infoOffset, 0x20);
      author = decodeAscii(bytes, infoOffset + 0x20, 0x20);
      copyright = decodeAscii(bytes, infoOffset + 0x40, 0x20);
    }

    return {
      tag, magicOk, vers, firstTrack, initAddr, banks,
      dataTag, dataTagOk, dataSize, addr,
      title, author, copyright,
      dataOffset: HES.HEADER_SIZE
    };
  };
})(window);
