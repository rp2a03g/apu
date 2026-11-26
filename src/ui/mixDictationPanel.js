/*
 * 曲の採譜 (MML.UI.MixDictation) — UI層
 *
 * 伴奏入りの音声ファイル(または外のツールで分けたステム)を、src/input/polyTranscribe.js で
 *   旋律 → A / 2 声目 → B / 低音 → C / 打点 → D
 * の MML にして、エディタの末尾へ足す。入口は聴音のポップオーバー(src/ui/dictationPanel.js)。
 *
 * ■ ファイルごとの役割
 *   1 本だけなら「混ざった音」。複数なら名前(bass / drums / other / vocals)から役割を当てる。役割は一覧で直せる。
 *     混ざった音     … 多重音 → 旋律と 2 声目、低音(帯域 or 最低声部)、打点
 *     ベース(ステム)… 単音検出 → 低音
 *     伴奏(ステム)  … 多重音 → 旋律と 2 声目
 *     歌(ステム)    … 単音検出 → 旋律(伴奏の旋律は 2 声目へ回る)
 *     ドラム(ステム)… 打点
 *   分離そのものはこのツールでは行わない(分離の重みは配れない)。ほぼ無音(-50dB 未満)のステムは「使わない」にする。
 *
 * ■ 重い解析は 1 回だけ、しきい値は解き直さず効く
 *   多重音の活性(NMF)がいちばん重い(実時間の 1/5 程度)。これはファイルごとに 1 回だけ解いて持ち、
 *   しきい値・声部分け・量子化は持っている活性から作り直す(即時)。解析中は進み具合を出し、画面を止めない。
 *
 * ■ 調整の保管(レシピ)
 *   役割・しきい値・テンポ・使うパートを、ファイル(名前+サイズ)ごとに localStorage へ残す。音そのものは残さない。
 *   同じファイルをもう一度読むと前回の調整から始まる。
 *
 * ■ 挿入は必ずユーザーが確認してから(INV-6)。既存の MML は書き換えず、末尾に行を足すだけ。
 * ■ 精度の目安は tools/headless/wav2mml-bench.js。結果は「編曲の出発点」で、手直しが前提。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI  = MML.UI = MML.UI || {};
  const T   = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const STORAGE_KEY = 'mml.mixDictation', MAX_RECIPES = 40, QUIET_DB = -50;
  const DEFAULT_RECIPE = { roles: {}, threshold: 0.3, drumSensitivity: 2, bassMode: 'band', parts: { A: true, B: true, C: true, D: true }, grid: 16, rests: true, bpm: null };
  const ROLES = [['mix', '混ざった音'], ['bass', 'ベース(ステム)'], ['other', '伴奏(ステム)'], ['vocals', '歌(ステム)'], ['drums', 'ドラム(ステム)'], ['skip', '使わない']];
  const PART_LABELS = { A: '旋律 → A', B: '2声目 → B', C: '低音 → C', D: '打点 → D' };
  const GRID_LABELS = { 4: '4分音符', 8: '8分音符', 12: '3連8分音符', 16: '16分音符', 24: '3連16分音符', 32: '32分音符' };

  let getAudioCtx = null, getEditor = null, getMmlTempo = null, getUsedLetters = null, onInserted = null;
  let modalEl = null, els = {};
  let sources = [];     // [{ name, size, x(24kHz), db, role, act, bassCache }]
  let recipe = null, recipeKey = '';
  let result = null;    // PolyTranscribe.buildMml の戻り値 + counts
  let runId = 0, busy = false;

  // ---- レシピ -------------------------------------------------------------

  function loadStore() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveRecipe() {
    if (!recipeKey || !recipe) return;
    try {
      const st = loadStore();
      st[recipeKey] = Object.assign({}, recipe, { at: Date.now() });
      const keys = Object.keys(st).sort((a, b) => (st[b].at || 0) - (st[a].at || 0));
      for (const k of keys.slice(MAX_RECIPES)) delete st[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
    } catch (e) { /* ignore */ }
  }
  function recipeFor(key) {
    const saved = loadStore()[key];
    const r = JSON.parse(JSON.stringify(DEFAULT_RECIPE));
    if (saved) {
      for (const k of ['threshold', 'drumSensitivity', 'bassMode', 'grid', 'rests', 'bpm']) if (saved[k] != null) r[k] = saved[k];
      Object.assign(r.parts, saved.parts || {}); Object.assign(r.roles, saved.roles || {});
    }
    return r;
  }

  // ---- 小物 ---------------------------------------------------------------

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function row(labelText) { const r = el('div', 'metro-row'); r.appendChild(el('span', 'rec-label', labelText)); return r; }
  function rmsDb(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return 10 * Math.log10(s / Math.max(1, x.length) + 1e-12); }
  function guessRole(name, count) {
    if (count === 1) return 'mix';
    const n = name.toLowerCase();
    if (/bass|ベース/.test(n)) return 'bass';
    if (/drum|ドラム|perc/.test(n)) return 'drums';
    if (/vocal|voice|歌|ボーカル/.test(n)) return 'vocals';
    if (/other|inst|伴奏|accomp|piano|guitar/.test(n)) return 'other';
    return 'mix';
  }
  function setStatus(msg) { if (els.status) els.status.textContent = msg || ''; }

  // ---- 読み込み -----------------------------------------------------------

  async function openFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    const ctx = getAudioCtx ? getAudioCtx() : null;
    if (!ctx || !files.length) return;
    const PT = MML.Input.PolyTranscribe;
    openModal();
    sources = [];
    const myRun = ++runId;
    busy = true; syncBusy();
    for (const f of files) {
      setStatus(T('読み込み中: {name}', { name: f.name }));
      try {
        const buf = await ctx.decodeAudioData((await f.arrayBuffer()).slice(0));
        if (myRun !== runId) return;
        const n = buf.length, mono = new Float32Array(n);
        for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
        const x = PT.toMono24k(mono, buf.sampleRate);
        sources.push({ name: f.name, size: f.size, x, db: rmsDb(x), role: null, act: null, bassCache: null });
      } catch (e) {
        setStatus(T('読み込めませんでした: {msg}', { msg: f.name + ' — ' + ((e && e.message) || String(e)) }));
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    if (myRun !== runId) return;
    if (!sources.length) { busy = false; syncBusy(); setStatus(T('読み込める音声がありませんでした。')); return; }
    startWith(myRun);
  }

  /* テスト用・他の入口用: PCM を直接渡す。list: [{ name, samples, sampleRate }] */
  function openSamples(list) {
    const PT = MML.Input.PolyTranscribe;
    openModal();
    const myRun = ++runId;
    sources = list.map(s => { const x = PT.toMono24k(s.samples, s.sampleRate); return { name: s.name, size: s.samples.length, x, db: rmsDb(x), role: s.role || null, act: null, bassCache: null }; });
    return startWith(myRun);
  }

  function startWith(myRun) {
    recipeKey = sources.map(s => s.name + '|' + s.size).sort().join('//');
    recipe = recipeFor(recipeKey);
    for (const s of sources) {
      const saved = recipe.roles[s.name];
      s.role = s.role || saved || (s.db < QUIET_DB ? 'skip' : guessRole(s.name, sources.length));
    }
    renderSources(); syncControls();
    return analyze(myRun);
  }

  // ---- 解析 ---------------------------------------------------------------

  /* 重い段: 多重音の活性を、要るファイルだけ解く(済んでいるものは飛ばす) */
  async function analyze(myRun) {
    const PT = MML.Input.PolyTranscribe;
    myRun = myRun || ++runId;
    busy = true; syncBusy();
    const need = sources.filter(s => (s.role === 'mix' || s.role === 'other') && !s.act);
    const t0 = performance.now();
    for (let i = 0; i < need.length; i++) {
      const s = need[i];
      const act = await PT.multiPitchAsync(s.x, {}, (p) => {
        if (myRun !== runId) throw new Error('cancelled');
        setStatus(T('解析中: {name} {pct}%', { name: s.name, pct: Math.round(p * 100) }));
        if (els.bar) els.bar.style.width = (((i + p) / need.length) * 100).toFixed(1) + '%';
        return new Promise(r => setTimeout(r, 0));
      }).catch(() => null);
      if (myRun !== runId || !act) return;
      s.act = act;
    }
    if (myRun !== runId) return;
    busy = false; syncBusy();
    if (els.bar) els.bar.style.width = '100%';
    derive(need.length ? Math.round(performance.now() - t0) : null);
  }

  /* 軽い段: しきい値・声部分け・量子化。持っている活性から作り直す */
  function derive(analysisMs) {
    if (!modalEl || busy || !sources.length) return;
    const PT = MML.Input.PolyTranscribe, PD = MML.Input.PitchDetect, NS = MML.Input.NoteSegment;
    const o = { threshold: recipe.threshold, drumSensitivity: recipe.drumSensitivity };
    const mono = (x, det) => {
      const { frames } = PD.analyze(x, PT.SAMPLE_RATE, Object.assign({}, NS.PRESETS.instrument.detect, det));
      return NS.segment(frames, Object.assign({}, NS.PRESETS.instrument.segment, { keySnap: false, midiMin: 24 })).notes;
    };
    let melody = [], inner = [], bass = [], hits = [], cutoff = null;
    const by = (role) => sources.filter(s => s.role === role);
    for (const s of by('mix')) {
      const v = PT.voices(PT.notes(s.act, o), o);
      melody = melody.concat(v.melody); inner = inner.concat(v.inner);
      if (recipe.bassMode === 'line') bass = bass.concat(v.bass);
      else {
        cutoff = PT.suggestBassCutoff(v.bass, o);
        if (!s.bassCache || s.bassCache.cutoff !== cutoff) s.bassCache = { cutoff, notes: PT.bassBand(s.x, { bassCutoffHz: cutoff }) };
        bass = bass.concat(s.bassCache.notes);
      }
      hits = hits.concat(PT.drumOnsets(s.x, o));
    }
    for (const s of by('other')) {
      const v = PT.voices(PT.notes(s.act, o), Object.assign({}, o, { bassSplitMidi: 0 }));
      melody = melody.concat(v.melody); inner = inner.concat(v.inner);
    }
    for (const s of by('vocals')) {
      if (!s.monoCache) s.monoCache = mono(s.x, { fmin: 100, fmax: 2100 });
      if (melody.length) inner = melody;   // 伴奏側の旋律は 2 声目へ回す
      melody = s.monoCache;
    }
    for (const s of by('bass')) {
      if (!s.monoCache) s.monoCache = mono(s.x, { fmin: 30, fmax: 400, gateDb: -50 });
      bass = bass.concat(s.monoCache);
    }
    for (const s of by('drums')) hits = hits.concat(PT.drumOnsets(s.x, o));
    const sortN = (a) => a.slice().sort((p, q) => p.startSec - q.startSec);
    hits.sort((p, q) => p.timeSec - q.timeSec);

    const P = recipe.parts;
    const parts = [];
    if (P.A) parts.push({ letter: 'A', notes: sortN(melody) });
    if (P.B) parts.push({ letter: 'B', notes: sortN(inner) });
    if (P.C) parts.push({ letter: 'C', notes: sortN(bass) });
    const r = PT.buildMml(parts, { letter: 'D', hits: P.D ? hits : [] }, { bpm: recipe.bpm || undefined, grid: recipe.grid, rests: recipe.rests });
    result = Object.assign(r, { counts: { A: melody.length, B: inner.length, C: bass.length, D: hits.length }, cutoff });
    if (analysisMs != null) result.analysisMs = analysisMs;
    refresh();
  }

  // ---- ダイアログ ---------------------------------------------------------

  function openModal() {
    closeModal();
    const backdrop = el('div', 'es-backdrop');
    const modal = el('div', 'es-modal dict-modal');
    const header = el('div', 'es-modal-header');
    header.appendChild(el('span', null, T('曲の採譜(伴奏入り)')));
    const closeBtn = el('button', 'es-modal-close', '×'); closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', T('閉じる'));
    closeBtn.addEventListener('click', closeModal);
    header.appendChild(closeBtn); modal.appendChild(header);

    const body = el('div', 'es-modal-body dict-body');
    els.status = el('div', 'rec-info'); body.appendChild(els.status);
    const barWrap = el('div', 'dict-meter'); els.bar = el('div', 'dict-meter-bar'); barWrap.appendChild(els.bar); body.appendChild(barWrap);
    els.warn = el('div', 'rec-warn'); els.warn.hidden = true; body.appendChild(els.warn);

    const cols = el('div', 'dict-cols');
    const left = el('div', 'dict-col'), right = el('div', 'dict-col');
    cols.appendChild(left); cols.appendChild(right); body.appendChild(cols);

    // --- ファイルと役割 ---
    const secSrc = el('div', 'dict-sec'); secSrc.appendChild(el('div', 'dict-sec-title', T('ファイルと役割')));
    els.srcList = el('div', 'mixd-sources'); secSrc.appendChild(els.srcList);
    secSrc.appendChild(el('div', 'rec-note', T('外のツールで分けたファイル(bass / drums / other / vocals)をまとめて選ぶと、役割ごとに採譜します。分離はこのツールでは行いません。')));
    left.appendChild(secSrc);

    // --- 取り出すパート ---
    const secParts = el('div', 'dict-sec'); secParts.appendChild(el('div', 'dict-sec-title', T('取り出すパート')));
    els.parts = {};
    const pRow = el('div', 'rec-modes dict-stack');
    for (const L of ['A', 'B', 'C', 'D']) {
      const lab = el('label', 'rec-mode');
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.addEventListener('change', () => { recipe.parts[L] = cb.checked; saveRecipe(); derive(); });
      els.parts[L] = { cb, count: el('span', 'rec-unit dict-wide', '') };
      lab.appendChild(cb); lab.appendChild(document.createTextNode(T(PART_LABELS[L]))); lab.appendChild(els.parts[L].count);
      pRow.appendChild(lab);
    }
    secParts.appendChild(pRow);
    left.appendChild(secParts);

    // --- 検出 ---
    const secDet = el('div', 'dict-sec'); secDet.appendChild(el('div', 'dict-sec-title', T('検出')));
    const slider = (label, key, min, max, step, title) => {
      const r = row(label); r.title = title;
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step);
      const lab = el('span', 'rec-unit', '');
      inp.addEventListener('input', () => { recipe[key] = Number(inp.value); lab.textContent = String(recipe[key]); });
      inp.addEventListener('change', () => { saveRecipe(); derive(); });
      r.appendChild(inp); r.appendChild(lab); secDet.appendChild(r);
      return { inp, lab };
    };
    els.thr = slider(T('音符のしきい値'), 'threshold', 0.1, 1, 0.05, T('小さいほど弱い音も音符にします(誤検出も増えます)。大きいほど確かな音だけ残ります'));
    els.sens = slider(T('打点の感度'), 'drumSensitivity', 1.2, 6, 0.2, T('小さいほど打点を多く拾います。音程楽器の発音まで打点になるときは上げます'));
    const rBass = row(T('低音の取り方'));
    els.bassMode = document.createElement('select');
    for (const [v, label] of [['band', T('帯域で切る(誤検出が少ない)')], ['line', T('いちばん下の声部(高い音まで動くベース向け)')]]) { const o = document.createElement('option'); o.value = v; o.textContent = label; els.bassMode.appendChild(o); }
    els.bassMode.addEventListener('change', () => { recipe.bassMode = els.bassMode.value; saveRecipe(); derive(); });
    rBass.appendChild(els.bassMode); secDet.appendChild(rBass);
    els.cutNote = el('div', 'rec-note', ''); secDet.appendChild(els.cutNote);
    right.appendChild(secDet);

    // --- 量子化 ---
    const secQ = el('div', 'dict-sec'); secQ.appendChild(el('div', 'dict-sec-title', T('量子化')));
    const rBpm = row(T('テンポ'));
    els.bpm = document.createElement('input'); els.bpm.type = 'number'; els.bpm.className = 'dict-num'; els.bpm.min = '20'; els.bpm.max = '400'; els.bpm.step = '1';
    els.bpm.addEventListener('change', () => { const v = Number(els.bpm.value); recipe.bpm = (Number.isFinite(v) && v >= 20 && v <= 400) ? v : null; saveRecipe(); derive(); });
    rBpm.appendChild(els.bpm);
    els.bpmSrc = el('span', 'rec-unit', ''); rBpm.appendChild(els.bpmSrc);
    els.bpmEst = el('button', 'dict-small', T('推定し直す')); els.bpmEst.type = 'button';
    els.bpmEst.addEventListener('click', () => { recipe.bpm = null; saveRecipe(); derive(); });
    rBpm.appendChild(els.bpmEst); secQ.appendChild(rBpm);
    const rGrid = row(T('格子'));
    els.grid = document.createElement('select');
    for (const g of [4, 8, 12, 16, 24, 32]) { const o = document.createElement('option'); o.value = String(g); o.textContent = T(GRID_LABELS[g]); els.grid.appendChild(o); }
    els.grid.addEventListener('change', () => { recipe.grid = Number(els.grid.value); saveRecipe(); derive(); });
    rGrid.appendChild(els.grid); secQ.appendChild(rGrid);
    const rRest = row(T('隙間を休符に'));
    els.rests = document.createElement('input'); els.rests.type = 'checkbox';
    els.rests.addEventListener('change', () => { recipe.rests = els.rests.checked; saveRecipe(); derive(); });
    rRest.appendChild(els.rests); secQ.appendChild(rRest);
    right.appendChild(secQ);

    els.note = el('div', 'rec-note', T('MMLの末尾に行を足します。既存の行は書き換えません。調整はこのファイルの次回の読み込みに引き継がれます。'));
    body.appendChild(els.note);
    els.preview = el('pre', 'rec-preview'); body.appendChild(els.preview);
    modal.appendChild(body);

    const footer = el('div', 'es-modal-footer');
    const cancel = el('button', null, T('やめる')); cancel.type = 'button'; cancel.addEventListener('click', closeModal);
    els.ok = el('button', 'rec-insert', T('挿入')); els.ok.type = 'button'; els.ok.addEventListener('click', doInsert);
    footer.appendChild(cancel); footer.appendChild(els.ok); modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modalEl = backdrop;
    els.esc = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', els.esc, true);
    syncBusy();
  }

  function renderSources() {
    if (!els.srcList) return;
    els.srcList.textContent = '';
    for (const s of sources) {
      const r = el('div', 'metro-row');
      const name = el('span', 'rec-unit dict-wide', s.name); name.title = s.name;
      const sel = document.createElement('select');
      for (const [v, label] of ROLES) { const o = document.createElement('option'); o.value = v; o.textContent = T(label); sel.appendChild(o); }
      sel.value = s.role;
      sel.addEventListener('change', () => { s.role = sel.value; recipe.roles[s.name] = s.role; saveRecipe(); analyze(); });
      const info = el('span', 'rec-unit', T('{sec}秒', { sec: (s.x.length / MML.Input.PolyTranscribe.SAMPLE_RATE).toFixed(0) }));
      if (s.db < QUIET_DB) info.title = T('ほぼ無音です({db}dB)', { db: s.db.toFixed(0) });
      r.appendChild(name); r.appendChild(sel); r.appendChild(info);
      els.srcList.appendChild(r);
    }
  }

  function syncControls() {
    if (!modalEl || !recipe) return;
    for (const L of ['A', 'B', 'C', 'D']) els.parts[L].cb.checked = !!recipe.parts[L];
    els.thr.inp.value = String(recipe.threshold); els.thr.lab.textContent = String(recipe.threshold);
    els.sens.inp.value = String(recipe.drumSensitivity); els.sens.lab.textContent = String(recipe.drumSensitivity);
    els.bassMode.value = recipe.bassMode;
    els.grid.value = String(recipe.grid);
    els.rests.checked = !!recipe.rests;
  }

  function syncBusy() {
    if (!modalEl) return;
    if (els.ok) els.ok.disabled = busy || !result;
    for (const c of [els.bassMode, els.grid, els.rests, els.bpm, els.bpmEst, els.thr && els.thr.inp, els.sens && els.sens.inp]) if (c) c.disabled = busy;
  }

  function refresh() {
    if (!modalEl || !result) return;
    const c = result.counts, total = sources.reduce((a, s) => Math.max(a, s.x.length), 0) / MML.Input.PolyTranscribe.SAMPLE_RATE;
    setStatus(T('{sec}秒 / 旋律 {a} 音・2声目 {b} 音・低音 {c} 音・打点 {d}', { sec: total.toFixed(1), a: c.A, b: c.B, c: c.C, d: c.D })
      + (result.analysisMs != null ? T(' / 解析 {ms}ms', { ms: result.analysisMs }) : ''));
    for (const L of ['A', 'B', 'C', 'D']) els.parts[L].count.textContent = T('{n} 音', { n: c[L] });
    els.bpm.value = String(Math.round(result.bpm));
    els.bpmSrc.textContent = recipe.bpm ? T('手入力') : T('推定');
    els.bpmEst.hidden = !recipe.bpm;
    els.cutNote.textContent = (recipe.bassMode === 'band' && result.cutoff) ? T('低音は {hz}Hz より下から取りました(曲の最低声部の音域から自動で決めています)。', { hz: result.cutoff }) : '';
    els.preview.textContent = result.text || T('(音符が見つかりませんでした)');
    const used = getUsedLetters ? (getUsedLetters() || []) : [];
    const clash = result.lines.map(l => l.letter).filter(l => used.indexOf(l) >= 0);
    const mmlBpm = getMmlTempo ? getMmlTempo() : null;
    const msgs = [];
    if (clash.length) msgs.push(T('{letters} には既に音符があります。足した行はその続きとして鳴ります。', { letters: clash.join(' / ') }));
    if (used.length && Number.isFinite(mmlBpm) && Math.abs(mmlBpm - result.bpm) > 0.5) msgs.push(T('MML本文のテンポ({mml} BPM)と採譜のテンポ({rec} BPM)が違います。', { mml: Math.round(mmlBpm), rec: Math.round(result.bpm) }));
    els.warn.hidden = !msgs.length; els.warn.textContent = msgs.join(' ');
    syncBusy();
  }

  function doInsert() {
    const ta = getEditor ? getEditor() : null;
    if (!ta || !result || !result.text) return;
    const sep = (!ta.value || ta.value.endsWith('\n')) ? '' : '\n';
    ta.value = ta.value + sep + result.text + '\n';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const text = result.text;
    closeModal();
    ta.focus();
    if (onInserted) { try { onInserted(text); } catch (e) { console.error(e); } }
  }

  function closeModal() {
    runId++;   // 解析の途中なら止める
    busy = false;
    if (!modalEl) return;
    if (els.esc) document.removeEventListener('keydown', els.esc, true);
    modalEl.remove(); modalEl = null; els = {};
    sources = []; result = null;
  }

  UI.MixDictation = {
    init(opts) {
      getAudioCtx    = opts.getAudioCtx;
      getEditor      = opts.getEditor;
      getMmlTempo    = opts.getMmlTempo || null;
      getUsedLetters = opts.getUsedLetters || null;
      onInserted     = opts.onInserted || null;
    },
    openFiles,
    openSamples,
    isOpen() { return !!modalEl; },
    isBusy() { return busy; },
    getResult() { return result; },
    close: closeModal
  };

})(window);
