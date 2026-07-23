/*
 * AudioWorklet モジュールローダー
 *
 * mml-worklet-src / nsf-worklet-src という id を持つ <script type="text/plain">
 * タグからワークレットコードを取得し、Blob URL 経由で addModule() に渡す。
 * fetch() を一切使わないため file:// から直接開いても動作する。
 *
 * ワークレットコードを更新した場合は以下を実行して index.html を再生成:
 *   README-worklet-build.txt の PowerShell スクリプトを参照
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  MML.Audio = MML.Audio || {};

  function makeWorkletUrl(scriptId) {
    const el = document.getElementById(scriptId);
    if (!el) throw new Error(`Worklet source element #${scriptId} が見つかりません`);
    const blob = new Blob([el.textContent], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }

  let _mmlReady = null;
  let _nsfReady = null;

  MML.Audio.initMmlWorklet = async function (audioCtx) {
    if (!_mmlReady) {
      const url = makeWorkletUrl('mml-worklet-src');
      _mmlReady = audioCtx.audioWorklet.addModule(url).then(() => URL.revokeObjectURL(url));
    }
    return _mmlReady;
  };

  MML.Audio.initNsfWorklet = async function (audioCtx) {
    if (!_nsfReady) {
      const url = makeWorkletUrl('nsf-worklet-src');
      _nsfReady = audioCtx.audioWorklet.addModule(url).then(() => URL.revokeObjectURL(url));
    }
    return _nsfReady;
  };

  MML.Audio.createMmlNode = function (audioCtx) {
    return new AudioWorkletNode(audioCtx, 'mml-processor', {
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
  };

  MML.Audio.createNsfNode = function (audioCtx) {
    return new AudioWorkletNode(audioCtx, 'nsf-processor', {
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
  };
})(window);
