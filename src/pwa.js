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

  // ?debug=ms の表示(main.js)や console から見られる状態。{cached,total,missing} は SW の返事
  const MML = global.MML = global.MML || {};
  const PWA = MML.PWA = { status: 'unsupported', precache: null };
  function setStatus(s, extra) {
    PWA.status = s;
    if (extra) PWA.precache = extra;
    try { global.dispatchEvent(new CustomEvent('mml-pwa-status', { detail: { status: s, precache: PWA.precache } })); } catch (e) { /* ignore */ }
  }

  if ('serviceWorker' in navigator) {
    PWA.status = 'registering';
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.type === 'precache-done') setStatus(d.missing && d.missing.length ? 'incomplete' : 'ready', d);
    });
    global.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).then(async (reg) => {
        setStatus('registered');
        // 登録(初回は install の先読み)が終わったら、欠けている分を補うよう頼む。
        // 初回訪問はページが SW に握られていないので、ここで頼まないと歯抜けが残り得る
        await navigator.serviceWorker.ready;
        const sw = navigator.serviceWorker.controller || reg.active;
        if (sw) { setStatus('precaching'); sw.postMessage({ type: 'precache' }); }
      }).catch((e) => {
        // localhost 以外の平文 http などで登録できないだけ。オンラインの動作には影響しない
        setStatus('failed');
        console.warn('Service Worker を登録できませんでした:', e && e.message ? e.message : e);
      });
    });
  }
})(window);
