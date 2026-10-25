/*
 * 動画書き出しパネル MML.UI.VideoExportPanel(浮動ウィンドウ #win-video の中身)
 *
 *   init(hostEl, hooks)   hooks = {
 *     getSource()                       -> { compiled, source, cap, chips, tuning, title, subtitle, followCh, seconds } | null
 *                                          (プレビュー用。cap は音声なしの即席スナップショットでよい)
 *     runExport(opt, onStatus, signal)  -> Promise<filename>(本番。opt は本パネルの設定+seconds)
 *     isChannelMuted(ch)                -> boolean
 *     keyboardDisplay                   -> 鍵盤表示のインスタンス(renderExportFrame)
 *   }
 *   open({ seconds })     ウィンドウを出して設定とプレビューを更新する
 *   refresh()             MML が変わったときにプレビューを描き直す(main.js が呼ぶ)
 *
 * 設定は localStorage(mml_videoExport)に保存する。画面構成は MML.Video.LAYOUTS から選ぶ。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);
  const STORAGE_KEY = 'mml_videoExport';

  const DEFAULTS = {
    resolution: '1280x720', fps: 30, layout: 'roll-editor-v', rollOrientation: 'vertical', split: 60,
    scale: 1, editorFontPx: 18, showTitle: true, quality: 'normal',
    // 「エディタ」の区画に出すもの(2026-10-25): 'editor'(MMLエディタ) | 'score'(楽譜)。楽譜の形と色は
    // 楽譜ウィンドウと同じ選択肢(既定は楽譜ウィンドウで選んでいるもの。loadで決める)
    pane2: 'editor', scoreMode: null, scoreStyle: null,
  };
  // ビットレート(bps)。X は最大 25Mbps あたりまで受け付けるはず(推定)。720p30 で 6M は十分きれい
  function bitrateFor(width, height, fps, quality) {
    const base = (width * height) / (1280 * 720) * 6e6 * (fps > 30 ? 1.5 : 1);
    return Math.round(base * (quality === 'high' ? 1.6 : 1));
  }

  let host = null, hooks = null, settings = null;
  let els = {};
  let scene = null, scenePreviewT = 0, sourceCache = null;
  let exporting = null; // { controller }

  function load() {
    let s;
    try { s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch (e) { s = Object.assign({}, DEFAULTS); }
    // 楽譜の形・色をまだ選んでいなければ、楽譜ウィンドウで選んでいるものから始める
    const sv = document.getElementById('scoreView');
    const view = sv && sv._scoreView;
    if (!s.scoreMode) s.scoreMode = (view && view.getMode && view.getMode()) || 'all';
    if (!s.scoreStyle) s.scoreStyle = (view && view.getStyle && view.getStyle()) || 'color';
    return s;
  }
  function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } }

  function optionsHtml(list, cur) {
    return list.map(([v, label]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${T(label)}</option>`).join('');
  }

  function build() {
    const s = settings;
    host.innerHTML =
      `<div class="vx-form">` +
        `<label>${T('解像度')}<select data-k="resolution">${optionsHtml(MML.Video.RESOLUTIONS, s.resolution)}</select></label>` +
        `<label>${T('フレームレート')}<select data-k="fps">${optionsHtml([[30, '30 fps'], [60, '60 fps']], s.fps)}</select></label>` +
        `<label>${T('画面構成')}<select data-k="layout">${optionsHtml(MML.Video.LAYOUTS, s.layout)}</select></label>` +
        `<label>${T('ロールの向き')}<select data-k="rollOrientation">${optionsHtml([['vertical', '縦(音符が降る・鍵盤が下)'], ['horizontal', '横(音符が流れる・鍵盤が左)']], s.rollOrientation)}</select></label>` +
        `<label>${T('ロールの割合')}<input type="range" data-k="split" min="20" max="80" step="5" value="${s.split}"><span class="vx-split-val">${s.split}%</span></label>` +
        `<label>${T('ロールの描画倍率')}<select data-k="scale">${optionsHtml([[1, '1×'], [1.5, '1.5×'], [2, '2×']], s.scale)}</select></label>` +
        `<label>${T('エディタの区画に出すもの')}<select data-k="pane2">${optionsHtml([['editor', 'MMLエディタ'], ['score', '楽譜']], s.pane2)}</select></label>` +
        `<label>${T('楽譜の形')}<select data-k="scoreMode">${optionsHtml([['all', '全パート(1chごとに1段)'], ['piano', 'ピアノ2段(+打楽器)']], s.scoreMode)}</select></label>` +
        `<label>${T('楽譜の色')}<select data-k="scoreStyle">${optionsHtml([['color', 'カラー'], ['mono', 'モノクロ(白地に黒)']], s.scoreStyle)}</select></label>` +
        `<label>${T('エディタの文字サイズ')}<input type="number" data-k="editorFontPx" min="8" max="64" step="1" value="${s.editorFontPx}"><span>px</span></label>` +
        `<label>${T('画質')}<select data-k="quality">${optionsHtml([['normal', '標準'], ['high', '高画質']], s.quality)}</select></label>` +
        `<label><input type="checkbox" data-k="showTitle"${s.showTitle ? ' checked' : ''}>${T('タイトルと時間を上に出す')}</label>` +
        `<label>${T('長さ(秒)')}<input type="number" class="vx-seconds" min="1" max="3600" step="1" value="${s.seconds || 60}"></label>` +
      `</div>` +
      `<div class="vx-preview-wrap">` +
        `<canvas class="vx-preview"></canvas>` +
        `<div class="vx-preview-ctl"><input type="range" class="vx-time" min="0" max="60" step="0.05" value="0"><span class="vx-time-val">0.0s</span></div>` +
      `</div>` +
      `<div class="vx-actions">` +
        `<button type="button" class="vx-run">${T('MP4 を書き出す')}</button>` +
        `<button type="button" class="vx-abort secondary" style="display:none">${T('中止')}</button>` +
        `<span class="vx-status"></span>` +
      `</div>` +
      `<div class="vx-note vx-src-note"></div>` +
      `<div class="vx-note">${T('H.264 + AAC の MP4。X(Twitter)などにそのまま貼り付けられる形式です。追随するチャンネルはエディタの「追尾」で選んだものになります。')}</div>`;
    els = {
      preview: host.querySelector('.vx-preview'), time: host.querySelector('.vx-time'), timeVal: host.querySelector('.vx-time-val'),
      seconds: host.querySelector('.vx-seconds'), run: host.querySelector('.vx-run'), abort: host.querySelector('.vx-abort'),
      status: host.querySelector('.vx-status'), splitVal: host.querySelector('.vx-split-val'),
    };
    for (const el of host.querySelectorAll('[data-k]')) {
      el.addEventListener('input', () => {
        const k = el.dataset.k;
        if (el.type === 'checkbox') settings[k] = el.checked;
        else if (el.type === 'number' || el.type === 'range' || k === 'fps' || k === 'scale') settings[k] = Number(el.value);
        else settings[k] = el.value;
        if (k === 'split') els.splitVal.textContent = settings.split + '%';
        save();
        rebuildScene();
      });
    }
    els.seconds.addEventListener('change', () => {
      settings.seconds = Math.max(1, Math.min(3600, parseInt(els.seconds.value, 10) || 1));
      els.seconds.value = String(settings.seconds);
      save();
      els.time.max = String(settings.seconds);
      rebuildScene();
    });
    els.time.addEventListener('input', () => { scenePreviewT = Number(els.time.value); drawPreview(); });
    els.run.addEventListener('click', runExport);
    els.abort.addEventListener('click', () => { if (exporting) exporting.controller.abort(); });
  }

  function currentOpt() {
    const [w, h] = String(settings.resolution).split('x').map(Number);
    return {
      width: w, height: h, fps: settings.fps, layout: settings.layout, rollOrientation: settings.rollOrientation,
      split: settings.split / 100, scale: settings.scale, editorFontPx: settings.editorFontPx, showTitle: settings.showTitle,
      pane2: settings.pane2, scoreMode: settings.scoreMode, scoreStyle: settings.scoreStyle,
      bitrate: bitrateFor(w, h, settings.fps, settings.quality), durationSeconds: settings.seconds || 60,
    };
  }

  function rebuildScene() {
    scene = null;
    if (!host || host.offsetParent === null) return; // 閉じている間は描かない
    sourceCache = hooks.getSource ? hooks.getSource() : null;
    // ファイル再生: エディタ区画は無い(ロールのみ)。描ける長さは先読み済みの範囲まで
    const srcNote = host.querySelector('.vx-src-note');
    if (srcNote) {
      srcNote.textContent = (sourceCache && sourceCache.source == null)
        ? T('ファイル再生: MMLエディタの区画は無いのでロールのみで描きます。長さは先読み済みの {sec} 秒まで', { sec: Math.floor(sourceCache.maxSeconds || 0) })
        : '';
    }
    if (!sourceCache) { drawPreview(); return; }
    try {
      scene = MML.Video.createScene(Object.assign(currentOpt(), sourceCache, {
        keyboardDisplay: hooks.keyboardDisplay, isChannelMuted: hooks.isChannelMuted,
      }));
    } catch (e) { console.error('動画プレビューの構築に失敗:', e); scene = null; }
    drawPreview();
  }

  let lastDrawnT = -1;
  function drawPreview() {
    const c = els.preview;
    if (!c) return;
    els.timeVal.textContent = scenePreviewT.toFixed(1) + 's';
    if (!scene) {
      c.width = 320; c.height = 180;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#888'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(T('MML をコンパイルできるとプレビューが出ます'), c.width / 2, c.height / 2);
      return;
    }
    // 巻き戻しは createScene 側が検出して走査起点を戻す
    scene.draw(c, scenePreviewT);
    lastDrawnT = scenePreviewT;
  }

  async function runExport() {
    if (exporting || !hooks.runExport) return;
    const controller = new AbortController();
    exporting = { controller };
    els.run.disabled = true;
    els.abort.style.display = '';
    const onStatus = (text) => { els.status.textContent = text; };
    try {
      const file = await hooks.runExport(currentOpt(), onStatus, controller.signal);
      onStatus(T('書き出し完了: {file}', { file }));
    } catch (e) {
      console.error(e);
      onStatus(T('書き出しに失敗しました: {msg}', { msg: e && e.message ? e.message : String(e) }));
    } finally {
      exporting = null;
      els.run.disabled = false;
      els.abort.style.display = 'none';
    }
  }

  function init(hostEl, h) {
    host = hostEl; hooks = h || {};
    settings = load();
    build();
    // 言語切替で作り直す
    if (MML.I18n && MML.I18n.onChange) MML.I18n.onChange(() => { build(); rebuildScene(); });
  }

  function open(o) {
    if (!host) return;
    if (o && o.seconds > 0) { settings.seconds = Math.round(o.seconds); els.seconds.value = String(settings.seconds); save(); }
    els.time.max = String(settings.seconds || 60);
    const w = document.getElementById('win-video');
    if (w && getComputedStyle(w).display === 'none') {
      const btn = document.querySelector('.toggle-btn[data-target="win-video"]');
      if (btn) btn.click(); else w.style.display = 'flex';
    }
    if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-video');
    rebuildScene();
  }

  UI.VideoExportPanel = { init, open, refresh: rebuildScene };
})(window);
