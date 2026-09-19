/*
 * 本記譜のレイアウトと描画(作業計画「フェーズ外: 楽譜出力」段階4、2026-09-16)
 *
 * notation.js の表記モデル(小節/音符片/音価の型/付点/連符/タイ/スラー/連桁/臨時記号)を、
 * 記譜間隔(音価に応じた幅)で段組みした「紙の楽譜」として canvas 2D に描く。
 * 外部の楽譜描画ライブラリは使わない(記号はすべて自前の path/文字)。
 *
 *   layout = Score.layoutScore(notation, { sp, width, measureText })
 *     sp: 五線の間隔(px)。全ての寸法は sp の倍数。width: 段の幅(px)
 *     → { sp, width, height, leftW, systems:[{ y, staffY:[...], measures:[{ index, x, w, cols:[{units,x}] }] }],
 *         measureSystem:[段番号], notation }
 *   Score.drawScore(ctx, layout, { colorOf(letter)→色, staffColor, textColor, cursorFrame })
 *   Score.cursorAtFrame(layout, frame) → { x, y0, y1, system } | null   再生カーソル(コンパイラのフレーム→座標)
 *
 * 座標の約束: 五線の第1線(いちばん下)の y を staffY とし、音の高さは「第1線からの半段数 d」
 * (notation の pitch/unpitched から Score.staffStep で求める)で y = staffY - d*sp/2。
 * 記譜間隔: 小節ごとに全パートの音符の開始位置(units)を「列」にまとめ、隣の列までの音価が
 * 長いほど幅を対数で広げる(gap 16分=1、倍ごとに +1.3sp)。段に入る小節数は幅から決め、
 * 段の中で列幅を比例で伸ばして右端を揃える(最終段は伸ばしすぎない)。
 */
(function (global) {
  const MML = global.MML = global.MML || {};
  const Score = MML.Score = MML.Score || {};

  const LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  const MUSIC_FONT = 'Bravura, "Segoe UI Symbol", "Noto Music", "Apple Symbols", Symbola, sans-serif';
  const TEXT_FONT = 'system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif';
  const ACC_TEXT = { '-2': '\u{1D12B}', '-1': '♭', '0': '♮', '1': '♯', '2': '\u{1D12A}' };
  // 調号の位置(ト音記号、第1線からの半段数)。♯: F C G D A E B / ♭: B E A D G C F
  const SHARP_POS = [8, 5, 9, 6, 3, 7, 4];
  const FLAT_POS = [4, 7, 3, 6, 2, 5, 1];

  function refOf(part) { return (part.clef && part.clef.sign === 'F') ? 2 * 7 + 4 : 4 * 7 + 2; }
  // 音符片 → 第1線からの半段数 d(第1線=0、第5線=8)
  Score.staffStep = function (item, part) {
    const sym = item.pitch || item.unpitched;
    if (!sym) return 4;
    return sym.octave * 7 + LETTER_INDEX[sym.step] - refOf(part);
  };

  // ── レイアウト ────────────────────────────────────────────────────
  Score.layoutScore = function (notation, opts) {
    opts = opts || {};
    const sp = opts.sp || 7;
    const width = Math.max(200, opts.width || 900);
    const parts = notation.parts;
    const nP = parts.length;
    const U = notation.units;
    const measureUnits = notation.time.beats * U / notation.time.beatType;
    const minGap = U / 16;
    const nM = parts.length ? Math.max(...parts.map(p => p.measures.length)) : 0;
    const measureText = opts.measureText || ((s, px) => s.length * px * 0.58);

    // パート名の欄(段の左)。1段目は名前、2段目以降は文字だけ。幅は名前の最大幅
    const namePx = Math.max(9, Math.round(sp * 1.5));
    const leftW = nP ? Math.ceil(Math.max(...parts.map(p => measureText(p.name, namePx))) + sp) : 0;

    // 小節ごとの列(全パート共通の開始位置)と幅
    const measures = [];
    for (let m = 0; m < nM; m++) {
      const posSet = new Map(); // units(小節内) → { acc:臨時記号あり, dots:付点あり }
      const add = (u, acc, dots) => { const e = posSet.get(u) || { acc: false, dots: false }; e.acc = e.acc || acc; e.dots = e.dots || dots; posSet.set(u, e); };
      add(0, false, false);
      for (const part of parts) {
        const mm = part.measures[m];
        if (!mm) continue;
        for (const it of mm.items) {
          if (it.measureRest) continue;
          add(it.pos - mm.startUnits, !!it.accidental, it.dots > 0);
        }
      }
      const units = Array.from(posSet.keys()).sort((a, b) => a - b);
      const cols = [];
      let content = 0;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        const next = i + 1 < units.length ? units[i + 1] : measureUnits;
        const gap = Math.max(1, next - u);
        const e = posSet.get(u);
        const lead = e.acc ? sp * 1.4 : 0;                       // 臨時記号のぶん前を空ける
        let w = sp * (1.9 + 1.3 * Math.max(0, Math.log2(gap / minGap)));
        if (e.dots) w += sp * 0.7;
        w = Math.max(w, sp * 1.9);
        cols.push({ units: u, lead, w });
        content += lead + w;
      }
      measures.push({ index: m, cols, content, padL: sp * 1.0, padR: sp * 0.4 });
    }

    // 段の先頭に付く音部記号/調号/拍子の幅
    const fifths = notation.key.fifths | 0;
    const clefW = sp * 3.4;
    const keyW = fifths ? Math.abs(fifths) * sp * 1.05 + sp * 0.6 : 0;
    const timeW = sp * 2.8;
    const headerW = (first) => clefW + keyW + (first ? timeW : 0) + sp * 0.6;

    // 段に詰める
    const avail = width - leftW - sp * 1.5;
    const systems = [];
    let cur = null;
    for (const me of measures) {
      const mw = me.padL + me.content + me.padR;
      const hw = headerW(systems.length === 0 && !cur);
      if (!cur || (cur.width + mw > avail && cur.measures.length > 0)) {
        if (cur) systems.push(cur);
        cur = { measures: [], width: headerW(systems.length === 0), headerW: headerW(systems.length === 0) };
      }
      cur.measures.push(me);
      cur.width += mw;
    }
    if (cur) systems.push(cur);

    // 縦の寸法
    const staffH = 4 * sp;
    const partGap = sp * 5.5;
    const topPad = sp * 3.5;                                        // テンポ記号/小節番号の余地
    const sysH = topPad + nP * (staffH + partGap) - partGap + sp * 2.5;
    const sysGap = sp * 3;
    let y = sp * 2;
    const measureSystem = new Array(nM);
    systems.forEach((sys, si) => {
      sys.index = si;
      sys.y = y;
      sys.top = y + topPad;
      sys.staffY = [];
      for (let i = 0; i < nP; i++) sys.staffY.push(sys.top + i * (staffH + partGap) + staffH); // 第1線の y
      sys.bottom = sys.staffY[nP - 1] || sys.top;
      // 横: 列幅を比例で伸ばして右端を揃える(最終段は 1.4倍まで)
      const contentSum = sys.measures.reduce((a, me) => a + me.padL + me.content + me.padR, 0);
      let scale = contentSum > 0 ? (avail - sys.headerW) / contentSum : 1;
      if (si === systems.length - 1) scale = Math.min(scale, 1.4);
      scale = Math.max(scale, 0.5);
      let x = leftW + sys.headerW;
      sys.x0 = leftW;
      sys.headerX = leftW;
      for (const me of sys.measures) {
        me.system = si;
        me.x = x;
        let cx = x + me.padL * scale;
        for (const c of me.cols) {
          cx += c.lead * scale;
          c.x = cx;
          cx += c.w * scale;
        }
        me.w = (me.padL + me.content + me.padR) * scale;
        me.xEnd = x + me.w;
        x = me.xEnd;
        measureSystem[me.index] = si;
      }
      sys.xEnd = x;
      y += sysH + sysGap;
    });

    return { sp, width, height: Math.ceil(y + sp * 2), leftW, systems, measures, measureSystem, measureUnits, notation, namePx, fifths };
  };

  // 小節 index 内の位置 units → x(列の間は線形補間)
  function xAtUnits(layout, me, units) {
    const cols = me.cols;
    if (!cols.length) return me.x;
    if (units <= cols[0].units) return cols[0].x;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const nextU = i + 1 < cols.length ? cols[i + 1].units : layout.measureUnits;
      const nextX = i + 1 < cols.length ? cols[i + 1].x : me.xEnd - me.padR;
      if (units < nextU) return c.x + (units - c.units) / (nextU - c.units) * (nextX - c.x);
    }
    return me.xEnd - me.padR;
  }
  Score.xAtUnits = xAtUnits;

  // 再生カーソル: コンパイラのフレーム → 座標。小節のフレーム範囲は先頭パートのものを使う
  Score.cursorAtFrame = function (layout, frame) {
    const parts = layout.notation.parts;
    if (!parts.length || frame == null || frame < 0) return null;
    const ms = parts[0].measures;
    let mi = -1;
    for (let i = 0; i < ms.length; i++) { if (frame < ms[i].frameEnd) { mi = i; break; } }
    if (mi < 0) return null;
    const m = ms[mi];
    const frac = (m.frameEnd > m.frameStart) ? Math.max(0, Math.min(1, (frame - m.frameStart) / (m.frameEnd - m.frameStart))) : 0;
    const me = layout.measures[mi];
    const sys = layout.systems[layout.measureSystem[mi]];
    if (!me || !sys) return null;
    return { x: xAtUnits(layout, me, frac * layout.measureUnits), y0: sys.top - layout.sp, y1: sys.bottom + layout.sp * 1.5, system: sys.index, measure: mi };
  };

  // ── 描画 ──────────────────────────────────────────────────────────
  const TYPE_FLAGS = { 8: 1, 16: 2, 32: 3, 64: 4, 128: 5, 256: 6 };

  Score.drawScore = function (ctx, layout, opts) {
    opts = opts || {};
    const { sp, notation } = layout;
    const staffColor = opts.staffColor || '#8a8aa0';
    const textColor = opts.textColor || '#e6e6ef';
    const colorOf = opts.colorOf || (() => textColor);
    const parts = notation.parts;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    const noteHead = (x, y, filled, color, percussion, wide) => {
      ctx.fillStyle = color; ctx.strokeStyle = color;
      if (percussion) {
        const r = sp * 0.5;
        ctx.lineWidth = Math.max(1, sp * 0.16);
        ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y - r); ctx.stroke();
        return;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-0.4);
      ctx.beginPath();
      ctx.ellipse(0, 0, wide ? sp * 0.78 : sp * 0.66, sp * 0.48, 0, 0, Math.PI * 2);
      if (filled) ctx.fill();
      else { ctx.lineWidth = Math.max(1, sp * 0.22); ctx.stroke(); }
      ctx.restore();
    };
    // 旗: 符幹の先端(x, yTip)から符頭の側(toward: +1=下へ, -1=上へ)へ垂れる曲線。2本目以降は符頭側へずらす
    const flag = (x, yTip, toward, count, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, sp * 0.42);
      ctx.lineCap = 'round';
      for (let k = 0; k < count; k++) {
        const yy = yTip + toward * k * sp * 0.85;
        ctx.beginPath();
        ctx.moveTo(x, yy);
        ctx.bezierCurveTo(x + sp * 0.15, yy + toward * sp * 1.1, x + sp * 1.3, yy + toward * sp * 1.4, x + sp * 1.05, yy + toward * sp * 2.9);
        ctx.stroke();
      }
      ctx.lineCap = 'butt';
    };
    const beamSeg = (x1, y1, x2, y2, color) => {
      const t = sp * 0.5;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 + t); ctx.lineTo(x1, y1 + t); ctx.closePath();
      ctx.fill();
    };
    const restGlyph = (x, staffY, noteType, dots, color, measureRest) => {
      ctx.fillStyle = color; ctx.strokeStyle = color;
      const mid = staffY - 2 * sp;
      if (noteType === 1 || measureRest) {          // 全休符: 第4線からぶら下がる
        ctx.fillRect(x - sp * 0.7, mid - sp, sp * 1.4, sp * 0.5);
      } else if (noteType === 2) {                  // 2分休符: 第3線に乗る
        ctx.fillRect(x - sp * 0.7, mid - sp * 0.5, sp * 1.4, sp * 0.5);
      } else if (noteType === 4) {                  // 4分休符(折れ線)
        ctx.lineWidth = Math.max(1, sp * 0.42);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x - sp * 0.35, mid - sp * 1.6);
        ctx.lineTo(x + sp * 0.35, mid - sp * 0.7);
        ctx.lineTo(x - sp * 0.25, mid + sp * 0.1);
        ctx.lineTo(x + sp * 0.35, mid + sp * 0.9);
        ctx.quadraticCurveTo(x - sp * 0.5, mid + sp * 0.3, x - sp * 0.05, mid + sp * 1.4);
        ctx.stroke();
        ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      } else {                                      // 8分以下: 斜めの棒+旗の玉
        const n = TYPE_FLAGS[noteType] || 1;
        ctx.lineWidth = Math.max(1, sp * 0.3);
        ctx.beginPath();
        ctx.moveTo(x + sp * 0.45, mid - sp * 0.9);
        ctx.lineTo(x - sp * 0.35 - (n - 1) * sp * 0.25, mid + sp * 1.0 + (n - 1) * sp * 0.6);
        ctx.stroke();
        for (let k = 0; k < n; k++) {
          const yy = mid - sp * 0.9 + k * sp * 0.85;
          const xx = x + sp * 0.45 - (k * sp * 0.85) * 0.42;
          ctx.beginPath(); ctx.arc(xx - sp * 0.55, yy + sp * 0.15, sp * 0.28, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = Math.max(1, sp * 0.18);
          ctx.beginPath(); ctx.moveTo(xx - sp * 0.5, yy + sp * 0.3); ctx.quadraticCurveTo(xx - sp * 0.1, yy + sp * 0.5, xx, yy); ctx.stroke();
          ctx.lineWidth = Math.max(1, sp * 0.3);
        }
      }
      for (let k = 0; k < dots; k++) { ctx.beginPath(); ctx.arc(x + sp * 1.2 + k * sp * 0.55, mid - sp * 0.5, sp * 0.22, 0, Math.PI * 2); ctx.fill(); }
    };
    const text = (s, x, y, px, opt) => {
      opt = opt || {};
      ctx.font = `${opt.bold ? 'bold ' : ''}${opt.italic ? 'italic ' : ''}${px}px ${opt.music ? MUSIC_FONT : TEXT_FONT}`;
      ctx.fillStyle = opt.color || textColor;
      ctx.textAlign = opt.align || 'left';
      ctx.textBaseline = opt.baseline || 'alphabetic';
      ctx.fillText(s, x, y);
    };
    const clef = (part, x, staffY) => {
      ctx.fillStyle = textColor;
      if (part.clef && part.clef.sign === 'percussion') {
        ctx.fillRect(x + sp * 0.6, staffY - 3 * sp, sp * 0.45, 2 * sp);
        ctx.fillRect(x + sp * 1.4, staffY - 3 * sp, sp * 0.45, 2 * sp);
      } else if (part.clef && part.clef.sign === 'F') {
        text('\u{1D122}', x + sp * 0.3, staffY - 3 * sp, Math.round(sp * 3.6), { music: true, baseline: 'middle' });
      } else {
        text('\u{1D11E}', x + sp * 0.2, staffY - 2 * sp, Math.round(sp * 5.6), { music: true, baseline: 'middle' });
      }
    };
    const keySig = (part, x, staffY) => {
      const f = layout.fifths;
      if (!f) return 0;
      const bass = part.clef && part.clef.sign === 'F';
      const perc = part.clef && part.clef.sign === 'percussion';
      if (perc) return Math.abs(f) * sp * 1.05 + sp * 0.6;
      const glyph = f > 0 ? ACC_TEXT['1'] : ACC_TEXT['-1'];
      const table = f > 0 ? SHARP_POS : FLAT_POS;
      for (let i = 0; i < Math.abs(f); i++) {
        const d = table[i] - (bass ? 2 : 0);
        text(glyph, x + i * sp * 1.05, staffY - d * sp / 2, Math.round(sp * 2.4), { align: 'left', baseline: 'middle' });
      }
      return Math.abs(f) * sp * 1.05 + sp * 0.6;
    };
    const timeSig = (x, staffY) => {
      const px = Math.round(sp * 3.2);
      text(String(notation.time.beats), x + sp * 1.2, staffY - 2 * sp, px, { bold: true, align: 'center', baseline: 'alphabetic' });
      text(String(notation.time.beatType), x + sp * 1.2, staffY, px, { bold: true, align: 'center', baseline: 'alphabetic' });
    };

    for (const sys of layout.systems) {
      const first = sys.index === 0;
      // 五線とパート名
      ctx.strokeStyle = staffColor;
      ctx.lineWidth = 1;
      parts.forEach((part, pi) => {
        const sy = sys.staffY[pi];
        ctx.beginPath();
        for (let i = 0; i < 5; i++) { const yy = Math.round(sy - i * sp) + 0.5; ctx.moveTo(sys.x0, yy); ctx.lineTo(sys.xEnd, yy); }
        ctx.stroke();
        // パート名(ピアノのような多段パートは最初の段にだけ、段の間の高さに出す)
        const grouped = part.group && pi > 0 && parts[pi - 1].group === part.group;
        if (!grouped) {
          let ly = sy - 2 * sp;
          if (part.group && pi + 1 < parts.length && parts[pi + 1].group === part.group) ly = (sy - 4 * sp + sys.staffY[pi + 1]) / 2;
          text(first ? part.name : part.letter, sys.x0 - sp * (part.group ? 1.6 : 0.6), ly, layout.namePx, { align: 'right', baseline: 'middle', color: colorOf(part.letter) });
        }
        clef(part, sys.headerX, sy);
        const kw = keySig(part, sys.headerX + sp * 3.4, sy);
        if (first) timeSig(sys.headerX + sp * 3.4 + kw, sy);
      });
      // 段の左端をまとめる線
      ctx.strokeStyle = staffColor;
      ctx.lineWidth = Math.max(1, sp * 0.18);
      ctx.beginPath(); ctx.moveTo(sys.x0 + 0.5, sys.staffY[0] - 4 * sp); ctx.lineTo(sys.x0 + 0.5, sys.bottom); ctx.stroke();
      // ピアノ(group='piano' の連続する段)の括弧 "{"
      for (let pi = 0; pi < parts.length; pi++) {
        if (!parts[pi].group) continue;
        let pj = pi; while (pj + 1 < parts.length && parts[pj + 1].group === parts[pi].group) pj++;
        if (pj > pi) {
          const yTop = sys.staffY[pi] - 4 * sp, yBot = sys.staffY[pj];
          const xb = sys.x0 - sp * 0.9, mid = (yTop + yBot) / 2;
          ctx.strokeStyle = textColor; ctx.lineWidth = Math.max(1.2, sp * 0.3);
          ctx.beginPath();
          ctx.moveTo(xb + sp * 0.5, yTop);
          ctx.bezierCurveTo(xb - sp * 0.6, yTop + (mid - yTop) * 0.5, xb + sp * 0.4, mid - sp * 0.6, xb - sp * 0.4, mid);
          ctx.bezierCurveTo(xb + sp * 0.4, mid + sp * 0.6, xb - sp * 0.6, yBot - (yBot - mid) * 0.5, xb + sp * 0.5, yBot);
          ctx.stroke();
        }
        pi = pj;
      }
      // 小節線と小節番号
      ctx.lineWidth = 1;
      sys.measures.forEach((me, k) => {
        const last = me.index === layout.measures.length - 1;
        parts.forEach((part, pi) => {
          const sy = sys.staffY[pi];
          // ピアノ(group)の段は小節線を段の間まで通す
          const joined = part.group && pi + 1 < parts.length && parts[pi + 1].group === part.group;
          const yEnd = joined ? sys.staffY[pi + 1] - 4 * sp : sy;
          ctx.strokeStyle = staffColor;
          ctx.beginPath();
          const xx = Math.round(me.xEnd) + 0.5;
          ctx.moveTo(xx, sy - 4 * sp); ctx.lineTo(xx, yEnd);
          if (last) { ctx.moveTo(xx - sp * 0.5, sy - 4 * sp); ctx.lineTo(xx - sp * 0.5, yEnd); }
          ctx.stroke();
          if (last) { ctx.fillStyle = staffColor; ctx.fillRect(me.xEnd - sp * 0.15, sy - 4 * sp, sp * 0.35, yEnd - (sy - 4 * sp)); }
        });
        if (k === 0 || (me.index + 1) % 4 === 0) {
          text(String(me.index + 1), me.x + (k === 0 ? 0 : sp * 0.2), sys.staffY[0] - 4 * sp - sp * 0.8, Math.round(sp * 1.5), { color: staffColor, baseline: 'alphabetic' });
        }
      });

      // 音符
      parts.forEach((part, pi) => {
        const sy = sys.staffY[pi];
        const color = colorOf(part.letter);
        const perc = !!part.percussion;
        const yOf = (d) => sy - d * sp / 2;
        for (const me of sys.measures) {
          const mm = part.measures[me.index];
          if (!mm) continue;
          const items = mm.items;
          // 各片の座標を先に決める(連桁/タイ/連符が前後の片を参照するため)
          const geo = items.map((it) => {
            if (it.measureRest) return { it, x: (me.x + me.xEnd) / 2, rest: true };
            const u = it.pos - mm.startUnits;
            const col = me.cols.find(c => c.units === u);
            const x = col ? col.x + sp * 0.7 : xAtUnits(layout, me, u);
            if (it.rest) return { it, x, rest: true };
            const d = Score.staffStep(it, part);
            // 和音: 各音の段位置。d/y は「符幹側の端の音」(向きは第3線から遠い方の音で決める)
            if (it.chord && it.chord.length > 1) {
              const heads = it.chord.map(cn => { const dd = cn.pitch.octave * 7 + { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }[cn.pitch.step] - refOf(part); return { cn, d: dd, y: yOf(dd) }; })
                .sort((a, b) => a.d - b.d);
              const lo = heads[0].d, hi = heads[heads.length - 1].d;
              const dir = (Math.abs(hi - 4) > Math.abs(lo - 4)) ? 1 : -1; // 上端が遠ければ符幹は下
              const ext = dir < 0 ? heads[heads.length - 1] : heads[0];      // 符幹の先端側の音
              return { it, x, y: ext.y, d: ext.d, rest: false, heads, chordDir: dir, yLo: heads[0].y, yHi: heads[heads.length - 1].y };
            }
            return { it, x, y: yOf(d), d, rest: false };
          });
          // 連桁グループ(beams[0] の begin〜end)を集めて符幹の向きを決める
          const groups = [];
          let g = null;
          geo.forEach((q, i) => {
            const b = q.it.beams && q.it.beams[0];
            if (b === 'begin') { g = { idx: [i] }; groups.push(g); }
            else if ((b === 'continue' || b === 'end') && g) { g.idx.push(i); if (b === 'end') g = null; }
          });
          const inGroup = new Map();
          for (const grp of groups) {
            const avg = grp.idx.reduce((a, i) => a + geo[i].d, 0) / grp.idx.length;
            grp.dir = avg < 4 ? -1 : 1; // -1=符幹が上
            for (const i of grp.idx) {
              inGroup.set(i, grp);
              const q = geo[i];
              if (q.heads) { // 連桁の向きに合わせて、符幹側の端の音を取り直す
                const ext = grp.dir < 0 ? q.heads[q.heads.length - 1] : q.heads[0];
                q.y = ext.y; q.d = ext.d; q.chordDir = grp.dir;
              }
            }
          }
          // 描く
          geo.forEach((q, i) => {
            const it = q.it;
            if (q.rest) { restGlyph(q.x, sy, it.noteType, it.dots, it.measureRest ? staffColor : color, it.measureRest); return; }
            const d = q.d, x = q.x, y = q.y;
            const filled = it.noteType >= 4;
            const grp = inGroup.get(i);
            const dir = grp ? grp.dir : (q.chordDir != null ? q.chordDir : (d < 4 ? -1 : 1));
            // 符頭の一覧(単音なら1個)。和音で隣り合う2度は符幹の反対側へずらす
            const heads = q.heads || [{ cn: null, d, y }];
            let prevD = null, flip = false;
            const hx = heads.map(h => {
              flip = (prevD != null && Math.abs(h.d - prevD) === 1) ? !flip : false;
              prevD = h.d;
              return flip ? x + (dir < 0 ? sp * 1.2 : -sp * 1.2) : x;
            });
            // 加線(各符頭)
            ctx.strokeStyle = staffColor; ctx.lineWidth = 1;
            ctx.beginPath();
            heads.forEach((h, k) => {
              if (h.d < 0) for (let kk = -2; kk >= h.d; kk -= 2) { const yy = Math.round(yOf(kk)) + 0.5; ctx.moveTo(hx[k] - sp * 1.1, yy); ctx.lineTo(hx[k] + sp * 1.1, yy); }
              if (h.d > 8) for (let kk = 10; kk <= h.d; kk += 2) { const yy = Math.round(yOf(kk)) + 0.5; ctx.moveTo(hx[k] - sp * 1.1, yy); ctx.lineTo(hx[k] + sp * 1.1, yy); }
            });
            ctx.stroke();
            // 臨時記号(各符頭。近い段の記号は左へ段違いにする)
            let accCol = 0, lastAccD = null;
            for (let k = heads.length - 1; k >= 0; k--) {
              const h = heads[k];
              const acc = h.cn ? h.cn.accidental : it.accidental;
              if (!acc) continue;
              const alter = h.cn ? h.cn.pitch.alter : (it.pitch || {}).alter;
              if (lastAccD != null && lastAccD - h.d < 6) accCol++; else accCol = 0;
              lastAccD = h.d;
              text(ACC_TEXT[String(alter)] || '', x - sp * 0.95 - accCol * sp * 1.5, h.y, Math.round(sp * 2.4), { align: 'right', baseline: 'middle', color });
            }
            // 符頭と付点
            heads.forEach((h, k) => {
              noteHead(hx[k], h.y, filled, color, perc, it.noteType === 1);
              for (let kk = 0; kk < it.dots; kk++) {
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.arc(hx[k] + sp * 1.1 + kk * sp * 0.55, (h.d % 2 === 0) ? h.y - sp * 0.5 : h.y, sp * 0.22, 0, Math.PI * 2); ctx.fill();
              }
            });
            // 符幹と旗(全音符は無し。連桁の中の音は後でまとめて)。和音は端から端まで1本
            if (it.noteType >= 2) {
              const sx = dir < 0 ? x + sp * 0.6 : x - sp * 0.6;
              q.sx = sx; q.dir = dir;
              const yBase = q.heads ? (dir < 0 ? q.yLo : q.yHi) : y; // 符幹の根元=反対側の端の音
              q.stemBase = yBase;
              if (!grp) {
                const tip = y + dir * sp * 3.5;
                ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, sp * 0.14);
                ctx.beginPath(); ctx.moveTo(sx, yBase); ctx.lineTo(sx, tip); ctx.stroke();
                const nf = TYPE_FLAGS[it.noteType] || 0;
                if (nf) flag(sx, tip, -dir, nf, color);
                q.tip = tip;
              }
            }
          });
          // 連桁
          for (const grp of groups) {
            const qs = grp.idx.map(i => geo[i]);
            const dir = grp.dir;
            const x1 = qs[0].sx, x2 = qs[qs.length - 1].sx;
            let y1 = qs[0].y + dir * sp * 3.5, y2 = qs[qs.length - 1].y + dir * sp * 3.5;
            const slope = Math.max(-sp, Math.min(sp, y2 - y1));
            y2 = y1 + slope;
            const beamY = (x) => x2 === x1 ? y1 : y1 + (x - x1) / (x2 - x1) * (y2 - y1);
            // 符幹の最短 2.5sp を保証(足りなければ連桁全体を符幹側へ寄せる)
            let shift = 0;
            for (const q of qs) { const need = dir * (beamY(q.sx) - q.y); if (need < sp * 2.5) shift = Math.max(shift, sp * 2.5 - need); }
            y1 += dir * shift; y2 += dir * shift;
            ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, sp * 0.14);
            for (const q of qs) { ctx.beginPath(); ctx.moveTo(q.sx, q.stemBase != null ? q.stemBase : q.y); ctx.lineTo(q.sx, beamY(q.sx)); ctx.stroke(); q.tip = beamY(q.sx); }
            const off = dir < 0 ? 0 : -sp * 0.5; // 符幹が下向きなら連桁は符幹の先端の上側に置く
            beamSeg(x1, beamY(x1) + off, x2, beamY(x2) + off, color);
            // 2段目以降(16分〜)
            const maxLv = Math.max(...qs.map(q => (q.it.beams || []).length));
            for (let lv = 1; lv < maxLv; lv++) {
              const o = off - dir * lv * sp * 0.75;
              let start = null;
              qs.forEach((q, k) => {
                const b = (q.it.beams || [])[lv];
                if (b === 'begin') start = q.sx;
                else if (b === 'end' && start != null) { beamSeg(start, beamY(start) + o, q.sx, beamY(q.sx) + o, color); start = null; }
                else if (b === 'forward hook') beamSeg(q.sx, beamY(q.sx) + o, q.sx + sp * 1.2, beamY(q.sx + sp * 1.2) + o, color);
                else if (b === 'backward hook') beamSeg(q.sx - sp * 1.2, beamY(q.sx - sp * 1.2) + o, q.sx, beamY(q.sx) + o, color);
              });
            }
          }
          // 連符の数字と括弧
          let tup = null;
          geo.forEach((q, i) => {
            const t = q.it.tuplet;
            if (!t) return;
            if (t.start) tup = { i0: i, items: [] };
            if (tup) tup.items.push(q);
            if (t.stop && tup) {
              const qs = tup.items;
              const xa = qs[0].x - sp * 0.7, xb = qs[qs.length - 1].x + sp * 0.7;
              const up = qs.every(q => q.rest || q.dir === -1 || q.dir == null);
              const ys = qs.map(q => q.rest ? sy - 2 * sp : (q.tip != null ? q.tip : q.y));
              const yy = up ? Math.min(...ys, sy - 4 * sp) - sp * 1.2 : Math.max(...ys, sy) + sp * 1.2;
              const beamed = qs.every(q => q.it.beams && q.it.beams.length);
              if (!beamed) {
                ctx.strokeStyle = color; ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(xa, yy + (up ? sp * 0.6 : -sp * 0.6)); ctx.lineTo(xa, yy); ctx.lineTo(xb, yy); ctx.lineTo(xb, yy + (up ? sp * 0.6 : -sp * 0.6));
                ctx.stroke();
              }
              text(String(t.actual), (xa + xb) / 2, yy + (up ? -sp * 0.2 : sp * 0.2), Math.round(sp * 1.7), { italic: true, bold: true, align: 'center', baseline: up ? 'alphabetic' : 'hanging', color });
              tup = null;
            }
          });
          // タイ/スラー(この片から次の片へ。段をまたぐときは段の端まで)
          geo.forEach((q, i) => {
            const it = q.it;
            if (q.rest) return;
            const chordTies = q.heads ? q.heads.filter(h => h.cn && h.cn.tieStart) : [];
            if (!(it.tieStart || it.slurStart || chordTies.length)) return;
            // 次の音程あり片(同じパート、次の小節へ続くこともある)。note を渡すと和音の中のその音の y
            let nq = null;
            for (let k = i + 1; k < geo.length; k++) if (!geo[k].rest) { nq = geo[k]; break; }
            const yInItem = (item, note, fallbackY) => {
              if (note != null && item.chord) { const cn = item.chord.find(c => c.note === note); if (cn) return yOf(cn.pitch.octave * 7 + { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }[cn.pitch.step] - refOf(part)); }
              return fallbackY;
            };
            let xEndArc, endItem = null, endY = null;
            if (nq) { xEndArc = nq.x - sp * 0.7; endItem = nq.it; endY = nq.y; }
            else {
              // 次の小節の先頭の音程あり片
              const nm = part.measures[me.index + 1];
              const nextIt = nm && nm.items.find(z => !z.rest);
              const nextMe = layout.measures[me.index + 1];
              if (nextIt && nextMe && nextMe.system === sys.index) {
                const u = nextIt.pos - nm.startUnits;
                const col = nextMe.cols.find(c => c.units === u);
                xEndArc = (col ? col.x + sp * 0.7 : xAtUnits(layout, nextMe, u)) - sp * 0.7;
                endItem = nextIt; endY = yOf(Score.staffStep(nextIt, part));
              } else { xEndArc = me.xEnd - sp * 0.3; }
            }
            const stemUp = (q.dir == null ? q.d < 4 : q.dir === -1);
            const arc = (yFrom, yTo, below) => {
              const x0 = q.x + sp * 0.7, y0 = yFrom + (below ? sp * 0.6 : -sp * 0.6);
              const y1 = yTo + (below ? sp * 0.6 : -sp * 0.6);
              const cy = (y0 + y1) / 2 + (below ? 1 : -1) * Math.min(sp * 1.6, (xEndArc - x0) * 0.25);
              ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, sp * 0.16);
              ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0 + xEndArc) / 2, cy, xEndArc, y1); ctx.stroke();
            };
            if (q.heads) {
              // 和音: タイのある音ごとに弧。上半分の音は上へ、下半分は下へ膨らませる
              const mid = (q.yLo + q.yHi) / 2;
              for (const h of chordTies) {
                const yTo = endItem ? yInItem(endItem, h.cn.note, endY != null ? endY : h.y) : h.y;
                arc(h.y, yTo, h.y >= mid);
              }
              if (it.slurStart) arc(q.y, endY != null ? endY : q.y, stemUp);
            } else {
              const yTo = endItem ? yInItem(endItem, it.note, endY != null ? endY : q.y) : q.y;
              arc(q.y, yTo, stemUp);
            }
          });
          // テンポ記号(先頭パートの上)
          if (pi === 0) {
            for (const q of geo) {
              if (q.it.tempo == null) continue;
              const bpm = Math.round(q.it.tempo * 100) / 100;
              text('♩ = ' + bpm, q.x - sp * 0.7, sys.staffY[0] - 4 * sp - sp * 2.2, Math.round(sp * 1.7), { bold: true, baseline: 'alphabetic' });
            }
          }
        }
      });
    }
    ctx.restore();
  };
})(window);
