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

  let cached = null;
  function isTouch() {
    if (cached !== null) return cached;
    const nav = global.navigator || {};
    const ua = nav.userAgent || '';
    cached = /iPhone|iPad|iPod|Android/i.test(ua)
      || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
    return cached;
  }

  function setFileAccept(el, accept) {
    if (!el) return;
    if (isTouch()) { el.removeAttribute('accept'); return; }
    el.accept = accept;
  }

  function stripStaticAccepts() {
    if (!isTouch() || typeof document === 'undefined') return;
    document.querySelectorAll('input[type="file"][accept]').forEach((el) => el.removeAttribute('accept'));
  }

  MML.Device = { isTouch, setFileAccept };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stripStaticAccepts);
    else stripStaticAccepts();
  }
})(typeof window !== 'undefined' ? window : globalThis);
