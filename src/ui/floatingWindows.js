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

      // --- ドラッグ移動 ---
      let dragging = false;
      let startX = 0, startY = 0, origLeft = 0, origTop = 0;

      header.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn) return;
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
      // スプリッターの直前の兄弟要素を上側ペインとして扱う
      const topPane = splitter.previousElementSibling;
      if (!topPane) return;

      const saved = loadSplitterHeights()[id];
      if (saved != null) topPane.style.height = saved + 'px';

      let dragging = false;
      let startY = 0, startH = 0;

      splitter.addEventListener('mousedown', e => {
        dragging = true;
        startY = e.clientY;
        startH = topPane.offsetHeight;
        splitter.classList.add('dragging');
        e.preventDefault();
      });

      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const newH = Math.max(80, startH + (e.clientY - startY));
        topPane.style.height = newH + 'px';
      });

      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        if (id) saveSplitterHeight(id, topPane.offsetHeight);
      });
    });
  }

  window.MML = window.MML || {};
  window.MML.FloatingWindows = { init: init, initSplitters: initSplitters };
})();
