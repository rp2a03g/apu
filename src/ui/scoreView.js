/*
 * 楽譜ウィンドウ(本記譜、ROADMAP「フェーズ外: 楽譜出力」段階4、2026-09-16)
 *
 * MML のコンパイル結果から作った表記モデル(src/score/notation.js)を、記譜間隔で段組みした
 * 五線譜(src/score/engrave.js)として描く。鍵盤表示の「楽譜モード」(時間比例)とは別物で、
 * こちらは紙の楽譜と同じ見た目。再生位置は縦線のカーソル(DOM要素、canvas は描き直さない)で示し、
 * 「再生に追従」ONならカーソルの段が見えるようにスクロールする。
 *
 *   view = new MML.UI.ScoreView(container)
 *   view.setScore(score|null)   score = { notation, fps, loopPointFrame, totalFrames }(鍵盤表示の setScore と同じ物)
 *   view.setFrame(frame)        再生位置(コンパイラのフレーム。-1=停止)
 *   view.colorOf = (letter) => 色   パート(チャンネル文字)の色。省略時は白
 *   view.onExport = () => {}     「MusicXML」ボタン
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const SP_KEY = 'mml_scoreView_sp';
  const MODE_KEY = 'mml_scoreView_mode';
  const SP_MIN = 4, SP_MAX = 14, SP_DEFAULT = 7;
  const MAX_CANVAS_PX = 30000; // ブラウザの canvas 高さ上限(32767)の手前

  class ScoreView {
    constructor(container) {
      this.container = container;
      container._scoreView = this; // 検証用の逆参照(鍵盤表示の _kbdInstance と同じ流儀)
      this._score = null;
      this._layout = null;
      this._frame = -1;
      this._lastSystem = -1;
      this.colorOf = null;
      this.onExport = null;
      let sp = SP_DEFAULT;
      try { sp = parseFloat(localStorage.getItem(SP_KEY)) || SP_DEFAULT; } catch (e) { /* ignore */ }
      this._sp = Math.max(SP_MIN, Math.min(SP_MAX, sp));
      this._follow = true;

      container.classList.add('score-view');
      container.innerHTML =
        `<div class="score-view-bar">` +
          `<button type="button" class="score-zoom-out secondary" title="${T('縮小')}">−</button>` +
          `<span class="score-zoom-val"></span>` +
          `<button type="button" class="score-zoom-in secondary" title="${T('拡大')}">+</button>` +
          `<select class="score-mode" title="${T('楽譜の形')}">` +
            `<option value="all">${T('全パート(1chごとに1段)')}</option>` +
            `<option value="piano">${T('ピアノ2段(+打楽器)')}</option>` +
          `</select>` +
          `<label class="score-follow-label"><input type="checkbox" class="score-follow" checked>${T('再生に追従')}</label>` +
          `<span class="score-info"></span>` +
          `<button type="button" class="score-export secondary" title="${T('楽譜(MusicXML)出力')}">MusicXML</button>` +
        `</div>` +
        `<div class="score-view-scroll">` +
          `<div class="score-view-empty">${T('MMLを再生すると、その曲の楽譜がここに出ます')}</div>` +
          `<canvas class="score-view-canvas"></canvas>` +
          `<div class="score-view-cursor" style="display:none"></div>` +
        `</div>`;
      this._scrollEl = container.querySelector('.score-view-scroll');
      this._canvas = container.querySelector('.score-view-canvas');
      this._cursorEl = container.querySelector('.score-view-cursor');
      this._emptyEl = container.querySelector('.score-view-empty');
      this._infoEl = container.querySelector('.score-info');
      this._zoomValEl = container.querySelector('.score-zoom-val');
      container.querySelector('.score-zoom-out').addEventListener('click', () => this.setZoom(this._sp - 1));
      container.querySelector('.score-zoom-in').addEventListener('click', () => this.setZoom(this._sp + 1));
      const follow = container.querySelector('.score-follow');
      follow.addEventListener('change', () => { this._follow = follow.checked; });
      // 楽譜の形: 'all'(1chごとに1段) | 'piano'(右手/左手の2段+打楽器、Score.buildPianoNotation)。localStorage に残す
      this._modeEl = container.querySelector('.score-mode');
      this._mode = 'all';
      try { const m = localStorage.getItem(MODE_KEY); if (m === 'piano' || m === 'all') this._mode = m; } catch (e) { /* ignore */ }
      this._modeEl.value = this._mode;
      this._modeEl.addEventListener('change', () => {
        this._mode = this._modeEl.value === 'piano' ? 'piano' : 'all';
        try { localStorage.setItem(MODE_KEY, this._mode); } catch (e) { /* ignore */ }
        this._lastSystem = -1;
        this._relayout();
      });
      container.querySelector('.score-export').addEventListener('click', () => { if (this.onExport) this.onExport(this._mode); });
      // 幅が変わったら段組みし直す(表示中だけ。非表示のときは次に見えたときに描く)
      this._lastWidth = 0;
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this._maybeRelayout());
        this._ro.observe(this._scrollEl);
      }
      this._renderZoom();
    }

    setZoom(sp) {
      this._sp = Math.max(SP_MIN, Math.min(SP_MAX, Math.round(sp)));
      try { localStorage.setItem(SP_KEY, String(this._sp)); } catch (e) { /* ignore */ }
      this._renderZoom();
      this._relayout();
    }
    _renderZoom() { this._zoomValEl.textContent = Math.round(this._sp / SP_DEFAULT * 100) + '%'; }

    // score = { notation, compiled, fps, loopPointFrame, totalFrames }。ピアノ2段は compiled から作り直す
    setScore(score) {
      this._score = score && score.notation ? score : null;
      this._pianoNotation = null;
      this._lastSystem = -1;
      this._relayout();
    }
    getMode() { return this._mode; }
    // 今の形の表記モデル(ピアノ2段は初回だけ組み立ててキャッシュ)
    _currentNotation() {
      const sc = this._score;
      if (!sc) return null;
      if (this._mode !== 'piano' || !sc.compiled) return sc.notation;
      if (!this._pianoNotation) this._pianoNotation = MML.Score.buildPianoNotation(sc.compiled, {});
      return this._pianoNotation;
    }

    // 表示幅が変わったときだけ段組みし直す(ResizeObserver から)
    _maybeRelayout() {
      const w = this._scrollEl.clientWidth;
      if (w > 0 && w !== this._lastWidth && this._score) this._relayout();
    }

    _relayout() {
      const score = this._score;
      const w = this._scrollEl.clientWidth;
      this._emptyEl.style.display = score ? 'none' : '';
      this._canvas.style.display = score ? '' : 'none';
      this._cursorEl.style.display = 'none';
      if (!score || w <= 0) { this._layout = null; this._infoEl.textContent = ''; return; }
      this._lastWidth = w;
      const canvas = this._canvas;
      const ctx = canvas.getContext('2d');
      const width = Math.max(240, w - 12);
      const measureText = (s, px) => { ctx.font = `${px}px system-ui, sans-serif`; return ctx.measureText(s).width; };
      let layout, notation;
      try {
        notation = this._currentNotation();
        layout = MML.Score.layoutScore(notation, { sp: this._sp, width, measureText });
      } catch (e) {
        console.warn('楽譜の段組みに失敗:', e);
        this._layout = null;
        this._infoEl.textContent = T('楽譜の組み立てに失敗しました(内部エラー):') + ' ' + (e && e.message ? e.message : e);
        return;
      }
      this._layout = layout;
      let dpr = Math.max(1, Math.min(2, global.devicePixelRatio || 1));
      let height = layout.height;
      if (height * dpr > MAX_CANVAS_PX) dpr = 1;
      let clipped = false;
      if (height > MAX_CANVAS_PX) { height = MAX_CANVAS_PX; clipped = true; }
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const colorOf = (letter) => (this.colorOf && this.colorOf(letter)) || '#e6e6ef';
      MML.Score.drawScore(ctx, layout, { colorOf, staffColor: '#8a8aa0', textColor: '#e6e6ef' });
      const n = notation;
      const measures = n.parts.length ? n.parts[0].measures.length : 0;
      let info = T('{parts}パート / {measures}小節 / 拍子 {time} / 調号 {key}', {
        parts: n.parts.length, measures, time: n.time.beats + '/' + n.time.beatType,
        key: n.key.estimated ? T('{n}(推定)', { n: n.key.fifths }) : String(n.key.fifths)
      });
      if (n.piano) info += ' / ' + T('右手 {rh} / 左手 {lh}', { rh: n.piano.rh.join('') || '-', lh: n.piano.lh.join('') || '-' });
      this._infoEl.textContent = info + (clipped ? ' ' + T('(長すぎるため途中まで)') : '');
      this._placeCursor(true);
    }

    // 再生位置(コンパイラのフレーム)。停止中は -1
    setFrame(frame) {
      this._frame = frame == null ? -1 : frame;
      this._placeCursor(false);
    }

    _placeCursor(force) {
      const layout = this._layout;
      const el = this._cursorEl;
      if (!layout || this._frame < 0) { el.style.display = 'none'; this._lastSystem = -1; return; }
      // ループ地点(L)より後ろの末尾複製区間は、ループ地点からの相対位置へ戻す(鍵盤表示の楽譜モードと同じ)
      let frame = this._frame;
      const sc = this._score;
      if (sc.loopPointFrame != null && sc.totalFrames > 0) {
        const natural = (sc.totalFrames + sc.loopPointFrame) / 2;
        const loopLen = natural - sc.loopPointFrame;
        if (loopLen > 0 && frame >= natural) frame = sc.loopPointFrame + ((frame - natural) % loopLen);
      }
      const c = MML.Score.cursorAtFrame(layout, frame);
      if (!c) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = Math.round(c.x) + 'px';
      el.style.top = Math.round(c.y0) + 'px';
      el.style.height = Math.round(c.y1 - c.y0) + 'px';
      // 追従: 段が変わったとき(または強制時)にその段が見えるようスクロール
      if (this._follow && (force || c.system !== this._lastSystem)) {
        const sEl = this._scrollEl;
        const top = c.y0 - 12, bottom = c.y1 + 12;
        if (top < sEl.scrollTop || bottom > sEl.scrollTop + sEl.clientHeight) sEl.scrollTop = Math.max(0, top - 8);
      }
      this._lastSystem = c.system;
    }
  }

  UI.ScoreView = ScoreView;
})(window);
