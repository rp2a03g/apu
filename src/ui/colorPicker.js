/*
 * 汎用カラーピッカー(ポップオーバー)
 * MML.UI.ColorPicker.open(anchorEl, currentColor, onPick, onReset) -> anchorElの直下に
 *   プリセットスウォッチ+ネイティブ<input type=color>+「既定色に戻す」ボタンを表示する。
 *   外側クリックで自動的に閉じる。1インスタンスのみ存在するシングルトン。
 * MML.UI.ColorPicker.close() -> 明示的に閉じる
 *
 * 元々は鍵盤表示のチャンネル色編集(src/ui/keyboard.js)専用だったが、MMLエディタの
 * カラー設定(src/ui/editorSettings.js)でも同じUIが必要になったため共通モジュールへ切り出した。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  const T = (key, params) => MML.I18n.t(key, params);

  const PALETTE = [
    '#ff4466', '#ff8800', '#ffcc00', '#aaff33', '#33dd66', '#00cc99',
    '#00ccff', '#3388ff', '#7755ff', '#cc55ff', '#ff55aa', '#ffffff',
    '#ff8888', '#ffbb66', '#eedd55', '#88dd88', '#66cccc', '#88bbff',
    '#aaaacc', '#dd8899', '#886644', '#888888', '#444455', '#000000',
  ];

  let _el = null;
  let _outsideHandler = null;

  function close() {
    if (_el) { _el.remove(); _el = null; }
    if (_outsideHandler) {
      document.removeEventListener('mousedown', _outsideHandler, true);
      _outsideHandler = null;
    }
  }

  function open(anchorEl, currentColor, onPick, onReset) {
    close();
    const pop = document.createElement('div');
    pop.className = 'kbd-color-picker';
    const cur = (currentColor || '').toLowerCase();
    pop.innerHTML = PALETTE.map(c =>
      `<span class="kbd-color-swatch${c.toLowerCase() === cur ? ' kbd-color-swatch--selected' : ''}" ` +
      `style="background:${c}" data-color="${c}" title="${c}"></span>`
    ).join('') +
      // プリセット一覧を広げる代わりに、OSネイティブのカラーピッカー(無段階スペクトラム)を
      // 呼び出す小さな1マスを追加する。画面を圧迫せずに「もっと多くの色」を選べるようにする。
      `<span class="kbd-color-swatch kbd-color-more" title="${T('もっと選ぶ...')}">` +
      `<input type="color" class="kbd-color-native" value="${/^#[0-9a-f]{6}$/i.test(currentColor || '') ? currentColor : '#ffffff'}"></span>` +
      `<button type="button" class="kbd-color-reset">${T('既定色に戻す')}</button>`;
    document.body.appendChild(pop);

    const rect = anchorEl.getBoundingClientRect();
    pop.style.left = Math.round(rect.left) + 'px';
    pop.style.top = Math.round(rect.bottom + 4) + 'px';
    const pr = pop.getBoundingClientRect();
    if (pr.right > window.innerWidth) pop.style.left = Math.max(0, window.innerWidth - pr.width - 4) + 'px';
    if (pr.bottom > window.innerHeight) pop.style.top = Math.max(0, rect.top - pr.height - 4) + 'px';

    pop.querySelectorAll('.kbd-color-swatch[data-color]').forEach((sw) => {
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(sw.getAttribute('data-color'));
        close();
      });
    });
    pop.querySelector('.kbd-color-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      onReset();
      close();
    });

    // 「もっと選ぶ」マス: OSネイティブのカラーピッカーを開く。ドラッグ中は
    // input イベントでリアルタイムに反映し、確定(change)でポップオーバーを閉じる。
    const nativeInput = pop.querySelector('.kbd-color-native');
    nativeInput.addEventListener('input', () => onPick(nativeInput.value));
    nativeInput.addEventListener('change', (e) => {
      e.stopPropagation();
      onPick(nativeInput.value);
      close();
    });

    _el = pop;
    _outsideHandler = (e) => { if (!pop.contains(e.target)) close(); };
    // 開いたクリック自体で即座に閉じてしまわないよう、次のイベントループで登録する
    setTimeout(() => document.addEventListener('mousedown', _outsideHandler, true), 0);
  }

  UI.ColorPicker = { open, close, PALETTE };
})(window);
