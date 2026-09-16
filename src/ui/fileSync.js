/*
 * 外部テキストエディタとの同期 (2026-09-12)
 *
 *   MML.UI.FileSync.init({ onExternalChange, onStateChange, isDirty })
 *
 * MMLの正本をディスク上の .mml ファイルに置いたまま、VS Code / サクラエディタ / 秀丸などの
 * 使い慣れたテキストエディタで編集し、その結果をこのアプリへ取り込むための層。
 * File System Access API の FileSystemFileHandle を握り続け、getFile() の lastModified を
 * 一定間隔で見て変化を検出する(このAPIに変更通知イベントは無いのでポーリングしかない。
 * getFile()はメタデータを読むだけなので1秒間隔でも負荷は無視できる)。
 *
 * ■ file:// でも動く (2026-09-12 実測: Chrome 153 / Windows 11)
 *   file:// は Chrome では secure context 扱いで、showOpenFilePicker / showSaveFilePicker /
 *   DataTransferItem.getAsFileSystemHandle / createWritable / IndexedDB がすべて使える。
 *   遮断されるのは fetch/XHR で隣のファイルを読む経路だけ。
 *   逆に旧Filesystem API の webkitGetAsEntry は file:// では EncodingError で死ぬので使わない。
 *   → GitHubからダウンロードして index.html を直接開く運用のままこの機能を出せる。
 *
 * ■ 権限まわりの実測結果(ここが設計を決めている)
 *   ・ピッカー/ドロップで得た直後は読み取り可。確認ダイアログは出ない
 *   ・書き込みは最初の1回だけ Chrome の確認ダイアログ(「変更を保存しますか?」)が出る
 *   ・ページを再読込するとハンドルは IndexedDB から復元できるが、権限は 'prompt' に戻り
 *     getFile() が NotAllowedError になる。復帰には必ずユーザー操作(クリック)が要る
 *   → 起動時に黙って読み直すことはできない。「再接続」ボタンを出す形にしてある。
 *
 * ■ 外部が正 (INV-2「MMLテキストが正典」の延長)
 *   外部の更新はエディタ側が未編集なら黙って取り込む。エディタ側にも未保存の変更がある
 *   ときは取り込まずに保留し(pendingText)、どちらを採るかはユーザーに選ばせる。
 *   勝手に上書きして書きかけを失わせない、というのがこの層の唯一の約束。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};

  const DB_NAME = 'mml_fileSync';
  const STORE = 'handles';
  const KEY = 'lastMml';
  const WATCH_KEY = 'mml_fileSyncWatch'; // 自動取り込みのON/OFF(localStorage)
  const POLL_MS = 1000;

  let handle = null;        // 接続中の FileSystemFileHandle
  let remembered = null;    // IndexedDBから復元したハンドル(権限は 'prompt' に戻っている)
  let rememberedName = '';
  let baseModified = 0;     // ディスクと一致していると分かっている時点の lastModified
  let baseSize = -1;
  let baseText = null;      // 同上の本文。保存し直しただけ(内容が同じ)を無視するために持つ
  let pendingText = null;   // 衝突中で保留している外部の本文
  let timer = null;
  let checking = false;     // ポーリングの多重起動防止
  let watchEnabled = true;
  let lastError = '';
  let hooks = {};

  function supported() {
    return typeof global.showOpenFilePicker === 'function' ||
      (typeof DataTransferItem !== 'undefined' && 'getAsFileSystemHandle' in DataTransferItem.prototype);
  }

  // ---- IndexedDB (ハンドルは構造化クローンで保存できるのでlocalStorageでは代用できない) ----
  function openDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    });
  }
  async function idbPut(value) {
    const db = await openDb();
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } finally { db.close(); }
  }
  async function idbGet() {
    const db = await openDb();
    try {
      return await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const q = tx.objectStore(STORE).get(KEY);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => rej(q.error);
      });
    } finally { db.close(); }
  }
  function remember(h) { idbPut(h).catch(() => { /* プライベートモード等では諦める */ }); }
  function forget() { idbPut(null).catch(() => {}); remembered = null; rememberedName = ''; }

  // ---- 状態通知 ----
  function state() {
    return {
      supported: supported(),
      connected: !!handle,
      name: handle ? handle.name : '',
      watching: !!timer,
      watchEnabled,
      conflict: pendingText !== null,
      // 接続は切れているが、クリックすれば復帰できる相手がいるか
      resumable: (!handle && !!remembered) || (!!handle && !timer && !!lastError),
      resumableName: handle ? handle.name : rememberedName,
      error: lastError,
    };
  }
  function notify() { if (hooks.onStateChange) hooks.onStateChange(state()); }

  // ---- 監視 ----
  function startWatch() {
    stopWatch();
    if (handle && watchEnabled) {
      timer = setInterval(() => {
        // タブが裏に回っているあいだは止める。外部エディタを触っているときはブラウザが
        // 非フォーカスなだけでタブは表示されたままなので、これで監視は途切れない
        if (document.hidden) return;
        checkNow({ auto: true });
      }, POLL_MS);
    }
    notify(); // 監視の入/切はUIの表示(⟳の押し込み)に出るので、始めた側でも必ず通知する
  }
  function stopWatch() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setWatchEnabled(on) {
    watchEnabled = !!on;
    try { localStorage.setItem(WATCH_KEY, watchEnabled ? '1' : '0'); } catch (e) { /* ignore */ }
    if (watchEnabled) { startWatch(); checkNow(); } else { stopWatch(); notify(); }
  }

  // ディスク側が変わっていれば取り込む。戻り値は取り込んだかどうか。
  // opts.force でエディタ側の未保存の変更を無視して取り込む(衝突の「取り込む」ボタン用)
  // opts.auto は「自動取り込みの一部として呼んでいる」印。⟳がOFFなら何もしない。
  //   ★勝手に取り込まれない保証はここ1か所に集める。ポーリング以外の自動経路
  //     (フォーカス復帰など)を足すときは必ず auto を付けること。再生ボタンからの
  //     同期だけはユーザーの操作なので auto を付けず、OFFでも必ず取り込む
  async function checkNow(opts) {
    if (opts && opts.auto && !watchEnabled) return false;
    if (!handle || checking) return false;
    checking = true;
    try {
      const file = await handle.getFile();
      if (file.lastModified === baseModified && file.size === baseSize) return false;
      const text = await file.text();
      baseModified = file.lastModified;
      baseSize = file.size;
      if (text === baseText) return false; // 中身が同じ(エディタが保存し直しただけ)
      const dirty = !(opts && opts.force) && hooks.isDirty && hooks.isDirty();
      if (dirty) { pendingText = text; notify(); return false; }
      baseText = text;
      pendingText = null;
      if (hooks.onExternalChange) hooks.onExternalChange(text, { name: handle.name, lastModified: file.lastModified });
      notify();
      return true;
    } catch (e) {
      // 権限失効(NotAllowedError)・ファイルが消えた(NotFoundError)等。監視は止めるが
      // ハンドルは捨てない(クリックさえもらえれば requestPermission で復帰できる)
      lastError = (e && e.name) || String(e);
      stopWatch();
      notify();
      return false;
    } finally { checking = false; }
  }

  // 保留していた外部の本文を取り込む
  function acceptPending() {
    if (pendingText === null) return false;
    const text = pendingText;
    pendingText = null;
    baseText = text;
    if (hooks.onExternalChange) hooks.onExternalChange(text, { name: handle ? handle.name : '', pending: true });
    notify();
    return true;
  }
  function discardPending() { pendingText = null; notify(); }

  async function ensurePermission(h, mode) {
    if (!h.queryPermission) return 'granted'; // 権限APIが無い実装では素通し
    const opt = { mode };
    let p = await h.queryPermission(opt);
    if (p === 'granted') return p;
    p = await h.requestPermission(opt); // ★ユーザー操作(クリック)の中から呼ぶこと
    return p;
  }

  // ---- 接続 ----
  async function attach(h, file, text) {
    handle = h;
    if (!file) file = await h.getFile();
    if (text == null) text = await file.text();
    baseModified = file.lastModified;
    baseSize = file.size;
    baseText = text;
    pendingText = null;
    lastError = '';
    remembered = h;
    rememberedName = h.name;
    remember(h);
    startWatch();
    notify();
    return text;
  }

  function detach() {
    stopWatch();
    handle = null;
    baseText = null;
    baseModified = 0;
    baseSize = -1;
    pendingText = null;
    lastError = '';
    forget();
    notify();
  }

  // ピッカーでファイルを選ぶ。file:// でも開けることは実測済み。
  // .mml と一緒に .dmc も選べる(複数選択)。handle は同期対象にする .mml/.txt/楽譜(最初の1つ)、
  // handles は選んだ全部(呼び出し側が .dmc を台帳へ入れる。src/ui/dpcmStore.js)
  // 戻り値: { handle, handles } / { aborted:true } / { unsupported:true } / { error }
  async function pickOpen() {
    if (typeof global.showOpenFilePicker !== 'function') return { unsupported: true };
    try {
      const handles = await global.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'MML', accept: { 'text/plain': ['.mml', '.txt'] } },
                { description: 'MusicXML', accept: { 'application/vnd.recordare.musicxml+xml': ['.musicxml', '.xml'], 'application/vnd.recordare.musicxml': ['.mxl'] } },
                { description: 'DPCM', accept: { 'application/octet-stream': ['.dmc'] } }],
      });
      const h = handles.find((x) => !/\.dmc$/i.test(x.name)) || null;
      return { handle: h, handles };
    } catch (e) {
      if (e && e.name === 'AbortError') return { aborted: true };
      return { error: e };
    }
  }

  // ドロップされた項目からハンドルを取る。DataTransferItem はイベントハンドラを抜けると
  // 無効になるので、これは drop ハンドラの中から同期的に呼ぶこと(戻り値のPromiseは後でawaitしてよい)
  function handleFromDropItem(item) {
    if (!item || typeof item.getAsFileSystemHandle !== 'function') return null;
    try { return item.getAsFileSystemHandle(); } catch (e) { return null; }
  }

  // 再読込後などに、権限を取り直して接続を復帰する。★クリックハンドラの中から呼ぶこと。
  // 復帰できたらそのままファイルの内容を取り込む(エディタ側が未編集のときだけ。
  // 編集済みなら取り込まずに保留して、どちらを採るかは呼び出し側に選ばせる)。
  // 戻り値: { name, text, conflicted } / null(権限が下りなかった・相手がいない)
  async function reconnect() {
    const h = handle || remembered;
    if (!h) return null;
    try {
      if (await ensurePermission(h, 'read') !== 'granted') return null;
      const file = await h.getFile();
      const text = await file.text();
      await attach(h, file, text);
      if (hooks.isDirty && hooks.isDirty()) {
        pendingText = text;
        notify();
        return { name: h.name, text, conflicted: true };
      }
      if (hooks.onExternalChange) hooks.onExternalChange(text, { name: h.name, reconnect: true });
      notify();
      return { name: h.name, text, conflicted: false };
    } catch (e) {
      lastError = (e && e.name) || String(e);
      notify();
      return null;
    }
  }

  // 接続中のファイルへ上書き保存する。★クリックハンドラの中から呼ぶこと(初回は権限ダイアログが出る)
  // 戻り値: { ok:true } / { ok:false, denied:true } / { ok:false, error }
  async function write(text) {
    if (!handle) return { ok: false };
    try {
      if (await ensurePermission(handle, 'readwrite') !== 'granted') return { ok: false, denied: true };
      const writable = await handle.createWritable();
      await writable.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      await writable.close();
      await markSaved(text);
      if (!timer) startWatch(); // 権限切れで止まっていた監視はここで復帰する
      return { ok: true };
    } catch (e) {
      lastError = (e && e.name) || String(e);
      notify();
      return { ok: false, error: e };
    }
  }

  // アプリ側からディスクへ書いた直後の基準合わせ。これを忘れると自分の保存を
  // 「外部の更新」として拾い直してしまう
  async function markSaved(text) {
    if (!handle) return;
    try {
      const file = await handle.getFile();
      baseModified = file.lastModified;
      baseSize = file.size;
    } catch (e) { /* 読めなくても基準テキストだけは合わせる */ }
    baseText = text;
    pendingText = null;
    lastError = '';
    notify();
  }

  function init(opts) {
    hooks = opts || {};
    try { watchEnabled = localStorage.getItem(WATCH_KEY) !== '0'; } catch (e) { watchEnabled = true; }
    // 前回のファイルを思い出しておく(権限は失効しているので読み込みはしない。
    // ここでやるのは「再接続」ボタンに名前を出すところまで)
    idbGet().then((h) => {
      if (h && h.kind === 'file') { remembered = h; rememberedName = h.name; notify(); }
    }).catch(() => { /* IndexedDBが使えない環境では黙って諦める */ });
    notify();
  }

  MML.UI.FileSync = {
    init, supported, state,
    pickOpen, handleFromDropItem, attach, detach, reconnect,
    checkNow, acceptPending, discardPending,
    write, markSaved,
    setWatchEnabled, isWatchEnabled: () => watchEnabled,
    isConnected: () => !!handle,
    fileName: () => (handle ? handle.name : ''),
    currentHandle: () => handle, // 保存直後に .dmc を同じフォルダへ書くため(main.js afterMmlSaved)
  };
})(window);
