/*
 * MMLエディタの表示設定: フォント(ファミリー/サイズ)+配色(プリセット5種+個別カスタマイズ)
 * MML.UI.EditorSettings.init() -> トップメニューのフォント選択/設定ボタンを配線し、
 *   保存済みのフォント/配色をlocalStorageから復元して即適用する。main.jsから起動時に1回呼ぶ。
 *
 * 配色は:rootのCSSカスタムプロパティ(src/css/style.css)を書き換えることで反映する。
 * 「全体」16項目(--bg/--panel/--panel-raised/--surface/--mml-editor-bg/--mml-editor-fg/
 * --border/--control-bg/--text/--text-secondary/--text-muted/--text-faint/--accent/
 * --on-accent/--error/--ok。加えて設定UIには出さない--hover-bg)と
 * 「MMLエディタ」14項目(--tok-*の12分類+再生位置ハイライトの文字/縁取り、
 * src/mml/syntaxHighlight.js参照)を持つ。
 *
 * ★PRESETS[0](デフォルト)の値はstyle.cssの:root既定値と必ず一致させること
 * (起動直後の見た目と「既定値に戻す」の結果が食い違わないようにするため)。
 * ★プリセット間の色相の割り当ては共通の約束事(style.css :rootのコメント参照)。
 *   プリセットを切り替えても「音程系は青、音量系は緑」といった読み方が変わらないよう、
 *   各プリセットは同じ役割に同じ色相系統(明度・彩度だけを地色に合わせて調整)を使う。
 *   例外は「他エディタ/他アプリの再現」が目的のプリセット(VS Code等)で、そちらは
 *   元の配色への忠実さを優先する。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => MML.I18n.t(key, params);

  const FONT_KEY = 'mml_editorFont';
  // v2: 2026-08-16にデフォルトをダーク→ライトへ変更し、UI変数を7→16項目に増やした。
  // 旧キー(v1)に保存された7項目だけの色マップを新しい:root(ライト)へ上書きすると
  // 「7項目は旧ダーク・残り9項目は新ライト」の混在で破綻するため、キー名を変えて
  // 旧保存値を読まない(=全員が新しいデフォルトから始める)ようにする。
  const UI_COLOR_KEY = 'mml_uiColors_v3'; // v3(2026-09-18): 既定をダークへ戻しプリセットを1つに。v2(ライト既定)の保存値は読まない
  const TOKEN_COLOR_KEY = 'mml_tokenColors_v3';
  const PRESET_KEY = 'mml_colorPreset_v3';

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

  // 設定ダイアログに並べる順(上から視覚的に大きい面→小さい面→文字→アクセント)。
  // --hover-bgはrgba(半透明)のためカラーピッカーで扱えず一覧に出さない(プリセットが
  // 一括で設定するだけ)。
  const UI_VARS = [
    ['--bg', 'ページ背景'],
    ['--panel', 'パネル背景'],
    ['--panel-raised', 'ウィンドウ見出し背景'],
    ['--surface', '入力欄/出力欄の背景'],
    ['--mml-editor-bg', 'エディタ背景'],
    ['--mml-editor-fg', 'エディタ基本文字'],
    ['--border', '境界線'],
    ['--control-bg', 'ボタン/セレクト背景'],
    ['--text', '文字'],
    ['--text-secondary', '文字(サブ)'],
    ['--text-muted', '文字(控えめ)'],
    ['--text-faint', '文字(最も薄い)'],
    ['--accent', 'アクセント'],
    ['--on-accent', 'アクセント上の文字'],
    ['--error', 'エラー'],
    ['--ok', '成功'],
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
    ['--playing-fg', '再生位置ハイライト文字'],
    ['--playing-outline', '再生位置ハイライト縁取り'],
    ['--follow-fg', '追尾チャンネルのハイライト文字'],
    ['--follow-outline', '追尾チャンネルのハイライト縁取り'],
  ];

  // 全プリセット共通の設計方針(2026-08-16、「MMLがみづらい」というユーザー指摘を受けて全面刷新):
  //  - 音階(cdefgab)は「本文そのもの」なので基本文字色(--mml-editor-fg)と同じにする。
  //    MMLの大半は音符であり、そこに色を付けると画面全体が虹色になって読めなくなる。
  //    音符=無色・コマンド=有色、という対比で「どこがコマンドか」が浮かび上がる。
  //  - 休符は音符よりワントーン控えめ(音符の流れの中の「間」として弱く見せる)。
  //  - トラック文字は行頭の「見出し」なので太字+金/黄で目に留まる色に。
  //  - コマンド5系統は互いに区別できつつ主張しすぎない中彩度に揃える(音長=橙、音量=緑、
  //    音程=青、演奏制御=赤、特殊=マゼンタ。同じ役割は全プリセットで同じ色相系統)。
  //  - 定義行(@v0=/@FM0=等)は本文には出てこない「宣言」なので太字+はっきりした色でよい
  //    (エンベロープ=シアン/ティール、音色=ライム/オリーブ)。
  //  - コメントは最も薄い灰色(斜体は付けない、ユーザー要望)。
  //  - 各色は地色に対してWCAG AA相当(概ね4.5:1以上)のコントラストを確保する。
  // プリセットはダークモード1つだけ(2026-09-18、ユーザー指示: ダークを標準にし他の選択肢は削除)。
  // 以前あったデフォルト(ライト)/Windows標準/VS Code/NDP風は廃止。style.css の :root もこの値と同じ。
  // ハイライトの既定: 再生位置=白文字+オレンジ縁取り、追尾チャンネル=白文字+赤縁取り(同日ユーザー指示)
  const PRESETS = [
    {
      // ダークモード: このアプリが従来使ってきた青みがかった暗灰色のUI配色。暗い地なので各色は明るめのパステル
      id: 'dark', name: 'ダークモード',
      ui: {
        '--bg': '#1e1e24', '--panel': '#2a2a33', '--panel-raised': '#34343f', '--surface': '#14141a',
        '--mml-editor-bg': '#14141a', '--mml-editor-fg': '#e6e6ef',
        '--border': '#3d3d4a', '--control-bg': '#3d3d4a',
        '--text': '#e6e6ef', '--text-secondary': '#cfcfe0', '--text-muted': '#9999aa', '--text-faint': '#6a6a80',
        '--accent': '#6fb1ff', '--on-accent': '#102030', '--error': '#ff6b6b', '--ok': '#74e08e',
        '--hover-bg': 'rgba(255, 255, 255, 0.09)',
      },
      tokens: {
        '--tok-header': '#c39cff', '--tok-track': '#ffd479', '--tok-note': '#e6e6ef', '--tok-rest': '#9aa0ac',
        '--tok-cmd-length': '#f5a06a', '--tok-cmd-volume': '#7fd8a0', '--tok-cmd-pitch': '#7fb8ff',
        '--tok-cmd-perf': '#ff7a7a', '--tok-cmd-special': '#f38ad4',
        '--tok-def-envelope': '#66d9ef', '--tok-def-tone': '#b8e05a', '--tok-comment': '#7d828d',
        '--playing-fg': '#ffffff', '--playing-outline': '#ff8c00',
        '--follow-fg': '#ffffff', '--follow-outline': '#e53935',
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

  let _activePreset = 'dark';

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
    _activePreset = preset || ((savedUi || savedTokens) ? 'custom' : 'dark');
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
    // 各プリセットの雰囲気が一目で分かる代表色: エディタ地色/音符/トラック/音程系/音量系
    const swatches = ['--mml-editor-bg', '--tok-note', '--tok-track', '--tok-cmd-pitch', '--tok-cmd-volume']
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
