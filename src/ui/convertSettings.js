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

  // 'vgm' → 'btnVgmTempoTap' のような index.html 側のボタンidを組み立てる(main.js と同じ規則)
  const btnId = (fmt, suffix) => 'btn' + fmt[0].toUpperCase() + fmt.slice(1) + suffix;
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
    [T('音符の抽出'), [
      ['DRUM', T('打楽器を音符にする'), T('VGMのサンプルPCMで音程が取れなかった発音(ドラム/効果音)を1本のドラムパートにまとめ、サンプルごとに音程を割り当てる(OFFなら休符)')],
    ]],
    [T('譜面整形'), [
      ['SHAPE_REST',  T('短い休符を吸収'),     T('音符直後の1/32未満の休符(ゲートタイムの隙間)を音符に繋げる')],
      ['SHAPE_QUANT', T('16分音符格子へ丸める'), T('音符/休符の境界を16分音符の格子に揃える(3連符は崩れる)')],
    ]],
  ];

  // ★DPCM(打楽器)の設定(DMC_RATE/RATE_MIX/DRUM_POLY)はこのダイアログには無い(2026-09-05)。
  //   ドラム(DPCM)パネル最下段(src/ui/drumPanel.js)から set() で同じ cmd に書き込まれる。

  // ピッチ精度(N163出力のSA<num>自動選択、src/convert/pitch.js n163SaForBase参照)
  const PITCH_SA_OPTIONS = () => [
    ['note',   T('高(音符ごと最適)')],
    ['octave', T('中(オクターブ連動・推奨)')],
    ['off',    T('低(SA不使用・従来)')],
  ];
  // N163内蔵RAMに波形が収まらないときの扱い(src/convert/options.js N163_WAVE)
  const N163_WAVE_OPTIONS = () => [
    ['fit', T('収まるように縮める(あふれたぶんだけ半分に)')],
    ['keep', T('元の長さのまま(その曲は再生できない)')],
  ];
  // 基準ピッチ(全体オフセット、src/convert/options.js TUNING/TUNING_MIN。detectTuning冒頭コメント参照)
  const TUNING_OPTIONS = () => [
    ['auto', T('自動検出(曲全体の偏差を測る・推奨)')],
    ['a440', T('12平均律固定(A4=440Hz・従来)')],
  ];
  const PRESET_LABELS = () => ({ faithful: T('忠実再現'), plain: T('プレーン譜面') });

  let current = null; // 正規化済み cmd
  let modalEl = null;
  const listeners = []; // set() で外から変えられたときの通知先(ダイアログ外のUIが同じ cmd を持つため)

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
  // ダイアログの外(ドラム(DPCM)パネルのDMCレート等)から一部のキーを書き換える。
  // 保存・ボタン表示の更新・購読者への通知まで行う
  function set(patch) {
    if (!current) load();
    current = MML.Convert.normalizeCmd(Object.assign({}, current, patch || {}));
    save(); refreshButtons();
    for (const fn of listeners) { try { fn(get()); } catch (e) { console.error(e); } }
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

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

  // ctx: { format, onConvert } … 「to MML」から開いたときは、この画面の中で変換まで完結させる
  //   (ユーザー要望: ボタンを押したら設定画面を出し、その中にコンバート開始ボタンを置く)
  function openModal(ctx) {
    ctx = ctx || {};
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
    // 「to MML」から開いたときは、見出しの左に「コンバート開始」を置く(ユーザー指示)
    if (typeof ctx.onConvert === 'function') {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'cs-convert';
      go.textContent = T('コンバート開始');
      go.addEventListener('click', () => { closeModal(); ctx.onConvert(); });
      header.appendChild(go);
    }
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
        // DPCMキー(ドラム(DPCM)パネル側の設定)はプリセットに含まれないので今の値を残す
        const keep = {};
        for (const k of (MML.Convert.DPCM_KEYS || [])) keep[k] = current[k];
        current = MML.Convert.normalizeCmd(Object.assign({}, keep, MML.Convert.CMD_PRESETS[name]));
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

    // 変換テンポ(プリセットの直下)。実体は各フォーマットのパネルにある <prefix>TempoBpm 入力で、
    // ここはその代理(どちらから変えても同じ値)。自動(空欄)と手動、手動タップの3通り。
    const tempoSrc = ctx.format ? document.getElementById(ctx.format + 'TempoBpm') : null;
    if (tempoSrc) {
      const sec = document.createElement('div');
      sec.className = 'es-section';
      const h = document.createElement('h3');
      h.textContent = T('変換テンポ');
      sec.appendChild(h);

      const row = document.createElement('div');
      row.className = 'cs-tempo-row';
      const autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'es-preset';
      autoBtn.textContent = T('自動(推定)');
      const tempoInput = document.createElement('input');
      tempoInput.type = 'number';
      tempoInput.min = '40'; tempoInput.max = '400'; tempoInput.step = '0.1';
      tempoInput.placeholder = T('自動');
      tempoInput.className = 'cs-tempo';
      const tapBtn = document.createElement('button');
      tapBtn.type = 'button';
      tapBtn.className = 'es-preset cs-tap';
      tapBtn.textContent = T('タップ') + ' 👆'; // パネル側の「👆 タップ」と同じ絵文字(ユーザー指定)
      const tapOut = document.createElement('span');
      tapOut.className = 'cs-desc';

      const syncTempo = () => {
        tempoInput.value = tempoSrc.value;
        autoBtn.classList.toggle('es-preset--active', !tempoSrc.value);
      };
      tempoInput.addEventListener('input', () => { tempoSrc.value = tempoInput.value; syncTempo(); });
      autoBtn.addEventListener('click', () => {
        const sc = document.getElementById(btnId(ctx.format, 'TempoClear'));
        if (sc) sc.click(); else tempoSrc.value = '';
        syncTempo();
        tapOut.textContent = '';
      });

      // タップと自動はパネル側の実装(main.js setupTempoControl)が正典。ここは同じボタンを
      // 押しているだけ ─ 計測窓や外れタップ除去のロジックを二重に持たないため
      tapBtn.addEventListener('click', () => {
        const st = document.getElementById(btnId(ctx.format, 'TempoTap'));
        if (st) st.click();
        syncTempo();
        const info = document.getElementById(ctx.format + 'TempoTapInfo');
        tapOut.textContent = info ? info.textContent : (tempoSrc.value ? tempoSrc.value + ' BPM' : '');
      });

      row.appendChild(autoBtn);
      row.appendChild(tempoInput);
      row.appendChild(tapBtn);
      row.appendChild(tapOut);
      sec.appendChild(row);
      const d = document.createElement('span');
      d.className = 'cs-desc';
      d.textContent = T('BPM(40〜400)。「自動」なら音符の長さから推定、「タップ」は曲に合わせて数回押すと決まります');
      sec.appendChild(d);
      body.appendChild(sec);
      syncTempo();
    }

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

    // N163波形(内蔵RAMに収まらないときの扱い)。SCC/PCエンジン/PCM系をN163へ載せる曲に効く
    const nwRow = document.createElement('label');
    nwRow.className = 'cs-row';
    const nwSel = document.createElement('select');
    for (const [val, label] of N163_WAVE_OPTIONS()) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      nwSel.appendChild(o);
    }
    nwSel.addEventListener('change', () => {
      current = MML.Convert.normalizeCmd(Object.assign({}, current, { N163_WAVE: nwSel.value }));
      save(); syncChecks(); refreshButtons();
    });
    const nwDesc = document.createElement('span');
    nwDesc.className = 'cs-desc';
    nwDesc.textContent = T('N163が波形に使えるRAMは 128-8×使用ch数 バイトだけ(8ch使用なら64バイト=128サンプル)。同時に鳴る波形が入り切らない曲で、はみ出したぶんの波形長を落とすかどうか。落とさないとコンパイルエラーで再生・書き出しができません');
    nwRow.appendChild(nwSel); nwRow.appendChild(nwDesc);
    saSec.appendChild(nwRow);
    body.appendChild(saSec);

    // 基準ピッチ(全体オフセット)。ドライバ固有の音程表で曲全体が数十セントずれている曲向け
    // (玄人向け: 閾値も出す。既定5セント未満は何もしない=従来と同じ出力)
    const tnSec = document.createElement('div');
    tnSec.className = 'es-section';
    const tnH = document.createElement('h3');
    tnH.textContent = T('基準ピッチ');
    tnSec.appendChild(tnH);
    const tnRow = document.createElement('label');
    tnRow.className = 'cs-row';
    const tnSel = document.createElement('select');
    for (const [val, label] of TUNING_OPTIONS()) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      tnSel.appendChild(o);
    }
    tnSel.addEventListener('change', () => {
      current = MML.Convert.normalizeCmd(Object.assign({}, current, { TUNING: tnSel.value }));
      save(); syncChecks(); refreshButtons();
    });
    const tnDesc = document.createElement('span');
    tnDesc.className = 'cs-desc';
    tnDesc.textContent = T('曲全体の音程が12平均律(A4=440Hz)から何セントずれているかを測り、ずらした基準で音符に丸めて #TUNING をヘッダに出す。音名は変わらず(キーとは別)、再生とNSF書き出しの周波数テーブルが同じだけずれる。SPCは絶対音程がサンプル原音の推定に依存するため、15セント以上の安定した偏差に限って適用する');
    tnRow.appendChild(tnSel); tnRow.appendChild(tnDesc);
    tnSec.appendChild(tnRow);
    const tmRow = document.createElement('label');
    tmRow.className = 'cs-row';
    const tmKey = document.createElement('span');
    tmKey.className = 'cs-key';
    tmKey.textContent = T('最小偏差(セント)');
    const tmIn = document.createElement('input');
    tmIn.type = 'number';
    tmIn.min = '0'; tmIn.max = String(MML.Convert.TUNING_MIN_MAX); tmIn.step = '0.5';
    tmIn.addEventListener('change', () => {
      current = MML.Convert.normalizeCmd(Object.assign({}, current, { TUNING_MIN: tmIn.value }));
      save(); syncChecks(); refreshButtons();
    });
    const tmDesc = document.createElement('span');
    tmDesc.className = 'cs-desc';
    tmDesc.textContent = T('自動検出のとき、測った偏差の絶対値がこのセント数未満なら何もしない(既定5。0〜50)。小さくするほど僅かなずれでも #TUNING が付く');
    tmRow.appendChild(tmKey); tmRow.appendChild(tmIn); tmRow.appendChild(tmDesc);
    tnSec.appendChild(tmRow);
    body.appendChild(tnSec);

    function syncChecks() {
      for (const [k, cb] of Object.entries(checks)) cb.checked = !!current[k];
      saSel.value = current.PITCH_SA || 'octave';
      nwSel.value = current.N163_WAVE || 'fit';
      tnSel.value = current.TUNING || 'auto';
      tmIn.value = String(current.TUNING_MIN != null ? current.TUNING_MIN : MML.Convert.TUNING_MIN_DEFAULT);
      tmIn.disabled = current.TUNING !== 'auto';
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

  MML.UI.ConvertSettings = { init, get, set, onChange, open: openModal };
})(window);
