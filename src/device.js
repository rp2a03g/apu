/*
 * 端末の種類(MML.Device)
 *
 *   MML.Device.isTouch()              スマホ/タブレットなら true
 *   MML.Device.setFileAccept(el, s)   <input type="file"> の accept を PC のときだけ付ける
 *
 * ■ 判定
 *   UA が iPhone / iPad / iPod / Android のどれか、または「Mac を名乗るタッチ端末」。
 *   iPadOS 13 以降の Safari は既定で Mac の UA を返すので、UA だけでは iPad を見分けられない
 *   (navigator.platform が 'MacIntel' で maxTouchPoints > 1 なら iPad)。
 *   PC のタッチ対応ノート(Windows)はここでは PC 扱い(UA で判定するので maxTouchPoints は見ない)。
 *
 * ■ accept を PC 限定にする理由(2026-09-23 iPad 実機)
 *   iOS の Safari は accept に拡張子が並んでいると OS の型(UTI)へ引き当て、合わない項目を
 *   ファイル選択画面でグレーアウトする。.nsf / .spc / .kss などは iOS に登録された型が無いので
 *   引き当てられず、全ファイルが選べなくなる。タッチ端末では accept を付けない
 *   (PC の Windows ダイアログでは拡張子の絞り込みが便利なので残す)。
 *   index.html に静的に書いてある input は読み込み時にここで外す。JS で作る input は
 *   setFileAccept() を通す。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};

  let cachedIos = null, cachedAndroid = null;
  function isIOS() {
    if (cachedIos !== null) return cachedIos;
    const nav = global.navigator || {};
    const ua = nav.userAgent || '';
    cachedIos = /iPhone|iPad|iPod/i.test(ua)
      || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
    return cachedIos;
  }
  function isAndroid() {
    if (cachedAndroid !== null) return cachedAndroid;
    const nav = global.navigator || {};
    cachedAndroid = /Android/i.test(nav.userAgent || '');
    return cachedAndroid;
  }
  function isTouch() { return isIOS() || isAndroid(); }

  function setFileAccept(el, accept) {
    if (!el) return;
    if (isTouch()) { el.removeAttribute('accept'); return; }
    el.accept = accept;
  }

  function stripStaticAccepts() {
    if (!isTouch() || typeof document === 'undefined') return;
    document.querySelectorAll('input[type="file"][accept]').forEach((el) => el.removeAttribute('accept'));
  }

  // 画面の並べ方: 'mobile'(スマホ/タブレット向け、src/ui/mobileShell.js) | 'desktop'。
  // ?ui=mobile / ?ui=desktop で上書きでき(覚える)、無ければ localStorage、無ければタッチ端末かどうか
  const UI_MODE_KEY = 'mml_ui';
  let cachedMode = null;
  function uiMode() {
    if (cachedMode) return cachedMode;
    let m = null;
    try {
      const q = new URLSearchParams(global.location ? global.location.search : '').get('ui');
      if (q === 'mobile' || q === 'desktop') { m = q; setUiMode(q); }
    } catch (e) { /* ignore */ }
    if (!m) { try { m = localStorage.getItem(UI_MODE_KEY); } catch (e) { /* ignore */ } }
    if (m !== 'mobile' && m !== 'desktop') m = isTouch() ? 'mobile' : 'desktop';
    cachedMode = m;
    return m;
  }
  function setUiMode(m) {
    try { localStorage.setItem(UI_MODE_KEY, m); } catch (e) { /* ignore */ }
  }

  MML.Device = { isTouch, isIOS, isAndroid, setFileAccept, uiMode, setUiMode };
  // CSS の切替はできるだけ早く(ウィンドウの初期配置より前に)クラスを付けて済ませる
  if (typeof document !== 'undefined' && document.documentElement && uiMode() === 'mobile') {
    document.documentElement.classList.add('ui-mobile');
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stripStaticAccepts);
    else stripStaticAccepts();
  }
})(typeof window !== 'undefined' ? window : globalThis);
