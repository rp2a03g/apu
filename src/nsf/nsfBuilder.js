/*
 * NSFバイナリ生成（ヘッダ + プログラムイメージ）
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const NSF = MML.NSF = MML.NSF || {};

  /**
   * ヘッダオプション + プログラムバイト列から完全なNSFバイナリを生成する。
   * プログラムバイト列は headerOpt.loadAddr から配置されるメモリイメージとする。
   * @param {object} headerOpt - NSF.buildHeader と同じオプション
   * @param {Uint8Array} programBytes
   * @returns {Uint8Array}
   */
  NSF.buildNSF = function (headerOpt, programBytes) {
    const header = NSF.buildHeader(headerOpt);
    const out = new Uint8Array(header.length + programBytes.length);
    out.set(header, 0);
    out.set(programBytes, header.length);
    return out;
  };

  /**
   * 6502アセンブラの出力 (MML.Asm.assemble の戻り値) からNSFを生成する。
   * assembleResult.origin が loadAddr として使われる。
   * @param {object} headerOpt - songName, artist 等。loadAddr/initAddr/playAddrは省略時 assembleResult から推定
   * @param {object} assembleResult - { bytes, origin, symbols }
   * @param {object} [entryPoints] - { init: 'INIT', play: 'PLAY' } のようなラベル名指定
   * @returns {Uint8Array}
   */
  NSF.buildFromAssembly = function (headerOpt, assembleResult, entryPoints = {}) {
    const opt = Object.assign({}, headerOpt);
    opt.loadAddr = assembleResult.origin;

    const initLabel = entryPoints.init || 'INIT';
    const playLabel = entryPoints.play || 'PLAY';

    opt.initAddr = (assembleResult.symbols[initLabel] !== undefined)
      ? assembleResult.symbols[initLabel]
      : assembleResult.origin;
    opt.playAddr = (assembleResult.symbols[playLabel] !== undefined)
      ? assembleResult.symbols[playLabel]
      : assembleResult.origin;

    return NSF.buildNSF(opt, assembleResult.bytes);
  };

  /**
   * Blob としてダウンロードを開始する
   * @param {Uint8Array} bytes
   * @param {string} filename
   */
  NSF.download = function (bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
})(window);
