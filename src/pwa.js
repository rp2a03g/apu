/*
 * PWA の入口: manifest の取り付けと Service Worker の登録 (2026-09-23)
 *
 * ■ http(s) で開いたときだけ動く
 *   file:// では <link rel="manifest"> を置くだけでコンソールに CORS エラーが出る(実測)し、
 *   Service Worker はそもそも登録できない。file:// は元々オフラインなので何も要らない。
 *   静的に書かず、ここで判定してから <link> を足す。
 *
 * ■ インストールの勧誘は出さない(2026-09-23 ユーザー判断: まだ早い)
 *   Chrome(Android)はインストール条件が揃うと自動でバナーを出す。beforeinstallprompt を
 *   preventDefault() すると自動のバナーは出ず、ブラウザのメニューからだけ入れられる状態になる。
 *   勧誘を出す段階になったら、ここで event を控えておいてボタンから prompt() を呼ぶ。
 *
 * ■ オフライン起動の中身は sw.js(ネットワーク優先、失敗時キャッシュ)を参照
 */
(function (global) {
  'use strict';
  const proto = (global.location && global.location.protocol) || '';
  if (proto !== 'http:' && proto !== 'https:') return;

  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = 'manifest.json';
  document.head.appendChild(link);

  global.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); });

  if ('serviceWorker' in navigator) {
    global.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch((e) => {
        // localhost 以外の平文 http などで登録できないだけ。オンラインの動作には影響しない
        console.warn('Service Worker を登録できませんでした:', e && e.message ? e.message : e);
      });
    });
  }
})(window);
