/*
 * Service Worker: オフライン起動 (2026-09-23)
 *
 * ■ 方針: ネットワーク優先、失敗したらキャッシュ
 *   オンラインのときの動きは Service Worker が無いときと同じ(常にサーバーの最新を取る。
 *   ブラウザの HTTP キャッシュはこれまでどおり効く)。取れなかったとき(機内モード等)だけ
 *   キャッシュから返す。「キャッシュ優先」にしないのは、index.html だけ新しくて JS が古い、
 *   という版の混在を避けるため(ファイル名にハッシュを付けていないので混在すると壊れる)。
 *   取れた応答は毎回キャッシュへ入れ直すので、一度オンラインで開けば以後はその版でオフライン起動できる。
 *
 * ■ 先読み(install 時 + ページからの依頼)
 *   index.html を取り、その中の <script src> と <link href> を全部キャッシュする。
 *   ROADMAP の「キャッシュリストは index.html の script タグ群と同期させること」を、
 *   リストを手で持たずに index.html 自身から作ることで満たす。1本でも取れなければ
 *   install を失敗させず(次の起動で取り直す)、取れた分だけ入れる。
 *   ★初回訪問はまだ SW がページを握っていないので、この先読みだけが頼り。スマホで途中で
 *     切られると歯抜けのまま残り「起動はするがボタンが効かない」になる(2026-09-23 実機)。
 *     対策: (1) 先読みはブラウザの HTTP キャッシュを使う(ページが今読んだばかりのファイルなので
 *     一瞬で済む)。(2) ページ側(src/pwa.js)が登録後に {type:'precache'} を送り、欠けている分だけ
 *     補う(毎回の訪問で歯抜けを埋める)。返事 {type:'precache-done', cached, total, missing} を
 *     ページが受け取って ?debug=ms の表示に出す。
 *
 * ■ 対象外
 *   GET 以外、別オリジン(?nsf= で外部から曲を取る urlLoad.js の fetch を含む)、
 *   Blob/data URL(Worker バンドル・AudioWorklet)。file:// では Service Worker 自体が登録されない。
 *
 * ■ 版
 *   キャッシュの中身は常に最後にオンラインで取れたものなので、アプリの版が上がっても
 *   ここを変える必要は無い。この SW 自体の作りを変えたときだけ CACHE の名前を上げる
 *   (古いキャッシュは activate で捨てる)。
 */
'use strict';

const CACHE = 'sef-offline-1';
const INDEX = './index.html';
const CORE = [INDEX, './manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const NETWORK_TIMEOUT_MS = 8000; // 回線が生きているのに遅いとき、いつまでも待たずにキャッシュへ落ちる

function assetsFromHtml(html) {
  const out = new Set();
  const re = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (/^(https?:)?\/\//i.test(u) || /^(data|blob):/i.test(u)) continue; // 外部・埋め込みは対象外
    out.add(u);
  }
  return Array.from(out);
}

async function cacheOne(cache, url, onlyIfMissing) {
  try {
    if (onlyIfMissing && await cache.match(url)) return true;
    // HTTP キャッシュを使う(no-cache にしない)。ページが直前に読んだファイルなら通信無しで済む
    const res = await fetch(new Request(url));
    if (res && res.ok) { await cache.put(url, res); return true; }
  } catch (e) { /* 取れなかった分は次の機会に */ }
  return false;
}

// index.html と、その中で参照している資産を全部キャッシュへ。戻り値は {cached, total, missing}
async function precache(onlyIfMissing) {
  const cache = await caches.open(CACHE);
  let list = CORE.slice();
  try {
    const res = await fetch(new Request(INDEX, { cache: 'no-cache' }));
    if (res && res.ok) {
      const html = await res.clone().text();
      await cache.put(INDEX, res);
      list = list.concat(assetsFromHtml(html));
    }
  } catch (e) {
    // index が取れない(オフライン)ならキャッシュ済みの index から一覧を作る
    const hit = await cache.match(INDEX);
    if (hit) list = list.concat(assetsFromHtml(await hit.text()));
  }
  list = Array.from(new Set(list));
  const missing = [];
  // 同時接続を増やしすぎない(11MB 前後・約120本)
  const queue = list.filter((u) => u !== INDEX);
  const workers = [];
  for (let i = 0; i < 6; i++) {
    workers.push((async () => {
      while (queue.length) { const u = queue.shift(); if (!(await cacheOne(cache, u, onlyIfMissing))) missing.push(u); }
    })());
  }
  await Promise.all(workers);
  return { cached: list.length - missing.length, total: list.length, missing };
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precache(false);
    await self.skipWaiting();
  })());
});

// ページからの依頼: 欠けている分を補って結果を返す(src/pwa.js)
self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'precache') return;
  event.waitUntil((async () => {
    let result;
    try { result = await precache(true); } catch (e) { result = { cached: 0, total: 0, missing: [], error: String(e && e.message || e) }; }
    result.type = 'precache-done';
    try {
      if (event.source && event.source.postMessage) event.source.postMessage(result);
      else { const cs = await self.clients.matchAll(); for (const c of cs) c.postMessage(result); }
    } catch (e) { /* ignore */ }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isNav = req.mode === 'navigate';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetchWithTimeout(req);
      if (res && res.ok) {
        // ページ本体はクエリ(?ui= ?nsf= ?debug=)を落として1本に集約する
        cache.put(isNav ? INDEX : req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      const hit = await cache.match(isNav ? INDEX : req, { ignoreSearch: true });
      if (hit) return hit;
      throw e;
    }
  })());
});
