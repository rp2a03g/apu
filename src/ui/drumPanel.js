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

  function DS() { return MML.Convert && MML.Convert.DrumSamples; }
  function CS() { return MML.UI.ConvertSettings || null; }

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
          `<span class="dp-c-play"><i>${T('オリジナル')}</i><i>DPCM</i></span>` +
          `<span class="dp-c-hits">${T('打点')}</span>` +
          `<span class="dp-c-kind">${T('扱い')}</span>` +
          `<span class="dp-c-on">${T('変換')}</span>` +
          `<span class="dp-c-vol">${T('ボリューム')}</span>` +
          `<span class="dp-c-rate">${T('DMCレート')}</span>` +
          `<span class="dp-c-inc">${T('差し替え')}</span>` +
        `</div>` +
        `<div class="drum-panel-body"></div>` +
        `<div class="drum-panel-status" hidden></div>` +
        `<div class="drum-panel-foot"></div>` +
        `<div class="drum-panel-opts"></div>` +
      `</div>`;
    bodyEl = rootEl.querySelector('.drum-panel-body');
    costEl = rootEl.querySelector('.drum-panel-foot');
    statusEl = rootEl.querySelector('.drum-panel-status');
    optsEl = rootEl.querySelector('.drum-panel-opts');
    renderOpts();
    if (CS() && CS().onChange) CS().onChange(syncOpts);
    render();
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
    // ★DMC領域は16KB固定(ブラウザ再生 compiler.js layoutDpcmSamples も NSF書き出し ppmckDriver.js も
    //   窓4-7=$C000-$FFFF で頭打ち。超えたぶんのサンプルは黙って無音になる)。12KBで注意、16KBで超過
    costEl.classList.toggle('drum-panel-foot--warn', stats.bytes >= 12 * 1024);
    costEl.classList.toggle('drum-panel-foot--over', stats.bytes >= 16 * 1024);
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

  function render() {
    if (!bodyEl) return;
    if (!rows.length) {
      // ★形式非依存の文言にする(2026-09-04)。全6形式でこのパネルを使うので「VGMを再生して」は誤り
      bodyEl.innerHTML = `<div class="drum-panel-empty">${T('打楽器のサンプルがありません。曲を再生してキャプチャが終わると一覧に出ます(鍵盤表示の割当で借用先にE(DPCM)を選んだchもここに出ます)。')}</div>`;
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
      const row = document.createElement('div');
      row.className = 'drum-panel-row' + (st.enabled === false ? ' drum-panel-row--off' : '')
        + (missing ? ' drum-panel-row--missing' : '') + (noHash ? ' drum-panel-row--nohash' : '');
      row.innerHTML =
        `<span class="dp-c-color"><i style="background:${r.color || '#888'}"></i></span>` +
        // 名前は編集できる。付けた名前はロールのパッドと @DPCM の書き出しファイル名にも使う
        `<span class="dp-c-label"><input type="text" class="dp-name" value="${esc(st.name || '')}"` +
          ` placeholder="${esc(r.label || '?')}" title="${esc(r.key)}"></span>` +
        // 試聴はサンプルのすぐ右。押すところは音符マークにして、何を鳴らすかは列見出しで示す
        `<span class="dp-c-play">` +
          `<button type="button" class="dp-play" data-mode="raw" title="${T('原音を鳴らす')}">♪</button>` +
          `<button type="button" class="dp-play" data-mode="dpcm" title="${T('DPCM変換後を鳴らす')}">♪</button>` +
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

      const sel = row.querySelector('.dp-rate');
      for (const [v, label] of opts) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = String(st.rate);
      sel.addEventListener('change', () => {
        if (DS()) DS().set(r.hash, { rate: sel.value === 'auto' ? 'auto' : parseInt(sel.value, 10) });
        if (hooks.onChange) hooks.onChange();
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
        b.addEventListener('click', () => { if (hooks.onPlay) hooks.onPlay(r, b.dataset.mode); });
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
  }

  UI.DrumPanel = { mount, setRows, setCost, setStatus, render };
})(window);
