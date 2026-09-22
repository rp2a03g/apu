/*
 * URLパラメータで指定したサウンドファイルを開く (2026-09-22)
 *
 *   MML.UI.UrlLoad
 *
 * 「アプリのURL + 曲のありか」を1本のリンクにまとめて共有するための入口。
 *
 *   https://rp2a03g.github.io/apu/?nsf=https%3A%2F%2F.../song.nsf&song=3
 *
 * リンクを踏んだ人のブラウザがそのアドレスから直接ファイルを取ってくるだけで、
 * このアプリはファイルを一切預からない(置き場も責任も、上げた本人のところに残る)。
 *
 * ■ 取りに行ってよいアドレス
 *   ・https:// の絶対URL
 *   ・同じ場所からの相対パス(?nsf=songs/foo.nsf)
 *   ・http:// はページ自身が http のとき(localhostのプレビュー)だけ。https のページからは
 *     混在コンテンツとしてブラウザが止めるので、ここで先に弾いて理由を出す。
 *   file:// で開いたページは fetch そのものが使えないので、この機能ごと使えない。
 *
 * ■ CORS
 *   別オリジンのファイルは、配布元が Access-Control-Allow-Origin を返さないと読めない。
 *   ブラウザの制限なのでこちらからは外せない。実測(2026-09-22)では
 *   raw.githubusercontent.com と gist.githubusercontent.com はどちらも `*` を返すため、
 *   GitHubのリポジトリ/Gistに置いたファイルはそのまま読める。
 *   失敗したとき利用者に原因を推測する手がかりが無いので、文言でCORSの可能性まで書く
 *   (呼び出し側 main.js の msg 表。fetch は CORS拒否も名前解決失敗も同じ TypeError になり、
 *    スクリプトからは区別できない)。
 *
 * ■ 形式の判別
 *   openSoundFile() は File.name の拡張子で形式を決めるので、URLの末尾から名前を作る。
 *   拡張子が無い/知らない綴りのアドレスでも開けるよう、取得したバイト列の先頭(マジック)
 *   からも判定して名前を補う。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};

  // エラーは呼び出し側(main.js)で翻訳込みの文言を当てるので、ここではコードだけ載せる
  function err(code, params) {
    const e = new Error(code);
    e.code = code;
    e.params = params || {};
    return e;
  }

  // openSoundFile() が知っている拡張子。URL末尾の綴りがこの中に無ければマジックで判定する
  const KNOWN_EXTS = ['nsf', 'nsfe', 'spc', 'kss', 'gbs', 'hes', 'vgm', 'vgz',
                      'psf', 'minipsf', 'psflib', 'zip', '7z', 'mml', 'txt'];

  /**
   * クエリ文字列を読む。無指定なら null。
   *   ?nsf= / ?url=  … ファイルのアドレス(どちらでも同じ。nsf以外の形式も開ける)
   *   ?song=         … 曲番号。形式ごとのネイティブ表記(NSF/GBS=1始まり、KSS/HES=0始まり)を
   *                    そのまま書く(拡張m3uと同じ流儀)。zip/7zを開いた場合だけは
   *                    アーカイブ内の何曲目か(1始まり)として扱う
   */
  function parse(search) {
    let q;
    try { q = new URLSearchParams(search || ''); } catch (e) { return null; }
    const raw = q.get('nsf') || q.get('url');
    if (!raw) return null;
    const songRaw = q.get('song');
    const song = (songRaw !== null && /^-?[0-9]+$/.test(songRaw.trim())) ? parseInt(songRaw, 10) : null;
    return { raw, song };
  }

  // 取りに行ってよいアドレスか。相対パスはこのページからの相対として解決する
  function resolveUrl(raw) {
    const loc = global.location;
    if (loc && loc.protocol === 'file:') throw err('file-origin');
    let u;
    try { u = new URL(raw, loc ? loc.href : undefined); }
    catch (e) { throw err('bad-url', { url: raw }); }
    if (u.protocol === 'https:') return u;
    if (u.protocol === 'http:' && loc && loc.protocol === 'http:') return u; // localhostのプレビュー用
    throw err('bad-scheme', { url: raw });
  }

  // 先頭バイト(マジック)→ 拡張子。openSoundFile が分岐に使う綴りで返す
  function sniffExt(b) {
    if (!b || b.length < 4) return null;
    const str = (i, n) => {
      let s = '';
      for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
      return s;
    };
    const head4 = str(0, 4);
    if (head4 === 'NESM' && b[4] === 0x1a) return 'nsf';
    if (head4 === 'NSFE') return 'nsfe';
    if (head4 === 'KSCC' || head4 === 'KSSX') return 'kss';
    if (head4 === 'HESM') return 'hes';
    if (head4 === 'Vgm ') return 'vgm';
    if (str(0, 3) === 'GBS') return 'gbs';
    if (str(0, 3) === 'PSF') return 'psf'; // PSF1/miniPSF。PSF2等の拒否は MML.PSF 側の役目
    if (str(0, 27) === 'SNES-SPC700 Sound File Data') return 'spc';
    if (b[0] === 0x1f && b[1] === 0x8b) return 'vgz'; // gzip。VGZとして渡せば loadVgmFile が中身を見る
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
    if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '7z';
    return null;
  }

  // URL末尾 → ファイル名。パス区切りや禁止文字は落とす(File名にしか使わないが、
  // 画面にも出るので素のまま持ち回らない)
  function baseNameFromUrl(u) {
    const last = u.pathname.split('/').pop() || '';
    let name = last;
    try { name = decodeURIComponent(last); } catch (e) { /* 不正な%はそのまま使う */ }
    return name.replace(/[^\w.\-() 　ぁ-んァ-ヶ一-龠々ー]/g, '_').slice(0, 120);
  }

  function fileNameFor(u, bytes) {
    const name = baseNameFromUrl(u);
    const ext = name.indexOf('.') >= 0 ? name.split('.').pop().toLowerCase() : '';
    if (KNOWN_EXTS.indexOf(ext) >= 0) return name;
    const sniffed = sniffExt(bytes);
    if (!sniffed) throw err('unknown-format', { url: u.href });
    return (name || 'song') + '.' + sniffed;
  }

  /**
   * アドレスから読み込んで File を作る。戻り値 { file, url }(url は解決後の絶対URL)。
   * 失敗は code 付きの Error を投げる(file-origin / bad-url / bad-scheme /
   * fetch-failed / http-status / empty / unknown-format)。
   */
  async function fetchFile(raw) {
    const u = resolveUrl(raw);
    let res;
    try {
      res = await fetch(u.href, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      // CORS拒否・名前解決失敗・切断はどれも同じ TypeError で、区別する手段が無い
      throw err('fetch-failed', { url: u.href });
    }
    if (!res.ok) throw err('http-status', { url: u.href, status: String(res.status) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw err('empty', { url: u.href });
    return { file: new File([bytes], fileNameFor(u, bytes)), url: u.href };
  }

  UI.UrlLoad = { parse, fetchFile, sniffExt };
})(typeof window !== 'undefined' ? window : globalThis);
