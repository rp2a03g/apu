/*
 * 音色一覧パネル: この曲で使われている音色(楽器)1つ=1行の表 (2026-09-09)
 *   MML.UI.TonePanel.mount(el, hooks)   … 描画先と外部フックを渡す
 *   MML.UI.TonePanel.setRows(rows)      … 行データを差し替える(ロールが組み直されるたびに main.js が呼ぶ)
 *   MML.UI.TonePanel.setFilter(chId)    … 特定チャンネルの音色だけに絞る(null で全部)
 *   MML.UI.TonePanel.setDemotions(list) … 直前の変換で VRC7 自作音色があぶれてプリセットへ落ちた音色
 *   MML.UI.TonePanel.render()
 *
 * 設定の単位はチャンネルではなく「音色」(src/convert/toneSettings.js、キーは src/convert/toneKey.js)。
 * 同じ音色が複数チャンネルに出ても行は1つで、指定は全チャンネルに効く。ドラム(DPCM)パネルの
 * 「サンプル1つ=1行」と同じ考え方の旋律音色版。
 *
 * 行データ rows: [{ key, kind, label, color, info, chans:[{id, letter, target}], count, hash?, pcm?, srcRate? }]
 *   kind  … 'brr'|'pcm'|'opn'|'opll'|'wave'|'duty'|'sq'(toneKey.js の種別)
 *   info  … 表示/試聴用の付随情報(wave 32点0..15 / patch / bytes / inst / duty)
 *   chans … この音色を鳴らしたチャンネル(パート文字と今の借用先)。載せ先/音色指定の選択肢はここから決める
 *
 * 列: 音色(アイコン+名前) / 使用ch / 回数 / 元の音(試聴) / 載せ先 / 音色指定 / 変換後(試聴) / 注記
 *   載せ先「chに従う」= 上書き無し(チャンネルの借用先)。指定するとその音色だけ別パートへ分割される
 *   音色指定「chに従う」= 上書き無し(チャンネルの音色指定)。選択肢は実際に効く載せ先の種別で変わる
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  let rootEl = null, bodyEl = null, footEl = null, filterEl = null;
  let hooks = {};
  let rows = [];
  let filterCh = null;
  let demotions = [];   // [{key, preset, label}]
  let sortMode = 'count'; // 'count' | 'first'

  const TS = () => MML.Convert && MML.Convert.ToneSettings;
  const Plan = () => MML.Convert && MML.Convert.ChannelPlan;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 音色の種別 → 借用先候補を引くための元ch種別(channelPlan.js KIND_TARGETS の語彙)
  const SRC_KIND = { brr: 'brr', pcm: 'pcm', opn: 'fm4', opll: 'fm', wave: 'wave', duty: 'square', sq: 'square' };
  function srcKindOf(row) { return SRC_KIND[row.kind] || 'any'; }

  /** 行の「効いている載せ先」: 上書きがあればそれ、無ければ使用chの借用先(複数なら先頭) */
  function effectiveTarget(row, st) {
    if (st && st.target) return st.target;
    const c = (row.chans || []).find(x => x.target && x.target !== 'skip');
    return c ? c.target : ((row.chans || [])[0] || {}).target || 'skip';
  }

  // ── アイコン(波形/FM/サンプル) ─────────────────────────────────────
  function drawIcon(canvas, row) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const color = row.color || '#8ab4ff';
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    const mid = H / 2, amp = H / 2 - 2;
    const info = row.info || {};
    let wave = null; // 0..15 or ±1
    const TD = MML.Convert && MML.Convert.ToneDerive;
    if (info.wave) wave = info.wave.map(v => v / 7.5 - 1);
    else if (row.kind === 'opn' && info.patch && TD) wave = TD.opnSteadyWave(info.patch);
    else if (row.kind === 'opll' && TD) {
      let bytes = info.bytes;
      if (!bytes && info.inst > 0 && MML.Emu && MML.Emu.OPLLNuked && MML.Emu.OPLLNuked.presetBytes) bytes = MML.Emu.OPLLNuked.presetBytes('ym2413', info.inst);
      if (bytes) wave = TD.opllSteadyWave(bytes);
    } else if (row.kind === 'duty' || row.kind === 'sq') {
      const d = row.kind === 'duty' ? [0.125, 0.25, 0.5, 0.75][info.duty & 3] : 0.5;
      wave = Array.from({ length: 32 }, (_, i) => (i / 32 < d ? 1 : -1));
    }
    if (!wave || !wave.length) {
      // サンプル(PCM/BRR): 中央に破線
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(2, mid); ctx.lineTo(W - 2, mid); ctx.stroke(); ctx.setLineDash([]);
      if (row.pcm && row.pcm.length) {
        // 実PCMの外形(先頭〜2000サンプル)を薄く
        ctx.strokeStyle = color; ctx.globalAlpha = 0.8; ctx.beginPath();
        const n = Math.min(row.pcm.length, 4000);
        for (let x = 0; x < W; x++) {
          const i = Math.floor(x * n / W);
          const y = mid - Math.max(-1, Math.min(1, row.pcm[i] || 0)) * amp;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
      return;
    }
    ctx.beginPath();
    const n = wave.length;
    for (let x = 0; x <= W; x++) {
      const p = ((x / W) * 2) % 1; // 2周期
      const v = wave[Math.floor(p * n) % n];
      const y = mid - Math.max(-1, Math.min(1, v)) * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function kindLabel(row) {
    const info = row.info || {};
    switch (row.kind) {
      case 'brr': return 'BRR';
      case 'pcm': return 'PCM';
      case 'opn': return 'FM 4op';
      case 'opll': return info.inst > 0 ? ('OPLL @' + info.inst) : 'OPLL @0';
      case 'wave': return T('波形');
      case 'duty': return T('デューティ {n}', { n: info.duty | 0 });
      case 'sq': return T('矩形波');
      default: return row.kind || '';
    }
  }

  function mount(el, h) {
    rootEl = el; hooks = h || {};
    if (!rootEl) return;
    rootEl.innerHTML =
      `<div class="tone-panel">` +
        `<div class="tone-panel-bar">` +
          `<span class="tp-filter"></span>` +
          `<label class="tp-sort">${T('並び')} <select class="tp-sort-sel">` +
            `<option value="count">${T('回数の多い順')}</option><option value="first">${T('初出順')}</option></select></label>` +
        `</div>` +
        `<div class="tone-panel-head">` +
          `<span class="tp-c-icon"></span>` +
          `<span class="tp-c-label">${T('音色')}</span>` +
          `<span class="tp-c-chans">${T('使用ch')}</span>` +
          `<span class="tp-c-count">${T('回数')}</span>` +
          `<span class="tp-c-play"><i>${T('元の音')}</i><i>${T('変換後')}</i></span>` +
          `<span class="tp-c-target">${T('載せ先')}</span>` +
          `<span class="tp-c-tone">${T('音色指定')}</span>` +
          `<span class="tp-c-note"></span>` +
        `</div>` +
        `<div class="tone-panel-body"></div>` +
        `<div class="tone-panel-foot"></div>` +
      `</div>`;
    bodyEl = rootEl.querySelector('.tone-panel-body');
    footEl = rootEl.querySelector('.tone-panel-foot');
    filterEl = rootEl.querySelector('.tp-filter');
    const sortSel = rootEl.querySelector('.tp-sort-sel');
    sortSel.value = sortMode;
    sortSel.addEventListener('change', () => { sortMode = sortSel.value; render(); });
    sortSel.addEventListener('mousedown', (e) => e.stopPropagation());
    if (TS() && TS().onChange) TS().onChange(() => render());
    render();
  }

  function setRows(next) { rows = Array.isArray(next) ? next : []; render(); }
  function setFilter(chId) { filterCh = chId || null; render(); }
  function setDemotions(list) { demotions = Array.isArray(list) ? list : []; render(); }
  function getFilter() { return filterCh; }

  function optionEls(sel, opts, value) {
    sel.innerHTML = '';
    for (const [v, label, tint] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if (tint) o.style.backgroundColor = tint;
      sel.appendChild(o);
    }
    sel.value = value;
  }
  function tintOf(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},0.18)` : '';
  }

  function render() {
    if (!bodyEl) return;
    const P = Plan(), S = TS();
    // フィルタ表示
    if (filterEl) {
      filterEl.innerHTML = '';
      if (filterCh) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'tp-filter-chip';
        b.textContent = T('{ch} の音色だけ表示', { ch: filterCh }) + ' ×';
        b.title = T('クリックで全チャンネルの音色を表示');
        b.addEventListener('click', () => setFilter(null));
        filterEl.appendChild(b);
      } else {
        filterEl.textContent = T('全チャンネルの音色');
      }
    }
    let list = rows.filter(r => !filterCh || (r.chans || []).some(c => c.id === filterCh));
    list = list.slice().sort((a, b) => sortMode === 'count' ? (b.count - a.count) || (a.first - b.first) : (a.first - b.first));
    bodyEl.innerHTML = '';
    if (!list.length) {
      bodyEl.innerHTML = `<div class="tone-panel-empty">${T('音色がありません。曲を再生してロールができると、使われている音色がここに並びます(NSFは一覧のみ。音色ごとの指定は借用変換の形式で使えます)。')}</div>`;
      if (footEl) footEl.textContent = '';
      return;
    }
    const demoteOf = {};
    for (const d of demotions) demoteOf[d.key] = d;
    const editable = !!(hooks.editable ? hooks.editable() : true);
    for (const r of list) {
      const st = S ? S.get(r.key) : { name: null, tone: null, target: null };
      const row = document.createElement('div');
      row.className = 'tone-panel-row' + ((st.tone || st.target) ? ' tone-panel-row--custom' : '');
      const chanText = (r.chans || []).map(c => (c.letter ? c.letter + ':' : '') + c.id).join(' ');
      row.innerHTML =
        `<span class="tp-c-icon"><canvas width="44" height="18" title="${esc(kindLabel(r))}"></canvas></span>` +
        `<span class="tp-c-label"><input type="text" class="tp-name" value="${esc(st.name || '')}" placeholder="${esc(r.label || r.key)}" title="${esc(r.key)}"><i class="tp-kind">${esc(kindLabel(r))}</i></span>` +
        `<span class="tp-c-chans" title="${esc(chanText)}">${esc(chanText)}</span>` +
        `<span class="tp-c-count">${r.count != null ? r.count : ''}</span>` +
        `<span class="tp-c-play">` +
          `<button type="button" class="tp-play" data-mode="raw" title="${T('元の音を鳴らす')}">♪</button>` +
          `<button type="button" class="tp-play" data-mode="mml" title="${T('いまの指定で変換した音を鳴らす(MMLにしてNSF音源で再生)')}">♪</button>` +
        `</span>` +
        `<span class="tp-c-target"><select class="tp-target"></select></span>` +
        `<span class="tp-c-tone"><select class="tp-tone"></select></span>` +
        `<span class="tp-c-note"></span>`;
      const cv = row.querySelector('canvas');
      try { drawIcon(cv, r); } catch (e) { /* 描けなくても行は出す */ }

      // 名前
      const nameEl = row.querySelector('.tp-name');
      nameEl.addEventListener('change', () => { if (S) S.set(r.key, { name: nameEl.value.trim() || null }); if (hooks.onChange) hooks.onChange(r); });
      nameEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameEl.blur(); });
      nameEl.addEventListener('mousedown', (e) => e.stopPropagation());

      // 載せ先: 「chに従う」+ この音色の種別で選べる借用先
      const tgtSel = row.querySelector('.tp-target');
      const eff = effectiveTarget(r, st);
      const cands = P ? P.targetsForKind(srcKindOf(r)) : [];
      const chTargetLabel = (r.chans || []).length
        ? T('chに従う({t})', { t: P ? P.targetLabel(effectiveTarget(r, null)) : effectiveTarget(r, null) })
        : T('chに従う');
      const tOpts = [['', chTargetLabel]];
      for (const t of cands) tOpts.push([t, (P ? P.targetLabel(t) : t) + ((t === 'dpcm' && (r.kind === 'brr' || r.kind === 'pcm')) ? T('(打楽器として)') : ''), P && P.colorOfTarget ? tintOf(P.colorOfTarget(t)) : '']);
      optionEls(tgtSel, tOpts, st.target || '');
      tgtSel.disabled = !editable;
      tgtSel.addEventListener('change', () => {
        if (S) S.set(r.key, { target: tgtSel.value || null });
        if (hooks.onChange) hooks.onChange(r);
      });
      tgtSel.addEventListener('mousedown', (e) => e.stopPropagation());

      // 音色指定: 効いている載せ先の種別で選択肢が変わる
      const toneSel = row.querySelector('.tp-tone');
      const toneKind = P && P.toneKindOfTarget ? P.toneKindOfTarget(eff, srcKindOf(r)) : null;
      if (!toneKind) {
        toneSel.style.display = 'none';
        const sp = document.createElement('span'); sp.className = 'tp-tone-none';
        sp.textContent = eff === 'skip' ? '' : T('(音色の選択なし)');
        toneSel.parentNode.appendChild(sp);
      } else {
        const to = P.toneOptionsFor(toneKind, srcKindOf(r));
        const cur = (st.tone && st.tone[toneKind] !== undefined) ? st.tone[toneKind] : '';
        const chToneLabel = T('chに従う');
        optionEls(toneSel, [['', chToneLabel]].concat(to.opts.map(p => [p[0], p[1]])), cur);
        toneSel.disabled = !editable;
        toneSel.addEventListener('change', () => {
          if (S) S.setTone(r.key, toneKind, toneSel.value || null);
          if (hooks.onChange) hooks.onChange(r);
        });
        toneSel.addEventListener('mousedown', (e) => e.stopPropagation());
        // 波形メモリ音源へ音符ごとに波形を切り替えるコストの注意(FDSは書き換え中に止まる)
        if (toneKind === 'wave' && /^fds$/.test(eff)) toneSel.title = T('FDSは波形の書き換え中に音が止まるため、音色が切り替わる所でプチノイズが乗ることもあります');
      }

      // 注記: VRC7自作音色があぶれてプリセットへ落ちた / 設定済みの印
      const noteEl = row.querySelector('.tp-c-note');
      const dm = demoteOf[r.key];
      if (dm && P) {
        const names = (MML.Convert.Vrc7Tone && MML.Convert.Vrc7Tone.PRESET_NAMES) || [];
        noteEl.textContent = T('→ @{n} {name} へ', { n: dm.preset, name: names[dm.preset] || '' });
        noteEl.title = T('VRC7の自作音色(@0)はチップ全体で1音色しか同時に持てないため、直前の変換ではこの音色はいちばん近い内蔵音色へ置き換わりました。載せ先か音色指定を変えると解消します');
        noteEl.classList.add('tp-c-note--warn');
      }
      if (st.tone || st.target) {
        const clr = document.createElement('button');
        clr.type = 'button'; clr.className = 'tp-clear'; clr.textContent = '↺';
        clr.title = T('この音色の指定を消す(chに従う)');
        clr.addEventListener('click', () => { if (S) S.set(r.key, { tone: null, target: null }); if (S && S.clear && !st.name) S.clear(r.key); if (hooks.onChange) hooks.onChange(r); });
        noteEl.appendChild(clr);
      }
      for (const b of row.querySelectorAll('.tp-play')) {
        b.addEventListener('click', () => { if (hooks.onPlay) hooks.onPlay(r, b.dataset.mode, { target: eff, toneKind, st }); });
      }
      bodyEl.appendChild(row);
    }
    if (footEl) {
      const n = list.filter(r => { const st = S ? S.get(r.key) : null; return st && (st.tone || st.target); }).length;
      footEl.textContent = T('音色 {total} 件 / 指定あり {n} 件。指定は音色の内容(ハッシュ)ごとに保存され、同じ音色なら別の曲でも効きます', { total: list.length, n });
    }
  }

  UI.TonePanel = { mount, setRows, setFilter, getFilter, setDemotions, render };
})(window);
