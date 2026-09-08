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
  const UI_COLOR_KEY = 'mml_uiColors_v2';
  const TOKEN_COLOR_KEY = 'mml_tokenColors_v2';
  const PRESET_KEY = 'mml_colorPreset_v2';

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
  const PRESETS = [
    {
      // 1. デフォルト: 明るいニュートラル。GitHub Light系の落ち着いた配色をベースに、
      //    白地で読みやすい深めの色を選ぶ(彩度は上げすぎない)。style.css :rootと同値。
      id: 'default', name: 'デフォルト',
      ui: {
        '--bg': '#f5f6f8', '--panel': '#ffffff', '--panel-raised': '#eceff3', '--surface': '#f0f2f5',
        '--mml-editor-bg': '#ffffff', '--mml-editor-fg': '#24292f',
        '--border': '#d0d5dc', '--control-bg': '#e4e8ee',
        '--text': '#24292f', '--text-secondary': '#3f4750', '--text-muted': '#6e7781', '--text-faint': '#9aa2ad',
        '--accent': '#2563eb', '--on-accent': '#ffffff', '--error': '#c62828', '--ok': '#1a7f37',
        '--hover-bg': 'rgba(0, 0, 0, 0.06)',
      },
      tokens: {
        '--tok-header': '#6f42c1', '--tok-track': '#9a6700', '--tok-note': '#24292f', '--tok-rest': '#57606a',
        '--tok-cmd-length': '#bc4c00', '--tok-cmd-volume': '#1a7f37', '--tok-cmd-pitch': '#0550ae',
        '--tok-cmd-perf': '#cf222e', '--tok-cmd-special': '#a626a4',
        '--tok-def-envelope': '#0f766e', '--tok-def-tone': '#667a00', '--tok-comment': '#6a737d',
        '--playing-fg': '#ffffff', '--playing-outline': '#000000',
        '--follow-fg': '#ffe14d', '--follow-outline': '#000000',
      },
    },
    {
      // 2. ダークモード: このアプリが従来使ってきた青みがかった暗灰色のUI配色をそのまま残し、
      //    トークン色だけ上記方針で刷新したもの(以前は音符が青・休符が灰・数値が緑…と
      //    ほぼ全文字に色が付いていた)。暗い地なので各色は明るめのパステルにする。
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
        '--playing-fg': '#ffffff', '--playing-outline': '#000000',
        '--follow-fg': '#ffe14d', '--follow-outline': '#000000',
      },
    },
    {
      // 3. Windows標準: Windows 11の標準アプリ(メモ帳等)の見た目。ごく薄い灰色の地に白い
      //    パネル、控えめな境界線、Windowsの青(#0067c0)をアクセントに。トークン色は
      //    Fluent Design Systemの標準カラー(orange #ca5010/green #107c10/red #c42b1c/
      //    purple #881798/magenta #c239b3/teal #038387/gold #986f0b)から取る。
      id: 'windows', name: 'Windows標準',
      ui: {
        '--bg': '#f3f3f3', '--panel': '#ffffff', '--panel-raised': '#f0f0f0', '--surface': '#fafafa',
        '--mml-editor-bg': '#ffffff', '--mml-editor-fg': '#1b1b1b',
        '--border': '#dcdcdc', '--control-bg': '#f7f7f7',
        '--text': '#1b1b1b', '--text-secondary': '#3b3b3b', '--text-muted': '#616161', '--text-faint': '#8a8a8a',
        '--accent': '#0067c0', '--on-accent': '#ffffff', '--error': '#c42b1c', '--ok': '#0f7b0f',
        '--hover-bg': 'rgba(0, 0, 0, 0.05)',
      },
      tokens: {
        '--tok-header': '#881798', '--tok-track': '#986f0b', '--tok-note': '#1b1b1b', '--tok-rest': '#767676',
        '--tok-cmd-length': '#ca5010', '--tok-cmd-volume': '#107c10', '--tok-cmd-pitch': '#0067c0',
        '--tok-cmd-perf': '#c42b1c', '--tok-cmd-special': '#c239b3',
        '--tok-def-envelope': '#038387', '--tok-def-tone': '#667a00', '--tok-comment': '#6b6b6b',
        '--playing-fg': '#ffffff', '--playing-outline': '#000000',
        '--follow-fg': '#ffe14d', '--follow-outline': '#000000',
      },
    },
    {
      // 4. VS Code (Dark Modern): VS Codeの既定テーマ。UI色はDark Modern
      //    (エディタ#1f1f1f/サイドバー・タイトルバー#181818/境界#2b2b2b/アクセント#0078d4)、
      //    トークン色はDark+のシンタックス配色をそのまま流用する:
      //      #c586c0(キーワード/#include等のディレクティブ)→ヘッダー
      //      #dcdcaa(関数名)→トラック  #ce9178(文字列)→音長系  #b5cea8(数値)→音量系
      //      #569cd6(キーワード)→音程系  #d16969(正規表現)→演奏制御  #f44747(エラー)→特殊
      //      #4ec9b0(型)→エンベロープ定義  #4fc1ff(定数)→音色定義  #6a9955(コメント)
      //    (音色定義だけは共通方針の「ライム」ではなくDark+の定数色を使う=元テーマへの忠実さ優先)
      id: 'vscode', name: 'VS Code (Dark Modern)',
      ui: {
        '--bg': '#181818', '--panel': '#1f1f1f', '--panel-raised': '#181818', '--surface': '#181818',
        '--mml-editor-bg': '#1f1f1f', '--mml-editor-fg': '#d4d4d4',
        '--border': '#2b2b2b', '--control-bg': '#313131',
        '--text': '#cccccc', '--text-secondary': '#bbbbbb', '--text-muted': '#9d9d9d', '--text-faint': '#6e7681',
        '--accent': '#0078d4', '--on-accent': '#ffffff', '--error': '#f14c4c', '--ok': '#89d185',
        '--hover-bg': 'rgba(255, 255, 255, 0.08)',
      },
      tokens: {
        '--tok-header': '#c586c0', '--tok-track': '#dcdcaa', '--tok-note': '#d4d4d4', '--tok-rest': '#8b8b8b',
        '--tok-cmd-length': '#ce9178', '--tok-cmd-volume': '#b5cea8', '--tok-cmd-pitch': '#569cd6',
        '--tok-cmd-perf': '#d16969', '--tok-cmd-special': '#f44747',
        '--tok-def-envelope': '#4ec9b0', '--tok-def-tone': '#4fc1ff', '--tok-comment': '#6a9955',
        '--playing-fg': '#ffffff', '--playing-outline': '#000000',
        '--follow-fg': '#ffe14d', '--follow-outline': '#000000',
      },
    },
    {
      // 5. NDP風: NDP MML Compiler(ユーザー提供のスクリーンショット)を再現。ウィンドウの
      //    周囲はWindows標準の明るい灰色、エディタ部分だけ濃紺の地に、音符=白、@系コマンド=緑、
      //    トラック番号=淡い黄、コメント=灰、#ヘッダー=緑、という非常に色数の少ない配色。
      //    元が「@付き=緑/それ以外=白」の2色主体なので、本ツールの12分類のうち音長系(l/q/t)は
      //    白に近い色のまま、音量系と定義行を緑、残りの系統(音程/演奏制御/特殊)だけ紺地に
      //    馴染む淡い水色/珊瑚/桃を薄く足して「NDPの雰囲気を保ちつつ最低限区別できる」に留める。
      //    エディタだけ紺・周囲は明るい、を成立させるため--mml-editor-fgを--textと分けている。
      id: 'ndp', name: 'NDP風',
      ui: {
        '--bg': '#f0f0f0', '--panel': '#ffffff', '--panel-raised': '#f0f0f0', '--surface': '#ffffff',
        '--mml-editor-bg': '#212a4c', '--mml-editor-fg': '#dcdde3',
        '--border': '#c8c8c8', '--control-bg': '#e8e8e8',
        '--text': '#1a1a1a', '--text-secondary': '#333333', '--text-muted': '#666666', '--text-faint': '#999999',
        '--accent': '#0078d7', '--on-accent': '#ffffff', '--error': '#c42b1c', '--ok': '#107c10',
        '--hover-bg': 'rgba(0, 0, 0, 0.05)',
      },
      tokens: {
        '--tok-header': '#5ad35a', '--tok-track': '#e8d878', '--tok-note': '#dcdde3', '--tok-rest': '#a3a6b3',
        '--tok-cmd-length': '#c9cbd4', '--tok-cmd-volume': '#62d46a', '--tok-cmd-pitch': '#7fc8f0',
        '--tok-cmd-perf': '#f0a090', '--tok-cmd-special': '#f28fb8',
        '--tok-def-envelope': '#62d46a', '--tok-def-tone': '#7fe0d0', '--tok-comment': '#8f95a7',
        '--playing-fg': '#ffffff', '--playing-outline': '#000000',
        '--follow-fg': '#ffe14d', '--follow-outline': '#000000',
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
