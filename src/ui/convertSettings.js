/*
 * *2MML 変換設定ダイアログ(2026-08-24)
 *
 * MML.UI.ConvertSettings.init() … 各フォーマットの「to MML」隣の「⚙ 変換設定」ボタンを配線し、
 *                                 localStorage から保存済み設定を復元する(main.jsから起動時に1回)
 * MML.UI.ConvertSettings.get()  … 現在の設定(src/convert/options.js の cmd 形式)。各 *2mml の
 *                                 options.cmd にそのまま渡す
 *
 * 狙い: 熟練者が「ほぼ音階だけのプレーンな譜面」から編曲を始められるよう、セント単位の
 * 補正コマンド(D/EP/MP/PT/EN)や音量エンベロープ(@v)を出す/出さないを選べるようにする。
 * 6形式共通の1つの設定で、ダイアログの見た目はカラー設定(editorSettings.js の es-modal)を流用。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};

  const T = (key, params) => MML.I18n.t(key, params);
  const STORAGE_KEY = 'mml.convertCmd.v1';

  // 表示グループ(見出し, [[キー, ラベル, 説明], ...])
  const GROUPS = () => [
    [T('ピッチコマンド'), [
      ['D',  'D<n>',  T('チャンネル間デチューン(セント単位の音程補正)')],
      ['EP', 'EP<n>', T('ピッチエンベロープ(MP/PTで表せない揺れの受け皿)')],
      ['MP', 'MP<n>', T('ビブラート')],
      ['PT', 'PT<n>', T('ポルタメント')],
      ['EN', 'EN<n>', T('高速アルペジオ(OFF時は基音1音にまとめる)')],
    ]],
    [T('音量コマンド'), [
      ['ENV', '@v/@vr', T('音量エンベロープ(OFF時はピーク音量を v で出す)')],
      ['V',   'v<n>',   T('音量そのもの(OFFなら v を一切出さない)')],
    ]],
    [T('音色コマンド'), [
      ['INST',  '@ OP MH N', T('音色/デューティ/VRC7音色/FDS変調/FME7ノイズ周期')],
      ['SWEEP', 's<n>,<n>',  T('2A03ハードウェアスイープ')],
    ]],
    [T('譜面整形'), [
      ['SHAPE_REST',  T('短い休符を吸収'),     T('音符直後の1/32未満の休符(ゲートタイムの隙間)を音符に繋げる')],
      ['SHAPE_QUANT', T('16分音符格子へ丸める'), T('音符/休符の境界を16分音符の格子に揃える(3連符は崩れる)')],
    ]],
  ];

  // PCM品質(HES DDA→@DPCMのDMCレート選択、src/convert/options.js PCM_RATE参照)。
  // select値はlocalStorage往復で文字列になるためnormalizeCmd側で数値へ戻す。
  const PCM_RATE_OPTIONS = () => [
    ['max', T('最高(33kHz固定・データ大)')],
    ['8',   T('8倍(ソースレートの8倍以上)')],
    ['4',   T('4倍')],
    ['2',   T('2倍')],
    ['1',   T('等倍(従来・データ最小)')],
  ];

  // ピッチ精度(N163出力のSA<num>自動選択、src/convert/pitch.js n163SaForBase参照)
  const PITCH_SA_OPTIONS = () => [
    ['note',   T('高(音符ごと最適)')],
    ['octave', T('中(オクターブ連動・推奨)')],
    ['off',    T('低(SA不使用・従来)')],
  ];
  const PRESET_LABELS = () => ({ faithful: T('忠実再現'), plain: T('プレーン譜面') });

  let current = null; // 正規化済み cmd
  let modalEl = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      current = MML.Convert.normalizeCmd(raw ? JSON.parse(raw) : null);
    } catch (e) { current = MML.Convert.normalizeCmd(null); }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e) { /* private browsing等は無視 */ }
  }

  function get() {
    if (!current) load();
    return Object.assign({}, current);
  }

  // 各「to MML」ボタンのラベルに現在のプリセット名を添える(設定が既定以外だと一目で分かるように)
  function refreshButtons() {
    const name = MML.Convert.cmdPresetName(current);
    document.querySelectorAll('.convert-settings-btn').forEach(btn => {
      btn.classList.toggle('convert-settings-btn--active', name !== 'faithful');
      btn.title = T('変換設定') + ': ' + (name === 'custom' ? T('カスタム') : PRESET_LABELS()[name]);
    });
  }

  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function openModal() {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'es-backdrop';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

    const modal = document.createElement('div');
    modal.className = 'es-modal cs-modal';

    const header = document.createElement('div');
    header.className = 'es-modal-header';
    const title = document.createElement('span');
    title.textContent = T('変換設定');
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

    const note = document.createElement('p');
    note.className = 'cs-note';
    note.textContent = T('NSF/SPC/KSS/GBS/HES/VGM → MML 変換で出力するコマンドを選びます(全形式共通、次回の変換から有効)。');
    body.appendChild(note);

    // プリセット
    const presetSection = document.createElement('div');
    presetSection.className = 'es-section';
    const presetHeading = document.createElement('h3');
    presetHeading.textContent = T('プリセット');
    presetSection.appendChild(presetHeading);
    const presetRow = document.createElement('div');
    presetRow.className = 'es-preset-row';
    const presetButtons = {};
    for (const [name, label] of Object.entries(PRESET_LABELS())) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'es-preset';
      b.textContent = label;
      b.addEventListener('click', () => {
        current = MML.Convert.normalizeCmd(MML.Convert.CMD_PRESETS[name]);
        save(); syncChecks(); refreshButtons();
      });
      presetButtons[name] = b;
      presetRow.appendChild(b);
    }
    const customTag = document.createElement('span');
    customTag.className = 'es-preset--custom';
    customTag.textContent = T('カスタム');
    presetRow.appendChild(customTag);
    presetSection.appendChild(presetRow);
    body.appendChild(presetSection);

    // チェックボックス群
    const checks = {};
    for (const [heading, items] of GROUPS()) {
      const sec = document.createElement('div');
      sec.className = 'es-section';
      const h = document.createElement('h3');
      h.textContent = heading;
      sec.appendChild(h);
      for (const [key, label, desc] of items) {
        const row = document.createElement('label');
        row.className = 'cs-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          current[key] = cb.checked;
          save(); syncChecks(); refreshButtons();
        });
        const name = document.createElement('code');
        name.className = 'cs-key';
        name.textContent = label;
        const d = document.createElement('span');
        d.className = 'cs-desc';
        d.textContent = desc;
        row.appendChild(cb); row.appendChild(name); row.appendChild(d);
        sec.appendChild(row);
        checks[key] = cb;
      }
      body.appendChild(sec);
    }

    // PCM品質(select 1つの独立セクション)
    const pcmSec = document.createElement('div');
    pcmSec.className = 'es-section';
    const pcmH = document.createElement('h3');
    pcmH.textContent = T('PCM品質');
    pcmSec.appendChild(pcmH);
    const pcmRow = document.createElement('label');
    pcmRow.className = 'cs-row';
    const pcmSel = document.createElement('select');
    for (const [val, label] of PCM_RATE_OPTIONS()) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      pcmSel.appendChild(o);
    }
    pcmSel.addEventListener('change', () => {
      current = MML.Convert.normalizeCmd(Object.assign({}, current, { PCM_RATE: pcmSel.value }));
      save(); syncChecks(); refreshButtons();
    });
    const pcmDesc = document.createElement('span');
    pcmDesc.className = 'cs-desc';
    pcmDesc.textContent = T('PCM→DPCM変換のレート(HESのDDA等)。高いほどアタックが鈍らずノイズも減るが.dmcデータが大きくなる');
    pcmRow.appendChild(pcmSel); pcmRow.appendChild(pcmDesc);
    pcmSec.appendChild(pcmRow);
    body.appendChild(pcmSec);

    // ピッチ精度(SA)
    const saSec = document.createElement('div');
    saSec.className = 'es-section';
    const saH = document.createElement('h3');
    saH.textContent = T('ピッチ精度(SA)');
    saSec.appendChild(saH);
    const saRow = document.createElement('label');
    saRow.className = 'cs-row';
    const saSel = document.createElement('select');
    for (const [val, label] of PITCH_SA_OPTIONS()) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      saSel.appendChild(o);
    }
    saSel.addEventListener('change', () => {
      current = MML.Convert.normalizeCmd(Object.assign({}, current, { PITCH_SA: saSel.value }));
      save(); syncChecks(); refreshButtons();
    });
    const saDesc = document.createElement('span');
    saDesc.className = 'cs-desc';
    saDesc.textContent = T('N163出力のSA<n>(D/EP/MPの倍率)の選び方。深いビブラートをテーブルのbyte幅を超えて表現する');
    saRow.appendChild(saSel); saRow.appendChild(saDesc);
    saSec.appendChild(saRow);
    body.appendChild(saSec);

    function syncChecks() {
      for (const [k, cb] of Object.entries(checks)) cb.checked = !!current[k];
      pcmSel.value = String(current.PCM_RATE != null ? current.PCM_RATE : 'max');
      saSel.value = current.PITCH_SA || 'octave';
      const name = MML.Convert.cmdPresetName(current);
      for (const [n, b] of Object.entries(presetButtons)) b.classList.toggle('es-preset--active', n === name);
      customTag.style.display = name === 'custom' ? '' : 'none';
    }
    syncChecks();

    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modalEl = backdrop;
    document.addEventListener('keydown', onKey);
  }

  function init() {
    load();
    document.querySelectorAll('.convert-settings-btn').forEach(btn => btn.addEventListener('click', openModal));
    refreshButtons();
  }

  MML.UI.ConvertSettings = { init, get, open: openModal };
})(window);
