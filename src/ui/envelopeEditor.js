/*
 * エンベロープエディタ(音量 / 音色 / ピッチ / ノート)
 * MML.UI.EnvelopeEditor
 *
 * MML本文中のフレーム単位テーブル定義を1つのウィンドウにまとめて編集する。
 *   @v<n>  = { ... }   音量エンベロープ(絶対値)          … 本文では @v<n>
 *   @vr<n> = { ... }   リリース音量(@vの定義を流用可)     … 本文では @vr<n>
 *   @<n>   = { ... }   デューティ(音色)エンベロープ(絶対値) … 本文では @@<n>
 *                      そのリリース版は @@r<n>(同じ @<n>={...} の別番号を指す)
 *   @EP<n> = { ... }   ピッチエンベロープ(生レジスタオフセット、前フレームからの差分の累積)
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
 * ■ ピッチ/ノートレーンは保存形式が違う
 * @EN はMML上「前回値からの相対値」でその累積が音程になる(compiler.js
 * cumulativeEnvelopeValue)。@EP もppmck準拠で同じ「差分の累積」(2026-09-13修正、
 * compiler.js pitchEnvelopeValue)。編集は「実際に鳴る音程/オフセットの階段」を描く方が
 * 分かりやすいので、ローカル状態は累積値で持ち、MMLへ書く直前に差分へ変換する(FDS変調テーブルの
 * computeModCurve/codesFromCurve と同じ考え方)。キャンバス上で1点を動かしても
 * その後ろの音程がずれないよう、次のフレームの差分で辻褄を合わせる。非ループの@EPは実機が
 * 末尾の差分を足し続けるため、末尾の差分が0でなければ書き出し時に0を足して止める
 * (描いた形のまま保持される)。
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
  // volEff: 実機で実際に効く上限(これ以上は音が大きくならない)。エディタの目盛りの最大はこちら
  //   (2026-09-14方針「FDSとVRC6ノコギリ波は実質の上限値をMAXに」。MML上は63まで書けるが、
  //    効かない範囲を描かせても意味が無い。既存の表に上限超えの値があれば上限に張り付いて描かれる)
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
    { id: 'fme7', label: 'SUNSOFT 5B', letter: 'X', chip: 'fme7', volMax: 15, duty: 0, pitch: true },
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
  const MAX_LEN = 128;
  const CELL_W = 13;      // 1フレームの横幅(px)
  const LANE_H = { bar: 74, grid: 0, signed: 74, step: 86 }; // 値の区画の高さ。gridは行数×ROW_H
  const ROW_H = 15;
  // キャンバス上端の目盛り帯。ループ位置と終端(長さ)のつまみはここに置く。値の区画でドラッグすると
  // 値を描いてしまうので、つまみのドラッグは帯の中だけで受ける(ダブルクリックはどちらでも効く)
  const RULER_H = 12;
  const SEP_W = 3;        // 本体とリリースの境目(キーオフの赤線)の幅
  const SLACK = 3;        // 区画の右に空けておくマス数。終端つまみを掴んで右へ伸ばす余地
  // 左端の目盛り欄(縦の値の数字)。4レーンとも同じ幅にして、同じフレームが縦に揃うようにする
  const GUTTER = 26;
  const RANGE_MAX = 127;  // ピッチ/ノートの縦幅(±)の上限

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

  // ピッチ/ノートレーン用: 相対値(MML) ⇄ 累積値(編集表示)
  function deltasToCum(deltas) {
    let acc = 0;
    return deltas.map((d) => (acc += d));
  }
  function cumToDeltas(cum) {
    let acc = 0;
    return cum.map((c) => { const d = c - acc; acc = c; return d; });
  }
  const isCumulativeLane = (lane) => lane.key === 'en' || lane.key === 'ep';
  // 編集表示(累積値)→MMLへ書く相対値。非ループのピッチは、実機が末尾の差分を足し続けるため
  // 末尾の差分が0でなければ0を足して止める(ヘッダコメント参照)
  function tableDeltas(lane, s) {
    const d = cumToDeltas(s.values);
    if (lane.key === 'ep' && s.loop == null && d.length && d[d.length - 1] !== 0) d.push(0);
    return d;
  }

  // ── ノートレーンの和音入力 ──────────────────────────────────────────
  // 2026-09-14ユーザー合意: 鍵盤を主にして、和音名(根音+種類を選ぶ)と数字の並びを連動させる。
  //   弾く音の例 … 鍵盤と和音名を見せるための仮の音(コード上は chord.base)。MMLには書かれない。
  //               表に入るのは「弾いた音からのずれ(半音)」の数字だけで、鳴る音は本文で弾く音で決まる
  //   鍵盤 ……… クリックで音を足す/外す。何オクターブ目の音かが見えるので和音名を知らなくても組める
  //   並び ……… 基準から(既定) / 上昇 / 下降 / 往復 / クリック順
  // どれかを操作するたびにレーンの表を作り直す(反映を押すまでMMLは変わらない)。
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK_PC = new Set([1, 3, 6, 8, 10]);
  const KB_LOW = -12;     // 鍵盤の範囲(基準の音からの半音)。1オクターブ下〜2オクターブ上
  const KB_HIGH = 24;
  // 和音の種類。音の数ごとに分けて選べるようにする(方針「和音の数と一緒に」)。
  // 名前はコード表記そのもの(万国共通なので訳さない)。長三和音だけは表記が空なので label で出す
  const CHORD_GROUPS = [
    { count: 3, items: [
      { q: '', label: 'メジャー', iv: [0, 4, 7] }, { q: 'm', iv: [0, 3, 7] }, { q: 'dim', iv: [0, 3, 6] },
      { q: 'aug', iv: [0, 4, 8] }, { q: 'sus2', iv: [0, 2, 7] }, { q: 'sus4', iv: [0, 5, 7] }] },
    { count: 4, items: [
      { q: '7', iv: [0, 4, 7, 10] }, { q: 'M7', iv: [0, 4, 7, 11] }, { q: 'm7', iv: [0, 3, 7, 10] },
      { q: 'mM7', iv: [0, 3, 7, 11] }, { q: 'm7-5', iv: [0, 3, 6, 10] }, { q: 'dim7', iv: [0, 3, 6, 9] },
      { q: '6', iv: [0, 4, 7, 9] }, { q: 'm6', iv: [0, 3, 7, 9] }, { q: 'add9', iv: [0, 4, 7, 14] },
      { q: '7sus4', iv: [0, 5, 7, 10] }] },
    { count: 5, items: [
      { q: '9', iv: [0, 4, 7, 10, 14] }, { q: 'M9', iv: [0, 4, 7, 11, 14] }, { q: 'm9', iv: [0, 3, 7, 10, 14] },
      { q: '69', iv: [0, 4, 7, 9, 14] }] }
  ];
  const CHORD_BY_Q = new Map();
  for (const g of CHORD_GROUPS) for (const it of g.items) CHORD_BY_Q.set(it.q, it);
  const pcOf = (n) => ((n % 12) + 12) % 12;

  // 根音+種類 → 基準の音からの半音。根音は基準の音から±半オクターブ以内に置く(G/Cなら5つ下)
  function tonesFromName(base, root, quality) {
    const it = CHORD_BY_Q.get(quality);
    if (!it) return null;
    let off = pcOf(root - base);
    if (off > 6) off -= 12;
    return it.iv.map((i) => i + off);
  }

  // 音の集まり → 和音名(根音+種類)。オクターブの違いは無視して音名の集合で比べる。
  // 同じ集合に複数の名前が付く場合(C6=Am7 等)は、一番低い音を根音とする方を優先する
  function detectChord(base, tones) {
    if (!tones.length) return null;
    const pcs = new Set(tones.map((t) => pcOf(t + base)));
    const lowest = pcOf(Math.min(...tones) + base);
    let found = null;
    for (let root = 0; root < 12; root++) {
      for (const g of CHORD_GROUPS) {
        for (const it of g.items) {
          const set = new Set(it.iv.map((i) => pcOf(root + i)));
          if (set.size !== pcs.size || [...set].some((p) => !pcs.has(p))) continue;
          if (root === lowest) return { root, quality: it.q };
          if (!found) found = { root, quality: it.q };
        }
      }
    }
    return found;
  }

  // 鳴らす順。基準から: 低い順に並べて基準の音(0)から始まるよう回す。和音に基準の音が
  // 無いときは基準の音に一番近い音から始める(同じ近さなら低い方)
  function chordSequence(chord) {
    const asc = [...new Set(chord.tones)].sort((a, b) => a - b);
    switch (chord.order) {
      case 'up': return asc;
      case 'down': return asc.slice().reverse();
      case 'updown': return asc.concat(asc.slice(1, -1).reverse());
      case 'click': return [...new Set(chord.tones)];
      default: {
        let start = 0;
        asc.forEach((t, i) => { if (Math.abs(t) < Math.abs(asc[start])) start = i; });
        return asc.slice(start).concat(asc.slice(0, start));
      }
    }
  }

  // ── キャンバス1枚(本体の表 + リリースの表) ─────────────────────────
  // zones: [{ values, loop }] の1つか2つ。2つ目はリリース。
  // 縦は上から「目盛り帯(RULER_H)」「値の区画」。横は区画0 → 境目(SEP_W) → 区画1 → 余白(SLACK)。
  //
  // 操作(2026-09-14方針):
  //   値の区画のドラッグ ………… 値を描く
  //   目盛り帯の終端つまみ ……… 左右ドラッグで長さを変える
  //   目盛り帯のループつまみ …… 左右ドラッグでループ位置を動かす
  //   ダブルクリック …………… その場所にループ位置を置く。ループ線の上なら削除(帯でも値の区画でも効く)
  // 値の区画でのダブルクリックは、その前の2回のmousedownで値を描いてしまっているので、
  // 1回目のmousedownの直前に取っておいた値へ戻してからループ位置を置く。
  //
  // ピッチ/ノートの縦幅(2026-09-14方針「範囲は縦にドラッグして延ばす。目盛り振っといて」):
  //   値を描くドラッグで上端/下端より外へ出ると、はみ出した距離に応じて縦幅(±)が広がる。
  //   広がり方はドラッグ開始時の縦幅を基準にした一定の比率(広がった後の目盛りで測ると加速してしまうため)。
  //   左端の目盛り欄に数値を振り、目盛り帯の左端に今の縦幅(±n)を出す。目盛り欄のダブルクリックで
  //   表の値ぴったりへ縮める(広げっぱなしで潰れた表を戻す手段)。
  //
  // 呼び出し側への通知: cb.edit(zone, frame, value) / cb.setLoop(zone, frame|null) /
  //   cb.setLength(zone, len) / cb.restore(zone配列ぶんのvaluesのコピー) /
  //   cb.setRange(n) / cb.fitRange()
  const HANDLE_GRAB = 5;     // つまみを掴める左右の幅(px)
  const DBL_GUARD_MS = 500;  // この間隔より空いたmousedownでだけ「描く前の値」を取り直す
  const isCenteredKind = (kind) => kind === 'signed' || kind === 'step';

  // 目盛りの刻み。数字どうしが TICK_MIN_PX 以上離れる最小のきりの良い数。
  // span: 値の幅(音量は0..max、ピッチ/ノートは片側) / px: その幅に当たる画素数
  const TICK_MIN_PX = 14;
  function tickStep(kind, span, px) {
    const cands = kind === 'step' ? [1, 2, 3, 6, 12, 24, 48]            // 半音: 半オクターブ/オクターブ
      : kind === 'bar' ? [1, 2, 4, 5, 8, 10, 16, 20, 32]
        : [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 50, 64, 100];
    for (const c of cands) if ((c / (span || 1)) * px >= TICK_MIN_PX) return c;
    return cands[cands.length - 1];
  }

  class LaneCanvas {
    constructor(canvas, lane, cb) {
      this.canvas = canvas;
      this.lane = lane;
      this.cb = cb;
      this.zones = [];
      this.range = { min: 0, max: 15, rows: 0 };
      this.drag = null;          // { kind:'paint'|'loop'|'end', zone }
      this.snapshot = null;      // 値を描く前の各区画のコピー(ダブルクリックで戻す)
      this.lastDownAt = 0;

      // ドラッグ中はキャンバスの外へ出ても追いかけたいので、windowへの登録はドラッグの間だけ
      this.onWindowMove = (e) => this.dragMove(e);
      this.onWindowUp = () => this.endDrag();
      canvas.addEventListener('mousedown', (e) => this.down(e));
      canvas.addEventListener('mousemove', (e) => { if (!this.drag) this.updateCursor(e); });
      canvas.addEventListener('dblclick', (e) => this.dblclick(e));
    }

    valueH() {
      return this.lane.kind === 'grid' ? Math.max(2, this.range.rows) * ROW_H : LANE_H[this.lane.kind];
    }

    // 各区画の左端x。区画0は目盛り欄の右、区画1は区画0の終端+境目
    origins() {
      const out = [];
      let x = GUTTER;
      for (let z = 0; z < this.zones.length; z++) {
        out.push(x);
        x += this.zones[z].values.length * CELL_W + SEP_W;
      }
      return out;
    }

    setZones(zones, range) {
      this.zones = zones;
      this.range = range;
      const ox = this.origins();
      const last = zones.length - 1;
      const contentW = last >= 0 ? ox[last] + zones[last].values.length * CELL_W : CELL_W;
      this.canvas.width = contentW + SLACK * CELL_W;
      this.canvas.height = RULER_H + this.valueH();
      this.draw();
    }

    local(e) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (this.canvas.width / (rect.width || 1)),
        y: (e.clientY - rect.top) * (this.canvas.height / (rect.height || 1))
      };
    }

    // x → その位置を受け持つ区画(左端がxより左にある最後の区画)とフレーム(区画内に丸める)
    zoneAt(x) {
      const ox = this.origins();
      let z = 0;
      for (let i = 0; i < ox.length; i++) if (x >= ox[i]) z = i;
      const len = this.zones[z].values.length;
      return { zone: z, ox: ox[z], frame: clamp(Math.floor((x - ox[z]) / CELL_W), 0, len - 1) };
    }

    // 目盛り帯のつまみ。近い方を返す(区画1のループ位置0と区画0の終端は3pxしか離れないため)
    handleAt(x) {
      const ox = this.origins();
      let best = null;
      const consider = (kind, zone, hx) => {
        const d = Math.abs(x - hx);
        if (d <= HANDLE_GRAB && (!best || d < best.d)) best = { kind, zone, d };
      };
      this.zones.forEach((zone, z) => {
        consider('end', z, ox[z] + zone.values.length * CELL_W);
        if (zone.loop != null) consider('loop', z, ox[z] + zone.loop * CELL_W);
      });
      return best;
    }

    valueAt(y) {
      const h = this.valueH();
      const vy = y - RULER_H;
      if (this.lane.kind === 'grid') {
        return clamp(this.range.rows - 1 - Math.floor(vy / ROW_H), 0, this.range.rows - 1);
      }
      const { min, max } = this.range;
      return clamp(Math.round(min + (max - min) * (1 - clamp(vy, 0, h) / h)), min, max);
    }

    updateCursor(e) {
      const p = this.local(e);
      let cursor = 'crosshair';
      if (p.y < RULER_H) {
        const hd = this.handleAt(p.x);
        cursor = hd ? 'ew-resize' : 'default';
      } else if (p.x < GUTTER) {
        cursor = 'default';
      }
      this.canvas.style.cursor = cursor;
    }

    down(e) {
      if (e.button !== 0 || !this.zones.length) return;
      const p = this.local(e);
      if (p.y >= RULER_H && p.x < GUTTER) return; // 目盛り欄はダブルクリック(縦幅を表に合わせる)専用
      if (p.y < RULER_H) {
        const hd = this.handleAt(p.x);
        if (!hd) return; // 帯の空いた所はダブルクリック用(1回のクリックでは何もしない)
        this.drag = { kind: hd.kind, zone: hd.zone };
      } else {
        const now = Date.now();
        // ダブルクリック直後(snapshotを使い切った後)は間隔に関係なく取り直す。続けて素早く
        // ダブルクリックしたとき、2回目の分を戻せなくなるため
        if (!this.snapshot || now - this.lastDownAt > DBL_GUARD_MS) this.snapshot = this.zones.map((z) => z.values.slice());
        this.lastDownAt = now;
        this.drag = { kind: 'paint', range0: this.range.max };
        this.paint(p);
      }
      e.preventDefault(); // ドラッグ中に文字選択が走らないように
      global.addEventListener('mousemove', this.onWindowMove);
      global.addEventListener('mouseup', this.onWindowUp);
    }

    dragMove(e) {
      if (!this.drag) return;
      const p = this.local(e);
      const d = this.drag;
      if (d.kind === 'paint') { this.paint(p); return; }
      const ox = this.origins()[d.zone];
      const cells = Math.round((p.x - ox) / CELL_W);
      if (d.kind === 'end') {
        const len = clamp(cells, 1, MAX_LEN);
        if (len !== this.zones[d.zone].values.length) {
          this.cb.setLength(d.zone, len);
          this.revealEnd(d.zone);
        }
      } else {
        const loop = clamp(cells, 0, this.zones[d.zone].values.length - 1);
        if (loop !== this.zones[d.zone].loop) this.cb.setLoop(d.zone, loop);
      }
    }

    endDrag() {
      this.drag = null;
      global.removeEventListener('mousemove', this.onWindowMove);
      global.removeEventListener('mouseup', this.onWindowUp);
    }

    // 伸ばした終端が横スクロールの外へ出たら追いかける
    revealEnd(zone) {
      const wrap = this.canvas.parentElement;
      if (!wrap) return;
      const ox = this.origins()[zone];
      const endX = ox + this.zones[zone].values.length * CELL_W + SLACK * CELL_W;
      const scale = this.canvas.getBoundingClientRect().width / (this.canvas.width || 1);
      const need = endX * scale - wrap.clientWidth;
      if (need > wrap.scrollLeft) wrap.scrollLeft = need;
    }

    paint(p) {
      const hit = this.zoneAt(p.x);
      if (isCenteredKind(this.lane.kind)) {
        const h = this.valueH();
        const vy = p.y - RULER_H;
        const over = vy < 0 ? -vy : vy > h ? vy - h : 0;
        if (over > 0) {
          // 上端/下端より外: ドラッグ開始時の縦幅を基準に、はみ出した距離ぶん縦幅を広げて端の値を描く
          const r0 = (this.drag && this.drag.range0) || this.range.max;
          const need = clamp(Math.ceil(r0 + (over / h) * 2 * r0), 1, RANGE_MAX);
          if (need > this.range.max) this.cb.setRange(need); // renderLaneでthis.rangeが更新される
          this.cb.edit(hit.zone, hit.frame, (vy < 0 ? 1 : -1) * this.range.max);
          return;
        }
      }
      this.cb.edit(hit.zone, hit.frame, this.valueAt(p.y));
    }

    dblclick(e) {
      if (!this.zones.length) return;
      const p = this.local(e);
      if (p.y >= RULER_H && p.x < GUTTER) { this.cb.fitRange(); return; }
      // 値の区画なら、ダブルクリックの2回のmousedownで描いてしまった値を元に戻す
      if (p.y >= RULER_H && this.snapshot) this.cb.restore(this.snapshot);
      this.snapshot = null;
      const hit = this.zoneAt(p.x);
      const zone = this.zones[hit.zone];
      if (zone.loop != null && Math.abs(p.x - (hit.ox + zone.loop * CELL_W)) <= HANDLE_GRAB) {
        this.cb.setLoop(hit.zone, null);
      } else {
        this.cb.setLoop(hit.zone, hit.frame);
      }
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const w = this.canvas.width, h = this.canvas.height;
      const vh = this.valueH();
      const top = RULER_H;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#1c1c24';
      ctx.fillRect(0, 0, w, RULER_H);
      if (!this.zones.length) return;

      const { min, max, rows } = this.range;
      const isGrid = this.lane.kind === 'grid';
      const yOf = (v) => top + vh - ((v - min) / (max - min || 1)) * vh;
      const ox = this.origins();
      const last = this.zones.length - 1;
      const contentW = ox[last] + this.zones[last].values.length * CELL_W;

      // 表の外(右の余白)は暗くして「ここはまだ無いフレーム」と分かるようにする
      ctx.fillStyle = '#0d0d11';
      ctx.fillRect(contentW, top, w - contentW, vh);

      // 左端の目盛り欄と横罫線。gridは行ごと、それ以外はきりの良い刻み(tickStep)で数値を振る
      ctx.fillStyle = '#18181f';
      ctx.fillRect(0, top, GUTTER, vh);
      ctx.font = '8px monospace';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      const label = (text, y) => {
        ctx.fillStyle = '#8a8a98';
        ctx.textAlign = 'right';
        ctx.fillText(text, GUTTER - 3, clamp(y, top + 4, h - 4));
        ctx.textAlign = 'left';
      };
      const hLine = (y, color) => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(GUTTER, Math.round(y) + 0.5); ctx.lineTo(contentW, Math.round(y) + 0.5);
        ctx.stroke();
      };
      if (isGrid) {
        for (let r = 0; r < rows; r++) {
          if (r > 0) hLine(top + r * ROW_H, '#26262f');
          label(String(rows - 1 - r), top + r * ROW_H + ROW_H / 2);
        }
      } else {
        // 音量は0..max、ピッチ/ノートは±max。どちらも片側の幅がmax
        const st = tickStep(this.lane.kind, max, this.lane.kind === 'bar' ? vh : vh / 2);
        const from = this.lane.kind === 'bar' ? 0 : -Math.floor(max / st) * st;
        for (let t = from; t <= max; t += st) {
          const y = yOf(t);
          // ノートはオクターブ(12の倍数)の線を少し明るく
          const strong = this.lane.kind === 'step' && t !== 0 && t % 12 === 0;
          if (t !== 0 && t !== min) hLine(y, strong ? '#34343f' : '#26262f');
          label(isCenteredKind(this.lane.kind) && t > 0 ? '+' + t : String(t), y);
        }
        // 目盛り帯の左端に今の縦幅。ドラッグで広げたことがここの数字で分かる
        ctx.fillStyle = '#c8c8d4';
        ctx.fillText(isCenteredKind(this.lane.kind) ? '±' + max : String(max), 2, RULER_H / 2 + 1);
      }
      for (let z = 0; z < this.zones.length; z++) {
        const zone = this.zones[z];
        const x0 = ox[z];
        const len = zone.values.length;

        // 縦罫線と目盛りの数字(4フレームごと)
        ctx.strokeStyle = '#21212a';
        ctx.beginPath();
        for (let i = 4; i < len; i += 4) { const x = Math.round(x0 + i * CELL_W) + 0.5; ctx.moveTo(x, top); ctx.lineTo(x, h); }
        ctx.stroke();
        ctx.fillStyle = '#6a6a78';
        for (let i = 0; i < len; i += 4) ctx.fillText(String(i), x0 + i * CELL_W + 2, RULER_H / 2 + 1);

        ctx.fillStyle = z === 0 ? this.lane.color : this.lane.color + '80';
        for (let i = 0; i < len; i++) {
          const v = clamp(zone.values[i], min, max);
          const x = x0 + i * CELL_W;
          const cw = Math.max(1, CELL_W - 2);
          if (isGrid) {
            ctx.fillRect(x, top + (rows - 1 - clamp(v, 0, rows - 1)) * ROW_H + 2, cw, ROW_H - 4);
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

        // ループ位置: 値の区画は破線、目盛り帯は下向きの三角(ドラッグで動かすつまみ)
        if (zone.loop != null && zone.loop >= 0 && zone.loop < len) {
          const x = Math.round(x0 + zone.loop * CELL_W) + 0.5;
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#e0a030';
          ctx.beginPath();
          ctx.moveTo(x, top); ctx.lineTo(x, h);
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = '#e0a030';
          ctx.beginPath();
          ctx.moveTo(x - 5, 1); ctx.lineTo(x + 5, 1); ctx.lineTo(x, RULER_H - 1);
          ctx.closePath();
          ctx.fill();
        }

        // 終端のつまみ(長さ)。本体の終端はキーオフの赤線と兼ねる
        const xe = x0 + len * CELL_W;
        const isKeyOff = z === 0 && this.zones.length > 1;
        ctx.fillStyle = isKeyOff ? '#e05a5a' : '#9a9aa8';
        ctx.fillRect(xe, 0, SEP_W, RULER_H);
        ctx.fillRect(xe - 2, 2, SEP_W + 4, RULER_H - 4);
        if (isKeyOff) ctx.fillRect(xe, top, SEP_W, vh);
        else { ctx.fillStyle = '#4a4a56'; ctx.fillRect(xe, top, 1, vh); }
      }

      // 0の位置(ピッチ/ノート)と下端(音量)
      ctx.strokeStyle = '#5a5a68';
      ctx.beginPath();
      const baseY = isCenteredKind(this.lane.kind) ? yOf(0) : h;
      ctx.moveTo(GUTTER, Math.round(baseY) - 0.5); ctx.lineTo(contentW, Math.round(baseY) - 0.5);
      ctx.stroke();
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
          // ノートレーンの和音入力(buildChordPanel参照)。tonesは基準の音からの半音で、並びは
          // 鍵盤をクリックした順(和音名から作ったときは低い順)
          chord: lane.key === 'en' ? { base: 0, root: 0, quality: '', tones: [0, 4, 7], order: 'base', step: 1 } : null,
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
        const rel = lane.relTag == null ? '' :
          `<label class="env-lane-relon"><input type="checkbox" class="env-rel-on" />${T('リリース')}</label>` +
          `<select class="env-rel-index" title="${T('インデックス')}"></select>` +
          `<label>${T('長さ')}<input type="number" class="env-rel-len" min="1" max="128" style="width:42px" /></label>` +
          `<label>${T('ループ')}<input type="number" class="env-rel-loop" min="0" max="127" style="width:42px" placeholder="${T('なし')}" /></label>`;
        return `<div class="env-lane" data-lane="${lane.key}">` +
          `<div class="toolbar env-lane-bar">` +
            `<label class="env-lane-on"><input type="checkbox" class="env-on" /><b>${lane.cmd}</b> ${T(lane.label)}</label>` +
            // 反映はレーン名のすぐ右(2026-09-14方針「右だと遠いので左に」)
            `<button type="button" class="env-apply" title="${T('現在の内容をMMLへ反映')}">${T('反映')}</button>` +
            `<button type="button" class="secondary env-add" title="${T('新規定義を追加')}">＋</button>` +
            `<select class="env-index" title="${T('インデックス')}"></select>` +
            `<label>${T('長さ')}<input type="number" class="env-len" min="1" max="128" style="width:42px" /></label>` +
            `<label>${T('ループ')}<input type="number" class="env-loop" min="0" max="127" style="width:42px" placeholder="${T('なし')}" /></label>` +
            rel +
          `</div>` +
          (lane.key === 'en' ? chordPanelHtml() : '') +
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
            T('4つのエンベロープを同じ時間軸(横1マス=1フレーム)で編集します。テーブル定義はチャンネルに紐づかないので、目盛り・音色の段数・試聴先は「対象音源」だけで決まります(表の中身は音源を変えても書き換えません)。キャンバスはドラッグで値を描きます。ダブルクリックでその位置にループ位置(MMLの"|")を置き、ループ線をダブルクリックすると消えます。上端の目盛り帯では、ループのつまみ(▼)を左右にドラッグして動かし、表の終端のつまみをドラッグして長さを変えます。音量と音色は赤い縦線から右がリリースの表(@vr/@@r)で、区画ごとに自分の表と1対1に対応します。ノート(@EN)とピッチ(@EP)はMML上は前回値からの相対値ですが、ここでは実際に鳴る音程/オフセットの階段を描き、反映のときに差分へ変換します。ピッチとノートの縦幅は、値を描きながら上端や下端より外へドラッグすると広がり、左端の目盛りをダブルクリックすると表の値に合わせて縮みます。ノートは和音からも作れます。和音を選ぶか鍵盤をクリックすると、その場で表が作り直されます。表に入るのは弾いた音からの半音の数字だけで、どの音で鳴るかは本文で弾く音しだいです。「弾く音の例」は鍵盤と和音名を見やすくするための仮の音で、MMLには書き込まれません。編集はこのウィンドウの中だけで、「反映」を押すまでMML本文は変わりません。') +
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
            disabled: q('.env-lane-disabled', root),
            chordPanel: q('.env-chord', root)
          };
          els.lanes.set(lane.key, e);
          canvases.set(lane.key, new LaneCanvas(e.canvas, lane, {
            edit: (zone, frame, value) => editValue(lane, zone, frame, value),
            setLoop: (zone, frame) => setLoop(lane, zone, frame),
            setLength: (zone, len) => setLength(lane, zone, len),
            restore: (snaps) => restoreValues(lane, snaps),
            setRange: (n) => { state.get(lane.key).range = clamp(n, 1, RANGE_MAX); renderLane(lane); },
            fitRange: () => { fitRange(lane); renderLane(lane); }
          }));
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
        if (e.chordPanel && s.chord) wireChordPanel(lane, e.chordPanel);
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

      // リリース側の既定番号。音量はppmckの書き方(`@v1={...}` を定義して `@vr1` で呼ぶ)に
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
        if (lane.key === 'v') return { min: 0, max: Math.max(1, target.volEff || target.volMax), rows: 0 };
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
        // ピッチ/ノートレーンのローカル状態は累積値(=鳴る音程/オフセット)なので、1マス動かしても
        // 後ろは動かない。MMLへ書く直前のtableDeltasが、そのフレームと次のフレームの相対値を
        // 自動的に辻褄の合う値へ作り直す
        arr[frame] = value;
        markDirty(lane);
        renderLane(lane);
      }

      // frame=null でループ位置を消す(キャンバスのダブルクリック/つまみのドラッグから呼ばれる)
      function setLoop(lane, zone, frame) {
        const s = state.get(lane.key);
        if (zone === 0) s.loop = frame;
        else s.relLoop = frame;
        markDirty(lane);
        renderLane(lane);
      }

      // ピッチ/ノートの縦幅を表の値ぴったりに合わせる(読み込み時と目盛り欄のダブルクリック)。
      // 表が小さくても最低限の幅は残す(ノートは1オクターブ、ピッチは8)
      function fitRange(lane) {
        if (!isCenteredKind(lane.kind)) return;
        const s = state.get(lane.key);
        const peak = Math.max(...s.values.map((v) => Math.abs(v)), 0);
        s.range = clamp(Math.max(lane.key === 'ep' ? 8 : 12, peak), 1, RANGE_MAX);
      }

      // ── ノートレーンの和音入力パネル ────────────────────────────────
      function chordPanelHtml() {
        const noteOpts = NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
        const qualOpts = CHORD_GROUPS.map((g) =>
          `<optgroup label="${T('{n}音', { n: g.count })}">` +
          g.items.map((it) => `<option value="${it.q}">${it.label ? T(it.label) : it.q}</option>`).join('') +
          `</optgroup>`).join('');
        // ★誤解させない並べ方(2026-09-14ユーザー指摘「基準の音と和音を入れたら、その音がMMLで鳴るかのような
        //   誤解を与える。あくまで数値の設定をしているだけ」): 表に入るのは「弾いた音からの半音」の数字だけで、
        //   実際に鳴る音は本文で弾く音で変わる。そこで
        //   ・1段目の先頭に「表に入る値」(数字)を置き、これが本体だと分かるようにする
        //   ・和音名と鍵盤は2段目の「作る道具」にし、音名は「弾く音の例」(仮の音、MMLには書かれない)として出す
        //   ・鍵盤の下に「同じ数字でも弾く音が変わると別の和音になる」実例を2つ並べる(renderChordPanel)
        return `<div class="env-chord">` +
          `<div class="toolbar env-chord-bar">` +
            `<label class="env-ch-main" title="${T('表に入る値。弾いた音からの半音を鳴らす順に並べたもの(0=弾いた音)')}">${T('表に入る値(半音)')}` +
              `<input type="text" class="env-ch-nums" style="width:110px" /></label>` +
            `<label>${T('並び|アルペジオ')}<select class="env-ch-order">` +
              `<option value="base">${T('弾いた音から')}</option><option value="up">${T('上昇')}</option>` +
              `<option value="down">${T('下降')}</option><option value="updown">${T('往復')}</option>` +
              `<option value="click">${T('クリック順')}</option></select></label>` +
            `<label>${T('1音あたり')}<input type="number" class="env-ch-step" min="1" max="16" style="width:40px" />${T('フレーム')}</label>` +
          `</div>` +
          `<div class="toolbar env-chord-bar">` +
            `<label>${T('和音から作る')}` +
              `<select class="env-ch-root"><option value="">—</option>${noteOpts}</select>` +
              `<select class="env-ch-qual"><option value="-">—</option>${qualOpts}</select></label>` +
            `<label title="${T('鍵盤と和音名を見やすくするための仮の音です。MMLには書き込まれません(表に入るのは数字だけ)')}">${T('弾く音の例')}` +
              `<select class="env-ch-base">${noteOpts}</select></label>` +
          `</div>` +
          `<div class="env-kb" title="${T('クリックで和音の音を足す/外す')}"></div>` +
          `<div class="env-ch-example"></div>` +
        `</div>`;
      }

      function wireChordPanel(lane, panel) {
        const s = state.get(lane.key);
        const c = s.chord;
        const $ = (sel) => panel.querySelector(sel);
        $('.env-ch-base').addEventListener('change', (ev) => {
          c.base = parseInt(ev.target.value, 10) || 0;
          // 和音名が選ばれていればその和音のまま基準だけ変える(ずれが変わる)。手で組んだ音は
          // ずれをそのまま保ち、名前だけ付け直す
          const fromName = c.root !== '' && CHORD_BY_Q.has(c.quality)
            ? tonesFromName(c.base, c.root, c.quality) : null;
          if (fromName) c.tones = fromName; else nameFromTones(c);
          applyChord(lane);
        });
        const onName = () => {
          const root = $('.env-ch-root').value;
          const qual = $('.env-ch-qual').value;
          if (root === '' || !CHORD_BY_Q.has(qual)) return; // 片方だけ選んだ途中
          c.root = parseInt(root, 10); c.quality = qual;
          c.tones = tonesFromName(c.base, c.root, c.quality);
          applyChord(lane);
        };
        $('.env-ch-root').addEventListener('change', onName);
        $('.env-ch-qual').addEventListener('change', onName);
        $('.env-ch-nums').addEventListener('input', (ev) => {
          const parts = ev.target.value.split(/[\s,]+/).filter(Boolean);
          const nums = parts.map((p) => parseInt(p, 10));
          const ok = parts.length > 0 && nums.every((n) => Number.isFinite(n) && Math.abs(n) <= 48);
          ev.target.classList.toggle('env-ch-nums--bad', !ok && parts.length > 0);
          if (!ok) return;
          c.tones = [...new Set(nums)];
          nameFromTones(c);
          applyChord(lane, { keepNums: true });
        });
        $('.env-ch-order').addEventListener('change', (ev) => { c.order = ev.target.value; applyChord(lane); });
        $('.env-ch-step').addEventListener('change', (ev) => {
          c.step = clamp(parseInt(ev.target.value, 10) || 1, 1, 16);
          applyChord(lane);
        });
        $('.env-kb').addEventListener('mousedown', (ev) => {
          const key = ev.target.closest('[data-tone]');
          if (!key) return;
          ev.preventDefault();
          const t = parseInt(key.dataset.tone, 10);
          const i = c.tones.indexOf(t);
          if (i >= 0) c.tones.splice(i, 1); else c.tones.push(t);
          nameFromTones(c);
          applyChord(lane);
        });
      }

      function nameFromTones(c) {
        const hit = detectChord(c.base, c.tones);
        c.root = hit ? hit.root : '';
        c.quality = hit ? hit.quality : '-';
      }

      // 和音 → レーンの表(累積値)。最後に最初の音へ戻る1フレームを足してループ位置を1にするので、
      // ループ区間の相対値の合計が0になり何周しても音程がずれない(ppmckの @EN0={0 | 4 3 -7} と同じ形)
      function applyChord(lane, opt) {
        const s = state.get(lane.key);
        const c = s.chord;
        if (c.tones.length) {
          const cum = [];
          for (const t of chordSequence(c)) for (let k = 0; k < c.step; k++) cum.push(t);
          cum.push(cum[0]);
          s.values = cum;
          s.loop = 1;
          fitRange(lane);
          markDirty(lane);
        }
        renderLane(lane, opt);
      }

      // 表を読み込んだとき、ループ区間(無ければ全体)に出てくる音を出てきた順に拾って鍵盤へ映す。
      // 表そのものは書き換えない
      function chordFromTable(s) {
        const c = s.chord;
        const part = s.loop != null ? s.values.slice(s.loop) : s.values;
        const tones = [...new Set(part)].filter((t) => t >= KB_LOW && t <= KB_HIGH);
        if (!tones.length) return;
        c.tones = tones;
        nameFromTones(c);
      }

      function renderChordPanel(lane, opt) {
        const s = state.get(lane.key);
        const c = s.chord;
        const panel = els.lanes.get(lane.key).chordPanel;
        const $ = (sel) => panel.querySelector(sel);
        $('.env-ch-base').value = String(c.base);
        $('.env-ch-root').value = c.root === '' ? '' : String(c.root);
        $('.env-ch-qual').value = c.quality;
        if (!(opt && opt.keepNums)) {
          const nums = $('.env-ch-nums');
          nums.value = c.tones.join(',');
          nums.classList.remove('env-ch-nums--bad');
        }
        $('.env-ch-order').value = c.order;
        $('.env-ch-step').value = String(c.step);

        // 同じ数字でも弾く音で別の和音になる、という実例。弾く音の例と、その4度上の2つを出す
        const ex = $('.env-ch-example');
        const tones = [...new Set(c.tones)].sort((a, b) => a - b);
        if (tones.length) {
          const sample = (played) => T('{note} を弾くと {chord}', {
            note: NOTE_NAMES[played].toLowerCase(),
            chord: tones.map((t) => NOTE_NAMES[pcOf(played + t)]).join(' ')
          });
          ex.textContent = T('表に入るのは数字だけです。鳴る音は本文で弾く音で変わります') + ':  ' +
            sample(c.base) + '  /  ' + sample(pcOf(c.base + 5));
        } else {
          ex.textContent = '';
        }

        // 鍵盤。白鍵を並べ、黒鍵は直前の白鍵の右肩に重ねる。並びがクリック順のときは押した順番を出す
        const kb = $('.env-kb');
        const whites = [], blacks = [];
        for (let t = KB_LOW; t <= KB_HIGH; t++) (BLACK_PC.has(pcOf(t + c.base)) ? blacks : whites).push(t);
        const WK = 16, BK = 10;
        const orderNo = (t) => (c.order === 'click' ? c.tones.indexOf(t) + 1 : 0);
        let html = '';
        whites.forEach((t, i) => {
          const on = c.tones.includes(t);
          const no = on ? orderNo(t) : 0;
          html += `<div class="env-kb-w${on ? ' on' : ''}${t === 0 ? ' base' : ''}" data-tone="${t}" style="left:${i * WK}px">` +
            (no ? `<i>${no}</i>` : '') +
            (t === 0 ? `<b>${NOTE_NAMES[c.base]}</b>` : pcOf(t + c.base) === 0 ? `<u>C</u>` : '') + `</div>`;
        });
        for (const t of blacks) {
          const leftWhite = whites.indexOf(t - 1);
          if (leftWhite < 0) continue;
          const on = c.tones.includes(t);
          const no = on ? orderNo(t) : 0;
          html += `<div class="env-kb-b${on ? ' on' : ''}${t === 0 ? ' base' : ''}" data-tone="${t}" style="left:${(leftWhite + 1) * WK - BK / 2}px">` +
            (no ? `<i>${no}</i>` : '') + `</div>`;
        }
        kb.style.width = `${whites.length * WK}px`;
        kb.innerHTML = html;
      }

      // ダブルクリックの2回のmousedownで描いてしまった値を、描く前のコピーへ戻す
      function restoreValues(lane, snaps) {
        const s = state.get(lane.key);
        if (snaps[0] && snaps[0].length === s.values.length) s.values = snaps[0];
        if (snaps[1] && snaps[1].length === s.relValues.length) s.relValues = snaps[1];
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
      function renderLane(lane, opt) {
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
        if (e.chordPanel && s.chord) renderChordPanel(lane, opt);
        if (e.relOn) {
          e.relOn.checked = s.relOn;
          e.relIndex.disabled = !s.relOn;
          e.relLen.disabled = !s.relOn;
          e.relLoop.disabled = !s.relOn;
          e.relLen.value = String(s.relValues.length);
          e.relLoop.value = s.relLoop == null ? '' : String(s.relLoop);
        }
        e.values.textContent = valuesText(lane);
        e.apply.classList.toggle('apply-btn--dirty', !!s.dirty); // シェルを作り直しても未反映の印を保つ
      }

      // 下に出す1行テキスト。ノートレーンは「MMLに書かれる相対値」と「鳴る音程」の両方を出す
      function valuesText(lane) {
        const s = state.get(lane.key);
        const withLoop = (vals, loop) => {
          const parts = vals.map(String);
          if (loop != null && loop < parts.length) parts.splice(loop, 0, '|');
          return parts.join(' ');
        };
        if (isCumulativeLane(lane)) {
          const deltas = tableDeltas(lane, s);
          const sum = s.loop == null ? 0 : deltas.slice(s.loop).reduce((a, b) => a + b, 0);
          const warn = (s.loop != null && sum !== 0)
            ? '  ' + (lane.key === 'en'
              ? T('※ループ区間の合計が{n}半音なので、ループのたびに音程がずれ続けます', { n: sum })
              : T('※ループ区間の合計が{n}なので、ループのたびに音程がずれ続けます', { n: sum }))
            : '';
          const shown = lane.key === 'en' ? T('鳴る音程') : T('実際のオフセット');
          return `@${lane.tag}: ${withLoop(deltas, s.loop)}   (${shown}: ${s.values.join(' ')})${warn}`;
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
          s.values = isCumulativeLane(lane) ? deltasToCum(main.values) : main.values.slice();
          s.loop = main.loop;
        }
        if (lane.relTag != null) {
          // @vr<n> の定義が無ければppmck同様 @v<n> を参照する(compiler.js resolveEnvTables)
          let rel = readTable(src, lane.relTag, s.relIndex);
          if (!rel && lane.relTag === 'vr') rel = readTable(src, 'v', s.relIndex);
          if (rel) { s.relValues = rel.values.slice(); s.relLoop = rel.loop; }
        }
        if (!s.values.length) s.values = new Array(DEFAULT_LEN).fill(0);
        fitRange(lane);
        if (s.chord) chordFromTable(s);
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
        const vol = target.volMax === 0 ? T('音量なし') : T('音量 0-{max}', { max: target.volEff || target.volMax });
        const duty = target.duty ? T('音色 0-{max}', { max: target.duty - 1 }) : T('音色エンベロープなし');
        return `${vol} / ${duty} / ${T('試聴ch')} ${target.letter}`;
      }

      // ── MMLへの書き込み ──────────────────────────────────────────
      function tableTextFor(lane, index, zone) {
        const s = state.get(lane.key);
        if (zone === 0) {
          const vals = isCumulativeLane(lane) ? tableDeltas(lane, s) : s.values;
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
          // N163はppmck綴り(#EX-NAMCO106)でも通るのでどちらかがあれば足さない
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
        // 言語切替はシェルを作り直すだけで、MMLから読み直さない(読み直すと反映前の編集が消えるため)
        MML.I18n.onChange(() => { buildShell(); if (els.phrase) els.phrase.value = phraseText; });
      }
    }
  };
})(window);
