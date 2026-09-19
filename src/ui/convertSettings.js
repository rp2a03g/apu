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
 * 画面構成は 2026-09-18 に再整理(プリセット|変換テンポ → 変換ログ → 出力コマンド(チップ) →
 * 譜面の書き方(折りたたみ) → 出力の書式(折りたたみ) → 詳細設定/N163(折りたたみ)。折りたたみは全部閉が既定)。
 * 項目の説明はホバーの title か各行の薄い文で出し、1画面に収める。グループは薄い色で塗り分ける(CSS .cs-group--*)。
 * 折りたたみの開閉は localStorage に覚える(OPEN_KEY)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  MML.UI = MML.UI || {};

  // 'vgm' → 'btnVgmTempoTap' のような index.html 側のボタンidを組み立てる(main.js と同じ規則)
  const btnId = (fmt, suffix) => 'btn' + fmt[0].toUpperCase() + fmt.slice(1) + suffix;
  const T = (key, params) => MML.I18n.t(key, params);
  const STORAGE_KEY = 'mml.convertCmd.v1';
  const LOOP_ON_KEY = 'mml.convertCmd.loopDetectOn'; // LOOP_DETECT 既定 true 化の移行済み印(load 参照)
  const OPEN_KEY = 'mml.convertSettings.open.v1'; // 折りたたみ区画の開閉状態 { score, layout, advanced, n163 }

  // ── 画面構成(2026-09-18 に再整理。ユーザー要望「1画面に収める・グループを分かりやすく」) ──
  //   1. プリセット | 変換テンポ(横並び)、その下に変換ログ
  //   2. 出力コマンド … チェック付きのチップを1段に並べる(説明はホバーの title)
  //   3. 譜面の書き方(折りたたみ) … 音符の区切り / ゲートを揃える(近似)+許容 / 短い休符を吸収(近似) / 似た@v表を統合(近似)
  //      「(近似)」が付くものは音が数フレーム変わりうる整形、付かないものは再生が変わらない厳密な変形
  //   4. 出力の書式(折りたたみ) / 詳細設定(折りたたみ) / N163(折りたたみ)
  // 出力コマンド(キー, チップ表示, ホバー説明)
  const CMD_CHIPS = () => [
    ['D',     'D',        T('チャンネル間デチューン(セント単位の音程補正)')],
    ['EP',    'EP',       T('ピッチエンベロープ(MP/PTで表せない揺れの受け皿)')],
    ['MP',    'MP',       T('ビブラート')],
    ['PT',    'PT',       T('ポルタメント')],
    ['EN',    'EN',       T('高速アルペジオ(OFF時は基音1音にまとめる)')],
    ['ENV',   '@v/@vr',   T('音量エンベロープ(OFF時はピーク音量を v で出す)')],
    ['V',     'v',        T('音量そのもの(OFFなら v を一切出さない)')],
    ['INST',  '@ OP MH N', T('音色/デューティ/VRC7音色/FDS変調/FME7ノイズ周期')],
    ['SWEEP', 's',        T('2A03ハードウェアスイープ')],
    // ★DRUM は MML コマンドではなく「打楽器パートを出すか」のスイッチ(全6形式の *2mml が cmd.DRUM !== false で見る)。
    //   ドラムパッド(DPCM(E)/ノイズ(D))へ載せた打点を音符化する経路そのものの ON/OFF
    ['DRUM',  T('打楽器パート'), T('ドラムパッド(DPCM(E)/ノイズ(D))へ載せた打楽器の打点を音符にして出す(OFFなら打楽器パートごと出さない)。MMLコマンドではなくパートのON/OFF')],
  ];
  // 音符の区切り(src/convert/options.js NOTE_END、src/convert/envelope.js applyNoteEnd)
  const NOTE_END_OPTIONS = () => [
    ['next', T('次の音符まで(推奨)')],
    ['zero', T('音量ゼロで区切る')],
  ];
  // ピッチ精度(N163出力のSA<num>自動選択、src/convert/pitch.js n163SaForBase参照)
  const PITCH_SA_OPTIONS = () => [
    ['note',   T('高(音符ごと最適)')],
    ['octave', T('中(オクターブ連動・推奨)')],
    ['off',    T('低(SA不使用・従来)')],
  ];
  // N163の実効チャンネル数(src/convert/options.js N163_CH)
  const N163_CH_OPTIONS = () => [
    ['fixed8', T('8ch固定(推奨)')],
    ['used',   T('使ったch数だけ')],
  ];
  // N163内蔵RAMに波形が収まらないときの扱い(src/convert/options.js N163_WAVE)
  const N163_WAVE_OPTIONS = () => [
    ['both', T('RAMと音域の両方に収まるように縮める(推奨)')],
    ['fit',  T('RAMに収まるようにだけ縮める')],
    ['keep', T('元の長さのまま(その曲は再生できない)')],
  ];
  // SN76489 の周期ノイズの写し先(src/convert/options.js SN_PERIODIC)
  const SN_PERIODIC_OPTIONS = () => [
    ['white', T('ホワイトノイズ(長周期)・推奨')],
    ['short', T('短周期ノイズ(@1、音程を合わせる)')],
  ];
  // 基準ピッチ(全体オフセット、src/convert/options.js TUNING/TUNING_MIN。detectTuning冒頭コメント参照)
  const TUNING_OPTIONS = () => [
    ['auto', T('自動検出(曲全体の偏差を測る・推奨)')],
    ['note', T('音名別に自動検出(音名ごとの偏差を測る)')],
    ['a440', T('12平均律固定(A4=440Hz・従来)')],
  ];
  const PRESET_LABELS = () => ({ faithful: T('忠実再現'), plain: T('プレーン譜面') });
  // 出力の書式: チャンネルの並び順(src/convert/options.js CHANNEL_ORDER)
  const CHANNEL_ORDER_OPTIONS = () => [
    ['letter', T('アルファベット順')],
    ['source', T('変換元の割り当て順')],
  ];
  // 出力の書式: パートの並び(src/convert/options.js PART_ORDER)
  const PART_ORDER_OPTIONS = () => [
    ['block', T('チャンネル順に小節ブロック')],
    ['part',  T('パートごとにまとめる')],
  ];
  let modalPos = null; // ドラッグで動かした位置(次に開いたときも同じ場所に)

  let current = null; // 正規化済み cmd
  let modalEl = null;
  let logObserver = null; // 変換ログの写し取り(openModal / closeModal で対に)
  const listeners = []; // set() で外から変えられたときの通知先(ダイアログ外のUIが同じ cmd を持つため)

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      // ループ自動検出の既定を false→true に変えた(2026-09-19)。それ以前に保存された設定は false を
      // 「選んだ値」ではなく旧既定として持っているので、1回だけ true へ移す(LOOP_ON_KEY で1回限り)
      if (saved && !localStorage.getItem(LOOP_ON_KEY)) {
        saved.LOOP_DETECT = true;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      }
      try { localStorage.setItem(LOOP_ON_KEY, '1'); } catch (e) { /* 保存できなくても動作は同じ */ }
      current = MML.Convert.normalizeCmd(saved);
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
    if (logObserver) { logObserver.disconnect(); logObserver = null; }
    if (modalEl) { modalEl.remove(); modalEl = null; }
    document.removeEventListener('keydown', onKey);
  }
  // 見出し行のドラッグでダイアログを動かす(ユーザー要望 2026-09-08)。動かした位置は次回も使う
  function makeDraggable(modal, header) {
    const place = (x, y) => {
      const w = modal.offsetWidth || 600, h = modal.offsetHeight || 400;
      x = Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), x));
      y = Math.max(0, Math.min(window.innerHeight - 40, y));
      modal.classList.add('cs-modal--moved');
      modal.style.left = x + 'px';
      modal.style.top = y + 'px';
      modalPos = { x, y };
      void h;
    };
    if (modalPos) requestAnimationFrame(() => place(modalPos.x, modalPos.y));
    let drag = null;
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, label')) return;
      const r = modal.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    const onMove = (e) => { if (drag) place(e.clientX - drag.dx, e.clientY - drag.dy); };
    const onUp = () => { drag = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  // 小さな DOM ヘルパー
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // 見出し直下の短い説明。長文はホバー(title)へ回す(2026-09-09「説明が横に長い」対策)
  // セレクトと付随入力(最小偏差など)を1つのセルへまとめる
  function inline2(a, b) {
    const w = document.createElement('span');
    w.className = 'cs-inline';
    w.appendChild(a);
    if (b) w.appendChild(b);
    return w;
  }
  function descLine(short, help) {
    const d = el('div', 'cs-desc', short);
    if (help) d.title = help;
    return d;
  }
  function section(title, group) {
    const sec = el('div', 'es-section');
    if (group) sec.classList.add('cs-group--' + group);
    sec.appendChild(el('h3', null, title));
    return sec;
  }
  function loadOpen() {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY)) || {}; } catch (e) { return {}; }
  }
  // 折りたたみ区画(<details>)。開閉は id ごとに localStorage へ覚え、次に開いたときも同じ状態にする
  function foldSection(id, title, defaultOpen, group) {
    const det = document.createElement('details');
    det.className = 'cs-details cs-span';
    if (group) det.classList.add('cs-group--' + group);
    const st = loadOpen();
    det.open = (id in st) ? !!st[id] : !!defaultOpen;
    det.appendChild(el('summary', null, title));
    det.addEventListener('toggle', () => {
      const s = loadOpen(); s[id] = det.open;
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(s)); } catch (e) { /* private browsing等は無視 */ }
    });
    return det;
  }
  function makeSelect(options, onchange) {
    const sel = document.createElement('select');
    for (const [val, label] of options) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', onchange);
    return sel;
  }

  // ctx: { format, onConvert } … 「to MML」から開いたときは、この画面の中で変換まで完結させる
  //   (ユーザー要望: ボタンを押したら設定画面を出し、その中にコンバート開始ボタンを置く)
  function openModal(ctx) {
    ctx = ctx || {};
    closeModal();
    const backdrop = el('div', 'es-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

    const modal = el('div', 'es-modal cs-modal');
    const header = el('div', 'es-modal-header');
    const closeBtn = el('button', 'es-modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', T('閉じる'));
    closeBtn.addEventListener('click', closeModal);
    header.appendChild(el('span', null, T('変換設定')));
    // 「to MML」から開いたときは、見出し「変換設定」の右に「コンバート開始」を置く(ユーザー指示 2026-09-09)。
    // ★押しても閉じない: 進捗と変換結果のログはこのダイアログの中(下部のログ欄)に出す。
    //   完了したらMMLエディタを最前面へ出す(変換結果をすぐ見られるように)
    if (typeof ctx.onConvert === 'function') {
      const go = el('button', 'cs-convert', T('コンバート開始'));
      go.type = 'button';
      go.addEventListener('click', async () => {
        if (go.disabled) return;
        go.disabled = true;
        go.classList.add('cs-convert--busy');
        try { await ctx.onConvert(); } catch (e) { console.error(e); }
        go.disabled = false;
        go.classList.remove('cs-convert--busy');
        if (MML.FloatingWindows && MML.FloatingWindows.bringToFront) MML.FloatingWindows.bringToFront('win-mml');
        const mmlWin = document.getElementById('win-mml');
        if (mmlWin && mmlWin.style.display === 'none') mmlWin.style.display = 'flex';
      });
      header.appendChild(go);
    }
    header.appendChild(closeBtn);
    modal.appendChild(header);
    makeDraggable(modal, header);

    const body = el('div', 'es-modal-body cs-body');
    const commit = () => { save(); syncAll(); refreshButtons(); };
    const setKey = (k, v) => { current = MML.Convert.normalizeCmd(Object.assign({}, current, { [k]: v })); commit(); };

    // ── 1. プリセット(+カスタム表示) | 変換テンポ … 横並び(CSS .cs-top)。その下に変換ログ ──
    const top = el('div', 'cs-top');
    const presetSec = section(T('プリセット'), 'preset');
    const presetRow = el('div', 'es-preset-row');
    const presetButtons = {};
    for (const [name, label] of Object.entries(PRESET_LABELS())) {
      const b = el('button', 'es-preset', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        // DPCMキー(ドラム(DPCM)パネル側の設定)と出力の書式はプリセットに含まれないので今の値を残す
        const keep = {};
        for (const k of [...(MML.Convert.DPCM_KEYS || []), ...(MML.Convert.LAYOUT_KEYS || [])]) keep[k] = current[k];
        current = MML.Convert.normalizeCmd(Object.assign({}, keep, MML.Convert.CMD_PRESETS[name]));
        commit();
      });
      presetButtons[name] = b;
      presetRow.appendChild(b);
    }
    const customTag = el('span', 'es-preset--custom', T('カスタム'));
    presetRow.appendChild(customTag);
    presetSec.appendChild(presetRow);
    presetSec.appendChild(descLine(T('忠実再現=元曲の演奏そのまま / プレーン譜面=音階と音色だけ'), T('「忠実再現」は元曲の演奏をそのまま、「プレーン譜面」は音階と音色だけ(編曲の出発点)。どれかを触ると「カスタム」になります')));
    top.appendChild(presetSec);

    // ── 変換テンポ(プリセットの右)。実体は各フォーマットのパネルにある <prefix>TempoBpm 入力で、
    // ここはその代理(どちらから変えても同じ値)。自動(空欄)と手動、手動タップの3通り。
    const tempoSrc = ctx.format ? document.getElementById(ctx.format + 'TempoBpm') : null;
    if (tempoSrc) {
      const sec = section(T('変換テンポ'), 'preset');
      const row = el('div', 'cs-tempo-row');
      const autoBtn = el('button', 'es-preset', T('自動(推定)'));
      autoBtn.type = 'button';
      const tempoInput = document.createElement('input');
      tempoInput.type = 'number';
      tempoInput.min = '40'; tempoInput.max = '400'; tempoInput.step = '0.1';
      tempoInput.placeholder = T('自動');
      tempoInput.className = 'cs-tempo';
      const tapBtn = el('button', 'es-preset cs-tap', '👆 ' + T('タップ')); // パネル側の「👆 タップ」と同じ並び(絵文字が左)
      tapBtn.type = 'button';
      const tapOut = el('span', 'cs-desc');
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
      row.appendChild(autoBtn); row.appendChild(tempoInput); row.appendChild(tapBtn); row.appendChild(tapOut);
      sec.appendChild(row);
      sec.appendChild(descLine(T('BPM 40〜400。空欄で自動推定'), T('BPM(40〜400)。「自動」なら音符の長さから推定、「タップ」は曲に合わせて数回押すと決まります')));
      top.appendChild(sec);
      syncTempo();
    }
    body.appendChild(top);

    // ── 変換の進捗と結果ログ(ユーザー指示 2026-09-09。位置はプリセット/テンポの直下 2026-09-18) ──
    // 実体は各フォーマットのパネルにある #<fmt>FileStatus。キャプチャ進捗も完了メッセージも
    // エラーもそこへ書かれるので、MutationObserver で写して1か所(このダイアログ)で読めるようにする
    // (書き込み側6か所をいじらずに済み、新しいメッセージを足しても取りこぼさない)
    if (ctx.format) {
      const src = document.getElementById(ctx.format + 'FileStatus');
      if (src) {
        const logSec = section(T('変換ログ'), 'log');
        logSec.classList.add('cs-span');
        const log = el('div', 'cs-log');
        log.innerHTML = src.innerHTML;
        logSec.appendChild(log);
        body.appendChild(logSec);
        if (logObserver) logObserver.disconnect();
        logObserver = new MutationObserver(() => {
          log.innerHTML = src.innerHTML;
          log.scrollTop = log.scrollHeight;
        });
        logObserver.observe(src, { childList: true, subtree: true, characterData: true });
      }
    }

    // ── 2. 出力コマンド(チップ) ──
    const cmdSec = section(T('出力コマンド'), 'cmd');
    cmdSec.classList.add('cs-span');
    const chips = el('div', 'cs-chips');
    const checks = {};
    for (const [key, label, desc] of CMD_CHIPS()) {
      const chip = el('label', 'cs-chip');
      chip.title = desc;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => setKey(key, cb.checked));
      chip.appendChild(cb);
      chip.appendChild(el('code', 'cs-key', label));
      chips.appendChild(chip);
      checks[key] = cb;
    }
    cmdSec.appendChild(chips);
    cmdSec.appendChild(descLine(T('OFFにしたコマンドは出力しません'), T('OFFにしたコマンドは出力しません(説明は各項目にマウスを載せると出ます)')));
    body.appendChild(cmdSec);

    // ── 3. 譜面の書き方(折りたたみ。既定は閉: 折りたたみ区画は全部閉じた状態が既定、ユーザー指示 2026-09-18) ──
    const wrSec = foldSection('score', T('譜面の書き方'), false, 'score');
    // 1行 = [コントロール][名前][追加入力(許容フレーム等、無ければ空)][短い説明] の4列グリッド(CSS .cs-line)。
    // help(長い説明)は行の title へ回す: 長文を横へ並べると読みづらい、というユーザー指摘(2026-09-09)。
    // 行の間には区切り線を入れる(CSS .cs-line + .cs-line)
    const line = (control, label, desc, extra, help) => {
      const row = el('label', 'cs-line');
      if (help) row.title = help;
      row.appendChild(control || el('span'));
      row.appendChild(el('span', 'cs-key', label));
      row.appendChild(extra || el('span'));
      row.appendChild(el('span', 'cs-desc', desc || ''));
      return row;
    };
    const neSel = makeSelect(NOTE_END_OPTIONS(), () => setKey('NOTE_END', neSel.value));
    wrSec.appendChild(line(null, T('音符の区切り'), T('音符をどこで終わらせるか'), neSel, T('「次の音符まで」は音符をキーオン間隔まで伸ばし、無音を@v表の末尾0かゲートで表す(再生は変わらない)。「音量ゼロ」は元の細かい区切りのまま')));
    const gaCb = document.createElement('input'); gaCb.type = 'checkbox';
    gaCb.addEventListener('change', () => setKey('GATE_APPROX', gaCb.checked));
    const gtIn = document.createElement('input');
    gtIn.type = 'number'; gtIn.min = '0'; gtIn.max = String(MML.Convert.GATE_TOL_MAX); gtIn.step = '1'; gtIn.className = 'cs-num';
    gtIn.addEventListener('change', () => setKey('GATE_TOL', gtIn.value));
    gtIn.addEventListener('click', (e) => e.preventDefault());
    const gtWrap = el('span', 'cs-inline');
    gtWrap.appendChild(el('span', null, T('許容')));
    gtWrap.appendChild(gtIn);
    gtWrap.appendChild(el('span', null, T('フレーム')));
    wrSec.appendChild(line(gaCb, T('ゲートを揃える(近似)'), T('休符や k を出さず q でそろえる'), gtWrap, T('キーオフ位置のずれが許容内の音符を、チャンネルで最も多く合う q に揃える(休符や k を出さない)。レガートは切らない')));
    // 音長を丸める(LEN_SNAP、src/convert/duration.js framesToLengths の slackFrames)
    const lsIn = document.createElement('input');
    lsIn.type = 'number'; lsIn.min = '0'; lsIn.max = String(MML.Convert.LEN_SNAP_MAX); lsIn.step = '1'; lsIn.className = 'cs-num';
    lsIn.addEventListener('change', () => setKey('LEN_SNAP', lsIn.value));
    lsIn.addEventListener('click', (e) => e.preventDefault());
    const lsWrap = el('span', 'cs-inline');
    lsWrap.appendChild(el('span', null, T('許容')));
    lsWrap.appendChild(lsIn);
    lsWrap.appendChild(el('span', null, T('フレーム')));
    wrSec.appendChild(line(null, T('音長を丸める(近似)'), T('タイの列にせず1個の音価で書く'), lsWrap, T('音符/休符の長さが許容フレーム数以内で大きな音価に乗るなら、タイの列(4&2&8..&64.&192)にせず1個で書く。余りは次の音符へ持ち越すので誤差は溜まらない。0で厳密(192分音符単位)')));
    // 音長をチャンネル全体で最適化(LEN_DP、src/convert/duration.js quantizeSeq。忠実=ON / プレーン=OFF)
    const ldCb = document.createElement('input'); ldCb.type = 'checkbox';
    ldCb.addEventListener('change', () => setKey('LEN_DP', ldCb.checked));
    wrSec.appendChild(line(ldCb, T('音長をチャンネル全体で最適化(忠実)'), T('全ての境界のずれを許容内に収める'), null, T('音符ごとに直前の余りだけを見て最も近い音価を選ぶ代わりに、チャンネル全体を見渡して「音価の書きにくさ+境界のずれ」の合計が最小になる音価を動的計画法で選ぶ。全ての境界のずれが「音長を丸める」の許容フレーム以内に収まる(OFFだと持ち越しの超過分は捨てられ、曲が進むと黙ってずれる)。格子に乗らない音符が多い曲では3連系やタイが増えるのでプレーン譜面ではOFF')));
    // 分割DPCMの音長は丸めない(DPCM_EXACT、src/convert/drumHits.js の分割 + mmlEmit.js/duration.js の exact)
    const deCb = document.createElement('input'); deCb.type = 'checkbox';
    deCb.addEventListener('change', () => setKey('DPCM_EXACT', deCb.checked));
    wrSec.appendChild(line(deCb, T('分割DPCMの音長は丸めない(忠実)'), T('ストリーム再生の継ぎ目を守る'), null, T('DMC 1本の上限(4081バイト)を超える長いサンプルは区間に分割して連続再生します。その区間の音長を「音長を丸める」「チャンネル全体で最適化」の対象から外し、フレーム単位で厳密に書きます(丸めると継ぎ目に空白や食い込みが出ます)')));
    const srCb = document.createElement('input'); srCb.type = 'checkbox';
    srCb.addEventListener('change', () => setKey('SHAPE_REST', srCb.checked));
    wrSec.appendChild(line(srCb, T('短い休符を吸収(近似)'), T('音符直後の短い休符を音符に繋げる'), null, T('音符直後の1/32未満の休符を音符に繋げる(伸ばした区間は最後の音量のまま鳴る)')));
    const emCb = document.createElement('input'); emCb.type = 'checkbox';
    emCb.addEventListener('change', () => setKey('ENV_MERGE', emCb.checked));
    wrSec.appendChild(line(emCb, T('似た@v表を統合(近似)'), T('長さ違いの表を1本にまとめる'), null, T('段の並びが同じで長さが±1違うだけの@v/@vr表を1本にまとめる(段の境目が最大1フレーム動く)')));
    // 合成chの複製パートを省く(FOLD_DOUBLES、src/convert/poolDoubles.js。忠実=OFF / プレーン=ON)
    const fdCb = document.createElement('input'); fdCb.type = 'checkbox';
    fdCb.addEventListener('change', () => setKey('FOLD_DOUBLES', fdCb.checked));
    wrSec.appendChild(line(fdCb, T('合成chの複製パートを省く(近似)'), T('デチューン二重化・エコーを1本にする'), null, T('合成ch(鍵盤表示・ロールの「合成ch」と同じ。PSF/C352/C140/QSound/MultiPCM/SegaPCM などプール式PCMの論理レーン)で、同じ旋律を別のボイスで重ねたデチューン二重化や数フレーム遅れのエコーを検出し、複製側の音符を変換から外します(何を省いたかはMMLのヘッダに書きます)。ppmckにはディレイもコーラスも無いので、複製の分だけチャンネルを節約できます。OFFでも、N163等の枠へ自動で載せるチャンネルを選ぶときは複製を後回しにします')));
    checks.GATE_APPROX = gaCb; checks.LEN_DP = ldCb; checks.DPCM_EXACT = deCb; checks.SHAPE_REST = srCb; checks.ENV_MERGE = emCb; checks.FOLD_DOUBLES = fdCb;
    body.appendChild(wrSec);

    // ── 3b. 出力の書式(パートの並び / 1行の小節数 / 小節揃え)。折りたたみ、既定は閉 ──
    const lySec = foldSection('layout', T('出力の書式'), false, 'layout');
    const coSel = makeSelect(CHANNEL_ORDER_OPTIONS(), () => setKey('CHANNEL_ORDER', coSel.value));
    lySec.appendChild(line(null, T('チャンネルの並び順'), T('A,B,C… 順か、元の音源のch順か'), coSel,
      T('「アルファベット順」はパート文字の順(A,B,C…)。「変換元の割り当て順」は元の音源のチャンネル順(FM1,FM2…PSG1… の並び)で、割り当て先の文字が飛んでいてもその順に出す')));
    const poSel = makeSelect(PART_ORDER_OPTIONS(), () => setKey('PART_ORDER', poSel.value));
    lySec.appendChild(line(null, T('パートの並び'), T('全パートを数小節ずつ並べるか、1パートずつか'), poSel, T('「チャンネル順に小節ブロック」は全パートを数小節ずつ縦に並べる。「パートごとにまとめる」はAを最後まで書いてからB、と1パートずつ続ける')));
    const bpIn = document.createElement('input');
    bpIn.type = 'number'; bpIn.min = '1'; bpIn.max = String(MML.Convert.BARS_PER_LINE_MAX); bpIn.step = '1'; bpIn.className = 'cs-num';
    bpIn.addEventListener('change', () => setKey('BARS_PER_LINE', bpIn.value));
    bpIn.addEventListener('click', (e) => e.preventDefault());
    const bpWrap = el('span', 'cs-inline');
    bpWrap.appendChild(bpIn);
    bpWrap.appendChild(el('span', null, T('小節')));
    lySec.appendChild(line(null, T('1行の小節数'), T('この小節数ごとに改行する'), bpWrap, T('この小節数ごとに改行する(1〜16)')));
    const baCb = document.createElement('input'); baCb.type = 'checkbox';
    baCb.addEventListener('change', () => setKey('BAR_ALIGN', baCb.checked));
    lySec.appendChild(line(baCb, T('小節を揃える'), T('小節の頭を縦にそろえる'), null, T('小節の区切りを全パートで同じ桁に揃える(空白で埋める)。OFFならスペース1つで区切る')));
    checks.BAR_ALIGN = baCb;
    // ループを自動検出(LOOP_DETECT、src/convert/mmlEmit.js detectLoop)。プリセット外(出力の書式と同じ扱い)
    const ldLoopCb = document.createElement('input'); ldLoopCb.type = 'checkbox';
    ldLoopCb.addEventListener('change', () => setKey('LOOP_DETECT', ldLoopCb.checked));
    lySec.appendChild(line(ldLoopCb, T('ループを自動検出'), T('イントロ+1周だけ書き出して L を置く'), null,
      T('元曲のループ周期を全チャンネルの音符列から検出し、イントロ+1周ぶんだけを書き出して各チャンネルのループ開始位置に L を置きます。長く変換しても曲データが1周ぶんで済むのでNSFが小さくなります。イントロとループ1周の長さは全チャンネルで一致させます(ずれると周回のたびにチャンネルがずれていくため)。一致させられない場合と、変換した長さが「イントロ+2周」に満たず確認できない場合は、通常どおり全部を書き出します')));
    checks.LOOP_DETECT = ldLoopCb;
    body.appendChild(lySec);

    // ── 4. 詳細設定(折りたたみ) ──
    const det = foldSection('advanced', T('詳細設定'), false, 'adv');
    const tnSel = makeSelect(TUNING_OPTIONS(), () => setKey('TUNING', tnSel.value));
    const tmIn = document.createElement('input');
    tmIn.type = 'number'; tmIn.min = '0'; tmIn.max = String(MML.Convert.TUNING_MIN_MAX); tmIn.step = '0.5'; tmIn.className = 'cs-num';
    tmIn.addEventListener('change', () => setKey('TUNING_MIN', tmIn.value));
    tmIn.addEventListener('click', (e) => e.preventDefault());
    const tmWrap = el('span', 'cs-inline');
    tmWrap.title = T('自動検出のとき、測った偏差の絶対値がこのセント数未満なら何もしない(既定5。0〜50)。小さくするほど僅かなずれでも #TUNING / #TUNING-NOTE が付く');
    tmWrap.appendChild(el('span', null, T('最小偏差')));
    tmWrap.appendChild(tmIn);
    tmWrap.appendChild(el('span', null, T('セント')));
    det.appendChild(line(null, T('基準ピッチ'), T('曲の音程のずれを測って補正'), inline2(tnSel, tmWrap), T('「自動検出」は曲全体の音程が12平均律(A4=440Hz)から何セントずれているかを測り、ずらした基準で音符に丸めて #TUNING をヘッダに出す。「音名別に自動検出」は音名(c〜b)ごとにずれを測り、ずれている音名だけを #TUNING-NOTE でずらす(音程表が音名ごとに外れている曲用。例: F# だけ +33 セント)。どちらも音名は変わらず、再生とNSF書き出しの周波数テーブルがその分だけずれる')));
    const snSel = makeSelect(SN_PERIODIC_OPTIONS(), () => setKey('SN_PERIODIC', snSel.value));
    det.appendChild(line(null, T('SN76489の周期ノイズ'), T('SMS/GG/メガドライブのPSG'), snSel, T('SN76489 のノイズには、ホワイトノイズのほかに「周期ノイズ」(1/16デューティの細いパルスのような、音程のある音)がある。2A03に同じ音は無いので、ホワイトノイズ(長周期)にするか、2A03の短周期ノイズ(@1、93ステップの金属的な音)で音程を合わせるかを選ぶ。周期ノイズの高さを切り替えてタムやキックを作っている曲で差が出る')));
    body.appendChild(det);

    // ── N163(実効ch数・ピッチ精度・波形RAM)。1つの物理量で3つ同時に動くので1か所へ ──
    const n163 = foldSection('n163', T('N163 (ナムコ163)'), false, 'adv');
    n163.appendChild(descLine(
      T('実効ch数を減らすと、波形を大きくでき、音量が出て、高い音まで出せます。代わりに音程の刻みが粗くなります。'),
      T('実機N163は8chを時間多重するため、有効ch数が1つ動くと3つ同時に動きます。波形RAM=128-8×ch数バイト(1ch=120 / 8ch=64)。音量=出力は有効ch数で平均されるので1chは5chの5倍。周波数レジスタ=ch数に比例し、少ないほど刻みが粗く、出せる最高音は上がる(32サンプル波形で8ch=1864Hz / 1ch=14915Hz)')));
    // いまの設定で出せる最高音。波形長は既定の32サンプルを基準に出す(実際の長さは曲ごとに
    // 変わり、「RAMと音域の両方」を選んでいれば足りない波形だけ自動で縮む)
    const rangeNote = el('div', 'cs-desc');
    function updateN163Range() {
      const Fit = MML.Convert && MML.Convert.N163Fit;
      if (!Fit || !Fit.maxNoteFor) { rangeNote.textContent = ''; return; }
      const numCh = (ncSel.value === 'used') ? null : 8;
      const NN = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
      const name = (n) => NN[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1);
      if (numCh === null) {
        rangeNote.textContent = T('出せる最高音は使ったch数で変わります(32サンプル波形で 1ch={n1} 〜 8ch={n8})',
          { n1: name(Fit.maxNoteFor(32, 1)), n8: name(Fit.maxNoteFor(32, 8)) });
      } else {
        rangeNote.textContent = T('この設定(8ch・32サンプル波形)では {note} が最高です。これを超える音は波形を縮めて届かせます',
          { note: name(Fit.maxNoteFor(32, 8)) });
      }
      rangeNote.title = T('N163の周波数レジスタは18bitで、freqReg = 音の周波数×15×65536×波形長×有効ch数÷CPUクロック。波形を半分にすると上限は1オクターブ上がります');
    }
    const ncSel = makeSelect(N163_CH_OPTIONS(), () => { setKey('N163_CH', ncSel.value); updateN163Range(); });
    n163.appendChild(line(null, T('実効ch数'), T('#EX-N163 に書く値'), ncSel, T('8ch固定なら、ch数で変わる値(波形RAM・音量・音程の刻み)が曲によって変わりません。使ったch数だけにすると、使ったスロットの一番大きい番号がそのまま実効ch数になります(ch1とch8なら8、ch2とch6なら6)。大きい波形を使いたい・音量を出したい・高い音を出したいときはこちら。元がN163のNSF変換はこの設定の対象外で、元の曲のch数に従います')));
    n163.appendChild(rangeNote);
    const saSel = makeSelect(PITCH_SA_OPTIONS(), () => setKey('PITCH_SA', saSel.value));
    n163.appendChild(line(null, T('ピッチ精度(SA)'), T('N163のSA<n>の選び方'), saSel, T('N163出力のSA<n>(D/EP/MPの倍率)の選び方。深いビブラートをテーブルのbyte幅を超えて表現する。SAは実効ch数に追随するので、ch数を変えてもEP/MPの刻みは一定に保たれます')));
    const nwSel = makeSelect(N163_WAVE_OPTIONS(), () => setKey('N163_WAVE', nwSel.value));
    n163.appendChild(line(null, T('波形RAM'), T('波形がRAMに入り切らないとき'), nwSel, T('N163が波形に使えるRAMは 128-8×実効ch数 バイトだけ。同時に鳴る波形が入り切らない曲で、はみ出したぶんの波形長を落とすかどうか。落とさないとコンパイルエラーで再生・書き出しができません')));
    body.appendChild(n163);

    function syncAll() {
      for (const [k, cb] of Object.entries(checks)) cb.checked = !!current[k];
      neSel.value = current.NOTE_END || 'next';
      gtIn.value = String(current.GATE_TOL != null ? current.GATE_TOL : MML.Convert.GATE_TOL_DEFAULT);
      gtIn.disabled = !current.GATE_APPROX;
      lsIn.value = String(current.LEN_SNAP != null ? current.LEN_SNAP : MML.Convert.LEN_SNAP_DEFAULT);
      coSel.value = current.CHANNEL_ORDER || 'letter';
      poSel.value = current.PART_ORDER || 'block';
      bpIn.value = String(current.BARS_PER_LINE || 4);
      ncSel.value = current.N163_CH || 'fixed8';
      saSel.value = current.PITCH_SA || 'octave';
      nwSel.value = current.N163_WAVE || 'both';
      updateN163Range();
      tnSel.value = current.TUNING || 'auto';
      tmIn.value = String(current.TUNING_MIN != null ? current.TUNING_MIN : MML.Convert.TUNING_MIN_DEFAULT);
      tmIn.disabled = current.TUNING === 'a440'; // 最小偏差は「自動検出」「音名別」の両方で効く
      snSel.value = current.SN_PERIODIC || 'white';
      const name = MML.Convert.cmdPresetName(current);
      for (const [n, b] of Object.entries(presetButtons)) b.classList.toggle('es-preset--active', n === name);
      customTag.style.display = name === 'custom' ? '' : 'none';
    }
    syncAll();

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
    // ボタンのツールチップは「変換設定: <プリセット名>」の組み立てなので、表示言語を切り替えたら付け直す
    if (MML.I18n) MML.I18n.onChange(refreshButtons);
  }

  MML.UI.ConvertSettings = { init, get, set, onChange, open: openModal };
})(window);
