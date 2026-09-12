/*
 * エンベロープエディタ(音量 / 音色 / ピッチ / ノート)
 * MML.UI.EnvelopeEditor
 *
 * MML本文中のフレーム単位テーブル定義を1つのウィンドウにまとめて編集する。
 *   @v<n>  = { ... }   音量エンベロープ(絶対値)          … 本文では @v<n>
 *   @vr<n> = { ... }   リリース音量(@vの定義を流用可)     … 本文では @vr<n>
 *   @<n>   = { ... }   デューティ(音色)エンベロープ(絶対値) … 本文では @@<n>
 *                      そのリリース版は @@r<n>(同じ @<n>={...} の別番号を指す)
 *   @EP<n> = { ... }   ピッチエンベロープ(生レジスタオフセット、各フレームの絶対値)
 *   @EN<n> = { ... }   ノートエンベロープ(半音、前フレームからの相対値の累積)
 *
 * ■ なぜ1画面か
 * この4つは組み合わせて使う技なので、レーンごとにON/OFFしながら1本の一時MMLを組んで
 * まとめて試聴できるようにした。時間軸(横=フレーム)は4レーン共通。
 *
 * ■ 対象音源セレクタ
 * テーブル定義自体はチップに紐づかない(どのチャンネルからでも同じ番号で呼べる)のに、
 * 効く範囲はチャンネルによって違う。そこで「本文を走査して使用先を推測する」のではなく
 * (ゼロから書き起こす時に推測のしようがないため)、対象音源を明示的に選ばせ、それだけを
 * 根拠に目盛り・上限・音色の行数・試聴チャンネルを決める。表の中身は対象音源を変えても
 * 一切書き換えない。
 *
 * ■ リリースの表示
 * 音量と音色のレーンは、1枚のキャンバスを「キーオフ」の縦線で2つに割り、左が本体の表
 * (@v/@)、右がリリースの表(@vr/@@r)。どちらの区画も自分の表と1対1に対応するので
 * 編集位置に迷いが無い(ループを展開した「実際に鳴る列」は描かない)。
 *
 * ■ ノートレーンだけ保存形式が違う
 * @EN はMML上「前回値からの相対値」でその累積が音程になる(compiler.js
 * cumulativeEnvelopeValue)。編集は「実際に鳴る音程の階段」を描く方が分かりやすいので、
 * ローカル状態は累積値で持ち、MMLへ書く直前に差分へ変換する(FDS変調テーブルの
 * computeModCurve/codesFromCurve と同じ考え方)。キャンバス上で1点を動かしても
 * その後ろの音程がずれないよう、次のフレームの差分で辻褄を合わせる。
 *
 * ■ 書き込みタイミング
 * FDS/N163/VRC7エディタと同じ規約: キャンバス編集・数値入力はローカルのみ更新し、
 * レーンごとの「反映」ボタンでMMLへ書き込む。「＋」(新規)だけは番号を確保するため即座に
 * 書き込む。MMLからの読み込みはインデックス選択時・ウィンドウを開いた時・
 * 定義のダブルクリック時だけ。定義ブロックの走査/書き戻しは src/mml/defBlocks.js。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => MML.I18n.t(key, params);
  const Defs = MML.Defs;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── 対象音源 ────────────────────────────────────────────────────────
  // letter: 試聴に使うチャンネル文字(実機ppmck固定割当。compiler.js assignExpansionLetters
  //   と同じ dpcm1=E / fds1=F / vrc7 6=G-L / vrc6 3=M-O / n163 8=P-W / fme7 3=X-Z / mmc5 2=a,b)
  // volMax: v<n>と@v<n>の最大値(compiler.js buildSegments の volMax と同じ)
  // volEff: 実機で実際に効く上限(これ以上は音が大きくならない)。目盛りに線を引くだけ
  // duty:   @<n>={...}(デューティエンベロープ)の段数。0=そのチャンネルには存在しない
  // pitch:  EP(ピッチエンベロープ)が使えるか。VRC7はfnum/blockの対数表現のため対象外
  const TARGETS = [
    { id: '2a03p', label: '2A03 パルス', letter: 'A', chip: null, volMax: 15, duty: 4, pitch: true },
    { id: '2a03t', label: '2A03 三角波', letter: 'C', chip: null, volMax: 0, duty: 0, pitch: true },
    { id: '2a03n', label: '2A03 ノイズ', letter: 'D', chip: null, volMax: 15, duty: 0, pitch: true },
    { id: 'vrc6p', label: 'VRC6 パルス', letter: 'M', chip: 'vrc6', volMax: 15, duty: 8, pitch: true },
    { id: 'vrc6s', label: 'VRC6 のこぎり波', letter: 'O', chip: 'vrc6', volMax: 63, volEff: 42, duty: 0, pitch: true },
    { id: 'mmc5p', label: 'MMC5 パルス', letter: 'a', chip: 'mmc5', volMax: 15, duty: 4, pitch: true },
    { id: 'fds', label: 'FDS', letter: 'F', chip: 'fds', volMax: 63, volEff: 32, duty: 0, pitch: true },
    { id: 'n163', label: 'N163', letter: 'P', chip: 'n163', volMax: 15, duty: 0, pitch: true },
    { id: 'fme7', label: 'FME7', letter: 'X', chip: 'fme7', volMax: 15, duty: 0, pitch: true },
    { id: 'vrc7', label: 'VRC7', letter: 'G', chip: 'vrc7', volMax: 15, duty: 0, pitch: false }
  ];

  // ── レーン ──────────────────────────────────────────────────────────
  // tag/relTag: defBlocks.js に渡す定義タグ(''=「@の直後が数字」形式)
  // cmd/relCmd: 本文側で呼ぶコマンド名
  // kind:      キャンバスの描き方 'bar'(0から上へ) / 'grid'(行選択) / 'signed'(中心から上下) /
  //            'step'(累積の階段)
  const LANES = [
    { key: 'v', tag: 'v', relTag: 'vr', cmd: '@v', relCmd: '@vr', label: '音量', kind: 'bar', color: '#6fb1ff' },
    { key: 'duty', tag: '', relTag: '', cmd: '@@', relCmd: '@@r', label: '音色', kind: 'grid', color: '#b48cff' },
    { key: 'ep', tag: 'EP', relTag: null, cmd: 'EP', label: 'ピッチ', kind: 'signed', color: '#ff9a5a' },
    { key: 'en', tag: 'EN', relTag: null, cmd: 'EN', label: 'ノート', kind: 'step', color: '#5ad4a0' }
  ];

  // 試聴用の一時定義に使う番号(他のエディタと同じく本文と衝突しにくい大きい番号)
  const TEMP_INDEX = 98;
  const TEMP_REL_INDEX = 99;

  const DEFAULT_LEN = 8;
  const CELL_W = 13;      // 1フレームの横幅(px)
  const LANE_H = { bar: 74, grid: 0, signed: 74, step: 86 }; // gridは行数×ROW_Hで決める
  const ROW_H = 15;

  // ── MML定義 ⇄ {values, loop} ────────────────────────────────────────
  // ループ位置はMML上 "|" の位置。省略時はnull(末尾の値を保持)
  function readTable(source, tag, index) {
    const tokens = Defs.tokens(source, tag, index);
    if (!tokens) return null;
    const values = [];
    let loop = null;
    for (const t of tokens) {
      if (t === '|') { loop = values.length; continue; }
      const n = Defs.parseNumber(t);
      values.push(Number.isFinite(n) ? n : 0);
    }
    return { values, loop };
  }

  // Defs.format は「区切り1種類で並べるだけ」なのでここでは使わない。ループ記号"|"は
  // 値ではなく区切りなので、"12, |, 11" ではなく手書きと同じ "12 | 11" の形で書きたい
  // (コンパイラはどちらも読めるが、人が書いた既存MMLと見た目を揃える)
  function formatTable(tag, index, values, loop) {
    const rows = [];
    let row = '';
    for (let i = 0; i < values.length; i++) {
      if (i > 0 && i % 16 === 0) { rows.push(row); row = ''; }
      if (loop === i) row += row ? ' | ' : '| ';
      else if (row) row += ', ';
      row += String(values[i]);
    }
    rows.push(row);
    return `@${tag}${index} = { ${rows.join('\n        ')} }`;
  }

  // ノートレーン専用: 相対値(MML) ⇄ 累積値(編集表示)
  function deltasToCum(deltas) {
    let acc = 0;
    return deltas.map((d) => (acc += d));
  }
  function cumToDeltas(cum) {
    let acc = 0;
    return cum.map((c) => { const d = c - acc; acc = c; return d; });
  }

  // ── キャンバス1枚(本体の表 + リリースの表) ─────────────────────────
  // zones: [{ values, loop, editable }] の1つか2つ。2つ目はリリース。
  // 値の編集は onEdit(zoneIndex, frameIndex, value) で呼び出し側へ返す
  class LaneCanvas {
    constructor(canvas, lane, onEdit, onSetLoop) {
      this.canvas = canvas;
      this.lane = lane;
      this.onEdit = onEdit;
      this.onSetLoop = onSetLoop;
      this.zones = [];
      this.range = { min: 0, max: 15, rows: 0 };
      this.dragging = false;
      canvas.addEventListener('mousedown', (e) => {
        if (e.shiftKey) { this.setLoopAt(e); return; }
        this.dragging = true;
        this.paintAt(e);
      });
      canvas.addEventListener('mousemove', (e) => { if (this.dragging) this.paintAt(e); });
      global.addEventListener('mouseup', () => { this.dragging = false; });
    }

    setZones(zones, range) {
      this.zones = zones;
      this.range = range;
      const total = zones.reduce((n, z) => n + z.values.length, 0);
      this.canvas.width = Math.max(1, total) * CELL_W + (zones.length > 1 ? 3 : 0);
      this.canvas.height = this.lane.kind === 'grid' ? Math.max(2, range.rows) * ROW_H : LANE_H[this.lane.kind];
      this.draw();
    }

    // キャンバスx座標 → { zone, frame }。区画の境目(3px)の上はnull
    hit(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      let base = 0;
      for (let z = 0; z < this.zones.length; z++) {
        const len = this.zones[z].values.length;
        const left = base * CELL_W + (z > 0 ? 3 : 0);
        const right = left + len * CELL_W;
        if (x >= left && x < right) return { zone: z, frame: Math.floor((x - left) / CELL_W), x, rect };
        base += len;
      }
      // 右端ちょうどは最後の区画の最後のフレーム扱い
      const last = this.zones.length - 1;
      if (last >= 0 && x >= 0) return { zone: last, frame: this.zones[last].values.length - 1, x, rect };
      return null;
    }

    valueAt(e) {
      const rect = this.canvas.getBoundingClientRect();
      const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const h = this.canvas.height;
      if (this.lane.kind === 'grid') {
        return clamp(this.range.rows - 1 - Math.floor(y / ROW_H), 0, this.range.rows - 1);
      }
      const { min, max } = this.range;
      return Math.round(min + (max - min) * (1 - clamp(y, 0, h) / h));
    }

    paintAt(e) {
      const hit = this.hit(e);
      if (!hit || hit.frame < 0) return;
      this.onEdit(hit.zone, hit.frame, clamp(this.valueAt(e), this.range.min, this.range.max));
    }

    setLoopAt(e) {
      const hit = this.hit(e);
      if (!hit || hit.frame < 0) return;
      this.onSetLoop(hit.zone, hit.frame);
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, w, h);
      if (!this.zones.length) return;

      const { min, max, rows } = this.range;
      const isGrid = this.lane.kind === 'grid';
      const yOf = (v) => h - ((v - min) / (max - min || 1)) * h;

      // 横罫線(gridは行、それ以外は4分割。signedは中心線を濃く)
      ctx.strokeStyle = '#26262f';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (isGrid) {
        for (let r = 1; r < rows; r++) { const y = r * ROW_H + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      } else {
        for (let i = 1; i < 4; i++) { const y = Math.round((i / 4) * h) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      }
      ctx.stroke();

      let base = 0;
      for (let z = 0; z < this.zones.length; z++) {
        const zone = this.zones[z];
        const ox = base * CELL_W + (z > 0 ? 3 : 0);
        const len = zone.values.length;

        // 縦罫線(4フレームごと)
        ctx.strokeStyle = '#21212a';
        ctx.beginPath();
        for (let i = 4; i < len; i += 4) { const x = Math.round(ox + i * CELL_W) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        ctx.stroke();

        ctx.fillStyle = z === 0 ? this.lane.color : this.lane.color + '80';
        for (let i = 0; i < len; i++) {
          const v = clamp(zone.values[i], min, max);
          const x = ox + i * CELL_W;
          const cw = Math.max(1, CELL_W - 2);
          if (isGrid) {
            ctx.fillRect(x, (rows - 1 - clamp(v, 0, rows - 1)) * ROW_H + 2, cw, ROW_H - 4);
          } else if (this.lane.kind === 'bar') {
            const y = yOf(v);
            ctx.fillRect(x, y, cw, Math.max(1, h - y));
          } else if (this.lane.kind === 'signed') {
            const y0 = yOf(0), y = yOf(v);
            ctx.fillRect(x, Math.min(y0, y), cw, Math.max(1, Math.abs(y - y0)));
          } else {
            ctx.fillRect(x, yOf(v) - 1.5, cw, 3);
          }
        }

        // ループ位置(縦の破線)
        if (zone.loop != null && zone.loop >= 0 && zone.loop < len) {
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#e0a030';
          ctx.beginPath();
          const x = Math.round(ox + zone.loop * CELL_W) + 0.5;
          ctx.moveTo(x, 0); ctx.lineTo(x, h);
          ctx.stroke();
          ctx.restore();
        }
        base += len;
      }

      // 区画の境目(キーオフ)
      if (this.zones.length > 1) {
        const x = this.zones[0].values.length * CELL_W;
        ctx.fillStyle = '#e05a5a';
        ctx.fillRect(x, 0, 3, h);
      }

      // 0の位置(signed)と実効上限(bar)
      ctx.strokeStyle = '#5a5a68';
      ctx.beginPath();
      const baseY = this.lane.kind === 'signed' ? yOf(0) : h;
      ctx.moveTo(0, Math.round(baseY) - 0.5); ctx.lineTo(w, Math.round(baseY) - 0.5);
      ctx.stroke();
      if (this.range.eff != null && this.range.eff < max) {
        ctx.save();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = '#8a8a98';
        ctx.beginPath();
        const y = Math.round(yOf(this.range.eff)) + 0.5;
        ctx.moveTo(0, y); ctx.lineTo(w, y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  UI.EnvelopeEditor = {
    init(mmlSourceEl) {
      const rootEl = document.getElementById('envelopeEditor');
      if (!rootEl) return;
      const win = document.getElementById('win-envelope');
      const toggleBtn = document.querySelector('.toggle-btn[data-target="win-envelope"]');

      let target = TARGETS[0];
      let audioCtx = null;
      let activePlayer = null;
      // レーンごとのローカル状態。valuesはノートレーンだけ累積値(MMLは相対値)
      const state = new Map();
      for (const lane of LANES) {
        state.set(lane.key, {
          on: lane.key === 'v',
          index: 0, values: new Array(DEFAULT_LEN).fill(lane.key === 'v' ? 15 : 0), loop: null,
          relOn: false, relIndex: 0, relIndexTouched: false,
          relValues: new Array(4).fill(0), relLoop: null,
          range: lane.key === 'ep' ? 32 : 12,  // 中心0の上下(ピッチ/ノートだけ使う)
          dirty: false
        });
      }
      // シェルを作り直しても残すもの(言語切替時)
      let helpOpen = false;
      let phraseDirty = false;
      let phraseText = '';
      let gate = 6;

      // 要素参照(buildShellで持ち直す)
      let els = {};
      const canvases = new Map();

      // ── シェル ────────────────────────────────────────────────────
      function laneHtml(lane) {
        // ピッチ/ノートは中心0の上下なので、縦の目盛り幅を数値で指定できるようにする
        // (EPの生レジスタオフセットは曲によって数値の桁が全く違うため、固定だと潰れる)
        const rangeBox = (lane.kind === 'signed' || lane.kind === 'step')
          ? `<label>${T('範囲')} ±<input type="number" class="env-range" min="1" max="127" style="width:44px" /></label>`
          : '';
        const extra = rangeBox + (lane.key === 'en'
          ? `<span class="env-lane-extra"><input type="text" class="env-en-chord" size="7" value="0,4,7"`
            + ` title="${T('和音を半音の並びで指定します(0=音符そのもの)')}" />`
            + `<input type="number" class="env-en-step" min="1" max="16" value="1" style="width:38px"`
            + ` title="${T('1音あたりのフレーム数')}" />`
            + `<button type="button" class="secondary env-en-gen" title="${T('和音とフレーム数からアルペジオの表を作る')}">${T('和音生成')}</button></span>`
          : '');
        const rel = lane.relTag == null ? '' :
          `<label class="env-lane-relon"><input type="checkbox" class="env-rel-on" />${T('リリース')}</label>` +
          `<select class="env-rel-index" title="${T('インデックス')}"></select>` +
          `<label>${T('長さ')}<input type="number" class="env-rel-len" min="1" max="128" style="width:42px" /></label>` +
          `<label>${T('ループ')}<input type="number" class="env-rel-loop" min="0" max="127" style="width:42px" placeholder="${T('なし')}" /></label>`;
        return `<div class="env-lane" data-lane="${lane.key}">` +
          `<div class="toolbar env-lane-bar">` +
            `<label class="env-lane-on"><input type="checkbox" class="env-on" /><b>${lane.cmd}</b> ${T(lane.label)}</label>` +
            `<button type="button" class="secondary env-add" title="${T('新規定義を追加')}">＋</button>` +
            `<select class="env-index" title="${T('インデックス')}"></select>` +
            `<label>${T('長さ')}<input type="number" class="env-len" min="1" max="128" style="width:42px" /></label>` +
            `<label>${T('ループ')}<input type="number" class="env-loop" min="0" max="127" style="width:42px" placeholder="${T('なし')}" /></label>` +
            extra + rel +
            `<button type="button" class="env-apply" title="${T('現在の内容をMMLへ反映')}">${T('反映')}</button>` +
          `</div>` +
          `<div class="env-lane-canvas-wrap"><canvas class="env-lane-canvas"></canvas></div>` +
          `<div class="fds-values-text env-lane-values"></div>` +
          `<div class="env-lane-disabled" style="display:none;"></div>` +
        `</div>`;
      }

      function shellHtml() {
        return `<div class="env-ed compact-wave-editor">` +
          `<div class="toolbar env-ed-top">` +
            `<label>${T('対象音源')}<select class="env-target">` +
              TARGETS.map((t) => `<option value="${t.id}">${T(t.label)}</option>`).join('') +
            `</select></label>` +
            `<span class="env-scale"></span>` +
            `<button type="button" class="secondary env-help-btn" title="${T('説明を表示/非表示')}">❓</button>` +
          `</div>` +
          `<div class="fds-help-text env-help" style="display:none;">` +
            T('4つのエンベロープを同じ時間軸(横1マス=1フレーム)で編集します。テーブル定義はチャンネルに紐づかないので、目盛り・音色の段数・試聴先は「対象音源」だけで決まります(表の中身は音源を変えても書き換えません)。キャンバスはドラッグで編集、Shift+クリックでループ位置(MMLの"|")を指定します。音量と音色は赤い縦線から右がリリースの表(@vr/@@r)で、区画ごとに自分の表と1対1に対応します。ノート(@EN)はMML上は前回値からの相対値ですが、ここでは実際に鳴る音程の階段を描き、反映のときに差分へ変換します。編集はこのウィンドウの中だけで、「反映」を押すまでMML本文は変わりません。') +
          `</div>` +
          `<div class="env-lanes">` + LANES.map(laneHtml).join('') + `</div>` +
          `<h3>${T('試聴')}</h3>` +
          `<div class="toolbar">` +
            `<label>${T('ゲート')} q<input type="number" class="env-gate" min="0" max="8" style="width:38px" /></label>` +
            `<button type="button" class="env-play" title="${T('サンプル再生')}">▶</button>` +
            `<button type="button" class="secondary env-stop" title="${T('停止')}">■</button>` +
            `<span class="env-note">${T('チェックを入れたレーンだけが鳴ります')}</span>` +
          `</div>` +
          `<textarea class="fds-sample-mml env-phrase" spellcheck="false"></textarea>` +
          `<div class="output fds-status-output env-status"></div>` +
        `</div>`;
      }

      function q(sel, root) { return (root || rootEl).querySelector(sel); }

      function buildShell() {
        rootEl.innerHTML = shellHtml();
        els = {
          target: q('.env-target'), scale: q('.env-scale'),
          help: q('.env-help'), helpBtn: q('.env-help-btn'),
          gate: q('.env-gate'), play: q('.env-play'), stop: q('.env-stop'),
          phrase: q('.env-phrase'), status: q('.env-status'),
          lanes: new Map()
        };
        els.help.style.display = helpOpen ? 'block' : 'none';
        els.target.value = target.id;
        els.gate.value = String(gate);
        canvases.clear();
        for (const lane of LANES) {
          const root = q(`.env-lane[data-lane="${lane.key}"]`);
          const e = {
            root,
            on: q('.env-on', root), add: q('.env-add', root), index: q('.env-index', root),
            len: q('.env-len', root), loop: q('.env-loop', root), apply: q('.env-apply', root),
            relOn: q('.env-rel-on', root), relIndex: q('.env-rel-index', root),
            relLen: q('.env-rel-len', root), relLoop: q('.env-rel-loop', root),
            canvas: q('.env-lane-canvas', root), values: q('.env-lane-values', root),
            disabled: q('.env-lane-disabled', root), range: q('.env-range', root),
            chord: q('.env-en-chord', root), step: q('.env-en-step', root), gen: q('.env-en-gen', root)
          };
          els.lanes.set(lane.key, e);
          canvases.set(lane.key, new LaneCanvas(e.canvas, lane,
            (zone, frame, value) => editValue(lane, zone, frame, value),
            (zone, frame) => setLoop(lane, zone, frame)));
          wireLane(lane, e);
        }
        wireShell();
        refreshAll();
      }

      // ── レーンごとの配線 ──────────────────────────────────────────
      function wireLane(lane, e) {
        const s = state.get(lane.key);
        e.on.addEventListener('change', () => { s.on = e.on.checked; regeneratePhrase(); });
        e.index.addEventListener('mousedown', () => refreshIndexSelect(lane));
        e.index.addEventListener('change', () => {
          s.index = parseInt(e.index.value, 10) || 0;
          defaultRelIndex(lane);
          loadLane(lane);
          regeneratePhrase();
        });
        e.len.addEventListener('change', () => { setLength(lane, 0, parseInt(e.len.value, 10) || 1); });
        e.loop.addEventListener('change', () => {
          const v = e.loop.value.trim();
          s.loop = v === '' ? null : clamp(parseInt(v, 10) || 0, 0, s.values.length - 1);
          markDirty(lane); renderLane(lane);
        });
        e.apply.addEventListener('click', () => applyLane(lane));
        e.add.addEventListener('click', () => addDef(lane, false));
        if (e.range) {
          e.range.addEventListener('change', () => {
            s.range = clamp(parseInt(e.range.value, 10) || 1, 1, 127);
            renderLane(lane);
          });
        }
        if (e.relOn) {
          e.relOn.addEventListener('change', () => {
            s.relOn = e.relOn.checked;
            if (s.relOn) { defaultRelIndex(lane); loadLane(lane); }
            renderLane(lane); regeneratePhrase();
          });
          e.relIndex.addEventListener('mousedown', () => refreshIndexSelect(lane));
          e.relIndex.addEventListener('change', () => {
            s.relIndex = parseInt(e.relIndex.value, 10) || 0;
            s.relIndexTouched = true;
            loadLane(lane); regeneratePhrase();
          });
          e.relLen.addEventListener('change', () => { setLength(lane, 1, parseInt(e.relLen.value, 10) || 1); });
          e.relLoop.addEventListener('change', () => {
            const v = e.relLoop.value.trim();
            s.relLoop = v === '' ? null : clamp(parseInt(v, 10) || 0, 0, s.relValues.length - 1);
            markDirty(lane); renderLane(lane);
          });
        }
        if (e.gen) {
          e.gen.addEventListener('click', () => {
            const notes = e.chord.value.split(/[\s,]+/).filter(Boolean)
              .map((t) => parseInt(t, 10)).filter((n) => Number.isFinite(n));
            if (!notes.length) return;
            const step = clamp(parseInt(e.step.value, 10) || 1, 1, 16);
            const cum = [];
            for (const n of notes) for (let k = 0; k < step; k++) cum.push(clamp(n, -48, 48));
            // 最後に基準音へ戻る1フレームを足し、ループ位置を1にする。こうするとループ区間の
            // 相対値の合計が0になり、何周しても音程がずれない(本家ppmckの @EN0={0 | 4 3 -7}
            // と同じ形。合計が0でないと1周ごとに上がり続ける)
            cum.push(cum[0]);
            s.values = cum;
            s.loop = 1;
            markDirty(lane); renderLane(lane);
          });
        }
      }

      function wireShell() {
        els.target.addEventListener('change', () => {
          target = TARGETS.find((t) => t.id === els.target.value) || TARGETS[0];
          refreshAll();
          regeneratePhrase();
        });
        els.helpBtn.addEventListener('click', () => {
          helpOpen = els.help.style.display === 'none';
          els.help.style.display = helpOpen ? 'block' : 'none';
        });
        els.gate.addEventListener('change', () => {
          gate = clamp(parseInt(els.gate.value, 10), 0, 8);
          if (!Number.isFinite(gate)) gate = 6;
          els.gate.value = String(gate);
          regeneratePhrase();
        });
        els.phrase.addEventListener('input', () => { phraseDirty = true; phraseText = els.phrase.value; });
        els.play.addEventListener('click', playSample);
        els.stop.addEventListener('click', () => {
          stopPlayback();
          els.status.className = 'output fds-status-output env-status';
          els.status.textContent = T('停止');
        });
      }

      // リリース側の既定番号。音量は本家ppmckの書き方(`@v1={...}` を定義して `@vr1` で呼ぶ)に
      // 倣って本体と同じ番号にする。音色のリリース(@@r<n>)は同じ @<n>={...} の別番号を指すので、
      // 本体と同じ番号では上書きになってしまう。空き番号を取る
      function defaultRelIndex(lane) {
        const s = state.get(lane.key);
        if (s.relIndexTouched) return;
        s.relIndex = lane.relTag === lane.tag
          ? Defs.nextFreeIndex(mmlSourceEl.value, lane.tag, [s.index])
          : s.index;
      }

      // ── レーンが使えるか(対象音源しだい) ──────────────────────────
      function laneAvailability(lane) {
        if (lane.key === 'v' && target.volMax === 0) {
          return T('三角波には音量制御そのものがありません(@vは使えません)');
        }
        if (lane.key === 'duty' && target.duty === 0) {
          return T('このチャンネルにはデューティ(音色)エンベロープがありません。波形や音色番号を持つチップ(FDS/N163/VRC7)では @@<n> は @<n> と同じ音色選択になります');
        }
        if (lane.key === 'ep' && !target.pitch) {
          return T('VRC7はfnum/blockの対数的な音程表現のため、EP(生レジスタへの加算)は対象外です');
        }
        return null;
      }

      // 値の範囲(目盛り)。対象音源だけで決まる
      function rangeOf(lane) {
        if (lane.key === 'v') return { min: 0, max: Math.max(1, target.volMax), rows: 0, eff: target.volEff };
        if (lane.key === 'duty') return { min: 0, max: Math.max(1, target.duty - 1), rows: Math.max(2, target.duty) };
        const r = state.get(lane.key).range || (lane.key === 'ep' ? 32 : 12);
        return { min: -r, max: r, rows: 0 };
      }

      // ── 編集 ──────────────────────────────────────────────────────
      function markDirty(lane) {
        const s = state.get(lane.key);
        s.dirty = true;
        els.lanes.get(lane.key).apply.classList.add('apply-btn--dirty');
      }

      function editValue(lane, zone, frame, value) {
        const s = state.get(lane.key);
        const arr = zone === 0 ? s.values : s.relValues;
        if (frame < 0 || frame >= arr.length) return;
        // ノートレーンのローカル状態は累積値(=鳴る音程)なので、1マス動かしても後ろの音程は
        // 動かない。MMLへ書く直前のcumToDeltasが、そのフレームと次のフレームの相対値を
        // 自動的に辻褄の合う値へ作り直す
        arr[frame] = value;
        markDirty(lane);
        renderLane(lane);
      }

      function setLoop(lane, zone, frame) {
        const s = state.get(lane.key);
        if (zone === 0) s.loop = (s.loop === frame) ? null : frame;
        else s.relLoop = (s.relLoop === frame) ? null : frame;
        markDirty(lane);
        renderLane(lane);
      }

      function setLength(lane, zone, len) {
        const s = state.get(lane.key);
        len = clamp(len, 1, 128);
        const key = zone === 0 ? 'values' : 'relValues';
        const arr = s[key].slice(0, len);
        const fill = arr.length ? arr[arr.length - 1] : 0;
        while (arr.length < len) arr.push(fill);
        s[key] = arr;
        const loopKey = zone === 0 ? 'loop' : 'relLoop';
        if (s[loopKey] != null && s[loopKey] >= len) s[loopKey] = null;
        markDirty(lane);
        renderLane(lane);
      }

      // ── 表示 ──────────────────────────────────────────────────────
      function renderLane(lane) {
        const s = state.get(lane.key);
        const e = els.lanes.get(lane.key);
        const reason = laneAvailability(lane);
        e.disabled.textContent = reason || '';
        e.disabled.style.display = reason ? 'block' : 'none';
        e.root.classList.toggle('env-lane--off', !!reason);
        e.on.disabled = !!reason;
        if (reason) s.on = false;
        e.on.checked = s.on && !reason;

        const zones = [{ values: s.values, loop: s.loop }];
        if (lane.relTag != null && s.relOn) zones.push({ values: s.relValues, loop: s.relLoop });
        canvases.get(lane.key).setZones(zones, rangeOf(lane));

        e.len.value = String(s.values.length);
        e.loop.value = s.loop == null ? '' : String(s.loop);
        if (e.range) e.range.value = String(s.range);
        if (e.relOn) {
          e.relOn.checked = s.relOn;
          e.relIndex.disabled = !s.relOn;
          e.relLen.disabled = !s.relOn;
          e.relLoop.disabled = !s.relOn;
          e.relLen.value = String(s.relValues.length);
          e.relLoop.value = s.relLoop == null ? '' : String(s.relLoop);
        }
        e.values.textContent = valuesText(lane);
      }

      // 下に出す1行テキスト。ノートレーンは「MMLに書かれる相対値」と「鳴る音程」の両方を出す
      function valuesText(lane) {
        const s = state.get(lane.key);
        const withLoop = (vals, loop) => {
          const parts = vals.map(String);
          if (loop != null && loop < parts.length) parts.splice(loop, 0, '|');
          return parts.join(' ');
        };
        if (lane.key === 'en') {
          const deltas = cumToDeltas(s.values);
          const sum = s.loop == null ? 0 : deltas.slice(s.loop).reduce((a, b) => a + b, 0);
          const warn = (s.loop != null && sum !== 0)
            ? '  ' + T('※ループ区間の合計が{n}半音なので、ループのたびに音程がずれ続けます', { n: sum })
            : '';
          return `@EN: ${withLoop(deltas, s.loop)}   (${T('鳴る音程')}: ${s.values.join(' ')})${warn}`;
        }
        let text = withLoop(s.values, s.loop);
        if (lane.relTag != null && s.relOn) text += `   ${T('リリース')}: ` + withLoop(s.relValues, s.relLoop);
        return text;
      }

      function refreshIndexSelect(lane) {
        const s = state.get(lane.key);
        const e = els.lanes.get(lane.key);
        const fill = (selectEl, tag, current) => {
          if (!selectEl) return;
          const list = Defs.indices(mmlSourceEl.value, tag);
          const want = String(current);
          selectEl.innerHTML = '';
          for (const idx of (list.length ? list : [current])) {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = String(idx);
            selectEl.appendChild(opt);
          }
          if (![...selectEl.options].some((o) => o.value === want)) {
            const opt = document.createElement('option');
            opt.value = want;
            opt.textContent = want + ' *'; // まだMMLに無い番号
            selectEl.appendChild(opt);
          }
          selectEl.value = want;
        };
        fill(e.index, lane.tag, s.index);
        // リリース側は @vr/@ のどちらを引くかがレーンで違う(音色のリリースは @<n> の別番号)
        if (e.relIndex) fill(e.relIndex, lane.relTag, s.relIndex);
      }

      // ── MMLからの読み込み ────────────────────────────────────────
      function loadLane(lane) {
        const s = state.get(lane.key);
        const src = mmlSourceEl.value;
        const main = readTable(src, lane.tag, s.index);
        if (main) {
          s.values = lane.key === 'en' ? deltasToCum(main.values) : main.values.slice();
          s.loop = main.loop;
        }
        if (lane.relTag != null) {
          // @vr<n> の定義が無ければ本家ppmck同様 @v<n> を参照する(compiler.js resolveEnvTables)
          let rel = readTable(src, lane.relTag, s.relIndex);
          if (!rel && lane.relTag === 'vr') rel = readTable(src, 'v', s.relIndex);
          if (rel) { s.relValues = rel.values.slice(); s.relLoop = rel.loop; }
        }
        if (!s.values.length) s.values = new Array(DEFAULT_LEN).fill(0);
        // ピッチ/ノートの縦の目盛りは読み込んだ表に合わせて自動で広げる
        // (EPの値は曲によって桁が全く違い、固定目盛りだと潰れて掴めないため)
        if (lane.kind === 'signed' || lane.kind === 'step') {
          const peak = Math.max(...s.values.map((v) => Math.abs(v)), 0);
          s.range = clamp(Math.max(lane.key === 'ep' ? 8 : 12, Math.ceil(peak * 1.25)), 1, 127);
        }
        s.dirty = false;
        els.lanes.get(lane.key).apply.classList.remove('apply-btn--dirty');
        renderLane(lane);
      }

      function refreshAll() {
        els.scale.textContent = scaleText();
        for (const lane of LANES) {
          refreshIndexSelect(lane);
          renderLane(lane);
        }
      }

      function scaleText() {
        const vol = target.volMax === 0 ? T('音量なし')
          : target.volEff ? T('音量 0-{max}(実効{eff}で頭打ち)', { max: target.volMax, eff: target.volEff })
            : T('音量 0-{max}', { max: target.volMax });
        const duty = target.duty ? T('音色 0-{max}', { max: target.duty - 1 }) : T('音色エンベロープなし');
        return `${vol} / ${duty} / ${T('試聴ch')} ${target.letter}`;
      }

      // ── MMLへの書き込み ──────────────────────────────────────────
      function tableTextFor(lane, index, zone) {
        const s = state.get(lane.key);
        if (zone === 0) {
          const vals = lane.key === 'en' ? cumToDeltas(s.values) : s.values;
          return formatTable(lane.tag, index, vals, s.loop);
        }
        return formatTable(lane.relTag, index, s.relValues, s.relLoop);
      }

      function applyLane(lane) {
        const s = state.get(lane.key);
        Defs.write(mmlSourceEl, lane.tag, s.index, tableTextFor(lane, s.index, 0));
        if (lane.relTag != null && s.relOn) {
          Defs.write(mmlSourceEl, lane.relTag, s.relIndex, tableTextFor(lane, s.relIndex, 1));
        }
        s.dirty = false;
        els.lanes.get(lane.key).apply.classList.remove('apply-btn--dirty');
        refreshIndexSelect(lane);
        checkCompileErrors();
      }

      function addDef(lane, isRel) {
        const s = state.get(lane.key);
        const tag = isRel ? lane.relTag : lane.tag;
        const next = Defs.nextFreeIndex(mmlSourceEl.value, tag, []);
        if (isRel) s.relIndex = next; else s.index = next;
        Defs.write(mmlSourceEl, tag, next, tableTextFor(lane, next, isRel ? 1 : 0));
        refreshIndexSelect(lane);
        loadLane(lane);
        regeneratePhrase();
      }

      function checkCompileErrors() {
        const compiled = MML.Mml.compile(mmlSourceEl.value, {});
        if (compiled.errors.length > 0) {
          els.status.className = 'output fds-status-output env-status error';
          els.status.textContent = T('エラー:') + '\n' +
            compiled.errors.map((e) => (e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message)).join('\n');
        } else {
          els.status.className = 'output fds-status-output env-status';
          els.status.textContent = '';
        }
      }

      // ── 試聴 ──────────────────────────────────────────────────────
      // ONにしたレーンぶんだけコマンドを並べる。定義は一時番号で上書きするので
      // 「反映」を押していない編集中の内容がそのまま鳴る
      function activeCommands(tempIdx, tempRelIdx) {
        const cmds = [];
        for (const lane of LANES) {
          const s = state.get(lane.key);
          if (!s.on || laneAvailability(lane)) continue;
          cmds.push(lane.cmd + tempIdx);
          if (lane.relTag != null && s.relOn) cmds.push(lane.relCmd + tempRelIdx);
        }
        return cmds;
      }

      function regeneratePhrase() {
        if (phraseDirty) return;
        const cmds = activeCommands(TEMP_INDEX, TEMP_REL_INDEX).join(' ');
        phraseText = `${target.letter} q${gate} ${cmds} o4 l4 cdefgab>c`.replace(/\s+/g, ' ');
        if (els.phrase) els.phrase.value = phraseText;
      }

      function stopPlayback() {
        if (activePlayer) { activePlayer.destroy(); activePlayer = null; }
      }

      function playSample() {
        stopPlayback();
        if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
        audioCtx.resume();

        let defText = Defs.definitionLines(mmlSourceEl.value);
        if (target.chip) {
          const directive = MML.Mml.EX_CHIP_DIRECTIVE[target.chip];
          const re = new RegExp('^\\s*' + directive.replace(/[-]/g, '\\-') + '\\b', 'im');
          // N163は本家綴り(#EX-NAMCO106)でも通るのでどちらかがあれば足さない
          const already = target.chip === 'n163'
            ? /^\s*#EX-(N163|NAMCO106)\b/im.test(defText) : re.test(defText);
          if (!already) defText = directive + '\n' + defText;
        }
        // 編集中の内容を一時番号の定義として重ねる(後勝ちではなく別番号なので本文は汚さない)
        const live = [];
        for (const lane of LANES) {
          const s = state.get(lane.key);
          if (!s.on || laneAvailability(lane)) continue;
          live.push(tableTextFor(lane, TEMP_INDEX, 0));
          if (lane.relTag != null && s.relOn) live.push(tableTextFor(lane, TEMP_REL_INDEX, 1));
        }
        const phrase = (els.phrase.value.trim() || phraseText);
        const tempSource = defText + '\n' + live.join('\n') + '\n' + phrase + '\n';

        const compiled = MML.Mml.compile(tempSource, {});
        els.status.className = 'output fds-status-output env-status';
        if (compiled.errors.length > 0) {
          els.status.classList.add('error');
          els.status.textContent = T('エラー:') + '\n' +
            compiled.errors.map((e) => (e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message)).join('\n');
          return;
        }
        const player = new MML.Audio.MmlStreamPlayer(audioCtx);
        player.load(compiled, null);
        player.onEnded = () => { activePlayer = null; els.status.textContent = T('再生終了'); };
        player.play();
        activePlayer = player;
        els.status.classList.add('ok');
        els.status.textContent = T('再生中...');
      }

      // ── ウィンドウを開いた時 / 定義のダブルクリック ──────────────
      function reloadAll() {
        for (const lane of LANES) { refreshIndexSelect(lane); loadLane(lane); }
        els.scale.textContent = scaleText();
        regeneratePhrase();
      }

      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          if (win && win.style.display === 'none') return; // 閉じる操作
          reloadAll();
        });
      }

      // ダブルクリックした定義に対応するレーンを開く。@<n>(デューティ)は
      // 他のタグと紛れないよう最後に試す(defBlocks側で長いタグから順に当たる)
      const DBL_TAGS = [['v', 'v'], ['vr', 'v'], ['EP', 'ep'], ['EN', 'en'], ['', 'duty']];
      mmlSourceEl.addEventListener('dblclick', () => {
        const pos = mmlSourceEl.selectionStart;
        for (const [tag, laneKey] of DBL_TAGS) {
          const hit = Defs.enclosing(mmlSourceEl.value, pos, tag);
          if (!hit) continue;
          const lane = LANES.find((l) => l.key === laneKey);
          const s = state.get(laneKey);
          if (tag === 'vr') { s.relOn = true; s.relIndex = hit.index; } else { s.index = hit.index; }
          if (win && win.style.display === 'none') {
            if (toggleBtn) toggleBtn.click();
          } else if (win && win._famimmlWindow) {
            win._famimmlWindow.bringToFront();
          }
          refreshIndexSelect(lane);
          loadLane(lane);
          regeneratePhrase();
          els.lanes.get(laneKey).root.scrollIntoView({ block: 'nearest' });
          return;
        }
      });

      // ── 初期化 ────────────────────────────────────────────────────
      buildShell();
      reloadAll();
      if (MML.I18n && MML.I18n.onChange) {
        MML.I18n.onChange(() => { buildShell(); reloadAll(); });
      }
    }
  };
})(window);
