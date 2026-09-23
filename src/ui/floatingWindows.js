/*
 * フローティングウィンドウ管理
 * - .float-window 要素をドラッグ移動・リサイズ可能にする
 * - 位置・サイズ・表示状態を localStorage に保存して復元する
 * - data-target を持つ .toggle-btn で表示/非表示を切り替える
 */
(function () {
  const STORAGE_KEY = 'famimml-window-layout-v1';

  function loadLayout() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveLayout(layout) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch (e) {
      /* ignore */
    }
  }

  function setVisible(win, visible) {
    win.style.display = visible ? 'flex' : 'none';
  }

  function updateToggleButtons() {
    document.querySelectorAll('.toggle-btn[data-target]').forEach((btn) => {
      const win = document.getElementById(btn.dataset.target);
      if (!win) return;
      btn.classList.toggle('active', win.style.display !== 'none');
    });
  }

    // id → そのウィンドウを最前面へ出す関数(init内のクロージャを外から呼べるようにする)。
  // ★「パッド」ボタンのようにコードから開くウィンドウは、表示はされても他のウィンドウの
  //   背面に隠れることがある(zIndexはドラッグ/クリックのたびに増えて永続化されるため、
  //   一度も触っていないウィンドウのzは相対的に低いまま)。
  const frontFns = new Map();

  // ウィンドウの辺(上下左右)と角(左上/右上/左下)に細い枠を置き、ドラッグで大きさを変える。
  // 左/上の辺は反対側(右/下の端)を固定したまま広げる。最小サイズは CSS の min-width/min-height を守る。
  // 右下の角はブラウザ標準の resize: both のつまみ(従来どおり)
  function attachEdgeResize(win, bringToFront, persist) {
    const dirs = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw'];
    for (const d of dirs) {
      const h = document.createElement('div');
      h.className = 'fw-edge fw-edge--' + d;
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        bringToFront();
        const cs = getComputedStyle(win);
        const minW = parseFloat(cs.minWidth) || 120, minH = parseFloat(cs.minHeight) || 80;
        const x0 = e.clientX, y0 = e.clientY;
        const L0 = win.offsetLeft, T0 = win.offsetTop, W0 = win.offsetWidth, H0 = win.offsetHeight;
        const move = (ev) => {
          const dx = ev.clientX - x0, dy = ev.clientY - y0;
          let L = L0, T = T0, W = W0, H = H0;
          if (d.indexOf('e') >= 0) W = Math.max(minW, W0 + dx);
          if (d.indexOf('s') >= 0) H = Math.max(minH, H0 + dy);
          if (d.indexOf('w') >= 0) {
            W = Math.max(minW, W0 - dx);
            L = L0 + (W0 - W);
            if (L < 0) { W += L; L = 0; } // 画面の左へはみ出さないように
          }
          if (d.indexOf('n') >= 0) {
            H = Math.max(minH, H0 - dy);
            T = T0 + (H0 - H);
            if (T < 0) { H += T; T = 0; } // タイトル行が画面の上へ出ないように
          }
          win.style.left = L + 'px'; win.style.top = T + 'px';
          win.style.width = W + 'px'; win.style.height = H + 'px';
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          persist();
        };
        // 枠の外まで速く動かしても追えるよう、動きと離しは window で受ける
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      win.appendChild(h);
    }
  }

  function init() {
    let zCounter = 100;
    const windows = Array.from(document.querySelectorAll('.float-window'));

    windows.forEach((win) => {
      const id = win.id;
      const header = win.querySelector('.float-window-header');
      const closeBtn = win.querySelector('.float-window-close');

      const defaultLeft = parseInt(win.dataset.defaultLeft, 10) || 20;
      const defaultTop = parseInt(win.dataset.defaultTop, 10) || 90;
      const defaultWidth = parseInt(win.dataset.defaultWidth, 10) || 480;
      const defaultHeight = parseInt(win.dataset.defaultHeight, 10) || 400;
      const defaultVisible = win.dataset.alwaysVisible === 'true';

      const saved = loadLayout()[id] || {};

      win.style.left = (saved.left != null ? saved.left : defaultLeft) + 'px';
      win.style.top = (saved.top != null ? saved.top : defaultTop) + 'px';
      win.style.width = (saved.width != null ? saved.width : defaultWidth) + 'px';
      win.style.height = (saved.height != null ? saved.height : defaultHeight) + 'px';

      zCounter = Math.max(zCounter, (saved.z || 0) + 1);
      win.style.zIndex = String(saved.z || zCounter);

      setVisible(win, saved.visible != null ? saved.visible === true : defaultVisible);

      function persist() {
        const layout = loadLayout();
        const existing = layout[id] || {};
        const visible = win.style.display !== 'none';
        layout[id] = {
          left: visible ? win.offsetLeft : (existing.left != null ? existing.left : defaultLeft),
          top: visible ? win.offsetTop : (existing.top != null ? existing.top : defaultTop),
          width: visible ? win.offsetWidth : (existing.width != null ? existing.width : defaultWidth),
          height: visible ? win.offsetHeight : (existing.height != null ? existing.height : defaultHeight),
          visible: visible,
          z: parseInt(win.style.zIndex, 10) || 0
        };
        saveLayout(layout);
      }

      function bringToFront() {
        zCounter++;
        win.style.zIndex = String(zCounter);
        persist();
      }
      if (id) frontFns.set(id, bringToFront);

      // --- ドラッグ移動 ---
      let dragging = false;
      let startX = 0, startY = 0, origLeft = 0, origTop = 0;

      header.addEventListener('mousedown', (e) => {
        // タイトル行に埋め込まれた操作(閉じるボタン/アイコンボタン/チェックボックス/
        // セレクト/速度スライダー等)をクリックした時はウィンドウ移動を始めない
        if (e.target.closest('button, input, select, label')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        origLeft = win.offsetLeft;
        origTop = win.offsetTop;
        bringToFront();
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        let newLeft = origLeft + (e.clientX - startX);
        let newTop = origTop + (e.clientY - startY);
        newLeft = Math.max(0, Math.min(window.innerWidth - 60, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));
        win.style.left = newLeft + 'px';
        win.style.top = newTop + 'px';
      });

      window.addEventListener('mouseup', () => {
        if (dragging) {
          dragging = false;
          persist();
        }
      });

      win.addEventListener('mousedown', () => bringToFront());

      // --- 辺・角でのリサイズ(右下以外。2026-09-19 方針「普通のウィンドウと同じように」) ---
      attachEdgeResize(win, bringToFront, persist);

      // --- リサイズ（CSS resize: both）の状態保存 ---
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => persist());
        ro.observe(win);
      }

      // --- 閉じるボタン（存在する場合のみ） ---
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          setVisible(win, false);
          persist();
          updateToggleButtons();
        });
      }

      win._famimmlWindow = { persist, bringToFront };
    });

    // --- 表示/非表示トグルボタン ---
    document.querySelectorAll('.toggle-btn[data-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const win = document.getElementById(btn.dataset.target);
        if (!win || !win._famimmlWindow) return;
        const willShow = win.style.display === 'none';
        setVisible(win, willShow);
        if (willShow) win._famimmlWindow.bringToFront();
        win._famimmlWindow.persist();
        updateToggleButtons();
      });
    });

    updateToggleButtons();
  }

  // --- ペインスプリッター ---
  // .pane-splitter 要素をドラッグして上側ペインの高さを変更する。
  // 高さは localStorage に保存・復元される。

  const SPLITTER_KEY = 'famimml-splitter-v1';

  function loadSplitterHeights() {
    try { return JSON.parse(localStorage.getItem(SPLITTER_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveSplitterHeight(id, h) {
    const d = loadSplitterHeights();
    d[id] = h;
    try { localStorage.setItem(SPLITTER_KEY, JSON.stringify(d)); } catch (e) { /* ignore */ }
  }

  function initSplitters() {
    document.querySelectorAll('.pane-splitter').forEach(splitter => {
      const id = splitter.id;
      // 既定は「直前の兄弟=上側ペイン」の高さを変える。data-resize="next" を付けると
      // 「直後の兄弟=下側ペイン」を変える(上側がflexで伸び縮みする作りのとき。
      //  MMLエディタは下のログ欄を content 高さに固定し、エディタ側が余りを取る)
      const next = splitter.dataset.resize === 'next';
      const pane = next ? splitter.nextElementSibling : splitter.previousElementSibling;
      if (!pane) return;
      const minH = next ? 40 : 80;

      const saved = loadSplitterHeights()[id];
      if (saved != null) pane.style.height = saved + 'px';

      let dragging = false;
      let startY = 0, startH = 0;

      // pointer イベント(マウスと指の両方。2026-09-23: mouse 系だけだとスマホで動かせなかった)
      splitter.addEventListener('pointerdown', e => {
        if (e.button != null && e.button !== 0) return;
        dragging = true;
        startY = e.clientY;
        startH = pane.offsetHeight;
        splitter.classList.add('dragging');
        e.preventDefault();
        try { splitter.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      });

      splitter.addEventListener('pointermove', e => {
        if (!dragging) return;
        // 下側ペインを変える場合はドラッグ方向が逆(下へ引く=下側が縮む)
        const delta = next ? (startY - e.clientY) : (e.clientY - startY);
        pane.style.height = Math.max(minH, startH + delta) + 'px';
      });

      const end = () => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        if (id) saveSplitterHeight(id, pane.offsetHeight);
      };
      splitter.addEventListener('pointerup', end);
      splitter.addEventListener('pointercancel', end);
    });
  }

  window.MML = window.MML || {};
  /** 指定ウィンドウを最前面へ(id文字列か要素)。未登録なら何もしない */
  function bringToFront(idOrEl) {
    const id = typeof idOrEl === 'string' ? idOrEl : (idOrEl && idOrEl.id);
    const fn = id && frontFns.get(id);
    if (fn) fn();
  }

  window.MML.FloatingWindows = { init: init, initSplitters: initSplitters, bringToFront: bringToFront };
})();
