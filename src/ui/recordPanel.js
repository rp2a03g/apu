/*
 * 演奏の録音とMML挿入 (MML.UI.RecordPanel) — UI層
 *
 * ROADMAPフェーズ3 段階2。演奏入力(src/ui/performInput.js)で弾いた音を録り、
 * tick格子へ量子化して(src/input/quantize.js)MMLの断片にし、エディタへ挿入する。
 *
 * ■ 時間の基準はメトロノーム
 *   ●を押すとメトロノームをカウントイン付きで開始し、その**カウントイン明けの拍**
 *   (Metronome.downbeatTime())を tick 0 とする。テンポも拍子もメトロノームの設定を使うので、
 *   「聴いていたクリック」と「量子化の格子」が必ず一致する。クリックを聴きたくない場合は
 *   メトロノームの音量を0にする(格子は残る)。
 *   入力の遅れは録音時に MML.Input.Latency の較正値を引いて補正する(段階0で測った値)。
 *
 * ■ 重ね録り(オーバーダブ)
 *   MMLを再生しながら●を押すと重ね録りになる。打鍵の時刻は
 *   src/audio/stream-player.js の songTimeAt() で**曲の位置**へ写してから量子化するので、
 *   録れた音符は曲頭からの絶対位置を持つ。それをそのまま未使用のチャンネル文字へ
 *   書き出せば、先頭の休符ぶんだけ後ろにずれた正しい位置で重なる。
 *   ★getPosition()とcurrentTimeを直接突き合わせると1バッファ(約93ms)ずれる。
 *   聴き比べるパートのミュートは鍵盤表示のミュート(既存機能)を使う。
 *   再生範囲のくり返しがONなら、折り返した時点で1周ぶんを閉じる。
 *
 * ■ 和音(段階5-a)
 *   打鍵は NoteSource.addNoteListener() から1つずつ受ける(単音ビューでは
 *   和音の下の音が見えないため)。量子化してから同じstartでまとめるので、
 *   「同時押しの判定閾値」は要らない(src/input/quantize.js)。
 *   扱いは「1chの高速アルペジオ(EN)」「複数チャンネルへ分ける」「いちばん上の音だけ」。
 *   ★分ける場合は emitScore(小節で縦に揃えたスコア形式)へそのまま渡す。挿入先は
 *     未使用のチャンネル文字を声部の数だけ連続して使う(使用中へ足すと並列にならない)。
 *   ★ENの定義行(@EN<n> = {...})は本文の**先頭**へ入れる。定義は曲全体で共有される
 *     ものなので、音符と同じ場所へ差し込むわけにいかない。既にMMLで使われている
 *     @EN番号とぶつからないよう、最大値+1から採番する。
 *
 * ■ 挿入は必ずユーザーが確認してから(INV-6: 既存MMLを黙って書き換えない)
 *   停止すると結果ダイアログが開き、格子・強さ・ゲートを変えながら**挿入される文字列
 *   そのもの**をプレビューできる。押すまで本文には一切触らない。
 *   カーソル位置へ差し込む場合は l<n> を出さない(=以降の既定音価を変えない)。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI  = MML.UI = MML.UI || {};
  const T   = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const STORAGE_KEY = 'mml.record';
  const DEFAULTS = { grid: 16, strength: 100, gate: 'fill', mode: 'cursor', letter: 'A', chordMode: 'arp', voices: 3 };

  const GRID_LABELS = {
    // ★ラベルはメトロノームの刻み(src/ui/metronomePanel.js)と同じ語にする
    4:  '4分音符', 8:  '8分音符', 12: '3連8分音符',
    16: '16分音符', 24: '3連16分音符', 32: '32分音符'
  };
  // 'fill' = 隙間を詰める(レガート)。人は音価いっぱいには押さないので、これが既定
  const GATE_OPTIONS = [['fill', '隙間を詰める'], [100, 'そのまま'], [75, '75%'], [50, '50%'], [25, '25%']];
  // 和音の扱い。'arp' は1chで済み、ppmckのEN(高速アルペジオ)そのものなので既定にする
  const CHORD_OPTIONS = [['arp', 'アルペジオにする (EN)'], ['split', 'チャンネルに分ける'], ['top', 'いちばん上の音だけ']];

  let state = Object.assign({}, DEFAULTS);
  let toggleEl = null, getAudioCtx = null, getEditor = null, getChannelLetters = null;
  let getMmlTempo = null, onInserted = null;
  let getPlaybackClock = null, getSongTimeAt = null, getUsedLetters = null;

  let recording = false;
  let recorded  = [];      // TimedPitchEvent列(単音ビュー。和音を使わない経路の互換用)
  let recordedNotes = [];  // 打鍵列 [{type,note,velocity,timeSec}](和音を含む本体)
  let take      = null;    // { originSec, endSec, bpm, beatsPerBar }
  let modalEl   = null;
  // 重ね録りのときだけ挿入先を「末尾に新しい行」に寄せる。state.mode(保存される
  // ユーザーの好み)は書き換えず、このテイクの間だけ上書きする
  let modeOverride = null;
  let els = {};

  // ---- 設定の保存/復元 -------------------------------------------------

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULTS)) if (raw[k] != null) state[k] = raw[k];
      }
    } catch (e) { /* ignore */ }
    if (MML.Input.QUANTIZE_GRIDS.indexOf(state.grid) < 0) state.grid = DEFAULTS.grid;
    state.strength = clampNum(state.strength, 0, 100, DEFAULTS.strength);
    if (state.gate !== 'fill') state.gate = clampNum(state.gate, 25, 100, 100);
    if (state.mode !== 'cursor' && state.mode !== 'append') state.mode = DEFAULTS.mode;
    if (['arp', 'top', 'split'].indexOf(state.chordMode) < 0) state.chordMode = DEFAULTS.chordMode;
    state.voices = clampNum(state.voices, 1, 8, DEFAULTS.voices);
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function clampNum(v, min, max, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // ---- 録音 -------------------------------------------------------------

  function onEvent(e) {
    if (!recording || e.timeSec == null) return;
    // 段階0で測った入力の遅れを引く。ここで引いておけば量子化側は素直な時間軸だけ見ればよい
    const offset = MML.Input.Latency ? MML.Input.Latency.getOffsetSec() : 0;
    const t = e.timeSec - offset;
    // 重ね録りは「曲のどこで鳴らしたか」を記録する(オーディオ時刻のままだと曲と結び付かない)
    const at = take && take.overdub ? (getSongTimeAt ? getSongTimeAt(t) : null) : t;
    if (at == null) return;
    recorded.push({ timeSec: at, midiNote: e.midiNote, velocity: e.velocity });
  }

  /* 打鍵1つずつ。時刻の扱いは単音ビュー(onEvent)とまったく同じ規則 */
  function onNoteEvent(e) {
    if (!recording || e.timeSec == null) return;
    const offset = MML.Input.Latency ? MML.Input.Latency.getOffsetSec() : 0;
    const t = e.timeSec - offset;
    const at = take && take.overdub ? (getSongTimeAt ? getSongTimeAt(t) : null) : t;
    if (at == null) return;
    recordedNotes.push({ type: e.type, note: e.note, velocity: e.velocity, timeSec: at });
  }

  function start() {
    if (recording) return;
    const ctx = getAudioCtx ? getAudioCtx() : null;
    const PI = MML.UI.PerformInput;
    const MP = MML.UI.MetronomePanel;
    if (!ctx || !PI || !MP) return;

    closeModal();
    PI.arm();                      // 弾けなければ録れない
    recorded = [];
    recordedNotes = [];
    PI.getNoteSource().addEventListener(onEvent);
    PI.getNoteSource().addNoteListener(onNoteEvent);

    const clock = getPlaybackClock ? getPlaybackClock() : null;
    if (clock) {
      // 重ね録り: 曲が基準。メトロノームは(点いていれば)曲の拍へ合わせ直すだけで、
      // 掛け直すとカウントインで曲を跨いでしまうので触らない
      MP.requestPlaybackSync();
      take = { overdub: true, originSec: 0, endSec: null, bpm: MP.getBpm(), beatsPerBar: MP.getBeatsPerBar() };
    } else {
      // 単独録音: メトロノームを録り直しのたびに掛け直す(カウントインを毎回頭から出すため)
      MP.stop();
      MP.start({ forceCountIn: true });
      const m = MP.getMetronome();
      take = {
        overdub: false,
        originSec: m ? m.downbeatTime() : ctx.currentTime,
        endSec: null,
        bpm: MP.getBpm(),
        beatsPerBar: m ? m.beatsPerBar : 4
      };
    }
    recording = true;
    updateToggleUI();
  }

  function stop() {
    if (!recording) return;
    const ctx = getAudioCtx ? getAudioCtx() : null;
    const PI = MML.UI.PerformInput;
    const src = PI.getNoteSource();
    // ★離す前に外すと、押しっぱなしの音の終端(midiNote:null)が録れず最後の音が伸び続ける
    src.allOff(ctx ? ctx.currentTime : null);
    src.removeEventListener(onEvent);
    src.removeNoteListener(onNoteEvent);
    // 重ね録りのメトロノームは曲に付いているので止めない(曲を止めるのはユーザーの操作)
    if (!take.overdub) MML.UI.MetronomePanel.stop();
    const nowCtx = ctx ? ctx.currentTime : null;
    take.endSec = take.overdub
      ? ((getSongTimeAt && nowCtx != null ? getSongTimeAt(nowCtx) : null) != null
          ? getSongTimeAt(nowCtx) : take.originSec)
      : (nowCtx != null ? nowCtx : take.originSec);
    recording = false;
    updateToggleUI();

    if (!recordedNotes.some(e => e.type === 'on')) { take = null; return; }
    openModal();
  }

  function toggle() { if (recording) stop(); else start(); }

  /* 演奏入力が切れた(Esc等)なら録音も止める */
  function onPerformDisarmed() { if (recording) stop(); }

  /*
   * 再生範囲のくり返しが折り返した(main.js)。重ね録りは「1周ぶん」で閉じる。
   * ★閉じないと曲の位置が巻き戻り、2周目の打鍵が1周目と同じ時刻に重なって
   *   前の音符を上書きしてしまう(量子化は時刻順に並べ直すため)。
   */
  function onLoopWrapped() { if (recording && take && take.overdub) stop(); }

  function updateToggleUI() {
    if (!toggleEl) return;
    toggleEl.classList.toggle('is-recording', recording);
    toggleEl.title = recording ? T('録音を止める') : T('演奏を録音してMMLにする');
    toggleEl.setAttribute('aria-pressed', recording ? 'true' : 'false');
  }

  // ---- 量子化とMML生成 --------------------------------------------------

  function letters() {
    const list = getChannelLetters ? (getChannelLetters() || []) : [];
    return list.length ? list : ['A', 'B', 'C', 'D'];
  }

  function currentMode() { return modeOverride || state.mode; }

  /*
   * 声部を複数チャンネルへ分けて書き出す。emitScore(小節で縦に揃えたスコア形式)を
   * そのまま使うので、パート同士が小節で揃った読みやすい譜面になる。
   */
  function buildScore(q) {
    const ls = splitLetters(q.lanes.length);
    const channelsData = q.lanes.map((events, i) => ({ letter: ls[i], events }));
    const text = MML.Convert.emitScore(channelsData, MML.Convert.TPQN, {
      totalFrames: q.totalTicks,
      beatsPerMeasure: take.beatsPerBar,
      cmd: { SHAPE_REST: false }
    });
    return { q, text, defLines: [], letters: ls };
  }

  /*
   * 音程を鳴らせるチャンネル文字だけを、チャンネル文字の並び順で返す。
   * ★ノイズ(D)とDPCM(E)を外すのが要点。外さないと和音の一部が
   *   ノイズchへ配られて、音程のつもりの音がノイズになる(実際に踏んだ)。
   */
  function melodicLetters() {
    const P = MML.Convert && MML.Convert.ChannelPlan;
    const all = letters();
    if (!P) return all.filter((l) => l !== 'D' && l !== 'E');
    return all.filter((l) => {
      const t = P.targetOfLetter(l);
      if (!t || t === 'skip') return false;
      const info = P.targetInfo(t);
      return info && info.family && info.family !== 'noise' && info.family !== 'dpcm';
    });
  }

  /*
   * 声部の数だけチャンネル文字を確保する。★未使用の文字を優先する。
   * 使用中の文字へ足すと「並列に鳴る別パート」ではなく「そのチャンネルの続き」に
   * なってしまい、和音として重ならない(足りないときは知らせる: splitLetterWarning)。
   */
  function splitLetters(n) {
    const all = melodicLetters();
    const used = getUsedLetters ? (getUsedLetters() || []) : [];
    const free = all.filter((l) => used.indexOf(l) < 0);
    const out = free.slice(0, n);
    for (const l of all) { if (out.length >= n) break; if (out.indexOf(l) < 0) out.push(l); }
    return out;
  }

  /* 選ばれた文字のうち、既に音符があるもの(並列に鳴らない)を返す */
  function splitLetterWarning(ls) {
    const used = getUsedLetters ? (getUsedLetters() || []) : [];
    return ls.filter((l) => used.indexOf(l) >= 0);
  }

  /* MML本文で既に使われている @EN 番号の次(ぶつからないように採番する) */
  function nextFreeEnIndex() {
    const ta = getEditor ? getEditor() : null;
    if (!ta) return 0;
    let max = -1;
    const re = /@EN\s*(\d+)/g;
    let m;
    while ((m = re.exec(ta.value)) !== null) max = Math.max(max, Number(m[1]));
    return max + 1;
  }

  function build() {
    const q = MML.Input.quantize(recorded, {
      noteEvents: recordedNotes,
      chordMode: state.chordMode,
      voices: state.voices,
      bpm: take.bpm,
      originSec: take.originSec,
      endSec: take.endSec,
      grid: state.grid,
      strength: state.strength / 100,
      gate: (state.gate === 'fill') ? 1 : state.gate / 100,
      legato: (state.gate === 'fill'),
      beatsPerBar: take.beatsPerBar
    });
    // ★チャンネルに分けるときは複数行のスコアになるので、カーソル位置へは差し込めない。
    //   挿入先は常に「末尾に新しい行」になる(UI側でもラジオを固定する)
    const splitMode = (state.chordMode === 'split' && q.lanes.length > 1);
    if (splitMode) return buildScore(q);

    const cursorMode = (currentMode() === 'cursor');
    // カーソル挿入は「音符だけ」がほしいので先頭の休符を落として0から始める。
    // 重ね録りだと曲頭からの絶対位置なので、落とさないと曲の長さぶんの休符が入る
    const lead = (cursorMode && q.events.length) ? q.events[0].start : 0;
    const evs = lead
      ? q.events.map(e => Object.assign({}, e, { start: e.start - lead, end: e.end - lead }))
      : q.events.map(e => Object.assign({}, e));

    // 和音→アルペジオ: ev.noteEnvOffsets を @EN<n> へ登録する。
    // 「検出は量子化側・登録は呼び出し元」という既存の役割分担(assignNoteEnvelope)に合わせる
    const enBase = nextFreeEnIndex();
    const reg = new MML.Convert.NoteEnvelopeRegistry({ EN: true });
    let hasEn = false;
    for (const ev of evs) {
      if (!ev.noteEnvOffsets) continue;
      const idx = reg.registerShape(ev.noteEnvOffsets);
      if (idx != null) { ev.noteEnv = idx + enBase; hasEn = true; }
      delete ev.noteEnvOffsets;
    }
    const defLines = hasEn
      ? reg.defLines().map(l => l.replace(/^@EN(\d+)/, (mm, n) => '@EN' + (Number(n) + enBase)))
      : [];
    const text = MML.Convert.emitChannel(cursorMode ? '' : state.letter, evs, MML.Convert.TPQN, {
      // カーソル挿入は「弾いたぶんだけ」。小節へ切り上げた尺を使うと末尾に休符が付き、
      // 挿入位置より後ろにあった既存の音符がそのぶん後ろへずれてしまう
      totalFrames: cursorMode ? (q.contentTicks - lead) : q.totalTicks,
      // カーソル挿入では l<n> を出さない(以降の既定音価を変えてしまうため)
      noDefaultLen: cursorMode,
      // カーソル挿入は1行に収める(途中で折り返すとチャンネル文字の無い行ができて壊れる)
      wrapCol: cursorMode ? 1e9 : 80,
      // 譜面整形はここでは掛けない(量子化は src/input/quantize.js が済ませている)
      cmd: { SHAPE_REST: false },
      hasNoteEnv: hasEn
    });
    // ★カーソル挿入でENを使ったら、断片の最後で必ず ENOF に戻す。
    //   戻さないと、差し込んだ位置より後ろにあった**既存の音符が全部アルペジオになる**
    //   (l<n>を出さないのと同じ理由。INV-6: 既存MMLの意味を黙って変えない)。
    //   末尾に足す方は後ろに何も無いので不要。
    const closed = (cursorMode && hasEn) ? (text.trim() + ' ENOF') : text;
    return { q, text: cursorMode ? closed.trim() : closed, defLines };
  }

  // ---- 結果ダイアログ ---------------------------------------------------

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function row(labelText) {
    const r = el('div', 'rec-row');
    r.appendChild(el('span', 'rec-label', labelText));
    return r;
  }

  function openModal() {
    closeModal();
    modeOverride = null;
    const backdrop = el('div', 'es-backdrop');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

    const modal = el('div', 'es-modal rec-modal');
    const header = el('div', 'es-modal-header');
    header.appendChild(el('span', null, T('録音結果')));
    const closeBtn = el('button', 'es-modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', T('閉じる'));
    closeBtn.addEventListener('click', closeModal);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const body = el('div', 'es-modal-body');
    els.info = el('div', 'rec-info');
    body.appendChild(els.info);
    els.warn = el('div', 'rec-warn');
    els.warn.hidden = true;
    body.appendChild(els.warn);

    // --- 量子化 ---
    const rGrid = row(T('格子'));
    els.gridSelect = document.createElement('select');
    for (const g of MML.Input.QUANTIZE_GRIDS) {
      const o = document.createElement('option');
      o.value = String(g); o.textContent = T(GRID_LABELS[g]);
      els.gridSelect.appendChild(o);
    }
    els.gridSelect.value = String(state.grid);
    els.gridSelect.addEventListener('change', () => { state.grid = Number(els.gridSelect.value); saveState(); refresh(); });
    rGrid.appendChild(els.gridSelect);
    body.appendChild(rGrid);

    const rStr = row(T('吸着の強さ'));
    els.strInput = document.createElement('input');
    els.strInput.type = 'range'; els.strInput.min = '0'; els.strInput.max = '100'; els.strInput.step = '5';
    els.strInput.value = String(state.strength);
    els.strLabel = el('span', 'rec-unit', state.strength + '%');
    els.strInput.addEventListener('input', () => {
      state.strength = Number(els.strInput.value);
      els.strLabel.textContent = state.strength + '%';
      saveState(); refresh();
    });
    rStr.appendChild(els.strInput);
    rStr.appendChild(els.strLabel);
    body.appendChild(rStr);

    const rGate = row(T('音の長さ'));
    els.gateSelect = document.createElement('select');
    for (const [value, label] of GATE_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(value); o.textContent = T(label);
      els.gateSelect.appendChild(o);
    }
    els.gateSelect.value = String(state.gate);
    els.gateSelect.addEventListener('change', () => {
      const v = els.gateSelect.value;
      state.gate = (v === 'fill') ? 'fill' : Number(v);
      saveState(); refresh();
    });
    rGate.appendChild(els.gateSelect);
    body.appendChild(rGate);

    const rChord = row(T('和音'));
    els.chordSelect = document.createElement('select');
    for (const [value, label] of CHORD_OPTIONS) {
      const o = document.createElement('option');
      o.value = value; o.textContent = T(label);
      els.chordSelect.appendChild(o);
    }
    els.chordSelect.value = state.chordMode;
    els.chordSelect.addEventListener('change', () => {
      state.chordMode = els.chordSelect.value;
      saveState(); syncModeUI(); refresh();
    });
    rChord.appendChild(els.chordSelect);
    els.voicesSelect = document.createElement('select');
    for (let n = 2; n <= 8; n++) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = T('{n}声', { n });
      els.voicesSelect.appendChild(o);
    }
    els.voicesSelect.value = String(state.voices);
    els.voicesSelect.addEventListener('change', () => {
      state.voices = clampNum(els.voicesSelect.value, 1, 8, state.voices);
      saveState(); refresh();
    });
    rChord.appendChild(els.voicesSelect);
    body.appendChild(rChord);

    // --- 挿入先 ---
    const rMode = row(T('挿入先'));
    const modeWrap = el('div', 'rec-modes');
    for (const [value, label] of [['cursor', T('カーソル位置')], ['append', T('末尾に新しい行')]]) {
      const lab = el('label', 'rec-mode');
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'rec-mode'; radio.value = value;
      radio.checked = (currentMode() === value);
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        // 手で選び直したらそれがユーザーの好み。上書きは解除して保存する
        modeOverride = null;
        state.mode = value; saveState(); syncModeUI(); refresh();
      });
      lab.appendChild(radio);
      lab.appendChild(document.createTextNode(label));
      modeWrap.appendChild(lab);
    }
    els.letterSelect = document.createElement('select');
    const usedNow = getUsedLetters ? (getUsedLetters() || []) : [];
    for (const l of letters()) {
      const o = document.createElement('option');
      o.value = l;
      o.textContent = (usedNow.indexOf(l) >= 0) ? T('{letter}(使用中)', { letter: l }) : l;
      els.letterSelect.appendChild(o);
    }
    // 重ね録りは既定で未使用のチャンネルへ(使用中へ足すと続きとして鳴り、重ならない)
    if (take && take.overdub) {
      const free = letters().find(l => usedNow.indexOf(l) < 0);
      if (free && usedNow.indexOf(state.letter) >= 0) state.letter = free;
      modeOverride = 'append';
    }
    if (letters().indexOf(state.letter) < 0) state.letter = letters()[0];
    els.letterSelect.value = state.letter;
    els.letterSelect.addEventListener('change', () => { state.letter = els.letterSelect.value; saveState(); refresh(); });
    modeWrap.appendChild(els.letterSelect);
    rMode.appendChild(modeWrap);
    body.appendChild(rMode);

    // 重ね録りの既定(append)を上のletterSelect構築で決めているので、ラジオを合わせ直す
    for (const r of modeWrap.querySelectorAll('input[name=rec-mode]')) r.checked = (r.value === currentMode());

    els.note = el('div', 'rec-note');
    body.appendChild(els.note);

    els.defNote = el('div', 'rec-note');
    els.defNote.textContent = T('先頭の @EN 定義行はMMLのいちばん上へ入ります(定義は曲全体で共有されるため)。');
    els.defNote.hidden = true;
    body.appendChild(els.defNote);
    els.preview = el('pre', 'rec-preview');
    body.appendChild(els.preview);
    modal.appendChild(body);

    const footer = el('div', 'es-modal-footer');
    const again = el('button', null, T('もう一度録る'));
    again.type = 'button';
    again.addEventListener('click', () => { closeModal(); start(); });
    const cancel = el('button', null, T('やめる'));
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    const ok = el('button', 'rec-insert', T('挿入'));
    ok.type = 'button';
    ok.addEventListener('click', doInsert);
    footer.appendChild(again);
    footer.appendChild(cancel);
    footer.appendChild(ok);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modalEl = backdrop;
    syncModeUI();
    refresh();

    els.esc = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', els.esc, true);
  }

  function syncModeUI() {
    if (!els.letterSelect) return;
    const split = (state.chordMode === 'split');
    if (els.voicesSelect) els.voicesSelect.hidden = !split;
    // 複数行のスコアになるのでカーソル位置へは差し込めない。末尾追記に固定する
    for (const r of (modalEl ? modalEl.querySelectorAll('input[name=rec-mode]') : [])) {
      r.disabled = split && r.value === 'cursor';
    }
    if (split) {
      modeOverride = 'append';
      for (const r of modalEl.querySelectorAll('input[name=rec-mode]')) r.checked = (r.value === 'append');
      els.letterSelect.hidden = true;
      const ls = splitLetters(state.voices);
      const busy = splitLetterWarning(ls);
      els.note.textContent = T('{letters} の{n}チャンネルに分けて、MMLの末尾へ足します。',
        { letters: ls.join('/'), n: ls.length })
        + (busy.length ? T('★{letters}には既に音符があるので、並列ではなく続きとして鳴ります。', { letters: busy.join('/') }) : '');
      return;
    }
    els.letterSelect.hidden = (currentMode() !== 'append');
    const used = getUsedLetters ? (getUsedLetters() || []) : [];
    if (currentMode() === 'cursor') {
      els.note.textContent = T('カーソル位置に差し込みます。以降の既定音価は変えません(全ての音符に音価を書きます)。ただしオクターブ(o<n>)は後ろの音符にも効き続けます。')
        + (take && take.overdub ? T('(重ね録りの位置合わせは失われます)') : '');
    } else if (used.indexOf(state.letter) >= 0) {
      els.note.textContent = T('MMLの末尾に「{letter} …」の行を足します。{letter}には既に音符があるので、その続きとして鳴ります。', { letter: state.letter });
    } else {
      els.note.textContent = take && take.overdub
        ? T('未使用の{letter}へ書き出します。先頭の休符で位置が合うので、曲に重なって鳴ります。', { letter: state.letter })
        : T('未使用の{letter}へ新しいパートとして書き出します。', { letter: state.letter });
    }
  }

  function refresh() {
    if (!modalEl || !take) return;
    const { q, text, defLines } = build();
    const bars = Math.max(1, Math.round(q.totalTicks / (MML.Convert.TPQN * take.beatsPerBar)));
    els.info.textContent = T('{bpm} BPM / {beats}拍子 / {bars}小節 / {notes}音', {
      bpm: Math.round(take.bpm * 10) / 10, beats: take.beatsPerBar, bars, notes: q.noteCount
    }) + (q.chordCount ? T('・和音{n}個', { n: q.chordCount }) : '')
      + (q.droppedCount ? T('(短すぎる{n}音は除外)', { n: q.droppedCount }) : '');
    els.preview.textContent = defLines.length ? (defLines.join('\n') + '\n\n' + text) : text;
    els.defNote.hidden = !defLines.length;

    // ★録音時のテンポとMML本文のテンポが違うと、挿入した音符は「弾いた速さ」ではなく
    //   MML側のテンポで鳴る(emitChannelはt<n>を出さない=曲全体のテンポを勝手に変えない)。
    //   黙って速さが変わるのが一番わかりにくいので、ここで必ず知らせる
    const mmlBpm = getMmlTempo ? getMmlTempo() : null;
    const mismatch = Number.isFinite(mmlBpm) && Math.abs(mmlBpm - take.bpm) > 0.05;
    els.warn.hidden = !mismatch;
    if (mismatch) {
      els.warn.textContent = T('MML本文のテンポ({mml} BPM)と録音時のテンポ({rec} BPM)が違います。挿入した音符はMML側のテンポで鳴ります。',
        { mml: Math.round(mmlBpm * 10) / 10, rec: Math.round(take.bpm * 10) / 10 });
    }
  }

  function doInsert() {
    const ta = getEditor ? getEditor() : null;
    if (!ta) return;
    const { text, defLines } = build();
    // ★@EN定義は曲全体で共有されるものなので、音符と同じ場所へは差し込めない。
    //   本文のいちばん上へ入れ、カーソル位置はその長さぶんずらす
    // ★カーソル位置は value を書き換える**前**に控える。ta.value への代入は
    //   選択位置を末尾へリセットするので、先に定義行を足すと差し込み先を見失う
    const selStart = ta.selectionStart, selEnd = ta.selectionEnd;
    let defPad = 0;
    if (defLines.length) {
      const block = defLines.join('\n') + '\n';
      ta.value = block + ta.value;
      defPad = block.length;
    }
    if (currentMode() === 'cursor') {
      const s = selStart + defPad, e = selEnd + defPad;
      const v = ta.value;
      // 前後が詰まっていると "ccco4 c4" のようになり、字句解析は通っても人が読めない。
      // 空白/改行が無い側にだけ足す
      const before = v.slice(0, s), after = v.slice(e);
      const body = (before && !/\s$/.test(before) ? ' ' : '') + text +
                   (after && !/^\s/.test(after) ? ' ' : '');
      ta.value = before + body + after;
      ta.selectionStart = ta.selectionEnd = s + body.length;
    } else {
      const sep = (!ta.value || ta.value.endsWith('\n')) ? '' : '\n';
      ta.value = ta.value + sep + text + '\n';
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
    // シンタックスハイライトと未保存フラグを更新させる
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    closeModal();
    // ★フォーカスをエディタへ戻すと演奏入力は自動で切れる(PC鍵盤が文字入力に戻る)
    ta.focus();
    if (onInserted) { try { onInserted(text); } catch (e) { console.error(e); } }
  }

  function closeModal() {
    if (!modalEl) return;
    if (els.esc) document.removeEventListener('keydown', els.esc, true);
    modalEl.remove();
    modalEl = null;
    els = {};
  }

  // ---- 公開API ---------------------------------------------------------

  UI.RecordPanel = {
    init(opts) {
      toggleEl          = opts.toggleEl;
      getAudioCtx       = opts.getAudioCtx;
      getEditor         = opts.getEditor;
      getChannelLetters = opts.getChannelLetters || null;
      getMmlTempo       = opts.getMmlTempo || null;
      getPlaybackClock  = opts.getPlaybackClock || null;
      getSongTimeAt     = opts.getSongTimeAt || null;
      getUsedLetters    = opts.getUsedLetters || null;
      onInserted        = opts.onInserted || null;
      loadState();
      if (toggleEl) toggleEl.addEventListener('click', toggle);
      updateToggleUI();
    },
    isRecording() { return recording; },
    start,
    stop,
    toggle,
    onPerformDisarmed,
    onLoopWrapped
  };

})(window);
