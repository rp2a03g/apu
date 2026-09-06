/*
 * 演奏入力UI (MML.UI.PerformInput) — UI層
 *
 * ROADMAPフェーズ3 段階1。PC鍵盤と画面ピアノで音を出せるようにし、その打鍵を
 * すべて MML.Input.NoteSource へ集約する。段階2の録音は NoteSource の
 * onEvent(TimedPitchEvent) を受け取るだけでよく、入力源ごとの分岐は増えない。
 *
 * ■ 「演奏入力中」はPC鍵盤を横取りする
 *   トラッカーと同じで、モード中は z/x/c… が音符になりMMLの文字入力には入らない。
 *   混乱しないよう次の2つを守る:
 *     ・モードに入るとき、MMLエディタにフォーカスがあれば外す
 *     ・エディタや入力欄にフォーカスが入ったら**自動でモードを抜ける**
 *   これで「打とうとしたら文字が入らない」状態に閉じ込められない。Escでも抜ける。
 *
 * ■ 音は借用先の音源そのもの
 *   音色の選択肢は変換の借用先(src/convert/channelPlan.js)をそのまま使い、
 *   発音は src/audio/live-monitor.js(= AssignPreview)に任せる。
 *   「モニタで聴いた音」と「変換・NSF書き出しの音」を別実装にしないため。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI  = MML.UI = MML.UI || {};
  const T   = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const STORAGE_KEY = 'mml.performInput';
  // polyphony: 同時に鳴らす声部の数。既定3は2A03の pulse1/pulse2/triangle =
  // ファミコン曲の定番の3声(voiceTargets参照)
  const DEFAULTS = { target: 'pulse1', tone: '2', octave: 4, velocity: 100, polyphony: 3, midi: false, midiChannel: 0 };

  let state       = Object.assign({}, DEFAULTS);
  let armed       = false;
  let toggleEl    = null;
  let settingsEl  = null;
  let getAudioCtx = null;
  let onArmedChange = null;
  let onNotesChange = null;   // 押している音が変わるたび(画面ピアノの点灯を描き直す)

  let source  = null;   // MML.Input.NoteSource
  let monitor = null;   // MML.Audio.LiveMonitor
  let popEl = null, popCloseHandler = null;
  let els = {};
  const downCodes = new Set();  // 押しっぱなしのcode(キーリピート対策と取りこぼし防止)

  // ---- 設定の保存/復元 -------------------------------------------------

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULTS)) if (raw[k] != null) state[k] = raw[k];
      }
    } catch (e) { /* ignore */ }
    const KM = MML.Input.KeyMap;
    state.octave   = clampNum(state.octave, KM.OCTAVE_MIN, KM.OCTAVE_MAX, DEFAULTS.octave);
    state.velocity = clampNum(state.velocity, 1, 127, DEFAULTS.velocity);
    state.midiChannel = clampNum(state.midiChannel, 0, 16, DEFAULTS.midiChannel);
    state.polyphony = clampNum(state.polyphony, 1, 8, DEFAULTS.polyphony);
    state.midi = !!state.midi;
    if (!plan() || !plan().TARGETS[state.target]) state.target = DEFAULTS.target;
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function clampNum(v, min, max, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function plan() { return MML.Convert && MML.Convert.ChannelPlan; }

  // ---- 音色(借用先)の選択肢 ------------------------------------------

  function targetOptions() {
    const P = plan();
    if (!P) return [];
    // skip(変換しない)と dpcm(打楽器サンプル)は「弾く」対象にならないので外す
    return Object.keys(P.TARGETS)
      .filter(t => t !== 'skip' && t !== 'dpcm')
      .map(t => [t, P.targetLabel(t)]);
  }

  /*
   * 借用先ごとの音色(duty/波形/VRC7音色)。ChannelPlanの語彙をそのまま使う。
   * ★第2引数の 'spc' は「音色選択を全部出せるフォーマット」の意味(capsOf参照)。
   *   演奏入力はフォーマット非依存なので、制限の無い側を指定して一覧を得る。
   */
  function toneOptionsFor(target) {
    const P = plan();
    if (!P) return null;
    const kind = P.toneKindFor(target, 'spc');
    if (!kind) return null;
    const o = P.toneOptionsFor(kind, null);
    if (!o) return null;
    // 'copy'(元の波形をコピー)は演奏入力には元が無いので出さない
    const opts = o.opts.filter(pair => pair[0] !== 'copy');
    const def = (o.def === 'copy') ? (opts[0] && opts[0][0]) : o.def;
    return { def, opts };
  }

  /*
   * 選んだ借用先から始めて、同じチップの「音程を持つ」借用先を並び順に取る。
   * 2A03で pulse1 を選べば [pulse1, pulse2, triangle](ノイズ/DPCMは除く)になり、
   * 高い音からこの順に配ると メロディ=pulse1・ベース=三角波 という
   * 実際のファミコン曲の書き方に一致する(配り方は live-monitor.js selectVoices)。
   */
  function melodicTargetsFrom(target) {
    const P = plan();
    if (!P) return [target];
    const tt = P.targetInfo(target);
    if (!tt || !tt.chip) return [target];
    const all = Object.keys(P.TARGETS).filter((t) => {
      const i = P.targetInfo(t);
      return i && i.chip === tt.chip && i.family !== 'noise' && i.family !== 'dpcm';
    });
    const at = all.indexOf(target);
    return (at < 0) ? [target] : all.slice(at);
  }

  function maxPolyphony() { return Math.max(1, melodicTargetsFrom(state.target).length); }

  /* 声部ごとの音色。同じ種類(duty/波形/VRC7音色)なら選んだ音色を、違えばその既定を使う */
  function toneForTarget(target) {
    const o = toneOptionsFor(target);
    if (!o) return null;
    if (state.tone != null && o.opts.some((pr) => pr[0] === state.tone)) return state.tone;
    return o.def;
  }

  function voiceTargets() {
    const n = Math.min(Math.max(1, state.polyphony), maxPolyphony());
    return melodicTargetsFrom(state.target).slice(0, n)
      .map((t) => ({ target: t, tone: toneForTarget(t) }));
  }

  function normalizeTone() {
    const o = toneOptionsFor(state.target);
    if (!o) { state.tone = null; return; }
    if (!o.opts.some(pair => pair[0] === state.tone)) state.tone = o.def;
  }

  // ---- 発音 -------------------------------------------------------------

  function ensureSource() {
    if (source) return source;
    source = new MML.Input.NoteSource({ velocity: state.velocity });
    // ★1声のときは NoteSource の後着優先(active)をそのまま使う。
    //   多声のときだけ「押している全部」を声部へ配る(配り方は live-monitor.js)。
    //   1声でも最高音優先にしてしまうと、既存の単音モニタの挙動が変わってしまう。
    source.onVoicesChange = (voices) => {
      if (!monitor) return;
      if (monitor.voiceCount() <= 1) {
        const a = source.getActive();
        monitor.setNote(a ? a.note : null, a ? a.velocity : 0);
      } else {
        monitor.setVoices(voices);
      }
    };
    return source;
  }

  /*
   * モニタ(音)は armed とは別に管理する。
   * ★MIDIはPC鍵盤と違って文字入力を横取りしないので、演奏入力モードに入らなくても
   *   弾いたら鳴ってほしい。armedはあくまで「PC鍵盤を横取りしているか」の意味に留める。
   */
  function monitorShouldRun() { return armed || (state.midi && MML.Input.MidiInput.isEnabled()); }

  function syncMonitor() {
    if (monitorShouldRun()) {
      const m = ensureMonitor();
      if (m) m.start();
    } else if (monitor) {
      monitor.stop();
    }
  }

  function ensureMonitor() {
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx || !MML.Audio.LiveMonitor) return null;
    if (monitor && monitor.audioCtx !== ctx) { monitor.dispose(); monitor = null; }
    if (!monitor) monitor = new MML.Audio.LiveMonitor(ctx);
    monitor.setTargets(voiceTargets());
    return monitor;
  }

  function nowSec() {
    const ctx = getAudioCtx ? getAudioCtx() : null;
    return ctx ? ctx.currentTime : null;
  }

  /*
   * 外部(画面ピアノ・MIDI)からの打鍵。
   * velocity 省略時は設定値(PC鍵盤/画面ピアノは強弱を持たないため)。
   * MIDI(sourceId==='midi')は文字入力を横取りしないので armed を要求しない。
   */
  function noteOn(note, sourceId, evt, velocity) {
    const isMidi = (sourceId === 'midi');
    if (!armed && !isMidi) return;
    const ctx = getAudioCtx ? getAudioCtx() : null;
    const time = (evt && ctx && MML.Input.Latency)
      ? MML.Input.Latency.contextTimeFromEvent(ctx, evt) : nowSec();
    const vel = (velocity != null && velocity > 0) ? velocity : state.velocity;
    ensureSource().noteOn(note, { velocity: vel, time, sourceId: sourceId || 'ui' });
    notesChanged();
  }

  function noteOff(note, sourceId, evt) {
    if (!source) return;
    const ctx = getAudioCtx ? getAudioCtx() : null;
    const time = (evt && ctx && MML.Input.Latency)
      ? MML.Input.Latency.contextTimeFromEvent(ctx, evt) : nowSec();
    source.noteOff(note, { time, sourceId: sourceId || 'ui' });
    notesChanged();
  }

  function notesChanged() {
    if (onNotesChange) { try { onNotesChange(); } catch (e) { console.error(e); } }
  }

  // ---- モードの入り/切り -------------------------------------------------

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable;
  }

  function arm() {
    if (armed) return;
    // モード中はPC鍵盤を横取りするので、エディタにフォーカスが残っていると
    // 「打っても文字が入らない」状態になる。先に外す
    if (isEditable(document.activeElement)) document.activeElement.blur();
    ensureSource();
    armed = true;
    syncMonitor();
    downCodes.clear();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('blur', panic);
    updateToggleUI();
    if (onArmedChange) onArmedChange(true);
    notesChanged();
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('blur', panic);
    downCodes.clear();
    if (source) source.allOff(nowSec());
    syncMonitor();   // MIDIが有効ならモニタは鳴らしたまま
    updateToggleUI();
    if (onArmedChange) onArmedChange(false);
    notesChanged();
  }

  function toggle() { if (armed) disarm(); else arm(); }

  /* ウィンドウがフォーカスを失うとkeyupが来ないので、押しっぱなしを全部離す */
  function panic() {
    downCodes.clear();
    if (source) source.allOff(nowSec());
    notesChanged();
  }

  function onFocusIn(e) {
    // エディタや入力欄を触ったら文字入力に戻す(モードに閉じ込めない)
    if (isEditable(e.target) && !(popEl && popEl.contains(e.target))) disarm();
  }

  // ---- MIDI -------------------------------------------------------------

  function wireMidi() {
    const MI = MML.Input.MidiInput;
    MI.onNote = (n) => {
      if (n.type === 'on') noteOn(n.note, 'midi', n.event, n.velocity);
      else noteOff(n.note, 'midi', n.event);
    };
    MI.onDevicesChanged = () => { renderMidiDevices(); };
  }

  async function setMidiEnabled(on) {
    const MI = MML.Input.MidiInput;
    if (on) {
      MI.setChannel(state.midiChannel);
      const st = await MI.enable();
      state.midi = (st.state === 'ok');
    } else {
      MI.disable();
      state.midi = false;
      if (source) source.allOff(nowSec());
      notesChanged();
    }
    saveState();
    syncMonitor();
    renderMidiDevices();
    return MI.getStatus();
  }

  // ---- PC鍵盤 -----------------------------------------------------------

  function onKeyDown(e) {
    if (e.key === 'Escape') { disarm(); return; }
    // focusinを取りこぼしてもモードに閉じ込められないための保険。入力欄に
    // フォーカスがある状態でキーが来たら、その打鍵は横取りせず文字入力へ通す
    if (isEditable(document.activeElement)) { disarm(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;   // ショートカットは邪魔しない
    const KM = MML.Input.KeyMap;
    if (!KM.handles(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || downCodes.has(e.code)) return;    // キーリピートは打ち直しではない

    const oct = KM.octaveDelta(e.code);
    if (oct) {
      // 押している音があるまま動かすと離せなくなるので、いったん全部離す
      panic();
      state.octave = clampNum(state.octave + oct, KM.OCTAVE_MIN, KM.OCTAVE_MAX, state.octave);
      saveState();
      syncPopover();
      return;
    }
    const note = KM.noteFor(e.code, state.octave);
    if (note == null) return;
    downCodes.add(e.code);
    noteOn(note, 'pc', e);
  }

  function onKeyUp(e) {
    const KM = MML.Input.KeyMap;
    if (!KM.handles(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!downCodes.has(e.code)) return;
    downCodes.delete(e.code);
    // ★離すときのノート番号は「押したときのオクターブ」で引き直せないため、
    //   押下中にオクターブを変えたら panic() で全部落としてある(onKeyDown参照)
    const note = KM.noteFor(e.code, state.octave);
    if (note != null) noteOff(note, 'pc', e);
  }

  // ---- UI ---------------------------------------------------------------

  function updateToggleUI() {
    if (!toggleEl) return;
    toggleEl.classList.toggle('is-active', armed);
    toggleEl.title = armed ? T('演奏入力を終える (Esc)') : T('演奏入力: PC鍵盤と画面ピアノで音を出す');
    toggleEl.setAttribute('aria-pressed', armed ? 'true' : 'false');
  }

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
    const pop = el('div', 'metro-pop perform-pop');
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());

    // --- 音色(借用先 + duty/波形) ---
    const secTone = section(T('鳴らす音源'));
    const rowTarget = el('div', 'metro-row');
    els.targetSelect = document.createElement('select');
    for (const [value, label] of targetOptions()) {
      const o = document.createElement('option');
      o.value = value; o.textContent = label;
      els.targetSelect.appendChild(o);
    }
    els.targetSelect.value = state.target;
    els.targetSelect.addEventListener('change', () => {
      state.target = els.targetSelect.value;
      normalizeTone();
      saveState();
      if (monitor) monitor.setTargets(voiceTargets());
      rebuildToneSelect();
      updatePolyUI();
    });
    rowTarget.appendChild(els.targetSelect);
    secTone.appendChild(rowTarget);

    els.toneRow = el('div', 'metro-row');
    secTone.appendChild(els.toneRow);
    pop.appendChild(secTone);

    // --- オクターブ / 強さ ---
    const secPlay = section(T('演奏'));
    const rowOct = el('div', 'metro-row');
    rowOct.appendChild(el('span', null, T('オクターブ')));
    els.octSelect = document.createElement('select');
    const KM = MML.Input.KeyMap;
    for (let n = KM.OCTAVE_MIN; n <= KM.OCTAVE_MAX; n++) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = 'o' + n;
      els.octSelect.appendChild(o);
    }
    els.octSelect.value = String(state.octave);
    els.octSelect.addEventListener('change', () => {
      panic();
      state.octave = clampNum(els.octSelect.value, KM.OCTAVE_MIN, KM.OCTAVE_MAX, state.octave);
      saveState();
      updateKeyGuide();
    });
    rowOct.appendChild(els.octSelect);
    secPlay.appendChild(rowOct);

    const rowPoly = el('div', 'metro-row');
    rowPoly.appendChild(el('span', null, T('同時発音数')));
    els.polySelect = document.createElement('select');
    els.polyHint = el('span', 'metro-hint');
    els.polySelect.addEventListener('change', () => {
      state.polyphony = clampNum(els.polySelect.value, 1, 8, state.polyphony);
      saveState();
      if (monitor) monitor.setTargets(voiceTargets());
      updatePolyUI();
    });
    rowPoly.appendChild(els.polySelect);
    rowPoly.appendChild(els.polyHint);
    secPlay.appendChild(rowPoly);

    const rowVel = el('div', 'metro-row metro-row-vol');
    rowVel.appendChild(el('span', null, T('強さ')));
    els.velInput = document.createElement('input');
    els.velInput.type = 'range';
    els.velInput.min = '1'; els.velInput.max = '127'; els.velInput.step = '1';
    els.velInput.value = String(state.velocity);
    els.velLabel = el('span', 'metro-unit', String(state.velocity));
    els.velInput.addEventListener('input', () => {
      state.velocity = clampNum(els.velInput.value, 1, 127, state.velocity);
      els.velLabel.textContent = String(state.velocity);
      saveState();
    });
    rowVel.appendChild(els.velInput);
    rowVel.appendChild(els.velLabel);
    secPlay.appendChild(rowVel);
    pop.appendChild(secPlay);

    // --- MIDI機器 ---
    const secMidi = section(T('MIDI機器'));
    const rowMidi = el('div', 'metro-row');
    els.midiToggle = el('label', 'metro-opt');
    els.midiCheck = document.createElement('input');
    els.midiCheck.type = 'checkbox';
    els.midiCheck.checked = !!state.midi;
    els.midiCheck.addEventListener('change', async () => {
      els.midiCheck.disabled = true;
      await setMidiEnabled(els.midiCheck.checked);
      els.midiCheck.disabled = false;
      els.midiCheck.checked = MML.Input.MidiInput.isEnabled();
    });
    els.midiToggle.appendChild(els.midiCheck);
    els.midiToggle.appendChild(document.createTextNode(T('MIDI入力を使う')));
    rowMidi.appendChild(els.midiToggle);
    secMidi.appendChild(rowMidi);

    const rowCh = el('div', 'metro-row');
    rowCh.appendChild(el('span', null, T('チャンネル')));
    els.midiChSelect = document.createElement('select');
    for (let n = 0; n <= 16; n++) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = (n === 0) ? T('すべて') : String(n);
      els.midiChSelect.appendChild(o);
    }
    els.midiChSelect.value = String(state.midiChannel);
    els.midiChSelect.addEventListener('change', () => {
      state.midiChannel = clampNum(els.midiChSelect.value, 0, 16, state.midiChannel);
      MML.Input.MidiInput.setChannel(state.midiChannel);
      saveState();
    });
    rowCh.appendChild(els.midiChSelect);
    secMidi.appendChild(rowCh);

    els.midiDevices = el('div', 'perform-midi-list');
    secMidi.appendChild(els.midiDevices);
    pop.appendChild(secMidi);

    // --- キー配列の案内 ---
    const secKeys = section(T('PC鍵盤'));
    els.keyGuide = el('div', 'perform-keyguide');
    secKeys.appendChild(els.keyGuide);
    secKeys.appendChild(el('div', 'metro-note',
      T('↑↓でオクターブ移動。画面のピアノをクリックしても鳴ります。Escで演奏入力を終えます。')));
    pop.appendChild(secKeys);

    rebuildToneSelect();
    updatePolyUI();
    updateKeyGuide();
    renderMidiDevices();
    return pop;
  }

  /*
   * 同時発音数の選択肢。上限は「選んだ借用先から後ろに何声取れるか」で決まるので、
   * 借用先を変えるたびに作り直す。どの音源へ配られるかも並べて出す。
   */
  function updatePolyUI() {
    if (!els.polySelect) return;
    const max = maxPolyphony();
    if (state.polyphony > max) { state.polyphony = max; saveState(); }
    els.polySelect.innerHTML = '';
    for (let n = 1; n <= max; n++) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = String(n);
      els.polySelect.appendChild(o);
    }
    els.polySelect.value = String(state.polyphony);
    els.polySelect.disabled = (max <= 1);
    const P2 = plan();
    const names = voiceTargets().map((v) => (P2 ? P2.targetLabel(v.target) : v.target));
    els.polyHint.textContent = (names.length > 1) ? ('(' + names.join(' / ') + ')') : '';
  }

  function rebuildToneSelect() {
    if (!els.toneRow) return;
    els.toneRow.innerHTML = '';
    const o = toneOptionsFor(state.target);
    if (!o) { els.toneRow.hidden = true; return; }
    els.toneRow.hidden = false;
    els.toneRow.appendChild(el('span', null, T('波形/音色')));
    const sel = document.createElement('select');
    for (const [value, label] of o.opts) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = state.tone;
    sel.addEventListener('change', () => {
      state.tone = sel.value;
      saveState();
      if (monitor) monitor.setTargets(voiceTargets());
    });
    els.toneRow.appendChild(sel);
  }

  /*
   * MIDI機器の一覧と状態。機器0台でも「許可は下りている」ことが分かるように
   * 状態を文で出す(実機が無い段階で配線を確かめられるようにするため)。
   */
  function renderMidiDevices() {
    if (!els.midiDevices) return;
    const MI = MML.Input.MidiInput;
    const st = MI.getStatus();
    els.midiDevices.innerHTML = '';
    if (els.midiCheck) els.midiCheck.checked = MI.isEnabled();

    let msg = '';
    if (!MI.isSupported()) msg = T('このブラウザはWeb MIDIに対応していません。');
    else if (st.state === 'denied') msg = T('MIDIの使用が許可されませんでした。');
    else if (st.state === 'error')  msg = T('MIDIを開けませんでした: {msg}', { msg: st.message });
    else if (!MI.isEnabled())       msg = T('チェックを入れると接続します(初回は許可を聞かれます)。');

    const list = MI.isEnabled() ? MI.getInputs() : [];
    if (msg) {
      els.midiDevices.appendChild(el('div', 'metro-note', msg));
      return;
    }
    if (!list.length) {
      els.midiDevices.appendChild(el('div', 'metro-note', T('接続済み。MIDI機器は見つかりません(挿すとここに出ます)。')));
      return;
    }
    for (const d of list) {
      const lab = el('label', 'metro-opt');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = d.selected;
      cb.addEventListener('change', () => { MI.setInputSelected(d.id, cb.checked); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(d.name + (d.manufacturer ? ' (' + d.manufacturer + ')' : '')));
      els.midiDevices.appendChild(lab);
    }
  }

  /* キー配列図。押したときに出る音名を実際のオクターブで出す(目安表示) */
  function updateKeyGuide() {
    if (!els.keyGuide) return;
    const KM = MML.Input.KeyMap;
    const rows = KM.rows();
    els.keyGuide.innerHTML = '';
    for (const key of ['upper', 'lower']) {
      const line = el('div', 'perform-keyrow');
      for (const k of rows[key]) {
        const cap = el('span', 'perform-key' + (k.black ? ' perform-key--black' : ''), k.label);
        const note = KM.noteFor(k.code, state.octave);
        if (note != null) cap.title = noteName(note);
        line.appendChild(cap);
      }
      els.keyGuide.appendChild(line);
    }
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(m) { return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); }

  function syncPopover() {
    if (!popEl) return;
    if (els.octSelect) els.octSelect.value = String(state.octave);
    updateKeyGuide();
  }

  function openPopover() {
    if (popEl) { closePopover(); return; }
    const pop = buildPopover();
    document.body.appendChild(pop);
    const r = settingsEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right - pw, top = r.bottom + 4;
    if (left < 4) left = 4;
    if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
    popEl = pop;

    popCloseHandler = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type !== 'keydown' && (pop.contains(e.target) || settingsEl.contains(e.target))) return;
      closePopover();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', popCloseHandler, true);
      document.addEventListener('keydown', popCloseHandler, true);
    }, 0);
  }

  function closePopover() {
    if (!popEl) return;
    document.removeEventListener('mousedown', popCloseHandler, true);
    document.removeEventListener('keydown', popCloseHandler, true);
    popCloseHandler = null;
    popEl.remove();
    popEl = null;
    els = {};
  }

  // ---- 公開API ---------------------------------------------------------

  UI.PerformInput = {
    init(opts) {
      toggleEl      = opts.toggleEl;
      settingsEl    = opts.settingsEl;
      getAudioCtx   = opts.getAudioCtx;
      onArmedChange = opts.onArmedChange || null;
      onNotesChange = opts.onNotesChange || null;
      loadState();
      normalizeTone();
      // 受信の配線は最初から張っておく(実機が無くても injectMessage() で経路を試せる)
      wireMidi();
      if (toggleEl)   toggleEl.addEventListener('click', toggle);
      if (settingsEl) settingsEl.addEventListener('click', openPopover);
      updateToggleUI();
      // 前回ONにしていたら繋ぎ直す。許可済みならプロンプトは出ないので黙って復帰し、
      // 拒否/未許可なら state.midi が false に戻るだけ(エラーは出さない)
      if (state.midi) setMidiEnabled(true);
    },

    isArmed() { return armed; },
    /* 段階4: 設定ポップオーバー以外からもMIDIを開けるようにしておく */
    setMidiEnabled,
    isMidiEnabled() { return MML.Input.MidiInput.isEnabled(); },
    arm,
    disarm,
    toggle,
    noteOn,
    noteOff,
    /* 画面ピアノの点灯用。押されている音のノート番号 */
    heldNotes() { return source ? source.getHeld() : []; },
    /* 段階2(録音)がTimedPitchEvent列を受け取るための入口 */
    getNoteSource() { return ensureSource(); }
  };

})(window);
