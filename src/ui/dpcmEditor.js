/*
 * DPCMコンバータ(@DPCM<n>定義エディタ)
 * MML.UI.DpcmEditor
 *
 * 見た目はドラム(DPCM)パネルと同じ「1定義=1行」の表、動作はFDS/N163/VRC7の波形・音色
 * エディタと同じ「ローカルで編集 → 『反映』でMML本文へ書き込む」方式(MMLテキストが正典、
 * DESIGN.md INV-2)。
 *   ・行 = MML本文の @DPCM<n> 定義。エディタで定義をダブルクリックするとその行を選んで開く
 *   ・📂 で音声ファイル(decodeAudioDataが読める形式なら何でも)か .dmc(変換済み生データ)を
 *     読む。.dmc は「元が.dmc」と表示して変換はしない(レート/ループ/試聴だけ)
 *   ・♪ で原音と変換後を試聴。下段に選択行の波形(上=オリジナル、下=DPCM)を出し、再生位置を重ねる
 *   ・DMC 1本の上限は $4013 の 4081 バイト。encode() は16バイト単位で出すので実質 4080 バイト
 *     = 32640 サンプル。読み込んだ音がこれを超えても勝手には切らずエラー表示にし、ユーザーが
 *     「限界で分割」(そのレートの上限に収まる均等割り)か波形のダブルクリックで区切りを足す。
 *     下段の分割ビューは src/ui/dpcmSplitView.js(ドラム(DPCM)パネルと共用の部品、2026-09-10)
 *   ・反映すると使用区間ごとに @DPCM 定義を書き、.dmc は <名前>_<区間番号>.dmc(1区間だけなら <名前>.dmc)。
 *     2つ目以降の定義は親の直後の行へ連番で挿入し、その行は「分割 k/N」と出して親の行から一括で扱う
 *   ・反映するまでMML本文には何も書かない。未反映の行は「反映」ボタンの色と状態列で分かる
 *   ・曲の再生/NSF書き出しが使う変換済みバイト列は hooks.setSample(file, bytes) で main.js の
 *     台帳(dpcmSampleCache、compile の opt.dpcmSamples)へ渡す。反映していない内容は曲には乗らない。
 *     逆に台帳にあるだけの定義(*2mml変換の出力など)は hooks.getSample(file) で拾い、
 *     「.dmc(台帳)」として試聴できる
 *
 * hooks: { getSample(file) → Uint8Array|null, setSample(file, bytes), onApplied() }
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => (MML.I18n ? MML.I18n.t(key, params) : key);

  // 区間の計算・変換・試聴は分割ビューの部品(src/ui/dpcmSplitView.js)と共有する
  const M = UI.DpcmSplitView.model;
  const { HW_MAX_BYTES, MAX_BYTES, rateHz, clamp, fmtTime, clampVol, fillRateSelect,
          hasData, isDmcRow, segRate, segSamples, segBytes, segOver, resetSegs, invalidateAll,
          ensurePiece, decodePiece, previewPcm, usedSegs, totalUsedBytes, totalSeconds } = M;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sanitize(name) {
    const DS = MML.Convert && MML.Convert.DrumSamples;
    const s = DS ? DS.sanitizeName(name) : String(name || '').replace(/[^0-9A-Za-z_.+-]+/g, '_');
    return s || '';
  }
  function baseName(file) { return String(file || '').replace(/\.[^.]*$/, ''); }

  // ── MML本文の @DPCM<n> 定義(lexer.js DPCM_DEF_RE と同じ書式) ──────────────────
  // 定義ブロックの位置探しは共通モジュール(src/mml/defBlocks.js)に任せ、
  // ここでは中身 `"ファイル名", freq, size, dac, mode` の読み取りだけを行う
  const Defs = MML.Defs;
  const BODY_RE = /^\s*"([^"]*)"\s*,([\s\S]*)$/;
  function parseNum(s) { return Defs.parseNumber(s); }
  function scanDefs(source) {
    const out = [];
    for (const d of Defs.scan(source, 'DPCM')) {
      const body = BODY_RE.exec(Defs.stripComments(source.slice(d.contentStart, d.contentEnd)));
      if (!body) continue; // ファイル名が無い壊れた定義は無視する(コンパイル側でもエラーになる)
      const p = body[2].trim().split(/[\s,]+/).filter(Boolean).map(parseNum);
      const num = (i, dflt) => (Number.isFinite(p[i]) ? p[i] : dflt);
      out.push({ index: d.index, file: body[1], freq: num(0, 0), size: num(1, 0), dac: num(2, 0), mode: num(3, 0),
                 start: d.start, end: d.end });
    }
    return out;
  }
  function findDefRange(source, index) { return scanDefs(source).find(d => d.index === index) || null; }
  function findEnclosingDef(source, pos) { return scanDefs(source).find(d => pos >= d.start && pos <= d.end) || null; }
  function formatDef(index, d) {
    return `@DPCM${index} = { "${d.file}", ${d.freq}, ${d.size}, ${d.dac}, ${d.mode} }`;
  }

  // ── ローカル状態(行ごと。反映するまでMMLには書かない) ─────────────────────────
  //   base      … ファイル名(拡張子なし)。反映時に <base>.dmc / 分割なら <base>_<区間番号>.dmc
  //   pcm/srcRate … 読み込んだ音声(変換元)。.dmc を読んだ/台帳から拾ったときは dmc の方
  //   dmc/dmcFrom … 変換済み生データと出所('file' | 'cache')
  //   rate/loop/dac/vol … @DPCM の freq(行の一括値)/mode/dac、変換ボリューム(1-100)
  //   segs/pieces … 区間と変換キャッシュ(dpcmSplitView.js 冒頭コメント参照。ここでは segs[].rate は常に数値)
  //   pieceIndices/pieceNos … 反映済みの分割定義(2本目以降)の番号と、その区間番号。次の反映で使い回す
  //   pieceOf/pieceNo … この行が分割で生まれた子のとき、親の番号と区間番号
  function newLocal(def) {
    const rate = def ? clamp(def.freq | 0, 0, 15) : 15;
    return {
      base: def ? baseName(def.file) : '',
      pcm: null, srcRate: 0, dmc: null, dmcFrom: null,
      rate,
      loop: def ? !!def.mode : false,
      dac: def ? def.dac : 64,
      vol: 100,
      dirty: false, segs: [{ end: 1, rate, used: true }], pieces: [null],
      pieceIndices: [], pieceNos: [], pieceOf: null, pieceNo: 0,
      previewPcm: null, previewKey: null,
    };
  }

  // ── 本体 ─────────────────────────────────────────────────────────────────
  const api = {};
  UI.DpcmEditor = api;

  api.init = function (mmlSourceEl, hooks) {
    hooks = hooks || {};
    const win = document.getElementById('win-dpcm');
    const rootEl = document.getElementById('dpcmEditor');
    if (!win || !rootEl) return;
    const toggleBtn = document.querySelector('.toggle-btn[data-target="win-dpcm"]');

    let rows = [];                 // [{index, def}]  MML本文の定義(表示順=番号順)
    const locals = new Map();      // index → local
    let selected = null;           // 選択中の行番号
    let audioCtx = null;           // 音声ファイルの decodeAudioData 用(試聴は分割ビューが持つ)
    let view = null;               // 下段の分割ビュー(dpcmSplitView.js)

    // 表の中身(行/区間)は render() が作り直すが、見出し・ボタン・説明文は下のシェルに
    // 埋まっているので、言語切替では buildShell() でシェルごと作り直す
    // (keyboard.js / helpPanel.js と同じ MML.I18n.onChange の規約)。要素を持ち直すため参照は let
    let bodyEl, totalEl, helpBox, waveEl, statusEl;

    function shellHtml() {
      return `<div class="dpcm-ed compact-wave-editor">` +
        `<div class="toolbar dpcm-ed-toolbar">` +
          `<button type="button" class="secondary dpcm-ed-add" title="${T('新規定義を追加')}">＋</button>` +
          `<button type="button" class="secondary dpcm-ed-help-btn" title="${T('説明を表示/非表示')}">❓</button>` +
          `<span class="dpcm-ed-total"></span>` +
        `</div>` +
        `<div class="fds-help-text dpcm-ed-help" style="display:none;">` +
          T('行はMML本文の @DPCM<n> 定義です。📂 で音声ファイル(.dmcなら変換なしでそのまま)を読み、♪ で原音/変換後を聴き比べ、「反映」でMMLへ書き込みます。反映するまでMMLは変わりません(色の付いた「反映」=未反映)。DMC 1本は4081バイトまでなので、超える音は下段で区切ります: 「限界で分割」で上限に収まるように切るか、波形をダブルクリックして区切りを足し、境目をドラッグして聞きながら決めます(境目のダブルクリックで区切りを削除。上=オリジナル/下=DPCMで、クリックした側の音でその区間だけ試聴)。区間ごとに番号・使用/未使用・DMCレートがあり、未使用(グレー)は反映されず、上限超え(赤)のままでは反映できません。反映後のファイル名は <名前>_<区間番号>.dmc です。') +
        `</div>` +
        `<div class="dpcm-ed-head">` +
          `<span class="de-c-idx">#</span>` +
          `<span class="de-c-file"></span>` +
          `<span class="de-c-name">${T('ファイル名')}</span>` +
          `<span class="de-c-play"><i>${T('オリジナル')}</i><i>DPCM</i></span>` +
          `<span class="de-c-vol">${T('ボリューム')}</span>` +
          `<span class="de-c-rate">${T('DMCレート')}</span>` +
          `<span class="de-c-loop">${T('ループ')}</span>` +
          `<span class="de-c-size">${T('サイズ')}</span>` +
          `<span class="de-c-state">${T('状態')}</span>` +
          `<span class="de-c-ops"></span>` +
        `</div>` +
        `<div class="dpcm-ed-body"></div>` +
        `<div class="dpcm-ed-wave"></div>` +
        `<div class="output fds-status-output dpcm-ed-status"></div>` +
      `</div>`;
    }

    // シェルを組み立て直して要素を持ち直す(初回と言語切替の2箇所から呼ぶ)。
    // 説明(❓)の開閉とログの文言は作り直しても残す
    function buildShell() {
      const helpOpen = !!(helpBox && helpBox.style.display !== 'none');
      const status = statusEl ? { text: statusEl.textContent, cls: statusEl.className } : null;
      if (view) view.destroy();
      rootEl.innerHTML = shellHtml();
      bodyEl = rootEl.querySelector('.dpcm-ed-body');
      totalEl = rootEl.querySelector('.dpcm-ed-total');
      helpBox = rootEl.querySelector('.dpcm-ed-help');
      waveEl = rootEl.querySelector('.dpcm-ed-wave');
      statusEl = rootEl.querySelector('.dpcm-ed-status');
      if (helpOpen) helpBox.style.display = 'block';
      if (status) { statusEl.textContent = status.text; statusEl.className = status.cls; }
      rootEl.querySelector('.dpcm-ed-add').addEventListener('click', onAdd);
      rootEl.querySelector('.dpcm-ed-help-btn').addEventListener('click', onHelpToggle);
      view = UI.DpcmSplitView.create(waveEl, {
        onChange: (L) => { L.dirty = true; render(); },
        onStatus: setStatus,
        title: (L) => `@DPCM${selected} ${L.base}.dmc`,
        emptyText: () => {
          const S = selected != null ? locals.get(selected) : null;
          return !S ? ''
            : (S.pieceOf != null) ? T('@DPCM{n}: 分割の子(@DPCM{p} の行で編集)', { n: selected, p: S.pieceOf })
            : T('@DPCM{n}: 波形なし(ファイル未読込)', { n: selected });
        },
      });
    }

    function setStatus(text, cls) {
      statusEl.className = 'output fds-status-output dpcm-ed-status' + (cls ? ' ' + cls : '');
      statusEl.textContent = text || '';
    }
    function stop() { if (view) view.stop(); }

    // ── MML ⇄ 行 ─────────────────────────────────────────────────────────
    function rebuildRows() {
      const defs = scanDefs(mmlSourceEl.value).sort((a, b) => a.index - b.index);
      const seen = new Set();
      rows = [];
      // 分割の子(反映済み)は親の pieceIndices で分かる
      const childOf = new Map();
      for (const [idx, L] of locals) if (L.pieceOf == null) L.pieceIndices.forEach((ci, k) => childOf.set(ci, { owner: idx, no: L.pieceNos[k] || (k + 2) }));
      for (const d of defs) {
        if (seen.has(d.index)) continue; // 同じ番号の定義が重複していたら先頭だけ
        seen.add(d.index);
        let L = locals.get(d.index);
        const child = childOf.get(d.index);
        if (child) {
          if (!L || L.pieceOf !== child.owner) { L = newLocal(d); locals.set(d.index, L); }
          L.pieceOf = child.owner; L.pieceNo = child.no;
        } else if (!L) {
          L = newLocal(d);
          locals.set(d.index, L);
        } else if (!L.dirty && !L.pcm && L.dmcFrom !== 'file') {
          // 手を付けていない行は定義の値へ追随する(手打ちで freq を変えた場合など)
          L.base = baseName(d.file); L.rate = clamp(d.freq | 0, 0, 15); L.loop = !!d.mode; L.dac = d.dac;
          for (const s of L.segs) s.rate = L.rate;
          invalidateAll(L);
        }
        // 台帳(反映済み/変換出力)のバイト列を拾う。読み込んだファイルがあればそちらを優先
        if (!L.pcm && L.dmcFrom !== 'file') {
          const bytes = hooks.getSample ? hooks.getSample(d.file) : null;
          if (bytes && bytes.length) {
            if (L.dmc !== bytes) { L.dmc = bytes; L.dmcFrom = 'cache'; L.previewKey = null; resetSegs(L); }
          } else if (L.dmcFrom === 'cache') { L.dmc = null; L.dmcFrom = null; L.previewKey = null; resetSegs(L); }
        }
        rows.push({ index: d.index, def: d });
      }
      // MMLから消えた定義のローカル状態は捨てる(子だった行は親が持ち直す)
      for (const idx of Array.from(locals.keys())) if (!seen.has(idx)) locals.delete(idx);
      if (selected != null && !seen.has(selected)) selected = null;
      if (selected == null && rows.length) selected = rows[0].index;
    }

    function writeSource(newSource) { Defs.setSource(mmlSourceEl, newSource); }
    // anchorIndex: 新規の定義を「その定義の直後」に置く(分割の子を親の隣へ並べるため)。
    // 無ければ他のエディタと同じく先頭の定義ブロックの末尾へ
    function writeDef(index, d, anchorIndex) {
      const anchor = anchorIndex != null ? { anchor: { tag: 'DPCM', index: anchorIndex } } : null;
      Defs.write(mmlSourceEl, 'DPCM', index, formatDef(index, d), anchor);
    }
    function removeDef(index) { Defs.erase(mmlSourceEl, 'DPCM', index); }
    function nextFreeIndex(used) { return Defs.nextFreeIndex(mmlSourceEl.value, 'DPCM', used); }

    // ── 反映 ─────────────────────────────────────────────────────────────
    function applyRow(index) {
      const L = locals.get(index);
      if (!L || L.pieceOf != null) return;
      if (!hasData(L)) { setStatus(T('先に 📂 で音声ファイルか .dmc を読み込んでください'), 'error'); return; }
      const used = usedSegs(L);
      if (!used.length) { setStatus(T('使用する区間がありません(全区間が未使用)'), 'error'); return; }
      const overK = used.find(k => segOver(L, k));
      if (overK != null) {
        setStatus(T('区間{k}が{n}バイトで上限{max}を超えています。「限界で分割」か境目の移動、または未使用にしてください', { k: overK + 1, n: segBytes(L, overK), max: MAX_BYTES }), 'error');
        return;
      }
      const pieces = used.map(k => ensurePiece(L, k));
      const over = pieces.find(p => p.bytes.length > MAX_BYTES);
      if (over) {
        setStatus(T('区間{k}が{n}バイトで上限{max}を超えています。「限界で分割」か境目の移動、または未使用にしてください', { k: used[pieces.indexOf(over)] + 1, n: over.bytes.length, max: MAX_BYTES }), 'error');
        return;
      }
      const base = sanitize(L.base) || ('dpcm' + index);
      L.base = base;
      // 番号: 先頭はこの行、2本目以降は前回の分割番号を使い回し、足りなければ空き番号を足す
      const indices = [index];
      const usedIdx = new Set([index]);
      for (let k = 1; k < used.length; k++) {
        let ci = L.pieceIndices[k - 1];
        if (ci == null || usedIdx.has(ci)) ci = nextFreeIndex(usedIdx);
        usedIdx.add(ci);
        indices.push(ci);
      }
      // 本数が減ったぶんの子定義は消す
      for (const stale of L.pieceIndices.slice(used.length - 1)) { removeDef(stale); locals.delete(stale); }
      L.pieceIndices = indices.slice(1);
      L.pieceNos = used.slice(1).map(k => k + 1);
      const multi = L.segs.length > 1;
      const files = used.map(k => multi ? `${base}_${k + 1}.dmc` : `${base}.dmc`);
      pieces.forEach((p, i) => {
        // 子(2本目以降)は直前の定義の直後へ置き、MML上でも順に並ぶようにする
        writeDef(indices[i], { file: files[i], freq: segRate(L, used[i]), size: p.bytes.length, dac: p.dac, mode: L.loop ? 1 : 0 }, i > 0 ? indices[i - 1] : null);
        if (hooks.setSample) hooks.setSample(files[i], p.bytes);
      });
      L.dirty = false;
      rebuildRows();
      render();
      const total = pieces.reduce((s, p) => s + p.bytes.length, 0);
      setStatus(used.length > 1
        ? T('反映しました: @DPCM{a}〜 {n}本 / 合計{bytes}バイト。区間を続けて鳴らすには E @{a} c @{b} c … のように並べます', { a: indices[0], b: indices[1], n: used.length, bytes: total })
        : T('反映しました: @DPCM{a} "{file}" {bytes}バイト', { a: index, file: files[0], bytes: total }), 'ok');
      if (hooks.onApplied) hooks.onApplied();
    }

    // ── ファイル読み込み ───────────────────────────────────────────────────
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*,.dmc';
    fileInput.style.display = 'none';
    fileInput.className = 'dpcm-ed-file-input';
    document.body.appendChild(fileInput);
    let pickIndex = null; // 📂 を押した行
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      const index = pickIndex;
      fileInput.value = '';
      if (!file || index == null) return;
      await loadFile(index, file);
    });
    function pickFile(index) {
      pickIndex = index;
      fileInput.click();
    }
    function ensureAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    }
    async function loadFile(index, file) {
      const L = locals.get(index);
      if (!L) return;
      try {
        stop();
        const buf = await file.arrayBuffer();
        if (/\.dmc$/i.test(file.name)) {
          L.pcm = null; L.srcRate = 0;
          L.dmc = new Uint8Array(buf); L.dmcFrom = 'file';
        } else {
          ensureAudio();
          const ab = await audioCtx.decodeAudioData(buf);
          // モノラル化(左右の平均)。DPCMは元々モノラル
          const n = ab.length;
          const pcm = new Float32Array(n);
          for (let c = 0; c < ab.numberOfChannels; c++) {
            const d = ab.getChannelData(c);
            for (let i = 0; i < n; i++) pcm[i] += d[i] / ab.numberOfChannels;
          }
          L.pcm = pcm; L.srcRate = ab.sampleRate;
          L.dmc = null; L.dmcFrom = null;
        }
        L.base = sanitize(baseName(file.name)) || L.base;
        L.dirty = true; L.previewKey = null;
        resetSegs(L); // 読み込み直後は1区間。上限超えは切らずにエラー表示(下)
        selected = index;
        render();
        const bytes = segBytes(L, 0);
        let msg = isDmcRow(L)
          ? T('元が.dmcファイルのため変換はしません(レートとループは指定できます): {n}バイト', { n: L.dmc.length })
          : T('読み込みました: {name} {rate}Hz {n}サンプル → DMC {hz}Hz {m}サンプル({bytes}バイト)', { name: file.name, rate: L.srcRate, n: L.pcm.length, hz: rateHz(L.rate).toFixed(0), m: segSamples(L, 0), bytes });
        let cls = 'ok';
        if (bytes > MAX_BYTES) {
          msg += '\n' + T('DMC 1本の上限({max}バイト)を超えています。「限界で分割」か、波形をダブルクリックして区切ってください', { max: HW_MAX_BYTES });
          cls = 'error';
        }
        setStatus(msg, cls);
      } catch (e) {
        console.error('DPCM: ファイル読み込み失敗', e);
        setStatus(T('音声ファイルを読み込めませんでした: {msg}', { msg: e.message }), 'error');
      }
    }

    // ── 保存(.dmc) ────────────────────────────────────────────────────────
    async function saveRow(index) {
      const L = locals.get(index);
      if (!L) return;
      if (L.pieceOf != null) {
        const d = defOf(index);
        const bytes = (d && hooks.getSample) ? hooks.getSample(d.file) : null;
        if (bytes) await saveBytes(d.file, bytes, true);
        return;
      }
      if (!hasData(L)) return;
      const used = usedSegs(L);
      if (!used.length) return;
      const base = sanitize(L.base) || ('dpcm' + index);
      if (used.length === 1 && L.segs.length === 1) { await saveBytes(base + '.dmc', ensurePiece(L, 0).bytes, true); return; }
      // 複数ファイルはダイアログを連続で出せない(ユーザー操作1回につき1回)のでダウンロードで落とす
      for (const k of used) saveBytes(`${base}_${k + 1}.dmc`, ensurePiece(L, k).bytes, false);
      setStatus(T('{n}個の.dmcをダウンロードしました', { n: used.length }), 'ok');
    }
    async function saveBytes(name, bytes, dialog) {
      if (dialog && window.showSaveFilePicker) {
        let handle = null;
        try {
          handle = await window.showSaveFilePicker({ suggestedName: name,
            types: [{ description: 'DMC', accept: { 'application/octet-stream': ['.dmc'] } }] });
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          handle = null;
        }
        if (handle) {
          try {
            const w = await handle.createWritable();
            await w.write(new Blob([bytes], { type: 'application/octet-stream' }));
            await w.close();
            setStatus(T('保存しました: {file} ({n}バイト)', { file: handle.name, n: bytes.length }), 'ok');
          } catch (e) {
            setStatus(T('保存に失敗しました: {msg}', { msg: e.message }), 'error');
          }
          return;
        }
      }
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function defOf(index) { const r = rows.find(x => x.index === index); return r ? r.def : null; }

    // ── 試聴(行の ♪。分割ビューの再生機構を使う) ───────────────────────────
    function playRaw(index) {
      const L = locals.get(index);
      if (!L || !view) return;
      if (L.pieceOf != null) { playDpcm(index); return; }
      if (hasData(L)) view.playRaw();
    }
    function playDpcm(index) {
      const L = locals.get(index);
      if (!L || !view) return;
      if (L.pieceOf != null) {
        const d = defOf(index);
        const bytes = (d && hooks.getSample) ? hooks.getSample(d.file) : null;
        if (!bytes) return;
        view.playSequence([{ pcm: MML.Dpcm.decode(bytes, bytes.length * 8, (d.dac == null || d.dac === 255) ? 64 : (d.dac & 0x7F)), hz: rateHz(d.freq), t0: 0, t1: 1 }]);
        return;
      }
      if (hasData(L)) view.playDpcm();
    }

    // ── 表の描画 ───────────────────────────────────────────────────────────
    function rowState(L) {
      if (L.pieceOf != null) {
        const owner = locals.get(L.pieceOf);
        return { text: T('分割 {k}/{n} (@DPCM{p})', { k: L.pieceNo, n: owner ? owner.segs.length : '?', p: L.pieceOf }), cls: 'de-state--child' };
      }
      if (!hasData(L)) return { text: T('未読込'), cls: 'de-state--none' };
      const parts = [L.dirty ? T('未反映') : T('反映済み')];
      if (isDmcRow(L)) parts.push(L.dmcFrom === 'file' ? T('元が.dmc') : T('.dmc(台帳)'));
      const unused = L.segs.length - usedSegs(L).length;
      if (L.segs.length > 1) parts.push(T('{n}区間', { n: L.segs.length }) + (unused ? T('(未使用{m})', { m: unused }) : ''));
      const over = usedSegs(L).some(k => segOver(L, k));
      if (over) parts.push(T('サイズ超過'));
      return { text: parts.join(' / '), cls: over ? 'de-state--over' : (L.dirty ? 'de-state--dirty' : 'de-state--ok') };
    }
    function sizeText(L, def) {
      if (L.pieceOf != null) return `${def.size | 0}B`;
      if (!hasData(L)) return '';
      return `${totalUsedBytes(L)}B ${fmtTime(totalSeconds(L))}`;
    }

    function render() {
      bodyEl.innerHTML = '';
      if (!rows.length) {
        bodyEl.innerHTML = `<div class="dpcm-ed-empty">${T('@DPCM定義がありません。＋で追加するか、MML本文に @DPCM<n> = { "file.dmc", 15, 0, 64, 0 } を書いてください')}</div>`;
      }
      let total = 0;
      for (const r of rows) {
        const L = locals.get(r.index);
        const st = rowState(L);
        const child = L.pieceOf != null;
        const row = document.createElement('div');
        row.className = 'dpcm-ed-row' + (r.index === selected ? ' dpcm-ed-row--sel' : '') + (L.dirty ? ' dpcm-ed-row--dirty' : '') + (child ? ' dpcm-ed-row--child' : '');
        row.dataset.index = String(r.index);
        // 手を付けるまでは定義に書いてある名前をそのまま出す(反映すると <base>.dmc になる)
        const nameVal = (child || !(L.dirty || hasData(L)) || !L.base) ? r.def.file : L.base + '.dmc';
        row.innerHTML =
          `<span class="de-c-idx">${r.index}</span>` +
          `<span class="de-c-file">` +
            `<button type="button" class="secondary de-file" title="${T('音声ファイル / .dmc を読み込む(反映を押すまでMMLへは書き込まれません)')}"${child ? ' disabled' : ''}>📂</button>` +
            `<button type="button" class="secondary de-save" title="${T('変換後の.dmcを保存')}"${(hasData(L) || child) ? '' : ' disabled'}>💾</button>` +
          `</span>` +
          `<span class="de-c-name"><input type="text" class="de-name" value="${esc(nameVal)}" title="${esc(r.def.file)}"${child ? ' disabled' : ''}></span>` +
          `<span class="de-c-play">` +
            `<button type="button" class="de-play" data-mode="raw" title="${T('原音を鳴らす')}"${(hasData(L) && !child && !isDmcRow(L)) ? '' : ' disabled'}>♪</button>` +
            `<button type="button" class="de-play" data-mode="dpcm" title="${T('DPCM変換後を鳴らす')}"${(hasData(L) || child) ? '' : ' disabled'}>♪</button>` +
          `</span>` +
          `<span class="de-c-vol">` +
            `<input type="range" class="de-vol" min="1" max="100" step="1" value="${clampVol(L.vol)}"${(child || isDmcRow(L)) ? ' disabled' : ''}>` +
            `<span class="de-vol-num">${clampVol(L.vol)}%</span>` +
          `</span>` +
          `<span class="de-c-rate"><select class="de-rate" title="${T('全区間のDMCレートをまとめて変えます(区間ごとの指定は下段)')}"${child ? ' disabled' : ''}></select></span>` +
          `<span class="de-c-loop"><input type="checkbox" class="de-loop"${L.loop ? ' checked' : ''}${child ? ' disabled' : ''}></span>` +
          `<span class="de-c-size">${esc(sizeText(L, r.def))}</span>` +
          `<span class="de-c-state ${st.cls}">${esc(st.text)}</span>` +
          `<span class="de-c-ops">` +
            `<button type="button" class="de-apply${L.dirty ? ' apply-btn--dirty' : ''}" title="${T('現在の内容をMMLへ反映')}"${child ? ' disabled' : ''}>${T('反映')}</button>` +
            `<button type="button" class="secondary de-del" title="${T('この定義をMMLから削除')}">×</button>` +
          `</span>`;
        const sel = row.querySelector('.de-rate');
        fillRateSelect(sel, child ? clamp(r.def.freq | 0, 0, 15) : L.rate);
        sel.addEventListener('change', () => {
          L.rate = parseInt(sel.value, 10) | 0;
          for (const s of L.segs) s.rate = L.rate;
          L.dirty = true; invalidateAll(L);
          selected = r.index;
          render();
        });
        const nameEl = row.querySelector('.de-name');
        nameEl.addEventListener('change', () => {
          const v = sanitize(baseName(nameEl.value.trim()));
          if (v && v !== L.base) { L.base = v; L.dirty = true; render(); }
          else nameEl.value = L.base ? L.base + '.dmc' : r.def.file;
        });
        nameEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameEl.blur(); });
        // ★DPCMは1bitデルタ変調なので、振幅を下げるほど量子化ノイズが相対的に大きくなる。
        //   効きすぎる前に気づけるよう、ドラム(DPCM)パネルと同じ25%未満の印を出す
        const volEl = row.querySelector('.de-vol');
        const volNum = row.querySelector('.de-vol-num');
        const syncVolWarn = () => {
          const v = clampVol(volEl.value);
          volNum.textContent = v + '%';
          volNum.classList.toggle('de-vol-num--warn', v < 25);
          volNum.title = isDmcRow(L)
            ? T('元が.dmc(1bit化済み)のデータは変換しないため、ボリュームは掛けられません')
            : v < 25
              ? T('小さくしすぎるとDPCMの量子化ノイズが目立ちます(25%未満)。元のサンプル側を下げるか、鳴らさない方が良い場合があります')
              : T('変換時にこのサンプルへ掛ける音量。DPCMは実機で@vが効かないので、ここが唯一の音量調整です');
        };
        syncVolWarn();
        volEl.addEventListener('input', syncVolWarn);
        volEl.addEventListener('change', () => {
          L.vol = clampVol(volEl.value);
          L.dirty = true; L.previewKey = null; invalidateAll(L);
          selected = r.index;
          render();
        });
        const loopEl = row.querySelector('.de-loop');
        loopEl.addEventListener('change', () => { L.loop = loopEl.checked; L.dirty = true; render(); });
        for (const b of row.querySelectorAll('.de-play')) {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            selected = r.index; renderSelection();
            if (b.dataset.mode === 'raw') playRaw(r.index); else playDpcm(r.index);
          });
        }
        row.querySelector('.de-file').addEventListener('click', (e) => { e.stopPropagation(); selected = r.index; renderSelection(); pickFile(r.index); });
        row.querySelector('.de-save').addEventListener('click', (e) => { e.stopPropagation(); saveRow(r.index); });
        row.querySelector('.de-apply').addEventListener('click', (e) => { e.stopPropagation(); applyRow(r.index); });
        row.querySelector('.de-del').addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm(T('@DPCM{n} をMMLから削除しますか?', { n: r.index }))) return;
          removeDef(r.index);
          locals.delete(r.index);
          if (selected === r.index) selected = null;
          rebuildRows(); render();
        });
        row.addEventListener('mousedown', (e) => {
          if (e.target.closest('button, input, select')) return;
          selected = r.index; renderSelection();
        });
        for (const el of row.querySelectorAll('input, select')) el.addEventListener('mousedown', (e) => e.stopPropagation());
        bodyEl.appendChild(row);
        // 合計: 親が分割ぶんまで含めて数えるので子は足さない。未読込の行は定義に書いてある size を信じる
        if (!child) total += hasData(L) ? totalUsedBytes(L) : (r.def.size | 0);
      }
      totalEl.textContent = rows.length ? T('合計 {n}定義 / {kb} KB (DMC領域16KB)', { n: rows.length, kb: (total / 1024).toFixed(1) }) : '';
      totalEl.classList.toggle('dpcm-ed-total--over', total > 16384);
      renderWave();
    }
    function renderSelection() {
      for (const el of bodyEl.querySelectorAll('.dpcm-ed-row')) el.classList.toggle('dpcm-ed-row--sel', +el.dataset.index === selected);
      renderWave();
    }
    // 下段(分割ビュー): 選択中の親行でデータがあるものだけ編集対象にする
    function selLocal() {
      const L = selected != null ? locals.get(selected) : null;
      return (L && L.pieceOf == null && hasData(L)) ? L : null;
    }
    function renderWave() { if (view) view.setLocal(selLocal()); }

    // ── ツールバー ─────────────────────────────────────────────────────────
    function onAdd() {
      // 他のエディタと同じく番号を確保するため即座にMMLへ書く(中身は反映で入れ替わる)
      const idx = nextFreeIndex([]);
      writeDef(idx, { file: `dpcm${idx}.dmc`, freq: 15, size: 0, dac: 64, mode: 0 });
      rebuildRows();
      selected = idx;
      render();
      pickFile(idx);
    }
    function onHelpToggle() {
      helpBox.style.display = helpBox.style.display === 'none' ? 'block' : 'none';
    }

    // ── 開く/閉じる/ダブルクリック ─────────────────────────────────────────
    function openWindow() {
      if (win.style.display === 'none') { if (toggleBtn) toggleBtn.click(); }
      else if (win._famimmlWindow) win._famimmlWindow.bringToFront();
    }
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        if (win.style.display === 'none') { stop(); return; }
        rebuildRows(); render();
      });
    }
    mmlSourceEl.addEventListener('dblclick', () => {
      const hit = findEnclosingDef(mmlSourceEl.value, mmlSourceEl.selectionStart);
      if (!hit) return;
      api.openForIndex(hit.index);
    });
    api.openForIndex = function (index) {
      openWindow();
      rebuildRows();
      if (locals.has(index)) selected = index;
      render();
      const rowEl = bodyEl.querySelector(`.dpcm-ed-row[data-index="${index}"]`);
      if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
    };
    api.refresh = function () {
      if (win.style.display === 'none') return;
      rebuildRows(); render();
    };
    // MML本文を丸ごと差し替えたとき(ファイルを開く/変換結果)に呼ぶ。読み込み中の音声は捨てる
    api.reset = function () {
      stop();
      locals.clear(); selected = null;
      if (win.style.display !== 'none') { rebuildRows(); render(); }
    };
    // ドラム(DPCM)パネルの「コンバータの音を使う」向け: 選択行の変換元(ボリューム込み)。
    // 渡した先のパッドにも独自のボリュームがあり、そちらは重ねて掛かる
    api.currentSource = function () {
      const L = selected != null ? locals.get(selected) : null;
      if (!L || L.pieceOf != null || !L.pcm) return null;
      return { name: (L.base || 'dpcm') + '.dmc', pcm: previewPcm(L), rate: L.srcRate };
    };
    api.stop = stop;
    // 行へファイルを流し込む(ドロップ等の外部経路用。📂 と同じ処理)
    api.loadFileFor = function (index, file) {
      if (!locals.has(index)) { rebuildRows(); render(); }
      if (!locals.has(index)) return Promise.resolve();
      return loadFile(index, file);
    };

    // 言語切替: 見出し・ボタン・説明文はシェルに埋まっているので作り直す
    if (MML.I18n && MML.I18n.onChange) MML.I18n.onChange(() => { buildShell(); render(); });

    buildShell();
    rebuildRows();
    render();
  };
})(window);
