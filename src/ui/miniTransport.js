/*
 * 常に手前に出るミニ操作窓 (2026-09-12)
 *
 *   MML.UI.MiniTransport.init({ onAction, onToggleSource, onRepeatCycle, onMuteToggle, makeSeekBar })
 *   MML.UI.MiniTransport.open()   ★必ずクリックハンドラの中から呼ぶこと
 *
 * 外部テキストエディタで作業しているあいだ、ブラウザを前面に出さずに再生・曲送り・
 * ミュートを操作するための小窓(Document Picture-in-Picture)。
 * 外部テキストエディタ同期と組みで使う想定で、エディタで保存 → 小窓の▶ で最新が鳴る。
 *
 * ■ 作りの方針: 操作の実体を一切持たない
 *   ボタンは onAction('prev'|'play'|'stop'|'next') 等を呼ぶだけで、実際の再生/曲送りは
 *   main.js が鍵盤表示のタイトル行(keyboardDisplay.onTransport)へ流しているのと同じ関数へ入る。
 *   状態(再生中か・押せるか)も setState() で外から流し込む。二重実装を作らないため。
 *
 * ■ 中身のDOMは本体側の文書で作り、開くときに小窓へ移す
 *   小窓を閉じたら本体側へ戻す。こうするとシークバー(main.jsのseekBars配列に登録済み)や
 *   イベントハンドラを作り直さずに済み、開閉を繰り返しても状態が途切れない。
 *
 * ■ 小窓のCSS
 *   about:blank の文書なので何も継承しない。本体のスタイルシートから必要な規則だけ
 *   文字列で取り出して流し込む(file:// で cssRules が読めない場合は <link> の複製へ落とす)。
 *   配色はCSS変数を :root から実値コピーするので、テーマ切替にもその場で追随する。
 *
 * ■ 開くのに必ずクリックが要る (2026-09-12 実測)
 *   requestWindow() は user activation 必須で、無操作だと
 *   "NotAllowedError: Document PiP requires user activation" になる。
 *   → 「ウィンドウを最小化したら自動で出す」は原理的に作れない。開閉はトップの
 *     ミニ操作窓ボタン(同じボタンをもう一度押すと閉じる)だけが入口。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};
  const T = (k, p) => (MML.I18n ? MML.I18n.t(k, p) : k);

  const MUTES_KEY = 'mml_miniTransportMutesOpen'; // chミュート行を開いているか
  const SIZE_KEY = 'mml_miniTransportSize';       // 小窓の大きさ(手で変えたら次回も同じ大きさで開く)
  const DEFAULT_SIZE = { w: 380, h: 150 };
  // 小窓へ持ち込む配色。style.css の :root から実値をコピーする(テーマ追随のため)
  const VARS = ['--panel', '--panel-raised', '--surface', '--border', '--control-bg',
    '--text', '--text-secondary', '--text-muted', '--text-faint', '--accent', '--on-accent',
    '--ok', '--error', '--hover-bg', '--sans', '--mono'];

  const ICONS = {
    prev: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M6.6 4.5v11h1.8v-11zM16 5.2c0-.8-.9-1.2-1.5-.8l-5.1 4.1a1 1 0 0 0 0 1.6l5.1 4.1c.6.5 1.5 0 1.5-.8z"/></svg>',
    play: '<svg class="icon-play" viewBox="0 0 20 20" fill="currentColor"><path d="M6.5 4.2v11.6c0 .8.9 1.3 1.6.9l9-5.8c.6-.4.6-1.4 0-1.8l-9-5.8c-.7-.4-1.6.1-1.6.9Z"/></svg>' +
          '<svg class="icon-pause" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="4" width="3.4" height="12"/><rect x="11.6" y="4" width="3.4" height="12"/></svg>',
    stop: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.2"/></svg>',
    next: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.4 4.5v11h-1.8v-11zM4 5.2c0-.8.9-1.2 1.5-.8l5.1 4.1a1 1 0 0 1 0 1.6l-5.1 4.1c-.6.5-1.5 0-1.5-.8z"/></svg>',
  };

  let root = null;        // 小窓の中身(本体文書で作り、開くときだけ小窓へ移す)
  let pipWin = null;
  let tick = null;        // 小窓側で回す表示更新タイマー
  let hooks = {};
  let btns = {};
  let titleEl = null, badgeEl = null, repeatEl = null, mutesEl = null, mutesHeadEl = null;
  let mutesOpen = false;  // 既定は畳む(拡張音源を積むと30行近くになるため)
  let state = { playing: false, canPlay: false, canStop: false, canPrevNext: false, canToggleSource: false, kind: 'mml' };
  let channels = [];

  function supported() { return 'documentPictureInPicture' in global; }
  function isOpen() { return !!pipWin && !pipWin.closed; }

  // ── 大きさの記憶 ──────────────────────────────────────────
  // requestWindow() は開いた後から大きさを変えられないので、閉じるまでの実寸を控えて
  // 次に開くときの初期値にする。極端な値で開いて画面外に出ないよう範囲を縛る
  function clampSize(w, h) {
    return {
      w: Math.max(240, Math.min(1600, Math.round(w))),
      h: Math.max(90, Math.min(1200, Math.round(h))),
    };
  }
  function loadSize() {
    try {
      const o = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
      if (o && o.w > 0 && o.h > 0) return clampSize(o.w, o.h);
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULT_SIZE);
  }
  function saveSize(w, h) {
    if (!(w > 0) || !(h > 0)) return;
    const s = clampSize(w, h);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  function build() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'mini-tp';
    root.hidden = true;

    const main = document.createElement('div');
    main.className = 'mini-tp-row mini-tp-main';
    // ファイルを開く。小窓だけで別の曲へ移れるように置いてある(鍵盤表示ヘッダの同名ボタンと同じ実体)
    const openFileBtn = document.createElement('button');
    openFileBtn.type = 'button';
    openFileBtn.className = 'mini-tp-btn mini-tp-open';
    openFileBtn.title = T('ファイルを開く');
    openFileBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5c0-.83.67-1.5 1.5-1.5h3.4l1.4 1.6H16c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5v-8.6Z"/></svg>';
    openFileBtn.addEventListener('click', () => { if (hooks.onOpenFile) hooks.onOpenFile(); });
    main.appendChild(openFileBtn);
    for (const act of ['prev', 'play', 'stop', 'next']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini-tp-btn mini-tp-btn--' + act;
      b.innerHTML = ICONS[act];
      b.addEventListener('click', () => { if (!b.disabled && hooks.onAction) hooks.onAction(act); });
      main.appendChild(b);
      btns[act] = b;
    }
    // MML ⇔ サウンドファイルの切り替え。鍵盤表示のバッジと同じ意味・同じ呼び先
    badgeEl = document.createElement('button');
    badgeEl.type = 'button';
    badgeEl.className = 'mini-tp-badge';
    badgeEl.addEventListener('click', () => {
      if (state.canToggleSource && hooks.onToggleSource) hooks.onToggleSource();
    });
    main.appendChild(badgeEl);
    // 曲が終わった後の挙動(次の曲/1曲/ランダム/停止)。押すたびに回る
    repeatEl = document.createElement('button');
    repeatEl.type = 'button';
    repeatEl.className = 'mini-tp-btn mini-tp-repeat';
    repeatEl.addEventListener('click', () => { if (hooks.onRepeatCycle) hooks.onRepeatCycle(); });
    main.appendChild(repeatEl);

    titleEl = document.createElement('span');
    titleEl.className = 'mini-tp-title';
    main.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mini-tp-btn mini-tp-close';
    closeBtn.textContent = '×';
    closeBtn.title = T('小窓を閉じる');
    closeBtn.addEventListener('click', () => close());
    main.appendChild(closeBtn);
    root.appendChild(main);

    // シークバー(main.js の seekBars に登録済みの副インスタンスをそのまま置く)
    const seekRow = document.createElement('div');
    seekRow.className = 'mini-tp-row mini-tp-seek';
    if (hooks.makeSeekBar) {
      const sb = hooks.makeSeekBar();
      if (sb) { seekRow.appendChild(sb.wrapEl); if (sb.timeEl) seekRow.appendChild(sb.timeEl); }
    }
    root.appendChild(seekRow);

    // チャンネルのミュート。拡張音源を積んだ曲だと30行近くになって小窓が埋まるので、
    // 既定は畳んでおき、畳んだままでもミュート中の数だけは見出しに出す
    mutesHeadEl = document.createElement('button');
    mutesHeadEl.type = 'button';
    mutesHeadEl.className = 'mini-tp-row mini-tp-mutes-head';
    mutesHeadEl.addEventListener('click', () => setMutesOpen(!mutesOpen));
    root.appendChild(mutesHeadEl);

    mutesEl = document.createElement('div');
    mutesEl.className = 'mini-tp-row mini-tp-mutes';
    root.appendChild(mutesEl);

    document.body.appendChild(root);
    render();
    renderMutes(); // まだチャンネルが無いので、この時点では見出しごと隠れる
    return root;
  }

  // 本体のスタイルシートから、小窓で要る規則だけ取り出す。
  // file:// では cssRules が読めないことがあるので、その場合は <link> の複製で代用する
  function styleFor(doc) {
    const wanted = /(^|,|\s)\.(mini-tp|seek-)/;
    let css = '';
    let readable = false;
    for (const sheet of document.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch (e) { rules = null; }
      if (!rules) continue;
      readable = true;
      for (const r of rules) {
        if (r.selectorText && wanted.test(r.selectorText)) css += r.cssText + '\n';
      }
    }
    if (readable && css) {
      const st = doc.createElement('style');
      st.textContent = css;
      doc.head.appendChild(st);
      return;
    }
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      doc.head.appendChild(link.cloneNode(true)); // hrefは絶対URLに解決済み
    }
  }

  function applyVars(doc) {
    const cs = getComputedStyle(document.documentElement);
    const el = doc.documentElement;
    for (const v of VARS) {
      const value = cs.getPropertyValue(v);
      if (value) el.style.setProperty(v, value.trim());
    }
  }

  // ★クリックハンドラの中から呼ぶこと(user activation 必須)
  async function open() {
    if (!supported()) return { ok: false, unsupported: true };
    if (isOpen()) { try { pipWin.focus(); } catch (e) {} return { ok: true }; }
    build();
    try {
      const size = loadSize();
      pipWin = await global.documentPictureInPicture.requestWindow({ width: size.w, height: size.h });
    } catch (e) {
      pipWin = null;
      return { ok: false, error: e };
    }
    const doc = pipWin.document;
    doc.title = T('再生操作');
    applyVars(doc);
    styleFor(doc);
    doc.body.className = 'mini-tp-body';
    root.hidden = false;
    doc.body.appendChild(root); // 本体文書から小窓へ移す(adoptNodeは自動、ハンドラは維持される)
    // ユーザーが小窓を閉じたとき(×やOSの閉じる)に中身を本体へ戻す。
    // 戻しておかないと次に開いたときシークバーの登録が死ぬ
    // 表示の更新は小窓側のタイマーで回す。本体のタブが最小化されると本体側のrAFは
    // 止まってしまうが(そのときこそ小窓を使っている)、小窓は出ているので間引かれない
    // ★以下のハンドラは pipWin ではなく win(開いた時点の窓)を見ること。
    //   close()が先に pipWin=null にしてから pagehide が飛ぶ場合があり、
    //   モジュール変数を見に行くと閉じるたびに例外になる
    const win = pipWin;
    tick = win.setInterval(() => { if (hooks.onTick) hooks.onTick(); }, 250);
    // 手で大きさを変えたら覚える(連射されるので少し待ってから1回だけ書く)
    let sizeTimer = null;
    win.addEventListener('resize', () => {
      if (sizeTimer) win.clearTimeout(sizeTimer);
      sizeTimer = win.setTimeout(() => { saveSize(win.innerWidth, win.innerHeight); }, 400);
    });
    win.addEventListener('pagehide', () => {
      // 閉じる直前の実寸が最終的な答え(resizeの待ち時間中に閉じられても取りこぼさない)
      saveSize(win.innerWidth, win.innerHeight);
      if (sizeTimer) { try { win.clearTimeout(sizeTimer); } catch (e) {} sizeTimer = null; }
      if (tick) { try { win.clearInterval(tick); } catch (e) {} tick = null; }
      if (root) { root.hidden = true; document.body.appendChild(root); }
      pipWin = null;
      if (hooks.onCloseChange) hooks.onCloseChange(false);
    });
    if (hooks.onCloseChange) hooks.onCloseChange(true);
    render();
    return { ok: true };
  }

  function close() {
    if (!isOpen()) return;
    try { pipWin.close(); } catch (e) { /* ignore */ }
    // pagehide が飛ばない環境のための保険
    if (root && root.ownerDocument !== document) { root.hidden = true; document.body.appendChild(root); }
    pipWin = null;
    if (hooks.onCloseChange) hooks.onCloseChange(false);
  }

  function render() {
    if (!root) return;
    btns.prev.disabled = !state.canPrevNext;
    btns.next.disabled = !state.canPrevNext;
    btns.play.disabled = !state.canPlay;
    btns.stop.disabled = !state.canStop;
    btns.play.classList.toggle('is-playing', state.playing);
    btns.play.title = state.playing ? T('一時停止') : T('再生');
    btns.stop.title = T('停止');
    btns.prev.title = T('前の曲');
    btns.next.title = T('次の曲');
    const isMml = !state.kind || state.kind === 'mml';
    badgeEl.textContent = isMml ? 'MML' : String(state.kind).toUpperCase();
    badgeEl.classList.toggle('mini-tp-badge--mml', isMml);
    badgeEl.disabled = !state.canToggleSource;
    badgeEl.title = state.canToggleSource
      ? T('MML再生とファイル再生を切り替える')
      : T('切り替える相手のファイルがありません');
    if (state.repeatSvg) repeatEl.innerHTML = state.repeatSvg;
    if (state.repeatLabel) repeatEl.title = state.repeatLabel;
    titleEl.textContent = state.title || '';
    titleEl.title = state.title || '';
  }

  function setState(s) {
    Object.assign(state, s || {});
    render();
  }

  function setMutesOpen(open) {
    mutesOpen = !!open;
    try { localStorage.setItem(MUTES_KEY, mutesOpen ? '1' : '0'); } catch (e) { /* ignore */ }
    renderMutes();
  }

  // 畳んだ状態でも「何chあるか」「今いくつ消しているか」は見出しに残す
  function renderMutes() {
    if (!mutesHeadEl) return;
    const n = channels.length;
    const muted = channels.filter(c => c.muted).length;
    mutesHeadEl.hidden = !n;
    mutesEl.hidden = !n || !mutesOpen;
    if (!n) return;
    mutesHeadEl.textContent = (mutesOpen ? '▾ ' : '▸ ') +
      T('chミュート ({n}ch)', { n }) + (muted ? ' — ' + T('{n}個ミュート中', { n: muted }) : '');
    mutesHeadEl.classList.toggle('has-muted', muted > 0);
    mutesHeadEl.title = mutesOpen ? T('チャンネルを畳む') : T('チャンネルを開く');
  }

  // list: [{ id, label, muted }]。押すと onMuteToggle(id)
  function setChannels(list) {
    if (!root) return;
    list = list || [];
    const sig = list.map(c => c.id + (c.muted ? '!' : '')).join(',');
    if (sig === channels.sig) return; // 毎フレーム呼ばれても実際に変わった時だけ作り直す
    channels = list.slice();
    channels.sig = sig;
    mutesEl.innerHTML = '';
    renderMutes();
    for (const ch of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini-tp-mute' + (ch.muted ? ' is-muted' : '');
      b.textContent = ch.label || ch.id;
      b.title = ch.id + (ch.muted ? ' (' + T('ミュート中') + ')' : '');
      // ch一覧と同じ色で薄く塗り分ける。多チャンネルのとき見分けが付かなくなるため
      // (色は鍵盤表示の行の丸と同じ値。ユーザーが色を変えればここも変わる)
      if (ch.color) b.style.setProperty('--ch-color', ch.color);
      b.addEventListener('click', () => { if (hooks.onMuteToggle) hooks.onMuteToggle(ch.id); });
      mutesEl.appendChild(b);
    }
  }

  function init(opts) {
    hooks = opts || {};
    try { mutesOpen = localStorage.getItem(MUTES_KEY) === '1'; } catch (e) { mutesOpen = false; }
    build();
  }

  MML.UI.MiniTransport = {
    init, open, close, setState, setChannels, render, setMutesOpen,
    supported, isOpen,
  };
})(window);
