/*
 * @DPCM サンプル(.dmc)の台帳の永続化と、.mml と同じフォルダへの書き出し (2026-09-16)
 *
 *   MML.UI.DpcmStore
 *
 * 保存形式は変えない(.mml はテキストのみ、.dmc はその隣に置く = ppmck の運用。DESIGN.md INV-2)。
 * このモジュールが担うのは「同じ .mml を開き直したら .dmc も戻る」ための紐付けと、
 * 保存時に「参照している .dmc を .mml と同じフォルダへ書く」ことだけ。
 *
 * ■ 何を覚えるか
 *   ・サンプルのバイト列: IndexedDB(mml_dpcm/samples)にファイル名をキーで保存する。
 *     *2mml 変換の出力・DPCMコンバータの反映・開いた/ドロップした .dmc がすべて入口
 *     (main.js setDpcmSampleBytes)。同名は後勝ち(曲をまたいで kick.dmc が複数あれば直近のもの)。
 *   ・.dmc の書き出し先フォルダ: showDirectoryPicker で選んだ FileSystemDirectoryHandle を
 *     IndexedDB(mml_dpcm/meta)に覚える。再読込後は権限が 'prompt' に戻るので、書き込みは
 *     必ずユーザー操作(保存ボタン)の中で requestPermission する(src/ui/fileSync.js と同じ事情)。
 *     「覚えているフォルダ」に今保存した .mml が本当に居るか(isSameEntry)を確かめてから書く。
 *     別のフォルダへ保存し直したときに、古いフォルダへ .dmc を撒かないため。
 *
 * ■ file:// でも動く
 *   IndexedDB / showDirectoryPicker / createWritable は file:// でも使える(fileSync.js の実測と同じ)。
 *   showDirectoryPicker が無いブラウザ(Firefox 等)では、呼び出し側がダウンロードに落とす。
 *
 * ■ ppmckc との整合
 *   ppmckc は @DPCM のファイル名を fopen にそのまま渡し、無ければ環境変数 DMC_INCLUDE のフォルダを
 *   順に探す(mck/src/ppmckc/file.c openDmc)。.mml と同じフォルダで ppmckc を走らせれば
 *   ここで書き出した .dmc がそのまま使える。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};

  const DB_NAME = 'mml_dpcm';
  const STORE_SAMPLES = 'samples';
  const STORE_META = 'meta';
  const DIR_KEY = 'dmcDir';

  function hasIdb() { return typeof indexedDB !== 'undefined'; }

  // ---- IndexedDB ------------------------------------------------------------
  function openDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SAMPLES)) db.createObjectStore(STORE_SAMPLES);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    });
  }
  // store に対して fn(objectStore) を1トランザクションで走らせる。戻り値は fn が返したリクエストの結果
  async function withStore(store, mode, fn) {
    if (!hasIdb()) return null;
    const db = await openDb();
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction(store, mode);
        let out;
        try { out = fn(tx.objectStore(store)); } catch (e) { rej(e); return; }
        tx.oncomplete = () => res(out && typeof out.result !== 'undefined' ? out.result : out);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('aborted'));
      });
    } finally { db.close(); }
  }

  // ---- サンプルのバイト列 -----------------------------------------------------
  // 失敗(プライベートモード等)は握りつぶす: 永続化できなくても曲は鳴る
  async function put(name, bytes) {
    if (!name || !bytes) return;
    try {
      const copy = new Uint8Array(bytes); // 呼び出し側の配列が後で差し替わっても台帳の中身は変わらない
      await withStore(STORE_SAMPLES, 'readwrite', (s) => s.put({ bytes: copy, savedAt: Date.now() }, String(name)));
    } catch (e) { /* ignore */ }
  }
  async function get(name) {
    try {
      const rec = await withStore(STORE_SAMPLES, 'readonly', (s) => s.get(String(name)));
      return rec && rec.bytes ? new Uint8Array(rec.bytes) : null;
    } catch (e) { return null; }
  }

  // MML本文の @DPCM<n> 定義からファイル名を拾う(src/mml/defBlocks.js。DPCMコンバータと同じ読み方)。
  // 重複は1つにまとめる(同じ .dmc を複数の定義が別レートで参照することがある)
  function namesIn(source) {
    const Defs = MML.Defs;
    if (!Defs || !source) return [];
    const out = [];
    for (const d of Defs.scan(source, 'DPCM')) {
      const m = /^\s*"([^"]*)"/.exec(Defs.stripComments(source.slice(d.contentStart, d.contentEnd)));
      if (m && m[1] && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  // 台帳(cache: main.js dpcmSampleCache)に無い名前を IndexedDB から埋める。
  // 戻り値 { restored: [name], missing: [name] }
  async function restore(names, cache) {
    const restored = [];
    const missing = [];
    for (const name of names || []) {
      if (cache[name]) continue;
      const bytes = await get(name);
      if (bytes) { cache[name] = bytes; restored.push(name); }
      else missing.push(name);
    }
    return { restored, missing };
  }

  // ---- .dmc の書き出し先フォルダ --------------------------------------------
  let dirHandle = null;   // 覚えているフォルダ(権限はまだ無いかもしれない)
  let dirLoaded = null;   // 復元の Promise(初回だけ IndexedDB を見る)

  function dirSupported() { return typeof global.showDirectoryPicker === 'function'; }

  function loadDir() {
    if (!dirLoaded) {
      dirLoaded = withStore(STORE_META, 'readonly', (s) => s.get(DIR_KEY))
        .then((h) => { if (h && h.kind === 'directory') dirHandle = h; })
        .catch(() => {});
    }
    return dirLoaded;
  }
  function rememberDir(h) {
    dirHandle = h;
    withStore(STORE_META, 'readwrite', (s) => s.put(h, DIR_KEY)).catch(() => {});
  }

  async function ensurePermission(h, mode) {
    if (!h.queryPermission) return 'granted';
    const opt = { mode };
    let p = await h.queryPermission(opt);
    if (p === 'granted') return p;
    try { p = await h.requestPermission(opt); } catch (e) { return 'denied'; } // ★クリック内でないと投げる
    return p;
  }

  // フォルダを選ぶ(★クリック内)。startIn に .mml のハンドルを渡すとそのフォルダで開く。
  // 戻り値: ハンドル / null(キャンセル・非対応・権限なし)
  async function pickDir(startIn) {
    if (!dirSupported()) return null;
    let h = null;
    try {
      h = await global.showDirectoryPicker({ id: 'mml-dmc', mode: 'readwrite', startIn: startIn || 'documents' });
    } catch (e) {
      if (e && e.name === 'AbortError') return null; // キャンセル
      // startIn にファイルハンドルを受け付けない実装なら、指定なしで出し直す
      if (!startIn) return null;
      try { h = await global.showDirectoryPicker({ id: 'mml-dmc', mode: 'readwrite' }); }
      catch (e2) { return null; }
    }
    try {
      if (await ensurePermission(h, 'readwrite') !== 'granted') return null;
    } catch (e) { return null; }
    rememberDir(h);
    return h;
  }

  // fileHandle(保存した .mml)が dir の直下にあるか
  async function dirContains(dir, fileHandle) {
    if (!dir || !fileHandle || !fileHandle.name) return false;
    try {
      const fh = await dir.getFileHandle(fileHandle.name);
      return fileHandle.isSameEntry ? await fileHandle.isSameEntry(fh) : true;
    } catch (e) { return false; }
  }

  async function writeAll(dir, files) {
    const written = [];
    const failed = [];
    for (const f of files || []) {
      try {
        const fh = await dir.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable();
        await w.write(new Blob([f.bytes], { type: 'application/octet-stream' }));
        await w.close();
        written.push(f.name);
      } catch (e) {
        failed.push(f.name);
      }
    }
    return { written, failed, dirName: dir.name };
  }

  // 保存直後の「黙って隣へ書く」経路。覚えているフォルダに今保存した .mml が居て、権限が取れたときだけ書く。
  // 戻り値: writeAll の結果 / null(書けなかった: 呼び出し側は「フォルダを選んで書く」ボタンを出す)
  async function writeBeside(fileHandle, files) {
    await loadDir();
    if (!dirHandle || !fileHandle) return null;
    if (await ensurePermission(dirHandle, 'readwrite') !== 'granted') return null;
    if (!(await dirContains(dirHandle, fileHandle))) return null;
    return writeAll(dirHandle, files);
  }

  // ボタンから: フォルダを選んで(★クリック内)書く
  async function pickAndWrite(startIn, files) {
    const h = await pickDir(startIn);
    if (!h) return null;
    return writeAll(h, files);
  }

  MML.UI.DpcmStore = {
    supported: hasIdb,
    dirSupported,
    put, get, namesIn, restore,
    writeBeside, pickAndWrite,
  };
})(typeof window !== 'undefined' ? window : globalThis);
