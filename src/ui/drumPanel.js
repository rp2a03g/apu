/*
 * ドラム(DPCM)パネル: サンプル1つ=1行の表
 *   MML.UI.DrumPanel.mount(el, hooks)  … 描画先と外部フックを渡す
 *   MML.UI.DrumPanel.setRows(rows)     … 行データを差し替える(再生/変換のたびに呼ぶ)
 *   MML.UI.DrumPanel.setCost(stats)    … 合計ROMの表示
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

  function DS() { return MML.Convert && MML.Convert.DrumSamples; }

  /** 属性値へ入れる文字のエスケープ(名前はユーザーが自由に打てるので必須) */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rateOptions() {
    const table = (MML.Dpcm && MML.Dpcm.DMC_RATE_TABLE_NTSC) || [];
    const opts = [['auto', T('自動')]];
    for (let i = table.length - 1; i >= 0; i--) opts.push([String(i), (table[i] / 1000).toFixed(1) + 'kHz']);
    return opts;
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
          `<span class="dp-c-on">${T('変換')}</span>` +
          `<span class="dp-c-vol">${T('ボリューム')}</span>` +
          `<span class="dp-c-rate">${T('DMCレート')}</span>` +
          `<span class="dp-c-inc">${T('差し替え')}</span>` +
        `</div>` +
        `<div class="drum-panel-body"></div>` +
        `<div class="drum-panel-foot"></div>` +
      `</div>`;
    bodyEl = rootEl.querySelector('.drum-panel-body');
    costEl = rootEl.querySelector('.drum-panel-foot');
    render();
  }

  function setRows(next) {
    rows = Array.isArray(next) ? next : [];
    render();
  }

  function setCost(stats) {
    if (!costEl) return;
    if (!stats) { costEl.textContent = ''; return; }
    costEl.textContent = T('合計 定義 {clips} / 打点 {segments} / ROM {kb} KB',
      { clips: stats.clips, segments: stats.segments, kb: (stats.bytes / 1024).toFixed(1) });
    costEl.classList.toggle('drum-panel-foot--warn', stats.bytes >= 32 * 1024);
    costEl.classList.toggle('drum-panel-foot--over', stats.bytes >= 64 * 1024);
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
      bodyEl.innerHTML = `<div class="drum-panel-empty">${T('打楽器のサンプルがありません。VGMを再生してキャプチャが終わると一覧に出ます。')}</div>`;
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

  UI.DrumPanel = { mount, setRows, setCost, render };
})(window);
