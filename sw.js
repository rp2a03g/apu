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
 * ■ 先読み(install 時)
 *   index.html を取り、その中の <script src> と <link href> を全部キャッシュする。
 *   ROADMAP の「キャッシュリストは index.html の script タグ群と同期させること」を、
 *   リストを手で持たずに index.html 自身から作ることで満たす。1本でも取れなければ
 *   install を失敗させず(次の起動で取り直す)、取れた分だけ入れる。
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

async function cacheOne(cache, url) {
  try {
    const res = await fetch(new Request(url, { cache: 'no-cache' }));
    if (res && res.ok) await cache.put(url, res);
  } catch (e) { /* 取れなかった分は次の機会に */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let list = CORE.slice();
    try {
      const res = await fetch(new Request(INDEX, { cache: 'no-cache' }));
      if (res && res.ok) {
        const html = await res.clone().text();
        await cache.put(INDEX, res);
        list = list.concat(assetsFromHtml(html));
      }
    } catch (e) { /* index が取れなければ CORE だけ */ }
    // 同時接続を増やしすぎない(11MB 前後・約120本)
    const queue = list.filter((u) => u !== INDEX);
    const workers = [];
    for (let i = 0; i < 6; i++) {
      workers.push((async () => { while (queue.length) await cacheOne(cache, queue.shift()); })());
    }
    await Promise.all(workers);
    await self.skipWaiting();
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
