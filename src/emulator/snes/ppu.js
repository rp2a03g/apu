/*
 * スーパーファミコンの PPU(段階 8g-2/8g-3 の範囲)
 * MML.Emu.SnesPpu
 *
 * スーパーゲームボーイの枠と GB 画面の表示、公開テスト ROM の結果表示に要る範囲:
 *   - レジスタ $2100-$213F(VRAM/CGRAM/OAM の読み書き、スクロール、BG の設定、表示の有効、明るさ)
 *   - 描画は行単位。BG モード 0(2bpp×4)、1(4bpp×2+2bpp)、3(8bpp+4bpp)。タイル 8×8/16×16、マップ 32/64、反転、優先
 *   - スプライト(1 行 32 個まで、大きさ 6 通り、優先 4 段)
 *   まだ無い物: 窓、色演算(サブ画面)、モザイク、モード 2/4/5/6/7、オフセットパータイル、高解像度、インターレース、
 *   スプライトの 1 行あたりのタイル数制限。SNES 本体(SNES2VGM)をやる時に足す
 *
 * 画面は 256×224(frame、0xAABBGGRR)。本体(snesConsole.js)が表示行ごとに renderLine(y) を呼ぶ。
 * 参考: fullsnes(nocash)、SNESdev Wiki "PPU registers" "Backgrounds" "Sprites"
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const Emu = MML.Emu = MML.Emu || {};

  const W = 256, H = 224;
  const OBJ_SIZES = [[8, 16], [8, 32], [8, 64], [16, 32], [16, 64], [32, 64], [16, 32], [16, 32]];
  // モードごとの BG の色深度(0 = その BG は無い)
  const BPP = [[2, 2, 2, 2], [4, 4, 2, 0], [4, 4, 0, 0], [8, 4, 0, 0], [8, 2, 0, 0], [4, 2, 0, 0], [4, 0, 0, 0], [8, 0, 0, 0]];

  class SnesPpu {
    constructor() {
      this.vram = new Uint16Array(0x8000);
      this.cgram = new Uint16Array(256);
      this.oam = new Uint8Array(544);
      this.frame = new Uint32Array(W * H);
      this.lineZ = new Uint8Array(W);
      this.lineC = new Uint16Array(W);
      this.objC = new Uint8Array(W); this.objP = new Uint8Array(W);
      this.reset();
    }

    reset() {
      this.vram.fill(0); this.cgram.fill(0); this.oam.fill(0);
      this.forceBlank = true; this.brightness = 0;
      this.obsel = 0; this.oamAddr = 0; this.oamReload = 0; this.oamLatch = 0;
      this.bgMode = 0; this.bg3Prio = false; this.tileBig = [false, false, false, false];
      this.bgMap = [0, 0, 0, 0]; this.bgMapSize = [0, 0, 0, 0]; this.bgChar = [0, 0, 0, 0];
      this.hofs = [0, 0, 0, 0]; this.vofs = [0, 0, 0, 0]; this.bgLatch = 0; this.hLatch = 0;
      this.vmain = 0; this.vaddr = 0; this.vbuf = 0;
      this.cgAddr = 0; this.cgFlip = false; this.cgLatch = 0;
      this.tm = 0; this.ts = 0;
      this.ophct = 0; this.opvct = 0; this.opLatched = false; this.opHFlip = false; this.opVFlip = false;
      this.openBus = 0;
      this.frame.fill(0xFF000000);
    }

    // VRAM の番地の変換($2115 bit2-3)
    _vaddr() {
      const a = this.vaddr;
      switch ((this.vmain >> 2) & 3) {
        case 1: return ((a & 0xFF00) | ((a & 0x00E0) >> 5) | ((a & 0x001F) << 3)) & 0x7FFF;
        case 2: return ((a & 0xFE00) | ((a & 0x01C0) >> 6) | ((a & 0x003F) << 3)) & 0x7FFF;
        case 3: return ((a & 0xFC00) | ((a & 0x0380) >> 7) | ((a & 0x007F) << 3)) & 0x7FFF;
      }
      return a & 0x7FFF;
    }
    _vstep() { const s = this.vmain & 3; this.vaddr = (this.vaddr + (s === 0 ? 1 : s === 1 ? 32 : 128)) & 0xFFFF; }

    write(reg, v) {
      switch (reg) {
        case 0x00: this.forceBlank = (v & 0x80) !== 0; this.brightness = v & 15; break;
        case 0x01: this.obsel = v; break;
        case 0x02: this.oamReload = (this.oamReload & 0x200) | (v << 1); this.oamAddr = this.oamReload; break;
        case 0x03: this.oamReload = (this.oamReload & 0x1FE) | ((v & 1) << 9); this.oamAddr = this.oamReload; break;
        case 0x04: {
          const a = this.oamAddr;
          if (a >= 0x200) this.oam[0x200 | (a & 0x1F)] = v;
          else if (a & 1) { this.oam[a - 1] = this.oamLatch; this.oam[a] = v; }
          else this.oamLatch = v;
          this.oamAddr = (a + 1) & 0x3FF;
          break;
        }
        case 0x05: this.bgMode = v & 7; this.bg3Prio = (v & 8) !== 0; for (let i = 0; i < 4; i++) this.tileBig[i] = (v & (0x10 << i)) !== 0; break;
        case 0x07: case 0x08: case 0x09: case 0x0A: this.bgMap[reg - 7] = ((v >> 2) << 10) & 0x7FFF; this.bgMapSize[reg - 7] = v & 3; break;
        case 0x0B: this.bgChar[0] = (v & 0x0F) << 12; this.bgChar[1] = (v >> 4) << 12; break;
        case 0x0C: this.bgChar[2] = (v & 0x0F) << 12; this.bgChar[3] = (v >> 4) << 12; break;
        // スクロール: 2 回書き(下位 → 上位)。水平は前々回の下位 3bit が混ざる
        case 0x0D: case 0x0F: case 0x11: case 0x13: { const i = (reg - 0x0D) >> 1; this.hofs[i] = ((v << 8) | (this.bgLatch & ~7) | (this.hLatch & 7)) & 0x3FF; this.bgLatch = v; this.hLatch = v; break; }
        case 0x0E: case 0x10: case 0x12: case 0x14: { const i = (reg - 0x0E) >> 1; this.vofs[i] = ((v << 8) | this.bgLatch) & 0x3FF; this.bgLatch = v; break; }
        case 0x15: this.vmain = v; break;
        case 0x16: this.vaddr = (this.vaddr & 0xFF00) | v; this.vbuf = this.vram[this._vaddr()]; break;
        case 0x17: this.vaddr = (this.vaddr & 0x00FF) | (v << 8); this.vbuf = this.vram[this._vaddr()]; break;
        case 0x18: { const a = this._vaddr(); this.vram[a] = (this.vram[a] & 0xFF00) | v; if (!(this.vmain & 0x80)) this._vstep(); break; }
        case 0x19: { const a = this._vaddr(); this.vram[a] = (this.vram[a] & 0x00FF) | (v << 8); if (this.vmain & 0x80) this._vstep(); break; }
        case 0x21: this.cgAddr = v; this.cgFlip = false; break;
        case 0x22:
          if (!this.cgFlip) this.cgLatch = v;
          else { this.cgram[this.cgAddr] = ((v & 0x7F) << 8) | this.cgLatch; this.cgAddr = (this.cgAddr + 1) & 0xFF; }
          this.cgFlip = !this.cgFlip;
          break;
        case 0x2C: this.tm = v; break;
        case 0x2D: this.ts = v; break;
      }
    }

    read(reg) {
      let v;
      switch (reg) {
        case 0x38: { const a = this.oamAddr; v = a >= 0x200 ? this.oam[0x200 | (a & 0x1F)] : this.oam[a]; this.oamAddr = (a + 1) & 0x3FF; break; }
        case 0x39: v = this.vbuf & 0xFF; if (!(this.vmain & 0x80)) { this.vbuf = this.vram[this._vaddr()]; this._vstep(); } break;
        case 0x3A: v = this.vbuf >> 8; if (this.vmain & 0x80) { this.vbuf = this.vram[this._vaddr()]; this._vstep(); } break;
        case 0x3B:
          if (!this.cgFlip) v = this.cgram[this.cgAddr] & 0xFF;
          else { v = (this.cgram[this.cgAddr] >> 8) | (this.openBus & 0x80); this.cgAddr = (this.cgAddr + 1) & 0xFF; }
          this.cgFlip = !this.cgFlip;
          break;
        case 0x3C: v = this.opHFlip ? ((this.ophct >> 8) & 1) | (this.openBus & 0xFE) : this.ophct & 0xFF; this.opHFlip = !this.opHFlip; break;
        case 0x3D: v = this.opVFlip ? ((this.opvct >> 8) & 1) | (this.openBus & 0xFE) : this.opvct & 0xFF; this.opVFlip = !this.opVFlip; break;
        case 0x3E: v = 0x01; break; // STAT77: PPU1 の版
        case 0x3F: v = 0x02 | (this.opLatched ? 0x40 : 0); this.opLatched = false; this.opHFlip = false; this.opVFlip = false; break; // STAT78: NTSC、PPU2 の版
        default: return this.openBus;
      }
      this.openBus = v;
      return v;
    }
    // H/V カウンタを控える($2137 の読み出し、または $4201 bit7 の立ち下がり)
    latchCounters(h, vline) { this.ophct = h; this.opvct = vline; this.opLatched = true; }
    // VBlank の頭: OAM の番地を戻す
    vblank() { if (!this.forceBlank) this.oamAddr = this.oamReload; }

    // ── 描画 ──
    // BG 1 枚をこの行ぶん。zLow/zHigh = タイルの優先ビット 0/1 の時の深さ(大きいほど手前)
    _bgLine(bg, y, bpp, zLow, zHigh, palBase) {
      const vram = this.vram, lineZ = this.lineZ, lineC = this.lineC;
      const big = this.tileBig[bg], tsh = big ? 4 : 3;
      const size = this.bgMapSize[bg], wide = (size & 1) !== 0, tall = (size & 2) !== 0;
      const map = this.bgMap[bg], chr = this.bgChar[bg];
      const hofs = this.hofs[bg], py = (y + this.vofs[bg]) & 0x3FF;
      const ty = py >> tsh, words = bpp * 4;
      let lastTx = -1, entry = 0, p0 = 0, p1 = 0, p2 = 0, p3 = 0, zt = 0, pal = 0, hflip = false;
      for (let x = 0; x < W; x++) {
        const px = (x + hofs) & 0x3FF, tx = px >> tsh;
        if (tx !== lastTx || big) {
          lastTx = tx;
          let off = ((ty & 31) << 5) | (tx & 31);
          if (wide && (tx & 32)) off += 0x400;
          if (tall && (ty & 32)) off += wide ? 0x800 : 0x400;
          entry = vram[(map + off) & 0x7FFF];
          hflip = (entry & 0x4000) !== 0;
          const vflip = (entry & 0x8000) !== 0;
          let tile = entry & 0x3FF, row = py & 7;
          if (big) {
            const subX = ((px >> 3) & 1) ^ (hflip ? 1 : 0), subY = ((py >> 3) & 1) ^ (vflip ? 1 : 0);
            tile = (tile + subX + (subY << 4)) & 0x3FF;
          }
          if (vflip) row = 7 - row;
          const a = (chr + tile * words + row) & 0x7FFF;
          const w0 = vram[a]; p0 = w0 & 0xFF; p1 = w0 >> 8;
          if (bpp >= 4) { const w1 = vram[(a + 8) & 0x7FFF]; p2 = w1 & 0xFF; p3 = w1 >> 8; }
          if (bpp === 8) { this._w2 = vram[(a + 16) & 0x7FFF]; this._w3 = vram[(a + 24) & 0x7FFF]; }
          zt = (entry & 0x2000) ? zHigh : zLow;
          pal = (entry >> 10) & 7;
        }
        if (zt <= lineZ[x]) continue;
        const bit = hflip ? (px & 7) : 7 - (px & 7);
        let c = ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1);
        if (bpp >= 4) c |= (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        if (bpp === 8) c |= (((this._w2 >> bit) & 1) << 4) | (((this._w2 >> (bit + 8)) & 1) << 5) | (((this._w3 >> bit) & 1) << 6) | (((this._w3 >> (bit + 8)) & 1) << 7);
        if (!c) continue;
        lineZ[x] = zt;
        lineC[x] = bpp === 8 ? c : bpp === 4 ? (pal << 4) | c : palBase + (pal << 2) + c;
      }
    }

    // スプライトをこの行ぶん objC/objP(色番号 1-15+パレット、優先)に集める
    _objLine(y) {
      const oam = this.oam, vram = this.vram, objC = this.objC, objP = this.objP;
      objC.fill(0);
      const sizes = OBJ_SIZES[this.obsel >> 5];
      const base = (this.obsel & 7) << 13, gap = (((this.obsel >> 3) & 3) + 1) << 12;
      let count = 0;
      for (let i = 0; i < 128 && count < 32; i++) {
        const o = i * 4, hb = (oam[0x200 + (i >> 2)] >> ((i & 3) * 2)) & 3;
        const size = sizes[hb >> 1];
        const sy = oam[o + 1];
        let row = (y - sy) & 0xFF;
        if (row >= size) continue;
        count++;
        let sx = oam[o] | ((hb & 1) << 8);
        if (sx >= 256) sx -= 512;
        if (sx <= -size) continue;
        const attr = oam[o + 3], tile = oam[o + 2] | ((attr & 1) << 8);
        const pal = (attr >> 1) & 7, prio = (attr >> 4) & 3, hflip = (attr & 0x40) !== 0;
        if (attr & 0x80) row = size - 1 - row;
        const tcol0 = tile & 0x0F, trow = ((tile >> 4) + (row >> 3)) & 0x0F;
        const tbase = base + ((tile & 0x100) ? gap : 0);
        for (let px = 0; px < size; px++) {
          const x = sx + px;
          if (x < 0 || x >= W || objC[x]) continue;
          const col = hflip ? size - 1 - px : px;
          const t = (trow << 4) | ((tcol0 + (col >> 3)) & 0x0F);
          const a = (tbase + t * 16 + (row & 7)) & 0x7FFF;
          const w0 = vram[a], w1 = vram[(a + 8) & 0x7FFF], bit = 7 - (col & 7);
          const c = ((w0 >> bit) & 1) | (((w0 >> (bit + 8)) & 1) << 1) | (((w1 >> bit) & 1) << 2) | (((w1 >> (bit + 8)) & 1) << 3);
          if (!c) continue;
          objC[x] = 0x80 | (pal << 4) | c; objP[x] = prio;
        }
      }
    }

    // 表示行 y(1〜224)を frame の y-1 行目に描く
    renderLine(y) {
      if (y < 1 || y > H) return;
      const out = this.frame, base = (y - 1) * W;
      if (this.forceBlank) { for (let x = 0; x < W; x++) out[base + x] = 0xFF000000; return; }
      const lineZ = this.lineZ, lineC = this.lineC, tm = this.tm, mode = this.bgMode, bpp = BPP[mode];
      lineZ.fill(0); lineC.fill(0);
      if (mode === 0) {
        if ((tm & 1) && bpp[0]) this._bgLine(0, y, 2, 8, 11, 0);
        if ((tm & 2) && bpp[1]) this._bgLine(1, y, 2, 7, 10, 32);
        if ((tm & 4) && bpp[2]) this._bgLine(2, y, 2, 2, 5, 64);
        if ((tm & 8) && bpp[3]) this._bgLine(3, y, 2, 1, 4, 96);
      } else {
        if ((tm & 1) && bpp[0]) this._bgLine(0, y, bpp[0], 8, 11, 0);
        if ((tm & 2) && bpp[1]) this._bgLine(1, y, bpp[1], 7, 10, 0);
        if ((tm & 4) && bpp[2]) this._bgLine(2, y, bpp[2], 2, (mode === 1 && this.bg3Prio) ? 13 : 5, 0);
      }
      if (tm & 0x10) {
        this._objLine(y);
        const objC = this.objC, objP = this.objP;
        for (let x = 0; x < W; x++) { const c = objC[x]; if (!c) continue; const z = 3 + objP[x] * 3; if (z > lineZ[x]) { lineZ[x] = z; lineC[x] = c; } } // 優先 0-3 → 深さ 3/6/9/12
      }
      const cg = this.cgram, br = this.brightness;
      for (let x = 0; x < W; x++) {
        const c = cg[lineC[x]];
        let r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
        r = ((r << 3) | (r >> 2)) * br / 15 | 0; g = ((g << 3) | (g >> 2)) * br / 15 | 0; b = ((b << 3) | (b >> 2)) * br / 15 | 0;
        out[base + x] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  SnesPpu.WIDTH = W; SnesPpu.HEIGHT = H;
  Emu.SnesPpu = SnesPpu;
})(typeof window !== 'undefined' ? window : globalThis);
