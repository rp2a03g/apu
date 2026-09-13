/*
 * MMLエディタの行番号ガター+カーソル位置表示 (MML.UI.EditorLineInfo)
 *
 * 動機: コンパイルエラーは「[Line 123] …」と行番号で場所を示すが、エディタ側に行番号が
 * 無く、その行を探す手段が無かった。次の2モードを「行番号」チェックボックスで切り替える:
 *   ON : エディタ左端に行番号ガターを出す(カーソル行の番号は太字+本文色で強調)
 *   OFF: ガターを出さず、エディタ右下に「行 N, 列 M」のバッジでカーソル位置を出す
 * どちらのモードでも gotoLine(n) でその行の先頭へカーソルを移してスクロールできる
 * (main.jsがエラーログの [Line N] をクリック可能にして呼ぶ)。
 *
 * 行番号の描画はオーバーレイ(src/mml/syntaxHighlight.jsが作る .mml-line)にCSSカウンタで
 * 付ける(::before、src/css/style.css の .mml-editor--linenum 参照)。折り返しのある行でも
 * 論理行の先頭にだけ番号が付き、textarea側とは padding-left を同じぶん広げるだけで字送りが
 * 一致する。★.mml-line に position:relative を付けてはいけない: 子spanのoffsetTopが
 * 行内相対値になり、追随スクロール(main.js ensureScrollGeomCache)が壊れる。番号は
 * インラインブロック+負のマージンで「幅0」に見せてパディング領域へはみ出させている。
 *
 * ガター幅は行数の桁数から決めて --mml-gutter-w に入れる(CSS側で padding/帯幅/番号幅が
 * 全てこの1変数から派生する)。桁数が変わるのは稀なので、変わった時だけ書き換える。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => MML.I18n.t(key, params);

  const STORAGE_KEY = 'mml_lineNumbers';
  const CLASS_ON = 'mml-editor--linenum';
  const CLASS_CURSOR = 'mml-line--cursor';
  const CLASS_PLAYING = 'mml-line--playing'; // 追尾チャンネルが今鳴っている行(main.js が毎更新で呼ぶ)

  let textarea = null;
  let overlay = null;
  let editorEl = null;
  let toggleEl = null;
  let posEl = null;
  let onLayoutChange = null;

  let enabled = true;
  let gutterDigits = 0;
  let cursorLineEl = null; // 現在 CLASS_CURSOR を付けている .mml-line
  let playingLineEl = null; // 同 CLASS_PLAYING(追尾チャンネルの現在行)
  let lastLine = -1;
  let lastCol = -1;

  function loadPref() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  }
  function savePref(v) {
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function countLines(text) {
    let n = 1;
    let i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
    return n;
  }

  // 桁数からガター幅を決める(最低2桁。等幅フォント前提で ch 単位)。
  // 変数はエディタ要素に置く(:rootではなく)ので他のエディタには影響しない
  function updateGutterWidth(force) {
    const digits = Math.max(2, String(countLines(textarea.value)).length);
    if (!force && digits === gutterDigits) return;
    gutterDigits = digits;
    editorEl.style.setProperty('--mml-gutter-w', `calc(${digits}ch + 14px)`);
    if (onLayoutChange) onLayoutChange();
  }

  // selectionStart から (行, 列) を求める。行・列とも1始まり
  function cursorLineCol() {
    const pos = textarea.selectionStart || 0;
    const head = textarea.value.slice(0, pos);
    const nl = head.lastIndexOf('\n');
    return { line: countLines(head), col: pos - nl };
  }

  function setCursorMarker(line) {
    if (cursorLineEl) {
      cursorLineEl.classList.remove(CLASS_CURSOR);
      cursorLineEl = null;
    }
    if (!enabled) return;
    const el = overlay.children[line - 1];
    if (el) {
      el.classList.add(CLASS_CURSOR);
      cursorLineEl = el;
    }
  }

  // 追尾チャンネルの現在行を強調する(2026-09-09、ユーザー要望「追尾と行番号有効時、行番号も追尾」)。
  // 引数はハイライト中の span(main.js の followEl)。その論理行(.mml-line)へ印を移す。
  // null で消す。行番号OFFのときはガター自体が出ないので何もしない
  function setPlayingLineEl(el) {
    const lineEl = (enabled && el && el.closest) ? el.closest('.mml-line') : null;
    if (lineEl === playingLineEl) return;
    if (playingLineEl) playingLineEl.classList.remove(CLASS_PLAYING);
    playingLineEl = lineEl;
    if (playingLineEl) playingLineEl.classList.add(CLASS_PLAYING);
  }

  function updateCursor(force) {
    const { line, col } = cursorLineCol();
    if (!force && line === lastLine && col === lastCol) return;
    lastLine = line;
    lastCol = col;
    if (posEl) posEl.textContent = T('行 {line}, 列 {col}', { line, col });
    setCursorMarker(line);
  }

  // 「行 {line}, 列 {col}」は引数付きの文言なので、表示言語を切り替えたら書き直す
  // (起動時の言語確定でも呼ばれうるので、エディタへの接続前は何もしない)
  if (MML.I18n) MML.I18n.onChange(() => { if (textarea) updateCursor(true); });

  function applyMode() {
    editorEl.classList.toggle(CLASS_ON, enabled);
    if (posEl) posEl.hidden = enabled;
    if (toggleEl) toggleEl.checked = enabled;
    if (enabled) updateGutterWidth(true);
    else if (onLayoutChange) onLayoutChange();
    // モード切替で行の折り返し位置が変わりうるので、オーバーレイのスクロール位置を合わせ直す
    overlay.scrollTop = textarea.scrollTop;
    overlay.scrollLeft = textarea.scrollLeft;
    updateCursor(true);
  }

  // 指定行(1始まり)の先頭へカーソルを移し、その行が見えるようスクロールしてフォーカスする
  function gotoLine(line) {
    const text = textarea.value;
    const total = countLines(text);
    line = Math.max(1, Math.min(total, Math.floor(line) || 1));
    let pos = 0;
    for (let n = 1; n < line; n++) {
      const nl = text.indexOf('\n', pos);
      if (nl < 0) break;
      pos = nl + 1;
    }
    // 行末(改行の手前)までを選択して、どの行が対象かひと目で分かるようにする
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    textarea.focus();
    textarea.setSelectionRange(pos, end);
    // オーバーレイの該当行の位置から縦中央に来るscrollTopを求める(textareaとオーバーレイは
    // 同じpadding/フォント/折り返しなので位置が一致する)
    const lineEl = overlay.children[line - 1];
    if (lineEl) {
      const top = lineEl.offsetTop + lineEl.offsetHeight / 2 - textarea.clientHeight / 2;
      textarea.scrollTop = Math.max(0, top);
      overlay.scrollTop = textarea.scrollTop;
    }
    updateCursor(true);
  }

  UI.EditorLineInfo = {
    setPlayingLineEl,
    /*
     * opts: { textarea, overlay, editorEl, toggleEl, posEl, onLayoutChange }
     *   onLayoutChange: ガター幅/表示モードが変わり折り返し位置がずれうる時に呼ぶ
     *   (main.jsが追随スクロールの位置キャッシュを捨てるために使う)
     */
    init(opts) {
      textarea = opts.textarea;
      overlay = opts.overlay;
      editorEl = opts.editorEl;
      toggleEl = opts.toggleEl || null;
      posEl = opts.posEl || null;
      onLayoutChange = opts.onLayoutChange || null;
      enabled = loadPref();

      if (toggleEl) {
        toggleEl.addEventListener('change', () => {
          enabled = toggleEl.checked;
          savePref(enabled);
          applyMode();
        });
      }
      // カーソル移動の検出: selectionchange(キー/マウス/プログラムによる移動を全て拾う)を
      // 主にし、古いブラウザ向けに keyup/mouseup/input/focus でも拾う
      document.addEventListener('selectionchange', () => {
        if (document.activeElement === textarea) updateCursor(false);
      });
      for (const ev of ['keyup', 'mouseup', 'input', 'focus']) {
        textarea.addEventListener(ev, () => updateCursor(false));
      }
      applyMode();
    },

    // オーバーレイのHTMLが作り直された直後に呼ぶ(行数の桁が変わればガター幅を更新し、
    // 消えたカーソル行の印を付け直す)
    refresh() {
      if (!textarea) return;
      if (enabled) updateGutterWidth(false);
      cursorLineEl = null; // 旧DOMの要素なので参照を捨てる
      playingLineEl = null;
      updateCursor(true);
    },

    gotoLine,
    isEnabled() { return enabled; },
  };
})(window);
