/*
 * VRC7(OPLL)2オペレータFM音色エディタ
 * MML.UI.Vrc7ToneEditor
 *
 * MML本文中の @OP<n> = { 8バイト } / @OT<n> = { 24値 }(VRC7カスタム音色)を、
 * よくあるFM音源の図解(自己帰還 → モジュレータ → キャリア → 出力)として編集する。
 * FDS波形エディタ(src/ui/fdsWaveEditor.js)・N163波形エディタと同じアーキテクチャと
 * 書き込みタイミング規約を踏襲する:
 *   ドラッグ・数値入力・ファイル読込・貼り付け・プリセット読込はローカル(このウィンドウ内)
 *   のみ更新し、「反映」ボタンでMMLへ書き込む。「新規」だけは即座にMMLへ書き込む
 *   (インデックス確保のため)。MMLからの読み込みはインデックス選択時・ウィンドウを開いた
 *   時・ダブルクリック時のみ。
 *
 * ■ 表示の作り
 * 1枚のキャンバス(vrc7ToneDiagram)に、左から
 *   自己帰還(FB) → モジュレータ → 位相を変調 → キャリア → 出力(波形 / 音量の時間変化)
 * を**横に並べて**置く。編集しながら結果を同時に見られるようにするため。
 *  - 各ブロックの中はそのオペレータのエンベロープ。横軸は時間そのものではなく
 *    「レートの目盛り」(実時間はレート+1で半分になる指数なので、そのまま描くと
 *    速い側が潰れてドラッグで掴めない)。実時間の姿は右の「音量の時間変化」が
 *    **実チップの音**で見せるので、こちらは編集しやすさを優先している。
 *  - 右の2枚(出力波形/音量の時間変化)は **実際のVRC7コア
 *    (src/emulator/expansion/vrc7.js)を鳴らして描く**。EG=0(減衰音)とEG=1(持続音)の
 *    違いや、EG=0の離鍵が固定レートである実機の癖もそのまま出る。
 *
 * ■ 図の上で直接編集できるもの(数値入力欄とは双方向に同期する)
 *  - エンベロープの■ハンドル … ピーク(x=AR / y=モジュレータのTL)、ひざ(x=DR / y=SL)、
 *    リリース終端(x=RR)
 *  - EG/KR/AM/VB/WF のタグ … クリックで反転
 *  - FBの8目盛りバー … クリック/ドラッグで0-7
 *
 * ■ VRC7の音色まわりの制約(ヘルプにも出している)
 *  - 自作音色スロットはチップ全体で1つ($00-$07)。音符側は@0で選び、OP<n>で中身を差し替える。
 *  - キャリアのTLは音色ではなく音量(v<n>)が担当するので、音色パラメータには無い。
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const UI = MML.UI = MML.UI || {};
  const T = (key, params) => MML.I18n.t(key, params);

  const OPLL_SAMPLE_RATE = 49716;   // vrc7.js SAMPLE_RATE
  const OPLL_CYCLES_PER_SAMPLE = 36; // vrc7.js CYCLES_PER_SAMPLE
  const VRC7_CLOCK = 1789773;

  const parseMmlNumber = (s) => MML.Defs.parseNumber(s);

  // ── 音色の内部表現 ───────────────────────────────────────────────
  // { fb, mod:{ML,TL,AR,DR,SL,RR,KL,EG,KR,AM,VB,WF}, car:{ 同(TLは持たない) } }
  // 生8バイトとの相互変換は src/mml/lexer.js parseVrc7ToneAltDef /
  // src/emulator/expansion/vrc7.js dump2patch と同じビット配置。
  function bytesToPatch(b) {
    const g = i => (b[i] | 0) & 0xFF;
    return {
      fb: g(3) & 7,
      mod: {
        AM: (g(0) >> 7) & 1, VB: (g(0) >> 6) & 1, EG: (g(0) >> 5) & 1, KR: (g(0) >> 4) & 1, ML: g(0) & 15,
        KL: (g(2) >> 6) & 3, TL: g(2) & 63, WF: (g(3) >> 3) & 1,
        AR: (g(4) >> 4) & 15, DR: g(4) & 15, SL: (g(6) >> 4) & 15, RR: g(6) & 15
      },
      car: {
        AM: (g(1) >> 7) & 1, VB: (g(1) >> 6) & 1, EG: (g(1) >> 5) & 1, KR: (g(1) >> 4) & 1, ML: g(1) & 15,
        KL: (g(3) >> 6) & 3, WF: (g(3) >> 4) & 1,
        AR: (g(5) >> 4) & 15, DR: g(5) & 15, SL: (g(7) >> 4) & 15, RR: g(7) & 15
      }
    };
  }
  function patchToBytes(p) {
    const m = p.mod, c = p.car;
    return [
      ((m.AM & 1) << 7) | ((m.VB & 1) << 6) | ((m.EG & 1) << 5) | ((m.KR & 1) << 4) | (m.ML & 15),
      ((c.AM & 1) << 7) | ((c.VB & 1) << 6) | ((c.EG & 1) << 5) | ((c.KR & 1) << 4) | (c.ML & 15),
      ((m.KL & 3) << 6) | (m.TL & 63),
      ((c.KL & 3) << 6) | ((c.WF & 1) << 4) | ((m.WF & 1) << 3) | (p.fb & 7),
      ((m.AR & 15) << 4) | (m.DR & 15),
      ((c.AR & 15) << 4) | (c.DR & 15),
      ((m.SL & 15) << 4) | (m.RR & 15),
      ((c.SL & 15) << 4) | (c.RR & 15)
    ];
  }
  // @OT(MGSDRV互換)の24値。並びは lexer.js parseVrc7ToneAltDef と厳密に合わせること
  function patchToOtValues(p) {
    const op = o => [o.AR, o.DR, o.SL, o.RR, o.KL, o.ML, o.AM, o.VB, o.EG, o.KR, o.WF];
    return [p.mod.TL, p.fb].concat(op(p.mod), op(p.car));
  }
  function defaultPatch() {
    return bytesToPatch([0x21, 0x21, 20, 3, 0xF4, 0xF4, 0x24, 0x24]);
  }

  // ── MML本文の定義の走査(@OPと@OTの両方を同じ番号空間として扱う) ─────────
  // 定義ブロックの走査/読み書きは共通モジュール(src/mml/defBlocks.js)へ集約した。
  // ★行コメントの除去も共通モジュール側で行う: @OTは1行に11個ずつ並べて
  //   「; AR DR SL RR …」と見出しコメントを添える書き方が普通で(このエディタ自身も
  //   そう書き出すし、サンプルMMLの@OT0もそうなっている)、落とさないとコメントの語を
  //   パラメータとして数えてしまい値が全部ずれる。
  const Defs = MML.Defs;
  // kindはMML上の綴り('OP'/'OT')の小文字。このファイル内では 'op' / 'ot' で扱う
  const scanDefs = (source) => Defs.scan(source, ['OP', 'OT'])
    .map(d => ({ ...d, kind: d.tag.toLowerCase() }));
  const findDefRange = (source, index) => {
    const d = Defs.find(source, ['OP', 'OT'], index);
    return d ? { ...d, kind: d.tag.toLowerCase() } : null;
  };
  const listIndices = (source) => Defs.indices(source, ['OP', 'OT']);
  const findEnclosingDef = (source, pos) => {
    const d = Defs.enclosing(source, pos, ['OP', 'OT']);
    return d ? { ...d, kind: d.tag.toLowerCase() } : null;
  };
  const extractDefinitionLines = (s) => Defs.definitionLines(s);

  // 定義1件 → パッチ。@OTは lexer と同じ規則で8バイトへ畳んでから読む
  function readPatch(source, index) {
    const range = findDefRange(source, index);
    if (!range) return null;
    const vals = Defs.values(source, range.tag, index);
    if (range.kind === 'op') {
      if (vals.length < 8) return null;
      return { patch: bytesToPatch(vals), kind: 'op' };
    }
    if (vals.length < 24) return null;
    const TL = vals[0], FB = vals[1];
    const rd = (a) => ({ AR: a[0], DR: a[1], SL: a[2], RR: a[3], KL: a[4], ML: a[5], AM: a[6], VB: a[7], EG: a[8], KR: a[9], WF: a[10] });
    const p = { fb: FB & 7, mod: rd(vals.slice(2, 13)), car: rd(vals.slice(13, 24)) };
    p.mod.TL = TL & 63;
    return { patch: p, kind: 'ot' };
  }
  // 画面下の1行表示用(コメント無し)。MMLへ書き出す formatDefText は見出しコメント入りなので、
  // そのまま改行を潰すとコメントの語が値の列に混ざって読めなくなる
  function formatDefOneLine(index, patch, kind) {
    if (kind === 'op') return formatDefText(index, patch, 'op');
    return `@OT${index} = { ` + patchToOtValues(patch).join(', ') + ' }';
  }

  function formatDefText(index, patch, kind) {
    if (kind === 'op') {
      return `@OP${index} = { ` + patchToBytes(patch).map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ' }';
    }
    const v = patchToOtValues(patch);
    return `@OT${index} = {\n; TL FB\n  ${v[0]}, ${v[1]},\n` +
      `; AR DR SL RR KL ML AM VB EG KR DT\n` +
      `  ${v.slice(2, 13).join(', ')},\n  ${v.slice(13, 24).join(', ')}\n}`;
  }

  // ── 実機コアで鳴らして波形/エンベロープを得る ─────────────────────────
  // 表示用なので短く鳴らすだけ。VRC7は36サイクルで1サンプル進む(vrc7.js clock())
  function renderPatch(patch, fnum, block, holdSec, releaseSec) {
    const Emu = MML.Emu;
    if (!Emu || !Emu.VRC7Audio) return null;
    const chip = new Emu.VRC7Audio(VRC7_CLOCK);
    const w = (a, v) => { chip.writeRegister(0x9010, a); chip.writeRegister(0x9030, v); };
    const bytes = patchToBytes(patch);
    for (let i = 0; i < 8; i++) w(i, bytes[i]);
    w(0x30, 0x00); // ch0: 音色0(自作) / 音量最大
    w(0x10, fnum & 0xFF);
    w(0x20, 0x10 | ((block & 7) << 1) | ((fnum >> 8) & 1)); // キーオン
    const step = () => { for (let i = 0; i < OPLL_CYCLES_PER_SAMPLE; i++) chip.clock(); return chip.mixSample(); };
    const holdN = Math.floor(OPLL_SAMPLE_RATE * holdSec);
    const relN = Math.floor(OPLL_SAMPLE_RATE * releaseSec);
    const buf = new Float64Array(holdN + relN);
    for (let i = 0; i < holdN; i++) buf[i] = step();
    w(0x20, ((block & 7) << 1) | ((fnum >> 8) & 1)); // キーオフ
    for (let i = 0; i < relN; i++) buf[holdN + i] = step();
    return { buf, keyOffAt: holdN };
  }
  // 5ms窓のピーク列(音量の時間変化)
  function envelopeOf(buf, winSec) {
    const win = Math.max(1, Math.round(OPLL_SAMPLE_RATE * winSec));
    const out = [];
    for (let i = 0; i + win <= buf.length; i += win) {
      let p = 0;
      for (let j = i; j < i + win; j++) { const v = Math.abs(buf[j]); if (v > p) p = v; }
      out.push(p);
    }
    return out;
  }

  // ── 図の中のエンベロープ: 横軸は「レートの目盛り」 ─────────────────────
  // 実時間はレート+1で半分になる指数なので、そのまま時間軸で描くと速い側が潰れて
  // ドラッグで掴めない。FM音源のエディタで普通にそうするように、各区間の幅を
  // レートに比例させる(右へ伸ばす=遅い)。実時間の姿は右の「音量の時間変化」が
  // 実チップの音で見せるので、こちらは編集しやすさを優先する。
  const SEG_MAX = 52;  // AR/DR/RR 1区間の最大幅(px、レート0のとき)
  const SEG_MIN = 5;   // レート15(最速)でも掴めるように残す幅
  const SUS_W = 32;    // 持続区間の幅(固定)。SEG_MAX*3+SUS_W がエンベロープ枠の幅に収まること
  const segW = (rate) => SEG_MIN + (SEG_MAX - SEG_MIN) * (15 - Math.max(0, Math.min(15, rate))) / 15;
  const segRate = (px) => Math.max(0, Math.min(15, Math.round(15 - (px - SEG_MIN) / (SEG_MAX - SEG_MIN) * 15)));

  // 音の高さの選択肢(表示・試聴に使う)。fnum/blockは f = 49716*fnum/2^(19-block)
  const NOTE_CHOICES = [
    { label: 'o3 c', fnum: 0x0AD, block: 3 },
    { label: 'o4 c', fnum: 0x0AD, block: 4 },
    { label: 'o4 a', fnum: 0x121, block: 4 },
    { label: 'o5 c', fnum: 0x0AD, block: 5 },
    { label: 'o6 c', fnum: 0x0AD, block: 6 }
  ];

  UI.Vrc7ToneEditor = {
    // ヘッドレス点検用(tools/headless/check-all.js)。@OT書式の並びやビット配置が
    // src/mml/lexer.js の解釈とずれると「エディタで編集したら音が変わる」事故になるので、
    // 実際のlexerへ通して往復一致を毎回検査できるようにしておく
    _internal: { bytesToPatch, patchToBytes, formatDefText, readPatch, defaultPatch },
    init(mmlSourceEl) {
      const win = document.getElementById('win-vrc7tone');
      if (!win || !mmlSourceEl) return;
      const toggleBtn = document.querySelector('[data-target="win-vrc7tone"]');
      const $ = (id) => document.getElementById(id);

      let currentIndex = 0;
      let patch = defaultPatch();
      let outFormat = 'ot';
      // 未反映の印: 音色(patch/書式)を触るたびに redraw() が通るのでそこで立て、
      // 反映するかMMLから読み直す(loadFromMml)と戻す
      let dirty = false;
      function setDirty(v) { dirty = v; $('vrc7ToneApply').classList.toggle('apply-btn--dirty', v); }

      const selectEl = $('vrc7ToneIndex');
      const formatEl = $('vrc7ToneFormat');
      const presetEl = $('vrc7TonePreset');
      const noteEl = $('vrc7ToneNote');
      const diagram = $('vrc7ToneDiagram');
      const envOutCv = $('vrc7ToneEnvOut');
      const harmCv = $('vrc7ToneHarm');
      const outCv = $('vrc7ToneOut');
      const solveBtn = $('vrc7ToneSolve'), targetClearBtn = $('vrc7ToneTargetClear'), solveListEl = $('vrc7ToneSolveList');
      const valuesEl = $('vrc7ToneValues');
      const statusEl = $('vrc7ToneStatus');
      const sampleMmlEl = $('vrc7ToneSampleMml');

      // --- パラメータ入力欄の対応表 ---
      const FIELDS = [
        ['ML', 'number'], ['TL', 'number'], ['AR', 'number'], ['DR', 'number'],
        ['SL', 'number'], ['RR', 'number'], ['KL', 'number'],
        ['EG', 'check'], ['KR', 'check'], ['AM', 'check'], ['VB', 'check'], ['WF', 'check']
      ];
      const inputs = { mod: {}, car: {} };
      for (const [name, kind] of FIELDS) {
        for (const op of ['mod', 'car']) {
          const el = $(`vrc7Tone${op === 'mod' ? 'Mod' : 'Car'}${name}`);
          if (el) inputs[op][name] = { el, kind };
        }
      }
      const fbEl = $('vrc7ToneFB');

      function syncInputsFromPatch() {
        for (const op of ['mod', 'car']) {
          for (const name of Object.keys(inputs[op])) {
            const { el, kind } = inputs[op][name];
            const v = patch[op][name] || 0;
            if (kind === 'check') el.checked = !!v; else el.value = String(v);
          }
        }
        fbEl.value = String(patch.fb);
      }
      function readPatchFromInputs() {
        for (const op of ['mod', 'car']) {
          for (const name of Object.keys(inputs[op])) {
            const { el, kind } = inputs[op][name];
            if (kind === 'check') patch[op][name] = el.checked ? 1 : 0;
            else {
              const max = parseInt(el.max, 10);
              let v = parseInt(el.value, 10);
              if (isNaN(v)) v = 0;
              patch[op][name] = Math.max(0, Math.min(max, v));
            }
          }
        }
        let fb = parseInt(fbEl.value, 10); if (isNaN(fb)) fb = 0;
        patch.fb = Math.max(0, Math.min(7, fb));
      }

      // ── 構成図(YM2413アプリケーションマニュアルの「ユニットセル」に合わせた形) ──────
      // 参考: YM2413 Application Manual 図1-1(ユニットセルによるFM方式の表現)/図3-2(エンベロープ波形)、
      //       およびFM音源の位相変調の説明図。1オペレータを
      //         位相PG(MULTIPLE/VIB) → 波形(サイン/半波整流 DM・DC) → ⊗ ← EG(AR/DR/SL/RR/TL/KSL/KSR/…)
      //       の4ブロックで描き、**どのレジスタ値がどこに入るか**が図の上で分かるようにする。
      //       変調波 → 搬送波 → 変調結果(右の出力パネル=実チップの音) が左から右に並ぶ。
      // 図の上で直接編集できるもの:
      //   ・EGブロックのエンベロープの■ … ピーク(x=AR / y=モジュレータのTL)、ひざ(x=DR / y=SL)、
      //     リリース終端(x=RR)
      //   ・各ブロックのタグ(VIB / DM・DC / EG-TYP / KSR / AM) … クリックで反転
      //   ・波形ブロックの絵 … クリックでサイン波⇔半波整流
      //   ・FBの8目盛りバー … クリック/ドラッグで0-7
      const COL_MOD = '#e0a83c', COL_CAR = '#57b6e0', COL_LINE = '#8a8a9a', COL_DIM = '#3a3a46';
      // ★操作できる部品の色。エンベロープ線(オペレータ色)と混ざらないよう別色にする
      const COL_GRAB = '#ff6b9d';   // 操作できる部品(ドラッグ/クリック)の共通色
      const COL_HOVER = '#ffd0e2';  // マウスが乗っている部品の強調色
      const CELL_W = 260, CELL_H = 160, CELL_Y = 44;
      // 構成図の並べ方(2026-09-24): PC は左→右(変調波 → 搬送波 → 出力)、スマホ画面は上→下の縦長。
      // セルの中身(drawCell)は位置に依存しないので、セルを置く座標と、セルどうしをつなぐ矢印だけが違う
      const VERTICAL = !!(MML.Device && MML.Device.uiMode && MML.Device.uiMode() === 'mobile');
      const GAP_V = 40;                                   // 縦並びのセル間(矢印と「位相を変調」の文字)
      const MOD_X = 8, MOD_Y = CELL_Y;
      const CAR_X = VERTICAL ? MOD_X : MOD_X + CELL_W + 30;
      const CAR_Y = VERTICAL ? MOD_Y + CELL_H + GAP_V : CELL_Y;
      const OUT_X = CAR_X + CELL_W + 30;
      const OUT_Y = CAR_Y + CELL_H + GAP_V;               // 縦並びの「出力」の位置
      if (VERTICAL) { diagram.width = MOD_X + CELL_W + 30; diagram.height = OUT_Y + 8; }
      // セル内のサブブロック(マニュアルのユニットセルの並び)
      const PG_X = 7, PG_Y = 20, PG_W = 88, PG_H = 40;
      const WV_X = 111, WV_Y = 20, WV_W = 58, WV_H = 40;
      const MUL_X = 202, MUL_Y = 40, MUL_R = 9;
      const EG_X = 7, EG_Y = 64, EG_W = 200, EG_H = 90;

      let hitAreas = [];          // ドラッグ/クリックの当たり判定(描画のたびに作り直す)
      let hoverArea = null;       // マウスが乗っている部品(強調表示用)
      let lastOutput = null;      // 実チップの計算結果(図の再描画のたびに鳴らさないための控え)
      // 逆算の目標波形(1周期N点 + 倍音の振幅/位相)。無いときは null。
      // 手描き(出力セル)と倍音バーは同じ目標を共有し、どちらを触っても両方が追随する
      let target = null;
      const COL_TARGET = '#6fd08a';  // 目標(緑)。青=いまの音色、ピンク=操作部品 と区別する

      function envGeom(x, y, opName) {
        const op = patch[opName];
        const ex = x + EG_X + 6, ey = y + EG_Y + 14, ew = EG_W - 12, eh = EG_H - 32;
        const peak = opName === 'mod' ? (1 - op.TL / 63) : 1;
        const sus = Math.max(0, peak * (1 - op.SL / 15));
        const xAtk = ex + segW(op.AR);
        const xDec = xAtk + segW(op.DR);
        const xOff = xDec + SUS_W;
        const xEnd = xOff + segW(op.RR);
        const lv = (l) => ey + eh - l * eh;
        // EG-TYP=1は持続、0はキーオン中もRRで下がり続ける(マニュアル 図3-1)
        const susEnd = op.EG ? sus : Math.max(0, sus * 0.15);
        return { ex, ey, ew, eh, peak, sus, susEnd, xAtk, xDec, xOff, xEnd, lv };
      }

      function drawDiagram() {
        const ctx = diagram.getContext('2d');
        const W = diagram.width, H = diagram.height;
        hitAreas = [];
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#14141a'; ctx.fillRect(0, 0, W, H);

        drawFeedback(ctx);
        drawCell(ctx, MOD_X, MOD_Y, 'mod');
        drawCell(ctx, CAR_X, CAR_Y, 'car');

        if (VERTICAL) {
          // 縦並び: セルの右端から出た線を右の余白で下へ回し、次の段へ上から下へ入れる
          const railX = MOD_X + CELL_W + 14;
          const pgMidX = CAR_X + PG_X + PG_W / 2;
          ctx.strokeStyle = COL_LINE; ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(MOD_X + CELL_W, MOD_Y + MUL_Y); ctx.lineTo(railX, MOD_Y + MUL_Y);
          ctx.lineTo(railX, CAR_Y - GAP_V / 2); ctx.lineTo(pgMidX, CAR_Y - GAP_V / 2);
          ctx.stroke();
          arrow(ctx, pgMidX, CAR_Y - GAP_V / 2, pgMidX, CAR_Y, COL_LINE);
          ctx.fillStyle = '#9a9aa8'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
          ctx.fillText(T('位相を変調'), pgMidX + 8, CAR_Y - GAP_V / 2 + 12);
          // 搬送波の出力 → 音
          ctx.strokeStyle = COL_LINE;
          ctx.beginPath();
          ctx.moveTo(CAR_X + CELL_W, CAR_Y + MUL_Y); ctx.lineTo(railX, CAR_Y + MUL_Y);
          ctx.lineTo(railX, OUT_Y - 18);
          ctx.stroke();
          arrow(ctx, railX, OUT_Y - 18, railX, OUT_Y - 4, COL_LINE);
          ctx.fillStyle = '#c8c8d4'; ctx.textAlign = 'right';
          ctx.fillText(T('出力'), railX - 6, OUT_Y - 6);
        } else {
          // 変調波の出力 → 搬送波の位相へ
          const midY = CELL_Y + MUL_Y;
          arrow(ctx, MOD_X + CELL_W, midY, CAR_X + PG_X, midY, COL_LINE);
          ctx.fillStyle = '#9a9aa8'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(T('位相を変調'), (MOD_X + CELL_W + CAR_X) / 2, CELL_Y - 6);
          // 搬送波の出力 → 音
          arrow(ctx, CAR_X + CELL_W, midY, OUT_X, midY, COL_LINE);
          ctx.fillStyle = '#c8c8d4';
          ctx.fillText(T('出力'), (CAR_X + CELL_W + OUT_X) / 2, CELL_Y - 6);
        }

        drawOut();
        drawEnvOut();
        drawHarm();
      }

      // 自己帰還(FB): 変調波が自分自身の位相へ回り込む。0-7の目盛りバーで直接設定できる
      function drawFeedback(ctx) {
        const on = patch.fb > 0;
        const topY = MOD_Y, arcY = MOD_Y - 30;
        const lx = MOD_X + PG_X + 14, rx = MOD_X + MUL_X;
        ctx.strokeStyle = on ? COL_MOD : COL_DIM;
        ctx.lineWidth = on ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(rx, topY);
        ctx.bezierCurveTo(rx, arcY, lx, arcY, lx, topY);
        ctx.stroke();
        ctx.fillStyle = on ? COL_MOD : COL_DIM;
        ctx.beginPath();
        ctx.moveTo(lx, topY + 1); ctx.lineTo(lx - 5, topY - 7); ctx.lineTo(lx + 5, topY - 7);
        ctx.closePath(); ctx.fill();

        const bw = 9, bh = 11, bx = MOD_X + CELL_W / 2 - (bw * 8) / 2, by = arcY - 5;
        ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
        ctx.fillStyle = on ? COL_MOD : '#6a6a78';
        ctx.fillText('FEEDBACK', bx - 4, by + 9);
        for (let i = 0; i < 8; i++) {
          ctx.fillStyle = (patch.fb > 0 && i <= patch.fb) ? COL_MOD : '#26262f';
          ctx.fillRect(bx + i * bw + 1, by, bw - 2, bh);
        }
        // 押せる部品なので枠は操作色(タグ/フェーダーと同じ)。乗っている間は明るく太く
        const fbHot = isHover({ kind: 'fb' });
        ctx.strokeStyle = fbHot ? COL_HOVER : COL_GRAB; ctx.lineWidth = fbHot ? 1.6 : 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw * 8 - 1, bh);
        ctx.fillStyle = '#c8c8d4'; ctx.textAlign = 'left';
        ctx.fillText(String(patch.fb), bx + bw * 8 + 4, by + 9);
        // 端の1pxで取りこぼさないよう当たり判定は左右に少し広げる(値はclampする)
        hitAreas.push({ kind: 'fb', x: bx - 2, y: by - 3, w: bw * 8 + 4, h: bh + 6, bx, bw });
      }

      // 矢印(向きは任意。先端は(x2,y2))。左→右の水平矢印は従来と同じ形になる
      function arrow(ctx, x1, y1, x2, y2, color) {
        const a = Math.atan2(y2 - y1, x2 - x1), ca = Math.cos(a), sa = Math.sin(a);
        ctx.strokeStyle = color; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - 7 * ca, y2 - 7 * sa); ctx.stroke();
        ctx.fillStyle = color;
        const bx = x2 - 8 * ca, by = y2 - 8 * sa;
        ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(bx + 4.5 * sa, by - 4.5 * ca); ctx.lineTo(bx - 4.5 * sa, by + 4.5 * ca);
        ctx.closePath(); ctx.fill();
      }
      // ドラッグできる点。操作できることが一目で分かるよう専用色(COL_GRAB)+白フチにする。
      // マウスが乗っている間は一回り大きく明るくする
      function handle(ctx, x, y, area) {
        const hot = isHover(area);
        const r = hot ? 5 : 4;
        ctx.fillStyle = hot ? COL_HOVER : COL_GRAB; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        ctx.strokeRect(x - r, y - r, r * 2, r * 2);
      }
      // 小ブロックの枠+見出し。areaを渡すとブロック全体が押せる印(操作色の枠)になる
      function subBox(ctx, x, y, w, h, title, color, area) {
        const hot = area ? isHover(area) : false;
        ctx.strokeStyle = area ? (hot ? COL_HOVER : COL_GRAB) : '#333340';
        ctx.lineWidth = hot ? 1.6 : 1; ctx.fillStyle = '#1f1f28';
        ctx.beginPath(); ctx.rect(x + 0.5, y + 0.5, w, h); ctx.fill(); ctx.stroke();
        ctx.font = '8px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = color;
        ctx.fillText(title, x + 4, y + 9);
      }
      // 点灯タグ(クリックで反転)
      // クリックで反転するタグ。押せることが分かるよう**操作色(COL_GRAB)の枠**で囲む。
      // 点灯時はオペレータ色で塗りつぶし、マウスが乗っている間は枠を明るくする。
      function tag(ctx, x, y, label, on, color, area) {
        ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
        const w = ctx.measureText(label).width;
        const hot = isHover(area);
        ctx.fillStyle = on ? color : '#20202a';
        ctx.strokeStyle = hot ? COL_HOVER : COL_GRAB; ctx.lineWidth = hot ? 1.6 : 1;
        ctx.beginPath(); ctx.rect(x - 3.5, y - 9.5, w + 7, 12); ctx.fill(); ctx.stroke();
        ctx.fillStyle = on ? '#14141a' : '#c0c0cc';
        ctx.fillText(label, x, y);
        hitAreas.push(Object.assign({ x: x - 4, y: y - 11, w: w + 9, h: 15 }, area));
        return w;
      }
      // マウスが乗っている部品か(hoverAreaは種類とop/keyで同定する)
      function isHover(area) {
        const h = hoverArea;
        if (!h || !area) return false;
        return h.kind === area.kind && h.op === area.op && h.key === area.key;
      }
      // ── 音量つまみ風のフェーダー(モジュレータのTL=変調の深さ) ──
      // 上=TL0(いちばん深い変調) / 下=TL63(変調なし)。ドラッグで直接変えられる
      function fader(ctx, x, y, w, h, value, max, area) {
        const hot = isHover(area);
        ctx.fillStyle = '#1a1a22';
        ctx.strokeStyle = hot ? COL_HOVER : COL_GRAB; ctx.lineWidth = hot ? 1.6 : 1;
        ctx.beginPath(); ctx.rect(x + 0.5, y + 0.5, w, h); ctx.fill(); ctx.stroke();
        // 目盛り
        ctx.strokeStyle = '#33333f'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const ty = y + (i / 4) * h;
          ctx.beginPath(); ctx.moveTo(x + 2, ty); ctx.lineTo(x + w - 2, ty); ctx.stroke();
        }
        // つまみ(上が0=深い)
        const ky = y + (value / max) * (h - 8);
        ctx.fillStyle = hot ? COL_HOVER : COL_GRAB;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.rect(x - 1.5, ky + 0.5, w + 3, 7); ctx.fill(); ctx.stroke();
        hitAreas.push(Object.assign({ x: x - 4, y: y - 3, w: w + 8, h: h + 6, fy: y, fh: h, fmax: max }, area));
      }

      // 波形ブロック: そのオペレータの基本波形。WF=0=サイン波 / WF=1=半波整流
      // (レジスタ$03 の DM=変調波・DC=搬送波)。変調波は変調の深さ(TL)ぶん振幅を縮めて描くので、
      // 「どれくらい位相を揺らしているか」が絵で分かる。薄い線が全振幅の目安。
      function drawOpWave(ctx, x, y, w, h, op, color, isMod) {
        const cy = y + h / 2 + 3, amp = h / 2 - 7;
        const depth = isMod ? Math.pow(10, -(op.TL * 0.75) / 20) : 1;
        const shape = (t) => {
          const s = Math.sin(t * Math.PI * 2);
          return op.WF ? Math.max(0, s) : s;   // 半波整流は負側を0に
        };
        ctx.strokeStyle = '#33333f'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 3, cy); ctx.lineTo(x + w - 3, cy); ctx.stroke();
        // 全振幅の目安(薄線)
        if (isMod && depth < 0.95) {
          ctx.strokeStyle = '#3a3a46'; ctx.beginPath();
          for (let i = 0; i <= 40; i++) {
            const px = x + 3 + (i / 40) * (w - 6), py = cy - shape(i / 40 * 1.5) * amp;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.strokeStyle = color; ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i <= 60; i++) {
          const px = x + 3 + (i / 60) * (w - 6), py = cy - shape(i / 60 * 1.5) * amp * depth;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      function drawCell(ctx, x, y, opName) {
        const op = patch[opName];
        const color = opName === 'mod' ? COL_MOD : COL_CAR;
        const isMod = opName === 'mod';
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.fillStyle = '#1b1b23';
        ctx.beginPath(); ctx.rect(x + 0.5, y + 0.5, CELL_W, CELL_H); ctx.fill(); ctx.stroke();
        ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = color;
        ctx.fillText(isMod ? T('モジュレータ(変調波)') : T('キャリア(搬送波)'), x + 7, y + 13);

        // --- 位相 PG: MULTIPLE と VIB ---
        subBox(ctx, x + PG_X, y + PG_Y, PG_W, PG_H, T('位相 PG'), '#8a8a9a');
        ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#d0d0dc';
        ctx.fillText('MULTIPLE ' + (op.ML === 0 ? '×0.5' : '×' + op.ML), x + PG_X + 5, y + PG_Y + 24);
        tag(ctx, x + PG_X + 5, y + PG_Y + 36, 'VIB', op.VB, color, { kind: 'tag', op: opName, key: 'VB' });

        // --- 波形: サイン波 / 半波整流(DM・DC) ---
        subBox(ctx, x + WV_X, y + WV_Y, WV_W, WV_H, isMod ? 'DM' : 'DC', op.WF ? color : '#8a8a9a',
          { kind: 'tag', op: opName, key: 'WF' });
        drawOpWave(ctx, x + WV_X, y + WV_Y, WV_W, WV_H, op, color, isMod);
        hitAreas.push({ kind: 'tag', op: opName, key: 'WF', x: x + WV_X, y: y + WV_Y, w: WV_W, h: WV_H });

        arrow(ctx, x + PG_X + PG_W, y + PG_Y + PG_H / 2, x + WV_X, y + PG_Y + PG_H / 2, COL_LINE);
        arrow(ctx, x + WV_X + WV_W, y + PG_Y + PG_H / 2, x + MUL_X - MUL_R, y + MUL_Y, COL_LINE);

        // --- ⊗(波形 × エンベロープ) ---
        ctx.strokeStyle = COL_LINE; ctx.lineWidth = 1.2; ctx.fillStyle = '#1f1f28';
        ctx.beginPath(); ctx.arc(x + MUL_X, y + MUL_Y, MUL_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + MUL_X - 4, y + MUL_Y - 4); ctx.lineTo(x + MUL_X + 4, y + MUL_Y + 4);
        ctx.moveTo(x + MUL_X + 4, y + MUL_Y - 4); ctx.lineTo(x + MUL_X - 4, y + MUL_Y + 4);
        ctx.stroke();
        arrow(ctx, x + MUL_X + MUL_R, y + MUL_Y, x + CELL_W, y + MUL_Y, COL_LINE);

        // --- EG: AR/DR/SL/RR + TL/KSL/KSR/EG-TYP/AM ---
        subBox(ctx, x + EG_X, y + EG_Y, EG_W, EG_H, T('エンベロープ EG'), '#8a8a9a');
        arrow(ctx, x + MUL_X, y + EG_Y, x + MUL_X, y + MUL_Y + MUL_R, COL_LINE);

        const g = envGeom(x, y, opName);
        ctx.strokeStyle = '#2a2a34'; ctx.lineWidth = 1;
        ctx.strokeRect(g.ex + 0.5, g.ey + 0.5, g.ew, g.eh);
        ctx.strokeStyle = color; ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(g.ex, g.lv(0));
        ctx.lineTo(g.xAtk, g.lv(g.peak));
        ctx.lineTo(g.xDec, g.lv(g.sus));
        ctx.lineTo(g.xOff, g.lv(g.susEnd));
        ctx.lineTo(g.xEnd, g.lv(0));
        ctx.stroke();
        // KEY OFF の位置(マニュアル 図3-1 と同じ表し方)
        ctx.strokeStyle = '#6a6a7a'; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(g.xOff, g.ey); ctx.lineTo(g.xOff, g.ey + g.eh); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '8px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#6a6a78';
        ctx.fillText('KEY OFF', g.xOff + 2, g.ey + 8);
        handle(ctx, g.xAtk, g.lv(g.peak), { kind: 'peak', op: opName });
        handle(ctx, g.xDec, g.lv(g.sus), { kind: 'knee', op: opName });
        handle(ctx, g.xEnd, g.lv(0), { kind: 'rel', op: opName });
        hitAreas.push({ kind: 'peak', op: opName, bx: x, by: y, x: g.xAtk, y: g.lv(g.peak) });
        hitAreas.push({ kind: 'knee', op: opName, bx: x, by: y, x: g.xDec, y: g.lv(g.sus) });
        hitAreas.push({ kind: 'rel', op: opName, bx: x, by: y, x: g.xEnd, y: g.lv(0) });
        // AR/DR/SL/RR がエンベロープのどの区間かを示す
        ctx.font = '8px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#8a8a9a';
        const lblY = g.ey + g.eh + 9;
        ctx.fillText('AR' + op.AR, (g.ex + g.xAtk) / 2, lblY);
        ctx.fillText('DR' + op.DR, (g.xAtk + g.xDec) / 2, lblY);
        ctx.fillText('SL' + op.SL, (g.xDec + g.xOff) / 2, lblY);
        ctx.fillText('RR' + op.RR, (g.xOff + g.xEnd) / 2, lblY);

        // EGブロックの右側: TL(モジュレータは音量つまみ風フェーダー) / KSL / KSR / AM
        const rx = x + EG_X + EG_W + 6;
        ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#9a9aa8';
        ctx.fillText('TL', rx, y + EG_Y + 11);
        if (isMod) {
          fader(ctx, rx + 1, y + EG_Y + 15, 10, 36, op.TL, 63, { kind: 'tl', op: opName });
          ctx.fillStyle = '#d0d0dc'; ctx.fillText(String(op.TL), rx + 15, y + EG_Y + 33);
        } else {
          ctx.fillStyle = '#6a6a78'; ctx.fillText('= v<n>', rx, y + EG_Y + 23);
        }
        ctx.fillStyle = '#d0d0dc';
        ctx.fillText('KSL' + op.KL, rx, y + EG_Y + 63);
        tag(ctx, rx, y + EG_Y + 77, 'KSR', op.KR, color, { kind: 'tag', op: opName, key: 'KR' });
        tag(ctx, rx + 26, y + EG_Y + 77, 'AM', op.AM, color, { kind: 'tag', op: opName, key: 'AM' });
        tag(ctx, x + EG_X + 92, y + EG_Y + 9, 'EG-TYP', op.EG, color, { kind: 'tag', op: opName, key: 'EG' });
      }
      // ── 出力波形(右列の専用キャンバス。ドラッグで目標を手描きできる) ──
      // 構成図の3つめのセルだったものを、逆算の操作(逆算/消去/候補/倍音バー)の真下へ移した
      let outHover = false;
      function outGeom() {
        const px0 = 8, py0 = 20, pw = outCv.width - 16, ph = outCv.height - 30;
        return { px0, py0, pw, ph, midY: py0 + ph / 2 };
      }
      function drawOut() {
        if (!outCv) return;
        const ctx = outCv.getContext('2d');
        const W = outCv.width, H = outCv.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#1b1b23'; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = COL_CAR; ctx.lineWidth = 1.2; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
        ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = COL_CAR;
        ctx.fillText(T('出力波形(1周期)'), 7, 13);

        const { px0, py0, pw, ph, midY } = outGeom();
        // 手描きできる領域なので枠は操作色(乗っている間は明るく)
        ctx.strokeStyle = target ? (outHover ? COL_HOVER : COL_GRAB) : (outHover ? COL_HOVER : '#2a2a34');
        ctx.lineWidth = outHover ? 1.6 : 1;
        ctx.strokeRect(px0 + 0.5, py0 + 0.5, pw, ph);
        ctx.strokeStyle = '#3a3a46'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px0 + 1, midY); ctx.lineTo(px0 + pw - 1, midY); ctx.stroke();
        // 凡例(目標があるときだけ)
        if (target) {
          ctx.font = '8px sans-serif'; ctx.textAlign = 'right';
          ctx.fillStyle = COL_TARGET; ctx.fillText('■ ' + T('目標'), W - 40, 13);
          ctx.fillStyle = COL_CAR; ctx.fillText('■ ' + T('いま'), W - 8, 13);
        }
        const plot = (wave, peak, color, width) => {
          ctx.strokeStyle = color; ctx.lineWidth = width;
          ctx.beginPath();
          for (let i = 0; i < wave.length; i++) {
            const wx = px0 + 2 + (i / (wave.length - 1)) * (pw - 4);
            const wy = midY - (wave[i] / peak) * (ph / 2 - 5);
            if (i === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
          }
          ctx.stroke();
        };
        if (target) plot(target.wave, 1, COL_TARGET, 1.2);
        if (!lastOutput) return;
        if (lastOutput.peak <= 1e-6) {
          ctx.font = '9px sans-serif'; ctx.fillStyle = '#b06a6a'; ctx.textAlign = 'center';
          ctx.fillText(T('音が出ていません'), px0 + pw / 2, midY + 3);
          return;
        }
        plot(lastOutput.wave, lastOutput.peak, COL_CAR, 1.5);
      }
      // 手描き: 直前の点から線形補間で列を埋める
      let drawLast = null;
      function drawTargetAt(pos) {
        const S = Solver();
        const g = outGeom();
        const toIdx = (px) => Math.max(0, Math.min(S.N - 1, Math.round((px - g.px0 - 2) / (g.pw - 4) * (S.N - 1))));
        const toVal = (py) => Math.max(-1, Math.min(1, (g.midY - py) / (g.ph / 2 - 5)));
        const i1 = toIdx(pos.x), v1 = toVal(pos.y);
        const i0 = drawLast ? drawLast.i : i1, v0 = drawLast ? drawLast.v : v1;
        const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
        for (let i = lo; i <= hi; i++) {
          const t = hi === lo ? 0 : (i - lo) / (hi - lo);
          target.wave[i] = i0 <= i1 ? v0 + (v1 - v0) * t : v1 + (v0 - v1) * t;
        }
        drawLast = { i: i1, v: v1 };
      }

      // ── 倍音バー(別キャンバス。音量エンベロープの下) ──
      // 緑=目標(ドラッグで振幅を変える) / 青=いまの音色。探索が見ているものをそのまま触る
      const Solver = () => UI.Vrc7ToneSolver;
      let harmHover = -1;
      function harmGeom() {
        const W = harmCv.width, H = harmCv.height;
        const x = 18, y = 14, w = W - 24, h = H - 24;
        const S = Solver();
        const bw = w / (S ? S.H : 16);
        return { x, y, w, h, bw, W, H };
      }
      function drawHarm() {
        if (!harmCv) return;
        const ctx = harmCv.getContext('2d');
        const S = Solver();
        const { x, y, w, h, bw, W, H } = harmGeom();
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#14141a'; ctx.fillRect(0, 0, W, H);
        ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#6a6a78';
        ctx.fillText(T('倍音'), 5, 10);
        ctx.strokeStyle = target ? COL_GRAB : '#2a2a34'; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        // いまの音色(青の細い輪郭)
        if (lastOutput && lastOutput.peak > 1e-6 && S) {
          const cur = S.analyze(S.resample(lastOutput.wave, S.N)).mag;
          ctx.strokeStyle = COL_CAR; ctx.lineWidth = 1;
          for (let k = 1; k <= S.H; k++) {
            const bx = x + (k - 1) * bw, bh = cur[k] * (h - 2);
            ctx.strokeRect(bx + 1.5, y + h - bh - 0.5, bw - 3, bh);
          }
        }
        // 目標(緑の塗り)
        if (target && S) {
          for (let k = 1; k <= S.H; k++) {
            const bx = x + (k - 1) * bw, bh = target.mag[k] * (h - 2);
            ctx.fillStyle = (harmHover === k) ? COL_HOVER : COL_TARGET;
            ctx.globalAlpha = 0.75;
            ctx.fillRect(bx + 3, y + h - bh, bw - 6, bh);
            ctx.globalAlpha = 1;
          }
        }
        ctx.fillStyle = '#6a6a78'; ctx.textAlign = 'center'; ctx.font = '8px sans-serif';
        for (const k of [1, 4, 8, 12, 16]) ctx.fillText(String(k), x + (k - 0.5) * bw, y + h + 9);
      }
      function harmPos(e) {
        const r = harmCv.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (harmCv.width / r.width), y: (e.clientY - r.top) * (harmCv.height / r.height) };
      }
      function harmIndexAt(pos) {
        const { x, y, w, h, bw } = harmGeom();
        if (pos.x < x || pos.x > x + w || pos.y < y - 4 || pos.y > y + h + 4) return -1;
        return Math.max(1, Math.min(Solver().H, Math.floor((pos.x - x) / bw) + 1));
      }
      // 目標が無ければ「いまの音色」を出発点にする(手描き・倍音バーどちらも同じ)
      function ensureTarget() {
        if (target) return true;
        const S = Solver();
        if (!S || !lastOutput || lastOutput.peak <= 1e-6) return false;
        const wave = S.resample(lastOutput.wave, S.N);
        let pk = 0; for (let i = 0; i < wave.length; i++) pk = Math.max(pk, Math.abs(wave[i]));
        if (pk > 0) for (let i = 0; i < wave.length; i++) wave[i] /= pk;
        const sp = S.analyze(wave);
        target = { wave, mag: sp.mag, phase: sp.phase };
        return true;
      }
      function setTargetFromWave(wave) {
        const S = Solver();
        const sp = S.analyze(wave);
        target = { wave, mag: sp.mag, phase: sp.phase };
      }
      function setTargetMag(k, v) {
        const S = Solver();
        target.mag[k] = Math.max(0, Math.min(1, v));
        // 正規化し直して波形を合成(位相はそのまま)
        let e = 0; for (let i = 1; i <= S.H; i++) e += target.mag[i] * target.mag[i];
        e = Math.sqrt(e) || 1; for (let i = 1; i <= S.H; i++) target.mag[i] /= e;
        target.wave = S.synth(target.mag, target.phase);
      }
      function clearTarget() {
        target = null;
        solveListEl.innerHTML = '';
        drawDiagram();
      }

      // ── 音量エンベロープ(別キャンバス。出力波形セルの真下に置く) ──
      function drawEnvOut() {
        if (!envOutCv) return;
        const ctx = envOutCv.getContext('2d');
        const W = envOutCv.width, H = envOutCv.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#14141a'; ctx.fillRect(0, 0, W, H);
        ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#6a6a78';
        ctx.fillText(T('音量の時間変化(離鍵あり)'), 5, 12);
        const x = 5, y = 18, w = W - 10, h = H - 30;
        ctx.strokeStyle = '#2a2a34'; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        if (!lastOutput) return;
        const env = lastOutput.env, emax = lastOutput.envMax;
        ctx.strokeStyle = COL_CAR; ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let i = 0; i < env.length; i++) {
          const px = x + 2 + (i / (env.length - 1)) * (w - 4);
          const py = y + h - 2 - (env[i] / emax) * (h - 4);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        const offX = x + 2 + lastOutput.keyOffRatio * (w - 4);
        ctx.strokeStyle = '#6a6a7a'; ctx.setLineDash([2, 2]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(offX, y + 1); ctx.lineTo(offX, y + h - 1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#6a6a78'; ctx.textAlign = 'center';
        ctx.fillText('KEY OFF', offX, y + h + 10);
        ctx.textAlign = 'right';
        ctx.fillText('1.25s', x + w, y + h + 10);
      }
      // 実チップを鳴らして控えを作る(重いので間引いて呼ぶ)
      function recomputeOutput() {
        const note = NOTE_CHOICES[Math.max(0, noteEl.selectedIndex)] || NOTE_CHOICES[1];
        const r = renderPatch(patch, note.fnum, note.block, 0.9, 0.35);
        if (!r) { lastOutput = null; return; }
        const f0 = OPLL_SAMPLE_RATE * note.fnum / Math.pow(2, 19 - note.block);
        const period = Math.max(4, Math.round(OPLL_SAMPLE_RATE / f0));
        // ★切り出す位置は「いちばん大きく鳴っている瞬間」。固定時刻(例:20ms)にすると
        //   立ち上がりの遅い音色(AR小)で真っ平らな区間を掴んでしまい「音が出ていません」に見える
        let peakIdx = 0, peakAbs = 0;
        for (let i = 0; i < r.keyOffAt; i++) {
          const v = Math.abs(r.buf[i]);
          if (v > peakAbs) { peakAbs = v; peakIdx = i; }
        }
        const start = Math.max(0, Math.min(peakIdx - (period >> 1), r.buf.length - period - 1));
        const wave = new Float64Array(period);
        let peak = 0;
        for (let i = 0; i < period; i++) { wave[i] = r.buf[start + i]; peak = Math.max(peak, Math.abs(wave[i])); }
        const env = envelopeOf(r.buf, 0.005);
        lastOutput = { wave, peak, env, envMax: Math.max(...env, 1e-9), keyOffRatio: r.keyOffAt / r.buf.length };
      }

      // ── キャンバス上での直接編集 ─────────────────────────────────────
      function canvasPos(e) {
        const rect = diagram.getBoundingClientRect();
        return {
          x: (e.clientX - rect.left) * (diagram.width / rect.width),
          y: (e.clientY - rect.top) * (diagram.height / rect.height)
        };
      }
      function hitTest(pos, tol) {
        // ハンドルが最優先(タグ/FBバーと重なっても掴めるように)。指は tol を広げて呼ぶ
        const r = tol || 7;
        let best = null, bestD = Infinity;
        for (const a of hitAreas) {
          if (a.kind === 'peak' || a.kind === 'knee' || a.kind === 'rel') {
            const d = Math.max(Math.abs(pos.x - a.x), Math.abs(pos.y - a.y));
            if (d <= r && d < bestD) { best = a; bestD = d; }
          }
        }
        if (best) return best;
        for (const a of hitAreas) {
          if (a.w && pos.x >= a.x && pos.x <= a.x + a.w && pos.y >= a.y && pos.y <= a.y + a.h) return a;
        }
        return null;
      }
      // ドラッグ中の更新。ハンドルの種類ごとに担当するパラメータへ落とす
      function applyDrag(area, pos) {
        if (area.kind === 'tl') {   // 音量つまみ風フェーダー(上=TL0=いちばん深い変調)
          const t = Math.max(0, Math.min(1, (pos.y - area.fy) / (area.fh - 8)));
          patch[area.op].TL = Math.round(t * area.fmax);
          return;
        }
        if (area.kind === 'fb') {
          patch.fb = Math.max(0, Math.min(7, Math.floor((pos.x - area.bx) / area.bw)));
          return;
        }
        const opName = area.op, op = patch[opName];
        const g = envGeom(area.bx, area.by, opName);
        const level = Math.max(0, Math.min(1, (g.ey + g.eh - pos.y) / g.eh));
        if (area.kind === 'peak') {
          op.AR = segRate(pos.x - g.ex);
          if (opName === 'mod') op.TL = Math.max(0, Math.min(63, Math.round(63 * (1 - level))));
        } else if (area.kind === 'knee') {
          op.DR = segRate(pos.x - g.xAtk);
          const peak = opName === 'mod' ? (1 - op.TL / 63) : 1;
          op.SL = peak > 0.001 ? Math.max(0, Math.min(15, Math.round(15 * (1 - level / peak)))) : 0;
        } else if (area.kind === 'rel') {
          op.RR = segRate(pos.x - g.xOff);
        }
      }
      let dragArea = null;
      diagram.addEventListener('mousedown', (e) => {
        const pos = canvasPos(e);
        const area = hitTest(pos);
        if (!area) return;
        e.preventDefault();
        if (area.kind === 'tag') {          // タグはクリックで反転
          patch[area.op][area.key] = patch[area.op][area.key] ? 0 : 1;
          syncInputsFromPatch(); redraw(false);
          return;
        }
        dragArea = area;
        applyDrag(area, pos);
        syncInputsFromPatch(); redraw(false);
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragArea) return;
        applyDrag(dragArea, canvasPos(e));
        syncInputsFromPatch(); redraw(false);
      });
      window.addEventListener('mouseup', () => { dragArea = null; });
      // 指(2026-09-24): 部品の上で触れたときだけページのスクロールを止めて操作する。
      // 部品の無いところはそのまま縦スクロールできる(touch-action を殺さないので touch イベントで横取りする)
      const touchPos = (t) => canvasPos({ clientX: t.clientX, clientY: t.clientY });
      const TOUCH_TOL = 16;
      diagram.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const pos = touchPos(e.touches[0]);
        const area = hitTest(pos, TOUCH_TOL);
        if (!area) return;
        e.preventDefault(); // スクロールと、後から来る擬似マウスイベントを止める
        if (area.kind === 'tag') {
          patch[area.op][area.key] = patch[area.op][area.key] ? 0 : 1;
          syncInputsFromPatch(); redraw(false);
          return;
        }
        dragArea = area;
        hoverArea = area;
        applyDrag(area, pos);
        syncInputsFromPatch(); redraw(false);
      }, { passive: false });
      diagram.addEventListener('touchmove', (e) => {
        if (!dragArea) return;
        e.preventDefault();
        applyDrag(dragArea, touchPos(e.touches[0]));
        syncInputsFromPatch(); redraw(false);
      }, { passive: false });
      const touchEnd = () => { if (dragArea) { dragArea = null; hoverArea = null; drawDiagram(); } };
      diagram.addEventListener('touchend', touchEnd);
      diagram.addEventListener('touchcancel', touchEnd);
      // 掴めるところではカーソルを変える
      // 押せる部品ごとの説明(ツールチップ)。キャンバス1枚なので要素のtitleは使えず、
      // 乗っている部品に合わせて canvas の title を差し替える
      const diagramTitle = diagram.title;
      function describeArea(a) {
        if (!a) return diagramTitle;
        const isMod = a.op === 'mod';
        switch (a.kind) {
          case 'peak': return isMod
            ? T('ピーク: 左右にドラッグ=AR(立ち上がりの速さ) / 上下=TL(変調の深さ)')
            : T('ピーク: 左右にドラッグ=AR(立ち上がりの速さ)。高さはMMLの v<n> で決まるので動かせません');
          case 'knee': return T('ひざ: 左右にドラッグ=DR(減衰の速さ) / 上下=SL(持続レベル)');
          case 'rel': return T('リリース終端: 左右にドラッグ=RR(離鍵後に消える速さ。EG-TYP消灯時は押鍵中に減衰する速さ)');
          case 'tl': return T('TL 変調の深さ: 上下にドラッグ。上=0=いちばん深い(倍音が多く明るい) / 下=63=変調なし(サイン波)');
          case 'fb': return T('FB 自己帰還: クリック/ドラッグで0-7。モジュレータが自分の出力で自分を変調する量。大きいほどノコギリ波に近づく');

          case 'tag': switch (a.key) {
            case 'VB': return T('VIB ビブラート: クリックで反転。チップ内蔵のLFO(約6.4Hz)で音程を揺らす');
            case 'AM': return T('AM トレモロ: クリックで反転。チップ内蔵のLFO(約3.7Hz)で音量を揺らす');
            case 'KR': return T('KSR 音階レート: クリックで反転。点灯=高い音ほどエンベロープが速くなる');
            case 'EG': return T('EG-TYP 持続音: クリックで反転。点灯=押している間SLの高さで鳴り続ける / 消灯=RRの速さで減衰する打楽器的な音');
            case 'WF': return isMod
              ? T('DM 変調波の半波整流: クリックで反転。点灯=負側を0にした波形で変調する(倍音の付き方が変わる)')
              : T('DC 搬送波の半波整流: クリックで反転。点灯=負側を0にした波形を出力する(偶数倍音が増える)');
          }
        }
        return diagramTitle;
      }
      diagram.addEventListener('mousemove', (e) => {
        if (dragArea) return;
        const a = hitTest(canvasPos(e));
        diagram.style.cursor = !a ? 'default'
          : (a.kind === 'tag' || a.kind === 'fb') ? 'pointer'
          : a.kind === 'tl' ? 'ns-resize' : 'grab';
        // 乗っている部品が変わったときだけ描き直す(毎回描くとドラッグ以外でもちらつく)
        const same = (a && hoverArea) ? (a.kind === hoverArea.kind && a.op === hoverArea.op && a.key === hoverArea.key)
          : (a === hoverArea);
        if (!same) { hoverArea = a; diagram.title = describeArea(a); drawDiagram(); }
      });
      diagram.addEventListener('mouseleave', () => {
        if (hoverArea) { hoverArea = null; diagram.title = diagramTitle; drawDiagram(); }
      });

      // 再描画(図はすぐ、実チップの計算は間引く)
      let redrawTimer = null;
      function redraw(immediate) {
        setDirty(true);
        valuesEl.textContent = formatDefOneLine(currentIndex, patch, outFormat);
        if (redrawTimer) clearTimeout(redrawTimer);
        if (immediate) { recomputeOutput(); drawDiagram(); return; }
        drawDiagram();
        redrawTimer = setTimeout(() => { redrawTimer = null; recomputeOutput(); drawDiagram(); }, 120);
      }
      function onInputChanged() { readPatchFromInputs(); redraw(false); }
      for (const op of ['mod', 'car']) {
        for (const name of Object.keys(inputs[op])) {
          inputs[op][name].el.addEventListener('input', onInputChanged);
          inputs[op][name].el.addEventListener('change', onInputChanged);
        }
      }
      fbEl.addEventListener('input', onInputChanged);
      fbEl.addEventListener('change', onInputChanged);

      // ── MMLへの書き戻し(反映・新規のときだけ) ─────────────────────────
      function writeDef(index, p, kind) {
        // 差し替え先は@OP/@OTのどちらでもよい(同じ番号の既存定義をそのまま上書きする)
        Defs.write(mmlSourceEl, ['OP', 'OT'], index, formatDefText(index, p, kind));
      }

      function refreshIndexSelect() {
        const indices = listIndices(mmlSourceEl.value);
        const list = indices.length ? indices : [0];
        selectEl.innerHTML = '';
        for (const idx of list) {
          const opt = document.createElement('option');
          opt.value = String(idx); opt.textContent = String(idx);
          selectEl.appendChild(opt);
        }
        const want = String(currentIndex);
        selectEl.value = list.map(String).includes(want) ? want : String(list[0]);
        currentIndex = parseInt(selectEl.value, 10) || 0;
      }
      selectEl.addEventListener('mousedown', refreshIndexSelect);

      function loadFromMml() {
        const r = readPatch(mmlSourceEl.value, currentIndex);
        if (r) { patch = r.patch; outFormat = r.kind; formatEl.value = r.kind; }
        else { patch = defaultPatch(); }
        syncInputsFromPatch();
        redraw(true);
        setDirty(false);
      }
      selectEl.addEventListener('change', () => {
        currentIndex = parseInt(selectEl.value, 10) || 0;
        loadFromMml();
        regenerateSamplePhraseIfClean();
      });
      formatEl.addEventListener('change', () => { outFormat = formatEl.value; redraw(true); });
      noteEl.addEventListener('change', () => { const d = dirty; redraw(true); setDirty(d); regenerateSamplePhraseIfClean(); }); // 音程は定義に入らない

      // --- 内蔵音色プリセット(die dumpの実ROM値。src/convert/vrc7Tone.js) ---
      function fillPresets() {
        const names = (MML.Convert && MML.Convert.Vrc7Tone) ? MML.Convert.Vrc7Tone.PRESET_NAMES : [];
        presetEl.innerHTML = '';
        const head = document.createElement('option');
        head.value = ''; head.textContent = T('内蔵音色から…');
        presetEl.appendChild(head);
        for (let i = 1; i <= 15; i++) {
          const o = document.createElement('option');
          o.value = String(i); o.textContent = `@${i} ${names[i] || ''}`.trim();
          presetEl.appendChild(o);
        }
        // ゲームの自作音色(実機のレジスタ書き込みから採取。src/convert/vrc7Tone.js GAME_TONES)
        const games = (MML.Convert && MML.Convert.Vrc7Tone && MML.Convert.Vrc7Tone.GAME_TONES) || [];
        games.forEach((g, gi) => {
          const grp = document.createElement('optgroup');
          grp.label = T(g.game);
          g.tones.forEach((t, ti) => {
            const o = document.createElement('option');
            o.value = `g${gi}:${ti}`;
            // ゲーム名は optgroup の見出しに出るので、項目は「サンプル#n(使われている曲番号)」だけ(ユーザー指定)
            o.textContent = T('サンプル#{n}({songs})', { n: ti + 1, songs: t.songs.map((x) => x + 1).join(',') });
            grp.appendChild(o);
          });
          presetEl.appendChild(grp);
        });
      }
      fillPresets();
      // 見出しと「サンプル#n(曲番号)」は引数付きの文言なので、表示言語を切り替えたら作り直す
      if (MML.I18n) MML.I18n.onChange(fillPresets);
      presetEl.addEventListener('change', () => {
        const v = presetEl.value;
        presetEl.value = '';
        if (!v || !MML.Convert || !MML.Convert.Vrc7Tone) return;
        const V = MML.Convert.Vrc7Tone;
        let bytes = null;
        const gm = /^g(\d+):(\d+)$/.exec(v);
        if (gm) { const g = (V.GAME_TONES || [])[+gm[1]]; bytes = g && g.tones[+gm[2]] && g.tones[+gm[2]].bytes; }
        else bytes = V.PRESETS[parseInt(v, 10)];
        if (!bytes) return;
        patch = bytesToPatch(bytes);
        syncInputsFromPatch();
        redraw(true);
      });

      // 音程の選択肢
      for (const c of NOTE_CHOICES) {
        const o = document.createElement('option');
        o.value = c.label; o.textContent = c.label;
        noteEl.appendChild(o);
      }
      noteEl.selectedIndex = 1;

      // --- 説明トグル ---
      const helpBtn = $('vrc7ToneHelp'), helpBox = $('vrc7ToneHelpText');
      if (helpBtn && helpBox) {
        helpBtn.addEventListener('click', () => {
          helpBox.style.display = helpBox.style.display === 'none' ? 'block' : 'none';
        });
      }

      // --- サンプル再生フレーズ(VRC7のチャンネル文字はppmck準拠でG-L固定) ---
      // ★2ch使う: 自作音色スロットはチップ全体で1つなので、複数chで同時に鳴らすと
      //   必ず同じ音色になる。単音だけでは分からない「重ねたときの太さ」を確かめられるよう、
      //   既定のフレーズは 単音 → ユニゾン → デチューン → オクターブ重ね の4小節に加えて、
      //   メロディ(o4-o5)とベース(o2-o3)の2小節。音域で表情が変わる(KSL/KSR/MLの効き)ので
      //   高い方と低い方の両方で聴けるようにするため。
      //   D<n> はVRC7でも使える(EP/MP/PTは非対応だがD/ENは可。fnumへの直接加算で、
      //   o4c付近は1あたり約5セント)。3小節目はH側をD6=約30セントずらして
      //   うなりの出る「太いユニゾン」を聴かせる。4小節目に入る前にD0で戻す。
      let sampleDirty = false;
      sampleMmlEl.addEventListener('input', () => { sampleDirty = true; });
      function regenerateSamplePhraseIfClean() {
        if (sampleDirty) return;
        const m = (NOTE_CHOICES[Math.max(0, noteEl.selectedIndex)] || NOTE_CHOICES[1]).label.match(/o(\d)/);
        const o = m ? parseInt(m[1], 10) : 4;
        const sc = 'cdefgab>c<';
        const up = Math.min(7, o + 1), lo = Math.max(1, o - 2);
        sampleMmlEl.value =
          '; ①単音 ②ユニゾン ③デチューン(D6≒30セント) ④オクターブ重ね ⑤⑥メロディ+ベース\n' +
          `G @0 OP${currentIndex} l8 o${o} ${sc} ${sc} ${sc} ${sc}` +
          ` o${o} efgab>cde< b4g4e4c4\n` +
          `H @0 OP${currentIndex} l8 r1 o${o} ${sc} D6 ${sc} D0 o${up} ${sc}` +
          ` o${lo} c4g4>c4<g4 f4>c4<f4c4`;
      }

      // --- 新規 ---
      $('vrc7ToneAdd').addEventListener('click', () => {
        const indices = listIndices(mmlSourceEl.value);
        currentIndex = indices.length ? Math.max(...indices) + 1 : 0;
        patch = defaultPatch();
        syncInputsFromPatch();
        writeDef(currentIndex, patch, outFormat);
        refreshIndexSelect();
        loadFromMml();
        regenerateSamplePhraseIfClean();
      });

      // --- 反映 ---
      function checkCompileErrors() {
        const compiled = MML.Mml.compile(mmlSourceEl.value, {});
        if (compiled.errors.length > 0) {
          statusEl.className = 'output fds-status-output error';
          statusEl.textContent = T('エラー:') + '\n' +
            compiled.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
        } else {
          statusEl.className = 'output fds-status-output';
          statusEl.textContent = '';
        }
      }
      $('vrc7ToneApply').addEventListener('click', () => {
        readPatchFromInputs();
        writeDef(currentIndex, patch, outFormat);
        setDirty(false);
        regenerateSamplePhraseIfClean();
        checkCompileErrors();
      });

      // --- 保存/読み込み(実ファイル。読み込みはローカルのみ) ---
      $('vrc7ToneSave').addEventListener('click', () => {
        const name = prompt(T('保存するファイル名を入力してください(拡張子不要)'), `vrc7tone-${currentIndex}`);
        if (!name) return;
        const blob = new Blob([patchToBytes(patch).join(', ')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name.replace(/\.[^.]*$/, '') + '.txt';
        a.click(); URL.revokeObjectURL(url);
      });
      $('vrc7ToneLoad').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file'; MML.Device.setFileAccept(input, '.txt,.json,text/plain');
        input.addEventListener('change', () => {
          const file = input.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const vals = String(reader.result).trim().split(/[\s,]+/)
              .filter(s => s.length > 0).map(parseMmlNumber).filter(n => !isNaN(n));
            if (vals.length >= 24) {
              const rd = (a) => ({ AR: a[0], DR: a[1], SL: a[2], RR: a[3], KL: a[4], ML: a[5], AM: a[6], VB: a[7], EG: a[8], KR: a[9], WF: a[10] });
              patch = { fb: vals[1] & 7, mod: rd(vals.slice(2, 13)), car: rd(vals.slice(13, 24)) };
              patch.mod.TL = vals[0] & 63;
            } else if (vals.length >= 8) {
              patch = bytesToPatch(vals);
            } else return;
            syncInputsFromPatch();
            redraw(true);
          };
          reader.readAsText(file);
        });
        input.click();
      });

      // --- コピー/貼り付け(8バイトの数値列として。貼り付けもローカルのみ) ---
      function flashButton(btn, text) {
        const orig = btn.textContent;
        btn.textContent = text;
        setTimeout(() => { btn.textContent = orig; }, 900);
      }
      const copyBtn = $('vrc7ToneCopy'), pasteBtn = $('vrc7TonePaste');
      copyBtn.addEventListener('click', async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(patchToBytes(patch).join(', ')); ok = true; } catch (e) { ok = false; }
        flashButton(copyBtn, ok ? '✓' : '✗');
      });
      pasteBtn.addEventListener('click', async () => {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch (e) { flashButton(pasteBtn, '✗'); return; }
        const vals = text.trim().split(/[\s,]+/).filter(s => s.length > 0).map(parseMmlNumber).filter(n => !isNaN(n));
        if (vals.length < 8) { flashButton(pasteBtn, '✗'); return; }
        patch = vals.length >= 24
          ? (() => { const r = readPatch(`@OT0 = { ${vals.join(',')} }`, 0); return r ? r.patch : patch; })()
          : bytesToPatch(vals);
        syncInputsFromPatch();
        redraw(true);
        flashButton(pasteBtn, '✓');
      });

      // --- ウィンドウを開いた時にMMLから再読み込み ---
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          if (win.style.display === 'none') return; // 閉じる操作
          refreshIndexSelect();
          loadFromMml();
          regenerateSamplePhraseIfClean();
        });
      }

      // --- ダブルクリックで該当定義を開く(FDS/N163エディタと同じ操作) ---
      mmlSourceEl.addEventListener('dblclick', () => {
        const pos = mmlSourceEl.selectionStart;
        const hit = findEnclosingDef(mmlSourceEl.value, pos);
        if (!hit) return;
        if (win.style.display === 'none') { if (toggleBtn) toggleBtn.click(); }
        else if (win._famimmlWindow) win._famimmlWindow.bringToFront();
        currentIndex = hit.index;
        refreshIndexSelect();
        loadFromMml();
        regenerateSamplePhraseIfClean();
      });

      // --- サンプル再生(N163/FDSエディタと同じ作り。未反映の内容がそのまま鳴る) ---
      const envelopeEl = $('vrc7ToneEnvelope');
      let audioCtx = null;
      let activeSamplePlayer = null;
      function stopSamplePlayback() {
        if (activeSamplePlayer) { activeSamplePlayer.destroy(); activeSamplePlayer = null; }
      }
      function playSample() {
        stopSamplePlayback();
        readPatchFromInputs();
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        let defText = extractDefinitionLines(mmlSourceEl.value);
        if (!/^\s*#EX-VRC7\b/im.test(defText)) defText = '#EX-VRC7\n' + defText;
        // 「反映」を押していなくても今の内容が鳴るよう、選択中インデックスの定義を上書きする
        const liveDef = formatDefText(currentIndex, patch, 'op');
        const vol = (envelopeEl.value.trim() || '11');
        const phrase = sampleMmlEl.value.trim() || `G @0 OP${currentIndex} o4 l4 cdefgab>c`;
        // v は数値1つなら v<n>、"|"入りなら @v テーブルとして解釈する
        const volCmd = /[|,\s]/.test(vol) ? `@v98 = { ${vol} }\n` : '';
        const volPrefix = volCmd ? '@v98' : `v${parseInt(vol, 10) || 11}`;
        // 音量はフレーズが使う全chへ先に流す(2ch以上のユニゾンでも同じ音量になるように)
        const chs = [...new Set(phrase.match(/^[G-L]/gm) || ['G'])].join('');
        const tempSource = `${defText}\n${liveDef}\n${volCmd}${chs} ${volPrefix}\n${phrase}\n`;
        const compiled = MML.Mml.compile(tempSource, {});
        statusEl.className = 'output fds-status-output';
        if (compiled.errors.length > 0) {
          statusEl.classList.add('error');
          statusEl.textContent = T('エラー:') + '\n' +
            compiled.errors.map(e => e.lineNo ? `[Line ${e.lineNo}] ${e.message}` : e.message).join('\n');
          return;
        }
        const player = new MML.Audio.MmlStreamPlayer(audioCtx);
        player.load(compiled, null);
        player.onEnded = () => { activeSamplePlayer = null; statusEl.textContent = T('再生終了'); };
        player.play();
        activeSamplePlayer = player;
        statusEl.classList.add('ok');
        statusEl.textContent = T('再生中...');
      }
      $('vrc7TonePlay').addEventListener('click', playSample);
      $('vrc7ToneStop').addEventListener('click', () => {
        stopSamplePlayback();
        statusEl.className = 'output fds-status-output';
        statusEl.textContent = T('停止');
      });

      // --- 逆算(出力波形 → パラメータ) ---
      // 倍音バーのドラッグ
      let harmDrag = false;
      if (harmCv) {
        const applyHarm = (e) => {
          const pos = harmPos(e), k = harmIndexAt(pos);
          if (k < 0) return;
          const { y, h } = harmGeom();
          setTargetMag(k, (y + h - pos.y) / (h - 2));
          drawDiagram();
        };
        harmCv.addEventListener('mousedown', (e) => {
          if (harmIndexAt(harmPos(e)) < 0 || !ensureTarget()) return;
          e.preventDefault(); harmDrag = true; applyHarm(e);
        });
        window.addEventListener('mousemove', (e) => { if (harmDrag) applyHarm(e); });
        window.addEventListener('mouseup', () => { harmDrag = false; });
        harmCv.addEventListener('mousemove', (e) => {
          const k = harmIndexAt(harmPos(e));
          harmCv.style.cursor = k < 0 ? 'default' : 'ns-resize';
          if (k !== harmHover) { harmHover = k; drawHarm(); }
        });
        harmCv.addEventListener('mouseleave', () => { if (harmHover !== -1) { harmHover = -1; drawHarm(); } });
        // 指(2026-09-24): バーの上で触れたらスクロールを止めてなぞった高さを入れる
        const tp = (e) => ({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        harmCv.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          if (harmIndexAt(harmPos(tp(e))) < 0 || !ensureTarget()) return;
          e.preventDefault(); harmDrag = true; applyHarm(tp(e));
        }, { passive: false });
        harmCv.addEventListener('touchmove', (e) => {
          if (!harmDrag || e.touches.length !== 1) return;
          e.preventDefault(); applyHarm(tp(e));
        }, { passive: false });
        const harmTouchEnd = () => { harmDrag = false; };
        harmCv.addEventListener('touchend', harmTouchEnd);
        harmCv.addEventListener('touchcancel', harmTouchEnd);
      }
      // 出力波形キャンバスへの手描き
      let outDrag = false;
      if (outCv) {
        const outPos = (e) => {
          const r = outCv.getBoundingClientRect();
          return { x: (e.clientX - r.left) * (outCv.width / r.width), y: (e.clientY - r.top) * (outCv.height / r.height) };
        };
        const inPlot = (pos) => { const g = outGeom(); return pos.x >= g.px0 && pos.x <= g.px0 + g.pw && pos.y >= g.py0 && pos.y <= g.py0 + g.ph; };
        outCv.addEventListener('mousedown', (e) => {
          const pos = outPos(e);
          if (!inPlot(pos) || !ensureTarget()) return;
          e.preventDefault(); outDrag = true; drawLast = null;
          drawTargetAt(pos); drawOut();
        });
        window.addEventListener('mousemove', (e) => { if (outDrag) { drawTargetAt(outPos(e)); drawOut(); } });
        window.addEventListener('mouseup', () => {
          if (!outDrag) return;
          outDrag = false; drawLast = null;
          // 描き終わり: 手描きの波形から倍音を取り直す(倍音バーが追随する)
          setTargetFromWave(target.wave);
          drawDiagram();
        });
        outCv.addEventListener('mousemove', (e) => {
          const h = inPlot(outPos(e));
          outCv.style.cursor = h ? 'crosshair' : 'default';
          if (h !== outHover) { outHover = h; drawOut(); }
        });
        outCv.addEventListener('mouseleave', () => { if (outHover) { outHover = false; drawOut(); } });
        // 指(2026-09-24): 波形の枠の中で触れたらスクロールを止めて手描きする。離したら倍音を取り直す
        const tp = (e) => ({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        outCv.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          const pos = outPos(tp(e));
          if (!inPlot(pos) || !ensureTarget()) return;
          e.preventDefault(); outDrag = true; drawLast = null;
          drawTargetAt(pos); drawOut();
        }, { passive: false });
        outCv.addEventListener('touchmove', (e) => {
          if (!outDrag || e.touches.length !== 1) return;
          e.preventDefault(); drawTargetAt(outPos(tp(e))); drawOut();
        }, { passive: false });
        const outTouchEnd = () => {
          if (!outDrag) return;
          outDrag = false; drawLast = null;
          setTargetFromWave(target.wave);
          drawDiagram();
        };
        outCv.addEventListener('touchend', outTouchEnd);
        outCv.addEventListener('touchcancel', outTouchEnd);
      }
      let solveCandidates = [];
      let solving = false;
      function applyCandidate(c) {
        patch.mod.WF = c.dm; patch.car.WF = c.dc; patch.mod.ML = c.mlm; patch.car.ML = c.mlc;
        patch.fb = c.fb; patch.mod.TL = c.tl;
        syncInputsFromPatch(); redraw(true);
      }
      function fillSolveList() {
        solveListEl.innerHTML = '';
        solveCandidates.forEach((c, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = T('{i}: 一致{c}% DM{dm} DC{dc} ML{mlm}:{mlc} FB{fb} TL{tl}', {
            i: i + 1, c: Math.round(c.corr * 100), dm: c.dm, dc: c.dc,
            mlm: c.mlm === 0 ? '0.5' : c.mlm, mlc: c.mlc === 0 ? '0.5' : c.mlc, fb: c.fb, tl: c.tl });
          solveListEl.appendChild(opt);
        });
      }
      solveListEl.addEventListener('change', () => {
        const c = solveCandidates[+solveListEl.value];
        if (c) applyCandidate(c);
      });
      targetClearBtn.addEventListener('click', clearTarget);
      solveBtn.addEventListener('click', async () => {
        if (solving) return;
        const S = Solver();
        if (!S || !target) {
          statusEl.className = 'output fds-status-output';
          statusEl.textContent = T('逆算するには目標の波形が要ります(出力セルにドラッグで手描き、または倍音バーをドラッグ)');
          return;
        }
        solving = true; solveBtn.disabled = true;
        statusEl.className = 'output fds-status-output';
        try {
          // 1) 厳密モデル(Nuked-OPLLの演算)で総当たり → 倍音の振幅が近い上位12
          const top = await S.search(target.mag, {
            onProgress: (p) => { statusEl.textContent = T('逆算中… {p}%', { p: Math.round(p * 100) }); }
          });
          // 2) 上位候補を「いまのエンベロープのまま」実チップで鳴らし、目標との波形一致率で並べ直す
          //    (モデルは定常状態なので、実際の音での順位で最終判断する)
          statusEl.textContent = T('逆算: 候補を実チップで鳴らして照合中…');
          await new Promise((r) => setTimeout(r, 0));
          const note = NOTE_CHOICES[Math.max(0, noteEl.selectedIndex)] || NOTE_CHOICES[1];
          const f0 = OPLL_SAMPLE_RATE * note.fnum / Math.pow(2, 19 - note.block);
          const period = Math.max(4, Math.round(OPLL_SAMPLE_RATE / f0));
          const base = JSON.parse(JSON.stringify(patch));
          for (const c of top) {
            const q = JSON.parse(JSON.stringify(base));
            q.mod.WF = c.dm; q.car.WF = c.dc; q.mod.ML = c.mlm; q.car.ML = c.mlc; q.fb = c.fb; q.mod.TL = c.tl;
            const r = renderPatch(q, note.fnum, note.block, 0.5, 0.05);
            let pi = 0, pa = 0;
            for (let i = 0; i < r.keyOffAt - period * 2; i++) { const v = Math.abs(r.buf[i]); if (v > pa) { pa = v; pi = i; } }
            const start = Math.max(0, pi - (period >> 1));
            c.corr = pa > 1e-6 ? S.corr(target.wave, S.resample(r.buf.subarray(start, start + period), S.N)) : 0;
          }
          top.sort((a, b) => b.corr - a.corr);
          solveCandidates = top;
          fillSolveList();
          applyCandidate(top[0]);
          let msg = T('逆算完了: 最良の一致率 {c}%(候補{n}件)。選び直しは右の一覧から', { c: Math.round(top[0].corr * 100), n: top.length });
          if (!patch.mod.EG || !patch.car.EG) msg += '\n' + T('エンベロープが減衰型(EG-TYP消灯)のため定常波形が無く、一致率は目安です');
          statusEl.textContent = msg;
        } catch (e) {
          statusEl.className = 'output fds-status-output error';
          statusEl.textContent = T('エラー:') + '\n' + (e && e.message ? e.message : String(e));
        } finally {
          solving = false; solveBtn.disabled = false;
        }
      });

      // --- 初期化 ---
      refreshIndexSelect();
      loadFromMml();
      regenerateSamplePhraseIfClean();
    }
  };
})(window);
