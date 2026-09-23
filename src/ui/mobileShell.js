/*
 * スマホ/タブレット向けの画面の並べ方 (MML.UI.MobileShell、2026-09-23)
 *
 * ■ 方針: デスクトップの DOM・JS は触らず、並べ方だけ変える
 *   端末判定(src/device.js MML.Device.uiMode())が 'mobile' のとき <html class="ui-mobile"> が付き、
 *   style.css の末尾の規則でフローティングウィンドウを「1画面に1枚、画面いっぱい」に変える。
 *   ここでやるのは次のことだけ。
 *     1. 画面下にウィンドウ切替のタブバーを作る(ラベルは各ウィンドウの見出し)。
 *        鍵盤表示だけは「チャンネル」と「ピアノロール」の2タブに分け、同じウィンドウの見せ方を切り替える
 *     2. 鍵盤表示の見出し行へ、ミニ操作窓のシークバー行と「⋯」(音量/速度の出し入れ)を足す。
 *        再生ボタン群は鍵盤表示の見出し行にあるものを CSS で大きくして使う(全タブ共通の帯は置かない)
 *     3. チャンネル一覧の2本指ピンチで一覧の拡大率を変える(行の大きさ/幅。一覧は横スクロール)
 *     4. 「PC表示」への切替ボタン(逆にタッチ端末のPC表示には「スマホ表示」ボタン)
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

  const KBD = 'win-keyboard';
  const KBD_VIEW_KEY = 'mml_mobileKbdView';     // 'list' | 'roll'
  const LIST_ZOOM_KEY = 'mml_mobileListZoom';    // チャンネル一覧の拡大率
  let tabsEl = null;
  let activeId = null;
  let kbdView = 'roll';

  // タブの並び: 鍵盤表示(チャンネル/ピアノロールの2つ)→MMLエディタ→残りは文書の順
  const TAB_ORDER = [KBD, 'win-mml'];
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

  function applyKbdView(view) {
    if (view !== 'list' && view !== 'roll') return;
    kbdView = view;
    const win = document.getElementById(KBD);
    if (win) {
      win.classList.toggle('m-view-list', view === 'list');
      win.classList.toggle('m-view-roll', view === 'roll');
    }
    try { localStorage.setItem(KBD_VIEW_KEY, view); } catch (e) { /* ignore */ }
  }

  // id: ウィンドウの id。view: 鍵盤表示のときだけ 'list' | 'roll'(省略=今の見せ方のまま)
  function activate(id, view) {
    if (!id) return;
    if (id === KBD && view) applyKbdView(view);
    const same = activeId === id;
    activeId = id;
    if (!same) for (const w of windows()) w.classList.toggle('m-active', w.id === id);
    if (tabsEl) {
      for (const b of tabsEl.querySelectorAll('.m-tab')) {
        const on = b.dataset.target === id && (!b.dataset.view || b.dataset.view === kbdView);
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
    const add = (target, label, view) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-tab';
      b.dataset.target = target;
      if (view) b.dataset.view = view;
      b.setAttribute('role', 'tab');
      b.textContent = label;
      b.addEventListener('click', () => activate(target, view));
      tabsEl.appendChild(b);
    };
    for (const w of windows()) {
      if (w.id === KBD) {
        add(KBD, T('チャンネル'), 'list');
        add(KBD, T('ピアノロール'), 'roll');
      } else {
        add(w.id, labelOf(w));
      }
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
    b.textContent = toMode === 'desktop' ? T('PC表示') : T('スマホ表示');
    b.title = toMode === 'desktop' ? T('PC向けの画面に切り替える') : T('スマホ向けの画面に切り替える');
    b.addEventListener('click', () => {
      if (Device && Device.setUiMode) Device.setUiMode(toMode);
      // ?ui= を消して開き直す(付けたままだと URL の指定が勝ち続ける)
      const u = new URL(location.href);
      u.searchParams.delete('ui');
      location.replace(u.toString());
    });
    return b;
  }

  // 鍵盤表示の見出し行: シークバー(ミニ操作窓の行を借りる)と「⋯」(音量/速度の出し入れ)を足す。
  // 並びは style.css の order で決める
  function initKeyboardHeader() {
    const win = document.getElementById(KBD);
    const header = win && win.querySelector('.float-window-header');
    if (!header) return;
    const extras = document.createElement('button');
    extras.type = 'button';
    extras.className = 'm-extras-btn';
    extras.textContent = '⋯'; // ⋯
    extras.title = T('音量と速度');
    extras.setAttribute('aria-label', T('音量と速度'));
    extras.addEventListener('click', () => {
      const on = !win.classList.contains('m-extras');
      win.classList.toggle('m-extras', on);
      extras.classList.toggle('is-active', on);
    });
    header.appendChild(extras);
    if (MML.UI.MiniTransport && MML.UI.MiniTransport.dockSeekRow) {
      const row = MML.UI.MiniTransport.dockSeekRow(header);
      if (row) row.classList.add('m-seek-row');
    }
  }

  // チャンネル一覧の2本指ピンチ = 一覧の拡大率(行の高さ・列の幅がまとめて変わる。はみ出た分は横スクロール)。
  // 一覧は1本指の縦スクロールを残したいので pointer ではなく touch イベントで2本指のときだけ横取りする
  // (touchmove の preventDefault でページ自体の拡大を止める。passive:false が要る)
  function initListPinch() {
    const win = document.getElementById(KBD);
    if (!win) return;
    let zoom = 1;
    try { const v = parseFloat(localStorage.getItem(LIST_ZOOM_KEY)); if (Number.isFinite(v)) zoom = v; } catch (e) { /* ignore */ }
    const apply = (z) => { zoom = Math.max(0.6, Math.min(2, z)); win.style.setProperty('--m-lz', zoom.toFixed(3)); };
    apply(zoom);
    let start = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const inList = (el) => win.classList.contains('m-view-list') && el && el.closest && el.closest('.kbd-left');
    win.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && inList(e.target)) start = { d: dist(e.touches), z: zoom };
    }, { passive: true });
    win.addEventListener('touchmove', (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      if (start.d > 20) apply(start.z * d / start.d);
    }, { passive: false });
    const end = (e) => {
      if (!start || e.touches.length >= 2) return;
      start = null;
      try { localStorage.setItem(LIST_ZOOM_KEY, zoom.toFixed(3)); } catch (err) { /* ignore */ }
    };
    win.addEventListener('touchend', end);
    win.addEventListener('touchcancel', end);
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
    let view = 'roll';
    try { const v = localStorage.getItem(KBD_VIEW_KEY); if (v === 'list' || v === 'roll') view = v; } catch (e) { /* ignore */ }
    applyKbdView(view);
    initKeyboardHeader();
    initListPinch();
    buildTabs();
    watchWindowOpens();
    // 最初は鍵盤表示(プレイヤー)。無ければ最初のウィンドウ
    const first = document.getElementById(KBD) || windows()[0];
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
