/*
 * MMLエディタの表示設定: フォント(ファミリー/サイズ)+配色(プリセット5種+個別カスタマイズ)
 * MML.UI.EditorSettings.init() -> トップメニューのフォント選択/設定ボタンを配線し、
 *   保存済みのフォント/配色をlocalStorageから復元して即適用する。main.jsから起動時に1回呼ぶ。
 *
 * 配色は:rootのCSSカスタムプロパティ(src/css/style.css)を書き換えることで反映する。
 * 「全体」7項目(--bg/--panel/--mml-editor-bg/--border/--text/--accent/--error)と
 * 「MMLエディタ」12項目(--tok-*、src/mml/syntaxHighlight.js参照)の計19変数を持つ。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => MML.I18n.t(key, params);

  const FONT_KEY = 'mml_editorFont';
  const UI_COLOR_KEY = 'mml_uiColors';
  const TOKEN_COLOR_KEY = 'mml_tokenColors';
  const PRESET_KEY = 'mml_colorPreset';

  const FONT_FAMILIES = [
    { value: 'var(--mono)', label: '既定' },
    { value: "'Consolas', var(--mono)", label: 'Consolas' },
    { value: "'Courier New', var(--mono)", label: 'Courier New' },
    { value: "'BIZ UDGothic', var(--mono)", label: 'BIZ UDGothic' },
    { value: "'MS Gothic', var(--mono)", label: 'MSゴシック' },
    { value: "'Yu Gothic UI', var(--mono)", label: '游ゴシック UI' },
    { value: 'monospace', label: 'monospace(総称)' },
  ];
  const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

  const UI_VARS = [
    ['--bg', 'ページ背景'],
    ['--panel', 'パネル背景'],
    ['--mml-editor-bg', 'エディタ背景'],
    ['--border', '境界線'],
    ['--text', '文字'],
    ['--accent', 'アクセント'],
    ['--error', 'エラー'],
  ];
  const TOKEN_VARS = [
    ['--tok-header', 'ヘッダー系(#...)'],
    ['--tok-track', 'トラックヘッダー'],
    ['--tok-note', '音階と音長'],
    ['--tok-rest', '休符'],
    ['--tok-cmd-length', '音長系'],
    ['--tok-cmd-volume', '音量系'],
    ['--tok-cmd-pitch', '音程系'],
    ['--tok-cmd-perf', '演奏制御系'],
    ['--tok-cmd-special', '特殊'],
    ['--tok-def-envelope', 'エンベロープデータ定義'],
    ['--tok-def-tone', '音色データ定義'],
    ['--tok-comment', 'コメント'],
  ];

  const PRESETS = [
    {
      id: 'default', name: '既定(ダーク)',
      ui: {
        '--bg': '#1e1e24', '--panel': '#2a2a33', '--mml-editor-bg': '#14141a',
        '--border': '#3d3d4a', '--text': '#e6e6ef', '--accent': '#6fb1ff', '--error': '#ff6b6b',
      },
      tokens: {
        '--tok-header': '#59a869', '--tok-track': '#ffd479', '--tok-note': '#6fb1ff',
        '--tok-rest': '#9aa0ac', '--tok-cmd-length': '#f78c6c', '--tok-cmd-volume': '#82d2ce',
        '--tok-cmd-pitch': '#c792ea', '--tok-cmd-perf': '#ff6b6b', '--tok-cmd-special': '#ffcc66',
        '--tok-def-envelope': '#66d9ef', '--tok-def-tone': '#a6e22e', '--tok-comment': '#6a737d',
      },
    },
    {
      id: 'light', name: 'ライト',
      ui: {
        '--bg': '#f4f4f8', '--panel': '#e6e6ee', '--mml-editor-bg': '#ffffff',
        '--border': '#c7c7d3', '--text': '#202028', '--accent': '#2f6fce', '--error': '#c62828',
      },
      tokens: {
        '--tok-header': '#1a7a34', '--tok-track': '#b8860b', '--tok-note': '#1a56c4',
        '--tok-rest': '#6b7280', '--tok-cmd-length': '#b45309', '--tok-cmd-volume': '#0e7d75',
        '--tok-cmd-pitch': '#7a3fa0', '--tok-cmd-perf': '#c0392b', '--tok-cmd-special': '#a06600',
        '--tok-def-envelope': '#0f7ea3', '--tok-def-tone': '#3f8f1f', '--tok-comment': '#7a7a85',
      },
    },
    {
      id: 'solarized', name: 'Solarized Dark',
      ui: {
        '--bg': '#002b36', '--panel': '#073642', '--mml-editor-bg': '#00252e',
        '--border': '#586e75', '--text': '#93a1a1', '--accent': '#268bd2', '--error': '#dc322f',
      },
      tokens: {
        '--tok-header': '#b58900', '--tok-track': '#cb4b16', '--tok-note': '#268bd2',
        '--tok-rest': '#657b83', '--tok-cmd-length': '#6c71c4', '--tok-cmd-volume': '#2aa198',
        '--tok-cmd-pitch': '#d33682', '--tok-cmd-perf': '#dc322f', '--tok-cmd-special': '#93a1a1',
        '--tok-def-envelope': '#859900', '--tok-def-tone': '#b58900', '--tok-comment': '#586e75',
      },
    },
    {
      id: 'monokai', name: 'Monokai',
      ui: {
        '--bg': '#272822', '--panel': '#3e3d32', '--mml-editor-bg': '#1e1f1c',
        '--border': '#49483e', '--text': '#f8f8f2', '--accent': '#66d9ef', '--error': '#f92672',
      },
      tokens: {
        '--tok-header': '#a6e22e', '--tok-track': '#e6db74', '--tok-note': '#66d9ef',
        '--tok-rest': '#75715e', '--tok-cmd-length': '#fd971f', '--tok-cmd-volume': '#ae81ff',
        '--tok-cmd-pitch': '#f92672', '--tok-cmd-perf': '#ff6188', '--tok-cmd-special': '#e6db74',
        '--tok-def-envelope': '#a1efe4', '--tok-def-tone': '#a6e22e', '--tok-comment': '#75715e',
      },
    },
    {
      id: 'highContrast', name: '高コントラスト',
      ui: {
        '--bg': '#000000', '--panel': '#101010', '--mml-editor-bg': '#000000',
        '--border': '#ffffff', '--text': '#ffffff', '--accent': '#ffff00', '--error': '#ff3333',
      },
      tokens: {
        '--tok-header': '#00ff00', '--tok-track': '#ffff00', '--tok-note': '#00ffff',
        '--tok-rest': '#ffffff', '--tok-cmd-length': '#ff8800', '--tok-cmd-volume': '#00ff88',
        '--tok-cmd-pitch': '#ff00ff', '--tok-cmd-perf': '#ff3333', '--tok-cmd-special': '#ffaa00',
        '--tok-def-envelope': '#00aaff', '--tok-def-tone': '#aaff00', '--tok-comment': '#aaaaaa',
      },
    },
  ];
  const DEFAULT_PRESET = PRESETS[0];

  function loadJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private browsing等は無視 */ }
  }
  function applyVars(map) {
    if (!map) return;
    for (const k of Object.keys(map)) document.documentElement.style.setProperty(k, map[k]);
  }
  function currentVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  let _activePreset = 'default';

  function applyPreset(preset, persist) {
    applyVars(preset.ui);
    applyVars(preset.tokens);
    if (persist !== false) {
      saveJson(UI_COLOR_KEY, preset.ui);
      saveJson(TOKEN_COLOR_KEY, preset.tokens);
      try { localStorage.setItem(PRESET_KEY, preset.id); } catch (e) { /* ignore */ }
    }
    _activePreset = preset.id;
  }

  function applySavedColors() {
    const savedUi = loadJson(UI_COLOR_KEY);
    const savedTokens = loadJson(TOKEN_COLOR_KEY);
    if (savedUi) applyVars(savedUi);
    if (savedTokens) applyVars(savedTokens);
    let preset = null;
    try { preset = localStorage.getItem(PRESET_KEY); } catch (e) { /* ignore */ }
    _activePreset = preset || ((savedUi || savedTokens) ? 'custom' : 'default');
  }

  // ── フォント ──────────────────────────────────────────
  function applyFont(family, size) {
    document.documentElement.style.setProperty('--mml-font-family', family);
    document.documentElement.style.setProperty('--mml-font-size', size + 'px');
  }

  function initFontControls() {
    const familySel = document.getElementById('mmlFontFamily');
    const sizeSel = document.getElementById('mmlFontSize');
    if (!familySel || !sizeSel) return;

    familySel.innerHTML = FONT_FAMILIES.map((f) =>
      `<option value="${f.value.replace(/"/g, '&quot;')}">${T(f.label)}</option>`).join('');
    sizeSel.innerHTML = FONT_SIZES.map((s) => `<option value="${s}">${s}px</option>`).join('');

    const saved = loadJson(FONT_KEY);
    const family = (saved && saved.family) || FONT_FAMILIES[0].value;
    const size = (saved && saved.size) || 13;
    familySel.value = family;
    sizeSel.value = String(size);
    applyFont(family, size);

    const onChange = () => {
      const fam = familySel.value;
      const sz = Number(sizeSel.value) || 13;
      applyFont(fam, sz);
      saveJson(FONT_KEY, { family: fam, size: sz });
    };
    familySel.addEventListener('change', onChange);
    sizeSel.addEventListener('change', onChange);
  }

  // ── カラー設定モーダル ────────────────────────────────
  let _modalEl = null;
  function closeModal() {
    if (_modalEl) { _modalEl.remove(); _modalEl = null; }
    UI.ColorPicker.close();
  }

  function setColorVar(varName, storageKey, value) {
    document.documentElement.style.setProperty(varName, value);
    const map = loadJson(storageKey) || {};
    map[varName] = value;
    saveJson(storageKey, map);
    _activePreset = 'custom';
    try { localStorage.setItem(PRESET_KEY, 'custom'); } catch (e) { /* ignore */ }
    updatePresetIndicator();
  }

  function updatePresetIndicator() {
    if (!_modalEl) return;
    _modalEl.querySelectorAll('.es-preset').forEach((el) => {
      el.classList.toggle('es-preset--active', el.dataset.presetId === _activePreset);
    });
    const customLabel = _modalEl.querySelector('.es-preset--custom');
    if (customLabel) customLabel.style.display = _activePreset === 'custom' ? '' : 'none';
  }

  function refreshSwatches() {
    if (!_modalEl) return;
    _modalEl.querySelectorAll('.es-swatch').forEach((sw) => {
      sw.style.background = currentVar(sw.dataset.var);
    });
  }

  function buildRow(varName, label, storageKey, defaultValue) {
    const row = document.createElement('div');
    row.className = 'es-row';
    const lab = document.createElement('span');
    lab.className = 'es-row-label';
    lab.textContent = T(label);
    const sw = document.createElement('span');
    sw.className = 'es-swatch';
    sw.dataset.var = varName;
    sw.style.background = currentVar(varName) || defaultValue;
    sw.addEventListener('click', () => {
      UI.ColorPicker.open(sw, currentVar(varName) || defaultValue,
        (color) => { sw.style.background = color; setColorVar(varName, storageKey, color); },
        () => { sw.style.background = defaultValue; setColorVar(varName, storageKey, defaultValue); });
    });
    row.appendChild(lab);
    row.appendChild(sw);
    return row;
  }

  function buildPresetButton(preset) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'es-preset';
    btn.dataset.presetId = preset.id;
    const swatches = ['--bg', '--tok-note', '--tok-cmd-pitch', '--tok-cmd-volume']
      .map((k) => `<span style="background:${preset.ui[k] || preset.tokens[k]}"></span>`).join('');
    btn.innerHTML = `<span class="es-preset-swatches">${swatches}</span>` +
      `<span class="es-preset-name">${T(preset.name)}</span>`;
    btn.addEventListener('click', () => {
      applyPreset(preset);
      refreshSwatches();
      updatePresetIndicator();
    });
    return btn;
  }

  function openModal() {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'es-backdrop';

    const modal = document.createElement('div');
    modal.className = 'es-modal';

    const header = document.createElement('div');
    header.className = 'es-modal-header';
    const title = document.createElement('span');
    title.textContent = T('カラー設定');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'es-modal-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', T('閉じる'));
    closeBtn.addEventListener('click', closeModal);
    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'es-modal-body';

    const presetSection = document.createElement('div');
    presetSection.className = 'es-section';
    const presetHeading = document.createElement('h3');
    presetHeading.textContent = T('プリセット');
    const customLabel = document.createElement('span');
    customLabel.className = 'es-preset--custom';
    customLabel.textContent = ' (' + T('カスタム') + ')';
    customLabel.style.display = 'none';
    presetHeading.appendChild(customLabel);
    presetSection.appendChild(presetHeading);
    const presetRow = document.createElement('div');
    presetRow.className = 'es-preset-row';
    for (const preset of PRESETS) presetRow.appendChild(buildPresetButton(preset));
    presetSection.appendChild(presetRow);
    body.appendChild(presetSection);

    const uiSection = document.createElement('div');
    uiSection.className = 'es-section';
    const uiHeading = document.createElement('h3');
    uiHeading.textContent = T('全体の配色');
    uiSection.appendChild(uiHeading);
    for (const [varName, label] of UI_VARS) {
      uiSection.appendChild(buildRow(varName, label, UI_COLOR_KEY, DEFAULT_PRESET.ui[varName]));
    }
    body.appendChild(uiSection);

    const tokSection = document.createElement('div');
    tokSection.className = 'es-section';
    const tokHeading = document.createElement('h3');
    tokHeading.textContent = T('MMLエディタの配色');
    tokSection.appendChild(tokHeading);
    for (const [varName, label] of TOKEN_VARS) {
      tokSection.appendChild(buildRow(varName, label, TOKEN_COLOR_KEY, DEFAULT_PRESET.tokens[varName]));
    }
    body.appendChild(tokSection);

    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'es-modal-footer';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = T('既定値に戻す');
    resetBtn.addEventListener('click', () => {
      applyPreset(DEFAULT_PRESET);
      refreshSwatches();
      updatePresetIndicator();
    });
    footer.appendChild(resetBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
    document.body.appendChild(backdrop);
    _modalEl = backdrop;
    updatePresetIndicator();
  }

  function initSettingsButton() {
    const btn = document.getElementById('btnEditorSettings');
    if (btn) btn.addEventListener('click', openModal);
  }

  UI.EditorSettings = {
    init() {
      applySavedColors();
      initFontControls();
      initSettingsButton();
    },
  };
})(window);
