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
 *     = 32640 サンプル(MAX_BYTES/MAX_SAMPLES)。読み込んだ音がこれを超えても勝手には切らず
 *     エラー表示にし、ユーザーが「限界で分割」(そのレートの上限に収まる均等割り)か
 *     波形のダブルクリックで区切りを足す。境目はドラッグで動かす(上限で拘束はしない=
 *     超えた区間は赤く出してエラーのまま残す)。区間ごとに 番号 / 使用・未使用 / DMCレート を持ち、
 *     未使用の区間はグレーで反映されない。区間の ✕ で前の区間と結合
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
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTime(sec) { return (sec >= 10 ? sec.toFixed(1) : sec.toFixed(2)) + 's'; }
  function sanitize(name) {
    const DS = MML.Convert && MML.Convert.DrumSamples;
    const s = DS ? DS.sanitizeName(name) : String(name || '').replace(/[^0-9A-Za-z_.+-]+/g, '_');
    return s || '';
  }
  function baseName(file) { return String(file || '').replace(/\.[^.]*$/, ''); }

  // ── MML本文の @DPCM<n> 定義(lexer.js DPCM_DEF_RE と同じ書式) ──────────────────
  const DEF_RE = /@DPCM(\d+)\s*=\s*\{\s*"([^"]*)"\s*,([^}]*)\}/gi;
  function parseNum(s) { return s[0] === '$' ? parseInt(s.slice(1), 16) : parseInt(s, 10); }
  function scanDefs(source) {
    const out = [];
    DEF_RE.lastIndex = 0;
    let m;
    while ((m = DEF_RE.exec(source)) !== null) {
      const p = m[3].trim().split(/[\s,]+/).filter(Boolean).map(parseNum);
      const num = (i, dflt) => (Number.isFinite(p[i]) ? p[i] : dflt);
      out.push({ index: +m[1], file: m[2], freq: num(0, 0), size: num(1, 0), dac: num(2, 0), mode: num(3, 0),
                 start: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  function findDefRange(source, index) { return scanDefs(source).find(d => d.index === index) || null; }
  function findEnclosingDef(source, pos) { return scanDefs(source).find(d => pos >= d.start && pos <= d.end) || null; }
  function formatDef(index, d) {
    return `@DPCM${index} = { "${d.file}", ${d.freq}, ${d.size}, ${d.dac}, ${d.mode} }`;
  }
  // 新規定義の挿入位置(FDS/N163エディタと同じ): 先頭から続く定義行ブロックの直後
  function findInsertionOffset(source) {
    const rawLines = source.split(/\r\n|\r|\n/);
    let depth = 0, offset = 0;
    for (const rawLine of rawLines) {
      const ci = rawLine.indexOf(';');
      const code = ci >= 0 ? rawLine.slice(0, ci) : rawLine;
      const trimmed = code.trim();
      const isDef = depth > 0 || trimmed === '' || trimmed[0] === '@' || trimmed[0] === '#' || trimmed[0] === '$';
      if (!isDef) return offset;
      for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); }
      offset += rawLine.length + 1;
    }
    return source.length;
  }

  // ── ローカル状態(行ごと。反映するまでMMLには書かない) ─────────────────────────
  //   base      … ファイル名(拡張子なし)。反映時に <base>.dmc / 分割なら <base>_<区間番号>.dmc
  //   pcm/srcRate … 読み込んだ音声(変換元)。.dmc を読んだ/台帳から拾ったときは dmc の方
  //   dmc/dmcFrom … 変換済み生データと出所('file' | 'cache')
  //   rate/loop/dac … @DPCM の freq(行の一括値)/mode/dac
  //   segs      … 区間 [{end, rate, used}]。end=区間の終わり(全体に対する割合 0-1、最後は1)、
  //               区間kは [segs[k-1].end, segs[k].end)。rate=区間ごとのDMCレート、used=反映するか
  //   pieces    … 区間ごとの変換結果キャッシュ [{bytes, sampleCount, dac}|null]
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
  function hasData(L) { return !!(L.pcm || L.dmc); }
  function isDmcRow(L) { return !L.pcm && !!L.dmc; }
  /** 変換ボリューム(%)を 1〜100 に丸める(ドラム(DPCM)パネルと同じ範囲。0は「鳴らさない」と紛らわしいので下限1) */
  function clampVol(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 100;
  }
  // 全体の長さ(元データのサンプル数。PCM行=元のレート、.dmc行=DMCサンプル)
  function srcLength(L) { return L.pcm ? L.pcm.length : (L.dmc ? L.dmc.length * 8 : 0); }
  function segStart(L, k) { return k > 0 ? L.segs[k - 1].end : 0; }
  function segRange(L, k) { return [segStart(L, k), L.segs[k].end]; }
  // 区間のDMCサンプル数(encode() のリサンプルと同じ丸め)
  function segSamples(L, k) {
    const [t0, t1] = segRange(L, k);
    const N = srcLength(L);
    const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
    if (L.pcm) return Math.max(1, Math.round((b - a) * rateHz(L.segs[k].rate) / L.srcRate));
    return b - a;
  }
  function segBytes(L, k) {
    const p = L.pieces[k];
    return p ? p.bytes.length : bytesForSamples(segSamples(L, k));
  }
  function segSeconds(L, k) { return segSamples(L, k) / rateHz(L.segs[k].rate); }
  function segOver(L, k) { return segBytes(L, k) > MAX_BYTES; }
  // .dmc の区切りは16バイト境界へ吸着する(1バイト=8サンプルの生データを切るため)
  function snapFrac(L, t) {
    const N = srcLength(L);
    if (!N) return t;
    if (isDmcRow(L)) return clamp(Math.round(t * N / SNAP_SAMPLES) * SNAP_SAMPLES / N, 0, 1);
    return clamp(t, 0, 1);
  }
  function resetSegs(L) { L.segs = [{ end: 1, rate: L.rate, used: true }]; L.pieces = [null]; }
  function invalidateAll(L) { L.pieces = L.segs.map(() => null); }
  // 区間kを割合tで2つに切る(番号は後ろへずれる)
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
  // 区間kを前の区間と結合する(レートと使用は前の区間の値を引き継ぐ)
  function mergeWithPrev(L, k) {
    if (k <= 0) return false;
    const prev = L.segs[k - 1];
    L.segs.splice(k - 1, 2, { end: L.segs[k].end, rate: prev.rate, used: prev.used || L.segs[k].used });
    L.pieces.splice(k - 1, 2, null);
    return true;
  }
  // 上限を超えている使用区間を、そのレートで上限に収まる本数へ均等に切る
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
  function encodeSeg(L, k) {
    const [t0, t1] = segRange(L, k);
    if (L.pcm) {
      // ★変換元は previewPcm(=ボリュームを掛けた後の波形)。上段の表示・原音の試聴と同じものを焼く
      const src = previewPcm(L);
      const N = src.length;
      const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
      const seg = src.subarray(a, b);
      // 先頭サンプル値を$4011初期値にすると頭の追従ランプ(クリック)が消える(drumHits.js と同じ)
      const dac = clamp(Math.round((seg[0] + 1) / 2 * 127), 0, 127);
      const r = MML.Dpcm.encode(seg, L.srcRate, L.segs[k].rate, { startCounter: dac });
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
  // 上段(オリジナル)の波形 = 「いまの設定で変換元として使われる音」。PCM行はボリュームを掛けた後、
  // .dmc行は復号した音(既に1bit化済みなので掛けようがない=ボリュームは無効)。
  // 割合表示なのでレートが変わっても形は同じ。encodeSeg もここを変換元にする
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
    let audioCtx = null;
    let playing = null;            // { srcs, startAt, items:[{at, dur, t0, t1}], total }
    let rafId = 0;

    // 表の中身(行/区間)は render() が作り直すが、見出し・ボタン・説明文は下のシェルに
    // 埋まっているので、言語切替では buildShell() でシェルごと作り直す
    // (keyboard.js / helpPanel.js と同じ MML.I18n.onChange の規約)。要素を持ち直すため
    // 参照は let にし、window側に一度だけ付けるリスナーは常に最新の変数を見るようにする
    let bodyEl, totalEl, helpBox, waveEl, waveTitleEl, waveInfoEl, autoCutBtn, canvas, segsEl, statusEl;
    let resizeObs = null;

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
        `<div class="dpcm-ed-wave">` +
          `<div class="toolbar dpcm-ed-wave-bar">` +
            `<span class="dpcm-ed-wave-title"></span>` +
            `<button type="button" class="secondary dpcm-ed-autocut" title="${T('上限を超えている区間を、そのDMCレートで上限に収まる本数に均等に切ります。あとは境目をドラッグして調整してください')}">${T('限界で分割')}</button>` +
            `<button type="button" class="dpcm-ed-play-raw" title="${T('原音を鳴らす')}">▶ ${T('原音')}</button>` +
            `<button type="button" class="dpcm-ed-play-dpcm" title="${T('DPCM変換後を鳴らす(使用区間を順に)')}">▶ DPCM</button>` +
            `<button type="button" class="secondary dpcm-ed-stop" title="${T('停止')}">■</button>` +
            `<span class="dpcm-ed-wave-info"></span>` +
          `</div>` +
          `<canvas class="dpcm-ed-canvas" width="600" height="${LANE_H * 2 + LANE_GAP}" title="${T('境目をドラッグ / 波形をダブルクリックで区切りを追加・境目をダブルクリックで削除 / 上段(オリジナル)クリックで原音・下段(DPCM)クリックで変換後を区間試聴')}"></canvas>` +
          `<div class="dpcm-ed-segs"></div>` +
        `</div>` +
        `<div class="output fds-status-output dpcm-ed-status"></div>` +
      `</div>`;
    }

    // シェルを組み立て直して要素を持ち直す(初回と言語切替の2箇所から呼ぶ)。
    // 説明(❓)の開閉とログの文言は作り直しても残す
    function buildShell() {
      const helpOpen = !!(helpBox && helpBox.style.display !== 'none');
      const status = statusEl ? { text: statusEl.textContent, cls: statusEl.className } : null;
      rootEl.innerHTML = shellHtml();
      bodyEl = rootEl.querySelector('.dpcm-ed-body');
      totalEl = rootEl.querySelector('.dpcm-ed-total');
      helpBox = rootEl.querySelector('.dpcm-ed-help');
      waveEl = rootEl.querySelector('.dpcm-ed-wave');
      waveTitleEl = rootEl.querySelector('.dpcm-ed-wave-title');
      waveInfoEl = rootEl.querySelector('.dpcm-ed-wave-info');
      autoCutBtn = rootEl.querySelector('.dpcm-ed-autocut');
      canvas = rootEl.querySelector('.dpcm-ed-canvas');
      segsEl = rootEl.querySelector('.dpcm-ed-segs');
      statusEl = rootEl.querySelector('.dpcm-ed-status');
      if (helpOpen) helpBox.style.display = 'block';
      if (status) { statusEl.textContent = status.text; statusEl.className = status.cls; }
      rootEl.querySelector('.dpcm-ed-add').addEventListener('click', onAdd);
      rootEl.querySelector('.dpcm-ed-help-btn').addEventListener('click', onHelpToggle);
      autoCutBtn.addEventListener('click', onAutoCut);
      rootEl.querySelector('.dpcm-ed-play-raw').addEventListener('click', onPlayRaw);
      rootEl.querySelector('.dpcm-ed-play-dpcm').addEventListener('click', onPlayDpcm);
      rootEl.querySelector('.dpcm-ed-stop').addEventListener('click', stop);
      canvas.addEventListener('mousedown', onCanvasDown);
      canvas.addEventListener('dblclick', onCanvasDblClick);
      canvas.addEventListener('mousemove', onCanvasMove);
      if (window.ResizeObserver) {
        if (resizeObs) resizeObs.disconnect();
        resizeObs = new ResizeObserver(() => drawWave());
        resizeObs.observe(waveEl);
      }
    }

    function setStatus(text, cls) {
      statusEl.className = 'output fds-status-output dpcm-ed-status' + (cls ? ' ' + cls : '');
      statusEl.textContent = text || '';
    }

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

    function writeSource(newSource) {
      const scrollTop = mmlSourceEl.scrollTop;
      mmlSourceEl.value = newSource;
      mmlSourceEl.scrollTop = scrollTop;
      mmlSourceEl.dispatchEvent(new Event('input'));
    }
    // anchorIndex: 新規の定義を「その定義の直後」に置く(分割の子を親の隣へ並べるため)。
    // 無ければ他のエディタと同じく先頭の定義ブロックの末尾へ
    function writeDef(index, d, anchorIndex) {
      const text = formatDef(index, d);
      const source = mmlSourceEl.value;
      const range = findDefRange(source, index);
      if (range) return writeSource(source.slice(0, range.start) + text + source.slice(range.end));
      const anchor = anchorIndex != null ? findDefRange(source, anchorIndex) : null;
      if (anchor) {
        let at = anchor.end;
        const nl = source.indexOf('\n', at);
        at = nl < 0 ? source.length : nl + 1;
        const lead = (at === source.length && source[at - 1] !== '\n') ? '\n' : '';
        return writeSource(source.slice(0, at) + lead + text + '\n' + source.slice(at));
      }
      const offset = findInsertionOffset(source);
      const sep = (offset > 0 && source[offset - 1] !== '\n') ? '\n' : '';
      writeSource(source.slice(0, offset) + sep + text + '\n' + source.slice(offset));
    }
    function removeDef(index) {
      const source = mmlSourceEl.value;
      const range = findDefRange(source, index);
      if (!range) return;
      let end = range.end;
      if (source[end] === '\r') end++;
      if (source[end] === '\n') end++;
      writeSource(source.slice(0, range.start) + source.slice(end));
    }
    function nextFreeIndex(used) {
      let n = 0;
      for (const d of scanDefs(mmlSourceEl.value)) n = Math.max(n, d.index + 1);
      for (const u of used) n = Math.max(n, u + 1);
      return n;
    }

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
        writeDef(indices[i], { file: files[i], freq: L.segs[used[i]].rate, size: p.bytes.length, dac: p.dac, mode: L.loop ? 1 : 0 }, i > 0 ? indices[i - 1] : null);
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

    // ── 試聴 ─────────────────────────────────────────────────────────────
    function ensureAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    }
    function stop() {
      if (playing) { for (const s of playing.srcs) { try { s.stop(); } catch (e) { /* ignore */ } } playing = null; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      drawWave();
    }
    // AudioBufferのサンプルレートには下限があるので、DMCレートのままでは作れない。
    // コンテキストのレートへ線形補間で伸ばしてから鳴らす(main.js playFloatPcm と同じ)
    function makeBuffer(pcm, hz) {
      const ctxRate = audioCtx.sampleRate;
      const n = Math.max(1, Math.round(pcm.length * ctxRate / hz));
      const buf = audioCtx.createBuffer(1, n, ctxRate);
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
    // items: [{pcm, hz, t0, t1}] を順に鳴らす(区間ごとにレートが違ってもよい)。t0/t1 は再生位置線用の割合
    function playSequence(items) {
      items = items.filter(it => it.pcm && it.pcm.length && it.hz > 0);
      if (!items.length) return;
      ensureAudio();
      stop();
      const dest = (MML.Audio && MML.Audio.getMasterGain) ? MML.Audio.getMasterGain(audioCtx) : audioCtx.destination;
      const g = audioCtx.createGain();
      g.gain.value = 0.9;
      g.connect(dest);
      const startAt = audioCtx.currentTime + 0.02;
      const srcs = [];
      const sched = [];
      let at = 0;
      for (const it of items) {
        const buf = makeBuffer(it.pcm, it.hz);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(g);
        src.start(startAt + at);
        srcs.push(src);
        sched.push({ at, dur: buf.duration, t0: it.t0, t1: it.t1 });
        at += buf.duration;
      }
      playing = { srcs, startAt, items: sched, total: at };
      srcs[srcs.length - 1].onended = () => { if (playing && playing.srcs === srcs) { playing = null; drawWave(); } };
      tick();
    }
    function tick() {
      rafId = 0;
      if (!playing) return;
      drawWave();
      rafId = requestAnimationFrame(tick);
    }
    function playheadFrac() {
      if (!playing || !audioCtx) return null;
      const el = audioCtx.currentTime - playing.startAt;
      if (el < 0) return playing.items[0].t0;
      for (const it of playing.items) {
        if (el < it.at + it.dur) return it.t0 + clamp((el - it.at) / it.dur, 0, 1) * (it.t1 - it.t0);
      }
      return null;
    }
    function playRaw(index) {
      const L = locals.get(index);
      if (!L) return;
      if (L.pieceOf != null) { playDpcm(index); return; }
      // 原音側にもボリュームを掛ける(previewPcm)。このボタンは「元のPCM」ではなく
      // 「いまの設定で変換元として使われる音」の試聴なので(ドラム(DPCM)パネルと同じ考え方)
      if (L.pcm) playSequence([{ pcm: previewPcm(L), hz: L.srcRate, t0: 0, t1: 1 }]);
      else if (L.dmc) playSequence([{ pcm: previewPcm(L), hz: rateHz(L.rate), t0: 0, t1: 1 }]); // .dmc は復号した音しか無い
    }
    function playDpcm(index) {
      const L = locals.get(index);
      if (!L) return;
      if (L.pieceOf != null) {
        const d = defOf(index);
        const bytes = (d && hooks.getSample) ? hooks.getSample(d.file) : null;
        if (!bytes) return;
        playSequence([{ pcm: MML.Dpcm.decode(bytes, bytes.length * 8, (d.dac == null || d.dac === 255) ? 64 : (d.dac & 0x7F)), hz: rateHz(d.freq), t0: 0, t1: 1 }]);
        return;
      }
      if (!hasData(L)) return;
      // 使用区間を順に(未使用は飛ばす=反映後に鳴る形)
      playSequence(usedSegs(L).map(k => {
        const [t0, t1] = segRange(L, k);
        return { pcm: decodePiece(ensurePiece(L, k)), hz: rateHz(L.segs[k].rate), t0, t1 };
      }));
    }
    // 区間kの試聴。lane='raw' なら上段(オリジナル)、それ以外は下段(DPCM変換後)の音
    function playSeg(index, k, lane) {
      const L = locals.get(index);
      if (!L || !hasData(L) || !L.segs[k]) return;
      const [t0, t1] = segRange(L, k);
      if (lane === 'raw') {
        // .dmc行のオリジナルは復号した音そのもの(元PCMが存在しない)。PCM行はボリューム込み
        const src = previewPcm(L);
        if (!src) return;
        const N = src.length;
        const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
        playSequence([{ pcm: src.subarray(a, b), hz: L.pcm ? L.srcRate : rateHz(L.segs[k].rate), t0, t1 }]);
        return;
      }
      playSequence([{ pcm: decodePiece(ensurePiece(L, k)), hz: rateHz(L.segs[k].rate), t0, t1 }]);
    }

    // ── 表の描画 ───────────────────────────────────────────────────────────
    function rateOptions() {
      const table = rateTable();
      const opts = [];
      for (let i = table.length - 1; i >= 0; i--) opts.push([String(i), (table[i] / 1000).toFixed(1) + 'kHz']);
      return opts;
    }
    function fillRateSelect(sel, value) {
      for (const [v, label] of rateOptions()) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = String(value);
    }
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

    // ── 下段: 波形(上=オリジナル/下=DPCM) + 区間 ───────────────────────────
    function selLocal() {
      const L = selected != null ? locals.get(selected) : null;
      return (L && L.pieceOf == null && hasData(L)) ? L : null;
    }
    // 区間を触った後の共通処理(変換キャッシュはドラッグ中に捨ててあるので、ここで描き直す)
    function segsChanged(L) {
      L.dirty = true;
      render();
    }
    function renderWave() {
      const L = selLocal();
      waveEl.classList.toggle('dpcm-ed-wave--empty', !L);
      segsEl.innerHTML = '';
      if (!L) {
        const S = selected != null ? locals.get(selected) : null;
        waveTitleEl.textContent = !S ? ''
          : (S.pieceOf != null) ? T('@DPCM{n}: 分割の子(@DPCM{p} の行で編集)', { n: selected, p: S.pieceOf })
          : T('@DPCM{n}: 波形なし(ファイル未読込)', { n: selected });
        waveInfoEl.textContent = '';
        autoCutBtn.disabled = true;
        drawWave();
        return;
      }
      waveTitleEl.textContent = `@DPCM${selected} ${L.base}.dmc`;
      // 使用区間の変換をここでまとめて行う(ドラッグ中は捨ててあり、止めた時のこの描画で下段のDPCM波形が出る)
      for (const k of usedSegs(L)) ensurePiece(L, k);
      autoCutBtn.disabled = !usedSegs(L).some(k => segOver(L, k));
      waveInfoEl.textContent = T('{n}区間 {t} / 1本の上限 {max}バイト(={tmax} @{hz}Hz)', { n: L.segs.length, t: fmtTime(totalSeconds(L)), max: HW_MAX_BYTES, tmax: fmtTime(MAX_SAMPLES / rateHz(L.rate)), hz: rateHz(L.rate).toFixed(0) });
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
        fillRateSelect(el.querySelector('.de-seg-rate'), s.rate);
        el.querySelector('.de-seg-rate').addEventListener('change', (e) => { s.rate = parseInt(e.target.value, 10) | 0; L.pieces[k] = null; segsChanged(L); });
        el.querySelector('.de-seg-used').addEventListener('change', (e) => { s.used = e.target.checked; segsChanged(L); });
        const mg = el.querySelector('.de-seg-merge');
        if (mg) mg.addEventListener('click', () => { if (mergeWithPrev(L, k)) segsChanged(L); });
        el.querySelector('.de-seg-no').addEventListener('click', () => playSeg(selected, k));
        for (const c of el.querySelectorAll('input, select, button')) c.addEventListener('mousedown', (e) => e.stopPropagation());
        segsEl.appendChild(el);
      });
      drawWave();
    }
    function onAutoCut() {
      const L = selLocal();
      if (!L) return;
      const n = autoCut(L);
      if (n) { segsChanged(L); setStatus(T('上限に収まるように {n} 区間へ切りました。境目をドラッグして調整できます', { n: L.segs.length }), 'ok'); }
    }
    function onPlayRaw() { if (selected != null) playRaw(selected); }
    function onPlayDpcm() { if (selected != null) playDpcm(selected); }

    function fitCanvas() {
      const w = Math.max(200, Math.floor(waveEl.clientWidth) - 2);
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
        for (let i = a; i < e && i < pcm.length; i++) { const v = pcm[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo > hi) continue;
        ctx.moveTo(x + 0.5, mid - hi * amp);
        ctx.lineTo(x + 0.5, mid - lo * amp + 1);
      }
      ctx.stroke();
    }
    function drawWave() {
      const L = selLocal();
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
        // 上: オリジナル(未使用は暗く)
        const a = Math.round(t0 * N), b = Math.max(a + 1, Math.round(t1 * N));
        // ★オリジナルは暗めの色にする。上に重ねる区間番号/サイズの文字が波形に埋もれないため
        drawLane(ctx, pcm.subarray(a, b), x0, x1, topA, LANE_H, s.used ? '#2f5680' : '#3b3e4a');
        // 下: DPCM(変換済みの区間だけ。ドラッグ中は捨ててあるので描かない=止めた時に出る)
        if (s.used && L.pieces[k]) drawLane(ctx, decodePiece(L.pieces[k]), x0, x1, topB, LANE_H, over ? '#ff8a7a' : '#8ad48a');
        // ラベル: 番号(大きめ) + バイト数/時間
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
        ctx.strokeStyle = k === dragIdx ? '#ffd166' : '#ffb347';
        ctx.lineWidth = k === dragIdx ? 2 : 1.5;
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

    // ── 境目のドラッグ / 区間クリックで試聴 / ダブルクリックで区切り追加 ──────────
    let dragIdx = -1;
    let dragMoved = false;
    let downX = 0;
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
    // クリックした縦位置がどちらのレーンか('raw'=上段オリジナル / 'dpcm'=下段)
    function laneAt(e) {
      const rc = canvas.getBoundingClientRect();
      const y = (e.clientY - rc.top) * (canvas.height / rc.height);
      return y < LANE_H + LANE_GAP / 2 ? 'raw' : 'dpcm';
    }
    function segAt(L, t) {
      for (let k = 0; k < L.segs.length; k++) { const [t0, t1] = segRange(L, k); if (t >= t0 && t < t1) return k; }
      return L.segs.length - 1;
    }
    // 境目kの移動先: 両隣の境目の内側(最小区間ぶんは空ける)。上限では拘束しない(超えたら赤で示す)
    function clampSplit(L, k, t) {
      const lo = segStart(L, k), hi = L.segs[k + 1].end;
      const minF = SNAP_SAMPLES / Math.max(1, srcLength(L));
      return snapFrac(L, clamp(t, lo + minF, hi - minF));
    }
    function onCanvasDown(e) {
      const L = selLocal();
      if (!L) return;
      e.preventDefault();
      downX = e.clientX; dragMoved = false;
      dragIdx = handleAt(L, e);
      drawWave();
    }
    window.addEventListener('mousemove', (e) => {
      const L = selLocal();
      if (!L || dragIdx < 0) return;
      if (Math.abs(e.clientX - downX) > 1) dragMoved = true;
      L.segs[dragIdx].end = clampSplit(L, dragIdx, fracAt(e));
      L.pieces[dragIdx] = null; L.pieces[dragIdx + 1] = null;
      drawWave();
    });
    window.addEventListener('mouseup', (e) => {
      const L = selLocal();
      if (!L) { dragIdx = -1; return; }
      if (dragIdx >= 0) {
        const moved = dragMoved;
        dragIdx = -1;
        if (moved) segsChanged(L); else drawWave();
        return;
      }
      if (e.target !== canvas) return;
      // 区間クリック → その区間だけ試聴。上段のオリジナルを押せば原音、下段を押せばDPCM変換後
      playSeg(selected, segAt(L, fracAt(e)), laneAt(e));
    });
    function onCanvasDblClick(e) {
      const L = selLocal();
      if (!L) return;
      stop();
      // 境目の上なら区切りを消す(前の区間と結合)、それ以外なら区切りを足す
      const h = handleAt(L, e);
      if (h >= 0) { if (mergeWithPrev(L, h + 1)) segsChanged(L); return; }
      const t = fracAt(e);
      if (splitAt(L, segAt(L, t), t)) segsChanged(L);
    }
    function onCanvasMove(e) {
      const L = selLocal();
      canvas.style.cursor = (!L) ? 'default' : (dragIdx >= 0 || handleAt(L, e) >= 0) ? 'ew-resize' : 'pointer';
    }

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
