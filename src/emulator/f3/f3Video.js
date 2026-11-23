/*
 * MML.Emu.createF3Video(main, opt) — タイトー F3 の画面(TC0630FDP): 背景 4 面、文字の面 / ピクセルの面、スプライト、ライン RAM による合成。
 *
 * MAME taito/taito_f3_v.cpp(Copyright Bryan McPhail, ywy, 12Me21。BSD-3-Clause)の移植。走査線ごとに「ライン RAM」の設定を読み、
 * 9 枚(文字 / ピクセル 1、スプライトの優先度の組 4、背景 4)を優先度の順に混ぜる。半透明は「手前の色 × 係数 + 奥の色 × 係数」。
 *   RAM(main.vram = 0x600000 から): スプライト 0x00000 / 背景 0x10000 / 文字の面 0x1C000 / 文字の絵 0x1E000 / ライン RAM 0x20000 / ピクセルの面の絵 0x30000
 *   背景    : 1 枚 16 × 16 画素、4 / 5 / 6bpp。1 文字 = 属性の語 [yx.. ddac cccc cccc] と番号の語。面は 512 × 512 が 8 枚、または 1024 × 512 が 4 枚(extend)
 *   文字の面: 64 × 64 文字、1 文字 16bit [y ccccccc x tttttttt]。絵は RAM(8 × 8、4bpp)
 *   ピクセルの面: 512 × 256。絵は RAM の 2048 文字を縦に並べた物。色と反転は文字の面の同じ位置から
 *   スプライト: 16 × 16、拡大縮小つき。並び(1 件 8 語)を読んで別の面に描いておき、走査線の合成で使う。ゲームによって 0〜2 フレーム遅れて出る(lag)
 *   上下左右の反転: スプライトの並びの中の命令で切り替わる。絵を逆さに持っていて、これで正しい向きにするゲームがある
 *   色      : パレット 0x440000 から 1 色 32bit(00RRGGBB。初期のゲームは 12bit)
 * 絵の ROM(opt.gfx)が無い時は、背景とスプライトは出ない(文字の面とピクセルの面だけ)。
 *
 * opt: { top(見える範囲の最初の走査線。既定 24), height(既定 232), pal12, extend(背景が横 1024), lag(スプライトの遅れ 0〜2),
 *        gfx: { spr, sprHi, tile, tileHi }(Uint8Array。MAME の領域と同じ並び。Hi は無ければ null)}
 * 口: width / height / render(Uint32Array width × height。ABGR = キャンバスの ImageData の並び)/ busy(背景かスプライトを描いたか。重さの目安)
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const H_START = 46, WIDTH = 320, H_TOTAL = 432, FBW = 512;
  // 文字の絵の画素 x(0〜7)→ [行の中のバイト, 上位ニブルか]
  const NIB_BYTE = [3, 3, 2, 2, 1, 1, 0, 0], NIB_HI = [0, 1, 0, 1, 0, 1, 0, 1];
  const s16 = (v) => v << 16 >> 16;

  Emu.createF3Video = function (main, opt) {
    opt = opt || {};
    const top = opt.top === undefined ? 24 : opt.top, height = opt.height || 232;
    const vram = main.vram, pal = main.pal, ctrl = main.ctrl;
    const extend = !!opt.extend, lag = opt.lag === undefined ? 1 : opt.lag, widthMask = extend ? 0x3ff : 0x1ff;
    const gfx = opt.gfx || null;
    const spr = gfx ? gfx.spr : null, sprHi = gfx ? gfx.sprHi : null, tile = gfx ? gfx.tile : null, tileHi = gfx ? gfx.tileHi : null;
    const nSpr = spr ? Math.floor(spr.length / 128) : 0, nTile = tile ? Math.floor(tile.length / 128) : 0;
    const PF = 0x10000, TEXT = 0x1c000, CHAR = 0x1e000, LINE = 0x20000, PIVOT = 0x30000;
    const w16 = (o) => vram[o] << 8 | vram[o + 1];
    const lineWord = (i) => vram[LINE + i * 2] << 8 | vram[LINE + i * 2 + 1];
    const clut = new Uint32Array(0x2000);

    // ── スプライト(別の面に描いておく)──
    const fb = new Uint16Array(FBW * 256);
    const MAXS = 0x400;
    const sCode = new Int32Array(MAXS), sColor = new Uint8Array(MAXS), sFlipX = new Uint8Array(MAXS), sFlipY = new Uint8Array(MAXS);
    const sX = new Int32Array(MAXS), sY = new Int32Array(MAXS), sScaleX = new Int32Array(MAXS), sScaleY = new Int32Array(MAXS);
    let sCount = 0, flipscreen = false, spriteBank = 0, spriteTrails = false, spritePenMask = 0x0f, spritesDrawn = 0;
    const minX = H_START, maxX = H_START + WIDTH - 1, minY = top, maxY = top + height - 1;

    function getSpriteInfo() {
      // 軸ごとの状態(x, y): ブロックの倍率、位置、ブロックの位置、全体 / 部分のスクロール
      const ax = [{ bs: 256, pos: 0, bp: 0, g: 0, sg: 0 }, { bs: 256, pos: 0, bp: 0, g: 0, sg: 0 }];
      const upd = (a, scroll, posw, multi, blockCtrl, zoom) => {
        let np = (posw << 20) >> 20;
        if (scroll & 1) a.sg = np;
        if (scroll & 2) a.g = np;
        if (!(scroll & 8)) { np += a.g; if (!(scroll & 4)) np += a.sg; }
        np = s16(np);
        if (blockCtrl === 0) { if (!multi) { a.bp = np << 8; a.bs = 0x100 - zoom; } a.pos = a.bp; }
        else if (blockCtrl === 2) a.pos = a.bp;
        else if (blockCtrl === 3) a.pos += a.bs * 16;
      };
      let color = 0, multi = false, n = 0, total = 0;
      for (let offs = 0; offs < 0x400 && total < 0x400; offs++) {
        total++;
        const o = (spriteBank ? 0x8000 : 0) + offs * 16;
        const w0 = w16(o), w1 = w16(o + 2), w2 = w16(o + 4), w3 = w16(o + 6), w4 = w16(o + 8), w5 = w16(o + 10), w6 = w16(o + 12);
        if (w3 & 0x8000) {     // 命令: 反転、色の深さ、残像、並びの切り替え
          flipscreen = !!(w5 & 0x2000);
          spritePenMask = ((w5 >> 8 & 3) << 4) | 0x0f;
          spriteTrails = !!(w5 & 2);
          spriteBank = w5 & 1;
        }
        if (w6 & 0x8000) { const to = w6 & 0x3ff; if (to === offs) break; offs = to - 1; }   // ジャンプ(命令の後で見る)
        const cont = w4 >> 8;
        if (!(cont & 4)) color = w4 & 0xff;
        const scroll = w2 >> 12;
        upd(ax[0], scroll, w2 & 0xfff, multi, cont >> 6 & 3, w1 & 0xff);
        upd(ax[1], scroll, w3 & 0xfff, multi, cont >> 4 & 3, w1 >> 8);
        multi = !!(cont & 8);
        const code = w0 | (w5 & 1) << 16;
        if (!code) continue;
        const x = ax[0], y = ax[1];
        const tx = flipscreen ? (512 << 8) - x.bs * 16 - x.pos : x.pos, ty = flipscreen ? (256 << 8) - y.bs * 16 - y.pos : y.pos;
        if (tx + x.bs * 16 <= minX << 8 || tx > maxX << 8 || ty + y.bs * 16 <= minY << 8 || ty > maxY << 8) continue;
        sX[n] = tx; sY[n] = ty; sCode[n] = code; sColor[n] = color; sScaleX[n] = x.bs; sScaleY[n] = y.bs;
        sFlipX[n] = (cont & 1 ? 1 : 0) ^ (flipscreen ? 1 : 0); sFlipY[n] = (cont & 2 ? 1 : 0) ^ (flipscreen ? 1 : 0);
        n++;
      }
      sCount = n;
    }
    function drawSprites() {
      if (!spriteTrails) fb.fill(0);
      spritesDrawn = 0;
      if (!spr) return;
      const mask = spritePenMask, round = flipscreen ? 0 : 255;
      for (let i = sCount - 1; i >= 0; i--) {
        const base = (sCode[i] % nSpr) * 128, hiBase = (sCode[i] % nSpr) * 64, fx = sFlipX[i] ? 15 : 0, fy = sFlipY[i] ? 15 : 0;
        const pen0 = 0x1000 + (sColor[i] << 4), scx = sScaleX[i], scy = sScaleY[i];
        let dy8 = sY[i] + round;
        for (let y = 0; y < 16; y++) {
          const dy = dy8 >> 8; dy8 += scy;
          if (dy < minY || dy > maxY) continue;
          const row = dy * FBW, sy = y ^ fy, src = base + sy * 8, srcHi = hiBase + sy * 4;
          let dx8 = sX[i] + 128;
          for (let x = 0; x < 16; x++) {
            const dx = dx8 >> 8; dx8 += scx;
            if (dx < minX || dx > maxX) continue;
            if (dx === dx8 >> 8) continue;
            const sx = x ^ fx, b = spr[src + (sx >> 1)];
            let c = sx & 1 ? b >> 4 : b & 15;
            if (mask > 15 && sprHi) c |= ((sprHi[srcHi + (sx >> 2)] >> ((sx & 3) * 2)) & 3) << 4;
            c &= mask;
            if (c && !fb[row + dx]) { fb[row + dx] = pen0 | c; spritesDrawn++; }
          }
        }
      }
    }

    // ── 走査線ごとの設定(ライン RAM から読んで、次の行へ持ち越す)──
    const mkMix = (kind, index) => ({ kind, index, mix: 0, prio: 0, blendMode: 0, xSampleEn: false, blendSelV: false,
      colscroll: 0, alt: false, xScale: 0x80, yScale: 0, palAdd: 0, rowscroll: 0, regSx: 0, regSy: 0, regFxY: 0, regFxX: 0, control: 0 });
    const pivot = mkMix(0, 0), sp = [0, 1, 2, 3].map((i) => mkMix(1, i)), pf = [0, 1, 2, 3].map((i) => mkMix(2, i));
    const BASE_ORDER = [pivot, sp[0], pf[0], sp[3], pf[3], sp[2], pf[2], sp[1], pf[1]], order = BASE_ORDER.slice();
    const clipL = new Int16Array(4), clipR = new Int16Array(4), blend = new Uint8Array(4);
    let xSample = 16, bgPalette = 0;
    const setMix = (m, v) => { m.mix = v; m.prio = v & 15; m.blendMode = v >> 14 & 3; };

    function readLineRam(y) {
      const latched = (section, sub) => {
        const l = lineWord(section * 0x100 + y), base = 0x4000 + 0x1000 * section + 0x200 * sub;
        if (l >> (sub + 4) & 1) return (base + 0x800) / 2 + y;
        if (l >> sub & 1) return base / 2 + y;
        return 0;
      };
      let w;
      for (let i = 2; i < 4; i++) if ((w = latched(0, i))) {
        const c = lineWord(w), k = 2 * (i - 2);
        pf[i].colscroll = c & 0x1ff; pf[i].alt = !extend && !!(c & 0x200);
        clipL[k] = (clipL[k] & 0xff) | (c >> 12 & 1) << 8; clipR[k] = (clipR[k] & 0xff) | (c >> 13 & 1) << 8;
        clipL[k + 1] = (clipL[k + 1] & 0xff) | (c >> 14 & 1) << 8; clipR[k + 1] = (clipR[k + 1] & 0xff) | (c >> 15 & 1) << 8;
      }
      for (let i = 0; i < 4; i++) if ((w = latched(1, i))) { const c = lineWord(w); clipL[i] = (clipL[i] & 0x100) | (c & 0xff); clipR[i] = (clipR[i] & 0x100) | (c >> 8); }
      if ((w = latched(2, 0))) {
        const c = lineWord(w);
        pivot.blendSelV = !!(c & 0x200); pivot.control = c >> 8;
        for (let g = 0; g < 4; g++) { const b = c >> (g * 2) & 3; sp[g].mix = (sp[g].mix & 0x3fff) | b << 14; sp[g].blendMode = b; }
      }
      if ((w = latched(2, 1))) { const c = lineWord(w); for (let i = 0; i < 4; i++) blend[i] = Math.min(8, 15 - (c >> (4 * i) & 15)); }
      if ((w = latched(2, 2))) {
        const c = lineWord(w);
        xSample = 16 - (c >> 4 & 15);
        for (let i = 0; i < 4; i++) { pf[i].xSampleEn = !!(c >> i & 1); sp[i].xSampleEn = !!(c & 0x100); }
        pivot.xSampleEn = !!(c & 0x200);
      }
      if ((w = latched(2, 3))) bgPalette = lineWord(w);
      if ((w = latched(3, 1))) setMix(pivot, lineWord(w));
      if ((w = latched(3, 2))) { const c = lineWord(w); for (let g = 0; g < 4; g++) { setMix(sp[g], (sp[g].mix & 0xc00f) | (c & 0x3ff) << 4); sp[g].blendSelV = !!(c >> (12 + g) & 1); } }
      if ((w = latched(3, 3))) { const c = lineWord(w); for (let g = 0; g < 4; g++) { const p = c >> (g * 4) & 15; sp[g].mix = (sp[g].mix & 0xfff0) | p; sp[g].prio = p; } }
      const FIX_Y = [0, 3, 2, 1];
      for (let i = 0; i < 4; i++) if ((w = latched(4, i))) { const c = lineWord(w); pf[i].xScale = 256 - (c >> 8); pf[FIX_Y[i]].yScale = (c & 0xff) << 1; }
      for (let i = 0; i < 4; i++) if ((w = latched(5, i))) pf[i].palAdd = (lineWord(w) * 16) & 0xffff;
      for (let i = 0; i < 4; i++) if ((w = latched(6, i))) { const r = lineWord(w) << 2; pf[i].rowscroll = (r & 0xffffff00) - (r & 0xff); }
      for (let i = 0; i < 4; i++) if ((w = latched(7, i))) setMix(pf[i], lineWord(w));
    }
    function pfScroll(n, m) {
      let sx = s16(ctrl[n * 2] << 8 | ctrl[n * 2 + 1]), sy = s16(ctrl[8 + n * 2] << 8 | ctrl[8 + n * 2 + 1]);
      sy = s16(sy + 128);
      if (flipscreen) { sx = s16(sx + (320 << 6)); sx = s16(sx + ((512 + 192) << 6)); sy = s16(-sy); }
      sx = s16(sx + ((40 - 4 * n) << 6));
      let fx = sx << 2, fy = sy << 1;
      fx ^= 0xfc;
      fx -= H_START << 8;
      if (flipscreen) fy = -fy;
      m.regSx = fx; m.regSy = fy;
    }
    // 見える範囲(クリップ面 4 つの組み合わせ)。MAME の calc_clip と同じ手順
    function calcClip(m) {
      const en = m.mix >> 8 & 15, inv = m.mix >> 4 & 15;
      let normal = en & ~inv, invert = en & inv;
      if (!(m.mix & 0x1000)) { const t = normal; normal = invert; invert = t; }
      let ranges = [[H_START, H_START + WIDTH]];
      for (let p = 0; p < 4; p++) {
        const cl = clipL[p] - 1, cr = clipR[p] - 2;
        if (normal >> p & 1) {
          const out = [];
          for (const r of ranges) { if (cl > cr || r[1] < cl || r[0] > cr) continue; out.push([Math.max(r[0], cl), Math.min(r[1], cr)]); }
          ranges = out;
        } else if ((invert >> p & 1) && cl <= cr) {
          const nr = [];
          for (let i = 0; i < ranges.length; i++) nr.push([H_START, cl]);
          for (let i = 0; i < ranges.length; i++) nr.push([cr, H_START + WIDTH]);
          const out = [];
          for (const it of nr) {
            let keep = true;
            for (const r of ranges) { it[0] = Math.max(r[0], it[0]); it[1] = Math.max(r[0], it[1]); if (it[0] >= it[1]) { keep = false; break; } }
            if (keep) out.push(it);
          }
          ranges = out;
        }
      }
      return ranges;
    }

    // ── 1 枚の 1 行を、色の番号(0xFFFF = 何も無い)と係数の選択に直す ──
    const colBuf = new Uint16Array(H_TOTAL + 8), selBuf = new Uint8Array(H_TOTAL + 8);
    const NONE = 0xffff;
    function mosaicX(x) { let c = x - 46 + 114; if (c >= 432) c -= 432; return x - (c % xSample); }
    function fetchPlayfield(m, l, r) {
      const y = ((m.regFxY >> 8) + m.colscroll) & 0x1ff, yy = flipscreen ? 511 - y : y;
      let tmap = m.index; if (!extend && m.alt) tmap += 2;
      const cols = extend ? 64 : 32, base = PF + tmap * (extend ? 0x2000 : 0x1000) + (yy >> 4) * cols * 4, py0 = yy & 15, W1 = widthMask;
      const fxX = m.regFxX, xs = m.xScale, palAdd = m.palAdd, mos = m.xSampleEn;
      let lastCol = -1, palBase = 0, sel = 0, penMask = 15, rowAddr = 0, rowHi = 0, flipX = 0;
      for (let x = l; x < r; x++) {
        const rx = mos ? mosaicX(x) : x;
        let gx = (((fxX + (rx - H_START) * xs) >> 8) + H_START) & W1;
        if (flipscreen) gx = W1 - gx;
        const col = gx >> 4;
        if (col !== lastCol) {
          lastCol = col;
          const o = base + col * 4, attr = vram[o] << 8 | vram[o + 1], code = (vram[o + 2] << 8 | vram[o + 3]) % nTile;
          const pc = attr & 0x1ff, extra = attr >> 10 & 3;
          palBase = pc << 4; sel = attr >> 9 & 1; penMask = ((extra & ~pc) << 4) | 15; flipX = attr & 0x4000 ? 15 : 0;
          const py = attr & 0x8000 ? 15 - py0 : py0;
          rowAddr = code * 128 + py * 8; rowHi = code * 64 + py * 4;
        }
        const px = (gx & 15) ^ flipX, b = tile[rowAddr + (px >> 1)];
        let p = px & 1 ? b >> 4 : b & 15;
        if (penMask > 15 && tileHi) { const k = rowHi + (px >> 3) * 2, bit = px & 7; p |= (tileHi[k] >> bit & 1) << 4 | (tileHi[k + 1] >> bit & 1) << 5; }
        p &= penMask;
        if (p) { colBuf[x] = (palBase + p + palAdd) & 0x1fff; selBuf[x] = sel; } else colBuf[x] = NONE;
      }
    }
    function fetchText(m, l, r, lineY) {
      const y = (m.regSy + lineY) & 0x1ff, ty = flipscreen ? 511 - y : y, row = ty >> 3, py0 = ty & 7, mos = m.xSampleEn, sel = m.blendSelV ? 1 : 0;
      for (let x = l; x < r; x++) {
        const rx = mos ? mosaicX(x) : x;
        let tx = (rx + m.regSx) & 0x1ff; if (flipscreen) tx = 511 - tx;
        const o = TEXT + (row * 64 + (tx >> 3)) * 2, hi = vram[o], t = vram[o + 1];
        let px = tx & 7, py = py0;
        if (hi & 0x01) px = 7 - px;
        if (hi & 0x80) py = 7 - py;
        const b = vram[CHAR + t * 32 + py * 4 + NIB_BYTE[px]], p = NIB_HI[px] ? b >> 4 : b & 15;
        if (p) { colBuf[x] = ((hi >> 1 & 0x3f) << 4) | p; selBuf[x] = sel; } else colBuf[x] = NONE;
      }
    }
    function fetchPixel(m, l, r, lineY) {
      const y = (m.regSy + lineY) & 0xff, ty = flipscreen ? 255 - y : y, row = ty >> 3, py0 = ty & 7, mos = m.xSampleEn, sel = m.blendSelV ? 1 : 0;
      // 色と反転は文字の面から。面を下へ送ると、文字の面の下半分の色を使う
      const c5 = ctrl[0x1a] << 8 | ctrl[0x1b];
      let yo = row * 8 + c5; if (flipscreen) yo += 0x100;
      const arow = (yo & 0x1ff) >= 256 ? row + 32 : row;
      for (let x = l; x < r; x++) {
        const rx = mos ? mosaicX(x) : x;
        let tx = (rx + m.regSx) & 0x1ff; if (flipscreen) tx = 511 - tx;
        const col = tx >> 3, hi = vram[TEXT + (arow * 64 + col) * 2];
        let px = tx & 7, py = py0;
        if (hi & 0x01) px = 7 - px;
        if (hi & 0x80) py = 7 - py;
        const b = vram[PIVOT + (col * 32 + row) * 32 + py * 4 + NIB_BYTE[px]], p = NIB_HI[px] ? b >> 4 : b & 15;
        if (p) { colBuf[x] = ((hi >> 1 & 0x3f) << 4) | p; selBuf[x] = sel; } else colBuf[x] = NONE;
      }
    }
    function fetchSprite(m, l, r, lineY) {
      const row = (lineY & 0xff) * FBW, g = m.index, mos = m.xSampleEn, sel = m.blendSelV ? 1 : 0;
      for (let x = l; x < r; x++) {
        const c = fb[row + (mos ? mosaicX(x) : x)];
        if (c && (c >> 10 & 3) === g) { colBuf[x] = c; selBuf[x] = sel; } else colBuf[x] = NONE;
      }
    }

    // ── 合成(1 行ぶんの控え)──
    const srcPal = new Uint16Array(H_TOTAL), dstPal = new Uint16Array(H_TOTAL), srcBlend = new Uint8Array(H_TOTAL), dstBlend = new Uint8Array(H_TOTAL);
    const srcPrio = new Uint8Array(H_TOTAL), dstPrio = new Uint8Array(H_TOTAL), srcMode = new Uint8Array(H_TOTAL);
    function mixLine(m, l, r) {
      const prio = m.prio, mode = m.blendMode;
      for (let x = l; x < r; x++) {
        if (mode === srcMode[x]) continue;            // 同じ混ぜ方の面どうしは重ならない
        const color = colBuf[x];
        if (color === NONE) continue;
        const sel = selBuf[x];
        if (prio > srcPrio[x]) {
          if (mode === 1) { const b = blend[2 + sel]; if (b === 0) continue; srcBlend[x] = b; }
          else if (mode === 2) { const b = blend[sel]; if (b === 0) continue; srcBlend[x] = b; }
          else {
            if (blend[sel] + blend[2 + sel] === 0) continue;
            srcBlend[x] = blend[2 + sel]; dstBlend[x] = blend[sel]; dstPrio[x] = prio; dstPal[x] = color;
          }
          srcPal[x] = color; srcMode[x] = mode; srcPrio[x] = prio;
        } else if (prio >= dstPrio[x]) {
          dstPal[x] = prio !== dstPrio[x] ? color : 0;   // 優先度が同じ = 色の線がぶつかる(実機の癖)
          dstPrio[x] = prio;
          dstBlend[x] = srcMode[x] === 1 ? blend[sel] : blend[2 + sel];
        }
      }
    }
    let busy = false;
    function scanlineDraw(out) {
      // パレット
      if (opt.pal12) for (let i = 0, o = 0; i < 0x2000; i++, o += 4) clut[i] = (0xff000000 | (pal[o + 3] >> 4) << 20 | (pal[o + 2] & 15) << 12 | (pal[o + 2] >> 4) << 4) >>> 0;
      else for (let i = 0, o = 0; i < 0x2000; i++, o += 4) clut[i] = (0xff000000 | pal[o + 3] << 16 | pal[o + 2] << 8 | pal[o + 1]) >>> 0;
      // 行をまたいで持つ設定を初期値へ
      for (const m of BASE_ORDER) { m.mix = 0; m.prio = 0; m.blendMode = 0; m.xSampleEn = false; m.blendSelV = false; m.colscroll = 0; m.alt = false; m.xScale = 0x80; m.yScale = 0; m.palAdd = 0; m.rowscroll = 0; m.control = 0; }
      clipL.fill(0); clipR.fill(0); blend.fill(0); xSample = 16; bgPalette = 0;
      for (let i = 0; i < 4; i++) { pfScroll(i, pf[i]); pf[i].regFxY = pf[i].regSy; }
      const c4 = ctrl[0x18] << 8 | ctrl[0x19], c5 = ctrl[0x1a] << 8 | ctrl[0x1b];
      if (flipscreen) { pivot.regSx = (c4 - 12) & 0xffff; pivot.regSy = c5; } else { pivot.regSx = (-c4 - 5) & 0xffff; pivot.regSy = (-c5) & 0xffff; }
      busy = false;
      const L0 = H_START, R0 = H_START + WIDTH;
      for (let sy = 0; sy < 256; sy++) {
        readLineRam(flipscreen ? 255 - sy : sy);
        if (sy >= top && sy < top + height) {
          for (let i = 0; i < 4; i++) { const m = pf[i]; m.regFxX = m.regSx + m.rowscroll + 10 * (m.xScale - 256); }
          for (let x = L0; x < R0; x++) { srcPal[x] = 0; dstPal[x] = bgPalette; srcBlend[x] = 0; dstBlend[x] = 8; srcPrio[x] = 0; dstPrio[x] = 0; srcMode[x] = 0xff; }
          // 優先度の高い順(同じなら元の並び)
          for (let i = 0; i < 9; i++) order[i] = BASE_ORDER[i];
          for (let i = 1; i < 9; i++) { const m = order[i]; let j = i - 1; while (j >= 0 && order[j].prio < m.prio) { order[j + 1] = order[j]; j--; } order[j + 1] = m; }
          for (let i = 0; i < 9; i++) {
            const m = order[i];
            if (!(m.mix & 0x2000)) continue;
            if (m.kind === 1 ? m.blendMode === 0 : m.blendMode === 3) continue;
            if (m.kind === 2 && !tile) continue;
            if (m.kind === 1 && !spritesDrawn) continue;
            const ranges = (m.mix & 0x0f00) ? calcClip(m) : null;
            const n = ranges ? ranges.length : 1;
            for (let k = 0; k < n; k++) {
              const l = ranges ? Math.max(L0, ranges[k][0]) : L0, r = ranges ? Math.min(R0, ranges[k][1]) : R0;
              if (l >= r) continue;
              if (m.kind === 2) { fetchPlayfield(m, l, r); busy = true; }
              else if (m.kind === 1) { fetchSprite(m, l, r, sy); busy = true; }
              else if (m.control & 0xa0) fetchPixel(m, l, r, sy);
              else fetchText(m, l, r, sy);
              mixLine(m, l, r);
            }
          }
          const o = (sy - top) * WIDTH - L0;
          for (let x = L0; x < R0; x++) {
            const sb = srcBlend[x], db = dstBlend[x];
            if (sb === 0 && db === 8) { out[o + x] = clut[dstPal[x] & 0x1fff]; continue; }
            const s = clut[srcPal[x] & 0x1fff], d = clut[dstPal[x] & 0x1fff];
            let rr = ((s & 0xff) * sb + (d & 0xff) * db) >> 3, gg = ((s >> 8 & 0xff) * sb + (d >> 8 & 0xff) * db) >> 3, bb = ((s >> 16 & 0xff) * sb + (d >> 16 & 0xff) * db) >> 3;
            if (rr > 255) rr = 255; if (gg > 255) gg = 255; if (bb > 255) bb = 255;
            out[o + x] = (0xff000000 | bb << 16 | gg << 8 | rr) >>> 0;
          }
        }
        if (sy !== 0) for (let i = 0; i < 4; i++) pf[i].regFxY += pf[i].yScale;
      }
    }
    function render(out) {
      if (lag === 0) { getSpriteInfo(); drawSprites(); scanlineDraw(out); }
      else if (lag === 1) { scanlineDraw(out); getSpriteInfo(); drawSprites(); }
      else { scanlineDraw(out); drawSprites(); getSpriteInfo(); }
    }
    return { width: WIDTH, height, render, get busy() { return busy; }, get flipscreen() { return flipscreen; } };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
