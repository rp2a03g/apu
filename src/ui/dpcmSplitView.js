/*
 * DPCM 分割ビュー(部品)
 * MML.UI.DpcmSplitView
 *
 * 「1本のサンプルを DMC の上限(4080バイト)以下の区間に切って、区間ごとに 番号/使用/DMCレート を持たせ、
 * 聞きながら境目を決める」ためのUI部品。DPCMコンバータ(src/ui/dpcmEditor.js)の下段と、
 * ドラム(DPCM)パネル(src/ui/drumPanel.js)の下段で同じものを使う(2026-09-10 に部品化)。
 *
 *   上段 = オリジナル(変換元。ボリューム込み)、下段 = DPCM(区間ごとにそのレートで焼いて復号した音)
 *   ・境目をドラッグ(上限で拘束しない=超えた区間は赤)、波形をダブルクリックで区切り追加、
 *     境目をダブルクリックで削除、区間の ✕ で前と結合、「限界で分割」で上限に収まる本数へ均等割り
 *   ・区間クリックでその区間だけ試聴(上段=原音 / 下段=DPCM)、番号クリックも同じ
 *   ・再生位置線は両レーンにまたがる
 *
 * 状態(L、ホストが持つ): { pcm, srcRate, dmc, dac, rate, vol, segs:[{end, rate, used}], pieces:[], previewPcm, previewKey }
 *   pcm/srcRate … 変換元のPCM(-1..1)とレート。無ければ dmc(1bit化済みの生データ、変換なし)
 *   rate      … 行のDMCレート(0-15)。segs[k].rate が null の区間はこれに従う(パネルの「自動」)
 *   vol       … 変換ボリューム(1-100)。previewPcm(=上段/原音試聴/焼く音)に掛かる
 *   segs      … 区間 [{end, rate, used}]。end=区間の終わり(全体に対する割合 0-1、最後は1)
 *   pieces    … 区間ごとの変換結果キャッシュ [{bytes, sampleCount, dac}|null]
 * ホストは L を渡し、変更は opts.onChange(L) で受け取る(dirty印や保存はホスト側)。
 *
 * model(純粋関数群)も公開する。区間の計算は共通層 src/convert/drumHits.js の自動分割と同じ規約
 * (encode() のリサンプルと同じ丸め、.dmc は16バイト境界)なので、ここで見た区間サイズと変換結果が一致する。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  const HW_MAX_BYTES = 4081;            // 実機 $4013=255 → 255*16+1
  const MAX_BYTES = 4080;               // encode() の出力は16バイト単位なのでここが実質上限
  const MAX_SAMPLES = MAX_BYTES * 8;    // 32640
  const SNAP_SAMPLES = 128;             // .dmc を分割するときの粒度(16バイト)
  const LANE_H = 96;                    // 波形キャンバスの1レーン(上=オリジナル/下=DPCM)の高さ
  const LANE_GAP = 10;

  function rateTable() { return (MML.Dpcm && MML.Dpcm.DMC_RATE_TABLE_NTSC) || []; }
  function rateHz(i) { return rateTable()[i] || 33143.9; }
  function bytesForSamples(n) { return Math.ceil(n / 8 / 16) * 16 || 16; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmtTime(sec) { return (sec >= 10 ? sec.toFixed(1) : sec.toFixed(2)) + 's'; }
  /** 変換ボリューム(%)を 1〜100 に丸める(0は「鳴らさない」と紛らわしいので下限1) */
  function clampVol(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 100;
  }
  function rateOptions() {
    const table = rateTable();
    const opts = [];
    for (let i = table.length - 1; i >= 0; i--) opts.push([String(i), (table[i] / 1000).toFixed(1) + 'kHz']);
    return opts;
  }
  // withAuto: 先頭に「自動」(value 'auto' = 行のレートに従う)を足す
  function fillRateSelect(sel, value, withAuto, autoLabel) {
    if (withAuto) {
      const o = document.createElement('option');
      o.value = 'auto'; o.textContent = autoLabel || T('自動');
      sel.appendChild(o);
    }
    for (const [v, label] of rateOptions()) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = value == null ? 'auto' : String(value);
  }

  // ── 区間の計算(純粋関数) ────────────────────────────────────────────────
  function hasData(L) { return !!(L && (L.pcm || L.dmc)); }
  function isDmcRow(L) { return !L.pcm && !!L.dmc; }
  /** 全体の長さ(元データのサンプル数。PCM=元のレート、.dmc=DMCサンプル) */
  function srcLength(L) { return L.pcm ? L.pcm.length : (L.dmc ? L.dmc.length * 8 : 0); }
  function segStart(L, k) { return k > 0 ? L.segs[k - 1].end : 0; }
  function segRange(L, k) { return [segStart(L, k), L.segs[k].end]; }
  /** 区間のDMCレート(区間指定が無ければ行のレート) */
  function segRate(L, k) { const r = L.segs[k].rate; return (r == null || r === 'auto') ? L.rate : (r | 0); }
  /** 区間のDMCサンプル数(encode() のリサンプルと同じ丸め) */
  function segSamples(L, k) {
    const [t0, t1] = segRange(L, k);
    const N = srcLength(L);
    const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
    if (L.pcm) return Math.max(1, Math.round((b - a) * rateHz(segRate(L, k)) / L.srcRate));
    return b - a;
  }
  function segBytes(L, k) {
    const p = L.pieces[k];
    return p ? p.bytes.length : bytesForSamples(segSamples(L, k));
  }
  function segSeconds(L, k) { return segSamples(L, k) / rateHz(segRate(L, k)); }
  function segOver(L, k) { return segBytes(L, k) > MAX_BYTES; }
  /** .dmc の区切りは16バイト境界へ吸着する(1バイト=8サンプルの生データを切るため) */
  function snapFrac(L, t) {
    const N = srcLength(L);
    if (!N) return t;
    if (isDmcRow(L)) return clamp(Math.round(t * N / SNAP_SAMPLES) * SNAP_SAMPLES / N, 0, 1);
    return clamp(t, 0, 1);
  }
  function resetSegs(L, rate) { L.segs = [{ end: 1, rate: rate === undefined ? L.rate : rate, used: true }]; L.pieces = [null]; }
  function invalidateAll(L) { L.pieces = L.segs.map(() => null); }
  /** 均等K分割の区間列(rate は全区間同じ値=null なら行に従う) */
  function evenSegs(L, K, rate) {
    const out = [];
    for (let k = 1; k <= K; k++) out.push({ end: k === K ? 1 : snapFrac(L, k / K), rate: rate === undefined ? null : rate, used: true });
    return out;
  }
  /** 1本で収まらないとき、上限に収まる本数(共通層の自動分割と同じ計算) */
  function requiredPieces(L) {
    if (!hasData(L)) return 1;
    const N = L.pcm ? Math.round(L.pcm.length * rateHz(L.rate) / L.srcRate) : L.dmc.length * 8;
    return Math.max(1, Math.ceil(N / MAX_SAMPLES));
  }
  /** 区間kを割合tで2つに切る(番号は後ろへずれる) */
  function splitAt(L, k, t) {
    const [t0, t1] = segRange(L, k);
    const minF = SNAP_SAMPLES / Math.max(1, srcLength(L));
    t = snapFrac(L, t);
    if (t <= t0 + minF || t >= t1 - minF) return false;
    const s = L.segs[k];
    L.segs.splice(k, 0, { end: t, rate: s.rate, used: s.used });
    L.pieces.splice(k, 0, null);
    L.pieces[k + 1] = null;
    return true;
  }
  /** 区間kを前の区間と結合する(レートと使用は前の区間の値を引き継ぐ) */
  function mergeWithPrev(L, k) {
    if (k <= 0) return false;
    const prev = L.segs[k - 1];
    L.segs.splice(k - 1, 2, { end: L.segs[k].end, rate: prev.rate, used: prev.used || L.segs[k].used });
    L.pieces.splice(k - 1, 2, null);
    return true;
  }
  /** 上限を超えている使用区間を、そのレートで上限に収まる本数へ均等に切る */
  function autoCut(L) {
    let cut = 0;
    for (let k = 0; k < L.segs.length; k++) {
      const s = L.segs[k];
      if (!s.used || !segOver(L, k)) continue;
      const n = Math.ceil(segSamples(L, k) / MAX_SAMPLES);
      const [t0, t1] = segRange(L, k);
      const parts = [];
      for (let i = 1; i < n; i++) parts.push({ end: snapFrac(L, t0 + (t1 - t0) * i / n), rate: s.rate, used: s.used });
      parts.push(s);
      L.segs.splice(k, 1, ...parts);
      L.pieces.splice(k, 1, ...parts.map(() => null));
      k += parts.length - 1;
      cut++;
    }
    return cut;
  }
  function dac0(L) { return (L.dac == null || L.dac === 255) ? 64 : (L.dac & 0x7F); }
  /** 区間kを焼く。PCMは previewPcm(ボリューム込み)から、.dmc は生データを16バイト境界で切る */
  function encodeSeg(L, k) {
    const [t0, t1] = segRange(L, k);
    if (L.pcm) {
      const src = previewPcm(L);
      const N = src.length;
      const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
      const seg = src.subarray(a, b);
      // 先頭サンプル値を$4011初期値にすると頭の追従ランプ(クリック)が消える(drumHits.js と同じ)
      const dac = clamp(Math.round((seg[0] + 1) / 2 * 127), 0, 127);
      const r = MML.Dpcm.encode(seg, L.srcRate, segRate(L, k), { startCounter: dac });
      return { bytes: r.bytes, sampleCount: r.sampleCount, dac: r.startCounter };
    }
    const N = L.dmc.length * 8;
    const a = Math.round(t0 * N), b = Math.max(a + SNAP_SAMPLES, Math.round(t1 * N));
    let dac = dac0(L);
    if (a > 0) {
      // 区間の頭のDAC値 = 直前までを復号したときのカウンタ(復号値からカウンタへ戻す。厳密に可逆)
      const dec = MML.Dpcm.decode(L.dmc, a, dac);
      dac = clamp(Math.round((dec[a - 1] + 1) / 2 * 127), 0, 127);
    }
    const bytes = L.dmc.slice(a >> 3, Math.min(L.dmc.length, b >> 3));
    return { bytes, sampleCount: bytes.length * 8, dac };
  }
  function ensurePiece(L, k) {
    if (!L.pieces[k]) L.pieces[k] = encodeSeg(L, k);
    return L.pieces[k];
  }
  function decodePiece(p) { return MML.Dpcm.decode(p.bytes, p.sampleCount, p.dac); }
  /**
   * 上段(オリジナル)の波形 = 「いまの設定で変換元として使われる音」。PCMはボリュームを掛けた後、
   * .dmc は復号した音(既に1bit化済みなので掛けようがない)。割合表示なのでレートが変わっても形は同じ。
   * encodeSeg もここを変換元にする(表示・試聴・焼く音が必ず一致する)
   */
  function previewPcm(L) {
    const key = L.pcm ? ('pcm:' + L.vol) : ('dmc:' + dac0(L));
    if (L.previewPcm && L.previewKey === key) return L.previewPcm;
    if (L.pcm) {
      const g = clampVol(L.vol) / 100;
      if (g === 1) L.previewPcm = L.pcm;
      else {
        const out = new Float32Array(L.pcm.length);
        for (let i = 0; i < out.length; i++) out[i] = L.pcm[i] * g;
        L.previewPcm = out;
      }
    } else if (L.dmc) L.previewPcm = MML.Dpcm.decode(L.dmc, L.dmc.length * 8, dac0(L));
    else L.previewPcm = null;
    L.previewKey = key;
    return L.previewPcm;
  }
  function usedSegs(L) { return L.segs.map((s, k) => k).filter(k => L.segs[k].used); }
  function totalUsedBytes(L) { return usedSegs(L).reduce((s, k) => s + segBytes(L, k), 0); }
  function totalSeconds(L) { return L.segs.reduce((s, _, k) => s + segSeconds(L, k), 0); }

  const model = {
    HW_MAX_BYTES, MAX_BYTES, MAX_SAMPLES, SNAP_SAMPLES,
    rateTable, rateHz, bytesForSamples, clamp, fmtTime, clampVol, rateOptions, fillRateSelect,
    hasData, isDmcRow, srcLength, segStart, segRange, segRate, segSamples, segBytes, segSeconds, segOver, snapFrac,
    resetSegs, invalidateAll, evenSegs, requiredPieces, splitAt, mergeWithPrev, autoCut, dac0,
    encodeSeg, ensurePiece, decodePiece, previewPcm, usedSegs, totalUsedBytes, totalSeconds,
  };

  // ── ビュー ─────────────────────────────────────────────────────────────
  /**
   * @param {HTMLElement} container 中身を組み立てる要素(innerHTML を置き換える)
   * @param {object} opts
   *   onChange(L)         … 区間を変えた(境目/分割/結合/使用/レート)。ホストは dirty 印・保存・再描画をする
   *   onStatus(text, cls) … 「限界で分割」等の一言(省略可)
   *   title(L)            … 左上の見出し(省略可)
   *   emptyText()         … L が無い/データが無いときの見出し(省略可)
   *   rateAuto            … 区間のレート選択に「自動(行のレート)」を出す(パネル用)
   *   autoLabel           … その表示名(省略時 T('自動'))
   */
  function create(container, opts) {
    opts = opts || {};
    const v = {
      L: null, playing: null, rafId: 0, audioCtx: null,
      dragIdx: -1, dragMoved: false, downX: 0, destroyed: false,
    };
    container.innerHTML =
      `<div class="toolbar dpcm-ed-wave-bar">` +
        `<span class="dpcm-ed-wave-title"></span>` +
        `<button type="button" class="secondary dpcm-ed-autocut" title="${T('上限を超えている区間を、そのDMCレートで上限に収まる本数に均等に切ります。あとは境目をドラッグして調整してください')}">${T('限界で分割')}</button>` +
        `<button type="button" class="dpcm-ed-play-raw" title="${T('原音を鳴らす')}">▶ <span>${T('原音')}</span></button>` + // 文言だけを独立したノードにして、言語切替で i18nDom が訳し直せるようにする
        `<button type="button" class="dpcm-ed-play-dpcm" title="${T('DPCM変換後を鳴らす(使用区間を順に)')}">▶ DPCM</button>` +
        `<button type="button" class="secondary dpcm-ed-stop" title="${T('停止')}">■</button>` +
        `<span class="dpcm-ed-wave-info"></span>` +
      `</div>` +
      `<canvas class="dpcm-ed-canvas" width="600" height="${LANE_H * 2 + LANE_GAP}" title="${T('境目をドラッグ / 波形をダブルクリックで区切りを追加・境目をダブルクリックで削除 / 上段(オリジナル)クリックで原音・下段(DPCM)クリックで変換後を区間試聴')}"></canvas>` +
      `<div class="dpcm-ed-segs"></div>`;
    const titleEl = container.querySelector('.dpcm-ed-wave-title');
    const infoEl = container.querySelector('.dpcm-ed-wave-info');
    const autoCutBtn = container.querySelector('.dpcm-ed-autocut');
    const canvas = container.querySelector('.dpcm-ed-canvas');
    const segsEl = container.querySelector('.dpcm-ed-segs');

    const status = (text, cls) => { if (opts.onStatus) opts.onStatus(text, cls); };
    const changed = () => { if (v.L && opts.onChange) opts.onChange(v.L); render(); };
    const live = () => (v.L && hasData(v.L)) ? v.L : null;

    // ── 試聴 ─────────────────────────────────────────────────────────────
    function ensureAudio() {
      if (!v.audioCtx) v.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (v.audioCtx.state === 'suspended') v.audioCtx.resume();
    }
    function stop() {
      if (v.playing) { for (const s of v.playing.srcs) { try { s.stop(); } catch (e) { /* ignore */ } } v.playing = null; }
      if (v.rafId) { cancelAnimationFrame(v.rafId); v.rafId = 0; }
      if (!v.destroyed) drawWave();
    }
    // AudioBufferのサンプルレートには下限があるので、DMCレートのままでは作れない。
    // コンテキストのレートへ線形補間で伸ばしてから鳴らす(main.js playFloatPcm と同じ)
    function makeBuffer(pcm, hz) {
      const ctxRate = v.audioCtx.sampleRate;
      const n = Math.max(1, Math.round(pcm.length * ctxRate / hz));
      const buf = v.audioCtx.createBuffer(1, n, ctxRate);
      const out = buf.getChannelData(0);
      const step = hz / ctxRate;
      let pos = 0;
      for (let i = 0; i < n; i++) {
        const idx = pos | 0;
        const a = pcm[Math.min(idx, pcm.length - 1)], b = pcm[Math.min(idx + 1, pcm.length - 1)];
        out[i] = a + (b - a) * (pos - idx);
        pos += step;
      }
      return buf;
    }
    /** items: [{pcm, hz, t0, t1}] を順に鳴らす(区間ごとにレートが違ってもよい)。t0/t1 は再生位置線用の割合 */
    function playSequence(items) {
      items = (items || []).filter(it => it.pcm && it.pcm.length && it.hz > 0);
      if (!items.length) return;
      ensureAudio();
      stop();
      const dest = (MML.Audio && MML.Audio.getMasterGain) ? MML.Audio.getMasterGain(v.audioCtx) : v.audioCtx.destination;
      const g = v.audioCtx.createGain();
      g.gain.value = 0.9;
      g.connect(dest);
      const startAt = v.audioCtx.currentTime + 0.02;
      const srcs = [], sched = [];
      let at = 0;
      for (const it of items) {
        const buf = makeBuffer(it.pcm, it.hz);
        const src = v.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(g);
        src.start(startAt + at);
        srcs.push(src);
        sched.push({ at, dur: buf.duration, t0: it.t0 || 0, t1: it.t1 == null ? 1 : it.t1 });
        at += buf.duration;
      }
      v.playing = { srcs, startAt, items: sched, total: at };
      srcs[srcs.length - 1].onended = () => { if (v.playing && v.playing.srcs === srcs) { v.playing = null; if (!v.destroyed) drawWave(); } };
      tick();
    }
    function tick() {
      v.rafId = 0;
      if (!v.playing || v.destroyed) return;
      drawWave();
      v.rafId = requestAnimationFrame(tick);
    }
    function playheadFrac() {
      if (!v.playing || !v.audioCtx) return null;
      const el = v.audioCtx.currentTime - v.playing.startAt;
      if (el < 0) return v.playing.items[0].t0;
      for (const it of v.playing.items) {
        if (el < it.at + it.dur) return it.t0 + clamp((el - it.at) / it.dur, 0, 1) * (it.t1 - it.t0);
      }
      return null;
    }
    function playRaw() {
      const L = live();
      if (!L) return;
      // 原音側にもボリュームを掛ける(previewPcm)。「元のPCM」ではなく「いまの設定で変換元として使われる音」
      playSequence([{ pcm: previewPcm(L), hz: L.pcm ? L.srcRate : rateHz(L.rate), t0: 0, t1: 1 }]);
    }
    function playDpcm() {
      const L = live();
      if (!L) return;
      // 使用区間を順に(未使用は飛ばす=変換後に鳴る形)
      playSequence(usedSegs(L).map(k => {
        const [t0, t1] = segRange(L, k);
        return { pcm: decodePiece(ensurePiece(L, k)), hz: rateHz(segRate(L, k)), t0, t1 };
      }));
    }
    /** 区間kの試聴。lane='raw' なら上段(オリジナル)、それ以外は下段(DPCM変換後) */
    function playSeg(k, lane) {
      const L = live();
      if (!L || !L.segs[k]) return;
      const [t0, t1] = segRange(L, k);
      if (lane === 'raw') {
        const src = previewPcm(L);
        if (!src) return;
        const N = src.length;
        const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
        playSequence([{ pcm: src.subarray(a, b), hz: L.pcm ? L.srcRate : rateHz(segRate(L, k)), t0, t1 }]);
        return;
      }
      playSequence([{ pcm: decodePiece(ensurePiece(L, k)), hz: rateHz(segRate(L, k)), t0, t1 }]);
    }

    // ── 描画 ─────────────────────────────────────────────────────────────
    function render() {
      const L = live();
      container.classList.toggle('dpcm-ed-wave--empty', !L);
      segsEl.innerHTML = '';
      if (!L) {
        titleEl.textContent = opts.emptyText ? (opts.emptyText(v.L) || '') : '';
        infoEl.textContent = '';
        autoCutBtn.disabled = true;
        drawWave();
        return;
      }
      titleEl.textContent = opts.title ? (opts.title(L) || '') : '';
      // 使用区間の変換をここでまとめて行う(ドラッグ中は捨ててあり、止めた時のこの描画で下段のDPCM波形が出る)
      for (const k of usedSegs(L)) ensurePiece(L, k);
      autoCutBtn.disabled = !usedSegs(L).some(k => segOver(L, k));
      infoEl.textContent = T('{n}区間 {t} / 1本の上限 {max}バイト(={tmax} @{hz}Hz)', { n: L.segs.length, t: fmtTime(totalSeconds(L)), max: HW_MAX_BYTES, tmax: fmtTime(MAX_SAMPLES / rateHz(L.rate)), hz: rateHz(L.rate).toFixed(0) });
      // 区間の一覧: 番号 / 使用 / レート / サイズ / 結合
      L.segs.forEach((s, k) => {
        const over = segOver(L, k);
        const el = document.createElement('div');
        el.className = 'de-seg' + (s.used ? '' : ' de-seg--unused') + (over && s.used ? ' de-seg--over' : '');
        el.innerHTML =
          `<b class="de-seg-no" title="${T('この区間を試聴')}">${k + 1}</b>` +
          `<label class="de-seg-used-lab" title="${T('反映に含める(外すとグレーになり、.dmcも定義も作られません)')}"><input type="checkbox" class="de-seg-used"${s.used ? ' checked' : ''}>${T('使用')}</label>` +
          `<select class="de-seg-rate" title="${T('この区間のDMCレート')}"></select>` +
          `<span class="de-seg-size">${segBytes(L, k)}B ${fmtTime(segSeconds(L, k))}</span>` +
          (k > 0 ? `<button type="button" class="secondary de-seg-merge" title="${T('前の区間と結合')}">✕</button>` : '');
        const rateSel = el.querySelector('.de-seg-rate');
        fillRateSelect(rateSel, opts.rateAuto ? s.rate : segRate(L, k), !!opts.rateAuto, opts.autoLabel);
        rateSel.addEventListener('change', (e) => {
          s.rate = e.target.value === 'auto' ? null : (parseInt(e.target.value, 10) | 0);
          L.pieces[k] = null;
          changed();
        });
        el.querySelector('.de-seg-used').addEventListener('change', (e) => { s.used = e.target.checked; changed(); });
        const mg = el.querySelector('.de-seg-merge');
        if (mg) mg.addEventListener('click', () => { if (mergeWithPrev(L, k)) changed(); });
        el.querySelector('.de-seg-no').addEventListener('click', () => playSeg(k));
        for (const c of el.querySelectorAll('input, select, button')) c.addEventListener('mousedown', (e) => e.stopPropagation());
        segsEl.appendChild(el);
      });
      drawWave();
    }
    function fitCanvas() {
      const w = Math.max(200, Math.floor(container.clientWidth) - 2);
      if (canvas.width !== w) canvas.width = w;
    }
    // 1レーンぶんの波形(列ごとの最小/最大)を [x0,x1) に描く。pcm はそのレーンの区間ぶん
    function drawLane(ctx, pcm, x0, x1, top, h, color) {
      if (!pcm || !pcm.length || x1 <= x0) return;
      const mid = top + h / 2, amp = h / 2 - 2;
      const per = pcm.length / (x1 - x0);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x < x1; x++) {
        const a = Math.floor((x - x0) * per), e = Math.max(a + 1, Math.floor((x - x0 + 1) * per));
        let lo = 1, hi = -1;
        for (let i = a; i < e && i < pcm.length; i++) { const val = pcm[i]; if (val < lo) lo = val; if (val > hi) hi = val; }
        if (lo > hi) continue;
        ctx.moveTo(x + 0.5, mid - hi * amp);
        ctx.lineTo(x + 0.5, mid - lo * amp + 1);
      }
      ctx.stroke();
    }
    function drawWave() {
      if (v.destroyed) return;
      const L = live();
      const ctx = canvas.getContext('2d');
      fitCanvas();
      const w = canvas.width, h = canvas.height;
      const topA = 0, topB = LANE_H + LANE_GAP;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#6a6a78';
      ctx.fillText(T('オリジナル'), 4, topA + 2);
      ctx.fillText('DPCM', 4, topB + 2);
      if (!L) return;
      const pcm = previewPcm(L);
      if (!pcm || !pcm.length) return;
      const N = pcm.length;
      for (let k = 0; k < L.segs.length; k++) {
        const s = L.segs[k];
        const [t0, t1] = segRange(L, k);
        const x0 = Math.round(t0 * w), x1 = Math.max(x0 + 1, Math.round(t1 * w));
        const over = s.used && segOver(L, k);
        // 区間の背景: 未使用=グレー / 上限超え=赤 / それ以外は交互
        ctx.fillStyle = !s.used ? 'rgba(128,128,136,0.22)' : over ? 'rgba(209,72,58,0.28)' : (k & 1 ? 'rgba(111,177,255,0.10)' : 'rgba(111,177,255,0.04)');
        ctx.fillRect(x0, 0, x1 - x0, h);
        // 上: オリジナル(暗めの色。上に重ねる区間番号/サイズの文字が波形に埋もれないため。未使用はさらに暗く)
        const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
        drawLane(ctx, pcm.subarray(a, b), x0, x1, topA, LANE_H, s.used ? '#2f5680' : '#3b3e4a');
        // 下: DPCM(変換済みの区間だけ。ドラッグ中は捨ててあるので描かない=止めた時に出る)
        if (s.used && L.pieces[k]) drawLane(ctx, decodePiece(L.pieces[k]), x0, x1, topB, LANE_H, over ? '#ff8a7a' : '#8ad48a');
        const label = `${segBytes(L, k)}B ${fmtTime(segSeconds(L, k))}` + (s.used ? '' : ' ' + T('未使用'));
        ctx.fillStyle = over ? '#ff8a7a' : (s.used ? '#c8d0e0' : '#8a8a98');
        if (x1 - x0 > 22) {
          ctx.font = 'bold 13px sans-serif';
          ctx.fillText(String(k + 1), x0 + 4, topA + 14);
          ctx.font = '10px sans-serif';
          if (x1 - x0 > 60) ctx.fillText(label, x0 + 18, topA + 16, x1 - x0 - 22);
        }
      }
      ctx.strokeStyle = '#3a3a48';
      ctx.beginPath();
      ctx.moveTo(0, topA + LANE_H / 2 + 0.5); ctx.lineTo(w, topA + LANE_H / 2 + 0.5);
      ctx.moveTo(0, topB + LANE_H / 2 + 0.5); ctx.lineTo(w, topB + LANE_H / 2 + 0.5);
      ctx.stroke();
      // 境目(ハンドル)
      for (let k = 0; k + 1 < L.segs.length; k++) {
        const x = Math.round(L.segs[k].end * w) + 0.5;
        ctx.strokeStyle = k === v.dragIdx ? '#ffd166' : '#ffb347';
        ctx.lineWidth = k === v.dragIdx ? 2 : 1.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x - 5, h); ctx.lineTo(x + 5, h); ctx.lineTo(x, h - 7); ctx.closePath(); ctx.fill();
      }
      // 再生位置(両レーンにまたがる)
      const f = playheadFrac();
      if (f != null) {
        const x = Math.round(f * w) + 0.5;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }

    // ── 境目のドラッグ / 区間クリックで試聴 / ダブルクリックで区切りの追加・削除 ───────
    function fracAt(e) {
      const rc = canvas.getBoundingClientRect();
      return clamp((e.clientX - rc.left) / rc.width, 0, 1);
    }
    function handleAt(L, e) {
      const rc = canvas.getBoundingClientRect();
      const x = e.clientX - rc.left;
      let best = -1, bestD = 6;
      for (let k = 0; k + 1 < L.segs.length; k++) { const d = Math.abs(L.segs[k].end * rc.width - x); if (d < bestD) { bestD = d; best = k; } }
      return best;
    }
    /** クリックした縦位置がどちらのレーンか('raw'=上段オリジナル / 'dpcm'=下段) */
    function laneAt(e) {
      const rc = canvas.getBoundingClientRect();
      const y = (e.clientY - rc.top) * (canvas.height / rc.height);
      return y < LANE_H + LANE_GAP / 2 ? 'raw' : 'dpcm';
    }
    function segAt(L, t) {
      for (let k = 0; k < L.segs.length; k++) { const [t0, t1] = segRange(L, k); if (t >= t0 && t < t1) return k; }
      return L.segs.length - 1;
    }
    /** 境目kの移動先: 両隣の境目の内側(最小区間ぶんは空ける)。上限では拘束しない(超えたら赤で示す) */
    function clampSplit(L, k, t) {
      const lo = segStart(L, k), hi = L.segs[k + 1].end;
      const minF = SNAP_SAMPLES / Math.max(1, srcLength(L));
      return snapFrac(L, clamp(t, lo + minF, hi - minF));
    }
    function onDown(e) {
      const L = live();
      if (!L) return;
      e.preventDefault();
      v.downX = e.clientX; v.dragMoved = false;
      v.dragIdx = handleAt(L, e);
      drawWave();
    }
    function onWinMove(e) {
      const L = live();
      if (!L || v.dragIdx < 0) return;
      if (Math.abs(e.clientX - v.downX) > 1) v.dragMoved = true;
      L.segs[v.dragIdx].end = clampSplit(L, v.dragIdx, fracAt(e));
      L.pieces[v.dragIdx] = null; L.pieces[v.dragIdx + 1] = null;
      drawWave();
    }
    function onWinUp(e) {
      const L = live();
      if (!L) { v.dragIdx = -1; return; }
      if (v.dragIdx >= 0) {
        const moved = v.dragMoved;
        v.dragIdx = -1;
        if (moved) changed(); else drawWave();
        return;
      }
      if (e.target !== canvas) return;
      // 区間クリック → その区間だけ試聴。上段のオリジナルを押せば原音、下段を押せばDPCM変換後
      playSeg(segAt(L, fracAt(e)), laneAt(e));
    }
    function onDbl(e) {
      const L = live();
      if (!L) return;
      stop();
      // 境目の上なら区切りを消す(前の区間と結合)、それ以外なら区切りを足す
      const h = handleAt(L, e);
      if (h >= 0) { if (mergeWithPrev(L, h + 1)) changed(); return; }
      const t = fracAt(e);
      if (splitAt(L, segAt(L, t), t)) changed();
    }
    function onMove(e) {
      const L = live();
      canvas.style.cursor = (!L) ? 'default' : (v.dragIdx >= 0 || handleAt(L, e) >= 0) ? 'ew-resize' : 'pointer';
    }
    function onAutoCut() {
      const L = live();
      if (!L) return;
      if (autoCut(L)) { changed(); status(T('上限に収まるように {n} 区間へ切りました。境目をドラッグして調整できます', { n: L.segs.length }), 'ok'); }
    }
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('mousemove', onMove);
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
    autoCutBtn.addEventListener('click', onAutoCut);
    container.querySelector('.dpcm-ed-play-raw').addEventListener('click', playRaw);
    container.querySelector('.dpcm-ed-play-dpcm').addEventListener('click', playDpcm);
    container.querySelector('.dpcm-ed-stop').addEventListener('click', stop);
    let resizeObs = null;
    if (window.ResizeObserver) { resizeObs = new ResizeObserver(() => drawWave()); resizeObs.observe(container); }

    return {
      /** 表示・編集する状態を差し替える(null で空表示) */
      setLocal(L) { v.L = L || null; render(); },
      get local() { return v.L; },
      render, stop, playSequence, playRaw, playDpcm, playSeg,
      /** window 側のリスナーと監視を外す(シェルを作り直すときに呼ぶ) */
      destroy() {
        stop();
        v.destroyed = true;
        window.removeEventListener('mousemove', onWinMove);
        window.removeEventListener('mouseup', onWinUp);
        if (resizeObs) resizeObs.disconnect();
      },
    };
  }

  UI.DpcmSplitView = { create, model, LANE_H, LANE_GAP };
})(window);
