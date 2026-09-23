/*
 * スマホ/タブレット向けの画面の並べ方 (MML.UI.MobileShell、2026-09-23)
 *
 * ■ 方針: デスクトップの DOM・JS は触らず、並べ方だけ変える
 *   端末判定(src/device.js MML.Device.uiMode())が 'mobile' のとき <html class="ui-mobile"> が付き、
 *   style.css の末尾の規則でフローティングウィンドウを「1画面に1枚、画面いっぱい」に変える。
 *   ここでやるのは次の3つだけ。
 *     1. ミニ操作窓の中身(src/ui/miniTransport.js。ファイルを開く/⏮▶⏭■/曲名/シークバー/chミュート)を
 *        画面上部に常設する(小窓へ移すのと同じ仕組みで、本体の要素をそのまま置き直す)
 *     2. 画面下にウィンドウ切替のタブバーを作る(ラベルは各ウィンドウの見出し)
 *     3. 「PC表示」への切替ボタン(逆にタッチ端末のPC表示には「スマホ表示」ボタン)
 *   再生・曲送り・ミュート・シークの実体はデスクトップと同じ関数(keyboardDisplay.onTransport 等)。
 *
 * ■ 切替の記憶
 *   ?ui=mobile / ?ui=desktop で上書きでき、選んだ方を localStorage('mml_ui') に覚える。
 *   iPad の Safari は Mac の UA を名乗るので UA では判定できず、pointer/タッチ点で見る(device.js)。
 *
 * ■ main.js が ensureKeyboardWindowOpen() 等でウィンドウを「表示」にしたら、そのタブへ切り替える
 *   (インラインの display を MutationObserver で見張る。デスクトップ側の関数は呼び方を変えない)
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};
  const T = (k, p) => (MML.I18n ? MML.I18n.t(k, p) : k);
  const Device = MML.Device;

  const DEFAULT_WINDOW = 'win-keyboard';
  let tabsEl = null;
  let activeId = null;

  // タブの並び: 鍵盤表示(プレイヤー)→MMLエディタ→残りは文書の順
  const TAB_ORDER = ['win-keyboard', 'win-mml'];
  function windows() {
    // ピアノロール別ウィンドウは「ロールの置き場=別ウィンドウ」の設定のときだけ意味がある
    const all = Array.from(document.querySelectorAll('.float-window')).filter((w) => w.id !== 'win-pianoroll');
    const rank = (w) => { const i = TAB_ORDER.indexOf(w.id); return i < 0 ? TAB_ORDER.length : i; };
    return all.sort((a, b) => rank(a) - rank(b));
  }
  function labelOf(win) {
    // 見出しの文字。鍵盤表示は keyboard.js が見出しを作り直すので、ツールバーのボタンの aria-label から取る
    const span = win.querySelector('.float-window-header > span');
    const text = span ? span.textContent.trim() : '';
    if (text) return text;
    const btn = document.querySelector('.toggle-btn[data-target="' + win.id + '"]');
    return (btn && (btn.getAttribute('aria-label') || btn.title)) || win.id;
  }

  function activate(id) {
    if (!id || activeId === id) return;
    activeId = id;
    for (const w of windows()) w.classList.toggle('m-active', w.id === id);
    if (tabsEl) {
      for (const b of tabsEl.querySelectorAll('.m-tab')) {
        const on = b.dataset.target === id;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      const cur = tabsEl.querySelector('.m-tab.is-active');
      if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ } }
    }
    // ロール/鍵盤は自分の大きさを見て描くので、表示に切り替えたら測り直させる
    try { global.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
  }

  function buildTabs() {
    tabsEl = document.createElement('nav');
    tabsEl.className = 'm-tabs';
    tabsEl.setAttribute('role', 'tablist');
    for (const w of windows()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-tab';
      b.dataset.target = w.id;
      b.setAttribute('role', 'tab');
      b.textContent = labelOf(w);
      b.addEventListener('click', () => activate(w.id));
      tabsEl.appendChild(b);
    }
    document.body.appendChild(tabsEl);
  }

  // main.js がウィンドウを開いたら(インラインの display が none 以外になったら)そのタブへ
  function watchWindowOpens() {
    if (!('MutationObserver' in global)) return;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const w = m.target;
        if (!w.classList || !w.classList.contains('float-window') || w.id === 'win-pianoroll') continue;
        const was = m.oldValue || '';
        const nowShown = w.style.display !== 'none';
        const wasShown = !/display:\s*none/.test(was);
        if (nowShown && !wasShown) activate(w.id);
      }
    });
    for (const w of windows()) obs.observe(w, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
  }

  function switchButton(toMode) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = toMode === 'desktop' ? 'm-switch' : 'icon-btn icon-btn-text m-switch-to-mobile';
    b.textContent = toMode === 'desktop' ? 'PC表示' : 'スマホ表示';
    b.title = toMode === 'desktop' ? 'PC向けの画面に切り替える' : 'スマホ向けの画面に切り替える';
    b.addEventListener('click', () => {
      if (Device && Device.setUiMode) Device.setUiMode(toMode);
      // ?ui= を消して開き直す(付けたままだと URL の指定が勝ち続ける)
      const u = new URL(location.href);
      u.searchParams.delete('ui');
      location.replace(u.toString());
    });
    return b;
  }

  function initMobile() {
    const header = document.querySelector('header');
    // 上の帯: 見出し + PC表示ボタン(言語選択は i18nDom が header に足すのでそのまま並ぶ)
    if (header) {
      const bar = document.createElement('div');
      bar.className = 'm-topbar';
      const title = document.createElement('span');
      title.className = 'm-title';
      title.textContent = 'Sound Emulation Foundry';
      title.setAttribute('data-i18n-skip', '');
      bar.appendChild(title);
      bar.appendChild(switchButton('desktop'));
      header.appendChild(bar);
    }
    // 再生操作(ミニ操作窓の中身)を header の直後に常設
    const player = document.createElement('div');
    player.id = 'mobilePlayer';
    if (header && header.parentNode) header.parentNode.insertBefore(player, header.nextSibling);
    else document.body.insertBefore(player, document.body.firstChild);
    if (MML.UI.MiniTransport && MML.UI.MiniTransport.dock) MML.UI.MiniTransport.dock(player);

    buildTabs();
    watchWindowOpens();
    // 最初は鍵盤表示(プレイヤー)。無ければ最初のウィンドウ
    const first = document.getElementById(DEFAULT_WINDOW) || windows()[0];
    if (first) activate(first.id);
  }

  function initDesktopOnTouch() {
    // タッチ端末でPC表示を選んでいるとき、戻れるようにツールバーの末尾へ「スマホ表示」を出す
    const bar = document.getElementById('iconToolbar');
    if (bar) bar.appendChild(switchButton('mobile'));
  }

  function init() {
    if (!Device || !Device.uiMode) return;
    if (Device.uiMode() === 'mobile') initMobile();
    else if (Device.isTouch()) initDesktopOnTouch();
  }

  MML.UI.MobileShell = { init, activate };

  // main.js の初期化(ミニ操作窓の生成を含む)が終わってから
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
