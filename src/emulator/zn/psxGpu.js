/*
 * MML.Emu.createPsxGpu({ vramHeight })
 *
 * PlayStation の GPU(ソフトウェア描画)。ZN-1 の基板(znMain.js)のテストモード画面を出すための物。
 * VRAM は横 1024、縦は 512(1MB)か 1024(2MB。業務用基板)。1 画素 15bit+マスク 1bit。
 * 命令(GP0): 塗りつぶし、多角形(単色 / グラデーション / テクスチャ、3 角 / 4 角)、線、矩形(スプライト)、VRAM 内の複写、
 *   CPU からの転送、CPU への読み出し、描画の設定(テクスチャページ、窓、描画範囲、原点、マスク)。
 * 命令(GP1): リセット、表示の入切、DMA の向き、表示の位置と範囲、画面モード、情報の読み出し。
 * 仕様は公開資料(Nocash PSX Specifications)による。ディザは掛けない。
 *
 * 口: gp0(word) / gp1(word) / read() / stat() / vblank() / interlace / render(out) / width / height / stats
 *   render(out): 今の表示範囲を Uint32Array(RGBA、リトルエンディアン)へ書く。大きさは width × height(画面モードで変わる)
 */
(function (root) {
  'use strict';
  const MML = root.MML = root.MML || {}, Emu = MML.Emu = MML.Emu || {};
  const HRES = [256, 320, 512, 640];

  Emu.createPsxGpu = function (opt) {
    opt = opt || {};
    const VH = opt.vramHeight === 512 ? 512 : 1024, YM = VH - 1, XM = 1023;
    const vram = new Uint16Array(1024 * VH);
    const stats = { cmds: new Map(), pixels: 0, unknown: 0 };
    // 描画の設定
    let texPage = 0, texX = 0, texY = 0, semi = 0, depth = 0, drawToDisplay = 0, dither = 0;
    let twMaskX = 0, twMaskY = 0, twOffX = 0, twOffY = 0, rawTw = 0;
    let clipL = 0, clipT = 0, clipR = 0, clipB = 0, rawTL = 0, rawBR = 0, offX = 0, offY = 0, rawOff = 0;
    let setMask = 0, checkMask = 0;
    // 表示の設定
    let dispOff = 1, dmaDir = 0, dispX = 0, dispY = 0, hr1 = 0x200, hr2 = 0xc00, vr1 = 0x10, vr2 = 0x100, mode = 0, irq = 0, info = 0, field = 0;
    // 命令の受け取り
    const buf = new Uint32Array(16); let have = 0, need = 0;
    let loadLeft = 0, loadX = 0, loadY = 0, loadW = 0, loadH = 0, loadPos = 0;
    let readLeft = 0, readX = 0, readY = 0, readW = 0, readPos = 0;
    let poly = 0, polyColor = 0, polyPrev = 0, polyPrevC = 0, polyStage = 0;   // 折れ線の途中

    function resetState() {
      texPage = 0; texX = 0; texY = 0; semi = 0; depth = 0; drawToDisplay = 0; dither = 0;
      twMaskX = twMaskY = twOffX = twOffY = rawTw = 0; clipL = clipT = clipR = clipB = rawTL = rawBR = 0; offX = offY = rawOff = 0; setMask = checkMask = 0;
      dispOff = 1; dmaDir = 0; dispX = dispY = 0; hr1 = 0x200; hr2 = 0xc00; vr1 = 0x10; vr2 = 0x100; mode = 0; irq = 0;
      have = need = 0; loadLeft = 0; readLeft = 0; poly = 0;
    }
    function setTexPage(v) {
      texPage = v & (VH === 1024 ? 0x9ff : 0x1ff);
      texX = (v & 15) * 64; texY = (v >> 4 & 1) * 256 + (VH === 1024 ? (v >> 11 & 1) * 512 : 0);
      semi = v >> 5 & 3; depth = v >> 7 & 3;
    }

    // ── 画素 ──
    // 半透明の 4 通り: 0 = 半分ずつ、1 = 足す、2 = 引く、3 = 1/4 を足す
    function blend(b, f, m) {
      let br = b & 31, bg = b >> 5 & 31, bb = b >> 10 & 31; const fr = f & 31, fg = f >> 5 & 31, fb = f >> 10 & 31;
      if (m === 0) { br = (br + fr) >> 1; bg = (bg + fg) >> 1; bb = (bb + fb) >> 1; }
      else if (m === 1) { br += fr; bg += fg; bb += fb; }
      else if (m === 2) { br -= fr; bg -= fg; bb -= fb; }
      else { br += fr >> 2; bg += fg >> 2; bb += fb >> 2; }
      br = br < 0 ? 0 : br > 31 ? 31 : br; bg = bg < 0 ? 0 : bg > 31 ? 31 : bg; bb = bb < 0 ? 0 : bb > 31 ? 31 : bb;
      return br | bg << 5 | bb << 10;
    }
    function texel(u, v, clutAt) {
      u = (u & 255 & ~(twMaskX << 3)) | ((twOffX & twMaskX) << 3);
      v = (v & 255 & ~(twMaskY << 3)) | ((twOffY & twMaskY) << 3);
      const row = ((texY + v) & YM) * 1024;
      if (depth === 0) { const w = vram[row + ((texX + (u >> 2)) & XM)]; return vram[clutAt + (w >> ((u & 3) * 4) & 15)]; }
      if (depth === 1) { const w = vram[row + ((texX + (u >> 1)) & XM)]; return vram[clutAt + (w >> ((u & 1) * 8) & 255)]; }
      return vram[row + ((texX + u) & XM)];
    }
    // 色(8bit ずつ)を掛けて 15bit に。128 が等倍
    function modulate(t, r, g, b) {
      let tr = (t & 31) * r >> 7, tg = (t >> 5 & 31) * g >> 7, tb = (t >> 10 & 31) * b >> 7;
      if (tr > 31) tr = 31; if (tg > 31) tg = 31; if (tb > 31) tb = 31;
      return tr | tg << 5 | tb << 10 | (t & 0x8000);
    }
    // 画面座標 (x, y) へ 1 画素。c = 15bit+bit15、tr = 半透明の指定、textured = テクスチャつき(bit15 の画素だけ半透明)
    function put(x, y, c, tr, textured) {
      const i = (y & YM) * 1024 + (x & XM), bg = vram[i];
      if (checkMask && (bg & 0x8000)) return;
      if (tr && (!textured || (c & 0x8000))) c = blend(bg, c, semi) | (c & 0x8000);
      vram[i] = c | setMask; stats.pixels++;
    }

    // ── 図形 ──
    const sx = (w) => ((w << 21) >> 21) + offX, sy = (w) => ((w << 21) >> 21) + offY;   // どちらも下位 11bit(符号つき)。y は呼ぶ側で 16bit 右へ寄せて渡す
    function fill(color, xy, wh) {
      const c = (color >> 3 & 31) | (color >> 11 & 31) << 5 | (color >> 19 & 31) << 10;
      const x0 = xy & 0x3f0, y0 = xy >>> 16 & YM, w = ((wh & 0x3ff) + 15) & ~15, h = wh >>> 16 & 0x1ff;
      for (let y = 0; y < h; y++) { const row = ((y0 + y) & YM) * 1024; for (let x = 0; x < w; x++) vram[row + ((x0 + x) & XM)] = c; }
    }
    function rect(x, y, w, h, color, tex, u0, v0, clut, tr, raw) {
      const r = color & 255, g = color >> 8 & 255, b = color >> 16 & 255;
      const flat = (r >> 3) | (g >> 3) << 5 | (b >> 3) << 10;
      const clutAt = tex ? (clut >> 6 & YM) * 1024 + (clut & 63) * 16 : 0;
      let x0 = x, y0 = y, x1 = x + w, y1 = y + h;
      if (x0 < clipL) x0 = clipL; if (y0 < clipT) y0 = clipT; if (x1 > clipR + 1) x1 = clipR + 1; if (y1 > clipB + 1) y1 = clipB + 1;
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        if (!tex) { put(px, py, flat, tr, false); continue; }
        let t = texel(u0 + px - x, v0 + py - y, clutAt);
        if (t === 0) continue;
        if (!raw) t = modulate(t, r, g, b);
        put(px, py, t, tr, true);
      }
    }
    // 3 角形。v = [x, y, r, g, b, u, v] ×3。左上の辺だけ含める(隣の 3 角形と重ならない)
    function tri(a, b, c, tex, clut, tr, raw, shaded) {
      let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (area === 0) return;
      if (area < 0) { const t = b; b = c; c = t; area = -area; }
      let minX = Math.min(a[0], b[0], c[0]), maxX = Math.max(a[0], b[0], c[0]), minY = Math.min(a[1], b[1], c[1]), maxY = Math.max(a[1], b[1], c[1]);
      if (maxX - minX > 1023 || maxY - minY > 511) return;
      if (minX < clipL) minX = clipL; if (minY < clipT) minY = clipT; if (maxX > clipR) maxX = clipR; if (maxY > clipB) maxY = clipB;
      if (minX > maxX || minY > maxY) return;
      const clutAt = tex ? (clut >> 6 & YM) * 1024 + (clut & 63) * 16 : 0;
      // 辺の関数 E(p) = (q.x - p0.x) * dy - (q.y - p0.y) * dx。左上の辺でなければ 1 だけ厳しくする
      const e = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1]; return { dx, dy, bias: (dy < 0 || (dy === 0 && dx > 0)) ? 0 : -1 }; };
      const e0 = e(b, c), e1 = e(c, a), e2 = e(a, b), inv = 1 / area;
      const r0 = a[2], g0 = a[3], b0 = a[4];
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const w0 = (x - b[0]) * e0.dy - (y - b[1]) * e0.dx, w1 = (x - c[0]) * e1.dy - (y - c[1]) * e1.dx, w2 = (x - a[0]) * e2.dy - (y - a[1]) * e2.dx;
        // 向きをそろえたので、内側は 3 つとも 0 以下(符号は辺の向きの取り方による)
        if (-w0 + e0.bias < 0 || -w1 + e1.bias < 0 || -w2 + e2.bias < 0) continue;
        const l0 = -w0 * inv, l1 = -w1 * inv, l2 = -w2 * inv;
        let r = r0, g = g0, bl = b0;
        if (shaded) { r = (a[2] * l0 + b[2] * l1 + c[2] * l2) | 0; g = (a[3] * l0 + b[3] * l1 + c[3] * l2) | 0; bl = (a[4] * l0 + b[4] * l1 + c[4] * l2) | 0; }
        if (!tex) { put(x, y, (r >> 3) | (g >> 3) << 5 | (bl >> 3) << 10, tr, false); continue; }
        let t = texel((a[5] * l0 + b[5] * l1 + c[5] * l2 + 0.5) | 0, (a[6] * l0 + b[6] * l1 + c[6] * l2 + 0.5) | 0, clutAt);
        if (t === 0) continue;
        if (!raw) t = modulate(t, r, g, bl);
        put(x, y, t, tr, true);
      }
    }
    function line(x0, y0, c0, x1, y1, c1, tr) {
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), n = Math.max(dx, dy);
      if (dx > 1023 || dy > 511) return;
      for (let i = 0; i <= n; i++) {
        const t = n ? i / n : 0, x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
        if (x < clipL || x > clipR || y < clipT || y > clipB) continue;
        const r = (c0 & 255) + ((c1 & 255) - (c0 & 255)) * t, g = (c0 >> 8 & 255) + ((c1 >> 8 & 255) - (c0 >> 8 & 255)) * t, b = (c0 >> 16 & 255) + ((c1 >> 16 & 255) - (c0 >> 16 & 255)) * t;
        put(x, y, (r >> 3) | (g >> 3) << 5 | (b >> 3) << 10, tr, false);
      }
    }

    // ── 命令 ──
    function words(cmd) {
      const c = cmd >>> 24;
      if (c >= 0x20 && c < 0x40) { const n = c & 8 ? 4 : 3, tex = c & 4 ? 1 : 0; return c & 0x10 ? n * (2 + tex) : 1 + n * (1 + tex); }
      if (c >= 0x40 && c < 0x60) return c & 0x10 ? 4 : 3;       // 折れ線も最初の 1 本ぶんで受け、続きは別に読む
      if (c >= 0x60 && c < 0x80) return 2 + (c & 4 ? 1 : 0) + ((c >> 3 & 3) === 0 ? 1 : 0);
      if (c >= 0x80 && c < 0xa0) return 4;
      if (c >= 0xa0 && c < 0xe0) return 3;
      if (c === 2) return 3;
      return 1;
    }
    function exec() {
      const cmd = buf[0], c = cmd >>> 24;
      stats.cmds.set(c, (stats.cmds.get(c) || 0) + 1);
      if (c >= 0x20 && c < 0x40) {
        const n = c & 8 ? 4 : 3, tex = !!(c & 4), shaded = !!(c & 0x10), tr = !!(c & 2), raw = !!(c & 1);
        const v = []; let p = 0, clut = 0;
        for (let i = 0; i < n; i++) {
          const col = shaded || i === 0 ? buf[p++] : buf[0], xy = buf[p++];
          let u = 0, tv = 0;
          if (tex) { const t = buf[p++]; u = t & 255; tv = t >> 8 & 255; if (i === 0) clut = t >>> 16; else if (i === 1) setTexPage((texPage & ~0x9ff) | (t >>> 16 & 0x9ff)); }
          v.push([sx(xy), sy(xy >>> 16), col & 255, col >> 8 & 255, col >> 16 & 255, u, tv]);
        }
        tri(v[0], v[1], v[2], tex, clut, tr, raw, shaded);
        if (n === 4) tri(v[1], v[2], v[3], tex, clut, tr, raw, shaded);
      } else if (c >= 0x40 && c < 0x60) {
        const shaded = !!(c & 0x10), tr = !!(c & 2);
        const c0 = buf[0] & 0xffffff, p0 = buf[1], c1 = shaded ? buf[2] & 0xffffff : c0, p1 = shaded ? buf[3] : buf[2];
        line(sx(p0), sy(p0 >>> 16), c0, sx(p1), sy(p1 >>> 16), c1, tr);
        if (c & 8) { poly = shaded ? 2 : 1; polyColor = cmd; polyPrev = p1; polyPrevC = c1; polyStage = 0; }
      } else if (c >= 0x60 && c < 0x80) {
        const tex = !!(c & 4), size = c >> 3 & 3, tr = !!(c & 2), raw = !!(c & 1);
        let p = 1; const xy = buf[p++]; let u = 0, v = 0, clut = 0, w, h;
        if (tex) { const t = buf[p++]; u = t & 255; v = t >> 8 & 255; clut = t >>> 16; }
        if (size === 0) { const wh = buf[p++]; w = wh & 0x3ff; h = wh >>> 16 & 0x1ff; } else w = h = size === 1 ? 1 : size === 2 ? 8 : 16;
        rect(sx(xy), sy(xy >>> 16), w, h, cmd & 0xffffff, tex, u, v, clut, tr, raw);
      } else if (c >= 0x80 && c < 0xa0) {
        const sX = buf[1] & XM, sY = buf[1] >>> 16 & YM, dX = buf[2] & XM, dY = buf[2] >>> 16 & YM;
        const w = ((buf[3] - 1) & XM) + 1, h = ((buf[3] >>> 16) - 1 & 0x1ff) + 1;
        const tmp = new Uint16Array(w);
        for (let y = 0; y < h; y++) {
          const sr = ((sY + y) & YM) * 1024, dr = ((dY + y) & YM) * 1024;
          for (let x = 0; x < w; x++) tmp[x] = vram[sr + ((sX + x) & XM)];
          for (let x = 0; x < w; x++) { const i = dr + ((dX + x) & XM); if (checkMask && (vram[i] & 0x8000)) continue; vram[i] = tmp[x] | setMask; }
        }
      } else if (c >= 0xa0 && c < 0xc0) {
        loadX = buf[1] & XM; loadY = buf[1] >>> 16 & YM; loadW = ((buf[2] - 1) & XM) + 1; loadH = ((buf[2] >>> 16) - 1 & 0x1ff) + 1;
        loadLeft = loadW * loadH; loadPos = 0;
      } else if (c >= 0xc0 && c < 0xe0) {
        readX = buf[1] & XM; readY = buf[1] >>> 16 & YM; readW = ((buf[2] - 1) & XM) + 1;
        readLeft = readW * (((buf[2] >>> 16) - 1 & 0x1ff) + 1); readPos = 0;
      } else switch (c) {
        case 0x00: case 0x01: break;
        case 0x02: fill(cmd, buf[1], buf[2]); break;
        case 0x1f: irq = 1; if (opt.onIrq) opt.onIrq(); break;
        case 0xe1: setTexPage(cmd); dither = cmd >> 9 & 1; drawToDisplay = cmd >> 10 & 1; break;
        case 0xe2: rawTw = cmd & 0xfffff; twMaskX = cmd & 31; twMaskY = cmd >> 5 & 31; twOffX = cmd >> 10 & 31; twOffY = cmd >> 15 & 31; break;
        case 0xe3: rawTL = cmd & 0xfffff; clipL = cmd & 0x3ff; clipT = cmd >> 10 & YM; break;
        case 0xe4: rawBR = cmd & 0xfffff; clipR = cmd & 0x3ff; clipB = cmd >> 10 & YM; break;
        case 0xe5: rawOff = cmd & 0x3fffff; offX = (cmd << 21) >> 21; offY = (cmd << 10) >> 21; break;
        case 0xe6: setMask = cmd & 1 ? 0x8000 : 0; checkMask = cmd >> 1 & 1; break;
        default: stats.unknown++; break;
      }
    }
    function gp0(w) {
      w >>>= 0;
      if (loadLeft > 0) {                                  // CPU からの転送の途中: 1 語に 2 画素
        for (let k = 0; k < 2 && loadLeft > 0; k++) {
          const x = loadPos % loadW, y = (loadPos / loadW) | 0, i = ((loadY + y) & YM) * 1024 + ((loadX + x) & XM);
          if (!(checkMask && (vram[i] & 0x8000))) vram[i] = (w >>> (k * 16) & 0xffff) | setMask;
          loadPos++; loadLeft--;
        }
        return;
      }
      if (poly) {                                          // 折れ線の続き。終わりの印は 0x5xxx5xxx
        if (polyStage === 0 && (w & 0xf000f000) === 0x50005000) { poly = 0; return; }
        if (poly === 2 && polyStage === 0) { polyColor = w; polyStage = 1; return; }
        const c1 = poly === 2 ? polyColor & 0xffffff : polyPrevC;
        line(sx(polyPrev), sy(polyPrev >>> 16), polyPrevC, sx(w), sy(w >>> 16), c1, !!(polyColor >>> 24 & 2));
        polyPrev = w; polyPrevC = c1; polyStage = 0;
        return;
      }
      if (have === 0) need = words(w);
      buf[have++] = w;
      if (have >= need) { have = 0; exec(); }
    }
    function gp1(w) {
      w >>>= 0;
      switch (w >>> 24 & 0x3f) {
        case 0x00: resetState(); break;
        case 0x01: have = 0; loadLeft = 0; readLeft = 0; poly = 0; break;
        case 0x02: irq = 0; break;
        case 0x03: dispOff = w & 1; break;
        case 0x04: dmaDir = w & 3; break;
        case 0x05: dispX = w & 0x3ff; dispY = w >> 10 & YM; break;
        case 0x06: hr1 = w & 0xfff; hr2 = w >> 12 & 0xfff; break;
        case 0x07: vr1 = w & 0x3ff; vr2 = w >> 10 & 0x3ff; break;
        case 0x08: mode = w & 0xff; break;
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16: case 0x17:
        case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f:
          switch (w & 7) { case 2: info = rawTw; break; case 3: info = rawTL; break; case 4: info = rawBR; break; case 5: info = rawOff; break; case 7: info = 2; break; default: break; }
          break;
        default: break;
      }
    }
    function read() {
      if (readLeft > 0) {
        let v = 0;
        for (let k = 0; k < 2 && readLeft > 0; k++) {
          const x = readPos % readW, y = (readPos / readW) | 0;
          v |= vram[((readY + y) & YM) * 1024 + ((readX + x) & XM)] << (k * 16);
          readPos++; readLeft--;
        }
        return v >>> 0;
      }
      return info >>> 0;
    }
    function stat() {
      // bit26 命令を受け取れる、bit27 読み出しの用意あり、bit28 DMA を受け取れる。bit25 は DMA の向きに応じた要求。bit31(奇偶)は基板側で足す
      let s = (texPage & 0x7ff) | (setMask ? 1 << 11 : 0) | checkMask << 12 | dither << 9 | drawToDisplay << 10 | (texPage & 0x800 ? 1 << 15 : 0);
      s |= (mode & 0x3f) << 17 | (mode & 0x40) << 10 | dispOff << 23 | irq << 24 | 0x1C000000 | dmaDir << 29;
      if (dmaDir === 1 || dmaDir === 2 || dmaDir === 3) s |= 1 << 25;
      return s | 0;
    }

    // ── 表示 ──
    const width = () => mode & 0x40 ? 368 : HRES[mode & 3];
    const height = () => (mode & 0x24) === 0x24 ? 480 : 240;
    const C5 = new Uint8Array(32); for (let i = 0; i < 32; i++) C5[i] = i << 3 | i >> 2;
    function render(out) {
      const w = width(), h = height();
      if (dispOff) { out.fill(0xff000000, 0, w * h); return; }
      for (let y = 0; y < h; y++) {
        const row = ((dispY + y) & YM) * 1024, o = y * w;
        for (let x = 0; x < w; x++) { const c = vram[row + ((dispX + x) & XM)]; out[o + x] = 0xff000000 | C5[c >> 10 & 31] << 16 | C5[c >> 5 & 31] << 8 | C5[c & 31]; }
      }
    }
    resetState();
    return { gp0, gp1, read, stat, render, vram, stats, vblank() { field ^= 1; },
      get interlace() { return (mode & 0x24) === 0x24; }, get width() { return width(); }, get height() { return height(); },
      get display() { return { x: dispX, y: dispY, hr1, hr2, vr1, vr2, mode, off: dispOff }; } };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
