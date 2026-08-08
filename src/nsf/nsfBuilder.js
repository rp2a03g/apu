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
