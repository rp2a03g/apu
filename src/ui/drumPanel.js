/*
 * ドラム(DPCM)パネル: サンプル1つ=1行の表
 *   MML.UI.DrumPanel.mount(el, hooks)  … 描画先と外部フックを渡す
 *   MML.UI.DrumPanel.setRows(rows)     … 行データを差し替える(再生/変換のたびに呼ぶ)
 *   MML.UI.DrumPanel.setCost(stats)    … 合計ROMの表示
 *   MML.UI.DrumPanel.setStatus(text)   … 進行中の作業(分離レンダリング等)の表示。空文字で消す
 *
 * 最下段はDPCM変換の共通設定(2026-09-05、変換設定ダイアログから移動): DMCレート(「自動」の
 * サンプルに使うレート)/重複打点のレート(高/低)/同時打点の扱い(ミックス/単音)。実体は
 * 変換設定の cmd(src/convert/options.js DMC_RATE/RATE_MIX/DRUM_POLY)で、
 * MML.UI.ConvertSettings.set() 経由で保存する(各 *2mml が options.cmd で受け取るため)。
 *
 * 行データ rows: [{ key, hash, label, color, hits, pcm, srcRate }]
 *   key   … 'c140:294064'(ドラム区画のパッドと同じキー)
 *   hash  … サンプル内容のハッシュ(設定の保存キー。src/convert/drumSamples.js)
 *
 * 設定の単位を「チャンネル」ではなく「サンプル」にしている理由は drumSamples.js 冒頭参照。
 * パッド(鍵盤の左端)はクリックで即試聴、じっくり詰めるときはこの表、という住み分け。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  let rootEl = null;
  let hooks = {};
  let rows = [];
  let costEl = null;
  let bodyEl = null;
  let statusEl = null;
  let optsEl = null;
  let optSels = null; // { DMC_RATE, RATE_MIX, DRUM_POLY } の <select>
  // 下段の分割ビュー(src/ui/dpcmSplitView.js、DPCMコンバータ下段と同じ部品。2026-09-10)。
  // 行をクリックで選ぶと、そのサンプルの波形(上=オリジナル/下=DPCM)と区間が出て、境目・使用/未使用・
  // 区間ごとのレートを聞きながら決められる。決めた分割はサンプル単位の設定(drumSamples.js split)に
  // 保存され、変換(共通層 drumHits.js)が「単独で鳴っている区間」に効かせる。未設定なら自動分割
  let splitEl = null;
  let splitView = null;
  let splitResetBtn = null;
  let selectedKey = null;
  let splitLocal = null;  // 表示中の L(dpcmSplitView.js 冒頭コメントの形)。hash/key/title を足してある

  function DS() { return MML.Convert && MML.Convert.DrumSamples; }
  function CS() { return MML.UI.ConvertSettings || null; }
  function NP() { return (MML.Convert && MML.Convert.NoisePresets) || null; }

  // ── ノイズパッド(2026-09-18): パッドの現在の音色を解き、エディタ(src/ui/noisePadEditor.js)を開く ──
  // 音色の出自は3通り: このパッドだけの音色(noise.custom) / プリセット(noise.preset) / 未指定(先頭プリセット)。
  // エディタからは「このパッドだけに適用」「プリセットを更新」「新規プリセット」「削除/組み込みに戻す」「試聴」
  // 「音程から自動」(音程を持つパッドの既定): 周期は元の音程から、音量は元のまま(drumHits.js noiseToneOf と同じ)
  // 既定(未設定)は、音程を持つパッドと「割当どおりノイズ」(D で打楽器化した ch/ボイスのパッド)で auto。
  // 後者の auto = 変換器の従来の写し(元の D の音符)のまま(drumHits.js noiseToneOf と同じ規則)
  function isAutoTone(st, r) {
    return !!((st.noise && st.noise.auto) || (!st.noise && r && (r.srcMidi != null || r.defaultTarget === 'noise')));
  }
  function noiseToneOfRow(st, r) {
    const np = NP();
    if (!np) return null;
    if (isAutoTone(st, r)) {
      const DH = MML.Convert.DrumHits;
      const t = (DH && DH.noiseToneOf) ? DH.noiseToneOf(st, np.snapshot(), { srcMidi: r ? r.srcMidi : null, vol: 1 }).tone : np.sanitizeTone(np.DEFAULT_TONE);
      return { tone: t, preset: null, auto: true };
    }
    if (st.noise && st.noise.custom) return { tone: np.sanitizeTone(st.noise.custom), preset: null };
    const p = st.noise && st.noise.preset ? np.get(st.noise.preset) : null;
    if (p) return { tone: p.tone, preset: p };
    const first = np.all()[0] || null;
    return { tone: first ? first.tone : np.sanitizeTone(np.DEFAULT_TONE), preset: first };
  }
  // 実効の載せ先(明示 > 割当どおり(行の defaultTarget) > dpcm)
  function effectiveTargetOf(st, r) {
    if (st.target === 'noise' || st.target === 'dpcm') return st.target;
    return (r && r.defaultTarget === 'noise') ? 'noise' : 'dpcm';
  }
  function openNoiseEditor(anchor, r) {
    const np = NP(), ed = MML.UI.NoisePadEditor;
    if (!np || !ed || !DS() || !r.hash) return;
    const st = DS().get(r.hash);
    const cur = noiseToneOfRow(st, r);
    const p = cur.preset;
    ed.open(anchor, {
      title: T('ノイズの音色: {name}', { name: st.name || r.label || r.key }),
      tone: cur.tone, presetId: p ? p.id : null, presetName: p ? p.name : '', builtin: !!(p && p.builtin), modified: !!(p && p.modified),
      onApplyPad: (tone) => { DS().set(r.hash, { noise: { custom: tone } }); render(); if (hooks.onChange) hooks.onChange(); },
      onSavePreset: (id, name, tone) => {
        const newId = np.set(id, name, tone);
        DS().set(r.hash, { noise: { preset: newId } });
        render(); if (hooks.onChange) hooks.onChange();
      },
      onDeletePreset: (id) => { np.remove(id); render(); if (hooks.onChange) hooks.onChange(); },
      onResetPreset: (id) => { np.resetBuiltin(id); render(); if (hooks.onChange) hooks.onChange(); },
      onAudition: (tone) => { if (hooks.onAuditionNoise) hooks.onAuditionNoise(tone); },
      onAuditionRaw: () => { if (hooks.onPlay) hooks.onPlay(r, 'raw'); },
    });
  }

  /** 属性値へ入れる文字のエスケープ(名前はユーザーが自由に打てるので必須) */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // DMCレート表(index 15=33.1kHz … 0=4.2kHz)を高い順に。withAuto=行の「自動」を先頭に足す
  function rateOptions(withAuto) {
    const table = (MML.Dpcm && MML.Dpcm.DMC_RATE_TABLE_NTSC) || [];
    const opts = withAuto === false ? [] : [['auto', T('自動')]];
    for (let i = table.length - 1; i >= 0; i--) opts.push([String(i), (table[i] / 1000).toFixed(1) + 'kHz']);
    return opts;
  }

  // ── 最下段: DPCM変換の共通設定(冒頭コメント参照) ─────────────────────────
  //   [cmdキー, ラベル, 説明, 選択肢[[値, 表示], ...]]
  function optRows() {
    return [
      ['DMC_RATE', T('DMCレート'),
        T('DMCレートを「自動」にしたサンプルに使うレート(33.1〜4.2kHz)。音質の良さとROM容量は比例します'),
        rateOptions(false)],
      ['RATE_MIX', T('重複打点のレート'),
        T('同時に鳴った打点のDMCレートが異なるとき、高い方と低い方のどちらに合わせるか'),
        [['quality', T('高')], ['size', T('低')]]],
      ['DRUM_POLY', T('同時打点の扱い'),
        T('別チャンネルなどで打点が重なったとき、組み合わせぶんDPCM定義を増やす(ミックス)か、直近の1音に抑える(単音)か。ミックスは同時発音の組み合わせぶん.dmcファイルが増えます'),
        [['mix', T('ミックス')], ['mono', T('単音')]]],
    ];
  }
  function renderOpts() {
    if (!optsEl) return;
    optsEl.innerHTML = '';
    optSels = {};
    for (const [key, name, desc, opts] of optRows()) {
      const row = document.createElement('label');
      row.className = 'dp-opt';
      const n = document.createElement('span');
      n.className = 'dp-opt-name';
      n.textContent = name;
      const sel = document.createElement('select');
      sel.className = 'dp-opt-sel';
      for (const [v, label] of opts) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        if (CS()) CS().set({ [key]: sel.value });
        if (hooks.onChange) hooks.onChange(); // ROMコストの再計算(DMCレートで.dmcの大きさが変わる)
      });
      sel.addEventListener('mousedown', (e) => e.stopPropagation());
      const d = document.createElement('span');
      d.className = 'dp-opt-desc';
      d.textContent = desc;
      row.appendChild(n); row.appendChild(sel); row.appendChild(d);
      optsEl.appendChild(row);
      optSels[key] = sel;
    }
    syncOpts();
  }
  // 今の cmd を select へ反映(他所から set() された場合も ConvertSettings.onChange 経由でここへ来る)
  function syncOpts() {
    if (!optSels || !CS() || !MML.Convert || !MML.Convert.normalizeCmd) return;
    const cmd = MML.Convert.normalizeCmd(CS().get());
    for (const key of Object.keys(optSels)) optSels[key].value = String(cmd[key]);
  }

  function mount(el, h) {
    rootEl = el;
    hooks = h || {};
    if (!rootEl) return;
    rootEl.innerHTML =
      `<div class="drum-panel">` +
        `<div class="drum-panel-head">` +
          `<span class="dp-c-color"></span>` +
          `<span class="dp-c-label">${T('サンプル')}</span>` +
          `<span class="dp-c-play"><i>${T('オリジナル')}</i><i>${T('変換後')}</i></span>` +
          `<span class="dp-c-hits">${T('打点')}</span>` +
          `<span class="dp-c-kind">${T('扱い')}</span>` +
          `<span class="dp-c-on">${T('変換')}</span>` +
          `<span class="dp-c-target">${T('載せ先')}</span>` +
          `<span class="dp-c-noise">${T('ノイズ音色')}</span>` +
          `<span class="dp-c-prio">${T('優先')}</span>` +
          `<span class="dp-c-vol">${T('ボリューム')}</span>` +
          `<span class="dp-c-rate">${T('DMCレート')}</span>` +
          `<span class="dp-c-inc">${T('差し替え')}</span>` +
        `</div>` +
        `<div class="drum-panel-body"></div>` +
        // 一覧と下段(分割ビュー)の境目。ドラッグで下段の高さを変える=一覧の見える範囲を広げられる
        // (パッドが多いと一覧がスクロールになるため、ユーザー要望 2026-09-18)。高さは localStorage に保存
        `<div class="drum-panel-divider" title="${T('ドラッグで一覧と下段の高さを変える(下まで下げると下段を畳む)')}"></div>` +
        `<div class="drum-panel-split"></div>` +
        `<div class="drum-panel-status" hidden></div>` +
        `<div class="drum-panel-foot"></div>` +
        `<div class="drum-panel-opts"></div>` +
      `</div>`;
    bodyEl = rootEl.querySelector('.drum-panel-body');
    costEl = rootEl.querySelector('.drum-panel-foot');
    statusEl = rootEl.querySelector('.drum-panel-status');
    optsEl = rootEl.querySelector('.drum-panel-opts');
    splitEl = rootEl.querySelector('.drum-panel-split');
    initDivider(rootEl.querySelector('.drum-panel-divider'));
    if (MML.UI.DpcmSplitView) {
      splitView = MML.UI.DpcmSplitView.create(splitEl, {
        rateAuto: true, autoLabel: T('自動(行のレート)'),
        onChange: (L) => persistSplit(L),
        title: (L) => L.title || '',
        emptyText: () => T('行を選ぶと、そのサンプルの波形と分割がここに出ます'),
      });
      // 「自動に戻す」: 手動の分割を消す(ビューのツールバーの末尾に足す)
      splitResetBtn = document.createElement('button');
      splitResetBtn.type = 'button';
      splitResetBtn.className = 'secondary dp-split-reset';
      splitResetBtn.textContent = T('自動に戻す');
      splitResetBtn.title = T('手動の分割を消して、共通層の自動分割(上限を超えるときだけ均等に切る)に戻します');
      splitResetBtn.addEventListener('click', () => {
        if (!splitLocal || !splitLocal.hash || !DS()) return;
        DS().set(splitLocal.hash, { split: null });
        render();
        if (hooks.onChange) hooks.onChange();
      });
      const bar = splitEl.querySelector('.dpcm-ed-wave-bar');
      if (bar) bar.insertBefore(splitResetBtn, bar.querySelector('.dpcm-ed-wave-info'));
    }
    renderOpts();
    if (CS() && CS().onChange) CS().onChange(syncOpts);
    if (NP() && NP().onChange) NP().onChange(() => render()); // プリセットの追加/更新で行のセレクトを作り直す
    render();
  }

  // ── 一覧/下段の境目ドラッグ(2026-09-18) ────────────────────────────────────────
  // 下段(.drum-panel-split)の高さを変える。一覧(.drum-panel-body)は flex:1 で残りを取るので、下段を
  // 縮めるほど一覧が広がる。24px未満(ツールバー1本分)まで下げると下段を畳んだ扱い。
  const DIVIDER_KEY = 'drumPanelSplitH';
  function applySplitHeight(h) {
    if (!splitEl) return;
    if (h == null) { splitEl.style.height = ''; splitEl.style.overflow = ''; return; }
    splitEl.style.height = Math.max(0, h) + 'px';
    splitEl.style.overflow = 'hidden';
  }
  function initDivider(div) {
    if (!div || !splitEl) return;
    let saved = null;
    try { const v = parseInt(global.localStorage.getItem(DIVIDER_KEY), 10); if (Number.isFinite(v)) saved = v; } catch (e) { /* ignore */ }
    if (saved != null) applySplitHeight(saved);
    let dragging = false, startY = 0, startH = 0;
    div.addEventListener('mousedown', (e) => {
      dragging = true; startY = e.clientY; startH = splitEl.offsetHeight;
      div.classList.add('dragging'); e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // 下へ引く=下段が縮む(=一覧が広がる)
      const h = Math.max(0, startH + (startY - e.clientY));
      applySplitHeight(h);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; div.classList.remove('dragging');
      try { global.localStorage.setItem(DIVIDER_KEY, String(splitEl.offsetHeight)); } catch (e) { /* ignore */ }
    });
    // ダブルクリックで自動(内容なりの高さ)へ戻す
    div.addEventListener('dblclick', () => {
      applySplitHeight(null);
      try { global.localStorage.removeItem(DIVIDER_KEY); } catch (e) { /* ignore */ }
    });
  }

  function setRows(next) {
    rows = Array.isArray(next) ? next : [];
    render();
  }

  // 進行中の作業の表示。分離レンダリングは曲の長さぶん再エミュレーションするので数十秒かかる。
  // 何も出さないと「急に重くなった」ようにしか見えないので、必ずここへ出す
  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  }

  function setCost(stats) {
    if (!costEl) return;
    if (!stats) { costEl.textContent = ''; return; }
    costEl.textContent = T('合計 定義 {clips} / 打点 {segments} / ROM {kb} KB',
      { clips: stats.clips, segments: stats.segments, kb: (stats.bytes / 1024).toFixed(1) });
    // 16KB(DMC領域1ページ=窓4-7)を超えると、ブラウザ再生もNSF書き出しも16KBごとの「ページ」に分けて
    // トリガー時にバンク切替する(2026-09-10、compiler.js layoutDpcmSamples / ppmckDriver.js DPCM_PAGE_TBL)。
    // 無音にはならないがROMがそのぶん大きくなるので、16KB超は黄色で「大きい」と知らせるだけにする
    costEl.classList.toggle('drum-panel-foot--warn', stats.bytes >= 16 * 1024);
    costEl.classList.remove('drum-panel-foot--over');
  }

  // 差し替えの小メニュー。DPCMコンバータで開いている音をそのまま使えるようにして、
  // 「コンバータ ⇄ ドラムパッド」を1操作で繋ぐ(ユーザー要望の融合)
  let menuEl = null;
  function closeIncludeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }
  function openIncludeMenu(anchor, r) {
    closeIncludeMenu();
    const m = document.createElement('div');
    m.className = 'kbd-sample-menu';
    const items = [];
    items.push([T('ファイルを選ぶ…'), () => { if (hooks.onInclude) hooks.onInclude(r); }]);
    const cname = hooks.converterName ? hooks.converterName() : null;
    if (cname) items.push([T('DPCMコンバータの「{name}」を使う', { name: cname }), () => { if (hooks.onIncludeFromConverter) hooks.onIncludeFromConverter(r); }]);
    if (DS() && DS().get(r.hash).include) {
      items.push([T('元のサンプルに戻す'), () => {
        DS().setIncludePcm(r.hash, null, null, 0);
        render();
        if (hooks.onChange) hooks.onChange();
      }]);
    }
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-sample-menu-item';
      b.textContent = label;
      b.addEventListener('click', (e) => { e.stopPropagation(); closeIncludeMenu(); fn(); });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const rc = anchor.getBoundingClientRect();
    m.style.left = Math.round(Math.min(rc.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.round(Math.min(rc.bottom + 2, window.innerHeight - m.offsetHeight - 8)) + 'px';
    menuEl = m;
    setTimeout(() => document.addEventListener('click', closeIncludeMenu, { once: true }), 0);
  }

  // ── 下段の分割ビュー ─────────────────────────────────────────────────────
  // 行の設定(レート/音量/差し替え)とパネル最下段の DMC_RATE から、分割ビューが扱う L を組む。
  // 手動の分割(split)が無ければ、共通層 drumHits.js と同じ自動分割(上限に収まる本数の均等割り)を
  // 見せる。境目を動かした時点で手動になり保存される
  function buildLocal(r) {
    const M = MML.UI.DpcmSplitView && MML.UI.DpcmSplitView.model;
    if (!M || !DS() || !r || !r.hash) return null;
    const st = DS().get(r.hash);
    const inc = DS().getIncludePcm(r.hash);
    const pcm = (inc && inc.pcm) ? inc.pcm : r.pcm;
    const srcRate = (inc && inc.rate > 0) ? inc.rate : r.srcRate;
    if (!pcm || !pcm.length || !(srcRate > 0)) return null;
    const cmd = (CS() && MML.Convert && MML.Convert.normalizeCmd) ? MML.Convert.normalizeCmd(CS().get()) : { DMC_RATE: 15 };
    const rate = (st.rate === 'auto' || st.rate == null) ? (cmd.DMC_RATE | 0) : (parseInt(st.rate, 10) | 0);
    const L = { key: r.key, hash: r.hash, baseTitle: st.name || r.label || r.key, title: '',
                pcm, srcRate, dmc: null, dmcFrom: null, dac: 64, rate, vol: M.clampVol(st.vol),
                segs: [{ end: 1, rate: null, used: true }], pieces: [null], previewPcm: null, previewKey: null,
                manual: false };
    const split = DS().sanitizeSplit(st.split);
    if (split) {
      // 保存は秒(drumSamples.js 参照)。ビューは割合なので、いまのクリップ長で割る。決めたときより
      // 長いクリップなら残りを未使用の区間として足す(境目は動かさない)。末尾の1フレーム以内は末尾へ吸着
      const total = pcm.length / srcRate;
      L.segs = [];
      let prev = 0;
      for (const s of split.segs) {
        let end = Math.min(1, s.end / total);
        if (s.end >= total - 1 / 60) end = 1;
        if (end <= prev) continue;
        L.segs.push({ end, rate: s.rate, used: s.used });
        prev = end;
      }
      if (!L.segs.length) L.segs = [{ end: 1, rate: null, used: true }];
      else if (L.segs[L.segs.length - 1].end < 1) L.segs.push({ end: 1, rate: null, used: false });
      L.manual = true;
    } else {
      L.segs = autoSegs(L);
    }
    L.pieces = L.segs.map(() => null);
    return L;
  }
  // 共通層 drumHits.js の自動分割を再現した区間列: 上限に収まる本数の均等割り。ただし共通層は
  // 1打点を最大 MAX_CLIP_SEC(10秒)までしか焼かないので、それより長いサンプルは先頭10秒ぶんを
  // 割り、残りを「未使用」の区間として見せる(境目を動かした時点で手動になり、全長が使える)
  function autoSegs(L) {
    const M = MML.UI.DpcmSplitView.model;
    const capSec = (MML.Convert.DrumHits && MML.Convert.DrumHits.MAX_CLIP_SEC) || 10;
    const len = L.pcm.length, capN = Math.min(len, Math.round(capSec * L.srcRate));
    const c = capN / len;
    const K = M.requiredPieces(c < 1 ? Object.assign({}, L, { pcm: L.pcm.subarray(0, capN) }) : L);
    const segs = [];
    for (let k = 1; k <= K; k++) segs.push({ end: k === K ? c : c * k / K, rate: null, used: true });
    if (c < 1) segs.push({ end: 1, rate: null, used: false });
    else segs[K - 1].end = 1;
    return segs;
  }
  function autoCapSec(L) {
    const capSec = (MML.Convert.DrumHits && MML.Convert.DrumHits.MAX_CLIP_SEC) || 10;
    return (L.pcm.length / L.srcRate > capSec) ? capSec : 0;
  }
  // 手動の分割かどうか: 区間が1つで既定(全区間使用・レート行任せ)なら「自動」と同じなので保存しない
  function isDefaultSplit(L) {
    const auto = autoSegs(L);
    if (L.segs.length !== auto.length) return false;
    return L.segs.every((s, k) => Math.abs(s.end - auto[k].end) < 1e-6 && (s.used !== false) === auto[k].used && s.rate == null);
  }
  function persistSplit(L) {
    if (!DS() || !L || !L.hash) return;
    const dflt = isDefaultSplit(L);
    L.manual = !dflt;
    const total = L.pcm.length / L.srcRate; // 保存は秒(drumSamples.js 参照)
    DS().set(L.hash, { split: dflt ? null : { segs: L.segs.map(s => ({ end: s.end * total, rate: s.rate == null ? null : s.rate, used: s.used !== false })) } });
    L.title = titleOf(L); // onChange の直後にビューが描き直すので、ここで見出しを差し替えておけば反映される
    if (splitResetBtn) splitResetBtn.hidden = !L.manual;
    syncBadges();
    if (hooks.onChange) hooks.onChange(); // ROMコスト再計算(区間の未使用/レートでサイズが変わる)
  }
  function syncSplit() {
    if (!splitView) return;
    const r = selectedKey != null ? rows.find(x => x.key === selectedKey) : null;
    if (!r) { selectedKey = null; splitLocal = null; splitView.setLocal(null); if (splitResetBtn) splitResetBtn.hidden = true; return; }
    splitLocal = buildLocal(r);
    if (splitLocal) splitLocal.title = titleOf(splitLocal);
    splitView.setLocal(splitLocal);
    if (splitResetBtn) splitResetBtn.hidden = !(splitLocal && splitLocal.manual);
  }
  // 分割ビューの見出し: 名前 + いまの分割が自動か手動か(自動なら共通層が何本にするか)
  function titleOf(L) {
    const K = L.segs.filter(s => s.used !== false).length, cap = autoCapSec(L);
    return (L.baseTitle || '') + '  ' + (L.manual
      ? T('分割 {n}区間(手動)', { n: L.segs.length })
      : cap ? T('{n}区間に分割して変換します(自動、先頭{sec}秒まで。境目を動かすと全長が使えます)', { n: K, sec: cap })
      : (K > 1 ? T('{n}区間に分割して変換します(自動)', { n: K }) : T('1本で収まります')));
  }
  function selectRow(key) {
    selectedKey = key;
    for (const el of bodyEl.querySelectorAll('.drum-panel-row')) el.classList.toggle('drum-panel-row--sel', el.dataset.key === key);
    syncSplit();
  }
  // 行の「✂N」(手動の分割あり)を付け直す(分割ビューで変えたときは行を作り直さずここだけ更新)
  function syncBadges() {
    if (!bodyEl || !DS()) return;
    for (const el of bodyEl.querySelectorAll('.drum-panel-row')) {
      const r = rows.find(x => x.key === el.dataset.key);
      const badge = el.querySelector('.dp-split-badge');
      if (!r || !badge) continue;
      const sp = r.hash ? DS().get(r.hash).split : null;
      badge.textContent = (sp && sp.segs && sp.segs.length) ? '✂' + sp.segs.length : '';
    }
  }

  function render() {
    if (!bodyEl) return;
    if (!rows.length) {
      // ★形式非依存の文言にする(2026-09-04)。全6形式でこのパネルを使うので「VGMを再生して」は誤り
      bodyEl.innerHTML = `<div class="drum-panel-empty">${T('打楽器のサンプルがありません。曲を再生してキャプチャが終わると一覧に出ます(鍵盤表示の割当で借用先にE(DPCM)を選んだchもここに出ます)。')}</div>`;
      syncSplit();
      return;
    }
    bodyEl.innerHTML = '';
    const opts = rateOptions();
    for (const r of rows) {
      const st = DS() ? DS().get(r.hash) : { enabled: true, rate: 'auto', include: null };
      // 名前だけ残っていてPCMが未登録(ページ再読み込み後)。UIで気づけるようにする
      const missing = !!(DS() && st.include && !DS().getIncludePcm(r.hash));
      // ★ハッシュが無い行は設定を保存できない(=操作しても黙って何も起きない)。
      //   実際に「キャプチャWorkerのバンドル再ビルド忘れでsampleHashが届かない」事故があったので、
      //   黙って無反応にせず理由を出して操作を止める
      const noHash = !r.hash;
      const vol = DS() ? DS().clampVol(st.vol) : 100;
      const effNoise = effectiveTargetOf(st, r) === 'noise'; // 載せ先がノイズ(明示 or 割当どおり)
      const row = document.createElement('div');
      row.className = 'drum-panel-row' + (st.enabled === false ? ' drum-panel-row--off' : '')
        + (missing ? ' drum-panel-row--missing' : '') + (noHash ? ' drum-panel-row--nohash' : '')
        + (r.key === selectedKey ? ' drum-panel-row--sel' : '');
      row.dataset.key = r.key;
      row.dataset.hash = r.hash || '';
      const sp = st.split && st.split.segs && st.split.segs.length ? st.split.segs.length : 0;
      row.innerHTML =
        `<span class="dp-c-color"><i style="background:${r.color || '#888'}"></i></span>` +
        // 名前は編集できる。付けた名前はロールのパッドと @DPCM の書き出しファイル名にも使う
        `<span class="dp-c-label"><input type="text" class="dp-name" value="${esc(st.name || '')}"` +
          ` placeholder="${esc(r.label || '?')}" title="${esc(r.key)}">` +
          // ✂N = 手動の分割あり(下段で編集)
          `<span class="dp-split-badge" title="${T('境目・使用/未使用・区間ごとのレートを手で決めた分割。行を選ぶと下段に出ます')}">${sp ? '✂' + sp : ''}</span></span>` +
        // 試聴はサンプルのすぐ右。押すところは音符マークにして、何を鳴らすかは列見出しで示す
        `<span class="dp-c-play">` +
          `<button type="button" class="dp-play" data-mode="raw" title="${T('原音を鳴らす')}">♪</button>` +
          // 変換後: 載せ先が DPCM なら DPCM 変換後、ノイズならセットしたノイズの音色を鳴らす(ボタンの文字で示す)
          `<button type="button" class="dp-play dp-play--text" data-mode="dpcm" title="${effNoise ? T('セットしたノイズの音色(変換後)を鳴らす') : T('DPCM変換後を鳴らす')}">${effNoise ? T('ノイズ') : 'DPCM'}</button>` +
        `</span>` +
        `<span class="dp-c-hits">${r.hits != null ? r.hits : ''}</span>` +
        // 扱い: 打楽器(パッド)か音階付きサンプルか。自動判定を手で上書きする
        // (実体は Emu.SamplePitchUtil のkind上書き=サンプル内容ハッシュ。ロール/鍵盤/変換が同じ1点を見る)
        `<span class="dp-c-kind"><select class="dp-kind" title="${T('このサンプルを打楽器(パッド)として扱うか、音階を持つサンプルとして扱うか')}">` +
          `<option value="auto">${T('自動')}</option>` +
          `<option value="drum">${T('打楽器')}</option>` +
          `<option value="pitch">${T('音階')}</option>` +
        `</select></span>` +
        `<span class="dp-c-on"><input type="checkbox" class="dp-on"${st.enabled === false ? '' : ' checked'}></span>` +
        // 載せ先(2026-09-18、ノイズパッド): DPCM=実サンプルを@DPCMへ / ノイズ=2A03ノイズ(D)の音符列へ。
        // ノイズのときは音色(プリセット or このパッドだけの音色)と、重なった時の優先度を選ぶ
        `<span class="dp-c-target"><select class="dp-target" title="${T('この打点をどこで鳴らすか。DPCM=実サンプルを焼く / ノイズ=2A03ノイズ(D)の音符にする(プリセットの音色で)。既定は鍵盤の割当どおり(E→DPCM、D→ノイズ)')}">` +
          `<option value="">${T('割当どおり')}(${r.defaultTarget === 'noise' ? T('ノイズ') : 'DPCM'})</option>` +
          `<option value="dpcm">DPCM</option><option value="noise">${T('ノイズ')}</option></select></span>` +
        `<span class="dp-c-noise">` +
          `<select class="dp-noise" title="${T('ノイズの音色(プリセット)。「このパッドだけ…」を選ぶか ✎ で個別に編集')}"></select>` +
          `<button type="button" class="dp-noise-edit" title="${T('音色を編集/試聴(プリセットの更新・追加もここから)')}">✎</button>` +
        `</span>` +
        `<span class="dp-c-prio"><select class="dp-prio" title="${T('打点が重なった時の優先(ノイズは1本)。同時なら高い方、同じなら後から始まった方が勝つ')}">` +
          `<option value="-1">${T('低')}</option><option value="0">${T('通常')}</option><option value="1">${T('高')}</option></select></span>` +
        `<span class="dp-c-vol">` +
          `<input type="range" class="dp-vol" min="1" max="100" step="1" value="${vol}">` +
          `<span class="dp-vol-num">${vol}%</span>` +
        `</span>` +
        `<span class="dp-c-rate"><select class="dp-rate"></select></span>` +
        `<span class="dp-c-inc">` +
          `<button type="button" class="dp-inc"${missing ? ' title="' + T('差し替えファイルが未読み込みです(ページを開き直すとPCMは消えます)。もう一度選び直してください') + '"' : ''}>` +
            `${st.include ? (st.include.name || T('差し替え済み')) : T('ファイル…')}${missing ? ' ' + T('(要再読込)') : ''}</button>` +
          (st.include ? `<button type="button" class="dp-inc-clear" title="${T('元のサンプルに戻す')}">×</button>` : '') +
        `</span>`;
      const kindSel = row.querySelector('.dp-kind');
      kindSel.value = r.kind || 'auto';
      kindSel.disabled = noHash;
      kindSel.addEventListener('change', () => {
        if (hooks.onKind) hooks.onKind(r, kindSel.value);
      });

      // ── 載せ先 / ノイズ音色 / 優先(ノイズパッド) ──
      const isNoise = effectiveTargetOf(st, r) === 'noise';
      if (isNoise) row.classList.add('drum-panel-row--noise');
      const targetSel = row.querySelector('.dp-target');
      targetSel.value = (st.target === 'noise' || st.target === 'dpcm') ? st.target : '';
      targetSel.disabled = noHash || !NP();
      targetSel.addEventListener('change', () => {
        if (DS()) DS().set(r.hash, { target: targetSel.value === 'noise' ? 'noise' : (targetSel.value === 'dpcm' ? 'dpcm' : null) });
        render();
        if (hooks.onChange) hooks.onChange();
      });
      const noiseSel = row.querySelector('.dp-noise');
      const noiseEdit = row.querySelector('.dp-noise-edit');
      const prioSel = row.querySelector('.dp-prio');
      if (NP()) {
        // 音程を持つパッド(旋律chの打楽器化)は「音程から自動」が先頭かつ既定(従来の D 割当と同じ出力)
        if (r.srcMidi != null || r.defaultTarget === 'noise') {
          const oa = document.createElement('option');
          oa.value = '__auto';
          // 音程を持つパッド: 音程→周期・音量は元のまま / D割当のサンプル(SPC BRR・VGM PCM): 変換器の写しのまま
          oa.textContent = r.srcMidi != null ? T('音程から自動(元の音程・音量)') : T('自動(元の写しのまま)');
          noiseSel.appendChild(oa);
        }
        for (const p of NP().all()) {
          const o = document.createElement('option');
          o.value = p.id; o.textContent = p.name + (p.modified ? ' *' : '');
          noiseSel.appendChild(o);
        }
        const oc = document.createElement('option');
        oc.value = '__custom'; oc.textContent = T('このパッドだけの音色…');
        noiseSel.appendChild(oc);
        const cur = isAutoTone(st, r) ? '__auto'
          : (st.noise && st.noise.custom ? '__custom'
            : (st.noise && st.noise.preset && NP().get(st.noise.preset) ? st.noise.preset : (NP().all()[0] || {}).id));
        if (cur) noiseSel.value = cur;
        noiseSel.addEventListener('change', () => {
          if (noiseSel.value === '__custom') { openNoiseEditor(noiseEdit, r); noiseSel.value = st.noise && st.noise.custom ? '__custom' : cur; return; }
          if (DS()) DS().set(r.hash, { noise: noiseSel.value === '__auto' ? { auto: true } : { preset: noiseSel.value } });
          render();
          if (hooks.onChange) hooks.onChange();
        });
        noiseEdit.addEventListener('click', (e) => { e.stopPropagation(); openNoiseEditor(noiseEdit, r); });
      }
      noiseSel.disabled = !isNoise || noHash || !NP();
      noiseEdit.disabled = !isNoise || noHash || !NP();
      prioSel.value = String(st.priority | 0);
      prioSel.disabled = !isNoise || noHash;
      prioSel.addEventListener('change', () => {
        if (DS()) DS().set(r.hash, { priority: parseInt(prioSel.value, 10) | 0 });
        if (hooks.onChange) hooks.onChange();
      });

      const sel = row.querySelector('.dp-rate');
      for (const [v, label] of opts) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = String(st.rate);
      sel.addEventListener('change', () => {
        if (DS()) DS().set(r.hash, { rate: sel.value === 'auto' ? 'auto' : parseInt(sel.value, 10) });
        if (r.key === selectedKey) syncSplit(); // 下段の区間サイズは行のレートで変わる
        if (hooks.onChange) hooks.onChange();
      });
      // 行のクリック(操作部品以外)でそのサンプルを選び、下段に波形と分割を出す
      row.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input, select, label')) return;
        selectRow(r.key);
      });
      const nameEl = row.querySelector('.dp-name');
      nameEl.addEventListener('change', () => {
        const v = nameEl.value.trim();
        if (DS()) DS().set(r.hash, { name: v || null });
        if (hooks.onRename) hooks.onRename();
      });
      // 入力中にウィンドウのドラッグやキーボードショートカットへ取られないようにする
      nameEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameEl.blur(); });
      nameEl.addEventListener('mousedown', (e) => e.stopPropagation());

      const volEl = row.querySelector('.dp-vol');
      const volNum = row.querySelector('.dp-vol-num');
      // ★DPCMは1bitデルタ変調なので、振幅を下げるほど量子化ノイズが相対的に大きくなる
      //   (実測: 50%でRMS誤差17%、25%で34%、10%で85%)。効きすぎる前に気づけるよう印を出す
      const syncVolWarn = () => {
        const v = parseInt(volEl.value, 10);
        volNum.textContent = v + '%';
        volNum.classList.toggle('dp-vol-num--warn', v < 25);
        volNum.title = v < 25
          ? T('小さくしすぎるとDPCMの量子化ノイズが目立ちます(25%未満)。元のサンプル側を下げるか、鳴らさない方が良い場合があります')
          : T('変換時にこのサンプルへ掛ける音量。DPCMは実機で@vが効かないので、ここが唯一の音量調整です');
      };
      syncVolWarn();
      volEl.addEventListener('input', syncVolWarn);
      volEl.addEventListener('change', () => {
        if (DS()) DS().set(r.hash, { vol: parseInt(volEl.value, 10) });
        if (r.key === selectedKey) syncSplit(); // 下段の上段波形/DPCMはボリューム込み
        if (hooks.onChange) hooks.onChange();
      });
      volEl.addEventListener('mousedown', (e) => e.stopPropagation());

      const on = row.querySelector('.dp-on');
      on.addEventListener('change', () => {
        if (DS()) DS().set(r.hash, { enabled: on.checked });
        row.classList.toggle('drum-panel-row--off', !on.checked);
        if (hooks.onChange) hooks.onChange();
      });
      for (const b of row.querySelectorAll('.dp-play')) {
        b.addEventListener('click', () => {
          if (b.dataset.mode === 'dpcm' && effNoise) {
            // ノイズの変換後 = パッドにセットした音色を本物のコンパイラ+2A03で鳴らす(main.js onAuditionNoise)
            const cur = noiseToneOfRow(st, r);
            if (cur && hooks.onAuditionNoise) hooks.onAuditionNoise(cur.tone);
            return;
          }
          if (hooks.onPlay) hooks.onPlay(r, b.dataset.mode);
        });
      }
      const inc = row.querySelector('.dp-inc');
      if (inc) inc.addEventListener('click', (e) => { e.stopPropagation(); openIncludeMenu(inc, r); });
      if (noHash) {
        for (const el of row.querySelectorAll('.dp-rate, .dp-on, .dp-inc, .dp-vol, .dp-name')) {
          el.disabled = true;
          el.title = T('このサンプルの同定情報(ハッシュ)が届いていないため設定を保存できません。キャプチャWorkerの再ビルドが必要かもしれません');
        }
      }
      const clr = row.querySelector('.dp-inc-clear');
      if (clr) clr.addEventListener('click', () => {
        if (DS()) DS().setIncludePcm(r.hash, null, null, 0);
        render();
        if (hooks.onChange) hooks.onChange();
      });
      bodyEl.appendChild(row);
    }
    syncSplit(); // 行を作り直したので下段(選択中の行)も追従させる
  }

  UI.DrumPanel = { mount, setRows, setCost, setStatus, render };
})(window);
