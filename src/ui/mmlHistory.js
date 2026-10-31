/*
 * MMLの版履歴 (2026-10-31)
 *
 *   MML.UI.MmlHistory.init({ getText, getName, onRestore })
 *
 * 「別の曲を貼り付けたまま上書き保存して、元のファイルを失った」(2026-10-30)の再発防止策の
 * 1つ。同期の切断や保存時の確認(fileSync.js / main.js saveMmlFile)が「事故を起こさない」側
 * なのに対し、ここは「起きても戻せる」側: ツール自身が IndexedDB に版を持つ。
 *
 *   ・上書き保存の直前に、それまでディスクにあった本文を「保存前の版」として残す
 *     (FileSync.write と、保存ダイアログで既存ファイルを選んだ経路の両方)
 *   ・保存していない編集中の本文も、入力が止まって DRAFT_IDLE_MS 後に「下書き」として残す
 *     (接続中ならそのファイル名、未接続なら UNTITLED のキー)
 *   ・「エディタへ戻す」は今の本文も履歴に入れてから差し替える。戻した本文はディスクと
 *     一致しないので外部エディタ同期は切る(main.js 側で FileSync.detach())
 *
 * 保存形式は .mml のプレーンテキストが正典(DESIGN.md INV-2)のまま。ここで持つのはブラウザ側
 * の控えで、ディスク上のファイルには何も足さない。file:// でも IndexedDB は使える
 * (fileSync.js 冒頭の実測)。プライベートモード等で IndexedDB が使えなければ黙って諦める。
 *
 * 容量: 1キーあたり PER_NAME_MAX 版、全体で TOTAL_MAX_BYTES(UTF-8換算)。超えた分は古い版から捨てる。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const DB_NAME = 'mml_history';
  const STORE = 'versions';
  const UNTITLED = '(untitled)';
  const PER_NAME_MAX = 12;             // 1キーあたりの版数(保存前の版+下書きを合わせて)
  const TOTAL_MAX_BYTES = 4 * 1024 * 1024;
  const DRAFT_IDLE_MS = 30 * 1000;     // 入力が止まってから下書きを残すまで
  const LIST_MAX = 30;                 // 一覧に出す件数

  let hooks = {};
  let draftTimer = null;
  let panelEl = null;
  let selectEl = null;
  let listEl = null;
  let viewName = null;                 // 一覧で見ているキー(null = 今のファイル)
  let listVersion = 0;                 // 非同期の描き直しの追い越し防止
  let lastListed = [];

  // ---- IndexedDB ----
  function openDb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const st = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        st.createIndex('name', 'name', { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    });
  }
  function reqToPromise(q) {
    return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, mode);
      const r = await fn(tx.objectStore(STORE));
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      return r;
    } finally { db.close(); }
  }

  function byteLength(s) {
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
  }
  function firstLine(text) {
    const m = /^[^\r\n]*/.exec(text || '');
    return (m ? m[0] : '').trim();
  }
  function keyFor(name) { return (name || '').trim() || UNTITLED; }

  // 全件(本文は含めない。一覧と容量計算用)
  async function listAll() {
    return withStore('readonly', (st) => reqToPromise(st.getAll()));
  }

  // 1版入れる。同じキーに同一内容の版が既にあれば入れない。
  // kind: 'saved'(上書き前にディスクにあった版) | 'draft'(編集中の下書き) | 'replaced'(戻す前の本文)
  async function add(name, text, kind) {
    if (typeof text !== 'string' || !text.length) return false;
    const key = keyFor(name);
    const bytes = byteLength(text);
    if (bytes > TOTAL_MAX_BYTES / 2) return false; // 1本で容量の半分を超えるものは持たない
    const added = await withStore('readwrite', async (st) => {
      const idx = st.index('name');
      const same = await reqToPromise(idx.getAll(key));
      same.sort((a, b) => a.time - b.time);
      // 同じ内容がこのキーの履歴に既にあれば入れない(戻した直後の下書き等で同じ本文が重ならないように)
      if (same.some(e => e.text === text)) return false;
      st.add({ name: key, kind, time: Date.now(), bytes, head: firstLine(text), text });
      // 1キーあたりの上限
      const over = same.length + 1 - PER_NAME_MAX;
      for (let i = 0; i < over; i++) st.delete(same[i].id);
      return true;
    });
    if (added) { await trimTotal(); render(); }
    return added;
  }

  // 全体の容量上限: 古い版から捨てる(キーをまたいで時刻順)
  async function trimTotal() {
    await withStore('readwrite', async (st) => {
      const all = await reqToPromise(st.getAll());
      let total = all.reduce((s, e) => s + (e.bytes || 0), 0);
      if (total <= TOTAL_MAX_BYTES) return;
      all.sort((a, b) => a.time - b.time);
      for (const e of all) {
        if (total <= TOTAL_MAX_BYTES) break;
        st.delete(e.id);
        total -= e.bytes || 0;
      }
    });
  }

  async function get(id) {
    return withStore('readonly', (st) => reqToPromise(st.get(id)));
  }
  async function remove(id) {
    await withStore('readwrite', (st) => { st.delete(id); });
    render();
  }

  // ---- 入口 ----

  // 上書き保存の直前。handle のファイルに今ある本文を「保存前の版」として残す。
  // baseText が分かっていれば(fileSync.js が持っている)それを使い、無ければ読み直す。
  // 保存ダイアログで新規作成した直後のファイルは空なので、何も残らない。
  async function beforeOverwrite(handle, baseText) {
    try {
      let text = baseText;
      if (typeof text !== 'string' && handle && handle.getFile) text = await (await handle.getFile()).text();
      if (typeof text !== 'string') return false;
      if (hooks.getText && text === hooks.getText()) return false; // 同じ内容を保存し直すだけ
      return await add(handle ? handle.name : hooks.getName && hooks.getName(), text, 'saved');
    } catch (e) { return false; }
  }

  // エディタの input のたびに呼ぶ。入力が止まって DRAFT_IDLE_MS 後に下書きを残す
  function touch() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, DRAFT_IDLE_MS);
  }
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (!hooks.getText) return;
    const text = hooks.getText();
    if (hooks.isSynced && hooks.isSynced()) return; // ディスクと同じ本文は下書きにしない
    add(hooks.getName && hooks.getName(), text, 'draft').catch(() => {});
  }

  // 一覧の版をエディタへ戻す。今の本文を先に残してから onRestore へ渡す
  async function restore(id) {
    const e = await get(id);
    if (!e) return false;
    if (hooks.getText) {
      const cur = hooks.getText();
      if (cur !== e.text) await add(hooks.getName && hooks.getName(), cur, 'replaced').catch(() => {});
    }
    if (hooks.onRestore) hooks.onRestore(e.text, e);
    return true;
  }

  // ---- 表示(鍵盤表示のファイル情報ペインへ main.js が付け替える) ----
  function kindLabel(kind) {
    if (kind === 'saved') return T('保存前の版');
    if (kind === 'replaced') return T('戻す前の本文');
    return T('下書き');
  }
  function fmtTime(t) {
    const d = new Date(t);
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
  }

  function element() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'mml-history';
    panelEl.setAttribute('data-i18n-skip', ''); // 文言はここで T() を通す(言語切替は onChange で描き直す)
    panelEl.setAttribute('data-kbd-fi-auto', ''); // これだけのときファイル情報ペインを中身なりの高さにする(keyboard.js)
    panelEl.setAttribute('data-kbd-fi-auto', ''); // これだけのときファイル情報ペインを中身なりの高さにする(keyboard.js)
    const head = document.createElement('div');
    head.className = 'mml-history-head';
    const title = document.createElement('span');
    title.className = 'mml-history-title';
    head.appendChild(title);
    selectEl = document.createElement('select');
    selectEl.className = 'mml-history-select';
    selectEl.addEventListener('change', () => { viewName = selectEl.value || null; render(); });
    head.appendChild(selectEl);
    panelEl.appendChild(head);
    listEl = document.createElement('div');
    listEl.className = 'mml-history-list';
    panelEl.appendChild(listEl);
    panelEl._titleEl = title;
    if (MML.I18n && MML.I18n.onChange) MML.I18n.onChange(render);
    render();
    return panelEl;
  }

  function currentKey() { return keyFor(hooks.getName && hooks.getName()); }

  async function render() {
    if (!panelEl) return;
    const my = ++listVersion;
    panelEl._titleEl.textContent = T('前の版');
    panelEl._titleEl.title = T('上書き保存の前にあった本文と、編集中の下書きをブラウザが控えたもの。ディスク上のファイルには何も足しません');
    let all = [];
    try { all = await listAll(); } catch (e) { all = []; }
    if (my !== listVersion) return;
    lastListed = all;
    const cur = currentKey();
    const names = Array.from(new Set(all.map(e => e.name)));
    if (!names.includes(cur)) names.unshift(cur);
    names.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : a.localeCompare(b)));
    const want = viewName && names.includes(viewName) ? viewName : cur;
    selectEl.innerHTML = '';
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = (n === UNTITLED ? T('(名前なし)') : n) + (n === cur ? ' ' + T('(今のファイル)') : '');
      selectEl.appendChild(o);
    }
    selectEl.value = want;
    const rows = all.filter(e => e.name === want).sort((a, b) => b.time - a.time).slice(0, LIST_MAX);
    listEl.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'mml-history-empty';
      empty.textContent = T('まだ版がありません。上書き保存の直前の本文と、入力が止まって30秒後の下書きがここに溜まります。');
      listEl.appendChild(empty);
      return;
    }
    for (const e of rows) {
      const row = document.createElement('div');
      row.className = 'mml-history-row mml-history-row--' + (e.kind || 'draft');
      const meta = document.createElement('span');
      meta.className = 'mml-history-meta';
      meta.textContent = fmtTime(e.time) + ' · ' + kindLabel(e.kind) + ' · ' + T('{n}バイト', { n: e.bytes });
      const headEl = document.createElement('span');
      headEl.className = 'mml-history-headline';
      headEl.textContent = e.head || '';
      headEl.title = e.head || '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mml-history-restore';
      btn.textContent = T('エディタへ戻す');
      btn.title = T('この版をエディタへ入れます。今の本文も「戻す前の本文」として履歴に残り、外部ファイルとの同期は切れます(黙って上書きしないため)');
      btn.addEventListener('click', () => { restore(e.id).catch(() => {}); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mml-history-delete';
      del.textContent = '×';
      del.title = T('この版を履歴から消す');
      del.addEventListener('click', () => { remove(e.id).catch(() => {}); });
      row.appendChild(meta);
      row.appendChild(headEl);
      row.appendChild(btn);
      row.appendChild(del);
      listEl.appendChild(row);
    }
  }

  // hooks: getText() 今の本文 / getName() 接続中または直近のファイル名 / isSynced() 本文がディスクと同じか /
  //        onRestore(text, entry) エディタへ入れる(main.js 側で同期を切る)
  function init(opts) {
    hooks = opts || {};
    // タブが裏に回る/閉じる直前に、待っている下書きを残す(閉じる時は間に合わないこともある)
    document.addEventListener('visibilitychange', () => { if (document.hidden && draftTimer) flushDraft(); });
    global.addEventListener('pagehide', () => { if (draftTimer) flushDraft(); });
  }

  MML.UI.MmlHistory = {
    init, element, render,
    beforeOverwrite, touch, flushDraft, restore, add, remove,
    // テスト/診断用
    list: listAll, UNTITLED,
  };
})(window);
