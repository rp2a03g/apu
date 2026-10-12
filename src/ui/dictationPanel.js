/*
 * 聴音 (MML.UI.DictationPanel) — UI層
 *
 * 鼻歌・口笛・楽器の単音を、マイク(リアルタイム)か音声ファイルから取り込み、
 *   src/input/pitchDetect.js(ピッチ) → src/input/noteSegment.js(音符列) → src/input/quantize.js(格子)
 *   → src/convert/mmlEmit.js(MML)
 * の順で MML の断片にしてエディタへ挿入する。作業計画フェーズ4。
 *
 * ■ 結果は停止後に PCM 全体を見渡して確定する
 *   ライブのピッチ(ポップオーバーの針)は先読みが無いので、ビブラートの谷やスクープを音符にしてしまう。
 *   録音中は PCM をテイクとして保持し、停止したときに全体を解いて音符列にする。保持した PCM があるので、
 *   結果ダイアログで感度・オクターブ・調寄せ・テンポを変えるたびに**歌い直さず**再計算できる。
 *   検出(YIN)側のしきい値を変えたときだけ解き直し(数十秒の録音で 1 秒前後)、区切り側は即時。
 *
 * ■ テンポの基準
 *   「メトロノームに合わせる」: src/ui/recordPanel.js と同じく、カウントイン明けの拍を tick 0 にする。
 *   「自由に歌う」/ファイル: 発音間隔から MML.Convert.detectBpm で推定し、先頭の音を tick 0 にする。
 *   BPM 欄は常に直せる(推定は原理的に 2倍/半分に転ぶことがある)。
 *
 * ■ 調整が効くこと(ユーザー要望 2026-10-12: 実データは人により違う)
 *   声/楽器のプリセットを出発点に、区切りと検出のしきい値を全部スライダーで変えられる。
 *   値はプリセットごとに localStorage に残る。「初期値に戻す」でプリセットの値へ。
 *   テイクは WAV で保存できる(調整の相談用。マイクの違いを後から再現できる)。
 *
 * ■ マイクは押されたときだけ開く(src/input/micInput.js)。起動時に許可を求めない。
 *
 * ■ 挿入は必ずユーザーが確認してから(INV-6)。挿入の規則は recordPanel.js と同じ
 *   (カーソル挿入は l<n> を出さず先頭の休符を落とす、末尾追記は新しい行)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI  = MML.UI = MML.UI || {};
  const T   = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const STORAGE_KEY = 'mml.dictation';
  const DEFAULTS = {
    preset: 'voice', tempoMode: 'metronome', grid: 16, strength: 100, rests: false,
    mode: 'cursor', letter: 'A', transpose: 'auto', offsetMs: 0, deviceId: '',
    tune: { voice: {}, instrument: {} }   // プリセットごとの detect/segment 上書き
  };
  const GRID_LABELS = { 4: '4分音符', 8: '8分音符', 12: '3連8分音符', 16: '16分音符', 24: '3連16分音符', 32: '32分音符' };
  const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];
  const KEY_NAMES  = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /*
   * スライダーの定義。group: 'segment'(即時) | 'detect'(解き直し)。scale は表示単位への倍率。
   * 既定値はプリセット(NoteSegment.PRESETS / PitchDetect.DEFAULTS)から引く。
   */
  const TUNABLES = [
    { key: 'dipDb',        group: 'segment', label: '連打の谷',       min: 0,    max: 12,   step: 1,    unit: 'dB',  desc: '同じ音を続けて歌ったときの音量の落ち込み。これ以上下がって戻れば別の音符にする。0で切る' },
    { key: 'riseDb',       group: 'segment', label: '弾き直し',       min: 0,    max: 12,   step: 1,    unit: 'dB',  desc: '30ms以内にこれ以上音量が上がれば別の音符にする(ギター・ピアノの弾き直し)。0で切る' },
    { key: 'minNoteSec',   group: 'segment', label: '音の最短長',     min: 0.02, max: 0.25, step: 0.01, unit: 'ms', scale: 1000, desc: 'これより短い音符は隣へ吸収する' },
    { key: 'sigma',        group: 'segment', label: '揺れの許容',     min: 0.3,  max: 1.2,  step: 0.05, unit: '半音', desc: 'ビブラートや音程のふらつきをどこまで同じ音とみなすか' },
    { key: 'switchCost',   group: 'segment', label: '割れにくさ',     min: 3,    max: 40,   step: 1,    unit: '',    desc: '大きいほど音符が割れにくい(速いパッセージを取りこぼすなら下げる)' },
    { key: 'scoopMaxSec',  group: 'segment', label: 'スクープ吸収',   min: 0,    max: 0.25, step: 0.01, unit: 'ms', scale: 1000, desc: '下から入る癖(スクープ)をこの長さまで次の音へ畳む。楽器では0' },
    { key: 'gateDb',       group: 'detect',  label: '無音の音量',     min: -80,  max: -20,  step: 1,    unit: 'dB',  desc: 'これより小さい音は無音とみなす。息や部屋の音を拾うなら上げる' },
    { key: 'maxAperiodicity', group: 'detect', label: '雑音の許容',   min: 0.1,  max: 0.7,  step: 0.05, unit: '',    desc: '周期性の弱い音(息・子音)をどこまで音として拾うか。大きいほど拾う' },
    { key: 'fmin',         group: 'detect',  label: '最低の高さ',     min: 30,   max: 200,  step: 5,    unit: 'Hz',  desc: '探す音の下限。低い声やベースは下げる(低いほど処理が重い)' },
    { key: 'fmax',         group: 'detect',  label: '最高の高さ',     min: 500,  max: 3000, step: 50,   unit: 'Hz',  desc: '探す音の上限。口笛は 2000 以上に' }
  ];

  let state = JSON.parse(JSON.stringify(DEFAULTS));
  let toggleEl = null, getAudioCtx = null, getEditor = null, getChannelLetters = null;
  let getMmlTempo = null, getUsedLetters = null, onInserted = null;

  let popEl = null, popCloseHandler = null, pels = {};
  let modalEl = null, els = {};
  let liveTracker = null, liveRaf = 0, micInfo = null;
  let recording = false, recTracker = null, recStartCtx = null, recMetroOrigin = null, recBpm = null, recBeats = 4;
  let take = null;      // { samples, sampleRate, frames, source, name, durationSec, bpm, beatsPerBar, originSec|null }
  let result = null;    // { notes, key, transpose, bpm, q, text, defLines }
  let detectTimer = 0;

  // ---- 設定 -------------------------------------------------------------

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULTS)) if (raw[k] != null) state[k] = raw[k];
      }
    } catch (e) { /* ignore */ }
    if (!MML.Input.NoteSegment.PRESETS[state.preset]) state.preset = DEFAULTS.preset;
    if (state.tempoMode !== 'metronome' && state.tempoMode !== 'free') state.tempoMode = DEFAULTS.tempoMode;
    if (MML.Input.QUANTIZE_GRIDS.indexOf(state.grid) < 0) state.grid = DEFAULTS.grid;
    state.strength = clampNum(state.strength, 0, 100, DEFAULTS.strength);
    if (state.mode !== 'cursor' && state.mode !== 'append') state.mode = DEFAULTS.mode;
    if (state.transpose !== 'auto') state.transpose = clampNum(state.transpose, -36, 36, 0);
    state.offsetMs = clampNum(state.offsetMs, -300, 300, 0);
    if (!state.tune || typeof state.tune !== 'object') state.tune = { voice: {}, instrument: {} };
    for (const p of Object.keys(MML.Input.NoteSegment.PRESETS)) if (!state.tune[p]) state.tune[p] = {};
  }
  function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }
  function clampNum(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  /* 現在のプリセット+上書きから、検出/区切りの実効値を作る */
  function presetBase(group) {
    const P = MML.Input.NoteSegment.PRESETS[state.preset];
    const base = group === 'detect' ? MML.Input.PitchDetect.DEFAULTS : MML.Input.NoteSegment.DEFAULTS;
    return Object.assign({}, base, P[group]);
  }
  function effective(group) {
    const out = presetBase(group);
    const over = state.tune[state.preset] || {};
    for (const t of TUNABLES) if (t.group === group && over[t.key] != null) out[t.key] = over[t.key];
    if (group === 'segment') out.keySnap = (over.keySnap != null) ? !!over.keySnap : true;
    return out;
  }
  function setTune(key, value) {
    state.tune[state.preset] = state.tune[state.preset] || {};
    state.tune[state.preset][key] = value;
    saveState();
  }

  // ---- DOM 小道具 -------------------------------------------------------

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
  function row(labelText, cls) {
    const r = el('div', cls || 'rec-row');
    r.appendChild(el('span', 'rec-label', labelText));
    return r;
  }
  function noteName(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12] + ' o' + (Math.floor(midi / 12) - 1); }
  function ctxNow() { const ctx = getAudioCtx ? getAudioCtx() : null; return ctx ? ctx.currentTime : 0; }

  // ---- マイク(ライブ) ----------------------------------------------------

  async function openMic() {
    const ctx = getAudioCtx ? getAudioCtx() : null;
    const MI = MML.Input.MicInput;
    if (!ctx || !MI.isSupported()) { setStatus(T('この環境ではマイクを使えません。音声ファイルから読み込んでください。')); return false; }
    setStatus(T('マイクの許可を待っています…'));
    try {
      micInfo = await MI.open(ctx, {
        deviceId: state.deviceId || undefined,
        onBlock: (block, startSec) => {
          if (liveTracker) liveTracker.push(block);
          if (recording && recTracker) {
            if (recStartCtx == null) recStartCtx = startSec;
            recTracker.push(block);
          }
        }
      });
    } catch (e) {
      micInfo = null;
      setStatus(e && e.name === 'NotAllowedError' ? T('マイクの使用が許可されませんでした。') : T('マイクを開けませんでした: {msg}', { msg: (e && e.message) || String(e) }));
      return false;
    }
    liveTracker = new MML.Input.PitchDetect.Tracker(ctx.sampleRate, effective('detect'));
    setStatus(micInfo.label ? T('マイク: {label}', { label: micInfo.label }) : T('マイクを開きました'));
    renderDevices();
    startLive();
    syncPopUI();
    return true;
  }

  function closeMic() {
    if (recording) stopRecording();
    MML.Input.MicInput.close();
    micInfo = null; liveTracker = null;
    stopLive();
    setStatus('');
    syncPopUI();
  }

  // ★rAF ではなく setInterval。背面のウィンドウでは rAF が止まり、針と音量計が動かなくなる(実際に踏んだ)
  function startLive() {
    stopLive();
    const tick = () => {
      if (!popEl || !liveTracker) return;
      const fr = liveTracker.latest();
      const db = fr ? fr.rms : -120;
      if (pels.meter) pels.meter.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
      if (pels.pitch) {
        if (fr && fr.f) {
          const m = MML.Input.PitchDetect.toMidi(fr.f);
          const r = Math.round(m), cents = Math.round((m - r) * 100);
          pels.pitch.textContent = `${noteName(r)}  ${cents >= 0 ? '+' : ''}${cents}¢  ${fr.f.toFixed(1)}Hz`;
        } else pels.pitch.textContent = '—';
      }
      if (pels.recTime && recording && recTracker) pels.recTime.textContent = recTracker.durationSec().toFixed(1) + 's';
      // 30秒を超えて保持し続けないよう、ライブ用トラッカーは定期的に作り直す(録音用は別)
      if (liveTracker.durationSec() > 20) {
        const ctx = getAudioCtx();
        liveTracker = new MML.Input.PitchDetect.Tracker(ctx.sampleRate, effective('detect'));
      }
    };
    liveRaf = setInterval(tick, 50);
  }
  function stopLive() { if (liveRaf) clearInterval(liveRaf); liveRaf = 0; }

  async function renderDevices() {
    if (!pels.device) return;
    const list = await MML.Input.MicInput.listDevices();
    pels.device.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = T('既定のマイク');
    pels.device.appendChild(def);
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.label || T('マイク {n}', { n: i + 1 });
      pels.device.appendChild(o);
    });
    pels.device.value = list.some(d => d.id === state.deviceId) ? state.deviceId : '';
  }

  function setStatus(msg) { if (pels.status) pels.status.textContent = msg || ''; }

  // ---- 録音 -------------------------------------------------------------

  async function startRecording() {
    if (recording) return;
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx) return;
    if (!MML.Input.MicInput.isOpen()) { const ok = await openMic(); if (!ok) return; }
    recTracker = new MML.Input.PitchDetect.Tracker(ctx.sampleRate, effective('detect'));
    recStartCtx = null;
    recBpm = null; recMetroOrigin = null; recBeats = 4;
    const MP = UI.MetronomePanel;
    if (state.tempoMode === 'metronome' && MP) {
      MP.stop();
      MP.start({ forceCountIn: true });
      const m = MP.getMetronome();
      recMetroOrigin = m ? m.downbeatTime() : ctx.currentTime;
      recBpm = MP.getBpm();
      recBeats = m ? m.beatsPerBar : MP.getBeatsPerBar();
    }
    recording = true;
    updateToggleUI();
    syncPopUI();
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    const MP = UI.MetronomePanel;
    if (state.tempoMode === 'metronome' && MP) MP.stop();
    updateToggleUI();
    const tr = recTracker; recTracker = null;
    syncPopUI();
    if (!tr || tr.durationSec() < 0.3) return;
    const samples = tr.samples();
    const originSec = (recMetroOrigin != null && recStartCtx != null) ? (recMetroOrigin - recStartCtx) : null;
    newTake({ samples, sampleRate: tr.sampleRate, source: 'mic', name: T('マイク'), bpm: recBpm, beatsPerBar: recBeats, originSec });
  }

  // ---- ファイル -----------------------------------------------------------

  async function loadFile(file) {
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx || !file) return;
    setStatus(T('読み込み中: {name}', { name: file.name }));
    try {
      const ab = await file.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab.slice(0));
      const n = buf.length, mono = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
      setStatus('');
      newTake({ samples: mono, sampleRate: buf.sampleRate, source: 'file', name: file.name, bpm: null, beatsPerBar: 4, originSec: null });
    } catch (e) {
      setStatus(T('読み込めませんでした: {msg}', { msg: (e && e.message) || String(e) }));
    }
  }

  // ---- 解析 ---------------------------------------------------------------

  function newTake(t) {
    take = Object.assign({ frames: null, durationSec: t.samples.length / t.sampleRate, transposeAuto: null, bpmUser: null }, t);
    closePopover();
    analyzeTake();
    openModal();
  }

  /* 検出(YIN)をやり直す。検出側のしきい値を変えたときと、テイクを作ったとき */
  function analyzeTake() {
    if (!take) return;
    const t0 = performance.now();
    const r = MML.Input.PitchDetect.analyze(take.samples, take.sampleRate, effective('detect'));
    // analyze は 32kHz 超を間引くので、保持する PCM も間引き後に揃える(WAV 保存・再解析が軽くなる)
    take.samples = r.samples; take.sampleRate = r.sampleRate; take.frames = r.frames;
    take.detectMs = Math.round(performance.now() - t0);
  }

  function currentTranspose(notes) {
    if (state.transpose !== 'auto') return Number(state.transpose) || 0;
    if (take.transposeAuto == null) take.transposeAuto = MML.Input.NoteSegment.suggestTranspose(notes);
    return take.transposeAuto;
  }

  function letters() {
    const ls = getChannelLetters ? getChannelLetters() : null;
    return (ls && ls.length) ? ls.filter(l => l !== 'D' && l !== 'E') : ['A', 'B', 'C'];
  }

  /* 区切り → 量子化 → MML。区切り側のしきい値変更で毎回呼ぶ(軽い) */
  function build() {
    const NS = MML.Input.NoteSegment;
    const seg = NS.segment(take.frames, effective('segment'));
    const notes = seg.notes;
    const transpose = currentTranspose(notes);
    let bpm;
    if (take.bpmUser != null) bpm = take.bpmUser;
    else if (take.bpm != null) bpm = take.bpm;
    else bpm = NS.estimateBpm(notes, getMmlTempo ? (getMmlTempo() || 120) : 120);
    const offset = state.offsetMs / 1000;
    const events = NS.toTimedEvents(notes, transpose).map(e => ({ timeSec: e.timeSec - offset, midiNote: e.midiNote }));
    const metroOrigin = (take.originSec != null);
    const originSec = metroOrigin ? take.originSec : (notes.length ? notes[0].startSec - offset : 0);
    const q = MML.Input.quantize(events, {
      bpm, originSec, endSec: take.durationSec - offset, grid: state.grid, strength: state.strength / 100,
      legato: !state.rests, gate: 1, beatsPerBar: take.beatsPerBar || 4
    });
    const cursorMode = (state.mode === 'cursor');
    const lead = (cursorMode && q.events.length) ? q.events[0].start : 0;
    const evs = q.events.map(e => Object.assign({}, e, { start: e.start - lead, end: e.end - lead }));
    const text = MML.Convert.emitChannel(cursorMode ? '' : state.letter, evs, MML.Convert.TPQN, {
      totalFrames: cursorMode ? (q.contentTicks - lead) : q.totalTicks,
      noDefaultLen: cursorMode,
      wrapCol: cursorMode ? 1e9 : 80,
      cmd: { SHAPE_REST: false }
    });
    result = { notes, key: seg.key, transpose, bpm, q, text: cursorMode ? text.trim() : text };
    return result;
  }

  // ---- 結果ダイアログ -----------------------------------------------------

  function openModal() {
    closeModal();
    const backdrop = el('div', 'es-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
    const modal = el('div', 'es-modal dict-modal');
    const header = el('div', 'es-modal-header');
    header.appendChild(el('span', null, T('聴音の結果')));
    const closeBtn = el('button', 'es-modal-close', '×');
    closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', T('閉じる'));
    closeBtn.addEventListener('click', closeModal);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = el('div', 'es-modal-body dict-body');
    els.info = el('div', 'rec-info'); body.appendChild(els.info);
    els.warn = el('div', 'rec-warn'); els.warn.hidden = true; body.appendChild(els.warn);

    const cols = el('div', 'dict-cols');
    const left = el('div', 'dict-col'), right = el('div', 'dict-col');
    cols.appendChild(left); cols.appendChild(right);
    body.appendChild(cols);

    // --- 音程 ---
    const secPitch = el('div', 'dict-sec'); secPitch.appendChild(el('div', 'dict-sec-title', T('音程')));
    const rTr = row(T('オクターブ補正'));
    els.transpose = document.createElement('select');
    for (const [v, label] of [['auto', T('自動')], ['24', '+2'], ['12', '+1'], ['0', '0'], ['-12', '-1'], ['-24', '-2']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = label; els.transpose.appendChild(o);
    }
    els.transpose.value = String(state.transpose);
    els.transpose.addEventListener('change', () => { state.transpose = els.transpose.value === 'auto' ? 'auto' : Number(els.transpose.value); saveState(); refresh(); });
    rTr.appendChild(els.transpose);
    els.trNote = el('span', 'rec-unit dict-wide', ''); rTr.appendChild(els.trNote);
    secPitch.appendChild(rTr);
    const rKey = row(T('調へ寄せる'));
    els.keySnap = document.createElement('input'); els.keySnap.type = 'checkbox';
    els.keySnap.checked = effective('segment').keySnap;
    els.keySnap.addEventListener('change', () => { setTune('keySnap', els.keySnap.checked); refresh(); });
    rKey.appendChild(els.keySnap);
    els.keyNote = el('span', 'rec-unit dict-wide', ''); rKey.appendChild(els.keyNote);
    rKey.title = T('半音の境目にいる音を、曲の調(長調の音階として推定)に乗る側へ寄せます');
    secPitch.appendChild(rKey);
    left.appendChild(secPitch);

    // --- 区切り / 検出(スライダー) ---
    const secSeg = el('div', 'dict-sec'); secSeg.appendChild(el('div', 'dict-sec-title', T('音符の区切り')));
    const secDet = el('div', 'dict-sec'); secDet.appendChild(el('div', 'dict-sec-title', T('ピッチ検出(変えると解き直し)')));
    els.sliders = {};
    for (const t of TUNABLES) {
      const r = row(T(t.label)); r.title = T(t.desc);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = String(t.min); inp.max = String(t.max); inp.step = String(t.step);
      const lab = el('span', 'rec-unit');
      const show = (v) => { lab.textContent = (t.scale ? Math.round(v * t.scale) : (t.step < 1 ? v.toFixed(2) : Math.round(v))) + (t.unit ? ' ' + T(t.unit) : ''); };
      inp.addEventListener('input', () => {
        const v = Number(inp.value); show(v); setTune(t.key, v);
        if (t.group === 'detect') scheduleDetect(); else refresh();
      });
      r.appendChild(inp); r.appendChild(lab);
      (t.group === 'detect' ? secDet : secSeg).appendChild(r);
      els.sliders[t.key] = { inp, show };
    }
    left.appendChild(secSeg);
    left.appendChild(secDet);
    const presetRow = row(T('プリセット'));
    els.presetSel = document.createElement('select');
    for (const [v, label] of [['voice', T('声(鼻歌・口笛)')], ['instrument', T('楽器の単音')]]) {
      const o = document.createElement('option'); o.value = v; o.textContent = label; els.presetSel.appendChild(o);
    }
    els.presetSel.value = state.preset;
    els.presetSel.addEventListener('change', () => { state.preset = els.presetSel.value; saveState(); syncSliders(); analyzeTake(); refresh(); });
    presetRow.appendChild(els.presetSel);
    const resetBtn = el('button', 'dict-small', T('初期値に戻す')); resetBtn.type = 'button';
    resetBtn.title = T('このプリセットのしきい値を出発点の値に戻します');
    resetBtn.addEventListener('click', () => { state.tune[state.preset] = {}; saveState(); syncSliders(); analyzeTake(); refresh(); });
    presetRow.appendChild(resetBtn);
    secSeg.insertBefore(presetRow, secSeg.children[1]);

    // --- 量子化 ---
    const secQ = el('div', 'dict-sec'); secQ.appendChild(el('div', 'dict-sec-title', T('量子化')));
    const rBpm = row(T('テンポ'));
    els.bpm = document.createElement('input'); els.bpm.type = 'number'; els.bpm.min = '20'; els.bpm.max = '400'; els.bpm.step = '1';
    els.bpm.className = 'dict-num';
    els.bpm.addEventListener('change', () => { const v = clampNum(els.bpm.value, 20, 400, null); take.bpmUser = v; refresh(); });
    rBpm.appendChild(els.bpm);
    els.bpmSrc = el('span', 'rec-unit dict-wide', '');
    rBpm.appendChild(els.bpmSrc);
    els.bpmEst = el('button', 'dict-small', T('推定し直す')); els.bpmEst.type = 'button';
    els.bpmEst.addEventListener('click', () => { take.bpmUser = null; refresh(); });
    rBpm.appendChild(els.bpmEst);
    secQ.appendChild(rBpm);
    const rGrid = row(T('格子'));
    els.grid = document.createElement('select');
    for (const g of MML.Input.QUANTIZE_GRIDS) { const o = document.createElement('option'); o.value = String(g); o.textContent = T(GRID_LABELS[g]); els.grid.appendChild(o); }
    els.grid.value = String(state.grid);
    els.grid.addEventListener('change', () => { state.grid = Number(els.grid.value); saveState(); refresh(); });
    rGrid.appendChild(els.grid);
    secQ.appendChild(rGrid);
    const rStr = row(T('吸着の強さ'));
    els.str = document.createElement('input'); els.str.type = 'range'; els.str.min = '0'; els.str.max = '100'; els.str.step = '5'; els.str.value = String(state.strength);
    els.strLab = el('span', 'rec-unit', state.strength + '%');
    els.str.addEventListener('input', () => { state.strength = Number(els.str.value); els.strLab.textContent = state.strength + '%'; saveState(); refresh(); });
    rStr.appendChild(els.str); rStr.appendChild(els.strLab);
    secQ.appendChild(rStr);
    const rOff = row(T('遅れの補正'));
    rOff.title = T('歌い出しがクリックより遅れる人はプラス。ファイルの頭のずれにも使えます');
    els.off = document.createElement('input'); els.off.type = 'range'; els.off.min = '-300'; els.off.max = '300'; els.off.step = '10'; els.off.value = String(state.offsetMs);
    els.offLab = el('span', 'rec-unit', state.offsetMs + ' ms');
    els.off.addEventListener('input', () => { state.offsetMs = Number(els.off.value); els.offLab.textContent = state.offsetMs + ' ms'; saveState(); refresh(); });
    rOff.appendChild(els.off); rOff.appendChild(els.offLab);
    secQ.appendChild(rOff);
    const rRest = row(T('隙間を休符に'));
    els.rests = document.createElement('input'); els.rests.type = 'checkbox'; els.rests.checked = !!state.rests;
    els.rests.addEventListener('change', () => { state.rests = els.rests.checked; saveState(); refresh(); });
    rRest.appendChild(els.rests);
    rRest.appendChild(el('span', 'rec-unit dict-wide', T('息継ぎを休符として残す(既定は詰める)')));
    secQ.appendChild(rRest);
    right.appendChild(secQ);

    // --- 挿入先 ---
    const secIns = el('div', 'dict-sec'); secIns.appendChild(el('div', 'dict-sec-title', T('挿入先')));
    const rMode = row('');
    const modeWrap = el('div', 'rec-modes');
    for (const [value, label] of [['cursor', T('カーソル位置')], ['append', T('末尾に新しい行')]]) {
      const lab = el('label', 'rec-mode');
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'dict-mode'; radio.value = value; radio.checked = (state.mode === value);
      radio.addEventListener('change', () => { if (radio.checked) { state.mode = value; saveState(); syncModeUI(); refresh(); } });
      lab.appendChild(radio); lab.appendChild(document.createTextNode(label));
      modeWrap.appendChild(lab);
    }
    els.letter = document.createElement('select');
    const used = getUsedLetters ? (getUsedLetters() || []) : [];
    for (const l of letters()) {
      const o = document.createElement('option'); o.value = l;
      o.textContent = used.indexOf(l) >= 0 ? T('{letter}(使用中)', { letter: l }) : l;
      els.letter.appendChild(o);
    }
    if (letters().indexOf(state.letter) < 0) state.letter = letters()[0];
    els.letter.value = state.letter;
    els.letter.addEventListener('change', () => { state.letter = els.letter.value; saveState(); refresh(); });
    modeWrap.appendChild(els.letter);
    rMode.appendChild(modeWrap);
    secIns.appendChild(rMode);
    els.note = el('div', 'rec-note'); secIns.appendChild(els.note);
    right.appendChild(secIns);

    els.notesList = el('div', 'dict-notes');
    right.appendChild(els.notesList);

    els.preview = el('pre', 'rec-preview'); body.appendChild(els.preview);
    modal.appendChild(body);

    const footer = el('div', 'es-modal-footer');
    const save = el('button', null, T('WAVで保存')); save.type = 'button';
    save.title = T('取り込んだ音をそのまま保存します(しきい値の調整を後で再現するため)');
    save.addEventListener('click', saveWav);
    const again = el('button', null, T('もう一度')); again.type = 'button';
    again.addEventListener('click', () => { closeModal(); openPopover(); });
    const cancel = el('button', null, T('やめる')); cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    const ok = el('button', 'rec-insert', T('挿入')); ok.type = 'button';
    ok.addEventListener('click', doInsert);
    footer.appendChild(save); footer.appendChild(again); footer.appendChild(cancel); footer.appendChild(ok);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modalEl = backdrop;
    syncSliders();
    syncModeUI();
    refresh();
    els.esc = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', els.esc, true);
  }

  function syncSliders() {
    if (!els.sliders) return;
    const det = effective('detect'), seg = effective('segment');
    for (const t of TUNABLES) {
      const s = els.sliders[t.key]; if (!s) continue;
      const v = (t.group === 'detect' ? det : seg)[t.key];
      s.inp.value = String(v); s.show(Number(v));
    }
    if (els.keySnap) els.keySnap.checked = seg.keySnap;
    if (els.presetSel) els.presetSel.value = state.preset;
  }

  function scheduleDetect() {
    clearTimeout(detectTimer);
    if (els.info) els.info.textContent = T('解き直しています…');
    detectTimer = setTimeout(() => { analyzeTake(); refresh(); }, 350);
  }

  function syncModeUI() {
    if (!els.letter) return;
    const used = getUsedLetters ? (getUsedLetters() || []) : [];
    els.letter.hidden = (state.mode !== 'append');
    if (state.mode === 'cursor') els.note.textContent = T('カーソル位置に差し込みます。以降の既定音価は変えません(全ての音符に音価を書きます)。ただしオクターブ(o<n>)は後ろの音符にも効き続けます。');
    else if (used.indexOf(state.letter) >= 0) els.note.textContent = T('MMLの末尾に「{letter} …」の行を足します。{letter}には既に音符があるので、その続きとして鳴ります。', { letter: state.letter });
    else els.note.textContent = T('未使用の{letter}へ新しいパートとして書き出します。', { letter: state.letter });
  }

  function refresh() {
    if (!modalEl || !take) return;
    const r = build();
    const ms = r.notes.map(n => n.midi + r.transpose).sort((a, b) => a - b);
    const range = ms.length ? `${noteName(ms[0])} – ${noteName(ms[ms.length - 1])}` : '—';
    els.info.textContent = T('{name} / {sec}秒 / {notes}音 / 音域 {range} / 解析 {ms}ms',
      { name: take.name, sec: take.durationSec.toFixed(1), notes: r.notes.length, range, ms: take.detectMs })
      + (r.q.droppedCount ? T('(短すぎる{n}音は除外)', { n: r.q.droppedCount }) : '');
    els.trNote.textContent = state.transpose === 'auto' ? T('提案: {n}', { n: (r.transpose >= 0 ? '+' : '') + r.transpose / 12 }) : '';
    els.keyNote.textContent = r.key ? T('推定: {key} 長調の音階', { key: KEY_NAMES[r.key.root] }) : '';
    els.bpm.value = String(Math.round(r.bpm));
    els.bpmSrc.textContent = take.bpmUser != null ? T('手入力') : (take.bpm != null ? T('メトロノーム') : T('推定'));
    els.bpmEst.hidden = (take.bpm != null && take.bpmUser == null);
    els.preview.textContent = r.text;
    // 音符の一覧(どこで割れたかを見るため)
    els.notesList.textContent = r.notes.map(n =>
      `${n.startSec.toFixed(2)} ${noteName(n.midi + r.transpose)}${n.onset === 'dip' || n.onset === 'rise' ? '*' : ''}`).join('  ');
    const mmlBpm = getMmlTempo ? getMmlTempo() : null;
    const mismatch = Number.isFinite(mmlBpm) && Math.abs(mmlBpm - r.bpm) > 0.5;
    els.warn.hidden = !mismatch;
    if (mismatch) els.warn.textContent = T('MML本文のテンポ({mml} BPM)と取り込みのテンポ({rec} BPM)が違います。挿入した音符はMML側のテンポで鳴ります。', { mml: Math.round(mmlBpm), rec: Math.round(r.bpm) });
  }

  function doInsert() {
    const ta = getEditor ? getEditor() : null;
    if (!ta || !result) return;
    const text = result.text;
    if (state.mode === 'cursor') {
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
      const before = v.slice(0, s), after = v.slice(e);
      const body = (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '');
      ta.value = before + body + after;
      ta.selectionStart = ta.selectionEnd = s + body.length;
    } else {
      const sep = (!ta.value || ta.value.endsWith('\n')) ? '' : '\n';
      ta.value = ta.value + sep + text + '\n';
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    closeModal();
    ta.focus();
    if (onInserted) { try { onInserted(text); } catch (e) { console.error(e); } }
  }

  function saveWav() {
    if (!take) return;
    const x = take.samples, sr = take.sampleRate;
    const buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    const blob = new Blob([buf], { type: 'audio/wav' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    a.download = `dictation-${stamp}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function closeModal() {
    if (!modalEl) return;
    if (els.esc) document.removeEventListener('keydown', els.esc, true);
    clearTimeout(detectTimer);
    modalEl.remove(); modalEl = null; els = {};
  }

  // ---- ポップオーバー ----------------------------------------------------

  function buildPopover() {
    const pop = el('div', 'metro-pop dict-pop');
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());

    const secKind = section(T('取り込むもの'));
    const kindRow = el('div', 'rec-modes');
    for (const [v, label] of [['voice', T('声(鼻歌・口笛)')], ['instrument', T('楽器の単音')]]) {
      const lab = el('label', 'rec-mode');
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'dict-preset'; radio.value = v; radio.checked = (state.preset === v);
      radio.addEventListener('change', () => { if (radio.checked) { state.preset = v; saveState(); } });
      lab.appendChild(radio); lab.appendChild(document.createTextNode(label)); kindRow.appendChild(lab);
    }
    secKind.appendChild(kindRow);
    secKind.appendChild(el('div', 'rec-note', T('単旋律だけ取り込めます(和音・伴奏入りは不可)。音程を保って歌うほど正確になります。')));
    pop.appendChild(secKind);

    const secMic = section(T('マイク'));
    const devRow = el('div', 'metro-row');
    pels.device = document.createElement('select');
    pels.device.addEventListener('change', async () => { state.deviceId = pels.device.value; saveState(); if (MML.Input.MicInput.isOpen()) { closeMic(); await openMic(); } });
    devRow.appendChild(pels.device);
    pels.micBtn = el('button', 'dict-small', T('マイクを開く')); pels.micBtn.type = 'button';
    pels.micBtn.addEventListener('click', () => { if (MML.Input.MicInput.isOpen()) closeMic(); else openMic(); });
    devRow.appendChild(pels.micBtn);
    secMic.appendChild(devRow);
    const meterWrap = el('div', 'dict-meter'); pels.meter = el('div', 'dict-meter-bar'); meterWrap.appendChild(pels.meter);
    secMic.appendChild(meterWrap);
    pels.pitch = el('div', 'dict-pitch', '—'); secMic.appendChild(pels.pitch);
    pels.status = el('div', 'rec-note', ''); secMic.appendChild(pels.status);
    pop.appendChild(secMic);

    const secTempo = section(T('テンポの基準'));
    const tRow = el('div', 'rec-modes dict-stack');
    for (const [v, label] of [['metronome', T('メトロノームに合わせる(カウントイン付き)')], ['free', T('自由に歌う(テンポは後で推定)')]]) {
      const lab = el('label', 'rec-mode');
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'dict-tempo'; radio.value = v; radio.checked = (state.tempoMode === v);
      radio.addEventListener('change', () => { if (radio.checked) { state.tempoMode = v; saveState(); } });
      lab.appendChild(radio); lab.appendChild(document.createTextNode(label)); tRow.appendChild(lab);
    }
    secTempo.appendChild(tRow);
    pop.appendChild(secTempo);

    const recRow = el('div', 'metro-row dict-rec-row');
    pels.recBtn = el('button', 'dict-rec', ''); pels.recBtn.type = 'button';
    pels.recBtn.addEventListener('click', () => { if (recording) stopRecording(); else startRecording(); });
    recRow.appendChild(pels.recBtn);
    pels.recTime = el('span', 'rec-unit', ''); recRow.appendChild(pels.recTime);
    pop.appendChild(recRow);

    const secFile = section(T('音声ファイルから'));
    const fRow = el('div', 'metro-row');
    const fileBtn = el('button', 'dict-small', T('ファイルを選ぶ…')); fileBtn.type = 'button';
    const fileInp = document.createElement('input'); fileInp.type = 'file'; fileInp.accept = 'audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm'; fileInp.hidden = true;
    fileInp.addEventListener('change', () => { if (fileInp.files && fileInp.files[0]) loadFile(fileInp.files[0]); });
    fileBtn.addEventListener('click', () => fileInp.click());
    fRow.appendChild(fileBtn); fRow.appendChild(fileInp);
    fRow.appendChild(el('span', 'rec-note', T('ブラウザが再生できる形式(WAV/MP3/M4A など)')));
    secFile.appendChild(fRow);
    pop.appendChild(secFile);

    // ドロップでも読める
    pop.addEventListener('dragover', (e) => { e.preventDefault(); });
    pop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });
    return pop;
  }

  function syncPopUI() {
    if (!popEl) return;
    const open = MML.Input.MicInput.isOpen();
    pels.micBtn.textContent = open ? T('マイクを閉じる') : T('マイクを開く');
    pels.recBtn.textContent = recording ? T('■ 停止してMMLにする') : T('● 録音を始める');
    pels.recBtn.classList.toggle('is-recording', recording);
    if (!recording) pels.recTime.textContent = '';
    if (!open) { pels.meter.style.width = '0%'; pels.pitch.textContent = '—'; }
  }

  function openPopover() {
    if (popEl) { closePopover(); return; }
    const pop = buildPopover();
    document.body.appendChild(pop);
    const r = toggleEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right - pw, top = r.bottom + 4;
    if (left < 4) left = 4;
    if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 4);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    popEl = pop;
    syncPopUI();
    renderDevices();
    if (MML.Input.MicInput.isOpen()) startLive();
    popCloseHandler = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type !== 'keydown' && (pop.contains(e.target) || toggleEl.contains(e.target))) return;
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
    popEl.remove(); popEl = null; pels = {};
    stopLive();
    // 録音中でなければマイクも閉じる(開いたままにしない)
    if (!recording && MML.Input.MicInput.isOpen()) { MML.Input.MicInput.close(); micInfo = null; liveTracker = null; }
  }

  function updateToggleUI() {
    if (!toggleEl) return;
    toggleEl.classList.toggle('is-recording', recording);
    toggleEl.title = recording ? T('聴音の録音を止めてMMLにする') : T('聴音: 鼻歌や楽器の単音を録ってMMLにする');
    toggleEl.setAttribute('aria-pressed', recording ? 'true' : 'false');
  }

  function toggle() {
    if (recording) { stopRecording(); return; }
    openPopover();
  }

  // ---- 公開API ---------------------------------------------------------

  UI.DictationPanel = {
    init(opts) {
      toggleEl          = opts.toggleEl;
      getAudioCtx       = opts.getAudioCtx;
      getEditor         = opts.getEditor;
      getChannelLetters = opts.getChannelLetters || null;
      getMmlTempo       = opts.getMmlTempo || null;
      getUsedLetters    = opts.getUsedLetters || null;
      onInserted        = opts.onInserted || null;
      loadState();
      if (toggleEl) toggleEl.addEventListener('click', toggle);
      updateToggleUI();
    },
    isRecording() { return recording; },
    startRecording,
    stopRecording,
    /* 他の入口(ドロップ等)から音声ファイルを渡す */
    loadFile,
    /* テスト用: PCM を直接テイクにする */
    loadSamples(samples, sampleRate, name) { newTake({ samples, sampleRate, source: 'file', name: name || 'pcm', bpm: null, beatsPerBar: 4, originSec: null }); },
    getResult() { return result; }
  };

})(window);
