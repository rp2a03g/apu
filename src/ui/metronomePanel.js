/*
 * メトロノームUI (MML.UI.MetronomePanel) — UI層
 *
 * MMLウィンドウのツールバーにある2つのボタンを受け持つ:
 *   ♩ボタン  … メトロノームのON/OFF(カウントイン付きで開始)
 *   ⚙ボタン  … 設定ポップオーバー(テンポ/拍子/刻み/カウントイン/音量/入力オフセット)
 *
 * 音の生成と時刻管理はコア層(src/input/metronome.js)。ここはDOMと設定の保存だけを見る。
 * 入力オフセットの較正もここに置く: メトロノームのクリックに合わせてパッドを
 * 叩いてもらい、そのずれの中央値を MML.Input.Latency へ書き戻す。
 * この値はフェーズ3のMIDI録音・フェーズ4の鼻歌入力がそのまま使う。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI  = MML.UI = MML.UI || {};
  const T   = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const STORAGE_KEY = 'mml.metronome';
  const DEFAULTS = {
    bpm: 120,          // followMml=false のときに使う手動テンポ
    followMml: true,   // MMLの t<n> に追従する
    beatsPerBar: 4,
    subdivision: 1,    // 1=4分 2=8分 3=3連8分 4=16分
    countInBars: 1,
    volume: 0.5
  };
  const CAL_TAPS = 16;              // 較正で叩いてもらう回数
  const FLASH_MS = 90;              // ボタンの点滅時間

  const SUBDIVISION_OPTIONS = [
    [1, '4分音符'],
    [2, '8分音符'],
    [3, '3連8分音符'],
    [4, '16分音符']
  ];

  let state       = Object.assign({}, DEFAULTS);
  let metro       = null;
  let toggleEl    = null;
  let settingsEl  = null;
  let getAudioCtx = null;
  let getMmlTempo = null;
  let getPlaybackClock = null;  // () => { songSec, ctxTime } | null (再生中のみ)
  let needSync = false;         // 次に対応表が取れたら再生へ合わせ直す

  let popEl = null, popCloseHandler = null, popTempoTimer = null;
  let els = {};            // ポップオーバー内の主要要素
  let cal = null;          // 較正中/直後の状態 { taps, done, result }

  // ---- 設定の保存/復元 -------------------------------------------------

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
          if (raw[k] != null) state[k] = raw[k];
        }
      }
    } catch (e) { /* ignore */ }
    // 保存値が壊れていても動くように最低限のクランプをかける
    state.bpm         = clampNum(state.bpm, 20, 400, DEFAULTS.bpm);
    state.beatsPerBar = clampNum(state.beatsPerBar, 1, 16, DEFAULTS.beatsPerBar);
    state.subdivision = clampNum(state.subdivision, 1, 4, DEFAULTS.subdivision);
    state.countInBars = clampNum(state.countInBars, 0, 4, DEFAULTS.countInBars);
    state.volume      = Math.max(0, Math.min(1, Number(state.volume) || DEFAULTS.volume));
    state.followMml   = !!state.followMml;
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function clampNum(v, min, max, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // ---- メトロノーム本体 ------------------------------------------------

  /*
   * MMLの t<n> に追従する設定なら、そちらを優先する。MMLが未入力/テンポ未指定の
   * ときは手動値へ落ちる(「追従」を選んだ瞬間に無音や極端なテンポにならないように)。
   */
  function effectiveBpm() {
    if (state.followMml && getMmlTempo) {
      const t = getMmlTempo();
      if (Number.isFinite(t) && t > 0) return t;
    }
    return state.bpm;
  }

  function ensureMetro() {
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx || !MML.Input || !MML.Input.Metronome) return null;
    if (metro && metro.ctx !== ctx) { metro.dispose(); metro = null; }
    if (!metro) {
      metro = new MML.Input.Metronome(ctx, { volume: state.volume });
      metro.onTick = onTick;
    }
    applyStateToMetro();
    return metro;
  }

  function applyStateToMetro() {
    if (!metro) return;
    metro.setTempo(effectiveBpm());
    metro.setBeatsPerBar(state.beatsPerBar);
    metro.setSubdivision(state.subdivision);
    metro.setVolume(state.volume);
  }

  function isRunning() { return !!(metro && metro.isRunning()); }

  // ---- 曲の再生への同期 ------------------------------------------------

  /*
   * 再生中の曲の拍へクリックを合わせ直す。
   * ★プレイヤーの getPosition() と currentTime を直接突き合わせてはいけない
   *   (ScriptProcessorNodeは1バッファ先を埋めるので約93msずれる)。
   *   src/audio/stream-player.js の songTimeAt()/ctxTimeAt() が持つ対応表を使う。
   * ★曲頭からテンポ一定であることを前提にした換算(曲の途中に t<n> があるとずれる)。
   */
  function syncToPlayback(songSec, ctxOfSongSec) {
    const m = ensureMetro();
    if (!m) return false;
    const tickDur = m.tickDurSec();
    if (!(tickDur > 0)) return false;
    // 直後の拍から鳴らす。ほぼ拍の上にいるときに1つ前を鳴らさないよう少しだけ進める
    const idx = Math.ceil((songSec + 1e-4) / tickDur);
    const at = ctxOfSongSec + (idx * tickDur - songSec);
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx || at < ctx.currentTime + 0.02) return false;  // 間に合わない
    m.start({ at, startIndex: idx, countInBars: 0 });
    updateToggleUI();
    return true;
  }

  /* 再生開始/シークのたびに main.js から呼ぶ。実際の同期は対応表が立ってから */
  function requestPlaybackSync() { needSync = true; }

  /*
   * main.js の再生UI更新(rAF)から毎フレーム呼ばれる。同期が要求されていて
   * 対応表が取れたときだけ動く(それ以外は何もしないので毎フレーム呼んでよい)。
   */
  function tickPlaybackSync() {
    if (!needSync || !isRunning() || !getPlaybackClock) return;
    const c = getPlaybackClock();
    if (!c) return;
    if (syncToPlayback(c.songSec, c.ctxTime)) needSync = false;
  }

  function start(opts = {}) {
    const m = ensureMetro();
    if (!m) return;
    // 曲が鳴っている最中に点けたら、カウントインではなく曲の拍へ合わせる
    const clock = (!opts.forceCountIn && getPlaybackClock) ? getPlaybackClock() : null;
    if (clock && syncToPlayback(clock.songSec, clock.ctxTime)) return;
    m.start({ countInBars: (opts.countInBars != null) ? opts.countInBars : state.countInBars });
    updateToggleUI();
  }

  function stop() {
    if (metro) metro.stop();
    updateToggleUI();
    updateCalUI();
  }

  function toggle() {
    if (isRunning()) stop();
    else start();
  }

  /*
   * 拍を予約した瞬間に呼ばれる(=発音の最大200ms前)。実際の発音時刻に合わせて
   * 点滅させたいので、差分ぶんだけ setTimeout で遅らせる。
   */
  function onTick(info) {
    // 走行中にMML側のテンポが変わったら追従する(次に予約する拍から効く)
    if (metro) metro.setTempo(effectiveBpm());
    const ctx = getAudioCtx ? getAudioCtx() : null;
    const delayMs = ctx ? Math.max(0, (info.time - ctx.currentTime) * 1000) : 0;
    setTimeout(() => flash(info), delayMs);
    if (cal && !cal.done) updateCalUI(info);
  }

  function flash(info) {
    if (!toggleEl) return;
    toggleEl.classList.add('is-beat');
    if (info.kind === 'accent') toggleEl.classList.add('is-accent');
    setTimeout(() => {
      toggleEl.classList.remove('is-beat', 'is-accent');
    }, FLASH_MS);
  }

  function updateToggleUI() {
    if (!toggleEl) return;
    const on = isRunning();
    toggleEl.classList.toggle('is-active', on);
    toggleEl.title = on ? T('メトロノームを止める') : T('メトロノームを鳴らす');
    toggleEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---- 設定ポップオーバー ----------------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function section(title) {
    const sec = el('div', 'metro-sec');
    sec.appendChild(el('div', 'metro-sec-title', title));
    return sec;
  }

  function buildPopover() {
    const pop = el('div', 'metro-pop');
    // フローティングウィンドウのドラッグ/前面化を起こさない
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());

    // --- テンポ ---
    const secTempo = section(T('テンポ'));
    const labFollow = el('label', 'metro-opt');
    els.followRadio = document.createElement('input');
    els.followRadio.type = 'radio';
    els.followRadio.name = 'metro-tempo-src';
    els.followRadio.checked = state.followMml;
    labFollow.appendChild(els.followRadio);
    labFollow.appendChild(document.createTextNode(T('MMLに追従')));
    els.tempoHint = el('span', 'metro-hint');
    labFollow.appendChild(els.tempoHint);
    secTempo.appendChild(labFollow);

    const labManual = el('label', 'metro-opt');
    els.manualRadio = document.createElement('input');
    els.manualRadio.type = 'radio';
    els.manualRadio.name = 'metro-tempo-src';
    els.manualRadio.checked = !state.followMml;
    labManual.appendChild(els.manualRadio);
    labManual.appendChild(document.createTextNode(T('手動')));
    els.bpmInput = document.createElement('input');
    els.bpmInput.type = 'number';
    els.bpmInput.min = '20';
    els.bpmInput.max = '400';
    els.bpmInput.step = '1';
    els.bpmInput.value = String(state.bpm);
    els.bpmInput.className = 'metro-num';
    labManual.appendChild(els.bpmInput);
    labManual.appendChild(el('span', 'metro-unit', 'BPM'));
    secTempo.appendChild(labManual);

    const onTempoSrcChange = () => {
      state.followMml = els.followRadio.checked;
      saveState(); applyStateToMetro(); updateTempoHint();
    };
    els.followRadio.addEventListener('change', onTempoSrcChange);
    els.manualRadio.addEventListener('change', onTempoSrcChange);
    els.bpmInput.addEventListener('input', () => {
      state.bpm = clampNum(els.bpmInput.value, 20, 400, state.bpm);
      // 手動値を触ったら「手動」に切り替わるのが自然
      if (!els.manualRadio.checked) { els.manualRadio.checked = true; state.followMml = false; }
      saveState(); applyStateToMetro(); updateTempoHint();
    });
    pop.appendChild(secTempo);

    // --- 拍子 / 刻み ---
    const secMeter = section(T('拍子'));
    const rowMeter = el('div', 'metro-row');
    rowMeter.appendChild(el('span', null, T('1小節の拍数')));
    els.beatsSelect = document.createElement('select');
    for (let n = 1; n <= 8; n++) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = String(n);
      els.beatsSelect.appendChild(o);
    }
    els.beatsSelect.value = String(state.beatsPerBar);
    els.beatsSelect.addEventListener('change', () => {
      state.beatsPerBar = clampNum(els.beatsSelect.value, 1, 16, state.beatsPerBar);
      saveState(); applyStateToMetro();
    });
    rowMeter.appendChild(els.beatsSelect);
    secMeter.appendChild(rowMeter);

    const rowSub = el('div', 'metro-row');
    rowSub.appendChild(el('span', null, T('刻み')));
    els.subSelect = document.createElement('select');
    for (const [value, label] of SUBDIVISION_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(value); o.textContent = T(label);
      els.subSelect.appendChild(o);
    }
    els.subSelect.value = String(state.subdivision);
    els.subSelect.addEventListener('change', () => {
      state.subdivision = clampNum(els.subSelect.value, 1, 4, state.subdivision);
      saveState(); applyStateToMetro();
    });
    rowSub.appendChild(els.subSelect);
    secMeter.appendChild(rowSub);
    pop.appendChild(secMeter);

    // --- カウントイン ---
    const secCount = section(T('カウントイン'));
    const rowCount = el('div', 'metro-row');
    els.countSelect = document.createElement('select');
    for (const n of [0, 1, 2]) {
      const o = document.createElement('option');
      o.value = String(n);
      // 英語は 1 bar / 2 bars と単複が変わるので、1小節だけ別のキーにしてある
      o.textContent = n === 0 ? T('なし') : (n === 1 ? T('1小節') : T('{n}小節', { n }));
      els.countSelect.appendChild(o);
    }
    els.countSelect.value = String(state.countInBars);
    els.countSelect.addEventListener('change', () => {
      state.countInBars = clampNum(els.countSelect.value, 0, 4, state.countInBars);
      saveState();
    });
    rowCount.appendChild(els.countSelect);
    secCount.appendChild(rowCount);
    pop.appendChild(secCount);

    // --- 音量 ---
    const secVol = section(T('クリック音量'));
    const rowVol = el('div', 'metro-row metro-row-vol');
    els.volInput = document.createElement('input');
    els.volInput.type = 'range';
    els.volInput.min = '0'; els.volInput.max = '100'; els.volInput.step = '1';
    els.volInput.value = String(Math.round(state.volume * 100));
    els.volLabel = el('span', 'metro-unit', Math.round(state.volume * 100) + '%');
    els.volInput.addEventListener('input', () => {
      state.volume = Number(els.volInput.value) / 100;
      els.volLabel.textContent = els.volInput.value + '%';
      saveState();
      if (metro) metro.setVolume(state.volume);
    });
    rowVol.appendChild(els.volInput);
    rowVol.appendChild(els.volLabel);
    secVol.appendChild(rowVol);
    pop.appendChild(secVol);

    // --- 入力オフセット ---
    const secOffset = section(T('入力オフセット'));
    const rowOffset = el('div', 'metro-row');
    els.offsetInput = document.createElement('input');
    els.offsetInput.type = 'number';
    els.offsetInput.min = '-500'; els.offsetInput.max = '500'; els.offsetInput.step = '1';
    els.offsetInput.className = 'metro-num';
    els.offsetInput.value = String(Math.round(MML.Input.Latency.getOffsetSec() * 1000));
    els.offsetInput.addEventListener('input', () => {
      MML.Input.Latency.setOffsetSec(Number(els.offsetInput.value) / 1000);
    });
    rowOffset.appendChild(els.offsetInput);
    rowOffset.appendChild(el('span', 'metro-unit', 'ms'));
    els.calButton = el('button', 'metro-btn', T('較正…'));
    els.calButton.type = 'button';
    els.calButton.addEventListener('click', startCalibration);
    rowOffset.appendChild(els.calButton);
    secOffset.appendChild(rowOffset);
    secOffset.appendChild(el('div', 'metro-note',
      T('録音時に入力の時刻からこの値を引きます。クリックより遅れて叩く癖があればプラスになります。')));

    // 較正エリア(既定は非表示)
    els.calArea = el('div', 'metro-cal');
    els.calArea.hidden = true;
    els.calText = el('div', 'metro-cal-text');
    els.calPad = el('button', 'metro-cal-pad', T('ここを叩く'));
    els.calPad.type = 'button';
    els.calPad.addEventListener('pointerdown', onTap);
    els.calPad.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === ' ' || e.key === 'Enter') onTap(e);
    });
    els.calStatus = el('div', 'metro-cal-status');
    els.calCancel = el('button', 'metro-btn', T('やめる'));
    els.calCancel.type = 'button';
    els.calCancel.addEventListener('click', cancelCalibration);
    els.calArea.appendChild(els.calText);
    els.calArea.appendChild(els.calPad);
    els.calArea.appendChild(els.calStatus);
    els.calArea.appendChild(els.calCancel);
    secOffset.appendChild(els.calArea);
    pop.appendChild(secOffset);

    return pop;
  }

  function updateTempoHint() {
    if (!els.tempoHint) return;
    const t = getMmlTempo ? getMmlTempo() : null;
    els.tempoHint.textContent = (Number.isFinite(t) && t > 0)
      ? T('({bpm} BPM)', { bpm: Math.round(t * 10) / 10 })
      : T('(未検出 → 手動値)');
  }

  function openPopover() {
    if (popEl) { closePopover(); return; }
    const pop = buildPopover();
    document.body.appendChild(pop);

    // アンカー(⚙)の直下、右端揃え。画面からはみ出す場合は寄せる
    const r = settingsEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right - pw, top = r.bottom + 4;
    if (left < 4) left = 4;
    if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';

    popEl = pop;
    updateTempoHint();
    // MML本文のテンポは随時変わるので、開いている間だけ定期的に引き直す
    popTempoTimer = setInterval(updateTempoHint, 500);

    popCloseHandler = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type !== 'keydown' && (pop.contains(e.target) || settingsEl.contains(e.target))) return;
      closePopover();
    };
    // 今のクリックでいきなり閉じないよう次のタスクで登録する
    setTimeout(() => {
      document.addEventListener('mousedown', popCloseHandler, true);
      document.addEventListener('keydown', popCloseHandler, true);
    }, 0);
  }

  function closePopover() {
    if (!popEl) return;
    if (cal) cancelCalibration();
    document.removeEventListener('mousedown', popCloseHandler, true);
    document.removeEventListener('keydown', popCloseHandler, true);
    clearInterval(popTempoTimer);
    popTempoTimer = null;
    popCloseHandler = null;
    popEl.remove();
    popEl = null;
    els = {};
  }

  // ---- 入力オフセットの較正 --------------------------------------------

  function startCalibration() {
    const m = ensureMetro();
    if (!m) return;
    cal = { taps: [], done: false, result: null };
    // 較正は必ず4分音符で叩いてもらう。8分/16分刻みのままだと最寄り拍の間隔が
    // 半分以下になり、少し遅れただけで「次の拍を早めに叩いた」と誤判定される
    m.setSubdivision(1);
    m.start({ countInBars: 1 });
    updateToggleUI();
    els.calArea.hidden = false;
    els.calButton.disabled = true;
    els.calText.textContent = T('クリック音に合わせて、下のパッドを{n}回叩いてください(スペースキーでも可)。', { n: CAL_TAPS });
    els.calPad.hidden = false;
    els.calPad.focus();
    updateCalUI();
  }

  function cancelCalibration() {
    cal = null;
    if (metro) metro.stop();
    applyStateToMetro();   // 較正用に潰した刻み設定を戻す
    updateToggleUI();
    if (els.calArea) {
      els.calArea.hidden = true;
      els.calButton.disabled = false;
    }
  }

  function onTap(evt) {
    if (!cal || cal.done) return;
    // ボタンの既定動作(Spaceでclick発火)を止めて二重カウントを防ぐ
    evt.preventDefault();
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx || !metro) return;
    const t = MML.Input.Latency.contextTimeFromEvent(ctx, evt);
    // カウントイン中の拍は基準にしない(まだ拍の取り方が定まっていない)
    const near = metro.nearestTick(t, { countIn: false });
    if (!near) return;
    if (Math.abs(near.delta) > metro.tickDurSec() / 2) return;
    cal.taps.push(near.delta);
    updateCalUI();
    if (cal.taps.length >= CAL_TAPS) finishCalibration();
  }

  function finishCalibration() {
    const half = metro ? metro.tickDurSec() / 2 : 0.25;
    const result = MML.Input.Latency.estimateTapOffset(cal.taps, {
      maxAbs: Math.min(0.25, half * 0.7)
    });
    cal.done = true;
    cal.result = result;
    if (metro) metro.stop();
    applyStateToMetro();
    updateToggleUI();

    els.calPad.hidden = true;
    els.calButton.disabled = false;
    els.calCancel.textContent = T('閉じる');

    if (!result) {
      els.calText.textContent = T('うまく測れませんでした。もう一度お試しください。');
      els.calStatus.textContent = '';
      return;
    }
    const ms = MML.Input.Latency.setOffsetSec(result.offsetSec) * 1000;
    els.offsetInput.value = String(Math.round(ms));
    els.calText.textContent = T('入力オフセットを {ms} ms に設定しました。', { ms: Math.round(ms) });
    els.calStatus.textContent = T('ばらつき ±{jitter} ms / {used}回を採用({rejected}回を除外)', {
      jitter: Math.round(result.jitterSec * 1000),
      used: result.used,
      rejected: result.rejected
    });
  }

  function updateCalUI(tickInfo) {
    if (!cal || !els.calStatus) return;
    if (cal.done) return;
    if (tickInfo && tickInfo.countIn) {
      els.calStatus.textContent = T('カウントイン… {n}', { n: tickInfo.countInLeft });
      return;
    }
    els.calStatus.textContent = `${cal.taps.length} / ${CAL_TAPS}`;
  }

  // ---- 公開API ---------------------------------------------------------

  UI.MetronomePanel = {
    /*
     * opts.toggleEl / opts.settingsEl: ツールバーの2つのボタン
     * opts.getAudioCtx: () => AudioContext (必要なら生成して返す)
     * opts.getMmlTempo: () => number|null  現在のMMLのテンポ(BPM)
     */
    init(opts) {
      toggleEl    = opts.toggleEl;
      settingsEl  = opts.settingsEl;
      getAudioCtx = opts.getAudioCtx;
      getMmlTempo = opts.getMmlTempo;
      getPlaybackClock = opts.getPlaybackClock || null;
      loadState();
      if (toggleEl)   toggleEl.addEventListener('click', toggle);
      if (settingsEl) settingsEl.addEventListener('click', openPopover);
      updateToggleUI();
    },

    isRunning,
    start,
    stop,
    toggle,
    syncToPlayback,
    requestPlaybackSync,
    tickPlaybackSync,
    /* 1小節あたりの拍数(録音側が量子化の小節長に使う) */
    getBeatsPerBar() { return state.beatsPerBar; },
    /* 現在の実効テンポ(BPM)。将来の録音側が拍格子を作るのに使う */
    getBpm: effectiveBpm,
    /* 録音側が拍位置を引くための本体。走っていなければ null */
    getMetronome() { return metro; }
  };

})(window);
