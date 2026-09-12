/*
 * MMLエディタ(textarea)のキー操作(2026-09-08)
 *
 *   MML.UI.EditorKeys.init(textarea, { playPause })
 *
 * ■ Tab
 *   ブラウザの textarea は Tab でフォーカスが次の要素へ移る(ウィンドウ化しているので隣の
 *   ウィンドウへ飛ぶ)。ここで Tab を横取りしてタブ文字を入れる。
 *   ・選択が複数行にまたがるときは各行の先頭にタブを足す(Shift+Tab で1つ外す)
 *   ・1行内なら Tab=タブ文字挿入、Shift+Tab=直前のタブ文字(無ければ行頭の空白1つ)を消す
 *   ・Ctrl/Alt を押しながらの Tab は触らない(OS/ブラウザのタブ切り替え)
 *   ・キーボードだけでフォーカスを外したいときは Esc → Tab(Esc の直後の Tab は素通し)
 *   挿入は document.execCommand('insertText') を優先する(Ctrl+Z で戻せる。使えない環境では
 *   setRangeText + input イベント)
 *
 * ■ F5
 *   エディタにフォーカスがあるあいだは F5 を再生/一時停止ボタン(btnMmlCapture)に割り当てる。
 *   既定の F5(ページ再読み込み)は未保存の MML を消してしまうので止める。
 *
 * ■ Ctrl+S / Ctrl+Shift+S
 *   保存 / 名前を付けて保存(opts.save(saveAs))。既定の「ページを保存」は止める。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};

  const TAB = '\t';

  // undo 履歴に残る形で選択範囲を text に置き換える
  function replaceSelection(ta, text, selStart, selEnd) {
    ta.setSelectionRange(selStart, selEnd);
    let ok = false;
    try { ok = document.execCommand && document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      ta.setRangeText(text, selStart, selEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function handleTab(ta, shift) {
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const multiLine = v.slice(s, e).indexOf('\n') >= 0;
    if (multiLine) {
      // 選択範囲が含む行をまとめてインデント/アンインデント
      let lineEnd = v.indexOf('\n', e - 1);
      if (e > 0 && v[e - 1] === '\n') lineEnd = e - 1; // 選択末尾がちょうど行末なら次の行は含めない
      if (lineEnd < 0) lineEnd = v.length;
      const block = v.slice(lineStart, lineEnd);
      const lines = block.split('\n');
      const out = lines.map(l => shift ? l.replace(/^(\t| {1,2})/, '') : (l.length ? TAB + l : l)).join('\n');
      if (out === block) return;
      replaceSelection(ta, out, lineStart, lineEnd);
      ta.setSelectionRange(lineStart, lineStart + out.length);
      return;
    }
    if (shift) {
      // 直前のタブ(無ければ行頭の空白1つ)を消す
      if (s > lineStart && v[s - 1] === TAB) replaceSelection(ta, '', s - 1, e);
      else if (v[lineStart] === TAB || v[lineStart] === ' ') { replaceSelection(ta, '', lineStart, lineStart + 1); }
      return;
    }
    replaceSelection(ta, TAB, s, e);
  }

  function init(textarea, opts) {
    opts = opts || {};
    let escArmed = false; // Esc 直後の Tab は素通し(キーボードだけでフォーカスを外す道)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { escArmed = true; return; }
      if (e.key === 'Tab') {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (escArmed) { escArmed = false; return; }
        e.preventDefault();
        handleTab(textarea, e.shiftKey);
        return;
      }
      escArmed = false;
      if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        if (typeof opts.playPause === 'function') opts.playPause();
        return;
      }
      // Ctrl+S = 保存。既定のブラウザ「名前を付けてページを保存」は邪魔なので止める。
      // 外部エディタと同じ指が使えないと、外部ファイルと往復する運用で毎回つまずく
      if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        if (typeof opts.save === 'function') opts.save(e.shiftKey); // Shift+Ctrl+S = 名前を付けて保存
      }
    });
  }

  MML.UI.EditorKeys = { init };
})(window);
